'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// artifactService.js — Phase 7.5
//
// Produces a validated, schema-versioned Investigation Artifact: a complete,
// self-contained record of a forensic investigation at a point in time.
//
// DESIGN INVARIANTS
//
//   ART-1  Evidence is referenced by evidence_id only.  The full evidence
//          dataset is never duplicated into the artifact.
//
//   ART-2  The AI narrative is isolated in a dedicated section tagged with
//          layer:"ai_synthesis".  It can never appear in case_identity,
//          forensic_analysis, or evidence_references sections.
//
//   ART-3  causal_attribution_established is carried verbatim from the
//          deterministic ForensicAnalysis object.  This function never
//          infers, computes, or overrides it.
//
//   ART-4  Hypothesis assessments are carried verbatim from the deterministic
//          ForensicAnalysis object.  The analyst_narrative and analyst_content
//          sections cannot change them.
//
//   ART-5  The environmental_context evidence list is always separate from
//          supporting_evidence in every per-hypothesis record.
//
//   ART-6  No numerical probability claims appear anywhere in the artifact.
//          validateArtifact() checks all free-text fields.
//
//   ART-7  The integrity_digest covers only the stable (content) sections.
//          It explicitly excludes artifact_metadata (timestamps, generator)
//          so that re-generating an artifact from identical inputs produces
//          the same digest.
//
//   ART-8  artifact_schema_version is required for forward compatibility and
//          must be present in every artifact produced and validated by this
//          module.
//
//   ART-9  analyst_content (observations + challenges) is analyst-created
//          content.  It is annotated with layer:"analyst_created" and never
//          merged with forensic_analysis or evidence_references sections.
//
//   ART-10 The artifact is read-only.  This module contains no write path.
//          No investigation store function is called here — callers supply
//          all inputs.
// ---------------------------------------------------------------------------

const ARTIFACT_SCHEMA_VERSION = '1.0.0';
const ARTIFACT_GENERATOR      = 'spaceforensics-artifact-service';

// Regex for numerical probability claims — mirrors aiAnalyst.js A10.
const NUMERICAL_PROBABILITY_RE =
  /\b\d+(\.\d+)?\s*%|\b\d+(\.\d+)?\s*(probability|chance|likelihood)/i;

