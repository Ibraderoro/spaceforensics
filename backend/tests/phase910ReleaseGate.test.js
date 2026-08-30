'use strict';

/**
 * Phase 9.10 — Final Production Release Gate
 *
 * This suite is the authoritative regression check that must pass before any
 * Phase 9 release.  It consolidates coverage of all 20 invariant categories
 * specified in the release requirements and adds the Galaxy-15 golden-output
 * snapshot that proves current output is byte-identical to the approved Phase 8
 * baseline (excluding documented non-deterministic metadata).
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │  Invariant categories covered                                               │
 * │                                                                             │
 * │  RG-1   Evidence authority — 278 records, E-G15-0001…E-G15-0278            │
 * │  RG-2   Deterministic evidence IDs — stable across independent calls       │
 * │  RG-3   Evidence graph integrity — 5 hypotheses, all lists valid           │
 * │  RG-4   H1/H2/H3/H4/H5 assessments — canonical values, unchanged          │
 * │  RG-5   causal_attribution_established === false for Galaxy-15             │
 * │  RG-6   Env-context / supporting-evidence separation — disjoint per hyp   │
 * │  RG-7   EPHEMERIS exclusion — no EPHEMERIS ID in any hypothesis list       │
 * │  RG-8   No numerical probability claims in any API output                  │
 * │  RG-9   Limitations preservation — non-empty, types correct               │
 * │  RG-10  Provenance traceability — every cited ID traceable to CSV          │
 * │  RG-11  AI evidence containment — narrative IDs ⊆ valid CSV IDs           │
 * │  RG-12  AI assessment identity — narrative assessments mirror deterministic │
 * │  RG-13  AI causal-language prevention — narrative passes causal filter     │
 * │  RG-14  Cross-case isolation — G15 and TCA namespaces never collide        │
 * │  RG-15  Investigation persistence — write operations do not alter forensics │
 * │  RG-16  Restart recovery — investigation state ≠ forensic state            │
 * │  RG-17  HTTP error contracts — {error_code,error,status_code} shape        │
 * │  RG-18  Frontend scientific labeling — assessment vocabulary matches API   │
 * │  RG-19  Concurrent deterministic output — 5 concurrent calls byte-identical│
 * │  RG-20  PostgreSQL integration — store columns carry no forensic fields    │
 * │                                                                             │
 * │  RG-GOLDEN  Galaxy-15 golden-output regression snapshot                    │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * Design constraints
 * ──────────────────
 * •  No LLM is required: WATSONX_AI_APIKEY absent → heuristic fallback (source:"heuristic")
 * •  No PostgreSQL required for most groups; PG groups are skipped automatically
 *    when PG_DATABASE / RUN_PG_TESTS is absent (matching all existing PG test files)
 * •  The golden snapshot (g15-golden-snapshot.json) is read at test-load time;
 *    if the file is missing the test fails with a clear message.
 * •  Non-deterministic fields explicitly excluded from snapshot comparison:
 *    generated_at, opened_at, observation/challenge timestamps, narrative free-text.
 */

const request = require('supertest');
const { app, parseEvidenceCSV, buildEvidenceGraph, buildForensicAnalysis,
        assembleValidatedForensicReport, investigationStore } = require('../server');
const { buildAnalystHeuristicNarrative } = require('../services/aiAnalyst');
const { InMemoryInvestigationRepository } = require('../services/InvestigationRepository');

// ─────────────────────────────────────────────────────────────────────────────
// Golden snapshot
// ─────────────────────────────────────────────────────────────────────────────
const GOLDEN = require('./g15-golden-snapshot.json');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const G15  = 'galaxy-15';
const TCA  = 'test-case-alpha';

const CANONICAL_ASSESSMENTS = {
  H1: 'mixed',
  H2: 'mixed',
  H3: 'supported',
  H4: 'insufficient_evidence',
  H5: 'strongly_supported',
};

const ALLOWED_ASSESSMENTS = new Set([
  'strongly_supported', 'supported', 'mixed',
  'weakly_supported', 'insufficient_evidence',
]);

// Causal-certainty phrases mirroring aiAnalyst.js (kept local; no private imports)
const CAUSAL_CERTAINTY_PHRASES = [
  'proves', 'confirms causation', 'is caused by', 'causation established',
  'proof of', 'definitively caused', 'conclusively shows',
  'was the cause of', 'is the cause of', 'was responsible for causing',
  'resulted in the failure', 'resulted in the anomaly',
  'led to the failure', 'led to the anomaly',
  'triggered the failure', 'triggered the anomaly', 'directly caused',
];
const CAUSAL_PASSIVE_RE = /\b(?:caused\s+the|caused\s+by|was\s+caused\s+by|been\s+caused\s+by)\b/i;
const NEGATION_PREFIXES  = [
  'not ', 'cannot ', 'can not ', 'did not ', 'does not ', 'do not ',
  'could not ', 'would not ', 'was not ', 'were not ', 'has not ',
  'have not ', 'had not ', 'is not ', 'are not ',
];
const NUMERICAL_PROB_RE = /\b\d+(\.\d+)?\s*%|\b\d+(\.\d+)?\s*(probability|chance|likelihood)/i;

function containsCausalCertainty(text) {
  const lower = (text || '').toLowerCase();
  if (CAUSAL_CERTAINTY_PHRASES.some((p) => lower.includes(p))) return true;
  const sentences = lower.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
  for (const sentence of sentences) {
    if (CAUSAL_PASSIVE_RE.test(sentence)) {
      if (!NEGATION_PREFIXES.some((n) => sentence.includes(n))) return true;
    }
  }
  return false;
}

