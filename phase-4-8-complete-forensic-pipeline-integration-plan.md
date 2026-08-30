# Phase 4.8 — Complete Forensic Pipeline Integration Plan

## Top-Level Overview

Phase 4.8 wires all Phase 4 components into a single validated forensic pipeline
and surfaces the unified result through the existing
`GET /api/cases/:caseId/forensic-analysis` endpoint.

**Current state (end of Phase 4.7)**

| Route | Returns |
|-------|---------|
| `GET /api/cases/:id/forensic-analysis` | Deterministic `ForensicAnalysis` only (no AI layer) |
| `GET /api/cases/:id/forensic-analysis/narrative` | `AnalystNarrative` only (no deterministic analysis included) |

**Target state (Phase 4.8)**

| Route | Returns |
|-------|---------|
| `GET /api/cases/:id/forensic-analysis` | Unified `ValidatedForensicReport` — deterministic analysis + validated AI narrative embedded, structural immutability enforced |
| `GET /api/cases/:id/forensic-analysis/narrative` | Unchanged (kept as a convenience endpoint) |

The pipeline that must be executed by the unified endpoint:

```
Evidence CSV rows
       ↓
   buildEvidenceGraph
       ↓
   buildForensicAnalysis          (deterministic, validated, Phase 4.2–4.3)
       ↓
   getEvidenceProvenance          (available per-item; not called in bulk here)
       ↓
   generateAnalystNarrative       (AI or heuristic; validated A1–A10 + B1–B4)
       ↓
   assembleValidatedForensicReport  (merge + enforce immutability)
       ↓
   ValidatedForensicReport  ← returned by GET /api/cases/:id/forensic-analysis
```

### Architectural constraints (non-negotiable)

- The deterministic analysis remains **authoritative**. The AI narrative is
  merged in as an additive `analyst_narrative` field. It never overwrites:
  - `evidence_ids` / hypothesis `assessment` values
  - `hypothesis_relationships`
  - `limitations`
  - `causal_attribution_established`
  - `causal_attribution` fields
- All existing tests (106 tests across 8 files) must continue to pass.
- `GET /api/cases/:id/evidence-graph` and `GET /api/cases/:id/timeline` are
  not touched.
- No frontend code changes.

### Galaxy-15 regression assertions

The following facts must be preserved end-to-end:

| Fact | Expected |
|------|----------|
| `causal_attribution_established` | `false` |
| H1 assessment | `mixed` |
| H2 assessment | `mixed` |
| H3 assessment | `supported` |
| H4 assessment | `insufficient_evidence` |
| H5 assessment | `strongly_supported` |
| `environmental_context` lists | separate from `supporting_evidence` |
| EPHEMERIS records | absent from all hypothesis relationship lists |
| Evidence flooding | absent — IDs unique per list per hypothesis |

---

## Sub-Tasks

---

### Sub-Task 1 — Fix `generateAnalystNarrative` to pass `graph` to the validator

**Intent**

`generateAnalystNarrative` currently calls `validateAnalystResponse` with only
three arguments (missing `graph`) on line 643 of `aiAnalyst.js`. This means
B1 (evidence ID belongs to hypothesis) and B2 (env-context used as mechanism
confirmation) are silently skipped for any real LLM response. The graph must be
threaded through so all 14 invariants (A1–A10 + B1–B4) are enforced.

**Expected Outcomes**

- `generateAnalystNarrative(analysis, validIds, graph)` accepts `graph` as an
  optional third parameter.
- When called with a `graph`, the inner `validateAnalystResponse` call on LLM
  output receives all four arguments.
- When `graph` is absent the function behaves identically to today (backward
  compatible — the heuristic path already validates without a graph for existing
  tests).
- All 10 existing T-AA-* tests and 12 T-B* tests continue to pass unchanged
  (they call `validateAnalystResponse` directly, not via `generateAnalystNarrative`).

**Todo List**

1. In `backend/services/aiAnalyst.js`, update the signature of
   `generateAnalystNarrative` from `(analysis, validIds)` to
   `(analysis, validIds, graph)`.
