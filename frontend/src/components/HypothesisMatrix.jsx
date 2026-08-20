import { useState, useMemo } from "react";
import { ChevronDown, ChevronUp, AlertTriangle, Info } from "lucide-react";
import { getAssessmentLabel, getAssessmentColor } from "../utils/assessmentLabels";

// ── Constants ──────────────────────────────────────────────────────────────────

const HYPOTHESIS_ICONS = {
  surface_charging_esd: "⚡",
  single_event_upset:   "☢️",
  hardware_failure:     "🔩",
};

const UNCERTAINTY_STYLES = {
  observed: "bg-green-900/70 text-green-300 border border-green-700",
  inferred: "bg-amber-900/70 text-amber-300 border border-amber-700",
  unknown:  "bg-slate-700 text-slate-400 border border-slate-500",
};

const RELATIONSHIP_STYLES = {
  supports:            "bg-cyan-900/60 text-cyan-300 border border-cyan-700",
  contradicts:         "bg-red-900/60 text-red-300 border border-red-700",
  non_discriminating:  "bg-slate-700 text-slate-400 border border-slate-500",
};

const RELATIONSHIP_LABELS = {
  supports:           "Supports",
  contradicts:        "Contradicts",
  non_discriminating: "Non-discriminating",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function countByRelationship(claims = []) {
  return {
    supporting:      claims.filter((c) => c.relationship === "supports").length,
    contradicting:   claims.filter((c) => c.relationship === "contradicts").length,
    nonDiscriminating: claims.filter((c) => c.relationship === "non_discriminating").length,
  };
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function EvidenceRecord({ evidenceById, evidenceId }) {
  const rec = evidenceById?.[evidenceId];
  if (!rec) {
    return (
      <span className="font-mono text-xs text-slate-500 italic">
        {evidenceId} — record not found in timeline
      </span>
    );
  }
  return (
    <div className="font-mono text-xs text-slate-400 leading-snug">
      <span className="text-slate-500">{rec.evidence_id}</span>
      {" · "}
      <span className="text-slate-500">{rec.timestamp}</span>
      {" · "}
      <span className="text-slate-300">{rec.source}</span>
      {" · "}
      <span className="text-slate-300">
        {rec.measurement}: {rec.value} {rec.unit}
      </span>
      {rec.resolution && (
        <span className="text-slate-500"> ({rec.resolution})</span>
      )}
    </div>
  );
}

function ClaimRow({ claim, evidenceById }) {
  const uncertaintyStyle = UNCERTAINTY_STYLES[claim.uncertainty] ?? UNCERTAINTY_STYLES.unknown;
  const relationshipStyle = RELATIONSHIP_STYLES[claim.relationship] ?? "bg-slate-700 text-slate-400 border border-slate-500";
  const uncertaintyLabel = (claim.uncertainty ?? "unknown").toUpperCase();
  const hasEvidence = Array.isArray(claim.evidence_ids) && claim.evidence_ids.length > 0;

  return (
    <div className="flex flex-col gap-1.5 py-2.5 border-b border-slate-700/60 last:border-0">
      {/* Uncertainty pill + statement */}
      <div className="flex items-start gap-2">
        <span className={`shrink-0 mt-0.5 text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${uncertaintyStyle}`}>
          {uncertaintyLabel}
        </span>
        <p className="text-slate-200 text-xs leading-relaxed flex-1">{claim.statement}</p>
      </div>

      {/* Evidence records */}
      <div className="ml-0 flex flex-col gap-1 pl-0">
        {hasEvidence ? (
          claim.evidence_ids.map((eid) => (
            <EvidenceRecord key={eid} evidenceById={evidenceById} evidenceId={eid} />
          ))
        ) : (
          <span className="font-mono text-xs text-slate-600 italic">
            No direct measurement — {claim.uncertainty === "unknown" ? "data not available" : "inferred from proxy data"}
          </span>
        )}
      </div>

      {/* Reasoning */}
      {claim.reasoning && (
        <p className="text-slate-500 text-xs italic leading-relaxed">
          {claim.reasoning}
        </p>
      )}

      {/* Relationship chip */}
      <div className="flex items-center gap-1.5">
        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${relationshipStyle}`}>
          {RELATIONSHIP_LABELS[claim.relationship] ?? claim.relationship}
        </span>
      </div>
    </div>
  );
}

function HypothesisCard({ h, idx, evidenceById, defaultExpanded }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const counts = countByRelationship(h.claims);
  const assessmentClass = getAssessmentColor(h.assessment);
  const assessmentLabel = getAssessmentLabel(h.assessment);
  const hasClaims = Array.isArray(h.claims) && h.claims.length > 0;
  const hasMissing = Array.isArray(h.missing_evidence) && h.missing_evidence.length > 0;
  const hasLimitations = Array.isArray(h.limitations) && h.limitations.length > 0;

  return (
    <div className="bg-slate-800 rounded-lg border border-slate-700 flex flex-col">
      {/* Card header */}
      <div className="p-4 flex flex-col gap-2">
        {/* Title row */}
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs text-slate-300 font-semibold flex items-center gap-1.5">
            <span>{HYPOTHESIS_ICONS[h.hypothesis_id] ?? HYPOTHESIS_ICONS[h.id] ?? "🔍"}</span>
            {h.label}
          </span>
          {idx === 0 && (
            <span className="text-[10px] font-mono bg-cyan-900 text-cyan-300 border border-cyan-700 px-1.5 py-0.5 rounded uppercase tracking-wider shrink-0">
              LEAD
            </span>
          )}
        </div>

        {/* Assessment badge */}
        <div>
          <span className={`inline-block text-[11px] font-mono font-semibold px-2 py-0.5 rounded border ${assessmentClass}`}>
            {assessmentLabel}
          </span>
        </div>

        {/* Evidence count chips */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cyan-900/40 text-cyan-400 border border-cyan-800">
            {counts.supporting} supporting
          </span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-red-900/40 text-red-400 border border-red-800">
            {counts.contradicting} contradicting
          </span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-700 text-slate-400 border border-slate-600">
            {counts.nonDiscriminating} non-discrim.
          </span>
        </div>

        {/* Causal attribution status */}
        <p className="text-[10px] font-mono text-slate-500">
          Causal attribution: <span className="text-amber-500">Not established</span>
        </p>
      </div>

      {/* Expand toggle */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center justify-between w-full px-4 py-2 text-xs font-mono text-slate-400 hover:text-slate-200 border-t border-slate-700 transition-colors"
      >
        <span>{expanded ? "Hide evidence" : "Show evidence"}</span>
        {expanded
          ? <ChevronUp className="w-3.5 h-3.5" />
          : <ChevronDown className="w-3.5 h-3.5" />
        }
      </button>

      {/* Expanded evidence panel */}
      {expanded && (
        <div className="px-4 pb-4 flex flex-col gap-3 border-t border-slate-700">
          {/* Claims */}
          <div className="mt-2">
            <p className="font-mono text-[10px] text-slate-500 uppercase tracking-wider mb-1">
              Claims ({h.claims?.length ?? 0})
            </p>
            {hasClaims ? (
              <div className="flex flex-col">
                {h.claims.map((c) => (
                  <ClaimRow key={c.claim_id} claim={c} evidenceById={evidenceById} />
                ))}
              </div>
            ) : (
              <p className="text-slate-600 text-xs italic font-mono">
                No claim-level evidence available.
              </p>
            )}
          </div>

          {/* Missing evidence */}
          {hasMissing && (
            <div>
              <p className="font-mono text-[10px] text-slate-500 uppercase tracking-wider mb-1">
                Missing evidence
              </p>
              <ul className="flex flex-col gap-1">
                {h.missing_evidence.map((m, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-xs text-amber-400/80">
                    <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                    <span>{m}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Limitations */}
          {hasLimitations && (
            <div>
              <p className="font-mono text-[10px] text-slate-500 uppercase tracking-wider mb-1">
                Data limitations
              </p>
              <ul className="flex flex-col gap-1">
                {h.limitations.map((l, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-xs text-slate-500">
                    <Info className="w-3 h-3 shrink-0 mt-0.5" />
                    <span>{l}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main export ────────────────────────────────────────────────────────────────

export default function HypothesisMatrix({ hypotheses, timelineData }) {
  // Build an O(1) lookup from evidence_id → full record
  const evidenceById = useMemo(() => {
    if (!timelineData?.length) return {};
    return Object.fromEntries(timelineData.map((r) => [r.evidence_id, r]));
  }, [timelineData]);

  if (!hypotheses?.length) {
    return (
      <div className="bg-slate-900 rounded-xl p-6 border border-slate-700 flex items-center justify-center min-h-[160px]">
        <p className="text-slate-500 font-mono text-sm text-center">
          Click <span className="text-cyan-400 font-semibold">Investigate</span> to run Pass 1 hypothesis analysis
        </p>
      </div>
    );
  }

  const sorted = [...hypotheses].sort((a, b) => b.confidence - a.confidence);

  return (
    <div className="bg-slate-900 rounded-xl p-4 border border-slate-700">
      <h2 className="font-mono text-sm font-semibold text-slate-200 uppercase tracking-wider mb-4">
        Hypothesis Matrix
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {sorted.map((h, idx) => (
          <HypothesisCard
            key={h.hypothesis_id ?? h.id}
            h={h}
            idx={idx}
            evidenceById={evidenceById}
            defaultExpanded={idx === 0}
          />
        ))}
      </div>
    </div>
  );
}
