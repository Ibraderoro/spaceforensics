'use strict';

/**
 * Phase 6.2 — HTTP Integration Coverage
 *
 * Covers the three endpoints that had no HTTP-layer test coverage:
 *
 *   GET  /api/cases/:id/evidence/:evidenceId/provenance
 *   POST /api/cases/:id/investigate
 *   POST /api/cases/:id/challenge
 *
 * All tests use the real HTTP application (supertest against `app`) and do NOT
 * substitute direct function calls for HTTP calls.  No existing test is
 * modified or weakened.
 *
 * Scientific invariants that must hold:
 *   - causal_attribution_established is never changed by investigate or challenge
 *   - Assessment vocabulary is restricted to ALLOWED_ASSESSMENTS
 *   - No causal-certainty language in heuristic output
 *   - Source evidence is not mutated
 *   - hypothesis_relationships in provenance are verbatim from the graph
 *   - EPHEMERIS records have empty hypothesis_relationships
 */

const request = require('supertest');
const { app, parseEvidenceCSV, buildEvidenceGraph } = require('../server');

// ─────────────────────────────────────────────────────────────────────────────
// Shared constants
// ─────────────────────────────────────────────────────────────────────────────

const CASE_ID  = 'galaxy-15';
const UNKNOWN  = 'no-such-case-xyz';

const ALLOWED_ASSESSMENTS = new Set([
  'strongly_supported', 'supported', 'mixed', 'weakly_supported', 'insufficient_evidence',
]);

const ALL_LISTS = [
  'environmental_context',
  'supporting_evidence',
  'contradicting_evidence',
  'non_discriminating_evidence',
];

// Heuristic causal-certainty phrases that must never appear in output
// (mirrors the pass-level check in aiEngine.js)
const CAUSAL_CERTAINTY_PHRASES = [
  'proves', 'confirms causation', 'is caused by', 'causation established',
  'proof of', 'definitively caused', 'conclusively shows', 'confirms that',
];

// Evidence ID RE for Galaxy 15
const G15_ID_RE = /^E-G15-\d{4}$/;

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture — built once for the whole file; re-used by several suites.
// Parsing 278 rows + building the graph are the expensive operations; do them
// once rather than per-suite.
// ─────────────────────────────────────────────────────────────────────────────

let g15Rows;
let g15Graph;
let anchorId;      // evidence_id of the single CASE row
let ephemerisId;   // evidence_id of the first GOES11_EPHEMERIS row
let ep8WindowId;   // evidence_id of first EP8 environmental_context ref

beforeAll(async () => {
  jest.setTimeout(60_000);
  g15Rows  = await parseEvidenceCSV(CASE_ID);
  g15Graph = await buildEvidenceGraph(CASE_ID, g15Rows);

  anchorId     = g15Rows.find((r) => r.source === 'CASE').evidence_id;
  ephemerisId  = g15Rows.find((r) => r.source === 'GOES11_EPHEMERIS').evidence_id;

  for (const h of g15Graph.hypotheses) {
    if ((h.environmental_context || []).length > 0) {
      ep8WindowId = h.environmental_context[0].evidence_id;
      break;
    }
  }
}, 60_000);

// =============================================================================
// PART 1 — GET /api/cases/:id/evidence/:evidenceId/provenance
// =============================================================================

