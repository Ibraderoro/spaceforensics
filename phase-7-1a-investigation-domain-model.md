# Phase 7.1A — Investigation Domain Model Reconnaissance

**Status:** Design only. No implementation. No code changes.**
**Baseline:** 768 tests passing. 0 failures. Galaxy-15 byte-identical to Phase 5. test-case-alpha fully isolated.

---

## A. Domain Model

### Entity Catalogue

Ten entities are defined. Each entry states: what the entity is, where its source of truth lives, whether it is mutable, how it is produced, its required identifiers, and its audit requirements.

---

#### 1. Case

**What it is:** The root administrative envelope for one investigation. Contains metadata (title, description, target asset, data window, anchor event, recovery event, scientific limitations, data sources). Does not contain evidence or analytical conclusions.

| Property | Value |
|---|---|
| Source of truth | `cases/<case_id>/case.json` — file on disk, version-controlled |
| Mutability | **Immutable at runtime.** Modified only by curators through source-control commits. Never written by the API, by analysts, or by AI. |
| Production mode | **Deterministic** (hand-authored, committed). |
| Required identifiers | `case_id` (string, filesystem-safe slug, e.g. `galaxy-15`). Must be unique across all cases. |
| Relationship to `case_id` | It *is* the definition of a case. All other entities reference it. |
| Relationship to `evidence_id` | None directly. Declares `data_sources` that describe where evidence came from, not the evidence rows themselves. |
| Relationship to `hypothesis_id` | None. Hypothesis definitions live in `hypotheses.json`. |
| Audit requirements | File-level: git commit hash, commit timestamp, author. No runtime audit log required. Changes must not be deployed without a passing test suite referencing the new case. |

---

#### 2. Evidence

**What it is:** A single measurement row from the normalised CSV. Twelve fixed fields: `evidence_id`, `timestamp`, `source`, `measurement`, `value`, `unit`, `resolution`, `dataset_id`, `provider`, `variable`, `evidence_type`, `quality`. Produced entirely from external instrument archives.

| Property | Value |
|---|---|
| Source of truth | `cases/<case_id>/normalized/<case_id>.csv` — parsed at request time by `parseEvidenceCSV`. |
| Mutability | **Immutable.** No endpoint writes to the CSV. No analyst or AI operation modifies, appends, or deletes rows. |
| Production mode | **Deterministic.** Ingested from external data providers; normalised by a curator-controlled ETL step. |
| Required identifiers | `evidence_id` (string, format `<PREFIX>-NNN`, e.g. `G15-001`). Must be unique within a case. The prefix is defined in `case.json` `id_prefix`. |
| Relationship to `case_id` | Scoped strictly to one case. `evidence_id` is only meaningful within its case namespace. Cross-case reference is forbidden. |
| Relationship to `evidence_id` | It *is* identified by `evidence_id`. |
| Relationship to `hypothesis_id` | None at the row level. The evidence graph (entity 3) maps evidence to hypotheses. |
| Audit requirements | CSV checksum stored at build time. Any change to the CSV must produce a detectable change in the checksum, which the test suite verifies against the Phase 5 baseline. |

---

#### 3. Evidence Graph

**What it is:** The computed mapping from evidence rows to hypotheses, produced by `buildEvidenceGraph(caseId, rows)`. Contains the temporal-window selection result: which evidence IDs appear in each of the four relationship lists (`environmental_context`, `supporting_evidence`, `contradicting_evidence`, `non_discriminating_evidence`) for each hypothesis. Also carries the case-level `causal_attribution_established` boolean.

| Property | Value |
|---|---|
| Source of truth | Computed from CSV rows + `hypotheses.json` at request time. Not persisted to disk. |
| Mutability | **Immutable once built.** The graph object is frozen in memory for the lifetime of one request pipeline. |
| Production mode | **Deterministic.** Same inputs always produce identical output. |
| Required identifiers | `case_id`. Each hypothesis entry carries `hypothesis_id`. Each evidence reference carries `evidence_id`. |
| Relationship to `case_id` | One graph per case per pipeline run. |
| Relationship to `evidence_id` | Contains `evidence_id` references drawn verbatim from the CSV. No IDs can exist in the graph that do not first exist in the CSV. |
| Relationship to `hypothesis_id` | Carries the full set of `hypothesis_id` values from `hypotheses.json`. Each maps evidence to one of the four relationship lists. |
| Audit requirements | Validated by `validateForensicAnalysis` (invariants V1–V6) on every pipeline run. Any graph that fails validation throws `ForensicAnalysisValidationError`; the request is rejected. |

