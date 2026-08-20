'use strict';

const { parseEvidenceCSV } = require('../server');
const {
  generateHypothesesPass,
  redTeamChallengePass,
  validatePass1Response,
  validatePass2Response,
  buildEvidenceSnapshot,
} = require('../services/aiEngine');

const CASE_ID = 'galaxy-15';

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture — real galaxy-15 CSV, loaded once.
// No WATSONX_AI_APIKEY is set in the test environment so every call exercises
// the heuristic fallback path (source === 'heuristic').
// ─────────────────────────────────────────────────────────────────────────────
let rows;
let pass1Result;
let topHypothesis;
let pass2Result;

beforeAll(async () => {
  rows         = await parseEvidenceCSV(CASE_ID);
  pass1Result  = await generateHypothesesPass(rows);
  topHypothesis = pass1Result.hypotheses[0];
  pass2Result  = await redTeamChallengePass(topHypothesis, rows);
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// T-AI-1: Valid evidence references
// Every evidence_id cited in every claim must exist in the parsed CSV.
// ─────────────────────────────────────────────────────────────────────────────
test('T-AI-1: heuristic Pass 1 claims cite only valid evidence_ids from the CSV', () => {
  const validIds = new Set(rows.map((r) => r.evidence_id));

  for (const h of pass1Result.hypotheses) {
    for (const c of h.claims) {
      for (const eid of c.evidence_ids) {
        expect(validIds.has(eid)).toBe(true);
        if (!validIds.has(eid)) {
          throw new Error(`Hypothesis ${h.hypothesis_id} Claim ${c.claim_id}: hallucinated evidence_id "${eid}"`);
        }
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T-AI-2: Hallucinated evidence ID rejection
// validatePass1Response must reject a parsed object that contains an
// evidence_id not in the allowed set.
// ─────────────────────────────────────────────────────────────────────────────
test('T-AI-2: validatePass1Response rejects a hallucinated evidence_id', () => {
  const validIds = new Set(rows.map((r) => r.evidence_id));

  // E-G15-9999 does not exist in the 278-record set
  const fakeResponse = {
    hypotheses: [
      {
        hypothesis_id  : 'surface_charging_esd',
        label          : 'Surface Charging / ESD',
        assessment     : 'supported',
        claims         : [
          {
            claim_id    : 'FAKE-C1',
            statement   : 'Elevated electron flux observed.',
            evidence_ids: ['E-G15-0001', 'E-G15-9999'],  // 9999 is hallucinated
            relationship: 'supports',
            reasoning   : 'High flux environment is consistent with charging.',
            uncertainty : 'inferred',
          },
        ],
        missing_evidence: [],
        limitations     : ['Proxy measurement only.'],
      },
    ],
  };

  const { valid, errors } = validatePass1Response(fakeResponse, validIds);

  expect(valid).toBe(false);
  expect(errors.some((e) => e.includes('E-G15-9999'))).toBe(true);
  expect(errors.some((e) => e.includes('hallucinated'))).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// T-AI-3: Insufficient evidence when EP8 rows are absent
// When the evidence stream contains no electron flux data, at least one
// hypothesis must carry assessment: "insufficient_evidence".
// ─────────────────────────────────────────────────────────────────────────────
test('T-AI-3: insufficient_evidence assessment when EP8 rows are absent', async () => {
  const noEp8Rows = rows.filter((r) => r.source !== 'GOES11_EP8');
  const result    = await generateHypothesesPass(noEp8Rows);

  const assessments = result.hypotheses.map((h) => h.assessment);
  expect(assessments).toContain('insufficient_evidence');
});

// ─────────────────────────────────────────────────────────────────────────────
// T-AI-4: Counter-evidence schema — Pass 2 heuristic output has challenges array
// ─────────────────────────────────────────────────────────────────────────────
test('T-AI-4: Pass 2 heuristic output has a challenges array with required fields', () => {
  expect(Array.isArray(pass2Result.challenges)).toBe(true);
  expect(pass2Result.challenges.length).toBeGreaterThan(0);

  for (const ch of pass2Result.challenges) {
    expect(typeof ch.claim_id).toBe('string');
    expect(typeof ch.challenge).toBe('string');
    expect(Array.isArray(ch.counter_evidence_ids)).toBe(true);
    expect(Array.isArray(ch.missing_evidence)).toBe(true);
    expect(typeof ch.severity).toBe('string');
    expect(typeof ch.revised_assessment).toBe('string');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T-AI-5: Uncertainty labels — every heuristic claim has uncertainty: "inferred"
// or a valid vocabulary value (not an arbitrary string)
// ─────────────────────────────────────────────────────────────────────────────
test('T-AI-5: every heuristic claim has a valid uncertainty label', () => {
  const VALID_UNCERTAINTIES = new Set(['observed', 'inferred', 'unknown']);

  for (const h of pass1Result.hypotheses) {
    for (const c of h.claims) {
      expect(VALID_UNCERTAINTIES.has(c.uncertainty)).toBe(true);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T-AI-6: Red-team claim-level challenges — each challenge has required fields
// ─────────────────────────────────────────────────────────────────────────────
test('T-AI-6: red-team challenges have claim_id, challenge, severity, revised_assessment', () => {
  for (const ch of pass2Result.challenges) {
    expect(ch.claim_id.length).toBeGreaterThan(0);
    expect(ch.challenge.length).toBeGreaterThan(0);
    expect(['high', 'medium', 'low']).toContain(ch.severity);
    expect(ch.revised_assessment.length).toBeGreaterThan(0);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T-AI-7: No causal-certainty language — validatePass1Response rejects it
// ─────────────────────────────────────────────────────────────────────────────
test('T-AI-7: validatePass1Response rejects causal-certainty language in claims', () => {
  const validIds = new Set(rows.map((r) => r.evidence_id));

  const causalResponse = {
    hypotheses: [
      {
        hypothesis_id  : 'surface_charging_esd',
        label          : 'Surface Charging / ESD',
        assessment     : 'supported',
        claims         : [
          {
            claim_id    : 'C1',
            statement   : 'This proves that ESD is caused by the electron flux spike.',
            evidence_ids: [],
            relationship: 'supports',
            reasoning   : 'The evidence definitively caused the anomaly via surface charging.',
            uncertainty : 'observed',
          },
        ],
        missing_evidence: [],
        limitations     : [],
      },
    ],
  };

  const { valid, errors } = validatePass1Response(causalResponse, validIds);

  expect(valid).toBe(false);
  expect(errors.some((e) => e.includes('causal-certainty'))).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// T-AI-8: Schema completeness — Pass 1 hypotheses carry all required fields
// ─────────────────────────────────────────────────────────────────────────────
test('T-AI-8: Pass 1 hypotheses carry hypothesis_id, label, assessment, claims, missing_evidence, limitations', () => {
  expect(pass1Result.hypotheses.length).toBeGreaterThan(0);

  for (const h of pass1Result.hypotheses) {
    expect(typeof h.hypothesis_id).toBe('string');
    expect(h.hypothesis_id.length).toBeGreaterThan(0);
    expect(typeof h.label).toBe('string');
    expect(h.label.length).toBeGreaterThan(0);
    expect(typeof h.assessment).toBe('string');
    expect(h.assessment.length).toBeGreaterThan(0);
    expect(Array.isArray(h.claims)).toBe(true);
    expect(Array.isArray(h.missing_evidence)).toBe(true);
    expect(Array.isArray(h.limitations)).toBe(true);
    expect(h.limitations.length).toBeGreaterThan(0);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T-AI-9: source label — heuristic path returns source: "heuristic"
// (No WATSONX_AI_APIKEY in test env, so both passes must use heuristic)
// ─────────────────────────────────────────────────────────────────────────────
test('T-AI-9: heuristic path returns source "heuristic" for both passes', () => {
  // Guard: confirm no API key is set in the test environment
  expect(process.env.WATSONX_AI_APIKEY).toBeFalsy();

  expect(pass1Result.source).toBe('heuristic');
  expect(pass2Result.source).toBe('heuristic');
});

// ─────────────────────────────────────────────────────────────────────────────
// T-AI-10: validatePass2Response rejects hallucinated counter_evidence_ids
// ─────────────────────────────────────────────────────────────────────────────
test('T-AI-10: validatePass2Response rejects a hallucinated counter_evidence_id', () => {
  const validIds = new Set(rows.map((r) => r.evidence_id));

  const fakeChallenge = {
    challenges: [
      {
        claim_id           : 'ESD-C1',
        challenge          : 'The flux measurement is a proxy.',
        counter_evidence_ids: ['E-G15-0001', 'E-G15-FAKE'],  // FAKE is hallucinated
        missing_evidence   : ['Onboard sensor data'],
        severity           : 'high',
        revised_assessment : 'Should be non_discriminating.',
      },
    ],
    red_team_summary: 'Overall challenge summary.',
  };

  const { valid, errors } = validatePass2Response(fakeChallenge, validIds);

  expect(valid).toBe(false);
  expect(errors.some((e) => e.includes('E-G15-FAKE'))).toBe(true);
  expect(errors.some((e) => e.includes('hallucinated'))).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// T-AI-11: buildEvidenceSnapshot produces an evidence_index with only valid IDs
// ─────────────────────────────────────────────────────────────────────────────
test('T-AI-11: buildEvidenceSnapshot evidence_index contains only valid evidence_ids', () => {
  const validIds = new Set(rows.map((r) => r.evidence_id));
  const snapshot = buildEvidenceSnapshot(rows, CASE_ID);

  expect(Array.isArray(snapshot.evidence_index)).toBe(true);
  expect(snapshot.evidence_index.length).toBeGreaterThan(0);
  expect(snapshot.evidence_index.length).toBeLessThanOrEqual(150);

  for (const entry of snapshot.evidence_index) {
    expect(validIds.has(entry.evidence_id)).toBe(true);
    expect(typeof entry.timestamp).toBe('string');
    expect(typeof entry.source).toBe('string');
    expect(typeof entry.measurement).toBe('string');
    expect(typeof entry.value).toBe('number');
    expect(typeof entry.unit).toBe('string');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T-AI-12: CASE anchor rows are always included in the evidence_index
// ─────────────────────────────────────────────────────────────────────────────
test('T-AI-12: CASE anchor rows are unconditionally included in the evidence_index', () => {
  const snapshot   = buildEvidenceSnapshot(rows, CASE_ID);
  const caseInRows = rows.filter((r) => r.source === 'CASE').map((r) => r.evidence_id);
  const idxIds     = new Set(snapshot.evidence_index.map((e) => e.evidence_id));

  for (const id of caseInRows) {
    expect(idxIds.has(id)).toBe(true);
  }
});
