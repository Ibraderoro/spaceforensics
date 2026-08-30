'use strict';

const { FORENSIC_TEMPORAL_WINDOW_MINUTES } = require('./forensicConfig');

// ---------------------------------------------------------------------------
// evidenceExploration.js — Phase 7.3
//
// Pure functions for navigating the evidence exploration hierarchy:
//
//   Case → Hypothesis → Evidence relationship → Evidence record → Provenance
//
// ALL FUNCTIONS ARE READ-ONLY.  No function in this module modifies evidence
// rows, graph structures, or hypothesis assessments.
//
// DESIGN INVARIANTS
//   EX-1  Evidence records are read-only.  No function writes, adds, or
//         removes evidence rows.
//   EX-2  Every returned evidence item is traceable to an evidence_id that
//         exists verbatim in the case's CSV rows.
//   EX-3  Environmental context is always returned in a separate field from
//         supporting_evidence.  They are never merged.
//   EX-4  Contradicting evidence is always returned in a separate field.
//   EX-5  Non-discriminating evidence is always returned in a separate field.
//   EX-6  EPHEMERIS records are never included in hypothesis evidence lists.
//         (They are excluded upstream by buildEvidenceGraph; this module
//          honours that exclusion and does not re-introduce them.)
//   EX-7  No temporal proximity between two records is used to infer a
//         relationship.  All relationships come from the graph's explicit
//         hypothesis lists.  The ±10-minute window is an upstream heuristic
//         already baked into the graph; this module does not re-apply it.
//   EX-8  No numerical probabilities, confidence scores, or percentages are
//         produced by any function in this module.
//   EX-9  Hypothesis assessments are never modified or re-derived here; they
//         are passed through verbatim from the graph/analysis.
//   EX-10 Cross-case evidence comparison is explicitly prohibited.  The
//         comparison functions operate on a single case's graph at a time.
//         A caller that passes graphs from two different cases receives an
//         error, not a merged result.
// ---------------------------------------------------------------------------

// The four canonical evidence relationship list names — ordered and fixed.
const EVIDENCE_LISTS = [
  'environmental_context',
  'supporting_evidence',
  'contradicting_evidence',
  'non_discriminating_evidence',
];

// Human-readable labels for each list — used in navigation summaries.
const LIST_LABELS = {
  environmental_context:        'Environmental Context',
  supporting_evidence:          'Supporting Evidence',
  contradicting_evidence:       'Contradicting Evidence',
  non_discriminating_evidence:  'Non-Discriminating Evidence',
};

// Heuristic window label — always shown when environmental context is present
// so the analyst sees the selection method explicitly.
// The ±N value is derived from FORENSIC_TEMPORAL_WINDOW_MINUTES (forensicConfig.js)
// so that the displayed label stays consistent with the actual selection window.
const HEURISTIC_WINDOW_LABEL =
  `Evidence selected via \u00b1${FORENSIC_TEMPORAL_WINDOW_MINUTES}-minute heuristic temporal window around the anomaly. ` +
  'This window is an evidence-selection heuristic, not a scientifically calibrated causal threshold.';

// ---------------------------------------------------------------------------
// resolveEvidenceRecord(evidenceId, rows)
//
// Looks up a single evidence row by evidence_id.
// Returns the row verbatim (all 12 fields) or null if not found.
//
// EX-1: read-only — returns a plain object copy, not a reference.
// EX-2: traceability — the returned object always carries evidence_id.
// ---------------------------------------------------------------------------
function resolveEvidenceRecord(evidenceId, rows) {
  const row = rows.find((r) => r.evidence_id === evidenceId);
  if (!row) return null;
  // Return a shallow copy to preserve immutability of the source array.
  return {
    evidence_id:   row.evidence_id,
    timestamp:     row.timestamp,
    source:        row.source,
    measurement:   row.measurement,
    value:         row.value,
    unit:          row.unit,
    resolution:    row.resolution,
    dataset_id:    row.dataset_id,
    provider:      row.provider,
    variable:      row.variable,
    evidence_type: row.evidence_type,
    quality:       row.quality,
  };
}

