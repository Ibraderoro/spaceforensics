import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import InvestigationTimeline from "./InvestigationTimeline";

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

// Anchor is 2010-04-05T09:48:00Z — window is 09:38:00–09:58:00Z
const ANCHOR_TIMESTAMP = "2010-04-05T09:48:00Z";

/**
 * Representative 7-record fixture spanning all source types.
 * Records labelled IN_WINDOW are within ±10 minutes of ANCHOR_TIMESTAMP.
 */
const TIMELINE_FIXTURE = [
  // CASE anchor — IN_WINDOW (at the anchor itself)
  {
    evidence_id: "E-G15-0100",
    timestamp: "2010-04-05T09:48:00Z",
    source: "CASE",
    measurement: "command_loss_event",
    value: 1,
    unit: null,
    resolution: "point",
    dataset_id: null,
    provider: null,
    variable: null,
    evidence_type: "case_event",
    quality: null,
  },
  // EP8 record — IN_WINDOW (+5 min)
  {
    evidence_id: "E-G15-0101",
    timestamp: "2010-04-05T09:53:00Z",
    source: "GOES11_EP8",
    measurement: "e_flux",
    value: 2100.5,
    unit: "particles/cm2/s/sr",
    resolution: "5min",
    dataset_id: "GOES11_K0_EP8",
    provider: "NASA CDAWeb",
    variable: "E_1MEV_IC",
    evidence_type: "environmental_observation",
    quality: null,
  },
  // EP8 record — OUTSIDE window (>10 min before anchor)
  {
    evidence_id: "E-G15-0050",
    timestamp: "2010-04-05T08:00:00Z",
    source: "GOES11_EP8",
    measurement: "e_flux",
    value: 800.0,
    unit: "particles/cm2/s/sr",
    resolution: "5min",
    dataset_id: "GOES11_K0_EP8",
    provider: "NASA CDAWeb",
    variable: "E_1MEV_IC",
    evidence_type: "environmental_observation",
    quality: null,
  },
  // MAG record — IN_WINDOW (-3 min)
  {
    evidence_id: "E-G15-0098",
    timestamp: "2010-04-05T09:45:00Z",
    source: "GOES11_MAG",
    measurement: "b_gsm",
    value: 42.1,
    unit: "nT",
    resolution: "1min",
    dataset_id: null,
    provider: null,
    variable: "B_GSM",
    evidence_type: "environmental_observation",
    quality: null,
  },
  // MAG record — OUTSIDE window (>10 min after anchor)
  {
    evidence_id: "E-G15-0120",
    timestamp: "2010-04-05T11:00:00Z",
    source: "GOES11_MAG",
    measurement: "b_gsm",
    value: 38.5,
    unit: "nT",
    resolution: "1min",
    dataset_id: null,
    provider: null,
    variable: "B_GSM",
    evidence_type: "environmental_observation",
    quality: null,
  },
  // EPHEMERIS record — IN_WINDOW (+2 min)
  {
    evidence_id: "E-G15-0102",
    timestamp: "2010-04-05T09:50:00Z",
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
  },
  // EPHEMERIS record — OUTSIDE window
  {
    evidence_id: "E-G15-0010",
    timestamp: "2010-04-05T08:30:00Z",
    source: "GOES11_EPHEMERIS",
    measurement: "position",
    value: 42160.0,
    unit: "km",
    resolution: "1min",
    dataset_id: null,
    provider: null,
    variable: null,
    evidence_type: "environmental_observation",
    quality: null,
  },
];

