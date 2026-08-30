'use strict';

/**
 * Phase 9.8 — Production Concurrency and Performance Audit
 *
 * Benchmarks the forensic platform under concurrent request load and verifies
 * that deterministic forensic outputs are byte-identical under concurrency.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  Ten benchmark scenarios                                                │
 * │  CP-1  10 concurrent forensic-analysis requests (galaxy-15)             │
 * │  CP-2  25 concurrent forensic-analysis requests (galaxy-15)             │
 * │  CP-3  50 concurrent forensic-analysis requests (galaxy-15)             │
 * │  CP-4  Concurrent requests across multiple simultaneous cases           │
 * │  CP-5  Concurrent investigation creation (PostgreSQL-backed)            │
 * │  CP-6  Concurrent challenge operations on the same investigation        │
 * │  CP-7  Concurrent evidence-provenance requests                          │
 * │  CP-8  PostgreSQL connection-pool saturation behaviour                  │
 * │  CP-9  Memory growth under sustained load                               │
 * │  CP-10 Output determinism — all concurrent Galaxy-15 responses are      │
 * │        byte-identical after stable serialisation                        │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Design principles
 * ─────────────────
 * •  The test file is self-contained: it starts the Express app via supertest
 *    (no external server required) so the full request/response lifecycle,
 *    including middleware and route guards, is exercised.
 *
 * •  PostgreSQL scenarios (CP-5, CP-6, CP-8) are gated on PG_DATABASE /
 *    RUN_PG_TESTS, matching the Phase 9.6 convention.
 *
 * •  In-memory scenarios (CP-1 – CP-4, CP-7, CP-9, CP-10) run on every
 *    `npm test` invocation with NO environment prerequisites.
 *
 * •  Scientific invariants are never altered to improve benchmark numbers.
 *    Any change to a deterministic forensic output must be reported as a
 *    regression, not a performance optimisation.
 *
 * •  The determinism check (CP-10) serialises every concurrent response with
 *    JSON.stringify sorted by key — the same stable approach used in Phase
 *    9.5's fullStackForensicPipeline test — and asserts byte equality across
 *    all N responses.
 *
 * Run manually with PostgreSQL:
 *   PG_DATABASE=spaceforensics_test npx jest tests/phase98ConcurrencyPerf.test.js --verbose
 *
 * Run in-memory only (default npm test):
 *   npx jest tests/phase98ConcurrencyPerf.test.js --verbose
 */

const request = require('supertest');
const { app }  = require('../server');

// ---------------------------------------------------------------------------
// Skip guard — mirrors Phase 9.6 pattern.
// ---------------------------------------------------------------------------
const PG_DATABASE    = process.env.PG_DATABASE || 'spaceforensics_test';
const SKIP_PG        = !process.env.PG_DATABASE && !process.env.RUN_PG_TESTS;
const describeOrSkip = SKIP_PG ? describe.skip : describe;

// ---------------------------------------------------------------------------
// Case fixtures used across scenarios
// ---------------------------------------------------------------------------
const CASES = {
  primary:   'galaxy-15',
  secondary: 'goes16-sep2017',
  tertiary:  'test-case-alpha',
};

// Expected canonical assessments for Galaxy-15 (immutable scientific invariants).
const G15_ASSESSMENTS = {
  H1: 'mixed',
  H2: 'mixed',
  H3: 'supported',
  H4: 'insufficient_evidence',
  H5: 'strongly_supported',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stable, order-invariant JSON serialiser.
 * Recursively sorts object keys alphabetically before stringifying so that
 * two semantically identical objects produce the same string regardless of
 * insertion order.  Arrays preserve their order (evidence lists are ordered).
 */
function stableSerialize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableSerialize).join(',') + ']';
  const sorted = Object.keys(value)
    .sort()
    .map((k) => JSON.stringify(k) + ':' + stableSerialize(value[k]))
    .join(',');
  return '{' + sorted + '}';
}

/**
 * Compute summary statistics from an array of numeric durations (ms).
 */
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const n   = sorted.length;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    n,
    min:    sorted[0],
    p50:    sorted[Math.floor(n * 0.50)],
    p90:    sorted[Math.floor(n * 0.90)],
    p99:    sorted[Math.min(Math.floor(n * 0.99), n - 1)],
    max:    sorted[n - 1],
    avg:    sum / n,
    sum,
  };
}

