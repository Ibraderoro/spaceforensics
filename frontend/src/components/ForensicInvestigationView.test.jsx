import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ForensicInvestigationView, { buildInterpretationMap } from "./ForensicInvestigationView";

// ── API mock ──────────────────────────────────────────────────────────────────
// fetchEvidenceProvenance is mocked so tests do not make real network calls.
// Each test that needs a specific response configures mockResolvedValue before
// clicking a chip.
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
 * Minimal but structurally valid ValidatedForensicReport fixture.
 * Matches the Galaxy 15 assessments as returned by the backend.
 */
const REPORT_FIXTURE = {
  case_id: "galaxy-15",
  analysis_version: "4.3.0",
  causal_attribution_established: false,

  event: {
    timestamp: "2010-04-05T09:48:00Z",
    label: "galaxy15_anomaly",
    description: "Last successful ground command contact was lost at 09:48 UTC.",
    recovery_event: {
      timestamp: "2010-12-26T00:00:00Z",
      label: "autonomous_recovery",
      description: "Galaxy 15 autonomously resumed normal operations.",
    },
  },

  hypotheses: [
    {
      hypothesis_id: "H1",
      label: "Spacecraft charging / electrostatic discharge",
      assessment: "mixed",
      heuristic_note: "MVP temporal selection window of ±10 minutes used; no in-situ G15 data available.",
      limitations: [
        { type: "proxy_measurement", description: "GOES-11 EP8 measurements are a proxy ~2° from Galaxy 15." },
        { type: "missing_data",      description: "No spacecraft surface-charging telemetry available." },
      ],
      evidence_summary: {
        environmental_context_ids: ["E-G15-0001"],
        environmental_context_count: 1,
        supporting_evidence_ids: ["E-G15-0010"],
        supporting_evidence_count: 1,
        contradicting_evidence_ids: [],
        contradicting_evidence_count: 0,
        non_discriminating_evidence_ids: ["E-G15-0020"],
        non_discriminating_evidence_count: 1,
      },
    },
    {
      hypothesis_id: "H2",
      label: "Single event upset from galactic cosmic ray",
      assessment: "mixed",
      heuristic_note: null,
      limitations: [],
      evidence_summary: {
        environmental_context_ids: ["E-G15-0001"],
        environmental_context_count: 1,
        supporting_evidence_ids: [],
        supporting_evidence_count: 0,
        contradicting_evidence_ids: [],
        contradicting_evidence_count: 0,
        non_discriminating_evidence_ids: [],
        non_discriminating_evidence_count: 0,
      },
    },
    {
      hypothesis_id: "H3",
      label: "Hardware or firmware latent fault",
      assessment: "supported",
      heuristic_note: null,
      limitations: [],
      evidence_summary: {
        environmental_context_ids: [],
        environmental_context_count: 0,
        supporting_evidence_ids: [],
        supporting_evidence_count: 0,
        contradicting_evidence_ids: [],
        contradicting_evidence_count: 0,
        non_discriminating_evidence_ids: [],
        non_discriminating_evidence_count: 0,
      },
    },
    {
      hypothesis_id: "H4",
      label: "Deliberate interference or cyber attack",
      assessment: "insufficient_evidence",
      heuristic_note: null,
      limitations: [],
      evidence_summary: {
        environmental_context_ids: [],
        environmental_context_count: 0,
        supporting_evidence_ids: [],
        supporting_evidence_count: 0,
        contradicting_evidence_ids: [],
        contradicting_evidence_count: 0,
        non_discriminating_evidence_ids: [],
        non_discriminating_evidence_count: 0,
      },
    },
    {
      hypothesis_id: "H5",
      label: "Absence of discriminating evidence is itself a forensic finding",
      assessment: "strongly_supported",
      heuristic_note: null,
      limitations: [],
      evidence_summary: {
        environmental_context_ids: [],
        environmental_context_count: 0,
        supporting_evidence_ids: [],
        supporting_evidence_count: 0,
        contradicting_evidence_ids: [],
        contradicting_evidence_count: 0,
        non_discriminating_evidence_ids: [],
        non_discriminating_evidence_count: 0,
      },
    },
  ],

  hypothesis_comparison: [
    {
      hypothesis_id: "H1",
      label: "Spacecraft charging / electrostatic discharge",
      assessment: "mixed",
      evidence_profile: {},
      key_observations: ["Environmental context present; no direct ESD evidence."],
      key_limitations: [
        { type: "proxy_measurement", description: "GOES-11 is a proxy ~2° from Galaxy 15." },
      ],
    },
  ],

  limitations: [
    {
      type: "proxy_measurement",
      description: "GOES-11 EP8 measurements are a proxy — GOES-11 was ~2° from Galaxy 15.",
    },
    {
      type: "missing_data",
      description: "No onboard surface-charging telemetry existed on Galaxy 15.",
    },
  ],

  analyst_narrative: {
    source: "heuristic",
    generated_at: "2024-01-15T10:30:00Z",
    causal_attribution_established: false,
    hypothesis_assessments: [
      {
        hypothesis_id: "H1",
        assessment: "mixed",
        reasoning: "Environmental data is consistent with elevated particle flux but does not confirm ESD.",
        evidence_ids: ["E-G15-0001"],
        notable_claims: [],
      },
    ],
    event_description: "Galaxy 15 lost command responsiveness at 09:48 UTC on 5 April 2010.",
    environmental_context: "GOES-11 recorded elevated 1 MeV electron flux in the hours prior to the anomaly.",
    notable_limitations: "No direct in-situ measurements at the Galaxy 15 bus are available.",
    investigation_summary: "Test summary: no single hypothesis is established as the definitive cause.",
  },
};

