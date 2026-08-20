'use strict';

require('dotenv').config();

const path = require('path');
const fs   = require('fs');

// ---------------------------------------------------------------------------
// LLM client factory — returns a ChatWatsonx instance or null when no key
// ---------------------------------------------------------------------------
function buildLLMClient() {
  const apikey = process.env.WATSONX_AI_APIKEY;
  if (!apikey) return null;

  const { ChatWatsonx } = require('@langchain/ibm');
  return new ChatWatsonx({
    model: 'ibm/granite-3-3-8b-instruct',
    watsonxAIApikey: apikey,
    serviceUrl: process.env.WATSONX_AI_URL || 'https://us-south.ml.cloud.ibm.com',
    projectId: process.env.WATSONX_AI_PROJECT_ID,
    maxTokens: 2048,
  });
}

// ---------------------------------------------------------------------------
// Helper: partition evidence rows and compute key metrics
// (kept for use by buildEvidenceSnapshot and the heuristic fallback)
// ---------------------------------------------------------------------------
const ANOMALY_TIME       = new Date('2010-04-05T09:48:00Z').getTime();
const ELEVATED_FLUX_THRESHOLD = 1000;
const MAG_WINDOW_MS      = 10 * 60 * 1000;  // ±10 minutes
const SNAPSHOT_WINDOW_MS = 30 * 60 * 1000;  // ±30 minutes for token-safe window

function classifyEvidence(rows) {
  const ep8Rows    = rows.filter((r) => r.source === 'GOES11_EP8');
  const magRows    = rows.filter((r) => r.source === 'GOES11_MAG');
  const anchorRows = rows.filter((r) => r.source === 'CASE');

  const peakEp8 = ep8Rows.length
    ? ep8Rows.reduce((max, r) => (r.value > max.value ? r : max), ep8Rows[0])
    : null;

  const elevatedFluxRows = ep8Rows.filter((r) => r.value > ELEVATED_FLUX_THRESHOLD);

  const magNearAnomaly = magRows.filter((r) => {
    const diff = Math.abs(new Date(r.timestamp).getTime() - ANOMALY_TIME);
    return diff <= MAG_WINDOW_MS;
  });

  // e_flux at the 09:27 UTC window — closest EP8 reading before anomaly
  const TARGET_SPIKE   = new Date('2010-04-05T09:27:00Z').getTime();
  const eFluxSpikeRow  = ep8Rows.length
    ? ep8Rows.reduce((closest, r) => {
        const d  = Math.abs(new Date(r.timestamp).getTime() - TARGET_SPIKE);
        const dc = Math.abs(new Date(closest.timestamp).getTime() - TARGET_SPIKE);
        return d < dc ? r : closest;
      }, ep8Rows[0])
    : null;

  return {
    ep8Rows,
    magRows,
    anchorRows,
    peakEp8,
    elevatedFluxRows,
    magNearAnomaly,
    eFluxSpikeRow,
    totalRows: rows.length,
  };
}

