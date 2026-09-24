# SpaceForensics Demo

A step-by-step walkthrough of the Galaxy 15 investigation, from evidence ingestion through AI-generated narrative.

---

## 1. What the demo shows

The demo walks through a complete spacecraft anomaly investigation:

1. **Evidence dataset** — 278 structured records from real GOES-11 instrument data, each with a deterministic ID, timestamp, provenance, and evidence type.
2. **Evidence graph** — typed relationships linking each evidence record to the five hypotheses.
3. **Deterministic forensic analysis** — categorical hypothesis assessments produced without AI involvement.
4. **AI narrative** — IBM Granite explaining the validated analysis; AI output is validated before reaching the consumer.
5. **Safety constraints** — demonstrated via the test suite: what the system rejects even if the AI tries to assert it.

The demo does not prove a causal mechanism for the Galaxy 15 anomaly. `causal_attribution_established: false` is a primary result, not a limitation of the system.

---

## 2. Prerequisites

| Requirement | Notes |
|---|---|
| Node.js 18+ | Both backend and frontend |
| npm | Included with Node.js |
| Git | To clone the repository |
| PostgreSQL | **Optional** — in-memory store used by default |
| IBM Watsonx.ai API key | **Optional** — heuristic fallback used without one |

No Docker setup is required. No database is required for the forensic pipeline or the demo.

---

## 3. Start the system

```bash
# Clone
git clone https://github.com/Ibraderoro/spaceforensics.git
cd spaceforensics

# Backend
cd backend
npm install
cp .env.example .env
# Edit .env — set PORT=5001
# Optionally add WATSONX_AI_APIKEY and WATSONX_AI_PROJECT_ID for live LLM output
npm start

# Frontend (new terminal)
cd ../frontend
npm install
npm run dev
```

The backend starts on `http://localhost:5001`.  
The frontend starts on `http://localhost:5173`.

**Without a Watsonx key:** the system runs fully. All forensic analysis, evidence exploration, and graph routes work. The AI narrative falls back to a deterministic heuristic that is still evidence-grounded.

**Without PostgreSQL:** investigation workflow features (create investigation, add observations, challenges) use an in-memory store. All forensic routes are unaffected.

---

## 4. Open the application

Open `http://localhost:5173` in a browser.

The UI loads Galaxy 15 by default. You should see:

- A header with the case title
- An event timeline chart showing GOES-11 measurements and the anchor event marker
- The investigation timeline — the full 278-record evidence list with provenance columns
- The Investigate button
- Case metadata (NORAD ID, spacecraft bus, anchor timestamp)

If the frontend shows "Connection error", confirm the backend is running on port 5001.

---

## 5. Select Galaxy-15

Galaxy 15 is selected automatically on load. If a second case (`goes16-sep2017`) is present, a case selector dropdown appears at the top. Select **Galaxy 15 Satellite Anomaly — April 2010**.

The case metadata card shows:

```
Case ID:       galaxy-15
Anchor Event:  2010-04-05T09:48:00Z
Records:       278
NORAD ID:      28884
Bus:           Star-2 (Orbital Sciences)
```

---

## 6. Inspect evidence

The **Investigation Timeline** panel lists all 278 evidence records. Key columns:

| Column | What it shows |
|---|---|
| `evidence_id` | Deterministic ID (`E-G15-0001` → `E-G15-0278`) |
| `timestamp` | ISO 8601 measurement time |
| `source` | Instrument/dataset (`GOES11_MAG`, `GOES11_EP8`, `GOES11_EPHEMERIS`, `CASE`) |
| `measurement` | Physical variable (`b_gsm`, `e_flux`, `position`) |
| `value` | Observed value |
| `evidence_type` | `observational` or `environmental_context` |
| Provenance | Dataset, provider, variable |

**Important observations:**

- The `CASE` record (E-G15-0001 or similar) is the anchor event — loss of command contact at `2010-04-05T09:48:00Z`.
- 61 `GOES11_EPHEMERIS` records have `evidence_type: environmental_context`. These document orbital position; they are never included in hypothesis supporting/contradicting evidence lists.
- No records are interpolated or gap-filled. Data gaps in the source archive are gaps in the evidence set.

To inspect a single record's provenance via API:

```bash
curl http://localhost:5001/api/cases/galaxy-15/evidence/E-G15-0001/provenance
```

---

## 7. Inspect hypotheses

Click **Run Pass 1 — Investigate** or inspect the forensic analysis directly:

```bash
curl http://localhost:5001/api/cases/galaxy-15/forensic-analysis | jq .
```

The five hypotheses and their deterministic assessments:

| ID | Label | Assessment |
|---|---|---|
| H1 | Spacecraft charging / electrostatic discharge | `mixed` |
| H2 | Single-event electronic upset / latchup | `mixed` |
| H3 | Command receiver / command-processing fault | `supported` |
| H4 | Ground segment / RF link anomaly | `insufficient_evidence` |
| H5 | Insufficient evidence for causal attribution | `strongly_supported` |

`causal_attribution_established: false`

These are **categorical assessments** produced deterministically from the evidence graph. No numerical probabilities are assigned. H5 being `strongly_supported` is a forensically accurate result: the available evidence does not establish a mechanism.

Each hypothesis also has explicit **limitations** — gaps in the evidence that prevent a more definitive conclusion.

---

## 8. Inspect the evidence graph

The **Evidence Graph Explorer** panel (below the hypothesis matrix) and the graph API show typed relationships between hypotheses and evidence:

```bash
curl http://localhost:5001/api/cases/galaxy-15/evidence-graph | jq .
```

Four relationship categories are used:

| Relationship | Meaning |
|---|---|
| `supporting_evidence` | Evidence consistent with the hypothesis |
| `contradicting_evidence` | Evidence arguing against it |
| `non_discriminating_evidence` | Present but not diagnostic |
| `environmental_context` | EPHEMERIS and orbital context — separated |

To inspect evidence for a specific hypothesis:

```bash
curl http://localhost:5001/api/cases/galaxy-15/hypotheses/H3/evidence | jq .
curl http://localhost:5001/api/cases/galaxy-15/hypotheses/compare | jq .
```

---

## 9. Inspect environmental context

Environmental context is deliberately kept separate from supporting evidence. This matters:

```bash
curl http://localhost:5001/api/cases/galaxy-15/environmental-context | jq .
```

The GOES-11 EPHEMERIS records (orbital radius and position) document that GOES-11 was at the relevant orbital location during the anomaly window. This is a precondition observation — it establishes what the environment looked like, not that a specific mechanism occurred.

**Why this separation exists:**

An LLM handed raw space weather data will often treat co-occurring measurements as causal evidence. The architecture prevents this at the data model level. `environmental_context` records never appear in `supporting_evidence` lists, regardless of what the AI is asked.

---

## 10. Run or inspect AI analysis

```bash
curl http://localhost:5001/api/cases/galaxy-15/forensic-analysis/narrative | jq .
```

The pipeline that produces this response:

```
Evidence files (read-only)
        ↓
parseEvidenceCSV → 278 rows with deterministic IDs
        ↓
buildEvidenceGraph → hypothesis/evidence relationships
        ↓
buildForensicAnalysis → categorical assessments (no AI)
        ↓
generateAnalystNarrative → IBM Granite receives ForensicAnalysis only
        ↓
Validation (A1–A10): IDs, assessments, causal flag, probabilities, language
        ↓
Accepted or heuristic fallback
        ↓
API response
```

The AI receives the `ForensicAnalysis` object — the output of the deterministic pipeline — and the set of valid evidence IDs. **It does not receive raw CSV rows, graph internals, or source files.** Its role is to produce a human-readable explanation of findings that have already been determined.

If validation fails, the system logs the failure at the `ai_validation` pipeline stage and returns a heuristic narrative instead. The API consumer always receives a valid, evidence-grounded response.

---

## 11. Demonstrate safety behavior

The following invariants are enforced in code. Rather than fabricating a live UI demonstration, the corresponding test file is referenced for each.

### A. Invalid evidence IDs

**Rule A8**: The AI validator checks that every evidence ID cited in AI output actually exists in the case's parsed evidence set. A fabricated ID triggers fallback.

**Test**: `backend/tests/aiForensicOutputValidation.test.js`, `backend/tests/aiAnalyst.test.js`

### B. Changed hypothesis assessment

**Rule A4**: If AI output contains a hypothesis assessment that differs from the deterministic value (e.g., changes H4 from `insufficient_evidence` to `supported`), the output is rejected.

**Test**: `backend/tests/aiForensicOutputValidation.test.js`

### C. Changed causal attribution flag

**Rule A5**: If AI output sets `causal_attribution_established: true` when the forensic analysis produced `false`, the output is rejected.

**Test**: `backend/tests/aiForensicOutputValidation.test.js`, `backend/tests/causalCertaintyValidation.test.js`

### D. Causal-certainty language

**Rule A7**: Phrases such as `proves`, `confirms causation`, `definitively caused`, `was the cause of`, `was responsible for causing` trigger rejection.

**Test**: `backend/tests/causalCertaintyValidation.test.js`

### E. Numerical probability claims

**Rule A6**: Any output containing percentage figures or explicit probability language (e.g., `75%`, `probability of 0.8`) is rejected.

**Test**: `backend/tests/aiForensicOutputValidation.test.js`

### F. Environmental context treated as mechanism confirmation