/** Minimal timeline data — one record per evidence ID referenced in the fixture. */
const TIMELINE_FIXTURE = [
  {
    evidence_id: "E-G15-0001",
    timestamp: "2010-04-05T08:00:00Z",
    source: "GOES11_EP8",
    measurement: "e_flux",
    value: 1500.5,
    unit: "particles/cm2/s/sr",
    resolution: "5min",
    dataset_id: "GOES11_K0_EP8",
    provider: "NASA CDAWeb",
    variable: "E_1MEV_IC",
    evidence_type: "environmental_observation",
  },
  {
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
  },
  {
    evidence_id: "E-G15-0020",
    timestamp: "2010-04-05T09:00:00Z",
    source: "GOES11_MAG",
    measurement: "b_gsm",
    value: 45.3,
    unit: "nT",
    resolution: "1min",
    dataset_id: null,
    provider: null,
    variable: "B_GSM",
    evidence_type: "environmental_observation",
  },
];

/** Evidence graph fixture — provides interpretation text. */
const GRAPH_FIXTURE = {
  hypotheses: [
    {
      hypothesis_id: "H1",
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
  ],
};

/**
 * Full provenance fixture matching the E-G15-0010 timeline record,
 * with two hypothesis relationship entries.
 */
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
    {
      hypothesis_id: "H2",
      list_name: "environmental_context",
      relationship: "energetic_particle_environment_at_anomaly_time",
      interpretation: "Contextualises the particle environment at the time of the anomaly.",
    },
  ],
};

/** Provenance fixture for an EPHEMERIS-sourced record — no hypothesis relationships. */
const PROVENANCE_EPHEMERIS_FIXTURE = {
  found: true,
  evidence_id: "E-G15-0005",
  timestamp: "2010-04-05T08:30:00Z",
  source: "GOES11_EPHEMERIS",
  measurement: "position",
  value: 42164.0,
  unit: "km",
  resolution: "1min",
  dataset_id: null,
  provider: null,
  variable: null,
  evidence_type: "environmental_observation",
  quality: null,
  hypothesis_relationships: [],
};

/** Provenance fixture for an unknown evidence ID. */
const PROVENANCE_NOT_FOUND_FIXTURE = {
  found: false,
  evidence_id: "E-G15-9999",
  reason: "Evidence ID not found in timeline",
};

// ── Helper: renders the component with default fixtures ───────────────────────

