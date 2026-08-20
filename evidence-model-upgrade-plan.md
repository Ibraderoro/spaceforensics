# Evidence Model Upgrade — Stable IDs and Provenance

## Overview

Upgrade the evidence model so every record returned by `parseEvidenceCSV()` carries:
- A deterministic `evidence_id` (`E-G15-0001` … `E-G15-0278`)
- Provenance fields (`dataset_id`, `provider`, `variable`, `evidence_type`, `quality`)

Scope is limited to `backend/server.js` and a new test file. No frontend, no AI engine, no ingestion script changes.

---

## Sub-Task 1 — Install Jest

**Intent**  
Add Jest as a dev-dependency so the test suite in Sub-Task 3 can run with `npm test`.

**Expected Outcomes**  
- `jest` appears in `devDependencies` in `backend/package.json`
- `npm test` inside `backend/` runs Jest and exits with the correct code

**Todo List**  
1. Run `npm install --save-dev jest` inside `backend/`
2. Set `"test": "jest"` in the `scripts` block of `backend/package.json`

**Relevant Context**  
- `backend/package.json` — currently `"test": "echo \"Error: no test specified\" && exit 1"`
- `"type": "commonjs"` — Jest works with CommonJS without extra config

**Status** — `[ ] pending`

---

## Sub-Task 2 — Refactor `parseEvidenceCSV()`

**Intent**  
Enrich each evidence record with a stable `evidence_id` and provenance fields, without altering existing field names or the function's external signature.

**Expected Outcomes**  
- Every record contains all original fields unchanged: `timestamp`, `source`, `measurement`, `value`, `unit`, `resolution`
- Every record also contains: `evidence_id`, `dataset_id`, `provider`, `variable`, `evidence_type`, `quality`
- IDs are `E-G15-NNNN` where NNNN is the 1-based global position in chronological order
- Ties on `timestamp` are broken by `source` (ascending alphabetical) for full determinism
- Provenance is joined from `case.json` `data_sources` by matching on `measurement`
- `CASE` source records have `dataset_id: null`, `provider: null`, `variable: null`, `evidence_type: "case_event"`
- `GOES11_*` records with an environmental measurement get `evidence_type: "environmental_observation"`
- `quality` is always `null` (no quality flag in the current dataset)

**Todo List**  
1. Inside `parseEvidenceCSV(caseId)`, after the CSV path check, load `case.json` synchronously and build a `Map<measurement, {dataset_id, provider, variable}>` from `data_sources`
2. Define a helper `evidenceType(source)` that returns `"case_event"` for `source === "CASE"` and `"environmental_observation"` for all `GOES11_*` sources
3. After sorting rows (existing logic), loop with `rows.forEach((row, i) => { row.evidence_id = ... })` — assign `E-G15-${String(i+1).padStart(4,'0')}`
4. During the `on('data')` callback, attach `dataset_id`, `provider`, `variable`, `evidence_type`, `quality` to each pushed row using the lookup map
5. Update the sort comparator to sort by `(timestamp, source)` for determinism at ties

**Relevant Context**  
- `backend/server.js` lines 28–58 — `parseEvidenceCSV()`
- `cases/galaxy-15/case.json` lines 30–58 — `data_sources` array; join key is `measurement`
- CSV source values: `GOES11_EP8`, `GOES11_MAG`, `GOES11_EPHEMERIS`, `CASE`
- `GOES11_EPHEMERIS` in CSV maps to `GOES11_EPHEMERIS_SSC` dataset (matched via `measurement: "position"`)
- The `CASE` source has no matching `data_sources` entry — provenance fields must be `null`, not fabricated
- `quality` is `null` throughout; the Level-2 CDAWeb archive provides no per-record quality flag in this dataset (fill values are already excluded from the CSV before it reaches this function)

**Status** — `[ ] pending`

---

## Sub-Task 3 — Write and Run Tests

**Intent**  
Verify the evidence model upgrade with automated tests covering all requirements from the spec.

**Expected Outcomes**  
All 10 test cases pass with `npm test` inside `backend/`

**Todo List**  
1. Create `backend/tests/evidenceModel.test.js`
2. Write tests for:
   - Total record count is 278
   - All 278 records have unique `evidence_id` values
   - First chronological record is `E-G15-0001`
   - Last record is `E-G15-0278`
   - IDs are sequential (`E-G15-0001`, `E-G15-0002`, …)
   - IDs are stable across two independent calls to `parseEvidenceCSV()`
   - Provenance fields are populated correctly for each source type (EP8, MAG, EPHEMERIS, CASE)
   - Unknown `measurement` values (no matching `data_sources` entry) yield `null` provenance, not fabricated strings
   - `quality` is `null` on every record
   - All original fields (`timestamp`, `source`, `measurement`, `value`, `unit`, `resolution`) are preserved exactly
3. Run `npm test` inside `backend/` and capture output
4. All tests must pass before marking this sub-task done

**Relevant Context**  
- `backend/tests/` directory does not yet exist — create it
- Test file imports `parseEvidenceCSV` which must be exported from `server.js`; use `module.exports = { parseEvidenceCSV }` or extract to a separate module
- Since `server.js` calls `app.listen()` at the bottom, the test import must not start the server — guard the `app.listen()` call with `if (require.main === module)`
- The test needs access to the real CSV and case.json — use the path `path.join(__dirname, '../../cases/galaxy-15')` relative to the test file

**Status** — `[ ] pending`

---

## Assumptions

1. The `GOES11_EPHEMERIS` source in the CSV maps to the `GOES11_EPHEMERIS_SSC` dataset via the shared `measurement: "position"` key. This is the only dataset with that measurement value in `case.json`.
2. Tie-breaking on equal timestamps uses ascending `source` string sort (`GOES11_EP8 < GOES11_MAG` alphabetically). This is the minimal stable secondary key derivable purely from the data.
3. `evidence_type` for `GOES11_EPHEMERIS` (position/orbit data) is `"environmental_observation"` because it is an in-situ sensor measurement from the same scientific asset. A more granular type (`"orbital_observation"`) is not introduced to avoid inventing classifications not present in the spec.
4. `quality` is `null` across the board. The CDAWeb Level-2 archive fill-value exclusion happens in the ingestion script — by the time records reach `parseEvidenceCSV`, only scientifically valid values are present. No inferred quality flag is added.
5. `parseEvidenceCSV` is exported for testing via `module.exports` added at the bottom of `server.js`. The `app.listen()` call is guarded with `if (require.main === module)` so that importing the file in tests does not start the HTTP server.
