'use strict';

// ---------------------------------------------------------------------------
// Phase 7.5 — Investigation Summary endpoint tests
//
// GET /api/cases/:id/investigations/:iid/summary
//
// Tests are grouped by the nine response sections defined in the Phase 7.5
// specification:
//
//   IS-1   Top-level structure and metadata
//   IS-2   case_metadata section
//   IS-3   investigation_state section
//   IS-4   forensic_conclusion section
//   IS-5   hypotheses section
//   IS-6   evidence_references section
//   IS-7   provenance section
//   IS-8   limitations section
//   IS-9   ai_narrative section
//   IS-10  analyst_challenges section
//   IS-11  Error handling (404 case, 404 investigation, cross-case)
//   IS-12  Pipeline isolation invariants (SUM-1 through SUM-6)
//   IS-13  Galaxy-15 baseline preservation
// ---------------------------------------------------------------------------

const request = require('supertest');
const { app, investigationStore } = require('../server');

const G15 = 'galaxy-15';
const TCA = 'test-case-alpha';
const G15_VALID_HYPOTHESIS = 'H1';
const G15_VALID_EVIDENCE   = 'E-G15-0001';

// Helper: create an investigation and return the record.
async function makeInvestigation(caseId = G15, extra = {}) {
  const res = await request(app)
    .post(`/api/cases/${caseId}/investigations`)
    .send({ title: 'Summary test', opened_by: 'tester', ...extra });
  expect(res.status).toBe(201);
  return res.body;
}

// Helper: fetch the summary for an investigation.
async function getSummary(caseId, iid) {
  return request(app).get(`/api/cases/${caseId}/investigations/${iid}/summary`);
}

beforeEach(() => {
  investigationStore._reset();
});

// ===========================================================================
// IS-1 — Top-level structure and metadata
// ===========================================================================
describe('IS-1: top-level structure', () => {
  test('IS-1-1: returns HTTP 200 for a valid investigation', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(res.status).toBe(200);
  });

  test('IS-1-2: response carries summary_version "1.0.0"', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(res.body.summary_version).toBe('1.0.0');
  });

  test('IS-1-3: response carries generated_at ISO8601 timestamp', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(typeof res.body.generated_at).toBe('string');
    expect(() => new Date(res.body.generated_at)).not.toThrow();
    expect(new Date(res.body.generated_at).toISOString()).toBe(res.body.generated_at);
  });

  test('IS-1-4: all nine top-level sections are present', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    const body = res.body;
    expect(body).toHaveProperty('case_metadata');
    expect(body).toHaveProperty('investigation_state');
    expect(body).toHaveProperty('forensic_conclusion');
    expect(body).toHaveProperty('hypotheses');
    expect(body).toHaveProperty('evidence_references');
    expect(body).toHaveProperty('provenance');
    expect(body).toHaveProperty('limitations');
    expect(body).toHaveProperty('ai_narrative');
    expect(body).toHaveProperty('analyst_challenges');
  });
});

// ===========================================================================
// IS-2 — case_metadata section
// ===========================================================================
describe('IS-2: case_metadata section', () => {
  test('IS-2-1: case_id matches the requested case', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(res.body.case_metadata.case_id).toBe(G15);
  });

  test('IS-2-2: title is a non-empty string', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(typeof res.body.case_metadata.title).toBe('string');
    expect(res.body.case_metadata.title.length).toBeGreaterThan(0);
  });

  test('IS-2-3: causal_attribution is present and not a boolean', async () => {
    // causal_attribution in case.json is a narrative string, not a boolean.
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(typeof res.body.case_metadata.causal_attribution).toBe('string');
  });

  test('IS-2-4: anchor_event carries timestamp', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(res.body.case_metadata.anchor_event).toHaveProperty('timestamp');
  });

  test('IS-2-5: data_sources is an array', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(Array.isArray(res.body.case_metadata.data_sources)).toBe(true);
    expect(res.body.case_metadata.data_sources.length).toBeGreaterThan(0);
  });

  test('IS-2-6: scientific_limitations is an array of strings', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    const lims = res.body.case_metadata.scientific_limitations;
    expect(Array.isArray(lims)).toBe(true);
    lims.forEach((l) => expect(typeof l).toBe('string'));
  });

  test('IS-2-7: target_asset carries operator field', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(res.body.case_metadata.target_asset).toHaveProperty('operator');
  });
});