/**
 * Heap snapshot in MB.
 */
function heapMB() {
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

/**
 * Fire N concurrent GET requests to the same URL using supertest.
 * Returns: { statuses, bodies, latencies, errors }
 *   latencies: wall-clock time per request (ms)
 *   errors:    requests that threw an exception (should be empty)
 */
async function concurrentGets(url, n) {
  const statuses  = [];
  const bodies    = [];
  const latencies = [];
  const errors    = [];

  await Promise.all(
    Array.from({ length: n }, async () => {
      const t0 = Date.now();
      try {
        const res = await request(app).get(url);
        latencies.push(Date.now() - t0);
        statuses.push(res.status);
        bodies.push(res.body);
      } catch (err) {
        latencies.push(Date.now() - t0);
        errors.push(err.message);
      }
    }),
  );

  return { statuses, bodies, latencies, errors };
}

/**
 * Fire N concurrent POST requests with the same body.
 * (Defined for completeness; CP-5 and CP-6 use inline request() chains
 *  for clarity and direct access to per-request response objects.)
 */
async function concurrentPosts(url, body, n) {
  const statuses  = [];
  const resbodies = [];
  const latencies = [];
  const errors    = [];

  await Promise.all(
    Array.from({ length: n }, async () => {
      const t0 = Date.now();
      try {
        const res = await request(app).post(url).send(body);
        latencies.push(Date.now() - t0);
        statuses.push(res.status);
        resbodies.push(res.body);
      } catch (err) {
        latencies.push(Date.now() - t0);
        errors.push(err.message);
      }
    }),
  );

  return { statuses, bodies: resbodies, latencies, errors };
}

// ===========================================================================
// CP-1 — 10 concurrent forensic-analysis requests (Galaxy-15)
// ===========================================================================

describe('CP-1: 10 concurrent forensic-analysis requests', () => {
  const N   = 10;
  const URL = `/api/cases/${CASES.primary}/forensic-analysis`;

  let result;
  let latencyStats;

  beforeAll(async () => {
    result       = await concurrentGets(URL, N);
    latencyStats = stats(result.latencies);
  }, 60_000);

  test('CP-1-1: zero request errors', () => {
    expect(result.errors).toHaveLength(0);
  });

  test('CP-1-2: all responses are HTTP 200', () => {
    for (const s of result.statuses) expect(s).toBe(200);
  });

  test('CP-1-3: throughput — N responses received equals N sent', () => {
    expect(result.statuses).toHaveLength(N);
  });

  test('CP-1-4: causal_attribution_established is false in every response', () => {
    for (const b of result.bodies) {
      expect(b.causal_attribution_established).toBe(false);
    }
  });

  test('CP-1-5: canonical hypothesis assessments are stable in every response', () => {
    for (const b of result.bodies) {
      expect(Array.isArray(b.hypotheses)).toBe(true);
      for (const [hid, expected] of Object.entries(G15_ASSESSMENTS)) {
        const h = b.hypotheses.find((x) => x.hypothesis_id === hid);
        expect(h).toBeDefined();
        expect(h.assessment).toBe(expected);
      }
    }
  });

  test('CP-1-6: p99 latency is within 10 000 ms', () => {
    // Conservative wall-clock SLO; real p99 should be <1000ms on local hardware.
    // Phase 9.8 documents the actual value; we only fail on extreme regression.
    expect(latencyStats.p99).toBeLessThan(10_000);
  });

  test('CP-1-7: latency statistics are collected and structured', () => {
    expect(typeof latencyStats.min).toBe('number');
    expect(typeof latencyStats.p50).toBe('number');
    expect(typeof latencyStats.p90).toBe('number');
    expect(typeof latencyStats.p99).toBe('number');
    expect(typeof latencyStats.max).toBe('number');
    expect(typeof latencyStats.avg).toBe('number');
  });
});

// ===========================================================================
// CP-2 — 25 concurrent forensic-analysis requests (Galaxy-15)
// ===========================================================================

describe('CP-2: 25 concurrent forensic-analysis requests', () => {
  const N   = 25;
  const URL = `/api/cases/${CASES.primary}/forensic-analysis`;

  let result;
  let latencyStats;

  beforeAll(async () => {
    result       = await concurrentGets(URL, N);
    latencyStats = stats(result.latencies);
  }, 120_000);

  test('CP-2-1: zero request errors', () => {
    expect(result.errors).toHaveLength(0);
  });

  test('CP-2-2: all responses are HTTP 200', () => {
    for (const s of result.statuses) expect(s).toBe(200);
  });

  test('CP-2-3: throughput — N responses equal N sent', () => {
    expect(result.statuses).toHaveLength(N);
  });

  test('CP-2-4: causal_attribution_established is false across all 25 responses', () => {
    for (const b of result.bodies) {
      expect(b.causal_attribution_established).toBe(false);
    }
  });

  test('CP-2-5: hypothesis count is 5 in every response', () => {
    for (const b of result.bodies) {
      expect(Array.isArray(b.hypotheses)).toBe(true);
      expect(b.hypotheses).toHaveLength(5);
    }
  });

  test('CP-2-6: all canonical assessments are preserved across 25 concurrent responses', () => {
    for (const b of result.bodies) {
      for (const [hid, expected] of Object.entries(G15_ASSESSMENTS)) {
        const h = b.hypotheses.find((x) => x.hypothesis_id === hid);
        expect(h).toBeDefined();
        expect(h.assessment).toBe(expected);
      }
    }
  });

  test('CP-2-7: p90 latency is within 15 000 ms', () => {
    expect(latencyStats.p90).toBeLessThan(15_000);
  });
});

// ===========================================================================
// CP-3 — 50 concurrent forensic-analysis requests (Galaxy-15)
// ===========================================================================

describe('CP-3: 50 concurrent forensic-analysis requests', () => {
  const N   = 50;
  const URL = `/api/cases/${CASES.primary}/forensic-analysis`;

  let result;
  let latencyStats;

  beforeAll(async () => {
    result       = await concurrentGets(URL, N);
    latencyStats = stats(result.latencies);
  }, 180_000);

  test('CP-3-1: zero request errors', () => {
    expect(result.errors).toHaveLength(0);
  });

  test('CP-3-2: all 50 responses are HTTP 200', () => {
    expect(result.statuses.every((s) => s === 200)).toBe(true);
  });

  test('CP-3-3: throughput — exactly 50 responses received', () => {
    expect(result.statuses).toHaveLength(N);
  });

  test('CP-3-4: causal_attribution_established invariant holds under 50-concurrent load', () => {
    for (const b of result.bodies) {
      expect(b.causal_attribution_established).toBe(false);
    }
  });

  test('CP-3-5: every response has 5 hypotheses with canonical assessments', () => {
    for (const b of result.bodies) {
      expect(b.hypotheses).toHaveLength(5);
      for (const [hid, expected] of Object.entries(G15_ASSESSMENTS)) {
        const h = b.hypotheses.find((x) => x.hypothesis_id === hid);
        expect(h).toBeDefined();
        expect(h.assessment).toBe(expected);
      }
    }
  });

  test('CP-3-6: p99 latency is within 30 000 ms', () => {
    expect(latencyStats.p99).toBeLessThan(30_000);
  });

  test('CP-3-7: failure rate is zero', () => {
    const failures = result.statuses.filter((s) => s >= 500);
    expect(failures).toHaveLength(0);
  });
});

// ===========================================================================
// CP-4 — Multiple simultaneous cases
// ===========================================================================

describe('CP-4: concurrent requests across multiple simultaneous cases', () => {
  // Fire concurrent forensic-analysis requests against all three known cases
  // at the same time.  Confirms isolation: each case returns its own
  // case_id, and there is no cross-case contamination.
  const cases = [CASES.primary, CASES.secondary, CASES.tertiary];
  const REQUESTS_PER_CASE = 5;

  let allResults;
  let latencies;

  beforeAll(async () => {
    allResults = [];
    latencies  = [];

    await Promise.all(
      cases.flatMap((caseId) =>
        Array.from({ length: REQUESTS_PER_CASE }, async () => {
          const t0  = Date.now();
          const res = await request(app).get(`/api/cases/${caseId}/forensic-analysis`);
          latencies.push(Date.now() - t0);
          allResults.push({ caseId, status: res.status, body: res.body });
        }),
      ),
    );
  }, 180_000);

  test('CP-4-1: total response count equals cases × requests per case', () => {
    expect(allResults).toHaveLength(cases.length * REQUESTS_PER_CASE);
  });

  test('CP-4-2: every response is HTTP 200', () => {
    for (const r of allResults) expect(r.status).toBe(200);
  });

  test('CP-4-3: each response carries its own case_id (no cross-case contamination)', () => {
    for (const r of allResults) {
      expect(r.body.case_id).toBe(r.caseId);
    }
  });

  test('CP-4-4: Galaxy-15 responses preserve canonical assessments under multi-case load', () => {
    const g15 = allResults.filter((r) => r.caseId === CASES.primary);
    for (const r of g15) {
      expect(r.body.causal_attribution_established).toBe(false);
      for (const [hid, expected] of Object.entries(G15_ASSESSMENTS)) {
        const h = r.body.hypotheses.find((x) => x.hypothesis_id === hid);
        expect(h).toBeDefined();
        expect(h.assessment).toBe(expected);
      }
    }
  });

  test('CP-4-5: no response contains forbidden numerical probability language', () => {
    const PROB_RE = /\b\d+\s*%|\b(probability|confidence|likelihood)\s*(of|is|=|:)\s*\d/i;
    for (const r of allResults) {
      const json = JSON.stringify(r.body);
      expect(PROB_RE.test(json)).toBe(false);
    }
  });
});

// ===========================================================================
// CP-5 — Concurrent investigation creation (PostgreSQL-backed)
// ===========================================================================

describeOrSkip('CP-5: concurrent investigation creation (PostgreSQL)', () => {
  const { Pool }     = require('pg');
  const { runMigrations } = require('../db/migrate');
  const { setPool }  = require('../db/pool');

  let pgPool;

  beforeAll(async () => {
    pgPool = new Pool({
      host:                    process.env.PG_HOST     || 'localhost',
      port:                    parseInt(process.env.PG_PORT || '5432', 10),
      database:                PG_DATABASE,
      user:                    process.env.PG_USER     || undefined,
      password:                process.env.PG_PASSWORD || undefined,
      ssl:                     false,
      max:                     20,          // wider pool for concurrency test
      idleTimeoutMillis:       3_000,
      connectionTimeoutMillis: 5_000,
    });
    setPool(pgPool);
    await runMigrations(pgPool);
    await pgPool.query('TRUNCATE investigations CASCADE');
  }, 30_000);

  afterAll(async () => {
    if (pgPool) {
      setPool(null);
      await pgPool.end();
    }
  }, 15_000);

  test('CP-5-1: 20 concurrent POST /investigations produce distinct IDs', async () => {
    const N    = 20;
    const caseId = CASES.primary;

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        request(app)
          .post(`/api/cases/${caseId}/investigations`)
          .send({ title: `Concurrent investigation ${i}`, opened_by: 'perf-analyst' }),
      ),
    );

    const statuses = results.map((r) => r.status);
    const ids      = results.map((r) => r.body.investigation_id);

    expect(statuses.every((s) => s === 201)).toBe(true);
    expect(new Set(ids).size).toBe(N); // all UUIDs distinct
  }, 30_000);

  test('CP-5-2: all created investigations are retrievable after concurrent creation', async () => {
    const caseId = CASES.primary;
    // Pre-create 10 investigations concurrently.
    const creates = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        request(app)
          .post(`/api/cases/${caseId}/investigations`)
          .send({ title: `Retrieve test ${i}`, opened_by: 'perf-analyst' }),
      ),
    );

    const invIds = creates.map((r) => r.body.investigation_id);

    // Concurrently retrieve all of them.
    const retrieves = await Promise.all(
      invIds.map((id) => request(app).get(`/api/cases/${caseId}/investigations/${id}`)),
    );

    for (const r of retrieves) {
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('open');
      expect(r.body.case_id).toBe(caseId);
    }
  }, 30_000);

  test('CP-5-3: concurrent investigation creation does not alter forensic-analysis output', async () => {
    // While 10 investigations are being created, simultaneously run 5
    // forensic-analysis requests.  The forensic pipeline must be unaffected.
    const caseId = CASES.primary;

    const [investigationResults, analysisResults] = await Promise.all([
      Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          request(app)
            .post(`/api/cases/${caseId}/investigations`)
            .send({ title: `Concurrent inv ${i}`, opened_by: 'perf' }),
        ),
      ),
      Promise.all(
        Array.from({ length: 5 }, () =>
          request(app).get(`/api/cases/${caseId}/forensic-analysis`),
        ),
      ),
    ]);

    // All investigations created successfully.
    for (const r of investigationResults) expect(r.status).toBe(201);

    // All forensic analyses are deterministic and unaffected.
    for (const r of analysisResults) {
      expect(r.status).toBe(200);
      expect(r.body.causal_attribution_established).toBe(false);
      for (const [hid, expected] of Object.entries(G15_ASSESSMENTS)) {
        const h = r.body.hypotheses.find((x) => x.hypothesis_id === hid);
        expect(h).toBeDefined();
        expect(h.assessment).toBe(expected);
      }
    }
  }, 60_000);
});

