# Galaxy 15 Data Fetch & Evidence Build Plan

## Top-Level Overview

**Goal:** Build a self-contained data pipeline for the Galaxy 15 anomaly case (anchor event: 2010-04-05T09:48 UTC). The pipeline queries two NASA REST APIs (CDAWeb and OMNI), downloads three raw JSON payloads, parses and normalises them into a single flat CSV, and writes a case metadata file.

**Scope:**
- One new script: `cases/galaxy-15/fetch_galaxy15.py`
- Three raw JSON files under `cases/galaxy-15/raw/`
- One normalised CSV: `cases/galaxy-15/normalized/galaxy15_evidence.csv`
- One case metadata file: `cases/galaxy-15/case.json`

**Approach:** A single Python script handles fetch + parse + write. No framework or task runner — just `requests` and `pandas`, which are already installed in the project venv.

**Non-Goals:** No database ingestion, no frontend wiring, no unit tests, no scheduling.

---

## Sub-Tasks

### Sub-Task 1 — Create directory scaffolding and `case.json`

**Intent:**  
Ensure the required directories exist and produce the case metadata file that describes the investigation target, anchor event, and scientific limitations. This file is the "identity card" of the case.

**Expected Outcomes:**
- `cases/galaxy-15/raw/` directory exists (already present, confirmed)
- `cases/galaxy-15/normalized/` directory exists (already present, confirmed)
- `cases/galaxy-15/case.json` exists and contains:
  - `case_id`, `title`, `anchor_event` (timestamp + label)
  - `target_asset` block: name="Galaxy 15", norad_id=28884, orbit="GEO", longitude="-133.0° W"
  - `data_window` start/end in ISO 8601
  - `data_sources` array listing the three CDAWeb dataset IDs
  - `scientific_limitations` array of plain-English caveats

**Todo List:**
1. Write `cases/galaxy-15/case.json` with all required fields (see Expected Outcomes above).

**Relevant Context:**
- No existing `case.json` template — write from scratch.
- Directories already exist per the codebase exploration.

**Status:** `[x] done`

---

### Sub-Task 2 — Implement the fetch layer in `fetch_galaxy15.py`

**Intent:**  
Write the portion of the script that calls the NASA CDAWeb REST API for each of the three datasets and saves each response as a raw JSON file. Keeping fetch separate from parsing makes the script re-runnable without hitting the network again (skip-if-exists logic).

**Expected Outcomes:**
- `cases/galaxy-15/raw/GOES11_K0_EP8.json` — particle flux response
- `cases/galaxy-15/raw/GOES11_K0_MAG.json` — magnetic field response
- `cases/galaxy-15/raw/GOES11_EPHEMERIS_SSC.json` — orbit position response
- Each file is the raw JSON body returned by the API, unmodified.
- If a file already exists, the fetch is skipped (idempotent runs).

**Todo List:**
1. Define constants at the top of the script: time window, dataset IDs, variable names, output paths.
2. Write a `fetch_dataset(dataset_id, variables, out_path)` helper that:
   - Builds the CDAWeb REST URL: `https://cdaweb.gsfc.nasa.gov/WS/cdasr/1/dataviews/sp_phys/datasets/{dataset_id}/data/{start}/{end}/{variables}`
   - Issues a GET with `Accept: application/json`
   - Saves the raw response JSON to `out_path`
   - Skips if `out_path` already exists
3. Call `fetch_dataset` three times (one per dataset) from a `main()` function.

**Relevant Context:**
- `requests` 2.34.2 is installed.
- CDAWeb REST API base: `https://cdaweb.gsfc.nasa.gov/WS/cdasr/1/`
- Dataset / variable mapping:
  - `GOES11_K0_EP8` → variable `E_1MEV_IC` (1 MeV electron integral channel, representative e_flux)
  - `GOES11_K0_MAG` → variable `B_GSM` (magnetic field in GSM coordinates)
  - `GOES11_EPHEMERIS_SSC` → variable `XYZ_GSM` (orbital position in GSM)
- Time format required by CDAWeb: `YYYYMMDDTHHMMSSZ`

**Status:** `[x] done`

**Notes (post-implementation):**
- Confirmed working URL pattern: `{BASE}/{dataset}/data/{start},{end}/{variable}?format=json` (comma-separated time range, `?format=json` query param required)
- Confirmed variable names: `E2` (EP8), `B_GSM_c` (MAG), `RADIUS` (EPHEMERIS)
- `XYZ_GSM` was replaced with `RADIUS` (scalar, Re) — `XYZ_GSM` timed out due to payload size

---

### Sub-Task 3 — Implement the parse/normalise layer

**Intent:**  
Write the parser that reads the three raw JSON files, strips CDAWeb fill values (-1.0E31), flattens each record into the canonical six-column schema, concatenates all streams, inserts the anchor event row, sorts by timestamp, and writes `galaxy15_evidence.csv`.