2. On the line that reads
   ```js
   const { valid, errors } = validateAnalystResponse(parsed, analysis, validIds);
   ```
   change it to:
   ```js
   const { valid, errors } = validateAnalystResponse(parsed, analysis, validIds, graph);
   ```
3. No other changes to `aiAnalyst.js`.

**Relevant Context**

- `backend/services/aiAnalyst.js:625` — `generateAnalystNarrative` function.
- `backend/services/aiAnalyst.js:643` — the three-argument `validateAnalystResponse` call to fix.
- `backend/services/aiAnalyst.js:149` — `validateAnalystResponse(parsed, sourceAnalysis, validIds, graph)` already accepts 4 args.

**Status** `[x] done`

---

### Sub-Task 2 — Add `assembleValidatedForensicReport` to `forensicAnalysis.js`

**Intent**

Create a pure, synchronous function `assembleValidatedForensicReport(analysis, narrative)`
in `backend/services/forensicAnalysis.js` that merges the deterministic analysis
with the validated AI narrative while enforcing immutability of all authoritative
deterministic fields.

This function is the **gate**: it verifies the narrative did not alter any
protected field before producing the final unified object.

**Expected Outcomes**

- The function is exported from `forensicAnalysis.js`.
- It returns an object of shape:
  ```js
  {
    // All deterministic analysis fields — verbatim, unchanged:
    case_id,
    analysis_version,
    causal_attribution_established,
    event,
    evidence_summary,
    hypotheses,
    comparison,
    hypothesis_comparison,
    limitations,
    // Additive AI layer:
    analyst_narrative: AnalystNarrative
  }
  ```
- It throws `ForensicAnalysisValidationError` if `narrative.causal_attribution_established`
  does not match `analysis.causal_attribution_established` (redundant safety net
  on top of A7).
- It throws `ForensicAnalysisValidationError` if any hypothesis assessment in the
  narrative does not match the corresponding assessment in the analysis.
- No narrative field may overwrite any analysis field.

**Implementation notes**

- The function is purely additive: spread the analysis object, then set
  `analyst_narrative` from the narrative.
- The immutability checks are lightweight guard assertions (2–3 checks), not a
  full re-run of A1–A10 (that already happened inside `generateAnalystNarrative`).
- Throws `ForensicAnalysisValidationError` (already defined in the file) so
  callers get a consistent error type.

**Todo List**

1. In `backend/services/forensicAnalysis.js`, after `buildForensicAnalysis`,
   add `assembleValidatedForensicReport(analysis, narrative)`:
   ```
   - Guard: narrative.causal_attribution_established must equal
     analysis.causal_attribution_established; throw if not.
   - Guard: for each entry in narrative.hypothesis_assessments, the assessment
     must equal the corresponding hypothesis assessment in analysis.hypotheses;
     throw if not.
   - Return { ...analysis, analyst_narrative: narrative }.
   ```
2. Add `assembleValidatedForensicReport` to `module.exports` at the bottom of
   `forensicAnalysis.js`.

**Relevant Context**

- `backend/services/forensicAnalysis.js:77` — `ForensicAnalysisValidationError` class.
- `backend/services/forensicAnalysis.js:539` — `buildForensicAnalysis` output shape.
- `backend/services/forensicAnalysis.js:750` — `module.exports` block.

**Status** `[x] done`

---

### Sub-Task 3 — Upgrade `GET /api/cases/:id/forensic-analysis` to run the full pipeline

**Intent**

Replace the current 3-step route handler (parse → graph → deterministic analysis)
with the full 5-step pipeline (parse → graph → deterministic analysis →
AI narrative → assemble validated report).

The route now returns the `ValidatedForensicReport` (deterministic analysis +
`analyst_narrative` field) instead of the bare deterministic analysis.

**Expected Outcomes**

- `curl http://localhost:5001/api/cases/galaxy-15/forensic-analysis | jq`
  returns a JSON object that includes all existing deterministic fields PLUS
  an `analyst_narrative` field.
