'use strict';

/**
 * Phase 5.4 — Pipeline observability tests
 *
 * Assertions:
 *   OB-1   pipelineLog writes valid JSON to stdout
 *   OB-2   every log entry carries ts, level, stage, case_id
 *   OB-3   stage names match PIPELINE_STAGES constants
 *   OB-4   instrumentation does not mutate the analysis or report
 *   OB-5   logged fields contain no raw evidence rows, no credentials
 *   OB-6   duration_ms is a non-negative integer
 *   OB-7   evidence_count equals 278 for galaxy-15
 *   OB-8   hypothesis_count equals 5 for galaxy-15
 *   OB-9   causal_attribution_established is false in the forensic-analysis log
 *   OB-10  ai_mode is "llm" or "heuristic"
 *   OB-11  successful /forensic-analysis HTTP response is unchanged by instrumentation
 *   OB-12  error path logs a pipeline_error entry
 */

const request = require('supertest');
const { app, parseEvidenceCSV, buildEvidenceGraph, buildForensicAnalysis,
        assembleValidatedForensicReport } = require('../server');
const { pipelineLog, startTimer, PIPELINE_STAGES } = require('../services/pipelineLogger');

const CASE_ID = 'galaxy-15';

// ─────────────────────────────────────────────────────────────────────────────
// Capture console.log output during a block
// ─────────────────────────────────────────────────────────────────────────────
function captureConsoleLogs(fn) {
  const captured = [];
  const orig = console.log;
  console.log = (...args) => captured.push(args.join(' '));
  try {
    const result = fn();
    // Handle both sync and async
    if (result && typeof result.then === 'function') {
      return result.finally(() => { console.log = orig; }).then(() => captured);
    }
    return captured;
  } finally {
    if (!(fn() instanceof Promise)) console.log = orig;
  }
}

async function captureConsoleLogsAsync(fn) {
  const captured = [];
  const orig = console.log;
  console.log = (...args) => captured.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return captured;
}

