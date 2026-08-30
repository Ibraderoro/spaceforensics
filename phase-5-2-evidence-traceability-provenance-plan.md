# Phase 5.2 — Evidence Traceability & Provenance

## Top-Level Overview

**Goal:** Make every evidence reference in the forensic report fully traceable to its
original timeline record and its hypothesis relationships.

**Scope:**
- Add a backend HTTP endpoint that exposes `getEvidenceProvenance()` for a given
  evidence ID.
- Add a `fetchEvidenceProvenance(evidenceId)` function in `frontend/src/api.js`.
- Upgrade `ProvenancePanel` in `ForensicInvestigationView.jsx` to:
  - Display all 12 required evidence fields (several are currently missing test IDs
    and `variable`, `evidence_type`, `quality` are not rendered at all).
  - Display `hypothesis_relationships` as structured entries (hypothesis ID, list name,
    relationship, interpretation) — currently only a flat interpretation string is shown.
  - Clearly distinguish raw evidence fields, relationship entries, and hypothesis
    assessment (the assessment comes from the report, not from provenance).
- Add frontend tests (FUI-P-1 through FUI-P-7) and a backend route test.
- Ensure EPHEMERIS records render their provenance fields but show no hypothesis
  relationship entries.

**Approach decision — backend endpoint vs. client-side computation:**
The backend already has `getEvidenceProvenance(caseId, evidenceId, rows, graph)`
which is a pure function returning the full structured result including
`hypothesis_relationships`. Rather than re-implementing the same traversal in the
frontend, a dedicated backend route `GET /api/cases/:id/evidence/:evidenceId/provenance`
is the correct path. This keeps forensic logic in one place (the backend) and lets the
frontend remain a pure renderer.

**Non-goals:**
- No changes to `getEvidenceProvenance()` or any other backend service logic.
- No changes to evidence IDs or assessment values.
- No duplication of evidence data into a new frontend data model.
- No new backend service functions — only a new HTTP route that calls the existing one.

---

## Sub-Tasks

---

### Sub-Task 1 — Add backend provenance HTTP route

**Intent:**
Expose `getEvidenceProvenance()` as a GET endpoint so the frontend can query provenance
for any evidence ID without reimplementing the graph-traversal logic client-side.

**Expected Outcomes:**
- `GET /api/cases/:id/evidence/:evidenceId/provenance` returns the full provenance object
  for a known evidence ID (all 12 fields + `hypothesis_relationships`).
- Returns HTTP 404 with `{ found: false, evidence_id, reason }` when the evidence ID is
  not found (matching the existing `found: false` contract).
- EPHEMERIS evidence resolves with `found: true` and `hypothesis_relationships: []`.
- The route calls the existing `getEvidenceProvenance` function — no new logic.

**Todo List:**
1. In `backend/server.js`, import `getEvidenceProvenance` from the existing module
   exports (it is already exported from `forensicAnalysis.js`).
2. Add a new GET route: `app.get('/api/cases/:id/evidence/:evidenceId/provenance', ...)`.
3. Inside the handler: parse the evidence CSV, build the graph (same as other routes),
   call `getEvidenceProvenance(req.params.id, req.params.evidenceId, rows, graph)`.
4. If `result.found === false`, respond with HTTP 404 and the result object.
5. If `result.found === true`, respond with HTTP 200 and the result object.
6. Handle CSV/graph build errors with HTTP 500 (same pattern as other routes).

**Relevant Context:**
- `backend/server.js` — existing route patterns at `GET /api/cases/:id/forensic-analysis`
  show the standard `parseEvidenceCSV` → `buildEvidenceGraph` → service call sequence.
- `backend/services/forensicAnalysis.js` — `getEvidenceProvenance` is in `module.exports`.
- `backend/tests/evidenceProvenance.test.js` — F18–F24 cover the service function;
  we need a new API-level test for the route.

**Status:** [x] done

---

### Sub-Task 2 — Add `fetchEvidenceProvenance` to frontend api.js

**Intent:**
Provide a typed, discoverable API function for the new provenance endpoint so components
do not construct URLs manually.

**Expected Outcomes:**
- `fetchEvidenceProvenance(caseId, evidenceId)` is exported from `frontend/src/api.js`.
- The function calls `GET /api/cases/:caseId/evidence/:evidenceId/provenance`.
- It returns the raw JSON response (the component decides how to handle `found: false`).
- The existing six API functions are unchanged.

**Todo List:**
1. In `frontend/src/api.js`, add a new exported function
   `fetchEvidenceProvenance(caseId, evidenceId)` that calls
   `apiFetch(\`/api/cases/${caseId}/evidence/${evidenceId}/provenance\`)`.

