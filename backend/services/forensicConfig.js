'use strict';

// ---------------------------------------------------------------------------
// forensicConfig.js — Shared forensic pipeline configuration constants
//
// IMPORTANT: These constants define the operational parameters of the
// evidence-selection pipeline.  They must not be changed without a
// corresponding update to tests and documentation.
//
// FC-1  FORENSIC_TEMPORAL_WINDOW_MINUTES is an evidence-selection heuristic.
//       It defines the ±N-minute band around the anomaly anchor within which
//       environmental measurements are considered temporally proximate and
//       eligible for inclusion in a hypothesis's environmental_context list.
//
// FC-2  This window is NOT a scientifically calibrated causal threshold.
//       Temporal proximity is a necessary condition for initial evidence
//       selection, not a sufficient condition for causal attribution.
//
// FC-3  Per-case hypotheses.json may override the default via
//       heuristic_window_minutes.  This default is used when no per-case
//       override is present.
// ---------------------------------------------------------------------------

/**
 * Default ±N-minute evidence-selection band used by buildEvidenceGraph.
 *
 * Evidence-selection heuristic — NOT a scientifically calibrated causal threshold.
 */
const FORENSIC_TEMPORAL_WINDOW_MINUTES = 10;

module.exports = { FORENSIC_TEMPORAL_WINDOW_MINUTES };
