'use strict';
/*
 * STEP 3C/3B PERSISTENCE-PATH GUARD — proves the STRONG-bind metadata survives the
 * REAL generation sequence, not just the direct binder.
 *
 * The bug this locks down: markDataAwareCases stamps a strong binding
 * (matchKind/coverageItemId/storyId/storyColumn) onto the RAW parsed case, then
 * architect.normaliseCase (run a few lines later, via normaliseScenario's
 * `cases.map(normaliseCase)`) rebuilt dataBinding field-by-field and SILENTLY DROPPED
 * those fields — downgrading a resolver/coverageItem bind to a bare { sheet } at
 * persist time. coveragePlanner.__strongBind reads dataBinding.matchKind, and
 * testDataMatrix.filterRowsBySelector reads dataBinding.storyColumn, so the loss made
 * the bind both override-able by repair AND un-filterable at run time.
 *
 * Real sequence exercised here (no mocks of the units under test):
 *   raw Architect case (top-level coverageItemId)
 *     -> testDataAuthoring.markDataAwareCases   (resolver stamps the strong bind)
 *     -> architect.normaliseCase                (the normaliser that used to strip it)
 *     -> coveragePlanner.repairCoveragePlanScenarios  (must NOT clobber a strong bind)
 *   then assert matchKind / storyColumn / storyId / coverageItemId all survive,
 *   and the post-normalise rowSelector story:<id> still filters to that story's rows.
 *
 * Pure fixtures, generic (no site/sheet string drives behaviour).
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const TDA = require(path.join(ROOT, 'server', 'services', 'testDataAuthoring'));
const architect = require(path.join(ROOT, 'server', 'services', 'agents', 'architect'));
const coveragePlanner = require(path.join(ROOT, 'server', 'services', 'coveragePlanner'));
const matrix = require(path.join(ROOT, 'server', 'services', 'testDataMatrix'));
const { buildWorkbookContract, buildCoverageItems } = require(path.join(ROOT, 'server', 'services', 'workbookContract'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

if (typeof architect.normaliseCase !== 'function') {
  console.log('  FAIL  architect.normaliseCase must be exported for this guard  <<< not exported');
  process.exit(1);
}

// Two sheets, identical credential columns (keyword/column overlap CANNOT disambiguate),
// different story ids — only the storyId/coverageItem signal can pick the right one.
const sheets = [
  { name: 'PIM_EmployeeLifecycle', headers: ['storyId', 'username', 'password', 'expectedVisibleSignal'], rows: [
    { storyId: 'US-OHRM-004', username: 'admin', password: 'p', expectedVisibleSignal: 'Saved' },
    { storyId: 'US-OHRM-004', username: 'hr', password: 'p', expectedVisibleSignal: 'Saved' },
    { storyId: 'US-OHRM-007', username: 'x', password: 'p', expectedVisibleSignal: 'Other' },
  ] },
  { name: 'Admin_UserSearch', headers: ['storyId', 'username', 'password', 'expectedVisibleSignal'], rows: [
    { storyId: 'US-OHRM-009', username: 'admin', password: 'p', expectedVisibleSignal: 'Found' },
  ] },
];
const testData = { sheets, mapping: { bindings: [
  { sheet: 'PIM_EmployeeLifecycle', columnToField: { username: 'username', password: 'password' }, expectedColumn: 'expectedVisibleSignal' },
  { sheet: 'Admin_UserSearch', columnToField: { username: 'username', password: 'password' }, expectedColumn: 'expectedVisibleSignal' },
] } };

const contract = buildWorkbookContract({ sheets });
const ci = buildCoverageItems(contract).find((i) => i.sheet === 'PIM_EmployeeLifecycle' && i.storyId === 'US-OHRM-004');

// A raw Architect-shaped case: cites the CoverageItem at the TOP LEVEL, NAME/MODULE
// scream "Admin" so any keyword fallback would mis-bind — only the cited CI is right.
const rawCase = {
  name: 'Admin user search filter',
  module: 'admin',
  type: 'functional',
  requirementRefs: [],
  declaredAssertions: [],
  coverageItemId: ci.id,
  steps: [
    { action: 'Fill', element: 'Username', value: '{{username}}' },
    { action: 'Fill', element: 'Password', value: '{{password}}' },
  ],
};

console.log('— real sequence: markDataAwareCases -> normaliseCase -> coveragePlanner repair —');

// 1) RESOLVER (on the raw parsed scenario, exactly as architect.run does)
const parsed = [{ name: 'S', module: 'admin', cases: [rawCase] }];
TDA.markDataAwareCases(parsed, testData, {});
const afterResolve = parsed[0].cases[0].dataBinding;
ok('resolver stamped a coverageItem strong bind', afterResolve && afterResolve.matchKind === 'coverageItem' && afterResolve.sheet === 'PIM_EmployeeLifecycle', JSON.stringify(afterResolve && { mk: afterResolve.matchKind, s: afterResolve.sheet }));

// 2) NORMALISE (the step that used to strip the strong-bind metadata)
const normalised = parsed[0].cases.map(architect.normaliseCase).filter(Boolean);
const nb = normalised[0] && normalised[0].dataBinding;
ok('normaliseCase preserves dataBinding.matchKind', nb && nb.matchKind === 'coverageItem', JSON.stringify(nb && { mk: nb.matchKind }));
ok('normaliseCase preserves dataBinding.coverageItemId', nb && nb.coverageItemId === ci.id, JSON.stringify(nb && { ci: nb.coverageItemId }));
ok('normaliseCase preserves dataBinding.storyId', nb && nb.storyId === 'US-OHRM-004', JSON.stringify(nb && { sid: nb.storyId }));
ok('normaliseCase preserves dataBinding.storyColumn', nb && nb.storyColumn === 'storyId', JSON.stringify(nb && { sc: nb.storyColumn }));
ok('normaliseCase preserves dataBinding.rowSelector (story:<id>)', nb && /^story:us-ohrm-004$/i.test(String(nb.rowSelector)), JSON.stringify(nb && { rs: nb.rowSelector }));
ok('normaliseCase preserves the TOP-LEVEL coverageItemId', normalised[0] && normalised[0].coverageItemId === ci.id, JSON.stringify(normalised[0] && { ci: normalised[0].coverageItemId }));

// 3) COVERAGE-PLANNER REPAIR — must NOT pollute the strong bind. Build a real manifest
//    so the DATA_BOUND / sheet-match / sheet-exists repair paths are all reachable, then
//    prove __strongBind keeps them off this bind.
const reqClauses = [{ id: 'REQ-A', storyId: 'US-OHRM-009', title: 'admin user search', behaviourText: 'search users by name', requirementRefs: [] }];
const manifest = coveragePlanner.buildCoveragePlanManifest({ requirementClauses: reqClauses, testData });
const repairScn = [{ name: 'S', module: 'admin', cases: [JSON.parse(JSON.stringify(normalised[0]))] }];
const repairOut = coveragePlanner.repairCoveragePlanScenarios({ manifest, scenarios: repairScn, testData });
const repaired = Array.isArray(repairOut) ? repairOut : (repairOut && repairOut.scenarios) || [];
const rb = repaired[0] && repaired[0].cases[0] && repaired[0].cases[0].dataBinding;
ok('repair leaves the strong bind on its home sheet (no clobber to Admin)', rb && rb.sheet === 'PIM_EmployeeLifecycle', JSON.stringify(rb && { s: rb.sheet, by: rb.repairedBy }));
ok('repair preserves matchKind=coverageItem (did not downgrade)', rb && rb.matchKind === 'coverageItem', JSON.stringify(rb && { mk: rb.matchKind }));
ok('repair preserves storyColumn through the clone', rb && rb.storyColumn === 'storyId', JSON.stringify(rb && { sc: rb.storyColumn }));

// 4) RUNTIME row filter still honours the POST-NORMALISE binding (story:<id> + storyColumn).
if (typeof matrix.filterRowsBySelector === 'function') {
  console.log('\n— runtime: the persisted binding still filters to the story rows —');
  const filtered = matrix.filterRowsBySelector(sheets[0].rows, { rowSelector: rb.rowSelector, storyColumn: rb.storyColumn }, sheets[0], { name: 'c' });
  ok('post-normalise story:<id> selector returns ONLY that story\'s rows', filtered.length === 2 && filtered.every((r) => r.storyId === 'US-OHRM-004'), `got ${filtered.length}`);
}

// 5) Sheetless needs_review binding survives normalisation (cited storyId no sheet carries).
//    The OLD normaliser required a string sheet, so it dropped this binding entirely and the
//    case looked "unbound" instead of needs_review. The signal here is matchKind:'needs_review'
//    + status:'incomplete' + the story_id_no_data finding (NOT a needsReview flag — that flag is
//    the separate weak-semantic path, checked directly below).
console.log('\n— sheetless needs_review bind is not lost by the normaliser —');
{
  const orphan = [{ name: 'S', module: 'x', cases: [{ name: 'orphan', type: 'functional', requirementRefs: ['REQ-Z'], declaredAssertions: [], steps: [{ action: 'Fill', element: 'Username', value: '{{username}}' }] }] }];
  TDA.markDataAwareCases(orphan, testData, { clauseStoryIndex: { 'REQ-Z': 'US-OHRM-999' } });
  const norm = orphan[0].cases.map(architect.normaliseCase).filter(Boolean);
  const ob = norm[0] && norm[0].dataBinding;
  ok('sheetless needs_review bind survives (matchKind + status + finding)', ob && ob.matchKind === 'needs_review' && ob.status === 'incomplete' && (ob.findings || []).some((f) => f.code === 'story_id_no_data'), JSON.stringify(ob));
}

// 5b) Direct unit check that normaliseCase preserves a needsReview:true flag (weak-semantic path).
{
  const out = architect.normaliseCase({ name: 'weak', type: 'functional', dataBinding: { sheet: 'PIM_EmployeeLifecycle', matchKind: 'semantic', needsReview: true, findings: [{ code: 'weak_semantic_binding', severity: 'warning' }] } });
  ok('normaliseCase preserves dataBinding.needsReview === true', out && out.dataBinding && out.dataBinding.needsReview === true && out.dataBinding.matchKind === 'semantic', JSON.stringify(out && out.dataBinding));
}

// 5c) normaliseCase must preserve dataBinding.companions (multi-source credential sources).
//     Without this the GenerationCompiler saw the multi_source finding but no companions,
//     and could not clear it → a false needs_review on the login case.
{
  const out = architect.normaliseCase({ name: 'login', type: 'functional', dataBinding: { sheet: 'Dashboard_QuickLaunch', matchKind: 'storyId', companions: [{ sheet: 'ExecutionProfiles', columnToField: { username: 'username', loginpassword: 'loginpassword' }, source: 'credential_companion' }], findings: [{ code: 'multi_source_credential_binding', severity: 'warning' }] } });
  const comp = out && out.dataBinding && out.dataBinding.companions;
  ok('normaliseCase preserves dataBinding.companions[]', Array.isArray(comp) && comp.length === 1 && comp[0].sheet === 'ExecutionProfiles' && comp[0].columnToField && comp[0].columnToField.username === 'username', JSON.stringify(comp));
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — strong-bind metadata (matchKind/coverageItemId/storyId/storyColumn) and the top-level coverageItemId survive the full markDataAwareCases -> normaliseCase -> coveragePlanner repair path, and the persisted story:<id> selector still filters at run time.');
