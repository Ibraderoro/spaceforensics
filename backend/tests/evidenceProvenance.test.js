'use strict';

const { parseEvidenceCSV, buildEvidenceGraph } = require('../server');
const {
  getEvidenceProvenance,
  ForensicAnalysisValidationError,
} = require('../services/forensicAnalysis');

const CASE_ID = 'galaxy-15';

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture — built once for the whole suite.
// ─────────────────────────────────────────────────────────────────────────────
let rows;
let graph;
let anchorId;     // evidence_id of the single CASE source row
let ephemerisId;  // evidence_id of the first GOES11_EPHEMERIS row
let ep8WindowId;  // evidence_id of the first EP8 row referenced in a graph list

beforeAll(async () => {
  rows  = await parseEvidenceCSV(CASE_ID);
  graph = await buildEvidenceGraph(CASE_ID, rows);

  // The CASE anchor row — appears in H3 and H5 supporting_evidence.
  const anchorRow = rows.find((r) => r.source === 'CASE');
  anchorId = anchorRow.evidence_id;

  // An EPHEMERIS row — intentionally excluded from all hypothesis lists (T23).
  const ephemerisRow = rows.find((r) => r.source === 'GOES11_EPHEMERIS');
  ephemerisId = ephemerisRow.evidence_id;

  // The first EP8 id that appears in a graph environmental_context list (H1/H2).
  for (const h of graph.hypotheses) {
    if ((h.environmental_context || []).length > 0) {
      ep8WindowId = h.environmental_context[0].evidence_id;
      break;
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// F18 — Known evidence ID resolves with found: true and required shape
// Uses the CASE anchor record (the primary forensic anchor for Galaxy 15).
// ─────────────────────────────────────────────────────────────────────────────
test('F18: known CASE anchor evidence_id resolves with found: true and all top-level fields', () => {
  const prov = getEvidenceProvenance(CASE_ID, anchorId, rows, graph);

  expect(prov.found).toBe(true);
  expect(prov.evidence_id).toBe(anchorId);

  // All 12 evidence row fields must be present.
  expect(prov).toHaveProperty('timestamp');
  expect(prov).toHaveProperty('source');
  expect(prov).toHaveProperty('measurement');
  expect(prov).toHaveProperty('value');
  expect(prov).toHaveProperty('unit');
  expect(prov).toHaveProperty('resolution');
  expect(prov).toHaveProperty('dataset_id');
  expect(prov).toHaveProperty('provider');
  expect(prov).toHaveProperty('variable');
  expect(prov).toHaveProperty('evidence_type');
  expect(prov).toHaveProperty('quality');

  // hypothesis_relationships must be an array.
  expect(Array.isArray(prov.hypothesis_relationships)).toBe(true);
  // The anchor row is referenced by at least one hypothesis.
  expect(prov.hypothesis_relationships.length).toBeGreaterThan(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// F19 — Unknown evidence ID returns found: false (no throw)
// ─────────────────────────────────────────────────────────────────────────────
test('F19: unknown evidence_id returns { found: false } without throwing', () => {
  const UNKNOWN_ID = 'E-G15-9999';
  let result;

  expect(() => {
    result = getEvidenceProvenance(CASE_ID, UNKNOWN_ID, rows, graph);
  }).not.toThrow();

  expect(result.found).toBe(false);
  expect(result.evidence_id).toBe(UNKNOWN_ID);
  expect(typeof result.reason).toBe('string');
  expect(result.reason.length).toBeGreaterThan(0);

  // Must NOT contain evidence row fields (nothing was found).
  expect(result).not.toHaveProperty('timestamp');
  expect(result).not.toHaveProperty('source');
});

// ─────────────────────────────────────────────────────────────────────────────
// F20 — Provenance preserves all original evidence fields verbatim
// Compares every field of the provenance result against the source row.
// ─────────────────────────────────────────────────────────────────────────────
test('F20: provenance result contains all 12 evidence row fields verbatim', () => {
  const prov = getEvidenceProvenance(CASE_ID, anchorId, rows, graph);
  const sourceRow = rows.find((r) => r.evidence_id === anchorId);

  expect(prov.evidence_id).toBe(sourceRow.evidence_id);
  expect(prov.timestamp).toBe(sourceRow.timestamp);
  expect(prov.source).toBe(sourceRow.source);
  expect(prov.measurement).toBe(sourceRow.measurement);
  expect(prov.value).toBe(sourceRow.value);
  expect(prov.unit).toBe(sourceRow.unit);
  expect(prov.resolution).toBe(sourceRow.resolution);
  expect(prov.dataset_id).toBe(sourceRow.dataset_id);
  expect(prov.provider).toBe(sourceRow.provider);
  expect(prov.variable).toBe(sourceRow.variable);
  expect(prov.evidence_type).toBe(sourceRow.evidence_type);
  expect(prov.quality).toBe(sourceRow.quality);
});

// ─────────────────────────────────────────────────────────────────────────────
// F21 — Relationship type and list_name are preserved from the graph
// The CASE anchor is in supporting_evidence for H3 and H5.
// ─────────────────────────────────────────────────────────────────────────────
test('F21: hypothesis_relationships entries preserve list_name, relationship, and interpretation from the graph', () => {
  const prov = getEvidenceProvenance(CASE_ID, anchorId, rows, graph);

  for (const rel of prov.hypothesis_relationships) {
    // Required fields on every relationship entry.
    expect(typeof rel.hypothesis_id).toBe('string');
    expect(rel.hypothesis_id.length).toBeGreaterThan(0);
    expect(typeof rel.list_name).toBe('string');
    expect(['environmental_context', 'supporting_evidence', 'contradicting_evidence',
      'non_discriminating_evidence']).toContain(rel.list_name);
    expect(typeof rel.relationship).toBe('string');
    expect(rel.relationship.length).toBeGreaterThan(0);
    expect(typeof rel.interpretation).toBe('string');
    expect(rel.interpretation.length).toBeGreaterThan(0);

    // Cross-check: find the corresponding EvidenceRef in the graph and verify
    // that relationship and interpretation match exactly.
    const graphH = graph.hypotheses.find((h) => h.hypothesis_id === rel.hypothesis_id);
    expect(graphH).toBeDefined();
    const graphRef = (graphH[rel.list_name] || []).find((r) => r.evidence_id === anchorId);
    expect(graphRef).toBeDefined();
    expect(rel.relationship).toBe(graphRef.relationship);
    expect(rel.interpretation).toBe(graphRef.interpretation);
  }

  // The anchor is referenced by H3 and H5 (in supporting_evidence) and also
  // by H1 and H2 (in non_discriminating_evidence).  Verify H3 and H5 appear.
  const hypothesisIds = prov.hypothesis_relationships.map((r) => r.hypothesis_id);
  expect(hypothesisIds).toContain('H3');
  expect(hypothesisIds).toContain('H5');

  // H3 and H5 relationships must be in supporting_evidence.
  const h3rel = prov.hypothesis_relationships.find((r) => r.hypothesis_id === 'H3');
  const h5rel = prov.hypothesis_relationships.find((r) => r.hypothesis_id === 'H5');
  expect(h3rel).toBeDefined();
  expect(h5rel).toBeDefined();
  expect(h3rel.list_name).toBe('supporting_evidence');
  expect(h5rel.list_name).toBe('supporting_evidence');
});

// ─────────────────────────────────────────────────────────────────────────────
// F22 — EPHEMERIS evidence resolves from the timeline but has no hypothesis
//        relationships (intentionally excluded from all graph lists — T23)
// ─────────────────────────────────────────────────────────────────────────────
test('F22: EPHEMERIS evidence_id resolves with found: true but hypothesis_relationships is empty', () => {
  const prov = getEvidenceProvenance(CASE_ID, ephemerisId, rows, graph);

  expect(prov.found).toBe(true);
  expect(prov.evidence_id).toBe(ephemerisId);
  expect(prov.source).toBe('GOES11_EPHEMERIS');

  // hypothesis_relationships must be empty — EPHEMERIS is not hypothesis-linked.
  expect(Array.isArray(prov.hypothesis_relationships)).toBe(true);
  expect(prov.hypothesis_relationships).toHaveLength(0);

  // The evidence_type field must be the correct classification, not null.
  expect(prov.evidence_type).toBe('environmental_observation');
});

// ─────────────────────────────────────────────────────────────────────────────
// F23 — Provenance does not invent evidence
// Every evidence_id referenced inside hypothesis_relationships must equal the
// queried id — the function must not return relationships for other records.
// ─────────────────────────────────────────────────────────────────────────────
test('F23: every evidence_id in hypothesis_relationships equals the queried evidence_id', () => {
  // Check a windowed EP8 record that IS referenced in a graph hypothesis list.
  const prov = getEvidenceProvenance(CASE_ID, ep8WindowId, rows, graph);

  expect(prov.found).toBe(true);

  // Verify no relationship entry smuggles in a different evidence_id.
  for (const rel of prov.hypothesis_relationships) {
    // The relationship entry does not carry an evidence_id field itself —
    // it describes the relationship between the queried id and a hypothesis.
    // Verify the cross-reference by looking up the graph ref and confirming
    // it points back to ep8WindowId.
    const graphH = graph.hypotheses.find((h) => h.hypothesis_id === rel.hypothesis_id);
    expect(graphH).toBeDefined();
    const matchingRef = (graphH[rel.list_name] || []).find(
      (r) => r.evidence_id === ep8WindowId,
    );
    expect(matchingRef).toBeDefined();
  }

  // The provenance result itself must carry only the queried record's fields.
  expect(prov.evidence_id).toBe(ep8WindowId);
});

// ─────────────────────────────────────────────────────────────────────────────
// F24 — Duplicate (hypothesis_id, list_name) triple throws
//        ForensicAnalysisValidationError
// Uses a hand-crafted fake graph with the same evidence_id appearing twice in
// the same list of the same hypothesis.  Does NOT call buildForensicAnalysis —
// isolated to validator rejection behavior inside getEvidenceProvenance.
// ─────────────────────────────────────────────────────────────────────────────
test('F24: duplicate (hypothesis_id, list_name) reference in graph throws ForensicAnalysisValidationError', () => {
  // Use a real evidence_id from the timeline so the row lookup succeeds.
  const targetId = anchorId;

  // Fake graph: same evidence_id appears twice in supporting_evidence of H3.
  const fakeGraph = {
    case_id:                       CASE_ID,
    causal_attribution_established: false,
    hypotheses: [
      {
        hypothesis_id:           'H3',
        label:                   'fake',
        assessment:              'supported',
        environmental_context:   [],
        supporting_evidence: [
          { evidence_id: targetId, relationship: 'r1', interpretation: 'i1' },
          { evidence_id: targetId, relationship: 'r2', interpretation: 'i2' }, // ← duplicate
        ],
        contradicting_evidence:       [],
        non_discriminating_evidence:  [],
        heuristic_note:  null,
        limitations:     [{ type: 'unresolved', description: 'placeholder' }],
      },
    ],
  };

  expect(() => getEvidenceProvenance(CASE_ID, targetId, rows, fakeGraph))
    .toThrow(ForensicAnalysisValidationError);

  // Verify the violations array is populated with the duplicate description.
  try {
    getEvidenceProvenance(CASE_ID, targetId, rows, fakeGraph);
  } catch (err) {
    expect(err instanceof ForensicAnalysisValidationError).toBe(true);
    expect(Array.isArray(err.violations)).toBe(true);
    expect(err.violations.length).toBeGreaterThan(0);
    expect(err.violations.some((v) => v.includes('Duplicate'))).toBe(true);
  }
});
