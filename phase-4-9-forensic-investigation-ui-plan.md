# Phase 4.9 — Forensic Investigation UI

## Top-Level Overview

The backend forensic-analysis pipeline (Phases 4.1–4.8) exposes a single endpoint —
`GET /api/cases/:id/forensic-analysis` — that returns a `ValidatedForensicReport`
containing all deterministic analysis fields plus the AI analyst narrative.

This phase integrates that endpoint into the React frontend as a new dedicated
**Forensic Investigation View**. The view must render backend data faithfully,
enforce all scientific distinctions the backend makes (e.g. environmental context ≠
supporting evidence, causal attribution NOT established), and expose evidence
provenance on demand.

**No forensic logic lives in the frontend.** The frontend renders what the API returns.

**Key constraint for Galaxy 15:**
- `causal_attribution_established` is always `false`
- The UI must prominently display: "CAUSAL ATTRIBUTION: NOT ESTABLISHED"
- Never display language like "Cause: H3"
- H1: Mixed · H2: Mixed · H3: Supported · H4: Insufficient evidence · H5: Strongly supported

**Scope:**
- Add `fetchForensicAnalysis()` to `api.js`
- Create `ForensicInvestigationView.jsx` (new component, 10 sections)
- Create `EvidenceProvenancePanel.jsx` (side-panel opened on evidence ID click)
- Update `App.jsx` to load and display the new view
- Update `vite.config.js` test environment to `jsdom`
- Add frontend test file `ForensicInvestigationView.test.jsx`
- Run all backend + frontend tests and confirm they pass

---

## Sub-Tasks

---

### Sub-Task 1 — Add `fetchForensicAnalysis` to `api.js`

**Intent**
Expose the `GET /api/cases/galaxy-15/forensic-analysis` endpoint to the frontend
via the existing API helper module. This is the single data source for the entire
forensic view.

**Expected Outcomes**
- `fetchForensicAnalysis()` is exported from `frontend/src/api.js`
- It calls `GET /api/cases/galaxy-15/forensic-analysis`
- No other functions in `api.js` are modified

**Todo List**
1. Open `frontend/src/api.js`
2. Add `export function fetchForensicAnalysis()` that calls `apiFetch('/api/cases/galaxy-15/forensic-analysis')`

**Relevant Context**
- File: `frontend/src/api.js` (30 lines, see existing pattern for `fetchCaseMeta()`)
- All helpers use `apiFetch(path)` — no options needed for GET

**Status:** `[x] done`

---

### Sub-Task 2 — Configure Vitest with jsdom environment

**Intent**
The current `vite.config.js` sets `test.environment: 'node'`. React component tests
require a DOM environment. This must be changed to `jsdom` before any component test
can be written.

**Expected Outcomes**
- `frontend/vite.config.js` has `test.environment: 'jsdom'`
- Existing `assessmentLabels.test.js` still passes (it does not use the DOM)
- The test runner can now render React components via Vitest

**Todo List**
1. Open `frontend/vite.config.js`
2. Change `environment: 'node'` to `environment: 'jsdom'`
3. Run `npm run test` in `frontend/` to confirm existing tests still pass

**Relevant Context**
- File: `frontend/vite.config.js` (10 lines)
- Vitest is already installed (`"vitest": "^4.1.11"`)
- `@testing-library/react` is NOT yet installed — install it as a dev dependency

**Status:** `[x] done`

---

### Sub-Task 3 — Create `ForensicInvestigationView.jsx`

**Intent**
Build the primary forensic view component. It receives the `ValidatedForensicReport`
as a prop and renders all 10 required sections. It does not contain any forensic
logic — it is a pure render of the API response.

