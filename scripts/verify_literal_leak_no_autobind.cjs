'use strict';
/*
 * STEP 4 (remainder) — literal-leak must NOT auto-bind. A value that merely appears in
 * an uploaded sheet is not proof a case belongs to that sheet. The old fallback bound
 * such a case to the sheet (bestBindingForLeaks) and ran it as data-driven — which bound
 * page-load / smoke cases to a data matrix by coincidence. Now: with NO storyId /
 * coverageItem / module / explicit / placeholder signal, the case stays UNBOUND
 * (sheet:null, not data-driven) and the leak is surfaced as a needs_review warning only.
 *
 * Pure fixtures, generic.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const TDA = require(path.join(ROOT, 'server', 'services', 'testDataAuthoring'));
const caseCompiler = require(path.join(ROOT, 'server', 'services', 'caseCompiler'));
const OC = require(path.join(ROOT, 'server', 'services', 'oracleContract'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

const sheets = [
  { name: 'Reference_Data', headers: ['storyId', 'companyName', 'taxId'], rows: [
    { storyId: 'US-OHRM-050', companyName: 'Globex Industries', taxId: '99-1234567' },
  ] },
  { name: 'Login_Matrix', headers: ['username', 'password'], rows: [
    { username: 'admin', password: 'secret' },
  ] },
];
const testData = { sheets, mapping: { bindings: [
  { sheet: 'Reference_Data', columnToField: { companyName: 'companyName' } },
  { sheet: 'Login_Matrix', columnToField: { username: 'username', password: 'password' } },
] } };

const mk = (over) => ({ name: 'c', module: 'misc', type: 'functional', requirementRefs: [], declaredAssertions: [], steps: [], ...over });

console.log('— literal-leak ONLY (no storyId/coverageItem/module/placeholder) → unbound + warn —');
{
  // A page-content case that mentions a sheet value as a LITERAL, no {{tokens}}.
  const scn = [{ name: 'S', module: 'misc', cases: [mk({
    name: 'Verify partner directory listing',
    assertions: 'The directory shows Globex Industries in the partner list',
  })] }];
  const stats = TDA.markDataAwareCases(scn, testData, {});
  const b = scn[0].cases[0].dataBinding;
  ok('NOT auto-bound to the sheet the literal came from (sheet stays null)', b && b.sheet === null, JSON.stringify(b && { sheet: b.sheet, mk: b.matchKind }));
  ok('matchKind = needs_review (surfaced, not silently bound)', b && b.matchKind === 'needs_review' && b.needsReview === true);
  ok('carries the data_literal_without_binding warning', b && (b.findings || []).some((f) => f.code === 'data_literal_without_binding' && f.severity === 'warning'), JSON.stringify(b && b.findings));
  ok('counted as incomplete, NOT assigned', stats.incomplete >= 1, JSON.stringify(stats));
}

console.log('\n— a literal-leak-only case is NOT data-driven downstream —');
{
  const scn = [{ name: 'S', module: 'misc', cases: [mk({ name: 'Verify partner directory listing', assertions: 'shows Globex Industries' })] }];
  TDA.markDataAwareCases(scn, testData, {});
  const c = scn[0].cases[0];
  const oc = OC.buildOracleContract({ name: c.name, automatability: 'automatable', declaredAssertions: c.declaredAssertions, dataBinding: c.dataBinding, assertions: c.assertions });
  ok('Oracle Contract treats it as STATIC (sheet null → not data-driven)', oc.verdict.mode === 'static' && oc.rowEvidence === null, oc.verdict.mode);
  // CaseCompiler: a sheet:null binding must NOT be a hard data_binding_incomplete blocker.
  const v = caseCompiler.compileCase({ name: c.name, steps: [], assertions: c.assertions, declaredAssertions: [{ type: 'TEXT', criticality: 'must', payload: { expectedText: 'Globex Industries' } }], dataBinding: c.dataBinding, automatability: 'automatable' });
  ok('CaseCompiler does NOT hard-block it on data_binding_incomplete', !v.blockers.some((x) => x.code === 'data_binding_incomplete'), JSON.stringify(v.blockers.map((x) => x.code)));
}

console.log('\n— a clean page-load case (no literal, no placeholder) stays fully UNBOUND —');
{
  const scn = [{ name: 'S', module: 'misc', cases: [mk({ name: 'Open the homepage', assertions: 'header is visible' })] }];
  TDA.markDataAwareCases(scn, testData, {});
  const b = scn[0].cases[0].dataBinding;
  ok('no dataBinding object created at all', b === undefined || b === null, JSON.stringify(b));
}

console.log('\n— REGRESSION: a real placeholder/keyword match STILL binds (token proof) —');
{
  const scn = [{ name: 'S', module: 'login', cases: [mk({
    name: 'Login with credentials', module: 'login',
    steps: [{ action: 'Fill', element: 'Username', value: '{{username}}' }, { action: 'Fill', element: 'Password', value: '{{password}}' }],
  })] }];
  const stats = TDA.markDataAwareCases(scn, testData, {});
  const b = scn[0].cases[0].dataBinding;
  ok('placeholder-bearing case is bound to its sheet', b && b.sheet === 'Login_Matrix', JSON.stringify(b && { sheet: b.sheet, mk: b.matchKind }));
  ok('counted as assigned', stats.assigned >= 1, JSON.stringify(stats));
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — literal-leak no longer auto-binds: a case with no real binding signal stays unbound (warned, needs_review), a clean page-load case stays fully unbound, and a placeholder-bearing case still binds.');
