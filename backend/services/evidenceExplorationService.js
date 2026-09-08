'use strict';

// ---------------------------------------------------------------------------
// evidenceExplorationService.js — Phase 10.1
//
// Evidence Exploration Contract — a read-only service that composes the lower-
// level exploration primitives (evidenceExploration.js, getEvidenceProvenance)
// into a single cohesive API surface.
//
// DESIGN PRINCIPLES
//   • The evidence CSV (rows) and the evidence graph remain the sole source of
//     truth.  This service does not duplicate, cache, or shadow them.
//   • All returned objects are shallow copies; the original row arrays and
//     graph structures are never mutated.
//   • Callers supply pre-loaded rows and graph.  Loading is the caller's
//     responsibility (parseEvidenceCSV + buildEvidenceGraph).  This keeps
//     the service synchronous and testable without I/O.
//
// SERVICE INVARIANTS (carry forward from Phase 7.3 EX-1 … EX-10)
//   SI-1   No function in this service writes, adds, or removes evidence rows.
//   SI-2   Every returned evidence item carries the evidence_id verbatim from
//          the source rows array.
//   SI-3   environmental_context is always returned in a separate field from
//          supporting_evidence.  They are never merged.
//   SI-4   contradicting_evidence is always returned in a separate field.
//   SI-5   non_discriminating_evidence is always returned in a separate field.
//   SI-6   EPHEMERIS records are excluded from hypothesis evidence lists
//          (enforced upstream by buildEvidenceGraph; this service does not
//          re-introduce them).
//   SI-7   No temporal proximity inference — all relationships come from the
//          graph's explicit hypothesis lists.
//   SI-8   No numerical probabilities, confidence scores, or percentages are
//          produced by any method.
//   SI-9   Hypothesis assessments are never modified or re-derived; they are
//          passed through verbatim from the graph.
//   SI-10  Cross-case exploration is prohibited.  Every method validates that
//          the rows belong to the same case as the graph.
//   SI-11  causal_attribution_established is never set, modified, or established
//          by this service.  It is only passed through verbatim when present
//          on the graph object.
//   SI-12  environmental_context records are never converted into or merged
//          with supporting_evidence.
//   SI-13  Evidence IDs are never modified or synthesised.
//   SI-14  Filtering never creates new evidence records; it only narrows the
//          view of existing ones.
// ---------------------------------------------------------------------------

const {
  resolveEvidenceRecord,
  buildHypothesisEvidenceView,
  buildCaseEvidenceIndex,
  buildEnvironmentalContextSummary,
  compareHypothesesEvidence,
  EVIDENCE_LISTS,
  LIST_LABELS,
  HEURISTIC_WINDOW_LABEL,
} = require('./evidenceExploration');

const { getEvidenceProvenance } = require('./forensicAnalysis');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validate that rows and graph share the same case_id (SI-10).
 * Returns an error descriptor if they do not match, or null if they match.
 * @param {string} caseId
 * @param {object} graph
 * @returns {{ error_code: string, error: string }|null}
 */
function _validateCaseId(caseId, graph) {
  if (!caseId || typeof caseId !== 'string') {
    return { error_code: 'INVALID_CASE_ID', error: 'caseId must be a non-empty string.' };
  }
  if (!graph || graph.case_id !== caseId) {
    return {
      error_code: 'CASE_MISMATCH',
      error: `Graph case_id ("${graph && graph.case_id}") does not match requested caseId ("${caseId}"). ` +
             'Cross-case exploration is prohibited (SI-10).',
    };
  }
  return null;
}

/**
 * Return a shallow copy of a row, enforcing read-only contract (SI-1, SI-2).
 * @param {object} row
 * @returns {object}
 */
function _copyRow(row) {
  return {
    evidence_id:   row.evidence_id,
    timestamp:     row.timestamp,
    source:        row.source,
    measurement:   row.measurement,
    value:         row.value,
    unit:          row.unit,
    resolution:    row.resolution,
    dataset_id:    row.dataset_id,
    provider:      row.provider,
    variable:      row.variable,
    evidence_type: row.evidence_type,
    quality:       row.quality,
  };
}

