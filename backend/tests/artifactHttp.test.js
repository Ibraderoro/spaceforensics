'use strict';

// ---------------------------------------------------------------------------
// Phase 7.5 — Artifact endpoint HTTP integration tests
//
// GET /api/cases/:id/investigations/:iid/artifact
//
// Groups:
//   AH-1   Top-level structure and schema versioning
//   AH-2   case_identity section
//   AH-3   investigation_identity section
//   AH-4   forensic_analysis section (determinism, causal flag, assessments)
//   AH-5   evidence_references section (IDs only, no data rows)
//   AH-6   provenance section
//   AH-7   limitations section
//   AH-8   analyst_narrative section (layer tag, no probabilities)
//   AH-9   analyst_content section (layer tag, observations, challenges)
//   AH-10  integrity section (digest stability, tamper detection)
//   AH-11  Error handling (404 case, 404 investigation, cross-case)
//   AH-12  Content-Disposition header for download
//   AH-13  Pipeline isolation (forensic pipeline unaffected by investigation content)
//   AH-14  Galaxy-15 baseline preservation
// ---------------------------------------------------------------------------

const request = require('supertest');
const { app, investigationStore, artifactService } = require('../server');

const G15 = 'galaxy-15';
const TCA = 'test-case-alpha';
const G15_VALID_HYPOTHESIS = 'H1';
const G15_VALID_EVIDENCE   = 'E-G15-0001';

async function makeInvestigation(caseId = G15, extra = {}) {
  const res = await request(app)
    .post(`/api/cases/${caseId}/investigations`)
    .send({ title: 'Artifact test', opened_by: 'tester', ...extra });
  expect(res.status).toBe(201);
  return res.body;
}

async function getArtifact(caseId, iid) {
  return request(app).get(`/api/cases/${caseId}/investigations/${iid}/artifact`);
}

beforeEach(() => {
  investigationStore._reset();
});

// ===========================================================================
// AH-1 — Top-level structure and schema versioning
// ===========================================================================
describe('AH-1: top-level structure', () => {
  test('AH-1-1: returns HTTP 200', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.status).toBe(200);
  });

  test('AH-1-2: artifact_schema_version is "1.0.0"', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.artifact_schema_version).toBe('1.0.0');
  });

  test('AH-1-3: all top-level sections are present', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    const b   = res.body;
    expect(b).toHaveProperty('artifact_schema_version');
    expect(b).toHaveProperty('artifact_metadata');
    expect(b).toHaveProperty('case_identity');
    expect(b).toHaveProperty('investigation_identity');
    expect(b).toHaveProperty('forensic_analysis');
    expect(b).toHaveProperty('evidence_references');
    expect(b).toHaveProperty('provenance');
    expect(b).toHaveProperty('limitations');
    expect(b).toHaveProperty('analyst_narrative');
    expect(b).toHaveProperty('analyst_content');
    expect(b).toHaveProperty('integrity');
  });

  test('AH-1-4: artifact_metadata.generated_at is a valid ISO8601 timestamp', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    const ts  = res.body.artifact_metadata.generated_at;
    expect(typeof ts).toBe('string');
    expect(new Date(ts).toISOString()).toBe(ts);
  });

  test('AH-1-5: artifact_metadata.generator identifies this service', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(typeof res.body.artifact_metadata.generator).toBe('string');
    expect(res.body.artifact_metadata.generator.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// AH-2 — case_identity section
// ===========================================================================
describe('AH-2: case_identity section', () => {
  test('AH-2-1: case_id matches the requested case', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.case_identity.case_id).toBe(G15);
  });

  test('AH-2-2: title is a non-empty string', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(typeof res.body.case_identity.title).toBe('string');
    expect(res.body.case_identity.title.length).toBeGreaterThan(0);
  });

  test('AH-2-3: anchor_event carries timestamp', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.case_identity.anchor_event).toHaveProperty('timestamp');
  });

  test('AH-2-4: scientific_limitations is an array of strings', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    const sl  = res.body.case_identity.scientific_limitations;
    expect(Array.isArray(sl)).toBe(true);
    sl.forEach((s) => expect(typeof s).toBe('string'));
  });
});

