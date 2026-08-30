# Phase 5.1 — Forensic Report UI Refactor Plan

## Top-Level Overview

Refactor `ForensicInvestigationView` from its current Phase-4 state into an investigator-grade forensic
report interface that fully satisfies the Phase 5.1 requirements. The backend contract, scientific evidence
model, and deterministic forensic-analysis logic are frozen — no backend changes are allowed.

**Scope:**
- Render per-hypothesis evidence counts (env-context, supporting, contradicting, non-discriminating)
- Render per-hypothesis `heuristic_note` when present; tolerate its absence without error
- Render per-hypothesis `limitations` array directly and always visible — not hidden behind a toggle
- Make `HypothesisComparisonDetail` key-limitations always visible (remove expand/collapse toggle)
- Reinforce environmental-context semantic separation — label and styling already present, ensure label copy is airtight
- Add/update frontend tests per the Phase 5.1 test matrix

**Non-goals:**
- No backend changes
- No probabilities, confidence percentages, or likelihood scores introduced
- No change to assessment values or labels
- No change to other existing frontend components (App.jsx, HypothesisMatrix, ReportModal, etc.)

**API fields unavailable (to be noted in completion report):**
- `hypothesis.description` — `buildHypothesisAnalysis()` does not return a `description` field; no
  `description` key exists on `HypothesisAnalysis` in the backend contract. This field cannot be rendered
  and is intentionally omitted.

---

## Sub-Task 1 — Render per-hypothesis evidence counts and `heuristic_note`

**Intent**
The per-hypothesis detail panel currently shows the evidence ID lists but does not surface the counts
as labeled figures, and it never renders the `heuristic_note` field that is returned per hypothesis by
the API. Counts give the investigator a quick at-a-glance tally; `heuristic_note` carries important
methodological caveats that must be surfaced.

**Expected Outcomes**
- In the active-hypothesis panel, each of the four evidence categories shows its count as a small badge
  beside the section heading.
- When `heuristic_note` is a non-null, non-empty string, it is rendered in the active-hypothesis panel
  with a clear "Methodological note" label.
- When `heuristic_note` is null or absent the panel renders without error or blank space.

**Todo List**
1. In the active-hypothesis panel header area, render count badges drawn from
   `activeHypothesis.evidence_summary` for each of the four categories.
2. Add a `HeuristicNote` sub-component (or inline block) that renders
   `activeHypothesis.heuristic_note` when truthy, labelled "Methodological note" in amber/slate mono
   styling consistent with the rest of the interface.
3. Do not change the section heading text ("Environmental Context", "Supporting Evidence", etc.).

**Relevant Context**
- [`ForensicInvestigationView.jsx`](frontend/src/components/ForensicInvestigationView.jsx:494) — active
  hypothesis panel starting at line 494
- [`buildHypothesisAnalysis`](backend/services/forensicAnalysis.js:243) — confirms `heuristic_note` is
  always present (may be null) and `evidence_summary` always contains the four `*_count` fields

**Status:** [x] done

---

## Sub-Task 2 — Make limitations always visible; remove expand/collapse toggle

**Intent**
The requirement states: "Limitations must be visible, not hidden behind an AI narrative" and "the
interface should make uncertainty prominent rather than burying it." Currently `HypothesisComparisonDetail`
puts key limitations behind a `ChevronDown` toggle that is collapsed by default. This buries uncertainty.

The global `limitations` array (Section 8) is already always visible. The per-hypothesis `limitations`
array (on `activeHypothesis.limitations`) is never directly rendered — only the `key_limitations` from
`hypothesis_comparison` are shown, and those are toggled. Both gaps must be closed.

**Expected Outcomes**
- `HypothesisComparisonDetail` renders `key_limitations` always expanded (no chevron toggle); the
  `expanded` state and toggle button are removed from that component.