---

#### 4. Forensic Analysis

**What it is:** The output of `buildForensicAnalysis(caseId, graph)`. A structured analytical object containing: per-hypothesis assessments, evidence summaries, hypothesis comparison, aggregate limitations, and key observations. All values are derived deterministically from the evidence graph. No LLM involved.

| Property | Value |
|---|---|
| Source of truth | Computed from the evidence graph. Not persisted. |
| Mutability | **Immutable.** Once validated and returned, no downstream step may alter `assessment`, `causal_attribution_established`, or any evidence-relationship field. Enforced by `assembleValidatedForensicReport`. |
| Production mode | **Deterministic.** `ANALYSIS_VERSION` is a constant. Same graph always produces identical analysis. |
| Required identifiers | `case_id`, `analysis_version`. Each hypothesis entry carries `hypothesis_id`. |
| Relationship to `case_id` | One analysis per case per pipeline run. |
| Relationship to `evidence_id` | All `evidence_id` values present in hypothesis lists are drawn from the graph's evidence pool. Fabricated IDs are rejected by V1. |
| Relationship to `hypothesis_id` | Assessment vocabulary is one of: `strongly_supported`, `supported`, `mixed`, `weakly_supported`, `insufficient_evidence`. Assessments are set in `hypotheses.json`, not computed from evidence counts. |
| Audit requirements | V1–V6 validation on every build. `assembleValidatedForensicReport` enforces immutability at assembly time (I1, I2). |

---

#### 5. AI Narrative

**What it is:** The output of `generateAnalystNarrative(analysis, validIds, graph)`. A structured explanation of the forensic analysis, written by the LLM (or the deterministic heuristic fallback). Contains: `executive_summary`, `event_description`, `hypothesis_assessments` (with reasoning only — assessments copied verbatim), `strongest_observations`, `major_uncertainties`, `missing_evidence`, `causal_attribution_established`, `source`, `generated_at`.

| Property | Value |
|---|---|
| Source of truth | LLM output (source: `llm`) or heuristic fallback (source: `heuristic`). Not persisted. |
| Mutability | **Immutable once assembled.** The final `ValidatedForensicReport` merges analysis and narrative; the narrative fields are additive — they do not overwrite any deterministic field. |
| Production mode | **AI-derived** (with heuristic fallback). |
| Required identifiers | None of its own. References `case_id`, `hypothesis_id` values from the source analysis. |
| Relationship to `case_id` | Inherited from the analysis it explains. |
| Relationship to `evidence_id` | May cite `evidence_id` values in `hypothesis_assessments[].evidence_ids`, but only values present in `validIds`. Fabricated IDs rejected by A6. |
| Relationship to `hypothesis_id` | Must include an assessment entry for every hypothesis in the source analysis (B4). Must not introduce new hypothesis IDs (A4). |
| Audit requirements | Validated by `validateAnalystResponse` (A1–A10, B1–B4) before acceptance. LLM failures log an error and fall back to heuristic — the fallback is also validated. |

---

#### 6. Investigation

**What it is:** A named, time-bounded analytical session in which one or more analysts examine a case, record observations, raise challenges, make decisions, and produce artifacts. An investigation is the operational container that wraps a case — it does not replace, re-run, or mutate the forensic pipeline. It refers to a forensic analysis snapshot by reference.

| Property | Value |
|---|---|
| Source of truth | Investigation store (new, write-able persistence layer — design only here). |
| Mutability | **Mutable by analysts.** Status (`open` → `suspended` → `closed`), title, participants, and linked artifacts change over time. The forensic analysis snapshot it references does not change. |
| Production mode | **Analyst-created.** Opened explicitly. |
| Required identifiers | `investigation_id` (UUID, system-generated at open time). `case_id` (foreign key, validated against the cases directory). `opened_at` (ISO 8601 timestamp). `opened_by` (analyst identifier). |
| Relationship to `case_id` | One investigation belongs to exactly one case. Multiple investigations may exist per case (e.g. re-opened after new data). |
| Relationship to `evidence_id` | None directly. Evidence is accessed through the forensic pipeline, not through the investigation entity. |
| Relationship to `hypothesis_id` | May reference `hypothesis_id` values when linking decisions or observations, but may not define new hypotheses or modify existing ones. |
| Audit requirements | Full lifecycle event log: `opened`, `suspended`, `resumed`, `closed`. Each event records: `investigation_id`, `case_id`, `actor`, `timestamp`, `reason`. |

