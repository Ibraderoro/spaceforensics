# AI Engine Evidence Provenance Plan

## Top-Level Overview

Upgrade `backend/services/aiEngine.js` so that IBM Granite reasons over
**individual evidence objects with provenance** (evidence_id, timestamp,
measurement, value, unit, source, dataset_id, provider) instead of receiving
only aggregate summary statistics.

Every substantive AI claim must cite specific `evidence_id` values drawn from
the input.  The model must never invent IDs.  Post-response validation rejects
hallucinated IDs and malformed objects before the result leaves the engine.

The existing two-pass architecture (Pass 1 = competing hypothesis generation,
Pass 2 = red-team challenge) is preserved.  The deterministic fallback is also
preserved but re-labelled as **heuristic** rather than scientific probability.

No frontend changes.  No backend routes change their URL or HTTP method.
No other files are modified.

---

## Sub-Tasks

---

### ST-1 — Build evidence snapshot helper

**Status:** `[ ] pending`

**Intent**
Replace `classifyEvidence()` as the sole input formatter.  Add a new helper
`buildEvidenceSnapshot(rows)` that assembles a compact, JSON-serialisable
snapshot of all evidence objects the model may cite, grouped by source.  The
snapshot is the authoritative `evidence_id` allowlist for validation.

The snapshot must include:
- A flat `evidence_index` array: `{ evidence_id, timestamp, source, measurement, value, unit }`
  for every row (capped at a token-safe limit so the prompt stays within
  `maxTokens`; emit the full set but truncate the middle of long series,
  preserving anchor events and the ±30-minute window around the anomaly).
- The case scientific limitations (read from `cases/galaxy-15/case.json`).
- Aggregated metrics retained from `classifyEvidence()` as a **context
  summary**, not as the sole input — they help orient the model but the model
  must still cite specific IDs.

**Expected Outcomes**
- `buildEvidenceSnapshot(rows)` exists and returns `{ evidence_index, scientificLimitations, contextSummary }`.
- The `evidence_index` contains only IDs that exist in the parsed CSV.
- `classifyEvidence()` is kept as an internal utility used by `buildEvidenceSnapshot`.

**Todo List**
1. Keep `classifyEvidence()` unchanged.
2. Add `buildEvidenceSnapshot(rows, caseId)` that calls `classifyEvidence` then
   produces `evidence_index` plus `scientificLimitations` from `case.json`.
3. Cap the evidence_index to ≤ 150 rows for token safety:
   - Always include all CASE rows (anchor events — 1–2 rows, unconditional).
   - Always include EP8 and MAG rows within the ±30-min anomaly window.
   - Fill remaining budget proportionally from the rest of the sensor series.
4. Export `buildEvidenceSnapshot` for test access.

**Relevant Context**
- `classifyEvidence`: `backend/services/aiEngine.js` lines 29–65
- `cases/galaxy-15/case.json`: `scientific_limitations` array, lines 59–66
- Evidence record shape: `{ evidence_id, timestamp, source, measurement, value, unit, dataset_id, provider }`

---

### ST-2 — Redesign Pass 1 prompt to return claim-referenced hypotheses

**Status:** `[ ] pending`

**Intent**
Replace `buildPass1Prompt()` with a new prompt that:

1. Provides the evidence snapshot (evidence_index + limitations + context
   summary) as structured input.
2. Instructs Granite to return hypotheses in the new schema, where each
   hypothesis carries a `claims` array and every claim cites `evidence_ids`.
3. Embeds the 10 scientific rules from the user's requirements directly in the
   system prompt.

New Pass 1 output schema (per hypothesis):
```json
{
  "hypothesis_id": "surface_charging_esd",
  "label": "Surface Charging / ESD",
  "assessment": "supported | weakly_supported | insufficient_evidence | mixed",
  "claims": [
    {
      "claim_id": "C1",
      "statement": "...",
      "evidence_ids": ["E-G15-0042", "E-G15-0047"],
      "relationship": "supports | contradicts | non_discriminating",
      "reasoning": "...",
      "uncertainty": "observed | inferred | unknown"
    }
  ],
  "missing_evidence": ["..."],
  "limitations": ["..."]
}
```

