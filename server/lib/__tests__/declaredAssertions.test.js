'use strict';

/**
 * Phase H M3 — declared-assertion helper smoke.
 *
 * Run with: node server/lib/__tests__/declaredAssertions.test.js
 */

const {
  normalizeForCase,
  validateRecord,
  newAssertionId,
  VALID_TYPES,
} = require('../declaredAssertions');

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

console.log('newAssertionId');
const id = newAssertionId();
expectTrue('starts with ASN-', /^ASN-[0-9a-f]{8}$/.test(id));
expectTrue('unique within 1000 generations', new Set(Array.from({length: 1000}, () => newAssertionId())).size === 1000);

console.log('validateRecord');
expect('TEXT ok',
  validateRecord({ type: 'TEXT', payload: { expectedText: 'Welcome' } }).ok,
  true);
expect('URL ok',
  validateRecord({ type: 'URL', payload: { expectedUrlPattern: '/dashboard' } }).ok,
  true);
expect('FORBIDDEN_TEXT ok',
  validateRecord({ type: 'FORBIDDEN_TEXT', payload: { unexpectedText: 'undefined' } }).ok,
  true);
expect('DOWNLOAD with minSize ok',
  validateRecord({ type: 'DOWNLOAD', payload: { minSize: 1000 } }).ok,
  true);
expect('unknown type rejected',
  validateRecord({ type: 'SCREENSHOT', payload: {} }).ok,
  false);
expect('missing payload rejected',
  validateRecord({ type: 'TEXT' }).ok,
  false);
expect('TEXT without expectedText rejected',
  validateRecord({ type: 'TEXT', payload: {} }).ok,
  false);
expect('not an object rejected',
  validateRecord('hello').ok,
  false);
expect('null rejected',
  validateRecord(null).ok,
  false);

console.log('normalizeForCase — automation case happy path');
const happy = normalizeForCase(
  [{ type: 'TEXT', payload: { expectedText: 'Welcome back' }, targetUrl: '/dashboard' }],
  { automatability: 'automatable', caseName: 'login happy' }
);
expect('one record returned', happy.normalized.length, 1);
expect('id stamped', /^ASN-[0-9a-f]{8}$/.test(happy.normalized[0].id), true);
expect('type preserved', happy.normalized[0].type, 'TEXT');
expect('payload preserved', happy.normalized[0].payload.expectedText, 'Welcome back');
expect('targetUrl preserved', happy.normalized[0].targetUrl, '/dashboard');
expect('checkAt defaults to end', happy.normalized[0].checkAt, 'end');
expect('parseFailed absent', happy.normalized[0].parseFailed, undefined);
expect('no issues', happy.issues.length, 0);

console.log('normalizeForCase — automation case with empty array → parseFailed placeholder');
const empty = normalizeForCase([], { automatability: 'automatable', caseName: 'malformed' });
expect('one placeholder record', empty.normalized.length, 1);
expect('placeholder marked parseFailed', empty.normalized[0].parseFailed, true);
expect('parseIssue is no_assertions_declared', empty.normalized[0].parseIssue, 'no_assertions_declared');
expectTrue('issues logged', empty.issues.length > 0);

console.log('normalizeForCase — automation case with undefined array → parseFailed placeholder');
const und = normalizeForCase(undefined, { automatability: 'automatable', caseName: 'missing field' });
expect('one placeholder record', und.normalized.length, 1);
expect('placeholder marked parseFailed', und.normalized[0].parseFailed, true);

console.log('normalizeForCase — manual case with empty array is fine');
const manualEmpty = normalizeForCase([], { automatability: 'manual', caseName: 'manual review' });
expect('zero records', manualEmpty.normalized.length, 0);
expect('no issues', manualEmpty.issues.length, 0);

console.log('normalizeForCase — manual case with assertions also fine');
const manualWith = normalizeForCase(
  [{ type: 'TEXT', payload: { expectedText: 'review needed' } }],
  { automatability: 'manual', caseName: 'manual with notes' }
);
expect('one record', manualWith.normalized.length, 1);
expect('id stamped', /^ASN-[0-9a-f]{8}$/.test(manualWith.normalized[0].id), true);

console.log('normalizeForCase — mixed valid+invalid preserves both with parseFailed flag on bad ones');
const mixed = normalizeForCase(
  [
    { type: 'TEXT', payload: { expectedText: 'good' } },
    { type: 'INVENTED_TYPE', payload: {} },
    { type: 'URL', payload: { expectedUrlPattern: '/x' } },
  ],
  { automatability: 'automatable', caseName: 'mixed' }
);
expect('three records', mixed.normalized.length, 3);
expect('first is valid', mixed.normalized[0].parseFailed, undefined);
expect('second is parseFailed', mixed.normalized[1].parseFailed, true);
expect('third is valid', mixed.normalized[2].parseFailed, undefined);
expectTrue('issues logged for invalid', mixed.issues.length === 1);

console.log('normalizeForCase — all-parseFailed automation case logs an issue (not silent pass)');
const allBad = normalizeForCase(
  [{ type: 'WRONG' }, { type: 'ALSO_WRONG' }],
  { automatability: 'automatable', caseName: 'all bad' }
);
expect('two records', allBad.normalized.length, 2);
expectTrue('all parseFailed', allBad.normalized.every((n) => n.parseFailed));
expectTrue('a summary issue is logged', allBad.issues.some((i) => i.includes('ALL parseFailed')));

console.log('normalizeForCase — Architect-supplied id is kept (idempotent re-normalize)');
const customId = 'ASN-deadbeef';
const withId = normalizeForCase(
  [{ id: customId, type: 'TEXT', payload: { expectedText: 'x' } }],
  { automatability: 'automatable', caseName: 'with id' }
);
expect('id preserved when format matches', withId.normalized[0].id, customId);

console.log('VALID_TYPES contains expected entries');
['TEXT', 'URL', 'ROLE', 'DOWNLOAD', 'FORBIDDEN_TEXT', 'FORBIDDEN_ROLE', 'EVALUATE', 'PAGE'].forEach((t) => {
  expectTrue(`VALID_TYPES has ${t}`, VALID_TYPES.has(t));
});

console.log('');
if (failures > 0) {
  console.log(`FAILED — ${failures} assertion(s)`);
  process.exit(1);
} else {
  console.log('OK — all assertions passed');
}
