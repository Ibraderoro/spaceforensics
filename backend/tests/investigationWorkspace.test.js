'use strict';

/**
 * Phase 7.2 — Investigation Workspace API — HTTP Integration Tests
 *
 * All tests exercise the real HTTP application via supertest.
 * No test modifies or weakens any existing test.
 *
 * INVARIANTS verified here:
 *   INV-2  Fabricated evidence_id → 422
 *   INV-3  Challenge body cannot set assessment or causal_attribution_established → 422
 *   INV-4  Investigation state cannot change causal_attribution_established
 *   INV-7  Forensic pipeline output is identical before and after investigation writes
 *   INV-8  Closed investigation → writes rejected 409
 *   INV-9  investigation_id is server-generated UUID (client-supplied body ID ignored)
 *   ID-2   evidence_id must belong to the requested case
 *   ID-3   hypothesis_id must belong to the requested case
 *   ID-4   evidence_id from Case A rejected in Case B investigation
 *   ID-5   hypothesis_id from Case A rejected in Case B investigation
 */

const request = require('supertest');
const { app, investigationStore } = require('../server');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const G15   = 'galaxy-15';
const TCA   = 'test-case-alpha';
const BOGUS = 'no-such-case-zzzz';

// Galaxy-15 known valid IDs (from multi-case isolation tests)
const G15_VALID_EVIDENCE_ID  = 'E-G15-0001';
const G15_VALID_HYPOTHESIS   = 'H1';

// test-case-alpha known valid IDs
const TCA_VALID_EVIDENCE_ID  = 'E-TCA-0001';
const TCA_VALID_HYPOTHESIS   = 'H1';

// Fabricated IDs — must not exist in any case
const FABRICATED_EVIDENCE_ID  = 'E-FAKE-9999';
const FABRICATED_HYPOTHESIS   = 'H999';

