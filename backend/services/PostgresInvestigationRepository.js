'use strict';

// ---------------------------------------------------------------------------
// services/PostgresInvestigationRepository.js — Phase 8.2
//
// PostgreSQL-backed implementation of InvestigationRepository.
//
// Every method mirrors the shape and semantics of InMemoryInvestigationRepository
// exactly, so callers (investigationStore.js, server.js) need no changes.
//
// DESIGN PRINCIPLES:
//   P1  All queries are parameterised — no string interpolation.
//   P2  PostgreSQL errors, SQL text, and stack traces are never returned
//       through HTTP responses.  Methods return { ok, error, status_code }
//       on expected failures; unexpected DB errors propagate as thrown Errors
//       (caught by the route layer's try/catch and mapped to a 500).
//   P3  UUIDs are generated in application code (STORE-2).  No SERIAL/IDENTITY
//       columns are used for business keys.
//   P4  JSON columns are used for the structured arrays (events, versions,
//       lifecycle) so the in-memory shape is round-tripped exactly.
//   P5  All timestamps are stored as the ISO-8601 string produced by the app
//       (new Date().toISOString()), never regenerated on read.
//   P6  No forensic data (evidence rows, analysis fields, causal flags) is
//       stored or referenced in this module.
//
// TRANSACTION STRATEGY:
//   Writes that span multiple tables (create investigation, create observation,
//   create challenge) use explicit BEGIN/COMMIT transactions via a client
//   checked out from the pool.  Single-table writes use pool.query() directly.
// ---------------------------------------------------------------------------

const { InvestigationRepository, CHALLENGE_TARGET_TYPES, CHALLENGE_RESOLUTION_OUTCOMES } = require('./InvestigationRepository');
const { getPool } = require('../db/pool');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a pool client transaction.  Commits on success; rolls back and
 * re-throws on any error.
 * @param {import('pg').Pool} pool
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Map a raw investigation row + its event rows into the JS record shape
 * that callers expect (identical to InMemoryInvestigationRepository output).
 */
function buildInvestigationRecord(row, eventRows) {
  return {
    investigation_id: row.investigation_id,
    case_id:          row.case_id,
    title:            row.title,
    description:      row.description || null,
    opened_by:        row.opened_by   || null,
    opened_at:        row.opened_at instanceof Date
      ? row.opened_at.toISOString()
      : row.opened_at,
    status: row.status,
    events: (eventRows || []).map((e) => ({
      event:     e.event,
      actor:     e.actor     || null,
      timestamp: e.event_at instanceof Date ? e.event_at.toISOString() : e.event_at,
      reason:    e.reason    || null,
    })),
  };
}

/**
 * Map raw observation rows into the JS record shape.
 */
function buildObservationRecord(obsRow, versionRows, evidenceIds, hypothesisIds) {
  return {
    observation_id:   obsRow.observation_id,
    investigation_id: obsRow.investigation_id,
    authored_by:      obsRow.authored_by  || null,
    authored_at:      obsRow.authored_at instanceof Date
      ? obsRow.authored_at.toISOString()
      : obsRow.authored_at,
    status:   obsRow.status,
    versions: (versionRows || []).map((v) => ({
      version:     v.version,
      text:        v.text,
      authored_by: v.authored_by || null,
      authored_at: v.authored_at instanceof Date ? v.authored_at.toISOString() : v.authored_at,
    })),
    evidence_ids:   evidenceIds   || [],
    hypothesis_ids: hypothesisIds || [],
  };
}

/**
 * Map raw challenge rows into the JS record shape.
 */
