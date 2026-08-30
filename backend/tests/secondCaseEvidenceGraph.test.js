'use strict';

/**
 * Phase 6 — Second Case Evidence Graph Tests
 *
 * Verifies that buildEvidenceGraph produces a structurally valid graph for
 * test-case-alpha, applying the same forensic invariants that hold for Galaxy 15.
 *
 * These tests are structural/contract tests — they do NOT pin specific
 * test-case-alpha assessment values (which would make them regression tests).
 * They verify the graph satisfies the platform-wide scientific invariants.
 */

const { parseEvidenceCSV, buildEvidenceGraph } = require('../server');

const CASE_ID = 'test-case-alpha';

const ALL_LISTS = [
  'environmental_context',
  'supporting_evidence',
  'contradicting_evidence',
  'non_discriminating_evidence',
];

const ALLOWED_ASSESSMENTS = new Set([
  'strongly_supported', 'supported', 'mixed', 'weakly_supported', 'insufficient_evidence',
]);

let rows;
let graph;
let validIds;

beforeAll(async () => {
  rows     = await parseEvidenceCSV(CASE_ID);
  graph    = await buildEvidenceGraph(CASE_ID, rows);
  validIds = new Set(rows.map((r) => r.evidence_id));
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-GR-1 — Graph has required top-level fields
// ─────────────────────────────────────────────────────────────────────────────
test('SC-GR-1: graph has case_id, causal_attribution_established, and hypotheses array', () => {
  expect(graph.case_id).toBe(CASE_ID);
  expect(typeof graph.causal_attribution_established).toBe('boolean');
  expect(Array.isArray(graph.hypotheses)).toBe(true);
  expect(graph.hypotheses.length).toBeGreaterThan(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-GR-2 — causal_attribution_established is false for test-case-alpha
// ─────────────────────────────────────────────────────────────────────────────
test('SC-GR-2: causal_attribution_established is false for test-case-alpha', () => {
  expect(graph.causal_attribution_established).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-GR-3 — All hypothesis IDs are non-empty strings
// ─────────────────────────────────────────────────────────────────────────────
test('SC-GR-3: every hypothesis has a non-empty hypothesis_id string', () => {
  for (const h of graph.hypotheses) {
    expect(typeof h.hypothesis_id).toBe('string');
    expect(h.hypothesis_id.length).toBeGreaterThan(0);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-GR-4 — All assessments are in the allowed vocabulary
// ─────────────────────────────────────────────────────────────────────────────
test('SC-GR-4: every hypothesis assessment is in ALLOWED_ASSESSMENTS', () => {
  for (const h of graph.hypotheses) {
    if (h.assessment !== null && h.assessment !== undefined) {
      expect(ALLOWED_ASSESSMENTS.has(h.assessment)).toBe(true);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-GR-5 — All four evidence-list fields are present on every hypothesis
// ─────────────────────────────────────────────────────────────────────────────
test('SC-GR-5: every hypothesis has all four evidence-list fields', () => {
  for (const h of graph.hypotheses) {
    for (const listName of ALL_LISTS) {
      expect(Array.isArray(h[listName])).toBe(true);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-GR-6 — All referenced evidence IDs exist in the parsed evidence
// ─────────────────────────────────────────────────────────────────────────────
test('SC-GR-6: every evidence_id referenced in the graph exists in the parsed evidence', () => {
  for (const h of graph.hypotheses) {
    for (const listName of ALL_LISTS) {
      for (const entry of h[listName] || []) {
        expect(validIds.has(entry.evidence_id)).toBe(true);
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-GR-7 — No duplicate evidence_id within any single list
// ─────────────────────────────────────────────────────────────────────────────
test('SC-GR-7: no duplicate evidence_id within any single relationship list', () => {
  for (const h of graph.hypotheses) {
    for (const listName of ALL_LISTS) {
      const ids   = (h[listName] || []).map((e) => e.evidence_id);
      const uniq  = new Set(ids);
      expect(uniq.size).toBe(ids.length);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-GR-8 — environmental_context and supporting_evidence are disjoint (V5)
// ─────────────────────────────────────────────────────────────────────────────
test('SC-GR-8: environmental_context_ids and supporting_evidence_ids are disjoint per hypothesis (V5)', () => {
  for (const h of graph.hypotheses) {
    const envCtxSet = new Set((h.environmental_context || []).map((e) => e.evidence_id));
    for (const entry of h.supporting_evidence || []) {
      expect(envCtxSet.has(entry.evidence_id)).toBe(false);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-GR-9 — Every hypothesis has at least one limitation
// ─────────────────────────────────────────────────────────────────────────────
test('SC-GR-9: every hypothesis has at least one limitation', () => {
  for (const h of graph.hypotheses) {
    expect(Array.isArray(h.limitations)).toBe(true);
    expect(h.limitations.length).toBeGreaterThanOrEqual(1);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-GR-10 — No causal-certainty language in descriptions or interpretations
// ─────────────────────────────────────────────────────────────────────────────
test('SC-GR-10: no hypothesis uses causal-certainty language', () => {
  const FORBIDDEN = ['proves', 'confirms causation', 'is caused by', 'causation established', 'proof of'];
  for (const h of graph.hypotheses) {
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

// ─────────────────────────────────────────────────────────────────────────────
// SC-GR-11 — Test-case-alpha uses TCA evidence ID prefix, not G15
// ─────────────────────────────────────────────────────────────────────────────
test('SC-GR-11: all evidence_ids in the graph use the TCA prefix', () => {
  for (const h of graph.hypotheses) {
    for (const listName of ALL_LISTS) {
      for (const entry of h[listName] || []) {
        expect(entry.evidence_id).toMatch(/^E-TCA-/);
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-GR-12 — Strongly-supported "insufficient evidence" hypothesis is present
// The platform-wide pattern: every case should have an "insufficient evidence"
// outcome as a legitimate epistemic result (not required by name, but required
// as at least one hypothesis with strongly_supported assessment when attribution
// is not established).
// ─────────────────────────────────────────────────────────────────────────────
test('SC-GR-12: at least one hypothesis has assessment "strongly_supported" (captures unresolved outcome)', () => {
  const hasStronglySupported = graph.hypotheses.some((h) => h.assessment === 'strongly_supported');
  expect(hasStronglySupported).toBe(true);
});
