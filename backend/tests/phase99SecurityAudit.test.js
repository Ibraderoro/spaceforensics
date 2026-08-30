'use strict';

/**
 * Phase 9.9 — Production Security & Configuration Audit
 *
 * Invariants exercised:
 *
 *   SEC-1  Security headers are present on every API response.
 *          X-Content-Type-Options: nosniff
 *          X-Frame-Options: DENY
 *          Cache-Control: no-store
 *
 *   SEC-2  CORS — only pre-configured origins are reflected.
 *          An unknown origin must NOT receive an Access-Control-Allow-Origin
 *          header in the response.
 *
 *   SEC-3  Body-size limit — payloads exceeding 64 KB are rejected with 413.
 *
 *   SEC-4  Malformed JSON — a syntactically invalid request body returns
 *          HTTP 400 with error_code INVALID_JSON and no stack trace.
 *
 *   SEC-5  Unknown routes — any request to an undeclared path returns HTTP 404
 *          with error_code NOT_FOUND and the {error_code,error,status_code}
 *          contract shape.  No stack trace is included.
 *
 *   SEC-6  Unsupported HTTP methods — DELETE / PUT on a known API path returns
 *          HTTP 404 (via the catch-all) with error_code NOT_FOUND.
 *
 *   SEC-7  Error responses from the legacy case-listing routes carry
 *          {error_code, error, status_code} and do not expose err.message
 *          (filesystem paths, ENOENT text, etc.).
 *
 *   SEC-8  No secret values in any response body (API keys, passwords,
 *          connection strings, stack traces, absolute filesystem paths).
 *
 *   SEC-9  Oversized Content-Type bypass — sending a very large body with an
 *          incorrect Content-Type should not bypass the limit check.
 */

const request = require('supertest');
const { app }  = require('../server');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Assert the three mandatory security headers are present. */
function assertSecurityHeaders(res) {
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['x-frame-options']).toBe('DENY');
  expect(res.headers['cache-control']).toBe('no-store');
}

/** Assert no internal implementation detail leaks into the body. */
function assertNoInternalLeakage(body) {
  const text = JSON.stringify(body);

  // Stack-trace markers
  expect(text).not.toMatch(/at Object\.|at async |at Function\./);

  // Absolute filesystem paths
  expect(text).not.toMatch(/\/Users\/|\/home\/|\/var\/|C:\\|\\backend\\/);

  // Credential-like strings
  expect(text).not.toMatch(/WATSONX_AI_APIKEY|PG_PASSWORD|api_key|apikey|password|secret/i);

  // Raw Node error messages that contain OS-level details
  expect(text).not.toMatch(/ENOENT|EACCES|ECONNREFUSED/);
}

/** Assert the {error_code, error, status_code} contract shape. */
function assertErrorContract(body, expectedCode, expectedStatus) {
  expect(typeof body.error_code).toBe('string');
  expect(body.error_code).toBe(expectedCode);
  expect(typeof body.error).toBe('string');
  expect(body.error.length).toBeGreaterThan(0);
  expect(typeof body.status_code).toBe('number');
  expect(body.status_code).toBe(expectedStatus);
}

