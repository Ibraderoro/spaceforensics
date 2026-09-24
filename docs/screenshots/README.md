# Screenshots

This directory contains (or will contain) portfolio screenshots of the SpaceForensics UI.

Screenshots should be captured from a running instance of the application. Instructions for starting the application are in [`docs/DEMO.md`](../DEMO.md).

---

## Recommended screenshot set

The following seven screenshots give a complete visual record of the investigation workflow.

---

### 1. `01-dashboard-overview.png`

**Screen:** Full application on load (Galaxy 15 selected)  
**What it shows:** The complete dashboard layout — header, event timeline chart, investigation timeline record list, and case metadata card.  
**Why it matters to a recruiter:** Establishes the scope of the UI and that the system loads real data from a live backend.  
**Crop:** Full page (1440 × 900 or similar), no crop needed.  
**Source:** Running application — `http://localhost:5173`, default load.

---

### 2. `02-event-timeline-chart.png`

**Screen:** Event timeline chart panel (Recharts)  
**What it shows:** The GOES-11 time-series measurements plotted across the 3-hour investigation window, with the anchor event marker at `2010-04-05T09:48:00Z`.  
**Why it matters to a recruiter:** Shows that the evidence dataset is actual instrument data, not synthetic test data, and that the frontend renders it usefully.  
**Crop:** Timeline chart panel only, showing the anomaly marker.  
**Source:** Running application — scroll up to see the chart.

---

### 3. `03-investigation-timeline-evidence.png`

**Screen:** Investigation timeline record list, expanded  
**What it shows:** Several evidence records with their IDs (`E-G15-NNNN`), timestamps, source instrument, measurement variable, value, and evidence type (`observational` vs `environmental_context`).  
**Why it matters to a recruiter:** Makes the deterministic ID scheme and provenance model visible. Shows that `environmental_context` records are explicitly typed.  
**Crop:** The record list, showing approximately 10–15 rows with all columns visible.  
**Source:** Running application — Investigation Timeline panel.

---

### 4. `04-hypothesis-assessments.png`

**Screen:** Forensic Investigation View — hypothesis list  
**What it shows:** All five hypotheses with their assessment labels (`mixed`, `mixed`, `supported`, `insufficient_evidence`, `strongly_supported`) and the `causal_attribution_established: false` indicator.  
**Why it matters to a recruiter:** Demonstrates that the system produces honest, calibrated assessments — including `insufficient_evidence` and `strongly_supported` for H5 — rather than forcing a conclusion.  
**Crop:** The hypothesis assessment section, showing all five hypotheses and the causal attribution flag.  
**Source:** Running application — Forensic Investigation View panel.

---

### 5. `05-evidence-graph-explorer.png`

**Screen:** Evidence Graph Explorer panel  
**What it shows:** A hypothesis selected in the explorer, showing its typed evidence relationships (`supporting_evidence`, `contradicting_evidence`, `non_discriminating_evidence`, `environmental_context`).  
**Why it matters to a recruiter:** Makes the graph data model visible and shows that environmental context is kept separate from supporting evidence.  
**Crop:** The Evidence Graph Explorer panel with a hypothesis selected (e.g. H3 or H2).  
**Source:** Running application — Evidence Graph Explorer panel, select a hypothesis.

---

### 6. `06-ai-narrative.png`

**Screen:** AI narrative section of the Forensic Investigation View (or a `curl` response if the UI section is not separately visible)  
**What it shows:** The AI-generated narrative explaining the forensic findings, including the `source` field (`"llm"` or `"heuristic"`) that indicates whether the narrative came from the LLM or the fallback.  
**Why it matters to a recruiter:** Shows that the AI output is structured and attributed, and that the system works in both LLM and heuristic modes.  
**Crop:** The narrative section, showing the text and the source attribution.  
**Source:** Running application, or: `curl http://localhost:5001/api/cases/galaxy-15/forensic-analysis/narrative | python3 -m json.tool`

---

### 7. `07-test-run-golden-gate.png`

**Screen:** Terminal output of the golden release gate test  
**What it shows:** `npx jest --runInBand tests/phase910ReleaseGate.test.js` completing with 124 passed, 0 failed.  
**Why it matters to a recruiter:** Provides direct evidence of automated testing discipline. Makes the "124 checks" claim concrete and verifiable.  
**Crop:** Terminal, showing the test summary line and the pass/fail counts.  
**Source:** Terminal — `cd backend && npx jest --runInBand tests/phase910ReleaseGate.test.js`

---

## Capturing screenshots

The application uses a dark UI (slate-950 background). Screenshots look best on a dark-mode OS or browser.

Recommended browser width: 1440px.

For terminal screenshots, a dark terminal theme (e.g. iTerm2 Solarized Dark or similar) is readable and consistent with the UI aesthetic.

Do not fabricate screenshots. Every screenshot in this directory should be captured from a running instance of the actual application.

---

## Adding screenshots

Once captured, place PNG files in this directory (`docs/screenshots/`) and update the main `README.md` if you want to embed them inline. Relative paths work in GitHub Markdown:

```markdown
![Dashboard overview](docs/screenshots/01-dashboard-overview.png)
```
