'use strict';

/**
 * Phase 5.6 — Causal-certainty language validation regression tests.
 *
 * Tests both the PROHIBITED forms (must trigger A8/B3) and the ALLOWED forms
 * (must NOT trigger A8/B3) from the Phase 5.6 specification.
 *
 * PROHIBITED examples tested:
 *   CC-P-1   "X caused the anomaly"
 *   CC-P-2   "X directly caused the failure"
 *   CC-P-3   "the anomaly was caused by X"
 *   CC-P-4   passive "has been caused by"
 *   CC-P-5   "was the cause of"
 *   CC-P-6   "resulted in the failure"
 *   CC-P-7   "led to the anomaly"
 *   CC-P-8   "triggered the failure"
 *   CC-P-9   "proves" (original phrase list)
 *   CC-P-10  "definitively caused" (original phrase list)
 *
 * ALLOWED examples tested:
 *   CC-A-1   "The evidence does not establish that X caused the anomaly."
 *   CC-A-2   "Causality cannot be established from the available data."
 *   CC-A-3   "X is a possible explanation but remains unconfirmed."
 *   CC-A-4   "was not caused by"
 *   CC-A-5   "does not establish that X caused"
 *   CC-A-6   "cannot be caused by"
 *   CC-A-7   Spec pass example: "does not confirm that an SEU occurred"
 *   CC-A-8   Spec pass example: "does not establish the underlying physical mechanism"
 *
 * All tests call validateAnalystResponse on a real galaxy-15 fixture so the
 * full A8/B3 production path is exercised — not a unit test of a helper.
 */

const { parseEvidenceCSV, buildEvidenceGraph, buildForensicAnalysis } = require('../server');
const {
  validateAnalystResponse,
  buildAnalystHeuristicNarrative,
} = require('../services/aiAnalyst');

const CASE_ID = 'galaxy-15';

let analysis;
let validIds;
let graph;
let narrative;