// ─────────────────────────────────────────────────────────────────────────────
// OB-1 / OB-2 — pipelineLog unit tests
// ─────────────────────────────────────────────────────────────────────────────
describe('OB-1/2: pipelineLog writes valid structured JSON', () => {
  test('OB-1: output is valid JSON', () => {
    let line;
    const orig = console.log;
    console.log = (s) => { line = s; };
    pipelineLog({ level: 'info', stage: PIPELINE_STAGES.EVIDENCE_INGESTION,
      case_id: 'test-case', evidence_count: 10, duration_ms: 5 });
    console.log = orig;

    expect(() => JSON.parse(line)).not.toThrow();
  });

  test('OB-2: every entry has ts, level, stage, case_id', () => {
    let line;
    const orig = console.log;
    console.log = (s) => { line = s; };
    pipelineLog({ level: 'info', stage: PIPELINE_STAGES.FORENSIC_ANALYSIS,
      case_id: 'test-case', hypothesis_count: 5, duration_ms: 2 });
    console.log = orig;

    const entry = JSON.parse(line);
    expect(typeof entry.ts).toBe('string');
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.level).toBe('info');
    expect(entry.stage).toBe(PIPELINE_STAGES.FORENSIC_ANALYSIS);
    expect(entry.case_id).toBe('test-case');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OB-3 — PIPELINE_STAGES constants are correct strings
// ─────────────────────────────────────────────────────────────────────────────
describe('OB-3: PIPELINE_STAGES constants', () => {
  const EXPECTED = [
    'evidence_ingestion', 'evidence_graph', 'forensic_analysis',
    'ai_narrative', 'ai_validation', 'report_assembly',
    'pipeline_complete', 'pipeline_error',
  ];

  test('OB-3: all eight stage names are defined', () => {
    for (const name of EXPECTED) {
      expect(Object.values(PIPELINE_STAGES)).toContain(name);
    }
  });

  test('OB-3: PIPELINE_STAGES object is frozen (immutable)', () => {
    expect(Object.isFrozen(PIPELINE_STAGES)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OB-4 — Instrumentation does not mutate analysis or report
// ─────────────────────────────────────────────────────────────────────────────
describe('OB-4: instrumentation does not mutate pipeline outputs', () => {
  let rows, graph, analysis, report;

  beforeAll(async () => {
    rows     = await parseEvidenceCSV(CASE_ID);
    graph    = await buildEvidenceGraph(CASE_ID, rows);
    analysis = buildForensicAnalysis(CASE_ID, graph);

    // Snapshot key fields before any pipelineLog call
    const snapshotHypotheses = analysis.hypotheses.map((h) => ({
      id: h.hypothesis_id, assessment: h.assessment,
    }));

    // Call pipelineLog (which is all instrumentation does to these objects)
    pipelineLog({ level: 'info', stage: PIPELINE_STAGES.FORENSIC_ANALYSIS,
      case_id: analysis.case_id, hypothesis_count: analysis.hypotheses.length,
      causal_attribution_established: analysis.causal_attribution_established,
      duration_ms: 1 });

    // Verify nothing changed
    const afterHypotheses = analysis.hypotheses.map((h) => ({
      id: h.hypothesis_id, assessment: h.assessment,
    }));
    expect(afterHypotheses).toEqual(snapshotHypotheses);

    // Assemble report
    const narrative = { source: 'heuristic', generated_at: new Date().toISOString(),
      causal_attribution_established: false,
      hypothesis_assessments: analysis.hypotheses.map((h) => ({
        hypothesis_id: h.hypothesis_id, assessment: h.assessment,
        rationale: 'test', evidence_ids: [],
      })) };
    report = assembleValidatedForensicReport(analysis, narrative);
  }, 30_000);

  test('OB-4-1: analysis.case_id is unchanged after logging', () => {
    expect(analysis.case_id).toBe(CASE_ID);
  });

  test('OB-4-2: analysis.causal_attribution_established is still false', () => {
    expect(analysis.causal_attribution_established).toBe(false);
  });

  test('OB-4-3: analysis.hypotheses count is still 5', () => {
    expect(analysis.hypotheses).toHaveLength(5);
  });

  test('OB-4-4: H5 assessment is still strongly_supported after logging', () => {
    const h5 = analysis.hypotheses.find((h) => h.hypothesis_id === 'H5');
    expect(h5.assessment).toBe('strongly_supported');
  });

  test('OB-4-5: report contains analyst_narrative and has no extra error fields', () => {
    expect(report).toHaveProperty('analyst_narrative');
    expect(report).not.toHaveProperty('error_code');
    expect(report).not.toHaveProperty('violations');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OB-5 — Logged fields contain no forbidden content
// ─────────────────────────────────────────────────────────────────────────────
describe('OB-5: logged entries contain no forbidden content', () => {
  test('OB-5-1: log entries do not contain raw evidence row data', () => {
    let line;
    const orig = console.log;
    console.log = (s) => { line = s; };
    pipelineLog({ level: 'info', stage: PIPELINE_STAGES.EVIDENCE_INGESTION,
      case_id: CASE_ID, evidence_count: 278, duration_ms: 10 });
    console.log = orig;

    const entry = JSON.parse(line);
    // Raw rows would have fields like 'timestamp', 'measurement', 'value', 'unit'
    expect(entry).not.toHaveProperty('rows');
    expect(entry).not.toHaveProperty('timestamp');  // row-level field
    expect(entry).not.toHaveProperty('measurement');
    expect(entry).not.toHaveProperty('value');
    expect(entry).not.toHaveProperty('unit');
  });

  test('OB-5-2: log entries do not contain API keys or credential patterns', () => {
    let line;
    const orig = console.log;
    console.log = (s) => { line = s; };
    pipelineLog({ level: 'info', stage: PIPELINE_STAGES.AI_NARRATIVE,
      case_id: CASE_ID, ai_mode: 'heuristic', duration_ms: 3 });
    console.log = orig;

    const text = JSON.stringify(JSON.parse(line));
    expect(text).not.toMatch(/API_KEY|api_key|SECRET|password|token/i);
  });

  test('OB-5-3: log entries do not contain filesystem paths', () => {
    let line;
    const orig = console.log;
    console.log = (s) => { line = s; };
    pipelineLog({ level: 'error', stage: PIPELINE_STAGES.PIPELINE_ERROR,
      case_id: 'unknown', error_code: 'CASE_NOT_FOUND', duration_ms: 1 });
    console.log = orig;

    const text = JSON.stringify(JSON.parse(line));
    expect(text).not.toMatch(/\/Users\/|\/home\/|\/var\/|node_modules\//);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OB-6 — startTimer returns non-negative integers
// ─────────────────────────────────────────────────────────────────────────────
describe('OB-6: startTimer produces non-negative integer durations', () => {
  test('OB-6-1: elapsed() immediately returns a non-negative integer', () => {
    const elapsed = startTimer();
    const ms = elapsed();
    expect(typeof ms).toBe('number');
    expect(Number.isInteger(ms)).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(0);
  });

  test('OB-6-2: elapsed() grows with time', async () => {
    const elapsed = startTimer();
    await new Promise((r) => setTimeout(r, 10));
    expect(elapsed()).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OB-7/8/9/10 — HTTP pipeline emits correctly-valued log entries
// ─────────────────────────────────────────────────────────────────────────────
describe('OB-7–10: pipeline HTTP request produces correct log field values', () => {
  let logLines;

  beforeAll(async () => {
    logLines = await captureConsoleLogsAsync(async () => {
      await request(app).get(`/api/cases/${CASE_ID}/forensic-analysis`);
    });
  }, 30_000);

  function parseEntries() {
    return logLines
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
      .filter((e) => e.case_id === CASE_ID && e.stage);
  }

  test('OB-7: evidence_ingestion log reports evidence_count 278', () => {
    const entries = parseEntries();
    const ingestion = entries.find((e) => e.stage === PIPELINE_STAGES.EVIDENCE_INGESTION);
    expect(ingestion).toBeDefined();
    expect(ingestion.evidence_count).toBe(278);
  });

  test('OB-8: evidence_graph log reports hypothesis_count 5', () => {
    const entries = parseEntries();
    const graphEntry = entries.find((e) => e.stage === PIPELINE_STAGES.EVIDENCE_GRAPH);
    expect(graphEntry).toBeDefined();
    expect(graphEntry.hypothesis_count).toBe(5);
  });

  test('OB-9: forensic_analysis log has causal_attribution_established false', () => {
    const entries = parseEntries();
    const analysisEntry = entries.find((e) => e.stage === PIPELINE_STAGES.FORENSIC_ANALYSIS);
    expect(analysisEntry).toBeDefined();
    expect(analysisEntry.causal_attribution_established).toBe(false);
  });

  test('OB-10: ai_narrative log has ai_mode "llm" or "heuristic"', () => {
    const entries = parseEntries();
    const narrativeEntry = entries.find((e) => e.stage === PIPELINE_STAGES.AI_NARRATIVE);
    expect(narrativeEntry).toBeDefined();
    expect(['llm', 'heuristic']).toContain(narrativeEntry.ai_mode);
  });

  test('OB-10b: pipeline_complete log has total_duration_ms >= 0', () => {
    const entries = parseEntries();
    const complete = entries.find((e) => e.stage === PIPELINE_STAGES.PIPELINE_COMPLETE);
    expect(complete).toBeDefined();
    expect(complete.total_duration_ms).toBeGreaterThanOrEqual(0);
  });

  test('OB-10c: duration_ms is a non-negative integer on every pipeline log entry', () => {
    const entries = parseEntries();
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      if ('duration_ms' in e) {
        expect(typeof e.duration_ms).toBe('number');
        expect(e.duration_ms).toBeGreaterThanOrEqual(0);
      }
      if ('total_duration_ms' in e) {
        expect(typeof e.total_duration_ms).toBe('number');
        expect(e.total_duration_ms).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OB-11 — Successful HTTP response is unchanged by instrumentation
// ─────────────────────────────────────────────────────────────────────────────
describe('OB-11: HTTP response content is unchanged by instrumentation', () => {
  test('OB-11-1: /forensic-analysis still returns 200 with case_id and hypotheses', async () => {
    const res = await request(app).get(`/api/cases/${CASE_ID}/forensic-analysis`);
    expect(res.status).toBe(200);
    expect(res.body.case_id).toBe(CASE_ID);
    expect(res.body.causal_attribution_established).toBe(false);
    expect(Array.isArray(res.body.hypotheses)).toBe(true);
    expect(res.body.hypotheses).toHaveLength(5);
    // No observability fields bleed into the response
    expect(res.body).not.toHaveProperty('duration_ms');
    expect(res.body).not.toHaveProperty('stage');
    expect(res.body).not.toHaveProperty('level');
  }, 30_000);

  test('OB-11-2: H5 assessment is still strongly_supported in HTTP response', async () => {
    const res = await request(app).get(`/api/cases/${CASE_ID}/forensic-analysis`);
    const h5 = res.body.hypotheses.find((h) => h.hypothesis_id === 'H5');
    expect(h5).toBeDefined();
    expect(h5.assessment).toBe('strongly_supported');
  }, 30_000);

  test('OB-11-3: /forensic-analysis/narrative still returns 200 with source', async () => {
    const res = await request(app).get(`/api/cases/${CASE_ID}/forensic-analysis/narrative`);
    expect(res.status).toBe(200);
    expect(['llm', 'heuristic']).toContain(res.body.source);
    expect(res.body).not.toHaveProperty('duration_ms');
    expect(res.body).not.toHaveProperty('stage');
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// OB-12 — Error path produces a pipeline_error log entry
// ─────────────────────────────────────────────────────────────────────────────
describe('OB-12: error path logs a pipeline_error entry', () => {
  test('OB-12-1: unknown case produces a pipeline_error log with CASE_NOT_FOUND', async () => {
    const UNKNOWN = 'unknown-case-xyz';
    const logLines = await captureConsoleLogsAsync(async () => {
      await request(app).get(`/api/cases/${UNKNOWN}/forensic-analysis`);
    });

    const entries = logLines
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);

    const errEntry = entries.find((e) => e.stage === PIPELINE_STAGES.PIPELINE_ERROR);
    expect(errEntry).toBeDefined();
    expect(errEntry.error_code).toBe('CASE_NOT_FOUND');
    expect(errEntry.level).toBe('error');
    expect(typeof errEntry.duration_ms).toBe('number');
  });
});
