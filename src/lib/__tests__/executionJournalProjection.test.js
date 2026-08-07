import { describe, expect, it } from 'vitest';
import {
  continuationLabel,
  normalizeExecutionJournal,
  projectExecutionJournal,
} from '../executionJournalProjection';
import {
  buildConductorSummary,
  buildStepContinuation,
  buildStepEvidenceRows,
  buildStepReportNarrative,
} from '../reportEvidence';

describe('executionJournalProjection', () => {
  it('never invents a pass for a planned step without a journal result', () => {
    const rows = normalizeExecutionJournal(
      [{ stepId: 'one', ordinal: 1, status: 'pass' }],
      [{ id: 'one', text: 'Executed' }, { id: 'two', text: 'Never reached' }],
    );

    expect(rows[0]).toMatchObject({ actionOutcome: 'succeeded' });
    expect(rows[1]).toMatchObject({
      stepId: 'two',
      actionOutcome: 'not_executed',
      assertionOutcome: 'not_applicable',
      failureType: 'dependency_skipped',
    });
    expect(rows[1].continuationReason).toContain('No execution journal result');
  });

  it('separates non-blocking validation failures from execution errors', () => {
    const { rows, summary } = projectExecutionJournal([
      {
        stepId: 'validation',
        actionOutcome: 'succeeded',
        assertions: [{ outcome: 'not_matched', expected: '42', actual: '41', comparator: 'equals' }],
        continuationOutcome: 'continue',
      },
      {
        stepId: 'dispatch',
        actionOutcome: 'failed',
        executionError: true,
        continuationOutcome: 'stop_descendants',
      },
    ]);

    expect(rows[0].assertionOutcome).toBe('not_matched');
    expect(summary).toMatchObject({
      planned: 2,
      executed: 2,
      validationFailed: 1,
      executionErrors: 1,
      productFailures: 0,
      passed: 0,
    });
    expect(continuationLabel(rows[0])).toBe('Continued');
    expect(continuationLabel(rows[1])).toBe('Stopped dependent steps');
  });

  it('projects the requested 25-step completion truthfully', () => {
    const results = Array.from({ length: 25 }, (_, index) => ({
      stepId: `step-${index + 1}`,
      ordinal: index + 1,
      actionOutcome: 'succeeded',
      assertions: index < 4 ? [{ outcome: 'not_matched' }] : [],
      continuationOutcome: 'continue',
    }));

    expect(projectExecutionJournal(results).summary).toMatchObject({
      planned: 25,
      executed: 25,
      passed: 21,
      validationFailed: 4,
      executionCompleted: true,
    });
  });

  it('keeps legacy rows compatible without converting blocked or skipped rows to passes', () => {
    const { rows, summary } = projectExecutionJournal([
      { index: 1, status: 'pass' },
      { index: 2, status: 'fail', expected: 'A', actual: 'B', assertionOutcome: 'not_matched' },
      { index: 3, status: 'blocked', error: 'Locator could not be resolved' },
      { index: 4, status: 'skipped' },
    ]);

    expect(rows.map(row => row.actionOutcome)).toEqual(['succeeded', 'succeeded', 'failed', 'not_executed']);
    expect(summary).toMatchObject({ passed: 1, validationFailed: 1, executionErrors: 1, notExecuted: 1 });
  });
});

describe('reportEvidence enriched journal compatibility', () => {
  const verdict = {
    ordinal: 4,
    status: 'fail',
    actionOutcome: 'succeeded',
    assertionOutcome: 'not_matched',
    assertions: [{
      id: 'total-check',
      outcome: 'not_matched',
      expected: '42',
      actual: '41',
      comparator: 'equals',
      reason: 'Displayed total differs',
      evidence: 'screenshot://step-4',
    }],
    continuationOutcome: 'continue',
    continuationReason: 'Later checks are independent.',
  };

  it('projects expected, actual, comparator, reason, evidence and continuation', () => {
    expect(buildStepEvidenceRows(verdict)).toEqual([expect.objectContaining({
      outcome: 'not_matched',
      expected: '42',
      actual: '41',
      comparator: 'equals',
      reason: 'Displayed total differs',
      evidence: 'screenshot://step-4',
    })]);
    expect(buildStepContinuation(verdict)).toEqual({
      label: 'Continued',
      reason: 'Later checks are independent.',
    });
  });

  it('does not claim a continuing validation failure stopped the case', () => {
    const narrative = buildStepReportNarrative({ step: { text: 'Check total' }, number: 4, verdict });
    expect(narrative.title).toBe('Validation evidence');
    expect(narrative.conclusion).toContain('continued with independent steps');
    expect(buildConductorSummary({ status: 'fail', stepResults: [verdict] })).toContain('recorded an issue at Step 4');
  });
});
