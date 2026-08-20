# Phase 3 — Dual-Pass AI Engine Plan

## Top-Level Overview

Build a dual-pass AI reasoning engine for SPACEFORENSICS that takes the 278 normalized
timeline records for a case and produces structured hypothesis analysis and red-team critique.

**Pass 1 (`generateHypothesesPass`)** — constructs three competing hypotheses
(Surface Charging/ESD, SEU, Hardware Failure), scores each with initial confidence (0–100),
and maps supporting evidence records to each hypothesis.

**Pass 2 (`redTeamChallengePass`)** — acts as a Red-Team agent. It challenges the
top-ranked hypothesis in depth (missing signatures, contradicting data, sensor limitations)
and produces brief counter-notes for the remaining two. Confidence scores are downgraded
when counter-evidence is found.

**LLM Integration** — IBM Granite (`ibm/granite-3-3-8b-instruct`) via IBM Watsonx.ai
(`https://us-south.ml.cloud.ibm.com`) using `@langchain/community` WatsonxAI chat wrapper.
When `WATSONX_API_KEY` is absent, a deterministic domain-logic fallback runs instead so
the endpoints always return valid JSON during local development.

**New endpoints** in `backend/server.js`:
- `POST /api/cases/:id/investigate` → Pass 1 result
- `POST /api/cases/:id/challenge` → Pass 1 + Pass 2 combined result

---

## Sub-Tasks

---

### Sub-Task 1 — Install LLM Dependencies

**Intent**
Add the two npm packages needed for LangChain + IBM Watsonx.ai integration without
touching any other dependencies.

**Expected Outcomes**
- `@langchain/core` and `@langchain/community` appear in `backend/package.json` dependencies.
- `npm install` completes without errors.

**Todo List**
1. In `backend/`, run `npm install @langchain/core @langchain/community`.
2. Confirm both packages appear in `package.json` and `node_modules/`.

**Relevant Context**
- [`backend/package.json`](backend/package.json) — current deps: express, cors, csv-parser, dotenv.
- No existing AI packages.

**Status** — `[ ] pending`

---

### Sub-Task 2 — Create `backend/services/aiEngine.js`

**Intent**
Implement the dual-pass analysis engine as a standalone CommonJS module.
`server.js` requires it; it does not import server concerns.

**Expected Outcomes**
- File `backend/services/aiEngine.js` exists and exports `generateHypothesesPass`
  and `redTeamChallengePass`.
- Both functions accept the evidence stream (array of CSV row objects) as input.
- When `WATSONX_API_KEY` is set, functions call Granite via LangChain ChatModel.
- When `WATSONX_API_KEY` is absent, deterministic fallback logic runs instead.
- Both functions return a well-typed result object (documented below).

**Result shapes**:

`generateHypothesesPass` returns:
```js
{
  hypotheses: [
    {
      id: "surface_charging_esd" | "single_event_upset" | "hardware_failure",
      label: string,
      confidence: number,          // 0–100
      supporting_evidence: [ ...evidenceRow ],
      reasoning: string            // LLM explanation or deterministic label
    },
    ...
  ],
  top_hypothesis_id: string,       // id of highest-confidence hypothesis
  generated_at: ISO8601 string
}
```

`redTeamChallengePass` returns:
```js
{
  challenged_hypothesis_id: string,
  counter_evidence: [
    {
      type: "missing_signature" | "contradicting_data" | "sensor_limitation",
      description: string,
      confidence_impact: number    // negative integer, e.g. -15
    },
    ...
  ],
  updated_hypotheses: [            // same shape as hypotheses above, scores adjusted
    { id, label, confidence, reasoning }
  ],
  red_team_summary: string,        // LLM or deterministic paragraph
  generated_at: ISO8601 string
}
```

