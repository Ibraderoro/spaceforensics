'use strict';

const fs   = require('fs');
const path = require('path');

// Cases directory — two levels up from backend/services/
const CASES_DIR = path.join(__dirname, '..', '..', 'cases');

// ---------------------------------------------------------------------------
// Deterministic Forensic Analysis — Phases 4.1 & 4.2
//
// Phase 4.1  runForensicAnalysis(caseId, rows, graph)
//   Pure contract function; consumes raw evidence rows + the frozen graph.
//
// Phase 4.2  buildForensicAnalysis(caseId, graph)
//   Full engine entry-point; graph-only signature; derives the `event` block
//   from case.json (sync read); runs deterministic validation before returning.
//
// INVARIANTS (both functions):
//   - No numerical probabilities, confidence scores, or percentages.
//   - All assessment values use only the allowed categorical vocabulary.
//   - All evidence_id references are drawn verbatim from the graph.
//   - causal_attribution_established is a boolean passthrough from the graph.
//   - No async I/O, no LLM calls, no side effects.
//
// Pipeline position:
//
//   Evidence rows  ──►  buildEvidenceGraph  ──►  graph (frozen Phase 3.5)
//                                                     │
//                               buildForensicAnalysis(caseId, graph)  ◄── Phase 4.2
//                                                     │
//                               Validated ForensicAnalysis object
//                                                     │
//                               LLM Explanation  (Phase 4.3+)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ANALYSIS_VERSION = '4.3.0';

// Rank order for assessment vocabulary — higher = stronger.
// Used to select most_supported in buildHypothesisComparison.
const ASSESSMENT_RANK = new Map([
  ['strongly_supported',  4],
  ['supported',           3],
  ['mixed',               2],
  ['weakly_supported',    1],
  ['insufficient_evidence', 0],
]);

// The complete allowed assessment vocabulary — shared by comparison builder
// and the V3 validation rule.
const ALLOWED_ASSESSMENTS = new Set([
  'strongly_supported',
  'supported',
  'mixed',
  'weakly_supported',
  'insufficient_evidence',
]);

// The four evidence-relationship list names present on every graph hypothesis.
const EVIDENCE_LISTS = [
  'environmental_context',
  'supporting_evidence',
  'contradicting_evidence',
  'non_discriminating_evidence',
];

// ---------------------------------------------------------------------------
// ForensicAnalysisValidationError
//
// Thrown by validateForensicAnalysis when one or more invariants are violated.
// The `violations` array contains one descriptive string per failed rule.
// ---------------------------------------------------------------------------
class ForensicAnalysisValidationError extends Error {
  constructor(violations) {
    super(
      `ForensicAnalysis validation failed with ${violations.length} violation(s):\n` +
      violations.map((v, i) => `  [${i + 1}] ${v}`).join('\n'),
    );
    this.name = 'ForensicAnalysisValidationError';
    this.violations = violations;
  }
}