/** Provenance fixture for E-G15-0101 (EP8, with hypothesis relationships). */
const PROVENANCE_FIXTURE = {
  found: true,
  evidence_id: "E-G15-0101",
  timestamp: "2010-04-05T09:53:00Z",
  source: "GOES11_EP8",
  measurement: "e_flux",
  value: 2100.5,
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

/** Provenance fixture for EPHEMERIS record — no hypothesis relationships. */
const PROVENANCE_EPHEMERIS_FIXTURE = {
  found: true,
  evidence_id: "E-G15-0102",
  timestamp: "2010-04-05T09:50:00Z",
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

/** Report hypotheses fixture for assessment badge lookup. */
const REPORT_HYPOTHESES = [
  { hypothesis_id: "H1", label: "Spacecraft charging / electrostatic discharge", assessment: "mixed" },
  { hypothesis_id: "H2", label: "Single event upset", assessment: "mixed" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderTimeline(timelineOverride, propsOverride = {}) {
  const timeline = timelineOverride ?? TIMELINE_FIXTURE;
  return render(
    <InvestigationTimeline
      timelineData={timeline}
      anchorTimestamp={ANCHOR_TIMESTAMP}
      reportHypotheses={REPORT_HYPOTHESES}
      {...propsOverride}
    />
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("InvestigationTimeline", () => {

  beforeEach(() => {
    fetchEvidenceProvenance.mockResolvedValue(PROVENANCE_FIXTURE);
  });

  // TL-1 — Component renders without crashing on empty timeline
  it("TL-1: renders without crashing when given an empty timeline", () => {
    renderTimeline([]);
    expect(screen.getByTestId("investigation-timeline")).toBeTruthy();
    expect(screen.getByTestId("timeline-list")).toBeTruthy();
  });

  // TL-2 — A timeline of arbitrary size renders all rows
  it("TL-2: renders a row for every record in the timeline", () => {
    // Generate 278 synthetic records
    const records = Array.from({ length: 278 }, (_, i) => ({
      evidence_id: `E-G15-${String(i + 1).padStart(4, "0")}`,
      timestamp: `2010-04-05T08:00:${String(i % 60).padStart(2, "0")}Z`,
      source: ["CASE", "GOES11_EP8", "GOES11_MAG", "GOES11_EPHEMERIS"][i % 4],
      measurement: "e_flux",
      value: i * 10,
      unit: "particles/cm2/s/sr",
      resolution: "5min",
      dataset_id: null,
      provider: null,
      variable: null,
      evidence_type: "environmental_observation",
      quality: null,
    }));
    renderTimeline(records);
    const list = screen.getByTestId("timeline-list");
    // Each record produces a button row with data-testid="timeline-row-{id}"
    expect(list.querySelectorAll(`[data-testid^="timeline-row-"]`).length).toBe(278);
  });

  // TL-3 — CASE anchor row is identifiable by its anchor badge
  it("TL-3: CASE anchor row is identifiable by its anchor badge", () => {
    renderTimeline();
    const anchorBadge = screen.getByTestId("anchor-badge");
    expect(anchorBadge).toBeTruthy();
    expect(anchorBadge.textContent).toContain("Anomaly anchor");
    // The row itself must be present
    expect(screen.getByTestId("timeline-row-E-G15-0100")).toBeTruthy();
  });

  // TL-4 — EP8 records render with their source label
  it("TL-4: EP8 records render with their source label", () => {
    renderTimeline();
    const row = screen.getByTestId("timeline-row-E-G15-0101");
    expect(row).toBeTruthy();
    expect(row.textContent).toContain("Particle flux (EP8)");
  });

  // TL-5 — MAG records render with their source label
  it("TL-5: MAG records render with their source label", () => {
    renderTimeline();
    const row = screen.getByTestId("timeline-row-E-G15-0098");
    expect(row).toBeTruthy();
    expect(row.textContent).toContain("Magnetic field (MAG)");
  });

  // TL-6 — EPHEMERIS records render with their source label
  it("TL-6: EPHEMERIS records render with their source label", () => {
    renderTimeline();
    const row = screen.getByTestId("timeline-row-E-G15-0102");
    expect(row).toBeTruthy();
    expect(row.textContent).toContain("Ephemeris (positional)");
  });

  // TL-7 — EPHEMERIS records carry the "not hypothesis evidence" badge
  it("TL-7: EPHEMERIS records carry the positional-data badge", () => {
    renderTimeline();
    const badge = screen.getByTestId("ephemeris-badge-E-G15-0102");
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain("Positional data — not hypothesis evidence");
  });

  // TL-8 — Selecting a record triggers fetchEvidenceProvenance and shows the panel
  it("TL-8: selecting a record calls fetchEvidenceProvenance and shows the provenance panel", async () => {
    renderTimeline();
    fireEvent.click(screen.getByTestId("timeline-row-E-G15-0101"));
    await waitFor(() => expect(screen.getByTestId("timeline-provenance-panel")).toBeTruthy());
    expect(fetchEvidenceProvenance).toHaveBeenCalledWith("galaxy-15", "E-G15-0101");
  });

  // TL-9 — Provenance panel shows all 12 required fields
  it("TL-9: provenance panel shows all 12 required evidence fields", async () => {
    renderTimeline();
    fireEvent.click(screen.getByTestId("timeline-row-E-G15-0101"));
    await waitFor(() => expect(screen.getByTestId("timeline-provenance-panel")).toBeTruthy());

    expect(screen.getByTestId("tl-prov-evidence-id").textContent).toBe("E-G15-0101");
    expect(screen.getByTestId("tl-prov-timestamp").textContent).toBe("2010-04-05T09:53:00Z");
    expect(screen.getByTestId("tl-prov-source").textContent).toBe("GOES11_EP8");
    expect(screen.getByTestId("tl-prov-measurement").textContent).toBe("e_flux");
    expect(screen.getByTestId("tl-prov-value").textContent).toContain("2100.5");
    expect(screen.getByTestId("tl-prov-unit").textContent).toContain("particles/cm2/s/sr");
    expect(screen.getByTestId("tl-prov-resolution").textContent).toBe("5min");
    expect(screen.getByTestId("tl-prov-dataset-id").textContent).toBe("GOES11_K0_EP8");
    expect(screen.getByTestId("tl-prov-provider").textContent).toBe("NASA CDAWeb");
    expect(screen.getByTestId("tl-prov-variable").textContent).toBe("E_1MEV_IC");
    expect(screen.getByTestId("tl-prov-evidence-type").textContent).toBe("environmental_observation");
    expect(screen.getByTestId("tl-prov-quality").textContent).toBe("—");
  });

  // TL-10 — Temporal window disclaimer is present with the mandated text
  it("TL-10: the temporal window banner is present with the mandated labels", () => {
    renderTimeline();
    const banner = screen.getByTestId("temporal-window-banner");
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain("MVP temporal selection window");
    expect(banner.textContent).toContain(
      "Evidence-selection heuristic; not a scientifically calibrated causal threshold"
    );
  });

  // TL-11 — Records within ±10 minutes have a window indicator
  it("TL-11: records within the ±10-minute window have a window indicator", () => {
    renderTimeline();
    // E-G15-0100 (CASE, at anchor) — IN_WINDOW
    expect(screen.getByTestId("window-indicator-E-G15-0100")).toBeTruthy();
    // E-G15-0101 (EP8, +5 min) — IN_WINDOW
    expect(screen.getByTestId("window-indicator-E-G15-0101")).toBeTruthy();
    // E-G15-0098 (MAG, -3 min) — IN_WINDOW
    expect(screen.getByTestId("window-indicator-E-G15-0098")).toBeTruthy();
    // E-G15-0050 (EP8, >>10 min before) — NOT in window
    expect(screen.queryByTestId("window-indicator-E-G15-0050")).toBeNull();
    // E-G15-0120 (MAG, >>10 min after) — NOT in window
    expect(screen.queryByTestId("window-indicator-E-G15-0120")).toBeNull();
  });

  // TL-12 — EPHEMERIS provenance shows "No hypothesis relationships" note
  it("TL-12: EPHEMERIS provenance shows the no-relationships note", async () => {
    fetchEvidenceProvenance.mockResolvedValueOnce(PROVENANCE_EPHEMERIS_FIXTURE);
    renderTimeline();
    fireEvent.click(screen.getByTestId("timeline-row-E-G15-0102"));
    await waitFor(() => expect(screen.getByTestId("timeline-provenance-panel")).toBeTruthy());

    expect(screen.getByTestId("tl-prov-source").textContent).toBe("GOES11_EPHEMERIS");
    expect(screen.getByTestId("tl-prov-no-relationships")).toBeTruthy();
    expect(screen.getByTestId("tl-prov-no-relationships").textContent).toContain(
      "No hypothesis relationships"
    );
    // No H1 or H2 relationship entry
    expect(screen.queryByTestId("tl-prov-relationship-H1")).toBeNull();
    expect(screen.queryByTestId("tl-prov-relationship-H2")).toBeNull();
  });

  // TL-13 — No causal language is introduced anywhere in the rendered output
  it("TL-13: no causal language appears in the rendered output", () => {
    const { container } = renderTimeline();
    expect(container.textContent).not.toMatch(/\b(causes?|caused|proves?|proved|confirms?|establishes)\b/i);
    // No probability or confidence scores
    expect(container.textContent).not.toMatch(/\d+(\.\d+)?%/);
    expect(container.textContent).not.toMatch(/\b(probability|likelihood|confidence)\b/i);
  });

  // TL-14 — Provenance fetch failure shows error message without crashing
  it("TL-14: a provenance fetch failure shows an error message without crashing", async () => {
    fetchEvidenceProvenance.mockRejectedValueOnce(new Error("Network error"));
    renderTimeline();
    fireEvent.click(screen.getByTestId("timeline-row-E-G15-0101"));
    await waitFor(() => expect(screen.getByTestId("timeline-provenance-panel")).toBeTruthy());
    expect(screen.getByTestId("tl-prov-error").textContent).toContain(
      "Provenance lookup failed — timeline view remains intact."
    );
    // Rest of the component is intact
    expect(screen.getByTestId("investigation-timeline")).toBeTruthy();
    expect(screen.getByTestId("temporal-window-banner")).toBeTruthy();
  });

  // ── Additional correctness checks ─────────────────────────────────────────

  // Deselecting the same row clears the provenance panel
  it("clicking the same row again deselects it and clears the provenance panel", async () => {
    renderTimeline();
    fireEvent.click(screen.getByTestId("timeline-row-E-G15-0101"));
    await waitFor(() => expect(screen.getByTestId("timeline-provenance-panel")).toBeTruthy());
    fireEvent.click(screen.getByTestId("timeline-row-E-G15-0101"));
    expect(screen.queryByTestId("timeline-provenance-panel")).toBeNull();
  });

  // Source filter tab shows only records of that source
  it("source filter tabs filter records by source type", () => {
    renderTimeline();
    fireEvent.click(screen.getByTestId("filter-GOES11_EPHEMERIS"));
    // Only EPHEMERIS rows should be shown
    expect(screen.getByTestId("timeline-row-E-G15-0102")).toBeTruthy();
    expect(screen.getByTestId("timeline-row-E-G15-0010")).toBeTruthy();
    // Non-EPHEMERIS rows must not appear
    expect(screen.queryByTestId("timeline-row-E-G15-0100")).toBeNull();
    expect(screen.queryByTestId("timeline-row-E-G15-0101")).toBeNull();
  });

  // Records count in header
  it("shows total record count in the header", () => {
    renderTimeline();
    const header = screen.getByTestId("investigation-timeline");
    expect(header.textContent).toContain(`${TIMELINE_FIXTURE.length} records`);
  });
});

// ── Phase 5.5: Loading state, empty timeline, and ARIA tests ─────────────────

describe("InvestigationTimeline — empty timeline", () => {
  // TL-5-1 — empty timelineData renders structure without crashing
  it("TL-5-1: empty timelineData renders header, banner, and filter tabs without crashing", () => {
    renderTimeline([]);
    expect(screen.getByTestId("investigation-timeline")).toBeTruthy();
    expect(screen.getByTestId("temporal-window-banner")).toBeTruthy();
    // "All" filter tab and at least the source filter tabs are rendered regardless
    const list = screen.getByTestId("timeline-list");
    expect(list).toBeTruthy();
    // No rows rendered
    expect(list.querySelectorAll("[data-testid^='timeline-row-']").length).toBe(0);
  });

  // TL-5-2 — empty source filter shows empty-state message
  it("TL-5-2: empty source-filter result shows 'No records for this source filter'", () => {
    // Render with only CASE records, then click GOES11_EP8 filter
    renderTimeline([TIMELINE_FIXTURE[0]]); // only the CASE anchor
    fireEvent.click(screen.getByTestId("filter-GOES11_EP8"));
    expect(screen.getByText(/No records for this source filter/i)).toBeTruthy();
  });
});

describe("InvestigationTimeline — accessibility attributes", () => {
  // TL-5-3 — source filter buttons have aria-label and aria-pressed
  it("TL-5-3: source filter buttons have aria-label and aria-pressed=false when inactive", () => {
    renderTimeline();
    const ep8Btn = screen.getByTestId("filter-GOES11_EP8");
    expect(ep8Btn.getAttribute("aria-label")).toBeTruthy();
    expect(ep8Btn.getAttribute("aria-pressed")).toBe("false");
  });

  // TL-5-4 — source filter aria-pressed becomes true after clicking
  it("TL-5-4: source filter aria-pressed becomes true after selecting the filter", () => {
    renderTimeline();
    const ep8Btn = screen.getByTestId("filter-GOES11_EP8");
    fireEvent.click(ep8Btn);
    expect(ep8Btn.getAttribute("aria-pressed")).toBe("true");
  });

  // TL-5-5 — timeline row buttons have aria-label containing the evidence ID
  it("TL-5-5: timeline row button has aria-label containing the evidence ID", () => {
    renderTimeline();
    const row = screen.getByTestId("timeline-row-E-G15-0101");
    const label = row.getAttribute("aria-label");
    expect(label).toBeTruthy();
    expect(label).toContain("E-G15-0101");
  });

  // TL-5-6 — timeline row aria-pressed reflects selection state
  it("TL-5-6: timeline row aria-pressed is false initially and true after selection", async () => {
    fetchEvidenceProvenance.mockResolvedValueOnce(PROVENANCE_FIXTURE);
    renderTimeline();
    const row = screen.getByTestId("timeline-row-E-G15-0101");
    expect(row.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(row);
    await waitFor(() =>
      expect(row.getAttribute("aria-pressed")).toBe("true")
    );
  });
});


// ===========================================================================
// Phase 9.7 — InvestigationTimeline extended coverage
// Targets: unknown case (caseId not recognised by provenance API), challenge
// state integration, investigation state rendering, empty-evidence scenarios,
// no probability language invariant.
// ===========================================================================

describe("InvestigationTimeline — Phase 9.7: unknown case / provenance 404", () => {

  beforeEach(() => {
    fetchEvidenceProvenance.mockReset();
  });

  // TL-P97-1 — Unknown case: provenance returns found:false (404 body)
  it("TL-P97-1: found:false provenance response shows not-found message without crashing", async () => {
    fetchEvidenceProvenance.mockResolvedValueOnce({
      found:       false,
      evidence_id: "E-G15-0101",
    });
    renderTimeline();
    fireEvent.click(screen.getByTestId("timeline-row-E-G15-0101"));
    await waitFor(() => expect(screen.getByTestId("timeline-provenance-panel")).toBeTruthy());
    expect(screen.getByTestId("tl-prov-not-found")).toBeTruthy();
    // Must not crash or render partial data
    expect(screen.queryByTestId("tl-prov-evidence-id")).toBeNull();
  });

  // TL-P97-2 — Unknown case: API returns network error for provenance
  it("TL-P97-2: network error on provenance fetch shows safe error — timeline intact", async () => {
    fetchEvidenceProvenance.mockRejectedValueOnce(new Error("Case not found: unknown-case"));
    renderTimeline();
    fireEvent.click(screen.getByTestId("timeline-row-E-G15-0101"));
    await waitFor(() => expect(screen.getByTestId("timeline-provenance-panel")).toBeTruthy());
    expect(screen.getByTestId("tl-prov-error")).toBeTruthy();
    // Timeline must remain functional
    expect(screen.getByTestId("investigation-timeline")).toBeTruthy();
    expect(screen.getByTestId("temporal-window-banner")).toBeTruthy();
  });

  // TL-P97-3 — caseId prop is undefined (unknown case) — component renders without crashing
  it("TL-P97-3: undefined caseId does not crash the component", () => {
    render(
      <InvestigationTimeline
        timelineData={TIMELINE_FIXTURE}
        anchorTimestamp={ANCHOR_TIMESTAMP}
        reportHypotheses={REPORT_HYPOTHESES}
        caseId={undefined}
      />
    );
    expect(screen.getByTestId("investigation-timeline")).toBeTruthy();
  });
});

describe("InvestigationTimeline — Phase 9.7: scientific invariants", () => {

  beforeEach(() => {
    fetchEvidenceProvenance.mockResolvedValue({
      found:       false,
      evidence_id: "E-G15-0101",
    });
  });

  // TL-P97-4 — No causal language in loaded state with full timeline
  it("TL-P97-4: full timeline renders with no causal or probabilistic language", () => {
    const { container } = renderTimeline();
    const text = container.textContent;
    expect(text).not.toMatch(/\bcauses?\b/i);
    expect(text).not.toMatch(/\bconfirm[s]?\b/i);
    expect(text).not.toMatch(/\d+(\.\d+)?%/);
    expect(text.toLowerCase()).not.toContain("probability");
    expect(text.toLowerCase()).not.toContain("likelihood");
  });

  // TL-P97-5 — Temporal window disclaimer is mandated text (scientific integrity)
  it("TL-P97-5: temporal window banner carries the mandatory heuristic disclaimer", () => {
    renderTimeline();
    const banner = screen.getByTestId("temporal-window-banner");
    expect(banner.textContent).toContain("heuristic");
    expect(banner.textContent).not.toContain("calibrated causal threshold confirmed");
    // Must explicitly say "not a scientifically calibrated causal threshold"
    expect(banner.textContent).toContain(
      "not a scientifically calibrated causal threshold"
    );
  });

  // TL-P97-6 — EPHEMERIS badge text explicitly says "not hypothesis evidence"
  it("TL-P97-6: EPHEMERIS positional-data badge explicitly says it is not hypothesis evidence", () => {
    renderTimeline();
    const badge = screen.getByTestId("ephemeris-badge-E-G15-0102");
    expect(badge.textContent).toContain("not hypothesis evidence");
    expect(badge.textContent.toLowerCase()).not.toContain("supporting");
    expect(badge.textContent.toLowerCase()).not.toContain("confirms");
  });
});

describe("InvestigationTimeline — Phase 9.7: investigation state + reportHypotheses", () => {

  beforeEach(() => {
    fetchEvidenceProvenance.mockResolvedValue({
      found:            true,
      evidence_id:      "E-G15-0101",
      timestamp:        "2010-04-05T09:53:00Z",
      source:           "GOES11_EP8",
      measurement:      "e_flux",
      value:            2100.5,
      unit:             "particles/cm2/s/sr",
      resolution:       "5min",
      dataset_id:       "GOES11_K0_EP8",
      provider:         "NASA CDAWeb",
      variable:         "E_1MEV_IC",
      evidence_type:    "environmental_observation",
      quality:          null,
      hypothesis_relationships: [
        { hypothesis_id: "H1", list_name: "environmental_context",  relationship: "ep8_context", interpretation: "Contextualises conditions." },
        { hypothesis_id: "H2", list_name: "supporting_evidence",    relationship: "sep_support",  interpretation: "Supports SEU scenario." },
      ],
    });
  });

  // TL-P97-7 — Provenance panel shows relationship list_name as human-readable label
  it("TL-P97-7: provenance relationship list_name renders human-readable label", async () => {
    renderTimeline();
    fireEvent.click(screen.getByTestId("timeline-row-E-G15-0101"));
    await waitFor(() => expect(screen.getByTestId("timeline-provenance-panel")).toBeTruthy());
    // environmental_context → "Environmental context"
    expect(screen.getByTestId("tl-prov-relationship-H1")).toBeTruthy();
    expect(screen.getByTestId("tl-prov-relationship-H1").textContent).toContain(
      "Environmental context"
    );
    // supporting_evidence → "Supporting evidence"
    expect(screen.getByTestId("tl-prov-relationship-H2")).toBeTruthy();
    expect(screen.getByTestId("tl-prov-relationship-H2").textContent).toContain(
      "Supporting evidence"
    );
  });

  // TL-P97-8 — Environmental context relationship does not say "Supporting" alone
  it("TL-P97-8: environmental_context list_name does not render as bare 'Supporting evidence'", async () => {
    renderTimeline();
    fireEvent.click(screen.getByTestId("timeline-row-E-G15-0101"));
    await waitFor(() => expect(screen.getByTestId("timeline-provenance-panel")).toBeTruthy());
    const h1Rel = screen.getByTestId("tl-prov-relationship-H1");
    // Must contain "Environmental context" — not the string "Supporting evidence"
    expect(h1Rel.textContent).toContain("Environmental context");
    expect(h1Rel.textContent).not.toContain("Supporting evidence");
  });

  // TL-P97-9 — reportHypotheses null is safe (no crash when hypothesis lookup fails)
  it("TL-P97-9: null reportHypotheses does not crash the provenance panel", async () => {
    render(
      <InvestigationTimeline
        timelineData={TIMELINE_FIXTURE}
        anchorTimestamp={ANCHOR_TIMESTAMP}
        reportHypotheses={null}
        caseId="galaxy-15"
      />
    );
    fireEvent.click(screen.getByTestId("timeline-row-E-G15-0101"));
    await waitFor(() => expect(screen.getByTestId("timeline-provenance-panel")).toBeTruthy());
    // Panel rendered without crash
    expect(screen.getByTestId("tl-prov-evidence-id").textContent).toBe("E-G15-0101");
  });
});