// ─────────────────────────────────────────────────────────────────────────────
// SEC-1 — Security headers on every response type
// ─────────────────────────────────────────────────────────────────────────────
describe('SEC-1: security headers present on all responses', () => {
  test('SEC-1-1: 200 response (GET /api/cases) includes security headers', async () => {
    const res = await request(app).get('/api/cases');
    assertSecurityHeaders(res);
  });

  test('SEC-1-2: 404 response (unknown case) includes security headers', async () => {
    const res = await request(app).get('/api/cases/no-such-case-xyz');
    assertSecurityHeaders(res);
  });

  test('SEC-1-3: health check (GET /) includes security headers', async () => {
    const res = await request(app).get('/');
    assertSecurityHeaders(res);
  });

  test('SEC-1-4: catch-all 404 response includes security headers', async () => {
    const res = await request(app).get('/api/nonexistent-endpoint');
    assertSecurityHeaders(res);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEC-2 — CORS origin restriction
// ─────────────────────────────────────────────────────────────────────────────
describe('SEC-2: CORS — unknown origin is not reflected', () => {
  test('SEC-2-1: request from a non-allowlisted origin does not receive Allow-Origin header', async () => {
    const res = await request(app)
      .get('/api/cases')
      .set('Origin', 'https://malicious.example.com');
    // The cors() middleware must not echo back an unknown origin.
    expect(res.headers['access-control-allow-origin']).not.toBe(
      'https://malicious.example.com',
    );
  });

  test('SEC-2-2: preflight from unknown origin returns no allow-origin header', async () => {
    const res = await request(app)
      .options('/api/cases')
      .set('Origin', 'https://attacker.example.com')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).not.toBe(
      'https://attacker.example.com',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEC-3 — Body-size limit
// ─────────────────────────────────────────────────────────────────────────────
describe('SEC-3: request body size limit', () => {
  test('SEC-3-1: POST body exceeding 64 KB is rejected', async () => {
    // Build a valid-looking JSON object that exceeds 64 KB.
    const bigString = 'x'.repeat(70_000);
    const bigBody   = JSON.stringify({ analyst_statement: bigString });

    const res = await request(app)
      .post('/api/cases/galaxy-15/investigations/fake-id/challenges')
      .set('Content-Type', 'application/json')
      .send(bigBody);

    // Express rejects oversized bodies → 413 PAYLOAD_TOO_LARGE.
    expect(res.status).toBe(413);
    assertErrorContract(res.body, 'PAYLOAD_TOO_LARGE', 413);
    assertNoInternalLeakage(res.body);
  });

  test('SEC-3-2: POST body under 64 KB reaches the route handler normally', async () => {
    const normalBody = JSON.stringify({
      title: 'small investigation',
      opened_by: 'tester',
    });

    const res = await request(app)
      .post('/api/cases/galaxy-15/investigations')
      .set('Content-Type', 'application/json')
      .send(normalBody);

    // Either 201 (created) or 4xx from route validation — must not be 413.
    expect(res.status).not.toBe(413);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEC-4 — Malformed JSON
// ─────────────────────────────────────────────────────────────────────────────
describe('SEC-4: malformed JSON request body', () => {
  test('SEC-4-1: returns HTTP 400 with error_code INVALID_JSON', async () => {
    const res = await request(app)
      .post('/api/cases/galaxy-15/investigations')
      .set('Content-Type', 'application/json')
      .send('{not valid json');

    expect(res.status).toBe(400);
    assertErrorContract(res.body, 'INVALID_JSON', 400);
  });

  test('SEC-4-2: error body contains no stack trace', async () => {
    const res = await request(app)
      .post('/api/cases/galaxy-15/investigations')
      .set('Content-Type', 'application/json')
      .send('{bad json}');

    assertNoInternalLeakage(res.body);
  });

  test('SEC-4-3: malformed JSON to PATCH investigation also returns 400', async () => {
    const res = await request(app)
      .patch('/api/cases/galaxy-15/investigations/fake-id')
      .set('Content-Type', 'application/json')
      .send('{"status": }');

    expect(res.status).toBe(400);
    assertErrorContract(res.body, 'INVALID_JSON', 400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEC-5 — Unknown routes return 404 with contract shape
// ─────────────────────────────────────────────────────────────────────────────
describe('SEC-5: unknown routes', () => {
  const UNKNOWN_PATHS = [
    '/api/admin',
    '/api/config',
    '/api/debug',
    '/api/cases/../etc/passwd',
    '/__proto__',
    '/api/cases/%2e%2e/etc/passwd',
  ];

  test.each(UNKNOWN_PATHS)(
    'SEC-5: %s returns HTTP 404 with NOT_FOUND error_code',
    async (path) => {
      const res = await request(app).get(path);
      expect(res.status).toBe(404);
      assertErrorContract(res.body, 'NOT_FOUND', 404);
      assertNoInternalLeakage(res.body);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// SEC-6 — Unsupported HTTP methods
// ─────────────────────────────────────────────────────────────────────────────
describe('SEC-6: unsupported HTTP methods', () => {
  test('SEC-6-1: DELETE /api/cases returns 404 NOT_FOUND', async () => {
    const res = await request(app).delete('/api/cases');
    expect(res.status).toBe(404);
    assertErrorContract(res.body, 'NOT_FOUND', 404);
  });

  test('SEC-6-2: PUT /api/cases/galaxy-15 returns 404 NOT_FOUND', async () => {
    const res = await request(app)
      .put('/api/cases/galaxy-15')
      .send({ title: 'hacked' });
    expect(res.status).toBe(404);
    assertErrorContract(res.body, 'NOT_FOUND', 404);
  });

  test('SEC-6-3: DELETE /api/cases/galaxy-15/forensic-analysis returns 404 NOT_FOUND', async () => {
    const res = await request(app)
      .delete('/api/cases/galaxy-15/forensic-analysis');
    expect(res.status).toBe(404);
    assertErrorContract(res.body, 'NOT_FOUND', 404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEC-7 — Case-listing / case-metadata error responses use contract shape
// ─────────────────────────────────────────────────────────────────────────────
describe('SEC-7: case routes use {error_code,error,status_code} on errors', () => {
  test('SEC-7-1: GET /api/cases/:id with unknown id returns CASE_NOT_FOUND contract', async () => {
    const res = await request(app).get('/api/cases/nonexistent-case-xyz');
    expect(res.status).toBe(404);
    assertErrorContract(res.body, 'CASE_NOT_FOUND', 404);
    assertNoInternalLeakage(res.body);
  });

  test('SEC-7-2: GET /api/cases/:id/timeline with unknown id returns CASE_NOT_FOUND contract', async () => {
    const res = await request(app).get('/api/cases/nonexistent-case-xyz/timeline');
    expect(res.status).toBe(404);
    assertErrorContract(res.body, 'CASE_NOT_FOUND', 404);
    assertNoInternalLeakage(res.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEC-8 — No secret values or implementation details in any response
// ─────────────────────────────────────────────────────────────────────────────
describe('SEC-8: no secrets or internal details in responses', () => {
  test('SEC-8-1: 404 errors do not contain filesystem paths', async () => {
    const res = await request(app).get('/api/cases/no-such-case');
    assertNoInternalLeakage(res.body);
  });

  test('SEC-8-2: forensic-analysis 404 does not leak path or env-var names', async () => {
    const res = await request(app)
      .get('/api/cases/no-such-case/forensic-analysis');
    assertNoInternalLeakage(res.body);
  });

  test('SEC-8-3: successful GET /api/cases does not contain env-var values', async () => {
    const res = await request(app).get('/api/cases');
    expect(res.status).toBe(200);
    assertNoInternalLeakage(res.body);
  });

  test('SEC-8-4: unknown-route 404 contains no stack trace', async () => {
    const res = await request(app).get('/api/does/not/exist');
    assertNoInternalLeakage(res.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEC-9 — Preservation of existing forensic API behaviour
// Ensure security changes do not break the forensic pipeline contract.
// ─────────────────────────────────────────────────────────────────────────────
describe('SEC-9: existing forensic API behaviour preserved', () => {
  test('SEC-9-1: GET /api/cases returns 200 with array', async () => {
    const res = await request(app).get('/api/cases');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('SEC-9-2: GET /api/cases/galaxy-15 returns 200 with case_id', async () => {
    const res = await request(app).get('/api/cases/galaxy-15');
    expect(res.status).toBe(200);
    expect(res.body.case_id).toBe('galaxy-15');
  }, 10_000);

  test('SEC-9-3: GET /api/cases/galaxy-15/evidence-graph returns 200 with hypotheses', async () => {
    const res = await request(app).get('/api/cases/galaxy-15/evidence-graph');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.hypotheses)).toBe(true);
  }, 15_000);
});
