'use strict';

/**
 * Phase 9.2 — Complete HTTP Integration Coverage
 *
 * Real HTTP-level integration tests (via supertest against the live app) for:
 *
 *   1. GET  /api/cases/:id/evidence/:evidenceId/provenance
 *   2. POST /api/cases/:id/investigate
 *   3. POST /api/cases/:id/challenge
 *
 * And the persistence-path routes that implement investigation/challenge workflow:
 *
 *   4. POST /api/cases/:id/investigations
 *   5. POST /api/cases/:id/investigations/:iid/challenges
 *
 * Coverage areas:
 *   - Successful 200/201 responses
 *   - Unknown-case 404 with full { error_code, error, status_code } contract
 *   - Unknown-evidence 404 for provenance
 *   - Malformed / missing POST payload validation (422)
 *   - No leakage of filesystem paths, stack traces, credentials, or internal
 *     implementation details through any error response
 *   - Investigation + challenge persistence semantics against the repository
 *     abstraction (create → retrieve → list → case-scoped isolation)
 *   - Test isolation between cases (galaxy-15 vs test-case-alpha)
 *
 * Scientific invariants upheld:
 *   - causal_attribution_established is never altered by investigate / challenge
 *   - Deterministic forensic assessments are not mutated by any of these routes
 *   - No evidence rows are mutated (timeline row count and order is unchanged)
 *   - No fabricated evidence IDs are introduced
 *
 * All tests use the real HTTP application and NO direct function calls are
 * substituted for HTTP calls.  Existing tests are not modified or weakened.
 */

const request          = require('supertest');
const { app, parseEvidenceCSV, buildEvidenceGraph } = require('../server');
const { investigationStore } = require('../server');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const G15  = 'galaxy-15';
const TCA  = 'test-case-alpha';
const NONE = 'no-such-case-phase92';

const UNKNOWN_EVIDENCE_ID  = 'E-G15-ZZZZ';
const G15_EVIDENCE_ID_RE   = /^E-G15-\d{4}$/;
const TCA_EVIDENCE_ID_RE   = /^E-TCA-\d{4}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture — parsed once; re-used across multiple suites.
// ─────────────────────────────────────────────────────────────────────────────

let g15Rows;
let g15Graph;
let anchorId;       // evidence_id of the single CASE source row
let ephemerisId;    // evidence_id of the first GOES11_EPHEMERIS row
let ep8WindowId;    // evidence_id of first EP8 environmental_context ref

beforeAll(async () => {
  jest.setTimeout(60_000);
  g15Rows  = await parseEvidenceCSV(G15);
  g15Graph = await buildEvidenceGraph(G15, g15Rows);

  anchorId    = g15Rows.find((r) => r.source === 'CASE').evidence_id;
  ephemerisId = g15Rows.find((r) => r.source === 'GOES11_EPHEMERIS').evidence_id;

  for (const h of g15Graph.hypotheses) {
    if ((h.environmental_context || []).length > 0) {
      ep8WindowId = h.environmental_context[0].evidence_id;
      break;
    }
  }
}, 60_000);

// Reset investigation store before each test so state never leaks between tests.
beforeEach(() => { investigationStore._reset(); });

// ─────────────────────────────────────────────────────────────────────────────
// Shared assertion helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assert full { error_code, error, status_code } shape from the Phase 5.3 contract.
 */
function assertErrorContract(body, expectedCode, expectedHttpStatus) {
  expect(typeof body.error_code).toBe('string');
  expect(body.error_code.length).toBeGreaterThan(0);
  expect(body.error_code).toBe(expectedCode);
  expect(typeof body.error).toBe('string');
  expect(body.error.length).toBeGreaterThan(0);
  expect(typeof body.status_code).toBe('number');
  expect(body.status_code).toBe(expectedHttpStatus);
}

/**
 * Assert that no internal implementation details are present in the response body.
 * Checks for stack traces, absolute filesystem paths, and credentials.
 */
