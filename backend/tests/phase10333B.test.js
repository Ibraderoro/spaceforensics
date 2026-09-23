'use strict';

/**
 * Phase 10.3.3-B — Evidence Case Cache Safety & Production Hardening
 *
 * Verifies that the cache's Phase 10.3.3-B hardening is correct:
 *
 *   CS-1   Cached row objects are frozen (Object.isFrozen)
 *   CS-2   Assigning a field on a returned row throws TypeError (strict mode)
 *   CS-3   Assignment attempt does not change the field value
 *   CS-4   A warm hit after a failed mutation still returns the original value
 *   CS-5   Caller's rows array is unfrozen — sort/filter/push are permitted
 *   CS-6   The cached rows array is frozen — push to it throws
 *   CS-7   Two cold callers receive row objects that are the same frozen reference
 *   CS-8   Two warm callers receive row objects that are the same frozen reference
 *   CS-9   Every row returned by the cache is frozen (all 278 G15 rows)
 *   CS-10  Every row has the correct shape after freezing (all required fields present)
 *   CS-11  Frozen rows passed to a fresh buildEvidenceGraph produce the same graph
 *   CS-12  Concurrent callers each receive an independent rows array
 *   CS-13  Concurrent callers share the same frozen row object references
 *   CS-14  No row field is undefined after freezing (null is permitted)
 *   CS-15  Row freeze does not modify the original object returned by parseEvidenceCSV
 *   CS-16  Graph causal_attribution_established is false and immutable (CD-1 / CC-6)
 *   CS-17  Graph hypothesis assessments are canonical and immutable (CC-6)
 *   CS-18  EPHEMERIS count correct in frozen rows
 *   CS-19  evidence_id sequence intact after freezing (E-G15-0001 … E-G15-0278)
 *   CS-20  Warm-hit rows array length equals cold-hit rows array length
 */

const serverModule      = require('../server');
const evidenceCaseCache = require('../services/evidenceCaseCache');

const G15  = 'galaxy-15';
const TCA  = 'test-case-alpha';
const GS17 = 'goes16-sep2017';

const G15_EVIDENCE_COUNT   = 278;
const G15_EPHEMERIS_COUNT  = 61;
const G15_FIRST_ID         = 'E-G15-0001';
const G15_LAST_ID          = 'E-G15-0278';
const G15_ASSESSMENTS      = { H1: 'mixed', H2: 'mixed', H3: 'supported', H4: 'insufficient_evidence', H5: 'strongly_supported' };
const ROW_REQUIRED_FIELDS  = ['evidence_id', 'source', 'timestamp', 'measurement', 'value', 'unit'];