function renderView(reportOverride = {}, timelineOverride = TIMELINE_FIXTURE) {
  const report = { ...REPORT_FIXTURE, ...reportOverride };
  return render(
    <ForensicInvestigationView
      report={report}
      timelineData={timelineOverride}
      evidenceGraph={GRAPH_FIXTURE}
    />
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ForensicInvestigationView", () => {

  beforeEach(() => {
    // Default: every evidence chip click resolves with the full provenance fixture.
    fetchEvidenceProvenance.mockResolvedValue(PROVENANCE_FIXTURE);
  });

  // FUI-1 — Causal attribution banner shows NOT ESTABLISHED
  it("FUI-1: renders the causal attribution banner with NOT ESTABLISHED", () => {
    renderView();
    const banner = screen.getByTestId("causal-attribution-banner");
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain("NOT ESTABLISHED");
  });

  // FUI-2 — Never renders the word "Cause:" anywhere in the output
  it("FUI-2: does not render misleading 'Cause:' language anywhere", () => {
    const { container } = renderView();
    expect(container.textContent).not.toMatch(/\bCause:\s/i);
  });

  // FUI-3 — All five hypothesis IDs are rendered
  it("FUI-3: renders all five hypothesis IDs H1 through H5", () => {
    renderView();
    for (const id of ["H1", "H2", "H3", "H4", "H5"]) {
      expect(screen.getByTestId(`hypothesis-row-${id}`)).toBeTruthy();
    }
  });

  // FUI-4 — H1 assessment shows "Mixed"
  it("FUI-4: H1 assessment badge shows Mixed", () => {
    renderView();
    const badge = screen.getByTestId("assessment-H1");
    expect(badge.textContent).toBe("Mixed");
  });

  // FUI-5 — H2 assessment shows "Mixed"
  it("FUI-5: H2 assessment badge shows Mixed", () => {
    renderView();
    const badge = screen.getByTestId("assessment-H2");
    expect(badge.textContent).toBe("Mixed");
  });

  // FUI-6 — H3 assessment shows "Supported"
  it("FUI-6: H3 assessment badge shows Supported", () => {
    renderView();
    const badge = screen.getByTestId("assessment-H3");
    expect(badge.textContent).toBe("Supported");
  });

  // FUI-7 — H4 assessment shows "Insufficient evidence"
  it("FUI-7: H4 assessment badge shows Insufficient evidence", () => {
    renderView();
    const badge = screen.getByTestId("assessment-H4");
    expect(badge.textContent).toBe("Insufficient evidence");
  });

  // FUI-8 — H5 assessment shows "Strongly supported"
  it("FUI-8: H5 assessment badge shows Strongly supported", () => {
    renderView();
    const badge = screen.getByTestId("assessment-H5");
    expect(badge.textContent).toBe("Strongly supported");
  });

  // FUI-9 — Environmental context section has distinct amber CSS treatment
  it("FUI-9: environmental context list has distinct amber CSS class", () => {
    renderView();
    const envSection = screen.getByTestId("section-environmental-context");
    // The EnvContextList root div carries the amber treatment class
    const amberEl = envSection.querySelector("[data-testid='env-context-list']");
    expect(amberEl).toBeTruthy();
    expect(amberEl.className).toContain("border-amber-600");
    expect(amberEl.className).toContain("bg-amber-950");
  });

  // FUI-10 — Limitations section is present and rendered (not hidden by default)
  it("FUI-10: limitations section is present and not hidden by default", () => {
    renderView();
    const section = screen.getByTestId("section-limitations");
    expect(section).toBeTruthy();
    // Both limitation descriptions should be visible in the DOM (no toggle required)
    expect(section.textContent).toContain("GOES-11 EP8 measurements are a proxy");
    expect(section.textContent).toContain("No onboard surface-charging telemetry");
  });

  // FUI-11 — Clicking a supporting evidence ID opens the provenance panel (async)
  it("FUI-11: clicking a supporting evidence chip shows the provenance panel", async () => {
    renderView();
    // E-G15-0010 is in supporting_evidence_ids for H1 (default active tab)
    const chip = screen.getByTestId("evidence-chip-E-G15-0010");
    fireEvent.click(chip);
    // Provenance panel appears after the async fetch resolves
    await waitFor(() => expect(screen.getByTestId("provenance-panel")).toBeTruthy());
  });

  // FUI-12 — Provenance panel shows correct fields for selected evidence (async)
  it("FUI-12: provenance panel shows timestamp, source, measurement, value, unit", async () => {
    renderView();
    fireEvent.click(screen.getByTestId("evidence-chip-E-G15-0010"));
    await waitFor(() => expect(screen.getByTestId("provenance-panel")).toBeTruthy());
    expect(screen.getByTestId("prov-timestamp").textContent).toBe("2010-04-05T08:55:00Z");
    expect(screen.getByTestId("prov-source").textContent).toBe("GOES11_EP8");
    expect(screen.getByTestId("prov-measurement").textContent).toBe("e_flux");
    expect(screen.getByTestId("prov-value").textContent).toContain("2100");
  });

  // FUI-13 — AI executive summary renders investigation_summary text
  it("FUI-13: executive summary section renders the investigation_summary text", () => {
    renderView();
    const summaryEl = screen.getByTestId("executive-summary-text");
    expect(summaryEl.textContent).toContain(
      "Test summary: no single hypothesis is established as the definitive cause."
    );
  });

  // FUI-14 — Source badge ("LLM" or "Heuristic") appears in executive summary
  it("FUI-14: executive summary section shows a source badge (LLM or Heuristic)", () => {
    renderView();
    const badge = screen.getByTestId("executive-source-badge");
    expect(badge).toBeTruthy();
    expect(["LLM", "Heuristic"]).toContain(badge.textContent.trim());
  });

  // ── Additional correctness checks ─────────────────────────────────────────

  // Causal attribution shows ESTABLISHED when flag is true
  it("shows ESTABLISHED when causal_attribution_established is true", () => {
    renderView({ causal_attribution_established: true });
    const banner = screen.getByTestId("causal-attribution-banner");
    expect(banner.textContent).toContain("ESTABLISHED");
    expect(banner.textContent).not.toContain("NOT ESTABLISHED");
  });

  // Environmental context IDs are NOT rendered inside the supporting evidence section
  it("environmental context IDs do not appear inside the supporting evidence section", () => {
    renderView();
    const supportingSection = screen.getByTestId("section-supporting-evidence");
    // E-G15-0001 is an env-context ID — it must not appear as a supporting chip
    const supportChip = supportingSection.querySelector("[data-testid='evidence-chip-E-G15-0001']");
    expect(supportChip).toBeNull();
  });

  // Provenance panel is dismissed when the same chip is clicked again (toggle)
  it("clicking the same evidence chip again dismisses the provenance panel", async () => {
    renderView();
    const chip = screen.getByTestId("evidence-chip-E-G15-0010");
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByTestId("provenance-panel")).toBeTruthy());
    fireEvent.click(chip);
    expect(screen.queryByTestId("provenance-panel")).toBeNull();
  });

  // Switching hypothesis tabs clears the selected evidence
  it("switching hypothesis tabs clears the provenance panel", async () => {
    renderView();
    fireEvent.click(screen.getByTestId("evidence-chip-E-G15-0010"));
    await waitFor(() => expect(screen.getByTestId("provenance-panel")).toBeTruthy());
    fireEvent.click(screen.getByTestId("tab-H2"));
    expect(screen.queryByTestId("provenance-panel")).toBeNull();
  });

  // Renders gracefully with null report (loading state)
  it("renders a loading placeholder when report is null", () => {
    render(
      <ForensicInvestigationView
        report={null}
        timelineData={[]}
        evidenceGraph={null}
      />
    );
    expect(screen.getByText(/Loading forensic investigation/i)).toBeTruthy();
  });

  // ── Phase 5.1 new tests ───────────────────────────────────────────────────

  // FUI-NEW-1 — All five hypothesis panels are reachable via tab navigation
  it("FUI-NEW-1: each hypothesis tab renders its own panel when selected", () => {
    renderView();
    for (const id of ["H1", "H2", "H3", "H4", "H5"]) {
      fireEvent.click(screen.getByTestId(`tab-${id}`));
      // The active hypothesis header should contain the selected ID
      const view = screen.getByTestId("forensic-investigation-view");
      expect(view.textContent).toContain(id);
    }
  });

  // FUI-NEW-2 — Assessment labels are exactly the categorical strings with no probability text
  it("FUI-NEW-2: assessment labels are exact categorical strings, no probability text", () => {
    renderView();
    expect(screen.getByTestId("assessment-H1").textContent).toBe("Mixed");
    expect(screen.getByTestId("assessment-H2").textContent).toBe("Mixed");
    expect(screen.getByTestId("assessment-H3").textContent).toBe("Supported");
    expect(screen.getByTestId("assessment-H4").textContent).toBe("Insufficient evidence");
    expect(screen.getByTestId("assessment-H5").textContent).toBe("Strongly supported");
    // No percentage or decimal-probability strings anywhere
    const { container } = renderView();
    expect(container.textContent).not.toMatch(/\d+(\.\d+)?%/);
    expect(container.textContent).not.toMatch(/\b(probability|likelihood|confidence)\b/i);
  });

  // FUI-NEW-3 — Environmental context and supporting evidence render in distinct sections
  it("FUI-NEW-3: env-context and supporting-evidence sections are distinct elements", () => {
    renderView();
    const envSection  = screen.getByTestId("section-environmental-context");
    const suppSection = screen.getByTestId("section-supporting-evidence");
    expect(envSection).toBeTruthy();
    expect(suppSection).toBeTruthy();
    // They must be different DOM nodes
    expect(envSection).not.toBe(suppSection);
    // The env section must contain the amber list element
    expect(envSection.querySelector("[data-testid='env-context-list']")).toBeTruthy();
    // The supporting section must NOT contain the amber list element
    expect(suppSection.querySelector("[data-testid='env-context-list']")).toBeNull();
  });

  // FUI-NEW-4 — Per-hypothesis limitations render directly without requiring a toggle
  it("FUI-NEW-4: H1 limitations are visible without any toggle interaction", () => {
    renderView();
    // H1 is the default active tab
    const section = screen.getByTestId("section-hypothesis-limitations");
    expect(section).toBeTruthy();
    expect(section.textContent).toContain("GOES-11 EP8 measurements are a proxy");
    expect(section.textContent).toContain("No spacecraft surface-charging telemetry available");
  });

  // FUI-NEW-5 — causal_attribution_established: false is clearly represented in both surfaces
  it("FUI-NEW-5: causal attribution false is prominently represented", () => {
    renderView();
    // Banner
    const banner = screen.getByTestId("causal-attribution-banner");
    expect(banner.textContent).toContain("NOT ESTABLISHED");
    // Executive summary re-statement
    const { container } = renderView();
    expect(container.textContent).toContain("Not established");
  });

  // FUI-NEW-6 — No numerical probabilities appear anywhere in the rendered output
  it("FUI-NEW-6: no numerical probability strings appear in the rendered output", () => {
    const { container } = renderView();
    // No percentage strings
    expect(container.textContent).not.toMatch(/\d+(\.\d+)?%/);
    // No "probability", "likelihood", or "confidence" words
    expect(container.textContent).not.toMatch(/\b(probability|likelihood|confidence)\b/i);
    // No "X% likely" or similar
    expect(container.textContent).not.toMatch(/\d+\s*percent/i);
  });

  // FUI-NEW-7 — null heuristic_note does not break rendering (H2 has null note)
  it("FUI-NEW-7: null heuristic_note on active hypothesis does not break rendering", () => {
    renderView();
    fireEvent.click(screen.getByTestId("tab-H2"));
    // No error thrown, and the methodological note block is absent
    expect(screen.queryByTestId("hypothesis-heuristic-note")).toBeNull();
    // H2 env-context section still renders
    expect(screen.getByTestId("section-environmental-context")).toBeTruthy();
  });

  // FUI-NEW-8 — Present heuristic_note is rendered in the active hypothesis panel
  it("FUI-NEW-8: non-null heuristic_note is rendered in the active hypothesis panel", () => {
    renderView();
    // H1 is active by default and has heuristic_note set in the fixture
    const note = screen.getByTestId("hypothesis-heuristic-note");
    expect(note).toBeTruthy();
    expect(note.textContent).toContain("MVP temporal selection window");
    expect(note.textContent).toContain("Methodological note");
  });

  // FUI-NEW-9 — Evidence count badges are rendered for the active hypothesis
  it("FUI-NEW-9: evidence count badges appear in the section headings for the active hypothesis", () => {
    renderView();
    // H1 has env_context_count=1, supporting_count=1, non_discriminating_count=1
    const envSection  = screen.getByTestId("section-environmental-context");
    const suppSection = screen.getByTestId("section-supporting-evidence");
    const ndSection   = screen.getByTestId("section-non-discriminating");
    // Each heading should contain a "1" count badge
    expect(envSection.textContent).toContain("1");
    expect(suppSection.textContent).toContain("1");
    expect(ndSection.textContent).toContain("1");
    // Contradicting has count=0 — the badge renders "0"
    const contSection = screen.getByTestId("section-contradicting-evidence");
    expect(contSection.textContent).toContain("0");
  });

  // ── Phase 5.2 traceability tests ──────────────────────────────────────────

  // FUI-P-1 — Selecting an evidence chip calls fetchEvidenceProvenance with the correct ID
  it("FUI-P-1: selecting an evidence chip calls fetchEvidenceProvenance with the correct evidence ID", async () => {
    renderView();
    fireEvent.click(screen.getByTestId("evidence-chip-E-G15-0010"));
    await waitFor(() => expect(screen.getByTestId("provenance-panel")).toBeTruthy());
    expect(fetchEvidenceProvenance).toHaveBeenCalledWith("galaxy-15", "E-G15-0010");
  });

  // FUI-P-2 — All 12 required provenance fields render when the API returns them
  it("FUI-P-2: all 12 required provenance fields render in the panel", async () => {
    renderView();
    fireEvent.click(screen.getByTestId("evidence-chip-E-G15-0010"));
    await waitFor(() => expect(screen.getByTestId("provenance-panel")).toBeTruthy());

    expect(screen.getByTestId("prov-evidence-id").textContent).toBe("E-G15-0010");
    expect(screen.getByTestId("prov-timestamp").textContent).toBe("2010-04-05T08:55:00Z");
    expect(screen.getByTestId("prov-source").textContent).toBe("GOES11_EP8");
    expect(screen.getByTestId("prov-measurement").textContent).toBe("e_flux");
    // value and unit are co-located
    expect(screen.getByTestId("prov-value").textContent).toContain("2100");
    expect(screen.getByTestId("prov-unit").textContent).toContain("particles/cm2/s/sr");
    expect(screen.getByTestId("prov-resolution").textContent).toBe("5min");
    expect(screen.getByTestId("prov-dataset-id").textContent).toBe("GOES11_K0_EP8");
    expect(screen.getByTestId("prov-provider").textContent).toBe("NASA CDAWeb");
    expect(screen.getByTestId("prov-variable").textContent).toBe("E_1MEV_IC");
    expect(screen.getByTestId("prov-evidence-type").textContent).toBe("environmental_observation");
    // quality is null in the fixture — renders as "—"
    expect(screen.getByTestId("prov-quality").textContent).toBe("—");
  });

  // FUI-P-3 — Each hypothesis relationship entry renders all its fields
  it("FUI-P-3: each hypothesis relationship entry renders hypothesis ID, list name, relationship label, and interpretation", async () => {
    renderView();
    fireEvent.click(screen.getByTestId("evidence-chip-E-G15-0010"));
    await waitFor(() => expect(screen.getByTestId("provenance-panel")).toBeTruthy());

    // H1 relationship
    const h1Rel = screen.getByTestId("prov-relationship-H1");
    expect(h1Rel).toBeTruthy();
    expect(h1Rel.textContent).toContain("H1");
    expect(screen.getByTestId("prov-rel-label-H1").textContent).toBe("elevated_flux_supports_charging");
    expect(screen.getByTestId("prov-rel-interpretation-H1").textContent).toContain(
      "consistent with spacecraft charging conditions"
    );

    // H2 relationship
    const h2Rel = screen.getByTestId("prov-relationship-H2");
    expect(h2Rel).toBeTruthy();
    expect(h2Rel.textContent).toContain("H2");
    expect(screen.getByTestId("prov-rel-label-H2").textContent).toBe(
      "energetic_particle_environment_at_anomaly_time"
    );
  });

  // FUI-P-4 — Relationship type (list_name) renders with correct human-readable label
  it("FUI-P-4: relationship list_name renders as the correct human-readable label", async () => {
    renderView();
    fireEvent.click(screen.getByTestId("evidence-chip-E-G15-0010"));
    await waitFor(() => expect(screen.getByTestId("provenance-panel")).toBeTruthy());

    // H1 is supporting_evidence
    expect(screen.getByTestId("prov-list-name-H1").textContent).toBe("Supporting evidence");
    // H2 is environmental_context
    expect(screen.getByTestId("prov-list-name-H2").textContent).toBe("Environmental context");
  });

  // FUI-P-5 — Unknown evidence ID (found: false) shows not-found message without crashing
  it("FUI-P-5: unknown evidence ID shows not-found message without crashing the view", async () => {
    fetchEvidenceProvenance.mockResolvedValueOnce(PROVENANCE_NOT_FOUND_FIXTURE);
    renderView();
    // Click the env-context chip (E-G15-0001) — we override the mock for this call
    fireEvent.click(screen.getByTestId("env-chip-E-G15-0001"));
    await waitFor(() => expect(screen.getByTestId("provenance-panel")).toBeTruthy());
    expect(screen.getByTestId("prov-not-found").textContent).toContain("E-G15-9999");
    // The rest of the investigation view must still be intact
    expect(screen.getByTestId("causal-attribution-banner")).toBeTruthy();
    expect(screen.getByTestId("section-hypothesis-comparison")).toBeTruthy();
  });

  // FUI-P-6 — Provenance fetch failure shows error message without crashing the view
  it("FUI-P-6: a provenance fetch failure shows an error message without crashing the view", async () => {
    fetchEvidenceProvenance.mockRejectedValueOnce(new Error("Network error"));
    renderView();
    fireEvent.click(screen.getByTestId("evidence-chip-E-G15-0010"));
    await waitFor(() => expect(screen.getByTestId("provenance-panel")).toBeTruthy());
    expect(screen.getByTestId("prov-error").textContent).toContain(
      "Provenance lookup failed — investigation view remains intact."
    );
    // The rest of the view must still be intact
    expect(screen.getByTestId("causal-attribution-banner")).toBeTruthy();
    expect(screen.getByTestId("section-limitations")).toBeTruthy();
  });

  // FUI-P-7 — EPHEMERIS evidence: found: true but hypothesis_relationships is empty
  it("FUI-P-7: EPHEMERIS evidence shows provenance fields but no hypothesis relationships", async () => {
    fetchEvidenceProvenance.mockResolvedValueOnce(PROVENANCE_EPHEMERIS_FIXTURE);
    renderView();
    // Click the env-context chip (E-G15-0001) — mock returns the EPHEMERIS fixture
    fireEvent.click(screen.getByTestId("env-chip-E-G15-0001"));
    await waitFor(() => expect(screen.getByTestId("provenance-panel")).toBeTruthy());

    // Evidence fields are shown
    expect(screen.getByTestId("prov-source").textContent).toBe("GOES11_EPHEMERIS");
    expect(screen.getByTestId("prov-evidence-id").textContent).toBe("E-G15-0005");

    // No hypothesis relationship entries
    expect(screen.queryByTestId("prov-relationship-H1")).toBeNull();
    expect(screen.queryByTestId("prov-relationship-H2")).toBeNull();

    // "No hypothesis relationships" note is shown
    expect(screen.getByTestId("prov-no-relationships")).toBeTruthy();
    expect(screen.getByTestId("prov-no-relationships").textContent).toContain(
      "No hypothesis relationships"
    );
  });
});

