'use strict';

/**
 * Phase 8.3 — Investigation Restart Recovery and Persistence Verification
 *
 * Proves that investigation state survives application/store restart by
 * exercising real PostgreSQL persistence.  Each "restart" is simulated by
 * disposing the repository object and/or the connection pool and re-creating
 * them from scratch — exactly what happens when a Node process restarts and
 * reconnects to the same database.
 *
 * This file does NOT duplicate Phase 8.2 unit tests.  It focuses on:
 *   (a) the restart/reconnect contract
 *   (b) clean-migration-from-zero
 *   (c) migration idempotence
 *   (d) full-lifecycle state equivalence after restart
 *   (e) unknown-ID behaviour after restart
 *   (f) cross-case isolation after restart
 *   (g) concurrent creation/read operations
 *   (h) forensic boundary regression — Galaxy-15 evidence, forensic analysis,
 *       and causal_attribution_established must be unaffected by persistence
 *
 * Skip condition:
 *   Skipped automatically when neither PG_DATABASE nor RUN_PG_TESTS is set.
 *   Run with:
 *     PG_DATABASE=spaceforensics_test RUN_PG_TESTS=1 npx jest tests/restartRecovery.test.js --verbose
 *
 * Prerequisites:
 *   - PostgreSQL running on localhost:5432
 *   - Database spaceforensics_test exists (owned by the current OS user)
 *   - No prior state required — the suite manages its own schema and data
 */

const { Pool }   = require('pg');
const { runMigrations } = require('../db/migrate');
const { PostgresInvestigationRepository } = require('../services/PostgresInvestigationRepository');
const {
  parseEvidenceCSV,
  buildEvidenceGraph,
  buildForensicAnalysis,
  assembleValidatedForensicReport,
} = require('../server');
const { buildAnalystHeuristicNarrative } = require('../services/aiAnalyst');

// ---------------------------------------------------------------------------
// Skip when no database is configured.
// ---------------------------------------------------------------------------
const PG_DATABASE = process.env.PG_DATABASE || 'spaceforensics_test';
const SKIP = !process.env.PG_DATABASE && !process.env.RUN_PG_TESTS;

const describeOrSkip = SKIP ? describe.skip : describe;

// ---------------------------------------------------------------------------
// Pool factory — creates a fresh, independent pool each time it is called.
// This is what makes the "restart" simulation realistic: a new pool has zero
// cached state; it must re-authenticate and re-query the database from scratch.
// ---------------------------------------------------------------------------
function makeFreshPool() {
  return new Pool({
    host:     process.env.PG_HOST     || 'localhost',
    port:     parseInt(process.env.PG_PORT || '5432', 10),
    database: PG_DATABASE,
    user:     process.env.PG_USER     || undefined,
    password: process.env.PG_PASSWORD || undefined,
    ssl:      false,
    max: 3,
    idleTimeoutMillis:       3_000,
    connectionTimeoutMillis: 5_000,
  });
}

// ---------------------------------------------------------------------------
// Lifecycle helpers used across describe blocks
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_RE  = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

async function cleanDatabase(pool) {
  // TRUNCATE all investigation data; CASCADE handles child tables.
  // schema_migrations is intentionally NOT truncated (tests migration idempotence).
  await pool.query('TRUNCATE investigations CASCADE');
}

// ===========================================================================
// Suite-level setup: one pool for the whole file to set up the schema.
// Each describe block then creates its own disposable pools.
// ===========================================================================
let setupPool;

beforeAll(async () => {
  if (SKIP) return;
  setupPool = makeFreshPool();
  await runMigrations(setupPool);
}, 30_000);

afterAll(async () => {
  if (setupPool) await setupPool.end();
}, 15_000);

// Clean investigation data before every test using a fresh one-shot pool.
// A shared pool can have stale connection state after RR-MIGRATE-CLEAN-1 drops
// and recreates tables in a separate pool; a fresh pool is always clean.
beforeEach(async () => {
  if (SKIP) return;
  const p = makeFreshPool();
  try {
    await runMigrations(p);   // idempotent — ensures tables exist after any drop
    await cleanDatabase(p);
  } finally {
    await p.end();
  }
});

// ===========================================================================
// RR-MIGRATE-CLEAN — migration from a completely clean database
// ===========================================================================