function buildChallengeRecord(cRow, lifecycleRows, evidenceIds) {
  let resolution_metadata = null;
  if (cRow.resolution_outcome) {
    resolution_metadata = {
      resolution_outcome: cRow.resolution_outcome,
      resolution_notes:   cRow.resolution_notes || null,
      resolved_by:        cRow.resolved_by      || null,
      resolved_at:        cRow.resolved_at instanceof Date
        ? cRow.resolved_at.toISOString()
        : (cRow.resolved_at || null),
    };
  }

  return {
    challenge_id:      cRow.challenge_id,
    investigation_id:  cRow.investigation_id,
    case_id:           cRow.case_id          || null,
    target_type:       cRow.target_type,
    target_id:         cRow.target_id,
    authored_by:       cRow.authored_by      || null,
    created_at:        cRow.created_at instanceof Date
      ? cRow.created_at.toISOString()
      : cRow.created_at,
    analyst_statement: cRow.analyst_statement,
    status:            cRow.status,
    evidence_ids:      evidenceIds || [],
    lifecycle: (lifecycleRows || []).map((l) => ({
      status:    l.status,
      actor:     l.actor     || null,
      timestamp: l.transition_at instanceof Date ? l.transition_at.toISOString() : l.transition_at,
      notes:     l.notes     || null,
    })),
    resolution_metadata,
  };
}

// ===========================================================================
// PostgresInvestigationRepository
// ===========================================================================

class PostgresInvestigationRepository extends InvestigationRepository {
  /**
   * @param {import('pg').Pool} [pool]  — injectable for tests; defaults to shared pool
   */
  constructor(pool) {
    super();
    this._pool = pool || null; // resolved lazily via _getPool()
  }

  _getPool() {
    return this._pool || getPool();
  }

  // ── Investigations ─────────────────────────────────────────────────────────

  async createInvestigation({ case_id, title, opened_by, description }) {
    const { uuidv4 } = require('./InvestigationRepository');
    // uuidv4 is not exported directly — replicate the same generator here.
    const investigation_id = _uuidv4();
    const opened_at        = new Date().toISOString();
    const resolvedTitle    = title || `Investigation for ${case_id}`;

    await withTransaction(this._getPool(), async (client) => {
      await client.query(
        `INSERT INTO investigations
           (investigation_id, case_id, title, description, opened_by, opened_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'open')`,
        [investigation_id, case_id, resolvedTitle, description || null, opened_by || null, opened_at],
      );
      await client.query(
        `INSERT INTO investigation_events
           (investigation_id, event, actor, event_at, reason)
         VALUES ($1, 'opened', $2, $3, NULL)`,
        [investigation_id, opened_by || null, opened_at],
      );
    });

    return {
      investigation_id,
      case_id,
      title:       resolvedTitle,
      description: description || null,
      opened_by:   opened_by   || null,
      opened_at,
      status: 'open',
      events: [{ event: 'opened', actor: opened_by || null, timestamp: opened_at, reason: null }],
    };
  }

  async getInvestigation(investigation_id) {
    const pool = this._getPool();
    const [invRes, evtRes] = await Promise.all([
      pool.query('SELECT * FROM investigations WHERE investigation_id = $1', [investigation_id]),
      pool.query(
        'SELECT * FROM investigation_events WHERE investigation_id = $1 ORDER BY id',
        [investigation_id],
      ),
    ]);
    if (invRes.rows.length === 0) return null;
    return buildInvestigationRecord(invRes.rows[0], evtRes.rows);
  }

  async getInvestigationsForCase(case_id) {
    const pool = this._getPool();
    const invRes = await pool.query(
      'SELECT * FROM investigations WHERE case_id = $1 ORDER BY created_at',
      [case_id],
    );
    if (invRes.rows.length === 0) return [];

    const ids = invRes.rows.map((r) => r.investigation_id);
    const evtRes = await pool.query(
      'SELECT * FROM investigation_events WHERE investigation_id = ANY($1) ORDER BY id',
      [ids],
    );

    const eventsByInv = new Map();
    for (const evt of evtRes.rows) {
      if (!eventsByInv.has(evt.investigation_id)) eventsByInv.set(evt.investigation_id, []);
      eventsByInv.get(evt.investigation_id).push(evt);
    }

    return invRes.rows.map((row) =>
      buildInvestigationRecord(row, eventsByInv.get(row.investigation_id) || []),
    );
  }