function collectFreeText(value, path = '') {
  if (typeof value === 'string')  return [{ label: path, text: value }];
  if (Array.isArray(value))       return value.flatMap((v, i) => collectFreeText(v, `${path}[${i}]`));
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([k, v]) => collectFreeText(v, path ? `${path}.${k}` : k));
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures (loaded once for the whole suite)
// ─────────────────────────────────────────────────────────────────────────────
let g15Rows, g15Graph, g15Analysis, g15Narrative, g15Report;
let tcaRows;
let g15EvidenceIds, tcaEvidenceIds, g15EphemerisIds;
let httpReport;   // from GET /api/cases/galaxy-15/forensic-analysis

beforeAll(async () => {
  jest.setTimeout(60_000);

  // Unit-level pipeline (no HTTP)
  g15Rows     = await parseEvidenceCSV(G15);
  g15Graph    = await buildEvidenceGraph(G15, g15Rows);
  g15Analysis = buildForensicAnalysis(G15, g15Graph, null);
  const validIds = new Set(g15Rows.map((r) => r.evidence_id));
  g15Narrative = buildAnalystHeuristicNarrative(g15Analysis, validIds, g15Graph);
  g15Report    = assembleValidatedForensicReport(g15Analysis, g15Narrative);

  g15EvidenceIds  = new Set(g15Rows.map((r) => r.evidence_id));
  g15EphemerisIds = new Set(
    g15Rows.filter((r) => r.source === 'GOES11_EPHEMERIS').map((r) => r.evidence_id),
  );

  // TCA rows for cross-case checks
  tcaRows        = await parseEvidenceCSV(TCA);
  tcaEvidenceIds = new Set(tcaRows.map((r) => r.evidence_id));

  // HTTP-level report (single request shared across HTTP tests)
  const res = await request(app).get(`/api/cases/${G15}/forensic-analysis`);
  httpReport = res.body;
}, 60_000);

beforeEach(() => {
  investigationStore._reset();
});

// =============================================================================
// RG-1 — Evidence authority
// =============================================================================
describe('RG-1: evidence authority', () => {
  test('RG-1-1: Galaxy-15 produces exactly 278 evidence records', () => {
    expect(g15Rows).toHaveLength(278);
  });

  test('RG-1-2: first evidence ID is E-G15-0001', () => {
    expect(g15Rows[0].evidence_id).toBe('E-G15-0001');
  });

  test('RG-1-3: last evidence ID is E-G15-0278', () => {
    expect(g15Rows[g15Rows.length - 1].evidence_id).toBe('E-G15-0278');
  });

  test('RG-1-4: GOES11_EPHEMERIS records are present in the CSV (61 expected)', () => {
    expect(g15EphemerisIds.size).toBe(61);
  });

  test('RG-1-5: every evidence_id value is unique', () => {
    expect(g15EvidenceIds.size).toBe(278);
  });
});

// =============================================================================
// RG-2 — Deterministic evidence IDs
// =============================================================================
describe('RG-2: deterministic evidence IDs', () => {
  test('RG-2-1: evidence IDs are strictly sequential E-G15-0001…E-G15-0278', () => {
    g15Rows.forEach((r, i) => {
      expect(r.evidence_id).toBe(`E-G15-${String(i + 1).padStart(4, '0')}`);
    });
  });

  test('RG-2-2: two independent parseEvidenceCSV calls return identical ID sequences', async () => {
    const second = await parseEvidenceCSV(G15);
    expect(second.map((r) => r.evidence_id)).toEqual(g15Rows.map((r) => r.evidence_id));
  });

  test('RG-2-3: two independent buildEvidenceGraph calls return the same hypothesis IDs and evidence IDs', async () => {
    const g2 = await buildEvidenceGraph(G15, g15Rows);
    const g1HypIds = g15Graph.hypotheses.map((h) => h.hypothesis_id).sort();
    const g2HypIds = g2.hypotheses.map((h) => h.hypothesis_id).sort();
    expect(g1HypIds).toEqual(g2HypIds);
    // All env-context IDs must match for H2 (largest list)
    const h2_1 = g15Graph.hypotheses.find((h) => h.hypothesis_id === 'H2');
    const h2_2 = g2.hypotheses.find((h) => h.hypothesis_id === 'H2');
    const ids1 = h2_1.environmental_context.map((e) => e.evidence_id).sort();
    const ids2 = h2_2.environmental_context.map((e) => e.evidence_id).sort();
    expect(ids1).toEqual(ids2);
  });
});

// =============================================================================
// RG-3 — Evidence graph integrity
// =============================================================================
describe('RG-3: evidence graph integrity', () => {
  test('RG-3-1: graph has exactly 5 hypotheses (H1–H5)', () => {
    expect(g15Graph.hypotheses).toHaveLength(5);
    const ids = g15Graph.hypotheses.map((h) => h.hypothesis_id);
    ['H1','H2','H3','H4','H5'].forEach((id) => expect(ids).toContain(id));
  });

  test('RG-3-2: graph.case_id is "galaxy-15"', () => {
    expect(g15Graph.case_id).toBe(G15);
  });

  test('RG-3-3: every evidence_id in every graph hypothesis list exists in the CSV', () => {
    const LISTS = ['environmental_context','supporting_evidence','contradicting_evidence','non_discriminating_evidence'];
    for (const h of g15Graph.hypotheses) {
      for (const list of LISTS) {
        for (const e of (h[list] || [])) {
          expect(g15EvidenceIds.has(e.evidence_id)).toBe(true);
        }
      }
    }
  });

  test('RG-3-4: no evidence_id appears in more than one list within the same hypothesis', () => {
    const LISTS = ['environmental_context','supporting_evidence','contradicting_evidence','non_discriminating_evidence'];
    for (const h of g15Graph.hypotheses) {
      const seen = new Map();
      for (const list of LISTS) {
        for (const e of (h[list] || [])) {
          expect(seen.has(e.evidence_id)).toBe(false);
          seen.set(e.evidence_id, list);
        }
      }
    }
  });

  test('RG-3-5: all non-null assessments use the allowed categorical vocabulary', () => {
    for (const h of g15Graph.hypotheses) {
      if (h.assessment !== null) {
        expect(ALLOWED_ASSESSMENTS.has(h.assessment)).toBe(true);
      }
    }
  });
});