// ── Phase 5.5: Loading state, error, empty evidence, and ARIA tests ───────────

describe("ForensicInvestigationView — loading state", () => {
  // FUI-5-1 — report=null renders loading placeholder
  it("FUI-5-1: renders a loading placeholder with testid when report is null", () => {
    render(
      <ForensicInvestigationView
        report={null}
        timelineData={TIMELINE_FIXTURE}
        evidenceGraph={GRAPH_FIXTURE}
      />
    );
    expect(screen.getByTestId("forensic-investigation-view")).toBeTruthy();
    expect(screen.getByTestId("forensic-investigation-loading")).toBeTruthy();
    expect(screen.getByTestId("forensic-investigation-loading").textContent).toContain(
      "Loading forensic investigation"
    );
  });
});

describe("ForensicInvestigationView — empty evidence state (H4 profile)", () => {
  // FUI-5-2 — hypothesis with zero evidence in all four lists renders without crash
  it("FUI-5-2: hypothesis with all lists empty renders empty-state messages without crashing", () => {
    renderView();
    // Switch to H4 — all evidence_summary counts are 0
    fireEvent.click(screen.getByTestId("tab-H4"));
    // The four evidence sections should render empty-state text
    expect(screen.getByTestId("section-environmental-context").textContent).toContain(
      "No environmental context records"
    );
    expect(screen.getByTestId("section-supporting-evidence").textContent).toContain(
      "None for this hypothesis"
    );
    expect(screen.getByTestId("section-contradicting-evidence").textContent).toContain(
      "None for this hypothesis"
    );
    expect(screen.getByTestId("section-non-discriminating").textContent).toContain(
      "None for this hypothesis"
    );
  });
});

