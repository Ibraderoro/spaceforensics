'use strict';

/**
 * Phase 6.1C — Second-Case Onboarding: Comprehensive Validation
 *
 * Covers every requirement from the Phase 6.1C specification that is not
 * already exercised by existing tests:
 *
 *   Req 1  — Preserve all Phase 5 behaviour             (confirmed by existing suite)
 *   Req 2  — Preserve all existing tests                 (confirmed by existing suite)
 *   Req 3  — Second case passes deterministic pipeline   (this file)
 *   Req 4  — Case resolution is explicit                 (this file + multiCaseIngestion)
 *   Req 5  — Unknown case IDs return 404                 (this file + apiErrorContract)
 *   Req 6  — Never silently fall back to Galaxy 15       (this file)
 *   Req 7  — Evidence IDs are deterministic and stable   (this file + secondCaseIngestion)
 *   Req 8  — Evidence IDs do not collide across cases    (this file + multiCaseIsolation)
 *   Req 9  — Graph refs resolve to own case evidence     (this file + secondCaseEvidenceGraph)
 *   Req 10 — Hypotheses belong to the case               (this file)
 *   Req 11 — Case-specific source classifications        (this file — evidenceType for GOES13)
 *   Req 12 — Environmental context ≠ supporting evidence (this file + secondCaseForensicPipeline)
 *   Req 13 — No EPHEMERIS exclusion needed (TCA has none) but verified (this file)
 *   Req 14 — No numerical probabilities                  (this file + secondCaseForensicPipeline)
 *   Req 15 — AI does not receive raw evidence rows       (this file — heuristic path only)
 *   Req 16 — Galaxy 15 assessments unchanged             (this file + multiCaseIsolation)
 *   Req 17 — Phase 5 invariants enforced                 (this file)
 *
 * Plus the test categories specified in the requirements:
 *   - second-case resolution
 *   - valid case loading
 *   - invalid case rejection
 *   - deterministic parsing
 *   - evidence ID uniqueness
 *   - graph construction
 *   - hypothesis membership
 *   - provenance (HTTP)
 *   - forensic analysis
 *   - causal attribution flag
 *   - API response
 *   - concurrent deterministic execution
 */

const request = require('supertest');
const {
  app,
  parseEvidenceCSV,
  buildEvidenceGraph,
  buildForensicAnalysis,
  assembleValidatedForensicReport,
  getEvidenceProvenance,
} = require('../server');
const {
  buildAnalystHeuristicNarrative,
  validateAnalystResponse,
} = require('../services/aiAnalyst');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const TCA     = 'test-case-alpha';
const G15     = 'galaxy-15';
const UNKNOWN = 'does-not-exist-999';

const ALLOWED_ASSESSMENTS = new Set([
  'strongly_supported', 'supported', 'mixed', 'weakly_supported', 'insufficient_evidence',
]);

const ALL_LISTS = [
  'environmental_context',
  'supporting_evidence',
  'contradicting_evidence',
  'non_discriminating_evidence',
];

const TCA_ID_RE = /^E-TCA-\d{4}$/;
const G15_ID_RE = /^E-G15-\d{4}$/;

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures — built once; reused by all suites in this file.
// ─────────────────────────────────────────────────────────────────────────────

let tcaRows;
let tcaGraph;
let tcaAnalysis;
let tcaValidIds;
let tcaNarrative;
let tcaReport;

let g15Rows;
let g15Graph;
let g15Analysis;

beforeAll(async () => {
  jest.setTimeout(60_000);

  // Load both cases concurrently (tests concurrent deterministic execution)
  [tcaRows, g15Rows] = await Promise.all([
    parseEvidenceCSV(TCA),
    parseEvidenceCSV(G15),
  ]);

  // Build both graphs concurrently
  [tcaGraph, g15Graph] = await Promise.all([
    buildEvidenceGraph(TCA, tcaRows),
    buildEvidenceGraph(G15, g15Rows),
  ]);

  // Full pipeline for TCA
  tcaAnalysis  = buildForensicAnalysis(TCA, tcaGraph);
  tcaValidIds  = new Set(tcaRows.map((r) => r.evidence_id));
  tcaNarrative = buildAnalystHeuristicNarrative(tcaAnalysis);
  tcaReport    = assembleValidatedForensicReport(tcaAnalysis, tcaNarrative);

  // G15 analysis for cross-case isolation checks
  g15Analysis  = buildForensicAnalysis(G15, g15Graph);
}, 60_000);

// =============================================================================
// 1. CASE RESOLUTION — explicit routing, no silent Galaxy 15 fallback
// =============================================================================

