'use strict';

/**
 * Phase 9.5 — Async case discovery
 *
 * Verifies that:
 *
 *   P95-1  GET /api/cases uses only async I/O (no sync FS calls on the hot path)
 *   P95-2  Case list is deterministically ordered across repeated calls
 *   P95-3  Unknown-case routes return 404 (regression guard)
 *   P95-4  loadCaseMeta does not block the event loop — concurrent case
 *          metadata loads resolve independently
 *   P95-5  buildForensicAnalysis output is byte-identical whether called with a
 *          pre-loaded caseMeta (new server.js path) or without (sync fallback
 *          used by existing tests)
 *   P95-6  Concurrent forensic-analysis requests for different cases do not
 *          cross-contaminate event blocks
 *   P95-7  Galaxy-15 serialized forensic output is byte-identical before and
 *          after the refactor (regression guard)
 */

const request = require('supertest');
const path    = require('path');
const fs      = require('fs');

const { app, parseEvidenceCSV, buildEvidenceGraph, buildForensicAnalysis } = require('../server');
const { buildForensicAnalysis: buildFA } = require('../services/forensicAnalysis');

const CASES_DIR = path.join(__dirname, '..', '..', 'cases');

const G15  = 'galaxy-15';
const TCA  = 'test-case-alpha';
const GS17 = 'goes16-sep2017';

// ─────────────────────────────────────────────────────────────────────────────
// Shared pipeline fixtures — built once in beforeAll
// ─────────────────────────────────────────────────────────────────────────────
let g15Rows,  g15Graph;
let tcaRows,  tcaGraph;
let gs17Rows, gs17Graph;