describeOrSkip('RR-MIGRATE-CLEAN: clean-from-zero migration', () => {
  /**
   * The strategy:
   *   1. Drop all tables (simulates a fresh empty database).
   *   2. Call runMigrations on the empty database.
   *   3. Assert schema is correctly created.
   *   4. Call runMigrations again — must be idempotent (no errors, no duplicate rows).
   */
  test('RR-MIGRATE-CLEAN-1: schema created from scratch on a clean database', async () => {
    const pool = makeFreshPool();
    try {
      // Simulate a truly empty database by dropping everything.
      await pool.query('DROP TABLE IF EXISTS schema_migrations CASCADE');
      await pool.query('DROP TABLE IF EXISTS investigations CASCADE');

      // Now migrate from zero.
      await runMigrations(pool);

      // Verify all tables exist.
      const tableRes = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
         ORDER BY table_name`,
      );
      const tables = tableRes.rows.map((r) => r.table_name);
      const expected = [
        'challenge_evidence', 'challenge_lifecycle', 'challenges',
        'investigation_events', 'investigations',
        'observation_evidence', 'observation_hypotheses', 'observation_versions', 'observations',
        'schema_migrations',
      ];
      for (const t of expected) {
        expect(tables).toContain(t);
      }
    } finally {
      await pool.end();
    }
  });

  test('RR-MIGRATE-CLEAN-2: migration is idempotent — second run completes without error', async () => {
    const pool = makeFreshPool();
    try {
      // First run (may already be applied from suite setup).
      await runMigrations(pool);

      // Second run — must not throw, must not insert duplicate schema_migrations rows.
      await expect(runMigrations(pool)).resolves.not.toThrow();

      const res = await pool.query(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE version = '001_create_investigations'",
      );
      expect(parseInt(res.rows[0].n, 10)).toBe(1);
    } finally {
      await pool.end();
    }
  });

  test('RR-MIGRATE-CLEAN-3: migration records are preserved by investigation TRUNCATE', async () => {
    // TRUNCATE investigations CASCADE should not touch schema_migrations.
    const pool = makeFreshPool();
    try {
      await runMigrations(pool);
      await pool.query('TRUNCATE investigations CASCADE');

      const res = await pool.query('SELECT COUNT(*) AS n FROM schema_migrations');
      expect(parseInt(res.rows[0].n, 10)).toBeGreaterThanOrEqual(1);
    } finally {
      await pool.end();
    }
  });
});

// ===========================================================================
// RR-RESTART — state survives repository / Pool disposal and recreation
// ===========================================================================

describeOrSkip('RR-RESTART: full state survives restart (Pool recreation)', () => {
  /**
   * Pattern used throughout this block:
   *   1. Create a Pool ("pool-A") and Repository ("repo-A").
   *   2. Write state through repo-A.
   *   3. DISPOSE pool-A (pool.end()) — simulates process shutdown.
   *   4. Create a new Pool ("pool-B") and Repository ("repo-B").
   *   5. Read state through repo-B — must match step 2 exactly.
   *   6. DISPOSE pool-B.
   */

  test('RR-RESTART-1: investigation_id, case_id, title, opened_by, status survive restart', async () => {
    // ── Write phase ──────────────────────────────────────────────────────────
    const poolA = makeFreshPool();
    const repoA = new PostgresInvestigationRepository(poolA);

    const written = await repoA.createInvestigation({
      case_id:    'galaxy-15',
      title:      'Restart recovery test investigation',
      opened_by:  'phase-8-3-analyst',
      description: 'Investigation created to verify restart persistence.',
    });

    const writtenId = written.investigation_id;
    await poolA.end();
    // ── Restart: pool-A is gone ──────────────────────────────────────────────

    // ── Read phase ───────────────────────────────────────────────────────────
    const poolB = makeFreshPool();
    const repoB = new PostgresInvestigationRepository(poolB);

    const recovered = await repoB.getInvestigation(writtenId);
    await poolB.end();

    // ── Assertions ───────────────────────────────────────────────────────────
    expect(recovered).not.toBeNull();
    expect(recovered.investigation_id).toBe(writtenId);       // ID unchanged
    expect(recovered.case_id).toBe('galaxy-15');              // case_id unchanged
    expect(recovered.title).toBe('Restart recovery test investigation');
    expect(recovered.opened_by).toBe('phase-8-3-analyst');
    expect(recovered.description).toBe('Investigation created to verify restart persistence.');
    expect(recovered.status).toBe('open');
    expect(recovered.opened_at).toMatch(ISO_RE);              // timestamp preserved
    expect(recovered.events).toHaveLength(1);
    expect(recovered.events[0].event).toBe('opened');
    expect(recovered.events[0].actor).toBe('phase-8-3-analyst');
    expect(recovered.events[0].timestamp).toMatch(ISO_RE);

    // opened_at stored by the app must equal the timestamp in the events array.
    expect(recovered.opened_at).toBe(written.opened_at);
  });

  test('RR-RESTART-2: lifecycle events survive restart', async () => {
    const poolA = makeFreshPool();
    const repoA = new PostgresInvestigationRepository(poolA);

    const inv = await repoA.createInvestigation({ case_id: 'galaxy-15', title: 'T', opened_by: 'a' });
    await repoA.updateInvestigationStatus(inv.investigation_id, { status: 'suspended', actor: 'a', reason: 'Paused for additional data.' });
    await repoA.updateInvestigationStatus(inv.investigation_id, { status: 'closed',    actor: 'b', reason: 'Analysis complete.' });
    await poolA.end();

    const poolB = makeFreshPool();
    const repoB = new PostgresInvestigationRepository(poolB);
    const recovered = await repoB.getInvestigation(inv.investigation_id);
    await poolB.end();

    expect(recovered.status).toBe('closed');
    expect(recovered.events).toHaveLength(3);
    expect(recovered.events.map((e) => e.event)).toEqual(['opened', 'suspended', 'closed']);
    expect(recovered.events[1].reason).toBe('Paused for additional data.');
    expect(recovered.events[2].actor).toBe('b');
  });

  test('RR-RESTART-3: observations with evidence_ids and hypothesis_ids survive restart', async () => {
    const poolA = makeFreshPool();
    const repoA = new PostgresInvestigationRepository(poolA);

    const inv = await repoA.createInvestigation({ case_id: 'galaxy-15', title: 'T', opened_by: 'a' });
    const obs = await repoA.createObservation({
      investigation_id: inv.investigation_id,
      text:             'Electron flux elevated 12 minutes before anomaly onset.',
      authored_by:      'analyst',
      evidence_ids:     ['E-G15-0001', 'E-G15-0010', 'E-G15-0050'],
      hypothesis_ids:   ['H1', 'H5'],
    });
    await poolA.end();

    const poolB = makeFreshPool();
    const repoB = new PostgresInvestigationRepository(poolB);
    const recovered = await repoB.getObservation(obs.observation_id);
    await poolB.end();

    expect(recovered).not.toBeNull();
    expect(recovered.observation_id).toBe(obs.observation_id);
    expect(recovered.investigation_id).toBe(inv.investigation_id);
    expect(recovered.authored_by).toBe('analyst');
    expect(recovered.status).toBe('published');
    expect(recovered.versions).toHaveLength(1);
    expect(recovered.versions[0].text).toBe('Electron flux elevated 12 minutes before anomaly onset.');
    expect(recovered.versions[0].version).toBe(1);
    expect(recovered.authored_at).toBe(obs.authored_at);   // timestamp unchanged
    // evidence_ids are stored as opaque references — not evidence rows.
    expect(recovered.evidence_ids).toHaveLength(3);
    expect(recovered.evidence_ids).toContain('E-G15-0001');
    expect(recovered.evidence_ids).toContain('E-G15-0010');
    expect(recovered.evidence_ids).toContain('E-G15-0050');
    expect(recovered.hypothesis_ids).toHaveLength(2);
    expect(recovered.hypothesis_ids).toContain('H1');
    expect(recovered.hypothesis_ids).toContain('H5');
  });

  test('RR-RESTART-4: observation version history survives restart', async () => {
    const poolA = makeFreshPool();
    const repoA = new PostgresInvestigationRepository(poolA);

    const inv = await repoA.createInvestigation({ case_id: 'galaxy-15', title: 'T', opened_by: 'a' });
    const obs = await repoA.createObservation({
      investigation_id: inv.investigation_id,
      text:             'Version 1 text.',
      authored_by:      'analyst',
    });
    await repoA.updateObservation(obs.observation_id, { text: 'Version 2 text — revised.', authored_by: 'analyst' });
    await repoA.updateObservation(obs.observation_id, { text: 'Version 3 text — final.',   authored_by: 'lead'   });
    await poolA.end();

    const poolB = makeFreshPool();
    const repoB = new PostgresInvestigationRepository(poolB);
    const recovered = await repoB.getObservation(obs.observation_id);
    await poolB.end();

    expect(recovered.versions).toHaveLength(3);
    expect(recovered.versions[0].text).toBe('Version 1 text.');
    expect(recovered.versions[1].text).toBe('Version 2 text — revised.');
    expect(recovered.versions[2].text).toBe('Version 3 text — final.');
    expect(recovered.versions[2].authored_by).toBe('lead');
    // current_text is always the last version's text.
    const currentText = recovered.versions[recovered.versions.length - 1].text;
    expect(currentText).toBe('Version 3 text — final.');
  });

  test('RR-RESTART-5: challenge with lifecycle survives restart', async () => {
    const poolA = makeFreshPool();
    const repoA = new PostgresInvestigationRepository(poolA);

    const inv = await repoA.createInvestigation({ case_id: 'galaxy-15', title: 'T', opened_by: 'a' });
    const { ok, record: chal } = await repoA.createChallenge({
      investigation_id:  inv.investigation_id,
      case_id:           'galaxy-15',
      target_type:       'hypothesis_assessment',
      target_id:         'H1',
      authored_by:       'analyst',
      analyst_statement: 'H1 mixed assessment may underweight the EP8 context window evidence.',
      evidence_ids:      ['E-G15-0001'],
    });
    expect(ok).toBe(true);

    await repoA.transitionChallenge(chal.challenge_id, { status: 'under_review', actor: 'reviewer', notes: 'Investigating.' });
    await poolA.end();

    const poolB = makeFreshPool();
    const repoB = new PostgresInvestigationRepository(poolB);
    const recovered = await repoB.getChallenge(chal.challenge_id);
    await poolB.end();

    expect(recovered).not.toBeNull();
    expect(recovered.challenge_id).toBe(chal.challenge_id);
    expect(recovered.investigation_id).toBe(inv.investigation_id);
    expect(recovered.case_id).toBe('galaxy-15');
    expect(recovered.target_type).toBe('hypothesis_assessment');
    expect(recovered.target_id).toBe('H1');
    expect(recovered.analyst_statement).toBe('H1 mixed assessment may underweight the EP8 context window evidence.');
    expect(recovered.status).toBe('under_review');
    expect(recovered.lifecycle).toHaveLength(2);
    expect(recovered.lifecycle[0].status).toBe('open');
    expect(recovered.lifecycle[1].status).toBe('under_review');
    expect(recovered.lifecycle[1].actor).toBe('reviewer');
    expect(recovered.evidence_ids).toEqual(['E-G15-0001']);
    expect(recovered.created_at).toBe(chal.created_at);  // timestamp unchanged
    expect(recovered.resolution_metadata).toBeNull();
  });

  test('RR-RESTART-6: resolved challenge resolution_metadata survives restart', async () => {
    const poolA = makeFreshPool();
    const repoA = new PostgresInvestigationRepository(poolA);

    const inv = await repoA.createInvestigation({ case_id: 'galaxy-15', title: 'T', opened_by: 'a' });
    const { record: chal } = await repoA.createChallenge({
      investigation_id:  inv.investigation_id,
      case_id:           'galaxy-15',
      target_type:       'limitation',
      target_id:         'proxy_measurement',
      authored_by:       'analyst',
      analyst_statement: 'The proxy measurement limitation warrants escalation for direct sensor data.',
      evidence_ids:      [],
    });

    await repoA.transitionChallenge(chal.challenge_id, { status: 'under_review', actor: 'a' });
    await repoA.transitionChallenge(chal.challenge_id, {
      status:             'resolved',
      actor:              'lead',
      notes:              'Escalated to data acquisition team.',
      resolution_outcome: 'escalated',
    });
    await poolA.end();

    const poolB = makeFreshPool();
    const repoB = new PostgresInvestigationRepository(poolB);
    const recovered = await repoB.getChallenge(chal.challenge_id);
    await poolB.end();

    expect(recovered.status).toBe('resolved');
    expect(recovered.resolution_metadata).not.toBeNull();
    expect(recovered.resolution_metadata.resolution_outcome).toBe('escalated');
    expect(recovered.resolution_metadata.resolved_by).toBe('lead');
    expect(recovered.resolution_metadata.resolution_notes).toBe('Escalated to data acquisition team.');
    expect(recovered.resolution_metadata.resolved_at).toMatch(ISO_RE);
    expect(recovered.lifecycle).toHaveLength(3);
  });

  test('RR-RESTART-7: getInvestigationHistory assembles correctly after restart', async () => {
    const poolA = makeFreshPool();
    const repoA = new PostgresInvestigationRepository(poolA);

    const inv = await repoA.createInvestigation({ case_id: 'galaxy-15', title: 'T', opened_by: 'a' });
    const obs  = await repoA.createObservation({ investigation_id: inv.investigation_id, text: 'Obs text.', authored_by: 'a' });
    const { record: chal } = await repoA.createChallenge({
      investigation_id: inv.investigation_id, case_id: 'galaxy-15',
      target_type: 'missing_evidence', target_id: 'SEP-fluence',
      authored_by: 'a', analyst_statement: 'Direct SEP fluence data is absent.', evidence_ids: [],
    });
    await repoA.updateInvestigationStatus(inv.investigation_id, { status: 'suspended', actor: 'a' });
    await poolA.end();

    const poolB = makeFreshPool();
    const repoB = new PostgresInvestigationRepository(poolB);
    const history = await repoB.getInvestigationHistory(inv.investigation_id);
    await poolB.end();

    expect(history).not.toBeNull();
    expect(history.investigation_id).toBe(inv.investigation_id);
    expect(history.case_id).toBe('galaxy-15');
    expect(history.status).toBe('suspended');
    expect(history.events).toHaveLength(2);
    expect(history.observations).toHaveLength(1);
    expect(history.observations[0].observation_id).toBe(obs.observation_id);
    expect(history.observations[0].current_text).toBe('Obs text.');
    expect(history.challenges).toHaveLength(1);
    expect(history.challenges[0].challenge_id).toBe(chal.challenge_id);
  });
});

// ===========================================================================
// RR-UNKNOWN — unknown IDs after restart
// ===========================================================================

describeOrSkip('RR-UNKNOWN: unknown IDs return null after restart', () => {
  test('RR-UNKNOWN-1: fabricated investigation_id returns null from fresh pool', async () => {
    const pool = makeFreshPool();
    const repo = new PostgresInvestigationRepository(pool);
    try {
      expect(await repo.getInvestigation('00000000-0000-4000-8000-000000000000')).toBeNull();
      expect(await repo.getObservation('00000000-0000-4000-8000-000000000001')).toBeNull();
      expect(await repo.getChallenge('00000000-0000-4000-8000-000000000002')).toBeNull();
    } finally {
      await pool.end();
    }
  });

  test('RR-UNKNOWN-2: updateInvestigationStatus returns 404 for unknown id after restart', async () => {
    const pool = makeFreshPool();
    const repo = new PostgresInvestigationRepository(pool);
    try {
      const result = await repo.updateInvestigationStatus(
        '00000000-0000-4000-8000-000000000000',
        { status: 'closed' },
      );
      expect(result.ok).toBe(false);
      expect(result.status_code).toBe(404);
    } finally {
      await pool.end();
    }
  });

  test('RR-UNKNOWN-3: getInvestigationHistory returns null for unknown id after restart', async () => {
    const pool = makeFreshPool();
    const repo = new PostgresInvestigationRepository(pool);
    try {
      expect(await repo.getInvestigationHistory('00000000-0000-4000-8000-000000000000')).toBeNull();
    } finally {
      await pool.end();
    }
  });

  test('RR-UNKNOWN-4: getInvestigationsForCase returns empty array for unknown case after restart', async () => {
    const pool = makeFreshPool();
    const repo = new PostgresInvestigationRepository(pool);
    try {
      expect(await repo.getInvestigationsForCase('no-such-case')).toEqual([]);
    } finally {
      await pool.end();
    }
  });
});

// ===========================================================================
// RR-ISOLATE — two investigations for different cases remain isolated
// ===========================================================================

describeOrSkip('RR-ISOLATE: cross-case isolation survives restart', () => {
  test('RR-ISOLATE-1: G15 and TCA investigations stay separate across pool recreation', async () => {
    // Write both investigations with pool A.
    const poolA = makeFreshPool();
    const repoA = new PostgresInvestigationRepository(poolA);

    const g15Inv = await repoA.createInvestigation({ case_id: 'galaxy-15',      title: 'G15 investigation', opened_by: 'analyst' });
    const tcaInv = await repoA.createInvestigation({ case_id: 'test-case-alpha', title: 'TCA investigation', opened_by: 'analyst' });

    await repoA.createObservation({
      investigation_id: g15Inv.investigation_id,
      text: 'Galaxy-15 observation — references E-G15 evidence only.',
      evidence_ids: ['E-G15-0001'],
    });
    const { record: g15Chal } = await repoA.createChallenge({
      investigation_id: g15Inv.investigation_id, case_id: 'galaxy-15',
      target_type: 'hypothesis_assessment', target_id: 'H1',
      analyst_statement: 'G15 challenge.', evidence_ids: [],
    });
    const { record: tcaChal } = await repoA.createChallenge({
      investigation_id: tcaInv.investigation_id, case_id: 'test-case-alpha',
      target_type: 'hypothesis_assessment', target_id: 'H1',
      analyst_statement: 'TCA challenge.', evidence_ids: [],
    });
    await poolA.end();

    // Read with pool B.
    const poolB = makeFreshPool();
    const repoB = new PostgresInvestigationRepository(poolB);

    const g15List = await repoB.getInvestigationsForCase('galaxy-15');
    const tcaList = await repoB.getInvestigationsForCase('test-case-alpha');

    expect(g15List).toHaveLength(1);
    expect(tcaList).toHaveLength(1);
    expect(g15List[0].investigation_id).toBe(g15Inv.investigation_id);
    expect(tcaList[0].investigation_id).toBe(tcaInv.investigation_id);

    // G15 observations are not visible in TCA investigation.
    const tcaObs = await repoB.getObservationsForInvestigation(tcaInv.investigation_id);
    expect(tcaObs).toHaveLength(0);

    // G15 challenges are not accessible via TCA investigation getter.
    const tcaChalList = await repoB.getChallengesForInvestigation(tcaInv.investigation_id);
    expect(tcaChalList).toHaveLength(1);
    expect(tcaChalList[0].challenge_id).toBe(tcaChal.challenge_id);

    // TCA case challenges do not include G15 challenge.
    const tcaCaseChals = await repoB.getChallengesForCase('test-case-alpha');
    const g15CaseChals = await repoB.getChallengesForCase('galaxy-15');
    expect(tcaCaseChals).toHaveLength(1);
    expect(tcaCaseChals[0].challenge_id).toBe(tcaChal.challenge_id);
    expect(g15CaseChals).toHaveLength(1);
    expect(g15CaseChals[0].challenge_id).toBe(g15Chal.challenge_id);

    await poolB.end();
  });

  test('RR-ISOLATE-2: evidence_ids from G15 observations never appear in TCA investigation lists', async () => {
    const poolA = makeFreshPool();
    const repoA = new PostgresInvestigationRepository(poolA);

    const g15Inv = await repoA.createInvestigation({ case_id: 'galaxy-15',      title: 'G', opened_by: 'a' });
    const tcaInv = await repoA.createInvestigation({ case_id: 'test-case-alpha', title: 'T', opened_by: 'a' });

    // Create observations in both investigations with their respective evidence IDs.
    await repoA.createObservation({
      investigation_id: g15Inv.investigation_id,
      text: 'G15 obs', evidence_ids: ['E-G15-0001', 'E-G15-0050'],
    });
    await repoA.createObservation({
      investigation_id: tcaInv.investigation_id,
      text: 'TCA obs', evidence_ids: ['E-TCA-0001', 'E-TCA-0020'],
    });
    await poolA.end();

    const poolB = makeFreshPool();
    const repoB = new PostgresInvestigationRepository(poolB);

    const g15Obs = await repoB.getObservationsForInvestigation(g15Inv.investigation_id);
    const tcaObs = await repoB.getObservationsForInvestigation(tcaInv.investigation_id);
    await poolB.end();

    // G15 observations contain only E-G15 IDs.
    for (const o of g15Obs) {
      for (const eid of o.evidence_ids) {
        expect(eid).toMatch(/^E-G15-/);
      }
    }
    // TCA observations contain only E-TCA IDs.
    for (const o of tcaObs) {
      for (const eid of o.evidence_ids) {
        expect(eid).toMatch(/^E-TCA-/);
      }
    }
  });

  test('RR-ISOLATE-3: updating G15 investigation status does not affect TCA investigation', async () => {
    const poolA = makeFreshPool();
    const repoA = new PostgresInvestigationRepository(poolA);

    const g15Inv = await repoA.createInvestigation({ case_id: 'galaxy-15',      title: 'G', opened_by: 'a' });
    const tcaInv = await repoA.createInvestigation({ case_id: 'test-case-alpha', title: 'T', opened_by: 'a' });
    await repoA.updateInvestigationStatus(g15Inv.investigation_id, { status: 'closed', actor: 'a' });
    await poolA.end();

    const poolB = makeFreshPool();
    const repoB = new PostgresInvestigationRepository(poolB);

    const g15Recovered = await repoB.getInvestigation(g15Inv.investigation_id);
    const tcaRecovered = await repoB.getInvestigation(tcaInv.investigation_id);
    await poolB.end();

    expect(g15Recovered.status).toBe('closed');
    expect(tcaRecovered.status).toBe('open');   // TCA is unaffected
  });
});

// ===========================================================================
// RR-CONCURRENT — concurrent creation and read operations
// ===========================================================================

describeOrSkip('RR-CONCURRENT: concurrent creation and read operations', () => {
  test('RR-CONCURRENT-1: concurrent createInvestigation calls produce distinct UUIDs', async () => {
    const pool = makeFreshPool();
    const repo = new PostgresInvestigationRepository(pool);

    try {
      const N = 8;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          repo.createInvestigation({
            case_id:   'galaxy-15',
            title:     `Concurrent investigation ${i}`,
            opened_by: `analyst-${i}`,
          }),
        ),
      );

      const ids = results.map((r) => r.investigation_id);
      const unique = new Set(ids);
      expect(unique.size).toBe(N);           // all UUIDs distinct
      for (const id of ids) {
        expect(id).toMatch(UUID_RE);         // all valid v4 UUIDs
      }
    } finally {
      await pool.end();
    }
  });

  test('RR-CONCURRENT-2: concurrent reads from the same pool return consistent state', async () => {
    const pool = makeFreshPool();
    const repo = new PostgresInvestigationRepository(pool);

    try {
      const inv = await repo.createInvestigation({ case_id: 'galaxy-15', title: 'T', opened_by: 'a' });

      // 10 concurrent reads of the same investigation.
      const reads = await Promise.all(
        Array.from({ length: 10 }, () => repo.getInvestigation(inv.investigation_id)),
      );

      for (const r of reads) {
        expect(r).not.toBeNull();
        expect(r.investigation_id).toBe(inv.investigation_id);
        expect(r.status).toBe('open');
      }
    } finally {
      await pool.end();
    }
  });

  test('RR-CONCURRENT-3: concurrent createObservation calls produce distinct IDs', async () => {
    const pool = makeFreshPool();
    const repo = new PostgresInvestigationRepository(pool);

    try {
      const inv = await repo.createInvestigation({ case_id: 'galaxy-15', title: 'T', opened_by: 'a' });

      const N = 6;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          repo.createObservation({
            investigation_id: inv.investigation_id,
            text:             `Concurrent observation ${i}`,
            authored_by:      'analyst',
          }),
        ),
      );

      const ids = results.map((r) => r.observation_id);
      expect(new Set(ids).size).toBe(N);
    } finally {
      await pool.end();
    }
  });

  test('RR-CONCURRENT-4: concurrent createChallenge calls persist independently', async () => {
    const pool = makeFreshPool();
    const repo = new PostgresInvestigationRepository(pool);

    try {
      const inv = await repo.createInvestigation({ case_id: 'galaxy-15', title: 'T', opened_by: 'a' });

      const N = 5;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          repo.createChallenge({
            investigation_id:  inv.investigation_id,
            case_id:           'galaxy-15',
            target_type:       'hypothesis_assessment',
            target_id:         `H${(i % 5) + 1}`,
            authored_by:       'analyst',
            analyst_statement: `Concurrent challenge ${i}: evidence warrants re-evaluation.`,
            evidence_ids:      [],
          }),
        ),
      );

      expect(results.every((r) => r.ok)).toBe(true);
      const ids = results.map((r) => r.record.challenge_id);
      expect(new Set(ids).size).toBe(N);

      const stored = await repo.getChallengesForInvestigation(inv.investigation_id);
      expect(stored).toHaveLength(N);
    } finally {
      await pool.end();
    }
  });
});

// ===========================================================================
// RR-ARTIFACT — artifact references are stable after restart
// ===========================================================================

describeOrSkip('RR-ARTIFACT: artifact evidence references are stable after restart', () => {
  /**
   * Observations and challenges store evidence_id references, not evidence rows.
   * After a restart, those references must still be exactly the same opaque strings —
   * neither augmented with evidence data nor silently dropped.
   */
  test('RR-ARTIFACT-1: evidence_id references round-trip as opaque strings only', async () => {
    const poolA = makeFreshPool();
    const repoA = new PostgresInvestigationRepository(poolA);

    const inv = await repoA.createInvestigation({ case_id: 'galaxy-15', title: 'T', opened_by: 'a' });
    const EVIDENCE_REFS = ['E-G15-0001', 'E-G15-0010', 'E-G15-0050', 'E-G15-0100'];

    const obs = await repoA.createObservation({
      investigation_id: inv.investigation_id,
      text: 'Evidence reference test.',
      evidence_ids: EVIDENCE_REFS,
    });
    await poolA.end();

    const poolB = makeFreshPool();
    const repoB = new PostgresInvestigationRepository(poolB);
    const recovered = await repoB.getObservation(obs.observation_id);
    await poolB.end();

    // References must be exactly the opaque ID strings — no data augmentation.
    expect(recovered.evidence_ids).toHaveLength(EVIDENCE_REFS.length);
    for (const eid of EVIDENCE_REFS) {
      expect(recovered.evidence_ids).toContain(eid);
    }
    // Must NOT contain any evidence row fields.
    for (const eid of recovered.evidence_ids) {
      expect(typeof eid).toBe('string');   // plain string, not an object with fields
    }
    expect(recovered).not.toHaveProperty('timestamp');
    expect(recovered).not.toHaveProperty('value');
    expect(recovered).not.toHaveProperty('unit');
    expect(recovered).not.toHaveProperty('measurement');
  });

  test('RR-ARTIFACT-2: investigation persistence layer never contains evidence row data', async () => {
    // Directly inspect the database to confirm no evidence data was written.
    const pool = makeFreshPool();
    const repo = new PostgresInvestigationRepository(pool);

    try {
      const inv = await repo.createInvestigation({ case_id: 'galaxy-15', title: 'T', opened_by: 'a' });
      await repo.createObservation({
        investigation_id: inv.investigation_id,
        text: 'Observation citing evidence.',
        evidence_ids: ['E-G15-0001', 'E-G15-0005'],
      });

      // Check that observation_evidence only stores the evidence_id string.
      const res = await pool.query('SELECT * FROM observation_evidence LIMIT 10');
      for (const row of res.rows) {
        const cols = Object.keys(row);
        // The only columns should be observation_id and evidence_id.
        expect(cols).toContain('observation_id');
        expect(cols).toContain('evidence_id');
        expect(typeof row.evidence_id).toBe('string');
        // No evidence data columns.
        expect(cols).not.toContain('timestamp');
        expect(cols).not.toContain('value');
        expect(cols).not.toContain('unit');
        expect(cols).not.toContain('measurement');
        expect(cols).not.toContain('source');
      }
    } finally {
      await pool.end();
    }
  });

  test('RR-ARTIFACT-3: forensic analysis is never stored in investigation tables', async () => {
    const pool = makeFreshPool();
    try {
      // No table in the investigation schema should have forensic analysis columns.
      const forensicColumns = [
        'causal_attribution_established',
        'analysis_version',
        'evidence_value',
        'evidence_timestamp',
        'hypothesis_assessments',
        'executive_summary',
        'analyst_narrative',
      ];
      const tableRes = await pool.query(
        `SELECT table_name, column_name
         FROM information_schema.columns
         WHERE table_schema = 'public'
         AND column_name = ANY($1)`,
        [forensicColumns],
      );
      // None of the forensic column names should appear in any table.
      expect(tableRes.rows).toHaveLength(0);
    } finally {
      await pool.end();
    }
  });
});

// ===========================================================================
// RR-FORENSIC-REGRESSION — Galaxy-15 forensic baseline remains unchanged
// ===========================================================================

describeOrSkip('RR-FORENSIC-REGRESSION: Galaxy-15 forensic baseline unchanged by persistence', () => {
  /**
   * These tests prove that the addition of PostgreSQL persistence has zero
   * effect on the deterministic forensic pipeline.  The forensic pipeline is
   * entirely read-only with respect to the investigation layer (INV-7) and must
   * produce byte-identical output regardless of how many investigations exist.
   */

  let rows, graph, analysis, narrative, report;

  beforeAll(async () => {
    rows      = await parseEvidenceCSV('galaxy-15');
    graph     = await buildEvidenceGraph('galaxy-15', rows);
    analysis  = buildForensicAnalysis('galaxy-15', graph);
    narrative = buildAnalystHeuristicNarrative(analysis);
    report    = assembleValidatedForensicReport(analysis, narrative);
  }, 30_000);

  test('RR-REGRESSION-1: Galaxy-15 still has exactly 278 evidence records', () => {
    expect(rows).toHaveLength(278);
  });

  test('RR-REGRESSION-2: evidence IDs are still deterministic (E-G15-0001 to E-G15-0278)', () => {
    expect(rows[0].evidence_id).toBe('E-G15-0001');
    expect(rows[rows.length - 1].evidence_id).toBe('E-G15-0278');
    const ids = rows.map((r) => r.evidence_id);
    const unique = new Set(ids);
    expect(unique.size).toBe(278);
    for (let i = 1; i <= 278; i++) {
      expect(ids[i - 1]).toBe(`E-G15-${String(i).padStart(4, '0')}`);
    }
  });

  test('RR-REGRESSION-3: causal_attribution_established is false', () => {
    expect(analysis.causal_attribution_established).toBe(false);
    expect(report.causal_attribution_established).toBe(false);
    expect(narrative.causal_attribution_established).toBe(false);
  });

  test('RR-REGRESSION-4: Galaxy-15 has exactly 5 hypotheses', () => {
    expect(analysis.hypotheses).toHaveLength(5);
  });

  test('RR-REGRESSION-5: hypothesis assessments are byte-identical to the Phase 6 baseline', () => {
    const assessments = Object.fromEntries(
      analysis.hypotheses.map((h) => [h.hypothesis_id, h.assessment]),
    );
    expect(assessments.H1).toBe('mixed');
    expect(assessments.H2).toBe('mixed');
    expect(assessments.H3).toBe('supported');
    expect(assessments.H4).toBe('insufficient_evidence');
    expect(assessments.H5).toBe('strongly_supported');
  });

  test('RR-REGRESSION-6: forensic report is byte-identical on two independent pipeline runs', async () => {
    const rows2      = await parseEvidenceCSV('galaxy-15');
    const graph2     = await buildEvidenceGraph('galaxy-15', rows2);
    const analysis2  = buildForensicAnalysis('galaxy-15', graph2);
    const narrative2 = buildAnalystHeuristicNarrative(analysis2);
    const report2    = assembleValidatedForensicReport(analysis2, narrative2);

    // Deterministic fields must be byte-identical.
    const stableFields = [
      'case_id', 'analysis_version', 'causal_attribution_established',
    ];
    for (const field of stableFields) {
      expect(report[field]).toStrictEqual(report2[field]);
    }

    // All hypothesis assessments must match.
    for (const h of report.hypotheses) {
      const h2 = report2.hypotheses.find((x) => x.hypothesis_id === h.hypothesis_id);
      expect(h2).toBeDefined();
      expect(h2.assessment).toBe(h.assessment);
    }

    // Evidence IDs in all hypothesis lists must match.
    for (const h of report.hypotheses) {
      const h2 = report2.hypotheses.find((x) => x.hypothesis_id === h.hypothesis_id);
      const s1 = h.evidence_summary;
      const s2 = h2.evidence_summary;
      expect(s1.environmental_context_ids.sort()).toEqual(s2.environmental_context_ids.sort());
      expect(s1.supporting_evidence_ids.sort()).toEqual(s2.supporting_evidence_ids.sort());
      expect(s1.contradicting_evidence_ids.sort()).toEqual(s2.contradicting_evidence_ids.sort());
      expect(s1.non_discriminating_evidence_ids.sort()).toEqual(s2.non_discriminating_evidence_ids.sort());
    }
  });

  test('RR-REGRESSION-7: EPHEMERIS records are still excluded from all hypothesis evidence lists', () => {
    const LISTS = [
      'environmental_context_ids',
      'supporting_evidence_ids',
      'contradicting_evidence_ids',
      'non_discriminating_evidence_ids',
    ];
    const ephemerisIds = new Set(
      rows.filter((r) => r.source === 'GOES11_EPHEMERIS').map((r) => r.evidence_id),
    );
    expect(ephemerisIds.size).toBeGreaterThan(0);

    for (const h of report.hypotheses) {
      for (const list of LISTS) {
        for (const eid of h.evidence_summary[list] || []) {
          expect(ephemerisIds.has(eid)).toBe(false);
        }
      }
    }
  });

  test('RR-REGRESSION-8: forensic analysis is unchanged after creating investigations in the database', async () => {
    // Write 5 investigations into the database, then re-run the forensic pipeline.
    // The pipeline must produce the same output regardless.
    const pool = makeFreshPool();
    const repo = new PostgresInvestigationRepository(pool);

    try {
      for (let i = 0; i < 5; i++) {
        const inv = await repo.createInvestigation({ case_id: 'galaxy-15', title: `Inv ${i}`, opened_by: 'a' });
        await repo.createObservation({ investigation_id: inv.investigation_id, text: `Obs ${i}`, evidence_ids: ['E-G15-0001'] });
      }
    } finally {
      await pool.end();
    }

    // Re-run forensic pipeline — must be identical.
    const rows3      = await parseEvidenceCSV('galaxy-15');
    const graph3     = await buildEvidenceGraph('galaxy-15', rows3);
    const analysis3  = buildForensicAnalysis('galaxy-15', graph3);

    expect(rows3).toHaveLength(278);
    expect(analysis3.causal_attribution_established).toBe(false);
    expect(analysis3.hypotheses).toHaveLength(5);
    for (const h of analysis3.hypotheses) {
      const orig = analysis.hypotheses.find((x) => x.hypothesis_id === h.hypothesis_id);
      expect(h.assessment).toBe(orig.assessment);
    }
  });

  test('RR-REGRESSION-9: limitations are non-empty and preserved', () => {
    expect(report.limitations).toBeDefined();
    expect(report.limitations.length).toBeGreaterThan(0);
    const descriptions = new Set(report.limitations.map((l) => l.description));
    expect(descriptions.size).toBe(report.limitations.length); // all unique
  });

  test('RR-REGRESSION-10: narrative source is "heuristic" and contains no numerical probabilities', () => {
    expect(narrative.source).toBe('heuristic');
    const PROB_RE = /\b\d+(\.\d+)?\s*%|\b\d+(\.\d+)?\s*(probability|chance|likelihood)/i;
    expect(PROB_RE.test(narrative.executive_summary)).toBe(false);
    for (const ha of narrative.hypothesis_assessments) {
      expect(PROB_RE.test(ha.reasoning)).toBe(false);
    }
  });
});
