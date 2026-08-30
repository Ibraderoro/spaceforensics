'use strict';

// ---------------------------------------------------------------------------
// Phase 7.5 — artifactService unit tests
//
// Groups:
//   AS-1   serializeStable — deterministic key ordering
//   AS-2   computeArtifactDigest — stability and sensitivity
//   AS-3   assembleArtifact — section presence and structural rules
//   AS-4   assembleArtifact — ART invariants (evidence refs, layer tags, etc.)
//   AS-5   validateArtifact — accepts valid artifacts
//   AS-6   validateArtifact — V-SCH, V-CAU, V-HYP, V-SEP, V-PROB, V-LAYER,
//                             V-ALAYER, V-DIG, V-REF, V-NODUP
//   AS-7   verifyArtifactIntegrity — round-trip and tamper detection
//   AS-8   Galaxy-15 forensic preservation
// ---------------------------------------------------------------------------

const {
  assembleArtifact,
  validateArtifact,
  verifyArtifactIntegrity,
  computeArtifactDigest,
  serializeStable,
  ARTIFACT_SCHEMA_VERSION,
  ARTIFACT_GENERATOR,
} = require('../services/artifactService');

// ---------------------------------------------------------------------------
// Minimal fixture builders
// ---------------------------------------------------------------------------

function makeReport(overrides = {}) {
  return {
    case_id:                        'test-case',
    analysis_version:               '4.3.0',
    causal_attribution_established: false,
    event: {
      timestamp:   '2010-04-05T09:48:00Z',
      label:       'anomaly',
      description: 'Test anomaly.',
      recovery:    { timestamp: '2010-12-26T00:00:00Z', label: 'recovery', description: 'Recovery.' },
      target_asset: { name: 'TestSat', alias: 'TS-1', norad_id: 99999,
                      orbit_type: 'GEO', longitude_deg_west: -100, operator: 'TestCo', spacecraft_bus: 'TBD' },
      data_window: { start: '2010-04-05T08:00:00Z', end: '2010-04-05T11:00:00Z', duration_minutes: 180 },
    },
    evidence_summary: {
      total_environmental_context: 4,
      total_supporting_evidence:   1,
      total_contradicting_evidence: 0,
      total_non_discriminating_evidence: 2,
      total_limitations: 3,
    },
    comparison: {
      assessed_hypotheses:     ['H1', 'H2'],
      supported_hypotheses:    ['H2'],
      mixed_hypotheses:        ['H1'],
      insufficient_hypotheses: [],
      most_supported:          'H2',
    },
    hypothesis_comparison: [],
    hypotheses: [
      {
        hypothesis_id: 'H1',
        label:         'Test H1',
        assessment:    'mixed',
        heuristic_note: null,
        evidence_summary: {
          environmental_context_count:        2,
          supporting_evidence_count:          0,
          contradicting_evidence_count:       0,
          non_discriminating_evidence_count:  1,
          environmental_context_ids:          ['E-TC-0001', 'E-TC-0002'],
          supporting_evidence_ids:            [],
          contradicting_evidence_ids:         [],
          non_discriminating_evidence_ids:    ['E-TC-0010'],
        },
        limitations: [{ type: 'proxy_measurement', description: 'Proxy data only.' }],
      },
      {
        hypothesis_id: 'H2',
        label:         'Test H2',
        assessment:    'supported',
        heuristic_note: null,
        evidence_summary: {
          environmental_context_count:        0,
          supporting_evidence_count:          1,
          contradicting_evidence_count:       0,
          non_discriminating_evidence_count:  0,
          environmental_context_ids:          [],
          supporting_evidence_ids:            ['E-TC-0005'],
          contradicting_evidence_ids:         [],
          non_discriminating_evidence_ids:    [],
        },
        limitations: [{ type: 'missing_data', description: 'Telemetry absent.' }],
      },
    ],
    limitations: [
      { type: 'proxy_measurement', description: 'Proxy data only.' },
      { type: 'missing_data',      description: 'Telemetry absent.' },
    ],
    analyst_narrative: {
      source:                         'heuristic',
      causal_attribution_established: false,
      executive_summary:              'Forensic analysis of test-case. Causal attribution has not been established.',
      event_description:              'Anomaly at 2010-04-05T09:48:00Z.',
      hypothesis_assessments: [
        {
          hypothesis_id: 'H1',
          assessment:    'mixed',
          reasoning:     '2 environmental context records. Assessment: mixed.',
          evidence_ids:  ['E-TC-0001', 'E-TC-0002', 'E-TC-0010'],
          limitations:   ['Proxy data only.'],
        },
        {
          hypothesis_id: 'H2',
          assessment:    'supported',
          reasoning:     '1 record directly consistent. Assessment: supported.',
          evidence_ids:  ['E-TC-0005'],
          limitations:   ['Telemetry absent.'],
        },
      ],
      strongest_observations: ['Environmental context documented.'],
      major_uncertainties:    ['Causal mechanism not established.'],
      missing_evidence:       ['Spacecraft telemetry absent.'],
    },
    ...overrides,
  };
}