- All Galaxy-15 regression assertions hold in the response (see table above).
- `analyst_narrative.causal_attribution_established` equals `false`.
- `analyst_narrative.source` is `"heuristic"` (no API key in dev/test env).
- The `/api/cases/:id/forensic-analysis/narrative` route is unchanged.
- The response remains backward compatible: all pre-existing top-level fields
  are still present in the same position.
- Unknown case → 404.

**Todo List**

1. Import `assembleValidatedForensicReport` from `./services/forensicAnalysis`
   at the top of `server.js` (update the existing destructured require).
2. Update the `GET /api/cases/:id/forensic-analysis` route body to:
   ```
   const graph     = buildEvidenceGraph(req.params.id, rows);
   const analysis  = buildForensicAnalysis(req.params.id, graph);
   const validIds  = new Set(rows.map(r => r.evidence_id));
   const narrative = await aiAnalyst.generateAnalystNarrative(analysis, validIds, graph);
   const report    = assembleValidatedForensicReport(analysis, narrative);
   res.json(report);
   ```
3. Ensure the route is still `async` (it already is — `narrative` is async).
4. The `catch (err)` block is unchanged — errors surface as `500 { error: err.message }`.
5. Update `module.exports` to also export `assembleValidatedForensicReport`
   so tests can import it.

**Relevant Context**

- `backend/server.js:512` — current `GET /api/cases/:id/forensic-analysis` handler.
- `backend/server.js:8` — existing `require('./services/forensicAnalysis')` destructure.
- `backend/server.js:634` — `module.exports` line.
- `backend/services/aiAnalyst.js` is already imported as `aiAnalyst` in `server.js`.

**Status** `[x] done`

---

### Sub-Task 4 — Write `backend/tests/forensicPipelineIntegration.test.js`

**Intent**

Create a focused integration test file that verifies the complete pipeline
(evidence model → graph → deterministic analysis → AI narrative → validated
report) end-to-end using real galaxy-15 data. All Galaxy-15 regression
assertions must be codified as named tests.

This file serves as the regression contract for Phase 4.8: if the pipeline is
ever broken, these tests catch it.

**Expected Outcomes**

- All new tests pass with `npm test -- --runInBand`.
- All 106 previously-passing tests continue to pass.
- Every Galaxy-15 regression assertion has a dedicated named test.

**Test Matrix**

| ID   | What is tested |
|------|----------------|
| F33  | Full pipeline produces a `ValidatedForensicReport` without throwing |
| F34  | `causal_attribution_established` is strictly `false` in the report |
| F35  | H1 assessment is `mixed` |
| F36  | H2 assessment is `mixed` |
| F37  | H3 assessment is `supported` |
| F38  | H4 assessment is `insufficient_evidence` |
| F39  | H5 assessment is `strongly_supported` |
| F40  | `analyst_narrative` field is present and has `source: "heuristic"` (no API key in test env) |
| F41  | `analyst_narrative.causal_attribution_established` equals `false` |
| F42  | `analyst_narrative` assessments for each hypothesis exactly match the deterministic assessments |
| F43  | `environmental_context_ids` and `supporting_evidence_ids` are disjoint (no flooding) for every hypothesis |
| F44  | No `GOES11_EPHEMERIS` evidence_id appears in any hypothesis relationship list (`environmental_context`, `supporting_evidence`, `contradicting_evidence`, `non_discriminating_evidence`) |
| F45  | No evidence_id appears more than once across all four lists within a single hypothesis (no intra-hypothesis flooding) |
| F46  | Every evidence_id in `analyst_narrative.hypothesis_assessments[*].evidence_ids` exists in `validIds` |
| F47  | `analyst_narrative.hypothesis_assessments` contains exactly one entry per hypothesis (H1–H5) |

**Fixture design**

```js
beforeAll(async) {
  rows      = await parseEvidenceCSV('galaxy-15');
  graph     = buildEvidenceGraph('galaxy-15', rows);
  analysis  = buildForensicAnalysis('galaxy-15', graph);
  validIds  = new Set(rows.map(r => r.evidence_id));
  narrative = buildAnalystHeuristicNarrative(analysis);
  report    = assembleValidatedForensicReport(analysis, narrative);
}
```

