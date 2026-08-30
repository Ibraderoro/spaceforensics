'use strict';

/**
 * Phase 8.6 — Investigation Concurrency and Cross-Case Isolation Hardening
 *
 * All assertions verify that operations for Case A (galaxy-15) can never
 * read, write, or mutate state belonging to Case B (test-case-alpha), and
 * vice versa, even when executed concurrently.
 *
 * Test groups:
 *   CI-1   Concurrent investigation creation for both cases
 *   CI-2   Concurrent reads of investigations in both cases
 *   CI-3   Concurrent investigate/challenge HTTP requests for both cases
 *   CI-4   Cross-case evidence ID injection (observations + challenges)
 *   CI-5   Cross-case hypothesis ID manipulation (observations + challenges)
 *   CI-6   Concurrent artifact retrieval for both cases
 *   CI-7   One case failing while the other succeeds
 *   CI-8   Repository queries are case-scoped — no cross-case leakage
 *   CI-9   Globally safe identifiers — UUIDs are unique across cases
 *   CI-10  No mutable global state — concurrent forensic pipelines are independent
 *   CI-11  Store invariants — causal_attribution_established never stored or mutated
 *   CI-12  Investigation cross-case access — investigation belonging to Case A
 *          cannot be accessed through Case B's URL path
 *
 * Coordination strategy:
 *   All concurrency is expressed as Promise.all over HTTP (supertest) calls.
 *   No sleep-based synchronisation is used; completion of the Promise.all
 *   is the explicit synchronization point.
 */

const request = require('supertest');
const { app, investigationStore, parseEvidenceCSV, buildEvidenceGraph,
        buildForensicAnalysis } = require('../server');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const G15 = 'galaxy-15';
const TCA = 'test-case-alpha';
const BOGUS = 'no-such-case-ci86';

const G15_ID_RE  = /^E-G15-\d{4}$/;
const TCA_ID_RE  = /^E-TCA-\d{4}$/;
const UUID_RE    = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Known valid IDs in each case.
const G15_EVIDENCE_ID = 'E-G15-0001';
const TCA_EVIDENCE_ID = 'E-TCA-0001';
const G15_HYPOTHESIS  = 'H1';
const TCA_HYPOTHESIS  = 'H1';   // same label, different namespace
const G15_HYPOTHESIS_ONLY = 'H5';  // H5 exists in G15 but not in TCA

// ─────────────────────────────────────────────────────────────────────────────
// Reset investigation store before each test.
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  investigationStore._reset();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function createInv(caseId, extra = {}) {
  const res = await request(app)
    .post(`/api/cases/${caseId}/investigations`)
    .send({ title: `CI-86 test for ${caseId}`, opened_by: 'ci-tester', ...extra });
  expect(res.status).toBe(201);
  return res.body;
}

async function addObservation(caseId, invId, opts = {}) {
  return request(app)
    .post(`/api/cases/${caseId}/investigations/${invId}/observations`)
    .send({
      text:        opts.text        || 'Standard CI observation.',
      authored_by: opts.authored_by || 'ci-tester',
      evidence_ids:  opts.evidence_ids  || [],
      hypothesis_ids: opts.hypothesis_ids || [],
    });
}

async function addChallenge(caseId, invId, opts = {}) {
  return request(app)
    .post(`/api/cases/${caseId}/investigations/${invId}/challenges`)
    .send({
      target_type:       opts.target_type       || 'limitation',
      target_id:         opts.target_id         || 'missing-telemetry',
      analyst_statement: opts.analyst_statement || 'CI challenge statement.',
      authored_by:       opts.authored_by       || 'ci-tester',
      evidence_ids:      opts.evidence_ids      || [],
    });
}

// =============================================================================
// CI-1 — Concurrent investigation creation for both cases
// =============================================================================

describe('CI-1: concurrent investigation creation for both cases', () => {
  test('CI-1-1: concurrent POSTs for G15 and TCA both return 201', async () => {
    const [g15Res, tcaRes] = await Promise.all([
      request(app).post(`/api/cases/${G15}/investigations`).send({ title: 'G15 concurrent', opened_by: 'a' }),
      request(app).post(`/api/cases/${TCA}/investigations`).send({ title: 'TCA concurrent', opened_by: 'b' }),
    ]);
    expect(g15Res.status).toBe(201);
    expect(tcaRes.status).toBe(201);
  });

  test('CI-1-2: concurrently created investigations have distinct UUIDs', async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        request(app).post(`/api/cases/${i % 2 === 0 ? G15 : TCA}/investigations`)
          .send({ title: `CI-1-2 inv ${i}`, opened_by: 'ci' }),
      ),
    );
    const ids = responses.map((r) => r.body.investigation_id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(UUID_RE);
    }
  });

  test('CI-1-3: G15 investigations do not appear in TCA list after concurrent creation', async () => {
    await Promise.all([
      request(app).post(`/api/cases/${G15}/investigations`).send({ title: 'G15-a', opened_by: 'a' }),
      request(app).post(`/api/cases/${G15}/investigations`).send({ title: 'G15-b', opened_by: 'b' }),
      request(app).post(`/api/cases/${TCA}/investigations`).send({ title: 'TCA-a', opened_by: 'c' }),
    ]);

    const [g15List, tcaList] = await Promise.all([
      request(app).get(`/api/cases/${G15}/investigations`),
      request(app).get(`/api/cases/${TCA}/investigations`),
    ]);

    expect(g15List.body).toHaveLength(2);
    expect(tcaList.body).toHaveLength(1);

    const g15Ids = new Set(g15List.body.map((i) => i.investigation_id));
    const tcaIds = new Set(tcaList.body.map((i) => i.investigation_id));
    // No overlap.
    for (const id of tcaIds) {
      expect(g15Ids.has(id)).toBe(false);
    }
  });

  test('CI-1-4: each investigation records the correct case_id after concurrent creation', async () => {
    const [g15Res, tcaRes] = await Promise.all([
      request(app).post(`/api/cases/${G15}/investigations`).send({ title: 'G15', opened_by: 'x' }),
      request(app).post(`/api/cases/${TCA}/investigations`).send({ title: 'TCA', opened_by: 'y' }),
    ]);
    expect(g15Res.body.case_id).toBe(G15);
    expect(tcaRes.body.case_id).toBe(TCA);
  });
});

