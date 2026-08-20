# Galaxy 15 Case Metadata Corrections Plan

## Overview

**Goal:** Correct and strengthen the scientific metadata in `cases/galaxy-15/case.json` without modifying application logic, frontend code, AI prompts, datasets, or APIs.

**Scope:** Exactly one file — `cases/galaxy-15/case.json`.

**Non-goals:** No schema changes, no backend/frontend changes, no new data fetches, no commits.

All changes must be scientifically defensible and traceable to the stated requirements.

---

## Sub-Tasks

---

### Sub-Task 1 — Correct the spacecraft alias

**Intent:**  
Replace the incorrect alias `"AMC-15"` with the authoritative alias `"G-15"` in `target_asset.alias`. AMC-15 was the post-acquisition name used by SES Americom after Intelsat sold the satellite, but the authoritative project designation for this case is G-15. No additional aliases should be added.

**Expected Outcomes:**
- `target_asset.alias` equals `"G-15"`.
- No other fields in `target_asset` are modified.

**Todo List:**
1. In `cases/galaxy-15/case.json`, change `"alias": "AMC-15"` → `"alias": "G-15"`.

**Relevant Context:**
- `cases/galaxy-15/case.json` → `target_asset.alias`

**Status:** [ ] pending

---

### Sub-Task 2 — Remove causal language from the case description

**Intent:**  
The current `description` field implies the geomagnetic storm caused the anomaly. SPACEFORENSICS investigates causality rather than asserts it. The new description must state facts (what happened, what conditions were present) and leave causality as an open investigation question.

**Required content in the new description:**
- Galaxy 15 became unresponsive to ground commands at 2010-04-05T09:48:00Z.
- The anomaly occurred during disturbed geomagnetic and energetic-particle conditions.
- The spacecraft continued transmitting and remained otherwise operational.
- Causality remains an investigation question (no causal claim).

**Expected Outcomes:**
- `description` contains no language attributing the anomaly to space weather.
- `description` accurately reflects the known facts.
- No other fields are modified by this sub-task.

**Todo List:**
1. Rewrite the `description` field in `cases/galaxy-15/case.json` per the requirements above.

**Relevant Context:**
- `cases/galaxy-15/case.json` → `description`

**Status:** [ ] pending

---

### Sub-Task 3 — Add a structured `recovery_event` object

**Intent:**  
A recovery event occurred on 2010-12-26. This should be recorded as structured metadata so the application can calculate duration from timestamps rather than having it hard-coded in prose. The shape mirrors `anchor_event` (timestamp + label + description).

**Recovery event data:**
- `timestamp`: `"2010-12-26T00:00:00Z"`
- `label`: `"autonomous_recovery"`
- `description`: factual statement that the spacecraft resumed responding to ground commands autonomously; no exact duration claim.

**Expected Outcomes:**
- A new top-level field `recovery_event` exists in `case.json`.
- It contains `timestamp`, `label`, and `description` sub-fields.
- The description does not claim an exact duration.
- The existing `anchor_event` is unchanged.

**Todo List:**
1. Add a `recovery_event` object to `cases/galaxy-15/case.json` after `anchor_event`.

**Relevant Context:**
- `cases/galaxy-15/case.json` → `anchor_event` (shape to mirror)

**Status:** [ ] pending

---

### Sub-Task 4 — Add a case-level causal attribution statement

**Intent:**  
Add an explicit top-level field that makes the epistemic status of causal attribution machine-readable and unambiguous. This must state that causal attribution is not established by the available evidence.

**Expected Outcomes:**
- A new top-level field `causal_attribution` exists with value `"Causal attribution is not established by the available evidence."`.
- No existing fields are removed or weakened.

**Todo List:**
1. Add `"causal_attribution": "Causal attribution is not established by the available evidence."` to `cases/galaxy-15/case.json` at the top level.

**Relevant Context:**
- `cases/galaxy-15/case.json` → top-level structure
- Existing `scientific_limitations` already includes a related caveat — this field complements, not replaces, it.

**Status:** [ ] pending

---

### Sub-Task 5 — Validate and produce the diff

**Intent:**  
Confirm the final `case.json` is valid JSON and present the exact diff of all changes for review.

**Expected Outcomes:**
- `cases/galaxy-15/case.json` passes JSON parse validation.
- A clear, readable diff is shown covering all four prior sub-tasks.
- No unrelated lines changed.

**Todo List:**
1. Read the final `cases/galaxy-15/case.json` and verify it parses correctly.
2. Show the diff against the original content.

**Status:** [ ] pending

---

## Preservation Constraints

- `scientific_limitations` array: must remain exactly as-is (no additions, removals, or rewording).
- `data_window`: unchanged.
- `data_sources` array: unchanged.
- `anchor_event`: unchanged (except that `recovery_event` is added alongside it).
- All other existing fields: unchanged.
