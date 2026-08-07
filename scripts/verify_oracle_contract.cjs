'use strict';
/*
 * STEP 3D — Oracle Contract. Proves the per-case oracle is COMPOSED from all contract
 * sources (declaredAssertions + dataBinding + requirementRefs/storyId + operations +
 * WorkbookContract row evidence), that the row-evidence layer does real work (flags a
 * data-driven case with no data-sourced oracle), that the CaseCompiler CONSUMES it
 * (its promotion verdict reflects the contract's findings AND carries the contract),
 * and that supplying NO workbook contract leaves the execution gate byte-identical.
 *
 * Pure fixtures, generic (no site/sheet string drives behaviour).
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const OC = require(path.join(ROOT, 'server', 'services', 'oracleContract'));
const caseCompiler = require(path.join(ROOT, 'server', 'services', 'caseCompiler'));
const { buildWorkbookContract, buildCoverageItems } = require(path.join(ROOT, 'server', 'services', 'workbookContract'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

// Sheet WITH an expected/oracle column (data-sourced truth exists) and one WITHOUT.
const sheets = [
  { name: 'PIM_EmployeeLifecycle', headers: ['storyId', 'username', 'password', 'expectedVisibleSignal'], rows: [
    { storyId: 'US-OHRM-004', username: 'admin', password: 'p', expectedVisibleSignal: 'Saved' },
    { storyId: 'US-OHRM-004', username: 'hr', password: 'p', expectedVisibleSignal: 'Saved' },
  ] },
  { name: 'Reference_Data', headers: ['storyId', 'username', 'password'], rows: [
    { storyId: 'US-OHRM-050', username: 'x', password: 'p' },
  ] },
];
const contract = buildWorkbookContract({ sheets });
const coverageItems = buildCoverageItems(contract);
const ciPim = coverageItems.find((i) => i.sheet === 'PIM_EmployeeLifecycle' && i.storyId === 'US-OHRM-004');
const ciRef = coverageItems.find((i) => i.sheet === 'Reference_Data' && i.storyId === 'US-OHRM-050');

console.log('— compose: a data-driven case binds expectations to workbook row evidence —');
const dataCase = {
  name: 'Edit employee — save',
  module: 'pim',
  automatability: 'automatable',
  requirementRefs: ['REQ-X'],
  storyId: 'US-OHRM-004',
  coverageItemId: ciPim.id,
  steps: [{ action: 'Fill', element: 'Name', value: '{{username}}' }],
  declaredAssertions: [
    { id: 'a1', type: 'TEXT', criticality: 'must', provenance: 'doc_quoted', payload: { expectedText: 'Successfully Saved' } },
    { id: 'a2', type: 'PAGE', criticality: 'should', provenance: 'qa_standard', payload: { pageName: 'PIM' } },
  ],
  dataBinding: { sheet: 'PIM_EmployeeLifecycle', rowSelector: 'story:US-OHRM-004', storyColumn: 'storyId', matchKind: 'coverageItem', status: 'complete', coverageItemId: ciPim.id, storyId: 'US-OHRM-004' },
  operations: { status: 'complete', operations: [{ type: 'fill' }], dropped: [] },
};
const oc = OC.buildOracleContract(dataCase, { workbookContract: contract });
ok('schemaVersion oc-1', oc.schemaVersion === 'oc-1');
ok('carries storyId + requirementRefs + coverageItemId', oc.storyId === 'US-OHRM-004' && oc.requirementRefs[0] === 'REQ-X' && oc.coverageItemId === ciPim.id, JSON.stringify({ s: oc.storyId, r: oc.requirementRefs, c: oc.coverageItemId }));
ok('verdict.mode = data_driven', oc.verdict.mode === 'data_driven');
ok('expectations flattened from declaredAssertions (2, typed)', oc.expectations.length === 2 && oc.expectations[0].type === 'TEXT' && oc.expectations[0].expected === 'Successfully Saved', JSON.stringify(oc.expectations));
ok('qa_standard provenance → source qa_standard', oc.expectations[1].source === 'qa_standard');
ok('verdict.requiredEvidenceKinds derived from the MUST assertion(s)', oc.verdict.requiredEvidenceKinds.includes('text_present') && oc.verdict.mustCount === 1, JSON.stringify(oc.verdict));
ok('rowEvidence resolved from the bound CoverageItem (expected oracle present)', oc.rowEvidence && oc.rowEvidence.sheet === 'PIM_EmployeeLifecycle' && oc.rowEvidence.oracleRoles.includes('visibleSignal') && oc.rowEvidence.rowCount === 2, JSON.stringify(oc.rowEvidence));
ok('data-sourced oracle present → NO data_oracle_missing finding', !oc.findings.some((f) => f.code === 'data_oracle_missing'), JSON.stringify(oc.findings));

console.log('\n— compose: data-driven case bound to rows with NO expected column → flagged —');
const blindCase = { ...dataCase, name: 'Reference lookup', storyId: 'US-OHRM-050', coverageItemId: ciRef.id,
  dataBinding: { sheet: 'Reference_Data', rowSelector: 'story:US-OHRM-050', storyColumn: 'storyId', matchKind: 'coverageItem', status: 'complete', coverageItemId: ciRef.id, storyId: 'US-OHRM-050' } };
const ocBlind = OC.buildOracleContract(blindCase, { workbookContract: contract });
ok('rowEvidence has empty oracleRoles', ocBlind.rowEvidence && ocBlind.rowEvidence.oracleRoles.length === 0, JSON.stringify(ocBlind.rowEvidence));
ok('flags data_oracle_missing (cannot source the expected outcome from data)', ocBlind.findings.some((f) => f.code === 'data_oracle_missing'), JSON.stringify(ocBlind.findings));

console.log('\n— alias supply: a must expecting {{expected}} that the binding ALIASES to a real column is NOT flagged —');
{
  // dataBinding.columnToField.expected → expectedVisibleSignal. {{expected}} (the role)
  // and {{expectedVisibleSignal}} (the header) are BOTH supplied — must not false-flag.
  const aliasCase = { ...dataCase, name: 'expects the aliased role',
    declaredAssertions: [{ id: 'a1', type: 'TEXT', criticality: 'must', payload: { expectedText: '{{expected}}' } }],
    dataBinding: { sheet: 'PIM_EmployeeLifecycle', rowSelector: 'story:US-OHRM-004', storyColumn: 'storyId', matchKind: 'coverageItem', status: 'complete', coverageItemId: ciPim.id, storyId: 'US-OHRM-004', columnToField: { username: 'username' }, expectedColumn: 'expectedVisibleSignal' } };
  const ocAlias = OC.buildOracleContract(aliasCase, { workbookContract: contract });
  ok('{{expected}} aliased to expectedVisibleSignal → NO expected_value_token_unsupplied', !ocAlias.findings.some((f) => f.code === 'expected_value_token_unsupplied'), JSON.stringify(ocAlias.findings.map((f) => f.code)));
  const aliasCase2 = { ...aliasCase, declaredAssertions: [{ id: 'a1', type: 'TEXT', criticality: 'must', payload: { expectedText: '{{expectedVisibleSignal}}' } }] };
  ok('{{expectedVisibleSignal}} (the header itself) → NO false flag', !OC.buildOracleContract(aliasCase2, { workbookContract: contract }).findings.some((f) => f.code === 'expected_value_token_unsupplied'));
}

console.log('\n— compose: a must expecting {{token}} the bound rows cannot supply → flagged —');
const tokCase = { ...dataCase, declaredAssertions: [{ id: 'a1', type: 'TEXT', criticality: 'must', payload: { expectedText: '{{nonexistentColumn}}' } }] };
const ocTok = OC.buildOracleContract(tokCase, { workbookContract: contract });
ok('flags expected_value_token_unsupplied', ocTok.findings.some((f) => f.code === 'expected_value_token_unsupplied'), JSON.stringify(ocTok.findings));

console.log('\n— CaseCompiler CONSUMES the contract (verdict reflects it + carries it) —');
const withWb = caseCompiler.compileCase(blindCase, { workbookContract: contract });
ok('compileCase attaches the oracleContract to its result', withWb.oracleContract && withWb.oracleContract.schemaVersion === 'oc-1');
ok('data_oracle_missing elevated to a needs_review warning', withWb.state === 'needs_review' && withWb.warnings.some((w) => w.code === 'data_oracle_missing'), JSON.stringify({ st: withWb.state, w: withWb.warnings.map((x) => x.code) }));
ok('a data-oracle finding is NEVER a hard blocker', withWb.blockers.every((b) => b.code !== 'data_oracle_missing'));

console.log('\n— NO workbook contract supplied → execution gate behaviour unchanged —');
const noWb = caseCompiler.compileCase(blindCase, {});
ok('without workbookContract, no rowEvidence → no data_oracle_missing warning', !noWb.warnings.some((w) => w.code === 'data_oracle_missing'), JSON.stringify(noWb.warnings.map((x) => x.code)));
ok('contract still composes (mode known) even without row evidence', noWb.oracleContract && noWb.oracleContract.verdict.mode === 'data_driven' && noWb.oracleContract.rowEvidence === null);

console.log('\n— static (non-data) case: mode=static, no row-evidence findings —');
const staticCase = { name: 'Open login page', module: 'auth', automatability: 'automatable', steps: [], requirementRefs: [],
  declaredAssertions: [{ id: 'p1', type: 'PAGE', criticality: 'must', payload: { pageName: 'Login' } }] };
const ocStatic = OC.buildOracleContract(staticCase, { workbookContract: contract });
ok('verdict.mode = static when no data binding', ocStatic.verdict.mode === 'static' && ocStatic.rowEvidence === null);
ok('requiredEvidenceKinds includes page_present', ocStatic.verdict.requiredEvidenceKinds.includes('page_present'));
ok('no data-oracle findings for a static case', !ocStatic.findings.some((f) => f.code === 'data_oracle_missing'));

console.log('\n— buildOracleContractFromStored derives the SAME contract from a TestCase row —');
const stored = {
  name: dataCase.name, module: 'pim', automatability: 'automatable',
  steps: JSON.stringify(dataCase.steps), assertions: '',
  declaredAssertions: JSON.stringify(dataCase.declaredAssertions),
  dataBindingJson: JSON.stringify(dataCase.dataBinding),
  operationsJson: JSON.stringify(dataCase.operations),
  requirementRefs: JSON.stringify(['REQ-X']),
  storyId: 'US-OHRM-004', coverageItemId: ciPim.id,
};
const ocStored = OC.buildOracleContractFromStored(stored, { workbookContract: contract });
ok('stored-derived contract matches: storyId + mode + rowEvidence', ocStored && ocStored.storyId === 'US-OHRM-004' && ocStored.verdict.mode === 'data_driven' && ocStored.rowEvidence.sheet === 'PIM_EmployeeLifecycle', JSON.stringify(ocStored && { s: ocStored.storyId, m: ocStored.verdict.mode }));
ok('stored-derived requiredEvidenceKinds match the live compose', JSON.stringify(ocStored.verdict.requiredEvidenceKinds) === JSON.stringify(oc.verdict.requiredEvidenceKinds));

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — the Oracle Contract composes every case-level contract source into one derivable snapshot, binds expectations to workbook row evidence, flags un-sourceable data oracles, and is consumed by the CaseCompiler without changing the execution gate.');
