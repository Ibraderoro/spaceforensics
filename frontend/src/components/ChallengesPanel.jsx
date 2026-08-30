import { useState } from "react";
import { Flag, Plus, AlertCircle, Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { createChallenge, patchChallengeStatus } from "../api";
import { getAssessmentColor } from "../utils/assessmentLabels";

const TARGET_TYPE_LABELS = {
  hypothesis_assessment:    "Hypothesis assessment",
  evidence_classification:  "Evidence classification",
  limitation:               "Limitation",
  missing_evidence:         "Missing evidence",
  additional_investigation: "Additional investigation",
};

const STATUS_STYLES = {
  open:         "bg-blue-900/40 text-blue-300 border-blue-800",
  under_review: "bg-amber-900/40 text-amber-300 border-amber-800",
  resolved:     "bg-green-900/40 text-green-300 border-green-800",
  rejected:     "bg-slate-700 text-slate-400 border-slate-600",
};

const RESOLUTION_OUTCOME_LABELS = {
  acknowledged: "Acknowledged",
  will_not_fix: "Will not fix",
  escalated:    "Escalated",
};

const TARGET_TYPES = Object.keys(TARGET_TYPE_LABELS);
const ALLOWED_TRANSITIONS = {
  open:         ["under_review", "rejected"],
  under_review: ["resolved", "rejected"],
};
const RESOLUTION_OUTCOMES = ["acknowledged", "will_not_fix", "escalated"];

/**
 * ChallengesPanel
 *
 * Lists analyst challenges for the current investigation and provides
 * a form to create new ones.
 *
 * Rules:
 *   - Challenges CANNOT change hypothesis assessments — the form does not
 *     provide an assessment field.
 *   - analyst_statement must use qualitative language only.
 *   - Lifecycle transitions shown read-only.
 *   - Forensic fields (assessment, causal_attribution_established) are read-only.
 */
export default function ChallengesPanel({
  caseId,
  investigationId,
  challenges,
  onChallengeCreated,
  onChallengeTransitioned,
}) {
  const [formOpen,     setFormOpen]     = useState(false);
  const [targetType,   setTargetType]   = useState("hypothesis_assessment");
  const [targetId,     setTargetId]     = useState("");
  const [statement,    setStatement]    = useState("");
  const [authoredBy,   setAuthoredBy]   = useState("");
  const [submitting,   setSubmitting]   = useState(false);
  const [formError,    setFormError]    = useState(null);
  const [transitioning, setTransitioning] = useState(null);

  const items = challenges ?? [];

  // ── Create challenge ────────────────────────────────────────────────────────
  async function handleSubmit(e) {
    e.preventDefault();
    if (!targetId.trim()) { setFormError("Target ID is required."); return; }
    if (!statement.trim()) { setFormError("Analyst statement is required."); return; }
    setFormError(null);
    setSubmitting(true);
    try {
      const created = await createChallenge(caseId, investigationId, {
        target_type:       targetType,
        target_id:         targetId.trim(),
        analyst_statement: statement.trim(),
        authored_by:       authoredBy.trim() || undefined,
      });
      setTargetId(""); setStatement(""); setAuthoredBy(""); setFormOpen(false);
      onChallengeCreated?.(created);
    } catch (err) {
      setFormError(err.message || "Failed to create challenge.");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Lifecycle transition ────────────────────────────────────────────────────
  async function handleTransition(cid, status, resolutionOutcome) {
    setTransitioning(cid);
    try {
      const updated = await patchChallengeStatus(caseId, investigationId, cid, {
        status,
        actor: "analyst",
        resolution_outcome: resolutionOutcome,
      });
      onChallengeTransitioned?.(updated);
    } catch (_) { /* surface nothing — caller can refresh */ }
    finally { setTransitioning(null); }
  }

  return (
    <div
      data-testid="challenges-panel"
      className="bg-slate-900 rounded-xl border border-slate-700 flex flex-col overflow-hidden"
    >
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="px-5 py-3 border-b border-slate-700 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Flag className="w-4 h-4 text-slate-400 shrink-0" />
          <h3 className="font-mono text-xs font-semibold text-slate-200 uppercase tracking-wider">
            Analyst Challenges
          </h3>
          <span className="font-mono text-[10px] text-slate-500 ml-1">{items.length}</span>
        </div>
        <button
          data-testid="challenges-open-form-btn"
          onClick={() => { setFormOpen((v) => !v); setFormError(null); }}
          className="flex items-center gap-1 font-mono text-[10px] px-2 py-1 rounded border
                     bg-slate-800 text-slate-300 border-slate-600 hover:bg-slate-700 transition-colors"
          aria-expanded={formOpen}
        >
          <Plus className="w-3 h-3" />
          New
        </button>
      </div>

      <div className="p-4 flex flex-col gap-3">
        {/* ── Create form ─────────────────────────────────────────────────────── */}
        {formOpen && (
          <form
            data-testid="challenge-form"
            onSubmit={handleSubmit}
            className="flex flex-col gap-2 mb-2 bg-slate-800/40 rounded-lg p-3 border border-slate-700"
          >
            <p className="font-mono text-[10px] text-slate-400 uppercase tracking-wider">New Challenge</p>

            <div className="flex flex-col gap-1">
              <label className="font-mono text-[10px] text-slate-500" htmlFor="challenge-target-type">
                Target type
              </label>
              <select
                id="challenge-target-type"
                data-testid="challenge-target-type-select"
                value={targetType}
                onChange={(e) => setTargetType(e.target.value)}
                className="font-mono text-xs bg-slate-800 border border-slate-600 rounded px-2 py-1.5
                           text-slate-200 focus:outline-none focus:border-slate-500"
              >
                {TARGET_TYPES.map((t) => (
                  <option key={t} value={t}>{TARGET_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="font-mono text-[10px] text-slate-500" htmlFor="challenge-target-id">
                Target ID
                {targetType === "hypothesis_assessment" && (
                  <span className="text-slate-600 ml-1">(e.g. H1, H2…)</span>
                )}
              </label>
              <input
                id="challenge-target-id"
                data-testid="challenge-target-id-input"
                type="text"
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                placeholder={targetType === "hypothesis_assessment" ? "H1" : "Enter target ID"}
                className="font-mono text-xs bg-slate-800 border border-slate-600 rounded px-2 py-1.5
                           text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-500"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="font-mono text-[10px] text-slate-500" htmlFor="challenge-statement">
                Analyst statement
              </label>
              <textarea
                id="challenge-statement"
                data-testid="challenge-statement-input"
                value={statement}
                onChange={(e) => setStatement(e.target.value)}
                placeholder="Describe the challenge in qualitative terms…"
                rows={3}
                className="font-mono text-xs bg-slate-800 border border-slate-600 rounded px-2 py-2
                           text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-500 resize-none"
              />
              <p className="font-mono text-[9px] text-slate-600">
                No numerical probabilities. No causal claims. No assessment changes.
              </p>
            </div>

            <input
              data-testid="challenge-author-input"
              type="text"
              value={authoredBy}
              onChange={(e) => setAuthoredBy(e.target.value)}
              placeholder="Analyst name (optional)"
              className="font-mono text-xs bg-slate-800 border border-slate-600 rounded px-2 py-1.5
                         text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-500"
            />

            {formError && (
              <div data-testid="challenge-form-error" className="flex items-center gap-1.5 text-red-400">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span className="font-mono text-xs">{formError}</span>
              </div>
            )}

            <div className="flex gap-2">
              <button
                data-testid="challenge-submit-btn"
                type="submit"
                disabled={submitting}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded font-mono text-xs
                           bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-200
                           disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                {submitting ? "Saving…" : "Submit"}
              </button>
              <button
                type="button"
                onClick={() => { setFormOpen(false); setFormError(null); }}
                className="px-3 py-1.5 rounded font-mono text-xs bg-slate-800 hover:bg-slate-700
                           border border-slate-700 text-slate-400 transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {/* ── Challenge list ───────────────────────────────────────────────── */}
        {items.length === 0 ? (
          <p data-testid="challenges-empty" className="font-mono text-xs text-slate-500 italic">
            No challenges raised for this investigation.
          </p>
        ) : (
          <ol data-testid="challenges-list" className="flex flex-col gap-3">
            {items.map((c, i) => {
              const statusStyle = STATUS_STYLES[c.status] ?? STATUS_STYLES.rejected;
              const allowedNext = ALLOWED_TRANSITIONS[c.status] ?? [];
              const isTerminal  = allowedNext.length === 0;
              const isTransitioning = transitioning === c.challenge_id;
              return (
                <li
                  key={c.challenge_id ?? i}
                  data-testid={`challenge-item-${c.challenge_id ?? i}`}
                  className="flex flex-col gap-2 pl-3 border-l-2 border-slate-700 bg-slate-800/20 rounded-r-lg p-3"
                >
                  {/* ── Challenge header ──────────────────────────────────── */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      data-testid={`challenge-status-${c.challenge_id ?? i}`}
                      className={`font-mono text-[9px] px-1.5 py-0.5 rounded border ${statusStyle}`}
                    >
                      {c.status}
                    </span>
                    <span className="font-mono text-[10px] text-slate-400">
                      {TARGET_TYPE_LABELS[c.target_type] ?? c.target_type}
                    </span>
                    <span className="font-mono text-[10px] font-semibold text-slate-200">
                      → {c.target_id}
                    </span>
                    {c.authored_by && (
                      <span className="font-mono text-[9px] text-slate-600 ml-auto">
                        {c.authored_by}
                      </span>
                    )}
                  </div>

                  {/* ── Analyst statement ─────────────────────────────────── */}
                  <p
                    data-testid={`challenge-statement-${c.challenge_id ?? i}`}
                    className="font-mono text-xs text-slate-300 leading-relaxed"
                  >
                    {c.analyst_statement}
                  </p>

                  {/* ── Resolution metadata ───────────────────────────────── */}
                  {c.resolution_metadata && (
                    <div
                      data-testid={`challenge-resolution-${c.challenge_id ?? i}`}
                      className="flex items-center gap-1.5"
                    >
                      <span className="font-mono text-[9px] text-slate-500">Outcome:</span>
                      <span className="font-mono text-[9px] text-green-300">
                        {RESOLUTION_OUTCOME_LABELS[c.resolution_metadata.resolution_outcome]
                          ?? c.resolution_metadata.resolution_outcome}
                      </span>
                    </div>
                  )}

                  {/* ── Lifecycle transitions ─────────────────────────────── */}
                  {!isTerminal && (
                    <div className="flex gap-1.5 flex-wrap" data-testid={`challenge-transitions-${c.challenge_id ?? i}`}>
                      {allowedNext.map((nextStatus) => (
                        <button
                          key={nextStatus}
                          data-testid={`transition-btn-${c.challenge_id}-${nextStatus}`}
                          disabled={isTransitioning}
                          onClick={() => {
                            const outcome = nextStatus === "resolved" ? "acknowledged" : undefined;
                            handleTransition(c.challenge_id, nextStatus, outcome);
                          }}
                          className={`font-mono text-[9px] px-2 py-1 rounded border transition-colors
                            ${STATUS_STYLES[nextStatus] ?? "bg-slate-700 text-slate-400 border-slate-600"}
                            disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-80`}
                        >
                          {isTransitioning
                            ? <Loader2 className="w-3 h-3 animate-spin inline" />
                            : `→ ${nextStatus}`
                          }
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
