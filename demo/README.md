# Demo

This directory contains supporting materials for demonstrating SpaceForensics in a portfolio or interview setting.

---

## Contents

| File | Purpose |
|---|---|
| `demo-script.md` | Annotated walkthrough script for a 60–90 second live demo |

---

## Prerequisites

- Backend running on `http://localhost:5001`
- Frontend running on `http://localhost:5173`

See [`docs/DEMO.md`](../docs/DEMO.md) for full setup instructions.

---

## What the demo covers

1. The engineering problem — why deterministic analysis before AI matters
2. Galaxy 15 evidence dataset — 278 records, deterministic IDs, provenance
3. Evidence graph — typed hypothesis/evidence relationships
4. Deterministic forensic assessments — five hypotheses, no numerical probabilities
5. AI narrative — IBM Granite explaining the validated analysis
6. Validation safety — what the system rejects if the AI oversteps

---

## Running the demo without a Watsonx API key

The system works fully without a Watsonx.ai API key. All forensic analysis, evidence exploration, and the evidence graph are available. The AI narrative falls back to a rule-based heuristic that is still evidence-grounded. The demo is equally effective in heuristic mode.

---

## Quick API check

Before a demo, verify the backend is healthy:

```bash
curl http://localhost:5001/api/cases | jq .
curl http://localhost:5001/api/cases/galaxy-15 | jq .
curl http://localhost:5001/api/cases/galaxy-15/forensic-analysis | jq '.hypotheses[].assessment'
```

Expected output for the last command:

```
"mixed"
"mixed"
"supported"
"insufficient_evidence"
"strongly_supported"
```

If these match, the forensic pipeline is working correctly.
