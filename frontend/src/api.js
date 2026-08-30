// Use VITE_API_BASE for production deployments; fall back to the local dev
// server so that development works without any .env configuration.
const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:5001";

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) {
    throw new Error(`API error ${res.status} on ${path}`);
  }
  return res.json();
}

// apiFetchAllowNotFound returns the parsed JSON body even when the server
// responds with 404. Used for provenance lookups where found: false is a
// valid, expected result rather than an error condition.
async function apiFetchAllowNotFound(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok && res.status !== 404) {
    throw new Error(`API error ${res.status} on ${path}`);
  }
  return res.json();
}

export function fetchCaseList() {
  return apiFetch("/api/cases");
}

export function fetchCaseMeta(caseId) {
  return apiFetch(`/api/cases/${caseId}`);
}

export function fetchTimeline(caseId) {
  return apiFetch(`/api/cases/${caseId}/timeline`);
}

export function fetchEvidenceGraph(caseId) {
  return apiFetch(`/api/cases/${caseId}/evidence-graph`);
}

export function fetchForensicAnalysis(caseId) {
  return apiFetch(`/api/cases/${caseId}/forensic-analysis`);
}

export function postInvestigate(caseId) {
  return apiFetch(`/api/cases/${caseId}/investigate`, { method: "POST" });
}

export function postChallenge(caseId) {
  return apiFetch(`/api/cases/${caseId}/challenge`, { method: "POST" });
}

/**
 * Fetch evidence provenance for a single evidence ID.
 * Returns the full provenance object from getEvidenceProvenance:
 *   { found: true,  evidence_id, timestamp, source, …, hypothesis_relationships }
 *   { found: false, evidence_id, reason }
 * A found: false result arrives as a 404 body — this function always resolves;
 * callers inspect result.found rather than catching errors.
 */
export function fetchEvidenceProvenance(caseId, evidenceId) {
  return apiFetchAllowNotFound(
    `/api/cases/${caseId}/evidence/${evidenceId}/provenance`
  );
}

// ── Phase 7 — Investigation Workspace API ────────────────────────────────────

export function createInvestigation(caseId, { title, opened_by, description } = {}) {
  return apiFetch(`/api/cases/${caseId}/investigations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, opened_by, description }),
  });
}

export function fetchInvestigations(caseId) {
  return apiFetch(`/api/cases/${caseId}/investigations`);
}

export function fetchInvestigation(caseId, iid) {
  return apiFetch(`/api/cases/${caseId}/investigations/${iid}`);
}

export function patchInvestigationStatus(caseId, iid, { status, actor, reason }) {
  return apiFetch(`/api/cases/${caseId}/investigations/${iid}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, actor, reason }),
  });
}

export function fetchInvestigationSummary(caseId, iid) {
  return apiFetch(`/api/cases/${caseId}/investigations/${iid}/summary`);
}

export function fetchInvestigationAssistance(caseId, iid) {
  return apiFetch(`/api/cases/${caseId}/investigations/${iid}/assistance`);
}

export function fetchInvestigationHistory(caseId, iid) {
  return apiFetch(`/api/cases/${caseId}/investigations/${iid}/history`);
}

// ── Observations ──────────────────────────────────────────────────────────────

export function fetchObservations(caseId, iid) {
  return apiFetch(`/api/cases/${caseId}/investigations/${iid}/observations`);
}

export function createObservation(caseId, iid, { text, authored_by, evidence_ids, hypothesis_ids } = {}) {
  return apiFetch(`/api/cases/${caseId}/investigations/${iid}/observations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, authored_by, evidence_ids, hypothesis_ids }),
  });
}

// ── Challenges ────────────────────────────────────────────────────────────────

export function fetchChallenges(caseId, iid) {
  return apiFetch(`/api/cases/${caseId}/investigations/${iid}/challenges`);
}

export function createChallenge(caseId, iid, { target_type, target_id, analyst_statement, authored_by, evidence_ids } = {}) {
  return apiFetch(`/api/cases/${caseId}/investigations/${iid}/challenges`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target_type, target_id, analyst_statement, authored_by, evidence_ids }),
  });
}

export function patchChallengeStatus(caseId, iid, cid, { status, actor, notes, resolution_outcome } = {}) {
  return apiFetch(`/api/cases/${caseId}/investigations/${iid}/challenges/${cid}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, actor, notes, resolution_outcome }),
  });
}
