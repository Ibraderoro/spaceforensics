# Frontend Evidence-Provenance Plan

## Top-Level Overview

The backend already exposes the full evidence-provenance model — every hypothesis
carries `assessment`, `claims[]` (with `evidence_ids`, `relationship`, `uncertainty`,
`reasoning`), `missing_evidence[]`, and `limitations[]`. The Pass 2 challenge route
returns `challenges[]` with `claim_id`, `challenge`, `counter_evidence_ids`,
`missing_evidence`, `severity`, and `revised_assessment`.

None of this data is shown in the frontend today.

This plan wires the existing backend model through to the existing investigation
screen without redesigning any layout or visual identity. Every sub-task touches
the minimum set of files necessary to surface one coherent capability.

No new routes. No backend changes. No redesign.

---

## Sub-Tasks

---

### ST-1 — Replace numerical confidence bar with Assessment badge + evidence counts

**Status:** `[x] done`

**Intent**
Per-hypothesis cards currently show a `confidence %` bar and raw reasoning text.
Replace the bar with a categorical Assessment badge and three small counters
(supporting / contradicting / non-discriminating claims). This is the first thing
the user sees per hypothesis and directly answers "How well-supported is this?"
without implying spurious precision.

Do NOT remove `confidence` from sort logic — the backend still returns it for
backward compat and it is the most reliable ranking signal.

**Expected Outcomes**
- Each hypothesis card shows an Assessment badge with text drawn from the
  `assessment` field: `strongly_supported`, `supported`, `mixed`,
  `weakly_supported`, `insufficient_evidence`.
- Three count chips show how many claims per hypothesis have
  `relationship === 'supports'`, `'contradicts'`, `'non_discriminating'`.
- The `confidence %` bar is removed. The numeric score is not displayed.
- The `reasoning` text field is removed from the card face (it moves to the
  expanded evidence section added in ST-2).
- Empty state unchanged. LEAD badge unchanged. Sort order unchanged.

**Todo List**
1. In `HypothesisMatrix.jsx` add an `ASSESSMENT_LABELS` map:
   `strongly_supported → "Strongly supported"`,
   `supported → "Supported"`,
   `mixed → "Mixed"`,
   `weakly_supported → "Weakly supported"`,
   `insufficient_evidence → "Insufficient evidence"`.
2. Add an `ASSESSMENT_COLORS` map for badge background/text Tailwind classes.
3. Replace the confidence bar JSX with the Assessment badge.
4. Below the badge add three inline count chips derived from counting
   `h.claims` by `relationship`. Show `—` when `claims` is absent/empty.
5. Remove the `h.reasoning` paragraph and `confidenceColor`/`confidenceTextColor`
   helper functions (they are no longer used).
6. Keep the `HYPOTHESIS_ICONS` map and the sorted rendering loop unchanged.

**Relevant Context**
- `frontend/src/components/HypothesisMatrix.jsx` — full rewrite of card interior
- Backend response shape: `h.assessment`, `h.claims[].relationship`
- `h.confidence` still used only for `.sort()`

---

### ST-2 — Add expandable evidence section to each hypothesis card

**Status:** `[x] done`

**Intent**
The user must be able to answer "What evidence supports this conclusion?" without
leaving the investigation screen. Each hypothesis card gets an expand toggle that
reveals the full claims list with:
- `evidence_id`, `timestamp`, `source`, `measurement`, `value`, `unit`,
  `resolution` (from the timeline data fetched on mount)
