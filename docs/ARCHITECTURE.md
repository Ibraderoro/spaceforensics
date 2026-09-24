# SpaceForensics — Architecture

This document describes the internal design of SpaceForensics: how evidence is ingested, how hypotheses are evaluated, how the AI layer is constrained, and how each system boundary is enforced.

---

## Design philosophy

SpaceForensics separates three concerns that LLM-first systems typically conflate:

1. **Evidence ingestion** — reading, normalising, and ID-assigning observational records from source files
2. **Forensic analysis** — deterministic, categorical hypothesis evaluation against the evidence
3. **Narrative synthesis** — AI-generated explanation of the validated forensic result

The AI layer cannot participate in (1) or (2). It receives only the output of (2) as structured input. This ordering is the central architectural constraint from which most other design decisions follow.

---

## System overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  Case files (read-only)                                             │
│  cases/{caseId}/normalized/*_evidence.csv                           │
│  cases/{caseId}/case.json                                           │
│  cases/{caseId}/hypotheses.json                                     │
└────────────────────────┬────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Evidence ingestion  (parseEvidenceCSV)                             │
│  • Deterministic row IDs: E-{CASE}-{NNNN}                          │
│  • Provenance stamped: source, measurement, instrument              │
│  • No interpolation; gaps remain gaps                               │
└────────────────────────┬────────────────────────────────────────────┘
                         │  rows[]
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Evidence cache  (evidenceCaseCache.js)                             │
│  • Source-signature validation on every access                      │
│  • Concurrent cold-load deduplication (_inFlight map)               │
│  • Frozen row objects (Object.freeze); callers get a new array      │
└────────────────────────┬────────────────────────────────────────────┘
                         │  { rows, graph }
                    ┌────┴─────────────────────────────────┐
                    │                                      │
                    ▼                                      ▼
┌───────────────────────────────┐      ┌───────────────────────────────┐
│  Evidence graph               │      │  Evidence exploration service  │
│  (buildEvidenceGraph)         │      │  (evidenceExplorationService)  │
│  • Hypothesis ↔ evidence      │      │  • filter, source, time-window │
│    relationships (typed)      │      │  • anomaly-centered window     │
│  • environmental_context      │      │  • provenance lookup           │
│    separated from supporting  │      │  • hypothesis comparison       │
│  • causal_attribution_        │      │  Read-only; no mutations       │
│    established boolean        │      └──────────────┬────────────────┘
└──────────────┬────────────────┘                     │
               │  graph                               │
               ▼                                      │
┌───────────────────────────────┐                     │
│  Forensic analysis            │                     │
│  (forensicAnalysis.js)        │                     │
│  • Categorical assessments    │                     │
│    (no probabilities)         │                     │
│  • Allowed vocabulary:        │                     │
│    strongly_supported         │                     │
│    supported                  │                     │
│    mixed                      │                     │
│    weakly_supported           │                     │
│    insufficient_evidence      │                     │
│  • Validated before return    │                     │
└──────────────┬────────────────┘                     │
               │  ForensicAnalysis                    │
               ▼                                      │
┌───────────────────────────────┐                     │
│  AI analyst  (aiAnalyst.js)   │                     │
│  • IBM Granite 3.3 8B         │                     │
│  • Receives analysis only —   │                     │
│    not raw rows               │                     │
│  • Validation rules A1–A10    │                     │
│  • Invalid → heuristic        │                     │
│    fallback; result still     │                     │
│    reaches consumer           │                     │
└──────────────┬────────────────┘                     │
               │  AnalystNarrative                    │
               └──────────────────┐                   │
                                  ▼                   ▼
                    ┌─────────────────────────────────────────┐
                    │  Express REST API  (server.js)          │
                    │  36 routes — all forensic data read-only│
                    └─────────────────┬───────────────────────┘
                                      │
                    ┌─────────────────┴───────────────────────┐
                    │                                         │
                    ▼                                         ▼
       ┌────────────────────┐              ┌──────────────────────────┐
       │  React / Vite UI   │              │  PostgreSQL (optional)   │
       │  Tailwind · Recharts│             │  Investigation workflow   │
       └────────────────────┘              │  observations · challenges│
                                           └──────────────────────────┘
```

---

## Evidence ingestion

**File**: [`backend/server.js`](../backend/server.js) — `parseEvidenceCSV`

Evidence is ingested from `cases/{caseId}/normalized/*_evidence.csv`. Each row is assigned a deterministic evidence ID of the form `E-{CASE}-{NNNN}` (e.g. `E-G15-0001`), zero-padded to four digits, in the order rows appear in the CSV.

Properties stamped on every row:

| Field | Source |
|---|---|
| `evidence_id` | Deterministic serial within the case |
| `timestamp` | ISO 8601 value from the CSV |
| `source` | Instrument/dataset identifier (e.g. `GOES11_MAG`) |
| `measurement` | Physical variable name |
| `value` | Observed value |
| `evidence_type` | `environmental_context` or `observational` |
| `instrument` | Sensor name |

No interpolation, averaging, or gap-filling is performed. A missing data point in the source file is a missing row in the evidence set.

---

## Evidence cache

**File**: [`backend/services/evidenceCaseCache.js`](../backend/services/evidenceCaseCache.js)

The cache sits between raw file I/O and all routes that need evidence rows or the evidence graph. It is strictly an infrastructure optimisation — it does not alter any forensic output.

### Source-signature validation

On every `getCaseEvidence(caseId)` call, before returning any cached data, the cache recomputes a signature over the three files that fully determine output:

1. `cases/{caseId}/normalized/*_evidence.csv`
2. `cases/{caseId}/case.json`
3. `cases/{caseId}/hypotheses.json`

Signature = `JSON.stringify(sorted [{ path, mtimeMs, size }])`.

If the signature has changed since the entry was stored, the entry is discarded and a fresh cold load is started. There is no TTL.

### Concurrent cold-load deduplication

When multiple callers request the same uncached case simultaneously, only one `parseEvidenceCSV + buildEvidenceGraph` pair runs. The first caller stores a Promise in `_inFlight`; subsequent callers join that same Promise via `.then()`. The `_inFlight` entry is removed in a `finally` block — on both success and failure — so a failed load never blocks a subsequent retry.

```
caller-1 ──► _inFlight.has('galaxy-15')? No
              → _doLoad('galaxy-15', sig)
              → _inFlight.set('galaxy-15', loadPromise)
              → loadPromise.then(...)

caller-2 ──► _inFlight.has('galaxy-15')? Yes
              → join existing loadPromise.then(...)

caller-3 ──► _inFlight.has('galaxy-15')? Yes
              → join existing loadPromise.then(...)

  loadPromise resolves:
    → _cache.set('galaxy-15', entry)
    → _inFlight.delete('galaxy-15')   ← finally block

caller-1, caller-2, caller-3 all receive { rows: rows.slice(), graph }
```

### Mutation safety

Cached rows are individually frozen via `Object.freeze(Object.assign({}, row))` at load time. Each caller receives a new (unfrozen) array of frozen row references. Callers can sort or filter their copy; they cannot mutate the `evidence_id`, `source`, `value`, or any other field of a row object.

The graph is also a frozen shallow copy. `causal_attribution_established` and `case_id` are non-writable at the top level; the `hypotheses` array and each hypothesis object are frozen; nested evidence-list arrays and their ref objects are frozen.

### Statistics

`getStats()` returns:

```js
{
  size,          // number of currently cached cases
  hits,          // requests served from cache (valid signature)
  misses,        // requests that triggered a cold load or joined an in-flight
  invalidations, // entries removed by stale signature or explicit call
  inFlight,      // number of active in-flight load Promises
}
```

---

## Evidence graph

**File**: [`backend/server.js`](../backend/server.js) — `buildEvidenceGraph`

The evidence graph links each hypothesis to its relevant evidence rows using four typed relationship categories:

| Relationship | Meaning |
|---|---|
| `supporting_evidence` | Evidence consistent with the hypothesis |
| `contradicting_evidence` | Evidence that argues against the hypothesis |
| `non_discriminating_evidence` | Evidence present but not diagnostic |
| `environmental_context` | EPHEMERIS and orbital context records |

`environmental_context` is kept strictly separate from `supporting_evidence`. EPHEMERIS records (orbital radius, position) document environmental conditions; they never appear in hypothesis-evidence relationship lists.

The graph also carries `causal_attribution_established` — a boolean determined by the forensic configuration, not by the AI layer. For Galaxy 15 this is `false`, reflecting that no mechanism was definitively identified.

---

## Deterministic forensic analysis

**File**: [`backend/services/forensicAnalysis.js`](../backend/services/forensicAnalysis.js)

`buildForensicAnalysis(caseId, graph)` evaluates each hypothesis and returns a `ForensicAnalysis` object. The analysis is:

- **Deterministic** — same inputs always produce the same output
- **Categorical** — assessments use a fixed vocabulary (`strongly_supported`, `supported`, `mixed`, `weakly_supported`, `insufficient_evidence`); no numerical probabilities
- **Self-validating** — the function validates its own output before returning; a `ForensicAnalysisValidationError` is thrown if invariants are violated
- **Limitation-aware** — each hypothesis assessment includes explicit limitations on what the evidence can and cannot establish

`causal_attribution_established` is passed through verbatim from the graph; the forensic analysis does not set or override it.

---

## AI analyst

**Files**: [`backend/services/aiEngine.js`](../backend/services/aiEngine.js), [`backend/services/aiAnalyst.js`](../backend/services/aiAnalyst.js)

### What the AI receives

The AI analyst receives the `ForensicAnalysis` object — the output of the deterministic pipeline — plus the set of valid evidence IDs. It does not receive raw CSV rows, graph internals, or source files.

### LLM configuration

| Parameter | Value |
|---|---|
| Model | `ibm/granite-3-3-8b-instruct` |
| Platform | IBM Watsonx.ai |
| Client | LangChain `ChatWatsonx` (`@langchain/ibm`) |
| Endpoint | `https://us-south.ml.cloud.ibm.com` (default) |
| Max tokens | 3072 |

If `WATSONX_AI_APIKEY` is absent, the LLM client is not constructed. All AI calls return `null`; the heuristic fallback is used instead.

### Validation rules (A1–A10)

Before any AI output is accepted, it is validated against the forensic analysis:

| Rule | Check |
|---|---|
| A1–A3 | Output is parseable JSON with required top-level fields |
| A4 | All hypothesis assessments in AI output match the deterministic values exactly |
| A5 | `causal_attribution_established` in AI output matches the forensic result |
| A6 | No numerical probability values (e.g. `75%`, `probability of 0.8`) |
| A7 | No causal-certainty phrases (`proves`, `confirms causation`, `definitively caused`, etc.) |
| A8 | All evidence IDs cited in the narrative exist in the case's parsed evidence set |
| A9 | Hypothesis IDs cited are valid for the case |
| A10 | AI output does not contain phrases that contradict `causal_attribution_established: false` |

Additional rules (AR-9, AR-11, AR-12) apply specific format and content constraints to the structured narrative sections.

### Fallback

If validation fails, `generateAnalystNarrative` returns a deterministic heuristic narrative constructed from the forensic analysis object. The AI failure is logged at the `ai_validation` pipeline stage. The consumer always receives a valid response.

---

## Evidence exploration service

**File**: [`backend/services/evidenceExplorationService.js`](../backend/services/evidenceExplorationService.js)

A read-only service that composes the lower-level exploration primitives (`evidenceExploration.js`) into the API surface exposed by the 11 exploration endpoints. It accepts pre-loaded `rows` and `graph` from the cache and performs no I/O of its own.

Service invariants (SI-1 through SI-14) guarantee that:

- No evidence row is created, modified, or removed
- `evidence_id` values are passed through verbatim
- `environmental_context` is never merged with `supporting_evidence`
- Hypothesis assessments are passed through without re-derivation
- `causal_attribution_established` is never set or modified
- Evidence belonging to one case is never mixed with another case's records
- No numerical probabilities are produced

---

## Investigation workflow

**Files**: [`backend/services/investigationStore.js`](../backend/services/investigationStore.js), [`backend/services/InvestigationRepository.js`](../backend/services/InvestigationRepository.js), [`backend/services/PostgresInvestigationRepository.js`](../backend/services/PostgresInvestigationRepository.js)

The investigation workflow is **completely separate from the forensic pipeline**. It provides a place for analysts to record observations and file scientific challenges against hypotheses. Nothing stored in the investigation workflow feeds back into `parseEvidenceCSV`, `buildEvidenceGraph`, or `buildForensicAnalysis`.

Store invariants:

| Invariant | Statement |
|---|---|
| STORE-1 | Every investigation is scoped to one `case_id` |
| STORE-2 | `investigation_id` is server-generated (UUID); never client-supplied |
| STORE-3 | The store receives zero input from the forensic pipeline |
| STORE-4 | Observations and challenges never become evidence |
| STORE-7 | `causal_attribution_established` is never stored or mutated here |

### Persistence backend selection

| Condition | Backend |
|---|---|
| `PG_DATABASE` env var set | `PostgresInvestigationRepository` |
| Otherwise | `InMemoryInvestigationRepository` |

Migrations run automatically on server startup when PostgreSQL is active. Two migration files exist: `001_create_investigations.sql` and `002_add_missing_fk_constraints.sql`.

---

## Pipeline logger

**File**: [`backend/services/pipelineLogger.js`](../backend/services/pipelineLogger.js)

Structured JSON diagnostics written to stdout. Every entry is a single-line JSON object. Pipeline stages:

| Stage constant | Value |
|---|---|
| `EVIDENCE_INGESTION` | `evidence_ingestion` |
| `EVIDENCE_GRAPH` | `evidence_graph` |
| `FORENSIC_ANALYSIS` | `forensic_analysis` |
| `AI_NARRATIVE` | `ai_narrative` |
| `AI_VALIDATION` | `ai_validation` |
| `REPORT_ASSEMBLY` | `report_assembly` |
| `PIPELINE_COMPLETE` | `pipeline_complete` |
| `PIPELINE_ERROR` | `pipeline_error` |

**Never logged**: raw evidence rows, AI prompts, API keys, full forensic reports, stack traces, or filesystem paths.

---

## Security

Headers applied to every API response:

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Cache-Control` | `no-store` |

CORS allows `http://localhost:5173` and `http://localhost:4173` by default. In production, set `ALLOWED_ORIGINS` (comma-separated) to restrict to the deployed frontend origin.

Request body size is limited to 64 KB to prevent memory exhaustion.

---

## REST API surface

All forensic data endpoints are read-only (`GET`). Write operations are limited to investigation workflow management and the `POST /api/cases/:id/investigate` pipeline trigger.

### Evidence and forensic routes

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/cases` | List all available cases |
| `GET` | `/api/cases/:id` | Case metadata |
| `GET` | `/api/cases/:id/timeline` | All evidence rows, time-sorted |
| `GET` | `/api/cases/:id/evidence-graph` | Hypothesis/evidence graph |
| `GET` | `/api/cases/:id/evidence` | All evidence records |
| `GET` | `/api/cases/:id/evidence/:evidenceId` | Single record with hypothesis relationships |
| `GET` | `/api/cases/:id/evidence/:evidenceId/provenance` | Dataset, provider, variable |
| `GET` | `/api/cases/:id/evidence/source/:source` | Filter by source |
| `GET` | `/api/cases/:id/evidence/measurement` | Filter by measurement or evidence type |
| `GET` | `/api/cases/:id/evidence/time-window` | `from`/`to` ISO 8601 window |
| `GET` | `/api/cases/:id/evidence/anomaly-centered` | `timestamp` + `window_minutes` |
| `GET` | `/api/cases/:id/evidence-index` | Evidence counts by source and type |
| `GET` | `/api/cases/:id/environmental-context` | Environmental context records |
| `GET` | `/api/cases/:id/hypotheses/compare` | Evidence comparison across hypotheses |
| `GET` | `/api/cases/:id/hypotheses/:hid/evidence` | Evidence list for one hypothesis |
| `GET` | `/api/cases/:id/forensic-analysis` | Full deterministic assessment |
| `GET` | `/api/cases/:id/forensic-analysis/narrative` | AI or heuristic narrative |
| `POST` | `/api/cases/:id/investigate` | Run full pipeline |
| `POST` | `/api/cases/:id/challenge` | Submit a scientific challenge |
| `GET` | `/api/cases/:id/challenges` | List challenges for a case |

### Investigation workflow routes

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/cases/:id/investigations` | Create investigation |
| `GET` | `/api/cases/:id/investigations` | List investigations |
| `GET` | `/api/cases/:id/investigations/:iid` | Get investigation |
| `PATCH` | `/api/cases/:id/investigations/:iid` | Update status |
| `POST` | `/api/cases/:id/investigations/:iid/observations` | Add observation |
| `GET` | `/api/cases/:id/investigations/:iid/observations/:oid` | Get observation |
| `POST` | `/api/cases/:id/investigations/:iid/challenges` | Add challenge |
| `GET` | `/api/cases/:id/investigations/:iid/challenges` | List challenges |
| `PATCH` | `/api/cases/:id/investigations/:iid/challenges/:cid` | Update challenge status |
| `GET` | `/api/cases/:id/investigations/:iid/forensic-analysis` | Investigation-scoped analysis |
| `GET` | `/api/cases/:id/investigations/:iid/state` | Investigation state |
| `GET` | `/api/cases/:id/investigations/:iid/summary` | Summary report |
| `GET` | `/api/cases/:id/investigations/:iid/artifact` | Report artifact |
| `GET` | `/api/cases/:id/investigations/:iid/assistance` | AI assistance |
| `GET` | `/api/cases/:id/investigations/:iid/history` | Investigation history |

### Cache management routes

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/cache/evidence/stats` | Cache statistics |
| `POST` | `/api/cache/evidence/invalidate/:caseId` | Invalidate one case |
| `POST` | `/api/cache/evidence/invalidate-all` | Clear all entries |

---

## Test coverage

| Suite | Files | Tests | Skipped | Failures |
|---|---|---|---|---|
| Backend (Jest) | 58 | 2,527 | 118 | 0 |
| Frontend (Vitest) | 18 | 394 | 0 | 0 |
| Golden release gate | — | 124 | 0 | 0 |

Skipped backend tests require a live PostgreSQL connection (`PG_DATABASE` unset).

The golden release gate ([`backend/tests/phase910ReleaseGate.test.js`](../backend/tests/phase910ReleaseGate.test.js)) locks the Galaxy 15 forensic baseline with 124 assertions covering evidence counts, ID sequences, hypothesis assessments, `causal_attribution_established`, and byte-identical deterministic fingerprints across independent pipeline runs.

Evidence cache tests are split across dedicated suites:

| File | Phase | Coverage |
|---|---|---|
| `phase10333Conc.test.js` | 10.3.3-A | CONC-1 – CONC-10: concurrent deduplication |
| `phase10333B.test.js` | 10.3.3-B | CS-1 – CS-20: mutation safety, frozen rows |
| `phase1034CacheOps.test.js` | 10.3.4 | CO-1 – CO-29: HTTP cache-management endpoints |
| `phase1035CacheLifecycle.test.js` | 10.3.5 | CL-1 – CL-35: full lifecycle, signature, retry |

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No (default 5000) | Port the Express server listens on |
| `WATSONX_AI_APIKEY` | No | IBM Watsonx.ai API key — enables LLM features |
| `WATSONX_AI_PROJECT_ID` | No | Watsonx project ID |
| `WATSONX_AI_URL` | No | Watsonx endpoint URL |
| `PG_DATABASE` | No | PostgreSQL database name — enables persistent investigation store |
| `PG_HOST` | No | PostgreSQL host (default `localhost`) |
| `PG_PORT` | No | PostgreSQL port (default `5432`) |
| `PG_USER` | No | PostgreSQL user |
| `PG_PASSWORD` | No | PostgreSQL password |
| `ALLOWED_ORIGINS` | No | Comma-separated CORS origins (default: localhost dev origins) |

With no environment variables set, the server starts, all forensic and exploration routes work, and investigations are stored in memory. AI narrative features are unavailable (heuristic fallback is used automatically).

---

## Key invariants summary

| Invariant | Enforced where |
|---|---|
| `causal_attribution_established` is never set by AI | aiAnalyst.js validation rule A5 |
| Numerical probabilities are never exposed | aiAnalyst.js rule A6 |
| AI cannot cite non-existent evidence IDs | aiAnalyst.js rule A8 |
| Hypothesis assessments cannot be altered by AI | aiAnalyst.js rule A4 |
| Environmental context never merged with supporting evidence | evidenceExploration.js, evidenceExplorationService.js SI-3/SI-12 |
| EPHEMERIS records excluded from hypothesis evidence lists | buildEvidenceGraph (server.js) |
| Forensic pipeline receives zero input from investigation store | investigationStore.js STORE-3 |
| Cache never modifies forensic results | evidenceCaseCache.js CC-6 |
| Failed loads are never cached | evidenceCaseCache.js CC-2, _doLoad finally block |
| Cross-case evidence isolation | evidenceExplorationService.js SI-10, evidenceCaseCache.js CC-1 |
