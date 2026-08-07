'use strict';
/*
 * STEP 6 — RTM single source of truth. Requirement coverage is DERIVED from live test
 * case refs, NEVER resurrected from the stored RequirementClause.coverageDisposition
 * column. The stored column is authoritative ONLY for the two explicit human
 * dispositions (manually_excluded / not_automatable). One function —
 * clauseCoverageDisposition — is the single authority, and both the RTM (buildRTM) and
 * the auditor evidence bundle (summarizeRequirements) route through it, so a stale
 * stored 'covered' can never surface as a false 'covered'.
 *
 * Pure fixtures, generic.
 */
// evidenceBundle transitively requires the vault (resolveAiCredentials), which refuses
// to load without a master key. This is a pure unit guard — supply a dummy key for the
// guard process only so we can exercise the REAL summarizeRequirements surface.
process.env.VAULT_MASTER_KEY = process.env.VAULT_MASTER_KEY || 'guard-only-dummy-master-key-0123456789';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const oracle = require(path.join(ROOT, 'server', 'services', 'requirementOracle'));
const evidence = require(path.join(ROOT, 'server', 'services', 'evidenceBundle'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

const D = oracle.clauseCoverageDisposition;

console.log('— clauseCoverageDisposition: coverage is DERIVED, stored column never resurrects covered —');
ok('live ref → covered (regardless of stored)', D({ coverageDisposition: 'uncovered' }, true) === 'covered');
ok('STALE stored "covered" but NO live ref → uncovered (the bug)', D({ coverageDisposition: 'covered' }, false) === 'uncovered', D({ coverageDisposition: 'covered' }, false));
ok('manually_excluded honoured when not covered', D({ coverageDisposition: 'manually_excluded' }, false) === 'manually_excluded');
ok('not_automatable honoured when not covered', D({ coverageDisposition: 'not_automatable' }, false) === 'not_automatable');
ok('derived covered BEATS a stored human exclusion (it really is covered now)', D({ coverageDisposition: 'manually_excluded' }, true) === 'covered');
ok('non-testable clause → not_testable (never inflates uncovered)', D({ sourceType: 'NON_TESTABLE', coverageDisposition: 'covered' }, false) === 'not_testable');
ok('testable:false → not_testable even if a ref exists', D({ testable: false }, true) === 'not_testable');
ok('default (uncovered stored, no ref) → uncovered', D({ coverageDisposition: 'uncovered' }, false) === 'uncovered');

console.log('\n— buildRTM routes through the single authority —');
{
  const requirements = [
    { id: 'REQ-A', behaviourText: 'login works', coverageDisposition: 'covered' }, // STALE stored covered
    { id: 'REQ-B', behaviourText: 'logout works', coverageDisposition: 'uncovered' },
    { id: 'REQ-C', behaviourText: 'excluded', coverageDisposition: 'manually_excluded' },
  ];
  const casesWithRefs = [{ caseId: 'tc1', requirementRefs: ['REQ-B'] }]; // only B is really covered
  const { matrix, uncovered, findings } = oracle.buildRTM(requirements, casesWithRefs);
  const byId = Object.fromEntries(matrix.map((m) => [m.id, m.disposition]));
  ok('REQ-A stale-covered but unreferenced → uncovered', byId['REQ-A'] === 'uncovered', byId['REQ-A']);
  ok('REQ-B referenced by a live case → covered', byId['REQ-B'] === 'covered', byId['REQ-B']);
  ok('REQ-C human-excluded, unreferenced → manually_excluded', byId['REQ-C'] === 'manually_excluded', byId['REQ-C']);
  ok('REQ-A appears in uncovered + emits a requirement_uncovered finding', uncovered.includes('REQ-A') && findings.some((f) => f.kind === 'requirement_uncovered' && /REQ-A/.test(f.summary)));
  ok('REQ-C (excluded) is NOT an uncovered finding', !uncovered.includes('REQ-C'));
}

console.log('\n— evidence-bundle RTM export uses the SAME authority (no stale covered leak) —');
{
  const requirements = [
    { id: 'REQ-A', sourceType: 'BRD', behaviourText: 'x', coverageDisposition: 'covered' }, // stale
    { id: 'REQ-B', sourceType: 'BRD', behaviourText: 'y', coverageDisposition: 'uncovered' },
  ];
  const coveredIds = new Set(['REQ-B']); // only B covered in this run
  const rows = evidence.summarizeRequirements(requirements, coveredIds);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.coverageDisposition]));
  ok('REQ-A stale stored "covered" but not covered this run → uncovered (no leak)', byId['REQ-A'] === 'uncovered', byId['REQ-A']);
  ok('REQ-B covered in run → covered', byId['REQ-B'] === 'covered', byId['REQ-B']);
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — requirement coverage has a single authority: derived from live case refs, stored column honoured only for explicit human dispositions, and both the RTM and the evidence bundle route through it (stale stored "covered" can never surface).');
