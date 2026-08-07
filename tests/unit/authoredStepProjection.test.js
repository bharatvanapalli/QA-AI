import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import {
  authoredStepText,
  projectAuthoredStepRows,
  selectAuthoredPlannedSteps,
  summarizeAuthoredStepVerdict,
} from '../../src/lib/authoredStepProjection';

const require = createRequire(import.meta.url);
const replayExport = require('../../server/services/codegen/replayExport');

describe('authored step report projection', () => {
  it('shows the exact authored sentence once while retaining atomic journal rows', () => {
    const authoredText = 'Click  Save and verify the employee was created.  ';
    const planned = [
      {
        id: 'step-save',
        logicalStepId: 'logical-save',
        authoredText,
        atomicOrdinal: 1,
        atomicCount: 2,
        text: 'Click Save.',
        action: 'Click',
        target: 'Save button',
      },
      {
        id: 'step-verify',
        logicalStepId: 'logical-save',
        authoredText,
        atomicOrdinal: 2,
        atomicCount: 2,
        text: 'Verify the employee-created message is visible.',
        action: 'AssertVisible',
        target: 'employee-created message',
      },
    ];
    const journal = [
      {
        stepId: 'step-save',
        ordinal: 1,
        status: 'pass',
        actionOutcome: 'succeeded',
        durationMs: 120,
        evidence: 'Save click changed the form state.',
      },
      {
        stepId: 'step-verify',
        ordinal: 2,
        status: 'fail',
        actionOutcome: 'succeeded',
        assertionOutcome: 'not_matched',
        durationMs: 80,
        evidence: 'The expected message was absent.',
      },
    ];

    const rows = projectAuthoredStepRows(planned, journal);

    expect(rows).toHaveLength(1);
    expect(rows[0].authoredText).toBe(authoredText);
    expect(authoredStepText(rows[0].step)).toBe(authoredText);
    expect(rows[0].atomicActions.map((action) => action.text)).toEqual([
      'Click Save.',
      'Verify the employee-created message is visible.',
    ]);
    expect(rows[0].atomicActions.map((action) => action.journal?.stepId)).toEqual([
      'step-save',
      'step-verify',
    ]);

    const verdict = summarizeAuthoredStepVerdict(
      rows[0].atomicActions.map((action) => ({ verdict: action.journal })),
    );
    expect(verdict.status).toBe('fail');
    expect(verdict.durationMs).toBe(200);
    expect(verdict.atomicResults).toHaveLength(2);
  });

  it('prefers a run-pinned authored contract over a subsequently changed test case', () => {
    const result = {
      executionContractJson: JSON.stringify({
        steps: [{
          id: 'pinned-step',
          logicalStepId: 'pinned-logical',
          authoredText: 'The exact step executed in this run.',
        }],
      }),
    };
    const testCase = {
      steps: [{
        id: 'current-step',
        logicalStepId: 'current-logical',
        authoredText: 'A later edit that was not part of this run.',
      }],
    };

    expect(selectAuthoredPlannedSteps({ result, testCase })).toEqual([
      expect.objectContaining({
        id: 'pinned-step',
        authoredText: 'The exact step executed in this run.',
      }),
    ]);
  });
});

describe('authored intent to ReplayIR traceability', () => {
  it('retains authored text as metadata while runtime actions come from executed ReplayIR', () => {
    const authoredText = 'Click Save and verify that the employee was created.';
    const result = {
      runResultId: 'run-result-1',
      testCaseId: 'case-1',
      caseName: 'Create employee',
      declaredSteps: [
        {
          id: 'step-save',
          logicalStepId: 'logical-save',
          authoredText,
          atomicOrdinal: 1,
          atomicCount: 2,
          action: 'Click',
          target: 'Save button',
          text: 'Click Save.',
        },
        {
          id: 'step-verify',
          logicalStepId: 'logical-save',
          authoredText,
          atomicOrdinal: 2,
          atomicCount: 2,
          action: 'AssertVisible',
          target: 'employee-created message',
          text: 'Verify the employee-created message is visible.',
        },
      ],
      envelope: {
        ir: {
          steps: [
            {
              id: 'resolve-save',
              op: 'resolve',
              as: 'save-target',
              label: 'Save button',
              candidates: [{ strategy: 'role', role: 'button', name: 'Save' }],
            },
            {
              id: 'runtime-save',
              contractStepId: 'step-save',
              op: 'act',
              action: 'click',
              target: 'save-target',
              runtimeEvidence: true,
              success: true,
              executionProvenance: 'verified_runtime_action',
            },
            {
              id: 'runtime-assert',
              contractRef: 'step-verify',
              op: 'assert',
              channel: 'UI_TEXT',
              expected: 'Employee created',
              runtimeEvidence: true,
              checked: true,
              matched: true,
              executionProvenance: 'runtime_evidence',
            },
          ],
        },
      },
    };

    const traceability = replayExport.buildAuthoredRuntimeTraceability(result);

    expect(traceability).toHaveLength(1);
    expect(traceability[0]).toMatchObject({
      logicalStepId: 'logical-save',
      authoredText,
      executionAuthority: 'positively_executed_replay_ir',
    });
    expect(traceability[0].interpretedAtomicActions).toHaveLength(2);
    expect(traceability[0].runtimeActions.map((action) => action.op)).toEqual(['act', 'assert']);
    expect(traceability[0].runtimeActions[0]).toMatchObject({
      action: 'click',
      target: 'Save button',
    });
    expect(traceability[0].runtimeActions[1]).toMatchObject({
      action: 'UI_TEXT',
      expected: 'Employee created',
    });

    const document = replayExport.buildAuthoredRuntimeTraceabilityDocument([result]);
    expect(document).toMatchObject({
      schema: 'qaai-authored-runtime-traceability/1',
      executableAuthority: 'positively_executed_replay_ir',
    });
    expect(document.entries[0].authoredSteps[0].authoredText).toBe(authoredText);
  });
});

