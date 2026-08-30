'use strict';

// Phase 4.7 — AI Forensic Output Validation
//
// Focused tests for every prohibited behaviour listed in the Phase 4.7 spec.
// Each test targets a single rule violation.  Two passing examples from the
// spec are also verified to ensure the validator does not over-reject valid text.
//
// Invariants exercised:
//   B1  Evidence ID cited for a hypothesis does not belong to that hypothesis
//   B2  Environmental context ID cited with mechanism-confirmation language
//   B3  Reasoning asserts causal certainty when causal_attribution_established=false
//   B4  Hypothesis silently omitted from hypothesis_assessments
//   A10 Numerical probability invented (spec example: "82% probability")
//
// Fixture: real galaxy-15 data built once in beforeAll.
// Tampered objects are always deep-cloned to avoid cross-test contamination.

const { parseEvidenceCSV, buildEvidenceGraph, buildForensicAnalysis } = require('../server');
const {
  validateAnalystResponse,
  buildAnalystHeuristicNarrative,
} = require('../services/aiAnalyst');

const CASE_ID = 'galaxy-15';

let rows;
let graph;
let analysis;
let validIds;
let narrative; // heuristic narrative — canonical "known-good" base

beforeAll(async () => {
  jest.setTimeout(30_000);
  rows      = await parseEvidenceCSV(CASE_ID);
  graph     = await buildEvidenceGraph(CASE_ID, rows);
  analysis  = buildForensicAnalysis(CASE_ID, graph);
  validIds  = new Set(rows.map((r) => r.evidence_id));
  narrative = buildAnalystHeuristicNarrative(analysis);
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Return a deep clone of the heuristic narrative so mutations are isolated. */
function cloneNarrative() {
  return JSON.parse(JSON.stringify(narrative));
}

/** Return the hypothesis_assessments entry for the given id (mutates clone). */
function entryFor(clone, hypothesisId) {
  return clone.hypothesis_assessments.find((ha) => ha.hypothesis_id === hypothesisId);
}

/**
 * Return the first environmental_context evidence_id for the given hypothesis,
 * or null if none exists.
 */
function firstEnvCtxId(hypothesisId) {
  const h = graph.hypotheses.find((gh) => gh.hypothesis_id === hypothesisId);
  if (!h || !h.environmental_context || h.environmental_context.length === 0) return null;
  return h.environmental_context[0].evidence_id;
}

/**
 * Return the first evidence_id from *any* evidence list for the given
 * hypothesis, or null if the hypothesis has no evidence at all.
 */
function firstAnyEvidenceId(hypothesisId) {
  const LISTS = ['environmental_context', 'supporting_evidence', 'contradicting_evidence', 'non_discriminating_evidence'];
  const h = graph.hypotheses.find((gh) => gh.hypothesis_id === hypothesisId);
  if (!h) return null;
  for (const list of LISTS) {
    if (h[list] && h[list].length > 0) return h[list][0].evidence_id;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sanity — baseline heuristic narrative passes the full B1–B4 validator
// ─────────────────────────────────────────────────────────────────────────────
test('BASELINE: heuristic narrative passes validateAnalystResponse with graph (B1–B4 active)', () => {
  const { valid, errors } = validateAnalystResponse(narrative, analysis, validIds, graph);
  expect(valid).toBe(true);
  expect(errors).toHaveLength(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// B1 — Evidence ID valid in dataset but does not belong to cited hypothesis
// ─────────────────────────────────────────────────────────────────────────────

test('T-B1-1: B1 fires when a valid evidence_id from H2 is cited in H3', () => {
  // H2 has environmental_context records (EP8/MAG).
  // H3 has its own supporting evidence.
  // Injecting an H2 ID into H3 must trigger B1.
  const h2EnvId = firstEnvCtxId('H2');
  expect(h2EnvId).not.toBeNull(); // guard: H2 must have env-ctx evidence

  const clone = cloneNarrative();
  const h3Entry = entryFor(clone, 'H3');
  h3Entry.evidence_ids.push(h2EnvId);

  const { valid, errors } = validateAnalystResponse(clone, analysis, validIds, graph);
  expect(valid).toBe(false);
  expect(errors.some((e) => e.includes('B1') && e.includes(h2EnvId))).toBe(true);
});

test('T-B1-2: B1 fires when an H2 env-ctx evidence_id is cited in H3', () => {
  // H2 has many EP8/MAG environmental context records.  H3 has none of them.
  // Injecting an H2 env-ctx ID into H3's evidence_ids must trigger B1.
  const h2EnvId = firstEnvCtxId('H2');
  expect(h2EnvId).not.toBeNull();

  // Guard: confirm this ID is not in H3's evidence lists
  const h3 = graph.hypotheses.find((h) => h.hypothesis_id === 'H3');
  const LISTS = ['environmental_context', 'supporting_evidence', 'contradicting_evidence', 'non_discriminating_evidence'];
  const h3Ids = new Set(LISTS.flatMap((l) => (h3[l] || []).map((r) => r.evidence_id)));
  expect(h3Ids.has(h2EnvId)).toBe(false); // guard: must not belong to H3

  const clone = cloneNarrative();
  const h3Entry = entryFor(clone, 'H3');
  h3Entry.evidence_ids.push(h2EnvId);

  const { valid, errors } = validateAnalystResponse(clone, analysis, validIds, graph);
  expect(valid).toBe(false);
  expect(errors.some((e) => e.includes('B1') && e.includes(h2EnvId))).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// B2 — Environmental context ID cited with mechanism-confirmation language
// ─────────────────────────────────────────────────────────────────────────────

test('T-B2-1: B2 fires for "The EP8 readings prove an SEU occurred" (spec failing example)', () => {
  // H2 has EP8 environmental context records.
  const h2EnvId = firstEnvCtxId('H2');
  expect(h2EnvId).not.toBeNull();

  const clone = cloneNarrative();
  const h2Entry = entryFor(clone, 'H2');

  // Ensure the env-ctx ID is cited in H2's evidence_ids
  if (!h2Entry.evidence_ids.includes(h2EnvId)) {
    h2Entry.evidence_ids.push(h2EnvId);
  }
  h2Entry.reasoning = 'The EP8 readings prove an SEU occurred.';

  const { valid, errors } = validateAnalystResponse(clone, analysis, validIds, graph);
  expect(valid).toBe(false);
  expect(errors.some((e) => e.includes('B2'))).toBe(true);
});

test('T-B2-2: B2 fires for "confirms a mechanism" language in H2 reasoning', () => {
  // "confirms a mechanism" is in MECHANISM_CONFIRMATION_PHRASES — B2 must fire
  // when an env-ctx ID is cited alongside this language.
  const h2EnvId = firstEnvCtxId('H2');
  expect(h2EnvId).not.toBeNull();

  const clone = cloneNarrative();
  const h2Entry = entryFor(clone, 'H2');
  if (!h2Entry.evidence_ids.includes(h2EnvId)) {
    h2Entry.evidence_ids.push(h2EnvId);
  }
  h2Entry.reasoning = `The magnetometer data confirms a mechanism for the SEU event in the command processor.`;

  const { valid, errors } = validateAnalystResponse(clone, analysis, validIds, graph);
  expect(valid).toBe(false);
  expect(errors.some((e) => e.includes('B2'))).toBe(true);
});

test('T-B2-3: B2 fires for "voltage spike" claimed in H1 reasoning (nonexistent telemetry)', () => {
  // H1 has EP8 environmental context. "voltage spike" is mechanism-confirmation
  // language — no such evidence exists in the dataset.
  const h1EnvId = firstEnvCtxId('H1');
  expect(h1EnvId).not.toBeNull();

  const clone = cloneNarrative();
  const h1Entry = entryFor(clone, 'H1');
  if (!h1Entry.evidence_ids.includes(h1EnvId)) {
    h1Entry.evidence_ids.push(h1EnvId);
  }
  h1Entry.reasoning = 'The command receiver experienced a voltage spike consistent with H1.';

  const { valid, errors } = validateAnalystResponse(clone, analysis, validIds, graph);
  expect(valid).toBe(false);
  expect(errors.some((e) => e.includes('B2'))).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// B3 — Reasoning asserts causal certainty when causal_attribution_established
//       is false (spec failing example: "The solar storm caused the failure.")
// ─────────────────────────────────────────────────────────────────────────────

test('T-B3-1: B3 fires for "caused the failure" phrasing when causal_attribution is false', () => {
  // Spec failing example: "The solar storm caused the failure."
  // The phrase "caused the failure" is in CAUSAL_CERTAINTY_PHRASES.
  // Galaxy-15 has causal_attribution_established: false — B3 must fire.
  expect(analysis.causal_attribution_established).toBe(false);

  const clone = cloneNarrative();
  const h1Entry = entryFor(clone, 'H1');
  h1Entry.reasoning = 'The solar storm caused the failure.';

  const { valid, errors } = validateAnalystResponse(clone, analysis, validIds, graph);
  expect(valid).toBe(false);
  // B3 fires because reasoning contradicts causal_attribution_established=false
  // A8 also fires for the same phrase (both checks apply to reasoning text)
  expect(errors.some((e) => e.includes('B3'))).toBe(true);
});

test('T-B3-2: B3 fires for "definitively caused" in hypothesis reasoning', () => {
  expect(analysis.causal_attribution_established).toBe(false);

  const clone = cloneNarrative();
  const h2Entry = entryFor(clone, 'H2');
  h2Entry.reasoning = 'The SEU definitively caused the loss of command reception.';

  const { valid, errors } = validateAnalystResponse(clone, analysis, validIds, graph);
  expect(valid).toBe(false);
  expect(errors.some((e) => e.includes('B3') || e.includes('A8'))).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// B4 — Hypothesis silently omitted from hypothesis_assessments
// ─────────────────────────────────────────────────────────────────────────────

test('T-B4-1: B4 fires when H2 is removed from hypothesis_assessments', () => {
  const clone = cloneNarrative();
  clone.hypothesis_assessments = clone.hypothesis_assessments.filter(
    (ha) => ha.hypothesis_id !== 'H2',
  );

  const { valid, errors } = validateAnalystResponse(clone, analysis, validIds, graph);
  expect(valid).toBe(false);
  expect(errors.some((e) => e.includes('B4') && e.includes('H2'))).toBe(true);
});

test('T-B4-2: B4 fires when H2 is replaced by a duplicate H1 entry', () => {
  const clone = cloneNarrative();
  // Replace the H2 entry with a copy of H1 (wrong id)
  const h1Entry = JSON.parse(JSON.stringify(entryFor(clone, 'H1')));
  clone.hypothesis_assessments = clone.hypothesis_assessments.map((ha) =>
    ha.hypothesis_id === 'H2' ? h1Entry : ha,
  );

  const { valid, errors } = validateAnalystResponse(clone, analysis, validIds, graph);
  expect(valid).toBe(false);
  // A4 fires because "H1" appears twice (the second occurrence has an id already
  // seen, or is unknown from A4's perspective as a duplicate).
  // B4 fires because H2 is now absent from the seen set.
  expect(errors.some((e) => e.includes('B4') && e.includes('H2'))).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// A10 — Numerical probability invented (spec failing example: "82% probability")
// ─────────────────────────────────────────────────────────────────────────────

test('T-B0-PROB: A10 fires for "H2 has an 82% probability" in reasoning', () => {
  const clone = cloneNarrative();
  const h2Entry = entryFor(clone, 'H2');
  h2Entry.reasoning = 'H2 has an 82% probability of being the root cause.';

  const { valid, errors } = validateAnalystResponse(clone, analysis, validIds, graph);
  expect(valid).toBe(false);
  expect(errors.some((e) => e.includes('A10'))).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Passing examples — spec-mandated phrases that MUST NOT be rejected
// ─────────────────────────────────────────────────────────────────────────────

test('T-PASS-1: valid environmental context phrasing passes validation', () => {
  // Spec example:
  // "The contemporaneous EP8 observations establish environmental context
  //  consistent with an energetic-particle environment, but they do not confirm
  //  that an SEU occurred."
  const clone = cloneNarrative();
  const h2Entry = entryFor(clone, 'H2');
  h2Entry.reasoning =
    'The contemporaneous EP8 observations establish environmental context ' +
    'consistent with an energetic-particle environment, but they do not confirm ' +
    'that an SEU occurred.';

  const { valid, errors } = validateAnalystResponse(clone, analysis, validIds, graph);
  expect(valid).toBe(true);
  expect(errors).toHaveLength(0);
});

test('T-PASS-2: valid supported-hypothesis phrasing passes validation', () => {
  // Spec example:
  // "H3 is supported by the observed command unresponsiveness, although the
  //  available evidence does not establish the underlying physical mechanism."
  const clone = cloneNarrative();
  const h3Entry = entryFor(clone, 'H3');
  h3Entry.reasoning =
    'H3 is supported by the observed command unresponsiveness, although the ' +
    'available evidence does not establish the underlying physical mechanism.';

  const { valid, errors } = validateAnalystResponse(clone, analysis, validIds, graph);
  expect(valid).toBe(true);
  expect(errors).toHaveLength(0);
});
