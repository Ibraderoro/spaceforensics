import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ForensicConclusionPanel from "./ForensicConclusionPanel";

const BASE_CONCLUSION = {
  causal_attribution_established: false,
  causal_attribution_statement: "Causal attribution cannot be established from available evidence.",
  analysis_version: "1.0.0",
  evidence_summary: {
    total_environmental_context: 3,
    total_supporting_evidence: 5,
    total_contradicting_evidence: 1,
    total_non_discriminating_evidence: 2,
    total_limitations: 4,
  },
  comparison: {
    most_supported: "H5",
    supported_hypotheses: ["H5"],
    mixed_hypotheses: ["H1", "H2"],
    insufficient_hypotheses: ["H3", "H4"],
  },
};

describe("ForensicConclusionPanel", () => {
  // ── Empty state ──────────────────────────────────────────────────────────────
  it("renders empty state when no conclusion is provided", () => {
    render(<ForensicConclusionPanel />);
    expect(screen.getByTestId("forensic-conclusion-empty")).toBeTruthy();
    expect(screen.queryByTestId("forensic-conclusion-panel")).toBeNull();
  });

  it("renders empty state when conclusion is null", () => {
    render(<ForensicConclusionPanel forensicConclusion={null} />);
    expect(screen.getByTestId("forensic-conclusion-empty")).toBeTruthy();
  });

  // ── Main panel renders ───────────────────────────────────────────────────────
  it("renders main panel when conclusion is provided", () => {
    render(<ForensicConclusionPanel forensicConclusion={BASE_CONCLUSION} />);
    expect(screen.getByTestId("forensic-conclusion-panel")).toBeTruthy();
  });

  // ── NOT ESTABLISHED invariant ───────────────────────────────────────────────
  it("displays NOT ESTABLISHED when causal_attribution_established is false", () => {
    render(<ForensicConclusionPanel forensicConclusion={BASE_CONCLUSION} />);
    const label = screen.getByTestId("causal-attribution-label");
    expect(label.textContent).toContain("NOT ESTABLISHED");
  });

  it("never displays 'Cause:' label when causal attribution is false", () => {
    render(<ForensicConclusionPanel forensicConclusion={BASE_CONCLUSION} />);
    expect(screen.queryByText(/Cause:/)).toBeNull();
  });

  it("displays ESTABLISHED when causal_attribution_established is true", () => {
    const established = { ...BASE_CONCLUSION, causal_attribution_established: true };
    render(<ForensicConclusionPanel forensicConclusion={established} />);
    const label = screen.getByTestId("causal-attribution-label");
    expect(label.textContent).toContain("ESTABLISHED");
    expect(label.textContent).not.toContain("NOT ESTABLISHED");
  });

  // ── Causal attribution statement ─────────────────────────────────────────────
  it("renders the causal attribution statement", () => {
    render(<ForensicConclusionPanel forensicConclusion={BASE_CONCLUSION} />);
    expect(screen.getByTestId("causal-attribution-statement").textContent).toBe(
      BASE_CONCLUSION.causal_attribution_statement
    );
  });

  // ── Evidence summary counts ───────────────────────────────────────────────────
  it("renders evidence summary counts", () => {
    render(<ForensicConclusionPanel forensicConclusion={BASE_CONCLUSION} />);
    expect(screen.getByTestId("evidence-summary")).toBeTruthy();
    expect(screen.getByTestId("count-environmental-context").textContent).toBe("3");
    expect(screen.getByTestId("count-supporting-evidence").textContent).toBe("5");
    expect(screen.getByTestId("count-contradicting-evidence").textContent).toBe("1");
    expect(screen.getByTestId("count-non-discriminating").textContent).toBe("2");
    expect(screen.getByTestId("count-limitations").textContent).toBe("4");
  });

  // ── No numerical probabilities ───────────────────────────────────────────────
  it("does not render any percentage or probability text", () => {
    render(<ForensicConclusionPanel forensicConclusion={BASE_CONCLUSION} />);
    // No % character anywhere
    expect(document.body.textContent).not.toMatch(/%/);
  });

  // ── Hypothesis comparison ────────────────────────────────────────────────────
  it("renders hypothesis comparison section", () => {
    render(<ForensicConclusionPanel forensicConclusion={BASE_CONCLUSION} />);
    expect(screen.getByTestId("hypothesis-comparison")).toBeTruthy();
  });

  it("shows most-supported hypothesis", () => {
    render(<ForensicConclusionPanel forensicConclusion={BASE_CONCLUSION} />);
    expect(screen.getByTestId("most-supported-hypothesis").textContent).toBe("H5");
  });

  it("renders supported hypothesis badges", () => {
    render(<ForensicConclusionPanel forensicConclusion={BASE_CONCLUSION} />);
    expect(screen.getByTestId("supported-badge-H5")).toBeTruthy();
  });

  it("renders mixed hypothesis badges", () => {
    render(<ForensicConclusionPanel forensicConclusion={BASE_CONCLUSION} />);
    expect(screen.getByTestId("mixed-badge-H1")).toBeTruthy();
    expect(screen.getByTestId("mixed-badge-H2")).toBeTruthy();
  });

  it("renders insufficient hypothesis badges", () => {
    render(<ForensicConclusionPanel forensicConclusion={BASE_CONCLUSION} />);
    expect(screen.getByTestId("insufficient-badge-H3")).toBeTruthy();
    expect(screen.getByTestId("insufficient-badge-H4")).toBeTruthy();
  });

  // ── Minimal conclusion (no evidence_summary, no comparison) ─────────────────
  it("renders without crashing when evidence_summary is absent", () => {
    const minimal = {
      causal_attribution_established: false,
      causal_attribution_statement: "Cannot determine.",
    };
    render(<ForensicConclusionPanel forensicConclusion={minimal} />);
    expect(screen.getByTestId("forensic-conclusion-panel")).toBeTruthy();
    expect(screen.queryByTestId("evidence-summary")).toBeNull();
  });
});
