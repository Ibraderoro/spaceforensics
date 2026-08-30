'use strict';

const { parseEvidenceCSV } = require('../server');

const GALAXY15 = 'galaxy-15';
const UNKNOWN  = 'unknown-xyz';

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture — Galaxy 15 parsed once for this suite.
// ─────────────────────────────────────────────────────────────────────────────
let g15Records;

beforeAll(async () => {
  g15Records = await parseEvidenceCSV(GALAXY15);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Galaxy 15 resolves successfully
// ─────────────────────────────────────────────────────────────────────────────
test('parseEvidenceCSV resolves for galaxy-15 without throwing', () => {
  expect(Array.isArray(g15Records)).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Galaxy 15 still produces exactly 278 records
// ─────────────────────────────────────────────────────────────────────────────
test('galaxy-15 dataset still produces exactly 278 evidence records', () => {
  expect(g15Records).toHaveLength(278);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. First and last evidence IDs are unchanged
// ─────────────────────────────────────────────────────────────────────────────
test('first evidence ID is still E-G15-0001', () => {
  expect(g15Records[0].evidence_id).toBe('E-G15-0001');
});

test('last evidence ID is still E-G15-0278', () => {
  expect(g15Records[g15Records.length - 1].evidence_id).toBe('E-G15-0278');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Dataset resolution is deterministic — two independent calls agree
// ─────────────────────────────────────────────────────────────────────────────
test('two independent parseEvidenceCSV calls for galaxy-15 return identical evidence IDs', async () => {
  const second = await parseEvidenceCSV(GALAXY15);
  expect(second.map((r) => r.evidence_id)).toEqual(g15Records.map((r) => r.evidence_id));
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Unknown case IDs are rejected — status 404
// ─────────────────────────────────────────────────────────────────────────────
test('parseEvidenceCSV rejects unknown case IDs with status 404', async () => {
  await expect(parseEvidenceCSV(UNKNOWN)).rejects.toMatchObject({ status: 404 });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Rejection message explicitly names the unknown case (not a generic string)
// ─────────────────────────────────────────────────────────────────────────────
test('rejection message for unknown case contains the case ID', async () => {
  let caught;
  try {
    await parseEvidenceCSV(UNKNOWN);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  expect(typeof caught.message).toBe('string');
  expect(caught.message.length).toBeGreaterThan(0);
  expect(caught.message).toContain(UNKNOWN);
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Unknown case does not silently resolve to the Galaxy 15 dataset
// ─────────────────────────────────────────────────────────────────────────────
test('unknown case ID does not resolve to the Galaxy 15 dataset', async () => {
  let resolved = false;
  try {
    await parseEvidenceCSV(UNKNOWN);
    resolved = true;
  } catch (_) {
    // expected
  }
  expect(resolved).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Rejection is deterministic — two calls for the same unknown case ID
//    produce identical rejection objects
// ─────────────────────────────────────────────────────────────────────────────
test('rejection for unknown case is deterministic across two calls', async () => {
  let err1, err2;
  try { await parseEvidenceCSV(UNKNOWN); } catch (e) { err1 = e; }
  try { await parseEvidenceCSV(UNKNOWN); } catch (e) { err2 = e; }
  expect(err1).toEqual(err2);
});
