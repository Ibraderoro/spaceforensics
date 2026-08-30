# Phase 5.5 — Investigator Workflow & Scientific UX Audit Plan

## Overview

A final UX and scientific-integrity pass over the Phase 5 investigator interface. The goal is to ensure an investigator unfamiliar with the codebase can answer the seven core questions (what happened, what evidence exists, which hypotheses were considered, what evidence relates to each, which observations are environmental context, what remains unknown, why causal attribution is not established) without requiring knowledge of the implementation.

**Scope:** Frontend-only UX polish, scientific-language audit, and test gap filling. No new backend scientific logic. No changes to evidence IDs, assessments, `causal_attribution_established`, evidence relationships, limitations, or deterministic analysis.

**Non-goals:**
- No new backend routes or data transformations
- No re-architecture of components
- No changes to the evidence graph or forensic analysis engine

**Constraints confirmed by code research:**
- The language audit found **zero user-facing strings implying proof, certainty, probability, or causation**. All existing labels are already compliant. No rewrites required.
- Loading and error states exist in `App.jsx` with `data-testid` attributes. `ForensicInvestigationView` renders a loading placeholder for `report=null` but lacks a dedicated `data-testid`.
- Three critical test-gap categories: (1) loading states, (2) accessibility/ARIA labels, (3) empty evidence states.
- Backend tests are complete and comprehensive — no backend test changes needed.

---

## Sub-Tasks

---

### Sub-Task 1 — Scientific Language Audit & Terminology Verification

**Status:** [x] done

**Intent**
Confirm no user-facing string in any frontend component implies proof, certainty, causation, probability, confidence percentage, likelihood, or confirmed mechanism. Replace any such strings found. This is the gating sub-task; if violations are found they must be resolved before proceeding.

**Expected Outcomes**
- Grep report of all matches for: `proof`, `proven`, `confirmed`, `likelihood`, `probability`, `confidence`, `certainty`, `caused the`, `definitely`, `%` (excluding test assertions and code comments) returns zero user-facing matches.
- All assessment labels remain categorical: Strongly supported / Supported / Mixed / Weakly supported / Insufficient evidence.
- Causal attribution language is limited to the explicit `causal_attribution_established` field with "NOT ESTABLISHED" / "ESTABLISHED" rendering.

**Todo List**
1. Run grep across `frontend/src/` (excluding `*.test.*`) for the above patterns. Record every match with file and line number.
2. For each match, determine if it is: (a) a code comment only, (b) a test assertion intentionally checking absence, or (c) a real user-facing string violating scientific integrity.
3. Rewrite any category-(c) violations using the approved vocabulary: "consistent with", "environmental context", "supported", "mixed", "insufficient evidence", "causal attribution not established".
4. Document each change or confirm no changes required.

**Relevant Context**
- Code research confirmed no violations exist in current code. This step is verification + documentation only.
- Approved vocabulary: `frontend/src/components/ForensicInvestigationView.jsx` and `EvidenceGraphExplorer.jsx` already use correct language.
- Test assertions checking absence of these terms: `ForensicInvestigationView.test.jsx` lines ~521/566, `EvidenceGraphExplorer.test.jsx` line ~355, `InvestigationTimeline.test.jsx` line ~359.

---

### Sub-Task 2 — Loading State, Error State & Empty State Test Coverage

**Status:** [x] done

**Intent**
Add tests covering all three "null/failure" UI states across the three main Phase-5 components. These states were identified as critical gaps: (1) loading indicator when data is null/pending, (2) provenance API failure graceful handling, (3) empty-evidence hypothesis rendering.

**Expected Outcomes**
- Each of the three components has an explicit test asserting the correct loading placeholder renders when data is absent.
- Each component has an explicit test for when `fetchEvidenceProvenance` rejects (network error), verifying the error message appears and the component does not crash.
- `ForensicInvestigationView` has a test for a hypothesis with zero evidence across all four lists (empty evidence_summary — matches H4 profile).
- `EvidenceGraphExplorer` has a test for a hypothesis with completely empty relationship lists.
- `InvestigationTimeline` has a test for an empty timeline array (no records).

**Todo List**
1. In `ForensicInvestigationView.test.jsx`:
   - Add test: `report={null}` renders loading placeholder (assert on existing `data-testid="forensic-investigation-view"` or the null-report text that currently renders).
   - Add test: `fetchEvidenceProvenance` throws → component renders error message without crashing (`data-testid="prov-error"`).
   - Add test: H4 hypothesis (zero evidence in all lists) renders the empty-evidence sections without crashing.

