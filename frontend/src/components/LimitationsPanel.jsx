import { AlertTriangle } from "lucide-react";

const LIMITATION_TYPE_LABELS = {
  proxy_measurement: "Proxy measurement",
  missing_data:      "Missing data",
  unresolved:        "Unresolved",
};

const LIMITATION_TYPE_STYLES = {
  proxy_measurement: "bg-amber-900/30 text-amber-300 border-amber-700",
  missing_data:      "bg-red-900/30 text-red-300 border-red-800",
  unresolved:        "bg-orange-900/30 text-orange-300 border-orange-800",
};

/**
 * LimitationsPanel
 *
 * Displays the aggregated, deduplicated limitations from the deterministic
 * forensic analysis.  Read-only.  No causal claims.
 */
export default function LimitationsPanel({ limitations }) {
  const items = limitations ?? [];

  return (
    <div
      data-testid="limitations-panel"
      className="bg-slate-900 rounded-xl border border-slate-700 flex flex-col overflow-hidden"
    >
      <div className="px-5 py-3 border-b border-slate-700 flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-orange-400 shrink-0" />
        <h3 className="font-mono text-xs font-semibold text-slate-200 uppercase tracking-wider">
          Analysis Limitations
        </h3>
        <span className="font-mono text-[10px] text-slate-500 ml-1">
          {items.length} {items.length === 1 ? "limitation" : "limitations"}
        </span>
      </div>

      <div className="p-4">
        {items.length === 0 ? (
          <p
            data-testid="limitations-empty"
            className="font-mono text-xs text-slate-500 italic"
          >
            No limitations recorded.
          </p>
        ) : (
          <ol
            data-testid="limitations-list"
            className="flex flex-col gap-3"
          >
            {items.map((lim, i) => {
              const typeStyle =
                LIMITATION_TYPE_STYLES[lim.type] ??
                "bg-slate-700 text-slate-400 border-slate-600";
              const typeLabel =
                LIMITATION_TYPE_LABELS[lim.type] ?? lim.type;
              return (
                <li
                  key={`${lim.type}-${i}`}
                  data-testid={`limitation-item-${i}`}
                  className="flex flex-col gap-1.5 pl-3 border-l border-slate-700"
                >
                  <span
                    data-testid={`limitation-type-${i}`}
                    className={`self-start font-mono text-[9px] px-1.5 py-0.5 rounded border uppercase tracking-wider ${typeStyle}`}
                  >
                    {typeLabel}
                  </span>
                  <p
                    data-testid={`limitation-description-${i}`}
                    className="font-mono text-xs text-slate-300 leading-relaxed"
                  >
                    {lim.description}
                  </p>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
