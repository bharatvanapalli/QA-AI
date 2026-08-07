'use strict';

/**
 * Phase H M5 — aggregateVerdictDisagreement smoke.
 *
 * Run with: node server/services/__tests__/verdictDashboard.test.js
 */

const { aggregateVerdictDisagreement } = require('../verdictDashboard');

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
function expectTrue(label, actual) {
  if (actual) console.log(`  PASS  ${label}`);
  else { console.log(`  FAIL  ${label}  (got ${JSON.stringify(actual)})`); failures += 1; }
}

// ── shorthand ──────────────────────────────────────────────────────────
const ROW = (verdictVersion, flipDirection, status = 'pass') => ({ verdictVersion, flipDirection, status });

// ─────────────────────────────────────────────────────────────────────────
console.log('Empty input → empty buckets, empty headline');
{
  const out = aggregateVerdictDisagreement([]);
  expect('zero buckets', out.verdictVersions.length, 0);
  expect('empty headline', out.headline, '');
}

// ─────────────────────────────────────────────────────────────────────────
console.log('Only legacy rows → no headline (card hides)');
{
  const rows = [
    ROW('legacy', null),
    ROW('legacy', null),
    ROW('legacy', 'FAIL_TO_PASS'),
  ];
  const out = aggregateVerdictDisagreement(rows);
  expect('one bucket', out.verdictVersions.length, 1);
  expect('legacy total',     out.verdictVersions[0].totalRuns, 3);
  expect('legacy agreed',    out.verdictVersions[0].agreedCount, 2);
  expect('legacy disagreed', out.verdictVersions[0].disagreedCount, 1);
  expect('headline stays empty without mechanical_v1 rows', out.headline, '');
}

// ─────────────────────────────────────────────────────────────────────────
console.log('Mechanical rows with mixed flips — needs_human flips fold into otherFlips');
{
  // FAIL_TO_NEEDS_HUMAN / PASS_TO_NEEDS_HUMAN / NEEDS_HUMAN_TO_FAIL / NEEDS_HUMAN_TO_PASS
  // all land in otherFlips since needs_human is no longer a distinct verdict.
  const rows = [
    ROW('mechanical_v1', 'FAIL_TO_PASS'),
    ROW('mechanical_v1', 'FAIL_TO_PASS'),
    ROW('mechanical_v1', 'FAIL_TO_NEEDS_HUMAN'),   // → otherFlips
    ROW('mechanical_v1', 'PASS_TO_FAIL'),
    ROW('mechanical_v1', 'PASS_TO_NEEDS_HUMAN'),   // → otherFlips
    ROW('mechanical_v1', 'NEEDS_HUMAN_TO_FAIL'),   // → otherFlips
    ROW('mechanical_v1', 'NEEDS_HUMAN_TO_PASS'),   // → otherFlips
    ROW('mechanical_v1', 'OTHER'),                 // → otherFlips
    ROW('mechanical_v1', null),  // agreement
    ROW('mechanical_v1', null),
  ];
  const out = aggregateVerdictDisagreement(rows, { windowDays: 7 });
  const mech = out.verdictVersions.find((v) => v.verdictVersion === 'mechanical_v1');
  expect('total runs',                 mech.totalRuns, 10);
  expect('disagreed count',            mech.disagreedCount, 8);
  expect('agreed count',               mech.agreedCount, 2);
  expect('rescued false-fails',        mech.rescuedFalseFails, 2);
  expect('caught over-claimed passes', mech.caughtOverclaimedPasses, 1);
  expect('other flips',                mech.otherFlips, 5);
  expect('disagreement rate',          mech.disagreementRate, 80);
  expectTrue('headline mentions rescued false-fails', out.headline.includes('false-fail'));
  expectTrue('headline mentions over-claimed passes', out.headline.includes('over-claimed pass'));
  expectTrue('headline mentions windowDays',          out.headline.includes('7 day'));
}

// ─────────────────────────────────────────────────────────────────────────
console.log('Mechanical rows with NO disagreements → emits zero-disagreement headline');
{
  const rows = [
    ROW('mechanical_v1', null),
    ROW('mechanical_v1', null),
    ROW('mechanical_v1', null),
  ];
  const out = aggregateVerdictDisagreement(rows, { windowDays: 7 });
  expectTrue('zero-disagreement headline rendered', out.headline.includes('0 disagreements'));
  expectTrue('headline includes count',             out.headline.includes('3 runs'));
}

// ─────────────────────────────────────────────────────────────────────────
console.log('Legacy needs_human flip directions still land in otherFlips (backward compat)');
{
  const rows = [
    ROW('mechanical_v1', 'FAIL_TO_NEEDS_HUMAN', 'fail'),
    ROW('mechanical_v1', null,                  'fail'),
    ROW('mechanical_v1', null,                  'pass'),
  ];
  const out = aggregateVerdictDisagreement(rows);
  const mech = out.verdictVersions[0];
  expect('legacy FAIL_TO_NEEDS_HUMAN goes to otherFlips', mech.otherFlips, 1);
  expect('total', mech.totalRuns, 3);
}

// ─────────────────────────────────────────────────────────────────────────
console.log('Stable ordering — legacy first, mechanical_v1 second, unknown after');
{
  const rows = [
    ROW('mechanical_v1', null),
    ROW('experimental_v2', null),
    ROW('legacy', null),
  ];
  const out = aggregateVerdictDisagreement(rows);
  expect('order[0]', out.verdictVersions[0].verdictVersion, 'legacy');
  expect('order[1]', out.verdictVersions[1].verdictVersion, 'mechanical_v1');
  expect('order[2]', out.verdictVersions[2].verdictVersion, 'experimental_v2');
}

// ─────────────────────────────────────────────────────────────────────────
console.log('Rate rounding — 1 disagreement in 3 = 33.3%');
{
  const rows = [
    ROW('mechanical_v1', 'FAIL_TO_PASS'),
    ROW('mechanical_v1', null),
    ROW('mechanical_v1', null),
  ];
  const out = aggregateVerdictDisagreement(rows);
  expect('rate rounds to 33.3', out.verdictVersions[0].disagreementRate, 33.3);
}

// ─────────────────────────────────────────────────────────────────────────
console.log('Null verdictVersion bucketed as legacy (defensive)');
{
  const rows = [
    { verdictVersion: null, flipDirection: null, status: 'pass' },
    { verdictVersion: undefined, flipDirection: null, status: 'pass' },
  ];
  const out = aggregateVerdictDisagreement(rows);
  expect('one bucket', out.verdictVersions.length, 1);
  expect('bucketed as legacy', out.verdictVersions[0].verdictVersion, 'legacy');
  expect('total counted',      out.verdictVersions[0].totalRuns, 2);
}

// ─────────────────────────────────────────────────────────────────────────
console.log('Windows beyond 1 day get plural day, 1 day stays singular');
{
  const rows = [ROW('mechanical_v1', 'FAIL_TO_PASS')];
  expectTrue('windowDays=1 singular',
    aggregateVerdictDisagreement(rows, { windowDays: 1 }).headline.includes('1 day.'));
  expectTrue('windowDays=14 plural',
    aggregateVerdictDisagreement(rows, { windowDays: 14 }).headline.includes('14 days.'));
}

// ─────────────────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.log(`FAILED — ${failures} assertion(s)`);
  process.exit(1);
} else {
  console.log('OK — all assertions passed');
}