**Todo List**
1. Create `backend/services/` directory.
2. Create `backend/services/aiEngine.js` with the following structure:
   - `require` dotenv, `@langchain/core/messages`, and `@langchain/community/llms/watsonxai`
     (or the ChatModel variant if available).
   - Helper `buildLLMClient()` — returns a configured WatsonxAI instance or `null` if
     `WATSONX_API_KEY` is missing.
   - Helper `classifyEvidence(rows)` — deterministic: partitions evidence rows by source,
     computes peak e_flux, counts elevated-flux readings (> 1 000), detects mag disturbance
     near the anomaly timestamp (±10 min of `2010-04-05T09:48:00Z`). Returns a plain object
     with those metrics for use by both LLM prompts and fallback logic.
   - `generateHypothesesPass(evidenceStream)` — calls Granite with a structured system
     prompt + user message built from `classifyEvidence` metrics, or runs fallback.
   - `redTeamChallengePass(leadingHypothesis, evidenceStream)` — calls Granite with a
     red-team system prompt that names the leading hypothesis and instructs the model to
     find counter-evidence, or runs fallback.
3. Deterministic fallback for Pass 1:
   - ESD baseline 60; +15 if elevated-flux count ≥ 5; +10 if peak e_flux > 2000.
   - SEU baseline 50; +10 if mag disturbance rows found; +5 if elevated-flux count ≥ 3.
   - Hardware Failure baseline 30; -10 if peak e_flux > 2000 (environment clearly elevated).
4. Deterministic fallback for Pass 2 (always generates at least 3 counter-evidence items
   for the ESD hypothesis, matching the known scientific limitations in `case.json`):
   - "no high-energy proton flux sensor on GOES-11 EP8 to directly support SEU"
   - "lack of onboard surface-charging sensors on Galaxy 15 — ESD inferred, not measured"
   - "attitude control remained nominal — ESD events typically disturb attitude sensors"
5. LLM Prompt design (document the prompts inline as JS template literals):
   - System prompt (Pass 1): instructs Granite to act as a space weather analyst,
     return JSON with the required schema, list evidence IDs for each hypothesis.
   - System prompt (Pass 2): instructs Granite to act as a Red-Team agent challenging
     the named hypothesis, return JSON with counter_evidence and updated confidence scores.
   - User message: compact summary of evidence metrics from `classifyEvidence`.
6. Parse Granite's JSON response; fall back to deterministic if JSON is malformed.

**Relevant Context**
- [`backend/server.js`](backend/server.js:142-237) — existing evidence partitioning logic
  (ep8Rows, magRows, anchorRows, peakEp8, magNearAnomaly) — reuse the same thresholds.
- [`cases/galaxy-15/case.json`](cases/galaxy-15/case.json) — scientific_limitations array
  provides text for deterministic counter-evidence items.
- LangChain WatsonxAI docs: model id `ibm/granite-3-3-8b-instruct`, endpoint
  `https://us-south.ml.cloud.ibm.com`.

**Status** — `[ ] pending`

---

### Sub-Task 3 — Add `.env` Keys

**Intent**
Document the new environment variables without overwriting any existing `.env` values.
The `.env` file is gitignored, so the plan must also specify which keys to add.

**Expected Outcomes**
- `backend/.env` contains `WATSONX_API_KEY`, `WATSONX_PROJECT_ID`, and `WATSONX_URL`.
- Existing `PORT=5001` line is preserved.
- A `.env.example` file is committed so future contributors know the required keys.

**Todo List**
1. Append the three new keys (empty values) to `backend/.env`:
   ```
   WATSONX_API_KEY=
   WATSONX_PROJECT_ID=
   WATSONX_URL=https://us-south.ml.cloud.ibm.com
   ```
2. Create `backend/.env.example` with the same three keys documented.

**Relevant Context**
- [`backend/server.js`](backend/server.js:1) — `require('dotenv').config()` already loads `.env`.

**Status** — `[ ] pending`

---

### Sub-Task 4 — Register New Endpoints in `server.js`