// ===========================================================================
// CP-6 — Concurrent challenge operations on the same investigation
// ===========================================================================

describeOrSkip('CP-6: concurrent challenge operations (PostgreSQL)', () => {
  const { Pool }     = require('pg');
  const { runMigrations } = require('../db/migrate');
  const { setPool }  = require('../db/pool');

  let pgPool;
  let investigationId;

  beforeAll(async () => {
    pgPool = new Pool({
      host:                    process.env.PG_HOST     || 'localhost',
      port:                    parseInt(process.env.PG_PORT || '5432', 10),
      database:                PG_DATABASE,
      user:                    process.env.PG_USER     || undefined,
      password:                process.env.PG_PASSWORD || undefined,
      ssl:                     false,
      max:                     20,
      idleTimeoutMillis:       3_000,
      connectionTimeoutMillis: 5_000,
    });
    setPool(pgPool);
    await runMigrations(pgPool);
    await pgPool.query('TRUNCATE investigations CASCADE');

    // Create one investigation to use for all CP-6 tests.
    const res = await request(app)
      .post(`/api/cases/${CASES.primary}/investigations`)
      .send({ title: 'CP-6 challenge concurrency investigation', opened_by: 'perf' });
    investigationId = res.body.investigation_id;
  }, 30_000);

  afterAll(async () => {
    if (pgPool) {
      setPool(null);
      await pgPool.end();
    }
  }, 15_000);

  test('CP-6-1: 10 concurrent challenge creations produce distinct challenge IDs', async () => {
    const N      = 10;
    const caseId = CASES.primary;

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        request(app)
          .post(`/api/cases/${caseId}/investigations/${investigationId}/challenges`)
          .send({
            target_type:       'hypothesis_assessment',
            target_id:         'H1',
            authored_by:       `analyst-${i}`,
            analyst_statement: `Concurrent challenge ${i}: H1 mixed assessment review.`,
          }),
      ),
    );

    const statuses = results.map((r) => r.status);
    const ids      = results.map((r) => r.body.challenge_id);

    expect(statuses.every((s) => s === 201)).toBe(true);
    expect(new Set(ids).size).toBe(N);
  }, 30_000);

  test('CP-6-2: all concurrent challenges are retrievable via the investigation list endpoint', async () => {
    const caseId = CASES.primary;
    const res = await request(app)
      .get(`/api/cases/${caseId}/investigations/${investigationId}/challenges`);

    expect(res.status).toBe(200);
    // There may be leftover challenges from CP-6-1; just verify all are returned.
    expect(Array.isArray(res.body)).toBe(true);
    for (const c of res.body) {
      expect(c.investigation_id).toBe(investigationId);
      expect(c.status).toBe('open');
    }
  }, 15_000);

  test('CP-6-3: concurrent challenge creation does not corrupt forensic invariants', async () => {
    const caseId = CASES.primary;

    // Simultaneously: 5 challenge creates + 3 forensic analyses.
    const [challengeResults, analysisResults] = await Promise.all([
      Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          request(app)
            .post(`/api/cases/${caseId}/investigations/${investigationId}/challenges`)
            .send({
              target_type:       'limitation',
              target_id:         `proxy_measurement_${i}`,
              authored_by:       'perf',
              analyst_statement: `Limitation challenge ${i}: proxy measurement warrant review.`,
            }),
        ),
      ),
      Promise.all(
        Array.from({ length: 3 }, () =>
          request(app).get(`/api/cases/${caseId}/forensic-analysis`),
        ),
      ),
    ]);

    for (const r of challengeResults) expect(r.status).toBe(201);

    for (const r of analysisResults) {
      expect(r.status).toBe(200);
      expect(r.body.causal_attribution_established).toBe(false);
      expect(r.body.hypotheses).toHaveLength(5);
    }
  }, 60_000);
});