// ---------------------------------------------------------------------------
// getEvidenceByCaseId(caseId, rows, graph)
//
// Returns all evidence rows for the case.  This is the top-level "case" tier
// in the exploration hierarchy.
//
// Returned shape:
//   {
//     case_id:                        string,
//     causal_attribution_established: boolean,   // verbatim passthrough (SI-11)
//     evidence_count:                 number,
//     evidence:                       EvidenceRecord[],  // all rows, copies
//   }
//
// SI-1:  read-only — every returned record is a copy.
// SI-2:  every evidence_id is verbatim from the rows array.
// SI-10: caseId is validated against graph.case_id.
// SI-11: causal_attribution_established passed through verbatim.
// ---------------------------------------------------------------------------
function getEvidenceByCaseId(caseId, rows, graph) {
  const mismatch = _validateCaseId(caseId, graph);
  if (mismatch) return mismatch;

  return {
    case_id:                        caseId,
    causal_attribution_established: graph.causal_attribution_established,  // SI-11
    evidence_count:                 rows.length,
    evidence:                       rows.map(_copyRow),
  };
}

// ---------------------------------------------------------------------------
// getEvidenceById(caseId, evidenceId, rows, graph)
//
// Returns the single evidence record matching evidenceId.  Uses the existing
// resolveEvidenceRecord primitive for the record look-up, and
// getEvidenceProvenance for graph-level relationships.
//
// Returned shape (found):
//   {
//     found:                    true,
//     evidence_id:              string,
//     <12 evidence fields>,
//     hypothesis_relationships: HypothesisRelationship[],
//   }
//
// Returned shape (not found):
//   {
//     found:        false,
//     evidence_id:  string,
//     reason:       string,
//   }
//
// SI-1:  read-only.
// SI-2:  evidence_id is verbatim.
// SI-10: caseId validated against graph.
// ---------------------------------------------------------------------------
function getEvidenceById(caseId, evidenceId, rows, graph) {
  const mismatch = _validateCaseId(caseId, graph);
  if (mismatch) return mismatch;

  if (!evidenceId || typeof evidenceId !== 'string') {
    return { error_code: 'INVALID_EVIDENCE_ID', error: 'evidenceId must be a non-empty string.' };
  }

  // Delegate to getEvidenceProvenance which already handles the 12-field
  // copy + hypothesis_relationships scan + duplicate detection (F24).
  return getEvidenceProvenance(caseId, evidenceId, rows, graph);
}

// ---------------------------------------------------------------------------
// filterBySource(caseId, source, rows, graph)
//
// Returns all evidence rows whose `source` field equals the given source string.
//
// Returned shape:
//   {
//     case_id:        string,
//     source:         string,
//     evidence_count: number,
//     evidence:       EvidenceRecord[],
//   }
//
// SI-1:  read-only copies.
// SI-10: caseId validated.
// SI-14: filtering never creates records; it only narrows.
// ---------------------------------------------------------------------------
function filterBySource(caseId, source, rows, graph) {
  const mismatch = _validateCaseId(caseId, graph);
  if (mismatch) return mismatch;

  if (!source || typeof source !== 'string') {
    return { error_code: 'INVALID_FILTER', error: 'source must be a non-empty string.' };
  }

  const filtered = rows.filter((r) => r.source === source).map(_copyRow);
  return {
    case_id:        caseId,
    source,
    evidence_count: filtered.length,
    evidence:       filtered,
  };
}

