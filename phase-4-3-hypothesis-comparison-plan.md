# Phase 4.3 — Hypothesis Comparison Layer

## Top-Level Overview

Add a `buildHypothesisComparison` function (replacing the internal helper of the same
name) and surface its output as a new `hypothesis_comparison` field on the
`buildForensicAnalysis` output.

The per-entry shape is:
```js
{
  hypothesis_id,
  label,
  assessment,
  evidence_profile,   // concise counts + auditable id lists
  key_observations,   // string[] — what the evidence establishes / cannot establish
  key_limitations     // AnalysisLimitation[] — most relevant limitations (non-empty)
}
```

This answers the six forensic questions without creating rankings, probabilities, or
causal claims.

**Scope:** Two files only.
- `backend/services/forensicAnalysis.js` — new internal helper, new export, bump version.
- `backend/tests/forensicAnalysis.test.js` — append F11–F17.

Nothing else changes.

---

## Architecture Position

```
buildForensicAnalysis(caseId, graph)
  │
  ├─ buildHypothesisAnalysis × 5           (existing)
  ├─ buildHypothesisClassification          (existing helper, renamed internally)
  ├─ buildDetailedHypothesisComparison      (NEW — Phase 4.3)
  ├─ buildCaseEvent                         (existing)
  ├─ buildAggregateEvidenceSummary          (existing)
  └─ validateForensicAnalysis               (existing)
```

The existing `comparison` field (with `assessed_hypotheses`, `supported_hypotheses`,
`mixed_hypotheses`, `insufficient_hypotheses`, `most_supported`) is **preserved
untouched** — no existing tests will break.

The new field `hypothesis_comparison` is added alongside it.

---

## Output Shape — HypothesisComparisonEntry

```js
{
  hypothesis_id:    string,
  label:            string,
  assessment:       string,         // categorical only
  evidence_profile: {
    environmental_context_count:        number,
    supporting_evidence_count:          number,
    contradicting_evidence_count:       number,
    non_discriminating_evidence_count:  number,
    environmental_context_ids:          string[],
    supporting_evidence_ids:            string[],
    contradicting_evidence_ids:         string[],
    non_discriminating_evidence_ids:    string[]
  },
  key_observations: string[],       // 1–4 auditable statements drawn from evidence
  key_limitations:  AnalysisLimitation[]  // subset of hypothesis limitations
}
```

`evidence_profile` is the same shape as `EvidenceSummary` — reuses
`buildEvidenceSummary` directly.

`key_observations` are deterministic strings derived from the evidence counts
and assessment. Rules per hypothesis type:

| Condition | key_observation added |
|-----------|----------------------|
| `environmental_context_count > 0` | "Environmental context documented: {count} record(s) establish preconditions contemporaneous with the anomaly." |
| `supporting_evidence_count > 0` | "Direct supporting evidence: {count} record(s) are consistent with this hypothesis." |
| `contradicting_evidence_count > 0` | "Contradicting evidence: {count} record(s) are inconsistent with this hypothesis." |
| `non_discriminating_evidence_count > 0` | "Non-discriminating evidence: {count} record(s) are consistent with multiple hypotheses." |
| `supporting_evidence_count === 0 && environmental_context_count === 0 && contradicting_evidence_count === 0` | "No evidence in this dataset speaks to this hypothesis." |
| assessment === `'mixed'` | "Assessment is mixed: environmental context exists but no direct mechanism evidence is available." |
| assessment === `'insufficient_evidence'` | "Insufficient evidence: this hypothesis cannot be evaluated from the available dataset." |
| assessment === `'strongly_supported'` | "Causal attribution is not established; the absence of discriminating evidence is itself a supported finding." |

Observations are non-empty strings; no probabilities, scores, or causal-certainty language.

`key_limitations` is a copy of `hypothesis.limitations` (the full array from
the graph). It is NOT a subset — every limitation for the hypothesis is preserved.
The field name `key_limitations` signals relevance to the comparison layer without
implying truncation.

---

## Six Forensic Questions — Mapping to Output

