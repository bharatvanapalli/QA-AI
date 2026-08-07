'use strict';

/**
 * Deterministic guard for the CoveragePlanManifest feature.
 *   node scripts/verify_coverage_planner.cjs
 *
 * No LLM calls, no database writes. This verifies both planner behavior and
 * the source-level trigger chain: manifest -> Architect prompt -> validation /
 * repair -> canonical persistence -> API coverageSummary.
 */

const fs = require('fs');
const path = require('path');
const cp = require('../server/services/coveragePlanner');

let failures = 0;
const ok = (m) => console.log('  ok - ' + m);
const bad = (m) => { console.log('  FAIL - ' + m); failures += 1; };
const assert = (cond, msg) => (cond ? ok(msg) : bad(msg));
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function item(manifest, predicate) {
  return manifest.items.find(predicate);
}

const loginTestData = {
  sheets: [{
    name: 'LoginData',
    headers: ['Username', 'Password', 'Expected Result', 'Type'],
    rows: [
      { Username: 'Admin', Password: 'admin123', 'Expected Result': 'Dashboard', Type: 'positive' },
    ],
  }],
  mapping: {
    bindings: [{
      sheet: 'LoginData',
      module: 'Authentication',
      moduleKey: 'Authentication',
      purpose: 'authentication login credentials username password',
      scenarioName: 'Authentication Login',
      columnToField: { username: 'Username', password: 'Password' },
      expectedColumn: 'Expected Result',
      rowClassColumn: 'Type',
    }],
    unmapped: [],
  },
};

const atlas = {
  capabilities: [{
    capabilityId: 'cap-login',
    type: 'login',
    name: 'Login form',
    pageUrl: '/login',
    operations: ['fill username', 'fill password', 'click login'],
  }],
};

console.log('\n[1] Coverage planner manifest classification');
const loginManifest = cp.buildCoveragePlanManifest({
  requirements: [
    {
      id: 'US-AUTH-LOGIN',
      title: 'Admin can sign in with username and password credentials',
      moduleHint: 'Authentication',
      content: 'Admin can sign in with username and password credentials and see the expected dashboard result.',
    },
    {
      id: 'US-PROFILE-AVATAR',
      title: 'User updates profile avatar preference',
      moduleHint: 'Profile',
      content: 'User can update the profile avatar preference.',
    },
  ],
  testData: loginTestData,
  calibrationAtlas: atlas,
});
const loginBound = item(loginManifest, (i) => i.type === cp.ITEM_TYPES.DATA_BOUND && i.dataSource && i.dataSource.sheet === 'LoginData');
assert(loginBound && loginBound.required && loginBound.confidence === 'high', 'high-confidence auth/login sheet becomes required DATA_BOUND');
const standardManifest = cp.buildCoveragePlanManifest({
  requirements: [{
    id: 'US-PROFILE-AVATAR',
    title: 'User updates profile avatar preference',
    moduleHint: 'Profile',
    content: 'User can update the profile avatar preference.',
  }],
  testData: loginTestData,
  calibrationAtlas: { capabilities: [] },
});
const standard = item(standardManifest, (i) => i.storyRef && i.storyRef.id === 'US-PROFILE-AVATAR');
assert(standard && standard.type === cp.ITEM_TYPES.STANDARD && standard.required, 'unrelated story becomes required STANDARD');

const advisoryManifest = cp.buildCoveragePlanManifest({
  requirements: [{ id: 'US-CRED-AUDIT', title: 'Credentials audit report', content: 'Credentials audit report' }],
  testData: loginTestData,
  calibrationAtlas: { capabilities: [] },
});
const advisory = item(advisoryManifest, (i) => i.advisory && i.confidence === 'medium');
assert(advisory && advisory.required === false, 'medium-confidence data link is advisory, not required');
const advisoryValidation = cp.validateCoveragePlan({
  manifest: advisoryManifest,
  scenarios: [{
    name: 'Credentials audit report',
    module: 'Audit',
    cases: [{ name: 'Audit report loads', coverageRefs: [item(advisoryManifest, (i) => i.required).manifestItemId], steps: [] }],
  }],
  testData: loginTestData,
});
assert(advisoryValidation.ok && advisoryValidation.findings.some((f) => f.code === 'coverage_advisory_omitted'), 'omitted advisory link logs info only');