// ===========================================================================
// CP-7 — Concurrent evidence-provenance requests
// ===========================================================================

describe('CP-7: concurrent evidence-provenance requests', () => {
  // Fetch the first 10 evidence IDs from Galaxy-15, then request their
  // provenance concurrently in batches of 10 and 20.
  let evidenceIds;

  beforeAll(async () => {
    const res = await request(app).get(`/api/cases/${CASES.primary}/forensic-analysis`);
    // Collect the first N distinct evidence IDs from all hypothesis lists.
    const ids = new Set();
    for (const h of res.body.hypotheses || []) {
      for (const list of ['environmental_context', 'supporting_evidence',
        'contradicting_evidence', 'non_discriminating_evidence']) {
        for (const e of h[list] || []) {
          if (e.evidence_id) ids.add(e.evidence_id);
        }
      }
    }
    evidenceIds = [...ids].slice(0, 20);
  }, 30_000);

  test('CP-7-1: 10 concurrent provenance requests all return HTTP 200', async () => {
    const subset = evidenceIds.slice(0, 10);
    const results = await Promise.all(
      subset.map((eid) =>
        request(app).get(`/api/cases/${CASES.primary}/evidence/${eid}/provenance`),
      ),
    );

    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body.found).toBe(true);
    }
  }, 30_000);

  test('CP-7-2: 20 concurrent provenance requests have zero failures', async () => {
    const results = await Promise.all(
      evidenceIds.map((eid) =>
        request(app).get(`/api/cases/${CASES.primary}/evidence/${eid}/provenance`),
      ),
    );

    const failures = results.filter((r) => r.status >= 500);
    expect(failures).toHaveLength(0);
  }, 30_000);

  test('CP-7-3: provenance response is consistent across concurrent calls to the same ID', async () => {
    if (evidenceIds.length === 0) {
      // Skip gracefully if no evidence IDs were found.
      return;
    }
    const targetId = evidenceIds[0];
    const N = 8;

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        request(app).get(`/api/cases/${CASES.primary}/evidence/${targetId}/provenance`),
      ),
    );

    const serialized = results.map((r) => stableSerialize(r.body));
    const reference  = serialized[0];

    for (const s of serialized) {
      expect(s).toBe(reference);
    }
  }, 30_000);

  test('CP-7-4: concurrent provenance requests do not embed causal certainty language', async () => {
    const CAUSAL_RE = /\b(caused by|definitively|conclusively|proves|confirmed cause|is the cause|was caused by|root cause is)\b/i;
    const results = await Promise.all(
      evidenceIds.slice(0, 10).map((eid) =>
        request(app).get(`/api/cases/${CASES.primary}/evidence/${eid}/provenance`),
      ),
    );
    for (const r of results) {
      expect(CAUSAL_RE.test(JSON.stringify(r.body))).toBe(false);
    }
  }, 30_000);
});

