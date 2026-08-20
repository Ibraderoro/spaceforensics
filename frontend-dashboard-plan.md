# Phase 4 — React Dashboard Frontend Plan

## Top-Level Overview

Build a dark-mode, scientific command-center frontend in `frontend/` using Vite + React +
Tailwind CSS + Recharts + Lucide Icons. The dashboard renders the Galaxy 15 case investigation
state — timeline data, hypothesis confidence scores, and red-team challenge output — by
consuming the running Express API at `http://localhost:5001`.

**Key Data Flow:**
1. On load: fetch `GET /api/cases/galaxy-15` (case metadata) + `GET /api/cases/galaxy-15/timeline` (278 records)
2. On "Investigate": `POST /api/cases/galaxy-15/investigate` → Pass 1 hypothesis scores
3. On "Challenge": `POST /api/cases/galaxy-15/challenge` → Pass 2 red-team counter-evidence + updated scores
4. On "Export Report": compile current investigation state into a modal forensic summary

**Design Aesthetic:** `bg-slate-950 text-slate-100` — space command center with
amber/cyan accent colours, monospace data labels, and minimal chrome.

**No proxy required** — CORS is fully enabled (`app.use(cors())`) on the backend, so the
frontend can fetch `http://localhost:5001/api` directly.

---

## Sub-Tasks

---

### Sub-Task 1 — Scaffold Vite + React App

**Intent**
Bootstrap `frontend/` as a Vite + React project and install all runtime dependencies
(Tailwind CSS, Lucide Icons, Recharts) so the dev server starts cleanly before any
components are written.

**Expected Outcomes**
- `frontend/package.json` exists with Vite, React, Tailwind CSS, Lucide, and Recharts dependencies.
- `npm run dev` inside `frontend/` starts the Vite dev server on port 5173 with no errors.
- `frontend/tailwind.config.js` and `frontend/postcss.config.js` exist.
- `frontend/src/index.css` imports Tailwind base/components/utilities.
- `frontend/index.html` is the Vite HTML entry point.
- Background of the default rendered page is `bg-slate-950` (dark slate).

**Todo List**

1. Run `npm create vite@latest frontend -- --template react` from the workspace root.
2. Run `npm install` inside `frontend/`.
3. Run `npm install recharts lucide-react` inside `frontend/`.
4. Run `npm install -D tailwindcss postcss autoprefixer` inside `frontend/`.
5. Run `npx tailwindcss init -p` inside `frontend/` to generate `tailwind.config.js` and `postcss.config.js`.
6. Configure `tailwind.config.js` content paths to `["./index.html", "./src/**/*.{js,jsx}"]`.
7. Replace the body of `frontend/src/index.css` with Tailwind directives (`@tailwind base/components/utilities`).
8. Set `frontend/src/App.jsx` to a minimal `<div className="min-h-screen bg-slate-950 text-slate-100">` shell.
9. Confirm `npm run dev` starts without errors.

**Relevant Context**

- Backend runs on port 5001. CORS is unrestricted — no Vite proxy config needed.
- Node.js package manager: npm (as used in backend).
- Vite default dev port: 5173.

**Status** — `[x] complete`

---

### Sub-Task 2 — Create `api.js` Service Module

**Intent**
Centralise all backend API calls in one module so components import typed fetch helpers
rather than constructing raw URLs. Every component that talks to the backend uses this module.

**Expected Outcomes**
- `frontend/src/api.js` exports five async functions:
  - `fetchCaseMeta()` → GET /api/cases/galaxy-15
  - `fetchTimeline()` → GET /api/cases/galaxy-15/timeline
  - `fetchEvidenceGraph()` → GET /api/cases/galaxy-15/evidence-graph
  - `postInvestigate()` → POST /api/cases/galaxy-15/investigate
  - `postChallenge()` → POST /api/cases/galaxy-15/challenge
- All functions throw on non-2xx responses with a descriptive message.
- Base URL is a constant `API_BASE = "http://localhost:5001"`.

**Expected Response Shapes (for component reference):**

`fetchTimeline()` → `Array<{ timestamp, source, measurement, value, unit, resolution }>`
- 278 records, sorted ascending by timestamp
- source values: `GOES11_EP8`, `GOES11_MAG`, `GOES11_EPHEMERIS`, `CASE`

