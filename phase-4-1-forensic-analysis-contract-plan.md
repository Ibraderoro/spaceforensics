# Phase 4.1 — Freeze the Forensic Analysis Contract

## Top-Level Overview

Establish a deterministic, LLM-independent forensic analysis layer by:

1. Defining the internal object contract (types/shapes) for `ForensicAnalysis`, `HypothesisAnalysis`, `EvidenceSummary`, `HypothesisComparison`, and `AnalysisLimitation` — all using only the existing, verified terminology.
2. Implementing the contract as a new file `backend/services/forensicAnalysis.js` with lightweight constructor/factory helpers and a single entry-point function `runForensicAnalysis(caseId, rows, graph)`.
3. Adding a focused test file `backend/tests/forensicAnalysis.test.js` that verifies contract shape, terminology, and no-probability invariants.
4. Running the full existing test suite to confirm no regressions.

**Phase 3.5 baseline is frozen.** Nothing in `parseEvidenceCSV`, evidence IDs, case data, `buildEvidenceGraph`, the AI engine, routes, or existing tests is touched.

---

## Architecture Reference

The intended data-flow is:

```
Evidence (rows from parseEvidenceCSV)
  ↓
Evidence Graph (buildEvidenceGraph — frozen)
  ↓
Deterministic Forensic Analysis  ← this phase
  ↓
Validated Analysis Object
  ↓
LLM Explanation             (Phase 4.2+)
  ↓
Validated Report
```

The forensic analysis layer consumes the graph and the raw evidence rows but **never** calls the AI engine. It is a pure function: given the same graph and rows it always returns the same object.

---

## Verified Baseline (Phase 3.5)

- Backend test suites: 3 passed, backend tests: 55 passed
- `evidenceGraph.test.js`: 25 passed (T1–T25 — note: T22/T23/T24 observed above)
- `causal_attribution_established`: false
- H1 assessment: mixed; H2 assessment: mixed; H3 assessment: supported; H4 assessment: insufficient_evidence; H5 assessment: strongly_supported
- `allEnvNonDiscrimRefs` removed; GOES11_EPHEMERIS excluded from hypothesis lists

---

## Existing Shapes (Frozen)

### EvidenceRef
```js
{ evidence_id: string, relationship: string, interpretation: string }
```

### Hypothesis (in graph)
```js
{
  hypothesis_id: string,            // 'H1'–'H5'
  label: string,
  description: string,
  environmental_context: EvidenceRef[],
  supporting_evidence: EvidenceRef[],
  contradicting_evidence: EvidenceRef[],
  non_discriminating_evidence: EvidenceRef[],
  heuristic_note: string | null,
  limitations: Limitation[],
  assessment: string                // categorical only
}
```

### Limitation
```js
{ type: string, description: string }
// type ∈ { 'unresolved', 'proxy_measurement', 'missing_data' }
```

### Evidence Record
```js
{
  evidence_id: string, timestamp: string, source: string,
  measurement: string, value: number, unit: string, resolution: string,
  dataset_id: string|null, provider: string|null, variable: string|null,
  evidence_type: string|null, quality: null
}
```

### Evidence Graph root
```js
{ case_id: string, causal_attribution_established: boolean, hypotheses: Hypothesis[] }
```

---

## Contract to Implement

### ForensicAnalysis (root)
```js
{
  case_id: string,
  analysis_version: string,              // e.g. '4.1.0'
  causal_attribution_established: boolean,  // passes through from graph
  hypotheses: HypothesisAnalysis[],
  comparison: HypothesisComparison,
  limitations: AnalysisLimitation[],
  heuristic_notes: string[]              // all non-null heuristic_note values from graph
}
```

### HypothesisAnalysis
```js
{
  hypothesis_id: string,
  label: string,
  assessment: string,                    // categorical; no probabilities
  evidence_summary: EvidenceSummary,
  limitations: AnalysisLimitation[],
  heuristic_note: string | null
}
```

### EvidenceSummary
```js
{
  environmental_context_count: number,
  supporting_evidence_count: number,
  contradicting_evidence_count: number,
  non_discriminating_evidence_count: number,
  environmental_context_ids: string[],   // evidence_id references only
  supporting_evidence_ids: string[],
  contradicting_evidence_ids: string[],
  non_discriminating_evidence_ids: string[]
}
```

