'use strict';

/**
 * Phase 7.3 — Evidence Exploration Service — Unit Tests
 *
 * Tests the pure functions in evidenceExploration.js against real case data.
 * No HTTP calls; exercises the service functions directly.
 *
 * Invariants verified:
 *   EX-1  Evidence records are read-only (service functions return copies)
 *   EX-2  Every returned item is traceable to an evidence_id from the CSV
 *   EX-3  environmental_context is separate from supporting_evidence
 *   EX-4  contradicting_evidence is in its own field
 *   EX-5  non_discriminating_evidence is in its own field
 *   EX-6  EPHEMERIS records are absent from all hypothesis views
 *   EX-7  Relationships come from the graph — no temporal proximity inference
 *   EX-8  No numerical probabilities in any output field
 *   EX-9  Assessments are read-only verbatim pass-throughs
 *   EX-10 compareHypothesesEvidence uses a single-case graph
 */

const { parseEvidenceCSV, buildEvidenceGraph } = require('../server');
const {
  resolveEvidenceRecord,
  buildHypothesisEvidenceView,
  buildCaseEvidenceIndex,
  buildEnvironmentalContextSummary,
  compareHypothesesEvidence,
  EVIDENCE_LISTS,
  LIST_LABELS,
  HEURISTIC_WINDOW_LABEL,
} = require('../services/evidenceExploration');

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures — built once for the whole file
// ─────────────────────────────────────────────────────────────────────────────

const G15  = 'galaxy-15';
const TCA  = 'test-case-alpha';

let g15Rows;
let g15Graph;
let tcaRows;
let tcaGraph;

// A known EP8 hypothesis that has environmental_context (H1 or H2 for G15)
let g15HypWithEnvCtx;
// A known G15 hypothesis with supporting_evidence (H3 or H5)
let g15HypWithSupport;
// An EPHEMERIS row from the G15 dataset
let g15EphemerisId;

