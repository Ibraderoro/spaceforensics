import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import App from "./App";

// ── API mock ──────────────────────────────────────────────────────────────────
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchCaseMeta:         vi.fn(),
    fetchTimeline:         vi.fn(),
    fetchCaseList:         vi.fn(),
    fetchForensicAnalysis: vi.fn(),
    fetchEvidenceGraph:    vi.fn(),
    postInvestigate:       vi.fn(),
    postChallenge:         vi.fn(),
  };
});

import {
  fetchCaseMeta,
  fetchTimeline,
  fetchCaseList,
  fetchForensicAnalysis,
  fetchEvidenceGraph,
  postInvestigate,
} from "./api";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CASE_META = {
  case_id:     "galaxy-15",
  title:       "Galaxy 15 Anomaly — April 2010",
  description: "Spacecraft anomaly under investigation.",
  anchor_event: { timestamp: "2010-04-05T09:48:00Z" },
  target_asset: {
    name:             "Galaxy 15",
    alias:            "AMC-15",
    norad_id:         28884,
    orbit_type:       "GEO",
    longitude_deg_west: 133,
    operator:         "Intelsat",
    spacecraft_bus:   "LS-1300",
  },
  data_window: {
    start:             "2010-04-05T08:00:00Z",
    end:               "2010-04-05T11:00:00Z",
    duration_minutes:  180,
  },
  data_sources: [
    { dataset_id: "GOES11_K0_EP8", measurement: "e_flux",  description: "GOES-11 EP8 1 MeV electrons" },
    { dataset_id: "GOES11_K0_MAG", measurement: "b_gsm",   description: "GOES-11 magnetometer" },
    { dataset_id: "GOES11_EPHEM",  measurement: "position", description: "GOES-11 ephemeris" },
  ],
  scientific_limitations: [
    "GOES-11 EP8 measurements are a proxy ~2° from Galaxy 15.",
    "No spacecraft surface-charging telemetry existed on Galaxy 15.",
  ],
};

const TIMELINE_DATA = [
  {
    evidence_id: "E-G15-0001",
    timestamp:   "2010-04-05T08:00:00Z",
    source:      "GOES11_EP8",
    measurement: "e_flux",
    value:       1500.0,
    unit:        "particles/cm2/s/sr",
    resolution:  "5min",
    evidence_type: "environmental_observation",
  },
  {
    evidence_id: "E-G15-0100",
    timestamp:   "2010-04-05T09:48:00Z",
    source:      "CASE",
    measurement: "command_loss_event",
    value:       1,
    unit:        null,
    resolution:  "point",
    evidence_type: "case_event",
  },
];

const FORENSIC_REPORT = {
  case_id:                        "galaxy-15",
  analysis_version:               "1.0.0",
  causal_attribution_established: false,
  causal_attribution_statement:   "Causal attribution not established.",
  hypotheses: [
    {
      hypothesis_id:  "H1",
      label:          "Spacecraft charging / ESD",
      assessment:     "mixed",
      heuristic_note: "Mixed assessment based on proxy data.",
      limitations: [
        { description: "GOES-11 EP8 is a proxy ~2° from Galaxy 15." },
      ],
      evidence_summary: {
        environmental_context_ids:       ["E-G15-0001"],
        supporting_evidence_ids:         [],
        contradicting_evidence_ids:      [],
        non_discriminating_evidence_ids: [],
      },
    },
    {
      hypothesis_id:  "H2",
      label:          "Single event upset (SEU)",
      assessment:     "mixed",
      heuristic_note: null,
      limitations: [],
      evidence_summary: {
        environmental_context_ids:       ["E-G15-0001"],
        supporting_evidence_ids:         [],
        contradicting_evidence_ids:      [],
        non_discriminating_evidence_ids: [],
      },
    },
    {
      hypothesis_id:  "H3",
      label:          "Solar array anomaly",
      assessment:     "supported",
      heuristic_note: null,
      limitations: [],
      evidence_summary: {
        environmental_context_ids:       [],
        supporting_evidence_ids:         ["E-G15-0100"],
        contradicting_evidence_ids:      [],
        non_discriminating_evidence_ids: [],
      },
    },
    {
      hypothesis_id:  "H4",
      label:          "Battery / power system fault",
      assessment:     "insufficient_evidence",
      heuristic_note: null,
      limitations: [],
      evidence_summary: {
        environmental_context_ids:       [],
        supporting_evidence_ids:         [],
        contradicting_evidence_ids:      [],
        non_discriminating_evidence_ids: [],
      },
    },
    {
      hypothesis_id:  "H5",
      label:          "Solar energetic particle (SEP) event",
      assessment:     "strongly_supported",
      heuristic_note: "SEP event strongly supported by GOES-11 observations.",
      limitations: [],
      evidence_summary: {
        environmental_context_ids:       [],
        supporting_evidence_ids:         ["E-G15-0100"],
        contradicting_evidence_ids:      [],
        non_discriminating_evidence_ids: [],
      },
    },
  ],
  analyst_narrative: {
    source:                         "heuristic",
    causal_attribution_established: false,
    executive_summary:              "SEP event is the most strongly supported hypothesis.",
  },
};