**Expected Outcomes**
Component renders these 10 sections in order:
1. **Event Summary** — `report.event` block (anchor timestamp, description, recovery event)
2. **Causal Attribution Status** — prominent banner: "CAUSAL ATTRIBUTION: NOT ESTABLISHED" when `causal_attribution_established === false`
3. **Hypothesis Comparison** — table of H1–H5 with label and assessment badge (using existing `getAssessmentLabel` / `getAssessmentColor`). No "Cause:" language, no ranking claims.
4. **Environmental Context** — for each hypothesis, lists `environmental_context` entries with interpretation. Uses a visually distinct amber/slate treatment (left border, distinct background) so it is clearly not the same as supporting evidence.
5. **Supporting Evidence** — per-hypothesis list from `evidence_summary.supporting_evidence_ids` (clickable IDs that trigger the provenance panel)
6. **Contradicting Evidence** — per-hypothesis list from `evidence_summary.contradicting_evidence_ids`
7. **Non-Discriminating Evidence** — per-hypothesis list from `evidence_summary.non_discriminating_evidence_ids`
8. **Limitations** — renders `report.limitations[]` (aggregate deduplicated list from all hypotheses). Always visible, not hidden in an accordion.
9. **Evidence Provenance Details** — shows selected evidence record's full provenance when an evidence ID is clicked (timestamp, source, measurement, value, unit, dataset, provider, interpretation). Rendered inline (not as a floating panel), cleared when a different hypothesis tab is active.
10. **AI Executive Summary** — renders `report.analyst_narrative.investigation_summary` and `report.analyst_narrative.event_description` (if present). Always prefixed with source attribution ("LLM" or "Heuristic" badge). Never asserts causation.

**Implementation notes:**
- The component receives the full `report` object and the `timelineData` array (for evidence provenance lookup)
- Hypothesis tabs or accordion to navigate H1–H5 (one active at a time); sections 4–7 show data for the active hypothesis
- The "Causal Attribution" banner is always shown at the top, not per-hypothesis
- Evidence IDs in sections 5–7 are rendered as `<button>` elements that, when clicked, set a `selectedEvidenceId` state and display section 9
- Environmental context (section 4) IDs must NOT be clickable as "supporting evidence" — they go through a separate rendering path
- Assessment labels come exclusively from `getAssessmentLabel()` / `getAssessmentColor()` in `assessmentLabels.js`
- No claim-level rendering from Pass 1/2 data in this view — that stays in `HypothesisMatrix` and `RedTeamPanel`
- This is a new component; it does not replace `HypothesisMatrix`

**Relevant Context**
- File to create: `frontend/src/components/ForensicInvestigationView.jsx`
- Reuse: `getAssessmentLabel`, `getAssessmentColor` from `frontend/src/utils/assessmentLabels.js`
- API response shape: `ValidatedForensicReport` (see exploration notes)
  - `report.event` — `{ timestamp, description, recovery_event }`
  - `report.causal_attribution_established` — always `false` for Galaxy 15
  - `report.hypothesis_comparison[]` — `{ hypothesis_id, label, assessment, evidence_profile, key_observations, key_limitations }`
  - `report.hypotheses[].evidence_summary` — `{ environmental_context_ids[], supporting_evidence_ids[], contradicting_evidence_ids[], non_discriminating_evidence_ids[] }`
  - `report.limitations[]` — `{ type, description }` (aggregate, deduped)
  - `report.analyst_narrative` — `{ source, investigation_summary, event_description, causal_attribution_established, hypothesis_assessments[] }`
- Styling: Tailwind dark palette (slate-950/900/800), font-mono, existing badge patterns
- Environmental context visual treatment: `border-l-2 border-amber-600 bg-amber-950/20` — distinct from cyan/green supporting evidence styling
- Icons: Lucide React (`AlertTriangle`, `Info`, `ChevronDown`, `ChevronUp`, `Search`)

**Status:** `[x] done`

---

### Sub-Task 4 — Integrate the Forensic View into `App.jsx`

**Intent**
Wire the new `ForensicInvestigationView` into the main application shell. Load
`forensicReport` state on mount alongside the existing `caseMeta` and `timelineData`
fetches. Display the view as a new section below the existing investigate/challenge
workflow.

**Expected Outcomes**
- `App.jsx` imports `fetchForensicAnalysis` and `ForensicInvestigationView`
- A new `forensicReport` state variable is populated on mount
- `ForensicInvestigationView` renders below `HypothesisMatrix` (inside the left column) when `forensicReport` is available
- If the API call fails, a non-blocking error message is shown (does not block existing functionality)
- Existing components (`HypothesisMatrix`, `RedTeamPanel`, `ReportModal`) are unaffected

