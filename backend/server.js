require('dotenv').config();
const express = require('express');
const cors = require('cors');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const aiEngine = require('./services/aiEngine');
const { buildForensicAnalysis, assembleValidatedForensicReport, getEvidenceProvenance, ForensicAnalysisValidationError } = require('./services/forensicAnalysis');
const aiAnalyst                  = require('./services/aiAnalyst');
const investigationStore         = require('./services/investigationStore');
const artifactService            = require('./services/artifactService');
const evidenceExploration        = require('./services/evidenceExploration');
const { pipelineLog, startTimer, PIPELINE_STAGES } = require('./services/pipelineLogger');
const { FORENSIC_TEMPORAL_WINDOW_MINUTES }         = require('./services/forensicConfig');

const app = express();
const PORT = process.env.PORT || 5000;

// Cases directory is one level up from backend/
const CASES_DIR = path.join(__dirname, '..', 'cases');

// Alias for readability within this module — the canonical value lives in forensicConfig.js.
const TEMPORAL_SELECTION_WINDOW_MINUTES = FORENSIC_TEMPORAL_WINDOW_MINUTES;

// ---------------------------------------------------------------------------
// Security middleware
// ---------------------------------------------------------------------------

// CORS — restrict to localhost origins in development; in production the
// ALLOWED_ORIGINS env-var should list the deployed frontend origin(s).
// Default: deny all cross-origin requests (empty string → no CORS headers).
const _corsOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : ['http://localhost:5173', 'http://localhost:4173'];

app.use(cors({
  origin: _corsOrigins,
  methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false,
}));

// Body parser — enforce a maximum to prevent memory exhaustion.
// 64 KB is generous for every investigation write; scientific evidence is
// served as read-only GET responses so no large uploads are expected.
app.use(express.json({ limit: '64kb' }));

// Security-relevant response headers applied to every API response.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

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
async function buildProvenanceMap(caseId) {
  const caseJsonPath = path.join(CASES_DIR, caseId, 'case.json');
  try {
    const meta = JSON.parse(await fs.promises.readFile(caseJsonPath, 'utf8'));
    const map = new Map();
    for (const ds of meta.data_sources || []) {
      map.set(ds.measurement, {
        dataset_id: ds.dataset_id,
        provider: ds.provider,
        variable: ds.variable,
      });
    }
    return map;
  } catch (_) {
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Helper: classify evidence_type from source string.
//
// Classification rules:
//   'CASE'    → 'case_event'         (anchor / case-defining events)
//   'GOES*_*' → 'environmental_observation'  (any GOES satellite sensor dataset)
//               Covers GOES11_*, GOES13_*, GOES15_*, etc. uniformly so that
//               second-case evidence from GOES-13 is correctly typed without
//               per-case branching.
//   anything else → null             (classification not defined for this source)
//
// Only classifications that are scientifically justified are returned.
// ---------------------------------------------------------------------------
function evidenceType(source) {
  if (source === 'CASE') return 'case_event';
  // Any GOES satellite sensor dataset is an in-situ environmental observation.
  // Pattern: GOESnn_ where nn is one or more digits.
  if (/^GOES\d+_/.test(source)) return 'environmental_observation';
  return null;
}

// ---------------------------------------------------------------------------
// Helper: build a standardised API error response body.
//
// Codes and their meanings:
//   CASE_NOT_FOUND                 — the requested case ID does not exist
//   FORENSIC_ANALYSIS_VALIDATION_ERROR — a deterministic invariant was violated
//   INTERNAL_FORENSIC_ERROR        — unexpected failure during analysis
//
// Only the code and a safe, human-readable message are returned.
// Stack traces, file paths, and internal details are never included.
// ---------------------------------------------------------------------------
function apiError(res, code, message, httpStatus) {
  return res.status(httpStatus).json({
    error_code:  code,
    error:       message,
    status_code: httpStatus,
  });
}

// ---------------------------------------------------------------------------
// Helper: map a caught error from the forensic pipeline to an apiError call.
// Distinguishes ForensicAnalysisValidationError from unexpected failures.
// ---------------------------------------------------------------------------
function handleForensicError(res, err) {
  if (err && err.name === 'ForensicAnalysisValidationError') {
    return apiError(res, 'FORENSIC_ANALYSIS_VALIDATION_ERROR',
      'Forensic analysis validation failed.', 422);
  }
  return apiError(res, 'INTERNAL_FORENSIC_ERROR',
    'An unexpected error occurred during forensic analysis.', 500);
}

// ---------------------------------------------------------------------------
// Helper: map a caught error from the investigation persistence layer to a
// safe apiError response.
//
// SAFETY RULES (Phase 8.7):
//   - NEVER include SQL text, stack traces, connection strings, credentials,
//     filesystem paths, or internal module names in the HTTP response.
//   - Distinguish client errors (4xx — already expressed via { ok, error,
//     status_code } returned by the repository) from server persistence
//     errors (5xx — unexpected DB / connection failures).
//   - Log the full error internally so operators can diagnose the failure.
//
// The { ok, error, status_code } pattern is used by both the in-memory and
// Postgres repositories for expected client-side failures (not-found, closed
// investigation, invalid status, etc.).  Only unexpected thrown errors reach
// this function; structured { ok:false } objects are handled inline.
// ---------------------------------------------------------------------------
function handlePersistenceError(res, err) {
  // Log the real error internally (operators need this; callers must not see it).
  console.error('[server] persistence error:', err && err.message ? err.message : String(err));

  // Map common PostgreSQL error codes to informative-but-safe messages.
  const code = err && err.code;

  // Connection / pool errors — DB is unreachable or pool is exhausted.
  if (code === '08000' || code === '08001' || code === '08003' || code === '08006' ||
      code === '57P03' || code === '53300' || (err && err.message &&
      (err.message.includes('connect ETIMEDOUT') ||
       err.message.includes('Connection terminated') ||
       err.message.includes('timeout expired') ||
       err.message.includes('remaining connection slots')))) {
    return apiError(res, 'PERSISTENCE_UNAVAILABLE',
      'The investigation persistence service is temporarily unavailable. Please retry shortly.',
      503);
  }

  // Transaction/serialisation failures — safe to retry.
  if (code === '40001' || code === '40P01') {
    return apiError(res, 'PERSISTENCE_CONFLICT',
      'A serialisation conflict occurred. Please retry the operation.',
      503);
  }

  // Unique-constraint violation — duplicate identifier.
  if (code === '23505') {
    return apiError(res, 'DUPLICATE_IDENTIFIER',
      'A record with the same identifier already exists.', 409);
  }

  // Foreign-key violation — referencing a non-existent parent record.
  if (code === '23503') {
    return apiError(res, 'INVALID_REFERENCE',
      'The referenced investigation or case does not exist.', 422);
  }

  // Generic persistence failure — do not expose SQL or stack trace.
  return apiError(res, 'PERSISTENCE_ERROR',
    'An unexpected persistence error occurred. The operation was not completed.',
    500);
}

// ---------------------------------------------------------------------------
// Helper: parse a case's evidence CSV into a sorted array of records.
// Each record carries the original six fields plus provenance:
//   evidence_id, dataset_id, provider, variable, evidence_type, quality
// ---------------------------------------------------------------------------
async function parseEvidenceCSV(caseId) {
  // Resolve the evidence CSV by scanning the case's normalized/ directory for
  // any file matching *_evidence.csv. Exactly one file must be present.
  const normalizedDir = path.join(CASES_DIR, caseId, 'normalized');

  try {
    await fs.promises.access(normalizedDir);
  } catch (_) {
    throw { status: 404, message: `Case not found: ${caseId}` };
  }

  const allEntries = await fs.promises.readdir(normalizedDir);
  const candidates = allEntries.filter((f) => /_evidence\.csv$/.test(f));

  if (candidates.length === 0) {
    throw { status: 404, message: `No evidence dataset found for case: ${caseId}` };
  }
  if (candidates.length > 1) {
    throw { status: 500, message: `Ambiguous evidence dataset for case: ${caseId}` };
  }

  const csvPath = path.join(normalizedDir, candidates[0]);

  // Read id_prefix from case.json asynchronously.
  // Fallback: uppercase caseId with hyphens removed — never fires for properly-onboarded cases.
  let idPrefix;
  try {
    const caseJsonPath = path.join(CASES_DIR, caseId, 'case.json');
    const meta = JSON.parse(await fs.promises.readFile(caseJsonPath, 'utf8'));
    idPrefix = meta.id_prefix || caseId.toUpperCase().replace(/-/g, '');
  } catch (_) {
    idPrefix = caseId.toUpperCase().replace(/-/g, '');
  }

  // Build provenance lookup once per call — small file, awaited.
  const provenance = await buildProvenanceMap(caseId);

  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(csvPath)
      .pipe(csv())
      .on('data', (row) => {
        const prov = provenance.get(row.measurement) || {
          dataset_id: null,
          provider: null,
          variable: null,
        };
        rows.push({
          // --- original fields (unchanged) ---
          timestamp: row.timestamp,
          source: row.source,
          measurement: row.measurement,
          value: parseFloat(row.value),
          unit: row.unit,
          resolution: row.resolution,
          // --- provenance fields ---
          evidence_id: null, // assigned after sort
          dataset_id: prov.dataset_id,
          provider: prov.provider,
          variable: prov.variable,
          evidence_type: evidenceType(row.source),
          quality: null, // no quality flag in this dataset
        });
      })
      .on('end', () => {
        // Primary sort: ISO 8601 timestamps are lexicographically sortable.
        // Secondary sort: source string — breaks ties deterministically so that
        // evidence_id assignment is stable across repeated calls with identical input.
        rows.sort((a, b) => {
          if (a.timestamp < b.timestamp) return -1;
          if (a.timestamp > b.timestamp) return 1;
          if (a.source < b.source) return -1;
          if (a.source > b.source) return 1;
          return 0;
        });

        // Assign deterministic IDs after sort (1-based, zero-padded to 4 digits).
        rows.forEach((row, i) => {
          row.evidence_id = `E-${idPrefix}-${String(i + 1).padStart(4, '0')}`;
        });

        resolve(rows);
      })
      .on('error', (err) => reject({ status: 500, message: err.message }));
  });
}