// =============================================================================
// CI-2 — Concurrent reads of investigations in both cases
// =============================================================================

describe('CI-2: concurrent reads of investigations in both cases', () => {
  let g15Inv, tcaInv;

  beforeEach(async () => {
    [g15Inv, tcaInv] = await Promise.all([createInv(G15), createInv(TCA)]);
  });

  test('CI-2-1: concurrent GET of both investigations returns each with correct case_id', async () => {
    const [g15Get, tcaGet] = await Promise.all([
      request(app).get(`/api/cases/${G15}/investigations/${g15Inv.investigation_id}`),
      request(app).get(`/api/cases/${TCA}/investigations/${tcaInv.investigation_id}`),
    ]);
    expect(g15Get.status).toBe(200);
    expect(tcaGet.status).toBe(200);
    expect(g15Get.body.case_id).toBe(G15);
    expect(tcaGet.body.case_id).toBe(TCA);
    expect(g15Get.body.investigation_id).toBe(g15Inv.investigation_id);
    expect(tcaGet.body.investigation_id).toBe(tcaInv.investigation_id);
  });

  test('CI-2-2: concurrent reads of both state endpoints are isolated', async () => {
    // Add an observation to G15 only.
    await addObservation(G15, g15Inv.investigation_id, { text: 'G15 note only.' });

    const [g15State, tcaState] = await Promise.all([
      request(app).get(`/api/cases/${G15}/investigations/${g15Inv.investigation_id}/state`),
      request(app).get(`/api/cases/${TCA}/investigations/${tcaInv.investigation_id}/state`),
    ]);

    expect(g15State.body.observation_count).toBe(1);
    expect(tcaState.body.observation_count).toBe(0);  // TCA sees zero — not contaminated
  });

  test('CI-2-3: concurrent reads of both investigation lists see only their own items', async () => {
    // Create one more G15 investigation.
    await createInv(G15);

    const [g15List, tcaList] = await Promise.all([
      request(app).get(`/api/cases/${G15}/investigations`),
      request(app).get(`/api/cases/${TCA}/investigations`),
    ]);
    expect(g15List.body).toHaveLength(2);
    expect(tcaList.body).toHaveLength(1);
  });

  test('CI-2-4: concurrent reads of both forensic analyses are independent', async () => {
    const [g15FA, tcaFA] = await Promise.all([
      request(app).get(`/api/cases/${G15}/forensic-analysis`),
      request(app).get(`/api/cases/${TCA}/forensic-analysis`),
    ]);
    expect(g15FA.status).toBe(200);
    expect(tcaFA.status).toBe(200);
    expect(g15FA.body.case_id).toBe(G15);
    expect(tcaFA.body.case_id).toBe(TCA);
    expect(g15FA.body.causal_attribution_established).toBe(false);
    expect(tcaFA.body.causal_attribution_established).toBe(false);

    // G15 has H1–H5; TCA has its own hypothesis set.
    // Neither must contain evidence IDs from the other case.
    const g15Text = JSON.stringify(g15FA.body);
    const tcaText = JSON.stringify(tcaFA.body);
    expect(g15Text).not.toMatch(/E-TCA-\d{4}/);
    expect(tcaText).not.toMatch(/E-G15-\d{4}/);
  });
});

// =============================================================================
// CI-3 — Concurrent investigate/challenge HTTP requests for both cases
// =============================================================================

describe('CI-3: concurrent investigate/challenge requests for both cases', () => {
  test('CI-3-1: concurrent POST /investigate for G15 and TCA both succeed', async () => {
    const [g15, tca] = await Promise.all([
      request(app).post(`/api/cases/${G15}/investigate`),
      request(app).post(`/api/cases/${TCA}/investigate`),
    ]);
    expect(g15.status).toBe(200);
    expect(tca.status).toBe(200);
    // Each response must only contain its own case's evidence IDs.
    expect(JSON.stringify(g15.body)).not.toMatch(/E-TCA-\d{4}/);
    expect(JSON.stringify(tca.body)).not.toMatch(/E-G15-\d{4}/);
  });

  test('CI-3-2: concurrent POST /challenge for G15 and TCA both succeed and are isolated', async () => {
    const [g15, tca] = await Promise.all([
      request(app).post(`/api/cases/${G15}/challenge`),
      request(app).post(`/api/cases/${TCA}/challenge`),
    ]);
    expect(g15.status).toBe(200);
    expect(tca.status).toBe(200);
    expect(g15.body.case_id).toBe(G15);
    expect(tca.body.case_id).toBe(TCA);
    // No cross-case IDs.
    expect(JSON.stringify(g15.body)).not.toMatch(/E-TCA-\d{4}/);
    expect(JSON.stringify(tca.body)).not.toMatch(/E-G15-\d{4}/);
  });

  test('CI-3-3: four concurrent investigate calls (2 per case) return correct case-scoped results', async () => {
    const results = await Promise.all([
      request(app).post(`/api/cases/${G15}/investigate`),
      request(app).post(`/api/cases/${TCA}/investigate`),
      request(app).post(`/api/cases/${G15}/investigate`),
      request(app).post(`/api/cases/${TCA}/investigate`),
    ]);
    for (const r of results) {
      expect(r.status).toBe(200);
    }
    // All G15 results must not contain TCA IDs.
    for (const r of [results[0], results[2]]) {
      expect(JSON.stringify(r.body)).not.toMatch(/E-TCA-\d{4}/);
    }
    // All TCA results must not contain G15 IDs.
    for (const r of [results[1], results[3]]) {
      expect(JSON.stringify(r.body)).not.toMatch(/E-G15-\d{4}/);
    }
  });

  test('CI-3-4: concurrent investigation assessments are deterministic and case-correct', async () => {
    const [g15a, g15b] = await Promise.all([
      request(app).post(`/api/cases/${G15}/investigate`),
      request(app).post(`/api/cases/${G15}/investigate`),
    ]);
    // Two concurrent G15 investigations must return the same hypothesis assessments.
    const assess = (body) =>
      Object.fromEntries(body.hypotheses.map((h) => [h.hypothesis_id, h.assessment]));
    expect(assess(g15a.body)).toEqual(assess(g15b.body));
  });
});

