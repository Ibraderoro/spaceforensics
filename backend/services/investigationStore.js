'use strict';

// ---------------------------------------------------------------------------
// investigationStore.js — Phase 7.2 / 7.4 / 8.1 / 8.2
//
// Public API is unchanged from Phase 7.  Internally the store delegates all
// persistence to a concrete InvestigationRepository implementation.
//
// BACKEND SELECTION (Phase 8.2):
//   When PG_DATABASE is set in the environment, a
//   PostgresInvestigationRepository is used (full persistence across restarts).
//   Otherwise the InMemoryInvestigationRepository is used (fast, in-process
//   — suitable for unit tests and development without a database).
//
// To override in tests, call replaceRepository(repo) before the test and
// _reset() / replaceRepository(null) after.
//
// DOMAIN INVARIANTS
//   STORE-1  Every investigation is scoped to exactly one case_id.
//   STORE-2  investigation_id is a server-generated UUID; never client-supplied.
//   STORE-3  The store is completely separate from the forensic pipeline.
//            buildForensicAnalysis / buildEvidenceGraph / parseEvidenceCSV
//            receive ZERO input from this module.
//   STORE-4  Analyst-created content (observations, challenges) never becomes
//            evidence.  The store contains no evidence rows.
//   STORE-5  evidence_id values cited in observations/challenges must have been
//            validated against the case's own CSV before insertion (caller's
//            responsibility — enforced at the route layer).
//   STORE-6  hypothesis_id values cited in challenges must have been validated
//            against the case's hypotheses.json before insertion (caller's
//            responsibility — enforced at the route layer).
//   STORE-7  causal_attribution_established is never stored or mutated here.
//
// CHALLENGE INVARIANTS (Phase 7.4)
//   CH-1 … CH-8 — see InvestigationRepository.js for full documentation.
// ---------------------------------------------------------------------------

require('dotenv').config();

const {
  InMemoryInvestigationRepository,
  CHALLENGE_TARGET_TYPES,
  CHALLENGE_RESOLUTION_OUTCOMES,
} = require('./InvestigationRepository');

// ---------------------------------------------------------------------------
// Repository factory — selects the backend based on environment.
// ---------------------------------------------------------------------------
function _createDefaultRepository() {
  if (process.env.PG_DATABASE) {
    const { PostgresInvestigationRepository } = require('./PostgresInvestigationRepository');
    return new PostgresInvestigationRepository();
  }
  return new InMemoryInvestigationRepository();
}

// ---------------------------------------------------------------------------
// Singleton repository.
// Tests may inject a replacement via replaceRepository().
// ---------------------------------------------------------------------------
let _repo = _createDefaultRepository();

/**
 * Replace the active repository instance.
 * Pass null to restore the default (environment-selected) repository.
 * TEST USE ONLY — never call this from production routes.
 * @param {import('./InvestigationRepository').InvestigationRepository|null} repo
 */
function replaceRepository(repo) {
  _repo = repo || _createDefaultRepository();
}

// ---------------------------------------------------------------------------
// Public API — thin delegating wrappers.
// Every function signature and return shape is identical to Phase 7.
// ---------------------------------------------------------------------------

function createInvestigation({ case_id, title, opened_by, description }) {
  return _repo.createInvestigation({ case_id, title, opened_by, description });
}

function getInvestigation(investigation_id) {
  return _repo.getInvestigation(investigation_id);
}

function getInvestigationsForCase(case_id) {
  return _repo.getInvestigationsForCase(case_id);
}

function updateInvestigationStatus(investigation_id, { status, actor, reason }) {
  return _repo.updateInvestigationStatus(investigation_id, { status, actor, reason });
}

function createObservation({ investigation_id, text, authored_by, evidence_ids, hypothesis_ids }) {
  return _repo.createObservation({ investigation_id, text, authored_by, evidence_ids, hypothesis_ids });
}

function getObservation(observation_id) {
  return _repo.getObservation(observation_id);
}

function getObservationsForInvestigation(investigation_id) {
  return _repo.getObservationsForInvestigation(investigation_id);
}

function updateObservation(observation_id, { text, authored_by }) {
  return _repo.updateObservation(observation_id, { text, authored_by });
}

function createChallenge({
  investigation_id,
  case_id,
  target_type,
  target_id,
  authored_by,
  analyst_statement,
  evidence_ids,
}) {
  return _repo.createChallenge({
    investigation_id,
    case_id,
    target_type,
    target_id,
    authored_by,
    analyst_statement,
    evidence_ids,
  });
}

function getChallenge(challenge_id) {
  return _repo.getChallenge(challenge_id);
}

function getChallengesForInvestigation(investigation_id) {
  return _repo.getChallengesForInvestigation(investigation_id);
}

function getChallengesForCase(case_id) {
  return _repo.getChallengesForCase(case_id);
}

function transitionChallenge(challenge_id, { status, actor, notes, resolution_outcome }) {
  return _repo.transitionChallenge(challenge_id, { status, actor, notes, resolution_outcome });
}

function reviewChallenge(challenge_id, { status, reviewed_by, review_notes }) {
  return _repo.reviewChallenge(challenge_id, { status, reviewed_by, review_notes });
}

function getInvestigationHistory(investigation_id) {
  return _repo.getInvestigationHistory(investigation_id);
}

// ---------------------------------------------------------------------------
// _reset() — test-only helper.
// Delegates to the repository instance so each test file gets a clean slate.
// ---------------------------------------------------------------------------
function _reset() {
  _repo._reset();
}

// ---------------------------------------------------------------------------
// Exports — identical to Phase 7 module.exports.
// ---------------------------------------------------------------------------
module.exports = {
  createInvestigation,
  getInvestigation,
  getInvestigationsForCase,
  updateInvestigationStatus,
  createObservation,
  getObservation,
  getObservationsForInvestigation,
  updateObservation,
  createChallenge,
  getChallenge,
  getChallengesForInvestigation,
  getChallengesForCase,
  transitionChallenge,
  reviewChallenge,             // backward-compat alias
  getInvestigationHistory,
  CHALLENGE_TARGET_TYPES,
  CHALLENGE_RESOLUTION_OUTCOMES,
  _reset,
  replaceRepository,           // Phase 8.2 — test-only injection hook
};
