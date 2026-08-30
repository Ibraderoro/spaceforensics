import { History } from "lucide-react";

const EVENT_STYLES = {
  opened:    "text-green-400",
  suspended: "text-amber-400",
  resumed:   "text-cyan-400",
  "re-opened": "text-cyan-400",
  closed:    "text-slate-400",
};

/**
 * InvestigationHistoryPanel
 *
 * Displays the investigation lifecycle event log.  Read-only.
 * Shows events in chronological order.
 */
export default function InvestigationHistoryPanel({ history, loading, error }) {
  if (loading) {
    return (
      <div data-testid="history-loading" className="bg-slate-900 rounded-xl border border-slate-700 p-4">
        <p className="font-mono text-xs text-slate-500 italic">Loading history…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="history-error" className="bg-slate-900 rounded-xl border border-red-900/60 p-4">
        <p className="font-mono text-xs text-red-300">{error}</p>
      </div>
    );
  }

  const events       = history?.events       ?? [];
  const observations = history?.observations ?? [];
  const challenges   = history?.challenges   ?? [];

  return (
    <div
      data-testid="investigation-history-panel"
      className="bg-slate-900 rounded-xl border border-slate-700 flex flex-col overflow-hidden"
    >
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="px-5 py-3 border-b border-slate-700 flex items-center gap-2">
        <History className="w-4 h-4 text-slate-400 shrink-0" />
        <h3 className="font-mono text-xs font-semibold text-slate-200 uppercase tracking-wider">
          Investigation History
        </h3>
      </div>

      <div className="p-4 flex flex-col gap-5">
        {/* ── Lifecycle events ──────────────────────────────────────────────── */}
        <div data-testid="history-events">
          <p className="font-mono text-[10px] text-slate-400 uppercase tracking-wider mb-2">
            Lifecycle Events
          </p>
          {events.length === 0 ? (
            <p className="font-mono text-xs text-slate-500 italic">No events recorded.</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {events.map((ev, i) => (
                <li
                  key={i}
                  data-testid={`history-event-${i}`}
                  className="flex items-start gap-2 pl-3 border-l-2 border-slate-700"
                >
                  <span className={`font-mono text-[10px] font-semibold shrink-0 ${EVENT_STYLES[ev.event] ?? "text-slate-300"}`}>
                    {ev.event}
                  </span>
                  <span className="font-mono text-[10px] text-slate-500">{ev.timestamp}</span>
                  {ev.actor && (
                    <span className="font-mono text-[10px] text-slate-600">by {ev.actor}</span>
                  )}
                  {ev.reason && (
                    <span className="font-mono text-[10px] text-slate-500 italic">{ev.reason}</span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>

        {/* ── Observation version history ───────────────────────────────────── */}
        {observations.length > 0 && (
          <div data-testid="history-observations">
            <p className="font-mono text-[10px] text-slate-400 uppercase tracking-wider mb-2">
              Observation Versions
            </p>
            <ol className="flex flex-col gap-3">
              {observations.map((obs, i) => (
                <li
                  key={obs.observation_id ?? i}
                  data-testid={`history-observation-${obs.observation_id ?? i}`}
                  className="flex flex-col gap-1 pl-3 border-l-2 border-slate-700"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] text-slate-500">
                      {obs.observation_id}
                    </span>
                    <span className="font-mono text-[9px] text-slate-600">
                      {obs.version_count ?? obs.versions?.length ?? 1} version(s)
                    </span>
                  </div>
                  {/* Show all versions */}
                  {(obs.versions ?? []).map((v) => (
                    <div
                      key={v.version}
                      data-testid={`history-obs-version-${obs.observation_id}-${v.version}`}
                      className="flex flex-col gap-0.5 pl-2 border-l border-slate-800"
                    >
                      <span className="font-mono text-[9px] text-slate-600">
                        v{v.version} · {v.authored_at}
                      </span>
                      <p className="font-mono text-[11px] text-slate-400 leading-relaxed">{v.text}</p>
                    </div>
                  ))}
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* ── Challenge lifecycle history ───────────────────────────────────── */}
        {challenges.length > 0 && (
          <div data-testid="history-challenges">
            <p className="font-mono text-[10px] text-slate-400 uppercase tracking-wider mb-2">
              Challenge History
            </p>
            <ol className="flex flex-col gap-3">
              {challenges.map((c, i) => (
                <li
                  key={c.challenge_id ?? i}
                  data-testid={`history-challenge-${c.challenge_id ?? i}`}
                  className="flex flex-col gap-1 pl-3 border-l-2 border-slate-700"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] text-slate-300 font-semibold">
                      {c.challenge_id}
                    </span>
                    <span className="font-mono text-[9px] text-slate-500">
                      {c.target_type} → {c.target_id}
                    </span>
                  </div>
                  {(c.lifecycle ?? []).map((step, si) => (
                    <div
                      key={si}
                      data-testid={`history-challenge-step-${c.challenge_id}-${si}`}
                      className="flex items-center gap-2 pl-2 border-l border-slate-800"
                    >
                      <span className="font-mono text-[9px] text-slate-500">{step.status}</span>
                      <span className="font-mono text-[9px] text-slate-600">{step.timestamp}</span>
                      {step.actor && (
                        <span className="font-mono text-[9px] text-slate-600">by {step.actor}</span>
                      )}
                    </div>
                  ))}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}