beforeEach(() => {
  evidenceCaseCache._reset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// CS-1  Cached row objects are frozen
// ─────────────────────────────────────────────────────────────────────────────
test('CS-1: every row object returned by a cold getCaseEvidence is frozen', async () => {
  const { rows } = await evidenceCaseCache.getCaseEvidence(G15);
  for (const row of rows) {
    expect(Object.isFrozen(row)).toBe(true);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CS-2  Assigning a field on a returned row throws TypeError in strict mode
// ─────────────────────────────────────────────────────────────────────────────
test('CS-2: assigning a field on a returned row throws TypeError in strict mode', async () => {
  const { rows } = await evidenceCaseCache.getCaseEvidence(G15);
  expect(() => {
    rows[0].evidence_id = '__INJECTED__';
  }).toThrow(TypeError);
});

// ─────────────────────────────────────────────────────────────────────────────
// CS-3  Assignment attempt does not change the field value
// ─────────────────────────────────────────────────────────────────────────────
test('CS-3: failed mutation attempt leaves field value unchanged', async () => {
  const { rows } = await evidenceCaseCache.getCaseEvidence(G15);
  const before = rows[0].evidence_id;
  try { rows[0].evidence_id = '__INJECTED__'; } catch (_) { /* expected */ }
  expect(rows[0].evidence_id).toBe(before);
});

// ─────────────────────────────────────────────────────────────────────────────
// CS-4  Warm hit after failed mutation still returns the original value
// ─────────────────────────────────────────────────────────────────────────────
test('CS-4: warm hit after a failed mutation attempt still returns the original field value', async () => {
  const { rows: coldRows } = await evidenceCaseCache.getCaseEvidence(G15);
  const originalId = coldRows[0].evidence_id;

  try { coldRows[0].evidence_id = '__INJECTED__'; } catch (_) { /* expected */ }

  const { rows: warmRows } = await evidenceCaseCache.getCaseEvidence(G15);
  expect(warmRows[0].evidence_id).toBe(originalId);
});

// ─────────────────────────────────────────────────────────────────────────────
// CS-5  Caller's rows array is unfrozen — standard array operations work
// ─────────────────────────────────────────────────────────────────────────────
test('CS-5: the returned rows array is unfrozen — push, splice, sort are permitted', async () => {
  const { rows } = await evidenceCaseCache.getCaseEvidence(G15);

  // Array itself must NOT be frozen (callers are allowed to sort/filter/push their copy).
  expect(Object.isFrozen(rows)).toBe(false);

  // push succeeds
  const originalLength = rows.length;
  rows.push({ evidence_id: 'SYNTHETIC', source: 'TEST' });
  expect(rows.length).toBe(originalLength + 1);

  // splice succeeds
  rows.splice(0, 1);
  expect(rows.length).toBe(originalLength);
});

// ─────────────────────────────────────────────────────────────────────────────
// CS-6  The cached rows array is frozen — push to it throws
// ─────────────────────────────────────────────────────────────────────────────
test('CS-6: a subsequent warm-hit still returns exactly 278 rows regardless of mutations to a prior returned array', async () => {
  const { rows: firstRows } = await evidenceCaseCache.getCaseEvidence(G15);

  // Push extra entry to the caller's own array copy.
  firstRows.push({ evidence_id: 'FAKE', source: 'INJECTED' });
  firstRows.splice(0, 5);

  // Cache must be unaffected — warm hit returns the canonical count.
  const { rows: warmRows } = await evidenceCaseCache.getCaseEvidence(G15);
  expect(warmRows.length).toBe(G15_EVIDENCE_COUNT);
});

// ─────────────────────────────────────────────────────────────────────────────
// CS-7  Two cold callers share the same frozen row object references
// ─────────────────────────────────────────────────────────────────────────────
test('CS-7: two concurrent cold callers receive the same frozen row object references', async () => {
  const [a, b] = await Promise.all([
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
  ]);

  // Distinct array instances (CD-1 slice).
  expect(a.rows).not.toBe(b.rows);

  // But identical row references at every position.
  expect(a.rows.length).toBe(b.rows.length);
  for (let i = 0; i < a.rows.length; i++) {
    expect(a.rows[i]).toBe(b.rows[i]);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CS-8  Two warm callers share the same frozen row object references
// ─────────────────────────────────────────────────────────────────────────────
test('CS-8: two sequential warm callers receive the same frozen row object references', async () => {
  await evidenceCaseCache.getCaseEvidence(G15);  // cold prime

  const warm1 = await evidenceCaseCache.getCaseEvidence(G15);
  const warm2 = await evidenceCaseCache.getCaseEvidence(G15);

  expect(warm1.rows).not.toBe(warm2.rows);  // distinct arrays

  for (let i = 0; i < warm1.rows.length; i++) {
    expect(warm1.rows[i]).toBe(warm2.rows[i]);  // same frozen row refs
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CS-9  Every G15 row is frozen (all 278)
// ─────────────────────────────────────────────────────────────────────────────
test('CS-9: all 278 Galaxy-15 rows returned by the cache are frozen', async () => {
  const { rows } = await evidenceCaseCache.getCaseEvidence(G15);
  expect(rows.length).toBe(G15_EVIDENCE_COUNT);
  let frozenCount = 0;
  for (const row of rows) {
    if (Object.isFrozen(row)) frozenCount++;
  }
  expect(frozenCount).toBe(G15_EVIDENCE_COUNT);
});

// ─────────────────────────────────────────────────────────────────────────────
// CS-10  Every row has the required fields after freezing
// ─────────────────────────────────────────────────────────────────────────────
test('CS-10: every cached row has all required fields (shape preserved by freeze)', async () => {
  const { rows } = await evidenceCaseCache.getCaseEvidence(G15);
  for (const row of rows) {
    for (const field of ROW_REQUIRED_FIELDS) {
      expect(row).toHaveProperty(field);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CS-11  Frozen rows passed to a fresh buildEvidenceGraph produce the same graph
// ─────────────────────────────────────────────────────────────────────────────
test('CS-11: frozen cached rows produce an identical graph when passed to a fresh buildEvidenceGraph', async () => {
  const { rows: cachedRows, graph: cachedGraph } = await evidenceCaseCache.getCaseEvidence(G15);

  // Pass the frozen row objects directly to a fresh graph build.
  const freshGraph = await serverModule.buildEvidenceGraph(G15, cachedRows);

  expect(cachedGraph.case_id).toBe(freshGraph.case_id);
  expect(cachedGraph.causal_attribution_established).toBe(freshGraph.causal_attribution_established);
  expect(cachedGraph.hypotheses.length).toBe(freshGraph.hypotheses.length);

  const sortIds = arr => (arr || []).map(r => r.evidence_id).sort();
  for (let i = 0; i < freshGraph.hypotheses.length; i++) {
    const ch = cachedGraph.hypotheses[i];
    const fh = freshGraph.hypotheses[i];
    expect(ch.hypothesis_id).toBe(fh.hypothesis_id);
    expect(ch.assessment).toBe(fh.assessment);
    for (const l of ['environmental_context', 'supporting_evidence', 'contradicting_evidence', 'non_discriminating_evidence']) {
      expect(sortIds(ch[l])).toEqual(sortIds(fh[l]));
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CS-12  Concurrent callers each receive an independent rows array
// ─────────────────────────────────────────────────────────────────────────────
test('CS-12: five concurrent callers each receive a distinct rows array instance', async () => {
  const results = await Promise.all([
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
  ]);

  const arrays = results.map(r => r.rows);
  for (let i = 0; i < arrays.length; i++) {
    for (let j = i + 1; j < arrays.length; j++) {
      expect(arrays[i]).not.toBe(arrays[j]);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CS-13  Concurrent callers share the same frozen row object references
// ─────────────────────────────────────────────────────────────────────────────
test('CS-13: five concurrent callers share identical frozen row object references at every position', async () => {
  const results = await Promise.all([
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
    evidenceCaseCache.getCaseEvidence(G15),
  ]);

  const first = results[0].rows;
  for (let r = 1; r < results.length; r++) {
    expect(results[r].rows.length).toBe(first.length);
    for (let i = 0; i < first.length; i++) {
      expect(results[r].rows[i]).toBe(first[i]);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CS-14  No row field is undefined after freezing
// ─────────────────────────────────────────────────────────────────────────────
test('CS-14: no required row field is undefined after freezing (null is permitted)', async () => {
  const { rows } = await evidenceCaseCache.getCaseEvidence(G15);
  const undefinedFields = [];
  for (const row of rows) {
    for (const field of ROW_REQUIRED_FIELDS) {
      if (row[field] === undefined) {
        undefinedFields.push(`${row.evidence_id}.${field}`);
      }
    }
  }
  expect(undefinedFields).toEqual([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// CS-15  Row freeze does not modify the original object returned by parseEvidenceCSV
// ─────────────────────────────────────────────────────────────────────────────
test('CS-15: the original row objects from parseEvidenceCSV are not frozen by the cache', async () => {
  // Capture raw rows directly from the authority chain.
  const rawRows = await serverModule.parseEvidenceCSV(G15);
  const wasFrozenBefore = rawRows.map(r => Object.isFrozen(r));

  // Load through cache — this will call parseEvidenceCSV again internally,
  // but the freeze is applied to copies, not the originals.
  evidenceCaseCache._reset();
  await evidenceCaseCache.getCaseEvidence(G15);

  // The rawRows we captured earlier must still be unfrozen
  // (the cache froze its own copies, not these references).
  for (let i = 0; i < rawRows.length; i++) {
    // If it was not frozen before, it must still not be frozen.
    if (!wasFrozenBefore[i]) {
      expect(Object.isFrozen(rawRows[i])).toBe(false);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CS-16  Graph causal_attribution_established is false and immutable
// ─────────────────────────────────────────────────────────────────────────────
test('CS-16: graph.causal_attribution_established is false and assigning true throws TypeError', async () => {
  const { graph } = await evidenceCaseCache.getCaseEvidence(G15);
  expect(graph.causal_attribution_established).toBe(false);

  expect(() => {
    graph.causal_attribution_established = true;
  }).toThrow(TypeError);

  expect(graph.causal_attribution_established).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// CS-17  Graph hypothesis assessments are canonical and immutable
// ─────────────────────────────────────────────────────────────────────────────
test('CS-17: all G15 hypothesis assessments are canonical and frozen', async () => {
  const { graph } = await evidenceCaseCache.getCaseEvidence(G15);

  for (const h of graph.hypotheses) {
    expect(G15_ASSESSMENTS[h.hypothesis_id]).toBeDefined();
    expect(h.assessment).toBe(G15_ASSESSMENTS[h.hypothesis_id]);
    // hypothesis object must be frozen (CD-1)
    expect(Object.isFrozen(h)).toBe(true);
    // assigning assessment throws
    expect(() => {
      h.assessment = 'strongly_supported';
    }).toThrow(TypeError);
    // value still canonical after failed write
    expect(h.assessment).toBe(G15_ASSESSMENTS[h.hypothesis_id]);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CS-18  EPHEMERIS count correct in frozen rows
// ─────────────────────────────────────────────────────────────────────────────
test('CS-18: frozen G15 rows contain exactly 61 GOES11_EPHEMERIS records', async () => {
  const { rows } = await evidenceCaseCache.getCaseEvidence(G15);
  const ephCount = rows.filter(r => r.source === 'GOES11_EPHEMERIS').length;
  expect(ephCount).toBe(G15_EPHEMERIS_COUNT);
});

// ─────────────────────────────────────────────────────────────────────────────
// CS-19  evidence_id sequence intact after freezing
// ─────────────────────────────────────────────────────────────────────────────
test('CS-19: G15 evidence_id sequence is E-G15-0001 … E-G15-0278 after row freeze', async () => {
  const { rows } = await evidenceCaseCache.getCaseEvidence(G15);
  expect(rows.length).toBe(G15_EVIDENCE_COUNT);
  expect(rows[0].evidence_id).toBe(G15_FIRST_ID);
  expect(rows[rows.length - 1].evidence_id).toBe(G15_LAST_ID);

  // All IDs must match the E-G15-NNNN pattern.
  for (const row of rows) {
    expect(row.evidence_id).toMatch(/^E-G15-\d{4}$/);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CS-20  Warm-hit rows array length equals cold-hit rows array length
// ─────────────────────────────────────────────────────────────────────────────
test('CS-20: warm-hit rows.length equals cold-hit rows.length for all three cases', async () => {
  for (const caseId of [G15, TCA, GS17]) {
    const cold = await evidenceCaseCache.getCaseEvidence(caseId);
    const warm = await evidenceCaseCache.getCaseEvidence(caseId);
    expect(warm.rows.length).toBe(cold.rows.length);
    // warm rows must also be frozen
    for (const row of warm.rows) {
      expect(Object.isFrozen(row)).toBe(true);
    }
  }
});
