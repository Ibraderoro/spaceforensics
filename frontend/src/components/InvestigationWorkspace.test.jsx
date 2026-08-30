import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import InvestigationWorkspace from "./InvestigationWorkspace";

// ── API mock ───────────────────────────────────────────────────────────────────
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createInvestigation:          vi.fn(),
    fetchInvestigations:          vi.fn(),
    fetchInvestigationSummary:    vi.fn(),
    fetchInvestigationAssistance: vi.fn(),
    fetchInvestigationHistory:    vi.fn(),
    fetchObservations:            vi.fn(),
    fetchChallenges:              vi.fn(),
    patchInvestigationStatus:     vi.fn(),
  };
});

import {
  createInvestigation,
  fetchInvestigations,
  fetchInvestigationSummary,
  fetchInvestigationAssistance,
  fetchInvestigationHistory,
  fetchObservations,
  fetchChallenges,
  patchInvestigationStatus,
} from "../api";

const INV_1 = {
  investigation_id: "INV-001",
  title:            "Initial forensic review",
  status:           "open",
  opened_by:        "analyst-a",
  opened_at:        "2024-01-15T09:00:00Z",
};

const INV_2 = {
  investigation_id: "INV-002",
  title:            "Follow-up review",
  status:           "suspended",
  opened_by:        "analyst-b",
  opened_at:        "2024-01-16T10:00:00Z",
};

const SUMMARY = {
  summary_version: "1.0.0",
  generated_at:    "2024-01-15T09:30:00Z",
  forensic_conclusion: {
    causal_attribution_established: false,
    causal_attribution_statement:   "Causal attribution not established.",
    analysis_version:               "1.0.0",
    evidence_summary: {
      total_environmental_context:     3,
      total_supporting_evidence:       5,
      total_contradicting_evidence:    1,
      total_non_discriminating_evidence: 2,
      total_limitations:               4,
    },
    comparison: {
      most_supported:          "H5",
      supported_hypotheses:    ["H5"],
      mixed_hypotheses:        ["H1"],
      insufficient_hypotheses: ["H3"],
    },
  },
  hypotheses: [
    {
      hypothesis_id:    "H5",
      label:            "SEP event",
      assessment:       "strongly_supported",
      evidence_summary: {
        environmental_context_ids:       ["EVT-001"],
        supporting_evidence_ids:         ["EVT-010"],
        contradicting_evidence_ids:      [],
        non_discriminating_evidence_ids: [],
      },
    },
  ],
  limitations: [
    { type: "proxy_measurement", description: "Kp index is a proxy." },
  ],
  ai_narrative: {
    source:                      "heuristic",
    executive_summary:           "SEP event is the most supported hypothesis.",
    causal_attribution_established: false,
  },
};

const ASSISTANCE = {
  source:           "heuristic",
  findings_summary: "The forensic pipeline identified SEP activity.",
};

const HISTORY = {
  events: [
    { event: "opened", timestamp: "2024-01-15T09:00:00Z", actor: "analyst-a" },
  ],
  observations: [],
  challenges:   [],
};

function setupMocks({ investigations = [INV_1], summary = SUMMARY } = {}) {
  fetchInvestigations.mockResolvedValue(investigations);
  fetchInvestigationSummary.mockResolvedValue(summary);
  fetchInvestigationAssistance.mockResolvedValue(ASSISTANCE);
  fetchInvestigationHistory.mockResolvedValue(HISTORY);
  fetchObservations.mockResolvedValue([]);
  fetchChallenges.mockResolvedValue([]);
}