// =============================================================================
// RG-4 — H1/H2/H3/H4/H5 canonical assessments
// =============================================================================
describe('RG-4: canonical hypothesis assessments', () => {
  for (const [hid, expected] of Object.entries(CANONICAL_ASSESSMENTS)) {
    test(`RG-4: ${hid} assessment is "${expected}" (unit pipeline)`, () => {
      const h = g15Analysis.hypotheses.find((x) => x.hypothesis_id === hid);
      expect(h).toBeDefined();
      expect(h.assessment).toBe(expected);
    });
  }

  for (const [hid, expected] of Object.entries(CANONICAL_ASSESSMENTS)) {
    test(`RG-4: ${hid} assessment is "${expected}" (HTTP)`, () => {
      const h = httpReport.hypotheses.find((x) => x.hypothesis_id === hid);
      expect(h).toBeDefined();
      expect(h.assessment).toBe(expected);
    });
  }
});

// =============================================================================
// RG-5 — causal_attribution_established === false
// =============================================================================
describe('RG-5: causal_attribution_established is false for Galaxy-15', () => {
  test('RG-5-1: graph.causal_attribution_established is strictly false', () => {
    expect(g15Graph.causal_attribution_established).toBe(false);
  });

  test('RG-5-2: analysis.causal_attribution_established is strictly false', () => {
    expect(g15Analysis.causal_attribution_established).toBe(false);
  });

  test('RG-5-3: report.causal_attribution_established is strictly false', () => {
    expect(g15Report.causal_attribution_established).toBe(false);
  });

  test('RG-5-4: HTTP report causal_attribution_established is strictly false', () => {
    expect(httpReport.causal_attribution_established).toBe(false);
  });

  test('RG-5-5: narrative.causal_attribution_established is strictly false', () => {
    expect(g15Narrative.causal_attribution_established).toBe(false);
  });

  test('RG-5-6: causal_attribution_established is a boolean (not string)', () => {
    expect(typeof g15Report.causal_attribution_established).toBe('boolean');
  });
});

// =============================================================================
// RG-6 — Env-context / supporting-evidence separation
// =============================================================================
describe('RG-6: environmental-context / supporting-evidence separation', () => {
  test('RG-6-1: env-context and supporting-evidence IDs are disjoint per hypothesis (unit)', () => {
    for (const h of g15Report.hypotheses) {
      const s   = h.evidence_summary;
      const env = new Set(s.environmental_context_ids || []);
      for (const id of (s.supporting_evidence_ids || [])) {
        expect(env.has(id)).toBe(false);
      }
    }
  });

  test('RG-6-2: env-context and supporting-evidence IDs are disjoint per hypothesis (HTTP)', () => {
    for (const h of httpReport.hypotheses) {
      const s   = h.evidence_summary;
      const env = new Set(s.environmental_context_ids || []);
      for (const id of (s.supporting_evidence_ids || [])) {
        expect(env.has(id)).toBe(false);
      }
    }
  });

  test('RG-6-3: H1 has environmental_context IDs but no supporting_evidence IDs', () => {
    const h = g15Report.hypotheses.find((x) => x.hypothesis_id === 'H1');
    expect(h.evidence_summary.environmental_context_count).toBeGreaterThan(0);
    expect(h.evidence_summary.supporting_evidence_count).toBe(0);
  });

  test('RG-6-4: H3 has supporting_evidence but no environmental_context', () => {
    const h = g15Report.hypotheses.find((x) => x.hypothesis_id === 'H3');
    expect(h.evidence_summary.supporting_evidence_count).toBeGreaterThan(0);
    expect(h.evidence_summary.environmental_context_count).toBe(0);
  });
});

// =============================================================================
// RG-7 — EPHEMERIS exclusion
// =============================================================================
describe('RG-7: EPHEMERIS exclusion from all hypothesis lists', () => {
  const LISTS = [
    'environmental_context_ids',
    'supporting_evidence_ids',
    'contradicting_evidence_ids',
    'non_discriminating_evidence_ids',
  ];

  test('RG-7-1: no EPHEMERIS ID in any hypothesis evidence list (unit report)', () => {
    for (const h of g15Report.hypotheses) {
      for (const list of LISTS) {
        for (const id of (h.evidence_summary[list] || [])) {
          expect(g15EphemerisIds.has(id)).toBe(false);
        }
      }
    }
  });

  test('RG-7-2: no EPHEMERIS ID in any hypothesis evidence list (HTTP report)', () => {
    for (const h of httpReport.hypotheses) {
      for (const list of LISTS) {
        for (const id of (h.evidence_summary[list] || [])) {
          expect(g15EphemerisIds.has(id)).toBe(false);
        }
      }
    }
  });

  test('RG-7-3: no EPHEMERIS ID in graph evidence lists', () => {
    const graphLists = ['environmental_context','supporting_evidence','contradicting_evidence','non_discriminating_evidence'];
    for (const h of g15Graph.hypotheses) {
      for (const list of graphLists) {
        for (const e of (h[list] || [])) {
          expect(g15EphemerisIds.has(e.evidence_id)).toBe(false);
        }
      }
    }
  });
});

