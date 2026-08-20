import { useState, useMemo } from "react";
import { Flame, Loader2, ChevronDown, ChevronUp, AlertTriangle, Info } from "lucide-react";
import { postChallenge } from "../api";

// ── Constants ──────────────────────────────────────────────────────────────────

const SEVERITY_STYLES = {
  high:   "bg-red-900/60 text-red-300 border border-red-700",
  medium: "bg-amber-900/60 text-amber-300 border border-amber-700",
  low:    "bg-slate-700 text-slate-400 border border-slate-500",
};

// ── Sub-components ─────────────────────────────────────────────────────────────

function StepLabel({ label }) {
  return (
    <span className="text-[9px] font-mono font-bold tracking-widest text-slate-600 uppercase">
      {label}
    </span>
  );
}

function StepDivider() {
  return (
    <div className="flex items-center gap-1 my-0.5 pl-1">
      <span className="text-slate-600 text-xs">↓</span>
    </div>
  );
}

function CounterEvidenceTag({ evidenceId, evidenceById }) {
  const rec = evidenceById?.[evidenceId];
  return (
    <span className="inline-flex flex-wrap items-center gap-1 font-mono text-[10px]">
      <span className="bg-slate-700 text-slate-300 border border-slate-600 px-1.5 py-0.5 rounded">
        {evidenceId}
      </span>
      {rec && (
        <span className="text-slate-500">
          {rec.measurement}: {rec.value} {rec.unit}
        </span>
      )}
    </span>
  );
}

