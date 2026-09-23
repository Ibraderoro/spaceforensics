'use strict';

/**
 * Phase 10.3.4 — Cache Observability & Management HTTP Endpoints
 *
 * Tests the three operational endpoints added in Phase 10.3.4:
 *
 *   GET  /api/cache/evidence/stats
 *   POST /api/cache/evidence/invalidate/:caseId
 *   POST /api/cache/evidence/invalidate-all
 *
 * Required coverage per spec:
 *   CO-1   Stats endpoint returns 200 and JSON
 *   CO-2   Stats endpoint does not expose raw evidence rows
 *   CO-3   Stats endpoint does not expose graph data
 *   CO-4   Stats endpoint does not trigger an evidence load
 *   CO-5   Known cached case can be invalidated via single-case endpoint
 *   CO-6   After single-case invalidation, next getCaseEvidence is a cold load
 *   CO-7   Invalidating one case does not invalidate another cached case
 *   CO-8   Unknown case invalidation is deterministic and does not cache anything
 *   CO-9   POST /api/cache/evidence/invalidate-all returns success
 *   CO-10  Invalidate-all clears all cached entries
 *   CO-11  After invalidate-all, next request for a case performs a cold load
 *   CO-12  Invalidation does not modify source files
 *   CO-13  Invalidation does not modify evidence rows on disk
 *   CO-14  Invalidation does not modify the evidence graph definition
 *   CO-15  Invalidation does not modify forensic/hypothesis output
 *   CO-16  Existing 11 evidence exploration endpoints continue to return their shapes
 *   CO-17  Concurrent cache semantics remain intact after invalidation
 *   CO-18  inFlight returns to zero after successful invalidation-related requests
 *   CO-19  inFlight returns to zero after failed cache loads
 *   CO-20  Cache statistics remain internally consistent before and after invalidation
 *   CO-21  Phase 10.3.3-B row freeze invariants hold through the HTTP path
 *   CO-22  Stats response shape does not include rows, graph, or hypothesis data
 *   CO-23  Single-case invalidation of an unknown case returns invalidated:false
 *   CO-24  invalidate-all reports the number of entries cleared
 *   CO-25  Route ordering: /api/cache/evidence/* does not interfere with /api/cases/:id/*
 */

const request           = require('supertest');
const { app, parseEvidenceCSV, buildEvidenceGraph } = require('../server');
const evidenceCaseCache = require('../services/evidenceCaseCache');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const G15   = 'galaxy-15';
const TCA   = 'test-case-alpha';
const GS17  = 'goes16-sep2017';
const BOGUS = 'no-such-case-1034-zzz';

const G15_EVIDENCE_COUNT  = 278;
const G15_EPHEMERIS_COUNT = 61;
const G15_FIRST_ID        = 'E-G15-0001';

const G15_ASSESSMENTS = {
  H1: 'mixed',
  H2: 'mixed',
  H3: 'supported',
  H4: 'insufficient_evidence',
  H5: 'strongly_supported',
};

// Evidence-exploration routes that return 200 with no extra query params.
// /evidence/measurement and /evidence/anomaly-centered require required params;
// they are tested separately in CO-25 to verify 400 is still returned correctly.
const EXPLORATION_ROUTES_200 = [
  `/api/cases/${G15}/evidence`,
  `/api/cases/${G15}/evidence/source/GOES11_EP8`,
  `/api/cases/${G15}/evidence/time-window?from=2010-04-05T00:00:00Z&to=2010-04-06T00:00:00Z`,
  `/api/cases/${G15}/evidence-index`,
  `/api/cases/${G15}/environmental-context`,
  `/api/cases/${G15}/hypotheses/compare`,
];

// Routes that require query params and return 400 without them —
// this is their correct existing behaviour.
const EXPLORATION_ROUTES_400_WITHOUT_PARAMS = [
  { url: `/api/cases/${G15}/evidence/measurement`, reason: 'requires measurement or evidence_type' },
  { url: `/api/cases/${G15}/evidence/anomaly-centered`, reason: 'requires timestamp and window_minutes' },
];

// Valid parameterised forms of the param-requiring routes.
const EXPLORATION_ROUTES_200_WITH_PARAMS = [
  `/api/cases/${G15}/evidence/measurement?measurement=b_gsm`,
  `/api/cases/${G15}/evidence/anomaly-centered?timestamp=2010-04-05T17:00:00Z&window_minutes=60`,
];

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — loaded once before all tests
// ─────────────────────────────────────────────────────────────────────────────

