'use strict';

// ---------------------------------------------------------------------------
// evidenceCaseCache.js — Phase 10.3.1 / 10.3.2 / 10.3.3-A / 10.3.3-B
//
// Per-case evidence/graph cache.  Infrastructure optimisation ONLY.
//
// PURPOSE
//   Avoid re-executing parseEvidenceCSV + buildEvidenceGraph on every HTTP
//   request.  Both functions are deterministic for a given set of case files;
//   re-running them produces identical results until the source files change.
//
// DESIGN INVARIANTS  (Phase 10.3.1 CC-* + Phase 10.3.2 CD-* + Phase 10.3.3-A/B)
//   CC-1  Cache is strictly keyed by caseId.
//   CC-2  Unknown or failed loads are never cached.
//   CC-3  Loading always delegates to parseEvidenceCSV → buildEvidenceGraph.
//   CC-4  (superseded by CD-1 below) — see mutation safety section.
//   CC-5  Invalidation is explicit or automatic on source-signature mismatch.
//   CC-6  The cache never modifies forensic results, assessments, or causal flag.
//   CC-7  No external caching dependencies.
//
//   CD-1  MUTATION SAFETY — returned rows/graph are fully isolated (Phase 10.3.3-B).
//         Specifically:
//           • Each row object is frozen before storage: Object.freeze on a
//             shallow copy of the raw parsed row.  Callers that try to assign
//             a field in strict mode receive a TypeError; silent-mode attempts
//             are no-ops.  This prevents any field-level corruption of cached
//             row data (e.g. evidence_id, source, value) across warm hits.
//           • The cached rows array itself is frozen (no push/splice).
//           • returned rows to each caller is a NEW unfrozen array (allows
//             callers to sort/filter their copy) whose elements are the same
//             frozen row references.
//           • returned graph is a shallow frozen copy: top-level properties
//             are non-writable (prevents causal_attribution_established = true,
//             case_id reassignment, etc.).  Nested hypothesis arrays are frozen
//             too (prevents splice/push), and each hypothesis object is frozen.
//             The deep hypothesis list arrays (environmental_context etc.) and
//             their ref objects are also frozen.
//           Freezing happens once at load time so warm hits pay zero extra cost.
//
//   CD-2  IN-FLIGHT DEDUPLICATION — concurrent cold requests for the same
//         caseId share one underlying load Promise.  The Promise is stored in
//         _inFlight.  All concurrent callers await the same Promise; only one
//         parseEvidenceCSV + buildEvidenceGraph pair is executed per case per
//         cold interval.
//
//         The _inFlight entry is always removed in a finally block, ensuring
//         cleanup on both success and failure paths.  A subsequent retry after
//         failure starts a fresh load.
//
//   CD-3  Invalidation during an in-flight load:
//         invalidateCase removes the _cache entry immediately.  The in-flight
//         Promise continues to completion; on success it writes a fresh entry
//         (overwriting any state between the invalidation and completion).
//         This is the safest deterministic behavior — the entry written is
//         from a load that was already running with a valid case, so the data
//         is correct.  No stale entry is possible: either the in-flight
//         succeeds (correct data) or it fails (nothing is written).
//
// SOURCE SIGNATURE STRATEGY
//   Files that fully determine parseEvidenceCSV + buildEvidenceGraph output:
//     1. cases/{caseId}/normalized/*_evidence.csv
//     2. cases/{caseId}/case.json
//     3. cases/{caseId}/hypotheses.json
//   Signature = JSON string of sorted { path, mtimeMs, size } triples.
//   Any mtime or size change → signature mismatch → stale entry discarded.
//   No TTL.  No external dependencies.
//
// PUBLIC API
//   getCaseEvidence(caseId)  → Promise<{ rows: object[], graph: object }>
//   invalidateCase(caseId)   → void
//   invalidateAll()          → void
//   has(caseId)              → boolean
//   getStats()               → { size, hits, misses, invalidations, inFlight }
//   _reset()                 → void  (test-only)
// ---------------------------------------------------------------------------

const fs   = require('fs');
const path = require('path');

function _getAuthority() {
  return require('../server');
}

const CASES_DIR = path.join(__dirname, '..', '..', 'cases');

// ---------------------------------------------------------------------------
// Source-signature helpers
// ---------------------------------------------------------------------------

async function _statFile(filePath) {
  try {
    const st = await fs.promises.stat(filePath);
    return { path: filePath, mtimeMs: st.mtimeMs, size: st.size };
  } catch (_) {
    return null;
  }
}

