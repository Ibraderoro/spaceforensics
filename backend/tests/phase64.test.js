'use strict';

/**
 * Phase 6.4 — Async Case Discovery
 *
 * Verifies the five requirements added by converting synchronous filesystem
 * I/O to async fs.promises throughout server.js:
 *
 *   CD-1  — Known case resolves correctly (galaxy-15)
 *   CD-2  — Known case resolves correctly (test-case-alpha)
 *   CD-3  — Unknown case ID rejects with the existing safe 404 error contract
 *   CD-4  — Multiple cases remain discoverable via GET /api/cases
 *   CD-5  — Concurrent case-discovery requests resolve correctly and
 *            independently (no shared state, no cross-contamination)
 *   CD-6  — Case-discovery failures produce the existing safe error contract
 *           (CASE_NOT_FOUND, HTTP 404, correct error shape)
 *
 * These tests operate purely through the exported async functions and the
 * Express app (via supertest).  No sync fs operations are involved.
 */

const request = require('supertest');
const { app, parseEvidenceCSV, buildEvidenceGraph } = require('../server');

// ─────────────────────────────────────────────────────────────────────────────
// CD-1 — Galaxy 15 case resolves: parseEvidenceCSV returns rows
// ─────────────────────────────────────────────────────────────────────────────
test('CD-1: parseEvidenceCSV resolves for galaxy-15 and returns 278 rows', async () => {
  const rows = await parseEvidenceCSV('galaxy-15');
  expect(Array.isArray(rows)).toBe(true);
  expect(rows).toHaveLength(278);
});

// ─────────────────────────────────────────────────────────────────────────────
// CD-2 — test-case-alpha case resolves: parseEvidenceCSV returns rows
// ─────────────────────────────────────────────────────────────────────────────
test('CD-2: parseEvidenceCSV resolves for test-case-alpha and returns 69 rows', async () => {
  const rows = await parseEvidenceCSV('test-case-alpha');
  expect(Array.isArray(rows)).toBe(true);
  expect(rows).toHaveLength(69);
});