2. In `InvestigationTimeline.test.jsx`:
   - Add test: empty `timelineData={[]}` renders header, filter tabs, and temporal banner (no crash); assert `data-testid="timeline-list"` exists but is empty.
   - Add test: provenance fetch throws → `data-testid="tl-prov-error"` appears.

3. In `EvidenceGraphExplorer.test.jsx`:
   - Add test: `evidenceGraph={null}` renders loading state (assert existing loading text); if component lacks `data-testid="evidence-graph-loading"`, add the attribute to the component first.
   - Add test: provenance fetch throws → `data-testid="explorer-prov-error"` appears.
   - Add test: hypothesis with all four relationship lists empty renders "None for this hypothesis." messages without crashing.

4. If `EvidenceGraphExplorer` lacks `data-testid="evidence-graph-loading"`, add it to the loading branch in the component.

**Relevant Context**
- `ForensicInvestigationView.jsx`: When `report` is null, line ~486 renders a placeholder — confirm it has text or testid asserted.
- `EvidenceGraphExplorer.jsx`: Loading branch currently renders "Loading evidence graph…" text — no `data-testid`.
- `InvestigationTimeline.jsx`: Component renders with empty array — filter tabs and banner are always rendered.
- `fetchEvidenceProvenance` is mocked via `vi.mock('../api')` in all three test files.

---

### Sub-Task 3 — Accessibility & ARIA Attribute Tests

**Status:** [x] done

**Intent**
Add tests for accessibility-critical ARIA attributes: `aria-label`, `aria-pressed`, `aria-selected`, `role`. This is the largest gap — zero ARIA tests currently exist for any Phase-5 component. Keyboard navigation tests are added where practical (interactive elements that already have `data-testid`).

**Expected Outcomes**
- `InvestigationTimeline` filter buttons have tests asserting `aria-label` and `aria-pressed` state.
- `InvestigationTimeline` timeline row buttons have tests asserting `aria-label` and `aria-pressed` state.
- `EvidenceGraphExplorer` hypothesis tabs have tests asserting `role="tab"`, `aria-selected`, and `aria-label`.
- `EvidenceGraphExplorer` filter toggle chips have tests asserting `aria-pressed` state.
- `ForensicInvestigationView` evidence chips have tests asserting `aria-label`.
- `ForensicInvestigationView` hypothesis tabs have tests asserting `role="tab"` and `aria-selected`.

**Todo List**
1. **InvestigationTimeline.test.jsx** — add accessibility block:
   - Assert source filter button for EP8 has `aria-label="Particle flux (EP8)"` and `aria-pressed="false"` when inactive.
   - Assert same button has `aria-pressed="true"` after clicking.
   - Assert a timeline row button has `aria-label` containing the record's `evidence_id`.
   - Assert the same timeline row has `aria-pressed="false"` when unselected and `aria-pressed="true"` when selected.

2. **EvidenceGraphExplorer.test.jsx** — add accessibility block:
   - Assert hypothesis tab H1 has `role="tab"` and `aria-selected="true"` when active.
   - Assert hypothesis tab H2 has `aria-selected="false"` when H1 is active.
   - Assert filter toggle for `environmental_context` has `aria-pressed="true"` initially (it defaults to visible).
   - Assert filter toggle for `environmental_context` has `aria-pressed="false"` after toggling off.
   - Assert an evidence ref chip has `aria-label` containing its `evidence_id`.

3. **ForensicInvestigationView.test.jsx** — add accessibility block:
   - Assert hypothesis tab H1 has `role="tab"` and `aria-selected="true"` when active.
   - Assert evidence chip for a known ID has `aria-label` containing the evidence ID.
   - Assert environmental context chip has `aria-label` containing the evidence ID.

4. **ARIA attributes on components** — verify components actually emit the correct attributes; add any missing ones:
   - `InvestigationTimeline.jsx`: confirm filter buttons have `aria-label` and `aria-pressed`. Code research confirmed these exist. No changes needed.
   - `EvidenceGraphExplorer.jsx`: confirm tabs have `role="tab"` and `aria-selected`. Add if missing.
   - `ForensicInvestigationView.jsx`: confirm tabs have `role="tab"` and `aria-selected`. Add if missing.
   - Evidence chips (`aria-label="Show provenance for {evidenceId}"`): confirmed present.

**Relevant Context**
- `InvestigationTimeline.jsx`: Filter buttons at the source-filter row already have `aria-label` and `aria-pressed` (confirmed in code research). Timeline rows also have `aria-label` and `aria-pressed`.
- `EvidenceGraphExplorer.jsx`: Hypothesis tabs have `role="tablist"` / `role="tab"` / `aria-selected` per the component structure described in the code research report.
- `ForensicInvestigationView.jsx`: Hypothesis tabs render with similar tablist pattern.
- Use `getByRole('tab', { name: /H1/ })` patterns in tests where role is established.