### HypothesisComparison
```js
{
  assessed_hypotheses: string[],         // hypothesis_ids with non-null assessment
  supported_hypotheses: string[],        // assessment ∈ { 'supported', 'strongly_supported' }
  mixed_hypotheses: string[],            // assessment === 'mixed'
  insufficient_hypotheses: string[],     // assessment === 'insufficient_evidence'
  most_supported: string | null          // hypothesis_id with strongest assessment, or null
}
```

Assessment rank order for `most_supported`:
`strongly_supported` > `supported` > `mixed` > `weakly_supported` > `insufficient_evidence`

### AnalysisLimitation
```js
{ type: string, description: string }   // same shape as Limitation; separate type name for clarity
```

---

## Invariants (Enforced by Contract)

1. No numerical probability, confidence score, or percentage appears anywhere in the object.
2. All `assessment` values must come from the allowed vocabulary:
   `{ 'strongly_supported', 'supported', 'mixed', 'weakly_supported', 'insufficient_evidence' }`.
3. All `evidence_id` values in `EvidenceSummary` ID lists must be drawn verbatim from the hypothesis graph (provenance preserved, no new IDs generated).
4. `causal_attribution_established` is passed through unchanged from the graph.
5. `runForensicAnalysis` is a pure synchronous function (no I/O, no async, no LLM calls).

---

## Sub-Tasks

---

### Sub-Task 1 — Create `backend/services/forensicAnalysis.js`

**Intent:** Implement the new deterministic analysis contract in its own service file, keeping it completely separate from `server.js`, `aiEngine.js`, and existing routes.

**Expected Outcomes:**
- File `backend/services/forensicAnalysis.js` exists.
- Exports `runForensicAnalysis(caseId, rows, graph)` — a pure, synchronous function.
- Exports `ANALYSIS_VERSION` constant (`'4.1.0'`).
- All five contract shapes are constructed correctly from the graph input.
- No numerical probability, no LLM call, no async I/O.

**Todo List:**
1. Create `backend/services/forensicAnalysis.js`.
2. Define `ANALYSIS_VERSION = '4.1.0'`.
3. Define `ASSESSMENT_RANK` map:
   `{ strongly_supported: 4, supported: 3, mixed: 2, weakly_supported: 1, insufficient_evidence: 0 }`.
4. Implement `buildEvidenceSummary(hypothesis)` helper — extracts counts and ID arrays from the four graph lists.
5. Implement `buildHypothesisAnalysis(hypothesis)` helper — wraps `buildEvidenceSummary` plus passes `assessment`, `limitations`, `heuristic_note`.
6. Implement `buildHypothesisComparison(hypotheses)` helper — classifies by assessment vocab and selects `most_supported` using `ASSESSMENT_RANK`.
7. Implement `runForensicAnalysis(caseId, rows, graph)`:
   - Derive `hypotheses: HypothesisAnalysis[]` from `graph.hypotheses`.
   - Derive `comparison` via `buildHypothesisComparison`.
   - Derive `limitations` by aggregating all unique limitation objects from the graph hypotheses (deduped by `description`).
   - Derive `heuristic_notes` by collecting all non-null `heuristic_note` strings from graph hypotheses (deduped).
   - Return the `ForensicAnalysis` root object.
8. Export: `module.exports = { runForensicAnalysis, ANALYSIS_VERSION }`.

**Relevant Context:**
- `backend/server.js` lines 286–485: frozen H1–H5 definitions (source of truth for assessments, limitations, heuristic_notes).
- `backend/services/aiEngine.js`: existing service file pattern — single-responsibility, separate file, `module.exports` at bottom.
- No routes or server.js changes needed in this sub-task.

**Status:** [x] done

---

### Sub-Task 2 — Add `backend/tests/forensicAnalysis.test.js`

**Intent:** Provide focused contract tests for the new analysis layer, following the exact same test conventions as the existing three test files.

**Expected Outcomes:**
- File `backend/tests/forensicAnalysis.test.js` exists.
- Tests numbered `T-FA-1` through `T-FA-N` (targeting ~12–15 tests).
- `beforeAll` fixture loads real evidence rows + graph, then runs `runForensicAnalysis`.
- All new tests pass.
- No existing tests are touched or re-tested.

