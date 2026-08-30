'use strict';

/**
 * Phase 5.8 — Forensic Pipeline Performance Baseline
 *
 * Measures execution time (ms) for each stage of the deterministic forensic
 * pipeline using Galaxy 15 as the baseline dataset.
 *
 * Stages measured:
 *   PERF-1   parseEvidenceCSV          — CSV read + provenance enrichment + sort
 *   PERF-2   buildEvidenceGraph        — evidence partitioning + graph construction
 *   PERF-3   buildForensicAnalysis     — deterministic analysis + validation
 *   PERF-4   buildAnalystHeuristicNarrative — heuristic narrative generation
 *   PERF-5   assembleValidatedForensicReport — immutability gate + report assembly
 *   PERF-6   Full pipeline end-to-end  — all five stages in sequence
 *
 * PERF-7   Repeatability — three independent full-pipeline runs produce
 *           byte-identical deterministic output.
 *
 * Metrics reported: average, median, min, max (all in milliseconds).
 *
 * After the suite completes, baseline numbers are written to:
 *   backend/tests/baseline.perf.json
 *
 * IMPORTANT: This file contains only measurement and repeatability tests.
 * No pipeline behavior is changed. No scientific classifications are altered.
 */

const fs   = require('fs');
const path = require('path');

const { parseEvidenceCSV, buildEvidenceGraph, buildForensicAnalysis,
        assembleValidatedForensicReport } = require('../server');
const { buildAnalystHeuristicNarrative } = require('../services/aiAnalyst');

const CASE_ID    = 'galaxy-15';
const ITERATIONS = 10;   // per-stage sample size
const BASELINE_PATH = path.join(__dirname, 'baseline.perf.json');

// ─────────────────────────────────────────────────────────────────────────────
// Timing utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Run fn() ITERATIONS times, return array of elapsed ms (float, 3 dp). */
function timeSync(fn) {
  const samples = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1_000_000);
  }
  return samples;
}

/** Run async fn() ITERATIONS times, return array of elapsed ms (float, 3 dp). */
async function timeAsync(fn) {
  const samples = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1_000_000);
  }
  return samples;
}

/** Compute {avg, median, min, max} from a samples array. All rounded to 3 dp. */
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum    = samples.reduce((s, v) => s + v, 0);
  const mid    = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  return {
    avg:    Math.round(sum / samples.length * 1000) / 1000,
    median: Math.round(median * 1000) / 1000,
    min:    Math.round(sorted[0] * 1000) / 1000,
    max:    Math.round(sorted[sorted.length - 1] * 1000) / 1000,
    samples: samples.map((v) => Math.round(v * 1000) / 1000),
  };
}