function assertNoLeakage(body) {
  const text = JSON.stringify(body);
  // No stack-trace markers
  expect(text).not.toMatch(/at Object\.|at async |at Function\./);
  // No absolute filesystem paths
  expect(text).not.toMatch(/\/Users\/|\/home\/|\/var\/|C:\\|\\backend\\/);
  // No credential-like strings
  expect(text).not.toMatch(/API_KEY|api_key|SECRET|password/i);
  // No SQL text
  expect(text).not.toMatch(/SELECT \*|INSERT INTO|UPDATE |DELETE FROM/i);
  // No raw violation arrays from ForensicAnalysisValidationError
  expect(body).not.toHaveProperty('violations');
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers for creating investigations/challenges via HTTP
// ─────────────────────────────────────────────────────────────────────────────

async function httpCreateInvestigation(caseId, overrides = {}) {
  return request(app)
    .post(`/api/cases/${caseId}/investigations`)
    .send({
      title:     overrides.title     || 'Phase 9.2 test investigation',
      opened_by: overrides.opened_by || 'test-analyst',
    });
}

async function httpCreateChallenge(caseId, iid, overrides = {}) {
  return request(app)
    .post(`/api/cases/${caseId}/investigations/${iid}/challenges`)
    .send({
      target_type:       overrides.target_type       || 'hypothesis_assessment',
      target_id:         overrides.target_id         || 'H1',
      analyst_statement: overrides.analyst_statement || 'The available evidence is ambiguous on this point.',
      authored_by:       overrides.authored_by       || 'test-analyst',
      evidence_ids:      overrides.evidence_ids      || [],
    });
}

// =============================================================================
// SECTION 1 — GET /api/cases/:id/evidence/:evidenceId/provenance
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// 1A. Full error-contract shape on unknown case
// ─────────────────────────────────────────────────────────────────────────────

describe('P92-PROV-1: provenance unknown-case error contract', () => {
  let res;

  beforeAll(async () => {
    res = await request(app).get(
      `/api/cases/${NONE}/evidence/E-G15-0001/provenance`,
    );
  });

  test('P92-PROV-1-1: returns HTTP 404 for unknown case', () => {
    expect(res.status).toBe(404);
  });

  test('P92-PROV-1-2: body has full { error_code, error, status_code } contract', () => {
    assertErrorContract(res.body, 'CASE_NOT_FOUND', 404);
  });

  test('P92-PROV-1-3: error message contains the unknown case ID', () => {
    expect(res.body.error).toContain(NONE);
  });

  test('P92-PROV-1-4: error response does not leak internal details', () => {
    assertNoLeakage(res.body);
  });

  test('P92-PROV-1-5: response does not contain found, evidence_id, or evidence fields', () => {
    expect(res.body).not.toHaveProperty('found');
    expect(res.body).not.toHaveProperty('timestamp');
    expect(res.body).not.toHaveProperty('hypothesis_relationships');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1B. Full error-contract shape on unknown evidence ID (known case)
// ─────────────────────────────────────────────────────────────────────────────

describe('P92-PROV-2: provenance unknown-evidence error contract', () => {
  let res;

  beforeAll(async () => {
    res = await request(app).get(
      `/api/cases/${G15}/evidence/${UNKNOWN_EVIDENCE_ID}/provenance`,
    );
  });

  test('P92-PROV-2-1: returns HTTP 404 for unknown evidence ID', () => {
    expect(res.status).toBe(404);
  });

  test('P92-PROV-2-2: body has error_code EVIDENCE_NOT_FOUND', () => {
    expect(res.body.error_code).toBe('EVIDENCE_NOT_FOUND');
  });

  test('P92-PROV-2-3: body has status_code 404', () => {
    expect(res.body.status_code).toBe(404);
  });

  test('P92-PROV-2-4: found is false', () => {
    expect(res.body.found).toBe(false);
  });

  test('P92-PROV-2-5: evidence_id echoes the queried ID', () => {
    expect(res.body.evidence_id).toBe(UNKNOWN_EVIDENCE_ID);
  });

  test('P92-PROV-2-6: reason field is a non-empty string', () => {
    expect(typeof res.body.reason).toBe('string');
    expect(res.body.reason.length).toBeGreaterThan(0);
  });

  test('P92-PROV-2-7: response does not contain evidence row fields', () => {
    expect(res.body).not.toHaveProperty('timestamp');
    expect(res.body).not.toHaveProperty('source');
    expect(res.body).not.toHaveProperty('measurement');
  });

  test('P92-PROV-2-8: error response does not leak internal details', () => {
    assertNoLeakage(res.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1C. Successful provenance response (anchor record)
// ─────────────────────────────────────────────────────────────────────────────

describe('P92-PROV-3: provenance successful response — anchor record', () => {
  let res;

  beforeAll(async () => {
    res = await request(app).get(
      `/api/cases/${G15}/evidence/${anchorId}/provenance`,
    );
  });

  test('P92-PROV-3-1: returns HTTP 200', () => {
    expect(res.status).toBe(200);
  });

  test('P92-PROV-3-2: found is true', () => {
    expect(res.body.found).toBe(true);
  });

  test('P92-PROV-3-3: successful response does NOT carry error_code or status_code', () => {
    expect(res.body).not.toHaveProperty('error_code');
    expect(res.body).not.toHaveProperty('status_code');
    expect(res.body).not.toHaveProperty('error');
  });

  test('P92-PROV-3-4: all 12 evidence fields are present', () => {
    const fields = [
      'evidence_id', 'timestamp', 'source', 'measurement',
      'value', 'unit', 'resolution', 'dataset_id',
      'provider', 'variable', 'evidence_type', 'quality',
    ];
    for (const f of fields) {
      expect(res.body).toHaveProperty(f);
    }
  });

  test('P92-PROV-3-5: hypothesis_relationships is a non-empty array', () => {
    expect(Array.isArray(res.body.hypothesis_relationships)).toBe(true);
    expect(res.body.hypothesis_relationships.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1D. Test isolation — provenance for TCA (separate case)
// ─────────────────────────────────────────────────────────────────────────────

describe('P92-PROV-4: provenance test-case-alpha isolation', () => {
  let tcaRows;
  let tcaAnchorId;

  beforeAll(async () => {
    tcaRows     = await parseEvidenceCSV(TCA);
    tcaAnchorId = tcaRows.find((r) => r.source === 'CASE').evidence_id;
  }, 30_000);

  test('P92-PROV-4-1: TCA anchor provenance returns 200', async () => {
    const res = await request(app).get(
      `/api/cases/${TCA}/evidence/${tcaAnchorId}/provenance`,
    );
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
  });

  test('P92-PROV-4-2: TCA evidence IDs are NOT found under galaxy-15', async () => {
    const tcaEvId = tcaRows[0].evidence_id;  // first row is always TCA-scoped
    const res = await request(app).get(
      `/api/cases/${G15}/evidence/${tcaEvId}/provenance`,
    );
    // The ID pattern is E-TCA-* so it will not exist in G15 rows
    expect(res.status).toBe(404);
    expect(res.body.found).toBe(false);
  });

  test('P92-PROV-4-3: G15 evidence IDs are NOT found under test-case-alpha', async () => {
    const res = await request(app).get(
      `/api/cases/${TCA}/evidence/${anchorId}/provenance`,
    );
    // G15 anchor is E-G15-*, absent from TCA
    expect(res.status).toBe(404);
    expect(res.body.found).toBe(false);
  });
});

// =============================================================================
// SECTION 2 — POST /api/cases/:id/investigate
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// 2A. Full error-contract shape on unknown case
// ─────────────────────────────────────────────────────────────────────────────

describe('P92-INV-1: investigate unknown-case error contract', () => {
  let res;

  beforeAll(async () => {
    res = await request(app).post(`/api/cases/${NONE}/investigate`);
  });

  test('P92-INV-1-1: returns HTTP 404', () => {
    expect(res.status).toBe(404);
  });

  test('P92-INV-1-2: body has full { error_code, error, status_code } contract', () => {
    assertErrorContract(res.body, 'CASE_NOT_FOUND', 404);
  });

  test('P92-INV-1-3: error message contains the unknown case ID', () => {
    expect(res.body.error).toContain(NONE);
  });

  test('P92-INV-1-4: error response does not leak internal details', () => {
    assertNoLeakage(res.body);
  });

  test('P92-INV-1-5: response does not contain hypotheses or any AI output fields', () => {
    expect(res.body).not.toHaveProperty('hypotheses');
    expect(res.body).not.toHaveProperty('top_hypothesis_id');
    expect(res.body).not.toHaveProperty('source');
    expect(res.body).not.toHaveProperty('generated_at');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2B. Malformed POST payload — /investigate ignores the body but must not
//     crash when given invalid JSON or a JSON body with unexpected keys.
// ─────────────────────────────────────────────────────────────────────────────

describe('P92-INV-2: investigate malformed/unexpected POST payload', () => {
  test('P92-INV-2-1: sending non-JSON body still returns 200 (route takes no body)', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigate`)
      .set('Content-Type', 'text/plain')
      .send('this is not json');
    // /investigate does not read the body; result is still 200
    expect(res.status).toBe(200);
  });

  test('P92-INV-2-2: sending unexpected JSON keys is harmless — still returns 200', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigate`)
      .send({ completely: 'irrelevant', fields: 42 });
    expect(res.status).toBe(200);
  });

  test('P92-INV-2-3: sending malformed JSON (body parser drops it) returns 200 for known case', async () => {
    // Express body-parser silently ignores non-JSON when Content-Type is absent;
    // test the resilience for a known case.
    const res = await request(app)
      .post(`/api/cases/${G15}/investigate`)
      .set('Content-Type', 'application/json')
      .send('{ invalid json }');
    // Express returns 400 for a hard JSON parse failure
    expect([200, 400]).toContain(res.status);
    // If 400, must not leak paths or stacks
    if (res.status === 400) {
      assertNoLeakage(res.body);
    }
  });

  test('P92-INV-2-4: sending malformed JSON to unknown case returns 400 or 404 with no leakage', async () => {
    const res = await request(app)
      .post(`/api/cases/${NONE}/investigate`)
      .set('Content-Type', 'application/json')
      .send('{ invalid json }');
    // The body parse happens before the route; may get 400 (parse error) or 404 (case guard)
    expect([400, 404]).toContain(res.status);
    assertNoLeakage(res.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2C. Successful response and scientific invariants
// ─────────────────────────────────────────────────────────────────────────────

describe('P92-INV-3: investigate successful response — scientific invariants', () => {
  let res;
  let body;

  beforeAll(async () => {
    res  = await request(app).post(`/api/cases/${G15}/investigate`);
    body = res.body;
  }, 30_000);

  test('P92-INV-3-1: returns HTTP 200', () => {
    expect(res.status).toBe(200);
  });

  test('P92-INV-3-2: successful response does NOT carry error_code, status_code, or error', () => {
    expect(body).not.toHaveProperty('error_code');
    expect(body).not.toHaveProperty('status_code');
    expect(body).not.toHaveProperty('error');
  });

  test('P92-INV-3-3: does not assert causal_attribution_established (scientific model untouched)', () => {
    expect(body).not.toHaveProperty('causal_attribution_established');
  });

  test('P92-INV-3-4: forensic analysis causal_attribution_established remains false after /investigate', async () => {
    const fa = await request(app).get(`/api/cases/${G15}/forensic-analysis`);
    expect(fa.status).toBe(200);
    expect(fa.body.causal_attribution_established).toBe(false);
  }, 30_000);

  test('P92-INV-3-5: deterministic forensic assessments are unchanged after /investigate', async () => {
    const fa = await request(app).get(`/api/cases/${G15}/forensic-analysis`);
    const assessments = Object.fromEntries(
      fa.body.hypotheses.map((h) => [h.hypothesis_id, h.assessment]),
    );
    expect(assessments.H1).toBe('mixed');
    expect(assessments.H2).toBe('mixed');
    expect(assessments.H3).toBe('supported');
    expect(assessments.H4).toBe('insufficient_evidence');
    expect(assessments.H5).toBe('strongly_supported');
  }, 30_000);

  test('P92-INV-3-6: timeline row count is unchanged — source evidence is not mutated', async () => {
    const tl = await request(app).get(`/api/cases/${G15}/timeline`);
    expect(tl.status).toBe(200);
    expect(tl.body).toHaveLength(278);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2D. Case isolation for /investigate
// ─────────────────────────────────────────────────────────────────────────────

describe('P92-INV-4: investigate case isolation', () => {
  test('P92-INV-4-1: /investigate for test-case-alpha returns 200', async () => {
    const res = await request(app).post(`/api/cases/${TCA}/investigate`);
    expect(res.status).toBe(200);
  });

  test('P92-INV-4-2: TCA /investigate response carries TCA-scoped evidence IDs only', async () => {
    const res   = await request(app).post(`/api/cases/${TCA}/investigate`);
    const text  = JSON.stringify(res.body);
    const ids   = [...text.matchAll(/E-[A-Z0-9]+-\d{4}/g)].map((m) => m[0]);
    for (const id of ids) {
      // All evidence IDs must belong to TCA, not G15
      expect(id).not.toMatch(/^E-G15-/);
      expect(id).toMatch(TCA_EVIDENCE_ID_RE);
    }
  });

  test('P92-INV-4-3: G15 /investigate response carries G15-scoped evidence IDs only', async () => {
    const res  = await request(app).post(`/api/cases/${G15}/investigate`);
    const text = JSON.stringify(res.body);
    const ids  = [...text.matchAll(/E-[A-Z0-9]+-\d{4}/g)].map((m) => m[0]);
    for (const id of ids) {
      expect(id).not.toMatch(/^E-TCA-/);
      expect(id).toMatch(G15_EVIDENCE_ID_RE);
    }
  });
});

// =============================================================================
// SECTION 3 — POST /api/cases/:id/challenge
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// 3A. Full error-contract shape on unknown case
// ─────────────────────────────────────────────────────────────────────────────

describe('P92-CHL-1: challenge unknown-case error contract', () => {
  let res;

  beforeAll(async () => {
    res = await request(app).post(`/api/cases/${NONE}/challenge`);
  });

  test('P92-CHL-1-1: returns HTTP 404', () => {
    expect(res.status).toBe(404);
  });

  test('P92-CHL-1-2: body has full { error_code, error, status_code } contract', () => {
    assertErrorContract(res.body, 'CASE_NOT_FOUND', 404);
  });

  test('P92-CHL-1-3: error message contains the unknown case ID', () => {
    expect(res.body.error).toContain(NONE);
  });

  test('P92-CHL-1-4: error response does not leak internal details', () => {
    assertNoLeakage(res.body);
  });

  test('P92-CHL-1-5: response does not contain challenges, updated_hypotheses, or pass1_hypotheses', () => {
    expect(res.body).not.toHaveProperty('challenges');
    expect(res.body).not.toHaveProperty('updated_hypotheses');
    expect(res.body).not.toHaveProperty('pass1_hypotheses');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3B. Malformed POST payload — /challenge ignores body; resilience tests
// ─────────────────────────────────────────────────────────────────────────────

describe('P92-CHL-2: challenge malformed/unexpected POST payload', () => {
  test('P92-CHL-2-1: sending non-JSON body returns 200 for known case (route takes no body)', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/challenge`)
      .set('Content-Type', 'text/plain')
      .send('this is not json');
    expect(res.status).toBe(200);
  });

  test('P92-CHL-2-2: sending unexpected JSON keys is harmless — still returns 200', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/challenge`)
      .send({ unexpected: 'key', with: 'value' });
    expect(res.status).toBe(200);
  });

  test('P92-CHL-2-3: malformed JSON for unknown case returns 400 or 404 with no leakage', async () => {
    const res = await request(app)
      .post(`/api/cases/${NONE}/challenge`)
      .set('Content-Type', 'application/json')
      .send('{ invalid json }');
    expect([400, 404]).toContain(res.status);
    assertNoLeakage(res.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3C. Successful response and scientific invariants
// ─────────────────────────────────────────────────────────────────────────────

describe('P92-CHL-3: challenge successful response — scientific invariants', () => {
  let res;
  let body;

  beforeAll(async () => {
    res  = await request(app).post(`/api/cases/${G15}/challenge`);
    body = res.body;
  }, 30_000);

  test('P92-CHL-3-1: returns HTTP 200', () => {
    expect(res.status).toBe(200);
  });

  test('P92-CHL-3-2: successful response does NOT carry error_code, status_code, or error', () => {
    expect(body).not.toHaveProperty('error_code');
    expect(body).not.toHaveProperty('status_code');
    expect(body).not.toHaveProperty('error');
  });

  test('P92-CHL-3-3: does not assert causal_attribution_established', () => {
    expect(body).not.toHaveProperty('causal_attribution_established');
  });

  test('P92-CHL-3-4: forensic causal_attribution_established remains false after /challenge', async () => {
    const fa = await request(app).get(`/api/cases/${G15}/forensic-analysis`);
    expect(fa.status).toBe(200);
    expect(fa.body.causal_attribution_established).toBe(false);
  }, 30_000);

  test('P92-CHL-3-5: deterministic assessments unchanged after /challenge', async () => {
    const fa = await request(app).get(`/api/cases/${G15}/forensic-analysis`);
    const assessments = Object.fromEntries(
      fa.body.hypotheses.map((h) => [h.hypothesis_id, h.assessment]),
    );
    expect(assessments.H1).toBe('mixed');
    expect(assessments.H3).toBe('supported');
    expect(assessments.H5).toBe('strongly_supported');
  }, 30_000);

  test('P92-CHL-3-6: timeline row count is unchanged — source evidence is not mutated', async () => {
    const tl = await request(app).get(`/api/cases/${G15}/timeline`);
    expect(tl.status).toBe(200);
    expect(tl.body).toHaveLength(278);
  });

  test('P92-CHL-3-7: case_id in response matches the request', () => {
    expect(body.case_id).toBe(G15);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3D. Case isolation for /challenge
// ─────────────────────────────────────────────────────────────────────────────

describe('P92-CHL-4: challenge case isolation', () => {
  test('P92-CHL-4-1: /challenge for test-case-alpha returns 200', async () => {
    const res = await request(app).post(`/api/cases/${TCA}/challenge`);
    expect(res.status).toBe(200);
  });

  test('P92-CHL-4-2: TCA /challenge case_id is "test-case-alpha"', async () => {
    const res = await request(app).post(`/api/cases/${TCA}/challenge`);
    expect(res.body.case_id).toBe(TCA);
  });

  test('P92-CHL-4-3: TCA /challenge response carries TCA-scoped evidence IDs only', async () => {
    const res  = await request(app).post(`/api/cases/${TCA}/challenge`);
    const text = JSON.stringify(res.body);
    const ids  = [...text.matchAll(/E-[A-Z0-9]+-\d{4}/g)].map((m) => m[0]);
    for (const id of ids) {
      expect(id).not.toMatch(/^E-G15-/);
      expect(id).toMatch(TCA_EVIDENCE_ID_RE);
    }
  });

  test('P92-CHL-4-4: G15 /challenge response carries G15-scoped evidence IDs only', async () => {
    const res  = await request(app).post(`/api/cases/${G15}/challenge`);
    const text = JSON.stringify(res.body);
    const ids  = [...text.matchAll(/E-[A-Z0-9]+-\d{4}/g)].map((m) => m[0]);
    for (const id of ids) {
      expect(id).not.toMatch(/^E-TCA-/);
      expect(id).toMatch(G15_EVIDENCE_ID_RE);
    }
  });
});

// =============================================================================
// SECTION 4 — POST /api/cases/:id/investigations (persistence route)
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// 4A. Successful creation and error-contract shape
// ─────────────────────────────────────────────────────────────────────────────

describe('P92-PERSIST-1: POST /investigations — successful creation', () => {
  let res;
  let body;

  beforeEach(async () => {
    res  = await httpCreateInvestigation(G15);
    body = res.body;
  });

  test('P92-PERSIST-1-1: returns HTTP 201', () => {
    expect(res.status).toBe(201);
  });

  test('P92-PERSIST-1-2: response carries investigation_id as UUID', () => {
    expect(typeof body.investigation_id).toBe('string');
    expect(body.investigation_id).toMatch(UUID_RE);
  });

  test('P92-PERSIST-1-3: response carries case_id matching the request', () => {
    expect(body.case_id).toBe(G15);
  });

  test('P92-PERSIST-1-4: initial status is "open"', () => {
    expect(body.status).toBe('open');
  });

  test('P92-PERSIST-1-5: title is stored from the request body', () => {
    expect(body.title).toBe('Phase 9.2 test investigation');
  });

  test('P92-PERSIST-1-6: opened_by is stored from the request body', () => {
    expect(body.opened_by).toBe('test-analyst');
  });

  test('P92-PERSIST-1-7: response is JSON', () => {
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  test('P92-PERSIST-1-8: successful response does NOT carry error_code or error', () => {
    expect(body).not.toHaveProperty('error_code');
    expect(body).not.toHaveProperty('error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4B. Unknown-case error contract for /investigations
// ─────────────────────────────────────────────────────────────────────────────

describe('P92-PERSIST-2: POST /investigations — unknown-case error contract', () => {
  let res;

  beforeAll(async () => {
    res = await httpCreateInvestigation(NONE);
  });

  test('P92-PERSIST-2-1: returns HTTP 404', () => {
    expect(res.status).toBe(404);
  });

  test('P92-PERSIST-2-2: body has full { error_code, error, status_code } contract', () => {
    assertErrorContract(res.body, 'CASE_NOT_FOUND', 404);
  });

  test('P92-PERSIST-2-3: error message contains the unknown case ID', () => {
    expect(res.body.error).toContain(NONE);
  });

  test('P92-PERSIST-2-4: error response does not leak internal details', () => {
    assertNoLeakage(res.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4C. Retrieval and persistence semantics
// ─────────────────────────────────────────────────────────────────────────────

describe('P92-PERSIST-3: investigation retrieve and list persistence semantics', () => {
  test('P92-PERSIST-3-1: created investigation is retrievable via GET', async () => {
    const createRes = await httpCreateInvestigation(G15);
    expect(createRes.status).toBe(201);
    const iid = createRes.body.investigation_id;

    const getRes = await request(app).get(`/api/cases/${G15}/investigations/${iid}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.investigation_id).toBe(iid);
    expect(getRes.body.case_id).toBe(G15);
  });

  test('P92-PERSIST-3-2: created investigation appears in the case list', async () => {
    const createRes = await httpCreateInvestigation(G15);
    const iid = createRes.body.investigation_id;

    const listRes = await request(app).get(`/api/cases/${G15}/investigations`);
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    const ids = listRes.body.map((i) => i.investigation_id);
    expect(ids).toContain(iid);
  });

  test('P92-PERSIST-3-3: G15 investigation does NOT appear in TCA list', async () => {
    const createRes = await httpCreateInvestigation(G15);
    const iid = createRes.body.investigation_id;

    const listRes = await request(app).get(`/api/cases/${TCA}/investigations`);
    expect(listRes.status).toBe(200);
    const ids = listRes.body.map((i) => i.investigation_id);
    expect(ids).not.toContain(iid);
  });

  test('P92-PERSIST-3-4: TCA investigation does NOT appear in G15 list', async () => {
    const createRes = await httpCreateInvestigation(TCA);
    const iid = createRes.body.investigation_id;

    const listRes = await request(app).get(`/api/cases/${G15}/investigations`);
    expect(listRes.status).toBe(200);
    const ids = listRes.body.map((i) => i.investigation_id);
    expect(ids).not.toContain(iid);
  });

  test('P92-PERSIST-3-5: GET on unknown investigation_id returns 404 with error contract', async () => {
    const res = await request(app).get(
      `/api/cases/${G15}/investigations/00000000-0000-4000-8000-000000000000`,
    );
    expect(res.status).toBe(404);
    assertErrorContract(res.body, 'INVESTIGATION_NOT_FOUND', 404);
    assertNoLeakage(res.body);
  });

  test('P92-PERSIST-3-6: GET on real investigation from wrong case returns 404', async () => {
    // Create under G15, try to fetch under TCA — must be rejected
    const createRes = await httpCreateInvestigation(G15);
    const iid = createRes.body.investigation_id;

    const res = await request(app).get(
      `/api/cases/${TCA}/investigations/${iid}`,
    );
    expect(res.status).toBe(404);
    assertErrorContract(res.body, 'INVESTIGATION_NOT_FOUND', 404);
  });

  test('P92-PERSIST-3-7: multiple investigations accumulate in list per case', async () => {
    await httpCreateInvestigation(G15, { title: 'Inv A' });
    await httpCreateInvestigation(G15, { title: 'Inv B' });
    await httpCreateInvestigation(G15, { title: 'Inv C' });

    const listRes = await request(app).get(`/api/cases/${G15}/investigations`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.length).toBeGreaterThanOrEqual(3);
    for (const inv of listRes.body) {
      expect(inv.case_id).toBe(G15);
    }
  });
});

// =============================================================================
// SECTION 5 — POST /api/cases/:id/investigations/:iid/challenges (persistence)
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// 5A. Successful creation and record shape
// ─────────────────────────────────────────────────────────────────────────────

describe('P92-CHLPERS-1: POST .../challenges — successful creation', () => {
  let invId;
  let res;
  let body;

  beforeEach(async () => {
    const invRes = await httpCreateInvestigation(G15);
    invId = invRes.body.investigation_id;
    res   = await httpCreateChallenge(G15, invId);
    body  = res.body;
  });

  test('P92-CHLPERS-1-1: returns HTTP 201', () => {
    expect(res.status).toBe(201);
  });

  test('P92-CHLPERS-1-2: response carries challenge_id as UUID', () => {
    expect(typeof body.challenge_id).toBe('string');
    expect(body.challenge_id).toMatch(UUID_RE);
  });

  test('P92-CHLPERS-1-3: response carries case_id matching the request', () => {
    expect(body.case_id).toBe(G15);
  });

  test('P92-CHLPERS-1-4: response carries investigation_id', () => {
    expect(body.investigation_id).toBe(invId);
  });

  test('P92-CHLPERS-1-5: initial challenge status is "open"', () => {
    expect(body.status).toBe('open');
  });

  test('P92-CHLPERS-1-6: response carries the submitted analyst_statement', () => {
    expect(body.analyst_statement).toBe('The available evidence is ambiguous on this point.');
  });

  test('P92-CHLPERS-1-7: response does NOT carry assessment (forensic field immutability)', () => {
    expect(body).not.toHaveProperty('assessment');
  });

  test('P92-CHLPERS-1-8: response does NOT carry causal_attribution_established', () => {
    expect(body).not.toHaveProperty('causal_attribution_established');
  });

  test('P92-CHLPERS-1-9: lifecycle array starts with one "open" entry', () => {
    expect(Array.isArray(body.lifecycle)).toBe(true);
    expect(body.lifecycle).toHaveLength(1);
    expect(body.lifecycle[0].status).toBe('open');
  });

  test('P92-CHLPERS-1-10: resolution_metadata is null on creation', () => {
    expect(body.resolution_metadata).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5B. Validation — malformed / missing required fields
// ─────────────────────────────────────────────────────────────────────────────

describe('P92-CHLPERS-2: POST .../challenges — payload validation', () => {
  let invId;

  beforeEach(async () => {
    const invRes = await httpCreateInvestigation(G15);
    invId = invRes.body.investigation_id;
  });

  test('P92-CHLPERS-2-1: missing target_type returns 422 with error contract', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${invId}/challenges`)
      .send({ target_id: 'H1', analyst_statement: 'Test statement.' });
    expect(res.status).toBe(422);
    assertErrorContract(res.body, 'VALIDATION_ERROR', 422);
    assertNoLeakage(res.body);
  });

  test('P92-CHLPERS-2-2: invalid target_type returns 422 with error contract', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${invId}/challenges`)
      .send({
        target_type:       'invalid_type_xyz',
        target_id:         'H1',
        analyst_statement: 'Test statement.',
      });
    expect(res.status).toBe(422);
    assertErrorContract(res.body, 'VALIDATION_ERROR', 422);
    assertNoLeakage(res.body);
  });

  test('P92-CHLPERS-2-3: missing target_id returns 422 with error contract', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${invId}/challenges`)
      .send({
        target_type:       'hypothesis_assessment',
        analyst_statement: 'Test statement.',
      });
    expect(res.status).toBe(422);
    assertErrorContract(res.body, 'VALIDATION_ERROR', 422);
    assertNoLeakage(res.body);
  });

  test('P92-CHLPERS-2-4: missing analyst_statement returns 422 with error contract', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${invId}/challenges`)
      .send({
        target_type: 'hypothesis_assessment',
        target_id:   'H1',
      });
    expect(res.status).toBe(422);
    assertErrorContract(res.body, 'VALIDATION_ERROR', 422);
    assertNoLeakage(res.body);
  });

  test('P92-CHLPERS-2-5: empty analyst_statement returns 422', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${invId}/challenges`)
      .send({
        target_type:       'hypothesis_assessment',
        target_id:         'H1',
        analyst_statement: '   ',
      });
    expect(res.status).toBe(422);
    assertErrorContract(res.body, 'VALIDATION_ERROR', 422);
  });

  test('P92-CHLPERS-2-6: probability claim in analyst_statement returns 422 with PROBABILITY_CLAIM_PROHIBITED', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${invId}/challenges`)
      .send({
        target_type:       'hypothesis_assessment',
        target_id:         'H1',
        analyst_statement: 'I believe there is a 75% probability this is ESD.',
      });
    expect(res.status).toBe(422);
    assertErrorContract(res.body, 'PROBABILITY_CLAIM_PROHIBITED', 422);
    assertNoLeakage(res.body);
  });

  test('P92-CHLPERS-2-7: setting assessment in body returns 422 with FORENSIC_FIELD_IMMUTABLE', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${invId}/challenges`)
      .send({
        target_type:       'hypothesis_assessment',
        target_id:         'H1',
        analyst_statement: 'Test.',
        assessment:        'supported',   // forbidden (CH-3, CH-7)
      });
    expect(res.status).toBe(422);
    assertErrorContract(res.body, 'FORENSIC_FIELD_IMMUTABLE', 422);
    assertNoLeakage(res.body);
  });

  test('P92-CHLPERS-2-8: setting causal_attribution_established in body returns 422', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${invId}/challenges`)
      .send({
        target_type:                    'hypothesis_assessment',
        target_id:                      'H1',
        analyst_statement:              'Test.',
        causal_attribution_established: true,  // forbidden (INV-4, CH-7)
      });
    expect(res.status).toBe(422);
    assertErrorContract(res.body, 'FORENSIC_FIELD_IMMUTABLE', 422);
    assertNoLeakage(res.body);
  });

  test('P92-CHLPERS-2-9: fabricated hypothesis_id returns 422 with INVALID_HYPOTHESIS_ID', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${invId}/challenges`)
      .send({
        target_type:       'hypothesis_assessment',
        target_id:         'H-FABRICATED-9999',
        analyst_statement: 'Testing fabricated ID.',
      });
    expect(res.status).toBe(422);
    assertErrorContract(res.body, 'INVALID_HYPOTHESIS_ID', 422);
    assertNoLeakage(res.body);
  });

  test('P92-CHLPERS-2-10: fabricated evidence_id in evidence_ids returns 422 with INVALID_EVIDENCE_ID', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${invId}/challenges`)
      .send({
        target_type:       'hypothesis_assessment',
        target_id:         'H1',
        analyst_statement: 'Testing fabricated supporting evidence.',
        evidence_ids:      ['E-G15-9999'],   // does not exist in CSV
      });
    expect(res.status).toBe(422);
    assertErrorContract(res.body, 'INVALID_EVIDENCE_ID', 422);
    assertNoLeakage(res.body);
  });

  test('P92-CHLPERS-2-11: fabricated evidence_id as classification target returns 422', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${invId}/challenges`)
      .send({
        target_type:       'evidence_classification',
        target_id:         'E-G15-9999',     // does not exist in CSV
        analyst_statement: 'Testing fabricated classification target.',
      });
    expect(res.status).toBe(422);
    assertErrorContract(res.body, 'INVALID_EVIDENCE_ID', 422);
    assertNoLeakage(res.body);
  });

  test('P92-CHLPERS-2-12: completely empty body returns 422', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${invId}/challenges`)
      .send({});
    expect(res.status).toBe(422);
    expect(res.body.error_code).toBe('VALIDATION_ERROR');
    assertNoLeakage(res.body);
  });

  test('P92-CHLPERS-2-13: no body at all returns 422', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/${invId}/challenges`);
    expect(res.status).toBe(422);
    expect(res.body.error_code).toBe('VALIDATION_ERROR');
    assertNoLeakage(res.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5C. Unknown-case and unknown-investigation error contracts
// ─────────────────────────────────────────────────────────────────────────────

describe('P92-CHLPERS-3: POST .../challenges — not-found error contracts', () => {
  test('P92-CHLPERS-3-1: unknown case returns 404 CASE_NOT_FOUND', async () => {
    const res = await request(app)
      .post(`/api/cases/${NONE}/investigations/00000000-0000-4000-8000-000000000000/challenges`)
      .send({
        target_type:       'hypothesis_assessment',
        target_id:         'H1',
        analyst_statement: 'Test.',
      });
    expect(res.status).toBe(404);
    assertErrorContract(res.body, 'CASE_NOT_FOUND', 404);
    assertNoLeakage(res.body);
  });

  test('P92-CHLPERS-3-2: unknown investigation returns 404 INVESTIGATION_NOT_FOUND', async () => {
    const res = await request(app)
      .post(`/api/cases/${G15}/investigations/00000000-0000-4000-8000-000000000000/challenges`)
      .send({
        target_type:       'hypothesis_assessment',
        target_id:         'H1',
        analyst_statement: 'Test.',
      });
    expect(res.status).toBe(404);
    assertErrorContract(res.body, 'INVESTIGATION_NOT_FOUND', 404);
    assertNoLeakage(res.body);
  });

  test('P92-CHLPERS-3-3: investigation from wrong case returns 404', async () => {
    // Create under G15, try to add challenge under TCA
    const invRes = await httpCreateInvestigation(G15);
    const iid = invRes.body.investigation_id;

    const res = await request(app)
      .post(`/api/cases/${TCA}/investigations/${iid}/challenges`)
      .send({
        target_type:       'hypothesis_assessment',
        target_id:         'H1',
        analyst_statement: 'Cross-case attempt.',
      });
    expect(res.status).toBe(404);
    assertErrorContract(res.body, 'INVESTIGATION_NOT_FOUND', 404);
    assertNoLeakage(res.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5D. Persistence semantics — created challenge is retrievable
// ─────────────────────────────────────────────────────────────────────────────

describe('P92-CHLPERS-4: challenge persistence semantics', () => {
  let invId;
  let challengeId;

  beforeEach(async () => {
    const invRes = await httpCreateInvestigation(G15);
    invId = invRes.body.investigation_id;
    const chlRes = await httpCreateChallenge(G15, invId);
    challengeId = chlRes.body.challenge_id;
  });

  test('P92-CHLPERS-4-1: created challenge is retrievable via GET', async () => {
    const res = await request(app).get(
      `/api/cases/${G15}/investigations/${invId}/challenges/${challengeId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.challenge_id).toBe(challengeId);
    expect(res.body.case_id).toBe(G15);
    expect(res.body.investigation_id).toBe(invId);
  });

  test('P92-CHLPERS-4-2: created challenge appears in investigation challenge list', async () => {
    const res = await request(app).get(
      `/api/cases/${G15}/investigations/${invId}/challenges`,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const ids = res.body.map((c) => c.challenge_id);
    expect(ids).toContain(challengeId);
  });

  test('P92-CHLPERS-4-3: challenge does NOT appear in list for a different investigation', async () => {
    const inv2Res = await httpCreateInvestigation(G15);
    const invId2  = inv2Res.body.investigation_id;

    const res = await request(app).get(
      `/api/cases/${G15}/investigations/${invId2}/challenges`,
    );
    expect(res.status).toBe(200);
    const ids = res.body.map((c) => c.challenge_id);
    expect(ids).not.toContain(challengeId);
  });

  test('P92-CHLPERS-4-4: challenge does NOT appear under a different case', async () => {
    // Create TCA investigation and list its challenges — G15 challenge absent
    const tcaInvRes = await httpCreateInvestigation(TCA);
    const tcaInvId  = tcaInvRes.body.investigation_id;
    await httpCreateChallenge(TCA, tcaInvId);

    const g15ListRes = await request(app).get(
      `/api/cases/${G15}/investigations/${invId}/challenges`,
    );
    const g15Ids = g15ListRes.body.map((c) => c.challenge_id);

    const tcaListRes = await request(app).get(
      `/api/cases/${TCA}/investigations/${tcaInvId}/challenges`,
    );
    const tcaIds = tcaListRes.body.map((c) => c.challenge_id);

    // No cross-contamination
    for (const gid of g15Ids) {
      expect(tcaIds).not.toContain(gid);
    }
    for (const tid of tcaIds) {
      expect(g15Ids).not.toContain(tid);
    }
  });

  test('P92-CHLPERS-4-5: case-level challenges endpoint includes the created challenge', async () => {
    const res = await request(app).get(`/api/cases/${G15}/challenges`);
    expect(res.status).toBe(200);
    expect(res.body.case_id).toBe(G15);
    expect(Array.isArray(res.body.challenges)).toBe(true);
    const ids = res.body.challenges.map((c) => c.challenge_id);
    expect(ids).toContain(challengeId);
  });

  test('P92-CHLPERS-4-6: G15 challenges do NOT appear in TCA case-level challenges', async () => {
    const tcaInvRes = await httpCreateInvestigation(TCA);
    await httpCreateChallenge(TCA, tcaInvRes.body.investigation_id);

    const g15Res = await request(app).get(`/api/cases/${G15}/challenges`);
    const tcaRes = await request(app).get(`/api/cases/${TCA}/challenges`);

    const g15Ids = g15Res.body.challenges.map((c) => c.challenge_id);
    const tcaIds = tcaRes.body.challenges.map((c) => c.challenge_id);

    // Each case's list is scoped correctly
    expect(g15Ids).toContain(challengeId);
    for (const tid of tcaIds) {
      expect(g15Ids).not.toContain(tid);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5E. Closed investigation rejects new challenges
// ─────────────────────────────────────────────────────────────────────────────

describe('P92-CHLPERS-5: closed investigation rejects new challenges', () => {
  test('P92-CHLPERS-5-1: challenge against closed investigation returns 409 INVESTIGATION_CLOSED', async () => {
    // Create investigation
    const invRes = await httpCreateInvestigation(G15);
    const iid    = invRes.body.investigation_id;

    // Close it via PATCH
    const closeRes = await request(app)
      .patch(`/api/cases/${G15}/investigations/${iid}`)
      .send({ status: 'closed', actor: 'test-analyst' });
    expect(closeRes.status).toBe(200);
    expect(closeRes.body.status).toBe('closed');

    // Attempt to add a challenge to the closed investigation
    const chlRes = await request(app)
      .post(`/api/cases/${G15}/investigations/${iid}/challenges`)
      .send({
        target_type:       'hypothesis_assessment',
        target_id:         'H1',
        analyst_statement: 'Should be rejected.',
      });
    expect(chlRes.status).toBe(409);
    assertErrorContract(chlRes.body, 'INVESTIGATION_CLOSED', 409);
    assertNoLeakage(chlRes.body);
  });
});

// =============================================================================
// SECTION 6 — Cross-cutting: no-leakage audit for all error paths
// =============================================================================

describe('P92-LEAK-1: no internal leakage across all error paths', () => {
  const errorPaths = [
    // Unknown case — provenance
    () => request(app).get(`/api/cases/${NONE}/evidence/E-G15-0001/provenance`),
    // Unknown evidence — provenance
    () => request(app).get(`/api/cases/${G15}/evidence/E-G15-ZZZZ/provenance`),
    // Unknown case — investigate
    () => request(app).post(`/api/cases/${NONE}/investigate`),
    // Unknown case — challenge
    () => request(app).post(`/api/cases/${NONE}/challenge`),
    // Unknown case — investigations list
    () => request(app).get(`/api/cases/${NONE}/investigations`),
    // Unknown case — create investigation
    () => request(app).post(`/api/cases/${NONE}/investigations`).send({ title: 'T' }),
    // Unknown investigation — get
    () => request(app).get(`/api/cases/${G15}/investigations/00000000-0000-4000-8000-000000000000`),
  ];

  test.each(errorPaths.map((fn, i) => [i, fn]))(
    'P92-LEAK-1-%i: error response does not leak internal details',
    async (_i, fn) => {
      const res = await fn();
      // Any error status (4xx/5xx) must have no leakage
      if (res.status >= 400) {
        assertNoLeakage(res.body);
      }
    },
  );
});
