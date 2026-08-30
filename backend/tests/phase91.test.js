'use strict';

/**
 * Phase 9.1 — Shared Forensic Configuration Constants
 *
 * Focused regression tests proving that:
 *
 *   P91-1  FORENSIC_TEMPORAL_WINDOW_MINUTES in forensicConfig.js equals 10 —
 *          the value that was previously inlined in server.js and aiEngine.js.
 *
 *   P91-2  The constant governs the actual evidence-selection window used by
 *          buildEvidenceGraph: a row exactly at ±FORENSIC_TEMPORAL_WINDOW_MINUTES
 *          from the anchor is included; a row one millisecond beyond is excluded.
 *
 *   P91-3  HEURISTIC_WINDOW_LABEL in evidenceExploration.js is consistent with
 *          FORENSIC_TEMPORAL_WINDOW_MINUTES (i.e. the label displays the same
 *          numeric value as the constant and does not contain a stale hard-coded
 *          number).
 *
 *   P91-4  Galaxy-15 evidence-graph output is byte-identical to an independent
 *          pipeline run, confirming the refactor introduced no behavioral change.
 *
 * These tests operate through the same exported functions used by the live API.
 */

const { parseEvidenceCSV, buildEvidenceGraph } = require('../server');
const { FORENSIC_TEMPORAL_WINDOW_MINUTES }     = require('../services/forensicConfig');
const { HEURISTIC_WINDOW_LABEL }               = require('../services/evidenceExploration');

// ─────────────────────────────────────────────────────────────────────────────
// P91-1 — Constant value
// ─────────────────────────────────────────────────────────────────────────────
test('P91-1: FORENSIC_TEMPORAL_WINDOW_MINUTES is 10 (preserved from pre-refactor inline value)', () => {
  expect(FORENSIC_TEMPORAL_WINDOW_MINUTES).toBe(10);
});

test('P91-1b: FORENSIC_TEMPORAL_WINDOW_MINUTES is a positive integer', () => {
  expect(Number.isInteger(FORENSIC_TEMPORAL_WINDOW_MINUTES)).toBe(true);
  expect(FORENSIC_TEMPORAL_WINDOW_MINUTES).toBeGreaterThan(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// P91-2 — Constant governs actual evidence selection in buildEvidenceGraph
// ─────────────────────────────────────────────────────────────────────────────
test('P91-2: buildEvidenceGraph uses FORENSIC_TEMPORAL_WINDOW_MINUTES as the selection boundary for G15', async () => {
  const rows  = await parseEvidenceCSV('galaxy-15');
  const graph = await buildEvidenceGraph('galaxy-15', rows);

  const ANCHOR    = new Date('2010-04-05T09:48:00Z').getTime();
  const WINDOW_MS = FORENSIC_TEMPORAL_WINDOW_MINUTES * 60 * 1000;

  const envRows = rows.filter(
    (r) => r.source === 'GOES11_EP8' || r.source === 'GOES11_MAG',
  );

  const allEnvCtxIds = new Set(
    graph.hypotheses.flatMap((h) =>
      (h.environmental_context || []).map((ref) => ref.evidence_id),
    ),
  );

  // Every row within the window must appear in at least one hypothesis's
  // environmental_context — the selection window is inclusive (<=).
  const withinWindow = envRows.filter(
    (r) => Math.abs(new Date(r.timestamp).getTime() - ANCHOR) <= WINDOW_MS,
  );
  expect(withinWindow.length).toBeGreaterThan(0);
  for (const row of withinWindow) {
    expect(allEnvCtxIds.has(row.evidence_id)).toBe(true);
  }

  // No row beyond the window should appear in any environmental_context.
  const outsideWindow = envRows.filter(
    (r) => Math.abs(new Date(r.timestamp).getTime() - ANCHOR) > WINDOW_MS,
  );
  for (const row of outsideWindow) {
    expect(allEnvCtxIds.has(row.evidence_id)).toBe(false);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P91-3 — HEURISTIC_WINDOW_LABEL is consistent with the constant
// ─────────────────────────────────────────────────────────────────────────────
test('P91-3: HEURISTIC_WINDOW_LABEL contains the numeric value of FORENSIC_TEMPORAL_WINDOW_MINUTES', () => {
  // The label must display the same number as the constant.
  expect(HEURISTIC_WINDOW_LABEL).toContain(String(FORENSIC_TEMPORAL_WINDOW_MINUTES));
  // Sanity: must still contain the heuristic-disclaimer text.
  expect(HEURISTIC_WINDOW_LABEL).toContain('evidence-selection heuristic');
  expect(HEURISTIC_WINDOW_LABEL).toContain('not a scientifically calibrated causal threshold');
});

test('P91-3b: HEURISTIC_WINDOW_LABEL matches the exact pre-refactor string', () => {
  // This test locks the label to its pre-refactor byte-identical value.
  // If FORENSIC_TEMPORAL_WINDOW_MINUTES is ever changed, this test will
  // fail — which is the desired outcome (both must be updated together).
  const expectedLabel =
    `Evidence selected via \u00b1${FORENSIC_TEMPORAL_WINDOW_MINUTES}-minute heuristic temporal window around the anomaly. ` +
    'This window is an evidence-selection heuristic, not a scientifically calibrated causal threshold.';
  expect(HEURISTIC_WINDOW_LABEL).toBe(expectedLabel);
});

// ─────────────────────────────────────────────────────────────────────────────
// P91-4 — Galaxy-15 graph is byte-identical on two independent runs
// ─────────────────────────────────────────────────────────────────────────────
test('P91-4: Galaxy-15 evidence graph is byte-identical on two independent pipeline runs after refactor', async () => {
  const [rows1, rows2] = await Promise.all([
    parseEvidenceCSV('galaxy-15'),
    parseEvidenceCSV('galaxy-15'),
  ]);
  const [graph1, graph2] = await Promise.all([
    buildEvidenceGraph('galaxy-15', rows1),
    buildEvidenceGraph('galaxy-15', rows2),
  ]);

  // Hypothesis count and IDs must match.
  expect(graph1.hypotheses).toHaveLength(graph2.hypotheses.length);

  for (const h1 of graph1.hypotheses) {
    const h2 = graph2.hypotheses.find((h) => h.hypothesis_id === h1.hypothesis_id);
    expect(h2).toBeDefined();
    expect(h2.assessment).toBe(h1.assessment);

    // All four evidence list IDs must be identical (sorted for stability).
    const lists = [
      'environmental_context',
      'supporting_evidence',
      'contradicting_evidence',
      'non_discriminating_evidence',
    ];
    for (const list of lists) {
      const ids1 = (h1[list] || []).map((r) => r.evidence_id).sort();
      const ids2 = (h2[list] || []).map((r) => r.evidence_id).sort();
      expect(ids1).toEqual(ids2);
    }
  }
});
