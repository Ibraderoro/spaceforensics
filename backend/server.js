require('dotenv').config();
const express = require('express');
const cors = require('cors');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const aiEngine = require('./services/aiEngine');

const app = express();
const PORT = process.env.PORT || 5000;

// Cases directory is one level up from backend/
const CASES_DIR = path.join(__dirname, '..', 'cases');

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'spaceforensics-api' });
});

// ---------------------------------------------------------------------------
// Helper: build a provenance lookup map from case.json data_sources.
// Key: measurement string  →  Value: { dataset_id, provider, variable }
// Returns an empty Map when case.json cannot be loaded.
// ---------------------------------------------------------------------------
function buildProvenanceMap(caseId) {
  const caseJsonPath = path.join(CASES_DIR, caseId, 'case.json');
  if (!fs.existsSync(caseJsonPath)) return new Map();
  try {
    const meta = JSON.parse(fs.readFileSync(caseJsonPath, 'utf8'));
    const map = new Map();
    for (const ds of (meta.data_sources || [])) {
      map.set(ds.measurement, {
        dataset_id: ds.dataset_id,
        provider:   ds.provider,
        variable:   ds.variable,
      });
    }
    return map;
  } catch (_) {
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Helper: classify evidence_type from source string.
// Only classifications justified by the actual source data are used.
// ---------------------------------------------------------------------------
function evidenceType(source) {
  if (source === 'CASE') return 'case_event';
  // All GOES11_* sources are in-situ environmental sensor measurements
  if (source.startsWith('GOES11_')) return 'environmental_observation';
  return null;
}

// ---------------------------------------------------------------------------
// Helper: parse a case's evidence CSV into a sorted array of records.
// Each record carries the original six fields plus provenance:
//   evidence_id, dataset_id, provider, variable, evidence_type, quality
// ---------------------------------------------------------------------------
function parseEvidenceCSV(caseId) {
  return new Promise((resolve, reject) => {
    // NOTE: filename is currently case-specific. When new cases are added,
    // this should be generalised to glob for *_evidence.csv inside normalized/.
    const csvPath = path.join(CASES_DIR, caseId, 'normalized', 'galaxy15_evidence.csv');

    if (!fs.existsSync(csvPath)) {
      return reject({ status: 404, message: 'Timeline data not found' });
    }

    // Build provenance lookup once per call — safe, synchronous, small file.
    const provenance = buildProvenanceMap(caseId);

    const rows = [];
    fs.createReadStream(csvPath)
      .pipe(csv())
      .on('data', (row) => {
        const prov = provenance.get(row.measurement) || {
          dataset_id: null,
          provider:   null,
          variable:   null,
        };
        rows.push({
          // --- original fields (unchanged) ---
          timestamp:   row.timestamp,
          source:      row.source,
          measurement: row.measurement,
          value:       parseFloat(row.value),
          unit:        row.unit,
          resolution:  row.resolution,
          // --- provenance fields ---
          evidence_id:  null,          // assigned after sort
          dataset_id:   prov.dataset_id,
          provider:     prov.provider,
          variable:     prov.variable,
          evidence_type: evidenceType(row.source),
          quality:      null,          // no quality flag in this dataset
        });
      })
      .on('end', () => {
        // Primary sort: ISO 8601 timestamps are lexicographically sortable.
        // Secondary sort: source string — breaks ties deterministically so that
        // evidence_id assignment is stable across repeated calls with identical input.
        rows.sort((a, b) => {
          if (a.timestamp < b.timestamp) return -1;
          if (a.timestamp > b.timestamp) return  1;
          if (a.source    < b.source)    return -1;
          if (a.source    > b.source)    return  1;
          return 0;
        });

        // Assign deterministic IDs after sort (1-based, zero-padded to 4 digits).
        rows.forEach((row, i) => {
          row.evidence_id = `E-G15-${String(i + 1).padStart(4, '0')}`;
        });

        resolve(rows);
      })
      .on('error', (err) => reject({ status: 500, message: err.message }));
  });
}

// ---------------------------------------------------------------------------
// GET /api/cases — list all available cases
// ---------------------------------------------------------------------------
app.get('/api/cases', (req, res) => {
  try {
    const entries = fs.readdirSync(CASES_DIR, { withFileTypes: true });
    const cases = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const caseJsonPath = path.join(CASES_DIR, entry.name, 'case.json');
      if (!fs.existsSync(caseJsonPath)) continue;
      const meta = JSON.parse(fs.readFileSync(caseJsonPath, 'utf8'));
      cases.push({ case_id: meta.case_id, title: meta.title });
    }

    res.json(cases);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/cases/:id — full case metadata
// ---------------------------------------------------------------------------
app.get('/api/cases/:id', (req, res) => {
  const caseJsonPath = path.join(CASES_DIR, req.params.id, 'case.json');

  if (!fs.existsSync(caseJsonPath)) {
    return res.status(404).json({ error: 'Case not found' });
  }

  try {
    const meta = JSON.parse(fs.readFileSync(caseJsonPath, 'utf8'));
    res.json(meta);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/cases/:id/timeline — time-sorted evidence records
// ---------------------------------------------------------------------------
app.get('/api/cases/:id/timeline', async (req, res) => {
  // Guard: case directory must exist
  const casePath = path.join(CASES_DIR, req.params.id);
  if (!fs.existsSync(casePath)) {
    return res.status(404).json({ error: 'Case not found' });
  }

  try {
    const rows = await parseEvidenceCSV(req.params.id);
    res.json(rows);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Helper: build the evidence-provenance graph from an already-parsed rows array.
//
// Design principles:
//   - All evidence is referenced by evidence_id; raw rows are never duplicated.
//   - Five hypotheses (H1–H5) are returned including H5 (insufficient evidence),
//     which is a legitimate outcome.
//   - assessments use categorical language only — never a probability or score.
//   - causal_attribution_established is always false for Galaxy 15.
//   - Any temporal selection of evidence is labelled as a heuristic window; it
//     is NOT a calibrated scientific threshold.
//   - The four scientifically-unsound inferences from the prior implementation
//     (A–D) have been replaced with defensible language.
// ---------------------------------------------------------------------------
function buildEvidenceGraph(caseId, rows) {
  // ── Partition rows by source ─────────────────────────────────────────────
  const ep8Rows    = rows.filter((r) => r.source === 'GOES11_EP8');
  const magRows    = rows.filter((r) => r.source === 'GOES11_MAG');
  const anchorRows = rows.filter((r) => r.source === 'CASE');

  // ── Temporal investigation window around the anomaly ────────────────────
  // HEURISTIC: ±10-minute window is an MVP evidence-selection convention.
  // It is NOT a scientifically calibrated causal threshold.
  const HEURISTIC_WINDOW_NOTE =
    'MVP temporal selection window of ±10 minutes around the anomaly timestamp; ' +
    'this is an evidence-selection heuristic, not a scientifically calibrated causal threshold.';
  const anomalyTime = new Date('2010-04-05T09:48:00Z').getTime();
  const WINDOW_MS   = 10 * 60 * 1000;

  const ep8Window = ep8Rows.filter(
    (r) => Math.abs(new Date(r.timestamp).getTime() - anomalyTime) <= WINDOW_MS
  );
  const magWindow = magRows.filter(
    (r) => Math.abs(new Date(r.timestamp).getTime() - anomalyTime) <= WINDOW_MS
  );

  // ── Helpers ──────────────────────────────────────────────────────────────
  // Deduplicate a list of evidence_ids while preserving insertion order.
  const dedup = (ids) => [...new Set(ids)];

  // Build a supporting_evidence relationship object.
  const ref = (evidence_id, relationship, interpretation) => ({
    evidence_id,
    relationship,
    interpretation,
  });

  // ── Shared anchor-event references ───────────────────────────────────────
  const anchorRefs = dedup(anchorRows.map((r) => r.evidence_id)).map((id) =>
    ref(
      id,
      'command_loss_consistent_with_multiple_mechanisms',
      'The anchor event (loss of ground command contact) is consistent with multiple ' +
      'failure mechanisms and does not by itself discriminate among them.'
    )
  );

  // ── EP8 environmental-context references (within heuristic window) ───────
  const ep8EnvRefs = dedup(ep8Window.map((r) => r.evidence_id)).map((id) =>
    ref(
      id,
      'elevated_electron_flux_environment',
      'Elevated 1 MeV electron flux measured by GOES-11 EP8 within the ±10-minute ' +
      'heuristic investigation window establishes an energetic-particle environment ' +
      'contemporaneous with the anomaly. This is environmental context; it does not ' +
      'independently confirm a causal mechanism.'
    )
  );

  // ── MAG environmental-context references (within heuristic window) ───────
  const magEnvRefs = dedup(magWindow.map((r) => r.evidence_id)).map((id) =>
    ref(
      id,
      'magnetic_field_disturbance_near_anomaly',
      'Magnetic field measurements from GOES-11 MAG within the ±10-minute heuristic ' +
      'investigation window document geomagnetic conditions contemporaneous with the ' +
      'anomaly. The field values are a proxy measurement at GOES-11 longitude, not ' +
      'direct in-situ data at the Galaxy 15 spacecraft bus.'
    )
  );

  // ── Non-discriminating EP8 + MAG references (all records, not windowed) ──
  // Used for hypotheses where the environment is neither supporting nor contradicting.
  const allEnvNonDiscrimRefs = dedup([
    ...ep8Rows.map((r) => r.evidence_id),
    ...magRows.map((r) => r.evidence_id),
  ]).map((id) =>
    ref(
      id,
      'environmental_conditions_neither_confirm_nor_exclude',
      'Available environmental measurements neither confirm nor exclude this hypothesis. ' +
      'The presence of an energetic-particle environment is not sufficient to attribute ' +
      'or rule out any specific failure mechanism without additional telemetry.'
    )
  );

  // ────────────────────────────────────────────────────────────────────────
  // H1 — Spacecraft charging / electrostatic discharge
  // ────────────────────────────────────────────────────────────────────────
  const H1 = {
    hypothesis_id: 'H1',
    label: 'Spacecraft charging / electrostatic discharge',
    description:
      'Differential charging of spacecraft surfaces by sustained high-energy electron flux ' +
      'leading to an electrostatic discharge event that affected the command receiver or ' +
      'command-processing subsystem.',
    supporting_evidence: ep8EnvRefs,
    heuristic_note: HEURISTIC_WINDOW_NOTE,
    contradicting_evidence: [],
    non_discriminating_evidence: anchorRefs,
    limitations: [
      {
        type: 'unresolved',
        description:
          'Continued nominal attitude behavior does not independently confirm a spacecraft-wide ' +
          'electrical disturbance and does not by itself rule out a localized charging/ESD event.',
      },
      {
        type: 'proxy_measurement',
        description:
          'GOES-11 EP8 measurements are a proxy ~2° of longitude from Galaxy 15. Direct in-situ ' +
          'particle flux at the spacecraft bus is unavailable.',
      },
      {
        type: 'missing_data',
        description:
          'No spacecraft surface-charging telemetry or onboard electrostatic monitoring data is ' +
          'available in this dataset.',
      },
    ],
    assessment: 'mixed',
  };

  // ────────────────────────────────────────────────────────────────────────
  // H2 — Single-event electronic upset / latchup
  // ────────────────────────────────────────────────────────────────────────
  const H2 = {
    hypothesis_id: 'H2',
    label: 'Single-event electronic upset / latchup',
    description:
      'A high-energy particle traversed the command-receiver or command-processor integrated ' +
      'circuit, causing a single-event upset (SEU) that flipped a critical configuration bit, ' +
      'or inducing a latchup that rendered the uplink receiver unresponsive.',
    supporting_evidence: [...ep8EnvRefs, ...magEnvRefs],
    heuristic_note: HEURISTIC_WINDOW_NOTE,
    contradicting_evidence: [],
    non_discriminating_evidence: anchorRefs,
    limitations: [
      {
        type: 'unresolved',
        description:
          'Continued payload/transponder operation constrains hypotheses involving spacecraft-wide ' +
          'failure, but does not rule out a localized electronic upset in the command subsystem.',
      },
      {
        type: 'proxy_measurement',
        description:
          'The 5-minute averaging of EP8 particle flux data smooths sub-minute impulsive flux ' +
          'increases that may have caused single-event upsets. The exact particle environment at ' +
          'the time of upset cannot be resolved from 5-minute averages.',
      },
      {
        type: 'proxy_measurement',
        description:
          'B_GSM is the local field at GOES-11, not at the Galaxy 15 spacecraft body. No ' +
          'magnetometer was onboard Galaxy 15.',
      },
    ],
    assessment: 'mixed',
  };

  // ────────────────────────────────────────────────────────────────────────
  // H3 — Command receiver / command-processing fault
  // ────────────────────────────────────────────────────────────────────────
  const H3 = {
    hypothesis_id: 'H3',
    label: 'Command receiver / command-processing fault',
    description:
      'A fault internal to the command receiver or command-processing chain — hardware, ' +
      'firmware, power-state, or software — produced a persistent loss of command uplink ' +
      'capability independent of the external environment.',
    supporting_evidence: anchorRows.map((r) =>
      ref(
        r.evidence_id,
        'persistent_command_unresponsiveness',
        'Extended command unresponsiveness is consistent with a persistent command-system fault, ' +
        'but does not establish whether the underlying mechanism was hardware, software, latchup, ' +
        'or another failure mode.'
      )
    ),
    contradicting_evidence: [],
    non_discriminating_evidence: allEnvNonDiscrimRefs,
    limitations: [
      {
        type: 'unresolved',
        description:
          'Autonomous recovery provides evidence against an irreversible catastrophic failure, but ' +
          'does not by itself distinguish among recoverable hardware, software, power-state, latchup, ' +
          'or command-processing mechanisms.',
      },
      {
        type: 'missing_data',
        description:
          'No spacecraft command-subsystem telemetry, onboard fault logs, or RF link data are ' +
          'present in this dataset.',
      },
    ],
    assessment: 'supported',
  };

  // ────────────────────────────────────────────────────────────────────────
  // H4 — Ground segment / RF link anomaly
  // ────────────────────────────────────────────────────────────────────────
  const H4 = {
    hypothesis_id: 'H4',
    label: 'Ground segment / RF link anomaly',
    description:
      'A fault in the ground station, the RF uplink chain, or the command-routing infrastructure ' +
      'produced the apparent loss of command responsiveness without any fault on the spacecraft.',
    supporting_evidence: [],
    contradicting_evidence: [],
    non_discriminating_evidence: allEnvNonDiscrimRefs,
    limitations: [
      {
        type: 'missing_data',
        description:
          'No ground-segment or RF link data is present in this dataset. This hypothesis cannot be ' +
          'evaluated from the available evidence.',
      },
    ],
    assessment: 'insufficient_evidence',
  };

  // ────────────────────────────────────────────────────────────────────────
  // H5 — Insufficient evidence for causal attribution
  // ────────────────────────────────────────────────────────────────────────
  const H5 = {
    hypothesis_id: 'H5',
    label: 'Insufficient evidence for causal attribution',
    description:
      'The available evidence is insufficient to establish a causal mechanism for the Galaxy 15 ' +
      'command anomaly. This is a legitimate outcome of the investigation, not a failure to analyse.',
    supporting_evidence: anchorRows.map((r) =>
      ref(
        r.evidence_id,
        'anomaly_unresolved_after_investigation',
        'The anchor event documents a persistent anomaly whose causal mechanism is not established ' +
        'by the available environmental or spacecraft data.'
      )
    ),
    contradicting_evidence: [],
    non_discriminating_evidence: allEnvNonDiscrimRefs,
    limitations: [
      {
        type: 'unresolved',
        description:
          'Causal attribution is not established by the available evidence, as stated in case.json. ' +
          'Multiple hypotheses remain plausible and cannot be discriminated without additional data.',
      },
      {
        type: 'missing_data',
        description:
          'Key discriminating data — spacecraft command-subsystem telemetry, onboard fault logs, ' +
          'RF link monitoring, and direct in-situ particle measurements at the Galaxy 15 bus — are ' +
          'absent from this dataset.',
      },
    ],
    assessment: 'strongly_supported',
  };

  return {
    case_id: caseId,
    causal_attribution_established: false,
    hypotheses: [H1, H2, H3, H4, H5],
  };
}

// ---------------------------------------------------------------------------
// GET /api/cases/:id/evidence-graph
// ---------------------------------------------------------------------------
app.get('/api/cases/:id/evidence-graph', async (req, res) => {
  const casePath = path.join(CASES_DIR, req.params.id);
  if (!fs.existsSync(casePath)) {
    return res.status(404).json({ error: 'Case not found' });
  }

  let rows;
  try {
    rows = await parseEvidenceCSV(req.params.id);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  res.json(buildEvidenceGraph(req.params.id, rows));
});

// ---------------------------------------------------------------------------
// POST /api/cases/:id/investigate — Pass 1: competing hypotheses + evidence graph
// ---------------------------------------------------------------------------
app.post('/api/cases/:id/investigate', async (req, res) => {
  const casePath = path.join(CASES_DIR, req.params.id);
  if (!fs.existsSync(casePath)) {
    return res.status(404).json({ error: 'Case not found' });
  }

  let rows;
  try {
    rows = await parseEvidenceCSV(req.params.id);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  try {
    const result = await aiEngine.generateHypothesesPass(rows);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/cases/:id/challenge — Pass 2: red-team critique + updated confidence
// ---------------------------------------------------------------------------
app.post('/api/cases/:id/challenge', async (req, res) => {
  const casePath = path.join(CASES_DIR, req.params.id);
  if (!fs.existsSync(casePath)) {
    return res.status(404).json({ error: 'Case not found' });
  }

  let rows;
  try {
    rows = await parseEvidenceCSV(req.params.id);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  try {
    // Pass 1 — identify the top-ranked hypothesis
    const pass1 = await aiEngine.generateHypothesesPass(rows);
    const topHypothesis = pass1.hypotheses[0];

    // Pass 2 — red-team the top hypothesis
    const pass2 = await aiEngine.redTeamChallengePass(topHypothesis, rows);

    res.json({
      case_id: req.params.id,
      pass1_hypotheses: pass1.hypotheses,
      ...pass2,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start server — guard prevents the server from starting when this module is
// imported by tests (require.main !== module in that case).
// ---------------------------------------------------------------------------
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`SPACEFORENSICS API running on port ${PORT}`);
  });
}

// ---------------------------------------------------------------------------
// Exports — available to automated tests
// ---------------------------------------------------------------------------
module.exports = { parseEvidenceCSV, buildEvidenceGraph };
