'use strict';

/**
 * Phase 5.9 — Full-Stack Forensic Pipeline Integration Test
 *
 * Makes ONE real HTTP request to GET /api/cases/galaxy-15/forensic-analysis
 * and ONE to GET /api/cases/galaxy-15/timeline (for evidence cross-reference),
 * then validates the COMPLETE response body across all 13 contract dimensions.
 *
 * CONTRACT DIMENSIONS (REQ 1–13):
 *   REQ-1   HTTP 200
 *   REQ-2   case_id === "galaxy-15"
 *   REQ-3   exactly 5 hypotheses
 *   REQ-4   H1=mixed, H2=mixed, H3=supported, H4=insufficient_evidence,
 *           H5=strongly_supported
 *   REQ-5   causal_attribution_established === false
 *   REQ-6   environmental_context_ids and supporting_evidence_ids are disjoint
 *           per hypothesis
 *   REQ-7   no EPHEMERIS evidence_id appears in any hypothesis evidence list
 *   REQ-8   every cited evidence_id exists in the real evidence dataset
 *           (cross-referenced with /timeline)
 *   REQ-9   no causal-certainty language in any free-text field
 *   REQ-10  no numerical probabilities in any free-text field
 *   REQ-11  limitations survive the complete pipeline (non-empty per hypothesis
 *           and at the analysis level)
 *   REQ-12  all required top-level schema fields are present
 *   REQ-13  3 independent HTTP-level runs produce byte-identical deterministic
 *           analysis output (fingerprint comparison)
 *
 * What this test does NOT duplicate:
 *   - Per-endpoint HTTP 200/404 unit tests  → httpIntegration.test.js
 *   - Unit-level pipeline assertions F33–F47 → forensicPipelineIntegration.test.js
 *   - Analysis API boundary F25–F32         → forensicAnalysisApi.test.js
 *   - Evidence model / 278 records          → evidenceModel.test.js
 *   - Phrase-level validator unit tests      → causalCertaintyValidation.test.js
 *   - Per-stage timing                       → forensicPipelinePerf.test.js
 *
 * IMPORTANT: must NOT depend on a live LLM (WATSONX_AI_APIKEY absent in test
 * env → heuristic fallback).
 */

const request = require('supertest');
const { app } = require('../server');

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

// Required top-level fields in a ValidatedForensicReport (REQ-12).
const REQUIRED_TOP_LEVEL_FIELDS = [
  'case_id',
  'analysis_version',
  'causal_attribution_established',
  'hypotheses',
  'analyst_narrative',
  'limitations',
  'evidence_summary',
];

// Evidence-list keys inside evidence_summary per hypothesis.
const EVIDENCE_LIST_KEYS = [
  'environmental_context_ids',
  'supporting_evidence_ids',
  'contradicting_evidence_ids',
  'non_discriminating_evidence_ids',
];

// ---------------------------------------------------------------------------
// Causal-certainty detection — mirrors aiAnalyst.js logic exactly.
// Re-declared here so the test is self-contained and does not rely on
// private module internals (the service does not export these constants).
// Kept in sync with aiAnalyst.js CAUSAL_CERTAINTY_PHRASES / CAUSAL_CERTAINTY_RE.
// ---------------------------------------------------------------------------
const CAUSAL_CERTAINTY_PHRASES = [
  'proves', 'confirms causation', 'is caused by', 'causation established',
  'proof of', 'definitively caused', 'conclusively shows',
  'was the cause of',
  'is the cause of',
  'was responsible for causing',
  'resulted in the failure',
  'resulted in the anomaly',
  'led to the failure',
  'led to the anomaly',
  'triggered the failure',
  'triggered the anomaly',
  'directly caused',
];

const NEGATION_PREFIXES = [
  'not ', 'cannot ', 'can not ', 'did not ', 'does not ', 'do not ',
  'could not ', 'would not ', 'was not ', 'were not ', 'has not ', 'have not ',
  'had not ', 'is not ', 'are not ',
];

const CAUSAL_CERTAINTY_RE = /\b(?:caused\s+the|caused\s+by|was\s+caused\s+by|been\s+caused\s+by)\b/i;

const NUMERICAL_PROBABILITY_RE =
  /\b\d+(\.\d+)?\s*%|\b\d+(\.\d+)?\s*(probability|chance|likelihood)/i;

/**
 * Returns true if the text contains causal-certainty language using the same
 * sentence-level, negation-aware logic as aiAnalyst.js::containsCausalCertainty.
 */