// ---------------------------------------------------------------------------
// buildHypothesisEvidenceView(graphHypothesis, rows)
//
// Returns a structured read-only view of all evidence associated with a single
// hypothesis, with each of the four lists kept separate (EX-3, EX-4, EX-5).
//
// Shape:
//   {
//     hypothesis_id:   string,
//     label:           string,
//     assessment:      string,          // verbatim — not re-derived (EX-9)
//     heuristic_note:  string | null,
//     environmental_context: EvidenceEntry[],
//     supporting_evidence:   EvidenceEntry[],
//     contradicting_evidence: EvidenceEntry[],
//     non_discriminating_evidence: EvidenceEntry[],
//     heuristic_window_note: string | null,
//   }
//
// EvidenceEntry shape:
//   {
//     evidence_id:    string,
//     relationship:   string,           // verbatim from graph ref template
//     interpretation: string,           // verbatim from graph ref template
//     record:         EvidenceRecord,   // all 12 CSV fields
//   }
//
// EPHEMERIS exclusion (EX-6): because buildEvidenceGraph never puts EPHEMERIS
// records in any hypothesis list, they cannot appear here.  No additional
// filter is needed; the contract is maintained upstream.
// ---------------------------------------------------------------------------
function buildHypothesisEvidenceView(graphHypothesis, rows) {
  function buildEntries(listName) {
    const refs = graphHypothesis[listName] || [];
    return refs.map((ref) => {
      const record = resolveEvidenceRecord(ref.evidence_id, rows);
      return {
        evidence_id:    ref.evidence_id,
        relationship:   ref.relationship,
        interpretation: ref.interpretation,
        record,                           // null only if CSV was modified after graph build
      };
    });
  }

  const envContext = buildEntries('environmental_context');

  // EX-7 / EX-8: show heuristic note whenever there is environmental context,
  // so the analyst is always reminded this was a temporal window selection.
  const heuristicWindowNote = envContext.length > 0 ? HEURISTIC_WINDOW_LABEL : null;

  return {
    hypothesis_id:               graphHypothesis.hypothesis_id,
    label:                       graphHypothesis.label,
    assessment:                  graphHypothesis.assessment,   // verbatim (EX-9)
    heuristic_note:              graphHypothesis.heuristic_note || null,
    heuristic_window_note:       heuristicWindowNote,
    environmental_context:       envContext,
    supporting_evidence:         buildEntries('supporting_evidence'),
    contradicting_evidence:      buildEntries('contradicting_evidence'),
    non_discriminating_evidence: buildEntries('non_discriminating_evidence'),
  };
}

// ---------------------------------------------------------------------------
// buildCaseEvidenceIndex(graph, rows)
//
// Returns a flat array of every evidence record that is referenced in the
// graph (across all hypotheses, all four lists).  Each entry carries the
// evidence record plus all hypothesis relationships.
//
// This is the "Evidence record → Provenance" view: given an evidence_id you
// can find which hypotheses reference it and how.
//
// Shape (per entry):
//   {
//     evidence_id:              string,
//     record:                   EvidenceRecord,
//     hypothesis_relationships: HypothesisRelationship[],
//   }
//
// HypothesisRelationship:
//   {
//     hypothesis_id:  string,
//     label:          string,
//     list_name:      string,
//     list_label:     string,   // human-readable list name
//     relationship:   string,
//     interpretation: string,
//   }
//
// EX-6: EPHEMERIS records are absent because they are not in any graph list.
// EX-2: every entry carries evidence_id traceable to a CSV row.
// ---------------------------------------------------------------------------
function buildCaseEvidenceIndex(graph, rows) {
  // Collect all unique evidence IDs from the graph, plus their relationships.
  const index = new Map(); // evidence_id → { record, hypothesis_relationships[] }

  for (const h of graph.hypotheses || []) {
    for (const listName of EVIDENCE_LISTS) {
      for (const ref of h[listName] || []) {
        const eid = ref.evidence_id;
        if (!index.has(eid)) {
          index.set(eid, {
            evidence_id:              eid,
            record:                   resolveEvidenceRecord(eid, rows),
            hypothesis_relationships: [],
          });
        }
        index.get(eid).hypothesis_relationships.push({
          hypothesis_id:  h.hypothesis_id,
          label:          h.label,
          list_name:      listName,
          list_label:     LIST_LABELS[listName],
          relationship:   ref.relationship,
          interpretation: ref.interpretation,
        });
      }
    }
  }

  return [...index.values()];
}

