# Backend API Plan — SPACEFORENSICS Express Server

## Top-Level Overview

Build a minimal Express.js REST API in `backend/` that serves the Galaxy 15 case pack from Phase 1.
The server reads data directly from the `cases/` directory on disk — no database. It exposes four
endpoints covering case discovery, case metadata, a time-sorted evidence timeline, and a structured
evidence graph for three competing hypotheses. The server runs on port **5001** with CORS enabled.

> **Note:** Port 5000 is reserved by macOS AirPlay on Ventura/Sonoma. `backend/.env` uses `PORT=5001`.

---

## Sub-Task 1 — Initialize Node.js Project

**Intent**
Bootstrap `backend/` as a proper Node.js package with all required runtime dependencies declared so
the project can be installed and started by any contributor.

**Expected Outcomes**
- `backend/package.json` exists with `name`, `main`, `scripts.start`, and all four dependencies:
  `express`, `cors`, `csv-parser`, `dotenv`.
- `backend/node_modules/` is populated after `npm install`.
- `backend/.env` holds `PORT=5000`.
- `backend/` is excluded from git tracking for `node_modules`.

**Todo List**
1. Run `npm init -y` inside `backend/`.
2. Run `npm install express cors csv-parser dotenv` inside `backend/`.
3. Add a `"start": "node server.js"` script to `package.json`.
4. Create `backend/.env` with `PORT=5000`.
5. Ensure `.gitignore` at the root (or inside `backend/`) ignores `node_modules/`.

**Relevant Context**
- `backend/` directory exists but is empty.
- No existing `package.json` anywhere in the project.

**Status:** [x] done

---

## Sub-Task 2 — Create `server.js` Skeleton

**Intent**
Stand up the Express app with CORS, JSON middleware, and the `PORT` config wired from `.env`. This
provides the runnable skeleton before any routes are added.

**Expected Outcomes**
- `backend/server.js` starts without errors.
- `curl http://localhost:5000/` returns a 200 or 404 (no crash).
- CORS headers are present on responses.

**Todo List**
1. Create `backend/server.js`.
2. Load `dotenv` at the top and read `PORT` (default `5000`).
3. Initialise `express()`, apply `cors()` and `express.json()` middleware.
4. Add a root health-check route `GET /` → `{ status: "ok" }`.
5. Call `app.listen(PORT, ...)` and log the port.

**Relevant Context**
- `backend/.env` created in Sub-Task 1.
- No existing Express patterns in the repo to follow.

**Status:** [x] done

---

## Sub-Task 3 — Implement `GET /api/cases`

**Intent**
Return a list of all available cases by scanning the `cases/` directory for subdirectories that
contain a `case.json` file. This makes the API self-describing as new cases are added.

**Expected Outcomes**
- `curl http://localhost:5000/api/cases` returns a JSON array with at least one entry for `galaxy-15`.
- Each entry includes at minimum `case_id` and `title` (read from `case.json`).
- If `cases/` is empty, returns `[]`.

**Todo List**
1. Add a route `GET /api/cases` in `server.js`.
2. Use `fs.readdirSync` to list subdirectories of `../cases/` relative to `server.js`.
3. For each subdirectory, check that `case.json` exists; skip directories without it.
4. Read and parse `case.json` from each valid directory.
5. Return an array of `{ case_id, title }` objects (or the full `case.json` objects).

**Relevant Context**
- `cases/galaxy-15/case.json` — the only case at this time.
- `case.json` schema: `case_id`, `title`, `description`, `anchor_event`, `target_asset`, etc.
- Path resolution: `server.js` is in `backend/`; cases are at `../cases/`.

**Status:** [x] done

---

## Sub-Task 4 — Implement `GET /api/cases/:id`

**Intent**
Return the full `case.json` metadata for a specific case. This is the primary case-detail endpoint.

**Expected Outcomes**
- `curl http://localhost:5000/api/cases/galaxy-15` returns the full parsed `case.json` object.
- `curl http://localhost:5000/api/cases/nonexistent` returns HTTP 404 with a JSON error body.

**Todo List**
1. Add a route `GET /api/cases/:id` in `server.js`.
2. Construct the path `../cases/:id/case.json` using `path.join`.
3. Check file existence; if missing, respond `404 { error: "Case not found" }`.
4. Read, parse, and return the JSON.

**Relevant Context**
- `cases/galaxy-15/case.json` — full schema documented in the explore findings above.
- Error handling: must return structured JSON, not Express default HTML error pages.

**Status:** [x] done

---

## Sub-Task 5 — Implement `GET /api/cases/:id/timeline`

**Intent**
Parse the normalized evidence CSV and return all 278 records as a time-sorted JSON array.
This is the primary data feed for the frontend timeline component.

**Expected Outcomes**
- `curl http://localhost:5000/api/cases/galaxy-15/timeline` returns a JSON array of exactly 278 objects.
- Records are sorted ascending by `timestamp`.
- Each record has the six fields from the CSV: `timestamp`, `source`, `measurement`, `value`, `unit`,
  `resolution`.
