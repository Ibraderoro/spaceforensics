# Phase 6.1B — Second-Case Onboarding Implementation Plan

**Goal:** Generalise the three load-bearing Galaxy-15-specific assumptions so that a second forensic case can be onboarded without changing any existing test assertions, scientific invariants, or Galaxy-15 regression values.

**Scope:** Minimal change only. Every Phase 5 test must continue to pass byte-identically. No refactor of unrelated code.

**Reconnaissance source:** `phase-6-1a-second-case-architecture-reconnaissance.md`

---

## Architecture Summary

Three components require change. Everything else is already case-agnostic.

```
Component 1 — Evidence ID prefix         server.js:164
Component 2 — buildEvidenceGraph          server.js:245–526
Component 3 — Frontend case selection     api.js, App.jsx, InvestigationTimeline.jsx
```

Second case data contract (no code changes needed beyond the three components):
```
cases/<new-case-id>/
  case.json              (standard schema + "id_prefix" field)
  hypotheses.json        (new — N hypothesis definitions)
  normalized/
    <name>_evidence.csv  (standard column schema)
```

---

## Sub-Tasks

---

### Sub-Task 1 — `case.json` Schema Extension: `id_prefix` Field

**Status:** `[ ] pending`

**Intent**

Add a single new optional field `id_prefix` to `cases/galaxy-15/case.json`. This field provides the short uppercase slug used when generating evidence IDs (e.g. `"G15"` produces `E-G15-0001`). Adding it to Galaxy 15 first preserves current behaviour exactly while enabling the generalisation in Sub-Task 2.

**Expected Outcomes**

- `cases/galaxy-15/case.json` gains `"id_prefix": "G15"` at the top level.
- All existing tests continue to pass unchanged (no code has changed yet).
- The second case's `case.json` will carry its own `id_prefix` value.

**Todo List**

1. Open `cases/galaxy-15/case.json`.
2. Add `"id_prefix": "G15"` as a top-level field (after `"case_id"`).
3. Verify the file remains valid JSON.

**Relevant Context**

- File: `cases/galaxy-15/case.json` — currently 67 lines, read by `buildProvenanceMap` in `server.js:33` and by `buildCaseEvent` in `forensicAnalysis.js:331`.
- No existing code reads `id_prefix`; the field is inert until Sub-Task 2.

---

### Sub-Task 2 — Generalise Evidence ID Generation in `parseEvidenceCSV`

**Status:** `[ ] pending`

**Intent**

Replace the hardcoded `E-G15` prefix in `server.js:164` with a value derived from `case.json.id_prefix`. Galaxy 15 will produce identical IDs (`E-G15-XXXX`) because the field added in Sub-Task 1 provides `"G15"`. A second case with `"id_prefix": "AKF2"` would produce `E-AKF2-0001`, etc.

**Expected Outcomes**

- `parseEvidenceCSV` reads `case.json` once at the top of the function (synchronously, before the CSV stream opens) to extract `id_prefix`.
- If `id_prefix` is absent from `case.json`, fall back to a deterministic slug derived from `caseId` (e.g. `galaxy-15` → `G15` by uppercasing and removing hyphens/vowels, or simply by uppercasing the whole caseId — exact algorithm must be specified and frozen).
- Galaxy 15 ID range `E-G15-0001` through `E-G15-0278` is byte-identical to before.
- `multiCaseIngestion.test.js` tests 3–4 (first/last ID assertions) continue to pass.

**Todo List**

1. In `server.js`, at the top of `parseEvidenceCSV` (before the CSV stream), read `case.json` synchronously to extract `id_prefix`. Use the existing `CASES_DIR` constant.
2. If `case.json` does not exist or `id_prefix` is absent, derive a fallback slug: take the `caseId`, uppercase it, remove hyphens → e.g. `galaxy-15` → `GALAXY15`. This fallback must never be reached for any properly-onboarded case.
3. Replace `row.evidence_id = \`E-G15-${...}\`` with `row.evidence_id = \`E-${idPrefix}-${...}\``.
4. Run `backend/tests/multiCaseIngestion.test.js` — all 8 tests must pass. Pay particular attention to tests 3 and 4 (first/last IDs).
5. Run the full backend test suite — 293 tests must pass.