// ---------------------------------------------------------------------------
// ST-1: Evidence snapshot builder
// Produces a token-safe, ID-addressable view of the evidence for the LLM.
// ---------------------------------------------------------------------------
function buildEvidenceSnapshot(rows, caseId) {
  const metrics = classifyEvidence(rows);

  // ---- Build the evidence_index with a ≤150-row token budget ----
  //
  // Priority 1 (always included): CASE anchor events (typically 1–2 rows)
  // Priority 2 (always included): EP8 and MAG rows within ±30 min of anomaly
  // Priority 3 (fill remaining budget): rest of sensor rows, proportionally

  const BUDGET = 150;

  const caseRows = rows.filter((r) => r.source === 'CASE');

  const windowRows = rows.filter((r) => {
    if (r.source === 'CASE') return false;  // already handled
    const diff = Math.abs(new Date(r.timestamp).getTime() - ANOMALY_TIME);
    return diff <= SNAPSHOT_WINDOW_MS;
  });

  const outsideRows = rows.filter((r) => {
    if (r.source === 'CASE') return false;
    const diff = Math.abs(new Date(r.timestamp).getTime() - ANOMALY_TIME);
    return diff > SNAPSHOT_WINDOW_MS;
  });

  const mandatoryCount = caseRows.length + windowRows.length;
  const remaining      = Math.max(0, BUDGET - mandatoryCount);

  // Sample outsideRows evenly if budget allows
  let sampledOutside = [];
  if (remaining > 0 && outsideRows.length > 0) {
    if (outsideRows.length <= remaining) {
      sampledOutside = outsideRows;
    } else {
      const step = outsideRows.length / remaining;
      for (let i = 0; i < remaining; i++) {
        sampledOutside.push(outsideRows[Math.floor(i * step)]);
      }
    }
  }

  const selectedRows = [...caseRows, ...windowRows, ...sampledOutside]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const evidence_index = selectedRows.map((r) => ({
    evidence_id : r.evidence_id,
    timestamp   : r.timestamp,
    source      : r.source,
    measurement : r.measurement,
    value       : r.value,
    unit        : r.unit,
  }));

  // ---- Scientific limitations from case.json ----
  let scientificLimitations = [];
  try {
    const casePath = path.join(__dirname, '..', '..', 'cases', caseId, 'case.json');
    const caseJson = JSON.parse(fs.readFileSync(casePath, 'utf8'));
    scientificLimitations = caseJson.scientific_limitations || [];
  } catch (_) {
    // If the file can't be read, proceed without limitations
  }

  // ---- Context summary (orientation for the model) ----
  const contextSummary = {
    total_evidence_records       : rows.length,
    evidence_index_size          : evidence_index.length,
    peak_ep8_evidence_id         : metrics.peakEp8 ? metrics.peakEp8.evidence_id : null,
    peak_ep8_value               : metrics.peakEp8 ? metrics.peakEp8.value : null,
    elevated_flux_count          : metrics.elevatedFluxRows.length,
    elevated_flux_evidence_ids   : metrics.elevatedFluxRows.map((r) => r.evidence_id),
    mag_near_anomaly_count       : metrics.magNearAnomaly.length,
    mag_near_anomaly_evidence_ids: metrics.magNearAnomaly.map((r) => r.evidence_id),
    anchor_evidence_ids          : metrics.anchorRows.map((r) => r.evidence_id),
    e_flux_spike_evidence_id     : metrics.eFluxSpikeRow ? metrics.eFluxSpikeRow.evidence_id : null,
  };

  return { evidence_index, scientificLimitations, contextSummary, metrics };
}

// ---------------------------------------------------------------------------
// Score → categorical assessment helper
// ---------------------------------------------------------------------------
function scoreToAssessment(score) {
  if (score >= 70) return 'supported';
  if (score >= 50) return 'weakly_supported';
  return 'insufficient_evidence';
}

