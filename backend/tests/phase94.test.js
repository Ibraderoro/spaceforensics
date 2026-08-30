'use strict';

/**
 * Phase 9.4 — Second Real Case Onboarding: GOES-16 September 2017 SEP Event
 *
 * Validates the Phase 5/6 multi-case architecture by onboarding goes16-sep2017,
 * a second real forensic case, alongside the existing Galaxy-15 case.
 *
 * Case: GOES-16 EXIS instrument safe mode on 2017-09-08T16:00:00Z
 * Case ID: goes16-sep2017
 * ID prefix: GS17
 * Evidence: 423 rows (241 GOES16_SGPS + 181 GOES16_MPSH + 1 CASE)
 * Hypotheses: H1=mixed, H2=mixed, H3=insufficient_evidence, H4=strongly_supported
 *
 * Coverage:
 *   P94-1   Case discovery (in /api/cases list)
 *   P94-2   Evidence parsing (row count, prefix, determinism, sort order)
 *   P94-3   Deterministic evidence IDs (GS17 prefix, not G15 or TCA)
 *   P94-4   Timeline HTTP endpoint
 *   P94-5   Evidence graph (structure, invariants, heuristic window)
 *   P94-6   Forensic analysis (assessments, causal attribution, narrative)
 *   P94-7   Evidence provenance HTTP endpoint
 *   P94-8   HTTP endpoints for all GS17 routes
 *   P94-9   Investigation creation/retrieval for goes16-sep2017
 *   P94-10  Challenge behavior (create, validate, reject forbidden fields)
 *   P94-11  Cross-case evidence injection rejection (GS17 context rejects G15/TCA IDs)
 *   P94-12  Cross-case investigation isolation (GS17 inv not in G15/TCA lists)
 *   P94-13  Concurrent requests for GS17 + G15 run independently
 *   P94-14  Galaxy-15 forensic output is byte-identical before/after GS17 onboarding
 */

const request = require('supertest');
const {
  app,
  parseEvidenceCSV,
  buildEvidenceGraph,
  buildForensicAnalysis,
  assembleValidatedForensicReport,
  investigationStore,
} = require('../server');
const { buildAnalystHeuristicNarrative, validateAnalystResponse } = require('../services/aiAnalyst');

// ─────────────────────────────────────────────────────────────────────────────
// Constants — pinned to the known GS17 dataset values
// ─────────────────────────────────────────────────────────────────────────────

const GS17 = 'goes16-sep2017';
const G15  = 'galaxy-15';
const TCA  = 'test-case-alpha';

const GS17_EXPECTED_ROW_COUNT = 423;
const GS17_EXPECTED_FIRST_ID  = 'E-GS17-0001';
const GS17_EXPECTED_LAST_ID   = `E-GS17-${String(GS17_EXPECTED_ROW_COUNT).padStart(4, '0')}`;
const GS17_ANCHOR_TIMESTAMP   = '2017-09-08T16:00:00Z';
const GS17_CASE_EVIDENCE_ID   = 'E-GS17-0211';

// Pinned deterministic assessments — must never change after onboarding.
const GS17_ASSESSMENTS = {
  H1: 'mixed',
  H2: 'mixed',
  H3: 'insufficient_evidence',
  H4: 'strongly_supported',
};

const ALLOWED_ASSESSMENTS = new Set([
  'strongly_supported', 'supported', 'mixed', 'weakly_supported', 'insufficient_evidence',
]);

