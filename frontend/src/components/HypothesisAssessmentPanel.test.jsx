import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import HypothesisAssessmentPanel from "./HypothesisAssessmentPanel";

const HYPOTHESES = [
  {
    hypothesis_id:    "H5",
    label:            "Solar energetic particle (SEP) event",
    assessment:       "strongly_supported",
    evidence_summary: {
      environmental_context_ids:       ["EVT-001", "EVT-002"],
      supporting_evidence_ids:         ["EVT-010", "EVT-011"],
      contradicting_evidence_ids:      [],
      non_discriminating_evidence_ids: ["EVT-020"],
    },
    limitations:       [{ description: "Kp index is a proxy." }],
    heuristic_note:    "Confidence based on heuristic scoring.",
    key_observations:  ["Proton flux exceeded threshold.", "TTC anomaly correlated."],
  },
  {
    hypothesis_id:    "H4",
    label:            "Battery degradation",
    assessment:       "insufficient_evidence",
    evidence_summary: {
      environmental_context_ids:       [],
      supporting_evidence_ids:         [],
      contradicting_evidence_ids:      ["EVT-030"],
      non_discriminating_evidence_ids: [],
    },
    limitations:  [],
    key_observations: [],
  },
];

describe("HypothesisAssessmentPanel", () => {
  // ── Empty state ──────────────────────────────────────────────────────────────
  it("renders empty state when no hypotheses", () => {
    render(<HypothesisAssessmentPanel />);
    expect(screen.getByTestId("no-hypotheses")).toBeTruthy();
  });

  it("renders empty state when hypotheses array is empty", () => {
    render(<HypothesisAssessmentPanel hypotheses={[]} />);
    expect(screen.getByTestId("no-hypotheses")).toBeTruthy();
  });

  // ── Panel header ─────────────────────────────────────────────────────────────
  it("renders the hypothesis assessment panel", () => {
    render(<HypothesisAssessmentPanel hypotheses={HYPOTHESES} />);
    expect(screen.getByTestId("hypothesis-assessment-panel")).toBeTruthy();
  });

  it("shows 'read-only · deterministic pipeline' label", () => {
    render(<HypothesisAssessmentPanel hypotheses={HYPOTHESES} />);
    expect(screen.getByTestId("hypothesis-assessment-panel").textContent).toContain(
      "read-only · deterministic pipeline"
    );
  });

  // ── Hypothesis cards ─────────────────────────────────────────────────────────
  it("renders a card for each hypothesis", () => {
    render(<HypothesisAssessmentPanel hypotheses={HYPOTHESES} />);
    expect(screen.getByTestId("hypothesis-card-H5")).toBeTruthy();
    expect(screen.getByTestId("hypothesis-card-H4")).toBeTruthy();
  });

  it("shows hypothesis label in card header", () => {
    render(<HypothesisAssessmentPanel hypotheses={HYPOTHESES} />);
    expect(screen.getByTestId("hypothesis-header-H5").textContent).toContain(
      "Solar energetic particle (SEP) event"
    );
  });

  // ── Assessment badges — read-only ────────────────────────────────────────────
  it("renders assessment badge with canonical label", () => {
    render(<HypothesisAssessmentPanel hypotheses={HYPOTHESES} />);
    const badge = screen.getByTestId("hypothesis-assessment-badge-H5");
    expect(badge.textContent).toMatch(/strongly supported/i);
  });

  it("renders insufficient evidence badge for H4", () => {
    render(<HypothesisAssessmentPanel hypotheses={HYPOTHESES} />);
    const badge = screen.getByTestId("hypothesis-assessment-badge-H4");
    expect(badge.textContent).toMatch(/insufficient evidence/i);
  });

  it("assessment badges have no edit/input controls", () => {
    render(<HypothesisAssessmentPanel hypotheses={HYPOTHESES} />);
    // No inputs near assessment badges
    const panel = screen.getByTestId("hypothesis-assessment-panel");
    // There should be no text inputs in the panel
    expect(panel.querySelectorAll("input").length).toBe(0);
  });

  // ── Collapse/expand ──────────────────────────────────────────────────────────
  it("detail section is hidden before expanding", () => {
    render(<HypothesisAssessmentPanel hypotheses={HYPOTHESES} />);
    expect(screen.queryByTestId("hypothesis-detail-H5")).toBeNull();
  });

  it("expands card on header click", () => {
    render(<HypothesisAssessmentPanel hypotheses={HYPOTHESES} />);
    fireEvent.click(screen.getByTestId("hypothesis-header-H5"));
    expect(screen.getByTestId("hypothesis-detail-H5")).toBeTruthy();
  });

  it("collapses card on second header click", () => {
    render(<HypothesisAssessmentPanel hypotheses={HYPOTHESES} />);
    fireEvent.click(screen.getByTestId("hypothesis-header-H5"));
    fireEvent.click(screen.getByTestId("hypothesis-header-H5"));
    expect(screen.queryByTestId("hypothesis-detail-H5")).toBeNull();
  });

  // ── Environmental context — visually distinct invariant ──────────────────────
  it("renders environmental context section with amber styling and disclaimer", () => {
    render(<HypothesisAssessmentPanel hypotheses={HYPOTHESES} />);
    fireEvent.click(screen.getByTestId("hypothesis-header-H5"));
    const envSection = screen.getByTestId("env-context-section-H5");
    expect(envSection).toBeTruthy();
    // Must NOT say "mechanism confirmation" in a positive way
    expect(envSection.textContent).toContain("not mechanism confirmation");
  });

  it("shows the ENV context disclaimer note text", () => {
    render(<HypothesisAssessmentPanel hypotheses={HYPOTHESES} />);
    fireEvent.click(screen.getByTestId("hypothesis-header-H5"));
    const note = screen.getByTestId("env-context-note-H5");
    expect(note.textContent).toContain("do not confirm a mechanism");
  });

  it("renders environmental context IDs in amber section", () => {
    render(<HypothesisAssessmentPanel hypotheses={HYPOTHESES} />);
    fireEvent.click(screen.getByTestId("hypothesis-header-H5"));
    expect(screen.getByTestId("env-context-ids-H5")).toBeTruthy();
    expect(screen.getByTestId("env-chip-H5-EVT-001")).toBeTruthy();
    expect(screen.getByTestId("env-chip-H5-EVT-002")).toBeTruthy();
  });

  // ── Supporting evidence section ───────────────────────────────────────────────
  it("renders supporting evidence section", () => {
    render(<HypothesisAssessmentPanel hypotheses={HYPOTHESES} />);
    fireEvent.click(screen.getByTestId("hypothesis-header-H5"));
    expect(screen.getByTestId("supporting-section-H5")).toBeTruthy();
    expect(screen.getByTestId("supp-chip-H5-EVT-010")).toBeTruthy();
  });

  // ── Contradicting evidence section ────────────────────────────────────────────
  it("renders contradicting evidence section when present", () => {
    render(<HypothesisAssessmentPanel hypotheses={HYPOTHESES} />);
    fireEvent.click(screen.getByTestId("hypothesis-header-H4"));
    expect(screen.getByTestId("contradicting-section-H4")).toBeTruthy();
    expect(screen.getByTestId("cont-chip-H4-EVT-030")).toBeTruthy();
  });

  // ── No evidence message ───────────────────────────────────────────────────────
  it("shows no-evidence message when all evidence lists are empty", () => {
    const noEv = [{
      hypothesis_id: "H99", label: "Unknown", assessment: "insufficient_evidence",
      evidence_summary: {
        environmental_context_ids: [], supporting_evidence_ids: [],
        contradicting_evidence_ids: [], non_discriminating_evidence_ids: [],
      },
    }];
    render(<HypothesisAssessmentPanel hypotheses={noEv} />);
    fireEvent.click(screen.getByTestId("hypothesis-header-H99"));
    expect(screen.getByTestId("no-evidence-H99")).toBeTruthy();
  });

  // ── Key observations ─────────────────────────────────────────────────────────
  it("renders key observations after expand", () => {
    render(<HypothesisAssessmentPanel hypotheses={HYPOTHESES} />);
    fireEvent.click(screen.getByTestId("hypothesis-header-H5"));
    expect(screen.getByTestId("key-observation-H5-0")).toBeTruthy();
    expect(screen.getByTestId("key-observation-H5-0").textContent).toContain(
      "Proton flux exceeded threshold."
    );
  });

  // ── Heuristic note ────────────────────────────────────────────────────────────
  it("renders heuristic note after expand", () => {
    render(<HypothesisAssessmentPanel hypotheses={HYPOTHESES} />);
    fireEvent.click(screen.getByTestId("hypothesis-header-H5"));
    expect(screen.getByTestId("heuristic-note-H5").textContent).toContain(
      "heuristic scoring"
    );
  });

  // ── Limitations ───────────────────────────────────────────────────────────────
  it("renders limitations after expand", () => {
    render(<HypothesisAssessmentPanel hypotheses={HYPOTHESES} />);
    fireEvent.click(screen.getByTestId("hypothesis-header-H5"));
    expect(screen.getByTestId("hypothesis-limitations-H5")).toBeTruthy();
    expect(screen.getByTestId("hypothesis-limitation-0").textContent).toContain("proxy");
  });

  // ── No probability language ────────────────────────────────────────────────────
  it("does not render percentage or probability language", () => {
    render(<HypothesisAssessmentPanel hypotheses={HYPOTHESES} />);
    expect(document.body.textContent).not.toMatch(/%/);
  });
});

