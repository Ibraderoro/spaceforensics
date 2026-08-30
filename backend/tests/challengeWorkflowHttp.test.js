'use strict';

/**
 * Phase 7.4 — Analyst Challenge Workflow — HTTP Integration Tests
 *
 * Covers the full auditable challenge lifecycle via real HTTP (supertest).
 * No existing test is modified or weakened.
 *
 * Endpoints covered:
 *   POST   /api/cases/:id/investigations/:iid/challenges
 *   GET    /api/cases/:id/investigations/:iid/challenges
 *   GET    /api/cases/:id/investigations/:iid/challenges/:cid
 *   PATCH  /api/cases/:id/investigations/:iid/challenges/:cid
 *   GET    /api/cases/:id/challenges
 *
 * Invariants verified:
 *   CH-1  challenge record always carries case_id
 *   CH-2  allowed target_type vocabulary enforced
 *   CH-3  challenge never modifies forensic fields
 *   CH-4  lifecycle: open → under_review → resolved | rejected
 *   CH-5  resolution_metadata records outcome without mutating forensic fields
 *   CH-6  terminal state cannot be re-transitioned
 *   CH-7  causal_attribution_established blocked in challenge body
 *   CH-8  numerical probability claims blocked in analyst_statement
 */

const request = require('supertest');
const { app, investigationStore } = require('../server');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const G15   = 'galaxy-15';
const TCA   = 'test-case-alpha';
const BOGUS = 'no-such-case-ph74';

const G15_VALID_EVIDENCE_ID = 'E-G15-0001';
const G15_VALID_HYPOTHESIS  = 'H1';
const TCA_VALID_EVIDENCE_ID = 'E-TCA-0001';
const TCA_VALID_HYPOTHESIS  = 'H1';

const FABRICATED_EVIDENCE_ID = 'E-FAKE-0000';
const FABRICATED_HYPOTHESIS  = 'HFAKE';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ALL_TARGET_TYPES = [
  'hypothesis_assessment',
  'evidence_classification',
  'limitation',
  'missing_evidence',
  'additional_investigation',
];

const ALL_RESOLUTION_OUTCOMES = ['acknowledged', 'will_not_fix', 'escalated'];

// ─────────────────────────────────────────────────────────────────────────────
// Reset store before each test
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => { investigationStore._reset(); });

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function createInv(caseId = G15) {
  const res = await request(app)
    .post(`/api/cases/${caseId}/investigations`)
    .send({ title: 'Test Investigation', opened_by: 'analyst' });
  return res.body;
}

async function createChallenge(caseId, iid, overrides = {}) {
  return request(app)
    .post(`/api/cases/${caseId}/investigations/${iid}/challenges`)
    .send({
      target_type:       overrides.target_type       || 'hypothesis_assessment',
      target_id:         overrides.target_id         || G15_VALID_HYPOTHESIS,
      analyst_statement: overrides.analyst_statement || 'The mixed assessment may not fully reflect the evidence.',
      authored_by:       overrides.authored_by       || 'analyst',
      evidence_ids:      overrides.evidence_ids      || [],
      ...overrides._extra,
    });
}

function assertErrorShape(body, expectedCode, expectedHttpStatus) {
  expect(typeof body.error_code).toBe('string');
  expect(body.error_code).toBe(expectedCode);
  expect(typeof body.error).toBe('string');
  expect(body.error.length).toBeGreaterThan(0);
  expect(body.status_code).toBe(expectedHttpStatus);
}

// =============================================================================
// CH-1 — POST challenges — creation and required fields
// =============================================================================

