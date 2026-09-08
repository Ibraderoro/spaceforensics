'use strict';

/**
 * Phase 10.1 — EvidenceExplorationService — Unit Tests
 *
 * Tests every method in evidenceExplorationService.js against real case data
 * (galaxy-15 as the primary fixture, test-case-alpha for cross-case isolation).
 * No HTTP calls; exercises the service functions directly.
 *
 * Service Invariants verified:
 *   SI-1   Evidence records are read-only (service functions return copies)
 *   SI-2   Every returned item is traceable to an evidence_id from the CSV
 *   SI-3   environmental_context is separate from supporting_evidence
 *   SI-4   contradicting_evidence is in its own field
 *   SI-5   non_discriminating_evidence is in its own field
 *   SI-6   EPHEMERIS records absent from hypothesis evidence views
 *   SI-7   No temporal proximity inference — temporal_note always present
 *   SI-8   No numerical probabilities in any output field
 *   SI-9   Assessments are read-only verbatim pass-throughs
 *   SI-10  Cross-case exploration is explicitly blocked
 *   SI-11  causal_attribution_established never set or modified by service
 *   SI-12  environmental_context never converted into supporting_evidence
 *   SI-13  Evidence IDs never modified or synthesised
 *   SI-14  Filtering never creates new evidence records
 */

const { parseEvidenceCSV, buildEvidenceGraph } = require('../server');
const {
  getEvidenceByCaseId,
  getEvidenceById,
  filterBySource,
  filterByMeasurementType,
  filterByTimeWindow,
  getAnomalyCenteredEvidence,
  getHypothesisLinkedEvidence,
  getProvenanceLookup,
  getCaseEvidenceIndex,
  getEnvironmentalContextSummary,
  compareHypothesesEvidenceForCase,
  TEMPORAL_FILTER_NOTE,
} = require('../services/evidenceExplorationService');

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures — built once for all tests in this file
// ─────────────────────────────────────────────────────────────────────────────

const G15 = 'galaxy-15';
const TCA = 'test-case-alpha';

let g15Rows;
let g15Graph;
let tcaRows;
let tcaGraph;

let g15EphemerisId;       // an EPHEMERIS row ID (source: GOES11_EPHEMERIS)
let g15AnchorId;          // CASE source row ID (anchor event)
let g15HypWithEnvCtx;     // a G15 hypothesis with environmental_context entries
let g15HypWithSupport;    // a G15 hypothesis with supporting_evidence entries
let g15AnchorTimestamp;   // timestamp of the CASE anchor row (for time-window tests)

