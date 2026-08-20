import { describe, it, expect } from "vitest";
import {
  ASSESSMENT_LABELS,
  ASSESSMENT_COLORS,
  getAssessmentLabel,
  getAssessmentColor,
} from "./assessmentLabels.js";

const ALL_KEYS = [
  "strongly_supported",
  "supported",
  "mixed",
  "weakly_supported",
  "insufficient_evidence",
];

describe("ASSESSMENT_LABELS", () => {
  it("maps all 5 canonical keys to non-empty strings", () => {
    for (const key of ALL_KEYS) {
      expect(typeof ASSESSMENT_LABELS[key]).toBe("string");
      expect(ASSESSMENT_LABELS[key].length).toBeGreaterThan(0);
    }
  });

  it("does not contain the word 'probability' or 'confidence'", () => {
    for (const label of Object.values(ASSESSMENT_LABELS)) {
      expect(label.toLowerCase()).not.toContain("probability");
      expect(label.toLowerCase()).not.toContain("confidence");
    }
  });

  it("does not contain forbidden causal language", () => {
    const forbidden = ["proven", "confirmed cause", "99%", "definitely caused"];
    for (const label of Object.values(ASSESSMENT_LABELS)) {
      for (const f of forbidden) {
        expect(label.toLowerCase()).not.toContain(f);
      }
    }
  });
});

describe("ASSESSMENT_COLORS", () => {
  it("maps all 5 canonical keys to non-empty Tailwind class strings", () => {
    for (const key of ALL_KEYS) {
      expect(typeof ASSESSMENT_COLORS[key]).toBe("string");
      expect(ASSESSMENT_COLORS[key].length).toBeGreaterThan(0);
    }
  });
});

describe("getAssessmentLabel", () => {
  it("returns the correct label for each known key", () => {
    expect(getAssessmentLabel("supported")).toBe("Supported");
    expect(getAssessmentLabel("weakly_supported")).toBe("Weakly supported");
    expect(getAssessmentLabel("insufficient_evidence")).toBe("Insufficient evidence");
    expect(getAssessmentLabel("mixed")).toBe("Mixed");
    expect(getAssessmentLabel("strongly_supported")).toBe("Strongly supported");
  });

  it("returns the raw key (not undefined) for an unknown value", () => {
    const result = getAssessmentLabel("some_unknown_key");
    expect(result).not.toBeUndefined();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns a non-empty string for null/undefined input", () => {
    const result = getAssessmentLabel(undefined);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("getAssessmentColor", () => {
  it("returns a non-empty string for each known key", () => {
    for (const key of ALL_KEYS) {
      const result = getAssessmentColor(key);
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it("returns a fallback string (not undefined) for unknown keys", () => {
    const result = getAssessmentColor("nonsense_key");
    expect(result).not.toBeUndefined();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});
