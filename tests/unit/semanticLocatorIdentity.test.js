import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const replayEmitter = require('../../server/services/codegen/replayEmitter');
const frameworkAdapter = require('../../server/services/codegen/adapters/frameworkAdapter');
const seleniumReference = require('../../server/services/codegen/adapters/seleniumReference');

describe('semantic locator identity', () => {
  it('emits deterministic semantic resolve refs with stable collision suffixes and preserves every action', () => {
    const emitted = replayEmitter.buildReplayIR({
      caseId: 'semantic-locator-case',
      title: 'Enter account details and continue',
      trail: [
        {
          tool: 'browser_fill_form',
          args: {
            fields: [
              { name: 'Email Address', type: 'textbox', value: 'first@example.test' },
              { name: 'Email Address', type: 'textbox', value: 'second@example.test' },
            ],
          },
        },
        { tool: 'browser_click', args: { element: 'Continue button', role: 'button' } },
        { tool: 'browser_click', args: { element: 'Continue button', role: 'button' } },
      ],
      declaredAssertions: [],
      assertionOutcomes: [],
      verdictStatus: 'pass',
    });

    const resolves = emitted.ir.steps.filter((step) => step.op === 'resolve');
    const acts = emitted.ir.steps.filter((step) => step.op === 'act' && step.target);

    expect(resolves.map((step) => step.as)).toEqual([
      'emailAddressField',
      'emailAddressField2',
      'continueButton',
      'continueButton2',
    ]);
    expect(acts.map((step) => step.target)).toEqual(resolves.map((step) => step.as));
    expect(acts.map((step) => step.action)).toEqual(['fill', 'fill', 'click', 'click']);
    expect(JSON.stringify(emitted.ir.steps)).not.toMatch(/\b(?:el|element|ref|node|target|field)[_-]?\d+\b/i);
  });

  it('rewrites internal and UUID refs to semantic Selenium variables without changing locators or guessed warnings', () => {
    const uuidRef = '8b6d6b31-caea-4e84-9f2d-4dc04fac7246';
    const replayIR = {
      caseId: 'semantic-selenium-case',
      title: 'Update user profile',
      authProfile: { id: 'authenticated-user', strategy: 'existing_session' },
      steps: [
        {
          op: 'resolve',
          as: 'el1',
          elementLabel: 'Email Address',
          candidates: [{ strategy: 'role', role: 'textbox', name: 'Email Address' }],
        },
        { op: 'act', action: 'fill', target: 'el1', valueRef: 'env:QAAI_EMAIL_ADDRESS' },
        {
          op: 'resolve',
          as: uuidRef,
          elementLabel: 'Continue',
          guessedLocator: true,
          locatorProvenance: { kind: 'qaai_guessed_locator' },
          candidates: [{ strategy: 'role', role: 'button', name: 'Continue' }],
        },
        { op: 'act', action: 'click', target: uuidRef },
        {
          op: 'resolve',
          as: 'node_3',
          elementLabel: 'Continue',
          guessedLocator: true,
          locatorProvenance: { kind: 'qaai_guessed_locator' },
          candidates: [{ strategy: 'role', role: 'button', name: 'Continue' }],
        },
        { op: 'act', action: 'click', target: 'node_3' },
        { op: 'waitFor', condition: { kind: 'visible', target: uuidRef, timeoutMs: 5000 } },
      ],
      verdict: { status: 'pass', perAssertionOutcomes: [] },
    };

    const compiled = frameworkAdapter.compileReplayIR(seleniumReference, replayIR);
    const source = compiled.files[compiled.layout.testFile];

    expect(source).toContain('WebElement emailAddressField = LocatorResolver.resolve');
    expect(source).toContain('emailAddressField.sendKeys(EnvReader.required("QAAI_EMAIL_ADDRESS"))');
    expect(source).toContain('WebElement continueButton = LocatorResolver.resolve');
    expect(source).toContain('WebElement SecondContinueButton = LocatorResolver.resolve');
    expect(source).toContain('ExpectedConditions.visibilityOf(continueButton)');
    expect(source).toContain('LocatorCandidate.role("textbox", "Email Address")');
    expect(source).toContain('LocatorCandidate.role("button", "Continue")');
    expect(source.match(/QAAI_GUESSED_LOCATOR/g)).toHaveLength(3);
    expect(source).toContain('continueButton.click();');
    expect(source).toContain('SecondContinueButton.click();');
    expect(source).not.toMatch(/continueButton\d+\.click\(\);/);
    expect(source).not.toContain('el1');
    expect(source).not.toContain('node_3');
    expect(source).not.toContain(uuidRef);
  });
});