| Question | Where answered |
|----------|---------------|
| What does the evidence establish? | `key_observations` (supporting/contradicting entries) |
| What environmental context exists? | `evidence_profile.environmental_context_count` + `key_observations` env entry |
| Which hypotheses have direct supporting evidence? | `evidence_profile.supporting_evidence_count > 0` |
| Which hypotheses lack discriminating evidence? | `assessment === 'insufficient_evidence'` or all counts 0 |
| What relevant evidence is missing? | `key_limitations` (type === 'missing_data') |
| Why can causal attribution not be established? | `key_observations` on H5 + top-level `causal_attribution_established: false` |

---

## Galaxy 15 Expected Output (Phase 4.3 Verification)

| hid | assessment | env_ctx | sup_ev | key_obs count |
|-----|-----------|---------|--------|--------------|
| H1 | mixed | 4 | 0 | ≥2 |
| H2 | mixed | 24 | 0 | ≥2 |
| H3 | supported | 0 | 1 | ≥1 |
| H4 | insufficient_evidence | 0 | 0 | ≥1 |
| H5 | strongly_supported | 0 | 1 | ≥2 |

---

## Files Changed

| File | Action |
|------|--------|
| `backend/services/forensicAnalysis.js` | Add `buildDetailedHypothesisComparison`, update `buildForensicAnalysis` to include `hypothesis_comparison`, bump `ANALYSIS_VERSION` to `'4.3.0'`, add export |
| `backend/tests/forensicAnalysis.test.js` | Append F11–F17; add `analysis43` fixture variable |

## Files NOT Changed

- `backend/server.js`
- `backend/services/aiEngine.js`
- `backend/tests/evidenceGraph.test.js`
- `backend/tests/evidenceModel.test.js`
- `backend/tests/aiEngine.test.js`
- `cases/galaxy-15/*`
- Anything in `frontend/`

---

## Sub-Tasks

---

### Sub-Task 1 — Extend `backend/services/forensicAnalysis.js`

**Intent:** Add the Phase 4.3 per-hypothesis comparison builder alongside the existing
helpers.  The existing `comparison` field in `buildForensicAnalysis` output is preserved.
A new `hypothesis_comparison` field is added.

**Expected Outcomes:**
- `ANALYSIS_VERSION` updated to `'4.3.0'`.
- New helper `buildKeyObservations(hypothesis)` — returns `string[]` per the rules table.
- New function `buildDetailedHypothesisComparison(graphHypotheses)` — returns
  `HypothesisComparisonEntry[]`, one per graph hypothesis.
- `buildForensicAnalysis` adds `hypothesis_comparison` field to its output object.
- `validateForensicAnalysis` passes (no new invariants needed — existing V1–V6 cover
  all evidence_id references; hypothesis_comparison reuses evidence_summary IDs).
- `buildDetailedHypothesisComparison` added to `module.exports`.

**Todo List:**
1. Bump `ANALYSIS_VERSION` to `'4.3.0'`.
2. Add helper `buildKeyObservations(hypothesis)`:
   - Accept a **graph hypothesis** (has raw `environmental_context[]`, `supporting_evidence[]` etc).
   - Apply the seven observation rules in the order shown in the table.
   - Return a non-empty `string[]`.
3. Add function `buildDetailedHypothesisComparison(graphHypotheses)`:
   - Map over `graphHypotheses`.
   - For each: call `buildEvidenceSummary(h)` for `evidence_profile`, `buildKeyObservations(h)`
     for `key_observations`, copy `h.limitations` into `key_limitations`.
   - Return array of `HypothesisComparisonEntry`.
4. Inside `buildForensicAnalysis`, after the `comparison` line, add:
   ```js
   const hypothesis_comparison = buildDetailedHypothesisComparison(graph.hypotheses);
   ```
   and include it in the returned `analysis` object.
5. Add `buildDetailedHypothesisComparison` to `module.exports`.

**Relevant Context:**
- `buildEvidenceSummary` (line 210) is already written and correct — reuse it directly.
- `buildHypothesisAnalysis` (line 243) already maps over graph hypotheses — the new
  builder follows the same pattern.
- The internal `buildHypothesisComparison` (line 274) must NOT be renamed — it is
  called by both `runForensicAnalysis` and `buildForensicAnalysis`. Keep it as-is.
- `ANALYSIS_VERSION` is tested only as `typeof === 'string'` in T-FA-1 — bumping it
  to `'4.3.0'` causes no regression.