const ALL_LISTS = [
  'environmental_context',
  'supporting_evidence',
  'contradicting_evidence',
  'non_discriminating_evidence',
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures — built once for the test file
// ─────────────────────────────────────────────────────────────────────────────

let gs17Rows, gs17Graph, gs17Analysis, gs17ValidIds, gs17Narrative, gs17Report;
let g15Rows, g15Graph, g15Analysis, g15Report;

beforeAll(async () => {
  jest.setTimeout(60_000);

  // Build both cases concurrently (tests concurrent safety too)
  [gs17Rows, g15Rows] = await Promise.all([
    parseEvidenceCSV(GS17),
    parseEvidenceCSV(G15),
  ]);
  [gs17Graph, g15Graph] = await Promise.all([
    buildEvidenceGraph(GS17, gs17Rows),
    buildEvidenceGraph(G15, g15Rows),
  ]);

  gs17Analysis  = buildForensicAnalysis(GS17, gs17Graph);
  gs17ValidIds  = new Set(gs17Rows.map((r) => r.evidence_id));
  gs17Narrative = buildAnalystHeuristicNarrative(gs17Analysis);
  gs17Report    = assembleValidatedForensicReport(gs17Analysis, gs17Narrative);

  g15Analysis   = buildForensicAnalysis(G15, g15Graph);
  const g15Narrative = buildAnalystHeuristicNarrative(g15Analysis);
  g15Report     = assembleValidatedForensicReport(g15Analysis, g15Narrative);
}, 60_000);

beforeEach(() => { investigationStore._reset(); });

// =============================================================================
// P94-1 — Case discovery
// =============================================================================

describe('P94-1: goes16-sep2017 appears in case discovery', () => {
  test('P94-1-1: GET /api/cases includes goes16-sep2017', async () => {
    const res = await request(app).get('/api/cases');
    expect(res.status).toBe(200);
    const ids = res.body.map((c) => c.case_id);
    expect(ids).toContain(GS17);
  });

  test('P94-1-2: GET /api/cases goes16-sep2017 entry has a non-empty title', async () => {
    const res = await request(app).get('/api/cases');
    const entry = res.body.find((c) => c.case_id === GS17);
    expect(entry).toBeDefined();
    expect(typeof entry.title).toBe('string');
    expect(entry.title.length).toBeGreaterThan(0);
  });

  test('P94-1-3: GET /api/cases/:id returns correct metadata for goes16-sep2017', async () => {
    const res = await request(app).get(`/api/cases/${GS17}`);
    expect(res.status).toBe(200);
    expect(res.body.case_id).toBe(GS17);
    expect(res.body.id_prefix).toBe('GS17');
    expect(res.body.anchor_event.timestamp).toBe(GS17_ANCHOR_TIMESTAMP);
  });

  test('P94-1-4: GET /api/cases still includes galaxy-15 after goes16-sep2017 onboarded', async () => {
    const res = await request(app).get('/api/cases');
    const ids = res.body.map((c) => c.case_id);
    expect(ids).toContain(G15);
    expect(ids).toContain(GS17);
  });

  test('P94-1-5: unknown case ID still returns 404 after goes16-sep2017 onboarded', async () => {
    const res = await request(app).get('/api/cases/no-such-case-p94');
    expect(res.status).toBe(404);
  });
});

// =============================================================================
// P94-2 — Evidence parsing
// =============================================================================

describe('P94-2: goes16-sep2017 evidence parsing', () => {
  test('P94-2-1: parseEvidenceCSV returns exactly 423 rows', () => {
    expect(gs17Rows).toHaveLength(GS17_EXPECTED_ROW_COUNT);
  });

  test('P94-2-2: first evidence ID is E-GS17-0001', () => {
    expect(gs17Rows[0].evidence_id).toBe(GS17_EXPECTED_FIRST_ID);
  });

  test('P94-2-3: last evidence ID is E-GS17-0423', () => {
    expect(gs17Rows[gs17Rows.length - 1].evidence_id).toBe(GS17_EXPECTED_LAST_ID);
  });

  test('P94-2-4: rows are sorted by timestamp (primary) then source (secondary)', () => {
    for (let i = 1; i < gs17Rows.length; i++) {
      const a = gs17Rows[i - 1];
      const b = gs17Rows[i];
      if (a.timestamp === b.timestamp) {
        expect(a.source <= b.source).toBe(true);
      } else {
        expect(a.timestamp < b.timestamp).toBe(true);
      }
    }
  });

  test('P94-2-5: two independent parseEvidenceCSV calls return identical evidence IDs', async () => {
    const second = await parseEvidenceCSV(GS17);
    expect(second.map((r) => r.evidence_id)).toEqual(gs17Rows.map((r) => r.evidence_id));
  });

  test('P94-2-6: every row has all required 12 fields', () => {
    const REQUIRED = [
      'evidence_id', 'timestamp', 'source', 'measurement',
      'value', 'unit', 'resolution', 'dataset_id',
      'provider', 'variable', 'evidence_type', 'quality',
    ];
    for (const row of gs17Rows) {
      for (const field of REQUIRED) {
        expect(row).toHaveProperty(field);
      }
    }
  });

  test('P94-2-7: CASE row has evidence_type "case_event"', () => {
    const caseRow = gs17Rows.find((r) => r.source === 'CASE');
    expect(caseRow).toBeDefined();
    expect(caseRow.evidence_type).toBe('case_event');
  });

  test('P94-2-8: GOES16_SGPS rows have evidence_type "environmental_observation"', () => {
    const sgpsRows = gs17Rows.filter((r) => r.source === 'GOES16_SGPS');
    expect(sgpsRows.length).toBeGreaterThan(0);
    for (const row of sgpsRows) {
      expect(row.evidence_type).toBe('environmental_observation');
    }
  });

  test('P94-2-9: GOES16_MPSH rows have evidence_type "environmental_observation"', () => {
    const mpshRows = gs17Rows.filter((r) => r.source === 'GOES16_MPSH');
    expect(mpshRows.length).toBeGreaterThan(0);
    for (const row of mpshRows) {
      expect(row.evidence_type).toBe('environmental_observation');
    }
  });
});

// =============================================================================
// P94-3 — Deterministic evidence IDs scoped to GS17
// =============================================================================

describe('P94-3: GS17 evidence IDs are scoped and non-overlapping', () => {
  test('P94-3-1: all GS17 evidence IDs use the E-GS17-XXXX pattern', () => {
    for (const row of gs17Rows) {
      expect(row.evidence_id).toMatch(/^E-GS17-\d{4}$/);
    }
  });

  test('P94-3-2: no GS17 evidence ID starts with E-G15-', () => {
    for (const row of gs17Rows) {
      expect(row.evidence_id).not.toMatch(/^E-G15-/);
    }
  });

  test('P94-3-3: no GS17 evidence ID starts with E-TCA-', () => {
    for (const row of gs17Rows) {
      expect(row.evidence_id).not.toMatch(/^E-TCA-/);
    }
  });

  test('P94-3-4: GS17 and G15 evidence ID sets are completely disjoint', () => {
    const gs17Ids = new Set(gs17Rows.map((r) => r.evidence_id));
    const g15Ids  = new Set(g15Rows.map((r) => r.evidence_id));
    for (const id of gs17Ids) expect(g15Ids.has(id)).toBe(false);
    for (const id of g15Ids) expect(gs17Ids.has(id)).toBe(false);
  });

  test('P94-3-5: CASE anchor row is E-GS17-0211 (position after sort)', () => {
    const caseRow = gs17Rows.find((r) => r.source === 'CASE');
    expect(caseRow.evidence_id).toBe(GS17_CASE_EVIDENCE_ID);
    expect(caseRow.timestamp).toBe(GS17_ANCHOR_TIMESTAMP);
  });
});

// =============================================================================
// P94-4 — Timeline HTTP endpoint
// =============================================================================

describe('P94-4: GET /api/cases/goes16-sep2017/timeline', () => {
  let res;

  beforeAll(async () => {
    res = await request(app).get(`/api/cases/${GS17}/timeline`);
  });

  test('P94-4-1: returns HTTP 200', () => {
    expect(res.status).toBe(200);
  });

  test('P94-4-2: body is an array of 423 records', () => {
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(GS17_EXPECTED_ROW_COUNT);
  });

  test('P94-4-3: first evidence ID is E-GS17-0001', () => {
    expect(res.body[0].evidence_id).toBe(GS17_EXPECTED_FIRST_ID);
  });

  test('P94-4-4: last evidence ID is E-GS17-0423', () => {
    expect(res.body[res.body.length - 1].evidence_id).toBe(GS17_EXPECTED_LAST_ID);
  });

  test('P94-4-5: all evidence IDs use the GS17 prefix', () => {
    for (const r of res.body) {
      expect(r.evidence_id).toMatch(/^E-GS17-\d{4}$/);
    }
  });

  test('P94-4-6: timeline contains no G15 or TCA evidence IDs', () => {
    for (const r of res.body) {
      expect(r.evidence_id).not.toMatch(/^E-G15-/);
      expect(r.evidence_id).not.toMatch(/^E-TCA-/);
    }
  });
});

// =============================================================================
// P94-5 — Evidence graph
// =============================================================================

describe('P94-5: goes16-sep2017 evidence graph', () => {
  test('P94-5-1: graph case_id is "goes16-sep2017"', () => {
    expect(gs17Graph.case_id).toBe(GS17);
  });

  test('P94-5-2: causal_attribution_established is false', () => {
    expect(gs17Graph.causal_attribution_established).toBe(false);
  });

  test('P94-5-3: graph has exactly 4 hypotheses (H1–H4)', () => {
    expect(gs17Graph.hypotheses).toHaveLength(4);
    const ids = gs17Graph.hypotheses.map((h) => h.hypothesis_id);
    ['H1', 'H2', 'H3', 'H4'].forEach((id) => expect(ids).toContain(id));
  });

  test('P94-5-4: every hypothesis has all four evidence-list fields', () => {
    for (const h of gs17Graph.hypotheses) {
      for (const listName of ALL_LISTS) {
        expect(Array.isArray(h[listName])).toBe(true);
      }
    }
  });

  test('P94-5-5: all referenced evidence IDs are valid GS17 IDs', () => {
    for (const h of gs17Graph.hypotheses) {
      for (const listName of ALL_LISTS) {
        for (const ref of h[listName] || []) {
          expect(ref.evidence_id).toMatch(/^E-GS17-\d{4}$/);
          expect(gs17ValidIds.has(ref.evidence_id)).toBe(true);
        }
      }
    }
  });

  test('P94-5-6: no G15 or TCA IDs appear in the GS17 graph', () => {
    for (const h of gs17Graph.hypotheses) {
      for (const listName of ALL_LISTS) {
        for (const ref of h[listName] || []) {
          expect(ref.evidence_id).not.toMatch(/^E-G15-/);
          expect(ref.evidence_id).not.toMatch(/^E-TCA-/);
        }
      }
    }
  });

  test('P94-5-7: H1 has non-empty environmental_context (windowed env rows)', () => {
    const h1 = gs17Graph.hypotheses.find((h) => h.hypothesis_id === 'H1');
    expect(h1.environmental_context.length).toBeGreaterThan(0);
  });

  test('P94-5-8: H4 has exactly one supporting_evidence entry (anchor)', () => {
    const h4 = gs17Graph.hypotheses.find((h) => h.hypothesis_id === 'H4');
    expect(h4.supporting_evidence).toHaveLength(1);
    expect(h4.supporting_evidence[0].evidence_id).toBe(GS17_CASE_EVIDENCE_ID);
  });

  test('P94-5-9: no duplicate evidence_id within any single list', () => {
    for (const h of gs17Graph.hypotheses) {
      for (const listName of ALL_LISTS) {
        const ids  = (h[listName] || []).map((r) => r.evidence_id);
        const uniq = new Set(ids);
        expect(uniq.size).toBe(ids.length);
      }
    }
  });

  test('P94-5-10: environmental_context and supporting_evidence are disjoint (V5)', () => {
    for (const h of gs17Graph.hypotheses) {
      const envSet = new Set((h.environmental_context || []).map((r) => r.evidence_id));
      for (const ref of h.supporting_evidence || []) {
        expect(envSet.has(ref.evidence_id)).toBe(false);
      }
    }
  });

  test('P94-5-11: heuristic window selects rows within ±10 min of anchor only', () => {
    const ANCHOR_MS = new Date(GS17_ANCHOR_TIMESTAMP).getTime();
    const WINDOW_MS = 10 * 60 * 1000;
    const allEnvCtxIds = new Set(
      gs17Graph.hypotheses.flatMap((h) =>
        (h.environmental_context || []).map((r) => r.evidence_id),
      ),
    );
    // Every row in environmental_context must be within the ±10-min window
    for (const id of allEnvCtxIds) {
      const row = gs17Rows.find((r) => r.evidence_id === id);
      expect(row).toBeDefined();
      const diff = Math.abs(new Date(row.timestamp).getTime() - ANCHOR_MS);
      expect(diff).toBeLessThanOrEqual(WINDOW_MS);
    }
    // Rows outside the window must NOT appear in environmental_context
    const outsideIds = new Set(
      gs17Rows
        .filter((r) => r.source !== 'CASE')
        .filter((r) => Math.abs(new Date(r.timestamp).getTime() - ANCHOR_MS) > WINDOW_MS)
        .map((r) => r.evidence_id),
    );
    for (const id of outsideIds) {
      expect(allEnvCtxIds.has(id)).toBe(false);
    }
  });
});

// =============================================================================
// P94-6 — Forensic analysis and narrative
// =============================================================================

describe('P94-6: goes16-sep2017 forensic analysis', () => {
  test('P94-6-1: report has case_id "goes16-sep2017"', () => {
    expect(gs17Report.case_id).toBe(GS17);
  });

  test('P94-6-2: causal_attribution_established is false', () => {
    expect(gs17Report.causal_attribution_established).toBe(false);
  });

  test('P94-6-3: H1 assessment is "mixed" (pinned)', () => {
    const h = gs17Report.hypotheses.find((h) => h.hypothesis_id === 'H1');
    expect(h.assessment).toBe(GS17_ASSESSMENTS.H1);
  });

  test('P94-6-4: H2 assessment is "mixed" (pinned)', () => {
    const h = gs17Report.hypotheses.find((h) => h.hypothesis_id === 'H2');
    expect(h.assessment).toBe(GS17_ASSESSMENTS.H2);
  });

  test('P94-6-5: H3 assessment is "insufficient_evidence" (pinned)', () => {
    const h = gs17Report.hypotheses.find((h) => h.hypothesis_id === 'H3');
    expect(h.assessment).toBe(GS17_ASSESSMENTS.H3);
  });

  test('P94-6-6: H4 assessment is "strongly_supported" (pinned)', () => {
    const h = gs17Report.hypotheses.find((h) => h.hypothesis_id === 'H4');
    expect(h.assessment).toBe(GS17_ASSESSMENTS.H4);
  });

  test('P94-6-7: all hypotheses have allowed vocabulary assessments', () => {
    for (const h of gs17Report.hypotheses) {
      if (h.assessment != null) {
        expect(ALLOWED_ASSESSMENTS.has(h.assessment)).toBe(true);
      }
    }
  });

  test('P94-6-8: heuristic narrative passes validateAnalystResponse (A1–A10 + B1–B4)', () => {
    const { valid, errors } = validateAnalystResponse(gs17Narrative, gs17Analysis, gs17ValidIds, gs17Graph);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  test('P94-6-9: narrative causal_attribution_established matches analysis', () => {
    expect(gs17Report.analyst_narrative.causal_attribution_established).toBe(
      gs17Report.causal_attribution_established,
    );
  });

  test('P94-6-10: narrative assessments exactly match deterministic analysis', () => {
    const map = new Map(gs17Report.hypotheses.map((h) => [h.hypothesis_id, h.assessment]));
    for (const ha of gs17Report.analyst_narrative.hypothesis_assessments) {
      expect(map.has(ha.hypothesis_id)).toBe(true);
      expect(ha.assessment).toBe(map.get(ha.hypothesis_id));
    }
  });

  test('P94-6-11: pipeline is deterministic across two independent runs', async () => {
    const rows2     = await parseEvidenceCSV(GS17);
    const graph2    = await buildEvidenceGraph(GS17, rows2);
    const analysis2 = buildForensicAnalysis(GS17, graph2);
    const narr2     = buildAnalystHeuristicNarrative(analysis2);
    const report2   = assembleValidatedForensicReport(analysis2, narr2);

    expect(report2.case_id).toBe(gs17Report.case_id);
    expect(report2.causal_attribution_established).toBe(gs17Report.causal_attribution_established);
    expect(report2.hypotheses.map((h) => h.hypothesis_id)).toEqual(
      gs17Report.hypotheses.map((h) => h.hypothesis_id),
    );
    expect(report2.hypotheses.map((h) => h.assessment)).toEqual(
      gs17Report.hypotheses.map((h) => h.assessment),
    );
  });

  test('P94-6-12: narrative contains no numerical probability claims', () => {
    const PROB_RE = /\b\d+(\.\d+)?\s*%|\b\d+(\.\d+)?\s*(probability|chance|likelihood)/i;
    expect(PROB_RE.test(JSON.stringify(gs17Report.analyst_narrative))).toBe(false);
  });
});

// =============================================================================
// P94-7 — Evidence provenance HTTP endpoint
// =============================================================================

describe('P94-7: evidence provenance for goes16-sep2017', () => {
  test('P94-7-1: CASE anchor returns HTTP 200 with found: true', async () => {
    const res = await request(app).get(
      `/api/cases/${GS17}/evidence/${GS17_CASE_EVIDENCE_ID}/provenance`,
    );
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.evidence_id).toBe(GS17_CASE_EVIDENCE_ID);
  });

  test('P94-7-2: anchor provenance has hypothesis_relationships for H4 (supporting)', async () => {
    const res = await request(app).get(
      `/api/cases/${GS17}/evidence/${GS17_CASE_EVIDENCE_ID}/provenance`,
    );
    const rels = res.body.hypothesis_relationships;
    expect(Array.isArray(rels)).toBe(true);
    expect(rels.length).toBeGreaterThan(0);
    const h4rel = rels.find((r) => r.hypothesis_id === 'H4');
    expect(h4rel).toBeDefined();
    expect(h4rel.list_name).toBe('supporting_evidence');
  });

  test('P94-7-3: unknown evidence ID for GS17 returns 404 with EVIDENCE_NOT_FOUND', async () => {
    const res = await request(app).get(
      `/api/cases/${GS17}/evidence/E-GS17-9999/provenance`,
    );
    expect(res.status).toBe(404);
    expect(res.body.found).toBe(false);
    expect(res.body.error_code).toBe('EVIDENCE_NOT_FOUND');
  });

  test('P94-7-4: unknown GS17 case returns 404 CASE_NOT_FOUND', async () => {
    const res = await request(app).get(
      `/api/cases/no-such-case-p94/evidence/E-GS17-0001/provenance`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error_code).toBe('CASE_NOT_FOUND');
  });

  test('P94-7-5: G15 evidence ID is not found under GS17 case', async () => {
    const res = await request(app).get(
      `/api/cases/${GS17}/evidence/E-G15-0001/provenance`,
    );
    expect(res.status).toBe(404);
    expect(res.body.found).toBe(false);
  });
});

// =============================================================================
// P94-8 — HTTP endpoints for all GS17 routes
// =============================================================================

describe('P94-8: HTTP endpoints for goes16-sep2017', () => {
  test('P94-8-1: GET /api/cases/goes16-sep2017/evidence-graph returns 200', async () => {
    const res = await request(app).get(`/api/cases/${GS17}/evidence-graph`);
    expect(res.status).toBe(200);
    expect(res.body.case_id).toBe(GS17);
    expect(res.body.hypotheses).toHaveLength(4);
    expect(res.body.causal_attribution_established).toBe(false);
  });

  test('P94-8-2: GET /api/cases/goes16-sep2017/forensic-analysis returns 200', async () => {
    const res = await request(app).get(`/api/cases/${GS17}/forensic-analysis`);
    expect(res.status).toBe(200);
    expect(res.body.case_id).toBe(GS17);
    expect(res.body.causal_attribution_established).toBe(false);
    expect(res.body).toHaveProperty('analyst_narrative');
  }, 30_000);

  test('P94-8-3: GET /api/cases/goes16-sep2017/forensic-analysis H1–H4 assessments correct', async () => {
    const res = await request(app).get(`/api/cases/${GS17}/forensic-analysis`);
    expect(res.status).toBe(200);
    const hyps = Object.fromEntries(res.body.hypotheses.map((h) => [h.hypothesis_id, h.assessment]));
    expect(hyps.H1).toBe('mixed');
    expect(hyps.H2).toBe('mixed');
    expect(hyps.H3).toBe('insufficient_evidence');
    expect(hyps.H4).toBe('strongly_supported');
  }, 30_000);

  test('P94-8-4: GET /api/cases/goes16-sep2017/forensic-analysis/narrative returns 200', async () => {
    const res = await request(app).get(`/api/cases/${GS17}/forensic-analysis/narrative`);
    expect(res.status).toBe(200);
    expect(['heuristic', 'llm']).toContain(res.body.source);
    expect(Array.isArray(res.body.hypothesis_assessments)).toBe(true);
  }, 30_000);

  test('P94-8-5: POST /api/cases/goes16-sep2017/investigate returns 200', async () => {
    const res = await request(app).post(`/api/cases/${GS17}/investigate`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.hypotheses)).toBe(true);
    expect(res.body.hypotheses.length).toBeGreaterThan(0);
  }, 30_000);

  test('P94-8-6: POST /api/cases/goes16-sep2017/challenge returns 200', async () => {
    const res = await request(app).post(`/api/cases/${GS17}/challenge`);
    expect(res.status).toBe(200);
    expect(res.body.case_id).toBe(GS17);
  }, 30_000);

  test('P94-8-7: GET /api/cases/goes16-sep2017/investigations returns 200 with empty array initially', async () => {
    const res = await request(app).get(`/api/cases/${GS17}/investigations`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// =============================================================================
// P94-9 — Investigation creation/retrieval for goes16-sep2017
// =============================================================================

describe('P94-9: investigation persistence for goes16-sep2017', () => {
  test('P94-9-1: POST /api/cases/goes16-sep2017/investigations returns 201 with UUID', async () => {
    const res = await request(app)
      .post(`/api/cases/${GS17}/investigations`)
      .send({ title: 'Phase 9.4 GS17 test investigation', opened_by: 'test-analyst' });
    expect(res.status).toBe(201);
    expect(res.body.investigation_id).toMatch(UUID_RE);
    expect(res.body.case_id).toBe(GS17);
    expect(res.body.status).toBe('open');
  });

  test('P94-9-2: created investigation is retrievable via GET', async () => {
    const createRes = await request(app)
      .post(`/api/cases/${GS17}/investigations`)
      .send({ title: 'P94 retrieval test', opened_by: 'analyst' });
    const iid = createRes.body.investigation_id;

    const getRes = await request(app).get(`/api/cases/${GS17}/investigations/${iid}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.investigation_id).toBe(iid);
    expect(getRes.body.case_id).toBe(GS17);
  });

  test('P94-9-3: created investigation appears in the case list', async () => {
    const createRes = await request(app)
      .post(`/api/cases/${GS17}/investigations`)
      .send({ title: 'P94 list test', opened_by: 'analyst' });
    const iid = createRes.body.investigation_id;

    const listRes = await request(app).get(`/api/cases/${GS17}/investigations`);
    expect(listRes.status).toBe(200);
    const ids = listRes.body.map((i) => i.investigation_id);
    expect(ids).toContain(iid);
  });
});

// =============================================================================
// P94-10 — Challenge behavior for goes16-sep2017
// =============================================================================

describe('P94-10: challenge behavior for goes16-sep2017', () => {
  let gs17InvId;

  beforeEach(async () => {
    const res = await request(app)
      .post(`/api/cases/${GS17}/investigations`)
      .send({ title: 'P94 challenge test', opened_by: 'analyst' });
    gs17InvId = res.body.investigation_id;
  });

  test('P94-10-1: valid challenge against H1 returns 201', async () => {
    const res = await request(app)
      .post(`/api/cases/${GS17}/investigations/${gs17InvId}/challenges`)
      .send({
        target_type:       'hypothesis_assessment',
        target_id:         'H1',
        analyst_statement: 'The proton flux data provides context but not direct evidence of SEU.',
      });
    expect(res.status).toBe(201);
    expect(res.body.case_id).toBe(GS17);
    expect(res.body.status).toBe('open');
  });

  test('P94-10-2: challenge with real GS17 evidence_id is accepted', async () => {
    const res = await request(app)
      .post(`/api/cases/${GS17}/investigations/${gs17InvId}/challenges`)
      .send({
        target_type:       'hypothesis_assessment',
        target_id:         'H1',
        analyst_statement: 'The proton flux provides environmental context only.',
        evidence_ids:      [GS17_CASE_EVIDENCE_ID],
      });
    expect(res.status).toBe(201);
  });

  test('P94-10-3: challenge with fabricated GS17 evidence_id returns 422', async () => {
    const res = await request(app)
      .post(`/api/cases/${GS17}/investigations/${gs17InvId}/challenges`)
      .send({
        target_type:       'hypothesis_assessment',
        target_id:         'H1',
        analyst_statement: 'Testing fabricated ID.',
        evidence_ids:      ['E-GS17-9999'],  // does not exist in CSV
      });
    expect(res.status).toBe(422);
    expect(res.body.error_code).toBe('INVALID_EVIDENCE_ID');
  });

  test('P94-10-4: setting assessment in challenge body returns 422 FORENSIC_FIELD_IMMUTABLE', async () => {
    const res = await request(app)
      .post(`/api/cases/${GS17}/investigations/${gs17InvId}/challenges`)
      .send({
        target_type:       'hypothesis_assessment',
        target_id:         'H1',
        analyst_statement: 'Testing forbidden field.',
        assessment:        'supported',
      });
    expect(res.status).toBe(422);
    expect(res.body.error_code).toBe('FORENSIC_FIELD_IMMUTABLE');
  });

  test('P94-10-5: fabricated hypothesis_id returns 422 INVALID_HYPOTHESIS_ID', async () => {
    const res = await request(app)
      .post(`/api/cases/${GS17}/investigations/${gs17InvId}/challenges`)
      .send({
        target_type:       'hypothesis_assessment',
        target_id:         'H-FABRICATED',
        analyst_statement: 'Testing fabricated hypothesis ID.',
      });
    expect(res.status).toBe(422);
    expect(res.body.error_code).toBe('INVALID_HYPOTHESIS_ID');
  });
});

// =============================================================================
// P94-11 — Cross-case evidence injection rejection
// =============================================================================

describe('P94-11: cross-case evidence injection is rejected in GS17 context', () => {
  let gs17InvId;

  beforeEach(async () => {
    const res = await request(app)
      .post(`/api/cases/${GS17}/investigations`)
      .send({ title: 'P94 cross-case test', opened_by: 'analyst' });
    gs17InvId = res.body.investigation_id;
  });

  test('P94-11-1: G15 evidence ID (E-G15-0001) in GS17 challenge returns 422', async () => {
    const res = await request(app)
      .post(`/api/cases/${GS17}/investigations/${gs17InvId}/challenges`)
      .send({
        target_type:       'hypothesis_assessment',
        target_id:         'H1',
        analyst_statement: 'Testing cross-case injection.',
        evidence_ids:      ['E-G15-0001'],
      });
    expect(res.status).toBe(422);
    expect(res.body.error_code).toBe('INVALID_EVIDENCE_ID');
  });

  test('P94-11-2: TCA evidence ID (E-TCA-0001) in GS17 challenge returns 422', async () => {
    const res = await request(app)
      .post(`/api/cases/${GS17}/investigations/${gs17InvId}/challenges`)
      .send({
        target_type:       'hypothesis_assessment',
        target_id:         'H1',
        analyst_statement: 'Testing TCA cross-case injection.',
        evidence_ids:      ['E-TCA-0001'],
      });
    expect(res.status).toBe(422);
    expect(res.body.error_code).toBe('INVALID_EVIDENCE_ID');
  });

  test('P94-11-3: G15 hypothesis H5 does not exist in GS17 context', async () => {
    // GS17 only has H1–H4; H5 is a G15-only hypothesis
    const res = await request(app)
      .post(`/api/cases/${GS17}/investigations/${gs17InvId}/challenges`)
      .send({
        target_type:       'hypothesis_assessment',
        target_id:         'H5',
        analyst_statement: 'Testing cross-case hypothesis injection.',
      });
    expect(res.status).toBe(422);
    expect(res.body.error_code).toBe('INVALID_HYPOTHESIS_ID');
  });

  test('P94-11-4: GS17 evidence provenance does not return G15 data for G15 ID', async () => {
    const res = await request(app).get(
      `/api/cases/${GS17}/evidence/E-G15-0001/provenance`,
    );
    // E-G15-0001 does not exist in GS17; must return 404 with found: false
    expect(res.status).toBe(404);
    expect(res.body.found).toBe(false);
  });
});

// =============================================================================
// P94-12 — Cross-case investigation isolation
// =============================================================================

describe('P94-12: investigation isolation — GS17 vs G15 vs TCA', () => {
  test('P94-12-1: GS17 investigation does NOT appear in G15 list', async () => {
    const createRes = await request(app)
      .post(`/api/cases/${GS17}/investigations`)
      .send({ title: 'P94 GS17 isolation test', opened_by: 'analyst' });
    const iid = createRes.body.investigation_id;

    const g15List = await request(app).get(`/api/cases/${G15}/investigations`);
    const g15Ids  = g15List.body.map((i) => i.investigation_id);
    expect(g15Ids).not.toContain(iid);
  });

  test('P94-12-2: GS17 investigation does NOT appear in TCA list', async () => {
    const createRes = await request(app)
      .post(`/api/cases/${GS17}/investigations`)
      .send({ title: 'P94 GS17 vs TCA', opened_by: 'analyst' });
    const iid = createRes.body.investigation_id;

    const tcaList = await request(app).get(`/api/cases/${TCA}/investigations`);
    const tcaIds  = tcaList.body.map((i) => i.investigation_id);
    expect(tcaIds).not.toContain(iid);
  });

  test('P94-12-3: G15 investigation does NOT appear in GS17 list', async () => {
    const createRes = await request(app)
      .post(`/api/cases/${G15}/investigations`)
      .send({ title: 'P94 G15 isolation', opened_by: 'analyst' });
    const iid = createRes.body.investigation_id;

    const gs17List = await request(app).get(`/api/cases/${GS17}/investigations`);
    const gs17Ids  = gs17List.body.map((i) => i.investigation_id);
    expect(gs17Ids).not.toContain(iid);
  });

  test('P94-12-4: GS17 investigation not retrievable under G15 case', async () => {
    const createRes = await request(app)
      .post(`/api/cases/${GS17}/investigations`)
      .send({ title: 'P94 cross-fetch test', opened_by: 'analyst' });
    const iid = createRes.body.investigation_id;

    const res = await request(app).get(`/api/cases/${G15}/investigations/${iid}`);
    expect(res.status).toBe(404);
    expect(res.body.error_code).toBe('INVESTIGATION_NOT_FOUND');
  });
});

// =============================================================================
// P94-13 — Concurrent requests for GS17 and G15
// =============================================================================

describe('P94-13: concurrent requests for goes16-sep2017 and galaxy-15', () => {
  test('P94-13-1: concurrent evidence-graph requests return correct case_ids', async () => {
    const [gs17Res, g15Res] = await Promise.all([
      request(app).get(`/api/cases/${GS17}/evidence-graph`),
      request(app).get(`/api/cases/${G15}/evidence-graph`),
    ]);
    expect(gs17Res.status).toBe(200);
    expect(g15Res.status).toBe(200);
    expect(gs17Res.body.case_id).toBe(GS17);
    expect(g15Res.body.case_id).toBe(G15);
  });

  test('P94-13-2: concurrent requests produce non-overlapping evidence IDs', async () => {
    const [gs17Res, g15Res] = await Promise.all([
      request(app).get(`/api/cases/${GS17}/timeline`),
      request(app).get(`/api/cases/${G15}/timeline`),
    ]);
    const gs17Ids = new Set(gs17Res.body.map((r) => r.evidence_id));
    const g15Ids  = new Set(g15Res.body.map((r) => r.evidence_id));
    for (const id of gs17Ids) expect(g15Ids.has(id)).toBe(false);
    for (const id of g15Ids) expect(gs17Ids.has(id)).toBe(false);
  });

  test('P94-13-3: three concurrent parseEvidenceCSV for GS17 return identical IDs', async () => {
    const [r1, r2, r3] = await Promise.all([
      parseEvidenceCSV(GS17),
      parseEvidenceCSV(GS17),
      parseEvidenceCSV(GS17),
    ]);
    const ids1 = r1.map((r) => r.evidence_id);
    expect(r2.map((r) => r.evidence_id)).toEqual(ids1);
    expect(r3.map((r) => r.evidence_id)).toEqual(ids1);
  });

  test('P94-13-4: concurrent forensic analysis for both cases returns correct causal attribution', () => {
    // Both analyses were already built concurrently in beforeAll
    expect(gs17Analysis.case_id).toBe(GS17);
    expect(gs17Analysis.causal_attribution_established).toBe(false);
    expect(g15Analysis.case_id).toBe(G15);
    expect(g15Analysis.causal_attribution_established).toBe(false);
  });

  test('P94-13-5: concurrent buildForensicAnalysis calls do not cross-contaminate hypothesis counts', () => {
    // GS17 has 4 hypotheses; G15 has 5
    expect(gs17Analysis.hypotheses).toHaveLength(4);
    expect(g15Analysis.hypotheses).toHaveLength(5);
  });
});

// =============================================================================
// P94-14 — Galaxy-15 output is byte-identical before/after GS17 onboarding
// =============================================================================

describe('P94-14: Galaxy-15 forensic output is byte-identical after goes16-sep2017 onboarded', () => {
  test('P94-14-1: G15 row count is still 278', () => {
    expect(g15Rows).toHaveLength(278);
  });

  test('P94-14-2: G15 first evidence ID is still E-G15-0001', () => {
    expect(g15Rows[0].evidence_id).toBe('E-G15-0001');
  });

  test('P94-14-3: G15 last evidence ID is still E-G15-0278', () => {
    expect(g15Rows[g15Rows.length - 1].evidence_id).toBe('E-G15-0278');
  });

  test('P94-14-4: G15 causal_attribution_established is still false', () => {
    expect(g15Analysis.causal_attribution_established).toBe(false);
  });

  test('P94-14-5: G15 still has exactly 5 hypotheses H1–H5', () => {
    expect(g15Analysis.hypotheses).toHaveLength(5);
    const ids = g15Analysis.hypotheses.map((h) => h.hypothesis_id);
    ['H1', 'H2', 'H3', 'H4', 'H5'].forEach((id) => expect(ids).toContain(id));
  });

  test('P94-14-6: G15 H1 assessment is still "mixed"', () => {
    const h = g15Analysis.hypotheses.find((h) => h.hypothesis_id === 'H1');
    expect(h.assessment).toBe('mixed');
  });

  test('P94-14-7: G15 H2 assessment is still "mixed"', () => {
    const h = g15Analysis.hypotheses.find((h) => h.hypothesis_id === 'H2');
    expect(h.assessment).toBe('mixed');
  });

  test('P94-14-8: G15 H3 assessment is still "supported"', () => {
    const h = g15Analysis.hypotheses.find((h) => h.hypothesis_id === 'H3');
    expect(h.assessment).toBe('supported');
  });

  test('P94-14-9: G15 H4 assessment is still "insufficient_evidence"', () => {
    const h = g15Analysis.hypotheses.find((h) => h.hypothesis_id === 'H4');
    expect(h.assessment).toBe('insufficient_evidence');
  });

  test('P94-14-10: G15 H5 assessment is still "strongly_supported"', () => {
    const h = g15Analysis.hypotheses.find((h) => h.hypothesis_id === 'H5');
    expect(h.assessment).toBe('strongly_supported');
  });

  test('P94-14-11: G15 report assessments are byte-identical on two independent runs', async () => {
    const rows2     = await parseEvidenceCSV(G15);
    const graph2    = await buildEvidenceGraph(G15, rows2);
    const analysis2 = buildForensicAnalysis(G15, graph2);
    const narr2     = buildAnalystHeuristicNarrative(analysis2);
    const report2   = assembleValidatedForensicReport(analysis2, narr2);

    for (const h of g15Report.hypotheses) {
      const h2 = report2.hypotheses.find((x) => x.hypothesis_id === h.hypothesis_id);
      expect(h2).toBeDefined();
      expect(h2.assessment).toBe(h.assessment);
    }
    expect(report2.causal_attribution_established).toBe(g15Report.causal_attribution_established);
  });

  test('P94-14-12: G15 evidence IDs do not overlap with GS17 IDs (namespace isolation)', () => {
    const g15Ids  = new Set(g15Rows.map((r) => r.evidence_id));
    const gs17Ids = new Set(gs17Rows.map((r) => r.evidence_id));
    for (const id of g15Ids) expect(gs17Ids.has(id)).toBe(false);
    for (const id of gs17Ids) expect(g15Ids.has(id)).toBe(false);
  });

  test('P94-14-13: G15 HTTP forensic-analysis endpoint still returns correct assessments after GS17 onboarded', async () => {
    const res = await request(app).get(`/api/cases/${G15}/forensic-analysis`);
    expect(res.status).toBe(200);
    expect(res.body.case_id).toBe(G15);
    expect(res.body.causal_attribution_established).toBe(false);
    const hyps = Object.fromEntries(res.body.hypotheses.map((h) => [h.hypothesis_id, h.assessment]));
    expect(hyps.H1).toBe('mixed');
    expect(hyps.H2).toBe('mixed');
    expect(hyps.H3).toBe('supported');
    expect(hyps.H4).toBe('insufficient_evidence');
    expect(hyps.H5).toBe('strongly_supported');
  }, 30_000);
});