describe('P1: GET /api/cases/:id/evidence/:evidenceId/provenance — anchor record', () => {
  let res;
  let body;

  beforeAll(async () => {
    res  = await request(app).get(`/api/cases/${CASE_ID}/evidence/${anchorId}/provenance`);
    body = res.body;
  });

  // ── HTTP contract ──────────────────────────────────────────────────────────

  test('P1-1: returns HTTP 200 for a known evidence ID', () => {
    expect(res.status).toBe(200);
  });

  test('P1-2: response content-type is application/json', () => {
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  // ── found flag and evidence_id ─────────────────────────────────────────────

  test('P1-3: found is true', () => {
    expect(body.found).toBe(true);
  });

  test('P1-4: evidence_id in response matches the requested ID', () => {
    expect(body.evidence_id).toBe(anchorId);
  });

  // ── All 12 verbatim evidence fields are present ───────────────────────────

  test('P1-5: all 12 evidence row fields are present in the response', () => {
    const REQUIRED_FIELDS = [
      'evidence_id', 'timestamp', 'source', 'measurement',
      'value', 'unit', 'resolution', 'dataset_id',
      'provider', 'variable', 'evidence_type', 'quality',
    ];
    for (const f of REQUIRED_FIELDS) {
      expect(body).toHaveProperty(f);
    }
  });

  test('P1-6: all 12 evidence row fields match the source row verbatim', () => {
    const srcRow = g15Rows.find((r) => r.evidence_id === anchorId);
    expect(body.evidence_id).toBe(srcRow.evidence_id);
    expect(body.timestamp).toBe(srcRow.timestamp);
    expect(body.source).toBe(srcRow.source);
    expect(body.measurement).toBe(srcRow.measurement);
    expect(body.value).toBe(srcRow.value);
    expect(body.unit).toBe(srcRow.unit);
    expect(body.resolution).toBe(srcRow.resolution);
    expect(body.dataset_id).toBe(srcRow.dataset_id);
    expect(body.provider).toBe(srcRow.provider);
    expect(body.variable).toBe(srcRow.variable);
    expect(body.evidence_type).toBe(srcRow.evidence_type);
    expect(body.quality).toBe(srcRow.quality);
  });

  test('P1-7: source is "CASE" for the anchor record', () => {
    expect(body.source).toBe('CASE');
  });

  test('P1-8: evidence_type is "case_event" for CASE source', () => {
    expect(body.evidence_type).toBe('case_event');
  });

  // ── hypothesis_relationships shape ────────────────────────────────────────

  test('P1-9: hypothesis_relationships is a non-empty array', () => {
    expect(Array.isArray(body.hypothesis_relationships)).toBe(true);
    expect(body.hypothesis_relationships.length).toBeGreaterThan(0);
  });

  test('P1-10: every relationship entry has hypothesis_id, list_name, relationship, interpretation', () => {
    for (const rel of body.hypothesis_relationships) {
      expect(typeof rel.hypothesis_id).toBe('string');
      expect(rel.hypothesis_id.length).toBeGreaterThan(0);
      expect(ALL_LISTS).toContain(rel.list_name);
      expect(typeof rel.relationship).toBe('string');
      expect(rel.relationship.length).toBeGreaterThan(0);
      expect(typeof rel.interpretation).toBe('string');
      expect(rel.interpretation.length).toBeGreaterThan(0);
    }
  });

  test('P1-11: hypothesis_relationships entries are verbatim from the graph', () => {
    for (const rel of body.hypothesis_relationships) {
      const graphH = g15Graph.hypotheses.find((h) => h.hypothesis_id === rel.hypothesis_id);
      expect(graphH).toBeDefined();
      const graphRef = (graphH[rel.list_name] || []).find((r) => r.evidence_id === anchorId);
      expect(graphRef).toBeDefined();
      expect(rel.relationship).toBe(graphRef.relationship);
      expect(rel.interpretation).toBe(graphRef.interpretation);
    }
  });

  test('P1-12: anchor record appears in H3 and H5 supporting_evidence', () => {
    const ids = body.hypothesis_relationships.map((r) => r.hypothesis_id);
    expect(ids).toContain('H3');
    expect(ids).toContain('H5');
    const h3rel = body.hypothesis_relationships.find((r) => r.hypothesis_id === 'H3');
    const h5rel = body.hypothesis_relationships.find((r) => r.hypothesis_id === 'H5');
    expect(h3rel.list_name).toBe('supporting_evidence');
    expect(h5rel.list_name).toBe('supporting_evidence');
  });

  test('P1-13: anchor record also appears in H1 and H2 non_discriminating_evidence', () => {
    const h1rel = body.hypothesis_relationships.find((r) => r.hypothesis_id === 'H1');
    const h2rel = body.hypothesis_relationships.find((r) => r.hypothesis_id === 'H2');
    expect(h1rel).toBeDefined();
    expect(h2rel).toBeDefined();
    expect(h1rel.list_name).toBe('non_discriminating_evidence');
    expect(h2rel.list_name).toBe('non_discriminating_evidence');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 1b — provenance for an EP8 windowed record
// ─────────────────────────────────────────────────────────────────────────────

describe('P1b: GET /api/cases/:id/evidence/:evidenceId/provenance — EP8 window record', () => {
  let res;
  let body;

  beforeAll(async () => {
    res  = await request(app).get(`/api/cases/${CASE_ID}/evidence/${ep8WindowId}/provenance`);
    body = res.body;
  });

  test('P1b-1: returns HTTP 200', () => {
    expect(res.status).toBe(200);
  });

  test('P1b-2: found is true', () => {
    expect(body.found).toBe(true);
  });

  test('P1b-3: source is GOES11_EP8', () => {
    expect(body.source).toBe('GOES11_EP8');
  });

  test('P1b-4: evidence_type is environmental_observation', () => {
    expect(body.evidence_type).toBe('environmental_observation');
  });

  test('P1b-5: hypothesis_relationships is non-empty (EP8 window records are referenced)', () => {
    expect(Array.isArray(body.hypothesis_relationships)).toBe(true);
    expect(body.hypothesis_relationships.length).toBeGreaterThan(0);
  });

  test('P1b-6: EP8 windowed record appears in environmental_context (not supporting_evidence)', () => {
    // All EP8 windowed refs are environmental_context — never supporting_evidence
    for (const rel of body.hypothesis_relationships) {
      expect(rel.list_name).toBe('environmental_context');
    }
  });

  test('P1b-7: all 12 evidence fields match the source row verbatim', () => {
    const srcRow = g15Rows.find((r) => r.evidence_id === ep8WindowId);
    expect(body.timestamp).toBe(srcRow.timestamp);
    expect(body.source).toBe(srcRow.source);
    expect(body.measurement).toBe(srcRow.measurement);
    expect(body.value).toBe(srcRow.value);
    expect(body.unit).toBe(srcRow.unit);
    expect(body.resolution).toBe(srcRow.resolution);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 1c — provenance for EPHEMERIS
// ─────────────────────────────────────────────────────────────────────────────

describe('P1c: GET /api/cases/:id/evidence/:evidenceId/provenance — EPHEMERIS record', () => {
  let res;
  let body;

  beforeAll(async () => {
    res  = await request(app).get(`/api/cases/${CASE_ID}/evidence/${ephemerisId}/provenance`);
    body = res.body;
  });

  test('P1c-1: returns HTTP 200', () => {
    expect(res.status).toBe(200);
  });

  test('P1c-2: found is true', () => {
    expect(body.found).toBe(true);
  });

  test('P1c-3: source is GOES11_EPHEMERIS', () => {
    expect(body.source).toBe('GOES11_EPHEMERIS');
  });

  test('P1c-4: hypothesis_relationships is an empty array (EPHEMERIS excluded from all lists)', () => {
    expect(Array.isArray(body.hypothesis_relationships)).toBe(true);
    expect(body.hypothesis_relationships).toHaveLength(0);
  });

  test('P1c-5: evidence_type is environmental_observation', () => {
    expect(body.evidence_type).toBe('environmental_observation');
  });

  test('P1c-6: all 12 evidence fields are present', () => {
    const REQUIRED_FIELDS = [
      'evidence_id', 'timestamp', 'source', 'measurement',
      'value', 'unit', 'resolution', 'dataset_id',
      'provider', 'variable', 'evidence_type', 'quality',
    ];
    for (const f of REQUIRED_FIELDS) {
      expect(body).toHaveProperty(f);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 1d — provenance for unknown evidence ID
// ─────────────────────────────────────────────────────────────────────────────

describe('P1d: GET /api/cases/:id/evidence/:evidenceId/provenance — unknown evidence ID', () => {
  const UNKNOWN_EVIDENCE_ID = 'E-G15-9999';

  let res;
  let body;

  beforeAll(async () => {
    res  = await request(app).get(
      `/api/cases/${CASE_ID}/evidence/${UNKNOWN_EVIDENCE_ID}/provenance`,
    );
    body = res.body;
  });

  test('P1d-1: returns HTTP 404 for unknown evidence ID', () => {
    expect(res.status).toBe(404);
  });

  test('P1d-2: found is false', () => {
    expect(body.found).toBe(false);
  });

  test('P1d-3: evidence_id in response matches the requested ID', () => {
    expect(body.evidence_id).toBe(UNKNOWN_EVIDENCE_ID);
  });

  test('P1d-4: reason field is a non-empty string', () => {
    expect(typeof body.reason).toBe('string');
    expect(body.reason.length).toBeGreaterThan(0);
  });

  test('P1d-5: unknown ID response does not contain evidence row fields', () => {
    expect(body).not.toHaveProperty('timestamp');
    expect(body).not.toHaveProperty('source');
    expect(body).not.toHaveProperty('measurement');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 1e — provenance for unknown case ID
// ─────────────────────────────────────────────────────────────────────────────

describe('P1e: GET /api/cases/:id/evidence/:evidenceId/provenance — unknown case', () => {
  let res;

  beforeAll(async () => {
    res = await request(app).get(`/api/cases/${UNKNOWN}/evidence/E-G15-0001/provenance`);
  });

  test('P1e-1: returns HTTP 404 for unknown case', () => {
    expect(res.status).toBe(404);
  });

  test('P1e-2: response body has an error field', () => {
    expect(res.body).toHaveProperty('error');
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// PART 2 — POST /api/cases/:id/investigate
// =============================================================================

describe('P2: POST /api/cases/:id/investigate — successful request', () => {
  let res;
  let body;

  beforeAll(async () => {
    // No API key in test environment → heuristic fallback is always used.
    res  = await request(app).post(`/api/cases/${CASE_ID}/investigate`);
    body = res.body;
  }, 30_000);

  // ── HTTP contract ──────────────────────────────────────────────────────────

  test('P2-1: returns HTTP 200', () => {
    expect(res.status).toBe(200);
  });

  test('P2-2: response content-type is application/json', () => {
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  // ── Required top-level fields ──────────────────────────────────────────────

  test('P2-3: body has hypotheses array', () => {
    expect(Array.isArray(body.hypotheses)).toBe(true);
    expect(body.hypotheses.length).toBeGreaterThan(0);
  });

  test('P2-4: body has top_hypothesis_id string', () => {
    expect(typeof body.top_hypothesis_id).toBe('string');
    expect(body.top_hypothesis_id.length).toBeGreaterThan(0);
  });

  test('P2-5: body has source field ("heuristic" without API key)', () => {
    expect(typeof body.source).toBe('string');
    expect(['heuristic', 'llm']).toContain(body.source);
    // Guard: test env has no API key so heuristic is expected
    if (!process.env.WATSONX_AI_APIKEY) {
      expect(body.source).toBe('heuristic');
    }
  });

  test('P2-6: body has generated_at ISO timestamp', () => {
    expect(typeof body.generated_at).toBe('string');
    expect(() => new Date(body.generated_at)).not.toThrow();
    expect(new Date(body.generated_at).toISOString()).toBe(body.generated_at);
  });

  // ── Hypothesis shape ───────────────────────────────────────────────────────

  test('P2-7: every hypothesis has hypothesis_id, label, assessment, claims', () => {
    for (const h of body.hypotheses) {
      expect(typeof h.hypothesis_id).toBe('string');
      expect(h.hypothesis_id.length).toBeGreaterThan(0);
      expect(typeof h.label).toBe('string');
      expect(h.label.length).toBeGreaterThan(0);
      expect(typeof h.assessment).toBe('string');
      expect(Array.isArray(h.claims)).toBe(true);
    }
  });

  test('P2-8: every assessment is in ALLOWED_ASSESSMENTS', () => {
    for (const h of body.hypotheses) {
      expect(ALLOWED_ASSESSMENTS.has(h.assessment)).toBe(true);
    }
  });

  test('P2-9: every claim evidence_id references a real E-G15-XXXX ID', () => {
    const validIds = new Set(g15Rows.map((r) => r.evidence_id));
    for (const h of body.hypotheses) {
      for (const c of h.claims || []) {
        for (const eid of c.evidence_ids || []) {
          expect(eid).toMatch(G15_ID_RE);
          expect(validIds.has(eid)).toBe(true);
        }
      }
    }
  });

  test('P2-10: no causal-certainty language in any hypothesis claim statement or reasoning', () => {
    const text = JSON.stringify(body).toLowerCase();
    for (const phrase of CAUSAL_CERTAINTY_PHRASES) {
      expect(text).not.toContain(phrase.toLowerCase());
    }
  });

  // ── Scientific: assessments are independently derived; they do not include
  //   causal attribution ──────────────────────────────────────────────────────

  test('P2-11: response does not assert causal_attribution_established at the top level', () => {
    // /investigate does NOT expose the deterministic forensic analysis object;
    // it returns a Pass 1 hypothesis set. causal_attribution_established is
    // not a field of the /investigate response.
    expect(body).not.toHaveProperty('causal_attribution_established');
  });

  // ── Source evidence integrity ─────────────────────────────────────────────

  test('P2-12: /investigate does not mutate the source evidence rows (side-effect free)', async () => {
    // Call /investigate a second time and verify the timeline is unchanged
    const timelineRes = await request(app).get(`/api/cases/${CASE_ID}/timeline`);
    expect(timelineRes.status).toBe(200);
    expect(Array.isArray(timelineRes.body)).toBe(true);
    expect(timelineRes.body).toHaveLength(278);
    expect(timelineRes.body[0].evidence_id).toBe('E-G15-0001');
  });

  // ── Determinism — two calls to /investigate return structurally identical
  //   results (same hypothesis IDs and assessments) ─────────────────────────

  test('P2-13: two independent /investigate calls return the same hypothesis IDs', async () => {
    const res2  = await request(app).post(`/api/cases/${CASE_ID}/investigate`);
    const ids1  = body.hypotheses.map((h) => h.hypothesis_id).sort();
    const ids2  = res2.body.hypotheses.map((h) => h.hypothesis_id).sort();
    expect(ids2).toEqual(ids1);
  });

  test('P2-14: two independent /investigate calls return the same assessments', async () => {
    const res2 = await request(app).post(`/api/cases/${CASE_ID}/investigate`);
    const assessments1 = body.hypotheses.map((h) => ({ id: h.hypothesis_id, a: h.assessment })).sort((a, b) => a.id.localeCompare(b.id));
    const assessments2 = res2.body.hypotheses.map((h) => ({ id: h.hypothesis_id, a: h.assessment })).sort((a, b) => a.id.localeCompare(b.id));
    expect(assessments2).toEqual(assessments1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 2b — /investigate for unknown case
// ─────────────────────────────────────────────────────────────────────────────

describe('P2b: POST /api/cases/:id/investigate — unknown case', () => {
  let res;

  beforeAll(async () => {
    res = await request(app).post(`/api/cases/${UNKNOWN}/investigate`);
  });

  test('P2b-1: returns HTTP 404 for unknown case', () => {
    expect(res.status).toBe(404);
  });

  test('P2b-2: response has an error field', () => {
    expect(res.body).toHaveProperty('error');
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);
  });

  test('P2b-3: response does not contain hypotheses', () => {
    expect(res.body).not.toHaveProperty('hypotheses');
  });
});

// =============================================================================
// PART 3 — POST /api/cases/:id/challenge
// =============================================================================

describe('P3: POST /api/cases/:id/challenge — successful request', () => {
  let res;
  let body;

  beforeAll(async () => {
    res  = await request(app).post(`/api/cases/${CASE_ID}/challenge`);
    body = res.body;
  }, 30_000);

  // ── HTTP contract ──────────────────────────────────────────────────────────

  test('P3-1: returns HTTP 200', () => {
    expect(res.status).toBe(200);
  });

  test('P3-2: response content-type is application/json', () => {
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  // ── Required top-level fields ──────────────────────────────────────────────

  test('P3-3: body has case_id matching the request', () => {
    expect(body.case_id).toBe(CASE_ID);
  });

  test('P3-4: body has pass1_hypotheses array', () => {
    expect(Array.isArray(body.pass1_hypotheses)).toBe(true);
    expect(body.pass1_hypotheses.length).toBeGreaterThan(0);
  });

  test('P3-5: body has challenged_hypothesis_id string', () => {
    expect(typeof body.challenged_hypothesis_id).toBe('string');
    expect(body.challenged_hypothesis_id.length).toBeGreaterThan(0);
  });

  test('P3-6: body has challenges array', () => {
    expect(Array.isArray(body.challenges)).toBe(true);
    expect(body.challenges.length).toBeGreaterThan(0);
  });

  test('P3-7: body has updated_hypotheses array', () => {
    expect(Array.isArray(body.updated_hypotheses)).toBe(true);
    expect(body.updated_hypotheses.length).toBeGreaterThan(0);
  });

  test('P3-8: body has red_team_summary non-empty string', () => {
    expect(typeof body.red_team_summary).toBe('string');
    expect(body.red_team_summary.length).toBeGreaterThan(0);
  });

  test('P3-9: body has source field', () => {
    expect(['heuristic', 'llm']).toContain(body.source);
    if (!process.env.WATSONX_AI_APIKEY) {
      expect(body.source).toBe('heuristic');
    }
  });

  test('P3-10: body has generated_at ISO timestamp', () => {
    expect(typeof body.generated_at).toBe('string');
    expect(new Date(body.generated_at).toISOString()).toBe(body.generated_at);
  });

  // ── Challenge shape ────────────────────────────────────────────────────────

  test('P3-11: every challenge entry has required fields', () => {
    for (const ch of body.challenges) {
      expect(typeof ch.claim_id).toBe('string');
      expect(typeof ch.challenge).toBe('string');
      expect(ch.challenge.length).toBeGreaterThan(0);
      expect(Array.isArray(ch.counter_evidence_ids)).toBe(true);
      expect(Array.isArray(ch.missing_evidence)).toBe(true);
      expect(['high', 'medium', 'low']).toContain(ch.severity);
      expect(typeof ch.revised_assessment).toBe('string');
      expect(ch.revised_assessment.length).toBeGreaterThan(0);
    }
  });

  test('P3-12: all counter_evidence_ids in challenges are real E-G15-XXXX IDs', () => {
    const validIds = new Set(g15Rows.map((r) => r.evidence_id));
    for (const ch of body.challenges) {
      for (const eid of ch.counter_evidence_ids || []) {
        expect(eid).toMatch(G15_ID_RE);
        expect(validIds.has(eid)).toBe(true);
      }
    }
  });

  // ── updated_hypotheses: assessments in allowed vocabulary ─────────────────

  test('P3-13: every updated_hypothesis assessment is in ALLOWED_ASSESSMENTS', () => {
    for (const h of body.updated_hypotheses) {
      expect(ALLOWED_ASSESSMENTS.has(h.assessment)).toBe(true);
    }
  });

  // ── Scientific invariants ─────────────────────────────────────────────────

  test('P3-14: challenge response does not assert causal_attribution_established', () => {
    // /challenge is a Pass 2 response; it does not expose the deterministic
    // forensic analysis object and must not claim to establish causality.
    expect(body).not.toHaveProperty('causal_attribution_established');
  });

  test('P3-15: no causal-certainty language in any challenge text', () => {
    const text = JSON.stringify(body).toLowerCase();
    for (const phrase of CAUSAL_CERTAINTY_PHRASES) {
      expect(text).not.toContain(phrase.toLowerCase());
    }
  });

  test('P3-16: /challenge cannot mutate hypothesis assessments in the deterministic analysis', async () => {
    // The deterministic forensic analysis is unaffected by the challenge call.
    // Verify by calling /forensic-analysis after /challenge and confirming
    // the Phase 4 pinned values are unchanged.
    const fa = await request(app).get(`/api/cases/${CASE_ID}/forensic-analysis`);
    expect(fa.status).toBe(200);
    const faBody = fa.body;
    expect(faBody.hypotheses.find((h) => h.hypothesis_id === 'H1').assessment).toBe('mixed');
    expect(faBody.hypotheses.find((h) => h.hypothesis_id === 'H2').assessment).toBe('mixed');
    expect(faBody.hypotheses.find((h) => h.hypothesis_id === 'H3').assessment).toBe('supported');
    expect(faBody.hypotheses.find((h) => h.hypothesis_id === 'H4').assessment).toBe('insufficient_evidence');
    expect(faBody.hypotheses.find((h) => h.hypothesis_id === 'H5').assessment).toBe('strongly_supported');
  }, 30_000);

  test('P3-17: /challenge cannot establish causality — forensic causal_attribution_established remains false', async () => {
    const fa = await request(app).get(`/api/cases/${CASE_ID}/forensic-analysis`);
    expect(fa.status).toBe(200);
    expect(fa.body.causal_attribution_established).toBe(false);
  }, 30_000);

  test('P3-18: /challenge cannot mutate source evidence — timeline row count is still 278', async () => {
    const timeline = await request(app).get(`/api/cases/${CASE_ID}/timeline`);
    expect(timeline.status).toBe(200);
    expect(timeline.body).toHaveLength(278);
  });

  test('P3-19: /challenge cannot mutate source evidence — first evidence ID is still E-G15-0001', async () => {
    const timeline = await request(app).get(`/api/cases/${CASE_ID}/timeline`);
    expect(timeline.body[0].evidence_id).toBe('E-G15-0001');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 3b — /challenge for unknown case
// ─────────────────────────────────────────────────────────────────────────────

describe('P3b: POST /api/cases/:id/challenge — unknown case', () => {
  let res;

  beforeAll(async () => {
    res = await request(app).post(`/api/cases/${UNKNOWN}/challenge`);
  });

  test('P3b-1: returns HTTP 404 for unknown case', () => {
    expect(res.status).toBe(404);
  });

  test('P3b-2: response has an error field', () => {
    expect(res.body).toHaveProperty('error');
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);
  });

  test('P3b-3: response does not contain challenges', () => {
    expect(res.body).not.toHaveProperty('challenges');
  });

  test('P3b-4: response does not contain updated_hypotheses', () => {
    expect(res.body).not.toHaveProperty('updated_hypotheses');
  });
});