**Relevant Context:**
- `frontend/src/api.js` — all existing functions follow the same `apiFetch(path)` pattern.

**Status:** [x] done

---

### Sub-Task 3 — Upgrade ProvenancePanel to show all required fields

**Intent:**
The current `ProvenancePanel` renders only 8 of the 12 required fields (missing
`variable`, `evidence_type`, `quality`; `resolution` is conditionally rendered but
lacks a `data-testid`). This sub-task adds the missing fields with proper test IDs
and correct null-handling (show "—" when null).

**Expected Outcomes:**
- All 12 fields render in the panel when present in the provenance record:
  `evidence_id`, `source`, `timestamp`, `measurement`, `value`, `unit`,
  `resolution`, `dataset_id`, `provider`, `variable`, `evidence_type`, `quality`.
- Each field row has a unique `data-testid` attribute (`prov-variable`,
  `prov-evidence-type`, `prov-quality`, `prov-resolution`, `prov-dataset-id`,
  `prov-provider` — filling gaps in existing test IDs).
- Null fields render as "—" (not empty, not missing rows).
- `unit` continues to display inline with `value` as it currently does.
- The "raw evidence fields" block is visually distinct from the relationship entries
  block (added in Sub-Task 4).

**Todo List:**
1. In `ForensicInvestigationView.jsx`, locate the `ProvenancePanel` component.
2. Add missing field rows: `variable`, `evidence_type`, `quality`.
3. Add `data-testid` to all field rows that lack them: `prov-resolution`,
   `prov-dataset-id`, `prov-provider`, `prov-variable`, `prov-evidence-type`,
   `prov-quality`.
4. Make `resolution` always render (not conditionally), defaulting to "—" if absent.
5. Keep the existing null-display convention: `field ?? "—"`.

**Relevant Context:**
- `ForensicInvestigationView.jsx` lines 182–249 — `ProvenancePanel` component.
- `TIMELINE_FIXTURE` in the test file already includes `variable`, `evidence_type`
  fields, so tests can immediately assert on them.

**Status:** [x] done

---

### Sub-Task 4 — Add hypothesis_relationships display to ProvenancePanel

**Intent:**
The current panel shows only a flat `interpretationMap[evidenceId]` string. Phase 5.2
requires structured display of each hypothesis relationship: which hypothesis, which
list (relationship type), the relationship label, and the interpretation text.

**This is the core traceability feature:**
- Environmental context, supporting, contradicting, non-discriminating distinctions
  must be preserved and visually distinguished.
- The hypothesis assessment must come from the `report` prop (not from provenance data).
- The panel must never state that evidence proves a hypothesis.

**Expected Outcomes:**
- When a provenance record has `hypothesis_relationships`, each entry renders as a
  distinct row showing: `hypothesis_id`, `list_name` (relationship category),
  `relationship` (the evidence-graph relationship label), `interpretation`.
- `list_name` is rendered using a human-readable label:
  - `environmental_context` → "Environmental context"
  - `supporting_evidence` → "Supporting evidence"
  - `contradicting_evidence` → "Contradicting evidence"
  - `non_discriminating_evidence` → "Non-discriminating"
- Each relationship entry has `data-testid="prov-relationship-{hypothesis_id}"`.
- When `hypothesis_relationships` is empty (EPHEMERIS or no relationships), a note
  "No hypothesis relationships — record not cited in any hypothesis" is shown.
- The existing flat `interpretationMap` display is removed from `ProvenancePanel`
  (replaced by the structured `hypothesis_relationships` from the API response).
- Hypothesis assessment badge (e.g., "Mixed", "Supported") appears beside the
  hypothesis ID in each relationship entry — sourced from `report.hypotheses`, not
  from provenance data.

**Architecture note:**
`ProvenancePanel` currently receives `evidenceById` and `interpretationMap` as props.
After this sub-task it will receive `provenanceData` (the full API response object) and
`reportHypotheses` (for assessment lookup). The component no longer reads directly from
`evidenceById` — all evidence fields come from `provenanceData`.

The parent (`ForensicInvestigationView`) will:
- On evidence chip click: call `fetchEvidenceProvenance` (or use a cached result).
- Store the provenance result in state (`provenanceResult`).
- Pass `provenanceResult` and `report.hypotheses` to `ProvenancePanel`.

**Todo List:**
1. Add `provenanceResult` state to `ForensicInvestigationView` (starts as `null`).
2. In `handleEvidenceSelect`: when an evidence ID is selected, call
   `fetchEvidenceProvenance('galaxy-15', id)` and store the result in `provenanceResult`.
   When deselected (toggle), set `provenanceResult` to `null`.