function makeCaseMeta(overrides = {}) {
  return {
    case_id:      'test-case',
    title:        'Test Case',
    description:  'A test case.',
    causal_attribution: 'Not established.',
    anchor_event: { timestamp: '2010-04-05T09:48:00Z', label: 'anomaly', description: 'Test.' },
    recovery_event: null,
    target_asset:   null,
    data_window:    null,
    data_sources: [
      { dataset_id: 'DS1', description: 'Dataset 1', variable: 'V1',
        measurement: 'm1', unit: 'u', resolution: '5min', provider: 'NASA' },
    ],
    scientific_limitations: ['Proxy measurement only.'],
    ...overrides,
  };
}

function makeRows(count = 20) {
  return Array.from({ length: count }, (_, i) => ({
    evidence_id: `E-TC-${String(i + 1).padStart(4, '0')}`,
    timestamp:   `2010-04-05T09:${String(i).padStart(2, '0')}:00Z`,
    source:      'TEST_DS',
    measurement: 'test',
    value:       i,
    unit:        'u',
    resolution:  '1min',
    dataset_id:  'DS1',
    provider:    'NASA',
    variable:    'V1',
    evidence_type: 'environmental_observation',
    quality:     null,
  }));
}

function makeInvestigation(overrides = {}) {
  return {
    investigation_id: 'inv-0001-0000-0000-000000000001',
    case_id:          'test-case',
    title:            'Test Investigation',
    description:      null,
    opened_by:        'tester',
    opened_at:        '2026-01-01T00:00:00.000Z',
    status:           'open',
    events:           [{ event: 'opened', actor: 'tester', timestamp: '2026-01-01T00:00:00.000Z', reason: null }],
    ...overrides,
  };
}

function makeObservation(overrides = {}) {
  return {
    observation_id:   'obs-0001',
    investigation_id: 'inv-0001-0000-0000-000000000001',
    authored_by:      'tester',
    authored_at:      '2026-01-02T00:00:00.000Z',
    status:           'published',
    versions: [{ version: 1, text: 'Test observation.', authored_by: 'tester', authored_at: '2026-01-02T00:00:00.000Z' }],
    evidence_ids:   ['E-TC-0001'],
    hypothesis_ids: ['H1'],
    ...overrides,
  };
}

function makeChallenge(overrides = {}) {
  return {
    challenge_id:        'ch-0001',
    investigation_id:    'inv-0001-0000-0000-000000000001',
    case_id:             'test-case',
    target_type:         'hypothesis_assessment',
    target_id:           'H1',
    authored_by:         'tester',
    created_at:          '2026-01-03T00:00:00.000Z',
    analyst_statement:   'The mixed assessment seems inconsistent.',
    status:              'open',
    evidence_ids:        ['E-TC-0001'],
    lifecycle:           [{ status: 'open', actor: 'tester', timestamp: '2026-01-03T00:00:00.000Z', notes: null }],
    resolution_metadata: null,
    ...overrides,
  };
}

// Build a complete valid artifact for use across test groups.
function buildValidArtifact(opts = {}) {
  return assembleArtifact({
    caseMeta:           makeCaseMeta(opts.caseMeta),
    report:             makeReport(opts.report),
    rows:               opts.rows || makeRows(),
    heuristicWindowNote: opts.heuristicWindowNote || '±10-minute selection window.',
    investigation:      makeInvestigation(opts.investigation),
    observations:       opts.observations || [makeObservation()],
    challenges:         opts.challenges   || [makeChallenge()],
  });
}

