# Phase 4.6 — AI Analyst Layer Plan

## Top-Level Overview

Add an AI analyst layer that receives the **already-validated deterministic
`ForensicAnalysis` object** (output of `buildForensicAnalysis`) and returns
a strictly-validated structured explanation object.

The LLM is **not** an evidence engine. It explains and synthesises the
deterministic analysis. It may never change hypothesis assessments,
invent evidence IDs, establish causality, or remove limitations.

### Pipeline position

```
Evidence CSV
    │
    ▼
buildEvidenceGraph (server.js)
    │
    ▼
buildForensicAnalysis (forensicAnalysis.js)   ← Phase 4.2 (deterministic, validated)
    │
    ▼
generateAnalystNarrative (aiAnalyst.js)        ← Phase 4.6  ← NEW
    │  ├─ buildAnalystPrompt()
    │  ├─ LLM call (ChatWatsonx) OR heuristic fallback
    │  └─ validateAnalystResponse()
    ▼
Validated AnalystNarrative object
    │
    ▼
GET /api/cases/:id/forensic-analysis/narrative   ← NEW route
```

The deterministic object is the only input to the LLM. Raw CSV rows are
**not** sent to the LLM.

---

## Architecture Decisions

- **New file**: `backend/services/aiAnalyst.js` — keeps the analyst separate
  from the existing `aiEngine.js` (which handles Pass 1/2 hypothesis
  generation from raw rows). No changes to `aiEngine.js`.
- **Existing SDK**: reuse `buildLLMClient()` pattern from `aiEngine.js`
  (ChatWatsonx / `@langchain/ibm`). Copy the factory locally; do not
  import from `aiEngine.js`.
- **New route**: `GET /api/cases/:id/forensic-analysis/narrative` in
  `server.js`. The existing `GET /api/cases/:id/forensic-analysis` route is
  unchanged.
- **Heuristic fallback**: when no `WATSONX_AI_APIKEY` is set (or LLM
  response fails validation) the function returns a deterministically
  constructed `AnalystNarrative` built from the deterministic analysis
  object itself — no LLM needed. All mocked tests exercise the validator
  directly.

---

## Output Schema — `AnalystNarrative`

```json
{
  "executive_summary": "string",
  "event_description": "string",
  "hypothesis_assessments": [
    {
      "hypothesis_id": "string",
      "assessment": "string",
      "reasoning": "string",
      "evidence_ids": ["string"],
      "limitations": ["string"]
    }
  ],
  "strongest_observations": ["string"],
  "major_uncertainties": ["string"],
  "missing_evidence": ["string"],
  "causal_attribution_established": false,
  "source": "llm | heuristic",
  "generated_at": "ISO-8601 string"
}
```

---

## Validation Invariants — `validateAnalystResponse`

| ID  | Rule |
|-----|------|
| A1  | `executive_summary` is a non-empty string |
| A2  | `event_description` is a non-empty string |
| A3  | `hypothesis_assessments` is an array with exactly N entries (one per hypothesis in the source analysis) |
| A4  | Every `hypothesis_id` in `hypothesis_assessments` matches a hypothesis in the source analysis |
| A5  | Every `assessment` in `hypothesis_assessments` is unchanged from the source analysis |
| A6  | Every `evidence_id` in `hypothesis_assessments[*].evidence_ids` exists in `validIds` (from the source analysis) |
| A7  | `causal_attribution_established` matches the source analysis value exactly |
| A8  | No causal-certainty language in any free-text field (`executive_summary`, `event_description`, `reasoning`) |
| A9  | `strongest_observations`, `major_uncertainties`, `missing_evidence` are all non-empty arrays of strings |
| A10 | No numerical probability claims (patterns like "70%", "0.7 probability", "70 percent") in any free-text field |

---

## Sub-Tasks

---

### Sub-Task 1 — Create `backend/services/aiAnalyst.js`

**Intent**
Implement the AI analyst service as a standalone module. It has three
public exports:
- `generateAnalystNarrative(analysis, validIds)` — async; returns a
  validated `AnalystNarrative`.
- `validateAnalystResponse(parsed, sourceAnalysis, validIds)` — sync;
  returns `{ valid, errors }`. Exported for tests.
- `buildAnalystHeuristicNarrative(analysis)` — sync; pure deterministic
  fallback built from the `ForensicAnalysis` object. Exported for tests.

**Expected Outcomes**
- The module exists at `backend/services/aiAnalyst.js`.
- `generateAnalystNarrative` returns a valid `AnalystNarrative` without
  throwing when called with a real `galaxy-15` analysis object.
- `validateAnalystResponse` returns `{ valid: false, errors }` for each of
  the A1–A10 violation scenarios.
- `buildAnalystHeuristicNarrative` returns a structurally valid
  `AnalystNarrative` deterministically from any `ForensicAnalysis`.