All direct function imports — no HTTP client.

**Relevant Context**

- `backend/tests/forensicAnalysisApi.test.js` — fixture pattern to follow.
- `backend/services/forensicAnalysis.js` — `assembleValidatedForensicReport` (new export).
- `backend/services/aiAnalyst.js` — `buildAnalystHeuristicNarrative`.
- `backend/server.js` — `parseEvidenceCSV`, `buildEvidenceGraph`, `buildForensicAnalysis`.
- Galaxy-15 evidence sources: CASE, EP8, MAG records are in hypotheses; GOES11_EPHEMERIS is excluded.

**Status** `[x] done`

---

### Sub-Task 5 — Regression verification: run full test suite

**Intent**

Run `npm test -- --runInBand` and confirm:
1. All 106 pre-existing tests pass.
2. All new Phase 4.8 tests pass.
3. No test output contains "FAIL" or unhandled promise rejections.

Additionally confirm the three manual `curl` commands produce the expected
outputs as described in the task brief.

**Expected Outcomes**

- `npm test -- --runInBand` exits 0.
- Test count: all pre-existing 106 tests + all new Phase 4.8 tests.
- `GET /api/cases/galaxy-15/forensic-analysis` response includes `analyst_narrative`
  at the top level with all Galaxy-15 regression facts.
- `GET /api/cases/galaxy-15/evidence-graph` response is unchanged from Phase 3.5.
- `GET /api/cases/galaxy-15/timeline` response length is unchanged from Phase 3.5.

**Todo List**

1. Run `cd backend && npm test -- --runInBand` and verify exit code 0.
2. If any test fails, diagnose and fix before declaring sub-task complete.
3. Start the server (`PORT=5001 node server.js`) and run the three curl commands:
   ```
   curl -s http://localhost:5001/api/cases/galaxy-15/evidence-graph | jq
   curl -s http://localhost:5001/api/cases/galaxy-15/forensic-analysis | jq
   curl -s http://localhost:5001/api/cases/galaxy-15/timeline | jq 'length'
   ```
4. Confirm the evidence-graph and timeline outputs are compatible with Phase 3.5.
5. Confirm the forensic-analysis response contains `analyst_narrative`.

**Relevant Context**

- `backend/package.json` — test script: `jest`.
- All test files are in `backend/tests/`.

**Status** `[x] done`

---

## Implementation Notes

### Backward compatibility

The existing `forensicAnalysisApi.test.js` tests (F25–F32) import
`buildForensicAnalysis` from `server.js` and call it directly — they do NOT
go through the route handler. Those tests therefore continue to test the
bare deterministic analysis and remain completely unaffected by this change.

### Route ordering

`GET /api/cases/:id/forensic-analysis/narrative` is already registered before
any wildcard routes (Phase 4.6). No route ordering changes needed.

### Error surface

`assembleValidatedForensicReport` throws `ForensicAnalysisValidationError` if
immutability guards fail. The route handler's existing `catch (err)` block
returns `500 { error: err.message }` — no stack trace is ever exposed.

### Heuristic path in tests

Since `WATSONX_AI_APIKEY` is not set in the test environment,
`generateAnalystNarrative` always returns the heuristic narrative. All
pipeline tests exercise the full path without hitting a real LLM.

### No LLM in graph or analysis

`buildEvidenceGraph` and `buildForensicAnalysis` remain purely synchronous and
deterministic. Only `generateAnalystNarrative` is async.

### EPHEMERIS exclusion

GOES11_EPHEMERIS records are loaded in `parseEvidenceCSV` and appear in
`rows` / `validIds`. They are intentionally excluded from all hypothesis
evidence lists in `buildEvidenceGraph`. The regression test F44 confirms this
invariant is preserved end-to-end.

### Environmental context separation

`environmental_context` evidence is a distinct classification from
`supporting_evidence`. F43 confirms they remain disjoint per hypothesis.
The AI narrative is validated by B2 to not misrepresent environmental context
as mechanism confirmation.
