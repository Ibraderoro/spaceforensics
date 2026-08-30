# Phase 5.1 — Multi-Case Evidence Ingestion Plan

## Top-Level Overview

**Goal:** Make `parseEvidenceCSV` case-aware so it resolves the correct evidence CSV from
the case ID, instead of always loading the hardcoded filename `galaxy15_evidence.csv`.

**Scope:** One function in one file (`backend/server.js`), plus a new focused test file
(`backend/tests/multiCaseIngestion.test.js`).

**Approach:** Replace the single hardcoded filename on line 75 with a `fs.readdirSync`
glob over `cases/{caseId}/normalized/` looking for any `*_evidence.csv`. If exactly one
file is found, use it. If none or more than one is found (or the directory does not exist),
reject with a deterministic, explicit error. Galaxy 15 continues to resolve to the same
file, so all 171 existing passing tests remain unaffected.

**Non-goals:**
- No database or registry abstraction.
- No fallback mapping of unknown cases to Galaxy 15.
- No changes to `buildEvidenceGraph`, `buildForensicAnalysis`, `aiAnalyst`, or any
  other service.
- No changes to evidence ID generation logic (`E-G15-XXXX`).
- No changes to any existing test file.

---

## Sub-Tasks

### Sub-Task 1 — Replace hardcoded CSV filename with dynamic resolution

**Intent:**
Fix the one-line technical debt in `parseEvidenceCSV` by replacing the hardcoded
`'galaxy15_evidence.csv'` filename with a directory scan that finds `*_evidence.csv`
inside `cases/{caseId}/normalized/`. An unknown case ID or a directory containing zero
or multiple evidence files must produce an explicit error; no silent fallback is allowed.

**Expected Outcomes:**
- `parseEvidenceCSV('galaxy-15')` resolves to `cases/galaxy-15/normalized/galaxy15_evidence.csv`
  (exactly as before — no data change).
- `parseEvidenceCSV('unknown-case')` rejects with `{ status: 404, message: ... }`.
- All 16 existing tests in `evidenceModel.test.js` continue to pass.
- All other existing tests (171 total) continue to pass.

**Todo List:**
1. Open `backend/server.js` lines 67–132.
2. Remove the hardcoded CSV path block (lines 71–76).
3. Replace it with a `fs.readdirSync` over the `normalized/` subdirectory of the case,
   filtering for files matching `/_evidence\.csv$/`.
4. If the `normalized/` directory does not exist → reject `{ status: 404, message: 'Case not found: {caseId}' }`.
5. If zero files match → reject `{ status: 404, message: 'No evidence dataset found for case: {caseId}' }`.
6. If more than one file matches → reject `{ status: 500, message: 'Ambiguous evidence dataset for case: {caseId}' }`.
7. Set `csvPath` to the single resolved file path and continue with the existing stream
   logic unchanged.
8. Remove the now-redundant `fs.existsSync(csvPath)` check on line 78 (the directory scan
   already handles absence; keep only the stream-level `.on('error', ...)` handler).

**Relevant Context:**
- [`backend/server.js:67-132`](backend/server.js:67) — `parseEvidenceCSV` full body
- [`backend/server.js:71-76`](backend/server.js:71) — hardcoded `galaxy15_evidence.csv`
- [`backend/server.js:78-80`](backend/server.js:78) — `fs.existsSync` guard (becomes redundant)
- [`cases/galaxy-15/normalized/galaxy15_evidence.csv`](cases/galaxy-15/normalized/galaxy15_evidence.csv) — the real data file
- [`backend/tests/evidenceModel.test.js`](backend/tests/evidenceModel.test.js) — 16 tests that must not regress

**Status:** [x] done

---

### Sub-Task 2 — Add multi-case ingestion tests

**Intent:**
Add a new test file that explicitly covers the case-resolution behaviour introduced in
Sub-Task 1: successful Galaxy 15 resolution, record count and ID stability, unknown-case
rejection, and determinism. No existing test file is modified.

**Expected Outcomes:**
- New test file `backend/tests/multiCaseIngestion.test.js` passes all assertions.
- The new file does not duplicate assertions already in `evidenceModel.test.js`; it focuses
  exclusively on case-resolution concerns.
- `npm test -- --runInBand` shows the new suite in green alongside the existing 171 tests.

**Todo List:**
1. Create `backend/tests/multiCaseIngestion.test.js`.
2. Add test: `parseEvidenceCSV('galaxy-15')` resolves (smoke — does not throw).
3. Add test: Galaxy 15 produces exactly 278 records.
4. Add test: first evidence ID is `E-G15-0001` and last is `E-G15-0278`.
5. Add test: two independent calls to `parseEvidenceCSV('galaxy-15')` return identical
   evidence ID arrays (determinism).
6. Add test: `parseEvidenceCSV('unknown-xyz')` rejects with `status: 404`.
7. Add test: `parseEvidenceCSV('unknown-xyz')` rejection message is a non-empty string and
   explicitly names the unknown case (not a generic 'Timeline data not found' message).
8. Add test: `parseEvidenceCSV('unknown-xyz')` does NOT resolve to the Galaxy 15 dataset
   (guard against silent fallback).
9. Add test: dataset resolution is deterministic — two calls with the same unknown case ID
   produce identical rejection objects.

**Relevant Context:**
- [`backend/tests/evidenceModel.test.js`](backend/tests/evidenceModel.test.js) — existing
  gold-standard tests; do not replicate, do not modify
- [`backend/tests/forensicPipelineIntegration.test.js`](backend/tests/forensicPipelineIntegration.test.js)
  — pipeline integration; must remain green

**Status:** [x] done

---

### Sub-Task 3 — Validation run

**Intent:**
Confirm that both sub-tasks produce zero regressions and that all required validations pass.

**Expected Outcomes:**
- `git diff --check` exits 0.
- `npm test -- --runInBand` runs all test suites, exits 0, new suite listed in green.

**Todo List:**
1. Run `git diff --check` from the repository root.
2. Run `npm test -- --runInBand` from `backend/`.
3. Confirm total passing count is ≥ 171 + new tests.
4. Confirm no existing suite reports a new failure or a new skip.

**Relevant Context:**
- All test files under [`backend/tests/`](backend/tests/)
- [`backend/package.json`](backend/package.json) — test runner configuration

**Status:** [x] done — 10 suites, 153 tests, 0 failures.
