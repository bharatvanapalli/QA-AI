import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const conductor = require('../../server/services/agents/conductor.js');

const merge = conductor._mergeAssertionOutcomesFromExecutionJournal;

describe('mergeAssertionOutcomesFromExecutionJournal', () => {
  it('preserves explicit outcomes and fills missing identities from the fresh-run journal shape', () => {
    const step1 = 'cc9fdfde-5d03-4b7d-94e6-07f16557c460:step:1:37631926c3391f98';
    const step4 = 'cc9fdfde-5d03-4b7d-94e6-07f16557c460:step:4:1cd1b0023b22688d';
    const step11 = 'cc9fdfde-5d03-4b7d-94e6-07f16557c460:step:11:efcb0a233ddf0edf';

    const result = merge({
      recorded: [{
        assertionId: 'ASN-sign-in-option',
        outcome: 'matched',
        matched: true,
        expected: true,
        actual: true,
        source: 'declared_reconciliation',
      }],
      executionContract: {
        nodes: [
          { kind: 'action', contractStepId: step1 },
          {
            kind: 'assertion',
            contractStepId: step4,
            assertionId: 'ASN-sign-in-option',
            expectedOutcome: { kind: 'VISIBLE', expected: true },
          },
          { kind: 'assertion', contractStepId: step11 },
        ],
      },
      stepResults: [
        {
          stepId: step1,
          contractStepId: step1,
          kind: 'action',
          assertionOutcomes: [{
            assertionId: step1,
            outcome: 'matched',
            matched: true,
            kind: 'oracle',
            reason: 'visible_confirmed',
            evidence: 'Element textbox "Email Address" is visible.',
          }],
        },
        {
          stepId: step4,
          contractStepId: step4,
          kind: 'assertion',
          expectedState: { expected: true },
          assertionOutcomes: [{
            assertionId: null,
            outcome: 'matched',
            matched: true,
            expected: true,
            actual: true,
            kind: 'oracle',
            evidence: 'visible_matched',
          }],
        },
        {
          stepId: step11,
          contractStepId: step11,
          kind: 'assertion',
          expectedState: { expected: "Home dashboard displayed with 'Welcome OdysseyOne!' visible" },
          assertionOutcomes: [{
            assertionId: null,
            outcome: 'matched',
            matched: true,
            kind: 'page_ready',
            evidence: 'Browser transition confirmed by stable generic evidence.',
          }],
        },
      ],
    });

    expect(result).toHaveLength(3);
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({
        assertionId: 'ASN-sign-in-option',
        outcome: 'matched',
        source: 'declared_reconciliation',
        evidence: 'visible_matched',
      }),
      expect.objectContaining({
        assertionId: step1,
        contractStepId: step1,
        outcome: 'matched',
        source: 'execution_journal',
      }),
      expect.objectContaining({
        assertionId: step11,
        contractStepId: step11,
        outcome: 'matched',
        source: 'execution_journal',
      }),
    ]));
  });

  it('converts evaluated action-owned checks once and ignores unevaluated expectations', () => {
    const result = merge({
      executionContract: {
        nodes: [1, 2, 3, 4, 5, 6].map((ordinal) => ({
          kind: 'action',
          contractStepId: `case:step:${ordinal}`,
        })),
      },
      stepResults: [
        {
          contractStepId: 'case:step:1',
          kind: 'action',
          assertion: {
            status: 'pass', checked: true, matched: true,
            expected: 'Email field is visible', evidence: 'visible_confirmed', kind: 'visible',
          },
          assertionOutcomes: [],
        },
        {
          contractStepId: 'case:step:2',
          kind: 'action',
          assertionResult: {
            status: 'fail', checked: true, matched: false,
            expected: 'Validation matches', actual: 'Mismatch', evidence: 'mismatch_confirmed', kind: 'oracle',
          },
          assertionOutcomes: [],
        },
        {
          contractStepId: 'case:step:3',
          kind: 'action',
          operationCheck: {
            status: 'pass', checked: true, matched: true,
            expected: 'Navigation begins', evidence: 'navigation_event_confirmed', kind: 'page_ready',
          },
          assertionOutcomes: [],
        },
        {
          contractStepId: 'case:step:4',
          kind: 'action',
          actionPostcondition: {
            outcome: 'matched', expected: 'Value accepted', evidence: 'exact target value confirmed', kind: 'input_accepted',
          },
          assertionOutcomes: [],
        },
        {
          contractStepId: 'case:step:5',
          kind: 'action',
          operationCheck: {
            status: 'pass', checked: true, matched: true,
            expected: 'Effect is proven', evidence: 'effect_proven', kind: 'action_completed',
          },
          evidence: {
            status: 'pass', checked: true, matched: true,
            expected: 'Effect is proven', evidence: 'effect_proven', kind: 'operation_check',
          },
          assertionOutcomes: [{
            assertionId: 'case:step:5', outcome: 'matched', matched: true,
            expected: 'Effect is proven', evidence: 'effect_proven', kind: 'action_completed',
          }],
        },
        {
          contractStepId: 'case:step:6',
          kind: 'action',
          operationCheck: { expected: 'Not evaluated yet', kind: 'action_completed' },
          assertionOutcomes: [],
        },
      ],
    });

    expect(result).toHaveLength(5);
    expect(result.map((item) => item.assertionId)).toEqual([
      'case:step:1', 'case:step:2', 'case:step:3', 'case:step:4', 'case:step:5',
    ]);
    expect(result.find((item) => item.assertionId === 'case:step:2')).toMatchObject({
      outcome: 'not_matched', matched: false, evidence: 'mismatch_confirmed',
    });
    expect(result.find((item) => item.assertionId === 'case:step:5')).toMatchObject({
      outcome: 'matched', evidence: 'effect_proven',
    });
    expect(result.some((item) => item.assertionId === 'case:step:6')).toBe(false);
  });
});