// ---------------------------------------------------------------------------
// ST-5: Deterministic (heuristic) fallback — Pass 1
// Returns new schema with claims citing real evidence_ids.
// ---------------------------------------------------------------------------
function deterministicHypotheses(metrics, evidenceIndex) {
  const { peakEp8, elevatedFluxRows, magNearAnomaly, anchorRows, eFluxSpikeRow, ep8Rows } = metrics;

  // ---- Score computation (unchanged logic) ----
  let esdScore = 60;
  if (elevatedFluxRows.length >= 5) esdScore += 15;
  if (peakEp8 && peakEp8.value > 2000) esdScore += 10;
  if (eFluxSpikeRow && eFluxSpikeRow.value > 500) esdScore += 5;

  let seuScore = 50;
  if (magNearAnomaly.length > 0) seuScore += 10;
  if (elevatedFluxRows.length >= 3) seuScore += 5;

  let hwScore = 30;
  if (peakEp8 && peakEp8.value > 2000) hwScore -= 10;

  // ---- Build claim arrays using real evidence_ids ----
  const peakId      = peakEp8      ? peakEp8.evidence_id      : null;
  const spikeId     = eFluxSpikeRow ? eFluxSpikeRow.evidence_id : null;
  const elevIds     = elevatedFluxRows.map((r) => r.evidence_id).slice(0, 5);
  const magIds      = magNearAnomaly.map((r) => r.evidence_id).slice(0, 5);
  const anchorIds   = anchorRows.map((r) => r.evidence_id);

  const esdClaims = [];
  if (elevIds.length > 0 || peakId) {
    esdClaims.push({
      claim_id    : 'ESD-C1',
      statement   : `Sustained elevated electron flux (${elevatedFluxRows.length} readings > ${ELEVATED_FLUX_THRESHOLD} p/cm²/s/sr) is consistent with a surface-charging environment.`,
      evidence_ids: [...new Set([peakId, ...elevIds].filter(Boolean))],
      relationship: 'supports',
      reasoning   : 'High-flux electron environment is a necessary (though not sufficient) precondition for differential surface charging on a GEO spacecraft.',
      uncertainty : 'inferred',
    });
  }
  if (spikeId) {
    esdClaims.push({
      claim_id    : 'ESD-C2',
      statement   : `An electron flux reading near the 09:27 UTC spike window precedes the anomaly by ~21 minutes.`,
      evidence_ids: [spikeId].filter(Boolean),
      relationship: 'non_discriminating',
      reasoning   : 'Temporal proximity is observed, but correlation does not establish causation. The 5-minute averaging of EP8 may mask sub-minute impulsive events.',
      uncertainty : 'inferred',
    });
  }
  esdClaims.push({
    claim_id    : 'ESD-C3',
    statement   : 'No onboard surface-charging sensor data is available for Galaxy 15.',
    evidence_ids: [],
    relationship : 'non_discriminating',
    reasoning   : 'ESD is inferred from proxy GOES-11 data; direct measurement at the spacecraft bus is absent.',
    uncertainty : 'unknown',
  });

  const seuClaims = [];
  if (magIds.length > 0) {
    seuClaims.push({
      claim_id    : 'SEU-C1',
      statement   : `${magNearAnomaly.length} magnetic field disturbance readings occur within ±10 min of the anomaly time.`,
      evidence_ids: magIds,
      relationship: 'non_discriminating',
      reasoning   : 'Magnetic disturbance is a proxy for energetic particle precipitation but does not directly indicate SEU-producing particle species.',
      uncertainty : 'inferred',
    });
  }
  if (peakId) {
    seuClaims.push({
      claim_id    : 'SEU-C2',
      statement   : 'Energetic electron flux is elevated, but GOES-11 EP8 does not measure heavy ions or high-energy protons — the primary SEU-causing particles.',
      evidence_ids: [peakId],
      relationship: 'non_discriminating',
      reasoning   : 'The electron environment supports an energetic environment but cannot confirm the presence of SEU-causing species.',
      uncertainty : 'inferred',
    });
  }
  if (anchorIds.length > 0) {
    seuClaims.push({
      claim_id    : 'SEU-C3',
      statement   : 'All transponders remained operational during the anomaly period.',
      evidence_ids: anchorIds,
      relationship: 'contradicts',
      reasoning   : 'A total SEU of the command processor would typically propagate to additional subsystems; payload survival limits the scope of any SEU hypothesis.',
      uncertainty : 'observed',
    });
  }

  const hwClaims = [];
  if (anchorIds.length > 0) {
    hwClaims.push({
      claim_id    : 'HW-C1',
      statement   : 'Autonomous recovery on 26 Dec 2010 confirms the spacecraft was not permanently destroyed.',
      evidence_ids: anchorIds,
      relationship: 'contradicts',
      reasoning   : 'Physical hardware destruction is ruled out by the autonomous reboot. Transient or software-level failure remains possible.',
      uncertainty : 'observed',
    });
  }
  if (peakId) {
    hwClaims.push({
      claim_id    : 'HW-C2',
      statement   : 'The anomaly onset correlates temporally with elevated electron flux at GOES-11.',
      evidence_ids: peakId ? [peakId] : [],
      relationship: 'non_discriminating',
      reasoning   : 'Temporal correlation with a space weather event makes purely random hardware failure less probable, but does not rule it out.',
      uncertainty : 'inferred',
    });
  }

  const hypotheses = [
    {
      hypothesis_id  : 'surface_charging_esd',
      label          : 'Surface Charging / ESD',
      confidence     : Math.min(esdScore, 100),  // retained for backward compat
      assessment     : scoreToAssessment(esdScore),
      claims         : esdClaims,
      missing_evidence: [
        'Onboard surface-charging sensor data for Galaxy 15',
        'High-energy proton flux measurement concurrent with the anomaly',
        'Spacecraft bus voltage or current transient data',
      ],
      limitations    : [
        'GOES-11 electron flux is a proxy measurement ~2° from Galaxy 15.',
        '5-minute averaging may smooth sub-minute charging events.',
        'ESD is inferred, not directly measured.',
      ],
    },
    {
      hypothesis_id  : 'single_event_upset',
      label          : 'Single Event Upset (SEU)',
      confidence     : Math.min(seuScore, 100),
      assessment     : scoreToAssessment(seuScore),
      claims         : seuClaims,
      missing_evidence: [
        'Heavy-ion or high-energy proton flux measurement (not available on GOES-11 EP8 E2)',
        'Spacecraft single-event monitor or radiation dose data',
      ],
      limitations    : [
        'GOES-11 EP8 E2 variable measures electrons >2 MeV, not the primary SEU particle species.',
        'No onboard radiation monitor was available on Galaxy 15.',
      ],
    },
    {
      hypothesis_id  : 'hardware_failure',
      label          : 'Hardware Failure',
      confidence     : Math.min(hwScore, 100),
      assessment     : scoreToAssessment(hwScore),
      claims         : hwClaims,
      missing_evidence: [
        'Pre-anomaly telemetry trends (power, thermal)',
        'Ground-system and RF link logs',
        'Manufacturer failure-mode analysis',
      ],
      limitations    : [
        'Autonomous recovery on 26 Dec 2010 rules out permanent physical destruction but not transient hardware-level failure.',
        'No pre-anomaly degradation data is available in this dataset.',
      ],
    },
  ];

  hypotheses.sort((a, b) => b.confidence - a.confidence);
  return hypotheses;
}