`postInvestigate()` →
```
{
  hypotheses: [{ id, label, confidence, supporting_evidence, reasoning }],
  top_hypothesis_id: string,
  source: "llm" | "deterministic",
  generated_at: string
}
```

`postChallenge()` →
```
{
  case_id: string,
  pass1_hypotheses: [...],
  challenged_hypothesis_id: string,
  counter_evidence: [{ type, description, confidence_impact }],
  updated_hypotheses: [{ id, label, confidence, reasoning }],
  red_team_summary: string,
  source: "llm" | "deterministic",
  generated_at: string
}
```

**Todo List**
1. Create `frontend/src/api.js`.
2. Define `API_BASE = "http://localhost:5001"`.
3. Implement each of the five exported async fetch functions.
4. Use `response.ok` guard; throw `new Error(...)` with status + endpoint on failure.

**Relevant Context**
- `backend/server.js` — all six routes documented. CORS unrestricted.
- The `/challenge` endpoint takes no request body (POST with empty body is valid).

**Status** — `[ ] pending`

---

### Sub-Task 3 — Build `Header.jsx`

**Intent**
Render the persistent top bar that communicates the active case identity and system status
at a glance. No dynamic data fetching — accepts case metadata as a prop.

**Expected Outcomes**
- `frontend/src/components/Header.jsx` renders:
  - Application title: "SPACEFORENSICS" in monospace, large, bright white.
  - Case badge: "Galaxy 15 — GEO −133.0° W" with a pulsing amber dot indicating active case.
  - Telemetry status chips: "GOES-11 MAG ✓", "GOES-11 EP8 ✓", "EPHEMERIS ✓" in green.
  - A case selector dropdown (static for now — only "Galaxy 15" option).
- Uses only Tailwind utility classes and Lucide icons (no custom CSS).
- Sticky at top of page (Tailwind `sticky top-0 z-50`).

**Todo List**
1. Create `frontend/src/components/Header.jsx`.
2. Accept prop `caseMeta` (the GET /api/cases/galaxy-15 response object).
3. Render a `<header>` with `bg-slate-900 border-b border-slate-700 sticky top-0 z-50`.
4. Left side: satellite icon (Lucide `Satellite`) + "SPACEFORENSICS" title.
5. Center: case name + longitude badge using `caseMeta.target_asset`.
6. Right side: three status chips using Lucide `Activity` icon, green dot style.
7. Import and use in `App.jsx`.

**Relevant Context**
- `caseMeta.target_asset.name` = "Galaxy 15"
- `caseMeta.target_asset.longitude_deg_west` = -133.0
- `caseMeta.target_asset.orbit_type` = "GEO"

**Status** — `[ ] pending`

---

### Sub-Task 4 — Build `EventTimeline.jsx`

**Intent**
Render the multi-series Recharts `ComposedChart` that plots the GOES-11 MAG and EP8 data
across the 3-hour investigation window with a vertical reference line at the anomaly timestamp.
This is the primary scientific visualisation of the dashboard.

**Expected Outcomes**
- `frontend/src/components/EventTimeline.jsx`:
  - Accepts `timelineData` prop (array of 278 evidence records).
  - Filters and pivots data into two Recharts series:
    - `GOES11_MAG` (`b_gsm` in nT) — rendered as a cyan Line.
    - `GOES11_EP8` (`e_flux` in cm⁻²s⁻¹sr⁻¹keV⁻¹) — rendered as an amber Line on a secondary Y-axis.
  - X-axis: time from "08:00" to "11:00" UTC (formatted as HH:mm from ISO timestamp).
  - Primary Y-axis (left): magnetic field magnitude, labelled "B-field (nT)".
  - Secondary Y-axis (right): electron flux on a log scale, labelled "e-flux (log)".
  - `ReferenceLine` at x = "09:48" with label "Galaxy 15 Anomaly" in red/amber.
  - Tooltip showing time + both values on hover.
  - Recharts `ResponsiveContainer` fills the card width.
  - Card wrapper: `bg-slate-900 rounded-xl p-4 border border-slate-700`.

