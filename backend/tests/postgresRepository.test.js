'use strict';

/**
 * Phase 8.2 — PostgresInvestigationRepository Integration Tests
 *
 * These tests exercise the real PostgreSQL database (spaceforensics_test).
 * They are skipped automatically when PG_DATABASE is not set so the standard
 * Jest run (which uses the in-memory repository) remains fast and
 * fully deterministic.
 *
 * To run manually:
 *   PG_DATABASE=spaceforensics_test npx jest tests/postgresRepository.test.js
 *
 * Prerequisites:
 *   - PostgreSQL running on localhost:5432
 *   - Database spaceforensics_test exists and is owned by the current OS user
 *   - Migration 001 has been applied:
 *       psql -d spaceforensics_test -f db/migrations/001_create_investigations.sql
 *
 * Coverage:
 *   PG-MIGRATE  migration succeeds from a clean database
 *   PG-1        createInvestigation / getInvestigation round-trip
 *   PG-2        getInvestigationsForCase returns only that case's records
 *   PG-3        updateInvestigationStatus persists across a new repository instance
 *   PG-4        getInvestigation returns null for unknown id
 *   PG-5        createObservation / getObservation round-trip (evidence + hypothesis refs)
 *   PG-6        getObservationsForInvestigation scoping
 *   PG-7        updateObservation appends a version (persists on re-read)
 *   PG-8        createChallenge / getChallenge round-trip
 *   PG-9        getChallengesForInvestigation / getChallengesForCase scoping
 *   PG-10       transitionChallenge persists lifecycle
 *   PG-11       transitionChallenge resolved — resolution_metadata persists
 *   PG-12       reviewChallenge accepted → acknowledged resolution
 *   PG-13       getInvestigationHistory assembles all entities correctly
 *   PG-RESTART  data survives repository / Pool recreation (restart simulation)
 *   PG-ISOLATE  two investigations remain completely isolated
 *   PG-UNKNOWN  unknown investigation / observation / challenge return null
 *   PG-CLOSED   closed investigation rejects further status changes
 *   PG-TERMINAL terminal challenge cannot be re-transitioned
 *   PG-NORAW    no evidence rows, no forensic fields in any persisted record
 */

const { Pool }     = require('pg');
const { runMigrations } = require('../db/migrate');
const { PostgresInvestigationRepository } = require('../services/PostgresInvestigationRepository');

// ---------------------------------------------------------------------------
// Skip the whole file when PG_DATABASE is not configured.
// This keeps the default Jest run (npm test) identical to Phase 7 behaviour.
// ---------------------------------------------------------------------------
const PG_DATABASE = process.env.PG_DATABASE || 'spaceforensics_test';
const SKIP = !process.env.PG_DATABASE && !process.env.RUN_PG_TESTS;

const describeOrSkip = SKIP ? describe.skip : describe;

// ---------------------------------------------------------------------------
// Shared pool for the test run. Created once, closed in afterAll.
// ---------------------------------------------------------------------------
let pool;
let repo;

beforeAll(async () => {
  if (SKIP) return;

  pool = new Pool({
    host:     process.env.PG_HOST     || 'localhost',
    port:     parseInt(process.env.PG_PORT || '5432', 10),
    database: PG_DATABASE,
    user:     process.env.PG_USER     || undefined,
    password: process.env.PG_PASSWORD || undefined,
    ssl:      false,
    max: 5,
    idleTimeoutMillis:    5_000,
    connectionTimeoutMillis: 5_000,
  });

  // Apply migrations (idempotent).
  await runMigrations(pool);

  repo = new PostgresInvestigationRepository(pool);
}, 30_000);

afterAll(async () => {
  if (pool) await pool.end();
});

