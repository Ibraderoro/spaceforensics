'use strict';

/**
 * Phase 7.3 — Evidence Exploration API — HTTP Integration Tests
 *
 * All tests exercise the real HTTP application via supertest.
 * No existing test is modified or weakened.
 *
 * Endpoints covered:
 *   GET /api/cases/:id/hypotheses/:hid/evidence
 *   GET /api/cases/:id/evidence-index
 *   GET /api/cases/:id/environmental-context
 *   GET /api/cases/:id/hypotheses/compare
 *
 * Invariants verified:
 *   EX-1  Evidence records are read-only (responses do not mutate source data)
 *   EX-2  Every item is traceable to an evidence_id from the CSV
 *   EX-3  environmental_context is separate from supporting_evidence
 *   EX-4  contradicting_evidence is in its own field
 *   EX-5  non_discriminating_evidence is in its own field
 *   EX-6  EPHEMERIS records absent from hypothesis evidence views
 *   EX-7  Heuristic window note is always shown with environmental context
 *   EX-8  No numerical probabilities or confidence scores
 *   EX-9  Hypothesis assessments are read-only verbatim
 *   EX-10 Cross-case comparison is explicitly blocked by scope
 */

const request = require('supertest');
const { app, parseEvidenceCSV, buildEvidenceGraph } = require('../server');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const G15  = 'galaxy-15';
const TCA  = 'test-case-alpha';
const BOGUS = 'no-such-case-zzz99';

const EVIDENCE_LISTS = [
  'environmental_context',
  'supporting_evidence',
  'contradicting_evidence',
  'non_discriminating_evidence',
];

const G15_HYPOTHESIS_IDS = ['H1', 'H2', 'H3', 'H4', 'H5'];