// ===========================================================================
// AS-1 — serializeStable
// ===========================================================================
describe('AS-1: serializeStable', () => {
  test('AS-1-1: sorts object keys alphabetically', () => {
    const result = serializeStable({ z: 1, a: 2, m: 3 });
    expect(result).toBe('{"a":2,"m":3,"z":1}');
  });

  test('AS-1-2: nested objects are also key-sorted', () => {
    const result = serializeStable({ b: { d: 4, c: 3 }, a: 1 });
    expect(result).toBe('{"a":1,"b":{"c":3,"d":4}}');
  });

  test('AS-1-3: arrays preserve element order', () => {
    const result = serializeStable({ arr: [3, 1, 2] });
    expect(result).toBe('{"arr":[3,1,2]}');
  });

  test('AS-1-4: two objects with same keys/values but different insertion order produce identical output', () => {
    const a = serializeStable({ z: 99, a: 1 });
    const b = serializeStable({ a: 1,  z: 99 });
    expect(a).toBe(b);
  });

  test('AS-1-5: null, string, number, boolean are serialised as JSON', () => {
    expect(serializeStable(null)).toBe('null');
    expect(serializeStable('hello')).toBe('"hello"');
    expect(serializeStable(42)).toBe('42');
    expect(serializeStable(true)).toBe('true');
  });

  test('AS-1-6: changing a value changes the serialisation', () => {
    const a = serializeStable({ x: 1 });
    const b = serializeStable({ x: 2 });
    expect(a).not.toBe(b);
  });
});

