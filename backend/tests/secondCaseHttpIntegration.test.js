'use strict';

/**
 * Phase 6 — Second Case HTTP Integration Tests
 *
 * Verifies that all five API endpoints return correct HTTP responses for
 * test-case-alpha, exercising the full server stack from HTTP to pipeline.
 */

const request = require('supertest');
const { app } = require('../server');

const CASE_ID = 'test-case-alpha';

// ─────────────────────────────────────────────────────────────────────────────
// SC-HTTP-1 — GET /api/cases/:id — case metadata
// ─────────────────────────────────────────────────────────────────────────────
describe('SC-HTTP-1: GET /api/cases/:id for test-case-alpha', () => {
  let res;
  beforeAll(async () => {
    res = await request(app).get(`/api/cases/${CASE_ID}`);
  });

  test('returns HTTP 200', () => {
    expect(res.status).toBe(200);
  });

  test('body has case_id = "test-case-alpha"', () => {
    expect(res.body.case_id).toBe(CASE_ID);
  });

  test('body has anchor_event.timestamp', () => {
    expect(typeof res.body.anchor_event?.timestamp).toBe('string');
    expect(res.body.anchor_event.timestamp).toBe('2009-08-12T14:30:00Z');
  });

  test('body has id_prefix = "TCA"', () => {
    expect(res.body.id_prefix).toBe('TCA');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-HTTP-2 — GET /api/cases/:id/timeline
// ─────────────────────────────────────────────────────────────────────────────
describe('SC-HTTP-2: GET /api/cases/:id/timeline for test-case-alpha', () => {
  let res;
  beforeAll(async () => {
    res = await request(app).get(`/api/cases/${CASE_ID}/timeline`);
  });

  test('returns HTTP 200', () => {
    expect(res.status).toBe(200);
  });

  test('body is an array of 69 records', () => {
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(69);
  });

  test('first evidence ID is E-TCA-0001', () => {
    expect(res.body[0].evidence_id).toBe('E-TCA-0001');
  });

  test('all evidence IDs use the TCA prefix', () => {
    for (const r of res.body) {
      expect(r.evidence_id).toMatch(/^E-TCA-\d{4}$/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-HTTP-3 — GET /api/cases/:id/evidence-graph
// ─────────────────────────────────────────────────────────────────────────────
describe('SC-HTTP-3: GET /api/cases/:id/evidence-graph for test-case-alpha', () => {
  let res;
  beforeAll(async () => {
    res = await request(app).get(`/api/cases/${CASE_ID}/evidence-graph`);
  });

  test('returns HTTP 200', () => {
    expect(res.status).toBe(200);
  });

  test('body has case_id, causal_attribution_established, and hypotheses array', () => {
    expect(res.body.case_id).toBe(CASE_ID);
    expect(typeof res.body.causal_attribution_established).toBe('boolean');
    expect(Array.isArray(res.body.hypotheses)).toBe(true);
  });

  test('causal_attribution_established is false', () => {
    expect(res.body.causal_attribution_established).toBe(false);
  });

  test('hypotheses array has exactly 3 entries (H1, H2, H3)', () => {
    expect(res.body.hypotheses).toHaveLength(3);
    const ids = res.body.hypotheses.map((h) => h.hypothesis_id);
    expect(ids).toContain('H1');
    expect(ids).toContain('H2');
    expect(ids).toContain('H3');
  });

  test('every hypothesis has all four evidence-list fields', () => {
    const LISTS = ['environmental_context','supporting_evidence','contradicting_evidence','non_discriminating_evidence'];
    for (const h of res.body.hypotheses) {
      for (const l of LISTS) {
        expect(Array.isArray(h[l])).toBe(true);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-HTTP-4 — GET /api/cases/:id/forensic-analysis
// ─────────────────────────────────────────────────────────────────────────────
describe('SC-HTTP-4: GET /api/cases/:id/forensic-analysis for test-case-alpha', () => {
  let res;
  beforeAll(async () => {
    res = await request(app).get(`/api/cases/${CASE_ID}/forensic-analysis`);
  }, 30_000);

  test('returns HTTP 200', () => {
    expect(res.status).toBe(200);
  });

  test('body has case_id = "test-case-alpha"', () => {
    expect(res.body.case_id).toBe(CASE_ID);
  });

  test('causal_attribution_established is false', () => {
    expect(res.body.causal_attribution_established).toBe(false);
  });

  test('analyst_narrative is present', () => {
    expect(res.body).toHaveProperty('analyst_narrative');
    expect(typeof res.body.analyst_narrative).toBe('object');
  });

  test('all hypothesis assessments are in allowed vocabulary', () => {
    const ALLOWED = new Set(['strongly_supported','supported','mixed','weakly_supported','insufficient_evidence']);
    for (const h of res.body.hypotheses) {
      if (h.assessment !== null && h.assessment !== undefined) {
        expect(ALLOWED.has(h.assessment)).toBe(true);
      }
    }
  });

  test('response contains no error_code or violations fields', () => {
    expect(res.body).not.toHaveProperty('error_code');
    expect(res.body).not.toHaveProperty('violations');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-HTTP-5 — GET /api/cases (list endpoint includes test-case-alpha)
// ─────────────────────────────────────────────────────────────────────────────
describe('SC-HTTP-5: GET /api/cases includes test-case-alpha', () => {
  let res;
  beforeAll(async () => {
    res = await request(app).get('/api/cases');
  });

  test('returns HTTP 200', () => {
    expect(res.status).toBe(200);
  });

  test('response array contains test-case-alpha', () => {
    const ids = res.body.map((c) => c.case_id);
    expect(ids).toContain(CASE_ID);
  });

  test('test-case-alpha entry has a title field', () => {
    const entry = res.body.find((c) => c.case_id === CASE_ID);
    expect(typeof entry.title).toBe('string');
    expect(entry.title.length).toBeGreaterThan(0);
  });
});