console.log('\n[2] Conservative security and validation row linking');
const securityData = {
  sheets: [{
    name: 'Payloads',
    headers: ['Comment', 'Expected Result', 'Type'],
    rows: [{ Comment: '<script>alert(1)</script>', 'Expected Result': 'Rejected', Type: 'negative' }],
  }],
  mapping: { bindings: [{ sheet: 'Payloads', module: 'Feedback', moduleKey: 'Feedback', purpose: 'feedback comment payloads', scenarioName: 'Feedback comment', columnToField: { comment: 'Comment' }, expectedColumn: 'Expected Result', rowClassColumn: 'Type' }] },
};
const genericSecurity = cp.buildCoveragePlanManifest({
  requirements: [{ id: 'US-FEEDBACK', title: 'User can submit feedback comment', moduleHint: 'Feedback', content: 'User can submit feedback comment' }],
  testData: securityData,
  calibrationAtlas: { capabilities: [] },
  moduleScope: 'Feedback',
});
assert(!genericSecurity.items.some((i) => i.type === cp.ITEM_TYPES.DATA_BOUND && i.required), 'XSS row does not force DATA_BOUND without security story terms');
const explicitSecurity = cp.buildCoveragePlanManifest({
  requirements: [{ id: 'US-FEEDBACK-SEC', title: 'Security rejects XSS script payload injection in feedback comment', moduleHint: 'Feedback', content: 'Security rejects XSS script payload injection in feedback comment' }],
  testData: securityData,
  calibrationAtlas: { capabilities: [] },
  moduleScope: 'Feedback',
});
assert(explicitSecurity.items.some((i) => i.type === cp.ITEM_TYPES.DATA_BOUND && i.required && i.dataSource.rowSelector === 'negative'), 'XSS row links when row evidence and story security terms both exist');

const validationData = {
  sheets: [{
    name: 'FormValidation',
    headers: ['Email', 'Expected Result', 'Type'],
    rows: [{ Email: 'bad-email', 'Expected Result': 'Invalid email required', Type: 'negative' }],
  }],
  mapping: { bindings: [{ sheet: 'FormValidation', module: 'Registration', moduleKey: 'Registration', purpose: 'registration form validation email', scenarioName: 'Registration form', columnToField: { email: 'Email' }, expectedColumn: 'Expected Result', rowClassColumn: 'Type' }] },
};
const genericValidation = cp.buildCoveragePlanManifest({
  requirements: [{ id: 'US-REGISTER', title: 'User can register account', moduleHint: 'Registration', content: 'User can register account' }],
  testData: validationData,
  calibrationAtlas: { capabilities: [] },
  moduleScope: 'Registration',
});
assert(!genericValidation.items.some((i) => i.type === cp.ITEM_TYPES.DATA_BOUND && i.required), 'validation row does not force DATA_BOUND without validation/form story context');
const explicitValidation = cp.buildCoveragePlanManifest({
  requirements: [{ id: 'US-REGISTER-VALIDATION', title: 'Registration form validation shows error for invalid email', moduleHint: 'Registration', content: 'Registration form validation shows error for invalid email' }],
  testData: validationData,
  calibrationAtlas: { capabilities: [] },
  moduleScope: 'Registration',
});
assert(explicitValidation.items.some((i) => i.type === cp.ITEM_TYPES.DATA_BOUND && i.required && i.dataSource.rowSelector === 'negative'), 'validation rows link only with form/validation story context');

console.log('\n[3] Atlas and validator gates');
const missingAtlasManifest = cp.buildCoveragePlanManifest({
  requirements: [{ id: 'US-BILLING', title: 'Billing invoice export', moduleHint: 'Billing', content: 'Billing invoice export must be available.' }],
  testData: null,
  calibrationAtlas: atlas,
});
assert(missingAtlasManifest.items.some((i) => i.type === cp.ITEM_TYPES.MISSING_CAPABILITY && i.required), 'missing atlas capability becomes required MISSING_CAPABILITY');

const missingRequired = cp.validateCoveragePlan({ manifest: loginManifest, scenarios: [], testData: loginTestData });
assert(!missingRequired.ok && missingRequired.findings.some((f) => f.code === 'coverage_required_missing'), 'missing required item fails validation');