// ---------------------------------------------------------------------------
// filterByMeasurementType(caseId, measurement, rows, graph)
//
// Returns all evidence rows whose `measurement` field equals the given string.
// Also supports filtering by `evidence_type` when the caller passes an
// evidence_type value that matches the classification produced by
// evidenceType() in server.js (e.g. 'case_event', 'environmental_observation').
//
// Parameters:
//   measurement — exact string to match against row.measurement (primary filter)
//   evidence_type — if provided AND measurement is null/undefined, filters by
//                   row.evidence_type instead.
//
// At least one of measurement or evidence_type must be provided.
//
// Returned shape:
//   {
//     case_id:        string,
//     filter:         { measurement?, evidence_type? },
//     evidence_count: number,
//     evidence:       EvidenceRecord[],
//   }
//
// SI-1:  read-only copies.
// SI-10: caseId validated.
// SI-14: filtering narrows only.
// ---------------------------------------------------------------------------
function filterByMeasurementType(caseId, { measurement, evidence_type } = {}, rows, graph) {
  const mismatch = _validateCaseId(caseId, graph);
  if (mismatch) return mismatch;

  if (!measurement && !evidence_type) {
    return {
      error_code: 'INVALID_FILTER',
      error: 'At least one of measurement or evidence_type must be provided.',
    };
  }

  let filtered;
  if (measurement) {
    filtered = rows.filter((r) => r.measurement === measurement);
  } else {
    filtered = rows.filter((r) => r.evidence_type === evidence_type);
  }

  return {
    case_id:        caseId,
    filter:         Object.fromEntries(
      Object.entries({ measurement, evidence_type }).filter(([, v]) => v != null),
    ),
    evidence_count: filtered.length,
    evidence:       filtered.map(_copyRow),
  };
}

// ---------------------------------------------------------------------------
// filterByTimeWindow(caseId, { from, to }, rows, graph)
//
// Returns evidence rows whose `timestamp` falls within [from, to] (inclusive).
// Both bounds are ISO 8601 strings.  from and to are both optional:
//   • from only  → records at or after from
//   • to only    → records at or before to
//   • both       → records within the closed interval
//
// IMPORTANT: this function performs a simple timestamp string comparison
// (ISO 8601 strings are lexicographically sortable).  It is NOT re-applying
// the ±10-minute heuristic from buildEvidenceGraph; it is a general-purpose
// time-range filter over the full evidence set.  No causal inference is drawn
// from the resulting set (SI-7, SI-11).
//
// Returned shape:
//   {
//     case_id:        string,
//     filter:         { from?, to? },
//     evidence_count: number,
//     evidence:       EvidenceRecord[],
//     temporal_note:  string,   // always present — reminds caller this is NOT causal
//   }
//
// SI-1:  read-only copies.
// SI-7:  no temporal proximity inference.
// SI-10: caseId validated.
// SI-14: narrows only.
// ---------------------------------------------------------------------------
const TEMPORAL_FILTER_NOTE =
  'Time-window filter narrows the evidence set by timestamp only. ' +
  'Temporal proximity is not a causal relationship. ' +
  'No causal attribution is established by this filter (SI-7, SI-11).';

function filterByTimeWindow(caseId, { from, to } = {}, rows, graph) {
  const mismatch = _validateCaseId(caseId, graph);
  if (mismatch) return mismatch;

  if (!from && !to) {
    return {
      error_code: 'INVALID_FILTER',
      error: 'At least one of from or to must be provided.',
    };
  }

  let filtered = rows;
  if (from) {
    filtered = filtered.filter((r) => r.timestamp >= from);
  }
  if (to) {
    filtered = filtered.filter((r) => r.timestamp <= to);
  }

  return {
    case_id:        caseId,
    filter:         Object.fromEntries(
      Object.entries({ from, to }).filter(([, v]) => v != null),
    ),
    evidence_count: filtered.length,
    evidence:       filtered.map(_copyRow),
    temporal_note:  TEMPORAL_FILTER_NOTE,
  };
}