**Relevant Context**

- `server.js:100–171` — `parseEvidenceCSV` function
- `server.js:33–50` — `buildProvenanceMap` already reads `case.json` synchronously; use the same pattern
- `cases/galaxy-15/case.json` — `"id_prefix": "G15"` (added in Sub-Task 1)
- Evidence ID format constraint: `E-{PREFIX}-{NNNN}` where NNNN is 1-based zero-padded to 4 digits
- Galaxy 15 regression: `E-G15-0001` through `E-G15-0278` must be preserved exactly

---

### Sub-Task 3 — Externalise `buildEvidenceGraph` into Case-Specific `hypotheses.json`

**Status:** `[ ] pending`

**Intent**

This is the largest structural change. The current `buildEvidenceGraph` function in `server.js` is a 280-line monolith that hardcodes the Galaxy 15 hypothesis set, anchor timestamp, GOES-11 source names, and all interpretation texts. It must be refactored to:

1. Read the anchor timestamp from `case.json.anchor_event.timestamp`
2. Derive source partitions from `case.json.data_sources` (by dataset_id / source name)
3. Load hypothesis skeleton definitions from `cases/<id>/hypotheses.json`
4. Populate each hypothesis's evidence lists by applying the temporal window and source-partition logic

A new file `cases/galaxy-15/hypotheses.json` is created that encodes all current Galaxy 15 hypothesis definitions (H1–H5 labels, descriptions, assessments, limitations, and the evidence-list assembly rules). The production of evidence lists (ep8EnvRefs, magEnvRefs, anchorRefs) remains logic in the function but is now driven by configurable rule fields in `hypotheses.json` rather than hardcoded per-hypothesis.

**Expected Outcomes**

- `buildEvidenceGraph('galaxy-15', rows)` returns a byte-identical graph to the current implementation.
- `buildEvidenceGraph('new-case-id', rows)` returns a valid graph for any second case with a matching `hypotheses.json`.
- The Galaxy 15 `causal_attribution_established: false` value is read from `hypotheses.json` (or `case.json`) — not hardcoded.
- All `evidenceGraph.test.js` tests pass, especially T2 (exactly H1–H5), T7 (H5=strongly_supported), T8 (causal_attribution=false).
- `server.js` no longer contains the strings `"2010-04-05T09:48:00Z"`, `"GOES11_EP8"`, `"GOES11_MAG"`, `"Galaxy 15"` in `buildEvidenceGraph`.
- Full 293-test backend suite passes.

**`hypotheses.json` Schema (Galaxy 15 instance)**

```jsonc
{
  "causal_attribution_established": false,
  "heuristic_window_minutes": 10,
  "source_roles": {
    "anchor":   "CASE",
    "env_ep8":  "GOES11_EP8",
    "env_mag":  "GOES11_MAG"
    // sources not listed here (e.g. GOES11_EPHEMERIS) are excluded from all lists
  },
  "hypotheses": [
    {
      "hypothesis_id": "H1",
      "label": "Spacecraft charging / electrostatic discharge",
      "description": "...",
      "assessment": "mixed",
      "heuristic_note": "MVP temporal selection window of ±10 minutes ...",
      "evidence_rules": {
        "environmental_context": ["env_ep8_window"],
        "supporting_evidence": [],
        "contradicting_evidence": [],
        "non_discriminating_evidence": ["anchor"]
      },
      "limitations": [ ... ]
    },
    // H2–H5 ...
  ]
}
```

`evidence_rules` entries are symbolic role names (`"anchor"`, `"env_ep8_window"`, `"env_mag_window"`) that `buildEvidenceGraph` resolves to actual evidence rows. This avoids duplicating row-selection logic per hypothesis. The relationship strings and interpretation texts are also stored in `hypotheses.json` per rule type.

