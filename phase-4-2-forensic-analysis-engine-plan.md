# Phase 4.2 — Deterministic Forensic Analysis Engine

## Top-Level Overview

Extend `backend/services/forensicAnalysis.js` to expose a new engine function
`buildForensicAnalysis(caseId, evidenceGraph)` that:

1. Reads `case.json` for the `event` block (anchor_event, recovery_event, target_asset, data_window).
2. Builds an aggregate top-level `evidence_summary` across all hypotheses.
3. Produces the full analysis object required by Phase 4.2.
4. Runs deterministic validation over the produced object and throws a structured
   `ForensicAnalysisValidationError` on any violation.

**Nothing else changes.** `runForensicAnalysis` from Phase 4.1 stays untouched.
No routes, no AI engine, no frontend, no existing tests are modified.

---

## Architecture Position

```
parseEvidenceCSV  ─────────────────────────────────────────► rows (unchanged)
                                                               │
buildEvidenceGraph(caseId, rows)  ─────────────────────────► graph (frozen)
                                                               │
buildForensicAnalysis(caseId, graph)  ─────────────────────► ForensicAnalysis  ← Phase 4.2
                                                               │
[LLM Explanation]  (Phase 4.3+)
```

`buildForensicAnalysis` reads `case.json` (sync, via `fs.readFileSync`) for the
`event` block. It does NOT re-parse the CSV; it does NOT call `parseEvidenceCSV`.
All evidence_id validation is done against the IDs already present in the graph
itself (the graph is the source of truth for this layer).

---

## Output Shape

```js
{
  case_id:                        string,
  analysis_version:               string,        // '4.2.0'
  causal_attribution_established: boolean,       // passthrough from graph
  event: {
    timestamp:    string,                         // anchor_event.timestamp
    label:        string,                         // anchor_event.label
    description:  string,                         // anchor_event.description
    recovery: {
      timestamp:    string,
      label:        string,
      description:  string
    },
    target_asset: {                               // verbatim from case.json
      name: string, alias: string, norad_id: number,
      orbit_type: string, longitude_deg_west: number,
      operator: string, spacecraft_bus: string
    },
    data_window: { start: string, end: string, duration_minutes: number }
  },
  evidence_summary: {                            // aggregate across all hypotheses
    total_environmental_context:    number,
    total_supporting_evidence:      number,
    total_contradicting_evidence:   number,
    total_non_discriminating_evidence: number,
    total_limitations:              number
  },
  hypotheses: HypothesisAnalysis[],             // same shape as Phase 4.1
  comparison: HypothesisComparison,             // same shape as Phase 4.1
  limitations: AnalysisLimitation[]             // same shape as Phase 4.1
}
```

Note: `heuristic_notes` from Phase 4.1 is preserved inside each `HypothesisAnalysis`
via `heuristic_note`. The top-level `heuristic_notes` array from `runForensicAnalysis`
is not carried over to `buildForensicAnalysis` (it was a Phase 4.1 convenience field;
consumers of Phase 4.2 can derive it from `hypotheses[*].heuristic_note`).

---

## Validation Rules (all enforced before returning)

| # | Rule |
|---|------|
| V1 | Every evidence_id referenced in any hypothesis list exists in the graph's own evidence_id pool (collected from all four lists of all hypotheses). |
| V2 | Every hypothesis_id in the graph is a non-empty string. |
| V3 | Every assessment is in the allowed categorical vocabulary. |
| V4 | `causal_attribution_established` is strictly boolean. |
| V5 | No evidence_id appears in both `environmental_context` and `supporting_evidence` for the same hypothesis. |
| V6 | No evidence_id is duplicated within any single relationship list for the same hypothesis. |

Violations throw `ForensicAnalysisValidationError` (a subclass of `Error`) with a
`violations` array property listing each failure.

---

## Allowed Assessment Vocabulary (unchanged from Phase 3.5 / 4.1)

```
strongly_supported | supported | mixed | weakly_supported | insufficient_evidence
```

---

## Files Changed

| File | Action |
|------|--------|
| `backend/services/forensicAnalysis.js` | Extend — add `buildForensicAnalysis`, `validateForensicAnalysis`, `ForensicAnalysisValidationError`, bump `ANALYSIS_VERSION` to `'4.2.0'` |
| `backend/tests/forensicAnalysis.test.js` | Extend — append F1–F10 tests for `buildForensicAnalysis`; existing T-FA-1–T-FA-15 are untouched |

## Files NOT Changed

- `backend/server.js`
- `backend/services/aiEngine.js`
- `backend/tests/evidenceGraph.test.js`
- `backend/tests/evidenceModel.test.js`
- `backend/tests/aiEngine.test.js`
- `cases/galaxy-15/*`
- Anything in `frontend/`

