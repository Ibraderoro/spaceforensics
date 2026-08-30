# Phase 5.3 — Investigation Timeline & Temporal Context

## Top-Level Overview

**Goal:** Build an investigator-facing timeline component that displays all 278 Galaxy 15
timeline records, lets the investigator select a record to view its provenance, shows the
±10-minute temporal window with the mandated heuristic disclaimer, and preserves the
scientifically required separation between observation and causal attribution.

**Scope:**
- New component: `InvestigationTimeline.jsx` — a scrollable, filterable list of all
  timeline records, grouped by source type, with selection and provenance integration.
- New test file: `InvestigationTimeline.test.jsx`.
- One-line addition to `App.jsx` to render the new component below the existing chart.
- No changes to `EventTimeline.jsx`, `parseEvidenceCSV`, or the timeline API.

**Architecture decision — new component, not a modification of `EventTimeline`:**
`EventTimeline.jsx` is a Recharts time-series chart that aggregates MAG + EP8 data. Phase
5.3 requires a fundamentally different UI: a scrollable record-by-record list covering all
four source types (CASE, GOES11_EP8, GOES11_MAG, GOES11_EPHEMERIS), with record selection
and inline provenance display. These are orthogonal concerns. Creating a new
`InvestigationTimeline` component keeps both concerns clean and avoids breaking the
existing chart.

**Provenance integration:**
`fetchEvidenceProvenance` is already available from Phase 5.2. The new component uses the
same async pattern established in `ForensicInvestigationView` — click record → call API →
render provenance panel with hypothesis relationships (or "no hypothesis relationships"
for EPHEMERIS).

**Scientific constraints preserved throughout:**
- No causal arrows, causal scores, or probability language.
- The ±10-minute window is labelled "MVP temporal selection window" with the mandated
  disclaimer.
- EPHEMERIS records are shown as timeline observations and explicitly cannot appear as
  hypothesis evidence.
- Observational/environmental data is not linked to causation in any label, tooltip, or
  description.

**Non-goals:**
- No changes to `parseEvidenceCSV`, `buildEvidenceGraph`, or any backend service logic.
- No changes to `EventTimeline.jsx` (the chart).
- No new backend endpoints.
- No changes to `ForensicInvestigationView.jsx`.

---

## Sub-Tasks

---

### Sub-Task 1 — Build `InvestigationTimeline` component

**Intent:**
Create the main component that renders all timeline records in a scrollable list,
distinguishes source types visually, supports record selection, and shows the ±10-minute
heuristic window disclaimer.

**Expected Outcomes:**
- Component accepts `timelineData` (array of 278 records from GET /timeline) and
  `anchorTimestamp` (ISO string) as props.
- All 278 records render in the list (no filtering, all sources shown).
- Each row shows: `evidence_id`, `timestamp`, `source`, `measurement`, `value`, `unit`.
- Source types are visually distinguished:
  - `CASE` — amber (anomaly anchor treatment)
  - `GOES11_EP8` — cyan (environmental observation)
  - `GOES11_MAG` — blue (environmental observation)
  - `GOES11_EPHEMERIS` — slate/muted (positional data; no hypothesis relationship)
- The CASE anchor row is visually prominent (border, label "Anomaly anchor").
- The ±10-minute window boundary is computed from `anchorTimestamp ± 600 seconds`.
  Records within the window get a subtle visual indicator.
- A disclaimer banner above the list reads:
  "MVP temporal selection window — Evidence-selection heuristic; not a scientifically
  calibrated causal threshold."
- EPHEMERIS records include a badge: "Positional data — not hypothesis evidence".
- Clicking any row sets it as selected (toggle: click again to deselect).
- Selected state is stored locally with `useState`.
- The provenance panel (Sub-Task 2) is rendered below the selected row (or at the
  bottom of the component).
- Component is exported as default from `InvestigationTimeline.jsx`.

