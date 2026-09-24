# SpaceForensics — Portfolio Case Study

A technical case study written for software-engineering internship candidates and entry-level positions.

---

## Project overview

SpaceForensics is an evidence-grounded forensic analysis system for investigating unexpected spacecraft events. It ingests heterogeneous observational data, constructs a structured evidence graph, runs deterministic hypothesis assessment, and then — and only then — passes the validated forensic analysis to an AI analyst for narrative explanation.

The reference investigation is Galaxy 15: a real geostationary satellite that became unresponsive to all ground commands on 2010-04-05 during disturbed geomagnetic and energetic-particle conditions. The anomaly lasted nine months. The causal mechanism was never definitively established.

**GitHub**: [https://github.com/Ibraderoro/spaceforensics](https://github.com/Ibraderoro/spaceforensics)

---

## The problem

Spacecraft anomaly investigations combine:

- Multiple instrument streams with different time bases and resolutions
- Incomplete and gappy data
- Competing physical hypotheses
- Environmental observations that co-occur with an anomaly but do not establish mechanism
- Genuine scientific uncertainty that must be preserved, not papered over

Handing raw space weather data to an LLM produces fluent, confident-sounding explanations that frequently:

- Cite nonexistent evidence
- Overstate causality from temporal correlation
- Conflate environmental conditions with mechanism confirmation
- Change or soften established assessments

SpaceForensics was built around that specific failure mode. The design question was: how do you use an LLM for its genuine strength — synthesizing and explaining complex findings — while preventing it from doing the parts it does unreliably?

---

## Why this was technically interesting

The interesting engineering was not the LLM call itself. It was everything around it:

1. **Ordering** — deterministic analysis must run before the LLM. The architecture has to enforce that ordering, not rely on prompting.
2. **Data isolation** — the LLM must not access raw evidence rows or graph internals. It receives a structured object representing already-completed analysis.
3. **Output validation** — LLM output must be validated against the deterministic result before it reaches a consumer. The system must reject outputs that violate forensic invariants.
4. **Scientific integrity** — `causal_attribution_established` is a first-class result. The system must not allow that result to be silently overridden.
5. **Caching with correctness** — evidence parsing and graph construction are expensive. The cache must not sacrifice correctness for speed.

These problems compound: the cache, the graph, the validation, and the AI boundary each have their own invariants, and they interact at every API call.

---

## Architecture

The system is structured as a backend Node.js/Express API and a React/Vite frontend.

```
Case Files (read-only CSV + JSON)
        ↓
Evidence Ingestion — deterministic IDs, provenance, no interpolation
        ↓
Evidence Cache — source-signature validation, concurrent deduplication
        ↓                         ↓
Evidence Graph              Evidence Exploration Service
(typed hypothesis/evidence    (filter, window, provenance,
 relationships)                index — read-only)
        ↓                         ↓
Deterministic Forensic Analysis   ↓
(categorical assessments)         ↓
        ↓                         ↓
AI Analyst + Validation     ←─────┘
(IBM Granite, rules A1–A10)
        ↓
REST API (Express, 36 routes)
        ↓                    ↓
React/Vite UI          PostgreSQL (optional)
                     (investigation workflow)
```

### Major components

| Component | File | Responsibility |
|---|---|---|
| Evidence ingestion | `backend/server.js` (`parseEvidenceCSV`) | CSV → structured rows, deterministic IDs, provenance |
| Evidence graph | `backend/server.js` (`buildEvidenceGraph`) | Hypothesis/evidence relationships (4 typed categories) |
| Evidence cache | `backend/services/evidenceCaseCache.js` | Source-signature cache, concurrent deduplication, mutation safety |
| Forensic analysis | `backend/services/forensicAnalysis.js` | Categorical hypothesis assessment |
| AI analyst | `backend/services/aiAnalyst.js` | LLM call, A1–A10 validation, heuristic fallback |
| AI engine | `backend/services/aiEngine.js` | IBM Granite client (IBM Watsonx.ai via LangChain) |
| Evidence exploration | `backend/services/evidenceExplorationService.js` | Read-only query layer |
| Investigation store | `backend/services/investigationStore.js` | Persistence facade (in-memory or PostgreSQL) |
| Pipeline logger | `backend/services/pipelineLogger.js` | Structured JSON diagnostics |

---

## Engineering work represented in this repository

The following areas are represented concretely in the code and tests.

### Evidence ingestion and deterministic IDs

`parseEvidenceCSV` reads normalized CSV files, assigns deterministic IDs (`E-{CASE}-{NNNN}`), and stamps provenance fields (source, measurement, instrument, dataset) on every row. No interpolation or gap-filling is performed. Data gaps in the source archive are gaps in the evidence set.

### Evidence graph construction

`buildEvidenceGraph` maps each hypothesis to its relevant evidence using four typed relationship categories. The distinction between `supporting_evidence` and `environmental_context` is structural — not a convention — so the AI cannot conflate them regardless of what it is asked.

### Service-layer design

Each major capability (evidence exploration, forensic analysis, AI analysis, investigation storage) is a separate service module. The forensic pipeline has no dependency on the investigation store; the AI analyst has no access to raw CSV rows.

### Evidence cache

`evidenceCaseCache.js` provides:

- **Source-signature invalidation**: recomputes a signature over CSV mtimes/sizes and `case.json`/`hypotheses.json` on every request; stale entries are discarded automatically.
- **Concurrent cold-load deduplication**: the first concurrent request starts a load and stores the Promise in `_inFlight`; subsequent concurrent requests join the same Promise.
- **Failure safety**: `_inFlight` is cleared in a `finally` block; failed loads are never cached.
- **Mutation safety**: cached row objects are individually frozen (`Object.freeze`); callers receive a new (unfrozen) array of frozen row references. The graph is a shallow-frozen copy.
- **Explicit invalidation**: `POST /api/cache/evidence/invalidate/:caseId` and `POST /api/cache/evidence/invalidate-all`.

### AI integration

The system uses IBM Granite 3.3 8B Instruct via IBM Watsonx.ai, accessed through LangChain `ChatWatsonx`. The LLM is optional: if `WATSONX_AI_APIKEY` is absent, the client is not constructed and all AI calls return `null` immediately; the heuristic fallback is used automatically.

### AI output validation (rules A1–A10)

Before any AI output reaches a consumer, it is validated against the deterministic forensic analysis:

| Rule | Check |
|---|---|
| A1–A3 | Parseable JSON with required top-level fields |
| A4 | All hypothesis assessments match deterministic values exactly |
| A5 | `causal_attribution_established` matches forensic result |
| A6 | No numerical probability values |
| A7 | No causal-certainty phrases |
| A8 | All cited evidence IDs exist in the case's parsed evidence set |
| A9 | Hypothesis IDs are valid for the case |
| A10 | No phrases that contradict `causal_attribution_established: false` |

Any failed rule triggers heuristic fallback. The consumer always receives a valid response.

### PostgreSQL persistence

Investigation workflow state (investigations, observations, challenges) is stored in PostgreSQL when `PG_DATABASE` is set, or in an in-memory store otherwise. The persistence backend is selected at startup. Migrations run automatically. The forensic pipeline has zero dependency on the store.

### Automated testing

2,921 tests across backend and frontend — see [Testing strategy](#testing-strategy) below.

### Multi-case isolation

`caseId` is the namespace boundary throughout the system. Evidence IDs, cache entries, graph nodes, and exploration results are all scoped per case. Cross-case leakage is explicitly tested.

### Frontend

A React/Vite UI with Tailwind and Recharts. Components include: event timeline chart, investigation timeline (full record list), hypothesis matrix, forensic investigation view, evidence graph explorer, investigation workspace, AI assistance panel, red team panel, and report export.

---

## Hardest engineering problems

### 1. Keeping AI downstream of deterministic analysis

The core constraint is that the LLM must explain findings that have already been determined — not determine findings itself. This means:

- The forensic analysis pipeline must complete before any AI call.
- The LLM must receive only the structured analysis object, not raw rows.
- The LLM's output must be validated against the forensic result before being used.

The common failure mode in AI-integrated systems is prompt-level instruction: "don't change the assessments." That is not reliable. SpaceForensics enforces the boundary architecturally: the LLM literally cannot see the raw data, and its output is validated field-by-field against the deterministic result.

### 2. Concurrent cache loading

When the server receives multiple simultaneous requests for the same uncached case, running `parseEvidenceCSV + buildEvidenceGraph` once per request wastes resources and creates a race condition where multiple loads could complete and overwrite each other.

The solution: the first caller stores a load Promise in `_inFlight`. Subsequent concurrent callers join that same Promise via `.then()`. Only one load executes.

```
Request A → _inFlight.has('galaxy-15')? No  → start load → store Promise
Request B → _inFlight.has('galaxy-15')? Yes → join Promise
Request C → _inFlight.has('galaxy-15')? Yes → join Promise

Load completes → cache set → _inFlight.delete (finally block)
A, B, C all receive { rows: rows.slice(), graph }
```

The `finally` block is important: a failed load clears `_inFlight` so subsequent requests can retry from scratch rather than joining a rejected Promise.

### 3. Cache mutation safety

The cache serves many concurrent requests. If callers can mutate cached row objects, one request could corrupt data seen by another. The fix: rows are frozen (`Object.freeze`) at load time. Each caller receives a new array (which they can sort or filter) of frozen row references. Mutation attempts in strict mode throw `TypeError`; in sloppy mode they silently no-op.

The evidence graph gets the same treatment: `causal_attribution_established` and `case_id` are non-writable at the top level; hypothesis arrays and each hypothesis object are frozen. This prevents a caller from, for example, setting `graph.causal_attribution_established = true`.

### 4. Scientific integrity

The system tracks four distinct categories that are easy to conflate:

| Category | Example | Rule |
|---|---|---|
| Observational evidence | EP8 electron flux measurement | Can support/contradict a hypothesis |
| Environmental context | EPHEMERIS orbital position | Documents conditions; never supports/contradicts |
| Hypothesis assessment | `mixed`, `supported`, `insufficient_evidence` | Deterministic; cannot be set by AI |
| AI narrative | Explanation of assessment | Explains only what forensics found |

Maintaining these boundaries required explicit enforcement at the data model (graph construction), the service layer (exploration service invariants SI-1–SI-14), and the AI validation layer (rules A4–A10).

### 5. Cross-case isolation

With multiple cases in the same server process, there are several places where case boundaries could be violated: cache entries, evidence IDs, graph nodes, and exploration query results. Each layer uses `caseId` as its primary namespace key. The `multiCaseIsolation.test.js` suite and the release gate (RG-14) test that Galaxy 15 evidence never appears in queries for other cases and vice versa.

---

## Testing strategy

Testing is layered across four levels:

### Unit tests
Service-level tests that exercise individual functions in isolation: evidence ingestion, graph construction, forensic analysis, AI validator, exploration service, investigation repository.

### HTTP integration tests
Supertest-based tests that start the Express server and verify API responses end-to-end: evidence routes, forensic routes, investigation workflow routes, cache management routes, error contracts.

### Specialised tests
Dedicated suites for specific engineering concerns:

| File | What it tests |
|---|---|
| `phase10333Conc.test.js` | CONC-1–CONC-10: concurrent cache deduplication |
| `phase10333B.test.js` | CS-1–CS-20: frozen rows, mutation safety |
| `phase1035CacheLifecycle.test.js` | CL-1–CL-35: full cache lifecycle, signature, retry |
| `causalCertaintyValidation.test.js` | AI causal-certainty phrase detection |
| `multiCaseIsolation.test.js` | Cross-case evidence isolation |
| `phase86ConcurrencyIsolation.test.js` | Concurrent investigation creation isolation |
| `phase99SecurityAudit.test.js` | HTTP security headers, error response shapes |

### Golden release gate

`backend/tests/phase910ReleaseGate.test.js` — 124 checks that lock the Galaxy 15 forensic baseline:

| Category | Check |
|---|---|
| RG-1 | 278 evidence records, IDs `E-G15-0001`–`E-G15-0278` |
| RG-2 | Stable IDs across independent calls |
| RG-3 | Evidence graph integrity |
| RG-4–5 | Hypothesis assessments and `causal_attribution_established` |
| RG-6–7 | Environmental context/EPHEMERIS separation |
| RG-8 | No numerical probabilities in any API output |
| RG-11–13 | AI evidence containment, assessment identity, causal-language prevention |
| RG-14 | Cross-case isolation |
| RG-19 | Byte-identical output across 5 concurrent pipeline runs |

### Frontend tests

18 Vitest test files covering all major React components: evidence displays, hypothesis panels, forensic views, investigation workspace, AI assistance panel.

### Verified baseline (v1.0.0)

| Suite | Files | Tests | Skipped | Failures |
|---|---|---|---|---|
| Backend (Jest) | 58 | 2,527 | 118 | 0 |
| Frontend (Vitest) | 18 | 394 | 0 | 0 |
| Golden release gate | — | 124 | 0 | 0 |

The 118 skipped backend tests require a live PostgreSQL connection and are skipped when `PG_DATABASE` is unset.

---

## Release engineering

- **v1.0.0** — tagged release with complete forensic pipeline, full test baseline, and documentation commit `3079fab` (the docs commit is not the v1.0.0 tag itself).
- The golden release gate (`phase910ReleaseGate.test.js`) must pass at zero failures for any release.
- Release gate checks 20 invariant categories including byte-identical deterministic output across independent pipeline runs.

---

## What I learned

**Separation of concerns is a testing aid, not just a design preference.** When the forensic analysis engine, the cache, the AI layer, and the investigation store each have clear boundaries, writing targeted tests for each becomes straightforward. When I tried to test composite behavior first, I often couldn't isolate the failing part.

**Caching is harder to get right than it looks.** The interaction between concurrent requests, signature validation, and failure recovery each introduced edge cases that only became visible when I wrote dedicated concurrency tests. The `_inFlight` pattern solved the duplicate-load problem cleanly once I understood what I was actually guarding against.

**Asynchronous debugging requires logging.** The pipeline logger provided structured JSON output at each stage. When AI validation failed, the log showed exactly which rule triggered. Without that I would have had no way to see inside the validation path during development.

**Scientific uncertainty needs to be a first-class data value, not a narrative hedge.** Having `causal_attribution_established` as a boolean in the data model, passed through every layer, validated in AI output, and checked in 124 release gate assertions, was more reliable than any amount of prompt engineering.

**LLM integration is most interesting at the boundary, not the call site.** The actual LangChain call is a few lines. The interesting work is designing what the LLM receives, what it's allowed to return, and what happens when it doesn't comply.

---

## Future work

The following improvements are known and not yet implemented:

- **Authentication and authorization** on cache-management endpoints (`/api/cache/evidence/invalidate*`). These are currently unauthenticated.
- **Rate limiting** on AI narrative endpoints to prevent unbounded Watsonx.ai usage.
- **Deployment hardening** — the repository has no production Docker setup, reverse proxy configuration, or deployment documentation.
- **Observability** — structured logging exists at the pipeline level; distributed tracing and metrics are not implemented.
- **Pagination** — evidence listing endpoints return all records without pagination; this may become a concern for cases with significantly more evidence.
- **Additional case data** — `goes16-sep2017` has a case directory but is not as thoroughly documented as Galaxy 15.

These are genuine open items. They are not described as implemented.

---

## Resume-ready summary

### One-line version

> Full-stack spacecraft anomaly investigation system: deterministic forensic analysis pipeline with evidence graph, AI-generated narrative constrained by ten validation rules, and 2,921 automated tests.

---

### Two-bullet version

- Built a Node.js/Express forensic analysis backend that ingests heterogeneous observational data into a typed evidence graph, runs deterministic hypothesis assessment, and validates AI-generated narrative against the forensic results before returning it to the client.
- Designed and tested an evidence cache with source-signature invalidation, concurrent-load deduplication (`_inFlight`), and `Object.freeze`-based mutation safety, backed by 94 dedicated cache tests.

---

### Three-bullet version

- **Backend/API:** Node.js/Express REST API (36 routes) for evidence ingestion, graph-based exploration, deterministic forensic analysis, and investigation workflow; PostgreSQL persistence with in-memory fallback.
- **Caching/concurrency/testing:** Source-signature evidence cache with `_inFlight` concurrent deduplication and frozen-object mutation safety; 58 backend test suites including concurrency, lifecycle, and a 124-check golden release gate.
- **Evidence-grounded AI:** IBM Granite (Watsonx.ai via LangChain) constrained by ten validation rules that verify evidence IDs, hypothesis assessments, causal attribution, probability language, and causal-certainty phrases before any AI output reaches an API consumer.
