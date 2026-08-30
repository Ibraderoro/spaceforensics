'use strict';

// Phase 4.8 — Complete Forensic Pipeline Integration
//
// Verifies the full pipeline end-to-end using real galaxy-15 data:
//
//   parseEvidenceCSV
//     → buildEvidenceGraph
//     → buildForensicAnalysis          (deterministic, Phase 4.2–4.3)
//     → buildAnalystHeuristicNarrative (heuristic AI layer, no API key in test env)
//     → assembleValidatedForensicReport (immutability gate, Phase 4.8)
//
// Galaxy-15 regression assertions (F33–F47) codify the fixed invariants that
// must hold across all future changes.

const { parseEvidenceCSV, buildEvidenceGraph, buildForensicAnalysis, assembleValidatedForensicReport } = require('../server');
const { buildAnalystHeuristicNarrative } = require('../services/aiAnalyst');

const CASE_ID = 'galaxy-15';

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture — built once for the whole suite.
// ─────────────────────────────────────────────────────────────────────────────
let rows;
let graph;
let analysis;
let validIds;
let narrative;
let report;

beforeAll(async () => {
  jest.setTimeout(30_000);
  rows      = await parseEvidenceCSV(CASE_ID);
  graph     = await buildEvidenceGraph(CASE_ID, rows);
  analysis  = buildForensicAnalysis(CASE_ID, graph);
  validIds  = new Set(rows.map((r) => r.evidence_id));
  narrative = buildAnalystHeuristicNarrative(analysis);
  report    = assembleValidatedForensicReport(analysis, narrative);
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// F33 — Full pipeline produces a ValidatedForensicReport without throwing
// ─────────────────────────────────────────────────────────────────────────────
test('F33: full pipeline produces a ValidatedForensicReport without throwing', () => {
  expect(report).toBeDefined();
  expect(typeof report).toBe('object');
  expect(report.case_id).toBe(CASE_ID);
  expect(report.analyst_narrative).toBeDefined();
});

// ─────────────────────────────────────────────────────────────────────────────
// F34 — causal_attribution_established is false in the report
// ─────────────────────────────────────────────────────────────────────────────
test('F34: causal_attribution_established is strictly false in the ValidatedForensicReport', () => {
  expect(report.causal_attribution_established).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// F35 — H1 assessment is mixed
// ─────────────────────────────────────────────────────────────────────────────
test('F35: H1 assessment is "mixed"', () => {
  const h1 = report.hypotheses.find((h) => h.hypothesis_id === 'H1');
  expect(h1).toBeDefined();
  expect(h1.assessment).toBe('mixed');
});

// ─────────────────────────────────────────────────────────────────────────────
// F36 — H2 assessment is mixed
// ─────────────────────────────────────────────────────────────────────────────
test('F36: H2 assessment is "mixed"', () => {
  const h2 = report.hypotheses.find((h) => h.hypothesis_id === 'H2');
  expect(h2).toBeDefined();
  expect(h2.assessment).toBe('mixed');
});

// ─────────────────────────────────────────────────────────────────────────────
// F37 — H3 assessment is supported
// ─────────────────────────────────────────────────────────────────────────────
test('F37: H3 assessment is "supported"', () => {
  const h3 = report.hypotheses.find((h) => h.hypothesis_id === 'H3');
  expect(h3).toBeDefined();
  expect(h3.assessment).toBe('supported');
});

// ─────────────────────────────────────────────────────────────────────────────
// F38 — H4 assessment is insufficient_evidence
// ─────────────────────────────────────────────────────────────────────────────
test('F38: H4 assessment is "insufficient_evidence"', () => {
  const h4 = report.hypotheses.find((h) => h.hypothesis_id === 'H4');
  expect(h4).toBeDefined();
  expect(h4.assessment).toBe('insufficient_evidence');
});

// ─────────────────────────────────────────────────────────────────────────────
// F39 — H5 assessment is strongly_supported
// ─────────────────────────────────────────────────────────────────────────────
test('F39: H5 assessment is "strongly_supported"', () => {
  const h5 = report.hypotheses.find((h) => h.hypothesis_id === 'H5');
  expect(h5).toBeDefined();
  expect(h5.assessment).toBe('strongly_supported');
});

// ─────────────────────────────────────────────────────────────────────────────
// F40 — analyst_narrative present with source "heuristic" (no API key in test env)
// ─────────────────────────────────────────────────────────────────────────────
test('F40: analyst_narrative is present with source "heuristic" (no API key in test env)', () => {
  expect(process.env.WATSONX_AI_APIKEY).toBeFalsy(); // guard
  expect(report.analyst_narrative).toBeDefined();
  expect(report.analyst_narrative.source).toBe('heuristic');
  expect(typeof report.analyst_narrative.generated_at).toBe('string');
});

// ─────────────────────────────────────────────────────────────────────────────
// F41 — analyst_narrative.causal_attribution_established is false
// ─────────────────────────────────────────────────────────────────────────────
test('F41: analyst_narrative.causal_attribution_established is false', () => {
  expect(report.analyst_narrative.causal_attribution_established).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// F42 — analyst_narrative assessments match deterministic assessments exactly
// ─────────────────────────────────────────────────────────────────────────────
test('F42: analyst_narrative hypothesis assessments exactly match deterministic analysis', () => {
  const deterministicMap = new Map(
    report.hypotheses.map((h) => [h.hypothesis_id, h.assessment]),
  );
  for (const ha of report.analyst_narrative.hypothesis_assessments) {
    expect(deterministicMap.has(ha.hypothesis_id)).toBe(true);
    expect(ha.assessment).toBe(deterministicMap.get(ha.hypothesis_id));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// F43 — environmental_context_ids and supporting_evidence_ids are disjoint
//       (no evidence flooding) for every hypothesis
// ─────────────────────────────────────────────────────────────────────────────
test('F43: environmental_context_ids and supporting_evidence_ids are disjoint for every hypothesis', () => {
  for (const h of report.hypotheses) {
    const envCtxSet = new Set(h.evidence_summary.environmental_context_ids);
    for (const id of h.evidence_summary.supporting_evidence_ids) {
      expect(envCtxSet.has(id)).toBe(false);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// F44 — GOES11_EPHEMERIS evidence_ids are absent from all hypothesis
//       relationship lists (environmental_context, supporting_evidence,
//       contradicting_evidence, non_discriminating_evidence)
// ─────────────────────────────────────────────────────────────────────────────
test('F44: GOES11_EPHEMERIS evidence_ids do not appear in any hypothesis relationship list', () => {
  // Collect all EPHEMERIS evidence_ids from the parsed CSV
  const ephemerisIds = new Set(
    rows
      .filter((r) => r.source === 'GOES11_EPHEMERIS')
      .map((r) => r.evidence_id),
  );

  // Guard: galaxy-15 must have some EPHEMERIS records
  expect(ephemerisIds.size).toBeGreaterThan(0);

  const LISTS = ['environmental_context', 'supporting_evidence', 'contradicting_evidence', 'non_discriminating_evidence'];

  for (const gh of graph.hypotheses) {
    for (const listName of LISTS) {
      for (const ref of (gh[listName] || [])) {
        expect(ephemerisIds.has(ref.evidence_id)).toBe(false);
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// F45 — No evidence_id appears more than once across the four lists within
//       a single hypothesis (no intra-hypothesis flooding)
// ─────────────────────────────────────────────────────────────────────────────
test('F45: no evidence_id appears in more than one list within a single hypothesis', () => {
  const LISTS = ['environmental_context', 'supporting_evidence', 'contradicting_evidence', 'non_discriminating_evidence'];

  for (const h of report.hypotheses) {
    const seen = new Map(); // evidence_id → list_name
    const s = h.evidence_summary;
    const combined = [
      ...s.environmental_context_ids.map((id) => [id, 'environmental_context']),
      ...s.supporting_evidence_ids.map((id) => [id, 'supporting_evidence']),
      ...s.contradicting_evidence_ids.map((id) => [id, 'contradicting_evidence']),
      ...s.non_discriminating_evidence_ids.map((id) => [id, 'non_discriminating_evidence']),
    ];
    for (const [id, list] of combined) {
      expect(seen.has(id)).toBe(false);
      seen.set(id, list);
    }
    // Also verify via the graph directly
    for (const listName of LISTS) {
      const gh = graph.hypotheses.find((g) => g.hypothesis_id === h.hypothesis_id);
      if (!gh) continue;
      const seenInList = new Set();
      for (const ref of (gh[listName] || [])) {
        expect(seenInList.has(ref.evidence_id)).toBe(false);
        seenInList.add(ref.evidence_id);
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// F46 — Every evidence_id in analyst_narrative.hypothesis_assessments[*].evidence_ids
//       exists in validIds (no hallucinated IDs)
// ─────────────────────────────────────────────────────────────────────────────
test('F46: every evidence_id in analyst_narrative exists in validIds', () => {
  for (const ha of report.analyst_narrative.hypothesis_assessments) {
    for (const eid of (ha.evidence_ids || [])) {
      expect(validIds.has(eid)).toBe(true);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// F47 — analyst_narrative.hypothesis_assessments contains exactly one entry
//       per source hypothesis (H1–H5)
// ─────────────────────────────────────────────────────────────────────────────
test('F47: analyst_narrative.hypothesis_assessments has exactly one entry per source hypothesis', () => {
  const sourceIds = report.hypotheses.map((h) => h.hypothesis_id).sort();
  const narrativeIds = report.analyst_narrative.hypothesis_assessments
    .map((ha) => ha.hypothesis_id)
    .sort();
  expect(narrativeIds).toEqual(sourceIds);
});
