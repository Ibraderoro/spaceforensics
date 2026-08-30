'use strict';

/**
 * Phase 7.4 — Analyst Challenge Workflow — Unit Tests
 *
 * Tests the store functions directly: createChallenge, transitionChallenge,
 * getChallengesForCase, getInvestigationHistory with Phase 7.4 shape.
 *
 * Invariants verified:
 *   CH-1  Challenge record always carries case_id
 *   CH-2  Allowed target_type vocabulary
 *   CH-3  Challenge never modifies forensic fields
 *   CH-4  Lifecycle: open → under_review → resolved | rejected
 *   CH-5  resolution_metadata records outcome without mutating forensic fields
 *   CH-6  Terminal state cannot be re-transitioned
 *   CH-7  causal_attribution_established absent from challenge record
 *   CH-8  Probability claims tested at route layer; store receives clean data
 */

const {
  createInvestigation,
  createChallenge,
  getChallenge,
  getChallengesForInvestigation,
  getChallengesForCase,
  transitionChallenge,
  reviewChallenge,
  getInvestigationHistory,
  CHALLENGE_TARGET_TYPES,
  CHALLENGE_RESOLUTION_OUTCOMES,
  _reset,
} = require('../services/investigationStore');

const CASE_ID  = 'galaxy-15';
const CASE_ID2 = 'test-case-alpha';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeInv(caseId = CASE_ID) {
  return createInvestigation({ case_id: caseId, title: 'Test', opened_by: 'analyst' });
}