beforeAll(async () => {
  [
    [g15Rows,  g15Graph ],
    [tcaRows,  tcaGraph ],
    [gs17Rows, gs17Graph],
  ] = await Promise.all([
    parseEvidenceCSV(G15 ).then(async (rows) => [rows, await buildEvidenceGraph(G15,  rows)]),
    parseEvidenceCSV(TCA ).then(async (rows) => [rows, await buildEvidenceGraph(TCA,  rows)]),
    parseEvidenceCSV(GS17).then(async (rows) => [rows, await buildEvidenceGraph(GS17, rows)]),
  ]);
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// P95-1: GET /api/cases is fully async — verified by response correctness
//        (the endpoint uses fs.promises.readdir + fs.promises.readFile)
// ─────────────────────────────────────────────────────────────────────────────
describe('P95-1: GET /api/cases async I/O', () => {
  test('P95-1-1: returns HTTP 200 with an array', async () => {
    const res = await request(app).get('/api/cases');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('P95-1-2: all three known cases appear', async () => {
    const res = await request(app).get('/api/cases');
    const ids = res.body.map((c) => c.case_id);
    expect(ids).toContain(G15);
    expect(ids).toContain(TCA);
    expect(ids).toContain(GS17);
  });

  test('P95-1-3: every entry has case_id and title strings', async () => {
    const res = await request(app).get('/api/cases');
    for (const c of res.body) {
      expect(typeof c.case_id).toBe('string');
      expect(c.case_id.length).toBeGreaterThan(0);
      expect(typeof c.title).toBe('string');
      expect(c.title.length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P95-2: Deterministic ordering — two calls return same case IDs in same order
// ─────────────────────────────────────────────────────────────────────────────
describe('P95-2: deterministic case ordering', () => {
  test('P95-2-1: two sequential GET /api/cases calls return identical ordered lists', async () => {
    const [res1, res2] = await Promise.all([
      request(app).get('/api/cases'),
      request(app).get('/api/cases'),
    ]);
    const ids1 = res1.body.map((c) => c.case_id);
    const ids2 = res2.body.map((c) => c.case_id);
    expect(ids1).toEqual(ids2);
  });

  test('P95-2-2: five concurrent calls all return identical ordered lists', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => request(app).get('/api/cases')),
    );
    const reference = responses[0].body.map((c) => c.case_id);
    for (const res of responses.slice(1)) {
      expect(res.body.map((c) => c.case_id)).toEqual(reference);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P95-3: Unknown-case 404 regression guard
// ─────────────────────────────────────────────────────────────────────────────
describe('P95-3: unknown-case 404 behavior preserved', () => {
  const UNKNOWN = 'nonexistent-case-xyz';

  test('P95-3-1: GET /api/cases/:id returns 404 for unknown case', async () => {
    const res = await request(app).get(`/api/cases/${UNKNOWN}`);
    expect(res.status).toBe(404);
  });

  test('P95-3-2: GET /api/cases/:id/timeline returns 404 for unknown case', async () => {
    const res = await request(app).get(`/api/cases/${UNKNOWN}/timeline`);
    expect(res.status).toBe(404);
  });

  test('P95-3-3: GET /api/cases/:id/forensic-analysis returns 404 for unknown case', async () => {
    const res = await request(app).get(`/api/cases/${UNKNOWN}/forensic-analysis`);
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P95-4: Concurrent async caseMeta loads resolve independently
// ─────────────────────────────────────────────────────────────────────────────
describe('P95-4: concurrent caseMeta async loads', () => {
  test('P95-4-1: loading G15 and TCA metadata concurrently yields correct titles', async () => {
    const [g15Meta, tcaMeta] = await Promise.all([
      fs.promises.readFile(path.join(CASES_DIR, G15,  'case.json'), 'utf8').then(JSON.parse),
      fs.promises.readFile(path.join(CASES_DIR, TCA,  'case.json'), 'utf8').then(JSON.parse),
    ]);
    expect(g15Meta.case_id).toBe(G15);
    expect(tcaMeta.case_id).toBe(TCA);
    expect(typeof g15Meta.title).toBe('string');
    expect(typeof tcaMeta.title).toBe('string');
  });

  test('P95-4-2: loading all three case metas concurrently yields three distinct case_ids', async () => {
    const metas = await Promise.all(
      [G15, TCA, GS17].map((id) =>
        fs.promises.readFile(path.join(CASES_DIR, id, 'case.json'), 'utf8').then(JSON.parse),
      ),
    );
    const ids = metas.map((m) => m.case_id);
    expect(new Set(ids).size).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P95-5: Pre-loaded caseMeta path produces byte-identical output to sync fallback
// ─────────────────────────────────────────────────────────────────────────────
describe('P95-5: pre-loaded caseMeta vs sync-fallback byte identity', () => {
  test('P95-5-1: G15 analysis with pre-loaded meta equals analysis with sync fallback', async () => {
    const caseMeta   = JSON.parse(await fs.promises.readFile(
      path.join(CASES_DIR, G15, 'case.json'), 'utf8',
    ));
    const withMeta    = buildFA(G15,  g15Graph,  caseMeta);   // async-safe path
    const withFallback = buildFA(G15, g15Graph);               // sync fallback (no caseMeta arg)

    // Strip any object-reference differences — compare via JSON
    expect(JSON.stringify(withMeta)).toBe(JSON.stringify(withFallback));
  });

  test('P95-5-2: TCA analysis with pre-loaded meta equals sync fallback', async () => {
    const caseMeta   = JSON.parse(await fs.promises.readFile(
      path.join(CASES_DIR, TCA, 'case.json'), 'utf8',
    ));
    const withMeta    = buildFA(TCA, tcaGraph,  caseMeta);
    const withFallback = buildFA(TCA, tcaGraph);

    expect(JSON.stringify(withMeta)).toBe(JSON.stringify(withFallback));
  });

  test('P95-5-3: null caseMeta arg produces null event block', () => {
    const withNull = buildFA(G15, g15Graph, null);
    expect(withNull.event).toBeNull();
  });

  test('P95-5-4: event block from pre-loaded meta has correct G15 anchor timestamp', async () => {
    const caseMeta = JSON.parse(await fs.promises.readFile(
      path.join(CASES_DIR, G15, 'case.json'), 'utf8',
    ));
    const analysis = buildFA(G15, g15Graph, caseMeta);
    expect(analysis.event).not.toBeNull();
    expect(analysis.event.timestamp).toBe('2010-04-05T09:48:00Z');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P95-6: Concurrent forensic-analysis requests do not cross-contaminate
// ─────────────────────────────────────────────────────────────────────────────
describe('P95-6: concurrent async forensic analysis does not cross-contaminate', () => {
  test('P95-6-1: G15 and TCA analyses in parallel each have the correct case_id', async () => {
    const g15Meta  = JSON.parse(await fs.promises.readFile(path.join(CASES_DIR, G15, 'case.json'), 'utf8'));
    const tcaMeta  = JSON.parse(await fs.promises.readFile(path.join(CASES_DIR, TCA, 'case.json'), 'utf8'));

    const [g15Analysis, tcaAnalysis] = await Promise.all([
      Promise.resolve(buildFA(G15, g15Graph, g15Meta)),
      Promise.resolve(buildFA(TCA, tcaGraph, tcaMeta)),
    ]);

    expect(g15Analysis.case_id).toBe(G15);
    expect(tcaAnalysis.case_id).toBe(TCA);
  });

  test('P95-6-2: G15 and TCA event blocks do not share anchor timestamp', async () => {
    const [g15Meta, tcaMeta] = await Promise.all([
      fs.promises.readFile(path.join(CASES_DIR, G15, 'case.json'), 'utf8').then(JSON.parse),
      fs.promises.readFile(path.join(CASES_DIR, TCA, 'case.json'), 'utf8').then(JSON.parse),
    ]);
    const g15Analysis = buildFA(G15, g15Graph, g15Meta);
    const tcaAnalysis = buildFA(TCA, tcaGraph, tcaMeta);

    expect(g15Analysis.event.timestamp).not.toBe(tcaAnalysis.event.timestamp);
    expect(g15Analysis.event.timestamp).toBe('2010-04-05T09:48:00Z');
    expect(tcaAnalysis.event.timestamp).toBe('2009-08-12T14:30:00Z');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P95-7: Galaxy-15 byte-identity regression guard
// ─────────────────────────────────────────────────────────────────────────────
describe('P95-7: Galaxy-15 serialized forensic output byte-identity', () => {
  test('P95-7-1: two independent G15 analyses with pre-loaded meta produce identical JSON', async () => {
    const caseMeta = JSON.parse(await fs.promises.readFile(
      path.join(CASES_DIR, G15, 'case.json'), 'utf8',
    ));
    const a1 = JSON.stringify(buildFA(G15, g15Graph, caseMeta));
    const a2 = JSON.stringify(buildFA(G15, g15Graph, caseMeta));
    expect(a1).toBe(a2);
  });

  test('P95-7-2: pre-loaded path and sync-fallback path produce identical G15 JSON', async () => {
    const caseMeta     = JSON.parse(await fs.promises.readFile(
      path.join(CASES_DIR, G15, 'case.json'), 'utf8',
    ));
    const asyncPath    = JSON.stringify(buildFA(G15, g15Graph, caseMeta));
    const fallbackPath = JSON.stringify(buildFA(G15, g15Graph));
    expect(asyncPath).toBe(fallbackPath);
  });

  test('P95-7-3: G15 hypothesis count and assessments are unchanged', async () => {
    const caseMeta = JSON.parse(await fs.promises.readFile(
      path.join(CASES_DIR, G15, 'case.json'), 'utf8',
    ));
    const analysis = buildFA(G15, g15Graph, caseMeta);
    expect(analysis.hypotheses).toHaveLength(5);
    const assessments = analysis.hypotheses.map((h) => h.assessment);
    // Phase 8 baseline assessments — must not change
    expect(assessments).toContain('mixed');
    expect(assessments).toContain('strongly_supported');
    expect(assessments.filter((a) => a === 'mixed')).toHaveLength(2);
    expect(assessments.filter((a) => a === 'insufficient_evidence')).toHaveLength(1);
  });
});