**Relationship / Interpretation storage in `hypotheses.json`**

Relationship strings and interpretation texts (currently inline in `server.js:282–319`) move into a `"ref_templates"` block in `hypotheses.json`:

```jsonc
"ref_templates": {
  "anchor": {
    "relationship": "command_loss_consistent_with_multiple_mechanisms",
    "interpretation": "The anchor event (loss of ground command contact) ..."
  },
  "env_ep8_window": {
    "relationship": "energetic_particle_environment_at_anomaly_time",
    "interpretation": "GOES-11 EP8 1 MeV electron flux ..."
  },
  "env_mag_window": {
    "relationship": "geomagnetic_conditions_at_anomaly_time",
    "interpretation": "GOES-11 MAG B_GSM measurements ..."
  }
}
```

**Todo List**

1. Create `cases/galaxy-15/hypotheses.json` encoding the full Galaxy 15 hypothesis definitions, `source_roles`, `ref_templates`, `heuristic_window_minutes`, and `causal_attribution_established`.
2. Rewrite `buildEvidenceGraph(caseId, rows)` in `server.js` to:
   a. Read `case.json` for `anchor_event.timestamp`
   b. Read `hypotheses.json` for the full definition set
   c. Partition rows into named buckets by `source_roles`
   d. Apply temporal windowing using the anchor timestamp and `heuristic_window_minutes`
   e. For each hypothesis, resolve `evidence_rules` entries to actual row arrays and build ref objects using `ref_templates`
   f. Return `{ case_id, causal_attribution_established, hypotheses }` — identical shape to now
3. Verify Galaxy 15 graph output is byte-identical to current output using the `forensicPipelinePerf.test.js` PERF-7 repeatability test.
4. Run the full 293-test backend suite. All tests must pass.

**Relevant Context**

- `server.js:245–527` — current `buildEvidenceGraph` (to be replaced)
- `server.js:33–50` — `buildProvenanceMap` — pattern for sync `case.json` reads
- `forensicAnalysis.js` — `buildForensicAnalysis` consumes the graph; its signature does not change
- `evidenceGraph.test.js:T2` pins exactly 5 hypotheses H1–H5 for Galaxy 15 — this must pass
- `evidenceGraph.test.js:T7` pins H5 `strongly_supported` — must come from `hypotheses.json`
- `evidenceGraph.test.js:T8` pins `causal_attribution_established: false` — must come from `hypotheses.json`
- `forensicPipelineIntegration.test.js:F35–F39` pins all five assessments — all from `hypotheses.json`
- HEURISTIC_WINDOW_NOTE text is currently in `server.js:254–256`; must move to `hypotheses.json` as `heuristic_note` per hypothesis

---

### Sub-Task 4 — Frontend Case Parameterisation

**Status:** `[ ] pending`

**Intent**

All six frontend API functions currently hardcode `"galaxy-15"`. This sub-task makes them accept a `caseId` parameter. `App.jsx` gains a `selectedCaseId` state defaulting to `"galaxy-15"`. A minimal case-selector UI is added (a `<select>` populated from `GET /api/cases`). The hardcoded `09:48:00 UTC` in the Case Metadata card is replaced with the dynamic value from `caseMeta.anchor_event?.timestamp`.

`InvestigationTimeline.jsx:287` also hardcodes `"galaxy-15"` in the `fetchEvidenceProvenance` call — this must be fixed by passing `caseId` as a prop.

**Expected Outcomes**

