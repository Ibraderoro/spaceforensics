# Evidence Graph Refactor Plan

## Overview

Refactor `GET /api/cases/:id/evidence-graph` in `backend/server.js` from its current form —
which uses raw evidence rows, fabricated inline objects, scientifically questionable inferences,
and an arbitrary `value > 1000` threshold — into an evidence-provenance model that:

- References evidence by `evidence_id` rather than duplicating raw rows.
- Exposes five defensible hypotheses (H1–H5) for Galaxy 15.
- Uses only categorical assessments (no fake probabilities).
- Explicitly labels any retained heuristic as such.
- Replaces four specific scientifically-unsound interpretations with correct language.
- Adds `causal_attribution_established: false` at the graph level.
- Adds a new test file covering graph-level invariants.

**Scope:** `backend/server.js` (route handler only) + new test file `backend/tests/evidenceGraph.test.js`.  
**Out of scope:** frontend, AI engine, data ingestion, case.json, CSV files.

---

## Sub-Task 1 — Rewrite the Evidence Graph Route Handler

**Intent:**  
Replace the current `app.get('/api/cases/:id/evidence-graph', …)` handler with one that
implements the evidence-provenance model: five hypotheses (H1–H5), correct
scientific language, categorical assessments, evidence_id references, and
`causal_attribution_established: false`.

**Expected Outcomes:**
- The route returns a JSON object matching the required schema.
- Five hypotheses are present: H1 (ESD), H2 (SEU/latchup), H3 (command-processing fault),
  H4 (ground/RF anomaly), H5 (insufficient evidence).
- Every evidence reference uses an `evidence_id` string (e.g. `"E-G15-0245"`), not a raw row copy.
- No duplicate `evidence_id` within any single relationship list for a given hypothesis.
- No object in the graph claims causality.
- The four unsound reasoning strings (A–D from the brief) are absent; their replacements are present.
- The arbitrary `value > 1000` threshold is either removed or explicitly labelled `heuristic_note`.
- `causal_attribution_established: false` appears at the top level of the response.
- `assessment` uses only the allowed categorical values or is omitted when unresolved.

**Todo List:**
1. Add a helper `buildEvidenceGraph(caseId, rows)` inside `backend/server.js` that accepts
   the already-parsed rows array and returns the structured graph object (keeps route handler thin).
2. In the helper, build a lookup of `evidence_id` → row for each source class:
   - `ep8Rows` — source = `GOES11_EP8`
   - `magRows` — source = `GOES11_MAG`
   - `ephRows` — source = `GOES11_EPHEMERIS`
   - `anchorRows` — source = `CASE`
3. Identify the IDs to reference for each hypothesis:
   - **Supporting EP8 evidence:** all `GOES11_EP8` evidence_ids (elevated flux environment).
     If any flux-based filtering is applied (e.g. ±10 min window or a value threshold), label it
     `heuristic_note: "MVP threshold — not a calibrated scientific cutoff"` and do NOT call the
     result a probability or confidence score.
   - **Supporting MAG evidence for H2:** `GOES11_MAG` records within ±10 min of anomaly timestamp
     (`2010-04-05T09:48:00Z`). Label the window as a heuristic selection window.
   - **Anchor event for H3/H5:** the `CASE` source record(s) IDs.
4. Construct the five hypothesis objects using the schema:
   ```
   {
     hypothesis_id,
     label,
     description,
     supporting_evidence: [{ evidence_id, relationship, interpretation }],
     contradicting_evidence: [{ evidence_id, relationship, interpretation }],
     non_discriminating_evidence: [{ evidence_id, relationship, interpretation }],
     limitations: [{ type: "missing_data"|"proxy_measurement"|"unresolved", description }],
     assessment   // categorical string or null
   }
   ```