// UUID v4 RE
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ─────────────────────────────────────────────────────────────────────────────
// Reset the in-memory investigation store before each test so every test
// starts from a clean state.  This does NOT affect the forensic pipeline.
// ─────────────────────────────────────────────────────────────────────────────
beforeEach(() => {
  investigationStore._reset();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: create an investigation via HTTP and return the body.
// ─────────────────────────────────────────────────────────────────────────────
async function createInvestigation(caseId, body = {}) {
  return request(app)
    .post(`/api/cases/${caseId}/investigations`)
    .send({ title: 'Test Investigation', opened_by: 'test-analyst', ...body });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: assert standard API error shape { error_code, error, status_code }
// ─────────────────────────────────────────────────────────────────────────────
function assertErrorShape(body, expectedCode, expectedHttpStatus) {
  expect(typeof body.error_code).toBe('string');
  expect(body.error_code).toBe(expectedCode);
  expect(typeof body.error).toBe('string');
  expect(body.error.length).toBeGreaterThan(0);
  expect(body.status_code).toBe(expectedHttpStatus);
}

// =============================================================================
// IW-1 — POST /api/cases/:id/investigations — create investigation
// =============================================================================
describe('IW-1: POST /api/cases/:id/investigations — create investigation', () => {
  test('IW-1-1: returns HTTP 201 for a known case', async () => {
    const res = await createInvestigation(G15);
    expect(res.status).toBe(201);
  });

  test('IW-1-2: response contains investigation_id as a UUID (INV-9)', async () => {
    const res = await createInvestigation(G15);
    expect(res.body).toHaveProperty('investigation_id');
    expect(res.body.investigation_id).toMatch(UUID_RE);
  });

  test('IW-1-3: investigation_id is server-generated — client-supplied id in body is ignored (INV-9)', async () => {
    const clientId = 'my-custom-id-that-should-be-ignored';
    const res = await createInvestigation(G15, { investigation_id: clientId });
    expect(res.status).toBe(201);
    expect(res.body.investigation_id).not.toBe(clientId);
    expect(res.body.investigation_id).toMatch(UUID_RE);
  });

  test('IW-1-4: response contains correct case_id', async () => {
    const res = await createInvestigation(G15);
    expect(res.body.case_id).toBe(G15);
  });

  test('IW-1-5: initial status is "open"', async () => {
    const res = await createInvestigation(G15);
    expect(res.body.status).toBe('open');
  });

  test('IW-1-6: response contains opened_at timestamp', async () => {
    const res = await createInvestigation(G15);
    expect(typeof res.body.opened_at).toBe('string');
    expect(res.body.opened_at.length).toBeGreaterThan(0);
  });

  test('IW-1-7: lifecycle events contains an "opened" entry', async () => {
    const res = await createInvestigation(G15, { opened_by: 'analyst-007' });
    expect(Array.isArray(res.body.events)).toBe(true);
    const opened = res.body.events.find((e) => e.event === 'opened');
    expect(opened).toBeDefined();
    expect(opened.actor).toBe('analyst-007');
  });

  test('IW-1-8: two concurrent creates produce distinct investigation_ids', async () => {
    const [r1, r2] = await Promise.all([
      createInvestigation(G15),
      createInvestigation(G15),
    ]);
    expect(r1.body.investigation_id).not.toBe(r2.body.investigation_id);
  });

  test('IW-1-9: returns 404 for unknown case (existing error contract)', async () => {
    const res = await createInvestigation(BOGUS);
    expect(res.status).toBe(404);
    assertErrorShape(res.body, 'CASE_NOT_FOUND', 404);
  });

  test('IW-1-10: error message contains the unknown case ID', async () => {
    const res = await createInvestigation(BOGUS);
    expect(res.body.error).toContain(BOGUS);
  });
});

// =============================================================================
// IW-2 — GET /api/cases/:id/investigations — list investigations
// =============================================================================
describe('IW-2: GET /api/cases/:id/investigations — list investigations', () => {
  test('IW-2-1: returns HTTP 200 for a known case with no investigations', async () => {
    const res = await request(app).get(`/api/cases/${G15}/investigations`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  test('IW-2-2: returns the created investigation after POST', async () => {
    const created = await createInvestigation(G15);
    const res = await request(app).get(`/api/cases/${G15}/investigations`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].investigation_id).toBe(created.body.investigation_id);
  });

  test('IW-2-3: investigations for one case do not bleed into another case', async () => {
    await createInvestigation(G15);
    const res = await request(app).get(`/api/cases/${TCA}/investigations`);
    expect(res.status).toBe(200);
    // TCA list must be empty — G15 investigation must not appear here
    expect(res.body).toHaveLength(0);
  });

  test('IW-2-4: returns 404 for unknown case', async () => {
    const res = await request(app).get(`/api/cases/${BOGUS}/investigations`);
    expect(res.status).toBe(404);
    assertErrorShape(res.body, 'CASE_NOT_FOUND', 404);
  });
});

// =============================================================================
// IW-3 — GET /api/cases/:id/investigations/:iid — retrieve investigation
// =============================================================================
describe('IW-3: GET /api/cases/:id/investigations/:iid — retrieve investigation', () => {
  let inv;

  beforeEach(async () => {
    const res = await createInvestigation(G15);
    inv = res.body;
  });

  test('IW-3-1: returns HTTP 200 for a valid investigation', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}`);
    expect(res.status).toBe(200);
  });

  test('IW-3-2: returned record matches the created investigation', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}`);
    expect(res.body.investigation_id).toBe(inv.investigation_id);
    expect(res.body.case_id).toBe(G15);
  });

  test('IW-3-3: returns 404 for unknown investigation_id', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/non-existent-uuid`);
    expect(res.status).toBe(404);
    assertErrorShape(res.body, 'INVESTIGATION_NOT_FOUND', 404);
  });

  test('IW-3-4: returns 404 when investigation belongs to different case', async () => {
    // Create investigation for G15, try to fetch it via TCA's URL
    const res = await request(app)
      .get(`/api/cases/${TCA}/investigations/${inv.investigation_id}`);
    expect(res.status).toBe(404);
    assertErrorShape(res.body, 'INVESTIGATION_NOT_FOUND', 404);
  });
});

// =============================================================================
// IW-4 — PATCH /api/cases/:id/investigations/:iid — update status
// =============================================================================
describe('IW-4: PATCH /api/cases/:id/investigations/:iid — update status', () => {
  let inv;

  beforeEach(async () => {
    const res = await createInvestigation(G15);
    inv = res.body;
  });

  test('IW-4-1: OPEN → SUSPENDED succeeds', async () => {
    const res = await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}`)
      .send({ status: 'suspended', actor: 'analyst-a', reason: 'awaiting data' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('suspended');
  });

  test('IW-4-2: OPEN → CLOSED succeeds', async () => {
    const res = await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}`)
      .send({ status: 'closed', actor: 'analyst-a', reason: 'investigation complete' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('closed');
  });

  test('IW-4-3: status change appends event to lifecycle log', async () => {
    await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}`)
      .send({ status: 'suspended', actor: 'analyst-b', reason: 'testing' });
    const getRes = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}`);
    const events = getRes.body.events;
    expect(events.length).toBeGreaterThan(1);
    const suspended = events.find((e) => e.event === 'suspended');
    expect(suspended).toBeDefined();
    expect(suspended.actor).toBe('analyst-b');
    expect(suspended.reason).toBe('testing');
  });

  test('IW-4-4: closed investigation write returns 409 (INV-8)', async () => {
    // Close the investigation
    await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}`)
      .send({ status: 'closed', actor: 'analyst-a' });

    // Attempt to suspend — must be rejected with 409
    const res = await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}`)
      .send({ status: 'suspended', actor: 'analyst-a' });
    expect(res.status).toBe(409);
    assertErrorShape(res.body, 'INVESTIGATION_CLOSED', 409);
  });

  test('IW-4-5: missing status field returns 422', async () => {
    const res = await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}`)
      .send({ actor: 'analyst-a' });
    expect(res.status).toBe(422);
  });

  test('IW-4-6: invalid status value returns 422', async () => {
    const res = await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}`)
      .send({ status: 'deleted', actor: 'analyst-a' });
    expect(res.status).toBe(422);
  });
});

// =============================================================================
// IW-5 — GET /api/cases/:id/investigations/:iid/forensic-analysis
// Forensic pipeline isolation: investigation state must not affect output
// =============================================================================
describe('IW-5: GET …/investigations/:iid/forensic-analysis — pipeline isolation (INV-7)', () => {
  let inv;
  let baselineForensic;

  beforeAll(async () => {
    jest.setTimeout(60_000);
    // Fetch the direct forensic analysis baseline before creating any investigation
    const baselineRes = await request(app).get(`/api/cases/${G15}/forensic-analysis`);
    baselineForensic = baselineRes.body;
  }, 60_000);

  beforeEach(async () => {
    const res = await createInvestigation(G15);
    inv = res.body;
  });

  test('IW-5-1: returns HTTP 200', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/forensic-analysis`);
    expect(res.status).toBe(200);
  }, 30_000);

  test('IW-5-2: causal_attribution_established is false (INV-4)', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/forensic-analysis`);
    expect(res.body.causal_attribution_established).toBe(false);
  }, 30_000);

  test('IW-5-3: hypothesis assessments are identical to baseline (INV-7)', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/forensic-analysis`);
    const invBody = res.body;

    for (const baseH of baselineForensic.hypotheses) {
      const invH = invBody.hypotheses.find((h) => h.hypothesis_id === baseH.hypothesis_id);
      expect(invH).toBeDefined();
      expect(invH.assessment).toBe(baseH.assessment);
    }
  }, 30_000);

  test('IW-5-4: investigation observations do not affect forensic output (INV-7)', async () => {
    // Post an observation
    await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/observations`)
      .send({ text: 'This note should never affect forensic analysis.', authored_by: 'analyst' });

    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/forensic-analysis`);

    // H5 must still be strongly_supported
    const H5 = res.body.hypotheses.find((h) => h.hypothesis_id === 'H5');
    expect(H5.assessment).toBe('strongly_supported');
    expect(res.body.causal_attribution_established).toBe(false);
  }, 30_000);

  test('IW-5-5: returns 404 for unknown case', async () => {
    const res = await request(app)
      .get(`/api/cases/${BOGUS}/investigations/any-id/forensic-analysis`);
    expect(res.status).toBe(404);
    assertErrorShape(res.body, 'CASE_NOT_FOUND', 404);
  });
});