/** Format a stats object as a compact one-line string for console output. */
function fmtStats(label, s) {
  return `  ${label.padEnd(40)} avg=${String(s.avg).padStart(7)}ms  `
    + `med=${String(s.median).padStart(7)}ms  `
    + `min=${String(s.min).padStart(7)}ms  `
    + `max=${String(s.max).padStart(7)}ms`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared one-time warm-up fixture
// (builds the pipeline inputs ONCE before timing iterations)
// ─────────────────────────────────────────────────────────────────────────────
let warmRows;
let warmGraph;
let warmAnalysis;
let warmNarrative;

beforeAll(async () => {
  jest.setTimeout(120_000);
  // Single warm-up run — gives the JIT a chance to compile the hot paths
  // before measurement begins.
  warmRows     = await parseEvidenceCSV(CASE_ID);
  warmGraph    = await buildEvidenceGraph(CASE_ID, warmRows);
  warmAnalysis = buildForensicAnalysis(CASE_ID, warmGraph);
  warmNarrative = buildAnalystHeuristicNarrative(warmAnalysis);
}, 120_000);

// ─────────────────────────────────────────────────────────────────────────────
// Collected results — populated as each PERF test runs; written to file after all
// ─────────────────────────────────────────────────────────────────────────────
const results = {};

// ─────────────────────────────────────────────────────────────────────────────
// PERF-1 — parseEvidenceCSV
// ─────────────────────────────────────────────────────────────────────────────
test(`PERF-1: parseEvidenceCSV — ${ITERATIONS} iterations`, async () => {
  const samples = await timeAsync(() => parseEvidenceCSV(CASE_ID));
  const s = stats(samples);
  results['parseEvidenceCSV'] = s;

  // Correctness guard: the last parsed result must still have 278 records
  const lastRows = await parseEvidenceCSV(CASE_ID);
  expect(lastRows).toHaveLength(278);

  console.log(fmtStats('parseEvidenceCSV', s));

  // Sanity bound: parsing 278 rows should never exceed 2000 ms on any CI machine
  expect(s.max).toBeLessThan(2000);
}, 120_000);

// ─────────────────────────────────────────────────────────────────────────────
// PERF-2 — buildEvidenceGraph
// ─────────────────────────────────────────────────────────────────────────────
test(`PERF-2: buildEvidenceGraph — ${ITERATIONS} iterations`, async () => {
  const samples = await timeAsync(() => buildEvidenceGraph(CASE_ID, warmRows));
  const s = stats(samples);
  results['buildEvidenceGraph'] = s;

  console.log(fmtStats('buildEvidenceGraph', s));

  expect(s.max).toBeLessThan(1000);
}, 120_000);

// ─────────────────────────────────────────────────────────────────────────────
// PERF-3 — buildForensicAnalysis
// ─────────────────────────────────────────────────────────────────────────────
test(`PERF-3: buildForensicAnalysis — ${ITERATIONS} iterations`, () => {
  const samples = timeSync(() => buildForensicAnalysis(CASE_ID, warmGraph));
  const s = stats(samples);
  results['buildForensicAnalysis'] = s;

  console.log(fmtStats('buildForensicAnalysis', s));

  expect(s.max).toBeLessThan(1000);
});

// ─────────────────────────────────────────────────────────────────────────────
// PERF-4 — buildAnalystHeuristicNarrative
// ─────────────────────────────────────────────────────────────────────────────
test(`PERF-4: buildAnalystHeuristicNarrative — ${ITERATIONS} iterations`, () => {
  const samples = timeSync(() => buildAnalystHeuristicNarrative(warmAnalysis));
  const s = stats(samples);
  results['buildAnalystHeuristicNarrative'] = s;

  console.log(fmtStats('buildAnalystHeuristicNarrative', s));

  expect(s.max).toBeLessThan(500);
});

// ─────────────────────────────────────────────────────────────────────────────
// PERF-5 — assembleValidatedForensicReport
// ─────────────────────────────────────────────────────────────────────────────
test(`PERF-5: assembleValidatedForensicReport — ${ITERATIONS} iterations`, () => {
  const samples = timeSync(() =>
    assembleValidatedForensicReport(warmAnalysis, warmNarrative)
  );
  const s = stats(samples);
  results['assembleValidatedForensicReport'] = s;

  console.log(fmtStats('assembleValidatedForensicReport', s));

  expect(s.max).toBeLessThan(500);
});

// ─────────────────────────────────────────────────────────────────────────────
// PERF-6 — Full pipeline end-to-end
// ─────────────────────────────────────────────────────────────────────────────
test(`PERF-6: full pipeline end-to-end — ${ITERATIONS} iterations`, async () => {
  const samples = await timeAsync(async () => {
    const rows      = await parseEvidenceCSV(CASE_ID);
    const graph     = await buildEvidenceGraph(CASE_ID, rows);
    const analysis  = buildForensicAnalysis(CASE_ID, graph);
    const narrative = buildAnalystHeuristicNarrative(analysis);
    assembleValidatedForensicReport(analysis, narrative);
  });
  const s = stats(samples);
  results['fullPipeline'] = s;

  console.log(fmtStats('full pipeline end-to-end', s));

  // Full pipeline must complete in under 3 s per iteration on any CI machine
  expect(s.max).toBeLessThan(3000);
}, 120_000);

// ─────────────────────────────────────────────────────────────────────────────
// PERF-7 — Repeatability: three independent runs produce identical output
// ─────────────────────────────────────────────────────────────────────────────
test('PERF-7: three independent full-pipeline runs produce byte-identical deterministic output', async () => {
  /** Run the full pipeline once and return a fingerprint of all deterministic fields. */
  async function runAndFingerprint() {
    const rows     = await parseEvidenceCSV(CASE_ID);
    const graph    = await buildEvidenceGraph(CASE_ID, rows);
    const analysis = buildForensicAnalysis(CASE_ID, graph);
    const narrative = buildAnalystHeuristicNarrative(analysis);
    const report   = assembleValidatedForensicReport(analysis, narrative);

    // Extract only the deterministic fields — narrative.generated_at is excluded
    // because it contains the current timestamp.
    return JSON.stringify({
      case_id:                        report.case_id,
      analysis_version:               report.analysis_version,
      causal_attribution_established: report.causal_attribution_established,
      hypotheses: report.hypotheses.map((h) => ({
        hypothesis_id:  h.hypothesis_id,
        label:          h.label,
        assessment:     h.assessment,
        evidence_summary: {
          environmental_context_ids:        h.evidence_summary.environmental_context_ids,
          environmental_context_count:      h.evidence_summary.environmental_context_count,
          supporting_evidence_ids:          h.evidence_summary.supporting_evidence_ids,
          supporting_evidence_count:        h.evidence_summary.supporting_evidence_count,
          contradicting_evidence_ids:       h.evidence_summary.contradicting_evidence_ids,
          contradicting_evidence_count:     h.evidence_summary.contradicting_evidence_count,
          non_discriminating_evidence_ids:  h.evidence_summary.non_discriminating_evidence_ids,
          non_discriminating_evidence_count:h.evidence_summary.non_discriminating_evidence_count,
        },
      })),
      // Narrative assessments (timestamps excluded)
      narrative_assessments: report.analyst_narrative.hypothesis_assessments.map((ha) => ({
        hypothesis_id: ha.hypothesis_id,
        assessment:    ha.assessment,
      })),
      narrative_causal: report.analyst_narrative.causal_attribution_established,
    });
  }

  const [fp1, fp2, fp3] = await Promise.all([
    runAndFingerprint(),
    runAndFingerprint(),
    runAndFingerprint(),
  ]);

  expect(fp1).toBe(fp2);
  expect(fp1).toBe(fp3);
}, 120_000);

// ─────────────────────────────────────────────────────────────────────────────
// PERF-8 — Heap memory: pipeline does not allocate more than a safe ceiling
// ─────────────────────────────────────────────────────────────────────────────
test('PERF-8: full pipeline heap allocation stays within 50 MB above baseline', async () => {
  // Force GC before sampling if available (Node --expose-gc flag); skip if not.
  if (typeof global.gc === 'function') global.gc();

  const heapBefore = process.memoryUsage().heapUsed;

  const rows      = await parseEvidenceCSV(CASE_ID);
  const graph     = await buildEvidenceGraph(CASE_ID, rows);
  const analysis  = buildForensicAnalysis(CASE_ID, graph);
  const narrative = buildAnalystHeuristicNarrative(analysis);
  assembleValidatedForensicReport(analysis, narrative);

  const heapAfter = process.memoryUsage().heapUsed;
  const deltaMB   = (heapAfter - heapBefore) / (1024 * 1024);

  results['heapDeltaMB'] = Math.round(deltaMB * 100) / 100;
  console.log(`  heap delta: ${deltaMB.toFixed(2)} MB`);

  // 50 MB is a generous ceiling — the pipeline works with 278 rows of small
  // structured objects and should stay well under 10 MB in practice.
  expect(deltaMB).toBeLessThan(50);
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// After all measurements: write baseline.perf.json and print summary table
// ─────────────────────────────────────────────────────────────────────────────
afterAll(() => {
  const baseline = {
    recorded_at:  new Date().toISOString(),
    case_id:      CASE_ID,
    iterations:   ITERATIONS,
    note: 'All times in milliseconds. Generated by PERF-1–PERF-6. ' +
          'Do not use these numbers as hard SLOs — they are a baseline ' +
          'for detecting future regressions, not a performance contract.',
    stages: results,
  };

  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2));

  // Pretty-print a summary table
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  SPACEFORENSICS — Forensic Pipeline Performance Baseline');
  console.log(`  Case: ${CASE_ID}  |  Iterations: ${ITERATIONS}  |  ${baseline.recorded_at}`);
  console.log('══════════════════════════════════════════════════════════════');
  const order = [
    ['parseEvidenceCSV',              'parseEvidenceCSV'],
    ['buildEvidenceGraph',            'buildEvidenceGraph'],
    ['buildForensicAnalysis',         'buildForensicAnalysis'],
    ['buildAnalystHeuristicNarrative','buildAnalystHeuristicNarrative'],
    ['assembleValidatedForensicReport','assembleValidatedForensicReport'],
    ['fullPipeline',                  'full pipeline end-to-end'],
  ];
  for (const [key, label] of order) {
    if (results[key]) console.log(fmtStats(label, results[key]));
  }
  if (results.heapDeltaMB != null) {
    console.log(`  ${'heap delta (single run)'.padEnd(40)} ${results.heapDeltaMB} MB`);
  }
  console.log('══════════════════════════════════════════════════════════════\n');
});