**Todo List**
1. Create `frontend/src/components/EventTimeline.jsx`.
2. Accept `timelineData: Array` and `anchorTimestamp: string` props.
3. Filter `timelineData` to only `GOES11_MAG` and `GOES11_EP8` source rows.
4. Pivot rows into a flat array keyed by formatted time string (HH:mm:ss) with `mag` and `eFlux` fields.
5. Use `ComposedChart` with `Line` for MAG (left Y-axis) and `Line` for EP8 (right `YAxis` with `yAxisId="right"`).
6. Set EP8 Y-axis to logarithmic scale (`scale="log"` on `YAxis`).
7. Add `ReferenceLine x="09:48:00" stroke="#ef4444"` with a custom label.
8. Add `Legend`, `CartesianGrid`, `Tooltip` for full interactivity.
9. Import and use in `App.jsx`.

**Relevant Context**
- Timeline pivot: group by formatted timestamp, merge MAG and EP8 into same row object.
- GOES11_MAG rows: `measurement = "b_gsm"`, `unit = "nT"`, 180 records, 1-min resolution.
- GOES11_EP8 rows: `measurement = "e_flux"`, `unit = "cm-2 s-1 sr-1 keV-1"`, 36 records, 5-min resolution.
- Anchor event: `"2010-04-05T09:48:00Z"` — extract "09:48:00" for Recharts x-key lookup.

**Status** — `[ ] pending`

---

### Sub-Task 5 — Build `HypothesisMatrix.jsx`

**Intent**
Render the three competing hypotheses with animated horizontal progress bars displaying
confidence scores. This component reflects both the initial Pass 1 state and the
updated scores after the red-team pass.

**Expected Outcomes**
- `frontend/src/components/HypothesisMatrix.jsx`:
  - Accepts `hypotheses` prop — array of `{ id, label, confidence, reasoning }` objects.
  - Renders one card per hypothesis (3 cards in a responsive grid).
  - Each card shows: hypothesis label, confidence percentage, a colour-coded progress bar
    (green ≥70, amber 40–69, red <40), and the reasoning text in smaller muted font.
  - Progress bar is a `<div>` with Tailwind `transition-all duration-700` so score changes animate smoothly.
  - Top-ranked hypothesis (highest confidence) gets a "LEAD" badge.
  - When `hypotheses` is empty/null, renders a prompt to click "Investigate".

**Todo List**
1. Create `frontend/src/components/HypothesisMatrix.jsx`.
2. Accept `hypotheses` prop (nullable).
3. Sort the array by `confidence` descending before rendering.
4. Map each hypothesis to a card with: title, confidence number, progress bar, reasoning excerpt.
5. Use `style={{ width: \`${confidence}%\` }}` on the progress bar inner div.
6. Colour logic: `confidence >= 70` → `bg-green-500`, 40–69 → `bg-amber-500`, else `bg-red-500`.
7. Apply `transition-all duration-700` to the progress bar inner div for animated recalibration.
8. Import and use in `App.jsx`.

**Relevant Context**
- Data comes from `postInvestigate()` (Pass 1) or `postChallenge().updated_hypotheses` (Pass 2).
- The three hypothesis IDs: `surface_charging_esd`, `single_event_upset`, `hardware_failure`.

**Status** — `[ ] pending`

---

### Sub-Task 6 — Build `RedTeamPanel.jsx`

**Intent**
Provide the red-team challenge action button and render the counter-evidence list with
animated confidence recalibration after the challenge response arrives. This is the primary
interactive element of the dashboard.

**Expected Outcomes**
- `frontend/src/components/RedTeamPanel.jsx`:
  - Renders a prominent "🔥 Challenge This Conclusion (Red-Team Pass)" button in red/amber styling.
  - On click: calls `postChallenge()` from `api.js`, shows a loading spinner during the request.
  - On success: calls the `onChallengeComplete(data)` callback prop with the full response.
  - Renders counter-evidence list below the button once data is available:
    - Each item shows: `type` badge (colour-coded), `description`, and `confidence_impact` (red badge, e.g. "−15").
  - Renders the `red_team_summary` paragraph in italic muted text.
  - Renders source badge: "🤖 LLM" (blue) or "⚙️ Deterministic" (slate) based on `data.source`.
  - Button is disabled and shows spinner while loading.
  - Error state shows inline error message in red.

**Todo List**
1. Create `frontend/src/components/RedTeamPanel.jsx`.
2. Accept props: `onChallengeComplete(data)`, `challengeData` (nullable, the response).
3. Local state: `loading` (bool), `error` (string|null).
4. On button click: set `loading = true`, call `postChallenge()`, call `onChallengeComplete(data)`,
   set `loading = false`.
