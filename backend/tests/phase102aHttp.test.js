'use strict';

/**
 * Phase 10.2A — Evidence Exploration HTTP API — Route Contract Tests
 *
 * Tests every new route registered in Phase 10.2A via supertest.
 * No existing route is modified or retested here (Phase 7.3 routes are
 * covered by evidenceExplorationHttp.test.js).
 *
 * Routes covered:
 *   GET /api/cases/:id/evidence
 *   GET /api/cases/:id/evidence/:evidenceId
 *   GET /api/cases/:id/evidence/source/:source
 *   GET /api/cases/:id/evidence/measurement
 *   GET /api/cases/:id/evidence/time-window
 *   GET /api/cases/:id/evidence/anomaly-centered
 *
 * Pre-existing routes also exercised (via Phase 10.2A spec):
 *   GET /api/cases/:id/evidence/:evidenceId/provenance  (Phase 4.4 — unchanged)
 *   GET /api/cases/:id/evidence-index                   (Phase 7.3 — unchanged)
 *   GET /api/cases/:id/environmental-context            (Phase 7.3 — unchanged)
 *   GET /api/cases/:id/hypotheses/compare               (Phase 7.3 — unchanged)
 *   GET /api/cases/:id/hypotheses/:hid/evidence         (Phase 7.3 — unchanged)
 *
 * Contract requirements verified per Phase 10.2A spec:
 *   C1  Route is read-only — no state mutation on any call
 *   C2  Unknown case returns 404 CASE_NOT_FOUND
 *   C3  Malformed / missing required parameters return 400 VALIDATION_ERROR
 *   C4  causal_attribution_established is verbatim passthrough (never set)
 *   C5  Correct delegation to Phase 10.1 service (no logic duplication)
 *   C6  No fallback to galaxy-15 (test-case-alpha returns TCA evidence IDs only)
 *   C7  Standard API error shape: { error_code, error, status_code }
 *   C8  No filesystem paths, stack traces, credentials in responses
 *   C9  environmental_context != supporting_evidence (EX-3)
 *   C10 EPHEMERIS absent from hypothesis evidence views (EX-6)
 *   C11 No numerical probabilities (EX-8)
 *   C12 Assessments verbatim (EX-9)
 *   C13 temporal_note / heuristic_window_note always present on relevant routes
 */

const request = require('supertest');
const { app, parseEvidenceCSV, buildEvidenceGraph } = require('../server');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const G15   = 'galaxy-15';
const TCA   = 'test-case-alpha';
const BOGUS = 'no-such-case-zzz999phase102a';

// Known G15 assessments — must never change (C12)
const G15_ASSESSMENTS = {
  H1: 'mixed',
  H2: 'mixed',
  H3: 'supported',
  H4: 'insufficient_evidence',
  H5: 'strongly_supported',
};

const FOUR_LISTS = [
  'environmental_context',
  'supporting_evidence',
  'contradicting_evidence',
  'non_discriminating_evidence',
];

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────────

let g15Rows;
let g15Graph;
let tcaRows;
let tcaGraph;
let g15EphemerisId;   // GOES11_EPHEMERIS row evidence_id
let g15AnchorId;      // CASE-source row evidence_id
let g15AnchorTs;      // timestamp of CASE anchor row
let g15HypWithEnvCtx; // a G15 hypothesis with environmental_context entries

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
  g15AnchorId = anchorRow ? anchorRow.evidence_id : null;
  g15AnchorTs = anchorRow ? anchorRow.timestamp   : null;

  g15HypWithEnvCtx = g15Graph.hypotheses.find(
    (h) => (h.environmental_context || []).length > 0,
  );
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// Helper: assert standard API error shape (C7)
// ─────────────────────────────────────────────────────────────────────────────
function assertErrorShape(body, expectedCode, expectedHttpStatus) {
  expect(typeof body.error_code).toBe('string');
  expect(body.error_code).toBe(expectedCode);
  expect(typeof body.error).toBe('string');
  expect(body.error.length).toBeGreaterThan(0);
  expect(body.status_code).toBe(expectedHttpStatus);
}

