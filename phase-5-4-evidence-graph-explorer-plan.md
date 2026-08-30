# Phase 5.4 — Forensic Evidence Graph Explorer

## Top-Level Overview

**Goal:** Build a new `EvidenceGraphExplorer` component that lets investigators navigate
the evidence-graph relationships — hypothesis → relationship list → evidence — with
hypothesis and relationship-type filtering, provenance on evidence selection, forensic
summary on hypothesis selection, and all scientific constraints preserved.

**Scope:**
- New component: `frontend/src/components/EvidenceGraphExplorer.jsx`
- New test file: `frontend/src/components/EvidenceGraphExplorer.test.jsx`
- One addition to `App.jsx` to render it below `ForensicInvestigationView`
- No backend changes; no changes to any existing component

**Data source:**
`evidenceGraph` is already fetched in `App.jsx` and in state. The component receives it
as a prop (`evidenceGraph`) alongside `forensicReport` (for assessment and per-hypothesis
forensic summaries).

**Architecture:**
The component is a two-panel explorer:
- **Left / filter rail:** hypothesis selector (H1–H5 tabs) + relationship-type filter
  (four checkboxes or toggle chips).
- **Right / content area:** for the active hypothesis, show the filtered relationship
  lists, each with their evidence refs. Selecting an evidence ref shows the provenance
  panel (using `fetchEvidenceProvenance` from Phase 5.2). The hypothesis forensic summary
  (assessment, limitations, heuristic note) appears at the top of the content area.

**Scientific constraints (all must be preserved):**
- Environmental context is always visually distinct from supporting evidence
- Environmental context rows never carry the word "confirmation", "support", or "proof"
- H4 communicates: insufficient_evidence, zero evidence relationships, missing-data limitation
- H5 communicates: strongly_supported, anchor evidence, unresolved limitations
- No numerical scores or probabilities
- Assessment vocabulary is read from `forensicReport.hypotheses` (never re-derived)
- Relationships are read from `evidenceGraph.hypotheses` (never re-derived)

**Non-goals:**
- No changes to `buildEvidenceGraph()` or any backend service
- No new backend endpoints
- No changes to `ForensicInvestigationView`, `InvestigationTimeline`, or `EventTimeline`
- No re-computation of assessments in the frontend

---

## Sub-Tasks

---

### Sub-Task 1 — Build `EvidenceGraphExplorer` component

**Intent:**
Implement the full explorer with hypothesis selection, relationship-type filtering,
evidence-ref display, per-hypothesis forensic summary, and inline provenance panel.

**Component structure:**

```
EvidenceGraphExplorer
├── Header
├── HypothesisTabs (H1–H5)
├── RelationshipFilter (four toggle chips)
├── [Active Hypothesis Panel]
│   ├── HypothesisAssessmentHeader
│   │   ├── Assessment badge (from forensicReport)
│   │   ├── Label
│   │   └── Heuristic note (when present)
│   ├── HypothesisLimitations (always visible)
│   ├── [Per-list sections, filtered]
│   │   ├── EnvironmentalContextSection  (amber, NEVER labelled as confirming)
│   │   ├── SupportingEvidenceSection    (cyan)
│   │   ├── ContradictingEvidenceSection (red)
│   │   └── NonDiscriminatingSection     (slate)
│   └── EvidenceRefRow (clickable → provenance)
└── InlineProvenancePanel (shown below selected ref)
```

**Constants to define:**

```javascript
RELATIONSHIP_LIST_NAMES = [
  'environmental_context',
  'supporting_evidence',
  'contradicting_evidence',
  'non_discriminating_evidence',
]

LIST_CONFIG = {
  environmental_context:       { label: 'Environmental context', style: amber, disclaimer: 'Observational context — not supporting evidence' }
  supporting_evidence:         { label: 'Supporting evidence',   style: cyan }
  contradicting_evidence:      { label: 'Contradicting evidence', style: red }
  non_discriminating_evidence: { label: 'Non-discriminating evidence', style: slate }
}
```

**H4 empty-state:**
When the active hypothesis is H4 and all four relationship lists are empty, render a
dedicated `data-testid="h4-empty-state"` panel:
> "No evidence relationships available. This hypothesis cannot be evaluated from the
> available dataset — ground-segment and RF-link data are absent."

**H5 special handling:**
H5 has `supporting_evidence` (anchor event refs). Its panel must make visible:
- Assessment: `strongly_supported`
- Its `supporting_evidence` refs (the anchor event IDs)
- Both limitations (unresolved + missing_data)

No special-case code is needed — the generic rendering handles this correctly as long as
the component renders `supporting_evidence` and `limitations` for all hypotheses.

**Test IDs (required):**
- `evidence-graph-explorer` — root container
- `explorer-tab-{hypothesis_id}` — H1–H5 tab buttons
- `explorer-active-hypothesis` — active hypothesis content area
- `explorer-assessment-{hypothesis_id}` — assessment badge
- `explorer-limitations-{hypothesis_id}` — limitations block
- `explorer-list-{list_name}` — each relationship-list section
- `explorer-ref-{evidence_id}` — each evidence ref row
- `explorer-env-context-disclaimer` — the amber disclaimer text in env-context sections
- `filter-toggle-{list_name}` — each of the four filter toggle chips
- `h4-empty-state` — H4 zero-evidence panel
- `explorer-provenance-panel` — inline provenance panel
- `explorer-prov-loading` — loading indicator during fetch
- `explorer-prov-error` — fetch failure message
- `explorer-prov-not-found` — not-found message