// Known G15 assessments — these must never change (EX-9)
const G15_ASSESSMENTS = {
  H1: 'mixed',
  H2: 'mixed',
  H3: 'supported',
  H4: 'insufficient_evidence',
  H5: 'strongly_supported',
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────────

let g15Rows;
let g15Graph;
let g15EphemerisId;
let g15HypWithEnvCtx;   // a G15 hypothesis that has env context entries

beforeAll(async () => {
  jest.setTimeout(30_000);
  g15Rows  = await parseEvidenceCSV(G15);
  g15Graph = await buildEvidenceGraph(G15, g15Rows);

  const ephRow = g15Rows.find((r) => r.source === 'GOES11_EPHEMERIS');
  g15EphemerisId = ephRow ? ephRow.evidence_id : null;

  g15HypWithEnvCtx = g15Graph.hypotheses.find(
    (h) => (h.environmental_context || []).length > 0);
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────────

function assertErrorShape(body, expectedCode, expectedHttpStatus) {
  expect(typeof body.error_code).toBe('string');
  expect(body.error_code).toBe(expectedCode);
  expect(typeof body.error).toBe('string');
  expect(body.error.length).toBeGreaterThan(0);
  expect(body.status_code).toBe(expectedHttpStatus);
}

// =============================================================================
// HEV-1 — GET /api/cases/:id/hypotheses/:hid/evidence
// =============================================================================

describe('HEV-1: GET /api/cases/:id/hypotheses/:hid/evidence — H1 (env context present)', () => {
  let res;
  let body;

  beforeAll(async () => {
    const hid = g15HypWithEnvCtx
      ? g15HypWithEnvCtx.hypothesis_id
      : 'H1';
    res  = await request(app).get(`/api/cases/${G15}/hypotheses/${hid}/evidence`);
    body = res.body;
  });

  test('HEV-1-1: returns HTTP 200', () => {
    expect(res.status).toBe(200);
  });

  test('HEV-1-2: hypothesis_id is present', () => {
    expect(typeof body.hypothesis_id).toBe('string');
    expect(G15_HYPOTHESIS_IDS).toContain(body.hypothesis_id);
  });

  test('HEV-1-3: all four list fields are present (EX-3, EX-4, EX-5)', () => {
    for (const listName of EVIDENCE_LISTS) {
      expect(Array.isArray(body[listName])).toBe(true);
    }
  });

  test('HEV-1-4: environmental_context is non-empty for this hypothesis', () => {
    expect(body.environmental_context.length).toBeGreaterThan(0);
  });

  test('HEV-1-5: every entry in environmental_context has evidence_id, record (EX-2)', () => {
    for (const entry of body.environmental_context) {
      expect(typeof entry.evidence_id).toBe('string');
      expect(entry.evidence_id).toMatch(/^E-G15-\d{4}$/);
      expect(entry.record).not.toBeNull();
      expect(entry.record.evidence_id).toBe(entry.evidence_id);
    }
  });

  test('HEV-1-6: environmental_context entries have relationship and interpretation', () => {
    for (const entry of body.environmental_context) {
      expect(typeof entry.relationship).toBe('string');
      expect(entry.relationship.length).toBeGreaterThan(0);
      expect(typeof entry.interpretation).toBe('string');
      expect(entry.interpretation.length).toBeGreaterThan(0);
    }
  });

  test('HEV-1-7: heuristic_window_note is present and non-empty (EX-7)', () => {
    expect(typeof body.heuristic_window_note).toBe('string');
    expect(body.heuristic_window_note.length).toBeGreaterThan(0);
  });

  test('HEV-1-8: heuristic_window_note contains no causal language (EX-8)', () => {
    const note = body.heuristic_window_note.toLowerCase();
    expect(note).not.toContain('caused');
    expect(note).not.toContain('proves');
    expect(note).not.toContain('probability');
    expect(note).not.toContain('%');
  });

  test('HEV-1-9: EPHEMERIS absent from all four lists (EX-6)', () => {
    if (!g15EphemerisId) return;
    for (const listName of EVIDENCE_LISTS) {
      const ids = body[listName].map((e) => e.evidence_id);
      expect(ids).not.toContain(g15EphemerisId);
    }
  });

  test('HEV-1-10: assessment is the verbatim graph value (EX-9)', () => {
    const graphH = g15Graph.hypotheses.find((h) => h.hypothesis_id === body.hypothesis_id);
    expect(body.assessment).toBe(graphH.assessment);
    expect(body.assessment).toBe(G15_ASSESSMENTS[body.hypothesis_id]);
  });

  test('HEV-1-11: no numerical probability field (EX-8)', () => {
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/"probability"|"confidence"|"score"|"likelihood"/);
  });

  test('HEV-1-12: all evidence_ids resolve to valid G15 CSV IDs (EX-2)', () => {
    const csvIds = new Set(g15Rows.map((r) => r.evidence_id));
    for (const listName of EVIDENCE_LISTS) {
      for (const entry of body[listName]) {
        expect(csvIds.has(entry.evidence_id)).toBe(true);
      }
    }
  });
});

describe('HEV-1b: GET /api/cases/:id/hypotheses/:hid/evidence — H4 (no evidence at all)', () => {
  let res;
  let body;

  beforeAll(async () => {
    res  = await request(app).get(`/api/cases/${G15}/hypotheses/H4/evidence`);
    body = res.body;
  });

  test('HEV-1b-1: returns HTTP 200', () => {
    expect(res.status).toBe(200);
  });

  test('HEV-1b-2: all four lists are empty arrays', () => {
    for (const listName of EVIDENCE_LISTS) {
      expect(body[listName]).toHaveLength(0);
    }
  });

  test('HEV-1b-3: heuristic_window_note is null when no environmental_context (EX-7)', () => {
    expect(body.heuristic_window_note).toBeNull();
  });

  test('HEV-1b-4: assessment is "insufficient_evidence" verbatim (EX-9)', () => {
    expect(body.assessment).toBe('insufficient_evidence');
  });
});

describe('HEV-1c: GET /api/cases/:id/hypotheses/:hid/evidence — error cases', () => {
  test('HEV-1c-1: returns 404 for unknown case', async () => {
    const res = await request(app).get(`/api/cases/${BOGUS}/hypotheses/H1/evidence`);
    expect(res.status).toBe(404);
    assertErrorShape(res.body, 'CASE_NOT_FOUND', 404);
  });

  test('HEV-1c-2: error message contains unknown case ID', async () => {
    const res = await request(app).get(`/api/cases/${BOGUS}/hypotheses/H1/evidence`);
    expect(res.body.error).toContain(BOGUS);
  });

  test('HEV-1c-3: returns 404 for unknown hypothesis_id in a valid case', async () => {
    const res = await request(app).get(`/api/cases/${G15}/hypotheses/HFAKE/evidence`);
    expect(res.status).toBe(404);
    assertErrorShape(res.body, 'HYPOTHESIS_NOT_FOUND', 404);
  });
});

// =============================================================================
// HEV-2 — GET /api/cases/:id/evidence-index
// =============================================================================

describe('HEV-2: GET /api/cases/:id/evidence-index', () => {
  let res;
  let body;

  beforeAll(async () => {
    res  = await request(app).get(`/api/cases/${G15}/evidence-index`);
    body = res.body;
  });

  test('HEV-2-1: returns HTTP 200', () => {
    expect(res.status).toBe(200);
  });

  test('HEV-2-2: body contains case_id, evidence_count, and evidence array', () => {
    expect(body.case_id).toBe(G15);
    expect(typeof body.evidence_count).toBe('number');
    expect(Array.isArray(body.evidence)).toBe(true);
  });

  test('HEV-2-3: evidence_count matches evidence array length', () => {
    expect(body.evidence_count).toBe(body.evidence.length);
  });

  test('HEV-2-4: every entry has evidence_id, record, hypothesis_relationships (EX-2)', () => {
    for (const entry of body.evidence) {
      expect(typeof entry.evidence_id).toBe('string');
      expect(entry.record).not.toBeNull();
      expect(entry.record.evidence_id).toBe(entry.evidence_id);
      expect(Array.isArray(entry.hypothesis_relationships)).toBe(true);
    }
  });

  test('HEV-2-5: every evidence_id matches G15 pattern (EX-2)', () => {
    for (const entry of body.evidence) {
      expect(entry.evidence_id).toMatch(/^E-G15-\d{4}$/);
    }
  });

  test('HEV-2-6: EPHEMERIS absent from index (EX-6)', () => {
    if (!g15EphemerisId) return;
    const indexIds = body.evidence.map((e) => e.evidence_id);
    expect(indexIds).not.toContain(g15EphemerisId);
  });

  test('HEV-2-7: evidence_ids in index are unique (no duplicates)', () => {
    const ids = body.evidence.map((e) => e.evidence_id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  test('HEV-2-8: hypothesis_relationships list_name values are from the canonical four (EX-3, EX-4, EX-5)', () => {
    for (const entry of body.evidence) {
      for (const rel of entry.hypothesis_relationships) {
        expect(EVIDENCE_LISTS).toContain(rel.list_name);
      }
    }
  });

  test('HEV-2-9: no numerical probability field in any index entry (EX-8)', () => {
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/"probability"|"confidence"|"score"|"likelihood"/);
  });

  test('HEV-2-10: returns 404 for unknown case', async () => {
    const res = await request(app).get(`/api/cases/${BOGUS}/evidence-index`);
    expect(res.status).toBe(404);
    assertErrorShape(res.body, 'CASE_NOT_FOUND', 404);
  });
});

// =============================================================================
// HEV-3 — GET /api/cases/:id/environmental-context
// =============================================================================

describe('HEV-3: GET /api/cases/:id/environmental-context', () => {
  let res;
  let body;

  beforeAll(async () => {
    res  = await request(app).get(`/api/cases/${G15}/environmental-context`);
    body = res.body;
  });

  test('HEV-3-1: returns HTTP 200', () => {
    expect(res.status).toBe(200);
  });

  test('HEV-3-2: body contains case_id, heuristic_window_note, records', () => {
    expect(body.case_id).toBe(G15);
    expect(typeof body.heuristic_window_note).toBe('string');
    expect(Array.isArray(body.records)).toBe(true);
  });

  test('HEV-3-3: heuristic_window_note is non-empty (EX-7)', () => {
    expect(body.heuristic_window_note.length).toBeGreaterThan(0);
  });

  test('HEV-3-4: heuristic_window_note contains no causal language (EX-8)', () => {
    const note = body.heuristic_window_note.toLowerCase();
    expect(note).not.toContain('caused');
    expect(note).not.toContain('proves');
    expect(note).not.toContain('probability');
    expect(note).not.toContain('confirms causation');
  });

  test('HEV-3-5: records is non-empty for galaxy-15', () => {
    expect(body.records.length).toBeGreaterThan(0);
  });

  test('HEV-3-6: every record has evidence_id, record fields, referenced_by (EX-2)', () => {
    for (const r of body.records) {
      expect(typeof r.evidence_id).toBe('string');
      expect(r.evidence_id).toMatch(/^E-G15-\d{4}$/);
      expect(r.record).not.toBeNull();
      expect(r.record.evidence_id).toBe(r.evidence_id);
      expect(Array.isArray(r.referenced_by)).toBe(true);
      expect(r.referenced_by.length).toBeGreaterThan(0);
    }
  });

  test('HEV-3-7: EPHEMERIS is absent from environmental context records (EX-6)', () => {
    if (!g15EphemerisId) return;
    const ids = body.records.map((r) => r.evidence_id);
    expect(ids).not.toContain(g15EphemerisId);
  });

  test('HEV-3-8: environmental context records are not in any supporting_evidence list (EX-3)', () => {
    const ecIds = new Set(body.records.map((r) => r.evidence_id));
    for (const h of g15Graph.hypotheses) {
      for (const ref of h.supporting_evidence || []) {
        expect(ecIds.has(ref.evidence_id)).toBe(false);
      }
    }
  });

  test('HEV-3-9: referenced_by contains only valid hypothesis_ids', () => {
    const validHids = new Set(g15Graph.hypotheses.map((h) => h.hypothesis_id));
    for (const r of body.records) {
      for (const hid of r.referenced_by) {
        expect(validHids.has(hid)).toBe(true);
      }
    }
  });

  test('HEV-3-10: no numerical probability field in response (EX-8)', () => {
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/"probability"|"confidence"|"score"|"likelihood"/);
  });

  test('HEV-3-11: returns 404 for unknown case', async () => {
    const res = await request(app).get(`/api/cases/${BOGUS}/environmental-context`);
    expect(res.status).toBe(404);
    assertErrorShape(res.body, 'CASE_NOT_FOUND', 404);
  });
});

// =============================================================================
// HEV-4 — GET /api/cases/:id/hypotheses/compare — all hypotheses
// =============================================================================

describe('HEV-4: GET /api/cases/:id/hypotheses/compare — all hypotheses', () => {
  let res;
  let body;

  beforeAll(async () => {
    res  = await request(app).get(`/api/cases/${G15}/hypotheses/compare`);
    body = res.body;
  });

  test('HEV-4-1: returns HTTP 200', () => {
    expect(res.status).toBe(200);
  });

  test('HEV-4-2: case_id is correct', () => {
    expect(body.case_id).toBe(G15);
  });

  test('HEV-4-3: causal_attribution_established is false (EX-9)', () => {
    expect(body.causal_attribution_established).toBe(false);
  });

  test('HEV-4-4: hypothesis_ids contains all five G15 hypotheses', () => {
    expect(body.hypothesis_ids.sort()).toEqual(G15_HYPOTHESIS_IDS.sort());
  });

  test('HEV-4-5: shared_evidence and exclusive_evidence are present arrays', () => {
    expect(Array.isArray(body.shared_evidence)).toBe(true);
    expect(Array.isArray(body.exclusive_evidence)).toBe(true);
  });

  test('HEV-4-6: every shared_evidence item has evidence_id, record, appears_in (EX-2)', () => {
    for (const e of body.shared_evidence) {
      expect(typeof e.evidence_id).toBe('string');
      expect(e.evidence_id).toMatch(/^E-G15-\d{4}$/);
      expect(e.record).not.toBeNull();
      expect(Array.isArray(e.appears_in)).toBe(true);
      expect(e.appears_in.length).toBeGreaterThanOrEqual(2);
    }
  });

  test('HEV-4-7: every exclusive_evidence item belongs to exactly one hypothesis', () => {
    for (const e of body.exclusive_evidence) {
      expect(typeof e.hypothesis_id).toBe('string');
      expect(G15_HYPOTHESIS_IDS).toContain(e.hypothesis_id);
      expect(EVIDENCE_LISTS).toContain(e.list_name);
    }
  });

  test('HEV-4-8: all evidence_ids in comparison exist in the G15 CSV (EX-2)', () => {
    const csvIds = new Set(g15Rows.map((r) => r.evidence_id));
    for (const e of [...body.shared_evidence, ...body.exclusive_evidence]) {
      expect(csvIds.has(e.evidence_id)).toBe(true);
    }
  });

  test('HEV-4-9: EPHEMERIS absent from shared and exclusive lists (EX-6)', () => {
    if (!g15EphemerisId) return;
    const allIds = [
      ...body.shared_evidence.map((e) => e.evidence_id),
      ...body.exclusive_evidence.map((e) => e.evidence_id),
    ];
    expect(allIds).not.toContain(g15EphemerisId);
  });

  test('HEV-4-10: hypothesis assessments in comparison are verbatim (EX-9)', () => {
    for (const hEntry of body.hypotheses) {
      expect(hEntry.assessment).toBe(G15_ASSESSMENTS[hEntry.hypothesis_id]);
    }
  });

  test('HEV-4-11: no numerical probability field anywhere (EX-8)', () => {
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/"probability"|"confidence"|"score"|"likelihood"/);
  });

  test('HEV-4-12: comparison_note describes same-case scope (EX-10)', () => {
    expect(typeof body.comparison_note).toBe('string');
    expect(body.comparison_note.toLowerCase()).toContain('same case');
  });

  test('HEV-4-13: evidence_counts per hypothesis sum matches the graph', () => {
    for (const hEntry of body.hypotheses) {
      const graphH = g15Graph.hypotheses.find((h) => h.hypothesis_id === hEntry.hypothesis_id);
      for (const listName of EVIDENCE_LISTS) {
        expect(hEntry.evidence_counts[listName]).toBe((graphH[listName] || []).length);
      }
    }
  });
});

// =============================================================================
// HEV-5 — GET /api/cases/:id/hypotheses/compare — subset
// =============================================================================

describe('HEV-5: GET /api/cases/:id/hypotheses/compare — hypothesis_ids subset', () => {
  let res;
  let body;

  beforeAll(async () => {
    res  = await request(app).get(
      `/api/cases/${G15}/hypotheses/compare?hypothesis_ids=H1,H2`);
    body = res.body;
  });

  test('HEV-5-1: returns HTTP 200', () => {
    expect(res.status).toBe(200);
  });

  test('HEV-5-2: hypothesis_ids is exactly [H1, H2]', () => {
    expect(body.hypothesis_ids.sort()).toEqual(['H1', 'H2']);
  });

  test('HEV-5-3: hypotheses array has exactly 2 entries', () => {
    expect(body.hypotheses).toHaveLength(2);
  });

  test('HEV-5-4: H1 and H2 share the anchor record in non_discriminating_evidence', () => {
    const anchorRow = g15Rows.find((r) => r.source === 'CASE');
    const sharedIds = body.shared_evidence.map((e) => e.evidence_id);
    expect(sharedIds).toContain(anchorRow.evidence_id);
  });

  test('HEV-5-5: H3, H4, H5 evidence is not included in the subset comparison', () => {
    const allIds = [
      ...body.shared_evidence.map((e) => e.evidence_id),
      ...body.exclusive_evidence.map((e) => e.evidence_id),
    ];
    // Verify no exclusive evidence belongs to H3/H4/H5
    for (const e of body.exclusive_evidence) {
      expect(['H1','H2']).toContain(e.hypothesis_id);
    }
    // All hypothesis entries are for H1/H2 only
    for (const h of body.hypotheses) {
      expect(['H1','H2']).toContain(h.hypothesis_id);
    }
    void allIds;
  });

  test('HEV-5-6: returns 404 for unknown hypothesis_id in filter', async () => {
    const res = await request(app).get(
      `/api/cases/${G15}/hypotheses/compare?hypothesis_ids=H1,HFAKE`);
    expect(res.status).toBe(404);
    assertErrorShape(res.body, 'HYPOTHESIS_NOT_FOUND', 404);
  });

  test('HEV-5-7: returns 404 for unknown case', async () => {
    const res = await request(app).get(
      `/api/cases/${BOGUS}/hypotheses/compare`);
    expect(res.status).toBe(404);
    assertErrorShape(res.body, 'CASE_NOT_FOUND', 404);
  });
});

// =============================================================================
// HEV-6 — Forensic pipeline baseline preservation (EX-1)
// After calling all exploration endpoints, the forensic analysis must be
// byte-identical to the pre-call baseline.
// =============================================================================

describe('HEV-6: forensic pipeline is unaffected by exploration API calls (EX-1)', () => {
  let baselineAssessments;

  beforeAll(async () => {
    jest.setTimeout(30_000);
    const res = await request(app).get(`/api/cases/${G15}/forensic-analysis`);
    baselineAssessments = res.body.hypotheses.reduce((acc, h) => {
      acc[h.hypothesis_id] = h.assessment;
      return acc;
    }, {});
  }, 30_000);

  test('HEV-6-1: after all exploration calls, hypothesis assessments are unchanged (EX-1, EX-9)', async () => {
    // Exercise all exploration endpoints
    await request(app).get(`/api/cases/${G15}/hypotheses/H1/evidence`);
    await request(app).get(`/api/cases/${G15}/evidence-index`);
    await request(app).get(`/api/cases/${G15}/environmental-context`);
    await request(app).get(`/api/cases/${G15}/hypotheses/compare`);

    const res = await request(app).get(`/api/cases/${G15}/forensic-analysis`);
    for (const h of res.body.hypotheses) {
      expect(h.assessment).toBe(baselineAssessments[h.hypothesis_id]);
    }
  }, 30_000);

  test('HEV-6-2: causal_attribution_established remains false after exploration (EX-1)', async () => {
    const res = await request(app).get(`/api/cases/${G15}/forensic-analysis`);
    expect(res.body.causal_attribution_established).toBe(false);
  }, 30_000);
});

// =============================================================================
// HEV-7 — test-case-alpha exploration (second case correct isolation)
// =============================================================================

describe('HEV-7: test-case-alpha exploration — case isolation', () => {
  test('HEV-7-1: TCA hypothesis evidence view returns 200 and TCA evidence IDs', async () => {
    const res = await request(app).get(`/api/cases/${TCA}/hypotheses/H1/evidence`);
    expect(res.status).toBe(200);
    const allIds = EVIDENCE_LISTS.flatMap((l) =>
      (res.body[l] || []).map((e) => e.evidence_id));
    for (const id of allIds) {
      expect(id).toMatch(/^E-TCA-\d{4}$/);
    }
  });

  test('HEV-7-2: TCA evidence-index returns TCA evidence IDs only', async () => {
    const res = await request(app).get(`/api/cases/${TCA}/evidence-index`);
    expect(res.status).toBe(200);
    for (const entry of res.body.evidence) {
      expect(entry.evidence_id).toMatch(/^E-TCA-\d{4}$/);
    }
  });

  test('HEV-7-3: TCA environmental-context returns TCA evidence IDs only', async () => {
    const res = await request(app).get(`/api/cases/${TCA}/environmental-context`);
    expect(res.status).toBe(200);
    for (const r of res.body.records) {
      expect(r.evidence_id).toMatch(/^E-TCA-\d{4}$/);
    }
  });

  test('HEV-7-4: TCA comparison returns TCA evidence IDs only — no G15 IDs bleed in', async () => {
    const res = await request(app).get(`/api/cases/${TCA}/hypotheses/compare`);
    expect(res.status).toBe(200);
    const allIds = [
      ...res.body.shared_evidence.map((e) => e.evidence_id),
      ...res.body.exclusive_evidence.map((e) => e.evidence_id),
    ];
    for (const id of allIds) {
      expect(id).toMatch(/^E-TCA-\d{4}$/);
    }
  });

  test('HEV-7-5: TCA comparison case_id is test-case-alpha, not galaxy-15 (EX-10)', async () => {
    const res = await request(app).get(`/api/cases/${TCA}/hypotheses/compare`);
    expect(res.body.case_id).toBe(TCA);
  });
});