**Source type constants:**
```
SOURCE_STYLES = {
  CASE:              amber border + amber text
  GOES11_EP8:        cyan border + cyan text
  GOES11_MAG:        blue border + blue text
  GOES11_EPHEMERIS:  slate border + slate text (muted)
}
SOURCE_LABELS = {
  CASE:              "Anomaly anchor"
  GOES11_EP8:        "Particle flux (EP8)"
  GOES11_MAG:        "Magnetic field (MAG)"
  GOES11_EPHEMERIS:  "Ephemeris (positional)"
}
```

**Todo List:**
1. Create `frontend/src/components/InvestigationTimeline.jsx`.
2. Define `SOURCE_STYLES` and `SOURCE_LABELS` constants.
3. Compute `windowStart` and `windowEnd` from `anchorTimestamp ± 600s` using
   `Date` arithmetic. If `anchorTimestamp` is absent, disable window indicators.
4. Implement `isInWindow(timestamp)` helper — returns true if the record's timestamp
   falls within the window.
5. Render a disclaimer banner (`data-testid="temporal-window-banner"`) containing the
   mandated text: "MVP temporal selection window" and the heuristic disclaimer.
6. Render a scrollable list (`data-testid="timeline-list"`) — all records, sorted by
   timestamp ascending (the API already returns them sorted, but sort defensively).
7. For each record row:
   - `data-testid="timeline-row-{evidence_id}"`
   - Source badge with colour from `SOURCE_STYLES`
   - Evidence ID, timestamp, measurement, value+unit
   - Window indicator (`data-testid="window-indicator-{evidence_id}"`) when
     `isInWindow(row.timestamp)` is true
   - EPHEMERIS-only badge (`data-testid="ephemeris-badge-{evidence_id}"`) when
     `source === "GOES11_EPHEMERIS"`
   - CASE-only "Anomaly anchor" badge (`data-testid="anchor-badge"`) for the CASE row
   - Click handler: `handleRowSelect(evidence_id)` — toggles selection
8. Render the provenance panel below the list (Sub-Task 2 wires in the API call).
9. Export as default.

**Relevant Context:**
- `frontend/src/components/ForensicInvestigationView.jsx` — pattern for
  `handleEvidenceSelect`, `provenanceResult` state, and `ProvenancePanel` usage
  from Phase 5.2.
- `frontend/src/api.js` — `fetchEvidenceProvenance(caseId, evidenceId)` is available.
- `EVIDENCE_CATEGORY_STYLES` in `ForensicInvestigationView.jsx` — similar colour
  constants; define analogous `SOURCE_STYLES` independently in the new component.

**Status:** [x] done

---

### Sub-Task 2 — Wire provenance panel into selected record

**Intent:**
When an investigator clicks a timeline row, fetch provenance for that evidence ID and
display the full provenance record (all 12 fields + hypothesis relationships), reusing
the `ProvenancePanel` component from `ForensicInvestigationView.jsx` or implementing
an equivalent inline panel.

**Decision — inline panel, not import of `ProvenancePanel`:**
`ProvenancePanel` is not exported from `ForensicInvestigationView.jsx` (it is an
internal component). Rather than refactoring the existing file, the new component will
implement a self-contained `TimelineProvenancePanel` that renders the same fields using
the same data shape, following the same conventions.

**Expected Outcomes:**
- Clicking a row triggers `fetchEvidenceProvenance("galaxy-15", evidenceId)`.
- While the fetch is pending, a `data-testid="timeline-prov-loading"` indicator shows.
- On success (`found: true`): panel shows all 12 fields + hypothesis relationships.
- On `found: false`: panel shows "Evidence ID not found in timeline" message.
- On network error: panel shows "Provenance lookup failed" message.
- EPHEMERIS records resolve with `hypothesis_relationships: []`; panel shows
  "No hypothesis relationships — record not cited in any hypothesis."
- If a record has hypothesis relationships, each entry renders with:
  - hypothesis_id
  - list_name (human-readable label: "Environmental context", "Supporting evidence", etc.)
  - relationship label
  - interpretation text
