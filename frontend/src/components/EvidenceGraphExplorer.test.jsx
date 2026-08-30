import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import EvidenceGraphExplorer from "./EvidenceGraphExplorer";

// ── API mock ──────────────────────────────────────────────────────────────────
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchEvidenceProvenance: vi.fn(),
  };
});

import { fetchEvidenceProvenance } from "../api";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * Minimal evidence-graph fixture that covers all five hypothesis shapes.
 * Follows the exact data shape returned by GET /api/cases/:id/evidence-graph.
 */
const GRAPH_FIXTURE = {
  case_id: "galaxy-15",
  causal_attribution_established: false,
  hypotheses: [
    {
      hypothesis_id: "H1",
      label: "Spacecraft charging / electrostatic discharge",
      description: "ESD hypothesis.",
      assessment: "mixed",
      heuristic_note: "MVP temporal selection window of ±10 minutes used.",
      limitations: [
        { type: "proxy_measurement", description: "GOES-11 EP8 is a proxy ~2° from Galaxy 15." },
      ],
      environmental_context: [
        {
          evidence_id: "E-G15-0001",
          relationship: "energetic_particle_environment_at_anomaly_time",
          interpretation: "Contextualises the particle environment at the time of the anomaly.",
        },
      ],
      supporting_evidence: [
        {
          evidence_id: "E-G15-0010",
          relationship: "elevated_flux_supports_charging",
          interpretation: "Elevated 1 MeV electron flux is consistent with spacecraft charging conditions.",
        },
      ],
      contradicting_evidence: [],
      non_discriminating_evidence: [
        {
          evidence_id: "E-G15-0020",
          relationship: "temporal_proximity_only",
          interpretation: "Temporal proximity only; does not discriminate between hypotheses.",
        },
      ],
    },
    {
      hypothesis_id: "H2",
      label: "Single event upset from galactic cosmic ray",
      description: "SEU hypothesis.",
      assessment: "mixed",
      heuristic_note: null,
      limitations: [],
      environmental_context: [
        {
          evidence_id: "E-G15-0001",
          relationship: "energetic_particle_environment_at_anomaly_time",
          interpretation: "Contextualises the particle environment at the time of the anomaly.",
        },
      ],
      supporting_evidence: [],
      contradicting_evidence: [],
      non_discriminating_evidence: [],
    },
    {
      hypothesis_id: "H3",
      label: "Hardware or firmware latent fault",
      description: "Latent fault hypothesis.",
      assessment: "supported",
      heuristic_note: null,
      limitations: [],
      environmental_context: [],
      supporting_evidence: [
        {
          evidence_id: "E-G15-0100",
          relationship: "persistent_command_unresponsiveness",
          interpretation: "Extended command unresponsiveness is consistent with a persistent fault.",
        },
      ],
      contradicting_evidence: [],
      non_discriminating_evidence: [],
    },
    {
      // H4: all four lists empty, one missing_data limitation
      hypothesis_id: "H4",
      label: "Ground segment / RF link anomaly",
      description: "Ground segment hypothesis.",
      assessment: "insufficient_evidence",
      heuristic_note: null,
      limitations: [
        {
          type: "missing_data",
          description:
            "No ground-segment or RF link data is present in this dataset. This hypothesis cannot be evaluated from the available evidence.",
        },
      ],
      environmental_context: [],
      supporting_evidence: [],
      contradicting_evidence: [],
      non_discriminating_evidence: [],
    },
    {
      // H5: strongly_supported; supporting_evidence contains anchor refs; two limitations
      hypothesis_id: "H5",
      label: "Insufficient evidence for causal attribution",
      description: "Absence of evidence is a forensic finding.",
      assessment: "strongly_supported",
      heuristic_note: null,
      limitations: [
        {
          type: "unresolved",
          description:
            "Causal attribution is not established by the available evidence. Multiple hypotheses remain plausible.",
        },
        {
          type: "missing_data",
          description:
            "Key discriminating data — spacecraft command-subsystem telemetry, onboard fault logs — are absent.",
        },
      ],
      environmental_context: [],
      supporting_evidence: [
        {
          evidence_id: "E-G15-0167",
          relationship: "anomaly_unresolved_after_investigation",
          interpretation: "The anchor event documents a persistent anomaly whose causal mechanism is not established.",
        },
      ],
      contradicting_evidence: [],
      non_discriminating_evidence: [],
    },
  ],
};

