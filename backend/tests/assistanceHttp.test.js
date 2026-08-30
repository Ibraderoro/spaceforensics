'use strict';

/**
 * Phase 7.6 — Investigation Assistance endpoint — HTTP Integration Tests
 *
 * GET /api/cases/:id/investigations/:iid/assistance
 *
 * Test groups:
 *   AAS-1   Top-level structure (version, all 7 fields, generated_at, IDs, source)
 *   AAS-2   findings_summary (non-empty, no causal-certainty language, reflects G15 causal_attribution_established = false)
 *   AAS-3   evidence_relationships (non-empty array, one entry per hypothesis for G15 = 5, no numerical probabilities)
 *   AAS-4   limitations_explained (non-empty array, each a string)
 *   AAS-5   unanswered_questions (non-empty array, no mechanism-confirmation language)
 *   AAS-6   challenge_summary (changes between 0 and 1 challenge; "uncontested" when 0, count when ≥ 1)
 *   AAS-7   additional_evidence_suggestions (non-empty array)
 *   AAS-8   observation_inconsistencies (non-empty array; "No analyst observations or challenges" when empty)
 *   AAS-9   Error handling (CASE_NOT_FOUND, INVESTIGATION_NOT_FOUND, cross-case)
 *   AAS-10  Pipeline isolation (identical forensic content for two investigations on same case with different observation counts)
 */

const request = require('supertest');
const { app, investigationStore } = require('../server');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const G15   = 'galaxy-15';
const TCA   = 'test-case-alpha';
const BOGUS = 'no-such-case-aas99';

const G15_VALID_HYPOTHESIS  = 'H1';
const G15_VALID_EVIDENCE_ID = 'E-G15-0001';

const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// Words/phrases indicating causal certainty — must not appear in assistance output.
const CAUSAL_CERTAINTY_WORDS = ['proves', 'causation established', 'causal mechanism confirmed'];

// Phrases that claim the mechanism is settled — must not appear in unanswered_questions.
const MECHANISM_CONFIRMED_PHRASES = [
  'mechanism is established',
  'mechanism has been confirmed',
  'mechanism confirmed',
];

// ─────────────────────────────────────────────────────────────────────────────
// Store reset before every test
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  investigationStore._reset();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function makeInvestigation(caseId = G15, extra = {}) {
  const res = await request(app)
    .post(`/api/cases/${caseId}/investigations`)
    .send({ title: 'Assistance test', opened_by: 'tester', ...extra });
  expect(res.status).toBe(201);
  return res.body;
}

async function getAssistance(caseId, iid) {
  return request(app).get(`/api/cases/${caseId}/investigations/${iid}/assistance`);
}

async function addObservation(caseId, iid, text = 'Test observation') {
  return request(app)
    .post(`/api/cases/${caseId}/investigations/${iid}/observations`)
    .send({ text, authored_by: 'tester', evidence_ids: [], hypothesis_ids: [] });
}