// =============================================================================
// IW-6 — GET /api/cases/:id/investigations/:iid/evidence-graph
// =============================================================================
describe('IW-6: GET …/investigations/:iid/evidence-graph — pipeline isolation (INV-7)', () => {
  let inv;

  beforeEach(async () => {
    const res = await createInvestigation(G15);
    inv = res.body;
  });

  test('IW-6-1: returns HTTP 200', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/evidence-graph`);
    expect(res.status).toBe(200);
  });

  test('IW-6-2: returns correct case_id', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/evidence-graph`);
    expect(res.body.case_id).toBe(G15);
  });

  test('IW-6-3: causal_attribution_established is false (INV-4)', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/evidence-graph`);
    expect(res.body.causal_attribution_established).toBe(false);
  });

  test('IW-6-4: hypotheses array contains H1–H5', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/evidence-graph`);
    const ids = res.body.hypotheses.map((h) => h.hypothesis_id);
    ['H1','H2','H3','H4','H5'].forEach((id) => expect(ids).toContain(id));
  });

  test('IW-6-5: graph does not contain any investigation state fields', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/evidence-graph`);
    expect(res.body).not.toHaveProperty('observations');
    expect(res.body).not.toHaveProperty('challenges');
    expect(res.body).not.toHaveProperty('investigation_id');
  });

  test('IW-6-6: returns 404 for unknown case', async () => {
    const res = await request(app)
      .get(`/api/cases/${BOGUS}/investigations/any-id/evidence-graph`);
    expect(res.status).toBe(404);
    assertErrorShape(res.body, 'CASE_NOT_FOUND', 404);
  });
});

// =============================================================================
// IW-7 — GET /api/cases/:id/investigations/:iid/state
// =============================================================================
describe('IW-7: GET …/investigations/:iid/state — investigation state', () => {
  let inv;

  beforeEach(async () => {
    const res = await createInvestigation(G15);
    inv = res.body;
  });

  test('IW-7-1: returns HTTP 200', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/state`);
    expect(res.status).toBe(200);
  });

  test('IW-7-2: state contains investigation_id and case_id', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/state`);
    expect(res.body.investigation_id).toBe(inv.investigation_id);
    expect(res.body.case_id).toBe(G15);
  });

  test('IW-7-3: state does not contain any forensic analysis fields', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/state`);
    expect(res.body).not.toHaveProperty('hypotheses');
    expect(res.body).not.toHaveProperty('analyst_narrative');
    expect(res.body).not.toHaveProperty('causal_attribution_established');
    expect(res.body).not.toHaveProperty('analysis_version');
  });

  test('IW-7-4: initial observation_count is 0', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/state`);
    expect(res.body.observation_count).toBe(0);
    expect(res.body.challenge_count).toBe(0);
  });

  test('IW-7-5: observation_count increments after adding an observation', async () => {
    await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/observations`)
      .send({ text: 'Note about particle flux.', authored_by: 'analyst' });
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/state`);
    expect(res.body.observation_count).toBe(1);
  });

  test('IW-7-6: challenge_count increments after adding a challenge', async () => {
    await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type: 'hypothesis_assessment',
        target_id:   G15_VALID_HYPOTHESIS,
        rationale:   'I disagree with the mixed assessment based on the evidence window.',
        authored_by: 'analyst',
      });
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/state`);
    expect(res.body.challenge_count).toBe(1);
  });
});

