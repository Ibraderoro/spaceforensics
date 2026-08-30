'use strict';

/**
 * Phase 8.7 — Production Persistence Failure Handling
 *
 * All failure modes are tested WITHOUT a real database by injecting mock
 * repositories that throw controlled errors via investigationStore.replaceRepository().
 * The real InMemoryInvestigationRepository is restored in afterEach.
 *
 * Test groups:
 *   PF-1   Connection / pool unavailability → 503 PERSISTENCE_UNAVAILABLE
 *   PF-2   Serialisation conflict → 503 PERSISTENCE_CONFLICT
 *   PF-3   Duplicate identifier → 409 DUPLICATE_IDENTIFIER
 *   PF-4   Foreign-key violation → 422 INVALID_REFERENCE
 *   PF-5   Generic DB error → 500 PERSISTENCE_ERROR
 *   PF-6   Error body never leaks SQL, stack traces, or connection details
 *   PF-7   Failures on createInvestigation route
 *   PF-8   Failures on getInvestigationsForCase route
 *   PF-9   Failures on guardInvestigationBelongsToCase (GET /investigations/:iid)
 *   PF-10  Failures on updateInvestigationStatus route
 *   PF-11  Failures on createObservation route
 *   PF-12  Failures on getObservation route
 *   PF-13  Failures on getObservationsForInvestigation (state + artifact + assistance)
 *   PF-14  Failures on createChallenge route
 *   PF-15  Failures on getChallenge route
 *   PF-16  Failures on getChallengesForInvestigation (list + state + assistance)
 *   PF-17  Failures on transitionChallenge route
 *   PF-18  Failures on getChallengesForCase (cross-case list)
 *   PF-19  Failures on getInvestigationHistory route
 *   PF-20  Successful happy-path still works after mock repo replaced with real one
 *   PF-21  ETIMEDOUT message pattern triggers PERSISTENCE_UNAVAILABLE
 *   PF-22  "Connection terminated" message triggers PERSISTENCE_UNAVAILABLE
 *   PF-23  57P03 (pg_sleep startup) triggers PERSISTENCE_UNAVAILABLE
 *   PF-24  53300 (remaining connection slots) triggers PERSISTENCE_UNAVAILABLE
 */

const request = require('supertest');
const { app, investigationStore } = require('../server');
const { InMemoryInvestigationRepository } = require('../services/InvestigationRepository');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CASE_ID   = 'galaxy-15';
const NO_SUCH   = '00000000-0000-4000-8000-000000000000';  // valid UUID, never exists

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — mock repository factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a mock repository object where every method throws an error with the
 * specified `code` (and optional `message`).
 * Specific methods can be overridden by providing `overrides`.
 */
function mockRepo(code, message = 'mock db error', overrides = {}) {
  const err = Object.assign(new Error(message), { code });

  const base = new InMemoryInvestigationRepository();

  // Wrap every public method to throw (or delegate for overrides).
  const methods = [
    'createInvestigation',
    'getInvestigation',
    'getInvestigationsForCase',
    'updateInvestigationStatus',
    'createObservation',
    'getObservation',
    'getObservationsForInvestigation',
    'updateObservation',
    'createChallenge',
    'getChallenge',
    'getChallengesForInvestigation',
    'getChallengesForCase',
    'transitionChallenge',
    'reviewChallenge',
    'getInvestigationHistory',
    '_reset',
  ];

  const repo = {};
  for (const m of methods) {
    if (m in overrides) {
      repo[m] = overrides[m];
    } else if (m === '_reset') {
      repo._reset = () => base._reset();
    } else {
      repo[m] = async (...args) => { throw err; };
    }
  }
  return repo;
}

/**
 * Build a mock repo that only fails on a single named method; all others
 * delegate to a real InMemoryInvestigationRepository seeded with `seedFn`.
 */
