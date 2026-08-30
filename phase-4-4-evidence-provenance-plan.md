# Phase 4.4 — Evidence Provenance and Traceability

## Top-Level Overview

Add `getEvidenceProvenance(caseId, evidenceId, rows, graph)` to
`backend/services/forensicAnalysis.js`.

The function joins a single evidence row from the parsed timeline with every
hypothesis relationship that references it, returning a complete provenance
record that makes every analytical claim auditable.

One new file is added to house Phase 4.4-only tests cleanly:
`backend/tests/evidenceProvenance.test.js`

The existing `forensicAnalysis.test.js` is **not modified**.

---

## Trace Chain Implemented

```
evidence_id  (input)
    ↓
timeline row  (lookup in rows[] by evidence_id)
    ↓
evidence record fields  (timestamp, source, measurement, value, unit,
                         dataset_id, provider, evidence_type, …)
    ↓
hypothesis relationships  (scan all four lists of all graph hypotheses)
    ↓
{ hypothesis_id, list_name, relationship, interpretation }
```

---

## Return Shape — EvidenceProvenance

```js
// Success
{
  found:            true,
  evidence_id:      string,
  timestamp:        string,
  source:           string,
  measurement:      string,
  value:            number,
  unit:             string,
  resolution:       string,
  dataset_id:       string | null,
  provider:         string | null,
  variable:         string | null,
  evidence_type:    string | null,
  quality:          null,
  hypothesis_relationships: HypothesisRelationship[]
  // empty array when no hypothesis references this record
}

// Not found
{
  found:       false,
  evidence_id: string,      // the id that was queried
  reason:      string       // human-readable explanation
}
```

### HypothesisRelationship shape

```js
{
  hypothesis_id:  string,   // 'H1'–'H5'
  list_name:      string,   // 'environmental_context' | 'supporting_evidence' |
                            // 'contradicting_evidence' | 'non_discriminating_evidence'
  relationship:   string,   // the EvidenceRef.relationship value
  interpretation: string    // the EvidenceRef.interpretation value
}
```

`list_name` is the exact key used on the graph hypothesis object — this is the
field that classifies the record as `environmental_context`, `supporting_evidence`, etc.

---

## Key Design Decisions

1. **Signature `(caseId, evidenceId, rows, graph)`** — rows and graph are passed in
   (already built by the caller), keeping the function pure and avoiding any extra
   I/O inside it. `caseId` is included for consistency with the other functions in
   this module and for potential future use (multi-case).

2. **`found: false` return, not throw** — unknown IDs are a normal query outcome
   (e.g., a UI search). The caller can `if (!result.found)` branch cleanly without
   a try/catch.

3. **EPHEMERIS records** — fully resolvable from the timeline (they are real evidence
   rows). Their `hypothesis_relationships` array will be empty because EPHEMERIS IDs
   are intentionally absent from all graph hypothesis lists. The `source` field
   (`GOES11_EPHEMERIS`) and `evidence_type` (`environmental_observation`) are preserved
   verbatim. No special-casing is needed — the scan simply finds no relationships,
   which is the correct result.

4. **Duplicate relationship guard** — the scan uses a deduplication check: if the
   same `(hypothesis_id, list_name, evidence_id)` triple appears more than once in
   the graph (which the Phase 3.5 graph guarantees it won't, but the validator should
   still enforce), a violation is reported. This satisfies F24.
   Implementation: after collecting all relationships, assert that every
   `(hypothesis_id + list_name)` pair is unique per entry.

5. **No new evidence IDs** — the function is read-only; it never mutates rows or graph.

---

## Validation Inside getEvidenceProvenance

| Check | Behaviour |
|-------|-----------|
| `evidenceId` not in `rows[]` | Return `{ found: false, evidence_id, reason: 'Evidence ID not found in timeline' }` |
| Duplicate `(hypothesis_id, list_name)` pair for same `evidence_id` | Throw `ForensicAnalysisValidationError` listing each duplicate triple |

---

## Files Changed

| File | Action |
|------|--------|
| `backend/services/forensicAnalysis.js` | Add `getEvidenceProvenance`; export it |
| `backend/tests/evidenceProvenance.test.js` | **Create** — F18–F24 |

## Files NOT Changed

- `backend/server.js`
- `backend/services/aiEngine.js`
- `backend/tests/forensicAnalysis.test.js`
- `backend/tests/evidenceGraph.test.js`
- `backend/tests/evidenceModel.test.js`
- `backend/tests/aiEngine.test.js`
- `cases/galaxy-15/*`
- Anything in `frontend/`

---

## Sub-Tasks

---

### Sub-Task 1 — Add `getEvidenceProvenance` to `forensicAnalysis.js`

**Intent:** Implement the provenance lookup as a pure function alongside the
existing analysis helpers.

**Expected Outcomes:**
- `getEvidenceProvenance(caseId, evidenceId, rows, graph)` is exported.
- Returns `{ found: true, …fields…, hypothesis_relationships: [] }` for EPHEMERIS
  records and other unreferenced rows.
- Returns `{ found: false, evidence_id, reason }` for unknown IDs.
- Returns `{ found: true, …, hypothesis_relationships: [HypothesisRelationship, …] }`
  for referenced rows.
- Throws `ForensicAnalysisValidationError` when a duplicate
  `(hypothesis_id, list_name)` triple is detected in the graph.