// ---------------------------------------------------------------------------
// validateForensicAnalysis(analysis, graph)
//
// Runs all six deterministic invariants against an already-assembled analysis
// object.  Throws ForensicAnalysisValidationError (with a populated violations
// array) if any rule is violated.
//
// Invariants:
//   V1  Every evidence_id referenced in any hypothesis list exists in the
//       graph's own evidence-id pool (collected from all four lists of all
//       graph hypotheses).
//   V2  Every hypothesis_id is a non-empty string.
//   V3  Every assessment is in ALLOWED_ASSESSMENTS.
//   V4  causal_attribution_established is strictly boolean.
//   V5  No evidence_id appears in both environmental_context and
//       supporting_evidence for the same hypothesis.
//   V6  No evidence_id is duplicated within any single relationship list for
//       the same hypothesis.
// ---------------------------------------------------------------------------
function validateForensicAnalysis(analysis, graph) {
  const violations = [];

  // ── Build the graph's own evidence-id pool (V1 reference set) ────────────
  const graphIds = new Set();
  for (const h of graph.hypotheses || []) {
    for (const listName of EVIDENCE_LISTS) {
      for (const ref of h[listName] || []) {
        if (ref.evidence_id) graphIds.add(ref.evidence_id);
      }
    }
  }

  // ── V4: causal_attribution_established is boolean ─────────────────────────
  if (typeof analysis.causal_attribution_established !== 'boolean') {
    violations.push(
      `V4: causal_attribution_established must be boolean, got ${typeof analysis.causal_attribution_established}`,
    );
  }

  // ── Per-hypothesis checks ─────────────────────────────────────────────────
  for (const h of analysis.hypotheses || []) {
    const hid = h.hypothesis_id;

    // V2: hypothesis_id is a non-empty string
    if (typeof hid !== 'string' || hid.length === 0) {
      violations.push(`V2: hypothesis has missing or empty hypothesis_id`);
    }

    // V3: assessment is in the allowed vocabulary
    if (h.assessment !== null && h.assessment !== undefined) {
      if (!ALLOWED_ASSESSMENTS.has(h.assessment)) {
        violations.push(
          `V3: hypothesis ${hid} has unknown assessment '${h.assessment}'`,
        );
      }
    }

    const s = h.evidence_summary || {};
    const ecIds  = s.environmental_context_ids  || [];
    const seIds  = s.supporting_evidence_ids    || [];
    const ceIds  = s.contradicting_evidence_ids || [];
    const ndeIds = s.non_discriminating_evidence_ids || [];
    const allListsById = { environmental_context: ecIds, supporting_evidence: seIds, contradicting_evidence: ceIds, non_discriminating_evidence: ndeIds };

    // V1: every referenced id must exist in the graph's pool
    for (const [listName, ids] of Object.entries(allListsById)) {
      for (const eid of ids) {
        if (!graphIds.has(eid)) {
          violations.push(
            `V1: hypothesis ${hid} ${listName} references evidence_id '${eid}' not found in graph`,
          );
        }
      }
    }

    // V5: no id may appear in both environmental_context and supporting_evidence
    const ecSet = new Set(ecIds);
    for (const eid of seIds) {
      if (ecSet.has(eid)) {
        violations.push(
          `V5: hypothesis ${hid} has evidence_id '${eid}' in both environmental_context and supporting_evidence`,
        );
      }
    }

    // V6: no duplicate within any single list
    for (const [listName, ids] of Object.entries(allListsById)) {
      const seen = new Set();
      for (const eid of ids) {
        if (seen.has(eid)) {
          violations.push(
            `V6: hypothesis ${hid} ${listName} contains duplicate evidence_id '${eid}'`,
          );
        }
        seen.add(eid);
      }
    }
  }

  if (violations.length > 0) {
    throw new ForensicAnalysisValidationError(violations);
  }
}

// ---------------------------------------------------------------------------
// buildEvidenceSummary(hypothesis)
//
// Extracts counts and evidence_id arrays from the four relationship lists of a
// graph hypothesis.  Returns an EvidenceSummary object.
//
// Shape:
//   {
//     environmental_context_count:         number,
//     supporting_evidence_count:           number,
//     contradicting_evidence_count:        number,
//     non_discriminating_evidence_count:   number,
//     environmental_context_ids:           string[],
//     supporting_evidence_ids:             string[],
//     contradicting_evidence_ids:          string[],
//     non_discriminating_evidence_ids:     string[]
//   }
// ---------------------------------------------------------------------------
function buildEvidenceSummary(hypothesis) {
  const ec  = hypothesis.environmental_context      || [];
  const se  = hypothesis.supporting_evidence        || [];
  const ce  = hypothesis.contradicting_evidence     || [];
  const nde = hypothesis.non_discriminating_evidence || [];

  return {
    environmental_context_count:        ec.length,
    supporting_evidence_count:          se.length,
    contradicting_evidence_count:       ce.length,
    non_discriminating_evidence_count:  nde.length,
    environmental_context_ids:          ec.map((r) => r.evidence_id),
    supporting_evidence_ids:            se.map((r) => r.evidence_id),
    contradicting_evidence_ids:         ce.map((r) => r.evidence_id),
    non_discriminating_evidence_ids:    nde.map((r) => r.evidence_id),
  };
}