**Todo List**
1. Add `forensicReport` state: `const [forensicReport, setForensicReport] = useState(null)`
2. Extend the mount `useEffect` to also call `fetchForensicAnalysis()` — use `Promise.allSettled` so a forensic-analysis failure does not block the existing case metadata load
3. Import `ForensicInvestigationView` and render it in the left column after `HypothesisMatrix`
4. Pass `forensicReport` and `timelineData` as props

**Relevant Context**
- File: `frontend/src/App.jsx`
- Pattern: existing `Promise.all([fetchCaseMeta(), fetchTimeline()])` on mount — extend to `Promise.allSettled` with a third call
- The forensic-analysis endpoint may be slow (AI narrative generation); use a separate loading state `forensicLoading` distinct from the main `loading` flag
- Do not alter the grid layout — `ForensicInvestigationView` slots in as a new card in `xl:col-span-2`

**Status:** `[x] done`

---

### Sub-Task 5 — Write Frontend Tests

**Intent**
Add a Vitest test suite for `ForensicInvestigationView` covering all the requirements
called out in the Phase 4.9 spec. Tests must assert on rendered output, not on
internal component state.

**Expected Outcomes**
Test file `frontend/src/components/ForensicInvestigationView.test.jsx` contains:

| Test ID | Assertion |
|---------|-----------|
| FUI-1 | Renders the causal attribution banner "NOT ESTABLISHED" |
| FUI-2 | Does not render "Cause:" anywhere in the output |
| FUI-3 | Renders all five hypothesis IDs (H1–H5) |
| FUI-4 | H1 assessment badge shows "Mixed" |
| FUI-5 | H2 assessment badge shows "Mixed" |
| FUI-6 | H3 assessment badge shows "Supported" |
| FUI-7 | H4 assessment badge shows "Insufficient evidence" |
| FUI-8 | H5 assessment badge shows "Strongly supported" |
| FUI-9 | Environmental context section has distinct CSS class (amber treatment) |
| FUI-10 | Limitations section is present and not hidden by default |
| FUI-11 | Clicking an evidence ID sets selection and shows provenance fields |
| FUI-12 | Provenance panel shows timestamp, source, measurement, value, unit |
| FUI-13 | AI executive summary renders `investigation_summary` text |
| FUI-14 | Source badge ("LLM" or "Heuristic") appears in executive summary section |

**Implementation Notes**
- Use `@testing-library/react` (`render`, `screen`, `fireEvent`)
- Mock `fetchForensicAnalysis` — do not hit the real backend
- Construct a minimal but structurally valid `ValidatedForensicReport` fixture:
  - `causal_attribution_established: false`
  - All five hypotheses with correct assessments (H1/H2=mixed, H3=supported, H4=insufficient_evidence, H5=strongly_supported)
  - One evidence record in `supporting_evidence_ids` for the active hypothesis
  - One limitation in `report.limitations`
  - `analyst_narrative` with `source: 'heuristic'` and `investigation_summary: 'Test summary.'`
- `timelineData` fixture: one record matching the evidence ID used in the report fixture
- Tests should be pure unit tests — no network calls

**Relevant Context**
- File to create: `frontend/src/components/ForensicInvestigationView.test.jsx`
- Test runner: Vitest (`import { describe, it, expect } from 'vitest'`)
- DOM environment: jsdom (configured in Sub-Task 2)
- `@testing-library/react` must be installed before this sub-task

**Status:** `[x] done`

---

### Sub-Task 6 — Run All Tests and Confirm Pass

**Intent**
Validate that both the backend test suite (Jest, 9 test files) and the frontend
test suite (Vitest) pass with no new failures after the Phase 4.9 changes.

**Expected Outcomes**
- `cd backend && npm test` — all 9 test suites pass, no regressions
- `cd frontend && npm test` — all tests pass, including the new `ForensicInvestigationView.test.jsx`
- No changes are made to backend scientific logic during this sub-task

**Todo List**
1. Run `cd backend && npm test` — record output
2. Run `cd frontend && npm test` — record output
3. Fix any test failures caused by Phase 4.9 changes (e.g. missing imports, wrong fixtures)
4. Do NOT modify any backend service files or test files that already pass