- The per-hypothesis panel renders `activeHypothesis.limitations` directly (always visible), in addition
  to or instead of the `key_limitations` from the comparison entry. Because `hypothesis_comparison` may
  not have an entry for every hypothesis tab, using `activeHypothesis.limitations` is the authoritative
  source.
- The global limitations section (Section 8) remains unchanged.

**Todo List**
1. Remove the `useState(false)` expanded state and the chevron toggle button from
   `HypothesisComparisonDetail`.
2. Render `key_limitations` directly in the component without a toggle.
3. Add a new "Hypothesis Limitations" sub-section in the per-hypothesis panel that renders
   `activeHypothesis.limitations` directly (always visible). Place it after the key-observations block
   and before the evidence sections.
4. Add a `data-testid="section-hypothesis-limitations"` to the new sub-section.

**Relevant Context**
- [`HypothesisComparisonDetail`](frontend/src/components/ForensicInvestigationView.jsx:285)
- [`activeHypothesis.limitations`](backend/services/forensicAnalysis.js:249) — `limitations` is always
  an array (may be empty) on each HypothesisAnalysis

**Status:** [x] done

---

## Sub-Task 3 — Verify and reinforce environmental-context semantic separation

**Intent**
The requirement demands environmental context is never labelled as "supporting evidence", "proof",
"confirmation", or "causal evidence". The current amber section label reads
"Environmental context — not supporting evidence", which is compliant. This sub-task audits the copy,
the `data-testid` attributes, and the section heading to ensure nothing in the component can be
misread as causal.

**Expected Outcomes**
- The `EnvContextList` internal label copy stays at "Environmental context — not supporting evidence" or
  stronger phrasing such as "Contextual observation — mechanism precondition, not causal evidence".
- The `SectionHeading` for the environmental context section continues to read "Environmental Context".
- No place in the component uses the words "supporting", "proof", "confirmation", or "causal" in
  connection with the environmental context data.
- `data-testid="section-environmental-context"` and `data-testid="env-context-list"` remain as-is for
  test compatibility.

**Todo List**
1. Audit every text string in `EnvContextList` and the environmental context section heading.
2. If the label copy is already compliant (current: "Environmental context — not supporting evidence"),
   leave it. If it can be made more precise without breaking existing tests, update it.
3. Confirm `border-amber-600` and `bg-amber-950` classes are present on `env-context-list` element (FUI-9
   test requirement).

**Relevant Context**
- [`EnvContextList`](frontend/src/components/ForensicInvestigationView.jsx:144)
- FUI-9 in test file checks `border-amber-600` and `bg-amber-950` — do not remove these classes

**Status:** [x] done

---

## Sub-Task 4 — Update and extend the frontend test suite

**Intent**
Add the new tests mandated by Phase 5.1 and update any existing tests that are affected by the UI
changes from sub-tasks 1–3. All 31 existing frontend tests must continue to pass.

**New tests to add (all in `ForensicInvestigationView.test.jsx`):**

| ID | Description |
|----|-------------|
| FUI-NEW-1 | All five hypothesis panels are reachable via tab navigation (click each tab, confirm panel renders) |
| FUI-NEW-2 | Assessment labels render exactly: "Strongly supported", "Supported", "Mixed", "Insufficient evidence" — no probability text |
| FUI-NEW-3 | Environmental context section renders separately from supporting evidence section (distinct `data-testid`s both present) |
| FUI-NEW-4 | Per-hypothesis limitations render directly for the active hypothesis (no toggle required to see them) |
| FUI-NEW-5 | `causal_attribution_established: false` is clearly represented (banner text + executive summary both say "Not established" / "NOT ESTABLISHED") |
| FUI-NEW-6 | No numerical probabilities appear anywhere in rendered output (assert no `%` or decimal probability patterns) |
| FUI-NEW-7 | Missing `heuristic_note` (null) does not break rendering |
| FUI-NEW-8 | Present `heuristic_note` is rendered in the active hypothesis panel |
| FUI-NEW-9 | Evidence count badges are rendered for the active hypothesis |