**Todo List**
1. Create `backend/services/aiAnalyst.js` with `'use strict'` header.
2. Add `buildLLMClient()` factory (same pattern as `aiEngine.js`: reads
   `WATSONX_AI_APIKEY`, creates `ChatWatsonx` or returns `null`).
3. Add constants:
   - `CAUSAL_CERTAINTY_PHRASES` (copy from `aiEngine.js` — same set)
   - `NUMERICAL_PROBABILITY_PATTERN` — regex: `/\b\d+(\.\d+)?\s*%|\b\d+(\.\d+)?\s*(probability|chance|likelihood)/i`
4. Implement `containsCausalCertainty(text)` and
   `containsNumericalProbability(text)` helpers.
5. Implement `validateAnalystResponse(parsed, sourceAnalysis, validIds)`:
   - Enforce A1–A10 as described in the table above.
   - Collect all violations into an `errors` array; return
     `{ valid: errors.length === 0, errors }`.
6. Implement `buildAnalystHeuristicNarrative(analysis)`:
   - Build `executive_summary` from `analysis.comparison.most_supported`
     and `causal_attribution_established`.
   - Build `event_description` from `analysis.event` fields if present,
     else a generic placeholder.
   - Build `hypothesis_assessments` by iterating `analysis.hypotheses`:
     copy `hypothesis_id`, `assessment` verbatim; derive `reasoning` from
     the hypothesis `key_observations`/`limitations`; collect
     `evidence_ids` from `evidence_summary` id arrays; derive `limitations`
     as string descriptions from the hypothesis limitations list.
   - Build `strongest_observations` from `analysis.comparison` (supported
     hypotheses, most-supported label).
   - Build `major_uncertainties` from the aggregate `analysis.limitations`
     descriptions.
   - Build `missing_evidence` from `hypothesis_comparison` entries with
     `insufficient_evidence` assessment.
   - Set `causal_attribution_established` from `analysis.causal_attribution_established`.
   - Set `source: 'heuristic'`, `generated_at: new Date().toISOString()`.
7. Implement `buildAnalystPrompt(analysis)`:
   - System prompt instructs the model:
     - The `forensic_analysis` object is authoritative; do not change any
       `assessment` value.
     - `environmental_context` is not mechanism confirmation; do not call
       it supporting evidence.
     - `supporting_evidence` is the only list classified as direct support.
     - Missing telemetry must remain missing — do not invent measurements.
     - Uncertainty must be stated explicitly.
     - Causal attribution cannot be established unless
       `causal_attribution_established` is `true`.
     - Do not include numerical probabilities or percentages.
     - Only cite `evidence_id` values from the `valid_evidence_ids` array
       provided.
     - Return ONLY valid JSON matching the schema — no markdown, no prose
       outside JSON.
   - User prompt: serialised `analysis` object (the full deterministic
     object) + required output schema.
   - Include the list of all valid `evidence_ids` drawn from `validIds` so
     the model cannot hallucinate IDs.
8. Implement `generateAnalystNarrative(analysis, validIds)`:
   - Try `buildLLMClient()`; if null → heuristic.
   - Build prompt via `buildAnalystPrompt(analysis)`.
   - Call `llm.invoke([SystemMessage, HumanMessage])`.
   - Strip markdown fences; JSON-parse response.
   - Call `validateAnalystResponse(parsed, analysis, validIds)`.
   - If valid: attach `source: 'llm'`, `generated_at`, return.
   - If invalid: log errors to `stderr`, fall through to heuristic.
   - Return `buildAnalystHeuristicNarrative(analysis)` as fallback.
9. `module.exports = { generateAnalystNarrative, validateAnalystResponse, buildAnalystHeuristicNarrative }`.

**Relevant Context**
- `backend/services/aiEngine.js` — `buildLLMClient`, `containsCausalCertainty`,
  `validatePass1Response` patterns to mirror.
- `backend/services/forensicAnalysis.js` — `buildForensicAnalysis` output
  shape (lines 524–568): fields `case_id`, `hypotheses`, `comparison`,
  `hypothesis_comparison`, `limitations`, `event`, `evidence_summary`,
  `causal_attribution_established`.
- `ALLOWED_ASSESSMENTS` — same set as in `forensicAnalysis.js`.

**Status** `[x] done`

---

### Sub-Task 2 — Add `GET /api/cases/:id/forensic-analysis/narrative` route

**Intent**
Expose the analyst narrative through a new HTTP endpoint in `server.js`.
The route follows the existing plumbing pattern but adds one extra step:
it builds `validIds` from the parsed rows before calling the analyst.

**Expected Outcomes**
- `GET /api/cases/galaxy-15/forensic-analysis/narrative` returns `200`
  with a valid `AnalystNarrative` JSON object.
- `GET /api/cases/UNKNOWN/forensic-analysis/narrative` returns `404
  { "error": "Case not found" }`.
- No stack trace is ever exposed.
- All existing routes are unchanged.