const invented = cp.validateCoveragePlan({
  manifest: loginManifest,
  scenarios: [{ name: 'Bad', cases: [{ name: 'Invented ref', coverageRefs: ['cov::fake'], steps: [] }] }],
  testData: loginTestData,
});
assert(!invented.ok && invented.findings.some((f) => f.code === 'coverage_ref_invented'), 'invented coverageRefs fail validation');

const missingBinding = cp.validateCoveragePlan({
  manifest: loginManifest,
  scenarios: [{ name: 'Bad', cases: [{ name: 'Ref without binding', coverageRefs: [loginBound.manifestItemId], steps: [] }] }],
  testData: loginTestData,
});
assert(!missingBinding.ok && missingBinding.findings.some((f) => f.code === 'coverage_data_binding_missing'), 'DATA_BOUND coverageRef without dataBinding fails validation');

const wrongSheet = cp.validateCoveragePlan({
  manifest: loginManifest,
  scenarios: [{ name: 'Bad', cases: [{ name: 'Wrong sheet', coverageRefs: [loginBound.manifestItemId], dataBinding: { sheet: 'Other' }, steps: [] }] }],
  testData: loginTestData,
});
assert(!wrongSheet.ok && wrongSheet.findings.some((f) => f.code === 'coverage_data_binding_wrong_sheet'), 'wrong sheet fails validation');

const explicitValidationItem = item(explicitValidation, (i) => i.type === cp.ITEM_TYPES.DATA_BOUND);
const wrongRowSelector = cp.validateCoveragePlan({
  manifest: explicitValidation,
  scenarios: [{ name: 'Bad', cases: [{ name: 'Wrong row selector', coverageRefs: [explicitValidationItem.manifestItemId], dataBinding: { sheet: 'FormValidation', rowSelector: 'positive' }, steps: [] }] }],
  testData: validationData,
});
assert(!wrongRowSelector.ok && wrongRowSelector.findings.some((f) => f.code === 'coverage_data_binding_wrong_row_selector'), 'wrong required row selector fails validation');

const rawLiteral = cp.validateCoveragePlan({
  manifest: loginManifest,
  scenarios: [{
    name: 'Bad',
    cases: [{
      name: 'Hardcoded admin123',
      coverageRefs: [loginBound.manifestItemId],
      dataBinding: { sheet: 'LoginData' },
      steps: [{ order: 1, action: 'Type', value: 'admin123' }],
    }],
  }],
  testData: loginTestData,
});
assert(!rawLiteral.ok && rawLiteral.findings.some((f) => f.code === 'coverage_workbook_literal_leak'), 'raw workbook values fail validation for data-bound cases');

const loginOnlyManifest = cp.buildCoveragePlanManifest({
  requirements: [{
    id: 'US-AUTH-LOGIN',
    title: 'Admin can sign in with username and password credentials',
    moduleHint: 'Authentication',
    content: 'Admin can sign in with username and password credentials and see the expected dashboard result.',
  }],
  testData: loginTestData,
  calibrationAtlas: atlas,
});
const loginOnlyBound = item(loginOnlyManifest, (i) => i.type === cp.ITEM_TYPES.DATA_BOUND && i.dataSource && i.dataSource.sheet === 'LoginData');
const autoRepairInput = [{
  name: 'Bad',
  cases: [{
    name: 'Hardcoded admin123',
    coverageRefs: [loginOnlyBound.manifestItemId, 'cov::invented'],
    dataBinding: { sheet: 'Other', rowSelector: 'positive', status: 'incomplete' },
    steps: [
      { order: 1, action: 'Type', value: 'Admin' },
      { order: 2, action: 'Type', value: 'admin123' },
      { order: 3, action: 'Verify', expected: 'Dashboard' },
    ],
  }],
}];
const autoRepair = cp.repairCoveragePlanScenarios({ manifest: loginOnlyManifest, scenarios: autoRepairInput, testData: loginTestData });
const autoRepairValidation = cp.validateCoveragePlan({ manifest: loginOnlyManifest, scenarios: autoRepair.scenarios, testData: loginTestData });
assert(autoRepairValidation.ok, 'auto-repair converts bad coverage refs/bindings/literals into a valid data-bound case');
assert(autoRepair.repairs.invalidRefsRemoved === 1 && autoRepair.repairs.dataBindingsRepaired === 1 && autoRepair.repairs.literalRewrites >= 3, 'auto-repair records removed refs, binding repair, and literal rewrites');
assert(JSON.stringify(autoRepair.scenarios).includes('{{password}}') && !JSON.stringify(autoRepair.scenarios).includes('admin123'), 'auto-repair replaces workbook values with placeholders');

