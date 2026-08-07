import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const frameworkAdapter = require('../../server/services/codegen/adapters/frameworkAdapter');
const seleniumReference = require('../../server/services/codegen/adapters/seleniumReference');
const seleniumPom = require('../../server/services/codegen/adapters/seleniumPom');

function replayIr(caseId) {
  return {
    caseId,
    title: `Execute ${caseId}`,
    authProfile: { id: 'existing-session', strategy: 'existing_session' },
    steps: [{ op: 'act', action: 'navigate', url: 'https://example.test/start' }],
    verdict: { status: 'pass', perAssertionOutcomes: [] },
  };
}

function testSource(adapter, opts) {
  const compiled = frameworkAdapter.compileReplayIR(adapter, replayIr(opts.testCaseId), opts);
  return compiled.files[compiled.layout.testFile];
}

describe('Selenium dependency browser-session lifecycle', () => {
  it.each([
    ['Selenium reference', seleniumReference],
    ['Selenium POM', seleniumPom],
  ])('%s emits explicit lifecycle overrides for root, middle, last, and independent cases', (_name, adapter) => {
    const root = testSource(adapter, {
      testCaseId: 'TC-1',
      preserveSessionForDependents: true,
      continueSession: false,
    });
    const middle = testSource(adapter, {
      testCaseId: 'TC-2',
      dependsOn: ['TC-1'],
      continueSession: true,
      preserveSessionForDependents: true,
    });
    const last = testSource(adapter, {
      testCaseId: 'TC-3',
      dependsOn: ['TC-2'],
      continueSession: true,
      preserveSessionForDependents: false,
    });
    const independent = testSource(adapter, { testCaseId: 'standalone' });

    expect(root).toContain('protected boolean continueSession() { return false; }');
    expect(root).toContain('protected boolean preserveSessionForDependents() { return true; }');
    expect(middle).toContain('protected boolean continueSession() { return true; }');
    expect(middle).toContain('protected boolean preserveSessionForDependents() { return true; }');
    expect(last).toContain('protected boolean continueSession() { return true; }');
    expect(last).toContain('protected boolean preserveSessionForDependents() { return false; }');
    expect(independent).toContain('protected boolean continueSession() { return false; }');
    expect(independent).toContain('protected boolean preserveSessionForDependents() { return false; }');
  });

  it('BaseTest hands the exact dependency driver forward and keeps independent tests isolated', () => {
    const files = seleniumReference.assemblePackage({ admitted: [], envVars: [] });
    const baseTest = files['src/test/java/com/qaai/replayir/BaseTest.java'];

    expect(baseTest).toContain('private static final Map<String, WebDriver> PRESERVED_SESSIONS');
    expect(baseTest).toContain('public void setUp(Method testMethod)');
    expect(baseTest).toContain('driver = takeDependencySession(testMethod);');
    expect(baseTest).toContain('driver = createDriver();');
    expect(baseTest).toContain('PRESERVED_SESSIONS.put(currentSessionKey, driver)');
    expect(baseTest).toContain('PRESERVED_SESSIONS.remove(dependencies[index])');
    expect(baseTest).toContain('closeQuietly(driver);');
    expect(baseTest).toContain('public void closeUnclaimedDependencySessions()');
    expect(baseTest).not.toContain('driver.get(');
  });

  it('Selenium POM packages the same shared BaseTest implementation', () => {
    const files = seleniumPom.assemblePackage({ admitted: [], envVars: [] });
    const baseTest = files['src/test/java/com/qaai/replayir/BaseTest.java'];

    expect(baseTest).toContain('protected boolean continueSession()');
    expect(baseTest).toContain('protected boolean preserveSessionForDependents()');
    expect(baseTest).toContain('driver = takeDependencySession(testMethod);');
  });
});
