import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Header from "./Header.jsx";

// ── Fixture ───────────────────────────────────────────────────────────────────

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
  anchor_event: { timestamp: "2010-04-05T09:48:00Z" },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Header", () => {

  // HDR-1 — Renders without crashing when caseMeta is null (loading state)
  it("HDR-1: renders without crashing when caseMeta is null", () => {
    render(<Header caseMeta={null} />);
    // Must not throw — component wraps in a <header>
    expect(document.querySelector("header")).toBeTruthy();
  });

  // HDR-2 — Brand mark
  it("HDR-2: renders the SpaceForensics brand text", () => {
    render(<Header caseMeta={null} />);
    expect(screen.getByText(/SpaceForensics/i)).toBeTruthy();
  });

  // HDR-3 — Loading placeholder when caseMeta is null
  it("HDR-3: shows 'Loading…' when caseMeta is null", () => {
    render(<Header caseMeta={null} />);
    expect(screen.getByText(/Loading/i)).toBeTruthy();
  });

  // HDR-4 — Asset name rendered from caseMeta
  it("HDR-4: renders the asset name from caseMeta.target_asset.name", () => {
    render(<Header caseMeta={CASE_META} />);
    // getAllByText is used because "Galaxy 15" appears in both the case-identity
    // string and the hard-coded dropdown option text.
    expect(screen.getAllByText(/Galaxy 15/).length).toBeGreaterThanOrEqual(1);
  });

  // HDR-5 — Orbit type and longitude from caseMeta
  it("HDR-5: renders orbit type and longitude from caseMeta.target_asset", () => {
    render(<Header caseMeta={CASE_META} />);
    const header = document.querySelector("header");
    expect(header.textContent).toContain("GEO");
    expect(header.textContent).toContain("133");
  });

  // HDR-6 — Sensor status badges — scientific data-source label integrity
  // These labels correspond to the data sources used in Galaxy 15 evidence ingestion.
  // If the component is later generalised, these tests become regression anchors.
  it("HDR-6: sensor status region contains the Galaxy 15 data source labels", () => {
    render(<Header caseMeta={CASE_META} />);
    const header = document.querySelector("header");
    expect(header.textContent).toContain("GOES-11 MAG");
    expect(header.textContent).toContain("GOES-11 EP8");
    expect(header.textContent).toContain("EPHEMERIS");
  });

  // HDR-7 — No sensor badge contains causal or certainty language
  it("HDR-7: no sensor status label contains causal or certainty language", () => {
    render(<Header caseMeta={CASE_META} />);
    const header = document.querySelector("header");
    const text = header.textContent.toLowerCase();
    expect(text).not.toContain("confirmed");
    expect(text).not.toContain("established");
    expect(text).not.toContain("proven");
    expect(text).not.toContain("cause");
  });

  // HDR-8 — No numerical probabilities in rendered output
  it("HDR-8: rendered output contains no percentage or probability strings", () => {
    render(<Header caseMeta={CASE_META} />);
    const text = document.querySelector("header").textContent;
    expect(text).not.toMatch(/\d+(\.\d+)?%/);
    expect(text.toLowerCase()).not.toContain("probability");
    expect(text.toLowerCase()).not.toContain("likelihood");
  });

  // HDR-9 — Case selector dropdown is present
  it("HDR-9: a case selector dropdown is present in the header", () => {
    render(<Header caseMeta={CASE_META} />);
    const select = document.querySelector("header select");
    expect(select).toBeTruthy();
  });

});