- `api.js` — all six case-scoped functions accept a `caseId` parameter. `fetchCaseMeta(caseId)`, `fetchTimeline(caseId)`, `fetchEvidenceGraph(caseId)`, `fetchForensicAnalysis(caseId)`, `postInvestigate(caseId)`, `postChallenge(caseId)`.
- `App.jsx` — loads the case list from `GET /api/cases` on mount, stores `selectedCaseId` (default `"galaxy-15"`), passes `selectedCaseId` to all API calls, displays a case-selector dropdown.
- `App.jsx:207` — `09:48:00 UTC` replaced with `caseMeta.anchor_event?.timestamp ?? "—"`.
- `InvestigationTimeline.jsx` — accepts a `caseId` prop; passes it to `fetchEvidenceProvenance(caseId, id)` instead of the hardcoded `"galaxy-15"`.
- `App.jsx` passes `caseId={selectedCaseId}` to `<InvestigationTimeline>`.
- All 129 frontend tests pass. `InvestigationTimeline.test.jsx:TL-8` asserts `fetchEvidenceProvenance("galaxy-15", "E-G15-0101")` — this continues to pass because the fixture renders with `anchorTimestamp="2010-04-05T09:48:00Z"` (hardcoded in the test fixture, not in component code) and the component receives its caseId from props.

**Todo List**

1. Update `frontend/src/api.js`:
   - Add `caseId` parameter to `fetchCaseMeta`, `fetchTimeline`, `fetchEvidenceGraph`, `fetchForensicAnalysis`, `postInvestigate`, `postChallenge`.
   - Add `fetchCaseList()` function → `GET /api/cases` (no caseId param).
2. Update `frontend/src/App.jsx`:
   - Add `selectedCaseId` state (default `"galaxy-15"`).
   - Add `caseList` state (default `[]`).
   - In the initial `useEffect`, also call `fetchCaseList()` to populate `caseList`.
   - Pass `selectedCaseId` to all six API functions.
   - Add a minimal `<select>` case-selector dropdown in the header area, populated from `caseList`.
   - Replace line 207 (`09:48:00 UTC`) with `{caseMeta.anchor_event?.timestamp ?? "—"}`.
3. Update `frontend/src/components/InvestigationTimeline.jsx`:
   - Add `caseId` to the component props destructuring.
   - Replace `fetchEvidenceProvenance("galaxy-15", id)` on line 287 with `fetchEvidenceProvenance(caseId, id)`.
4. Update `frontend/src/App.jsx` to pass `caseId={selectedCaseId}` to `<InvestigationTimeline>`.
5. Run the full 129-test frontend suite. All tests must pass.

**Relevant Context**

- `frontend/src/api.js:22–58` — all six functions to update
- `frontend/src/App.jsx:207` — hardcoded `09:48:00 UTC`
- `frontend/src/App.jsx:109–113` — `<InvestigationTimeline>` render — add `caseId` prop here
- `frontend/src/components/InvestigationTimeline.jsx:287` — `fetchEvidenceProvenance("galaxy-15", id)`
- `frontend/src/components/InvestigationTimeline.test.jsx:TL-8:287` — asserts `fetchEvidenceProvenance("galaxy-15", ...)` — this test passes props explicitly, so it will call the component with whatever `caseId` prop the test passes; the test uses `renderTimeline()` which does not pass a `caseId` prop. The component must default `caseId` to `"galaxy-15"` when not provided, OR the test must be updated to pass `caseId="galaxy-15"` explicitly. **Preferred:** default `caseId = "galaxy-15"` in the component prop destructuring to avoid changing the test.
- `backend/server.js:176–193` — `GET /api/cases` is already implemented and generic

---

### Sub-Task 5 — Second Case: Data Files and `hypotheses.json`

**Status:** `[ ] pending`

**Intent**

Create the data directory and files for the second case. The second case used for Phase 6 is **Anik F1R** (NORAD 28868) — a GEO satellite anomaly from 2006 involving a command-link interruption with available GOES-10 space weather data. This provides a structurally similar but scientifically distinct case: different satellite, different sensor proxy, different anomaly mechanism hypotheses, different anchor timestamp.

If Anik F1R data is not yet available, a **synthetic minimal case** (`cases/test-case-alpha`) with fabricated but valid evidence records and a realistic hypothesis set is created instead, solely for the purpose of proving that the architecture generalises. The synthetic case must:
- Have at least 10 evidence records with a deterministic ID scheme
- Have at least 3 hypotheses
- Have `causal_attribution_established: false`
- Pass all structural validators

**Expected Outcomes**

