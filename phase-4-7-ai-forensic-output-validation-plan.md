# Phase 4.7 — AI Forensic Output Validation

## Overview

Phase 4.6 implemented `validateAnalystResponse` with invariants A1–A10.  Those
rules verify structural soundness (field presence, type checks, count matching,
known-ID checks, assessment passthrough, and basic language guards).

Phase 4.7 extends the validator with four deeper invariants (B1–B4) that
enforce **semantic fidelity** — verifying that the AI response does not exceed
the *source evidence*, does not misrepresent evidence roles, and does not omit
or contradict the deterministic analysis.

The work is split across two sub-tasks:
1. Extend `validateAnalystResponse` with B1–B4
2. Write focused tests for every prohibited behaviour

No evidence graph modifications.  No underlying evidence modifications.  All
backend tests must continue to pass.

---

## Sub-Tasks

---

### Sub-Task 1 — Extend `validateAnalystResponse` with invariants B1–B4

**Status:** [x] done

**Intent**

Add four new invariants to `validateAnalystResponse` in
`backend/services/aiAnalyst.js`.  These rules enforce that the AI response
respects the internal structure of the deterministic forensic analysis — not
just that IDs are syntactically valid, but that they are used in the correct
context.

**Expected Outcomes**

- `validateAnalystResponse` enforces all 14 invariants (A1–A10 + B1–B4).
- The function signature and return type `{ valid, errors }` are unchanged.
- The heuristic narrative produced by `buildAnalystHeuristicNarrative` still
  passes validation (it is the canonical "known-good" fixture).
- Every violation message includes its rule code so tests can assert on it.

**Invariants to Add**

| Code | Rule |
|------|------|
| B1 | Every `evidence_id` cited in `hypothesis_assessments[i].evidence_ids` must belong to hypothesis `i` in the deterministic graph — it must appear in at least one of `environmental_context`, `supporting_evidence`, `contradicting_evidence`, or `non_discriminating_evidence` for that hypothesis. |
| B2 | No `evidence_id` that is classified as `environmental_context` for a given hypothesis may be presented in reasoning text as "confirming", "proving", "demonstrating a mechanism", or any other phrase that implies it is direct mechanism evidence.  The check applies to the `reasoning` field of the matching `hypothesis_assessments` entry. |
| B3 | The AI response must not contradict any limitation from the deterministic analysis.  Specifically: if `causal_attribution_established` is `false`, the reasoning for any hypothesis must not assert that a causal mechanism was confirmed.  (B3 reuses the same causal-certainty phrase set as A8 but scoped to the `reasoning` field cross-referenced against the per-hypothesis limitations.) |
| B4 | Every `hypothesis_id` present in `sourceAnalysis.hypotheses` must appear exactly once in `hypothesis_assessments`.  A3 already checks the count; B4 checks that no specific hypothesis is silently swapped or omitted. |

**Implementation Notes**

- B1 requires the validator to receive the **graph** (not just `validIds`).
  The graph is needed to map hypothesis → its four evidence lists.
  - Update the function signature:
    `validateAnalystResponse(parsed, sourceAnalysis, validIds, graph)`.
  - `graph` is optional; B1 is skipped (with a warning error) if it is absent.
    This keeps backwards-compatibility with existing tests that pass only three
    arguments.
  - Build a lookup: `Map<hypothesis_id, Set<evidence_id>>` from the graph's
    four evidence lists for each hypothesis.
- B2 requires a new phrase list (`MECHANISM_CONFIRMATION_PHRASES`) analogous to
  `CAUSAL_CERTAINTY_PHRASES`.  Check only the `reasoning` string of the entry
  whose `hypothesis_id` matches, and only when the entry's `evidence_ids`
  contains at least one `environmental_context` ID for that hypothesis.
- B3 is a targeted check: after the B1/B2 per-entry loop, for each
  `hypothesis_assessments` entry check whether `reasoning` contains
  causal-certainty language AND whether the deterministic analysis has
  `causal_attribution_established: false`.  Emit a B3 violation when both
  are true.  (This is distinct from A8 which checks the top-level free-text
  fields; B3 checks the per-hypothesis reasoning cross-referenced against
  the limitation context.)