5. Populate H1 (ESD / spacecraft charging):
   - Supporting: EP8 electron flux records near the anomaly window (with heuristic label if
     a value or time filter is applied); relationship: `"elevated_electron_flux_environment"`.
   - Non-discriminating: anchor event IDs; relationship: `"command_loss_consistent_with_multiple_mechanisms"`.
   - Contradicting evidence list: empty (no measured contradicting signal; absence of attitude
     anomaly data is a limitation, not a contradiction).
   - Limitations: (a) "Continued nominal attitude behavior does not independently confirm a
     spacecraft-wide electrical disturbance and does not by itself rule out a localized
     charging/ESD event." (b) "GOES-11 EP8 is a proxy measurement ~2° from Galaxy 15 longitude;
     direct in-situ flux at the spacecraft is unavailable."
   - Assessment: `"mixed"` (environmental conditions present but insufficient for causal attribution).
6. Populate H2 (SEU / latchup):
   - Supporting: EP8 IDs + MAG IDs within ±10 min window; relationships:
     `"elevated_particle_flux_environment"` and `"magnetic_field_disturbance_near_anomaly"`.
   - Non-discriminating: anchor event IDs.
   - Contradicting evidence list: empty (continued transponder operation is a limitation, not
     a direct measured contradiction).
   - Limitations: (a) "Continued payload/transponder operation constrains hypotheses involving
     spacecraft-wide failure, but does not rule out a localized electronic upset." (b) "5-minute
     EP8 averaging masks sub-minute impulsive flux increases that may cause single-event upsets."
   - Assessment: `"mixed"`.
7. Populate H3 (command receiver / command-processing fault):
   - Supporting: anchor event IDs; relationship: `"persistent_command_unresponsiveness"`.
   - Non-discriminating: EP8 and MAG IDs (environmental data neither confirms nor rules out
     an internal command fault); relationship: `"environmental_conditions_neither_confirm_nor_exclude"`.
   - Contradicting evidence list: empty.
   - Limitations: (a) "Extended command unresponsiveness is consistent with a persistent
     command-system fault, but does not establish whether the underlying mechanism was hardware,
     software, latchup, or another failure mode." (b) "Autonomous recovery provides evidence
     against an irreversible catastrophic failure, but does not by itself distinguish among
     recoverable hardware, software, power-state, latchup, or command-processing mechanisms."
   - Assessment: `"supported"` (directly evidenced by the anchor event; mechanism unresolved).
8. Populate H4 (ground segment / RF link anomaly):
   - Supporting evidence list: empty (no RF or ground-segment telemetry in the dataset).
   - Non-discriminating: EP8 and MAG IDs.
   - Contradicting evidence list: empty.
   - Limitations: (a) "No ground-segment or RF link data is present in this dataset. This
     hypothesis cannot be evaluated from the available evidence."
   - Assessment: `"insufficient_evidence"`.
9. Populate H5 (insufficient evidence for causal attribution):
   - Supporting: anchor event IDs; relationship: `"anomaly_unresolved_after_investigation"`.
   - Non-discriminating: EP8 and MAG IDs.
   - Limitations: (a) "Causal attribution is not established by the available evidence, per
     case.json." (b) "Recovery event prevents ruling out any recoverable failure mode."
   - Assessment: `"strongly_supported"` (this is the outcome the evidence directly warrants).
10. At the top level include:
    - `case_id`
    - `causal_attribution_established: false`
    - `hypotheses: [H1, H2, H3, H4, H5]`
11. Export `buildEvidenceGraph` alongside `parseEvidenceCSV` for test use:
    `module.exports = { parseEvidenceCSV, buildEvidenceGraph };`
12. Replace the existing route handler body with: parse rows → call
    `buildEvidenceGraph(caseId, rows)` → `res.json(graph)`.

**Relevant Context:**
- Route to replace: `backend/server.js` lines 186–308.
- Evidence ID format: `E-G15-NNNN` (1-based, 4-digit zero-padded), assigned in `parseEvidenceCSV`.
- Anchor event timestamp: `2010-04-05T09:48:00Z` (from `cases/galaxy-15/case.json`).
- Total records: 278 (E-G15-0001 to E-G15-0278).
- Source classes: `GOES11_EP8`, `GOES11_MAG`, `GOES11_EPHEMERIS`, `CASE`.
- `causal_attribution` field in `case.json`: "Causal attribution is not established by the available evidence."
- Existing `module.exports` at bottom of server.js exports only `parseEvidenceCSV`.

