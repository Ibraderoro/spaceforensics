import { useState, useMemo, useCallback } from "react";
import { Search, AlertTriangle, Info, GitBranch } from "lucide-react";
import { getAssessmentLabel, getAssessmentColor } from "../utils/assessmentLabels";
import { fetchEvidenceProvenance } from "../api";

// ── Relationship list configuration ──────────────────────────────────────────

const RELATIONSHIP_LIST_NAMES = [
  "environmental_context",
  "supporting_evidence",
  "contradicting_evidence",
  "non_discriminating_evidence",
];

const LIST_CONFIG = {
  environmental_context: {
    label:      "Environmental context",
    // Amber — visually distinct from all other lists; never labelled as supporting
    chipStyle:  "bg-amber-900/40 text-amber-300 border border-amber-700",
    headingColor: "text-amber-400",
    borderColor:  "border-amber-700",
    bgColor:      "bg-amber-950/20",
    // Mandatory disclaimer — must never be removed or softened
    disclaimer: "Environmental context — not supporting evidence",
  },
  supporting_evidence: {
    label:      "Supporting evidence",
    chipStyle:  "bg-cyan-900/40 text-cyan-300 border border-cyan-800",
    headingColor: "text-cyan-400",
    borderColor:  "border-cyan-800",
    bgColor:      "bg-cyan-950/10",
    disclaimer: null,
  },
  contradicting_evidence: {
    label:      "Contradicting evidence",
    chipStyle:  "bg-red-900/40 text-red-300 border border-red-800",
    headingColor: "text-red-400",
    borderColor:  "border-red-800",
    bgColor:      "bg-red-950/10",
    disclaimer: null,
  },
  non_discriminating_evidence: {
    label:      "Non-discriminating evidence",
    chipStyle:  "bg-slate-700 text-slate-400 border border-slate-600",
    headingColor: "text-slate-400",
    borderColor:  "border-slate-700",
    bgColor:      "",
    disclaimer: null,
  },
};

const LIMITATION_TYPE_STYLES = {
  unresolved:        "text-amber-400",
  proxy_measurement: "text-orange-400",
  missing_data:      "text-red-400",
};

// ── Sub-components ────────────────────────────────────────────────────────────

/** Hypothesis selector tabs — H1 through H5. */
function HypothesisTabs({ hypotheses, activeId, onSelect }) {
  return (
    <div className="flex gap-1 flex-wrap" role="tablist" data-testid="explorer-hypothesis-tabs">
      {hypotheses.map((h) => {
        const isActive = h.hypothesis_id === activeId;
        const colorClass = getAssessmentColor(h.assessment);
        return (
          <button
            key={h.hypothesis_id}
            role="tab"
            aria-selected={isActive}
            data-testid={`explorer-tab-${h.hypothesis_id}`}
            onClick={() => onSelect(h.hypothesis_id)}
            className={`font-mono text-xs px-3 py-1.5 rounded border transition-colors
              ${isActive
                ? `${colorClass} opacity-100`
                : "bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-700"
              }`}
          >
            {h.hypothesis_id}
          </button>
        );
      })}
    </div>
  );
}

/** Four toggle chips to show/hide relationship list sections. */
function RelationshipFilter({ activeFilters, onToggle }) {
  return (
    <div className="flex gap-1.5 flex-wrap" data-testid="relationship-filter">
      {RELATIONSHIP_LIST_NAMES.map((name) => {
        const cfg = LIST_CONFIG[name];
        const isOn = activeFilters.has(name);
        return (
          <button
            key={name}
            data-testid={`filter-toggle-${name}`}
            aria-pressed={isOn}
            aria-label={cfg.label}
            onClick={() => onToggle(name)}
            className={`font-mono text-[10px] px-2 py-1 rounded border transition-colors
              ${isOn ? cfg.chipStyle : "bg-slate-800 text-slate-600 border-slate-700"}`}
          >
            {cfg.label}
          </button>
        );
      })}
    </div>
  );
}