// Clean all rows before each test so tests are isolated.
beforeEach(async () => {
  if (SKIP) return;
  await pool.query('TRUNCATE investigations CASCADE');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeInv(caseId = 'galaxy-15') {
  return repo.createInvestigation({ case_id: caseId, title: 'Test investigation', opened_by: 'analyst' });
}

async function makeObs(invId) {
  return repo.createObservation({
    investigation_id: invId,
    text: 'Observed elevated electron flux contemporaneous with anomaly.',
    authored_by: 'analyst',
    evidence_ids: ['E-G15-0001', 'E-G15-0010'],
    hypothesis_ids: ['H1', 'H5'],
  });
}

async function makeChallenge(invId, caseId = 'galaxy-15') {
  return repo.createChallenge({
    investigation_id: invId,
    case_id: caseId,
    target_type: 'hypothesis_assessment',
    target_id: 'H1',
    authored_by: 'analyst',
    analyst_statement: 'The H1 mixed assessment appears inconsistent with H5 strong support.',
    evidence_ids: ['E-G15-0001'],
  });
}

// ===========================================================================
// PG-MIGRATE — migration is idempotent
// ===========================================================================

describeOrSkip('PG-MIGRATE: migration is idempotent', () => {
  test('PG-MIGRATE-1: running migrations twice does not throw', async () => {
    await expect(runMigrations(pool)).resolves.not.toThrow();
  });

  test('PG-MIGRATE-2: schema_migrations table contains migration 001', async () => {
    const res = await pool.query("SELECT version FROM schema_migrations WHERE version = '001_create_investigations'");
    expect(res.rows).toHaveLength(1);
  });

  test('PG-MIGRATE-3: all expected tables exist', async () => {
    const expected = [
      'investigations', 'investigation_events',
      'observations', 'observation_versions', 'observation_evidence', 'observation_hypotheses',
      'challenges', 'challenge_lifecycle', 'challenge_evidence',
    ];
    for (const table of expected) {
      const res = await pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=$1",
        [table],
      );
      expect(res.rows).toHaveLength(1);
    }
  });
});

// ===========================================================================
// PG-1 — createInvestigation / getInvestigation round-trip
// ===========================================================================

describeOrSkip('PG-1: createInvestigation / getInvestigation', () => {
  test('PG-1-1: returned record has all required fields', async () => {
    const inv = await makeInv();
    expect(inv.investigation_id).toMatch(UUID_RE);
    expect(inv.case_id).toBe('galaxy-15');
    expect(inv.title).toBe('Test investigation');
    expect(inv.opened_by).toBe('analyst');
    expect(inv.status).toBe('open');
    expect(inv.opened_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Array.isArray(inv.events)).toBe(true);
    expect(inv.events).toHaveLength(1);
    expect(inv.events[0].event).toBe('opened');
    expect(inv.events[0].actor).toBe('analyst');
  });

  test('PG-1-2: getInvestigation retrieves the same record', async () => {
    const inv = await makeInv();
    const fetched = await repo.getInvestigation(inv.investigation_id);
    expect(fetched).not.toBeNull();
    expect(fetched.investigation_id).toBe(inv.investigation_id);
    expect(fetched.case_id).toBe(inv.case_id);
    expect(fetched.title).toBe(inv.title);
    expect(fetched.status).toBe('open');
    expect(fetched.events).toHaveLength(1);
  });

  test('PG-1-3: each createInvestigation call generates a distinct UUID', async () => {
    const inv1 = await makeInv();
    const inv2 = await makeInv();
    expect(inv1.investigation_id).not.toBe(inv2.investigation_id);
  });

  test('PG-1-4: no forensic fields in the investigation record', async () => {
    const inv = await makeInv();
    expect(inv).not.toHaveProperty('causal_attribution_established');
    expect(inv).not.toHaveProperty('assessment');
    expect(inv).not.toHaveProperty('evidence_rows');
    expect(inv).not.toHaveProperty('hypothesis_assessments');
  });
});

// ===========================================================================
// PG-2 — getInvestigationsForCase
// ===========================================================================

describeOrSkip('PG-2: getInvestigationsForCase', () => {
  test('PG-2-1: returns only records for the requested case', async () => {
    await makeInv('galaxy-15');
    await makeInv('test-case-alpha');
    await makeInv('galaxy-15');

    const g15 = await repo.getInvestigationsForCase('galaxy-15');
    const tca = await repo.getInvestigationsForCase('test-case-alpha');

    expect(g15).toHaveLength(2);
    expect(tca).toHaveLength(1);
    for (const inv of g15) expect(inv.case_id).toBe('galaxy-15');
    for (const inv of tca) expect(inv.case_id).toBe('test-case-alpha');
  });

  test('PG-2-2: returns empty array when case has no investigations', async () => {
    const list = await repo.getInvestigationsForCase('does-not-exist');
    expect(list).toEqual([]);
  });
});

// ===========================================================================
// PG-3 — updateInvestigationStatus persists across repository instance
// ===========================================================================

describeOrSkip('PG-3: updateInvestigationStatus persistence', () => {
  test('PG-3-1: status change survives a new repository instance (restart simulation)', async () => {
    const inv = await makeInv();

    // Perform status transition with the current repo.
    const result = await repo.updateInvestigationStatus(inv.investigation_id, {
      status: 'suspended',
      actor: 'analyst',
      reason: 'Awaiting additional telemetry.',
    });
    expect(result.ok).toBe(true);
    expect(result.record.status).toBe('suspended');

    // Simulate restart: create a fresh repository with the same pool.
    const freshRepo = new PostgresInvestigationRepository(pool);
    const fetched = await freshRepo.getInvestigation(inv.investigation_id);

    expect(fetched).not.toBeNull();
    expect(fetched.status).toBe('suspended');
    expect(fetched.events).toHaveLength(2);
    expect(fetched.events[1].event).toBe('suspended');
    expect(fetched.events[1].actor).toBe('analyst');
    expect(fetched.events[1].reason).toBe('Awaiting additional telemetry.');
  });

  test('PG-3-2: open → suspended → closed lifecycle persists', async () => {
    const inv = await makeInv();

    await repo.updateInvestigationStatus(inv.investigation_id, { status: 'suspended', actor: 'a' });
    await repo.updateInvestigationStatus(inv.investigation_id, { status: 'closed',    actor: 'b' });

    const fetched = await repo.getInvestigation(inv.investigation_id);
    expect(fetched.status).toBe('closed');
    expect(fetched.events).toHaveLength(3);
    expect(fetched.events.map((e) => e.event)).toEqual(['opened', 'suspended', 'closed']);
  });

  test('PG-3-3: closed investigation rejects further status changes', async () => {
    const inv = await makeInv();
    await repo.updateInvestigationStatus(inv.investigation_id, { status: 'closed', actor: 'a' });

    const result = await repo.updateInvestigationStatus(inv.investigation_id, {
      status: 'suspended', actor: 'b',
    });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(409);
  });
});

// ===========================================================================
// PG-4 — getInvestigation null for unknown ID
// ===========================================================================

describeOrSkip('PG-4: unknown entity returns null / not-found', () => {
  test('PG-4-1: getInvestigation returns null for unknown id', async () => {
    expect(await repo.getInvestigation('no-such-id')).toBeNull();
  });

  test('PG-4-2: getObservation returns null for unknown id', async () => {
    expect(await repo.getObservation('no-such-id')).toBeNull();
  });

  test('PG-4-3: getChallenge returns null for unknown id', async () => {
    expect(await repo.getChallenge('no-such-id')).toBeNull();
  });

  test('PG-4-4: updateInvestigationStatus returns status_code 404 for unknown investigation', async () => {
    const result = await repo.updateInvestigationStatus('no-such-id', { status: 'open' });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(404);
  });
});

// ===========================================================================
// PG-5 — createObservation / getObservation round-trip
// ===========================================================================

describeOrSkip('PG-5: createObservation / getObservation', () => {
  test('PG-5-1: observation persists with evidence_ids and hypothesis_ids', async () => {
    const inv = await makeInv();
    const obs = await makeObs(inv.investigation_id);

    const fetched = await repo.getObservation(obs.observation_id);
    expect(fetched).not.toBeNull();
    expect(fetched.observation_id).toBe(obs.observation_id);
    expect(fetched.investigation_id).toBe(inv.investigation_id);
    expect(fetched.status).toBe('published');
    expect(fetched.versions).toHaveLength(1);
    expect(fetched.versions[0].text).toBe('Observed elevated electron flux contemporaneous with anomaly.');
    expect(fetched.versions[0].version).toBe(1);
    expect(fetched.evidence_ids).toEqual(expect.arrayContaining(['E-G15-0001', 'E-G15-0010']));
    expect(fetched.hypothesis_ids).toEqual(expect.arrayContaining(['H1', 'H5']));
  });

  test('PG-5-2: observation carries no forensic data', async () => {
    const inv = await makeInv();
    const obs = await makeObs(inv.investigation_id);
    expect(obs).not.toHaveProperty('evidence_rows');
    expect(obs).not.toHaveProperty('causal_attribution_established');
    expect(obs).not.toHaveProperty('assessment');
  });
});

// ===========================================================================
// PG-6 — getObservationsForInvestigation scoping
// ===========================================================================

describeOrSkip('PG-6: getObservationsForInvestigation', () => {
  test('PG-6-1: returns only observations for the requested investigation', async () => {
    const inv1 = await makeInv();
    const inv2 = await makeInv();

    await makeObs(inv1.investigation_id);
    await makeObs(inv1.investigation_id);
    await makeObs(inv2.investigation_id);

    const obs1 = await repo.getObservationsForInvestigation(inv1.investigation_id);
    const obs2 = await repo.getObservationsForInvestigation(inv2.investigation_id);

    expect(obs1).toHaveLength(2);
    expect(obs2).toHaveLength(1);
    for (const o of obs1) expect(o.investigation_id).toBe(inv1.investigation_id);
    for (const o of obs2) expect(o.investigation_id).toBe(inv2.investigation_id);
  });
});

// ===========================================================================
// PG-7 — updateObservation appends version
// ===========================================================================

describeOrSkip('PG-7: updateObservation', () => {
  test('PG-7-1: update appends a new version and persists on re-read', async () => {
    const inv = await makeInv();
    const obs = await makeObs(inv.investigation_id);

    const result = await repo.updateObservation(obs.observation_id, {
      text: 'Updated: flux exceeded 1 MeV threshold 12 minutes before anomaly.',
      authored_by: 'senior-analyst',
    });
    expect(result.ok).toBe(true);
    expect(result.record.versions).toHaveLength(2);
    expect(result.record.versions[1].version).toBe(2);
    expect(result.record.versions[1].text).toContain('Updated:');

    // Verify persistence: fresh read
    const freshRepo = new PostgresInvestigationRepository(pool);
    const fetched = await freshRepo.getObservation(obs.observation_id);
    expect(fetched.versions).toHaveLength(2);
    expect(fetched.versions[1].text).toContain('Updated:');
  });

  test('PG-7-2: updateObservation returns 404 for unknown observation', async () => {
    const result = await repo.updateObservation('no-such-id', { text: 'x' });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(404);
  });
});

// ===========================================================================
// PG-8 — createChallenge / getChallenge round-trip
// ===========================================================================

describeOrSkip('PG-8: createChallenge / getChallenge', () => {
  test('PG-8-1: challenge persists with lifecycle and evidence_ids', async () => {
    const inv = await makeInv();
    const { ok, record } = await makeChallenge(inv.investigation_id);

    expect(ok).toBe(true);
    expect(record.challenge_id).toMatch(UUID_RE);
    expect(record.case_id).toBe('galaxy-15');
    expect(record.target_type).toBe('hypothesis_assessment');
    expect(record.status).toBe('open');
    expect(record.evidence_ids).toEqual(['E-G15-0001']);
    expect(record.lifecycle).toHaveLength(1);
    expect(record.lifecycle[0].status).toBe('open');
    expect(record.resolution_metadata).toBeNull();

    const fetched = await repo.getChallenge(record.challenge_id);
    expect(fetched).not.toBeNull();
    expect(fetched.challenge_id).toBe(record.challenge_id);
    expect(fetched.analyst_statement).toContain('H1 mixed assessment');
    expect(fetched.lifecycle).toHaveLength(1);
  });

  test('PG-8-2: challenge carries no forensic data', async () => {
    const inv = await makeInv();
    const { record } = await makeChallenge(inv.investigation_id);
    expect(record).not.toHaveProperty('causal_attribution_established');
    expect(record).not.toHaveProperty('assessment');
    expect(record).not.toHaveProperty('evidence_rows');
  });
});

// ===========================================================================
// PG-9 — getChallengesForInvestigation / getChallengesForCase
// ===========================================================================

describeOrSkip('PG-9: challenge list scoping', () => {
  test('PG-9-1: getChallengesForInvestigation returns only that investigation\'s challenges', async () => {
    const inv1 = await makeInv('galaxy-15');
    const inv2 = await makeInv('galaxy-15');

    await makeChallenge(inv1.investigation_id, 'galaxy-15');
    await makeChallenge(inv1.investigation_id, 'galaxy-15');
    await makeChallenge(inv2.investigation_id, 'galaxy-15');

    const c1 = await repo.getChallengesForInvestigation(inv1.investigation_id);
    const c2 = await repo.getChallengesForInvestigation(inv2.investigation_id);

    expect(c1).toHaveLength(2);
    expect(c2).toHaveLength(1);
    for (const c of c1) expect(c.investigation_id).toBe(inv1.investigation_id);
  });

  test('PG-9-2: getChallengesForCase returns all challenges for that case', async () => {
    const inv1 = await makeInv('galaxy-15');
    const inv2 = await makeInv('test-case-alpha');

    await makeChallenge(inv1.investigation_id, 'galaxy-15');
    await makeChallenge(inv2.investigation_id, 'test-case-alpha');

    const g15 = await repo.getChallengesForCase('galaxy-15');
    const tca = await repo.getChallengesForCase('test-case-alpha');

    expect(g15).toHaveLength(1);
    expect(tca).toHaveLength(1);
    expect(g15[0].case_id).toBe('galaxy-15');
    expect(tca[0].case_id).toBe('test-case-alpha');
  });
});

// ===========================================================================
// PG-10 — transitionChallenge lifecycle persistence
// ===========================================================================

describeOrSkip('PG-10: transitionChallenge lifecycle', () => {
  test('PG-10-1: open → under_review persists lifecycle entry', async () => {
    const inv = await makeInv();
    const { record } = await makeChallenge(inv.investigation_id);

    const result = await repo.transitionChallenge(record.challenge_id, {
      status: 'under_review',
      actor: 'reviewer',
      notes: 'Taking it for review.',
    });
    expect(result.ok).toBe(true);
    expect(result.record.status).toBe('under_review');
    expect(result.record.lifecycle).toHaveLength(2);
    expect(result.record.lifecycle[1].status).toBe('under_review');
    expect(result.record.lifecycle[1].actor).toBe('reviewer');

    // Fresh read confirms persistence.
    const fetched = await repo.getChallenge(record.challenge_id);
    expect(fetched.status).toBe('under_review');
    expect(fetched.lifecycle).toHaveLength(2);
  });

  test('PG-10-2: transition to terminal state blocks further transitions (409)', async () => {
    const inv = await makeInv();
    const { record } = await makeChallenge(inv.investigation_id);

    await repo.transitionChallenge(record.challenge_id, { status: 'rejected', actor: 'a' });

    const result = await repo.transitionChallenge(record.challenge_id, {
      status: 'under_review', actor: 'b',
    });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(409);
  });
});

// ===========================================================================
// PG-11 — transitionChallenge resolved → resolution_metadata
// ===========================================================================

describeOrSkip('PG-11: resolved challenge resolution_metadata', () => {
  test('PG-11-1: resolution_metadata is persisted correctly', async () => {
    const inv = await makeInv();
    const { record } = await makeChallenge(inv.investigation_id);

    await repo.transitionChallenge(record.challenge_id, {
      status: 'under_review', actor: 'reviewer',
    });
    const result = await repo.transitionChallenge(record.challenge_id, {
      status:             'resolved',
      actor:              'reviewer',
      notes:              'Acknowledged — additional data confirms context.',
      resolution_outcome: 'acknowledged',
    });

    expect(result.ok).toBe(true);
    const resolved = result.record;
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolution_metadata).not.toBeNull();
    expect(resolved.resolution_metadata.resolution_outcome).toBe('acknowledged');
    expect(resolved.resolution_metadata.resolved_by).toBe('reviewer');
    expect(resolved.resolution_metadata.resolved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Confirm persistence via fresh read.
    const freshRepo = new PostgresInvestigationRepository(pool);
    const fetched = await freshRepo.getChallenge(record.challenge_id);
    expect(fetched.resolution_metadata.resolution_outcome).toBe('acknowledged');
    expect(fetched.lifecycle).toHaveLength(3);
  });

  test('PG-11-2: resolution requires resolution_outcome', async () => {
    const inv = await makeInv();
    const { record } = await makeChallenge(inv.investigation_id);

    await repo.transitionChallenge(record.challenge_id, { status: 'under_review', actor: 'a' });

    const result = await repo.transitionChallenge(record.challenge_id, {
      status: 'resolved', actor: 'a',
      // no resolution_outcome
    });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(422);
  });
});

// ===========================================================================
// PG-12 — reviewChallenge (accepted → acknowledged)
// ===========================================================================

describeOrSkip('PG-12: reviewChallenge', () => {
  test('PG-12-1: accepted maps to resolved / acknowledged', async () => {
    const inv = await makeInv();
    const { record } = await makeChallenge(inv.investigation_id);

    await repo.transitionChallenge(record.challenge_id, { status: 'under_review', actor: 'a' });

    const result = await repo.reviewChallenge(record.challenge_id, {
      status: 'accepted',
      reviewed_by: 'lead-analyst',
      review_notes: 'Context acknowledged.',
    });
    expect(result.ok).toBe(true);
    expect(result.record.status).toBe('resolved');
    expect(result.record.resolution_metadata.resolution_outcome).toBe('acknowledged');
  });
});

// ===========================================================================
// PG-13 — getInvestigationHistory assembles all entities
// ===========================================================================

describeOrSkip('PG-13: getInvestigationHistory', () => {
  test('PG-13-1: history includes events, observations, and challenges', async () => {
    const inv = await makeInv();
    const obs = await makeObs(inv.investigation_id);
    const { record: chal } = await makeChallenge(inv.investigation_id);

    await repo.updateInvestigationStatus(inv.investigation_id, { status: 'suspended', actor: 'a' });

    const history = await repo.getInvestigationHistory(inv.investigation_id);

    expect(history).not.toBeNull();
    expect(history.investigation_id).toBe(inv.investigation_id);
    expect(history.events).toHaveLength(2);
    expect(history.observations).toHaveLength(1);
    expect(history.observations[0].observation_id).toBe(obs.observation_id);
    expect(history.observations[0].current_text).toContain('electron flux');
    expect(history.observations[0].versions).toHaveLength(1);
    expect(history.challenges).toHaveLength(1);
    expect(history.challenges[0].challenge_id).toBe(chal.challenge_id);
  });

  test('PG-13-2: returns null for unknown investigation', async () => {
    expect(await repo.getInvestigationHistory('no-such-id')).toBeNull();
  });
});

// ===========================================================================
// PG-RESTART — data survives Pool recreation
// ===========================================================================

describeOrSkip('PG-RESTART: data survives repository/Pool recreation', () => {
  test('PG-RESTART-1: investigation created with pool A is readable with fresh pool B', async () => {
    const inv = await makeInv();
    const obs = await makeObs(inv.investigation_id);
    const { record: chal } = await makeChallenge(inv.investigation_id);

    // Create a completely independent pool — simulates process restart.
    const pool2 = new Pool({
      host:     process.env.PG_HOST     || 'localhost',
      port:     parseInt(process.env.PG_PORT || '5432', 10),
      database: PG_DATABASE,
      user:     process.env.PG_USER     || undefined,
      password: process.env.PG_PASSWORD || undefined,
      ssl:      false,
      max: 2,
    });

    try {
      const repo2 = new PostgresInvestigationRepository(pool2);

      const fetchedInv = await repo2.getInvestigation(inv.investigation_id);
      expect(fetchedInv).not.toBeNull();
      expect(fetchedInv.investigation_id).toBe(inv.investigation_id);
      expect(fetchedInv.case_id).toBe('galaxy-15');

      const fetchedObs = await repo2.getObservation(obs.observation_id);
      expect(fetchedObs).not.toBeNull();
      expect(fetchedObs.evidence_ids).toContain('E-G15-0001');

      const fetchedChal = await repo2.getChallenge(chal.challenge_id);
      expect(fetchedChal).not.toBeNull();
      expect(fetchedChal.analyst_statement).toContain('H1 mixed assessment');
    } finally {
      await pool2.end();
    }
  });
});

// ===========================================================================
// PG-ISOLATE — two investigations remain completely isolated
// ===========================================================================

describeOrSkip('PG-ISOLATE: cross-investigation isolation', () => {
  test('PG-ISOLATE-1: observations and challenges for inv-A are invisible from inv-B', async () => {
    const invA = await makeInv('galaxy-15');
    const invB = await makeInv('galaxy-15');

    await makeObs(invA.investigation_id);
    await makeChallenge(invA.investigation_id, 'galaxy-15');

    const obsB  = await repo.getObservationsForInvestigation(invB.investigation_id);
    const chalB = await repo.getChallengesForInvestigation(invB.investigation_id);

    expect(obsB).toHaveLength(0);
    expect(chalB).toHaveLength(0);
  });

  test('PG-ISOLATE-2: updating inv-A status does not affect inv-B status', async () => {
    const invA = await makeInv();
    const invB = await makeInv();

    await repo.updateInvestigationStatus(invA.investigation_id, { status: 'closed', actor: 'a' });

    const fetchedB = await repo.getInvestigation(invB.investigation_id);
    expect(fetchedB.status).toBe('open');
  });
});

// ===========================================================================
// PG-NORAW — no forensic / evidence data stored
// ===========================================================================

describeOrSkip('PG-NORAW: forensic boundary', () => {
  test('PG-NORAW-1: investigations table has no forensic columns', async () => {
    const res = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'investigations'",
    );
    const cols = res.rows.map((r) => r.column_name);
    expect(cols).not.toContain('causal_attribution_established');
    expect(cols).not.toContain('assessment');
    expect(cols).not.toContain('evidence_value');
    expect(cols).not.toContain('evidence_timestamp');
  });

  test('PG-NORAW-2: challenges table has no forensic columns', async () => {
    const res = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'challenges'",
    );
    const cols = res.rows.map((r) => r.column_name);
    expect(cols).not.toContain('causal_attribution_established');
    expect(cols).not.toContain('assessment');
  });
});