// ===========================================================================
// AH-3 — investigation_identity section
// ===========================================================================
describe('AH-3: investigation_identity section', () => {
  test('AH-3-1: investigation_id matches', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.investigation_identity.investigation_id).toBe(inv.investigation_id);
  });

  test('AH-3-2: case_id matches', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.investigation_identity.case_id).toBe(G15);
  });

  test('AH-3-3: status reflects current investigation status', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.investigation_identity.status).toBe('open');
  });

  test('AH-3-4: events is a non-empty array with opened event', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(Array.isArray(res.body.investigation_identity.events)).toBe(true);
    expect(res.body.investigation_identity.events[0].event).toBe('opened');
  });
});

// ===========================================================================
// AH-4 — forensic_analysis section
// ===========================================================================
describe('AH-4: forensic_analysis section', () => {
  test('AH-4-1: causal_attribution_established is false for galaxy-15', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.forensic_analysis.causal_attribution_established).toBe(false);
  });

  test('AH-4-2: causal_attribution_established is strictly boolean', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(typeof res.body.forensic_analysis.causal_attribution_established).toBe('boolean');
  });

  test('AH-4-3: analysis_version is a non-empty string', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(typeof res.body.forensic_analysis.analysis_version).toBe('string');
    expect(res.body.forensic_analysis.analysis_version.length).toBeGreaterThan(0);
  });

  test('AH-4-4: galaxy-15 has 5 hypotheses', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.forensic_analysis.hypotheses).toHaveLength(5);
  });

  test('AH-4-5: every hypothesis carries a valid assessment', async () => {
    const ALLOWED = new Set(['strongly_supported','supported','mixed','weakly_supported','insufficient_evidence']);
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    for (const h of res.body.forensic_analysis.hypotheses) {
      expect(ALLOWED.has(h.assessment)).toBe(true);
    }
  });

  test('AH-4-6: H5 assessment is strongly_supported (baseline)', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    const h5  = res.body.forensic_analysis.hypotheses.find((h) => h.hypothesis_id === 'H5');
    expect(h5.assessment).toBe('strongly_supported');
  });

  test('AH-4-7: ART-5 — environmental_context_ids and supporting_evidence_ids are separate', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    for (const h of res.body.forensic_analysis.hypotheses) {
      const ec = new Set(h.evidence_summary.environmental_context_ids);
      for (const eid of h.evidence_summary.supporting_evidence_ids) {
        expect(ec.has(eid)).toBe(false);
      }
    }
  });

  test('AH-4-8: limitations are deduped (non-empty for galaxy-15)', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.forensic_analysis.limitations.length).toBeGreaterThan(0);
    const descs = res.body.forensic_analysis.limitations.map((l) => l.description);
    expect(new Set(descs).size).toBe(descs.length);
  });
});

// ===========================================================================
// AH-5 — evidence_references section (IDs only)
// ===========================================================================
describe('AH-5: evidence_references section', () => {
  test('AH-5-1: total_evidence_rows is 278 for galaxy-15', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.evidence_references.total_evidence_rows).toBe(278);
  });

  test('AH-5-2: referenced_evidence_count > 0', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.evidence_references.referenced_evidence_count).toBeGreaterThan(0);
  });

  test('AH-5-3: ART-1 — no evidence data rows (no timestamp/value fields in references)', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.evidence_references).not.toHaveProperty('evidence_rows');
    for (const h of res.body.evidence_references.evidence_by_hypothesis) {
      expect(h).not.toHaveProperty('timestamp');
      expect(h).not.toHaveProperty('value');
    }
  });

  test('AH-5-4: all referenced_evidence_ids follow E-G15- prefix', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    for (const eid of res.body.evidence_references.referenced_evidence_ids) {
      expect(eid).toMatch(/^E-G15-\d{4}$/);
    }
  });

  test('AH-5-5: referenced_evidence_ids is sorted', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    const ids = res.body.evidence_references.referenced_evidence_ids;
    expect(ids).toEqual([...ids].sort());
  });

  test('AH-5-6: referenced_evidence_ids has no duplicates', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    const ids = res.body.evidence_references.referenced_evidence_ids;
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('AH-5-7: evidence_by_hypothesis has one entry per hypothesis (5 for G15)', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.evidence_references.evidence_by_hypothesis).toHaveLength(5);
  });
});

