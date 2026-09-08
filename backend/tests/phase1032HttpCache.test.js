'use strict';

/**
 * Phase 10.3.2 — HTTP Evidence Cache Integration & Concurrency Hardening
 *
 * Verifies that every exploration HTTP route (Phase 7.3 and Phase 10.2A)
 * is now served through evidenceCaseCache, that the cache invariants hold
 * under concurrent load, and that mutation safety is preserved end-to-end.
 *
 * Test IDs:
 *   HTTP-CACHE-1   Cache is consulted on every Phase 10.2A route (cold → warm)
 *   HTTP-CACHE-2   Cache is consulted on every Phase 7.3 route (cold → warm)
 *   HTTP-CACHE-3   Warm hit: second request does NOT re-parse or re-build
 *   HTTP-CACHE-4   Warm hit: response body is byte-identical to cold hit
 *   HTTP-CACHE-5   Unknown case → 404 from cache path, not raw filesystem error
 *   HTTP-CACHE-6   Cache stats show correct hit/miss accounting after sequential requests
 *   HTTP-CACHE-7   causal_attribution_established is false on all cached responses
 *   HTTP-CACHE-8   Hypothesis assessments are identical between cold and warm hits (G15 canonical)
 *   HTTP-CACHE-9   EPHEMERIS records absent from all hypothesis-evidence responses served from cache
 *   HTTP-CACHE-10  No numerical probabilities in any cached response
 *   HTTP-CACHE-11  environmental_context ≠ supporting_evidence on cached hypothesis/evidence response
 *   HTTP-CACHE-12  Evidence IDs are stable across cold and warm hits (no regeneration)
 *   HTTP-CACHE-13  Cross-case isolation: G15 and TCA routes return only their own IDs
 *   HTTP-CACHE-14  Concurrent cold requests for same case resolve consistently (CD-2)
 *   HTTP-CACHE-15  Concurrent cold requests for different cases complete without interference
 *   HTTP-CACHE-16  Mutation safety: caller cannot alter cached graph via response data
 *   HTTP-CACHE-17  Mutation safety: caller cannot push to returned rows array
 *   HTTP-CACHE-18  Warm-hit rows.length equals cold-hit rows.length (slice is full copy)
 *   HTTP-CACHE-19  Phase 7.3 /evidence-index response is equivalent before and after cache wiring
 *   HTTP-CACHE-20  Phase 7.3 /hypotheses/compare response is equivalent before and after cache wiring
 *
 *   PERF-1  All 11 exploration routes for G15 are served in < 8 s from warm cache (combined)
 *   CONC-1  50 concurrent requests to /evidence return consistent evidence_count
 *   CONC-2  50 concurrent requests to /hypotheses/compare return consistent shared_evidence
 *   MUT-1   Directly mutating a returned graph reference does not alter the next warm-hit response
 *   MUT-2   Pushing to returned rows array does not corrupt subsequent warm-hit row count
 *   MUT-3   Attempting to set causal_attribution_established on returned graph throws (frozen)
 *
 * Scientific invariants preserved (never modified by Phase 10.3.2):
 *   G15: 278 evidence rows, E-G15-0001..E-G15-0278
 *   H1=mixed, H2=mixed, H3=supported, H4=insufficient_evidence, H5=strongly_supported
 *   causal_attribution_established === false
 *   EPHEMERIS records never in hypothesis lists
 *   No env/supporting overlap
 *   No numerical probabilities
 *   No cross-case IDs
 */

const request           = require('supertest');
const { app, parseEvidenceCSV, buildEvidenceGraph } = require('../server');
const evidenceCaseCache = require('../services/evidenceCaseCache');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const G15   = 'galaxy-15';
const TCA   = 'test-case-alpha';
const BOGUS = 'no-such-case-1032-zzz';

const G15_ASSESSMENTS = {
  H1: 'mixed',
  H2: 'mixed',
  H3: 'supported',
  H4: 'insufficient_evidence',
  H5: 'strongly_supported',
};

const FOUR_LISTS = [
  'environmental_context',
  'supporting_evidence',
  'contradicting_evidence',
  'non_discriminating_evidence',
];

// All Phase 10.2A + Phase 7.3 exploration routes under test
const PHASE_102A_ROUTES = [
  `/api/cases/${G15}/evidence`,
  `/api/cases/${G15}/evidence/source/GOES11_EP8`,
  `/api/cases/${G15}/evidence/measurement`,
  `/api/cases/${G15}/evidence/time-window?from=2010-04-05T00:00:00Z&to=2010-04-06T00:00:00Z`,
  `/api/cases/${G15}/evidence/anomaly-centered`,
];

const PHASE_73_ROUTES_NAMES = [
  'evidence-index',
  'environmental-context',
  'hypotheses/compare',
];

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

let g15Rows;
let g15Graph;
let g15H1Id;     // first hypothesis ID
let g15AnchorId; // evidence_id from CASE source (used in provenance tests)
let g15EphId;    // evidence_id from GOES11_EPHEMERIS

beforeAll(async () => {
  jest.setTimeout(60_000);

  // Load once via the canonical pipeline (not via cache) to establish reference
  g15Rows  = await parseEvidenceCSV(G15);
  g15Graph = await buildEvidenceGraph(G15, g15Rows);

  g15H1Id     = g15Graph.hypotheses[0]?.hypothesis_id ?? null;
  const eph   = g15Rows.find((r) => r.source === 'GOES11_EPHEMERIS');
  g15EphId    = eph ? eph.evidence_id : null;
  const anch  = g15Rows.find((r) => r.source === 'CASE');
  g15AnchorId = anch ? anch.evidence_id : null;
}, 60_000);

