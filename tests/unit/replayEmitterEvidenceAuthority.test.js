import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const replayEmitter = require('../../server/services/codegen/replayEmitter.js');
const replayExport = require('../../server/services/codegen/replayExport.js');

function evaluatedAssertionFixture() {
  const declaredAssertions = [
    {
      id: 'assert-dashboard-title',
      type: 'UI_TEXT',
      payload: {},
    },
    {
      id: 'assert-welcome-message',
      type: 'UI_TEXT',
      payload: { expectedText: 'Welcome OdysseyOne' },
    },
  ];
  const assertionOutcomes = [
    {
      id: 'assertion-evidence-pass',
      assertionId: 'assert-dashboard-title',
      assertionEvidenceId: 'assertion-evidence-pass',
      checked: true,
      matched: true,
      outcome: 'matched',
      expected: 'Dashboard',
      actual: 'Dashboard',
    },
    {
      id: 'assertion-evidence-fail',
      assertionId: 'assert-welcome-message',
      assertionEvidenceId: 'assertion-evidence-fail',
      checked: true,
      matched: false,
      outcome: 'not_matched',
      expected: 'Welcome OdysseyOne',
      actual: 'Sign in',
    },
  ];
  return { declaredAssertions, assertionOutcomes };
}

describe('ReplayIR evidence-only executable authority', () => {
  it('marks evaluated pass and fail assertions as canonical runtime evidence with their values', () => {
    const { declaredAssertions, assertionOutcomes } = evaluatedAssertionFixture();
    const emitted = replayEmitter.buildReplayIR({
      caseId: 'assertion-provenance-case',
      declaredAssertions,
      assertionOutcomes,
      verdictStatus: 'fail',
    });

    const assertions = emitted.ir.steps.filter((step) => step.op === 'assert');
    expect(assertions).toHaveLength(2);
    expect(assertions[0]).toMatchObject({
      contractRef: 'assert-dashboard-title',
      assertionId: 'assert-dashboard-title',
      assertionEvidenceId: 'assertion-evidence-pass',
      origin: 'runtime_evidence',
      canonicalExecution: true,
      runtimeEvidence: true,
      checked: true,
      matched: true,
      liveOutcome: 'matched',
      executionStatus: 'passed',
      expected: 'Dashboard',
      actual: 'Dashboard',
    });
    expect(assertions[1]).toMatchObject({
      contractRef: 'assert-welcome-message',
      assertionId: 'assert-welcome-message',
      assertionEvidenceId: 'assertion-evidence-fail',
      origin: 'runtime_evidence',
      canonicalExecution: true,
      runtimeEvidence: true,
      checked: true,
      matched: false,
      liveOutcome: 'not_matched',
      executionStatus: 'failed',
      expected: 'Welcome OdysseyOne',
      actual: 'Sign in',
    });
  });

  it('keeps both evaluated pass and failure assertions through final execution-only preparation', () => {
    const { declaredAssertions, assertionOutcomes } = evaluatedAssertionFixture();
    const envelope = replayEmitter.buildReplayIR({
      caseId: 'assertion-filter-case',
      declaredAssertions,
      assertionOutcomes,
      verdictStatus: 'fail',
    });
    const prepared = replayExport.prepareResultForExport({
      runResultId: 'run-assertion-filter',
      testCaseId: 'assertion-filter-case',
      status: 'failed',
      declaredAssertionsRaw: JSON.stringify(declaredAssertions),
      envelope,
    });

    expect(
      prepared.envelope.ir.steps
        .filter((step) => step.op === 'assert')
        .map((step) => ({
          contractRef: step.contractRef,
          expected: step.expected,
          actual: step.actual,
          liveOutcome: step.liveOutcome,
        })),
    ).toEqual([
      {
        contractRef: 'assert-dashboard-title',
        expected: 'Dashboard',
        actual: 'Dashboard',
        liveOutcome: 'matched',
      },
      {
        contractRef: 'assert-welcome-message',
        expected: 'Welcome OdysseyOne',
        actual: 'Sign in',
        liveOutcome: 'not_matched',
      },
    ]);
  });

  it('keeps unexecuted authored actions and waits diagnostic instead of synthesizing runnable steps', () => {
    const emitted = replayEmitter.buildReplayIR({
      caseId: 'unexecuted-authoring-case',
      trail: [],
      caseContractV1: {
        steps: [
          { id: 'open-menu', type: 'Click', text: 'Click Account menu' },
          { id: 'wait-panel', type: 'Wait', text: 'Wait for Account panel' },
        ],
      },
    });

    expect(emitted.ir.steps.filter((step) => ['act', 'waitFor', 'resolve'].includes(step.op)))
      .toHaveLength(0);
    expect(emitted.findings.filter((finding) => finding.code === 'planned_step_not_executed'))
      .toHaveLength(2);
    expect(emitted.findings.some((finding) => finding.code === 'authored_wait_utility_compiled'))
      .toBe(false);
  });

  it('contains no dormant narration-matching or authored-wait synthesis branch', () => {
    const source = readFileSync(
      require.resolve('../../server/services/codegen/replayEmitter.js'),
      'utf8',
    );
    expect(source).not.toContain('const matched = null');
    expect(source).not.toContain('authored_wait_utility_compiled');
    expect(source).not.toContain('replayConditionForPlannedWait');
    expect(source).not.toContain('every authored action remains in the script');
    expect(source).not.toContain('missing locator evidence gets an explicit editable guess');
    expect(source).not.toMatch(/[âÂ�]/);
    expect(source).not.toContain('\uFFFD');
  });
});