---

## Sub-Tasks

---

### Sub-Task 1 — Extend `backend/services/forensicAnalysis.js`

**Intent:** Add the Phase 4.2 engine and its validation layer inside the existing
service file, alongside (not replacing) the Phase 4.1 `runForensicAnalysis`.

**Expected Outcomes:**
- `ANALYSIS_VERSION` updated to `'4.2.0'`.
- `ForensicAnalysisValidationError` class exported.
- `validateForensicAnalysis(analysis, graph)` function — runs V1–V6, throws on failure.
- `buildForensicAnalysis(caseId, graph)` function — pure, synchronous, reads case.json,
  returns validated `ForensicAnalysis` object.
- New exports added: `buildForensicAnalysis`, `validateForensicAnalysis`,
  `ForensicAnalysisValidationError`.
- Existing exports (`runForensicAnalysis`, `ANALYSIS_VERSION`) remain intact.

**Todo List:**
1. Bump `ANALYSIS_VERSION` from `'4.1.0'` to `'4.2.0'` in the constant at the top
   of `forensicAnalysis.js`. (The Phase 4.1 tests do not assert a specific version
   string value, only that it is a string — confirmed in T-FA-1.)
2. Add `require('fs')` and `require('path')` at the top (needed for case.json read).
3. Add `CASES_DIR` path constant (same pattern as `server.js`: `path.join(__dirname, '..', '..', 'cases')`).
4. Implement `ForensicAnalysisValidationError extends Error` with a `violations` array.
5. Implement `validateForensicAnalysis(analysis, graph)`:
   - Build `graphIds` set: collect all evidence_ids present anywhere in the graph
     (all four lists across all hypotheses).
   - Run V1: verify every id referenced matches `graphIds`.
   - Run V2: verify all `hypothesis_id` are non-empty strings.
   - Run V3: verify all `assessment` values are in `ALLOWED_ASSESSMENTS` set.
   - Run V4: verify `causal_attribution_established` is `typeof boolean`.
   - Run V5: for each hypothesis check `environmental_context_ids` ∩ `supporting_evidence_ids` is empty.
   - Run V6: for each hypothesis, for each list, check no duplicate ids.
   - Throw `ForensicAnalysisValidationError` if `violations.length > 0`.
6. Implement `buildCaseEvent(caseId)` helper — reads `case.json` synchronously,
   returns `{ timestamp, label, description, recovery, target_asset, data_window }`.
   Returns `null` (does not throw) when case.json is absent (graceful degradation).
7. Implement `buildAggregateEvidenceSummary(hypotheses)` helper — sums the four
   `_count` fields across all `HypothesisAnalysis` entries plus total limitations.
8. Implement `buildForensicAnalysis(caseId, graph)`:
   - Call `buildHypothesisAnalysis` for each graph hypothesis (reuse Phase 4.1 helper).
   - Call `buildHypothesisComparison` (reuse Phase 4.1 helper).
   - Call `buildCaseEvent(caseId)` for the `event` block.
   - Call `buildAggregateEvidenceSummary` for top-level `evidence_summary`.
   - Aggregate `limitations` (reuse dedup logic from `runForensicAnalysis`).
   - Assemble the result object.
   - Call `validateForensicAnalysis(result, graph)` — throws before returning if invalid.
   - Return the validated object.
9. Add to `module.exports`: `buildForensicAnalysis`, `validateForensicAnalysis`,
   `ForensicAnalysisValidationError`.

**Relevant Context:**
- `CASES_DIR` in `server.js` is `path.join(__dirname, '..', 'cases')` (backend/ → cases/).
  In `forensicAnalysis.js` (inside `backend/services/`), the path must be
  `path.join(__dirname, '..', '..', 'cases')` (services/ → backend/ → cases/).
- The Phase 4.1 helpers `buildEvidenceSummary`, `buildHypothesisAnalysis`,
  `buildHypothesisComparison` are reused without modification.
- `ALLOWED_ASSESSMENTS` set should be defined once at module level and shared by
  both `buildHypothesisComparison` and `validateForensicAnalysis`.

**Status:** [ ] pending

---

### Sub-Task 2 — Append F1–F10 tests to `backend/tests/forensicAnalysis.test.js`

**Intent:** Add the ten Phase 4.2-specified tests covering `buildForensicAnalysis`
and `validateForensicAnalysis` without modifying the existing T-FA-1–T-FA-15 tests.

**Expected Outcomes:**
- F1–F10 appended after T-FA-15 in the same file.
- A second `beforeAll` block (or shared fixture reuse) loads `buildForensicAnalysis`
  output into a new `analysis42` variable so Phase 4.1 fixtures are not disturbed.
