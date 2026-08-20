/**
 * Shared assessment vocabulary — used by HypothesisMatrix, ReportModal, and RedTeamPanel.
 * Values are display strings only; the canonical identifiers are the keys.
 */

export const ASSESSMENT_LABELS = {
  strongly_supported:    "Strongly supported",
  supported:             "Supported",
  mixed:                 "Mixed",
  weakly_supported:      "Weakly supported",
  insufficient_evidence: "Insufficient evidence",
};

/**
 * Tailwind class pairs: [badgeBg+text classes, border class]
 * Returns a stable set of classes even for unknown assessment values.
 */
export const ASSESSMENT_COLORS = {
  strongly_supported:    "bg-green-900/60 text-green-300 border-green-700",
  supported:             "bg-cyan-900/60 text-cyan-300 border-cyan-700",
  mixed:                 "bg-amber-900/60 text-amber-300 border-amber-700",
  weakly_supported:      "bg-orange-900/60 text-orange-300 border-orange-700",
  insufficient_evidence: "bg-slate-700 text-slate-400 border-slate-500",
};

/** Returns display label; falls back to the raw key if unknown. */
export function getAssessmentLabel(key) {
  return ASSESSMENT_LABELS[key] ?? key ?? "Unknown";
}

/** Returns Tailwind badge class string; falls back to a neutral style. */
export function getAssessmentColor(key) {
  return ASSESSMENT_COLORS[key] ?? "bg-slate-700 text-slate-400 border-slate-500";
}