// =============================================================================
// CI-4 — Cross-case evidence ID injection (observations + challenges)
// =============================================================================

describe('CI-4: cross-case evidence ID injection', () => {
  let g15Inv, tcaInv;

  beforeEach(async () => {
    [g15Inv, tcaInv] = await Promise.all([createInv(G15), createInv(TCA)]);
  });

  test('CI-4-1: TCA evidence ID in G15 observation is rejected with 422', async () => {
    const res = await addObservation(G15, g15Inv.investigation_id, {
      text: 'Attempting to cite TCA evidence in G15.',
      evidence_ids: [TCA_EVIDENCE_ID],
    });
    expect(res.status).toBe(422);
    expect(res.body.error_code).toBe('INVALID_EVIDENCE_ID');
  });

  test('CI-4-2: G15 evidence ID in TCA observation is rejected with 422', async () => {
    const res = await addObservation(TCA, tcaInv.investigation_id, {
      text: 'Attempting to cite G15 evidence in TCA.',
      evidence_ids: [G15_EVIDENCE_ID],
    });
    expect(res.status).toBe(422);
    expect(res.body.error_code).toBe('INVALID_EVIDENCE_ID');
  });

  test('CI-4-3: concurrent cross-case injection attempts are both rejected', async () => {
    const [r1, r2] = await Promise.all([
      addObservation(G15, g15Inv.investigation_id, {
        text: 'Injecting TCA evidence.',
        evidence_ids: [TCA_EVIDENCE_ID],
      }),
      addObservation(TCA, tcaInv.investigation_id, {
        text: 'Injecting G15 evidence.',
        evidence_ids: [G15_EVIDENCE_ID],
      }),
    ]);
    expect(r1.status).toBe(422);
    expect(r2.status).toBe(422);
    expect(r1.body.error_code).toBe('INVALID_EVIDENCE_ID');
    expect(r2.body.error_code).toBe('INVALID_EVIDENCE_ID');
  });

  test('CI-4-4: TCA evidence ID in G15 challenge evidence_ids is rejected with 422', async () => {
    const res = await addChallenge(G15, g15Inv.investigation_id, {
      target_type:       'evidence_classification',
      target_id:         G15_EVIDENCE_ID,
      analyst_statement: 'Classifying anchor evidence.',
      evidence_ids:      [TCA_EVIDENCE_ID],  // cross-case support evidence
    });
    expect(res.status).toBe(422);
    expect(res.body.error_code).toBe('INVALID_EVIDENCE_ID');
  });

  test('CI-4-5: TCA evidence ID used as challenge target_id in evidence_classification is rejected', async () => {
    const res = await addChallenge(G15, g15Inv.investigation_id, {
      target_type:       'evidence_classification',
      target_id:         TCA_EVIDENCE_ID,    // cross-case target_id
      analyst_statement: 'Challenging TCA evidence in a G15 investigation.',
    });
    expect(res.status).toBe(422);
    expect(res.body.error_code).toBe('INVALID_EVIDENCE_ID');
  });

  test('CI-4-6: valid evidence IDs for each case are accepted concurrently', async () => {
    const [r1, r2] = await Promise.all([
      addObservation(G15, g15Inv.investigation_id, {
        text: 'Valid G15 evidence.',
        evidence_ids: [G15_EVIDENCE_ID],
      }),
      addObservation(TCA, tcaInv.investigation_id, {
        text: 'Valid TCA evidence.',
        evidence_ids: [TCA_EVIDENCE_ID],
      }),
    ]);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.evidence_ids).toContain(G15_EVIDENCE_ID);
    expect(r2.body.evidence_ids).toContain(TCA_EVIDENCE_ID);
    // Neither response should contain the other case's evidence ID.
    expect(r1.body.evidence_ids).not.toContain(TCA_EVIDENCE_ID);
    expect(r2.body.evidence_ids).not.toContain(G15_EVIDENCE_ID);
  });

  test('CI-4-7: fabricated evidence ID (not in any case) rejected in G15 observation', async () => {
    const res = await addObservation(G15, g15Inv.investigation_id, {
      text: 'Fabricated evidence reference.',
      evidence_ids: ['E-FAKE-9999'],
    });
    expect(res.status).toBe(422);
    expect(res.body.error_code).toBe('INVALID_EVIDENCE_ID');
  });

  test('CI-4-8: stored observation evidence_ids in G15 investigation are all G15 IDs', async () => {
    await addObservation(G15, g15Inv.investigation_id, {
      text: 'Observation with valid G15 evidence.',
      evidence_ids: [G15_EVIDENCE_ID],
    });
    const histRes = await request(app)
      .get(`/api/cases/${G15}/investigations/${g15Inv.investigation_id}/history`);
    expect(histRes.status).toBe(200);
    const allEvidenceIds = histRes.body.observations.flatMap((o) => o.evidence_ids);
    for (const eid of allEvidenceIds) {
      expect(eid).toMatch(G15_ID_RE);
    }
  });
});

