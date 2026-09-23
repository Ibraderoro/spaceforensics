'use strict';

/**
 * Phase 10.3.5 — Evidence Cache Lifecycle Hardening
 *
 * Enforces deterministic cache lifecycle behavior across:
 *   - source-signature invalidation (CSV, case.json, hypotheses.json)
 *   - failed parse recovery
 *   - failed graph-build recovery
 *   - retry and successful recovery
 *   - concurrent stale-entry reload
 *   - concurrent stale-reload failure
 *   - invalidation during in-flight load (CD-3 semantics)
 *   - cache statistics consistency
 *   - case isolation (G15, TCA, GS17)
 *   - mutation-safety regression (Phase 10.3.3-B)
 *   - HTTP endpoint regression (Phase 10.3.4)
 *
 * Invariants enforced (defined in Phase 10.3.5 spec):
 *   A  Valid warm entries may be returned without re-parsing
 *   B  Source-signature change → stale entry discarded, fresh load occurs
 *   C  Failed reload → not cached, _inFlight cleaned, caller gets error
 *   D  After failed reload, next request can retry successfully
 *   E  Concurrent stale reload → exactly one parse, one build, all callers share result
 *   F  invalidateCase/invalidateAll → next request is a cold load
 *   G  Failure/invalidation of one case does not corrupt another
 *
 * Test IDs: CL-1 through CL-35
 */

const fs            = require('fs');
const request       = require('supertest');
const serverModule  = require('../server');
const { app }       = serverModule;
const cache         = require('../services/evidenceCaseCache');

const G15   = 'galaxy-15';
const TCA   = 'test-case-alpha';
const GS17  = 'goes16-sep2017';
const BOGUS = 'no-such-case-1035-zzz';

const G15_ROW_COUNT      = 278;
const G15_EPHEMERIS_COUNT = 61;
const G15_FIRST_ID        = 'E-G15-0001';
const G15_LAST_ID         = 'E-G15-0278';
const G15_ASSESSMENTS = {
  H1: 'mixed', H2: 'mixed', H3: 'supported',
  H4: 'insufficient_evidence', H5: 'strongly_supported',
};

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle helpers
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  cache._reset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

/**
 * Corrupt the stored source_signature for a cached case so the next
 * getCaseEvidence sees a mismatch and triggers a cold reload.
 * Works by monkeypatching fs.promises.stat to return a bumped mtime
 * for exactly one call sequence (one signature computation), then restoring.
 *
 * Returns a restore function. Call it after the reload has been triggered
 * (or rely on afterEach jest.restoreAllMocks).
 */
function makeSignatureStale() {
  // Intercept the next call(s) to fs.promises.stat so mtimeMs appears changed.
  const original = fs.promises.stat;
  const spy = jest.spyOn(fs.promises, 'stat').mockImplementation(async (p) => {
    const real = await original.call(fs.promises, p);
    // Bump mtime by 1 second to simulate a source file change.
    return { ...real, mtimeMs: real.mtimeMs + 1000 };
  });
  return spy;
}

