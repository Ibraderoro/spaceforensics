'use strict';

/**
 * Phase 6 — Second Case Forensic Pipeline Tests
 *
 * Verifies that the full deterministic forensic pipeline runs cleanly for
 * test-case-alpha and produces a structurally valid ValidatedForensicReport.
 *
 * These tests verify structural/contract invariants, not specific assessment
 * values (those are in secondCaseEvidenceGraph.test.js and regression tests
 * would be added separately once values are scientifically reviewed).
 */

const { parseEvidenceCSV, buildEvidenceGraph, buildForensicAnalysis, assembleValidatedForensicReport } = require('../server');
const { buildAnalystHeuristicNarrative, validateAnalystResponse } = require('../services/aiAnalyst');

const CASE_ID = 'test-case-alpha';

const ALLOWED_ASSESSMENTS = new Set([
  'strongly_supported', 'supported', 'mixed', 'weakly_supported', 'insufficient_evidence',
]);

const REQUIRED_REPORT_FIELDS = [
  'case_id', 'analysis_version', 'causal_attribution_established',
  'hypotheses', 'analyst_narrative', 'limitations', 'evidence_summary',
];

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
// SC-FP-1 — Full pipeline produces a report without throwing
// ─────────────────────────────────────────────────────────────────────────────
test('SC-FP-1: full pipeline produces a ValidatedForensicReport without throwing', () => {
  expect(report).toBeDefined();
  expect(typeof report).toBe('object');
  expect(report.case_id).toBe(CASE_ID);
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-FP-2 — Report has all required top-level fields
// ─────────────────────────────────────────────────────────────────────────────
test('SC-FP-2: report has all required top-level fields', () => {
  for (const field of REQUIRED_REPORT_FIELDS) {
    expect(report).toHaveProperty(field);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-FP-3 — causal_attribution_established is false
// ─────────────────────────────────────────────────────────────────────────────
test('SC-FP-3: causal_attribution_established is strictly false', () => {
  expect(report.causal_attribution_established).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-FP-4 — All hypothesis assessments are in the allowed vocabulary
// ─────────────────────────────────────────────────────────────────────────────
test('SC-FP-4: every hypothesis assessment is in ALLOWED_ASSESSMENTS', () => {
  for (const h of report.hypotheses) {
    if (h.assessment !== null && h.assessment !== undefined) {
      expect(ALLOWED_ASSESSMENTS.has(h.assessment)).toBe(true);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-FP-5 — Narrative passes full validation (A1–A10 + B1–B4)
// ─────────────────────────────────────────────────────────────────────────────
test('SC-FP-5: heuristic narrative passes validateAnalystResponse with no errors', () => {
  const { valid, errors } = validateAnalystResponse(narrative, analysis, validIds, graph);
  expect(errors).toEqual([]);
  expect(valid).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-FP-6 — Narrative causal_attribution_established matches analysis
// ─────────────────────────────────────────────────────────────────────────────
test('SC-FP-6: narrative.causal_attribution_established matches analysis', () => {
  expect(report.analyst_narrative.causal_attribution_established).toBe(
    report.causal_attribution_established,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-FP-7 — Narrative assessments match deterministic analysis assessments
// ─────────────────────────────────────────────────────────────────────────────
test('SC-FP-7: narrative hypothesis assessments exactly match deterministic analysis', () => {
  const deterministicMap = new Map(
    report.hypotheses.map((h) => [h.hypothesis_id, h.assessment]),
  );
  for (const ha of report.analyst_narrative.hypothesis_assessments) {
    expect(deterministicMap.has(ha.hypothesis_id)).toBe(true);
    expect(ha.assessment).toBe(deterministicMap.get(ha.hypothesis_id));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-FP-8 — environmental_context_ids and supporting_evidence_ids are disjoint
// ─────────────────────────────────────────────────────────────────────────────
test('SC-FP-8: environmental_context_ids and supporting_evidence_ids are disjoint per hypothesis (V5)', () => {
  for (const h of report.hypotheses) {
    const s = h.evidence_summary;
    const envCtxSet = new Set(s.environmental_context_ids || []);
    for (const id of s.supporting_evidence_ids || []) {
      expect(envCtxSet.has(id)).toBe(false);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-FP-9 — All evidence IDs cited in hypotheses exist in the real dataset
// ─────────────────────────────────────────────────────────────────────────────
test('SC-FP-9: every evidence_id cited in any hypothesis list exists in the parsed evidence', () => {
  for (const h of report.hypotheses) {
    const s = h.evidence_summary;
    const allIds = [
      ...(s.environmental_context_ids          || []),
      ...(s.supporting_evidence_ids            || []),
      ...(s.contradicting_evidence_ids         || []),
      ...(s.non_discriminating_evidence_ids    || []),
    ];
    for (const id of allIds) {
      expect(validIds.has(id)).toBe(true);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-FP-10 — No numerical probabilities in the narrative
// ─────────────────────────────────────────────────────────────────────────────
test('SC-FP-10: narrative contains no numerical probability claims', () => {
  const PROB_RE = /\b\d+(\.\d+)?\s*%|\b\d+(\.\d+)?\s*(probability|chance|likelihood)/i;
  const text = JSON.stringify(report.analyst_narrative);
  expect(PROB_RE.test(text)).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-FP-11 — Pipeline is deterministic across two independent runs
// ─────────────────────────────────────────────────────────────────────────────
test('SC-FP-11: two independent full-pipeline runs produce identical reports', async () => {
  const rows2     = await parseEvidenceCSV(CASE_ID);
  const graph2    = await buildEvidenceGraph(CASE_ID, rows2);
  const analysis2 = buildForensicAnalysis(CASE_ID, graph2);
  const narrative2 = buildAnalystHeuristicNarrative(analysis2);
  const report2   = assembleValidatedForensicReport(analysis2, narrative2);

  // Compare deterministic fields only (narrative.generated_at differs by timestamp)
  expect(report2.case_id).toBe(report.case_id);
  expect(report2.causal_attribution_established).toBe(report.causal_attribution_established);
  expect(report2.hypotheses.map((h) => h.hypothesis_id)).toEqual(
    report.hypotheses.map((h) => h.hypothesis_id),
  );
  expect(report2.hypotheses.map((h) => h.assessment)).toEqual(
    report.hypotheses.map((h) => h.assessment),
  );
});