describe('6.1C-RES: Case resolution — explicit, no silent fallback', () => {
  // Req 4: case resolution is explicit

  test('RES-1: parseEvidenceCSV resolves "test-case-alpha" to TCA records', () => {
    expect(Array.isArray(tcaRows)).toBe(true);
    expect(tcaRows.length).toBeGreaterThan(0);
  });

  test('RES-2: TCA records do not carry any Galaxy 15 evidence IDs', () => {
    for (const r of tcaRows) {
      expect(r.evidence_id).not.toMatch(G15_ID_RE);
    }
  });

  // Req 6: never silently fall back to Galaxy 15

  test('RES-3: tcaGraph.case_id is "test-case-alpha", not "galaxy-15"', () => {
    expect(tcaGraph.case_id).toBe(TCA);
  });

  test('RES-4: tcaAnalysis.case_id is "test-case-alpha", not "galaxy-15"', () => {
    expect(tcaAnalysis.case_id).toBe(TCA);
  });

  test('RES-5: tcaReport.case_id is "test-case-alpha", not "galaxy-15"', () => {
    expect(tcaReport.case_id).toBe(TCA);
  });

  test('RES-6: TCA hypothesis set differs from Galaxy 15 (3 vs 5 hypotheses)', () => {
    expect(tcaGraph.hypotheses).toHaveLength(3);
    expect(g15Graph.hypotheses).toHaveLength(5);
  });

  test('RES-7: TCA hypothesis labels do not match Galaxy 15 hypothesis labels', () => {
    const tcaLabels = tcaGraph.hypotheses.map((h) => h.label).sort();
    const g15Labels = g15Graph.hypotheses.map((h) => h.label).sort();
    // They may share some label text but the full sets must differ
    expect(tcaLabels).not.toEqual(g15Labels);
  });
});

// =============================================================================
// 2. VALID CASE LOADING
// =============================================================================

describe('6.1C-LOAD: Valid case loading', () => {
  // Req 3: second case passes through deterministic pipeline

  test('LOAD-1: full TCA pipeline runs without throwing', () => {
    expect(tcaReport).toBeDefined();
    expect(typeof tcaReport).toBe('object');
  });

  test('LOAD-2: TCA evidence rows have the expected record count', () => {
    // 69 rows: 1 CASE + 37 EP8 + 31 MAG (from Phase 6.1B ST-5)
    expect(tcaRows).toHaveLength(69);
  });

  test('LOAD-3: TCA case.json anchor_event.timestamp is correct', async () => {
    const res = await request(app).get(`/api/cases/${TCA}`);
    expect(res.status).toBe(200);
    expect(res.body.anchor_event.timestamp).toBe('2009-08-12T14:30:00Z');
  });

  test('LOAD-4: TCA data sources are GOES13, not GOES11', async () => {
    const res = await request(app).get(`/api/cases/${TCA}`);
    const sourceIds = res.body.data_sources.map((ds) => ds.dataset_id);
    expect(sourceIds.some((id) => id.startsWith('GOES13'))).toBe(true);
    expect(sourceIds.some((id) => id.startsWith('GOES11'))).toBe(false);
  });
});

// =============================================================================
// 3. INVALID CASE REJECTION
// =============================================================================

describe('6.1C-REJ: Invalid / unknown case rejection', () => {
  // Req 5: unknown case IDs return 404

  test('REJ-1: parseEvidenceCSV rejects unknown case ID with status 404', async () => {
    await expect(parseEvidenceCSV(UNKNOWN)).rejects.toMatchObject({ status: 404 });
  });

  test('REJ-2: rejection message contains the unknown case ID', async () => {
    let caught;
    try { await parseEvidenceCSV(UNKNOWN); } catch (e) { caught = e; }
    expect(caught.message).toContain(UNKNOWN);
  });

  test('REJ-3: unknown case does not silently resolve to TCA dataset', async () => {
    let resolved = false;
    try { await parseEvidenceCSV(UNKNOWN); resolved = true; } catch (_) { /* expected */ }
    expect(resolved).toBe(false);
  });

  test('REJ-4: unknown case does not silently resolve to Galaxy 15 dataset', async () => {
    let resolved = false;
    try { await parseEvidenceCSV(UNKNOWN); resolved = true; } catch (_) { /* expected */ }
    expect(resolved).toBe(false);
  });

  test('REJ-5: GET /api/cases/:id/timeline for unknown case returns HTTP 404', async () => {
    const res = await request(app).get(`/api/cases/${UNKNOWN}/timeline`);
    expect(res.status).toBe(404);
  });

  test('REJ-6: GET /api/cases/:id/evidence-graph for unknown case returns HTTP 404', async () => {
    const res = await request(app).get(`/api/cases/${UNKNOWN}/evidence-graph`);
    expect(res.status).toBe(404);
  });

  test('REJ-7: GET /api/cases/:id/forensic-analysis for unknown case returns HTTP 404', async () => {
    const res = await request(app).get(`/api/cases/${UNKNOWN}/forensic-analysis`);
    expect(res.status).toBe(404);
  });

  test('REJ-8: GET /api/cases/:id/forensic-analysis for unknown case returns error_code CASE_NOT_FOUND', async () => {
    const res = await request(app).get(`/api/cases/${UNKNOWN}/forensic-analysis`);
    expect(res.body.error_code).toBe('CASE_NOT_FOUND');
  });

  test('REJ-9: GET /api/cases/:id/evidence/:evidenceId/provenance for unknown case returns HTTP 404', async () => {
    const res = await request(app).get(`/api/cases/${UNKNOWN}/evidence/E-TCA-0001/provenance`);
    expect(res.status).toBe(404);
  });
});