function ChallengeCard({ ch, evidenceById }) {
  const [open, setOpen] = useState(false);
  const severityClass = SEVERITY_STYLES[ch.severity] ?? SEVERITY_STYLES.low;
  const hasCounterEvidence = Array.isArray(ch.counter_evidence_ids) && ch.counter_evidence_ids.length > 0;
  const hasMissingEvidence = Array.isArray(ch.missing_evidence) && ch.missing_evidence.length > 0;

  return (
    <div className="bg-slate-800/70 rounded-lg border border-slate-700 overflow-hidden">
      {/* Collapsed header — claim_id + severity + toggle */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-slate-800 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${severityClass} shrink-0`}>
            {ch.severity?.toUpperCase() ?? "?"}
          </span>
          <span className="font-mono text-xs text-slate-300 truncate">
            Claim {ch.claim_id}
          </span>
        </div>
        {open
          ? <ChevronUp className="w-3.5 h-3.5 text-slate-500 shrink-0" />
          : <ChevronDown className="w-3.5 h-3.5 text-slate-500 shrink-0" />
        }
      </button>

      {open && (
        <div className="px-3 pb-3 flex flex-col gap-2 border-t border-slate-700">

          {/* CLAIM */}
          <div className="mt-2 flex flex-col gap-0.5">
            <StepLabel label="Claim" />
            <p className="text-slate-400 text-xs font-mono">{ch.claim_id}</p>
          </div>

          <StepDivider />

          {/* CHALLENGE */}
          <div className="flex flex-col gap-0.5">
            <StepLabel label="Challenge" />
            <p className="text-slate-200 text-xs leading-relaxed">{ch.challenge}</p>
          </div>

          <StepDivider />

          {/* COUNTER-EVIDENCE */}
          <div className="flex flex-col gap-1">
            <StepLabel label="Counter-evidence" />
            {hasCounterEvidence ? (
              <div className="flex flex-col gap-1">
                {ch.counter_evidence_ids.map((eid) => (
                  <CounterEvidenceTag key={eid} evidenceId={eid} evidenceById={evidenceById} />
                ))}
              </div>
            ) : (
              <span className="text-slate-600 text-xs italic font-mono">
                No counter-evidence IDs cited.
              </span>
            )}
          </div>

          <StepDivider />

          {/* MISSING EVIDENCE */}
          <div className="flex flex-col gap-1">
            <StepLabel label="Missing evidence" />
            {hasMissingEvidence ? (
              <ul className="flex flex-col gap-0.5">
                {ch.missing_evidence.map((m, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-xs text-amber-400/80">
                    <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                    <span>{m}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-slate-600 text-xs italic font-mono">None identified.</span>
            )}
          </div>

          <StepDivider />

          {/* REVISED ASSESSMENT */}
          <div className="flex flex-col gap-0.5">
            <StepLabel label="Revised assessment" />
            <p className="text-slate-300 text-xs leading-relaxed italic">
              {ch.revised_assessment}
            </p>
          </div>

        </div>
      )}
    </div>
  );
}

// ── Main export ────────────────────────────────────────────────────────────────

export default function RedTeamPanel({ onChallengeComplete, challengeData, timelineData, caseMeta }) {
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  const evidenceById = useMemo(() => {
    if (!timelineData?.length) return {};
    return Object.fromEntries(timelineData.map((r) => [r.evidence_id, r]));
  }, [timelineData]);

  const scientificLimitations = caseMeta?.scientific_limitations ?? [];

  async function handleChallenge() {
    setLoading(true);
    setError(null);
    try {
      const data = await postChallenge();
      onChallengeComplete(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const challenges = challengeData?.challenges ?? [];

  return (
    <div className="bg-slate-900 rounded-xl p-4 border border-slate-700 flex flex-col gap-5">
      <h2 className="font-mono text-sm font-semibold text-slate-200 uppercase tracking-wider">
        Red-Team Analysis
      </h2>

      {/* Challenge button */}
      <button
        onClick={handleChallenge}
        disabled={loading}
        className="flex items-center justify-center gap-2 w-full py-3 px-4 rounded-lg
                   bg-red-700 hover:bg-red-600 active:bg-red-800
                   disabled:opacity-60 disabled:cursor-not-allowed
                   transition-colors font-mono text-sm font-semibold text-white
                   border border-red-600 shadow-lg shadow-red-900/40"
      >
        {loading
          ? <Loader2 className="w-4 h-4 animate-spin" />
          : <Flame className="w-4 h-4" />
        }
        {loading ? "Running Red-Team Pass…" : "🔥 Challenge This Conclusion (Red-Team Pass)"}
      </button>

      {error && (
        <p className="text-red-400 text-xs font-mono bg-red-950/60 border border-red-800 rounded px-3 py-2">
          Error: {error}
        </p>
      )}

      {challengeData && (
        <>
          {/* Source badge + challenged hypothesis */}
          <div className="flex items-center gap-2">
            <span className={`text-xs font-mono px-2 py-0.5 rounded border ${
              challengeData.source === "llm"
                ? "bg-blue-900/60 text-blue-300 border-blue-700"
                : "bg-slate-700 text-slate-300 border-slate-500"
            }`}>
              {challengeData.source === "llm" ? "🤖 LLM" : "⚙️ Heuristic"}
            </span>
            <span className="text-xs text-slate-500 font-mono">
              Challenging: <span className="text-amber-400">
                {challengeData.challenged_hypothesis_id?.replace(/_/g, " ")}
              </span>
            </span>
          </div>

          {/* Challenge cards */}
          {challenges.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="font-mono text-[10px] text-slate-500 uppercase tracking-wider">
                Challenges ({challenges.length})
              </p>
              {challenges.map((ch, i) => (
                <ChallengeCard
                  key={ch.claim_id ?? i}
                  ch={ch}
                  evidenceById={evidenceById}
                />
              ))}
            </div>
          ) : (
            <p className="text-slate-600 text-xs italic font-mono">
              No challenges returned.
            </p>
          )}

          {/* Red-team summary */}
          {challengeData.red_team_summary && (
            <blockquote className="bg-slate-800/60 border-l-2 border-amber-500 rounded-r-lg px-4 py-3">
              <p className="text-slate-300 text-xs italic leading-relaxed">
                {challengeData.red_team_summary}
              </p>
            </blockquote>
          )}
        </>
      )}

      {/* Scientific limitations from case.json */}
      {scientificLimitations.length > 0 && (
        <div className="border-t border-slate-800 pt-4">
          <p className="font-mono text-[10px] text-slate-500 uppercase tracking-wider mb-2">
            Scientific Limitations
          </p>
          <ul className="flex flex-col gap-1.5">
            {scientificLimitations.map((l, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-slate-500">
                <Info className="w-3 h-3 shrink-0 mt-0.5 text-slate-600" />
                <span>{l}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