---

### Sub-Task 4 — Terminology Consistency & UI Label Audit

**Status:** [x] done

**Intent**
Walk through the seven investigator questions and verify the UI labels, section headings, and navigation flow answer each question without specialist knowledge. Fix any inconsistency in section headings, badge labels, or assessment text across components.

**Expected Outcomes**
- Section headings in `ForensicInvestigationView`, `EvidenceGraphExplorer`, and `InvestigationTimeline` use consistent terminology.
- The seven investigator questions can each be answered by pointing to a named UI element.
- No component uses a term for the same concept differently from another component (e.g., "Environmental context" vs "Observational context" — identify which is canonical and unify if needed).
- Assessment labels are identical across `HypothesisMatrix`, `ForensicInvestigationView`, `EvidenceGraphExplorer`, and `ReportModal`.

**Todo List**
1. Map each of the seven investigator questions to a specific UI element across components:
   - Q1 (What happened?): Event Summary section in `ForensicInvestigationView` → header in `App.jsx`
   - Q2 (What evidence exists?): `InvestigationTimeline` + provenance panel
   - Q3 (Which hypotheses?): Hypothesis Matrix / Hypothesis Comparison table
   - Q4 (Evidence per hypothesis?): `ForensicInvestigationView` per-hypothesis tabs / `EvidenceGraphExplorer`
   - Q5 (Environmental context vs mechanism?): Environmental Context sections with amber styling
   - Q6 (What remains unknown?): Limitations sections + H4/H5 empty states
   - Q7 (Why not causal?): `CausalAttributionBanner` + H5 strongly-supported rationale

2. Check "Environmental context" vs "Observational context" usage:
   - `ForensicInvestigationView.jsx` uses "Environmental context — not supporting evidence"
   - `EvidenceGraphExplorer.jsx` uses "Observational context — not supporting evidence" for the disclaimer
   - Decide on canonical label and unify. Recommended: **"Environmental context — not supporting evidence"** (matches the relationship list name `environmental_context` and the scientific intent). Update `EvidenceGraphExplorer.jsx` disclaimer text if it differs.

3. Verify assessment label rendering is identical in all four locations:
   - `getAssessmentLabel()` in `HypothesisMatrix.jsx`
   - `ForensicInvestigationView.jsx` assessment badge
   - `EvidenceGraphExplorer.jsx` assessment badge
   - `ReportModal.jsx` assessment badge
   If any component has a different label for the same assessment value, unify them.

4. Check `HypothesisMatrix.jsx` for any labels that diverge from `ForensicInvestigationView.jsx`.

**Relevant Context**
- Code research found `EvidenceGraphExplorer.jsx` line 24 uses "Observational context — not supporting evidence" as the disclaimer; `ForensicInvestigationView.jsx` line 157 uses "Environmental context — not supporting evidence". This is the primary inconsistency to resolve.
- Assessment values: `mixed`, `supported`, `weakly_supported`, `insufficient_evidence`, `strongly_supported` — labels should be: Mixed, Supported, Weakly supported, Insufficient evidence, Strongly supported.

---

### Sub-Task 5 — Empty State, Edge Case & Responsive Layout Verification

**Status:** [x] done

**Intent**
Verify that all empty states, edge-case UI flows, and layout states render correctly. This covers the investigator-experience concerns: what does the UI show before investigation runs, when data is partial, and at narrow viewport widths.

**Expected Outcomes**
- `HypothesisMatrix` empty state ("Click Investigate to run Pass 1") is present and matches the button label in `App.jsx`.
- `ForensicInvestigationView` not yet loaded shows a clean placeholder.
- `EvidenceGraphExplorer` H4 empty state is present with the missing-data message.
- `ReportModal` renders when `hypotheses` is an empty array without crashing.
- The layout's three-column (xl) / stacked (mobile) structure uses appropriate Tailwind responsive classes.
- No `overflow` clipping that would hide the EPHEMERIS positional badge or limitations text on narrow widths.

**Todo List**
1. Read `HypothesisMatrix.jsx` and confirm the empty-state text "Click **Investigate** to run Pass 1 hypothesis analysis" matches the button label "Run Pass 1 — Investigate" in `App.jsx`. If there is a mismatch, update the empty state to match.
2. Read `ReportModal.jsx` and confirm it renders gracefully when `hypotheses=[]` and `challengeData=null`.
3. Check `App.jsx` for the three-column layout at `xl:` breakpoint. Confirm `EvidenceGraphExplorer` is inside the left column (it answers Q2, Q4, Q5) and `RedTeamPanel` is in the right column.
4. Verify `InvestigationTimeline` has `max-h-96` or `max-h-[480px]` with `overflow-y-auto` so it does not overflow the layout at 278 records.
5. Add one test to `EvidenceGraphExplorer.test.jsx`: `evidenceGraph` with H4 having all four lists empty renders `data-testid="h4-empty-state"` (may already be covered by EG-3 — verify and add only if missing).