- Hypothesis assessment badge appears beside hypothesis_id (looked up from
  `reportHypotheses` prop if supplied; omitted gracefully if prop absent).
- Panel has `data-testid="timeline-provenance-panel"`.
- Deselecting (clicking same row again) clears `provenanceResult` state and hides panel.

**Todo List:**
1. Add `selectedRecordId` state (null initially) and `provenanceResult` state.
2. Implement `handleRowSelect(id)` using the same toggle + async fetch pattern from
   `ForensicInvestigationView.handleEvidenceSelect`.
3. Implement `TimelineProvenancePanel({ provenanceData, reportHypotheses })` as an
   internal sub-component within `InvestigationTimeline.jsx`.
   - Follow the same structure as `ProvenancePanel` in `ForensicInvestigationView.jsx`.
   - Render all 12 fields with `data-testid="tl-prov-{fieldname}"` test IDs.
   - Render hypothesis relationships with
     `data-testid="tl-prov-relationship-{hypothesis_id}"`.
   - Render `data-testid="tl-prov-no-relationships"` when `hypothesis_relationships`
     is empty.
   - Render `data-testid="tl-prov-not-found"` when `found: false`.
   - Render `data-testid="tl-prov-error"` when `_fetchError: true`.
4. Accept optional `reportHypotheses` prop on `InvestigationTimeline` for assessment
   badge lookup (passed from App.jsx via `forensicReport?.hypotheses`).

**Relevant Context:**
- `frontend/src/api.js` — `fetchEvidenceProvenance(caseId, evidenceId)`.
- `frontend/src/components/ForensicInvestigationView.jsx` — `ProvenancePanel` and
  `handleEvidenceSelect` as reference implementation.
- `LIST_NAME_LABELS` in `ForensicInvestigationView.jsx` — redefine the same constants
  locally in the new component.

**Status:** [x] done

---

### Sub-Task 3 — Add `InvestigationTimeline` to `App.jsx`

**Intent:**
Render the new component in the application below the existing `EventTimeline` chart,
passing `timelineData`, `anchorTimestamp`, and `reportHypotheses` from the already-
fetched state.

**Expected Outcomes:**
- `InvestigationTimeline` is imported and rendered below `EventTimeline` in the left
  column.
- Receives:
  - `timelineData={timelineData}` (already in state)
  - `anchorTimestamp={caseMeta?.anchor_event?.timestamp}` (same as EventTimeline)
  - `reportHypotheses={forensicReport?.hypotheses ?? []}` (for assessment badges)
- No new state, no new fetch calls.
- Existing components are unchanged.

**Todo List:**
1. Import `InvestigationTimeline` in `App.jsx`.
2. Add `<InvestigationTimeline>` below the `<EventTimeline>` element (line ~99 in the
   left column `flex flex-col gap-6`).
3. Pass the three props listed above.

**Relevant Context:**
- `frontend/src/App.jsx` — `EventTimeline` rendered at line 96; `forensicReport` already
  in state at line 20.

**Status:** [x] done

---

### Sub-Task 4 — Add `InvestigationTimeline.test.jsx`

**Intent:**
Cover the full set of required test scenarios: timeline loading, record counts, source
identification, selection behaviour, provenance display, heuristic label, and the
EPHEMERIS constraint.

**Test IDs (TL-1 through TL-14):**

| ID | Description |
|----|-------------|
| TL-1  | Component renders without crashing when given an empty timeline |
| TL-2  | All 278 records handled — a timeline of arbitrary size renders all rows |
| TL-3  | CASE anchor row is identifiable by its anchor badge |
| TL-4  | EP8 records render with their source label |
| TL-5  | MAG records render with their source label |
| TL-6  | EPHEMERIS records render with their source label |
| TL-7  | EPHEMERIS records carry the "not hypothesis evidence" badge |
| TL-8  | Selecting a record triggers `fetchEvidenceProvenance` and shows the provenance panel |
| TL-9  | Provenance panel shows all 12 required fields |
| TL-10 | Temporal window disclaimer is present with the mandated text |
| TL-11 | Records within the ±10-minute window have a window indicator |
| TL-12 | Provenance for EPHEMERIS shows "No hypothesis relationships" note |
| TL-13 | No causal language in the rendered output |
| TL-14 | Provenance fetch failure shows error without crashing |