// ===========================================================================
// AS-2 — computeArtifactDigest
// ===========================================================================
describe('AS-2: computeArtifactDigest', () => {
  test('AS-2-1: returns a 64-char lowercase hex string', () => {
    const artifact = buildValidArtifact();
    const digest   = computeArtifactDigest(artifact);
    expect(typeof digest).toBe('string');
    expect(digest).toHaveLength(64);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('AS-2-2: digest is identical for two artifacts assembled from the same inputs (ART-7 stability)', () => {
    const a = buildValidArtifact();
    const b = buildValidArtifact();
    // generated_at differs but digest covers only stable sections.
    expect(computeArtifactDigest(a)).toBe(computeArtifactDigest(b));
  });

  test('AS-2-3: digest differs when a forensic assessment changes', () => {
    const base    = buildValidArtifact();
    const tampered = JSON.parse(JSON.stringify(base));
    tampered.forensic_analysis.hypotheses[0].assessment = 'strongly_supported';
    expect(computeArtifactDigest(base)).not.toBe(computeArtifactDigest(tampered));
  });

  test('AS-2-4: digest differs when causal_attribution_established changes', () => {
    const base    = buildValidArtifact();
    const tampered = JSON.parse(JSON.stringify(base));
    tampered.forensic_analysis.causal_attribution_established = true;
    expect(computeArtifactDigest(base)).not.toBe(computeArtifactDigest(tampered));
  });

  test('AS-2-5: digest differs when analyst_statement changes in a challenge', () => {
    const base    = buildValidArtifact();
    const tampered = JSON.parse(JSON.stringify(base));
    tampered.analyst_content.challenges[0].analyst_statement = 'TAMPERED.';
    expect(computeArtifactDigest(base)).not.toBe(computeArtifactDigest(tampered));
  });

  test('AS-2-6: digest is NOT affected by artifact_metadata.generated_at (ART-7)', () => {
    const a = buildValidArtifact();
    const b = JSON.parse(JSON.stringify(a));
    b.artifact_metadata.generated_at = '1970-01-01T00:00:00.000Z';
    expect(computeArtifactDigest(a)).toBe(computeArtifactDigest(b));
  });

  test('AS-2-7: digest differs when an evidence_id reference is added', () => {
    const base    = buildValidArtifact();
    const tampered = JSON.parse(JSON.stringify(base));
    tampered.evidence_references.referenced_evidence_ids.push('E-TC-FAKE');
    expect(computeArtifactDigest(base)).not.toBe(computeArtifactDigest(tampered));
  });

  test('AS-2-8: digest differs when a limitation is removed', () => {
    const base    = buildValidArtifact();
    const tampered = JSON.parse(JSON.stringify(base));
    tampered.limitations.pop();
    expect(computeArtifactDigest(base)).not.toBe(computeArtifactDigest(tampered));
  });
});

// ===========================================================================
// AS-3 — assembleArtifact: section presence
// ===========================================================================
describe('AS-3: assembleArtifact section presence', () => {
  test('AS-3-1: all top-level sections are present', () => {
    const artifact = buildValidArtifact();
    expect(artifact).toHaveProperty('artifact_schema_version');
    expect(artifact).toHaveProperty('artifact_metadata');
    expect(artifact).toHaveProperty('case_identity');
    expect(artifact).toHaveProperty('investigation_identity');
    expect(artifact).toHaveProperty('forensic_analysis');
    expect(artifact).toHaveProperty('evidence_references');
    expect(artifact).toHaveProperty('provenance');
    expect(artifact).toHaveProperty('limitations');
    expect(artifact).toHaveProperty('analyst_narrative');
    expect(artifact).toHaveProperty('analyst_content');
    expect(artifact).toHaveProperty('integrity');
  });

  test('AS-3-2: artifact_schema_version is the module constant', () => {
    const artifact = buildValidArtifact();
    expect(artifact.artifact_schema_version).toBe(ARTIFACT_SCHEMA_VERSION);
  });

  test('AS-3-3: artifact_metadata carries generated_at and generator', () => {
    const artifact = buildValidArtifact();
    expect(typeof artifact.artifact_metadata.generated_at).toBe('string');
    expect(artifact.artifact_metadata.generator).toBe(ARTIFACT_GENERATOR);
  });

  test('AS-3-4: integrity block carries algorithm, digest, covers, excludes', () => {
    const artifact = buildValidArtifact();
    expect(artifact.integrity.algorithm).toBe('sha256');
    expect(typeof artifact.integrity.digest).toBe('string');
    expect(Array.isArray(artifact.integrity.covers)).toBe(true);
    expect(Array.isArray(artifact.integrity.excludes)).toBe(true);
  });

  test('AS-3-5: integrity.covers lists all stable sections', () => {
    const artifact = buildValidArtifact();
    const covers   = artifact.integrity.covers;
    expect(covers).toContain('case_identity');
    expect(covers).toContain('forensic_analysis');
    expect(covers).toContain('analyst_narrative');
    expect(covers).toContain('analyst_content');
    expect(covers).toContain('evidence_references');
    expect(covers).toContain('provenance');
    expect(covers).toContain('limitations');
  });

  test('AS-3-6: integrity.excludes includes artifact_metadata', () => {
    const artifact = buildValidArtifact();
    expect(artifact.integrity.excludes).toContain('artifact_metadata');
  });
});

// ===========================================================================
// AS-4 — assembleArtifact: ART invariants
// ===========================================================================
describe('AS-4: assembleArtifact ART invariants', () => {
  test('AS-4-1: ART-1 — no evidence data rows in the artifact', () => {
    const artifact = buildValidArtifact();
    // No field called "timestamp" or "value" or "source" should appear inside
    // evidence_references or forensic_analysis hypothesis evidence_summary.
    const refs = artifact.evidence_references;
    expect(refs).not.toHaveProperty('evidence_rows');
    expect(refs.evidence_by_hypothesis[0]).not.toHaveProperty('timestamp');
    expect(refs.evidence_by_hypothesis[0]).not.toHaveProperty('value');
  });

  test('AS-4-2: ART-2 — analyst_narrative.layer is "ai_synthesis"', () => {
    const artifact = buildValidArtifact();
    expect(artifact.analyst_narrative.layer).toBe('ai_synthesis');
  });

  test('AS-4-3: ART-3 — causal_attribution_established is false (from fixture)', () => {
    const artifact = buildValidArtifact();
    expect(artifact.forensic_analysis.causal_attribution_established).toBe(false);
    expect(typeof artifact.forensic_analysis.causal_attribution_established).toBe('boolean');
  });

  test('AS-4-4: ART-3 — causal_attribution_established carries true when report says true', () => {
    const artifact = buildValidArtifact({
      report: makeReport({ causal_attribution_established: true,
        analyst_narrative: { ...makeReport().analyst_narrative, causal_attribution_established: true } }),
    });
    expect(artifact.forensic_analysis.causal_attribution_established).toBe(true);
  });

  test('AS-4-5: ART-4 — hypothesis assessments are verbatim from report', () => {
    const artifact = buildValidArtifact();
    expect(artifact.forensic_analysis.hypotheses[0].assessment).toBe('mixed');
    expect(artifact.forensic_analysis.hypotheses[1].assessment).toBe('supported');
  });

  test('AS-4-6: ART-5 — environmental_context_ids and supporting_evidence_ids are always separate arrays', () => {
    const artifact = buildValidArtifact();
    for (const h of artifact.forensic_analysis.hypotheses) {
      const ec = new Set(h.evidence_summary.environmental_context_ids);
      for (const eid of h.evidence_summary.supporting_evidence_ids) {
        expect(ec.has(eid)).toBe(false);
      }
    }
  });

  test('AS-4-7: ART-5 — evidence_references preserves four separate lists per hypothesis', () => {
    const artifact = buildValidArtifact();
    for (const h of artifact.evidence_references.evidence_by_hypothesis) {
      expect(Array.isArray(h.environmental_context_ids)).toBe(true);
      expect(Array.isArray(h.supporting_evidence_ids)).toBe(true);
      expect(Array.isArray(h.contradicting_evidence_ids)).toBe(true);
      expect(Array.isArray(h.non_discriminating_evidence_ids)).toBe(true);
    }
  });

  test('AS-4-8: ART-7 — referenced_evidence_ids is sorted (digest stability)', () => {
    const artifact = buildValidArtifact();
    const ids      = artifact.evidence_references.referenced_evidence_ids;
    expect(ids).toEqual([...ids].sort());
  });

  test('AS-4-9: ART-9 — analyst_content.layer is "analyst_created"', () => {
    const artifact = buildValidArtifact();
    expect(artifact.analyst_content.layer).toBe('analyst_created');
  });

  test('AS-4-10: ART-9 — analyst_content carries observations and challenges', () => {
    const artifact = buildValidArtifact();
    expect(Array.isArray(artifact.analyst_content.observations)).toBe(true);
    expect(Array.isArray(artifact.analyst_content.challenges)).toBe(true);
  });

  test('AS-4-11: ART-1 — analyst_content observations carry evidence_ids, not evidence rows', () => {
    const artifact = buildValidArtifact();
    const obs = artifact.analyst_content.observations[0];
    expect(obs).toHaveProperty('evidence_ids');
    expect(obs).not.toHaveProperty('timestamp');
    expect(obs).not.toHaveProperty('value');
  });

  test('AS-4-12: ART-9 — observation current_text reflects latest version', () => {
    const obsWithVersions = makeObservation({
      versions: [
        { version: 1, text: 'Original.', authored_by: 'a', authored_at: '2026-01-02T00:00:00.000Z' },
        { version: 2, text: 'Updated.', authored_by: 'a',  authored_at: '2026-01-03T00:00:00.000Z' },
      ],
    });
    const artifact = buildValidArtifact({ observations: [obsWithVersions], challenges: [] });
    expect(artifact.analyst_content.observations[0].current_text).toBe('Updated.');
  });

  test('AS-4-13: provenance carries data_sources and heuristic_window_note', () => {
    const artifact = buildValidArtifact();
    expect(Array.isArray(artifact.provenance.data_sources)).toBe(true);
    expect(typeof artifact.provenance.heuristic_window_note).toBe('string');
    expect(artifact.provenance.evidence_count).toBe(20); // makeRows(20)
  });

  test('AS-4-14: limitations is the aggregated deduplicated set from the report', () => {
    const artifact = buildValidArtifact();
    expect(Array.isArray(artifact.limitations)).toBe(true);
    expect(artifact.limitations.length).toBeGreaterThan(0);
    // Dedup check: descriptions are unique.
    const descs = artifact.limitations.map((l) => l.description);
    expect(new Set(descs).size).toBe(descs.length);
  });

  test('AS-4-15: empty observations and challenges produce empty arrays in analyst_content', () => {
    const artifact = buildValidArtifact({ observations: [], challenges: [] });
    expect(artifact.analyst_content.observations).toHaveLength(0);
    expect(artifact.analyst_content.challenges).toHaveLength(0);
    expect(artifact.analyst_content.observation_count).toBe(0);
    expect(artifact.analyst_content.challenge_count).toBe(0);
  });
});

// ===========================================================================
// AS-5 — validateArtifact accepts valid artifacts
// ===========================================================================
describe('AS-5: validateArtifact accepts valid artifacts', () => {
  test('AS-5-1: valid artifact passes with no errors', () => {
    const artifact = buildValidArtifact();
    const { valid, errors } = validateArtifact(artifact);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  test('AS-5-2: artifact with empty observations/challenges passes', () => {
    const artifact = buildValidArtifact({ observations: [], challenges: [] });
    const { valid, errors } = validateArtifact(artifact);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  test('AS-5-3: artifact with multiple hypotheses passes', () => {
    const artifact = buildValidArtifact();
    expect(artifact.forensic_analysis.hypotheses).toHaveLength(2);
    const { valid } = validateArtifact(artifact);
    expect(valid).toBe(true);
  });
});

// ===========================================================================
// AS-6 — validateArtifact rejects violations
// ===========================================================================
describe('AS-6: validateArtifact rejects violations', () => {
  test('AS-6-1: V-SCH — missing artifact_schema_version', () => {
    const artifact = buildValidArtifact();
    const bad = { ...artifact, artifact_schema_version: undefined };
    const { valid, errors } = validateArtifact(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('V-SCH'))).toBe(true);
  });

  test('AS-6-2: V-CAU — causal_attribution_established is a string instead of boolean', () => {
    const artifact = buildValidArtifact();
    const bad = JSON.parse(JSON.stringify(artifact));
    bad.forensic_analysis.causal_attribution_established = 'false';
    const { valid, errors } = validateArtifact(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('V-CAU'))).toBe(true);
  });

  test('AS-6-3: V-HYP — invalid hypothesis assessment', () => {
    const artifact = buildValidArtifact();
    const bad = JSON.parse(JSON.stringify(artifact));
    bad.forensic_analysis.hypotheses[0].assessment = 'very_likely';
    const { valid, errors } = validateArtifact(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('V-HYP'))).toBe(true);
  });

  test('AS-6-4: V-SEP — same evidence_id in environmental_context and supporting_evidence', () => {
    const artifact = buildValidArtifact();
    const bad = JSON.parse(JSON.stringify(artifact));
    // Put E-TC-0001 in both environmental_context_ids and supporting_evidence_ids of H1
    bad.forensic_analysis.hypotheses[0].evidence_summary.supporting_evidence_ids = ['E-TC-0001'];
    const { valid, errors } = validateArtifact(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('V-SEP'))).toBe(true);
  });

  test('AS-6-5: V-PROB — numerical percentage in executive_summary', () => {
    const artifact = buildValidArtifact();
    const bad = JSON.parse(JSON.stringify(artifact));
    bad.analyst_narrative.executive_summary = 'There is a 70% chance of SEU.';
    const { valid, errors } = validateArtifact(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('V-PROB'))).toBe(true);
  });

  test('AS-6-6: V-PROB — "0.8 probability" pattern in event_description', () => {
    const artifact = buildValidArtifact();
    const bad = JSON.parse(JSON.stringify(artifact));
    bad.analyst_narrative.event_description = 'There is a 0.8 probability that SEU occurred.';
    const { valid, errors } = validateArtifact(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('V-PROB'))).toBe(true);
  });

  test('AS-6-7: V-PROB — percentage in hypothesis reasoning', () => {
    const artifact = buildValidArtifact();
    const bad = JSON.parse(JSON.stringify(artifact));
    bad.analyst_narrative.hypothesis_assessments[0].reasoning = 'Confidence: 90%.';
    const { valid, errors } = validateArtifact(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('V-PROB'))).toBe(true);
  });

  test('AS-6-8: V-LAYER — analyst_narrative.layer is not "ai_synthesis"', () => {
    const artifact = buildValidArtifact();
    const bad = JSON.parse(JSON.stringify(artifact));
    bad.analyst_narrative.layer = 'evidence';
    const { valid, errors } = validateArtifact(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('V-LAYER'))).toBe(true);
  });

  test('AS-6-9: V-ALAYER — analyst_content.layer is not "analyst_created"', () => {
    const artifact = buildValidArtifact();
    const bad = JSON.parse(JSON.stringify(artifact));
    bad.analyst_content.layer = 'forensic';
    const { valid, errors } = validateArtifact(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('V-ALAYER'))).toBe(true);
  });

  test('AS-6-10: V-DIG — digest is not a 64-char hex string', () => {
    const artifact = buildValidArtifact();
    const bad = JSON.parse(JSON.stringify(artifact));
    bad.integrity.digest = 'not-a-hex-digest';
    const { valid, errors } = validateArtifact(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('V-DIG'))).toBe(true);
  });

  test('AS-6-11: V-DIG — missing integrity block', () => {
    const artifact = buildValidArtifact();
    const bad = { ...artifact, integrity: null };
    const { valid, errors } = validateArtifact(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('V-DIG'))).toBe(true);
  });

  test('AS-6-12: V-NODUP — duplicate evidence_id in referenced_evidence_ids', () => {
    const artifact = buildValidArtifact();
    const bad = JSON.parse(JSON.stringify(artifact));
    bad.evidence_references.referenced_evidence_ids.push(
      bad.evidence_references.referenced_evidence_ids[0],
    );
    const { valid, errors } = validateArtifact(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('V-NODUP'))).toBe(true);
  });

  test('AS-6-13: V-REF — orphaned evidence_id in referenced_evidence_ids', () => {
    const artifact = buildValidArtifact();
    const bad = JSON.parse(JSON.stringify(artifact));
    bad.evidence_references.referenced_evidence_ids.push('E-TC-ORPHAN');
    const { valid, errors } = validateArtifact(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('V-REF'))).toBe(true);
  });

  test('AS-6-14: missing forensic_analysis returns V-CAU error', () => {
    const artifact = buildValidArtifact();
    const bad = { ...artifact, forensic_analysis: null };
    const { valid, errors } = validateArtifact(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('V-CAU'))).toBe(true);
  });
});