The model must include all three hypothesis IDs.

**Expected Outcomes**
- `buildPass1Prompt(snapshot)` accepts a snapshot instead of `metrics`.
- The system prompt encodes all 10 rules.
- The user message injects the evidence_index as a JSON block.
- The schema in the prompt matches the new output exactly.

**Todo List**
1. Delete the old `buildPass1Prompt(metrics)`.
2. Write `buildPass1Prompt(snapshot)` using the new schema.
3. Embed the 10 scientific rules as numbered instructions in the system prompt.
4. Render `evidence_index` as a compact JSON array in the user message.
5. Raise `maxTokens` to 2048 on the LLM client to accommodate the richer output.

**Relevant Context**
- Old `buildPass1Prompt`: `backend/services/aiEngine.js` lines 218–257
- `buildLLMClient` (maxTokens): line 18

---

### ST-3 — Redesign Pass 2 prompt to return claim-level red-team challenges

**Status:** `[ ] pending`

**Intent**
Replace `buildPass2Prompt()` with a prompt that attacks **individual claims**
(by `claim_id`) instead of producing a generic paragraph.

New Pass 2 output schema (per challenge):
```json
{
  "challenges": [
    {
      "claim_id": "C1",
      "challenge": "...",
      "counter_evidence_ids": ["E-G15-0055"],
      "missing_evidence": ["no onboard charging sensor"],
      "severity": "high | medium | low",
      "revised_assessment": "..."
    }
  ],
  "red_team_summary": "..."
}
```

The red-team must specifically look for the 8 failure modes listed in the
requirements (unsupported causal claims, proxy-vs-direct errors, temporal
correlation mistaken for causation, alternative hypotheses ignored,
overconfidence, hallucinated evidence, missing observations, evidence used
outside its scope).

**Expected Outcomes**
- `buildPass2Prompt(leadingHypothesis, snapshot)` accepts a snapshot.
- The system prompt specifies the 8 red-team failure modes.
- The user message passes the leading hypothesis's `claims` array as JSON.

**Todo List**
1. Delete the old `buildPass2Prompt(leadingHypothesis, metrics)`.
2. Write `buildPass2Prompt(leadingHypothesis, snapshot)` using the new schema.
3. List the 8 red-team attack patterns explicitly in the system prompt.
4. Render the leading hypothesis's claims as JSON in the user message.

**Relevant Context**
- Old `buildPass2Prompt`: `backend/services/aiEngine.js` lines 259–288

---

### ST-4 — Add post-response validation

**Status:** `[ ] pending`

**Intent**
After Granite returns a response, before it leaves `generateHypothesesPass` or
`redTeamChallengePass`, validate:

1. Every `evidence_id` in every `evidence_ids` / `counter_evidence_ids` array
   exists in the `evidence_index` built from the actual CSV rows.  Reject and
   strip (or log + fall through to deterministic) if any unknown ID is found.
2. Every hypothesis object has the required keys: `hypothesis_id`, `label`,
   `assessment`, `claims`, `missing_evidence`, `limitations`.
3. Every claim has `claim_id`, `statement`, `evidence_ids` (array), `relationship`,
   `reasoning`, `uncertainty`.
4. `relationship` is one of `supports | contradicts | non_discriminating`.
5. `uncertainty` is one of `observed | inferred | unknown`.
6. `assessment` is one of the allowed categorical values.
7. No causal-certainty phrases in free-text fields
   (`"proves"`, `"confirms causation"`, `"is caused by"`, `"causation established"`,
   `"proof of"`, `"definitively caused"`).

Validation is a pure function `validatePass1Response(parsed, allowedIds)` that
returns `{ valid: boolean, errors: string[] }`.

