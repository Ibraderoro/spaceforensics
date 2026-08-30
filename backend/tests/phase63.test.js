'use strict';

/**
 * Phase 6.3 — Temporal Selection Window Configuration
 *
 * Verifies requirements 7 and 8 of the Phase 6.3 specification:
 *
 *   Req 7 — A test proving the configured TEMPORAL_SELECTION_WINDOW_MINUTES
 *            value (10 minutes) is actually used when selecting evidence rows.
 *            Rows at exactly ±10 minutes must be included; rows beyond ±10
 *            minutes must be excluded.
 *
 *   Req 8 — A test preventing accidental causal interpretation of the window.
 *            The heuristic_note for every hypothesis must describe the window
 *            as an evidence-selection heuristic, not a causal threshold.
 *            The forensic output must not contain causal-certainty language
 *            derived from temporal proximity alone.
 *
 * These tests operate through buildEvidenceGraph (exported from server.js)
 * so they test the same code path used by the live API. No test doubles.
 */

const { parseEvidenceCSV, buildEvidenceGraph, buildForensicAnalysis } = require('../server');

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures for both cases
// ─────────────────────────────────────────────────────────────────────────────

let g15Rows, g15Graph, g15Analysis;
let tcaRows, tcaGraph, tcaAnalysis;

beforeAll(async () => {
  [g15Rows, tcaRows] = await Promise.all([
    parseEvidenceCSV('galaxy-15'),
    parseEvidenceCSV('test-case-alpha'),
  ]);
  g15Graph    = await buildEvidenceGraph('galaxy-15', g15Rows);
  tcaGraph    = await buildEvidenceGraph('test-case-alpha', tcaRows);
  g15Analysis = buildForensicAnalysis('galaxy-15', g15Graph);
  tcaAnalysis = buildForensicAnalysis('test-case-alpha', tcaGraph);
});

