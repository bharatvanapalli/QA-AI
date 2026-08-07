import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const frameworkAdapter = require('../../server/services/codegen/adapters/frameworkAdapter');
const seleniumReference = require('../../server/services/codegen/adapters/seleniumReference');
const seleniumPom = require('../../server/services/codegen/adapters/seleniumPom');

function authoredIr() {
  return {
    caseId: 'selenium-continuation-contract',
    title: 'Preserve authored Selenium steps and diagnostics',
    authProfile: { id: 'existing-session', strategy: 'existing_session' },
    steps: [
      {
        op: 'resolve',
        as: 'saveControl',
        elementLabel: 'Save button',
        candidates: [{ strategy: 'xpath', selector: '//button[1]' }],
      },
      { op: 'act', action: 'click', target: 'saveControl' },
      { op: 'act', action: 'browserExtensionOperation', target: 'extensionControl', narration: 'Use extension control' },
      { op: 'waitFor', condition: { kind: 'interactive', target: 'statusPanel', timeoutMs: 4321 } },
      { op: 'assert', channel: 'UI_TEXT', target: 'saveControl', expected: 'Saved', contractRef: 'saved-message', criticality: 'should' },
      { op: 'assert', channel: 'API', expected: 'HTTP 201', contractRef: 'api-result', criticality: 'should' },
      { op: 'humanInput', disposition: 'manual_gate', field: 'securityApproval', criticality: 'should' },
      { op: 'act', action: 'navigate', url: 'https://example.test/next' },
      {
        op: 'assert',
        channel: 'UI_TEXT',
        expected: 'Dependency ready',
        contractRef: 'dependency-ready',
        criticality: 'must',
        failureBehavior: 'stop_descendants',
      },
    ],
    verdict: { status: 'needs_human', perAssertionOutcomes: [] },
  };
}

function verifiedSaveLocator() {
  const source = 'verified_dom_inspection';
  return {
    kind: 'playwright',
    verified: true,
    verificationSource: source,
    evidenceSource: source,
    expression: 'page.locator("#verified-save")',
    frameworkExpressions: {
      playwright: 'page.locator("#verified-save")',
      selenium: 'By.cssSelector("#verified-save")',
    },
    proof: { verified: true, sameElement: true, count: 1, source },
    domAtlas: { verifiedActions: [{ action: 'click', selector: '#verified-save' }] },
  };
}

describe('Selenium executable diagnostics and continuation parity', () => {
  it.each([
    ['reference', seleniumReference],
    ['POM', seleniumPom],
  ])('%s preserves authored order, guesses only locator gaps, and collects non-critical failures', (_name, adapter) => {
    const compiled = frameworkAdapter.compileReplayIR(adapter, authoredIr(), { adapterFindings: [] });
    const source = compiled.files[compiled.layout.testFile];
    const allSource = Object.values(compiled.files).join('\n');

    expect(allSource).toContain('QAAI_GUESSED_LOCATOR');
    expect(allSource).toContain('LocatorCandidate.role("button", "Save")');
    expect(allSource).toContain('LocatorCandidate.xpath("//button[1]")');
    expect(allSource.indexOf('LocatorCandidate.role("button", "Save")'))
      .toBeLessThan(allSource.indexOf('LocatorCandidate.xpath("//button[1]")'));
    expect(source).toContain('SoftAssert qaaiSoft = new SoftAssert();');
    expect(source).toContain('qaaiSoft.assertTrue');
    expect(source).toContain('qaaiSoft.fail');
    expect(source).toContain('qaaiSoft.assertAll();');
    expect(source).toContain('Assert.assertTrue');
    expect(source).toContain('QAAI_DIAGNOSTIC: Selenium');
    expect(source).not.toContain('SkipException');
    expect(source).not.toContain('Unsupported ReplayIR action:');
    expect(source).not.toContain('Unsupported ReplayIR wait condition:');
    expect(source.indexOf('browserExtensionOperation')).toBeLessThan(source.indexOf('interactive'));
    expect(source.indexOf('interactive')).toBeLessThan(source.indexOf('saved-message'));
    expect(source.indexOf('securityApproval')).toBeLessThan(source.indexOf('driver.get("https://example.test/next")'));
  });

  it.each([
    ['reference', seleniumReference],
    ['POM', seleniumPom],
  ])('%s emits exact verified locator evidence before any semantic fallback', (_name, adapter) => {
    const ir = authoredIr();
    ir.steps[0].actionLocator = verifiedSaveLocator();
    const compiled = frameworkAdapter.compileReplayIR(adapter, ir, { adapterFindings: [] });
    const allSource = Object.values(compiled.files).join('\n');

    expect(allSource).toContain('LocatorCandidate.css("#verified-save")');
    expect(allSource).not.toContain('LocatorCandidate.role("button", "Save")');
    expect(allSource).not.toContain('LocatorCandidate.xpath("//button[1]")');
  });

  it('wraps non-critical locator-backed assertions so resolution errors are collected', () => {
    const opts = {};
    const ir = authoredIr();
    seleniumPom.emitSetup(ir, opts);
    seleniumPom.emitLocatorResolver([{ strategy: 'role', role: 'status', name: 'Saved' }], { op: 'resolve', as: 'status' }, ir, opts);
    const emitted = seleniumPom.emitAssertion({
      op: 'assert',
      channel: 'UI_TEXT',
      target: 'status',
      expected: 'Saved',
      contractRef: 'status-text',
      criticality: 'should',
    }, ir, opts);

    expect(emitted).toContain('try {');
    expect(emitted).toContain('catch (RuntimeException qaaiAssertionError)');
    expect(emitted).toContain('qaaiSoft.fail(qaaiAssertionMessage)');
  });
});