// ===========================================================================
// IS-3 — investigation_state section
// ===========================================================================
describe('IS-3: investigation_state section', () => {
  test('IS-3-1: investigation_id matches the requested investigation', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(res.body.investigation_state.investigation_id).toBe(inv.investigation_id);
  });

  test('IS-3-2: case_id matches the requested case', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(res.body.investigation_state.case_id).toBe(G15);
  });

  test('IS-3-3: status is "open" for a freshly opened investigation', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(res.body.investigation_state.status).toBe('open');
  });

  test('IS-3-4: observation_count starts at 0', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(res.body.investigation_state.observation_count).toBe(0);
  });

  test('IS-3-5: challenge_count starts at 0', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(res.body.investigation_state.challenge_count).toBe(0);
  });

  test('IS-3-6: observation_count reflects actual observations', async () => {
    const inv = await makeInvestigation();
    await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/observations`)
      .send({ text: 'Test observation.', authored_by: 'tester' });
    const res = await getSummary(G15, inv.investigation_id);
    expect(res.body.investigation_state.observation_count).toBe(1);
  });

  test('IS-3-7: challenge_count reflects actual challenges', async () => {
    const inv = await makeInvestigation();
    await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type: 'hypothesis_assessment',
        target_id:   G15_VALID_HYPOTHESIS,
        analyst_statement: 'Questioning the assessment.',
        authored_by: 'tester',
      });
    const res = await getSummary(G15, inv.investigation_id);
    expect(res.body.investigation_state.challenge_count).toBe(1);
  });

  test('IS-3-8: events is an array with at least the opened event', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    const events = res.body.investigation_state.events;
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].event).toBe('opened');
  });
});

// ===========================================================================
// IS-4 — forensic_conclusion section
// ===========================================================================
describe('IS-4: forensic_conclusion section', () => {
  test('IS-4-1: causal_attribution_established is false for galaxy-15', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(res.body.forensic_conclusion.causal_attribution_established).toBe(false);
  });

  test('IS-4-2: causal_attribution_established is strictly boolean', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(typeof res.body.forensic_conclusion.causal_attribution_established).toBe('boolean');
  });

  test('IS-4-3: analysis_version is a non-empty string', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(typeof res.body.forensic_conclusion.analysis_version).toBe('string');
    expect(res.body.forensic_conclusion.analysis_version.length).toBeGreaterThan(0);
  });

  test('IS-4-4: evidence_summary carries the five count fields', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    const es = res.body.forensic_conclusion.evidence_summary;
    expect(es).toHaveProperty('total_environmental_context');
    expect(es).toHaveProperty('total_supporting_evidence');
    expect(es).toHaveProperty('total_contradicting_evidence');
    expect(es).toHaveProperty('total_non_discriminating_evidence');
    expect(es).toHaveProperty('total_limitations');
  });

  test('IS-4-5: comparison carries most_supported', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(res.body.forensic_conclusion.comparison).toHaveProperty('most_supported');
  });

  test('IS-4-6: causal_attribution_statement is a non-empty string for galaxy-15', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(typeof res.body.forensic_conclusion.causal_attribution_statement).toBe('string');
    expect(res.body.forensic_conclusion.causal_attribution_statement.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// IS-5 — hypotheses section
// ===========================================================================
describe('IS-5: hypotheses section', () => {
  test('IS-5-1: hypotheses is an array of 5 entries for galaxy-15', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(Array.isArray(res.body.hypotheses)).toBe(true);
    expect(res.body.hypotheses).toHaveLength(5);
  });

  test('IS-5-2: each hypothesis carries hypothesis_id, label, assessment', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    for (const h of res.body.hypotheses) {
      expect(typeof h.hypothesis_id).toBe('string');
      expect(typeof h.label).toBe('string');
      expect(typeof h.assessment).toBe('string');
    }
  });

  test('IS-5-3: each hypothesis carries evidence_summary with count fields', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    for (const h of res.body.hypotheses) {
      expect(h.evidence_summary).toHaveProperty('environmental_context_count');
      expect(h.evidence_summary).toHaveProperty('supporting_evidence_count');
    }
  });

  test('IS-5-4: each hypothesis carries a non-empty key_observations array', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    for (const h of res.body.hypotheses) {
      expect(Array.isArray(h.key_observations)).toBe(true);
      expect(h.key_observations.length).toBeGreaterThan(0);
    }
  });

  test('IS-5-5: each hypothesis carries a limitations array', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    for (const h of res.body.hypotheses) {
      expect(Array.isArray(h.limitations)).toBe(true);
    }
  });

  test('IS-5-6: assessment vocabulary is from the allowed set', async () => {
    const ALLOWED = new Set([
      'strongly_supported', 'supported', 'mixed', 'weakly_supported', 'insufficient_evidence',
    ]);
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    for (const h of res.body.hypotheses) {
      expect(ALLOWED.has(h.assessment)).toBe(true);
    }
  });
});

// ===========================================================================
// IS-6 — evidence_references section
// ===========================================================================
describe('IS-6: evidence_references section', () => {
  test('IS-6-1: total_evidence_rows is 278 for galaxy-15', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(res.body.evidence_references.total_evidence_rows).toBe(278);
  });

  test('IS-6-2: referenced_evidence_count > 0', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(res.body.evidence_references.referenced_evidence_count).toBeGreaterThan(0);
  });

  test('IS-6-3: evidence_by_hypothesis has one entry per hypothesis', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(res.body.evidence_references.evidence_by_hypothesis).toHaveLength(5);
  });

  test('IS-6-4: evidence_by_hypothesis entries carry four list ID arrays', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    for (const h of res.body.evidence_references.evidence_by_hypothesis) {
      expect(Array.isArray(h.environmental_context_ids)).toBe(true);
      expect(Array.isArray(h.supporting_evidence_ids)).toBe(true);
      expect(Array.isArray(h.contradicting_evidence_ids)).toBe(true);
      expect(Array.isArray(h.non_discriminating_evidence_ids)).toBe(true);
    }
  });

  test('IS-6-5: all evidence IDs follow the E-G15- prefix for galaxy-15', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    const allIds = res.body.evidence_references.evidence_by_hypothesis.flatMap((h) => [
      ...h.environmental_context_ids,
      ...h.supporting_evidence_ids,
      ...h.contradicting_evidence_ids,
      ...h.non_discriminating_evidence_ids,
    ]);
    for (const id of allIds) {
      expect(id).toMatch(/^E-G15-\d{4}$/);
    }
  });
});

// ===========================================================================
// IS-7 — provenance section
// ===========================================================================
describe('IS-7: provenance section', () => {
  test('IS-7-1: data_sources is an array with entries', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(Array.isArray(res.body.provenance.data_sources)).toBe(true);
    expect(res.body.provenance.data_sources.length).toBeGreaterThan(0);
  });

  test('IS-7-2: each data source carries dataset_id and provider', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    for (const ds of res.body.provenance.data_sources) {
      expect(ds).toHaveProperty('dataset_id');
      expect(ds).toHaveProperty('provider');
    }
  });

  test('IS-7-3: heuristic_window_note is a non-empty string for galaxy-15', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(typeof res.body.provenance.heuristic_window_note).toBe('string');
    expect(res.body.provenance.heuristic_window_note.length).toBeGreaterThan(0);
  });

  test('IS-7-4: evidence_count matches total_evidence_rows', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(res.body.provenance.evidence_count)
      .toBe(res.body.evidence_references.total_evidence_rows);
  });
});

// ===========================================================================
// IS-8 — limitations section
// ===========================================================================
describe('IS-8: limitations section', () => {
  test('IS-8-1: limitations is a non-empty array', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(Array.isArray(res.body.limitations)).toBe(true);
    expect(res.body.limitations.length).toBeGreaterThan(0);
  });

  test('IS-8-2: each limitation carries type and description', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    for (const l of res.body.limitations) {
      expect(typeof l.type).toBe('string');
      expect(typeof l.description).toBe('string');
    }
  });

  test('IS-8-3: limitation descriptions are unique (deduplication)', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    const descriptions = res.body.limitations.map((l) => l.description);
    const unique = new Set(descriptions);
    expect(unique.size).toBe(descriptions.length);
  });
});

// ===========================================================================
// IS-9 — ai_narrative section
// ===========================================================================
describe('IS-9: ai_narrative section', () => {
  test('IS-9-1: ai_narrative is present and non-null', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(res.body.ai_narrative).not.toBeNull();
    expect(typeof res.body.ai_narrative).toBe('object');
  });

  test('IS-9-2: executive_summary is a non-empty string', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(typeof res.body.ai_narrative.executive_summary).toBe('string');
    expect(res.body.ai_narrative.executive_summary.length).toBeGreaterThan(0);
  });

  test('IS-9-3: causal_attribution_established matches forensic_conclusion', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(res.body.ai_narrative.causal_attribution_established)
      .toBe(res.body.forensic_conclusion.causal_attribution_established);
  });

  test('IS-9-4: hypothesis_assessments count matches hypotheses count', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(res.body.ai_narrative.hypothesis_assessments).toHaveLength(
      res.body.hypotheses.length,
    );
  });

  test('IS-9-5: source field is present (heuristic or llm)', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(['heuristic', 'llm']).toContain(res.body.ai_narrative.source);
  });

  test('IS-9-6: no causal certainty language in executive_summary', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    const lower = (res.body.ai_narrative.executive_summary || '').toLowerCase();
    expect(lower).not.toContain('proves');
    expect(lower).not.toContain('causation established');
  });
});

// ===========================================================================
// IS-10 — analyst_challenges section
// ===========================================================================
describe('IS-10: analyst_challenges section', () => {
  test('IS-10-1: challenge_count starts at 0', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(res.body.analyst_challenges.challenge_count).toBe(0);
  });

  test('IS-10-2: challenge status counters all start at 0', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    const ac = res.body.analyst_challenges;
    expect(ac.open_count).toBe(0);
    expect(ac.under_review_count).toBe(0);
    expect(ac.resolved_count).toBe(0);
    expect(ac.rejected_count).toBe(0);
  });

  test('IS-10-3: challenge_count and open_count reflect a created challenge', async () => {
    const inv = await makeInvestigation();
    await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type: 'limitation',
        target_id:   'proxy_measurement',
        analyst_statement: 'Proxy distance should be quantified.',
        authored_by: 'tester',
      });
    const res = await getSummary(G15, inv.investigation_id);
    const ac = res.body.analyst_challenges;
    expect(ac.challenge_count).toBe(1);
    expect(ac.open_count).toBe(1);
  });

  test('IS-10-4: resolved challenge increments resolved_count', async () => {
    const inv = await makeInvestigation();
    const chalRes = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type: 'limitation',
        target_id:   'proxy_measurement',
        analyst_statement: 'Proxy measurement distance concern.',
        authored_by: 'tester',
      });
    const chalId = chalRes.body.challenge_id;
    // Transition to under_review then resolved.
    await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${chalId}`)
      .send({ status: 'under_review', actor: 'reviewer' });
    await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${chalId}`)
      .send({ status: 'resolved', actor: 'reviewer', resolution_outcome: 'acknowledged' });

    const res = await getSummary(G15, inv.investigation_id);
    const ac = res.body.analyst_challenges;
    expect(ac.resolved_count).toBe(1);
    expect(ac.open_count).toBe(0);
  });

  test('IS-10-5: challenges array carries required fields per challenge', async () => {
    const inv = await makeInvestigation();
    await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type: 'hypothesis_assessment',
        target_id:   G15_VALID_HYPOTHESIS,
        analyst_statement: 'Assessment rationale needs elaboration.',
        authored_by: 'tester',
      });
    const res = await getSummary(G15, inv.investigation_id);
    const c = res.body.analyst_challenges.challenges[0];
    expect(c).toHaveProperty('challenge_id');
    expect(c).toHaveProperty('target_type');
    expect(c).toHaveProperty('target_id');
    expect(c).toHaveProperty('analyst_statement');
    expect(c).toHaveProperty('status');
    expect(c).toHaveProperty('lifecycle');
    expect(c).toHaveProperty('resolution_metadata');
  });

  test('IS-10-6: only challenges for this investigation are included (SUM-3)', async () => {
    const inv1 = await makeInvestigation();
    const inv2 = await makeInvestigation();
    await request(app)
      .post(`/api/cases/${G15}/investigations/${inv1.investigation_id}/challenges`)
      .send({
        target_type: 'limitation',
        target_id:   'x',
        analyst_statement: 'Challenge in investigation 1.',
        authored_by: 'tester',
      });
    const res = await getSummary(G15, inv2.investigation_id);
    // inv2 has no challenges — must not bleed inv1's challenge.
    expect(res.body.analyst_challenges.challenge_count).toBe(0);
    expect(res.body.analyst_challenges.challenges).toHaveLength(0);
  });
});

// ===========================================================================
// IS-11 — Error handling
// ===========================================================================
describe('IS-11: error handling', () => {
  test('IS-11-1: 404 for unknown case', async () => {
    const res = await request(app)
      .get('/api/cases/no-such-case/investigations/fake-iid/summary');
    expect(res.status).toBe(404);
    expect(res.body.error_code).toBe('CASE_NOT_FOUND');
  });

  test('IS-11-2: 404 for unknown investigation', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/00000000-0000-0000-0000-000000000000/summary`);
    expect(res.status).toBe(404);
    expect(res.body.error_code).toBe('INVESTIGATION_NOT_FOUND');
  });

  test('IS-11-3: 404 when investigation belongs to a different case (cross-case)', async () => {
    const inv = await makeInvestigation(TCA);
    // Request the TCA investigation under G15 — must be rejected.
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/summary`);
    expect(res.status).toBe(404);
    expect(res.body.error_code).toBe('INVESTIGATION_NOT_FOUND');
  });
});

// ===========================================================================
// IS-12 — Pipeline isolation invariants
// ===========================================================================
describe('IS-12: pipeline isolation invariants', () => {
  test('IS-12-1: SUM-1 — forensic_conclusion is identical regardless of investigation contents', async () => {
    // Two investigations for the same case — one with content, one empty.
    const invEmpty = await makeInvestigation();
    const invFull  = await makeInvestigation();

    // Add observations and challenges to invFull.
    await request(app)
      .post(`/api/cases/${G15}/investigations/${invFull.investigation_id}/observations`)
      .send({ text: 'Some observation.', authored_by: 'tester' });
    await request(app)
      .post(`/api/cases/${G15}/investigations/${invFull.investigation_id}/challenges`)
      .send({
        target_type: 'limitation',
        target_id:   'proxy',
        analyst_statement: 'Proxy concern.',
        authored_by: 'tester',
      });

    const [resEmpty, resFull] = await Promise.all([
      getSummary(G15, invEmpty.investigation_id),
      getSummary(G15, invFull.investigation_id),
    ]);

    // The forensic pipeline output must be identical between both investigations.
    expect(resEmpty.body.forensic_conclusion.causal_attribution_established)
      .toBe(resFull.body.forensic_conclusion.causal_attribution_established);
    expect(resEmpty.body.forensic_conclusion.analysis_version)
      .toBe(resFull.body.forensic_conclusion.analysis_version);
    // Deep-equal the evidence summary.
    expect(JSON.stringify(resEmpty.body.forensic_conclusion.evidence_summary))
      .toBe(JSON.stringify(resFull.body.forensic_conclusion.evidence_summary));
  });

  test('IS-12-2: SUM-2 — hypotheses assessments are read-only (not mutable from investigation)', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    // H5 is strongly_supported in galaxy-15 hypotheses.json.
    const h5 = res.body.hypotheses.find((h) => h.hypothesis_id === 'H5');
    expect(h5.assessment).toBe('strongly_supported');
  });

  test('IS-12-3: SUM-3 — challenges in summary are scoped to the investigation', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    for (const c of res.body.analyst_challenges.challenges) {
      // Every challenge must belong to this investigation's case.
      expect(c.challenge_id).toBeTruthy();
    }
    // Empty investigation: challenges array is empty.
    expect(res.body.analyst_challenges.challenges).toHaveLength(0);
  });

  test('IS-12-4: SUM-4 — generated_at is a fresh timestamp (not stale)', async () => {
    const inv = await makeInvestigation();
    const before = Date.now();
    const res = await getSummary(G15, inv.investigation_id);
    const after = Date.now();
    const ts = new Date(res.body.generated_at).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 100); // small clock tolerance
  });

  test('IS-12-5: SUM-5 — ai_narrative source is present', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(res.body.ai_narrative).toHaveProperty('source');
    expect(['heuristic', 'llm']).toContain(res.body.ai_narrative.source);
  });

  test('IS-12-6: SUM-6 — observations are not in the response body (count only)', async () => {
    const inv = await makeInvestigation();
    await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/observations`)
      .send({ text: 'Detailed observation text that must NOT appear in summary.', authored_by: 'a' });
    const res = await getSummary(G15, inv.investigation_id);
    // investigation_state must NOT carry an observations array with text.
    expect(res.body.investigation_state).not.toHaveProperty('observations');
    expect(res.body.investigation_state.observation_count).toBe(1);
  });
});