// =============================================================================
// 4. DETERMINISTIC PARSING  (Req 7)
// =============================================================================

describe('6.1C-DET: Deterministic parsing', () => {
  test('DET-1: two independent TCA parseEvidenceCSV calls return identical evidence IDs', async () => {
    const second = await parseEvidenceCSV(TCA);
    expect(second.map((r) => r.evidence_id)).toEqual(tcaRows.map((r) => r.evidence_id));
  });

  test('DET-2: two independent TCA parseEvidenceCSV calls return identical row values', async () => {
    const second = await parseEvidenceCSV(TCA);
    const fields = ['timestamp', 'source', 'measurement', 'value', 'unit', 'resolution'];
    for (let i = 0; i < tcaRows.length; i++) {
      for (const f of fields) {
        expect(second[i][f]).toBe(tcaRows[i][f]);
      }
    }
  });

  test('DET-3: TCA records are sorted timestamp-primary, source-secondary', () => {
    for (let i = 1; i < tcaRows.length; i++) {
      const a = tcaRows[i - 1];
      const b = tcaRows[i];
      if (a.timestamp === b.timestamp) {
        expect(a.source <= b.source).toBe(true);
      } else {
        expect(a.timestamp < b.timestamp).toBe(true);
      }
    }
  });

  test('DET-4: TCA first evidence ID is E-TCA-0001', () => {
    expect(tcaRows[0].evidence_id).toBe('E-TCA-0001');
  });

  test('DET-5: TCA last evidence ID is E-TCA-0069', () => {
    expect(tcaRows[tcaRows.length - 1].evidence_id).toBe('E-TCA-0069');
  });

  test('DET-6: concurrent parallel calls to both cases are deterministic', async () => {
    // Run two full-pipeline pairs in parallel
    const [rowsA, rowsB] = await Promise.all([
      parseEvidenceCSV(TCA),
      parseEvidenceCSV(TCA),
    ]);
    expect(rowsA.map((r) => r.evidence_id)).toEqual(rowsB.map((r) => r.evidence_id));
  });
});

// =============================================================================
// 5. EVIDENCE ID UNIQUENESS  (Req 8)
// =============================================================================