Environmental context records (`evidence_type: environmental_context`) are structurally excluded from `supporting_evidence` in the evidence graph. The data model prevents this misuse, not just the AI validator.

**Test**: `backend/tests/evidenceGraph.test.js`, `backend/tests/phase910ReleaseGate.test.js` (RG-6, RG-7)

### G. Cross-case evidence leakage

Evidence IDs and cache entries are keyed by `caseId`. Records from `galaxy-15` cannot appear in a query for another case.

**Test**: `backend/tests/multiCaseIsolation.test.js`, `backend/tests/phase910ReleaseGate.test.js` (RG-14)

### H. Golden release gate

The full baseline is locked by the release gate:

```bash
cd backend && npx jest --runInBand tests/phase910ReleaseGate.test.js
```

124 checks verify: evidence counts, ID sequences, hypothesis assessments, `causal_attribution_established`, byte-identical deterministic fingerprints across independent pipeline runs.

---

## 12. What the demo proves

| Property | Demonstrated by |
|---|---|
| Deterministic evidence ingestion | 278 records, stable IDs across independent runs |
| Provenance tracking | Dataset, provider, variable on every record |
| Graph-based evidence relationships | Four typed relationship categories per hypothesis |
| Environmental context separation | EPHEMERIS excluded from hypothesis evidence lists |
| Categorical forensic assessment | Five hypotheses, no numerical probabilities |
| `causal_attribution_established` as a primary result | `false` for Galaxy 15, enforced end-to-end |
| AI constrained by validated analysis | AI receives `ForensicAnalysis` object only |
| AI output validation | Rules A1–A10, fallback on any violation |
| Concurrent-load safety | `_inFlight` deduplication tested (CONC-1–CONC-10) |
| Mutation safety | Frozen cached rows tested (CS-1–CS-20) |
| Cross-case isolation | Tested in `multiCaseIsolation.test.js` and RG-14 |
| Scientific uncertainty preserved | H5 `strongly_supported`, explicit limitations per hypothesis |

---

## 13. Recruiter demo script (60–90 seconds)

The following script is written for a live walkthrough with the application running.

---

### 0–10 seconds — The problem

> "Spacecraft anomaly investigations combine evidence from multiple instruments, competing hypotheses, and genuinely incomplete data. If you hand that raw data to an LLM, you get a confident-sounding causal explanation that may have no reliable relationship to the evidence. SpaceForensics is designed around that specific problem."

---

### 10–25 seconds — Show Galaxy 15 and the evidence dataset

*Point to the Investigation Timeline.*

> "This is a real event — Galaxy 15, April 2010. It became unresponsive to all ground commands during a period of elevated energetic-particle flux. There are 278 structured evidence records, each with a deterministic ID — E-G15-0001 through E-G15-0278 — a timestamp, a measurement value, and provenance: which dataset, which instrument, which variable. Nothing is interpolated."

---

### 25–40 seconds — Show hypotheses and evidence relationships

*Point to the Evidence Graph Explorer.*

> "The system builds a graph linking hypotheses to evidence with typed relationships: supporting, contradicting, non-discriminating, and environmental context. The 61 ephemeris records are classified as environmental context — they document orbital conditions, but they're kept structurally separate from evidence that supports or contradicts a hypothesis. Co-occurrence is not causation, and the architecture enforces that."

---

### 40–55 seconds — Show the deterministic forensic result

*Point to the Forensic Investigation View.*

> "The forensic engine evaluates five hypotheses deterministically — same inputs, same output, every time. H3, command-receiver fault, is `supported`. H4, ground-segment anomaly, is `insufficient_evidence`. H5 — insufficient evidence for causal attribution — is `strongly_supported`. `causal_attribution_established` is false. That's an honest scientific result, not a failure of the system."

---

### 55–70 seconds — Show the AI-generated narrative

*Point to the AI narrative section or run the API call.*

> "After the deterministic analysis is done, IBM Granite receives the validated ForensicAnalysis object — not the raw data — and produces a human-readable explanation. It explains what the analysis found. It doesn't produce the analysis."

---

### 70–85 seconds — Show how validation prevents unsupported claims

*Point to the release gate test or the validation test files.*

> "Before any AI output reaches a consumer it goes through ten validation rules: evidence IDs checked against the parsed set, assessments verified against the deterministic values, causal-certainty phrases detected, numerical probabilities detected. If anything fails, the system falls back to a deterministic heuristic. The forensic result always gets through."

---

### 85–90 seconds — Engineering takeaway

> "The core engineering decision was putting the deterministic system first and treating the AI as a downstream explanation layer. That boundary is enforced at the data model level — not just as a prompt instruction — and it's tested with 2,527 backend tests and a 124-check golden release gate."