---

#### 7. Analyst Observation

**What it is:** A free-text note authored by an analyst about a specific aspect of the investigation: a pattern noticed in the evidence, a question about a hypothesis, a relevant external reference, a note about a limitation. Not evidence. Not analysis. Not AI output.

| Property | Value |
|---|---|
| Source of truth | Investigation store. Owned by the investigation. |
| Mutability | **Mutable by the authoring analyst** (within the open investigation). Soft-deleted if superseded; never hard-deleted (audit trail must be preserved). |
| Production mode | **Analyst-created.** |
| Required identifiers | `observation_id` (UUID). `investigation_id` (foreign key). `authored_by`. `authored_at`. |
| Relationship to `case_id` | Inherited through `investigation_id → case_id`. Never stored directly — derived on read. |
| Relationship to `evidence_id` | May *reference* one or more `evidence_id` values as context (read-only citation). Must not create or modify evidence. Referenced IDs must exist in the case's evidence set at time of authoring. |
| Relationship to `hypothesis_id` | May reference a `hypothesis_id` as context. Must not change the assessment of the referenced hypothesis. |
| Audit requirements | Append-only edit log. Each version retains: `observation_id`, `version`, `text`, `authored_by`, `authored_at`. Deletion is a soft state flag; the content is retained. |

---

#### 8. Analyst Challenge

**What it is:** A structured record in which an analyst formally disputes or questions a hypothesis assessment, an evidence classification, or a limitation statement. A challenge is not a command — it cannot mutate any deterministic field. It is a documented disagreement or question, pending review.

| Property | Value |
|---|---|
| Source of truth | Investigation store. |
| Mutability | **Mutable** (status changes: `open` → `reviewed` → `accepted` / `rejected`). The target field being challenged is immutable. |
| Production mode | **Analyst-created.** |
| Required identifiers | `challenge_id` (UUID). `investigation_id`. `authored_by`. `authored_at`. `target_type` (`hypothesis_assessment` / `evidence_classification` / `limitation`). `target_id` (the `hypothesis_id` or `evidence_id` being challenged). |
| Relationship to `case_id` | Inherited through `investigation_id`. |
| Relationship to `evidence_id` | May cite evidence IDs as justification. Cannot reclassify them. |
| Relationship to `hypothesis_id` | Must reference an existing `hypothesis_id`. Cannot change the `assessment` value — it can only record a dispute. |
| Audit requirements | Full status history: who raised it, when, what was disputed; who reviewed it, when, what decision was reached; supporting rationale text at each step. |

---

#### 9. Investigation Decision

**What it is:** A formal record that an analyst or review authority has reached a named conclusion during the investigation. Examples: "CLOSED — insufficient data to discriminate H1 and H2", "ESCALATED — recommend acquiring direct telemetry". A decision is a management record, not a forensic conclusion. It does not alter causal attribution or hypothesis assessments.

| Property | Value |
|---|---|
| Source of truth | Investigation store. |
| Mutability | **Immutable once recorded.** A subsequent decision supersedes a prior one by reference, not by mutation. |
| Production mode | **Analyst-created.** |
| Required identifiers | `decision_id` (UUID). `investigation_id`. `decided_by`. `decided_at`. `decision_type` (controlled vocabulary: `closed`, `escalated`, `deferred`, `re-opened`, `supplemented`). |
| Relationship to `case_id` | Inherited through `investigation_id`. |
| Relationship to `evidence_id` | May cite evidence IDs as supporting rationale (read-only). |
| Relationship to `hypothesis_id` | May reference hypothesis IDs in rationale text. Cannot change assessments. |
| Audit requirements | Immutable record. Every decision is an append-only event in the investigation event log. |

---

#### 10. Investigation Artifact

**What it is:** A document, export, screenshot, or derived product produced during or at the conclusion of an investigation. Examples: a forensic report PDF, an exported evidence provenance table, a timeline visualization export. Artifacts are outputs derived from the forensic pipeline and investigation state — they are not inputs to it.

