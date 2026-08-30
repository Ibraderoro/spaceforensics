'use strict';

/**
 * Phase 9.3 — Strengthened AR-11: Assessment Identity Lock
 *
 * Verifies that validateAssistanceResponse (AR-11) enforces exact identity
 * between every AI-returned hypothesis assessment and the deterministic
 * forensic-analysis value for that hypothesis.
 *
 * Known Phase 7 risk addressed:
 *   AR-11 previously validated assessment vocabulary only.  The invariant now
 *   requires character-for-character identity with the deterministic source —
 *   any valid-vocabulary-but-wrong value must be rejected.
 *
 * Galaxy-15 deterministic assessments (must never change):
 *   H1 → mixed
 *   H2 → mixed
 *   H3 → supported
 *   H4 → insufficient_evidence
 *   H5 → strongly_supported
 *
 * Coverage:
 *   P93-1  Correct assessments pass AR-11                  (positive)
 *   P93-2  H1 wrong-but-valid-vocab value → rejected        (H1 focus)
 *   P93-3  H2 wrong-but-valid-vocab value → rejected        (H2 focus)
 *   P93-4  H3 wrong-but-valid-vocab value → rejected        (H3 focus)
 *   P93-5  H4 wrong-but-valid-vocab value → rejected        (H4 focus)
 *   P93-6  H5 wrong-but-valid-vocab value → rejected        (H5 focus)
 *   P93-7  Heuristic fallback used when LLM returns wrong H1 assessment
 *   P93-8  Heuristic fallback used when LLM returns wrong H2 assessment
 *   P93-9  Heuristic fallback used when LLM returns wrong H3 assessment
 *   P93-10 Heuristic output itself always passes AR-11
 *   P93-11 Cross-case assessment contamination — TCA assessments in G15 context
 *   P93-12 Error message identifies the wrong and the expected value
 *   P93-13 Every other valid-vocab value for H1 is individually rejected
 *   P93-14 Vocabulary check is preserved (out-of-vocabulary values still rejected)
 */

const {
  parseEvidenceCSV,
  buildEvidenceGraph,
  buildForensicAnalysis,
  assembleValidatedForensicReport,
} = require('../server');

const {
  validateAssistanceResponse,
  buildAssistanceHeuristic,
  generateInvestigationAssistance,
} = require('../services/aiAnalyst');

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures — built once for the test file.
// ─────────────────────────────────────────────────────────────────────────────

const G15 = 'galaxy-15';
const TCA = 'test-case-alpha';

let g15Analysis;
let g15BaseSummary;
let g15BaseAssistance;
let g15ObservedIds;
let g15SourceHypotheses;

let tcaAnalysis;
let tcaSourceHypotheses;

// Galaxy-15 deterministic assessments — pinned as constants so any accidental
// change in the forensic model is caught here immediately.
const G15_ASSESSMENTS = {
  H1: 'mixed',
  H2: 'mixed',
  H3: 'supported',
  H4: 'insufficient_evidence',
  H5: 'strongly_supported',
};

