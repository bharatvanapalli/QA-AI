import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const replayIrBdd = require('../../server/services/codegen/adapters/replayIrBdd');
const seleniumBdd = require('../../server/services/codegen/adapters/seleniumBddReference');

function scopedResult({ runResultId, testCaseId, selector }) {
  return {
    runId: `RUN-${runResultId}`,
    runResultId,
    testCaseId,
    caseName: 'Edit customer profile',
    moduleName: 'Customer administration',
    status: 'pass',
    envelope: {
      complete: true,
      ir: {
        version: 1,
        caseId: testCaseId,
        authProfile: { id: 'none', strategy: 'none' },
        steps: [
          {
            op: 'resolve',
            as: 'el1',
            candidates: [
              { strategy: 'role', role: 'button', name: 'Save profile' },
              { strategy: 'css', selector },
            ],
          },
          { op: 'act', action: 'click', target: 'el1' },
          { op: 'assert', channel: 'UI_TEXT', expected: 'Profile saved', contractRef: 'profile-saved' },
        ],
        verdict: { status: 'pass', perAssertionOutcomes: [] },
      },
    },
  };
}

function fallbackIr() {
  return {
    version: 1,
    caseId: 'INTERNAL-CASE-ID',
    authProfile: { id: 'none', strategy: 'none' },
    steps: [
      {
        op: 'resolve',
        as: 'target',
        candidates: [{ strategy: 'role', role: 'button', name: 'Account tools' }],
        guessedLocator: true,
        locatorProvenance: { kind: 'qaai_guessed_locator' },
      },
      { op: 'act', action: 'scrollAndActivate', target: 'target' },
      { op: 'waitFor', condition: { kind: 'interactive', target: 'target', timeoutMs: 4321 } },
      { op: 'assert', channel: 'ARIA_STATE', target: 'target', expected: 'expanded', contractRef: 'account-tools-expanded' },
    ],
    verdict: { status: 'pass', perAssertionOutcomes: [] },
  };
}