**Implementation notes:**
- Mock `fetchEvidenceProvenance` using `vi.mock('../api')` — same pattern as
  `ForensicInvestigationView.test.jsx`.
- Fixtures:
  - `TIMELINE_FIXTURE` — a representative slice: one CASE record, two EP8, two MAG,
    two EPHEMERIS (7 records total). Use realistic field values with timestamps
    spanning the anomaly window.
  - `PROVENANCE_FIXTURE` — same shape used in Phase 5.2 tests.
  - `PROVENANCE_EPHEMERIS_FIXTURE` — `found: true`, `hypothesis_relationships: []`.
- For TL-2: render with a 278-item array (generated programmatically) and assert
  `timeline-list` contains the correct number of rows.
- For TL-13: assert `container.textContent` does not match causal vocabulary:
  `/\b(causes?|caused|proves?|proved|confirms?|establishes)\b/i`.

**Todo List:**
1. Create `frontend/src/components/InvestigationTimeline.test.jsx`.
2. Add `vi.mock("../api")` with `fetchEvidenceProvenance` as `vi.fn()` (same pattern).
3. Define `TIMELINE_FIXTURE`, `PROVENANCE_FIXTURE`, `PROVENANCE_EPHEMERIS_FIXTURE`.
4. Implement tests TL-1 through TL-14.

**Relevant Context:**
- `frontend/src/components/ForensicInvestigationView.test.jsx` — reference for mock
  setup, `beforeEach`, `waitFor` pattern, and fixture structure.
- `frontend/src/test-setup.js` — global jest-dom matchers (no per-test import needed).
- `frontend/package.json` — vitest + @testing-library/react available.

**Status:** [x] done

---

### Sub-Task 5 — Run full test suites and verify

**Intent:**
Confirm all existing tests still pass and all new tests pass with no regressions.

**Expected Outcomes:**
- Backend: all 144 tests continue to pass (no backend changes).
- Frontend: all existing 47 tests pass + 14 new TL tests pass = 61 total.
- No new console errors or test warnings.

**Todo List:**
1. Run `cd backend && npm test` — verify 144/144 pass.
2. Run `cd frontend && npm test` — verify 61/61 pass.
3. Fix any failures before marking complete.

**Status:** [x] done

---

## Scientific Invariants

| Invariant | Implementation |
|-----------|---------------|
| No causal language | All labels use "observation", "record", "context"; no "caused", "proves", "confirms" |
| ±10-minute window is heuristic | Banner with mandated text: "MVP temporal selection window — Evidence-selection heuristic; not a scientifically calibrated causal threshold." |
| EPHEMERIS not hypothesis evidence | EPHEMERIS rows carry a badge; provenance always shows empty `hypothesis_relationships` |
| Observational separation | Chart (EventTimeline) and record list (InvestigationTimeline) are separate; no implied causal arrow between environmental data and the anomaly |
| No causal score or probability | No numerical confidence, probability, or likelihood rendered anywhere in the component |

## Data Flow

```
App.jsx
  timelineData (already fetched)  ──→  InvestigationTimeline
  anchorTimestamp                  ──→  InvestigationTimeline
  forensicReport?.hypotheses       ──→  InvestigationTimeline (for assessment badges)

InvestigationTimeline
  row click (evidence_id)
      ↓
  fetchEvidenceProvenance("galaxy-15", id)
      ↓
  TimelineProvenancePanel renders:
    ┌─ 12 raw evidence fields ──────────────────────────────────────┐
    └─ hypothesis_relationships (or "No hypothesis relationships") ──┘
```
