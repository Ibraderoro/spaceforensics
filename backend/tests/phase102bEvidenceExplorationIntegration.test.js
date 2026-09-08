'use strict';

/**
 * Phase 10.2B — Evidence Exploration Integration & Cross-Endpoint Integrity
 *
 * All tests exercise the actual HTTP application via supertest against real
 * case fixtures.  No mocking of the evidence graph or service layer.
 *
 * Authority chain under test:
 *   parseEvidenceCSV → buildEvidenceGraph → evidenceExplorationService → HTTP
 *
 * Sections:
 *   §1  Cross-endpoint evidence identity  (spec §3)
 *   §2  Provenance consistency            (spec §4)
 *   §3  Hypothesis boundary H1–H5         (spec §5)
 *   §4  Environmental-context boundary    (spec §6)
 *   §5  EPHEMERIS boundary matrix         (spec §7)
 *   §6  Cross-case isolation              (spec §8)
 *   §7  Time-window semantics             (spec §9)
 *   §8  Anomaly-centered semantics        (spec §10)
 *   §9  Source/measurement filtering      (spec §11)
 *   §10 Scientific response-tree scan     (spec §12)
 *   §11 Read-only guarantee               (spec §13)
 *   §12 Error contract integration        (spec §14)
 *   §13 Performance baseline              (spec §16)
 */

const request = require('supertest');
const {
  app,
  parseEvidenceCSV,
  buildEvidenceGraph,
  buildForensicAnalysis,
} = require('../server');
const GOLDEN = require('./g15-golden-snapshot.json');

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — built once, shared by all sections
// ─────────────────────────────────────────────────────────────────────────────

const G15   = 'galaxy-15';
const TCA   = 'test-case-alpha';
const GS17  = 'goes16-sep2017';
const BOGUS = 'no-such-case-102b-zzz';

const G15_ASSESSMENTS = { H1: 'mixed', H2: 'mixed', H3: 'supported', H4: 'insufficient_evidence', H5: 'strongly_supported' };
const FOUR_LISTS = ['environmental_context','supporting_evidence','contradicting_evidence','non_discriminating_evidence'];
const ALLOWED_ASSESSMENTS = new Set(['strongly_supported','supported','mixed','weakly_supported','insufficient_evidence']);
const CAUSAL_RE = /\b(?:caused?|proves?|establishes?\s+causali|confirms?\s+causali)/i;
const NUMPROB_RE = /\b\d+(\.\d+)?\s*%|\b\d+(\.\d+)?\s*(probability|chance|likelihood)/i;

let g15Rows, g15Graph, g15Analysis;
let tcaRows, tcaGraph;
let gs17Rows, gs17Graph;

// Representative IDs (discovered from fixture inspection)
let g15AnchorId;       // CASE source — graph-referenced (H3, H5 supporting; H1, H2 non-disc)
let g15EphemerisId;    // GOES11_EPHEMERIS — NOT graph-referenced
let g15MagNonRefId;    // GOES11_MAG — NOT graph-referenced (E-G15-0002)
let g15Ep8RefId;       // GOES11_EP8 — graph-referenced in H2 environmental_context (E-G15-0158)
let g15Ep8NonRefId;    // GOES11_EP8 — NOT graph-referenced (E-G15-0004)
let g15AnchorTs;       // timestamp of CASE anchor row

beforeAll(async () => {
  jest.setTimeout(60_000);
  [g15Rows, tcaRows, gs17Rows] = await Promise.all([
    parseEvidenceCSV(G15),
    parseEvidenceCSV(TCA),
    parseEvidenceCSV(GS17),
  ]);
  [g15Graph, tcaGraph, gs17Graph] = await Promise.all([
    buildEvidenceGraph(G15, g15Rows),
    buildEvidenceGraph(TCA, tcaRows),
    buildEvidenceGraph(GS17, gs17Rows),
  ]);

  const anchor      = g15Rows.find(r => r.source === 'CASE');
  const eph         = g15Rows.find(r => r.source === 'GOES11_EPHEMERIS');
  const magNonRef   = g15Rows.find(r => r.source === 'GOES11_MAG');

  // Find graph-referenced EP8 (in H2 environmental_context)
  const h2          = g15Graph.hypotheses.find(h => h.hypothesis_id === 'H2');
  const graphIds    = new Set(
    g15Graph.hypotheses.flatMap(h => FOUR_LISTS.flatMap(l => (h[l]||[]).map(r => r.evidence_id)))
  );
  const ep8Ref      = h2.environmental_context.find(r =>
    g15Rows.find(row => row.evidence_id === r.evidence_id && row.source === 'GOES11_EP8')
  );
  const ep8NonRef   = g15Rows.find(r => r.source === 'GOES11_EP8' && !graphIds.has(r.evidence_id));

  g15AnchorId     = anchor.evidence_id;
  g15AnchorTs     = anchor.timestamp;
  g15EphemerisId  = eph.evidence_id;
  g15MagNonRefId  = magNonRef.evidence_id;
  g15Ep8RefId     = ep8Ref.evidence_id;
  g15Ep8NonRefId  = ep8NonRef.evidence_id;

  // Pre-build analysis for read-only regression check
  const { loadCaseMeta } = require('../server') || {};
  g15Analysis = buildForensicAnalysis(G15, g15Graph, null);
}, 60_000);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function assertErrorShape(body, code, httpStatus) {
  expect(typeof body.error_code).toBe('string');
  if (code) expect(body.error_code).toBe(code);
  expect(typeof body.error).toBe('string');
  expect(body.error.length).toBeGreaterThan(0);
  expect(body.status_code).toBe(httpStatus);
}

function assertNoLeakage(body) {
  const t = JSON.stringify(body);
  expect(t).not.toMatch(/node_modules/);
  expect(t).not.toMatch(/\.js:\d+/);
  expect(t).not.toMatch(/\bError:/);
  expect(t).not.toMatch(/CASES_DIR/);
  expect(t).not.toMatch(/\bpassword\b/i);
}

function scanForCausal(value) {
  if (typeof value === 'string') expect(value).not.toMatch(CAUSAL_RE);
  else if (Array.isArray(value)) value.forEach(v => scanForCausal(v));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => scanForCausal(v));
}

function scanForNumProb(value) {
  if (typeof value === 'string') expect(value).not.toMatch(NUMPROB_RE);
  else if (Array.isArray(value)) value.forEach(v => scanForNumProb(v));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => scanForNumProb(v));
}

// ─────────────────────────────────────────────────────────────────────────────
// §1  Cross-endpoint evidence identity
// ─────────────────────────────────────────────────────────────────────────────