A separate `validatePass2Response(parsed, allowedIds)` validates challenge
objects.

On validation failure: log all errors, fall through to the deterministic
fallback (do not surface invalid LLM output to the caller).

**Expected Outcomes**
- `validatePass1Response` and `validatePass2Response` are exported (for tests).
- Any hallucinated evidence_id causes the entire LLM response to be rejected.
- Malformed hypothesis/claim objects are rejected.
- Causal-certainty language triggers rejection.

**Todo List**
1. Write `validatePass1Response(parsed, allowedIds)`.
2. Write `validatePass2Response(parsed, allowedIds)`.
3. Wire both validators into `generateHypothesesPass` and `redTeamChallengePass`
   after JSON.parse succeeds.
4. Export both validators.

**Relevant Context**
- Current parse-and-use pattern: `backend/services/aiEngine.js` lines 306–323

---

### ST-5 — Update deterministic fallback to match new schema

**Status:** `[ ] pending`

**Intent**
`deterministicHypotheses()` currently returns `{ id, label, confidence, reasoning, supporting_evidence }`.
The rest of the engine must now return the new schema regardless of source.
Update the fallback so it outputs the new schema, clearly labelled as
`"source": "heuristic"` (not `"deterministic"` and never `"llm"`).

Retain `confidence` as a backward-compatible integer alongside the new
categorical `assessment` field so the existing frontend does not silently break.
The scoring logic maps to assessment categories as follows:
- score ≥ 70 → `"supported"`
- score 50–69 → `"weakly_supported"`
- score < 50 → `"insufficient_evidence"`

Populate `claims` with heuristic claim objects that cite real evidence_ids
(from the evidence_index passed in).  Each heuristic claim must have
`uncertainty: "inferred"` and note that it is a heuristic assessment.

Update `deterministicCounterEvidence()` to produce the new Pass 2 challenge
schema (list of challenge objects with `claim_id`, `challenge`,
`counter_evidence_ids`, `missing_evidence`, `severity`, `revised_assessment`).

**Expected Outcomes**
- Both fallbacks return the new schema.
- No `confidence` integers in output; only categorical `assessment`.
- Output is labelled `source: "heuristic"`.
- All cited `evidence_ids` in the fallback are real IDs from the input rows.

**Todo List**
1. Update `deterministicHypotheses(metrics, evidenceIndex)` signature to accept
   the evidence_index so it can cite real IDs.
2. Map heuristic score to categorical `assessment`.
3. Populate heuristic `claims` using real IDs for the metric-identified rows
   (peakEp8.evidence_id, elevatedFluxRows[].evidence_id, etc.).
4. Update `deterministicCounterEvidence(leadingHypothesisId, evidenceIndex)` to
   output the new challenge schema.
5. Update `generateHypothesesPass` and `redTeamChallengePass` to pass
   `evidence_index` into the fallback functions.
6. Change `source: 'deterministic'` to `source: 'heuristic'` everywhere.

**Relevant Context**
- `deterministicHypotheses`: `backend/services/aiEngine.js` lines 70–121
- `deterministicCounterEvidence`: `backend/services/aiEngine.js` lines 126–213

---

### ST-6 — Wire everything together in generateHypothesesPass and redTeamChallengePass

**Status:** `[ ] pending`

**Intent**
Refactor the two exported async functions to:
1. Build the evidence snapshot once at the top.
2. Derive the `allowedIds` Set from the snapshot's `evidence_index`.
3. Pass the snapshot to the LLM prompt builders.
4. Validate the LLM response; fall through to heuristic on failure.
5. Return the new schemas consistently, tagged with `source`.

Update the Pass 2 function to carry the Pass 1 leading hypothesis's `claims`
array forward so the red-team can attack them by `claim_id`.

**Expected Outcomes**
- `generateHypothesesPass(evidenceStream)` returns:
  ```json
  {
    "hypotheses": [ ...new schema... ],
    "top_hypothesis_id": "...",
    "source": "llm | heuristic",
    "generated_at": "..."
  }
  ```