**Todo List:**
1. Create `backend/tests/forensicAnalysis.test.js`.
2. `beforeAll`: load `rows`, `graph`, then call `runForensicAnalysis('galaxy-15', rows, graph)` → `analysis`.
3. Add `T-FA-1`: root shape — `analysis` has `case_id`, `analysis_version`, `causal_attribution_established`, `hypotheses` (array), `comparison`, `limitations` (array), `heuristic_notes` (array).
4. Add `T-FA-2`: `analysis.causal_attribution_established` equals `graph.causal_attribution_established` (passthrough, strictly `false`).
5. Add `T-FA-3`: `analysis.hypotheses` has exactly 5 entries with IDs H1–H5.
6. Add `T-FA-4`: every `HypothesisAnalysis` has `hypothesis_id`, `label`, `assessment`, `evidence_summary`, `limitations` (array), `heuristic_note`.
7. Add `T-FA-5`: no numerical probability/percentage anywhere in serialised analysis — scan `JSON.stringify(analysis)` for pattern `/\b\d+(\.\d+)?%|\bconfidence\b|\bprobability\b/`.
8. Add `T-FA-6`: all `assessment` values use only the allowed categorical vocabulary.
9. Add `T-FA-7`: every `evidence_id` in every `EvidenceSummary` ID list is a valid ID from the parsed evidence rows.
10. Add `T-FA-8`: `EvidenceSummary` counts match length of corresponding ID arrays (e.g., `environmental_context_count === environmental_context_ids.length`).
11. Add `T-FA-9`: H4 `EvidenceSummary` all counts are 0 and all ID arrays are empty.
12. Add `T-FA-10`: `comparison.most_supported` is `'H5'` (strongest assessment: `strongly_supported`).
13. Add `T-FA-11`: `comparison.supported_hypotheses` includes `'H3'` and `'H5'`.
14. Add `T-FA-12`: `comparison.mixed_hypotheses` includes `'H1'` and `'H2'`.
15. Add `T-FA-13`: `comparison.insufficient_hypotheses` includes `'H4'`.
16. Add `T-FA-14`: `analysis.heuristic_notes` is a non-empty array (H1 and H2 both have heuristic_note).
17. Add `T-FA-15`: `analysis.limitations` is a non-empty array and every entry has `type` and `description` (both non-empty strings).

**Relevant Context:**
- `backend/tests/evidenceGraph.test.js`: exact test file structure to mirror (beforeAll, no describe blocks, top-level test(), comments with test IDs).
- `backend/tests/evidenceModel.test.js`: simpler fixture pattern.
- Import: `{ parseEvidenceCSV, buildEvidenceGraph }` from `'../server'`, `{ runForensicAnalysis }` from `'../services/forensicAnalysis'`.

**Status:** [x] done

---

### Sub-Task 3 — Run Full Test Suite & Report

**Intent:** Confirm the new code passes all new tests and causes zero regressions in the 55 existing backend tests.

**Expected Outcomes:**
- All 3 existing suites continue to pass (evidenceModel, evidenceGraph, aiEngine).
- New `forensicAnalysis.test.js` suite passes (all T-FA-1 through T-FA-15).
- Total backend tests: 55 existing + ~15 new = ~70 total, all green.
- No warnings about circular requires or missing modules.

**Todo List:**
1. From `backend/` directory, run: `npm test`
2. Confirm all suites pass.
3. If any test fails, diagnose and fix — do NOT modify frozen Phase 3.5 code.
4. Record final test results in this plan.

**Relevant Context:**
- `backend/package.json` test script: `jest` (no config file — Jest auto-discovers `*.test.js` files in `tests/`).
- Module system: `"type": "commonjs"` — use `require`/`module.exports`, not ESM imports.

**Status:** [x] done — 4 suites, 70 tests, 0 failures (0.438 s)

---

## Post-Implementation Checklist

- [ ] `backend/services/forensicAnalysis.js` created (no other files modified)
- [ ] `backend/tests/forensicAnalysis.test.js` created (no existing tests modified)
- [ ] `runForensicAnalysis` is pure/synchronous — no async, no I/O, no LLM
- [ ] No numerical probabilities or confidence scores in contract
- [ ] All `assessment` values use allowed categorical vocabulary
- [ ] All `evidence_id` references pass through from graph (no new IDs)
- [ ] `causal_attribution_established` is a passthrough from graph (always `false` for Galaxy 15)
- [ ] Full test suite green (0 regressions)
- [ ] Phase 3.5 code untouched

## Files That Must NOT Be Modified

- `backend/server.js`
- `backend/services/aiEngine.js`
- `backend/tests/evidenceGraph.test.js`
- `backend/tests/evidenceModel.test.js`
- `backend/tests/aiEngine.test.js`
- `cases/galaxy-15/*`
- Any frontend files
