'use strict';

/**
 * Phase 8.1 — InvestigationRepository Contract Tests
 *
 * Exercises InMemoryInvestigationRepository directly.  Every test in this file
 * targets the InvestigationRepository interface contract; the same suite could
 * be run against any future concrete implementation.
 *
 * Coverage:
 *   REPO-1   create / read round-trip for each entity type
 *   REPO-2   getInvestigation returns null for unknown id
 *   REPO-3   getObservation returns null for unknown id
 *   REPO-4   getChallenge returns null for unknown id
 *   REPO-5   investigation_id stability (same record object returned)
 *   REPO-6   cross-investigation isolation for observations
 *   REPO-7   cross-investigation isolation for challenges
 *   REPO-8   _reset() clears all state
 *   REPO-9   updateInvestigationStatus valid transitions
 *   REPO-10  updateObservation appends a new version
 *   REPO-11  transitionChallenge lifecycle progression
 *   REPO-12  getInvestigationsForCase returns only that case's records
 *   REPO-13  getChallengesForCase cross-case isolation
 *   REPO-14  getInvestigationHistory includes all entities
 *   REPO-15  interface abstract methods throw if not implemented
 */

const {
  InvestigationRepository,
  InMemoryInvestigationRepository,
  CHALLENGE_TARGET_TYPES,
  CHALLENGE_RESOLUTION_OUTCOMES,
} = require('../services/InvestigationRepository');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CASE_A = 'galaxy-15';
const CASE_B = 'test-case-alpha';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeRepo() {
  return new InMemoryInvestigationRepository();
}

function makeInv(repo, caseId = CASE_A) {
  return repo.createInvestigation({ case_id: caseId, title: 'Test', opened_by: 'analyst' });
}

function makeObs(repo, invId) {
  return repo.createObservation({
    investigation_id: invId,
    text:             'Test observation text.',
    authored_by:      'analyst',
    evidence_ids:     ['E-G15-0001'],
    hypothesis_ids:   ['H1'],
  });
}

function makeChallenge(repo, invId, caseId = CASE_A, overrides = {}) {
  return repo.createChallenge({
    investigation_id:  invId,
    case_id:           caseId,
    target_type:       overrides.target_type       || 'hypothesis_assessment',
    target_id:         overrides.target_id         || 'H1',
    authored_by:       overrides.authored_by       || 'analyst',
    analyst_statement: overrides.analyst_statement || 'Assessment appears inconsistent.',
    evidence_ids:      overrides.evidence_ids      || [],
  });
}

// ---------------------------------------------------------------------------
// REPO-15: Abstract interface enforcement
// ---------------------------------------------------------------------------

describe('REPO-15: InvestigationRepository abstract methods throw', () => {
  const base = new InvestigationRepository();

  const methods = [
    () => base.createInvestigation({ case_id: 'x' }),
    () => base.getInvestigation('id'),
    () => base.getInvestigationsForCase('x'),
    () => base.updateInvestigationStatus('id', { status: 'open' }),
    () => base.getInvestigationHistory('id'),
    () => base.createObservation({ investigation_id: 'id', text: 't' }),
    () => base.getObservation('id'),
    () => base.getObservationsForInvestigation('id'),
    () => base.updateObservation('id', { text: 't' }),
    () => base.createChallenge({ investigation_id: 'id', case_id: 'x', target_type: 't', target_id: 'y', analyst_statement: 's' }),
    () => base.getChallenge('id'),
    () => base.getChallengesForInvestigation('id'),
    () => base.getChallengesForCase('x'),
    () => base.transitionChallenge('id', { status: 'open' }),
    () => base.reviewChallenge('id', { status: 'rejected' }),
    () => base._reset(),
  ];

  test.each(methods.map((fn, i) => [i, fn]))(
    'abstract method %i throws',
    (_i, fn) => {
      expect(fn).toThrow('is not implemented');
    },
  );
});

// ---------------------------------------------------------------------------
// REPO-1: Create / read round-trip
// ---------------------------------------------------------------------------