5. Render button with Lucide `Flame` icon, `bg-red-700 hover:bg-red-600` styling.
6. If `loading`, show Lucide `Loader2` with `animate-spin` class inside button.
7. Map `challengeData.counter_evidence` to list items with type badge and impact badge.
8. Render `challengeData.red_team_summary` in a blockquote styled card.
9. Import and use in `App.jsx`.

**Relevant Context**
- `postChallenge()` returns the full challenge response shape (see Sub-Task 2).
- `counter_evidence[].type` values: `"sensor_limitation"`, `"missing_signature"`, `"contradicting_data"`.
- `counter_evidence[].confidence_impact` is a negative integer (e.g. -15).
- The backend POST /challenge takes no body — empty POST is valid.

**Status** — `[ ] pending`

---

### Sub-Task 7 — Build `ReportModal.jsx`

**Intent**
Compile the current investigation state into an audit-ready Forensic Summary Report
displayed in a full-screen modal. This is for export/review, not further interaction.

**Expected Outcomes**
- `frontend/src/components/ReportModal.jsx`:
  - Triggered by an "Export Report" button in `App.jsx`.
  - Renders as a full-screen overlay (`fixed inset-0 z-50 bg-black/80 backdrop-blur-sm`).
  - Report sections (rendered as styled divs, not actual print):
    1. **Case Header**: case title, case ID, target asset, investigation timestamp.
    2. **Data Window**: start/end time, duration, data sources list.
    3. **Pass 1 Hypotheses**: table of all 3 hypotheses with confidence scores and reasoning.
    4. **Red-Team Challenge** (if available): challenged hypothesis, counter-evidence table,
       updated confidence scores.
    5. **Scientific Limitations**: list from `caseMeta.scientific_limitations`.
    6. **Red-Team Summary**: paragraph from `challengeData.red_team_summary`.
  - Close button (Lucide `X`) in top-right corner.
  - "Print / Save PDF" button using `window.print()`.

**Todo List**
1. Create `frontend/src/components/ReportModal.jsx`.
2. Accept props: `isOpen` (bool), `onClose()`, `caseMeta`, `hypotheses`, `challengeData`.
3. Render nothing when `isOpen = false`.
4. Render overlay div with inner white-on-dark report card, `overflow-y-auto max-h-screen`.
5. Build each section as a named `<section>` with a heading and content.
6. For the hypotheses table: use an HTML `<table>` styled with Tailwind.
7. For counter-evidence: render as a list if `challengeData` is not null, else show placeholder.
8. Add `window.print()` button (will print what the browser sees in the modal).
9. Import and conditionally render in `App.jsx` based on `showReport` state.

**Relevant Context**
- `caseMeta.scientific_limitations` — array of 6 strings from `case.json`.
- `caseMeta.data_sources` — array of 3 dataset objects with `instrument`, `parameter` fields.
- `challengeData` may be null if user has not run the challenge yet.

**Status** — `[ ] pending`

---

### Sub-Task 8 — Assemble `App.jsx`

**Intent**
Wire all components together in `App.jsx` with shared state management. Fetch initial data
on mount, coordinate the investigate/challenge flow, and pass correct props down to each component.

**Expected Outcomes**
- `frontend/src/App.jsx` manages all top-level state:
  - `caseMeta` — case metadata (from `fetchCaseMeta`)
  - `timelineData` — 278 records (from `fetchTimeline`)
  - `hypotheses` — Pass 1 array (from `postInvestigate` or initial null)
  - `challengeData` — full challenge response (from `postChallenge` or null)
  - `showReport` — boolean for report modal
  - `loading` — initial data loading state
- Layout: sticky Header, then a 2-column grid: left=timeline+hypothesis matrix, right=red-team panel.
- "Investigate" button in App (or HypothesisMatrix) calls `postInvestigate()` and sets `hypotheses`.
- `RedTeamPanel.onChallengeComplete` sets `challengeData` and merges updated scores into `hypotheses`.
- `HypothesisMatrix` always reflects the latest (Pass 1 or Pass 2-adjusted) scores.
- Export Report button sets `showReport = true`.
- Loading state shows a full-page spinner before initial data arrives.