// ===========================================================================
// AS-7 — verifyArtifactIntegrity: round-trip and tamper detection
// ===========================================================================
describe('AS-7: verifyArtifactIntegrity', () => {
  test('AS-7-1: fresh artifact verifies successfully', () => {
    const artifact = buildValidArtifact();
    const { verified } = verifyArtifactIntegrity(artifact);
    expect(verified).toBe(true);
  });

  test('AS-7-2: expected and actual digest match on a fresh artifact', () => {
    const artifact = buildValidArtifact();
    const result   = verifyArtifactIntegrity(artifact);
    expect(result.expected).toBe(result.actual);
  });

  test('AS-7-3: tampered forensic assessment fails verification', () => {
    const artifact = buildValidArtifact();
    const tampered = JSON.parse(JSON.stringify(artifact));
    tampered.forensic_analysis.hypotheses[0].assessment = 'strongly_supported';
    const { verified } = verifyArtifactIntegrity(tampered);
    expect(verified).toBe(false);
  });

  test('AS-7-4: tampered causal_attribution_established fails verification', () => {
    const artifact = buildValidArtifact();
    const tampered = JSON.parse(JSON.stringify(artifact));
    tampered.forensic_analysis.causal_attribution_established = true;
    const { verified } = verifyArtifactIntegrity(tampered);
    expect(verified).toBe(false);
  });

  test('AS-7-5: tampered analyst_statement fails verification', () => {
    const artifact = buildValidArtifact();
    const tampered = JSON.parse(JSON.stringify(artifact));
    tampered.analyst_content.challenges[0].analyst_statement = 'TAMPERED';
    const { verified } = verifyArtifactIntegrity(tampered);
    expect(verified).toBe(false);
  });

  test('AS-7-6: tampered observation text fails verification', () => {
    const artifact = buildValidArtifact();
    const tampered = JSON.parse(JSON.stringify(artifact));
    tampered.analyst_content.observations[0].current_text = 'TAMPERED';
    const { verified } = verifyArtifactIntegrity(tampered);
    expect(verified).toBe(false);
  });

  test('AS-7-7: changing generated_at does NOT fail verification (ART-7)', () => {
    const artifact = buildValidArtifact();
    const modified = JSON.parse(JSON.stringify(artifact));
    modified.artifact_metadata.generated_at = '1970-01-01T00:00:00.000Z';
    const { verified } = verifyArtifactIntegrity(modified);
    expect(verified).toBe(true);
  });

  test('AS-7-8: removing a limitation fails verification', () => {
    const artifact = buildValidArtifact();
    const tampered = JSON.parse(JSON.stringify(artifact));
    tampered.limitations.pop();
    const { verified } = verifyArtifactIntegrity(tampered);
    expect(verified).toBe(false);
  });

  test('AS-7-9: adding a referenced_evidence_id fails verification', () => {
    const artifact = buildValidArtifact();
    const tampered = JSON.parse(JSON.stringify(artifact));
    tampered.evidence_references.referenced_evidence_ids.push('E-TC-EXTRA');
    const { verified } = verifyArtifactIntegrity(tampered);
    expect(verified).toBe(false);
  });

  test('AS-7-10: two independently assembled artifacts from the same inputs have matching digests', () => {
    const a = buildValidArtifact();
    const b = buildValidArtifact();
    expect(a.integrity.digest).toBe(b.integrity.digest);
  });
});

