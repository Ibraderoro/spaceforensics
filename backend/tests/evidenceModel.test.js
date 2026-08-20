'use strict';

const path = require('path');
const { parseEvidenceCSV } = require('../server');

// The real case directory, two levels up from backend/tests/
const CASE_ID = 'galaxy-15';

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture — parsed once for the whole suite to keep tests fast.
// ─────────────────────────────────────────────────────────────────────────────
let records;

beforeAll(async () => {
  records = await parseEvidenceCSV(CASE_ID);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Record count
// ─────────────────────────────────────────────────────────────────────────────
test('exactly 278 evidence records are returned', () => {
  expect(records).toHaveLength(278);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. All IDs are unique
// ─────────────────────────────────────────────────────────────────────────────
test('all evidence_id values are unique', () => {
  const ids = records.map((r) => r.evidence_id);
  const unique = new Set(ids);
  expect(unique.size).toBe(278);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. First record is E-G15-0001
// ─────────────────────────────────────────────────────────────────────────────
test('first chronological record has evidence_id E-G15-0001', () => {
  expect(records[0].evidence_id).toBe('E-G15-0001');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Last record is E-G15-0278
// ─────────────────────────────────────────────────────────────────────────────
test('last record has evidence_id E-G15-0278', () => {
  expect(records[records.length - 1].evidence_id).toBe('E-G15-0278');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. IDs are strictly sequential
// ─────────────────────────────────────────────────────────────────────────────
test('evidence_ids are sequential from 0001 to 0278', () => {
  records.forEach((r, i) => {
    const expected = `E-G15-${String(i + 1).padStart(4, '0')}`;
    expect(r.evidence_id).toBe(expected);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. IDs are stable across two independent calls (determinism)
// ─────────────────────────────────────────────────────────────────────────────
test('evidence_ids are identical across two independent parseEvidenceCSV calls', async () => {
  const second = await parseEvidenceCSV(CASE_ID);
  expect(second.map((r) => r.evidence_id)).toEqual(records.map((r) => r.evidence_id));
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Provenance — GOES11_EP8 records (measurement: e_flux)
// ─────────────────────────────────────────────────────────────────────────────
test('GOES11_EP8 records carry correct provenance', () => {
  const ep8 = records.filter((r) => r.source === 'GOES11_EP8');
  expect(ep8.length).toBeGreaterThan(0);
  for (const r of ep8) {
    expect(r.dataset_id).toBe('GOES11_K0_EP8');
    expect(r.provider).toBe('NASA CDAWeb');
    expect(r.variable).toBe('E_1MEV_IC');
    expect(r.evidence_type).toBe('environmental_observation');
    expect(r.quality).toBeNull();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Provenance — GOES11_MAG records (measurement: b_gsm)
// ─────────────────────────────────────────────────────────────────────────────
test('GOES11_MAG records carry correct provenance', () => {
  const mag = records.filter((r) => r.source === 'GOES11_MAG');
  expect(mag.length).toBeGreaterThan(0);
  for (const r of mag) {
    expect(r.dataset_id).toBe('GOES11_K0_MAG');
    expect(r.provider).toBe('NASA CDAWeb');
    expect(r.variable).toBe('B_GSM');
    expect(r.evidence_type).toBe('environmental_observation');
    expect(r.quality).toBeNull();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Provenance — GOES11_EPHEMERIS records (measurement: position)
// ─────────────────────────────────────────────────────────────────────────────
test('GOES11_EPHEMERIS records carry correct provenance (mapped from GOES11_EPHEMERIS_SSC)', () => {
  const eph = records.filter((r) => r.source === 'GOES11_EPHEMERIS');
  expect(eph.length).toBeGreaterThan(0);
  for (const r of eph) {
    expect(r.dataset_id).toBe('GOES11_EPHEMERIS_SSC');
    expect(r.provider).toBe('NASA CDAWeb / SSC');
    expect(r.variable).toBe('XYZ_GSM');
    expect(r.evidence_type).toBe('environmental_observation');
    expect(r.quality).toBeNull();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Provenance — CASE records (anchor event, no data_sources entry)
// ─────────────────────────────────────────────────────────────────────────────
test('CASE source records have null provenance fields and evidence_type case_event', () => {
  const caseRows = records.filter((r) => r.source === 'CASE');
  expect(caseRows.length).toBeGreaterThan(0);
  for (const r of caseRows) {
    expect(r.dataset_id).toBeNull();
    expect(r.provider).toBeNull();
    expect(r.variable).toBeNull();
    expect(r.evidence_type).toBe('case_event');
    expect(r.quality).toBeNull();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Unknown measurement → null provenance (no fabrication)
// ─────────────────────────────────────────────────────────────────────────────
test('a record with an unmapped measurement receives null provenance, not fabricated values', async () => {
  // Inject a synthetic row with an unknown measurement by monkey-patching the
  // CSV path is not practical here; instead verify the helper logic directly
  // via a white-box check: every record whose measurement does NOT appear in
  // case.json data_sources must have null dataset_id / provider / variable.
  const caseJson = require(path.join(__dirname, '../../cases/galaxy-15/case.json'));
  const knownMeasurements = new Set(caseJson.data_sources.map((ds) => ds.measurement));

  for (const r of records) {
    if (!knownMeasurements.has(r.measurement)) {
      expect(r.dataset_id).toBeNull();
      expect(r.provider).toBeNull();
      expect(r.variable).toBeNull();
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. quality is null on every record
// ─────────────────────────────────────────────────────────────────────────────
test('quality is null on every record', () => {
  for (const r of records) {
    expect(r.quality).toBeNull();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. Original fields are preserved and correctly typed
// ─────────────────────────────────────────────────────────────────────────────
test('all original fields are present and correctly typed on every record', () => {
  for (const r of records) {
    // timestamp — ISO 8601 string
    expect(typeof r.timestamp).toBe('string');
    expect(r.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // source — non-empty string
    expect(typeof r.source).toBe('string');
    expect(r.source.length).toBeGreaterThan(0);
    // measurement — non-empty string
    expect(typeof r.measurement).toBe('string');
    expect(r.measurement.length).toBeGreaterThan(0);
    // value — finite number (fill values excluded by ingestion)
    expect(typeof r.value).toBe('number');
    expect(Number.isFinite(r.value)).toBe(true);
    // unit — non-empty string
    expect(typeof r.unit).toBe('string');
    expect(r.unit.length).toBeGreaterThan(0);
    // resolution — non-empty string
    expect(typeof r.resolution).toBe('string');
    expect(r.resolution.length).toBeGreaterThan(0);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. Native resolution is preserved (not resampled / coerced)
// ─────────────────────────────────────────────────────────────────────────────
test('native resolution strings are preserved as-is from the CSV', () => {
  const resolutions = new Set(records.map((r) => r.resolution));
  // The CSV contains exactly these four resolution strings
  expect(resolutions).toEqual(new Set(['5min', '1min', '3min', 'event']));
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. Fill values (NaN / Infinity) do not appear as analytical evidence
// ─────────────────────────────────────────────────────────────────────────────
test('no record has a non-finite value (fill values are excluded by ingestion)', () => {
  const bad = records.filter((r) => !Number.isFinite(r.value));
  expect(bad).toHaveLength(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 16. Timestamps are chronologically sorted
// ─────────────────────────────────────────────────────────────────────────────
test('records are sorted chronologically (primary: timestamp, secondary: source)', () => {
  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1];
    const curr = records[i];
    if (prev.timestamp === curr.timestamp) {
      expect(prev.source <= curr.source).toBe(true);
    } else {
      expect(prev.timestamp < curr.timestamp).toBe(true);
    }
  }
});