| Property | Value |
|---|---|
| Source of truth | Investigation store (blob reference + metadata). |
| Mutability | **Immutable once committed.** Superseded artifacts are retained with a `superseded_by` reference. |
| Production mode | **Analyst-created or system-generated.** A "generate report" action produces an artifact stamped with the forensic analysis snapshot version and the investigation state at time of generation. |
| Required identifiers | `artifact_id` (UUID). `investigation_id`. `artifact_type`. `created_at`. `created_by`. `analysis_version_snapshot` (the `analysis_version` string at time of generation). |
| Relationship to `case_id` | Inherited through `investigation_id`. |
| Relationship to `evidence_id` | An artifact may *embed* evidence provenance data (read-only snapshot). The embedded data is a copy, not a live reference — it cannot affect the source evidence. |
| Relationship to `hypothesis_id` | An artifact may embed hypothesis assessments (read-only snapshot). |
| Audit requirements | Artifact creation event recorded in the investigation event log. The snapshot fields (`analysis_version_snapshot`, `generated_at`) are set at creation time and are immutable. |

---

## B. Data Relationships

```
Case ──────────────────────────────── 1:1 ──► case.json (filesystem)
  │
  ├── 1:N ──► Evidence (CSV rows, scoped to case_id)
  │              │
  │              └── referenced by ──► Evidence Graph
  │                                        │
  │                                        └── drives ──► Forensic Analysis
  │                                                           │
  │                                                           └── explained by ──► AI Narrative
  │                                                                                    │
  │                                                                    merged into ──► ValidatedForensicReport
  │
  └── 1:N ──► Investigation (operational layer, write-able)
                │
                ├── references ──► Forensic Analysis (snapshot, read-only)
                │
                ├── 1:N ──► Analyst Observation
                │              ├── cites (read-only) ──► evidence_id ∈ Case Evidence
                │              └── cites (read-only) ──► hypothesis_id ∈ Case Hypotheses
                │
                ├── 1:N ──► Analyst Challenge
                │              ├── targets ──► hypothesis_id (cannot mutate)
                │              └── cites  ──► evidence_id (cannot reclassify)
                │
                ├── 1:N ──► Investigation Decision
                │              └── references ──► hypothesis_id / evidence_id (read-only)
                │
                └── 1:N ──► Investigation Artifact
                               └── embeds snapshot of ──► Forensic Analysis (copy, not live ref)
```

**Cross-entity constraints:**

- `evidence_id` is only valid within its own `case_id` namespace. No entity belonging to Case A may hold an `evidence_id` drawn from Case B.
- `hypothesis_id` is only valid within its own `case_id` namespace. Challenges and observations that reference a `hypothesis_id` must resolve that ID against the case linked to their `investigation_id`.
- The forensic pipeline entities (Evidence, Evidence Graph, Forensic Analysis, AI Narrative) form a **read-only spine** for the investigation layer. The investigation layer holds the only write-able entities (Investigation, Observation, Challenge, Decision, Artifact).
- An AI Narrative is part of the forensic pipeline, not the investigation layer. An analyst may read it; an analyst may create an Observation that discusses it. Neither the AI Narrative nor analyst discussion of it feeds back into the forensic pipeline.

---

## C. State Transitions

### Investigation lifecycle

```
                    ┌──────────────────────────────────────────────────────┐
                    │                                                        │
 [CREATE]           │                                                        │
    │               ▼                                                        │
    └──► OPEN ──► SUSPENDED ──► OPEN (resume)                              │
            │                                                                │
            └──────────────────────────────── CLOSED ◄──────────────────────┘
                                                 │
                                          [terminal: append-only from here]
```

- `OPEN → SUSPENDED`: analyst may suspend without closing (e.g. awaiting new data).
- `SUSPENDED → OPEN`: resumed when new data or analyst capacity becomes available.
- `OPEN → CLOSED`: formal closure; requires at least one `Investigation Decision` record.
- `CLOSED → OPEN` (re-open): permitted only through a new `Investigation Decision` of type `re-opened`, which creates a new open epoch on the same investigation record. The closed epoch is not mutated.
- No state transition may modify any forensic pipeline entity.

### Analyst Challenge lifecycle

```
 OPEN ──► UNDER_REVIEW ──► ACCEPTED
                      └──► REJECTED
```

- `ACCEPTED` means the challenge is acknowledged and logged. It does **not** mean the challenged forensic field is changed. The accepted challenge is a permanent record that a dispute existed and was reviewed. Any actual forensic change requires a curator to modify `hypotheses.json` and re-run the pipeline.

### Analyst Observation lifecycle

```
 DRAFT ──► PUBLISHED ──► SUPERSEDED (soft)
```

- A superseded observation's text is retained in the edit history. It is not deleted.

