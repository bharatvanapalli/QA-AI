'use strict';
// Guard for Phase A — preview matrix (pre-RUN projection of row -> intent ->
// requiredEvidence -> delta). Uses the REAL AuthProfiles sheet shape + the same
// resolveCaseRows the live run uses, so this proves the preview can't diverge.
const { buildPreviewMatrix } = require('../server/services/previewMatrix');

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

const testData = {
  sheets: [{
    name: 'AuthProfiles',
    headers: ['authRole', 'username', 'password', 'expectedLandingPage'],
    rows: [
      { authRole: 'admin', username: 'Admin', password: 'admin123', expectedLandingPage: '/web/index.php/dashboard/index' },
      { authRole: 'ess', username: 'ess_user_01', password: 'Admin@123', expectedLandingPage: '/web/index.php/dashboard/index' },
      { authRole: 'admin_logout', username: 'Admin', password: 'admin123', expectedLandingPage: '/web/index.php/auth/login' },
      { authRole: 'ess_logout', username: 'ess_user_01', password: 'Admin@123', expectedLandingPage: '/web/index.php/auth/login' },
    ],
  }],
  mapping: {
    bindings: [{
      sheet: 'AuthProfiles',
      columnToField: { role: 'authRole', username: 'username', password: 'password' },
      expectedColumn: 'expectedLandingPage',
      rowClassColumn: null,
    }],
  },
};

const scenario = { id: 's1', name: 'Login with AuthProfiles', module: 'authentication' };
const cases = [
  // data-bound — fans out across the whole AuthProfiles sheet
  { id: 'c1', title: 'Login matrix', scenarioId: 's1', dataBindingJson: JSON.stringify({ sheet: 'AuthProfiles' }) },
  // NOT data-bound — should still appear, as a single-run case under its scenario
  { id: 'c2', title: 'Page loads', scenarioId: 's1' },
];

console.log('— preview matrix shape + aggregation —');
{
  const m = buildPreviewMatrix({ cases, scenariosById: { s1: scenario }, testData });
  ok('one scenario group', m.scenarios.length === 1, JSON.stringify(m.scenarios.map((s) => s.scenarioName)));
  ok('scenario carries id + name + module', m.scenarios[0].scenarioId === 's1' && m.scenarios[0].scenarioName === 'Login with AuthProfiles' && m.scenarios[0].module === 'authentication', JSON.stringify(m.scenarios[0]));
  ok('two cases under scenario', m.scenarios[0].cases.length === 2, String(m.scenarios[0].cases.length));

  const bound = m.scenarios[0].cases.find((c) => c.caseId === 'c1');
  const single = m.scenarios[0].cases.find((c) => c.caseId === 'c2');
  ok('data-bound case flagged dataBound', bound && bound.dataBound === true, JSON.stringify(bound && { dataBound: bound.dataBound, rowCount: bound.rowCount }));
  ok('data-bound case fans out all 4 rows', bound && bound.rowCount === 4, String(bound && bound.rowCount));
  ok('data-bound case carries sheet name', bound && bound.sheet === 'AuthProfiles', String(bound && bound.sheet));
  ok('non-data-bound case present + dataBound=false', single && single.dataBound === false && single.rowCount === 0, JSON.stringify(single && { dataBound: single.dataBound, rowCount: single.rowCount }));
}

console.log('\n— per-row intent + evidence projection (the point of the preview) —');
{
  const m = buildPreviewMatrix({ cases, scenariosById: { s1: scenario }, testData });
  const rows = m.scenarios[0].cases.find((c) => c.caseId === 'c1').rows;
  ok('every row carries an intentClass', rows.every((r) => typeof r.intentClass === 'string' && r.intentClass), JSON.stringify(rows.map((r) => r.intentClass)));
  ok('every row carries requiredEvidence[]', rows.every((r) => Array.isArray(r.requiredEvidence) && r.requiredEvidence.length > 0), JSON.stringify(rows.map((r) => r.requiredEvidence.length)));
  // sourceColumns must be POPULATED (regression guard — it was dead/empty before
  // the contract started returning it): the expected-landing column drove intent.
  ok('rows carry non-empty sourceColumns (expectedLandingPage)', rows.every((r) => Array.isArray(r.sourceColumns) && r.sourceColumns.includes('expectedLandingPage')), JSON.stringify(rows.map((r) => r.sourceColumns)));
  // dashboard-landing rows = success; login-landing (logout) rows = auth_rejection per the destination-prose/auth-page rule
  const classes = rows.map((r) => r.intentClass);
  ok('mixed intent classes surfaced pre-run (not one frozen oracle)', new Set(classes).size >= 2, JSON.stringify(classes));
  ok('success rows require page_present', rows.filter((r) => r.intentClass === 'success').every((r) => r.requiredEvidence.some((e) => e.kind === 'page_present')), JSON.stringify(classes));
  ok('rejection rows require destination_absent', rows.filter((r) => r.intentClass === 'auth_rejection').every((r) => r.requiredEvidence.some((e) => e.kind === 'destination_absent')), JSON.stringify(classes));
}

console.log('\n— summary tallies —');
{
  const m = buildPreviewMatrix({ cases, scenariosById: { s1: scenario }, testData });
  ok('totalCases = 2', m.summary.totalCases === 2, String(m.summary.totalCases));
  ok('dataBoundCases = 1', m.summary.dataBoundCases === 1, String(m.summary.dataBoundCases));
  ok('totalRows = 4', m.summary.totalRows === 4, String(m.summary.totalRows));
  ok('byIntentClass sums to totalRows', Object.values(m.summary.byIntentClass).reduce((a, b) => a + b, 0) === 4, JSON.stringify(m.summary.byIntentClass));
  ok('deltaCount is a number', typeof m.summary.deltaCount === 'number', String(m.summary.deltaCount));
}

console.log('\n— degenerate inputs never throw —');
{
  ok('empty cases -> empty matrix', buildPreviewMatrix({ cases: [], testData }).scenarios.length === 0);
  ok('null opts -> empty matrix', buildPreviewMatrix().scenarios.length === 0);
  ok('case with no scenario -> Ungrouped group', buildPreviewMatrix({ cases: [{ id: 'x', title: 'orphan' }] }).scenarios[0].scenarioName === 'Ungrouped');
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — preview matrix verified on real AuthProfiles shape');