**Status:** [ ] pending

---

### Sub-Task 2 — Append F11–F17 tests

**Intent:** Add the seven Phase 4.3 tests to the existing test file without modifying
any test above them.

**Expected Outcomes:**
- `analysis43` fixture variable holds `buildForensicAnalysis` output after the version bump.
- F11–F17 all pass on first run.
- Tests F1–F10 and T-FA-1–T-FA-15 continue to pass unchanged.

**Test Mapping:**

| Test | Spec | What it verifies |
|------|------|-----------------|
| F11 | comparison includes H1–H5 | `analysis43.hypothesis_comparison` has 5 entries with IDs H1–H5 |
| F12 | comparison preserves assessments | each entry's `assessment` equals the corresponding graph hypothesis `assessment` |
| F13 | comparison does not create numerical probabilities | `JSON.stringify` scan — no `%`, `"confidence":`, `"probability":`, `"score":` |
| F14 | comparison preserves evidence provenance | every id in `evidence_profile.*_ids` exists in the graph id pool |
| F15 | H4 remains insufficient_evidence | `hypothesis_comparison` entry for H4 has `assessment === 'insufficient_evidence'` |
| F16 | H5 remains strongly_supported | entry for H5 has `assessment === 'strongly_supported'` |
| F17 | causal attribution remains false | `analysis43.causal_attribution_established === false` |

**Todo List:**
1. Add `let analysis43;` to the module-scope fixture block.
2. Extend the single `beforeAll` to also set `analysis43 = buildForensicAnalysis(CASE_ID, graph)`.
   (Since `buildForensicAnalysis` is already called for `analysis42`, `analysis43` just
   re-calls it with the same arguments after the version bump — they produce the same
   object shape. Alternatively reuse `analysis42` aliased as `analysis43` if the version
   bump is the only change. Since `buildForensicAnalysis` is deterministic, calling it
   twice is safe — but it's cleaner to just alias: `analysis43 = analysis42`.)
3. Implement F11–F17, numbered `F11:` through `F17:` in test names.
4. For F11: verify `analysis43.hypothesis_comparison` is array of length 5, IDs H1–H5.
5. For F12: for each entry, find matching graph hypothesis and assert `assessment` matches.
6. For F13: scan `JSON.stringify(analysis43.hypothesis_comparison)`.
7. For F14: build graph id pool, scan all `evidence_profile.*_ids` arrays.
8. For F15/F16: find by `hypothesis_id` in `hypothesis_comparison`.
9. For F17: assert `analysis43.causal_attribution_established === false`.

**Relevant Context:**
- Import line already includes `buildForensicAnalysis` — no import changes needed.
- `analysis42` and `analysis43` both produced by `buildForensicAnalysis(CASE_ID, graph)` —
  they are identical objects; using an alias avoids redundant computation.

**Status:** [ ] pending

---

### Sub-Task 3 — Run full test suite and report

**Intent:** Confirm 0 regressions across all 80 existing tests and all 7 new F-tests pass.

**Expected Outcomes:**
- `npm test -- --runInBand` completes with 4 suites, 87 tests, 0 failures.

**Todo List:**
1. Run `npm test -- --runInBand --verbose` from `backend/`.
2. Confirm all suites pass.
3. If any test fails, diagnose and fix without modifying frozen code.
4. Record results in this plan.

**Status:** [ ] pending

---

## Post-Implementation Checklist

- [ ] `ANALYSIS_VERSION` updated to `'4.3.0'`
- [ ] `buildDetailedHypothesisComparison` exported
- [ ] `hypothesis_comparison` field present in `buildForensicAnalysis` output
- [ ] Existing `comparison` field (Phase 4.1/4.2 shape) untouched
- [ ] `key_observations` is a non-empty string array — no probabilities
- [ ] `key_limitations` carries the full limitation array from the graph hypothesis
- [ ] `evidence_profile` reuses `buildEvidenceSummary` — no duplicated logic
- [ ] All `evidence_id` references in `evidence_profile` are graph provenance (V1 still passes)
- [ ] F11–F17 all pass
- [ ] All 80 existing tests pass
- [ ] Total: 87 tests, 4 suites, 0 failures
