import { X, Printer } from "lucide-react";
import { getAssessmentLabel } from "../utils/assessmentLabels";

const UNCERTAINTY_LABELS = {
  observed: "OBSERVED",
  inferred: "INFERRED",
  unknown:  "UNKNOWN",
};

const UNCERTAINTY_COLORS = {
  observed: "text-green-400",
  inferred: "text-amber-400",
  unknown:  "text-slate-500",
};

const RELATIONSHIP_LABELS = {
  supports:           "Supports",
  contradicts:        "Contradicts",
  non_discriminating: "Non-discriminating",
};

const SEVERITY_COLORS = {
  high:   "text-red-400",
  medium: "text-amber-400",
  low:    "text-slate-500",
};

export default function ReportModal({ isOpen, onClose, caseMeta, hypotheses, challengeData }) {
  if (!isOpen) return null;

  const now         = new Date().toISOString();
  const asset       = caseMeta?.target_asset  ?? {};
  const dataWindow  = caseMeta?.data_window   ?? {};
  const sources     = caseMeta?.data_sources  ?? [];
  const limitations = caseMeta?.scientific_limitations ?? [];
  const challenges  = challengeData?.challenges ?? [];
  const sortedHypotheses = hypotheses
    ? [...hypotheses].sort((a, b) => b.confidence - a.confidence)
    : [];

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-start justify-center overflow-y-auto py-8 px-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-3xl shadow-2xl">

        {/* Modal toolbar */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
          <h2 className="font-mono text-sm font-bold text-slate-100 uppercase tracking-widest">
            Forensic Summary Report
          </h2>
          <div className="flex items-center gap-3">
            <button
              onClick={() => globalThis.print?.()}
              className="flex items-center gap-1.5 text-xs font-mono text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-600 px-3 py-1.5 rounded transition-colors"
            >
              <Printer className="w-3.5 h-3.5" />
              Print / Save PDF
            </button>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-white transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Report body */}
        <div className="px-6 py-6 flex flex-col gap-8 text-sm">

          {/* Section 1 — Case Header */}
          <section>
            <SectionHeading>Case Header</SectionHeading>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 font-mono text-xs mt-3">
              <Row label="Case ID"     value={caseMeta?.case_id} />
              <Row label="Title"       value={caseMeta?.title} />
              <Row label="Target"      value={asset.name} />
              <Row label="Alias"       value={asset.alias} />
              <Row label="NORAD ID"    value={asset.norad_id} />
              <Row label="Orbit"       value={`${asset.orbit_type} ${asset.longitude_deg_west}° W`} />
              <Row label="Operator"    value={asset.operator} />
              <Row label="Bus"         value={asset.spacecraft_bus} />
              <Row label="Report time" value={now} />
            </dl>
            {caseMeta?.causal_attribution && (
              <p className="mt-2 font-mono text-xs text-amber-400/80">
                Causal attribution: {caseMeta.causal_attribution}
              </p>
            )}
          </section>

          {/* Section 2 — Data Window */}
          <section>
            <SectionHeading>Data Window</SectionHeading>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 font-mono text-xs mt-3">
              <Row label="Start"     value={dataWindow.start} />
              <Row label="End"       value={dataWindow.end} />
              <Row label="Duration"  value={dataWindow.duration_minutes ? `${dataWindow.duration_minutes} min` : undefined} />
            </dl>
            {sources.length > 0 && (
              <div className="mt-2">
                <p className="font-mono text-xs text-slate-400 uppercase tracking-wider mb-1">Data Sources</p>
                <ul className="list-disc list-inside font-mono text-xs text-slate-300 space-y-0.5">
                  {sources.map((s, i) => (
                    <li key={i}>{s.dataset_id ?? s.instrument ?? s.source_id} — {s.description ?? s.parameter}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* Section 3 — Pass 1 Hypotheses */}
          <section>
            <SectionHeading>Pass 1 — Competing Hypotheses</SectionHeading>
            {sortedHypotheses.length ? (
              <div className="mt-3 flex flex-col gap-5">
                {sortedHypotheses.map((h) => (
                  <div key={h.hypothesis_id ?? h.id} className="border border-slate-700 rounded-lg overflow-hidden">
                    {/* Hypothesis header */}
                    <div className="bg-slate-800 px-4 py-2.5 flex items-center justify-between gap-4">
                      <span className="font-mono text-xs font-semibold text-slate-200">{h.label}</span>
                      <span className="font-mono text-xs text-cyan-300 shrink-0">
                        {getAssessmentLabel(h.assessment)}
                      </span>
                    </div>

                    {/* Causal attribution */}
                    <div className="px-4 py-1.5 border-b border-slate-700/60">
                      <span className="font-mono text-[10px] text-slate-500">
                        Causal attribution: <span className="text-amber-500">Not established</span>
                      </span>
                    </div>

                    {/* Claims */}
                    {Array.isArray(h.claims) && h.claims.length > 0 && (
                      <div className="px-4 py-3 flex flex-col gap-2">
                        <p className="font-mono text-[10px] text-slate-500 uppercase tracking-wider">
                          Claims ({h.claims.length})
                        </p>
                        {h.claims.map((c) => {
                          const uColor = UNCERTAINTY_COLORS[c.uncertainty] ?? "text-slate-500";
                          const uLabel = UNCERTAINTY_LABELS[c.uncertainty] ?? (c.uncertainty ?? "UNKNOWN").toUpperCase();
                          const relLabel = RELATIONSHIP_LABELS[c.relationship] ?? c.relationship;
                          return (
                            <div key={c.claim_id} className="flex flex-col gap-0.5 py-1.5 border-b border-slate-800 last:border-0">
                              <div className="flex items-start gap-2">
                                <span className={`font-mono text-[9px] font-bold shrink-0 mt-0.5 ${uColor}`}>
                                  {uLabel}
                                </span>
                                <p className="text-slate-300 text-xs leading-relaxed">{c.statement}</p>
                              </div>
                              <div className="flex items-center gap-2 ml-0">
                                <span className="font-mono text-[9px] text-slate-600">{relLabel}</span>
                                {c.evidence_ids?.length > 0 && (
                                  <span className="font-mono text-[9px] text-slate-600">
                                    · {c.evidence_ids.join(", ")}
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Missing evidence */}
                    {Array.isArray(h.missing_evidence) && h.missing_evidence.length > 0 && (
                      <div className="px-4 pb-2.5 flex flex-col gap-0.5">
                        <p className="font-mono text-[10px] text-slate-500 uppercase tracking-wider mb-0.5">
                          Missing evidence
                        </p>
                        <ul className="list-disc list-inside font-mono text-xs text-amber-400/70 space-y-0.5">
                          {h.missing_evidence.map((m, i) => <li key={i}>{m}</li>)}
                        </ul>
                      </div>
                    )}

                    {/* Limitations */}
                    {Array.isArray(h.limitations) && h.limitations.length > 0 && (
                      <div className="px-4 pb-2.5 flex flex-col gap-0.5 border-t border-slate-800">
                        <p className="font-mono text-[10px] text-slate-500 uppercase tracking-wider mb-0.5 mt-2">
                          Data limitations
                        </p>
                        <ul className="list-disc list-inside font-mono text-xs text-slate-500 space-y-0.5">
                          {h.limitations.map((l, i) => <li key={i}>{l}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-slate-500 text-xs mt-2 font-mono italic">Investigation not yet run.</p>
            )}
          </section>

          {/* Section 4 — Red-Team Challenge */}
          <section>
            <SectionHeading>Pass 2 — Red-Team Challenge</SectionHeading>
            {challengeData ? (
              <>
                <p className="font-mono text-xs text-slate-400 mt-2 mb-3">
                  Challenged: <span className="text-amber-400">{challengeData.challenged_hypothesis_id?.replace(/_/g, " ")}</span>
                  {" "}· Source: <span className="text-cyan-400">{challengeData.source}</span>
                </p>

                {/* Updated assessments */}
                {challengeData.updated_hypotheses?.length > 0 && (
                  <table className="w-full mb-4 text-xs font-mono border-collapse">
                    <thead>
                      <tr className="text-slate-400 uppercase tracking-wider border-b border-slate-700">
                        <th className="text-left pb-2 pr-4">Hypothesis</th>
                        <th className="text-right pb-2 w-40">Updated Assessment</th>
                      </tr>
                    </thead>
                    <tbody>
                      {challengeData.updated_hypotheses.map((h) => (
                        <tr key={h.hypothesis_id ?? h.id} className="border-b border-slate-800">
                          <td className="py-2 pr-4 text-slate-200">{h.label}</td>
                          <td className="py-2 text-right text-cyan-300 font-semibold">
                            {getAssessmentLabel(h.assessment)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {/* Challenges — structured flow */}
                {challenges.length > 0 && (
                  <div className="flex flex-col gap-3">
                    <p className="font-mono text-[10px] text-slate-500 uppercase tracking-wider">
                      Challenges ({challenges.length})
                    </p>
                    {challenges.map((ch, i) => (
                      <div key={ch.claim_id ?? i} className="border border-slate-700 rounded-lg px-4 py-3 flex flex-col gap-1.5">
                        {/* Claim + severity */}
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className={`font-mono text-[9px] font-bold uppercase ${SEVERITY_COLORS[ch.severity] ?? "text-slate-500"}`}>
                            {ch.severity}
                          </span>
                          <span className="font-mono text-xs text-slate-400">· Claim {ch.claim_id}</span>
                        </div>

                        <ChallengeLine label="Challenge"         text={ch.challenge} />
                        {ch.counter_evidence_ids?.length > 0 && (
                          <ChallengeLine label="Counter-evidence" text={ch.counter_evidence_ids.join(", ")} />
                        )}
                        {ch.missing_evidence?.length > 0 && (
                          <ChallengeLine label="Missing evidence" text={ch.missing_evidence.join("; ")} />
                        )}
                        <ChallengeLine label="Revised assessment" text={ch.revised_assessment} />
                      </div>
                    ))}
                  </div>
                )}

                {/* Red team summary */}
                {challengeData.red_team_summary && (
                  <blockquote className="mt-4 border-l-2 border-amber-500 pl-4 text-xs text-slate-300 italic leading-relaxed">
                    {challengeData.red_team_summary}
                  </blockquote>
                )}
              </>
            ) : (
              <p className="text-slate-500 text-xs mt-2 font-mono italic">Red-team challenge not yet run.</p>
            )}
          </section>

          {/* Section 5 — Scientific Limitations */}
          {limitations.length > 0 && (
            <section>
              <SectionHeading>Scientific Limitations</SectionHeading>
              <ul className="mt-3 space-y-1.5 list-disc list-inside font-mono text-xs text-slate-400 leading-relaxed">
                {limitations.map((l, i) => <li key={i}>{l}</li>)}
              </ul>
            </section>
          )}

        </div>
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function SectionHeading({ children }) {
  return (
    <h3 className="font-mono text-xs font-bold text-cyan-400 uppercase tracking-widest border-b border-slate-700 pb-1">
      {children}
    </h3>
  );
}

function Row({ label, value }) {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-slate-200">{value ?? "—"}</dd>
    </>
  );
}

function ChallengeLine({ label, text }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="font-mono text-[9px] text-slate-600 uppercase tracking-wider shrink-0 mt-0.5 w-28">
        {label}
      </span>
      <span className="text-slate-300 leading-relaxed">{text}</span>
    </div>
  );
}