- B4: build `Set<string>` of all `hypothesis_id` values in
  `sourceAnalysis.hypotheses`.  Walk `parsed.hypothesis_assessments` and
  record which ids were seen.  Emit one `B4` error for each source id that
  is absent.

**Relevant Context**

- `backend/services/aiAnalyst.js` — `validateAnalystResponse` (lines 103–210)
- `backend/services/aiAnalyst.js` — `CAUSAL_CERTAINTY_PHRASES` (lines 51–54),
  `FREE_TEXT_FIELDS` (line 79)
- `backend/server.js` — `buildEvidenceGraph` — the graph's
  `hypotheses[*].environmental_context`, `.supporting_evidence`,
  `.contradicting_evidence`, `.non_discriminating_evidence` arrays
- Evidence list names: `['environmental_context', 'supporting_evidence',
  'contradicting_evidence', 'non_discriminating_evidence']`

**Todo List**

1. Add `MECHANISM_CONFIRMATION_PHRASES` constant (e.g. `['confirms a mechanism',
   'demonstrates the mechanism', 'proves the mechanism', 'ep8 readings prove',
   'confirms that an seu', 'voltage spike', 'confirms an seu']`).  These are the
   phrases used in the failing examples from the spec.
2. Update the `validateAnalystResponse` signature to accept an optional fourth
   argument `graph`.
3. Inside the `hypothesis_assessments` loop, after the existing A4/A5/A6/A8/A10
   checks, add:
   - **B1**: if `graph` present, build `Set<evidence_id>` for this hypothesis
     from its four evidence lists; for each cited `evidence_id` emit a B1 error
     if it is not in that set.
   - **B2**: if `graph` present, get the `environmental_context` ids for this
     hypothesis; if the `reasoning` text contains a mechanism-confirmation phrase
     AND at least one env-ctx id is cited, emit B2.
   - **B3**: if `causal_attribution_established` is `false` in `sourceAnalysis`
     and `reasoning` contains causal-certainty language, emit B3.
4. After the loop, add **B4**: find any source hypothesis_id not seen in the
   parsed assessments and emit one B4 error per missing id.
5. Update the comment block at the top of `validateAnalystResponse` to list
   B1–B4.
6. Export `validateAnalystResponse` is already exported — no change to
   `module.exports` needed.

---

### Sub-Task 2 — Write focused tests for all prohibited behaviours (B1–B4 + specification examples)

**Status:** [x] done

**Intent**

Add a new test file `backend/tests/aiForensicOutputValidation.test.js` that
covers every prohibited behaviour described in the Phase 4.7 spec, including
the four named failing examples.  Each prohibited pattern gets its own `test()`
block.  Passing patterns also get a test to confirm they are not erroneously
rejected.

**Expected Outcomes**

- Running `npm test` passes all tests including the new file.
- Each prohibited pattern has a dedicated test that asserts `valid === false`
  and that the error list includes the correct rule code.
- The two passing examples from the spec are asserted as `valid === true`.
- The new tests import from the same shared fixture pattern as the existing
  `aiAnalyst.test.js`.

**Test Cases**

| ID | Description | Expected rule(s) in errors |
|----|-------------|---------------------------|
| T-B1-1 | Evidence ID valid in dataset but does not belong to cited hypothesis | B1 |
| T-B1-2 | Evidence ID belonging to H2 cited in H3's entry | B1 |
| T-B2-1 | EP8 environmental context ID cited with reasoning "EP8 readings prove an SEU occurred" | B2 |
| T-B2-2 | Environmental context ID cited with reasoning containing "confirms that an SEU" | B2 |
| T-B3-1 | "The solar storm caused the failure." in hypothesis reasoning when causal_attribution_established is false | B3 |
| T-B3-2 | "definitively caused" in reasoning when causal_attribution is false | A8 or B3 |
| T-B4-1 | H2 entry removed from hypothesis_assessments | B4 |
| T-B4-2 | H2 entry replaced with a duplicate H1 entry | A4 (unknown id) or B4 |
| T-PASS-1 | Environmental context phrased correctly — "establishes environmental context consistent with an energetic-particle environment, but does not confirm that an SEU occurred" | valid = true |
| T-PASS-2 | Supported hypothesis phrased correctly — "H3 is supported by the observed command unresponsiveness, although the available evidence does not establish the underlying physical mechanism" | valid = true |
| T-B2-3 | "The command receiver experienced a voltage spike" in reasoning when no such evidence exists | B2 or A6/B1 |
| T-B0-PROB | "H2 has an 82% probability" in reasoning | A10 |

