import { useState } from "react";
import { ChevronDown, ChevronUp, AlertTriangle } from "lucide-react";
import { getAssessmentLabel, getAssessmentColor } from "../utils/assessmentLabels";

/**
 * HypothesisAssessmentPanel
 *
 * Displays per-hypothesis forensic assessments with full evidence breakdown.
 *
 * Scientific rules enforced:
 *   - Assessments are read-only; no edit controls.
 *   - Environmental context is visually distinct from supporting evidence
 *     with explicit "environmental context" label and amber colour.
 *   - "does not confirm a mechanism" disclaimer on env-context section.
 *   - No probability language anywhere.
 *   - Exact categorical labels from assessmentLabels.js.
 */

const ENV_CONTEXT_NOTE =
  "Environmental context records document preconditions contemporaneous with the anomaly. " +
  "They do not confirm a mechanism.";

function EvidenceIdChip({ id, testIdPrefix }) {
  return (
    <span
      data-testid={`${testIdPrefix}-${id}`}
      className="font-mono text-[9px] px-1.5 py-0.5 rounded bg-slate-700/60 text-slate-400 border border-slate-600 cursor-default"
    >
      {id}
    </span>
  );
}

function LimitationItem({ lim, index }) {
  return (
    <div
      data-testid={`hypothesis-limitation-${index}`}
      className="flex items-start gap-1.5 pl-2 border-l border-orange-900/60"
    >
      <AlertTriangle className="w-3 h-3 text-orange-500 shrink-0 mt-0.5" />
      <p className="font-mono text-[10px] text-slate-400 leading-relaxed">{lim.description}</p>
    </div>
  );
}

