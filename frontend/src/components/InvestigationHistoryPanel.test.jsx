import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import InvestigationHistoryPanel from "./InvestigationHistoryPanel";

const HISTORY = {
  events: [
    { event: "opened",    timestamp: "2024-01-15T09:00:00Z", actor: "analyst-a" },
    { event: "suspended", timestamp: "2024-01-16T14:00:00Z", actor: "lead",     reason: "Awaiting data." },
    { event: "resumed",   timestamp: "2024-01-17T08:00:00Z", actor: "analyst-a" },
  ],
  observations: [
    {
      observation_id: "OBS-001",
      version_count:  2,
      versions: [
        { version: 1, authored_at: "2024-01-15T10:00:00Z", text: "First draft." },
        { version: 2, authored_at: "2024-01-15T11:00:00Z", text: "Revised observation." },
      ],
    },
  ],
  challenges: [
    {
      challenge_id: "CH-001",
      target_type:  "hypothesis_assessment",
      target_id:    "H1",
      lifecycle: [
        { status: "open",         timestamp: "2024-01-15T10:00:00Z", actor: "analyst-a" },
        { status: "under_review", timestamp: "2024-01-15T12:00:00Z", actor: "lead"      },
      ],
    },
  ],
};

describe("InvestigationHistoryPanel", () => {
  // ── Loading state ────────────────────────────────────────────────────────────
  it("renders loading state", () => {
    render(<InvestigationHistoryPanel loading />);
    expect(screen.getByTestId("history-loading")).toBeTruthy();
    expect(screen.queryByTestId("investigation-history-panel")).toBeNull();
  });

  // ── Error state ──────────────────────────────────────────────────────────────
  it("renders error state", () => {
    render(<InvestigationHistoryPanel error="Failed to fetch history." />);
    expect(screen.getByTestId("history-error")).toBeTruthy();
    expect(screen.getByTestId("history-error").textContent).toContain("Failed to fetch history.");
  });

  // ── Main panel ───────────────────────────────────────────────────────────────
  it("renders main panel when history is provided", () => {
    render(<InvestigationHistoryPanel history={HISTORY} />);
    expect(screen.getByTestId("investigation-history-panel")).toBeTruthy();
  });

  // ── Lifecycle events ─────────────────────────────────────────────────────────
  it("renders lifecycle events section", () => {
    render(<InvestigationHistoryPanel history={HISTORY} />);
    expect(screen.getByTestId("history-events")).toBeTruthy();
  });

  it("renders each lifecycle event", () => {
    render(<InvestigationHistoryPanel history={HISTORY} />);
    expect(screen.getByTestId("history-event-0")).toBeTruthy();
    expect(screen.getByTestId("history-event-1")).toBeTruthy();
    expect(screen.getByTestId("history-event-2")).toBeTruthy();
  });

  it("renders event type labels", () => {
    render(<InvestigationHistoryPanel history={HISTORY} />);
    expect(screen.getByTestId("history-event-0").textContent).toContain("opened");
    expect(screen.getByTestId("history-event-1").textContent).toContain("suspended");
  });

  it("renders event reason when present", () => {
    render(<InvestigationHistoryPanel history={HISTORY} />);
    expect(screen.getByTestId("history-event-1").textContent).toContain("Awaiting data.");
  });

  // ── Empty events ─────────────────────────────────────────────────────────────
  it("shows 'No events recorded' when events array is empty", () => {
    render(<InvestigationHistoryPanel history={{ events: [], observations: [], challenges: [] }} />);
    expect(screen.getByTestId("history-events").textContent).toContain("No events recorded");
  });

  // ── Observation version history ───────────────────────────────────────────────
  it("renders observation version history when present", () => {
    render(<InvestigationHistoryPanel history={HISTORY} />);
    expect(screen.getByTestId("history-observations")).toBeTruthy();
    expect(screen.getByTestId("history-observation-OBS-001")).toBeTruthy();
  });

  it("renders observation versions with text", () => {
    render(<InvestigationHistoryPanel history={HISTORY} />);
    expect(screen.getByTestId("history-obs-version-OBS-001-1")).toBeTruthy();
    expect(screen.getByTestId("history-obs-version-OBS-001-2")).toBeTruthy();
  });

  it("does not render observation history section when empty", () => {
    render(<InvestigationHistoryPanel history={{ events: [], observations: [], challenges: [] }} />);
    expect(screen.queryByTestId("history-observations")).toBeNull();
  });

  // ── Challenge lifecycle history ───────────────────────────────────────────────
  it("renders challenge history when present", () => {
    render(<InvestigationHistoryPanel history={HISTORY} />);
    expect(screen.getByTestId("history-challenges")).toBeTruthy();
    expect(screen.getByTestId("history-challenge-CH-001")).toBeTruthy();
  });

  it("renders challenge lifecycle steps", () => {
    render(<InvestigationHistoryPanel history={HISTORY} />);
    expect(screen.getByTestId("history-challenge-step-CH-001-0")).toBeTruthy();
    expect(screen.getByTestId("history-challenge-step-CH-001-1")).toBeTruthy();
  });

  it("does not render challenge history section when empty", () => {
    render(<InvestigationHistoryPanel history={{ events: [], observations: [], challenges: [] }} />);
    expect(screen.queryByTestId("history-challenges")).toBeNull();
  });

  // ── Null history ─────────────────────────────────────────────────────────────
  it("renders without crashing when history is null", () => {
    render(<InvestigationHistoryPanel history={null} />);
    expect(screen.getByTestId("investigation-history-panel")).toBeTruthy();
    expect(screen.getByTestId("history-events").textContent).toContain("No events recorded");
  });
});
