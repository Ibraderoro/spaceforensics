import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ChallengesPanel from "./ChallengesPanel";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createChallenge:     vi.fn(),
    patchChallengeStatus: vi.fn(),
  };
});

import { createChallenge, patchChallengeStatus } from "../api";

const CHALLENGES = [
  {
    challenge_id:       "CH-001",
    target_type:        "hypothesis_assessment",
    target_id:          "H1",
    analyst_statement:  "The mixed assessment may underweight recent solar flux data.",
    authored_by:        "analyst-a",
    status:             "open",
    resolution_metadata: null,
    lifecycle: [{ status: "open", timestamp: "2024-01-15T10:00:00Z", actor: "analyst-a" }],
  },
  {
    challenge_id:       "CH-002",
    target_type:        "missing_evidence",
    target_id:          "SEP-LOG-2024",
    analyst_statement:  "NOAA particle log should be requested.",
    authored_by:        "analyst-b",
    status:             "resolved",
    resolution_metadata: { resolution_outcome: "acknowledged" },
    lifecycle: [
      { status: "open",     timestamp: "2024-01-14T09:00:00Z", actor: "analyst-b" },
      { status: "resolved", timestamp: "2024-01-14T12:00:00Z", actor: "lead"      },
    ],
  },
];

describe("ChallengesPanel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ── Empty state ──────────────────────────────────────────────────────────────
  it("renders empty state when no challenges", () => {
    render(<ChallengesPanel caseId="galaxy-15" investigationId="INV-1" challenges={[]} />);
    expect(screen.getByTestId("challenges-empty")).toBeTruthy();
    expect(screen.queryByTestId("challenges-list")).toBeNull();
  });

  it("renders empty state when challenges is undefined", () => {
    render(<ChallengesPanel caseId="galaxy-15" investigationId="INV-1" />);
    expect(screen.getByTestId("challenges-empty")).toBeTruthy();
  });

  // ── Challenge list ───────────────────────────────────────────────────────────
  it("renders challenges list", () => {
    render(<ChallengesPanel caseId="galaxy-15" investigationId="INV-1" challenges={CHALLENGES} />);
    expect(screen.getByTestId("challenges-list")).toBeTruthy();
  });

  it("renders each challenge item", () => {
    render(<ChallengesPanel caseId="galaxy-15" investigationId="INV-1" challenges={CHALLENGES} />);
    expect(screen.getByTestId("challenge-item-CH-001")).toBeTruthy();
    expect(screen.getByTestId("challenge-item-CH-002")).toBeTruthy();
  });

  it("renders challenge statement", () => {
    render(<ChallengesPanel caseId="galaxy-15" investigationId="INV-1" challenges={CHALLENGES} />);
    expect(screen.getByTestId("challenge-statement-CH-001").textContent).toContain(
      "mixed assessment may underweight"
    );
  });

  it("renders challenge status badges", () => {
    render(<ChallengesPanel caseId="galaxy-15" investigationId="INV-1" challenges={CHALLENGES} />);
    expect(screen.getByTestId("challenge-status-CH-001").textContent).toBe("open");
    expect(screen.getByTestId("challenge-status-CH-002").textContent).toBe("resolved");
  });

  it("renders resolution metadata for resolved challenges", () => {
    render(<ChallengesPanel caseId="galaxy-15" investigationId="INV-1" challenges={CHALLENGES} />);
    expect(screen.getByTestId("challenge-resolution-CH-002")).toBeTruthy();
    expect(screen.getByTestId("challenge-resolution-CH-002").textContent).toContain("Acknowledged");
  });

  // ── Lifecycle transitions ────────────────────────────────────────────────────
  it("shows transition buttons for non-terminal challenges", () => {
    render(<ChallengesPanel caseId="galaxy-15" investigationId="INV-1" challenges={CHALLENGES} />);
    // CH-001 is open → can go to under_review or rejected
    expect(screen.getByTestId("challenge-transitions-CH-001")).toBeTruthy();
    expect(screen.getByTestId("transition-btn-CH-001-under_review")).toBeTruthy();
    expect(screen.getByTestId("transition-btn-CH-001-rejected")).toBeTruthy();
  });

  it("does not show transition buttons for terminal challenges (resolved)", () => {
    render(<ChallengesPanel caseId="galaxy-15" investigationId="INV-1" challenges={CHALLENGES} />);
    expect(screen.queryByTestId("challenge-transitions-CH-002")).toBeNull();
  });

  it("calls patchChallengeStatus on transition click", async () => {
    const updated = { ...CHALLENGES[0], status: "under_review" };
    patchChallengeStatus.mockResolvedValueOnce(updated);
    const onTransitioned = vi.fn();

    render(
      <ChallengesPanel
        caseId="galaxy-15"
        investigationId="INV-1"
        challenges={CHALLENGES}
        onChallengeTransitioned={onTransitioned}
      />
    );

    fireEvent.click(screen.getByTestId("transition-btn-CH-001-under_review"));

    await waitFor(() => {
      expect(patchChallengeStatus).toHaveBeenCalledWith(
        "galaxy-15", "INV-1", "CH-001",
        expect.objectContaining({ status: "under_review", actor: "analyst" })
      );
      expect(onTransitioned).toHaveBeenCalledWith(updated);
    });
  });

  // ── Create form toggle ────────────────────────────────────────────────────────
  it("shows create form when New button is clicked", () => {
    render(<ChallengesPanel caseId="galaxy-15" investigationId="INV-1" challenges={[]} />);
    expect(screen.queryByTestId("challenge-form")).toBeNull();
    fireEvent.click(screen.getByTestId("challenges-open-form-btn"));
    expect(screen.getByTestId("challenge-form")).toBeTruthy();
  });

  // ── Form invariants ───────────────────────────────────────────────────────────
  it("challenge form has no assessment field — cannot change deterministic assessments", () => {
    render(<ChallengesPanel caseId="galaxy-15" investigationId="INV-1" challenges={[]} />);
    fireEvent.click(screen.getByTestId("challenges-open-form-btn"));
    const form = screen.getByTestId("challenge-form");
    // No input with 'assessment' in its test-id
    expect(screen.queryByTestId("challenge-assessment-input")).toBeNull();
    // Statement field should exist
    expect(screen.getByTestId("challenge-statement-input")).toBeTruthy();
  });

  it("challenge form shows qualitative-only disclaimer", () => {
    render(<ChallengesPanel caseId="galaxy-15" investigationId="INV-1" challenges={[]} />);
    fireEvent.click(screen.getByTestId("challenges-open-form-btn"));
    expect(screen.getByTestId("challenge-form").textContent).toContain("No numerical probabilities");
  });

  // ── Form validation ────────────────────────────────────────────────────────────
  it("shows form error when submitting with missing target ID", async () => {
    render(<ChallengesPanel caseId="galaxy-15" investigationId="INV-1" challenges={[]} />);
    fireEvent.click(screen.getByTestId("challenges-open-form-btn"));
    fireEvent.click(screen.getByTestId("challenge-submit-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("challenge-form-error")).toBeTruthy();
    });
  });

  it("calls createChallenge on valid submit", async () => {
    const newCh = {
      challenge_id: "CH-003", target_type: "missing_evidence", target_id: "EVT-X",
      analyst_statement: "Data gap.", status: "open",
    };
    createChallenge.mockResolvedValueOnce(newCh);
    const onCreated = vi.fn();

    render(
      <ChallengesPanel
        caseId="galaxy-15"
        investigationId="INV-1"
        challenges={[]}
        onChallengeCreated={onCreated}
      />
    );

    fireEvent.click(screen.getByTestId("challenges-open-form-btn"));
    fireEvent.change(screen.getByTestId("challenge-target-id-input"), {
      target: { value: "EVT-X" },
    });
    fireEvent.change(screen.getByTestId("challenge-statement-input"), {
      target: { value: "Data gap." },
    });
    fireEvent.click(screen.getByTestId("challenge-submit-btn"));

    await waitFor(() => {
      expect(createChallenge).toHaveBeenCalledWith(
        "galaxy-15", "INV-1",
        expect.objectContaining({ target_id: "EVT-X", analyst_statement: "Data gap." })
      );
      expect(onCreated).toHaveBeenCalledWith(newCh);
    });
  });
});