function HypothesisCard({ hypothesis }) {
  const [expanded, setExpanded] = useState(false);
  const {
    hypothesis_id,
    label,
    assessment,
    evidence_summary,
    limitations,
    heuristic_note,
    key_observations,
  } = hypothesis;

  const es            = evidence_summary ?? {};
  const envIds        = es.environmental_context_ids       ?? [];
  const suppIds       = es.supporting_evidence_ids         ?? [];
  const contIds       = es.contradicting_evidence_ids      ?? [];
  const nonDiscIds    = es.non_discriminating_evidence_ids ?? [];
  const limitItems    = limitations ?? [];

  return (
    <div
      data-testid={`hypothesis-card-${hypothesis_id}`}
      className="border border-slate-700 rounded-lg overflow-hidden"
    >
      {/* ── Card header (always visible) ───────────────────────────────────── */}
      <button
        data-testid={`hypothesis-header-${hypothesis_id}`}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full text-left flex items-center gap-3 px-4 py-3 bg-slate-800/40 hover:bg-slate-800/60 transition-colors"
      >
        <span className="font-mono text-sm font-bold text-slate-200 shrink-0 w-8">
          {hypothesis_id}
        </span>
        <span className="font-mono text-xs text-slate-300 flex-1 text-left leading-tight">
          {label}
        </span>
        {/* Assessment badge — read-only, exact canonical label */}
        <span
          data-testid={`hypothesis-assessment-badge-${hypothesis_id}`}
          className={`shrink-0 font-mono text-[10px] px-2 py-0.5 rounded border ${getAssessmentColor(assessment)}`}
        >
          {getAssessmentLabel(assessment)}
        </span>
        {expanded
          ? <ChevronUp className="w-4 h-4 text-slate-500 shrink-0" />
          : <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" />
        }
      </button>

      {/* ── Expanded detail ─────────────────────────────────────────────────── */}
      {expanded && (
        <div
          data-testid={`hypothesis-detail-${hypothesis_id}`}
          className="px-4 py-3 flex flex-col gap-4 bg-slate-900/60"
        >
          {/* Key observations from the deterministic analysis */}
          {(key_observations ?? []).length > 0 && (
            <div>
              <p className="font-mono text-[10px] text-slate-400 uppercase tracking-wider mb-1.5">
                Key Observations
              </p>
              <ul className="flex flex-col gap-1">
                {key_observations.map((obs, i) => (
                  <li
                    key={i}
                    data-testid={`key-observation-${hypothesis_id}-${i}`}
                    className="font-mono text-[11px] text-slate-300 leading-relaxed pl-2 border-l border-slate-700"
                  >
                    {obs}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ── Environmental context — visually distinct, explicit disclaimer ── */}
          {envIds.length > 0 && (
            <div
              data-testid={`env-context-section-${hypothesis_id}`}
              className="rounded-lg border border-amber-800/50 bg-amber-950/20 p-3"
            >
              <div className="flex items-start gap-1.5 mb-2">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                <div>
                  <p className="font-mono text-[10px] text-amber-400 font-semibold uppercase tracking-wider">
                    Environmental Context
                    <span className="font-normal text-amber-600 ml-1">— not mechanism confirmation</span>
                  </p>
                  <p
                    data-testid={`env-context-note-${hypothesis_id}`}
                    className="font-mono text-[9px] text-amber-700 mt-0.5 leading-relaxed"
                  >
                    {ENV_CONTEXT_NOTE}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-1" data-testid={`env-context-ids-${hypothesis_id}`}>
                {envIds.map((id) => (
                  <EvidenceIdChip key={id} id={id} testIdPrefix={`env-chip-${hypothesis_id}`} />
                ))}
              </div>
            </div>
          )}

          {/* ── Supporting evidence ────────────────────────────────────────── */}
          {suppIds.length > 0 && (
            <div data-testid={`supporting-section-${hypothesis_id}`}>
              <p className="font-mono text-[10px] text-cyan-400 uppercase tracking-wider mb-1.5">
                Supporting Evidence
              </p>
              <div className="flex flex-wrap gap-1" data-testid={`supporting-ids-${hypothesis_id}`}>
                {suppIds.map((id) => (
                  <EvidenceIdChip key={id} id={id} testIdPrefix={`supp-chip-${hypothesis_id}`} />
                ))}
              </div>
            </div>
          )}

          {/* ── Contradicting evidence ─────────────────────────────────────── */}
          {contIds.length > 0 && (
            <div data-testid={`contradicting-section-${hypothesis_id}`}>
              <p className="font-mono text-[10px] text-red-400 uppercase tracking-wider mb-1.5">
                Contradicting Evidence
              </p>
              <div className="flex flex-wrap gap-1" data-testid={`contradicting-ids-${hypothesis_id}`}>
                {contIds.map((id) => (
                  <EvidenceIdChip key={id} id={id} testIdPrefix={`cont-chip-${hypothesis_id}`} />
                ))}
              </div>
            </div>
          )}

          {/* ── Non-discriminating evidence ────────────────────────────────── */}
          {nonDiscIds.length > 0 && (
            <div data-testid={`non-discriminating-section-${hypothesis_id}`}>
              <p className="font-mono text-[10px] text-slate-400 uppercase tracking-wider mb-1.5">
                Non-discriminating Evidence
              </p>
              <div className="flex flex-wrap gap-1" data-testid={`non-discriminating-ids-${hypothesis_id}`}>
                {nonDiscIds.map((id) => (
                  <EvidenceIdChip key={id} id={id} testIdPrefix={`nondisc-chip-${hypothesis_id}`} />
                ))}
              </div>
            </div>
          )}

          {/* ── No evidence ────────────────────────────────────────────────── */}
          {envIds.length === 0 && suppIds.length === 0 && contIds.length === 0 && nonDiscIds.length === 0 && (
            <p
              data-testid={`no-evidence-${hypothesis_id}`}
              className="font-mono text-[11px] text-slate-600 italic"
            >
              No evidence in this dataset speaks to this hypothesis.
            </p>
          )}

          {/* ── Heuristic note ─────────────────────────────────────────────── */}
          {heuristic_note && (
            <p
              data-testid={`heuristic-note-${hypothesis_id}`}
              className="font-mono text-[10px] text-amber-700 italic border-t border-slate-800 pt-2"
            >
              {heuristic_note}
            </p>
          )}

          {/* ── Limitations ─────────────────────────────────────────────────── */}
          {limitItems.length > 0 && (
            <div data-testid={`hypothesis-limitations-${hypothesis_id}`}>
              <p className="font-mono text-[10px] text-orange-400 uppercase tracking-wider mb-1.5">
                Limitations
              </p>
              <div className="flex flex-col gap-1.5">
                {limitItems.map((lim, i) => (
                  <LimitationItem key={i} lim={lim} index={i} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Props:
 *   hypotheses — array from the investigation summary or forensic report
 */
export default function HypothesisAssessmentPanel({ hypotheses }) {
  const items = hypotheses ?? [];

  return (
    <div
      data-testid="hypothesis-assessment-panel"
      className="bg-slate-900 rounded-xl border border-slate-700 flex flex-col overflow-hidden"
    >
      <div className="px-5 py-3 border-b border-slate-700 flex items-center justify-between">
        <h3 className="font-mono text-xs font-semibold text-slate-200 uppercase tracking-wider">
          Hypothesis Assessments
        </h3>
        <span className="font-mono text-[9px] text-slate-600">
          read-only · deterministic pipeline
        </span>
      </div>

      <div className="p-4 flex flex-col gap-2" data-testid="hypothesis-cards">
        {items.length === 0 ? (
          <p className="font-mono text-xs text-slate-500 italic" data-testid="no-hypotheses">
            No hypotheses available.
          </p>
        ) : (
          items.map((h) => (
            <HypothesisCard key={h.hypothesis_id} hypothesis={h} />
          ))
        )}
      </div>
    </div>
  );
}