describe("ForensicInvestigationView — accessibility attributes", () => {
  // FUI-5-3 — hypothesis tab strip has correct ARIA roles
  it("FUI-5-3: hypothesis tab strip has role=tablist; tabs have role=tab", () => {
    renderView();
    const tablist = screen.getByRole("tablist", { name: /Hypothesis selection/i });
    expect(tablist).toBeTruthy();
    const tabs = tablist.querySelectorAll("[role='tab']");
    expect(tabs.length).toBe(5); // H1–H5
  });

  // FUI-5-4 — active hypothesis tab has aria-selected=true; others false
  it("FUI-5-4: active tab has aria-selected true; inactive tabs have aria-selected false", () => {
    renderView();
    const h1Tab = screen.getByTestId("tab-H1");
    const h2Tab = screen.getByTestId("tab-H2");
    expect(h1Tab.getAttribute("aria-selected")).toBe("true");
    expect(h2Tab.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(h2Tab);
    expect(h2Tab.getAttribute("aria-selected")).toBe("true");
    expect(h1Tab.getAttribute("aria-selected")).toBe("false");
  });

  // FUI-5-5 — evidence chips have aria-label containing the evidence ID
  it("FUI-5-5: supporting-evidence chip has aria-label containing the evidence ID", () => {
    renderView();
    const chip = screen.getByTestId("evidence-chip-E-G15-0010");
    const label = chip.getAttribute("aria-label");
    expect(label).toBeTruthy();
    expect(label).toContain("E-G15-0010");
  });

  // FUI-5-6 — environmental context chips have aria-label containing the evidence ID
  it("FUI-5-6: environmental-context chip has aria-label containing the evidence ID", () => {
    renderView();
    const chip = screen.getByTestId("env-chip-E-G15-0001");
    const label = chip.getAttribute("aria-label");
    expect(label).toBeTruthy();
    expect(label).toContain("E-G15-0001");
  });
});


// ── buildInterpretationMap unit tests ─────────────────────────────────────────

describe("buildInterpretationMap", () => {
  it("returns an empty object for null/undefined input", () => {
    expect(buildInterpretationMap(null)).toEqual({});
    expect(buildInterpretationMap(undefined)).toEqual({});
    expect(buildInterpretationMap({})).toEqual({});
  });

  it("extracts interpretation text for each evidence ID across all lists", () => {
    const map = buildInterpretationMap(GRAPH_FIXTURE);
    expect(map["E-G15-0001"]).toContain("particle environment");
    expect(map["E-G15-0010"]).toContain("charging conditions");
    expect(map["E-G15-0020"]).toContain("Temporal proximity");
  });

  it("handles hypotheses with empty relationship lists gracefully", () => {
    const graph = {
      hypotheses: [
        {
          hypothesis_id: "H3",
          environmental_context: [],
          supporting_evidence: [],
          contradicting_evidence: [],
          non_discriminating_evidence: [],
        },
      ],
    };
    expect(() => buildInterpretationMap(graph)).not.toThrow();
    expect(buildInterpretationMap(graph)).toEqual({});
  });
});

// ── Phase 5.7: resilience, error states, and scientific-label correctness ──────

describe("ForensicInvestigationView — API error state", () => {
  // FUI-57-1 — error prop renders error sentinel, not loading or content
  it("FUI-57-1: renders forensic-investigation-error when error prop is a string", () => {
    render(
      <ForensicInvestigationView
        report={null}
        timelineData={[]}
        evidenceGraph={null}
        error="HTTP 500 — internal server error"
      />
    );
    expect(screen.getByTestId("forensic-investigation-view")).toBeTruthy();
    expect(screen.getByTestId("forensic-investigation-error")).toBeTruthy();
    // Must NOT show loading placeholder
    expect(screen.queryByTestId("forensic-investigation-loading")).toBeNull();
  });

  // FUI-57-2 — error message text is shown in the error state
  it("FUI-57-2: error prop string appears in the error state output", () => {
    render(
      <ForensicInvestigationView
        report={null}
        timelineData={[]}
        evidenceGraph={null}
        error="Case not found: unknown-case"
      />
    );
    const el = screen.getByTestId("forensic-investigation-error");
    expect(el.textContent).toContain("Case not found: unknown-case");
  });

  // FUI-57-3 — boolean true error prop shows a safe generic message (no raw error object)
  it("FUI-57-3: boolean error prop renders generic safe message without crashing", () => {
    render(
      <ForensicInvestigationView
        report={null}
        timelineData={[]}
        evidenceGraph={null}
        error={true}
      />
    );
    const el = screen.getByTestId("forensic-investigation-error");
    expect(el.textContent).toContain("API returned an error");
    // No stack-trace or path-like text
    expect(el.textContent).not.toMatch(/at Object\.|node_modules|\/Users\//);
  });

  // FUI-57-4 — error state never renders hypothesis rows or scientific conclusions
  it("FUI-57-4: error state does not render any hypothesis rows or scientific conclusions", () => {
    render(
      <ForensicInvestigationView
        report={null}
        timelineData={[]}
        evidenceGraph={null}
        error="Service unavailable"
      />
    );
    // No hypothesis rows
    expect(screen.queryByTestId("hypothesis-row-H1")).toBeNull();
    expect(screen.queryByTestId("hypothesis-row-H5")).toBeNull();
    // No causal attribution banner (would imply a scientific conclusion)
    expect(screen.queryByTestId("causal-attribution-banner")).toBeNull();
  });

  // FUI-57-5 — error prop takes priority over null report (error renders, not loading)
  it("FUI-57-5: error prop takes priority — error state shown even when report is null", () => {
    render(
      <ForensicInvestigationView
        report={null}
        timelineData={[]}
        evidenceGraph={null}
        error="Timeout"
      />
    );
    expect(screen.getByTestId("forensic-investigation-error")).toBeTruthy();
    expect(screen.queryByTestId("forensic-investigation-loading")).toBeNull();
  });
});

describe("ForensicInvestigationView — unavailable/empty report", () => {
  // FUI-57-6 — report={} (no hypotheses) renders unavailable state
  it("FUI-57-6: report with no hypotheses renders forensic-investigation-unavailable", () => {
    render(
      <ForensicInvestigationView
        report={{}}
        timelineData={[]}
        evidenceGraph={null}
      />
    );
    expect(screen.getByTestId("forensic-investigation-view")).toBeTruthy();
    expect(screen.getByTestId("forensic-investigation-unavailable")).toBeTruthy();
    expect(
      screen.getByTestId("forensic-investigation-unavailable").textContent
    ).toContain("unavailable");
  });

  // FUI-57-7 — empty hypotheses array also renders unavailable state
  it("FUI-57-7: report with empty hypotheses array renders unavailable state", () => {
    render(
      <ForensicInvestigationView
        report={{ hypotheses: [], causal_attribution_established: false }}
        timelineData={[]}
        evidenceGraph={null}
      />
    );
    expect(screen.getByTestId("forensic-investigation-unavailable")).toBeTruthy();
    // No hypothesis comparison table rendered
    expect(screen.queryByTestId("section-hypothesis-comparison")).toBeNull();
  });

  // FUI-57-8 — unavailable state does not show loading placeholder
  it("FUI-57-8: unavailable state does not render loading text", () => {
    render(
      <ForensicInvestigationView
        report={{ hypotheses: [] }}
        timelineData={[]}
        evidenceGraph={null}
      />
    );
    expect(screen.queryByTestId("forensic-investigation-loading")).toBeNull();
  });
});

describe("ForensicInvestigationView — scientific label correctness", () => {
  beforeEach(() => {
    fetchEvidenceProvenance.mockResolvedValue(PROVENANCE_FIXTURE);
  });

  // FUI-57-9 — H1 Mixed assessment never implies causal establishment
  it("FUI-57-9: H1 assessment badge shows Mixed — never Established or Confirmed", () => {
    renderView();
    const badge = screen.getByTestId("assessment-H1");
    expect(badge.textContent).toBe("Mixed");
    expect(badge.textContent).not.toMatch(/established|confirmed|proven|caused/i);
  });

  // FUI-57-10 — H2 Mixed assessment never implies causal establishment
  it("FUI-57-10: H2 assessment badge shows Mixed — never Established or Confirmed", () => {
    renderView();
    const badge = screen.getByTestId("assessment-H2");
    expect(badge.textContent).toBe("Mixed");
    expect(badge.textContent).not.toMatch(/established|confirmed|proven|caused/i);
  });

  // FUI-57-11 — H5 Strongly supported clearly rendered as the strongest conclusion
  it("FUI-57-11: H5 assessment is Strongly supported and present in the hypothesis table", () => {
    renderView();
    const row = screen.getByTestId("hypothesis-row-H5");
    expect(row).toBeTruthy();
    const badge = screen.getByTestId("assessment-H5");
    expect(badge.textContent).toBe("Strongly supported");
  });

  // FUI-57-12 — H5 tab is reachable and renders its panel without errors
  it("FUI-57-12: clicking H5 tab renders its panel without errors", () => {
    renderView();
    const tab = screen.getByTestId("tab-H5");
    fireEvent.click(tab);
    // H5 panel must be visible and contain the hypothesis ID
    const view = screen.getByTestId("forensic-investigation-view");
    expect(view.textContent).toContain("H5");
    // Causal attribution banner must still show NOT ESTABLISHED
    expect(screen.getByTestId("causal-attribution-banner").textContent).toContain("NOT ESTABLISHED");
  });

  // FUI-57-13 — Environmental context section heading never reads "Supporting"
  it("FUI-57-13: environmental context section label is not 'Supporting' or 'Supporting Evidence'", () => {
    renderView();
    const envSection = screen.getByTestId("section-environmental-context");
    const heading = envSection.querySelector("h3");
    expect(heading).toBeTruthy();
    // Heading text must include "Environmental" and must NOT include "Supporting"
    expect(heading.textContent).toMatch(/environmental/i);
    expect(heading.textContent).not.toMatch(/^supporting/i);
  });

  // FUI-57-14 — Environmental context label inside the list explicitly states it is NOT supporting
  it("FUI-57-14: env-context list carries explicit disambiguation text", () => {
    renderView();
    const list = screen.getByTestId("env-context-list");
    expect(list.textContent).toMatch(/not supporting evidence/i);
  });

  // FUI-57-15 — Causal attribution NOT ESTABLISHED banner is always present in the full report view
  it("FUI-57-15: causal attribution NOT ESTABLISHED banner is always present on a successful report", () => {
    renderView();
    const banner = screen.getByTestId("causal-attribution-banner");
    expect(banner.textContent).toContain("NOT ESTABLISHED");
    // The banner must have its own visible text (not hidden by CSS class in DOM string)
    expect(banner.textContent).not.toContain("ESTABLISHED\nNOT");
  });

  // FUI-57-16 — The word "cause" never appears as an unqualified standalone claim
  it("FUI-57-16: rendered output does not contain bare 'cause:' or 'caused by:' as section labels", () => {
    const { container } = renderView();
    // Labels like "Cause:" or "Caused by:" would imply established causation
    expect(container.textContent).not.toMatch(/\bCause:\s/i);
    expect(container.textContent).not.toMatch(/\bCaused by:\s/i);
  });

  // FUI-57-17 — Assessment labels carry no numerical probabilities anywhere in the view
  it("FUI-57-17: no numerical probability strings appear in the complete rendered output", () => {
    const { container } = renderView();
    expect(container.textContent).not.toMatch(/\d+(\.\d+)?%/);
    expect(container.textContent).not.toMatch(/\b(probability|likelihood|confidence score)\b/i);
  });
});

describe("ForensicInvestigationView — loading state (Phase 5.7 extension)", () => {
  // FUI-57-18 — loading state is unambiguously distinct from error and unavailable
  it("FUI-57-18: loading state has forensic-investigation-loading testid and no error or unavailable testid", () => {
    render(
      <ForensicInvestigationView
        report={null}
        timelineData={[]}
        evidenceGraph={null}
      />
    );
    expect(screen.getByTestId("forensic-investigation-loading")).toBeTruthy();
    expect(screen.queryByTestId("forensic-investigation-error")).toBeNull();
    expect(screen.queryByTestId("forensic-investigation-unavailable")).toBeNull();
  });

  // FUI-57-19 — loading state does not show any hypothesis rows
  it("FUI-57-19: loading state does not render any hypothesis rows", () => {
    render(
      <ForensicInvestigationView
        report={null}
        timelineData={[]}
        evidenceGraph={null}
      />
    );
    expect(screen.queryByTestId("hypothesis-row-H1")).toBeNull();
    expect(screen.queryByTestId("causal-attribution-banner")).toBeNull();
  });
});