**Todo List:**
1. Create `frontend/src/components/EvidenceGraphExplorer.jsx`.
2. Define `RELATIONSHIP_LIST_NAMES`, `LIST_CONFIG` constants.
3. Build `HypothesisTabs` sub-component.
4. Build `RelationshipFilter` sub-component (four toggle chips).
5. Build `HypothesisAssessmentHeader` sub-component.
6. Build `HypothesisLimitations` sub-component.
7. Build `EvidenceRefRow` sub-component (clickable, shows evidence_id, relationship,
   interpretation).
8. Build `EnvironmentalContextSection` with amber styling and disclaimer; never label it
   as supporting or confirming.
9. Build generic `RelationshipListSection` for the other three lists.
10. Implement `H4EmptyState` sub-component.
11. Wire `handleEvidenceSelect` with async `fetchEvidenceProvenance` (same pattern as
    Phase 5.2/5.3).
12. Build `ExplorerProvenancePanel` (same field set as `TimelineProvenancePanel`; uses
    `explorer-prov-*` test IDs).
13. Implement `handleHypothesisSelect` — switches active tab, clears selection and
    provenance.
14. Export as default.

**Relevant Context:**
- `frontend/src/components/ForensicInvestigationView.jsx` — `ProvenancePanel`,
  `handleEvidenceSelect` pattern, `LIST_NAME_LABELS` constants.
- `frontend/src/components/InvestigationTimeline.jsx` — `TimelineProvenancePanel`,
  same async provenance fetch pattern.
- `frontend/src/utils/assessmentLabels.js` — `getAssessmentLabel`, `getAssessmentColor`.
- `frontend/src/api.js` — `fetchEvidenceProvenance(caseId, evidenceId)`.
- Backend H4: all four lists empty; one `missing_data` limitation.
- Backend H5: `supporting_evidence` contains anchor event refs; two limitations.

**Status:** [x] done

---

### Sub-Task 2 — Add `EvidenceGraphExplorer` to `App.jsx`

**Intent:**
Render the new component in the left column, below `ForensicInvestigationView`,
passing the already-fetched `evidenceGraph` and `forensicReport`.

**Expected Outcomes:**
- `EvidenceGraphExplorer` renders when `evidenceGraph` is available (same loading
  guard as `ForensicInvestigationView`).
- Props: `evidenceGraph={evidenceGraph}`, `forensicReport={forensicReport}`.
- No new state, no new fetch calls.

**Todo List:**
1. Import `EvidenceGraphExplorer` in `App.jsx`.
2. Inside the `forensicLoading ? ... : (...)` block, add `<EvidenceGraphExplorer>`
   below `<ForensicInvestigationView>`, wrapped in the same loading guard.

**Relevant Context:**
- `frontend/src/App.jsx` lines 134–145 — forensicLoading guard.

**Status:** [x] done

---

### Sub-Task 3 — Add `EvidenceGraphExplorer.test.jsx`

**Tests (EG-1 through EG-12):**

| ID | Description |
|----|-------------|
| EG-1  | Renders without crashing when given a valid evidence graph |
| EG-2  | H1–H5 tabs are all present and clickable |
| EG-3  | Switching to H4 shows the empty-state panel |
| EG-4  | H4 empty-state references missing ground/RF data |
| EG-5  | H5 panel shows strongly_supported assessment and supporting evidence refs |
| EG-6  | Environmental context section has distinct amber styling and the disclaimer text |
| EG-7  | Environmental context is not rendered inside the supporting-evidence section |
| EG-8  | Relationship filter hides sections when toggled off |
| EG-9  | Selecting an evidence ref calls fetchEvidenceProvenance and shows the panel |
| EG-10 | No numerical scores or probability language in the rendered output |
| EG-11 | No duplicate evidence refs within any list |
| EG-12 | Provenance fetch failure shows error without crashing |

**Implementation notes:**
- `vi.mock("../api")` with `fetchEvidenceProvenance` as `vi.fn()`.
- `GRAPH_FIXTURE` — a minimal 5-hypothesis graph matching the real backend shape:
  H1 with one env-context ref and one supporting ref; H2 with one env-context ref;
  H3 with one supporting ref; H4 with all lists empty + missing_data limitation;
  H5 with one supporting_evidence ref (anchor) + two limitations.
- `REPORT_FIXTURE` — minimal `{ hypotheses: [H1..H5 with assessment fields] }`.
- Use `waitFor` for all tests involving provenance fetch.

**Relevant Context:**
- `frontend/src/components/ForensicInvestigationView.test.jsx` — mock pattern.
- `frontend/src/components/InvestigationTimeline.test.jsx` — fixture structure.

**Status:** [x] done

---

### Sub-Task 4 — Run full test suites and verify

**Expected Outcomes:**
- Backend: 144/144 pass (no backend changes).
- Frontend: all existing 64 tests pass + 12 new EG tests = 76 total.

**Todo List:**
1. `cd backend && npm test`
2. `cd frontend && npm test`

**Status:** [x] done

---

## Relationship Semantics Rules

| List name | Label shown | Can be called "supporting"? | Can be called "confirming"? |
|-----------|------------|----------------------------|----------------------------|
| `environmental_context` | "Environmental context" | ❌ Never | ❌ Never |
| `supporting_evidence` | "Supporting evidence" | ✅ | ❌ Never |
| `contradicting_evidence` | "Contradicting evidence" | ❌ | ❌ |
| `non_discriminating_evidence` | "Non-discriminating evidence" | ❌ | ❌ |