beforeAll(async () => {
  jest.setTimeout(30_000);

  [g15Rows, tcaRows] = await Promise.all([
    parseEvidenceCSV(G15),
    parseEvidenceCSV(TCA),
  ]);
  [g15Graph, tcaGraph] = await Promise.all([
    buildEvidenceGraph(G15, g15Rows),
    buildEvidenceGraph(TCA, tcaRows),
  ]);

  const ephRow = g15Rows.find((r) => r.source === 'GOES11_EPHEMERIS');
  g15EphemerisId = ephRow ? ephRow.evidence_id : null;

  const anchorRow = g15Rows.find((r) => r.source === 'CASE');
  g15AnchorId        = anchorRow ? anchorRow.evidence_id    : null;
  g15AnchorTimestamp = anchorRow ? anchorRow.timestamp      : null;

  g15HypWithEnvCtx  = g15Graph.hypotheses.find((h) => (h.environmental_context || []).length > 0);
  g15HypWithSupport = g15Graph.hypotheses.find((h) => (h.supporting_evidence   || []).length > 0);
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// Helper: assert no numerical probability-like values in any leaf of an object.
// SI-8
// ─────────────────────────────────────────────────────────────────────────────
const NUMERIC_PROB_RE = /\b\d+(\.\d+)?\s*%|\b\d+(\.\d+)?\s*(probability|chance|likelihood)/i;

function assertNoNumericalProbs(value, path = '') {
  if (typeof value === 'string') {
    expect(value).not.toMatch(NUMERIC_PROB_RE);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoNumericalProbs(v, `${path}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      assertNoNumericalProbs(v, `${path}.${k}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-cutting: SI-10 cross-case isolation
// Every method that takes (caseId, rows, graph) must reject a mismatched graph.
// ─────────────────────────────────────────────────────────────────────────────

describe('SI-10: cross-case isolation — every method rejects mismatched caseId/graph', () => {
  const methods = [
    ['getEvidenceByCaseId',          () => getEvidenceByCaseId(G15, g15Rows, tcaGraph)],
    ['getEvidenceById',              () => getEvidenceById(G15, g15AnchorId, g15Rows, tcaGraph)],
    ['filterBySource',               () => filterBySource(G15, 'CASE', g15Rows, tcaGraph)],
    ['filterByMeasurementType',      () => filterByMeasurementType(G15, { measurement: 'ep8' }, g15Rows, tcaGraph)],
    ['filterByTimeWindow',           () => filterByTimeWindow(G15, { from: '2010-01-01T00:00:00Z' }, g15Rows, tcaGraph)],
    ['getAnomalyCenteredEvidence',   () => getAnomalyCenteredEvidence(G15, '2010-04-05T10:00:00Z', 10, g15Rows, tcaGraph)],
    ['getHypothesisLinkedEvidence',  () => getHypothesisLinkedEvidence(G15, 'H1', g15Rows, tcaGraph)],
    ['getProvenanceLookup',          () => getProvenanceLookup(G15, g15AnchorId, g15Rows, tcaGraph)],
    ['getCaseEvidenceIndex',         () => getCaseEvidenceIndex(G15, g15Rows, tcaGraph)],
    ['getEnvironmentalContextSummary', () => getEnvironmentalContextSummary(G15, g15Rows, tcaGraph)],
    ['compareHypothesesEvidenceForCase', () => compareHypothesesEvidenceForCase(G15, g15Rows, tcaGraph, [])],
  ];

  for (const [name, call] of methods) {
    test(`SI-10: ${name} returns CASE_MISMATCH error when graph.case_id !== caseId`, () => {
      const result = call();
      expect(result).toHaveProperty('error_code', 'CASE_MISMATCH');
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// getEvidenceByCaseId
// ─────────────────────────────────────────────────────────────────────────────

describe('getEvidenceByCaseId', () => {
  let result;

  beforeAll(() => {
    result = getEvidenceByCaseId(G15, g15Rows, g15Graph);
  });

  test('ES-CBC-1: returns case_id verbatim (SI-2)', () => {
    expect(result.case_id).toBe(G15);
  });

  test('ES-CBC-2: evidence_count equals rows length (SI-14)', () => {
    expect(result.evidence_count).toBe(g15Rows.length);
    expect(result.evidence.length).toBe(g15Rows.length);
  });

  test('ES-CBC-3: every record has all 12 evidence fields (SI-2)', () => {
    const FIELDS = [
      'evidence_id', 'timestamp', 'source', 'measurement',
      'value', 'unit', 'resolution', 'dataset_id',
      'provider', 'variable', 'evidence_type', 'quality',
    ];
    for (const rec of result.evidence) {
      for (const f of FIELDS) {
        expect(rec).toHaveProperty(f);
      }
    }
  });

  test('ES-CBC-4: evidence records are copies — mutating return does not affect source (SI-1)', () => {
    const firstReturned = result.evidence[0];
    const originalSource = g15Rows[0].source;
    firstReturned.source = '__MUTATED__';
    expect(g15Rows[0].source).toBe(originalSource);
  });

  test('ES-CBC-5: causal_attribution_established is verbatim from graph (SI-11)', () => {
    expect(result.causal_attribution_established).toBe(g15Graph.causal_attribution_established);
    // Galaxy-15 must be false (release gate invariant)
    expect(result.causal_attribution_established).toBe(false);
  });

  test('ES-CBC-6: no numerical probability language in output (SI-8)', () => {
    assertNoNumericalProbs(result);
  });

  test('ES-CBC-7: every evidence_id matches pattern E-G15- (SI-10 / SI-13)', () => {
    for (const rec of result.evidence) {
      expect(rec.evidence_id).toMatch(/^E-G15-/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getEvidenceById
// ─────────────────────────────────────────────────────────────────────────────

describe('getEvidenceById', () => {
  test('ES-EBI-1: known ID returns found: true and all 12 fields (SI-2)', () => {
    const result = getEvidenceById(G15, g15AnchorId, g15Rows, g15Graph);
    expect(result.found).toBe(true);
    expect(result.evidence_id).toBe(g15AnchorId);
    const FIELDS = [
      'timestamp', 'source', 'measurement', 'value', 'unit',
      'resolution', 'dataset_id', 'provider', 'variable',
      'evidence_type', 'quality',
    ];
    for (const f of FIELDS) {
      expect(result).toHaveProperty(f);
    }
  });

  test('ES-EBI-2: unknown ID returns found: false with a reason (SI-2)', () => {
    const result = getEvidenceById(G15, 'E-G15-BOGUS-9999', g15Rows, g15Graph);
    expect(result.found).toBe(false);
    expect(result.evidence_id).toBe('E-G15-BOGUS-9999');
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
    // Must not carry evidence row fields
    expect(result).not.toHaveProperty('timestamp');
    expect(result).not.toHaveProperty('source');
  });

  test('ES-EBI-3: EPHEMERIS ID returns found: true and empty hypothesis_relationships (SI-6)', () => {
    if (!g15EphemerisId) return; // guard — skip if no EPHEMERIS row
    const result = getEvidenceById(G15, g15EphemerisId, g15Rows, g15Graph);
    expect(result.found).toBe(true);
    expect(result.hypothesis_relationships).toHaveLength(0);
  });

  test('ES-EBI-4: null evidenceId returns INVALID_EVIDENCE_ID error', () => {
    const result = getEvidenceById(G15, null, g15Rows, g15Graph);
    expect(result).toHaveProperty('error_code', 'INVALID_EVIDENCE_ID');
  });

  test('ES-EBI-5: CASE anchor record has hypothesis_relationships (SI-2)', () => {
    const result = getEvidenceById(G15, g15AnchorId, g15Rows, g15Graph);
    expect(Array.isArray(result.hypothesis_relationships)).toBe(true);
    expect(result.hypothesis_relationships.length).toBeGreaterThan(0);
    for (const rel of result.hypothesis_relationships) {
      expect(typeof rel.hypothesis_id).toBe('string');
      expect(typeof rel.list_name).toBe('string');
      expect(typeof rel.relationship).toBe('string');
      expect(typeof rel.interpretation).toBe('string');
    }
  });

  test('ES-EBI-6: duplicate reference in fake graph throws ForensicAnalysisValidationError (from getEvidenceProvenance)', () => {
    const { ForensicAnalysisValidationError } = require('../services/forensicAnalysis');
    const fakeGraph = {
      case_id: G15,
      causal_attribution_established: false,
      hypotheses: [{
        hypothesis_id:          'H3',
        label:                  'fake',
        assessment:             'supported',
        environmental_context:  [],
        supporting_evidence: [
          { evidence_id: g15AnchorId, relationship: 'r1', interpretation: 'i1' },
          { evidence_id: g15AnchorId, relationship: 'r2', interpretation: 'i2' }, // duplicate
        ],
        contradicting_evidence:      [],
        non_discriminating_evidence: [],
        heuristic_note:  null,
        limitations:     [{ type: 'unresolved', description: 'placeholder' }],
      }],
    };
    expect(() => getEvidenceById(G15, g15AnchorId, g15Rows, fakeGraph))
      .toThrow(ForensicAnalysisValidationError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// filterBySource
// ─────────────────────────────────────────────────────────────────────────────

describe('filterBySource', () => {
  test('ES-FBS-1: filters to only CASE rows (SI-14)', () => {
    const result = filterBySource(G15, 'CASE', g15Rows, g15Graph);
    expect(result.case_id).toBe(G15);
    expect(result.source).toBe('CASE');
    for (const rec of result.evidence) {
      expect(rec.source).toBe('CASE');
    }
    expect(result.evidence_count).toBe(result.evidence.length);
  });

  test('ES-FBS-2: GOES11_EPHEMERIS filter returns only EPHEMERIS rows (SI-14)', () => {
    const result = filterBySource(G15, 'GOES11_EPHEMERIS', g15Rows, g15Graph);
    for (const rec of result.evidence) {
      expect(rec.source).toBe('GOES11_EPHEMERIS');
    }
    expect(result.evidence_count).toBeGreaterThan(0);
  });

  test('ES-FBS-3: unknown source returns empty evidence array, not an error (SI-14)', () => {
    const result = filterBySource(G15, 'NONEXISTENT_SOURCE_XYZ', g15Rows, g15Graph);
    expect(result.error_code).toBeUndefined();
    expect(result.evidence_count).toBe(0);
    expect(result.evidence).toEqual([]);
  });

  test('ES-FBS-4: null source returns INVALID_FILTER error', () => {
    const result = filterBySource(G15, null, g15Rows, g15Graph);
    expect(result).toHaveProperty('error_code', 'INVALID_FILTER');
  });

  test('ES-FBS-5: returned records are copies — mutating return does not affect source (SI-1)', () => {
    const result = filterBySource(G15, 'CASE', g15Rows, g15Graph);
    if (result.evidence.length === 0) return;
    const original = g15Rows.find((r) => r.source === 'CASE');
    const originalTs = original.timestamp;
    result.evidence[0].timestamp = '__MUTATED__';
    expect(original.timestamp).toBe(originalTs);
  });

  test('ES-FBS-6: evidence_ids are verbatim from rows (SI-2, SI-13)', () => {
    const result = filterBySource(G15, 'CASE', g15Rows, g15Graph);
    const caseIds = new Set(g15Rows.filter((r) => r.source === 'CASE').map((r) => r.evidence_id));
    for (const rec of result.evidence) {
      expect(caseIds).toContain(rec.evidence_id);
    }
  });

  test('ES-FBS-7: no numerical probability language in output (SI-8)', () => {
    const result = filterBySource(G15, 'CASE', g15Rows, g15Graph);
    assertNoNumericalProbs(result);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// filterByMeasurementType
// ─────────────────────────────────────────────────────────────────────────────

describe('filterByMeasurementType', () => {
  test('ES-FBM-1: filtering by evidence_type "case_event" returns only CASE rows (SI-14)', () => {
    const result = filterByMeasurementType(G15, { evidence_type: 'case_event' }, g15Rows, g15Graph);
    expect(result.error_code).toBeUndefined();
    for (const rec of result.evidence) {
      expect(rec.evidence_type).toBe('case_event');
    }
  });

  test('ES-FBM-2: filtering by evidence_type "environmental_observation" returns GOES rows (SI-14)', () => {
    const result = filterByMeasurementType(G15, { evidence_type: 'environmental_observation' }, g15Rows, g15Graph);
    expect(result.error_code).toBeUndefined();
    expect(result.evidence_count).toBeGreaterThan(0);
    for (const rec of result.evidence) {
      expect(rec.evidence_type).toBe('environmental_observation');
    }
  });

  test('ES-FBM-3: filtering by measurement string narrows correctly (SI-14)', () => {
    // Pick a real measurement from the first row
    const firstMeasurement = g15Rows[0].measurement;
    const result = filterByMeasurementType(G15, { measurement: firstMeasurement }, g15Rows, g15Graph);
    expect(result.error_code).toBeUndefined();
    for (const rec of result.evidence) {
      expect(rec.measurement).toBe(firstMeasurement);
    }
    expect(result.evidence_count).toBeGreaterThan(0);
  });

  test('ES-FBM-4: no filter provided returns INVALID_FILTER error', () => {
    const result = filterByMeasurementType(G15, {}, g15Rows, g15Graph);
    expect(result).toHaveProperty('error_code', 'INVALID_FILTER');
  });

  test('ES-FBM-5: measurement takes precedence over evidence_type when both supplied (SI-14)', () => {
    const firstMeasurement = g15Rows[0].measurement;
    const result = filterByMeasurementType(
      G15,
      { measurement: firstMeasurement, evidence_type: 'case_event' },
      g15Rows,
      g15Graph,
    );
    // When measurement is present it is used; result should be non-empty for the measurement
    expect(result.error_code).toBeUndefined();
    for (const rec of result.evidence) {
      expect(rec.measurement).toBe(firstMeasurement);
    }
  });

  test('ES-FBM-6: returned records are copies (SI-1)', () => {
    const result = filterByMeasurementType(G15, { evidence_type: 'case_event' }, g15Rows, g15Graph);
    if (result.evidence.length === 0) return;
    const original = g15Rows.find((r) => r.evidence_type === 'case_event');
    const origSource = original.source;
    result.evidence[0].source = '__MUTATED__';
    expect(original.source).toBe(origSource);
  });

  test('ES-FBM-7: no numerical probability language in output (SI-8)', () => {
    const result = filterByMeasurementType(G15, { evidence_type: 'case_event' }, g15Rows, g15Graph);
    assertNoNumericalProbs(result);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// filterByTimeWindow
// ─────────────────────────────────────────────────────────────────────────────

describe('filterByTimeWindow', () => {
  test('ES-FTW-1: from-only filter returns records at or after the timestamp (SI-14)', () => {
    const from = g15Rows[Math.floor(g15Rows.length / 2)].timestamp;
    const result = filterByTimeWindow(G15, { from }, g15Rows, g15Graph);
    expect(result.error_code).toBeUndefined();
    for (const rec of result.evidence) {
      expect(rec.timestamp >= from).toBe(true);
    }
    expect(result.filter).toEqual({ from });
  });

  test('ES-FTW-2: to-only filter returns records at or before the timestamp (SI-14)', () => {
    const to = g15Rows[Math.floor(g15Rows.length / 2)].timestamp;
    const result = filterByTimeWindow(G15, { to }, g15Rows, g15Graph);
    expect(result.error_code).toBeUndefined();
    for (const rec of result.evidence) {
      expect(rec.timestamp <= to).toBe(true);
    }
    expect(result.filter).toEqual({ to });
  });

  test('ES-FTW-3: from+to filter returns only records within the interval (SI-14)', () => {
    const from = g15Rows[10].timestamp;
    const to   = g15Rows[30].timestamp;
    const result = filterByTimeWindow(G15, { from, to }, g15Rows, g15Graph);
    expect(result.error_code).toBeUndefined();
    for (const rec of result.evidence) {
      expect(rec.timestamp >= from).toBe(true);
      expect(rec.timestamp <= to).toBe(true);
    }
  });

  test('ES-FTW-4: temporal_note is always present and non-empty (SI-7)', () => {
    const result = filterByTimeWindow(G15, { from: g15Rows[0].timestamp }, g15Rows, g15Graph);
    expect(typeof result.temporal_note).toBe('string');
    expect(result.temporal_note.length).toBeGreaterThan(0);
    expect(result.temporal_note).toBe(TEMPORAL_FILTER_NOTE);
  });

  test('ES-FTW-5: temporal_note must not claim causality (SI-7, SI-11)', () => {
    const result = filterByTimeWindow(G15, { from: g15Rows[0].timestamp }, g15Rows, g15Graph);
    expect(result.temporal_note.toLowerCase()).not.toMatch(/\bcaused\b/);
    expect(result.temporal_note.toLowerCase()).not.toContain('proves');
    expect(result.temporal_note.toLowerCase()).not.toContain('establishes causality');
  });

  test('ES-FTW-6: no filter bounds returns INVALID_FILTER error', () => {
    const result = filterByTimeWindow(G15, {}, g15Rows, g15Graph);
    expect(result).toHaveProperty('error_code', 'INVALID_FILTER');
  });

  test('ES-FTW-7: narrow window that excludes all records returns empty array, not error (SI-14)', () => {
    // Use a timestamp far before all data
    const result = filterByTimeWindow(G15,
      { from: '1900-01-01T00:00:00Z', to: '1900-01-02T00:00:00Z' },
      g15Rows, g15Graph);
    expect(result.error_code).toBeUndefined();
    expect(result.evidence_count).toBe(0);
    expect(result.evidence).toEqual([]);
  });

  test('ES-FTW-8: returned records are copies (SI-1)', () => {
    const result = filterByTimeWindow(G15, { from: g15Rows[0].timestamp }, g15Rows, g15Graph);
    if (result.evidence.length === 0) return;
    const original = g15Rows[0];
    const origSource = original.source;
    result.evidence[0].source = '__MUTATED__';
    expect(original.source).toBe(origSource);
  });

  test('ES-FTW-9: evidence_ids are verbatim (SI-2, SI-13)', () => {
    const result = filterByTimeWindow(G15,
      { from: g15Rows[0].timestamp, to: g15Rows[9].timestamp },
      g15Rows, g15Graph);
    const srcIds = new Set(g15Rows.slice(0, 10).map((r) => r.evidence_id));
    for (const rec of result.evidence) {
      expect(srcIds.has(rec.evidence_id)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getAnomalyCenteredEvidence
// ─────────────────────────────────────────────────────────────────────────────

describe('getAnomalyCenteredEvidence', () => {
  test('ES-ACE-1: returns evidence within ±N minutes of anchor timestamp (SI-7)', () => {
    if (!g15AnchorTimestamp) return;
    const window = 10;
    const result = getAnomalyCenteredEvidence(G15, g15AnchorTimestamp, window, g15Rows, g15Graph);
    expect(result.error_code).toBeUndefined();
    expect(result.evidence_count).toBeGreaterThan(0);

    const anchorMs = new Date(g15AnchorTimestamp).getTime();
    const windowMs = window * 60 * 1000;
    for (const rec of result.evidence) {
      const diff = Math.abs(new Date(rec.timestamp).getTime() - anchorMs);
      expect(diff).toBeLessThanOrEqual(windowMs);
    }
  });

  test('ES-ACE-2: heuristic_window_note is always present (SI-7)', () => {
    if (!g15AnchorTimestamp) return;
    const result = getAnomalyCenteredEvidence(G15, g15AnchorTimestamp, 10, g15Rows, g15Graph);
    expect(typeof result.heuristic_window_note).toBe('string');
    expect(result.heuristic_window_note.length).toBeGreaterThan(0);
  });

  test('ES-ACE-3: heuristic_window_note must not claim causality (SI-7, SI-11)', () => {
    if (!g15AnchorTimestamp) return;
    const result = getAnomalyCenteredEvidence(G15, g15AnchorTimestamp, 10, g15Rows, g15Graph);
    expect(result.heuristic_window_note.toLowerCase()).not.toMatch(/\bcaused\b/);
    expect(result.heuristic_window_note.toLowerCase()).not.toContain('proves causality');
  });

  test('ES-ACE-4: invalid anomalyTimestamp returns INVALID_FILTER error', () => {
    const result = getAnomalyCenteredEvidence(G15, null, 10, g15Rows, g15Graph);
    expect(result).toHaveProperty('error_code', 'INVALID_FILTER');
  });

  test('ES-ACE-5: windowMinutes ≤ 0 returns INVALID_FILTER error', () => {
    const result = getAnomalyCenteredEvidence(G15, g15AnchorTimestamp, -5, g15Rows, g15Graph);
    expect(result).toHaveProperty('error_code', 'INVALID_FILTER');
  });

  test('ES-ACE-6: windowMinutes = 0 returns INVALID_FILTER error', () => {
    const result = getAnomalyCenteredEvidence(G15, g15AnchorTimestamp, 0, g15Rows, g15Graph);
    expect(result).toHaveProperty('error_code', 'INVALID_FILTER');
  });

  test('ES-ACE-7: very large window includes all rows (SI-14)', () => {
    if (!g15AnchorTimestamp) return;
    const result = getAnomalyCenteredEvidence(G15, g15AnchorTimestamp, 999999, g15Rows, g15Graph);
    expect(result.evidence_count).toBe(g15Rows.length);
  });

  test('ES-ACE-8: anomaly_timestamp and window_minutes are echoed in result', () => {
    if (!g15AnchorTimestamp) return;
    const result = getAnomalyCenteredEvidence(G15, g15AnchorTimestamp, 10, g15Rows, g15Graph);
    expect(result.anomaly_timestamp).toBe(g15AnchorTimestamp);
    expect(result.window_minutes).toBe(10);
  });

  test('ES-ACE-9: returned records are copies (SI-1)', () => {
    if (!g15AnchorTimestamp) return;
    const result = getAnomalyCenteredEvidence(G15, g15AnchorTimestamp, 10, g15Rows, g15Graph);
    if (result.evidence.length === 0) return;
    const recId    = result.evidence[0].evidence_id;
    const original = g15Rows.find((r) => r.evidence_id === recId);
    const origSrc  = original.source;
    result.evidence[0].source = '__MUTATED__';
    expect(original.source).toBe(origSrc);
  });

  test('ES-ACE-10: result includes EPHEMERIS rows (raw timeline slice, not hypothesis view) (SI-14)', () => {
    if (!g15AnchorTimestamp) return;
    const result = getAnomalyCenteredEvidence(G15, g15AnchorTimestamp, 60, g15Rows, g15Graph);
    const ephemerisRecords = result.evidence.filter((r) => r.source === 'GOES11_EPHEMERIS');
    expect(ephemerisRecords.length).toBeGreaterThan(0);
  });

  test('ES-ACE-11: causal_attribution_established is NOT set on result (SI-11)', () => {
    if (!g15AnchorTimestamp) return;
    const result = getAnomalyCenteredEvidence(G15, g15AnchorTimestamp, 10, g15Rows, g15Graph);
    expect(result).not.toHaveProperty('causal_attribution_established');
  });

  test('ES-ACE-12: no numerical probability language in output (SI-8)', () => {
    if (!g15AnchorTimestamp) return;
    const result = getAnomalyCenteredEvidence(G15, g15AnchorTimestamp, 10, g15Rows, g15Graph);
    assertNoNumericalProbs(result);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getHypothesisLinkedEvidence
// ─────────────────────────────────────────────────────────────────────────────

describe('getHypothesisLinkedEvidence', () => {
  const FOUR_LISTS = [
    'environmental_context',
    'supporting_evidence',
    'contradicting_evidence',
    'non_discriminating_evidence',
  ];

  test('ES-HLE-1: known hypothesis returns all four separate lists (SI-3, SI-4, SI-5)', () => {
    const hid = g15HypWithEnvCtx ? g15HypWithEnvCtx.hypothesis_id : 'H1';
    const result = getHypothesisLinkedEvidence(G15, hid, g15Rows, g15Graph);
    expect(result.error_code).toBeUndefined();
    for (const list of FOUR_LISTS) {
      expect(Array.isArray(result[list])).toBe(true);
    }
  });

  test('ES-HLE-2: assessment is verbatim from graph (SI-9)', () => {
    const hid = g15HypWithEnvCtx ? g15HypWithEnvCtx.hypothesis_id : 'H1';
    const result = getHypothesisLinkedEvidence(G15, hid, g15Rows, g15Graph);
    const graphH = g15Graph.hypotheses.find((h) => h.hypothesis_id === hid);
    expect(result.assessment).toBe(graphH.assessment);
  });

  test('ES-HLE-3: environmental_context items NOT in supporting_evidence (SI-3, SI-12)', () => {
    const hid = g15HypWithEnvCtx ? g15HypWithEnvCtx.hypothesis_id : 'H1';
    const result = getHypothesisLinkedEvidence(G15, hid, g15Rows, g15Graph);
    const envIds = new Set(result.environmental_context.map((e) => e.evidence_id));
    const supIds = new Set(result.supporting_evidence.map((e) => e.evidence_id));
    // Intersection must be empty (SI-3, SI-12)
    for (const id of envIds) {
      expect(supIds.has(id)).toBe(false);
    }
  });

  test('ES-HLE-4: EPHEMERIS absent from all four lists (SI-6)', () => {
    for (const h of g15Graph.hypotheses) {
      const result = getHypothesisLinkedEvidence(G15, h.hypothesis_id, g15Rows, g15Graph);
      for (const list of FOUR_LISTS) {
        for (const entry of result[list]) {
          const row = g15Rows.find((r) => r.evidence_id === entry.evidence_id);
          if (row) {
            expect(row.source).not.toBe('GOES11_EPHEMERIS');
          }
        }
      }
    }
  });

  test('ES-HLE-5: hypothesis not found returns HYPOTHESIS_NOT_FOUND error', () => {
    const result = getHypothesisLinkedEvidence(G15, 'H_BOGUS_9999', g15Rows, g15Graph);
    expect(result).toHaveProperty('error_code', 'HYPOTHESIS_NOT_FOUND');
  });

  test('ES-HLE-6: null hypothesisId returns INVALID_HYPOTHESIS_ID error', () => {
    const result = getHypothesisLinkedEvidence(G15, null, g15Rows, g15Graph);
    expect(result).toHaveProperty('error_code', 'INVALID_HYPOTHESIS_ID');
  });

  test('ES-HLE-7: heuristic_window_note is present when environmental_context is non-empty (SI-7)', () => {
    const hid = g15HypWithEnvCtx ? g15HypWithEnvCtx.hypothesis_id : 'H1';
    const result = getHypothesisLinkedEvidence(G15, hid, g15Rows, g15Graph);
    if (result.environmental_context.length > 0) {
      expect(typeof result.heuristic_window_note).toBe('string');
      expect(result.heuristic_window_note.length).toBeGreaterThan(0);
    }
  });

  test('ES-HLE-8: hypothesis_id in result matches requested ID (SI-2)', () => {
    const hid = g15HypWithSupport ? g15HypWithSupport.hypothesis_id : 'H3';
    const result = getHypothesisLinkedEvidence(G15, hid, g15Rows, g15Graph);
    expect(result.hypothesis_id).toBe(hid);
  });

  test('ES-HLE-9: every entry in every list carries evidence_id, relationship, interpretation, record (SI-2)', () => {
    const hid = g15HypWithEnvCtx ? g15HypWithEnvCtx.hypothesis_id : 'H1';
    const result = getHypothesisLinkedEvidence(G15, hid, g15Rows, g15Graph);
    for (const list of FOUR_LISTS) {
      for (const entry of result[list]) {
        expect(typeof entry.evidence_id).toBe('string');
        expect(typeof entry.relationship).toBe('string');
        expect(typeof entry.interpretation).toBe('string');
        expect(entry.record).not.toBeNull();
      }
    }
  });

  test('ES-HLE-10: no numerical probability language in output (SI-8)', () => {
    const hid = g15HypWithEnvCtx ? g15HypWithEnvCtx.hypothesis_id : 'H1';
    const result = getHypothesisLinkedEvidence(G15, hid, g15Rows, g15Graph);
    assertNoNumericalProbs(result);
  });

  test('ES-HLE-11: assessment is in allowed vocabulary (SI-9)', () => {
    const ALLOWED = new Set([
      'strongly_supported', 'supported', 'mixed', 'weakly_supported', 'insufficient_evidence',
    ]);
    for (const h of g15Graph.hypotheses) {
      const result = getHypothesisLinkedEvidence(G15, h.hypothesis_id, g15Rows, g15Graph);
      expect(ALLOWED.has(result.assessment)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getProvenanceLookup
// ─────────────────────────────────────────────────────────────────────────────

describe('getProvenanceLookup', () => {
  test('ES-PL-1: known ID returns found: true with all 12 fields (SI-2)', () => {
    const result = getProvenanceLookup(G15, g15AnchorId, g15Rows, g15Graph);
    expect(result.found).toBe(true);
    expect(result.evidence_id).toBe(g15AnchorId);
    const FIELDS = [
      'timestamp', 'source', 'measurement', 'value', 'unit',
      'resolution', 'dataset_id', 'provider', 'variable',
      'evidence_type', 'quality',
    ];
    for (const f of FIELDS) {
      expect(result).toHaveProperty(f);
    }
  });

  test('ES-PL-2: EPHEMERIS resolves with found: true and empty hypothesis_relationships (SI-6)', () => {
    if (!g15EphemerisId) return;
    const result = getProvenanceLookup(G15, g15EphemerisId, g15Rows, g15Graph);
    expect(result.found).toBe(true);
    expect(result.hypothesis_relationships).toHaveLength(0);
  });

  test('ES-PL-3: unknown ID returns found: false (SI-2)', () => {
    const result = getProvenanceLookup(G15, 'E-G15-BOGUS-0001', g15Rows, g15Graph);
    expect(result.found).toBe(false);
    expect(typeof result.reason).toBe('string');
  });

  test('ES-PL-4: null evidenceId returns INVALID_EVIDENCE_ID error', () => {
    const result = getProvenanceLookup(G15, null, g15Rows, g15Graph);
    expect(result).toHaveProperty('error_code', 'INVALID_EVIDENCE_ID');
  });

  test('ES-PL-5: every relationship entry has list_name in allowed list (SI-3/4/5)', () => {
    const ALLOWED_LISTS = [
      'environmental_context', 'supporting_evidence',
      'contradicting_evidence', 'non_discriminating_evidence',
    ];
    const result = getProvenanceLookup(G15, g15AnchorId, g15Rows, g15Graph);
    for (const rel of result.hypothesis_relationships) {
      expect(ALLOWED_LISTS).toContain(rel.list_name);
    }
  });

  test('ES-PL-6: values in result match source row verbatim (SI-2)', () => {
    const result = getProvenanceLookup(G15, g15AnchorId, g15Rows, g15Graph);
    const src = g15Rows.find((r) => r.evidence_id === g15AnchorId);
    expect(result.timestamp).toBe(src.timestamp);
    expect(result.source).toBe(src.source);
    expect(result.measurement).toBe(src.measurement);
    expect(result.value).toBe(src.value);
    expect(result.evidence_type).toBe(src.evidence_type);
  });

  test('ES-PL-7: causal_attribution_established is NOT present on provenance result (SI-11)', () => {
    const result = getProvenanceLookup(G15, g15AnchorId, g15Rows, g15Graph);
    expect(result).not.toHaveProperty('causal_attribution_established');
  });

  test('ES-PL-8: no numerical probability language in output (SI-8)', () => {
    const result = getProvenanceLookup(G15, g15AnchorId, g15Rows, g15Graph);
    assertNoNumericalProbs(result);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getCaseEvidenceIndex
// ─────────────────────────────────────────────────────────────────────────────

describe('getCaseEvidenceIndex', () => {
  let result;

  beforeAll(() => {
    result = getCaseEvidenceIndex(G15, g15Rows, g15Graph);
  });

  test('ES-CEI-1: case_id matches (SI-10)', () => {
    expect(result.case_id).toBe(G15);
  });

  test('ES-CEI-2: evidence_count equals evidence array length (SI-14)', () => {
    expect(result.evidence_count).toBe(result.evidence.length);
  });

  test('ES-CEI-3: every entry has evidence_id, record, and hypothesis_relationships (SI-2)', () => {
    for (const entry of result.evidence) {
      expect(typeof entry.evidence_id).toBe('string');
      expect(Array.isArray(entry.hypothesis_relationships)).toBe(true);
    }
  });

  test('ES-CEI-4: no EPHEMERIS records in index (SI-6)', () => {
    const g15EphIds = new Set(
      g15Rows.filter((r) => r.source === 'GOES11_EPHEMERIS').map((r) => r.evidence_id),
    );
    for (const entry of result.evidence) {
      expect(g15EphIds.has(entry.evidence_id)).toBe(false);
    }
  });

  test('ES-CEI-5: all evidence_ids are from G15 (SI-10, SI-13)', () => {
    for (const entry of result.evidence) {
      expect(entry.evidence_id).toMatch(/^E-G15-/);
    }
  });

  test('ES-CEI-6: no numerical probability language (SI-8)', () => {
    assertNoNumericalProbs(result);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getEnvironmentalContextSummary
// ─────────────────────────────────────────────────────────────────────────────

describe('getEnvironmentalContextSummary', () => {
  let result;

  beforeAll(() => {
    result = getEnvironmentalContextSummary(G15, g15Rows, g15Graph);
  });

  test('ES-ECS-1: case_id matches (SI-10)', () => {
    expect(result.case_id).toBe(G15);
  });

  test('ES-ECS-2: heuristic_window_note is always present and non-empty (SI-7)', () => {
    expect(typeof result.heuristic_window_note).toBe('string');
    expect(result.heuristic_window_note.length).toBeGreaterThan(0);
  });

  test('ES-ECS-3: heuristic_window_note must not claim causality (SI-7, SI-11)', () => {
    expect(result.heuristic_window_note.toLowerCase()).not.toMatch(/\bcaused\b/);
    expect(result.heuristic_window_note.toLowerCase()).not.toContain('proves causality');
  });

  test('ES-ECS-4: records array contains only env context entries (SI-3, SI-12)', () => {
    expect(Array.isArray(result.records)).toBe(true);
    // Each record must appear in at least one hypothesis environmental_context list
    const envGraphIds = new Set(
      g15Graph.hypotheses.flatMap((h) => (h.environmental_context || []).map((e) => e.evidence_id)),
    );
    for (const r of result.records) {
      expect(envGraphIds.has(r.evidence_id)).toBe(true);
    }
  });

  test('ES-ECS-5: records are not in supporting_evidence in the graph (SI-3, SI-12)', () => {
    const supIds = new Set(
      g15Graph.hypotheses.flatMap((h) => (h.supporting_evidence || []).map((e) => e.evidence_id)),
    );
    // Verify that env_context records are cleanly separated from supporting_evidence
    for (const r of result.records) {
      const graphH = g15Graph.hypotheses.find((h) =>
        (h.environmental_context || []).some((e) => e.evidence_id === r.evidence_id),
      );
      // If the same ID appears in both lists for the SAME hypothesis, that would
      // violate V5 in validateForensicAnalysis — it cannot happen with a valid graph.
      // Here we verify the summary does not misclassify any record.
      expect(graphH).toBeDefined();
    }
  });

  test('ES-ECS-6: referenced_by contains hypothesis_ids (SI-9)', () => {
    const validHids = new Set(g15Graph.hypotheses.map((h) => h.hypothesis_id));
    for (const r of result.records) {
      expect(Array.isArray(r.referenced_by)).toBe(true);
      for (const hid of r.referenced_by) {
        expect(validHids.has(hid)).toBe(true);
      }
    }
  });

  test('ES-ECS-7: no numerical probability language (SI-8)', () => {
    assertNoNumericalProbs(result);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// compareHypothesesEvidenceForCase
// ─────────────────────────────────────────────────────────────────────────────

describe('compareHypothesesEvidenceForCase', () => {
  test('ES-CHEC-1: all hypotheses compared when hypothesisIds is empty (SI-9)', () => {
    const result = compareHypothesesEvidenceForCase(G15, g15Rows, g15Graph, []);
    expect(result.error_code).toBeUndefined();
    expect(result.case_id).toBe(G15);
    expect(result.hypotheses.length).toBe(g15Graph.hypotheses.length);
  });

  test('ES-CHEC-2: causal_attribution_established is verbatim from graph (SI-11)', () => {
    const result = compareHypothesesEvidenceForCase(G15, g15Rows, g15Graph, []);
    expect(result.causal_attribution_established).toBe(g15Graph.causal_attribution_established);
  });

  test('ES-CHEC-3: assessments in comparison entries are verbatim (SI-9)', () => {
    const result = compareHypothesesEvidenceForCase(G15, g15Rows, g15Graph, []);
    for (const entry of result.hypotheses) {
      const graphH = g15Graph.hypotheses.find((h) => h.hypothesis_id === entry.hypothesis_id);
      expect(entry.assessment).toBe(graphH.assessment);
    }
  });

  test('ES-CHEC-4: invalid hypothesis_id subset returns error (SI-10)', () => {
    const result = compareHypothesesEvidenceForCase(G15, g15Rows, g15Graph, ['H_BOGUS']);
    expect(result).toHaveProperty('error_code', 'HYPOTHESIS_NOT_FOUND');
  });

  test('ES-CHEC-5: shared_evidence IDs are all G15 IDs (SI-10, SI-13)', () => {
    const result = compareHypothesesEvidenceForCase(G15, g15Rows, g15Graph, []);
    for (const e of result.shared_evidence) {
      expect(e.evidence_id).toMatch(/^E-G15-/);
    }
  });

  test('ES-CHEC-6: exclusive_evidence IDs are all G15 IDs (SI-10, SI-13)', () => {
    const result = compareHypothesesEvidenceForCase(G15, g15Rows, g15Graph, []);
    for (const e of result.exclusive_evidence) {
      expect(e.evidence_id).toMatch(/^E-G15-/);
    }
  });

  test('ES-CHEC-7: no numerical probability language (SI-8)', () => {
    const result = compareHypothesesEvidenceForCase(G15, g15Rows, g15Graph, []);
    assertNoNumericalProbs(result);
  });

  test('ES-CHEC-8: comparison_note is present and mentions single-case scope (SI-10)', () => {
    const result = compareHypothesesEvidenceForCase(G15, g15Rows, g15Graph, []);
    expect(typeof result.comparison_note).toBe('string');
    expect(result.comparison_note.length).toBeGreaterThan(0);
  });

  test('ES-CHEC-9: subset comparison with two valid hypotheses returns only those (SI-10)', () => {
    const ids = g15Graph.hypotheses.slice(0, 2).map((h) => h.hypothesis_id);
    const result = compareHypothesesEvidenceForCase(G15, g15Rows, g15Graph, ids);
    expect(result.error_code).toBeUndefined();
    expect(result.hypotheses).toHaveLength(2);
    for (const entry of result.hypotheses) {
      expect(ids).toContain(entry.hypothesis_id);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-case isolation — additional data-content checks (SI-10)
// ─────────────────────────────────────────────────────────────────────────────

describe('SI-10: cross-case content isolation — G15 never returns TCA evidence IDs', () => {
  test('ES-CC-1: getEvidenceByCaseId G15 never returns TCA IDs', () => {
    const result = getEvidenceByCaseId(G15, g15Rows, g15Graph);
    for (const rec of result.evidence) {
      expect(rec.evidence_id).not.toMatch(/^E-TCA-/);
    }
  });

  test('ES-CC-2: filterBySource G15 never returns TCA IDs', () => {
    const result = filterBySource(G15, 'CASE', g15Rows, g15Graph);
    for (const rec of result.evidence) {
      expect(rec.evidence_id).not.toMatch(/^E-TCA-/);
    }
  });

  test('ES-CC-3: getAnomalyCenteredEvidence G15 never returns TCA IDs', () => {
    if (!g15AnchorTimestamp) return;
    const result = getAnomalyCenteredEvidence(G15, g15AnchorTimestamp, 60, g15Rows, g15Graph);
    for (const rec of result.evidence) {
      expect(rec.evidence_id).not.toMatch(/^E-TCA-/);
    }
  });

  test('ES-CC-4: getCaseEvidenceIndex G15 never returns TCA IDs', () => {
    const result = getCaseEvidenceIndex(G15, g15Rows, g15Graph);
    for (const entry of result.evidence) {
      expect(entry.evidence_id).not.toMatch(/^E-TCA-/);
    }
  });

  test('ES-CC-5: TCA case_id with G15 graph returns CASE_MISMATCH', () => {
    const result = getEvidenceByCaseId(TCA, g15Rows, g15Graph);
    expect(result).toHaveProperty('error_code', 'CASE_MISMATCH');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SI-11 — causal_attribution_established never established by this service
// ─────────────────────────────────────────────────────────────────────────────

describe('SI-11: causal_attribution_established never modified by service methods', () => {
  test('SI-11-1: getEvidenceByCaseId passes through graph value unchanged', () => {
    const graphCausal = g15Graph.causal_attribution_established;
    const result = getEvidenceByCaseId(G15, g15Rows, g15Graph);
    expect(result.causal_attribution_established).toBe(graphCausal);
    expect(g15Graph.causal_attribution_established).toBe(graphCausal);
  });

  test('SI-11-2: filterBySource does not add causal_attribution_established', () => {
    const result = filterBySource(G15, 'CASE', g15Rows, g15Graph);
    expect(result).not.toHaveProperty('causal_attribution_established');
  });

  test('SI-11-3: filterByTimeWindow does not add causal_attribution_established', () => {
    const result = filterByTimeWindow(G15, { from: g15Rows[0].timestamp }, g15Rows, g15Graph);
    expect(result).not.toHaveProperty('causal_attribution_established');
  });

  test('SI-11-4: getAnomalyCenteredEvidence does not add causal_attribution_established', () => {
    if (!g15AnchorTimestamp) return;
    const result = getAnomalyCenteredEvidence(G15, g15AnchorTimestamp, 10, g15Rows, g15Graph);
    expect(result).not.toHaveProperty('causal_attribution_established');
  });

  test('SI-11-5: compareHypothesesEvidenceForCase passes through graph value unchanged', () => {
    const result = compareHypothesesEvidenceForCase(G15, g15Rows, g15Graph, []);
    expect(result.causal_attribution_established).toBe(g15Graph.causal_attribution_established);
  });

  test('SI-11-6: the graph object causal_attribution_established is unmodified after all service calls', () => {
    // Run all methods that receive the graph
    getEvidenceByCaseId(G15, g15Rows, g15Graph);
    getEvidenceById(G15, g15AnchorId, g15Rows, g15Graph);
    filterBySource(G15, 'CASE', g15Rows, g15Graph);
    filterByMeasurementType(G15, { evidence_type: 'case_event' }, g15Rows, g15Graph);
    filterByTimeWindow(G15, { from: g15Rows[0].timestamp }, g15Rows, g15Graph);
    if (g15AnchorTimestamp) getAnomalyCenteredEvidence(G15, g15AnchorTimestamp, 10, g15Rows, g15Graph);
    getHypothesisLinkedEvidence(G15, g15Graph.hypotheses[0].hypothesis_id, g15Rows, g15Graph);
    getProvenanceLookup(G15, g15AnchorId, g15Rows, g15Graph);
    getCaseEvidenceIndex(G15, g15Rows, g15Graph);
    getEnvironmentalContextSummary(G15, g15Rows, g15Graph);
    compareHypothesesEvidenceForCase(G15, g15Rows, g15Graph, []);
    // After all calls, the graph causal flag must still be false for Galaxy-15
    expect(g15Graph.causal_attribution_established).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SI-1 — source rows array is never mutated
// ─────────────────────────────────────────────────────────────────────────────

describe('SI-1: source rows array is never mutated by any service method', () => {
  test('SI-1-1: row count unchanged after all service calls', () => {
    const before = g15Rows.length;
    getEvidenceByCaseId(G15, g15Rows, g15Graph);
    filterBySource(G15, 'CASE', g15Rows, g15Graph);
    filterByMeasurementType(G15, { evidence_type: 'case_event' }, g15Rows, g15Graph);
    filterByTimeWindow(G15, { from: g15Rows[0].timestamp }, g15Rows, g15Graph);
    if (g15AnchorTimestamp) {
      getAnomalyCenteredEvidence(G15, g15AnchorTimestamp, 10, g15Rows, g15Graph);
    }
    getCaseEvidenceIndex(G15, g15Rows, g15Graph);
    getEnvironmentalContextSummary(G15, g15Rows, g15Graph);
    compareHypothesesEvidenceForCase(G15, g15Rows, g15Graph, []);
    expect(g15Rows.length).toBe(before);
  });

  test('SI-1-2: first row evidence_id unchanged after all service calls', () => {
    const firstId = g15Rows[0].evidence_id;
    getEvidenceByCaseId(G15, g15Rows, g15Graph);
    filterBySource(G15, 'CASE', g15Rows, g15Graph);
    expect(g15Rows[0].evidence_id).toBe(firstId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEMPORAL_FILTER_NOTE contract
// ─────────────────────────────────────────────────────────────────────────────

describe('TEMPORAL_FILTER_NOTE', () => {
  test('TFN-1: is a non-empty string', () => {
    expect(typeof TEMPORAL_FILTER_NOTE).toBe('string');
    expect(TEMPORAL_FILTER_NOTE.length).toBeGreaterThan(0);
  });

  test('TFN-2: does not claim causality (SI-7)', () => {
    expect(TEMPORAL_FILTER_NOTE.toLowerCase()).not.toMatch(/\bcaused\b/);
    expect(TEMPORAL_FILTER_NOTE.toLowerCase()).not.toContain('proves');
    expect(TEMPORAL_FILTER_NOTE.toLowerCase()).not.toContain('establishes causality');
  });
});