async function _buildSourceSignature(caseId) {
  const normalizedDir = path.join(CASES_DIR, caseId, 'normalized');
  try {
    await fs.promises.access(normalizedDir);
  } catch (_) {
    return null;
  }

  let csvPath;
  try {
    const entries    = await fs.promises.readdir(normalizedDir);
    const candidates = entries.filter(f => /_evidence\.csv$/.test(f));
    if (candidates.length !== 1) return null;
    csvPath = path.join(normalizedDir, candidates[0]);
  } catch (_) {
    return null;
  }

  const caseJsonPath   = path.join(CASES_DIR, caseId, 'case.json');
  const hypothesesPath = path.join(CASES_DIR, caseId, 'hypotheses.json');

  const [csvStat, caseStat, hypoStat] = await Promise.all([
    _statFile(csvPath),
    _statFile(caseJsonPath),
    _statFile(hypothesesPath),
  ]);

  if (!csvStat) return null;

  const parts = [csvStat, caseStat, hypoStat]
    .filter(Boolean)
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  return JSON.stringify(parts);
}

// ---------------------------------------------------------------------------
// Mutation-safety helpers  (CD-1)
// ---------------------------------------------------------------------------

/**
 * Freeze a row object returned by parseEvidenceCSV.
 * Returns a new frozen shallow-copy so that callers cannot mutate evidence
 * fields (evidence_id, source, value, etc.) through the reference they hold.
 * The copy avoids altering the object that parseEvidenceCSV originally built.
 *
 * @param {object} row
 * @returns {Readonly<object>}
 */
function _freezeRow(row) {
  return Object.freeze(Object.assign({}, row));
}

/**
 * Freeze a hypothesis ref object (evidence_id, relationship, interpretation).
 * Returns the same object, now frozen.
 */
function _freezeRef(ref) {
  return Object.freeze(ref);
}

/**
 * Freeze a hypothesis object including all its list arrays and their refs.
 * Returns a new frozen object — the original (as built by buildEvidenceGraph)
 * is left untouched to avoid side-effects on the raw graph object.
 */
const HYPO_LISTS = [
  'environmental_context',
  'supporting_evidence',
  'contradicting_evidence',
  'non_discriminating_evidence',
];

function _freezeHypothesis(h) {
  const frozen = Object.assign({}, h);
  for (const l of HYPO_LISTS) {
    if (Array.isArray(frozen[l])) {
      frozen[l] = Object.freeze(frozen[l].map(_freezeRef));
    }
  }
  if (Array.isArray(frozen.limitations)) {
    frozen.limitations = Object.freeze(frozen.limitations.slice());
  }
  return Object.freeze(frozen);
}

/**
 * Produce a frozen, shallowly-isolated copy of the graph.
 *
 * Top-level fields (case_id, causal_attribution_established) are non-writable.
 * The hypotheses array and each hypothesis object are frozen.
 * Row objects in hypothesis list entries are frozen.
 *
 * This is not a deep-clone of rows (too expensive for 278+ rows on every warm
 * hit).  Row immutability is handled at the `rows` array level: callers receive
 * a new Array copy (so push/pop/splice on the array cannot corrupt the cache),
 * while individual row objects are the same references — callers must not
 * mutate row fields (documented invariant, tested in CACHE-14 / MUT-* tests).
 *
 * @param {object} graph
 * @returns {object} frozen graph copy
 */
function _freezeGraph(graph) {
  const frozenHypotheses = Object.freeze((graph.hypotheses || []).map(_freezeHypothesis));
  return Object.freeze(Object.assign({}, graph, { hypotheses: frozenHypotheses }));
}

// ---------------------------------------------------------------------------
// In-memory cache store
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   case_id:          string,
 *   rows:             Readonly<object>[],  // frozen row copies; array itself is frozen
 *   graph:            Readonly<object>,    // frozen graph copy
 *   source_signature: string,
 *   loaded_at:        number,
 * }} CacheEntry
 */

/** @type {Map<string, CacheEntry>} */
const _cache = new Map();

/**
 * In-flight loader map — keyed by caseId.
 * Value is a Promise that resolves to { rows, graph } after the load completes.
 * Entry is removed (win or fail) once the Promise settles.
 *
 * @type {Map<string, Promise<{rows:object[],graph:object}>>}
 */
const _inFlight = new Map();

let _hits          = 0;
let _misses        = 0;
let _invalidations = 0;

// ---------------------------------------------------------------------------
// Internal loader (shared by in-flight deduplication)
// ---------------------------------------------------------------------------

/**
 * Perform one full cold load: parse CSV, build graph, store to cache.
 * The _inFlight entry is removed in a finally block — always, win or fail.
 *
 * @param {string} caseId
 * @param {string} sig      Current source signature (already validated non-null)
 * @returns {Promise<{rows:object[],graph:object}>}
 */