function containsCausalCertainty(text) {
  const lower = (text || '').toLowerCase();
  if (CAUSAL_CERTAINTY_PHRASES.some((p) => lower.includes(p))) return true;
  const sentences = lower.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
  for (const sentence of sentences) {
    if (CAUSAL_CERTAINTY_RE.test(sentence)) {
      const negated = NEGATION_PREFIXES.some((n) => sentence.includes(n));
      if (!negated) return true;
    }
  }
  return false;
}

/**
 * Collect every free-text string present anywhere in the response body.
 * Walks the object/array tree recursively; string leaves are returned in an
 * array (with a label for diagnostic output on failure).
 *
 * @param {*}      value   - any JSON value
 * @param {string} path    - dot-notation path label (for assertion messages)
 * @returns {{ label: string, text: string }[]}
 */
function collectFreeText(value, path = '') {
  if (typeof value === 'string') {
    return [{ label: path, text: value }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => collectFreeText(v, `${path}[${i}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) =>
      collectFreeText(v, path ? `${path}.${k}` : k),
    );
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures — both HTTP calls made ONCE in beforeAll.
// ─────────────────────────────────────────────────────────────────────────────

let forensicRes;  // HTTP response from /forensic-analysis
let report;       // parsed response body
let timelineRes;  // HTTP response from /timeline
let timelineRows; // parsed timeline (array of evidence rows)
let realEvidenceIds; // Set<string> — all evidence_id values from /timeline

beforeAll(async () => {
  jest.setTimeout(60_000);

  // Single forensic-analysis request — all REQ-1..12 assertions use this.
  forensicRes = await request(app).get(`/api/cases/${CASE_ID}/forensic-analysis`);
  report      = forensicRes.body;

  // Timeline request — used for REQ-7 (EPHEMERIS exclusion) and REQ-8
  // (every cited ID must exist in the real dataset).
  timelineRes  = await request(app).get(`/api/cases/${CASE_ID}/timeline`);
  timelineRows = timelineRes.body;

  realEvidenceIds = new Set(
    Array.isArray(timelineRows) ? timelineRows.map((r) => r.evidence_id) : [],
  );
}, 60_000);

// ─────────────────────────────────────────────────────────────────────────────
// REQ-1: HTTP 200
// ─────────────────────────────────────────────────────────────────────────────
describe('Phase 5.9 — Full-Stack Forensic Pipeline Integration', () => {

  test('REQ-1: /forensic-analysis returns HTTP 200', () => {
    expect(forensicRes.status).toBe(200);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // REQ-2: case_id
  // ───────────────────────────────────────────────────────────────────────────
  test('REQ-2: response body contains case_id === "galaxy-15"', () => {
    expect(report.case_id).toBe(CASE_ID);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // REQ-3: exactly 5 hypotheses
  // ───────────────────────────────────────────────────────────────────────────
  test('REQ-3: hypotheses array contains exactly 5 entries (H1–H5)', () => {
    expect(Array.isArray(report.hypotheses)).toBe(true);
    expect(report.hypotheses).toHaveLength(5);
    const ids = report.hypotheses.map((h) => h.hypothesis_id);
    ['H1', 'H2', 'H3', 'H4', 'H5'].forEach((id) => expect(ids).toContain(id));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // REQ-4: individual hypothesis assessments
  // ───────────────────────────────────────────────────────────────────────────
  test('REQ-4a: H1 assessment is "mixed"', () => {
    const h = report.hypotheses.find((h) => h.hypothesis_id === 'H1');
    expect(h).toBeDefined();
    expect(h.assessment).toBe(EXPECTED_ASSESSMENTS.H1);
  });

  test('REQ-4b: H2 assessment is "mixed"', () => {
    const h = report.hypotheses.find((h) => h.hypothesis_id === 'H2');
    expect(h).toBeDefined();
    expect(h.assessment).toBe(EXPECTED_ASSESSMENTS.H2);
  });

  test('REQ-4c: H3 assessment is "supported"', () => {
    const h = report.hypotheses.find((h) => h.hypothesis_id === 'H3');
    expect(h).toBeDefined();
    expect(h.assessment).toBe(EXPECTED_ASSESSMENTS.H3);
  });

  test('REQ-4d: H4 assessment is "insufficient_evidence"', () => {
    const h = report.hypotheses.find((h) => h.hypothesis_id === 'H4');
    expect(h).toBeDefined();
    expect(h.assessment).toBe(EXPECTED_ASSESSMENTS.H4);
  });

  test('REQ-4e: H5 assessment is "strongly_supported"', () => {
    const h = report.hypotheses.find((h) => h.hypothesis_id === 'H5');
    expect(h).toBeDefined();
    expect(h.assessment).toBe(EXPECTED_ASSESSMENTS.H5);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // REQ-5: causal_attribution_established
  // ───────────────────────────────────────────────────────────────────────────
  test('REQ-5: causal_attribution_established is strictly false', () => {
    expect(report.causal_attribution_established).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // REQ-6: environmental_context_ids and supporting_evidence_ids are disjoint
  //        per hypothesis (no evidence flooding at the HTTP boundary)
  // ───────────────────────────────────────────────────────────────────────────
  test('REQ-6: environmental_context_ids and supporting_evidence_ids are disjoint per hypothesis', () => {
    for (const h of report.hypotheses) {
      const s = h.evidence_summary;
      const envCtxSet = new Set(s.environmental_context_ids || []);
      for (const id of (s.supporting_evidence_ids || [])) {
        expect(envCtxSet.has(id)).toBe(false);
      }
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // REQ-7: no EPHEMERIS evidence_id appears in any hypothesis evidence list.
  //        EPHEMERIS IDs are identified by cross-referencing /timeline.
  // ───────────────────────────────────────────────────────────────────────────
  test('REQ-7: /timeline returns HTTP 200 and at least one EPHEMERIS record exists', () => {
    expect(timelineRes.status).toBe(200);
    expect(Array.isArray(timelineRows)).toBe(true);
    const ephemerisCount = timelineRows.filter((r) => r.source === 'GOES11_EPHEMERIS').length;
    expect(ephemerisCount).toBeGreaterThan(0);
  });

  test('REQ-7: no EPHEMERIS evidence_id appears in any hypothesis evidence list', () => {
    const ephemerisIds = new Set(
      timelineRows
        .filter((r) => r.source === 'GOES11_EPHEMERIS')
        .map((r) => r.evidence_id),
    );

    for (const h of report.hypotheses) {
      const s = h.evidence_summary;
      const allIds = [
        ...(s.environmental_context_ids          || []),
        ...(s.supporting_evidence_ids            || []),
        ...(s.contradicting_evidence_ids         || []),
        ...(s.non_discriminating_evidence_ids    || []),
      ];
      for (const id of allIds) {
        expect(ephemerisIds.has(id)).toBe(false);
      }
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // REQ-8: every cited evidence_id exists in the real evidence dataset
  //        (cross-referenced with /timeline)
  // ───────────────────────────────────────────────────────────────────────────
  test('REQ-8: /timeline provides 278 real evidence records for cross-reference', () => {
    expect(realEvidenceIds.size).toBe(278);
  });

  test('REQ-8: every evidence_id cited in any hypothesis list exists in the real dataset', () => {
    for (const h of report.hypotheses) {
      const s = h.evidence_summary;
      const allIds = [
        ...(s.environmental_context_ids          || []),
        ...(s.supporting_evidence_ids            || []),
        ...(s.contradicting_evidence_ids         || []),
        ...(s.non_discriminating_evidence_ids    || []),
      ];
      for (const id of allIds) {
        expect(realEvidenceIds.has(id)).toBe(true);
      }
    }
  });

  test('REQ-8: every evidence_id in analyst_narrative.hypothesis_assessments exists in the real dataset', () => {
    const narrativeAssessments = report.analyst_narrative &&
      report.analyst_narrative.hypothesis_assessments;
    expect(Array.isArray(narrativeAssessments)).toBe(true);
    for (const ha of narrativeAssessments) {
      for (const id of (ha.evidence_ids || [])) {
        expect(realEvidenceIds.has(id)).toBe(true);
      }
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // REQ-9: no causal-certainty language in any free-text field
  //        (uses full sentence-level, negation-aware logic — not just a phrase list)
  // ───────────────────────────────────────────────────────────────────────────
  test('REQ-9: no free-text field in the response contains causal-certainty language', () => {
    const textFields = collectFreeText(report);
    const violations = textFields
      .filter(({ text }) => containsCausalCertainty(text))
      .map(({ label, text }) => `  ${label}: "${text.slice(0, 120)}"`);

    if (violations.length > 0) {
      throw new Error(
        `REQ-9: causal-certainty language found in ${violations.length} field(s):\n` +
        violations.join('\n'),
      );
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // REQ-10: no numerical probabilities in any free-text field
  // ───────────────────────────────────────────────────────────────────────────
  test('REQ-10: no free-text field in the response contains numerical probability claims', () => {
    const textFields = collectFreeText(report);
    const violations = textFields
      .filter(({ text }) => NUMERICAL_PROBABILITY_RE.test(text))
      .map(({ label, text }) => `  ${label}: "${text.slice(0, 120)}"`);

    if (violations.length > 0) {
      throw new Error(
        `REQ-10: numerical probability claims found in ${violations.length} field(s):\n` +
        violations.join('\n'),
      );
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // REQ-11: limitations survive the complete pipeline
  //   (a) top-level report.limitations is a non-empty array
  //   (b) every hypothesis carries at least one limitation entry
  // ───────────────────────────────────────────────────────────────────────────
  test('REQ-11a: report.limitations is a non-empty array', () => {
    expect(Array.isArray(report.limitations)).toBe(true);
    expect(report.limitations.length).toBeGreaterThan(0);
  });

  test('REQ-11b: every hypothesis carries at least one limitation entry', () => {
    for (const h of report.hypotheses) {
      expect(Array.isArray(h.limitations)).toBe(true);
      expect(h.limitations.length).toBeGreaterThan(0);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // REQ-12: all required top-level schema fields are present
  // ───────────────────────────────────────────────────────────────────────────
  test('REQ-12: all required top-level schema fields are present in the response', () => {
    for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
      expect(report).toHaveProperty(field);
    }
  });

  test('REQ-12: analyst_narrative contains required sub-fields', () => {
    const n = report.analyst_narrative;
    expect(n).toBeDefined();
    expect(typeof n.executive_summary).toBe('string');
    expect(typeof n.event_description).toBe('string');
    expect(Array.isArray(n.hypothesis_assessments)).toBe(true);
    expect(Array.isArray(n.strongest_observations)).toBe(true);
    expect(Array.isArray(n.major_uncertainties)).toBe(true);
    expect(Array.isArray(n.missing_evidence)).toBe(true);
    expect(typeof n.source).toBe('string');
    expect(typeof n.generated_at).toBe('string');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // REQ-13: 3 independent HTTP-level runs produce byte-identical deterministic
  //         analysis output.
  //
  //         The fingerprint covers every deterministic field.  generated_at
  //         (timestamp) is excluded from the fingerprint because it changes
  //         between calls.  All hypothesis IDs, assessments, evidence-list IDs,
  //         counts, causal_attribution_established, and narrative assessments
  //         must be identical across all three runs.
  // ───────────────────────────────────────────────────────────────────────────
  test('REQ-13: three independent HTTP-level runs produce byte-identical deterministic output', async () => {
    /**
     * Make one HTTP request and extract a deterministic fingerprint string.
     * Excludes generated_at (timestamp) from the fingerprint.
     */
    async function httpFingerprint() {
      const r    = await request(app).get(`/api/cases/${CASE_ID}/forensic-analysis`);
      const body = r.body;
      return JSON.stringify({
        case_id                        : body.case_id,
        analysis_version               : body.analysis_version,
        causal_attribution_established : body.causal_attribution_established,
        hypotheses: (body.hypotheses || []).map((h) => ({
          hypothesis_id : h.hypothesis_id,
          label         : h.label,
          assessment    : h.assessment,
          evidence_summary: {
            environmental_context_ids        : h.evidence_summary.environmental_context_ids,
            environmental_context_count      : h.evidence_summary.environmental_context_count,
            supporting_evidence_ids          : h.evidence_summary.supporting_evidence_ids,
            supporting_evidence_count        : h.evidence_summary.supporting_evidence_count,
            contradicting_evidence_ids       : h.evidence_summary.contradicting_evidence_ids,
            contradicting_evidence_count     : h.evidence_summary.contradicting_evidence_count,
            non_discriminating_evidence_ids  : h.evidence_summary.non_discriminating_evidence_ids,
            non_discriminating_evidence_count: h.evidence_summary.non_discriminating_evidence_count,
          },
        })),
        // Narrative assessments (generated_at excluded)
        narrative_assessments: (
          body.analyst_narrative &&
          Array.isArray(body.analyst_narrative.hypothesis_assessments)
            ? body.analyst_narrative.hypothesis_assessments
            : []
        ).map((ha) => ({
          hypothesis_id: ha.hypothesis_id,
          assessment   : ha.assessment,
        })),
        narrative_causal: body.analyst_narrative &&
          body.analyst_narrative.causal_attribution_established,
      });
    }

    // Three independent HTTP-level runs
    const [fp1, fp2, fp3] = await Promise.all([
      httpFingerprint(),
      httpFingerprint(),
      httpFingerprint(),
    ]);

    expect(fp1).toBe(fp2);
    expect(fp1).toBe(fp3);
  }, 60_000);

}); // end describe Phase 5.9
