'use strict';

/**
 * Phase 10.3.3-A — In-Flight Evidence Cache Deduplication — CONC Tests
 *
 * Verifies that concurrent cold-load requests for the same caseId share
 * exactly one underlying parseEvidenceCSV + buildEvidenceGraph operation.
 *
 * Required coverage per spec:
 *   CONC-1   5 concurrent calls → exactly 1 parse + 1 graph build
 *   CONC-2   All 5 callers receive structurally equivalent results
 *   CONC-3   Cache contains exactly one entry after completion
 *   CONC-4   inFlight === 0 after successful completion
 *   CONC-5   Parse failure propagated to all concurrent callers
 *   CONC-6   Graph-build failure propagated to all concurrent callers
 *   CONC-7   After failure: cache size = 0, inFlight = 0; retry succeeds
 *   CONC-8   Concurrent requests for different case IDs are independent
 *   CONC-9   Concurrent cold load followed by warm request skips parse/build
 *   CONC-10  Explicit invalidateCase after completed load leaves no stale _inFlight
 */

const serverModule      = require('../server');
const evidenceCaseCache = require('../services/evidenceCaseCache');

const G15  = 'galaxy-15';
const TCA  = 'test-case-alpha';
const GS17 = 'goes16-sep2017';

beforeEach(() => {
  evidenceCaseCache._reset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// CONC-1 — 5 simultaneous calls → exactly 1 parseEvidenceCSV + 1 buildEvidenceGraph
// ─────────────────────────────────────────────────────────────────────────────
test('CONC-1: five simultaneous cold-load calls execute exactly one parse and one graph build', async () => {
  const parseSpy = jest.spyOn(serverModule, 'parseEvidenceCSV');
  const graphSpy = jest.spyOn(serverModule, 'buildEvidenceGraph');

  await Promise.all([
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
  ]);

  expect(parseSpy).toHaveBeenCalledTimes(1);
  expect(graphSpy).toHaveBeenCalledTimes(1);
});

// ─────────────────────────────────────────────────────────────────────────────
// CONC-2 — All 5 callers receive structurally equivalent results
// ─────────────────────────────────────────────────────────────────────────────
test('CONC-2: all five concurrent callers receive structurally equivalent results', async () => {
  const results = await Promise.all([
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
  ]);

  // All graphs must reference the correct case and preserve forensic invariants.
  for (const { graph } of results) {
    expect(graph.case_id).toBe(G15);
    expect(graph.causal_attribution_established).toBe(false);
  }

  // All row arrays must have identical length.
  const rowCounts = results.map(r => r.rows.length);
  expect(new Set(rowCounts).size).toBe(1);

  // All hypothesis arrays must have identical length.
  const hypCounts = results.map(r => r.graph.hypotheses.length);
  expect(new Set(hypCounts).size).toBe(1);

  // Each caller receives a distinct rows array (CD-1: slice on every return).
  const rowArrays = results.map(r => r.rows);
  for (let i = 0; i < rowArrays.length; i++) {
    for (let j = i + 1; j < rowArrays.length; j++) {
      expect(rowArrays[i]).not.toBe(rowArrays[j]);
    }
  }

  // But all graph references are the same frozen object (shared from cache).
  for (let i = 1; i < results.length; i++) {
    expect(results[i].graph).toBe(results[0].graph);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CONC-3 — Cache contains exactly one entry after completion
// ─────────────────────────────────────────────────────────────────────────────
test('CONC-3: cache contains exactly one entry after concurrent cold load completes', async () => {
  await Promise.all([
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
  ]);

  expect(evidenceCaseCache.getStats().size).toBe(1);
  expect(evidenceCaseCache.has(G15)).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// CONC-4 — inFlight === 0 after successful completion
// ─────────────────────────────────────────────────────────────────────────────
test('CONC-4: inFlight is 0 after all concurrent loads complete successfully', async () => {
  await Promise.all([
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
  ]);

  expect(evidenceCaseCache.getStats().inFlight).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// CONC-5 — Parse failure propagated to all concurrent callers
// ─────────────────────────────────────────────────────────────────────────────
test('CONC-5: parse failure is propagated to all five concurrent callers', async () => {
  const parseError = { status: 500, message: 'Simulated concurrent parse error' };
  jest.spyOn(serverModule, 'parseEvidenceCSV').mockRejectedValue(parseError);

  const results = await Promise.allSettled([
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
  ]);

  // Every caller must receive a rejection.
  for (const result of results) {
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatchObject({ status: 500 });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CONC-6 — Graph-build failure propagated to all concurrent callers
// ─────────────────────────────────────────────────────────────────────────────
test('CONC-6: graph-build failure is propagated to all five concurrent callers', async () => {
  const graphError = new Error('Simulated concurrent graph build error');
  jest.spyOn(serverModule, 'buildEvidenceGraph').mockRejectedValue(graphError);

  const results = await Promise.allSettled([
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
  ]);

  // Every caller must receive a rejection.
  for (const result of results) {
    expect(result.status).toBe('rejected');
    expect(result.reason.message).toBe('Simulated concurrent graph build error');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CONC-7 — After failure: cache size = 0, inFlight = 0; subsequent call retries
// ─────────────────────────────────────────────────────────────────────────────
test('CONC-7: after failure cache size = 0 and inFlight = 0, and a retry succeeds', async () => {
  // 1. Inject a parse failure using a real async rejection so all concurrent
  //    callers properly join the in-flight before it settles.
  //    Using a setImmediate-deferred rejection guarantees the in-flight entry
  //    is visible to all callers before the Promise rejects.
  const parseError = { status: 500, message: 'Transient parse error' };
  const parseSpy = jest.spyOn(serverModule, 'parseEvidenceCSV').mockImplementation(
    () => new Promise((_, reject) => setImmediate(() => reject(parseError)))
  );

  const results = await Promise.allSettled([
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
  ]);

  // All three must be rejected.
  for (const r of results) {
    expect(r.status).toBe('rejected');
    expect(r.reason).toMatchObject({ status: 500 });
  }

  // 2. After failure: cache is empty, nothing in-flight.
  const statsAfterFailure = evidenceCaseCache.getStats();
  expect(statsAfterFailure.size).toBe(0);
  expect(statsAfterFailure.inFlight).toBe(0);

  // 3. Restore the spy so the real implementation is used on retry.
  parseSpy.mockRestore();

  // 4. Retry must succeed — the failed load must not leave a stale in-flight entry.
  const { graph } = await evidenceCaseCache.getCaseEvidence(G15);
  expect(graph.case_id).toBe(G15);
  expect(evidenceCaseCache.getStats().size).toBe(1);
  expect(evidenceCaseCache.getStats().inFlight).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// CONC-8 — Concurrent requests for different case IDs are independent
// ─────────────────────────────────────────────────────────────────────────────
test('CONC-8: concurrent cold loads for different cases are independent — one parse+build each', async () => {
  const parseSpy = jest.spyOn(serverModule, 'parseEvidenceCSV');
  const graphSpy = jest.spyOn(serverModule, 'buildEvidenceGraph');

  // Fire concurrent loads for three distinct cases: G15, TCA, GS17.
  const [g15, tca, gs17] = await Promise.all([
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(TCA),
    evidenceCaseCache.getCaseEvidence(GS17),
  ]);

  // Three cases — three separate cold loads.
  expect(parseSpy).toHaveBeenCalledTimes(3);
  expect(graphSpy).toHaveBeenCalledTimes(3);

  // Each case has the correct identity.
  expect(g15.graph.case_id).toBe(G15);
  expect(tca.graph.case_id).toBe(TCA);
  expect(gs17.graph.case_id).toBe(GS17);

  // Three cache entries.
  expect(evidenceCaseCache.getStats().size).toBe(3);

  // No cross-case evidence ID bleed.
  const g15Ids  = new Set(g15.rows.map(r => r.evidence_id));
  const tcaIds  = new Set(tca.rows.map(r => r.evidence_id));
  const gs17Ids = new Set(gs17.rows.map(r => r.evidence_id));

  for (const id of g15Ids)  { expect(tcaIds.has(id)).toBe(false);  expect(gs17Ids.has(id)).toBe(false); }
  for (const id of tcaIds)  { expect(g15Ids.has(id)).toBe(false);  expect(gs17Ids.has(id)).toBe(false); }
  for (const id of gs17Ids) { expect(g15Ids.has(id)).toBe(false);  expect(tcaIds.has(id)).toBe(false);  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CONC-9 — Concurrent cold load followed by warm request does not re-parse/build
// ─────────────────────────────────────────────────────────────────────────────
test('CONC-9: warm request after concurrent cold load does not trigger another parse or graph build', async () => {
  // Cold concurrent load — one parse + one build.
  await Promise.all([
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
  ]);

  // Now instrument the spies AFTER the cold load so any subsequent call is recorded.
  const parseSpy = jest.spyOn(serverModule, 'parseEvidenceCSV');
  const graphSpy = jest.spyOn(serverModule, 'buildEvidenceGraph');

  // Warm request.
  const { graph } = await evidenceCaseCache.getCaseEvidence(G15);

  expect(parseSpy).not.toHaveBeenCalled();
  expect(graphSpy).not.toHaveBeenCalled();

  // Warm hit counter reflects the warm request.
  expect(evidenceCaseCache.getStats().hits).toBeGreaterThanOrEqual(1);

  // Forensic invariants preserved through the warm path.
  expect(graph.case_id).toBe(G15);
  expect(graph.causal_attribution_established).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// CONC-10 — invalidateCase after completed load leaves no stale _inFlight state
// ─────────────────────────────────────────────────────────────────────────────
test('CONC-10: invalidateCase after a completed load leaves inFlight = 0 and the cache clear', async () => {
  // Complete a full concurrent load.
  await Promise.all([
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
  ]);

  expect(evidenceCaseCache.getStats().size).toBe(1);
  expect(evidenceCaseCache.getStats().inFlight).toBe(0);

  // Explicit invalidation.
  evidenceCaseCache.invalidateCase(G15);

  // Cache cleared, nothing stuck in-flight.
  expect(evidenceCaseCache.has(G15)).toBe(false);
  expect(evidenceCaseCache.getStats().size).toBe(0);
  expect(evidenceCaseCache.getStats().inFlight).toBe(0);
  expect(evidenceCaseCache.getStats().invalidations).toBeGreaterThanOrEqual(1);

  // A fresh load after invalidation must succeed — no zombie in-flight entry.
  const parseSpy = jest.spyOn(serverModule, 'parseEvidenceCSV');
  const { graph } = await evidenceCaseCache.getCaseEvidence(G15);

  expect(graph.case_id).toBe(G15);
  expect(parseSpy).toHaveBeenCalledTimes(1); // one fresh cold load
  expect(evidenceCaseCache.getStats().size).toBe(1);
  expect(evidenceCaseCache.getStats().inFlight).toBe(0);
});