**Todo List:**
1. Add helper function `getEvidenceProvenance(caseId, evidenceId, rows, graph)`:
   a. Find the row: `const row = rows.find(r => r.evidence_id === evidenceId)`.
   b. If not found: return `{ found: false, evidence_id: evidenceId, reason: 'Evidence ID not found in timeline' }`.
   c. Build `hypothesis_relationships[]` by scanning `EVIDENCE_LISTS` across all
      `graph.hypotheses` — for each matching ref push
      `{ hypothesis_id, list_name, relationship: ref.relationship, interpretation: ref.interpretation }`.
   d. Duplicate check: collect all `(hypothesis_id + '|' + list_name)` keys seen
      during scan; if any key appears more than once for the same evidence_id,
      collect violations and throw `ForensicAnalysisValidationError`.
   e. Return the full provenance object (copy all fields from `row` verbatim;
      include `hypothesis_relationships`).
2. Add `getEvidenceProvenance` to `module.exports`.

**Relevant Context:**
- `EVIDENCE_LISTS` constant (line 64) already enumerates the four list names — reuse it.
- `ForensicAnalysisValidationError` (line 77) is already defined — reuse it for the
  duplicate-relationship violation.
- The evidence row fields available (from `parseEvidenceCSV`):
  `evidence_id, timestamp, source, measurement, value, unit, resolution,
   dataset_id, provider, variable, evidence_type, quality`.
- The `EvidenceRef` shape in graph hypothesis lists:
  `{ evidence_id, relationship, interpretation }`.
- `ANALYSIS_VERSION` is **not bumped** — this is a new utility function, not a new
  analysis format. The analysis object shape is unchanged.

**Status:** [ ] pending

---

### Sub-Task 2 — Create `backend/tests/evidenceProvenance.test.js`

**Intent:** Write seven focused tests (F18–F24) in a new file, following the same
`beforeAll` fixture pattern as the other test files.

**Expected Outcomes:**
- All seven tests pass on first run.
- File is self-contained — no imports from `forensicAnalysis.test.js`.
- Tests do not modify any global state.

**Test Mapping:**

| ID | Spec | What it verifies |
|----|------|-----------------|
| F18 | known evidence ID resolves | A real CASE anchor id (e.g. `E-G15-0003`) returns `found: true` with all required fields |
| F19 | unknown evidence ID is rejected | `E-G15-9999` returns `{ found: false }` — does NOT throw |
| F20 | provenance preserves original evidence fields | All 12 fields from the evidence row are present verbatim in the result |
| F21 | relationship type is preserved | A CASE anchor id's `hypothesis_relationships` contains entries whose `list_name` and `relationship` match the graph |
| F22 | EPHEMERIS evidence is not falsely classified as hypothesis evidence | An EPHEMERIS id returns `found: true` AND `hypothesis_relationships` is an empty array |
| F23 | provenance does not invent evidence | Every `evidence_id` in every `hypothesis_relationships` entry equals the queried id |
| F24 | duplicate relationship references are rejected | Calling `getEvidenceProvenance` with a hand-crafted fake graph that has the same `(hypothesis_id, list_name, evidence_id)` triple twice throws `ForensicAnalysisValidationError` |

**Todo List:**
1. Create `backend/tests/evidenceProvenance.test.js`.
2. Add imports: `parseEvidenceCSV`, `buildEvidenceGraph` from `'../server'`;
   `getEvidenceProvenance`, `ForensicAnalysisValidationError` from
   `'../services/forensicAnalysis'`.
3. `beforeAll`: load `rows`, `graph`, `validIds`.
   - Identify the CASE anchor `evidenceId`: `anchorId = rows.find(r => r.source === 'CASE').evidence_id`.
   - Identify an EPHEMERIS `evidenceId`: `ephemerisId = rows.find(r => r.source === 'GOES11_EPHEMERIS').evidence_id`.
4. Implement F18–F24 using the fixture variables.
5. For F24, construct a `fakeGraph` with the same evidence_id duplicated in the
   same list of the same hypothesis and call `getEvidenceProvenance` directly —
   verify it throws `ForensicAnalysisValidationError`.

**Relevant Context:**
- The CASE anchor row has `source === 'CASE'` — there is exactly 1 such row in Galaxy 15.
  Its evidence_id is deterministic (confirmed by `evidenceModel.test.js`).
- EPHEMERIS rows have `source === 'GOES11_EPHEMERIS'` — confirmed excluded from all
  graph hypothesis lists by test T23 in `evidenceGraph.test.js`.
- Test pattern mirrors `evidenceGraph.test.js`: `beforeAll` fixture, top-level `test()`,
  no `describe` blocks, test IDs in the name string.

**Status:** [ ] pending

---

### Sub-Task 3 — Run full test suite and report

**Intent:** Confirm 0 regressions across all 87 existing tests and all 7 new
F18–F24 tests pass.

**Expected Outcomes:**
- `npm test -- --runInBand` completes: 5 suites, 94 tests, 0 failures.

**Todo List:**
1. Run `npm test -- --runInBand --verbose` from `backend/`.
2. Confirm all 5 suites pass.
3. If any test fails, diagnose and fix without modifying frozen code.
4. Record results in this plan.

**Status:** [ ] pending

---

## Post-Implementation Checklist

- [ ] `getEvidenceProvenance` exported from `forensicAnalysis.js`
- [ ] Returns `{ found: false }` object (not throw) for unknown IDs
- [ ] EPHEMERIS IDs resolve with `hypothesis_relationships: []`
- [ ] All 12 original evidence row fields are present verbatim in the result
- [ ] `list_name` field correctly distinguishes the four relationship categories
- [ ] Duplicate `(hypothesis_id, list_name)` triple throws `ForensicAnalysisValidationError`
- [ ] `ANALYSIS_VERSION` unchanged — no analysis shape change
- [ ] `backend/tests/evidenceProvenance.test.js` created
- [ ] F18–F24 all pass
- [ ] All 87 existing tests pass
- [ ] Total: 5 suites, 94 tests, 0 failures
