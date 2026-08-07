'use strict';
/*
 * STEP 3B RESOLVER — storyId-first data binding. Proves the binding ORDER changes
 * real behaviour in testDataAuthoring.markDataAwareCases:
 *   exact case.storyId → workbook row.storyId  >  module/scope  >  semantic(weak).
 * storyId beats keyword overlap; a wrong-story sheet is NOT bound despite matching
 * columns; a storyId no sheet carries → needs_review; a semantic-only bind is
 * flagged weak; and a strong storyId bind is never overridden by repair (it
 * `continue`s before the keyword/repair branches). Pure fixtures, generic.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const TDA = require(path.join(ROOT, 'server', 'services', 'testDataAuthoring'));
const { resolveStoryBinding } = require(path.join(ROOT, 'server', 'lib', 'storyBinding'));
const { buildWorkbookContract, buildCoverageItems } = require(path.join(ROOT, 'server', 'services', 'workbookContract'));
const matrix = require(path.join(ROOT, 'server', 'services', 'testDataMatrix'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

// Two sheets with IDENTICAL credential columns (so keyword/column overlap can't
// disambiguate) but DIFFERENT story ids — only storyId can pick the right one.
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
const contract = buildWorkbookContract({ sheets });
const testData = { sheets, mapping: { bindings: [
  { sheet: 'PIM_EmployeeLifecycle', columnToField: { username: 'username', password: 'password' }, expectedColumn: 'expectedVisibleSignal' },
  { sheet: 'Admin_UserSearch', columnToField: { username: 'username', password: 'password' }, expectedColumn: 'expectedVisibleSignal' },
] } };

console.log('— pure resolver order: storyId > module > (semantic = caller) —');
ok('exact storyId → its home sheet', resolveStoryBinding({ storyId: 'US-OHRM-004' }, contract).sheet === 'PIM_EmployeeLifecycle');
ok('storyId match beats nothing else needed (matchKind=storyId)', resolveStoryBinding({ storyId: 'US-OHRM-009' }, contract).matchKind === 'storyId');
ok('storyId no sheet carries → matchKind none + needsReview', (() => { const r = resolveStoryBinding({ storyId: 'US-OHRM-999' }, contract); return r.matchKind === 'none' && r.needsReview; })());
ok('no storyId → module match picks the sheet by name token', resolveStoryBinding({ storyId: null, module: 'admin' }, contract).matchKind === 'module');
ok('no storyId + unknown module → null (caller falls to semantic)', resolveStoryBinding({ storyId: null, module: 'zzz' }, contract) === null);

console.log('\n— markDataAwareCases: storyId-first CHANGES the bind (behaviour) —');
const mk = (over) => ({ name: 'c', module: 'x', requirementRefs: [], declaredAssertions: [], steps: [{ action: 'Fill', element: 'Username', value: '{{username}}' }, { action: 'Fill', element: 'Password', value: '{{password}}' }], ...over });

{
  // storyId points to PIM, but the NAME/MODULE scream Admin → storyId must win.
  const scn = [{ name: 'S', cases: [mk({ name: 'Admin user search filter', module: 'admin', requirementRefs: ['REQ-2'] })] }];
  TDA.markDataAwareCases(scn, testData, { clauseStoryIndex: { 'REQ-2': 'US-OHRM-004' } });
  const b = scn[0].cases[0].dataBinding;
  ok('storyId BEATS keyword/module: bound to PIM (not Admin) despite "admin user search" name', b && b.sheet === 'PIM_EmployeeLifecycle', JSON.stringify(b && { sheet: b.sheet, mk: b.matchKind }));
  ok('matchKind = storyId', b && b.matchKind === 'storyId');
  ok('row selector restricts to the story rows (story:<id>)', b && /^story:us-ohrm-004$/i.test(String(b.rowSelector)) && b.storyColumn === 'storyId', JSON.stringify(b && { rs: b.rowSelector, sc: b.storyColumn }));
}
{
  // wrong-story keyword: an explicit Admin binding + Admin keywords, storyId → PIM.
  const scn = [{ name: 'S', cases: [mk({ name: 'search users', module: 'admin', requirementRefs: ['REQ-9'], dataBinding: { sheet: 'Admin_UserSearch' } })] }];
  TDA.markDataAwareCases(scn, testData, { clauseStoryIndex: { 'REQ-9': 'US-OHRM-004' } });
  ok('storyId overrides the architect\'s EXPLICIT wrong-story sheet (Admin→PIM)', scn[0].cases[0].dataBinding.sheet === 'PIM_EmployeeLifecycle', scn[0].cases[0].dataBinding.sheet);
}
{
  // storyId no sheet carries → needs_review, not a guessed sheet.
  const scn = [{ name: 'S', cases: [mk({ name: 'orphan', requirementRefs: ['REQ-3'] })] }];
  TDA.markDataAwareCases(scn, testData, { clauseStoryIndex: { 'REQ-3': 'US-OHRM-999' } });
  const b = scn[0].cases[0].dataBinding;
  ok('cited storyId with no data → needs_review (no sheet guessed)', b && b.matchKind === 'needs_review' && b.status === 'incomplete' && (b.findings || []).some((f) => f.code === 'story_id_no_data'), JSON.stringify(b));
}
{
  // no storyId at all → semantic fallback, flagged WEAK (needs_review).
  const scn = [{ name: 'S', cases: [mk({ name: 'generic login', module: '', requirementRefs: [] })] }];
  TDA.markDataAwareCases(scn, testData, {});
  const b = scn[0].cases[0].dataBinding;
  ok('no storyId → semantic bind flagged matchKind=semantic + needsReview', b && b.matchKind === 'semantic' && b.needsReview === true && (b.findings || []).some((f) => f.code === 'weak_semantic_binding'), JSON.stringify(b && { mk: b.matchKind, nr: b.needsReview }));
}

if (typeof matrix.filterRowsBySelector === 'function') {
  console.log('\n— runtime row filter honours story:<id> —');
  const rows = sheets[0].rows;
  const filtered = matrix.filterRowsBySelector(rows, { rowSelector: 'story:US-OHRM-004', storyColumn: 'storyId' }, sheets[0], { name: 'c' });
  ok('story:<id> selector returns ONLY that story\'s rows', filtered.length === 2 && filtered.every((r) => r.storyId === 'US-OHRM-004'), `got ${filtered.length}`);
}

console.log('\n— Step 3C: architect-cited coverageItemId binds directly (strongest signal) —');
{
  const ci = buildCoverageItems(contract).find((i) => i.sheet === 'PIM_EmployeeLifecycle' && i.storyId === 'US-OHRM-004');
  const scn = [{ name: 'S', cases: [mk({ name: 'cited', module: 'admin', requirementRefs: [], coverageItemId: ci.id })] }];
  TDA.markDataAwareCases(scn, testData, {});
  const b = scn[0].cases[0].dataBinding;
  ok('cited coverageItemId → bound to its sheet, matchKind=coverageItem', b && b.sheet === 'PIM_EmployeeLifecycle' && b.matchKind === 'coverageItem' && b.coverageItemId === ci.id, JSON.stringify(b && { s: b.sheet, mk: b.matchKind }));
  ok('coverageItem bind carries the story rowSelector', b && /^story:us-ohrm-004$/i.test(String(b.rowSelector)));
}

console.log('\n— Fix 3: TWO valid but different stories (ref vs cited CI) → story_id_conflict needs_review —');
{
  // ref-derived storyId US-OHRM-004 (→ PIM) but the architect CITED the Admin_UserSearch
  // coverage item, a VALID DIFFERENT story US-OHRM-009 (→ Admin). Neither is trustworthy
  // (the Architect likely mis-assigned a requirementRef) — do NOT blindly bind to either.
  // This is the exact "requirementRef says X, cited CoverageItem says Y" defect.
  const wrongCi = buildCoverageItems(contract).find((i) => i.sheet === 'Admin_UserSearch' && i.storyId === 'US-OHRM-009');
  const scn = [{ name: 'S', cases: [mk({ name: 'conflicting citation', module: 'admin', requirementRefs: ['REQ-C'], coverageItemId: wrongCi.id })] }];
  TDA.markDataAwareCases(scn, testData, { clauseStoryIndex: { 'REQ-C': 'US-OHRM-004' } });
  const b = scn[0].cases[0].dataBinding;
  ok('story_id_conflict → NOT bound to either sheet (sheet:null, needs_review)', b && b.sheet === null && b.matchKind === 'needs_review' && b.needsReview === true, JSON.stringify(b && { s: b.sheet, mk: b.matchKind }));
  ok('carries the story_id_conflict defect', b && (b.findings || []).some((f) => f.code === 'story_id_conflict'), JSON.stringify(b && (b.findings || []).map((f) => f.code)));
}
{
  // No cited CI at all → storyId is authoritative and binds its home sheet (the
  // conflict path only triggers on a competing VALID cited story, not its absence).
  const scn2 = [{ name: 'S', cases: [mk({ name: 'no citation', module: 'admin', requirementRefs: ['REQ-C2'] })] }];
  TDA.markDataAwareCases(scn2, testData, { clauseStoryIndex: { 'REQ-C2': 'US-OHRM-004' } });
  const b2 = scn2[0].cases[0].dataBinding;
  ok('no cited CI + storyId → bound to PIM by storyId (no false conflict)', b2 && b2.sheet === 'PIM_EmployeeLifecycle' && b2.matchKind === 'storyId', JSON.stringify(b2 && { s: b2.sheet, mk: b2.matchKind }));
}
{
  // A CONSISTENT citation (same sheet as the storyId) is retained as coverageItem.
  const goodCi = buildCoverageItems(contract).find((i) => i.sheet === 'PIM_EmployeeLifecycle' && i.storyId === 'US-OHRM-004');
  const scn = [{ name: 'S', cases: [mk({ name: 'consistent citation', module: 'admin', requirementRefs: ['REQ-D'], coverageItemId: goodCi.id })] }];
  TDA.markDataAwareCases(scn, testData, { clauseStoryIndex: { 'REQ-D': 'US-OHRM-004' } });
  const b = scn[0].cases[0].dataBinding;
  ok('consistent citation retained: sheet=PIM, matchKind=coverageItem', b && b.sheet === 'PIM_EmployeeLifecycle' && b.matchKind === 'coverageItem' && b.coverageItemId === goodCi.id, JSON.stringify(b && { s: b.sheet, mk: b.matchKind }));
  ok('consistent citation is NOT flagged as a mismatch', b && !(b.findings || []).some((f) => f.code === 'coverage_item_story_mismatch'));
}

console.log('\n— Step 4: coveragePlanner repair cannot pollute a strong storyId/coverageItem bind —');
const cov = fs.readFileSync(path.join(ROOT, 'server', 'services', 'coveragePlanner.js'), 'utf8');
ok('repair computes a __strongBind flag (storyId/coverageItem/module)', /__strongBind\s*=\s*!!\(c\.dataBinding && \(c\.dataBinding\.matchKind === 'storyId'/.test(cov));
ok('all three repair paths are gated on !__strongBind', (cov.match(/__strongBind/g) || []).length >= 4);
ok('"sheet exists" no longer marks complete — becomes needs_review', cov.includes('data_binding_sheet_exists_only') && /repairedBy: 'coverage_planner_sheet_exists'[\s\S]{0,40}/.test(cov) && !/status: 'complete',\s*findings: clearResolvedFindings\(c\.dataBinding\.findings\),\s*repairedBy: 'coverage_planner_sheet_exists'/.test(cov));

console.log('\n— Step 3C authoring: CoverageItems fed to the Architect prompt + cite instruction —');
const arch = fs.readFileSync(path.join(ROOT, 'server', 'services', 'agents', 'architect.js'), 'utf8');
ok('architect builds a CoverageItems block from the WorkbookContract', arch.includes('function buildCoverageItemsBlock(') && /buildCoverageItems\(buildWorkbookContract\(\{ sheets \}\)\)/.test(arch));
ok('CoverageItems block is injected into the composed prompt', /coverageItemsBlock/.test(arch) && /coveragePlanBlock, coverageItemsBlock, testDataBlock/.test(arch));
ok('prompt instructs the architect to cite coverageItemId (not a raw sheet)', arch.includes('set "coverageItemId"'));
ok('prompt enforces requirement/story-module accuracy (no cross-module story tag)', /REQUIREMENT\/STORY ACCURACY/.test(arch) && /same module the case actually tests/i.test(arch));
ok('prompt mandates {{expected}} per-row oracle for mixed-outcome items', /MIXED-OUTCOME/.test(arch) && /must assert the per-row expected value via \{\{expected\}\}/i.test(arch));

console.log('\n— Fix 2/3: cited CI whose storyId MATCHES wins over another same-story sheet + placeholder canonicalization —');
{
  // US-OHRM-002 lives in TWO valid sheets. The resolver picks the higher-row-count
  // "best" (Menu_Navigation, 3 rows); the architect CITED the exact GlobalSearch CI.
  // Because the CI's storyId matches the case storyId, the citation must WIN.
  const sheets2 = [
    { name: 'Menu_Navigation', headers: ['storyId', 'menuLabel', 'expectedVisibleSignal'], rows: [
      { storyId: 'US-OHRM-002', menuLabel: 'Admin', expectedVisibleSignal: 'Admin' },
      { storyId: 'US-OHRM-002', menuLabel: 'PIM', expectedVisibleSignal: 'PIM' },
      { storyId: 'US-OHRM-002', menuLabel: 'Leave', expectedVisibleSignal: 'Leave' },
    ] },
    { name: 'GlobalSearch_Menu', headers: ['storyId', 'searchTermInput', 'expectedVisibleSignal'], rows: [
      { storyId: 'US-OHRM-002', searchTermInput: 'Admin', expectedVisibleSignal: 'Admin' },
    ] },
  ];
  const contract2 = buildWorkbookContract({ sheets: sheets2 });
  const testData2 = { sheets: sheets2, mapping: { bindings: [
    { sheet: 'Menu_Navigation', columnToField: { menuLabel: 'menuLabel' }, expectedColumn: 'expectedVisibleSignal' },
    { sheet: 'GlobalSearch_Menu', columnToField: { searchTermInput: 'searchTermInput' }, expectedColumn: 'expectedVisibleSignal' },
  ] } };
  const gci = buildCoverageItems(contract2).find((i) => i.sheet === 'GlobalSearch_Menu' && i.storyId === 'US-OHRM-002');
  // The case cites the GlobalSearch CI and uses a LOWERCASED token as the LLM emitted it.
  const scn = [{ name: 'S', cases: [mk({ name: 'Global search returns matching menu label', module: 'admin', requirementRefs: ['REQ-G'], coverageItemId: gci.id, steps: [{ action: 'Fill', element: 'Search', value: '{{searchterminput}}' }] })] }];
  TDA.markDataAwareCases(scn, testData2, { clauseStoryIndex: { 'REQ-G': 'US-OHRM-002' } });
  const b = scn[0].cases[0].dataBinding;
  ok('cited CI (storyId matches) wins over the higher-row same-story sheet (GlobalSearch_Menu, not Menu_Navigation)', b && b.sheet === 'GlobalSearch_Menu' && b.matchKind === 'coverageItem', JSON.stringify(b && { s: b.sheet, mk: b.matchKind }));
  const stepsJson = JSON.stringify(scn[0].cases[0].steps);
  ok('placeholder canonicalized on the strong-bind path: {{searchterminput}} → {{searchTermInput}}', /\{\{searchTermInput\}\}/.test(stepsJson) && !/\{\{searchterminput\}\}/.test(stepsJson), stepsJson);
}

console.log('\n— storyId-first runs even with NO placeholders (v5 US-OHRM-005→MyInfo / 003→Leave fix) —');
{
  // A case with NO {{tokens}} but a derivable storyId + an explicit WRONG architect
  // sheet. storyId is authoritative regardless of placeholders → binds to its home
  // sheet, NOT the architect's guess. (Previously the block was gated on placeholders,
  // so this fell to the explicit path and produced a storyId↔sheet mismatch.)
  const scn = [{ name: 'S', cases: [mk({ name: 'no-token case, wrong explicit sheet', module: 'admin', requirementRefs: ['REQ-NP'], steps: [{ action: 'Click', element: 'Search' }, { action: 'Verify', element: 'Result' }], dataBinding: { sheet: 'Admin_UserSearch' } })] }];
  TDA.markDataAwareCases(scn, testData, { clauseStoryIndex: { 'REQ-NP': 'US-OHRM-004' } });
  const b = scn[0].cases[0].dataBinding;
  ok('no-placeholder case binds to its storyId sheet (PIM), not the explicit Admin sheet', b && b.sheet === 'PIM_EmployeeLifecycle' && b.matchKind === 'storyId', JSON.stringify(b && { s: b.sheet, mk: b.matchKind }));
}
{
  // A no-token, NO-storyId, NO-citedCI page-load case with an explicit sheet is left on
  // the explicit path (not force-rebound / not newly flagged).
  const scn = [{ name: 'S', cases: [mk({ name: 'page load', module: 'x', requirementRefs: [], steps: [{ action: 'Click', element: 'Home' }], dataBinding: { sheet: 'Admin_UserSearch' } })] }];
  TDA.markDataAwareCases(scn, testData, {});
  const b = scn[0].cases[0].dataBinding;
  ok('no-token/no-story explicit case stays on its explicit sheet (unchanged)', b && b.sheet === 'Admin_UserSearch', JSON.stringify(b && { s: b.sheet, mk: b.matchKind }));
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — storyId-first binding is wired into markDataAwareCases: storyId beats keyword/module AND overrides the architect\'s explicit guess, binds only the story\'s rows, a cited-but-absent storyId is needs_review, and a semantic-only bind is flagged weak.');
