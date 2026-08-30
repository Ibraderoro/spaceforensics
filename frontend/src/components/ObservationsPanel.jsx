import { useState } from "react";
import { Eye, Plus, AlertCircle, Loader2 } from "lucide-react";
import { createObservation } from "../api";

/**
 * ObservationsPanel
 *
 * Lists analyst observations for the current investigation and provides
 * a form to add new ones.
 *
 * Rules:
 *   - Observations do not modify evidence or assessments.
 *   - Evidence IDs referenced are read-only citations, not new evidence.
 *   - Observations are analyst-created (not forensic authority).
 */
export default function ObservationsPanel({ caseId, investigationId, observations, onObservationAdded }) {
  const [text,       setText]       = useState("");
  const [authoredBy, setAuthoredBy] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError,  setFormError]  = useState(null);

  const items = observations ?? [];

  async function handleSubmit(e) {
    e.preventDefault();
    if (!text.trim()) {
      setFormError("Observation text is required.");
      return;
    }
    setFormError(null);
    setSubmitting(true);
    try {
      const created = await createObservation(caseId, investigationId, {
        text: text.trim(),
        authored_by: authoredBy.trim() || undefined,
      });
      setText("");
      setAuthoredBy("");
      onObservationAdded?.(created);
    } catch (err) {
      setFormError(err.message || "Failed to add observation.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      data-testid="observations-panel"
      className="bg-slate-900 rounded-xl border border-slate-700 flex flex-col overflow-hidden"
    >
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="px-5 py-3 border-b border-slate-700 flex items-center gap-2">
        <Eye className="w-4 h-4 text-slate-400 shrink-0" />
        <h3 className="font-mono text-xs font-semibold text-slate-200 uppercase tracking-wider">
          Analyst Observations
        </h3>
        <span className="font-mono text-[10px] text-slate-500 ml-1">
          {items.length}
        </span>
      </div>

      {/* ── Observation list ─────────────────────────────────────────────────── */}
      <div className="p-4 flex flex-col gap-3">
        {items.length === 0 ? (
          <p
            data-testid="observations-empty"
            className="font-mono text-xs text-slate-500 italic"
          >
            No observations recorded for this investigation.
          </p>
        ) : (
          <ol
            data-testid="observations-list"
            className="flex flex-col gap-3"
          >
            {items.map((obs, i) => (
              <li
                key={obs.observation_id ?? i}
                data-testid={`observation-item-${obs.observation_id ?? i}`}
                className="flex flex-col gap-1.5 pl-3 border-l-2 border-slate-700 bg-slate-800/30 rounded-r-lg px-3 py-2"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-[10px] text-slate-500">
                    {obs.authored_by ?? "Anonymous"}
                  </span>
                  <span className="font-mono text-[10px] text-slate-600">
                    {obs.authored_at ?? ""}
                  </span>
                  <span
                    data-testid={`observation-status-${obs.observation_id ?? i}`}
                    className="font-mono text-[9px] px-1.5 py-0.5 rounded border bg-slate-700 text-slate-400 border-slate-600"
                  >
                    {obs.status ?? "published"}
                  </span>
                </div>
                <p
                  data-testid={`observation-text-${obs.observation_id ?? i}`}
                  className="font-mono text-xs text-slate-300 leading-relaxed"
                >
                  {obs.current_text ?? obs.text ?? ""}
                </p>
                {(obs.evidence_ids ?? []).length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {obs.evidence_ids.map((eid) => (
                      <span
                        key={eid}
                        data-testid={`obs-evidence-ref-${eid}`}
                        className="font-mono text-[9px] px-1.5 py-0.5 rounded bg-slate-700/60 text-slate-400 border border-slate-600"
                      >
                        {eid}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}

        {/* ── Add observation form ──────────────────────────────────────────── */}
        <form
          data-testid="observation-form"
          onSubmit={handleSubmit}
          className="flex flex-col gap-2 pt-3 border-t border-slate-800 mt-1"
        >
          <p className="font-mono text-[10px] text-slate-500 uppercase tracking-wider flex items-center gap-1">
            <Plus className="w-3 h-3" />
            Add Observation
          </p>

          <textarea
            data-testid="observation-text-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Enter your observation…"
            rows={3}
            className="font-mono text-xs bg-slate-800 border border-slate-600 rounded px-3 py-2
                       text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-500
                       resize-none"
          />

          <input
            data-testid="observation-author-input"
            type="text"
            value={authoredBy}
            onChange={(e) => setAuthoredBy(e.target.value)}
            placeholder="Analyst name (optional)"
            className="font-mono text-xs bg-slate-800 border border-slate-600 rounded px-3 py-1.5
                       text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-500"
          />

          {formError && (
            <div
              data-testid="observation-form-error"
              className="flex items-center gap-1.5 text-red-400"
            >
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span className="font-mono text-xs">{formError}</span>
            </div>
          )}

          <button
            data-testid="observation-submit-btn"
            type="submit"
            disabled={submitting}
            className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded font-mono text-xs
                       bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-200
                       disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Plus className="w-3.5 h-3.5" />
                Add Observation
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