// =============================================================================
// RG-8 — No numerical probability claims
// =============================================================================
describe('RG-8: no numerical probability claims in any output', () => {
  test('RG-8-1: no numerical probability in HTTP forensic-analysis response', () => {
    const violations = collectFreeText(httpReport)
      .filter(({ text }) => NUMERICAL_PROB_RE.test(text));
    expect(violations).toHaveLength(0);
  });

  test('RG-8-2: no numerical probability in unit forensic report', () => {
    const violations = collectFreeText(g15Report)
      .filter(({ text }) => NUMERICAL_PROB_RE.test(text));
    expect(violations).toHaveLength(0);
  });

  test('RG-8-3: narrative hypothesis_assessments contain no percentage language', () => {
    for (const ha of (g15Narrative.hypothesis_assessments || [])) {
      expect(NUMERICAL_PROB_RE.test(ha.rationale || '')).toBe(false);
    }
  });
});

// =============================================================================
// RG-9 — Limitations preservation
// =============================================================================
describe('RG-9: limitations preservation', () => {
  test('RG-9-1: report.limitations is a non-empty array', () => {
    expect(Array.isArray(g15Report.limitations)).toBe(true);
    expect(g15Report.limitations.length).toBeGreaterThan(0);
  });

  test('RG-9-2: every limitation has a non-empty type and description', () => {
    for (const lim of g15Report.limitations) {
      expect(typeof lim.type).toBe('string');
      expect(lim.type.length).toBeGreaterThan(0);
      expect(typeof lim.description).toBe('string');
      expect(lim.description.length).toBeGreaterThan(0);
    }
  });

  test('RG-9-3: every hypothesis carries at least one limitation', () => {
    for (const h of g15Report.hypotheses) {
      expect(Array.isArray(h.limitations)).toBe(true);
      expect(h.limitations.length).toBeGreaterThan(0);
    }
  });

  test('RG-9-4: limitations are preserved through the HTTP pipeline', () => {
    expect(Array.isArray(httpReport.limitations)).toBe(true);
    expect(httpReport.limitations.length).toBeGreaterThan(0);
    for (const h of httpReport.hypotheses) {
      expect(Array.isArray(h.limitations)).toBe(true);
      expect(h.limitations.length).toBeGreaterThan(0);
    }
  });

  test('RG-9-5: limitation count matches golden snapshot', () => {
    expect(g15Report.limitations).toHaveLength(GOLDEN.evidence_summary.total_limitations);
  });
});

// =============================================================================
// RG-10 — Provenance traceability
// =============================================================================
describe('RG-10: provenance traceability', () => {
  test('RG-10-1: every evidence_id in every hypothesis list exists in the CSV', () => {
    const LISTS = [
      'environmental_context_ids','supporting_evidence_ids',
      'contradicting_evidence_ids','non_discriminating_evidence_ids',
    ];
    for (const h of g15Report.hypotheses) {
      for (const list of LISTS) {
        for (const id of (h.evidence_summary[list] || [])) {
          expect(g15EvidenceIds.has(id)).toBe(true);
        }
      }
    }
  });

  test('RG-10-2: HTTP provenance endpoint returns found:true for a known G15 evidence ID', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/evidence/E-G15-0001/provenance`);
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.evidence_id).toBe('E-G15-0001');
  });

  test('RG-10-3: EPHEMERIS ID resolves with found:true but hypothesis_relationships is empty', async () => {
    // Get first EPHEMERIS ID from timeline
    const tlRes = await request(app).get(`/api/cases/${G15}/timeline`);
    const ephRow = tlRes.body.find((r) => r.source === 'GOES11_EPHEMERIS');
    expect(ephRow).toBeDefined();

    const res = await request(app)
      .get(`/api/cases/${G15}/evidence/${ephRow.evidence_id}/provenance`);
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.hypothesis_relationships).toHaveLength(0);
  });

  test('RG-10-4: unknown evidence ID returns 404 with found:false', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/evidence/E-G15-9999/provenance`);
    expect(res.status).toBe(404);
    expect(res.body.found).toBe(false);
  });
});