// ===========================================================================
// AH-6 — provenance section
// ===========================================================================
describe('AH-6: provenance section', () => {
  test('AH-6-1: data_sources is a non-empty array', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(Array.isArray(res.body.provenance.data_sources)).toBe(true);
    expect(res.body.provenance.data_sources.length).toBeGreaterThan(0);
  });

  test('AH-6-2: each data source carries dataset_id and provider', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    for (const ds of res.body.provenance.data_sources) {
      expect(ds).toHaveProperty('dataset_id');
      expect(ds).toHaveProperty('provider');
    }
  });

  test('AH-6-3: heuristic_window_note is a non-empty string for galaxy-15', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(typeof res.body.provenance.heuristic_window_note).toBe('string');
    expect(res.body.provenance.heuristic_window_note.length).toBeGreaterThan(0);
  });

  test('AH-6-4: evidence_count matches total_evidence_rows', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.provenance.evidence_count)
      .toBe(res.body.evidence_references.total_evidence_rows);
  });
});

// ===========================================================================
// AH-7 — limitations section
// ===========================================================================
describe('AH-7: limitations section', () => {
  test('AH-7-1: limitations is a non-empty array for galaxy-15', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.limitations.length).toBeGreaterThan(0);
  });

  test('AH-7-2: each limitation carries type and description', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    for (const l of res.body.limitations) {
      expect(typeof l.type).toBe('string');
      expect(typeof l.description).toBe('string');
    }
  });

  test('AH-7-3: limitation descriptions are unique (deduplication preserved)', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    const descs = res.body.limitations.map((l) => l.description);
    expect(new Set(descs).size).toBe(descs.length);
  });
});

// ===========================================================================
// AH-8 — analyst_narrative section
// ===========================================================================
describe('AH-8: analyst_narrative section', () => {
  test('AH-8-1: ART-2 — layer is "ai_synthesis"', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.analyst_narrative.layer).toBe('ai_synthesis');
  });

  test('AH-8-2: executive_summary is a non-empty string', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(typeof res.body.analyst_narrative.executive_summary).toBe('string');
    expect(res.body.analyst_narrative.executive_summary.length).toBeGreaterThan(0);
  });

  test('AH-8-3: causal_attribution_established matches forensic_analysis', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.analyst_narrative.causal_attribution_established)
      .toBe(res.body.forensic_analysis.causal_attribution_established);
  });

  test('AH-8-4: hypothesis_assessments count matches hypotheses count', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.analyst_narrative.hypothesis_assessments).toHaveLength(
      res.body.forensic_analysis.hypotheses.length,
    );
  });

  test('AH-8-5: source is "heuristic" or "llm"', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(['heuristic', 'llm']).toContain(res.body.analyst_narrative.source);
  });

  test('AH-8-6: ART-6 — no numerical probabilities in executive_summary', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.analyst_narrative.executive_summary).not.toMatch(/\d+(\.\d+)?\s*%/);
  });

  test('AH-8-7: ART-2 — analyst_narrative does NOT appear inside forensic_analysis', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    // forensic_analysis must not contain an analyst_narrative or layer field.
    expect(res.body.forensic_analysis).not.toHaveProperty('analyst_narrative');
    expect(res.body.forensic_analysis).not.toHaveProperty('layer');
  });
});