// ===========================================================================
// Phase 9.7 — HypothesisAssessmentPanel extended coverage
// Targets: all five categorical assessments, env-context vs supporting
// separation, limitations visibility, unknown case (no evidence).
// ===========================================================================

describe("HypothesisAssessmentPanel — Phase 9.7: five canonical assessments", () => {

  const makeHyp = (id, assessment, envIds = [], suppIds = []) => ({
    hypothesis_id:  id,
    label:          `${id} label`,
    assessment,
    evidence_summary: {
      environmental_context_ids:       envIds,
      supporting_evidence_ids:         suppIds,
      contradicting_evidence_ids:      [],
      non_discriminating_evidence_ids: [],
    },
    limitations: [],
    key_observations: [],
  });

  // HAP-P97-1 — H1 mixed
  it("HAP-P97-1: H1 (mixed) badge renders 'Mixed' and never 'Established'", () => {
    render(<HypothesisAssessmentPanel hypotheses={[makeHyp("H1", "mixed")]} />);
    const badge = screen.getByTestId("hypothesis-assessment-badge-H1");
    expect(badge.textContent).toMatch(/Mixed/i);
    expect(document.body.textContent).not.toMatch(/\bEstablished\b/i);
  });

  // HAP-P97-2 — H2 mixed
  it("HAP-P97-2: H2 (mixed) badge renders 'Mixed'", () => {
    render(<HypothesisAssessmentPanel hypotheses={[makeHyp("H2", "mixed")]} />);
    expect(screen.getByTestId("hypothesis-assessment-badge-H2").textContent).toMatch(/Mixed/i);
  });

  // HAP-P97-3 — H3 supported
  it("HAP-P97-3: H3 (supported) badge renders 'Supported'", () => {
    render(<HypothesisAssessmentPanel hypotheses={[makeHyp("H3", "supported")]} />);
    expect(screen.getByTestId("hypothesis-assessment-badge-H3").textContent).toMatch(/Supported/i);
  });

  // HAP-P97-4 — H4 insufficient_evidence
  it("HAP-P97-4: H4 (insufficient_evidence) badge renders 'Insufficient evidence'", () => {
    render(<HypothesisAssessmentPanel hypotheses={[makeHyp("H4", "insufficient_evidence")]} />);
    expect(screen.getByTestId("hypothesis-assessment-badge-H4").textContent).toMatch(/Insufficient evidence/i);
  });

  // HAP-P97-5 — H5 strongly_supported
  it("HAP-P97-5: H5 (strongly_supported) badge renders 'Strongly supported'", () => {
    render(<HypothesisAssessmentPanel hypotheses={[makeHyp("H5", "strongly_supported")]} />);
    expect(screen.getByTestId("hypothesis-assessment-badge-H5").textContent).toMatch(/Strongly supported/i);
  });
});