describe('CH-HTTP-1: POST …/challenges — challenge creation', () => {
  let inv;

  beforeEach(async () => { inv = await createInv(); });

  test('CH-1-1: returns HTTP 201 for a valid challenge', async () => {
    const res = await createChallenge(G15, inv.investigation_id);
    expect(res.status).toBe(201);
  });

  test('CH-1-2: challenge_id is a server-generated UUID', async () => {
    const res = await createChallenge(G15, inv.investigation_id);
    expect(res.body.challenge_id).toMatch(UUID_RE);
  });

  test('CH-1-3: challenge record carries case_id (CH-1)', async () => {
    const res = await createChallenge(G15, inv.investigation_id);
    expect(res.body.case_id).toBe(G15);
  });

  test('CH-1-4: challenge record carries investigation_id', async () => {
    const res = await createChallenge(G15, inv.investigation_id);
    expect(res.body.investigation_id).toBe(inv.investigation_id);
  });

  test('CH-1-5: initial status is "open"', async () => {
    const res = await createChallenge(G15, inv.investigation_id);
    expect(res.body.status).toBe('open');
  });

  test('CH-1-6: response has analyst_statement field', async () => {
    const res = await createChallenge(G15, inv.investigation_id, {
      analyst_statement: 'The EP8 evidence window selection seems too broad.',
    });
    expect(res.body.analyst_statement).toBe('The EP8 evidence window selection seems too broad.');
  });

  test('CH-1-7: response has lifecycle array with one "open" entry (CH-4)', async () => {
    const res = await createChallenge(G15, inv.investigation_id);
    expect(Array.isArray(res.body.lifecycle)).toBe(true);
    expect(res.body.lifecycle).toHaveLength(1);
    expect(res.body.lifecycle[0].status).toBe('open');
  });

  test('CH-1-8: response has null resolution_metadata on creation (CH-5)', async () => {
    const res = await createChallenge(G15, inv.investigation_id);
    expect(res.body.resolution_metadata).toBeNull();
  });

  test('CH-1-9: created_at is present and is an ISO string', async () => {
    const res = await createChallenge(G15, inv.investigation_id);
    expect(typeof res.body.created_at).toBe('string');
    expect(() => new Date(res.body.created_at)).not.toThrow();
  });

  test('CH-1-10: challenge record does NOT have assessment field (CH-3)', async () => {
    const res = await createChallenge(G15, inv.investigation_id);
    expect(res.body).not.toHaveProperty('assessment');
  });

  test('CH-1-11: challenge record does NOT have causal_attribution_established (CH-7)', async () => {
    const res = await createChallenge(G15, inv.investigation_id);
    expect(res.body).not.toHaveProperty('causal_attribution_established');
  });
});

// =============================================================================
// CH-2 — Target type vocabulary enforcement
// =============================================================================

describe('CH-HTTP-2: target_type vocabulary (CH-2)', () => {
  let inv;
  beforeEach(async () => { inv = await createInv(); });

  test.each(ALL_TARGET_TYPES)(
    'CH-2-A: target_type "%s" is accepted',
    async (tt) => {
      const targetId = (tt === 'hypothesis_assessment')
        ? G15_VALID_HYPOTHESIS
        : (tt === 'evidence_classification')
          ? G15_VALID_EVIDENCE_ID
          : 'some-textual-target';
      const res = await createChallenge(G15, inv.investigation_id, {
        target_type: tt, target_id: targetId,
      });
      expect(res.status).toBe(201);
      expect(res.body.target_type).toBe(tt);
    },
  );

  test('CH-2-B: invalid target_type returns 422', async () => {
    const res = await createChallenge(G15, inv.investigation_id, {
      _extra: { target_type: 'bad_type' },
    });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'VALIDATION_ERROR', 422);
  });

  test('CH-2-C: missing target_type returns 422', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_id:         G15_VALID_HYPOTHESIS,
        analyst_statement: 'A statement.',
        authored_by:       'analyst',
      });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'VALIDATION_ERROR', 422);
  });
});

// =============================================================================
// CH-3 — Forensic field immutability
// =============================================================================

