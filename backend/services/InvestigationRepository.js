'use strict';

// ---------------------------------------------------------------------------
// InvestigationRepository.js — Phase 8.1
//
// Defines the persistence abstraction for the Investigation operational layer.
//
// TWO EXPORTS:
//   InvestigationRepository         — abstract interface / contract class
//   InMemoryInvestigationRepository — concrete in-memory implementation that
//                                     exactly matches the Phase 7 Map-based
//                                     behaviour of investigationStore.js
//
// DESIGN INVARIANTS (inherited from investigationStore.js)
//   STORE-1  Every investigation is scoped to exactly one case_id.
//   STORE-2  investigation_id is a server-generated UUID; never client-supplied.
//   STORE-3  The repository is completely separate from the forensic pipeline.
//   STORE-4  Analyst-created content never becomes evidence.
//   STORE-5  evidence_id citations validated at call-site before insertion.
//   STORE-6  hypothesis_id citations validated at call-site before insertion.
//   STORE-7  causal_attribution_established is never stored or mutated here.
//
// CHALLENGE INVARIANTS (CH-1 … CH-8) — same as investigationStore.js.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tiny deterministic UUID v4 generator — no external dependency.
// Produces the canonical xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx format.
// ---------------------------------------------------------------------------
function uuidv4() {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant bits
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// CHALLENGE_TARGET_TYPES — vocabulary constant shared by interface and callers.
// ---------------------------------------------------------------------------
const CHALLENGE_TARGET_TYPES = new Set([
  'hypothesis_assessment',
  'evidence_classification',
  'limitation',
  'missing_evidence',
  'additional_investigation',
]);

// CHALLENGE_RESOLUTION_OUTCOMES — vocabulary constant.
const CHALLENGE_RESOLUTION_OUTCOMES = new Set([
  'acknowledged',
  'will_not_fix',
  'escalated',
]);

// ===========================================================================
// InvestigationRepository — abstract interface / contract
//
// Concrete implementations MUST honour every method signature and return shape
// documented here.  All methods are synchronous in the in-memory
// implementation; a future persistent implementation may return Promises.
// ===========================================================================
class InvestigationRepository {
  // ── Investigations ─────────────────────────────────────────────────────────

  /**
   * Create and persist a new investigation.
   * investigation_id must be server-generated (STORE-2).
   *
   * @param {{ case_id: string, title?: string, opened_by?: string, description?: string }} params
   * @returns {InvestigationRecord}
   */
  // eslint-disable-next-line no-unused-vars
  createInvestigation({ case_id, title, opened_by, description }) {
    throw new Error('InvestigationRepository.createInvestigation() is not implemented');
  }

  /**
   * Return the investigation record for the given id, or null if not found.
   *
   * @param {string} investigation_id
   * @returns {InvestigationRecord|null}
   */
  // eslint-disable-next-line no-unused-vars
  getInvestigation(investigation_id) {
    throw new Error('InvestigationRepository.getInvestigation() is not implemented');
  }

  /**
   * Return all investigation records for the given case_id.
   *
   * @param {string} case_id
   * @returns {InvestigationRecord[]}
   */
  // eslint-disable-next-line no-unused-vars
  getInvestigationsForCase(case_id) {
    throw new Error('InvestigationRepository.getInvestigationsForCase() is not implemented');
  }

  /**
   * Transition the investigation status.
   * Allowed statuses: 'open' | 'suspended' | 'closed'.
   * Returns { ok: true, record } on success, or { ok: false, error, status_code } on failure.
   *
   * @param {string} investigation_id
   * @param {{ status: string, actor?: string, reason?: string }} params
   * @returns {{ ok: boolean, record?: InvestigationRecord, error?: string, status_code?: number }}
   */
  // eslint-disable-next-line no-unused-vars
  updateInvestigationStatus(investigation_id, { status, actor, reason }) {
    throw new Error('InvestigationRepository.updateInvestigationStatus() is not implemented');
  }

  /**
   * Return the full audit trail for an investigation (events + observations +
   * challenges).  Returns null if the investigation does not exist.
   *
   * @param {string} investigation_id
   * @returns {InvestigationHistory|null}
   */
  // eslint-disable-next-line no-unused-vars
  getInvestigationHistory(investigation_id) {
    throw new Error('InvestigationRepository.getInvestigationHistory() is not implemented');
  }

  // ── Observations ───────────────────────────────────────────────────────────

  /**
   * Create and persist a new observation.
   * Caller must have already validated evidence_ids, hypothesis_ids, and
   * that the investigation is open (STORE-5, STORE-6).
   *
   * @param {{ investigation_id: string, text: string, authored_by?: string, evidence_ids?: string[], hypothesis_ids?: string[] }} params
   * @returns {ObservationRecord}
   */
  // eslint-disable-next-line no-unused-vars
  createObservation({ investigation_id, text, authored_by, evidence_ids, hypothesis_ids }) {
    throw new Error('InvestigationRepository.createObservation() is not implemented');
  }

  /**
   * Return the observation record for the given id, or null if not found.
   *
   * @param {string} observation_id
   * @returns {ObservationRecord|null}
   */
  // eslint-disable-next-line no-unused-vars
  getObservation(observation_id) {
    throw new Error('InvestigationRepository.getObservation() is not implemented');
  }

  /**
   * Return all observations for the given investigation_id.
   *
   * @param {string} investigation_id
   * @returns {ObservationRecord[]}
   */
  // eslint-disable-next-line no-unused-vars
  getObservationsForInvestigation(investigation_id) {
    throw new Error('InvestigationRepository.getObservationsForInvestigation() is not implemented');
  }

  /**
   * Append a new version to an existing observation.
   * Returns { ok: true, record } on success, or { ok: false, error, status_code } on failure.
   *
   * @param {string} observation_id
   * @param {{ text: string, authored_by?: string }} params
   * @returns {{ ok: boolean, record?: ObservationRecord, error?: string, status_code?: number }}
   */
  // eslint-disable-next-line no-unused-vars
  updateObservation(observation_id, { text, authored_by }) {
    throw new Error('InvestigationRepository.updateObservation() is not implemented');
  }

  // ── Challenges ─────────────────────────────────────────────────────────────

  /**
   * Create and persist a new challenge.
   * Returns { ok: true, record } or { ok: false, error, status_code }.
   *
   * @param {{ investigation_id: string, case_id: string, target_type: string, target_id: string, authored_by?: string, analyst_statement: string, evidence_ids?: string[] }} params
   * @returns {{ ok: boolean, record?: ChallengeRecord, error?: string, status_code?: number }}
   */
  // eslint-disable-next-line no-unused-vars
  createChallenge({ investigation_id, case_id, target_type, target_id, authored_by, analyst_statement, evidence_ids }) {
    throw new Error('InvestigationRepository.createChallenge() is not implemented');
  }

  /**
   * Return the challenge record for the given id, or null if not found.
   *
   * @param {string} challenge_id
   * @returns {ChallengeRecord|null}
   */
  // eslint-disable-next-line no-unused-vars
  getChallenge(challenge_id) {
    throw new Error('InvestigationRepository.getChallenge() is not implemented');
  }

  /**
   * Return all challenges for the given investigation_id.
   *
   * @param {string} investigation_id
   * @returns {ChallengeRecord[]}
   */
  // eslint-disable-next-line no-unused-vars
  getChallengesForInvestigation(investigation_id) {
    throw new Error('InvestigationRepository.getChallengesForInvestigation() is not implemented');
  }

  /**
   * Return all challenges across all investigations for the given case_id (CH-1).
   *
   * @param {string} case_id
   * @returns {ChallengeRecord[]}
   */
  // eslint-disable-next-line no-unused-vars
  getChallengesForCase(case_id) {
    throw new Error('InvestigationRepository.getChallengesForCase() is not implemented');
  }

  /**
   * Transition a challenge through its lifecycle (CH-4).
   * Returns { ok: true, record } or { ok: false, error, status_code }.
   *
   * @param {string} challenge_id
   * @param {{ status: string, actor?: string, notes?: string, resolution_outcome?: string }} params
   * @returns {{ ok: boolean, record?: ChallengeRecord, error?: string, status_code?: number }}
   */
  // eslint-disable-next-line no-unused-vars
  transitionChallenge(challenge_id, { status, actor, notes, resolution_outcome }) {
    throw new Error('InvestigationRepository.transitionChallenge() is not implemented');
  }

  /**
   * Backward-compatibility alias for Phase 7.2 callers.
   * Maps the old reviewChallenge interface onto transitionChallenge.
   *
   * @param {string} challenge_id
   * @param {{ status: string, reviewed_by?: string, review_notes?: string }} params
   * @returns {{ ok: boolean, record?: ChallengeRecord, error?: string, status_code?: number }}
   */
  // eslint-disable-next-line no-unused-vars
  reviewChallenge(challenge_id, { status, reviewed_by, review_notes }) {
    throw new Error('InvestigationRepository.reviewChallenge() is not implemented');
  }

  // ── Test helper ────────────────────────────────────────────────────────────

  /**
   * Clear all persisted state.  For use in tests only.
   */
  _reset() {
    throw new Error('InvestigationRepository._reset() is not implemented');
  }
}

// ===========================================================================
// InMemoryInvestigationRepository
//
// Concrete implementation backed by three in-memory Maps.  Behaviour is
// identical to the original investigationStore.js Phase 7 implementation —
// this class is the authoritative in-memory persistence layer.
// ===========================================================================
class InMemoryInvestigationRepository extends InvestigationRepository {
  constructor() {
    super();
    /** @type {Map<string, object>} */
    this._investigations = new Map();
    /** @type {Map<string, object>} */
    this._observations   = new Map();
    /** @type {Map<string, object>} */
    this._challenges     = new Map();
  }

  // ── Investigations ─────────────────────────────────────────────────────────

  createInvestigation({ case_id, title, opened_by, description }) {
    const investigation_id = uuidv4();
    const opened_at        = new Date().toISOString();

    const record = {
      investigation_id,
      case_id,
      title:       title       || `Investigation for ${case_id}`,
      description: description || null,
      opened_by:   opened_by   || null,
      opened_at,
      status: 'open',
      events: [
        {
          event:     'opened',
          actor:     opened_by || null,
          timestamp: opened_at,
          reason:    null,
        },
      ],
    };

    this._investigations.set(investigation_id, record);
    return record;
  }

  getInvestigation(investigation_id) {
    return this._investigations.get(investigation_id) || null;
  }

  getInvestigationsForCase(case_id) {
    return [...this._investigations.values()].filter((inv) => inv.case_id === case_id);
  }

  updateInvestigationStatus(investigation_id, { status, actor, reason }) {
    const record = this._investigations.get(investigation_id);
    if (!record) {
      return { ok: false, error: `Investigation not found: ${investigation_id}`, status_code: 404 };
    }

    const ALLOWED_STATUSES = new Set(['open', 'suspended', 'closed']);
    if (!ALLOWED_STATUSES.has(status)) {
      return {
        ok: false,
        error: `Invalid status "${status}". Allowed: open, suspended, closed.`,
        status_code: 422,
      };
    }

    if (record.status === 'closed' && status !== 'open') {
      return {
        ok: false,
        error: 'Investigation is closed. Re-open it before making changes.',
        status_code: 409,
      };
    }

    const prev = record.status;
    record.status = status;

    const eventMap = {
      suspended: 'suspended',
      closed:    'closed',
      open:      prev === 'closed' ? 're-opened' : 'resumed',
    };

    record.events.push({
      event:     eventMap[status],
      actor:     actor  || null,
      timestamp: new Date().toISOString(),
      reason:    reason || null,
    });

    return { ok: true, record };
  }

  getInvestigationHistory(investigation_id) {
    const inv = this._investigations.get(investigation_id);
    if (!inv) return null;

    return {
      investigation_id,
      case_id:  inv.case_id,
      status:   inv.status,
      events:   [...inv.events],
      observations: this.getObservationsForInvestigation(investigation_id).map((o) => ({
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
      challenges: this.getChallengesForInvestigation(investigation_id).map((c) => ({
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

  createObservation({ investigation_id, text, authored_by, evidence_ids, hypothesis_ids }) {
    const observation_id = uuidv4();
    const authored_at    = new Date().toISOString();

    const record = {
      observation_id,
      investigation_id,
      authored_by:    authored_by    || null,
      authored_at,
      status: 'published',
      versions: [
        {
          version:     1,
          text:        text || '',
          authored_by: authored_by || null,
          authored_at,
        },
      ],
      evidence_ids:   Array.isArray(evidence_ids)   ? [...evidence_ids]   : [],
      hypothesis_ids: Array.isArray(hypothesis_ids) ? [...hypothesis_ids] : [],
    };

    this._observations.set(observation_id, record);
    return record;
  }

  getObservation(observation_id) {
    return this._observations.get(observation_id) || null;
  }

  getObservationsForInvestigation(investigation_id) {
    return [...this._observations.values()].filter(
      (o) => o.investigation_id === investigation_id,
    );
  }

  updateObservation(observation_id, { text, authored_by }) {
    const record = this._observations.get(observation_id);
    if (!record) {
      return { ok: false, error: `Observation not found: ${observation_id}`, status_code: 404 };
    }
    if (record.status === 'superseded' || record.status === 'deleted') {
      return {
        ok: false,
        error: `Observation ${observation_id} is ${record.status} and cannot be edited.`,
        status_code: 409,
      };
    }

    const nextVersion = record.versions.length + 1;
    const authored_at = new Date().toISOString();

    record.versions.push({
      version:     nextVersion,
      text:        text || '',
      authored_by: authored_by || null,
      authored_at,
    });

    return { ok: true, record };
  }

  // ── Challenges ─────────────────────────────────────────────────────────────

  createChallenge({
    investigation_id,
    case_id,
    target_type,
    target_id,
    authored_by,
    analyst_statement,
    evidence_ids,
  }) {
    const ALLOWED_TARGET_TYPES = new Set([
      'hypothesis_assessment',
      'evidence_classification',
      'limitation',
      'missing_evidence',
      'additional_investigation',
    ]);

    if (!ALLOWED_TARGET_TYPES.has(target_type)) {
      return {
        ok: false,
        error:
          `Invalid target_type "${target_type}". ` +
          `Allowed: hypothesis_assessment, evidence_classification, ` +
          `limitation, missing_evidence, additional_investigation.`,
        status_code: 422,
      };
    }

    const challenge_id = uuidv4();
    const created_at   = new Date().toISOString();

    const record = {
      challenge_id,
      investigation_id,
      case_id:           case_id          || null,
      target_type,
      target_id,
      authored_by:       authored_by      || null,
      created_at,
      analyst_statement: analyst_statement || '',
      status: 'open',
      evidence_ids: Array.isArray(evidence_ids) ? [...evidence_ids] : [],
      lifecycle: [
        { status: 'open', actor: authored_by || null, timestamp: created_at, notes: null },
      ],
      resolution_metadata: null,
    };

    this._challenges.set(challenge_id, record);
    return { ok: true, record };
  }

  getChallenge(challenge_id) {
    return this._challenges.get(challenge_id) || null;
  }

  getChallengesForInvestigation(investigation_id) {
    return [...this._challenges.values()].filter(
      (c) => c.investigation_id === investigation_id,
    );
  }

  getChallengesForCase(case_id) {
    return [...this._challenges.values()].filter((c) => c.case_id === case_id);
  }

  transitionChallenge(challenge_id, { status, actor, notes, resolution_outcome }) {
    const record = this._challenges.get(challenge_id);
    if (!record) {
      return { ok: false, error: `Challenge not found: ${challenge_id}`, status_code: 404 };
    }

    const ALLOWED_TRANSITIONS = {
      open:         new Set(['under_review', 'rejected']),
      under_review: new Set(['resolved', 'rejected']),
    };

    const allowed = ALLOWED_TRANSITIONS[record.status];
    if (!allowed) {
      return {
        ok: false,
        error: `Challenge ${challenge_id} is already in terminal state "${record.status}" and cannot be transitioned.`,
        status_code: 409,
      };
    }
    if (!allowed.has(status)) {
      return {
        ok: false,
        error: `Invalid transition from "${record.status}" to "${status}". ` +
               `Allowed from "${record.status}": ${[...allowed].join(', ')}.`,
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
      record.resolution_metadata = {
        resolution_outcome,
        resolution_notes: notes || null,
        resolved_by:      actor || null,
        resolved_at:      new Date().toISOString(),
      };
    }

    record.status = status;
    record.lifecycle.push({
      status,
      actor:     actor || null,
      timestamp: new Date().toISOString(),
      notes:     notes || null,
    });

    return { ok: true, record };
  }

  reviewChallenge(challenge_id, { status, reviewed_by, review_notes }) {
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

  _reset() {
    this._investigations.clear();
    this._observations.clear();
    this._challenges.clear();
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  InvestigationRepository,
  InMemoryInvestigationRepository,
  CHALLENGE_TARGET_TYPES,
  CHALLENGE_RESOLUTION_OUTCOMES,
};