- `cases/<second-case-id>/case.json` exists and is valid per the schema (with `id_prefix`).
- `cases/<second-case-id>/hypotheses.json` exists and is valid per the schema defined in Sub-Task 3.
- `cases/<second-case-id>/normalized/<name>_evidence.csv` exists with the standard column schema.
- `GET /api/cases` returns both cases.
- `GET /api/cases/<second-case-id>/forensic-analysis` returns HTTP 200 with a valid report.
- Evidence IDs for the second case do NOT contain `G15` and do NOT overlap with Galaxy 15's ID range.

**Todo List**

1. Decide on second case ID and `id_prefix` (e.g. `"anik-f1r"` / `"AF1R"`, or `"test-case-alpha"` / `"TCA"`).
2. Create `cases/<id>/case.json` with all required fields and the `id_prefix`.
3. Create `cases/<id>/hypotheses.json` with at least 3 hypothesis definitions using the schema from Sub-Task 3.
4. Create `cases/<id>/normalized/<name>_evidence.csv` with the standard columns: `timestamp, source, measurement, value, unit, resolution`.
5. Manually verify `GET /api/cases/<id>/evidence-graph` and `GET /api/cases/<id>/forensic-analysis` return 200.
6. Run `backend/tests/multiCaseIngestion.test.js` — Galaxy 15 regression assertions must still pass.

**Relevant Context**

- CSV columns: `timestamp, source, measurement, value, unit, resolution` (see `server.js:135–141`)
- `case.json` schema: see `cases/galaxy-15/case.json` — all fields optional except `case_id`, `anchor_event`, `id_prefix`
- `hypotheses.json` schema: defined in Sub-Task 3
- Galaxy 15 evidence IDs: `E-G15-0001` through `E-G15-0278` — second case IDs must not overlap

---

### Sub-Task 6 — New Multi-Case and Second-Case Tests

**Status:** `[ ] pending`

**Intent**

Write the new test suite required by the reconnaissance report (Section D). These tests validate the second case independently and verify that the two cases are isolated. No existing tests are modified.

**Expected Outcomes**

- 6 new test files created (backend)
- New tests pass alongside the existing 293 backend tests
- No existing test is modified, weakened, or removed
- Galaxy 15 regression tests are untouched

**Todo List**

1. Create `backend/tests/secondCaseIngestion.test.js`:
   - Resolves without throwing
   - Correct record count (matches CSV)
   - First ID is `E-{PREFIX}-0001`
   - Deterministic across two calls
2. Create `backend/tests/secondCaseEvidenceGraph.test.js`:
   - Graph has valid shape (case_id, causal_attribution_established, hypotheses array)
   - All hypothesis_ids are non-empty strings
   - All assessments are in `ALLOWED_ASSESSMENTS`
   - All four evidence-list fields present on every hypothesis
   - All referenced evidence_ids exist in the parsed evidence
   - No environmental_context / supporting_evidence overlap (V5)
   - EPHEMERIS records (if any) are excluded from all hypothesis lists
3. Create `backend/tests/secondCaseForensicPipeline.test.js`:
   - Full pipeline (parseEvidenceCSV → buildEvidenceGraph → buildForensicAnalysis → narrative → report) runs without throwing
   - Report has all required top-level fields
   - `causal_attribution_established` is boolean
   - All assessments are in `ALLOWED_ASSESSMENTS`
   - No causal-certainty language in narrative
4. Create `backend/tests/secondCaseHttpIntegration.test.js`:
   - `GET /api/cases/<id>` returns 200
   - `GET /api/cases/<id>/timeline` returns 200 and an array
   - `GET /api/cases/<id>/evidence-graph` returns 200 with hypotheses
   - `GET /api/cases/<id>/forensic-analysis` returns 200 with valid report
5. Create `backend/tests/multiCaseIsolation.test.js`:
   - Galaxy 15 evidence IDs and second-case evidence IDs are completely disjoint
   - `buildEvidenceGraph('galaxy-15', ...)` called after second case does not alter Galaxy 15 graph
   - Concurrent calls for both cases return correct results for each