describe('CH-HTTP-3: forensic field immutability (CH-3, CH-7)', () => {
  let inv;
  beforeEach(async () => { inv = await createInv(); });

  test('CH-3-1: body with assessment field is rejected 422 (CH-3)', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type:       'hypothesis_assessment',
        target_id:         G15_VALID_HYPOTHESIS,
        analyst_statement: 'A statement.',
        authored_by:       'analyst',
        assessment:        'strongly_supported',
      });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'FORENSIC_FIELD_IMMUTABLE', 422);
  });

  test('CH-3-2: body with causal_attribution_established is rejected 422 (CH-7)', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type:                   'hypothesis_assessment',
        target_id:                     G15_VALID_HYPOTHESIS,
        analyst_statement:             'A statement.',
        authored_by:                   'analyst',
        causal_attribution_established: true,
      });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'FORENSIC_FIELD_IMMUTABLE', 422);
  });

  test('CH-3-3: PATCH transition body with assessment field is rejected 422', async () => {
    const chalRes = await createChallenge(G15, inv.investigation_id);
    const cid = chalRes.body.challenge_id;
    const res = await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'under_review', actor: 'r', assessment: 'mixed' });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'FORENSIC_FIELD_IMMUTABLE', 422);
  });

  test('CH-3-4: after challenge accepted/resolved, forensic assessment is unchanged (CH-3)', async () => {
    const chalRes = await createChallenge(G15, inv.investigation_id, { target_id: 'H3' });
    const cid = chalRes.body.challenge_id;
    await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'under_review', actor: 'reviewer' });
    await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'resolved', actor: 'reviewer', resolution_outcome: 'acknowledged' });

    const analysisRes = await request(app).get(`/api/cases/${G15}/forensic-analysis`);
    const H3 = analysisRes.body.hypotheses.find((h) => h.hypothesis_id === 'H3');
    expect(H3.assessment).toBe('supported');
  }, 30_000);

  test('CH-3-5: after rejection, causal_attribution_established is still false (CH-3)', async () => {
    const chalRes = await createChallenge(G15, inv.investigation_id);
    const cid = chalRes.body.challenge_id;
    await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'rejected', actor: 'reviewer', notes: 'Not well-founded.' });

    const analysisRes = await request(app).get(`/api/cases/${G15}/forensic-analysis`);
    expect(analysisRes.body.causal_attribution_established).toBe(false);
  }, 30_000);
});

// =============================================================================
// CH-4 — Probability claim prohibition
// =============================================================================

describe('CH-HTTP-4: probability claims prohibited in analyst_statement (CH-8)', () => {
  let inv;
  beforeEach(async () => { inv = await createInv(); });

  const PROBABILITY_STATEMENTS = [
    '75% probability this is the cause.',
    'Confidence: 0.85 that the hypothesis is correct.',
    'likelihood of 90% based on flux data.',
    'probability of 0.7 is indicated.',
  ];

  test.each(PROBABILITY_STATEMENTS)(
    'CH-4-A: "%s" is rejected 422',
    async (stmt) => {
      const res = await request(app)
        .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
        .send({
          target_type:       'hypothesis_assessment',
          target_id:         G15_VALID_HYPOTHESIS,
          analyst_statement: stmt,
          authored_by:       'analyst',
        });
      expect(res.status).toBe(422);
      assertErrorShape(res.body, 'PROBABILITY_CLAIM_PROHIBITED', 422);
    },
  );

  test('CH-4-B: qualitative statement without percentages is accepted', async () => {
    const res = await createChallenge(G15, inv.investigation_id, {
      analyst_statement: 'The evidence suggests a possible connection but does not confirm causation.',
    });
    expect(res.status).toBe(201);
  });
});

// =============================================================================
// CH-5 — ID validation: fabricated and cross-case
// =============================================================================

