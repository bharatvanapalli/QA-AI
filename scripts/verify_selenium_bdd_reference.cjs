'use strict';

const bdd = require('../server/services/codegen/adapters/seleniumBddReference');
const replayExport = require('../server/services/codegen/replayExport');
const regressionCorpus = require('../server/services/codegen/adapters/regressionCorpus');

let fail = 0;
function ok(cond, msg) {
  if (!cond) {
    fail += 1;
    console.error('  FAIL:', msg);
  } else {
    console.log('  ok:', msg);
  }
}

function mkResult(overrides = {}) {
  const corpus = regressionCorpus.forAdapter('selenium-reference')[0];
  return {
    runResultId: 'RR-SEL-BDD-1',
    runId: 'RUN-SEL-BDD',
    testCaseId: 'TC-SEL-BDD',
    status: 'pass',
    caseName: 'Valid login',
    moduleName: 'Authentication',
    scenarioId: null,
    scenarioName: null,
    envelope: {
      schema: 'qaai/replay-ir',
      complete: true,
      emitterVersion: 'guard',
      ir: JSON.parse(JSON.stringify(corpus.replayIR)),
    },
    ...overrides,
  };
}

console.log('\n[1] Selenium BDD compiles ReplayIR into deterministic feature files');
{
  const result = bdd.compileResults({ results: [mkResult()] });
  ok(result.admitted.length === 1 && result.blocked.length === 0, 'valid ReplayIR is admitted');
  const feature = result.admitted[0].content;
  ok(/^Feature:/m.test(feature), 'feature has Feature header');
  ok(/Scenario: Valid login/.test(feature), 'feature has deterministic Scenario');
  ok(/When I fill "Username" with env "QAAI_USERNAME"/.test(feature), 'credential fill uses env name, not value');
  ok(/When I click "Login"/.test(feature), 'click action is represented');
  ok(/Then "Dashboard" should contain "Dashboard"/.test(feature), 'UI assertion is represented');
  ok(!/admin123/.test(feature), 'feature contains no secret literal');
}

console.log('\n[2] unsupported channels and role-only locators block honestly');
{
  const api = mkResult();
  api.envelope.ir.steps.push({ op: 'assert', contractRef: 'ASN-API', channel: 'API', expected: 'x' });
  const apiResult = bdd.compileResults({ results: [api] });
  ok(apiResult.admitted.length === 0, 'unsupported API assertion is not admitted');
  ok(apiResult.blocked[0] && apiResult.blocked[0].code === 'bdd_channel_unsupported', 'unsupported channel is blocked with exact code');

  const roleOnly = mkResult();
  const resolve = roleOnly.envelope.ir.steps.find((s) => s.op === 'resolve');
  resolve.candidates = [{ strategy: 'role', role: 'textbox' }];
  const roleResult = bdd.compileResults({ results: [roleOnly] });
  ok(roleResult.admitted.length === 0, 'role-only locator is not admitted');
  ok(roleResult.blocked[0] && roleResult.blocked[0].code === 'selenium_bdd_locator_unmappable', 'role-only locator blocks as selenium_bdd_locator_unmappable');
}

console.log('\n[3] package contains Cucumber-JVM runner, hooks, steps, support, and locator catalog');
{
  const result = bdd.compileResults({ results: [mkResult()] });
  const files = bdd.assemblePackage({ admitted: result.admitted, locators: result.locators, envVars: replayExport.collectEnvVars([mkResult().envelope]) });
  ok(!!files['pom.xml'] && /cucumber-java/.test(files['pom.xml']) && /cucumber-testng/.test(files['pom.xml']), 'pom.xml declares Cucumber-JVM dependencies');
  ok(!!files['testng.xml'] && /com\.qaai\.runner\.TestRunner/.test(files['testng.xml']), 'testng.xml points at the Cucumber TestNG runner');
  ok(!!files['src/test/java/com/qaai/runner/TestRunner.java'], 'TestRunner.java included');
  ok(!!files['src/test/java/com/qaai/steps/ReplayIrSteps.java'], 'ReplayIrSteps.java included');
  ok(!!files['src/test/java/com/qaai/steps/Hooks.java'], 'Hooks.java included');
  ok(!!files['src/main/java/com/qaai/bdd/LocatorCatalog.java'], 'LocatorCatalog.java included');
  ok(/LOCATORS\.put\("Username"/.test(files['src/main/java/com/qaai/bdd/LocatorCatalog.java']), 'locator catalog carries recorded candidates');
  ok(/private boolean absentOrHidden/.test(files['src/test/java/com/qaai/steps/ReplayIrSteps.java']), 'hidden step treats missing elements as hidden');
  ok(/Assert\.assertTrue\(absentOrHidden\(label\)/.test(files['src/test/java/com/qaai/steps/ReplayIrSteps.java']), 'hidden assertion uses absent-or-hidden helper');
}

console.log('\n[4] package validation is invoked for selenium-bdd-reference');
{
  (async () => {
    const result = bdd.compileResults({ results: [mkResult()] });
    const files = bdd.assemblePackage({ admitted: result.admitted, locators: result.locators, envVars: replayExport.collectEnvVars([mkResult().envelope]) });
    const validation = await replayExport.validateAssembled({ adapterId: 'selenium-bdd-reference', files });
    ok(validation.checked === true, 'validation checked=true');
    ok(validation.skipped !== true, 'validation not marked skipped');
    ok(Array.isArray(validation.commands) && validation.commands.some((c) => c.cmd === 'mvn -o -q -DskipTests test-compile'), 'Maven test-compile command executed');
    if (validation.errorCount > 0) ok(false, `validation has errors: ${validation.findings.map((f) => f.rule).join(', ')}`);
    if (fail) {
      console.error(`\n${fail} check(s) FAILED`);
      process.exit(1);
    }
    console.log('\nverify_selenium_bdd_reference: all checks passed');
  })().catch((err) => {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
