'use strict';
/**
 * Guard for P8 parity lane wiring. Pure: no browser, no DB, no Maven.
 *
 * The harness and Enterprise Mode must agree on the canonical report filename
 * for every export adapter. Otherwise an Enterprise export can read stale proof
 * from another framework and certify the wrong package.
 */

const fs = require('fs');
const path = require('path');
const enterpriseMode = require('../server/services/enterpriseMode');

let failures = 0;
const ok = (m) => console.log('  PASS  ' + m);
const bad = (m, d) => { console.log('  FAIL  ' + m + (d ? '  - ' + d : '')); failures++; };
const assert = (cond, m, d) => (cond ? ok(m) : bad(m, d));
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

console.log('\n[1] canonical report names are unique for Selenium lanes');
{
  const names = {
    seleniumReference: enterpriseMode.reportNameForFramework('selenium-reference'),
    seleniumPom: enterpriseMode.reportNameForFramework('selenium-pom'),
    seleniumBdd: enterpriseMode.reportNameForFramework('selenium-bdd-reference'),
  };
  assert(names.seleniumReference === 'selenium-reference', 'selenium-reference writes selenium-reference.json');
  assert(names.seleniumPom === 'selenium-pom', 'selenium-pom writes selenium-pom.json');
  assert(names.seleniumBdd === 'selenium-bdd', 'selenium-bdd-reference writes selenium-bdd.json');
  assert(new Set(Object.values(names)).size === Object.values(names).length, 'Selenium P8 report names cannot collide');
}

console.log('\n[2] smoke harness uses Enterprise Mode naming, not CLI aliases');
{
  const smoke = read('scripts/_smoke_p8_parity.cjs');
  assert(/enterpriseMode\s*=\s*require\(['"]\.\.\/server\/services\/enterpriseMode['"]\)/.test(smoke), 'smoke harness imports enterpriseMode');
  assert(/REPORT_STEM\s*=\s*enterpriseMode\.reportNameForFramework\(ADAPTER_ID\)/.test(smoke), 'smoke harness derives report filename from adapter id');
  assert(!/path\.join\(REPORT_DIR,\s*`\$\{FRAMEWORK\}\.json`\)/.test(smoke), 'smoke harness does not write alias-named parity JSON');
  assert(/'selenium-pom':\s*'selenium-pom'/.test(smoke), 'selenium-pom adapter lane is routable');
  assert(/'selenium-bdd':\s*'selenium-bdd-reference'/.test(smoke), 'selenium-bdd alias routes to Selenium BDD adapter');
  assert(/'selenium-bdd-reference':\s*'selenium-bdd-reference'/.test(smoke), 'selenium-bdd-reference adapter lane is routable');
}

console.log('\n[3] evidence bundle default frameworks include the certified Selenium outputs');
{
  const evidence = require('../server/services/evidenceBundle');
  assert(evidence.DEFAULT_FRAMEWORKS.includes('selenium-pom'), 'evidence bundle includes Selenium POM by default');
  assert(evidence.DEFAULT_FRAMEWORKS.includes('selenium-bdd-reference'), 'evidence bundle includes Selenium BDD by default');
  assert(evidence.parseFrameworks('selenium-java,selenium-bdd').join(',') === 'selenium-pom,selenium-bdd-reference', 'UI/project aliases normalize to certified Selenium adapters');
}

console.log('\n[4] generated Selenium shells avoid unnecessary remote JSON dependencies');
{
  const seleniumPom = read('server/services/codegen/adapters/seleniumReference.js');
  const seleniumBdd = read('server/services/codegen/adapters/seleniumBddReference.js');
  assert(!/jackson|ObjectMapper|TypeReference|com\.fasterxml/i.test(seleniumPom), 'Selenium POM shell has no Jackson dependency');
  assert(!/jackson|ObjectMapper|TypeReference|com\.fasterxml/i.test(seleniumBdd), 'Selenium BDD shell has no Jackson dependency');
  assert(/class Parser/.test(seleniumPom) && /Files\.readString/.test(seleniumPom), 'Selenium POM DataReader is JDK-only');
  assert(/WebDriverWait/.test(seleniumPom) && /seesText\(String text\)[\s\S]*Duration\.ofSeconds\(8\)/.test(seleniumPom), 'Selenium POM text assertions auto-wait');
  assert(/WebDriverWait/.test(seleniumBdd) && /seesText\(String text\)[\s\S]*Duration\.ofSeconds\(8\)/.test(seleniumBdd), 'Selenium BDD text assertions auto-wait');
  assert(/urlMatchesNow/.test(seleniumPom) && /urlMatchesNow/.test(seleniumBdd), 'Selenium URL assertions use a bounded wait helper');
}

console.log('\n[5] Selenium POM Java source sets match imports');
{
  const seleniumPom = require('../server/services/codegen/adapters/seleniumPom');
  const files = seleniumPom.assemblePackage({ admitted: [], envVars: [] });
  assert(!!files['src/main/java/com/qaai/replayir/LocatorCandidate.java'], 'LocatorCandidate is emitted in main scope for page objects');
  assert(!!files['src/main/java/com/qaai/replayir/LocatorResolver.java'], 'LocatorResolver is emitted in main scope for page objects');
  assert(!files['src/test/java/com/qaai/replayir/LocatorCandidate.java'], 'LocatorCandidate is not duplicated in test scope');
  assert(!files['src/test/java/com/qaai/replayir/LocatorResolver.java'], 'LocatorResolver is not duplicated in test scope');
  assert(!!files['src/test/java/com/qaai/replayir/BaseTest.java'], 'BaseTest remains test scoped');
  assert(!!files['src/test/java/com/qaai/replayir/DataReader.java'], 'DataReader remains test scoped');
}

console.log('\n[6] Selenium BDD Java source sets match imports');
{
  const seleniumBdd = require('../server/services/codegen/adapters/seleniumBddReference');
  const files = seleniumBdd.assemblePackage({ admitted: [], locators: new Map(), envVars: [] });
  assert(!!files['src/main/java/com/qaai/replayir/LocatorCandidate.java'], 'BDD LocatorCandidate is emitted in main scope');
  assert(!!files['src/main/java/com/qaai/replayir/LocatorResolver.java'], 'BDD LocatorResolver is emitted in main scope');
  assert(!files['src/test/java/com/qaai/replayir/LocatorCandidate.java'], 'BDD LocatorCandidate is not duplicated in test scope');
  assert(!files['src/test/java/com/qaai/replayir/LocatorResolver.java'], 'BDD LocatorResolver is not duplicated in test scope');
  assert(!!files['src/main/java/com/qaai/bdd/BddWorld.java'], 'BDD world remains main scoped');
  assert(!!files['src/test/java/com/qaai/steps/ReplayIrSteps.java'], 'BDD step definitions remain test scoped');
}

console.log(`\n${failures === 0 ? 'PASS - P8 parity lanes: Selenium POM and Selenium BDD have canonical, non-colliding certification reports' : 'FAIL - ' + failures + ' check(s) failed'}\n`);
process.exit(failures === 0 ? 0 : 1);