describe('CH-HTTP-5: ID validation — fabricated and cross-case', () => {
  let g15Inv;
  let tcaInv;

  beforeEach(async () => {
    [g15Inv, tcaInv] = await Promise.all([createInv(G15), createInv(TCA)]);
  });

  test('CH-5-1: fabricated hypothesis_id rejected 422', async () => {
    const res = await createChallenge(G15, g15Inv.investigation_id, {
      target_type: 'hypothesis_assessment',
      target_id:   FABRICATED_HYPOTHESIS,
    });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'INVALID_HYPOTHESIS_ID', 422);
  });

  test('CH-5-2: fabricated evidence_id as target_id rejected 422', async () => {
    const res = await createChallenge(G15, g15Inv.investigation_id, {
      target_type: 'evidence_classification',
      target_id:   FABRICATED_EVIDENCE_ID,
    });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'INVALID_EVIDENCE_ID', 422);
  });

  test('CH-5-3: fabricated evidence_id in evidence_ids[] rejected 422', async () => {
    const res = await createChallenge(G15, g15Inv.investigation_id, {
      evidence_ids: [FABRICATED_EVIDENCE_ID],
    });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'INVALID_EVIDENCE_ID', 422);
  });

  test('CH-5-4: cross-case evidence_id (TCA in G15) rejected 422', async () => {
    const res = await createChallenge(G15, g15Inv.investigation_id, {
      evidence_ids: [TCA_VALID_EVIDENCE_ID],
    });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'INVALID_EVIDENCE_ID', 422);
  });

  test('CH-5-5: cross-case evidence_id as classification target (G15 evidence in TCA) rejected 422', async () => {
    const res = await createChallenge(TCA, tcaInv.investigation_id, {
      target_type: 'evidence_classification',
      target_id:   G15_VALID_EVIDENCE_ID,
    });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'INVALID_EVIDENCE_ID', 422);
  });

  test('CH-5-6: unknown case_id returns 404', async () => {
    const res = await request(app)
      .post(`/api/cases/${BOGUS}/investigations/any-id/challenges`)
      .send({
        target_type:       'limitation',
        target_id:         'some-target',
        analyst_statement: 'A limitation statement.',
        authored_by:       'analyst',
      });
    expect(res.status).toBe(404);
    assertErrorShape(res.body, 'CASE_NOT_FOUND', 404);
  });

  test('CH-5-7: non-null valid evidence_ids accepted for G15 challenge', async () => {
    const res = await createChallenge(G15, g15Inv.investigation_id, {
      evidence_ids: [G15_VALID_EVIDENCE_ID],
    });
    expect(res.status).toBe(201);
    expect(res.body.evidence_ids).toContain(G15_VALID_EVIDENCE_ID);
  });
});

// =============================================================================
// CH-6 — Lifecycle transitions via PATCH
// =============================================================================