/** Assessment badge + label + heuristic note for the active hypothesis. */
function HypothesisAssessmentHeader({ hypothesis }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-mono text-sm font-semibold text-slate-200">
          {hypothesis.hypothesis_id} — {hypothesis.label}
        </span>
        <span
          data-testid={`explorer-assessment-${hypothesis.hypothesis_id}`}
          className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded border ${getAssessmentColor(hypothesis.assessment)}`}
        >
          {getAssessmentLabel(hypothesis.assessment)}
        </span>
      </div>
      {hypothesis.heuristic_note && (
        <div className="p-2.5 rounded border border-amber-800/50 bg-amber-950/20">
          <p className="font-mono text-[10px] text-amber-500 uppercase tracking-wider mb-0.5">
            Methodological note
          </p>
          <p className="text-amber-200/80 text-xs leading-relaxed">
            {hypothesis.heuristic_note}
          </p>
        </div>
      )}
    </div>
  );
}

/** Limitations block — always visible, never collapsed. */
function HypothesisLimitations({ hypothesis }) {
  if (!hypothesis.limitations?.length) return null;
  return (
    <div data-testid={`explorer-limitations-${hypothesis.hypothesis_id}`}>
      <p className="font-mono text-[10px] text-slate-500 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
        <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0" />
        Limitations
      </p>
      <ul className="flex flex-col gap-1.5">
        {hypothesis.limitations.map((l, i) => (
          <li key={i} className="flex items-start gap-2 text-xs">
            <Info
              className={`w-3 h-3 shrink-0 mt-0.5 ${LIMITATION_TYPE_STYLES[l.type] ?? "text-slate-600"}`}
            />
            <span className={LIMITATION_TYPE_STYLES[l.type] ?? "text-slate-400"}>
              {l.description}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A single evidence reference row — clickable for provenance. */
function EvidenceRefRow({ ref: evidRef, isSelected, onSelect, listName }) {
  const cfg = LIST_CONFIG[listName] ?? LIST_CONFIG.non_discriminating_evidence;
  return (
    <button
      data-testid={`explorer-ref-${evidRef.evidence_id}`}
      aria-label={`Show provenance for ${evidRef.evidence_id}`}
      aria-pressed={isSelected}
      onClick={() => onSelect(evidRef.evidence_id)}
      className={`w-full text-left flex flex-col gap-1.5 p-2.5 rounded border transition-colors
        hover:brightness-110
        ${isSelected
          ? `${cfg.bgColor} ${cfg.borderColor} ring-1 ring-white/20`
          : `bg-slate-800/40 border-slate-700`
        }`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Search className="w-3 h-3 text-slate-500 shrink-0" />
        <span className={`font-mono text-xs font-semibold ${cfg.headingColor}`}>
          {evidRef.evidence_id}
        </span>
        <span className={`font-mono text-[10px] px-1.5 py-0.5 rounded ${cfg.chipStyle}`}>
          {evidRef.relationship}
        </span>
      </div>
      {evidRef.interpretation && (
        <p className="text-slate-400 text-xs leading-relaxed italic pl-5">
          {evidRef.interpretation}
        </p>
      )}
    </button>
  );
}

/**
 * Environmental context section — amber visual treatment, mandatory disclaimer.
 * Must never be labelled as supporting, confirming, or causal.
 */
function EnvironmentalContextSection({ refs, selectedId, onSelect, visible }) {
  if (!visible) return null;
  const cfg = LIST_CONFIG.environmental_context;
  return (
    <section
      data-testid="explorer-list-environmental_context"
      className={`rounded-lg border ${cfg.borderColor} ${cfg.bgColor} p-3 flex flex-col gap-2`}
    >
      <div className="flex items-center justify-between flex-wrap gap-2">
        <span className={`font-mono text-xs font-semibold uppercase tracking-wider ${cfg.headingColor}`}>
          {cfg.label}
          <span className="ml-1.5 font-mono text-[9px] px-1 py-0.5 rounded bg-slate-700 text-slate-400 border border-slate-600">
            {refs.length}
          </span>
        </span>
        {/* Mandatory disclaimer — never removed */}
        <span
          data-testid="explorer-env-context-disclaimer"
          className="font-mono text-[10px] text-amber-500/80 italic"
        >
          {cfg.disclaimer}
        </span>
      </div>
      {refs.length === 0 ? (
        <p className="text-slate-600 text-xs italic font-mono">
          No environmental context records for this hypothesis.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {refs.map((r) => (
            <EvidenceRefRow
              key={r.evidence_id}
              ref={r}
              isSelected={selectedId === r.evidence_id}
              onSelect={onSelect}
              listName="environmental_context"
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** Generic relationship list section for supporting, contradicting, non-discriminating. */
function RelationshipListSection({ listName, refs, selectedId, onSelect, visible }) {
  if (!visible) return null;
  const cfg = LIST_CONFIG[listName] ?? LIST_CONFIG.non_discriminating_evidence;
  return (
    <section
      data-testid={`explorer-list-${listName}`}
      className="flex flex-col gap-2"
    >
      <div className="flex items-center gap-2">
        <span className={`font-mono text-[10px] uppercase tracking-wider font-semibold ${cfg.headingColor} border-b border-slate-700 pb-1 w-full`}>
          {cfg.label}
          <span className="ml-1.5 font-mono text-[9px] px-1 py-0.5 rounded bg-slate-700 text-slate-400 border border-slate-600 normal-case">
            {refs.length}
          </span>
        </span>
      </div>
      {refs.length === 0 ? (
        <p className="text-slate-600 text-xs italic font-mono">
          None for this hypothesis.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {refs.map((r) => (
            <EvidenceRefRow
              key={r.evidence_id}
              ref={r}
              isSelected={selectedId === r.evidence_id}
              onSelect={onSelect}
              listName={listName}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** H4 zero-evidence empty state. */
function H4EmptyState({ limitations }) {
  return (
    <div
      data-testid="h4-empty-state"
      className="flex flex-col gap-3 p-4 rounded-lg border border-slate-700 bg-slate-800/40"
    >
      <p className="font-mono text-xs text-slate-400">
        No evidence relationships available.
      </p>
      <p className="text-slate-500 text-xs leading-relaxed">
        This hypothesis cannot be evaluated from the available dataset — ground-segment
        and RF-link data are absent.
      </p>
      {limitations?.length > 0 && (
        <div className="pt-2 border-t border-slate-700">
          <p className="font-mono text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">
            Limitations
          </p>
          <ul className="flex flex-col gap-1.5">
            {limitations.map((l, i) => (
              <li key={i} className="flex items-start gap-2 text-xs">
                <Info className={`w-3 h-3 shrink-0 mt-0.5 ${LIMITATION_TYPE_STYLES[l.type] ?? "text-slate-600"}`} />
                <span className={LIMITATION_TYPE_STYLES[l.type] ?? "text-slate-400"}>
                  {l.description}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Inline provenance panel — uses explorer-prov-* test IDs. */
function ExplorerProvenancePanel({ provenanceData, reportHypotheses }) {
  if (!provenanceData) return null;

  if (provenanceData._fetchError) {
    return (
      <div
        data-testid="explorer-provenance-panel"
        className="bg-slate-800/80 rounded-lg border border-red-800 p-3"
      >
        <p className="text-red-400 text-xs font-mono" data-testid="explorer-prov-error">
          Provenance lookup failed — explorer view remains intact.
        </p>
      </div>
    );
  }

  if (!provenanceData.found) {
    return (
      <div
        data-testid="explorer-provenance-panel"
        className="bg-slate-800/80 rounded-lg border border-slate-600 p-3"
      >
        <p className="text-slate-500 text-xs italic font-mono" data-testid="explorer-prov-not-found">
          Evidence ID {provenanceData.evidence_id} not found in timeline.
        </p>
      </div>
    );
  }

  const assessmentById = {};
  for (const h of reportHypotheses ?? []) {
    assessmentById[h.hypothesis_id] = h.assessment;
  }

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

  const rels = provenanceData.hypothesis_relationships ?? [];

  return (
    <div
      data-testid="explorer-provenance-panel"
      className="bg-slate-800/80 rounded-lg border border-slate-600 p-4 flex flex-col gap-4"
    >
      <p className="font-mono text-[10px] text-slate-400 uppercase tracking-widest border-b border-slate-700 pb-1.5">
        Evidence Provenance — {provenanceData.evidence_id}
      </p>

      {/* 12 raw evidence fields */}
      <div>
        <p className="font-mono text-[10px] text-slate-500 uppercase tracking-wider mb-2">Record</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-xs">
          <dt className="text-slate-500">Evidence ID</dt>
          <dd className="text-slate-200" data-testid="explorer-prov-evidence-id">{provenanceData.evidence_id}</dd>

          <dt className="text-slate-500">Timestamp</dt>
          <dd className="text-slate-200" data-testid="explorer-prov-timestamp">{provenanceData.timestamp ?? "—"}</dd>

          <dt className="text-slate-500">Source</dt>
          <dd className="text-slate-200" data-testid="explorer-prov-source">{provenanceData.source ?? "—"}</dd>

          <dt className="text-slate-500">Measurement</dt>
          <dd className="text-slate-200" data-testid="explorer-prov-measurement">{provenanceData.measurement ?? "—"}</dd>

          <dt className="text-slate-500">Value</dt>
          <dd className="text-slate-200" data-testid="explorer-prov-value">
            {provenanceData.value != null ? `${provenanceData.value}` : "—"}
            {provenanceData.unit
              ? <span className="text-slate-500 ml-1" data-testid="explorer-prov-unit">{provenanceData.unit}</span>
              : null}
          </dd>

          <dt className="text-slate-500">Resolution</dt>
          <dd className="text-slate-300" data-testid="explorer-prov-resolution">{provenanceData.resolution ?? "—"}</dd>

          <dt className="text-slate-500">Dataset</dt>
          <dd className="text-slate-300" data-testid="explorer-prov-dataset-id">{provenanceData.dataset_id ?? "—"}</dd>

          <dt className="text-slate-500">Provider</dt>
          <dd className="text-slate-300" data-testid="explorer-prov-provider">{provenanceData.provider ?? "—"}</dd>

          <dt className="text-slate-500">Variable</dt>
          <dd className="text-slate-300" data-testid="explorer-prov-variable">{provenanceData.variable ?? "—"}</dd>

          <dt className="text-slate-500">Evidence type</dt>
          <dd className="text-slate-300" data-testid="explorer-prov-evidence-type">{provenanceData.evidence_type ?? "—"}</dd>

          <dt className="text-slate-500">Quality</dt>
          <dd className="text-slate-300" data-testid="explorer-prov-quality">{provenanceData.quality ?? "—"}</dd>
        </dl>
      </div>

      {/* Hypothesis relationships */}
      <div className="pt-2 border-t border-slate-700">
        <p className="font-mono text-[10px] text-slate-500 uppercase tracking-wider mb-2">
          Hypothesis Relationships
        </p>
        {rels.length === 0 ? (
          <p className="text-slate-600 text-xs italic font-mono" data-testid="explorer-prov-no-relationships">
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
                  data-testid={`explorer-prov-rel-${rel.hypothesis_id}`}
                  className="flex flex-col gap-1 pl-2 border-l border-slate-700"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-slate-200">{rel.hypothesis_id}</span>
                    {assessment && (
                      <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${getAssessmentColor(assessment)}`}>
                        {getAssessmentLabel(assessment)}
                      </span>
                    )}
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${listStyle}`}>
                      {listLabel}
                    </span>
                  </div>
                  <span className="font-mono text-[10px] text-slate-500">{rel.relationship}</span>
                  {rel.interpretation && (
                    <p className="text-slate-300 text-xs leading-relaxed italic">{rel.interpretation}</p>
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

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * EvidenceGraphExplorer
 *
 * Investigator-facing evidence relationship explorer.
 * Reads the evidence graph from the backend (via prop) and renders
 * hypothesis → relationship list → evidence ref hierarchically.
 *
 * No assessments are re-derived; all scientific judgements come from
 * the backend API responses.
 *
 * Props:
 *   evidenceGraph  — evidence graph from GET /evidence-graph
 *   forensicReport — validated report from GET /forensic-analysis
 *                    (used for assessment badges and per-hypothesis forensic summaries)
 */
export default function EvidenceGraphExplorer({ evidenceGraph, forensicReport }) {
  const hypotheses = evidenceGraph?.hypotheses ?? [];

  // Assessment lookup from the forensic report (do not re-derive)
  const assessmentById = useMemo(() => {
    const map = {};
    for (const h of forensicReport?.hypotheses ?? []) {
      map[h.hypothesis_id] = h;
    }
    return map;
  }, [forensicReport]);

  const [activeHypothesisId, setActiveHypothesisId] = useState(
    hypotheses[0]?.hypothesis_id ?? null
  );
  const [activeFilters, setActiveFilters] = useState(
    new Set(RELATIONSHIP_LIST_NAMES) // all on by default
  );
  const [selectedRefId,    setSelectedRefId]    = useState(null);
  const [provenanceResult, setProvenanceResult] = useState(null);

  const activeGraphHypothesis = hypotheses.find((h) => h.hypothesis_id === activeHypothesisId);
  // Forensic-report hypothesis carries the authoritative assessment + limitations + heuristic_note
  const activeReportHypothesis = assessmentById[activeHypothesisId];

  // Merge: use graph for evidence refs; report for assessment/limitations/heuristic_note
  // If report is absent, fall back to graph data
  const activeHypothesis = useMemo(() => {
    if (!activeGraphHypothesis) return null;
    const reportH = activeReportHypothesis ?? {};
    return {
      ...activeGraphHypothesis,
      assessment:    reportH.assessment    ?? activeGraphHypothesis.assessment,
      limitations:   reportH.limitations   ?? activeGraphHypothesis.limitations   ?? [],
      heuristic_note: reportH.heuristic_note ?? activeGraphHypothesis.heuristic_note ?? null,
    };
  }, [activeGraphHypothesis, activeReportHypothesis]);

  // Derive the flat list of hypotheses for the tab bar (with assessments from report)
  const tabHypotheses = useMemo(() => (
    hypotheses.map((h) => ({
      ...h,
      assessment: assessmentById[h.hypothesis_id]?.assessment ?? h.assessment,
    }))
  ), [hypotheses, assessmentById]);

  // Toggle a relationship filter chip
  function handleFilterToggle(name) {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  // Switch hypothesis tab — clears selection and provenance
  function handleHypothesisSelect(id) {
    setActiveHypothesisId(id);
    setSelectedRefId(null);
    setProvenanceResult(null);
  }

  // Click evidence ref — toggle + async provenance fetch
  const handleRefSelect = useCallback((id) => {
    setSelectedRefId((prev) => {
      if (prev === id) {
        setProvenanceResult(null);
        return null;
      }
      fetchEvidenceProvenance("galaxy-15", id)
        .then((data) => setProvenanceResult(data))
        .catch(() => setProvenanceResult({ _fetchError: true }));
      return id;
    });
  }, []);

  // Detect H4-style: all four lists empty
  const allListsEmpty = useMemo(() => {
    if (!activeHypothesis) return false;
    return RELATIONSHIP_LIST_NAMES.every(
      (name) => (activeHypothesis[name] ?? []).length === 0
    );
  }, [activeHypothesis]);

  if (!evidenceGraph) {
    return (
      <div
        data-testid="evidence-graph-explorer"
        className="bg-slate-900 rounded-xl p-6 border border-slate-700"
      >
        <p
          data-testid="evidence-graph-loading"
          className="text-slate-500 font-mono text-sm"
        >
          Loading evidence graph…
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid="evidence-graph-explorer"
      className="bg-slate-900 rounded-xl border border-slate-700 flex flex-col overflow-hidden"
    >
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="px-5 py-4 border-b border-slate-700 flex items-center gap-3">
        <GitBranch className="w-4 h-4 text-slate-400 shrink-0" />
        <h2 className="font-mono text-sm font-semibold text-slate-200 uppercase tracking-wider">
          Evidence Graph Explorer
        </h2>
      </div>

      <div className="px-5 py-4 flex flex-col gap-5">

        {/* ── Hypothesis tabs ──────────────────────────────────────────────── */}
        <HypothesisTabs
          hypotheses={tabHypotheses}
          activeId={activeHypothesisId}
          onSelect={handleHypothesisSelect}
        />

        {/* ── Relationship filter ──────────────────────────────────────────── */}
        <RelationshipFilter
          activeFilters={activeFilters}
          onToggle={handleFilterToggle}
        />

        {/* ── Active hypothesis content ────────────────────────────────────── */}
        {activeHypothesis && (
          <div
            data-testid="explorer-active-hypothesis"
            className="flex flex-col gap-4"
          >
            {/* Assessment + label + heuristic note */}
            <HypothesisAssessmentHeader hypothesis={activeHypothesis} />

            {/* Limitations (always visible) */}
            <HypothesisLimitations hypothesis={activeHypothesis} />

            {/* H4-style empty state when all lists are empty */}
            {allListsEmpty ? (
              <H4EmptyState limitations={activeHypothesis.limitations} />
            ) : (
              <div className="flex flex-col gap-4">

                {/* Environmental context — MUST remain visually separate */}
                <EnvironmentalContextSection
                  refs={activeHypothesis.environmental_context ?? []}
                  selectedId={selectedRefId}
                  onSelect={handleRefSelect}
                  visible={activeFilters.has("environmental_context")}
                />

                {/* Supporting evidence */}
                <RelationshipListSection
                  listName="supporting_evidence"
                  refs={activeHypothesis.supporting_evidence ?? []}
                  selectedId={selectedRefId}
                  onSelect={handleRefSelect}
                  visible={activeFilters.has("supporting_evidence")}
                />

                {/* Contradicting evidence */}
                <RelationshipListSection
                  listName="contradicting_evidence"
                  refs={activeHypothesis.contradicting_evidence ?? []}
                  selectedId={selectedRefId}
                  onSelect={handleRefSelect}
                  visible={activeFilters.has("contradicting_evidence")}
                />

                {/* Non-discriminating evidence */}
                <RelationshipListSection
                  listName="non_discriminating_evidence"
                  refs={activeHypothesis.non_discriminating_evidence ?? []}
                  selectedId={selectedRefId}
                  onSelect={handleRefSelect}
                  visible={activeFilters.has("non_discriminating_evidence")}
                />

              </div>
            )}

            {/* ── Provenance panel ────────────────────────────────────────── */}
            {selectedRefId && (
              provenanceResult ? (
                <ExplorerProvenancePanel
                  provenanceData={provenanceResult}
                  reportHypotheses={forensicReport?.hypotheses}
                />
              ) : (
                <p
                  className="text-slate-600 text-xs italic font-mono"
                  data-testid="explorer-prov-loading"
                >
                  Loading provenance for {selectedRefId}…
                </p>
              )
            )}

          </div>
        )}

      </div>
    </div>
  );
}