// ===========================================================================
// IS-13 — Galaxy-15 baseline preservation
// ===========================================================================
describe('IS-13: galaxy-15 baseline preservation', () => {
  test('IS-13-1: forensic pipeline output is byte-identical to the standalone /forensic-analysis endpoint', async () => {
    const inv     = await makeInvestigation();
    const [sumRes, faRes] = await Promise.all([
      getSummary(G15, inv.investigation_id),
      request(app).get(`/api/cases/${G15}/forensic-analysis`),
    ]);
    expect(sumRes.status).toBe(200);
    expect(faRes.status).toBe(200);

    const sumConc = sumRes.body.forensic_conclusion;
    const fa      = faRes.body;

    // causal_attribution_established must match.
    expect(sumConc.causal_attribution_established).toBe(fa.causal_attribution_established);
    // analysis_version must match.
    expect(sumConc.analysis_version).toBe(fa.analysis_version);
    // Hypothesis count must match.
    expect(sumRes.body.hypotheses.length).toBe(fa.hypotheses.length);
    // Per-hypothesis assessments must be identical.
    for (const sh of sumRes.body.hypotheses) {
      const fah = fa.hypotheses.find((h) => h.hypothesis_id === sh.hypothesis_id);
      expect(fah).toBeDefined();
      expect(sh.assessment).toBe(fah.assessment);
    }
  });

  test('IS-13-2: limitations count matches standalone /forensic-analysis', async () => {
    const inv = await makeInvestigation();
    const [sumRes, faRes] = await Promise.all([
      getSummary(G15, inv.investigation_id),
      request(app).get(`/api/cases/${G15}/forensic-analysis`),
    ]);
    expect(sumRes.body.limitations.length).toBe(faRes.body.limitations.length);
  });

  test('IS-13-3: evidence_references total matches 278 rows', async () => {
    const inv = await makeInvestigation();
    const res = await getSummary(G15, inv.investigation_id);
    expect(res.body.evidence_references.total_evidence_rows).toBe(278);
  });
});