// ---------------------------------------------------------------------------
// getAnomalyCenteredEvidence(caseId, anomalyTimestamp, windowMinutes, rows, graph)
//
// Returns evidence records within ±windowMinutes of the given anomalyTimestamp.
// This is a read-only filtering convenience; it does NOT re-run buildEvidenceGraph
// or alter the graph's existing environmental_context assignments (SI-7, SI-12).
//
// The result includes ALL evidence types (including EPHEMERIS), because this is
// a raw temporal slice of the timeline — not a hypothesis-linked view.
//
// The heuristic note is always included so the caller is reminded that temporal
// proximity is an evidence-selection heuristic, not a causal threshold.
//
// Parameters:
//   anomalyTimestamp — ISO 8601 string; the focal point
//   windowMinutes    — number > 0; the ±N window around the anomaly
//
// Returned shape:
//   {
//     case_id:              string,
//     anomaly_timestamp:    string,
//     window_minutes:       number,
//     heuristic_window_note: string,  // always present
//     evidence_count:       number,
//     evidence:             EvidenceRecord[],
//   }
//
// SI-1:  read-only.
// SI-7:  no causal inference — heuristic note always present.
// SI-11: causal_attribution_established is NOT set by this function.
// SI-12: environmental_context assignments in the graph are not touched.
// ---------------------------------------------------------------------------
function getAnomalyCenteredEvidence(caseId, anomalyTimestamp, windowMinutes, rows, graph) {
  const mismatch = _validateCaseId(caseId, graph);
  if (mismatch) return mismatch;

  if (!anomalyTimestamp || typeof anomalyTimestamp !== 'string') {
    return {
      error_code: 'INVALID_FILTER',
      error: 'anomalyTimestamp must be a non-empty ISO 8601 string.',
    };
  }

  const windowMins = Number(windowMinutes);
  if (!Number.isFinite(windowMins) || windowMins <= 0) {
    return {
      error_code: 'INVALID_FILTER',
      error: 'windowMinutes must be a positive number.',
    };
  }

  const anchorMs  = new Date(anomalyTimestamp).getTime();
  const windowMs  = windowMins * 60 * 1000;

  const filtered = rows.filter((r) => {
    const rowMs = new Date(r.timestamp).getTime();
    return Math.abs(rowMs - anchorMs) <= windowMs;
  });

  return {
    case_id:               caseId,
    anomaly_timestamp:     anomalyTimestamp,
    window_minutes:        windowMins,
    heuristic_window_note: HEURISTIC_WINDOW_LABEL,
    evidence_count:        filtered.length,
    evidence:              filtered.map(_copyRow),
  };
}

// ---------------------------------------------------------------------------
// getHypothesisLinkedEvidence(caseId, hypothesisId, rows, graph)
//
// Returns the full structured evidence view for a single hypothesis using the
// existing buildHypothesisEvidenceView primitive.
//
// The four evidence lists are always kept separate (SI-3, SI-4, SI-5).
// Assessments are verbatim (SI-9).  EPHEMERIS records are absent (SI-6).
//
// Returned shape: see buildHypothesisEvidenceView in evidenceExploration.js
// Plus a top-level error descriptor when the hypothesis is not found.
//
// SI-3/4/5: four lists separate.
// SI-6: EPHEMERIS absent.
// SI-9: assessment verbatim.
// SI-10: caseId validated.
// ---------------------------------------------------------------------------
function getHypothesisLinkedEvidence(caseId, hypothesisId, rows, graph) {
  const mismatch = _validateCaseId(caseId, graph);
  if (mismatch) return mismatch;

  if (!hypothesisId || typeof hypothesisId !== 'string') {
    return { error_code: 'INVALID_HYPOTHESIS_ID', error: 'hypothesisId must be a non-empty string.' };
  }

  const graphHypothesis = (graph.hypotheses || []).find(
    (h) => h.hypothesis_id === hypothesisId,
  );

  if (!graphHypothesis) {
    return {
      error_code: 'HYPOTHESIS_NOT_FOUND',
      error: `Hypothesis "${hypothesisId}" not found in case "${caseId}".`,
    };
  }

  return buildHypothesisEvidenceView(graphHypothesis, rows);
}

