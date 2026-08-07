import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const replayExport = require('../../server/services/codegen/replayExport.js');
const playwrightPomJs = require('../../server/services/codegen/adapters/playwrightPomJs.js');

function clickStep(id, target, label = target) {
  return {
    op: 'resolve',
    as: target,
    contractStepId: id,
    elementLabel: label,
    candidates: [{ strategy: 'role', role: 'button', name: label }],
  };
}

describe('replay export authored cardinality', () => {
  it('canonicalizes mixed persisted and execution identities before downstream generation', () => {
    const result = {
      runResultId: 'run-result-mixed-identity',
      testCaseId: 'case-mixed-identity',
      caseName: 'Mixed identity boundary',
      status: 'pass',
      declaredSteps: [
        {
          id: 'case_step_10',
          contractStepId: 'case_step_10',
          action: 'Dismiss if visible',
          target: 'Post-authentication prompt',
          expected: 'Prompt dismissed if present; flow continues',
        },
        {
          id: 'case_step_11',
          contractStepId: 'case_step_11',
          action: 'Verify',
          target: 'Home banner',
          expected: 'Welcome message is visible',
        },
      ],
      executionContract: {
        steps: [
          {
            contractStepId: 'case-mixed-identity:step:10:stable',
            stepOrdinal: 10,
            kind: 'action',
            actionType: 'dismiss_if_visible',
            plannedText: 'Dismiss the post-authentication prompt if visible',
            raw: { target: 'Post-authentication prompt' },
          },
          {
            contractStepId: 'case-mixed-identity:step:11:stable',
            stepOrdinal: 11,
            kind: 'assertion',
            actionType: 'verify',
            plannedText: 'Verify the home banner',
            raw: { target: 'Home banner' },
          },
          {
            contractStepId: 'case-mixed-identity:assertion:internal',
            kind: 'assertion',
            assertionType: 'UI_TEXT',
            expected: 'Internal probe fragment',
          },
        ],
      },
      envelope: {
        complete: false,
        ir: { caseId: 'case-mixed-identity', title: 'Mixed identity boundary', steps: [] },
      },
    };

    const prepared = replayExport.prepareResultForExport(structuredClone(result));

    expect(prepared.declaredSteps).toHaveLength(2);
    expect(prepared.declaredSteps[0]).toMatchObject({
      id: 'case-mixed-identity:step:10:stable',
      contractStepId: 'case-mixed-identity:step:10:stable',
      sourceStepId: 'case_step_10',
      action: 'Dismiss if visible',
      expected: 'Prompt dismissed if present; flow continues',
    });
    expect(prepared.declaredSteps[1]).toMatchObject({
      id: 'case-mixed-identity:step:11:stable',
      contractStepId: 'case-mixed-identity:step:11:stable',
      sourceStepId: 'case_step_11',
      action: 'Verify',
      expected: 'Welcome message is visible',
    });

    const emitted = playwrightPomJs.emitJourneySpec([{
      caseName: prepared.caseName,
      testCaseId: prepared.testCaseId,
      declaredSteps: prepared.declaredSteps,
      ir: prepared.envelope.ir,
    }], { scenarioName: 'Mixed identity boundary', moduleFormat: 'esm' });
    const pageSources = Object.entries(emitted.extraFiles)
      .filter(([filePath]) => /^pages\/.*Page\.js$/.test(filePath))
      .map(([, source]) => source)
      .join('\n');
    expect(emitted.content).not.toMatch(/\.assert[A-Za-z0-9_$]+\(/);
    expect(emitted.content).not.toMatch(/\.click[A-Za-z0-9_$]+\(/);
    expect(pageSources).not.toContain("waitFor({ state: 'visible'");
    expect(pageSources).not.toContain('.then(() => true).catch(() => false)');
  });

  it('does not attach one-word semantic runtime evidence to a distinct authored action', () => {
    const result = {
      runResultId: 'run-result-cardinality',
      testCaseId: 'case-cardinality',
      caseName: 'Distinct Microsoft actions',
      status: 'pass',
      declaredSteps: [
        { id: 'choose-microsoft-provider', action: 'click', target: 'Microsoft provider option' },
        { id: 'submit-microsoft-credentials', action: 'click', target: 'Microsoft credential submit' },
      ],
      envelope: {
        complete: false,
        ir: {
          caseId: 'case-cardinality',
          title: 'Distinct Microsoft actions',
          steps: [
            clickStep('runtime-microsoft-account', 'runtimeMicrosoftButton', 'Microsoft account'),
            {
              op: 'act', action: 'click', target: 'runtimeMicrosoftButton',
              targetLabel: 'Microsoft account', contractStepId: 'runtime-microsoft-account', authored: false,
              origin: 'runtime_evidence', canonicalExecution: true, status: 'passed',
            },
          ],
        },
      },
    };

    const prepared = replayExport.prepareResultForExport(structuredClone(result));
    const clicks = prepared.envelope.ir.steps.filter((step) => step.op === 'act' && step.action === 'click');
    const ids = clicks.map((step) => step.contractStepId);

    expect(ids.filter((id) => id === 'choose-microsoft-provider')).toHaveLength(0);
    expect(ids.filter((id) => id === 'submit-microsoft-credentials')).toHaveLength(0);
    expect(ids.filter((id) => id === 'runtime-microsoft-account')).toHaveLength(1);
    expect(prepared.envelope.reconstructedMissingAuthoredActions).toBe(true);
    expect(prepared.envelope.authoredParity.executionAuthority).toBe('executed_occurrences_only');
  });

  it('does not materialize an omitted declared assertion without execution evidence', () => {
    const result = {
      runResultId: 'run-result-assertion',
      testCaseId: 'case-assertion',
      caseName: 'Dashboard assertion recovery',
      status: 'pass',
      declaredSteps: [
        { id: 'open-dashboard', action: 'click', target: 'Dashboard' },
      ],
      declaredAssertionsRaw: JSON.stringify([
        { id: 'assert-welcome', type: 'UI_TEXT', payload: { expectedText: 'Welcome OdysseyOne' } },
      ]),
      envelope: {
        complete: true,
        gaps: [],
        findings: [],
        ir: {
          caseId: 'case-assertion',
          title: 'Dashboard assertion recovery',
          steps: [
            clickStep('open-dashboard', 'dashboardButton', 'Dashboard'),
            { op: 'act', action: 'click', target: 'dashboardButton', contractStepId: 'open-dashboard', authored: true },
          ],
        },
      },
    };

    const prepared = replayExport.prepareResultForExport(structuredClone(result));
    const assertions = prepared.envelope.ir.steps.filter((step) => step.op === 'assert');

    expect(assertions).toHaveLength(0);
    expect(prepared.envelope.reconstructedMissingAuthoredAssertions).toBe(true);
    expect(prepared.envelope.complete).toBe(false);
  });

  it('keeps a usable assertion contract descriptive until execution evidence exists', () => {
    const result = {
      runResultId: 'run-result-placeholder-assertion',
      testCaseId: 'case-placeholder-assertion',
      caseName: 'Placeholder assertion recovery',
      status: 'pass',
      declaredAssertionsRaw: JSON.stringify([{ id: 'empty-placeholder', type: 'TEXT' }]),
      executionContract: {
        steps: [
          {
            id: 'verify-welcome',
            kind: 'assertion',
            assertionType: 'UI_TEXT',
            target: 'Home dashboard',
            expected: { expected: 'Welcome OdysseyOne!' },
          },
        ],
      },
      envelope: {
        complete: false,
        ir: { caseId: 'case-placeholder-assertion', title: 'Placeholder assertion recovery', steps: [] },
      },
    };

    const prepared = replayExport.prepareResultForExport(structuredClone(result));
    const assertions = prepared.envelope.ir.steps.filter((step) => step.op === 'assert');

    expect(assertions).toHaveLength(0);
    expect(prepared.declaredAssertions).toHaveLength(1);
    expect(prepared.declaredAssertions[0]).toMatchObject({
      id: 'verify-welcome',
      target: 'Home dashboard',
      expected: 'Welcome OdysseyOne!',
    });
    expect(JSON.stringify(prepared.declaredAssertions)).not.toContain('empty-placeholder');
  });

  it('merges assertion descriptions without materializing executable assertions', () => {
    const result = {
      runResultId: 'run-result-merged-assertions',
      testCaseId: 'case-merged-assertions',
      caseName: 'Merged assertion contracts',
      status: 'pass',
      declaredAssertionsRaw: JSON.stringify([
        {
          id: 'verify-banner',
          type: 'UI_TEXT',
          payload: { target: 'Status banner', expectedText: 'Ready' },
        },
      ]),
      executionContract: {
        steps: [
          {
            id: 'verify-banner',
            kind: 'assertion',
            assertionType: 'UI_TEXT',
            target: 'Status banner',
            expected: 'Ready',
          },
          {
            id: 'verify-url',
            kind: 'assertion',
            assertionType: 'URL',
            expected: '/dashboard',
          },
        ],
      },
      envelope: {
        complete: false,
        ir: { caseId: 'case-merged-assertions', title: 'Merged assertion contracts', steps: [] },
      },
    };

    const prepared = replayExport.prepareResultForExport(structuredClone(result));
    const assertions = prepared.envelope.ir.steps.filter((step) => step.op === 'assert');
    const refs = assertions.map((step) => step.contractRef).sort();

    expect(refs).toEqual([]);
    expect(prepared.declaredAssertions.map((assertion) => assertion.id).sort()).toEqual([
      'verify-banner',
      'verify-url',
    ]);
  });

  it('does not promote unmapped execution fragments beside explicit authored Verify steps', () => {
    const result = {
      runResultId: 'run-result-explicit-verify',
      testCaseId: 'case-explicit-verify',
      caseName: 'Explicit verification precedence',
      declaredSteps: [
        { id: 'verify-provider', action: 'Verify', target: 'Provider option', expected: 'Provider is visible' },
        { id: 'verify-dashboard', action: 'Validate', target: 'Dashboard', expected: 'Welcome is visible' },
      ],
      declaredAssertionsRaw: JSON.stringify([{ id: 'metadata-only', type: 'TEXT' }]),
      executionContract: {
        steps: [
          { id: 'assertion-fragment-1', kind: 'assertion', expected: 'Provider is visible' },
          { id: 'assertion-fragment-2', kind: 'assertion', expected: 'Welcome is visible' },
        ],
      },
      envelope: {
        complete: false,
        ir: { caseId: 'case-explicit-verify', title: 'Explicit verification precedence', steps: [] },
      },
    };

    const prepared = replayExport.prepareResultForExport(structuredClone(result));
    expect(prepared.declaredAssertions).toEqual([]);
  });

  it('admits an execution assertion only when it maps to an explicit authored Verify occurrence', () => {
    const result = {
      runResultId: 'run-result-mapped-verify',
      testCaseId: 'case-mapped-verify',
      caseName: 'Mapped verification enrichment',
      declaredSteps: [
        { id: 'verify-dashboard', action: 'Verify', target: 'Dashboard' },
      ],
      executionContract: {
        steps: [
          {
            id: 'runtime-assertion-1',
            sourceStepId: 'verify-dashboard',
            kind: 'assertion',
            assertionType: 'PAGE',
            expected: 'Welcome is visible',
          },
        ],
      },
      envelope: {
        complete: false,
        ir: { caseId: 'case-mapped-verify', title: 'Mapped verification enrichment', steps: [] },
      },
    };

    const prepared = replayExport.prepareResultForExport(structuredClone(result));
    expect(prepared.declaredAssertions).toHaveLength(1);
    expect(prepared.declaredAssertions[0]).toMatchObject({
      id: 'verify-dashboard',
      sourceStepId: 'verify-dashboard',
      expected: 'Welcome is visible',
    });
  });

});