---

## D. Validation Rules

### Cross-cutting ID validation rules

| Rule | Description | Enforced at |
|---|---|---|
| ID-1 | `case_id` in any investigation entity must resolve to a directory in `cases/` | Investigation creation time |
| ID-2 | `evidence_id` cited in observations, challenges, decisions, or artifacts must exist in the case's CSV at citation time | Write time (observation/challenge/decision creation) |
| ID-3 | `hypothesis_id` cited in any investigation entity must exist in the case's `hypotheses.json` at citation time | Write time |
| ID-4 | `evidence_id` from Case A must never appear in any entity belonging to Case B | Write time; also enforced by namespace scoping |
| ID-5 | `hypothesis_id` from Case A must never appear in any entity belonging to Case B | Write time |

### Forensic pipeline immutability rules (existing, carried forward)

| Rule | Description | Source |
|---|---|---|
| I1 | `causal_attribution_established` must be identical in analysis and narrative | `assembleValidatedForensicReport` |
| I2 | Hypothesis `assessment` values in the narrative must match the analysis exactly | `assembleValidatedForensicReport` |
| V1–V6 | Evidence ID pool validity, assessment vocabulary, no env/supporting overlap, no intra-list duplicates | `validateForensicAnalysis` |
| A1–A10, B1–B4 | AI narrative content rules (causal language, hallucinated IDs, mechanism promotion) | `validateAnalystResponse` |

### New investigation layer validation rules

| Rule | Description |
|---|---|
| INV-1 | An Analyst Observation must not set or contain a field named `evidence_id` that is not already in the case's evidence set. |
| INV-2 | An Analyst Observation may cite `evidence_id` values; it must not introduce new `evidence_id` values. Fabricated IDs are rejected. |
| INV-3 | An Analyst Challenge must not mutate `assessment`, `causal_attribution_established`, `environmental_context`, `supporting_evidence`, `contradicting_evidence`, or `non_discriminating_evidence`. |
| INV-4 | An Investigation Decision must not set `causal_attribution_established` to a value that differs from the forensic analysis. |
| INV-5 | An Investigation Artifact's snapshot fields are write-once at creation. A new artifact must be created to reflect updated analysis state. |
| INV-6 | An AI Narrative referenced in an Observation is a read-only citation. The narrative text may not be imported as an Observation body without explicit analyst authorship attribution. |
| INV-7 | Investigation state (status, observations, challenges, decisions) must not be passed as input to `buildForensicAnalysis`, `buildEvidenceGraph`, or `generateAnalystNarrative`. |
| INV-8 | A closed Investigation may not receive new Observations, Challenges, or Decisions unless first re-opened through a Decision of type `re-opened`. |
| INV-9 | `investigation_id` is system-generated (UUID). It must not be client-supplied on creation. |

---

## E. API Implications

### Existing endpoints (unchanged, read-only for investigation layer)

| Endpoint | Role in investigation layer |
|---|---|
| `GET /api/cases` | Enumerates available cases. The investigation layer reads this to validate `case_id` on investigation creation. |
| `GET /api/cases/:id` | Returns case metadata. The investigation layer reads this to validate that a case exists. |
| `GET /api/cases/:id/evidence-graph` | Read-only. Investigation entities may reference its output but must not mutate it. |
| `GET /api/cases/:id/forensic-analysis` | Read-only. Produces the forensic analysis + AI narrative. Investigation creation may capture the `analysis_version` at that moment as a snapshot reference. |
| `GET /api/cases/:id/evidence/:evidenceId/provenance` | Read-only. Used when an analyst observation or challenge cites an evidence ID — the API validates the ID exists before accepting the citation. |

### New endpoints required (design only — not implemented in this phase)

