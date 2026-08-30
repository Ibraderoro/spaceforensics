'use strict';

/**
 * Phase 6 — Second Case Ingestion Tests
 *
 * Verifies that parseEvidenceCSV correctly loads the test-case-alpha dataset
 * with the expected record count, evidence ID format, and deterministic behaviour.
 *
 * These tests are structurally identical to the Galaxy 15 regression tests in
 * multiCaseIngestion.test.js but assert test-case-alpha values.
 * Galaxy 15 values are not referenced here.
 */

const { parseEvidenceCSV } = require('../server');

const CASE_ID  = 'test-case-alpha';
const EXPECTED_COUNT = 69;
const EXPECTED_FIRST_ID = 'E-TCA-0001';
const EXPECTED_LAST_ID  = `E-TCA-${String(EXPECTED_COUNT).padStart(4, '0')}`;

let records;

beforeAll(async () => {
  records = await parseEvidenceCSV(CASE_ID);
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-ING-1 — Resolves successfully
// ─────────────────────────────────────────────────────────────────────────────
test('SC-ING-1: parseEvidenceCSV resolves for test-case-alpha without throwing', () => {
  expect(Array.isArray(records)).toBe(true);
  expect(records.length).toBeGreaterThan(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-ING-2 — Correct record count
// ─────────────────────────────────────────────────────────────────────────────
test(`SC-ING-2: test-case-alpha dataset produces exactly ${EXPECTED_COUNT} evidence records`, () => {
  expect(records).toHaveLength(EXPECTED_COUNT);
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-ING-3 — First evidence ID uses the TCA prefix
// ─────────────────────────────────────────────────────────────────────────────
test(`SC-ING-3: first evidence ID is ${EXPECTED_FIRST_ID}`, () => {
  expect(records[0].evidence_id).toBe(EXPECTED_FIRST_ID);
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-ING-4 — Last evidence ID is correct
// ─────────────────────────────────────────────────────────────────────────────
test(`SC-ING-4: last evidence ID is ${EXPECTED_LAST_ID}`, () => {
  expect(records[records.length - 1].evidence_id).toBe(EXPECTED_LAST_ID);
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-ING-5 — IDs use TCA prefix, not G15
// ─────────────────────────────────────────────────────────────────────────────
test('SC-ING-5: all evidence IDs use the TCA prefix and not the G15 prefix', () => {
  for (const r of records) {
    expect(r.evidence_id).toMatch(/^E-TCA-\d{4}$/);
    expect(r.evidence_id).not.toContain('G15');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-ING-6 — Deterministic across two independent calls
// ─────────────────────────────────────────────────────────────────────────────
test('SC-ING-6: two independent parseEvidenceCSV calls for test-case-alpha return identical evidence IDs', async () => {
  const second = await parseEvidenceCSV(CASE_ID);
  expect(second.map((r) => r.evidence_id)).toEqual(records.map((r) => r.evidence_id));
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-ING-7 — Records are sorted by timestamp then source
// ─────────────────────────────────────────────────────────────────────────────
test('SC-ING-7: records are sorted by timestamp (primary) then source (secondary)', () => {
  for (let i = 1; i < records.length; i++) {
    const a = records[i - 1];
    const b = records[i];
    if (a.timestamp === b.timestamp) {
      expect(a.source <= b.source).toBe(true);
    } else {
      expect(a.timestamp < b.timestamp).toBe(true);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-ING-8 — Required fields are present on every record
// ─────────────────────────────────────────────────────────────────────────────
test('SC-ING-8: every record has all required fields', () => {
  const REQUIRED = ['evidence_id', 'timestamp', 'source', 'measurement', 'value', 'unit', 'resolution'];
  for (const r of records) {
    for (const field of REQUIRED) {
      expect(r).toHaveProperty(field);
    }
  }
});