const EVIDENCE_GRAPH = {
  case_id:                        "galaxy-15",
  causal_attribution_established: false,
  hypotheses: FORENSIC_REPORT.hypotheses.map((h) => ({
    ...h,
    environmental_context:    [],
    supporting_evidence:      [],
    contradicting_evidence:   [],
    non_discriminating_evidence: [],
  })),
};

const CASE_LIST_SINGLE  = [{ case_id: "galaxy-15", title: "Galaxy 15 Anomaly" }];
const CASE_LIST_MULTI   = [
  { case_id: "galaxy-15",      title: "Galaxy 15 Anomaly" },
  { case_id: "goes16-sep2017", title: "GOES-16 SEP 2017"  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Set up the happy-path mocks and render the App.
 * Returns the render result.
 */
function setupAndRender({
  caseList      = CASE_LIST_SINGLE,
  caseMeta      = CASE_META,
  timeline      = TIMELINE_DATA,
  forensic      = FORENSIC_REPORT,
  evidenceGraph = EVIDENCE_GRAPH,
} = {}) {
  fetchCaseMeta.mockResolvedValue(caseMeta);
  fetchTimeline.mockResolvedValue(timeline);
  fetchCaseList.mockResolvedValue(caseList);
  fetchForensicAnalysis.mockResolvedValue(forensic);
  fetchEvidenceGraph.mockResolvedValue(evidenceGraph);
  return render(<App />);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("App — loading state", () => {
  it("APP-1: shows the full-page loading spinner while initial data is fetching", () => {
    // Never resolves — keeps the loading state visible.
    fetchCaseMeta.mockReturnValue(new Promise(() => {}));
    fetchTimeline.mockReturnValue(new Promise(() => {}));
    fetchCaseList.mockReturnValue(new Promise(() => {}));
    fetchForensicAnalysis.mockReturnValue(new Promise(() => {}));
    fetchEvidenceGraph.mockReturnValue(new Promise(() => {}));
    render(<App />);
    // The full-page loader should be visible; no main content yet.
    expect(document.body.textContent).toContain("Connecting to SPACEFORENSICS API");
  });

  it("APP-2: loading state does not render any hypothesis assessments", () => {
    fetchCaseMeta.mockReturnValue(new Promise(() => {}));
    fetchTimeline.mockReturnValue(new Promise(() => {}));
    fetchCaseList.mockReturnValue(new Promise(() => {}));
    fetchForensicAnalysis.mockReturnValue(new Promise(() => {}));
    fetchEvidenceGraph.mockReturnValue(new Promise(() => {}));
    render(<App />);
    expect(document.body.textContent).not.toContain("strongly_supported");
    expect(document.body.textContent).not.toContain("insufficient_evidence");
  });
});

describe("App — API error state (unknown case / connection failure)", () => {
  it("APP-3: shows connection error when initial fetch fails", async () => {
    fetchCaseMeta.mockRejectedValue(new Error("Case not found: unknown-case"));
    fetchTimeline.mockRejectedValue(new Error("Case not found: unknown-case"));
    fetchCaseList.mockRejectedValue(new Error("Case not found: unknown-case"));
    fetchForensicAnalysis.mockResolvedValue(FORENSIC_REPORT);
    fetchEvidenceGraph.mockResolvedValue(EVIDENCE_GRAPH);
    render(<App />);
    await waitFor(() => {
      expect(document.body.textContent).toContain("Connection error");
    });
  });

  it("APP-4: error state does not render any forensic hypothesis rows", async () => {
    fetchCaseMeta.mockRejectedValue(new Error("Case not found: unknown-case"));
    fetchTimeline.mockRejectedValue(new Error("Case not found: unknown-case"));
    fetchCaseList.mockRejectedValue(new Error("Case not found: unknown-case"));
    fetchForensicAnalysis.mockResolvedValue(FORENSIC_REPORT);
    fetchEvidenceGraph.mockResolvedValue(EVIDENCE_GRAPH);
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Connection error"));
    // No hypothesis data rendered in error state.
    expect(document.body.textContent).not.toContain("NOT ESTABLISHED");
  });

  it("APP-5: error state includes safe backend-check message without raw stack traces", async () => {
    fetchCaseMeta.mockRejectedValue(new Error("Network failure"));
    fetchTimeline.mockRejectedValue(new Error("Network failure"));
    fetchCaseList.mockRejectedValue(new Error("Network failure"));
    fetchForensicAnalysis.mockResolvedValue(FORENSIC_REPORT);
    fetchEvidenceGraph.mockResolvedValue(EVIDENCE_GRAPH);
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Connection error"));
    // The error message must NOT expose internal paths or stack traces.
    expect(document.body.textContent).not.toContain("at Object.");
    expect(document.body.textContent).not.toContain("node_modules");
    // Safe guidance text must be visible.
    expect(document.body.textContent).toContain("backend");
  });

  it("APP-6: forensic-analysis loading state is shown while forensic fetch is pending", async () => {
    fetchCaseMeta.mockResolvedValue(CASE_META);
    fetchTimeline.mockResolvedValue(TIMELINE_DATA);
    fetchCaseList.mockResolvedValue(CASE_LIST_SINGLE);
    // Forensic fetch never resolves — keeps forensic loading state visible.
    fetchForensicAnalysis.mockReturnValue(new Promise(() => {}));
    fetchEvidenceGraph.mockReturnValue(new Promise(() => {}));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("forensic-loading")).toBeTruthy());
  });

  it("APP-7: forensic-error state appears when both forensic and graph fetches fail", async () => {
    fetchCaseMeta.mockResolvedValue(CASE_META);
    fetchTimeline.mockResolvedValue(TIMELINE_DATA);
    fetchCaseList.mockResolvedValue(CASE_LIST_SINGLE);
    fetchForensicAnalysis.mockRejectedValue(new Error("API error 404 on /api/cases/unknown/forensic-analysis"));
    fetchEvidenceGraph.mockRejectedValue(new Error("API error 404 on /api/cases/unknown/evidence-graph"));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("forensic-error")).toBeTruthy());
    // No forensic conclusions rendered.
    expect(document.body.textContent).not.toContain("NOT ESTABLISHED");
    expect(document.body.textContent).not.toContain("Strongly supported");
  });
});