describe('CH-HTTP-6: lifecycle transitions via PATCH (CH-4, CH-5)', () => {
  let inv;

  beforeEach(async () => { inv = await createInv(); });

  test('CH-6-1: open → under_review succeeds with 200', async () => {
    const chalRes = await createChallenge(G15, inv.investigation_id);
    const cid = chalRes.body.challenge_id;
    const res = await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'under_review', actor: 'reviewer', notes: 'Taking a look.' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('under_review');
  });

  test('CH-6-2: open → rejected succeeds with 200 (fast-path)', async () => {
    const chalRes = await createChallenge(G15, inv.investigation_id);
    const cid = chalRes.body.challenge_id;
    const res = await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'rejected', actor: 'reviewer', notes: 'Out of scope.' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
  });

  test('CH-6-3: under_review → resolved with acknowledged outcome', async () => {
    const chalRes = await createChallenge(G15, inv.investigation_id);
    const cid = chalRes.body.challenge_id;
    await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'under_review', actor: 'reviewer' });
    const res = await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'resolved', actor: 'reviewer', resolution_outcome: 'acknowledged' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('resolved');
    expect(res.body.resolution_metadata.resolution_outcome).toBe('acknowledged');
  });

  test('CH-6-4: resolution_metadata has resolved_by, resolved_at, resolution_outcome (CH-5)', async () => {
    const chalRes = await createChallenge(G15, inv.investigation_id);
    const cid = chalRes.body.challenge_id;
    await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'under_review', actor: 'r' });
    const res = await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({
        status:             'resolved',
        actor:              'senior-analyst',
        resolution_outcome: 'will_not_fix',
        notes:              'Evidence classification is correct per methodology.',
      });
    const meta = res.body.resolution_metadata;
    expect(meta.resolved_by).toBe('senior-analyst');
    expect(typeof meta.resolved_at).toBe('string');
    expect(meta.resolution_outcome).toBe('will_not_fix');
    expect(meta.resolution_notes).toContain('Evidence classification');
  });

  test('CH-6-5: under_review → resolved → re-transition returns 409 (CH-6)', async () => {
    const chalRes = await createChallenge(G15, inv.investigation_id);
    const cid = chalRes.body.challenge_id;
    await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'under_review', actor: 'r' });
    await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'resolved', actor: 'r', resolution_outcome: 'acknowledged' });
    const res = await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'under_review', actor: 'r' });
    expect(res.status).toBe(409);
    assertErrorShape(res.body, 'CHALLENGE_TERMINAL', 409);
  });

  test('CH-6-6: rejected → transition returns 409 (CH-6)', async () => {
    const chalRes = await createChallenge(G15, inv.investigation_id);
    const cid = chalRes.body.challenge_id;
    await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'rejected', actor: 'r' });
    const res = await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'under_review', actor: 'r' });
    expect(res.status).toBe(409);
    assertErrorShape(res.body, 'CHALLENGE_TERMINAL', 409);
  });

  test('CH-6-7: resolving without resolution_outcome returns 422', async () => {
    const chalRes = await createChallenge(G15, inv.investigation_id);
    const cid = chalRes.body.challenge_id;
    await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'under_review', actor: 'r' });
    const res = await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'resolved', actor: 'r' });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'VALIDATION_ERROR', 422);
  });

  test('CH-6-8: lifecycle grows with each transition (CH-4)', async () => {
    const chalRes = await createChallenge(G15, inv.investigation_id);
    const cid = chalRes.body.challenge_id;
    await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'under_review', actor: 'r' });
    const res = await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'resolved', actor: 'r', resolution_outcome: 'escalated' });
    // open (created) + under_review + resolved = 3
    expect(res.body.lifecycle).toHaveLength(3);
    expect(res.body.lifecycle[0].status).toBe('open');
    expect(res.body.lifecycle[1].status).toBe('under_review');
    expect(res.body.lifecycle[2].status).toBe('resolved');
  });

  test.each(ALL_RESOLUTION_OUTCOMES)(
    'CH-6-9: resolution_outcome "%s" is accepted (CH-5)',
    async (outcome) => {
      investigationStore._reset();
      const localInv = await createInv();
      const chalRes  = await createChallenge(G15, localInv.investigation_id);
      const cid      = chalRes.body.challenge_id;
      await request(app)
        .patch(`/api/cases/${G15}/investigations/${localInv.investigation_id}/challenges/${cid}`)
        .send({ status: 'under_review', actor: 'r' });
      const res = await request(app)
        .patch(`/api/cases/${G15}/investigations/${localInv.investigation_id}/challenges/${cid}`)
        .send({ status: 'resolved', actor: 'r', resolution_outcome: outcome });
      expect(res.status).toBe(200);
      expect(res.body.resolution_metadata.resolution_outcome).toBe(outcome);
    },
  );

  test('CH-6-10: PATCH on unknown challenge returns 404', async () => {
    const res = await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/not-real`)
      .send({ status: 'under_review', actor: 'r' });
    expect(res.status).toBe(404);
    assertErrorShape(res.body, 'CHALLENGE_NOT_FOUND', 404);
  });

  test('CH-6-11: PATCH without status field returns 422', async () => {
    const chalRes = await createChallenge(G15, inv.investigation_id);
    const cid = chalRes.body.challenge_id;
    const res = await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ actor: 'r' });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'VALIDATION_ERROR', 422);
  });

  test('CH-6-12: invalid transition from open → resolved returns 422', async () => {
    const chalRes = await createChallenge(G15, inv.investigation_id);
    const cid = chalRes.body.challenge_id;
    const res = await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'resolved', actor: 'r', resolution_outcome: 'acknowledged' });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'VALIDATION_ERROR', 422);
  });
});

// =============================================================================
// CH-7 — GET challenges list endpoints
// =============================================================================

describe('CH-HTTP-7: GET challenge list endpoints', () => {
  let inv;

  beforeEach(async () => { inv = await createInv(); });

  test('CH-7-1: GET …/challenges returns empty array initially', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  test('CH-7-2: GET …/challenges returns created challenge', async () => {
    await createChallenge(G15, inv.investigation_id);
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].investigation_id).toBe(inv.investigation_id);
  });

  test('CH-7-3: GET /api/cases/:id/challenges returns all challenges for the case', async () => {
    const inv2 = await createInv();
    await createChallenge(G15, inv.investigation_id);
    await createChallenge(G15, inv2.investigation_id);
    const res = await request(app).get(`/api/cases/${G15}/challenges`);
    expect(res.status).toBe(200);
    expect(res.body.case_id).toBe(G15);
    expect(res.body.challenge_count).toBe(2);
    expect(res.body.challenges).toHaveLength(2);
  });

  test('CH-7-4: case-level challenges endpoint returns correct case_id on each record (CH-1)', async () => {
    await createChallenge(G15, inv.investigation_id);
    const res = await request(app).get(`/api/cases/${G15}/challenges`);
    for (const c of res.body.challenges) {
      expect(c.case_id).toBe(G15);
    }
  });

  test('CH-7-5: TCA challenges are absent from G15 case-level endpoint', async () => {
    const tcaInv = await createInv(TCA);
    await createChallenge(TCA, tcaInv.investigation_id, {
      target_type: 'hypothesis_assessment',
      target_id:   TCA_VALID_HYPOTHESIS,
    });
    const res = await request(app).get(`/api/cases/${G15}/challenges`);
    expect(res.body.challenge_count).toBe(0);
  });

  test('CH-7-6: G15 challenges are absent from TCA case-level endpoint', async () => {
    await createChallenge(G15, inv.investigation_id);
    const res = await request(app).get(`/api/cases/${TCA}/challenges`);
    expect(res.body.challenge_count).toBe(0);
  });

  test('CH-7-7: case-level endpoint returns 404 for unknown case', async () => {
    const res = await request(app).get(`/api/cases/${BOGUS}/challenges`);
    expect(res.status).toBe(404);
    assertErrorShape(res.body, 'CASE_NOT_FOUND', 404);
  });
});

// =============================================================================
// CH-8 — GET single challenge
// =============================================================================

describe('CH-HTTP-8: GET …/challenges/:cid — retrieve challenge', () => {
  let inv;
  let chal;

  beforeEach(async () => {
    inv = await createInv();
    const res = await createChallenge(G15, inv.investigation_id, {
      analyst_statement: 'Limitation statement for testing.',
      target_type:       'limitation',
      target_id:         'proxy-measurement-limitation',
    });
    chal = res.body;
  });

  test('CH-8-1: returns 200 for a valid challenge', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${chal.challenge_id}`);
    expect(res.status).toBe(200);
  });

  test('CH-8-2: returned record matches created challenge', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${chal.challenge_id}`);
    expect(res.body.challenge_id).toBe(chal.challenge_id);
    expect(res.body.target_type).toBe('limitation');
    expect(res.body.analyst_statement).toBe('Limitation statement for testing.');
  });

  test('CH-8-3: returned record has lifecycle and resolution_metadata fields (CH-4, CH-5)', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${chal.challenge_id}`);
    expect(Array.isArray(res.body.lifecycle)).toBe(true);
    expect(res.body).toHaveProperty('resolution_metadata');
  });

  test('CH-8-4: returned record does not have assessment or causal fields (CH-3, CH-7)', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${chal.challenge_id}`);
    expect(res.body).not.toHaveProperty('assessment');
    expect(res.body).not.toHaveProperty('causal_attribution_established');
  });

  test('CH-8-5: unknown challenge_id returns 404', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/not-real`);
    expect(res.status).toBe(404);
    assertErrorShape(res.body, 'CHALLENGE_NOT_FOUND', 404);
  });
});

