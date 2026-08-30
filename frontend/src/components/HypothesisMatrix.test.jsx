import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import HypothesisMatrix from "./HypothesisMatrix.jsx";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * Timeline data used to populate evidenceById lookup inside the component.
 * Must contain every evidence_id referenced in the hypotheses fixture.
 */
const TIMELINE_FIXTURE = [
  {
    evidence_id: "E-G15-0001",
    timestamp: "2010-04-05T08:00:00Z",
    source: "GOES11_EP8",
    measurement: "e_flux",
    value: 1500.5,
    unit: "particles/cm2/s/sr",
    resolution: "5min",
    evidence_type: "environmental_observation",
  },
  {
    evidence_id: "E-G15-0010",
    timestamp: "2010-04-05T09:48:00Z",
    source: "CASE",
    measurement: "command_loss_event",
    value: 1,
    unit: null,
    resolution: "point",
    evidence_type: "case_event",
  },
];

/**
 * Pass 1 hypothesis fixture.  Three hypotheses with distinct assessments,
 * confidence levels, and evidence profiles, ordered by descending confidence
 * so HM-17 (sort order) can be verified.
 *
 * These use the Pass 1 AI claim model (supports / contradicts / non_discriminating)
 * which is distinct from the four-category forensic graph model.
 */
const HYPOTHESES_FIXTURE = [
  {
    hypothesis_id: "surface_charging_esd",
    id: "surface_charging_esd",
    label: "Surface charging / ESD",
    assessment: "mixed",
    confidence: 0.45,
    claims: [
      {
        claim_id: "C1",
        statement: "Elevated 1 MeV electron flux observed in the hours preceding the anomaly.",
        uncertainty: "observed",
        relationship: "supports",
        evidence_ids: ["E-G15-0001"],
        reasoning: "GOES-11 EP8 data shows elevated flux.",
      },
      {
        claim_id: "C2",
        statement: "No direct in-situ surface charging measurement available for Galaxy 15.",
        uncertainty: "unknown",
        relationship: "non_discriminating",
        evidence_ids: [],
        reasoning: "Absence of direct data limits discriminating power.",
      },
    ],
    missing_evidence: ["In-situ spacecraft surface-potential telemetry."],
    limitations: [
      "GOES-11 EP8 is a proxy measurement ~2° longitude from Galaxy 15.",
      "No spacecraft surface-charging telemetry exists for Galaxy 15.",
    ],
  },
  {
    hypothesis_id: "single_event_upset",
    id: "single_event_upset",
    label: "Single event upset (SEU)",
    assessment: "weakly_supported",
    confidence: 0.30,
    claims: [
      {
        claim_id: "C3",
        statement: "The anomaly is consistent with an SEU in command-processing circuitry.",
        uncertainty: "inferred",
        relationship: "supports",
        evidence_ids: ["E-G15-0010"],
        reasoning: "Loss of command response is consistent with SEU.",
      },
    ],
    missing_evidence: [],
    limitations: [],
  },
  {
    hypothesis_id: "hardware_failure",
    id: "hardware_failure",
    label: "Hardware or firmware latent fault",
    assessment: "insufficient_evidence",
    confidence: 0.15,
    claims: [],
    missing_evidence: [],
    limitations: [],
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function renderMatrix(hypothesesOverride, timelineOverride) {
  const hypotheses = hypothesesOverride ?? HYPOTHESES_FIXTURE;
  const timelineData = timelineOverride ?? TIMELINE_FIXTURE;
  return render(
    <HypothesisMatrix hypotheses={hypotheses} timelineData={timelineData} />
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("HypothesisMatrix", () => {

  // ── Empty-state tests ──────────────────────────────────────────────────────

  // HM-1 — Empty state when hypotheses is null
  it("HM-1: renders the 'Investigate' prompt when hypotheses is null", () => {
    render(<HypothesisMatrix hypotheses={null} timelineData={[]} />);
    expect(screen.getByText(/Investigate/i)).toBeTruthy();
  });

  // HM-2 — Empty state when hypotheses is an empty array
  it("HM-2: renders the 'Investigate' prompt when hypotheses is an empty array", () => {
    render(<HypothesisMatrix hypotheses={[]} timelineData={[]} />);
    expect(screen.getByText(/Investigate/i)).toBeTruthy();
  });

  // ── Structural tests ───────────────────────────────────────────────────────

  // HM-3 — One card per hypothesis
  it("HM-3: renders one card for each hypothesis in the input array", () => {
    const { container } = renderMatrix();
    // Each HypothesisCard has a border-slate-700 rounded-lg div — count via labels
    expect(screen.getByText("Surface charging / ESD")).toBeTruthy();
    expect(screen.getByText("Single event upset (SEU)")).toBeTruthy();
    expect(screen.getByText("Hardware or firmware latent fault")).toBeTruthy();
  });

  // HM-4 — Each card shows its label text
  it("HM-4: each card shows the hypothesis label text", () => {
    renderMatrix();
    for (const h of HYPOTHESES_FIXTURE) {
      expect(screen.getByText(h.label)).toBeTruthy();
    }
  });

  // ── Assessment vocabulary tests (scientific integrity) ────────────────────

  // HM-5 — Correct canonical assessment labels for each vocabulary term
  it("HM-5: assessment badges render the correct canonical label for each assessment value", () => {
    const allAssessments = [
      { hypothesis_id: "A", id: "A", label: "A", assessment: "strongly_supported",    confidence: 5, claims: [], missing_evidence: [], limitations: [] },
      { hypothesis_id: "B", id: "B", label: "B", assessment: "supported",             confidence: 4, claims: [], missing_evidence: [], limitations: [] },
      { hypothesis_id: "C", id: "C", label: "C", assessment: "mixed",                 confidence: 3, claims: [], missing_evidence: [], limitations: [] },
      { hypothesis_id: "D", id: "D", label: "D", assessment: "weakly_supported",      confidence: 2, claims: [], missing_evidence: [], limitations: [] },
      { hypothesis_id: "E", id: "E", label: "E", assessment: "insufficient_evidence", confidence: 1, claims: [], missing_evidence: [], limitations: [] },
    ];
    renderMatrix(allAssessments);
    expect(screen.getByText("Strongly supported")).toBeTruthy();
    expect(screen.getByText("Supported")).toBeTruthy();
    expect(screen.getByText("Mixed")).toBeTruthy();
    expect(screen.getByText("Weakly supported")).toBeTruthy();
    expect(screen.getByText("Insufficient evidence")).toBeTruthy();
  });

  // HM-6 — Raw assessment keys never appear as displayed text
  it("HM-6: raw assessment key strings are never rendered as visible text", () => {
    renderMatrix();
    const text = document.body.textContent;
    expect(text).not.toContain("strongly_supported");
    expect(text).not.toContain("weakly_supported");
    expect(text).not.toContain("insufficient_evidence");
  });

  // ── Causal attribution tests (scientific integrity) ───────────────────────

  // HM-7 — Every card renders "Not established" for causal attribution
  it("HM-7: every hypothesis card shows causal attribution as 'Not established'", () => {
    renderMatrix();
    const notEstablishedMatches = screen.getAllByText(/Not established/i);
    // One per hypothesis card
    expect(notEstablishedMatches.length).toBeGreaterThanOrEqual(HYPOTHESES_FIXTURE.length);
  });

  // HM-8 — No card renders "Established" (without "Not") for causal attribution
  it("HM-8: no card renders bare 'Established' for causal attribution", () => {
    renderMatrix();
    const text = document.body.textContent;
    // "Not established" is allowed; "Established" without "Not" preceding it is not
    // We check that "Established" only appears after "Not"
    const matches = [...text.matchAll(/\bEstablished\b/gi)];
    for (const match of matches) {
      const preceding = text.slice(Math.max(0, match.index - 10), match.index);
      expect(preceding.toLowerCase()).toContain("not");
    }
  });

  // ── Probability / numeric tests (scientific integrity) ────────────────────

  // HM-9 — Evidence count chips show counts only — no percentage strings
  it("HM-9: evidence count chips contain integers only, no percentages", () => {
    renderMatrix();
    const text = document.body.textContent;
    expect(text).not.toMatch(/\d+(\.\d+)?%/);
    expect(text.toLowerCase()).not.toContain("probability");
    expect(text.toLowerCase()).not.toContain("likelihood");
    expect(text.toLowerCase()).not.toContain("confidence score");
  });

  // ── Limitations visibility tests (scientific integrity) ───────────────────

  // HM-10 — Limitations are visible in the expanded state when present
  it("HM-10: limitations are visible when the card is expanded", () => {
    renderMatrix();
    // The first card (highest confidence) is expanded by default (defaultExpanded=true)
    // Surface charging / ESD has two limitations
    const text = document.body.textContent;
    expect(text).toContain("GOES-11 EP8 is a proxy measurement");
    expect(text).toContain("No spacecraft surface-charging telemetry");
  });

  // HM-11 — Limitations section absent when limitations array is empty
  it("HM-11: 'Data limitations' heading absent for hypothesis with no limitations", () => {
    // Render only the hardware_failure hypothesis which has limitations: []
    renderMatrix([HYPOTHESES_FIXTURE[2]]);
    // The card starts expanded (idx=0 → defaultExpanded=true)
    // "Data limitations" section heading must not appear
    expect(screen.queryByText(/Data limitations/i)).toBeNull();
  });

  // ── Expand/collapse tests ─────────────────────────────────────────────────

  // HM-12 — Expand/collapse toggle reveals and hides claims
  it("HM-12: clicking the expand toggle reveals the claims section", () => {
    // Render only the SEU hypothesis (idx=0 → expanded by default)
    renderMatrix([HYPOTHESES_FIXTURE[1]]);
    // Starts expanded — claims section visible
    expect(document.body.textContent).toContain("Claims");
    // Click to collapse
    const toggleButton = screen.getByText(/Hide evidence|Show evidence/i);
    fireEvent.click(toggleButton);
    // Claims section heading gone after collapse
    expect(document.body.textContent).not.toContain("Claims (1)");
    // Click to re-expand
    fireEvent.click(screen.getByText(/Show evidence/i));
    expect(document.body.textContent).toContain("Claims");
  });

  // HM-13 — First card (highest confidence) is expanded by default
  it("HM-13: the first card (highest confidence) is expanded by default", () => {
    renderMatrix();
    // Surface charging / ESD has confidence=0.45 (highest) → its claims should be visible
    expect(document.body.textContent).toContain("Elevated 1 MeV electron flux");
  });

  // ── Causal language test (scientific integrity) ───────────────────────────

  // HM-14 — No affirmative causal-certainty language outside "Not established"
  it("HM-14: no affirmative causal-certainty language outside of 'Not established'", () => {
    renderMatrix();
    const text = document.body.textContent.toLowerCase();
    expect(text).not.toContain("confirmed cause");
    expect(text).not.toContain("proven cause");
    expect(text).not.toContain("establishes cause");
  });

  // ── Claim relationship label tests (scientific integrity) ─────────────────

  // HM-15 — Claim relationship chips use display labels, not raw keys
  it("HM-15: claim relationship chips show display labels, not raw relationship key strings", () => {
    renderMatrix();
    const text = document.body.textContent;
    // Display labels must be present for the claims in fixture
    expect(text).toContain("Supports");
    expect(text).toContain("Non-discriminating");
    // Raw keys must not appear as rendered text
    expect(text).not.toContain("non_discriminating");
    expect(text).not.toContain("_discriminating");
  });

  // ── Empty claims test ─────────────────────────────────────────────────────

  // HM-16 — Hypothesis with no claims shows empty-claims placeholder
  it("HM-16: a hypothesis with no claims shows the empty-claims message", () => {
    // hardware_failure has claims: []
    renderMatrix([HYPOTHESES_FIXTURE[2]]);
    // Expanded by default (idx=0)
    expect(document.body.textContent).toContain("No claim-level evidence available");
  });

  // ── Sort order test ───────────────────────────────────────────────────────

  // HM-17 — Cards are sorted by descending confidence
  it("HM-17: cards are sorted by descending confidence value", () => {
    renderMatrix();
    const labels = document.body.querySelectorAll
      ? Array.from(
          document.body.querySelectorAll(".bg-slate-800.rounded-lg span.font-mono")
        ).map((el) => el.textContent.trim())
      : [];
    // Find relative order of the three hypothesis labels in the rendered text
    const text = document.body.textContent;
    const posESD = text.indexOf("Surface charging / ESD");
    const posSEU = text.indexOf("Single event upset (SEU)");
    const posHW  = text.indexOf("Hardware or firmware latent fault");
    // ESD (0.45) should appear before SEU (0.30) which appears before HW (0.15)
    expect(posESD).toBeLessThan(posSEU);
    expect(posSEU).toBeLessThan(posHW);
  });

});

// ===========================================================================
// Phase 9.7 — HypothesisMatrix extended coverage
// Targets: unknown case, H1/H2/H3/H4/H5 categorical assessment rendering,
// investigation state wiring, env-context vs supporting-evidence separation.
// ===========================================================================

describe("HypothesisMatrix — Phase 9.7: all five canonical assessment values", () => {

  // HM-P97-1 — H1 must render Mixed, never Established/Confirmed/Strongly supported
  it("HM-P97-1: H1-equivalent (mixed) renders 'Mixed' — never 'Established'", () => {
    const h1 = [{
      hypothesis_id: "H1", id: "H1", label: "H1 label",
      assessment: "mixed", confidence: 0.4,
      claims: [], missing_evidence: [], limitations: [],
    }];
    renderMatrix(h1);
    expect(screen.getByText("Mixed")).toBeTruthy();
    const text = document.body.textContent;
    expect(text).not.toContain("Established");
    expect(text).not.toContain("Confirmed");
    expect(text).not.toContain("Strongly supported");
  });

  // HM-P97-2 — H2 must also render Mixed
  it("HM-P97-2: H2-equivalent (mixed) renders 'Mixed'", () => {
    const h2 = [{
      hypothesis_id: "H2", id: "H2", label: "H2 label",
      assessment: "mixed", confidence: 0.35,
      claims: [], missing_evidence: [], limitations: [],
    }];
    renderMatrix(h2);
    expect(screen.getByText("Mixed")).toBeTruthy();
  });

  // HM-P97-3 — H3 renders Supported
  it("HM-P97-3: H3-equivalent (supported) renders 'Supported'", () => {
    const h3 = [{
      hypothesis_id: "H3", id: "H3", label: "H3 label",
      assessment: "supported", confidence: 0.6,
      claims: [], missing_evidence: [], limitations: [],
    }];
    renderMatrix(h3);
    expect(screen.getByText("Supported")).toBeTruthy();
  });

  // HM-P97-4 — H4 renders Insufficient evidence
  it("HM-P97-4: H4-equivalent (insufficient_evidence) renders 'Insufficient evidence'", () => {
    const h4 = [{
      hypothesis_id: "H4", id: "H4", label: "H4 label",
      assessment: "insufficient_evidence", confidence: 0.1,
      claims: [], missing_evidence: [], limitations: [],
    }];
    renderMatrix(h4);
    expect(screen.getByText("Insufficient evidence")).toBeTruthy();
  });

  // HM-P97-5 — H5 renders Strongly supported
  it("HM-P97-5: H5-equivalent (strongly_supported) renders 'Strongly supported'", () => {
    const h5 = [{
      hypothesis_id: "H5", id: "H5", label: "H5 label",
      assessment: "strongly_supported", confidence: 0.85,
      claims: [], missing_evidence: [], limitations: [],
    }];
    renderMatrix(h5);
    expect(screen.getByText("Strongly supported")).toBeTruthy();
  });

  // HM-P97-6 — Causal attribution stays NOT ESTABLISHED for all assessments
  it("HM-P97-6: causal attribution is 'Not established' even for strongly_supported", () => {
    const h5 = [{
      hypothesis_id: "H5", id: "H5", label: "H5 label",
      assessment: "strongly_supported", confidence: 0.85,
      claims: [], missing_evidence: [], limitations: [],
    }];
    renderMatrix(h5);
    expect(screen.getByText(/Not established/i)).toBeTruthy();
    // "Strongly supported" for assessment is fine; "Established" for causal is not.
    const text = document.body.textContent;
    // The word "Established" must only appear after "Not"
    const matches = [...text.matchAll(/\bEstablished\b/gi)];
    for (const m of matches) {
      const preceding = text.slice(Math.max(0, m.index - 10), m.index);
      expect(preceding.toLowerCase()).toContain("not");
    }
  });
});

describe("HypothesisMatrix — Phase 9.7: investigation state + empty evidence", () => {

  // HM-P97-7 — Investigation state: renders correctly when passed as part of multi-card layout
  it("HM-P97-7: all five Galaxy-15 hypothesis IDs render in a single pass", () => {
    const allFive = [
      { hypothesis_id: "H1", id: "H1", label: "Spacecraft charging / ESD", assessment: "mixed",                confidence: 0.45, claims: [], missing_evidence: [], limitations: [] },
      { hypothesis_id: "H2", id: "H2", label: "Single event upset (SEU)",  assessment: "mixed",                confidence: 0.30, claims: [], missing_evidence: [], limitations: [] },
      { hypothesis_id: "H3", id: "H3", label: "Solar array anomaly",        assessment: "supported",            confidence: 0.60, claims: [], missing_evidence: [], limitations: [] },
      { hypothesis_id: "H4", id: "H4", label: "Battery fault",              assessment: "insufficient_evidence", confidence: 0.10, claims: [], missing_evidence: [], limitations: [] },
      { hypothesis_id: "H5", id: "H5", label: "SEP event",                  assessment: "strongly_supported",   confidence: 0.85, claims: [], missing_evidence: [], limitations: [] },
    ];
    renderMatrix(allFive);
    const text = document.body.textContent;
    // Each label must appear
    expect(text).toContain("Spacecraft charging / ESD");
    expect(text).toContain("Single event upset (SEU)");
    expect(text).toContain("Solar array anomaly");
    expect(text).toContain("Battery fault");
    expect(text).toContain("SEP event");
    // Each assessment label
    expect(text).toContain("Mixed");
    expect(text).toContain("Supported");
    expect(text).toContain("Insufficient evidence");
    expect(text).toContain("Strongly supported");
    // All have causal Not established
    const notEstablished = screen.getAllByText(/Not established/i);
    expect(notEstablished.length).toBeGreaterThanOrEqual(5);
  });

  // HM-P97-8 — Empty evidence (no claims) renders the empty-claims placeholder
  it("HM-P97-8: hypothesis with empty claims renders placeholder, not undefined", () => {
    const noEvidence = [{
      hypothesis_id: "H4", id: "H4", label: "Battery fault",
      assessment: "insufficient_evidence", confidence: 0.1,
      claims: [], missing_evidence: [], limitations: [],
    }];
    renderMatrix(noEvidence);
    // First card is expanded by default — empty claims message must appear
    expect(document.body.textContent).toContain("No claim-level evidence available");
  });

  // HM-P97-9 — Unknown-case scenario: timeline is empty → evidence shows "record not found"
  it("HM-P97-9: evidence record not found in timeline renders graceful fallback", () => {
    // Single hypothesis with a claim citing evidence not in the timeline
    const hyp = [{
      hypothesis_id: "H1", id: "H1", label: "H1 label",
      assessment: "mixed", confidence: 0.5,
      claims: [{
        claim_id: "C1",
        statement: "Some claim.",
        uncertainty: "inferred",
        relationship: "supports",
        evidence_ids: ["E-UNKNOWN-9999"],
        reasoning: "Proxy data.",
      }],
      missing_evidence: [], limitations: [],
    }];
    // Pass empty timeline — no evidence records are available (unknown case scenario)
    renderMatrix(hyp, []);
    // The card is expanded by default — must render without crashing
    expect(document.body.textContent).toContain("E-UNKNOWN-9999");
    expect(document.body.textContent).toContain("record not found in timeline");
  });
});