**Todo List**
1. Replace `frontend/src/App.jsx` contents with the assembled layout.
2. Import all 5 components: Header, EventTimeline, HypothesisMatrix, RedTeamPanel, ReportModal.
3. Import all 5 api functions from `./api.js`.
4. On mount (`useEffect`), call `fetchCaseMeta()` and `fetchTimeline()` in parallel (`Promise.all`).
5. Set `caseMeta` and `timelineData` state on resolution.
6. Render full-page `Loader2` spinner (`animate-spin`) while `loading = true`.
7. Render main layout: `<Header caseMeta={caseMeta} />` at top.
8. Below header: responsive grid `grid grid-cols-1 xl:grid-cols-3 gap-6 p-6`.
9. Left column (col-span-2): `<EventTimeline>` + "Investigate" button + `<HypothesisMatrix>`.
10. Right column (col-span-1): `<RedTeamPanel>` + Export Report button.
11. Render `<ReportModal>` at end of JSX tree.

**Relevant Context**
- Pass 2 response `updated_hypotheses` replaces `hypotheses` state after challenge.
- `challengeData.updated_hypotheses` has the same shape as Pass 1 `hypotheses`.
- `caseMeta.anchor_event.timestamp` = `"2010-04-05T09:48:00Z"` — pass to `EventTimeline`.

**Status** — `[ ] pending`

---

### Sub-Task 9 — Verification

**Intent**
Confirm the complete dashboard renders correctly, the timeline chart displays both data series,
and the challenge flow dynamically updates confidence scores.

**Expected Outcomes**
- `npm run dev` inside `frontend/` starts on port 5173 with no errors.
- http://localhost:5173 loads a dark-mode dashboard with the timeline chart rendered.
- Clicking "Investigate" populates the HypothesisMatrix with 3 cards and confidence scores.
- Clicking "🔥 Challenge This Conclusion" shows a loading spinner, then replaces hypothesis
  scores with updated values and renders counter-evidence list.
- The confidence progress bars animate smoothly when scores update.
- Clicking "Export Report" opens the ReportModal with all sections populated.
- No JavaScript console errors.

**Todo List**
1. Ensure `backend/` is running: `cd backend && node server.js` (port 5001).
2. Start frontend: `cd frontend && npm run dev`.
3. Open http://localhost:5173 — verify dark background, header, and timeline chart.
4. Click "Investigate" — verify 3 hypothesis cards appear with scores and reasoning.
5. Click "🔥 Challenge This Conclusion" — verify loading spinner, then counter-evidence list.
6. Confirm confidence bars animate (visible transition from old to new score).
7. Click "Export Report" — verify modal opens with case header, hypotheses table, and limitations.
8. Open browser DevTools console — confirm zero JS errors.

**Relevant Context**
- Backend must be running at port 5001 before frontend dev server is started.
- CORS is unrestricted on backend — no proxy config needed.
- Deterministic fallback in `aiEngine.js` means AI endpoints work without a Watsonx API key.

**Status** — `[ ] pending`

---

## File Map

```
frontend/
├── index.html                      ← Vite entry point
├── package.json                    ← vite, react, tailwindcss, recharts, lucide-react
├── tailwind.config.js              ← content: ["./index.html","./src/**/*.{js,jsx}"]
├── postcss.config.js               ← autoprefixer plugin
├── vite.config.js                  ← default Vite React config (no proxy needed)
└── src/
    ├── index.css                   ← @tailwind base/components/utilities
    ├── main.jsx                    ← ReactDOM.createRoot entry
    ├── App.jsx                     ← root component, state, layout
    ├── api.js                      ← all fetch helpers (API_BASE = localhost:5001)
    └── components/
        ├── Header.jsx              ← sticky top bar
        ├── EventTimeline.jsx       ← Recharts multi-series chart
        ├── HypothesisMatrix.jsx    ← confidence progress bar grid
        ├── RedTeamPanel.jsx        ← challenge button + counter-evidence list
        └── ReportModal.jsx         ← full-screen audit report overlay
```

## Dependency Versions

| Package | Role |
|---------|------|
| vite | Build tool / dev server |
| react + react-dom | UI framework |
| tailwindcss | Utility CSS |
| postcss + autoprefixer | CSS processing |
| recharts | Timeline chart |
| lucide-react | Icon set |

No version pinning required — latest stable of all packages.