```
POST   /api/cases/:id/investigations
       Body: { title, opened_by, description? }
       Returns: { investigation_id, case_id, status: 'open', opened_at }
       Invariant: case_id must resolve; investigation_id is system-generated UUID.

GET    /api/cases/:id/investigations
       Returns: paginated list of investigations for the case.

GET    /api/cases/:id/investigations/:iid
       Returns: full investigation record including linked entities.

PATCH  /api/cases/:id/investigations/:iid
       Body: { status: 'suspended' | 'closed', reason, decided_by }
       Constraint: status changes only. Closing requires a decision record.
       Constraint: closed investigations cannot be patched except to re-open (via decision endpoint).

POST   /api/cases/:id/investigations/:iid/observations
       Body: { text, authored_by, evidence_ids?: [], hypothesis_ids?: [] }
       Invariant: evidence_ids validated against case CSV (ID-2).
       Invariant: hypothesis_ids validated against case hypotheses.json (ID-3).
       Returns: { observation_id, investigation_id, authored_at }

PATCH  /api/cases/:id/investigations/:iid/observations/:oid
       Body: { text }
       Creates a new version entry. Previous version is retained.

POST   /api/cases/:id/investigations/:iid/challenges
       Body: { target_type, target_id, authored_by, rationale, evidence_ids?: [] }
       Invariant: target_id must resolve against the case.
       Invariant: Cannot set assessment or causal_attribution_established fields.
       Returns: { challenge_id, status: 'open' }

PATCH  /api/cases/:id/investigations/:iid/challenges/:cid
       Body: { status: 'under_review' | 'accepted' | 'rejected', reviewed_by, review_notes }
       Invariant: status is the only mutable field. Target forensic fields are unchanged.

POST   /api/cases/:id/investigations/:iid/decisions
       Body: { decision_type, decided_by, rationale, hypothesis_ids?: [], evidence_ids?: [] }
       Invariant: Immutable once written.
       Invariant: decision_type must be from the controlled vocabulary.

POST   /api/cases/:id/investigations/:iid/artifacts
       Body: { artifact_type, created_by, content_ref }
       System stamps: analysis_version_snapshot, generated_at.
       Invariant: analysis_version_snapshot is set from the current forensic analysis. Not client-supplied.
```

### HTTP error contract extensions

| Code | Condition |
|---|---|
| 404 | `case_id` not found (existing contract) |
| 404 | `investigation_id` not found within the case |
| 422 | Fabricated `evidence_id` in observation/challenge body (ID-2) |
| 422 | Fabricated `hypothesis_id` in observation/challenge body (ID-3) |
| 422 | Attempt to set `assessment` or `causal_attribution_established` via investigation API (INV-3, INV-4) |
| 409 | Attempt to mutate a closed investigation without a re-open decision (INV-8) |
| 403 | Attempt to mutate a forensic pipeline entity via the investigation API |

---

## F. Test Strategy

Tests must be added **without modifying any existing test file**. All 768 existing tests must continue to pass.

### Test surface for the investigation layer

#### F1 — Entity creation and ID validation

- `POST /investigations` with a valid `case_id` → returns a system-generated `investigation_id` (UUID, not client-supplied).
- `POST /investigations` with an unknown `case_id` → 404.
- Two concurrent calls create two distinct `investigation_id` values.

#### F2 — Evidence ID scoping (invariant INV-1, INV-2, ID-2, ID-4)

- Observation citing a valid `evidence_id` from the same case → accepted (201).
- Observation citing a fabricated `evidence_id` (one not in the CSV) → rejected (422).
- Observation citing a valid `evidence_id` from **a different case** → rejected (422) — even if the ID string resolves in that other case's CSV.
- Observation body must not contain a field whose name implies it is creating evidence.

#### F3 — Hypothesis ID scoping (invariant INV-3, ID-3, ID-5)

- Challenge targeting a valid `hypothesis_id` from the same case → accepted.
- Challenge targeting a fabricated `hypothesis_id` → rejected (422).
- Challenge targeting a `hypothesis_id` from a different case → rejected (422).
- Challenge body that attempts to set `assessment` → rejected (422).
- Challenge body that attempts to set `causal_attribution_established` → rejected (422).

#### F4 — Forensic pipeline isolation (invariant INV-7)

- After creating observations and challenges for a case, calling `GET /api/cases/:id/forensic-analysis` must return an identical response to the baseline (bit-for-bit match on deterministic fields).
- The forensic analysis pipeline must not read from the investigation store.
- Investigation state must have no influence on `buildForensicAnalysis`, `buildEvidenceGraph`, or `generateAnalystNarrative` function inputs or outputs.

#### F5 — Investigation state transitions

- `OPEN → SUSPENDED`: succeeds with required fields.
- `CLOSED → mutation` (without re-open decision): returns 409.
- `CLOSED → re-open` (via decision of type `re-opened`): succeeds; old closed epoch retained.
- Challenge status: `open → accepted` does not modify the challenged forensic field.

#### F6 — Analyst observation immutability

- PATCH observation creates a new version; the original version is accessible in the audit log.
- Deleted (soft) observation returns `status: deleted` but text is still retrievable in history by authorized roles.