// ---------------------------------------------------------------------------
// buildHypothesisAnalysis(hypothesis)
//
// Wraps a graph Hypothesis into a HypothesisAnalysis object.
//
// Shape:
//   {
//     hypothesis_id:    string,
//     label:            string,
//     assessment:       string,           // categorical only — no probabilities
//     evidence_summary: EvidenceSummary,
//     limitations:      AnalysisLimitation[],
//     heuristic_note:   string | null
//   }
// ---------------------------------------------------------------------------
function buildHypothesisAnalysis(hypothesis) {
  return {
    hypothesis_id:    hypothesis.hypothesis_id,
    label:            hypothesis.label,
    assessment:       hypothesis.assessment,
    evidence_summary: buildEvidenceSummary(hypothesis),
    limitations:      (hypothesis.limitations || []).map((l) => ({
      type:        l.type,
      description: l.description,
    })),
    heuristic_note: hypothesis.heuristic_note !== undefined
      ? hypothesis.heuristic_note
      : null,
  };
}

// ---------------------------------------------------------------------------
// buildHypothesisComparison(hypotheses)
//
// Classifies graph hypotheses by assessment vocabulary and selects
// most_supported using ASSESSMENT_RANK.
//
// Shape:
//   {
//     assessed_hypotheses:     string[],
//     supported_hypotheses:    string[],
//     mixed_hypotheses:        string[],
//     insufficient_hypotheses: string[],
//     most_supported:          string | null
//   }
// ---------------------------------------------------------------------------
function buildHypothesisComparison(hypotheses) {
  const assessed      = [];
  const supported     = [];
  const mixed         = [];
  const insufficient  = [];
  let mostSupported   = null;
  let bestRank        = -1;

  for (const h of hypotheses) {
    const a = h.assessment;
    if (a === null || a === undefined) continue;

    assessed.push(h.hypothesis_id);

    if (a === 'supported' || a === 'strongly_supported') {
      supported.push(h.hypothesis_id);
    } else if (a === 'mixed') {
      mixed.push(h.hypothesis_id);
    } else if (a === 'insufficient_evidence') {
      insufficient.push(h.hypothesis_id);
    }

    const rank = ASSESSMENT_RANK.has(a) ? ASSESSMENT_RANK.get(a) : -1;
    if (rank > bestRank) {
      bestRank      = rank;
      mostSupported = h.hypothesis_id;
    }
  }

  return {
    assessed_hypotheses:     assessed,
    supported_hypotheses:    supported,
    mixed_hypotheses:        mixed,
    insufficient_hypotheses: insufficient,
    most_supported:          mostSupported,
  };
}

