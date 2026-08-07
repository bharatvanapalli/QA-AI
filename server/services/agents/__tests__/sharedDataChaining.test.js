'use strict';

/**
 * Tests for P0-17 — markUnsatisfiedDataDependencies.
 *
 * Verifies that the architect output validator correctly identifies cases
 * whose requiresData keys have no upstream producer in their transitive
 * dependsOnNames chain, and correctly flags them via c.dataWarnings.
 *
 * Run with:
 *   node server/services/agents/__tests__/sharedDataChaining.test.js
 */

const { markUnsatisfiedDataDependencies } = require('../architect');

let failures = 0;
function expect(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`  PASS  ${label}`); }
  else {
    console.log(`  FAIL  ${label}`);
    console.log(`        expected: ${JSON.stringify(expected)}`);
    console.log(`        actual:   ${JSON.stringify(actual)}`);
    failures += 1;
  }
}

function makeScens(cases) {
  return [{ name: 'Scen', cases }];
}

// ─────────────────────────────────────────────────────────────────────────
console.log('P0-17 — direct dep satisfies requiresData: VALID');
{
  const producer = { name: 'Place order', producesData: ['orderId'], dependsOnNames: [] };
  const consumer = { name: 'Track shipment', requiresData: ['orderId'], dependsOnNames: ['Place order'] };
  const scens = makeScens([producer, consumer]);
  const r = markUnsatisfiedDataDependencies(scens);
  expect('satisfiedCases=1', r.satisfiedCases, 1);
  expect('unsatisfiedCases=0', r.unsatisfiedCases, 0);
  expect('no dataWarnings on consumer', consumer.dataWarnings, undefined);
}

console.log('');
console.log('P0-17 — requiresData with no dependsOnNames at all: UNSATISFIED');
{
  const consumer = { name: 'Track shipment', requiresData: ['orderId'], dependsOnNames: [] };
  const scens = makeScens([consumer]);
  const r = markUnsatisfiedDataDependencies(scens);
  expect('unsatisfiedCases=1', r.unsatisfiedCases, 1);
  expect('unsatisfiedKeys=1', r.unsatisfiedKeys, 1);
  expect('dataWarnings set', Array.isArray(consumer.dataWarnings), true);
  expect('warning mentions orderId', consumer.dataWarnings[0].includes('orderId'), true);
}

console.log('');
console.log('P0-17 — dep exists but does NOT produce the required key: UNSATISFIED');
{
  const producer = { name: 'Login', producesData: ['sessionToken'], dependsOnNames: [] };
  const consumer = { name: 'Track shipment', requiresData: ['orderId'], dependsOnNames: ['Login'] };
  const scens = makeScens([producer, consumer]);
  const r = markUnsatisfiedDataDependencies(scens);
  expect('unsatisfiedCases=1', r.unsatisfiedCases, 1);
  expect('orderId not satisfied by Login', consumer.dataWarnings[0].includes('orderId'), true);
}

console.log('');
console.log('P0-17 — multiple deps, one satisfies the key: VALID');
{
  const login = { name: 'Login', producesData: ['sessionToken'], dependsOnNames: [] };
  const order = { name: 'Place order', producesData: ['orderId'], dependsOnNames: ['Login'] };
  const consumer = {
    name: 'Cancel order',
    requiresData: ['orderId'],
    dependsOnNames: ['Login', 'Place order'],
  };
  const scens = makeScens([login, order, consumer]);
  const r = markUnsatisfiedDataDependencies(scens);
  expect('satisfiedCases=1', r.satisfiedCases, 1);
  expect('unsatisfiedCases=0', r.unsatisfiedCases, 0);
  expect('no warnings', consumer.dataWarnings, undefined);
}

console.log('');
console.log('P0-17 — no requiresData: case is skipped entirely');
{
  const c = { name: 'Login', producesData: ['sessionToken'], dependsOnNames: [] };
  const scens = makeScens([c]);
  const r = markUnsatisfiedDataDependencies(scens);
  expect('satisfiedCases=0 (no requiresData)', r.satisfiedCases, 0);
  expect('unsatisfiedCases=0', r.unsatisfiedCases, 0);
  expect('no warnings', c.dataWarnings, undefined);
}

console.log('');
console.log('P0-17 — empty requiresData array: treated as absent');
{
  const c = { name: 'Login', requiresData: [], dependsOnNames: [] };
  const scens = makeScens([c]);
  const r = markUnsatisfiedDataDependencies(scens);
  expect('empty requiresData: skipped', r.unsatisfiedCases, 0);
  expect('no warnings', c.dataWarnings, undefined);
}

console.log('');
console.log('P0-17 — transitive chain A→B→C: C requires A\'s produced key via B: VALID');
{
  const a = { name: 'A', producesData: ['trackingId'], dependsOnNames: [] };
  const b = { name: 'B', dependsOnNames: ['A'] };
  const c = { name: 'C', requiresData: ['trackingId'], dependsOnNames: ['B'] };
  const scens = makeScens([a, b, c]);
  const r = markUnsatisfiedDataDependencies(scens);
  expect('transitive satisfied', r.satisfiedCases, 1);
  expect('no unsatisfied', r.unsatisfiedCases, 0);
  expect('no warnings on C', c.dataWarnings, undefined);
}

console.log('');
console.log('P0-17 — multiple missing keys counted individually');
{
  const consumer = {
    name: 'Checkout',
    requiresData: ['cartId', 'userId', 'promoCode'],
    dependsOnNames: [],
  };
  const scens = makeScens([consumer]);
  const r = markUnsatisfiedDataDependencies(scens);
  expect('unsatisfiedCases=1', r.unsatisfiedCases, 1);
  expect('unsatisfiedKeys=3', r.unsatisfiedKeys, 3);
  expect('3 warnings', consumer.dataWarnings.length, 3);
}

console.log('');
if (failures > 0) {
  console.log(`FAILED — ${failures} assertion(s)`);
  process.exit(1);
} else {
  console.log('OK — all assertions passed');
}