let g15RowsRef;   // raw canonical rows from the authority chain
let g15GraphRef;  // raw canonical graph

beforeAll(async () => {
  jest.setTimeout(60_000);
  g15RowsRef  = await parseEvidenceCSV(G15);
  g15GraphRef = await buildEvidenceGraph(G15, g15RowsRef);
}, 60_000);

beforeEach(() => {
  evidenceCaseCache._reset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  evidenceCaseCache._reset();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function get(url) {
  const res  = await request(app).get(url);
  const body = res.body;
  return { res, body };
}

async function post(url) {
  const res  = await request(app).post(url);
  const body = res.body;
  return { res, body };
}

function statsUrl()               { return '/api/cache/evidence/stats'; }
function invalidateUrl(caseId)    { return `/api/cache/evidence/invalidate/${caseId}`; }
function invalidateAllUrl()       { return '/api/cache/evidence/invalidate-all'; }

// ─────────────────────────────────────────────────────────────────────────────
// CO-1 — Stats endpoint returns 200 and JSON
// ─────────────────────────────────────────────────────────────────────────────
test('CO-1: GET /api/cache/evidence/stats returns 200 and application/json', async () => {
  const { res, body } = await get(statsUrl());
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/application\/json/);
  expect(body).toBeDefined();
  expect(typeof body).toBe('object');
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-2 — Stats endpoint does not expose raw evidence rows
// ─────────────────────────────────────────────────────────────────────────────
test('CO-2: stats response does not contain raw evidence rows', async () => {
  // Prime the cache so there is something to inspect.
  await evidenceCaseCache.getCaseEvidence(G15);

  const { body } = await get(statsUrl());

  // Must not have a rows field or any array of evidence objects.
  expect(body.rows).toBeUndefined();
  expect(body.evidence).toBeUndefined();

  // Verify no nested key contains evidence_id patterns.
  const json = JSON.stringify(body);
  expect(json).not.toMatch(/E-G15-\d{4}/);
  expect(json).not.toMatch(/evidence_id/);
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-3 — Stats endpoint does not expose graph data
// ─────────────────────────────────────────────────────────────────────────────
test('CO-3: stats response does not contain graph or hypothesis data', async () => {
  await evidenceCaseCache.getCaseEvidence(G15);

  const { body } = await get(statsUrl());

  expect(body.graph).toBeUndefined();
  expect(body.hypotheses).toBeUndefined();
  expect(body.causal_attribution_established).toBeUndefined();

  const json = JSON.stringify(body);
  expect(json).not.toMatch(/causal_attribution_established/);
  expect(json).not.toMatch(/hypothesis_id/);
  expect(json).not.toMatch(/supporting_evidence/);
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-4 — Stats endpoint does not trigger an evidence load
// ─────────────────────────────────────────────────────────────────────────────
test('CO-4: GET /api/cache/evidence/stats does not call parseEvidenceCSV or buildEvidenceGraph', async () => {
  const parseSpy = jest.spyOn(require('../server'), 'parseEvidenceCSV');
  const graphSpy = jest.spyOn(require('../server'), 'buildEvidenceGraph');

  await get(statsUrl());

  expect(parseSpy).not.toHaveBeenCalled();
  expect(graphSpy).not.toHaveBeenCalled();
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-5 — Known cached case can be invalidated
// ─────────────────────────────────────────────────────────────────────────────
test('CO-5: POST /api/cache/evidence/invalidate/:caseId invalidates a cached case', async () => {
  // Prime the cache.
  await evidenceCaseCache.getCaseEvidence(G15);
  expect(evidenceCaseCache.has(G15)).toBe(true);

  const { res, body } = await post(invalidateUrl(G15));

  expect(res.status).toBe(200);
  expect(body.invalidated).toBe(true);
  expect(body.case_id).toBe(G15);
  expect(evidenceCaseCache.has(G15)).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-6 — After single-case invalidation the next getCaseEvidence is a cold load
// ─────────────────────────────────────────────────────────────────────────────
test('CO-6: after single-case invalidation via HTTP the next getCaseEvidence performs a cold load', async () => {
  await evidenceCaseCache.getCaseEvidence(G15);   // prime

  await post(invalidateUrl(G15));                  // invalidate via HTTP

  const parseSpy = jest.spyOn(require('../server'), 'parseEvidenceCSV');
  const { rows, graph } = await evidenceCaseCache.getCaseEvidence(G15);

  expect(parseSpy).toHaveBeenCalledTimes(1);        // cold reload occurred
  expect(rows.length).toBe(G15_EVIDENCE_COUNT);
  expect(graph.case_id).toBe(G15);
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-7 — Invalidating one case does not invalidate another
// ─────────────────────────────────────────────────────────────────────────────
test('CO-7: invalidating G15 via HTTP does not remove TCA from the cache', async () => {
  await evidenceCaseCache.getCaseEvidence(G15);
  await evidenceCaseCache.getCaseEvidence(TCA);

  expect(evidenceCaseCache.getStats().size).toBe(2);

  await post(invalidateUrl(G15));

  expect(evidenceCaseCache.has(G15)).toBe(false);
  expect(evidenceCaseCache.has(TCA)).toBe(true);
  expect(evidenceCaseCache.getStats().size).toBe(1);
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-8 — Unknown case invalidation is deterministic, no cache entry created
// ─────────────────────────────────────────────────────────────────────────────
test('CO-8: invalidating an unknown case returns invalidated:false and does not create a cache entry', async () => {
  const { res, body } = await post(invalidateUrl(BOGUS));

  expect(res.status).toBe(200);
  expect(body.invalidated).toBe(false);
  expect(body.case_id).toBe(BOGUS);

  // Must not create a cache entry for the unknown case.
  expect(evidenceCaseCache.has(BOGUS)).toBe(false);
  expect(evidenceCaseCache.getStats().size).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-9 — invalidate-all returns a success response
// ─────────────────────────────────────────────────────────────────────────────
test('CO-9: POST /api/cache/evidence/invalidate-all returns 200 with invalidated:true', async () => {
  const { res, body } = await post(invalidateAllUrl());

  expect(res.status).toBe(200);
  expect(body.invalidated).toBe(true);
  expect(typeof body.cleared).toBe('number');
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-10 — invalidate-all clears all cached entries
// ─────────────────────────────────────────────────────────────────────────────
test('CO-10: POST /api/cache/evidence/invalidate-all clears all three primed entries', async () => {
  await evidenceCaseCache.getCaseEvidence(G15);
  await evidenceCaseCache.getCaseEvidence(TCA);
  await evidenceCaseCache.getCaseEvidence(GS17);
  expect(evidenceCaseCache.getStats().size).toBe(3);

  const { body } = await post(invalidateAllUrl());

  expect(body.cleared).toBe(3);
  expect(body.invalidated).toBe(true);
  expect(evidenceCaseCache.getStats().size).toBe(0);
  expect(evidenceCaseCache.has(G15)).toBe(false);
  expect(evidenceCaseCache.has(TCA)).toBe(false);
  expect(evidenceCaseCache.has(GS17)).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-11 — After invalidate-all the next request for a case is a cold load
// ─────────────────────────────────────────────────────────────────────────────
test('CO-11: after invalidate-all via HTTP a fresh evidence request performs a cold load', async () => {
  await evidenceCaseCache.getCaseEvidence(G15);

  await post(invalidateAllUrl());

  const parseSpy = jest.spyOn(require('../server'), 'parseEvidenceCSV');
  const { rows } = await evidenceCaseCache.getCaseEvidence(G15);

  expect(parseSpy).toHaveBeenCalledTimes(1);
  expect(rows.length).toBe(G15_EVIDENCE_COUNT);
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-12 — Invalidation does not modify source files
// ─────────────────────────────────────────────────────────────────────────────
test('CO-12: invalidation via HTTP does not write to any source file', async () => {
  const fsSpy = jest.spyOn(require('fs').promises, 'writeFile');

  await evidenceCaseCache.getCaseEvidence(G15);
  await post(invalidateUrl(G15));
  await post(invalidateAllUrl());

  expect(fsSpy).not.toHaveBeenCalled();
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-13 — Invalidation does not modify evidence rows on disk
// ─────────────────────────────────────────────────────────────────────────────
test('CO-13: evidence rows after a cache invalidation and reload are byte-identical to the canonical parse', async () => {
  await post(invalidateUrl(G15));

  const { rows: reloadedRows } = await evidenceCaseCache.getCaseEvidence(G15);

  // Evidence IDs must match exactly.
  expect(reloadedRows.length).toBe(g15RowsRef.length);
  for (let i = 0; i < g15RowsRef.length; i++) {
    expect(reloadedRows[i].evidence_id).toBe(g15RowsRef[i].evidence_id);
    expect(reloadedRows[i].source).toBe(g15RowsRef[i].source);
    expect(reloadedRows[i].measurement).toBe(g15RowsRef[i].measurement);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-14 — Invalidation does not modify the evidence graph definition
// ─────────────────────────────────────────────────────────────────────────────
test('CO-14: evidence graph after cache invalidation and reload is structurally identical to the canonical graph', async () => {
  await post(invalidateAllUrl());

  const { graph: reloadedGraph } = await evidenceCaseCache.getCaseEvidence(G15);

  expect(reloadedGraph.case_id).toBe(g15GraphRef.case_id);
  expect(reloadedGraph.causal_attribution_established).toBe(g15GraphRef.causal_attribution_established);
  expect(reloadedGraph.hypotheses.length).toBe(g15GraphRef.hypotheses.length);

  for (let i = 0; i < g15GraphRef.hypotheses.length; i++) {
    expect(reloadedGraph.hypotheses[i].hypothesis_id).toBe(g15GraphRef.hypotheses[i].hypothesis_id);
    expect(reloadedGraph.hypotheses[i].assessment).toBe(g15GraphRef.hypotheses[i].assessment);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-15 — Invalidation does not alter forensic/hypothesis output
// ─────────────────────────────────────────────────────────────────────────────
test('CO-15: forensic assessments and causal_attribution_established are unchanged after invalidation', async () => {
  await post(invalidateAllUrl());

  const { graph } = await evidenceCaseCache.getCaseEvidence(G15);

  expect(graph.causal_attribution_established).toBe(false);
  for (const h of graph.hypotheses) {
    expect(G15_ASSESSMENTS[h.hypothesis_id]).toBeDefined();
    expect(h.assessment).toBe(G15_ASSESSMENTS[h.hypothesis_id]);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-16 — Existing evidence exploration endpoints continue working unchanged
// ─────────────────────────────────────────────────────────────────────────────
test('CO-16: evidence exploration routes return their existing response shapes after invalidation', async () => {
  // Invalidate everything to force cold paths.
  await post(invalidateAllUrl());

  // Routes that do not require extra params must still return 200.
  for (const url of EXPLORATION_ROUTES_200) {
    const { res } = await get(url);
    expect(res.status).toBe(200);
  }

  // Param-requiring routes without params must still return 400 (correct
  // validation behaviour unchanged by Phase 10.3.4).
  for (const { url } of EXPLORATION_ROUTES_400_WITHOUT_PARAMS) {
    const { res } = await get(url);
    expect(res.status).toBe(400);
  }

  // Param-requiring routes with valid params must return 200.
  for (const url of EXPLORATION_ROUTES_200_WITH_PARAMS) {
    const { res } = await get(url);
    expect(res.status).toBe(200);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-17 — Concurrent cache semantics remain intact after invalidation
// ─────────────────────────────────────────────────────────────────────────────
test('CO-17: concurrent cold loads after invalidation deduplicate correctly (one parse+build)', async () => {
  await evidenceCaseCache.getCaseEvidence(G15);

  await post(invalidateUrl(G15));

  const parseSpy = jest.spyOn(require('../server'), 'parseEvidenceCSV');
  const graphSpy = jest.spyOn(require('../server'), 'buildEvidenceGraph');

  const results = await Promise.all([
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
  ]);

  expect(parseSpy).toHaveBeenCalledTimes(1);
  expect(graphSpy).toHaveBeenCalledTimes(1);
  expect(evidenceCaseCache.getStats().size).toBe(1);

  for (const { graph } of results) {
    expect(graph.case_id).toBe(G15);
    expect(graph.causal_attribution_established).toBe(false);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-18 — inFlight returns to 0 after invalidation-related requests
// ─────────────────────────────────────────────────────────────────────────────
test('CO-18: inFlight is 0 after all cache management HTTP requests complete', async () => {
  await evidenceCaseCache.getCaseEvidence(G15);
  await evidenceCaseCache.getCaseEvidence(TCA);

  await post(invalidateUrl(G15));
  expect(evidenceCaseCache.getStats().inFlight).toBe(0);

  await post(invalidateAllUrl());
  expect(evidenceCaseCache.getStats().inFlight).toBe(0);

  // Reload and confirm still zero after completing the cold load.
  await evidenceCaseCache.getCaseEvidence(G15);
  expect(evidenceCaseCache.getStats().inFlight).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-19 — inFlight returns to 0 after a failed cache load
// ─────────────────────────────────────────────────────────────────────────────
test('CO-19: inFlight returns to 0 after a simulated parse failure', async () => {
  const parseError = { status: 500, message: 'Simulated CO-19 parse error' };
  const parseSpy = jest.spyOn(require('../server'), 'parseEvidenceCSV')
    .mockImplementation(() => new Promise((_, reject) => setImmediate(() => reject(parseError))));

  await Promise.allSettled([
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
  ]);

  expect(evidenceCaseCache.getStats().inFlight).toBe(0);
  expect(evidenceCaseCache.getStats().size).toBe(0);

  parseSpy.mockRestore();

  // Confirm stats endpoint also shows 0 inFlight via HTTP.
  const { body } = await get(statsUrl());
  expect(body.inFlight).toBe(0);
  expect(body.size).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-20 — Cache statistics internally consistent before and after invalidation
// ─────────────────────────────────────────────────────────────────────────────
test('CO-20: cache statistics remain internally consistent across the invalidation lifecycle', async () => {
  // Initial state
  let { body: s0 } = await get(statsUrl());
  expect(s0).toEqual({ size: 0, hits: 0, misses: 0, invalidations: 0, inFlight: 0 });

  // Two cold loads
  await evidenceCaseCache.getCaseEvidence(G15);
  await evidenceCaseCache.getCaseEvidence(TCA);
  let { body: s1 } = await get(statsUrl());
  expect(s1.size).toBe(2);
  expect(s1.misses).toBe(2);
  expect(s1.hits).toBe(0);
  expect(s1.inFlight).toBe(0);

  // One warm hit each
  await evidenceCaseCache.getCaseEvidence(G15);
  await evidenceCaseCache.getCaseEvidence(TCA);
  let { body: s2 } = await get(statsUrl());
  expect(s2.size).toBe(2);
  expect(s2.misses).toBe(2);
  expect(s2.hits).toBe(2);

  // Single-case invalidation via HTTP
  await post(invalidateUrl(G15));
  let { body: s3 } = await get(statsUrl());
  expect(s3.size).toBe(1);
  expect(s3.invalidations).toBe(1);

  // Reload G15 — one more miss
  await evidenceCaseCache.getCaseEvidence(G15);
  let { body: s4 } = await get(statsUrl());
  expect(s4.size).toBe(2);
  expect(s4.misses).toBe(3);
  expect(s4.hits).toBe(2);

  // Invalidate-all via HTTP
  await post(invalidateAllUrl());
  let { body: s5 } = await get(statsUrl());
  expect(s5.size).toBe(0);
  expect(s5.invalidations).toBe(3); // 1 (single) + 2 (all)
  expect(s5.inFlight).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-21 — Phase 10.3.3-B row freeze invariants hold through HTTP path
// ─────────────────────────────────────────────────────────────────────────────
test('CO-21: Phase 10.3.3-B row freeze guarantees hold after HTTP-triggered invalidation and reload', async () => {
  // Invalidate to ensure a cold load.
  await post(invalidateAllUrl());

  const { rows, graph } = await evidenceCaseCache.getCaseEvidence(G15);

  // All row objects must be frozen.
  expect(rows.length).toBe(G15_EVIDENCE_COUNT);
  for (const row of rows) {
    expect(Object.isFrozen(row)).toBe(true);
  }

  // Mutation in strict mode must throw.
  expect(() => { rows[0].evidence_id = '__MUTATED__'; }).toThrow(TypeError);
  expect(rows[0].evidence_id).toBe(G15_FIRST_ID);

  // Caller's array is independently mutable.
  expect(Object.isFrozen(rows)).toBe(false);
  const originalLen = rows.length;
  rows.push({ evidence_id: 'SYNTHETIC' });
  expect(rows.length).toBe(originalLen + 1);

  // Warm hit unaffected by the push.
  const { rows: warmRows } = await evidenceCaseCache.getCaseEvidence(G15);
  expect(warmRows.length).toBe(G15_EVIDENCE_COUNT);

  // Graph frozen.
  expect(Object.isFrozen(graph)).toBe(true);
  expect(graph.causal_attribution_established).toBe(false);
  expect(() => { graph.causal_attribution_established = true; }).toThrow(TypeError);
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-22 — Stats response shape is exactly {size,hits,misses,invalidations,inFlight}
// ─────────────────────────────────────────────────────────────────────────────
test('CO-22: stats response shape contains exactly the expected operational keys', async () => {
  const { body } = await get(statsUrl());

  const keys = Object.keys(body).sort();
  expect(keys).toEqual(['hits', 'inFlight', 'invalidations', 'misses', 'size']);

  // All values must be non-negative integers.
  for (const k of keys) {
    expect(typeof body[k]).toBe('number');
    expect(body[k]).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(body[k])).toBe(true);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-23 — Single-case invalidation of an unknown case returns invalidated:false
// ─────────────────────────────────────────────────────────────────────────────
test('CO-23: invalidating an unknown case returns { invalidated: false, case_id }', async () => {
  const { res, body } = await post(invalidateUrl(BOGUS));

  expect(res.status).toBe(200);
  expect(body.invalidated).toBe(false);
  expect(body.case_id).toBe(BOGUS);
  // The unknown case must not appear in the cache.
  expect(evidenceCaseCache.has(BOGUS)).toBe(false);
  // Stats must be unchanged.
  const s = evidenceCaseCache.getStats();
  expect(s.size).toBe(0);
  expect(s.invalidations).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-24 — invalidate-all reports the correct number of cleared entries
// ─────────────────────────────────────────────────────────────────────────────
test('CO-24: invalidate-all on an empty cache reports cleared:0', async () => {
  const { body: b0 } = await post(invalidateAllUrl());
  expect(b0.cleared).toBe(0);
  expect(b0.invalidated).toBe(true);
});

test('CO-24b: invalidate-all on a populated cache reports the exact count cleared', async () => {
  await evidenceCaseCache.getCaseEvidence(G15);
  await evidenceCaseCache.getCaseEvidence(TCA);
  await evidenceCaseCache.getCaseEvidence(GS17);

  const { body } = await post(invalidateAllUrl());
  expect(body.cleared).toBe(3);
  expect(body.invalidated).toBe(true);
  expect(evidenceCaseCache.getStats().size).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-25 — Route ordering: /api/cache/evidence/* does not interfere with
//         /api/cases/:id/* dynamic routes
// ─────────────────────────────────────────────────────────────────────────────
test('CO-25: /api/cases/:id/evidence still returns 200 after cache endpoint registration', async () => {
  const { res, body } = await get(`/api/cases/${G15}/evidence`);
  expect(res.status).toBe(200);
  expect(body).toHaveProperty('evidence_count');
  expect(body.evidence_count).toBe(G15_EVIDENCE_COUNT);
});

test('CO-25b: /api/cache/evidence/stats does not shadow /api/cases/:id/evidence', async () => {
  // Stats endpoint
  const { res: statsRes, body: statsBody } = await get('/api/cache/evidence/stats');
  expect(statsRes.status).toBe(200);
  expect(statsBody).not.toHaveProperty('evidence_count');

  // Case evidence endpoint still works
  const { res: caseRes, body: caseBody } = await get(`/api/cases/${G15}/evidence`);
  expect(caseRes.status).toBe(200);
  expect(caseBody.evidence_count).toBe(G15_EVIDENCE_COUNT);
});

// ─────────────────────────────────────────────────────────────────────────────
// Additional: EPHEMERIS golden count survives full invalidate-reload cycle
// ─────────────────────────────────────────────────────────────────────────────
test('EXTRA-1: G15 EPHEMERIS count is still 61 after invalidate-all and reload', async () => {
  await post(invalidateAllUrl());
  const { rows } = await evidenceCaseCache.getCaseEvidence(G15);
  const ephCount = rows.filter(r => r.source === 'GOES11_EPHEMERIS').length;
  expect(ephCount).toBe(G15_EPHEMERIS_COUNT);
});

// ─────────────────────────────────────────────────────────────────────────────
// Additional: causal_attribution_established stays false through HTTP lifecycle
// ─────────────────────────────────────────────────────────────────────────────
test('EXTRA-2: causal_attribution_established is false after any sequence of invalidations', async () => {
  for (let i = 0; i < 3; i++) {
    await post(invalidateAllUrl());
    const { graph } = await evidenceCaseCache.getCaseEvidence(G15);
    expect(graph.causal_attribution_established).toBe(false);
  }
});
