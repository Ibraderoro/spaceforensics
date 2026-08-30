'use strict';

require('dotenv').config();

// ---------------------------------------------------------------------------
// Phase 4.6 — AI Analyst Layer
//
// generateAnalystNarrative(analysis, validIds)
//   Receives the validated deterministic ForensicAnalysis object and a Set
//   of all evidence_ids from the parsed CSV.  Returns a validated
//   AnalystNarrative object.
//
// ARCHITECTURAL RULE:
//   The LLM is an explanation/synthesis layer only.
//   It receives the deterministic ForensicAnalysis object — NOT raw CSV rows.
//   It must not invent evidence, change assessments, or establish causality.
//
// Pipeline position:
//
//   buildForensicAnalysis  ──►  generateAnalystNarrative  ──►  AnalystNarrative
//                                      │
//                         LLM (ChatWatsonx) OR heuristic fallback
//
// Validation invariants (A1–A10) are enforced before any output is returned.
// Unvalidated LLM output is never exposed to API consumers.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LLM client factory — returns a ChatWatsonx instance or null when no key.
// Pattern mirrors aiEngine.js — kept local to avoid cross-service coupling.
// ---------------------------------------------------------------------------
function buildLLMClient() {
  const apikey = process.env.WATSONX_AI_APIKEY;
  if (!apikey) return null;

  const { ChatWatsonx } = require('@langchain/ibm');
  return new ChatWatsonx({
    model       : 'ibm/granite-3-3-8b-instruct',
    watsonxAIApikey : apikey,
    serviceUrl  : process.env.WATSONX_AI_URL || 'https://us-south.ml.cloud.ibm.com',
    projectId   : process.env.WATSONX_AI_PROJECT_ID,
    maxTokens   : 3072,
  });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Phrases that assert causation — the LLM must not use these.
// NOTE: keep phrases specific enough to avoid matching negations such as
// "does not confirm" or "do not confirm that".
const CAUSAL_CERTAINTY_PHRASES = [
  'proves', 'confirms causation', 'is caused by', 'causation established',
  'proof of', 'definitively caused', 'conclusively shows',
  // Additional explicit variants that do not appear inside common negations
  'was the cause of',
  'is the cause of',
  'was responsible for causing',
  'resulted in the failure',
  'resulted in the anomaly',
  'led to the failure',
  'led to the anomaly',
  'triggered the failure',
  'triggered the anomaly',
  'directly caused',
];

// Negation prefixes that cancel a causal-certainty claim.
// Used by the sentence-level negation check below.
const NEGATION_PREFIXES = [
  'not ', 'cannot ', 'can not ', 'did not ', 'does not ', 'do not ',
  'could not ', 'would not ', 'was not ', 'were not ', 'has not ', 'have not ',
  'had not ', 'is not ', 'are not ',
];

// Structural regex for passive-voice "caused by" forms not covered by the phrase list.
//
// Matches positive passive assertions:
//   "was caused by X"       → \bwas\s+caused\s+by\b
//   "has been caused by X"  → \bbeen\s+caused\s+by\b
//   "caused by the …"       → \bcaused\s+by\s+the\b
//   "caused the failure/anomaly/loss"  → \bcaused\s+the\b
//
// Negation guard: matches are filtered at the sentence level by
// sentenceContainsCausalCertainty — not by lookbehind — because indirect
// negation ("does not establish that X caused the anomaly") places "not"
// many words before "caused" and cannot be reliably caught with
// fixed-width lookbehind.
const CAUSAL_CERTAINTY_RE = /\b(?:caused\s+the|caused\s+by|was\s+caused\s+by|been\s+caused\s+by)\b/i;

// Phrases that present environmental-context evidence as direct mechanism
// confirmation — caught by B2.  These are patterns that appear when an LLM
// misrepresents a precondition record as a causal observation.
//
// IMPORTANT: phrases must be specific enough not to match their own negations
// (e.g. "do not confirm" must NOT trigger B2).  Use the positive-assertion form
// only; do not use substrings that appear naturally inside "do not …" clauses.
const MECHANISM_CONFIRMATION_PHRASES = [
  'proves an seu', 'prove an seu',
  'proves the seu', 'prove the seu',
  'an seu was confirmed',
  'demonstrates the mechanism', 'demonstrate the mechanism',
  'confirms a mechanism', 'confirm a mechanism',
  'proves the mechanism', 'prove the mechanism',
  'voltage spike',
  'confirms the failure mode', 'confirm the failure mode',
  'confirms the cause', 'confirm the cause',
];

// Regex to detect numerical probability claims (e.g. "70%", "0.7 probability").
const NUMERICAL_PROBABILITY_RE =
  /\b\d+(\.\d+)?\s*%|\b\d+(\.\d+)?\s*(probability|chance|likelihood)/i;

// Assessment vocabulary — used by validator A5.
const ALLOWED_ASSESSMENTS = new Set([
  'strongly_supported', 'supported', 'mixed', 'weakly_supported', 'insufficient_evidence',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Split text into sentences on '.', '!', '?' and check each sentence
// individually.  A sentence is flagged only when it:
//   (a) matches CAUSAL_CERTAINTY_RE or contains a CAUSAL_CERTAINTY_PHRASE, AND
//   (b) does not contain any NEGATION_PREFIX anywhere in that sentence.
//
// This sentence-level approach catches indirect negation ("does not establish
// that X caused the anomaly") because "does not" appears in the same sentence
// as "caused the", so the sentence is not flagged.
function containsCausalCertainty(text) {
  const lower = (text || '').toLowerCase();

  // Fast path: phrase-list check (phrases that don't appear inside common negations)
  if (CAUSAL_CERTAINTY_PHRASES.some((p) => lower.includes(p))) {
    return true;
  }

  // Sentence-level check for regex patterns (negation-aware)
  const sentences = lower.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
  for (const sentence of sentences) {
    if (CAUSAL_CERTAINTY_RE.test(sentence)) {
      // Allowed if the sentence also contains a negation prefix
      const negated = NEGATION_PREFIXES.some((n) => sentence.includes(n));
      if (!negated) return true;
    }
  }

  return false;
}

function containsMechanismConfirmation(text) {
  const lower = (text || '').toLowerCase();
  return MECHANISM_CONFIRMATION_PHRASES.some((p) => lower.includes(p));
}

function containsNumericalProbability(text) {
  return NUMERICAL_PROBABILITY_RE.test(text || '');
}

// Evidence list names used to build per-hypothesis evidence sets (B1/B2).
const EVIDENCE_LISTS = [
  'environmental_context',
  'supporting_evidence',
  'contradicting_evidence',
  'non_discriminating_evidence',
];

// Fields in which causal certainty and probability checks are applied.
const FREE_TEXT_FIELDS = ['executive_summary', 'event_description'];

// ---------------------------------------------------------------------------
// validateAnalystResponse(parsed, sourceAnalysis, validIds[, graph])
//
// Enforces invariants A1–A10 + B1–B4 against a parsed LLM (or mock) response.
// Returns { valid: boolean, errors: string[] }.
//
// Invariants:
//   A1   executive_summary is a non-empty string
//   A2   event_description is a non-empty string
//   A3   hypothesis_assessments is an array with exactly N entries
//        (one per hypothesis in sourceAnalysis)
//   A4   every hypothesis_id in hypothesis_assessments matches the source
//   A5   every assessment in hypothesis_assessments is unchanged from source
//   A6   every evidence_id in hypothesis_assessments[*].evidence_ids exists
//        in validIds
//   A7   causal_attribution_established matches the source analysis value
//   A8   no causal-certainty language in executive_summary, event_description,
//        or any hypothesis reasoning field
//   A9   strongest_observations, major_uncertainties, missing_evidence are
//        all non-empty arrays of strings
//   A10  no numerical probability claims in free-text fields
//
//   B1   every evidence_id cited for a hypothesis must belong to that
//        hypothesis in the graph (not merely exist in validIds).
//        Requires optional 4th argument `graph`; skipped if absent.
//   B2   no evidence_id that is environmental_context for a hypothesis may
//        appear in that hypothesis's reasoning with mechanism-confirmation
//        language.  Requires `graph`; skipped if absent.
//   B3   per-hypothesis reasoning must not assert causal certainty when
//        causal_attribution_established is false in the source analysis.
//   B4   every hypothesis_id present in sourceAnalysis must appear exactly
//        once in hypothesis_assessments — no hypothesis may be silently omitted.
// ---------------------------------------------------------------------------
function validateAnalystResponse(parsed, sourceAnalysis, validIds, graph) {
  const errors = [];

  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, errors: ['Response is not an object'] };
  }

  // A1 — executive_summary
  if (typeof parsed.executive_summary !== 'string' || parsed.executive_summary.trim() === '') {
    errors.push('A1: executive_summary must be a non-empty string');
  }

  // A2 — event_description
  if (typeof parsed.event_description !== 'string' || parsed.event_description.trim() === '') {
    errors.push('A2: event_description must be a non-empty string');
  }

  // ── Build graph-based lookups (used by B1/B2) ──────────────────────────────
  // Maps hypothesis_id → Set of all evidence_ids belonging to that hypothesis.
  // Maps hypothesis_id → Set of evidence_ids classified as environmental_context.
  const graphEvidenceByHypothesis   = new Map(); // B1
  const graphEnvCtxByHypothesis     = new Map(); // B2
  if (graph && Array.isArray(graph.hypotheses)) {
    for (const gh of graph.hypotheses) {
      const allIds    = new Set();
      const envCtxIds = new Set();
      for (const listName of EVIDENCE_LISTS) {
        for (const ref of (gh[listName] || [])) {
          if (ref.evidence_id) {
            allIds.add(ref.evidence_id);
            if (listName === 'environmental_context') {
              envCtxIds.add(ref.evidence_id);
            }
          }
        }
      }
      graphEvidenceByHypothesis.set(gh.hypothesis_id, allIds);
      graphEnvCtxByHypothesis.set(gh.hypothesis_id, envCtxIds);
    }
  }

  // A3/A4/A5/A6/A8/B1/B2/B3 — hypothesis_assessments
  if (!Array.isArray(parsed.hypothesis_assessments)) {
    errors.push('A3: hypothesis_assessments must be an array');
  } else {
    const expectedIds = new Map(
      sourceAnalysis.hypotheses.map((h) => [h.hypothesis_id, h.assessment]),
    );

    // A3 — count must match
    if (parsed.hypothesis_assessments.length !== sourceAnalysis.hypotheses.length) {
      errors.push(
        `A3: hypothesis_assessments has ${parsed.hypothesis_assessments.length} entries; ` +
        `expected ${sourceAnalysis.hypotheses.length}`,
      );
    }

    // B4 — track which source hypothesis_ids appear in the response
    const seenHypothesisIds = new Set();

    for (const ha of parsed.hypothesis_assessments) {
      const hid = ha.hypothesis_id || '(unknown)';

      // A4 — hypothesis_id must exist in source
      if (!expectedIds.has(ha.hypothesis_id)) {
        errors.push(`A4: unknown hypothesis_id "${hid}" not present in source analysis`);
        continue; // cannot check A5/B1/B2/B3 without a valid id
      }

      seenHypothesisIds.add(ha.hypothesis_id);

      // A5 — assessment must be unchanged
      const expectedAssessment = expectedIds.get(ha.hypothesis_id);
      if (ha.assessment !== expectedAssessment) {
        errors.push(
          `A5: hypothesis ${hid} assessment changed from ` +
          `"${expectedAssessment}" to "${ha.assessment}"`,
        );
      }

      // A5b — assessment must still be in the allowed vocabulary
      if (ha.assessment && !ALLOWED_ASSESSMENTS.has(ha.assessment)) {
        errors.push(`A5: hypothesis ${hid} assessment "${ha.assessment}" is not in the allowed vocabulary`);
      }

      // A6 — evidence_ids must all exist in validIds
      if (Array.isArray(ha.evidence_ids)) {
        for (const eid of ha.evidence_ids) {
          if (!validIds.has(eid)) {
            errors.push(`A6: hypothesis ${hid} references unknown evidence_id "${eid}" (hallucinated)`);
          }
        }
      }

      // A8 — no causal-certainty language in reasoning
      if (containsCausalCertainty(ha.reasoning)) {
        errors.push(`A8: hypothesis ${hid} reasoning contains causal-certainty language`);
      }

      // A10 — no numerical probabilities in reasoning
      if (containsNumericalProbability(ha.reasoning)) {
        errors.push(`A10: hypothesis ${hid} reasoning contains numerical probability claim`);
      }

      // B1 — cited evidence_ids must belong to this hypothesis in the graph
      if (graph && Array.isArray(ha.evidence_ids)) {
        const hypothesisIds = graphEvidenceByHypothesis.get(ha.hypothesis_id);
        if (hypothesisIds) {
          for (const eid of ha.evidence_ids) {
            if (validIds.has(eid) && !hypothesisIds.has(eid)) {
              errors.push(
                `B1: hypothesis ${hid} cites evidence_id "${eid}" which does not ` +
                `belong to this hypothesis in the source graph`,
              );
            }
          }
        }
      }

      // B2 — environmental context IDs must not be presented as mechanism confirmation
      if (graph) {
        const envCtxIds = graphEnvCtxByHypothesis.get(ha.hypothesis_id) || new Set();
        const citedEnvCtxIds = (ha.evidence_ids || []).filter((eid) => envCtxIds.has(eid));
        if (citedEnvCtxIds.length > 0 && containsMechanismConfirmation(ha.reasoning)) {
          errors.push(
            `B2: hypothesis ${hid} reasoning presents environmental context ` +
            `(${citedEnvCtxIds.join(', ')}) as direct mechanism confirmation`,
          );
        }
      }

      // B3 — per-hypothesis reasoning must not assert causal certainty when
      //      causal_attribution_established is false in the source analysis
      if (
        sourceAnalysis.causal_attribution_established === false &&
        containsCausalCertainty(ha.reasoning)
      ) {
        errors.push(
          `B3: hypothesis ${hid} reasoning asserts causal certainty but ` +
          `causal_attribution_established is false in the source analysis`,
        );
      }
    }

    // B4 — every source hypothesis_id must appear in the response
    for (const srcId of expectedIds.keys()) {
      if (!seenHypothesisIds.has(srcId)) {
        errors.push(
          `B4: hypothesis "${srcId}" is present in the source analysis but was ` +
          `silently omitted from hypothesis_assessments`,
        );
      }
    }
  }

  // A7 — causal_attribution_established must match source
  if (parsed.causal_attribution_established !== sourceAnalysis.causal_attribution_established) {
    errors.push(
      `A7: causal_attribution_established is "${parsed.causal_attribution_established}" ` +
      `but source analysis says "${sourceAnalysis.causal_attribution_established}"`,
    );
  }

  // A8 — causal-certainty in top-level free-text fields
  for (const field of FREE_TEXT_FIELDS) {
    if (containsCausalCertainty(parsed[field])) {
      errors.push(`A8: "${field}" contains causal-certainty language`);
    }
  }

  // A9 — strongest_observations, major_uncertainties, missing_evidence
  for (const field of ['strongest_observations', 'major_uncertainties', 'missing_evidence']) {
    if (!Array.isArray(parsed[field]) || parsed[field].length === 0) {
      errors.push(`A9: "${field}" must be a non-empty array`);
    }
  }

  // A10 — numerical probabilities in top-level free-text fields
  for (const field of FREE_TEXT_FIELDS) {
    if (containsNumericalProbability(parsed[field])) {
      errors.push(`A10: "${field}" contains numerical probability claim`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// buildAnalystHeuristicNarrative(analysis)
//
// Deterministic fallback.  Constructs a valid AnalystNarrative entirely from
// the ForensicAnalysis object — no LLM required.
// Returns an object that passes validateAnalystResponse with source:"heuristic".
// ---------------------------------------------------------------------------
function buildAnalystHeuristicNarrative(analysis) {
  const caseId = analysis.case_id || 'unknown';

  // ---- executive_summary ---------------------------------------------------
  const mostSupported = analysis.comparison && analysis.comparison.most_supported;
  const attrClause    = analysis.causal_attribution_established
    ? 'Causal attribution has been established.'
    : 'Causal attribution has not been established from the available evidence.';

  const supportedList  = (analysis.comparison && analysis.comparison.supported_hypotheses) || [];
  const mixedList      = (analysis.comparison && analysis.comparison.mixed_hypotheses)     || [];
  const insuffList     = (analysis.comparison && analysis.comparison.insufficient_hypotheses) || [];

  let summaryParts = [`Forensic analysis of case ${caseId}.`, attrClause];
  if (supportedList.length > 0) {
    summaryParts.push(`Hypothesis ${supportedList.join(', ')} is assessed as supported by the available evidence.`);
  }
  if (mixedList.length > 0) {
    summaryParts.push(`Hypothesis ${mixedList.join(', ')} yields mixed evidence — environmental context exists but no direct mechanism evidence is present.`);
  }
  if (insuffList.length > 0) {
    summaryParts.push(`Hypothesis ${insuffList.join(', ')} cannot be evaluated from this dataset due to absent telemetry.`);
  }
  if (mostSupported) {
    summaryParts.push(`The most supported outcome is hypothesis ${mostSupported}.`);
  }
  const executive_summary = summaryParts.join(' ');

  // ---- event_description ---------------------------------------------------
  let event_description;
  const ev = analysis.event;
  if (ev && ev.timestamp && ev.label) {
    const recoveryClause = (ev.recovery && ev.recovery.timestamp)
      ? ` Autonomous recovery occurred at ${ev.recovery.timestamp}.`
      : '';
    const assetClause = (ev.target_asset && ev.target_asset.name)
      ? ` Target asset: ${ev.target_asset.name}` +
        (ev.target_asset.operator ? ` (operated by ${ev.target_asset.operator})` : '') + '.'
      : '';
    event_description =
      `${ev.label} at ${ev.timestamp}.` +
      (ev.description ? ` ${ev.description}` : '') +
      recoveryClause +
      assetClause;
  } else {
    event_description =
      `Satellite anomaly case ${caseId}. ` +
      `Refer to the deterministic forensic analysis for event details.`;
  }

  // ---- hypothesis_assessments ----------------------------------------------
  const hypothesis_assessments = analysis.hypotheses.map((h) => {
    const s = h.evidence_summary;

    // Collect all evidence IDs referenced for this hypothesis.
    const evidence_ids = [
      ...(s.environmental_context_ids  || []),
      ...(s.supporting_evidence_ids    || []),
      ...(s.contradicting_evidence_ids || []),
      ...(s.non_discriminating_evidence_ids || []),
    ];

    // Reasoning derived from evidence counts and assessment — no causal claims.
    const parts = [];
    if (s.environmental_context_count > 0) {
      parts.push(
        `${s.environmental_context_count} environmental context record(s) establish preconditions contemporaneous with the anomaly; ` +
        `these are precondition indicators, not mechanism confirmation.`,
      );
    }
    if (s.supporting_evidence_count > 0) {
      parts.push(`${s.supporting_evidence_count} record(s) are directly consistent with this hypothesis.`);
    }
    if (s.contradicting_evidence_count > 0) {
      parts.push(`${s.contradicting_evidence_count} record(s) are inconsistent with this hypothesis.`);
    }
    if (s.non_discriminating_evidence_count > 0) {
      parts.push(`${s.non_discriminating_evidence_count} record(s) are consistent with multiple hypotheses and do not discriminate.`);
    }
    if (
      s.environmental_context_count === 0 &&
      s.supporting_evidence_count   === 0 &&
      s.contradicting_evidence_count === 0 &&
      s.non_discriminating_evidence_count === 0
    ) {
      parts.push(`No evidence in this dataset speaks to this hypothesis.`);
    }
    parts.push(`Assessment: ${h.assessment}.`);

    const limitations = (h.limitations || []).map((l) => l.description).filter(Boolean);

    return {
      hypothesis_id : h.hypothesis_id,
      assessment    : h.assessment,
      reasoning     : parts.join(' '),
      evidence_ids,
      limitations   : limitations.length > 0
        ? limitations
        : ['No specific limitations recorded for this hypothesis.'],
    };
  });

  // ---- strongest_observations ----------------------------------------------
  const strongest_observations = [];
  if (supportedList.length > 0) {
    strongest_observations.push(
      `Hypothesis ${supportedList.join(' and ')} is assessed as supported by the available evidence.`,
    );
  }
  if (mixedList.length > 0) {
    strongest_observations.push(
      `Hypotheses ${mixedList.join(' and ')} have environmental context but lack direct mechanism evidence.`,
    );
  }
  if (
    analysis.evidence_summary &&
    analysis.evidence_summary.total_environmental_context > 0
  ) {
    strongest_observations.push(
      `${analysis.evidence_summary.total_environmental_context} environmental context record(s) establish preconditions but do not confirm a causal mechanism.`,
    );
  }
  if (strongest_observations.length === 0) {
    strongest_observations.push(
      `No hypothesis is strongly supported; the evidence is insufficient to attribute causality.`,
    );
  }

  // ---- major_uncertainties -------------------------------------------------
  // Drawn from the aggregate limitations list in the analysis.
  const major_uncertainties = (analysis.limitations || [])
    .map((l) => l.description)
    .filter(Boolean);

  if (major_uncertainties.length === 0) {
    major_uncertainties.push(
      `Insufficient evidence is available to resolve the competing hypotheses. ` +
      `Causal attribution remains undetermined.`,
    );
  }

  // ---- missing_evidence ----------------------------------------------------
  // Derived from hypothesis_comparison entries — insufficient or those with no evidence.
  const missing_evidence = [];
  const seen = new Set();
  for (const h of analysis.hypotheses) {
    if (h.assessment === 'insufficient_evidence') {
      const entry = `Hypothesis ${h.hypothesis_id} (${h.label || h.hypothesis_id}): ` +
        `no telemetry in this dataset addresses this hypothesis.`;
      if (!seen.has(h.hypothesis_id)) {
        seen.add(h.hypothesis_id);
        missing_evidence.push(entry);
      }
    }
    // Also surface limitations that describe missing data.
    for (const lim of (h.limitations || [])) {
      if (
        lim.type === 'missing_data' &&
        lim.description &&
        !seen.has(lim.description)
      ) {
        seen.add(lim.description);
        missing_evidence.push(lim.description);
      }
    }
  }
  if (missing_evidence.length === 0) {
    missing_evidence.push(
      `No specific missing evidence was identified at the hypothesis level; ` +
      `refer to the analysis limitations for dataset gaps.`,
    );
  }

  return {
    executive_summary,
    event_description,
    hypothesis_assessments,
    strongest_observations,
    major_uncertainties,
    missing_evidence,
    causal_attribution_established : analysis.causal_attribution_established,
    source                         : 'heuristic',
    generated_at                   : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// buildAnalystPrompt(analysis, validIds)
//
// Constructs the system + user messages for the LLM call.
// The deterministic analysis object is the ONLY data source sent to the LLM.
// Raw CSV rows are never included.
// ---------------------------------------------------------------------------
function buildAnalystPrompt(analysis, validIds) {
  const validIdList = [...validIds].sort();

  const outputSchema = JSON.stringify({
    executive_summary    : '<one paragraph overview — no causal claims, no probabilities>',
    event_description    : '<one paragraph describing the anomaly event from the event block>',
    hypothesis_assessments: [
      {
        hypothesis_id : '<must match a hypothesis_id from the forensic_analysis>',
        assessment    : '<must be IDENTICAL to the assessment in the forensic_analysis — do not change>',
        reasoning     : '<2–3 sentences explaining the assessment without causal claims>',
        evidence_ids  : ['<evidence_id from valid_evidence_ids — DO NOT invent IDs>'],
        limitations   : ['<one limitation per entry>'],
      },
    ],
    strongest_observations : ['<key analytical observation — no causal claims>'],
    major_uncertainties    : ['<key uncertainty that prevents stronger conclusions>'],
    missing_evidence       : ['<measurement that is absent from the dataset>'],
    causal_attribution_established: false,
  }, null, 2);

  const system = `You are a space-weather forensics analyst. Your task is to explain \
a validated deterministic forensic analysis to a technical audience.

CRITICAL RULES — violating any of these will cause your response to be rejected:
1. The forensic_analysis object provided is AUTHORITATIVE. Do not change any assessment value.
2. environmental_context is NOT mechanism confirmation. It documents preconditions only.
   Do not describe environmental_context records as supporting_evidence.
3. supporting_evidence is the only relationship classified as direct support.
4. Missing telemetry must remain missing. Do not invent measurements, sensor readings,
   or spacecraft data that are absent from the forensic_analysis.
5. Uncertainty must be stated explicitly — distinguish observed, inferred, and unknown.
6. Causal attribution cannot be established unless causal_attribution_established is true
   in the forensic_analysis. For this case it is false — do not claim a cause was found.
7. Do not include numerical probabilities, percentages, or confidence scores anywhere.
8. Only cite evidence_id values from the valid_evidence_ids list. Never invent evidence IDs.
9. Produce ONLY valid JSON matching the schema below — no markdown fences, no prose outside JSON.
10. The causal_attribution_established field in your response must equal the value
    in the forensic_analysis: ${analysis.causal_attribution_established}.

Return exactly this schema:
${outputSchema}`;

  // Trim the analysis to only what the LLM needs to reason about — this avoids
  // sending redundant internal fields and keeps the prompt token-efficient.
  const analysisSummary = {
    case_id                       : analysis.case_id,
    causal_attribution_established: analysis.causal_attribution_established,
    event                         : analysis.event,
    hypotheses                    : analysis.hypotheses.map((h) => ({
      hypothesis_id   : h.hypothesis_id,
      label           : h.label,
      assessment      : h.assessment,
      evidence_summary: h.evidence_summary,
      limitations     : h.limitations,
      heuristic_note  : h.heuristic_note,
    })),
    comparison          : analysis.comparison,
    hypothesis_comparison: analysis.hypothesis_comparison,
    limitations         : analysis.limitations,
  };

  const user = `Explain the following validated forensic analysis. \
Do not change any assessment. Do not establish causality. Do not invent evidence.

forensic_analysis:
${JSON.stringify(analysisSummary, null, 2)}

valid_evidence_ids (only cite IDs from this list):
${JSON.stringify(validIdList)}

Produce the JSON explanation object now.`;

  return { system, user };
}

// ---------------------------------------------------------------------------
// generateAnalystNarrative(analysis, validIds, graph[, _llmFactory])
//
// Primary entry point.  Async.
// Calls the LLM when WATSONX_AI_APIKEY is set; falls back to heuristic
// when the key is absent or the LLM response fails validation.
//
// Parameters:
//   analysis     — validated ForensicAnalysis (output of buildForensicAnalysis)
//   validIds     — Set<string> of evidence_ids from the parsed CSV
//   graph        — EvidenceGraph (for B1/B2 validation)
//   _llmFactory  — optional factory function returning an LLM client or null.
//                  Defaults to buildLLMClient.  Used in tests to inject a
//                  controlled mock without requiring a real Watsonx API key.
//                  The mock must still pass through the full validateAnalystResponse
//                  path — this parameter only controls what .invoke() returns.
// ---------------------------------------------------------------------------
async function generateAnalystNarrative(analysis, validIds, graph, _llmFactory) {
  const llm = (_llmFactory || buildLLMClient)();

  if (llm) {
    try {
      const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
      const prompt   = buildAnalystPrompt(analysis, validIds);
      const response = await llm.invoke([
        new SystemMessage(prompt.system),
        new HumanMessage(prompt.user),
      ]);

      const raw      = typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content);
      const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      const parsed   = JSON.parse(jsonText);

      const { valid, errors } = validateAnalystResponse(parsed, analysis, validIds, graph);
      if (!valid) {
        console.error('[aiAnalyst] LLM response failed validation, using heuristic fallback:', errors);
        throw new Error('validation_failed');
      }

      return {
        ...parsed,
        source      : 'llm',
        generated_at: new Date().toISOString(),
      };
    } catch (err) {
      console.error('[aiAnalyst] LLM error, using heuristic fallback:', err.message);
    }
  }

  return buildAnalystHeuristicNarrative(analysis);
}

// ---------------------------------------------------------------------------
// Phase 7.6 — Investigation Assistance Layer
//
// generateInvestigationAssistance(summary, _llmFactory)
//
//   Receives an already-validated investigation summary (the same object
//   returned by GET …/summary) and returns a structured assistance document
//   covering the seven permitted AI tasks:
//
//     1. findings_summary        — summarise deterministic findings
//     2. evidence_relationships  — explain evidence-to-hypothesis relationships
//     3. limitations_explained   — explain each limitation in plain language
//     4. unanswered_questions    — identify questions the data cannot answer
//     5. challenge_summary       — summarise analyst challenges by status
//     6. additional_evidence_suggestions — categories of evidence to investigate
//     7. observation_inconsistencies     — inconsistencies between analyst
//                                         observations and deterministic analysis
//
// BOUNDARY RULES (mirror of the spec):
//   AI-A  The AI does not modify evidence, create evidence, or alter evidence IDs.
//   AI-B  The AI does not modify hypothesis assessments.
//   AI-C  The AI does not establish causality.
//   AI-D  The AI does not assign numerical probabilities.
//   AI-E  Environmental context is never presented as mechanism evidence.
//   AI-F  Unverified mechanisms are never stated as established.
//   AI-G  The deterministic analysis remains authoritative — the AI is
//         explanatory only.
//   AI-H  The AI receives only validated analysis/investigation summaries,
//         never raw evidence rows.
//   AI-I  All output passes validateAssistanceResponse before exposure.
//         On validation failure, buildAssistanceHeuristic is used.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// validateAssistanceResponse(parsed, forensicAnalysis, observedEvidenceIds)
//
// Enforces the investigation-assistance invariants against a parsed LLM or
// mock response.  Returns { valid: boolean, errors: string[] }.
//
// Rules:
//   AR-1  findings_summary is a non-empty string.
//   AR-2  evidence_relationships is a non-empty array of strings.
//   AR-3  limitations_explained is a non-empty array of strings.
//   AR-4  unanswered_questions is a non-empty array of strings.
//   AR-5  challenge_summary is a non-empty string.
//   AR-6  additional_evidence_suggestions is a non-empty array of strings.
//   AR-7  observation_inconsistencies is a non-empty array of strings.
//   AR-8  No causal-certainty language in any free-text field (AI-C, AI-F).
//   AR-9  No numerical probability claims in any free-text field (AI-D).
//   AR-10 No fabricated evidence_ids anywhere in the response (AI-A).
//         Any field value that embeds a plausible-looking evidence ID (E-*-*)
//         must match an observed ID from the forensic analysis.
//   AR-11 No hypothesis assessment is stated in a changed form (AI-B).
//         Assessments mentioned in free text must use the allowed vocabulary.
//   AR-12 causal_attribution_established is not present or, if present, matches
//         the forensic analysis value (AI-C, AI-G).
// ---------------------------------------------------------------------------
function validateAssistanceResponse(parsed, forensicAnalysis, observedEvidenceIds, sourceHypotheses) {
  const errors = [];

  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, errors: ['AR: response is not an object'] };
  }

  // AR-1 through AR-7: required field checks
  const requiredStrings = ['findings_summary', 'challenge_summary'];
  for (const field of requiredStrings) {
    if (typeof parsed[field] !== 'string' || parsed[field].trim() === '') {
      errors.push(`AR: "${field}" must be a non-empty string`);
    }
  }
  const requiredArrays = [
    'evidence_relationships',
    'limitations_explained',
    'unanswered_questions',
    'additional_evidence_suggestions',
    'observation_inconsistencies',
  ];
  for (const field of requiredArrays) {
    if (!Array.isArray(parsed[field]) || parsed[field].length === 0) {
      errors.push(`AR: "${field}" must be a non-empty array of strings`);
    }
  }

  // Collect all free-text values for content checks.
  const allText = [
    parsed.findings_summary   || '',
    parsed.challenge_summary  || '',
    ...(parsed.evidence_relationships          || []),
    ...(parsed.limitations_explained           || []),
    ...(parsed.unanswered_questions            || []),
    ...(parsed.additional_evidence_suggestions || []),
    ...(parsed.observation_inconsistencies     || []),
  ].join('\n');

  // AR-8: no causal-certainty language
  if (containsCausalCertainty(allText)) {
    errors.push('AR-8: response contains causal-certainty language');
  }

  // AR-9: no numerical probability claims
  if (containsNumericalProbability(allText)) {
    errors.push('AR-9: response contains a numerical probability claim');
  }

  // AR-10: no fabricated evidence IDs
  // Any token matching the evidence-ID pattern (E-<PREFIX>-<digits>) that is
  // not present in observedEvidenceIds is treated as a fabricated ID.
  const EVIDENCE_ID_RE = /\bE-[A-Z0-9]+-\d{4}\b/g;
  const mentionedIds   = new Set(allText.match(EVIDENCE_ID_RE) || []);
  for (const eid of mentionedIds) {
    if (!observedEvidenceIds.has(eid)) {
      errors.push(`AR-10: response mentions evidence_id "${eid}" which is not in the analysis`);
    }
  }

  // AR-11: hypothesis_assessments must exactly match the deterministic source.
  //
  // The assistance response MAY include a hypothesis_assessments array that
  // re-states the deterministic assessments for the investigator's benefit.
  // When present — or when sourceHypotheses is provided — every entry is
  // validated against the authoritative hypothesis list:
  //
  //   • Each hypothesis_id must exist in the source (no unknown IDs).
  //   • No hypothesis_id may appear more than once (no duplicates).
  //   • The count must exactly match the source (no omissions).
  //   • Each assessment must be IDENTICAL to the source value (no vocabulary-
  //     correct-but-wrong values, no swapped assessments).
  //   • Every assessment must still be in the allowed vocabulary (preserved
  //     from previous AR-11 intent).
  //
  // When sourceHypotheses is supplied, the hypothesis_assessments field is
  // REQUIRED in the parsed response.
  if (sourceHypotheses && Array.isArray(sourceHypotheses) && sourceHypotheses.length > 0) {
    // Build authoritative map: hypothesis_id → deterministic assessment.
    const deterministicMap = new Map(
      sourceHypotheses.map((h) => [h.hypothesis_id, h.assessment]),
    );

    if (!Array.isArray(parsed.hypothesis_assessments)) {
      errors.push('AR-11: hypothesis_assessments must be an array when source hypotheses are provided');
    } else {
      // Count check.
      if (parsed.hypothesis_assessments.length !== deterministicMap.size) {
        errors.push(
          `AR-11: hypothesis_assessments has ${parsed.hypothesis_assessments.length} entries; ` +
          `expected ${deterministicMap.size}`,
        );
      }

      const seenIds = new Set();
      for (const ha of parsed.hypothesis_assessments) {
        const hid = ha.hypothesis_id;

        // Duplicate IDs.
        if (seenIds.has(hid)) {
          errors.push(`AR-11: duplicate hypothesis_id "${hid}" in hypothesis_assessments`);
          continue;
        }
        seenIds.add(hid);

        // Unknown hypothesis ID.
        if (!deterministicMap.has(hid)) {
          errors.push(`AR-11: unknown hypothesis_id "${hid}" not present in deterministic analysis`);
          continue; // cannot check assessment without a known id
        }

        const deterministicAssessment = deterministicMap.get(hid);

        // Exact assessment identity — must match character-for-character.
        if (ha.assessment !== deterministicAssessment) {
          errors.push(
            `AR-11: hypothesis ${hid} assessment "${ha.assessment}" does not match ` +
            `deterministic analysis assessment "${deterministicAssessment}"`,
          );
        }

        // Allowed vocabulary check (preserved from original AR-11 intent).
        if (ha.assessment && !ALLOWED_ASSESSMENTS.has(ha.assessment)) {
          errors.push(
            `AR-11: hypothesis ${hid} assessment "${ha.assessment}" is not in the allowed vocabulary`,
          );
        }
      }

      // Every source hypothesis must appear in the response (no silent omissions).
      for (const srcId of deterministicMap.keys()) {
        if (!seenIds.has(srcId)) {
          errors.push(
            `AR-11: hypothesis "${srcId}" is present in the deterministic analysis but ` +
            `is missing from hypothesis_assessments`,
          );
        }
      }
    }
  }

  // AR-12: causal_attribution_established must not be changed if present
  if (
    forensicAnalysis &&
    parsed.causal_attribution_established !== undefined &&
    parsed.causal_attribution_established !== forensicAnalysis.causal_attribution_established
  ) {
    errors.push(
      `AR-12: causal_attribution_established is "${parsed.causal_attribution_established}" ` +
      `but forensic analysis says "${forensicAnalysis.causal_attribution_established}"`,
    );
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// buildAssistanceHeuristic(summary)
//
// Deterministic fallback.  Produces a valid assistance document entirely from
// the already-assembled investigation summary — no LLM required.
//
// Parameters:
//   summary — the object returned by assembleInvestigationSummary / the
//             summary route, containing at minimum:
//             { forensic_conclusion, hypotheses, limitations, analyst_challenges,
//               investigation_state, provenance }
//
// Returns an object that passes validateAssistanceResponse.
// ---------------------------------------------------------------------------
function buildAssistanceHeuristic(summary) {
  const fc         = summary.forensic_conclusion  || {};
  const hypotheses = summary.hypotheses           || [];
  const limitations = summary.limitations         || [];
  const challenges  = summary.analyst_challenges  || {};
  const invState    = summary.investigation_state || {};
  const provenance  = summary.provenance          || {};
  const evidenceRefs = summary.evidence_references || {};

  // ── 1. findings_summary ──────────────────────────────────────────────────
  const attrClause = fc.causal_attribution_established
    ? 'Causal attribution has been established from the available evidence.'
    : 'Causal attribution has not been established from the available evidence.';

  const supportedIds  = (fc.comparison && fc.comparison.supported_hypotheses)    || [];
  const mixedIds      = (fc.comparison && fc.comparison.mixed_hypotheses)         || [];
  const insuffIds     = (fc.comparison && fc.comparison.insufficient_hypotheses)  || [];
  const mostSupported = fc.comparison && fc.comparison.most_supported;

  const summaryParts = [attrClause];
  if (supportedIds.length > 0) {
    summaryParts.push(
      `${supportedIds.length} hypothesis/es (${supportedIds.join(', ')}) are assessed as supported by available evidence.`,
    );
  }
  if (mixedIds.length > 0) {
    summaryParts.push(
      `${mixedIds.length} hypothesis/es (${mixedIds.join(', ')}) yield mixed evidence — environmental context is present but no direct mechanism evidence has been identified.`,
    );
  }
  if (insuffIds.length > 0) {
    summaryParts.push(
      `${insuffIds.length} hypothesis/es (${insuffIds.join(', ')}) cannot be evaluated because the required telemetry is absent from this dataset.`,
    );
  }
  if (mostSupported) {
    summaryParts.push(`The most supported outcome from the deterministic analysis is hypothesis ${mostSupported}.`);
  }
  const findings_summary = summaryParts.join(' ');

  // ── 2. evidence_relationships ─────────────────────────────────────────────
  const evidence_relationships = hypotheses.map((h) => {
    const es    = h.evidence_summary || {};
    const parts = [];
    if (es.environmental_context_count > 0) {
      parts.push(
        `${es.environmental_context_count} environmental context record(s) document preconditions ` +
        `contemporaneous with the anomaly. These are precondition indicators only — ` +
        `they do not confirm a mechanism.`,
      );
    }
    if (es.supporting_evidence_count > 0) {
      parts.push(
        `${es.supporting_evidence_count} record(s) are classified as direct supporting evidence.`,
      );
    }
    if (es.contradicting_evidence_count > 0) {
      parts.push(
        `${es.contradicting_evidence_count} record(s) are inconsistent with this hypothesis.`,
      );
    }
    if (es.non_discriminating_evidence_count > 0) {
      parts.push(
        `${es.non_discriminating_evidence_count} record(s) are consistent with multiple hypotheses and do not discriminate.`,
      );
    }
    if (parts.length === 0) {
      parts.push(`No evidence in this dataset speaks to this hypothesis.`);
    }
    return `Hypothesis ${h.hypothesis_id} (${h.label || h.hypothesis_id}, assessment: ${h.assessment}): ${parts.join(' ')}`;
  });

  if (evidence_relationships.length === 0) {
    evidence_relationships.push('No hypothesis evidence relationships are available in this analysis.');
  }

  // ── 3. limitations_explained ──────────────────────────────────────────────
  const limitations_explained = limitations.map((l) =>
    `[${l.type || 'limitation'}] ${l.description}`,
  );
  if (limitations_explained.length === 0) {
    limitations_explained.push('No specific limitations are recorded for this analysis.');
  }

  // ── 4. unanswered_questions ───────────────────────────────────────────────
  const unanswered_questions = [];
  // Questions derived from hypotheses with insufficient or no supporting evidence.
  for (const h of hypotheses) {
    if (h.assessment === 'insufficient_evidence') {
      unanswered_questions.push(
        `Can hypothesis ${h.hypothesis_id} (${h.label || h.hypothesis_id}) be evaluated with additional telemetry?`,
      );
    }
    if (h.assessment === 'mixed') {
      unanswered_questions.push(
        `What direct mechanism evidence (beyond environmental context) could discriminate hypothesis ${h.hypothesis_id}?`,
      );
    }
  }
  // Questions from limitations of type 'missing_data'.
  for (const l of limitations) {
    if (l.type === 'missing_data') {
      unanswered_questions.push(
        `Would obtaining the following missing data change the analysis? "${l.description}"`,
      );
    }
  }
  if (unanswered_questions.length === 0) {
    unanswered_questions.push(
      'What additional data would allow the competing hypotheses to be discriminated?',
    );
  }

  // ── 5. challenge_summary ──────────────────────────────────────────────────
  const totalChallenges = challenges.challenge_count || 0;
  let challenge_summary;
  if (totalChallenges === 0) {
    challenge_summary =
      'No analyst challenges have been raised for this investigation. ' +
      'The deterministic findings are uncontested so far.';
  } else {
    const open        = challenges.open_count         || 0;
    const underReview = challenges.under_review_count || 0;
    const resolved    = challenges.resolved_count     || 0;
    const rejected    = challenges.rejected_count     || 0;
    challenge_summary =
      `${totalChallenges} analyst challenge(s) recorded: ` +
      `${open} open, ${underReview} under review, ${resolved} resolved, ${rejected} rejected. ` +
      `No challenge modifies the deterministic forensic assessments.`;
  }

  // ── 6. additional_evidence_suggestions ───────────────────────────────────
  // Derived from limitation types and unanswered hypothesis questions.
  const additional_evidence_suggestions = [];
  const seenSuggestions = new Set();

  const addSuggestion = (s) => {
    if (!seenSuggestions.has(s)) {
      seenSuggestions.add(s);
      additional_evidence_suggestions.push(s);
    }
  };

  for (const l of limitations) {
    if (l.type === 'proxy_measurement') {
      addSuggestion(
        'Direct in-situ measurements at the spacecraft bus rather than proxy measurements from a nearby satellite.',
      );
    }
    if (l.type === 'missing_data') {
      addSuggestion(
        'Spacecraft command-subsystem telemetry and onboard fault logs if accessible from the operator.',
      );
    }
    if (l.type === 'unresolved') {
      addSuggestion(
        'Post-anomaly engineering review records or incident reports from the spacecraft operator.',
      );
    }
  }

  for (const h of hypotheses) {
    if (h.assessment === 'insufficient_evidence') {
      addSuggestion(
        `Data that would allow evaluation of hypothesis ${h.hypothesis_id} (${h.label || h.hypothesis_id}).`,
      );
    }
  }

  const dataSources = provenance.data_sources || [];
  if (dataSources.length > 0 && !seenSuggestions.has('additional_sensors')) {
    addSuggestion(
      `Additional sensor data from sources complementary to: ${dataSources.map((d) => d.dataset_id || d.measurement).filter(Boolean).join(', ')}.`,
    );
  }

  if (additional_evidence_suggestions.length === 0) {
    additional_evidence_suggestions.push(
      'No specific additional evidence categories identified; refer to the limitations for dataset gaps.',
    );
  }

  // ── 7. observation_inconsistencies ───────────────────────────────────────
  // Without full observation text (not available in summary — observations are
  // count-only in the summary per SUM-6), the heuristic can only report the
  // structural situation.
  const obsCount  = invState.observation_count || 0;
  const chalCount = invState.challenge_count   || 0;
  const observation_inconsistencies = [];

  if (obsCount === 0 && chalCount === 0) {
    observation_inconsistencies.push(
      'No analyst observations or challenges have been recorded. ' +
      'No inconsistencies can be identified without analyst input.',
    );
  } else {
    if (chalCount > 0) {
      observation_inconsistencies.push(
        `${chalCount} analyst challenge(s) indicate areas where analyst judgement differs ` +
        `from or supplements the deterministic findings. Reviewing each challenge against ` +
        `the forensic assessment is recommended.`,
      );
    }
    if (obsCount > 0) {
      observation_inconsistencies.push(
        `${obsCount} analyst observation(s) recorded. Full text is in the investigation ` +
        `history. Observations are analyst-created annotations and do not modify the ` +
        `deterministic forensic analysis.`,
      );
    }
  }

  // ── 8. hypothesis_assessments ─────────────────────────────────────────────
  // Re-state the deterministic assessments verbatim so the investigator can
  // see them alongside the assistance narrative.  These are read-only copies
  // of the authoritative values — AR-11 will reject any deviation.
  const hypothesis_assessments = hypotheses.map((h) => ({
    hypothesis_id: h.hypothesis_id,
    assessment:    h.assessment,
  }));

  return {
    findings_summary,
    evidence_relationships,
    limitations_explained,
    unanswered_questions,
    challenge_summary,
    additional_evidence_suggestions,
    observation_inconsistencies,
    hypothesis_assessments,
    source:       'heuristic',
    generated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// buildAssistancePrompt(summary, observedEvidenceIds)
//
// Constructs the system + user messages for the LLM assistance call.
// The summary object (already-validated pipeline output) is the ONLY data
// source sent to the LLM.  Raw evidence rows are never included (AI-H).
// ---------------------------------------------------------------------------
function buildAssistancePrompt(summary, observedEvidenceIds) {
  const fc         = summary.forensic_conclusion  || {};
  const hypotheses = summary.hypotheses           || [];
  const limitations = summary.limitations         || [];
  const challenges  = summary.analyst_challenges  || {};
  const invState    = summary.investigation_state || {};

  // Build a compact version of the summary for the prompt.
  const promptSummary = {
    case_id:                        (summary.case_metadata || {}).case_id,
    causal_attribution_established: fc.causal_attribution_established,
    causal_attribution_statement:   fc.causal_attribution_statement,
    analysis_version:               fc.analysis_version,
    hypotheses: hypotheses.map((h) => ({
      hypothesis_id: h.hypothesis_id,
      label:         h.label,
      assessment:    h.assessment,            // authoritative — must not be changed
      key_observations: h.key_observations || [],
      limitations:   h.limitations || [],
      evidence_summary: {
        environmental_context_count:       h.evidence_summary.environmental_context_count,
        supporting_evidence_count:         h.evidence_summary.supporting_evidence_count,
        contradicting_evidence_count:      h.evidence_summary.contradicting_evidence_count,
        non_discriminating_evidence_count: h.evidence_summary.non_discriminating_evidence_count,
        // IDs are included so the LLM can cite them, but must not invent new ones.
        environmental_context_ids:         h.evidence_summary.environmental_context_ids,
        supporting_evidence_ids:           h.evidence_summary.supporting_evidence_ids,
      },
    })),
    aggregate_evidence_summary: fc.evidence_summary,
    limitations,
    analyst_challenges: {
      challenge_count:    challenges.challenge_count    || 0,
      open_count:         challenges.open_count         || 0,
      under_review_count: challenges.under_review_count || 0,
      resolved_count:     challenges.resolved_count     || 0,
      rejected_count:     challenges.rejected_count     || 0,
      // Include challenge target_types for context, but not full analyst_statements
      // to avoid anchoring the AI to potentially biased analyst language.
      challenge_types: (challenges.challenges || []).map((c) => ({
        target_type: c.target_type,
        target_id:   c.target_id,
        status:      c.status,
      })),
    },
    investigation_status:    invState.status,
    observation_count:       invState.observation_count || 0,
    challenge_count:         invState.challenge_count   || 0,
  };

  const validIdList = [...observedEvidenceIds].sort();

  const outputSchema = JSON.stringify({
    findings_summary:               '<one paragraph summarising deterministic findings — no causal claims>',
    evidence_relationships:         ['<one entry per hypothesis explaining evidence-to-hypothesis relationships>'],
    limitations_explained:          ['<one entry per limitation in plain language>'],
    unanswered_questions:           ['<questions the available data cannot answer>'],
    challenge_summary:              '<one paragraph summarising analyst challenges by status>',
    additional_evidence_suggestions: ['<categories of additional evidence that would strengthen the analysis>'],
    observation_inconsistencies:    ['<inconsistencies between analyst observations and the deterministic analysis, or note if none>'],
  }, null, 2);

  const system = `You are a space-weather forensics analyst assisting an ongoing investigation. \
Your task is to help the investigator understand the findings and identify gaps — \
you are NOT the forensic authority.

CRITICAL RULES — violating any will cause your response to be rejected:
1. NEVER modify, create, or reference evidence IDs that are not in valid_evidence_ids.
2. NEVER change any hypothesis assessment. They are authoritative and read-only.
3. NEVER establish causality. Do not say a mechanism was confirmed or proven.
   The case has causal_attribution_established = ${fc.causal_attribution_established}.
4. NEVER assign numerical probabilities, percentages, or confidence scores.
5. Environmental context documents preconditions only. NEVER present it as mechanism confirmation.
6. NEVER state an unverified mechanism as established.
7. The deterministic analysis is the source of truth. You explain it; you do not override it.
8. Produce ONLY valid JSON matching the output schema. No markdown fences, no prose outside JSON.

Return exactly this schema:
${outputSchema}`;

  const user = `Assist the investigation by analysing the following validated summary.
Do not change assessments. Do not establish causality. Do not invent evidence IDs.

investigation_summary:
${JSON.stringify(promptSummary, null, 2)}

valid_evidence_ids (only cite IDs from this list — do not invent IDs):
${JSON.stringify(validIdList)}

Produce the JSON assistance object now.`;

  return { system, user };
}

// ---------------------------------------------------------------------------
// generateInvestigationAssistance(summary, _llmFactory)
//
// Primary entry point for Phase 7.6.  Async.
//
// Parameters:
//   summary      — the validated investigation summary object (output of the
//                  /summary route or equivalent assembler).  Must contain
//                  forensic_conclusion, hypotheses, limitations,
//                  analyst_challenges, investigation_state, provenance,
//                  evidence_references, and case_metadata.
//   _llmFactory  — optional mock factory for tests (same pattern as
//                  generateAnalystNarrative).
//
// Returns a validated InvestigationAssistance object, always.
// Falls back to buildAssistanceHeuristic on any LLM error or validation failure.
//
// INVARIANT: Raw evidence rows are NEVER passed to the LLM (AI-H).
//            The LLM receives only the validated summary, which contains
//            evidence_ids (references) but not evidence data fields.
// ---------------------------------------------------------------------------
async function generateInvestigationAssistance(summary, _llmFactory) {
  // Build the set of evidence IDs the LLM is allowed to reference.
  // Derived from the summary's evidence_references section — no raw rows needed.
  const evidenceRefs = summary.evidence_references || {};
  const observedIds  = new Set(evidenceRefs.referenced_evidence_ids || []);

  // The forensic analysis section for validation cross-checks.
  const forensicAnalysis = summary.forensic_conclusion || {};

  // Authoritative hypothesis list — used by AR-11 to enforce assessment identity.
  const sourceHypotheses = summary.hypotheses || [];

  const llm = (_llmFactory || buildLLMClient)();

  if (llm) {
    try {
      const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
      const prompt   = buildAssistancePrompt(summary, observedIds);
      const response = await llm.invoke([
        new SystemMessage(prompt.system),
        new HumanMessage(prompt.user),
      ]);

      const raw      = typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content);
      const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      const parsed   = JSON.parse(jsonText);

      const { valid, errors } = validateAssistanceResponse(parsed, forensicAnalysis, observedIds, sourceHypotheses);
      if (!valid) {
        console.error('[aiAnalyst] assistance LLM response failed validation, using heuristic fallback:', errors);
        throw new Error('validation_failed');
      }

      return {
        ...parsed,
        source:       'llm',
        generated_at: new Date().toISOString(),
      };
    } catch (err) {
      console.error('[aiAnalyst] assistance LLM error, using heuristic fallback:', err.message);
    }
  }

  return buildAssistanceHeuristic(summary);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  generateAnalystNarrative,
  validateAnalystResponse,
  buildAnalystHeuristicNarrative,
  generateInvestigationAssistance,
  validateAssistanceResponse,
  buildAssistanceHeuristic,
};
