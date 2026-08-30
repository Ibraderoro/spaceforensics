import { ShieldAlert, ShieldCheck, BarChart2 } from "lucide-react";
import { getAssessmentLabel, getAssessmentColor } from "../utils/assessmentLabels";

/**
 * ForensicConclusionPanel
 *
 * Displays the deterministic forensic conclusion:
 *   - Causal attribution banner (NOT ESTABLISHED / ESTABLISHED)
 *   - Aggregate evidence counts
 *   - Hypothesis comparison summary (most supported, lists)
 *
 * Scientific rules enforced:
 *   - "NOT ESTABLISHED" is always shown when causal_attribution_established is false.
 *   - No "Cause:" label is ever rendered.
 *   - No numerical probabilities.
 *   - Assessments use only the canonical vocabulary from assessmentLabels.js.
 */
export default function ForensicConclusionPanel({ forensicConclusion }) {
  if (!forensicConclusion) {
    return (
      <div
        data-testid="forensic-conclusion-empty"
        className="bg-slate-900 rounded-xl border border-slate-700 p-4"
      >
        <p className="font-mono text-xs text-slate-500 italic">
          Forensic conclusion not available.
        </p>
      </div>
    );
  }

  const {
    causal_attribution_established,
    causal_attribution_statement,
    analysis_version,
    evidence_summary,
    comparison,
  } = forensicConclusion;

  const established = causal_attribution_established === true;

  return (
    <div
      data-testid="forensic-conclusion-panel"
      className="bg-slate-900 rounded-xl border border-slate-700 flex flex-col overflow-hidden"
    >
      {/* ── Causal attribution banner ───────────────────────────────────────── */}
      <div
        data-testid="causal-attribution-banner"
        className={`flex items-center gap-3 px-5 py-3 border-b ${
          established
            ? "bg-green-950/40 border-green-800"
            : "bg-red-950/30 border-red-900/60"
        }`}
      >
        {established ? (
          <ShieldCheck className="w-4 h-4 text-green-400 shrink-0" />
        ) : (
          <ShieldAlert className="w-4 h-4 text-red-400 shrink-0" />
        )}
        <div className="flex flex-col gap-0.5">
          <span
            data-testid="causal-attribution-label"
            className={`font-mono text-xs font-bold uppercase tracking-widest ${
              established ? "text-green-300" : "text-red-300"
            }`}
          >
            {established ? "Causal Attribution: ESTABLISHED" : "Causal Attribution: NOT ESTABLISHED"}
          </span>
          {causal_attribution_statement && (
            <span
              data-testid="causal-attribution-statement"
              className="font-mono text-[10px] text-slate-400 leading-relaxed"
            >
              {causal_attribution_statement}
            </span>
          )}
        </div>
      </div>

      <div className="p-4 flex flex-col gap-4">
        {/* ── Analysis version ───────────────────────────────────────────────── */}
        {analysis_version && (
          <p className="font-mono text-[10px] text-slate-600">
            Analysis version: {analysis_version}
          </p>
        )}

        {/* ── Aggregate evidence summary ──────────────────────────────────────── */}
        {evidence_summary && (
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <BarChart2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span className="font-mono text-[10px] text-slate-400 uppercase tracking-wider">
                Evidence Summary
              </span>
            </div>
            <dl
              data-testid="evidence-summary"
              className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-xs"
            >
              <dt className="text-slate-500">Environmental context</dt>
              <dd
                data-testid="count-environmental-context"
                className="text-amber-300 font-semibold"
              >
                {evidence_summary.total_environmental_context ?? "—"}
              </dd>
              <dt className="text-slate-500">Supporting evidence</dt>
              <dd
                data-testid="count-supporting-evidence"
                className="text-cyan-300 font-semibold"
              >
                {evidence_summary.total_supporting_evidence ?? "—"}
              </dd>
              <dt className="text-slate-500">Contradicting evidence</dt>
              <dd
                data-testid="count-contradicting-evidence"
                className="text-red-300 font-semibold"
              >
                {evidence_summary.total_contradicting_evidence ?? "—"}
              </dd>
              <dt className="text-slate-500">Non-discriminating</dt>
              <dd
                data-testid="count-non-discriminating"
                className="text-slate-400 font-semibold"
              >
                {evidence_summary.total_non_discriminating_evidence ?? "—"}
              </dd>
              <dt className="text-slate-500">Limitations</dt>
              <dd
                data-testid="count-limitations"
                className="text-orange-300 font-semibold"
              >
                {evidence_summary.total_limitations ?? "—"}
              </dd>
            </dl>
          </div>
        )}

        {/* ── Hypothesis comparison ───────────────────────────────────────────── */}
        {comparison && (
          <div data-testid="hypothesis-comparison">
            <p className="font-mono text-[10px] text-slate-400 uppercase tracking-wider mb-2">
              Hypothesis Assessment Summary
            </p>
            <dl className="flex flex-col gap-1.5 font-mono text-xs">
              {comparison.most_supported && (
                <div className="flex items-center gap-2">
                  <dt className="text-slate-500 shrink-0">Most supported</dt>
                  <dd>
                    <span
                      data-testid="most-supported-hypothesis"
                      className={`px-2 py-0.5 rounded border text-[10px] ${getAssessmentColor("supported")}`}
                    >
                      {comparison.most_supported}
                    </span>
                  </dd>
                </div>
              )}

              {(comparison.supported_hypotheses ?? []).length > 0 && (
                <div className="flex items-start gap-2">
                  <dt className="text-slate-500 shrink-0 mt-0.5">Supported</dt>
                  <dd className="flex flex-wrap gap-1">
                    {comparison.supported_hypotheses.map((id) => (
                      <span
                        key={id}
                        data-testid={`supported-badge-${id}`}
                        className={`px-1.5 py-0.5 rounded border text-[10px] ${getAssessmentColor("supported")}`}
                      >
                        {id}
                      </span>
                    ))}
                  </dd>
                </div>
              )}

              {(comparison.mixed_hypotheses ?? []).length > 0 && (
                <div className="flex items-start gap-2">
                  <dt className="text-slate-500 shrink-0 mt-0.5">Mixed</dt>
                  <dd className="flex flex-wrap gap-1">
                    {comparison.mixed_hypotheses.map((id) => (
                      <span
                        key={id}
                        data-testid={`mixed-badge-${id}`}
                        className={`px-1.5 py-0.5 rounded border text-[10px] ${getAssessmentColor("mixed")}`}
                      >
                        {id}
                      </span>
                    ))}
                  </dd>
                </div>
              )}

              {(comparison.insufficient_hypotheses ?? []).length > 0 && (
                <div className="flex items-start gap-2">
                  <dt className="text-slate-500 shrink-0 mt-0.5">Insufficient</dt>
                  <dd className="flex flex-wrap gap-1">
                    {comparison.insufficient_hypotheses.map((id) => (
                      <span
                        key={id}
                        data-testid={`insufficient-badge-${id}`}
                        className={`px-1.5 py-0.5 rounded border text-[10px] ${getAssessmentColor("insufficient_evidence")}`}
                      >
                        {id}
                      </span>
                    ))}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}