describe("HypothesisAssessmentPanel — Phase 9.7: env-context vs supporting separation", () => {

  const H1_BOTH = {
    hypothesis_id: "H1",
    label: "H1 label",
    assessment: "mixed",
    evidence_summary: {
      environmental_context_ids:       ["ENV-001", "ENV-002"],
      supporting_evidence_ids:         ["SUP-010"],
      contradicting_evidence_ids:      [],
      non_discriminating_evidence_ids: [],
    },
    limitations: [{ description: "Proxy measurement." }],
    key_observations: [],
  };

  // HAP-P97-6 — env-context and supporting sections are distinct elements
  it("HAP-P97-6: env-context and supporting sections are separate DOM nodes", () => {
    render(<HypothesisAssessmentPanel hypotheses={[H1_BOTH]} />);
    fireEvent.click(screen.getByTestId("hypothesis-header-H1"));
    const env  = screen.getByTestId("env-context-section-H1");
    const supp = screen.getByTestId("supporting-section-H1");
    expect(env).not.toBe(supp);
  });

  // HAP-P97-7 — ENV IDs do not appear inside the supporting section
  it("HAP-P97-7: ENV-001 does not appear inside the supporting-evidence section", () => {
    render(<HypothesisAssessmentPanel hypotheses={[H1_BOTH]} />);
    fireEvent.click(screen.getByTestId("hypothesis-header-H1"));
    const suppSection = screen.getByTestId("supporting-section-H1");
    // ENV-001 is an env-context ID — it must not be in the supporting section
    expect(suppSection.textContent).not.toContain("ENV-001");
    expect(suppSection.textContent).not.toContain("ENV-002");
    // SUP-010 must be in the supporting section
    expect(suppSection.textContent).toContain("SUP-010");
  });

  // HAP-P97-8 — Limitations remain visible after expand (scientific integrity)
  it("HAP-P97-8: limitations are visible after expanding the card", () => {
    render(<HypothesisAssessmentPanel hypotheses={[H1_BOTH]} />);
    fireEvent.click(screen.getByTestId("hypothesis-header-H1"));
    expect(screen.getByTestId("hypothesis-limitations-H1")).toBeTruthy();
    expect(screen.getByTestId("hypothesis-limitation-0").textContent).toContain("Proxy measurement.");
  });
});