3. Change `ProvenancePanel` props from
   `{ evidenceId, evidenceById, interpretationMap }` to
   `{ provenanceData, reportHypotheses }`.
4. Rebuild `ProvenancePanel` to read all 12 evidence fields from `provenanceData`
   (instead of `evidenceById`).
5. Add a `hypothesis_relationships` section below the field list:
   - Heading: "Hypothesis Relationships"
   - For each entry in `provenanceData.hypothesis_relationships`:
     - Show `hypothesis_id` + assessment badge (looked up from `reportHypotheses`).
     - Show `list_name` as human-readable label (styled distinctly per category:
       amber for env-context, cyan for supporting, red for contradicting, slate for
       non-discriminating — reuse `EVIDENCE_CATEGORY_STYLES`).
     - Show `relationship` label (monospace, muted).
     - Show `interpretation` text.
   - If `hypothesis_relationships` is empty: show "No hypothesis relationships recorded."
6. Remove the old `interpretationMap` prop and the `buildInterpretationMap` helper call
   from the panel (the graph-based flat interpretation is superseded by the structured
   API data). Keep `buildInterpretationMap` exported (it may be tested).
7. Handle `provenanceData.found === false`: show
   `"Evidence ID {id} not found in timeline."` inside the panel.
8. Handle provenance fetch error (network/server error): show
   `"Provenance lookup failed — investigation view remains intact."` without crashing.
9. Handle `provenanceData === null` (no evidence selected): keep existing
   "Select an evidence ID above…" placeholder.

**Relevant Context:**
- `ForensicInvestigationView.jsx` — `handleEvidenceSelect` at line ~382, `ProvenancePanel`
  at lines 182–249, `section-provenance` at lines ~556–570.
- `frontend/src/api.js` — `fetchEvidenceProvenance` added in Sub-Task 2.
- `EVIDENCE_CATEGORY_STYLES` constant at lines 13–17 of the component — reuse for
  relationship type visual treatment.
- Do NOT remove `buildInterpretationMap` export — it has its own test suite
  (`describe("buildInterpretationMap", ...)`).

**Status:** [x] done

---

### Sub-Task 5 — Frontend tests (FUI-P-1 through FUI-P-7)

**Intent:**
Test the new provenance traceability behaviour: API call on evidence selection, field
rendering, relationship type rendering, unknown ID handling, error resilience, and
EPHEMERIS guard.

**Expected Outcomes:**
All seven new tests pass alongside the existing FUI-1 through FUI-NEW-9 tests.

**Tests to add:**

| ID | Description |
|----|-------------|
| FUI-P-1 | Selecting an evidence chip calls `fetchEvidenceProvenance` with the correct evidence ID |
| FUI-P-2 | All 12 required provenance fields render in the panel when the API returns them |
| FUI-P-3 | Each hypothesis relationship entry renders with hypothesis ID, list name, relationship label, and interpretation text |
| FUI-P-4 | Relationship type (list_name) is rendered with the correct human-readable label for each of the four categories |
| FUI-P-5 | An unknown evidence ID (found: false) shows the "not found" message without crashing the view |
| FUI-P-6 | A provenance fetch failure (rejected promise) shows the error message without crashing the investigation view |
| FUI-P-7 | EPHEMERIS evidence resolves (found: true) but hypothesis_relationships is empty — the "No hypothesis relationships recorded" note is shown |

**Implementation notes:**
- Mock `fetchEvidenceProvenance` using `vi.mock('../api')` so tests do not make real
  network calls.
- Fixtures:
  - `PROVENANCE_FIXTURE` — a valid provenance result with all 12 fields and two
    hypothesis relationship entries.
  - `PROVENANCE_EPHEMERIS_FIXTURE` — a valid provenance result with EPHEMERIS source and
    `hypothesis_relationships: []`.
  - `PROVENANCE_NOT_FOUND_FIXTURE` — `{ found: false, evidence_id: 'E-G15-9999', reason: '...' }`.
- Use `waitFor` from Testing Library for async state updates after the API call.
- `renderView` helper should receive an optional `apiMock` parameter or the tests can
  configure the mock before rendering.

**Relevant Context:**
- `frontend/src/components/ForensicInvestigationView.test.jsx` — existing test file;
  add new tests at the end of the `describe("ForensicInvestigationView", ...)` block.
- The existing `TIMELINE_FIXTURE` includes all fields needed for `PROVENANCE_FIXTURE`.
- `vi.mock` / `vi.fn` are available via vitest.

**Status:** [x] done

---

### Sub-Task 6 — Backend provenance service integration test

**Intent:**
Verify `getEvidenceProvenance` at the analysis-API boundary using the real Galaxy 15
dataset. The existing `backend/tests/forensicAnalysisApi.test.js` calls service
functions directly (not HTTP via supertest) and already has `rows`/`graph`/`validIds`
fixtures — new tests extend that file following the same pattern.