// ===========================================================================
// AH-9 — analyst_content section
// ===========================================================================
describe('AH-9: analyst_content section', () => {
  test('AH-9-1: ART-9 — layer is "analyst_created"', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.analyst_content.layer).toBe('analyst_created');
  });

  test('AH-9-2: observation_count and challenge_count start at 0', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.analyst_content.observation_count).toBe(0);
    expect(res.body.analyst_content.challenge_count).toBe(0);
  });

  test('AH-9-3: observation is present after creation', async () => {
    const inv = await makeInvestigation();
    await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/observations`)
      .send({ text: 'Particle flux elevated.', authored_by: 'tester' });
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.analyst_content.observation_count).toBe(1);
    expect(res.body.analyst_content.observations).toHaveLength(1);
  });

  test('AH-9-4: ART-1 — observation carries evidence_ids (references only, no data rows)', async () => {
    const inv = await makeInvestigation();
    await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/observations`)
      .send({ text: 'Obs.', authored_by: 'tester', evidence_ids: [G15_VALID_EVIDENCE] });
    const res = await getArtifact(G15, inv.investigation_id);
    const obs = res.body.analyst_content.observations[0];
    expect(obs.evidence_ids).toContain(G15_VALID_EVIDENCE);
    expect(obs).not.toHaveProperty('timestamp');
    expect(obs).not.toHaveProperty('value');
  });

  test('AH-9-5: challenge is present after creation', async () => {
    const inv = await makeInvestigation();
    await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type:       'hypothesis_assessment',
        target_id:         G15_VALID_HYPOTHESIS,
        analyst_statement: 'Questioning the assessment.',
        authored_by:       'tester',
      });
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.analyst_content.challenge_count).toBe(1);
    expect(res.body.analyst_content.challenges).toHaveLength(1);
  });

  test('AH-9-6: challenge carries lifecycle array', async () => {
    const inv = await makeInvestigation();
    await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type:       'limitation',
        target_id:         'proxy',
        analyst_statement: 'Proxy distance concern.',
        authored_by:       'tester',
      });
    const res = await getArtifact(G15, inv.investigation_id);
    const chal = res.body.analyst_content.challenges[0];
    expect(Array.isArray(chal.lifecycle)).toBe(true);
    expect(chal.lifecycle.length).toBeGreaterThan(0);
  });

  test('AH-9-7: resolved challenge carries resolution_metadata', async () => {
    const inv     = await makeInvestigation();
    const chalRes = await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type:       'limitation',
        target_id:         'proxy',
        analyst_statement: 'Proxy distance concern.',
        authored_by:       'tester',
      });
    const cid = chalRes.body.challenge_id;
    await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'under_review', actor: 'reviewer' });
    await request(app)
      .patch(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges/${cid}`)
      .send({ status: 'resolved', actor: 'reviewer', resolution_outcome: 'acknowledged' });

    const res  = await getArtifact(G15, inv.investigation_id);
    const chal = res.body.analyst_content.challenges[0];
    expect(chal.status).toBe('resolved');
    expect(chal.resolution_metadata).not.toBeNull();
    expect(chal.resolution_metadata.resolution_outcome).toBe('acknowledged');
  });
});

// ===========================================================================
// AH-10 — integrity section
// ===========================================================================
describe('AH-10: integrity section', () => {
  test('AH-10-1: integrity.algorithm is "sha256"', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.integrity.algorithm).toBe('sha256');
  });

  test('AH-10-2: integrity.digest is a 64-char hex string', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.integrity.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('AH-10-3: verifyArtifactIntegrity passes on the returned artifact', async () => {
    const inv      = await makeInvestigation();
    const res      = await getArtifact(G15, inv.investigation_id);
    const { verified } = artifactService.verifyArtifactIntegrity(res.body);
    expect(verified).toBe(true);
  });

  test('AH-10-4: digest is identical for two requests with the same investigation state (ART-7)', async () => {
    const inv = await makeInvestigation();
    const [r1, r2] = await Promise.all([
      getArtifact(G15, inv.investigation_id),
      getArtifact(G15, inv.investigation_id),
    ]);
    expect(r1.body.integrity.digest).toBe(r2.body.integrity.digest);
  });

  test('AH-10-5: generated_at differs between two requests but digest is the same', async () => {
    const inv = await makeInvestigation();
    const r1  = await getArtifact(G15, inv.investigation_id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const r2  = await getArtifact(G15, inv.investigation_id);
    // Timestamps may or may not differ at ms resolution, but digests must match.
    expect(r1.body.integrity.digest).toBe(r2.body.integrity.digest);
  });

  test('AH-10-6: tampered assessment fails verifyArtifactIntegrity', async () => {
    const inv      = await makeInvestigation();
    const res      = await getArtifact(G15, inv.investigation_id);
    const tampered = JSON.parse(JSON.stringify(res.body));
    tampered.forensic_analysis.hypotheses[0].assessment = 'strongly_supported';
    const { verified } = artifactService.verifyArtifactIntegrity(tampered);
    expect(verified).toBe(false);
  });

  test('AH-10-7: integrity.covers lists stable sections', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.body.integrity.covers).toContain('forensic_analysis');
    expect(res.body.integrity.covers).toContain('case_identity');
    expect(res.body.integrity.covers).toContain('analyst_narrative');
    expect(res.body.integrity.covers).toContain('analyst_content');
  });

  test('AH-10-8: adding a challenge changes the digest', async () => {
    const inv = await makeInvestigation();
    const r1  = await getArtifact(G15, inv.investigation_id);

    await request(app)
      .post(`/api/cases/${G15}/investigations/${inv.investigation_id}/challenges`)
      .send({
        target_type:       'limitation',
        target_id:         'proxy',
        analyst_statement: 'Proxy distance concern.',
        authored_by:       'tester',
      });

    const r2 = await getArtifact(G15, inv.investigation_id);
    expect(r1.body.integrity.digest).not.toBe(r2.body.integrity.digest);
  });
});

// ===========================================================================
// AH-11 — Error handling
// ===========================================================================
describe('AH-11: error handling', () => {
  test('AH-11-1: 404 for unknown case', async () => {
    const res = await request(app)
      .get('/api/cases/no-such-case/investigations/fake-iid/artifact');
    expect(res.status).toBe(404);
    expect(res.body.error_code).toBe('CASE_NOT_FOUND');
  });

  test('AH-11-2: 404 for unknown investigation', async () => {
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/00000000-0000-0000-0000-000000000000/artifact`);
    expect(res.status).toBe(404);
    expect(res.body.error_code).toBe('INVESTIGATION_NOT_FOUND');
  });

  test('AH-11-3: 404 when investigation belongs to a different case (cross-case)', async () => {
    const inv = await makeInvestigation(TCA);
    const res = await request(app)
      .get(`/api/cases/${G15}/investigations/${inv.investigation_id}/artifact`);
    expect(res.status).toBe(404);
    expect(res.body.error_code).toBe('INVESTIGATION_NOT_FOUND');
  });
});