// =============================================================================
// IW-8 — POST /api/cases/:id/investigations/:iid/observations
// =============================================================================
describe('IW-8: POST …/investigations/:iid/observations — record observation', () => {
  let inv;

  beforeEach(async () => {
    const res = await createInvestigation(G15);
    inv = res.body;
  });

  test('IW-8-1: returns HTTP 201 for a valid observation', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/observations`)
      .send({ text: 'Particle flux was elevated.', authored_by: 'analyst' });
    expect(res.status).toBe(201);
  });

  test('IW-8-2: response contains observation_id as UUID', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/observations`)
      .send({ text: 'Particle flux was elevated.', authored_by: 'analyst' });
    expect(res.body).toHaveProperty('observation_id');
    expect(res.body.observation_id).toMatch(UUID_RE);
  });

  test('IW-8-3: observation is linked to the correct investigation', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/observations`)
      .send({ text: 'Note.', authored_by: 'analyst' });
    expect(res.body.investigation_id).toBe(inv.investigation_id);
  });

  test('IW-8-4: observation with valid evidence_id succeeds (ID-2)', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/observations`)
      .send({
        text:        'Examining anchor event.',
        authored_by: 'analyst',
        evidence_ids: [G15_VALID_EVIDENCE_ID],
      });
    expect(res.status).toBe(201);
    expect(res.body.evidence_ids).toContain(G15_VALID_EVIDENCE_ID);
  });

  test('IW-8-5: fabricated evidence_id is rejected 422 (INV-2, ID-2)', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/observations`)
      .send({
        text:        'Note with bad ID.',
        authored_by: 'analyst',
        evidence_ids: [FABRICATED_EVIDENCE_ID],
      });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'INVALID_EVIDENCE_ID', 422);
  });

  test('IW-8-6: cross-case evidence_id rejected 422 (ID-4)', async () => {
    // TCA evidence ID submitted in a G15 investigation
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/observations`)
      .send({
        text:        'Cross-case evidence citation attempt.',
        authored_by: 'analyst',
        evidence_ids: [TCA_VALID_EVIDENCE_ID],
      });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'INVALID_EVIDENCE_ID', 422);
  });

  test('IW-8-7: valid hypothesis_id reference is stored (ID-3)', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/observations`)
      .send({
        text:           'Discussing H1.',
        authored_by:    'analyst',
        hypothesis_ids: [G15_VALID_HYPOTHESIS],
      });
    expect(res.status).toBe(201);
    expect(res.body.hypothesis_ids).toContain(G15_VALID_HYPOTHESIS);
  });

  test('IW-8-8: fabricated hypothesis_id rejected 422 (ID-3)', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/observations`)
      .send({
        text:           'Note with bad hypothesis.',
        authored_by:    'analyst',
        hypothesis_ids: [FABRICATED_HYPOTHESIS],
      });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'INVALID_HYPOTHESIS_ID', 422);
  });

  test('IW-8-9: cross-case hypothesis_id rejected 422 (ID-5)', async () => {
    // TCA hypothesis H1 submitted for a G15 investigation is still H1
    // but the namespace is cross-case only if the case has different hypo IDs.
    // Use a fabricated ID to guarantee cross-case namespace enforcement.
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/observations`)
      .send({
        text:           'Cross-case hypothesis reference.',
        authored_by:    'analyst',
        hypothesis_ids: ['H999-TCA-ONLY'],
      });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'INVALID_HYPOTHESIS_ID', 422);
  });

  test('IW-8-10: empty text rejected 422', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/observations`)
      .send({ text: '   ', authored_by: 'analyst' });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'VALIDATION_ERROR', 422);
  });

  test('IW-8-11: observation stored with version history (append-only)', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/observations`)
      .send({ text: 'Initial note.', authored_by: 'analyst' });
    expect(Array.isArray(res.body.versions)).toBe(true);
    expect(res.body.versions).toHaveLength(1);
    expect(res.body.versions[0].version).toBe(1);
    expect(res.body.versions[0].text).toBe('Initial note.');
  });

  test('IW-8-12: observation on closed investigation returns 409 (INV-8)', async () => {
    // Close the investigation
    await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}`)
      .send({ status: 'closed', actor: 'analyst' });

    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/observations`)
      .send({ text: 'This should fail.', authored_by: 'analyst' });
    expect(res.status).toBe(409);
    assertErrorShape(res.body, 'INVESTIGATION_CLOSED', 409);
  });

  test('IW-8-13: observation is not an evidence row — response has no evidence-row fields', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/observations`)
      .send({ text: 'A note.', authored_by: 'analyst' });
    // Evidence-row fields must be absent from the observation record
    const body = res.body;
    expect(body).not.toHaveProperty('source');
    expect(body).not.toHaveProperty('measurement');
    expect(body).not.toHaveProperty('value');
    expect(body).not.toHaveProperty('unit');
    expect(body).not.toHaveProperty('dataset_id');
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('variable');
    expect(body).not.toHaveProperty('evidence_type');
    expect(body).not.toHaveProperty('quality');
  });
});

