'use strict';

const { parseEvidenceCSV, buildEvidenceGraph } = require('../server');

const CASE_ID = 'galaxy-15';

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture — built once for the whole suite.
// ─────────────────────────────────────────────────────────────────────────────
let rows;
let graph;
let validIds;

beforeAll(async () => {
  rows    = await parseEvidenceCSV(CASE_ID);
  graph   = buildEvidenceGraph(CASE_ID, rows);
  validIds = new Set(rows.map((r) => r.evidence_id));
});

// ─────────────────────────────────────────────────────────────────────────────
// T1 — Valid JSON structure
// ─────────────────────────────────────────────────────────────────────────────
test('T1: graph has case_id, causal_attribution_established, and hypotheses array', () => {
  expect(typeof graph.case_id).toBe('string');
  expect(graph).toHaveProperty('causal_attribution_established');
  expect(Array.isArray(graph.hypotheses)).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// T2 — Five hypotheses present with expected IDs
// ─────────────────────────────────────────────────────────────────────────────
test('T2: exactly five hypotheses are returned with IDs H1–H5', () => {
  expect(graph.hypotheses).toHaveLength(5);
  const ids = graph.hypotheses.map((h) => h.hypothesis_id);
  expect(ids).toContain('H1');
  expect(ids).toContain('H2');
  expect(ids).toContain('H3');
  expect(ids).toContain('H4');
  expect(ids).toContain('H5');
});

// ─────────────────────────────────────────────────────────────────────────────
// T3 — Every referenced evidence_id exists in the parsed evidence set
// ─────────────────────────────────────────────────────────────────────────────
test('T3: every evidence_id referenced in the graph exists in the parsed evidence', () => {
  const RELATIONSHIP_LISTS = [
    'supporting_evidence',
    'contradicting_evidence',
    'non_discriminating_evidence',
  ];

  for (const h of graph.hypotheses) {
    for (const listName of RELATIONSHIP_LISTS) {
      const list = h[listName] || [];
      for (const entry of list) {
        expect(validIds.has(entry.evidence_id)).toBe(true);
        // Provide a helpful failure message identifying the offending ID
        if (!validIds.has(entry.evidence_id)) {
          throw new Error(
            `Hypothesis ${h.hypothesis_id} ${listName} references unknown evidence_id: ${entry.evidence_id}`
          );
        }
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T4 — No duplicate evidence_id within a single relationship list
// ─────────────────────────────────────────────────────────────────────────────
test('T4: no duplicate evidence_id within any single relationship list', () => {
  const RELATIONSHIP_LISTS = [
    'supporting_evidence',
    'contradicting_evidence',
    'non_discriminating_evidence',
  ];

  for (const h of graph.hypotheses) {
    for (const listName of RELATIONSHIP_LISTS) {
      const list  = h[listName] || [];
      const ids   = list.map((e) => e.evidence_id);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T5 — No hypothesis claims causality
// ─────────────────────────────────────────────────────────────────────────────
test('T5: no hypothesis uses causal-certainty language in assessment, description, or interpretations', () => {
  // Forbidden assessment values
  const FORBIDDEN_ASSESSMENTS = new Set([
    'proven',
    'confirmed',
    'causation_established',
    'causal',
    'definitive',
  ]);

  // Forbidden substrings in free-text fields
  const FORBIDDEN_PHRASES = [
    'proves',
    'confirms causation',
    'is caused by',
    'causation established',
    'proof of',
  ];

  const RELATIONSHIP_LISTS = [
    'supporting_evidence',
    'contradicting_evidence',
    'non_discriminating_evidence',
  ];

  for (const h of graph.hypotheses) {
    // Check assessment
    if (h.assessment !== null && h.assessment !== undefined) {
      expect(FORBIDDEN_ASSESSMENTS.has(h.assessment)).toBe(false);
    }

    // Check description
    for (const phrase of FORBIDDEN_PHRASES) {
      expect(h.description.toLowerCase()).not.toContain(phrase.toLowerCase());
    }

    // Check all interpretation strings
    for (const listName of RELATIONSHIP_LISTS) {
      for (const entry of h[listName] || []) {
        for (const phrase of FORBIDDEN_PHRASES) {
          expect(entry.interpretation.toLowerCase()).not.toContain(phrase.toLowerCase());
        }
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T6 — Every hypothesis has at least one limitation
// ─────────────────────────────────────────────────────────────────────────────
test('T6: every hypothesis has at least one entry in its limitations array', () => {
  for (const h of graph.hypotheses) {
    expect(Array.isArray(h.limitations)).toBe(true);
    expect(h.limitations.length).toBeGreaterThanOrEqual(1);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T7 — H5 is present and carries assessment: strongly_supported
// ─────────────────────────────────────────────────────────────────────────────
test('T7: H5 is present and has assessment strongly_supported', () => {
  const H5 = graph.hypotheses.find((h) => h.hypothesis_id === 'H5');
  expect(H5).toBeDefined();
  expect(H5.assessment).toBe('strongly_supported');
});

// ─────────────────────────────────────────────────────────────────────────────
// T8 — causal_attribution_established is exactly false for Galaxy 15
// ─────────────────────────────────────────────────────────────────────────────
test('T8: causal_attribution_established is false for Galaxy 15', () => {
  expect(graph.causal_attribution_established).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// T9 — Forbidden phrases from the prior implementation are absent
// ─────────────────────────────────────────────────────────────────────────────
test('T9: forbidden scientifically-unsound phrases are not present in the serialised graph', () => {
  const serialised = JSON.stringify(graph).toLowerCase();

  const FORBIDDEN = [
    // A — unsound attitude-anomaly inference
    'no attitude anomaly',
    // B — transponder over-claim
    'transponders remained active, therefore seu is contradicted',
    // C — 9-month duration as proof of hardware failure
    '9-month command loss proves hardware failure',
    // D — autonomous recovery ruling out all hardware failure
    'physical hardware destruction is ruled out',
    // General causal over-claims
    'esd is contradicted',
    'seu is contradicted',
    'value > 1000',
  ];

  for (const phrase of FORBIDDEN) {
    expect(serialised).not.toContain(phrase.toLowerCase());
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T10 — All relationship objects have evidence_id, relationship, interpretation
// ─────────────────────────────────────────────────────────────────────────────
test('T10: every relationship object has evidence_id (string), relationship (string), interpretation (string)', () => {
  const RELATIONSHIP_LISTS = [
    'supporting_evidence',
    'contradicting_evidence',
    'non_discriminating_evidence',
  ];

  for (const h of graph.hypotheses) {
    for (const listName of RELATIONSHIP_LISTS) {
      for (const entry of h[listName] || []) {
        expect(typeof entry.evidence_id).toBe('string');
        expect(entry.evidence_id.length).toBeGreaterThan(0);
        expect(typeof entry.relationship).toBe('string');
        expect(entry.relationship.length).toBeGreaterThan(0);
        expect(typeof entry.interpretation).toBe('string');
        expect(entry.interpretation.length).toBeGreaterThan(0);
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T11 — All non-null assessments use only the allowed categorical vocabulary
// ─────────────────────────────────────────────────────────────────────────────
test('T11: all non-null assessments use only allowed categorical values', () => {
  const ALLOWED = new Set([
    'strongly_supported',
    'supported',
    'mixed',
    'weakly_supported',
    'insufficient_evidence',
  ]);

  for (const h of graph.hypotheses) {
    if (h.assessment !== null && h.assessment !== undefined) {
      expect(ALLOWED.has(h.assessment)).toBe(true);
    }
  }
});
