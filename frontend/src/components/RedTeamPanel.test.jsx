import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import RedTeamPanel from "./RedTeamPanel.jsx";

// ── API mock ──────────────────────────────────────────────────────────────────

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    postChallenge: vi.fn(),
  };
});

import { postChallenge } from "../api";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CASE_META = {
  case_id: "galaxy-15",
  scientific_limitations: [
    "GOES-11 EP8 measurements are a proxy ~2° from Galaxy 15; direct in-situ measurements are unavailable.",
    "No spacecraft surface-charging telemetry existed on Galaxy 15 at the time of the anomaly.",
  ],
};

const CASE_META_NO_LIMITATIONS = {
  case_id: "galaxy-15",
  scientific_limitations: [],
};

const TIMELINE_FIXTURE = [
  {
    evidence_id: "E-G15-0001",
    timestamp: "2010-04-05T08:00:00Z",
    source: "GOES11_EP8",
    measurement: "e_flux",
    value: 1500.0,
    unit: "particles/cm2/s/sr",
    resolution: "5min",
    evidence_type: "environmental_observation",
  },
];

const CHALLENGE_DATA_HEURISTIC = {
  source: "heuristic",
  challenged_hypothesis_id: "surface_charging_esd",
  challenges: [
    {
      claim_id: "C1",
      severity: "high",
      challenge: "Elevated flux is consistent with but does not uniquely implicate ESD; SEU is equally consistent.",
      counter_evidence_ids: ["E-G15-0001"],
      missing_evidence: ["Direct spacecraft surface-potential measurement."],
      revised_assessment: "Evidence is consistent with multiple mechanisms; ESD remains plausible but unproven.",
    },
    {
      claim_id: "C2",
      severity: "medium",
      challenge: "Absence of direct data is not evidence for or against the hypothesis.",
      counter_evidence_ids: [],
      missing_evidence: [],
      revised_assessment: "Inconclusive — further data required.",
    },
  ],
  red_team_summary: "The top-ranked hypothesis cannot be confirmed from the available evidence alone.",
  updated_hypotheses: [],
};

const CHALLENGE_DATA_LLM = {
  ...CHALLENGE_DATA_HEURISTIC,
  source: "llm",
};

// ── Helper ────────────────────────────────────────────────────────────────────