#### F7 — Cross-case isolation (invariants ID-4, ID-5)

- Evidence IDs from `galaxy-15` must not be accepted in an investigation linked to `test-case-alpha`, and vice versa.
- Two investigations on two different cases must not interfere at any layer.

#### F8 — AI narrative isolation

- Analyst observation that includes AI narrative text verbatim must be stored as an `observation` (analyst-authored), not promoted to `evidence` or `supporting_evidence`.
- The `source` field of an observation must be `analyst`, not `llm` or `heuristic`.

#### F9 — Artifact snapshot integrity

- Artifact creation stamps `analysis_version_snapshot` from the current `buildForensicAnalysis` output, not from a client-supplied value.
- A new artifact created after `hypotheses.json` is modified must carry a different `analysis_version_snapshot` than artifacts created before the change.

#### F10 — Audit log completeness

- Every lifecycle transition (create, suspend, close, re-open) must appear in the audit log with `actor`, `timestamp`, `reason`.
- Challenge reviews must appear in the audit log.
- Observation edits must appear in the version history.

---

## G. Security and Integrity Concerns

### G1 — Evidence fabrication via investigation API

**Risk:** An attacker or careless client posts an investigation observation with a body that looks like an evidence row — containing all 12 evidence fields including an `evidence_id` — and later that data is mistakenly included in a forensic pipeline query.

**Mitigation:** The investigation store must be a completely separate persistence namespace from the evidence CSV. The forensic pipeline functions `parseEvidenceCSV`, `buildEvidenceGraph`, and `buildForensicAnalysis` must receive no input from the investigation store under any code path. The API handlers for investigation endpoints must never call `parseEvidenceCSV` with investigator-supplied data. Enforced by INV-7 and tested by F4.

### G2 — Hypothesis assessment mutation via challenge acceptance

**Risk:** An analyst raises a challenge against H3's `assessment: supported`. A reviewer marks it `accepted`. A downstream consumer interprets `accepted` as the new authoritative assessment.

**Mitigation:** The `accepted` status means only that the challenge was reviewed. The challenge record stores the *original* assessment at challenge time. The forensic analysis assessment is unchanged. The API response for `GET /forensic-analysis` is generated fresh from `buildForensicAnalysis` on every request and carries no investigation state. Enforced by INV-3.

### G3 — Cross-case evidence reference

**Risk:** Case `test-case-alpha` has evidence IDs beginning with `A1-`. If a `galaxy-15` investigation observation cites `A1-001`, and this is not validated, a consumer might interpret it as galaxy-15 evidence.

**Mitigation:** On every citation of `evidence_id` in an investigation write operation, the ID is validated against `parseEvidenceCSV(investigation.case_id)`. The case's own CSV is the authority. An ID not present in that CSV is rejected with 422. Enforced by ID-2, ID-4.

### G4 — Causal language injection via observations

**Risk:** An analyst observation contains the phrase "caused the anomaly", which is picked up by a report generator and inserted into an executive summary that looks like forensic output.

**Mitigation:** Report generation must clearly label its sections. Analyst-authored content must be rendered in a visually and structurally distinct section from forensic analysis output. No causal language filter is applied to observations (analysts are human and may use casual language), but the forensic analysis section remains generated exclusively from the deterministic pipeline — analyst text cannot be injected into it.

### G5 — investigation_id spoofing

**Risk:** A client supplies its own `investigation_id` on creation, potentially colliding with or overwriting an existing investigation.

**Mitigation:** `investigation_id` is always a server-generated UUID (v4). Client-supplied `investigation_id` in the POST body is silently ignored. Enforced by INV-9 and tested by F1.

### G6 — Closed investigation mutation

**Risk:** Investigation is closed and a formal decision is recorded. Later, an observation is added that contradicts the decision, silently changing the investigation's effective conclusion.

**Mitigation:** Write operations to a closed investigation return 409. Re-opening requires an explicit decision record of type `re-opened`, which is append-only and creates a new open epoch. The prior closed state is preserved. Enforced by INV-8 and tested by F5.

### G7 — AI narrative promotion to evidence

**Risk:** The AI narrative `executive_summary` text is stored verbatim as an observation. A consumer misreads the `source: llm` field on the narrative and treats the observation as authoritative forensic output.

**Mitigation:** AI Narrative is a forensic pipeline entity (entity 5) with `source: llm` or `source: heuristic`. Analyst Observation is an investigation entity (entity 7) with `source: analyst`. These are different entities with different schemas, stored in different namespaces. The API must not allow an observation to be created with `source: llm`. Enforced by INV-6 and tested by F8.

