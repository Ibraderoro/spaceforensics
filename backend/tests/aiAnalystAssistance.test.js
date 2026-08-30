'use strict';

/**
 * Phase 7.6 — AI Analyst Investigation Assistance unit and LLM-path tests
 *
 * Tests:
 *   AS6-1   heuristic output has valid shape and all seven required fields
 *   AS6-2   heuristic output passes validateAssistanceResponse
 *   AS6-3   validateAssistanceResponse rejects missing required fields
 *   AS6-4   validateAssistanceResponse rejects causal-certainty language (AR-8)
 *   AS6-5   validateAssistanceResponse rejects numerical probability claims (AR-9)
 *   AS6-6   validateAssistanceResponse rejects fabricated evidence IDs (AR-10)
 *   AS6-7   validateAssistanceResponse rejects changed causal_attribution_established (AR-12)
 *   AS6-8   validateAssistanceResponse accepts real evidence IDs in text (AR-10)
 *   AS6-9   heuristic: findings_summary reflects causal attribution statement
 *   AS6-10  heuristic: evidence_relationships has one entry per hypothesis
 *   AS6-11  heuristic: limitations_explained has one entry per limitation
 *   AS6-12  heuristic: unanswered_questions generated from mixed/insufficient hypotheses
 *   AS6-13  heuristic: challenge_summary reflects zero challenges
 *   AS6-14  heuristic: challenge_summary reflects non-zero challenges with counts
 *   AS6-15  heuristic: additional_evidence_suggestions derived from limitation types
 *   AS6-16  heuristic: observation_inconsistencies when no observations
 *   AS6-17  heuristic: observation_inconsistencies when challenges and observations present
 *   AS6-18  LLM path: valid mock LLM response accepted, source:"llm" stamped
 *   AS6-19  LLM path: hallucinated evidence ID → AR-10 rejection → heuristic fallback
 *   AS6-20  LLM path: fabricated evidence ID not in valid set → rejected → fallback
 *   AS6-21  LLM path: causal-certainty language in findings_summary → AR-8 → fallback
 *   AS6-22  LLM path: numerical probability in evidence_relationships → AR-9 → fallback
 *   AS6-23  LLM path: mechanism-confirmation claim → AR-8 → fallback
 *   AS6-24  LLM path: changed causal_attribution_established → AR-12 → fallback
 *   AS6-25  LLM path: malformed (non-JSON) response → parse error → fallback
 *   AS6-26  LLM path: network failure (.invoke() throws) → fallback
 *   AS6-27  LLM path: valid explanatory output accepted (no forbidden content)
 *   AS6-28  LLM path: markdown-fenced response parsed correctly
 *   AS6-29  AI-H: LLM receives summary (no raw evidence data fields)
 *   AS6-30  cross-case evidence ID in response → AR-10 → rejected
 */

const { parseEvidenceCSV, buildEvidenceGraph, buildForensicAnalysis, assembleValidatedForensicReport } = require('../server');
const aiAnalyst = require('../services/aiAnalyst');
const {
  generateInvestigationAssistance,
  validateAssistanceResponse,
  buildAssistanceHeuristic,
  buildAnalystHeuristicNarrative,
} = aiAnalyst;

const CASE_ID = 'galaxy-15';

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture — real galaxy-15 pipeline built once.
// ─────────────────────────────────────────────────────────────────────────────
let rows, graph, analysis, validIds, report;
let baseSummary;          // minimal summary for unit tests
let baseAssistance;       // heuristic output used as mock LLM template

