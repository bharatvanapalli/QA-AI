'use strict';
/*
 * GENERATION COMPILER — ready-only gate. Proves the compile-repair-before-persist stage:
 *  • static (no-token) case bound to a sheet → binding CLEARED (not data-driven) → ready
 *  • product-gap presence check → ready (row-matrix advisories cleared)
 *  • data-driven UNIFORM expected outcome, no {{expected}} → advisory cleared → ready
 *  • data-driven VARYING expected outcome, no {{expected}} → REAL defect → not ready
 *  • deterministic single companion credential → ready (not needs_review)
 *  • story_id_conflict + a real story contract → rebound to the contract sheet, ready
 *  • compileGeneration repairs contract-backed candidates into the persisted ready suite
 * Pure fixtures, generic.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const GC = require(path.join(ROOT, 'server', 'services', 'generationCompiler'));
const { buildWorkbookContract } = require(path.join(ROOT, 'server', 'services', 'workbookContract'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

const sheets = [
  { name: 'PIM_EmployeeLifecycle', headers: ['storyId', 'name', 'expectedVisibleSignal'], rows: [
    { storyId: 'US-1', name: 'a', expectedVisibleSignal: 'Saved' },
    { storyId: 'US-1', name: 'b', expectedVisibleSignal: 'Saved' },
  ] },
  { name: 'PIM_Validation', headers: ['storyId', 'firstName', 'expectedValidationMessage'], rows: [
    { storyId: 'US-2', firstName: 'x', expectedValidationMessage: 'Saved' },
    { storyId: 'US-2', firstName: '', expectedValidationMessage: 'Required' },
  ] },
  { name: 'Admin_MissingFeature_Bugs', headers: ['storyId', 'mustHaveVisibleControl', 'expectedPlatformVerdict'], rows: [{ storyId: 'US-9', mustHaveVisibleControl: 'Export CSV', expectedPlatformVerdict: 'FAIL' }] },
];
const contract = buildWorkbookContract({ sheets });
const mustText = (t) => [{ type: 'TEXT', criticality: 'must', payload: { expectedText: t } }];

function compileOne(caseObj) {
  const scn = [{ name: 'S', cases: [caseObj] }];
  const out = GC.compileGeneration({ scenarios: scn, workbookContract: contract });
  return { c: scn[0].cases[0], report: out.report, allReady: out.allAutomatableReady };
}

console.log('— static no-token case → binding cleared, ready —');
{
  const r = compileOne({ name: 'Verify menu items present', automatability: 'automatable', steps: [{ action: 'Click', element: 'Menu' }], declaredAssertions: mustText('Admin'), dataBinding: { sheet: 'PIM_EmployeeLifecycle', columnToField: { name: 'name' }, expectedColumn: 'expectedVisibleSignal', findings: [{ code: 'data_expected_placeholder_missing', severity: 'warning' }] } });
  ok('static case data binding CLEARED', r.c.dataBinding == null && r.c.caseClass === 'static', JSON.stringify({ b: r.c.dataBinding, cls: r.c.caseClass }));
  ok('static case is ready', r.report.ready === 1 && r.report.needsReview === 0, JSON.stringify(r.report));
}

console.log('\n— product-gap presence check (NO tokens) → static, ready —');
{
  const r = compileOne({ name: 'CSV export control absent — product gap', automatability: 'automatable', steps: [], declaredAssertions: mustText('Export'), dataBinding: { sheet: 'Admin_MissingFeature_Bugs', findings: [{ code: 'data_input_placeholders_missing', severity: 'warning' }, { code: 'data_expected_placeholder_missing', severity: 'warning' }] } });
  ok('no-token product-gap classified + binding cleared + ready', r.c.caseClass === 'product-gap' && r.c.dataBinding == null && r.report.ready === 1, JSON.stringify({ cls: r.c.caseClass, b: r.c.dataBinding, rep: r.report }));
}

console.log('\n— DATA-DRIVEN product-gap (consumes {{musthavevisiblecontrol}}) → KEEP binding, ready —');
{
  // The *_MissingFeature_Bugs sheet exposes a real mustHaveVisibleControl column. A case
  // that reads {{musthavevisiblecontrol}} is data-driven — its binding must NOT be cleared
  // (clearing orphaned the token → unresolved_tokens_no_binding block, the v7 regression).
  const r = compileOne({ name: 'Export CSV control presence check', automatability: 'automatable', steps: [{ action: 'Verify', element: 'Control', value: '{{musthavevisiblecontrol}}' }], declaredAssertions: mustText('Export CSV'), dataBinding: { sheet: 'Admin_MissingFeature_Bugs', rowSelector: 'story:US-9', matchKind: 'storyId', columnToField: { musthavevisiblecontrol: 'mustHaveVisibleControl' }, expectedColumn: 'expectedPlatformVerdict' } });
  ok('data-driven product-gap KEEPS its binding (not orphaned)', r.c.dataBinding && r.c.dataBinding.sheet === 'Admin_MissingFeature_Bugs', JSON.stringify(r.c.dataBinding));
  ok('data-driven product-gap → ready (token resolves, not blocked)', r.report.ready === 1 && r.report.blocked === 0, JSON.stringify(r.report));
}

console.log('\n— data-driven UNIFORM expected, no {{expected}} → advisory cleared, ready —');
{
  const r = compileOne({ name: 'Save employee per row', automatability: 'automatable', steps: [{ action: 'Fill', element: 'Name', value: '{{name}}' }], declaredAssertions: mustText('Saved'), dataBinding: { sheet: 'PIM_EmployeeLifecycle', rowSelector: 'story:US-1', columnToField: { name: 'name' }, expectedColumn: 'expectedVisibleSignal', matchKind: 'storyId', findings: [{ code: 'data_expected_placeholder_missing', severity: 'warning' }] } });
  ok('uniform-outcome data case → ready (fixed oracle ok)', r.report.ready === 1 && r.report.needsReview === 0, JSON.stringify(r.report));
  ok('data_expected_placeholder_missing was cleared', !(r.c.dataBinding.findings || []).some((f) => f.code === 'data_expected_placeholder_missing'));
}

console.log('\n— data-bound no-token/literal case → compiler injects row placeholders —');
{
  const r = compileOne({ name: 'Save employee with literal authoring', automatability: 'automatable', steps: [{ action: 'Fill', element: 'Name', value: 'a' }], declaredAssertions: mustText('Saved'), dataBinding: { sheet: 'PIM_EmployeeLifecycle', rowSelector: 'story:US-1', storyId: 'US-1', columnToField: {}, expectedColumn: 'expectedVisibleSignal', matchKind: 'storyId', findings: [{ code: 'data_input_placeholders_missing', severity: 'warning' }, { code: 'data_expected_placeholder_missing', severity: 'warning' }] } });
  ok('literal bound fill is rewritten to a row placeholder instead of static-cleared', r.c.dataBinding && r.c.steps[0].value === '{{name}}', JSON.stringify({ steps: r.c.steps, binding: r.c.dataBinding }));
  ok('row oracle {{expected}} is synthesized and mapped', (r.c.declaredAssertions || []).some((a) => a.payload && a.payload.expectedText === '{{expected}}') && r.c.dataBinding.columnToField.expected === 'expectedVisibleSignal', JSON.stringify({ assertions: r.c.declaredAssertions, binding: r.c.dataBinding }));
  ok('rewritten literal-bound case is ready', r.report.ready === 1 && r.report.needsReview === 0 && r.report.blocked === 0, JSON.stringify(r.report));
}

console.log('\n— data-driven VARYING expected: fixed-text must is REPAIRED to {{expected}} → ready —');
{
  const r = compileOne({ name: 'Validation matrix per row', automatability: 'automatable', steps: [{ action: 'Fill', element: 'First Name', value: '{{firstName}}' }], declaredAssertions: mustText('Required'), dataBinding: { sheet: 'PIM_Validation', rowSelector: 'story:US-2', columnToField: { firstName: 'firstName' }, expectedColumn: 'expectedValidationMessage', matchKind: 'storyId' } });
  ok('varying case with a fixed TEXT must → REPAIRED to ready', r.report.ready === 1 && r.report.needsReview === 0, JSON.stringify(r.report));
  const injected = (r.c.declaredAssertions || []).some((a) => a && a.payload && a.payload.expectedText === '{{expected}}');
  ok('the must expectedText was rewritten to {{expected}} (per-row oracle)', injected, JSON.stringify(r.c.declaredAssertions));
  ok('binding maps expected → the column', r.c.dataBinding && r.c.dataBinding.columnToField && r.c.dataBinding.columnToField.expected === 'expectedValidationMessage');
}
{
  // Varying sheet but the must is EVALUATE (a DYNAMIC content oracle) → already handles
  // per-row outcomes; no {{expected}} needed, not a defect → ready.
  const r = compileOne({ name: 'Search matrix with evaluate oracle', automatability: 'automatable', steps: [{ action: 'Fill', element: 'Search', value: '{{firstName}}' }], declaredAssertions: [{ type: 'EVALUATE', criticality: 'must', payload: { script: '() => document.querySelectorAll(".oxd-table-row").length >= 0', expectedReturn: 'true' } }], dataBinding: { sheet: 'PIM_Validation', rowSelector: 'story:US-2', columnToField: { firstName: 'firstName' }, expectedColumn: 'expectedValidationMessage', matchKind: 'storyId' } });
  ok('varying case with an EVALUATE (dynamic) oracle → ready, not flagged', r.report.ready === 1 && !r.report.defects.some((d) => d.code === 'mixed_expected_needs_row_oracle'), JSON.stringify(r.report));
}
{
  // Varying sheet but the ONLY must is a PAGE (no plain-text must to retarget) → genuine defect.
  const r = compileOne({ name: 'Validation matrix, page-only must', automatability: 'automatable', steps: [{ action: 'Fill', element: 'First Name', value: '{{firstName}}' }], declaredAssertions: [{ type: 'PAGE', criticality: 'must', payload: { pageName: 'PIM' } }], dataBinding: { sheet: 'PIM_Validation', rowSelector: 'story:US-2', columnToField: { firstName: 'firstName' }, expectedColumn: 'expectedValidationMessage', matchKind: 'storyId' } });
  ok('varying case with NO injectable text must → compiler synthesizes {{expected}} oracle and repairs to ready', r.report.ready === 1 && r.report.needsReview === 0 && r.report.blocked === 0, JSON.stringify(r.report));
  ok('malformed/page-only must no longer poisons repaired case', (r.c.declaredAssertions || []).some((a) => a && a.type === 'TEXT' && a.payload && a.payload.expectedText === '{{expected}}'), JSON.stringify(r.c.declaredAssertions));
}
{
  // Already consumes {{expected}} → ready, no change.
  const r = compileOne({ name: 'Validation matrix, tokenized oracle', automatability: 'automatable', steps: [{ action: 'Fill', element: 'First Name', value: '{{firstName}}' }], declaredAssertions: [{ type: 'TEXT', criticality: 'must', payload: { expectedText: '{{expected}}' } }], dataBinding: { sheet: 'PIM_Validation', rowSelector: 'story:US-2', columnToField: { firstName: 'firstName' }, expectedColumn: 'expectedValidationMessage', matchKind: 'storyId' } });
  ok('varying-outcome case already WITH {{expected}} → ready', r.report.ready === 1, JSON.stringify(r.report));
}

console.log('\n— deterministic companion credentials → ready —');
{
  const r = compileOne({ name: 'Login and verify dashboard', automatability: 'automatable', steps: [{ action: 'Fill', element: 'User', value: '{{username}}' }], declaredAssertions: mustText('Dashboard'), dataBinding: { sheet: 'PIM_EmployeeLifecycle', rowSelector: 'story:US-1', columnToField: { name: 'name' }, matchKind: 'storyId', companions: [{ sheet: 'ExecutionProfiles', columnToField: { username: 'username', loginpassword: 'loginpassword' } }], needsReview: true, findings: [{ code: 'multi_source_credential_binding', severity: 'warning' }] } });
  ok('single deterministic companion → ready (multi_source cleared)', r.report.ready === 1 && !(r.c.dataBinding.findings || []).some((f) => f.code === 'multi_source_credential_binding'), JSON.stringify(r.report));
}

console.log('\n— story_id_conflict with a real story contract is repaired, not surfaced —');
{
  const r = compileOne({ name: 'Add employee empty name', storyId: 'US-2', automatability: 'automatable', steps: [{ action: 'Fill', element: 'First Name', value: '{{firstName}}' }], declaredAssertions: mustText('Required'), dataBinding: { sheet: null, matchKind: 'needs_review', needsReview: true, source: 'story_id_conflict', findings: [{ code: 'story_id_conflict', severity: 'warning', detail: 'ref vs CI conflict' }] } });
  ok('story_id_conflict + storyId → rebound from WorkbookContract and ready', r.report.ready === 1 && r.c.dataBinding && r.c.dataBinding.sheet === 'PIM_Validation', JSON.stringify({ report: r.report, binding: r.c.dataBinding }));
  ok('story_id_conflict warning is removed before persistence', !(r.c.dataBinding.findings || []).some((f) => f.code === 'story_id_conflict'));
}

console.log('\n— REPAIR-FIRST ASSEMBLY: contract-backed defects become ready before persistence —');
{
  const scn = [{ name: 'S', cases: [
    { name: 'Save per row', automatability: 'automatable', steps: [{ action: 'Fill', element: 'Name', value: '{{name}}' }], declaredAssertions: mustText('Saved'), dataBinding: { sheet: 'PIM_EmployeeLifecycle', rowSelector: 'story:US-1', columnToField: { name: 'name' }, expectedColumn: 'expectedVisibleSignal', matchKind: 'storyId' } },
    // a conflict that still carries the story contract is repaired, not dropped.
    { name: 'Conflicted case', storyId: 'US-2', automatability: 'automatable', steps: [{ action: 'Fill', element: 'X', value: '{{firstName}}' }], declaredAssertions: mustText('Required'), dataBinding: { sheet: null, matchKind: 'needs_review', needsReview: true, source: 'story_id_conflict', findings: [{ code: 'story_id_conflict', severity: 'warning', detail: 'ref vs CI' }] } },
  ] }];
  const out = GC.compileGeneration({ scenarios: scn, workbookContract: contract });
  ok('report is clean: all contract-backed cases repaired to ready', out.allAutomatableReady === true && out.report.ready === 2 && out.report.needsReview === 0 && out.report.blocked === 0, JSON.stringify(out.report));
  const readyCases = out.readyScenarios.flatMap((s) => s.cases);
  ok('readyScenarios contains BOTH cases after repair (nothing contract-backed is dropped)', readyCases.length === 2 && readyCases.some((c) => c.name === 'Conflicted case'), JSON.stringify(readyCases.map((c) => c.name)));
  ok('diagnostics are empty for repaired cases', out.report.notReady.length === 0, JSON.stringify(out.report.notReady));
}
{
  // Even when the Architect lost storyId/coverageItemId, the WorkbookContract token
  // signature is enough to recover the source sheet. This is the architecture we want:
  // the contract, not the LLM's citation memory, owns binding.
  const scn = [{ name: 'S', cases: [
    { name: 'Conflicted only', automatability: 'automatable', steps: [{ action: 'Fill', element: 'X', value: '{{firstName}}' }], declaredAssertions: mustText('Required'), dataBinding: { sheet: null, matchKind: 'needs_review', needsReview: true, source: 'story_id_conflict', findings: [{ code: 'story_id_conflict', severity: 'warning' }] } },
  ] }];
  const out = GC.compileGeneration({ scenarios: scn, workbookContract: contract });
  const total = out.readyScenarios.reduce((a, s) => a + s.cases.length, 0);
  const c = out.readyScenarios[0] && out.readyScenarios[0].cases[0];
  ok('lost story/binding is repaired by token signature, not withheld', total === 1 && out.report.ready === 1 && out.report.notReady.length === 0, JSON.stringify(out.report));
  ok('token-signature recovery picked the sheet that owns {{firstName}}', c && c.dataBinding && c.dataBinding.sheet === 'PIM_Validation' && c.dataBinding.matchKind === 'storyId', JSON.stringify(c && c.dataBinding));
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — GenerationCompiler REPAIRS contract-backed candidates into a ready-only suite; only source-less impossible artifacts stay out of persistence.');