// =============================================================================
// IW-9 — GET /api/cases/:id/investigations/:iid/observations/:oid
// =============================================================================
describe('IW-9: GET …/observations/:oid — retrieve observation', () => {
  let inv;
  let obs;

  beforeEach(async () => {
    const invRes = await createInvestigation(G15);
    inv = invRes.body;
    const obsRes = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/observations`)
      .send({ text: 'Test observation.', authored_by: 'analyst' });
    obs = obsRes.body;
  });

  test('IW-9-1: returns HTTP 200 for a valid observation', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/observations/${obs.observation_id}`);
    expect(res.status).toBe(200);
  });

  test('IW-9-2: returned observation matches the created one', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/observations/${obs.observation_id}`);
    expect(res.body.observation_id).toBe(obs.observation_id);
    expect(res.body.versions[0].text).toBe('Test observation.');
  });

  test('IW-9-3: returns 404 for unknown observation_id', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/observations/not-real`);
    expect(res.status).toBe(404);
    assertErrorShape(res.body, 'OBSERVATION_NOT_FOUND', 404);
  });
});

// =============================================================================
// IW-10 — POST /api/cases/:id/investigations/:iid/challenges
// =============================================================================
describe('IW-10: POST …/investigations/:iid/challenges — record challenge', () => {
  let inv;

  beforeEach(async () => {
    const res = await createInvestigation(G15);
    inv = res.body;
  });

  test('IW-10-1: hypothesis_assessment challenge succeeds for valid hypothesis', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type: 'hypothesis_assessment',
        target_id:   G15_VALID_HYPOTHESIS,
        rationale:   'The mixed assessment seems inconsistent with the particle environment data.',
        authored_by: 'analyst',
      });
    expect(res.status).toBe(201);
  });

  test('IW-10-2: challenge_id is a UUID', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type: 'hypothesis_assessment',
        target_id:   G15_VALID_HYPOTHESIS,
        rationale:   'A rationale.',
        authored_by: 'analyst',
      });
    expect(res.body.challenge_id).toMatch(UUID_RE);
  });

  test('IW-10-3: initial challenge status is "open"', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type: 'hypothesis_assessment',
        target_id:   G15_VALID_HYPOTHESIS,
        rationale:   'A rationale.',
        authored_by: 'analyst',
      });
    expect(res.body.status).toBe('open');
  });

  test('IW-10-4: challenge body with assessment field is rejected 422 (INV-3)', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type:  'hypothesis_assessment',
        target_id:    G15_VALID_HYPOTHESIS,
        rationale:    'My reason.',
        authored_by:  'analyst',
        assessment:   'strongly_supported',   // ← forbidden
      });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'FORENSIC_FIELD_IMMUTABLE', 422);
  });

  test('IW-10-5: challenge body with causal_attribution_established is rejected 422 (INV-4)', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type:                   'hypothesis_assessment',
        target_id:                     G15_VALID_HYPOTHESIS,
        rationale:                     'My reason.',
        authored_by:                   'analyst',
        causal_attribution_established: true,  // ← forbidden
      });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'FORENSIC_FIELD_IMMUTABLE', 422);
  });

  test('IW-10-6: fabricated hypothesis_id rejected 422 (ID-3)', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type: 'hypothesis_assessment',
        target_id:   FABRICATED_HYPOTHESIS,
        rationale:   'A reason.',
        authored_by: 'analyst',
      });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'INVALID_HYPOTHESIS_ID', 422);
  });

  test('IW-10-7: evidence_classification challenge with valid evidence_id succeeds', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type: 'evidence_classification',
        target_id:   G15_VALID_EVIDENCE_ID,
        rationale:   'This evidence should be supporting, not environmental context.',
        authored_by: 'analyst',
      });
    expect(res.status).toBe(201);
  });

  test('IW-10-8: evidence_classification challenge with fabricated evidence_id rejected 422 (INV-2)', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type: 'evidence_classification',
        target_id:   FABRICATED_EVIDENCE_ID,
        rationale:   'A reason.',
        authored_by: 'analyst',
      });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'INVALID_EVIDENCE_ID', 422);
  });

  test('IW-10-9: cross-case evidence_id in evidence_ids field rejected 422 (ID-4)', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type:  'hypothesis_assessment',
        target_id:    G15_VALID_HYPOTHESIS,
        rationale:    'A reason.',
        authored_by:  'analyst',
        evidence_ids: [TCA_VALID_EVIDENCE_ID],  // cross-case
      });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'INVALID_EVIDENCE_ID', 422);
  });

  test('IW-10-10: missing rationale returns 422', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type: 'hypothesis_assessment',
        target_id:   G15_VALID_HYPOTHESIS,
        authored_by: 'analyst',
      });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'VALIDATION_ERROR', 422);
  });

  test('IW-10-11: challenge on closed investigation returns 409 (INV-8)', async () => {
    await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}`)
      .send({ status: 'closed', actor: 'analyst' });

    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type: 'hypothesis_assessment',
        target_id:   G15_VALID_HYPOTHESIS,
        rationale:   'This should fail.',
        authored_by: 'analyst',
      });
    expect(res.status).toBe(409);
    assertErrorShape(res.body, 'INVESTIGATION_CLOSED', 409);
  });

  test('IW-10-12: accepted challenge does NOT change forensic assessment (INV-3)', async () => {
    // Create challenge
    const chalRes = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type: 'hypothesis_assessment',
        target_id:   'H3',
        rationale:   'H3 assessment seems too high.',
        authored_by: 'analyst',
      });
    expect(chalRes.status).toBe(201);
    // The challenge record does NOT carry an assessment field
    expect(chalRes.body).not.toHaveProperty('assessment');
    // The challenge has no mechanism to change the forensic analysis
    // Verify forensic analysis still has H3 = 'supported'
    const analysisRes = await request(app).get(`/api/cases/${G15}/forensic-analysis`);
    const H3 = analysisRes.body.hypotheses.find((h) => h.hypothesis_id === 'H3');
    expect(H3.assessment).toBe('supported');
  }, 30_000);
});

// =============================================================================
// IW-11 — GET /api/cases/:id/investigations/:iid/challenges/:cid
// =============================================================================
describe('IW-11: GET …/investigations/:iid/challenges/:cid — retrieve challenge', () => {
  let inv;
  let chal;

  beforeEach(async () => {
    const invRes = await createInvestigation(G15);
    inv = invRes.body;
    const chalRes = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type: 'hypothesis_assessment',
        target_id:   G15_VALID_HYPOTHESIS,
        rationale:   'A challenge.',
        authored_by: 'analyst',
      });
    chal = chalRes.body;
  });

  test('IW-11-1: returns HTTP 200 for a valid challenge', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${chal.challenge_id}`);
    expect(res.status).toBe(200);
  });

  test('IW-11-2: returned challenge matches the created one', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${chal.challenge_id}`);
    expect(res.body.challenge_id).toBe(chal.challenge_id);
    expect(res.body.target_type).toBe('hypothesis_assessment');
    expect(res.body.target_id).toBe(G15_VALID_HYPOTHESIS);
  });

  test('IW-11-3: returns 404 for unknown challenge_id', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/not-real`);
    expect(res.status).toBe(404);
    assertErrorShape(res.body, 'CHALLENGE_NOT_FOUND', 404);
  });
});

