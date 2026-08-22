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

// Helper: all four evidence-list names including the new environmental_context field.
const ALL_LISTS = [
  'environmental_context',
  'supporting_evidence',
  'contradicting_evidence',
  'non_discriminating_evidence',
];

// Helper: the three original relationship lists (used by tests that pre-date T12).
const ORIGINAL_LISTS = [
  'supporting_evidence',
  'contradicting_evidence',
  'non_discriminating_evidence',
];

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
// Covers original three lists (environmental_context covered by T14).
// ─────────────────────────────────────────────────────────────────────────────
test('T3: every evidence_id referenced in the graph exists in the parsed evidence', () => {
  for (const h of graph.hypotheses) {
    for (const listName of ORIGINAL_LISTS) {
      const list = h[listName] || [];
      for (const entry of list) {
        expect(validIds.has(entry.evidence_id)).toBe(true);
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
// Covers original three lists (environmental_context covered by T15).
// ─────────────────────────────────────────────────────────────────────────────
test('T4: no duplicate evidence_id within any single relationship list', () => {
  for (const h of graph.hypotheses) {
    for (const listName of ORIGINAL_LISTS) {
      const list  = h[listName] || [];
      const ids   = list.map((e) => e.evidence_id);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T5 — No hypothesis claims causality
// Extended to also scan environmental_context entries.
// ─────────────────────────────────────────────────────────────────────────────
test('T5: no hypothesis uses causal-certainty language in assessment, description, or interpretations', () => {
  const FORBIDDEN_ASSESSMENTS = new Set([
    'proven',
    'confirmed',
    'causation_established',
    'causal',
    'definitive',
  ]);

  const FORBIDDEN_PHRASES = [
    'proves',
    'confirms causation',
    'is caused by',
    'causation established',
    'proof of',
  ];

  for (const h of graph.hypotheses) {
    if (h.assessment !== null && h.assessment !== undefined) {
      expect(FORBIDDEN_ASSESSMENTS.has(h.assessment)).toBe(false);
    }

    for (const phrase of FORBIDDEN_PHRASES) {
      expect(h.description.toLowerCase()).not.toContain(phrase.toLowerCase());
    }

    // Check all four lists including environmental_context.
    for (const listName of ALL_LISTS) {
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
// T10 — All relationship objects in the original three lists have required fields
// ─────────────────────────────────────────────────────────────────────────────
test('T10: every relationship object has evidence_id (string), relationship (string), interpretation (string)', () => {
  for (const h of graph.hypotheses) {
    for (const listName of ORIGINAL_LISTS) {
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

// ─────────────────────────────────────────────────────────────────────────────
// T12 — environmental_context field exists on every hypothesis
// ─────────────────────────────────────────────────────────────────────────────
test('T12: every hypothesis has an environmental_context array', () => {
  for (const h of graph.hypotheses) {
    expect(h).toHaveProperty('environmental_context');
    expect(Array.isArray(h.environmental_context)).toBe(true);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T13 — environmental_context entries follow the standard EvidenceRef schema
// ─────────────────────────────────────────────────────────────────────────────
test('T13: every environmental_context entry has evidence_id, relationship, and interpretation (all non-empty strings)', () => {
  for (const h of graph.hypotheses) {
    for (const entry of h.environmental_context || []) {
      expect(typeof entry.evidence_id).toBe('string');
      expect(entry.evidence_id.length).toBeGreaterThan(0);
      expect(typeof entry.relationship).toBe('string');
      expect(entry.relationship.length).toBeGreaterThan(0);
      expect(typeof entry.interpretation).toBe('string');
      expect(entry.interpretation.length).toBeGreaterThan(0);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T14 — All evidence_ids in environmental_context are valid
// ─────────────────────────────────────────────────────────────────────────────
test('T14: every evidence_id referenced in environmental_context exists in the parsed evidence', () => {
  for (const h of graph.hypotheses) {
    for (const entry of h.environmental_context || []) {
      expect(validIds.has(entry.evidence_id)).toBe(true);
      if (!validIds.has(entry.evidence_id)) {
        throw new Error(
          `Hypothesis ${h.hypothesis_id} environmental_context references unknown evidence_id: ${entry.evidence_id}`
        );
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T15 — No duplicate evidence_id within environmental_context
// ─────────────────────────────────────────────────────────────────────────────
test('T15: no duplicate evidence_id within environmental_context', () => {
  for (const h of graph.hypotheses) {
    const ids    = (h.environmental_context || []).map((e) => e.evidence_id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T16 — H4 has no evidence in any list (all four are empty)
// H4 (ground segment / RF link anomaly) cannot be evaluated from environmental
// or spacecraft data; no evidence from this dataset speaks to it.
// ─────────────────────────────────────────────────────────────────────────────
test('T16: H4 has no entries in any evidence list', () => {
  const H4 = graph.hypotheses.find((h) => h.hypothesis_id === 'H4');
  expect(H4).toBeDefined();
  for (const listName of ALL_LISTS) {
    expect((H4[listName] || []).length).toBe(0);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T17 — H3 non_discriminating_evidence is empty
// Environmental data is not probative for an internal command-system fault.
// ─────────────────────────────────────────────────────────────────────────────
test('T17: H3 non_discriminating_evidence is empty', () => {
  const H3 = graph.hypotheses.find((h) => h.hypothesis_id === 'H3');
  expect(H3).toBeDefined();
  expect((H3.non_discriminating_evidence || []).length).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// T18 — H5 non_discriminating_evidence is empty
// H5 (attribution failure) is strongly_supported by the anchor event + limitations
// alone; environmental flooding added no forensic value.
// ─────────────────────────────────────────────────────────────────────────────
test('T18: H5 non_discriminating_evidence is empty', () => {
  const H5 = graph.hypotheses.find((h) => h.hypothesis_id === 'H5');
  expect(H5).toBeDefined();
  expect((H5.non_discriminating_evidence || []).length).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// T19 — EP8 and MAG windowed records appear in environmental_context for H1/H2,
//        not in supporting_evidence
// ─────────────────────────────────────────────────────────────────────────────
test('T19: H1 and H2 environmental_context is non-empty; supporting_evidence is empty', () => {
  const H1 = graph.hypotheses.find((h) => h.hypothesis_id === 'H1');
  const H2 = graph.hypotheses.find((h) => h.hypothesis_id === 'H2');

  expect(H1).toBeDefined();
  expect(H2).toBeDefined();

  // environmental_context must have entries (windowed EP8 for H1; EP8+MAG for H2).
  expect(H1.environmental_context.length).toBeGreaterThan(0);
  expect(H2.environmental_context.length).toBeGreaterThan(0);

  // supporting_evidence must be empty after the reclassification.
  expect(H1.supporting_evidence.length).toBe(0);
  expect(H2.supporting_evidence.length).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// T20 — H2 environmental_context contains more entries than H1
//        (H2 receives both EP8 and MAG windowed records; H1 receives EP8 only)
// ─────────────────────────────────────────────────────────────────────────────
test('T20: H2 environmental_context has more entries than H1 (EP8+MAG vs EP8 only)', () => {
  const H1 = graph.hypotheses.find((h) => h.hypothesis_id === 'H1');
  const H2 = graph.hypotheses.find((h) => h.hypothesis_id === 'H2');
  expect(H2.environmental_context.length).toBeGreaterThan(H1.environmental_context.length);
});

// ─────────────────────────────────────────────────────────────────────────────
// T21 — H5 assessment remains strongly_supported without environmental flooding
// ─────────────────────────────────────────────────────────────────────────────
test('T21: H5 assessment is strongly_supported even with empty non_discriminating_evidence', () => {
  const H5 = graph.hypotheses.find((h) => h.hypothesis_id === 'H5');
  expect(H5.assessment).toBe('strongly_supported');
  expect((H5.non_discriminating_evidence || []).length).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// T22 — causal_attribution_established is strictly boolean false
// ─────────────────────────────────────────────────────────────────────────────
test('T22: causal_attribution_established is strictly boolean false', () => {
  expect(typeof graph.causal_attribution_established).toBe('boolean');
  expect(graph.causal_attribution_established).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// T23 — No EPHEMERIS records appear in any hypothesis evidence list
// GOES11_EPHEMERIS orbital position data is not forensically probative for
// a command anomaly hypothesis and must not appear in the graph.
// ─────────────────────────────────────────────────────────────────────────────
test('T23: no GOES11_EPHEMERIS evidence_ids appear in any hypothesis evidence list', () => {
  const ephemerisIds = new Set(
    rows
      .filter((r) => r.source === 'GOES11_EPHEMERIS')
      .map((r) => r.evidence_id)
  );

  for (const h of graph.hypotheses) {
    for (const listName of ALL_LISTS) {
      for (const entry of h[listName] || []) {
        expect(ephemerisIds.has(entry.evidence_id)).toBe(false);
        if (ephemerisIds.has(entry.evidence_id)) {
          throw new Error(
            `Hypothesis ${h.hypothesis_id} ${listName} contains EPHEMERIS evidence_id: ${entry.evidence_id}`
          );
        }
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T24 — No evidence_id appears in more than one list within the same hypothesis
// Guards against cross-list duplication (e.g. same ID in both environmental_context
// and supporting_evidence for the same hypothesis).
// ─────────────────────────────────────────────────────────────────────────────
test('T24: no evidence_id appears in more than one list within the same hypothesis', () => {
  for (const h of graph.hypotheses) {
    const allRefs = [];
    for (const listName of ALL_LISTS) {
      for (const entry of h[listName] || []) {
        allRefs.push({ id: entry.evidence_id, list: listName });
      }
    }
    const idCounts = {};
    for (const { id } of allRefs) {
      idCounts[id] = (idCounts[id] || 0) + 1;
    }
    for (const [id, count] of Object.entries(idCounts)) {
      if (count > 1) {
        throw new Error(
          `Hypothesis ${h.hypothesis_id} contains evidence_id ${id} in ${count} lists`
        );
      }
      expect(count).toBe(1);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T25 — Total unique evidence_ids across all hypotheses does not exceed
//        the count of non-EPHEMERIS records in the parsed evidence set.
// Guards against evidence flooding: the graph should reference only records
// that genuinely bear on at least one forensic question.
// ─────────────────────────────────────────────────────────────────────────────
test('T25: total unique evidence_ids referenced in the graph do not exceed non-EPHEMERIS record count', () => {
  const nonEphemerisCount = rows.filter(
    (r) => r.source !== 'GOES11_EPHEMERIS'
  ).length;

  const allReferencedIds = new Set();
  for (const h of graph.hypotheses) {
    for (const listName of ALL_LISTS) {
      for (const entry of h[listName] || []) {
        allReferencedIds.add(entry.evidence_id);
      }
    }
  }

  expect(allReferencedIds.size).toBeLessThanOrEqual(nonEphemerisCount);
});

test('T26: H2 environmental_context contains only windowed EP8 and MAG evidence', () => {
  const H2 = graph.hypotheses.find((h) => h.hypothesis_id === 'H2');

  expect(H2.environmental_context.length).toBeGreaterThan(0);

  for (const entry of H2.environmental_context) {
    const row = rows.find((r) => r.evidence_id === entry.evidence_id);
    expect(row).toBeDefined();
    expect(['GOES11_EP8', 'GOES11_MAG']).toContain(row.source);
  }
});

test('T27: H1 environmental_context contains only windowed EP8 evidence', () => {
  const H1 = graph.hypotheses.find((h) => h.hypothesis_id === 'H1');

  expect(H1.environmental_context.length).toBeGreaterThan(0);

  for (const entry of H1.environmental_context) {
    const row = rows.find((r) => r.evidence_id === entry.evidence_id);
    expect(row).toBeDefined();
    expect(row.source).toBe('GOES11_EP8');
  }
});