describe("InvestigationWorkspace", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ── Loading state ────────────────────────────────────────────────────────────
  it("shows loading state while fetching investigations", () => {
    fetchInvestigations.mockReturnValue(new Promise(() => {})); // never resolves
    render(<InvestigationWorkspace caseId="galaxy-15" />);
    expect(screen.getByTestId("workspace-loading")).toBeTruthy();
  });

  // ── Error state ──────────────────────────────────────────────────────────────
  it("shows error state when fetchInvestigations fails", async () => {
    fetchInvestigations.mockRejectedValueOnce(new Error("Network down"));
    render(<InvestigationWorkspace caseId="galaxy-15" />);
    await waitFor(() => {
      expect(screen.getByTestId("workspace-error")).toBeTruthy();
      expect(screen.getByTestId("workspace-error").textContent).toContain("Network down");
    });
  });

  // ── Empty state ───────────────────────────────────────────────────────────────
  it("shows empty state when no investigations exist", async () => {
    fetchInvestigations.mockResolvedValueOnce([]);
    render(<InvestigationWorkspace caseId="galaxy-15" />);
    await waitFor(() => {
      expect(screen.getByTestId("workspace-empty")).toBeTruthy();
    });
  });

  // ── Main workspace renders ────────────────────────────────────────────────────
  it("renders the workspace with investigations", async () => {
    setupMocks();
    render(<InvestigationWorkspace caseId="galaxy-15" />);
    await waitFor(() => {
      expect(screen.getByTestId("investigation-workspace")).toBeTruthy();
    });
  });

  // ── Investigation identity bar ────────────────────────────────────────────────
  it("shows investigation identity bar with status badge", async () => {
    setupMocks();
    render(<InvestigationWorkspace caseId="galaxy-15" />);
    await waitFor(() => {
      expect(screen.getByTestId("investigation-identity")).toBeTruthy();
      expect(screen.getByTestId("investigation-status-badge").textContent).toBe("open");
    });
  });

  it("shows the investigation title in the identity bar", async () => {
    setupMocks();
    render(<InvestigationWorkspace caseId="galaxy-15" />);
    await waitFor(() => {
      expect(screen.getByTestId("investigation-identity").textContent).toContain(
        "Initial forensic review"
      );
    });
  });

  // ── Tab navigation ────────────────────────────────────────────────────────────
  it("renders all workspace tabs", async () => {
    setupMocks();
    render(<InvestigationWorkspace caseId="galaxy-15" />);
    await waitFor(() => {
      expect(screen.getByTestId("workspace-tabs")).toBeTruthy();
      expect(screen.getByTestId("tab-forensic")).toBeTruthy();
      expect(screen.getByTestId("tab-hypotheses")).toBeTruthy();
      expect(screen.getByTestId("tab-ai")).toBeTruthy();
      expect(screen.getByTestId("tab-observations")).toBeTruthy();
      expect(screen.getByTestId("tab-challenges")).toBeTruthy();
      expect(screen.getByTestId("tab-history")).toBeTruthy();
    });
  });

  it("defaults to forensic analysis tab", async () => {
    setupMocks();
    render(<InvestigationWorkspace caseId="galaxy-15" />);
    await waitFor(() => {
      expect(screen.getByTestId("tab-content-forensic")).toBeTruthy();
    });
  });

  it("switches to hypotheses tab on click", async () => {
    setupMocks();
    render(<InvestigationWorkspace caseId="galaxy-15" />);
    await waitFor(() => screen.getByTestId("tab-hypotheses"));
    fireEvent.click(screen.getByTestId("tab-hypotheses"));
    expect(screen.getByTestId("tab-content-hypotheses")).toBeTruthy();
    expect(screen.queryByTestId("tab-content-forensic")).toBeNull();
  });

  it("switches to AI analyst tab on click", async () => {
    setupMocks();
    render(<InvestigationWorkspace caseId="galaxy-15" />);
    await waitFor(() => screen.getByTestId("tab-ai"));
    fireEvent.click(screen.getByTestId("tab-ai"));
    expect(screen.getByTestId("tab-content-ai")).toBeTruthy();
  });

  it("switches to observations tab on click", async () => {
    setupMocks();
    render(<InvestigationWorkspace caseId="galaxy-15" />);
    await waitFor(() => screen.getByTestId("tab-observations"));
    fireEvent.click(screen.getByTestId("tab-observations"));
    expect(screen.getByTestId("tab-content-observations")).toBeTruthy();
  });

  it("switches to challenges tab on click", async () => {
    setupMocks();
    render(<InvestigationWorkspace caseId="galaxy-15" />);
    await waitFor(() => screen.getByTestId("tab-challenges"));
    fireEvent.click(screen.getByTestId("tab-challenges"));
    expect(screen.getByTestId("tab-content-challenges")).toBeTruthy();
  });

  it("switches to history tab on click", async () => {
    setupMocks();
    render(<InvestigationWorkspace caseId="galaxy-15" />);
    await waitFor(() => screen.getByTestId("tab-history"));
    fireEvent.click(screen.getByTestId("tab-history"));
    expect(screen.getByTestId("tab-content-history")).toBeTruthy();
  });

  // ── Forensic tab content ──────────────────────────────────────────────────────
  it("renders ForensicConclusionPanel on forensic tab", async () => {
    setupMocks();
    render(<InvestigationWorkspace caseId="galaxy-15" />);
    await waitFor(() => {
      expect(screen.getByTestId("forensic-conclusion-panel")).toBeTruthy();
    });
  });

  it("shows NOT ESTABLISHED causal attribution on forensic tab", async () => {
    setupMocks();
    render(<InvestigationWorkspace caseId="galaxy-15" />);
    await waitFor(() => {
      expect(screen.getByTestId("causal-attribution-label").textContent).toContain(
        "NOT ESTABLISHED"
      );
    });
  });

  it("renders LimitationsPanel on forensic tab", async () => {
    setupMocks();
    render(<InvestigationWorkspace caseId="galaxy-15" />);
    await waitFor(() => {
      expect(screen.getByTestId("limitations-panel")).toBeTruthy();
    });
  });

  // ── Investigation selector (multiple investigations) ──────────────────────────
  it("renders investigation selector when multiple investigations exist", async () => {
    setupMocks({ investigations: [INV_1, INV_2] });
    render(<InvestigationWorkspace caseId="galaxy-15" />);
    await waitFor(() => {
      expect(screen.getByTestId("investigation-selector")).toBeTruthy();
      expect(screen.getByTestId("investigation-selector-INV-001")).toBeTruthy();
      expect(screen.getByTestId("investigation-selector-INV-002")).toBeTruthy();
    });
  });

  it("does not render selector with a single investigation", async () => {
    setupMocks({ investigations: [INV_1] });
    render(<InvestigationWorkspace caseId="galaxy-15" />);
    await waitFor(() => {
      expect(screen.queryByTestId("investigation-selector")).toBeNull();
    });
  });

  // ── Lifecycle transitions ─────────────────────────────────────────────────────
  it("shows allowed transition buttons for open investigation", async () => {
    setupMocks();
    render(<InvestigationWorkspace caseId="galaxy-15" />);
    await waitFor(() => {
      expect(screen.getByTestId("investigation-transitions")).toBeTruthy();
      expect(screen.getByTestId("status-transition-suspended")).toBeTruthy();
      expect(screen.getByTestId("status-transition-closed")).toBeTruthy();
    });
  });

  it("calls patchInvestigationStatus on transition click", async () => {
    patchInvestigationStatus.mockResolvedValueOnce({ ...INV_1, status: "suspended" });
    setupMocks();
    render(<InvestigationWorkspace caseId="galaxy-15" />);
    await waitFor(() => screen.getByTestId("status-transition-suspended"));
    fireEvent.click(screen.getByTestId("status-transition-suspended"));
    await waitFor(() => {
      expect(patchInvestigationStatus).toHaveBeenCalledWith(
        "galaxy-15", "INV-001",
        expect.objectContaining({ status: "suspended", actor: "analyst" })
      );
    });
  });

  // ── New investigation form ────────────────────────────────────────────────────
  it("shows new investigation form on button click", async () => {
    setupMocks();
    render(<InvestigationWorkspace caseId="galaxy-15" />);
    await waitFor(() => screen.getByTestId("new-investigation-btn"));
    fireEvent.click(screen.getByTestId("new-investigation-btn"));
    expect(screen.getByTestId("new-investigation-form")).toBeTruthy();
  });

  it("hides form on cancel", async () => {
    setupMocks();
    render(<InvestigationWorkspace caseId="galaxy-15" />);
    await waitFor(() => screen.getByTestId("new-investigation-btn"));
    fireEvent.click(screen.getByTestId("new-investigation-btn"));
    expect(screen.getByTestId("new-investigation-form")).toBeTruthy();
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByTestId("new-investigation-form")).toBeNull();
  });

  it("creates investigation on form submit", async () => {
    const newInv = { investigation_id: "INV-003", title: "New Review", status: "open" };
    createInvestigation.mockResolvedValueOnce(newInv);
    setupMocks({ investigations: [INV_1] });
    render(<InvestigationWorkspace caseId="galaxy-15" />);
    await waitFor(() => screen.getByTestId("new-investigation-btn"));
    fireEvent.click(screen.getByTestId("new-investigation-btn"));
    fireEvent.change(screen.getByTestId("new-investigation-title"), {
      target: { value: "New Review" },
    });
    fireEvent.click(screen.getByTestId("new-investigation-submit"));
    await waitFor(() => {
      expect(createInvestigation).toHaveBeenCalledWith("galaxy-15", expect.objectContaining({
        title: "New Review",
      }));
    });
  });

  it("shows form error when new investigation title is empty", async () => {
    setupMocks({ investigations: [INV_1] });
    render(<InvestigationWorkspace caseId="galaxy-15" />);
    await waitFor(() => screen.getByTestId("new-investigation-btn"));
    fireEvent.click(screen.getByTestId("new-investigation-btn"));
    fireEvent.click(screen.getByTestId("new-investigation-submit"));
    await waitFor(() => {
      expect(screen.getByTestId("new-investigation-form-error")).toBeTruthy();
    });
  });

  // ── Forensic isolation invariant ─────────────────────────────────────────────
  it("never renders assessment edit controls anywhere in the workspace", async () => {
    setupMocks();
    render(<InvestigationWorkspace caseId="galaxy-15" />);
    await waitFor(() => screen.getByTestId("investigation-workspace"));
    // Switch through all tabs and ensure no assessment edit inputs exist
    ["forensic", "hypotheses", "observations", "challenges", "history"].forEach((tabId) => {
      fireEvent.click(screen.getByTestId(`tab-${tabId}`));
    });
    // No test-id of the form challenge-assessment-input
    expect(screen.queryByTestId("challenge-assessment-input")).toBeNull();
  });
});