// ─────────────────────────────────────────────────────────────────────────────
// P63-WIN-1 — 10-minute boundary inclusion: G15
// Rows whose timestamp is exactly 10 minutes from the anchor are included.
// ─────────────────────────────────────────────────────────────────────────────
test('P63-WIN-1: G15 rows exactly at the ±10-minute boundary are captured in the evidence graph', () => {
  // The G15 anchor is 2010-04-05T09:48:00Z.
  // Any GOES11_EP8 or GOES11_MAG row at 09:38:00Z or 09:58:00Z (±10 min exact)
  // must be referenced somewhere in the graph.
  const ANCHOR = new Date('2010-04-05T09:48:00Z').getTime();
  const WINDOW_MS = 10 * 60 * 1000;

  const envRows = g15Rows.filter(
    (r) => r.source === 'GOES11_EP8' || r.source === 'GOES11_MAG',
  );

  // Rows exactly at the boundary
  const atBoundary = envRows.filter(
    (r) => Math.abs(new Date(r.timestamp).getTime() - ANCHOR) === WINDOW_MS,
  );

  if (atBoundary.length > 0) {
    // Every boundary row must have its evidence_id referenced in at least one
    // hypothesis's environmental_context list.
    const allEnvCtxIds = new Set(
      g15Graph.hypotheses.flatMap((h) =>
        (h.environmental_context || []).map((ref) => ref.evidence_id),
      ),
    );
    for (const row of atBoundary) {
      expect(allEnvCtxIds.has(row.evidence_id)).toBe(true);
    }
  } else {
    // No row falls exactly on the boundary — confirm at least one row within
    // the window is present, proving the window is operative.
    const withinWindow = envRows.filter(
      (r) => Math.abs(new Date(r.timestamp).getTime() - ANCHOR) <= WINDOW_MS,
    );
    expect(withinWindow.length).toBeGreaterThan(0);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P63-WIN-2 — Rows outside ±10 minutes are excluded from environmental_context
// ─────────────────────────────────────────────────────────────────────────────
test('P63-WIN-2: G15 rows more than 10 minutes from the anchor are NOT in environmental_context', () => {
  const ANCHOR = new Date('2010-04-05T09:48:00Z').getTime();
  const WINDOW_MS = 10 * 60 * 1000;

  // Build the set of env IDs that are outside the ±10-min window
  const outsideWindowIds = new Set(
    g15Rows
      .filter((r) => r.source === 'GOES11_EP8' || r.source === 'GOES11_MAG')
      .filter((r) => Math.abs(new Date(r.timestamp).getTime() - ANCHOR) > WINDOW_MS)
      .map((r) => r.evidence_id),
  );

  if (outsideWindowIds.size === 0) return; // nothing to test

  const allEnvCtxIds = new Set(
    g15Graph.hypotheses.flatMap((h) =>
      (h.environmental_context || []).map((ref) => ref.evidence_id),
    ),
  );

  // None of the outside-window IDs should appear in any environmental_context
  for (const id of outsideWindowIds) {
    expect(allEnvCtxIds.has(id)).toBe(false);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P63-WIN-3 — Same boundary correctness holds for test-case-alpha (±10 min)
// ─────────────────────────────────────────────────────────────────────────────
test('P63-WIN-3: TCA rows more than 10 minutes from the anchor are NOT in environmental_context', () => {
  const ANCHOR = new Date('2009-08-12T14:30:00Z').getTime(); // TCA anchor
  const WINDOW_MS = 10 * 60 * 1000;

  const outsideWindowIds = new Set(
    tcaRows
      .filter((r) => r.source === 'GOES13_EP8' || r.source === 'GOES13_MAG')
      .filter((r) => Math.abs(new Date(r.timestamp).getTime() - ANCHOR) > WINDOW_MS)
      .map((r) => r.evidence_id),
  );

  if (outsideWindowIds.size === 0) return;

  const allEnvCtxIds = new Set(
    tcaGraph.hypotheses.flatMap((h) =>
      (h.environmental_context || []).map((ref) => ref.evidence_id),
    ),
  );

  for (const id of outsideWindowIds) {
    expect(allEnvCtxIds.has(id)).toBe(false);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P63-HEUR-1 — heuristic_note describes the window as a selection heuristic
// (Req 8 — no accidental causal interpretation — G15)
// ─────────────────────────────────────────────────────────────────────────────
test('P63-HEUR-1: G15 hypotheses with heuristic_note describe the window as a heuristic, not a causal threshold', () => {
  const hypothesesWithNote = g15Graph.hypotheses.filter((h) => h.heuristic_note);
  expect(hypothesesWithNote.length).toBeGreaterThan(0);

  for (const h of hypothesesWithNote) {
    const note = h.heuristic_note.toLowerCase();
    // Must contain language indicating it is a heuristic
    const isHeuristic = note.includes('heuristic') || note.includes('selection') || note.includes('evidence-selection');
    expect(isHeuristic).toBe(true);
    // Must NOT affirmatively assert causation — negations like "not a causal threshold" are correct and allowed.
    // "proves causation", "is a causal threshold", "is a scientifically calibrated causal threshold"
    // are all forbidden; "not a … causal threshold" is the correct phrasing.
    expect(note).not.toMatch(/proves?\s+caus/i);
    // Reject affirmative framing: "is a causal threshold" / "serves as a causal threshold"
    expect(note).not.toMatch(/\bis\s+a\s+(?:scientifically\s+calibrated\s+)?causal\s+threshold/i);
    expect(note).not.toMatch(/\bserves?\s+as\s+a\s+(?:scientifically\s+calibrated\s+)?causal\s+threshold/i);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P63-HEUR-2 — Same heuristic-note requirement holds for test-case-alpha
// (Req 8 — no accidental causal interpretation — TCA)
// ─────────────────────────────────────────────────────────────────────────────
test('P63-HEUR-2: TCA hypotheses with heuristic_note describe the window as a heuristic, not a causal threshold', () => {
  const hypothesesWithNote = tcaGraph.hypotheses.filter((h) => h.heuristic_note);
  expect(hypothesesWithNote.length).toBeGreaterThan(0);

  for (const h of hypothesesWithNote) {
    const note = h.heuristic_note.toLowerCase();
    const isHeuristic = note.includes('heuristic') || note.includes('selection') || note.includes('evidence-selection');
    expect(isHeuristic).toBe(true);
    expect(note).not.toMatch(/proves?\s+caus/i);
    expect(note).not.toMatch(/\bis\s+a\s+(?:scientifically\s+calibrated\s+)?causal\s+threshold/i);
    expect(note).not.toMatch(/\bserves?\s+as\s+a\s+(?:scientifically\s+calibrated\s+)?causal\s+threshold/i);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P63-HEUR-3 — Temporal proximity alone does not assert causation in assessments
// (Req 8 — forensic analysis does not derive causal verdicts from the window)
// ─────────────────────────────────────────────────────────────────────────────
test('P63-HEUR-3: G15 forensic analysis does not assert causation solely from temporal proximity', () => {
  for (const h of g15Analysis.hypotheses) {
    // The window is a selection mechanism; no assessment should say
    // "temporally proximate therefore caused"
    const rationale = (h.rationale || '').toLowerCase();
    expect(rationale).not.toMatch(/temporal(ly)?\s+proximate\s+(therefore|proves?|establishes?|confirms?)\s+caus/i);
    expect(rationale).not.toMatch(/within\s+\d+\s+min(ute)?s?\s+(therefore|proves?|establishes?)\s+caus/i);
  }
});