// =============================================================================
// CI-5 — Cross-case hypothesis ID manipulation
// =============================================================================

describe('CI-5: cross-case hypothesis ID manipulation', () => {
  let g15Inv, tcaInv;

  beforeEach(async () => {
    [g15Inv, tcaInv] = await Promise.all([createInv(G15), createInv(TCA)]);
  });

  test('CI-5-1: G15 hypothesis H5 challenged in TCA investigation is rejected', async () => {
    // H5 exists in G15 but not in TCA.
    const res = await addChallenge(TCA, tcaInv.investigation_id, {
      target_type:       'hypothesis_assessment',
      target_id:         G15_HYPOTHESIS_ONLY,   // H5 — TCA does not have this
      analyst_statement: 'Challenging H5 in TCA context.',
    });
    expect(res.status).toBe(422);
    expect(res.body.error_code).toBe('INVALID_HYPOTHESIS_ID');
  });

  test('CI-5-2: fabricated hypothesis ID rejected in G15 observation', async () => {
    const res = await addObservation(G15, g15Inv.investigation_id, {
      text: 'Fabricated hypothesis.',
      hypothesis_ids: ['H999-FABRICATED'],
    });
    expect(res.status).toBe(422);
    expect(res.body.error_code).toBe('INVALID_HYPOTHESIS_ID');
  });

  test('CI-5-3: concurrent cross-case hypothesis injection attempts are both rejected', async () => {
    const [r1, r2] = await Promise.all([
      // Try to use a fabricated TCA-specific hypothesis in G15.
      addObservation(G15, g15Inv.investigation_id, {
        text: 'Cross-case H injection to G15.',
        hypothesis_ids: ['H999-TCA-ONLY'],
      }),
      // Try to use G15's H5 in TCA (H5 doesn't exist in TCA).
      addChallenge(TCA, tcaInv.investigation_id, {
        target_type:       'hypothesis_assessment',
        target_id:         G15_HYPOTHESIS_ONLY,
        analyst_statement: 'H5 cross-case challenge.',
      }),
    ]);
    expect(r1.status).toBe(422);
    expect(r2.status).toBe(422);
  });

  test('CI-5-4: valid G15 hypothesis challenge accepted; valid TCA hypothesis challenge accepted concurrently', async () => {
    const [r1, r2] = await Promise.all([
      addChallenge(G15, g15Inv.investigation_id, {
        target_type:       'hypothesis_assessment',
        target_id:         G15_HYPOTHESIS,
        analyst_statement: 'Challenging G15 H1 assessment.',
      }),
      addChallenge(TCA, tcaInv.investigation_id, {
        target_type:       'hypothesis_assessment',
        target_id:         TCA_HYPOTHESIS,
        analyst_statement: 'Challenging TCA H1 assessment.',
      }),
    ]);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.case_id).toBe(G15);
    expect(r2.body.case_id).toBe(TCA);
    expect(r1.body.target_id).toBe(G15_HYPOTHESIS);
    expect(r2.body.target_id).toBe(TCA_HYPOTHESIS);
  });

  test('CI-5-5: challenge body with assessment field is rejected regardless of case', async () => {
    const [r1, r2] = await Promise.all([
      request(app)
        .post(`/api/cases/${G15}/investigations/${g15Inv.investigation_id}/challenges`)
        .send({
          target_type:       'hypothesis_assessment',
          target_id:         G15_HYPOTHESIS,
          analyst_statement: 'Attempt to set assessment.',
          assessment:        'strongly_supported',    // FORBIDDEN
        }),
      request(app)
        .post(`/api/cases/${TCA}/investigations/${tcaInv.investigation_id}/challenges`)
        .send({
          target_type:                  'hypothesis_assessment',
          target_id:                    TCA_HYPOTHESIS,
          analyst_statement:            'Attempt to establish causality.',
          causal_attribution_established: true,       // FORBIDDEN
        }),
    ]);
    expect(r1.status).toBe(422);
    expect(r1.body.error_code).toBe('FORENSIC_FIELD_IMMUTABLE');
    expect(r2.status).toBe(422);
    expect(r2.body.error_code).toBe('FORENSIC_FIELD_IMMUTABLE');
  });

  test('CI-5-6: after concurrent hypothesis challenges, forensic H1–H5 assessments are unchanged', async () => {
    await Promise.all([
      addChallenge(G15, g15Inv.investigation_id, {
        target_type:       'hypothesis_assessment',
        target_id:         'H1',
        analyst_statement: 'I disagree with H1 mixed assessment.',
      }),
      addChallenge(G15, g15Inv.investigation_id, {
        target_type:       'hypothesis_assessment',
        target_id:         'H3',
        analyst_statement: 'I disagree with H3 supported assessment.',
      }),
    ]);
    const fa = await request(app).get(`/api/cases/${G15}/forensic-analysis`);
    expect(fa.status).toBe(200);
    expect(fa.body.causal_attribution_established).toBe(false);
    const h1 = fa.body.hypotheses.find((h) => h.hypothesis_id === 'H1');
    const h3 = fa.body.hypotheses.find((h) => h.hypothesis_id === 'H3');
    expect(h1.assessment).toBe('mixed');
    expect(h3.assessment).toBe('supported');
  }, 30_000);
});

// =============================================================================
// CI-6 — Concurrent artifact retrieval for both cases
// =============================================================================