// ===========================================================================
// AS-8 — Galaxy-15 forensic preservation (smoke test using real pipeline)
// ===========================================================================
describe('AS-8: real pipeline smoke test', () => {
  // Import the real server modules for an end-to-end smoke test.
  const {
    parseEvidenceCSV,
    buildEvidenceGraph,
    buildForensicAnalysis,
    assembleValidatedForensicReport,
  } = require('../server');
  const aiAnalyst         = require('../services/aiAnalyst');
  const path              = require('path');
  const fs                = require('fs');
  const CASES_DIR         = path.join(__dirname, '..', '..', 'cases');

  async function buildG15Report() {
    const rows      = await parseEvidenceCSV('galaxy-15');
    const graph     = await buildEvidenceGraph('galaxy-15', rows);
    const analysis  = buildForensicAnalysis('galaxy-15', graph);
    const validIds  = new Set(rows.map((r) => r.evidence_id));
    const narrative = await aiAnalyst.generateAnalystNarrative(analysis, validIds, graph);
    const report    = assembleValidatedForensicReport(analysis, narrative);
    const caseMeta  = JSON.parse(fs.readFileSync(path.join(CASES_DIR, 'galaxy-15', 'case.json'), 'utf8'));
    const hypoConfig = JSON.parse(fs.readFileSync(path.join(CASES_DIR, 'galaxy-15', 'hypotheses.json'), 'utf8'));
    return { rows, report, caseMeta, heuristicWindowNote: hypoConfig.heuristic_window_note };
  }

  test('AS-8-1: galaxy-15 artifact passes validation', async () => {
    const { rows, report, caseMeta, heuristicWindowNote } = await buildG15Report();
    const artifact = assembleArtifact({
      caseMeta,
      report,
      rows,
      heuristicWindowNote,
      investigation: makeInvestigation({ case_id: 'galaxy-15' }),
      observations: [],
      challenges:   [],
    });
    const { valid, errors } = validateArtifact(artifact);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  test('AS-8-2: galaxy-15 causal_attribution_established is false', async () => {
    const { rows, report, caseMeta, heuristicWindowNote } = await buildG15Report();
    const artifact = assembleArtifact({
      caseMeta, report, rows, heuristicWindowNote,
      investigation: makeInvestigation({ case_id: 'galaxy-15' }),
      observations: [], challenges: [],
    });
    expect(artifact.forensic_analysis.causal_attribution_established).toBe(false);
  });

  test('AS-8-3: galaxy-15 has 5 hypotheses in forensic_analysis', async () => {
    const { rows, report, caseMeta, heuristicWindowNote } = await buildG15Report();
    const artifact = assembleArtifact({
      caseMeta, report, rows, heuristicWindowNote,
      investigation: makeInvestigation({ case_id: 'galaxy-15' }),
      observations: [], challenges: [],
    });
    expect(artifact.forensic_analysis.hypotheses).toHaveLength(5);
  });

  test('AS-8-4: galaxy-15 total_evidence_rows is 278', async () => {
    const { rows, report, caseMeta, heuristicWindowNote } = await buildG15Report();
    const artifact = assembleArtifact({
      caseMeta, report, rows, heuristicWindowNote,
      investigation: makeInvestigation({ case_id: 'galaxy-15' }),
      observations: [], challenges: [],
    });
    expect(artifact.evidence_references.total_evidence_rows).toBe(278);
  });

  test('AS-8-5: galaxy-15 artifact verifies integrity', async () => {
    const { rows, report, caseMeta, heuristicWindowNote } = await buildG15Report();
    const artifact = assembleArtifact({
      caseMeta, report, rows, heuristicWindowNote,
      investigation: makeInvestigation({ case_id: 'galaxy-15' }),
      observations: [], challenges: [],
    });
    const { verified } = verifyArtifactIntegrity(artifact);
    expect(verified).toBe(true);
  });

  test('AS-8-6: galaxy-15 digest is stable across two assemblies', async () => {
    const { rows, report, caseMeta, heuristicWindowNote } = await buildG15Report();
    const inv = makeInvestigation({ case_id: 'galaxy-15' });
    const a = assembleArtifact({ caseMeta, report, rows, heuristicWindowNote, investigation: inv, observations: [], challenges: [] });
    const b = assembleArtifact({ caseMeta, report, rows, heuristicWindowNote, investigation: inv, observations: [], challenges: [] });
    expect(a.integrity.digest).toBe(b.integrity.digest);
  });

  test('AS-8-7: galaxy-15 ai_narrative.layer is "ai_synthesis"', async () => {
    const { rows, report, caseMeta, heuristicWindowNote } = await buildG15Report();
    const artifact = assembleArtifact({
      caseMeta, report, rows, heuristicWindowNote,
      investigation: makeInvestigation({ case_id: 'galaxy-15' }),
      observations: [], challenges: [],
    });
    expect(artifact.analyst_narrative.layer).toBe('ai_synthesis');
  });

  test('AS-8-8: galaxy-15 no numerical probabilities anywhere in narrative', async () => {
    const { rows, report, caseMeta, heuristicWindowNote } = await buildG15Report();
    const artifact = assembleArtifact({
      caseMeta, report, rows, heuristicWindowNote,
      investigation: makeInvestigation({ case_id: 'galaxy-15' }),
      observations: [], challenges: [],
    });
    const { valid, errors } = validateArtifact(artifact);
    expect(errors.filter((e) => e.includes('V-PROB'))).toHaveLength(0);
    expect(valid).toBe(true);
  });
});
