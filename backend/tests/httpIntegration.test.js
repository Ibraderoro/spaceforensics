'use strict';

const request = require('supertest');
const { app }  = require('../server');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const CASE_ID = 'galaxy-15';

const EXPECTED_ASSESSMENTS = {
  H1: 'mixed',
  H2: 'mixed',
  H3: 'supported',
  H4: 'insufficient_evidence',
  H5: 'strongly_supported',
};

const CAUSAL_CERTAINTY_PHRASES = [
  'caused by',
  'definitively',
  'conclusively',
  'proves',
  'confirmed cause',
  'is the cause',
  'was caused by',
  'root cause is',
];

// Valid evidence ID pattern — E-G15-XXXX (1-based, 1–9999)
const EVIDENCE_ID_RE = /^E-G15-\d{4}$/;

// ─────────────────────────────────────────────────────────────────────────────
// H1. GET /api/cases/galaxy-15/forensic-analysis
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/cases/:id/forensic-analysis', () => {
  let res;
  let body;

  beforeAll(async () => {
    res  = await request(app).get(`/api/cases/${CASE_ID}/forensic-analysis`);
    body = res.body;
  }, 30_000);

  // H1-1: HTTP 200
  test('H1-1: returns HTTP 200 for galaxy-15', () => {
    expect(res.status).toBe(200);
  });

  // H1-2: case_id
  test('H1-2: body contains case_id === "galaxy-15"', () => {
    expect(body.case_id).toBe(CASE_ID);
  });

  // H1-3: causal_attribution_established is strictly false
  test('H1-3: causal_attribution_established is false', () => {
    expect(body.causal_attribution_established).toBe(false);
  });

  // H1-4: hypotheses H1–H5 are all present
  test('H1-4: hypotheses array contains exactly H1–H5', () => {
    expect(Array.isArray(body.hypotheses)).toBe(true);
    const ids = body.hypotheses.map((h) => h.hypothesis_id);
    expect(ids).toContain('H1');
    expect(ids).toContain('H2');
    expect(ids).toContain('H3');
    expect(ids).toContain('H4');
    expect(ids).toContain('H5');
    expect(ids).toHaveLength(5);
  });

  // H1-5: individual assessments are as specified
  test('H1-5: H1 assessment is "mixed"', () => {
    const h = body.hypotheses.find((h) => h.hypothesis_id === 'H1');
    expect(h).toBeDefined();
    expect(h.assessment).toBe(EXPECTED_ASSESSMENTS.H1);
  });

  test('H1-6: H2 assessment is "mixed"', () => {
    const h = body.hypotheses.find((h) => h.hypothesis_id === 'H2');
    expect(h).toBeDefined();
    expect(h.assessment).toBe(EXPECTED_ASSESSMENTS.H2);
  });

  test('H1-7: H3 assessment is "supported"', () => {
    const h = body.hypotheses.find((h) => h.hypothesis_id === 'H3');
    expect(h).toBeDefined();
    expect(h.assessment).toBe(EXPECTED_ASSESSMENTS.H3);
  });

  test('H1-8: H4 assessment is "insufficient_evidence"', () => {
    const h = body.hypotheses.find((h) => h.hypothesis_id === 'H4');
    expect(h).toBeDefined();
    expect(h.assessment).toBe(EXPECTED_ASSESSMENTS.H4);
  });

  test('H1-9: H5 assessment is "strongly_supported"', () => {
    const h = body.hypotheses.find((h) => h.hypothesis_id === 'H5');
    expect(h).toBeDefined();
    expect(h.assessment).toBe(EXPECTED_ASSESSMENTS.H5);
  });

  // H1-10: no evidence ID in the response is fabricated
  test('H1-10: every evidence_id referenced in hypotheses resolves to a real E-G15-XXXX ID', () => {
    for (const h of body.hypotheses) {
      const s = h.evidence_summary;
      const allIds = [
        ...(s.environmental_context_ids   || []),
        ...(s.supporting_evidence_ids     || []),
        ...(s.contradicting_evidence_ids  || []),
        ...(s.non_discriminating_evidence_ids || []),
      ];
      for (const id of allIds) {
        expect(id).toMatch(EVIDENCE_ID_RE);
      }
    }
  });

  // H1-11: analyst_narrative is present in the response
  test('H1-11: analyst_narrative field is present in the validated report', () => {
    expect(body).toHaveProperty('analyst_narrative');
    expect(typeof body.analyst_narrative).toBe('object');
    expect(body.analyst_narrative).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H2. GET /api/cases/galaxy-15/forensic-analysis/narrative
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/cases/:id/forensic-analysis/narrative', () => {
  let res;
  let body;

  beforeAll(async () => {
    res  = await request(app).get(`/api/cases/${CASE_ID}/forensic-analysis/narrative`);
    body = res.body;
  }, 30_000);

  // H2-1: HTTP 200
  test('H2-1: returns HTTP 200 for galaxy-15', () => {
    expect(res.status).toBe(200);
  });

  // H2-2: narrative structure — required top-level fields
  test('H2-2: narrative body has required top-level fields', () => {
    expect(body).toHaveProperty('source');
    expect(body).toHaveProperty('generated_at');
    expect(body).toHaveProperty('hypothesis_assessments');
  });

  // H2-3: source is one of the known values
  test('H2-3: narrative source is "llm" or "heuristic"', () => {
    expect(['llm', 'heuristic']).toContain(body.source);
  });

  // H2-4: hypothesis_assessments covers H1–H5
  test('H2-4: hypothesis_assessments covers H1–H5', () => {
    expect(Array.isArray(body.hypothesis_assessments)).toBe(true);
    const ids = body.hypothesis_assessments.map((ha) => ha.hypothesis_id);
    ['H1', 'H2', 'H3', 'H4', 'H5'].forEach((id) => expect(ids).toContain(id));
  });

  // H2-5: no causal-certainty language anywhere in the serialized narrative
  test('H2-5: narrative contains no causal-certainty language', () => {
    const text = JSON.stringify(body).toLowerCase();
    for (const phrase of CAUSAL_CERTAINTY_PHRASES) {
      expect(text).not.toContain(phrase.toLowerCase());
    }
  });

  // H2-6: no fabricated evidence IDs — every E-XXXX reference matches the real pattern
  test('H2-6: every evidence_id referenced in the narrative matches E-G15-XXXX pattern', () => {
    const text = JSON.stringify(body);
    // Extract anything that looks like an evidence reference (E-...-NNNN)
    const mentioned = [...text.matchAll(/E-[A-Z0-9]+-\d{4}/g)].map((m) => m[0]);
    for (const id of mentioned) {
      expect(id).toMatch(EVIDENCE_ID_RE);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H3. GET /api/cases/galaxy-15/evidence-graph
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/cases/:id/evidence-graph', () => {
  let res;
  let body;

  beforeAll(async () => {
    res  = await request(app).get(`/api/cases/${CASE_ID}/evidence-graph`);
    body = res.body;
  }, 30_000);

  // H3-1: HTTP 200
  test('H3-1: returns HTTP 200 for galaxy-15', () => {
    expect(res.status).toBe(200);
  });

  // H3-2: graph structure invariants
  test('H3-2: graph has case_id, causal_attribution_established, and hypotheses array', () => {
    expect(body.case_id).toBe(CASE_ID);
    expect(body).toHaveProperty('causal_attribution_established');
    expect(Array.isArray(body.hypotheses)).toBe(true);
  });

  // H3-3: exactly five hypotheses
  test('H3-3: graph contains exactly five hypotheses (H1–H5)', () => {
    expect(body.hypotheses).toHaveLength(5);
    const ids = body.hypotheses.map((h) => h.hypothesis_id);
    ['H1', 'H2', 'H3', 'H4', 'H5'].forEach((id) => expect(ids).toContain(id));
  });

  // H3-4: each hypothesis carries the four evidence lists
  test('H3-4: every hypothesis has all four evidence-list fields', () => {
    const LISTS = [
      'environmental_context',
      'supporting_evidence',
      'contradicting_evidence',
      'non_discriminating_evidence',
    ];
    for (const h of body.hypotheses) {
      for (const list of LISTS) {
        expect(Array.isArray(h[list])).toBe(true);
      }
    }
  });

  // H3-5: no evidence IDs in the graph are fabricated
  test('H3-5: every evidence_id in the graph matches E-G15-XXXX', () => {
    const text = JSON.stringify(body);
    const mentioned = [...text.matchAll(/E-[A-Z0-9]+-\d{4}/g)].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(0);
    for (const id of mentioned) {
      expect(id).toMatch(EVIDENCE_ID_RE);
    }
  });

  // H3-6: causal_attribution_established is false
  test('H3-6: causal_attribution_established is false in the evidence graph', () => {
    expect(body.causal_attribution_established).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H4. Unknown case IDs — HTTP error contract
// ─────────────────────────────────────────────────────────────────────────────
describe('Unknown case ID — HTTP 404 contract', () => {
  const UNKNOWN = 'unknown-case-xyz';

  test('H4-1: GET /forensic-analysis for unknown case returns 404', async () => {
    const res = await request(app).get(`/api/cases/${UNKNOWN}/forensic-analysis`);
    expect(res.status).toBe(404);
  });

  test('H4-2: GET /forensic-analysis for unknown case returns JSON with error field', async () => {
    const res = await request(app).get(`/api/cases/${UNKNOWN}/forensic-analysis`);
    expect(res.body).toHaveProperty('error');
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);
  });

  test('H4-3: GET /forensic-analysis/narrative for unknown case returns 404', async () => {
    const res = await request(app).get(`/api/cases/${UNKNOWN}/forensic-analysis/narrative`);
    expect(res.status).toBe(404);
  });

  test('H4-4: GET /forensic-analysis/narrative for unknown case returns JSON with error field', async () => {
    const res = await request(app).get(`/api/cases/${UNKNOWN}/forensic-analysis/narrative`);
    expect(res.body).toHaveProperty('error');
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);
  });

  test('H4-5: GET /evidence-graph for unknown case returns 404', async () => {
    const res = await request(app).get(`/api/cases/${UNKNOWN}/evidence-graph`);
    expect(res.status).toBe(404);
  });

  test('H4-6: GET /evidence-graph for unknown case returns JSON with error field', async () => {
    const res = await request(app).get(`/api/cases/${UNKNOWN}/evidence-graph`);
    expect(res.body).toHaveProperty('error');
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);
  });
});
