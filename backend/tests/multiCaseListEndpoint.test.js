'use strict';

/**
 * Phase 6 — Multi-Case List Endpoint Tests
 *
 * Verifies that GET /api/cases returns all known cases (Galaxy 15, test-case-alpha,
 * and goes16-sep2017) with the correct shape and that no non-existent cases appear.
 */

const request = require('supertest');
const { app } = require('../server');

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture
// ─────────────────────────────────────────────────────────────────────────────
let res;
let body;

beforeAll(async () => {
  res  = await request(app).get('/api/cases');
  body = res.body;
});

// ─────────────────────────────────────────────────────────────────────────────
// MCL-1 — Returns HTTP 200
// ─────────────────────────────────────────────────────────────────────────────
test('MCL-1: GET /api/cases returns HTTP 200', () => {
  expect(res.status).toBe(200);
});

// ─────────────────────────────────────────────────────────────────────────────
// MCL-2 — Response is an array
// ─────────────────────────────────────────────────────────────────────────────
test('MCL-2: response is an array', () => {
  expect(Array.isArray(body)).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// MCL-3 — Response contains all known cases
// ─────────────────────────────────────────────────────────────────────────────
test('MCL-3: response contains exactly three cases', () => {
  expect(body).toHaveLength(3);
});

// ─────────────────────────────────────────────────────────────────────────────
// MCL-4 — Galaxy 15 is present
// ─────────────────────────────────────────────────────────────────────────────
test('MCL-4: response includes galaxy-15', () => {
  const ids = body.map((c) => c.case_id);
  expect(ids).toContain('galaxy-15');
});

// ─────────────────────────────────────────────────────────────────────────────
// MCL-5 — test-case-alpha is present
// ─────────────────────────────────────────────────────────────────────────────
test('MCL-5: response includes test-case-alpha', () => {
  const ids = body.map((c) => c.case_id);
  expect(ids).toContain('test-case-alpha');
});

// ─────────────────────────────────────────────────────────────────────────────
// MCL-6 — Every entry has case_id and title fields
// ─────────────────────────────────────────────────────────────────────────────
test('MCL-6: every entry has case_id (string) and title (string)', () => {
  for (const c of body) {
    expect(typeof c.case_id).toBe('string');
    expect(c.case_id.length).toBeGreaterThan(0);
    expect(typeof c.title).toBe('string');
    expect(c.title.length).toBeGreaterThan(0);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MCL-7 — Galaxy 15 title is correct
// ─────────────────────────────────────────────────────────────────────────────
test('MCL-7: Galaxy 15 entry has expected title', () => {
  const g15 = body.find((c) => c.case_id === 'galaxy-15');
  expect(g15.title).toContain('Galaxy 15');
});

// ─────────────────────────────────────────────────────────────────────────────
// MCL-8 — test-case-alpha title is correct
// ─────────────────────────────────────────────────────────────────────────────
test('MCL-8: test-case-alpha entry has expected title', () => {
  const tca = body.find((c) => c.case_id === 'test-case-alpha');
  expect(tca.title).toContain('Test Case Alpha');
});

// ─────────────────────────────────────────────────────────────────────────────
// MCL-8b — goes16-sep2017 is present
// ─────────────────────────────────────────────────────────────────────────────
test('MCL-8b: response includes goes16-sep2017', () => {
  const ids = body.map((c) => c.case_id);
  expect(ids).toContain('goes16-sep2017');
});

// ─────────────────────────────────────────────────────────────────────────────
// MCL-8c — goes16-sep2017 title is correct
// ─────────────────────────────────────────────────────────────────────────────
test('MCL-8c: goes16-sep2017 entry has expected title', () => {
  const gs17 = body.find((c) => c.case_id === 'goes16-sep2017');
  expect(gs17.title).toContain('GOES-16');
});

// ─────────────────────────────────────────────────────────────────────────────
// MCL-9 — No unknown case IDs appear
// ─────────────────────────────────────────────────────────────────────────────
test('MCL-9: no unknown case IDs appear in the list', () => {
  const KNOWN = new Set(['galaxy-15', 'test-case-alpha', 'goes16-sep2017']);
  for (const c of body) {
    expect(KNOWN.has(c.case_id)).toBe(true);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MCL-10 — Response is deterministic across two calls
// ─────────────────────────────────────────────────────────────────────────────
test('MCL-10: two calls to GET /api/cases return the same case IDs', async () => {
  const res2   = await request(app).get('/api/cases');
  const ids1   = body.map((c) => c.case_id).sort();
  const ids2   = res2.body.map((c) => c.case_id).sort();
  expect(ids2).toEqual(ids1);
});