// ---------------------------------------------------------------------------
// GET /api/cases — list all available cases
// ---------------------------------------------------------------------------
app.get('/api/cases', async (req, res) => {
  try {
    const entries = await fs.promises.readdir(CASES_DIR, { withFileTypes: true });
    const cases = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const caseJsonPath = path.join(CASES_DIR, entry.name, 'case.json');
      try {
        const meta = JSON.parse(await fs.promises.readFile(caseJsonPath, 'utf8'));
        cases.push({ case_id: meta.case_id, title: meta.title });
      } catch (_) {
        // Directory has no valid case.json — skip silently
      }
    }

    res.json(cases);
  } catch (_) {
    return apiError(res, 'INTERNAL_ERROR',
      'Unable to list cases. Please try again.', 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/cases/:id — full case metadata
// ---------------------------------------------------------------------------
app.get('/api/cases/:id', async (req, res) => {
  const caseJsonPath = path.join(CASES_DIR, req.params.id, 'case.json');

  try {
    const meta = JSON.parse(await fs.promises.readFile(caseJsonPath, 'utf8'));
    res.json(meta);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return apiError(res, 'CASE_NOT_FOUND', 'Case not found', 404);
    }
    return apiError(res, 'INTERNAL_ERROR',
      'Unable to read case metadata. Please try again.', 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/cases/:id/timeline — time-sorted evidence records
// ---------------------------------------------------------------------------
app.get('/api/cases/:id/timeline', async (req, res) => {
  // Guard: case directory must exist
  const casePath = path.join(CASES_DIR, req.params.id);
  try {
    await fs.promises.access(casePath);
  } catch (_) {
    return apiError(res, 'CASE_NOT_FOUND', `Case not found: ${req.params.id}`, 404);
  }

  try {
    const rows = await parseEvidenceCSV(req.params.id);
    res.json(rows);
  } catch (err) {
    if (err && err.status === 404) {
      return apiError(res, 'CASE_NOT_FOUND', `Case not found: ${req.params.id}`, 404);
    }
    return apiError(res, 'INTERNAL_ERROR',
      'Unable to load case timeline. Please try again.', 500);
  }
});

// ---------------------------------------------------------------------------
// Helper: build the evidence-provenance graph from an already-parsed rows array.
//
// Reads hypotheses.json from the case directory to get hypothesis definitions,
// source roles, ref templates, and the heuristic window configuration.
// All Galaxy-15-specific values live in cases/galaxy-15/hypotheses.json.
// ---------------------------------------------------------------------------
async function buildEvidenceGraph(caseId, rows) {
  // ── Load case configuration ──────────────────────────────────────────────
  const caseJsonPath = path.join(CASES_DIR, caseId, 'case.json');
  const hypothesesJsonPath = path.join(CASES_DIR, caseId, 'hypotheses.json');

  let anchorTimestamp;
  try {
    const caseMeta = JSON.parse(await fs.promises.readFile(caseJsonPath, 'utf8'));
    anchorTimestamp = caseMeta.anchor_event && caseMeta.anchor_event.timestamp;
  } catch (_) {
    anchorTimestamp = null;
  }

  let hypoConfig;
  try {
    hypoConfig = JSON.parse(await fs.promises.readFile(hypothesesJsonPath, 'utf8'));
  } catch (_) {
    return { case_id: caseId, causal_attribution_established: false, hypotheses: [] };
  }

  const {
    causal_attribution_established,
    heuristic_window_minutes,
    heuristic_window_note: globalHeuristicNote,
    source_roles,
    ref_templates,
    hypotheses: hypoDefs,
  } = hypoConfig;

  // ── Partition rows by source role ────────────────────────────────────────
  const roleBuckets = {};
  for (const [role, sourceName] of Object.entries(source_roles || {})) {
    roleBuckets[role] = rows.filter((r) => r.source === sourceName);
  }

  // ── Temporal investigation window ────────────────────────────────────────
  const WINDOW_MS = (heuristic_window_minutes || TEMPORAL_SELECTION_WINDOW_MINUTES) * 60 * 1000;
  const anomalyTime = anchorTimestamp ? new Date(anchorTimestamp).getTime() : null;

  // Windowed buckets: for each "env_*" role, filter to within the heuristic window
  const windowedBuckets = {};
  for (const [role] of Object.entries(source_roles || {})) {
    if (role.startsWith('env_') && anomalyTime !== null) {
      windowedBuckets[`${role}_window`] = roleBuckets[role].filter(
        (r) => Math.abs(new Date(r.timestamp).getTime() - anomalyTime) <= WINDOW_MS,
      );
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  const dedup = (ids) => [...new Set(ids)];
  const mkRef = (evidence_id, tmpl) => ({
    evidence_id,
    relationship:   tmpl.relationship,
    interpretation: tmpl.interpretation,
  });

  // Resolve a rule name to an array of ref objects.
  // - env_*_window rules → dedup windowed env bucket → ref per ID
  // - anchor_* rules → anchor bucket rows → ref per row (no dedup, preserves original behaviour)
  //   EXCEPT when used in non_discriminating_evidence → dedup anchor IDs
  function resolveRule(ruleName, listName) {
    const tmpl = ref_templates[ruleName];
    if (!tmpl) return [];

    if (ruleName.startsWith('env_') && ruleName.endsWith('_window')) {
      // windowed environmental bucket
      const bucket = windowedBuckets[ruleName] || [];
      return dedup(bucket.map((r) => r.evidence_id)).map((id) => mkRef(id, tmpl));
    }

    if (ruleName.startsWith('anchor_')) {
      const anchorBucket = roleBuckets['anchor'] || [];
      if (listName === 'non_discriminating_evidence') {
        // dedup anchor IDs (original behaviour for H1/H2 non_discriminating)
        return dedup(anchorBucket.map((r) => r.evidence_id)).map((id) => mkRef(id, tmpl));
      }
      // supporting_evidence: one ref per anchor row (original behaviour for H3/H5)
      return anchorBucket.map((r) => mkRef(r.evidence_id, tmpl));
    }

    return [];
  }

  // ── Assemble hypotheses ──────────────────────────────────────────────────
  const LISTS = ['environmental_context', 'supporting_evidence', 'contradicting_evidence', 'non_discriminating_evidence'];

  const hypotheses = (hypoDefs || []).map((def) => {
    const assembled = {
      hypothesis_id: def.hypothesis_id,
      label:         def.label,
      description:   def.description,
      assessment:    def.assessment,
      heuristic_note: def.heuristic_note === 'use_global' ? globalHeuristicNote : (def.heuristic_note ?? null),
      limitations:   def.limitations || [],
    };

    for (const listName of LISTS) {
      const rules = (def.evidence_rules && def.evidence_rules[listName]) || [];
      assembled[listName] = rules.flatMap((ruleName) => resolveRule(ruleName, listName));
    }

    return assembled;
  });

  return {
    case_id: caseId,
    causal_attribution_established: !!causal_attribution_established,
    hypotheses,
  };
}

// ---------------------------------------------------------------------------
// GET /api/cases/:id/evidence-graph
// ---------------------------------------------------------------------------
app.get('/api/cases/:id/evidence-graph', async (req, res) => {
  const casePath = path.join(CASES_DIR, req.params.id);
  try {
    await fs.promises.access(casePath);
  } catch (_) {
    return apiError(res, 'CASE_NOT_FOUND', `Case not found: ${req.params.id}`, 404);
  }

  let rows;
  try {
    rows = await parseEvidenceCSV(req.params.id);
  } catch (err) {
    if (err && err.status === 404) {
      return apiError(res, 'CASE_NOT_FOUND', `Case not found: ${req.params.id}`, 404);
    }
    return handleForensicError(res, err);
  }

  res.json(await buildEvidenceGraph(req.params.id, rows));
});

// ---------------------------------------------------------------------------
// GET /api/cases/:id/evidence/:evidenceId/provenance
// Returns the full provenance record for a single evidence ID:
//   - All 12 evidence fields from the timeline row
//   - hypothesis_relationships: entries from all four lists across all hypotheses
// EPHEMERIS records resolve with found: true and hypothesis_relationships: [].
// Unknown IDs return HTTP 404 with found: false.
// ---------------------------------------------------------------------------
app.get('/api/cases/:id/evidence/:evidenceId/provenance', async (req, res) => {
  const caseId = req.params.id;
  if (!await guardCaseExists(res, caseId)) return;

  let rows;
  try {
    rows = await parseEvidenceCSV(caseId);
  } catch (err) {
    if (err && err.status === 404) {
      return apiError(res, 'CASE_NOT_FOUND', `Case not found: ${caseId}`, 404);
    }
    return handleForensicError(res, err);
  }

  const graph = await buildEvidenceGraph(caseId, rows);
  const result = getEvidenceProvenance(caseId, req.params.evidenceId, rows, graph);

  if (!result.found) {
    return res.status(404).json({
      ...result,
      error_code:  'EVIDENCE_NOT_FOUND',
      status_code: 404,
    });
  }
  res.json(result);
});

// ---------------------------------------------------------------------------
// GET /api/cases/:id/forensic-analysis — full validated forensic pipeline
//
// Pipeline:
//   parseEvidenceCSV
//     → buildEvidenceGraph
//     → buildForensicAnalysis  (deterministic, Phase 4.2–4.3)
//     → generateAnalystNarrative  (AI or heuristic, validated A1–A10 + B1–B4)
//     → assembleValidatedForensicReport  (immutability gate, Phase 4.8)
//
// Returns a ValidatedForensicReport: all deterministic fields plus
// analyst_narrative from the AI layer.
// ---------------------------------------------------------------------------
app.get('/api/cases/:id/forensic-analysis', async (req, res) => {
  const caseId    = req.params.id;
  const casePath  = path.join(CASES_DIR, caseId);
  const pipelineT = startTimer();

  try {
    await fs.promises.access(casePath);
  } catch (_) {
    pipelineLog({ level: 'error', stage: PIPELINE_STAGES.PIPELINE_ERROR,
      case_id: caseId, error_code: 'CASE_NOT_FOUND', duration_ms: pipelineT() });
    return apiError(res, 'CASE_NOT_FOUND', `Case not found: ${caseId}`, 404);
  }

  let rows;
  try {
    const t = startTimer();
    rows = await parseEvidenceCSV(caseId);
    pipelineLog({ level: 'info', stage: PIPELINE_STAGES.EVIDENCE_INGESTION,
      case_id: caseId, evidence_count: rows.length, duration_ms: t() });
  } catch (err) {
    pipelineLog({ level: 'error', stage: PIPELINE_STAGES.PIPELINE_ERROR,
      case_id: caseId, error_code: err && err.status === 404 ? 'CASE_NOT_FOUND' : 'INTERNAL_FORENSIC_ERROR',
      duration_ms: pipelineT() });
    if (err && err.status === 404) {
      return apiError(res, 'CASE_NOT_FOUND', `Case not found: ${caseId}`, 404);
    }
    return handleForensicError(res, err);
  }

  try {
    const graphT   = startTimer();
    const [graph, caseMeta0] = await Promise.all([
      buildEvidenceGraph(caseId, rows),
      loadCaseMeta(caseId),
    ]);
    pipelineLog({ level: 'info', stage: PIPELINE_STAGES.EVIDENCE_GRAPH,
      case_id: caseId, hypothesis_count: graph.hypotheses.length, duration_ms: graphT() });

    const analysisT = startTimer();
    const analysis  = buildForensicAnalysis(caseId, graph, caseMeta0);
    pipelineLog({ level: 'info', stage: PIPELINE_STAGES.FORENSIC_ANALYSIS,
      case_id: caseId, hypothesis_count: analysis.hypotheses.length,
      causal_attribution_established: analysis.causal_attribution_established,
      duration_ms: analysisT() });

    const validIds  = new Set(rows.map((r) => r.evidence_id));

    const narrativeT = startTimer();
    const narrative  = await aiAnalyst.generateAnalystNarrative(analysis, validIds, graph);
    pipelineLog({ level: 'info', stage: PIPELINE_STAGES.AI_NARRATIVE,
      case_id: caseId, ai_mode: narrative.source, duration_ms: narrativeT() });

    const assemblyT = startTimer();
    const report    = assembleValidatedForensicReport(analysis, narrative);
    pipelineLog({ level: 'info', stage: PIPELINE_STAGES.REPORT_ASSEMBLY,
      case_id: caseId, duration_ms: assemblyT() });

    pipelineLog({ level: 'info', stage: PIPELINE_STAGES.PIPELINE_COMPLETE,
      case_id: caseId, total_duration_ms: pipelineT() });

    res.json(report);
  } catch (err) {
    const errorCode = err && err.name === 'ForensicAnalysisValidationError'
      ? 'FORENSIC_ANALYSIS_VALIDATION_ERROR' : 'INTERNAL_FORENSIC_ERROR';
    pipelineLog({ level: 'error', stage: PIPELINE_STAGES.PIPELINE_ERROR,
      case_id: caseId, error_code: errorCode, duration_ms: pipelineT() });
    return handleForensicError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/cases/:id/forensic-analysis/narrative — AI analyst explanation
// NOTE: this route must be registered before the generic :id/investigate route
//       so Express does not shadow the "narrative" segment as a param value.
// ---------------------------------------------------------------------------
app.get('/api/cases/:id/forensic-analysis/narrative', async (req, res) => {
  const caseId    = req.params.id;
  const casePath  = path.join(CASES_DIR, caseId);
  const pipelineT = startTimer();

  try {
    await fs.promises.access(casePath);
  } catch (_) {
    pipelineLog({ level: 'error', stage: PIPELINE_STAGES.PIPELINE_ERROR,
      case_id: caseId, error_code: 'CASE_NOT_FOUND', duration_ms: pipelineT() });
    return apiError(res, 'CASE_NOT_FOUND', `Case not found: ${caseId}`, 404);
  }

  let rows;
  try {
    const t = startTimer();
    rows = await parseEvidenceCSV(caseId);
    pipelineLog({ level: 'info', stage: PIPELINE_STAGES.EVIDENCE_INGESTION,
      case_id: caseId, evidence_count: rows.length, duration_ms: t() });
  } catch (err) {
    pipelineLog({ level: 'error', stage: PIPELINE_STAGES.PIPELINE_ERROR,
      case_id: caseId, error_code: err && err.status === 404 ? 'CASE_NOT_FOUND' : 'INTERNAL_FORENSIC_ERROR',
      duration_ms: pipelineT() });
    if (err && err.status === 404) {
      return apiError(res, 'CASE_NOT_FOUND', `Case not found: ${caseId}`, 404);
    }
    return handleForensicError(res, err);
  }

  try {
    const validIds  = new Set(rows.map((r) => r.evidence_id));

    const graphT  = startTimer();
    const [graph, caseMeta1] = await Promise.all([
      buildEvidenceGraph(caseId, rows),
      loadCaseMeta(caseId),
    ]);
    pipelineLog({ level: 'info', stage: PIPELINE_STAGES.EVIDENCE_GRAPH,
      case_id: caseId, hypothesis_count: graph.hypotheses.length, duration_ms: graphT() });

    const analysisT = startTimer();
    const analysis  = buildForensicAnalysis(caseId, graph, caseMeta1);
    pipelineLog({ level: 'info', stage: PIPELINE_STAGES.FORENSIC_ANALYSIS,
      case_id: caseId, hypothesis_count: analysis.hypotheses.length,
      causal_attribution_established: analysis.causal_attribution_established,
      duration_ms: analysisT() });

    const narrativeT = startTimer();
    const narrative  = await aiAnalyst.generateAnalystNarrative(analysis, validIds, graph);
    pipelineLog({ level: 'info', stage: PIPELINE_STAGES.AI_NARRATIVE,
      case_id: caseId, ai_mode: narrative.source, duration_ms: narrativeT() });

    pipelineLog({ level: 'info', stage: PIPELINE_STAGES.PIPELINE_COMPLETE,
      case_id: caseId, total_duration_ms: pipelineT() });

    res.json(narrative);
  } catch (err) {
    const errorCode = err && err.name === 'ForensicAnalysisValidationError'
      ? 'FORENSIC_ANALYSIS_VALIDATION_ERROR' : 'INTERNAL_FORENSIC_ERROR';
    pipelineLog({ level: 'error', stage: PIPELINE_STAGES.PIPELINE_ERROR,
      case_id: caseId, error_code: errorCode, duration_ms: pipelineT() });
    return handleForensicError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/cases/:id/investigate — Pass 1: competing hypotheses + evidence graph
// ---------------------------------------------------------------------------
app.post('/api/cases/:id/investigate', async (req, res) => {
  const caseId = req.params.id;
  if (!await guardCaseExists(res, caseId)) return;

  let rows;
  try {
    rows = await parseEvidenceCSV(caseId);
  } catch (err) {
    if (err && err.status === 404) {
      return apiError(res, 'CASE_NOT_FOUND', `Case not found: ${caseId}`, 404);
    }
    return handleForensicError(res, err);
  }

  try {
    const result = await aiEngine.generateHypothesesPass(rows);
    res.json(result);
  } catch (err) {
    return handleForensicError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/cases/:id/challenge — Pass 2: red-team critique + updated confidence
// ---------------------------------------------------------------------------
app.post('/api/cases/:id/challenge', async (req, res) => {
  const caseId = req.params.id;
  if (!await guardCaseExists(res, caseId)) return;

  let rows;
  try {
    rows = await parseEvidenceCSV(caseId);
  } catch (err) {
    if (err && err.status === 404) {
      return apiError(res, 'CASE_NOT_FOUND', `Case not found: ${caseId}`, 404);
    }
    return handleForensicError(res, err);
  }

  try {
    // Pass 1 — identify the top-ranked hypothesis
    const pass1 = await aiEngine.generateHypothesesPass(rows);
    const topHypothesis = pass1.hypotheses[0];

    // Pass 2 — red-team the top hypothesis
    const pass2 = await aiEngine.redTeamChallengePass(topHypothesis, rows);

    res.json({
      case_id:          caseId,
      pass1_hypotheses: pass1.hypotheses,
      ...pass2,
    });
  } catch (err) {
    return handleForensicError(res, err);
  }
});

// ===========================================================================
// EVIDENCE EXPLORATION API — Phase 7.3
//
// Read-only navigation layer:
//   Case → Hypothesis → Evidence relationship → Evidence record → Provenance
//
// INVARIANTS:
//   EX-1  Evidence records are read-only.
//   EX-2  Every returned evidence item is traceable to an evidence_id from the CSV.
//   EX-3  Environmental context is always separated from supporting_evidence.
//   EX-4  Contradicting evidence is always separated.
//   EX-5  Non-discriminating evidence is always separated.
//   EX-6  EPHEMERIS records are never in hypothesis evidence lists.
//   EX-7  No temporal proximity inference — all relationships come from the graph.
//   EX-8  No numerical probabilities.
//   EX-9  Hypothesis assessments are read-only pass-throughs.
//   EX-10 Cross-case comparison is explicitly blocked.
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /api/cases/:id/hypotheses/:hid/evidence
//
// Evidence exploration view for a single hypothesis:
//   environmental_context, supporting_evidence, contradicting_evidence,
//   and non_discriminating_evidence as separate lists (EX-3, EX-4, EX-5).
//   Each entry carries the full 12-field evidence record (EX-2).
//   EPHEMERIS records are absent because they are excluded from all
//   hypothesis lists by buildEvidenceGraph (EX-6).
// ---------------------------------------------------------------------------
app.get('/api/cases/:id/hypotheses/:hid/evidence', async (req, res) => {
  const caseId = req.params.id;
  if (!await guardCaseExists(res, caseId)) return;

  let rows;
  try {
    rows = await parseEvidenceCSV(caseId);
  } catch (err) {
    if (err && err.status === 404) {
      return apiError(res, 'CASE_NOT_FOUND', `Case not found: ${caseId}`, 404);
    }
    return handleForensicError(res, err);
  }

  const graph = await buildEvidenceGraph(caseId, rows);
  const hypothesis = graph.hypotheses.find((h) => h.hypothesis_id === req.params.hid);
  if (!hypothesis) {
    return apiError(res, 'HYPOTHESIS_NOT_FOUND',
      `Hypothesis not found: ${req.params.hid}`, 404);
  }

  const view = evidenceExploration.buildHypothesisEvidenceView(hypothesis, rows);
  return res.json(view);
});

// ---------------------------------------------------------------------------
// GET /api/cases/:id/evidence-index
//
// All evidence records referenced in the graph (across all hypotheses, all
// four lists), each annotated with its hypothesis_relationships.
// Supports the "Evidence record → Provenance" navigation tier.
// EPHEMERIS records are absent (EX-6).
// ---------------------------------------------------------------------------
app.get('/api/cases/:id/evidence-index', async (req, res) => {
  const caseId = req.params.id;
  if (!await guardCaseExists(res, caseId)) return;

  let rows;
  try {
    rows = await parseEvidenceCSV(caseId);
  } catch (err) {
    if (err && err.status === 404) {
      return apiError(res, 'CASE_NOT_FOUND', `Case not found: ${caseId}`, 404);
    }
    return handleForensicError(res, err);
  }

  const graph = await buildEvidenceGraph(caseId, rows);
  const index = evidenceExploration.buildCaseEvidenceIndex(graph, rows);
  return res.json({ case_id: caseId, evidence_count: index.length, evidence: index });
});

// ---------------------------------------------------------------------------
// GET /api/cases/:id/environmental-context
//
// Consolidated environmental context view: all unique evidence records that
// appear in any hypothesis's environmental_context list.
// Always carries the heuristic_window_note (EX-7, EX-8).
// ---------------------------------------------------------------------------
app.get('/api/cases/:id/environmental-context', async (req, res) => {
  const caseId = req.params.id;
  if (!await guardCaseExists(res, caseId)) return;

  let rows;
  try {
    rows = await parseEvidenceCSV(caseId);
  } catch (err) {
    if (err && err.status === 404) {
      return apiError(res, 'CASE_NOT_FOUND', `Case not found: ${caseId}`, 404);
    }
    return handleForensicError(res, err);
  }

  const graph   = await buildEvidenceGraph(caseId, rows);
  const summary = evidenceExploration.buildEnvironmentalContextSummary(graph, rows);
  return res.json({ case_id: caseId, ...summary });
});

// ---------------------------------------------------------------------------
// GET /api/cases/:id/hypotheses/compare
//
// Compare evidence profiles across hypotheses WITHIN THE SAME CASE.
// Cross-case comparison is explicitly blocked (EX-10).
//
// Query parameters:
//   hypothesis_ids — comma-separated list of hypothesis IDs to compare.
//                    If omitted, all hypotheses in the case are compared.
//
// Returns: shared_evidence, exclusive_evidence, per-hypothesis evidence counts.
// Assessments are read-only (EX-9).  No probabilities (EX-8).
// ---------------------------------------------------------------------------
app.get('/api/cases/:id/hypotheses/compare', async (req, res) => {
  const caseId = req.params.id;
  if (!await guardCaseExists(res, caseId)) return;

  let rows;
  try {
    rows = await parseEvidenceCSV(caseId);
  } catch (err) {
    if (err && err.status === 404) {
      return apiError(res, 'CASE_NOT_FOUND', `Case not found: ${caseId}`, 404);
    }
    return handleForensicError(res, err);
  }

  const graph = await buildEvidenceGraph(caseId, rows);

  // Parse optional hypothesis_ids query param.
  let hypothesisIds = [];
  if (req.query.hypothesis_ids) {
    hypothesisIds = req.query.hypothesis_ids
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const result = evidenceExploration.compareHypothesesEvidence(graph, rows, hypothesisIds);

  if (result.error_code) {
    return apiError(res, result.error_code, result.error, 404);
  }

  return res.json(result);
});

// ===========================================================================
// INVESTIGATION WORKSPACE API — Phase 7.2
//
// All routes below belong to the Investigation operational layer.
//
// BOUNDARY INVARIANTS:
//   INV-7  No investigation route passes investigation state into
//          buildForensicAnalysis, buildEvidenceGraph, or generateAnalystNarrative.
//   INV-2  Fabricated evidence_ids are rejected at write time (422).
//   INV-3  Challenges cannot set assessment or causal_attribution_established.
//   INV-4  Decisions cannot alter causal_attribution_established.
//   INV-8  Closed investigations reject write operations (409).
//   INV-9  investigation_id is always server-generated.
// ===========================================================================

// ---------------------------------------------------------------------------
// Helper: assert that a case directory exists.
// Returns true if it does; sends the standard 404 and returns false if not.
// ---------------------------------------------------------------------------
async function guardCaseExists(res, caseId) {
  const casePath = path.join(CASES_DIR, caseId);
  try {
    await fs.promises.access(casePath);
    return true;
  } catch (_) {
    apiError(res, 'CASE_NOT_FOUND', `Case not found: ${caseId}`, 404);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helper: load case.json metadata asynchronously.
// Returns the parsed object, or null if the file cannot be read.
// Never throws — callers treat null as "metadata unavailable".
// ---------------------------------------------------------------------------
async function loadCaseMeta(caseId) {
  try {
    const caseJsonPath = path.join(CASES_DIR, caseId, 'case.json');
    return JSON.parse(await fs.promises.readFile(caseJsonPath, 'utf8'));
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helper: load the set of valid evidence IDs for a case from its CSV.
// Returns a Set<string>, or sends a 404/500 and returns null on failure.
// ---------------------------------------------------------------------------
async function loadCaseEvidenceIds(res, caseId) {
  try {
    const rows = await parseEvidenceCSV(caseId);
    return new Set(rows.map((r) => r.evidence_id));
  } catch (err) {
    if (err && err.status === 404) {
      apiError(res, 'CASE_NOT_FOUND', `Case not found: ${caseId}`, 404);
    } else {
      apiError(res, 'INTERNAL_FORENSIC_ERROR',
        'An unexpected error occurred loading case evidence.', 500);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helper: load the set of valid hypothesis IDs for a case from hypotheses.json.
// Returns a Set<string>, or sends a 404/500 and returns null on failure.
// ---------------------------------------------------------------------------
async function loadCaseHypothesisIds(res, caseId) {
  const hypoPath = path.join(CASES_DIR, caseId, 'hypotheses.json');
  try {
    const hypoConfig = JSON.parse(await fs.promises.readFile(hypoPath, 'utf8'));
    return new Set((hypoConfig.hypotheses || []).map((h) => h.hypothesis_id));
  } catch (err) {
    if (err.code === 'ENOENT') {
      apiError(res, 'CASE_NOT_FOUND', `Case not found: ${caseId}`, 404);
    } else {
      apiError(res, 'INTERNAL_FORENSIC_ERROR',
        'An unexpected error occurred loading case hypotheses.', 500);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helper: assert that an investigation exists and belongs to the given case.
// Returns the record or null (and sends the appropriate error).
// Phase 8.7: made async so it correctly awaits the Postgres-backed store.
// ---------------------------------------------------------------------------
async function guardInvestigationBelongsToCase(res, caseId, investigationId) {
  let inv;
  try {
    inv = await investigationStore.getInvestigation(investigationId);
  } catch (err) {
    handlePersistenceError(res, err);
    return null;
  }
  if (!inv) {
    apiError(res, 'INVESTIGATION_NOT_FOUND',
      `Investigation not found: ${investigationId}`, 404);
    return null;
  }
  if (inv.case_id !== caseId) {
    apiError(res, 'INVESTIGATION_NOT_FOUND',
      `Investigation ${investigationId} does not belong to case ${caseId}`, 404);
    return null;
  }
  return inv;
}

// ---------------------------------------------------------------------------
// Helper: assert that an investigation is open (not closed).
// Returns true if open; sends 409 and returns false if closed.
// ---------------------------------------------------------------------------
function guardInvestigationOpen(res, inv) {
  if (inv.status === 'closed') {
    apiError(res, 'INVESTIGATION_CLOSED',
      'Investigation is closed. Re-open it before making changes.', 409);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// POST /api/cases/:id/investigations
// Create (open) a new investigation for a case.
// ---------------------------------------------------------------------------
app.post('/api/cases/:id/investigations', async (req, res) => {
  const caseId = req.params.id;
  if (!await guardCaseExists(res, caseId)) return;

  const { title, opened_by, description } = req.body || {};

  let record;
  try {
    record = await investigationStore.createInvestigation({
      case_id: caseId,
      title,
      opened_by,
      description,
    });
  } catch (err) {
    return handlePersistenceError(res, err);
  }

  return res.status(201).json(record);
});

// ---------------------------------------------------------------------------
// GET /api/cases/:id/investigations
// List all investigations for a case.
// ---------------------------------------------------------------------------
app.get('/api/cases/:id/investigations', async (req, res) => {
  const caseId = req.params.id;
  if (!await guardCaseExists(res, caseId)) return;

  let list;
  try {
    list = await investigationStore.getInvestigationsForCase(caseId);
  } catch (err) {
    return handlePersistenceError(res, err);
  }
  return res.json(list);
});

// ---------------------------------------------------------------------------
// GET /api/cases/:id/investigations/:iid
// Retrieve a specific investigation.
// ---------------------------------------------------------------------------
app.get('/api/cases/:id/investigations/:iid', async (req, res) => {
  const caseId = req.params.id;
  if (!await guardCaseExists(res, caseId)) return;

  const inv = await guardInvestigationBelongsToCase(res, caseId, req.params.iid);
  if (!inv) return;

  return res.json(inv);
});

// ---------------------------------------------------------------------------
// PATCH /api/cases/:id/investigations/:iid
// Update investigation status (open / suspended / closed).
// ---------------------------------------------------------------------------
app.patch('/api/cases/:id/investigations/:iid', async (req, res) => {
  const caseId = req.params.id;
  if (!await guardCaseExists(res, caseId)) return;

  const inv = await guardInvestigationBelongsToCase(res, caseId, req.params.iid);
  if (!inv) return;

  const { status, actor, reason } = req.body || {};
  if (!status) {
    return apiError(res, 'VALIDATION_ERROR', 'status is required.', 422);
  }

  let result;
  try {
    result = await investigationStore.updateInvestigationStatus(req.params.iid, {
      status, actor, reason,
    });
  } catch (err) {
    return handlePersistenceError(res, err);
  }

  if (!result.ok) {
    const httpStatus = result.status_code || 422;
    return apiError(res, result.status_code === 409 ? 'INVESTIGATION_CLOSED' : 'VALIDATION_ERROR',
      result.error, httpStatus);
  }

  return res.json(result.record);
});

// ---------------------------------------------------------------------------
// GET /api/cases/:id/investigations/:iid/forensic-analysis
// Returns the live forensic analysis for the case associated with this
// investigation.  The forensic pipeline is invoked fresh — NO investigation
// state is passed into the pipeline (INV-7).
// ---------------------------------------------------------------------------
app.get('/api/cases/:id/investigations/:iid/forensic-analysis', async (req, res) => {
  const caseId = req.params.id;
  if (!await guardCaseExists(res, caseId)) return;

  const inv = await guardInvestigationBelongsToCase(res, caseId, req.params.iid);
  if (!inv) return;

  try {
    const rows     = await parseEvidenceCSV(caseId);
    // INV-7: graph and analysis receive ONLY rows derived from the CSV — no
    // investigation state, observations, or challenges are passed in.
    const [graph, caseMeta2] = await Promise.all([
      buildEvidenceGraph(caseId, rows),
      loadCaseMeta(caseId),
    ]);
    const analysis = buildForensicAnalysis(caseId, graph, caseMeta2);
    const validIds = new Set(rows.map((r) => r.evidence_id));
    const narrative = await aiAnalyst.generateAnalystNarrative(analysis, validIds, graph);
    const report    = assembleValidatedForensicReport(analysis, narrative);
    return res.json(report);
  } catch (err) {
    return handleForensicError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/cases/:id/investigations/:iid/evidence-graph
// Returns the live evidence graph for the case — read-only, no investigation
// state passed into the pipeline (INV-7).
// ---------------------------------------------------------------------------
app.get('/api/cases/:id/investigations/:iid/evidence-graph', async (req, res) => {
  const caseId = req.params.id;
  if (!await guardCaseExists(res, caseId)) return;

  const inv = await guardInvestigationBelongsToCase(res, caseId, req.params.iid);
  if (!inv) return;

  try {
    const rows  = await parseEvidenceCSV(caseId);
    const graph = await buildEvidenceGraph(caseId, rows);
    return res.json(graph);
  } catch (err) {
    return handleForensicError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/cases/:id/investigations/:iid/state
// Returns the current investigation state: status + observations + challenges
// (no forensic pipeline data — that is fetched separately).
// ---------------------------------------------------------------------------
app.get('/api/cases/:id/investigations/:iid/state', async (req, res) => {
  const caseId = req.params.id;
  if (!await guardCaseExists(res, caseId)) return;

  const inv = await guardInvestigationBelongsToCase(res, caseId, req.params.iid);
  if (!inv) return;

  let obs, chal;
  try {
    [obs, chal] = await Promise.all([
      investigationStore.getObservationsForInvestigation(req.params.iid),
      investigationStore.getChallengesForInvestigation(req.params.iid),
    ]);
  } catch (err) {
    return handlePersistenceError(res, err);
  }

  return res.json({
    investigation_id: inv.investigation_id,
    case_id:          inv.case_id,
    status:           inv.status,
    title:            inv.title,
    opened_by:        inv.opened_by,
    opened_at:        inv.opened_at,
    observation_count: obs.length,
    challenge_count:   chal.length,
    observations: obs.map((o) => ({
      observation_id:  o.observation_id,
      authored_by:     o.authored_by,
      authored_at:     o.authored_at,
      status:          o.status,
      current_text:    o.versions[o.versions.length - 1].text,
      evidence_ids:    o.evidence_ids,
      hypothesis_ids:  o.hypothesis_ids,
    })),
    challenges: chal.map((c) => ({
      challenge_id: c.challenge_id,
      target_type:  c.target_type,
      target_id:    c.target_id,
      authored_by:  c.authored_by,
      authored_at:  c.authored_at,
      status:       c.status,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /api/cases/:id/investigations/:iid/observations
// Record an analyst observation.
//
// Validates:
//   - investigation exists and is open (INV-8)
//   - evidence_ids belong to this case's CSV (INV-2, ID-2, ID-4)
//   - hypothesis_ids belong to this case's hypotheses.json (ID-3, ID-5)
// ---------------------------------------------------------------------------
app.post('/api/cases/:id/investigations/:iid/observations', async (req, res) => {
  const caseId = req.params.id;
  if (!await guardCaseExists(res, caseId)) return;

  const inv = await guardInvestigationBelongsToCase(res, caseId, req.params.iid);
  if (!inv) return;

  if (!guardInvestigationOpen(res, inv)) return;

  const { text, authored_by, evidence_ids, hypothesis_ids } = req.body || {};

  if (!text || typeof text !== 'string' || text.trim() === '') {
    return apiError(res, 'VALIDATION_ERROR', 'text is required and must be a non-empty string.', 422);
  }

  // Validate evidence_ids against this case's CSV (INV-2, ID-2, ID-4).
  if (Array.isArray(evidence_ids) && evidence_ids.length > 0) {
    const validEvidenceIds = await loadCaseEvidenceIds(res, caseId);
    if (!validEvidenceIds) return;
    for (const eid of evidence_ids) {
      if (!validEvidenceIds.has(eid)) {
        return apiError(res, 'INVALID_EVIDENCE_ID',
          `evidence_id "${eid}" does not exist in case ${caseId}. Fabricated IDs are not permitted.`,
          422);
      }
    }
  }

  // Validate hypothesis_ids against this case's hypotheses.json (ID-3, ID-5).
  if (Array.isArray(hypothesis_ids) && hypothesis_ids.length > 0) {
    const validHypothesisIds = await loadCaseHypothesisIds(res, caseId);
    if (!validHypothesisIds) return;
    for (const hid of hypothesis_ids) {
      if (!validHypothesisIds.has(hid)) {
        return apiError(res, 'INVALID_HYPOTHESIS_ID',
          `hypothesis_id "${hid}" does not exist in case ${caseId}. Fabricated IDs are not permitted.`,
          422);
      }
    }
  }

  let record;
  try {
    record = await investigationStore.createObservation({
      investigation_id: req.params.iid,
      text,
      authored_by,
      evidence_ids,
      hypothesis_ids,
    });
  } catch (err) {
    return handlePersistenceError(res, err);
  }

  return res.status(201).json(record);
});

// ---------------------------------------------------------------------------
// GET /api/cases/:id/investigations/:iid/observations/:oid
// Retrieve an observation (including full version history).
// ---------------------------------------------------------------------------
app.get('/api/cases/:id/investigations/:iid/observations/:oid', async (req, res) => {
  const caseId = req.params.id;
  if (!await guardCaseExists(res, caseId)) return;

  const inv = await guardInvestigationBelongsToCase(res, caseId, req.params.iid);
  if (!inv) return;

  let obs;
  try {
    obs = await investigationStore.getObservation(req.params.oid);
  } catch (err) {
    return handlePersistenceError(res, err);
  }
  if (!obs || obs.investigation_id !== req.params.iid) {
    return apiError(res, 'OBSERVATION_NOT_FOUND',
      `Observation not found: ${req.params.oid}`, 404);
  }

  return res.json(obs);
});

// ---------------------------------------------------------------------------
// Helper: validate a challenge body and return validated fields, or respond
// with the appropriate error.  Returns null if a response was already sent.
// ---------------------------------------------------------------------------
async function validateChallengeBody(res, caseId, body) {
  body = body || {};

  // CH-7 / INV-3 / INV-4: reject forbidden forensic fields.
  if ('assessment' in body || 'causal_attribution_established' in body) {
    apiError(res, 'FORENSIC_FIELD_IMMUTABLE',
      'Challenges cannot set assessment or causal_attribution_established. ' +
      'These are deterministic forensic fields and are not mutable through the investigation API.',
      422);
    return null;
  }

  const {
    target_type,
    target_id,
    authored_by,
    evidence_ids,
  } = body;
  // Accept both 'analyst_statement' (Phase 7.4 canonical) and 'rationale'
  // (Phase 7.2 backward-compatibility alias) so existing tests are unaffected.
  const analyst_statement = body.analyst_statement || body.rationale;

  if (!target_type) {
    apiError(res, 'VALIDATION_ERROR', 'target_type is required.', 422);
    return null;
  }
  // Validate target_type vocabulary.
  if (!investigationStore.CHALLENGE_TARGET_TYPES.has(target_type)) {
    apiError(res, 'VALIDATION_ERROR',
      `Invalid target_type "${target_type}". Allowed: ${[...investigationStore.CHALLENGE_TARGET_TYPES].join(', ')}.`,
      422);
    return null;
  }
  if (!target_id || typeof target_id !== 'string' || target_id.trim() === '') {
    apiError(res, 'VALIDATION_ERROR', 'target_id is required and must be a non-empty string.', 422);
    return null;
  }
  if (!analyst_statement || typeof analyst_statement !== 'string' || analyst_statement.trim() === '') {
    apiError(res, 'VALIDATION_ERROR', 'analyst_statement is required and must be a non-empty string.', 422);
    return null;
  }

  // CH-8: prohibit numerical probability claims in analyst_statement.
  if (/\b\d+(\.\d+)?\s*%|\b(probability|confidence|likelihood)\s*(of|is|=|:)\s*\d/i.test(analyst_statement)) {
    apiError(res, 'PROBABILITY_CLAIM_PROHIBITED',
      'analyst_statement must not contain numerical probability claims or percentages. ' +
      'Use qualitative language only.',
      422);
    return null;
  }

  // For hypothesis_assessment challenges, validate target_id against case hypotheses.
  if (target_type === 'hypothesis_assessment') {
    const validHypothesisIds = await loadCaseHypothesisIds(res, caseId);
    if (!validHypothesisIds) return null;
    if (!validHypothesisIds.has(target_id)) {
      apiError(res, 'INVALID_HYPOTHESIS_ID',
        `hypothesis_id "${target_id}" does not exist in case ${caseId}. Fabricated IDs are not permitted.`,
        422);
      return null;
    }
  }

  // For evidence_classification challenges, validate target_id against case CSV.
  if (target_type === 'evidence_classification') {
    const validEvidenceIds = await loadCaseEvidenceIds(res, caseId);
    if (!validEvidenceIds) return null;
    if (!validEvidenceIds.has(target_id)) {
      apiError(res, 'INVALID_EVIDENCE_ID',
        `evidence_id "${target_id}" does not exist in case ${caseId}. Fabricated IDs are not permitted.`,
        422);
      return null;
    }
  }

  // Validate supporting evidence_ids against this case's CSV.
  if (Array.isArray(evidence_ids) && evidence_ids.length > 0) {
    const validEvidenceIds = await loadCaseEvidenceIds(res, caseId);
    if (!validEvidenceIds) return null;
    for (const eid of evidence_ids) {
      if (!validEvidenceIds.has(eid)) {
        apiError(res, 'INVALID_EVIDENCE_ID',
          `evidence_id "${eid}" does not exist in case ${caseId}. Fabricated IDs are not permitted.`,
          422);
        return null;
      }
    }
  }

  return { target_type, target_id, authored_by, analyst_statement, evidence_ids };
}

// ---------------------------------------------------------------------------
// POST /api/cases/:id/investigations/:iid/challenges
// Record an analyst challenge.
//
// Required fields: target_type, target_id, analyst_statement
// Optional fields: authored_by, evidence_ids[]
//
// Allowed target_type values (CH-2):
//   hypothesis_assessment | evidence_classification | limitation |
//   missing_evidence | additional_investigation
//
// Validates:
//   - investigation exists and is open (INV-8)
//   - target_id resolves against this case (ID-3 for hypotheses, ID-2 for evidence)
//   - body must NOT set assessment or causal_attribution_established (INV-3, INV-4, CH-7)
//   - analyst_statement must not contain numerical probability claims (CH-8)
//   - evidence_ids cited as justification must belong to this case (INV-2, ID-2)
// ---------------------------------------------------------------------------
app.post('/api/cases/:id/investigations/:iid/challenges', async (req, res) => {
  const caseId = req.params.id;
  if (!await guardCaseExists(res, caseId)) return;

  const inv = await guardInvestigationBelongsToCase(res, caseId, req.params.iid);
  if (!inv) return;

  if (!guardInvestigationOpen(res, inv)) return;

  const fields = await validateChallengeBody(res, caseId, req.body);
  if (!fields) return;

  let result;
  try {
    result = await investigationStore.createChallenge({
      investigation_id: req.params.iid,
      case_id:          caseId,   // CH-1
      target_type:      fields.target_type,
      target_id:        fields.target_id,
      authored_by:      fields.authored_by,
      analyst_statement: fields.analyst_statement,
      evidence_ids:     fields.evidence_ids,
    });
  } catch (err) {
    return handlePersistenceError(res, err);
  }

  if (!result.ok) {
    return apiError(res, 'VALIDATION_ERROR', result.error, result.status_code || 422);
  }

  return res.status(201).json(result.record);
});

// ---------------------------------------------------------------------------
// GET /api/cases/:id/investigations/:iid/challenges
// List all challenges for an investigation.
// ---------------------------------------------------------------------------
app.get('/api/cases/:id/investigations/:iid/challenges', async (req, res) => {
  const caseId = req.params.id;
  if (!await guardCaseExists(res, caseId)) return;

  const inv = await guardInvestigationBelongsToCase(res, caseId, req.params.iid);
  if (!inv) return;

  let list;
  try {
    list = await investigationStore.getChallengesForInvestigation(req.params.iid);
  } catch (err) {
    return handlePersistenceError(res, err);
  }
  return res.json(list);
});

// ---------------------------------------------------------------------------
// GET /api/cases/:id/investigations/:iid/challenges/:cid
// Retrieve a challenge (including lifecycle log and resolution_metadata).
// ---------------------------------------------------------------------------
app.get('/api/cases/:id/investigations/:iid/challenges/:cid', async (req, res) => {
  const caseId = req.params.id;
  if (!await guardCaseExists(res, caseId)) return;

  const inv = await guardInvestigationBelongsToCase(res, caseId, req.params.iid);
  if (!inv) return;

  let chal;
  try {
    chal = await investigationStore.getChallenge(req.params.cid);
  } catch (err) {
    return handlePersistenceError(res, err);
  }
  if (!chal || chal.investigation_id !== req.params.iid) {
    return apiError(res, 'CHALLENGE_NOT_FOUND',
      `Challenge not found: ${req.params.cid}`, 404);
  }

  return res.json(chal);
});

// ---------------------------------------------------------------------------
// PATCH /api/cases/:id/investigations/:iid/challenges/:cid
// Transition a challenge through its lifecycle (CH-4).
//
// Body:
//   status             — 'under_review' | 'resolved' | 'rejected'
//   actor              — who is performing the transition
//   notes              — optional free-text notes
//   resolution_outcome — required when status = 'resolved'
//                        one of: 'acknowledged' | 'will_not_fix' | 'escalated'
//
// INVARIANT (CH-3): This endpoint NEVER modifies any forensic analysis field.
//   Resolution records the outcome without altering evidence, IDs, or assessments.
// ---------------------------------------------------------------------------
app.patch('/api/cases/:id/investigations/:iid/challenges/:cid', async (req, res) => {
  const caseId = req.params.id;
  if (!await guardCaseExists(res, caseId)) return;

  const inv = await guardInvestigationBelongsToCase(res, caseId, req.params.iid);
  if (!inv) return;

  let chal;
  try {
    chal = await investigationStore.getChallenge(req.params.cid);
  } catch (err) {
    return handlePersistenceError(res, err);
  }
  if (!chal || chal.investigation_id !== req.params.iid) {
    return apiError(res, 'CHALLENGE_NOT_FOUND',
      `Challenge not found: ${req.params.cid}`, 404);
  }

  const { status, actor, notes, resolution_outcome } = req.body || {};

  if (!status) {
    return apiError(res, 'VALIDATION_ERROR', 'status is required.', 422);
  }

  // CH-7: block any attempt to embed forbidden forensic fields in the transition body.
  if (req.body && (
    'assessment' in req.body ||
    'causal_attribution_established' in req.body
  )) {
    return apiError(res, 'FORENSIC_FIELD_IMMUTABLE',
      'Challenge transitions cannot set assessment or causal_attribution_established.',
      422);
  }

  let result;
  try {
    result = await investigationStore.transitionChallenge(req.params.cid, {
      status,
      actor,
      notes,
      resolution_outcome,
    });
  } catch (err) {
    return handlePersistenceError(res, err);
  }

  if (!result.ok) {
    const code = result.status_code === 409 ? 'CHALLENGE_TERMINAL' : 'VALIDATION_ERROR';
    return apiError(res, code, result.error, result.status_code || 422);
  }

  return res.json(result.record);
});

// ---------------------------------------------------------------------------
// GET /api/cases/:id/challenges
// List all challenges across all investigations for a case.
// Supports the "case-level challenge view" without requiring an investigation_id.
// ---------------------------------------------------------------------------
app.get('/api/cases/:id/challenges', async (req, res) => {
  const caseId = req.params.id;
  if (!await guardCaseExists(res, caseId)) return;

  let list;
  try {
    list = await investigationStore.getChallengesForCase(caseId);
  } catch (err) {
    return handlePersistenceError(res, err);
  }
  return res.json({ case_id: caseId, challenge_count: list.length, challenges: list });
});

// ---------------------------------------------------------------------------
// GET /api/cases/:id/investigations/:iid/summary
//
// Phase 7.5 — Unified Investigation Summary
//
// Assembles all nine named sections into one read-only document:
//
//   1. case_metadata         — from case.json (read-only)
//   2. investigation_state   — from investigationStore (read-only view)
//   3. forensic_conclusion   — deterministic pipeline output (causal flag, counts)
//   4. hypotheses            — full per-hypothesis analysis from the pipeline
//   5. evidence_references   — evidence IDs per hypothesis and per list type
//   6. provenance            — data sources + heuristic window note
//   7. limitations           — aggregated unique limitations from all hypotheses
//   8. ai_narrative          — validated AI/heuristic synthesis
//   9. analyst_challenges    — all challenges for this investigation
//
// INVARIANTS:
//   SUM-1  The forensic pipeline receives ZERO investigation state (INV-7).
//   SUM-2  No forensic field is mutated; this is a pure read and assemble.
//   SUM-3  Analyst challenges are scoped to this investigation_id only.
//   SUM-4  The response carries a generated_at timestamp and summary_version.
//   SUM-5  AI narrative is labelled with its source (heuristic | llm).
//   SUM-6  Observations are summarised by count only — full text is in /state
//          and /history to avoid duplicating large version arrays.
// ---------------------------------------------------------------------------
app.get('/api/cases/:id/investigations/:iid/summary', async (req, res) => {
  const caseId = req.params.id;
  if (!await guardCaseExists(res, caseId)) return;

  const inv = await guardInvestigationBelongsToCase(res, caseId, req.params.iid);
  if (!inv) return;

  // ── 1. Case metadata ──────────────────────────────────────────────────────
  let caseMeta;
  try {
    const caseJsonPath = path.join(CASES_DIR, caseId, 'case.json');
    caseMeta = JSON.parse(await fs.promises.readFile(caseJsonPath, 'utf8'));
  } catch (_) {
    return apiError(res, 'CASE_NOT_FOUND', `case.json not readable for ${caseId}`, 500);
  }

  // ── 2. Investigation state (read-only view) ───────────────────────────────
  let obs, chal;
  try {
    [obs, chal] = await Promise.all([
      investigationStore.getObservationsForInvestigation(req.params.iid),
      investigationStore.getChallengesForInvestigation(req.params.iid),
    ]);
  } catch (err) {
    return handlePersistenceError(res, err);
  }

  const investigationState = {
    investigation_id:  inv.investigation_id,
    case_id:           inv.case_id,
    status:            inv.status,
    title:             inv.title,
    description:       inv.description,
    opened_by:         inv.opened_by,
    opened_at:         inv.opened_at,
    observation_count: obs.length,
    challenge_count:   chal.length,
    events:            [...inv.events],
  };

  // ── Run the forensic pipeline (SUM-1: no investigation state passed in) ───
  let rows, graph, analysis, narrative, report;
  try {
    rows     = await parseEvidenceCSV(caseId);
    // SUM-1: graph receives ONLY CSV rows — no observations, no challenges.
    graph    = await buildEvidenceGraph(caseId, rows);
    analysis = buildForensicAnalysis(caseId, graph, caseMeta);
    const validIds = new Set(rows.map((r) => r.evidence_id));
    narrative = await aiAnalyst.generateAnalystNarrative(analysis, validIds, graph);
    report    = assembleValidatedForensicReport(analysis, narrative);
  } catch (err) {
    return handleForensicError(res, err);
  }

  // ── 3. Forensic conclusion ────────────────────────────────────────────────
  const forensicConclusion = {
    causal_attribution_established: report.causal_attribution_established,
    causal_attribution_statement:   caseMeta.causal_attribution || null,
    analysis_version:               report.analysis_version,
    evidence_summary:               report.evidence_summary,
    comparison:                     report.comparison,
  };

  // ── 4. Hypotheses ─────────────────────────────────────────────────────────
  // Include key_observations from the detailed hypothesis_comparison.
  const hypothesisKeyObsMap = new Map(
    (report.hypothesis_comparison || []).map((h) => [h.hypothesis_id, h.key_observations]),
  );
  const hypotheses = report.hypotheses.map((h) => ({
    hypothesis_id:    h.hypothesis_id,
    label:            h.label,
    assessment:       h.assessment,
    evidence_summary: h.evidence_summary,
    limitations:      h.limitations,
    heuristic_note:   h.heuristic_note,
    key_observations: hypothesisKeyObsMap.get(h.hypothesis_id) || [],
  }));

  // ── 5. Evidence references ────────────────────────────────────────────────
  const evidenceByHypothesis = report.hypotheses.map((h) => ({
    hypothesis_id:                   h.hypothesis_id,
    environmental_context_ids:       h.evidence_summary.environmental_context_ids,
    supporting_evidence_ids:         h.evidence_summary.supporting_evidence_ids,
    contradicting_evidence_ids:      h.evidence_summary.contradicting_evidence_ids,
    non_discriminating_evidence_ids: h.evidence_summary.non_discriminating_evidence_ids,
  }));

  // Unique referenced IDs across all hypotheses and all four lists.
  const referencedIds = new Set(
    evidenceByHypothesis.flatMap((h) => [
      ...h.environmental_context_ids,
      ...h.supporting_evidence_ids,
      ...h.contradicting_evidence_ids,
      ...h.non_discriminating_evidence_ids,
    ]),
  );

  const evidenceReferences = {
    total_evidence_rows:      rows.length,
    referenced_evidence_count: referencedIds.size,
    evidence_by_hypothesis:   evidenceByHypothesis,
  };

  // ── 6. Provenance ─────────────────────────────────────────────────────────
  // Read heuristic_window_note from hypotheses.json (best-effort).
  let heuristicWindowNote = null;
  try {
    const hypoPath  = path.join(CASES_DIR, caseId, 'hypotheses.json');
    const hypoConfig = JSON.parse(await fs.promises.readFile(hypoPath, 'utf8'));
    heuristicWindowNote = hypoConfig.heuristic_window_note || null;
  } catch (_) { /* non-fatal */ }

  const provenance = {
    data_sources:        caseMeta.data_sources || [],
    heuristic_window_note: heuristicWindowNote,
    evidence_count:      rows.length,
  };

  // ── 7. Limitations ────────────────────────────────────────────────────────
  // Already deduplicated by buildForensicAnalysis.
  const limitations = report.limitations;

  // ── 8. AI narrative ───────────────────────────────────────────────────────
  const aiNarrative = report.analyst_narrative;

  // ── 9. Analyst challenges ─────────────────────────────────────────────────
  let openCount = 0, underReviewCount = 0, resolvedCount = 0, rejectedCount = 0;
  for (const c of chal) {
    if (c.status === 'open')           openCount++;
    else if (c.status === 'under_review') underReviewCount++;
    else if (c.status === 'resolved')  resolvedCount++;
    else if (c.status === 'rejected')  rejectedCount++;
  }

  const analystChallenges = {
    challenge_count:    chal.length,
    open_count:         openCount,
    under_review_count: underReviewCount,
    resolved_count:     resolvedCount,
    rejected_count:     rejectedCount,
    challenges:         chal.map((c) => ({
      challenge_id:        c.challenge_id,
      target_type:         c.target_type,
      target_id:           c.target_id,
      analyst_statement:   c.analyst_statement,
      status:              c.status,
      authored_by:         c.authored_by,
      created_at:          c.created_at,
      evidence_ids:        c.evidence_ids,
      lifecycle:           c.lifecycle,
      resolution_metadata: c.resolution_metadata,
    })),
  };

  // ── Assemble and return ───────────────────────────────────────────────────
  return res.json({
    summary_version:     '1.0.0',
    generated_at:        new Date().toISOString(),
    case_metadata: {
      case_id:                caseMeta.case_id,
      title:                  caseMeta.title,
      description:            caseMeta.description,
      causal_attribution:     caseMeta.causal_attribution,
      anchor_event:           caseMeta.anchor_event,
      recovery_event:         caseMeta.recovery_event || null,
      target_asset:           caseMeta.target_asset   || null,
      data_window:            caseMeta.data_window     || null,
      data_sources:           caseMeta.data_sources    || [],
      scientific_limitations: caseMeta.scientific_limitations || [],
    },
    investigation_state:  investigationState,
    forensic_conclusion:  forensicConclusion,
    hypotheses,
    evidence_references:  evidenceReferences,
    provenance,
    limitations,
    ai_narrative:         aiNarrative,
    analyst_challenges:   analystChallenges,
  });
});

// ---------------------------------------------------------------------------
// GET /api/cases/:id/investigations/:iid/artifact
//
// Phase 7.5 — Auditable Investigation Artifact
//
// Produces a complete, schema-versioned, integrity-digested artifact that
// captures the full investigation state at the time of generation.
//
// Sections:
//   case_identity        — case.json identity fields (read-only)
//   investigation_identity — investigation record snapshot
//   forensic_analysis    — deterministic pipeline: assessments, evidence IDs,
//                          limitations (ART-3, ART-4, ART-5)
//   evidence_references  — evidence_id references only, never full rows (ART-1)
//   provenance           — data sources + heuristic window note (ART-7)
//   limitations          — aggregated deduped limitations
//   analyst_narrative    — AI synthesis, layer:"ai_synthesis" (ART-2)
//   analyst_content      — observations + challenges, layer:"analyst_created" (ART-9)
//   integrity            — SHA-256 digest of stable sections (ART-7)
//   artifact_metadata    — generated_at, generator (excluded from digest)
//
// INVARIANTS:
//   ART-INV-1  Forensic pipeline receives ZERO investigation state (INV-7).
//   ART-INV-2  artifact.integrity.digest is stable for identical inputs.
//   ART-INV-3  The artifact is validated before being returned; a 500 is
//              returned if validation fails (should never happen in practice).
// ---------------------------------------------------------------------------
app.get('/api/cases/:id/investigations/:iid/artifact', async (req, res) => {
  const caseId = req.params.id;
  if (!await guardCaseExists(res, caseId)) return;

  const inv = await guardInvestigationBelongsToCase(res, caseId, req.params.iid);
  if (!inv) return;

  // ── Read case.json ────────────────────────────────────────────────────────
  let caseMeta;
  try {
    const caseJsonPath = path.join(CASES_DIR, caseId, 'case.json');
    caseMeta = JSON.parse(await fs.promises.readFile(caseJsonPath, 'utf8'));
  } catch (_) {
    return apiError(res, 'CASE_NOT_FOUND', `case.json not readable for ${caseId}`, 500);
  }

  // ── Read heuristic_window_note (best-effort) ──────────────────────────────
  let heuristicWindowNote = null;
  try {
    const hypoPath  = path.join(CASES_DIR, caseId, 'hypotheses.json');
    const hypoConfig = JSON.parse(await fs.promises.readFile(hypoPath, 'utf8'));
    heuristicWindowNote = hypoConfig.heuristic_window_note || null;
  } catch (_) { /* non-fatal */ }

  // ── Run forensic pipeline (ART-INV-1: no investigation state passed in) ───
  let rows, graph, analysis, narrative, report;
  try {
    rows      = await parseEvidenceCSV(caseId);
    graph     = await buildEvidenceGraph(caseId, rows);
    analysis  = buildForensicAnalysis(caseId, graph, caseMeta);
    const validIds = new Set(rows.map((r) => r.evidence_id));
    narrative = await aiAnalyst.generateAnalystNarrative(analysis, validIds, graph);
    report    = assembleValidatedForensicReport(analysis, narrative);
  } catch (err) {
    return handleForensicError(res, err);
  }

  // ── Load investigation content ────────────────────────────────────────────
  let observations, challenges;
  try {
    observations = await investigationStore.getObservationsForInvestigation(req.params.iid);
    challenges   = await investigationStore.getChallengesForInvestigation(req.params.iid);
  } catch (err) {
    return handlePersistenceError(res, err);
  }

  // ── Assemble artifact ─────────────────────────────────────────────────────
  const artifact = artifactService.assembleArtifact({
    caseMeta,
    report,
    rows,
    heuristicWindowNote,
    investigation: inv,
    observations,
    challenges,
  });

  // ── Validate before returning (ART-INV-3) ─────────────────────────────────
  const { valid, errors: validationErrors } = artifactService.validateArtifact(artifact);
  if (!valid) {
    // This should never happen if assembleArtifact is correct.
    // Surface as an internal error without leaking violation details.
    return apiError(res, 'ARTIFACT_VALIDATION_ERROR',
      `Artifact validation failed with ${validationErrors.length} violation(s). This is an internal error.`,
      500);
  }

  // ── Suggest a filename for direct download ─────────────────────────────────
  const slug = `${caseId}-${req.params.iid.slice(0, 8)}`;
  res.setHeader('Content-Disposition', `attachment; filename="spaceforensics-artifact-${slug}.json"`);
  return res.json(artifact);
});

// ---------------------------------------------------------------------------
// GET /api/cases/:id/investigations/:iid/assistance
//
// Phase 7.6 — AI Analyst Investigation Assistance
//
// Runs the full forensic pipeline (investigation state never passed in — INV-7),
// assembles the same summary object used by /summary, and passes it to
// generateInvestigationAssistance.  Returns a validated assistance document.
//
// The AI assistance layer:
//   - summarises deterministic findings
//   - explains evidence relationships
//   - explains limitations in plain language
//   - identifies unanswered questions
//   - summarises analyst challenges
//   - suggests additional evidence categories
//   - identifies observation inconsistencies
//
// The AI CANNOT: modify evidence, change assessments, establish causality,
//   assign probabilities, or present env-context as mechanism confirmation.
//
// Falls back to the deterministic heuristic on any LLM/validation failure.
// ---------------------------------------------------------------------------
app.get('/api/cases/:id/investigations/:iid/assistance', async (req, res) => {
  const caseId = req.params.id;
  if (!await guardCaseExists(res, caseId)) return;

  const inv = await guardInvestigationBelongsToCase(res, caseId, req.params.iid);
  if (!inv) return;

  // ── Read case.json ────────────────────────────────────────────────────────
  let caseMeta;
  try {
    const caseJsonPath = path.join(CASES_DIR, caseId, 'case.json');
    caseMeta = JSON.parse(await fs.promises.readFile(caseJsonPath, 'utf8'));
  } catch (_) {
    return apiError(res, 'CASE_NOT_FOUND', `case.json not readable for ${caseId}`, 500);
  }

  // ── Read heuristic_window_note (best-effort) ──────────────────────────────
  let heuristicWindowNote = null;
  try {
    const hypoPath   = path.join(CASES_DIR, caseId, 'hypotheses.json');
    const hypoConfig = JSON.parse(await fs.promises.readFile(hypoPath, 'utf8'));
    heuristicWindowNote = hypoConfig.heuristic_window_note || null;
  } catch (_) { /* non-fatal */ }

  // ── Run forensic pipeline (INV-7: zero investigation state) ──────────────
  let rows, graph, analysis, narrative, report;
  try {
    rows      = await parseEvidenceCSV(caseId);
    graph     = await buildEvidenceGraph(caseId, rows);
    analysis  = buildForensicAnalysis(caseId, graph, caseMeta);
    const validIds = new Set(rows.map((r) => r.evidence_id));
    narrative = await aiAnalyst.generateAnalystNarrative(analysis, validIds, graph);
    report    = assembleValidatedForensicReport(analysis, narrative);
  } catch (err) {
    return handleForensicError(res, err);
  }

  // ── Assemble investigation summary (same shape as /summary) ──────────────
  let obs, chal;
  try {
    obs  = await investigationStore.getObservationsForInvestigation(req.params.iid);
    chal = await investigationStore.getChallengesForInvestigation(req.params.iid);
  } catch (err) {
    return handlePersistenceError(res, err);
  }

  // Reuse the same summary assembly logic as the /summary route.
  const hypothesisKeyObsMap = new Map(
    (report.hypothesis_comparison || []).map((h) => [h.hypothesis_id, h.key_observations]),
  );

  let openCount = 0, underReviewCount = 0, resolvedCount = 0, rejectedCount = 0;
  for (const c of chal) {
    if (c.status === 'open')              openCount++;
    else if (c.status === 'under_review') underReviewCount++;
    else if (c.status === 'resolved')     resolvedCount++;
    else if (c.status === 'rejected')     rejectedCount++;
  }

  const evidenceByHypothesis = report.hypotheses.map((h) => ({
    hypothesis_id:                   h.hypothesis_id,
    environmental_context_ids:       h.evidence_summary.environmental_context_ids,
    supporting_evidence_ids:         h.evidence_summary.supporting_evidence_ids,
    contradicting_evidence_ids:      h.evidence_summary.contradicting_evidence_ids,
    non_discriminating_evidence_ids: h.evidence_summary.non_discriminating_evidence_ids,
  }));
  const referencedIds = new Set(
    evidenceByHypothesis.flatMap((h) => [
      ...h.environmental_context_ids,
      ...h.supporting_evidence_ids,
      ...h.contradicting_evidence_ids,
      ...h.non_discriminating_evidence_ids,
    ]),
  );

  const investigationSummary = {
    case_metadata: {
      case_id:    caseMeta.case_id,
      title:      caseMeta.title,
      description: caseMeta.description || null,
      causal_attribution: caseMeta.causal_attribution || null,
      data_sources:           caseMeta.data_sources    || [],
      scientific_limitations: caseMeta.scientific_limitations || [],
    },
    investigation_state: {
      investigation_id:  inv.investigation_id,
      case_id:           inv.case_id,
      status:            inv.status,
      title:             inv.title,
      observation_count: obs.length,
      challenge_count:   chal.length,
    },
    forensic_conclusion: {
      causal_attribution_established: report.causal_attribution_established,
      causal_attribution_statement:   caseMeta.causal_attribution || null,
      analysis_version:               report.analysis_version,
      evidence_summary:               report.evidence_summary,
      comparison:                     report.comparison,
    },
    hypotheses: report.hypotheses.map((h) => ({
      hypothesis_id:    h.hypothesis_id,
      label:            h.label,
      assessment:       h.assessment,
      evidence_summary: h.evidence_summary,
      limitations:      h.limitations,
      heuristic_note:   h.heuristic_note,
      key_observations: hypothesisKeyObsMap.get(h.hypothesis_id) || [],
    })),
    evidence_references: {
      total_evidence_rows:       rows.length,
      referenced_evidence_count: referencedIds.size,
      referenced_evidence_ids:   [...referencedIds].sort(),
      evidence_by_hypothesis:    evidenceByHypothesis,
    },
    provenance: {
      data_sources:          caseMeta.data_sources || [],
      heuristic_window_note: heuristicWindowNote,
      evidence_count:        rows.length,
    },
    limitations: report.limitations,
    ai_narrative: report.analyst_narrative,
    analyst_challenges: {
      challenge_count:    chal.length,
      open_count:         openCount,
      under_review_count: underReviewCount,
      resolved_count:     resolvedCount,
      rejected_count:     rejectedCount,
      challenges: chal.map((c) => ({
        challenge_id:  c.challenge_id,
        target_type:   c.target_type,
        target_id:     c.target_id,
        status:        c.status,
        authored_by:   c.authored_by,
        created_at:    c.created_at,
        evidence_ids:  c.evidence_ids,
        lifecycle:     c.lifecycle,
        resolution_metadata: c.resolution_metadata,
      })),
    },
  };

  // ── Generate assistance (AI or heuristic fallback) ────────────────────────
  const assistance = await aiAnalyst.generateInvestigationAssistance(investigationSummary);

  return res.json({
    assistance_version:  '1.0.0',
    generated_at:        new Date().toISOString(),
    investigation_id:    inv.investigation_id,
    case_id:             caseId,
    ...assistance,
  });
});

// ---------------------------------------------------------------------------
// GET /api/cases/:id/investigations/:iid/history
// Returns the full audit trail: lifecycle events + observations (with version
// history) + challenges (with review history).
// ---------------------------------------------------------------------------
app.get('/api/cases/:id/investigations/:iid/history', async (req, res) => {
  const caseId = req.params.id;
  if (!await guardCaseExists(res, caseId)) return;

  const inv = await guardInvestigationBelongsToCase(res, caseId, req.params.iid);
  if (!inv) return;

  let history;
  try {
    history = await investigationStore.getInvestigationHistory(req.params.iid);
  } catch (err) {
    return handlePersistenceError(res, err);
  }

  // Add review_history as a backward-compat alias (Phase 7.2 HTTP contract).
  // The store exposes only `lifecycle`; the HTTP response exposes both so that
  // IW-12-5 (Phase 7.2 test) continues to pass alongside CU-HIS-2 (unit test).
  const responseHistory = {
    ...history,
    challenges: history.challenges.map((c) => ({
      ...c,
      review_history: c.lifecycle,
    })),
  };
  return res.json(responseHistory);
});

// ---------------------------------------------------------------------------
// Catch-all: unknown routes / unsupported methods
// Must be registered after all application routes.
// ---------------------------------------------------------------------------
app.use((req, res) => {
  return apiError(res, 'NOT_FOUND',
    `${req.method} ${req.path} is not a recognised API endpoint.`, 404);
});

// ---------------------------------------------------------------------------
// Global error handler — catches any error passed to next(err) that is not
// already handled inline, including the malformed-JSON SyntaxError that
// Express 5's body-parser propagates.
// Must be registered after all routes and the catch-all above.
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return apiError(res, 'INVALID_JSON',
      'Request body is not valid JSON.', 400);
  }
  if (err && err.type === 'entity.too.large') {
    return apiError(res, 'PAYLOAD_TOO_LARGE',
      'Request body exceeds the maximum allowed size.', 413);
  }
  // Log the real error for operator diagnostics — never surface it to callers.
  console.error('[server] unhandled error:', err && err.message ? err.message : String(err));
  return apiError(res, 'INTERNAL_ERROR',
    'An unexpected server error occurred.', 500);
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
module.exports = { app, parseEvidenceCSV, buildEvidenceGraph, buildForensicAnalysis, assembleValidatedForensicReport, getEvidenceProvenance, investigationStore, artifactService };