**Expected Outcomes:**
- A known evidence ID returns `found: true` with all 12 evidence fields present.
- An unknown evidence ID returns `{ found: false, evidence_id, reason }` without throwing.
- EPHEMERIS source ID returns `found: true` with `hypothesis_relationships: []`.
- Every `evidence_id` in `hypothesis_relationships` matches the queried ID.

**Todo List:**
1. Add tests F35–F38 to `backend/tests/forensicAnalysisApi.test.js`.
2. Import `getEvidenceProvenance` from `'../services/forensicAnalysis'` at the top.
3. Test F35: resolve a known CASE anchor ID → `found: true`, all 12 fields present.
4. Test F36: resolve an unknown ID (`'E-G15-9999'`) → `found: false`, no throw.
5. Test F37: resolve an EPHEMERIS source ID → `found: true`, `hypothesis_relationships: []`.
6. Test F38: for a relationship-bearing ID, every `hypothesis_relationships[*].evidence_id`
   equals the queried ID.

**Relevant Context:**
- `backend/tests/forensicAnalysisApi.test.js` — `beforeAll` already builds `rows`,
  `graph`, and `validIds` from real Galaxy 15 data; F35–F38 reuse these fixtures.
- `backend/tests/evidenceProvenance.test.js` — F18–F24 are the unit-level coverage;
  F35–F38 confirm the same contract at the analysis-pipeline boundary.

**Status:** [x] done

---

### Sub-Task 7 — Run full test suites and verify

**Intent:**
Confirm that all existing tests still pass and all new tests pass with no regressions.

**Expected Outcomes:**
- Backend: all existing tests pass + new provenance route tests pass.
- Frontend: all FUI-1 through FUI-NEW-9 pass + FUI-P-1 through FUI-P-7 pass.
- No new console errors or test warnings.

**Todo List:**
1. Run `cd backend && npm test` — verify all backend suites pass.
2. Run `cd frontend && npm test` — verify all frontend suites pass.
3. If any tests fail due to this phase's changes, fix them in the same sub-task.

**Relevant Context:**
- `frontend/src/test-setup.js` — vitest setup file.
- `backend/package.json`, `frontend/package.json` — test runner configurations.

**Status:** [x] done

---

## Data Flow After Phase 5.2

```
Evidence chip click (evidence_id)
    ↓
handleEvidenceSelect(id) in ForensicInvestigationView
    ↓
fetchEvidenceProvenance('galaxy-15', id)  [frontend/src/api.js]
    ↓
GET /api/cases/galaxy-15/evidence/:id/provenance  [backend/server.js]
    ↓
getEvidenceProvenance('galaxy-15', id, rows, graph)  [forensicAnalysis.js]
    ↓
provenanceResult stored in component state
    ↓
ProvenancePanel renders:
  ┌─ Raw evidence fields (12 fields, all from provenanceResult) ─────────┐
  │  evidence_id, timestamp, source, measurement,                        │
  │  value+unit, resolution, dataset_id, provider,                       │
  │  variable, evidence_type, quality                                     │
  └─────────────────────────────────────────────────────────────────────┘
  ┌─ Hypothesis Relationships ───────────────────────────────────────────┐
  │  H2 [Mixed]                                                          │
  │    Environmental context                                             │
  │    energetic_particle_environment_at_anomaly_time                    │
  │    "Contextualises the particle environment at the time of…"         │
  │                                                                      │
  │  H1 [Mixed]                                                          │
  │    Supporting evidence                                               │
  │    elevated_flux_supports_charging                                   │
  │    "Elevated 1 MeV electron flux is consistent with…"               │
  └─────────────────────────────────────────────────────────────────────┘
```

## Invariants Preserved

| Invariant | How preserved |
|-----------|--------------|
| No evidence proves a hypothesis | Panel never uses the word "proves"; relationship type label distinguishes between supporting, contradicting, non-discriminating, and environmental context |
| EPHEMERIS excluded from hypothesis evidence | `getEvidenceProvenance` returns `hypothesis_relationships: []` for EPHEMERIS; panel shows "No hypothesis relationships recorded" |
| Assessment values unchanged | Assessment badge in relationship entries reads from `report.hypotheses[*].assessment`, not from provenance data |
| Raw evidence / relationship / assessment are distinct | Three visually separate sections within `ProvenancePanel` |
| No new evidence IDs invented | `ProvenancePanel` reads only from the API response; no local fabrication |
| Backend logic frozen | Only a new HTTP route is added; `getEvidenceProvenance` is called unchanged |