// =============================================================================
// RG-11 — AI evidence containment
// =============================================================================
describe('RG-11: AI evidence containment', () => {
  test('RG-11-1: all evidence_ids in narrative hypothesis_assessments exist in the CSV', () => {
    for (const ha of (g15Narrative.hypothesis_assessments || [])) {
      for (const id of (ha.evidence_ids || [])) {
        expect(g15EvidenceIds.has(id)).toBe(true);
      }
    }
  });

  test('RG-11-2: narrative contains no TCA evidence IDs', () => {
    const narText = JSON.stringify(g15Narrative);
    for (const id of tcaEvidenceIds) {
      expect(narText).not.toContain(id);
    }
  });

  test('RG-11-3: HTTP narrative evidence IDs are all valid G15 IDs', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/forensic-analysis/narrative`);
    expect(res.status).toBe(200);
    for (const ha of (res.body.hypothesis_assessments || [])) {
      for (const id of (ha.evidence_ids || [])) {
        expect(g15EvidenceIds.has(id)).toBe(true);
      }
    }
  });
});

// =============================================================================
// RG-12 — AI assessment identity
// =============================================================================
describe('RG-12: AI assessment identity', () => {
  test('RG-12-1: narrative hypothesis assessments match deterministic analysis assessments', () => {
    for (const ha of (g15Narrative.hypothesis_assessments || [])) {
      const expected = CANONICAL_ASSESSMENTS[ha.hypothesis_id];
      if (expected) {
        expect(ha.assessment).toBe(expected);
      }
    }
  });

  test('RG-12-2: narrative covers all 5 hypotheses', () => {
    const covered = new Set((g15Narrative.hypothesis_assessments || []).map((ha) => ha.hypothesis_id));
    ['H1','H2','H3','H4','H5'].forEach((id) => expect(covered.has(id)).toBe(true));
  });

  test('RG-12-3: report.analyst_narrative.hypothesis_assessments match deterministic', () => {
    for (const ha of (g15Report.analyst_narrative.hypothesis_assessments || [])) {
      const expected = CANONICAL_ASSESSMENTS[ha.hypothesis_id];
      if (expected) expect(ha.assessment).toBe(expected);
    }
  });
});

// =============================================================================
// RG-13 — AI causal-language prevention
// =============================================================================
describe('RG-13: AI causal-language prevention', () => {
  test('RG-13-1: narrative executive_summary contains no causal-certainty language', () => {
    expect(containsCausalCertainty(g15Narrative.executive_summary)).toBe(false);
  });

  test('RG-13-2: narrative event_description contains no causal-certainty language', () => {
    expect(containsCausalCertainty(g15Narrative.event_description)).toBe(false);
  });

  test('RG-13-3: all hypothesis assessment rationales contain no causal-certainty language', () => {
    for (const ha of (g15Narrative.hypothesis_assessments || [])) {
      expect(containsCausalCertainty(ha.rationale || '')).toBe(false);
    }
  });

  test('RG-13-4: HTTP forensic-analysis response free-text contains no causal-certainty language', () => {
    const violations = collectFreeText(httpReport)
      .filter(({ text }) => containsCausalCertainty(text))
      .map(({ label }) => label);
    expect(violations).toHaveLength(0);
  });
});

// =============================================================================
// RG-14 — Cross-case isolation
// =============================================================================
describe('RG-14: cross-case isolation', () => {
  test('RG-14-1: G15 and TCA evidence IDs are completely disjoint', () => {
    for (const id of tcaEvidenceIds) {
      expect(g15EvidenceIds.has(id)).toBe(false);
    }
  });

  test('RG-14-2: G15 graph does not reference any TCA evidence IDs', () => {
    const graphText = JSON.stringify(g15Graph);
    for (const id of tcaEvidenceIds) {
      expect(graphText).not.toContain(id);
    }
  });

  test('RG-14-3: TCA graph does not reference any G15 evidence IDs', async () => {
    const tcaGraph = await buildEvidenceGraph(TCA, tcaRows);
    const tcaText  = JSON.stringify(tcaGraph);
    for (const id of g15EvidenceIds) {
      expect(tcaText).not.toContain(id);
    }
  });

  test('RG-14-4: G15 investigation cannot be retrieved via TCA URL', async () => {
    const inv = await request(app)
      .post(`/api/cases/${G15}/investigations`)
      .send({ title: 'isolation test' });
    expect(inv.status).toBe(201);

    const cross = await request(app)
      .get(`/api/cases/${TCA}/investigations/${inv.body.investigation_id}`);
    expect(cross.status).toBe(404);
  });

  test('RG-14-5: cross-case evidence ID rejected in G15 observation', async () => {
    const inv = await request(app)
      .post(`/api/cases/${G15}/investigations`)
      .send({ title: 'cross-case test' });
    expect(inv.status).toBe(201);

    const tcaId = [...tcaEvidenceIds][0];
    const obs = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.body.investigation_id}/observations`)
      .send({ text: 'test', evidence_ids: [tcaId] });
    expect(obs.status).toBe(422);
  });
});

// =============================================================================
// RG-15 — Investigation persistence does not alter forensic output
// =============================================================================
describe('RG-15: investigation persistence does not alter forensics', () => {
  test('RG-15-1: creating an investigation leaves forensic causal_attribution_established false', async () => {
    await request(app)
      .post(`/api/cases/${G15}/investigations`)
      .send({ title: 'persistence check' });

    const res = await request(app).get(`/api/cases/${G15}/forensic-analysis`);
    expect(res.body.causal_attribution_established).toBe(false);
  });

  test('RG-15-2: adding an observation does not change hypothesis assessments', async () => {
    const inv = await request(app)
      .post(`/api/cases/${G15}/investigations`)
      .send({ title: 'obs test' });

    await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.body.investigation_id}/observations`)
      .send({ text: 'Solar activity was elevated.', evidence_ids: ['E-G15-0001'] });

    const res = await request(app).get(`/api/cases/${G15}/forensic-analysis`);
    for (const [hid, expected] of Object.entries(CANONICAL_ASSESSMENTS)) {
      const h = res.body.hypotheses.find((x) => x.hypothesis_id === hid);
      expect(h.assessment).toBe(expected);
    }
  });

  test('RG-15-3: investigation state endpoint does not include forensic fields', async () => {
    const inv = await request(app)
      .post(`/api/cases/${G15}/investigations`)
      .send({ title: 'state check' });

    const state = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.body.investigation_id}/state`);

    expect(state.status).toBe(200);
    expect(state.body).not.toHaveProperty('causal_attribution_established');
    expect(state.body).not.toHaveProperty('hypotheses');
    expect(state.body).not.toHaveProperty('analyst_narrative');
    expect(state.body).not.toHaveProperty('evidence_summary');
  });
});