**Relevant Context**
- `HypothesisMatrix.jsx`: Empty state at the top of the component renders when `hypotheses` is empty or null.
- `App.jsx`: Button text at line ~130 is "Run Pass 1 — Investigate".
- `InvestigationTimeline.jsx`: Has `max-height: 480px` scroll container confirmed in code research.
- `EvidenceGraphExplorer.jsx`: H4 empty state renders `data-testid="h4-empty-state"` when all relationship lists are empty.

---

### Sub-Task 6 — Run Full Test Suite & Report

**Status:** [x] done

**Intent**
Execute both backend and frontend test suites after all changes are applied, run `git diff --check` for whitespace issues, and produce the final audit report.

**Expected Outcomes**
- `npm test -- --runInBand` in `backend/` exits with zero failures.
- `npm test -- --runInBand` in `frontend/` exits with zero failures.
- `git diff --check` reports no whitespace errors.
- Final report includes: files changed, tests added, total test count, failures (expected: 0), remaining technical debt, scientific-integrity concerns.

**Todo List**
1. From `backend/`, run: `npm test -- --runInBand`. Record output.
2. From `frontend/`, run: `npm test -- --runInBand`. Record output.
3. Run `git diff --check`. Record any whitespace violations and fix them.
4. Count total tests: backend (sum all describe blocks), frontend (sum all it/test blocks).
5. Write final audit report:
   - Files changed (list)
   - Tests added (by component + total)
   - Total test count (backend + frontend separately)
   - Failures: 0 expected
   - Remaining technical debt (list any deferred items with rationale)
   - Scientific-integrity concerns discovered (list any, expected: none)

**Relevant Context**
- Backend test runner: `npm test` in `backend/` (Jest with `--runInBand` for determinism)
- Frontend test runner: `npm test` in `frontend/` (Vitest, `--runInBand` flag available)
- Test files:
  - Backend: `backend/tests/aiAnalyst.test.js`, `aiForensicOutputValidation.test.js`, `evidenceProvenance.test.js`, `forensicAnalysis.test.js`, `forensicAnalysisApi.test.js`, `forensicPipelineIntegration.test.js`
  - Frontend: `frontend/src/components/ForensicInvestigationView.test.jsx`, `InvestigationTimeline.test.jsx`, `EvidenceGraphExplorer.test.jsx`

---

## Implementation Notes

### Sub-task ordering
Sub-tasks 1 and 4 are independent (audit + terminology). Sub-tasks 2 and 3 are independent (tests). Sub-task 5 is independent (layout/empty states). Sub-task 6 depends on all prior sub-tasks completing.

Recommended order: **1 → 4 → 2 → 3 → 5 → 6**

Sub-tasks 1 and 4 may be done in a single agent pass (both are primarily read + small edits).
Sub-tasks 2 and 3 may be done in a single agent pass (both are test additions to the same three files).

### Files likely to change
- `frontend/src/components/ForensicInvestigationView.test.jsx` — tests added (Sub-tasks 2, 3)
- `frontend/src/components/InvestigationTimeline.test.jsx` — tests added (Sub-tasks 2, 3)
- `frontend/src/components/EvidenceGraphExplorer.test.jsx` — tests added (Sub-tasks 2, 3, 5)
- `frontend/src/components/EvidenceGraphExplorer.jsx` — loading `data-testid` + ARIA attributes (Sub-tasks 2, 3, 4)
- `frontend/src/components/ForensicInvestigationView.jsx` — ARIA attributes on tabs (Sub-task 3, 4)
- `frontend/src/components/EvidenceGraphExplorer.jsx` — disclaimer text unification (Sub-task 4)
- Possibly: `frontend/src/components/HypothesisMatrix.jsx` — empty state text alignment (Sub-task 5)

### Files that must NOT change
- Any file in `backend/services/`
- Any file in `backend/tests/`
- `backend/server.js` routes
- Evidence IDs, assessments, `causal_attribution_established`, evidence relationships, limitations, deterministic analysis output

### Test count estimates
- Sub-task 2: ~8 new tests (2–3 per component)
- Sub-task 3: ~12 new tests (4 per component)
- Sub-task 5: ~1–2 new tests
- Total new frontend tests: ~21–22