describe('BDD semantic output fidelity', () => {
  it('uses semantic Playwright-BDD names and isolates same-label locators by scenario', () => {
    const firstId = 'RR-INTERNAL-A9F3';
    const firstCaseId = 'TC-INTERNAL-4491';
    const secondId = 'RR-INTERNAL-B7D2';
    const secondCaseId = 'TC-INTERNAL-9982';
    const compiled = replayIrBdd.compileResults({
      results: [
        scopedResult({ runResultId: firstId, testCaseId: firstCaseId, selector: '#primary-save' }),
        scopedResult({ runResultId: secondId, testCaseId: secondCaseId, selector: '#secondary-save' }),
      ],
    });

    expect(compiled.blocked).toEqual([]);
    expect(compiled.admitted.map((item) => item.featurePath)).toEqual([
      'features/edit-customer-profile.feature',
      'features/edit-customer-profile-2.feature',
    ]);
    expect(Object.keys(compiled.locators)).toEqual(['edit-customer-profile', 'edit-customer-profile-2']);
    expect(compiled.locators['edit-customer-profile']['Save profile']).toEqual(expect.arrayContaining([
      expect.objectContaining({ selector: '#primary-save' }),
    ]));
    expect(compiled.locators['edit-customer-profile-2']['Save profile']).toEqual(expect.arrayContaining([
      expect.objectContaining({ selector: '#secondary-save' }),
    ]));

    for (const feature of compiled.admitted.map((item) => item.featureContent)) {
      expect(feature).toContain('Feature: Edit customer profile');
      expect(feature).toContain('Given I use locator scope "edit-customer-profile');
      expect(feature).toContain('I click "Save profile"');
      expect(feature).not.toMatch(/@rr-|@tc-|RunResult|testCase|el1/);
      expect(feature).not.toContain(firstId);
      expect(feature).not.toContain(firstCaseId);
      expect(feature).not.toContain(secondId);
      expect(feature).not.toContain(secondCaseId);
    }
  });

  it('uses semantic Selenium-BDD names and isolates same-label locators by scenario', () => {
    const internalIds = ['RR-INTERNAL-A9F3', 'TC-INTERNAL-4491', 'RR-INTERNAL-B7D2', 'TC-INTERNAL-9982'];
    const compiled = seleniumBdd.compileResults({
      results: [
        scopedResult({ runResultId: internalIds[0], testCaseId: internalIds[1], selector: '#primary-save' }),
        scopedResult({ runResultId: internalIds[2], testCaseId: internalIds[3], selector: '#secondary-save' }),
      ],
    });

    expect(compiled.blocked).toEqual([]);
    expect(compiled.admitted.map((item) => item.filePath)).toEqual([
      'src/test/resources/features/customer-administration/edit-customer-profile.feature',
      'src/test/resources/features/customer-administration/edit-customer-profile-2.feature',
    ]);
    expect([...compiled.locators.keys()]).toEqual(['edit-customer-profile', 'edit-customer-profile-2']);
    const files = seleniumBdd.assemblePackage({ admitted: compiled.admitted, locators: compiled.locators, envVars: [] });
    const catalog = Object.entries(files).find(([name]) => name.endsWith('/LocatorCatalog.java'))?.[1] || '';
    expect(catalog).toContain('edit-customer-profile::Save profile');
    expect(catalog).toContain('edit-customer-profile-2::Save profile');
    expect(catalog).toContain('#primary-save');
    expect(catalog).toContain('#secondary-save');

    for (const feature of compiled.admitted.map((item) => item.content)) {
      expect(feature).toContain('Scenario: Edit customer profile');
      expect(feature).toContain('Given I use locator scope "edit-customer-profile');
      expect(feature).not.toMatch(/@runResult-|RunResult|testCase|el1/);
      for (const internalId of internalIds) expect(feature).not.toContain(internalId);
    }
  });

  it('emits executable diagnostic fallbacks for unsupported authored Playwright-BDD variants', () => {
    const rendered = replayIrBdd.renderIr(fallbackIr());

    expect(rendered.block).toBeUndefined();
    expect(rendered.lines.map((line) => line.key)).toEqual(['fallbackAction', 'fallbackWait', 'fallbackAssert']);
    expect(rendered.comments.join('\n')).toContain('QAAI_GUESSED_LOCATOR');
    expect(rendered.comments.join('\n')).toContain('QAAI_FALLBACK');
    const glue = replayIrBdd.emitGlue();
    expect(glue).toContain('performAuthoredActionFallback');
    expect(glue).toContain('performAuthoredWaitFallback');
    expect(glue).toContain('performAuthoredAssertionFallback');
    expect(glue).not.toContain('@skip');

    const compiled = replayIrBdd.compileResults({
      results: [{
        runResultId: 'RR-INTERNAL-FALLBACK',
        testCaseId: 'TC-INTERNAL-FALLBACK',
        caseName: 'Use account tools',
        moduleName: 'Accounts',
        status: 'pass',
        envelope: { complete: true, ir: fallbackIr() },
      }],
    });
    expect(compiled.blocked).toEqual([]);
    expect(compiled.admitted[0].featureContent).toContain('QAAI_FALLBACK');
  });

  it('emits executable diagnostic fallbacks for unsupported authored Selenium-BDD variants', () => {
    const feature = seleniumBdd.renderFeature({
      runResultId: 'RR-INTERNAL-FALLBACK',
      testCaseId: 'TC-INTERNAL-FALLBACK',
      caseName: 'Use account tools',
      moduleName: 'Accounts',
      status: 'pass',
      envelope: { complete: true, ir: fallbackIr() },
    }, new Map());

    expect(feature).toContain('QAAI_GUESSED_LOCATOR');
    expect(feature).toContain('QAAI_FALLBACK');
    expect(feature).toContain('When I perform authored action "scrollAndActivate"');
    expect(feature).toContain('When I wait up to 4321 milliseconds for authored condition "interactive"');
    expect(feature).toContain('Then the authored assertion "ARIA_STATE"');
    expect(feature).not.toContain('@skip');
    expect(feature).not.toContain('RR-INTERNAL-FALLBACK');
    expect(feature).not.toContain('TC-INTERNAL-FALLBACK');

    const files = seleniumBdd.assemblePackage({ admitted: [], locators: new Map(), envVars: [] });
    const steps = Object.entries(files).find(([name]) => name.endsWith('/ReplayIrSteps.java'))?.[1] || '';
    expect(steps).toContain('performAuthoredActionFallback');
    expect(steps).toContain('waitForAuthoredConditionFallback');
    expect(steps).toContain('authoredAssertionFallback');
    expect(steps).not.toContain('@skip');

    const compiled = seleniumBdd.compileResults({
      results: [{
        runResultId: 'RR-INTERNAL-FALLBACK',
        testCaseId: 'TC-INTERNAL-FALLBACK',
        caseName: 'Use account tools',
        moduleName: 'Accounts',
        status: 'pass',
        envelope: { complete: true, ir: fallbackIr() },
      }],
    });
    expect(compiled.blocked).toEqual([]);
    expect(compiled.admitted[0].content).toContain('QAAI_FALLBACK');
  });

  it('turns empty locator evidence into an explicit semantic guessed locator in both BDD frameworks', () => {
    const ir = {
      version: 1,
      caseId: 'INTERNAL-EMPTY-LOCATOR',
      authProfile: { id: 'none', strategy: 'none' },
      steps: [
        { op: 'resolve', as: 'el9', candidates: [] },
        { op: 'act', action: 'click', target: 'el9' },
      ],
      verdict: { status: 'pass', perAssertionOutcomes: [] },
    };

    const playwright = replayIrBdd.renderIr(ir);
    expect(playwright.block).toBeUndefined();
    expect(playwright.lines.map((line) => line.text).join('\n')).toContain('I click "Clickable control"');
    expect(playwright.comments.join('\n')).toContain('QAAI_GUESSED_LOCATOR');
    expect(playwright.labels['Clickable control']).toEqual([
      expect.objectContaining({ strategy: 'role', role: 'button' }),
    ]);
    expect(JSON.stringify(playwright)).not.toContain('el9');

    const selenium = seleniumBdd.renderFeature({
      caseName: 'Open customer actions',
      moduleName: 'Customers',
      status: 'pass',
      envelope: { complete: true, ir },
    }, new Map());
    expect(selenium).toContain('I click "Clickable control"');
    expect(selenium).toContain('QAAI_GUESSED_LOCATOR');
    expect(selenium).not.toContain('el9');

    const result = {
      runResultId: 'RR-INTERNAL-EMPTY-LOCATOR',
      testCaseId: 'TC-INTERNAL-EMPTY-LOCATOR',
      caseName: 'Open customer actions',
      moduleName: 'Customers',
      status: 'pass',
      envelope: { complete: true, ir },
    };
    const playwrightCompiled = replayIrBdd.compileResults({ results: [result] });
    const seleniumCompiled = seleniumBdd.compileResults({ results: [result] });
    expect(playwrightCompiled.blocked).toEqual([]);
    expect(playwrightCompiled.admitted[0].featureContent).toContain('QAAI_GUESSED_LOCATOR');
    expect(seleniumCompiled.blocked).toEqual([]);
    expect(seleniumCompiled.admitted[0].content).toContain('QAAI_GUESSED_LOCATOR');
  });

});