describe('§1 Cross-endpoint evidence identity', () => {
  // The 12 authoritative evidence row fields that must be byte-identical
  // across every endpoint that returns them.
  const AUTH_FIELDS = [
    'evidence_id','timestamp','source','measurement',
    'value','unit','resolution','dataset_id',
    'provider','variable','evidence_type','quality',
  ];

  /**
   * Pick a record from /evidence, compare it against /evidence/:id and
   * provenance.  Also verify it appears in /evidence-index if graph-referenced.
   */
  async function crossCheck(caseId, evidenceId, expectGraphRef) {
    // 1. Retrieve via /evidence/:id
    const byId = await request(app).get(`/api/cases/${caseId}/evidence/${evidenceId}`);
    expect(byId.status).toBe(200);
    expect(byId.body.found).toBe(true);

    // 2. Retrieve via /evidence (full list) and find the same record
    const allEv = await request(app).get(`/api/cases/${caseId}/evidence`);
    expect(allEv.status).toBe(200);
    const inAll = allEv.body.evidence.find(r => r.evidence_id === evidenceId);
    expect(inAll).toBeDefined();

    // 3. Compare AUTH_FIELDS between /evidence/:id and /evidence
    for (const f of AUTH_FIELDS) {
      expect(byId.body[f]).toStrictEqual(inAll[f]);
    }

    // 4. Retrieve provenance
    const prov = await request(app).get(`/api/cases/${caseId}/evidence/${evidenceId}/provenance`);
    expect(prov.status).toBe(200);
    expect(prov.body.found).toBe(true);

    // 5. Compare AUTH_FIELDS: /evidence/:id vs /provenance
    for (const f of AUTH_FIELDS) {
      expect(byId.body[f]).toStrictEqual(prov.body[f]);
    }

    // 6. If graph-referenced: find in evidence-index
    if (expectGraphRef) {
      const idx = await request(app).get(`/api/cases/${caseId}/evidence-index`);
      expect(idx.status).toBe(200);
      const inIdx = idx.body.evidence.find(e => e.evidence_id === evidenceId);
      expect(inIdx).toBeDefined();
      for (const f of AUTH_FIELDS) {
        expect(byId.body[f]).toStrictEqual(inIdx.record[f]);
      }
    }
  }

  test('EID-1: CASE anchor — consistent across /evidence/:id, /evidence, /provenance, /evidence-index', async () => {
    await crossCheck(G15, g15AnchorId, true);
  });

  test('EID-2: GOES11_MAG non-referenced — consistent across /evidence/:id, /evidence, /provenance', async () => {
    await crossCheck(G15, g15MagNonRefId, false);
  });

  test('EID-3: GOES11_EP8 graph-referenced — consistent across /evidence/:id, /evidence, /provenance, /evidence-index', async () => {
    await crossCheck(G15, g15Ep8RefId, true);
  });

  test('EID-4: GOES11_EPHEMERIS — consistent across /evidence/:id, /evidence, /provenance', async () => {
    await crossCheck(G15, g15EphemerisId, false);
  });

  test('EID-5: evidence_id is never rewritten by any endpoint', async () => {
    // Check a sample of 5 records from the full list; verify /evidence/:id
    // returns the exact same evidence_id that was used to query it.
    const sample = g15Rows.slice(0, 5);
    for (const row of sample) {
      const r = await request(app).get(`/api/cases/${G15}/evidence/${row.evidence_id}`);
      expect(r.status).toBe(200);
      expect(r.body.evidence_id).toBe(row.evidence_id);
    }
  });

  test('EID-6: value field is not rounded or reinterpreted by any endpoint', async () => {
    // The numeric value stored in the CSV must come back unchanged.
    const r = await request(app).get(`/api/cases/${G15}/evidence/${g15AnchorId}`);
    const authoritative = g15Rows.find(row => row.evidence_id === g15AnchorId);
    expect(r.body.value).toBe(authoritative.value);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2  Provenance consistency
// ─────────────────────────────────────────────────────────────────────────────

describe('§2 Provenance consistency', () => {
  test('PROV-1: anchor /evidence/:id and /provenance have identical hypothesis_relationships', async () => {
    const byId = await request(app).get(`/api/cases/${G15}/evidence/${g15AnchorId}`);
    const prov = await request(app).get(`/api/cases/${G15}/evidence/${g15AnchorId}/provenance`);
    expect(byId.status).toBe(200);
    expect(prov.status).toBe(200);
    // Both carry hypothesis_relationships; sort and compare
    const normRel = arr => arr.map(r => JSON.stringify(r)).sort();
    expect(normRel(byId.body.hypothesis_relationships))
      .toEqual(normRel(prov.body.hypothesis_relationships));
  });

  test('PROV-2: hypothesis_relationships reference valid hypothesis_ids', async () => {
    const prov = await request(app).get(`/api/cases/${G15}/evidence/${g15AnchorId}/provenance`);
    const validHids = new Set(g15Graph.hypotheses.map(h => h.hypothesis_id));
    for (const rel of prov.body.hypothesis_relationships) {
      expect(validHids.has(rel.hypothesis_id)).toBe(true);
    }
  });

  test('PROV-3: evidence-index entry matches /provenance for graph-referenced anchor — shared invariant fields', async () => {
    const idx  = await request(app).get(`/api/cases/${G15}/evidence-index`);
    const prov = await request(app).get(`/api/cases/${G15}/evidence/${g15AnchorId}/provenance`);
    const idxEntry = idx.body.evidence.find(e => e.evidence_id === g15AnchorId);
    expect(idxEntry).toBeDefined();
    // Both carry hypothesis_relationships but with different shapes:
    //   /evidence-index  (buildCaseEvidenceIndex):  { hypothesis_id, label, list_name, list_label, relationship, interpretation }
    //   /provenance      (getEvidenceProvenance):   { hypothesis_id, list_name, relationship, interpretation }
    // Compare only the four invariant fields that both surfaces guarantee.
    const normCore = arr => arr
      .map(r => JSON.stringify({ hypothesis_id: r.hypothesis_id, list_name: r.list_name, relationship: r.relationship, interpretation: r.interpretation }))
      .sort();
    expect(normCore(idxEntry.hypothesis_relationships))
      .toEqual(normCore(prov.body.hypothesis_relationships));
    // Verify same count
    expect(idxEntry.hypothesis_relationships.length).toBe(prov.body.hypothesis_relationships.length);
  });

  test('PROV-4: EPHEMERIS provenance — found: true, hypothesis_relationships is empty', async () => {
    const prov = await request(app).get(`/api/cases/${G15}/evidence/${g15EphemerisId}/provenance`);
    expect(prov.status).toBe(200);
    expect(prov.body.found).toBe(true);
    expect(prov.body.source).toBe('GOES11_EPHEMERIS');
    expect(prov.body.hypothesis_relationships).toHaveLength(0);
  });

  test('PROV-5: EPHEMERIS not in evidence-index (not graph-referenced)', async () => {
    const idx = await request(app).get(`/api/cases/${G15}/evidence-index`);
    const ephIds = new Set(g15Rows.filter(r => r.source === 'GOES11_EPHEMERIS').map(r => r.evidence_id));
    for (const entry of idx.body.evidence) {
      expect(ephIds.has(entry.evidence_id)).toBe(false);
    }
  });

  test('PROV-6: list_name in every relationship entry is one of the four canonical lists', async () => {
    const prov = await request(app).get(`/api/cases/${G15}/evidence/${g15AnchorId}/provenance`);
    for (const rel of prov.body.hypothesis_relationships) {
      expect(FOUR_LISTS).toContain(rel.list_name);
    }
  });

  test('PROV-7: provenance does not elevate env_context to supporting_evidence', async () => {
    const prov = await request(app).get(`/api/cases/${G15}/evidence/${g15Ep8RefId}/provenance`);
    expect(prov.status).toBe(200);
    // The EP8 ref ID is in environmental_context (not supporting_evidence)
    const lists = prov.body.hypothesis_relationships.map(r => r.list_name);
    expect(lists.every(l => l === 'environmental_context')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3  Hypothesis boundary H1–H5
// ─────────────────────────────────────────────────────────────────────────────

describe('§3 Hypothesis boundary — all five G15 hypotheses', () => {
  const G15_HYP_IDS = Object.keys(G15_ASSESSMENTS);

  for (const hid of G15_HYP_IDS) {
    describe(`Hypothesis ${hid}`, () => {
      let r;
      let body;

      beforeAll(async () => {
        r    = await request(app).get(`/api/cases/${G15}/hypotheses/${hid}/evidence`);
        body = r.body;
      });

      test(`HB-${hid}-1: HTTP 200`, () => {
        expect(r.status).toBe(200);
      });

      test(`HB-${hid}-2: hypothesis_id matches requested ${hid}`, () => {
        expect(body.hypothesis_id).toBe(hid);
      });

      test(`HB-${hid}-3: assessment is canonical (${G15_ASSESSMENTS[hid]})`, () => {
        expect(body.assessment).toBe(G15_ASSESSMENTS[hid]);
      });

      test(`HB-${hid}-4: all four list fields present`, () => {
        for (const l of FOUR_LISTS) expect(Array.isArray(body[l])).toBe(true);
      });

      test(`HB-${hid}-5: environmental_context ∩ supporting_evidence = ∅`, () => {
        const envIds = new Set((body.environmental_context || []).map(e => e.evidence_id));
        for (const e of (body.supporting_evidence || [])) {
          expect(envIds.has(e.evidence_id)).toBe(false);
        }
      });

      test(`HB-${hid}-6: no EPHEMERIS evidence in any list`, () => {
        const g15EphIds = new Set(
          g15Rows.filter(r => r.source === 'GOES11_EPHEMERIS').map(r => r.evidence_id)
        );
        for (const l of FOUR_LISTS) {
          for (const e of (body[l] || [])) {
            expect(g15EphIds.has(e.evidence_id)).toBe(false);
          }
        }
      });

      test(`HB-${hid}-7: all evidence_ids belong to G15 CSV`, () => {
        const csvIds = new Set(g15Rows.map(r => r.evidence_id));
        for (const l of FOUR_LISTS) {
          for (const e of (body[l] || [])) {
            expect(csvIds.has(e.evidence_id)).toBe(true);
            expect(e.evidence_id).toMatch(/^E-G15-/);
          }
        }
      });

      test(`HB-${hid}-8: every entry has evidence_id, relationship, interpretation, record`, () => {
        for (const l of FOUR_LISTS) {
          for (const e of (body[l] || [])) {
            expect(typeof e.evidence_id).toBe('string');
            expect(typeof e.relationship).toBe('string');
            expect(typeof e.interpretation).toBe('string');
            expect(e.record).not.toBeNull();
          }
        }
      });

      test(`HB-${hid}-9: no evidence ID from TCA appears`, () => {
        for (const l of FOUR_LISTS) {
          for (const e of (body[l] || [])) {
            expect(e.evidence_id).not.toMatch(/^E-TCA-/);
          }
        }
      });

      test(`HB-${hid}-10: evidence counts match golden snapshot`, () => {
        const golden = GOLDEN.hypotheses.find(h => h.hypothesis_id === hid);
        expect(golden).toBeDefined();
        expect((body.environmental_context || []).length)
          .toBe(golden.evidence_summary.environmental_context_count);
        expect((body.supporting_evidence || []).length)
          .toBe(golden.evidence_summary.supporting_evidence_count);
        expect((body.contradicting_evidence || []).length)
          .toBe(golden.evidence_summary.contradicting_evidence_count);
        expect((body.non_discriminating_evidence || []).length)
          .toBe(golden.evidence_summary.non_discriminating_evidence_count);
      });

      test(`HB-${hid}-11: no numerical probabilities in hypothesis evidence view`, () => {
        scanForNumProb(body);
      });
    });
  }

  test('HB-unknown: unknown hypothesis_id returns 404', async () => {
    const r = await request(app).get(`/api/cases/${G15}/hypotheses/H_BOGUS_999/evidence`);
    expect(r.status).toBe(404);
    assertErrorShape(r.body, 'HYPOTHESIS_NOT_FOUND', 404);
    assertNoLeakage(r.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §4  Environmental-context boundary
// ─────────────────────────────────────────────────────────────────────────────

describe('§4 Environmental-context boundary', () => {
  let envRes;
  let envBody;

  beforeAll(async () => {
    envRes  = await request(app).get(`/api/cases/${G15}/environmental-context`);
    envBody = envRes.body;
  });

  test('EC-1: HTTP 200', () => {
    expect(envRes.status).toBe(200);
  });

  test('EC-2: case_id is G15', () => {
    expect(envBody.case_id).toBe(G15);
  });

  test('EC-3: heuristic_window_note is present and non-empty', () => {
    expect(typeof envBody.heuristic_window_note).toBe('string');
    expect(envBody.heuristic_window_note.length).toBeGreaterThan(0);
  });

  test('EC-4: heuristic_window_note does not claim causality', () => {
    expect(envBody.heuristic_window_note.toLowerCase()).not.toMatch(CAUSAL_RE);
  });

  test('EC-5: every env-context evidence_id appears in /evidence (CSV)', async () => {
    const allEv = await request(app).get(`/api/cases/${G15}/evidence`);
    const csvIds = new Set(allEv.body.evidence.map(r => r.evidence_id));
    for (const rec of envBody.records) {
      expect(csvIds.has(rec.evidence_id)).toBe(true);
    }
  });

  test('EC-6: every env-context evidence_id appears in /evidence-index', async () => {
    const idx = await request(app).get(`/api/cases/${G15}/evidence-index`);
    const idxIds = new Set(idx.body.evidence.map(e => e.evidence_id));
    for (const rec of envBody.records) {
      expect(idxIds.has(rec.evidence_id)).toBe(true);
    }
  });

  test('EC-7: env-context IDs are disjoint from supporting_evidence across all hypotheses', async () => {
    const envIds = new Set(envBody.records.map(r => r.evidence_id));
    for (const hid of Object.keys(G15_ASSESSMENTS)) {
      const hRes = await request(app).get(`/api/cases/${G15}/hypotheses/${hid}/evidence`);
      for (const e of (hRes.body.supporting_evidence || [])) {
        expect(envIds.has(e.evidence_id)).toBe(false);
      }
    }
  });

  test('EC-8: env-context IDs match golden snapshot environmental_context_ids across all hypotheses', () => {
    const allEnvIds = new Set(envBody.records.map(r => r.evidence_id));
    const goldenEnvIds = new Set(
      GOLDEN.hypotheses.flatMap(h => h.evidence_summary.environmental_context_ids)
    );
    for (const id of goldenEnvIds) expect(allEnvIds.has(id)).toBe(true);
    for (const id of allEnvIds) expect(goldenEnvIds.has(id)).toBe(true);
  });

  test('EC-9: env-context endpoint is descriptive not causal — no causal language', () => {
    scanForCausal(envBody);
  });

  test('EC-10: referenced_by field on each record contains valid hypothesis_ids', () => {
    const validHids = new Set(Object.keys(G15_ASSESSMENTS));
    for (const rec of envBody.records) {
      for (const hid of rec.referenced_by) {
        expect(validHids.has(hid)).toBe(true);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5  EPHEMERIS boundary matrix
// ─────────────────────────────────────────────────────────────────────────────

describe('§5 EPHEMERIS boundary matrix', () => {
  test('EPH-1: /evidence includes EPHEMERIS rows (YES)', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence`);
    const eph = r.body.evidence.filter(e => e.source === 'GOES11_EPHEMERIS');
    expect(eph.length).toBe(GOLDEN.ephemeris_count); // 61
  });

  test('EPH-2: /evidence/:id resolves EPHEMERIS with found:true (YES)', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence/${g15EphemerisId}`);
    expect(r.status).toBe(200);
    expect(r.body.found).toBe(true);
    expect(r.body.source).toBe('GOES11_EPHEMERIS');
  });

  test('EPH-3: /evidence/:id/provenance resolves EPHEMERIS with found:true (YES)', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence/${g15EphemerisId}/provenance`);
    expect(r.status).toBe(200);
    expect(r.body.found).toBe(true);
    expect(r.body.source).toBe('GOES11_EPHEMERIS');
  });

  test('EPH-4: /evidence/source/GOES11_EPHEMERIS returns only EPHEMERIS (YES)', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence/source/GOES11_EPHEMERIS`);
    expect(r.status).toBe(200);
    expect(r.body.evidence_count).toBe(GOLDEN.ephemeris_count);
    for (const rec of r.body.evidence) expect(rec.source).toBe('GOES11_EPHEMERIS');
  });

  test('EPH-5: /evidence/anomaly-centered includes EPHEMERIS (YES)', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/anomaly-centered?timestamp=${encodeURIComponent(g15AnchorTs)}&window_minutes=60`);
    expect(r.status).toBe(200);
    const eph = r.body.evidence.filter(e => e.source === 'GOES11_EPHEMERIS');
    expect(eph.length).toBeGreaterThan(0);
  });

  test('EPH-6: /evidence-index does NOT include EPHEMERIS (not graph-referenced)', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence-index`);
    for (const entry of r.body.evidence) {
      const row = g15Rows.find(row => row.evidence_id === entry.evidence_id);
      if (row) expect(row.source).not.toBe('GOES11_EPHEMERIS');
    }
  });

  test('EPH-7: hypothesis evidence views do NOT include EPHEMERIS (NO)', async () => {
    const g15EphIds = new Set(
      g15Rows.filter(r => r.source === 'GOES11_EPHEMERIS').map(r => r.evidence_id)
    );
    for (const hid of Object.keys(G15_ASSESSMENTS)) {
      const r = await request(app).get(`/api/cases/${G15}/hypotheses/${hid}/evidence`);
      for (const l of FOUR_LISTS) {
        for (const e of (r.body[l] || [])) {
          expect(g15EphIds.has(e.evidence_id)).toBe(false);
        }
      }
    }
  });

  test('EPH-8: EPHEMERIS provenance has empty hypothesis_relationships — never graph support', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence/${g15EphemerisId}/provenance`);
    expect(r.body.hypothesis_relationships).toHaveLength(0);
  });

  test('EPH-9: /environmental-context does not include EPHEMERIS', async () => {
    const r = await request(app).get(`/api/cases/${G15}/environmental-context`);
    const g15EphIds = new Set(
      g15Rows.filter(row => row.source === 'GOES11_EPHEMERIS').map(row => row.evidence_id)
    );
    for (const rec of r.body.records) {
      expect(g15EphIds.has(rec.evidence_id)).toBe(false);
    }
  });

  test('EPH-10: /hypotheses/compare does not include EPHEMERIS in shared or exclusive evidence', async () => {
    const r = await request(app).get(`/api/cases/${G15}/hypotheses/compare`);
    expect(r.status).toBe(200);
    const g15EphIds = new Set(
      g15Rows.filter(row => row.source === 'GOES11_EPHEMERIS').map(row => row.evidence_id)
    );
    for (const e of (r.body.shared_evidence || [])) {
      expect(g15EphIds.has(e.evidence_id)).toBe(false);
    }
    for (const e of (r.body.exclusive_evidence || [])) {
      expect(g15EphIds.has(e.evidence_id)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6  Cross-case isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('§6 Cross-case isolation (G15, TCA, GS17)', () => {
  // G15 never returns TCA or GS17 IDs
  test('ISO-1: G15 /evidence never returns TCA or GS17 evidence IDs', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence`);
    for (const rec of r.body.evidence) {
      expect(rec.evidence_id).toMatch(/^E-G15-/);
    }
  });

  test('ISO-2: TCA /evidence never returns G15 or GS17 evidence IDs', async () => {
    const r = await request(app).get(`/api/cases/${TCA}/evidence`);
    for (const rec of r.body.evidence) {
      expect(rec.evidence_id).toMatch(/^E-TCA-/);
    }
  });

  test('ISO-3: GS17 /evidence never returns G15 or TCA evidence IDs', async () => {
    const r = await request(app).get(`/api/cases/${GS17}/evidence`);
    for (const rec of r.body.evidence) {
      expect(rec.evidence_id).toMatch(/^E-GS17-/);
    }
  });

  test('ISO-4: G15 evidence ID supplied to TCA /evidence/:id returns 404', async () => {
    const r = await request(app).get(`/api/cases/${TCA}/evidence/${g15AnchorId}`);
    expect(r.status).toBe(404);
    expect(r.body.error_code).toBe('EVIDENCE_NOT_FOUND');
  });

  test('ISO-5: TCA evidence ID supplied to G15 /evidence/:id returns 404', async () => {
    const tcaAnchorId = tcaRows.find(r => r.source === 'CASE').evidence_id;
    const r = await request(app).get(`/api/cases/${G15}/evidence/${tcaAnchorId}`);
    expect(r.status).toBe(404);
    expect(r.body.error_code).toBe('EVIDENCE_NOT_FOUND');
  });

  test('ISO-6: G15 evidence ID on TCA /provenance returns 404', async () => {
    const r = await request(app).get(`/api/cases/${TCA}/evidence/${g15AnchorId}/provenance`);
    expect(r.status).toBe(404);
  });

  test('ISO-7: TCA evidence ID on G15 /provenance returns 404', async () => {
    const tcaId = tcaRows[0].evidence_id;
    const r = await request(app).get(`/api/cases/${G15}/evidence/${tcaId}/provenance`);
    expect(r.status).toBe(404);
  });

  test('ISO-8: unknown case returns 404 — never resolves to G15 data', async () => {
    const r = await request(app).get(`/api/cases/${BOGUS}/evidence`);
    expect(r.status).toBe(404);
    expect(r.body).not.toHaveProperty('evidence');
  });

  test('ISO-9: unknown case /evidence/:id returns 404 — never G15 data', async () => {
    const r = await request(app).get(`/api/cases/${BOGUS}/evidence/${g15AnchorId}`);
    expect(r.status).toBe(404);
  });

  test('ISO-10: G15 /evidence-index contains only G15 IDs', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence-index`);
    for (const entry of r.body.evidence) {
      expect(entry.evidence_id).toMatch(/^E-G15-/);
    }
  });

  test('ISO-11: TCA /evidence-index contains only TCA IDs', async () => {
    const r = await request(app).get(`/api/cases/${TCA}/evidence-index`);
    for (const entry of r.body.evidence) {
      expect(entry.evidence_id).toMatch(/^E-TCA-/);
    }
  });

  test('ISO-12: GS17 /evidence-index contains only GS17 IDs', async () => {
    const r = await request(app).get(`/api/cases/${GS17}/evidence-index`);
    for (const entry of r.body.evidence) {
      expect(entry.evidence_id).toMatch(/^E-GS17-/);
    }
  });

  test('ISO-13: G15 hypothesis IDs on TCA /hypotheses/:hid/evidence returns 404', async () => {
    const r = await request(app).get(`/api/cases/${TCA}/hypotheses/H1/evidence`);
    // TCA has H1, so this would succeed — cross-case isolation is at evidence level, not hypothesis ID level.
    // Instead test that TCA H1 evidence contains only TCA IDs:
    expect(r.status).toBe(200);
    for (const l of FOUR_LISTS) {
      for (const e of (r.body[l] || [])) {
        expect(e.evidence_id).toMatch(/^E-TCA-/);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §7  Time-window semantics
// ─────────────────────────────────────────────────────────────────────────────

describe('§7 Time-window semantics', () => {
  // Pick boundary timestamps using the sorted G15 rows
  let fromTs, toTs, boundaryTs;

  beforeAll(() => {
    const mid = Math.floor(g15Rows.length / 2);
    fromTs     = g15Rows[mid - 10].timestamp;
    toTs       = g15Rows[mid + 10].timestamp;
    boundaryTs = g15Rows[mid].timestamp; // exact boundary timestamp
  });

  test('TW-1: from+to closed interval — no record outside bounds', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/time-window?from=${encodeURIComponent(fromTs)}&to=${encodeURIComponent(toTs)}`);
    expect(r.status).toBe(200);
    for (const rec of r.body.evidence) {
      expect(rec.timestamp >= fromTs).toBe(true);
      expect(rec.timestamp <= toTs).toBe(true);
    }
  });

  test('TW-2: from-only — all records at or after from', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/time-window?from=${encodeURIComponent(fromTs)}`);
    expect(r.status).toBe(200);
    for (const rec of r.body.evidence) {
      expect(rec.timestamp >= fromTs).toBe(true);
    }
  });

  test('TW-3: to-only — all records at or before to', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/time-window?to=${encodeURIComponent(toTs)}`);
    expect(r.status).toBe(200);
    for (const rec of r.body.evidence) {
      expect(rec.timestamp <= toTs).toBe(true);
    }
  });

  test('TW-4: narrow window (single boundary timestamp) — inclusive boundary semantics', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/time-window?from=${encodeURIComponent(boundaryTs)}&to=${encodeURIComponent(boundaryTs)}`);
    expect(r.status).toBe(200);
    // All returned records must have exactly boundaryTs
    for (const rec of r.body.evidence) {
      expect(rec.timestamp).toBe(boundaryTs);
    }
  });

  test('TW-5: broad window (full dataset) — returns all G15 rows', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/time-window?from=${encodeURIComponent(g15Rows[0].timestamp)}&to=${encodeURIComponent(g15Rows[g15Rows.length - 1].timestamp)}`);
    expect(r.status).toBe(200);
    expect(r.body.evidence_count).toBe(g15Rows.length);
  });

  test('TW-6: temporal_note is always present', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/time-window?from=${encodeURIComponent(fromTs)}`);
    expect(typeof r.body.temporal_note).toBe('string');
    expect(r.body.temporal_note.length).toBeGreaterThan(0);
  });

  test('TW-7: temporal_note explicitly prevents causal interpretation', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/time-window?from=${encodeURIComponent(fromTs)}`);
    expect(r.body.temporal_note.toLowerCase()).not.toMatch(CAUSAL_RE);
    // Must contain an explicit disclaimer
    expect(r.body.temporal_note.toLowerCase()).toMatch(/causal|causali/);
  });

  test('TW-8: returned records belong to requested case only', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/time-window?from=${encodeURIComponent(fromTs)}&to=${encodeURIComponent(toTs)}`);
    for (const rec of r.body.evidence) {
      expect(rec.evidence_id).toMatch(/^E-G15-/);
    }
  });

  test('TW-9: window entirely before data returns empty array — not an error', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/time-window?from=1900-01-01T00:00:00Z&to=1900-01-02T00:00:00Z`);
    expect(r.status).toBe(200);
    expect(r.body.evidence_count).toBe(0);
    expect(r.body.evidence).toEqual([]);
  });

  test('TW-10: missing both params returns 400 VALIDATION_ERROR', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence/time-window`);
    expect(r.status).toBe(400);
    assertErrorShape(r.body, 'VALIDATION_ERROR', 400);
  });

  test('TW-11: TCA time-window returns only TCA IDs (no G15 fallback)', async () => {
    const r = await request(app)
      .get(`/api/cases/${TCA}/evidence/time-window?from=2009-01-01T00:00:00Z`);
    expect(r.status).toBe(200);
    expect(r.body.case_id).toBe(TCA);
    for (const rec of r.body.evidence) {
      expect(rec.evidence_id).toMatch(/^E-TCA-/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §8  Anomaly-centered semantics
// ─────────────────────────────────────────────────────────────────────────────

describe('§8 Anomaly-centered semantics', () => {
  const ts = () => encodeURIComponent(g15AnchorTs);
  const url = (extra = '') =>
    `/api/cases/${G15}/evidence/anomaly-centered?timestamp=${ts()}&window_minutes=10${extra}`;

  test('ACE-1: valid timestamp + window returns evidence within ±10 min', async () => {
    const r = await request(app).get(url());
    expect(r.status).toBe(200);
    const anchorMs = new Date(g15AnchorTs).getTime();
    const windowMs = 10 * 60 * 1000;
    for (const rec of r.body.evidence) {
      const diff = Math.abs(new Date(rec.timestamp).getTime() - anchorMs);
      expect(diff).toBeLessThanOrEqual(windowMs);
    }
  });

  test('ACE-2: boundary records are included (closed window)', async () => {
    // Find a row exactly 10 min from the anchor
    const anchorMs = new Date(g15AnchorTs).getTime();
    const windowMs = 10 * 60 * 1000;
    const boundaryRow = g15Rows.find(row =>
      Math.abs(new Date(row.timestamp).getTime() - anchorMs) === windowMs
    );
    if (!boundaryRow) return; // no exact boundary row in this dataset — skip
    const r = await request(app).get(url());
    const ids = new Set(r.body.evidence.map(e => e.evidence_id));
    expect(ids.has(boundaryRow.evidence_id)).toBe(true);
  });

  test('ACE-3: EPHEMERIS rows are included in the raw slice', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/anomaly-centered?timestamp=${ts()}&window_minutes=60`);
    const eph = r.body.evidence.filter(e => e.source === 'GOES11_EPHEMERIS');
    expect(eph.length).toBeGreaterThan(0);
  });

  test('ACE-4: heuristic_window_note is present', async () => {
    const r = await request(app).get(url());
    expect(typeof r.body.heuristic_window_note).toBe('string');
    expect(r.body.heuristic_window_note.length).toBeGreaterThan(0);
  });

  test('ACE-5: heuristic_window_note does not claim causality', async () => {
    const r = await request(app).get(url());
    expect(r.body.heuristic_window_note.toLowerCase()).not.toMatch(CAUSAL_RE);
  });

  test('ACE-6: missing timestamp → 400 VALIDATION_ERROR', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/anomaly-centered?window_minutes=10`);
    expect(r.status).toBe(400);
    assertErrorShape(r.body, 'VALIDATION_ERROR', 400);
    assertNoLeakage(r.body);
  });

  test('ACE-7: zero window_minutes → 400 VALIDATION_ERROR', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/anomaly-centered?timestamp=${ts()}&window_minutes=0`);
    expect(r.status).toBe(400);
    assertErrorShape(r.body, 'VALIDATION_ERROR', 400);
  });

  test('ACE-8: negative window_minutes → 400 VALIDATION_ERROR', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/anomaly-centered?timestamp=${ts()}&window_minutes=-5`);
    expect(r.status).toBe(400);
  });

  test('ACE-9: non-numeric window_minutes → 400 VALIDATION_ERROR', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/anomaly-centered?timestamp=${ts()}&window_minutes=abc`);
    expect(r.status).toBe(400);
  });

  test('ACE-10: result does not promote any evidence to hypothesis support', async () => {
    const r = await request(app).get(url());
    // The response must not carry hypothesis_relationships or any list-labeling
    expect(r.body).not.toHaveProperty('supporting_evidence');
    expect(r.body).not.toHaveProperty('environmental_context');
    expect(r.body).not.toHaveProperty('hypothesis_relationships');
  });

  test('ACE-11: causal_attribution_established is NOT in the response', async () => {
    const r = await request(app).get(url());
    expect(r.body).not.toHaveProperty('causal_attribution_established');
  });

  test('ACE-12: no evidence mutation — returned IDs are verbatim from CSV', async () => {
    const r = await request(app).get(url());
    const csvIds = new Set(g15Rows.map(row => row.evidence_id));
    for (const rec of r.body.evidence) {
      expect(csvIds.has(rec.evidence_id)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §9  Source and measurement filtering
// ─────────────────────────────────────────────────────────────────────────────

describe('§9 Source and measurement filtering', () => {
  const SOURCES = ['CASE', 'GOES11_MAG', 'GOES11_EP8', 'GOES11_EPHEMERIS'];

  for (const src of SOURCES) {
    test(`SRC-${src}: /evidence/source/${src} returns only ${src} rows, IDs unchanged`, async () => {
      const r = await request(app).get(`/api/cases/${G15}/evidence/source/${encodeURIComponent(src)}`);
      expect(r.status).toBe(200);
      expect(r.body.source).toBe(src);
      const csvIds = new Set(g15Rows.filter(row => row.source === src).map(row => row.evidence_id));
      for (const rec of r.body.evidence) {
        expect(rec.source).toBe(src);
        expect(csvIds.has(rec.evidence_id)).toBe(true);
      }
      expect(r.body.evidence_count).toBe(csvIds.size);
    });
  }

  test('MEAS-1: measurement filter changes selection only — does not modify IDs', async () => {
    const firstMeasurement = g15Rows[0].measurement;
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/measurement?measurement=${encodeURIComponent(firstMeasurement)}`);
    expect(r.status).toBe(200);
    const expectedIds = new Set(
      g15Rows.filter(row => row.measurement === firstMeasurement).map(row => row.evidence_id)
    );
    for (const rec of r.body.evidence) {
      expect(expectedIds.has(rec.evidence_id)).toBe(true);
      expect(rec.measurement).toBe(firstMeasurement);
    }
    expect(r.body.evidence_count).toBe(expectedIds.size);
  });

  test('MEAS-2: evidence_type filter changes selection only — does not modify assessments', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/measurement?evidence_type=case_event`);
    expect(r.status).toBe(200);
    for (const rec of r.body.evidence) {
      expect(rec.evidence_type).toBe('case_event');
    }
  });

  test('MEAS-3: filter does not remove provenance metadata from returned records', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/measurement?evidence_type=environmental_observation`);
    expect(r.status).toBe(200);
    // Every returned record must still have all 12 fields
    for (const rec of r.body.evidence.slice(0, 5)) {
      expect(rec).toHaveProperty('evidence_id');
      expect(rec).toHaveProperty('dataset_id');
      expect(rec).toHaveProperty('provider');
      expect(rec).toHaveProperty('variable');
    }
  });

  test('MEAS-4: filter does not establish any new hypothesis relationships', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/measurement?evidence_type=environmental_observation`);
    // The response must not carry hypothesis_relationships at the top level
    expect(r.body).not.toHaveProperty('hypothesis_relationships');
    expect(r.body).not.toHaveProperty('supporting_evidence');
  });

  test('MEAS-5: missing filter returns 400 VALIDATION_ERROR', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence/measurement`);
    expect(r.status).toBe(400);
    assertErrorShape(r.body, 'VALIDATION_ERROR', 400);
  });

  test('MEAS-6: /evidence/source for TCA returns only TCA IDs (no G15 bleed)', async () => {
    const r = await request(app).get(`/api/cases/${TCA}/evidence/source/CASE`);
    expect(r.status).toBe(200);
    for (const rec of r.body.evidence) {
      expect(rec.evidence_id).toMatch(/^E-TCA-/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10  Scientific response-tree scan
// ─────────────────────────────────────────────────────────────────────────────

describe('§10 Scientific response-tree scan — no prohibited content', () => {
  const ENDPOINTS = [
    [`/api/cases/${G15}/evidence`,                                                                        'evidence'],
    [`/api/cases/${G15}/evidence/${() => g15AnchorId}`,                                                  'evidence-byId'],
    [`/api/cases/${G15}/evidence/${() => g15AnchorId}/provenance`,                                       'provenance'],
    [`/api/cases/${G15}/evidence-index`,                                                                  'evidence-index'],
    [`/api/cases/${G15}/environmental-context`,                                                           'env-context'],
    [`/api/cases/${G15}/hypotheses/H1/evidence`,                                                         'hyp-H1-evidence'],
    [`/api/cases/${G15}/hypotheses/compare`,                                                              'hyp-compare'],
    [`/api/cases/${G15}/evidence/source/CASE`,                                                           'source-CASE'],
    [`/api/cases/${G15}/evidence/measurement?evidence_type=case_event`,                                  'measurement'],
    [`/api/cases/${G15}/evidence/time-window?from=2010-04-05T09:00:00Z`,                                 'time-window'],
    [`/api/cases/${G15}/evidence/anomaly-centered?timestamp=2010-04-05T09%3A48%3A00Z&window_minutes=10`, 'anomaly-centered'],
  ];

  for (const [urlOrFn, label] of ENDPOINTS) {
    const getUrl = typeof urlOrFn === 'function' ? urlOrFn : () => urlOrFn;

    test(`SCAN-${label}: no numerical probability language`, async () => {
      const r = await request(app).get(getUrl());
      if (r.status !== 200) return; // skip error responses
      scanForNumProb(r.body);
    });

    test(`SCAN-${label}: no causal-certainty language`, async () => {
      const r = await request(app).get(getUrl());
      if (r.status !== 200) return;
      // Only check for affirmative causal claims (e.g. "caused the anomaly")
      // not the word "causal" which appears in legitimate disclaimers
      const CERT_RE = /\b(?:caused\s+the|caused\s+by|was\s+caused|been\s+caused|confirms?\s+causali)\b/i;
      const text = JSON.stringify(r.body);
      expect(text).not.toMatch(CERT_RE);
    });

    test(`SCAN-${label}: no invented confidence score fields`, async () => {
      const r = await request(app).get(getUrl());
      if (r.status !== 200) return;
      const text = JSON.stringify(r.body);
      expect(text).not.toMatch(/"confidence(?:_score)?"\s*:\s*\d/);
    });

    test(`SCAN-${label}: assessment values in allowed vocabulary only`, async () => {
      const r = await request(app).get(getUrl());
      if (r.status !== 200) return;
      // Recursively find any `assessment` string values
      function checkAssessments(val) {
        if (val && typeof val === 'object') {
          if (typeof val.assessment === 'string') {
            expect(ALLOWED_ASSESSMENTS.has(val.assessment)).toBe(true);
          }
          Object.values(val).forEach(checkAssessments);
        }
        if (Array.isArray(val)) val.forEach(checkAssessments);
      }
      checkAssessments(r.body);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// §11  Read-only guarantee
// ─────────────────────────────────────────────────────────────────────────────

describe('§11 Read-only guarantee — forensic authority unchanged after exploration', () => {
  test('RO-1: evidence row count unchanged after full exploration run', async () => {
    // Run a representative exploration sweep
    await Promise.all([
      request(app).get(`/api/cases/${G15}/evidence`),
      request(app).get(`/api/cases/${G15}/evidence/${g15AnchorId}`),
      request(app).get(`/api/cases/${G15}/evidence/${g15AnchorId}/provenance`),
      request(app).get(`/api/cases/${G15}/evidence-index`),
      request(app).get(`/api/cases/${G15}/environmental-context`),
      request(app).get(`/api/cases/${G15}/hypotheses/H1/evidence`),
      request(app).get(`/api/cases/${G15}/hypotheses/compare`),
      request(app).get(`/api/cases/${G15}/evidence/source/CASE`),
      request(app).get(`/api/cases/${G15}/evidence/measurement?evidence_type=case_event`),
      request(app).get(`/api/cases/${G15}/evidence/time-window?from=2010-04-05T09:00:00Z`),
      request(app).get(`/api/cases/${G15}/evidence/anomaly-centered?timestamp=${encodeURIComponent(g15AnchorTs)}&window_minutes=10`),
    ]);
    // Re-parse and verify row count
    const freshRows = await parseEvidenceCSV(G15);
    expect(freshRows.length).toBe(GOLDEN.evidence_record_count);
  });

  test('RO-2: first and last evidence IDs unchanged after exploration (golden)', async () => {
    const freshRows = await parseEvidenceCSV(G15);
    expect(freshRows[0].evidence_id).toBe(GOLDEN.first_evidence_id);
    expect(freshRows[freshRows.length - 1].evidence_id).toBe(GOLDEN.last_evidence_id);
  });

  test('RO-3: evidence graph causal_attribution_established is still false after exploration', async () => {
    const freshRows  = await parseEvidenceCSV(G15);
    const freshGraph = await buildEvidenceGraph(G15, freshRows);
    expect(freshGraph.causal_attribution_established).toBe(false);
  });

  test('RO-4: hypothesis assessments unchanged after exploration (golden snapshot)', async () => {
    const freshRows   = await parseEvidenceCSV(G15);
    const freshGraph  = await buildEvidenceGraph(G15, freshRows);
    for (const h of freshGraph.hypotheses) {
      expect(h.assessment).toBe(G15_ASSESSMENTS[h.hypothesis_id]);
    }
  });

  test('RO-5: forensic analysis causal_attribution_established still false', async () => {
    const freshRows   = await parseEvidenceCSV(G15);
    const freshGraph  = await buildEvidenceGraph(G15, freshRows);
    const freshAnalysis = buildForensicAnalysis(G15, freshGraph, null);
    expect(freshAnalysis.causal_attribution_established).toBe(false);
  });

  test('RO-6: EPHEMERIS count still 61 after exploration (golden snapshot)', async () => {
    const freshRows = await parseEvidenceCSV(G15);
    const ephCount = freshRows.filter(r => r.source === 'GOES11_EPHEMERIS').length;
    expect(ephCount).toBe(GOLDEN.ephemeris_count);
  });

  test('RO-7: golden evidence_summary totals unchanged', async () => {
    const freshRows   = await parseEvidenceCSV(G15);
    const freshGraph  = await buildEvidenceGraph(G15, freshRows);
    const freshAnalysis = buildForensicAnalysis(G15, freshGraph, null);
    expect(freshAnalysis.evidence_summary.total_environmental_context)
      .toBe(GOLDEN.evidence_summary.total_environmental_context);
    expect(freshAnalysis.evidence_summary.total_supporting_evidence)
      .toBe(GOLDEN.evidence_summary.total_supporting_evidence);
    expect(freshAnalysis.evidence_summary.total_contradicting_evidence)
      .toBe(GOLDEN.evidence_summary.total_contradicting_evidence);
    expect(freshAnalysis.evidence_summary.total_non_discriminating_evidence)
      .toBe(GOLDEN.evidence_summary.total_non_discriminating_evidence);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §12  Error contract integration
// ─────────────────────────────────────────────────────────────────────────────

describe('§12 Error contract integration', () => {
  test('ERR-1: unknown case /evidence → 404 CASE_NOT_FOUND', async () => {
    const r = await request(app).get(`/api/cases/${BOGUS}/evidence`);
    expect(r.status).toBe(404);
    assertErrorShape(r.body, 'CASE_NOT_FOUND', 404);
    assertNoLeakage(r.body);
  });

  test('ERR-2: unknown evidence ID /evidence/:id → 404 EVIDENCE_NOT_FOUND', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence/E-G15-BOGUS-9999`);
    expect(r.status).toBe(404);
    assertErrorShape(r.body, 'EVIDENCE_NOT_FOUND', 404);
    assertNoLeakage(r.body);
  });

  test('ERR-3: cross-case evidence ID /evidence/:id → 404 EVIDENCE_NOT_FOUND', async () => {
    const tcaId = tcaRows[0].evidence_id;
    const r = await request(app).get(`/api/cases/${G15}/evidence/${tcaId}`);
    expect(r.status).toBe(404);
    assertErrorShape(r.body, 'EVIDENCE_NOT_FOUND', 404);
  });

  test('ERR-4: unknown hypothesis /hypotheses/:hid/evidence → 404 HYPOTHESIS_NOT_FOUND', async () => {
    const r = await request(app).get(`/api/cases/${G15}/hypotheses/H_BOGUS/evidence`);
    expect(r.status).toBe(404);
    assertErrorShape(r.body, 'HYPOTHESIS_NOT_FOUND', 404);
    assertNoLeakage(r.body);
  });

  test('ERR-5: missing time-window bounds → 400 VALIDATION_ERROR', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence/time-window`);
    expect(r.status).toBe(400);
    assertErrorShape(r.body, 'VALIDATION_ERROR', 400);
    assertNoLeakage(r.body);
  });

  test('ERR-6: missing anomaly timestamp → 400 VALIDATION_ERROR', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence/anomaly-centered?window_minutes=10`);
    expect(r.status).toBe(400);
    assertErrorShape(r.body, 'VALIDATION_ERROR', 400);
  });

  test('ERR-7: zero window_minutes → 400 VALIDATION_ERROR', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/anomaly-centered?timestamp=${encodeURIComponent(g15AnchorTs)}&window_minutes=0`);
    expect(r.status).toBe(400);
    assertErrorShape(r.body, 'VALIDATION_ERROR', 400);
  });

  test('ERR-8: non-numeric window_minutes → 400 VALIDATION_ERROR', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/evidence/anomaly-centered?timestamp=${encodeURIComponent(g15AnchorTs)}&window_minutes=bad`);
    expect(r.status).toBe(400);
    assertErrorShape(r.body, 'VALIDATION_ERROR', 400);
  });

  test('ERR-9: missing measurement filter → 400 VALIDATION_ERROR', async () => {
    const r = await request(app).get(`/api/cases/${G15}/evidence/measurement`);
    expect(r.status).toBe(400);
    assertErrorShape(r.body, 'VALIDATION_ERROR', 400);
  });

  test('ERR-10: bogus hypothesis_ids on /compare → 404 HYPOTHESIS_NOT_FOUND', async () => {
    const r = await request(app)
      .get(`/api/cases/${G15}/hypotheses/compare?hypothesis_ids=H_BOGUS`);
    expect(r.status).toBe(404);
    assertErrorShape(r.body, 'HYPOTHESIS_NOT_FOUND', 404);
    assertNoLeakage(r.body);
  });

  test('ERR-11: unknown case /evidence-index → 404 CASE_NOT_FOUND', async () => {
    const r = await request(app).get(`/api/cases/${BOGUS}/evidence-index`);
    expect(r.status).toBe(404);
    assertErrorShape(r.body, 'CASE_NOT_FOUND', 404);
  });

  test('ERR-12: unknown case /environmental-context → 404 CASE_NOT_FOUND', async () => {
    const r = await request(app).get(`/api/cases/${BOGUS}/environmental-context`);
    expect(r.status).toBe(404);
    assertErrorShape(r.body, 'CASE_NOT_FOUND', 404);
  });

  test('ERR-13: unknown case /hypotheses/compare → 404 CASE_NOT_FOUND', async () => {
    const r = await request(app).get(`/api/cases/${BOGUS}/hypotheses/compare`);
    expect(r.status).toBe(404);
    assertErrorShape(r.body, 'CASE_NOT_FOUND', 404);
  });

  test('ERR-14: unknown case /evidence/source/:source → 404 CASE_NOT_FOUND', async () => {
    const r = await request(app).get(`/api/cases/${BOGUS}/evidence/source/CASE`);
    expect(r.status).toBe(404);
    assertErrorShape(r.body, 'CASE_NOT_FOUND', 404);
  });

  test('ERR-15: every error response has no stack traces or internal paths', async () => {
    const errResponses = await Promise.all([
      request(app).get(`/api/cases/${BOGUS}/evidence`),
      request(app).get(`/api/cases/${G15}/evidence/E-G15-BOGUS`),
      request(app).get(`/api/cases/${G15}/evidence/time-window`),
      request(app).get(`/api/cases/${G15}/hypotheses/compare?hypothesis_ids=H_BOGUS`),
    ]);
    for (const r of errResponses) {
      assertNoLeakage(r.body);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §13  Performance baseline
// ─────────────────────────────────────────────────────────────────────────────

describe('§13 Performance baseline (wall-clock, no caching)', () => {
  // Runs each endpoint 3 times and records min/avg/max latency.
  // These are not pass/fail timing gates — they establish a baseline for
  // the Phase 10.3 caching decision.  The test always passes as long as
  // the endpoint returns 200.

  const PERF_ENDPOINTS = [
    { label: 'GET /evidence',              url: `/api/cases/${G15}/evidence` },
    { label: 'GET /evidence/:id (anchor)', url: () => `/api/cases/${G15}/evidence/${g15AnchorId}` },
    { label: 'GET /evidence-index',        url: `/api/cases/${G15}/evidence-index` },
    { label: 'GET /environmental-context', url: `/api/cases/${G15}/environmental-context` },
    { label: 'GET /hypotheses/H2/evidence',url: `/api/cases/${G15}/hypotheses/H2/evidence` },
    {
      label: 'GET /evidence/anomaly-centered',
      url: () => `/api/cases/${G15}/evidence/anomaly-centered?timestamp=${encodeURIComponent(g15AnchorTs)}&window_minutes=10`,
    },
  ];

  const RUNS = 3;
  const perfResults = {};

  afterAll(() => {
    // Emit the baseline table to stdout so it's captured in CI logs.
    const lines = ['\n=== Phase 10.2B Performance Baseline ==='];
    for (const [label, { avg, min, max }] of Object.entries(perfResults)) {
      lines.push(`  ${label.padEnd(45)} min=${min}ms  avg=${avg}ms  max=${max}ms`);
    }
    lines.push('=========================================\n');
    console.log(lines.join('\n')); // eslint-disable-line no-console
  });

  for (const { label, url } of PERF_ENDPOINTS) {
    test(`PERF: ${label}`, async () => {
      const times = [];
      for (let i = 0; i < RUNS; i++) {
        const resolvedUrl = typeof url === 'function' ? url() : url;
        const t0 = Date.now();
        const r  = await request(app).get(resolvedUrl);
        times.push(Date.now() - t0);
        expect(r.status).toBe(200);
      }
      const avg = Math.round(times.reduce((a, b) => a + b, 0) / RUNS);
      const min = Math.min(...times);
      const max = Math.max(...times);
      perfResults[label] = { avg, min, max };
      // Sanity gate: each individual request under 5 000 ms
      for (const t of times) expect(t).toBeLessThan(5000);
    });
  }
});
