# 🛰️ SPACEFORENSICS

> **AI-Powered Forensic Investigation Engine for Unexpected Space Events**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Built with IBM Bob](https://img.shields.io/badge/Built%20With-IBM%20Bob-blueviolet.svg)](#-how-ibm-bob-was-used)
[![AI: IBM Granite via LangChain](https://img.shields.io/badge/AI-IBM%20Granite%20%7C%20LangChain-blue.svg)](#-ai-approach--architecture)
[![Challenge: IBM Build with AI](https://img.shields.io/badge/Challenge-IBM%20Build%20with%20AI-orange.svg)](#-selected-challenge-theme)

---

## 🎯 Selected Challenge Theme

**Track:** IBM Build with AI Hackathon Challenge

**Objective:** Transform space anomaly investigation from slow, expert-only forensic workflows into an AI-assisted, evidence-backed, auditable reasoning system — making spacecraft anomaly analysis accessible, transparent, and scientifically defensible.

---

## ❓ Problem Statement

Space operators investigating satellite anomalies face a unique and dangerous failure mode when applying standard AI tooling: **the Black-Box LLM Problem**.

Generic AI wrappers that ingest raw space weather data and produce narrative outputs like *"A solar flare caused the satellite reset"* are **rejected by domain experts** for three well-founded reasons:

| Failure Mode | Impact |
|---|---|
| **Hallucinated causal links** | LLMs correlate co-occurring events (e.g., a geomagnetic storm + a command anomaly) and invent causation, producing claims unsupported by the underlying physics |
| **Lossy temporal flattening** | Multi-rate sensor streams (1-min magnetometer, 5-min particle flux, 3-min orbital ephemeris) are downsampled or averaged, destroying the temporal nuance needed to establish event sequencing |
| **No self-falsification** | Standard LLM outputs offer no mechanism to challenge their own conclusions, identify missing sensors, evaluate observational gaps, or recalibrate confidence when counter-evidence exists |

The result: **AI-generated anomaly reports that cannot be trusted** and are discarded by the satellite engineers and space physicists who need them most.

### Hero Case — Galaxy 15 ("Zombiesat")

On **April 5, 2010 at 09:48 UTC**, the Galaxy 15 (AMC-15) geostationary communications satellite operated by Intelsat failed to respond to all ground commands following an intense geomagnetic storm. The spacecraft entered what became known as the **"Zombiesat" state** — transponders active, attitude control nominal, but the command uplink permanently unresponsive. Galaxy 15 drifted freely through the GEO belt for **nine months** before autonomously rebooting on December 26, 2010.

The cause remains scientifically contested. Three competing hypotheses — surface charging / electrostatic discharge (ESD), a single event upset (SEU) in the command processor, and a spontaneous hardware failure — each have supporting evidence and critical weaknesses. This is the exact class of problem that rewards structured forensic AI reasoning rather than point-estimate prediction.

---

## 💡 Solution Description

**SPACEFORENSICS** is an evidence-backed forensic reasoning engine that investigates satellite anomalies under real-world observational uncertainty.

Instead of outputting unverified predictions, SPACEFORENSICS operates as an active **scientific forensic investigator**:

### Core Capabilities

**1 — Multi-Rate Evidence Preservation**
Ingests native, multi-resolution temporal streams directly from NASA CDAWeb without lossy downsampling:
- GOES-11 EP8 particle flux at 5-minute resolution (36 records)
- GOES-11 magnetometer B-field in GSM coordinates at 1-minute resolution (180 records)
- GOES-11 orbital ephemeris at 3-minute resolution (61 records)
- Anchor event record at the exact anomaly timestamp

All 278 normalised evidence records are preserved in their original temporal structure as a flat CSV, timestamped in ISO 8601, and served via a REST API.

**2 — Dual-Pass AI Reasoning Engine**
A two-stage reasoning architecture evaluates three physics-based hypotheses with explicit supporting evidence citations:

- **Pass 1 (Hypothesis Generation):** Constructs three competing hypotheses (Surface Charging/ESD, Single Event Upset, Hardware Failure), scores each with a confidence value (0–100), and maps supporting evidence records to each.
- **Pass 2 (Red-Team Challenge):** Acts as an adversarial Red-Team agent. Challenges the leading hypothesis by scanning for missing signatures, evaluating sensor limitations, and identifying contradicting data. Confidence scores are recalibrated when counter-evidence is found.

**3 — Interactive Forensic Dashboard**
A dark-mode React command-center renders the full investigation state:
- Multi-series Recharts timeline chart (MAG + EP8 overlaid, anomaly reference line)
- Animated hypothesis confidence matrix with colour-coded progress bars
- Red-team challenge panel with counter-evidence list and confidence recalibration
- Exportable Forensic Summary Report with case metadata, data sources, and scientific limitations

**4 — Scientific Transparency**
Every output cites the evidence records that inform it. Scientific limitations (proxy sensor distance, data gaps, averaging artefacts) are surfaced explicitly and included in every report — not hidden.

---

## 🧠 AI Approach & Architecture

SPACEFORENSICS uses **IBM Granite 3.3 8B Instruct** (`ibm/granite-3-3-8b-instruct`) via **IBM Watsonx.ai**, orchestrated through **LangChain** (`@langchain/ibm`) in a dual-pass agent architecture.

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        DATA PIPELINE                            │
│  NASA CDAWeb API  →  fetch_galaxy15.py  →  galaxy15_evidence.csv│
│  (3 datasets)         (Python/pandas)      (278 records, flat)  │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│                       EXPRESS REST API                          │
│  GET  /api/cases/:id            → case metadata (case.json)     │
│  GET  /api/cases/:id/timeline   → 278 evidence records          │
│  GET  /api/cases/:id/evidence-graph → static hypothesis nodes   │
│  POST /api/cases/:id/investigate    → Pass 1 hypothesis scores  │
│  POST /api/cases/:id/challenge      → Pass 1 + Pass 2 combined  │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│                      AI ENGINE (aiEngine.js)                    │
│                                                                 │
│  classifyEvidence(rows)                                         │
│    → peakEp8, elevatedFluxCount, magNearAnomaly                 │
│                                                                 │
│  Pass 1: generateHypothesesPass(evidenceStream)                 │
│    → IBM Granite via ChatWatsonx (LangChain)                    │
│    → System prompt: space weather analyst, return JSON schema   │
│    → Returns: hypotheses[{id, label, confidence, reasoning,     │
│               supporting_evidence}], top_hypothesis_id          │
│                                                                 │
│  Pass 2: redTeamChallengePass(leadingHypothesis, evidenceStream)│
│    → IBM Granite via ChatWatsonx (LangChain)                    │
│    → System prompt: Red-Team agent, challenge named hypothesis  │
│    → Returns: counter_evidence[{type, description,              │
│               confidence_impact}], updated_hypotheses,          │
│               red_team_summary                                  │
│                                                                 │
│  Fallback (no API key): deterministic domain-logic engine       │
│    → ESD baseline 60 + flux bonuses                             │
│    → SEU baseline 50 + mag disturbance bonus                    │
│    → Hardware Failure baseline 30 − environment penalty         │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│                    REACT DASHBOARD (Vite)                       │
│  Header → EventTimeline (Recharts) → HypothesisMatrix           │
│  RedTeamPanel → ReportModal                                     │
│  Tailwind CSS dark-mode · Lucide Icons · port 5173              │
└─────────────────────────────────────────────────────────────────┘
```

### LLM Integration Details

| Property | Value |
|---|---|
| **Model** | `ibm/granite-3-3-8b-instruct` |
| **Platform** | IBM Watsonx.ai (`https://us-south.ml.cloud.ibm.com`) |
| **LangChain Class** | `ChatWatsonx` from `@langchain/ibm` |
| **Auth** | `WATSONX_AI_APIKEY` + `WATSONX_AI_PROJECT_ID` (env vars) |
| **Max Tokens** | 1024 per pass |
| **Fallback** | Deterministic domain-logic engine (runs when no API key) |

### Pass 1 — Hypothesis Generation Prompt Design

The system prompt instructs Granite to act as a **space weather analyst** specialising in geostationary satellite anomaly forensics. The user message supplies a compact summary of computed evidence metrics (peak e-flux, elevated-flux count, magnetic disturbance rows). Granite returns structured JSON matching the hypothesis schema, with confidence scores and supporting evidence IDs for each competing hypothesis.

### Pass 2 — Red-Team Challenge Prompt Design

The system prompt instructs Granite to act as a **Red-Team agent** whose sole purpose is to challenge the named leading hypothesis. It is explicitly instructed to find missing signatures (e.g. absent proton flux sensor), contradicting data (e.g. attitude control remained nominal), and sensor limitations (e.g. proxy observer 2° away). Granite returns structured JSON with `counter_evidence` items (typed: `missing_signature`, `contradicting_data`, `sensor_limitation`), updated confidence scores, and a red-team summary paragraph.

### Deterministic Fallback

When `WATSONX_AI_APIKEY` is absent, a self-contained domain-logic engine runs instead so all API endpoints return valid, structurally correct JSON during local development and CI:

- **ESD:** baseline 60 → +15 if ≥5 elevated-flux readings → +10 if peak e-flux > 2000
- **SEU:** baseline 50 → +10 if magnetic disturbance rows found → +5 if ≥3 elevated-flux readings
- **Hardware Failure:** baseline 30 → −10 if peak e-flux > 2000 (environmental cause more likely)

Pass 2 fallback always generates ≥3 counter-evidence items sourced from the known scientific limitations in `case.json`.

---

## 🗂️ Project Structure

```
spaceforensics/
├── cases/
│   └── galaxy-15/
│       ├── case.json                      # Case identity card and scientific metadata
│       ├── fetch_galaxy15.py              # NASA CDAWeb data pipeline (Python/pandas)
│       ├── raw/
│       │   ├── GOES11_K0_EP8.json         # Raw particle flux from NASA CDAWeb
│       │   ├── GOES11_K0_MAG.json         # Raw magnetic field from NASA CDAWeb
│       │   └── GOES11_EPHEMERIS_SSC.json  # Raw orbital ephemeris from NASA CDAWeb
│       └── normalized/
│           └── galaxy15_evidence.csv      # 278 normalised evidence records
│
├── backend/
│   ├── server.js                          # Express REST API (6 endpoints)
│   ├── services/
│   │   └── aiEngine.js                    # Dual-pass AI engine (Granite + LangChain)
│   ├── .env.example                       # Required environment variables
│   └── package.json
│
└── frontend/
    ├── src/
    │   ├── App.jsx                        # Root component and state management
    │   ├── api.js                         # Centralised API fetch helpers
    │   └── components/
    │       ├── Header.jsx                 # Sticky top bar with case identity
    │       ├── EventTimeline.jsx          # Recharts multi-series timeline chart
    │       ├── HypothesisMatrix.jsx       # Confidence score progress bar grid
    │       ├── RedTeamPanel.jsx           # Challenge button + counter-evidence list
    │       └── ReportModal.jsx            # Full-screen exportable forensic report
    └── package.json
```

---

## ⚡ Quick Start

### Prerequisites
- Node.js ≥ 18
- Python ≥ 3.9 (for data pipeline only)
- IBM Watsonx.ai API key *(optional — deterministic fallback runs without it)*

### 1 — Clone and Install

```bash
git clone https://github.com/your-org/spaceforensics.git
cd spaceforensics

# Backend
cd backend && npm install && cd ..

# Frontend
cd frontend && npm install && cd ..
```

### 2 — Configure Environment

```bash
cp backend/.env.example backend/.env
# Edit backend/.env and fill in your Watsonx credentials (optional)
```

```env
PORT=5001
WATSONX_AI_APIKEY=
WATSONX_AI_PROJECT_ID=
WATSONX_AI_URL=https://us-south.ml.cloud.ibm.com
```

### 3 — Run

```bash
# Terminal 1 — Backend API
cd backend && node server.js
# → SPACEFORENSICS API running on port 5001

# Terminal 2 — Frontend dashboard
cd frontend && npm run dev
# → Local: http://localhost:5173
```

### 4 — Investigate

1. Open **http://localhost:5173**
2. The timeline chart and case metadata load automatically
3. Click **Investigate** → Pass 1 hypothesis scores appear with reasoning
4. Click **🔥 Challenge This Conclusion** → Pass 2 red-team counter-evidence recalibrates the scores
5. Click **Export Report** → Full forensic summary modal with all sections

---

## 🔌 API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/cases` | List all available cases |
| `GET` | `/api/cases/:id` | Full case metadata (`case.json`) |
| `GET` | `/api/cases/:id/timeline` | 278 time-sorted evidence records |
| `GET` | `/api/cases/:id/evidence-graph` | Hypothesis nodes with supporting/contradicting evidence |
| `POST` | `/api/cases/:id/investigate` | Pass 1: hypothesis generation + confidence scores |
| `POST` | `/api/cases/:id/challenge` | Pass 1 + Pass 2: red-team critique + updated scores |

---

## 🤖 How IBM Bob Was Used

IBM Bob (AI-assisted software engineering assistant) was the primary tool used to plan, implement, and iterate on every layer of this project. Bob was not used as a code generator for isolated snippets — it acted as a **technical co-pilot** for the full engineering lifecycle:

### Architecture & Planning
Bob produced detailed, phase-by-phase implementation plans before any code was written:
- [`galaxy15-fetch-plan.md`](galaxy15-fetch-plan.md) — Data pipeline design: NASA CDAWeb API integration, CDF-JSON parsing strategy, CSV normalisation schema
- [`backend-api-plan.md`](backend-api-plan.md) — Express REST API design: endpoint contracts, route patterns, helper architecture
- [`ai-engine-plan.md`](ai-engine-plan.md) — Dual-pass AI engine design: LLM prompt strategy, result schemas, deterministic fallback logic
- [`frontend-dashboard-plan.md`](frontend-dashboard-plan.md) — React dashboard design: component hierarchy, data flow, Recharts integration

Each plan included explicit expected outcomes, todo checklists, and verification criteria — allowing Bob to track progress across sessions.

### Implementation
Bob wrote all production code in this repository:
- The Python data pipeline (`fetch_galaxy15.py`) including the CDAWeb REST client, CDF-JSON structure navigation (discovered live via API inspection), fill-value filtering, and pandas normalisation
- The entire Express API (`server.js`) including the stream-based CSV parser, evidence graph classifier, and all six route handlers
- The dual-pass AI engine (`aiEngine.js`) including the `ChatWatsonx` / LangChain integration, prompt templates, JSON response parsing, and the deterministic fallback engine
- All five React components and the `api.js` service module

### Debugging & Iteration
Bob helped diagnose real integration issues encountered during development:
- Discovered that the CDAWeb REST API required `?format=json` as a query parameter (not `Accept` header) and that the correct CDF-JSON nesting path was `CDF[0].cdfVariables.variable[]` (not the assumed `CdaData.Variable`)
- Resolved a CommonJS / ESM boundary issue with `@langchain/ibm` in a `require()`-based Express server
- Identified and fixed the macOS AirPlay port conflict (port 5000 → 5001)

### Codebase Q&A
Throughout development, Bob was used to answer questions about the live codebase — reading files, finding symbol definitions, tracing data flow across layers — without requiring manual file navigation.

---

## 📊 Evidence Dataset

| Source | Instrument | Measurement | Resolution | Records |
|---|---|---|---|---|
| `GOES11_EP8` | GOES-11 Energetic Particle Sensor | Electron flux >2 MeV (`e_flux`) | 5 min | 36 |
| `GOES11_MAG` | GOES-11 Magnetometer | Magnetic field GSM (`b_gsm`, nT) | 1 min | 180 |
| `GOES11_EPHEMERIS` | GOES-11 SSC Ephemeris | Orbital radius (`position`, Re) | 3 min | 61 |
| `CASE` | Anchor event | Command loss (`galaxy15_anomaly`) | Event | 1 |
| **Total** | | | | **278** |

**Data window:** 2010-04-05T08:00:00Z → 2010-04-05T11:00:00Z (3 hours)  
**Source:** [NASA CDAWeb](https://cdaweb.gsfc.nasa.gov) — public, no authentication required

---

## ⚠️ Scientific Limitations

These limitations are surfaced explicitly in every investigation report and inform the red-team challenge:

1. GOES-11 was at GEO −135.0° W, approximately 2° from Galaxy 15 at −133.0° W. Particle and field measurements are a proxy, not a direct in-situ sample at the satellite bus.
2. The 5-minute averaging of EP8 particle flux data smooths sub-minute impulsive flux increases that may have caused single-event upsets.
3. B_GSM is the local field at GOES-11, not at the Galaxy 15 spacecraft body. No magnetometer was onboard Galaxy 15.
4. Causation between the space weather environment and the command anomaly is inferred, not established. Ground software and RF link conditions are not captured.
5. CDAWeb fill values (−1.0E31) indicate data gaps in the Level-2 archive and are removed from the evidence CSV.
6. GOES-11 ephemeris from SSC is reconstructed orbit data and may differ by tens of kilometres from the real-time position.

---

## 🔧 Tech Stack

| Layer | Technology |
|---|---|
| Data pipeline | Python 3, `requests`, `pandas` |
| Backend API | Node.js, Express.js, `csv-parser`, `dotenv` |
| AI engine | IBM Granite 3.3 8B Instruct, IBM Watsonx.ai, LangChain (`@langchain/ibm`) |
| Frontend | Vite, React, Tailwind CSS, Recharts, Lucide Icons |
| Data source | NASA CDAWeb REST API |

---

## 📄 License

MIT — see [LICENSE](LICENSE)