---

## H. Explicit Boundaries Between Forensic Truth and Investigation State

This section defines the hard line that no implementation may cross.

### H.1 — The forensic truth spine (read-only, deterministic)

```
case.json  →  hypotheses.json  →  evidence CSV
                                      │
                              parseEvidenceCSV
                                      │
                              buildEvidenceGraph
                                      │
                             buildForensicAnalysis  ←─── ANALYSIS_VERSION constant
                                      │
                           validateForensicAnalysis  ←─── V1–V6
                                      │
                         generateAnalystNarrative  ←─── LLM or heuristic
                                      │
                       validateAnalystResponse  ←─── A1–A10, B1–B4
                                      │
                   assembleValidatedForensicReport  ←─── I1, I2
                                      │
                            ValidatedForensicReport  ← READ ONLY FROM HERE
```

**Nothing on this spine reads from the investigation store. Nothing on this spine is written by an analyst. Nothing on this spine is written by an AI operating outside its validated channel. The spine produces the same output for the same input, always.**

### H.2 — The investigation layer (write-able, analyst-operated)

```
investigation_id
  │
  ├── references forensic analysis (case_id + analysis_version snapshot)
  │       — snapshot is a label, not a live reference
  │       — forensic analysis is NOT re-run or modified by any investigation operation
  │
  ├── analyst observations   (evidence_id citations are read-only; create no new evidence)
  ├── analyst challenges     (hypothesis_id citations are read-only; change no assessments)
  ├── investigation decisions  (append-only; do not change forensic conclusions)
  └── investigation artifacts  (snapshots of output at a point in time; immutable once created)
```

**Nothing in the investigation layer feeds back into the forensic truth spine.**

### H.3 — The boundary rules (summary table)

| Can the investigation layer … | Answer | Enforcement |
|---|---|---|
| Read evidence rows? | ✅ Yes — read-only via existing API | `GET /api/cases/:id/evidence-graph` |
| Add an evidence row? | ❌ No | INV-1; investigation store is separate namespace |
| Cite an evidence_id in an observation? | ✅ Yes — if the ID is real | ID-2 validation at write time |
| Fabricate an evidence_id? | ❌ No | ID-2 → 422 |
| Read hypothesis assessments? | ✅ Yes | `GET /api/cases/:id/forensic-analysis` |
| Change a hypothesis assessment? | ❌ No | INV-3; assessments live in `hypotheses.json`, not the investigation store |
| Accept a challenge and have that change the assessment? | ❌ No | Challenge acceptance is a status change only; INV-3 |
| Read AI narrative? | ✅ Yes | `GET /api/cases/:id/forensic-analysis` |
| Feed AI narrative text into forensic analysis? | ❌ No | INV-7; the pipeline ignores the investigation store |
| Record that an analyst disagrees with the AI narrative? | ✅ Yes — as an analyst observation | Analyst observation is a separate entity |
| Change causal_attribution_established? | ❌ No | INV-4; value is set in `case.json` and `hypotheses.json` |
| Record that causal attribution remains uncertain? | ✅ Yes — as an investigation decision | Decision records the investigative conclusion without changing forensic fields |
| Access evidence from another case? | ❌ No | ID-4 namespace enforcement |
| Access hypotheses from another case? | ❌ No | ID-5 namespace enforcement |

### H.4 — Permanent invariants that must survive all future phases

1. `buildForensicAnalysis` takes no parameters sourced from the investigation store.
2. `buildEvidenceGraph` takes no parameters sourced from the investigation store.
3. `generateAnalystNarrative` takes no parameters sourced from the investigation store.
4. No `investigation_id`, `observation_id`, `challenge_id`, `decision_id`, or `artifact_id` may appear in any field of the `ValidatedForensicReport`.
5. An `evidence_id` that does not exist in the case's normalised CSV at the time of an investigation write operation must be rejected before the operation is persisted.
6. A `hypothesis_id` that does not exist in the case's `hypotheses.json` at the time of an investigation write operation must be rejected before the operation is persisted.
7. The forensic pipeline must produce byte-identical output for `galaxy-15` before and after the investigation layer is introduced, as verified by the existing baseline test.

---

*End of Phase 7.1A — Investigation Domain Model Reconnaissance.*
*No code was modified. This document is a design artefact only.*