// ---------------------------------------------------------------------------
// buildCaseEvent(meta)
//
// Derives an event block from a pre-loaded case.json meta object.
// Accepts the raw parsed object (not a caseId) — I/O is the caller's
// responsibility, keeping this function pure.
// Returns null when meta is null/undefined.
//
// Shape:
//   {
//     timestamp:   string,
//     label:       string,
//     description: string,
//     recovery:    { timestamp, label, description },
//     target_asset: { name, alias, norad_id, orbit_type,
//                     longitude_deg_west, operator, spacecraft_bus },
//     data_window: { start, end, duration_minutes }
//   }
// ---------------------------------------------------------------------------
function buildCaseEvent(meta) {
  if (!meta) return null;
  try {
    const a = meta.anchor_event   || {};
    const r = meta.recovery_event || {};
    const t = meta.target_asset   || {};
    const d = meta.data_window    || {};
    return {
      timestamp:   a.timestamp   || null,
      label:       a.label       || null,
      description: a.description || null,
      recovery: {
        timestamp:   r.timestamp   || null,
        label:       r.label       || null,
        description: r.description || null,
      },
      target_asset: {
        name:                t.name                || null,
        alias:               t.alias               || null,
        norad_id:            t.norad_id            ?? null,
        orbit_type:          t.orbit_type          || null,
        longitude_deg_west:  t.longitude_deg_west  ?? null,
        operator:            t.operator            || null,
        spacecraft_bus:      t.spacecraft_bus      || null,
      },
      data_window: {
        start:             d.start             || null,
        end:               d.end               || null,
        duration_minutes:  d.duration_minutes  ?? null,
      },
    };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// buildAggregateEvidenceSummary(hypotheses)
//
// Sums the four evidence-category counts across all HypothesisAnalysis entries
// and totals the number of per-hypothesis limitations.
//
// Shape:
//   {
//     total_environmental_context:        number,
//     total_supporting_evidence:          number,
//     total_contradicting_evidence:       number,
//     total_non_discriminating_evidence:  number,
//     total_limitations:                  number
//   }
// ---------------------------------------------------------------------------
function buildAggregateEvidenceSummary(hypotheses) {
  let ec = 0, se = 0, ce = 0, nde = 0, lim = 0;
  for (const h of hypotheses) {
    const s = h.evidence_summary;
    ec  += s.environmental_context_count;
    se  += s.supporting_evidence_count;
    ce  += s.contradicting_evidence_count;
    nde += s.non_discriminating_evidence_count;
    lim += (h.limitations || []).length;
  }
  return {
    total_environmental_context:        ec,
    total_supporting_evidence:          se,
    total_contradicting_evidence:       ce,
    total_non_discriminating_evidence:  nde,
    total_limitations:                  lim,
  };
}

// ---------------------------------------------------------------------------
// buildKeyObservations(hypothesis)
//
// Derives a non-empty string[] of analytical observations from the evidence
// counts and assessment of a graph hypothesis.
// No probabilities, scores, or causal-certainty language are used.
//
// Rules (applied in order; multiple may fire):
//   1. environmental_context_count > 0  → document preconditions
//   2. supporting_evidence_count > 0    → document direct support
//   3. contradicting_evidence_count > 0 → document contradicting evidence
//   4. non_discriminating_evidence_count > 0 → document non-discriminating
//   5. all counts === 0                 → note absence of evidence
//   6. assessment === 'mixed'           → note mixed outcome
//   7. assessment === 'insufficient_evidence' → note inability to evaluate
//   8. assessment === 'strongly_supported'    → note attribution outcome
// ---------------------------------------------------------------------------
function buildKeyObservations(hypothesis) {
  const ec  = (hypothesis.environmental_context      || []).length;
  const se  = (hypothesis.supporting_evidence        || []).length;
  const ce  = (hypothesis.contradicting_evidence     || []).length;
  const nde = (hypothesis.non_discriminating_evidence || []).length;
  const a   = hypothesis.assessment;

  const observations = [];

  if (ec > 0) {
    observations.push(
      `Environmental context documented: ${ec} record(s) establish preconditions ` +
      `contemporaneous with the anomaly.`,
    );
  }

  if (se > 0) {
    observations.push(
      `Direct supporting evidence: ${se} record(s) are consistent with this hypothesis.`,
    );
  }

  if (ce > 0) {
    observations.push(
      `Contradicting evidence: ${ce} record(s) are inconsistent with this hypothesis.`,
    );
  }

  if (nde > 0) {
    observations.push(
      `Non-discriminating evidence: ${nde} record(s) are consistent with multiple hypotheses.`,
    );
  }

  if (ec === 0 && se === 0 && ce === 0 && nde === 0) {
    observations.push(
      `No evidence in this dataset speaks to this hypothesis.`,
    );
  }

  if (a === 'mixed') {
    observations.push(
      `Assessment is mixed: environmental context exists but no direct mechanism ` +
      `evidence is available.`,
    );
  }

  if (a === 'insufficient_evidence') {
    observations.push(
      `Insufficient evidence: this hypothesis cannot be evaluated from the available dataset.`,
    );
  }

  if (a === 'strongly_supported') {
    observations.push(
      `Causal attribution is not established; the absence of discriminating evidence ` +
      `is itself a supported finding.`,
    );
  }

  return observations;
}

// ---------------------------------------------------------------------------
// buildDetailedHypothesisComparison(graphHypotheses)            Phase 4.3
//
// Produces a HypothesisComparisonEntry[] — one entry per graph hypothesis —
// that answers the six forensic questions without creating rankings, numerical
// probabilities, or causal claims.
//
// HypothesisComparisonEntry shape:
//   {
//     hypothesis_id:    string,
//     label:            string,
//     assessment:       string,           // categorical only
//     evidence_profile: EvidenceSummary,  // counts + auditable id arrays
//     key_observations: string[],         // derived by buildKeyObservations
//     key_limitations:  AnalysisLimitation[]  // full limitation set from graph
//   }
// ---------------------------------------------------------------------------
function buildDetailedHypothesisComparison(graphHypotheses) {
  return graphHypotheses.map((h) => ({
    hypothesis_id:    h.hypothesis_id,
    label:            h.label,
    assessment:       h.assessment,
    evidence_profile: buildEvidenceSummary(h),
    key_observations: buildKeyObservations(h),
    key_limitations:  (h.limitations || []).map((l) => ({
      type:        l.type,
      description: l.description,
    })),
  }));
}

// ---------------------------------------------------------------------------
// buildForensicAnalysis(caseId, graph)                          Phase 4.2 / 4.3
//
// Full deterministic forensic analysis engine.
//
// Parameters:
//   caseId    string         — case identifier (e.g. 'galaxy-15')
//   graph     EvidenceGraph  — output of buildEvidenceGraph(caseId, rows)
//   caseMeta  object|null    — (optional) pre-loaded case.json object.
//               When provided, no filesystem I/O is performed (async-safe path).
//               When omitted, falls back to a synchronous read from disk
//               (preserved for backward compatibility with existing tests).
//
// Returns a validated ForensicAnalysis object:
//   {
//     case_id:                        string,
//     analysis_version:               string,
//     causal_attribution_established: boolean,
//     event:                          CaseEvent | null,
//     evidence_summary:               AggregateEvidenceSummary,
//     hypotheses:                     HypothesisAnalysis[],
//     comparison:                     HypothesisComparison,
//     hypothesis_comparison:          HypothesisComparisonEntry[],
//     limitations:                    AnalysisLimitation[]
//   }
//
// Throws ForensicAnalysisValidationError if any of the six invariants are
// violated by the assembled object.
// ---------------------------------------------------------------------------
function buildForensicAnalysis(caseId, graph, caseMeta) {
  // Resolve caseMeta: use the pre-loaded value when supplied; fall back to a
  // synchronous disk read only for the backward-compatible callers (e.g. tests)
  // that do not yet pre-load the metadata asynchronously.
  let resolvedMeta = caseMeta !== undefined ? caseMeta : null;
  if (resolvedMeta === null && caseMeta === undefined) {
    // Synchronous fallback — preserved for backward compatibility.
    const caseJsonPath = path.join(CASES_DIR, caseId, 'case.json');
    try {
      resolvedMeta = JSON.parse(fs.readFileSync(caseJsonPath, 'utf8'));
    } catch (_) {
      resolvedMeta = null;
    }
  }

  const hypotheses            = graph.hypotheses.map(buildHypothesisAnalysis);
  const comparison            = buildHypothesisComparison(graph.hypotheses);
  const hypothesis_comparison = buildDetailedHypothesisComparison(graph.hypotheses);
  const event                 = buildCaseEvent(resolvedMeta);
  const evidence_summary      = buildAggregateEvidenceSummary(hypotheses);

  // Aggregate all unique limitations across all hypotheses, deduped by description.
  const seenDescriptions = new Set();
  const limitations = [];
  for (const h of graph.hypotheses) {
    for (const l of h.limitations || []) {
      if (!seenDescriptions.has(l.description)) {
        seenDescriptions.add(l.description);
        limitations.push({ type: l.type, description: l.description });
      }
    }
  }

  const analysis = {
    case_id:                        caseId,
    analysis_version:               ANALYSIS_VERSION,
    causal_attribution_established: graph.causal_attribution_established,
    event,
    evidence_summary,
    hypotheses,
    comparison,
    hypothesis_comparison,
    limitations,
  };

  // Validate before returning — throws ForensicAnalysisValidationError on failure.
  validateForensicAnalysis(analysis, graph);

  return analysis;
}

// ---------------------------------------------------------------------------
// runForensicAnalysis(caseId, rows, graph)                      Phase 4.1
//
// Original contract function.  Preserved unchanged for backward compatibility.
//
// Parameters:
//   caseId  string         — case identifier (e.g. 'galaxy-15')
//   rows    Evidence[]     — output of parseEvidenceCSV(caseId)
//   graph   EvidenceGraph  — output of buildEvidenceGraph(caseId, rows)
//
// Returns:
//   {
//     case_id, analysis_version, causal_attribution_established,
//     hypotheses, comparison, limitations, heuristic_notes
//   }
// ---------------------------------------------------------------------------
function runForensicAnalysis(caseId, rows, graph) {
  const hypotheses = graph.hypotheses.map(buildHypothesisAnalysis);
  const comparison = buildHypothesisComparison(graph.hypotheses);

  // Aggregate all unique limitations across all hypotheses, deduped by description.
  const seenDescriptions = new Set();
  const limitations = [];
  for (const h of graph.hypotheses) {
    for (const l of h.limitations || []) {
      if (!seenDescriptions.has(l.description)) {
        seenDescriptions.add(l.description);
        limitations.push({ type: l.type, description: l.description });
      }
    }
  }

  // Collect all distinct non-null heuristic_note strings.
  const seenNotes = new Set();
  const heuristic_notes = [];
  for (const h of graph.hypotheses) {
    if (h.heuristic_note && !seenNotes.has(h.heuristic_note)) {
      seenNotes.add(h.heuristic_note);
      heuristic_notes.push(h.heuristic_note);
    }
  }

  return {
    case_id:                        caseId,
    analysis_version:               ANALYSIS_VERSION,
    causal_attribution_established: graph.causal_attribution_established,
    hypotheses,
    comparison,
    limitations,
    heuristic_notes,
  };
}

// ---------------------------------------------------------------------------
// getEvidenceProvenance(caseId, evidenceId, rows, graph)        Phase 4.4
//
// Pure, synchronous provenance lookup.  Joins one evidence timeline row with
// every hypothesis relationship that references it, making every analytical
// claim fully auditable.
//
// Parameters:
//   caseId      string        — case identifier (for context; no I/O performed)
//   evidenceId  string        — the evidence_id to resolve
//   rows        Evidence[]    — output of parseEvidenceCSV(caseId)
//   graph       EvidenceGraph — output of buildEvidenceGraph(caseId, rows)
//
// Returns one of two shapes:
//
//   Not found:
//     { found: false, evidence_id: string, reason: string }
//
//   Found:
//     {
//       found:            true,
//       evidence_id:      string,
//       timestamp:        string,
//       source:           string,
//       measurement:      string,
//       value:            number,
//       unit:             string,
//       resolution:       string,
//       dataset_id:       string | null,
//       provider:         string | null,
//       variable:         string | null,
//       evidence_type:    string | null,
//       quality:          null,
//       hypothesis_relationships: HypothesisRelationship[]
//     }
//
// HypothesisRelationship shape:
//   {
//     hypothesis_id:  string,   // 'H1'–'H5'
//     list_name:      string,   // 'environmental_context' | 'supporting_evidence' |
//                               // 'contradicting_evidence' | 'non_discriminating_evidence'
//     relationship:   string,   // EvidenceRef.relationship value
//     interpretation: string    // EvidenceRef.interpretation value
//   }
//
// EPHEMERIS records resolve with found: true and hypothesis_relationships: []
// because GOES11_EPHEMERIS IDs are intentionally absent from all graph hypothesis
// lists.  Their presence in the timeline is real; the empty relationship list is
// the correct forensic statement about them.
//
// Throws ForensicAnalysisValidationError if the graph contains a duplicate
// (hypothesis_id, list_name) pair for the same evidence_id — this would indicate
// a structural defect in the graph that must be surfaced immediately.
// ---------------------------------------------------------------------------
function getEvidenceProvenance(caseId, evidenceId, rows, graph) {
  // ── 1. Locate the timeline row ───────────────────────────────────────────
  const row = rows.find((r) => r.evidence_id === evidenceId);
  if (!row) {
    return {
      found:       false,
      evidence_id: evidenceId,
      reason:      'Evidence ID not found in timeline',
    };
  }

  // ── 2. Scan all hypothesis lists for references to this evidence_id ──────
  const hypothesis_relationships = [];
  const violations = [];
  // Key: `${hypothesis_id}|${list_name}` — used to detect duplicate triples.
  const seenKeys = new Set();

  for (const h of graph.hypotheses || []) {
    for (const listName of EVIDENCE_LISTS) {
      for (const ref of h[listName] || []) {
        if (ref.evidence_id !== evidenceId) continue;

        const key = `${h.hypothesis_id}|${listName}`;
        if (seenKeys.has(key)) {
          violations.push(
            `Duplicate (hypothesis_id='${h.hypothesis_id}', list_name='${listName}') ` +
            `reference for evidence_id '${evidenceId}' in graph`,
          );
        }
        seenKeys.add(key);

        hypothesis_relationships.push({
          hypothesis_id:  h.hypothesis_id,
          list_name:      listName,
          relationship:   ref.relationship,
          interpretation: ref.interpretation,
        });
      }
    }
  }

  if (violations.length > 0) {
    throw new ForensicAnalysisValidationError(violations);
  }

  // ── 3. Return the full provenance record — all 12 row fields verbatim ────
  return {
    found:                    true,
    evidence_id:              row.evidence_id,
    timestamp:                row.timestamp,
    source:                   row.source,
    measurement:              row.measurement,
    value:                    row.value,
    unit:                     row.unit,
    resolution:               row.resolution,
    dataset_id:               row.dataset_id,
    provider:                 row.provider,
    variable:                 row.variable,
    evidence_type:            row.evidence_type,
    quality:                  row.quality,
    hypothesis_relationships,
  };
}

// ---------------------------------------------------------------------------
// assembleValidatedForensicReport(analysis, narrative)          Phase 4.8
//
// Merges the validated deterministic ForensicAnalysis with the validated
// AnalystNarrative to produce the final unified ValidatedForensicReport.
//
// Enforces immutability: the narrative must not have altered any authoritative
// field from the deterministic analysis.  Two invariants are checked:
//
//   I1 — narrative.causal_attribution_established must equal
//        analysis.causal_attribution_established.
//   I2 — For every entry in narrative.hypothesis_assessments, the assessment
//        value must match the corresponding hypothesis assessment in analysis.
//
// Throws ForensicAnalysisValidationError on any violation.
//
// Returns:
//   {
//     ...analysis,                      // all deterministic fields verbatim
//     analyst_narrative: AnalystNarrative  // validated AI layer (additive only)
//   }
// ---------------------------------------------------------------------------
function assembleValidatedForensicReport(analysis, narrative) {
  const violations = [];

  // I1 — causal_attribution_established must be unchanged
  if (narrative.causal_attribution_established !== analysis.causal_attribution_established) {
    violations.push(
      `I1: analyst_narrative.causal_attribution_established is ` +
      `"${narrative.causal_attribution_established}" but analysis says ` +
      `"${analysis.causal_attribution_established}"`,
    );
  }

  // I2 — hypothesis assessments must be unchanged
  if (Array.isArray(narrative.hypothesis_assessments)) {
    const analysisMap = new Map(
      analysis.hypotheses.map((h) => [h.hypothesis_id, h.assessment]),
    );
    for (const ha of narrative.hypothesis_assessments) {
      const expected = analysisMap.get(ha.hypothesis_id);
      if (expected !== undefined && ha.assessment !== expected) {
        violations.push(
          `I2: analyst_narrative assessment for hypothesis "${ha.hypothesis_id}" ` +
          `is "${ha.assessment}" but analysis says "${expected}"`,
        );
      }
    }
  }

  if (violations.length > 0) {
    throw new ForensicAnalysisValidationError(violations);
  }

  return { ...analysis, analyst_narrative: narrative };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  // Phase 4.1
  runForensicAnalysis,
  // Phase 4.2
  buildForensicAnalysis,
  validateForensicAnalysis,
  ForensicAnalysisValidationError,
  // Phase 4.3
  buildDetailedHypothesisComparison,
  // Phase 4.4
  getEvidenceProvenance,
  // Phase 4.8
  assembleValidatedForensicReport,
  // Shared constant
  ANALYSIS_VERSION,
};