const synthesized = cp.synthesizeMissingCoverage({ missingItems: missingRequired.missingRequired });
const repaired = cp.validateCoveragePlan({ manifest: loginManifest, scenarios: synthesized, testData: loginTestData });
assert(repaired.ok, 'deterministic synthesis can satisfy missing required coverage');
const prompt = cp.buildAppendOnlyRepairPrompt({ manifest: loginManifest, acceptedRegistry: [{ name: 'Frozen', cases: [] }], missingItems: missingRequired.missingRequired });
assert(/Accepted scenarios are frozen/.test(prompt) && /Generate ONLY new scenarios/.test(prompt), 'repair prompt is append-only');
assert(/COVERAGE PLAN CONTRACT/.test(cp.renderCoveragePlanBlock(loginManifest)) && /coverageRefs/.test(cp.renderCoveragePlanBlock(loginManifest)), 'coverage contract block is renderable');

console.log('\n[4] Source trigger-chain checks');
const scenariosRoute = read('server/routes/scenarios.js');
const agentsRoute = read('server/routes/agents.js');
const architectSrc = read('server/services/agents/architect.js');
const tccSrc = read('server/services/testCaseContract.js');
const schema = read('prisma/schema.prisma');
const migration = read('prisma/migrations/20260625000000_add_generation_coverage_plan/migration.sql');

assert(/coveragePlanner\.buildCoveragePlanManifest/.test(scenariosRoute) && /coveragePlan,\s*\n\s*\}\);/.test(scenariosRoute), 'scenarios.js builds a manifest and passes coveragePlan into architect.run');
assert(/finalizeCoverage\(\{[\s\S]*manifest: coveragePlan[\s\S]*result\.scenarios = coverageResult\.scenarios/.test(scenariosRoute), 'full generation validates/repairs in memory before persistence');
assert(/repairCoveragePlanScenarios/.test(scenariosRoute), 'full generation auto-repairs residual coverage/data-binding defects before final validation');
assert(/sliceCoverageManifestForScenario/.test(scenariosRoute) && /coverageSummary/.test(scenariosRoute), 'single regeneration slices coverage and returns coverageSummary');
assert(/appendExistingCoverageRefs/.test(scenariosRoute) && /existingCoverageRefs: appendExistingCoverageRefs/.test(scenariosRoute), 'append mode counts existing accepted coverageRefs before planning');
assert(/sliceCoverageManifestForAppend/.test(scenariosRoute) && /mode: 'append_request'/.test(scenariosRoute), 'append mode enforces only the requested coverage slice');
assert(/coveragePlanner\.buildCoveragePlanManifest/.test(agentsRoute) && /finalizeAgentCoverage/.test(agentsRoute), 'agents.js all-in-one path uses the coverage planner');
assert(/coveragePlanner\.renderCoveragePlanBlock\(coveragePlan\)/.test(architectSrc), 'architect prompt includes the Coverage Plan Contract block');
assert(/coverageRefs/.test(tccSrc) && /coverageDisposition/.test(tccSrc) && /operationsJson/.test(tccSrc), 'persistCases stores coverageRefs and disposition inside operationsJson');
assert(/coveragePlanJson\s+String\?/.test(schema) && /coverageValidationJson\s+String\?/.test(schema) && /coverageRepairJson\s+String\?/.test(schema), 'ScenarioGeneration has nullable coverage JSON fields');
assert(/ADD COLUMN "coveragePlanJson"/.test(migration) && /ADD COLUMN "coverageValidationJson"/.test(migration) && /ADD COLUMN "coverageRepairJson"/.test(migration), 'migration SQL adds coverage JSON columns');

if (failures) {
  console.error(`\nverify_coverage_planner: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\nverify_coverage_planner: all checks passed');
