import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import AIAssistancePanel from "./AIAssistancePanel";

const NARRATIVE = {
  source: "heuristic",
  executive_summary: "Solar particle event caused anomalies.",
  event_description: "Galaxy 15 experienced multiple anomalies.",
  hypothesis_assessments: [
    { hypothesis_id: "H5", assessment: "strongly_supported", reasoning: "SEP flux matches." },
    { hypothesis_id: "H3", assessment: "supported",          reasoning: "Voltage dip observed." },
  ],
  strongest_observations: ["Proton flux exceeded threshold.", "TTC anomaly at peak."],
  major_uncertainties:    ["No direct current measurement."],
  missing_evidence:       ["High-energy particle detector data."],
  causal_attribution_established: false,
};

const ASSISTANCE = {
  source: "heuristic",
  findings_summary:                  "The forensic pipeline identified SEP-related activity.",
  evidence_relationships:            ["TTC anomaly correlates with proton flux."],
  limitations_explained:             ["Kp index is a proxy only."],
  unanswered_questions:              ["Why was the anomaly asymmetric?"],
  challenge_summary:                 "No open challenges.",
  additional_evidence_suggestions:   ["Request NOAA particle log."],
  observation_inconsistencies:       [],
};

describe("AIAssistancePanel", () => {
  // ── Loading state ────────────────────────────────────────────────────────────
  it("renders loading state", () => {
    render(<AIAssistancePanel loading />);
    expect(screen.getByTestId("ai-assistance-loading")).toBeTruthy();
    expect(screen.queryByTestId("ai-assistance-panel")).toBeNull();
  });

  // ── Error state ──────────────────────────────────────────────────────────────
  it("renders error state", () => {
    render(<AIAssistancePanel error="Network failure" />);
    expect(screen.getByTestId("ai-assistance-error")).toBeTruthy();
    expect(screen.getByTestId("ai-assistance-error").textContent).toContain("Network failure");
  });

  // ── Empty state ───────────────────────────────────────────────────────────────
  it("renders empty state when no narrative or assistance", () => {
    render(<AIAssistancePanel />);
    expect(screen.getByTestId("ai-assistance-empty")).toBeTruthy();
  });

  // ── Main panel ───────────────────────────────────────────────────────────────
  it("renders the panel with narrative", () => {
    render(<AIAssistancePanel narrative={NARRATIVE} />);
    expect(screen.getByTestId("ai-assistance-panel")).toBeTruthy();
  });

  // ── Source badge ─────────────────────────────────────────────────────────────
  it("shows source badge when narrative is provided", () => {
    render(<AIAssistancePanel narrative={NARRATIVE} />);
    expect(screen.getByTestId("ai-source-badge")).toBeTruthy();
    expect(screen.getByTestId("ai-source-badge").textContent).toContain("Heuristic synthesis");
  });

  it("shows LLM synthesis badge when source is llm", () => {
    render(<AIAssistancePanel narrative={{ ...NARRATIVE, source: "llm" }} />);
    expect(screen.getByTestId("ai-source-badge").textContent).toContain("LLM synthesis");
  });

  it("labels the panel as AI synthesis — not evidence", () => {
    render(<AIAssistancePanel narrative={NARRATIVE} />);
    expect(screen.getByTestId("ai-assistance-panel").textContent).toContain(
      "AI synthesis layer — not evidence"
    );
  });

  // ── Narrative sections ───────────────────────────────────────────────────────
  it("renders executive summary", () => {
    render(<AIAssistancePanel narrative={NARRATIVE} />);
    expect(screen.getByTestId("narrative-executive-summary").textContent).toBe(
      NARRATIVE.executive_summary
    );
  });

  it("renders event description", () => {
    render(<AIAssistancePanel narrative={NARRATIVE} />);
    expect(screen.getByTestId("narrative-event-description").textContent).toBe(
      NARRATIVE.event_description
    );
  });

  it("renders hypothesis reasoning entries", () => {
    render(<AIAssistancePanel narrative={NARRATIVE} />);
    expect(screen.getByTestId("narrative-hypothesis-H5")).toBeTruthy();
    expect(screen.getByTestId("narrative-reasoning-H5").textContent).toBe("SEP flux matches.");
  });

  it("shows assessment badge on hypothesis entry — read-only", () => {
    render(<AIAssistancePanel narrative={NARRATIVE} />);
    const badge = screen.getByTestId("narrative-assessment-H5");
    expect(badge.textContent).toMatch(/strongly supported/i);
  });

  it("renders strongest observations list", () => {
    render(<AIAssistancePanel narrative={NARRATIVE} />);
    expect(screen.getByTestId("narrative-observations-list")).toBeTruthy();
  });

  it("renders major uncertainties list", () => {
    render(<AIAssistancePanel narrative={NARRATIVE} />);
    expect(screen.getByTestId("narrative-uncertainties-list")).toBeTruthy();
  });

  it("renders missing evidence list", () => {
    render(<AIAssistancePanel narrative={NARRATIVE} />);
    expect(screen.getByTestId("narrative-missing-evidence-list")).toBeTruthy();
  });

  // ── Collapsible sections ─────────────────────────────────────────────────────
  it("collapses a section on click", () => {
    render(<AIAssistancePanel narrative={NARRATIVE} />);
    // Executive summary section button is the first collapsible
    const section = screen.getByTestId("narrative-executive-summary-section");
    const btn = section.querySelector("button");
    // Initially open
    expect(screen.getByTestId("narrative-executive-summary")).toBeTruthy();
    // Click to close
    fireEvent.click(btn);
    expect(screen.queryByTestId("narrative-executive-summary")).toBeNull();
  });

  // ── Assistance section ────────────────────────────────────────────────────────
  it("renders assistance content when assistance is provided", () => {
    render(<AIAssistancePanel narrative={NARRATIVE} assistance={ASSISTANCE} />);
    expect(screen.getByTestId("ai-assistance-content")).toBeTruthy();
  });

  it("renders findings summary", () => {
    render(<AIAssistancePanel narrative={NARRATIVE} assistance={ASSISTANCE} />);
    expect(screen.getByTestId("assistance-findings-summary").textContent).toBe(
      ASSISTANCE.findings_summary
    );
  });

  it("renders evidence relationships", () => {
    render(<AIAssistancePanel narrative={NARRATIVE} assistance={ASSISTANCE} />);
    expect(screen.getByTestId("assistance-evidence-relationships-list")).toBeTruthy();
  });

  it("renders unanswered questions", () => {
    render(<AIAssistancePanel narrative={NARRATIVE} assistance={ASSISTANCE} />);
    expect(screen.getByTestId("assistance-questions-list")).toBeTruthy();
  });

  // ── No probability invariant ─────────────────────────────────────────────────
  it("does not render any probability percentage", () => {
    render(<AIAssistancePanel narrative={NARRATIVE} assistance={ASSISTANCE} />);
    expect(document.body.textContent).not.toMatch(/%/);
  });
});
