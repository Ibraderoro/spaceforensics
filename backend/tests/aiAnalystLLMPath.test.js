'use strict';

/**
 * Phase 5.5 — Controlled LLM-path tests for generateAnalystNarrative.
 *
 * These tests exercise the LLM execution branch of generateAnalystNarrative
 * without a real Watsonx API key by injecting a mock LLM factory via the
 * optional _llmFactory parameter.
 *
 * The full production validation path (validateAnalystResponse A1–A10 + B1–B4)
 * runs unchanged on every response the mock returns.  No validator rule is
 * bypassed.
 *
 * Tests:
 *   LLM-1  valid LLM response is accepted and returned with source:"llm"
 *   LLM-2  LLM response with unknown evidence_id is rejected (A6 → heuristic fallback)
 *   LLM-3  LLM response with changed hypothesis assessment is rejected (A5 → fallback)
 *   LLM-4  LLM response with causal certainty claim is rejected (A8 → fallback)
 *   LLM-5  environmental evidence incorrectly framed as mechanism is rejected (B2 → fallback)
 *   LLM-6  malformed (non-JSON) LLM response is rejected (parse error → fallback)
 *   LLM-7  LLM exception causes heuristic fallback
 *   LLM-8  LLM receives the validated analysis object, not raw evidence rows
 */

const { parseEvidenceCSV, buildEvidenceGraph, buildForensicAnalysis } = require('../server');
const {
  generateAnalystNarrative,
  validateAnalystResponse,
  buildAnalystHeuristicNarrative,
} = require('../services/aiAnalyst');

const CASE_ID = 'galaxy-15';

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture — real galaxy-15 pipeline, built once for the whole suite.
// ─────────────────────────────────────────────────────────────────────────────
let rows;
let graph;
let analysis;
let validIds;
let baseNarrative;   // heuristic output used as the "good LLM template"