- All 25 tests in the file pass (15 existing + 10 new).
- `validateForensicAnalysis` rejection tests use hand-crafted invalid graph objects,
  not the live galaxy-15 graph.

**Test Mapping:**

| Test ID | Phase 4.2 spec | What it verifies |
|---------|---------------|------------------|
| F1 | valid evidence graph produces valid analysis | `buildForensicAnalysis` returns object with all required top-level fields |
| F2 | all H1–H5 are represented | `analysis42.hypotheses` has 5 entries with IDs H1–H5 |
| F3 | evidence IDs are preserved | every id in every HypothesisAnalysis summary list exists in the graph id pool |
| F4 | nonexistent evidence IDs are rejected | `validateForensicAnalysis` throws when a hypothesis references an id not in the graph |
| F5 | causal attribution remains false | `analysis42.causal_attribution_established === false` |
| F6 | environmental_context remains separate from supporting_evidence | no id appears in both lists for the same hypothesis |
| F7 | H4 remains insufficient_evidence | `analysis42.hypotheses.find(H4).assessment === 'insufficient_evidence'` |
| F8 | H5 remains strongly_supported | `analysis42.hypotheses.find(H5).assessment === 'strongly_supported'` |
| F9 | no numerical probability/confidence values | JSON.stringify scan (same pattern as T-FA-5) |
| F10 | limitations are preserved | every graph hypothesis limitation type+description appears in analysis |

**Todo List:**
1. Add import of `buildForensicAnalysis`, `validateForensicAnalysis`,
   `ForensicAnalysisValidationError` to the top of the existing test file.
2. Declare `let analysis42;` and `let graphIds;` at module scope alongside existing fixtures.
3. Add a second `beforeAll` (Jest allows multiple per file) that runs
   `analysis42 = buildForensicAnalysis(CASE_ID, graph)` — uses the same `graph`
   already built by the first `beforeAll` (order is guaranteed by Jest).
4. Implement F1–F10 test cases, numbered `F1:` through `F10:` in the test names.
5. For F4 (rejection test), construct a minimal fake graph inline:
   ```js
   const fakeGraph = {
     case_id: 'galaxy-15',
     causal_attribution_established: false,
     hypotheses: [{
       hypothesis_id: 'H1', label: 'fake', assessment: 'mixed',
       environmental_context: [{ evidence_id: 'E-G15-FAKE', relationship: 'r', interpretation: 'i' }],
       supporting_evidence: [], contradicting_evidence: [], non_discriminating_evidence: [],
       heuristic_note: null, limitations: [{ type: 'unresolved', description: 'd' }]
     }]
   };
   expect(() => validateForensicAnalysis(..., fakeGraph)).toThrow(ForensicAnalysisValidationError);
   ```
   Do not use `buildForensicAnalysis` for this test — call `validateForensicAnalysis` directly
   to avoid triggering the case.json file read.

**Relevant Context:**
- Jest's `beforeAll` runs in declaration order; the second block can safely use `graph`
  populated by the first block because they run sequentially.
- Existing T-FA-1–T-FA-15 use `analysis` (from `runForensicAnalysis`); new tests use
  `analysis42` (from `buildForensicAnalysis`). No variable conflicts.
- Import line at top of file will need updating to include new exports.

**Status:** [ ] pending

---

### Sub-Task 3 — Run full test suite and report

**Intent:** Confirm 0 regressions in the 70 existing tests and all 10 new F-tests pass.

**Expected Outcomes:**
- `npm test -- --runInBand` completes with all suites green.
- Total: 4 suites, 80 tests (70 existing + 10 new), 0 failures.

**Todo List:**
1. Run `npm test -- --runInBand` from `backend/`.
2. Confirm all 4 suites pass.
3. If any test fails, diagnose and fix without modifying frozen Phase 3.5 code.
4. Record results in this plan.

**Relevant Context:**
- `--runInBand` forces serial execution (requested in task spec).
- Module system is CommonJS — no ESM issues.

**Status:** [ ] pending

---

## Post-Implementation Checklist

- [ ] `ANALYSIS_VERSION` updated to `'4.2.0'`
- [ ] `buildForensicAnalysis(caseId, graph)` is pure and synchronous
- [ ] `event` block populated from `case.json` (no invented timestamps)
- [ ] Aggregate `evidence_summary` sums across all five hypotheses
- [ ] `validateForensicAnalysis` enforces all six invariants (V1–V6)
- [ ] `ForensicAnalysisValidationError` carries `violations` array
- [ ] `causal_attribution_established` is boolean passthrough (false for Galaxy 15)
- [ ] No probabilities, scores, or percentages anywhere in output
- [ ] All Phase 4.1 exports still present and T-FA-1–T-FA-15 still pass
- [ ] All new F1–F10 tests pass
- [ ] Total test count: 80, all green