// ---------------------------------------------------------------------------
// getProvenanceLookup(caseId, evidenceId, rows, graph)
//
// Returns the full provenance record for a single evidence ID:
//   - All 12 evidence fields from the timeline row
//   - hypothesis_relationships: entries across all four lists, all hypotheses
//
// Delegates to getEvidenceProvenance (forensicAnalysis.js) which also enforces
// the duplicate-triple validation (throws ForensicAnalysisValidationError).
//
// EPHEMERIS records resolve with found: true and hypothesis_relationships: []
// (as in F22).  Unknown IDs return { found: false }.
//
// This is explicitly a read-only lookup (SI-1).  The result does not alter
// causal_attribution_established (SI-11).
//
// SI-1:  read-only.
// SI-2:  evidence_id verbatim.
// SI-10: caseId validated.
// SI-11: causal_attribution not touched.
// ---------------------------------------------------------------------------
function getProvenanceLookup(caseId, evidenceId, rows, graph) {
  const mismatch = _validateCaseId(caseId, graph);
  if (mismatch) return mismatch;

  if (!evidenceId || typeof evidenceId !== 'string') {
    return { error_code: 'INVALID_EVIDENCE_ID', error: 'evidenceId must be a non-empty string.' };
  }

  return getEvidenceProvenance(caseId, evidenceId, rows, graph);
}

// ---------------------------------------------------------------------------
// getCaseEvidenceIndex(caseId, rows, graph)
//
// Returns a flat index of every evidence record referenced in the graph, each
// annotated with its hypothesis_relationships.  Delegates to
// buildCaseEvidenceIndex (evidenceExploration.js).
//
// SI-1:  read-only.
// SI-6:  EPHEMERIS absent (enforced upstream).
// SI-10: caseId validated.
// ---------------------------------------------------------------------------
function getCaseEvidenceIndex(caseId, rows, graph) {
  const mismatch = _validateCaseId(caseId, graph);
  if (mismatch) return mismatch;

  const index = buildCaseEvidenceIndex(graph, rows);
  return {
    case_id:        caseId,
    evidence_count: index.length,
    evidence:       index,
  };
}

// ---------------------------------------------------------------------------
// getEnvironmentalContextSummary(caseId, rows, graph)
//
// Returns the consolidated environmental context view across all hypotheses.
// Always includes the heuristic_window_note (SI-7).  Delegates to
// buildEnvironmentalContextSummary (evidenceExploration.js).
//
// SI-3:  env context strictly separated from supporting_evidence.
// SI-7:  heuristic note always present.
// SI-10: caseId validated.
// SI-12: env context not converted into supporting_evidence.
// ---------------------------------------------------------------------------
function getEnvironmentalContextSummary(caseId, rows, graph) {
  const mismatch = _validateCaseId(caseId, graph);
  if (mismatch) return mismatch;

  const summary = buildEnvironmentalContextSummary(graph, rows);
  return { case_id: caseId, ...summary };
}

// ---------------------------------------------------------------------------
// compareHypothesesEvidenceForCase(caseId, rows, graph, hypothesisIds)
//
// Compares evidence profiles across hypotheses within a single case.
// Cross-case comparison is blocked (SI-10).  Delegates to
// compareHypothesesEvidence (evidenceExploration.js).
//
// SI-9:  assessments verbatim.
// SI-10: single-case only.
// SI-11: causal_attribution_established verbatim passthrough.
// ---------------------------------------------------------------------------
function compareHypothesesEvidenceForCase(caseId, rows, graph, hypothesisIds) {
  const mismatch = _validateCaseId(caseId, graph);
  if (mismatch) return mismatch;

  return compareHypothesesEvidence(graph, rows, hypothesisIds);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  // Primary exploration entry points
  getEvidenceByCaseId,
  getEvidenceById,
  filterBySource,
  filterByMeasurementType,
  filterByTimeWindow,
  getAnomalyCenteredEvidence,
  getHypothesisLinkedEvidence,
  getProvenanceLookup,
  // Compound views
  getCaseEvidenceIndex,
  getEnvironmentalContextSummary,
  compareHypothesesEvidenceForCase,
  // Exposed constants (for tests)
  TEMPORAL_FILTER_NOTE,
};