// ===========================================================================
// AH-12 — Content-Disposition header
// ===========================================================================
describe('AH-12: Content-Disposition header', () => {
  test('AH-12-1: Content-Disposition header is set for download', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
  });

  test('AH-12-2: filename contains the case_id', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.headers['content-disposition']).toContain(G15);
  });

  test('AH-12-3: filename ends with .json', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    expect(res.headers['content-disposition']).toMatch(/\.json/);
  });
});

// ===========================================================================
// AH-13 — Pipeline isolation
// ===========================================================================
describe('AH-13: pipeline isolation', () => {
  test('AH-13-1: forensic_analysis is identical regardless of investigation content', async () => {
    const invEmpty = await makeInvestigation();
    const invFull  = await makeInvestigation();

    await request(app)
      .post(`/api/cases/${G15}/investigations/${invFull.investigation_id}/observations`)
      .send({ text: 'Some observation.', authored_by: 'tester' });
    await request(app)
      .post(`/api/cases/${G15}/investigations/${invFull.investigation_id}/challenges`)
      .send({ target_type: 'limitation', target_id: 'proxy',
              analyst_statement: 'Proxy concern.', authored_by: 'tester' });

    const [rEmpty, rFull] = await Promise.all([
      getArtifact(G15, invEmpty.investigation_id),
      getArtifact(G15, invFull.investigation_id),
    ]);

    expect(rEmpty.body.forensic_analysis.causal_attribution_established)
      .toBe(rFull.body.forensic_analysis.causal_attribution_established);
    expect(rEmpty.body.forensic_analysis.analysis_version)
      .toBe(rFull.body.forensic_analysis.analysis_version);
    expect(JSON.stringify(rEmpty.body.forensic_analysis.hypotheses.map((h) => h.assessment)))
      .toBe(JSON.stringify(rFull.body.forensic_analysis.hypotheses.map((h) => h.assessment)));
  });

  test('AH-13-2: challenges from a different investigation are absent', async () => {
    const inv1 = await makeInvestigation();
    const inv2 = await makeInvestigation();
    await request(app)
      .post(`/api/cases/${G15}/investigations/${inv1.investigation_id}/challenges`)
      .send({ target_type: 'limitation', target_id: 'proxy',
              analyst_statement: 'Challenge in inv1.', authored_by: 'tester' });

    const res = await getArtifact(G15, inv2.investigation_id);
    expect(res.body.analyst_content.challenge_count).toBe(0);
    expect(res.body.analyst_content.challenges).toHaveLength(0);
  });
});

