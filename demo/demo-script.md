# SpaceForensics Demo Script

**Target duration:** 60–90 seconds  
**Format:** Live walkthrough with running application + terminal, or screen recording  
**Prerequisites:** Backend on `http://localhost:5001`, frontend on `http://localhost:5173`

---

## Before you start

Have these tabs/windows ready:

1. Browser: `http://localhost:5173` — loaded on Galaxy 15 (default)
2. Terminal: ready to run `curl` commands (optional — useful for showing API responses)

The application loads Galaxy 15 by default. No interaction is needed before starting.

---

## Script

---

### [0–10 seconds] — The problem

*No interaction. Speak to camera or interviewer.*

> "This project is called SpaceForensics. The problem it's solving: spacecraft anomaly investigations combine data from multiple instruments, competing physical hypotheses, and genuinely incomplete information. If you hand that raw data to an LLM, it produces a confident-sounding causal explanation that may have no reliable relationship to the evidence — it correlates co-occurring events and calls it a mechanism.
>
> SpaceForensics is built around that failure mode. It puts deterministic forensic analysis first, and the AI is downstream of that, explaining findings that have already been determined."

*Transition: point to the application.*

---

### [10–25 seconds] — The evidence dataset

*Point to the Investigation Timeline panel.*

> "This is a real event — Galaxy 15, April 2010. It became unresponsive to all ground commands during a period of elevated energetic-particle activity. There are 278 structured evidence records. Each one has a deterministic ID — E-G15-0001 through E-G15-0278 — a timestamp, a measurement value, and provenance: which dataset, which instrument, which variable. Nothing in the dataset is interpolated or filled."

*Optional: scroll the timeline to show ID column and evidence_type column.*

> "Notice the evidence_type column — some records are `observational`, some are `environmental_context`. That distinction is structural, not just a label."

---

### [25–40 seconds] — Hypotheses and evidence relationships

*Point to the Evidence Graph Explorer or the Forensic Investigation View hypotheses.*

> "The system builds a graph linking hypotheses to evidence using four typed relationships: supporting, contradicting, non-discriminating, and environmental context. Those 61 ephemeris records — orbital position data — are classified as environmental context. They document what conditions existed near the anomaly. They're kept structurally separate from the evidence that can support or contradict a hypothesis."

*Optional: click a hypothesis in the Evidence Graph Explorer to show its evidence lists.*

> "So the system can't accidentally treat co-occurrence as causation, even if you asked it to — the data model prevents it."

---

### [40–55 seconds] — Deterministic forensic assessment

*Point to the hypothesis assessments (Forensic Investigation View or pass 1 results).*

> "The forensic engine evaluates five hypotheses deterministically — no AI involved, same inputs give the same output every time. H3, command-receiver fault, is `supported`. H4, ground-segment anomaly, is `insufficient_evidence` — there's simply no ground-segment data in the dataset. H5, insufficient evidence for causal attribution, is `strongly_supported`. And `causal_attribution_established` is false."

> "That's an honest scientific result. The system can't establish a mechanism with the available data, and it says so explicitly."

---

### [55–70 seconds] — AI-generated narrative

*Point to the AI narrative section, or run in terminal:*

```bash
curl http://localhost:5001/api/cases/galaxy-15/forensic-analysis/narrative | jq '.source, .summary'
```

> "After the deterministic analysis is done, IBM Granite — accessed via IBM Watsonx.ai through LangChain — receives the ForensicAnalysis object. Not the raw data. The validated analysis. It produces a human-readable explanation of what the forensic pipeline found. It explains the findings. It doesn't produce them."

> "If the API key isn't set, the system falls back to a rule-based heuristic — you can see the source field says 'heuristic' or 'llm' depending on which path ran."

---

### [70–85 seconds] — Validation safety

*Point to a terminal or reference the test files.*

> "Before any AI output reaches the consumer it goes through ten validation rules. Evidence IDs cited by the AI are checked against the parsed evidence set — a fabricated ID triggers fallback. Hypothesis assessments are compared field-by-field against the deterministic values — any mismatch triggers fallback. Causal-certainty phrases are detected. Numerical probability claims are detected."

*Optional: show test command:*

```bash
cd backend && npx jest --runInBand tests/phase910ReleaseGate.test.js
```

> "The golden release gate runs 124 checks that lock the Galaxy 15 baseline — evidence counts, ID sequences, hypothesis assessments, causal attribution, byte-identical output across five independent concurrent runs."

---

### [85–90 seconds] — Engineering takeaway

> "The core decision was treating deterministic analysis as the source of truth and the AI as a constrained explanation layer. That boundary is enforced at the data model, the service layer, and the validation layer — not just in the prompt. And it's tested with 2,527 backend tests and a release gate."

---

## Fallback cues

If any of these come up during a demo:

| Situation | Response |
|---|---|
| Frontend shows "Connection error" | Backend is not running — `cd backend && npm start` |
| AI narrative shows `source: "heuristic"` | Expected without a Watsonx key — the forensic analysis is still complete |
| Hypothesis assessments differ from expected | Run the golden gate: `cd backend && npx jest --runInBand tests/phase910ReleaseGate.test.js` |
| "Why is `causal_attribution_established: false`?" | "That's the forensically correct result. The available data doesn't establish a mechanism. H5 being `strongly_supported` is the system being honest about what the evidence can and cannot show." |

---

## Key numbers to have ready

| Fact | Value |
|---|---|
| Evidence records | 278 |
| Evidence ID range | E-G15-0001 – E-G15-0278 |
| EPHEMERIS records | 61 |
| Hypotheses | 5 |
| `causal_attribution_established` | `false` |
| Backend tests | 2,527 (58 suites) |
| Frontend tests | 394 (18 files) |
| Release gate checks | 124 |
| AI validation rules | A1–A10 |