**Implementation Notes**

- File: `backend/tests/aiForensicOutputValidation.test.js`
- Fixture setup mirrors `aiAnalyst.test.js`:
  ```
  beforeAll: parseEvidenceCSV → buildEvidenceGraph → buildForensicAnalysis
             → buildAnalystHeuristicNarrative (as clean base)
  ```
- The `graph` is needed for B1/B2 tests; capture it in `beforeAll`.
- Use deep clone (`JSON.parse(JSON.stringify(...))`) to mutate fixtures without
  cross-test contamination.
- To get env-ctx IDs for a hypothesis, read
  `graph.hypotheses.find(h => h.hypothesis_id === 'H2').environmental_context`
  and take the first id.
- For T-PASS-1 and T-PASS-2, set the `reasoning` field of the appropriate entry
  to the exact passing phrase from the spec; assert `valid === true`.

**Relevant Context**

- `backend/tests/aiAnalyst.test.js` — fixture pattern and deep-clone tamper
  style to follow
- `backend/services/aiAnalyst.js` — `validateAnalystResponse`, `buildAnalystHeuristicNarrative`
- `backend/server.js` — `buildEvidenceGraph` (needed to build graph for B1/B2)
- Galaxy-15 graph structure:
  - H1, H2: have `environmental_context` IDs (EP8/MAG records)
  - H3, H5: have `supporting_evidence` IDs (CASE anchor row)
  - H4: has no evidence in any list
  - All hypothesis IDs: H1, H2, H3, H4, H5

**Todo List**

1. Create `backend/tests/aiForensicOutputValidation.test.js`.
2. Add `beforeAll` fixture setup identical to `aiAnalyst.test.js` but also
   capture `graph`.
3. Write test T-B1-1: take an env-ctx ID from H2; inject it into H3's
   `evidence_ids`; assert B1 error.
4. Write test T-B1-2: take a supporting evidence ID from H3; inject into H1's
   `evidence_ids`; assert B1 error.
5. Write test T-B2-1: for H2 entry, add an env-ctx ID to `evidence_ids` and set
   `reasoning` to "The EP8 readings prove an SEU occurred."; assert B2 error.
6. Write test T-B2-2: for H1 entry, add an env-ctx ID and set `reasoning` to
   include "confirms that an SEU"; assert B2 error.
7. Write test T-B3-1: set `reasoning` of H1 entry to "The solar storm caused the
   failure."; assert B3 error (causal_attribution_established is false in galaxy-15).
8. Write test T-B4-1: remove H2 from `hypothesis_assessments`; assert B4 error
   mentioning H2.
9. Write test T-B4-2: duplicate H1 and remove H2; assert B4 error mentioning H2.
10. Write test T-PASS-1: set H2 `reasoning` to
    "The contemporaneous EP8 observations establish environmental context
    consistent with an energetic-particle environment, but they do not confirm
    that an SEU occurred."; assert `valid === true`.
11. Write test T-PASS-2: set H3 `reasoning` to
    "H3 is supported by the observed command unresponsiveness, although the
    available evidence does not establish the underlying physical mechanism.";
    assert `valid === true`.
12. Write test T-B0-PROB: set H2 `reasoning` to "H2 has an 82% probability.";
    assert A10 error.
13. Run full backend test suite and confirm all tests pass.

---

## Validation Checklist

- [ ] `validateAnalystResponse` returns all rule codes B1–B4 in error messages
- [ ] `buildAnalystHeuristicNarrative` output still passes the updated validator
      when called with the four-argument form
- [ ] All existing tests T-AA-1–T-AA-10 still pass (backwards compatibility)
- [ ] New test file passes all cases
- [ ] `npm test` exits 0