async function addChallenge(caseId, iid, overrides = {}) {
  return request(app)
    .post(`/api/cases/${caseId}/investigations/${iid}/challenges`)
    .send({
      target_type:       overrides.target_type       || 'hypothesis_assessment',
      target_id:         overrides.target_id         || G15_VALID_HYPOTHESIS,
      analyst_statement: overrides.analyst_statement || 'The mixed assessment warrants scrutiny.',
      authored_by:       overrides.authored_by       || 'analyst',
      evidence_ids:      overrides.evidence_ids      || [],
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// AAS-1: Top-level structure
// ─────────────────────────────────────────────────────────────────────────────

describe('AAS-1: top-level structure', () => {
  let inv;
  beforeEach(async () => { inv = await makeInvestigation(G15); });

  test('AAS-1-1: returns HTTP 200 for a valid investigation', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    expect(res.status).toBe(200);
  });

  test('AAS-1-2: assistance_version is "1.0.0"', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    expect(res.body.assistance_version).toBe('1.0.0');
  });

  test('AAS-1-3: generated_at is present and is an ISO 8601 string', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    expect(typeof res.body.generated_at).toBe('string');
    expect(res.body.generated_at).toMatch(ISO8601_RE);
  });

  test('AAS-1-4: investigation_id matches the requested investigation', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    expect(res.body.investigation_id).toBe(inv.investigation_id);
  });

  test('AAS-1-5: case_id matches the requested case', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    expect(res.body.case_id).toBe(G15);
  });

  test('AAS-1-6: source is "heuristic" or "llm"', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    expect(['heuristic', 'llm']).toContain(res.body.source);
  });

  test('AAS-1-7: findings_summary is present', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    expect(res.body).toHaveProperty('findings_summary');
  });

  test('AAS-1-8: evidence_relationships is present', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    expect(res.body).toHaveProperty('evidence_relationships');
  });

  test('AAS-1-9: limitations_explained is present', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    expect(res.body).toHaveProperty('limitations_explained');
  });

  test('AAS-1-10: unanswered_questions is present', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    expect(res.body).toHaveProperty('unanswered_questions');
  });

  test('AAS-1-11: challenge_summary is present', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    expect(res.body).toHaveProperty('challenge_summary');
  });

  test('AAS-1-12: additional_evidence_suggestions is present', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    expect(res.body).toHaveProperty('additional_evidence_suggestions');
  });

  test('AAS-1-13: observation_inconsistencies is present', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    expect(res.body).toHaveProperty('observation_inconsistencies');
  });

  test('AAS-1-14: works for test-case-alpha (TCA) as well', async () => {
    const tcaInv = await makeInvestigation(TCA);
    const res    = await getAssistance(TCA, tcaInv.investigation_id);
    expect(res.status).toBe(200);
    expect(res.body.case_id).toBe(TCA);
    expect(res.body.investigation_id).toBe(tcaInv.investigation_id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AAS-2: findings_summary
// ─────────────────────────────────────────────────────────────────────────────

describe('AAS-2: findings_summary', () => {
  let inv;
  beforeEach(async () => { inv = await makeInvestigation(G15); });

  test('AAS-2-1: findings_summary is a non-empty string', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    expect(typeof res.body.findings_summary).toBe('string');
    expect(res.body.findings_summary.trim().length).toBeGreaterThan(0);
  });

  test('AAS-2-2: findings_summary does not contain the word "proves"', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    expect(res.body.findings_summary.toLowerCase()).not.toContain('proves');
  });

  test('AAS-2-3: findings_summary does not contain "causation established"', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    expect(res.body.findings_summary.toLowerCase()).not.toContain('causation established');
  });

  test('AAS-2-4: findings_summary reflects that causal_attribution_established is false for G15', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    const summary = res.body.findings_summary.toLowerCase();
    // Must indicate attribution has NOT been established.
    expect(summary).toMatch(/not been established|has not been established|not established/);
  });

  test('AAS-2-5: findings_summary does not claim causation has been confirmed', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    const lower = res.body.findings_summary.toLowerCase();
    expect(lower).not.toContain('causal attribution has been established from the available evidence.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AAS-3: evidence_relationships
// ─────────────────────────────────────────────────────────────────────────────

describe('AAS-3: evidence_relationships', () => {
  let inv;
  beforeEach(async () => { inv = await makeInvestigation(G15); });

  test('AAS-3-1: evidence_relationships is a non-empty array', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    expect(Array.isArray(res.body.evidence_relationships)).toBe(true);
    expect(res.body.evidence_relationships.length).toBeGreaterThan(0);
  });

  test('AAS-3-2: evidence_relationships has one entry per G15 hypothesis (5 entries)', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    expect(res.body.evidence_relationships).toHaveLength(5);
  });

  test('AAS-3-3: every entry in evidence_relationships is a string', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    for (const entry of res.body.evidence_relationships) {
      expect(typeof entry).toBe('string');
    }
  });

  test('AAS-3-4: every entry in evidence_relationships is non-empty', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    for (const entry of res.body.evidence_relationships) {
      expect(entry.trim().length).toBeGreaterThan(0);
    }
  });

  test('AAS-3-5: evidence_relationships entries do not contain numerical probability claims (e.g. "73%")', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    const PROB_RE = /\b\d+(\.\d+)?\s*%|\bprobability\s+of\s+\d/i;
    for (const entry of res.body.evidence_relationships) {
      expect(entry).not.toMatch(PROB_RE);
    }
  });

  test('AAS-3-6: each entry references a hypothesis ID (H1..H5)', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    for (const entry of res.body.evidence_relationships) {
      expect(entry).toMatch(/H[1-5]/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AAS-4: limitations_explained
// ─────────────────────────────────────────────────────────────────────────────

describe('AAS-4: limitations_explained', () => {
  let inv;
  beforeEach(async () => { inv = await makeInvestigation(G15); });

  test('AAS-4-1: limitations_explained is a non-empty array', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    expect(Array.isArray(res.body.limitations_explained)).toBe(true);
    expect(res.body.limitations_explained.length).toBeGreaterThan(0);
  });

  test('AAS-4-2: every entry in limitations_explained is a string', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    for (const entry of res.body.limitations_explained) {
      expect(typeof entry).toBe('string');
    }
  });

  test('AAS-4-3: every entry in limitations_explained is non-empty', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    for (const entry of res.body.limitations_explained) {
      expect(entry.trim().length).toBeGreaterThan(0);
    }
  });

  test('AAS-4-4: limitations_explained also non-empty for TCA', async () => {
    const tcaInv = await makeInvestigation(TCA);
    const res    = await getAssistance(TCA, tcaInv.investigation_id);
    expect(res.body.limitations_explained.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AAS-5: unanswered_questions
// ─────────────────────────────────────────────────────────────────────────────

describe('AAS-5: unanswered_questions', () => {
  let inv;
  beforeEach(async () => { inv = await makeInvestigation(G15); });

  test('AAS-5-1: unanswered_questions is a non-empty array', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    expect(Array.isArray(res.body.unanswered_questions)).toBe(true);
    expect(res.body.unanswered_questions.length).toBeGreaterThan(0);
  });

  test('AAS-5-2: every entry in unanswered_questions is a string', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    for (const q of res.body.unanswered_questions) {
      expect(typeof q).toBe('string');
    }
  });

  test('AAS-5-3: every entry in unanswered_questions is non-empty', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    for (const q of res.body.unanswered_questions) {
      expect(q.trim().length).toBeGreaterThan(0);
    }
  });

  test('AAS-5-4: unanswered_questions entries do not claim mechanism is established', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    for (const q of res.body.unanswered_questions) {
      const lower = q.toLowerCase();
      for (const phrase of MECHANISM_CONFIRMED_PHRASES) {
        expect(lower).not.toContain(phrase);
      }
    }
  });

  test('AAS-5-5: unanswered_questions entries do not contain causal-certainty language', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    for (const q of res.body.unanswered_questions) {
      const lower = q.toLowerCase();
      for (const phrase of CAUSAL_CERTAINTY_WORDS) {
        expect(lower).not.toContain(phrase);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AAS-6: challenge_summary
// ─────────────────────────────────────────────────────────────────────────────

describe('AAS-6: challenge_summary', () => {
  test('AAS-6-1: challenge_summary is a non-empty string', async () => {
    const inv = await makeInvestigation(G15);
    const res = await getAssistance(G15, inv.investigation_id);
    expect(typeof res.body.challenge_summary).toBe('string');
    expect(res.body.challenge_summary.trim().length).toBeGreaterThan(0);
  });

  test('AAS-6-2: with 0 challenges, challenge_summary mentions "uncontested"', async () => {
    const inv = await makeInvestigation(G15);
    const res = await getAssistance(G15, inv.investigation_id);
    expect(res.body.challenge_summary.toLowerCase()).toContain('uncontested');
  });

  test('AAS-6-3: with 0 challenges, challenge_summary mentions "No analyst challenges"', async () => {
    const inv = await makeInvestigation(G15);
    const res = await getAssistance(G15, inv.investigation_id);
    expect(res.body.challenge_summary.toLowerCase()).toContain('no analyst challenges');
  });

  test('AAS-6-4: with 1 challenge, challenge_summary changes from the zero-challenge text', async () => {
    const invNone = await makeInvestigation(G15);
    const resNone = await getAssistance(G15, invNone.investigation_id);
    const summaryNone = resNone.body.challenge_summary;

    investigationStore._reset();

    const invOne = await makeInvestigation(G15);
    await addChallenge(G15, invOne.investigation_id);
    const resOne = await getAssistance(G15, invOne.investigation_id);
    const summaryOne = resOne.body.challenge_summary;

    expect(summaryOne).not.toBe(summaryNone);
  });

  test('AAS-6-5: with 1 challenge, challenge_summary mentions the challenge count', async () => {
    const inv = await makeInvestigation(G15);
    await addChallenge(G15, inv.investigation_id);
    const res = await getAssistance(G15, inv.investigation_id);
    expect(res.body.challenge_summary).toMatch(/1\s+analyst\s+challenge/i);
  });

  test('AAS-6-6: challenge_summary with 1 challenge does not mention "uncontested"', async () => {
    const inv = await makeInvestigation(G15);
    await addChallenge(G15, inv.investigation_id);
    const res = await getAssistance(G15, inv.investigation_id);
    expect(res.body.challenge_summary.toLowerCase()).not.toContain('uncontested');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AAS-7: additional_evidence_suggestions
// ─────────────────────────────────────────────────────────────────────────────

describe('AAS-7: additional_evidence_suggestions', () => {
  let inv;
  beforeEach(async () => { inv = await makeInvestigation(G15); });

  test('AAS-7-1: additional_evidence_suggestions is a non-empty array', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    expect(Array.isArray(res.body.additional_evidence_suggestions)).toBe(true);
    expect(res.body.additional_evidence_suggestions.length).toBeGreaterThan(0);
  });

  test('AAS-7-2: every entry in additional_evidence_suggestions is a string', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    for (const s of res.body.additional_evidence_suggestions) {
      expect(typeof s).toBe('string');
    }
  });

  test('AAS-7-3: every entry in additional_evidence_suggestions is non-empty', async () => {
    const res = await getAssistance(G15, inv.investigation_id);
    for (const s of res.body.additional_evidence_suggestions) {
      expect(s.trim().length).toBeGreaterThan(0);
    }
  });

  test('AAS-7-4: additional_evidence_suggestions is also non-empty for TCA', async () => {
    const tcaInv = await makeInvestigation(TCA);
    const res    = await getAssistance(TCA, tcaInv.investigation_id);
    expect(res.body.additional_evidence_suggestions.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AAS-8: observation_inconsistencies
// ─────────────────────────────────────────────────────────────────────────────

describe('AAS-8: observation_inconsistencies', () => {
  test('AAS-8-1: observation_inconsistencies is a non-empty array', async () => {
    const inv = await makeInvestigation(G15);
    const res = await getAssistance(G15, inv.investigation_id);
    expect(Array.isArray(res.body.observation_inconsistencies)).toBe(true);
    expect(res.body.observation_inconsistencies.length).toBeGreaterThan(0);
  });

  test('AAS-8-2: every entry in observation_inconsistencies is a string', async () => {
    const inv = await makeInvestigation(G15);
    const res = await getAssistance(G15, inv.investigation_id);
    for (const entry of res.body.observation_inconsistencies) {
      expect(typeof entry).toBe('string');
    }
  });

  test('AAS-8-3: with 0 observations and 0 challenges, first entry mentions "No analyst observations or challenges"', async () => {
    const inv = await makeInvestigation(G15);
    const res = await getAssistance(G15, inv.investigation_id);
    const combined = res.body.observation_inconsistencies.join(' ');
    expect(combined.toLowerCase()).toContain('no analyst observations or challenges');
  });

  test('AAS-8-4: with 0 observations and 0 challenges, mentions "No inconsistencies can be identified"', async () => {
    const inv = await makeInvestigation(G15);
    const res = await getAssistance(G15, inv.investigation_id);
    const combined = res.body.observation_inconsistencies.join(' ').toLowerCase();
    expect(combined).toContain('no inconsistencies can be identified');
  });

  test('AAS-8-5: with 1 observation added, observation_inconsistencies reflects observer input', async () => {
    const inv = await makeInvestigation(G15);
    const obsRes = await addObservation(G15, inv.investigation_id, 'The solar flux reading looks anomalous.');
    expect(obsRes.status).toBe(201);

    const res = await getAssistance(G15, inv.investigation_id);
    // With at least one observation, the "No analyst observations" message must not dominate.
    const combined = res.body.observation_inconsistencies.join(' ');
    // The heuristic emits an obs count line when obsCount > 0.
    expect(combined).toMatch(/1\s+analyst\s+observation/i);
  });

  test('AAS-8-6: with 1 challenge added, observation_inconsistencies reflects the challenge', async () => {
    const inv = await makeInvestigation(G15);
    const chalRes = await addChallenge(G15, inv.investigation_id);
    expect(chalRes.status).toBe(201);

    const res = await getAssistance(G15, inv.investigation_id);
    const combined = res.body.observation_inconsistencies.join(' ');
    expect(combined).toMatch(/1\s+analyst\s+challenge/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AAS-9: Error handling
// ─────────────────────────────────────────────────────────────────────────────

describe('AAS-9: error handling', () => {
  test('AAS-9-1: unknown case returns HTTP 404', async () => {
    const inv = await makeInvestigation(G15);
    const res = await getAssistance(BOGUS, inv.investigation_id);
    expect(res.status).toBe(404);
  });

  test('AAS-9-2: unknown case returns error_code CASE_NOT_FOUND', async () => {
    const inv = await makeInvestigation(G15);
    const res = await getAssistance(BOGUS, inv.investigation_id);
    expect(res.body.error_code).toBe('CASE_NOT_FOUND');
  });

  test('AAS-9-3: unknown case response carries error string', async () => {
    const inv = await makeInvestigation(G15);
    const res = await getAssistance(BOGUS, inv.investigation_id);
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);
  });

  test('AAS-9-4: unknown case response carries status_code 404', async () => {
    const inv = await makeInvestigation(G15);
    const res = await getAssistance(BOGUS, inv.investigation_id);
    expect(res.body.status_code).toBe(404);
  });

  test('AAS-9-5: unknown investigation ID returns HTTP 404', async () => {
    const res = await getAssistance(G15, 'no-such-investigation-uuid-aas');
    expect(res.status).toBe(404);
  });

  test('AAS-9-6: unknown investigation ID returns error_code INVESTIGATION_NOT_FOUND', async () => {
    const res = await getAssistance(G15, 'no-such-investigation-uuid-aas');
    expect(res.body.error_code).toBe('INVESTIGATION_NOT_FOUND');
  });

  test('AAS-9-7: unknown investigation response carries status_code 404', async () => {
    const res = await getAssistance(G15, 'no-such-investigation-uuid-aas');
    expect(res.body.status_code).toBe(404);
  });

  test('AAS-9-8: cross-case investigation returns HTTP 404', async () => {
    // Create investigation under TCA, then attempt to read it under G15.
    const tcaInv = await makeInvestigation(TCA);
    const res    = await getAssistance(G15, tcaInv.investigation_id);
    expect(res.status).toBe(404);
  });

  test('AAS-9-9: cross-case investigation returns error_code INVESTIGATION_NOT_FOUND', async () => {
    const tcaInv = await makeInvestigation(TCA);
    const res    = await getAssistance(G15, tcaInv.investigation_id);
    expect(res.body.error_code).toBe('INVESTIGATION_NOT_FOUND');
  });

  test('AAS-9-10: cross-case investigation response carries status_code 404', async () => {
    const tcaInv = await makeInvestigation(TCA);
    const res    = await getAssistance(G15, tcaInv.investigation_id);
    expect(res.body.status_code).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AAS-10: Pipeline isolation
// Two investigations on the same case — one with extra observations — must
// return identical forensic content because the forensic pipeline is isolated
// from investigation state.
// ─────────────────────────────────────────────────────────────────────────────

describe('AAS-10: pipeline isolation', () => {
  test('AAS-10-1: evidence_relationships identical for two G15 investigations regardless of observation count', async () => {
    const invA = await makeInvestigation(G15);
    const resA = await getAssistance(G15, invA.investigation_id);

    const invB = await makeInvestigation(G15);
    // Add observations to invB — must not affect the forensic output.
    await addObservation(G15, invB.investigation_id, 'First observer note');
    await addObservation(G15, invB.investigation_id, 'Second observer note');
    const resB = await getAssistance(G15, invB.investigation_id);

    expect(resA.body.evidence_relationships).toEqual(resB.body.evidence_relationships);
  });

  test('AAS-10-2: limitations_explained identical for two G15 investigations', async () => {
    const invA = await makeInvestigation(G15);
    const resA = await getAssistance(G15, invA.investigation_id);

    const invB = await makeInvestigation(G15);
    await addObservation(G15, invB.investigation_id, 'Additional note');
    const resB = await getAssistance(G15, invB.investigation_id);

    expect(resA.body.limitations_explained).toEqual(resB.body.limitations_explained);
  });

  test('AAS-10-3: findings_summary identical for two G15 investigations', async () => {
    const invA = await makeInvestigation(G15);
    const resA = await getAssistance(G15, invA.investigation_id);

    const invB = await makeInvestigation(G15);
    await addObservation(G15, invB.investigation_id, 'Third note for isolation check');
    const resB = await getAssistance(G15, invB.investigation_id);

    expect(resA.body.findings_summary).toBe(resB.body.findings_summary);
  });

  test('AAS-10-4: unanswered_questions identical for two G15 investigations', async () => {
    const invA = await makeInvestigation(G15);
    const resA = await getAssistance(G15, invA.investigation_id);

    const invB = await makeInvestigation(G15);
    await addObservation(G15, invB.investigation_id, 'Note that should not alter pipeline');
    const resB = await getAssistance(G15, invB.investigation_id);

    expect(resA.body.unanswered_questions).toEqual(resB.body.unanswered_questions);
  });

  test('AAS-10-5: additional_evidence_suggestions identical for two G15 investigations', async () => {
    const invA = await makeInvestigation(G15);
    const resA = await getAssistance(G15, invA.investigation_id);

    const invB = await makeInvestigation(G15);
    await addObservation(G15, invB.investigation_id, 'Pipeline isolation observer note');
    const resB = await getAssistance(G15, invB.investigation_id);

    expect(resA.body.additional_evidence_suggestions).toEqual(resB.body.additional_evidence_suggestions);
  });
});