6. Create `backend/tests/multiCaseListEndpoint.test.js`:
   - `GET /api/cases` returns an array containing both `"galaxy-15"` and the second case ID
   - Response shape: each entry has `case_id` and `title`
   - No case not present in the `cases/` directory appears in the list

**Relevant Context**

- `ALLOWED_ASSESSMENTS`: `['strongly_supported', 'supported', 'mixed', 'weakly_supported', 'insufficient_evidence']`
- `EVIDENCE_LISTS`: `['environmental_context', 'supporting_evidence', 'contradicting_evidence', 'non_discriminating_evidence']`
- Pattern: see `multiCaseIngestion.test.js` for parseEvidenceCSV test structure
- Pattern: see `evidenceGraph.test.js` for graph structural tests
- Pattern: see `forensicPipelineIntegration.test.js` for pipeline integration tests
- Pattern: see `httpIntegration.test.js` for HTTP integration tests

---

## Implementation Order and Dependencies

```
Sub-Task 1 → Sub-Task 2 → Sub-Task 3 → Sub-Task 5 → Sub-Task 6
                                   ↘
                              Sub-Task 4 (independent of 3 & 5)
```

- Sub-Task 1 must complete before Sub-Task 2 (id_prefix field must exist before it can be read).
- Sub-Task 2 must complete before Sub-Task 5 (second case needs working ID generation).
- Sub-Task 3 must complete before Sub-Task 5 (second case needs working graph construction).
- Sub-Task 4 is fully independent of Sub-Tasks 2, 3, 5 — it changes only frontend code.
- Sub-Task 6 requires Sub-Tasks 2, 3, 4, and 5 to all be complete.

---

## Scientific Invariants: Must Pass After Every Sub-Task

The following assertions must pass after every sub-task, without exception:

| Invariant | Test | Value |
|-----------|------|-------|
| Galaxy 15 has exactly 278 evidence records | `multiCaseIngestion.test.js:test 2` | 278 |
| First Galaxy 15 evidence ID is `E-G15-0001` | `multiCaseIngestion.test.js:test 3` | unchanged |
| Last Galaxy 15 evidence ID is `E-G15-0278` | `multiCaseIngestion.test.js:test 3` | unchanged |
| Galaxy 15 `causal_attribution_established` is `false` | `evidenceGraph.test.js:T8` | `false` |
| Galaxy 15 H5 assessment is `strongly_supported` | `evidenceGraph.test.js:T7` | `strongly_supported` |
| Galaxy 15 H1=mixed, H2=mixed, H3=supported, H4=insufficient_evidence, H5=strongly_supported | `fullStackForensicPipeline.test.js:REQ-4a–e` | all five |
| No causal-certainty language in any output | `causalCertaintyValidation.test.js` | all CC-P-* fail |
| `environmental_context` ≠ `supporting_evidence` (V5 disjointness) | `fullStackForensicPipeline.test.js:REQ-6` | disjoint |
| EPHEMERIS excluded from all hypothesis lists | `forensicPipelineIntegration.test.js:F44` | empty |
| No numerical probabilities in narrative | `aiAnalyst.test.js:T-AA-6` | none |

---

## Notes on Minimal Change Principle

- Sub-Task 3 (`buildEvidenceGraph` generalisation) is the most invasive change. The implementation must be verified to produce byte-identical Galaxy 15 output by running `forensicPipelinePerf.test.js:PERF-7` (three independent pipeline runs produce identical output).
- The `hypotheses.json` schema is introduced as a new file; no existing file format changes except the `id_prefix` addition to `case.json`.
- `assembleValidatedForensicReport`, `validateForensicAnalysis`, `validateAnalystResponse`, and all AI invariants (A1–A10, B1–B4, V1–V6, I1–I2) are not touched.
- The `ANALYSIS_VERSION` constant in `forensicAnalysis.js` is not changed.
- No test files are modified in Sub-Tasks 1–5. Sub-Task 6 adds new test files only.