function renderPanel(propsOverride = {}) {
  const defaults = {
    onChallengeComplete: vi.fn(),
    challengeData: null,
    timelineData: TIMELINE_FIXTURE,
    caseMeta: CASE_META,
  };
  return render(<RedTeamPanel {...defaults} {...propsOverride} />);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RedTeamPanel", () => {

  beforeEach(() => {
    postChallenge.mockReset();
  });

  // RT-1 — Renders without crashing in the null state
  it("RT-1: renders without crashing when challengeData is null and caseMeta is null", () => {
    render(
      <RedTeamPanel
        onChallengeComplete={vi.fn()}
        challengeData={null}
        timelineData={[]}
        caseMeta={null}
      />
    );
    expect(document.body.querySelector("div")).toBeTruthy();
  });

  // RT-2 — Challenge button present and not loading initially
  it("RT-2: the challenge button is present and not in loading state initially", () => {
    renderPanel();
    const btn = screen.getByRole("button", { name: /Challenge|Red-Team/i });
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).not.toContain("Running");
  });

  // RT-3 — Clicking the button calls postChallenge and shows loading indicator
  it("RT-3: clicking the button calls postChallenge and shows a loading spinner", async () => {
    // Never resolves during this test — keeps loading state visible
    postChallenge.mockImplementation(() => new Promise(() => {}));
    renderPanel();
    const btn = screen.getByRole("button", { name: /Challenge|Red-Team/i });
    fireEvent.click(btn);
    await waitFor(() => expect(btn.disabled).toBe(true));
    expect(document.body.textContent).toContain("Running");
    expect(postChallenge).toHaveBeenCalledTimes(1);
  });

  // RT-4 — onChallengeComplete called with returned data on success
  it("RT-4: onChallengeComplete is called with the API response on success", async () => {
    const onComplete = vi.fn();
    postChallenge.mockResolvedValue(CHALLENGE_DATA_HEURISTIC);
    renderPanel({ onChallengeComplete: onComplete });
    fireEvent.click(screen.getByRole("button", { name: /Challenge|Red-Team/i }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(CHALLENGE_DATA_HEURISTIC));
  });

  // RT-5 — API failure shows error message and button recovers
  it("RT-5: an API failure shows an error message and the button returns to normal", async () => {
    postChallenge.mockRejectedValue(new Error("Network error"));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Challenge|Red-Team/i }));
    await waitFor(() => expect(screen.getByText(/Error/i)).toBeTruthy());
    const btn = screen.getByRole("button", { name: /Challenge|Red-Team/i });
    expect(btn.disabled).toBe(false);
  });

  // RT-6 — Challenged hypothesis ID is displayed when challengeData is provided
  it("RT-6: the challenged hypothesis ID is shown when challengeData is provided", () => {
    renderPanel({ challengeData: CHALLENGE_DATA_HEURISTIC });
    expect(document.body.textContent).toContain("surface charging esd");
  });

  // RT-7 — Heuristic source badge (scientific integrity: source transparency)
  it("RT-7: source badge shows 'Heuristic' when source is not llm", () => {
    renderPanel({ challengeData: CHALLENGE_DATA_HEURISTIC });
    expect(screen.getByText(/Heuristic/i)).toBeTruthy();
  });

  // RT-8 — LLM source badge (scientific integrity: source transparency)
  it("RT-8: source badge shows 'LLM' when source is llm", () => {
    renderPanel({ challengeData: CHALLENGE_DATA_LLM });
    expect(screen.getByText(/LLM/i)).toBeTruthy();
  });

  // RT-9 — One ChallengeCard per challenge entry
  it("RT-9: one challenge card is rendered per entry in challengeData.challenges", () => {
    renderPanel({ challengeData: CHALLENGE_DATA_HEURISTIC });
    // Each card shows "Claim C1", "Claim C2" in collapsed state
    expect(screen.getByText(/Claim C1/)).toBeTruthy();
    expect(screen.getByText(/Claim C2/)).toBeTruthy();
  });

  // RT-10 — Expanding a ChallengeCard reveals challenge text and revised assessment
  it("RT-10: expanding a ChallengeCard reveals challenge text and revised assessment", () => {
    renderPanel({ challengeData: CHALLENGE_DATA_HEURISTIC });
    // Click the first card toggle button (Claim C1)
    const toggleBtn = screen.getByText(/Claim C1/).closest("button");
    fireEvent.click(toggleBtn);
    expect(document.body.textContent).toContain(
      "Elevated flux is consistent with but does not uniquely implicate ESD"
    );
    expect(document.body.textContent).toContain(
      "ESD remains plausible but unproven"
    );
  });

  // RT-11 — Scientific limitations visible when present (scientific integrity)
  it("RT-11: scientific limitations from caseMeta are rendered when present", () => {
    renderPanel({ challengeData: null, caseMeta: CASE_META });
    expect(document.body.textContent).toContain("Scientific Limitations");
    expect(document.body.textContent).toContain(
      "GOES-11 EP8 measurements are a proxy"
    );
    expect(document.body.textContent).toContain(
      "No spacecraft surface-charging telemetry"
    );
  });

  // RT-12 — Scientific limitations section absent when empty
  it("RT-12: scientific limitations section is absent when the array is empty", () => {
    renderPanel({ caseMeta: CASE_META_NO_LIMITATIONS });
    expect(screen.queryByText(/Scientific Limitations/i)).toBeNull();
  });

  // RT-13 — Empty challenges state
  it("RT-13: renders empty-challenges message when challenges array is empty", () => {
    renderPanel({
      challengeData: { ...CHALLENGE_DATA_HEURISTIC, challenges: [] },
    });
    expect(document.body.textContent).toContain("No challenges returned");
  });

  // RT-14 — Red-team summary blockquote is rendered when present
  it("RT-14: the red_team_summary is rendered when present in challengeData", () => {
    renderPanel({ challengeData: CHALLENGE_DATA_HEURISTIC });
    expect(document.body.textContent).toContain(
      "The top-ranked hypothesis cannot be confirmed from the available evidence alone"
    );
  });

  // RT-15 — No numerical probabilities in rendered output (scientific integrity)
  it("RT-15: rendered output contains no percentage or probability strings", () => {
    renderPanel({ challengeData: CHALLENGE_DATA_HEURISTIC });
    const text = document.body.textContent;
    expect(text).not.toMatch(/\d+(\.\d+)?%/);
    expect(text.toLowerCase()).not.toContain("probability");
    expect(text.toLowerCase()).not.toContain("likelihood");
  });

  // RT-16 — No affirmative causal-certainty language (scientific integrity)
  it("RT-16: rendered output does not contain affirmative causal-establishment language", () => {
    renderPanel({ challengeData: CHALLENGE_DATA_HEURISTIC });
    const text = document.body.textContent.toLowerCase();
    expect(text).not.toContain("confirmed cause");
    expect(text).not.toContain("proven cause");
    expect(text).not.toContain("establishes cause");
    // "unproven" is acceptable (it's in the revised_assessment fixture and denies causation)
  });

});