/** Matching forensicReport fixture — provides assessments for tab badges. */
const REPORT_FIXTURE = {
  hypotheses: GRAPH_FIXTURE.hypotheses.map((h) => ({
    hypothesis_id: h.hypothesis_id,
    label: h.label,
    assessment: h.assessment,
    heuristic_note: h.heuristic_note,
    limitations: h.limitations,
    evidence_summary: {
      environmental_context_ids: (h.environmental_context ?? []).map((r) => r.evidence_id),
      environmental_context_count: (h.environmental_context ?? []).length,
      supporting_evidence_ids: (h.supporting_evidence ?? []).map((r) => r.evidence_id),
      supporting_evidence_count: (h.supporting_evidence ?? []).length,
      contradicting_evidence_ids: (h.contradicting_evidence ?? []).map((r) => r.evidence_id),
      contradicting_evidence_count: (h.contradicting_evidence ?? []).length,
      non_discriminating_evidence_ids: (h.non_discriminating_evidence ?? []).map((r) => r.evidence_id),
      non_discriminating_evidence_count: (h.non_discriminating_evidence ?? []).length,
    },
  })),
};

/** Provenance fixture for E-G15-0010 (H1 supporting evidence). */
const PROVENANCE_FIXTURE = {
  found: true,
  evidence_id: "E-G15-0010",
  timestamp: "2010-04-05T08:55:00Z",
  source: "GOES11_EP8",
  measurement: "e_flux",
  value: 2100.0,
  unit: "particles/cm2/s/sr",
  resolution: "5min",
  dataset_id: "GOES11_K0_EP8",
  provider: "NASA CDAWeb",
  variable: "E_1MEV_IC",
  evidence_type: "environmental_observation",
  quality: null,
  hypothesis_relationships: [
    {
      hypothesis_id: "H1",
      list_name: "supporting_evidence",
      relationship: "elevated_flux_supports_charging",
      interpretation: "Elevated 1 MeV electron flux is consistent with spacecraft charging conditions.",
    },
  ],
};

// ── Helper ────────────────────────────────────────────────────────────────────