**Expected Outcomes:**
- `cases/galaxy-15/normalized/galaxy15_evidence.csv` is created with columns:
  `timestamp, source, measurement, value, unit, resolution`
- Fill value rows (`-1.0E31`) are removed before writing.
- Timestamps are in ISO 8601 format, preserved at native resolution (no rounding/binning).
- One anchor event row present at `2010-04-05T09:48:00Z`:
  `source=CASE, measurement=galaxy15_anomaly, value=1, unit=event, resolution=event`
- Rows are sorted ascending by timestamp.

**Todo List:**
1. Write a `parse_cdaweb_response(raw_json, source, measurement, unit, resolution)` function that:
   - Navigates the CDAWeb JSON structure to reach the time-series records.
   - Iterates over records, skips any where the value equals -1.0E31.
   - Returns a list of dicts with keys `[timestamp, source, measurement, value, unit, resolution]`.
2. Define the per-dataset metadata constants (unit strings, resolution strings).
3. Write a `build_evidence_csv()` function that:
   - Calls `parse_cdaweb_response` for each of the three raw JSON files.
   - Combines the three lists.
   - Appends the anchor event row manually.
   - Constructs a `pandas` DataFrame with the six-column schema.
   - Sorts by `timestamp`.
   - Writes to `cases/galaxy-15/normalized/galaxy15_evidence.csv` (index=False).
4. Call `build_evidence_csv()` from `main()` after the fetch calls.

**Relevant Context:**
- `pandas` 3.0.5 is installed.
- CDAWeb JSON response structure: the data lives under `CdaData.Variable[].Values[].Value` (array of `{Time, Value}` pairs) — this must be confirmed by inspecting an actual response; the parser must handle the real structure.
- Fill value: `-1.0E31` (compare with tolerance, not exact equality, to handle float rounding).
- Resolution strings to use: `5min` for EP8, `1min` for MAG, `3min` for EPHEMERIS.
- Unit strings: `particles/cm2/s/sr` for e_flux, `nT` for b_gsm, `Re` for position.

**Status:** `[x] done`

**Notes (post-implementation):**
- Real CDF-JSON structure: `CDF[0].cdfVariables.variable[]` (not `CdaData.Variable`)
- Timestamps in `Epoch` variable, keyed by `recNum` which aligns with data variable records
- Vector values (B_GSM_c) are space-separated strings: `"30.18 2.48 69.69"` → stored as |B| (L2 norm)
- Fill sentinel threshold: `< -1e29` (covers both -1.0E30 and -1.0E31 pad values)

---

### Sub-Task 4 — Wire `main()`, add CLI entry point, and validate end-to-end

**Intent:**  
Ensure the script is runnable as `python cases/galaxy-15/fetch_galaxy15.py` and that all outputs are produced correctly. This sub-task also covers any structural corrections needed after seeing real API responses.

**Expected Outcomes:**
- Running `python cases/galaxy-15/fetch_galaxy15.py` from the project root succeeds without error.
- All three raw JSON files are present under `raw/`.
- `galaxy15_evidence.csv` is present under `normalized/` with all six columns and at least the anchor event row.
- Console output confirms each step (fetch, parse, write).

**Todo List:**
1. Ensure `main()` calls fetch then parse in order, with `print()` progress messages.
2. Add `if __name__ == "__main__": main()` guard.
3. Verify the CSV output visually (first 5 rows + row count).
4. If the CDAWeb JSON structure differs from the assumed shape, update `parse_cdaweb_response` to match the real structure.

**Relevant Context:**
- venv is at `venv/` in the project root; activate with `source venv/bin/activate` before running.
- All dependencies (`requests`, `pandas`) are confirmed installed.

**Status:** `[x] done`

**Verified outputs:**
- 278 total rows, sorted ascending by timestamp ✓
- GOES11_EP8: 36 records (5-min e_flux >2 MeV) ✓
- GOES11_MAG: 180 records (1-min |B| GSM in nT) ✓
- GOES11_EPHEMERIS: 61 records (3-min radius in Re) ✓
- CASE anchor event at 2010-04-05T09:48:00Z ✓
- Monotonically ascending timestamp order ✓
- Time range: 2010-04-05T08:00:00Z → 2010-04-05T11:00:00Z ✓

---

## Implementation Notes

- **API rate limits:** CDAWeb is a public NASA API with no documented rate limit for small queries; three sequential requests are safe.
- **CDAWeb JSON shape uncertainty:** The exact nesting of time-value pairs in the CDAWeb response is not known until a live request is made. Sub-Task 3 must inspect the actual response and adapt the parser accordingly.
- **No credentials required:** CDAWeb REST API is fully public.
- **Python version:** Uses the project venv — Python 3.x assumed.