describe('CI-6: concurrent artifact retrieval for both cases', () => {
  let g15Inv, tcaInv;

  beforeEach(async () => {
    [g15Inv, tcaInv] = await Promise.all([createInv(G15), createInv(TCA)]);
  });

  test('CI-6-1: concurrent artifact retrieval for G15 and TCA both succeed', async () => {
    const [g15Art, tcaArt] = await Promise.all([
      request(app).get(`/api/cases/${G15}/investigations/${g15Inv.investigation_id}/artifact`),
      request(app).get(`/api/cases/${TCA}/investigations/${tcaInv.investigation_id}/artifact`),
    ]);
    expect(g15Art.status).toBe(200);
    expect(tcaArt.status).toBe(200);
  }, 30_000);

  test('CI-6-2: G15 artifact contains G15 case_id; TCA artifact contains TCA case_id', async () => {
    const [g15Art, tcaArt] = await Promise.all([
      request(app).get(`/api/cases/${G15}/investigations/${g15Inv.investigation_id}/artifact`),
      request(app).get(`/api/cases/${TCA}/investigations/${tcaInv.investigation_id}/artifact`),
    ]);
    // case_id is nested inside case_identity (ART schema: no top-level case_id).
    expect(g15Art.body.case_identity.case_id).toBe(G15);
    expect(tcaArt.body.case_identity.case_id).toBe(TCA);
  }, 30_000);

  test('CI-6-3: G15 artifact contains no TCA evidence IDs; TCA artifact contains no G15 evidence IDs', async () => {
    const [g15Art, tcaArt] = await Promise.all([
      request(app).get(`/api/cases/${G15}/investigations/${g15Inv.investigation_id}/artifact`),
      request(app).get(`/api/cases/${TCA}/investigations/${tcaInv.investigation_id}/artifact`),
    ]);
    const g15Text = JSON.stringify(g15Art.body);
    const tcaText = JSON.stringify(tcaArt.body);
    expect(g15Text).not.toMatch(/E-TCA-\d{4}/);
    expect(tcaText).not.toMatch(/E-G15-\d{4}/);
  }, 30_000);

  test('CI-6-4: G15 artifact causal_attribution_established is false after concurrent retrieval', async () => {
    const [g15Art] = await Promise.all([
      request(app).get(`/api/cases/${G15}/investigations/${g15Inv.investigation_id}/artifact`),
      request(app).get(`/api/cases/${TCA}/investigations/${tcaInv.investigation_id}/artifact`),
    ]);
    const fa = g15Art.body.forensic_analysis;
    expect(fa).toBeDefined();
    expect(fa.causal_attribution_established).toBe(false);
  }, 30_000);

  test('CI-6-5: artifact observation/challenge content is investigation-scoped', async () => {
    // Add content to the G15 investigation only.
    await addObservation(G15, g15Inv.investigation_id, { text: 'G15-only observation.' });
    await addChallenge(G15, g15Inv.investigation_id, {
      analyst_statement: 'G15-only challenge.',
    });

    const [g15Art, tcaArt] = await Promise.all([
      request(app).get(`/api/cases/${G15}/investigations/${g15Inv.investigation_id}/artifact`),
      request(app).get(`/api/cases/${TCA}/investigations/${tcaInv.investigation_id}/artifact`),
    ]);

    const g15Content = g15Art.body.analyst_content || {};
    const tcaContent = tcaArt.body.analyst_content || {};

    // G15 artifact has the observation and challenge; TCA artifact has zero.
    expect(g15Content.observation_count).toBeGreaterThanOrEqual(1);
    expect(g15Content.challenge_count).toBeGreaterThanOrEqual(1);
    expect(tcaContent.observation_count).toBe(0);
    expect(tcaContent.challenge_count).toBe(0);
  }, 30_000);

  test('CI-6-6: TCA investigation ID cannot retrieve G15 artifact (cross-case access blocked)', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${tcaInv.investigation_id}/artifact`);
    expect(res.status).toBe(404);
    expect(res.body.error_code).toBe('INVESTIGATION_NOT_FOUND');
  }, 30_000);
});

// =============================================================================
// CI-7 — One case failing while the other succeeds
// =============================================================================

describe('CI-7: one case failing while the other succeeds', () => {
  test('CI-7-1: G15 succeeds and unknown case fails in concurrent investigate calls', async () => {
    const [g15, bogus] = await Promise.all([
      request(app).post(`/api/cases/${G15}/investigate`),
      request(app).post(`/api/cases/${BOGUS}/investigate`),
    ]);
    expect(g15.status).toBe(200);
    expect(bogus.status).toBe(404);
    // G15 response is unaffected by the bogus failure.
    expect(Array.isArray(g15.body.hypotheses)).toBe(true);
    expect(bogus.body).toHaveProperty('error');
  });

  test('CI-7-2: G15 investigation creation succeeds while unknown case fails', async () => {
    const [g15, bogus] = await Promise.all([
      request(app).post(`/api/cases/${G15}/investigations`).send({ title: 'CI-7-2', opened_by: 'ci' }),
      request(app).post(`/api/cases/${BOGUS}/investigations`).send({ title: 'bogus', opened_by: 'ci' }),
    ]);
    expect(g15.status).toBe(201);
    expect(bogus.status).toBe(404);
    expect(g15.body).toHaveProperty('investigation_id');
    expect(bogus.body).toHaveProperty('error_code');
  });

  test('CI-7-3: G15 forensic analysis is unaffected by concurrent bogus-case call', async () => {
    const [g15FA, bogusFA] = await Promise.all([
      request(app).get(`/api/cases/${G15}/forensic-analysis`),
      request(app).get(`/api/cases/${BOGUS}/forensic-analysis`),
    ]);
    expect(g15FA.status).toBe(200);
    expect(bogusFA.status).toBe(404);
    expect(g15FA.body.causal_attribution_established).toBe(false);
    expect(g15FA.body.case_id).toBe(G15);
  }, 30_000);

  test('CI-7-4: eight concurrent mixed-case calls — all successes are correct, all failures are 404', async () => {
    const requests = await Promise.all([
      request(app).post(`/api/cases/${G15}/investigate`),
      request(app).post(`/api/cases/${BOGUS}/investigate`),
      request(app).post(`/api/cases/${TCA}/investigate`),
      request(app).post(`/api/cases/${BOGUS}/investigate`),
      request(app).get(`/api/cases/${G15}/forensic-analysis`),
      request(app).get(`/api/cases/${BOGUS}/forensic-analysis`),
      request(app).post(`/api/cases/${TCA}/investigations`).send({ title: 'mixed', opened_by: 'ci' }),
      request(app).post(`/api/cases/${BOGUS}/investigations`).send({ title: 'bogus', opened_by: 'ci' }),
    ]);
    // Indices 0, 2, 4, 6 are valid cases; 1, 3, 5, 7 are bogus.
    for (const idx of [0, 2, 4, 6]) {
      expect(requests[idx].status).not.toBe(404);
      expect(requests[idx].status).not.toBe(500);
    }
    for (const idx of [1, 3, 5, 7]) {
      expect(requests[idx].status).toBe(404);
    }
  }, 30_000);
});

// =============================================================================
// CI-8 — Repository queries are case-scoped
// =============================================================================

describe('CI-8: repository queries are case-scoped', () => {
  test('CI-8-1: getInvestigationsForCase returns only investigations for the requested case', async () => {
    await Promise.all([
      createInv(G15),
      createInv(G15),
      createInv(TCA),
    ]);
    const g15Only = investigationStore.getInvestigationsForCase(G15);
    const tcaOnly = investigationStore.getInvestigationsForCase(TCA);
    expect(g15Only).toHaveLength(2);
    expect(tcaOnly).toHaveLength(1);
    for (const inv of g15Only) {
      expect(inv.case_id).toBe(G15);
    }
    for (const inv of tcaOnly) {
      expect(inv.case_id).toBe(TCA);
    }
  });

  test('CI-8-2: getChallengesForCase returns only challenges scoped to the requested case', async () => {
    const [g15Inv, tcaInv] = await Promise.all([createInv(G15), createInv(TCA)]);
    await Promise.all([
      addChallenge(G15, g15Inv.investigation_id),
      addChallenge(G15, g15Inv.investigation_id),
      addChallenge(TCA, tcaInv.investigation_id),
    ]);
    const g15Challenges = investigationStore.getChallengesForCase(G15);
    const tcaChallenges = investigationStore.getChallengesForCase(TCA);
    expect(g15Challenges).toHaveLength(2);
    expect(tcaChallenges).toHaveLength(1);
    for (const ch of g15Challenges) {
      expect(ch.case_id).toBe(G15);
    }
    for (const ch of tcaChallenges) {
      expect(ch.case_id).toBe(TCA);
    }
  });

  test('CI-8-3: getChallengesForInvestigation returns only challenges for that investigation', async () => {
    const [g15Inv1, g15Inv2] = await Promise.all([createInv(G15), createInv(G15)]);
    await Promise.all([
      addChallenge(G15, g15Inv1.investigation_id),
      addChallenge(G15, g15Inv1.investigation_id),
      addChallenge(G15, g15Inv2.investigation_id),
    ]);
    const inv1Challenges = investigationStore.getChallengesForInvestigation(g15Inv1.investigation_id);
    const inv2Challenges = investigationStore.getChallengesForInvestigation(g15Inv2.investigation_id);
    expect(inv1Challenges).toHaveLength(2);
    expect(inv2Challenges).toHaveLength(1);
    for (const ch of inv1Challenges) {
      expect(ch.investigation_id).toBe(g15Inv1.investigation_id);
    }
  });

  test('CI-8-4: GET /api/cases/:id/challenges is case-scoped', async () => {
    const [g15Inv, tcaInv] = await Promise.all([createInv(G15), createInv(TCA)]);
    await Promise.all([
      addChallenge(G15, g15Inv.investigation_id),
      addChallenge(TCA, tcaInv.investigation_id),
      addChallenge(TCA, tcaInv.investigation_id),
    ]);
    const [g15, tca] = await Promise.all([
      request(app).get(`/api/cases/${G15}/challenges`),
      request(app).get(`/api/cases/${TCA}/challenges`),
    ]);
    expect(g15.body.challenge_count).toBe(1);
    expect(tca.body.challenge_count).toBe(2);
    for (const ch of g15.body.challenges) {
      expect(ch.case_id).toBe(G15);
    }
    for (const ch of tca.body.challenges) {
      expect(ch.case_id).toBe(TCA);
    }
  });

  test('CI-8-5: getObservationsForInvestigation is investigation-scoped, not case-scoped leak', async () => {
    const [g15Inv1, g15Inv2] = await Promise.all([createInv(G15), createInv(G15)]);
    await addObservation(G15, g15Inv1.investigation_id, { text: 'Obs for inv1.' });
    await addObservation(G15, g15Inv2.investigation_id, { text: 'Obs for inv2.' });

    const inv1Obs = investigationStore.getObservationsForInvestigation(g15Inv1.investigation_id);
    const inv2Obs = investigationStore.getObservationsForInvestigation(g15Inv2.investigation_id);

    expect(inv1Obs).toHaveLength(1);
    expect(inv2Obs).toHaveLength(1);
    expect(inv1Obs[0].investigation_id).toBe(g15Inv1.investigation_id);
    expect(inv2Obs[0].investigation_id).toBe(g15Inv2.investigation_id);
  });
});

// =============================================================================
// CI-9 — Globally safe identifiers — UUIDs unique across concurrent creation
// =============================================================================

describe('CI-9: globally safe identifiers', () => {
  test('CI-9-1: 20 concurrently created investigations have 20 unique UUIDs', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        request(app).post(`/api/cases/${i % 2 === 0 ? G15 : TCA}/investigations`)
          .send({ title: `CI-9 inv ${i}`, opened_by: 'ci' }),
      ),
    );
    const ids = responses.map((r) => {
      expect(r.status).toBe(201);
      return r.body.investigation_id;
    });
    const unique = new Set(ids);
    expect(unique.size).toBe(20);
    for (const id of ids) {
      expect(id).toMatch(UUID_RE);
    }
  });

  test('CI-9-2: challenge IDs are globally unique across concurrent creation for both cases', async () => {
    const [g15Inv, tcaInv] = await Promise.all([createInv(G15), createInv(TCA)]);
    const responses = await Promise.all([
      addChallenge(G15, g15Inv.investigation_id),
      addChallenge(G15, g15Inv.investigation_id),
      addChallenge(TCA, tcaInv.investigation_id),
      addChallenge(TCA, tcaInv.investigation_id),
    ]);
    const ids = responses.map((r) => {
      expect(r.status).toBe(201);
      return r.body.challenge_id;
    });
    const unique = new Set(ids);
    expect(unique.size).toBe(4);
    for (const id of ids) {
      expect(id).toMatch(UUID_RE);
    }
  });

  test('CI-9-3: observation IDs are globally unique across concurrent creation', async () => {
    const [g15Inv, tcaInv] = await Promise.all([createInv(G15), createInv(TCA)]);
    const responses = await Promise.all([
      addObservation(G15, g15Inv.investigation_id, { text: 'obs-1' }),
      addObservation(G15, g15Inv.investigation_id, { text: 'obs-2' }),
      addObservation(TCA, tcaInv.investigation_id, { text: 'obs-3' }),
    ]);
    const ids = responses.map((r) => {
      expect(r.status).toBe(201);
      return r.body.observation_id;
    });
    const unique = new Set(ids);
    expect(unique.size).toBe(3);
  });
});

// =============================================================================
// CI-10 — No mutable global state — concurrent forensic pipelines are independent
// =============================================================================

describe('CI-10: no mutable global state — concurrent forensic pipelines', () => {
  test('CI-10-1: concurrent parseEvidenceCSV calls return correct and independent results', async () => {
    const [g15Rows, tcaRows] = await Promise.all([
      parseEvidenceCSV(G15),
      parseEvidenceCSV(TCA),
    ]);
    // Each is the correct case.
    for (const r of g15Rows) expect(r.evidence_id).toMatch(G15_ID_RE);
    for (const r of tcaRows) expect(r.evidence_id).toMatch(TCA_ID_RE);
    // No cross-case contamination.
    const g15Ids = new Set(g15Rows.map((r) => r.evidence_id));
    const tcaIds = new Set(tcaRows.map((r) => r.evidence_id));
    for (const id of tcaIds) expect(g15Ids.has(id)).toBe(false);
  });

  test('CI-10-2: concurrent buildForensicAnalysis calls are independent (no shared mutable state)', async () => {
    const [g15Rows, tcaRows] = await Promise.all([
      parseEvidenceCSV(G15),
      parseEvidenceCSV(TCA),
    ]);
    const [g15Graph, tcaGraph] = await Promise.all([
      buildEvidenceGraph(G15, g15Rows),
      buildEvidenceGraph(TCA, tcaRows),
    ]);
    const [g15Analysis, tcaAnalysis] = await Promise.all([
      buildForensicAnalysis(G15, g15Graph),
      buildForensicAnalysis(TCA, tcaGraph),
    ]);
    expect(g15Analysis.case_id).toBe(G15);
    expect(tcaAnalysis.case_id).toBe(TCA);
    expect(g15Analysis.causal_attribution_established).toBe(false);
    expect(tcaAnalysis.causal_attribution_established).toBe(false);
    // G15 H5 must still be strongly_supported.
    const g15H5 = g15Analysis.hypotheses.find((h) => h.hypothesis_id === 'H5');
    expect(g15H5).toBeDefined();
    expect(g15H5.assessment).toBe('strongly_supported');
  });

  test('CI-10-3: eight concurrent forensic pipelines finish with consistent causal_attribution_established', async () => {
    // Run 4 G15 + 4 TCA pipelines simultaneously.
    const pipelineResults = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(app).get(`/api/cases/${i < 4 ? G15 : TCA}/forensic-analysis`),
      ),
    );
    for (const r of pipelineResults) {
      expect(r.status).toBe(200);
      expect(r.body.causal_attribution_established).toBe(false);
    }
    // All G15 results must agree on H5 assessment.
    const g15Results = pipelineResults.slice(0, 4);
    const h5Assessments = g15Results.map(
      (r) => r.body.hypotheses.find((h) => h.hypothesis_id === 'H5').assessment,
    );
    expect(new Set(h5Assessments).size).toBe(1);  // all the same
    expect(h5Assessments[0]).toBe('strongly_supported');
  }, 30_000);

  test('CI-10-4: investigationStore uses per-instance Maps — no module-level mutable state', () => {
    // Verify that _reset() genuinely clears the in-memory store with no
    // residual state. This tests the absence of module-level mutable variables.
    const { InMemoryInvestigationRepository } = require('../services/InvestigationRepository');
    const repo = new InMemoryInvestigationRepository();

    const inv1 = repo.createInvestigation({ case_id: G15, title: 'test', opened_by: 'ci' });
    const inv2 = repo.createInvestigation({ case_id: TCA, title: 'test', opened_by: 'ci' });

    expect(repo.getInvestigationsForCase(G15)).toHaveLength(1);
    expect(repo.getInvestigationsForCase(TCA)).toHaveLength(1);

    repo._reset();

    expect(repo.getInvestigationsForCase(G15)).toHaveLength(0);
    expect(repo.getInvestigationsForCase(TCA)).toHaveLength(0);
    expect(repo.getInvestigation(inv1.investigation_id)).toBeNull();
    expect(repo.getInvestigation(inv2.investigation_id)).toBeNull();
  });

  test('CI-10-5: two independent InMemoryInvestigationRepository instances do not share state', () => {
    const { InMemoryInvestigationRepository } = require('../services/InvestigationRepository');
    const repoA = new InMemoryInvestigationRepository();
    const repoB = new InMemoryInvestigationRepository();

    const inv = repoA.createInvestigation({ case_id: G15, title: 'A-only', opened_by: 'ci' });

    // repoB must have no knowledge of repoA's data.
    expect(repoB.getInvestigation(inv.investigation_id)).toBeNull();
    expect(repoB.getInvestigationsForCase(G15)).toHaveLength(0);

    // repoA still has the investigation.
    expect(repoA.getInvestigation(inv.investigation_id)).not.toBeNull();
  });
});

// =============================================================================
// CI-11 — Store invariants: causal_attribution_established never stored/mutated
// =============================================================================

describe('CI-11: causal_attribution_established never stored in investigation store', () => {
  let g15Inv;

  beforeEach(async () => {
    g15Inv = await createInv(G15);
  });

  test('CI-11-1: investigation record does not contain causal_attribution_established', () => {
    const stored = investigationStore.getInvestigation(g15Inv.investigation_id);
    expect(stored).not.toHaveProperty('causal_attribution_established');
  });

  test('CI-11-2: challenge record does not contain causal_attribution_established', async () => {
    const chalRes = await addChallenge(G15, g15Inv.investigation_id);
    expect(chalRes.status).toBe(201);
    const stored = investigationStore.getChallenge(chalRes.body.challenge_id);
    expect(stored).not.toHaveProperty('causal_attribution_established');
  });

  test('CI-11-3: observation record does not contain causal_attribution_established', async () => {
    const obsRes = await addObservation(G15, g15Inv.investigation_id, { text: 'CI-11 test.' });
    expect(obsRes.status).toBe(201);
    const stored = investigationStore.getObservation(obsRes.body.observation_id);
    expect(stored).not.toHaveProperty('causal_attribution_established');
  });

  test('CI-11-4: concurrent observation + challenge writes do not alter forensic output', async () => {
    await Promise.all([
      addObservation(G15, g15Inv.investigation_id, { text: 'Concurrent note.' }),
      addChallenge(G15, g15Inv.investigation_id, {
        analyst_statement: 'Concurrent challenge.',
      }),
    ]);
    const fa = await request(app).get(`/api/cases/${G15}/forensic-analysis`);
    expect(fa.status).toBe(200);
    expect(fa.body.causal_attribution_established).toBe(false);
  }, 30_000);
});

// =============================================================================
// CI-12 — Investigation cross-case access is blocked at the route layer
// =============================================================================

describe('CI-12: investigation cross-case URL access is blocked', () => {
  let g15Inv, tcaInv;

  beforeEach(async () => {
    [g15Inv, tcaInv] = await Promise.all([createInv(G15), createInv(TCA)]);
  });

  test('CI-12-1: G15 investigation_id accessed via TCA URL returns 404', async () => {
    const res = await request(app)
      .get(`/api/cases/${TCA}/investigations/${g15Inv.investigation_id}`);
    expect(res.status).toBe(404);
    expect(res.body.error_code).toBe('INVESTIGATION_NOT_FOUND');
  });

  test('CI-12-2: TCA investigation_id accessed via G15 URL returns 404', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${tcaInv.investigation_id}`);
    expect(res.status).toBe(404);
    expect(res.body.error_code).toBe('INVESTIGATION_NOT_FOUND');
  });

  test('CI-12-3: adding observation to G15 investigation via TCA URL returns 404', async () => {
    const res = await request(app)
      .post(`/api/cases/${TCA}/investigations/${g15Inv.investigation_id}/observations`)
      .send({ text: 'Cross-case observation write attempt.', authored_by: 'attacker' });
    expect(res.status).toBe(404);
    expect(res.body.error_code).toBe('INVESTIGATION_NOT_FOUND');
  });

  test('CI-12-4: adding challenge to G15 investigation via TCA URL returns 404', async () => {
    const res = await request(app)
      .post(`/api/cases/${TCA}/investigations/${g15Inv.investigation_id}/challenges`)
      .send({
        target_type:       'limitation',
        target_id:         'any-limitation',
        analyst_statement: 'Cross-case challenge write attempt.',
        authored_by:       'attacker',
      });
    expect(res.status).toBe(404);
    expect(res.body.error_code).toBe('INVESTIGATION_NOT_FOUND');
  });

  test('CI-12-5: concurrent cross-case access attempts are both blocked', async () => {
    const [r1, r2] = await Promise.all([
      request(app).get(`/api/cases/${TCA}/investigations/${g15Inv.investigation_id}`),
      request(app).get(`/api/cases/${G15}/investigations/${tcaInv.investigation_id}`),
    ]);
    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);
    expect(r1.body.error_code).toBe('INVESTIGATION_NOT_FOUND');
    expect(r2.body.error_code).toBe('INVESTIGATION_NOT_FOUND');
  });

  test('CI-12-6: after cross-case access attempts, original investigations are unmodified', async () => {
    // Attempt cross-case writes — they fail.
    await Promise.all([
      request(app).post(`/api/cases/${TCA}/investigations/${g15Inv.investigation_id}/observations`)
        .send({ text: 'Cross-case write.', authored_by: 'ci' }),
      request(app).post(`/api/cases/${G15}/investigations/${tcaInv.investigation_id}/observations`)
        .send({ text: 'Cross-case write.', authored_by: 'ci' }),
    ]);

    // Original investigations must be unmodified.
    const [g15State, tcaState] = await Promise.all([
      request(app).get(`/api/cases/${G15}/investigations/${g15Inv.investigation_id}/state`),
      request(app).get(`/api/cases/${TCA}/investigations/${tcaInv.investigation_id}/state`),
    ]);
    expect(g15State.body.observation_count).toBe(0);
    expect(tcaState.body.observation_count).toBe(0);
  });
});
