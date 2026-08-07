'use strict';
// Guard for Phase A — column-role detection, proven on the REAL sheet headers
// (AuthProfiles, FilterData) + the absence/presence emission into the contract.
const { detectColumnRoles, buildRowEvidenceContract } = require('../server/services/testDataMatrix');

let fail = 0;
const eq = (label, got, want) => { const p = got === want; if (!p) fail++; console.log(`  ${p ? 'PASS' : 'FAIL'}  ${label}: ${got}${p ? '' : ` (want ${want})`}`); };

console.log('— Real AuthProfiles headers —');
{
  const r = detectColumnRoles(['testCaseID', 'authRole', 'username', 'password', 'sensitivityLevel', 'expectedLandingPage', 'expectedVisibleMenuItems', 'expectedHiddenMenuItems', 'notes']);
  eq('testCaseID', r.testCaseID, 'metadata');
  eq('username', r.username, 'input');
  eq('password', r.password, 'input');
  eq('sensitivityLevel', r.sensitivityLevel, 'metadata');
  eq('expectedLandingPage', r.expectedLandingPage, 'destination');
  eq('expectedVisibleMenuItems', r.expectedVisibleMenuItems, 'presence');
  eq('expectedHiddenMenuItems', r.expectedHiddenMenuItems, 'absence');
}

console.log('\n— Real FilterData headers —');
{
  const r = detectColumnRoles(['testCaseID', 'scenarioName', 'filterType', 'searchName', 'category', 'priceMin', 'expectedResultCount', 'expectedContainsProductName', 'expectedDoesNotContainProduct', 'expectedEmptyState']);
  eq('scenarioName', r.scenarioName, 'class_label');
  eq('filterType', r.filterType, 'input');
  eq('searchName', r.searchName, 'input');
  eq('category (NOT class_label - it is a filter input here)', r.category, 'input');
  eq('expectedResultCount', r.expectedResultCount, 'expected_count');
  eq('expectedContainsProductName', r.expectedContainsProductName, 'presence');
  eq('expectedDoesNotContainProduct', r.expectedDoesNotContainProduct, 'absence');
  eq('expectedEmptyState', r.expectedEmptyState, 'empty_state');
}

console.log('\n— Login error/validation columns —');
{
  const r = detectColumnRoles(['username', 'password', 'expectedValidationError']);
  eq('expectedValidationError', r.expectedValidationError, 'error');
}

console.log('\n— absence/presence columns flow into a SUCCESS row contract —');
{
  const c = buildRowEvidenceContract({
    index: 0, setName: 'S', sheet: 'S',
    inputs: { username: 'Admin', password: 'admin123' },
    raw: { username: 'Admin', password: 'admin123', expectedLandingPage: '/web/index.php/dashboard/index', expectedVisibleMenuItems: 'Dashboard, Leave', expectedHiddenMenuItems: 'Admin' },
    expected: '/web/index.php/dashboard/index', expectedColumn: 'expectedLandingPage', rowClass: null, rowClassColumn: null, label: 'Row 1',
  });
  const kinds = c.requiredEvidence.map((e) => e.kind);
  const present = c.requiredEvidence.filter((e) => e.kind === 'element_present').map((e) => e.label);
  const absent = c.requiredEvidence.filter((e) => e.kind === 'element_absent').map((e) => e.label);
  const ok = (l, cond) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${l}`); };
  ok('intentClass success', c.intentClass === 'success');
  ok('requires dashboard destination present', kinds.includes('page_present'));
  ok('element_present for Dashboard + Leave', present.includes('Dashboard') && present.includes('Leave'));
  ok('element_absent for Admin (hidden menu)', absent.includes('Admin'));
}

console.log('\n— NEGATIVE row does NOT get menu presence/absence evidence (no auth) —');
{
  const c = buildRowEvidenceContract({
    index: 0, setName: 'S', sheet: 'S',
    inputs: { username: '', password: 'x' },
    raw: { username: '', password: 'x', expectedVisibleMenuItems: 'Dashboard' },
    expected: 'Required', expectedColumn: 'expectedValidationError', rowClass: null, rowClassColumn: null, label: 'Row 1 · emptyUsername',
  });
  const hasMenuEvidence = c.requiredEvidence.some((e) => e.kind === 'element_present' || e.kind === 'element_absent');
  const ok = (l, cond) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${l}`); };
  ok('intentClass required_validation', c.intentClass === 'required_validation');
  ok('no menu presence/absence evidence on a negative (unauthenticated) row', !hasMenuEvidence);
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — column-role detection verified');