**Status:** [ ] pending

---

## Sub-Task 2 — Write Evidence Graph Tests

**Intent:**  
Add `backend/tests/evidenceGraph.test.js` covering all invariants specified in the brief:
every evidence reference exists, no duplicate IDs within a relationship list, no causality
claims, limitations represented, H5 returnable, valid JSON, Galaxy 15 has no
causation-established result.

**Expected Outcomes:**
- All tests pass via `npm test` in `backend/`.
- Existing 16 tests in `evidenceModel.test.js` continue to pass.
- Tests do NOT inspect specific evidence_id values (those are fragile); they inspect structural
  and semantic invariants.

**Todo List:**
1. Create `backend/tests/evidenceGraph.test.js`.
2. Import `{ parseEvidenceCSV, buildEvidenceGraph }` from `../server`.
3. In `beforeAll`: call `parseEvidenceCSV('galaxy-15')` and then
   `buildEvidenceGraph('galaxy-15', rows)` to get the graph fixture.
4. Build a `Set` of all valid `evidence_id` strings from the parsed rows for reference lookups.
5. Write the following test cases:

   **T1 — Valid JSON structure**  
   Graph has `case_id`, `causal_attribution_established`, `hypotheses` array.

   **T2 — Five hypotheses present**  
   `hypotheses` has length 5; all expected `hypothesis_id` values (H1–H5) are present.

   **T3 — Every referenced evidence_id exists**  
   For every hypothesis, for every relationship list (`supporting_evidence`,
   `contradicting_evidence`, `non_discriminating_evidence`), every `evidence_id` string is
   present in the valid IDs set from step 4.

   **T4 — No duplicate evidence_id within a relationship list**  
   For each hypothesis and each relationship list, the list of `evidence_id` strings has no
   duplicates (Set size equals array length).

   **T5 — No hypothesis claims causality**  
   No `assessment` value equals `"proven"`, `"confirmed"`, `"causation_established"`,
   `"causal"`, or `"definitive"`. No `description` or `interpretation` string contains
   the substring `"proves"`, `"confirms causation"`, or `"is caused by"`.

   **T6 — Limitations are represented**  
   Every hypothesis has at least one entry in its `limitations` array.

   **T7 — H5 is present and returnable**  
   The hypothesis with `hypothesis_id: "H5"` exists in the hypotheses array and has
   `assessment: "strongly_supported"`.

   **T8 — causal_attribution_established is false for Galaxy 15**  
   `graph.causal_attribution_established === false`.

   **T9 — No unsound reasoning strings present**  
   The serialised graph JSON must not contain any of the four forbidden phrases:
   - `"No attitude anomaly"` (or `"no attitude anomaly"`)
   - `"Transponders remained active, therefore SEU is contradicted"`
   - `"9-month command loss proves hardware failure"`
   - `"physical hardware destruction is ruled out"` (autonomous reboot over-claim)

   **T10 — All relationship objects have required fields**  
   Every object inside any relationship list has `evidence_id` (string), `relationship`
   (string), and `interpretation` (string).

   **T11 — Assessments use only allowed categorical values or null**  
   All non-null `assessment` values are one of:
   `"strongly_supported"`, `"supported"`, `"mixed"`, `"weakly_supported"`, `"insufficient_evidence"`.

**Relevant Context:**
- Test framework: Jest (already configured in `backend/package.json`).
- Existing test pattern: `backend/tests/evidenceModel.test.js`.
- `buildEvidenceGraph` is added in Sub-Task 1 and exported from `backend/server.js`.

**Status:** [ ] pending

---

## Validation

After both sub-tasks are implemented, run:
```
cd backend && npm test
```
All 16 existing tests plus all 11 new tests must pass with no warnings.

The response for `GET /api/cases/galaxy-15/evidence-graph` must be inspectable
via `curl http://localhost:5000/api/cases/galaxy-15/evidence-graph` and return valid JSON
with `causal_attribution_established: false` and five hypotheses.
