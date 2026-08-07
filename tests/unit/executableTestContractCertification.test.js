import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const contract = require('../../server/services/executableTestContract.js');

describe('executable contract export certification reconciliation', () => {
  it('retires source-proven repairs and a guarded optional fallback after deterministic evidence exhaustion', () => {
    const testCaseId = 'TC-1';
    const tasks = [
      { category: 'step_parity_gap', contractStepId: 'TC-1:step:1:hash' },
      { category: 'missing_locator_recipe', contractStepId: 'TC-1:step:1:hash' },
      { category: 'assertion_translation_gap', contractStepId: 'TC-1:step:2:hash' },
      { category: 'assertion_translation_gap', contractStepId: 'TC-1:assertion:1' },
      { category: 'missing_locator_recipe', contractStepId: 'TC-1:step:3:hash' },
    ];
    const stepLedger = {
      summary: { totalPlannedSteps: 3, exported: 3, blockedInternal: 0, replayOnly: 0 },
      cases: [{
        testCaseId,
        ledger: [
          { contractStepId: 'TC-1:step:1:hash', exportStatus: 'exported', status: 'exported_direct', exportedPageMethod: 'clickContinue' },
          { contractStepId: 'TC-1:step:2:hash', exportStatus: 'exported', status: 'exported_direct', exportedPageMethod: 'assertProviderVisible' },
          { contractStepId: 'TC-1:step:3:hash', exportStatus: 'exported', status: 'exported_direct', exportedPageMethod: 'clickOptionalPrompt', operation: 'dismiss_if_visible' },
        ],
      }],
    };
    const report = contract.certifyContractExport({
      results: [{
        testCaseId,
        runResultId: 'RR-1',
        status: 'passed',
        executionContract: {},
        actionGraph: { repairTasks: tasks },
      }],
      files: {
        'tests/authentication/flow.spec.js': 'test("flow", async () => {});\n',
        'evidence/locator-manifest.json': JSON.stringify([
          { contractStepId: 'TC-1:step:1:hash', verified: true },
          {
            contractStepId: 'TC-1:step:3:hash',
            verified: false,
            expr: 'page.getByRole("button", { name: "Yes" })',
            source: 'qaaiGuessedLocator',
            provenance: { kind: 'qaai_guessed_locator', deterministicEvidenceExhausted: true },
          },
        ]),
      },
      validation: { packagePassed: true },
      stepLedger,
    });

    expect(report.packagePassed).toBe(true);
    expect(report.errorCount).toBe(0);
    expect(report.warningCount).toBe(0);
    expect(report.repairTasks).toEqual([]);
    expect(report.findings).toEqual([]);
  });

  it('retains an unguarded guessed locator as a non-blocking repair warning', () => {
    const report = contract.certifyContractExport({
      results: [{
        testCaseId: 'TC-unguarded',
        runResultId: 'RR-unguarded',
        status: 'passed',
        executionContract: {},
        actionGraph: {
          repairTasks: [{
            category: 'missing_locator_recipe',
            contractStepId: 'TC-unguarded:step:1:hash',
          }],
        },
      }],
      files: {
        'tests/flow.spec.js': 'test("flow", async () => {});\n',
        'evidence/locator-manifest.json': JSON.stringify([{
          contractStepId: 'TC-unguarded:step:1:hash',
          verified: false,
          expr: 'page.getByRole("button", { name: "Submit" })',
          source: 'qaaiGuessedLocator',
          provenance: { kind: 'qaai_guessed_locator', deterministicEvidenceExhausted: true },
        }]),
      },
      validation: { packagePassed: true },
      stepLedger: {
        summary: { totalPlannedSteps: 1, exported: 1, blockedInternal: 0, replayOnly: 0 },
        cases: [{
          testCaseId: 'TC-unguarded',
          ledger: [{
            contractStepId: 'TC-unguarded:step:1:hash',
            exportStatus: 'exported',
            status: 'exported_direct',
            exportedPageMethod: 'clickSubmit',
            operation: 'click',
          }],
        }],
      },
    });

    expect(report.packagePassed).toBe(true);
    expect(report.warningCount).toBe(1);
    expect(report.repairTasks).toEqual([
      expect.objectContaining({
        category: 'missing_locator_recipe',
        contractStepId: 'TC-unguarded:step:1:hash',
      }),
    ]);
  });
});
