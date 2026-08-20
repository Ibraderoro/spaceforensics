const API_BASE = "http://localhost:5001";

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) {
    throw new Error(`API error ${res.status} on ${path}`);
  }
  return res.json();
}

export function fetchCaseMeta() {
  return apiFetch("/api/cases/galaxy-15");
}

export function fetchTimeline() {
  return apiFetch("/api/cases/galaxy-15/timeline");
}

export function fetchEvidenceGraph() {
  return apiFetch("/api/cases/galaxy-15/evidence-graph");
}

export function postInvestigate() {
  return apiFetch("/api/cases/galaxy-15/investigate", { method: "POST" });
}

export function postChallenge() {
  return apiFetch("/api/cases/galaxy-15/challenge", { method: "POST" });
}
