'use strict';

/**
 * pipelineLogger — lightweight structured diagnostics for the forensic pipeline.
 *
 * Every log entry is a single-line JSON object written to stdout via
 * console.log.  The shape is:
 *
 *   {
 *     ts:        ISO 8601 timestamp
 *     level:     "info" | "warn" | "error"
 *     stage:     one of the PIPELINE_STAGES values
 *     case_id:   string
 *     ...fields  stage-specific safe fields (see below)
 *   }
 *
 * Fields that are NEVER logged:
 *   - raw evidence rows or any row content
 *   - full AI prompts or responses
 *   - API keys, secrets, credentials, or env-var values
 *   - full forensic reports or analysis objects
 *   - stack traces
 *   - filesystem paths
 */

// ---------------------------------------------------------------------------
// Stage constants — used both here and in tests for assertion clarity.
// ---------------------------------------------------------------------------
const PIPELINE_STAGES = Object.freeze({
  EVIDENCE_INGESTION  : 'evidence_ingestion',
  EVIDENCE_GRAPH      : 'evidence_graph',
  FORENSIC_ANALYSIS   : 'forensic_analysis',
  AI_NARRATIVE        : 'ai_narrative',
  AI_VALIDATION       : 'ai_validation',
  REPORT_ASSEMBLY     : 'report_assembly',
  PIPELINE_COMPLETE   : 'pipeline_complete',
  PIPELINE_ERROR      : 'pipeline_error',
});

// ---------------------------------------------------------------------------
// pipelineLog(entry)
//
// Writes a single structured log line to stdout.  `entry` must include at
// minimum `level`, `stage`, and `case_id`.  All other fields are passed
// through as-is; callers are responsible for including only safe fields.
// ---------------------------------------------------------------------------
function pipelineLog(entry) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}

// ---------------------------------------------------------------------------
// startTimer()
//
// Returns a function that, when called, returns elapsed milliseconds as an
// integer.  Used to capture per-stage duration_ms without Date arithmetic
// scattered across the caller.
// ---------------------------------------------------------------------------
function startTimer() {
  const t0 = Date.now();
  return () => Date.now() - t0;
}

module.exports = { pipelineLog, startTimer, PIPELINE_STAGES };