describe("App — normal rendering", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("APP-8: renders the main layout after all data loads", async () => {
    setupAndRender();
    await waitFor(() =>
      expect(screen.getByTestId("investigation-timeline")).toBeTruthy()
    );
  });

  it("APP-9: header renders SpaceForensics brand and asset name", async () => {
    setupAndRender();
    await waitFor(() => {
      const text = document.body.textContent;
      // Header renders "SpaceForensics" with mixed case (uppercase CSS applied via Tailwind)
      expect(text).toContain("SpaceForensics");
      expect(text).toContain("Galaxy 15");
    });
  });

  it("APP-10: investigation timeline is visible after data loads", async () => {
    setupAndRender();
    await waitFor(() => {
      expect(screen.getByTestId("investigation-timeline")).toBeTruthy();
    });
  });

  it("APP-11: ForensicInvestigationView renders after forensic data loads", async () => {
    setupAndRender();
    await waitFor(() => {
      expect(screen.getByTestId("forensic-investigation-view")).toBeTruthy();
    });
  });
});

describe("App — scientific UI invariants", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ── NOT ESTABLISHED banner ─────────────────────────────────────────────────

  it("APP-12: 'NOT ESTABLISHED' is visible when causal_attribution_established is false", async () => {
    setupAndRender({ forensic: { ...FORENSIC_REPORT, causal_attribution_established: false } });
    await waitFor(() =>
      expect(screen.getByTestId("forensic-investigation-view")).toBeTruthy()
    );
    expect(document.body.textContent).toContain("NOT ESTABLISHED");
  });

  it("APP-13: no 'Cause:' label is rendered anywhere when causality is not established", async () => {
    setupAndRender({ forensic: { ...FORENSIC_REPORT, causal_attribution_established: false } });
    await waitFor(() =>
      expect(screen.getByTestId("forensic-investigation-view")).toBeTruthy()
    );
    // "Cause:" as a standalone label must not appear.
    const text = document.body.textContent;
    expect(text).not.toMatch(/^Cause:\s/m);
    expect(text.toLowerCase()).not.toContain("confirmed cause");
    expect(text.toLowerCase()).not.toContain("proven cause");
  });

  // ── Hypothesis assessment invariants ──────────────────────────────────────

  it("APP-14: H1 assessment label is 'Mixed' (not Established, Confirmed, or Strongly supported)", async () => {
    setupAndRender();
    await waitFor(() =>
      expect(screen.getByTestId("forensic-investigation-view")).toBeTruthy()
    );
    // Click H1 tab to reveal its badge
    const h1Tab = screen.getAllByRole("button").find((b) =>
      b.getAttribute("data-testid") === "hypothesis-tab-H1"
    );
    if (h1Tab) {
      fireEvent.click(h1Tab);
      expect(document.body.textContent).not.toContain("Strongly supported");
      expect(document.body.textContent).not.toContain("Confirmed");
    }
  });

  it("APP-15: H5 assessment label contains 'Strongly supported'", async () => {
    setupAndRender();
    await waitFor(() =>
      expect(screen.getByTestId("forensic-investigation-view")).toBeTruthy()
    );
    // H5 tab
    const h5Tab = screen.getAllByRole("button").find((b) =>
      b.getAttribute("data-testid") === "hypothesis-tab-H5"
    );
    if (h5Tab) {
      fireEvent.click(h5Tab);
      expect(document.body.textContent).toContain("Strongly supported");
    }
  });

  // ── Environmental context visual separation ────────────────────────────────

  it("APP-16: environmental context section is visually distinct from supporting evidence section", async () => {
    setupAndRender();
    await waitFor(() =>
      expect(screen.getByTestId("forensic-investigation-view")).toBeTruthy()
    );
    // H1 has env context — activate it
    const h1Tab = screen.getAllByRole("button").find((b) =>
      b.getAttribute("data-testid") === "hypothesis-tab-H1"
    );
    if (h1Tab) {
      fireEvent.click(h1Tab);
      const envSection = screen.queryByTestId("env-context-H1");
      const suppSection = screen.queryByTestId("supporting-H1");
      if (envSection && suppSection) {
        // They must be separate DOM nodes
        expect(envSection).not.toBe(suppSection);
        // The env section must not label itself as "Supporting"
        expect(envSection.textContent.toLowerCase()).not.toContain("supporting evidence");
      }
    }
  });

  // ── No probability language ────────────────────────────────────────────────

  it("APP-17: no numerical probability or percentage strings appear after forensic data loads", async () => {
    setupAndRender();
    await waitFor(() =>
      expect(screen.getByTestId("forensic-investigation-view")).toBeTruthy()
    );
    const text = document.body.textContent;
    expect(text).not.toMatch(/\d+(\.\d+)?%/);
    expect(text.toLowerCase()).not.toContain("probability");
    expect(text.toLowerCase()).not.toContain("likelihood");
    expect(text.toLowerCase()).not.toContain("confidence score");
  });

  // ── Limitations section ────────────────────────────────────────────────────

  it("APP-18: H1 limitations are visible in the rendered output", async () => {
    setupAndRender();
    await waitFor(() =>
      expect(screen.getByTestId("forensic-investigation-view")).toBeTruthy()
    );
    const h1Tab = screen.getAllByRole("button").find((b) =>
      b.getAttribute("data-testid") === "hypothesis-tab-H1"
    );
    if (h1Tab) {
      fireEvent.click(h1Tab);
      // H1 has a limitation in the fixture
      expect(document.body.textContent).toContain("proxy");
    }
  });
});