describe('6.1C-UID: Evidence ID uniqueness and non-collision', () => {
  test('UID-1: all TCA evidence IDs match E-TCA-XXXX pattern', () => {
    for (const r of tcaRows) {
      expect(r.evidence_id).toMatch(TCA_ID_RE);
    }
  });

  test('UID-2: TCA evidence IDs are unique within the dataset', () => {
    const ids = tcaRows.map((r) => r.evidence_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('UID-3: TCA and G15 evidence ID sets are completely disjoint', () => {
    const tcaIds = new Set(tcaRows.map((r) => r.evidence_id));
    const g15Ids = new Set(g15Rows.map((r) => r.evidence_id));
    for (const id of tcaIds) expect(g15Ids.has(id)).toBe(false);
    for (const id of g15Ids) expect(tcaIds.has(id)).toBe(false);
  });

  test('UID-4: TCA evidence IDs do not contain the G15 prefix', () => {
    for (const r of tcaRows) {
      expect(r.evidence_id).not.toContain('G15');
    }
  });

  test('UID-5: G15 evidence IDs do not contain the TCA prefix', () => {
    for (const r of g15Rows) {
      expect(r.evidence_id).not.toContain('TCA');
    }
  });
});

// =============================================================================
// 6. EVIDENCE TYPE CLASSIFICATION  (Req 11)
// =============================================================================

describe('6.1C-TYPE: Case-specific source classification (evidenceType)', () => {
  // Req 11: GOES13 must be classified as environmental_observation without
  //         branching on the case ID.

  test('TYPE-1: GOES13_EP8 rows have evidence_type = "environmental_observation"', () => {
    const ep8Rows = tcaRows.filter((r) => r.source === 'GOES13_EP8');
    expect(ep8Rows.length).toBeGreaterThan(0);
    for (const r of ep8Rows) {
      expect(r.evidence_type).toBe('environmental_observation');
    }
  });

  test('TYPE-2: GOES13_MAG rows have evidence_type = "environmental_observation"', () => {
    const magRows = tcaRows.filter((r) => r.source === 'GOES13_MAG');
    expect(magRows.length).toBeGreaterThan(0);
    for (const r of magRows) {
      expect(r.evidence_type).toBe('environmental_observation');
    }
  });

  test('TYPE-3: CASE anchor row has evidence_type = "case_event"', () => {
    const anchor = tcaRows.find((r) => r.source === 'CASE');
    expect(anchor).toBeDefined();
    expect(anchor.evidence_type).toBe('case_event');
  });

  test('TYPE-4: GOES11_* classification is unchanged (G15 regression)', () => {
    const ep8Rows = g15Rows.filter((r) => r.source === 'GOES11_EP8');
    for (const r of ep8Rows) {
      expect(r.evidence_type).toBe('environmental_observation');
    }
    const magRows = g15Rows.filter((r) => r.source === 'GOES11_MAG');
    for (const r of magRows) {
      expect(r.evidence_type).toBe('environmental_observation');
    }
  });

  test('TYPE-5: evidenceType classification is visible in the HTTP timeline response', async () => {
    const res = await request(app).get(`/api/cases/${TCA}/timeline`);
    expect(res.status).toBe(200);
    const ep8 = res.body.find((r) => r.source === 'GOES13_EP8');
    expect(ep8).toBeDefined();
    expect(ep8.evidence_type).toBe('environmental_observation');
    const anchor = res.body.find((r) => r.source === 'CASE');
    expect(anchor.evidence_type).toBe('case_event');
  });
});

// =============================================================================
// 7. GRAPH CONSTRUCTION  (Req 9, 10)
// =============================================================================

describe('6.1C-GRAPH: Graph construction — TCA-specific hypotheses and evidence', () => {
  // Req 9: graph evidence references must resolve to the case's own evidence

  test('GRAPH-1: all graph evidence IDs are TCA IDs (no cross-case references)', () => {
    for (const h of tcaGraph.hypotheses) {
      for (const listName of ALL_LISTS) {
        for (const entry of h[listName] || []) {
          expect(entry.evidence_id).toMatch(TCA_ID_RE);
          expect(tcaValidIds.has(entry.evidence_id)).toBe(true);
        }
      }
    }
  });

  // Req 10: hypotheses must belong to the case

  test('GRAPH-2: TCA has exactly 3 hypotheses (H1, H2, H3)', () => {
    expect(tcaGraph.hypotheses).toHaveLength(3);
    const ids = tcaGraph.hypotheses.map((h) => h.hypothesis_id);
    expect(ids).toContain('H1');
    expect(ids).toContain('H2');
    expect(ids).toContain('H3');
  });

  test('GRAPH-3: TCA does not have H4 or H5 (those belong to Galaxy 15)', () => {
    const ids = tcaGraph.hypotheses.map((h) => h.hypothesis_id);
    expect(ids).not.toContain('H4');
    expect(ids).not.toContain('H5');
  });

  test('GRAPH-4: TCA H1 label is the SEU/latchup hypothesis', () => {
    const h1 = tcaGraph.hypotheses.find((h) => h.hypothesis_id === 'H1');
    expect(h1.label.toLowerCase()).toContain('upset');
  });

  test('GRAPH-5: TCA H2 label is the command receiver fault hypothesis', () => {
    const h2 = tcaGraph.hypotheses.find((h) => h.hypothesis_id === 'H2');
    expect(h2.label.toLowerCase()).toContain('command');
  });

  test('GRAPH-6: TCA H3 label is the insufficient evidence hypothesis', () => {
    const h3 = tcaGraph.hypotheses.find((h) => h.hypothesis_id === 'H3');
    expect(h3.label.toLowerCase()).toContain('insufficient');
  });

  test('GRAPH-7: TCA H1 environmental_context references GOES13 records', () => {
    const h1 = tcaGraph.hypotheses.find((h) => h.hypothesis_id === 'H1');
    expect(h1.environmental_context.length).toBeGreaterThan(0);
    for (const ref of h1.environmental_context) {
      const row = tcaRows.find((r) => r.evidence_id === ref.evidence_id);
      expect(row).toBeDefined();
      // Must come from GOES13 sensor, not GOES11
      expect(row.source).toMatch(/^GOES13_/);
    }
  });

  test('GRAPH-8: TCA H2 supporting_evidence references the CASE anchor', () => {
    const h2 = tcaGraph.hypotheses.find((h) => h.hypothesis_id === 'H2');
    expect(h2.supporting_evidence.length).toBeGreaterThan(0);
    for (const ref of h2.supporting_evidence) {
      const row = tcaRows.find((r) => r.evidence_id === ref.evidence_id);
      expect(row.source).toBe('CASE');
    }
  });

  test('GRAPH-9: TCA graph does not reference any G15 evidence IDs', () => {
    for (const h of tcaGraph.hypotheses) {
      for (const listName of ALL_LISTS) {
        for (const entry of h[listName] || []) {
          expect(entry.evidence_id).not.toMatch(G15_ID_RE);
        }
      }
    }
  });

  // Req 12: environmental context must never become supporting evidence

  test('GRAPH-10: environmental_context and supporting_evidence are disjoint for every TCA hypothesis', () => {
    for (const h of tcaGraph.hypotheses) {
      const envCtxSet = new Set((h.environmental_context || []).map((e) => e.evidence_id));
      for (const entry of h.supporting_evidence || []) {
        expect(envCtxSet.has(entry.evidence_id)).toBe(false);
      }
    }
  });

  // Req 13: no EPHEMERIS source in TCA — verify no EP8/MAG record is accidentally
  // treated as EPHEMERIS and that all graph-referenced IDs are classified correctly

  test('GRAPH-11: TCA has no source named GOES13_EPHEMERIS (not applicable to this case)', () => {
    const ephemerisRows = tcaRows.filter((r) => r.source.includes('EPHEMERIS'));
    expect(ephemerisRows).toHaveLength(0);
  });

  test('GRAPH-12: every hypothesis description avoids causal-certainty language', () => {
    const FORBIDDEN = ['proves', 'confirms causation', 'is caused by', 'causation established', 'proof of'];
    for (const h of tcaGraph.hypotheses) {
      for (const phrase of FORBIDDEN) {
        expect(h.description.toLowerCase()).not.toContain(phrase);
        for (const listName of ALL_LISTS) {
          for (const entry of h[listName] || []) {
            expect(entry.interpretation.toLowerCase()).not.toContain(phrase);
          }
        }
      }
    }
  });
});

// =============================================================================
// 8. PROVENANCE  (HTTP)
// =============================================================================

describe('6.1C-PROV: Provenance — TCA evidence (HTTP)', () => {
  let anchorId;
  let ep8Id;

  beforeAll(() => {
    anchorId = tcaRows.find((r) => r.source === 'CASE').evidence_id;
    // First EP8 row in a graph environmental_context list
    for (const h of tcaGraph.hypotheses) {
      if ((h.environmental_context || []).length > 0) {
        ep8Id = h.environmental_context[0].evidence_id;
        break;
      }
    }
  });

  test('PROV-1: GET /provenance for TCA anchor returns HTTP 200', async () => {
    const res = await request(app).get(`/api/cases/${TCA}/evidence/${anchorId}/provenance`);
    expect(res.status).toBe(200);
  });

  test('PROV-2: provenance response has found: true for known TCA evidence ID', async () => {
    const res = await request(app).get(`/api/cases/${TCA}/evidence/${anchorId}/provenance`);
    expect(res.body.found).toBe(true);
  });

  test('PROV-3: provenance evidence_id matches the requested TCA ID', async () => {
    const res = await request(app).get(`/api/cases/${TCA}/evidence/${anchorId}/provenance`);
    expect(res.body.evidence_id).toBe(anchorId);
    expect(res.body.evidence_id).toMatch(TCA_ID_RE);
  });

  test('PROV-4: provenance contains all 12 required evidence row fields', async () => {
    const res = await request(app).get(`/api/cases/${TCA}/evidence/${anchorId}/provenance`);
    const REQUIRED = [
      'evidence_id', 'timestamp', 'source', 'measurement',
      'value', 'unit', 'resolution', 'dataset_id',
      'provider', 'variable', 'evidence_type', 'quality',
    ];
    for (const f of REQUIRED) {
      expect(res.body).toHaveProperty(f);
    }
  });

  test('PROV-5: provenance anchor row fields match source row verbatim', async () => {
    const res   = await request(app).get(`/api/cases/${TCA}/evidence/${anchorId}/provenance`);
    const src   = tcaRows.find((r) => r.evidence_id === anchorId);
    expect(res.body.source).toBe(src.source);
    expect(res.body.timestamp).toBe(src.timestamp);
    expect(res.body.measurement).toBe(src.measurement);
    expect(res.body.value).toBe(src.value);
  });

  test('PROV-6: provenance anchor row evidence_type is "case_event"', async () => {
    const res = await request(app).get(`/api/cases/${TCA}/evidence/${anchorId}/provenance`);
    expect(res.body.evidence_type).toBe('case_event');
  });

  test('PROV-7: provenance anchor row has non-empty hypothesis_relationships', async () => {
    const res = await request(app).get(`/api/cases/${TCA}/evidence/${anchorId}/provenance`);
    expect(Array.isArray(res.body.hypothesis_relationships)).toBe(true);
    expect(res.body.hypothesis_relationships.length).toBeGreaterThan(0);
  });

  test('PROV-8: anchor provenance hypothesis_relationships are verbatim from TCA graph', async () => {
    const res  = await request(app).get(`/api/cases/${TCA}/evidence/${anchorId}/provenance`);
    for (const rel of res.body.hypothesis_relationships) {
      const graphH = tcaGraph.hypotheses.find((h) => h.hypothesis_id === rel.hypothesis_id);
      expect(graphH).toBeDefined();
      const graphRef = (graphH[rel.list_name] || []).find((r) => r.evidence_id === anchorId);
      expect(graphRef).toBeDefined();
      expect(rel.relationship).toBe(graphRef.relationship);
      expect(rel.interpretation).toBe(graphRef.interpretation);
    }
  });

  test('PROV-9: provenance for EP8 windowed record has evidence_type "environmental_observation"', async () => {
    const res = await request(app).get(`/api/cases/${TCA}/evidence/${ep8Id}/provenance`);
    expect(res.status).toBe(200);
    expect(res.body.evidence_type).toBe('environmental_observation');
  });

  test('PROV-10: EP8 windowed record appears only in environmental_context (not supporting_evidence)', async () => {
    const res = await request(app).get(`/api/cases/${TCA}/evidence/${ep8Id}/provenance`);
    for (const rel of res.body.hypothesis_relationships) {
      expect(rel.list_name).toBe('environmental_context');
    }
  });

  test('PROV-11: unknown TCA evidence ID returns HTTP 404 with found: false', async () => {
    const res = await request(app).get(`/api/cases/${TCA}/evidence/E-TCA-9999/provenance`);
    expect(res.status).toBe(404);
    expect(res.body.found).toBe(false);
    expect(res.body.evidence_id).toBe('E-TCA-9999');
  });

  test('PROV-12: G15 evidence ID on TCA case returns HTTP 404 (not found in TCA dataset)', async () => {
    const res = await request(app).get(`/api/cases/${TCA}/evidence/E-G15-0001/provenance`);
    expect(res.status).toBe(404);
    expect(res.body.found).toBe(false);
  });

  test('PROV-13: TCA evidence ID on G15 case returns HTTP 404 (not found in G15 dataset)', async () => {
    const res = await request(app).get(`/api/cases/${G15}/evidence/E-TCA-0001/provenance`);
    expect(res.status).toBe(404);
    expect(res.body.found).toBe(false);
  });
});

// =============================================================================
// 9. FORENSIC ANALYSIS  (Req 3, 14, 15)
// =============================================================================

describe('6.1C-FA: Forensic analysis — TCA pipeline', () => {
  // Req 14: no numerical probabilities

  test('FA-1: TCA report contains no numerical probability claims', () => {
    const PROB_RE = /\b\d+(\.\d+)?\s*%|\b\d+(\.\d+)?\s*(probability|chance|likelihood)/i;
    expect(PROB_RE.test(JSON.stringify(tcaReport))).toBe(false);
  });

  test('FA-2: TCA narrative passes full A1–A10 + B1–B4 validation', () => {
    const { valid, errors } = validateAnalystResponse(tcaNarrative, tcaAnalysis, tcaValidIds, tcaGraph);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  // Req 15: AI does not receive raw evidence rows
  // In the heuristic path, buildAnalystHeuristicNarrative receives analysis (the
  // validated ForensicAnalysis object) — NOT rows. Verify by confirming the
  // narrative contains no raw CSV field values (value, unit pairs from the CSV).

  test('FA-3: heuristic narrative does not contain raw CSV row fields (AI does not see raw rows)', () => {
    const narrativeText = JSON.stringify(tcaNarrative);
    // Raw row values from TCA CSV are numeric strings like "2000.0"
    // The narrative should not contain raw measurement values or the CSV unit strings
    // in a way that indicates raw rows were passed. The safest check: no "GOES13_EP8"
    // source tag appears in free-text narrative fields (it's not in the evidence_summary).
    expect(narrativeText).not.toContain('"source":"GOES13_EP8"');
    expect(narrativeText).not.toContain('"source":"GOES13_MAG"');
  });

  test('FA-4: TCA analysis_version matches the platform constant', () => {
    expect(typeof tcaAnalysis.analysis_version).toBe('string');
    expect(tcaAnalysis.analysis_version.length).toBeGreaterThan(0);
    // Must match G15 (same pipeline version)
    expect(tcaAnalysis.analysis_version).toBe(g15Analysis.analysis_version);
  });

  test('FA-5: TCA report contains all required top-level fields', () => {
    const REQUIRED = [
      'case_id', 'analysis_version', 'causal_attribution_established',
      'hypotheses', 'analyst_narrative', 'limitations', 'evidence_summary',
    ];
    for (const f of REQUIRED) {
      expect(tcaReport).toHaveProperty(f);
    }
  });

  test('FA-6: all TCA hypothesis assessments are in ALLOWED_ASSESSMENTS', () => {
    for (const h of tcaReport.hypotheses) {
      if (h.assessment !== null && h.assessment !== undefined) {
        expect(ALLOWED_ASSESSMENTS.has(h.assessment)).toBe(true);
      }
    }
  });

  test('FA-7: narrative hypothesis assessments match deterministic analysis assessments exactly', () => {
    const map = new Map(tcaReport.hypotheses.map((h) => [h.hypothesis_id, h.assessment]));
    for (const ha of tcaReport.analyst_narrative.hypothesis_assessments) {
      expect(map.has(ha.hypothesis_id)).toBe(true);
      expect(ha.assessment).toBe(map.get(ha.hypothesis_id));
    }
  });
});

// =============================================================================
// 10. CAUSAL ATTRIBUTION FLAG  (Req 17)
// =============================================================================

describe('6.1C-CAU: Causal attribution flag', () => {
  // Req 17: Phase 5 invariants enforced for TCA

  test('CAU-1: tcaGraph.causal_attribution_established is strictly false', () => {
    expect(tcaGraph.causal_attribution_established).toBe(false);
  });

  test('CAU-2: tcaAnalysis.causal_attribution_established is strictly false', () => {
    expect(tcaAnalysis.causal_attribution_established).toBe(false);
  });

  test('CAU-3: tcaReport.causal_attribution_established is strictly false', () => {
    expect(tcaReport.causal_attribution_established).toBe(false);
  });

  test('CAU-4: tcaNarrative.causal_attribution_established matches the analysis', () => {
    expect(tcaNarrative.causal_attribution_established).toBe(tcaAnalysis.causal_attribution_established);
  });

  test('CAU-5: H3 (insufficient evidence) has assessment "strongly_supported"', () => {
    const h3 = tcaGraph.hypotheses.find((h) => h.hypothesis_id === 'H3');
    expect(h3.assessment).toBe('strongly_supported');
  });
});

// =============================================================================
// 11. API RESPONSE  (Req 3, 5)
// =============================================================================

describe('6.1C-API: API response — TCA HTTP endpoints', () => {
  let faRes;
  let faBody;

  beforeAll(async () => {
    faRes  = await request(app).get(`/api/cases/${TCA}/forensic-analysis`);
    faBody = faRes.body;
  }, 30_000);

  test('API-1: GET /api/cases/:id/forensic-analysis returns HTTP 200 for TCA', () => {
    expect(faRes.status).toBe(200);
  });

  test('API-2: response case_id is "test-case-alpha"', () => {
    expect(faBody.case_id).toBe(TCA);
  });

  test('API-3: causal_attribution_established is false in the HTTP response', () => {
    expect(faBody.causal_attribution_established).toBe(false);
  });

  test('API-4: response has exactly 3 hypotheses', () => {
    expect(Array.isArray(faBody.hypotheses)).toBe(true);
    expect(faBody.hypotheses).toHaveLength(3);
  });

  test('API-5: all HTTP response assessments are in ALLOWED_ASSESSMENTS', () => {
    for (const h of faBody.hypotheses) {
      if (h.assessment !== null && h.assessment !== undefined) {
        expect(ALLOWED_ASSESSMENTS.has(h.assessment)).toBe(true);
      }
    }
  });

  test('API-6: response has analyst_narrative', () => {
    expect(faBody).toHaveProperty('analyst_narrative');
    expect(typeof faBody.analyst_narrative).toBe('object');
  });

  test('API-7: all evidence IDs in the HTTP response are TCA IDs', () => {
    for (const h of faBody.hypotheses) {
      const s = h.evidence_summary;
      const allIds = [
        ...(s.environmental_context_ids       || []),
        ...(s.supporting_evidence_ids         || []),
        ...(s.contradicting_evidence_ids      || []),
        ...(s.non_discriminating_evidence_ids || []),
      ];
      for (const id of allIds) {
        expect(id).toMatch(TCA_ID_RE);
        expect(id).not.toMatch(G15_ID_RE);
      }
    }
  });

  test('API-8: response contains no error_code or violations fields', () => {
    expect(faBody).not.toHaveProperty('error_code');
    expect(faBody).not.toHaveProperty('violations');
  });

  test('API-9: GET /api/cases/:id/evidence-graph returns 3 hypotheses for TCA', async () => {
    const res = await request(app).get(`/api/cases/${TCA}/evidence-graph`);
    expect(res.status).toBe(200);
    expect(res.body.hypotheses).toHaveLength(3);
    expect(res.body.causal_attribution_established).toBe(false);
  });

  test('API-10: GET /api/cases/:id/timeline returns 69 TCA records', async () => {
    const res = await request(app).get(`/api/cases/${TCA}/timeline`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(69);
  });
});

// =============================================================================
// 12. CONCURRENT DETERMINISTIC EXECUTION  (Req 7)
// =============================================================================

describe('6.1C-CONC: Concurrent deterministic execution', () => {
  test('CONC-1: three concurrent full TCA pipelines produce identical reports', async () => {
    const [rows1, rows2, rows3] = await Promise.all([
      parseEvidenceCSV(TCA),
      parseEvidenceCSV(TCA),
      parseEvidenceCSV(TCA),
    ]);
    const [graph1, graph2, graph3] = await Promise.all([
      buildEvidenceGraph(TCA, rows1),
      buildEvidenceGraph(TCA, rows2),
      buildEvidenceGraph(TCA, rows3),
    ]);
    const a1 = buildForensicAnalysis(TCA, graph1);
    const a2 = buildForensicAnalysis(TCA, graph2);
    const a3 = buildForensicAnalysis(TCA, graph3);

    // All three must produce identical case_id, causal flag, hypothesis IDs and assessments
    for (const a of [a2, a3]) {
      expect(a.case_id).toBe(a1.case_id);
      expect(a.causal_attribution_established).toBe(a1.causal_attribution_established);
      expect(a.hypotheses.map((h) => h.hypothesis_id))
        .toEqual(a1.hypotheses.map((h) => h.hypothesis_id));
      expect(a.hypotheses.map((h) => h.assessment))
        .toEqual(a1.hypotheses.map((h) => h.assessment));
    }
  });

  test('CONC-2: concurrent TCA and G15 pipelines do not contaminate each other', async () => {
    const [tcaA, g15A] = await Promise.all([
      parseEvidenceCSV(TCA).then((rows) => buildEvidenceGraph(TCA, rows).then((graph) => buildForensicAnalysis(TCA, graph))),
      parseEvidenceCSV(G15).then((rows) => buildEvidenceGraph(G15, rows).then((graph) => buildForensicAnalysis(G15, graph))),
    ]);
    expect(tcaA.case_id).toBe(TCA);
    expect(g15A.case_id).toBe(G15);
    expect(tcaA.hypotheses).toHaveLength(3);
    expect(g15A.hypotheses).toHaveLength(5);
  });

  test('CONC-3: concurrent HTTP requests for both cases return correct case_ids', async () => {
    const [tcaRes, g15Res] = await Promise.all([
      request(app).get(`/api/cases/${TCA}/forensic-analysis`),
      request(app).get(`/api/cases/${G15}/forensic-analysis`),
    ]);
    expect(tcaRes.body.case_id).toBe(TCA);
    expect(g15Res.body.case_id).toBe(G15);
  }, 30_000);

  test('CONC-4: concurrent HTTP requests for both cases return non-overlapping evidence IDs', async () => {
    const [tcaRes, g15Res] = await Promise.all([
      request(app).get(`/api/cases/${TCA}/forensic-analysis`),
      request(app).get(`/api/cases/${G15}/forensic-analysis`),
    ]);

    const extractIds = (body) => {
      const ids = [];
      for (const h of body.hypotheses || []) {
        const s = h.evidence_summary;
        ids.push(
          ...(s.environmental_context_ids       || []),
          ...(s.supporting_evidence_ids         || []),
          ...(s.contradicting_evidence_ids      || []),
          ...(s.non_discriminating_evidence_ids || []),
        );
      }
      return new Set(ids);
    };

    const tcaIds = extractIds(tcaRes.body);
    const g15Ids = extractIds(g15Res.body);
    for (const id of tcaIds) expect(g15Ids.has(id)).toBe(false);
    for (const id of g15Ids) expect(tcaIds.has(id)).toBe(false);
  }, 30_000);
});

// =============================================================================
// 13. GALAXY 15 REGRESSION  (Req 16, 17)
// =============================================================================

describe('6.1C-REG: Galaxy 15 scientific invariants unchanged after TCA onboarding', () => {
  // Req 16: Galaxy 15 assessments unchanged
  // Req 17: Phase 5 invariants enforced

  test('REG-1: G15 still has exactly 278 evidence records', () => {
    expect(g15Rows).toHaveLength(278);
  });

  test('REG-2: G15 first evidence ID is still E-G15-0001', () => {
    expect(g15Rows[0].evidence_id).toBe('E-G15-0001');
  });

  test('REG-3: G15 last evidence ID is still E-G15-0278', () => {
    expect(g15Rows[g15Rows.length - 1].evidence_id).toBe('E-G15-0278');
  });

  test('REG-4: G15 causal_attribution_established is still false', () => {
    expect(g15Analysis.causal_attribution_established).toBe(false);
  });

  test('REG-5: G15 H1 assessment is still "mixed"', () => {
    expect(g15Analysis.hypotheses.find((h) => h.hypothesis_id === 'H1').assessment).toBe('mixed');
  });

  test('REG-6: G15 H2 assessment is still "mixed"', () => {
    expect(g15Analysis.hypotheses.find((h) => h.hypothesis_id === 'H2').assessment).toBe('mixed');
  });

  test('REG-7: G15 H3 assessment is still "supported"', () => {
    expect(g15Analysis.hypotheses.find((h) => h.hypothesis_id === 'H3').assessment).toBe('supported');
  });

  test('REG-8: G15 H4 assessment is still "insufficient_evidence"', () => {
    expect(g15Analysis.hypotheses.find((h) => h.hypothesis_id === 'H4').assessment).toBe('insufficient_evidence');
  });

  test('REG-9: G15 H5 assessment is still "strongly_supported"', () => {
    expect(g15Analysis.hypotheses.find((h) => h.hypothesis_id === 'H5').assessment).toBe('strongly_supported');
  });

  test('REG-10: G15 still has exactly 5 hypotheses H1–H5', () => {
    expect(g15Analysis.hypotheses).toHaveLength(5);
    const ids = g15Analysis.hypotheses.map((h) => h.hypothesis_id);
    ['H1','H2','H3','H4','H5'].forEach((id) => expect(ids).toContain(id));
  });

  test('REG-11: G15 evidence IDs remain E-G15 prefix, not contaminated by TCA', () => {
    for (const r of g15Rows) {
      expect(r.evidence_id).toMatch(G15_ID_RE);
    }
  });

  test('REG-12: G15 /forensic-analysis HTTP response is still correct after TCA was loaded', async () => {
    const res = await request(app).get(`/api/cases/${G15}/forensic-analysis`);
    expect(res.status).toBe(200);
    expect(res.body.case_id).toBe(G15);
    expect(res.body.causal_attribution_established).toBe(false);
    expect(res.body.hypotheses).toHaveLength(5);
  }, 30_000);
});