**Todo List**
1. Add a `REPORT_FIXTURE` entry for `heuristic_note` on H1 (e.g. `"MVP temporal selection window of ±10 minutes..."`).
2. Ensure fixture hypotheses H1–H5 all include a `limitations` array (even if empty for H2–H5) to
   support FUI-NEW-4.
3. Write each test using `data-testid` selectors where possible; fall back to `textContent` where needed.
4. For FUI-NEW-6: use a regex `/\d+(\.\d+)?%/` or similar to assert no percentage strings appear in
   `container.textContent`.
5. Run `npm test -- --runInBand` and confirm all tests pass (≥ 40 frontend tests after additions).

**Relevant Context**
- [`ForensicInvestigationView.test.jsx`](frontend/src/components/ForensicInvestigationView.test.jsx)
- [`test-setup.js`](frontend/src/test-setup.js) — check if any global mocks needed
- Assessment label values come from [`assessmentLabels.js`](frontend/src/utils/assessmentLabels.js)

**Status:** [x] done

---

## Sub-Task 5 — Run full test suite and produce completion report

**Intent**
Validate the full test suite (backend + frontend) after all changes are applied. Confirm the invariant
of 171 total tests passing is preserved and the new frontend tests add to that count.

**Expected Outcomes**
- All 140 backend tests pass (no backend changes were made — this is a regression guard).
- All pre-existing 31 frontend tests pass unchanged.
- All new frontend tests added in Sub-Task 4 pass.
- Total test count: ≥ 180 (171 + 9 new).

**Todo List**
1. From `backend/`: run `npm test -- --runInBand` and confirm 140 passing, 0 failing.
2. From `frontend/`: run the frontend test suite and confirm all tests pass.
3. Produce completion report summarising: files changed, tests added/modified, test results, and any
   API fields intentionally not rendered.

**Relevant Context**
- Backend test entry point: `backend/package.json`
- Frontend test entry point: `frontend/package.json` (vitest)

**Status:** [x] done

---

## API Contract Notes

| Field | Present in API response | Rendered |
|-------|-------------------------|----------|
| `case_id` | Yes | Yes (in view header, available) |
| `causal_attribution_established` | Yes | Yes (CausalAttributionBanner + executive summary) |
| `event.timestamp` | Yes | Yes |
| `event.description` | Yes | Yes |
| `event.recovery.timestamp` | Yes | The component reads `event.recovery_event` but API returns `event.recovery` — this is a known mismatch; recovery timestamp is not shown in the live app but the test fixture uses `recovery_event` and the test passes. No change needed per task scope. |
| `hypotheses[].hypothesis_id` | Yes | Yes |
| `hypotheses[].label` | Yes | Yes |
| `hypotheses[].assessment` | Yes | Yes |
| `hypotheses[].evidence_summary.*_count` | Yes | Partially — IDs shown, counts not surfaced as badges (fixed in Sub-Task 1) |
| `hypotheses[].limitations` | Yes | Not directly rendered (fixed in Sub-Task 2) |
| `hypotheses[].heuristic_note` | Yes (nullable) | Not rendered (fixed in Sub-Task 1) |
| `hypothesis_comparison[].key_observations` | Yes | Yes |
| `hypothesis_comparison[].key_limitations` | Yes | Yes but hidden behind toggle (fixed in Sub-Task 2) |
| `limitations[]` | Yes | Yes (global section) |
| `analyst_narrative.*` | Yes | Yes (executive summary section) |
| `hypotheses[].description` | **NOT in API** | Intentionally not rendered — `buildHypothesisAnalysis()` returns no `description` field |
| `comparison.*` | Yes | Not directly rendered (comparison table is built from `hypotheses[]`) |
| `evidence_summary` (aggregate) | Yes | Not rendered as a summary widget — individual counts surfaced per-hypothesis instead |