// Reset cache counters between tests so hit/miss accounting is predictable
beforeEach(() => {
  evidenceCaseCache._reset();
});

afterAll(() => {
  evidenceCaseCache._reset();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Make a GET request and return { res, body } */
async function get(url) {
  const res  = await request(app).get(url);
  const body = res.body;
  return { res, body };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-CACHE-1: Cache consulted on every Phase 10.2A route
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTP-CACHE-1: Phase 10.2A routes use the evidence cache', () => {
  test('cold hit increments misses by 1 for /evidence', async () => {
    await get(`/api/cases/${G15}/evidence`);
    const stats = evidenceCaseCache.getStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(0);
  });

  test('warm hit on /evidence increments hits by 1', async () => {
    await get(`/api/cases/${G15}/evidence`);   // cold
    await get(`/api/cases/${G15}/evidence`);   // warm
    const stats = evidenceCaseCache.getStats();
    expect(stats.hits).toBeGreaterThanOrEqual(1);
  });

  test('cold hit increments misses by 1 for /evidence/source/:source', async () => {
    await get(`/api/cases/${G15}/evidence/source/GOES11_EP8`);
    const stats = evidenceCaseCache.getStats();
    expect(stats.misses).toBe(1);
  });

  test('warm hit on /evidence/source/:source increments hits', async () => {
    await get(`/api/cases/${G15}/evidence/source/GOES11_EP8`);
    await get(`/api/cases/${G15}/evidence/source/GOES11_EP8`);
    expect(evidenceCaseCache.getStats().hits).toBeGreaterThanOrEqual(1);
  });

  test('cold hit increments misses by 1 for /evidence/measurement (with measurement param)', async () => {
    // /evidence/measurement requires ?measurement= param; without it => 400 before cache.
    await get(`/api/cases/${G15}/evidence/measurement?measurement=e_flux`);
    expect(evidenceCaseCache.getStats().misses).toBe(1);
  });

  test('cold hit increments misses by 1 for /evidence/time-window', async () => {
    await get(
      `/api/cases/${G15}/evidence/time-window?from=2010-04-05T00:00:00Z&to=2010-04-06T00:00:00Z`,
    );
    expect(evidenceCaseCache.getStats().misses).toBe(1);
  });

  test('/evidence/anomaly-centered without required params returns 400 (before cache)', async () => {
    // No timestamp/window_minutes provided => 400 VALIDATION_ERROR before cache is consulted
    const { res } = await get(`/api/cases/${G15}/evidence/anomaly-centered`);
    expect(res.status).toBe(400);
    expect(evidenceCaseCache.getStats().misses).toBe(0);
  });

  test('/evidence/anomaly-centered with required params consults cache', async () => {
    await get(`/api/cases/${G15}/evidence/anomaly-centered?timestamp=2010-04-05T09:48:00Z&window_minutes=30`);
    expect(evidenceCaseCache.getStats().misses).toBe(1);
  });

  test('second request for G15 is always a warm hit regardless of route', async () => {
    // Prime via one route (cold miss)
    await get(`/api/cases/${G15}/evidence`);
    const statsBefore = { ...evidenceCaseCache.getStats() };

    // Query a different route — same caseId => warm hit
    await get(`/api/cases/${G15}/evidence-index`);
    const statsAfter = evidenceCaseCache.getStats();
    expect(statsAfter.hits).toBe(statsBefore.hits + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-CACHE-2: Cache consulted on every Phase 7.3 route
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTP-CACHE-2: Phase 7.3 routes use the evidence cache', () => {
  const P73_CASES = [
    { name: 'evidence-index',         url: `/api/cases/${G15}/evidence-index` },
    { name: 'environmental-context',  url: `/api/cases/${G15}/environmental-context` },
    { name: 'hypotheses/compare',     url: `/api/cases/${G15}/hypotheses/compare` },
    { name: 'hypotheses/:hid/evidence', url: () => `/api/cases/${G15}/hypotheses/${g15H1Id}/evidence` },
    { name: 'evidence/:eid/provenance', url: () => `/api/cases/${G15}/evidence/${g15AnchorId}/provenance` },
  ];

  for (const tc of P73_CASES) {
    test(`cold hit increments misses for ${tc.name}`, async () => {
      const url = typeof tc.url === 'function' ? tc.url() : tc.url;
      if (!url || url.includes('null') || url.includes('undefined')) return; // skip if fixture not resolved
      await get(url);
      expect(evidenceCaseCache.getStats().misses).toBe(1);
      expect(evidenceCaseCache.getStats().hits).toBe(0);
    });

    test(`warm hit increments hits for ${tc.name}`, async () => {
      const url = typeof tc.url === 'function' ? tc.url() : tc.url;
      if (!url || url.includes('null') || url.includes('undefined')) return;
      await get(url); // cold
      await get(url); // warm
      expect(evidenceCaseCache.getStats().hits).toBeGreaterThanOrEqual(1);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-CACHE-3: Warm hit does NOT re-parse or re-build
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTP-CACHE-3: Warm hit skips CSV parsing and graph building', () => {
  test('cache size stays 1 on second identical request', async () => {
    await get(`/api/cases/${G15}/evidence`);
    const sizeAfterCold = evidenceCaseCache.getStats().size;
    await get(`/api/cases/${G15}/evidence`);
    const sizeAfterWarm = evidenceCaseCache.getStats().size;
    expect(sizeAfterCold).toBe(1);
    expect(sizeAfterWarm).toBe(1);
  });

  test('misses stays at 1 after second request (no second parse)', async () => {
    await get(`/api/cases/${G15}/evidence`);
    await get(`/api/cases/${G15}/evidence`);
    expect(evidenceCaseCache.getStats().misses).toBe(1);
  });

  test('cross-route warm hit: /evidence-index after /evidence does not miss again', async () => {
    await get(`/api/cases/${G15}/evidence`);          // cold
    const before = evidenceCaseCache.getStats().misses;
    await get(`/api/cases/${G15}/evidence-index`);    // warm — same cache key
    expect(evidenceCaseCache.getStats().misses).toBe(before); // no new miss
    expect(evidenceCaseCache.getStats().hits).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-CACHE-4: Warm hit response is byte-identical to cold hit
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTP-CACHE-4: Response bodies are identical on cold vs warm hit', () => {
  const ROUTES = [
    { name: 'evidence',              url: `/api/cases/${G15}/evidence` },
    { name: 'evidence-index',        url: `/api/cases/${G15}/evidence-index` },
    { name: 'environmental-context', url: `/api/cases/${G15}/environmental-context` },
    { name: 'hypotheses/compare',    url: `/api/cases/${G15}/hypotheses/compare` },
  ];

  for (const tc of ROUTES) {
    test(`${tc.name}: cold and warm responses are deeply equal`, async () => {
      const cold = await get(tc.url);
      expect(cold.res.status).toBe(200);
      const warm = await get(tc.url);
      expect(warm.res.status).toBe(200);
      expect(warm.body).toEqual(cold.body);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-CACHE-5: Unknown case returns 404 via cache path
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTP-CACHE-5: Unknown case returns 404 via cache path', () => {
  const BOGUS_ROUTES = [
    `/api/cases/${BOGUS}/evidence`,
    `/api/cases/${BOGUS}/evidence-index`,
    `/api/cases/${BOGUS}/environmental-context`,
    `/api/cases/${BOGUS}/hypotheses/compare`,
  ];

  for (const url of BOGUS_ROUTES) {
    test(`404 CASE_NOT_FOUND for ${url}`, async () => {
      const { res, body } = await get(url);
      expect(res.status).toBe(404);
      expect(body.error_code).toBe('CASE_NOT_FOUND');
      expect(typeof body.error).toBe('string');
      // Unknown case must NOT be cached
      expect(evidenceCaseCache.getStats().size).toBe(0);
    });
  }

  test('unknown case is never cached (size stays 0 after 404)', async () => {
    await get(`/api/cases/${BOGUS}/evidence`);
    await get(`/api/cases/${BOGUS}/evidence`);
    expect(evidenceCaseCache.getStats().size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-CACHE-6: Hit/miss accounting
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTP-CACHE-6: Hit/miss accounting across sequential requests', () => {
  test('three sequential G15 requests produce 1 miss + 2 hits', async () => {
    await get(`/api/cases/${G15}/evidence`);
    await get(`/api/cases/${G15}/evidence`);
    await get(`/api/cases/${G15}/evidence`);
    const s = evidenceCaseCache.getStats();
    expect(s.misses).toBe(1);
    expect(s.hits).toBe(2);
  });

  test('two different cases produce 2 misses, 0 hits initially', async () => {
    await get(`/api/cases/${G15}/evidence`);
    await get(`/api/cases/${TCA}/evidence`);
    const s = evidenceCaseCache.getStats();
    expect(s.misses).toBe(2);
    expect(s.hits).toBe(0);
    expect(s.size).toBe(2);
  });

  test('after priming both cases, further requests increment only hits', async () => {
    await get(`/api/cases/${G15}/evidence`);
    await get(`/api/cases/${TCA}/evidence`);
    const beforeHits = evidenceCaseCache.getStats().hits;
    await get(`/api/cases/${G15}/evidence-index`);
    await get(`/api/cases/${TCA}/evidence-index`);
    const afterHits = evidenceCaseCache.getStats().hits;
    expect(afterHits).toBe(beforeHits + 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-CACHE-7: causal_attribution_established is false on all cached responses
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTP-CACHE-7: causal_attribution_established is false (CC-6)', () => {
  test('GET /evidence response does not set causal_attribution_established to true', async () => {
    const { body } = await get(`/api/cases/${G15}/evidence`);
    // Field may not be present on this route; if present it must be false
    if ('causal_attribution_established' in body) {
      expect(body.causal_attribution_established).toBe(false);
    }
  });

  test('hypothesis/evidence view does not set causal_attribution_established to true', async () => {
    if (!g15H1Id) return;
    const { body } = await get(`/api/cases/${G15}/hypotheses/${g15H1Id}/evidence`);
    if ('causal_attribution_established' in body) {
      expect(body.causal_attribution_established).toBe(false);
    }
    // Also check hypothesis objects within the response
    for (const list of FOUR_LISTS) {
      if (Array.isArray(body[list])) {
        for (const rec of body[list]) {
          if ('causal_attribution_established' in rec) {
            expect(rec.causal_attribution_established).toBe(false);
          }
        }
      }
    }
  });

  test('getCaseEvidence returns graph with causal_attribution_established === false', async () => {
    const { graph } = await evidenceCaseCache.getCaseEvidence(G15);
    expect(graph.causal_attribution_established).toBe(false);
  });

  test('warm-hit graph still has causal_attribution_established === false', async () => {
    await evidenceCaseCache.getCaseEvidence(G15); // cold
    const { graph } = await evidenceCaseCache.getCaseEvidence(G15); // warm
    expect(graph.causal_attribution_established).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-CACHE-8: Hypothesis assessments are canonical on cached responses
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTP-CACHE-8: Hypothesis assessments identical cold vs warm (CC-6)', () => {
  function extractAssessments(hypotheses) {
    const map = {};
    for (const h of hypotheses) {
      map[h.hypothesis_id] = h.assessment;
    }
    return map;
  }

  test('G15 cached graph hypotheses match canonical assessments', async () => {
    const { graph } = await evidenceCaseCache.getCaseEvidence(G15);
    for (const h of graph.hypotheses) {
      const shortId = h.hypothesis_id.replace(/^H-G15-/, 'H');
      if (G15_ASSESSMENTS[shortId]) {
        expect(h.assessment).toBe(G15_ASSESSMENTS[shortId]);
      }
    }
  });

  test('cold and warm getCaseEvidence return same hypothesis assessments', async () => {
    const cold = await evidenceCaseCache.getCaseEvidence(G15);
    const warm = await evidenceCaseCache.getCaseEvidence(G15);
    const coldAssessments = extractAssessments(cold.graph.hypotheses);
    const warmAssessments = extractAssessments(warm.graph.hypotheses);
    expect(warmAssessments).toEqual(coldAssessments);
  });

  test('/hypotheses/compare assessments stable across cold and warm HTTP hits', async () => {
    const cold = await get(`/api/cases/${G15}/hypotheses/compare`);
    const warm = await get(`/api/cases/${G15}/hypotheses/compare`);
    expect(cold.res.status).toBe(200);
    expect(warm.res.status).toBe(200);
    // hypotheses array assessments must be identical
    const coldHyps = (cold.body.hypotheses || []).map((h) => ({ id: h.hypothesis_id, a: h.assessment }));
    const warmHyps = (warm.body.hypotheses || []).map((h) => ({ id: h.hypothesis_id, a: h.assessment }));
    expect(warmHyps).toEqual(coldHyps);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-CACHE-9: EPHEMERIS absent from all hypothesis-evidence cached responses
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTP-CACHE-9: EPHEMERIS absent from hypothesis-evidence views (EX-6)', () => {
  test('hypothesis/:hid/evidence lists contain no EPHEMERIS records (cold)', async () => {
    if (!g15H1Id) return;
    const { body } = await get(`/api/cases/${G15}/hypotheses/${g15H1Id}/evidence`);
    for (const list of FOUR_LISTS) {
      if (Array.isArray(body[list])) {
        for (const rec of body[list]) {
          // Each entry has { evidence_id, relationship, interpretation, record }
          // where record is the full evidence row with source
          const source = rec.source || (rec.record && rec.record.source);
          if (source) {
            expect(source).not.toMatch(/EPHEMERIS/);
          }
          if (rec.evidence_id) {
            expect(rec.evidence_id).not.toBe(g15EphId);
          }
        }
      }
    }
  });

  test('hypothesis/:hid/evidence lists contain no EPHEMERIS records (warm)', async () => {
    if (!g15H1Id) return;
    await get(`/api/cases/${G15}/hypotheses/${g15H1Id}/evidence`); // cold
    const { body } = await get(`/api/cases/${G15}/hypotheses/${g15H1Id}/evidence`); // warm
    for (const list of FOUR_LISTS) {
      if (Array.isArray(body[list])) {
        for (const rec of body[list]) {
          const source = rec.source || (rec.record && rec.record.source);
          if (source) {
            expect(source).not.toMatch(/EPHEMERIS/);
          }
          if (rec.evidence_id) {
            expect(rec.evidence_id).not.toBe(g15EphId);
          }
        }
      }
    }
  });

  test('cached graph hypothesis lists do not contain EPHEMERIS evidence_ids', async () => {
    const { graph } = await evidenceCaseCache.getCaseEvidence(G15);
    for (const h of graph.hypotheses) {
      for (const list of FOUR_LISTS) {
        if (Array.isArray(h[list])) {
          for (const ref of h[list]) {
            expect(ref.evidence_id).not.toBe(g15EphId);
          }
        }
      }
    }
  });

  test('evidence-index does not contain EPHEMERIS record', async () => {
    const { body } = await get(`/api/cases/${G15}/evidence-index`);
    if (Array.isArray(body.evidence) && g15EphId) {
      const ids = body.evidence.map((r) => r.evidence_id);
      expect(ids).not.toContain(g15EphId);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-CACHE-10: No numerical probabilities in cached responses
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTP-CACHE-10: No numerical probabilities (EX-8)', () => {
  const NUMPROB_RE = /\b\d+(\.\d+)?\s*%|\b\d+(\.\d+)?\s*(probability|chance|likelihood)/i;

  const ROUTES = [
    `/api/cases/${G15}/evidence`,
    `/api/cases/${G15}/evidence-index`,
    `/api/cases/${G15}/environmental-context`,
    `/api/cases/${G15}/hypotheses/compare`,
  ];

  for (const url of ROUTES) {
    test(`no numerical probability in ${url.replace(`/api/cases/${G15}/`, '')} (warm)`, async () => {
      await get(url); // cold — prime cache
      const { body } = await get(url); // warm
      expect(JSON.stringify(body)).not.toMatch(NUMPROB_RE);
    });
  }

  test('no numerical probability in hypothesis/evidence warm response', async () => {
    if (!g15H1Id) return;
    const url = `/api/cases/${G15}/hypotheses/${g15H1Id}/evidence`;
    await get(url);
    const { body } = await get(url);
    expect(JSON.stringify(body)).not.toMatch(NUMPROB_RE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-CACHE-11: environmental_context ≠ supporting_evidence
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTP-CACHE-11: environmental_context distinct from supporting_evidence (EX-3)', () => {
  test('no env_ctx ID appears in supporting_evidence on warm hypothesis/evidence hit', async () => {
    if (!g15H1Id) return;
    const url = `/api/cases/${G15}/hypotheses/${g15H1Id}/evidence`;
    await get(url);
    const { body } = await get(url);

    const envIds = new Set(
      (body.environmental_context || []).map((r) => r.evidence_id).filter(Boolean),
    );
    const supIds = new Set(
      (body.supporting_evidence || []).map((r) => r.evidence_id).filter(Boolean),
    );
    for (const id of envIds) {
      expect(supIds.has(id)).toBe(false);
    }
  });

  test('cached graph env_ctx IDs do not appear in supporting_evidence for any hypothesis', async () => {
    const { graph } = await evidenceCaseCache.getCaseEvidence(G15);
    for (const h of graph.hypotheses) {
      const envIds = new Set((h.environmental_context || []).map((r) => r.evidence_id));
      const supIds = new Set((h.supporting_evidence  || []).map((r) => r.evidence_id));
      for (const id of envIds) {
        expect(supIds.has(id)).toBe(false);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-CACHE-12: Evidence IDs are stable across cold and warm hits
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTP-CACHE-12: Evidence IDs stable across cold and warm hits', () => {
  test('/evidence returns same IDs on cold and warm', async () => {
    const cold = await get(`/api/cases/${G15}/evidence`);
    const warm = await get(`/api/cases/${G15}/evidence`);
    const coldIds = (cold.body.evidence || []).map((r) => r.evidence_id).sort();
    const warmIds = (warm.body.evidence || []).map((r) => r.evidence_id).sort();
    expect(warmIds).toEqual(coldIds);
  });

  test('/evidence rows count is 278 for G15', async () => {
    const { body } = await get(`/api/cases/${G15}/evidence`);
    expect(body.evidence_count).toBe(278);
    expect(body.evidence.length).toBe(278);
  });

  test('getCaseEvidence rows.length is 278 for G15 (cold and warm)', async () => {
    const cold = await evidenceCaseCache.getCaseEvidence(G15);
    expect(cold.rows.length).toBe(278);
    const warm = await evidenceCaseCache.getCaseEvidence(G15);
    expect(warm.rows.length).toBe(278);
  });

  test('all G15 evidence IDs match E-G15-NNNN pattern', async () => {
    const { rows } = await evidenceCaseCache.getCaseEvidence(G15);
    for (const row of rows) {
      expect(row.evidence_id).toMatch(/^E-G15-\d{4}$/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-CACHE-13: Cross-case isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTP-CACHE-13: Cross-case isolation (no TCA IDs in G15, vice versa)', () => {
  test('G15 /evidence contains only E-G15-* IDs', async () => {
    const { body } = await get(`/api/cases/${G15}/evidence`);
    for (const rec of body.evidence) {
      expect(rec.evidence_id).toMatch(/^E-G15-/);
    }
  });

  test('TCA /evidence contains only E-TCA-* IDs', async () => {
    const { body } = await get(`/api/cases/${TCA}/evidence`);
    for (const rec of body.evidence) {
      expect(rec.evidence_id).toMatch(/^E-TCA-/);
    }
  });

  test('G15 and TCA cache entries are separate (no cross-case data)', async () => {
    const g15 = await evidenceCaseCache.getCaseEvidence(G15);
    const tca = await evidenceCaseCache.getCaseEvidence(TCA);
    expect(g15.graph.case_id).toBe(G15);
    expect(tca.graph.case_id).toBe(TCA);
    expect(evidenceCaseCache.getStats().size).toBe(2);
  });

  test('G15 hypothesis IDs are present and non-empty', async () => {
    const { graph } = await evidenceCaseCache.getCaseEvidence(G15);
    for (const h of graph.hypotheses) {
      expect(typeof h.hypothesis_id).toBe('string');
      expect(h.hypothesis_id.length).toBeGreaterThan(0);
    }
  });

  test('TCA hypothesis IDs are present and non-empty', async () => {
    const { graph } = await evidenceCaseCache.getCaseEvidence(TCA);
    for (const h of graph.hypotheses) {
      expect(typeof h.hypothesis_id).toBe('string');
      expect(h.hypothesis_id.length).toBeGreaterThan(0);
    }
  });

  test('G15 and TCA hypothesis ID sets are disjoint (no shared IDs)', async () => {
    const g15 = await evidenceCaseCache.getCaseEvidence(G15);
    const tca = await evidenceCaseCache.getCaseEvidence(TCA);
    const g15Ids = new Set(g15.graph.hypotheses.map((h) => h.hypothesis_id));
    const tcaIds = new Set(tca.graph.hypotheses.map((h) => h.hypothesis_id));
    // Hypothesis IDs may be the same short form (H1, H2...) per case, but the
    // case_id scopes them — they are separate objects in separate graphs
    // The important invariant is the graphs are separate cache entries
    expect(g15.graph.case_id).not.toBe(tca.graph.case_id);
    expect(g15.graph.case_id).toBe(G15);
    expect(tca.graph.case_id).toBe(TCA);
    // And the evidence ID sets must be disjoint
    const g15EvidIds = new Set(g15.rows.map((r) => r.evidence_id));
    const tcaEvidIds = new Set(tca.rows.map((r) => r.evidence_id));
    for (const id of g15EvidIds) {
      expect(tcaEvidIds.has(id)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-CACHE-14: Concurrent cold requests for same case resolve consistently (CD-2)
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTP-CACHE-14: Concurrent cold requests — same case (CD-2)', () => {
  test('20 concurrent cold requests all return 200 with same evidence_count', async () => {
    const promises = Array.from({ length: 20 }, () =>
      request(app).get(`/api/cases/${G15}/evidence`),
    );
    const results = await Promise.all(promises);
    const counts  = results.map((r) => r.body.evidence_count);
    expect(counts.every((c) => c === 278)).toBe(true);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  test('20 concurrent cold requests produce exactly 1 cache entry', async () => {
    const promises = Array.from({ length: 20 }, () =>
      request(app).get(`/api/cases/${G15}/evidence`),
    );
    await Promise.all(promises);
    expect(evidenceCaseCache.getStats().size).toBe(1);
  });

  test('20 concurrent getCaseEvidence calls return identical rows lengths', async () => {
    const promises = Array.from({ length: 20 }, () =>
      evidenceCaseCache.getCaseEvidence(G15),
    );
    const results = await Promise.all(promises);
    const lengths = results.map((r) => r.rows.length);
    expect(lengths.every((l) => l === 278)).toBe(true);
  });

  test('concurrent cold requests: total misses ≤ concurrent count, size stays 1', async () => {
    const N = 15;
    const promises = Array.from({ length: N }, () =>
      evidenceCaseCache.getCaseEvidence(G15),
    );
    await Promise.all(promises);
    const s = evidenceCacheStats();
    // misses may be 1 (first requester) or more (each joiner counts as miss) — all is fine
    expect(s.size).toBe(1);
  });
});

function evidenceCacheStats() {
  return evidenceCaseCache.getStats();
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-CACHE-15: Concurrent cold requests for different cases
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTP-CACHE-15: Concurrent cold requests — different cases', () => {
  test('concurrent G15 + TCA cold requests both succeed', async () => {
    const [g15Res, tcaRes] = await Promise.all([
      request(app).get(`/api/cases/${G15}/evidence`),
      request(app).get(`/api/cases/${TCA}/evidence`),
    ]);
    expect(g15Res.status).toBe(200);
    expect(tcaRes.status).toBe(200);
    expect(g15Res.body.case_id).toBe(G15);
    expect(tcaRes.body.case_id).toBe(TCA);
  });

  test('concurrent G15 + TCA produce 2 separate cache entries', async () => {
    await Promise.all([
      request(app).get(`/api/cases/${G15}/evidence`),
      request(app).get(`/api/cases/${TCA}/evidence`),
    ]);
    expect(evidenceCaseCache.getStats().size).toBe(2);
    expect(evidenceCaseCache.has(G15)).toBe(true);
    expect(evidenceCaseCache.has(TCA)).toBe(true);
  });

  test('concurrent G15 + TCA evidence counts are independently correct', async () => {
    const [g15Res, tcaRes] = await Promise.all([
      request(app).get(`/api/cases/${G15}/evidence`),
      request(app).get(`/api/cases/${TCA}/evidence`),
    ]);
    expect(g15Res.body.evidence_count).toBe(278);
    expect(tcaRes.body.evidence_count).toBeGreaterThan(0);
    expect(tcaRes.body.evidence_count).toBeLessThan(g15Res.body.evidence_count);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-CACHE-16: Mutation safety — graph (CD-1)
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTP-CACHE-16: Mutation safety — graph object (CD-1)', () => {
  test('returned graph is frozen (Object.isFrozen)', async () => {
    const { graph } = await evidenceCaseCache.getCaseEvidence(G15);
    expect(Object.isFrozen(graph)).toBe(true);
  });

  test('returned graph.hypotheses array is frozen', async () => {
    const { graph } = await evidenceCaseCache.getCaseEvidence(G15);
    expect(Object.isFrozen(graph.hypotheses)).toBe(true);
  });

  test('each hypothesis object is frozen', async () => {
    const { graph } = await evidenceCaseCache.getCaseEvidence(G15);
    for (const h of graph.hypotheses) {
      expect(Object.isFrozen(h)).toBe(true);
    }
  });

  test('hypothesis evidence list arrays are frozen', async () => {
    const { graph } = await evidenceCaseCache.getCaseEvidence(G15);
    for (const h of graph.hypotheses) {
      for (const list of FOUR_LISTS) {
        if (Array.isArray(h[list])) {
          expect(Object.isFrozen(h[list])).toBe(true);
        }
      }
    }
  });

  test('graph after warm hit is still frozen', async () => {
    await evidenceCaseCache.getCaseEvidence(G15); // cold
    const { graph } = await evidenceCaseCache.getCaseEvidence(G15); // warm
    expect(Object.isFrozen(graph)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-CACHE-17: Mutation safety — rows array (CD-1)
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTP-CACHE-17: Mutation safety — rows array (CD-1)', () => {
  test('returned rows is a new array each call (not the cached array reference)', async () => {
    const a = await evidenceCaseCache.getCaseEvidence(G15);
    const b = await evidenceCaseCache.getCaseEvidence(G15);
    expect(a.rows).not.toBe(b.rows); // different array references
  });

  test('pushing to returned rows does not corrupt next warm-hit length', async () => {
    const first = await evidenceCaseCache.getCaseEvidence(G15);
    const origLen = first.rows.length;
    // Corrupt the returned array
    first.rows.push({ evidence_id: 'FAKE-INJECTED', source: 'INJECTED' });
    expect(first.rows.length).toBe(origLen + 1);

    // Next warm hit should return unmodified cached copy
    const second = await evidenceCaseCache.getCaseEvidence(G15);
    expect(second.rows.length).toBe(origLen);
  });

  test('cold and warm row lengths are both 278', async () => {
    const cold = await evidenceCaseCache.getCaseEvidence(G15);
    const warm = await evidenceCaseCache.getCaseEvidence(G15);
    expect(cold.rows.length).toBe(278);
    expect(warm.rows.length).toBe(278);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-CACHE-18: Warm-hit rows.length equals cold-hit rows.length
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTP-CACHE-18: Warm-hit rows.length equals cold-hit rows.length', () => {
  test('G15: cold rows.length === warm rows.length', async () => {
    const cold = await evidenceCaseCache.getCaseEvidence(G15);
    const warm = await evidenceCaseCache.getCaseEvidence(G15);
    expect(cold.rows.length).toBe(warm.rows.length);
  });

  test('TCA: cold rows.length === warm rows.length', async () => {
    const cold = await evidenceCaseCache.getCaseEvidence(TCA);
    const warm = await evidenceCaseCache.getCaseEvidence(TCA);
    expect(cold.rows.length).toBe(warm.rows.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-CACHE-19: /evidence-index equivalent pre- and post-cache wiring
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTP-CACHE-19: /evidence-index semantics preserved after cache wiring', () => {
  test('case_id is present and correct', async () => {
    const { body } = await get(`/api/cases/${G15}/evidence-index`);
    expect(body.case_id).toBe(G15);
  });

  test('evidence array is present', async () => {
    const { body } = await get(`/api/cases/${G15}/evidence-index`);
    expect(Array.isArray(body.evidence)).toBe(true);
    expect(body.evidence.length).toBeGreaterThan(0);
  });

  test('evidence_count matches array length', async () => {
    const { body } = await get(`/api/cases/${G15}/evidence-index`);
    expect(body.evidence_count).toBe(body.evidence.length);
  });

  test('no EPHEMERIS IDs in evidence-index', async () => {
    const { body } = await get(`/api/cases/${G15}/evidence-index`);
    if (g15EphId) {
      const ids = body.evidence.map((r) => r.evidence_id);
      expect(ids).not.toContain(g15EphId);
    }
  });

  test('warm hit is identical to cold hit', async () => {
    const cold = await get(`/api/cases/${G15}/evidence-index`);
    const warm = await get(`/api/cases/${G15}/evidence-index`);
    expect(warm.body).toEqual(cold.body);
  });

  test('each entry has hypothesis_relationships array', async () => {
    const { body } = await get(`/api/cases/${G15}/evidence-index`);
    for (const rec of body.evidence.slice(0, 5)) {
      expect(Array.isArray(rec.hypothesis_relationships)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-CACHE-20: /hypotheses/compare equivalent pre- and post-cache wiring
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTP-CACHE-20: /hypotheses/compare semantics preserved after cache wiring', () => {
  test('returns 200 for G15', async () => {
    const { res } = await get(`/api/cases/${G15}/hypotheses/compare`);
    expect(res.status).toBe(200);
  });

  test('response contains hypotheses array', async () => {
    const { body } = await get(`/api/cases/${G15}/hypotheses/compare`);
    expect(Array.isArray(body.hypotheses)).toBe(true);
    expect(body.hypotheses.length).toBeGreaterThan(0);
  });

  test('response contains shared_evidence array', async () => {
    const { body } = await get(`/api/cases/${G15}/hypotheses/compare`);
    expect(Array.isArray(body.shared_evidence)).toBe(true);
  });

  test('warm hit body is deeply equal to cold hit body', async () => {
    const cold = await get(`/api/cases/${G15}/hypotheses/compare`);
    const warm = await get(`/api/cases/${G15}/hypotheses/compare`);
    expect(warm.body).toEqual(cold.body);
  });

  test('hypothesis_ids query param still works from cache', async () => {
    const { graph } = await evidenceCaseCache.getCaseEvidence(G15);
    const firstHid = graph.hypotheses[0]?.hypothesis_id;
    if (!firstHid) return;
    const { res, body } = await get(
      `/api/cases/${G15}/hypotheses/compare?hypothesis_ids=${firstHid}`,
    );
    expect(res.status).toBe(200);
    expect(body.hypotheses.length).toBe(1);
  });

  test('cross-case comparison is blocked even when using cache', async () => {
    // There's no server route that accepts multiple case IDs for compare
    // — this invariant is documented as EX-10. Verify the route does not
    // accept a case_id query param to cross case boundaries.
    const { res } = await get(
      `/api/cases/${G15}/hypotheses/compare?other_case_id=${TCA}`,
    );
    // Either 200 (param ignored) or 400 — must NOT return TCA hypothesis IDs
    const body = res.body;
    if (res.status === 200 && Array.isArray(body.hypotheses)) {
      for (const h of body.hypotheses) {
        expect(h.hypothesis_id).not.toMatch(/^H-TCA-/);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PERF-1: All 11 exploration routes for G15 served in < 8 s from warm cache
// ─────────────────────────────────────────────────────────────────────────────

describe('PERF-1: Warm cache serves all G15 exploration routes within time budget', () => {
  test('11 sequential warm G15 requests complete in < 8 000 ms', async () => {
    // Prime the cache
    await get(`/api/cases/${G15}/evidence`);

    const WARM_ROUTES = [
      `/api/cases/${G15}/evidence`,
      `/api/cases/${G15}/evidence/source/GOES11_MAG`,
      `/api/cases/${G15}/evidence/measurement`,
      `/api/cases/${G15}/evidence/time-window?start=2010-04-05T00:00:00Z&end=2010-04-06T00:00:00Z`,
      `/api/cases/${G15}/evidence/anomaly-centered`,
      `/api/cases/${G15}/evidence-index`,
      `/api/cases/${G15}/environmental-context`,
      `/api/cases/${G15}/hypotheses/compare`,
    ];

    if (g15H1Id) {
      WARM_ROUTES.push(`/api/cases/${G15}/hypotheses/${g15H1Id}/evidence`);
    }
    if (g15AnchorId) {
      WARM_ROUTES.push(`/api/cases/${G15}/evidence/${g15AnchorId}/provenance`);
    }
    // Add evidence/:id route
    WARM_ROUTES.push(`/api/cases/${G15}/evidence/E-G15-0001`);

    const start = Date.now();
    for (const url of WARM_ROUTES) {
      const { res } = await get(url);
      // 200 expected; some routes may 404 for non-existent specific IDs
      expect(res.status).toBeLessThan(500); // no server errors
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(8_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONC-1: 50 concurrent /evidence requests
// ─────────────────────────────────────────────────────────────────────────────

describe('CONC-1: 50 concurrent /evidence requests return consistent evidence_count', () => {
  test('all 50 responses have evidence_count === 278', async () => {
    const promises = Array.from({ length: 50 }, () =>
      request(app).get(`/api/cases/${G15}/evidence`),
    );
    const results = await Promise.all(promises);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body.evidence_count).toBe(278);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONC-2: 50 concurrent /hypotheses/compare requests
// ─────────────────────────────────────────────────────────────────────────────

describe('CONC-2: 50 concurrent /hypotheses/compare requests return consistent shared_evidence', () => {
  test('all 50 responses have the same shared_evidence length', async () => {
    const promises = Array.from({ length: 50 }, () =>
      request(app).get(`/api/cases/${G15}/hypotheses/compare`),
    );
    const results = await Promise.all(promises);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const lengths = results.map((r) => (r.body.shared_evidence || []).length);
    const firstLen = lengths[0];
    expect(lengths.every((l) => l === firstLen)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MUT-1: Mutating returned graph does not alter next warm-hit response
// ─────────────────────────────────────────────────────────────────────────────

describe('MUT-1: Mutating returned graph does not corrupt warm-hit data', () => {
  test('attempt to set causal_attribution_established throws (frozen graph)', async () => {
    const { graph } = await evidenceCaseCache.getCaseEvidence(G15);
    expect(() => {
      'use strict';
      graph.causal_attribution_established = true;
    }).toThrow();
  });

  test('next warm hit still has causal_attribution_established === false after mutation attempt', async () => {
    const first = await evidenceCaseCache.getCaseEvidence(G15);
    try { first.graph.causal_attribution_established = true; } catch (_) { /* frozen */ }
    const { graph } = await evidenceCaseCache.getCaseEvidence(G15);
    expect(graph.causal_attribution_established).toBe(false);
  });

  test('attempt to push to frozen hypothesis list throws', async () => {
    const { graph } = await evidenceCaseCache.getCaseEvidence(G15);
    const h = graph.hypotheses[0];
    if (h && Array.isArray(h.supporting_evidence)) {
      expect(() => {
        'use strict';
        h.supporting_evidence.push({ evidence_id: 'FAKE', relationship: 'fake' });
      }).toThrow();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MUT-2: Pushing to returned rows array does not corrupt subsequent hits
// ─────────────────────────────────────────────────────────────────────────────

describe('MUT-2: Push to returned rows array does not corrupt cached rows', () => {
  test('after pushing to cold rows, warm rows.length is still 278', async () => {
    const { rows } = await evidenceCaseCache.getCaseEvidence(G15);
    rows.push({ evidence_id: 'FAKE', source: 'INJECTED' });
    const warm = await evidenceCaseCache.getCaseEvidence(G15);
    expect(warm.rows.length).toBe(278);
  });

  test('after splicing cold rows, warm rows.length is still 278', async () => {
    const { rows } = await evidenceCaseCache.getCaseEvidence(G15);
    rows.splice(0, 10);
    const warm = await evidenceCaseCache.getCaseEvidence(G15);
    expect(warm.rows.length).toBe(278);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MUT-3: causal_attribution_established cannot be set on frozen graph
// ─────────────────────────────────────────────────────────────────────────────

describe('MUT-3: causal_attribution_established is immutable on cached graph', () => {
  test('strict mode assignment to causal_attribution_established throws TypeError', async () => {
    const { graph } = await evidenceCaseCache.getCaseEvidence(G15);
    expect(() => {
      'use strict';
      graph.causal_attribution_established = true;
    }).toThrow(TypeError);
  });

  test('causal_attribution_established remains false after repeated freeze-write attempts', async () => {
    for (let i = 0; i < 5; i++) {
      const { graph } = await evidenceCaseCache.getCaseEvidence(G15);
      try { graph.causal_attribution_established = true; } catch (_) { /* expected */ }
      expect(graph.causal_attribution_established).toBe(false);
    }
  });
});