- `value` is coerced to a float (not a string).
- HTTP 404 if the CSV file does not exist for the requested case.

**Todo List**
1. Add a route `GET /api/cases/:id/timeline` in `server.js`.
2. Construct the path `../cases/:id/normalized/galaxy15_evidence.csv`.
   - Note: the filename is currently hardcoded as `galaxy15_evidence.csv`; this is acceptable for
     Phase 2 since only one case exists. File the caveat in a code comment.
3. Check file existence; respond `404 { error: "Timeline data not found" }` if missing.
4. Use `csv-parser` to stream-parse the CSV, collecting rows into an array.
5. On stream `end`, sort the array by `timestamp` (ISO strings sort lexicographically correctly).
6. Coerce `value` field from string to `parseFloat`.
7. Send the sorted array as JSON.

**Relevant Context**
- CSV schema: `timestamp,source,measurement,value,unit,resolution`
- 278 rows total (36 EP8 + 180 MAG + 61 EPHEMERIS + 1 anchor event).
- `csv-parser` is a stream-based library; results are collected in an array then sent after `end`.
- Filename pattern: `galaxy15_evidence.csv` — single case only for now.

**Status:** [x] done

---

## Sub-Task 6 — Implement `GET /api/cases/:id/evidence-graph`

**Intent**
Return a structured JSON object that maps each competing hypothesis to its supporting and
contradicting evidence nodes, derived from the CSV data. This powers the hypothesis graph view.

**Expected Outcomes**
- `curl http://localhost:5000/api/cases/galaxy-15/evidence-graph` returns an object with three
  hypothesis keys: `surface_charging_esd`, `single_event_upset`, `hardware_failure`.
- Each hypothesis node contains: `label`, `supporting` (array of evidence objects), `contradicting`
  (array of evidence objects).
- Evidence objects reference real data points from the CSV (e.g. peak electron flux reading).
- HTTP 404 if the case does not exist.

**Todo List**
1. Add a route `GET /api/cases/:id/evidence-graph` in `server.js`.
2. Parse the CSV (same stream pattern as Sub-Task 5, or factor into a shared helper).
3. After parsing, apply classification logic to assign rows to hypotheses:
   - **Surface Charging/ESD** — supported by high electron flux (`source: GOES11_EP8`,
     `measurement: e_flux`); contradicted by absence of attitude anomaly.
   - **Single Event Upset (SEU)** — supported by elevated particle flux hitting command processor;
     contradicted by no telemetry loss (transponders stayed live).
   - **Hardware Failure** — supported by total command unresponsiveness; contradicted by 9-month
     survival before autonomous reboot (implies no physical destruction).
4. Return the structured graph object.

**Relevant Context**
- CSV sources: `GOES11_EP8` (e_flux), `GOES11_MAG` (b_gsm), `GOES11_EPHEMERIS` (position).
- Anchor event row: `source=CASE`, `measurement=galaxy15_anomaly` at `2010-04-05T09:48:00Z`.
- The classification mapping is static domain knowledge — it does not need to be data-driven for
  Phase 2.
- `case.json` → `scientific_limitations` field is relevant context for the contradicting evidence.

**Status:** [x] done

---

## Sub-Task 7 — Verification

**Intent**
Confirm the server starts cleanly and all four endpoints return correct data.

**Expected Outcomes**
- `node backend/server.js` starts without errors and logs `Server running on port 5000`.
- `curl http://localhost:5000/api/cases` → JSON array with galaxy-15 entry.
- `curl http://localhost:5000/api/cases/galaxy-15` → full case.json object.
- `curl http://localhost:5000/api/cases/galaxy-15/timeline` → array of exactly 278 records.
- `curl http://localhost:5000/api/cases/galaxy-15/evidence-graph` → object with 3 hypothesis keys.
- `curl http://localhost:5000/api/cases/nonexistent` → `{ "error": "Case not found" }` with 404.

**Todo List**
1. Start the server: `node backend/server.js`.
2. Run each curl command above and inspect the response.
3. Verify timeline record count: `curl ... | python3 -c "import sys,json; print(len(json.load(sys.stdin)))"`.
4. Stop the server.

**Relevant Context**
- All verification is manual curl-based as specified in the task.
- No automated test framework is required for Phase 2.

**Status:** [x] done — all curl checks passed. Port changed from 5000 → 5001 (macOS AirPlay conflict).

---

## File Map

```
backend/
├── .env                  ← PORT=5000
├── package.json          ← dependencies: express, cors, csv-parser, dotenv
├── node_modules/         ← gitignored
└── server.js             ← all routes, single file

cases/
└── galaxy-15/
    ├── case.json
    └── normalized/
        └── galaxy15_evidence.csv
```

## Dependency Versions

No version pinning is required; latest stable of all four packages is acceptable for Phase 2.
