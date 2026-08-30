import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ObservationsPanel from "./ObservationsPanel";

// Mock the api module
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createObservation: vi.fn(),
  };
});

import { createObservation } from "../api";

const OBSERVATIONS = [
  {
    observation_id: "OBS-001",
    authored_by:    "analyst-a",
    authored_at:    "2024-01-15T10:00:00Z",
    status:         "published",
    current_text:   "Solar particle event aligned with anomaly window.",
    evidence_ids:   ["EVT-042", "EVT-043"],
  },
  {
    observation_id: "OBS-002",
    authored_by:    "analyst-b",
    authored_at:    "2024-01-15T11:00:00Z",
    status:         "published",
    current_text:   "Kp index exceeded threshold 3 hours prior.",
    evidence_ids:   [],
  },
];

describe("ObservationsPanel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ── Empty state ──────────────────────────────────────────────────────────────
  it("renders empty state when no observations", () => {
    render(<ObservationsPanel caseId="galaxy-15" investigationId="INV-1" observations={[]} />);
    expect(screen.getByTestId("observations-empty")).toBeTruthy();
    expect(screen.queryByTestId("observations-list")).toBeNull();
  });

  it("renders empty state when observations is undefined", () => {
    render(<ObservationsPanel caseId="galaxy-15" investigationId="INV-1" />);
    expect(screen.getByTestId("observations-empty")).toBeTruthy();
  });

  // ── Observation list ─────────────────────────────────────────────────────────
  it("renders observations list", () => {
    render(<ObservationsPanel caseId="galaxy-15" investigationId="INV-1" observations={OBSERVATIONS} />);
    expect(screen.getByTestId("observations-list")).toBeTruthy();
  });

  it("renders each observation item", () => {
    render(<ObservationsPanel caseId="galaxy-15" investigationId="INV-1" observations={OBSERVATIONS} />);
    expect(screen.getByTestId("observation-item-OBS-001")).toBeTruthy();
    expect(screen.getByTestId("observation-item-OBS-002")).toBeTruthy();
  });

  it("renders observation text", () => {
    render(<ObservationsPanel caseId="galaxy-15" investigationId="INV-1" observations={OBSERVATIONS} />);
    expect(screen.getByTestId("observation-text-OBS-001").textContent).toBe(
      "Solar particle event aligned with anomaly window."
    );
  });

  it("renders observation status badge", () => {
    render(<ObservationsPanel caseId="galaxy-15" investigationId="INV-1" observations={OBSERVATIONS} />);
    expect(screen.getByTestId("observation-status-OBS-001").textContent).toBe("published");
  });

  it("renders evidence ID references as read-only chips", () => {
    render(<ObservationsPanel caseId="galaxy-15" investigationId="INV-1" observations={OBSERVATIONS} />);
    expect(screen.getByTestId("obs-evidence-ref-EVT-042")).toBeTruthy();
    expect(screen.getByTestId("obs-evidence-ref-EVT-043")).toBeTruthy();
  });

  // ── Form presence ─────────────────────────────────────────────────────────────
  it("renders the observation form", () => {
    render(<ObservationsPanel caseId="galaxy-15" investigationId="INV-1" observations={[]} />);
    expect(screen.getByTestId("observation-form")).toBeTruthy();
    expect(screen.getByTestId("observation-text-input")).toBeTruthy();
    expect(screen.getByTestId("observation-author-input")).toBeTruthy();
    expect(screen.getByTestId("observation-submit-btn")).toBeTruthy();
  });

  // ── Form validation ─────────────────────────────────────────────────────────
  it("shows form error when submitting with empty text", async () => {
    render(<ObservationsPanel caseId="galaxy-15" investigationId="INV-1" observations={[]} />);
    fireEvent.click(screen.getByTestId("observation-submit-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("observation-form-error")).toBeTruthy();
    });
  });

  // ── Successful submission ─────────────────────────────────────────────────────
  it("calls createObservation on valid submit", async () => {
    const newObs = { observation_id: "OBS-003", current_text: "New obs.", status: "published" };
    createObservation.mockResolvedValueOnce(newObs);
    const onAdded = vi.fn();

    render(
      <ObservationsPanel
        caseId="galaxy-15"
        investigationId="INV-1"
        observations={[]}
        onObservationAdded={onAdded}
      />
    );

    fireEvent.change(screen.getByTestId("observation-text-input"), {
      target: { value: "A new observation." },
    });
    fireEvent.click(screen.getByTestId("observation-submit-btn"));

    await waitFor(() => {
      expect(createObservation).toHaveBeenCalledWith("galaxy-15", "INV-1", {
        text:        "A new observation.",
        authored_by: undefined,
      });
      expect(onAdded).toHaveBeenCalledWith(newObs);
    });
  });

  // ── API error on submit ────────────────────────────────────────────────────────
  it("shows form error when API fails", async () => {
    createObservation.mockRejectedValueOnce(new Error("Server error"));

    render(<ObservationsPanel caseId="galaxy-15" investigationId="INV-1" observations={[]} />);
    fireEvent.change(screen.getByTestId("observation-text-input"), {
      target: { value: "Some observation." },
    });
    fireEvent.click(screen.getByTestId("observation-submit-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("observation-form-error").textContent).toContain("Server error");
    });
  });

  // ── Observations do not contain assessments ──────────────────────────────────
  it("does not render any assessment edit controls in the form", () => {
    render(<ObservationsPanel caseId="galaxy-15" investigationId="INV-1" observations={[]} />);
    // No select or dropdown that could modify assessments
    const form = screen.getByTestId("observation-form");
    const selects = form.querySelectorAll("select");
    expect(selects.length).toBe(0);
  });
});
