import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ReportModal from "./ReportModal.jsx";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CASE_META = {
  case_id: "galaxy-15",
  title: "Galaxy 15 Anomaly — April 2010",
  target_asset: {
    name: "Galaxy 15",
    alias: "AMC-15",
    norad_id: 28884,
    orbit_type: "GEO",
    longitude_deg_west: 133,
    operator: "Intelsat",
    spacecraft_bus: "LS-1300",
  },
  data_window: {
    start: "2010-04-05T08:00:00Z",
    end: "2010-04-05T11:00:00Z",
    duration_minutes: 180,
  },
  data_sources: [
    { dataset_id: "GOES11_K0_EP8",  description: "GOES-11 energetic particle detector (1 MeV electrons)" },
    { dataset_id: "GOES11_K0_MAG",  description: "GOES-11 magnetometer (B-field components)" },
    { dataset_id: "GOES11_EPHEM",   description: "GOES-11 ephemeris (orbital position)" },
  ],
  scientific_limitations: [
    "GOES-11 EP8 measurements are a proxy ~2° from Galaxy 15; direct in-situ measurements are unavailable.",
    "No spacecraft surface-charging telemetry existed on Galaxy 15.",
  ],
};

const CASE_META_NO_LIMITATIONS = {
  ...CASE_META,
  scientific_limitations: [],
};

/**
 * Pass 1 hypothesis fixture — three hypotheses with distinct assessments.
 * Confidence is used for sorting (descending).
 */
const HYPOTHESES_FIXTURE = [
  {
    hypothesis_id: "H1",
    id: "H1",
    label: "Spacecraft charging / ESD",
    assessment: "mixed",
    confidence: 0.45,
    claims: [
      {
        claim_id: "C1",
        statement: "Elevated 1 MeV electron flux observed.",
        uncertainty: "observed",
        relationship: "supports",
        evidence_ids: ["E-G15-0001"],
        reasoning: "GOES-11 data shows elevated flux.",
      },
    ],
    missing_evidence: ["In-situ surface-potential telemetry."],
    limitations: [
      "GOES-11 EP8 is a proxy measurement ~2° from Galaxy 15.",
      "No direct charging telemetry available.",
    ],
  },
  {
    hypothesis_id: "H2",
    id: "H2",
    label: "Single event upset (SEU)",
    assessment: "weakly_supported",
    confidence: 0.30,
    claims: [],
    missing_evidence: [],
    limitations: [],
  },
  {
    hypothesis_id: "H3",
    id: "H3",
    label: "Hardware latent fault",
    assessment: "insufficient_evidence",
    confidence: 0.15,
    claims: [],
    missing_evidence: [],
    limitations: [],
  },
];