- `redTeamChallengePass(leadingHypothesis, evidenceStream)` returns:
  ```json
  {
    "challenged_hypothesis_id": "...",
    "challenges": [ ...new schema... ],
    "updated_hypotheses": [ ...new schema... ],
    "red_team_summary": "...",
    "source": "llm | heuristic",
    "generated_at": "..."
  }
  ```
- Both functions fall through gracefully if Granite fails or is unavailable.

**Todo List**
1. Refactor `generateHypothesesPass` to use `buildEvidenceSnapshot`, new
   prompt builder, validator, and heuristic fallback.
2. Refactor `redTeamChallengePass` similarly.
3. Ensure the leading hypothesis object passed from Pass 1 → Pass 2 includes
   the `claims` array (the `/api/cases/:id/challenge` route already passes the
   top hypothesis through).
4. Confirm `module.exports` still exports only `generateHypothesesPass` and
   `redTeamChallengePass` (plus the new validators for testing).

**Relevant Context**
- `generateHypothesesPass`: `backend/services/aiEngine.js` lines 293–344
- `redTeamChallengePass`: `backend/services/aiEngine.js` lines 349–425
- `/api/cases/:id/challenge` route: `backend/server.js` lines 508–537

---

### ST-7 — Write aiEngine tests

**Status:** `[ ] pending`

**Intent**
Create `backend/tests/aiEngine.test.js` with tests that run entirely in the
**deterministic/heuristic path** (no real API key required).  Tests must cover:

1. **Valid evidence references** — heuristic output cites only IDs from the
   input evidence stream.
2. **Hallucinated evidence ID validation** — `validatePass1Response` rejects
   a parsed object that contains an unknown evidence_id.
3. **Insufficient evidence** — when zero EP8 rows are passed, at least one
   hypothesis carries `assessment: "insufficient_evidence"`.
4. **Counter-evidence schema** — Pass 2 heuristic output has `challenges` array
   with required fields.
5. **Uncertainty labels** — every heuristic claim has `uncertainty: "inferred"`.
6. **Red-team claim-level challenges** — each challenge object has `claim_id`,
   `challenge`, `severity`, `revised_assessment`.
7. **No causal-certainty language** — `validatePass1Response` rejects output
   containing forbidden phrases.
8. **Schema completeness** — Pass 1 output has `hypothesis_id`, `label`,
   `assessment`, `claims`, `missing_evidence`, `limitations` on every
   hypothesis.
9. **source label** — heuristic path returns `source: "heuristic"`.

**Expected Outcomes**
- `backend/tests/aiEngine.test.js` exists and all tests pass.
- Tests run without any environment variable set (offline).
- All tests pass alongside the existing 27 tests.

**Todo List**
1. Create `backend/tests/aiEngine.test.js`.
2. Import `generateHypothesesPass`, `redTeamChallengePass`, `validatePass1Response`,
   `validatePass2Response` from `../services/aiEngine`.
3. Load the real galaxy-15 CSV via `parseEvidenceCSV('galaxy-15')` in `beforeAll`,
   exactly as `evidenceModel.test.js` and `evidenceGraph.test.js` do.
   This ensures heuristic evidence_ids are genuinely valid and the hallucination
   rejection test is non-trivial (fabricate an ID like `"E-G15-9999"` that is
   provably absent from the 278-record set).
4. Write each of the 9 test cases listed above.
5. Run `npm test` from `backend/` and confirm all tests pass.

**Relevant Context**
- Existing tests: `backend/tests/evidenceModel.test.js`, `backend/tests/evidenceGraph.test.js`
- Jest config: `backend/package.json`

---

## Non-Goals

- No frontend changes.
- No new API routes or route URL changes.
- No database or persistence changes.
- No changes to the evidence CSV or `parseEvidenceCSV`.
- No changes to `buildEvidenceGraph` or the `/api/cases/:id/evidence-graph` route.
- No commit.