function makeChallenge(investigationId, caseId = CASE_ID, overrides = {}) {
  return createChallenge({
    investigation_id:  investigationId,
    case_id:           caseId,
    target_type:       overrides.target_type       || 'hypothesis_assessment',
    target_id:         overrides.target_id         || 'H1',
    authored_by:       overrides.authored_by       || 'analyst',
    analyst_statement: overrides.analyst_statement || 'The assessment appears inconsistent with available observations.',
    evidence_ids:      overrides.evidence_ids      || [],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Reset before each test
// ─────────────────────────────────────────────────────────────────────────────
beforeEach(() => { _reset(); });

// =============================================================================
// Module exports
// =============================================================================

describe('CHALLENGE_TARGET_TYPES and CHALLENGE_RESOLUTION_OUTCOMES exports', () => {
  test('CU-EX-1: CHALLENGE_TARGET_TYPES includes all five canonical types (CH-2)', () => {
    expect(CHALLENGE_TARGET_TYPES.has('hypothesis_assessment')).toBe(true);
    expect(CHALLENGE_TARGET_TYPES.has('evidence_classification')).toBe(true);
    expect(CHALLENGE_TARGET_TYPES.has('limitation')).toBe(true);
    expect(CHALLENGE_TARGET_TYPES.has('missing_evidence')).toBe(true);
    expect(CHALLENGE_TARGET_TYPES.has('additional_investigation')).toBe(true);
  });

  test('CU-EX-2: CHALLENGE_RESOLUTION_OUTCOMES includes acknowledged, will_not_fix, escalated (CH-5)', () => {
    expect(CHALLENGE_RESOLUTION_OUTCOMES.has('acknowledged')).toBe(true);
    expect(CHALLENGE_RESOLUTION_OUTCOMES.has('will_not_fix')).toBe(true);
    expect(CHALLENGE_RESOLUTION_OUTCOMES.has('escalated')).toBe(true);
  });
});

// =============================================================================
// createChallenge
// =============================================================================

describe('createChallenge', () => {
  test('CU-CR-1: returns { ok: true, record } for a valid challenge', () => {
    const inv = makeInv();
    const result = makeChallenge(inv.investigation_id);
    expect(result.ok).toBe(true);
    expect(result.record).toBeDefined();
  });

  test('CU-CR-2: challenge record has challenge_id as UUID', () => {
    const inv = makeInv();
    const { record } = makeChallenge(inv.investigation_id);
    expect(record.challenge_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  test('CU-CR-3: challenge record carries case_id (CH-1)', () => {
    const inv = makeInv();
    const { record } = makeChallenge(inv.investigation_id, CASE_ID);
    expect(record.case_id).toBe(CASE_ID);
  });

  test('CU-CR-4: challenge record carries investigation_id', () => {
    const inv = makeInv();
    const { record } = makeChallenge(inv.investigation_id);
    expect(record.investigation_id).toBe(inv.investigation_id);
  });

  test('CU-CR-5: initial status is "open" (CH-4)', () => {
    const inv = makeInv();
    const { record } = makeChallenge(inv.investigation_id);
    expect(record.status).toBe('open');
  });

  test('CU-CR-6: record has analyst_statement', () => {
    const inv = makeInv();
    const { record } = makeChallenge(inv.investigation_id, CASE_ID, {
      analyst_statement: 'Mixed assessment appears inconsistent.',
    });
    expect(record.analyst_statement).toBe('Mixed assessment appears inconsistent.');
  });

  test('CU-CR-7: lifecycle starts with an "open" entry (CH-4)', () => {
    const inv = makeInv();
    const { record } = makeChallenge(inv.investigation_id);
    expect(Array.isArray(record.lifecycle)).toBe(true);
    expect(record.lifecycle).toHaveLength(1);
    expect(record.lifecycle[0].status).toBe('open');
  });

  test('CU-CR-8: resolution_metadata is null on creation (CH-5)', () => {
    const inv = makeInv();
    const { record } = makeChallenge(inv.investigation_id);
    expect(record.resolution_metadata).toBeNull();
  });

  test('CU-CR-9: evidence_ids is stored as a copy', () => {
    const inv = makeInv();
    const ids = ['E-G15-0001'];
    const { record } = makeChallenge(inv.investigation_id, CASE_ID, { evidence_ids: ids });
    expect(record.evidence_ids).toEqual(ids);
    // mutating the original must not affect the stored record
    ids.push('E-G15-9999');
    expect(record.evidence_ids).toHaveLength(1);
  });

  test('CU-CR-10: challenge record does NOT carry assessment (CH-3)', () => {
    const inv = makeInv();
    const { record } = makeChallenge(inv.investigation_id);
    expect(record).not.toHaveProperty('assessment');
  });

  test('CU-CR-11: challenge record does NOT carry causal_attribution_established (CH-7)', () => {
    const inv = makeInv();
    const { record } = makeChallenge(inv.investigation_id);
    expect(record).not.toHaveProperty('causal_attribution_established');
  });

  test('CU-CR-12: all five target_type values are accepted (CH-2)', () => {
    const inv = makeInv();
    for (const tt of CHALLENGE_TARGET_TYPES) {
      const result = makeChallenge(inv.investigation_id, CASE_ID, {
        target_type: tt,
        target_id:   tt === 'hypothesis_assessment' ? 'H1' : 'some-target',
      });
      expect(result.ok).toBe(true);
    }
  });

  test('CU-CR-13: invalid target_type returns { ok: false }', () => {
    const inv = makeInv();
    const result = createChallenge({
      investigation_id:  inv.investigation_id,
      case_id:           CASE_ID,
      target_type:       'bad_type',
      target_id:         'H1',
      analyst_statement: 'Test.',
      evidence_ids:      [],
    });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(422);
  });

  test('CU-CR-14: created_at is an ISO timestamp', () => {
    const inv = makeInv();
    const { record } = makeChallenge(inv.investigation_id);
    expect(() => new Date(record.created_at)).not.toThrow();
    expect(record.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// =============================================================================
// getChallengesForCase
// =============================================================================

describe('getChallengesForCase', () => {
  test('CU-GCC-1: returns only challenges for the specified case_id (CH-1)', () => {
    const inv1 = makeInv(CASE_ID);
    const inv2 = makeInv(CASE_ID2);
    makeChallenge(inv1.investigation_id, CASE_ID);
    makeChallenge(inv2.investigation_id, CASE_ID2);
    const caseOneChallenges = getChallengesForCase(CASE_ID);
    expect(caseOneChallenges).toHaveLength(1);
    expect(caseOneChallenges[0].case_id).toBe(CASE_ID);
  });

  test('CU-GCC-2: cross-case challenge isolation — CASE_ID2 challenges absent from CASE_ID list', () => {
    const inv2 = makeInv(CASE_ID2);
    makeChallenge(inv2.investigation_id, CASE_ID2);
    const caseOneChallenges = getChallengesForCase(CASE_ID);
    expect(caseOneChallenges).toHaveLength(0);
  });

  test('CU-GCC-3: returns all challenges across multiple investigations for the same case', () => {
    const inv1 = makeInv(CASE_ID);
    const inv2 = makeInv(CASE_ID);
    makeChallenge(inv1.investigation_id, CASE_ID);
    makeChallenge(inv2.investigation_id, CASE_ID);
    const list = getChallengesForCase(CASE_ID);
    expect(list).toHaveLength(2);
    for (const c of list) {
      expect(c.case_id).toBe(CASE_ID);
    }
  });
});

// =============================================================================
// transitionChallenge — lifecycle
// =============================================================================

describe('transitionChallenge — lifecycle (CH-4)', () => {
  let inv;
  let challengeId;

  beforeEach(() => {
    inv = makeInv();
    const { record } = makeChallenge(inv.investigation_id);
    challengeId = record.challenge_id;
  });

  test('CU-TR-1: open → under_review succeeds', () => {
    const result = transitionChallenge(challengeId, { status: 'under_review', actor: 'reviewer' });
    expect(result.ok).toBe(true);
    expect(result.record.status).toBe('under_review');
  });

  test('CU-TR-2: open → rejected succeeds (fast-path)', () => {
    const result = transitionChallenge(challengeId, { status: 'rejected', actor: 'reviewer', notes: 'Out of scope.' });
    expect(result.ok).toBe(true);
    expect(result.record.status).toBe('rejected');
  });

  test('CU-TR-3: under_review → resolved succeeds with valid resolution_outcome (CH-5)', () => {
    transitionChallenge(challengeId, { status: 'under_review', actor: 'reviewer' });
    const result = transitionChallenge(challengeId, {
      status:             'resolved',
      actor:              'reviewer',
      notes:              'Acknowledged; assessment stands.',
      resolution_outcome: 'acknowledged',
    });
    expect(result.ok).toBe(true);
    expect(result.record.status).toBe('resolved');
  });

  test('CU-TR-4: resolved record has non-null resolution_metadata (CH-5)', () => {
    transitionChallenge(challengeId, { status: 'under_review', actor: 'reviewer' });
    const result = transitionChallenge(challengeId, {
      status:             'resolved',
      actor:              'reviewer-2',
      notes:              'Will not fix — insufficient supporting evidence for reclassification.',
      resolution_outcome: 'will_not_fix',
    });
    const meta = result.record.resolution_metadata;
    expect(meta).not.toBeNull();
    expect(meta.resolution_outcome).toBe('will_not_fix');
    expect(meta.resolved_by).toBe('reviewer-2');
    expect(typeof meta.resolved_at).toBe('string');
    expect(meta.resolution_notes).toContain('insufficient');
  });

  test('CU-TR-5: resolution_metadata does not contain assessment or causal field (CH-3, CH-5)', () => {
    transitionChallenge(challengeId, { status: 'under_review', actor: 'reviewer' });
    const result = transitionChallenge(challengeId, {
      status:             'resolved',
      actor:              'reviewer',
      resolution_outcome: 'escalated',
    });
    const meta = result.record.resolution_metadata;
    expect(meta).not.toHaveProperty('assessment');
    expect(meta).not.toHaveProperty('causal_attribution_established');
  });

  test('CU-TR-6: resolving without resolution_outcome returns { ok: false } (CH-5)', () => {
    transitionChallenge(challengeId, { status: 'under_review', actor: 'reviewer' });
    const result = transitionChallenge(challengeId, { status: 'resolved', actor: 'reviewer' });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(422);
  });

  test('CU-TR-7: resolving with invalid resolution_outcome returns { ok: false }', () => {
    transitionChallenge(challengeId, { status: 'under_review', actor: 'reviewer' });
    const result = transitionChallenge(challengeId, {
      status:             'resolved',
      actor:              'reviewer',
      resolution_outcome: 'bad_outcome',
    });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(422);
  });

  test('CU-TR-8: under_review → rejected succeeds', () => {
    transitionChallenge(challengeId, { status: 'under_review', actor: 'reviewer' });
    const result = transitionChallenge(challengeId, { status: 'rejected', actor: 'reviewer' });
    expect(result.ok).toBe(true);
    expect(result.record.status).toBe('rejected');
  });

  test('CU-TR-9: lifecycle array grows with each transition (CH-4)', () => {
    transitionChallenge(challengeId, { status: 'under_review', actor: 'reviewer' });
    const result = transitionChallenge(challengeId, {
      status:             'resolved',
      actor:              'reviewer',
      resolution_outcome: 'acknowledged',
    });
    // created (open) + under_review + resolved = 3 entries
    expect(result.record.lifecycle).toHaveLength(3);
  });

  test('CU-TR-10: each lifecycle entry has status, actor, timestamp, notes', () => {
    transitionChallenge(challengeId, { status: 'under_review', actor: 'reviewer-a', notes: 'Step one' });
    const result = transitionChallenge(challengeId, {
      status:             'resolved',
      actor:              'reviewer-b',
      notes:              'Step two',
      resolution_outcome: 'acknowledged',
    });
    for (const entry of result.record.lifecycle) {
      expect(typeof entry.status).toBe('string');
      expect(typeof entry.timestamp).toBe('string');
    }
    expect(result.record.lifecycle[1].actor).toBe('reviewer-a');
    expect(result.record.lifecycle[1].notes).toBe('Step one');
  });

  test('CU-TR-11: resolved challenge cannot be transitioned again (CH-6)', () => {
    transitionChallenge(challengeId, { status: 'under_review', actor: 'reviewer' });
    transitionChallenge(challengeId, {
      status:             'resolved',
      actor:              'reviewer',
      resolution_outcome: 'acknowledged',
    });
    // Try to transition resolved → under_review
    const result = transitionChallenge(challengeId, { status: 'under_review', actor: 'reviewer' });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(409);
  });

  test('CU-TR-12: rejected challenge cannot be transitioned again (CH-6)', () => {
    transitionChallenge(challengeId, { status: 'rejected', actor: 'reviewer' });
    const result = transitionChallenge(challengeId, { status: 'under_review', actor: 'reviewer' });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(409);
  });

  test('CU-TR-13: invalid transition open → resolved returns { ok: false }', () => {
    // Cannot go straight from open to resolved without under_review
    const result = transitionChallenge(challengeId, {
      status:             'resolved',
      actor:              'reviewer',
      resolution_outcome: 'acknowledged',
    });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(422);
  });

  test('CU-TR-14: unknown challenge_id returns { ok: false, status_code: 404 }', () => {
    const result = transitionChallenge('non-existent-uuid', { status: 'under_review', actor: 'a' });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(404);
  });

  test('CU-TR-15: all three resolution_outcome values are accepted (CH-5)', () => {
    for (const outcome of CHALLENGE_RESOLUTION_OUTCOMES) {
      _reset();
      const localInv = makeInv();
      const { record } = makeChallenge(localInv.investigation_id);
      transitionChallenge(record.challenge_id, { status: 'under_review', actor: 'reviewer' });
      const result = transitionChallenge(record.challenge_id, {
        status:             'resolved',
        actor:              'reviewer',
        resolution_outcome: outcome,
      });
      expect(result.ok).toBe(true);
      expect(result.record.resolution_metadata.resolution_outcome).toBe(outcome);
    }
  });
});

// =============================================================================
// reviewChallenge — backward-compat alias
// =============================================================================

describe('reviewChallenge backward-compatibility alias', () => {
  test('CU-RC-1: accepted maps to resolved/acknowledged', () => {
    const inv = makeInv();
    const { record } = makeChallenge(inv.investigation_id);
    const r1 = reviewChallenge(record.challenge_id, { status: 'under_review', reviewed_by: 'r' });
    expect(r1.ok).toBe(true);
    const r2 = reviewChallenge(record.challenge_id, { status: 'accepted', reviewed_by: 'r', review_notes: 'OK' });
    expect(r2.ok).toBe(true);
    expect(r2.record.status).toBe('resolved');
    expect(r2.record.resolution_metadata.resolution_outcome).toBe('acknowledged');
  });

  test('CU-RC-2: rejected still maps directly to rejected', () => {
    const inv = makeInv();
    const { record } = makeChallenge(inv.investigation_id);
    reviewChallenge(record.challenge_id, { status: 'under_review', reviewed_by: 'r' });
    const result = reviewChallenge(record.challenge_id, { status: 'rejected', reviewed_by: 'r' });
    expect(result.ok).toBe(true);
    expect(result.record.status).toBe('rejected');
  });
});

// =============================================================================
// getInvestigationHistory — Phase 7.4 shape
// =============================================================================

describe('getInvestigationHistory — Phase 7.4 challenge shape', () => {
  test('CU-HIS-1: history challenges carry analyst_statement (not rationale)', () => {
    const inv = makeInv();
    makeChallenge(inv.investigation_id, CASE_ID, {
      analyst_statement: 'Evidence window selection seems too narrow.',
    });
    const history = getInvestigationHistory(inv.investigation_id);
    expect(history.challenges).toHaveLength(1);
    expect(history.challenges[0]).toHaveProperty('analyst_statement');
    expect(history.challenges[0].analyst_statement).toBe('Evidence window selection seems too narrow.');
    expect(history.challenges[0]).not.toHaveProperty('rationale');
  });

  test('CU-HIS-2: history challenges carry lifecycle array (CH-4)', () => {
    const inv = makeInv();
    makeChallenge(inv.investigation_id);
    const history = getInvestigationHistory(inv.investigation_id);
    expect(Array.isArray(history.challenges[0].lifecycle)).toBe(true);
    expect(history.challenges[0]).not.toHaveProperty('review_history');
  });

  test('CU-HIS-3: history challenges carry resolution_metadata (CH-5)', () => {
    const inv = makeInv();
    const { record } = makeChallenge(inv.investigation_id);
    transitionChallenge(record.challenge_id, { status: 'under_review', actor: 'r' });
    transitionChallenge(record.challenge_id, {
      status: 'resolved', actor: 'r', resolution_outcome: 'escalated',
    });
    const history = getInvestigationHistory(inv.investigation_id);
    const c = history.challenges[0];
    expect(c.resolution_metadata).not.toBeNull();
    expect(c.resolution_metadata.resolution_outcome).toBe('escalated');
  });

  test('CU-HIS-4: history challenges carry case_id (CH-1)', () => {
    const inv = makeInv();
    makeChallenge(inv.investigation_id, CASE_ID);
    const history = getInvestigationHistory(inv.investigation_id);
    expect(history.challenges[0].case_id).toBe(CASE_ID);
  });

  test('CU-HIS-5: history challenges do NOT carry assessment or causal_attribution_established (CH-3, CH-7)', () => {
    const inv = makeInv();
    makeChallenge(inv.investigation_id);
    const history = getInvestigationHistory(inv.investigation_id);
    const c = history.challenges[0];
    expect(c).not.toHaveProperty('assessment');
    expect(c).not.toHaveProperty('causal_attribution_established');
  });
});