describe("HypothesisAssessmentPanel — Phase 9.7: unknown case / no evidence", () => {

  // HAP-P97-9 — Unknown case: hypothesis with no evidence summary renders gracefully
  it("HAP-P97-9: hypothesis without evidence_summary renders without crashing", () => {
    const noSummary = [{
      hypothesis_id: "H99",
      label:         "Unknown hypothesis",
      assessment:    "insufficient_evidence",
      // no evidence_summary provided — unknown case scenario
      limitations: [],
      key_observations: [],
    }];
    render(<HypothesisAssessmentPanel hypotheses={noSummary} />);
    expect(screen.getByTestId("hypothesis-card-H99")).toBeTruthy();
    // Expand — should show no-evidence placeholder
    fireEvent.click(screen.getByTestId("hypothesis-header-H99"));
    expect(screen.getByTestId("no-evidence-H99")).toBeTruthy();
  });

  // HAP-P97-10 — No probability language in any state
  it("HAP-P97-10: no percentage or probability language in any rendered state", () => {
    const hyps = [
      { hypothesis_id: "H1", label: "H1", assessment: "mixed",                evidence_summary: { environmental_context_ids: [], supporting_evidence_ids: [], contradicting_evidence_ids: [], non_discriminating_evidence_ids: [] }, limitations: [], key_observations: [] },
      { hypothesis_id: "H5", label: "H5", assessment: "strongly_supported",   evidence_summary: { environmental_context_ids: [], supporting_evidence_ids: [], contradicting_evidence_ids: [], non_discriminating_evidence_ids: [] }, limitations: [], key_observations: [] },
    ];
    render(<HypothesisAssessmentPanel hypotheses={hyps} />);
    const text = document.body.textContent;
    expect(text).not.toMatch(/\d+(\.\d+)?%/);
    expect(text.toLowerCase()).not.toContain("probability");
    expect(text.toLowerCase()).not.toContain("likelihood");
    expect(text.toLowerCase()).not.toContain("confidence score");
  });
});