**Intent**
Wire the two new POST endpoints into the existing Express app. The endpoints follow the
same pattern as the existing GET routes: parse the CSV, guard with 404, delegate to the
service, return JSON.

**Expected Outcomes**
- `POST /api/cases/:id/investigate` returns the Pass 1 result object (hypotheses + scores).
- `POST /api/cases/:id/challenge` returns the combined Pass 1 + Pass 2 result object
  (updated scores + counter-evidence items).
- Both endpoints return `{ error }` with appropriate HTTP status on failure.
- Existing endpoints are not modified.

**Todo List**
1. At the top of `backend/server.js`, add:
   ```js
   const aiEngine = require('./services/aiEngine');
   ```
2. After the existing `GET /api/cases/:id/evidence-graph` block, add:
   ```
   POST /api/cases/:id/investigate
   ```
   Handler: resolve caseId → parseEvidenceCSV → aiEngine.generateHypothesesPass(rows)
   → res.json(result).
3. Add:
   ```
   POST /api/cases/:id/challenge
   ```
   Handler: resolve caseId → parseEvidenceCSV → generateHypothesesPass →
   identify top hypothesis → redTeamChallengePass(topHypothesis, rows) → res.json(result).
4. Both handlers must honour the existing 404 guard pattern (check `casePath` exists
   before calling `parseEvidenceCSV`).

**Relevant Context**
- [`backend/server.js`](backend/server.js:100-115) — existing async route pattern to follow.
- [`backend/server.js`](backend/server.js:27-57) — `parseEvidenceCSV` helper already available.

**Status** — `[ ] pending`

---

### Sub-Task 5 — Verification

**Intent**
Confirm the two new endpoints return structurally valid JSON matching the required schemas,
with both the LLM path and the fallback path exercised.

**Expected Outcomes**
- `curl -X POST http://localhost:5001/api/cases/galaxy-15/investigate` returns JSON with
  a `hypotheses` array, each item having `id`, `label`, `confidence`, `reasoning`, and
  `supporting_evidence`.
- `curl -X POST http://localhost:5001/api/cases/galaxy-15/challenge` returns JSON with
  `counter_evidence` (array, ≥ 1 item), `updated_hypotheses` (array, ≥ 3 items with
  adjusted confidence scores), and `red_team_summary` (non-empty string).
- Server does not crash when `WATSONX_API_KEY` is empty (fallback path runs).

**Todo List**
1. Start the server: `cd backend && node server.js`.
2. Run: `curl -s -X POST http://localhost:5001/api/cases/galaxy-15/investigate | jq .`
   Confirm shape matches the schema in Sub-Task 2.
3. Run: `curl -s -X POST http://localhost:5001/api/cases/galaxy-15/challenge | jq .`
   Confirm `counter_evidence` is present and has at least one item with `type`,
   `description`, and `confidence_impact`.
4. If `WATSONX_API_KEY` is populated, confirm `reasoning` fields contain LLM-generated
   text (not the deterministic fallback labels).
5. Record any schema mismatches and update `aiEngine.js` accordingly.

**Relevant Context**
- Verification command from task spec: `POST http://localhost:5001/api/cases/galaxy-15/challenge`
- Expected response must contain explicit `counter_evidence` items and updated
  `confidence` scores.

**Status** — `[ ] pending`

---

## Implementation Notes

- `server.js` uses CommonJS (`require`). LangChain v0.3 packages are ESM-first but
  ship CJS builds — verify the import path resolves under CommonJS before committing
  (use `require('@langchain/community/llms/watsonxai')` or the `/dist/cjs/` path).
- Do not restructure `server.js` beyond the two new route blocks and the one new `require`.
- Keep the deterministic fallback self-contained so it can be unit-tested without API keys.
- IBM Watsonx token auth uses `WATSONX_API_KEY` + `WATSONX_PROJECT_ID`; the LangChain
  `WatsonxAI` class constructor reads these from env automatically.
