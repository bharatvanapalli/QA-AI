'use strict';
// Deterministic unit test for P1 journey partitioning — no LLM, no credits.
const J = require('../server/services/codegen/_journeys');
const assert = require('assert');

// Run case set (input order = how they'd be numbered):
//   A (root)  B→A  C→B          chain of 3
//   D (root)  E→D  F→D          fan-out: D then E,F
//   G                            singleton
//   H→zzz (dangling, not in run) singleton (edge dropped)
const cases = [
  { id: 'A', dependsOnIds: null },
  { id: 'B', dependsOnIds: ['A'] },
  { id: 'C', dependsOnIds: '["B"]' },           // JSON-string form tolerated
  { id: 'D', dependsOnIds: [] },
  { id: 'E', dependsOnIds: ['D'] },
  { id: 'F', dependsOnIds: ['D'] },
  { id: 'G', dependsOnIds: null },
  { id: 'H', dependsOnIds: ['zzz-not-in-run'] },
];

const journeys = J.planJourneys(cases);

// --- Partition property: disjoint + covering ---
const all = journeys.flatMap((j) => j.caseIds);
assert.equal(all.length, cases.length, 'covers every case exactly once (no omissions)');
assert.equal(new Set(all).size, cases.length, 'disjoint — no case in two journeys');

// --- Component grouping ---
const byMember = (id) => journeys.find((j) => j.caseIds.includes(id));
assert.deepEqual(byMember('A').caseIds, ['A', 'B', 'C'], 'A,B,C grouped into one chain, topo-ordered');
assert.equal(byMember('A').isJourney, true, 'the 3-chain is a journey');
const def = byMember('D');
assert.equal(def.caseIds[0], 'D', 'D (the prereq) runs first in its journey');
assert.deepEqual(def.caseIds.slice().sort(), ['D', 'E', 'F'], 'D,E,F grouped together');
assert.ok(def.caseIds.indexOf('D') < def.caseIds.indexOf('E') && def.caseIds.indexOf('D') < def.caseIds.indexOf('F'), 'prereq before both dependents');

// --- Singletons ---
assert.equal(byMember('G').isJourney, false, 'G is a standalone singleton');
assert.equal(byMember('H').isJourney, false, 'H with a dangling (out-of-run) dep is a singleton — edge dropped');
assert.equal(byMember('H').size, 1, 'dangling dep does not couple H to anything');

// --- indexJourneys helper drives the two emit sites ---
const { singletonIds, journeyOf } = J.indexJourneys(cases);
assert.ok(singletonIds.has('G') && singletonIds.has('H'), 'singletonIds = the standalone cases (inline emit)');
assert.ok(!singletonIds.has('B'), 'chained case B is NOT a singleton — it must NOT emit a standalone spec');
assert.equal(journeyOf.get('C').id, journeyOf.get('A').id, 'A and C resolve to the same journey');

// --- Cycle safety: X<->Y must not throw, must return both ---
const cyc = J.planJourneys([{ id: 'X', dependsOnIds: ['Y'] }, { id: 'Y', dependsOnIds: ['X'] }]);
assert.equal(cyc[0].caseIds.length, 2, 'cycle collapses to one journey of both nodes, no throw');

// --- Stable run order ---
assert.equal(journeys[0].caseIds[0], 'A', 'journeys emitted in stable run order (A-chain first)');

console.log('PASS — journey partitioning is a disjoint+covering partition:');
for (const j of journeys) {
  console.log(`  ${j.isJourney ? 'JOURNEY' : 'single '} [${j.caseIds.join(' → ')}]`);
}
console.log('  singletons (inline emit):', [...singletonIds].join(', '));
console.log('  subsumed (journey-only, NO standalone spec):', cases.map((c) => c.id).filter((id) => !singletonIds.has(id)).join(', '));
