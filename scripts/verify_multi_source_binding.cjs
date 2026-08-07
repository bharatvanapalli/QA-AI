'use strict';
/*
 * FIX 1 + FIX 4 — multi-source credential binding. A case may bind to a primary ORACLE
 * sheet that does NOT carry login credentials (e.g. Dashboard_QuickLaunch) while its
 * login step needs {{username}}/{{loginpassword}} from a companion auth sheet
 * (ExecutionProfiles). Behaviour:
 *   • a companion auth sheet supplies the credential roles → record binding.companions,
 *     drop the HARD unmapped-token block, and mark the case needs_review with a clear
 *     multi_source_credential_binding defect (NOT a silent "ready", NOT a fake pass).
 *   • a NON-credential unmapped token with NO companion → stays blocked (honest).
 * Generic, pure fixtures.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const TDA = require(path.join(ROOT, 'server', 'services', 'testDataAuthoring'));
const caseCompiler = require(path.join(ROOT, 'server', 'services', 'caseCompiler'));
const { buildWorkbookContract, buildCoverageItems } = require(path.join(ROOT, 'server', 'services', 'workbookContract'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

const sheets = [
  { name: 'Dashboard_QuickLaunch', headers: ['storyId', 'quickLaunchLabel', 'expectedVisibleSignal'], rows: [
    { storyId: 'US-OHRM-001', quickLaunchLabel: 'Assign Leave', expectedVisibleSignal: 'Assign Leave' },
    { storyId: 'US-OHRM-001', quickLaunchLabel: 'Leave List', expectedVisibleSignal: 'Leave List' },
  ] },
  { name: 'ExecutionProfiles', headers: ['role', 'username', 'loginpassword'], rows: [
    { role: 'Admin', username: 'Admin', loginpassword: 'admin123' },
  ] },
];
const testData = { sheets, mapping: { bindings: [
  { sheet: 'Dashboard_QuickLaunch', columnToField: { quickLaunchLabel: 'quickLaunchLabel' }, expectedColumn: 'expectedVisibleSignal' },
  { sheet: 'ExecutionProfiles', columnToField: { role: 'role', username: 'username', loginpassword: 'loginpassword' } },
] } };
const contract = buildWorkbookContract({ sheets });
const ci = buildCoverageItems(contract).find((i) => i.sheet === 'Dashboard_QuickLaunch' && i.storyId === 'US-OHRM-001');

const mk = (over) => ({ name: 'c', module: 'dashboard', type: 'functional', requirementRefs: [], declaredAssertions: [{ type: 'TEXT', criticality: 'must', payload: { expectedText: 'Dashboard' } }], steps: [], ...over });

console.log('— multi-source: login creds from a companion auth sheet → needs_review, not blocked —');
{
  const scn = [{ name: 'S', cases: [mk({
    name: 'Admin login and Dashboard widget verification',
    requirementRefs: ['REQ-1'], coverageItemId: ci.id,
    steps: [
      { action: 'Fill', element: 'Username', value: '{{username}}' },
      { action: 'Fill', element: 'Password', value: '{{loginpassword}}' },
      { action: 'Verify', element: 'Quick Launch', value: '{{quickLaunchLabel}}' },
    ],
  })] }];
  TDA.markDataAwareCases(scn, testData, { clauseStoryIndex: { 'REQ-1': 'US-OHRM-001' } });
  const b = scn[0].cases[0].dataBinding;
  ok('bound to the primary ORACLE sheet (Dashboard_QuickLaunch)', b && b.sheet === 'Dashboard_QuickLaunch', JSON.stringify(b && { s: b.sheet, mk: b.matchKind }));
  ok('records a companion source for the credential roles (ExecutionProfiles)', b && Array.isArray(b.companions) && b.companions.some((c) => c.sheet === 'ExecutionProfiles' && c.columnToField && (c.columnToField.username || c.columnToField.loginpassword)), JSON.stringify(b && b.companions));
  ok('the HARD unmapped-token flag is cleared for the credential roles', b && !(b.findings || []).some((f) => f.code === 'data_placeholder_not_in_mapping' && /username|loginpassword/i.test(String(f.token))), JSON.stringify(b && (b.findings || []).map((f) => f.code + (f.token ? ':' + f.token : ''))));
  ok('carries the multi_source_credential_binding review defect', b && (b.findings || []).some((f) => f.code === 'multi_source_credential_binding'));
  // Compile the stored shape — must be needs_review, NOT blocked, NOT ready.
  const v = caseCompiler.compileCase({ name: scn[0].cases[0].name, steps: scn[0].cases[0].steps, assertions: '', declaredAssertions: scn[0].cases[0].declaredAssertions, dataBinding: b, automatability: 'automatable' });
  ok('CaseCompiler → needs_review (companion resolvable, surfaced) — not blocked, not silently ready', v.state === 'needs_review' && !v.blockers.some((x) => x.code === 'unmapped_tokens'), JSON.stringify({ st: v.state, bl: v.blockers.map((x) => x.code), w: v.warnings.map((x) => x.code) }));
}

console.log('\n— honest block: a NON-credential unmapped token with NO companion stays blocked —');
{
  const scn = [{ name: 'S', cases: [mk({
    name: 'Widget uses an unmapped non-cred token',
    requirementRefs: ['REQ-1'], coverageItemId: ci.id,
    steps: [{ action: 'Fill', element: 'Widget', value: '{{unmappedWidgetField}}' }, { action: 'Verify', element: 'QL', value: '{{quickLaunchLabel}}' }],
  })] }];
  TDA.markDataAwareCases(scn, testData, { clauseStoryIndex: { 'REQ-1': 'US-OHRM-001' } });
  const b = scn[0].cases[0].dataBinding;
  ok('non-credential unmapped token remains flagged (no companion for it)', b && (b.findings || []).some((f) => f.code === 'data_placeholder_not_in_mapping' && /unmappedwidgetfield/i.test(String(f.token))), JSON.stringify(b && (b.findings || []).map((f) => f.code + (f.token ? ':' + f.token : ''))));
  const v = caseCompiler.compileCase({ name: scn[0].cases[0].name, steps: scn[0].cases[0].steps, assertions: '', declaredAssertions: scn[0].cases[0].declaredAssertions, dataBinding: b, automatability: 'automatable' });
  ok('CaseCompiler still BLOCKS the un-resolvable token (no fake pass)', v.state === 'blocked' && v.blockers.some((x) => x.code === 'unmapped_tokens'), JSON.stringify({ st: v.state, bl: v.blockers.map((x) => x.code) }));
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — multi-source credential binding: a primary oracle sheet + companion auth source is needs_review with a clear defect (never a fake pass), while a truly-unmappable token still blocks.');