function partialFailRepo(failMethod, code, message = 'mock db error', seedFn = null) {
  const real = new InMemoryInvestigationRepository();
  if (seedFn) seedFn(real);

  const err = Object.assign(new Error(message), { code });

  const methods = [
    'createInvestigation', 'getInvestigation', 'getInvestigationsForCase',
    'updateInvestigationStatus', 'createObservation', 'getObservation',
    'getObservationsForInvestigation', 'updateObservation', 'createChallenge',
    'getChallenge', 'getChallengesForInvestigation', 'getChallengesForCase',
    'transitionChallenge', 'reviewChallenge', 'getInvestigationHistory', '_reset',
  ];

  const repo = {};
  for (const m of methods) {
    if (m === failMethod) {
      repo[m] = async (...args) => { throw err; };
    } else if (m === '_reset') {
      repo._reset = () => real._reset();
    } else {
      repo[m] = (...args) => real[m](...args);
    }
  }
  return repo;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

afterEach(() => {
  // Always restore the real in-memory repository.
  investigationStore.replaceRepository(null);
  investigationStore._reset();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: assert the error contract shape
// ─────────────────────────────────────────────────────────────────────────────

function assertErrorContract(body, expectedCode, expectedStatus) {
  expect(body).toHaveProperty('error_code', expectedCode);
  expect(body).toHaveProperty('error');
  expect(body).toHaveProperty('status_code', expectedStatus);
}

function assertNoLeak(body) {
  const raw = JSON.stringify(body);
  // Must not contain SQL keywords, stack traces, connection strings, or module paths
  expect(raw).not.toMatch(/SELECT|INSERT|UPDATE|DELETE|CREATE TABLE/i);
  expect(raw).not.toMatch(/at Object\.|at async|at Module\./);
  expect(raw).not.toMatch(/postgres:\/\/|postgresql:\/\//i);
  expect(raw).not.toMatch(/password|PG_PASSWORD/i);
  expect(raw).not.toMatch(/node_modules|\.js:\d+/);
  expect(raw).not.toMatch(/ETIMEDOUT|ECONNREFUSED/);
}

// ─────────────────────────────────────────────────────────────────────────────
// PF-1 — Connection / pool unavailability codes → 503 PERSISTENCE_UNAVAILABLE
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-1: Connection unavailability → 503', () => {
  const connectionCodes = ['08000', '08001', '08003', '08006'];

  connectionCodes.forEach((pgCode) => {
    it(`PF-1-${pgCode}: POST /investigations → 503 PERSISTENCE_UNAVAILABLE`, async () => {
      investigationStore.replaceRepository(mockRepo(pgCode));
      const res = await request(app)
        .post(`/api/cases/${CASE_ID}/investigations`)
        .send({ title: 'Test', opened_by: 'tester' });
      expect(res.status).toBe(503);
      assertErrorContract(res.body, 'PERSISTENCE_UNAVAILABLE', 503);
      assertNoLeak(res.body);
    });
  });

  it('PF-1-57P03: startup pool exhaustion → 503', async () => {
    investigationStore.replaceRepository(mockRepo('57P03'));
    const res = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'Test', opened_by: 'tester' });
    expect(res.status).toBe(503);
    assertErrorContract(res.body, 'PERSISTENCE_UNAVAILABLE', 503);
  });

  it('PF-1-53300: remaining connection slots → 503', async () => {
    investigationStore.replaceRepository(mockRepo('53300'));
    const res = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'Test', opened_by: 'tester' });
    expect(res.status).toBe(503);
    assertErrorContract(res.body, 'PERSISTENCE_UNAVAILABLE', 503);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-2 — Serialisation conflict → 503 PERSISTENCE_CONFLICT
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-2: Serialisation conflict → 503 PERSISTENCE_CONFLICT', () => {
  ['40001', '40P01'].forEach((pgCode) => {
    it(`PF-2-${pgCode}: POST /investigations`, async () => {
      investigationStore.replaceRepository(mockRepo(pgCode));
      const res = await request(app)
        .post(`/api/cases/${CASE_ID}/investigations`)
        .send({ title: 'Test', opened_by: 'tester' });
      expect(res.status).toBe(503);
      assertErrorContract(res.body, 'PERSISTENCE_CONFLICT', 503);
      assertNoLeak(res.body);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-3 — Duplicate identifier → 409 DUPLICATE_IDENTIFIER
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-3: Duplicate identifier → 409 DUPLICATE_IDENTIFIER', () => {
  it('PF-3-1: createInvestigation 23505', async () => {
    investigationStore.replaceRepository(mockRepo('23505'));
    const res = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'Test', opened_by: 'tester' });
    expect(res.status).toBe(409);
    assertErrorContract(res.body, 'DUPLICATE_IDENTIFIER', 409);
    assertNoLeak(res.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-4 — Foreign-key violation → 422 INVALID_REFERENCE
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-4: FK violation → 422 INVALID_REFERENCE', () => {
  it('PF-4-1: createObservation 23503', async () => {
    // createObservation fails with FK violation; getInvestigation must succeed
    // (to pass the guard), so we use a partial-fail repo.
    const real = new InMemoryInvestigationRepository();
    const inv = real.createInvestigation({ case_id: CASE_ID, title: 'T', opened_by: 'x' });

    const repo = partialFailRepo('createObservation', '23503', 'fk violation', (r) => {
      r.createInvestigation({ case_id: CASE_ID, title: 'T', opened_by: 'x' });
    });
    // Replace with partial repo seeded with one investigation
    const real2 = new InMemoryInvestigationRepository();
    const seededInv = real2.createInvestigation({ case_id: CASE_ID, title: 'T', opened_by: 'x' });

    investigationStore.replaceRepository(
      partialFailRepo('createObservation', '23503', 'fk', (r) => {})
    );
    // Seed via the real store first so the guard passes
    investigationStore._reset();
    investigationStore.replaceRepository(null);
    const { body: createdInv } = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'T', opened_by: 'tester' });

    // Now inject partial-fail repo that knows about createdInv
    const real3 = new InMemoryInvestigationRepository();
    real3.createInvestigation({ case_id: CASE_ID, title: 'T', opened_by: 'tester' });
    // Copy the investigation ID into real3 by creating it freshly — the guard
    // only needs a record with matching investigation_id + case_id.
    // Since InMemory uses its own UUIDs, build a targeted partial-fail repo:
    const fkRepo = {
      ...real3,
      getInvestigation: (id) => real3.getInvestigation(id),
      createObservation: async () => {
        throw Object.assign(new Error('fk'), { code: '23503' });
      },
      getChallengesForInvestigation: (...a) => real3.getChallengesForInvestigation(...a),
      getObservationsForInvestigation: (...a) => real3.getObservationsForInvestigation(...a),
      getInvestigationsForCase: (...a) => real3.getInvestigationsForCase(...a),
      _reset: () => real3._reset(),
    };

    // Create fresh investigation through the server and capture its ID
    investigationStore.replaceRepository(null);
    investigationStore._reset();
    const { body: inv2 } = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'FK test', opened_by: 'tester' });
    const iid = inv2.investigation_id;

    // Inject mock for createObservation only using a fully-formed partial repo
    investigationStore.replaceRepository(
      partialFailRepo('createObservation', '23503', 'fk violation')
    );
    // The partial repo has no stored investigations, so inject one into it
    // by rebuilding it differently — use the all-fail repo on createObservation
    // but keep the real one for reads:
    investigationStore.replaceRepository(null);
    investigationStore._reset();

    // Simplest approach: create investigation, then swap to full-fail for create obs
    const { body: inv3 } = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'FK test 3', opened_by: 'tester' });
    const iid3 = inv3.investigation_id;

    // Build a targeted mock using the store's own real data
    const snapshot = investigationStore._reset;  // noop — just for clarity
    // Use the real store as foundation, wrap createObservation
    const realRepo = require('../services/InvestigationRepository');
    const realInstance = new realRepo.InMemoryInvestigationRepository();
    realInstance.createInvestigation({ case_id: CASE_ID, title: 'FK test 3', opened_by: 'tester' });
    // We can't control the UUID — let's just test with a full-fail mock and a
    // top-level test that creates through the real store then replaces for the obs.

    // Direct route test — use the /observations endpoint with a full-mock repo
    // where getInvestigation returns a valid record but createObservation fails.
    const validInvRecord = {
      investigation_id: iid3,
      case_id: CASE_ID,
      title: 'FK test 3',
      opened_by: 'tester',
      status: 'open',
      lifecycle: [],
      created_at: new Date().toISOString(),
      description: null,
    };
    investigationStore.replaceRepository({
      getInvestigation: async (id) => (id === iid3 ? validInvRecord : null),
      createObservation: async () => { throw Object.assign(new Error('fk'), { code: '23503' }); },
      getChallengesForInvestigation: async () => [],
      getObservationsForInvestigation: async () => [],
      getInvestigationsForCase: async () => [validInvRecord],
      _reset: () => {},
    });

    const res = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations/${iid3}/observations`)
      .send({ text: 'FK obs', authored_by: 'tester', evidence_ids: ['E-G15-0001'] });
    expect(res.status).toBe(422);
    assertErrorContract(res.body, 'INVALID_REFERENCE', 422);
    assertNoLeak(res.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-5 — Generic DB error → 500 PERSISTENCE_ERROR
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-5: Generic DB error → 500 PERSISTENCE_ERROR', () => {
  it('PF-5-1: POST /investigations — unknown code', async () => {
    investigationStore.replaceRepository(mockRepo('99999', 'unexpected pg error'));
    const res = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'Test', opened_by: 'tester' });
    expect(res.status).toBe(500);
    assertErrorContract(res.body, 'PERSISTENCE_ERROR', 500);
    assertNoLeak(res.body);
  });

  it('PF-5-2: generic Error with no code → 500', async () => {
    investigationStore.replaceRepository(mockRepo(undefined, 'no code here'));
    const res = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'Test', opened_by: 'tester' });
    expect(res.status).toBe(500);
    assertErrorContract(res.body, 'PERSISTENCE_ERROR', 500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-6 — Error body must never leak sensitive implementation details
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-6: No information leakage in error responses', () => {
  const sensitiveMessages = [
    'SELECT * FROM investigations WHERE id = $1',
    'connection string: postgresql://user:secret@db:5432/prod',
    'Error at Object.<anonymous> (server.js:1234:5)\n    at processTicksAndRejections',
    'PG_PASSWORD=hunter2',
    '/Users/deploy/node_modules/pg/lib/client.js:67:19',
  ];

  sensitiveMessages.forEach((msg, i) => {
    it(`PF-6-${i + 1}: sensitive message not reflected in response`, async () => {
      const err = Object.assign(new Error(msg), { code: '99999' });
      investigationStore.replaceRepository({
        createInvestigation: async () => { throw err; },
        _reset: () => {},
      });
      const res = await request(app)
        .post(`/api/cases/${CASE_ID}/investigations`)
        .send({ title: 'Leak test', opened_by: 'tester' });
      expect(res.status).toBe(500);
      const raw = JSON.stringify(res.body);
      // The sensitive message must not appear verbatim in the response
      expect(raw).not.toContain(msg.substring(0, 40));
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-7 — createInvestigation route failures
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-7: POST /api/cases/:id/investigations failures', () => {
  it('PF-7-1: 08006 connection failure → 503', async () => {
    investigationStore.replaceRepository(mockRepo('08006'));
    const r = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'T', opened_by: 'x' });
    expect(r.status).toBe(503);
    assertErrorContract(r.body, 'PERSISTENCE_UNAVAILABLE', 503);
  });

  it('PF-7-2: 40001 serialisation → 503 PERSISTENCE_CONFLICT', async () => {
    investigationStore.replaceRepository(mockRepo('40001'));
    const r = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'T', opened_by: 'x' });
    expect(r.status).toBe(503);
    assertErrorContract(r.body, 'PERSISTENCE_CONFLICT', 503);
  });

  it('PF-7-3: response does not include a partially created record', async () => {
    investigationStore.replaceRepository(mockRepo('08000'));
    const r = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'T', opened_by: 'x' });
    expect(r.body).not.toHaveProperty('investigation_id');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-8 — getInvestigationsForCase route failures
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-8: GET /api/cases/:id/investigations failures', () => {
  it('PF-8-1: DB unavailable → 503', async () => {
    investigationStore.replaceRepository(mockRepo('08003'));
    const r = await request(app).get(`/api/cases/${CASE_ID}/investigations`);
    expect(r.status).toBe(503);
    assertErrorContract(r.body, 'PERSISTENCE_UNAVAILABLE', 503);
    assertNoLeak(r.body);
  });

  it('PF-8-2: generic error → 500', async () => {
    investigationStore.replaceRepository(mockRepo('XXXXX'));
    const r = await request(app).get(`/api/cases/${CASE_ID}/investigations`);
    expect(r.status).toBe(500);
    assertErrorContract(r.body, 'PERSISTENCE_ERROR', 500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-9 — guardInvestigationBelongsToCase failures (GET /investigations/:iid)
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-9: GET /api/cases/:id/investigations/:iid — guard failures', () => {
  it('PF-9-1: getInvestigation DB error during guard → 503', async () => {
    investigationStore.replaceRepository(mockRepo('08001'));
    const r = await request(app)
      .get(`/api/cases/${CASE_ID}/investigations/${NO_SUCH}`);
    expect(r.status).toBe(503);
    assertErrorContract(r.body, 'PERSISTENCE_UNAVAILABLE', 503);
    assertNoLeak(r.body);
  });

  it('PF-9-2: generic guard failure → 500', async () => {
    investigationStore.replaceRepository(mockRepo('ZZZZ'));
    const r = await request(app)
      .get(`/api/cases/${CASE_ID}/investigations/${NO_SUCH}`);
    expect(r.status).toBe(500);
    assertErrorContract(r.body, 'PERSISTENCE_ERROR', 500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-10 — updateInvestigationStatus route failures
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-10: PATCH /api/cases/:id/investigations/:iid failures', () => {
  it('PF-10-1: updateInvestigationStatus DB error → 503', async () => {
    // Create a real investigation first, then replace repo so guard passes
    // but update fails.
    const { body: inv } = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'Patch test', opened_by: 'tester' });
    const iid = inv.investigation_id;

    const validRecord = { ...inv };
    investigationStore.replaceRepository({
      getInvestigation: async (id) => (id === iid ? validRecord : null),
      updateInvestigationStatus: async () => {
        throw Object.assign(new Error('db down'), { code: '08006' });
      },
      _reset: () => {},
    });

    const r = await request(app)
      .patch(`/api/cases/${CASE_ID}/investigations/${iid}`)
      .send({ status: 'closed', actor: 'tester' });
    expect(r.status).toBe(503);
    assertErrorContract(r.body, 'PERSISTENCE_UNAVAILABLE', 503);
    assertNoLeak(r.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-11 — createObservation route failures
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-11: POST /observations failures', () => {
  it('PF-11-1: DB unavailable on createObservation → 503', async () => {
    const { body: inv } = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'Obs fail', opened_by: 'tester' });
    const iid = inv.investigation_id;
    const validRecord = { ...inv };

    investigationStore.replaceRepository({
      getInvestigation: async (id) => (id === iid ? validRecord : null),
      createObservation: async () => {
        throw Object.assign(new Error('db gone'), { code: '08000' });
      },
      _reset: () => {},
    });

    const r = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations/${iid}/observations`)
      .send({ text: 'Test obs', authored_by: 'tester', evidence_ids: [] });
    expect(r.status).toBe(503);
    assertErrorContract(r.body, 'PERSISTENCE_UNAVAILABLE', 503);
    assertNoLeak(r.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-12 — getObservation route failures
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-12: GET /observations/:oid failures', () => {
  it('PF-12-1: getObservation DB error → 503', async () => {
    const { body: inv } = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'Get obs fail', opened_by: 'tester' });
    const iid = inv.investigation_id;
    const validRecord = { ...inv };

    investigationStore.replaceRepository({
      getInvestigation: async (id) => (id === iid ? validRecord : null),
      getObservation: async () => {
        throw Object.assign(new Error('read error'), { code: '08003' });
      },
      _reset: () => {},
    });

    const r = await request(app)
      .get(`/api/cases/${CASE_ID}/investigations/${iid}/observations/${NO_SUCH}`);
    expect(r.status).toBe(503);
    assertErrorContract(r.body, 'PERSISTENCE_UNAVAILABLE', 503);
    assertNoLeak(r.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-13 — getObservationsForInvestigation failures (state route)
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-13: /state route — getObservationsForInvestigation failures', () => {
  it('PF-13-1: state route returns 503 when observations unavailable', async () => {
    const { body: inv } = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'State obs fail', opened_by: 'tester' });
    const iid = inv.investigation_id;
    const validRecord = { ...inv };

    investigationStore.replaceRepository({
      getInvestigation: async (id) => (id === iid ? validRecord : null),
      getObservationsForInvestigation: async () => {
        throw Object.assign(new Error('obs fail'), { code: '08000' });
      },
      getChallengesForInvestigation: async () => [],
      _reset: () => {},
    });

    const r = await request(app)
      .get(`/api/cases/${CASE_ID}/investigations/${iid}/state`);
    expect(r.status).toBe(503);
    assertErrorContract(r.body, 'PERSISTENCE_UNAVAILABLE', 503);
    assertNoLeak(r.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-14 — createChallenge route failures
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-14: POST /challenges failures', () => {
  it('PF-14-1: createChallenge 40001 → 503 PERSISTENCE_CONFLICT', async () => {
    const { body: inv } = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'Challenge fail', opened_by: 'tester' });
    const iid = inv.investigation_id;
    const validRecord = { ...inv };

    investigationStore.replaceRepository({
      getInvestigation: async (id) => (id === iid ? validRecord : null),
      createChallenge: async () => {
        throw Object.assign(new Error('serialise'), { code: '40001' });
      },
      _reset: () => {},
    });

    const r = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations/${iid}/challenges`)
      .send({
        target_type:       'hypothesis_assessment',
        target_id:         'H1',
        authored_by:       'tester',
        analyst_statement: 'Challenge test.',
        evidence_ids:      [],
      });
    expect(r.status).toBe(503);
    assertErrorContract(r.body, 'PERSISTENCE_CONFLICT', 503);
    assertNoLeak(r.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-15 — getChallenge route failures
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-15: GET /challenges/:cid failures', () => {
  it('PF-15-1: getChallenge DB error → 500', async () => {
    const { body: inv } = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'Get chal fail', opened_by: 'tester' });
    const iid = inv.investigation_id;
    const validRecord = { ...inv };

    investigationStore.replaceRepository({
      getInvestigation: async (id) => (id === iid ? validRecord : null),
      getChallenge: async () => {
        throw Object.assign(new Error('generic read'), { code: 'ZZZZ' });
      },
      _reset: () => {},
    });

    const r = await request(app)
      .get(`/api/cases/${CASE_ID}/investigations/${iid}/challenges/${NO_SUCH}`);
    expect(r.status).toBe(500);
    assertErrorContract(r.body, 'PERSISTENCE_ERROR', 500);
    assertNoLeak(r.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-16 — getChallengesForInvestigation failures (list route)
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-16: GET /challenges (list) — getChallengesForInvestigation failures', () => {
  it('PF-16-1: list challenges DB error → 503', async () => {
    const { body: inv } = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'Chal list fail', opened_by: 'tester' });
    const iid = inv.investigation_id;
    const validRecord = { ...inv };

    investigationStore.replaceRepository({
      getInvestigation: async (id) => (id === iid ? validRecord : null),
      getChallengesForInvestigation: async () => {
        throw Object.assign(new Error('list fail'), { code: '08006' });
      },
      _reset: () => {},
    });

    const r = await request(app)
      .get(`/api/cases/${CASE_ID}/investigations/${iid}/challenges`);
    expect(r.status).toBe(503);
    assertErrorContract(r.body, 'PERSISTENCE_UNAVAILABLE', 503);
    assertNoLeak(r.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-17 — transitionChallenge route failures
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-17: PATCH /challenges/:cid — transitionChallenge failures', () => {
  it('PF-17-1: transitionChallenge 40P01 deadlock → 503 PERSISTENCE_CONFLICT', async () => {
    const { body: inv } = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'Transition fail', opened_by: 'tester' });
    const iid = inv.investigation_id;
    const validRecord = { ...inv };

    const mockChal = {
      challenge_id:      NO_SUCH,
      investigation_id:  iid,
      case_id:           CASE_ID,
      status:            'open',
      target_type:       'hypothesis',
      target_id:         'H1',
      authored_by:       'tester',
      analyst_statement: 'test',
      evidence_ids:      [],
      lifecycle:         [],
      created_at:        new Date().toISOString(),
      resolution_metadata: null,
    };

    investigationStore.replaceRepository({
      getInvestigation: async (id) => (id === iid ? validRecord : null),
      getChallenge: async (id) => (id === NO_SUCH ? mockChal : null),
      transitionChallenge: async () => {
        throw Object.assign(new Error('deadlock'), { code: '40P01' });
      },
      _reset: () => {},
    });

    const r = await request(app)
      .patch(`/api/cases/${CASE_ID}/investigations/${iid}/challenges/${NO_SUCH}`)
      .send({ status: 'under_review', actor: 'tester' });
    expect(r.status).toBe(503);
    assertErrorContract(r.body, 'PERSISTENCE_CONFLICT', 503);
    assertNoLeak(r.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-18 — getChallengesForCase failures
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-18: GET /api/cases/:id/challenges — getChallengesForCase failures', () => {
  it('PF-18-1: getChallengesForCase DB error → 503', async () => {
    investigationStore.replaceRepository(mockRepo('08003'));
    const r = await request(app).get(`/api/cases/${CASE_ID}/challenges`);
    expect(r.status).toBe(503);
    assertErrorContract(r.body, 'PERSISTENCE_UNAVAILABLE', 503);
    assertNoLeak(r.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-19 — getInvestigationHistory failures
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-19: GET /history — getInvestigationHistory failures', () => {
  it('PF-19-1: history DB error → 503', async () => {
    const { body: inv } = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'History fail', opened_by: 'tester' });
    const iid = inv.investigation_id;
    const validRecord = { ...inv };

    investigationStore.replaceRepository({
      getInvestigation: async (id) => (id === iid ? validRecord : null),
      getInvestigationHistory: async () => {
        throw Object.assign(new Error('history gone'), { code: '08000' });
      },
      _reset: () => {},
    });

    const r = await request(app)
      .get(`/api/cases/${CASE_ID}/investigations/${iid}/history`);
    expect(r.status).toBe(503);
    assertErrorContract(r.body, 'PERSISTENCE_UNAVAILABLE', 503);
    assertNoLeak(r.body);
  });

  it('PF-19-2: history generic DB error → 500', async () => {
    const { body: inv } = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'History fail 2', opened_by: 'tester' });
    const iid = inv.investigation_id;
    const validRecord = { ...inv };

    investigationStore.replaceRepository({
      getInvestigation: async (id) => (id === iid ? validRecord : null),
      getInvestigationHistory: async () => {
        throw Object.assign(new Error('weird error'), { code: 'CUSTOM_ERR' });
      },
      _reset: () => {},
    });

    const r = await request(app)
      .get(`/api/cases/${CASE_ID}/investigations/${iid}/history`);
    expect(r.status).toBe(500);
    assertErrorContract(r.body, 'PERSISTENCE_ERROR', 500);
    assertNoLeak(r.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-20 — Happy path still works after mock replaced with real repo
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-20: Happy path after mock repo restored', () => {
  it('PF-20-1: inject failure then restore → subsequent create succeeds', async () => {
    // Inject failure
    investigationStore.replaceRepository(mockRepo('08000'));
    const fail = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'Fail first', opened_by: 'tester' });
    expect(fail.status).toBe(503);

    // Restore real repo
    investigationStore.replaceRepository(null);
    investigationStore._reset();

    const ok = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'After restore', opened_by: 'tester' });
    expect(ok.status).toBe(201);
    expect(ok.body).toHaveProperty('investigation_id');
  });

  it('PF-20-2: list after failure and restore returns real data', async () => {
    investigationStore.replaceRepository(mockRepo('08006'));
    const fail = await request(app).get(`/api/cases/${CASE_ID}/investigations`);
    expect(fail.status).toBe(503);

    investigationStore.replaceRepository(null);
    investigationStore._reset();

    await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'After list fail', opened_by: 'tester' });

    const ok = await request(app).get(`/api/cases/${CASE_ID}/investigations`);
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body)).toBe(true);
    expect(ok.body.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-21 — ETIMEDOUT message triggers PERSISTENCE_UNAVAILABLE
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-21: ETIMEDOUT message pattern → 503 PERSISTENCE_UNAVAILABLE', () => {
  it('PF-21-1: "connect ETIMEDOUT" in message → 503', async () => {
    const err = new Error('connect ETIMEDOUT 10.0.0.1:5432');
    // No pg code — pure message matching
    investigationStore.replaceRepository({
      createInvestigation: async () => { throw err; },
      _reset: () => {},
    });
    const r = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'Timeout test', opened_by: 'tester' });
    expect(r.status).toBe(503);
    assertErrorContract(r.body, 'PERSISTENCE_UNAVAILABLE', 503);
    assertNoLeak(r.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-22 — "Connection terminated" message triggers PERSISTENCE_UNAVAILABLE
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-22: "Connection terminated" message → 503 PERSISTENCE_UNAVAILABLE', () => {
  it('PF-22-1: "Connection terminated unexpectedly" → 503', async () => {
    const err = new Error('Connection terminated unexpectedly');
    investigationStore.replaceRepository({
      createInvestigation: async () => { throw err; },
      _reset: () => {},
    });
    const r = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'Conn term', opened_by: 'tester' });
    expect(r.status).toBe(503);
    assertErrorContract(r.body, 'PERSISTENCE_UNAVAILABLE', 503);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-23 — 57P03 (pg_sleep / startup) → 503 PERSISTENCE_UNAVAILABLE
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-23: 57P03 startup error → 503 PERSISTENCE_UNAVAILABLE', () => {
  it('PF-23-1: on getInvestigationsForCase', async () => {
    investigationStore.replaceRepository(mockRepo('57P03'));
    const r = await request(app).get(`/api/cases/${CASE_ID}/investigations`);
    expect(r.status).toBe(503);
    assertErrorContract(r.body, 'PERSISTENCE_UNAVAILABLE', 503);
    assertNoLeak(r.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-24 — 53300 remaining connection slots → 503 PERSISTENCE_UNAVAILABLE
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-24: 53300 connection slots exhausted → 503 PERSISTENCE_UNAVAILABLE', () => {
  it('PF-24-1: on createInvestigation', async () => {
    investigationStore.replaceRepository(mockRepo('53300'));
    const r = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'Slots full', opened_by: 'tester' });
    expect(r.status).toBe(503);
    assertErrorContract(r.body, 'PERSISTENCE_UNAVAILABLE', 503);
    assertNoLeak(r.body);
  });

  it('PF-24-2: on getInvestigationHistory', async () => {
    const { body: inv } = await request(app)
      .post(`/api/cases/${CASE_ID}/investigations`)
      .send({ title: 'History slots', opened_by: 'tester' });
    const iid = inv.investigation_id;
    const validRecord = { ...inv };

    investigationStore.replaceRepository({
      getInvestigation: async (id) => (id === iid ? validRecord : null),
      getInvestigationHistory: async () => {
        throw Object.assign(new Error('slots'), { code: '53300' });
      },
      _reset: () => {},
    });

    const r = await request(app)
      .get(`/api/cases/${CASE_ID}/investigations/${iid}/history`);
    expect(r.status).toBe(503);
    assertErrorContract(r.body, 'PERSISTENCE_UNAVAILABLE', 503);
  });
});