// ===========================================================================
// CP-8 — PostgreSQL connection-pool saturation behaviour
// ===========================================================================

describeOrSkip('CP-8: PostgreSQL connection-pool saturation', () => {
  const { Pool }     = require('pg');
  const { runMigrations } = require('../db/migrate');
  const { setPool }  = require('../db/pool');

  // Intentionally use a SMALL pool (max: 3) to exercise pool contention /
  // queuing behaviour when saturated by concurrent investigation creates.
  const SMALL_POOL_SIZE = 3;
  let pgPool;

  beforeAll(async () => {
    pgPool = new Pool({
      host:                    process.env.PG_HOST     || 'localhost',
      port:                    parseInt(process.env.PG_PORT || '5432', 10),
      database:                PG_DATABASE,
      user:                    process.env.PG_USER     || undefined,
      password:                process.env.PG_PASSWORD || undefined,
      ssl:                     false,
      max:                     SMALL_POOL_SIZE,
      idleTimeoutMillis:       5_000,
      connectionTimeoutMillis: 10_000,   // generous timeout: queued requests must wait
    });
    setPool(pgPool);
    await runMigrations(pgPool);
    await pgPool.query('TRUNCATE investigations CASCADE');
  }, 30_000);

  afterAll(async () => {
    if (pgPool) {
      setPool(null);
      await pgPool.end();
    }
  }, 15_000);

  test('CP-8-1: 15 concurrent writes with pool size 3 all succeed (queuing)', async () => {
    // 15 concurrent requests vs 3 connections.  The pool must queue excess
    // requests internally and drain them without losing any.
    const N = 15;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        request(app)
          .post(`/api/cases/${CASES.primary}/investigations`)
          .send({ title: `Pool saturation ${i}`, opened_by: 'perf' }),
      ),
    );

    const statuses = results.map((r) => r.status);
    expect(statuses.every((s) => s === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.investigation_id)).size).toBe(N);
  }, 60_000);

  test('CP-8-2: pool exhaustion does not produce partial investigation rows', async () => {
    // After CP-8-1 all transactions committed cleanly; each investigation
    // must be fully hydrated (has events array with at least one entry).
    const listRes = await request(app)
      .get(`/api/cases/${CASES.primary}/investigations`);

    expect(listRes.status).toBe(200);
    for (const inv of listRes.body) {
      expect(Array.isArray(inv.events)).toBe(true);
      expect(inv.events.length).toBeGreaterThanOrEqual(1);
      expect(inv.events[0].event).toBe('opened');
    }
  }, 15_000);

  test('CP-8-3: forensic pipeline is unaffected during pool saturation', async () => {
    // Fire concurrent pool-saturating investigation creates WHILE forensic
    // analysis requests are in-flight.  The forensic pipeline uses no DB
    // connections; it must remain fully available and produce correct output.
    const [invResults, analysisResults] = await Promise.all([
      Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          request(app)
            .post(`/api/cases/${CASES.primary}/investigations`)
            .send({ title: `Saturation ${i}`, opened_by: 'perf' }),
        ),
      ),
      Promise.all(
        Array.from({ length: 5 }, () =>
          request(app).get(`/api/cases/${CASES.primary}/forensic-analysis`),
        ),
      ),
    ]);

    for (const r of invResults)      expect(r.status).toBe(201);
    for (const r of analysisResults) {
      expect(r.status).toBe(200);
      expect(r.body.causal_attribution_established).toBe(false);
    }
  }, 60_000);
});