  async updateInvestigationStatus(investigation_id, { status, actor, reason }) {
    const ALLOWED_STATUSES = new Set(['open', 'suspended', 'closed']);
    if (!ALLOWED_STATUSES.has(status)) {
      return {
        ok: false,
        error: `Invalid status "${status}". Allowed: open, suspended, closed.`,
        status_code: 422,
      };
    }

    const pool = this._getPool();
    const invRes = await pool.query(
      'SELECT * FROM investigations WHERE investigation_id = $1',
      [investigation_id],
    );
    if (invRes.rows.length === 0) {
      return { ok: false, error: `Investigation not found: ${investigation_id}`, status_code: 404 };
    }

    const current = invRes.rows[0];
    if (current.status === 'closed' && status !== 'open') {
      return {
        ok: false,
        error: 'Investigation is closed. Re-open it before making changes.',
        status_code: 409,
      };
    }

    const eventMap = {
      suspended: 'suspended',
      closed:    'closed',
      open:      current.status === 'closed' ? 're-opened' : 'resumed',
    };
    const eventName = eventMap[status];
    const eventAt   = new Date().toISOString();

    await withTransaction(pool, async (client) => {
      await client.query(
        'UPDATE investigations SET status = $1 WHERE investigation_id = $2',
        [status, investigation_id],
      );
      await client.query(
        `INSERT INTO investigation_events
           (investigation_id, event, actor, event_at, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [investigation_id, eventName, actor || null, eventAt, reason || null],
      );
    });

    const record = await this.getInvestigation(investigation_id);
    return { ok: true, record };
  }

  async getInvestigationHistory(investigation_id) {
    const inv = await this.getInvestigation(investigation_id);
    if (!inv) return null;

    const [observations, challenges] = await Promise.all([
      this.getObservationsForInvestigation(investigation_id),
      this.getChallengesForInvestigation(investigation_id),
    ]);

    return {
      investigation_id,
      case_id:  inv.case_id,
      status:   inv.status,
      events:   [...inv.events],
      observations: observations.map((o) => ({
        observation_id:   o.observation_id,
        status:           o.status,
        authored_by:      o.authored_by,
        authored_at:      o.authored_at,
        evidence_ids:     o.evidence_ids,
        hypothesis_ids:   o.hypothesis_ids,
        current_text:     o.versions[o.versions.length - 1].text,
        version_count:    o.versions.length,
        versions:         o.versions,
      })),
      challenges: challenges.map((c) => ({
        challenge_id:        c.challenge_id,
        case_id:             c.case_id,
        target_type:         c.target_type,
        target_id:           c.target_id,
        authored_by:         c.authored_by,
        created_at:          c.created_at,
        analyst_statement:   c.analyst_statement,
        status:              c.status,
        evidence_ids:        c.evidence_ids,
        lifecycle:           c.lifecycle,
        resolution_metadata: c.resolution_metadata,
      })),
    };
  }

  // ── Observations ───────────────────────────────────────────────────────────

  async createObservation({ investigation_id, text, authored_by, evidence_ids, hypothesis_ids }) {
    const observation_id = _uuidv4();
    const authored_at    = new Date().toISOString();
    const resolvedText   = text || '';
    const evIds = Array.isArray(evidence_ids)   ? [...evidence_ids]   : [];
    const hyIds = Array.isArray(hypothesis_ids) ? [...hypothesis_ids] : [];

    await withTransaction(this._getPool(), async (client) => {
      await client.query(
        `INSERT INTO observations (observation_id, investigation_id, authored_by, authored_at, status)
         VALUES ($1, $2, $3, $4, 'published')`,
        [observation_id, investigation_id, authored_by || null, authored_at],
      );
      await client.query(
        `INSERT INTO observation_versions (observation_id, version, text, authored_by, authored_at)
         VALUES ($1, 1, $2, $3, $4)`,
        [observation_id, resolvedText, authored_by || null, authored_at],
      );
      for (const eid of evIds) {
        await client.query(
          'INSERT INTO observation_evidence (observation_id, evidence_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [observation_id, eid],
        );
      }
      for (const hid of hyIds) {
        await client.query(
          'INSERT INTO observation_hypotheses (observation_id, hypothesis_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [observation_id, hid],
        );
      }
    });

    return {
      observation_id,
      investigation_id,
      authored_by:    authored_by || null,
      authored_at,
      status: 'published',
      versions: [{ version: 1, text: resolvedText, authored_by: authored_by || null, authored_at }],
      evidence_ids:   evIds,
      hypothesis_ids: hyIds,
    };
  }

  async getObservation(observation_id) {
    const pool = this._getPool();
    const [obsRes, verRes, evRes, hyRes] = await Promise.all([
      pool.query('SELECT * FROM observations WHERE observation_id = $1', [observation_id]),
      pool.query(
        'SELECT * FROM observation_versions WHERE observation_id = $1 ORDER BY version',
        [observation_id],
      ),
      pool.query('SELECT evidence_id FROM observation_evidence WHERE observation_id = $1', [observation_id]),
      pool.query('SELECT hypothesis_id FROM observation_hypotheses WHERE observation_id = $1', [observation_id]),
    ]);
    if (obsRes.rows.length === 0) return null;
    return buildObservationRecord(
      obsRes.rows[0],
      verRes.rows,
      evRes.rows.map((r) => r.evidence_id),
      hyRes.rows.map((r) => r.hypothesis_id),
    );
  }

  async getObservationsForInvestigation(investigation_id) {
    const pool = this._getPool();
    const obsRes = await pool.query(
      'SELECT * FROM observations WHERE investigation_id = $1 ORDER BY authored_at',
      [investigation_id],
    );
    if (obsRes.rows.length === 0) return [];

    const obsIds = obsRes.rows.map((r) => r.observation_id);
    const [verRes, evRes, hyRes] = await Promise.all([
      pool.query(
        'SELECT * FROM observation_versions WHERE observation_id = ANY($1) ORDER BY observation_id, version',
        [obsIds],
      ),
      pool.query('SELECT * FROM observation_evidence WHERE observation_id = ANY($1)', [obsIds]),
      pool.query('SELECT * FROM observation_hypotheses WHERE observation_id = ANY($1)', [obsIds]),
    ]);

    const verByObs = new Map();
    for (const v of verRes.rows) {
      if (!verByObs.has(v.observation_id)) verByObs.set(v.observation_id, []);
      verByObs.get(v.observation_id).push(v);
    }
    const evByObs = new Map();
    for (const e of evRes.rows) {
      if (!evByObs.has(e.observation_id)) evByObs.set(e.observation_id, []);
      evByObs.get(e.observation_id).push(e.evidence_id);
    }
    const hyByObs = new Map();
    for (const h of hyRes.rows) {
      if (!hyByObs.has(h.observation_id)) hyByObs.set(h.observation_id, []);
      hyByObs.get(h.observation_id).push(h.hypothesis_id);
    }

    return obsRes.rows.map((row) =>
      buildObservationRecord(
        row,
        verByObs.get(row.observation_id) || [],
        evByObs.get(row.observation_id)  || [],
        hyByObs.get(row.observation_id)  || [],
      ),
    );
  }

  async updateObservation(observation_id, { text, authored_by }) {
    const pool = this._getPool();
    const obsRes = await pool.query(
      'SELECT * FROM observations WHERE observation_id = $1',
      [observation_id],
    );
    if (obsRes.rows.length === 0) {
      return { ok: false, error: `Observation not found: ${observation_id}`, status_code: 404 };
    }
    const obs = obsRes.rows[0];
    if (obs.status === 'superseded' || obs.status === 'deleted') {
      return {
        ok: false,
        error: `Observation ${observation_id} is ${obs.status} and cannot be edited.`,
        status_code: 409,
      };
    }

    const verRes = await pool.query(
      'SELECT MAX(version) AS max_v FROM observation_versions WHERE observation_id = $1',
      [observation_id],
    );
    const nextVersion = (verRes.rows[0].max_v || 0) + 1;
    const authored_at = new Date().toISOString();

    await pool.query(
      `INSERT INTO observation_versions (observation_id, version, text, authored_by, authored_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [observation_id, nextVersion, text || '', authored_by || null, authored_at],
    );

    const record = await this.getObservation(observation_id);
    return { ok: true, record };
  }

  // ── Challenges ─────────────────────────────────────────────────────────────

  async createChallenge({
    investigation_id,
    case_id,
    target_type,
    target_id,
    authored_by,
    analyst_statement,
    evidence_ids,
  }) {
    if (!CHALLENGE_TARGET_TYPES.has(target_type)) {
      return {
        ok: false,
        error:
          `Invalid target_type "${target_type}". ` +
          `Allowed: hypothesis_assessment, evidence_classification, ` +
          `limitation, missing_evidence, additional_investigation.`,
        status_code: 422,
      };
    }

    const challenge_id = _uuidv4();
    const created_at   = new Date().toISOString();
    const evIds = Array.isArray(evidence_ids) ? [...evidence_ids] : [];

    await withTransaction(this._getPool(), async (client) => {
      await client.query(
        `INSERT INTO challenges
           (challenge_id, investigation_id, case_id, target_type, target_id,
            authored_by, created_at, analyst_statement, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open')`,
        [challenge_id, investigation_id, case_id || null, target_type, target_id,
         authored_by || null, created_at, analyst_statement || ''],
      );
      await client.query(
        `INSERT INTO challenge_lifecycle (challenge_id, status, actor, transition_at, notes)
         VALUES ($1, 'open', $2, $3, NULL)`,
        [challenge_id, authored_by || null, created_at],
      );
      for (const eid of evIds) {
        await client.query(
          'INSERT INTO challenge_evidence (challenge_id, evidence_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [challenge_id, eid],
        );
      }
    });

    return {
      ok: true,
      record: {
        challenge_id,
        investigation_id,
        case_id:           case_id          || null,
        target_type,
        target_id,
        authored_by:       authored_by      || null,
        created_at,
        analyst_statement: analyst_statement || '',
        status: 'open',
        evidence_ids: evIds,
        lifecycle: [{ status: 'open', actor: authored_by || null, timestamp: created_at, notes: null }],
        resolution_metadata: null,
      },
    };
  }

  async getChallenge(challenge_id) {
    const pool = this._getPool();
    const [cRes, lcRes, evRes] = await Promise.all([
      pool.query('SELECT * FROM challenges WHERE challenge_id = $1', [challenge_id]),
      pool.query(
        'SELECT * FROM challenge_lifecycle WHERE challenge_id = $1 ORDER BY id',
        [challenge_id],
      ),
      pool.query('SELECT evidence_id FROM challenge_evidence WHERE challenge_id = $1', [challenge_id]),
    ]);
    if (cRes.rows.length === 0) return null;
    return buildChallengeRecord(
      cRes.rows[0],
      lcRes.rows,
      evRes.rows.map((r) => r.evidence_id),
    );
  }

  async getChallengesForInvestigation(investigation_id) {
    const pool = this._getPool();
    const cRes = await pool.query(
      'SELECT * FROM challenges WHERE investigation_id = $1 ORDER BY created_at',
      [investigation_id],
    );
    if (cRes.rows.length === 0) return [];
    return this._hydrateMultipleChallenges(pool, cRes.rows);
  }

  async getChallengesForCase(case_id) {
    const pool = this._getPool();
    const cRes = await pool.query(
      'SELECT * FROM challenges WHERE case_id = $1 ORDER BY created_at',
      [case_id],
    );
    if (cRes.rows.length === 0) return [];
    return this._hydrateMultipleChallenges(pool, cRes.rows);
  }

  async _hydrateMultipleChallenges(pool, challengeRows) {
    const ids = challengeRows.map((r) => r.challenge_id);
    const [lcRes, evRes] = await Promise.all([
      pool.query(
        'SELECT * FROM challenge_lifecycle WHERE challenge_id = ANY($1) ORDER BY id',
        [ids],
      ),
      pool.query('SELECT * FROM challenge_evidence WHERE challenge_id = ANY($1)', [ids]),
    ]);

    const lcByChallenge = new Map();
    for (const lc of lcRes.rows) {
      if (!lcByChallenge.has(lc.challenge_id)) lcByChallenge.set(lc.challenge_id, []);
      lcByChallenge.get(lc.challenge_id).push(lc);
    }
    const evByChallenge = new Map();
    for (const e of evRes.rows) {
      if (!evByChallenge.has(e.challenge_id)) evByChallenge.set(e.challenge_id, []);
      evByChallenge.get(e.challenge_id).push(e.evidence_id);
    }

    return challengeRows.map((row) =>
      buildChallengeRecord(
        row,
        lcByChallenge.get(row.challenge_id) || [],
        evByChallenge.get(row.challenge_id) || [],
      ),
    );
  }

  async transitionChallenge(challenge_id, { status, actor, notes, resolution_outcome }) {
    const ALLOWED_TRANSITIONS = {
      open:         new Set(['under_review', 'rejected']),
      under_review: new Set(['resolved', 'rejected']),
    };

    const pool = this._getPool();
    const cRes = await pool.query('SELECT * FROM challenges WHERE challenge_id = $1', [challenge_id]);
    if (cRes.rows.length === 0) {
      return { ok: false, error: `Challenge not found: ${challenge_id}`, status_code: 404 };
    }

    const current = cRes.rows[0];
    const allowed = ALLOWED_TRANSITIONS[current.status];
    if (!allowed) {
      return {
        ok: false,
        error: `Challenge ${challenge_id} is already in terminal state "${current.status}" and cannot be transitioned.`,
        status_code: 409,
      };
    }
    if (!allowed.has(status)) {
      return {
        ok: false,
        error: `Invalid transition from "${current.status}" to "${status}". ` +
               `Allowed from "${current.status}": ${[...allowed].join(', ')}.`,
        status_code: 422,
      };
    }

    if (status === 'resolved') {
      const ALLOWED_OUTCOMES = new Set(['acknowledged', 'will_not_fix', 'escalated']);
      if (!resolution_outcome || !ALLOWED_OUTCOMES.has(resolution_outcome)) {
        return {
          ok: false,
          error: `resolution_outcome is required when resolving a challenge. ` +
                 `Allowed: acknowledged, will_not_fix, escalated.`,
          status_code: 422,
        };
      }
    }

    const transitionAt = new Date().toISOString();

    await withTransaction(pool, async (client) => {
      if (status === 'resolved') {
        await client.query(
          `UPDATE challenges SET status = $1,
             resolution_outcome = $2,
             resolution_notes = $3,
             resolved_by = $4,
             resolved_at = $5
           WHERE challenge_id = $6`,
          [status, resolution_outcome, notes || null, actor || null, transitionAt, challenge_id],
        );
      } else {
        await client.query(
          'UPDATE challenges SET status = $1 WHERE challenge_id = $2',
          [status, challenge_id],
        );
      }
      await client.query(
        `INSERT INTO challenge_lifecycle (challenge_id, status, actor, transition_at, notes)
         VALUES ($1, $2, $3, $4, $5)`,
        [challenge_id, status, actor || null, transitionAt, notes || null],
      );
    });

    const record = await this.getChallenge(challenge_id);
    return { ok: true, record };
  }

  async reviewChallenge(challenge_id, { status, reviewed_by, review_notes }) {
    const mappedStatus  = status === 'accepted' ? 'resolved' : status;
    const mappedOutcome = status === 'accepted' ? 'acknowledged' : undefined;
    return this.transitionChallenge(challenge_id, {
      status:             mappedStatus,
      actor:              reviewed_by,
      notes:              review_notes,
      resolution_outcome: mappedOutcome,
    });
  }

  // ── Test helper ────────────────────────────────────────────────────────────
  // Truncates all investigation tables — only for test databases.

  async _reset() {
    const pool = this._getPool();
    // Truncate in dependency order; CASCADE handles child tables.
    await pool.query('TRUNCATE investigations CASCADE');
  }
}

// ---------------------------------------------------------------------------
// Module-level UUID generator (same algorithm as InvestigationRepository.js)
// ---------------------------------------------------------------------------
function _uuidv4() {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

module.exports = { PostgresInvestigationRepository };