const CHALLENGE_DATA = {
  source: "heuristic",
  challenged_hypothesis_id: "H1",
  challenges: [
    {
      claim_id: "C1",
      severity: "high",
      challenge: "Elevated flux does not uniquely implicate ESD.",
      counter_evidence_ids: [],
      missing_evidence: ["Direct surface-potential data."],
      revised_assessment: "ESD remains plausible but unconfirmed by available evidence.",
    },
  ],
  updated_hypotheses: [
    {
      hypothesis_id: "H1",
      id: "H1",
      label: "Spacecraft charging / ESD",
      assessment: "mixed",
      confidence: 0.40,
    },
    {
      hypothesis_id: "H2",
      id: "H2",
      label: "Single event upset (SEU)",
      assessment: "weakly_supported",
      confidence: 0.30,
    },
  ],
  red_team_summary: "No single hypothesis is established as the definitive cause.",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function renderModal(propsOverride = {}) {
  const defaults = {
    isOpen: true,
    onClose: vi.fn(),
    caseMeta: CASE_META,
    hypotheses: HYPOTHESES_FIXTURE,
    challengeData: null,
  };
  return render(<ReportModal {...defaults} {...propsOverride} />);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ReportModal", () => {

  // RM-1 — Returns null when isOpen is false
  it("RM-1: renders nothing when isOpen is false", () => {
    const { container } = render(
      <ReportModal
        isOpen={false}
        onClose={vi.fn()}
        caseMeta={CASE_META}
        hypotheses={HYPOTHESES_FIXTURE}
        challengeData={null}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  // RM-2 — Renders the modal when isOpen is true
  it("RM-2: renders the modal body when isOpen is true", () => {
    renderModal();
    expect(screen.getByText(/Forensic Summary Report/i)).toBeTruthy();
  });

  // RM-3 — Close button calls onClose
  it("RM-3: the close button calls onClose", () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    // The X close button (no text label — find by role or proximity)
    const buttons = screen.getAllByRole("button");
    const closeBtn = buttons.find(
      (b) => b.getAttribute("aria-label") === "close" || b.querySelector("svg")
    );
    // Find via title or the X icon button (last button in the toolbar)
    const toolbarButtons = document.querySelectorAll(
      ".border-b button, .flex.items-center.gap-3 button"
    );
    // Click the last button in the top bar (the X button)
    const lastToolbarBtn = Array.from(toolbarButtons).pop();
    if (lastToolbarBtn) fireEvent.click(lastToolbarBtn);
    expect(onClose).toHaveBeenCalled();
  });

  // RM-4 — Case ID rendered in Section 1
  it("RM-4: the case ID from caseMeta is rendered in Section 1", () => {
    renderModal();
    expect(document.body.textContent).toContain("galaxy-15");
  });

  // RM-5 — Asset name and orbit in Section 1
  it("RM-5: asset name and orbit type are rendered in Section 1", () => {
    renderModal();
    const text = document.body.textContent;
    expect(text).toContain("Galaxy 15");
    expect(text).toContain("GEO");
    expect(text).toContain("133");
  });

  // RM-6 — Data sources from caseMeta appear in Section 2 (scientific integrity)
  it("RM-6: data source dataset IDs from caseMeta appear in Section 2", () => {
    renderModal();
    const text = document.body.textContent;
    expect(text).toContain("GOES11_K0_EP8");
    expect(text).toContain("GOES11_K0_MAG");
  });

  // RM-7 — "Investigation not yet run" when hypotheses is null
  it("RM-7: Section 3 shows 'Investigation not yet run' when hypotheses is null", () => {
    renderModal({ hypotheses: null });
    expect(screen.getByText(/Investigation not yet run/i)).toBeTruthy();
  });

  // RM-8 — One block per hypothesis when hypotheses is populated
  it("RM-8: Section 3 renders one block per hypothesis", () => {
    renderModal();
    const text = document.body.textContent;
    expect(text).toContain("Spacecraft charging / ESD");
    expect(text).toContain("Single event upset (SEU)");
    expect(text).toContain("Hardware latent fault");
  });

  // RM-9 — Correct canonical assessment labels (scientific integrity)
  it("RM-9: hypothesis blocks render canonical assessment labels, not raw keys", () => {
    renderModal();
    const text = document.body.textContent;
    expect(text).toContain("Mixed");
    expect(text).toContain("Weakly supported");
    expect(text).toContain("Insufficient evidence");
    // Raw keys must not appear as visible text
    expect(text).not.toContain("weakly_supported");
    expect(text).not.toContain("insufficient_evidence");
  });

  // RM-10 — Every hypothesis block renders "Not established" (scientific integrity)
  it("RM-10: every hypothesis block shows 'Not established' for causal attribution", () => {
    renderModal();
    const matches = screen.getAllByText(/Not established/i);
    // At least one per hypothesis
    expect(matches.length).toBeGreaterThanOrEqual(HYPOTHESES_FIXTURE.length);
  });

  // RM-11 — No block renders bare "Established" (scientific integrity)
  it("RM-11: no hypothesis block renders bare 'Established' for causal attribution", () => {
    renderModal();
    const text = document.body.textContent;
    // Every occurrence of "Established" must be preceded by "Not"
    const matches = [...text.matchAll(/\bEstablished\b/gi)];
    for (const match of matches) {
      const preceding = text.slice(Math.max(0, match.index - 10), match.index);
      expect(preceding.toLowerCase()).toContain("not");
    }
  });

  // RM-12 — Limitations visible in hypothesis block when present (scientific integrity)
  it("RM-12: hypothesis limitations are visible in the exported report", () => {
    renderModal();
    const text = document.body.textContent;
    expect(text).toContain("GOES-11 EP8 is a proxy measurement ~2° from Galaxy 15.");
    expect(text).toContain("No direct charging telemetry available.");
  });

  // RM-13 — Section 4 shows "not yet run" when challengeData is null
  it("RM-13: Section 4 shows 'Red-team challenge not yet run' when challengeData is null", () => {
    renderModal({ challengeData: null });
    expect(screen.getByText(/Red-team challenge not yet run/i)).toBeTruthy();
  });

  // RM-14 — Section 4 renders challenged hypothesis and source (scientific integrity)
  it("RM-14: Section 4 renders the challenged hypothesis ID and source", () => {
    renderModal({ challengeData: CHALLENGE_DATA });
    const text = document.body.textContent;
    expect(text).toContain("H1");
    expect(text).toContain("heuristic");
  });

  // RM-15 — Section 5 renders scientific limitations when present (scientific integrity)
  it("RM-15: Section 5 renders scientific limitations when caseMeta has them", () => {
    renderModal();
    expect(screen.getByText(/Scientific Limitations/i)).toBeTruthy();
    const text = document.body.textContent;
    expect(text).toContain("GOES-11 EP8 measurements are a proxy");
    expect(text).toContain("No spacecraft surface-charging telemetry");
  });

  // RM-16 — Section 5 absent when limitations is empty
  it("RM-16: Section 5 is absent when caseMeta.scientific_limitations is empty", () => {
    renderModal({ caseMeta: CASE_META_NO_LIMITATIONS });
    // "Scientific Limitations" heading must not appear
    expect(screen.queryByText(/Scientific Limitations/i)).toBeNull();
  });

  // RM-17 — No numerical probabilities anywhere (scientific integrity — highest priority)
  it("RM-17: no percentage or probability strings appear in the exported report", () => {
    renderModal({ challengeData: CHALLENGE_DATA });
    const text = document.body.textContent;
    expect(text).not.toMatch(/\d+(\.\d+)?%/);
    expect(text.toLowerCase()).not.toContain("probability");
    expect(text.toLowerCase()).not.toContain("likelihood");
    expect(text.toLowerCase()).not.toContain("confidence score");
  });

  // RM-18 — No affirmative causal-certainty language (scientific integrity)
  it("RM-18: no affirmative causal-certainty language appears outside of 'Not established'", () => {
    renderModal({ challengeData: CHALLENGE_DATA });
    const text = document.body.textContent.toLowerCase();
    expect(text).not.toContain("confirmed cause");
    expect(text).not.toContain("proven cause");
    expect(text).not.toContain("establishes cause");
  });

  // RM-19 — Hypotheses sorted by descending confidence in Section 3
  it("RM-19: Section 3 hypotheses are sorted by descending confidence", () => {
    renderModal();
    const text = document.body.textContent;
    const posH1 = text.indexOf("Spacecraft charging / ESD");
    const posH2 = text.indexOf("Single event upset (SEU)");
    const posH3 = text.indexOf("Hardware latent fault");
    // H1 (0.45) → H2 (0.30) → H3 (0.15)
    expect(posH1).toBeLessThan(posH2);
    expect(posH2).toBeLessThan(posH3);
  });

  // RM-20 — Updated assessments table renders when updated_hypotheses is non-empty (scientific integrity)
  it("RM-20: Section 4 renders the updated assessments table when updated_hypotheses is present", () => {
    renderModal({ challengeData: CHALLENGE_DATA });
    // The table header "Updated Assessment" must appear
    expect(screen.getByText(/Updated Assessment/i)).toBeTruthy();
    // The updated hypothesis labels must appear in the table
    const text = document.body.textContent;
    // H1 updated label is present multiple times (header + table row)
    expect(text).toContain("Spacecraft charging / ESD");
  });

  // RM-21 — Print/Save PDF button is present and functional
  it("RM-21: Print/Save PDF button is present in the modal toolbar", () => {
    renderModal();
    expect(screen.getByText(/Print \/ Save PDF/i)).toBeTruthy();
  });

});