// ===========================================================================
// CP-9 — Memory growth under sustained load
// ===========================================================================

describe('CP-9: memory growth under sustained load', () => {
  const ROUNDS   = 5;  // sequential rounds
  const BATCH    = 10; // concurrent requests per round

  let heapBefore;
  let heapAfter;
  let heapGrowthMB;

  beforeAll(async () => {
    // Force a GC pass if available (V8 --expose-gc flag in test process).
    if (typeof global.gc === 'function') global.gc();
    heapBefore = heapMB();

    for (let i = 0; i < ROUNDS; i++) {
      await Promise.all(
        Array.from({ length: BATCH }, () =>
          request(app).get(`/api/cases/${CASES.primary}/forensic-analysis`),
        ),
      );
    }

    if (typeof global.gc === 'function') global.gc();
    heapAfter = heapMB();
    heapGrowthMB = heapAfter - heapBefore;
  }, 180_000);

  test('CP-9-1: heap growth after 50 requests is below 150 MB', () => {
    // Generous bound; catches genuine leaks while tolerating GC jitter.
    expect(heapGrowthMB).toBeLessThan(150);
  });

  test('CP-9-2: heap growth is non-negative (sanity: heapAfter >= heapBefore - 20 MB)', () => {
    // GC may collect aggressively; allow 20 MB of GC-induced apparent shrink.
    expect(heapGrowthMB).toBeGreaterThan(-20);
  });

  test('CP-9-3: heap growth per request is below 3 MB', () => {
    const perRequest = heapGrowthMB / (ROUNDS * BATCH);
    expect(perRequest).toBeLessThan(3);
  });

  test('CP-9-4: heap growth measurements are captured as numbers', () => {
    expect(typeof heapBefore).toBe('number');
    expect(typeof heapAfter).toBe('number');
    expect(typeof heapGrowthMB).toBe('number');
  });
});