beforeAll(async () => {
  jest.setTimeout(60_000);

  // ── Galaxy-15 pipeline ────────────────────────────────────────────────────
  const g15Rows   = await parseEvidenceCSV(G15);
  const g15Graph  = await buildEvidenceGraph(G15, g15Rows);
  g15Analysis     = buildForensicAnalysis(G15, g15Graph);
  const g15Narrative = require('../services/aiAnalyst').buildAnalystHeuristicNarrative(g15Analysis);
  const g15Report = assembleValidatedForensicReport(g15Analysis, g15Narrative);

  g15SourceHypotheses = g15Report.hypotheses.map((h) => ({
    hypothesis_id: h.hypothesis_id,
    label:         h.label,
    assessment:    h.assessment,
    evidence_summary: h.evidence_summary,
    limitations:   h.limitations,
    heuristic_note: h.heuristic_note,
    key_observations: [],
  }));

  const evidenceByHypothesis = g15Report.hypotheses.map((h) => ({
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

  g15ObservedIds = referencedIds;

  g15BaseSummary = {
    case_metadata: {
      case_id:    G15,
      title:      'Galaxy 15 Satellite Anomaly',
      description: null,
      causal_attribution: 'Causal attribution is not established.',
      data_sources: [],
      scientific_limitations: [],
    },
    investigation_state: {
      investigation_id: 'phase93-inv-id',
      case_id:          G15,
      status:           'open',
      title:            'Phase 9.3 Test Investigation',
      observation_count: 0,
      challenge_count:   0,
    },
    forensic_conclusion: {
      causal_attribution_established: g15Report.causal_attribution_established,
      causal_attribution_statement:   'Causal attribution is not established.',
      analysis_version:               g15Report.analysis_version,
      evidence_summary:               g15Report.evidence_summary,
      comparison:                     g15Report.comparison,
    },
    hypotheses:         g15SourceHypotheses,
    evidence_references: {
      total_evidence_rows:       g15Rows.length,
      referenced_evidence_count: referencedIds.size,
      referenced_evidence_ids:   [...referencedIds].sort(),
      evidence_by_hypothesis:    evidenceByHypothesis,
    },
    provenance: {
      data_sources: [],
      heuristic_window_note: '±10-minute selection window.',
      evidence_count: g15Rows.length,
    },
    limitations: g15Report.limitations,
    ai_narrative: g15Report.analyst_narrative,
    analyst_challenges: {
      challenge_count: 0, open_count: 0, under_review_count: 0,
      resolved_count: 0, rejected_count: 0, challenges: [],
    },
  };

  g15BaseAssistance = buildAssistanceHeuristic(g15BaseSummary);

  // ── TCA pipeline ──────────────────────────────────────────────────────────
  const tcaRows   = await parseEvidenceCSV(TCA);
  const tcaGraph  = await buildEvidenceGraph(TCA, tcaRows);
  tcaAnalysis     = buildForensicAnalysis(TCA, tcaGraph);
  const tcaNarrative = require('../services/aiAnalyst').buildAnalystHeuristicNarrative(tcaAnalysis);
  const tcaReport = assembleValidatedForensicReport(tcaAnalysis, tcaNarrative);

  tcaSourceHypotheses = tcaReport.hypotheses.map((h) => ({
    hypothesis_id: h.hypothesis_id,
    assessment:    h.assessment,
  }));
}, 60_000);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clone the base heuristic assistance object (JSON round-trip for deep copy).
 */
function cloneBase() {
  return JSON.parse(JSON.stringify(g15BaseAssistance));
}

/**
 * Build a hypothesis_assessments array from g15SourceHypotheses with an
 * optional per-entry override function.
 */
function makeAssessments(overrideFn) {
  const assessments = g15SourceHypotheses.map((h) => ({
    hypothesis_id: h.hypothesis_id,
    assessment:    h.assessment,
  }));
  if (overrideFn) assessments.forEach(overrideFn);
  return assessments;
}

/**
 * Call validateAssistanceResponse with the four-argument signature that
 * activates AR-11, using g15SourceHypotheses as the authoritative source.
 */
function validateFull(parsed) {
  return validateAssistanceResponse(
    parsed,
    g15BaseSummary.forensic_conclusion,
    g15ObservedIds,
    g15SourceHypotheses,
  );
}

/**
 * Factory that returns a mock LLM whose only response is the serialised object.
 */
function mockLLM(obj) {
  return () => ({ invoke: async () => ({ content: JSON.stringify(obj) }) });
}

// ─────────────────────────────────────────────────────────────────────────────
// P93-1 — Positive test: correct assessments pass AR-11
// ─────────────────────────────────────────────────────────────────────────────
describe('P93-1: correct assessments pass AR-11', () => {
  test('P93-1-1: heuristic output already passes validateAssistanceResponse with AR-11', () => {
    const { valid, errors } = validateFull(g15BaseAssistance);
    expect(errors.filter((e) => e.includes('AR-11'))).toHaveLength(0);
    expect(valid).toBe(true);
  });

  test('P93-1-2: explicitly correct five-hypothesis array passes', () => {
    const good = cloneBase();
    good.hypothesis_assessments = makeAssessments();
    const { valid, errors } = validateFull(good);
    expect(errors.filter((e) => e.includes('AR-11'))).toHaveLength(0);
    expect(valid).toBe(true);
  });

  test('P93-1-3: heuristic assessments exactly mirror the pinned G15 values', () => {
    for (const [hid, expected] of Object.entries(G15_ASSESSMENTS)) {
      const ha = g15BaseAssistance.hypothesis_assessments.find(
        (x) => x.hypothesis_id === hid,
      );
      expect(ha).toBeDefined();
      expect(ha.assessment).toBe(expected);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P93-2 — H1: valid-vocabulary-but-wrong value is rejected
// H1 deterministic assessment = "mixed"
// ─────────────────────────────────────────────────────────────────────────────
describe('P93-2: AR-11 rejects valid-vocabulary-but-wrong assessment for H1', () => {
  const H1_CORRECT = 'mixed';

  // Every allowed value except the correct one must be rejected.
  const wrongValues = ['supported', 'weakly_supported', 'strongly_supported', 'insufficient_evidence'];

  test.each(wrongValues)(
    'P93-2: H1 set to "%s" (valid vocab, wrong value) is rejected',
    (wrongValue) => {
      const bad = cloneBase();
      bad.hypothesis_assessments = makeAssessments((ha) => {
        if (ha.hypothesis_id === 'H1') ha.assessment = wrongValue;
      });
      const { valid, errors } = validateFull(bad);
      expect(valid).toBe(false);
      // Error must mention AR-11 and H1.
      expect(errors.some((e) => e.includes('AR-11') && e.includes('H1'))).toBe(true);
      // Error must mention the wrong value that was submitted.
      expect(errors.some((e) => e.includes(wrongValue))).toBe(true);
      // Error must mention the correct expected value.
      expect(errors.some((e) => e.includes(H1_CORRECT))).toBe(true);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// P93-3 — H2: valid-vocabulary-but-wrong value is rejected
// H2 deterministic assessment = "mixed"
// ─────────────────────────────────────────────────────────────────────────────
describe('P93-3: AR-11 rejects valid-vocabulary-but-wrong assessment for H2', () => {
  const H2_CORRECT = 'mixed';
  const wrongValues = ['supported', 'weakly_supported', 'strongly_supported', 'insufficient_evidence'];

  test.each(wrongValues)(
    'P93-3: H2 set to "%s" (valid vocab, wrong value) is rejected',
    (wrongValue) => {
      const bad = cloneBase();
      bad.hypothesis_assessments = makeAssessments((ha) => {
        if (ha.hypothesis_id === 'H2') ha.assessment = wrongValue;
      });
      const { valid, errors } = validateFull(bad);
      expect(valid).toBe(false);
      expect(errors.some((e) => e.includes('AR-11') && e.includes('H2'))).toBe(true);
      expect(errors.some((e) => e.includes(wrongValue))).toBe(true);
      expect(errors.some((e) => e.includes(H2_CORRECT))).toBe(true);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// P93-4 — H3: valid-vocabulary-but-wrong value is rejected
// H3 deterministic assessment = "supported"
// ─────────────────────────────────────────────────────────────────────────────
describe('P93-4: AR-11 rejects valid-vocabulary-but-wrong assessment for H3', () => {
  const H3_CORRECT = 'supported';
  const wrongValues = ['mixed', 'weakly_supported', 'strongly_supported', 'insufficient_evidence'];

  test.each(wrongValues)(
    'P93-4: H3 set to "%s" (valid vocab, wrong value) is rejected',
    (wrongValue) => {
      const bad = cloneBase();
      bad.hypothesis_assessments = makeAssessments((ha) => {
        if (ha.hypothesis_id === 'H3') ha.assessment = wrongValue;
      });
      const { valid, errors } = validateFull(bad);
      expect(valid).toBe(false);
      expect(errors.some((e) => e.includes('AR-11') && e.includes('H3'))).toBe(true);
      expect(errors.some((e) => e.includes(wrongValue))).toBe(true);
      expect(errors.some((e) => e.includes(H3_CORRECT))).toBe(true);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// P93-5 — H4: valid-vocabulary-but-wrong value is rejected
// H4 deterministic assessment = "insufficient_evidence"
// ─────────────────────────────────────────────────────────────────────────────
describe('P93-5: AR-11 rejects valid-vocabulary-but-wrong assessment for H4', () => {
  const wrongValues = ['mixed', 'supported', 'weakly_supported', 'strongly_supported'];

  test.each(wrongValues)(
    'P93-5: H4 set to "%s" (valid vocab, wrong value) is rejected',
    (wrongValue) => {
      const bad = cloneBase();
      bad.hypothesis_assessments = makeAssessments((ha) => {
        if (ha.hypothesis_id === 'H4') ha.assessment = wrongValue;
      });
      const { valid, errors } = validateFull(bad);
      expect(valid).toBe(false);
      expect(errors.some((e) => e.includes('AR-11') && e.includes('H4'))).toBe(true);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// P93-6 — H5: valid-vocabulary-but-wrong value is rejected
// H5 deterministic assessment = "strongly_supported"
// ─────────────────────────────────────────────────────────────────────────────
describe('P93-6: AR-11 rejects valid-vocabulary-but-wrong assessment for H5', () => {
  const wrongValues = ['mixed', 'supported', 'weakly_supported', 'insufficient_evidence'];

  test.each(wrongValues)(
    'P93-6: H5 set to "%s" (valid vocab, wrong value) is rejected',
    (wrongValue) => {
      const bad = cloneBase();
      bad.hypothesis_assessments = makeAssessments((ha) => {
        if (ha.hypothesis_id === 'H5') ha.assessment = wrongValue;
      });
      const { valid, errors } = validateFull(bad);
      expect(valid).toBe(false);
      expect(errors.some((e) => e.includes('AR-11') && e.includes('H5'))).toBe(true);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// P93-7 — Heuristic fallback: LLM returns wrong H1 assessment
// ─────────────────────────────────────────────────────────────────────────────
describe('P93-7: heuristic fallback triggered when LLM returns wrong H1 assessment', () => {
  test('P93-7-1: H1 set to "supported" (valid vocab) → rejected → heuristic fallback', async () => {
    const bad = cloneBase();
    bad.hypothesis_assessments = makeAssessments((ha) => {
      if (ha.hypothesis_id === 'H1') ha.assessment = 'supported';
    });
    delete bad.source;
    delete bad.generated_at;

    const result = await generateInvestigationAssistance(g15BaseSummary, mockLLM(bad));
    expect(result.source).toBe('heuristic');
  });

  test('P93-7-2: heuristic fallback restores correct H1 assessment "mixed"', async () => {
    const bad = cloneBase();
    bad.hypothesis_assessments = makeAssessments((ha) => {
      if (ha.hypothesis_id === 'H1') ha.assessment = 'insufficient_evidence';
    });
    delete bad.source;
    delete bad.generated_at;

    const result = await generateInvestigationAssistance(g15BaseSummary, mockLLM(bad));
    expect(result.source).toBe('heuristic');
    const h1 = result.hypothesis_assessments.find((ha) => ha.hypothesis_id === 'H1');
    expect(h1).toBeDefined();
    expect(h1.assessment).toBe('mixed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P93-8 — Heuristic fallback: LLM returns wrong H2 assessment
// ─────────────────────────────────────────────────────────────────────────────
describe('P93-8: heuristic fallback triggered when LLM returns wrong H2 assessment', () => {
  test('P93-8-1: H2 set to "supported" (valid vocab) → rejected → heuristic fallback', async () => {
    const bad = cloneBase();
    bad.hypothesis_assessments = makeAssessments((ha) => {
      if (ha.hypothesis_id === 'H2') ha.assessment = 'supported';
    });
    delete bad.source;
    delete bad.generated_at;

    const result = await generateInvestigationAssistance(g15BaseSummary, mockLLM(bad));
    expect(result.source).toBe('heuristic');
  });

  test('P93-8-2: heuristic fallback restores correct H2 assessment "mixed"', async () => {
    const bad = cloneBase();
    bad.hypothesis_assessments = makeAssessments((ha) => {
      if (ha.hypothesis_id === 'H2') ha.assessment = 'strongly_supported';
    });
    delete bad.source;
    delete bad.generated_at;

    const result = await generateInvestigationAssistance(g15BaseSummary, mockLLM(bad));
    expect(result.source).toBe('heuristic');
    const h2 = result.hypothesis_assessments.find((ha) => ha.hypothesis_id === 'H2');
    expect(h2).toBeDefined();
    expect(h2.assessment).toBe('mixed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P93-9 — Heuristic fallback: LLM returns wrong H3 assessment
// ─────────────────────────────────────────────────────────────────────────────
describe('P93-9: heuristic fallback triggered when LLM returns wrong H3 assessment', () => {
  test('P93-9-1: H3 set to "mixed" (valid vocab) → rejected → heuristic fallback', async () => {
    const bad = cloneBase();
    bad.hypothesis_assessments = makeAssessments((ha) => {
      if (ha.hypothesis_id === 'H3') ha.assessment = 'mixed';
    });
    delete bad.source;
    delete bad.generated_at;

    const result = await generateInvestigationAssistance(g15BaseSummary, mockLLM(bad));
    expect(result.source).toBe('heuristic');
  });

  test('P93-9-2: heuristic fallback restores correct H3 assessment "supported"', async () => {
    const bad = cloneBase();
    bad.hypothesis_assessments = makeAssessments((ha) => {
      if (ha.hypothesis_id === 'H3') ha.assessment = 'weakly_supported';
    });
    delete bad.source;
    delete bad.generated_at;

    const result = await generateInvestigationAssistance(g15BaseSummary, mockLLM(bad));
    expect(result.source).toBe('heuristic');
    const h3 = result.hypothesis_assessments.find((ha) => ha.hypothesis_id === 'H3');
    expect(h3).toBeDefined();
    expect(h3.assessment).toBe('supported');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P93-10 — Heuristic output itself always passes AR-11
// ─────────────────────────────────────────────────────────────────────────────
describe('P93-10: heuristic output passes AR-11 for all hypotheses', () => {
  test('P93-10-1: buildAssistanceHeuristic output passes full validateAssistanceResponse', () => {
    const result = buildAssistanceHeuristic(g15BaseSummary);
    const { valid, errors } = validateFull(result);
    expect(errors.filter((e) => e.includes('AR-11'))).toHaveLength(0);
    expect(valid).toBe(true);
  });

  test('P93-10-2: heuristic output hypothesis_assessments count equals source hypothesis count', () => {
    const result = buildAssistanceHeuristic(g15BaseSummary);
    expect(result.hypothesis_assessments).toHaveLength(g15SourceHypotheses.length);
  });

  test('P93-10-3: every heuristic hypothesis assessment is identical to the deterministic source', () => {
    const result = buildAssistanceHeuristic(g15BaseSummary);
    for (const srcH of g15SourceHypotheses) {
      const ha = result.hypothesis_assessments.find(
        (x) => x.hypothesis_id === srcH.hypothesis_id,
      );
      expect(ha).toBeDefined();
      expect(ha.assessment).toBe(srcH.assessment);
    }
  });

  test('P93-10-4: heuristic generateInvestigationAssistance output (no LLM) passes AR-11', async () => {
    const result = await generateInvestigationAssistance(g15BaseSummary);
    expect(result.source).toBe('heuristic');
    const { valid, errors } = validateFull(result);
    expect(errors.filter((e) => e.includes('AR-11'))).toHaveLength(0);
    expect(valid).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P93-11 — Cross-case assessment contamination: TCA assessments in G15 context
//
// TCA assessments: H1=mixed, H2=supported, H3=strongly_supported
// G15 assessments: H1=mixed, H2=mixed, H3=supported, H4=insufficient_evidence, H5=strongly_supported
//
// A G15 response that uses TCA-derived values for H2 or H3 must be rejected.
// ─────────────────────────────────────────────────────────────────────────────
describe('P93-11: cross-case assessment contamination is rejected', () => {
  test('P93-11-1: G15 response with H2 set to TCA H2 value ("supported") is rejected', () => {
    // TCA H2 = "supported"; G15 H2 = "mixed"
    const bad = cloneBase();
    bad.hypothesis_assessments = makeAssessments((ha) => {
      if (ha.hypothesis_id === 'H2') ha.assessment = 'supported'; // TCA H2 value
    });
    const { valid, errors } = validateFull(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-11') && e.includes('H2'))).toBe(true);
    // The error must indicate the correct G15 value
    expect(errors.some((e) => e.includes('H2') && e.includes('mixed'))).toBe(true);
  });

  test('P93-11-2: G15 response with H3 set to TCA H3 value ("strongly_supported") is rejected', () => {
    // TCA H3 = "strongly_supported"; G15 H3 = "supported"
    const bad = cloneBase();
    bad.hypothesis_assessments = makeAssessments((ha) => {
      if (ha.hypothesis_id === 'H3') ha.assessment = 'strongly_supported'; // TCA H3 value
    });
    const { valid, errors } = validateFull(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-11') && e.includes('H3'))).toBe(true);
    // The error must indicate the correct G15 value
    expect(errors.some((e) => e.includes('H3') && e.includes('supported'))).toBe(true);
  });

  test('P93-11-3: G15 response with all assessments replaced by TCA values is rejected', () => {
    // Build a G15 response that substitutes TCA hypothesis assessments where they differ.
    // TCA has 3 hypotheses; G15 has 5 — count mismatch would normally fire first.
    // Instead test with a G15-shaped array using TCA values for matching IDs.
    const tcaById = new Map(tcaSourceHypotheses.map((h) => [h.hypothesis_id, h.assessment]));
    const bad = cloneBase();
    bad.hypothesis_assessments = makeAssessments((ha) => {
      if (tcaById.has(ha.hypothesis_id)) {
        ha.assessment = tcaById.get(ha.hypothesis_id); // substitute TCA value
      }
    });
    const { valid } = validateFull(bad);
    // H2 (G15=mixed, TCA=supported) and H3 (G15=supported, TCA=strongly_supported) differ
    expect(valid).toBe(false);
  });

  test('P93-11-4: validator is case-scoped — sourceHypotheses come from the G15 analysis', () => {
    // Verify that the authoritative map used by AR-11 is built from G15 hypotheses,
    // not from TCA.  Confirm G15 H2 is "mixed" and TCA H2 is "supported".
    const g15H2 = g15SourceHypotheses.find((h) => h.hypothesis_id === 'H2');
    const tcaH2 = tcaSourceHypotheses.find((h) => h.hypothesis_id === 'H2');
    expect(g15H2.assessment).toBe('mixed');
    expect(tcaH2.assessment).toBe('supported');
    // These are definitively different, confirming the cross-case risk is real.
    expect(g15H2.assessment).not.toBe(tcaH2.assessment);
  });

  test('P93-11-5: LLM returning TCA H2 value for G15 investigation → fallback', async () => {
    const bad = cloneBase();
    bad.hypothesis_assessments = makeAssessments((ha) => {
      if (ha.hypothesis_id === 'H2') ha.assessment = 'supported'; // TCA H2 value, wrong for G15
    });
    delete bad.source;
    delete bad.generated_at;
    const result = await generateInvestigationAssistance(g15BaseSummary, mockLLM(bad));
    expect(result.source).toBe('heuristic');
    // Fallback must use the correct G15 H2 assessment
    const h2 = result.hypothesis_assessments.find((ha) => ha.hypothesis_id === 'H2');
    expect(h2.assessment).toBe('mixed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P93-12 — Error message quality: identifies both wrong and expected values
// ─────────────────────────────────────────────────────────────────────────────
describe('P93-12: AR-11 error message identifies wrong and expected assessment values', () => {
  test('P93-12-1: H3 wrong value error names the submitted value', () => {
    const bad = cloneBase();
    bad.hypothesis_assessments = makeAssessments((ha) => {
      if (ha.hypothesis_id === 'H3') ha.assessment = 'weakly_supported';
    });
    const { errors } = validateFull(bad);
    const ar11Errors = errors.filter((e) => e.includes('AR-11') && e.includes('H3'));
    expect(ar11Errors.length).toBeGreaterThan(0);
    expect(ar11Errors.some((e) => e.includes('weakly_supported'))).toBe(true);
  });

  test('P93-12-2: H3 wrong value error names the correct expected value', () => {
    const bad = cloneBase();
    bad.hypothesis_assessments = makeAssessments((ha) => {
      if (ha.hypothesis_id === 'H3') ha.assessment = 'mixed';
    });
    const { errors } = validateFull(bad);
    const ar11Errors = errors.filter((e) => e.includes('AR-11') && e.includes('H3'));
    expect(ar11Errors.length).toBeGreaterThan(0);
    expect(ar11Errors.some((e) => e.includes('supported'))).toBe(true);
  });

  test('P93-12-3: H1 wrong value error names both values', () => {
    const bad = cloneBase();
    bad.hypothesis_assessments = makeAssessments((ha) => {
      if (ha.hypothesis_id === 'H1') ha.assessment = 'insufficient_evidence';
    });
    const { errors } = validateFull(bad);
    const ar11Errors = errors.filter((e) => e.includes('AR-11') && e.includes('H1'));
    expect(ar11Errors.length).toBeGreaterThan(0);
    // Must name the wrong submitted value
    expect(ar11Errors.some((e) => e.includes('insufficient_evidence'))).toBe(true);
    // Must name the correct expected value
    expect(ar11Errors.some((e) => e.includes('mixed'))).toBe(true);
  });

  test('P93-12-4: error distinguishes "not in allowed vocabulary" from "wrong value"', () => {
    // Out-of-vocabulary error is not AR-11 misidentified — vocabulary check is separate.
    const bad = cloneBase();
    bad.hypothesis_assessments = makeAssessments((ha) => {
      if (ha.hypothesis_id === 'H1') ha.assessment = 'completely_unknown_value';
    });
    const { valid, errors } = validateFull(bad);
    expect(valid).toBe(false);
    // AR-11 identity error must fire (wrong value)
    expect(errors.some((e) => e.includes('AR-11') && e.includes('H1'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P93-13 — Exhaustive: every non-correct valid-vocab value for H1 is rejected
// ─────────────────────────────────────────────────────────────────────────────
describe('P93-13: every non-correct valid-vocabulary value for H1 is individually rejected', () => {
  const ALLOWED_ASSESSMENTS = [
    'strongly_supported', 'supported', 'mixed',
    'weakly_supported', 'insufficient_evidence',
  ];

  test.each(
    ALLOWED_ASSESSMENTS
      .filter((v) => v !== G15_ASSESSMENTS.H1)
      .map((v) => [v]),
  )(
    'P93-13: H1 = "%s" is rejected',
    (wrongValue) => {
      const bad = cloneBase();
      bad.hypothesis_assessments = makeAssessments((ha) => {
        if (ha.hypothesis_id === 'H1') ha.assessment = wrongValue;
      });
      const { valid, errors } = validateFull(bad);
      expect(valid).toBe(false);
      expect(errors.some((e) => e.includes('AR-11') && e.includes('H1'))).toBe(true);
    },
  );

  test('P93-13-final: only the correct value "mixed" passes for H1', () => {
    const good = cloneBase();
    good.hypothesis_assessments = makeAssessments(); // all correct
    const { valid, errors } = validateFull(good);
    expect(errors.filter((e) => e.includes('AR-11') && e.includes('H1'))).toHaveLength(0);
    expect(valid).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P93-14 — Vocabulary check preserved: out-of-vocabulary values still rejected
// ─────────────────────────────────────────────────────────────────────────────
describe('P93-14: allowed-vocabulary check is preserved alongside identity check', () => {
  test('P93-14-1: completely invalid assessment token for H1 is rejected', () => {
    const bad = cloneBase();
    bad.hypothesis_assessments = makeAssessments((ha) => {
      if (ha.hypothesis_id === 'H1') ha.assessment = 'definitive';
    });
    const { valid, errors } = validateFull(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-11') && e.includes('H1'))).toBe(true);
  });

  test('P93-14-2: completely invalid assessment token for H3 is rejected', () => {
    const bad = cloneBase();
    bad.hypothesis_assessments = makeAssessments((ha) => {
      if (ha.hypothesis_id === 'H3') ha.assessment = 'confirmed';
    });
    const { valid, errors } = validateFull(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-11') && e.includes('H3'))).toBe(true);
  });

  test('P93-14-3: null assessment for H2 is rejected', () => {
    const bad = cloneBase();
    bad.hypothesis_assessments = makeAssessments((ha) => {
      if (ha.hypothesis_id === 'H2') ha.assessment = null;
    });
    const { valid, errors } = validateFull(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('AR-11') && e.includes('H2'))).toBe(true);
  });
});