// ---------------------------------------------------------------------------
// buildEnvironmentalContextSummary(graph, rows)
//
// Returns the consolidated environmental context across all hypotheses: a
// list of unique evidence records that appear in ANY hypothesis's
// environmental_context list.  Includes which hypotheses reference each record.
//
// This supports the "Environmental context" navigation tier.
//
// Shape:
//   {
//     heuristic_window_note: string,
//     records: [
//       {
//         evidence_id:          string,
//         record:               EvidenceRecord,
//         referenced_by:        string[],   // hypothesis_ids
//       }
//     ]
//   }
//
// EX-3: environmental context is strictly separated from other lists.
// EX-7: selection method is declared, not re-applied.
// EX-8: no numerical probabilities.
// ---------------------------------------------------------------------------
function buildEnvironmentalContextSummary(graph, rows) {
  const envMap = new Map(); // evidence_id → { record, referenced_by[] }

  for (const h of graph.hypotheses || []) {
    for (const ref of h.environmental_context || []) {
      const eid = ref.evidence_id;
      if (!envMap.has(eid)) {
        envMap.set(eid, {
          evidence_id:   eid,
          record:        resolveEvidenceRecord(eid, rows),
          referenced_by: [],
        });
      }
      envMap.get(eid).referenced_by.push(h.hypothesis_id);
    }
  }

  return {
    heuristic_window_note: HEURISTIC_WINDOW_LABEL,
    records: [...envMap.values()],
  };
}