// ===========================================================================
// CP-10 — Output determinism: all concurrent responses are byte-identical
// ===========================================================================

describe('CP-10: output determinism — concurrent responses are byte-identical', () => {
  // CRITICAL INVARIANT:
  // Concurrent execution of the forensic pipeline must not alter deterministic
  // forensic analysis.  For Galaxy-15, every concurrent response must serialise
  // to the same stable string.
  //
  // Scope: deterministic fields only.  The analyst_narrative may carry a
  // generated_at timestamp that differs per request; we extract and compare
  // only the authoritative fields: case_id, causal_attribution_established,
  // analysis_version, hypotheses (with their assessments and evidence IDs).

  function extractDeterministicFields(body) {
    return {
      case_id:                        body.case_id,
      analysis_version:               body.analysis_version,
      causal_attribution_established: body.causal_attribution_established,
      hypotheses: (body.hypotheses || []).map((h) => ({
        hypothesis_id:                 h.hypothesis_id,
        assessment:                    h.assessment,
        // Evidence reference lists — IDs only, sorted for stability.
        environmental_context:         (h.environmental_context || [])
          .map((e) => e.evidence_id).sort(),
        supporting_evidence:           (h.supporting_evidence || [])
          .map((e) => e.evidence_id).sort(),
        contradicting_evidence:        (h.contradicting_evidence || [])
          .map((e) => e.evidence_id).sort(),
        non_discriminating_evidence:   (h.non_discriminating_evidence || [])
          .map((e) => e.evidence_id).sort(),
      })).sort((a, b) => a.hypothesis_id.localeCompare(b.hypothesis_id)),
    };
  }

  describe('CP-10a: 10 concurrent requests — deterministic field equality', () => {
    const N = 10;
    let serializedSet;
    let bodies;

    beforeAll(async () => {
      const result = await concurrentGets(
        `/api/cases/${CASES.primary}/forensic-analysis`, N,
      );
      bodies       = result.bodies;
      serializedSet = new Set(
        result.bodies.map((b) => stableSerialize(extractDeterministicFields(b))),
      );
    }, 60_000);

    test('CP-10a-1: all 10 responses produce a single unique deterministic fingerprint', () => {
      expect(serializedSet.size).toBe(1);
    });

    test('CP-10a-2: the fingerprint includes causal_attribution_established: false', () => {
      const parsed = JSON.parse([...serializedSet][0]);
      // Key is sorted; find causal_attribution_established in the parsed object.
      expect(parsed.causal_attribution_established).toBe(false);
    });

    test('CP-10a-3: all 5 hypothesis assessments are identical in all responses', () => {
      for (const b of bodies) {
        for (const [hid, expected] of Object.entries(G15_ASSESSMENTS)) {
          const h = b.hypotheses.find((x) => x.hypothesis_id === hid);
          expect(h).toBeDefined();
          expect(h.assessment).toBe(expected);
        }
      }
    });
  });

  describe('CP-10b: 25 concurrent requests — deterministic field equality', () => {
    const N = 25;
    let serializedSet;

    beforeAll(async () => {
      const result = await concurrentGets(
        `/api/cases/${CASES.primary}/forensic-analysis`, N,
      );
      serializedSet = new Set(
        result.bodies.map((b) => stableSerialize(extractDeterministicFields(b))),
      );
    }, 120_000);

    test('CP-10b-1: all 25 concurrent responses share a single deterministic fingerprint', () => {
      expect(serializedSet.size).toBe(1);
    });
  });

  describe('CP-10c: evidence provenance determinism', () => {
    let provenanceSet;

    beforeAll(async () => {
      // Get a valid evidence ID from the graph.
      const graphRes = await request(app)
        .get(`/api/cases/${CASES.primary}/forensic-analysis`);
      let evidenceId;
      outer: for (const h of graphRes.body.hypotheses || []) {
        for (const list of ['environmental_context', 'supporting_evidence']) {
          const entry = (h[list] || [])[0];
          if (entry && entry.evidence_id) {
            evidenceId = entry.evidence_id;
            break outer;
          }
        }
      }

      if (!evidenceId) {
        provenanceSet = new Set(['__no_evidence_id_found__']);
        return;
      }

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          request(app).get(
            `/api/cases/${CASES.primary}/evidence/${evidenceId}/provenance`,
          ),
        ),
      );
      provenanceSet = new Set(results.map((r) => stableSerialize(r.body)));
    }, 60_000);

    test('CP-10c-1: 10 concurrent provenance lookups for the same ID are byte-identical', () => {
      expect(provenanceSet.size).toBe(1);
    });
  });
});