describe('REPO-1: create / read round-trip', () => {
  let repo;
  beforeEach(() => { repo = makeRepo(); });

  test('REPO-1-INV: createInvestigation returns a complete record with UUID id', () => {
    const inv = makeInv(repo);
    expect(inv.investigation_id).toMatch(UUID_RE);
    expect(inv.case_id).toBe(CASE_A);
    expect(inv.status).toBe('open');
    expect(inv.opened_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Array.isArray(inv.events)).toBe(true);
    expect(inv.events).toHaveLength(1);
    expect(inv.events[0].event).toBe('opened');
  });

  test('REPO-1-OBS: createObservation returns a complete record', () => {
    const inv = makeInv(repo);
    const obs = makeObs(repo, inv.investigation_id);
    expect(obs.observation_id).toMatch(UUID_RE);
    expect(obs.investigation_id).toBe(inv.investigation_id);
    expect(obs.status).toBe('published');
    expect(obs.versions).toHaveLength(1);
    expect(obs.versions[0].text).toBe('Test observation text.');
    expect(obs.versions[0].version).toBe(1);
    expect(obs.evidence_ids).toEqual(['E-G15-0001']);
    expect(obs.hypothesis_ids).toEqual(['H1']);
  });

  test('REPO-1-CHAL: createChallenge returns { ok: true, record } with UUID id', () => {
    const inv = makeInv(repo);
    const result = makeChallenge(repo, inv.investigation_id);
    expect(result.ok).toBe(true);
    const c = result.record;
    expect(c.challenge_id).toMatch(UUID_RE);
    expect(c.investigation_id).toBe(inv.investigation_id);
    expect(c.case_id).toBe(CASE_A);
    expect(c.status).toBe('open');
    expect(c.lifecycle).toHaveLength(1);
    expect(c.lifecycle[0].status).toBe('open');
    expect(c.resolution_metadata).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// REPO-2/3/4: Not-found returns
// ---------------------------------------------------------------------------

describe('REPO-2/3/4: not-found returns null', () => {
  let repo;
  beforeEach(() => { repo = makeRepo(); });

  test('REPO-2: getInvestigation returns null for unknown id', () => {
    expect(repo.getInvestigation('no-such-id')).toBeNull();
  });

  test('REPO-3: getObservation returns null for unknown id', () => {
    expect(repo.getObservation('no-such-id')).toBeNull();
  });

  test('REPO-4: getChallenge returns null for unknown id', () => {
    expect(repo.getChallenge('no-such-id')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// REPO-5: Identifier stability
// ---------------------------------------------------------------------------

describe('REPO-5: identifier stability — same record object on repeat gets', () => {
  let repo;
  beforeEach(() => { repo = makeRepo(); });

  test('REPO-5-INV: same investigation record on second get', () => {
    const inv = makeInv(repo);
    const again = repo.getInvestigation(inv.investigation_id);
    expect(again).toBe(inv); // reference equality
    expect(again.investigation_id).toBe(inv.investigation_id);
  });

  test('REPO-5-OBS: same observation record on second get', () => {
    const inv = makeInv(repo);
    const obs = makeObs(repo, inv.investigation_id);
    const again = repo.getObservation(obs.observation_id);
    expect(again).toBe(obs);
  });

  test('REPO-5-CHAL: same challenge record on second get', () => {
    const inv = makeInv(repo);
    const { record } = makeChallenge(repo, inv.investigation_id);
    const again = repo.getChallenge(record.challenge_id);
    expect(again).toBe(record);
  });
});

// ---------------------------------------------------------------------------
// REPO-6: Cross-investigation isolation for observations
// ---------------------------------------------------------------------------

describe('REPO-6: cross-investigation observation isolation', () => {
  let repo;
  beforeEach(() => { repo = makeRepo(); });

  test('REPO-6: observations for inv-A are not visible under inv-B', () => {
    const invA = makeInv(repo, CASE_A);
    const invB = makeInv(repo, CASE_A);
    makeObs(repo, invA.investigation_id);
    makeObs(repo, invA.investigation_id);
    makeObs(repo, invB.investigation_id);

    const obsA = repo.getObservationsForInvestigation(invA.investigation_id);
    const obsB = repo.getObservationsForInvestigation(invB.investigation_id);
    expect(obsA).toHaveLength(2);
    expect(obsB).toHaveLength(1);
    for (const o of obsA) expect(o.investigation_id).toBe(invA.investigation_id);
    for (const o of obsB) expect(o.investigation_id).toBe(invB.investigation_id);
  });
});

// ---------------------------------------------------------------------------
// REPO-7: Cross-investigation isolation for challenges
// ---------------------------------------------------------------------------

describe('REPO-7: cross-investigation challenge isolation', () => {
  let repo;
  beforeEach(() => { repo = makeRepo(); });

  test('REPO-7: challenges for inv-A are not visible under inv-B', () => {
    const invA = makeInv(repo, CASE_A);
    const invB = makeInv(repo, CASE_A);
    makeChallenge(repo, invA.investigation_id);
    makeChallenge(repo, invB.investigation_id);
    makeChallenge(repo, invB.investigation_id);

    const chalA = repo.getChallengesForInvestigation(invA.investigation_id);
    const chalB = repo.getChallengesForInvestigation(invB.investigation_id);
    expect(chalA).toHaveLength(1);
    expect(chalB).toHaveLength(2);
    for (const c of chalA) expect(c.investigation_id).toBe(invA.investigation_id);
    for (const c of chalB) expect(c.investigation_id).toBe(invB.investigation_id);
  });
});

// ---------------------------------------------------------------------------
// REPO-8: _reset() clears all state
// ---------------------------------------------------------------------------

describe('REPO-8: _reset() clears all state', () => {
  let repo;
  beforeEach(() => { repo = makeRepo(); });

  test('REPO-8: after reset, all stores are empty', () => {
    const inv = makeInv(repo);
    makeObs(repo, inv.investigation_id);
    makeChallenge(repo, inv.investigation_id);

    repo._reset();

    expect(repo.getInvestigation(inv.investigation_id)).toBeNull();
    expect(repo.getInvestigationsForCase(CASE_A)).toHaveLength(0);
    expect(repo.getObservationsForInvestigation(inv.investigation_id)).toHaveLength(0);
    expect(repo.getChallengesForInvestigation(inv.investigation_id)).toHaveLength(0);
  });

  test('REPO-8b: entities created after reset are accessible', () => {
    makeInv(repo);
    repo._reset();
    const inv2 = makeInv(repo, CASE_B);
    expect(repo.getInvestigation(inv2.investigation_id)).not.toBeNull();
    expect(repo.getInvestigationsForCase(CASE_B)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// REPO-9: updateInvestigationStatus transitions
// ---------------------------------------------------------------------------

describe('REPO-9: updateInvestigationStatus', () => {
  let repo;
  beforeEach(() => { repo = makeRepo(); });

  test('REPO-9a: open → suspended succeeds and appends event', () => {
    const inv = makeInv(repo);
    const result = repo.updateInvestigationStatus(inv.investigation_id, { status: 'suspended', actor: 'a' });
    expect(result.ok).toBe(true);
    expect(result.record.status).toBe('suspended');
    expect(result.record.events).toHaveLength(2);
    expect(result.record.events[1].event).toBe('suspended');
  });

  test('REPO-9b: open → closed succeeds', () => {
    const inv = makeInv(repo);
    const result = repo.updateInvestigationStatus(inv.investigation_id, { status: 'closed', actor: 'a' });
    expect(result.ok).toBe(true);
    expect(result.record.status).toBe('closed');
  });

  test('REPO-9c: closed → open (re-open) succeeds and records re-opened event', () => {
    const inv = makeInv(repo);
    repo.updateInvestigationStatus(inv.investigation_id, { status: 'closed', actor: 'a' });
    const result = repo.updateInvestigationStatus(inv.investigation_id, { status: 'open', actor: 'b', reason: 'new evidence' });
    expect(result.ok).toBe(true);
    expect(result.record.status).toBe('open');
    const lastEvent = result.record.events[result.record.events.length - 1];
    expect(lastEvent.event).toBe('re-opened');
    expect(lastEvent.reason).toBe('new evidence');
  });

  test('REPO-9d: closed → suspended returns { ok: false, status_code: 409 }', () => {
    const inv = makeInv(repo);
    repo.updateInvestigationStatus(inv.investigation_id, { status: 'closed' });
    const result = repo.updateInvestigationStatus(inv.investigation_id, { status: 'suspended' });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(409);
  });

  test('REPO-9e: invalid status returns { ok: false, status_code: 422 }', () => {
    const inv = makeInv(repo);
    const result = repo.updateInvestigationStatus(inv.investigation_id, { status: 'deleted' });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(422);
  });

  test('REPO-9f: unknown investigation_id returns { ok: false, status_code: 404 }', () => {
    const result = repo.updateInvestigationStatus('no-such-id', { status: 'closed' });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// REPO-10: updateObservation appends a new version
// ---------------------------------------------------------------------------

describe('REPO-10: updateObservation', () => {
  let repo;
  beforeEach(() => { repo = makeRepo(); });

  test('REPO-10a: appends version and returns ok', () => {
    const inv = makeInv(repo);
    const obs = makeObs(repo, inv.investigation_id);
    const result = repo.updateObservation(obs.observation_id, { text: 'Revised text.', authored_by: 'editor' });
    expect(result.ok).toBe(true);
    expect(result.record.versions).toHaveLength(2);
    expect(result.record.versions[1].version).toBe(2);
    expect(result.record.versions[1].text).toBe('Revised text.');
    expect(result.record.versions[1].authored_by).toBe('editor');
  });

  test('REPO-10b: multiple updates create sequential versions', () => {
    const inv = makeInv(repo);
    const obs = makeObs(repo, inv.investigation_id);
    repo.updateObservation(obs.observation_id, { text: 'v2' });
    repo.updateObservation(obs.observation_id, { text: 'v3' });
    expect(obs.versions).toHaveLength(3);
    expect(obs.versions[2].version).toBe(3);
    expect(obs.versions[2].text).toBe('v3');
  });

  test('REPO-10c: unknown observation_id returns { ok: false, status_code: 404 }', () => {
    const result = repo.updateObservation('no-such-id', { text: 'x' });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// REPO-11: transitionChallenge lifecycle
// ---------------------------------------------------------------------------

describe('REPO-11: transitionChallenge lifecycle', () => {
  let repo;
  let invId;
  let challengeId;

  beforeEach(() => {
    repo = makeRepo();
    const inv = makeInv(repo);
    invId = inv.investigation_id;
    const { record } = makeChallenge(repo, invId);
    challengeId = record.challenge_id;
  });

  test('REPO-11a: open → under_review appends lifecycle entry', () => {
    const result = repo.transitionChallenge(challengeId, { status: 'under_review', actor: 'r' });
    expect(result.ok).toBe(true);
    expect(result.record.status).toBe('under_review');
    expect(result.record.lifecycle).toHaveLength(2);
  });

  test('REPO-11b: open → rejected (fast-path) succeeds', () => {
    const result = repo.transitionChallenge(challengeId, { status: 'rejected', actor: 'r', notes: 'OOS' });
    expect(result.ok).toBe(true);
    expect(result.record.status).toBe('rejected');
  });

  test('REPO-11c: under_review → resolved with resolution_outcome sets resolution_metadata', () => {
    repo.transitionChallenge(challengeId, { status: 'under_review', actor: 'r' });
    const result = repo.transitionChallenge(challengeId, {
      status: 'resolved', actor: 'r2', notes: 'OK', resolution_outcome: 'acknowledged',
    });
    expect(result.ok).toBe(true);
    expect(result.record.status).toBe('resolved');
    expect(result.record.resolution_metadata).not.toBeNull();
    expect(result.record.resolution_metadata.resolution_outcome).toBe('acknowledged');
    expect(result.record.resolution_metadata.resolved_by).toBe('r2');
  });

  test('REPO-11d: resolving without resolution_outcome returns { ok: false, status_code: 422 }', () => {
    repo.transitionChallenge(challengeId, { status: 'under_review', actor: 'r' });
    const result = repo.transitionChallenge(challengeId, { status: 'resolved', actor: 'r' });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(422);
  });

  test('REPO-11e: terminal state → any transition returns { ok: false, status_code: 409 }', () => {
    repo.transitionChallenge(challengeId, { status: 'rejected', actor: 'r' });
    const result = repo.transitionChallenge(challengeId, { status: 'under_review', actor: 'r' });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(409);
  });

  test('REPO-11f: invalid transition open → resolved returns { ok: false, status_code: 422 }', () => {
    const result = repo.transitionChallenge(challengeId, {
      status: 'resolved', actor: 'r', resolution_outcome: 'acknowledged',
    });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(422);
  });

  test('REPO-11g: unknown challenge_id returns { ok: false, status_code: 404 }', () => {
    const result = repo.transitionChallenge('no-such-id', { status: 'under_review', actor: 'r' });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(404);
  });

  test('REPO-11h: lifecycle grows with each transition (open + under_review + resolved = 3)', () => {
    repo.transitionChallenge(challengeId, { status: 'under_review', actor: 'r' });
    const result = repo.transitionChallenge(challengeId, {
      status: 'resolved', actor: 'r', resolution_outcome: 'escalated',
    });
    expect(result.record.lifecycle).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// REPO-12: getInvestigationsForCase returns only that case's records
// ---------------------------------------------------------------------------

describe('REPO-12: getInvestigationsForCase scoping', () => {
  let repo;
  beforeEach(() => { repo = makeRepo(); });

  test('REPO-12a: returns only investigations for the given case_id', () => {
    makeInv(repo, CASE_A);
    makeInv(repo, CASE_A);
    makeInv(repo, CASE_B);

    const listA = repo.getInvestigationsForCase(CASE_A);
    const listB = repo.getInvestigationsForCase(CASE_B);
    expect(listA).toHaveLength(2);
    expect(listB).toHaveLength(1);
    for (const inv of listA) expect(inv.case_id).toBe(CASE_A);
    for (const inv of listB) expect(inv.case_id).toBe(CASE_B);
  });

  test('REPO-12b: unknown case returns empty array', () => {
    expect(repo.getInvestigationsForCase('no-such-case')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// REPO-13: getChallengesForCase cross-case isolation
// ---------------------------------------------------------------------------

describe('REPO-13: getChallengesForCase cross-case isolation', () => {
  let repo;
  beforeEach(() => { repo = makeRepo(); });

  test('REPO-13a: challenges are scoped by case_id (CH-1)', () => {
    const invA = makeInv(repo, CASE_A);
    const invB = makeInv(repo, CASE_B);
    makeChallenge(repo, invA.investigation_id, CASE_A);
    makeChallenge(repo, invA.investigation_id, CASE_A);
    makeChallenge(repo, invB.investigation_id, CASE_B);

    const caseAChallenges = repo.getChallengesForCase(CASE_A);
    const caseBChallenges = repo.getChallengesForCase(CASE_B);
    expect(caseAChallenges).toHaveLength(2);
    expect(caseBChallenges).toHaveLength(1);
    for (const c of caseAChallenges) expect(c.case_id).toBe(CASE_A);
    for (const c of caseBChallenges) expect(c.case_id).toBe(CASE_B);
  });

  test('REPO-13b: getChallengesForCase spans multiple investigations of the same case', () => {
    const inv1 = makeInv(repo, CASE_A);
    const inv2 = makeInv(repo, CASE_A);
    makeChallenge(repo, inv1.investigation_id, CASE_A);
    makeChallenge(repo, inv2.investigation_id, CASE_A);

    const list = repo.getChallengesForCase(CASE_A);
    expect(list).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// REPO-14: getInvestigationHistory includes all entities
// ---------------------------------------------------------------------------

describe('REPO-14: getInvestigationHistory', () => {
  let repo;
  beforeEach(() => { repo = makeRepo(); });

  test('REPO-14a: returns null for unknown investigation_id', () => {
    expect(repo.getInvestigationHistory('no-such-id')).toBeNull();
  });

  test('REPO-14b: includes events array', () => {
    const inv = makeInv(repo);
    const history = repo.getInvestigationHistory(inv.investigation_id);
    expect(history).not.toBeNull();
    expect(history.investigation_id).toBe(inv.investigation_id);
    expect(Array.isArray(history.events)).toBe(true);
    expect(history.events[0].event).toBe('opened');
  });

  test('REPO-14c: includes observations with version history', () => {
    const inv = makeInv(repo);
    makeObs(repo, inv.investigation_id);
    const history = repo.getInvestigationHistory(inv.investigation_id);
    expect(history.observations).toHaveLength(1);
    const o = history.observations[0];
    expect(o).toHaveProperty('observation_id');
    expect(o).toHaveProperty('current_text');
    expect(o).toHaveProperty('versions');
    expect(o).toHaveProperty('version_count');
    expect(o.version_count).toBe(1);
  });

  test('REPO-14d: includes challenges with lifecycle and resolution_metadata', () => {
    const inv = makeInv(repo);
    const { record } = makeChallenge(repo, inv.investigation_id);
    repo.transitionChallenge(record.challenge_id, { status: 'under_review', actor: 'r' });
    repo.transitionChallenge(record.challenge_id, {
      status: 'resolved', actor: 'r', resolution_outcome: 'acknowledged',
    });
    const history = repo.getInvestigationHistory(inv.investigation_id);
    expect(history.challenges).toHaveLength(1);
    const c = history.challenges[0];
    expect(c).toHaveProperty('analyst_statement');
    expect(c).toHaveProperty('lifecycle');
    expect(c.lifecycle).toHaveLength(3);
    expect(c.resolution_metadata).not.toBeNull();
    expect(c.resolution_metadata.resolution_outcome).toBe('acknowledged');
  });

  test('REPO-14e: only includes entities for this investigation', () => {
    const invA = makeInv(repo);
    const invB = makeInv(repo);
    makeObs(repo, invA.investigation_id);
    makeObs(repo, invB.investigation_id);
    makeChallenge(repo, invA.investigation_id);
    makeChallenge(repo, invB.investigation_id);
    makeChallenge(repo, invB.investigation_id);

    const histA = repo.getInvestigationHistory(invA.investigation_id);
    const histB = repo.getInvestigationHistory(invB.investigation_id);
    expect(histA.observations).toHaveLength(1);
    expect(histA.challenges).toHaveLength(1);
    expect(histB.observations).toHaveLength(1);
    expect(histB.challenges).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// REPO constants: exported vocabulary sets
// ---------------------------------------------------------------------------

describe('exported vocabulary constants', () => {
  test('CHALLENGE_TARGET_TYPES contains all 5 canonical types', () => {
    expect(CHALLENGE_TARGET_TYPES.has('hypothesis_assessment')).toBe(true);
    expect(CHALLENGE_TARGET_TYPES.has('evidence_classification')).toBe(true);
    expect(CHALLENGE_TARGET_TYPES.has('limitation')).toBe(true);
    expect(CHALLENGE_TARGET_TYPES.has('missing_evidence')).toBe(true);
    expect(CHALLENGE_TARGET_TYPES.has('additional_investigation')).toBe(true);
    expect(CHALLENGE_TARGET_TYPES.size).toBe(5);
  });

  test('CHALLENGE_RESOLUTION_OUTCOMES contains all 3 canonical outcomes', () => {
    expect(CHALLENGE_RESOLUTION_OUTCOMES.has('acknowledged')).toBe(true);
    expect(CHALLENGE_RESOLUTION_OUTCOMES.has('will_not_fix')).toBe(true);
    expect(CHALLENGE_RESOLUTION_OUTCOMES.has('escalated')).toBe(true);
    expect(CHALLENGE_RESOLUTION_OUTCOMES.size).toBe(3);
  });

  test('createChallenge rejects invalid target_type', () => {
    const repo = makeRepo();
    const inv  = makeInv(repo);
    const result = repo.createChallenge({
      investigation_id:  inv.investigation_id,
      case_id:           CASE_A,
      target_type:       'bad_type',
      target_id:         'H1',
      analyst_statement: 'Test.',
      evidence_ids:      [],
    });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(422);
  });

  test('evidence_ids are stored as a defensive copy', () => {
    const repo = makeRepo();
    const inv  = makeInv(repo);
    const ids  = ['E-G15-0001'];
    const { record } = repo.createChallenge({
      investigation_id:  inv.investigation_id,
      case_id:           CASE_A,
      target_type:       'hypothesis_assessment',
      target_id:         'H1',
      analyst_statement: 'Test.',
      evidence_ids:      ids,
    });
    ids.push('E-MUTATION-0001');
    expect(record.evidence_ids).toHaveLength(1);
  });

  test('reviewChallenge backward-compat: accepted maps to resolved/acknowledged', () => {
    const repo = makeRepo();
    const inv  = makeInv(repo);
    const { record } = makeChallenge(repo, inv.investigation_id);
    repo.reviewChallenge(record.challenge_id, { status: 'under_review', reviewed_by: 'r' });
    const result = repo.reviewChallenge(record.challenge_id, {
      status: 'accepted', reviewed_by: 'r', review_notes: 'ok',
    });
    expect(result.ok).toBe(true);
    expect(result.record.status).toBe('resolved');
    expect(result.record.resolution_metadata.resolution_outcome).toBe('acknowledged');
  });
});
