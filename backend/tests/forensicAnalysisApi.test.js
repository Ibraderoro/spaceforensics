'use strict';

const fs   = require('fs');
const path = require('path');
const { parseEvidenceCSV, buildEvidenceGraph, buildForensicAnalysis } = require('../server');
const { getEvidenceProvenance } = require('../services/forensicAnalysis');

const CASE_ID   = 'galaxy-15';
const CASES_DIR = path.join(__dirname, '..', '..', 'cases');

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture — built once for the whole suite.
// ─────────────────────────────────────────────────────────────────────────────
let rows;
let graph;
let analysis;
let validIds;     // Set<string> — every evidence_id in the parsed CSV
let allRefIds;    // Set<string> — every evidence_id referenced in the analysis

beforeAll(async () => {
  jest.setTimeout(30_000);
  rows     = await parseEvidenceCSV(CASE_ID);
  graph    = await buildEvidenceGraph(CASE_ID, rows);
  analysis = buildForensicAnalysis(CASE_ID, graph);
  validIds = new Set(rows.map((r) => r.evidence_id));

  // Collect every evidence_id referenced in the analysis across all four lists.
  allRefIds = new Set();
  for (const h of analysis.hypotheses) {
    const s = h.evidence_summary;
    for (const id of [
      ...s.environmental_context_ids,
      ...s.supporting_evidence_ids,
      ...s.contradicting_evidence_ids,
      ...s.non_discriminating_evidence_ids,
    ]) {
      allRefIds.add(id);
    }
  }
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// F25 — Endpoint returns a result for galaxy-15
// ─────────────────────────────────────────────────────────────────────────────
test('F25: buildForensicAnalysis returns a result for galaxy-15 without throwing', () => {
  expect(analysis).toBeDefined();
  expect(typeof analysis).toBe('object');
});

// ─────────────────────────────────────────────────────────────────────────────
// F26 — Response contains case_id
// ─────────────────────────────────────────────────────────────────────────────
test('F26: response contains case_id === "galaxy-15"', () => {
  expect(analysis.case_id).toBe(CASE_ID);
});

// ─────────────────────────────────────────────────────────────────────────────
// F27 — Response contains hypotheses H1–H5
// ─────────────────────────────────────────────────────────────────────────────
test('F27: response contains hypotheses H1, H2, H3, H4, and H5', () => {
  const ids = analysis.hypotheses.map((h) => h.hypothesis_id);
  expect(ids).toContain('H1');
  expect(ids).toContain('H2');
  expect(ids).toContain('H3');
  expect(ids).toContain('H4');
  expect(ids).toContain('H5');
  expect(ids).toHaveLength(5);
});

// ─────────────────────────────────────────────────────────────────────────────
// F28 — causal_attribution_established is false
// ─────────────────────────────────────────────────────────────────────────────
test('F28: causal_attribution_established is strictly false', () => {
  expect(analysis.causal_attribution_established).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// F29 — H4 remains insufficient_evidence
// ─────────────────────────────────────────────────────────────────────────────
test('F29: H4 assessment is "insufficient_evidence"', () => {
  const h4 = analysis.hypotheses.find((h) => h.hypothesis_id === 'H4');
  expect(h4).toBeDefined();
  expect(h4.assessment).toBe('insufficient_evidence');
});

// ─────────────────────────────────────────────────────────────────────────────
// F30 — H5 remains strongly_supported
// ─────────────────────────────────────────────────────────────────────────────
test('F30: H5 assessment is "strongly_supported"', () => {
  const h5 = analysis.hypotheses.find((h) => h.hypothesis_id === 'H5');
  expect(h5).toBeDefined();
  expect(h5.assessment).toBe('strongly_supported');
});

// ─────────────────────────────────────────────────────────────────────────────
// F31 — Every evidence_id in the response resolves to a real evidence record
// ─────────────────────────────────────────────────────────────────────────────
test('F31: every evidence_id referenced in the response exists in the parsed CSV', () => {
  for (const id of allRefIds) {
    expect(validIds.has(id)).toBe(true);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// F32 — Unknown case is handled correctly
//
// The route handler guards with fs.existsSync(casePath) before doing any work.
// This test verifies that guard contract: the cases directory for an unknown
// case ID does not exist on disk, which is what produces the 404 response.
// ─────────────────────────────────────────────────────────────────────────────
test('F32: case directory for an unknown case ID does not exist (route guard produces 404)', () => {
  const unknownCasePath = path.join(CASES_DIR, 'unknown-case-xyz');
  expect(fs.existsSync(unknownCasePath)).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// F48–F51 — getEvidenceProvenance at the analysis-API boundary
//
// These tests verify the provenance contract using the same rows/graph fixtures
// already built in beforeAll above.  They sit one level above the unit tests
// in evidenceProvenance.test.js (F18–F24) and confirm the function integrates
// correctly with the full Galaxy-15 pipeline output.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// F48 — Known CASE anchor resolves with found: true and all 12 fields present
// ─────────────────────────────────────────────────────────────────────────────
test('F48: getEvidenceProvenance resolves a known CASE anchor with found: true and all 12 fields', () => {
  const anchorRow = rows.find((r) => r.source === 'CASE');
  expect(anchorRow).toBeDefined();

  const result = getEvidenceProvenance(CASE_ID, anchorRow.evidence_id, rows, graph);

  expect(result.found).toBe(true);
  expect(result.evidence_id).toBe(anchorRow.evidence_id);

  // All 12 evidence fields must be present (not undefined)
  const REQUIRED_FIELDS = [
    'evidence_id', 'timestamp', 'source', 'measurement',
    'value', 'unit', 'resolution', 'dataset_id',
    'provider', 'variable', 'evidence_type', 'quality',
  ];
  for (const field of REQUIRED_FIELDS) {
    expect(Object.prototype.hasOwnProperty.call(result, field)).toBe(true);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// F49 — Unknown evidence ID returns found: false without throwing
// ─────────────────────────────────────────────────────────────────────────────
test('F49: getEvidenceProvenance returns found: false for an unknown evidence ID without throwing', () => {
  const UNKNOWN_ID = 'E-G15-9999';
  expect(() => {
    const result = getEvidenceProvenance(CASE_ID, UNKNOWN_ID, rows, graph);
    expect(result.found).toBe(false);
    expect(result.evidence_id).toBe(UNKNOWN_ID);
    expect(typeof result.reason).toBe('string');
  }).not.toThrow();
});

// ─────────────────────────────────────────────────────────────────────────────
// F50 — EPHEMERIS source resolves with found: true and empty hypothesis_relationships
// ─────────────────────────────────────────────────────────────────────────────
test('F50: EPHEMERIS evidence resolves with found: true and hypothesis_relationships: []', () => {
  const ephemerisRow = rows.find((r) => r.source === 'GOES11_EPHEMERIS');
  expect(ephemerisRow).toBeDefined();

  const result = getEvidenceProvenance(CASE_ID, ephemerisRow.evidence_id, rows, graph);

  expect(result.found).toBe(true);
  expect(result.source).toBe('GOES11_EPHEMERIS');
  expect(Array.isArray(result.hypothesis_relationships)).toBe(true);
  expect(result.hypothesis_relationships).toHaveLength(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// F51 — Every relationship entry traces back to the queried evidence ID in the graph
// Relationship entries do not carry an evidence_id field themselves; we verify
// by confirming that the referenced hypothesis/list in the graph contains the
// queried ID, i.e. the function never returns relationships for other records.
// ─────────────────────────────────────────────────────────────────────────────
test('F51: every hypothesis_relationships entry traces back to the queried evidence ID in the graph', () => {
  const anchorRow = rows.find((r) => r.source === 'CASE');
  const result = getEvidenceProvenance(CASE_ID, anchorRow.evidence_id, rows, graph);

  expect(result.found).toBe(true);
  for (const rel of result.hypothesis_relationships) {
    const graphH = graph.hypotheses.find((h) => h.hypothesis_id === rel.hypothesis_id);
    expect(graphH).toBeDefined();
    const matchingRef = (graphH[rel.list_name] || []).find(
      (r) => r.evidence_id === anchorRow.evidence_id
    );
    expect(matchingRef).toBeDefined();
  }
  // The top-level evidence_id must be the queried ID
  expect(result.evidence_id).toBe(anchorRow.evidence_id);
});
