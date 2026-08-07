import { describe, expect, it } from 'vitest';

const journal = require('../../server/services/executionJournal');
const { classifyActionFailureOwnership } = require('../../server/services/executionOutcomeOwnership');

function journalRowForFailure(input) {
  let rows = journal.initializeExecutionJournal({
    approvedSteps: [{ id: 'action', action: 'Click', required: true }],
  });
  const ownership = classifyActionFailureOwnership(input);
  rows = journal.recordActionOutcome(rows, 'action', {
    outcome: 'failed',
    reason: input.reason,
    failureType: ownership.failureType,
    executionError: ownership.executionError,
  });
  return { ownership, row: rows[0], summary: journal.projectExecutionJournal(rows) };
}

describe('execution outcome ownership', () => {
  it.each([
    'Timed out while waiting for the click effect.',
    'The element became stale before dispatch.',
    'The target detached before the action could be confirmed.',
    'Two ambiguous equal-score targets were found.',
    'Click action was unconfirmed after the bounded retry.',
    'The active target is unavailable.',
    'no_clickable_control',
  ])('classifies unproven browser failure as QAAI uncertainty: %s', (reason) => {
    const result = journalRowForFailure({ reason });
    expect(result.ownership).toMatchObject({
      executionError: true,
      failureOwner: 'qaai',
    });
    expect(result.row).toMatchObject({ status: 'blocked', executionError: true });
    expect(result.summary).toMatchObject({ executionErrors: 1, productFailures: 0 });
  });

  it('lets uncertainty override a contradictory generic product label', () => {
    expect(classifyActionFailureOwnership({
      failureType: 'product_failure',
      reason: 'Timed out; destination state remained unconfirmed.',
    })).toMatchObject({ executionError: true, failureOwner: 'qaai' });
  });

  it('defaults an unproven failure to QAAI uncertainty', () => {
    expect(classifyActionFailureOwnership({ reason: 'The action did not complete.' })).toEqual({
      executionError: true,
      failureOwner: 'qaai',
      failureType: 'qaai_execution_uncertainty',
    });
  });

  it('classifies typed positive browser rejection as product-owned', () => {
    const result = journalRowForFailure({
      failureType: 'business_rule_rejected',
      reason: 'The application displayed the observed business-rule rejection.',
    });
    expect(result.ownership).toMatchObject({ executionError: false, failureOwner: 'product' });
    expect(result.row).toMatchObject({ status: 'fail', executionError: false });
    expect(result.summary).toMatchObject({ executionErrors: 0, productFailures: 1 });
  });

  it('classifies an explicit assertion mismatch as product/functional evidence', () => {
    expect(classifyActionFailureOwnership({
      assertionMismatch: true,
      reason: 'Expected total 10 but observed 9.',
    })).toMatchObject({ executionError: false, failureOwner: 'product' });
  });

  it.each([
    ['locator', 'Locator resolution failed for the approved target.'],
    ['unconfirmed', 'The click completed but the page effect remained unconfirmed.'],
    ['ambiguous', 'Two ambiguous equal-score controls remain.'],
  ])('enforces %s uncertainty at the journal boundary even when caller labels product failure', (_kind, reason) => {
    let rows = journal.initializeExecutionJournal({
      approvedSteps: [{ id: 'submit', action: 'Click', required: true }],
    });
    rows = journal.recordActionOutcome(rows, 'submit', {
      outcome: 'failed',
      failureType: 'product_failure',
      executionError: false,
      reason,
    });
    expect(rows[0]).toMatchObject({
      actionOutcome: 'failed',
      executionError: true,
      failureOwner: 'qaai',
      failureType: 'qaai_execution_uncertainty',
      status: 'blocked',
    });
  });

  it('preserves explicit positive product rejection at the journal boundary', () => {
    let rows = journal.initializeExecutionJournal({
      approvedSteps: [{ id: 'submit', action: 'Click', required: true }],
    });
    rows = journal.recordActionOutcome(rows, 'submit', {
      outcome: 'failed',
      failureType: 'product_failure',
      observedProductRejection: true,
      reason: 'The browser displayed a business-rule rejection after submit.',
    });
    expect(rows[0]).toMatchObject({
      actionOutcome: 'failed',
      executionError: false,
      failureOwner: 'product',
      failureType: 'product_failure',
      status: 'fail',
    });
  });

  it('leaves successful action outcomes unchanged', () => {
    let rows = journal.initializeExecutionJournal({
      approvedSteps: [{ id: 'continue', action: 'Click', required: true }],
    });
    rows = journal.recordActionOutcome(rows, 'continue', {
      outcome: 'succeeded',
      reason: 'Destination fingerprint confirmed.',
    });
    expect(rows[0]).toMatchObject({
      actionOutcome: 'succeeded',
      executionError: false,
      failureOwner: null,
      failureType: null,
      status: 'pass',
    });
  });
});
