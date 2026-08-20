'use strict';

require('dotenv').config();

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
    maxTokens: 1024,
  });
}

// ---------------------------------------------------------------------------
// Helper: partition evidence rows and compute key metrics
// ---------------------------------------------------------------------------
const ANOMALY_TIME = new Date('2010-04-05T09:48:00Z').getTime();
const ELEVATED_FLUX_THRESHOLD = 1000;
const MAG_WINDOW_MS = 10 * 60 * 1000; // ±10 minutes

function classifyEvidence(rows) {
  const ep8Rows  = rows.filter((r) => r.source === 'GOES11_EP8');
  const magRows  = rows.filter((r) => r.source === 'GOES11_MAG');
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
  const TARGET_SPIKE = new Date('2010-04-05T09:27:00Z').getTime();
  const eFluxSpikeRow = ep8Rows.length
    ? ep8Rows.reduce((closest, r) => {
        const d = Math.abs(new Date(r.timestamp).getTime() - TARGET_SPIKE);
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
// Deterministic scoring — Pass 1 fallback
// ---------------------------------------------------------------------------
function deterministicHypotheses(metrics) {
  const { peakEp8, elevatedFluxRows, magNearAnomaly, anchorRows, eFluxSpikeRow, ep8Rows } = metrics;

  let esdScore = 60;
  if (elevatedFluxRows.length >= 5) esdScore += 15;
  if (peakEp8 && peakEp8.value > 2000) esdScore += 10;
  if (eFluxSpikeRow && eFluxSpikeRow.value > 500) esdScore += 5;

  let seuScore = 50;
  if (magNearAnomaly.length > 0) seuScore += 10;
  if (elevatedFluxRows.length >= 3) seuScore += 5;

  let hwScore = 30;
  if (peakEp8 && peakEp8.value > 2000) hwScore -= 10;

  const hypotheses = [
    {
      id: 'surface_charging_esd',
      label: 'Surface Charging / ESD',
      confidence: Math.min(esdScore, 100),
      supporting_evidence: [peakEp8, ...elevatedFluxRows].filter(Boolean),
      reasoning:
        `Sustained elevated electron flux (${elevatedFluxRows.length} readings above ` +
        `${ELEVATED_FLUX_THRESHOLD} p/cm²/s/sr) with a peak of ` +
        `${peakEp8 ? peakEp8.value.toFixed(1) : 'N/A'} at ${peakEp8 ? peakEp8.timestamp : 'N/A'} ` +
        `strongly supports differential surface charging leading to an ESD event on the command processor.`,
    },
    {
      id: 'single_event_upset',
      label: 'Single Event Upset (SEU)',
      confidence: Math.min(seuScore, 100),
      supporting_evidence: [peakEp8, ...magNearAnomaly, ...anchorRows].filter(Boolean),
      reasoning:
        `Energetic particle environment present (${ep8Rows.length} EP8 records) ` +
        `with ${magNearAnomaly.length} magnetic field disturbance readings within ±10 min of anomaly. ` +
        `However, absence of a direct proton flux measurement limits confidence.`,
    },
    {
      id: 'hardware_failure',
      label: 'Hardware Failure',
      confidence: Math.min(hwScore, 100),
      supporting_evidence: [...anchorRows].filter(Boolean),
      reasoning:
        `Complete command unresponsiveness for 9 months is consistent with hardware-level failure. ` +
        `However, the autonomous reboot on 26 Dec 2010 rules out permanent physical destruction, ` +
        `and the coincident space weather environment makes a purely random failure less likely.`,
    },
  ];

  hypotheses.sort((a, b) => b.confidence - a.confidence);
  return hypotheses;
}

// ---------------------------------------------------------------------------
// Deterministic counter-evidence — Pass 2 fallback
// ---------------------------------------------------------------------------
function deterministicCounterEvidence(leadingHypothesisId) {
  const counterMap = {
    surface_charging_esd: [
      {
        type: 'sensor_limitation',
        description:
          'Galaxy 15 had no onboard surface-charging sensors. ESD is inferred from ' +
          'GOES-11 electron flux proxy data, not directly measured on the spacecraft.',
        confidence_impact: -15,
      },
      {
        type: 'missing_signature',
        description:
          'Attitude control remained fully nominal throughout the anomaly. ' +
          'ESD events strong enough to disrupt the command processor typically disturb ' +
          'attitude sensors or produce a detectable voltage transient on the power bus.',
        confidence_impact: -12,
      },
      {
        type: 'missing_signature',
        description:
          'No high-energy proton flux spike was measured. ESD-inducing electron environments ' +
          'are often accompanied by concurrent proton enhancements; the absence of proton data ' +
          '(not available on GOES-11 EP8 E2 variable) leaves this signature unverified.',
        confidence_impact: -8,
      },
      {
        type: 'sensor_limitation',
        description:
          'GOES-11 was at GEO longitude −135.0° W, approximately 2° from Galaxy 15 at −133.0° W. ' +
          'The 5-minute averaging of EP8 smooths sub-minute impulsive flux variations that could ' +
          'indicate the specific discharge trigger.',
        confidence_impact: -5,
      },
    ],
    single_event_upset: [
      {
        type: 'missing_signature',
        description:
          'All transponders and payload remained fully operational throughout the anomaly. ' +
          'A total SEU of the flight computer would typically affect more subsystems beyond ' +
          'just the uplink command receiver.',
        confidence_impact: -18,
      },
      {
        type: 'sensor_limitation',
        description:
          'GOES-11 EP8 measures electrons > 2 MeV. No direct measurement of heavy-ion flux ' +
          'or high-energy protons (> 10 MeV) — the primary SEU-causing particles — was available.',
        confidence_impact: -12,
      },
      {
        type: 'contradicting_data',
        description:
          'Spacecraft autonomously rebooted and resumed normal operations on 26 Dec 2010, ' +
          'suggesting the underlying state was a latch-up or corrupted register, ' +
          'not necessarily a single-event gate rupture.',
        confidence_impact: -5,
      },
    ],
    hardware_failure: [
      {
        type: 'contradicting_data',
        description:
          'Spacecraft autonomously rebooted on 26 Dec 2010 and resumed normal operations. ' +
          'Physical hardware destruction is definitively ruled out.',
        confidence_impact: -25,
      },
      {
        type: 'contradicting_data',
        description:
          'The anomaly onset is tightly correlated with a peak electron flux event measured ' +
          'by GOES-11 EP8. A temporally coincident space weather event makes a purely ' +
          'random hardware failure statistically less probable.',
        confidence_impact: -15,
      },
      {
        type: 'missing_signature',
        description:
          'No pre-anomaly degradation trend was reported in telemetry prior to April 2010. ' +
          'Random hardware failures commonly show precursor symptoms in power or thermal data.',
        confidence_impact: -8,
      },
    ],
  };

  return counterMap[leadingHypothesisId] || counterMap['surface_charging_esd'];
}

// ---------------------------------------------------------------------------
// LLM prompts
// ---------------------------------------------------------------------------
function buildPass1Prompt(metrics) {
  const { peakEp8, elevatedFluxRows, magNearAnomaly, eFluxSpikeRow, totalRows } = metrics;
  return {
    system: `You are a space weather forensics analyst. Analyze the provided satellite anomaly evidence \
and return ONLY a valid JSON object with this exact schema — no markdown, no prose:
{
  "hypotheses": [
    {
      "id": "surface_charging_esd",
      "label": "Surface Charging / ESD",
      "confidence": <integer 0-100>,
      "reasoning": "<one concise paragraph>"
    },
    {
      "id": "single_event_upset",
      "label": "Single Event Upset (SEU)",
      "confidence": <integer 0-100>,
      "reasoning": "<one concise paragraph>"
    },
    {
      "id": "hardware_failure",
      "label": "Hardware Failure",
      "confidence": <integer 0-100>,
      "reasoning": "<one concise paragraph>"
    }
  ]
}
Sort hypotheses by confidence descending. Confidence must be an integer 0-100.`,
    user: `Galaxy 15 satellite anomaly — April 5, 2010 at 09:48 UTC.
GOES-11 evidence summary (${totalRows} records, 08:00–11:00 UTC):
- Peak electron flux (E2 >2 MeV): ${peakEp8 ? peakEp8.value.toFixed(1) + ' p/cm²/s/sr at ' + peakEp8.timestamp : 'N/A'}
- Electron flux readings above ${ELEVATED_FLUX_THRESHOLD} p/cm²/s/sr: ${elevatedFluxRows.length}
- e_flux closest to 09:27 UTC spike window: ${eFluxSpikeRow ? eFluxSpikeRow.value.toFixed(1) + ' at ' + eFluxSpikeRow.timestamp : 'N/A'}
- Magnetic field disturbance readings within ±10 min of anomaly: ${magNearAnomaly.length}
- Spacecraft autonomously rebooted on 26 Dec 2010 (9 months later), ruling out permanent hardware destruction.
- All transponders and payload remained operational during the anomaly.
- No onboard surface-charging sensors on Galaxy 15.
Assign confidence scores and reasoning for each hypothesis.`,
  };
}

function buildPass2Prompt(leadingHypothesis, metrics) {
  const { peakEp8, elevatedFluxRows, magNearAnomaly } = metrics;
  return {
    system: `You are a Red-Team forensics agent. Your task is to rigorously challenge the leading hypothesis \
and find counter-evidence, missing signatures, and sensor limitations that reduce its credibility.
Return ONLY a valid JSON object with this exact schema — no markdown, no prose:
{
  "counter_evidence": [
    {
      "type": "missing_signature" | "contradicting_data" | "sensor_limitation",
      "description": "<specific counter-argument>",
      "confidence_impact": <negative integer>
    }
  ],
  "red_team_summary": "<one paragraph summarising the overall challenge>"
}
Produce at least 3 counter_evidence items for the leading hypothesis.`,
    user: `Leading hypothesis: "${leadingHypothesis.label}" (current confidence: ${leadingHypothesis.confidence}%)
Evidence context:
- Peak electron flux: ${peakEp8 ? peakEp8.value.toFixed(1) + ' p/cm²/s/sr' : 'N/A'}
- Elevated flux readings: ${elevatedFluxRows.length}
- Mag disturbance readings near anomaly: ${magNearAnomaly.length}
- No onboard surface-charging sensors on Galaxy 15 (Star-2 bus, Orbital Sciences).
- No high-energy proton flux measurement available (GOES-11 EP8 E2 variable only).
- Attitude control remained nominal throughout the anomaly.
- All transponders remained operational.
- Spacecraft autonomously recovered 9 months later.
Find all counter-evidence that challenges the leading hypothesis and reduces its confidence.`,
  };
}

// ---------------------------------------------------------------------------
// Pass 1 — generate competing hypotheses
// ---------------------------------------------------------------------------
async function generateHypothesesPass(evidenceStream) {
  const metrics = classifyEvidence(evidenceStream);
  const llm = buildLLMClient();

  if (llm) {
    try {
      const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
      const prompt = buildPass1Prompt(metrics);
      const response = await llm.invoke([
        new SystemMessage(prompt.system),
        new HumanMessage(prompt.user),
      ]);

      const raw = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
      // Strip any accidental markdown fences
      const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      const parsed = JSON.parse(jsonText);

      // Attach supporting_evidence from metrics to each hypothesis
      const evidenceMap = {
        surface_charging_esd: [metrics.peakEp8, ...metrics.elevatedFluxRows].filter(Boolean),
        single_event_upset:   [metrics.peakEp8, ...metrics.magNearAnomaly, ...metrics.anchorRows].filter(Boolean),
        hardware_failure:     [...metrics.anchorRows].filter(Boolean),
      };

      const hypotheses = parsed.hypotheses.map((h) => ({
        ...h,
        supporting_evidence: evidenceMap[h.id] || [],
      }));
      hypotheses.sort((a, b) => b.confidence - a.confidence);

      return {
        hypotheses,
        top_hypothesis_id: hypotheses[0].id,
        source: 'llm',
        generated_at: new Date().toISOString(),
      };
    } catch (err) {
      // Fall through to deterministic on any LLM or parse error
      console.error('[aiEngine] Pass 1 LLM error, using fallback:', err.message);
    }
  }

  // Deterministic fallback
  const hypotheses = deterministicHypotheses(metrics);
  return {
    hypotheses,
    top_hypothesis_id: hypotheses[0].id,
    source: 'deterministic',
    generated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Pass 2 — red-team challenge
// ---------------------------------------------------------------------------
async function redTeamChallengePass(leadingHypothesis, evidenceStream) {
  const metrics = classifyEvidence(evidenceStream);
  const llm = buildLLMClient();

  let counterEvidence;
  let redTeamSummary;
  let source = 'deterministic';

  if (llm) {
    try {
      const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
      const prompt = buildPass2Prompt(leadingHypothesis, metrics);
      const response = await llm.invoke([
        new SystemMessage(prompt.system),
        new HumanMessage(prompt.user),
      ]);

      const raw = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
      const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      const parsed = JSON.parse(jsonText);

      counterEvidence = parsed.counter_evidence;
      redTeamSummary  = parsed.red_team_summary;
      source = 'llm';
    } catch (err) {
      console.error('[aiEngine] Pass 2 LLM error, using fallback:', err.message);
    }
  }

  if (!counterEvidence) {
    counterEvidence = deterministicCounterEvidence(leadingHypothesis.id);
    redTeamSummary =
      `Red-team analysis of "${leadingHypothesis.label}": ` +
      `While the hypothesis is consistent with the elevated electron flux environment, ` +
      `critical counter-evidence weakens its exclusive claim. ` +
      `The absence of onboard surface-charging sensors means ESD is inferred, not measured. ` +
      `The nominal attitude control response argues against a discharge strong enough to ` +
      `disrupt the command processor. These gaps reduce confidence by ` +
      `${Math.abs(counterEvidence.reduce((s, c) => s + c.confidence_impact, 0))} points.`;
  }

  // Apply confidence adjustments to all hypotheses by running Pass 1 deterministic
  const baseHypotheses = deterministicHypotheses(metrics);
  const totalImpact = counterEvidence.reduce((s, c) => s + (c.confidence_impact || 0), 0);

  const updatedHypotheses = baseHypotheses.map((h) => {
    if (h.id === leadingHypothesis.id) {
      return {
        ...h,
        confidence: Math.max(0, Math.min(100, h.confidence + totalImpact)),
        reasoning: h.reasoning + ` [Red-team adjusted: ${totalImpact} pts]`,
      };
    }
    // Brief counter-note for remaining hypotheses
    const briefs = {
      single_event_upset:
        'SEU remains plausible but lacks direct proton flux evidence; transponder survival argues against a total bit-flip.',
      hardware_failure:
        'Hardware failure is challenged by the autonomous Dec 2010 recovery and the temporally correlated space weather event.',
      surface_charging_esd:
        'ESD remains the leading candidate despite counter-evidence; no onboard sensors available to confirm or deny.',
    };
    return {
      ...h,
      reasoning: briefs[h.id] || h.reasoning,
    };
  });

  return {
    challenged_hypothesis_id: leadingHypothesis.id,
    counter_evidence: counterEvidence,
    updated_hypotheses: updatedHypotheses,
    red_team_summary: redTeamSummary,
    source,
    generated_at: new Date().toISOString(),
  };
}

module.exports = { generateHypothesesPass, redTeamChallengePass };