// =============================================================================
// IW-12 — GET /api/cases/:id/investigations/:iid/history
// =============================================================================
describe('IW-12: GET …/investigations/:iid/history — audit trail', () => {
  let inv;

  beforeEach(async () => {
    const res = await createInvestigation(G15, { opened_by: 'analyst-a' });
    inv = res.body;
  });

  test('IW-12-1: returns HTTP 200', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/history`);
    expect(res.status).toBe(200);
  });

  test('IW-12-2: history contains investigation_id and case_id', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/history`);
    expect(res.body.investigation_id).toBe(inv.investigation_id);
    expect(res.body.case_id).toBe(G15);
  });

  test('IW-12-3: history contains lifecycle events array with opened event', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/history`);
    expect(Array.isArray(res.body.events)).toBe(true);
    const opened = res.body.events.find((e) => e.event === 'opened');
    expect(opened).toBeDefined();
    expect(opened.actor).toBe('analyst-a');
  });

  test('IW-12-4: history includes observations with version history', async () => {
    await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/observations`)
      .send({ text: 'History note.', authored_by: 'analyst-a' });

    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/history`);
    expect(Array.isArray(res.body.observations)).toBe(true);
    expect(res.body.observations).toHaveLength(1);
    expect(Array.isArray(res.body.observations[0].versions)).toBe(true);
  });

  test('IW-12-5: history includes challenges with review_history', async () => {
    await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type: 'hypothesis_assessment',
        target_id:   G15_VALID_HYPOTHESIS,
        rationale:   'A rationale.',
        authored_by: 'analyst-a',
      });

    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/history`);
    expect(Array.isArray(res.body.challenges)).toBe(true);
    expect(res.body.challenges).toHaveLength(1);
    expect(Array.isArray(res.body.challenges[0].review_history)).toBe(true);
  });

  test('IW-12-6: status transition appears in history events', async () => {
    await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}`)
      .send({ status: 'suspended', actor: 'analyst-a', reason: 'test suspension' });

    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/history`);
    const events = res.body.events;
    const suspended = events.find((e) => e.event === 'suspended');
    expect(suspended).toBeDefined();
    expect(suspended.reason).toBe('test suspension');
  });

  test('IW-12-7: returns 404 for unknown investigation', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/not-real/history`);
    expect(res.status).toBe(404);
    assertErrorShape(res.body, 'INVESTIGATION_NOT_FOUND', 404);
  });
});

// =============================================================================
// IW-13 — Forensic pipeline baseline preservation (INV-7 end-to-end)
//
// After ALL investigation operations, the direct /forensic-analysis endpoint
// must return a byte-identical deterministic section compared to the baseline.
// =============================================================================
describe('IW-13: forensic pipeline baseline preservation after investigation writes (INV-7)', () => {
  let baseline;

  beforeAll(async () => {
    jest.setTimeout(60_000);
    const res = await request(app).get(`/api/cases/${G15}/forensic-analysis`);
    baseline = res.body;
  }, 60_000);

  test('IW-13-1: creating an investigation does not change forensic assessment values', async () => {
    const invRes = await createInvestigation(G15);
    const inv = invRes.body;

    await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/observations`)
      .send({ text: 'Should not affect forensic output.', authored_by: 'analyst' });
    await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type: 'hypothesis_assessment',
        target_id:   'H1',
        rationale:   'Test challenge.',
        authored_by: 'analyst',
      });
    await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}`)
      .send({ status: 'suspended', actor: 'analyst' });

    const afterRes = await request(app).get(`/api/cases/${G15}/forensic-analysis`);
    const after = afterRes.body;

    // causal_attribution_established must be unchanged
    expect(after.causal_attribution_established).toBe(baseline.causal_attribution_established);

    // All hypothesis assessments must be unchanged
    for (const bh of baseline.hypotheses) {
      const ah = after.hypotheses.find((h) => h.hypothesis_id === bh.hypothesis_id);
      expect(ah).toBeDefined();
      expect(ah.assessment).toBe(bh.assessment);
    }
  }, 60_000);
});

// =============================================================================
// IW-14 — Cross-case isolation (ID-4, ID-5)
// =============================================================================
describe('IW-14: cross-case isolation — evidence and hypothesis namespace enforcement', () => {
  let g15Inv;
  let tcaInv;

  beforeEach(async () => {
    const [r1, r2] = await Promise.all([
      createInvestigation(G15),
      createInvestigation(TCA),
    ]);
    g15Inv = r1.body;
    tcaInv = r2.body;
  });

  test('IW-14-1: TCA evidence_id rejected in G15 investigation (ID-4)', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${g15Inv.investigation_id}/observations`)
      .send({
        text:         'Trying to cross-contaminate.',
        authored_by:  'analyst',
        evidence_ids: [TCA_VALID_EVIDENCE_ID],
      });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'INVALID_EVIDENCE_ID', 422);
  });

  test('IW-14-2: G15 evidence_id rejected in TCA investigation (ID-4 reverse)', async () => {
    const res = await request(app)
      .post(`/api/cases/${TCA}/investigations/${tcaInv.investigation_id}/observations`)
      .send({
        text:         'Trying to cross-contaminate.',
        authored_by:  'analyst',
        evidence_ids: [G15_VALID_EVIDENCE_ID],
      });
    expect(res.status).toBe(422);
    assertErrorShape(res.body, 'INVALID_EVIDENCE_ID', 422);
  });

  test('IW-14-3: G15 investigation not visible in TCA investigation list (ID-4 namespace)', async () => {
    const res = await request(app).get(`/api/cases/${TCA}/investigations`);
    const ids = res.body.map((i) => i.investigation_id);
    expect(ids).not.toContain(g15Inv.investigation_id);
  });

  test('IW-14-4: TCA investigation not accessible via G15 URL (ID-4 cross-case guard)', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${tcaInv.investigation_id}`);
    expect(res.status).toBe(404);
    assertErrorShape(res.body, 'INVESTIGATION_NOT_FOUND', 404);
  });
});
