import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const replayIrBdd = require('../../server/services/codegen/adapters/replayIrBdd');
const seleniumBdd = require('../../server/services/codegen/adapters/seleniumBddReference');

function incompleteBlockedResult() {
  return {
    runId: 'RUN-BDD-DIAGNOSTIC',
    runResultId: 'RR-BDD-DIAGNOSTIC',
    testCaseId: 'TC-BDD-DIAGNOSTIC',
    caseName: 'Continue through incomplete source evidence',
    moduleName: 'account',
    status: 'blocked',
    blockedReason: 'source_browser_interrupted',
    operationPlan: {
      status: 'incomplete',
      operations: [],
      dropped: [{ operation: 'unavailableAction', reason: 'source_browser_interrupted' }],
    },
    envelope: {
      complete: false,
      gaps: [{ code: 'source_browser_interrupted', detail: 'The live source run ended early.' }],
      ir: {
        version: 1,
        caseId: 'TC-BDD-DIAGNOSTIC',
        authProfile: { id: 'none', strategy: 'none' },
        steps: [
          {
            op: 'resolve',
            as: 'continueButton',
            candidates: [{ strategy: 'role', role: 'button', name: 'Continue' }],
            guessedLocator: true,
            locatorProvenance: { kind: 'qaai_guessed_locator' },
          },
          {
            op: 'waitFor',
            condition: { kind: 'visible', target: 'continueButton', timeoutMs: 7_500 },
          },
          { op: 'act', action: 'click', target: 'continueButton' },
          {
            op: 'assert',
            channel: 'UI_TEXT',
            expected: 'Welcome',
            contractRef: 'assert-welcome',
          },
        ],
        verdict: { status: 'blocked', perAssertionOutcomes: [] },
      },
    },
  };
}

describe('BDD source diagnostics remain executable', () => {
  it('emits an enabled Playwright-BDD scenario for complete:false plus blocked source status', () => {
    const compiled = replayIrBdd.compileResults({ results: [incompleteBlockedResult()] });

    expect(compiled.blocked).toEqual([]);
    expect(compiled.admitted).toHaveLength(1);
    expect(compiled.admitted[0]).toMatchObject({
      executionEnabled: true,
      status: 'blocked',
      bdd: { enabled: true, exportable: true },
    });
    expect(compiled.manifestEntries[0].sourceDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'replayir_incomplete_diagnostic', severity: 'warning' }),
      expect.objectContaining({ code: 'source_verdict_diagnostic', severity: 'warning' }),
      expect.objectContaining({ code: 'bdd_operation_plan_incomplete_diagnostic', severity: 'warning' }),
    ]));

    const feature = compiled.admitted[0].featureContent;
    expect(feature).not.toContain('@skip');
    expect(feature).toContain('@source-diagnostic');
    expect(feature).toContain('@replayir-incomplete-diagnostic');
    expect(feature).toContain('QAAI source diagnostic: ReplayIR was marked complete:false');
    expect(feature).toContain('QAAI_GUESSED_LOCATOR');
    expect(feature).toContain('wait up to 7500 milliseconds');
    expect(feature).toContain('I click "Continue"');
    expect(feature).toContain('I should see "Welcome"');

    const files = replayIrBdd.assemblePackage({ admitted: compiled.admitted, locators: compiled.locators, envVars: [] });
    expect(files['README.md']).not.toContain('is `@skip`');
  });

  it('emits an enabled Selenium-BDD scenario and an unfiltered runner for the same diagnostics', () => {
    const compiled = seleniumBdd.compileResults({ results: [incompleteBlockedResult()] });

    expect(compiled.blocked).toEqual([]);
    expect(compiled.admitted).toHaveLength(1);
    expect(compiled.admitted[0]).toMatchObject({
      executionEnabled: true,
      status: 'blocked',
      bdd: { enabled: true, framework: 'selenium-bdd' },
    });
    expect(compiled.manifestEntries[0].sourceDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'replayir_incomplete_diagnostic', severity: 'warning' }),
      expect.objectContaining({ code: 'source_verdict_diagnostic', severity: 'warning' }),
    ]));

    const feature = compiled.admitted[0].content;
    expect(feature).not.toContain('@skip');
    expect(feature).toContain('@source-diagnostic');
    expect(feature).toContain('@replayir-incomplete-diagnostic');
    expect(feature).toContain('QAAI source diagnostic: ReplayIR was marked complete:false');
    expect(feature).toContain('QAAI_GUESSED_LOCATOR');
    expect(feature).toContain('wait up to 7500 milliseconds');
    expect(feature).toContain('I click "Continue"');
    expect(feature).toContain('I should see "Welcome"');

    const files = seleniumBdd.assemblePackage({ admitted: compiled.admitted, locators: compiled.locators, envVars: [] });
    const runner = Object.entries(files).find(([name]) => name.endsWith('/runner/TestRunner.java'))?.[1] || '';
    expect(runner).not.toContain('@skip');
    expect(runner).not.toContain('tags =');
    expect(files['README.md']).toContain('Generated scenarios remain enabled');
  });
});