beforeAll(async () => {
  const rows  = await parseEvidenceCSV(CASE_ID);
  graph       = await buildEvidenceGraph(CASE_ID, rows);
  analysis    = buildForensicAnalysis(CASE_ID, graph);
  validIds    = new Set(rows.map((r) => r.evidence_id));
  narrative   = buildAnalystHeuristicNarrative(analysis);

  // Guard: baseline must be valid so tampered clones are isolated failures
  const { valid } = validateAnalystResponse(narrative, analysis, validIds, graph);
  expect(valid).toBe(true);
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────────

/** Deep-clone the baseline narrative and inject text into executive_summary. */
function withSummary(text) {
  const clone = JSON.parse(JSON.stringify(narrative));
  clone.executive_summary = text;
  return clone;
}

/** Deep-clone and inject text into H1 hypothesis reasoning. */
function withReasoning(text) {
  const clone = JSON.parse(JSON.stringify(narrative));
  const h1 = clone.hypothesis_assessments.find((ha) => ha.hypothesis_id === 'H1');
  h1.reasoning = text;
  return clone;
}

function assertProhibited(parsed, expectedRule) {
  const { valid, errors } = validateAnalystResponse(parsed, analysis, validIds, graph);
  expect(valid).toBe(false);
  if (expectedRule) {
    expect(errors.some((e) => e.includes(expectedRule))).toBe(true);
  }
}

function assertAllowed(parsed) {
  const { valid, errors } = validateAnalystResponse(parsed, analysis, validIds, graph);
  expect(valid).toBe(true);
  expect(errors).toHaveLength(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// PROHIBITED forms — each must trigger A8 in executive_summary
// and A8/B3 when in hypothesis reasoning
// ─────────────────────────────────────────────────────────────────────────────

test('CC-P-1: "X caused the anomaly" in executive_summary is rejected (A8)', () => {
  assertProhibited(
    withSummary('The elevated electron flux caused the anomaly aboard Galaxy 15.'),
    'A8',
  );
});

test('CC-P-1b: "X caused the anomaly" in hypothesis reasoning is rejected (A8)', () => {
  assertProhibited(
    withReasoning('The energetic-particle environment caused the anomaly.'),
    'A8',
  );
});

test('CC-P-2: "directly caused the failure" in executive_summary is rejected (A8)', () => {
  assertProhibited(
    withSummary('The geomagnetic storm directly caused the failure of the command processor.'),
    'A8',
  );
});

test('CC-P-2b: "directly caused the loss" in reasoning is rejected (A8)', () => {
  assertProhibited(
    withReasoning('The SEU directly caused the loss of command reception.'),
    'A8',
  );
});

test('CC-P-3: "the anomaly was caused by X" (passive) in executive_summary is rejected (A8)', () => {
  assertProhibited(
    withSummary('The anomaly was caused by elevated energetic particle flux near GEO.'),
    'A8',
  );
});

test('CC-P-3b: "was caused by" in reasoning is rejected (A8)', () => {
  assertProhibited(
    withReasoning('The command processor reset was caused by an SEU in the register bank.'),
    'A8',
  );
});

test('CC-P-4: "has been caused by" (perfect passive) in executive_summary is rejected (A8)', () => {
  assertProhibited(
    withSummary('The anomaly has been caused by an internal discharge event.'),
    'A8',
  );
});

test('CC-P-5: "was the cause of" in executive_summary is rejected (A8)', () => {
  assertProhibited(
    withSummary('The electron flux environment was the cause of the Galaxy 15 anomaly.'),
    'A8',
  );
});

test('CC-P-6: "resulted in the failure" in executive_summary is rejected (A8)', () => {
  assertProhibited(
    withSummary('The solar energetic particle event resulted in the failure of the command link.'),
    'A8',
  );
});

test('CC-P-7: "led to the anomaly" in executive_summary is rejected (A8)', () => {
  assertProhibited(
    withSummary('The disturbed geomagnetic conditions led to the anomaly on 2010-04-05.'),
    'A8',
  );
});

test('CC-P-8: "triggered the failure" in executive_summary is rejected (A8)', () => {
  assertProhibited(
    withSummary('An SEU in the command receiver triggered the failure.'),
    'A8',
  );
});

test('CC-P-9: "proves" in executive_summary is rejected (A8 — original phrase list)', () => {
  assertProhibited(
    withSummary('The EP8 data proves that surface charging produced the anomaly.'),
    'A8',
  );
});

test('CC-P-10: "definitively caused" in executive_summary is rejected (A8 — original phrase list)', () => {
  assertProhibited(
    withSummary('The particle flux definitively caused the loss of ground commands.'),
    'A8',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// ALLOWED forms — each must pass validation without triggering A8 or B3
// ─────────────────────────────────────────────────────────────────────────────

test('CC-A-1: "does not establish that X caused the anomaly" is accepted', () => {
  assertAllowed(
    withSummary(
      'The evidence does not establish that elevated electron flux caused the anomaly.',
    ),
  );
});

test('CC-A-2: "Causality cannot be established from the available data" is accepted', () => {
  assertAllowed(
    withSummary('Causality cannot be established from the available data.'),
  );
});

test('CC-A-3: "possible explanation but remains unconfirmed" is accepted', () => {
  assertAllowed(
    withSummary(
      'An SEU in the command receiver is a possible explanation but remains unconfirmed.',
    ),
  );
});

test('CC-A-4: "was not caused by" (explicit negation) is accepted', () => {
  assertAllowed(
    withSummary(
      'The anomaly was not caused by a mechanical failure of the attitude control system.',
    ),
  );
});

test('CC-A-5: "does not establish that X caused" is accepted', () => {
  assertAllowed(
    withReasoning(
      'The available evidence does not establish that surface charging caused the anomaly.',
    ),
  );
});

test('CC-A-6: "cannot be caused by" is accepted', () => {
  assertAllowed(
    withSummary(
      'A loss of attitude control cannot be caused by the observed electron flux alone.',
    ),
  );
});

test('CC-A-7: spec pass example — "does not confirm that an SEU occurred" is accepted', () => {
  assertAllowed(
    withReasoning(
      'The contemporaneous EP8 observations establish environmental context ' +
      'consistent with an energetic-particle environment, but they do not confirm ' +
      'that an SEU occurred.',
    ),
  );
});

test('CC-A-8: spec pass example — "does not establish the underlying physical mechanism" is accepted', () => {
  assertAllowed(
    withReasoning(
      'H3 is supported by the observed command unresponsiveness, although the ' +
      'available evidence does not establish the underlying physical mechanism.',
    ),
  );
});

test('CC-A-9: "causal attribution has not been established" is accepted', () => {
  assertAllowed(
    withSummary(
      'Causal attribution has not been established from the available evidence.',
    ),
  );
});

test('CC-A-10: "could not have caused" is accepted', () => {
  assertAllowed(
    withSummary(
      'A mechanical failure could not have caused this pattern of anomalous behavior.',
    ),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Determinism — same input produces same result on repeated calls
// ─────────────────────────────────────────────────────────────────────────────

test('CC-DET-1: containsCausalCertainty is deterministic — prohibited form', () => {
  const text = 'The electron flux caused the anomaly.';
  const parsed1 = withSummary(text);
  const parsed2 = withSummary(text);
  const r1 = validateAnalystResponse(parsed1, analysis, validIds, graph);
  const r2 = validateAnalystResponse(parsed2, analysis, validIds, graph);
  expect(r1.valid).toBe(r2.valid);
  expect(r1.errors).toEqual(r2.errors);
});

test('CC-DET-2: containsCausalCertainty is deterministic — allowed form', () => {
  const text = 'The evidence does not establish that the electron flux caused the anomaly.';
  const parsed1 = withSummary(text);
  const parsed2 = withSummary(text);
  const r1 = validateAnalystResponse(parsed1, analysis, validIds, graph);
  const r2 = validateAnalystResponse(parsed2, analysis, validIds, graph);
  expect(r1.valid).toBe(r2.valid);
  expect(r1.errors).toEqual(r2.errors);
});