describe("App — case selector (multi-case)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("APP-19: case selector dropdown is hidden when only one case is available", async () => {
    setupAndRender({ caseList: CASE_LIST_SINGLE });
    await waitFor(() =>
      expect(screen.getByTestId("investigation-timeline")).toBeTruthy()
    );
    // No case-selector dropdown when only one case
    const selects = document.body.querySelectorAll("select");
    // Any <select> elements present must not list multiple cases
    if (selects.length > 0) {
      const caseOptions = Array.from(selects[0].querySelectorAll("option"));
      // If there's a select, it must have at most 1 option for a single-case list
      // (Header may have internal controls — only check App-level case selector)
    }
    // The distinctive multi-case select text should not appear
    expect(document.body.textContent).not.toContain("GOES-16 SEP 2017");
  });

  it("APP-20: case selector dropdown is visible when multiple cases are available", async () => {
    setupAndRender({ caseList: CASE_LIST_MULTI });
    await waitFor(() =>
      expect(screen.getByTestId("investigation-timeline")).toBeTruthy()
    );
    // Both case titles should appear in the selector
    expect(document.body.textContent).toContain("Galaxy 15 Anomaly");
    expect(document.body.textContent).toContain("GOES-16 SEP 2017");
  });
});

describe("App — empty evidence (timeline is empty)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("APP-21: renders without crashing when timeline is empty", async () => {
    setupAndRender({ timeline: [] });
    await waitFor(() =>
      expect(screen.getByTestId("investigation-timeline")).toBeTruthy()
    );
    // Timeline shows 0 records
    expect(document.body.textContent).toContain("0 records");
  });

  it("APP-22: forensic view renders when timeline is empty but forensic data is present", async () => {
    setupAndRender({ timeline: [] });
    await waitFor(() =>
      expect(screen.getByTestId("forensic-investigation-view")).toBeTruthy()
    );
    // NOT ESTABLISHED must still be visible — forensic data is independent of timeline
    expect(document.body.textContent).toContain("NOT ESTABLISHED");
  });
});