// ---------------------------------------------------------------------------
// serializeStable(value)
//
// Produces a deterministic JSON string with keys sorted recursively.
// Arrays preserve order (order matters for evidence IDs, lifecycle entries,
// etc.); only object keys are sorted.
// Used exclusively to compute the integrity digest (ART-7).
// ---------------------------------------------------------------------------
function serializeStable(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(serializeStable).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + serializeStable(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// computeArtifactDigest(artifact)
//
// Returns a hex-encoded SHA-256 digest of the stable content sections.
//
// Sections included (ART-7):
//   case_identity, forensic_analysis, analyst_narrative,
//   analyst_content, evidence_references, provenance, limitations
//
// Sections excluded (ART-7):
//   artifact_metadata  — contains generated_at timestamp
//   integrity          — the digest field itself
//   artifact_schema_version — structural metadata, not content
//
// Returns a 64-character hex string.
// ---------------------------------------------------------------------------
function computeArtifactDigest(artifact) {
  const stable = {
    case_identity:     artifact.case_identity,
    forensic_analysis: artifact.forensic_analysis,
    analyst_narrative: artifact.analyst_narrative,
    analyst_content:   artifact.analyst_content,
    evidence_references: artifact.evidence_references,
    provenance:        artifact.provenance,
    limitations:       artifact.limitations,
  };
  return crypto.createHash('sha256').update(serializeStable(stable)).digest('hex');
}

// ---------------------------------------------------------------------------
// assembleArtifact(inputs)
//
// Pure assembly function.  Receives already-validated pipeline outputs and
// investigation store snapshots; produces a complete ArtifactRecord.
//
// Parameters:
//   inputs.caseMeta            — parsed case.json object
//   inputs.report              — ValidatedForensicReport (analysis + narrative)
//   inputs.rows                — Evidence[] from parseEvidenceCSV (for counts)
//   inputs.heuristicWindowNote — string | null from hypotheses.json
//   inputs.investigation       — investigation record from store
//   inputs.observations        — ObservationRecord[] for this investigation
//   inputs.challenges          — ChallengeRecord[] for this investigation
//
// Returns a fully assembled, integrity-digested ArtifactRecord.
// Does NOT perform I/O.  Does NOT call validateArtifact — caller should do so.
// ---------------------------------------------------------------------------
function assembleArtifact({
  caseMeta,
  report,
  rows,
  heuristicWindowNote,
  investigation,
  observations,
  challenges,
}) {
  // ── 1. Case identity ──────────────────────────────────────────────────────
  // Structural identity of the case.  Read-only copy of case.json fields.
  const case_identity = {
    case_id:                caseMeta.case_id,
    title:                  caseMeta.title,
    description:            caseMeta.description     || null,
    causal_attribution:     caseMeta.causal_attribution || null,
    anchor_event:           caseMeta.anchor_event    || null,
    recovery_event:         caseMeta.recovery_event  || null,
    target_asset:           caseMeta.target_asset    || null,
    data_window:            caseMeta.data_window     || null,
    scientific_limitations: caseMeta.scientific_limitations || [],
  };

  // ── 2. Investigation identity ─────────────────────────────────────────────
  const investigation_identity = {
    investigation_id: investigation.investigation_id,
    case_id:          investigation.case_id,
    title:            investigation.title,
    description:      investigation.description || null,
    opened_by:        investigation.opened_by   || null,
    opened_at:        investigation.opened_at,
    status:           investigation.status,
    events:           [...investigation.events],
  };

  // ── 3. Forensic analysis ──────────────────────────────────────────────────
  // Deterministic fields only.  ART-3: causal_attribution_established verbatim.
  // ART-4: hypothesis assessments verbatim.
  // ART-5: environmental_context always separate from supporting_evidence.
  const forensic_analysis = {
    analysis_version:               report.analysis_version,
    causal_attribution_established: report.causal_attribution_established,  // ART-3
    event:                          report.event || null,
    evidence_summary:               report.evidence_summary,
    comparison:                     report.comparison,
    hypotheses: report.hypotheses.map((h) => ({
      hypothesis_id:  h.hypothesis_id,
      label:          h.label,
      assessment:     h.assessment,   // ART-4: verbatim, never overridden
      heuristic_note: h.heuristic_note || null,
      evidence_summary: {
        // ART-5: four lists always separate
        environmental_context_count:        h.evidence_summary.environmental_context_count,
        supporting_evidence_count:          h.evidence_summary.supporting_evidence_count,
        contradicting_evidence_count:       h.evidence_summary.contradicting_evidence_count,
        non_discriminating_evidence_count:  h.evidence_summary.non_discriminating_evidence_count,
        // ART-1: IDs only — no evidence data rows
        environmental_context_ids:          h.evidence_summary.environmental_context_ids,
        supporting_evidence_ids:            h.evidence_summary.supporting_evidence_ids,
        contradicting_evidence_ids:         h.evidence_summary.contradicting_evidence_ids,
        non_discriminating_evidence_ids:    h.evidence_summary.non_discriminating_evidence_ids,
      },
      limitations: (h.limitations || []).map((l) => ({
        type:        l.type,
        description: l.description,
      })),
    })),
    limitations: report.limitations,  // aggregated deduped set
  };

  // ── 4. Evidence references ────────────────────────────────────────────────
  // ART-1: IDs only.  ART-2: AI narrative not present here.
  const allReferencedIds = new Set(
    forensic_analysis.hypotheses.flatMap((h) => [
      ...h.evidence_summary.environmental_context_ids,
      ...h.evidence_summary.supporting_evidence_ids,
      ...h.evidence_summary.contradicting_evidence_ids,
      ...h.evidence_summary.non_discriminating_evidence_ids,
    ]),
  );

  const evidence_references = {
    total_evidence_rows:       rows.length,
    referenced_evidence_count: allReferencedIds.size,
    // Sorted for determinism (ART-7 stability).
    referenced_evidence_ids:   [...allReferencedIds].sort(),
    evidence_by_hypothesis: forensic_analysis.hypotheses.map((h) => ({
      hypothesis_id:                   h.hypothesis_id,
      // ART-5: always four separate lists
      environmental_context_ids:       h.evidence_summary.environmental_context_ids,
      supporting_evidence_ids:         h.evidence_summary.supporting_evidence_ids,
      contradicting_evidence_ids:      h.evidence_summary.contradicting_evidence_ids,
      non_discriminating_evidence_ids: h.evidence_summary.non_discriminating_evidence_ids,
    })),
  };

  // ── 5. Provenance ─────────────────────────────────────────────────────────
  const provenance = {
    data_sources:          caseMeta.data_sources || [],
    heuristic_window_note: heuristicWindowNote || null,
    evidence_count:        rows.length,
  };

  // ── 6. Limitations ────────────────────────────────────────────────────────
  // Already deduplicated by buildForensicAnalysis.
  const limitations = report.limitations;

  // ── 7. Analyst narrative ──────────────────────────────────────────────────
  // ART-2: isolated section, explicitly tagged.  Cannot be placed in
  // forensic_analysis or evidence_references sections.
  const narrative = report.analyst_narrative;
  const analyst_narrative = {
    layer:                          'ai_synthesis',   // ART-2: structural tag
    source:                         narrative.source,
    causal_attribution_established: narrative.causal_attribution_established,
    executive_summary:              narrative.executive_summary,
    event_description:              narrative.event_description,
    hypothesis_assessments: (narrative.hypothesis_assessments || []).map((ha) => ({
      hypothesis_id: ha.hypothesis_id,
      assessment:    ha.assessment,    // ART-4: must equal forensic assessment
      reasoning:     ha.reasoning,
      evidence_ids:  ha.evidence_ids || [],
      limitations:   ha.limitations  || [],
    })),
    strongest_observations: narrative.strongest_observations || [],
    major_uncertainties:    narrative.major_uncertainties    || [],
    missing_evidence:       narrative.missing_evidence       || [],
  };

  // ── 8. Analyst content ────────────────────────────────────────────────────
  // ART-9: analyst-created layer.  Observations include the current (latest)
  // text only — full version history is in /history for audit purposes.
  // Challenges include the full lifecycle for traceability.
  const analyst_content = {
    layer: 'analyst_created',   // ART-9: structural tag
    observation_count: observations.length,
    challenge_count:   challenges.length,
    observations: observations.map((o) => ({
      observation_id: o.observation_id,
      authored_by:    o.authored_by   || null,
      authored_at:    o.authored_at,
      status:         o.status,
      // Current (latest) version text only.  Evidence IDs are references, not data.
      current_text:   o.versions[o.versions.length - 1].text,
      evidence_ids:   o.evidence_ids   || [],   // ART-1: IDs only
      hypothesis_ids: o.hypothesis_ids || [],
    })),
    challenges: challenges.map((c) => ({
      challenge_id:        c.challenge_id,
      target_type:         c.target_type,
      target_id:           c.target_id,
      analyst_statement:   c.analyst_statement,
      status:              c.status,
      authored_by:         c.authored_by || null,
      created_at:          c.created_at,
      evidence_ids:        c.evidence_ids || [],   // ART-1: IDs only
      lifecycle:           c.lifecycle,
      resolution_metadata: c.resolution_metadata || null,
    })),
  };

  // ── 9. Artifact metadata ──────────────────────────────────────────────────
  // Excluded from the digest (ART-7): this section varies per generation.
  const artifact_metadata = {
    generated_at: new Date().toISOString(),
    generator:    ARTIFACT_GENERATOR,
  };

  // ── Assemble pre-digest object ────────────────────────────────────────────
  const preDigest = {
    artifact_schema_version: ARTIFACT_SCHEMA_VERSION,
    artifact_metadata,
    case_identity,
    investigation_identity,
    forensic_analysis,
    evidence_references,
    provenance,
    limitations,
    analyst_narrative,
    analyst_content,
    integrity: null,   // placeholder; replaced below
  };

  // ── Compute digest over stable sections (ART-7) ───────────────────────────
  const digest = computeArtifactDigest(preDigest);

  return {
    ...preDigest,
    integrity: {
      algorithm: 'sha256',
      digest,
      // Explicit declaration of which sections are covered (ART-7).
      covers: [
        'case_identity',
        'forensic_analysis',
        'analyst_narrative',
        'analyst_content',
        'evidence_references',
        'provenance',
        'limitations',
      ],
      excludes: ['artifact_metadata', 'integrity', 'artifact_schema_version'],
    },
  };
}

// ---------------------------------------------------------------------------
// validateArtifact(artifact)
//
// Structural and content validation for an ArtifactRecord.
// Returns { valid: boolean, errors: string[] }.
//
// Rules:
//   V-SCH  artifact_schema_version is present and a non-empty string (ART-8).
//   V-CAU  forensic_analysis.causal_attribution_established is strictly boolean (ART-3).
//   V-HYP  Every hypothesis in forensic_analysis carries a non-empty
//          assessment from the allowed vocabulary (ART-4).
//   V-SEP  environmental_context_ids and supporting_evidence_ids are always
//          separate arrays (ART-5); no evidence_id appears in both for the
//          same hypothesis.
//   V-PROB No numerical probability claims in free-text fields of
//          analyst_narrative (ART-6).
//   V-LAYER analyst_narrative.layer === "ai_synthesis" (ART-2).
//   V-ALAYER analyst_content.layer === "analyst_created" (ART-9).
//   V-DIG  integrity.digest is a 64-char hex string (structural check only;
//          re-computation check is done by verifyArtifactIntegrity).
//   V-REF  Every evidence_id in evidence_references.referenced_evidence_ids
//          appears in at least one hypothesis evidence list (no orphaned IDs).
//   V-NODUP referenced_evidence_ids contains no duplicates.
// ---------------------------------------------------------------------------

const ALLOWED_ASSESSMENTS = new Set([
  'strongly_supported', 'supported', 'mixed', 'weakly_supported', 'insufficient_evidence',
]);

function validateArtifact(artifact) {
  const errors = [];

  if (!artifact || typeof artifact !== 'object') {
    return { valid: false, errors: ['artifact is not an object'] };
  }

  // V-SCH
  if (!artifact.artifact_schema_version || typeof artifact.artifact_schema_version !== 'string') {
    errors.push('V-SCH: artifact_schema_version is missing or not a string');
  }

  // ── forensic_analysis ─────────────────────────────────────────────────────
  const fa = artifact.forensic_analysis;
  if (!fa || typeof fa !== 'object') {
    errors.push('V-CAU: forensic_analysis is missing');
  } else {
    // V-CAU
    if (typeof fa.causal_attribution_established !== 'boolean') {
      errors.push(
        `V-CAU: forensic_analysis.causal_attribution_established must be boolean, ` +
        `got ${typeof fa.causal_attribution_established}`,
      );
    }

    // V-HYP and V-SEP
    if (!Array.isArray(fa.hypotheses)) {
      errors.push('V-HYP: forensic_analysis.hypotheses must be an array');
    } else {
      for (const h of fa.hypotheses) {
        const hid = h.hypothesis_id || '(unknown)';

        if (!h.assessment || !ALLOWED_ASSESSMENTS.has(h.assessment)) {
          errors.push(
            `V-HYP: hypothesis ${hid} has invalid assessment "${h.assessment}"`,
          );
        }

        // V-SEP: environmental_context_ids ∩ supporting_evidence_ids must be ∅
        const ecIds  = new Set(h.evidence_summary && h.evidence_summary.environmental_context_ids || []);
        const seIds  = h.evidence_summary && h.evidence_summary.supporting_evidence_ids || [];
        for (const eid of seIds) {
          if (ecIds.has(eid)) {
            errors.push(
              `V-SEP: hypothesis ${hid} has evidence_id "${eid}" in both ` +
              `environmental_context_ids and supporting_evidence_ids`,
            );
          }
        }
      }
    }
  }

  // ── analyst_narrative ─────────────────────────────────────────────────────
  const an = artifact.analyst_narrative;
  if (!an || typeof an !== 'object') {
    errors.push('V-LAYER: analyst_narrative is missing');
  } else {
    // V-LAYER
    if (an.layer !== 'ai_synthesis') {
      errors.push(`V-LAYER: analyst_narrative.layer must be "ai_synthesis", got "${an.layer}"`);
    }

    // V-PROB: check all free-text fields in analyst_narrative
    const textFields = ['executive_summary', 'event_description'];
    for (const field of textFields) {
      if (NUMERICAL_PROBABILITY_RE.test(an[field] || '')) {
        errors.push(`V-PROB: analyst_narrative.${field} contains a numerical probability claim`);
      }
    }
    for (const ha of (an.hypothesis_assessments || [])) {
      if (NUMERICAL_PROBABILITY_RE.test(ha.reasoning || '')) {
        errors.push(
          `V-PROB: analyst_narrative.hypothesis_assessments[${ha.hypothesis_id}].reasoning ` +
          `contains a numerical probability claim`,
        );
      }
    }
    for (const field of ['strongest_observations', 'major_uncertainties', 'missing_evidence']) {
      for (const text of (an[field] || [])) {
        if (NUMERICAL_PROBABILITY_RE.test(text || '')) {
          errors.push(`V-PROB: analyst_narrative.${field} entry contains a numerical probability claim`);
        }
      }
    }
  }

  // ── analyst_content ───────────────────────────────────────────────────────
  const ac = artifact.analyst_content;
  if (!ac || typeof ac !== 'object') {
    errors.push('V-ALAYER: analyst_content is missing');
  } else {
    // V-ALAYER
    if (ac.layer !== 'analyst_created') {
      errors.push(`V-ALAYER: analyst_content.layer must be "analyst_created", got "${ac.layer}"`);
    }
  }

  // ── integrity ─────────────────────────────────────────────────────────────
  const integ = artifact.integrity;
  if (!integ || typeof integ !== 'object') {
    errors.push('V-DIG: integrity block is missing');
  } else if (typeof integ.digest !== 'string' || !/^[0-9a-f]{64}$/.test(integ.digest)) {
    errors.push('V-DIG: integrity.digest must be a 64-character lowercase hex string');
  }

  // ── evidence_references ───────────────────────────────────────────────────
  const er = artifact.evidence_references;
  if (er && Array.isArray(er.referenced_evidence_ids)) {
    // V-NODUP
    const seen = new Set();
    for (const eid of er.referenced_evidence_ids) {
      if (seen.has(eid)) {
        errors.push(`V-NODUP: evidence_references.referenced_evidence_ids contains duplicate "${eid}"`);
      }
      seen.add(eid);
    }

    // V-REF: every referenced_evidence_id must appear in at least one hypothesis list
    if (fa && Array.isArray(fa.hypotheses)) {
      const inHypotheses = new Set(
        fa.hypotheses.flatMap((h) => {
          const es = h.evidence_summary || {};
          return [
            ...(es.environmental_context_ids       || []),
            ...(es.supporting_evidence_ids         || []),
            ...(es.contradicting_evidence_ids      || []),
            ...(es.non_discriminating_evidence_ids || []),
          ];
        }),
      );
      for (const eid of er.referenced_evidence_ids) {
        if (!inHypotheses.has(eid)) {
          errors.push(
            `V-REF: evidence_references.referenced_evidence_ids contains "${eid}" ` +
            `which does not appear in any hypothesis evidence list`,
          );
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// verifyArtifactIntegrity(artifact)
//
// Re-computes the digest and compares it to artifact.integrity.digest.
// Returns { verified: boolean, expected: string, actual: string }.
//
// This is a tamper-detection check: any modification to the stable sections
// (case_identity, forensic_analysis, analyst_narrative, analyst_content,
// evidence_references, provenance, limitations) will produce a different digest.
//
// Note: artifact_metadata is excluded from the digest so that re-generating
// the same investigation at different times produces the same digest.
// ---------------------------------------------------------------------------
function verifyArtifactIntegrity(artifact) {
  const expected = artifact.integrity && artifact.integrity.digest;
  const actual   = computeArtifactDigest(artifact);
  return {
    verified: expected === actual,
    expected: expected || null,
    actual,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  assembleArtifact,
  validateArtifact,
  verifyArtifactIntegrity,
  computeArtifactDigest,
  serializeStable,
  ARTIFACT_SCHEMA_VERSION,
  ARTIFACT_GENERATOR,
};