// =============================================================================
// CH-9 — Full workflow e2e + forensic baseline preservation
// =============================================================================

describe('CH-HTTP-9: full workflow and forensic baseline preservation', () => {
  let baselineH5Assessment;
  let baselineCausal;

  beforeAll(async () => {
    jest.setTimeout(30_000);
    const res = await request(app).get(`/api/cases/${G15}/forensic-analysis`);
    const H5 = res.body.hypotheses.find((h) => h.hypothesis_id === 'H5');
    baselineH5Assessment = H5.assessment;
    baselineCausal = res.body.causal_attribution_established;
  }, 30_000);

  test('CH-9-1: full OPEN → UNDER_REVIEW → RESOLVED workflow', async () => {
    investigationStore._reset();
    const inv = await createInv();
    const chalRes = await createChallenge(G15, inv.investigation_id, {
      target_type:       'missing_evidence',
      target_id:         'spacecraft-telemetry-unavailable',
      analyst_statement: 'Direct spacecraft command-subsystem telemetry is absent from this dataset.',
    });
    const cid = chalRes.body.challenge_id;

    const step1 = await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'under_review', actor: 'lead-analyst', notes: 'Valid concern; investigating.' });
    expect(step1.body.status).toBe('under_review');

    const step2 = await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({
        status:             'resolved',
        actor:              'lead-analyst',
        resolution_outcome: 'acknowledged',
        notes:              'Acknowledged; dataset limitation documented in case.json scientific_limitations.',
      });
    expect(step2.body.status).toBe('resolved');
    expect(step2.body.resolution_metadata.resolution_outcome).toBe('acknowledged');
    expect(step2.body.lifecycle).toHaveLength(3);
  });

  test('CH-9-2: full OPEN → REJECTED workflow', async () => {
    investigationStore._reset();
    const inv = await createInv();
    const chalRes = await createChallenge(G15, inv.investigation_id, {
      target_type:       'additional_investigation',
      target_id:         'request-direct-telemetry',
      analyst_statement: 'Recommend acquiring direct in-situ particle measurements at the spacecraft bus.',
    });
    const cid = chalRes.body.challenge_id;
    const res = await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'rejected', actor: 'case-lead', notes: 'Out of scope for this dataset.' });
    expect(res.body.status).toBe('rejected');
    expect(res.body.resolution_metadata).toBeNull();
  });

  test('CH-9-3: after full workflow, H5 assessment is still strongly_supported (CH-3)', async () => {
    investigationStore._reset();
    const inv = await createInv();
    const chalRes = await createChallenge(G15, inv.investigation_id, { target_id: 'H5' });
    const cid = chalRes.body.challenge_id;
    await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'under_review', actor: 'r' });
    await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'resolved', actor: 'r', resolution_outcome: 'acknowledged' });

    const afterRes = await request(app).get(`/api/cases/${G15}/forensic-analysis`);
    const H5after = afterRes.body.hypotheses.find((h) => h.hypothesis_id === 'H5');
    expect(H5after.assessment).toBe(baselineH5Assessment);
    expect(afterRes.body.causal_attribution_established).toBe(baselineCausal);
  }, 30_000);

  test('CH-9-4: history endpoint includes full lifecycle after resolution', async () => {
    investigationStore._reset();
    const inv = await createInv(G15);
    const chalRes = await createChallenge(G15, inv.investigation_id);
    const cid = chalRes.body.challenge_id;
    await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'under_review', actor: 'r', notes: 'Reviewing.' });
    await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'resolved', actor: 'r', resolution_outcome: 'will_not_fix' });

    const histRes = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/history`);
    expect(histRes.status).toBe(200);
    const histChallenge = histRes.body.challenges[0];
    expect(histChallenge.status).toBe('resolved');
    expect(histChallenge.lifecycle).toHaveLength(3);
    expect(histChallenge.resolution_metadata.resolution_outcome).toBe('will_not_fix');
    // Must NOT carry forensic fields
    expect(histChallenge).not.toHaveProperty('assessment');
    expect(histChallenge).not.toHaveProperty('causal_attribution_established');
  });
});