// Helper: assert no internal details leaked (C8)
function assertNoLeakage(body) {
  const text = JSON.stringify(body);
  expect(text).not.toMatch(/node_modules/);
  expect(text).not.toMatch(/\.js:\d+/);
  expect(text).not.toMatch(/Error:/);
  expect(text).not.toMatch(/CASES_DIR/);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cases/:id/evidence
// ─────────────────────────────────────────────────────────────────────────────

describe('H102A-1: GET /api/cases/:id/evidence', () => {
  let res;
  let body;

  beforeAll(async () => {
    res  = await request(app).get(`/api/cases/${G15}/evidence`);
    body = res.body;
  });

  test('H102A-1-1: returns HTTP 200 for known case', () => {
    expect(res.status).toBe(200);
  });

  test('H102A-1-2: case_id matches the requested case (C6)', () => {
    expect(body.case_id).toBe(G15);
  });

  test('H102A-1-3: evidence array is present and non-empty', () => {
    expect(Array.isArray(body.evidence)).toBe(true);
    expect(body.evidence.length).toBeGreaterThan(0);
  });

  test('H102A-1-4: evidence_count matches array length', () => {
    expect(body.evidence_count).toBe(body.evidence.length);
  });

  test('H102A-1-5: every record has all 12 evidence fields (EX-2)', () => {
    const FIELDS = [
      'evidence_id', 'timestamp', 'source', 'measurement',
      'value', 'unit', 'resolution', 'dataset_id',
      'provider', 'variable', 'evidence_type', 'quality',
    ];
    for (const rec of body.evidence.slice(0, 10)) {
      for (const f of FIELDS) {
        expect(rec).toHaveProperty(f);
      }
    }
  });

  test('H102A-1-6: causal_attribution_established is false for Galaxy-15 (C4)', () => {
    expect(body.causal_attribution_established).toBe(false);
  });

  test('H102A-1-7: unknown case returns 404 CASE_NOT_FOUND (C2)', async () => {
    const r = await request(app).get(`/api/cases/${BOGUS}/evidence`);
    expect(r.status).toBe(404);
    assertErrorShape(r.body, 'CASE_NOT_FOUND', 404);
    assertNoLeakage(r.body);
  });

  test('H102A-1-8: no fallback to G15 — TCA case returns TCA IDs only (C6)', async () => {
    const r = await request(app).get(`/api/cases/${TCA}/evidence`);
    expect(r.status).toBe(200);
    expect(r.body.case_id).toBe(TCA);
    for (const rec of r.body.evidence) {
      expect(rec.evidence_id).toMatch(/^E-TCA-/);
    }
  });

  test('H102A-1-9: no numerical probability language (C11)', () => {
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/\b\d+(\.\d+)?\s*%/);
    expect(text).not.toMatch(/\bprobability\b/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cases/:id/evidence/:evidenceId
// ─────────────────────────────────────────────────────────────────────────────

describe('H102A-2: GET /api/cases/:id/evidence/:evidenceId', () => {
  test('H102A-2-1: known evidence ID returns HTTP 200 with all 12 fields', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence/${g15AnchorId}`);
    expect(r.status).toBe(200);
    expect(r.body.evidence_id).toBe(g15AnchorId);
    expect(r.body.found).toBe(true);
    const FIELDS = [
      'timestamp', 'source', 'measurement', 'value', 'unit',
      'resolution', 'dataset_id', 'provider', 'variable',
      'evidence_type', 'quality',
    ];
    for (const f of FIELDS) {
      expect(r.body).toHaveProperty(f);
    }
  });

  test('H102A-2-2: EPHEMERIS ID returns 200 with empty hypothesis_relationships (EX-6)', async () => {
    if (!g15EphemerisId) return;
    const r = await request(app).get(`/api/cases/${G15}/evidence/${g15EphemerisId}`);
    expect(r.status).toBe(200);
    expect(r.body.found).toBe(true);
    expect(Array.isArray(r.body.hypothesis_relationships)).toBe(true);
    expect(r.body.hypothesis_relationships).toHaveLength(0);
  });

  test('H102A-2-3: unknown evidence ID returns 404 EVIDENCE_NOT_FOUND (C2)', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence/E-G15-BOGUS-9999`);
    expect(r.status).toBe(404);
    assertErrorShape(r.body, 'EVIDENCE_NOT_FOUND', 404);
    assertNoLeakage(r.body);
  });

  test('H102A-2-4: unknown case returns 404 CASE_NOT_FOUND (C2)', async () => {
    const r = await request(app).get(`/api/cases/${BOGUS}/evidence/E-G15-0001`);
    expect(r.status).toBe(404);
    assertErrorShape(r.body, 'CASE_NOT_FOUND', 404);
  });

  test('H102A-2-5: CASE anchor has hypothesis_relationships (EX-2)', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence/${g15AnchorId}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.hypothesis_relationships)).toBe(true);
    expect(r.body.hypothesis_relationships.length).toBeGreaterThan(0);
  });

  test('H102A-2-6: route does not shadow /evidence/source path', async () => {
    // Verify that /evidence/source/:source is handled by its own route,
    // not captured as evidence/:evidenceId where evidenceId = "source".
    // (The source route returns { source, evidence: [] } shape, not { found: true/false }.)
    const r = await request(app).get(`/api/cases/${G15}/evidence/source/CASE`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('source', 'CASE');
    expect(Array.isArray(r.body.evidence)).toBe(true);
    // Must NOT have `found` field — that belongs to the /:evidenceId route
    expect(r.body).not.toHaveProperty('found');
  });

  test('H102A-2-7: no leakage of internals (C8)', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence/E-G15-BOGUS-9999`);
    assertNoLeakage(r.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cases/:id/evidence/source/:source
// ─────────────────────────────────────────────────────────────────────────────

describe('H102A-3: GET /api/cases/:id/evidence/source/:source', () => {
  test('H102A-3-1: CASE source returns only CASE rows', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence/source/CASE`);
    expect(r.status).toBe(200);
    expect(r.body.case_id).toBe(G15);
    expect(r.body.source).toBe('CASE');
    for (const rec of r.body.evidence) {
      expect(rec.source).toBe('CASE');
    }
    expect(r.body.evidence_count).toBe(r.body.evidence.length);
  });

  test('H102A-3-2: GOES11_EPHEMERIS source returns only EPHEMERIS rows', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence/source/GOES11_EPHEMERIS`);
    expect(r.status).toBe(200);
    for (const rec of r.body.evidence) {
      expect(rec.source).toBe('GOES11_EPHEMERIS');
    }
    expect(r.body.evidence_count).toBeGreaterThan(0);
  });

  test('H102A-3-3: unknown source returns 200 with empty array (C5 — service contract)', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence/source/NONEXISTENT_SRCXYZ`);
    expect(r.status).toBe(200);
    expect(r.body.evidence_count).toBe(0);
    expect(r.body.evidence).toEqual([]);
  });

  test('H102A-3-4: unknown case returns 404 CASE_NOT_FOUND (C2)', async () => {
    const r = await request(app).get(`/api/cases/${BOGUS}/evidence/source/CASE`);
    expect(r.status).toBe(404);
    assertErrorShape(r.body, 'CASE_NOT_FOUND', 404);
  });

  test('H102A-3-5: no fallback to G15 — TCA source filter returns TCA IDs (C6)', async () => {
    const r = await request(app).get(`/api/cases/${TCA}/evidence/source/CASE`);
    expect(r.status).toBe(200);
    expect(r.body.case_id).toBe(TCA);
    for (const rec of r.body.evidence) {
      expect(rec.evidence_id).toMatch(/^E-TCA-/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cases/:id/evidence/measurement
// ─────────────────────────────────────────────────────────────────────────────

describe('H102A-4: GET /api/cases/:id/evidence/measurement', () => {
  test('H102A-4-1: filtering by evidence_type=case_event returns CASE rows', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/measurement?evidence_type=case_event`);
    expect(r.status).toBe(200);
    expect(r.body.case_id).toBe(G15);
    for (const rec of r.body.evidence) {
      expect(rec.evidence_type).toBe('case_event');
    }
  });

  test('H102A-4-2: filtering by evidence_type=environmental_observation returns GOES rows', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/measurement?evidence_type=environmental_observation`);
    expect(r.status).toBe(200);
    expect(r.body.evidence_count).toBeGreaterThan(0);
    for (const rec of r.body.evidence) {
      expect(rec.evidence_type).toBe('environmental_observation');
    }
  });

  test('H102A-4-3: filtering by measurement string returns matching rows', async () => {
    const firstMeasurement = g15Rows[0].measurement;
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/measurement?measurement=${encodeURIComponent(firstMeasurement)}`);
    expect(r.status).toBe(200);
    for (const rec of r.body.evidence) {
      expect(rec.measurement).toBe(firstMeasurement);
    }
  });

  test('H102A-4-4: no filter params returns 400 VALIDATION_ERROR (C3)', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence/measurement`);
    expect(r.status).toBe(400);
    assertErrorShape(r.body, 'VALIDATION_ERROR', 400);
    assertNoLeakage(r.body);
  });

  test('H102A-4-5: unknown case returns 404 CASE_NOT_FOUND (C2)', async () => {
    const r = await request(app)
      .get(`/api/cases/${BOGUS}/evidence/measurement?evidence_type=case_event`);
    expect(r.status).toBe(404);
    assertErrorShape(r.body, 'CASE_NOT_FOUND', 404);
  });

  test('H102A-4-6: filter field is echoed in response', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/measurement?evidence_type=case_event`);
    expect(r.status).toBe(200);
    expect(r.body.filter).toHaveProperty('evidence_type', 'case_event');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cases/:id/evidence/time-window
// ─────────────────────────────────────────────────────────────────────────────

describe('H102A-5: GET /api/cases/:id/evidence/time-window', () => {
  let g15From;
  let g15To;

  beforeAll(() => {
    // Use a narrow slice around the middle of the dataset
    const mid = Math.floor(g15Rows.length / 2);
    g15From = g15Rows[mid - 5].timestamp;
    g15To   = g15Rows[mid + 5].timestamp;
  });

  test('H102A-5-1: from+to filter returns records within interval', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/time-window?from=${encodeURIComponent(g15From)}&to=${encodeURIComponent(g15To)}`);
    expect(r.status).toBe(200);
    expect(r.body.case_id).toBe(G15);
    for (const rec of r.body.evidence) {
      expect(rec.timestamp >= g15From).toBe(true);
      expect(rec.timestamp <= g15To).toBe(true);
    }
  });

  test('H102A-5-2: from-only filter returns records at or after from', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/time-window?from=${encodeURIComponent(g15From)}`);
    expect(r.status).toBe(200);
    for (const rec of r.body.evidence) {
      expect(rec.timestamp >= g15From).toBe(true);
    }
  });

  test('H102A-5-3: to-only filter returns records at or before to', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/time-window?to=${encodeURIComponent(g15To)}`);
    expect(r.status).toBe(200);
    for (const rec of r.body.evidence) {
      expect(rec.timestamp <= g15To).toBe(true);
    }
  });

  test('H102A-5-4: no filter params returns 400 VALIDATION_ERROR (C3)', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence/time-window`);
    expect(r.status).toBe(400);
    assertErrorShape(r.body, 'VALIDATION_ERROR', 400);
    assertNoLeakage(r.body);
  });

  test('H102A-5-5: temporal_note is always present (C13 — SI-7)', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/time-window?from=${encodeURIComponent(g15From)}`);
    expect(r.status).toBe(200);
    expect(typeof r.body.temporal_note).toBe('string');
    expect(r.body.temporal_note.length).toBeGreaterThan(0);
  });

  test('H102A-5-6: temporal_note must not claim causality (SI-7, SI-11)', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/time-window?from=${encodeURIComponent(g15From)}`);
    expect(r.body.temporal_note.toLowerCase()).not.toMatch(/\bcaused\b/);
    expect(r.body.temporal_note.toLowerCase()).not.toContain('proves');
  });

  test('H102A-5-7: unknown case returns 404 CASE_NOT_FOUND (C2)', async () => {
    const r = await request(app)
      .get(`/api/cases/${BOGUS}/evidence/time-window?from=${encodeURIComponent(g15From)}`);
    expect(r.status).toBe(404);
    assertErrorShape(r.body, 'CASE_NOT_FOUND', 404);
  });

  test('H102A-5-8: filter bounds are echoed in response', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/time-window?from=${encodeURIComponent(g15From)}&to=${encodeURIComponent(g15To)}`);
    expect(r.status).toBe(200);
    expect(r.body.filter).toHaveProperty('from', g15From);
    expect(r.body.filter).toHaveProperty('to', g15To);
  });

  test('H102A-5-9: causal_attribution_established is not present in response (SI-11)', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/time-window?from=${encodeURIComponent(g15From)}`);
    expect(r.body).not.toHaveProperty('causal_attribution_established');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cases/:id/evidence/anomaly-centered
// ─────────────────────────────────────────────────────────────────────────────

describe('H102A-6: GET /api/cases/:id/evidence/anomaly-centered', () => {
  test('H102A-6-1: valid request returns evidence within window', async () => {
    if (!g15AnchorTs) return;
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/anomaly-centered?timestamp=${encodeURIComponent(g15AnchorTs)}&window_minutes=10`);
    expect(r.status).toBe(200);
    expect(r.body.case_id).toBe(G15);
    expect(r.body.anomaly_timestamp).toBe(g15AnchorTs);
    expect(r.body.window_minutes).toBe(10);
    expect(r.body.evidence_count).toBeGreaterThan(0);
  });

  test('H102A-6-2: heuristic_window_note is always present (C13 — SI-7)', async () => {
    if (!g15AnchorTs) return;
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/anomaly-centered?timestamp=${encodeURIComponent(g15AnchorTs)}&window_minutes=10`);
    expect(r.status).toBe(200);
    expect(typeof r.body.heuristic_window_note).toBe('string');
    expect(r.body.heuristic_window_note.length).toBeGreaterThan(0);
  });

  test('H102A-6-3: heuristic_window_note must not claim causality (SI-7, SI-11)', async () => {
    if (!g15AnchorTs) return;
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/anomaly-centered?timestamp=${encodeURIComponent(g15AnchorTs)}&window_minutes=10`);
    expect(r.body.heuristic_window_note.toLowerCase()).not.toMatch(/\bcaused\b/);
    expect(r.body.heuristic_window_note.toLowerCase()).not.toContain('proves causality');
  });

  test('H102A-6-4: missing timestamp returns 400 VALIDATION_ERROR (C3)', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/anomaly-centered?window_minutes=10`);
    expect(r.status).toBe(400);
    assertErrorShape(r.body, 'VALIDATION_ERROR', 400);
    assertNoLeakage(r.body);
  });

  test('H102A-6-5: missing window_minutes returns 400 VALIDATION_ERROR (C3)', async () => {
    if (!g15AnchorTs) return;
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/anomaly-centered?timestamp=${encodeURIComponent(g15AnchorTs)}`);
    expect(r.status).toBe(400);
    assertErrorShape(r.body, 'VALIDATION_ERROR', 400);
  });

  test('H102A-6-6: window_minutes=0 returns 400 VALIDATION_ERROR (C3)', async () => {
    if (!g15AnchorTs) return;
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/anomaly-centered?timestamp=${encodeURIComponent(g15AnchorTs)}&window_minutes=0`);
    expect(r.status).toBe(400);
    assertErrorShape(r.body, 'VALIDATION_ERROR', 400);
  });

  test('H102A-6-7: negative window_minutes returns 400 VALIDATION_ERROR (C3)', async () => {
    if (!g15AnchorTs) return;
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/anomaly-centered?timestamp=${encodeURIComponent(g15AnchorTs)}&window_minutes=-5`);
    expect(r.status).toBe(400);
    assertErrorShape(r.body, 'VALIDATION_ERROR', 400);
  });

  test('H102A-6-8: non-numeric window_minutes returns 400 VALIDATION_ERROR (C3)', async () => {
    if (!g15AnchorTs) return;
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/anomaly-centered?timestamp=${encodeURIComponent(g15AnchorTs)}&window_minutes=abc`);
    expect(r.status).toBe(400);
    assertErrorShape(r.body, 'VALIDATION_ERROR', 400);
  });

  test('H102A-6-9: unknown case returns 404 CASE_NOT_FOUND (C2)', async () => {
    const r = await request(app)
      .get(`/api/cases/${BOGUS}/evidence/anomaly-centered?timestamp=2010-01-01T00:00:00Z&window_minutes=10`);
    expect(r.status).toBe(404);
    assertErrorShape(r.body, 'CASE_NOT_FOUND', 404);
  });

  test('H102A-6-10: result includes EPHEMERIS rows (raw timeline slice)', async () => {
    if (!g15AnchorTs || !g15EphemerisId) return;
    // Use a large window to ensure at least one EPHEMERIS row is included
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/anomaly-centered?timestamp=${encodeURIComponent(g15AnchorTs)}&window_minutes=60`);
    expect(r.status).toBe(200);
    const ephRecs = r.body.evidence.filter((e) => e.source === 'GOES11_EPHEMERIS');
    expect(ephRecs.length).toBeGreaterThan(0);
  });

  test('H102A-6-11: causal_attribution_established is NOT present in response (SI-11)', async () => {
    if (!g15AnchorTs) return;
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/anomaly-centered?timestamp=${encodeURIComponent(g15AnchorTs)}&window_minutes=10`);
    expect(r.body).not.toHaveProperty('causal_attribution_established');
  });

  test('H102A-6-12: no fallback to G15 — TCA case returns TCA IDs only (C6)', async () => {
    // Use TCA with its own anchor timestamp
    const tcaAnchorRow = tcaRows.find((r) => r.source === 'CASE') || tcaRows[0];
    const r = await request(app)
      .get(`/api/cases/${TCA}/evidence/anomaly-centered?timestamp=${encodeURIComponent(tcaAnchorRow.timestamp)}&window_minutes=999999`);
    expect(r.status).toBe(200);
    expect(r.body.case_id).toBe(TCA);
    for (const rec of r.body.evidence) {
      expect(rec.evidence_id).toMatch(/^E-TCA-/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scientific constraint preservation tests
// ─────────────────────────────────────────────────────────────────────────────

describe('H102A-7: Scientific constraints preserved across all new routes', () => {
  test('H102A-7-1: G15 causal_attribution_established is false on /evidence (C4)', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence`);
    expect(r.status).toBe(200);
    expect(r.body.causal_attribution_established).toBe(false);
  });

  test('H102A-7-2: /evidence route carries all 278 G15 evidence rows (golden count)', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence`);
    expect(r.status).toBe(200);
    expect(r.body.evidence_count).toBe(278);
  });

  test('H102A-7-3: assessment H1=mixed on hypotheses compare (C12)', async () => {
    const r = await request(app).get(`/api/cases/${G15}/hypotheses/compare`);
    expect(r.status).toBe(200);
    const h1 = r.body.hypotheses.find((h) => h.hypothesis_id === 'H1');
    expect(h1).toBeDefined();
    expect(h1.assessment).toBe('mixed');
  });

  test('H102A-7-4: no numerical probabilities on /evidence (C11)', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence`);
    const text = JSON.stringify(r.body).slice(0, 5000); // spot-check first chunk
    expect(text).not.toMatch(/\b\d+(\.\d+)?\s*%/);
    expect(text).not.toMatch(/\bprobability\b/i);
  });

  test('H102A-7-5: EPHEMERIS absent from hypothesis evidence view (EX-6, C10)', async () => {
    const hid = g15HypWithEnvCtx ? g15HypWithEnvCtx.hypothesis_id : 'H1';
    const r = await request(app).get(`/api/cases/${G15}/hypotheses/${hid}/evidence`);
    expect(r.status).toBe(200);
    const g15EphIds = new Set(
      g15Rows.filter((row) => row.source === 'GOES11_EPHEMERIS').map((row) => row.evidence_id),
    );
    for (const list of FOUR_LISTS) {
      for (const entry of r.body[list] || []) {
        expect(g15EphIds.has(entry.evidence_id)).toBe(false);
      }
    }
  });

  test('H102A-7-6: env_context != supporting_evidence on hypothesis view (EX-3, C9)', async () => {
    const hid = g15HypWithEnvCtx ? g15HypWithEnvCtx.hypothesis_id : 'H1';
    const r = await request(app).get(`/api/cases/${G15}/hypotheses/${hid}/evidence`);
    expect(r.status).toBe(200);
    const envIds = new Set((r.body.environmental_context || []).map((e) => e.evidence_id));
    for (const e of (r.body.supporting_evidence || [])) {
      expect(envIds.has(e.evidence_id)).toBe(false);
    }
  });

  test('H102A-7-7: canonical assessments preserved via hypothesis evidence view (C12)', async () => {
    for (const [hid, expected] of Object.entries(G15_ASSESSMENTS)) {
      const r = await request(app).get(`/api/cases/${G15}/hypotheses/${hid}/evidence`);
      expect(r.status).toBe(200);
      expect(r.body.assessment).toBe(expected);
    }
  });

  test('H102A-7-8: read-only — POST to a Phase 10.2A route returns 404 NOT_FOUND (C1)', async () => {
    // None of the new routes accept POST — Express catch-all returns 404
    const r = await request(app).post(`/api/cases/${G15}/evidence`).send({});
    expect(r.status).toBe(404);
  });

  test('H102A-7-9: read-only — PATCH to a Phase 10.2A route returns 404 NOT_FOUND (C1)', async () => {
    const r = await request(app).patch(`/api/cases/${G15}/evidence`).send({});
    expect(r.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Route registration verification
// ─────────────────────────────────────────────────────────────────────────────

describe('H102A-8: Route registration — all Phase 10.2A endpoints are reachable', () => {
  const ROUTES = [
    [`/api/cases/${G15}/evidence`,                                                         200],
    [`/api/cases/${G15}/evidence/source/CASE`,                                            200],
    [`/api/cases/${G15}/evidence/measurement?evidence_type=case_event`,                   200],
    [`/api/cases/${G15}/evidence/time-window?from=2010-01-01T00:00:00Z`,                  200],
    [`/api/cases/${G15}/evidence-index`,                                                   200],
    [`/api/cases/${G15}/environmental-context`,                                           200],
    [`/api/cases/${G15}/hypotheses/compare`,                                              200],
  ];

  for (const [route, expectedStatus] of ROUTES) {
    test(`H102A-8: GET ${route} returns ${expectedStatus}`, async () => {
      const r = await request(app).get(route);
      expect(r.status).toBe(expectedStatus);
    });
  }

  test('H102A-8: GET /api/cases/:id/evidence/:evidenceId returns 200 for known ID', async () => {
    if (!g15AnchorId) return;
    const r = await request(app).get(`/api/cases/${G15}/evidence/${g15AnchorId}`);
    expect(r.status).toBe(200);
  });

  test('H102A-8: GET /api/cases/:id/evidence/anomaly-centered returns 200 for valid params', async () => {
    if (!g15AnchorTs) return;
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/anomaly-centered?timestamp=${encodeURIComponent(g15AnchorTs)}&window_minutes=10`);
    expect(r.status).toBe(200);
  });

  test('H102A-8: GET /api/cases/:id/evidence/:evidenceId/provenance returns 200 for known ID', async () => {
    if (!g15AnchorId) return;
    const r = await request(app).get(`/api/cases/${G15}/evidence/${g15AnchorId}/provenance`);
    expect(r.status).toBe(200);
  });

  test('H102A-8: GET /api/cases/:id/hypotheses/:hid/evidence returns 200 for H1', async () => {
    const r = await request(app).get(`/api/cases/${G15}/hypotheses/H1/evidence`);
    expect(r.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// No fallback to Galaxy-15 (C6)
// ─────────────────────────────────────────────────────────────────────────────

describe('H102A-9: No fallback to Galaxy-15 — TCA case returns only TCA data', () => {
  test('H102A-9-1: /evidence returns TCA case_id and TCA evidence IDs', async () => {
    const r = await request(app).get(`/api/cases/${TCA}/evidence`);
    expect(r.status).toBe(200);
    expect(r.body.case_id).toBe(TCA);
    for (const rec of r.body.evidence) {
      expect(rec.evidence_id).not.toMatch(/^E-G15-/);
    }
  });

  test('H102A-9-2: /evidence/source/CASE for TCA returns TCA IDs, not G15 IDs', async () => {
    const r = await request(app).get(`/api/cases/${TCA}/evidence/source/CASE`);
    expect(r.status).toBe(200);
    expect(r.body.case_id).toBe(TCA);
    for (const rec of r.body.evidence) {
      expect(rec.evidence_id).not.toMatch(/^E-G15-/);
    }
  });

  test('H102A-9-3: /evidence/measurement for TCA returns TCA IDs, not G15 IDs', async () => {
    const r = await request(app)
      .get(`/api/cases/${TCA}/evidence/measurement?evidence_type=environmental_observation`);
    expect(r.status).toBe(200);
    expect(r.body.case_id).toBe(TCA);
    for (const rec of r.body.evidence) {
      expect(rec.evidence_id).not.toMatch(/^E-G15-/);
    }
  });

  test('H102A-9-4: unknown case returns 404 — not galaxy-15 data', async () => {
    const r = await request(app).get(`/api/cases/${BOGUS}/evidence`);
    expect(r.status).toBe(404);
    expect(r.body).not.toHaveProperty('evidence');
    expect(r.body.error_code).toBe('CASE_NOT_FOUND');
  });
});
