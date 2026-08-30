'use strict';

const { parseEvidenceCSV, buildEvidenceGraph } = require('../server');
const {
  runForensicAnalysis,
  buildForensicAnalysis,
  validateForensicAnalysis,
  ForensicAnalysisValidationError,
  buildDetailedHypothesisComparison,
  ANALYSIS_VERSION,
} = require('../services/forensicAnalysis');

const CASE_ID = 'galaxy-15';

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture — built once for the whole file.
//
// `analysis`   — Phase 4.1 output (runForensicAnalysis)
// `analysis42` — Phase 4.2 output (buildForensicAnalysis)
// Both share the same `rows` and `graph` instance.
// ─────────────────────────────────────────────────────────────────────────────
let rows;
let graph;
let validIds;
let analysis;    // Phase 4.1
let analysis42;  // Phase 4.2
let analysis43;  // Phase 4.3 — alias of analysis42 (same deterministic output)

beforeAll(async () => {
  rows       = await parseEvidenceCSV(CASE_ID);
  graph      = await buildEvidenceGraph(CASE_ID, rows);
  validIds   = new Set(rows.map((r) => r.evidence_id));
  analysis   = runForensicAnalysis(CASE_ID, rows, graph);
  analysis42 = buildForensicAnalysis(CASE_ID, graph);
  analysis43 = analysis42; // deterministic — same graph produces the same object
});

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 4.1 TESTS — runForensicAnalysis (T-FA-1 through T-FA-15)
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// T-FA-1 — Root shape
// ─────────────────────────────────────────────────────────────────────────────
test('T-FA-1: ForensicAnalysis root has all required top-level fields', () => {
  expect(typeof analysis.case_id).toBe('string');
  expect(typeof analysis.analysis_version).toBe('string');
  expect(analysis).toHaveProperty('causal_attribution_established');
  expect(Array.isArray(analysis.hypotheses)).toBe(true);
  expect(analysis).toHaveProperty('comparison');
  expect(Array.isArray(analysis.limitations)).toBe(true);
  expect(Array.isArray(analysis.heuristic_notes)).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// T-FA-2 — causal_attribution_established passthrough
// ─────────────────────────────────────────────────────────────────────────────
test('T-FA-2: causal_attribution_established is the same boolean as in the graph', () => {
  expect(typeof analysis.causal_attribution_established).toBe('boolean');
  expect(analysis.causal_attribution_established).toBe(graph.causal_attribution_established);
  // Galaxy 15 baseline: always false
  expect(analysis.causal_attribution_established).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// T-FA-3 — Five HypothesisAnalysis entries with correct IDs
// ─────────────────────────────────────────────────────────────────────────────
test('T-FA-3: analysis.hypotheses has exactly five entries with IDs H1–H5', () => {
  expect(analysis.hypotheses).toHaveLength(5);
  const ids = analysis.hypotheses.map((h) => h.hypothesis_id);
  expect(ids).toContain('H1');
  expect(ids).toContain('H2');
  expect(ids).toContain('H3');
  expect(ids).toContain('H4');
  expect(ids).toContain('H5');
});

// ─────────────────────────────────────────────────────────────────────────────
// T-FA-4 — HypothesisAnalysis shape
// ─────────────────────────────────────────────────────────────────────────────
test('T-FA-4: every HypothesisAnalysis has required fields with correct types', () => {
  for (const h of analysis.hypotheses) {
    expect(typeof h.hypothesis_id).toBe('string');
    expect(typeof h.label).toBe('string');
    expect(typeof h.assessment).toBe('string');
    expect(h).toHaveProperty('evidence_summary');
    expect(typeof h.evidence_summary).toBe('object');
    expect(Array.isArray(h.limitations)).toBe(true);
    // heuristic_note is present and is either string or null
    expect(h).toHaveProperty('heuristic_note');
    expect(h.heuristic_note === null || typeof h.heuristic_note === 'string').toBe(true);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T-FA-5 — No numerical probabilities or confidence scores anywhere
// ─────────────────────────────────────────────────────────────────────────────
test('T-FA-5: no numerical probability, confidence score, or percentage in the serialised analysis', () => {
  const serialised = JSON.stringify(analysis);
  expect(serialised).not.toMatch(/\b\d+(\.\d+)?%/);
  expect(serialised).not.toMatch(/"confidence"\s*:/);
  expect(serialised).not.toMatch(/"probability"\s*:/);
  expect(serialised).not.toMatch(/"score"\s*:/);
});

// ─────────────────────────────────────────────────────────────────────────────
// T-FA-6 — All assessment values use the allowed categorical vocabulary
// ─────────────────────────────────────────────────────────────────────────────
test('T-FA-6: all assessment values use only the allowed categorical vocabulary', () => {
  const ALLOWED = new Set([
    'strongly_supported',
    'supported',
    'mixed',
    'weakly_supported',
    'insufficient_evidence',
  ]);

  for (const h of analysis.hypotheses) {
    if (h.assessment !== null && h.assessment !== undefined) {
      expect(ALLOWED.has(h.assessment)).toBe(true);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T-FA-7 — Evidence provenance: all IDs in EvidenceSummary are valid
// ─────────────────────────────────────────────────────────────────────────────
test('T-FA-7: every evidence_id in every EvidenceSummary ID list exists in the parsed evidence', () => {
  const ID_LISTS = [
    'environmental_context_ids',
    'supporting_evidence_ids',
    'contradicting_evidence_ids',
    'non_discriminating_evidence_ids',
  ];

  for (const h of analysis.hypotheses) {
    for (const listName of ID_LISTS) {
      for (const eid of h.evidence_summary[listName] || []) {
        expect(validIds.has(eid)).toBe(true);
        if (!validIds.has(eid)) {
          throw new Error(
            `HypothesisAnalysis ${h.hypothesis_id} evidence_summary.${listName} references unknown evidence_id: ${eid}`
          );
        }
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T-FA-8 — EvidenceSummary counts match ID array lengths
// ─────────────────────────────────────────────────────────────────────────────
test('T-FA-8: EvidenceSummary _count fields match the length of their corresponding _ids arrays', () => {
  for (const h of analysis.hypotheses) {
    const s = h.evidence_summary;
    expect(s.environmental_context_count).toBe(s.environmental_context_ids.length);
    expect(s.supporting_evidence_count).toBe(s.supporting_evidence_ids.length);
    expect(s.contradicting_evidence_count).toBe(s.contradicting_evidence_ids.length);
    expect(s.non_discriminating_evidence_count).toBe(s.non_discriminating_evidence_ids.length);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T-FA-9 — H4 EvidenceSummary: all counts zero, all ID arrays empty
// H4 (ground segment / RF link anomaly) has no evidence from this dataset.
// ─────────────────────────────────────────────────────────────────────────────
test('T-FA-9: H4 EvidenceSummary has all counts at 0 and all ID arrays empty', () => {
  const H4 = analysis.hypotheses.find((h) => h.hypothesis_id === 'H4');
  expect(H4).toBeDefined();
  const s = H4.evidence_summary;
  expect(s.environmental_context_count).toBe(0);
  expect(s.supporting_evidence_count).toBe(0);
  expect(s.contradicting_evidence_count).toBe(0);
  expect(s.non_discriminating_evidence_count).toBe(0);
  expect(s.environmental_context_ids).toHaveLength(0);
  expect(s.supporting_evidence_ids).toHaveLength(0);
  expect(s.contradicting_evidence_ids).toHaveLength(0);
  expect(s.non_discriminating_evidence_ids).toHaveLength(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// T-FA-10 — comparison.most_supported is H5
// H5 carries assessment 'strongly_supported' — the highest rank.
// ─────────────────────────────────────────────────────────────────────────────
test('T-FA-10: comparison.most_supported is H5 (strongly_supported is the highest assessment)', () => {
  expect(analysis.comparison.most_supported).toBe('H5');
});

// ─────────────────────────────────────────────────────────────────────────────
// T-FA-11 — comparison.supported_hypotheses includes H3 and H5
// ─────────────────────────────────────────────────────────────────────────────
test('T-FA-11: comparison.supported_hypotheses includes H3 and H5', () => {
  expect(analysis.comparison.supported_hypotheses).toContain('H3');
  expect(analysis.comparison.supported_hypotheses).toContain('H5');
});

// ─────────────────────────────────────────────────────────────────────────────
// T-FA-12 — comparison.mixed_hypotheses includes H1 and H2
// ─────────────────────────────────────────────────────────────────────────────
test('T-FA-12: comparison.mixed_hypotheses includes H1 and H2', () => {
  expect(analysis.comparison.mixed_hypotheses).toContain('H1');
  expect(analysis.comparison.mixed_hypotheses).toContain('H2');
});

// ─────────────────────────────────────────────────────────────────────────────
// T-FA-13 — comparison.insufficient_hypotheses includes H4
// ─────────────────────────────────────────────────────────────────────────────
test('T-FA-13: comparison.insufficient_hypotheses includes H4', () => {
  expect(analysis.comparison.insufficient_hypotheses).toContain('H4');
});

// ─────────────────────────────────────────────────────────────────────────────
// T-FA-14 — heuristic_notes is non-empty (H1 and H2 both carry heuristic_note)
// ─────────────────────────────────────────────────────────────────────────────
test('T-FA-14: analysis.heuristic_notes is a non-empty array of strings', () => {
  expect(analysis.heuristic_notes.length).toBeGreaterThan(0);
  for (const note of analysis.heuristic_notes) {
    expect(typeof note).toBe('string');
    expect(note.length).toBeGreaterThan(0);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T-FA-15 — analysis.limitations is non-empty; every entry has type and description
// ─────────────────────────────────────────────────────────────────────────────
test('T-FA-15: analysis.limitations is non-empty and every entry has a non-empty type and description', () => {
  expect(analysis.limitations.length).toBeGreaterThan(0);
  for (const l of analysis.limitations) {
    expect(typeof l.type).toBe('string');
    expect(l.type.length).toBeGreaterThan(0);
    expect(typeof l.description).toBe('string');
    expect(l.description.length).toBeGreaterThan(0);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 4.2 TESTS — buildForensicAnalysis + validateForensicAnalysis (F1–F10)
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// F1 — Valid evidence graph produces a valid analysis object
// ─────────────────────────────────────────────────────────────────────────────
test('F1: valid evidence graph produces valid analysis with all required top-level fields', () => {
  expect(typeof analysis42.case_id).toBe('string');
  expect(typeof analysis42.analysis_version).toBe('string');
  expect(analysis42).toHaveProperty('causal_attribution_established');
  // event block — derived from case.json
  expect(analysis42).toHaveProperty('event');
  expect(analysis42.event).not.toBeNull();
  expect(typeof analysis42.event.timestamp).toBe('string');
  expect(typeof analysis42.event.label).toBe('string');
  expect(typeof analysis42.event.description).toBe('string');
  expect(analysis42.event).toHaveProperty('recovery');
  expect(analysis42.event).toHaveProperty('target_asset');
  expect(analysis42.event).toHaveProperty('data_window');
  // aggregate evidence_summary
  expect(analysis42).toHaveProperty('evidence_summary');
  expect(typeof analysis42.evidence_summary.total_environmental_context).toBe('number');
  expect(typeof analysis42.evidence_summary.total_supporting_evidence).toBe('number');
  expect(typeof analysis42.evidence_summary.total_contradicting_evidence).toBe('number');
  expect(typeof analysis42.evidence_summary.total_non_discriminating_evidence).toBe('number');
  expect(typeof analysis42.evidence_summary.total_limitations).toBe('number');
  // standard fields
  expect(Array.isArray(analysis42.hypotheses)).toBe(true);
  expect(analysis42).toHaveProperty('comparison');
  expect(Array.isArray(analysis42.limitations)).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// F2 — All H1–H5 are represented in the analysis
// ─────────────────────────────────────────────────────────────────────────────
test('F2: all H1–H5 are represented in analysis42.hypotheses', () => {
  expect(analysis42.hypotheses).toHaveLength(5);
  const ids = analysis42.hypotheses.map((h) => h.hypothesis_id);
  ['H1', 'H2', 'H3', 'H4', 'H5'].forEach((id) => expect(ids).toContain(id));
});

// ─────────────────────────────────────────────────────────────────────────────
// F3 — Evidence IDs are preserved with original provenance
// Every evidence_id in every HypothesisAnalysis summary list must exist in
// the graph's own id pool (collected from all four lists of all hypotheses).
// ─────────────────────────────────────────────────────────────────────────────
test('F3: every evidence_id in analysis42 is preserved from the graph (no invented IDs)', () => {
  // Build graph id pool — the source of truth for this layer.
  const EVIDENCE_LISTS = [
    'environmental_context',
    'supporting_evidence',
    'contradicting_evidence',
    'non_discriminating_evidence',
  ];
  const graphIds = new Set();
  for (const h of graph.hypotheses) {
    for (const listName of EVIDENCE_LISTS) {
      for (const ref of h[listName] || []) {
        graphIds.add(ref.evidence_id);
      }
    }
  }

  const SUMMARY_LISTS = [
    'environmental_context_ids',
    'supporting_evidence_ids',
    'contradicting_evidence_ids',
    'non_discriminating_evidence_ids',
  ];

  for (const h of analysis42.hypotheses) {
    for (const listName of SUMMARY_LISTS) {
      for (const eid of h.evidence_summary[listName] || []) {
        expect(graphIds.has(eid)).toBe(true);
        if (!graphIds.has(eid)) {
          throw new Error(
            `F3: hypothesis ${h.hypothesis_id} evidence_summary.${listName} ` +
            `contains invented evidence_id: ${eid}`
          );
        }
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// F4 — Nonexistent evidence IDs are rejected by the validator
// Uses a hand-crafted fake graph passed directly to validateForensicAnalysis.
// buildForensicAnalysis is NOT called here — this test is isolated to
// validator rejection behavior.
// ─────────────────────────────────────────────────────────────────────────────
test('F4: validateForensicAnalysis rejects an analysis referencing an evidence_id not in the graph', () => {
  // Minimal fake graph — contains only one valid id 'E-G15-0001'.
  const fakeGraph = {
    case_id: 'galaxy-15',
    causal_attribution_established: false,
    hypotheses: [
      {
        hypothesis_id: 'H1',
        label:         'fake hypothesis',
        assessment:    'mixed',
        environmental_context:      [{ evidence_id: 'E-G15-0001', relationship: 'r', interpretation: 'i' }],
        supporting_evidence:        [],
        contradicting_evidence:     [],
        non_discriminating_evidence: [],
        heuristic_note:  null,
        limitations:     [{ type: 'unresolved', description: 'placeholder' }],
      },
    ],
  };

  // Analysis claims an id that does not exist in fakeGraph.
  const fakeAnalysis = {
    case_id:                        'galaxy-15',
    analysis_version:               ANALYSIS_VERSION,
    causal_attribution_established: false,
    hypotheses: [
      {
        hypothesis_id: 'H1',
        label:         'fake hypothesis',
        assessment:    'mixed',
        evidence_summary: {
          environmental_context_count:        1,
          supporting_evidence_count:          0,
          contradicting_evidence_count:       0,
          non_discriminating_evidence_count:  0,
          environmental_context_ids:          ['E-G15-FAKE-9999'],   // ← does not exist
          supporting_evidence_ids:            [],
          contradicting_evidence_ids:         [],
          non_discriminating_evidence_ids:    [],
        },
        limitations:    [{ type: 'unresolved', description: 'placeholder' }],
        heuristic_note: null,
      },
    ],
    comparison:  { assessed_hypotheses: ['H1'], supported_hypotheses: [], mixed_hypotheses: ['H1'], insufficient_hypotheses: [], most_supported: 'H1' },
    limitations: [{ type: 'unresolved', description: 'placeholder' }],
  };

  expect(() => validateForensicAnalysis(fakeAnalysis, fakeGraph))
    .toThrow(ForensicAnalysisValidationError);

  // Also verify the violations array is populated.
  try {
    validateForensicAnalysis(fakeAnalysis, fakeGraph);
  } catch (err) {
    expect(err.violations.length).toBeGreaterThan(0);
    expect(err.violations.some((v) => v.includes('E-G15-FAKE-9999'))).toBe(true);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// F5 — causal_attribution_established remains false for Galaxy 15
// ─────────────────────────────────────────────────────────────────────────────
test('F5: analysis42.causal_attribution_established is strictly boolean false', () => {
  expect(typeof analysis42.causal_attribution_established).toBe('boolean');
  expect(analysis42.causal_attribution_established).toBe(false);
  // Must equal the graph value (passthrough — never calculated independently).
  expect(analysis42.causal_attribution_established).toBe(graph.causal_attribution_established);
});

// ─────────────────────────────────────────────────────────────────────────────
// F6 — environmental_context remains distinct from supporting_evidence
// No evidence_id may appear in both lists for the same hypothesis.
// ─────────────────────────────────────────────────────────────────────────────
test('F6: no evidence_id appears in both environmental_context and supporting_evidence for any hypothesis', () => {
  for (const h of analysis42.hypotheses) {
    const ecSet = new Set(h.evidence_summary.environmental_context_ids);
    for (const eid of h.evidence_summary.supporting_evidence_ids) {
      expect(ecSet.has(eid)).toBe(false);
      if (ecSet.has(eid)) {
        throw new Error(
          `F6: hypothesis ${h.hypothesis_id} evidence_id '${eid}' ` +
          `appears in both environmental_context and supporting_evidence`
        );
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// F7 — H4 remains insufficient_evidence
// H4 (ground segment / RF link anomaly) cannot be evaluated from this dataset.
// ─────────────────────────────────────────────────────────────────────────────
test('F7: H4 assessment remains insufficient_evidence', () => {
  const H4 = analysis42.hypotheses.find((h) => h.hypothesis_id === 'H4');
  expect(H4).toBeDefined();
  expect(H4.assessment).toBe('insufficient_evidence');
});

// ─────────────────────────────────────────────────────────────────────────────
// F8 — H5 remains strongly_supported
// H5 (insufficient evidence for causal attribution) is the strongest assessment
// in this dataset.
// ─────────────────────────────────────────────────────────────────────────────
test('F8: H5 assessment remains strongly_supported', () => {
  const H5 = analysis42.hypotheses.find((h) => h.hypothesis_id === 'H5');
  expect(H5).toBeDefined();
  expect(H5.assessment).toBe('strongly_supported');
});

// ─────────────────────────────────────────────────────────────────────────────
// F9 — No numerical probability or confidence values are generated
// ─────────────────────────────────────────────────────────────────────────────
test('F9: no numerical probability, confidence score, or percentage in serialised analysis42', () => {
  const serialised = JSON.stringify(analysis42);
  expect(serialised).not.toMatch(/\b\d+(\.\d+)?%/);
  expect(serialised).not.toMatch(/"confidence"\s*:/);
  expect(serialised).not.toMatch(/"probability"\s*:/);
  expect(serialised).not.toMatch(/"score"\s*:/);
});

// ─────────────────────────────────────────────────────────────────────────────
// F10 — Limitations are preserved from the graph
// Every limitation (type + description pair) present on a graph hypothesis must
// appear somewhere in analysis42.limitations (the top-level deduped list).
// ─────────────────────────────────────────────────────────────────────────────
test('F10: every graph hypothesis limitation is preserved in analysis42.limitations', () => {
  // Build a set of description strings present in the top-level limitations list.
  const topLevelDescriptions = new Set(
    analysis42.limitations.map((l) => l.description)
  );

  for (const gh of graph.hypotheses) {
    for (const l of gh.limitations || []) {
      expect(topLevelDescriptions.has(l.description)).toBe(true);
      if (!topLevelDescriptions.has(l.description)) {
        throw new Error(
          `F10: limitation from hypothesis ${gh.hypothesis_id} not found in ` +
          `analysis42.limitations: "${l.description.slice(0, 80)}..."`
        );
      }
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 4.3 TESTS — hypothesis_comparison / buildDetailedHypothesisComparison
//                   (F11–F17)
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// F11 — comparison includes H1–H5 with structurally valid evidence_profile
// Checks shape and required fields only; exact cardinalities are covered by F14.
// ─────────────────────────────────────────────────────────────────────────────
test('F11: hypothesis_comparison has 5 entries for H1–H5 with correct evidence_profile structure', () => {
  expect(Array.isArray(analysis43.hypothesis_comparison)).toBe(true);
  expect(analysis43.hypothesis_comparison).toHaveLength(5);

  const ids = analysis43.hypothesis_comparison.map((e) => e.hypothesis_id);
  ['H1', 'H2', 'H3', 'H4', 'H5'].forEach((id) => expect(ids).toContain(id));

  // Every entry has the required fields.
  for (const entry of analysis43.hypothesis_comparison) {
    expect(typeof entry.hypothesis_id).toBe('string');
    expect(typeof entry.label).toBe('string');
    expect(typeof entry.assessment).toBe('string');
    expect(entry).toHaveProperty('evidence_profile');
    expect(Array.isArray(entry.key_observations)).toBe(true);
    expect(entry.key_observations.length).toBeGreaterThan(0);
    expect(Array.isArray(entry.key_limitations)).toBe(true);
    expect(entry.key_limitations.length).toBeGreaterThan(0);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// F12 — comparison preserves assessments from the graph
// ─────────────────────────────────────────────────────────────────────────────
test('F12: every hypothesis_comparison entry carries the same assessment as the graph hypothesis', () => {
  for (const entry of analysis43.hypothesis_comparison) {
    const graphH = graph.hypotheses.find((h) => h.hypothesis_id === entry.hypothesis_id);
    expect(graphH).toBeDefined();
    expect(entry.assessment).toBe(graphH.assessment);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// F13 — comparison does not create numerical probabilities or confidence values
// ─────────────────────────────────────────────────────────────────────────────
test('F13: hypothesis_comparison contains no numerical probability, confidence score, or percentage', () => {
  const serialised = JSON.stringify(analysis43.hypothesis_comparison);
  expect(serialised).not.toMatch(/\b\d+(\.\d+)?%/);
  expect(serialised).not.toMatch(/"confidence"\s*:/);
  expect(serialised).not.toMatch(/"probability"\s*:/);
  expect(serialised).not.toMatch(/"score"\s*:/);
  expect(serialised).not.toMatch(/most likely/i);
  expect(serialised).not.toMatch(/\d+(?:\.\d+)?\s*probability/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// F14 — comparison preserves evidence provenance
// Every id in every evidence_profile list must exist in the graph id pool.
// ─────────────────────────────────────────────────────────────────────────────
test('F14: every evidence_id in every evidence_profile is preserved from the graph (no invented IDs)', () => {
  const GRAPH_LISTS = [
    'environmental_context',
    'supporting_evidence',
    'contradicting_evidence',
    'non_discriminating_evidence',
  ];
  const graphIds = new Set();
  for (const h of graph.hypotheses) {
    for (const listName of GRAPH_LISTS) {
      for (const ref of h[listName] || []) {
        graphIds.add(ref.evidence_id);
      }
    }
  }

  const PROFILE_LISTS = [
    'environmental_context_ids',
    'supporting_evidence_ids',
    'contradicting_evidence_ids',
    'non_discriminating_evidence_ids',
  ];

  for (const entry of analysis43.hypothesis_comparison) {
    for (const listName of PROFILE_LISTS) {
      for (const eid of entry.evidence_profile[listName] || []) {
        expect(graphIds.has(eid)).toBe(true);
        if (!graphIds.has(eid)) {
          throw new Error(
            `F14: hypothesis_comparison entry ${entry.hypothesis_id} ` +
            `evidence_profile.${listName} contains invented evidence_id: ${eid}`,
          );
        }
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// F15 — H4 remains insufficient_evidence in the comparison
// ─────────────────────────────────────────────────────────────────────────────
test('F15: hypothesis_comparison entry for H4 has assessment insufficient_evidence', () => {
  const H4 = analysis43.hypothesis_comparison.find((e) => e.hypothesis_id === 'H4');
  expect(H4).toBeDefined();
  expect(H4.assessment).toBe('insufficient_evidence');
  // All evidence_profile counts must be zero.
  expect(H4.evidence_profile.environmental_context_count).toBe(0);
  expect(H4.evidence_profile.supporting_evidence_count).toBe(0);
  expect(H4.evidence_profile.contradicting_evidence_count).toBe(0);
  expect(H4.evidence_profile.non_discriminating_evidence_count).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// F16 — H5 remains strongly_supported in the comparison
// ─────────────────────────────────────────────────────────────────────────────
test('F16: hypothesis_comparison entry for H5 has assessment strongly_supported', () => {
  const H5 = analysis43.hypothesis_comparison.find((e) => e.hypothesis_id === 'H5');
  expect(H5).toBeDefined();
  expect(H5.assessment).toBe('strongly_supported');
  // H5 has 1 supporting evidence record (anchor event) and no env context.
  expect(H5.evidence_profile.supporting_evidence_count).toBe(1);
  expect(H5.evidence_profile.environmental_context_count).toBe(0);
  // key_observations must include the attribution outcome statement.
  const hasAttributionObs = H5.key_observations.some((o) =>
    o.includes('Causal attribution is not established'),
  );
  expect(hasAttributionObs).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// F17 — causal_attribution_established remains false in analysis43
// ─────────────────────────────────────────────────────────────────────────────
test('F17: analysis43.causal_attribution_established is strictly boolean false', () => {
  expect(typeof analysis43.causal_attribution_established).toBe('boolean');
  expect(analysis43.causal_attribution_established).toBe(false);
});