// ─────────────────────────────────────────────────────────────────────────────
// CD-3 — Unknown case ID rejects with status 404
// ─────────────────────────────────────────────────────────────────────────────
test('CD-3: parseEvidenceCSV rejects unknown case IDs with { status: 404 }', async () => {
  await expect(parseEvidenceCSV('nonexistent-case-xyz')).rejects.toMatchObject({
    status: 404,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CD-4 — Multiple cases discoverable via GET /api/cases
// ─────────────────────────────────────────────────────────────────────────────
test('CD-4: GET /api/cases discovers both cases asynchronously', async () => {
  const res = await request(app).get('/api/cases');
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
  const ids = res.body.map((c) => c.case_id);
  expect(ids).toContain('galaxy-15');
  expect(ids).toContain('test-case-alpha');
});

// ─────────────────────────────────────────────────────────────────────────────
// CD-5 — Concurrent requests resolve correctly and independently
// ─────────────────────────────────────────────────────────────────────────────
test('CD-5: three concurrent parseEvidenceCSV calls for galaxy-15 return identical IDs', async () => {
  const [r1, r2, r3] = await Promise.all([
    parseEvidenceCSV('galaxy-15'),
    parseEvidenceCSV('galaxy-15'),
    parseEvidenceCSV('galaxy-15'),
  ]);
  const ids1 = r1.map((r) => r.evidence_id);
  const ids2 = r2.map((r) => r.evidence_id);
  const ids3 = r3.map((r) => r.evidence_id);
  expect(ids2).toEqual(ids1);
  expect(ids3).toEqual(ids1);
});

test('CD-5b: concurrent galaxy-15 and test-case-alpha parsing returns separate, non-overlapping IDs', async () => {
  const [g15Rows, tcaRows] = await Promise.all([
    parseEvidenceCSV('galaxy-15'),
    parseEvidenceCSV('test-case-alpha'),
  ]);
  const g15Ids = new Set(g15Rows.map((r) => r.evidence_id));
  const tcaIds = new Set(tcaRows.map((r) => r.evidence_id));
  for (const id of tcaIds) {
    expect(g15Ids.has(id)).toBe(false);
  }
});

test('CD-5c: concurrent buildEvidenceGraph calls for both cases produce independent graphs', async () => {
  const [g15Rows, tcaRows] = await Promise.all([
    parseEvidenceCSV('galaxy-15'),
    parseEvidenceCSV('test-case-alpha'),
  ]);
  const [g15Graph, tcaGraph] = await Promise.all([
    buildEvidenceGraph('galaxy-15', g15Rows),
    buildEvidenceGraph('test-case-alpha', tcaRows),
  ]);
  expect(g15Graph.case_id).toBe('galaxy-15');
  expect(tcaGraph.case_id).toBe('test-case-alpha');
  // Hypothesis counts are independent
  expect(g15Graph.hypotheses).toHaveLength(5);
  expect(tcaGraph.hypotheses).toHaveLength(3);
});

// ─────────────────────────────────────────────────────────────────────────────
// CD-6 — Case-discovery failures produce safe 404 error contract via HTTP
// ─────────────────────────────────────────────────────────────────────────────
test('CD-6a: GET /api/cases/:id for unknown case returns HTTP 404', async () => {
  const res = await request(app).get('/api/cases/nonexistent-case-xyz');
  expect(res.status).toBe(404);
});

test('CD-6b: GET /api/cases/:id/timeline for unknown case returns HTTP 404', async () => {
  const res = await request(app).get('/api/cases/nonexistent-case-xyz/timeline');
  expect(res.status).toBe(404);
});

test('CD-6c: GET /api/cases/:id/evidence-graph for unknown case returns structured CASE_NOT_FOUND error', async () => {
  const res = await request(app).get('/api/cases/nonexistent-case-xyz/evidence-graph');
  expect(res.status).toBe(404);
  expect(res.body.error_code).toBe('CASE_NOT_FOUND');
  expect(typeof res.body.error).toBe('string');
  expect(res.body.status_code).toBe(404);
});

test('CD-6d: GET /api/cases/:id/forensic-analysis for unknown case returns structured CASE_NOT_FOUND error', async () => {
  const res = await request(app).get('/api/cases/nonexistent-case-xyz/forensic-analysis');
  expect(res.status).toBe(404);
  expect(res.body.error_code).toBe('CASE_NOT_FOUND');
  expect(typeof res.body.error).toBe('string');
  expect(res.body.status_code).toBe(404);
});

test('CD-6e: GET /api/cases/:id/forensic-analysis/narrative for unknown case returns structured CASE_NOT_FOUND error', async () => {
  const res = await request(app).get('/api/cases/nonexistent-case-xyz/forensic-analysis/narrative');
  expect(res.status).toBe(404);
  expect(res.body.error_code).toBe('CASE_NOT_FOUND');
  expect(typeof res.body.error).toBe('string');
  expect(res.body.status_code).toBe(404);
});

test('CD-6f: POST /api/cases/:id/investigate for unknown case returns HTTP 404', async () => {
  const res = await request(app).post('/api/cases/nonexistent-case-xyz/investigate').send({});
  expect(res.status).toBe(404);
});

test('CD-6g: POST /api/cases/:id/challenge for unknown case returns HTTP 404', async () => {
  const res = await request(app).post('/api/cases/nonexistent-case-xyz/challenge').send({});
  expect(res.status).toBe(404);
});

// ─────────────────────────────────────────────────────────────────────────────
// CD-7 — GET /api/cases returns the correct shape for each entry
// ─────────────────────────────────────────────────────────────────────────────
test('CD-7: each entry in GET /api/cases has a non-empty case_id and title string', async () => {
  const res = await request(app).get('/api/cases');
  expect(res.status).toBe(200);
  for (const entry of res.body) {
    expect(typeof entry.case_id).toBe('string');
    expect(entry.case_id.length).toBeGreaterThan(0);
    expect(typeof entry.title).toBe('string');
    expect(entry.title.length).toBeGreaterThan(0);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CD-8 — GET /api/cases/:id returns full metadata for a known case
// ─────────────────────────────────────────────────────────────────────────────
test('CD-8: GET /api/cases/galaxy-15 returns 200 with case_id and title', async () => {
  const res = await request(app).get('/api/cases/galaxy-15');
  expect(res.status).toBe(200);
  expect(res.body.case_id).toBe('galaxy-15');
  expect(typeof res.body.title).toBe('string');
  expect(res.body.title.length).toBeGreaterThan(0);
});

test('CD-8b: GET /api/cases/test-case-alpha returns 200 with case_id and title', async () => {
  const res = await request(app).get('/api/cases/test-case-alpha');
  expect(res.status).toBe(200);
  expect(res.body.case_id).toBe('test-case-alpha');
  expect(typeof res.body.title).toBe('string');
  expect(res.body.title.length).toBeGreaterThan(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// CD-9 — Async discovery does not silently fall back to Galaxy 15
// Requesting test-case-alpha must return TCA evidence, not G15 evidence.
// ─────────────────────────────────────────────────────────────────────────────
test('CD-9: async discovery for test-case-alpha never silently returns Galaxy 15 rows', async () => {
  const rows = await parseEvidenceCSV('test-case-alpha');
  for (const row of rows) {
    expect(row.evidence_id).not.toMatch(/^E-G15-/);
  }
  expect(rows.some((r) => r.evidence_id.startsWith('E-TCA-'))).toBe(true);
});