// ===========================================================================
// Phase 9.7 — RedTeamPanel extended coverage
// Targets: investigation state (challenge data wiring), challenge state
// (lifecycle display), unknown case fallback (null caseMeta + null timeline),
// no probability language.
// ===========================================================================

describe("RedTeamPanel — Phase 9.7: investigation and challenge state", () => {

  beforeEach(() => {
    postChallenge.mockReset();
  });

  // RT-P97-1 — Investigation state: challengeData with full lifecycle renders
  it("RT-P97-1: all challenge claims in challengeData are rendered as cards", () => {
    renderPanel({ challengeData: CHALLENGE_DATA_HEURISTIC });
    // Two claim cards
    expect(screen.getByText(/Claim C1/)).toBeTruthy();
    expect(screen.getByText(/Claim C2/)).toBeTruthy();
    // Red-team summary blockquote
    expect(document.body.textContent).toContain(
      "The top-ranked hypothesis cannot be confirmed"
    );
  });

  // RT-P97-2 — Challenge state: severity badges are rendered per claim
  it("RT-P97-2: each challenge card shows the severity badge", () => {
    renderPanel({ challengeData: CHALLENGE_DATA_HEURISTIC });
    // C1 = HIGH, C2 = MEDIUM
    expect(document.body.textContent).toContain("HIGH");
    expect(document.body.textContent).toContain("MEDIUM");
  });

  // RT-P97-3 — Challenge state: expanding C1 shows missing evidence list
  it("RT-P97-3: expanded C1 shows missing evidence item", () => {
    renderPanel({ challengeData: CHALLENGE_DATA_HEURISTIC });
    const toggleBtn = screen.getByText(/Claim C1/).closest("button");
    fireEvent.click(toggleBtn);
    expect(document.body.textContent).toContain(
      "Direct spacecraft surface-potential measurement."
    );
  });

  // RT-P97-4 — Challenge state: expanded C2 shows "None identified" for missing evidence
  it("RT-P97-4: expanded C2 with no missing evidence shows 'None identified'", () => {
    renderPanel({ challengeData: CHALLENGE_DATA_HEURISTIC });
    const toggleBtn = screen.getByText(/Claim C2/).closest("button");
    fireEvent.click(toggleBtn);
    expect(document.body.textContent).toContain("None identified");
  });

  // RT-P97-5 — Unknown case (caseMeta is null, no scientific limitations)
  it("RT-P97-5: null caseMeta renders the panel without a limitations section", () => {
    renderPanel({ caseMeta: null, challengeData: null });
    // No scientific limitations section when caseMeta is null
    expect(screen.queryByText(/Scientific Limitations/i)).toBeNull();
    // Button still present
    expect(screen.getByRole("button", { name: /Challenge|Red-Team/i })).toBeTruthy();
  });

  // RT-P97-6 — Unknown case: empty timelineData does not crash CounterEvidenceTag resolution
  it("RT-P97-6: empty timelineData does not crash when challenge cites a counter-evidence ID", () => {
    const challengeWithCounterEvidence = {
      ...CHALLENGE_DATA_HEURISTIC,
      challenges: [{
        ...CHALLENGE_DATA_HEURISTIC.challenges[0],
        counter_evidence_ids: ["E-UNKNOWN-9999"],  // ID not in empty timeline
      }],
    };
    // Render with empty timeline (unknown case scenario)
    render(
      <RedTeamPanel
        onChallengeComplete={vi.fn()}
        challengeData={challengeWithCounterEvidence}
        timelineData={[]}
        caseMeta={null}
      />
    );
    // Expand the card to trigger counter-evidence rendering
    const toggleBtn = screen.getByText(/Claim C1/).closest("button");
    fireEvent.click(toggleBtn);
    // The evidence ID must still be displayed (no metadata available, but no crash)
    expect(document.body.textContent).toContain("E-UNKNOWN-9999");
  });

  // RT-P97-7 — No causal certainty language in challenge data output
  it("RT-P97-7: no affirmative causal language appears in the challenge panel", () => {
    renderPanel({ challengeData: CHALLENGE_DATA_LLM });
    const text = document.body.textContent.toLowerCase();
    expect(text).not.toContain("proven cause");
    expect(text).not.toContain("confirmed cause");
    expect(text).not.toContain("establishes causation");
    expect(text).not.toMatch(/\d+(\.\d+)?%/);
  });
});