**Relevant Context**
- Backend test command: `npm test` (Jest) in `backend/`
- Frontend test command: `npm run test` (Vitest) in `frontend/`
- Backend tests import `{ parseEvidenceCSV, buildEvidenceGraph, buildForensicAnalysis }` directly from `server.js` — these exports must remain intact

**Status:** `[x] done`

---

## Implementation Order

```
Sub-Task 1 (api.js)
    │
Sub-Task 2 (jsdom config + @testing-library/react install)
    │
Sub-Task 3 (ForensicInvestigationView component)
    │
Sub-Task 4 (App.jsx integration)
    │
Sub-Task 5 (Frontend tests)
    │
Sub-Task 6 (Run all tests)
```

Sub-Tasks 1 and 2 are independent and can be done simultaneously.
Sub-Task 3 depends on 1 and 2 being complete.
Sub-Tasks 4 and 5 both depend on 3 and can be done simultaneously.
Sub-Task 6 must be last.

---

## API Response Shape Reference (for implementers)

The `GET /api/cases/galaxy-15/forensic-analysis` response shape relevant to this view:

```
ValidatedForensicReport {
  case_id:                        "galaxy-15"
  analysis_version:               "4.3.0"
  causal_attribution_established: false

  event: {
    timestamp:   "2010-04-05T09:48:00Z"
    label:       "galaxy15_anomaly"
    description: string
    recovery_event: { timestamp, label, description } | null
  }

  hypotheses: HypothesisAnalysis[] [
    {
      hypothesis_id:   "H1" | "H2" | "H3" | "H4" | "H5"
      label:           string
      assessment:      "mixed" | "supported" | "strongly_supported" | "insufficient_evidence"
      description:     string
      evidence_summary: {
        environmental_context_ids:       string[]
        environmental_context_count:     number
        supporting_evidence_ids:         string[]
        supporting_evidence_count:       number
        contradicting_evidence_ids:      string[]
        contradicting_evidence_count:    number
        non_discriminating_evidence_ids: string[]
        non_discriminating_evidence_count: number
      }
    }
  ]

  hypothesis_comparison: HypothesisComparisonEntry[] [
    {
      hypothesis_id:    string
      label:            string
      assessment:       string
      evidence_profile: EvidenceSummary
      key_observations: string[]
      key_limitations:  { type: string, description: string }[]
    }
  ]

  limitations: { type: string, description: string }[]

  analyst_narrative: {
    source:                         "llm" | "heuristic"
    generated_at:                   ISO string
    causal_attribution_established: false
    hypothesis_assessments: [
      { hypothesis_id, assessment, reasoning, evidence_ids, notable_claims }
    ]
    event_description:        string
    environmental_context:    string
    notable_limitations:      string
    investigation_summary:    string
  }
}
```

Evidence provenance record (from `timelineData`):
```
{
  evidence_id:    "E-G15-0042"
  timestamp:      ISO string
  source:         string
  measurement:    string
  value:          number
  unit:           string
  resolution:     string | null
  dataset_id:     string | null
  provider:       string | null
  variable:       string | null
  evidence_type:  "environmental_observation" | "case_event" | null
}
```

Evidence interpretation comes from the evidence graph (`graph.hypotheses[n].<list>[m].interpretation`),
not from the forensic analysis. The forensic analysis only carries `evidence_summary`
(IDs + counts).

> **Implementation decision:** Fetch `evidence-graph` on mount in parallel with
> the forensic analysis (using the existing `fetchEvidenceGraph()` helper already
> in `api.js`). Build a flat lookup: `evidenceId → interpretation` from
> `graph.hypotheses[n].<list>[m].{ evidence_id, interpretation }` across all four
> relationship lists. Pass this map into `ForensicInvestigationView` so the
> provenance panel can display interpretation text alongside the timeline record
> fields. This adds one parallel fetch and zero extra complexity.

---

## Non-Goals

- Do not modify any backend service (`aiEngine.js`, `forensicAnalysis.js`, `aiAnalyst.js`, `server.js` routes)
- Do not replicate hypothesis scoring, evidence graph building, or assessment logic in React
- Do not add pagination, search, or filtering to the forensic view
- Do not change the existing `HypothesisMatrix`, `RedTeamPanel`, or `ReportModal` components (they remain for Pass 1/2 workflow)
- Do not add export/print functionality to the new view (that stays in `ReportModal`)