function renderExplorer(graphOverride, reportOverride) {
  const graph  = graphOverride ?? GRAPH_FIXTURE;
  const report = reportOverride ?? REPORT_FIXTURE;
  return render(
    <EvidenceGraphExplorer evidenceGraph={graph} forensicReport={report} />
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("EvidenceGraphExplorer", () => {

  beforeEach(() => {
    fetchEvidenceProvenance.mockResolvedValue(PROVENANCE_FIXTURE);
  });

  // EG-1 — Renders without crashing on a valid evidence graph
  it("EG-1: renders without crashing when given a valid evidence graph", () => {
    renderExplorer();
    expect(screen.getByTestId("evidence-graph-explorer")).toBeTruthy();
  });

  // EG-2 — H1–H5 tabs are all present and clickable
  it("EG-2: H1–H5 tabs are all present", () => {
    renderExplorer();
    for (const id of ["H1", "H2", "H3", "H4", "H5"]) {
      expect(screen.getByTestId(`explorer-tab-${id}`)).toBeTruthy();
    }
  });

  it("EG-2b: clicking each tab makes it the active hypothesis", () => {
    renderExplorer();
    for (const id of ["H1", "H2", "H3", "H4", "H5"]) {
      fireEvent.click(screen.getByTestId(`explorer-tab-${id}`));
      const activeArea = screen.getByTestId("explorer-active-hypothesis");
      expect(activeArea.textContent).toContain(id);
    }
  });

  // EG-3 — Switching to H4 shows the empty-state panel
  it("EG-3: switching to H4 shows the empty-state panel", () => {
    renderExplorer();
    fireEvent.click(screen.getByTestId("explorer-tab-H4"));
    expect(screen.getByTestId("h4-empty-state")).toBeTruthy();
  });

  // EG-4 — H4 empty-state references missing ground/RF data
  it("EG-4: H4 empty-state communicates missing ground/RF data", () => {
    renderExplorer();
    fireEvent.click(screen.getByTestId("explorer-tab-H4"));
    const emptyState = screen.getByTestId("h4-empty-state");
    expect(emptyState.textContent).toContain("ground");
    expect(emptyState.textContent).toContain("RF");
    // The limitation description is shown
    expect(emptyState.textContent).toContain("No ground-segment or RF link data");
  });

  it("EG-4b: H4 assessment badge shows 'Insufficient evidence'", () => {
    renderExplorer();
    fireEvent.click(screen.getByTestId("explorer-tab-H4"));
    expect(screen.getByTestId("explorer-assessment-H4").textContent).toBe("Insufficient evidence");
  });

  // EG-5 — H5 shows strongly_supported, supporting evidence, and limitations
  it("EG-5: H5 shows strongly_supported assessment", () => {
    renderExplorer();
    fireEvent.click(screen.getByTestId("explorer-tab-H5"));
    expect(screen.getByTestId("explorer-assessment-H5").textContent).toBe("Strongly supported");
  });

  it("EG-5b: H5 supporting_evidence section contains the anchor ref", () => {
    renderExplorer();
    fireEvent.click(screen.getByTestId("explorer-tab-H5"));
    // supporting_evidence list is visible
    const section = screen.getByTestId("explorer-list-supporting_evidence");
    expect(section).toBeTruthy();
    // The anchor evidence ref is shown
    expect(screen.getByTestId("explorer-ref-E-G15-0167")).toBeTruthy();
  });

  it("EG-5c: H5 limitations block is visible and contains unresolved + missing_data entries", () => {
    renderExplorer();
    fireEvent.click(screen.getByTestId("explorer-tab-H5"));
    const lims = screen.getByTestId("explorer-limitations-H5");
    expect(lims).toBeTruthy();
    expect(lims.textContent).toContain("Causal attribution is not established");
    expect(lims.textContent).toContain("Key discriminating data");
  });

  // EG-6 — Environmental context section has amber styling and the disclaimer
  it("EG-6: environmental context section carries the 'not supporting evidence' disclaimer", () => {
    renderExplorer();
    // H1 is active by default and has env-context refs
    const disclaimer = screen.getByTestId("explorer-env-context-disclaimer");
    expect(disclaimer).toBeTruthy();
    expect(disclaimer.textContent).toContain("Environmental context — not supporting evidence");
  });

  it("EG-6b: environmental context section has amber border CSS class", () => {
    renderExplorer();
    const section = screen.getByTestId("explorer-list-environmental_context");
    expect(section.className).toContain("amber");
  });

  // EG-7 — Environmental context ref is NOT inside the supporting-evidence section
  it("EG-7: E-G15-0001 (env-context) does not appear inside the supporting-evidence section", () => {
    renderExplorer();
    const suppSection = screen.getByTestId("explorer-list-supporting_evidence");
    // E-G15-0001 is in environmental_context, not supporting_evidence
    expect(
      suppSection.querySelector("[data-testid='explorer-ref-E-G15-0001']")
    ).toBeNull();
  });

  // EG-8 — Relationship filter hides sections when toggled off
  it("EG-8: toggling off environmental_context filter hides that section", () => {
    renderExplorer();
    // Section is initially visible
    expect(screen.getByTestId("explorer-list-environmental_context")).toBeTruthy();
    // Toggle off
    fireEvent.click(screen.getByTestId("filter-toggle-environmental_context"));
    // Section is now hidden
    expect(screen.queryByTestId("explorer-list-environmental_context")).toBeNull();
  });

  it("EG-8b: toggling off supporting_evidence filter hides that section", () => {
    renderExplorer();
    expect(screen.getByTestId("explorer-list-supporting_evidence")).toBeTruthy();
    fireEvent.click(screen.getByTestId("filter-toggle-supporting_evidence"));
    expect(screen.queryByTestId("explorer-list-supporting_evidence")).toBeNull();
  });

  // EG-9 — Selecting an evidence ref calls fetchEvidenceProvenance and shows the panel
  it("EG-9: selecting an evidence ref triggers fetchEvidenceProvenance and shows the provenance panel", async () => {
    renderExplorer();
    // E-G15-0010 is in H1 supporting_evidence (H1 is active by default)
    fireEvent.click(screen.getByTestId("explorer-ref-E-G15-0010"));
    await waitFor(() => expect(screen.getByTestId("explorer-provenance-panel")).toBeTruthy());
    expect(fetchEvidenceProvenance).toHaveBeenCalledWith("galaxy-15", "E-G15-0010");
  });

  it("EG-9b: deselecting the same ref clears the provenance panel", async () => {
    renderExplorer();
    fireEvent.click(screen.getByTestId("explorer-ref-E-G15-0010"));
    await waitFor(() => expect(screen.getByTestId("explorer-provenance-panel")).toBeTruthy());
    fireEvent.click(screen.getByTestId("explorer-ref-E-G15-0010"));
    expect(screen.queryByTestId("explorer-provenance-panel")).toBeNull();
  });

  it("EG-9c: switching hypothesis tab clears the provenance panel", async () => {
    renderExplorer();
    fireEvent.click(screen.getByTestId("explorer-ref-E-G15-0010"));
    await waitFor(() => expect(screen.getByTestId("explorer-provenance-panel")).toBeTruthy());
    fireEvent.click(screen.getByTestId("explorer-tab-H2"));
    expect(screen.queryByTestId("explorer-provenance-panel")).toBeNull();
  });

  // EG-10 — No numerical scores or probability language
  it("EG-10: no numerical scores or probability language in the rendered output", () => {
    const { container } = renderExplorer();
    expect(container.textContent).not.toMatch(/\d+(\.\d+)?%/);
    expect(container.textContent).not.toMatch(/\b(probability|likelihood|confidence|score)\b/i);
    expect(container.textContent).not.toMatch(/\b(causes?|caused|proves?|proved|confirms?)\b/i);
  });

  // EG-11 — No duplicate evidence refs within a list
  it("EG-11: no duplicate evidence ref test IDs within the H1 environmental_context list", () => {
    renderExplorer();
    const section = screen.getByTestId("explorer-list-environmental_context");
    const refButtons = section.querySelectorAll("[data-testid^='explorer-ref-']");
    const ids = Array.from(refButtons).map((b) => b.getAttribute("data-testid"));
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
  });

  it("EG-11b: no duplicate evidence ref test IDs within the H1 supporting_evidence list", () => {
    renderExplorer();
    const section = screen.getByTestId("explorer-list-supporting_evidence");
    const refButtons = section.querySelectorAll("[data-testid^='explorer-ref-']");
    const ids = Array.from(refButtons).map((b) => b.getAttribute("data-testid"));
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
  });

  // EG-12 — Provenance fetch failure shows error without crashing
  it("EG-12: provenance fetch failure shows an error message without crashing", async () => {
    fetchEvidenceProvenance.mockRejectedValueOnce(new Error("Network error"));
    renderExplorer();
    fireEvent.click(screen.getByTestId("explorer-ref-E-G15-0010"));
    await waitFor(() => expect(screen.getByTestId("explorer-provenance-panel")).toBeTruthy());
    expect(screen.getByTestId("explorer-prov-error").textContent).toContain(
      "Provenance lookup failed — explorer view remains intact."
    );
    // Root explorer is still present
    expect(screen.getByTestId("evidence-graph-explorer")).toBeTruthy();
  });

  // ── Additional correctness checks ─────────────────────────────────────────

  // null evidenceGraph renders loading state
  it("renders a loading state when evidenceGraph is null", () => {
    render(<EvidenceGraphExplorer evidenceGraph={null} forensicReport={null} />);
    expect(screen.getByTestId("evidence-graph-explorer")).toBeTruthy();
    expect(screen.getByText(/Loading evidence graph/i)).toBeTruthy();
  });

  // H1 heuristic_note is rendered
  it("H1 heuristic_note is rendered in the active panel", () => {
    renderExplorer();
    // H1 is active by default
    expect(screen.getByTestId("explorer-active-hypothesis").textContent).toContain(
      "MVP temporal selection window"
    );
  });

  // H4 limitations block shows the missing-data limitation
  it("H4 limitations block shows the missing-data limitation", () => {
    renderExplorer();
    fireEvent.click(screen.getByTestId("explorer-tab-H4"));
    const lims = screen.getByTestId("explorer-limitations-H4");
    expect(lims.textContent).toContain("No ground-segment or RF link data");
  });
});

// ── Phase 5.5: Loading state, empty hypothesis, and ARIA tests ───────────────

describe("EvidenceGraphExplorer — loading state", () => {
  // EG-5-1 — null evidenceGraph renders loading state with data-testid
  it("EG-5-1: null evidenceGraph renders loading placeholder with data-testid", () => {
    render(<EvidenceGraphExplorer evidenceGraph={null} forensicReport={null} />);
    expect(screen.getByTestId("evidence-graph-explorer")).toBeTruthy();
    expect(screen.getByTestId("evidence-graph-loading")).toBeTruthy();
    expect(screen.getByTestId("evidence-graph-loading").textContent).toContain(
      "Loading evidence graph"
    );
  });
});

describe("EvidenceGraphExplorer — empty hypothesis evidence profile", () => {
  // EG-5-2 — hypothesis with all four lists empty renders h4-empty-state without crashing
  // When allListsEmpty is true the component renders the H4EmptyState panel instead of
  // the individual relationship sections — the individual data-testid list elements are
  // intentionally absent in this branch.
  it("EG-5-2: all-empty hypothesis renders h4-empty-state panel without crashing", () => {
    const emptyGraph = {
      ...GRAPH_FIXTURE,
      hypotheses: GRAPH_FIXTURE.hypotheses.map((h) =>
        h.hypothesis_id === "H2"
          ? {
              ...h,
              environmental_context: [],
              supporting_evidence: [],
              contradicting_evidence: [],
              non_discriminating_evidence: [],
            }
          : h
      ),
    };
    renderExplorer(emptyGraph);
    fireEvent.click(screen.getByTestId("explorer-tab-H2"));
    // Component switches to the h4-empty-state branch — individual list sections are not rendered
    const emptyState = screen.getByTestId("h4-empty-state");
    expect(emptyState).toBeTruthy();
    expect(emptyState.textContent).toContain("No evidence relationships available");
    expect(emptyState.textContent).toContain("cannot be evaluated from the available dataset");
    // Root component is still intact
    expect(screen.getByTestId("evidence-graph-explorer")).toBeTruthy();
  });
});

describe("EvidenceGraphExplorer — accessibility attributes", () => {
  // EG-5-3 — hypothesis tabs have role=tab and aria-selected
  it("EG-5-3: hypothesis tab strip has role=tablist; H1 tab is aria-selected=true by default", () => {
    renderExplorer();
    const tablist = screen.getByRole("tablist");
    expect(tablist).toBeTruthy();
    const h1Tab = screen.getByTestId("explorer-tab-H1");
    expect(h1Tab.getAttribute("role")).toBe("tab");
    expect(h1Tab.getAttribute("aria-selected")).toBe("true");
  });

  // EG-5-4 — non-active tab has aria-selected=false
  it("EG-5-4: non-active tab has aria-selected=false; clicking it makes it active", () => {
    renderExplorer();
    const h2Tab = screen.getByTestId("explorer-tab-H2");
    expect(h2Tab.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(h2Tab);
    expect(h2Tab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("explorer-tab-H1").getAttribute("aria-selected")).toBe("false");
  });

  // EG-5-5 — filter toggle has aria-pressed reflecting visibility state
  it("EG-5-5: filter toggle for environmental_context has aria-pressed=true initially", () => {
    renderExplorer();
    const toggle = screen.getByTestId("filter-toggle-environmental_context");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  // EG-5-6 — filter toggle aria-pressed becomes false after toggling off
  it("EG-5-6: toggling filter off sets aria-pressed=false on that filter button", () => {
    renderExplorer();
    const toggle = screen.getByTestId("filter-toggle-environmental_context");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  // EG-5-7 — filter toggle aria-label is the list label
  it("EG-5-7: filter toggle has aria-label equal to the list label", () => {
    renderExplorer();
    const toggle = screen.getByTestId("filter-toggle-environmental_context");
    expect(toggle.getAttribute("aria-label")).toBe("Environmental context");
  });

  // EG-5-8 — evidence ref buttons have aria-label containing the evidence ID
  it("EG-5-8: evidence ref button has aria-label containing the evidence ID", () => {
    renderExplorer();
    const ref = screen.getByTestId("explorer-ref-E-G15-0010");
    const label = ref.getAttribute("aria-label");
    expect(label).toBeTruthy();
    expect(label).toContain("E-G15-0010");
  });

  // EG-5-9 — evidence ref aria-pressed is false initially, true after selection
  it("EG-5-9: evidence ref aria-pressed is false initially and true after clicking", async () => {
    fetchEvidenceProvenance.mockResolvedValueOnce(PROVENANCE_FIXTURE);
    renderExplorer();
    const ref = screen.getByTestId("explorer-ref-E-G15-0010");
    expect(ref.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(ref);
    await waitFor(() =>
      expect(ref.getAttribute("aria-pressed")).toBe("true")
    );
  });

  // EG-5-10 — env-context disclaimer uses canonical "Environmental context" wording
  it("EG-5-10: env-context disclaimer uses canonical 'Environmental context — not supporting evidence' text", () => {
    renderExplorer();
    const disclaimer = screen.getByTestId("explorer-env-context-disclaimer");
    expect(disclaimer.textContent).toBe("Environmental context — not supporting evidence");
  });
});

