import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import LimitationsPanel from "./LimitationsPanel";

const LIMITATIONS = [
  { type: "proxy_measurement", description: "Kp index is a planetary proxy." },
  { type: "missing_data",      description: "No direct SEP fluence measurement." },
  { type: "unresolved",        description: "Root cause of voltage transient unknown." },
];

describe("LimitationsPanel", () => {
  it("renders empty state when no limitations", () => {
    render(<LimitationsPanel />);
    expect(screen.getByTestId("limitations-empty")).toBeTruthy();
    expect(screen.queryByTestId("limitations-list")).toBeNull();
  });

  it("renders empty state when limitations array is empty", () => {
    render(<LimitationsPanel limitations={[]} />);
    expect(screen.getByTestId("limitations-empty")).toBeTruthy();
  });

  it("renders the panel with limitations", () => {
    render(<LimitationsPanel limitations={LIMITATIONS} />);
    expect(screen.getByTestId("limitations-panel")).toBeTruthy();
    expect(screen.getByTestId("limitations-list")).toBeTruthy();
  });

  it("renders correct count of limitation items", () => {
    render(<LimitationsPanel limitations={LIMITATIONS} />);
    expect(screen.getByTestId("limitation-item-0")).toBeTruthy();
    expect(screen.getByTestId("limitation-item-1")).toBeTruthy();
    expect(screen.getByTestId("limitation-item-2")).toBeTruthy();
  });

  it("renders limitation descriptions", () => {
    render(<LimitationsPanel limitations={LIMITATIONS} />);
    expect(screen.getByTestId("limitation-description-0").textContent).toBe(
      "Kp index is a planetary proxy."
    );
    expect(screen.getByTestId("limitation-description-1").textContent).toBe(
      "No direct SEP fluence measurement."
    );
  });

  it("renders type badges", () => {
    render(<LimitationsPanel limitations={LIMITATIONS} />);
    expect(screen.getByTestId("limitation-type-0").textContent).toMatch(/proxy measurement/i);
    expect(screen.getByTestId("limitation-type-1").textContent).toMatch(/missing data/i);
    expect(screen.getByTestId("limitation-type-2").textContent).toMatch(/unresolved/i);
  });

  it("shows correct count in header", () => {
    render(<LimitationsPanel limitations={LIMITATIONS} />);
    const header = screen.getByTestId("limitations-panel");
    expect(header.textContent).toContain("3");
  });

  it("shows singular 'limitation' for count of 1", () => {
    render(<LimitationsPanel limitations={[LIMITATIONS[0]]} />);
    // The header should contain "1 limitation" not "limitations"
    const panel = screen.getByTestId("limitations-panel");
    expect(panel.textContent).toContain("1 limitation");
  });

  it("handles unknown limitation type gracefully", () => {
    const custom = [{ type: "custom_type", description: "Custom limitation." }];
    render(<LimitationsPanel limitations={custom} />);
    expect(screen.getByTestId("limitation-type-0").textContent).toBe("custom_type");
  });
});