beforeAll(async () => {
  jest.setTimeout(30_000);
  rows      = await parseEvidenceCSV(CASE_ID);
  graph     = await buildEvidenceGraph(CASE_ID, rows);
  analysis  = buildForensicAnalysis(CASE_ID, graph);
  validIds  = new Set(rows.map((r) => r.evidence_id));
  const narrative = buildAnalystHeuristicNarrative(analysis);
  report    = assembleValidatedForensicReport(analysis, narrative);

  // Build a minimal summary that mirrors what /summary returns, so unit tests
  // can call buildAssistanceHeuristic and validateAssistanceResponse directly.
  const evidenceByHypothesis = report.hypotheses.map((h) => ({
    hypothesis_id:                   h.hypothesis_id,
    environmental_context_ids:       h.evidence_summary.environmental_context_ids,
    supporting_evidence_ids:         h.evidence_summary.supporting_evidence_ids,
    contradicting_evidence_ids:      h.evidence_summary.contradicting_evidence_ids,
    non_discriminating_evidence_ids: h.evidence_summary.non_discriminating_evidence_ids,
  }));
  const referencedIds = new Set(
    evidenceByHypothesis.flatMap((h) => [
      ...h.environmental_context_ids,
      ...h.supporting_evidence_ids,
      ...h.contradicting_evidence_ids,
      ...h.non_discriminating_evidence_ids,
    ]),
  );

  baseSummary = {
    case_metadata: {
      case_id:    CASE_ID,
      title:      'Galaxy 15 Satellite Anomaly',
      description: null,
      causal_attribution: 'Causal attribution is not established.',
      data_sources: [{ dataset_id: 'GOES11_K0_EP8', provider: 'NASA CDAWeb', measurement: 'e_flux' }],
      scientific_limitations: [],
    },
    investigation_state: {
      investigation_id:  'test-inv-id',
      case_id:           CASE_ID,
      status:            'open',
      title:             'Test Investigation',
      observation_count: 0,
      challenge_count:   0,
    },
    forensic_conclusion: {
      causal_attribution_established: report.causal_attribution_established,
      causal_attribution_statement:   'Causal attribution is not established.',
      analysis_version:               report.analysis_version,
      evidence_summary:               report.evidence_summary,
      comparison:                     report.comparison,
    },
    hypotheses: report.hypotheses.map((h) => ({
      hypothesis_id:    h.hypothesis_id,
      label:            h.label,
      assessment:       h.assessment,
      evidence_summary: h.evidence_summary,
      limitations:      h.limitations,
      heuristic_note:   h.heuristic_note,
      key_observations: [],
    })),
    evidence_references: {
      total_evidence_rows:       rows.length,
      referenced_evidence_count: referencedIds.size,
      referenced_evidence_ids:   [...referencedIds].sort(),
      evidence_by_hypothesis:    evidenceByHypothesis,
    },
    provenance: {
      data_sources: [{ dataset_id: 'GOES11_K0_EP8', provider: 'NASA CDAWeb', measurement: 'e_flux' }],
      heuristic_window_note: '±10-minute selection window.',
      evidence_count: rows.length,
    },
    limitations: report.limitations,
    ai_narrative: report.analyst_narrative,
    analyst_challenges: {
      challenge_count:    0,
      open_count:         0,
      under_review_count: 0,
      resolved_count:     0,
      rejected_count:     0,
      challenges:         [],
    },
  };

  baseAssistance = buildAssistanceHeuristic(baseSummary);

  // Paranoia: heuristic output must pass validation.
  const observedIds = new Set(baseSummary.evidence_references.referenced_evidence_ids);
  const { valid } = validateAssistanceResponse(
    baseAssistance,
    baseSummary.forensic_conclusion,
    observedIds,
  );
  expect(valid).toBe(true);
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMockLLM(responseContent) {
  return () => ({ invoke: async () => ({ content: responseContent }) });
}

function cloneAssistance() {
  return JSON.parse(JSON.stringify(baseAssistance));
}

function getObservedIds() {
  return new Set(baseSummary.evidence_references.referenced_evidence_ids);
}

// ─────────────────────────────────────────────────────────────────────────────
// AS6-1 — heuristic output shape
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-1: heuristic output shape', () => {
  test('AS6-1-1: all seven required fields are present', () => {
    expect(typeof baseAssistance.findings_summary).toBe('string');
    expect(baseAssistance.findings_summary.length).toBeGreaterThan(0);
    expect(Array.isArray(baseAssistance.evidence_relationships)).toBe(true);
    expect(baseAssistance.evidence_relationships.length).toBeGreaterThan(0);
    expect(Array.isArray(baseAssistance.limitations_explained)).toBe(true);
    expect(baseAssistance.limitations_explained.length).toBeGreaterThan(0);
    expect(Array.isArray(baseAssistance.unanswered_questions)).toBe(true);
    expect(baseAssistance.unanswered_questions.length).toBeGreaterThan(0);
    expect(typeof baseAssistance.challenge_summary).toBe('string');
    expect(baseAssistance.challenge_summary.length).toBeGreaterThan(0);
    expect(Array.isArray(baseAssistance.additional_evidence_suggestions)).toBe(true);
    expect(baseAssistance.additional_evidence_suggestions.length).toBeGreaterThan(0);
    expect(Array.isArray(baseAssistance.observation_inconsistencies)).toBe(true);
    expect(baseAssistance.observation_inconsistencies.length).toBeGreaterThan(0);
  });

  test('AS6-1-2: source is "heuristic"', () => {
    expect(baseAssistance.source).toBe('heuristic');
  });

  test('AS6-1-3: generated_at is an ISO8601 timestamp', () => {
    expect(typeof baseAssistance.generated_at).toBe('string');
    expect(new Date(baseAssistance.generated_at).toISOString()).toBe(baseAssistance.generated_at);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-2 — heuristic passes validateAssistanceResponse
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-2: heuristic passes validateAssistanceResponse', () => {
  test('AS6-2-1: heuristic output passes with no errors', () => {
    const { valid, errors } = validateAssistanceResponse(
      baseAssistance,
      baseSummary.forensic_conclusion,
      getObservedIds(),
    );
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-3 — rejects missing required fields
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-3: rejects missing required fields', () => {
  test('AS6-3-1: missing findings_summary', () => {
    const bad = cloneAssistance();
    delete bad.findings_summary;
    const { valid, errors } = validateAssistanceResponse(bad, baseSummary.forensic_conclusion, getObservedIds());
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('findings_summary'))).toBe(true);
  });

  test('AS6-3-2: missing evidence_relationships', () => {
    const bad = cloneAssistance();
    bad.evidence_relationships = [];
    const { valid, errors } = validateAssistanceResponse(bad, baseSummary.forensic_conclusion, getObservedIds());
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('evidence_relationships'))).toBe(true);
  });

  test('AS6-3-3: missing unanswered_questions', () => {
    const bad = cloneAssistance();
    bad.unanswered_questions = [];
    const { valid, errors } = validateAssistanceResponse(bad, baseSummary.forensic_conclusion, getObservedIds());
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('unanswered_questions'))).toBe(true);
  });

  test('AS6-3-4: missing challenge_summary', () => {
    const bad = cloneAssistance();
    bad.challenge_summary = '';
    const { valid, errors } = validateAssistanceResponse(bad, baseSummary.forensic_conclusion, getObservedIds());
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('challenge_summary'))).toBe(true);
  });

  test('AS6-3-5: missing observation_inconsistencies', () => {
    const bad = cloneAssistance();
    bad.observation_inconsistencies = [];
    const { valid, errors } = validateAssistanceResponse(bad, baseSummary.forensic_conclusion, getObservedIds());
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('observation_inconsistencies'))).toBe(true);
  });

  test('AS6-3-6: null response is rejected', () => {
    const { valid, errors } = validateAssistanceResponse(null, baseSummary.forensic_conclusion, getObservedIds());
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR:'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-4 — AR-8: causal-certainty language rejected
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-4: AR-8 rejects causal-certainty language', () => {
  test('AS6-4-1: "proves" in findings_summary', () => {
    const bad = cloneAssistance();
    bad.findings_summary = 'This proves the SEU was the root cause.';
    const { valid, errors } = validateAssistanceResponse(bad, baseSummary.forensic_conclusion, getObservedIds());
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-8'))).toBe(true);
  });

  test('AS6-4-2: "directly caused" in evidence_relationships', () => {
    const bad = cloneAssistance();
    bad.evidence_relationships = ['The elevated flux directly caused the anomaly.'];
    const { valid, errors } = validateAssistanceResponse(bad, baseSummary.forensic_conclusion, getObservedIds());
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-8'))).toBe(true);
  });

  test('AS6-4-3: "triggered the anomaly" in unanswered_questions', () => {
    const bad = cloneAssistance();
    bad.unanswered_questions = ['Why did the flux triggered the anomaly?'];
    const { valid, errors } = validateAssistanceResponse(bad, baseSummary.forensic_conclusion, getObservedIds());
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-8'))).toBe(true);
  });

  test('AS6-4-4: "causation established" in challenge_summary', () => {
    const bad = cloneAssistance();
    bad.challenge_summary = 'Challenge confirms causation established by analyst.';
    const { valid, errors } = validateAssistanceResponse(bad, baseSummary.forensic_conclusion, getObservedIds());
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-8'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-5 — AR-9: numerical probability claims rejected
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-5: AR-9 rejects numerical probability claims', () => {
  test('AS6-5-1: percentage in findings_summary', () => {
    const bad = cloneAssistance();
    bad.findings_summary = 'There is a 70% probability that SEU caused the anomaly.';
    const { valid, errors } = validateAssistanceResponse(bad, baseSummary.forensic_conclusion, getObservedIds());
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-9'))).toBe(true);
  });

  test('AS6-5-2: "0.8 probability" in evidence_relationships', () => {
    const bad = cloneAssistance();
    bad.evidence_relationships = ['There is a 0.8 probability of mechanism X.'];
    const { valid, errors } = validateAssistanceResponse(bad, baseSummary.forensic_conclusion, getObservedIds());
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-9'))).toBe(true);
  });

  test('AS6-5-3: "95% likelihood" in additional_evidence_suggestions', () => {
    const bad = cloneAssistance();
    bad.additional_evidence_suggestions = ['This has 95% likelihood of being the cause.'];
    const { valid, errors } = validateAssistanceResponse(bad, baseSummary.forensic_conclusion, getObservedIds());
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-9'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-6 — AR-10: fabricated evidence IDs rejected
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-6: AR-10 rejects fabricated evidence IDs', () => {
  test('AS6-6-1: hallucinated ID E-G15-9999 in findings_summary', () => {
    const bad = cloneAssistance();
    bad.findings_summary += ' Refer to E-G15-9999 for details.';
    const { valid, errors } = validateAssistanceResponse(bad, baseSummary.forensic_conclusion, getObservedIds());
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-10') && e.includes('E-G15-9999'))).toBe(true);
  });

  test('AS6-6-2: hallucinated ID E-G15-FAKE in evidence_relationships', () => {
    const bad = cloneAssistance();
    bad.evidence_relationships = [bad.evidence_relationships[0] + ' See E-G15-FAKE for reference.'];
    // E-G15-FAKE does not match the pattern E-[A-Z0-9]+-[0-9]{4} so won't be caught.
    // Use a valid-pattern but nonexistent ID instead.
    bad.evidence_relationships = [bad.evidence_relationships[0] + ' Evidence E-G15-9998 is relevant.'];
    const { valid, errors } = validateAssistanceResponse(bad, baseSummary.forensic_conclusion, getObservedIds());
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-10'))).toBe(true);
  });

  test('AS6-6-3: cross-case evidence ID (TCA) in unanswered_questions', () => {
    const bad = cloneAssistance();
    // E-TCA-0001 is a valid-pattern ID from a different case — not in G15 observed IDs.
    bad.unanswered_questions = ['Could E-TCA-0001 be relevant to this hypothesis?'];
    const { valid, errors } = validateAssistanceResponse(bad, baseSummary.forensic_conclusion, getObservedIds());
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-10') && e.includes('E-TCA-0001'))).toBe(true);
  });

  test('AS6-6-4: real evidence ID from this case is accepted (not flagged as fabricated)', () => {
    const observedIds = getObservedIds();
    const realId      = [...observedIds][0];
    const ok          = cloneAssistance();
    ok.findings_summary = `Evidence ${realId} is in the environmental context.`;
    const { valid, errors } = validateAssistanceResponse(ok, baseSummary.forensic_conclusion, observedIds);
    // AR-10 must NOT flag a real ID.
    expect(errors.filter((e) => e.includes('AR-10'))).toHaveLength(0);
    expect(valid).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-7 — AR-12: changed causal_attribution_established rejected
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-7: AR-12 rejects changed causal_attribution_established', () => {
  test('AS6-7-1: causal_attribution_established:true when analysis says false', () => {
    expect(report.causal_attribution_established).toBe(false);
    const bad = cloneAssistance();
    bad.causal_attribution_established = true;
    const { valid, errors } = validateAssistanceResponse(bad, baseSummary.forensic_conclusion, getObservedIds());
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-12'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-8 — real evidence IDs in text are accepted (AR-10 negative case)
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-8: real evidence IDs accepted by AR-10', () => {
  test('AS6-8-1: all referenced_evidence_ids from the case are in observed set', () => {
    const observedIds = getObservedIds();
    // Confirm every ID in the observed set matches the E-G15- prefix.
    for (const id of observedIds) {
      expect(id).toMatch(/^E-G15-\d{4}$/);
    }
  });

  test('AS6-8-2: including a real ID does not trigger AR-10', () => {
    const observedIds = getObservedIds();
    const realId      = [...observedIds][0];
    const ok          = cloneAssistance();
    ok.evidence_relationships = ok.evidence_relationships.concat(`Record ${realId} is an environmental context entry.`);
    const { valid } = validateAssistanceResponse(ok, baseSummary.forensic_conclusion, observedIds);
    expect(valid).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-9 — heuristic: findings_summary content
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-9: heuristic findings_summary content', () => {
  test('AS6-9-1: causal attribution is not established → statement reflected', () => {
    expect(report.causal_attribution_established).toBe(false);
    expect(baseAssistance.findings_summary).toMatch(/causal attribution has not been established/i);
  });

  test('AS6-9-2: no causal-certainty language', () => {
    const lower = baseAssistance.findings_summary.toLowerCase();
    expect(lower).not.toContain('proves');
    expect(lower).not.toContain('causation established');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-10 — heuristic: evidence_relationships
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-10: heuristic evidence_relationships', () => {
  test('AS6-10-1: one entry per hypothesis (5 for galaxy-15)', () => {
    expect(baseAssistance.evidence_relationships).toHaveLength(5);
  });

  test('AS6-10-2: each entry is a non-empty string', () => {
    for (const rel of baseAssistance.evidence_relationships) {
      expect(typeof rel).toBe('string');
      expect(rel.length).toBeGreaterThan(0);
    }
  });

  test('AS6-10-3: does not contain numerical probabilities', () => {
    for (const rel of baseAssistance.evidence_relationships) {
      expect(rel).not.toMatch(/\d+(\.\d+)?\s*%/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-11 — heuristic: limitations_explained
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-11: heuristic limitations_explained', () => {
  test('AS6-11-1: at least as many entries as report.limitations', () => {
    expect(baseAssistance.limitations_explained.length).toBeGreaterThanOrEqual(report.limitations.length);
  });

  test('AS6-11-2: each entry is a non-empty string', () => {
    for (const l of baseAssistance.limitations_explained) {
      expect(typeof l).toBe('string');
      expect(l.length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-12 — heuristic: unanswered_questions
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-12: heuristic unanswered_questions', () => {
  test('AS6-12-1: at least one question derived from mixed/insufficient hypotheses', () => {
    // Galaxy-15 has H1, H2 (mixed) and H4 (insufficient_evidence) — expect questions.
    expect(baseAssistance.unanswered_questions.length).toBeGreaterThan(0);
  });

  test('AS6-12-2: no causal certainty language', () => {
    for (const q of baseAssistance.unanswered_questions) {
      expect(q.toLowerCase()).not.toContain('proves');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-13 — heuristic: challenge_summary (zero challenges)
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-13: challenge_summary with zero challenges', () => {
  test('AS6-13-1: mentions uncontested when no challenges', () => {
    expect(baseSummary.analyst_challenges.challenge_count).toBe(0);
    expect(baseAssistance.challenge_summary.toLowerCase()).toMatch(/uncontested/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-14 — heuristic: challenge_summary (with challenges)
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-14: challenge_summary with challenges', () => {
  test('AS6-14-1: reflects challenge counts when challenges are present', () => {
    const summaryWithChallenges = JSON.parse(JSON.stringify(baseSummary));
    summaryWithChallenges.analyst_challenges = {
      challenge_count:    2,
      open_count:         1,
      under_review_count: 1,
      resolved_count:     0,
      rejected_count:     0,
      challenges:         [],
    };
    summaryWithChallenges.investigation_state.challenge_count = 2;
    const assistance = buildAssistanceHeuristic(summaryWithChallenges);
    expect(assistance.challenge_summary).toContain('2');
    // No causal certainty in challenge summary.
    expect(assistance.challenge_summary.toLowerCase()).not.toContain('proves');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-15 — heuristic: additional_evidence_suggestions
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-15: heuristic additional_evidence_suggestions', () => {
  test('AS6-15-1: non-empty for galaxy-15 (proxy and missing_data limitations present)', () => {
    expect(baseAssistance.additional_evidence_suggestions.length).toBeGreaterThan(0);
  });

  test('AS6-15-2: each suggestion is a non-empty string', () => {
    for (const s of baseAssistance.additional_evidence_suggestions) {
      expect(typeof s).toBe('string');
      expect(s.length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-16 — heuristic: observation_inconsistencies when no observations
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-16: observation_inconsistencies with no observations', () => {
  test('AS6-16-1: mentions "no analyst observations" when both counts are zero', () => {
    const entry = baseAssistance.observation_inconsistencies[0].toLowerCase();
    expect(entry).toMatch(/no analyst observations|no inconsistencies/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-17 — heuristic: observation_inconsistencies when there is analyst content
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-17: observation_inconsistencies with analyst content', () => {
  test('AS6-17-1: mentions challenge count when challenges present', () => {
    const summaryWithContent = JSON.parse(JSON.stringify(baseSummary));
    summaryWithContent.investigation_state.challenge_count   = 3;
    summaryWithContent.investigation_state.observation_count = 2;
    const assistance = buildAssistanceHeuristic(summaryWithContent);
    const text = assistance.observation_inconsistencies.join(' ').toLowerCase();
    expect(text).toMatch(/challenge/);
    expect(text).toMatch(/observation/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-18 — LLM path: valid mock response accepted with source:"llm"
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-18: LLM path accepts valid response', () => {
  test('AS6-18-1: valid mock LLM response returns source:"llm"', async () => {
    const good = cloneAssistance();
    delete good.source;
    delete good.generated_at;
    const result = await generateInvestigationAssistance(baseSummary, makeMockLLM(JSON.stringify(good)));
    expect(result.source).toBe('llm');
    expect(typeof result.generated_at).toBe('string');
    expect(Array.isArray(result.evidence_relationships)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-19 — LLM path: hallucinated evidence ID → AR-10 → heuristic fallback
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-19: hallucinated evidence ID causes fallback', () => {
  test('AS6-19-1: hallucinated E-G15-9999 → rejected → heuristic fallback', async () => {
    const bad = cloneAssistance();
    bad.findings_summary += ' Evidence E-G15-9999 supports this.';
    const result = await generateInvestigationAssistance(baseSummary, makeMockLLM(JSON.stringify(bad)));
    expect(result.source).toBe('heuristic');
    expect(JSON.stringify(result)).not.toContain('E-G15-9999');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-20 — LLM path: fabricated cross-case evidence ID → AR-10 → fallback
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-20: cross-case evidence ID causes fallback', () => {
  test('AS6-20-1: E-TCA-0001 in G15 investigation → rejected → heuristic fallback', async () => {
    const bad = cloneAssistance();
    bad.evidence_relationships = ['Could E-TCA-0001 be relevant here?'];
    const result = await generateInvestigationAssistance(baseSummary, makeMockLLM(JSON.stringify(bad)));
    expect(result.source).toBe('heuristic');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-21 — LLM path: causal-certainty language → AR-8 → heuristic fallback
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-21: causal-certainty language causes fallback', () => {
  test('AS6-21-1: "proves" in findings_summary → heuristic fallback', async () => {
    const bad = cloneAssistance();
    bad.findings_summary = 'This proves that the SEU directly caused the Galaxy 15 failure.';
    const result = await generateInvestigationAssistance(baseSummary, makeMockLLM(JSON.stringify(bad)));
    expect(result.source).toBe('heuristic');
    expect(result.findings_summary).not.toMatch(/proves/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-22 — LLM path: numerical probability → AR-9 → heuristic fallback
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-22: numerical probability causes fallback', () => {
  test('AS6-22-1: "70%" in evidence_relationships → heuristic fallback', async () => {
    const bad = cloneAssistance();
    bad.evidence_relationships = ['The evidence indicates a 70% probability of SEU.'];
    const result = await generateInvestigationAssistance(baseSummary, makeMockLLM(JSON.stringify(bad)));
    expect(result.source).toBe('heuristic');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-23 — LLM path: mechanism-confirmation language → AR-8 → heuristic fallback
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-23: mechanism confirmation causes fallback', () => {
  test('AS6-23-1: "triggered the anomaly" → AR-8 → heuristic fallback', async () => {
    const bad = cloneAssistance();
    bad.evidence_relationships = ['The flux triggered the anomaly via the command uplink.'];
    const result = await generateInvestigationAssistance(baseSummary, makeMockLLM(JSON.stringify(bad)));
    expect(result.source).toBe('heuristic');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-24 — LLM path: changed causal_attribution_established → AR-12 → fallback
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-24: changed causal_attribution_established causes fallback', () => {
  test('AS6-24-1: causal_attribution_established:true in response when analysis says false', async () => {
    expect(report.causal_attribution_established).toBe(false);
    const bad = cloneAssistance();
    bad.causal_attribution_established = true;
    const result = await generateInvestigationAssistance(baseSummary, makeMockLLM(JSON.stringify(bad)));
    expect(result.source).toBe('heuristic');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-25 — LLM path: malformed (non-JSON) response → heuristic fallback
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-25: malformed LLM response causes fallback', () => {
  test('AS6-25-1: non-JSON response falls back to heuristic', async () => {
    const result = await generateInvestigationAssistance(
      baseSummary,
      makeMockLLM('This is not valid JSON { broken]'),
    );
    expect(result.source).toBe('heuristic');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-26 — LLM path: network failure → heuristic fallback
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-26: network failure causes fallback', () => {
  test('AS6-26-1: .invoke() throws → heuristic fallback', async () => {
    const throwingFactory = () => ({
      invoke: async () => { throw new Error('Simulated network error'); },
    });
    const result = await generateInvestigationAssistance(baseSummary, throwingFactory);
    expect(result.source).toBe('heuristic');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-27 — LLM path: valid explanatory output accepted
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-27: valid explanatory output accepted', () => {
  test('AS6-27-1: response explaining evidence relationships is accepted when no violations', async () => {
    const good = cloneAssistance();
    // Confirm it passes validation directly.
    const { valid } = validateAssistanceResponse(good, baseSummary.forensic_conclusion, getObservedIds());
    expect(valid).toBe(true);
    delete good.source;
    delete good.generated_at;
    const result = await generateInvestigationAssistance(baseSummary, makeMockLLM(JSON.stringify(good)));
    expect(result.source).toBe('llm');
    expect(result.findings_summary).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-28 — LLM path: markdown-fenced response parsed correctly
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-28: markdown-fenced response accepted', () => {
  test('AS6-28-1: ```json fenced response is parsed and accepted', async () => {
    const good = cloneAssistance();
    delete good.source;
    delete good.generated_at;
    const fenced = '```json\n' + JSON.stringify(good) + '\n```';
    const result = await generateInvestigationAssistance(baseSummary, makeMockLLM(fenced));
    expect(result.source).toBe('llm');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-29 — AI-H: LLM receives summary, not raw evidence rows
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-29: AI-H — LLM prompt contains summary, not raw CSV rows', () => {
  test('AS6-29-1: prompt contains case_id and hypothesis assessments but not raw evidence row fields', async () => {
    let capturedMessages = null;
    const inspectingFactory = () => ({
      invoke: async (messages) => {
        capturedMessages = messages;
        const good = cloneAssistance();
        delete good.source;
        delete good.generated_at;
        return { content: JSON.stringify(good) };
      },
    });
    await generateInvestigationAssistance(baseSummary, inspectingFactory);
    expect(capturedMessages).not.toBeNull();
    const promptText = capturedMessages
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    // Must contain high-level analysis fields.
    expect(promptText).toContain(CASE_ID);
    expect(promptText).toContain('causal_attribution_established');
    expect(promptText).toContain('hypothesis_id');
    // Must NOT contain raw evidence data fields.
    const userMessage = capturedMessages.find((m) => m.constructor && m.constructor.name === 'HumanMessage');
    if (userMessage) {
      const userText = typeof userMessage.content === 'string'
        ? userMessage.content : JSON.stringify(userMessage.content);
      expect(userText).not.toMatch(/"value"\s*:\s*[\d.-]+/);
      expect(userText).not.toMatch(/"resolution"\s*:\s*"[^"]+min"/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS6-30 — generateInvestigationAssistance falls back when no LLM configured
// ─────────────────────────────────────────────────────────────────────────────
describe('AS6-30: heuristic when no LLM configured', () => {
  test('AS6-30-1: source is "heuristic" when no WATSONX_AI_APIKEY', async () => {
    expect(process.env.WATSONX_AI_APIKEY).toBeFalsy();
    const result = await generateInvestigationAssistance(baseSummary);
    expect(result.source).toBe('heuristic');
  });
});

// =============================================================================
// Phase 8.4 — AR-11: Assessment Identity Lock adversarial tests
//
// Galaxy-15 deterministic assessments (must never change):
//   H1 → mixed
//   H2 → mixed
//   H3 → supported
//   H4 → insufficient_evidence
//   H5 → strongly_supported
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// Helpers for Phase 8.4 tests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a hypothesis_assessments array from the baseSummary hypotheses,
 * with an optional override function applied to individual entries.
 *
 * @param {function} [override] — receives (entry, index) and may mutate it.
 */
function buildHypothesisAssessments(override) {
  const assessments = baseSummary.hypotheses.map((h) => ({
    hypothesis_id: h.hypothesis_id,
    assessment:    h.assessment,
  }));
  if (override) assessments.forEach(override);
  return assessments;
}

/**
 * Call validateAssistanceResponse with the full four-argument signature that
 * activates AR-11, using baseSummary.hypotheses as the authoritative source.
 */
function validateWithAR11(parsed) {
  return validateAssistanceResponse(
    parsed,
    baseSummary.forensic_conclusion,
    getObservedIds(),
    baseSummary.hypotheses,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AS8-1 — AR-11: positive test — exact deterministic assessments pass
// ─────────────────────────────────────────────────────────────────────────────
describe('AS8-1: AR-11 positive test — exact deterministic assessments pass', () => {
  test('AS8-1-1: heuristic output already contains correct hypothesis_assessments', () => {
    const { valid, errors } = validateWithAR11(baseAssistance);
    expect(errors.filter((e) => e.includes('AR-11'))).toHaveLength(0);
    expect(valid).toBe(true);
  });

  test('AS8-1-2: explicitly correct assessments pass for all five hypotheses', () => {
    const ok = cloneAssistance();
    ok.hypothesis_assessments = buildHypothesisAssessments();
    const { valid, errors } = validateWithAR11(ok);
    expect(errors.filter((e) => e.includes('AR-11'))).toHaveLength(0);
    expect(valid).toBe(true);
  });

  test('AS8-1-3: heuristic hypothesis_assessments exactly mirrors source hypotheses', () => {
    for (const h of baseSummary.hypotheses) {
      const ha = baseAssistance.hypothesis_assessments.find(
        (x) => x.hypothesis_id === h.hypothesis_id,
      );
      expect(ha).toBeDefined();
      expect(ha.assessment).toBe(h.assessment);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS8-2 — AR-11: H1 receives H2's assessment (swapped)
// ─────────────────────────────────────────────────────────────────────────────
describe('AS8-2: AR-11 rejects H1 receiving H2 assessment', () => {
  test('AS8-2-1: H1 assessment changed from mixed to mixed — both are mixed so same value', () => {
    // H1 and H2 share 'mixed' so swapping them yields no visible change.
    // Test with H1 → supported (H3's value) to ensure the check fires.
    const bad = cloneAssistance();
    bad.hypothesis_assessments = buildHypothesisAssessments((ha) => {
      if (ha.hypothesis_id === 'H1') ha.assessment = 'supported'; // H3's value
    });
    const { valid, errors } = validateWithAR11(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-11') && e.includes('H1'))).toBe(true);
  });

  test('AS8-2-2: H1 assessment set to H3 value "supported" is rejected', () => {
    const bad = cloneAssistance();
    bad.hypothesis_assessments = buildHypothesisAssessments((ha) => {
      if (ha.hypothesis_id === 'H1') ha.assessment = 'supported';
    });
    const { valid, errors } = validateWithAR11(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-11') && e.includes('H1') && e.includes('supported'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS8-3 — AR-11: H2 receives H1's assessment (swapped)
// ─────────────────────────────────────────────────────────────────────────────
describe('AS8-3: AR-11 rejects H2 receiving H1 assessment', () => {
  test('AS8-3-1: H2 assessment set to strongly_supported (H5 value) is rejected', () => {
    const bad = cloneAssistance();
    bad.hypothesis_assessments = buildHypothesisAssessments((ha) => {
      if (ha.hypothesis_id === 'H2') ha.assessment = 'strongly_supported';
    });
    const { valid, errors } = validateWithAR11(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-11') && e.includes('H2') && e.includes('strongly_supported'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS8-4 — AR-11: H3 changed from supported to mixed
// ─────────────────────────────────────────────────────────────────────────────
describe('AS8-4: AR-11 rejects H3 changed from supported to mixed', () => {
  test('AS8-4-1: H3 assessment changed from supported to mixed is rejected', () => {
    const bad = cloneAssistance();
    bad.hypothesis_assessments = buildHypothesisAssessments((ha) => {
      if (ha.hypothesis_id === 'H3') ha.assessment = 'mixed';
    });
    const { valid, errors } = validateWithAR11(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-11') && e.includes('H3') && e.includes('mixed'))).toBe(true);
    // Confirm the error mentions the expected value.
    expect(errors.some((e) => e.includes('AR-11') && e.includes('H3') && e.includes('supported'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS8-5 — AR-11: H4 changed from insufficient_evidence to supported
// ─────────────────────────────────────────────────────────────────────────────
describe('AS8-5: AR-11 rejects H4 changed from insufficient_evidence to supported', () => {
  test('AS8-5-1: H4 assessment changed to supported is rejected', () => {
    const bad = cloneAssistance();
    bad.hypothesis_assessments = buildHypothesisAssessments((ha) => {
      if (ha.hypothesis_id === 'H4') ha.assessment = 'supported';
    });
    const { valid, errors } = validateWithAR11(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-11') && e.includes('H4'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS8-6 — AR-11: H5 changed from strongly_supported to mixed
// ─────────────────────────────────────────────────────────────────────────────
describe('AS8-6: AR-11 rejects H5 changed from strongly_supported to mixed', () => {
  test('AS8-6-1: H5 assessment changed from strongly_supported to mixed is rejected', () => {
    const bad = cloneAssistance();
    bad.hypothesis_assessments = buildHypothesisAssessments((ha) => {
      if (ha.hypothesis_id === 'H5') ha.assessment = 'mixed';
    });
    const { valid, errors } = validateWithAR11(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-11') && e.includes('H5') && e.includes('mixed'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS8-7 — AR-11: all assessments shifted by one hypothesis (rotation attack)
// ─────────────────────────────────────────────────────────────────────────────
describe('AS8-7: AR-11 rejects all assessments shifted by one hypothesis', () => {
  test('AS8-7-1: each hypothesis receives the next hypothesis assessment — rejected', () => {
    const sourceOrder = baseSummary.hypotheses;
    const bad = cloneAssistance();
    // Rotate: H[i] gets H[i+1 mod n]'s assessment.
    bad.hypothesis_assessments = sourceOrder.map((h, i) => ({
      hypothesis_id: h.hypothesis_id,
      assessment:    sourceOrder[(i + 1) % sourceOrder.length].assessment,
    }));
    const { valid, errors } = validateWithAR11(bad);
    expect(valid).toBe(false);
    // At least one AR-11 error must fire (rotation changes at least one non-identical value).
    expect(errors.some((e) => e.includes('AR-11'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS8-8 — AR-11: valid vocabulary but incorrect source assessment
// ─────────────────────────────────────────────────────────────────────────────
describe('AS8-8: AR-11 rejects valid vocabulary but wrong assessment value', () => {
  test('AS8-8-1: H3 set to weakly_supported (valid vocabulary, wrong value) is rejected', () => {
    const bad = cloneAssistance();
    bad.hypothesis_assessments = buildHypothesisAssessments((ha) => {
      if (ha.hypothesis_id === 'H3') ha.assessment = 'weakly_supported';
    });
    const { valid, errors } = validateWithAR11(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-11') && e.includes('H3'))).toBe(true);
  });

  test('AS8-8-2: H4 set to weakly_supported (valid vocabulary, wrong value) is rejected', () => {
    const bad = cloneAssistance();
    bad.hypothesis_assessments = buildHypothesisAssessments((ha) => {
      if (ha.hypothesis_id === 'H4') ha.assessment = 'weakly_supported';
    });
    const { valid, errors } = validateWithAR11(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-11') && e.includes('H4'))).toBe(true);
  });

  test('AS8-8-3: H5 set to supported (valid vocabulary, wrong value) is rejected', () => {
    const bad = cloneAssistance();
    bad.hypothesis_assessments = buildHypothesisAssessments((ha) => {
      if (ha.hypothesis_id === 'H5') ha.assessment = 'supported';
    });
    const { valid, errors } = validateWithAR11(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-11') && e.includes('H5'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS8-9 — AR-11: missing hypothesis assessments
// ─────────────────────────────────────────────────────────────────────────────
describe('AS8-9: AR-11 rejects missing hypothesis assessments', () => {
  test('AS8-9-1: hypothesis_assessments not an array is rejected', () => {
    const bad = cloneAssistance();
    delete bad.hypothesis_assessments;
    const { valid, errors } = validateWithAR11(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-11') && e.includes('array'))).toBe(true);
  });

  test('AS8-9-2: empty hypothesis_assessments array is rejected (count mismatch)', () => {
    const bad = cloneAssistance();
    bad.hypothesis_assessments = [];
    const { valid, errors } = validateWithAR11(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-11'))).toBe(true);
  });

  test('AS8-9-3: H5 omitted from hypothesis_assessments is rejected', () => {
    const bad = cloneAssistance();
    bad.hypothesis_assessments = buildHypothesisAssessments().filter(
      (ha) => ha.hypothesis_id !== 'H5',
    );
    const { valid, errors } = validateWithAR11(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-11') && e.includes('H5'))).toBe(true);
  });

  test('AS8-9-4: H1 omitted from hypothesis_assessments is rejected', () => {
    const bad = cloneAssistance();
    bad.hypothesis_assessments = buildHypothesisAssessments().filter(
      (ha) => ha.hypothesis_id !== 'H1',
    );
    const { valid, errors } = validateWithAR11(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-11') && e.includes('H1'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS8-10 — AR-11: duplicate hypothesis IDs
// ─────────────────────────────────────────────────────────────────────────────
describe('AS8-10: AR-11 rejects duplicate hypothesis IDs', () => {
  test('AS8-10-1: H1 appears twice in hypothesis_assessments is rejected', () => {
    const bad = cloneAssistance();
    bad.hypothesis_assessments = buildHypothesisAssessments();
    bad.hypothesis_assessments.push({ hypothesis_id: 'H1', assessment: 'mixed' });
    const { valid, errors } = validateWithAR11(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-11') && e.includes('duplicate') && e.includes('H1'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS8-11 — AR-11: unknown hypothesis IDs
// ─────────────────────────────────────────────────────────────────────────────
describe('AS8-11: AR-11 rejects unknown hypothesis IDs', () => {
  test('AS8-11-1: fabricated hypothesis_id H9 is rejected', () => {
    const bad = cloneAssistance();
    bad.hypothesis_assessments = buildHypothesisAssessments();
    bad.hypothesis_assessments.push({ hypothesis_id: 'H9', assessment: 'supported' });
    const { valid, errors } = validateWithAR11(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-11') && e.includes('H9'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS8-12 — AR-11: LLM path fallback when hypothesis_assessments tampered
// ─────────────────────────────────────────────────────────────────────────────
describe('AS8-12: AR-11 triggers fallback when LLM tampers with hypothesis_assessments', () => {
  test('AS8-12-1: LLM swaps H3 from supported to mixed → AR-11 → heuristic fallback', async () => {
    const bad = cloneAssistance();
    bad.hypothesis_assessments = buildHypothesisAssessments((ha) => {
      if (ha.hypothesis_id === 'H3') ha.assessment = 'mixed';
    });
    delete bad.source;
    delete bad.generated_at;
    const result = await generateInvestigationAssistance(baseSummary, makeMockLLM(JSON.stringify(bad)));
    expect(result.source).toBe('heuristic');
    // The heuristic fallback must have the correct H3 assessment.
    const h3 = result.hypothesis_assessments.find((ha) => ha.hypothesis_id === 'H3');
    expect(h3).toBeDefined();
    expect(h3.assessment).toBe('supported');
  });

  test('AS8-12-2: LLM missing hypothesis_assessments entirely → AR-11 → heuristic fallback', async () => {
    const bad = cloneAssistance();
    delete bad.hypothesis_assessments;
    delete bad.source;
    delete bad.generated_at;
    const result = await generateInvestigationAssistance(baseSummary, makeMockLLM(JSON.stringify(bad)));
    expect(result.source).toBe('heuristic');
  });

  test('AS8-12-3: LLM H4 changed from insufficient_evidence to supported → fallback', async () => {
    const bad = cloneAssistance();
    bad.hypothesis_assessments = buildHypothesisAssessments((ha) => {
      if (ha.hypothesis_id === 'H4') ha.assessment = 'supported';
    });
    delete bad.source;
    delete bad.generated_at;
    const result = await generateInvestigationAssistance(baseSummary, makeMockLLM(JSON.stringify(bad)));
    expect(result.source).toBe('heuristic');
  });

  test('AS8-12-4: LLM H5 changed from strongly_supported to mixed → fallback', async () => {
    const bad = cloneAssistance();
    bad.hypothesis_assessments = buildHypothesisAssessments((ha) => {
      if (ha.hypothesis_id === 'H5') ha.assessment = 'mixed';
    });
    delete bad.source;
    delete bad.generated_at;
    const result = await generateInvestigationAssistance(baseSummary, makeMockLLM(JSON.stringify(bad)));
    expect(result.source).toBe('heuristic');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS8-13 — AR-11: heuristic fallback output is valid under AR-11
// ─────────────────────────────────────────────────────────────────────────────
describe('AS8-13: heuristic fallback passes AR-11', () => {
  test('AS8-13-1: buildAssistanceHeuristic output passes validateAssistanceResponse with sourceHypotheses', () => {
    const result = buildAssistanceHeuristic(baseSummary);
    const { valid, errors } = validateWithAR11(result);
    expect(errors.filter((e) => e.includes('AR-11'))).toHaveLength(0);
    expect(valid).toBe(true);
  });

  test('AS8-13-2: heuristic hypothesis_assessments count matches source hypotheses count', () => {
    const result = buildAssistanceHeuristic(baseSummary);
    expect(result.hypothesis_assessments).toHaveLength(baseSummary.hypotheses.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AS8-14 — Backward compatibility: existing three-arg call still works
// ─────────────────────────────────────────────────────────────────────────────
describe('AS8-14: backward compatibility — three-arg call omits AR-11', () => {
  test('AS8-14-1: three-arg call with tampered assessments does NOT trigger AR-11 errors', () => {
    // Without the fourth argument, AR-11 is inactive — preserving backward
    // compatibility with callers that do not have a sourceHypotheses list.
    const bad = cloneAssistance();
    bad.hypothesis_assessments = buildHypothesisAssessments((ha) => {
      if (ha.hypothesis_id === 'H3') ha.assessment = 'mixed'; // wrong value
    });
    const { errors } = validateAssistanceResponse(
      bad,
      baseSummary.forensic_conclusion,
      getObservedIds(),
      // no fourth argument
    );
    expect(errors.filter((e) => e.includes('AR-11'))).toHaveLength(0);
  });
});