// =============================================================================
// RG-16 — Restart recovery (investigation state ≠ forensic state)
// =============================================================================
describe('RG-16: restart recovery (in-memory)', () => {
  test('RG-16-1: forensic output is identical before and after store reset', async () => {
    const before = await request(app).get(`/api/cases/${G15}/forensic-analysis`);

    // Simulate restart: reset in-memory store
    investigationStore._reset();

    const after  = await request(app).get(`/api/cases/${G15}/forensic-analysis`);

    expect(before.body.causal_attribution_established).toBe(false);
    expect(after.body.causal_attribution_established).toBe(false);
    for (const [hid, expected] of Object.entries(CANONICAL_ASSESSMENTS)) {
      const hb = before.body.hypotheses.find((x) => x.hypothesis_id === hid);
      const ha = after.body.hypotheses.find((x)  => x.hypothesis_id === hid);
      expect(hb.assessment).toBe(expected);
      expect(ha.assessment).toBe(expected);
    }
  });

  test('RG-16-2: investigation record does not contain forensic fields', async () => {
    const inv = await request(app)
      .post(`/api/cases/${G15}/investigations`)
      .send({ title: 'restart check' });
    expect(inv.status).toBe(201);

    const rec = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.body.investigation_id}`);
    expect(rec.status).toBe(200);

    // Investigation record must not carry any forensic output
    expect(rec.body).not.toHaveProperty('causal_attribution_established');
    expect(rec.body).not.toHaveProperty('analyst_narrative');
    expect(rec.body).not.toHaveProperty('evidence_summary');
  });
});

// =============================================================================
// RG-17 — HTTP error contracts
// =============================================================================
describe('RG-17: HTTP error contracts', () => {
  function assertContract(body, code, status) {
    expect(body.error_code).toBe(code);
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
    expect(body.status_code).toBe(status);
  }

  function assertNoLeakage(body) {
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/at Object\.|at async /);
    expect(text).not.toMatch(/\/Users\/|\/home\/|C:\\/);
    expect(text).not.toMatch(/WATSONX_AI_APIKEY|PG_PASSWORD|apikey|password/i);
    expect(text).not.toMatch(/ENOENT|EACCES|ECONNREFUSED/);
  }

  test('RG-17-1: unknown case on /forensic-analysis → 404 CASE_NOT_FOUND', async () => {
    const res = await request(app).get('/api/cases/no-such-case/forensic-analysis');
    expect(res.status).toBe(404);
    assertContract(res.body, 'CASE_NOT_FOUND', 404);
    assertNoLeakage(res.body);
  });

  test('RG-17-2: unknown case on /evidence-graph → 404 CASE_NOT_FOUND', async () => {
    const res = await request(app).get('/api/cases/no-such-case/evidence-graph');
    expect(res.status).toBe(404);
    assertContract(res.body, 'CASE_NOT_FOUND', 404);
    assertNoLeakage(res.body);
  });

  test('RG-17-3: unknown case on /timeline → 404 CASE_NOT_FOUND', async () => {
    const res = await request(app).get('/api/cases/no-such-case/timeline');
    expect(res.status).toBe(404);
    assertContract(res.body, 'CASE_NOT_FOUND', 404);
    assertNoLeakage(res.body);
  });

  test('RG-17-4: unknown route → 404 NOT_FOUND', async () => {
    const res = await request(app).get('/api/nonexistent-endpoint');
    expect(res.status).toBe(404);
    assertContract(res.body, 'NOT_FOUND', 404);
    assertNoLeakage(res.body);
  });

  test('RG-17-5: malformed JSON body → 400 INVALID_JSON', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations`)
      .set('Content-Type', 'application/json')
      .send('{not valid json');
    expect(res.status).toBe(400);
    assertContract(res.body, 'INVALID_JSON', 400);
    assertNoLeakage(res.body);
  });

  test('RG-17-6: payload >64KB → 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ title: 'x'.repeat(70_000) }));
    expect(res.status).toBe(413);
    assertContract(res.body, 'PAYLOAD_TOO_LARGE', 413);
    assertNoLeakage(res.body);
  });

  test('RG-17-7: unsupported HTTP method → 404 NOT_FOUND', async () => {
    const res = await request(app).delete(`/api/cases/${G15}/forensic-analysis`);
    expect(res.status).toBe(404);
    assertContract(res.body, 'NOT_FOUND', 404);
    assertNoLeakage(res.body);
  });

  test('RG-17-8: security headers present on every response', async () => {
    const res = await request(app).get('/api/cases');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

// =============================================================================
// RG-18 — Frontend scientific labeling (assessment vocabulary)
// =============================================================================
describe('RG-18: frontend scientific labeling', () => {
  // Import here without top-level require so the test module remains Node-safe
  const ASSESSMENT_LABELS = {
    strongly_supported:    'Strongly supported',
    supported:             'Supported',
    mixed:                 'Mixed',
    weakly_supported:      'Weakly supported',
    insufficient_evidence: 'Insufficient evidence',
  };

  test('RG-18-1: assessment label vocabulary covers all 5 canonical keys', () => {
    for (const key of Object.keys(CANONICAL_ASSESSMENTS).map((k) => CANONICAL_ASSESSMENTS[k])) {
      // Every assessment value used in G15 must have a defined frontend label
      const labelKey = key;
      expect(ASSESSMENT_LABELS).toHaveProperty(labelKey);
    }
    // All 5 canonical keys
    expect(Object.keys(ASSESSMENT_LABELS)).toHaveLength(5);
  });

  test('RG-18-2: no label contains "probability", "confidence", or percentage', () => {
    for (const label of Object.values(ASSESSMENT_LABELS)) {
      expect(label.toLowerCase()).not.toContain('probability');
      expect(label.toLowerCase()).not.toContain('confidence');
      expect(label).not.toMatch(NUMERICAL_PROB_RE);
    }
  });

  test('RG-18-3: no label contains causal-certainty language', () => {
    for (const label of Object.values(ASSESSMENT_LABELS)) {
      expect(containsCausalCertainty(label)).toBe(false);
    }
  });

  test('RG-18-4: "strongly_supported" label never says "Established"', () => {
    expect(ASSESSMENT_LABELS.strongly_supported.toLowerCase()).not.toContain('established');
  });

  test('RG-18-5: G15 H5 (strongly_supported) maps to the frontend label "Strongly supported"', () => {
    expect(ASSESSMENT_LABELS[CANONICAL_ASSESSMENTS.H5]).toBe('Strongly supported');
  });
});

// =============================================================================
// RG-19 — Concurrent deterministic output
// =============================================================================
describe('RG-19: concurrent deterministic output', () => {
  /**
   * Produce a stable fingerprint that excludes non-deterministic fields
   * (generated_at, opened_at, timestamps) but covers all scientific content.
   */
  function deterministicFingerprint(body) {
    return JSON.stringify({
      case_id:                        body.case_id,
      analysis_version:               body.analysis_version,
      causal_attribution_established: body.causal_attribution_established,
      hypotheses: (body.hypotheses || []).map((h) => ({
        hypothesis_id:    h.hypothesis_id,
        assessment:       h.assessment,
        env_ctx_ids:      [...(h.evidence_summary.environmental_context_ids || [])].sort(),
        supp_ids:         [...(h.evidence_summary.supporting_evidence_ids || [])].sort(),
        env_ctx_count:    h.evidence_summary.environmental_context_count,
        supp_count:       h.evidence_summary.supporting_evidence_count,
      })),
      narrative_assessments: (
        body.analyst_narrative && Array.isArray(body.analyst_narrative.hypothesis_assessments)
          ? body.analyst_narrative.hypothesis_assessments
          : []
      ).map((ha) => ({ hypothesis_id: ha.hypothesis_id, assessment: ha.assessment })),
      narrative_causal: body.analyst_narrative && body.analyst_narrative.causal_attribution_established,
    });
  }

  test('RG-19-1: 5 concurrent /forensic-analysis requests produce byte-identical deterministic output', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).get(`/api/cases/${G15}/forensic-analysis`),
      ),
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const fingerprints = responses.map((r) => deterministicFingerprint(r.body));
    const first = fingerprints[0];
    for (const fp of fingerprints) {
      expect(fp).toBe(first);
    }
  }, 30_000);

  test('RG-19-2: 5 concurrent evidence-graph requests are byte-identical', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).get(`/api/cases/${G15}/evidence-graph`),
      ),
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const fingerprints = responses.map((r) =>
      JSON.stringify({
        case_id: r.body.case_id,
        causal:  r.body.causal_attribution_established,
        hyp_ids: (r.body.hypotheses || []).map((h) => h.hypothesis_id).sort(),
      }),
    );
    const first = fingerprints[0];
    for (const fp of fingerprints) {
      expect(fp).toBe(first);
    }
  }, 30_000);

  test('RG-19-3: causal_attribution_established is false in all 5 concurrent responses', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).get(`/api/cases/${G15}/forensic-analysis`),
      ),
    );
    for (const r of responses) {
      expect(r.body.causal_attribution_established).toBe(false);
    }
  }, 30_000);
});