beforeAll(async () => {
  rows         = await parseEvidenceCSV(CASE_ID);
  graph        = await buildEvidenceGraph(CASE_ID, rows);
  analysis     = buildForensicAnalysis(CASE_ID, graph);
  validIds     = new Set(rows.map((r) => r.evidence_id));
  baseNarrative = buildAnalystHeuristicNarrative(analysis);

  // Paranoia check: the heuristic output must itself be valid — it is the
  // template for all LLM-path mock responses.
  const { valid } = validateAnalystResponse(baseNarrative, analysis, validIds, graph);
  expect(valid).toBe(true);
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a mock LLM factory that makes a client whose .invoke() returns the
 * given text as the response content.  The text is treated by the production
 * code exactly as a real Watsonx response — it goes through JSON.parse and
 * then validateAnalystResponse before being accepted.
 */
function makeMockLLM(responseContent) {
  return () => ({
    invoke: async () => ({ content: responseContent }),
  });
}

/**
 * Deep-clone the base heuristic narrative so each test gets an independent
 * object to tamper with.
 */
function cloneBase() {
  return JSON.parse(JSON.stringify(baseNarrative));
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM-1 — Valid LLM response is accepted and returned with source: "llm"
// ─────────────────────────────────────────────────────────────────────────────
test('LLM-1: valid mock LLM response is accepted and returned with source "llm"', async () => {
  const goodResponse = cloneBase();
  // Ensure the response does not already carry source/generated_at so we can
  // confirm the production code stamps them on.
  delete goodResponse.source;
  delete goodResponse.generated_at;

  const narrative = await generateAnalystNarrative(
    analysis, validIds, graph,
    makeMockLLM(JSON.stringify(goodResponse)),
  );

  expect(narrative.source).toBe('llm');
  expect(typeof narrative.generated_at).toBe('string');
  expect(narrative.causal_attribution_established).toBe(false);
  expect(Array.isArray(narrative.hypothesis_assessments)).toBe(true);
  expect(narrative.hypothesis_assessments).toHaveLength(analysis.hypotheses.length);
});

// ─────────────────────────────────────────────────────────────────────────────
// LLM-2 — Unknown evidence_id → rejected (A6), falls back to heuristic
// ─────────────────────────────────────────────────────────────────────────────
test('LLM-2: LLM response with hallucinated evidence_id is rejected; heuristic fallback used', async () => {
  const tampered = cloneBase();
  tampered.hypothesis_assessments[0].evidence_ids.push('E-G15-HALLUCINATED');

  // Confirm the validator would reject this
  const { valid, errors } = validateAnalystResponse(tampered, analysis, validIds, graph);
  expect(valid).toBe(false);
  expect(errors.some((e) => e.includes('A6'))).toBe(true);

  // generateAnalystNarrative must fall back to heuristic
  const narrative = await generateAnalystNarrative(
    analysis, validIds, graph,
    makeMockLLM(JSON.stringify(tampered)),
  );

  expect(narrative.source).toBe('heuristic');
  // Heuristic output must not contain the hallucinated ID
  const text = JSON.stringify(narrative);
  expect(text).not.toContain('E-G15-HALLUCINATED');
});

// ─────────────────────────────────────────────────────────────────────────────
// LLM-3 — Changed hypothesis assessment → rejected (A5), heuristic fallback
// ─────────────────────────────────────────────────────────────────────────────
test('LLM-3: LLM response with changed hypothesis assessment is rejected; heuristic fallback used', async () => {
  const tampered = cloneBase();

  // Find any hypothesis that is not already strongly_supported and flip it
  const target = tampered.hypothesis_assessments.find(
    (ha) => ha.assessment !== 'strongly_supported',
  );
  expect(target).toBeDefined();
  const originalAssessment = target.assessment;
  target.assessment = 'strongly_supported';  // LLM unauthorised change

  const { valid, errors } = validateAnalystResponse(tampered, analysis, validIds, graph);
  expect(valid).toBe(false);
  expect(errors.some((e) => e.includes('A5') && e.includes(originalAssessment))).toBe(true);

  const narrative = await generateAnalystNarrative(
    analysis, validIds, graph,
    makeMockLLM(JSON.stringify(tampered)),
  );

  expect(narrative.source).toBe('heuristic');
  // Heuristic must preserve the correct assessment for the same hypothesis
  const heuristicEntry = narrative.hypothesis_assessments.find(
    (ha) => ha.hypothesis_id === target.hypothesis_id,
  );
  expect(heuristicEntry.assessment).toBe(originalAssessment);
});

// ─────────────────────────────────────────────────────────────────────────────
// LLM-4 — Causal certainty claim → rejected (A8), heuristic fallback
// ─────────────────────────────────────────────────────────────────────────────
test('LLM-4: LLM response with causal certainty language is rejected; heuristic fallback used', async () => {
  const tampered = cloneBase();
  tampered.executive_summary =
    'The elevated electron flux definitively caused the Galaxy 15 anomaly.';

  const { valid, errors } = validateAnalystResponse(tampered, analysis, validIds, graph);
  expect(valid).toBe(false);
  expect(errors.some((e) => e.includes('A8'))).toBe(true);

  const narrative = await generateAnalystNarrative(
    analysis, validIds, graph,
    makeMockLLM(JSON.stringify(tampered)),
  );

  expect(narrative.source).toBe('heuristic');
  // The causal-certainty phrase must not appear in the heuristic output
  expect(narrative.executive_summary).not.toMatch(/definitively caused/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// LLM-5 — Environmental context incorrectly framed as mechanism → rejected (B2)
// ─────────────────────────────────────────────────────────────────────────────
test('LLM-5: environmental evidence presented as mechanism confirmation is rejected (B2); heuristic fallback used', async () => {
  // Find a hypothesis with at least one environmental_context evidence item in the graph
  const hypothesisWithEnvCtx = graph.hypotheses.find(
    (h) => (h.environmental_context || []).length > 0,
  );
  expect(hypothesisWithEnvCtx).toBeDefined();

  const envId = hypothesisWithEnvCtx.environmental_context[0].evidence_id;
  const hid   = hypothesisWithEnvCtx.hypothesis_id;

  const tampered = cloneBase();
  const haEntry  = tampered.hypothesis_assessments.find((ha) => ha.hypothesis_id === hid);
  expect(haEntry).toBeDefined();

  // Put the env-ctx ID in evidence_ids and inject mechanism-confirmation language
  if (!haEntry.evidence_ids.includes(envId)) haEntry.evidence_ids.push(envId);
  haEntry.reasoning =
    'The electron flux confirms the failure mode — this proves the mechanism.';

  const { valid, errors } = validateAnalystResponse(tampered, analysis, validIds, graph);
  expect(valid).toBe(false);
  expect(errors.some((e) => e.includes('B2'))).toBe(true);

  const narrative = await generateAnalystNarrative(
    analysis, validIds, graph,
    makeMockLLM(JSON.stringify(tampered)),
  );

  expect(narrative.source).toBe('heuristic');
});

// ─────────────────────────────────────────────────────────────────────────────
// LLM-6 — Malformed response (non-JSON) → parse error → heuristic fallback
// ─────────────────────────────────────────────────────────────────────────────
test('LLM-6: malformed (non-JSON) LLM response falls back to heuristic', async () => {
  const narrative = await generateAnalystNarrative(
    analysis, validIds, graph,
    makeMockLLM('This is not valid JSON at all { broken'),
  );

  expect(narrative.source).toBe('heuristic');
});

// ─────────────────────────────────────────────────────────────────────────────
// LLM-7 — LLM .invoke() throws → heuristic fallback
// ─────────────────────────────────────────────────────────────────────────────
test('LLM-7: LLM invoke() exception causes heuristic fallback', async () => {
  const throwingFactory = () => ({
    invoke: async () => { throw new Error('Simulated Watsonx network error'); },
  });

  const narrative = await generateAnalystNarrative(
    analysis, validIds, graph, throwingFactory,
  );

  expect(narrative.source).toBe('heuristic');
});

// ─────────────────────────────────────────────────────────────────────────────
// LLM-8 — LLM receives the validated analysis object, not raw evidence rows
//
// The architectural rule (line 15 of aiAnalyst.js): "The LLM receives the
// deterministic ForensicAnalysis object — NOT raw CSV rows."
//
// Verified by inspecting what the mock .invoke() is called with: the messages
// must contain the serialised analysis object fields (case_id, hypotheses,
// causal_attribution_established) but must NOT contain raw evidence fields
// (value, unit, resolution) that only appear in the CSV rows.
// ─────────────────────────────────────────────────────────────────────────────
test('LLM-8: LLM prompt contains the analysis object fields but not raw CSV row fields', async () => {
  let capturedMessages = null;

  const inspectingFactory = () => ({
    invoke: async (messages) => {
      capturedMessages = messages;
      // Return a valid response so the function completes successfully
      const good = cloneBase();
      delete good.source;
      delete good.generated_at;
      return { content: JSON.stringify(good) };
    },
  });

  await generateAnalystNarrative(analysis, validIds, graph, inspectingFactory);

  expect(capturedMessages).not.toBeNull();

  // Serialise all message content for inspection
  const promptText = capturedMessages
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');

  // ── Must contain analysis-level fields ───────────────────────────────────
  expect(promptText).toContain(CASE_ID);                        // case_id
  expect(promptText).toContain('causal_attribution_established'); // analysis field
  expect(promptText).toContain('H1');                           // hypothesis_id
  expect(promptText).toContain('H5');                           // hypothesis_id
  expect(promptText).toContain('strongly_supported');           // assessment value
  expect(promptText).toContain('hypothesis_assessments');       // schema field

  // ── Must NOT contain raw CSV row-level fields ─────────────────────────────
  // Raw rows carry 'resolution', 'measurement', and 'unit' columns.
  // These should never appear in the LLM prompt.
  // (We check the user message portion specifically to avoid false matches
  //  in the system prompt template strings.)
  const userMessage = capturedMessages.find((m) => m.constructor.name === 'HumanMessage');
  expect(userMessage).toBeDefined();
  const userText = typeof userMessage.content === 'string'
    ? userMessage.content : JSON.stringify(userMessage.content);

  // The raw CSV 'resolution' field values (e.g. '5min', '1min') are numeric-prefixed
  // and would only appear if raw rows were passed.  Verify the prompt uses
  // analysis-level structure, not flat row arrays.
  expect(userText).not.toMatch(/"value"\s*:\s*[\d.-]+/);   // raw numeric value field
  expect(userText).not.toMatch(/"resolution"\s*:\s*"[^"]+min"/); // raw resolution string
});

// ─────────────────────────────────────────────────────────────────────────────
// LLM-9 — Returned source is exactly "llm" (not "heuristic") on success
// ─────────────────────────────────────────────────────────────────────────────
test('LLM-9: successful LLM path stamps source "llm" not "heuristic"', async () => {
  const good = cloneBase();
  delete good.source;
  delete good.generated_at;

  const narrative = await generateAnalystNarrative(
    analysis, validIds, graph,
    makeMockLLM(JSON.stringify(good)),
  );

  expect(narrative.source).toBe('llm');
  expect(narrative.source).not.toBe('heuristic');
});

// ─────────────────────────────────────────────────────────────────────────────
// LLM-10 — Markdown-fenced JSON response is accepted (production strips fences)
// ─────────────────────────────────────────────────────────────────────────────
test('LLM-10: LLM response wrapped in markdown code fences is accepted', async () => {
  const good = cloneBase();
  delete good.source;
  delete good.generated_at;
  const fenced = `\`\`\`json\n${JSON.stringify(good)}\n\`\`\``;

  const narrative = await generateAnalystNarrative(
    analysis, validIds, graph,
    makeMockLLM(fenced),
  );

  expect(narrative.source).toBe('llm');
});
