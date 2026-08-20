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
// Helper: parse a case's evidence CSV into a sorted array of records
// ---------------------------------------------------------------------------
function parseEvidenceCSV(caseId) {
  return new Promise((resolve, reject) => {
    // NOTE: filename is currently case-specific. When new cases are added,
    // this should be generalised to glob for *_evidence.csv inside normalized/.
    const csvPath = path.join(CASES_DIR, caseId, 'normalized', 'galaxy15_evidence.csv');

    if (!fs.existsSync(csvPath)) {
      return reject({ status: 404, message: 'Timeline data not found' });
    }

    const rows = [];
    fs.createReadStream(csvPath)
      .pipe(csv())
      .on('data', (row) => {
        rows.push({
          timestamp: row.timestamp,
          source: row.source,
          measurement: row.measurement,
          value: parseFloat(row.value),
          unit: row.unit,
          resolution: row.resolution,
        });
      })
      .on('end', () => {
        // ISO 8601 strings are lexicographically sortable
        rows.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
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
// GET /api/cases/:id/evidence-graph
//
// Returns three competing hypotheses with supporting and contradicting
// evidence nodes drawn from the parsed CSV rows.
//
// Classification is static domain knowledge for the Galaxy 15 incident:
//   - Surface Charging / ESD  → driven by elevated electron flux (EP8)
//   - Single Event Upset      → driven by energetic particle environment (EP8 + MAG)
//   - Hardware Failure        → driven by command unresponsiveness (anchor event)
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

  // Partition rows by source for convenience
  const ep8Rows = rows.filter((r) => r.source === 'GOES11_EP8');
  const magRows = rows.filter((r) => r.source === 'GOES11_MAG');
  const anchorRows = rows.filter((r) => r.source === 'CASE');

  // Peak electron flux reading — key supporting datum for ESD & SEU
  const peakEp8 = ep8Rows.reduce(
    (max, r) => (r.value > max.value ? r : max),
    ep8Rows[0] || { value: -Infinity }
  );

  // Magnetic field disturbance window — rows near the anomaly timestamp
  const anomalyTime = new Date('2010-04-05T09:48:00Z').getTime();
  const magNearAnomaly = magRows.filter((r) => {
    const diff = Math.abs(new Date(r.timestamp).getTime() - anomalyTime);
    return diff <= 10 * 60 * 1000; // ±10 minutes
  });

  const graph = {
    surface_charging_esd: {
      label: 'Surface Charging / ESD',
      description:
        'Differential charging of spacecraft surfaces by sustained high-energy electron flux ' +
        'leading to an electrostatic discharge event that disrupted the command processor.',
      supporting: [
        peakEp8,
        ...ep8Rows.filter((r) => r.value > 1000), // elevated flux threshold
      ].filter(Boolean),
      contradicting: [
        // No attitude anomaly was recorded — ESD events typically disturb attitude sensors
        ...anchorRows,
        {
          source: 'SCIENTIFIC_LIMITATION',
          measurement: 'no_attitude_anomaly',
          value: null,
          unit: null,
          resolution: null,
          timestamp: '2010-04-05T09:48:00Z',
          note: 'Attitude control remained nominal throughout the anomaly; pure ESD would likely have disturbed attitude sensors.',
        },
      ],
    },

    single_event_upset: {
      label: 'Single Event Upset (SEU)',
      description:
        'A high-energy particle (proton or heavy ion) penetrated the command processor ' +
        'and flipped a critical bit, locking the uplink receiver into a non-responsive state.',
      supporting: [
        peakEp8,
        ...magNearAnomaly,
        ...anchorRows,
      ].filter(Boolean),
      contradicting: [
        {
          source: 'SCIENTIFIC_LIMITATION',
          measurement: 'transponders_remained_active',
          value: null,
          unit: null,
          resolution: null,
          timestamp: '2010-04-05T09:48:00Z',
          note: 'All transponders and payload remained operational — a total SEU of the flight computer would typically affect more subsystems.',
        },
      ],
    },

    hardware_failure: {
      label: 'Hardware Failure',
      description:
        'A permanent or semi-permanent physical failure of the command receiver or uplink ' +
        'processing hardware, unrelated to the space weather environment.',
      supporting: [
        ...anchorRows,
        {
          source: 'CASE_CONTEXT',
          measurement: 'total_command_unresponsiveness',
          value: null,
          unit: null,
          resolution: null,
          timestamp: '2010-04-05T09:48:00Z',
          note: '9-month complete loss of uplink command capability is consistent with a hardware-level failure mode.',
        },
      ],
      contradicting: [
        {
          source: 'CASE_CONTEXT',
          measurement: 'autonomous_reboot',
          value: null,
          unit: null,
          resolution: null,
          timestamp: '2010-12-26T00:00:00Z',
          note: 'Spacecraft autonomously rebooted on 26 Dec 2010 and resumed normal operations — physical hardware destruction is ruled out.',
        },
        peakEp8,
      ].filter(Boolean),
    },
  };

  res.json(graph);
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
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`SPACEFORENSICS API running on port ${PORT}`);
});