async function _doLoad(caseId, sig) {
  const { parseEvidenceCSV, buildEvidenceGraph } = _getAuthority();

  try {
    const rawRows = await parseEvidenceCSV(caseId);
    const graph   = await buildEvidenceGraph(caseId, rawRows);

    // Freeze each row object (CD-1 Phase 10.3.3-B): shallow-copy then freeze.
    // This prevents any caller from mutating a field (e.g. evidence_id) through
    // the reference they hold, which would otherwise corrupt all future warm hits
    // sharing that same row reference.
    // buildEvidenceGraph has already consumed rawRows above, so freezing copies
    // here does not affect its output.
    const frozenRows  = Object.freeze(rawRows.map(_freezeRow));
    const frozenGraph = _freezeGraph(graph);

    // Atomically store — overwrites any stale entry that survived between the
    // start of this load and its completion (CD-3 safe: data is fresh).
    _cache.set(caseId, {
      case_id:          caseId,
      rows:             frozenRows,   // frozen array of frozen row copies
      graph:            frozenGraph,
      source_signature: sig,
      loaded_at:        Date.now(),
    });

    // Return the frozen rows directly — getCaseEvidence wraps every return
    // path with .slice() so each caller gets their own array instance.
    return { rows: frozenRows, graph: frozenGraph };
  } finally {
    // Always remove the in-flight entry — both on success and on any failure.
    // Concurrent callers that joined this Promise will receive the same
    // resolved value or rejection; the entry is no longer needed after
    // the Promise settles (CD-2).
    _inFlight.delete(caseId);
  }
}

// ---------------------------------------------------------------------------
// getCaseEvidence(caseId)  — public API
// ---------------------------------------------------------------------------

/**
 * Returns { rows, graph } for the given caseId.
 *
 *   Cold (miss or stale signature):
 *     If another request is already loading the same case, this request joins
 *     that in-flight Promise (deduplication — CD-2).  Otherwise a new load
 *     is started.
 *
 *   Warm (hit + valid signature):
 *     Returns cached data immediately.  rows is a new Array copy (CD-1).
 *
 *   Unknown case (signature = null):
 *     Throws { status: 404 } — not cached (CC-2).
 *
 * @param {string} caseId
 * @returns {Promise<{ rows: object[], graph: object }>}
 */
async function getCaseEvidence(caseId) {
  // 1. Cheap stat-based signature check.
  const sig = await _buildSourceSignature(caseId);

  if (sig === null) {
    throw { status: 404, message: `Case not found: ${caseId}` };
  }

  // 2. Warm hit — valid signature.
  const existing = _cache.get(caseId);
  if (existing && existing.source_signature === sig) {
    _hits++;
    // Return a new rows array (CD-1) so callers cannot push/splice the cached array.
    // Individual row objects are shared references (documented: callers must not mutate).
    return { rows: existing.rows.slice(), graph: existing.graph };
  }

  // 3. Stale — remove the stale entry and count as an invalidation.
  if (existing) {
    _cache.delete(caseId);
    _invalidations++;
  }

  // 4. Cold miss — check for an in-flight load for this case (CD-2).
  //    Join the existing load Promise.  Each joiner gets its own rows.slice()
  //    so callers cannot share the same array reference (CD-1 parity).
  if (_inFlight.has(caseId)) {
    _misses++;   // each waiting request counts as a miss (it didn't get a hit)
    return _inFlight.get(caseId).then(r => ({ rows: r.rows.slice(), graph: r.graph }));
  }

  // 5. First cold request — start a new load and register it as in-flight.
  //    Also wrap for rows-slice parity with joiners.
  _misses++;
  const loadPromise = _doLoad(caseId, sig);
  _inFlight.set(caseId, loadPromise);
  return loadPromise.then(r => ({ rows: r.rows.slice(), graph: r.graph }));
}

// ---------------------------------------------------------------------------
// invalidateCase(caseId)
// ---------------------------------------------------------------------------

/**
 * Remove the cache entry for caseId.
 * If a load is in-flight, it will still complete and write a fresh entry (CD-3).
 *
 * @param {string} caseId
 */
function invalidateCase(caseId) {
  if (_cache.has(caseId)) {
    _cache.delete(caseId);
    _invalidations++;
  }
  // Note: _inFlight entry is intentionally NOT deleted here (CD-3).
}

// ---------------------------------------------------------------------------
// invalidateAll()
// ---------------------------------------------------------------------------

/**
 * Remove all cache entries.
 * In-flight loads continue; on completion they repopulate the cache.
 */
function invalidateAll() {
  const count = _cache.size;
  _cache.clear();
  _invalidations += count;
  // In-flight entries continue — same CD-3 rationale.
}

// ---------------------------------------------------------------------------
// has(caseId)
// ---------------------------------------------------------------------------

/**
 * True if caseId has a live cache entry (signature revalidated at next get).
 *
 * @param {string} caseId
 * @returns {boolean}
 */
function has(caseId) {
  return _cache.has(caseId);
}

// ---------------------------------------------------------------------------
// getStats()
// ---------------------------------------------------------------------------

/**
 * @returns {{ size: number, hits: number, misses: number, invalidations: number, inFlight: number }}
 */
function getStats() {
  return {
    size:          _cache.size,
    hits:          _hits,
    misses:        _misses,
    invalidations: _invalidations,
    inFlight:      _inFlight.size,
  };
}

// ---------------------------------------------------------------------------
// _reset() — test-only
// ---------------------------------------------------------------------------
function _reset() {
  _cache.clear();
  _inFlight.clear();
  _hits          = 0;
  _misses        = 0;
  _invalidations = 0;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  getCaseEvidence,
  invalidateCase,
  invalidateAll,
  has,
  getStats,
  _reset,
};