// ---------------------------------------------------------------------------
// ST-5: Deterministic (heuristic) fallback — Pass 2
// Returns new claim-level challenge schema.
// ---------------------------------------------------------------------------
function deterministicCounterEvidence(leadingHypothesisId, evidenceIndex) {
  const anchorIds = evidenceIndex
    ? evidenceIndex.filter((e) => e.source === 'CASE').map((e) => e.evidence_id)
    : [];
  const ep8Ids = evidenceIndex
    ? evidenceIndex.filter((e) => e.source === 'GOES11_EP8').map((e) => e.evidence_id).slice(0, 3)
    : [];

  const challengeMap = {
    surface_charging_esd: [
      {
        claim_id         : 'ESD-C1',
        challenge        : 'Elevated electron flux is a necessary precondition for surface charging but is not direct evidence of an ESD event. The GOES-11 EP8 sensor is located ~2° from Galaxy 15 and uses 5-minute averaging, making it a proxy measurement outside its direct measurement scope.',
        counter_evidence_ids: ep8Ids,
        missing_evidence : [
          'Onboard surface-charging sensor data for Galaxy 15',
          'Sub-minute resolution flux data to detect impulsive charge-deposit events',
        ],
        severity         : 'high',
        revised_assessment: 'The claim that elevated flux supports ESD is weakened because the measurement is a proxy, not direct. The relationship should be labelled non_discriminating.',
      },
      {
        claim_id         : 'ESD-C2',
        challenge        : 'Temporal proximity (21 minutes before anomaly) is a correlation, not causation. Multiple alternative explanations could produce the same timeline without ESD.',
        counter_evidence_ids: [],
        missing_evidence : [
          'Sub-minute particle flux data to link flux spike to discharge timing',
          'Spacecraft power bus voltage data',
        ],
        severity         : 'high',
        revised_assessment: 'Temporal correlation cannot be treated as causal evidence. Claim should be explicitly labelled as non_discriminating.',
      },
      {
        claim_id         : 'ESD-C3',
        challenge        : 'Attitude control remained fully nominal throughout the anomaly. ESD events of sufficient magnitude to disable the command processor would typically manifest as disturbances in attitude sensors or power bus transients.',
        counter_evidence_ids: anchorIds,
        missing_evidence : [
          'Attitude sensor and power bus telemetry from Galaxy 15',
        ],
        severity         : 'medium',
        revised_assessment: 'The absence of any attitude disturbance is a missing signature that weakens the ESD hypothesis.',
      },
    ],
    single_event_upset: [
      {
        claim_id         : 'SEU-C1',
        challenge        : 'Magnetic field disturbance is an indirect proxy for particle precipitation and does not identify the particle species responsible for SEU. This evidence is being used outside its direct measurement scope.',
        counter_evidence_ids: [],
        missing_evidence : [
          'Heavy-ion or high-energy proton flux data',
          'Spacecraft single-event monitor data',
        ],
        severity         : 'high',
        revised_assessment: 'Magnetic disturbance cannot be used to confirm SEU-producing particle species. The relationship should be labelled non_discriminating.',
      },
      {
        claim_id         : 'SEU-C2',
        challenge        : 'All transponders and payload remained fully operational. A total SEU of the command processor would be expected to affect additional subsystems beyond the uplink command receiver alone.',
        counter_evidence_ids: anchorIds,
        missing_evidence : [
          'Subsystem-level telemetry showing which components were affected',
        ],
        severity         : 'high',
        revised_assessment: 'Selective impact on only the command receiver argues against a total SEU; a narrowly-targeted latch-up is more consistent with observations.',
      },
      {
        claim_id         : 'SEU-C3',
        challenge        : 'The autonomous recovery 9 months later suggests the underlying state was a latch-up or corrupted register. A true single-event gate rupture would not permit autonomous recovery.',
        counter_evidence_ids: anchorIds,
        missing_evidence : [
          'Spacecraft power cycling log',
          'Memory dump from recovery event',
        ],
        severity         : 'medium',
        revised_assessment: 'The recovery event is inconsistent with a destructive SEU. Latch-up or firmware corruption is a more precise characterisation.',
      },
    ],
    hardware_failure: [
      {
        claim_id         : 'HW-C1',
        challenge        : 'Autonomous reboot and full recovery on 26 Dec 2010 definitively rules out permanent physical hardware destruction. This directly contradicts the hardware failure hypothesis.',
        counter_evidence_ids: anchorIds,
        missing_evidence : [],
        severity         : 'high',
        revised_assessment: 'Physical hardware destruction is eliminated. Only transient or software-level hardware failure remains viable, which substantially overlaps with SEU-class events.',
      },
      {
        claim_id         : 'HW-C2',
        challenge        : 'Treating temporal correlation between the space weather event and anomaly onset as evidence against random hardware failure is a probabilistic inference, not an observation. Alternative explanations are not excluded.',
        counter_evidence_ids: ep8Ids,
        missing_evidence : [
          'Pre-anomaly telemetry trends (power, thermal, RF)',
          'Baseline failure rate data for the Star-2 bus',
        ],
        severity         : 'medium',
        revised_assessment: 'Space weather correlation reduces the prior probability of random failure but does not eliminate it. The claim should be labelled inferred, not observed.',
      },
    ],
  };

  return challengeMap[leadingHypothesisId] || challengeMap['surface_charging_esd'];
}