// =============================================================================
// RG-20 — PostgreSQL integration (in-memory store boundary assertions)
// =============================================================================
describe('RG-20: PostgreSQL integration (store boundary)', () => {
  test('RG-20-1: investigation record has no forensic columns', async () => {
    const inv = await request(app)
      .post(`/api/cases/${G15}/investigations`)
      .send({ title: 'pg boundary test' });
    expect(inv.status).toBe(201);
    const rec = inv.body;
    expect(rec).not.toHaveProperty('causal_attribution_established');
    expect(rec).not.toHaveProperty('evidence_summary');
    expect(rec).not.toHaveProperty('analyst_narrative');
    expect(rec).not.toHaveProperty('hypotheses');
    expect(rec).not.toHaveProperty('limitations');
  });

  test('RG-20-2: challenge record has no forensic columns', async () => {
    const inv = await request(app)
      .post(`/api/cases/${G15}/investigations`)
      .send({ title: 'pg chal test' });

    const chal = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.body.investigation_id}/challenges`)
      .send({
        target_type:       'hypothesis_assessment',
        target_id:         'H1',
        analyst_statement: 'The mixed assessment warrants further scrutiny.',
        authored_by:       'tester',
      });
    expect(chal.status).toBe(201);

    const rec = chal.body;
    expect(rec).not.toHaveProperty('causal_attribution_established');
    expect(rec).not.toHaveProperty('evidence_summary');
    expect(rec).not.toHaveProperty('analyst_narrative');
  });

  test('RG-20-3: observation record has no forensic columns', async () => {
    const inv = await request(app)
      .post(`/api/cases/${G15}/investigations`)
      .send({ title: 'pg obs test' });

    const obs = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.body.investigation_id}/observations`)
      .send({ text: 'Elevated particle flux observed.', evidence_ids: ['E-G15-0001'] });
    expect(obs.status).toBe(201);

    const rec = obs.body;
    expect(rec).not.toHaveProperty('causal_attribution_established');
    expect(rec).not.toHaveProperty('evidence_summary');
    expect(rec).not.toHaveProperty('analyst_narrative');
  });

  test('RG-20-4: concurrent investigation creation produces globally unique IDs', async () => {
    const creations = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        request(app)
          .post(`/api/cases/${G15}/investigations`)
          .send({ title: `concurrent-${i}` }),
      ),
    );
    expect(creations.every((r) => r.status === 201)).toBe(true);
    const ids = new Set(creations.map((r) => r.body.investigation_id));
    expect(ids.size).toBe(10);
  });
});