**Todo List**
1. At the top of `server.js` add:
   ```js
   const aiAnalyst = require('./services/aiAnalyst');
   ```
2. After the `GET /api/cases/:id/forensic-analysis` block, add the new
   route:
   ```
   GET /api/cases/:id/forensic-analysis/narrative
     - same casePath guard → 404
     - await parseEvidenceCSV → rows
     - const validIds = new Set(rows.map(r => r.evidence_id))
     - const graph    = buildEvidenceGraph(req.params.id, rows)
     - const analysis = buildForensicAnalysis(req.params.id, graph)
     - const narrative = await aiAnalyst.generateAnalystNarrative(analysis, validIds)
     - res.json(narrative)
     - catch (err) → res.status(500).json({ error: err.message })
   ```
3. Extend `module.exports` to also expose `aiAnalyst` for tests if needed
   (optional — tests can import `aiAnalyst` directly).

**Relevant Context**
- Existing `GET /api/cases/:id/forensic-analysis` route at
  `backend/server.js:507–530` as the pattern to copy.

**Status** `[x] done`

---

### Sub-Task 3 — Write tests `backend/tests/aiAnalyst.test.js`

**Intent**
Cover the seven required validator tests plus basic integration tests using
the heuristic path (no API key in test env). All tests use direct function
calls — no HTTP client needed.

**Expected Outcomes**
`npm test -- --runInBand` passes all new tests; all 102 existing tests
continue to pass.

**Test Matrix**

| ID     | What is tested |
|--------|----------------|
| T-AA-1 | Heuristic narrative returned for galaxy-15 — valid shape, all required fields present |
| T-AA-2 | Valid mocked LLM response is accepted by `validateAnalystResponse` |
| T-AA-3 | Malformed response (missing required keys) is rejected |
| T-AA-4 | Unknown `evidence_id` in `hypothesis_assessments[*].evidence_ids` is rejected |
| T-AA-5 | Assessment changed from source analysis is rejected |
| T-AA-6 | `causal_attribution_established: true` rejected when source says `false` |
| T-AA-7 | Invented telemetry / causal-certainty language rejected in free-text fields |
| T-AA-8 | Numerical probability claim rejected (`"70% probability"`) |
| T-AA-9 | `source` field is `"heuristic"` when no API key is set |
| T-AA-10| Every `evidence_id` in heuristic narrative exists in `validIds` |

**Fixture design**
```
beforeAll (async):
  rows     = await parseEvidenceCSV('galaxy-15')
  graph    = buildEvidenceGraph('galaxy-15', rows)
  analysis = buildForensicAnalysis('galaxy-15', graph)
  validIds = new Set(rows.map(r => r.evidence_id))
  narrative = buildAnalystHeuristicNarrative(analysis)
```

For T-AA-2 through T-AA-8: construct minimal mock objects inline (same
pattern as `aiEngine.test.js` T-AI-2, T-AI-7, T-AI-10).

For T-AA-2 the "valid mocked response" is built by calling
`buildAnalystHeuristicNarrative(analysis)` to get a guaranteed-valid base,
then passing it through `validateAnalystResponse` — this verifies the
validator accepts correct output.

**Todo List**
1. Create `backend/tests/aiAnalyst.test.js`.
2. Import `{ parseEvidenceCSV, buildEvidenceGraph, buildForensicAnalysis }`
   from `'../server'`.
3. Import `{ validateAnalystResponse, buildAnalystHeuristicNarrative }`
   from `'../services/aiAnalyst'`.
4. Write `beforeAll` fixture.
5. Write T-AA-1 through T-AA-10 as `test(...)` (not `describe/it`),
   following the style of `aiEngine.test.js`.

**Relevant Context**
- `backend/tests/aiEngine.test.js` — exact style and fixture pattern to
  mirror.
- `backend/tests/forensicAnalysisApi.test.js` — alternative fixture pattern.

**Status** `[x] done`

---

## Implementation Notes

- **No raw CSV to LLM**: `generateAnalystNarrative` receives only the
  validated `ForensicAnalysis` object and `validIds`. The CSV is never
  serialised into the prompt.
- **No refactoring of aiEngine.js**: `buildLLMClient` is duplicated
  locally in `aiAnalyst.js`. This is intentional — the two modules serve
  different purposes.
- **No frontend changes**.
- **No second AI provider**: ChatWatsonx / `@langchain/ibm` is reused.
- **Heuristic fallback is mandatory**: every test runs without
  `WATSONX_AI_APIKEY`, so the heuristic path must always produce a valid
  `AnalystNarrative`.
- **Error surface**: `validateAnalystResponse` violations surface as
  `{ valid: false, errors }` — the route's `catch(err)` returns
  `500 { error: err.message }` for unexpected throws; no stack trace
  ever leaks to the API consumer.
- **Route ordering**: the `/narrative` route must be registered before
  any wildcard or `param`-only routes to avoid shadowing.