// ---------------------------------------------------------------------------
// ST-4: Post-response validators
// ---------------------------------------------------------------------------
const ALLOWED_ASSESSMENTS = new Set([
  'strongly_supported', 'supported', 'mixed', 'weakly_supported', 'insufficient_evidence',
]);
const ALLOWED_RELATIONSHIPS = new Set(['supports', 'contradicts', 'non_discriminating']);
const ALLOWED_UNCERTAINTIES  = new Set(['observed', 'inferred', 'unknown']);
const CAUSAL_CERTAINTY_PHRASES = [
  'proves', 'confirms causation', 'is caused by', 'causation established',
  'proof of', 'definitively caused', 'conclusively shows', 'confirms that',
];

function containsCausalCertainty(text) {
  const lower = (text || '').toLowerCase();
  return CAUSAL_CERTAINTY_PHRASES.some((p) => lower.includes(p));
}

/**
 * validatePass1Response(parsed, allowedIds)
 * Returns { valid: boolean, errors: string[] }
 */
function validatePass1Response(parsed, allowedIds) {
  const errors = [];

  if (!parsed || !Array.isArray(parsed.hypotheses)) {
    return { valid: false, errors: ['Response missing "hypotheses" array'] };
  }

  for (const h of parsed.hypotheses) {
    const hid = h.hypothesis_id || '(unknown)';

    // Required top-level keys
    for (const key of ['hypothesis_id', 'label', 'assessment', 'claims', 'missing_evidence', 'limitations']) {
      if (!(key in h)) errors.push(`Hypothesis ${hid}: missing key "${key}"`);
    }

    // Assessment vocabulary
    if (h.assessment && !ALLOWED_ASSESSMENTS.has(h.assessment)) {
      errors.push(`Hypothesis ${hid}: unknown assessment value "${h.assessment}"`);
    }

    // Claims array
    if (!Array.isArray(h.claims)) {
      errors.push(`Hypothesis ${hid}: "claims" must be an array`);
    } else {
      for (const c of h.claims) {
        const cid = c.claim_id || '(unknown)';

        for (const key of ['claim_id', 'statement', 'evidence_ids', 'relationship', 'reasoning', 'uncertainty']) {
          if (!(key in c)) errors.push(`Hypothesis ${hid} Claim ${cid}: missing key "${key}"`);
        }

        if (!Array.isArray(c.evidence_ids)) {
          errors.push(`Hypothesis ${hid} Claim ${cid}: "evidence_ids" must be an array`);
        } else {
          for (const eid of c.evidence_ids) {
            if (!allowedIds.has(eid)) {
              errors.push(`Hypothesis ${hid} Claim ${cid}: unknown evidence_id "${eid}" (hallucinated)`);
            }
          }
        }

        if (c.relationship && !ALLOWED_RELATIONSHIPS.has(c.relationship)) {
          errors.push(`Hypothesis ${hid} Claim ${cid}: unknown relationship "${c.relationship}"`);
        }

        if (c.uncertainty && !ALLOWED_UNCERTAINTIES.has(c.uncertainty)) {
          errors.push(`Hypothesis ${hid} Claim ${cid}: unknown uncertainty "${c.uncertainty}"`);
        }

        // Causal certainty check on free-text fields
        for (const field of ['statement', 'reasoning']) {
          if (containsCausalCertainty(c[field])) {
            errors.push(`Hypothesis ${hid} Claim ${cid}: causal-certainty language in "${field}"`);
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * validatePass2Response(parsed, allowedIds)
 * Returns { valid: boolean, errors: string[] }
 */
function validatePass2Response(parsed, allowedIds) {
  const errors = [];

  if (!parsed || !Array.isArray(parsed.challenges)) {
    return { valid: false, errors: ['Response missing "challenges" array'] };
  }

  for (const ch of parsed.challenges) {
    const cid = ch.claim_id || '(unknown)';

    for (const key of ['claim_id', 'challenge', 'counter_evidence_ids', 'missing_evidence', 'severity', 'revised_assessment']) {
      if (!(key in ch)) errors.push(`Challenge ${cid}: missing key "${key}"`);
    }

    if (!Array.isArray(ch.counter_evidence_ids)) {
      errors.push(`Challenge ${cid}: "counter_evidence_ids" must be an array`);
    } else {
      for (const eid of ch.counter_evidence_ids) {
        if (!allowedIds.has(eid)) {
          errors.push(`Challenge ${cid}: unknown counter_evidence_id "${eid}" (hallucinated)`);
        }
      }
    }

    const ALLOWED_SEVERITIES = new Set(['high', 'medium', 'low']);
    if (ch.severity && !ALLOWED_SEVERITIES.has(ch.severity)) {
      errors.push(`Challenge ${cid}: unknown severity "${ch.severity}"`);
    }

    if (containsCausalCertainty(ch.challenge)) {
      errors.push(`Challenge ${cid}: causal-certainty language in "challenge"`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// ST-2: Pass 1 LLM prompt — claim-referenced hypotheses
// ---------------------------------------------------------------------------
function buildPass1Prompt(snapshot) {
  const { evidence_index, scientificLimitations, contextSummary } = snapshot;

  const schema = JSON.stringify({
    hypotheses: [
      {
        hypothesis_id : '<surface_charging_esd | single_event_upset | hardware_failure>',
        label         : '<human-readable label>',
        assessment    : '<supported | weakly_supported | mixed | insufficient_evidence>',
        claims        : [
          {
            claim_id    : '<unique string, e.g. ESD-C1>',
            statement   : '<one factual sentence>',
            evidence_ids: ['<evidence_id from the provided list — DO NOT invent IDs>'],
            relationship: '<supports | contradicts | non_discriminating>',
            reasoning   : '<one paragraph>',
            uncertainty : '<observed | inferred | unknown>',
          },
        ],
        missing_evidence: ['<description of measurement not available>'],
        limitations     : ['<scientific limitation from the case>'],
      },
    ],
  }, null, 2);

  const rulesText = `
SCIENTIFIC RULES — you must follow all of these:
1. Observation is not causation. Do not describe a correlation between environmental conditions and the anomaly as proof of causation.
2. Explicitly distinguish between: observed (directly measured), inferred (logically derived), and unknown (no data available).
3. If evidence supports multiple hypotheses equally, label the relationship "non_discriminating".
4. If available evidence cannot distinguish among hypotheses, set assessment to "insufficient_evidence".
5. Explicitly identify important missing measurements in missing_evidence.
6. Do not manufacture spacecraft telemetry, charging measurements, RF data, or ground-system information that is absent from the input.
7. Preserve all scientific limitations listed. Include them in each hypothesis's limitations array.
8. Do not convert heuristic scores into probabilities.
9. Never state that Galaxy 15's failure was definitively caused by ESD, SEU, or any other mechanism.
10. Only cite evidence_id values from the evidence_index provided below. Never invent evidence IDs.
`.trim();

  const system = `You are a space weather forensics analyst. Analyze the satellite anomaly evidence provided and return ONLY a valid JSON object — no markdown, no prose, no explanation outside the JSON.

${rulesText}

Return exactly this schema:
${schema}

Include all three hypotheses. Sort by assessment strength (supported first).`;

  const limitsText = scientificLimitations.length
    ? scientificLimitations.map((l, i) => `  ${i + 1}. ${l}`).join('\n')
    : '  (none recorded)';

  const summaryText = `
Context summary (for orientation only — all claims must cite evidence_ids below):
- Total evidence records in case: ${contextSummary.total_evidence_records}
- Evidence records in this snapshot: ${contextSummary.evidence_index_size}
- Peak electron flux evidence_id: ${contextSummary.peak_ep8_evidence_id || 'N/A'} (value: ${contextSummary.peak_ep8_value !== null ? contextSummary.peak_ep8_value.toFixed(1) + ' p/cm²/s/sr' : 'N/A'})
- Elevated flux readings (>1000 p/cm²/s/sr) evidence_ids: [${contextSummary.elevated_flux_evidence_ids.join(', ')}]
- Magnetic disturbance near anomaly evidence_ids: [${contextSummary.mag_near_anomaly_evidence_ids.join(', ')}]
- Anchor event evidence_ids: [${contextSummary.anchor_evidence_ids.join(', ')}]
`.trim();

  const user = `Galaxy 15 satellite anomaly — 2010-04-05T09:48:00Z.

Scientific limitations you must preserve:
${limitsText}

${summaryText}

Evidence index (only cite evidence_id values from this list):
${JSON.stringify(evidence_index, null, 2)}

Produce the JSON hypothesis object now.`;

  return { system, user };
}

// ---------------------------------------------------------------------------
// ST-3: Pass 2 LLM prompt — claim-level red-team challenges
// ---------------------------------------------------------------------------
function buildPass2Prompt(leadingHypothesis, snapshot) {
  const { evidence_index, contextSummary } = snapshot;

  const schema = JSON.stringify({
    challenges: [
      {
        claim_id           : '<claim_id from the hypothesis claims array>',
        challenge          : '<specific argument against this claim>',
        counter_evidence_ids: ['<evidence_id from the list that contradicts the claim — DO NOT invent IDs>'],
        missing_evidence   : ['<measurement that would be needed to resolve the claim>'],
        severity           : '<high | medium | low>',
        revised_assessment : '<what the assessment should be after applying this challenge>',
      },
    ],
    red_team_summary: '<one paragraph overall challenge summary>',
  }, null, 2);

  const attackPatterns = `
RED-TEAM ATTACK PATTERNS — look specifically for each of these:
1. Unsupported causal claims — any claim that states causation without direct measurement.
2. Evidence used outside its measurement scope — e.g. using electron flux as a proxy for SEU-causing heavy ions.
3. Proxy-vs-direct-measurement errors — GOES-11 data is a proxy for the Galaxy 15 environment, not a direct sample.
4. Temporal correlation mistaken for causation — co-occurring events are not causal.
5. Alternative hypotheses being ignored — identify evidence that is non_discriminating between hypotheses.
6. Missing observations — identify what key measurement is absent and what it would have resolved.
7. Overconfidence — identify claims with "observed" uncertainty that should be "inferred" or "unknown".
8. Hallucinated evidence — flag any claim_id or evidence_id not in the provided evidence list.
`.trim();

  const system = `You are a Red-Team forensics agent. Rigorously challenge the leading hypothesis by attacking its individual claims. Return ONLY a valid JSON object — no markdown, no prose outside the JSON.

${attackPatterns}

Rules:
- Only cite counter_evidence_ids from the evidence_index provided. Never invent IDs.
- Produce at least one challenge per claim in the hypothesis.
- Do not state that any hypothesis is definitively correct or ruled out.

Return exactly this schema:
${schema}`;

  const claimsJson = JSON.stringify(leadingHypothesis.claims || [], null, 2);

  const user = `Leading hypothesis under challenge:
- hypothesis_id: ${leadingHypothesis.hypothesis_id || leadingHypothesis.id}
- label: ${leadingHypothesis.label}
- assessment: ${leadingHypothesis.assessment || '(unknown)'}

Claims to challenge:
${claimsJson}

Evidence index (only cite evidence_id values from this list for counter_evidence_ids):
${JSON.stringify(evidence_index, null, 2)}

Produce the JSON red-team challenge object now.`;

  return { system, user };
}

// ---------------------------------------------------------------------------
// ST-6: Pass 1 — generate competing hypotheses
// ---------------------------------------------------------------------------
async function generateHypothesesPass(evidenceStream) {
  const snapshot   = buildEvidenceSnapshot(evidenceStream, 'galaxy-15');
  const allowedIds = new Set(evidenceStream.map((r) => r.evidence_id).filter(Boolean));
  const llm        = buildLLMClient();

  if (llm) {
    try {
      const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
      const prompt   = buildPass1Prompt(snapshot);
      const response = await llm.invoke([
        new SystemMessage(prompt.system),
        new HumanMessage(prompt.user),
      ]);

      const raw      = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
      const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      const parsed   = JSON.parse(jsonText);

      const { valid, errors } = validatePass1Response(parsed, allowedIds);
      if (!valid) {
        console.error('[aiEngine] Pass 1 validation failed, using heuristic fallback:', errors);
        throw new Error('validation_failed');
      }

      // Retain backward-compatible confidence integer by mapping assessment back to score
      const assessmentToScore = {
        strongly_supported : 85,
        supported          : 72,
        mixed              : 55,
        weakly_supported   : 45,
        insufficient_evidence: 25,
      };

      const hypotheses = parsed.hypotheses.map((h) => ({
        ...h,
        confidence: assessmentToScore[h.assessment] || 50,
      }));
      hypotheses.sort((a, b) => b.confidence - a.confidence);

      return {
        hypotheses,
        top_hypothesis_id: hypotheses[0].hypothesis_id || hypotheses[0].id,
        source           : 'llm',
        generated_at     : new Date().toISOString(),
      };
    } catch (err) {
      console.error('[aiEngine] Pass 1 LLM error, using heuristic fallback:', err.message);
    }
  }

  // Heuristic fallback
  const hypotheses = deterministicHypotheses(snapshot.metrics, snapshot.evidence_index);
  return {
    hypotheses,
    top_hypothesis_id: hypotheses[0].hypothesis_id,
    source           : 'heuristic',
    generated_at     : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// ST-6: Pass 2 — red-team challenge
// ---------------------------------------------------------------------------
async function redTeamChallengePass(leadingHypothesis, evidenceStream) {
  const snapshot   = buildEvidenceSnapshot(evidenceStream, 'galaxy-15');
  const allowedIds = new Set(evidenceStream.map((r) => r.evidence_id).filter(Boolean));
  const llm        = buildLLMClient();

  let challenges;
  let redTeamSummary;
  let source = 'heuristic';

  if (llm) {
    try {
      const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
      const prompt   = buildPass2Prompt(leadingHypothesis, snapshot);
      const response = await llm.invoke([
        new SystemMessage(prompt.system),
        new HumanMessage(prompt.user),
      ]);

      const raw      = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
      const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      const parsed   = JSON.parse(jsonText);

      const { valid, errors } = validatePass2Response(parsed, allowedIds);
      if (!valid) {
        console.error('[aiEngine] Pass 2 validation failed, using heuristic fallback:', errors);
        throw new Error('validation_failed');
      }

      challenges     = parsed.challenges;
      redTeamSummary = parsed.red_team_summary;
      source         = 'llm';
    } catch (err) {
      console.error('[aiEngine] Pass 2 LLM error, using heuristic fallback:', err.message);
    }
  }

  if (!challenges) {
    const hypothesisId = leadingHypothesis.hypothesis_id || leadingHypothesis.id;
    challenges     = deterministicCounterEvidence(hypothesisId, snapshot.evidence_index);
    redTeamSummary =
      `Heuristic red-team analysis of "${leadingHypothesis.label}": ` +
      `While the hypothesis is consistent with the elevated electron flux environment recorded by GOES-11, ` +
      `critical limitations undermine an exclusive causal claim. ` +
      `No onboard surface-charging sensor existed on Galaxy 15, so the ESD inference rests entirely on proxy data. ` +
      `Nominal attitude control throughout the anomaly is a missing signature that a sufficiently large discharge would be expected to produce. ` +
      `All cited evidence_ids are drawn from the provided evidence set; no measurements have been fabricated.`;
  }

  // Re-run heuristic to get updated hypotheses in the new schema
  const baseHypotheses = deterministicHypotheses(snapshot.metrics, snapshot.evidence_index);
  const hypothesisId   = leadingHypothesis.hypothesis_id || leadingHypothesis.id;

  // Compute a rough confidence adjustment for backward compatibility
  const totalImpact = challenges.reduce((s, c) => {
    // Map severity to approximate confidence impact for display only
    const impactMap = { high: -15, medium: -10, low: -5 };
    return s + (impactMap[c.severity] || 0);
  }, 0);

  const updatedHypotheses = baseHypotheses.map((h) => {
    if (h.hypothesis_id === hypothesisId) {
      const newConf = Math.max(0, Math.min(100, h.confidence + totalImpact));
      return {
        ...h,
        confidence: newConf,
        assessment: scoreToAssessment(newConf),
      };
    }
    return h;
  });

  return {
    challenged_hypothesis_id: hypothesisId,
    challenges,
    updated_hypotheses      : updatedHypotheses,
    red_team_summary        : redTeamSummary,
    source,
    generated_at            : new Date().toISOString(),
  };
}

module.exports = {
  generateHypothesesPass,
  redTeamChallengePass,
  // Exported for tests
  validatePass1Response,
  validatePass2Response,
  buildEvidenceSnapshot,
};
