'use strict';

const registry = require('../server/services/codegen/adapters');
const contract = require('../server/services/codegen/adapters/frameworkAdapter');
const regressionCorpus = require('../server/services/codegen/adapters/regressionCorpus');
const replayExport = require('../server/services/codegen/replayExport');

let fail = 0;
function ok(cond, msg) {
  if (!cond) {
    fail += 1;
    console.error('  FAIL:', msg);
  } else {
    console.log('  ok:', msg);
  }
}

function envelopeFor(ir) {
  return { schema: 'qaai/replay-ir', complete: true, emitterVersion: 'guard', ir };
}

function mkResult(overrides = {}) {
  const corpus = regressionCorpus.forAdapter('selenium-reference')[0];
  return {
    runResultId: 'RR-SEL-POM-1',
    runId: 'RUN-SEL-POM',
    testCaseId: 'TC-SEL-POM',
    status: 'pass',
    caseName: 'Valid login',
    moduleName: 'Authentication',
    scenarioId: null,
    scenarioName: null,
    envelope: envelopeFor(JSON.parse(JSON.stringify(corpus.replayIR))),
    ...overrides,
  };
}

console.log('\n[1] selenium-pom adapter is registered and contract-valid');
const adapter = registry.getAdapter('selenium-pom');
ok(!!adapter, 'registry exposes selenium-pom');
if (adapter) {
  const validation = contract.validateAdapter(adapter);
  ok(validation.valid, 'selenium-pom satisfies the frozen FrameworkAdapter contract');
}

console.log('\n[2] compile emits Selenium POM layers, not a flat replay-only class');
{
  const result = replayExport.compileResults({ adapter, results: [mkResult()] });
  ok(result.admitted.length === 1 && result.blocked.length === 0, 'valid ReplayIR is admitted');
  const admitted = result.admitted[0];
  ok(/^src\/test\/java\/com\/qaai\/pom\/tests\/.+Test\.java$/.test(admitted.filePath), 'test class lands under com/qaai/pom/tests');
  const extra = admitted.extraFiles || {};
  ok(Object.keys(extra).some((p) => /^src\/main\/java\/com\/qaai\/pom\/locators\/.+Locators\.java$/.test(p)), 'locator class emitted under com/qaai/pom/locators');
  ok(Object.keys(extra).some((p) => /^src\/main\/java\/com\/qaai\/pom\/pages\/.+Page\.java$/.test(p)), 'page class emitted under com/qaai/pom/pages');
  ok(/extends BaseTest/.test(admitted.content), 'test extends shared BaseTest');
  ok(/new \w+Page\(driver\)/.test(admitted.content), 'test instantiates the page object');
  ok(/page\.fill\w+\(/.test(admitted.content) && /page\.click\w+\(/.test(admitted.content), 'test calls page-object action methods');
  ok(!/LocatorResolver\.resolve/.test(admitted.content), 'test file has no inline locator resolution');
  ok(/@Test\(groups = \{/.test(admitted.content), 'test method carries TestNG group metadata');
}

console.log('\n[2b] Selenium POM negative assertions treat absent as hidden');
{
  const r = mkResult();
  const firstResolve = r.envelope.ir.steps.find((s) => s.op === 'resolve' && s.as);
  r.envelope.ir.steps.push({
    op: 'assert',
    target: firstResolve.as,
    channel: 'FORBIDDEN_ROLE',
    expected: firstResolve.as,
    contractRef: 'ASN-FORBIDDEN',
    liveOutcome: 'matched',
  });
  const result = replayExport.compileResults({ adapter, results: [r] });
  ok(result.admitted.length === 1, 'forbidden-role ReplayIR remains admitted');
  const admitted = result.admitted[0];
  const pageFile = Object.values(admitted.extraFiles || {}).find((text) => /class\s+\w+Page/.test(text)) || '';
  ok(/IsAbsentOrHidden\(\)/.test(pageFile), 'page object exposes absent-or-hidden helper');
  ok(/Assert\.assertTrue\(page\.\w+IsAbsentOrHidden\(\)/.test(admitted.content), 'test asserts hidden through page-object helper');
}

console.log('\n[3] assembled package includes support, tests, pages, locators, and POM TestNG discovery');
{
  const result = replayExport.compileResults({ adapter, results: [mkResult()] });
  const files = adapter.assemblePackage({ admitted: result.admitted, envVars: replayExport.collectEnvVars([mkResult().envelope]) });
  ok(!!files['pom.xml'], 'Maven pom.xml included');
  ok(/<package name="com\.qaai\.pom\.tests"\/>/.test(files['testng.xml']), 'testng.xml discovers Selenium POM tests');
  ok(!!files['src/test/java/com/qaai/replayir/BaseTest.java'], 'shared BaseTest included');
  ok(Object.keys(files).some((p) => /^src\/main\/java\/com\/qaai\/pom\/pages\/.+Page\.java$/.test(p)), 'page class included in final package');
  ok(Object.keys(files).some((p) => /^src\/main\/java\/com\/qaai\/pom\/locators\/.+Locators\.java$/.test(p)), 'locator class included in final package');
  ok(Object.keys(files).some((p) => /^src\/test\/java\/com\/qaai\/pom\/tests\/.+Test\.java$/.test(p)), 'test class included in final package');
}

console.log('\n[4] role-only candidates are rejected instead of generating ambiguous Selenium locators');
{
  const r = mkResult();
  const resolve = r.envelope.ir.steps.find((s) => s.op === 'resolve');
  resolve.candidates = [{ strategy: 'role', role: 'textbox' }];
  const result = replayExport.compileResults({ adapter, results: [r] });
  ok(result.admitted.length === 0, 'role-only locator is not admitted');
  ok(result.blocked[0] && result.blocked[0].code === 'selenium_locator_unmappable', 'role-only locator blocks as selenium_locator_unmappable');
}

console.log('\n[5] package validation is invoked for selenium-pom');
{
  (async () => {
    const result = replayExport.compileResults({ adapter, results: [mkResult()] });
    const files = adapter.assemblePackage({ admitted: result.admitted, envVars: replayExport.collectEnvVars([mkResult().envelope]) });
    const validation = await replayExport.validateAssembled({ adapterId: 'selenium-pom', files });
    ok(validation.checked === true, 'validation checked=true');
    ok(validation.skipped !== true, 'validation not marked skipped');
    ok(Array.isArray(validation.commands) && validation.commands.some((c) => c.cmd === 'mvn -o -q -DskipTests test-compile'), 'Maven test-compile command executed');
    if (validation.errorCount > 0) {
      ok(false, `validation has ${validation.errorCount} error(s): ${validation.findings.map((f) => f.rule).join(', ')}`);
    }
    if (fail) {
      console.error(`\n${fail} check(s) FAILED`);
      process.exit(1);
    }
    console.log('\nverify_selenium_pom: all checks passed');
  })().catch((err) => {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