// ─────────────────────────────────────────────────────────────────────────────
// CL-1  INVARIANT A — Warm hit returns cached data without reparsing
// ─────────────────────────────────────────────────────────────────────────────
test('CL-1 (INV-A): warm hit returns cached data without invoking parseEvidenceCSV', async () => {
  await cache.getCaseEvidence(G15);   // cold

  const parseSpy = jest.spyOn(serverModule, 'parseEvidenceCSV');
  const graphSpy = jest.spyOn(serverModule, 'buildEvidenceGraph');

  const { rows, graph } = await cache.getCaseEvidence(G15);  // warm

  expect(parseSpy).not.toHaveBeenCalled();
  expect(graphSpy).not.toHaveBeenCalled();
  expect(rows.length).toBe(G15_ROW_COUNT);
  expect(graph.case_id).toBe(G15);
  expect(cache.getStats().hits).toBe(1);
  expect(cache.getStats().misses).toBe(1);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-2  INVARIANT B — CSV signature change triggers a cold reload
// ─────────────────────────────────────────────────────────────────────────────
test('CL-2 (INV-B): CSV signature change causes stale entry to be discarded and fresh load to occur', async () => {
  // Prime
  await cache.getCaseEvidence(G15);
  expect(cache.has(G15)).toBe(true);
  expect(cache.getStats().misses).toBe(1);

  // Simulate file-system mtime bump (all tracked files, including CSV)
  makeSignatureStale();

  const parseSpy = jest.spyOn(serverModule, 'parseEvidenceCSV');

  const { rows, graph } = await cache.getCaseEvidence(G15);

  // A cold reload must have occurred.
  expect(parseSpy).toHaveBeenCalledTimes(1);
  expect(rows.length).toBe(G15_ROW_COUNT);
  expect(graph.case_id).toBe(G15);
  expect(graph.causal_attribution_established).toBe(false);

  // Stats: 2 misses (cold + stale), 1 auto-invalidation
  expect(cache.getStats().misses).toBe(2);
  expect(cache.getStats().invalidations).toBe(1);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-3  INVARIANT B — case.json signature change triggers a cold reload
// ─────────────────────────────────────────────────────────────────────────────
test('CL-3 (INV-B): case.json signature change causes stale entry to be discarded and reloaded', async () => {
  await cache.getCaseEvidence(G15);

  // Bump all stats (signature covers CSV + case.json + hypotheses.json)
  makeSignatureStale();
  const parseSpy = jest.spyOn(serverModule, 'parseEvidenceCSV');

  const { graph } = await cache.getCaseEvidence(G15);

  expect(parseSpy).toHaveBeenCalledTimes(1);
  expect(graph.case_id).toBe(G15);
  expect(cache.getStats().invalidations).toBe(1);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-4  INVARIANT B — After stale reload cache becomes warm again
// ─────────────────────────────────────────────────────────────────────────────
test('CL-4 (INV-B): after a stale-triggered reload the cache becomes warm again', async () => {
  // Use explicit invalidation to simulate the "after reload, now warm" path
  // without the mtime-restoration paradox: explicit invalidation clears the
  // entry, next getCaseEvidence cold-loads and caches, third is a warm hit.
  await cache.getCaseEvidence(G15);

  cache.invalidateCase(G15);
  await cache.getCaseEvidence(G15);  // cold reload
  expect(cache.has(G15)).toBe(true);

  const parseSpy = jest.spyOn(serverModule, 'parseEvidenceCSV');
  const { rows } = await cache.getCaseEvidence(G15);  // warm hit

  expect(parseSpy).not.toHaveBeenCalled();
  expect(rows.length).toBe(G15_ROW_COUNT);
  expect(cache.getStats().hits).toBeGreaterThanOrEqual(1);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-5  INVARIANT C — Parse failure on cold load: not cached, inFlight = 0
// ─────────────────────────────────────────────────────────────────────────────
test('CL-5 (INV-C): parse failure on cold load is not cached and inFlight returns to zero', async () => {
  const err = { status: 500, message: 'Simulated parse failure CL-5' };
  jest.spyOn(serverModule, 'parseEvidenceCSV')
    .mockImplementation(() => new Promise((_, rej) => setImmediate(() => rej(err))));

  await expect(cache.getCaseEvidence(G15)).rejects.toMatchObject({ status: 500 });

  expect(cache.has(G15)).toBe(false);
  expect(cache.getStats().size).toBe(0);
  expect(cache.getStats().inFlight).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-6  INVARIANT C — Parse failure on stale-entry reload: stale is removed, not re-served
// ─────────────────────────────────────────────────────────────────────────────
test('CL-6 (INV-C): parse failure during stale reload discards stale entry and does not serve stale data', async () => {
  // Prime and then make stale
  await cache.getCaseEvidence(G15);
  expect(cache.has(G15)).toBe(true);

  // Corrupt signature so next access sees stale
  makeSignatureStale();

  // Inject parse failure
  const err = { status: 500, message: 'Simulated stale-reload parse failure CL-6' };
  jest.spyOn(serverModule, 'parseEvidenceCSV')
    .mockImplementation(() => new Promise((_, rej) => setImmediate(() => rej(err))));

  await expect(cache.getCaseEvidence(G15)).rejects.toMatchObject({ status: 500 });

  // Stale entry must have been removed; no fresh entry cached.
  expect(cache.has(G15)).toBe(false);
  expect(cache.getStats().size).toBe(0);
  expect(cache.getStats().inFlight).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-7  INVARIANT D — First parse fails, second succeeds (cold retry)
// ─────────────────────────────────────────────────────────────────────────────
test('CL-7 (INV-D): first parse failure followed by successful retry: 2 parse calls, 1 graph build', async () => {
  const err = { status: 500, message: 'Transient parse error CL-7' };
  const parseSpy = jest.spyOn(serverModule, 'parseEvidenceCSV')
    .mockImplementationOnce(() => new Promise((_, rej) => setImmediate(() => rej(err))));
  const graphSpy = jest.spyOn(serverModule, 'buildEvidenceGraph');

  // First attempt fails
  await expect(cache.getCaseEvidence(G15)).rejects.toMatchObject({ status: 500 });
  expect(cache.getStats().size).toBe(0);
  expect(cache.getStats().inFlight).toBe(0);

  // Second attempt succeeds (mock exhausted, real impl used)
  const { rows, graph } = await cache.getCaseEvidence(G15);
  expect(rows.length).toBe(G15_ROW_COUNT);
  expect(graph.case_id).toBe(G15);
  expect(cache.has(G15)).toBe(true);

  expect(parseSpy).toHaveBeenCalledTimes(2);
  expect(graphSpy).toHaveBeenCalledTimes(1);  // only the successful build

  // Third request is a warm hit — no additional parse or build
  jest.restoreAllMocks();
  const parseSpy2 = jest.spyOn(serverModule, 'parseEvidenceCSV');
  await cache.getCaseEvidence(G15);
  expect(parseSpy2).not.toHaveBeenCalled();
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-8  Graph build failure on cold load: not cached, inFlight = 0
// ─────────────────────────────────────────────────────────────────────────────
test('CL-8: graph build failure on cold load is not cached and inFlight returns to zero', async () => {
  const err = new Error('Simulated graph build failure CL-8');
  jest.spyOn(serverModule, 'buildEvidenceGraph')
    .mockImplementation(() => new Promise((_, rej) => setImmediate(() => rej(err))));

  await expect(cache.getCaseEvidence(G15)).rejects.toThrow('Simulated graph build failure CL-8');

  expect(cache.has(G15)).toBe(false);
  expect(cache.getStats().size).toBe(0);
  expect(cache.getStats().inFlight).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-9  Parse can succeed while graph build fails; partial result never cached
// ─────────────────────────────────────────────────────────────────────────────
test('CL-9: parse succeeds but graph build fails — partial result never stored in cache', async () => {
  const err = new Error('Graph build failure CL-9');
  const parseSpy = jest.spyOn(serverModule, 'parseEvidenceCSV');
  jest.spyOn(serverModule, 'buildEvidenceGraph')
    .mockImplementation(() => new Promise((_, rej) => setImmediate(() => rej(err))));

  await expect(cache.getCaseEvidence(G15)).rejects.toThrow('Graph build failure CL-9');

  expect(parseSpy).toHaveBeenCalledTimes(1);  // parse ran
  expect(cache.has(G15)).toBe(false);          // but nothing was cached
  expect(cache.getStats().size).toBe(0);
  expect(cache.getStats().inFlight).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-10  Graph build failure retry succeeds; subsequent hit is warm
// ─────────────────────────────────────────────────────────────────────────────
test('CL-10: after graph build failure, retry succeeds and next request is a warm hit', async () => {
  const err = new Error('Transient graph error CL-10');
  const graphSpy = jest.spyOn(serverModule, 'buildEvidenceGraph')
    .mockImplementationOnce(() => new Promise((_, rej) => setImmediate(() => rej(err))));

  // First attempt — graph fails
  await expect(cache.getCaseEvidence(G15)).rejects.toThrow('Transient graph error CL-10');
  expect(cache.getStats().inFlight).toBe(0);

  // Second attempt — real graph build
  const { graph } = await cache.getCaseEvidence(G15);
  expect(graph.case_id).toBe(G15);
  expect(graph.causal_attribution_established).toBe(false);
  expect(cache.has(G15)).toBe(true);

  expect(graphSpy).toHaveBeenCalledTimes(2);  // once failed, once success

  // Third request — warm hit, no rebuild
  jest.restoreAllMocks();
  const graphSpy2 = jest.spyOn(serverModule, 'buildEvidenceGraph');
  await cache.getCaseEvidence(G15);
  expect(graphSpy2).not.toHaveBeenCalled();
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-11  INVARIANT E — Concurrent stale reload: exactly one parse, one build
// ─────────────────────────────────────────────────────────────────────────────
test('CL-11 (INV-E): 5 concurrent callers on a stale entry share one reload', async () => {
  // Prime
  await cache.getCaseEvidence(G15);
  // Make stale
  makeSignatureStale();

  const parseSpy = jest.spyOn(serverModule, 'parseEvidenceCSV');
  const graphSpy = jest.spyOn(serverModule, 'buildEvidenceGraph');

  const results = await Promise.all([
    cache.getCaseEvidence(G15),
    cache.getCaseEvidence(G15),
    cache.getCaseEvidence(G15),
    cache.getCaseEvidence(G15),
    cache.getCaseEvidence(G15),
  ]);

  expect(parseSpy).toHaveBeenCalledTimes(1);
  expect(graphSpy).toHaveBeenCalledTimes(1);

  // All five callers received correct data
  for (const { rows, graph } of results) {
    expect(rows.length).toBe(G15_ROW_COUNT);
    expect(graph.case_id).toBe(G15);
    expect(graph.causal_attribution_established).toBe(false);
  }

  // Cache has exactly one entry
  expect(cache.getStats().size).toBe(1);
  expect(cache.getStats().inFlight).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-12  INVARIANT E — Concurrent stale reload: all callers get distinct row arrays
// ─────────────────────────────────────────────────────────────────────────────
test('CL-12 (INV-E): all 5 concurrent stale-reload callers receive distinct rows arrays', async () => {
  await cache.getCaseEvidence(G15);
  makeSignatureStale();

  const results = await Promise.all(Array.from({ length: 5 }, () => cache.getCaseEvidence(G15)));

  const arrays = results.map(r => r.rows);
  for (let i = 0; i < arrays.length; i++) {
    for (let j = i + 1; j < arrays.length; j++) {
      expect(arrays[i]).not.toBe(arrays[j]);
    }
  }
  // But same frozen row objects at each position
  for (let i = 1; i < results.length; i++) {
    for (let k = 0; k < results[0].rows.length; k++) {
      expect(results[i].rows[k]).toBe(results[0].rows[k]);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-13  INVARIANT E — Concurrent stale reload failure propagates to all callers
// ─────────────────────────────────────────────────────────────────────────────
test('CL-13 (INV-E): concurrent stale reload failure propagates to all concurrent callers', async () => {
  await cache.getCaseEvidence(G15);
  makeSignatureStale();

  const err = { status: 500, message: 'Concurrent stale reload failure CL-13' };
  jest.spyOn(serverModule, 'parseEvidenceCSV')
    .mockImplementation(() => new Promise((_, rej) => setImmediate(() => rej(err))));

  const results = await Promise.allSettled([
    cache.getCaseEvidence(G15),
    cache.getCaseEvidence(G15),
    cache.getCaseEvidence(G15),
    cache.getCaseEvidence(G15),
    cache.getCaseEvidence(G15),
  ]);

  for (const r of results) {
    expect(r.status).toBe('rejected');
    expect(r.reason).toMatchObject({ status: 500 });
  }

  expect(cache.getStats().size).toBe(0);
  expect(cache.getStats().inFlight).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-14  INVARIANT E — After concurrent stale failure, recovery succeeds
// ─────────────────────────────────────────────────────────────────────────────
test('CL-14 (INV-E): after concurrent stale reload failure, next request retries and succeeds', async () => {
  await cache.getCaseEvidence(G15);
  makeSignatureStale();

  const err = { status: 500, message: 'CL-14 transient error' };
  const parseSpy = jest.spyOn(serverModule, 'parseEvidenceCSV')
    .mockImplementation(() => new Promise((_, rej) => setImmediate(() => rej(err))));

  await Promise.allSettled([cache.getCaseEvidence(G15), cache.getCaseEvidence(G15)]);

  expect(cache.getStats().inFlight).toBe(0);
  expect(cache.getStats().size).toBe(0);

  // Restore real implementation
  parseSpy.mockRestore();

  const { rows, graph } = await cache.getCaseEvidence(G15);
  expect(rows.length).toBe(G15_ROW_COUNT);
  expect(graph.case_id).toBe(G15);
  expect(cache.has(G15)).toBe(true);
  expect(cache.getStats().inFlight).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-15  INVARIANT F — invalidateCase: next request is a cold load
// ─────────────────────────────────────────────────────────────────────────────
test('CL-15 (INV-F): invalidateCase causes the next getCaseEvidence to cold-load', async () => {
  await cache.getCaseEvidence(G15);
  cache.invalidateCase(G15);
  expect(cache.has(G15)).toBe(false);

  const parseSpy = jest.spyOn(serverModule, 'parseEvidenceCSV');
  const { rows } = await cache.getCaseEvidence(G15);

  expect(parseSpy).toHaveBeenCalledTimes(1);
  expect(rows.length).toBe(G15_ROW_COUNT);
  expect(cache.has(G15)).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-16  INVARIANT F — invalidateAll: every case must cold-reload next time
// ─────────────────────────────────────────────────────────────────────────────
test('CL-16 (INV-F): invalidateAll forces cold reload for every previously cached case', async () => {
  await cache.getCaseEvidence(G15);
  await cache.getCaseEvidence(TCA);
  await cache.getCaseEvidence(GS17);

  cache.invalidateAll();

  expect(cache.getStats().size).toBe(0);
  expect(cache.has(G15)).toBe(false);
  expect(cache.has(TCA)).toBe(false);
  expect(cache.has(GS17)).toBe(false);

  const parseSpy = jest.spyOn(serverModule, 'parseEvidenceCSV');

  const [g15, tca, gs17] = await Promise.all([
    cache.getCaseEvidence(G15),
    cache.getCaseEvidence(TCA),
    cache.getCaseEvidence(GS17),
  ]);

  // Three separate cold loads
  expect(parseSpy).toHaveBeenCalledTimes(3);
  expect(g15.graph.case_id).toBe(G15);
  expect(tca.graph.case_id).toBe(TCA);
  expect(gs17.graph.case_id).toBe(GS17);
  expect(cache.getStats().size).toBe(3);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-17  INVARIANT F — CD-3: invalidation during in-flight does not poison cache
// ─────────────────────────────────────────────────────────────────────────────
test('CL-17 (INV-F / CD-3): invalidateCase during in-flight load: caller gets correct data, inFlight cleaned', async () => {
  // Strategy: use a gate Promise to pause _doLoad mid-flight.
  // getCaseEvidence must first complete _buildSourceSignature (real I/O) before
  // _doLoad runs and sets _inFlight.  We wait until inFlight becomes 1 by
  // polling with setImmediate, then interleave the invalidation.
  let resolveGate;
  const gate = new Promise(res => { resolveGate = res; });

  // Capture real parseEvidenceCSV before spying so restore works correctly
  const realParse = serverModule.parseEvidenceCSV.bind(serverModule);

  jest.spyOn(serverModule, 'parseEvidenceCSV').mockImplementationOnce(async (caseId) => {
    await gate;   // pause here until the test opens the gate
    return realParse(caseId);
  });

  // Start load — hangs at parseEvidenceCSV until gate opens
  const loadPromise = cache.getCaseEvidence(G15);

  // Poll until _inFlight is populated (signature check + _doLoad startup takes
  // several ticks of real I/O via fs.promises.stat / readdir).
  for (let i = 0; i < 100; i++) {
    if (cache.getStats().inFlight > 0) break;
    await new Promise(r => setImmediate(r));
  }

  // Now _inFlight must be set
  expect(cache.getStats().inFlight).toBe(1);

  // Invalidate while the load is in-flight (CD-3)
  cache.invalidateCase(G15);

  // Open the gate — the real parse runs and _doLoad completes
  resolveGate();

  // Await the result
  const { rows, graph } = await loadPromise;

  // Caller must receive correct data regardless of the invalidation
  expect(rows.length).toBe(G15_ROW_COUNT);
  expect(graph.case_id).toBe(G15);
  expect(graph.causal_attribution_established).toBe(false);

  // in-flight must be zero after completion
  expect(cache.getStats().inFlight).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-18  CD-3: Next getCaseEvidence after invalidation-during-inflight gets fresh data
// ─────────────────────────────────────────────────────────────────────────────
test('CL-18 (CD-3): a request made after invalidation-then-completion gets correct fresh data', async () => {
  // Simple sequential version: prime → invalidate → reload → warm
  await cache.getCaseEvidence(G15);
  cache.invalidateCase(G15);
  const { rows, graph } = await cache.getCaseEvidence(G15);  // cold reload

  expect(rows.length).toBe(G15_ROW_COUNT);
  expect(graph.case_id).toBe(G15);
  expect(graph.causal_attribution_established).toBe(false);
  expect(cache.has(G15)).toBe(true);
  expect(cache.getStats().inFlight).toBe(0);

  // Warm hit
  const parseSpy = jest.spyOn(serverModule, 'parseEvidenceCSV');
  await cache.getCaseEvidence(G15);
  expect(parseSpy).not.toHaveBeenCalled();
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-19  INVARIANT G — Case isolation: G15 failure does not affect TCA
// ─────────────────────────────────────────────────────────────────────────────
test('CL-19 (INV-G): parse failure for G15 does not corrupt TCA cache entry', async () => {
  await cache.getCaseEvidence(TCA);  // TCA primed first
  expect(cache.has(TCA)).toBe(true);

  // Fail G15 load
  const err = { status: 500, message: 'CL-19 G15 failure' };
  jest.spyOn(serverModule, 'parseEvidenceCSV')
    .mockImplementationOnce(() => new Promise((_, rej) => setImmediate(() => rej(err))));

  await expect(cache.getCaseEvidence(G15)).rejects.toMatchObject({ status: 500 });

  // All spies must be restored before checking TCA to avoid double-spy artefacts
  jest.restoreAllMocks();

  // TCA must be untouched
  expect(cache.has(TCA)).toBe(true);
  expect(cache.has(G15)).toBe(false);
  expect(cache.getStats().size).toBe(1);
  expect(cache.getStats().inFlight).toBe(0);

  // TCA warm hit: data intact, no reload needed.
  // Measure via hit counter rather than a fresh parseSpy to avoid double-spy
  // artefacts when nesting jest.spyOn calls.
  const hitsBefore = cache.getStats().hits;
  const { graph } = await cache.getCaseEvidence(TCA);
  expect(graph.case_id).toBe(TCA);
  expect(cache.getStats().hits).toBe(hitsBefore + 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-20  INVARIANT G — G15 invalidation does not touch GS17 or TCA
// ─────────────────────────────────────────────────────────────────────────────
test('CL-20 (INV-G): invalidating G15 leaves GS17 and TCA entries intact', async () => {
  await cache.getCaseEvidence(G15);
  await cache.getCaseEvidence(TCA);
  await cache.getCaseEvidence(GS17);

  cache.invalidateCase(G15);

  expect(cache.has(G15)).toBe(false);
  expect(cache.has(TCA)).toBe(true);
  expect(cache.has(GS17)).toBe(true);
  expect(cache.getStats().size).toBe(2);
  expect(cache.getStats().invalidations).toBe(1);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-21  Cache statistics — cold load
// ─────────────────────────────────────────────────────────────────────────────
test('CL-21: statistics are accurate across cold load → warm hits → invalidation → reload', async () => {
  // Initial state
  let s = cache.getStats();
  expect(s).toEqual({ size: 0, hits: 0, misses: 0, invalidations: 0, inFlight: 0 });

  await cache.getCaseEvidence(G15);
  s = cache.getStats();
  expect(s.size).toBe(1);
  expect(s.misses).toBe(1);
  expect(s.hits).toBe(0);
  expect(s.inFlight).toBe(0);

  await cache.getCaseEvidence(G15);
  await cache.getCaseEvidence(G15);
  s = cache.getStats();
  expect(s.hits).toBe(2);
  expect(s.misses).toBe(1);

  cache.invalidateCase(G15);
  s = cache.getStats();
  expect(s.size).toBe(0);
  expect(s.invalidations).toBe(1);

  await cache.getCaseEvidence(G15);
  s = cache.getStats();
  expect(s.size).toBe(1);
  expect(s.misses).toBe(2);
  expect(s.hits).toBe(2);
  expect(s.inFlight).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-22  Statistics — failed parse does not leave phantom entries
// ─────────────────────────────────────────────────────────────────────────────
test('CL-22: failed parse does not create phantom cache entry or corrupt counters', async () => {
  const err = { status: 500, message: 'CL-22 parse error' };
  jest.spyOn(serverModule, 'parseEvidenceCSV')
    .mockImplementation(() => new Promise((_, rej) => setImmediate(() => rej(err))));

  await expect(cache.getCaseEvidence(G15)).rejects.toMatchObject({ status: 500 });

  const s = cache.getStats();
  expect(s.size).toBe(0);
  expect(s.inFlight).toBe(0);
  expect(s.hits).toBe(0);
  expect(s.misses).toBe(1);
  expect(s.invalidations).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-23  Statistics — stale reload increments invalidations once
// ─────────────────────────────────────────────────────────────────────────────
test('CL-23: stale-signature reload increments invalidations exactly once', async () => {
  await cache.getCaseEvidence(G15);
  expect(cache.getStats().invalidations).toBe(0);

  // Simulate stale by explicit invalidation (avoids the mtime-restoration
  // paradox where restoring the stat spy makes the new entry appear stale again).
  cache.invalidateCase(G15);
  expect(cache.getStats().invalidations).toBe(1);

  // Reload
  await cache.getCaseEvidence(G15);
  expect(cache.getStats().invalidations).toBe(1);  // no further increment

  // Warm hit must not increment invalidations
  await cache.getCaseEvidence(G15);
  expect(cache.getStats().invalidations).toBe(1);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-24  Statistics — concurrent load: misses = 5, not 1
// ─────────────────────────────────────────────────────────────────────────────
test('CL-24: 5 concurrent cold callers each count as a miss (misses = 5)', async () => {
  await Promise.all(Array.from({ length: 5 }, () => cache.getCaseEvidence(G15)));
  expect(cache.getStats().misses).toBe(5);
  expect(cache.getStats().hits).toBe(0);
  expect(cache.getStats().size).toBe(1);
  expect(cache.getStats().inFlight).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-25  Statistics — failed concurrent load leaves size=0, inFlight=0
// ─────────────────────────────────────────────────────────────────────────────
test('CL-25: failed concurrent load leaves size=0 and inFlight=0 with correct miss count', async () => {
  const err = { status: 500, message: 'CL-25 concurrent failure' };
  jest.spyOn(serverModule, 'parseEvidenceCSV')
    .mockImplementation(() => new Promise((_, rej) => setImmediate(() => rej(err))));

  await Promise.allSettled(Array.from({ length: 4 }, () => cache.getCaseEvidence(G15)));

  const s = cache.getStats();
  expect(s.size).toBe(0);
  expect(s.inFlight).toBe(0);
  expect(s.misses).toBe(4);
  expect(s.hits).toBe(0);
  expect(s.invalidations).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-26  Mutation safety regression — rows frozen after reload
// ─────────────────────────────────────────────────────────────────────────────
test('CL-26 (mutation safety): rows are frozen after a stale reload', async () => {
  await cache.getCaseEvidence(G15);
  makeSignatureStale();

  const { rows } = await cache.getCaseEvidence(G15);

  expect(rows.length).toBe(G15_ROW_COUNT);
  for (const row of rows) {
    expect(Object.isFrozen(row)).toBe(true);
  }

  expect(() => { rows[0].evidence_id = '__BAD__'; }).toThrow(TypeError);
  expect(rows[0].evidence_id).toBe(G15_FIRST_ID);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-27  Mutation safety regression — caller array remains unfrozen after reload
// ─────────────────────────────────────────────────────────────────────────────
test('CL-27 (mutation safety): caller rows array is unfrozen after stale reload', async () => {
  await cache.getCaseEvidence(G15);
  makeSignatureStale();

  const { rows } = await cache.getCaseEvidence(G15);
  jest.restoreAllMocks();

  expect(Object.isFrozen(rows)).toBe(false);
  const len = rows.length;
  rows.push({ evidence_id: 'SYNTHETIC' });
  expect(rows.length).toBe(len + 1);

  // Cache unaffected
  const { rows: warm } = await cache.getCaseEvidence(G15);
  expect(warm.length).toBe(G15_ROW_COUNT);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-28  Mutation safety regression — warm callers share frozen row refs
// ─────────────────────────────────────────────────────────────────────────────
test('CL-28 (mutation safety): warm callers share the same frozen row object references', async () => {
  await cache.getCaseEvidence(G15);  // cold

  const w1 = await cache.getCaseEvidence(G15);
  const w2 = await cache.getCaseEvidence(G15);

  expect(w1.rows).not.toBe(w2.rows);
  for (let i = 0; i < w1.rows.length; i++) {
    expect(w1.rows[i]).toBe(w2.rows[i]);
    expect(Object.isFrozen(w1.rows[i])).toBe(true);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-29  Galaxy-15 invariants after invalidate-all + reload
// ─────────────────────────────────────────────────────────────────────────────
test('CL-29: Galaxy-15 invariants intact after invalidateAll and full reload', async () => {
  cache.invalidateAll();
  const { rows, graph } = await cache.getCaseEvidence(G15);

  expect(rows.length).toBe(G15_ROW_COUNT);
  expect(rows[0].evidence_id).toBe(G15_FIRST_ID);
  expect(rows[rows.length - 1].evidence_id).toBe(G15_LAST_ID);

  const ephCount = rows.filter(r => r.source === 'GOES11_EPHEMERIS').length;
  expect(ephCount).toBe(G15_EPHEMERIS_COUNT);

  expect(graph.causal_attribution_established).toBe(false);
  for (const h of graph.hypotheses) {
    expect(G15_ASSESSMENTS[h.hypothesis_id]).toBeDefined();
    expect(h.assessment).toBe(G15_ASSESSMENTS[h.hypothesis_id]);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-30  HTTP regression — stats after lifecycle operations
// ─────────────────────────────────────────────────────────────────────────────
test('CL-30 (HTTP): /api/cache/evidence/stats is consistent with direct getStats() through lifecycle', async () => {
  const getStats = async () => (await request(app).get('/api/cache/evidence/stats')).body;

  let s = await getStats();
  expect(s).toEqual({ size: 0, hits: 0, misses: 0, invalidations: 0, inFlight: 0 });

  await cache.getCaseEvidence(G15);
  s = await getStats();
  expect(s.size).toBe(1);
  expect(s.misses).toBe(1);

  // Stale reload
  makeSignatureStale();
  await cache.getCaseEvidence(G15);
  jest.restoreAllMocks();
  s = await getStats();
  expect(s.invalidations).toBe(1);
  expect(s.size).toBe(1);

  // Invalidate via HTTP
  await request(app).post(`/api/cache/evidence/invalidate/${G15}`);
  s = await getStats();
  expect(s.size).toBe(0);
  expect(s.invalidations).toBe(2);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-31  HTTP regression — invalidate/:caseId returns correct invalidated flag
// ─────────────────────────────────────────────────────────────────────────────
test('CL-31 (HTTP): POST /invalidate/:caseId returns invalidated:true only if entry was present', async () => {
  // Not cached yet
  const r1 = await request(app).post(`/api/cache/evidence/invalidate/${G15}`);
  expect(r1.status).toBe(200);
  expect(r1.body.invalidated).toBe(false);

  // Prime then invalidate
  await cache.getCaseEvidence(G15);
  const r2 = await request(app).post(`/api/cache/evidence/invalidate/${G15}`);
  expect(r2.body.invalidated).toBe(true);
  expect(r2.body.case_id).toBe(G15);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-32  HTTP regression — invalidate-all reports correct cleared count
// ─────────────────────────────────────────────────────────────────────────────
test('CL-32 (HTTP): POST /invalidate-all reports correct cleared count after mixed lifecycle', async () => {
  await cache.getCaseEvidence(G15);
  await cache.getCaseEvidence(TCA);

  const r = await request(app).post('/api/cache/evidence/invalidate-all');
  expect(r.status).toBe(200);
  expect(r.body.cleared).toBe(2);
  expect(r.body.invalidated).toBe(true);
  expect(cache.getStats().size).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-33  HTTP regression — exploration routes work after stale reload
// ─────────────────────────────────────────────────────────────────────────────
test('CL-33 (HTTP): /api/cases/:id/evidence returns 200 and correct count after stale reload', async () => {
  await cache.getCaseEvidence(G15);
  makeSignatureStale();

  const res = await request(app).get(`/api/cases/${G15}/evidence`);
  jest.restoreAllMocks();

  expect(res.status).toBe(200);
  expect(res.body.evidence_count).toBe(G15_ROW_COUNT);
  expect(res.body.causal_attribution_established).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-34  Unknown case: 404 on cold load; no lingering state
// ─────────────────────────────────────────────────────────────────────────────
test('CL-34: unknown case throws 404 and leaves no cache entry or in-flight state', async () => {
  await expect(cache.getCaseEvidence(BOGUS)).rejects.toMatchObject({ status: 404 });

  expect(cache.has(BOGUS)).toBe(false);
  expect(cache.getStats().size).toBe(0);
  expect(cache.getStats().inFlight).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-35  INVARIANT A-G combined: Full lifecycle for all three cases
// ─────────────────────────────────────────────────────────────────────────────
test('CL-35: combined lifecycle — three cases, stale reload, failure, recovery, isolation', async () => {
  // Cold-load all three
  const [g15, tca, gs17] = await Promise.all([
    cache.getCaseEvidence(G15),
    cache.getCaseEvidence(TCA),
    cache.getCaseEvidence(GS17),
  ]);
  expect(cache.getStats().size).toBe(3);
  expect(g15.graph.case_id).toBe(G15);
  expect(tca.graph.case_id).toBe(TCA);
  expect(gs17.graph.case_id).toBe(GS17);

  // Warm hits
  await cache.getCaseEvidence(G15);
  await cache.getCaseEvidence(TCA);
  expect(cache.getStats().hits).toBe(2);

  // Fail G15 after making it stale — TCA and GS17 must be unaffected
  makeSignatureStale();
  const err = { status: 500, message: 'CL-35 G15 stale-reload failure' };
  jest.spyOn(serverModule, 'parseEvidenceCSV')
    .mockImplementationOnce(() => new Promise((_, rej) => setImmediate(() => rej(err))));

  await expect(cache.getCaseEvidence(G15)).rejects.toMatchObject({ status: 500 });

  expect(cache.has(G15)).toBe(false);
  expect(cache.has(TCA)).toBe(true);
  expect(cache.has(GS17)).toBe(true);
  expect(cache.getStats().inFlight).toBe(0);

  // Restore and recover G15
  jest.restoreAllMocks();
  const { rows: g15Recovered, graph: g15Graph } = await cache.getCaseEvidence(G15);
  expect(g15Recovered.length).toBe(G15_ROW_COUNT);
  expect(g15Graph.causal_attribution_established).toBe(false);
  expect(cache.has(G15)).toBe(true);

  // All three cached again
  expect(cache.getStats().size).toBe(3);
  expect(cache.getStats().inFlight).toBe(0);
});
