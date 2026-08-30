import { useState, useMemo, useCallback } from "react";
import { Search, Clock, AlertTriangle } from "lucide-react";
import { getAssessmentLabel, getAssessmentColor } from "../utils/assessmentLabels";
import { fetchEvidenceProvenance } from "../api";

// ── Source type constants ──────────────────────────────────────────────────────

const SOURCE_STYLES = {
  CASE:              "bg-amber-900/40 text-amber-300 border border-amber-700",
  GOES11_EP8:        "bg-cyan-900/40 text-cyan-300 border border-cyan-700",
  GOES11_MAG:        "bg-blue-900/40 text-blue-300 border border-blue-700",
  GOES11_EPHEMERIS:  "bg-slate-700 text-slate-400 border border-slate-600",
};

const SOURCE_LABELS = {
  CASE:              "Anomaly anchor",
  GOES11_EP8:        "Particle flux (EP8)",
  GOES11_MAG:        "Magnetic field (MAG)",
  GOES11_EPHEMERIS:  "Ephemeris (positional)",
};

// Human-readable labels for hypothesis relationship list names.
const LIST_NAME_LABELS = {
  environmental_context:       "Environmental context",
  supporting_evidence:         "Supporting evidence",
  contradicting_evidence:      "Contradicting evidence",
  non_discriminating_evidence: "Non-discriminating",
};