// ===========================================================================
// AH-14 — Galaxy-15 baseline preservation
// ===========================================================================
describe('AH-14: galaxy-15 baseline preservation', () => {
  test('AH-14-1: forensic_analysis matches standalone /forensic-analysis endpoint', async () => {
    const inv = await makeInvestigation();
    const [artRes, faRes] = await Promise.all([
      getArtifact(G15, inv.investigation_id),
      request(app).get(`/api/cases/${G15}/forensic-analysis`),
    ]);
    expect(artRes.status).toBe(200);
    expect(faRes.status).toBe(200);

    const artFa = artRes.body.forensic_analysis;
    const fa    = faRes.body;

    expect(artFa.causal_attribution_established).toBe(fa.causal_attribution_established);
    expect(artFa.analysis_version).toBe(fa.analysis_version);
    expect(artFa.hypotheses.length).toBe(fa.hypotheses.length);
    for (const ah of artFa.hypotheses) {
      const fah = fa.hypotheses.find((h) => h.hypothesis_id === ah.hypothesis_id);
      expect(fah).toBeDefined();
      expect(ah.assessment).toBe(fah.assessment);
    }
  });

  test('AH-14-2: validateArtifact passes on the returned galaxy-15 artifact', async () => {
    const inv = await makeInvestigation();
    const res = await getArtifact(G15, inv.investigation_id);
    const { valid, errors } = artifactService.validateArtifact(res.body);
    expect(errors).toHaveLength(0);
    expect(valid).toBe(true);
  });

  test('AH-14-3: limitations count matches standalone /forensic-analysis', async () => {
    const inv = await makeInvestigation();
    const [artRes, faRes] = await Promise.all([
      getArtifact(G15, inv.investigation_id),
      request(app).get(`/api/cases/${G15}/forensic-analysis`),
    ]);
    expect(artRes.body.limitations.length).toBe(faRes.body.limitations.length);
  });
});