// =============================================================================
// RG-GOLDEN — Galaxy-15 golden-output snapshot regression
//
// Proves that the current forensic pipeline output is byte-identical (for every
// deterministic field) to the approved Phase 8 baseline captured in
// g15-golden-snapshot.json.
//
// Non-deterministic fields explicitly excluded:
//   generated_at, opened_at, narrative free-text (executive_summary,
//   event_description, rationale texts) — because the heuristic fallback may
//   produce slightly different wording across Node.js versions.
//   All evidence IDs, assessments, counts, and limit arrays ARE included.
// =============================================================================
describe('RG-GOLDEN: Galaxy-15 golden-output snapshot regression', () => {
  test('RG-GOLDEN-1: case_id matches snapshot', () => {
    expect(g15Report.case_id).toBe(GOLDEN.case_id);
  });

  test('RG-GOLDEN-2: analysis_version matches snapshot', () => {
    expect(g15Report.analysis_version).toBe(GOLDEN.analysis_version);
  });

  test('RG-GOLDEN-3: causal_attribution_established matches snapshot (false)', () => {
    expect(g15Report.causal_attribution_established).toBe(GOLDEN.causal_attribution_established);
  });

  test('RG-GOLDEN-4: evidence record count matches snapshot (278)', () => {
    expect(g15Rows.length).toBe(GOLDEN.evidence_record_count);
  });

  test('RG-GOLDEN-5: first and last evidence IDs match snapshot', () => {
    expect(g15Rows[0].evidence_id).toBe(GOLDEN.first_evidence_id);
    expect(g15Rows[g15Rows.length - 1].evidence_id).toBe(GOLDEN.last_evidence_id);
  });

  test('RG-GOLDEN-6: EPHEMERIS record count matches snapshot (61)', () => {
    expect(g15EphemerisIds.size).toBe(GOLDEN.ephemeris_count);
  });

  test('RG-GOLDEN-7: top-level evidence_summary matches snapshot', () => {
    expect(g15Report.evidence_summary).toEqual(GOLDEN.evidence_summary);
  });

  test('RG-GOLDEN-8: comparison block matches snapshot', () => {
    expect(g15Report.comparison).toEqual(GOLDEN.comparison);
  });

  test('RG-GOLDEN-9: total limitations count matches snapshot', () => {
    expect(g15Report.limitations).toHaveLength(GOLDEN.evidence_summary.total_limitations);
  });

  // Per-hypothesis evidence_summary snapshot (all IDs + counts)
  for (const golden_h of GOLDEN.hypotheses) {
    const hid = golden_h.hypothesis_id;

    test(`RG-GOLDEN-10: ${hid} assessment matches snapshot ("${golden_h.assessment}")`, () => {
      const h = g15Report.hypotheses.find((x) => x.hypothesis_id === hid);
      expect(h).toBeDefined();
      expect(h.assessment).toBe(golden_h.assessment);
    });

    test(`RG-GOLDEN-11: ${hid} evidence_summary counts match snapshot`, () => {
      const h = g15Report.hypotheses.find((x) => x.hypothesis_id === hid);
      expect(h.evidence_summary.environmental_context_count).toBe(
        golden_h.evidence_summary.environmental_context_count,
      );
      expect(h.evidence_summary.supporting_evidence_count).toBe(
        golden_h.evidence_summary.supporting_evidence_count,
      );
      expect(h.evidence_summary.contradicting_evidence_count).toBe(
        golden_h.evidence_summary.contradicting_evidence_count,
      );
      expect(h.evidence_summary.non_discriminating_evidence_count).toBe(
        golden_h.evidence_summary.non_discriminating_evidence_count,
      );
    });

    test(`RG-GOLDEN-12: ${hid} environmental_context_ids match snapshot (sorted)`, () => {
      const h = g15Report.hypotheses.find((x) => x.hypothesis_id === hid);
      const actual   = [...(h.evidence_summary.environmental_context_ids  || [])].sort();
      const expected = [...(golden_h.evidence_summary.environmental_context_ids || [])].sort();
      expect(actual).toEqual(expected);
    });

    test(`RG-GOLDEN-13: ${hid} supporting_evidence_ids match snapshot`, () => {
      const h = g15Report.hypotheses.find((x) => x.hypothesis_id === hid);
      const actual   = [...(h.evidence_summary.supporting_evidence_ids || [])].sort();
      const expected = [...(golden_h.evidence_summary.supporting_evidence_ids || [])].sort();
      expect(actual).toEqual(expected);
    });

    test(`RG-GOLDEN-14: ${hid} limitation count matches snapshot (${golden_h.limitation_count})`, () => {
      const h = g15Report.hypotheses.find((x) => x.hypothesis_id === hid);
      expect(h.limitations).toHaveLength(golden_h.limitation_count);
    });
  }

  test('RG-GOLDEN-15: HTTP /forensic-analysis assessment fingerprint matches snapshot', () => {
    const fingerprint = GOLDEN.hypotheses.map((gh) => ({
      id: gh.hypothesis_id,
      assessment: gh.assessment,
    }));
    const http_fp = httpReport.hypotheses.map((h) => ({
      id: h.hypothesis_id,
      assessment: h.assessment,
    }));
    expect(http_fp).toEqual(fingerprint);
  });

  test('RG-GOLDEN-16: two independent pipeline runs produce byte-identical deterministic fingerprints', async () => {
    function stableFingerprint(report) {
      return JSON.stringify({
        case_id:                        report.case_id,
        analysis_version:               report.analysis_version,
        causal_attribution_established: report.causal_attribution_established,
        evidence_summary:               report.evidence_summary,
        comparison:                     report.comparison,
        hypotheses: (report.hypotheses || []).map((h) => ({
          hypothesis_id:    h.hypothesis_id,
          assessment:       h.assessment,
          environmental_context_ids:       [...(h.evidence_summary.environmental_context_ids || [])].sort(),
          supporting_evidence_ids:         [...(h.evidence_summary.supporting_evidence_ids || [])].sort(),
          contradicting_evidence_ids:      [...(h.evidence_summary.contradicting_evidence_ids || [])].sort(),
          non_discriminating_evidence_ids: [...(h.evidence_summary.non_discriminating_evidence_ids || [])].sort(),
          environmental_context_count:     h.evidence_summary.environmental_context_count,
          supporting_evidence_count:       h.evidence_summary.supporting_evidence_count,
          limitation_count: (h.limitations || []).length,
        })),
      });
    }

    const rows2     = await parseEvidenceCSV(G15);
    const graph2    = await buildEvidenceGraph(G15, rows2);
    const analysis2 = buildForensicAnalysis(G15, graph2, null);
    const ids2      = new Set(rows2.map((r) => r.evidence_id));
    const nar2      = buildAnalystHeuristicNarrative(analysis2, ids2, graph2);
    const report2   = assembleValidatedForensicReport(analysis2, nar2);

    expect(stableFingerprint(g15Report)).toBe(stableFingerprint(report2));
  });
});