const LIST_NAME_STYLES = {
  environmental_context:       "bg-amber-900/40 text-amber-300 border border-amber-700",
  supporting_evidence:         "bg-cyan-900/40 text-cyan-300 border border-cyan-800",
  contradicting_evidence:      "bg-red-900/40 text-red-300 border border-red-800",
  non_discriminating_evidence: "bg-slate-700 text-slate-400 border border-slate-600",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Returns true when `timestamp` falls within ±600 seconds (10 minutes)
 * of `anchorTimestamp`. Returns false when either value is absent or invalid.
 */
function isInWindow(timestamp, windowStart, windowEnd) {
  if (!windowStart || !windowEnd || !timestamp) return false;
  const t = new Date(timestamp).getTime();
  return t >= windowStart && t <= windowEnd;
}

// ── TimelineProvenancePanel ────────────────────────────────────────────────────

/**
 * Inline provenance panel for the investigation timeline.
 * Shows the full provenance record (12 fields + hypothesis relationships)
 * for a selected evidence ID. Mirrors the ProvenancePanel in
 * ForensicInvestigationView but uses tl-prov-* test IDs to avoid collisions.
 *
 * Props:
 *   provenanceData   — result from fetchEvidenceProvenance (or { _fetchError: true })
 *   reportHypotheses — optional report.hypotheses array for assessment badge lookup
 */
function TimelineProvenancePanel({ provenanceData, reportHypotheses }) {
  if (!provenanceData) return null;

  if (provenanceData._fetchError) {
    return (
      <div
        data-testid="timeline-provenance-panel"
        className="mt-2 bg-slate-800/80 rounded-lg border border-red-800 p-3"
      >
        <p className="text-red-400 text-xs font-mono" data-testid="tl-prov-error">
          Provenance lookup failed — timeline view remains intact.
        </p>
      </div>
    );
  }

  if (!provenanceData.found) {
    return (
      <div
        data-testid="timeline-provenance-panel"
        className="mt-2 bg-slate-800/80 rounded-lg border border-slate-600 p-3"
      >
        <p className="text-slate-500 text-xs italic font-mono" data-testid="tl-prov-not-found">
          Evidence ID {provenanceData.evidence_id} not found in timeline.
        </p>
      </div>
    );
  }

  const assessmentById = {};
  for (const h of reportHypotheses ?? []) {
    assessmentById[h.hypothesis_id] = h.assessment;
  }

  const rels = provenanceData.hypothesis_relationships ?? [];

  return (
    <div
      data-testid="timeline-provenance-panel"
      className="mt-2 bg-slate-800/80 rounded-lg border border-slate-600 p-4 flex flex-col gap-4"
    >
      {/* Header */}
      <p className="font-mono text-[10px] text-slate-400 uppercase tracking-widest border-b border-slate-700 pb-1.5">
        Evidence Provenance — {provenanceData.evidence_id}
      </p>

      {/* Raw evidence fields (12 fields) */}
      <div>
        <p className="font-mono text-[10px] text-slate-500 uppercase tracking-wider mb-2">
          Record
        </p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-xs">
          <dt className="text-slate-500">Evidence ID</dt>
          <dd className="text-slate-200" data-testid="tl-prov-evidence-id">
            {provenanceData.evidence_id}
          </dd>

          <dt className="text-slate-500">Timestamp</dt>
          <dd className="text-slate-200" data-testid="tl-prov-timestamp">
            {provenanceData.timestamp ?? "—"}
          </dd>

          <dt className="text-slate-500">Source</dt>
          <dd className="text-slate-200" data-testid="tl-prov-source">
            {provenanceData.source ?? "—"}
          </dd>

          <dt className="text-slate-500">Measurement</dt>
          <dd className="text-slate-200" data-testid="tl-prov-measurement">
            {provenanceData.measurement ?? "—"}
          </dd>

          <dt className="text-slate-500">Value</dt>
          <dd className="text-slate-200" data-testid="tl-prov-value">
            {provenanceData.value != null ? `${provenanceData.value}` : "—"}
            {provenanceData.unit
              ? <span className="text-slate-500 ml-1" data-testid="tl-prov-unit">{provenanceData.unit}</span>
              : null}
          </dd>

          <dt className="text-slate-500">Resolution</dt>
          <dd className="text-slate-300" data-testid="tl-prov-resolution">
            {provenanceData.resolution ?? "—"}
          </dd>

          <dt className="text-slate-500">Dataset</dt>
          <dd className="text-slate-300" data-testid="tl-prov-dataset-id">
            {provenanceData.dataset_id ?? "—"}
          </dd>

          <dt className="text-slate-500">Provider</dt>
          <dd className="text-slate-300" data-testid="tl-prov-provider">
            {provenanceData.provider ?? "—"}
          </dd>

          <dt className="text-slate-500">Variable</dt>
          <dd className="text-slate-300" data-testid="tl-prov-variable">
            {provenanceData.variable ?? "—"}
          </dd>

          <dt className="text-slate-500">Evidence type</dt>
          <dd className="text-slate-300" data-testid="tl-prov-evidence-type">
            {provenanceData.evidence_type ?? "—"}
          </dd>

          <dt className="text-slate-500">Quality</dt>
          <dd className="text-slate-300" data-testid="tl-prov-quality">
            {provenanceData.quality ?? "—"}
          </dd>
        </dl>
      </div>

      {/* Hypothesis Relationships */}
      <div className="pt-2 border-t border-slate-700">
        <p className="font-mono text-[10px] text-slate-500 uppercase tracking-wider mb-2">
          Hypothesis Relationships
        </p>

        {rels.length === 0 ? (
          <p
            className="text-slate-600 text-xs italic font-mono"
            data-testid="tl-prov-no-relationships"
          >
            No hypothesis relationships — record not cited in any hypothesis.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {rels.map((rel) => {
              const assessment = assessmentById[rel.hypothesis_id];
              const listLabel  = LIST_NAME_LABELS[rel.list_name] ?? rel.list_name;
              const listStyle  = LIST_NAME_STYLES[rel.list_name] ?? LIST_NAME_STYLES.non_discriminating_evidence;
              return (
                <div
                  key={`${rel.hypothesis_id}-${rel.list_name}`}
                  data-testid={`tl-prov-relationship-${rel.hypothesis_id}`}
                  className="flex flex-col gap-1 pl-2 border-l border-slate-700"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-slate-200">
                      {rel.hypothesis_id}
                    </span>
                    {assessment && (
                      <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${getAssessmentColor(assessment)}`}>
                        {getAssessmentLabel(assessment)}
                      </span>
                    )}
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${listStyle}`}
                      data-testid={`tl-prov-list-name-${rel.hypothesis_id}`}
                    >
                      {listLabel}
                    </span>
                  </div>
                  <span
                    className="font-mono text-[10px] text-slate-500"
                    data-testid={`tl-prov-rel-label-${rel.hypothesis_id}`}
                  >
                    {rel.relationship}
                  </span>
                  {rel.interpretation && (
                    <p
                      className="text-slate-300 text-xs leading-relaxed italic"
                      data-testid={`tl-prov-rel-interpretation-${rel.hypothesis_id}`}
                    >
                      {rel.interpretation}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Source filter buttons ─────────────────────────────────────────────────────

const ALL_SOURCES = ["CASE", "GOES11_EP8", "GOES11_MAG", "GOES11_EPHEMERIS"];

// ── Main component ────────────────────────────────────────────────────────────

/**
 * InvestigationTimeline
 *
 * Displays the full Galaxy 15 evidence timeline as a scrollable investigator
 * record list. All source types are shown. Selecting a record fetches and
 * displays its provenance (evidence fields + hypothesis relationships).
 *
 * The ±10-minute temporal selection window is visually indicated but is
 * explicitly labelled as a heuristic, not a causal threshold.
 *
 * Props:
 *   timelineData     — evidence record array from GET /timeline
 *   anchorTimestamp  — ISO string of the anomaly anchor event
 *   reportHypotheses — optional report.hypotheses array for assessment badge lookup
 */
export default function InvestigationTimeline({ timelineData, anchorTimestamp, reportHypotheses, caseId = "galaxy-15" }) {
  const [selectedId,      setSelectedId]      = useState(null);
  const [provenanceResult, setProvenanceResult] = useState(null);
  const [activeSource,    setActiveSource]    = useState(null); // null = all sources

  // Compute ±10-minute window boundaries once
  const { windowStart, windowEnd } = useMemo(() => {
    if (!anchorTimestamp) return { windowStart: null, windowEnd: null };
    const anchor = new Date(anchorTimestamp).getTime();
    return {
      windowStart: anchor - 600_000, // −10 min in ms
      windowEnd:   anchor + 600_000, // +10 min in ms
    };
  }, [anchorTimestamp]);

  // Sort records by timestamp (API already sorts, but defensive)
  const sortedRecords = useMemo(() => {
    const data = timelineData ?? [];
    const filtered = activeSource ? data.filter((r) => r.source === activeSource) : data;
    return [...filtered].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }, [timelineData, activeSource]);

  const handleRowSelect = useCallback((id) => {
    setSelectedId((prev) => {
      if (prev === id) {
        setProvenanceResult(null);
        return null;
      }
      fetchEvidenceProvenance(caseId, id)
        .then((data) => setProvenanceResult(data))
        .catch(() => setProvenanceResult({ _fetchError: true }));
      return id;
    });
  }, []);

  const totalCount = (timelineData ?? []).length;
  const shownCount = sortedRecords.length;

  return (
    <div
      data-testid="investigation-timeline"
      className="bg-slate-900 rounded-xl border border-slate-700 flex flex-col overflow-hidden"
    >
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-slate-400 shrink-0" />
          <h2 className="font-mono text-sm font-semibold text-slate-200 uppercase tracking-wider">
            Investigation Timeline
          </h2>
          <span className="font-mono text-[10px] text-slate-500 ml-1">
            {shownCount === totalCount
              ? `${totalCount} records`
              : `${shownCount} of ${totalCount} records`}
          </span>
        </div>
      </div>

      {/* ── Temporal window disclaimer ───────────────────────────────────────── */}
      <div
        data-testid="temporal-window-banner"
        className="mx-5 mt-4 px-3 py-2 rounded border border-amber-800/50 bg-amber-950/20 flex items-start gap-2"
      >
        <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-[10px] text-amber-400 font-semibold uppercase tracking-wider">
            MVP temporal selection window
          </span>
          <span className="font-mono text-[10px] text-amber-300 leading-relaxed">
            Evidence-selection heuristic; not a scientifically calibrated causal threshold.
            Records within ±10 minutes of the anchor event are highlighted for investigator
            reference only.
          </span>
        </div>
      </div>

      {/* ── Source filter tabs ───────────────────────────────────────────────── */}
      <div className="px-5 pt-3 pb-2 flex gap-1.5 flex-wrap" data-testid="source-filter-tabs">
        <button
          onClick={() => { setActiveSource(null); setSelectedId(null); setProvenanceResult(null); }}
          className={`font-mono text-[10px] px-2 py-1 rounded border transition-colors ${
            activeSource === null
              ? "bg-slate-600 text-slate-200 border-slate-500"
              : "bg-slate-800 text-slate-500 border-slate-700 hover:bg-slate-700"
          }`}
          data-testid="filter-all"
          aria-label="Show all timeline sources"
          aria-pressed={activeSource === null}
        >
          All
        </button>
        {ALL_SOURCES.map((src) => (
          <button
            key={src}
            onClick={() => { setActiveSource(src); setSelectedId(null); setProvenanceResult(null); }}
            className={`font-mono text-[10px] px-2 py-1 rounded border transition-colors ${
              activeSource === src
                ? `${SOURCE_STYLES[src]} opacity-100`
                : "bg-slate-800 text-slate-500 border-slate-700 hover:bg-slate-700"
            }`}
            data-testid={`filter-${src}`}
            aria-label={`Filter by ${SOURCE_LABELS[src] ?? src}`}
            aria-pressed={activeSource === src}
          >
            {SOURCE_LABELS[src] ?? src}
          </button>
        ))}
      </div>

      {/* ── Record list ─────────────────────────────────────────────────────── */}
      <div
        data-testid="timeline-list"
        className="mx-5 mb-4 flex flex-col gap-0.5 max-h-[480px] overflow-y-auto border border-slate-800 rounded-lg"
      >
        {sortedRecords.length === 0 ? (
          <p className="text-slate-600 text-xs italic font-mono p-4">
            No records for this source filter.
          </p>
        ) : (
          sortedRecords.map((rec) => {
            const inWindow  = isInWindow(rec.timestamp, windowStart, windowEnd);
            const isCase    = rec.source === "CASE";
            const isEph     = rec.source === "GOES11_EPHEMERIS";
            const isSelected = selectedId === rec.evidence_id;
            const srcStyle  = SOURCE_STYLES[rec.source] ?? SOURCE_STYLES.GOES11_EPHEMERIS;

            return (
              <div key={rec.evidence_id}>
                <button
                  data-testid={`timeline-row-${rec.evidence_id}`}
                  onClick={() => handleRowSelect(rec.evidence_id)}
                  aria-label={`${isSelected ? "Deselect" : "Select"} record ${rec.evidence_id} — ${rec.source} ${rec.measurement}`}
                  aria-pressed={isSelected}
                  className={`w-full text-left px-3 py-2 flex items-start gap-3 hover:bg-slate-800/60 transition-colors
                    ${isSelected ? "bg-slate-800 ring-1 ring-inset ring-slate-600" : ""}
                    ${isCase ? "border-l-2 border-amber-500" : "border-l-2 border-transparent"}
                  `}
                >
                  {/* Window indicator */}
                  {inWindow && (
                    <span
                      data-testid={`window-indicator-${rec.evidence_id}`}
                      className="shrink-0 mt-1 w-1.5 h-1.5 rounded-full bg-amber-500"
                      title="Within MVP temporal selection window (±10 min)"
                    />
                  )}

                  {/* Evidence ID + timestamp */}
                  <div className="flex flex-col gap-0.5 min-w-[140px]">
                    <span className="font-mono text-[10px] text-slate-400">
                      {rec.evidence_id}
                    </span>
                    <span className="font-mono text-[10px] text-slate-500">
                      {rec.timestamp}
                    </span>
                  </div>

                  {/* Source badge */}
                  <span className={`shrink-0 font-mono text-[9px] px-1.5 py-0.5 rounded ${srcStyle}`}>
                    {SOURCE_LABELS[rec.source] ?? rec.source}
                  </span>

                  {/* CASE anchor badge */}
                  {isCase && (
                    <span
                      data-testid="anchor-badge"
                      className="shrink-0 font-mono text-[9px] px-1.5 py-0.5 rounded bg-amber-800/60 text-amber-300 border border-amber-700"
                    >
                      ⚡ Anomaly anchor
                    </span>
                  )}

                  {/* EPHEMERIS badge */}
                  {isEph && (
                    <span
                      data-testid={`ephemeris-badge-${rec.evidence_id}`}
                      className="shrink-0 font-mono text-[9px] px-1.5 py-0.5 rounded bg-slate-700/60 text-slate-500 border border-slate-600"
                    >
                      Positional data — not hypothesis evidence
                    </span>
                  )}

                  {/* Measurement + value */}
                  <div className="ml-auto flex items-center gap-2 shrink-0">
                    <span className="font-mono text-[10px] text-slate-500">{rec.measurement}</span>
                    <span className="font-mono text-[10px] text-slate-300">
                      {rec.value != null ? rec.value : "—"}
                      {rec.unit && (
                        <span className="text-slate-600 ml-0.5">{rec.unit}</span>
                      )}
                    </span>
                    <Search className="w-3 h-3 text-slate-600 shrink-0" />
                  </div>
                </button>

                {/* Inline provenance panel for selected row */}
                {isSelected && (
                  provenanceResult ? (
                    <div className="px-4 pb-3">
                      <TimelineProvenancePanel
                        provenanceData={provenanceResult}
                        reportHypotheses={reportHypotheses}
                      />
                    </div>
                  ) : (
                    <div className="px-4 pb-3">
                      <p
                        className="text-slate-600 text-xs italic font-mono py-2"
                        data-testid="timeline-prov-loading"
                      >
                        Loading provenance for {selectedId}…
                      </p>
                    </div>
                  )
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