- `interpretation` (the claim's `reasoning` field)
- `relationship` to the claim
- `uncertainty` badge (`OBSERVED` / `INFERRED` / `UNKNOWN`) displayed as a
  prominent pill preceding the statement

Also surface per-hypothesis:
- `missing_evidence[]` items
- `limitations[]` items
- Causal attribution status: "Not established" (static, always shown)
- Data limitations header drawn from `caseMeta.scientific_limitations` (passed
  down from App as a prop)

**Expected Outcomes**
- Each card has a "Show evidence" toggle button (chevron icon).
- When expanded, claims are listed with the OBSERVED / INFERRED / UNKNOWN pill,
  the claim statement, and a nested row of evidence record fields.
- If a claim has `evidence_ids: []` the evidence row shows a "No direct
  measurement" note.
- Missing evidence and limitations are rendered below the claims list.
- Causal attribution status line reads: `Causal attribution: Not established`.
- Collapse returns the card to its default size.
- Loading, empty, and error states: if `claims` is absent or empty a note reads
  "No claim-level evidence available."

**Todo List**
1. Add `timelineData` and `caseMeta` as props to `HypothesisMatrix` (passed from
   App; used to look up full evidence record by `evidence_id`).
2. Build an `evidenceById` lookup map inside the component
   (`useMemo` keyed on `timelineData`).
3. Per card: add local `useState(false)` for `expanded`.
4. Render an expand/collapse toggle button at card bottom using a `ChevronDown` /
   `ChevronUp` icon from lucide-react.
5. In the expanded panel render claims in order:
   a. Uncertainty pill (`OBSERVED` | `INFERRED` | `UNKNOWN`) with distinct
      background colors.
   b. Claim statement text.
   c. For each `evidence_id` in `claim.evidence_ids` look up the full record
      from `evidenceById` and render a small data row:
      `id · timestamp · source · measurement: value unit · resolution`
   d. Claim reasoning (italic, subdued).
   e. Relationship label chip.
6. Below claims render `missing_evidence` list with a ⚠ icon prefix.
7. Below that render `limitations` list with a ℹ icon prefix.
8. Show `Causal attribution: Not established` as a static footer line per card.
9. Pass `timelineData` and `caseMeta` down from `App.jsx`.

**Relevant Context**
- `frontend/src/App.jsx` — passes props to HypothesisMatrix; add `timelineData`
  and `caseMeta` to the `<HypothesisMatrix>` call
- `frontend/src/components/HypothesisMatrix.jsx`
- Backend claim shape: `claim_id`, `statement`, `evidence_ids[]`, `relationship`,
  `reasoning`, `uncertainty`
- Timeline record shape: `evidence_id`, `timestamp`, `source`, `measurement`,
  `value`, `unit`, `resolution`

---

### ST-3 — Rework RedTeamPanel to show structured Claim → Challenge flow

**Status:** `[x] done`

**Intent**
The current RedTeamPanel shows a flat list of `counter_evidence` items with type
and confidence_impact fields that no longer exist in the new schema. The backend
now returns `challenges[]` with `claim_id`, `challenge`, `counter_evidence_ids`,
`missing_evidence`, `severity`, `revised_assessment`.

Display the Red-Team panel with the structured flow the user asked for:

```
CLAIM
↓
CHALLENGE
↓
COUNTER-EVIDENCE
↓
MISSING EVIDENCE
↓
REVISED ASSESSMENT
```

Also surface the `scientific_limitations` from `caseMeta` in this panel.

**Expected Outcomes**
- The panel reads challenges from `challengeData.challenges` (not
  `challengeData.counter_evidence` which no longer exists in the new schema).
- Each challenge item shows: claim_id label, challenge text, counter-evidence
  IDs (linked to timeline records when possible), missing evidence list,
  severity badge, and revised assessment.
- The visual flow uses labelled section dividers or a vertical connector line.
- `red_team_summary` blockquote remains.
- Source badge (LLM / Deterministic) remains.
- Scientific limitations from `caseMeta.scientific_limitations` are shown at the
  bottom of the panel under a "Scientific Limitations" heading.
- Error state: existing error display preserved.
- Empty/pre-challenge state: existing button and prompt text preserved.

**Todo List**
1. Update `RedTeamPanel` props to accept `caseMeta` (for scientific limitations).
2. Remove the `TYPE_STYLES` map and `counter_evidence` rendering logic.
3. Add a `timelineData` prop and build a local `evidenceById` map (same pattern
   as ST-2; consider extracting a shared hook or utility).
4. Render `challengeData.challenges` with the 5-step flow using section labels:
   `CLAIM`, `CHALLENGE`, `COUNTER-EVIDENCE`, `MISSING EVIDENCE`,
   `REVISED ASSESSMENT`.
5. For counter-evidence IDs: show the evidence_id as a monospace tag; if found
   in `evidenceById`, show `measurement: value unit` inline.
6. Add severity badges: `high` → red, `medium` → amber, `low` → slate.
7. Add scientific limitations section at panel bottom (from `caseMeta`).
8. Pass `caseMeta` and `timelineData` down from `App.jsx`.

**Relevant Context**
- `frontend/src/components/RedTeamPanel.jsx`
- New challenge schema: `challenges[].claim_id`, `challenge`,
  `counter_evidence_ids`, `missing_evidence`, `severity`, `revised_assessment`
- `challengeData.red_team_summary` — unchanged field name
- `challengeData.challenged_hypothesis_id` — unchanged field name

---

### ST-4 — Update ReportModal to include the evidence-provenance model

**Status:** `[x] done`

**Intent**
The Forensic Report modal is the exportable/printable summary. It currently
shows confidence % values. Update it to show:
- Assessment labels instead of % scores
- Per-hypothesis claims with uncertainty labels
- Missing evidence per hypothesis
- Limitations per hypothesis
- Causal attribution: Not established
- Red-team challenges in the structured flow
- Scientific limitations section (already present, no change needed)

**Expected Outcomes**
- Pass 1 hypothesis table shows `assessment` label instead of `confidence %`.
- Each hypothesis row is expandable or has a sub-section listing its claims.
- Red-team section shows the `challenges[]` structured view.
- No `%` scores displayed unless they come from a validated statistical model.
- All existing sections (Case Header, Data Window, Data Sources) unchanged.

**Todo List**
1. In `ReportModal.jsx` Pass 1 table: replace `confidence %` column with
   `Assessment` column using the `ASSESSMENT_LABELS` map (import or inline).
2. Below each hypothesis row, render a compact claims sub-section:
   uncertainty pill + statement + relationship chip, one per claim.
3. Show `missing_evidence` per hypothesis.
4. Show `limitations` per hypothesis.
5. Show `Causal attribution: Not established` per hypothesis.
6. In Pass 2 section: replace the `counter_evidence` list with `challenges[]`
   using the same 5-step layout as ST-3 (simplified for print).
7. Remove the `confidence_impact` column from the updated scores table; show
   assessment label instead.

**Relevant Context**
- `frontend/src/components/ReportModal.jsx`
- Uses same `hypotheses` prop and `challengeData` prop as the main app

---

### ST-5 — Wire new props through App.jsx and add frontend build/lint validation

**Status:** `[x] done`

**Intent**
Audit all prop-passing changes introduced in ST-1 through ST-4, confirm the app
compiles cleanly, and run the Vite build and Oxlint lint to verify no regressions.

Since there is no frontend test runner configured, this sub-task focuses on:
- Prop wiring correctness (no missing or wrong prop names)
- Oxlint lint passing
- Vite production build passing with no warnings

Also add Vitest as a dev dependency and write a minimal smoke test that can be
run in CI — at minimum test the `ASSESSMENT_LABELS` utility and the evidence
lookup map logic (pure functions, no DOM required).

**Expected Outcomes**
- `npm run build` inside `frontend/` exits 0 with no errors.
- `npm run lint` inside `frontend/` exits 0 with no errors.
- At least one Vitest test exists and passes.
- No new console warnings in the browser.
- All existing routes (`/api/cases/galaxy-15`, timeline, investigate, challenge)
  continue to work.

**Todo List**
1. In `App.jsx`:
   a. Add `caseMeta` and `timelineData` props to `<HypothesisMatrix>` call.
   b. Add `caseMeta` and `timelineData` props to `<RedTeamPanel>` call.
2. Verify all prop names match what ST-2 and ST-3 expect.
3. Install `vitest` and `@vitest/ui` as devDependencies in `frontend/`.
4. Add `"test": "vitest run"` script to `frontend/package.json`.
5. Create `frontend/src/utils/assessmentLabels.js` extracting the
   `ASSESSMENT_LABELS` and `ASSESSMENT_COLORS` maps so they can be imported
   by both `HypothesisMatrix` and `ReportModal`.
6. Write `frontend/src/utils/assessmentLabels.test.js` with:
   - All 5 assessment keys map to non-empty label strings.
   - All 5 assessment keys map to non-empty color strings.
   - An unknown key returns a fallback (not undefined).
7. Run `npm run build` and fix any errors.
8. Run `npm run lint` and fix any errors.
9. Run `npm test` and confirm green.

**Relevant Context**
- `frontend/src/App.jsx` — prop wiring hub
- `frontend/package.json` — add vitest
- `frontend/vite.config.js` — may need `test` block for Vitest

---

## Data Flow Summary

```
App.jsx
  ├── caseMeta (from GET /api/cases/galaxy-15)
  ├── timelineData (from GET /api/cases/galaxy-15/timeline)  ← 278 evidence records
  ├── hypotheses (from POST /api/cases/galaxy-15/investigate)
  │     Each hypothesis: { hypothesis_id, label, assessment, claims[], missing_evidence[], limitations[], confidence }
  │     Each claim:      { claim_id, statement, evidence_ids[], relationship, reasoning, uncertainty }
  └── challengeData (from POST /api/cases/galaxy-15/challenge)
        { challenged_hypothesis_id, challenges[], updated_hypotheses[], red_team_summary, source }
        Each challenge: { claim_id, challenge, counter_evidence_ids[], missing_evidence[], severity, revised_assessment }

Components that receive new/updated props:
  HypothesisMatrix ← hypotheses, timelineData, caseMeta
  RedTeamPanel     ← onChallengeComplete, challengeData, timelineData, caseMeta
  ReportModal      ← isOpen, onClose, caseMeta, hypotheses, challengeData  (no new props needed)
```

---

## Non-Goals

- No backend changes.
- No new API routes.
- No redesign of layout, header, timeline chart, or color palette.
- No database or persistence.
- No routing changes.
- No commit.
