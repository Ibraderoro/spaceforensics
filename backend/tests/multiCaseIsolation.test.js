'use strict';

/**
 * Phase 6 — Multi-Case Isolation Tests
 *
 * Verifies that Galaxy 15 and test-case-alpha datasets are completely isolated:
 * - Evidence ID namespaces do not overlap
 * - Parsing one case does not contaminate the other
 * - Concurrent pipeline calls for both cases return correct results for each
 * - buildEvidenceGraph for one case does not affect the other
 */

const { parseEvidenceCSV, buildEvidenceGraph, buildForensicAnalysis } = require('../server');

const G15_CASE  = 'galaxy-15';
const TCA_CASE  = 'test-case-alpha';

let g15Rows;
let tcaRows;
let g15Graph;
let tcaGraph;

beforeAll(async () => {
  jest.setTimeout(30_000);
  // Load both cases concurrently to test parallel safety
  [g15Rows, tcaRows] = await Promise.all([
    parseEvidenceCSV(G15_CASE),
    parseEvidenceCSV(TCA_CASE),
  ]);
  [g15Graph, tcaGraph] = await Promise.all([
    buildEvidenceGraph(G15_CASE, g15Rows),
    buildEvidenceGraph(TCA_CASE, tcaRows),
  ]);
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// ISO-1 — Evidence ID namespaces are completely disjoint
// ─────────────────────────────────────────────────────────────────────────────
test('ISO-1: Galaxy 15 and test-case-alpha evidence IDs are completely disjoint', () => {
  const g15Ids  = new Set(g15Rows.map((r) => r.evidence_id));
  const tcaIds  = new Set(tcaRows.map((r) => r.evidence_id));

  for (const id of tcaIds) {
    expect(g15Ids.has(id)).toBe(false);
  }
  for (const id of g15Ids) {
    expect(tcaIds.has(id)).toBe(false);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ISO-2 — Galaxy 15 IDs use E-G15 prefix; TCA IDs use E-TCA prefix
// ─────────────────────────────────────────────────────────────────────────────
test('ISO-2: Galaxy 15 evidence IDs all match E-G15-XXXX; TCA IDs all match E-TCA-XXXX', () => {
  for (const r of g15Rows) {
    expect(r.evidence_id).toMatch(/^E-G15-\d{4}$/);
  }
  for (const r of tcaRows) {
    expect(r.evidence_id).toMatch(/^E-TCA-\d{4}$/);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ISO-3 — Galaxy 15 graph case_id is still "galaxy-15" after TCA was loaded
// ─────────────────────────────────────────────────────────────────────────────
test('ISO-3: Galaxy 15 graph case_id is "galaxy-15" after test-case-alpha was loaded', () => {
  expect(g15Graph.case_id).toBe(G15_CASE);
});

// ─────────────────────────────────────────────────────────────────────────────
// ISO-4 — TCA graph case_id is "test-case-alpha"
// ─────────────────────────────────────────────────────────────────────────────
test('ISO-4: test-case-alpha graph case_id is "test-case-alpha"', () => {
  expect(tcaGraph.case_id).toBe(TCA_CASE);
});

// ─────────────────────────────────────────────────────────────────────────────
// ISO-5 — Galaxy 15 still has exactly 5 hypotheses (H1–H5) after TCA was loaded
// ─────────────────────────────────────────────────────────────────────────────
test('ISO-5: Galaxy 15 still has exactly 5 hypotheses (H1–H5) after test-case-alpha was loaded', () => {
  expect(g15Graph.hypotheses).toHaveLength(5);
  const ids = g15Graph.hypotheses.map((h) => h.hypothesis_id);
  ['H1','H2','H3','H4','H5'].forEach((id) => expect(ids).toContain(id));
});

// ─────────────────────────────────────────────────────────────────────────────
// ISO-6 — Galaxy 15 causal_attribution_established remains false
// ─────────────────────────────────────────────────────────────────────────────
test('ISO-6: Galaxy 15 causal_attribution_established is still false after TCA was loaded', () => {
  expect(g15Graph.causal_attribution_established).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// ISO-7 — Galaxy 15 H5 is still strongly_supported after TCA was loaded
// ─────────────────────────────────────────────────────────────────────────────
test('ISO-7: Galaxy 15 H5 assessment is still "strongly_supported" after TCA was loaded', () => {
  const H5 = g15Graph.hypotheses.find((h) => h.hypothesis_id === 'H5');
  expect(H5).toBeDefined();
  expect(H5.assessment).toBe('strongly_supported');
});

// ─────────────────────────────────────────────────────────────────────────────
// ISO-8 — TCA graph does not reference any E-G15 evidence IDs
// ─────────────────────────────────────────────────────────────────────────────
test('ISO-8: test-case-alpha graph does not reference any Galaxy 15 evidence IDs', () => {
  const LISTS = ['environmental_context','supporting_evidence','contradicting_evidence','non_discriminating_evidence'];
  for (const h of tcaGraph.hypotheses) {
    for (const listName of LISTS) {
      for (const entry of h[listName] || []) {
        expect(entry.evidence_id).not.toMatch(/^E-G15-/);
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ISO-9 — Galaxy 15 graph does not reference any E-TCA evidence IDs
// ─────────────────────────────────────────────────────────────────────────────
test('ISO-9: Galaxy 15 graph does not reference any test-case-alpha evidence IDs', () => {
  const LISTS = ['environmental_context','supporting_evidence','contradicting_evidence','non_discriminating_evidence'];
  for (const h of g15Graph.hypotheses) {
    for (const listName of LISTS) {
      for (const entry of h[listName] || []) {
        expect(entry.evidence_id).not.toMatch(/^E-TCA-/);
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ISO-10 — Concurrent forensic analysis calls return correct case_ids
// ─────────────────────────────────────────────────────────────────────────────
test('ISO-10: concurrent buildForensicAnalysis calls return correct case_ids for each case', () => {
  const [g15Analysis, tcaAnalysis] = [
    buildForensicAnalysis(G15_CASE,  g15Graph),
    buildForensicAnalysis(TCA_CASE,  tcaGraph),
  ];
  expect(g15Analysis.case_id).toBe(G15_CASE);
  expect(tcaAnalysis.case_id).toBe(TCA_CASE);
});

// ─────────────────────────────────────────────────────────────────────────────
// ISO-11 — Galaxy 15 record count is still 278 after TCA was loaded
// ─────────────────────────────────────────────────────────────────────────────
test('ISO-11: Galaxy 15 still has exactly 278 records after test-case-alpha was loaded', () => {
  expect(g15Rows).toHaveLength(278);
});

// ─────────────────────────────────────────────────────────────────────────────
// ISO-12 — Galaxy 15 first/last IDs unchanged after TCA was loaded
// ─────────────────────────────────────────────────────────────────────────────
test('ISO-12: Galaxy 15 first ID is still E-G15-0001 and last is still E-G15-0278', () => {
  expect(g15Rows[0].evidence_id).toBe('E-G15-0001');
  expect(g15Rows[g15Rows.length - 1].evidence_id).toBe('E-G15-0278');
});
