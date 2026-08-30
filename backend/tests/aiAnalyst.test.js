'use strict';

const { parseEvidenceCSV, buildEvidenceGraph, buildForensicAnalysis } = require('../server');
const {
  validateAnalystResponse,
  buildAnalystHeuristicNarrative,
} = require('../services/aiAnalyst');

const CASE_ID = 'galaxy-15';

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture — real galaxy-15 data, built once for the whole suite.
//
// `analysis`  — validated ForensicAnalysis (deterministic Phase 4.2 output)
// `validIds`  — Set of all 278 evidence_ids from the parsed CSV
// `narrative` — heuristic AnalystNarrative built from analysis
// ─────────────────────────────────────────────────────────────────────────────
let rows;
let graph;
let analysis;
let validIds;
let narrative;

beforeAll(async () => {
  jest.setTimeout(30_000);
  rows      = await parseEvidenceCSV(CASE_ID);
  graph     = await buildEvidenceGraph(CASE_ID, rows);
  analysis  = buildForensicAnalysis(CASE_ID, graph);
  validIds  = new Set(rows.map((r) => r.evidence_id));
  narrative = buildAnalystHeuristicNarrative(analysis);
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// T-AA-1 — Heuristic narrative has valid shape and all required top-level fields
// ─────────────────────────────────────────────────────────────────────────────
test('T-AA-1: heuristic narrative returns a valid object with all required top-level fields', () => {
  expect(typeof narrative.executive_summary).toBe('string');
  expect(narrative.executive_summary.length).toBeGreaterThan(0);

  expect(typeof narrative.event_description).toBe('string');
  expect(narrative.event_description.length).toBeGreaterThan(0);

  expect(Array.isArray(narrative.hypothesis_assessments)).toBe(true);
  expect(narrative.hypothesis_assessments.length).toBe(analysis.hypotheses.length);

  expect(Array.isArray(narrative.strongest_observations)).toBe(true);
  expect(narrative.strongest_observations.length).toBeGreaterThan(0);

  expect(Array.isArray(narrative.major_uncertainties)).toBe(true);
  expect(narrative.major_uncertainties.length).toBeGreaterThan(0);

  expect(Array.isArray(narrative.missing_evidence)).toBe(true);
  expect(narrative.missing_evidence.length).toBeGreaterThan(0);

  expect(typeof narrative.causal_attribution_established).toBe('boolean');
  expect(narrative.source).toBe('heuristic');
  expect(typeof narrative.generated_at).toBe('string');
});

// ─────────────────────────────────────────────────────────────────────────────
// T-AA-2 — Valid structured response is accepted by validateAnalystResponse
// The heuristic output is guaranteed valid — use it as the "mock LLM response".
// ─────────────────────────────────────────────────────────────────────────────
test('T-AA-2: validateAnalystResponse accepts a valid structured response', () => {
  const { valid, errors } = validateAnalystResponse(narrative, analysis, validIds);
  expect(valid).toBe(true);
  expect(errors).toHaveLength(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// T-AA-3 — Malformed response (missing required keys) is rejected
// ─────────────────────────────────────────────────────────────────────────────
test('T-AA-3: validateAnalystResponse rejects a response missing required fields', () => {
  const malformed = {
    // executive_summary intentionally omitted → A1
    event_description        : 'Event description.',
    hypothesis_assessments   : [],
    strongest_observations   : ['An observation.'],
    major_uncertainties      : ['A limitation.'],
    missing_evidence         : ['Missing measurement.'],
    causal_attribution_established: false,
  };

  const { valid, errors } = validateAnalystResponse(malformed, analysis, validIds);
  expect(valid).toBe(false);
  // A1 violation: executive_summary missing
  expect(errors.some((e) => e.includes('A1'))).toBe(true);
  // A3 violation: hypothesis_assessments empty array (wrong count)
  expect(errors.some((e) => e.includes('A3'))).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// T-AA-4 — Unknown evidence_id in hypothesis_assessments[*].evidence_ids rejected
// ─────────────────────────────────────────────────────────────────────────────
test('T-AA-4: validateAnalystResponse rejects an unknown evidence_id in hypothesis_assessments', () => {
  // Clone the heuristic narrative and inject a hallucinated ID into the first hypothesis.
  const base = buildAnalystHeuristicNarrative(analysis);
  const tampered = JSON.parse(JSON.stringify(base));  // deep clone
  tampered.hypothesis_assessments[0].evidence_ids.push('E-G15-HALLUCINATED');

  const { valid, errors } = validateAnalystResponse(tampered, analysis, validIds);
  expect(valid).toBe(false);
  expect(errors.some((e) => e.includes('E-G15-HALLUCINATED'))).toBe(true);
  expect(errors.some((e) => e.includes('A6'))).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// T-AA-5 — Assessment changed from source analysis is rejected
// The LLM must not alter any assessment value.
// ─────────────────────────────────────────────────────────────────────────────
test('T-AA-5: validateAnalystResponse rejects a changed hypothesis assessment', () => {
  const base = buildAnalystHeuristicNarrative(analysis);
  const tampered = JSON.parse(JSON.stringify(base));

  // Find a hypothesis whose current assessment is not 'strongly_supported'
  // and flip it to something different.
  const target = tampered.hypothesis_assessments.find(
    (ha) => ha.assessment !== 'strongly_supported',
  );
  expect(target).toBeDefined();
  const original = target.assessment;
  target.assessment = 'strongly_supported';  // force change

  const { valid, errors } = validateAnalystResponse(tampered, analysis, validIds);
  expect(valid).toBe(false);
  expect(errors.some((e) => e.includes('A5') && e.includes(original))).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// T-AA-6 — causal_attribution_established: true rejected when source says false
// ─────────────────────────────────────────────────────────────────────────────
test('T-AA-6: validateAnalystResponse rejects causal_attribution_established:true when source is false', () => {
  // Confirm galaxy-15 source analysis has causal_attribution_established: false.
  expect(analysis.causal_attribution_established).toBe(false);

  const base = buildAnalystHeuristicNarrative(analysis);
  const tampered = JSON.parse(JSON.stringify(base));
  tampered.causal_attribution_established = true;  // LLM overrides — must be rejected

  const { valid, errors } = validateAnalystResponse(tampered, analysis, validIds);
  expect(valid).toBe(false);
  expect(errors.some((e) => e.includes('A7'))).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// T-AA-7 — Causal-certainty / invented telemetry language rejected
// Checks both executive_summary and hypothesis reasoning fields.
// ─────────────────────────────────────────────────────────────────────────────
test('T-AA-7: validateAnalystResponse rejects causal-certainty language in free-text fields', () => {
  const base = buildAnalystHeuristicNarrative(analysis);

  // Inject causal-certainty phrase into executive_summary
  const tampered = JSON.parse(JSON.stringify(base));
  tampered.executive_summary =
    'This proves that ESD is caused by the elevated electron flux.';

  const { valid: v1, errors: e1 } = validateAnalystResponse(tampered, analysis, validIds);
  expect(v1).toBe(false);
  expect(e1.some((e) => e.includes('A8'))).toBe(true);

  // Inject causal-certainty phrase into a hypothesis reasoning field
  const tampered2 = JSON.parse(JSON.stringify(base));
  tampered2.hypothesis_assessments[0].reasoning =
    'The evidence definitively caused the anomaly via surface charging.';

  const { valid: v2, errors: e2 } = validateAnalystResponse(tampered2, analysis, validIds);
  expect(v2).toBe(false);
  expect(e2.some((e) => e.includes('A8'))).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// T-AA-8 — Numerical probability claim rejected
// ─────────────────────────────────────────────────────────────────────────────
test('T-AA-8: validateAnalystResponse rejects a numerical probability claim', () => {
  const base = buildAnalystHeuristicNarrative(analysis);

  // "70% probability" in executive_summary
  const tampered = JSON.parse(JSON.stringify(base));
  tampered.executive_summary =
    'There is a 70% probability that ESD caused the anomaly.';

  const { valid, errors } = validateAnalystResponse(tampered, analysis, validIds);
  expect(valid).toBe(false);
  expect(errors.some((e) => e.includes('A10'))).toBe(true);

  // Percentage in reasoning
  const tampered2 = JSON.parse(JSON.stringify(base));
  tampered2.hypothesis_assessments[0].reasoning =
    'H1 has a 0.75 probability of being the root cause.';

  const { valid: v2, errors: e2 } = validateAnalystResponse(tampered2, analysis, validIds);
  expect(v2).toBe(false);
  expect(e2.some((e) => e.includes('A10'))).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// T-AA-9 — source field is "heuristic" when no API key is set
// ─────────────────────────────────────────────────────────────────────────────
test('T-AA-9: heuristic narrative source is "heuristic" (no WATSONX_AI_APIKEY in test env)', () => {
  // Guard: confirm no API key in test environment.
  expect(process.env.WATSONX_AI_APIKEY).toBeFalsy();
  expect(narrative.source).toBe('heuristic');
});

// ─────────────────────────────────────────────────────────────────────────────
// T-AA-10 — Every evidence_id in the heuristic narrative exists in validIds
// ─────────────────────────────────────────────────────────────────────────────
test('T-AA-10: every evidence_id in the heuristic narrative exists in the parsed CSV', () => {
  for (const ha of narrative.hypothesis_assessments) {
    for (const eid of ha.evidence_ids) {
      expect(validIds.has(eid)).toBe(true);
    }
  }
});