beforeAll(async () => {
  jest.setTimeout(30_000);
  [g15Rows, tcaRows] = await Promise.all([
    parseEvidenceCSV(G15),
    parseEvidenceCSV(TCA),
  ]);
  [g15Graph, tcaGraph] = await Promise.all([
    buildEvidenceGraph(G15, g15Rows),
    buildEvidenceGraph(TCA, tcaRows),
  ]);

  g15HypWithEnvCtx  = g15Graph.hypotheses.find((h) =>
    (h.environmental_context || []).length > 0);
  g15HypWithSupport = g15Graph.hypotheses.find((h) =>
    (h.supporting_evidence || []).length > 0);

  const ephRow = g15Rows.find((r) => r.source === 'GOES11_EPHEMERIS');
  g15EphemerisId = ephRow ? ephRow.evidence_id : null;
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// Module structure
// ─────────────────────────────────────────────────────────────────────────────

test('EX-MODULE-1: EVIDENCE_LISTS has exactly four canonical entries', () => {
  expect(EVIDENCE_LISTS).toEqual([
    'environmental_context',
    'supporting_evidence',
    'contradicting_evidence',
    'non_discriminating_evidence',
  ]);
});

test('EX-MODULE-2: LIST_LABELS covers all four list names', () => {
  for (const listName of EVIDENCE_LISTS) {
    expect(LIST_LABELS).toHaveProperty(listName);
    expect(typeof LIST_LABELS[listName]).toBe('string');
    expect(LIST_LABELS[listName].length).toBeGreaterThan(0);
  }
});

test('EX-MODULE-3: HEURISTIC_WINDOW_LABEL is a non-empty string', () => {
  expect(typeof HEURISTIC_WINDOW_LABEL).toBe('string');
  expect(HEURISTIC_WINDOW_LABEL.length).toBeGreaterThan(0);
  // Must not claim causality
  expect(HEURISTIC_WINDOW_LABEL.toLowerCase()).not.toContain('caused');
  expect(HEURISTIC_WINDOW_LABEL.toLowerCase()).not.toContain('proves');
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveEvidenceRecord
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveEvidenceRecord', () => {
  test('EX-R-1: returns a record with all 12 fields for a known evidence_id (EX-2)', () => {
    const rec = resolveEvidenceRecord(g15Rows[0].evidence_id, g15Rows);
    expect(rec).not.toBeNull();
    const FIELDS = [
      'evidence_id', 'timestamp', 'source', 'measurement',
      'value', 'unit', 'resolution', 'dataset_id',
      'provider', 'variable', 'evidence_type', 'quality',
    ];
    for (const f of FIELDS) {
      expect(rec).toHaveProperty(f);
    }
  });

  test('EX-R-2: evidence_id in returned record matches the requested ID (EX-2)', () => {
    const id = g15Rows[5].evidence_id;
    const rec = resolveEvidenceRecord(id, g15Rows);
    expect(rec.evidence_id).toBe(id);
  });

  test('EX-R-3: returns null for an unknown evidence_id', () => {
    const rec = resolveEvidenceRecord('E-G15-FAKE-9999', g15Rows);
    expect(rec).toBeNull();
  });

  test('EX-R-4: returned object is a shallow copy — mutating it does not affect the source array (EX-1)', () => {
    const id = g15Rows[0].evidence_id;
    const rec = resolveEvidenceRecord(id, g15Rows);
    rec.evidence_id = 'MUTATED';
    // Source row must be unchanged
    expect(g15Rows[0].evidence_id).toBe(id);
  });

  test('EX-R-5: no probability or score field in returned record (EX-8)', () => {
    const rec = resolveEvidenceRecord(g15Rows[0].evidence_id, g15Rows);
    expect(rec).not.toHaveProperty('probability');
    expect(rec).not.toHaveProperty('confidence');
    expect(rec).not.toHaveProperty('score');
    expect(rec).not.toHaveProperty('likelihood');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildHypothesisEvidenceView
// ─────────────────────────────────────────────────────────────────────────────

describe('buildHypothesisEvidenceView', () => {
  let viewWithEnv;
  let viewWithSupport;

  beforeAll(() => {
    viewWithEnv    = buildHypothesisEvidenceView(g15HypWithEnvCtx, g15Rows);
    viewWithSupport = g15HypWithSupport
      ? buildHypothesisEvidenceView(g15HypWithSupport, g15Rows)
      : null;
  });

  test('EX-HV-1: returns hypothesis_id matching the input', () => {
    expect(viewWithEnv.hypothesis_id).toBe(g15HypWithEnvCtx.hypothesis_id);
  });

  test('EX-HV-2: returns label and assessment verbatim (EX-9)', () => {
    expect(viewWithEnv.label).toBe(g15HypWithEnvCtx.label);
    expect(viewWithEnv.assessment).toBe(g15HypWithEnvCtx.assessment);
  });

  test('EX-HV-3: all four list fields are present and are arrays (EX-3, EX-4, EX-5)', () => {
    expect(Array.isArray(viewWithEnv.environmental_context)).toBe(true);
    expect(Array.isArray(viewWithEnv.supporting_evidence)).toBe(true);
    expect(Array.isArray(viewWithEnv.contradicting_evidence)).toBe(true);
    expect(Array.isArray(viewWithEnv.non_discriminating_evidence)).toBe(true);
  });

  test('EX-HV-4: environmental_context is a separate field from supporting_evidence (EX-3)', () => {
    // The four lists are distinct properties — they never share a reference
    expect(viewWithEnv.environmental_context).not.toBe(viewWithEnv.supporting_evidence);
  });

  test('EX-HV-5: every entry in environmental_context carries evidence_id, relationship, interpretation, record (EX-2)', () => {
    for (const entry of viewWithEnv.environmental_context) {
      expect(typeof entry.evidence_id).toBe('string');
      expect(entry.evidence_id.length).toBeGreaterThan(0);
      expect(typeof entry.relationship).toBe('string');
      expect(typeof entry.interpretation).toBe('string');
      expect(entry.record).not.toBeNull();
      expect(entry.record.evidence_id).toBe(entry.evidence_id);
    }
  });

  test('EX-HV-6: every evidence_id in env context resolves to a real CSV row (EX-2)', () => {
    for (const entry of viewWithEnv.environmental_context) {
      const csvId = new Set(g15Rows.map((r) => r.evidence_id));
      expect(csvId.has(entry.evidence_id)).toBe(true);
    }
  });

  test('EX-HV-7: heuristic_window_note is present when environmental_context is non-empty (EX-7)', () => {
    expect(viewWithEnv.environmental_context.length).toBeGreaterThan(0);
    expect(typeof viewWithEnv.heuristic_window_note).toBe('string');
    expect(viewWithEnv.heuristic_window_note.length).toBeGreaterThan(0);
    // Must match the canonical label
    expect(viewWithEnv.heuristic_window_note).toBe(HEURISTIC_WINDOW_LABEL);
  });

  test('EX-HV-8: heuristic_window_note does not contain causal language (EX-8)', () => {
    const note = viewWithEnv.heuristic_window_note.toLowerCase();
    expect(note).not.toContain('caused');
    expect(note).not.toContain('proves');
    expect(note).not.toContain('probability');
    expect(note).not.toContain('confidence');
  });

  test('EX-HV-9: EPHEMERIS evidence_id is absent from all four lists (EX-6)', () => {
    if (!g15EphemerisId) return; // guard for test resilience
    for (const listName of EVIDENCE_LISTS) {
      const ids = viewWithEnv[listName].map((e) => e.evidence_id);
      expect(ids).not.toContain(g15EphemerisId);
    }
  });

  test('EX-HV-10: supporting_evidence entries have evidence_id that resolves to CSV rows (EX-2)', () => {
    if (!viewWithSupport) return;
    const csvIds = new Set(g15Rows.map((r) => r.evidence_id));
    for (const entry of viewWithSupport.supporting_evidence) {
      expect(csvIds.has(entry.evidence_id)).toBe(true);
      expect(entry.record).not.toBeNull();
    }
  });

  test('EX-HV-11: assessment in view matches graph assessment and is not changed (EX-9)', () => {
    const graphH = g15Graph.hypotheses.find(
      (h) => h.hypothesis_id === viewWithEnv.hypothesis_id);
    expect(viewWithEnv.assessment).toBe(graphH.assessment);
  });

  test('EX-HV-12: no probability or numerical score field in view (EX-8)', () => {
    expect(viewWithEnv).not.toHaveProperty('probability');
    expect(viewWithEnv).not.toHaveProperty('confidence');
    expect(viewWithEnv).not.toHaveProperty('score');
    for (const listName of EVIDENCE_LISTS) {
      for (const entry of viewWithEnv[listName]) {
        expect(JSON.stringify(entry)).not.toMatch(/"probability"|"confidence"|"score"/);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildCaseEvidenceIndex
// ─────────────────────────────────────────────────────────────────────────────

describe('buildCaseEvidenceIndex', () => {
  let index;

  beforeAll(() => {
    index = buildCaseEvidenceIndex(g15Graph, g15Rows);
  });

  test('EX-CI-1: returns a non-empty array', () => {
    expect(Array.isArray(index)).toBe(true);
    expect(index.length).toBeGreaterThan(0);
  });

  test('EX-CI-2: every entry has evidence_id, record, and hypothesis_relationships (EX-2)', () => {
    for (const entry of index) {
      expect(typeof entry.evidence_id).toBe('string');
      expect(entry.evidence_id.length).toBeGreaterThan(0);
      expect(entry.record).not.toBeNull();
      expect(entry.record.evidence_id).toBe(entry.evidence_id);
      expect(Array.isArray(entry.hypothesis_relationships)).toBe(true);
    }
  });

  test('EX-CI-3: every evidence_id in the index exists in the CSV (EX-2)', () => {
    const csvIds = new Set(g15Rows.map((r) => r.evidence_id));
    for (const entry of index) {
      expect(csvIds.has(entry.evidence_id)).toBe(true);
    }
  });

  test('EX-CI-4: EPHEMERIS evidence_id is absent from the index (EX-6)', () => {
    if (!g15EphemerisId) return;
    const indexIds = new Set(index.map((e) => e.evidence_id));
    expect(indexIds.has(g15EphemerisId)).toBe(false);
  });

  test('EX-CI-5: every evidence_id in the index is unique (no duplicates)', () => {
    const ids = index.map((e) => e.evidence_id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  test('EX-CI-6: each hypothesis_relationship entry has hypothesis_id, list_name, list_label, relationship, interpretation', () => {
    for (const entry of index) {
      for (const rel of entry.hypothesis_relationships) {
        expect(typeof rel.hypothesis_id).toBe('string');
        expect(EVIDENCE_LISTS).toContain(rel.list_name);
        expect(typeof rel.list_label).toBe('string');
        expect(typeof rel.relationship).toBe('string');
        expect(typeof rel.interpretation).toBe('string');
      }
    }
  });

  test('EX-CI-7: list_name values are only from the four canonical lists (EX-3, EX-4, EX-5)', () => {
    for (const entry of index) {
      for (const rel of entry.hypothesis_relationships) {
        expect(EVIDENCE_LISTS).toContain(rel.list_name);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildEnvironmentalContextSummary
// ─────────────────────────────────────────────────────────────────────────────

describe('buildEnvironmentalContextSummary', () => {
  let summary;

  beforeAll(() => {
    summary = buildEnvironmentalContextSummary(g15Graph, g15Rows);
  });

  test('EX-EC-1: returns heuristic_window_note (EX-7)', () => {
    expect(typeof summary.heuristic_window_note).toBe('string');
    expect(summary.heuristic_window_note).toBe(HEURISTIC_WINDOW_LABEL);
  });

  test('EX-EC-2: returns records array', () => {
    expect(Array.isArray(summary.records)).toBe(true);
    expect(summary.records.length).toBeGreaterThan(0);
  });

  test('EX-EC-3: every record has evidence_id, record fields, and referenced_by array (EX-2)', () => {
    for (const r of summary.records) {
      expect(typeof r.evidence_id).toBe('string');
      expect(r.record).not.toBeNull();
      expect(r.record.evidence_id).toBe(r.evidence_id);
      expect(Array.isArray(r.referenced_by)).toBe(true);
      expect(r.referenced_by.length).toBeGreaterThan(0);
    }
  });

  test('EX-EC-4: every evidence_id in records exists in the CSV (EX-2)', () => {
    const csvIds = new Set(g15Rows.map((row) => row.evidence_id));
    for (const r of summary.records) {
      expect(csvIds.has(r.evidence_id)).toBe(true);
    }
  });

  test('EX-EC-5: EPHEMERIS is absent from environmental context (EX-6)', () => {
    if (!g15EphemerisId) return;
    const ecIds = summary.records.map((r) => r.evidence_id);
    expect(ecIds).not.toContain(g15EphemerisId);
  });

  test('EX-EC-6: no environmental context record appears in any supporting_evidence list (EX-3)', () => {
    const ecIds = new Set(summary.records.map((r) => r.evidence_id));
    for (const h of g15Graph.hypotheses) {
      for (const ref of h.supporting_evidence || []) {
        // EX-3 invariant: an env context ID must not also be supporting_evidence
        // (validated upstream by V5 in forensicAnalysis — verify it holds here too)
        expect(ecIds.has(ref.evidence_id)).toBe(false);
      }
    }
  });

  test('EX-EC-7: heuristic_window_note does not contain causal language (EX-7, EX-8)', () => {
    const note = summary.heuristic_window_note.toLowerCase();
    expect(note).not.toContain('caused');
    expect(note).not.toContain('proves');
    expect(note).not.toContain('confirms causation');
    expect(note).not.toContain('%');
    expect(note).not.toContain('probability');
  });

  test('EX-EC-8: referenced_by contains only valid hypothesis_ids from the graph', () => {
    const validHids = new Set(g15Graph.hypotheses.map((h) => h.hypothesis_id));
    for (const r of summary.records) {
      for (const hid of r.referenced_by) {
        expect(validHids.has(hid)).toBe(true);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// compareHypothesesEvidence — within-case
// ─────────────────────────────────────────────────────────────────────────────

describe('compareHypothesesEvidence — within-case (galaxy-15)', () => {
  test('EX-CMP-1: all hypotheses comparison returns correct case_id', () => {
    const result = compareHypothesesEvidence(g15Graph, g15Rows, []);
    expect(result.case_id).toBe(G15);
  });

  test('EX-CMP-2: comparison note contains no causal language (EX-8)', () => {
    const result = compareHypothesesEvidence(g15Graph, g15Rows, []);
    const note = result.comparison_note.toLowerCase();
    expect(note).not.toContain('caused');
    expect(note).not.toContain('proves');
    expect(note).not.toContain('probability');
  });

  test('EX-CMP-3: causal_attribution_established is false and unchanged (EX-9)', () => {
    const result = compareHypothesesEvidence(g15Graph, g15Rows, []);
    expect(result.causal_attribution_established).toBe(false);
  });

  test('EX-CMP-4: hypothesis_ids in result match all graph hypotheses when no filter given', () => {
    const result = compareHypothesesEvidence(g15Graph, g15Rows, []);
    const graphIds = g15Graph.hypotheses.map((h) => h.hypothesis_id);
    expect(result.hypothesis_ids.sort()).toEqual(graphIds.sort());
  });

  test('EX-CMP-5: hypothesis_ids in result match the requested subset', () => {
    const subset = ['H1', 'H2'];
    const result = compareHypothesesEvidence(g15Graph, g15Rows, subset);
    expect(result.hypothesis_ids.sort()).toEqual(subset.sort());
  });

  test('EX-CMP-6: shared_evidence and exclusive_evidence are arrays', () => {
    const result = compareHypothesesEvidence(g15Graph, g15Rows, []);
    expect(Array.isArray(result.shared_evidence)).toBe(true);
    expect(Array.isArray(result.exclusive_evidence)).toBe(true);
  });

  test('EX-CMP-7: every shared_evidence entry has evidence_id, record, and appears_in (EX-2)', () => {
    const result = compareHypothesesEvidence(g15Graph, g15Rows, []);
    for (const e of result.shared_evidence) {
      expect(typeof e.evidence_id).toBe('string');
      expect(e.record).not.toBeNull();
      expect(e.record.evidence_id).toBe(e.evidence_id);
      expect(Array.isArray(e.appears_in)).toBe(true);
      expect(e.appears_in.length).toBeGreaterThanOrEqual(2);
    }
  });

  test('EX-CMP-8: shared_evidence appears_in contains ≥2 distinct hypothesis_ids', () => {
    const result = compareHypothesesEvidence(g15Graph, g15Rows, []);
    for (const e of result.shared_evidence) {
      const uniqueHids = new Set(e.appears_in.map((a) => a.hypothesis_id));
      expect(uniqueHids.size).toBeGreaterThanOrEqual(2);
    }
  });

  test('EX-CMP-9: exclusive_evidence entries each belong to exactly one hypothesis', () => {
    const result = compareHypothesesEvidence(g15Graph, g15Rows, []);
    for (const e of result.exclusive_evidence) {
      expect(typeof e.hypothesis_id).toBe('string');
      expect(typeof e.list_name).toBe('string');
      expect(typeof e.list_label).toBe('string');
      expect(EVIDENCE_LISTS).toContain(e.list_name);
      expect(e.record).not.toBeNull();
    }
  });

  test('EX-CMP-10: every evidence_id in comparison exists in the CSV (EX-2)', () => {
    const result = compareHypothesesEvidence(g15Graph, g15Rows, []);
    const csvIds = new Set(g15Rows.map((r) => r.evidence_id));
    for (const e of [...result.shared_evidence, ...result.exclusive_evidence]) {
      expect(csvIds.has(e.evidence_id)).toBe(true);
    }
  });

  test('EX-CMP-11: EPHEMERIS absent from both shared and exclusive lists (EX-6)', () => {
    if (!g15EphemerisId) return;
    const result = compareHypothesesEvidence(g15Graph, g15Rows, []);
    const allIds = [
      ...result.shared_evidence.map((e) => e.evidence_id),
      ...result.exclusive_evidence.map((e) => e.evidence_id),
    ];
    expect(allIds).not.toContain(g15EphemerisId);
  });

  test('EX-CMP-12: assessments in hypothesis entries are verbatim from graph (EX-9)', () => {
    const result = compareHypothesesEvidence(g15Graph, g15Rows, []);
    const graphMap = new Map(g15Graph.hypotheses.map((h) => [h.hypothesis_id, h.assessment]));
    for (const hEntry of result.hypotheses) {
      expect(hEntry.assessment).toBe(graphMap.get(hEntry.hypothesis_id));
    }
  });

  test('EX-CMP-13: no numerical probability field anywhere in the comparison (EX-8)', () => {
    const result = compareHypothesesEvidence(g15Graph, g15Rows, []);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/"probability"|"confidence"|"score"|"likelihood"/);
  });

  test('EX-CMP-14: unknown hypothesis_id returns error object', () => {
    const result = compareHypothesesEvidence(g15Graph, g15Rows, ['H1', 'HFAKE']);
    expect(result).toHaveProperty('error_code');
    expect(result.error_code).toBe('HYPOTHESIS_NOT_FOUND');
    expect(result).toHaveProperty('error');
  });

  test('EX-CMP-15: comparing H1 and H2 correctly identifies shared anchor evidence', () => {
    // Both H1 and H2 have the CASE anchor in non_discriminating_evidence
    const result = compareHypothesesEvidence(g15Graph, g15Rows, ['H1', 'H2']);
    const anchorRow = g15Rows.find((r) => r.source === 'CASE');
    const sharedIds = result.shared_evidence.map((e) => e.evidence_id);
    // Anchor should appear in shared (it is in non_discriminating for both H1 and H2)
    expect(sharedIds).toContain(anchorRow.evidence_id);
  });

  test('EX-CMP-16: within-case comparison includes comparison_note (EX-10)', () => {
    const result = compareHypothesesEvidence(g15Graph, g15Rows, []);
    expect(typeof result.comparison_note).toBe('string');
    expect(result.comparison_note).toContain('same case');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EX-10 — Cross-case isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('EX-CMP cross-case isolation (EX-10)', () => {
  test('EX-CMP-17: compareHypothesesEvidence with G15 graph never returns TCA evidence IDs', () => {
    const result = compareHypothesesEvidence(g15Graph, g15Rows, []);
    const allIds = [
      ...result.shared_evidence.map((e) => e.evidence_id),
      ...result.exclusive_evidence.map((e) => e.evidence_id),
    ];
    for (const id of allIds) {
      expect(id).toMatch(/^E-G15-/);
    }
  });

  test('EX-CMP-18: compareHypothesesEvidence with TCA graph never returns G15 evidence IDs', () => {
    const result = compareHypothesesEvidence(tcaGraph, tcaRows, []);
    const allIds = [
      ...result.shared_evidence.map((e) => e.evidence_id),
      ...result.exclusive_evidence.map((e) => e.evidence_id),
    ];
    for (const id of allIds) {
      expect(id).toMatch(/^E-TCA-/);
    }
  });

  test('EX-CMP-19: buildCaseEvidenceIndex with G15 graph never returns TCA evidence IDs', () => {
    const index = buildCaseEvidenceIndex(g15Graph, g15Rows);
    for (const entry of index) {
      expect(entry.evidence_id).toMatch(/^E-G15-/);
    }
  });

  test('EX-CMP-20: buildEnvironmentalContextSummary with G15 graph never returns TCA evidence IDs', () => {
    const summary = buildEnvironmentalContextSummary(g15Graph, g15Rows);
    for (const r of summary.records) {
      expect(r.evidence_id).toMatch(/^E-G15-/);
    }
  });
});