// ---------------------------------------------------------------------------
// compareHypothesesEvidence(graph, rows, hypothesisIds)
//
// Compares evidence profiles across a specified set of hypotheses within the
// SAME case.  Returns a comparison object that highlights shared and exclusive
// evidence across the four lists.
//
// EX-10: Cross-case comparison is prohibited.  This function accepts only a
//        single graph (one case).  The caller is responsible for ensuring
//        all hypothesis_ids are from the same case.
//
// Parameters:
//   graph         — EvidenceGraph for the case
//   rows          — Evidence rows for the case
//   hypothesisIds — string[] subset of hypothesis IDs to compare;
//                   if empty or omitted, all hypotheses in the graph are used
//
// Returns:
//   {
//     case_id:          string,
//     causal_attribution_established: boolean,
//     hypothesis_ids:   string[],           // IDs actually compared
//     comparison_note:  string,             // explicit scope statement
//     hypotheses:       HypothesisComparisonEntry[],
//     shared_evidence:  SharedEvidenceEntry[],
//     exclusive_evidence: ExclusiveEvidenceEntry[],
//   }
//
// HypothesisComparisonEntry:
//   {
//     hypothesis_id: string,
//     label:         string,
//     assessment:    string,    // verbatim (EX-9)
//     evidence_counts: {
//       environmental_context:       number,
//       supporting_evidence:         number,
//       contradicting_evidence:      number,
//       non_discriminating_evidence: number,
//     },
//     evidence_ids_by_list: {
//       environmental_context:       string[],
//       supporting_evidence:         string[],
//       contradicting_evidence:      string[],
//       non_discriminating_evidence: string[],
//     }
//   }
//
// SharedEvidenceEntry (appears in 2+ of the compared hypotheses):
//   {
//     evidence_id: string,
//     record:      EvidenceRecord,
//     appears_in:  [ { hypothesis_id, list_name, list_label, relationship } ]
//   }
//
// ExclusiveEvidenceEntry (appears in exactly 1 of the compared hypotheses):
//   {
//     evidence_id:  string,
//     record:       EvidenceRecord,
//     hypothesis_id: string,
//     list_name:     string,
//     list_label:    string,
//     relationship:  string,
//   }
// ---------------------------------------------------------------------------
function compareHypothesesEvidence(graph, rows, hypothesisIds) {
  // Determine the set of hypotheses to compare.
  const targetIds = Array.isArray(hypothesisIds) && hypothesisIds.length > 0
    ? new Set(hypothesisIds)
    : null;  // null means "all"

  const targetHypotheses = (graph.hypotheses || []).filter(
    (h) => targetIds === null || targetIds.has(h.hypothesis_id),
  );

  // Validate that all requested IDs actually exist.
  if (targetIds !== null) {
    for (const id of targetIds) {
      if (!targetHypotheses.find((h) => h.hypothesis_id === id)) {
        return {
          error: `hypothesis_id "${id}" not found in the case graph`,
          error_code: 'HYPOTHESIS_NOT_FOUND',
        };
      }
    }
  }

  // Build per-hypothesis entries.
  const hypothesisEntries = targetHypotheses.map((h) => {
    const countsByList = {};
    const idsByList    = {};
    for (const listName of EVIDENCE_LISTS) {
      const refs = h[listName] || [];
      countsByList[listName] = refs.length;
      idsByList[listName]    = refs.map((r) => r.evidence_id);
    }
    return {
      hypothesis_id: h.hypothesis_id,
      label:         h.label,
      assessment:    h.assessment,  // verbatim (EX-9)
      evidence_counts:     countsByList,
      evidence_ids_by_list: idsByList,
    };
  });

  // Build a map: evidence_id → appearances across selected hypotheses.
  // EX-7: appearances are derived from explicit graph memberships only.
  const appearances = new Map(); // evidence_id → [ { hypothesis_id, list_name, list_label, relationship } ]

  for (const h of targetHypotheses) {
    for (const listName of EVIDENCE_LISTS) {
      for (const ref of h[listName] || []) {
        const eid = ref.evidence_id;
        if (!appearances.has(eid)) {
          appearances.set(eid, []);
        }
        appearances.get(eid).push({
          hypothesis_id: h.hypothesis_id,
          list_name:     listName,
          list_label:    LIST_LABELS[listName],
          relationship:  ref.relationship,
        });
      }
    }
  }

  // Partition into shared (≥2 hypotheses) and exclusive (exactly 1).
  const sharedEvidence    = [];
  const exclusiveEvidence = [];

  for (const [eid, apps] of appearances.entries()) {
    const uniqueHypotheses = new Set(apps.map((a) => a.hypothesis_id));
    const record = resolveEvidenceRecord(eid, rows);

    if (uniqueHypotheses.size >= 2) {
      sharedEvidence.push({
        evidence_id: eid,
        record,
        appears_in:  apps,
      });
    } else {
      const app = apps[0];
      exclusiveEvidence.push({
        evidence_id:   eid,
        record,
        hypothesis_id: app.hypothesis_id,
        list_name:     app.list_name,
        list_label:    app.list_label,
        relationship:  app.relationship,
      });
    }
  }

  return {
    case_id:                        graph.case_id,
    causal_attribution_established: graph.causal_attribution_established,
    hypothesis_ids:                 targetHypotheses.map((h) => h.hypothesis_id),
    comparison_note:
      'Comparison is restricted to hypotheses within the same case. ' +
      'Evidence relationships are as recorded in the graph — no new relationships ' +
      'are inferred from temporal proximity or any other heuristic. ' +
      'Assessments are read-only and are not re-derived by this comparison.',
    hypotheses:         hypothesisEntries,
    shared_evidence:    sharedEvidence,
    exclusive_evidence: exclusiveEvidence,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  resolveEvidenceRecord,
  buildHypothesisEvidenceView,
  buildCaseEvidenceIndex,
  buildEnvironmentalContextSummary,
  compareHypothesesEvidence,
  // Exposed for tests
  EVIDENCE_LISTS,
  LIST_LABELS,
  HEURISTIC_WINDOW_LABEL,
};
