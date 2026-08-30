import { useState, useMemo, useCallback } from "react";
import {
  AlertTriangle,
  Info,
  Search,
  Shield,
} from "lucide-react";
import { getAssessmentLabel, getAssessmentColor } from "../utils/assessmentLabels";
import { fetchEvidenceProvenance } from "../api";

// ── Visual treatment constants ─────────────────────────────────────────────────

// Environmental context gets a distinct amber treatment — it is NOT supporting evidence.
const ENV_CONTEXT_STYLE =
  "border-l-2 border-amber-600 bg-amber-950/20 rounded-r";

const EVIDENCE_CATEGORY_STYLES = {
  supporting:        "bg-cyan-900/40 text-cyan-300 border border-cyan-800",
  contradicting:     "bg-red-900/40 text-red-300 border border-red-800",
  non_discriminating:"bg-slate-700 text-slate-400 border border-slate-600",
};

const LIMITATION_TYPE_STYLES = {
  unresolved:        "text-amber-400",
  proxy_measurement: "text-orange-400",
  missing_data:      "text-red-400",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build a flat map: evidence_id → interpretation text
 * from all four relationship lists across all hypotheses in the evidence graph.
 */
export function buildInterpretationMap(evidenceGraph) {
  const map = {};
  if (!evidenceGraph?.hypotheses) return map;
  const LISTS = [
    "environmental_context",
    "supporting_evidence",
    "contradicting_evidence",
    "non_discriminating_evidence",
  ];
  for (const h of evidenceGraph.hypotheses) {
    for (const listName of LISTS) {
      for (const entry of h[listName] || []) {
        if (entry.evidence_id && entry.interpretation) {
          // Later entries overwrite earlier ones — all interpretations for a given
          // evidence_id should be consistent across hypotheses.
          map[entry.evidence_id] = entry.interpretation;
        }
      }
    }
  }
  return map;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SectionHeading({ children, icon: Icon }) {
  return (
    <h3 className="flex items-center gap-2 font-mono text-xs font-bold text-cyan-400 uppercase tracking-widest border-b border-slate-700 pb-1.5 mb-3">
      {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />}
      {children}
    </h3>
  );
}

/**
 * Causal Attribution Banner — always prominent at the top of the view.
 */
function CausalAttributionBanner({ established }) {
  const label  = established ? "ESTABLISHED" : "NOT ESTABLISHED";
  const colors = established
    ? "bg-green-950 border-green-700 text-green-300"
    : "bg-red-950/60 border-red-700 text-red-300";

  return (
    <div
      data-testid="causal-attribution-banner"
      className={`flex items-center gap-3 px-4 py-3 rounded-lg border font-mono ${colors}`}
    >
      <Shield className="w-4 h-4 shrink-0" />
      <div className="flex flex-col gap-0.5">
        <span className="text-[10px] text-slate-400 uppercase tracking-widest">
          Causal Attribution
        </span>
        <span className="text-sm font-bold tracking-wider">{label}</span>
      </div>
    </div>
  );
}

/**
 * Clickable evidence ID chip — triggers provenance display.
 */
function EvidenceChip({ evidenceId, category, selected, onClick }) {
  const colorClass = EVIDENCE_CATEGORY_STYLES[category] ?? EVIDENCE_CATEGORY_STYLES.non_discriminating;
  const selectedRing = selected ? " ring-1 ring-white/40" : "";

  return (
    <button
      data-testid={`evidence-chip-${evidenceId}`}
      onClick={() => onClick(evidenceId)}
      className={`inline-flex items-center gap-1 font-mono text-[10px] px-1.5 py-0.5 rounded transition-colors hover:brightness-125 ${colorClass}${selectedRing}`}
      aria-label={`Show provenance for ${evidenceId}`}
    >
      <Search className="w-2.5 h-2.5 shrink-0" />
      {evidenceId}
    </button>
  );
}

/**
 * Renders a list of evidence IDs as clickable chips.
 * Environmental context IDs are rendered via EnvContextList instead.
 */
function EvidenceIdList({ ids, category, selectedEvidenceId, onSelect }) {
  if (!ids?.length) {
    return (
      <p className="text-slate-600 text-xs italic font-mono">None for this hypothesis.</p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5" data-testid={`evidence-list-${category}`}>
      {ids.map((id) => (
        <EvidenceChip
          key={id}
          evidenceId={id}
          category={category}
          selected={selectedEvidenceId === id}
          onClick={onSelect}
        />
      ))}
    </div>
  );
}

/**
 * Environmental context list — distinct amber treatment.
 * IDs are also clickable for provenance but the section itself is visually separated.
 */
function EnvContextList({ ids, selectedEvidenceId, onSelect }) {
  if (!ids?.length) {
    return (
      <p className="text-slate-600 text-xs italic font-mono">
        No environmental context records for this hypothesis.
      </p>
    );
  }
  return (
    <div
      data-testid="env-context-list"
      className={`p-3 flex flex-col gap-2 ${ENV_CONTEXT_STYLE}`}
    >
      <p className="font-mono text-[10px] text-amber-500 uppercase tracking-wider">
        Environmental context — not supporting evidence
      </p>
      <div className="flex flex-wrap gap-1.5">
        {ids.map((id) => (
          <button
            key={id}
            data-testid={`env-chip-${id}`}
            onClick={() => onSelect(id)}
            className={`inline-flex items-center gap-1 font-mono text-[10px] px-1.5 py-0.5 rounded
                        bg-amber-900/40 text-amber-300 border border-amber-700
                        transition-colors hover:bg-amber-900/70
                        ${selectedEvidenceId === id ? "ring-1 ring-white/40" : ""}`}
            aria-label={`Show provenance for ${id}`}
          >
            <Search className="w-2.5 h-2.5 shrink-0" />
            {id}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Evidence Provenance Detail Panel — shown when an evidence ID is selected.
 */
// Human-readable labels for the four evidence relationship list names.
const LIST_NAME_LABELS = {
  environmental_context:      "Environmental context",
  supporting_evidence:        "Supporting evidence",
  contradicting_evidence:     "Contradicting evidence",
  non_discriminating_evidence:"Non-discriminating",
};

// CSS class sets for each list name — reuses EVIDENCE_CATEGORY_STYLES where possible.
const LIST_NAME_STYLES = {
  environmental_context:       "bg-amber-900/40 text-amber-300 border border-amber-700",
  supporting_evidence:         EVIDENCE_CATEGORY_STYLES.supporting,
  contradicting_evidence:      EVIDENCE_CATEGORY_STYLES.contradicting,
  non_discriminating_evidence: EVIDENCE_CATEGORY_STYLES.non_discriminating,
};

/**
 * Evidence Provenance Detail Panel — shown when an evidence ID is selected.
 *
 * Props:
 *   provenanceData  — result from fetchEvidenceProvenance (may be null while loading,
 *                     or an error sentinel object { _fetchError: true })
 *   reportHypotheses — report.hypotheses array, used for assessment badge lookup
 */
function ProvenancePanel({ provenanceData, reportHypotheses }) {
  // Nothing selected yet
  if (!provenanceData) return null;

  // Network / server error
  if (provenanceData._fetchError) {
    return (
      <div
        data-testid="provenance-panel"
        className="bg-slate-800/80 rounded-lg border border-red-800 p-4"
      >
        <p className="text-red-400 text-xs font-mono" data-testid="prov-error">
          Provenance lookup failed — investigation view remains intact.
        </p>
      </div>
    );
  }

  // Evidence ID not found in timeline
  if (!provenanceData.found) {
    return (
      <div
        data-testid="provenance-panel"
        className="bg-slate-800/80 rounded-lg border border-slate-600 p-4"
      >
        <p className="text-slate-500 text-xs italic font-mono" data-testid="prov-not-found">
          Evidence ID {provenanceData.evidence_id} not found in timeline.
        </p>
      </div>
    );
  }

  // Build a quick assessment lookup from the report hypotheses array
  const assessmentById = {};
  for (const h of reportHypotheses ?? []) {
    assessmentById[h.hypothesis_id] = h.assessment;
  }

  const rels = provenanceData.hypothesis_relationships ?? [];

  return (
    <div
      data-testid="provenance-panel"
      className="bg-slate-800/80 rounded-lg border border-slate-600 p-4 flex flex-col gap-4"
    >
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <p className="font-mono text-[10px] text-slate-400 uppercase tracking-widest border-b border-slate-700 pb-1.5">
        Evidence Provenance — {provenanceData.evidence_id}
      </p>

      {/* ── Raw evidence fields (12 fields) ─────────────────────────────── */}
      <div>
        <p className="font-mono text-[10px] text-slate-500 uppercase tracking-wider mb-2">
          Record
        </p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-xs">
          <dt className="text-slate-500">Evidence ID</dt>
          <dd className="text-slate-200" data-testid="prov-evidence-id">
            {provenanceData.evidence_id}
          </dd>

          <dt className="text-slate-500">Timestamp</dt>
          <dd className="text-slate-200" data-testid="prov-timestamp">
            {provenanceData.timestamp ?? "—"}
          </dd>

          <dt className="text-slate-500">Source</dt>
          <dd className="text-slate-200" data-testid="prov-source">
            {provenanceData.source ?? "—"}
          </dd>

          <dt className="text-slate-500">Measurement</dt>
          <dd className="text-slate-200" data-testid="prov-measurement">
            {provenanceData.measurement ?? "—"}
          </dd>

          <dt className="text-slate-500">Value</dt>
          <dd className="text-slate-200" data-testid="prov-value">
            {provenanceData.value != null ? `${provenanceData.value}` : "—"}
            {provenanceData.unit
              ? <span className="text-slate-500 ml-1" data-testid="prov-unit">{provenanceData.unit}</span>
              : null}
          </dd>

          <dt className="text-slate-500">Resolution</dt>
          <dd className="text-slate-300" data-testid="prov-resolution">
            {provenanceData.resolution ?? "—"}
          </dd>

          <dt className="text-slate-500">Dataset</dt>
          <dd className="text-slate-300" data-testid="prov-dataset-id">
            {provenanceData.dataset_id ?? "—"}
          </dd>

          <dt className="text-slate-500">Provider</dt>
          <dd className="text-slate-300" data-testid="prov-provider">
            {provenanceData.provider ?? "—"}
          </dd>

          <dt className="text-slate-500">Variable</dt>
          <dd className="text-slate-300" data-testid="prov-variable">
            {provenanceData.variable ?? "—"}
          </dd>

          <dt className="text-slate-500">Evidence type</dt>
          <dd className="text-slate-300" data-testid="prov-evidence-type">
            {provenanceData.evidence_type ?? "—"}
          </dd>

          <dt className="text-slate-500">Quality</dt>
          <dd className="text-slate-300" data-testid="prov-quality">
            {provenanceData.quality ?? "—"}
          </dd>
        </dl>
      </div>

      {/* ── Hypothesis Relationships ─────────────────────────────────────── */}
      <div className="pt-2 border-t border-slate-700">
        <p className="font-mono text-[10px] text-slate-500 uppercase tracking-wider mb-2">
          Hypothesis Relationships
        </p>

        {rels.length === 0 ? (
          <p
            className="text-slate-600 text-xs italic font-mono"
            data-testid="prov-no-relationships"
          >
            No hypothesis relationships — record not cited in any hypothesis.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {rels.map((rel) => {
              const assessment = assessmentById[rel.hypothesis_id];
              const listLabel  = LIST_NAME_LABELS[rel.list_name] ?? rel.list_name;
              const listStyle  = LIST_NAME_STYLES[rel.list_name] ?? EVIDENCE_CATEGORY_STYLES.non_discriminating;
              return (
                <div
                  key={`${rel.hypothesis_id}-${rel.list_name}`}
                  data-testid={`prov-relationship-${rel.hypothesis_id}`}
                  className="flex flex-col gap-1 pl-2 border-l border-slate-700"
                >
                  {/* Hypothesis ID + assessment badge */}
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-slate-200">
                      {rel.hypothesis_id}
                    </span>
                    {assessment && (
                      <span
                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${getAssessmentColor(assessment)}`}
                      >
                        {getAssessmentLabel(assessment)}
                      </span>
                    )}
                    {/* Relationship type label */}
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${listStyle}`}
                      data-testid={`prov-list-name-${rel.hypothesis_id}`}
                    >
                      {listLabel}
                    </span>
                  </div>
                  {/* Relationship label */}
                  <span
                    className="font-mono text-[10px] text-slate-500"
                    data-testid={`prov-rel-label-${rel.hypothesis_id}`}
                  >
                    {rel.relationship}
                  </span>
                  {/* Interpretation */}
                  {rel.interpretation && (
                    <p
                      className="text-slate-300 text-xs leading-relaxed italic"
                      data-testid={`prov-rel-interpretation-${rel.hypothesis_id}`}
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

/**
 * Hypothesis selector tab strip.
 */
function HypothesisTabs({ hypotheses, activeId, onSelect }) {
  return (
    <div className="flex gap-1 flex-wrap" role="tablist" aria-label="Hypothesis selection">
      {hypotheses.map((h) => {
        const isActive = h.hypothesis_id === activeId;
        const colorClass = getAssessmentColor(h.assessment);
        return (
          <button
            key={h.hypothesis_id}
            role="tab"
            aria-selected={isActive}
            data-testid={`tab-${h.hypothesis_id}`}
            onClick={() => onSelect(h.hypothesis_id)}
            className={`font-mono text-xs px-3 py-1.5 rounded border transition-colors
                        ${isActive
                          ? `${colorClass} opacity-100`
                          : "bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-700"}`}
          >
            {h.hypothesis_id}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Renders key observations for the active hypothesis comparison entry.
 * Limitations are rendered separately (always visible) in the per-hypothesis panel.
 */
function HypothesisComparisonDetail({ entry }) {
  if (!entry) return null;

  return (
    <div className="mt-3 flex flex-col gap-3">
      {entry.key_observations?.length > 0 && (
        <div>
          <p className="font-mono text-[10px] text-slate-500 uppercase tracking-wider mb-1">
            Key observations
          </p>
          <ul className="flex flex-col gap-1">
            {entry.key_observations.map((obs, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-slate-300">
                <span className="text-slate-600 shrink-0 mt-0.5">·</span>
                <span>{obs}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Small count badge shown beside section headings.
 */
function CountBadge({ count }) {
  if (count == null) return null;
  return (
    <span className="ml-1 font-mono text-[9px] px-1 py-0.5 rounded bg-slate-700 text-slate-400 border border-slate-600">
      {count}
    </span>
  );
}

/**
 * Heuristic / methodological note block for a hypothesis.
 * Only rendered when note is a non-empty string.
 */
function HeuristicNote({ note }) {
  if (!note) return null;
  return (
    <div
      data-testid="hypothesis-heuristic-note"
      className="p-3 rounded border border-amber-800/50 bg-amber-950/20"
    >
      <p className="font-mono text-[10px] text-amber-500 uppercase tracking-wider mb-1">
        Methodological note
      </p>
      <p className="text-amber-200/80 text-xs leading-relaxed">{note}</p>
    </div>
  );
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * ForensicInvestigationView
 *
 * Renders the full forensic investigation report from the backend's
 * ValidatedForensicReport. Does not perform any forensic logic —
 * all scientific judgements come from the API response.
 *
 * Props:
 *   report        — ValidatedForensicReport from GET /forensic-analysis
 *   timelineData  — evidence record array from GET /timeline
 *   evidenceGraph — evidence graph from GET /evidence-graph (for interpretation text)
 */
export default function ForensicInvestigationView({ report, timelineData, evidenceGraph, error }) {
  const [activeHypothesisId, setActiveHypothesisId] = useState(
    report?.hypotheses?.[0]?.hypothesis_id ?? null
  );
  const [selectedEvidenceId, setSelectedEvidenceId] = useState(null);
  // provenanceResult: null | { _fetchError: true } | provenance API response object
  const [provenanceResult, setProvenanceResult] = useState(null);

  // evidenceById kept for any future local use; interpretationMap kept for its own tests.
  const evidenceById = useMemo(() => {
    if (!timelineData?.length) return {};
    return Object.fromEntries(timelineData.map((r) => [r.evidence_id, r]));
  }, [timelineData]);

  const interpretationMap = useMemo(
    () => buildInterpretationMap(evidenceGraph),
    [evidenceGraph]
  );

  // ── Error state — API call failed ──────────────────────────────────────────
  if (error) {
    return (
      <div
        data-testid="forensic-investigation-view"
        className="bg-slate-900 rounded-xl p-6 border border-red-800 flex items-center justify-center min-h-[120px]"
      >
        <div
          data-testid="forensic-investigation-error"
          className="flex flex-col items-center gap-2 text-center"
        >
          <AlertTriangle className="w-5 h-5 text-red-400" />
          <p className="text-red-400 font-mono text-sm font-semibold">
            Forensic analysis unavailable
          </p>
          <p className="text-slate-500 font-mono text-xs">
            {typeof error === "string" ? error : "The API returned an error. No scientific conclusions can be displayed."}
          </p>
        </div>
      </div>
    );
  }

  // ── Loading state — report not yet received ─────────────────────────────────
  if (!report) {
    return (
      <div
        data-testid="forensic-investigation-view"
        className="bg-slate-900 rounded-xl p-6 border border-slate-700 flex items-center justify-center min-h-[120px]"
      >
        <p
          data-testid="forensic-investigation-loading"
          className="text-slate-500 font-mono text-sm text-center"
        >
          Loading forensic investigation…
        </p>
      </div>
    );
  }

  // ── Unavailable report — API responded but returned no hypotheses ───────────
  if (!report.hypotheses?.length) {
    return (
      <div
        data-testid="forensic-investigation-view"
        className="bg-slate-900 rounded-xl p-6 border border-slate-700 flex items-center justify-center min-h-[120px]"
      >
        <p
          data-testid="forensic-investigation-unavailable"
          className="text-slate-500 font-mono text-sm text-center"
        >
          Forensic report is unavailable or contains no hypotheses.
        </p>
      </div>
    );
  }

  const hypotheses       = report.hypotheses ?? [];
  const limitations      = report.limitations ?? [];
  const narrative        = report.analyst_narrative;
  const event            = report.event;
  const comparisonEntries = report.hypothesis_comparison ?? [];

  const activeHypothesis = hypotheses.find((h) => h.hypothesis_id === activeHypothesisId);
  const activeComparison = comparisonEntries.find((e) => e.hypothesis_id === activeHypothesisId);
  const es               = activeHypothesis?.evidence_summary;

  const handleEvidenceSelect = useCallback((id) => {
    setSelectedEvidenceId((prev) => {
      if (prev === id) {
        // Toggle off
        setProvenanceResult(null);
        return null;
      }
      // Fetch provenance asynchronously; set result when resolved
      fetchEvidenceProvenance("galaxy-15", id)
        .then((data) => setProvenanceResult(data))
        .catch(() => setProvenanceResult({ _fetchError: true }));
      return id;
    });
  }, []);

  function handleTabChange(id) {
    setActiveHypothesisId(id);
    setSelectedEvidenceId(null);
    setProvenanceResult(null);
  }

  return (
    <div
      data-testid="forensic-investigation-view"
      className="bg-slate-900 rounded-xl border border-slate-700 flex flex-col gap-0 overflow-hidden"
    >
      {/* ── View header ───────────────────────────────────────────────────────── */}
      <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between gap-4">
        <h2 className="font-mono text-sm font-semibold text-slate-200 uppercase tracking-wider">
          Forensic Investigation
        </h2>
        {narrative && (
          <span
            data-testid="source-badge"
            className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
              narrative.source === "llm"
                ? "bg-blue-900/60 text-blue-300 border-blue-700"
                : "bg-slate-700 text-slate-300 border-slate-500"
            }`}
          >
            {narrative.source === "llm" ? "LLM" : "Heuristic"}
          </span>
        )}
      </div>

      <div className="px-5 py-5 flex flex-col gap-7">

        {/* ── Section 1: Event Summary ─────────────────────────────────────────── */}
        {event && (
          <section data-testid="section-event-summary">
            <SectionHeading icon={Info}>Event Summary</SectionHeading>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-xs">
              <dt className="text-slate-500">Anchor event</dt>
              <dd className="text-amber-400">{event.timestamp}</dd>
              {event.description && (
                <>
                  <dt className="text-slate-500 col-span-2 mt-1">Description</dt>
                  <dd className="col-span-2 text-slate-300 leading-relaxed">{event.description}</dd>
                </>
              )}
              {event.recovery_event && (
                <>
                  <dt className="text-slate-500">Recovery</dt>
                  <dd className="text-green-400">{event.recovery_event.timestamp}</dd>
                </>
              )}
            </dl>
          </section>
        )}

        {/* ── Section 2: Causal Attribution Status ────────────────────────────── */}
        <section data-testid="section-causal-attribution">
          <SectionHeading icon={Shield}>Causal Attribution Status</SectionHeading>
          <CausalAttributionBanner established={report.causal_attribution_established} />
        </section>

        {/* ── Section 3: Hypothesis Comparison ────────────────────────────────── */}
        <section data-testid="section-hypothesis-comparison">
          <SectionHeading>Hypothesis Comparison</SectionHeading>
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-xs border-collapse">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400 uppercase tracking-wider text-[10px]">
                  <th className="text-left pb-2 pr-4 w-12">ID</th>
                  <th className="text-left pb-2 pr-4">Hypothesis</th>
                  <th className="text-right pb-2 w-36">Assessment</th>
                </tr>
              </thead>
              <tbody>
                {hypotheses.map((h) => (
                  <tr
                    key={h.hypothesis_id}
                    data-testid={`hypothesis-row-${h.hypothesis_id}`}
                    className="border-b border-slate-800"
                  >
                    <td className="py-2 pr-4 text-slate-500 font-bold">{h.hypothesis_id}</td>
                    <td className="py-2 pr-4 text-slate-200">{h.label}</td>
                    <td className="py-2 text-right">
                      <span
                        data-testid={`assessment-${h.hypothesis_id}`}
                        className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded border ${getAssessmentColor(h.assessment)}`}
                      >
                        {getAssessmentLabel(h.assessment)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* ── Hypothesis tabs (sections 4–7 are per-hypothesis) ───────────────── */}
        <div className="flex flex-col gap-4">
          <HypothesisTabs
            hypotheses={hypotheses}
            activeId={activeHypothesisId}
            onSelect={handleTabChange}
          />

          {activeHypothesis && (
            <div className="flex flex-col gap-5">

              {/* Active hypothesis header */}
              <div className="flex items-center gap-3">
                <span className="font-mono text-xs text-slate-300 font-semibold">
                  {activeHypothesis.hypothesis_id} — {activeHypothesis.label}
                </span>
                <span
                  className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded border ${getAssessmentColor(activeHypothesis.assessment)}`}
                >
                  {getAssessmentLabel(activeHypothesis.assessment)}
                </span>
              </div>

              {/* Comparison key observations */}
              {activeComparison && (
                <HypothesisComparisonDetail entry={activeComparison} />
              )}

              {/* ── Per-hypothesis limitations (always visible) ───────────────── */}
              {activeHypothesis.limitations?.length > 0 && (
                <section data-testid="section-hypothesis-limitations">
                  <SectionHeading icon={AlertTriangle}>Limitations for this hypothesis</SectionHeading>
                  <ul className="flex flex-col gap-2">
                    {activeHypothesis.limitations.map((l, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs">
                        <Info
                          className={`w-3 h-3 shrink-0 mt-0.5 ${
                            LIMITATION_TYPE_STYLES[l.type] ?? "text-slate-600"
                          }`}
                        />
                        <span className={LIMITATION_TYPE_STYLES[l.type] ?? "text-slate-400"}>
                          {l.description}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* ── Methodological note (when present) ───────────────────────── */}
              <HeuristicNote note={activeHypothesis.heuristic_note} />

              {/* ── Section 4: Environmental Context ──────────────────────────── */}
              <section data-testid="section-environmental-context">
                <SectionHeading>
                  Environmental Context
                  <CountBadge count={es?.environmental_context_count} />
                </SectionHeading>
                <EnvContextList
                  ids={es?.environmental_context_ids}
                  selectedEvidenceId={selectedEvidenceId}
                  onSelect={handleEvidenceSelect}
                />
              </section>

              {/* ── Section 5: Supporting Evidence ────────────────────────────── */}
              <section data-testid="section-supporting-evidence">
                <SectionHeading>
                  Supporting Evidence
                  <CountBadge count={es?.supporting_evidence_count} />
                </SectionHeading>
                <EvidenceIdList
                  ids={es?.supporting_evidence_ids}
                  category="supporting"
                  selectedEvidenceId={selectedEvidenceId}
                  onSelect={handleEvidenceSelect}
                />
              </section>

              {/* ── Section 6: Contradicting Evidence ─────────────────────────── */}
              <section data-testid="section-contradicting-evidence">
                <SectionHeading>
                  Contradicting Evidence
                  <CountBadge count={es?.contradicting_evidence_count} />
                </SectionHeading>
                <EvidenceIdList
                  ids={es?.contradicting_evidence_ids}
                  category="contradicting"
                  selectedEvidenceId={selectedEvidenceId}
                  onSelect={handleEvidenceSelect}
                />
              </section>

              {/* ── Section 7: Non-Discriminating Evidence ────────────────────── */}
              <section data-testid="section-non-discriminating">
                <SectionHeading>
                  Non-Discriminating Evidence
                  <CountBadge count={es?.non_discriminating_evidence_count} />
                </SectionHeading>
                <EvidenceIdList
                  ids={es?.non_discriminating_evidence_ids}
                  category="non_discriminating"
                  selectedEvidenceId={selectedEvidenceId}
                  onSelect={handleEvidenceSelect}
                />
              </section>

              {/* ── Section 9: Evidence Provenance ────────────────────────────── */}
              <section data-testid="section-provenance">
                <SectionHeading icon={Search}>Evidence Provenance</SectionHeading>
                {selectedEvidenceId ? (
                  provenanceResult ? (
                    <ProvenancePanel
                      provenanceData={provenanceResult}
                      reportHypotheses={hypotheses}
                    />
                  ) : (
                    <p className="text-slate-600 text-xs italic font-mono" data-testid="prov-loading">
                      Loading provenance for {selectedEvidenceId}…
                    </p>
                  )
                ) : (
                  <p className="text-slate-600 text-xs italic font-mono">
                    Select an evidence ID above to view its provenance record.
                  </p>
                )}
              </section>

            </div>
          )}
        </div>

        {/* ── Section 8: Limitations ──────────────────────────────────────────── */}
        <section data-testid="section-limitations">
          <SectionHeading icon={AlertTriangle}>Limitations</SectionHeading>
          {limitations.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {limitations.map((l, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <Info
                    className={`w-3 h-3 shrink-0 mt-0.5 ${
                      LIMITATION_TYPE_STYLES[l.type]
                        ? LIMITATION_TYPE_STYLES[l.type].replace("text-", "text-")
                        : "text-slate-600"
                    }`}
                  />
                  <span className={LIMITATION_TYPE_STYLES[l.type] ?? "text-slate-400"}>
                    {l.description}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-slate-600 text-xs italic font-mono">No limitations recorded.</p>
          )}
        </section>

        {/* ── Section 10: AI Executive Summary ────────────────────────────────── */}
        {narrative && (
          <section data-testid="section-executive-summary">
            <SectionHeading>AI-Generated Executive Summary</SectionHeading>

            <div className="flex flex-col gap-4">
              {/* Source + attribution */}
              <div className="flex items-center gap-2">
                <span
                  data-testid="executive-source-badge"
                  className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                    narrative.source === "llm"
                      ? "bg-blue-900/60 text-blue-300 border-blue-700"
                      : "bg-slate-700 text-slate-300 border-slate-500"
                  }`}
                >
                  {narrative.source === "llm" ? "LLM" : "Heuristic"}
                </span>
                <span className="font-mono text-[10px] text-slate-500">
                  {narrative.generated_at}
                </span>
              </div>

              {/* Causal attribution re-stated — never omitted */}
              <div className="font-mono text-[10px] text-slate-500">
                Causal attribution:{" "}
                <span className="text-amber-400 font-semibold">
                  {narrative.causal_attribution_established
                    ? "Established"
                    : "Not established"}
                </span>
              </div>

              {/* Event description */}
              {narrative.event_description && (
                <div>
                  <p className="font-mono text-[10px] text-slate-500 uppercase tracking-wider mb-1">
                    Event Description
                  </p>
                  <p className="text-slate-300 text-xs leading-relaxed">
                    {narrative.event_description}
                  </p>
                </div>
              )}

              {/* Investigation summary */}
              {narrative.investigation_summary && (
                <div>
                  <p className="font-mono text-[10px] text-slate-500 uppercase tracking-wider mb-1">
                    Investigation Summary
                  </p>
                  <blockquote
                    data-testid="executive-summary-text"
                    className="border-l-2 border-cyan-700 pl-3 text-slate-300 text-xs leading-relaxed italic"
                  >
                    {narrative.investigation_summary}
                  </blockquote>
                </div>
              )}

              {/* Notable limitations from narrative */}
              {narrative.notable_limitations && (
                <div>
                  <p className="font-mono text-[10px] text-slate-500 uppercase tracking-wider mb-1">
                    Notable Limitations
                  </p>
                  <p className="text-slate-400 text-xs leading-relaxed italic">
                    {narrative.notable_limitations}
                  </p>
                </div>
              )}
            </div>
          </section>
        )}

      </div>
    </div>
  );
}
