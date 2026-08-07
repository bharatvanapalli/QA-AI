import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const journal = require('../../server/services/executionJournal');

function actionSteps() {
  return [
    { id: 'open', action: 'Navigate', description: 'Open the application' },
    { id: 'email', action: 'Fill', description: 'Fill email' },
    { id: 'submit', action: 'Click', description: 'Submit the form' },
    { id: 'independent', action: 'Screenshot', description: 'Capture public footer', independent: true },
    { id: 'destination', action: 'Verify', description: 'Verify destination', dependsOnStepIds: ['submit'] },
  ];
}

function uncertainActionAndReadback() {
  let rows = journal.initializeExecutionJournal({
    approvedSteps: [
      { id: 'apply-choice', action: 'Click', description: 'Apply the selected choice' },
      {
        id: 'choice-readback',
        action: 'Verify',
        kind: 'assertion',
        description: 'Read back the selected choice',
        dependsOnStepIds: ['apply-choice'],
      },
      {
        id: 'continue-flow',
        action: 'Screenshot',
        description: 'Capture the next neutral state',
        dependsOnStepIds: ['choice-readback'],
      },
    ],
  });
  rows = journal.recordAttempt(rows, 'apply-choice', {
    tool: 'browser_click',
    actualOutcome: 'failed',
    reason: 'Postcondition evidence was temporarily unavailable.',
  });
  rows = journal.recordActionOutcome(rows, 'apply-choice', {
    outcome: 'failed',
    executionError: true,
    failureType: 'evidence_missing',
    continuationOutcome: 'continue',
    reason: 'Postcondition evidence was temporarily unavailable.',
    evidence: { code: 'postcondition_evidence_unavailable', observed: 'neutral_state_before_readback' },
  });
  return rows;
}

describe('executionJournal compatibility layer', () => {
  it('initializes one legacy-compatible row per planned step and merges contract metadata', () => {
    const approvedSteps = [
      { id: 'email', action: 'Fill', description: 'Fill email with alice@example.test' },
      { id: 'password', action: 'Fill', description: 'Fill password=VerySecret123' },
      { id: 'submit', action: 'Click', description: 'Submit', independent: true },
    ];
    const executionContract = {
      nodes: [
        {
          contractStepId: 'contract:email', stepOrdinal: 1, actionType: 'fill',
          dataBinding: { reference: 'email', value: 'alice@example.test' },
        },
        {
          contractStepId: 'contract:password', stepOrdinal: 2, actionType: 'fill',
          dataBinding: { sourceColumn: 'password', value: 'VerySecret123', sensitive: true },
        },
        { contractStepId: 'contract:submit', stepOrdinal: 3, actionType: 'click' },
      ],
    };

    const rows = journal.initializeExecutionJournal({ approvedSteps, executionContract });

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      journalVersion: 'execution_journal_v1',
      index: 1,
      ordinal: 1,
      stepId: 'email',
      contractStepId: 'contract:email',
      status: 'pending',
      actionOutcome: null,
      assertionOutcome: null,
      dependencyStepIds: [],
    });
    expect(rows[1].dependencyStepIds).toEqual(['email']);
    expect(rows[2].dependencyStepIds).toEqual([]);
    expect(rows[0].boundDataReferences[0].value).toBe('alice@example.test');
    expect(rows[1].boundDataReferences[0]).toMatchObject({ sensitive: true, value: '[REDACTED]' });
    expect(JSON.stringify(rows[1])).not.toContain('VerySecret123');
    expect(rows[1].plannedText).toContain('[REDACTED]');
  });

  it('treats empty dependency arrays as unspecified and builds a sequential form chain', () => {
    const approvedSteps = Array.from({ length: 87 }, (_, index) => ({
      id: `form-step-${index + 1}`,
      action: index % 3 === 0 ? 'Fill' : 'Click',
      dependencies: [],
    }));

    const rows = journal.initializeExecutionJournal({ approvedSteps });

    expect(rows[0].dependencyStepIds).toEqual([]);
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index].dependencyStepIds).toEqual([rows[index - 1].stepId]);
      expect(rows[index - 1].dependentStepIds).toContain(rows[index].stepId);
    }
  });

  it('applies sequential fallback when matched contract nodes declare empty dependencies', () => {
    const approvedSteps = [
      { id: 'organization', action: 'Fill' },
      { id: 'equipment', action: 'Select' },
      { id: 'direction', action: 'Select' },
    ];
    const executionContract = {
      nodes: approvedSteps.map((step, index) => ({
        stepId: step.id,
        stepOrdinal: index + 1,
        dependencies: [],
      })),
    };

    const rows = journal.initializeExecutionJournal({ approvedSteps, executionContract });

    expect(rows.map((row) => row.dependencyStepIds)).toEqual([
      [],
      ['organization'],
      ['equipment'],
    ]);
  });

  it('resolves authored dependency IDs through projected contract-node aliases', () => {
    const approvedSteps = [
      { id: 'runtime-step-1', action: 'Fill' },
      { id: 'runtime-step-2', action: 'Select', dependsOn: ['case-step-1'] },
      { id: 'runtime-step-3', action: 'Select', dependsOn: ['case-step-1'] },
    ];
    const executionContract = {
      nodes: [
        { contractStepId: 'runtime-step-1', caseContractStepId: 'case-step-1', stepOrdinal: 1 },
        { contractStepId: 'runtime-step-2', caseContractStepId: 'case-step-2', stepOrdinal: 2 },
        { contractStepId: 'runtime-step-3', caseContractStepId: 'case-step-3', stepOrdinal: 3 },
      ],
    };

    const rows = journal.initializeExecutionJournal({ approvedSteps, executionContract });

    expect(rows[1].dependencyStepIds).toEqual(['runtime-step-1']);
    expect(rows[2].dependencyStepIds).toEqual(['runtime-step-1']);
    expect(rows[0].dependentStepIds).toEqual(['runtime-step-2', 'runtime-step-3']);
  });

  it('stops later authored form actions after a required selection fails', () => {
    const approvedSteps = Array.from({ length: 87 }, (_, index) => ({
      id: `form-step-${index + 1}`,
      action: index === 14 ? 'Select' : 'Fill',
      dependencies: [],
    }));
    let rows = journal.initializeExecutionJournal({ approvedSteps });
    for (let index = 0; index < 14; index += 1) {
      rows = journal.recordActionOutcome(rows, approvedSteps[index].id, 'succeeded');
    }

    rows = journal.recordActionOutcome(rows, 'form-step-15', {
      outcome: 'failed',
      executionError: true,
      required: true,
      continuationOutcome: 'stop_descendants',
      reason: 'The exact option was not observed.',
    });

    expect(rows.slice(15)).toHaveLength(72);
    expect(rows.slice(15).every((row) => row.actionOutcome === 'not_executed')).toBe(true);
    expect(rows.slice(15).every((row) => row.dependencySkipped === true)).toBe(true);
    expect(journal.selectNextRunnableStep(rows)).toBeNull();
  });

  it('keeps an explicitly independent branch runnable after a required chain fails', () => {
    let rows = journal.initializeExecutionJournal({
      approvedSteps: [
        { id: 'organization', action: 'Select', dependencies: [] },
        { id: 'equipment', action: 'Select', dependencies: [] },
        { id: 'public-proof', action: 'Screenshot', dependencies: [], independent: true },
      ],
    });

    rows = journal.recordActionOutcome(rows, 'organization', {
      outcome: 'failed',
      executionError: true,
      required: true,
      continuationOutcome: 'stop_descendants',
    });

    expect(rows[1]).toMatchObject({ actionOutcome: 'not_executed', dependencySkipped: true });
    expect(rows[2].actionOutcome).toBeNull();
    expect(journal.selectNextRunnableStep(rows)?.stepId).toBe('public-proof');
  });

  it('blocks only one control transaction and releases the next independent control', () => {
    let rows = journal.initializeExecutionJournal({
      approvedSteps: [
        { id: 'time-open', action: 'Click', element: 'Early Pickup Time dropdown' },
        { id: 'time-wait', action: 'WaitForState', element: 'Early Pickup Time options', dependsOn: ['time-open'] },
        { id: 'time-select', action: 'Select', element: 'Early Pickup Time dropdown', dependsOn: ['time-open'] },
        { id: 'zone-open', action: 'Click', element: 'Early Pickup Time Zone dropdown', dependsOn: ['time-select'] },
        { id: 'zone-wait', action: 'WaitForState', element: 'Early Pickup Time Zone options', dependsOn: ['zone-open'] },
      ],
    });

    rows = journal.recordActionOutcome(rows, 'time-open', {
      outcome: 'failed',
      executionError: true,
      required: true,
      failureType: 'control_target_ambiguous',
      failureProven: true,
      reason: 'control_target_ambiguous',
    });

    expect(rows.find((row) => row.stepId === 'time-open')).toMatchObject({
      continuationOutcome: 'stop_descendants',
      affectedDescendantStepIds: ['time-wait', 'time-select'],
    });
    expect(rows.find((row) => row.stepId === 'time-wait')).toMatchObject({ actionOutcome: 'not_executed', dependencySkipped: true });
    expect(rows.find((row) => row.stepId === 'time-select')).toMatchObject({ actionOutcome: 'not_executed', dependencySkipped: true });
    expect(rows.find((row) => row.stepId === 'zone-open')).toMatchObject({
      actionOutcome: null,
      dependencyStepIds: [],
      dependencyReleaseReason: 'prior_control_transaction_failed_continue_independent',
    });
    expect(journal.selectNextRunnableStep(rows)?.stepId).toBe('zone-open');
  });

  it('delegates delivered opener observation uncertainty to the following typed control transaction', () => {
    let rows = journal.initializeExecutionJournal({
      approvedSteps: [
        {
          id: 'delivery-date-open',
          action: 'Click',
          element: 'Early Delivery Date calendar',
          operationCheck: { kind: 'menu_opened', required: true },
        },
        {
          id: 'delivery-date-wait',
          action: 'WaitForState',
          element: 'Early Delivery Date calendar',
        },
        {
          id: 'delivery-date-set',
          action: 'Date',
          element: 'Early Delivery Date calendar',
          value: '2026-08-21',
        },
      ],
    });

    rows = journal.recordActionOutcome(rows, 'delivery-date-open', {
      outcome: 'failed',
      required: true,
      dispatchStatus: 'delivered',
      reason: 'fresh_control_observation_unavailable',
      evidence: {
        kind: 'operation_check',
        matched: null,
        outcomeKind: 'qaai_execution_uncertainty',
        reason: 'fresh_control_observation_unavailable',
      },
    });

    expect(rows[0]).toMatchObject({
      actionOutcome: 'succeeded',
      continuationOutcome: 'continue',
      failureImpact: 'synchronization_delegated',
      status: 'pass',
    });
    expect(rows[1]).toMatchObject({ actionOutcome: null, dependencySkipped: false });
    expect(rows[2]).toMatchObject({ actionOutcome: null, dependencySkipped: false });
    expect(journal.selectNextRunnableStep(rows)?.stepId).toBe('delivery-date-wait');
  });

  it('records attempts, actions, assertions, and continuation as separate facts without mutating input', () => {
    const initial = journal.initializeExecutionJournal({
      approvedSteps: [{ id: 'password', action: 'Fill', description: 'Fill password' }],
      executionContract: {
        nodes: [{
          contractStepId: 'password-contract',
          stepOrdinal: 1,
          dataBinding: { reference: 'password', value: 'DontPersistMe', sensitive: true },
        }],
      },
    });

    const attempted = journal.recordAttempt(initial, 'password', {
      tool: 'browser_type',
      args: { element: 'Password', value: 'DontPersistMe', token: 'also-secret' },
      beforeFingerprint: { title: 'Sign in' },
    });
    const acted = journal.recordActionOutcome(attempted, 'password', {
      outcome: 'succeeded',
      observedState: { value: 'DontPersistMe' },
    });
    const asserted = journal.recordAssertionOutcome(acted, 'password', {
      assertionId: 'password-readback',
      outcome: 'matched',
      expected: 'DontPersistMe',
      observed: 'DontPersistMe',
    });
    const continued = journal.recordContinuationOutcome(asserted, 'password', 'continue');

    expect(initial[0].attempts).toEqual([]);
    expect(initial[0].actionOutcome).toBeNull();
    expect(attempted[0].attempts).toHaveLength(1);
    expect(acted[0].actionOutcome).toBe('succeeded');
    expect(asserted[0].assertionOutcome).toBe('matched');
    expect(continued[0]).toMatchObject({ continuationOutcome: 'continue', status: 'pass' });
    expect(JSON.stringify(continued)).not.toContain('DontPersistMe');
    expect(JSON.stringify(continued)).not.toContain('also-secret');
    expect(continued[0].attempts[0].args.element).toBe('Password');
  });

  it('continues after a non-blocking assertion mismatch and counts validation separately', () => {
    let rows = journal.initializeExecutionJournal({
      approvedSteps: [
        { id: 'open', action: 'Navigate', description: 'Open page' },
        { id: 'price', action: 'Verify', kind: 'assertion', description: 'Price is 10' },
        { id: 'footer', action: 'Screenshot', description: 'Capture footer' },
      ],
    });

    rows = journal.recordActionOutcome(rows, 'open', 'succeeded');
    expect(journal.selectNextRunnableStep(rows)?.stepId).toBe('price');
    rows = journal.recordAssertionOutcome(rows, 'price', {
      outcome: 'not_matched',
      expected: '10',
      observed: '12',
      comparator: 'number_equals',
    });

    expect(rows[1]).toMatchObject({
      actionOutcome: 'succeeded',
      assertionOutcome: 'not_matched',
      continuationOutcome: 'continue',
      failureImpact: 'validation_only',
      status: 'fail',
    });
    expect(journal.selectNextRunnableStep(rows)?.stepId).toBe('footer');

    rows = journal.recordActionOutcome(rows, 'footer', 'succeeded');
    rows = journal.finalizeExecutionJournal(rows);
    expect(journal.projectExecutionJournal(rows)).toMatchObject({
      planned: 3,
      executed: 3,
      passed: 2,
      validationFailed: 1,
      executionErrors: 0,
      dependencySkipped: 0,
      executionCompleted: true,
    });
  });

  it.each([
    ['text', { expected: 'Ready', observed: 'Pending', comparator: 'text_equals' }],
    ['number', { expected: 10, observed: 12, comparator: 'number_equals' }],
    ['visible', { expected: true, observed: false, comparator: 'visible' }],
  ])('continues after a non-blocking %s assertion mismatch', (_channel, assertion) => {
    let rows = journal.initializeExecutionJournal({
      approvedSteps: [
        { id: 'observe', action: 'Verify', kind: 'assertion' },
        { id: 'independent-check', action: 'Screenshot', independent: true },
      ],
    });

    rows = journal.recordAssertionOutcome(rows, 'observe', {
      outcome: 'not_matched',
      ...assertion,
    });

    expect(rows[0]).toMatchObject({
      actionOutcome: 'succeeded',
      assertionOutcome: 'not_matched',
      continuationOutcome: 'continue',
      failureImpact: 'validation_only',
    });
    expect(journal.selectNextRunnableStep(rows)?.stepId).toBe('independent-check');
  });

  it('keeps authored requiredForContinuation from overriding non-blocking assertion policy', () => {
    let rows = journal.initializeExecutionJournal({
      approvedSteps: [
        { id: 'required-banner', action: 'Verify', requiredForContinuation: true },
        { id: 'dependent-submit', action: 'Click', dependsOnStepIds: ['required-banner'] },
        { id: 'public-proof', action: 'Screenshot', independent: true },
      ],
    });

    rows = journal.recordAssertionOutcome(rows, 'required-banner', {
      outcome: 'not_matched',
      expected: 'Signed in',
      observed: 'Sign in',
    });

    expect(rows[0]).toMatchObject({
      requiredForContinuation: true,
      actionOutcome: 'succeeded',
      assertionOutcome: 'not_matched',
      continuationOutcome: 'continue',
      continuationPolicyDecision: {
        outcome: 'continue',
        reason: 'assertion_failed_continue_independent',
        blockDependents: false,
      },
    });
    expect(rows[1]).toMatchObject({ actionOutcome: null, dependencySkipped: false });
    expect(rows[2].actionOutcome).toBeNull();
    expect(journal.selectNextRunnableStep(rows)?.stepId).toBe('dependent-submit');
  });

  it('continues after explicitly non-blocking evidence is unavailable for a successful action', () => {
    let rows = journal.initializeExecutionJournal({
      approvedSteps: [
        { id: 'navigate', action: 'Navigate', requiredForContinuation: true },
        { id: 'landing-wait', action: 'WaitForState', dependsOnStepIds: ['navigate'] },
        { id: 'fill-field', action: 'Fill', dependsOnStepIds: ['landing-wait'] },
      ],
    });
    rows = journal.recordActionOutcome(rows, 'navigate', {
      outcome: 'succeeded',
      reason: 'browser_navigation_dispatched',
    });
    rows = journal.recordAssertionOutcome(rows, 'navigate', {
      outcome: 'uncheckable',
      matched: null,
      reason: 'qaai_validation_snapshot_unavailable',
      blocking: false,
      requiredForContinuation: false,
    });

    expect(rows[0]).toMatchObject({
      actionOutcome: 'succeeded',
      assertionOutcome: 'uncheckable',
      continuationOutcome: 'continue',
      failureImpact: 'validation_only',
    });
    expect(rows[1].actionOutcome).toBeNull();
    expect(journal.selectNextRunnableStep(rows)?.stepId).toBe('landing-wait');
  });

  it('prefers a retryable current step by stable ID and clears transient failure state after success', () => {
    let rows = journal.initializeExecutionJournal({
      approvedSteps: [
        { id: 'open', action: 'Navigate' },
        { id: 'email', action: 'Fill' },
        { id: 'submit', action: 'Click' },
      ],
    });
    rows = journal.recordActionOutcome(rows, 'open', 'succeeded');
    rows = journal.recordActionOutcome(rows, 'email', {
      outcome: 'failed',
      failureType: 'transient_evidence',
      temporarilyUnavailable: true,
      observation: { status: 'snapshot_temporarily_unavailable' },
      reason: 'The first snapshot was stale.',
    });

    expect(rows[1]).toMatchObject({
      actionOutcome: 'failed',
      continuationOutcome: 'retry',
      status: 'pending',
    });
    expect(rows[2]).toMatchObject({ actionOutcome: null, dependencySkipped: false });
    expect(journal.selectNextRunnableStep([...rows].reverse())?.stepId).toBe('email');
    expect(journal.projectExecutionJournal(rows)).toMatchObject({
      retryPending: 1,
      executionCompleted: false,
      executionIncomplete: true,
    });

    rows = journal.recordAttempt(rows, 'email', { tool: 'browser_type', attemptKind: 'retry' });
    rows = journal.recordActionOutcome(rows, 'email', 'succeeded');
    expect(rows[1]).toMatchObject({
      actionOutcome: 'succeeded',
      continuationOutcome: 'continue',
      executionError: false,
      failureImpact: null,
      error: null,
      status: 'pass',
    });
    expect(rows[1].attempts).toHaveLength(1);
    expect(journal.selectNextRunnableStep(rows)?.stepId).toBe('submit');
  });

  it('reopens an exact upstream input prerequisite before retrying the dependent action', () => {
    let rows = journal.initializeExecutionJournal({
      approvedSteps: [
        { id: 'password', action: 'Fill', element: 'Microsoft password field' },
        { id: 'sign-in', action: 'Click', element: 'Sign in button' },
        { id: 'dashboard', action: 'Verify', expected: 'Dashboard visible' },
        { id: 'independent-proof', action: 'Screenshot', independent: true },
      ],
    });
    rows = journal.recordActionOutcome(rows, 'password', 'succeeded');
    rows = journal.recordActionOutcome(rows, 'sign-in', {
      outcome: 'failed',
      required: true,
      evidence: {
        matched: false,
        reason: 'auth_submit_rejected',
        evidence: 'The page is still asking for a password.',
        args: { verify: { kind: 'action_completed' } },
      },
    });

    const recovery = journal.schedulePrerequisiteRetry(rows, 'sign-in', {
      requiredInputKind: 'password',
      cause: 'required_input_missing_after_submit',
      maxRetries: 1,
    });
    rows = recovery.journal;

    expect(recovery).toMatchObject({
      scheduled: true,
      exhausted: false,
      predecessorStepId: 'password',
      failedStepId: 'sign-in',
      retryCount: 1,
    });
    expect(rows.find((row) => row.stepId === 'password')).toMatchObject({
      actionOutcome: 'succeeded',
      continuationOutcome: 'retry',
      retryCount: 1,
      invalidatedByStepId: 'sign-in',
      failureImpact: 'prerequisite_invalidated',
    });
    expect(rows.find((row) => row.stepId === 'sign-in')).toMatchObject({
      actionOutcome: 'succeeded',
      continuationOutcome: 'retry',
      recoveryWaitingForStepId: 'password',
      failureOwner: 'transient',
    });
    expect(rows.find((row) => row.stepId === 'dashboard').actionOutcome).toBeNull();
    expect(journal.selectNextRunnableStep([...rows].reverse())?.stepId).toBe('password');

    rows = journal.recordAttempt(rows, 'password', { tool: 'browser_fill_form', attemptKind: 'causal_recovery' });
    rows = journal.recordActionOutcome(rows, 'password', 'succeeded');
    expect(journal.selectNextRunnableStep(rows)?.stepId).toBe('sign-in');

    rows = journal.recordActionOutcome(rows, 'sign-in', {
      outcome: 'succeeded',
      evidence: {
        matched: true,
        reason: 'auth_submit_confirmed',
        args: { verify: { kind: 'action_completed' } },
      },
    });
    expect(rows.find((row) => row.stepId === 'sign-in')).toMatchObject({
      actionOutcome: 'succeeded',
      assertionOutcome: 'matched',
      continuationOutcome: 'continue',
      status: 'pass',
    });
    expect(journal.selectNextRunnableStep(rows)?.stepId).toBe('dashboard');
  });

  it('rejects causal recovery to a step that is not an upstream dependency', () => {
    let rows = journal.initializeExecutionJournal({
      approvedSteps: [
        { id: 'password', action: 'Fill', element: 'Password' },
        { id: 'sign-in', action: 'Click', independent: true },
      ],
    });
    rows = journal.recordActionOutcome(rows, 'password', 'succeeded');
    rows = journal.recordActionOutcome(rows, 'sign-in', {
      outcome: 'failed',
      required: true,
      reason: 'Password is required.',
    });

    expect(() => journal.schedulePrerequisiteRetry(rows, 'sign-in', {
      predecessorStepRef: 'password',
      requiredInputKind: 'password',
    })).toThrow(/not upstream/);
  });

  it('allows one causal recovery and terminalizes the exhausted chain as a QAAI execution error', () => {
    let rows = journal.initializeExecutionJournal({
      approvedSteps: [
        { id: 'password', action: 'Fill', element: 'Password' },
        { id: 'sign-in', action: 'Click' },
        { id: 'private-dashboard', action: 'Verify' },
        { id: 'independent-proof', action: 'Screenshot', independent: true },
      ],
    });
    rows = journal.recordActionOutcome(rows, 'password', 'succeeded');
    rows = journal.recordActionOutcome(rows, 'sign-in', {
      outcome: 'failed',
      required: true,
      reason: 'Password is required.',
    });
    rows = journal.schedulePrerequisiteRetry(rows, 'sign-in', {
      requiredInputKind: 'password',
      maxRetries: 1,
    }).journal;
    rows = journal.recordActionOutcome(rows, 'password', 'succeeded');
    rows = journal.recordActionOutcome(rows, 'sign-in', {
      outcome: 'failed',
      required: true,
      reason: 'Password is still required.',
    });

    const exhausted = journal.schedulePrerequisiteRetry(rows, 'sign-in', {
      requiredInputKind: 'password',
      maxRetries: 1,
    });
    rows = exhausted.journal;

    expect(exhausted).toMatchObject({ scheduled: false, exhausted: true, retryCount: 1, maxRetries: 1 });
    expect(rows.find((row) => row.stepId === 'password')).toMatchObject({ retryExhausted: true });
    expect(rows.find((row) => row.stepId === 'sign-in')).toMatchObject({
      executionError: true,
      failureType: 'required_input_recovery_exhausted',
      failureOwner: 'qaai',
      continuationOutcome: 'stop_descendants',
      retryExhausted: true,
      status: 'blocked',
    });
    expect(rows.find((row) => row.stepId === 'private-dashboard')).toMatchObject({
      actionOutcome: 'not_executed',
      dependencySkipped: true,
    });
    expect(journal.selectNextRunnableStep(rows)?.stepId).toBe('independent-proof');
    expect(journal.projectExecutionJournal(rows)).toMatchObject({ retryPending: 0, executionErrors: 1 });
  });

  it('finalizes an interrupted causal recovery without leaving a pending retry loop', () => {
    let rows = journal.initializeExecutionJournal({
      approvedSteps: [
        { id: 'password', action: 'Fill', element: 'Password' },
        { id: 'sign-in', action: 'Click' },
        { id: 'dashboard', action: 'Verify' },
      ],
    });
    rows = journal.recordActionOutcome(rows, 'password', 'succeeded');
    rows = journal.recordActionOutcome(rows, 'sign-in', {
      outcome: 'failed',
      required: true,
      reason: 'Password is required.',
    });
    rows = journal.schedulePrerequisiteRetry(rows, 'sign-in', {
      requiredInputKind: 'password',
      maxRetries: 1,
    }).journal;

    rows = journal.finalizeExecutionJournal(rows, { reason: 'Case ended before bounded recovery completed.' });

    expect(rows.find((row) => row.stepId === 'sign-in')).toMatchObject({
      executionError: true,
      failureType: 'prerequisite_recovery_not_completed',
      continuationOutcome: 'stop_descendants',
      retryExhausted: true,
      status: 'blocked',
    });
    expect(journal.projectExecutionJournal(rows)).toMatchObject({
      retryPending: 0,
      executionErrors: 1,
      executionFinalized: true,
    });
  });

  it.each(['login_failed', 'wrong_page'])('stops only dependent descendants after %s', (failureType) => {
    let rows = journal.initializeExecutionJournal({
      approvedSteps: [
        { id: 'entry', action: 'Click' },
        { id: 'private-check', action: 'Verify', dependsOnStepIds: ['entry'] },
        { id: 'public-check', action: 'Screenshot', independent: true },
      ],
    });

    rows = journal.recordActionOutcome(rows, 'entry', {
      outcome: 'failed',
      failureType,
      executionError: false,
      observedProductRejection: failureType === 'login_failed',
      assertionMismatch: failureType === 'wrong_page',
      required: true,
      reason: failureType === 'login_failed' ? 'Authentication was rejected.' : 'Destination page did not match.',
    });

    expect(rows[0]).toMatchObject({
      actionOutcome: 'failed',
      continuationOutcome: 'stop_descendants',
      executionError: false,
      failureImpact: failureType,
    });
    expect(rows[1]).toMatchObject({ actionOutcome: 'not_executed', dependencySkipped: true });
    expect(rows[2].actionOutcome).toBeNull();
    expect(journal.selectNextRunnableStep(rows)?.stepId).toBe('public-check');
  });

  it('continues when an optional target is absent', () => {
    let rows = journal.initializeExecutionJournal({
      approvedSteps: [
        { id: 'dismiss-popup', action: 'Click', optional: true },
        { id: 'continue-flow', action: 'Click' },
      ],
    });
    rows = journal.recordActionOutcome(rows, 'dismiss-popup', {
      outcome: 'failed',
      optionalAbsent: true,
      failureType: 'optional_popup_absent',
      reason: 'Optional popup was not present.',
    });

    expect(rows[0]).toMatchObject({
      actionOutcome: 'succeeded',
      assertionOutcome: 'not_applicable',
      continuationOutcome: 'continue',
      failureImpact: 'optional_absent',
      executionError: false,
      status: 'pass',
    });
    expect(journal.selectNextRunnableStep(rows)?.stepId).toBe('continue-flow');
  });

  it('never serializes evidence objects as journal reasons and explains optional absence', () => {
    let rows = journal.initializeExecutionJournal({
      approvedSteps: [
        { id: 'save', action: 'Click' },
        { id: 'dismiss-if-visible', action: 'Dismiss if visible', optional: true },
      ],
    });
    rows = journal.recordActionOutcome(rows, 'save', {
      outcome: 'succeeded',
      evidence: { matched: true, operationCheck: { kind: 'action_completed' } },
    });
    rows = journal.recordActionOutcome(rows, 'dismiss-if-visible', {
      outcome: 'failed',
      optionalAbsent: true,
      failureType: 'optional_target_absent',
      evidence: { code: 'optional_target_absent', matched: false },
    });

    expect(rows[0].continuationReason).toBeNull();
    expect(rows[1].continuationReason).toBe('Optional target was absent; execution continued.');
    expect(JSON.stringify(rows)).not.toContain('[object Object]');
  });

  it('preserves authored if-visible intent even when a normalized step defaults required to true', () => {
    const optionalRows = journal.initializeExecutionJournal({
      approvedSteps: [
        {
          id: 'dismiss-if-visible',
          action: 'Dismiss if visible',
          description: 'Dismiss the post-action prompt when it is present.',
          required: true,
        },
      ],
    });

    expect(optionalRows[0]).toMatchObject({
      required: false,
      optional: true,
      conditionalPresence: true,
    });

    const requiredRows = journal.initializeExecutionJournal({
      approvedSteps: [
        {
          id: 'conditional-required-control',
          action: 'Click if visible',
          required: true,
        },
      ],
      executionContract: {
        nodes: [{
          contractStepId: 'conditional-required-control',
          stepOrdinal: 1,
          actionType: 'click',
          contract: { required: true },
        }],
      },
    });

    expect(requiredRows[0]).toMatchObject({
      required: true,
      optional: false,
      conditionalPresence: true,
    });
  });

  it('classifies ambiguous target selection as a QAAI execution failure', () => {
    let rows = journal.initializeExecutionJournal({ approvedSteps: actionSteps() });
    rows = journal.recordActionOutcome(rows, 'open', {
      outcome: 'failed',
      failureType: 'ambiguous_target',
      reason: 'Two equal-score targets remained after deterministic resolution.',
    });

    expect(rows[0]).toMatchObject({
      actionOutcome: 'failed',
      executionError: true,
      failureType: 'ambiguous_target',
      failureOwner: 'qaai',
      failureImpact: 'execution_error',
      continuationOutcome: 'stop_descendants',
      status: 'blocked',
    });
    expect(rows.find((row) => row.stepId === 'independent').actionOutcome).toBeNull();
    expect(journal.selectNextRunnableStep(rows)?.stepId).toBe('independent');
  });

  it('classifies exhausted page-transition evidence as QAAI execution failure, never product failure', () => {
    let rows = journal.initializeExecutionJournal({
      approvedSteps: [
        { id: 'open-destination', action: 'Click' },
        { id: 'dependent-check', action: 'Verify' },
        { id: 'independent-proof', action: 'Screenshot', independent: true },
      ],
    });
    rows = journal.recordActionOutcome(rows, 'open-destination', {
      outcome: 'failed',
      required: true,
      executionError: true,
      failureType: 'qaai_transition_evidence_inconclusive',
      reason: 'Stable transition evidence was unavailable after the bounded observer recovery.',
    });

    expect(rows[0]).toMatchObject({
      actionOutcome: 'failed',
      executionError: true,
      failureOwner: 'qaai',
      failureImpact: 'execution_error',
      continuationOutcome: 'stop_descendants',
      status: 'blocked',
    });
    expect(rows[0].failureOwner).not.toBe('product');
    expect(rows[1]).toMatchObject({ actionOutcome: 'not_executed', dependencySkipped: true });
    expect(journal.selectNextRunnableStep(rows)?.stepId).toBe('independent-proof');
  });

  it('stops only descendants after a required action failure and selects an independent step', () => {
    let rows = journal.initializeExecutionJournal({ approvedSteps: actionSteps() });
    rows = journal.recordActionOutcome(rows, 'open', 'succeeded');
    rows = journal.recordAttempt(rows, 'email', { tool: 'browser_type', target: 'Email' });
    rows = journal.recordActionOutcome(rows, 'email', {
      outcome: 'failed',
      required: true,
      executionError: true,
      reason: 'Required email field was not found after one re-resolution.',
    });

    expect(rows.find((row) => row.stepId === 'submit')).toMatchObject({
      actionOutcome: 'not_executed',
      dependencySkipped: true,
      status: 'skipped',
    });
    expect(rows.find((row) => row.stepId === 'destination')).toMatchObject({
      actionOutcome: 'not_executed',
      dependencySkipped: true,
      status: 'skipped',
    });
    expect(rows.find((row) => row.stepId === 'independent').actionOutcome).toBeNull();
    expect(journal.selectNextRunnableStep(rows)?.stepId).toBe('independent');

    rows = journal.recordActionOutcome(rows, 'independent', 'succeeded');
    rows = journal.finalizeExecutionJournal(rows);
    expect(journal.projectExecutionJournal(rows)).toMatchObject({
      planned: 5,
      executed: 3,
      passed: 2,
      validationFailed: 0,
      executionErrors: 1,
      dependencySkipped: 2,
      notExecuted: 2,
      executionCompleted: false,
      executionIncomplete: true,
      executionFinalized: true,
    });
  });

  it('uses explicit dependency edges and preserves explicitly independent roots', () => {
    const rows = journal.initializeExecutionJournal({
      approvedSteps: [
        { id: 'a', action: 'Navigate' },
        { id: 'b', action: 'Fill' },
        { id: 'c', action: 'Screenshot', independent: true },
      ],
      executionContract: {
        nodes: [
          { contractStepId: 'a', stepOrdinal: 1 },
          { contractStepId: 'b', stepOrdinal: 2 },
          { contractStepId: 'c', stepOrdinal: 3 },
        ],
        dependencyGraph: {
          edges: [{ from: 'a', to: 'b' }],
          dependenciesByStepId: { c: [] },
        },
      },
    });

    expect(rows.find((row) => row.stepId === 'b').dependencyStepIds).toEqual(['a']);
    expect(rows.find((row) => row.stepId === 'c').dependencyStepIds).toEqual([]);
  });

  it('finalizes untouched pending rows as not_executed and never synthesizes passes', () => {
    const rows = journal.initializeExecutionJournal({
      approvedSteps: [
        { id: 'one', action: 'Navigate' },
        { id: 'two', action: 'Click' },
      ],
    });

    const finalized = journal.finalizeExecutionJournal(rows, { reason: 'Run cancelled.' });
    expect(finalized.map((row) => row.actionOutcome)).toEqual(['not_executed', 'not_executed']);
    expect(finalized.map((row) => row.status)).toEqual(['skipped', 'skipped']);
    expect(finalized[0].continuationReason).toBe('Run cancelled.');
    expect(journal.projectExecutionJournal(finalized)).toMatchObject({
      planned: 2,
      executed: 0,
      passed: 0,
      notExecuted: 2,
      executionCompleted: false,
      executionIncomplete: true,
      executionFinalized: true,
    });
  });

  it('keeps an action-owned visible miss in the assertion channel and continues when nonblocking', () => {
    let rows = journal.initializeExecutionJournal({
      approvedSteps: [
        { id: 'open', action: 'Navigate', description: 'Open the classifier' },
        { id: 'email', action: 'Fill', description: 'Fill Email Address' },
      ],
    });

    rows = journal.recordActionOutcome(rows, 'open', {
      outcome: 'failed',
      failureType: 'product_failure',
      reason: 'visible_not_confirmed',
      evidence: {
        kind: 'operation_check',
        matched: false,
        reason: 'visible_not_confirmed',
        args: { verify: { kind: 'visible', element: { role: 'textbox', name: 'Email Address' } } },
      },
    });

    expect(rows[0]).toMatchObject({
      actionOutcome: 'succeeded',
      assertionOutcome: 'not_matched',
      continuationOutcome: 'continue',
      failureImpact: 'validation_only',
      executionError: false,
      status: 'fail',
    });
    expect(journal.selectNextRunnableStep(rows)?.stepId).toBe('email');
  });

  it('keeps an explicitly blocking UI postcondition non-blocking under central policy', () => {
    let rows = journal.initializeExecutionJournal({
      approvedSteps: [
        { id: 'open', action: 'Navigate', requiredForContinuation: true },
        { id: 'email', action: 'Fill' },
        { id: 'public', action: 'Screenshot', independent: true },
      ],
    });
    rows = journal.recordActionOutcome(rows, 'open', {
      outcome: 'failed',
      reason: 'visible_not_confirmed',
      evidence: {
        kind: 'operation_check', matched: false,
        args: { verify: { kind: 'visible' } },
      },
    });

    expect(rows.find((row) => row.stepId === 'open')).toMatchObject({
      actionOutcome: 'succeeded',
      assertionOutcome: 'not_matched',
      continuationOutcome: 'continue',
      continuationPolicyDecision: {
        outcome: 'continue',
        reason: 'assertion_failed_continue_independent',
        blockDependents: false,
      },
    });
    expect(rows.find((row) => row.stepId === 'email')).toMatchObject({ actionOutcome: null, dependencySkipped: false });
    expect(journal.selectNextRunnableStep(rows)?.stepId).toBe('email');
  });

  it('retains assertion retry history but projects the latest observation per stable assertion id', () => {
    let rows = journal.initializeExecutionJournal({
      approvedSteps: [{ id: 'price-check', action: 'Verify', assertionStep: true }],
    });

    rows = journal.recordAssertionOutcome(rows, 'price-check', {
      assertionId: 'assert-price',
      outcome: 'not_matched',
      expected: '$10',
      actual: '$9',
    });
    rows = journal.recordAssertionOutcome(rows, 'price-check', {
      assertionId: 'assert-price',
      outcome: 'matched',
      expected: '$10',
      actual: '$10',
    });

    expect(rows[0].assertionOutcomes).toHaveLength(2);
    expect(rows[0].assertionOutcome).toBe('matched');
    expect(rows[0].status).toBe('pass');
    expect(journal.projectExecutionJournal(rows)).toMatchObject({
      validationFailed: 0,
      passed: 1,
    });
  });

  it('counts the latest failures of two distinct assertions independently', () => {
    let rows = journal.initializeExecutionJournal({
      approvedSteps: [{ id: 'collection-check', action: 'Verify', assertionStep: true }],
    });

    rows = journal.recordAssertionOutcome(rows, 'collection-check', {
      assertionId: 'assert-first-option', outcome: 'not_matched',
    });
    rows = journal.recordAssertionOutcome(rows, 'collection-check', {
      assertionId: 'assert-second-option', outcome: 'not_matched',
    });

    expect(rows[0].assertionOutcomes).toHaveLength(2);
    expect(rows[0].assertionOutcome).toBe('not_matched');
    expect(journal.projectExecutionJournal(rows)).toMatchObject({ validationFailed: 2 });
  });

  it('reconciles a failed action projection when its authoritative operation check passed', () => {
    let rows = journal.initializeExecutionJournal({
      approvedSteps: [{ id: 'apply-state', action: 'Click', description: 'Apply a neutral state' }],
    });
    rows = journal.recordAttempt(rows, 'apply-state', {
      tool: 'browser_click',
      actualOutcome: 'failed',
      reason: 'The immediate observer was inconclusive.',
    });
    rows = journal.recordActionOutcome(rows, 'apply-state', {
      outcome: 'failed',
      executionError: true,
      failureType: 'evidence_missing',
      reason: 'The immediate observer was inconclusive.',
      evidence: {
        operationCheck: {
          status: 'pass',
          checked: true,
          matched: true,
          kind: 'effect',
          reason: 'Exact effect state confirmed.',
        },
      },
    });

    expect(rows[0]).toMatchObject({
      actionOutcome: 'succeeded',
      executionError: false,
      executionErrorReason: null,
      failureType: null,
      failureOwner: null,
      status: 'pass',
    });
    expect(rows[0].attempts).toEqual([
      expect.objectContaining({
        actualOutcome: 'failed',
        reason: 'The immediate observer was inconclusive.',
      }),
    ]);
    expect(rows[0].evidence).toMatchObject({
      operationCheck: { status: 'pass', matched: true },
    });
    expect(rows[0].reconciliationHistory).toEqual([
      expect.objectContaining({ kind: 'authoritative_operation_proof' }),
    ]);
  });

  it('ratifies an evidence-uncertain action from a directly dependent exact readback', () => {
    let rows = uncertainActionAndReadback();
    const priorAttempts = rows[0].attempts;
    const priorEvidence = rows[0].evidence;

    rows = journal.recordAssertionOutcome(rows, 'choice-readback', {
      assertionId: 'choice-readback-exact',
      outcome: 'matched',
      matched: true,
      status: 'pass',
      kind: 'value',
      comparator: 'equals',
      expected: 'Choice Alpha',
      actual: 'Choice Alpha',
      source: 'exact_control_readback',
    });

    expect(rows[0]).toMatchObject({
      actionOutcome: 'succeeded',
      executionError: false,
      executionErrorReason: null,
      failureType: null,
      failureOwner: null,
      reconciledByStepId: 'choice-readback',
      status: 'pass',
    });
    expect(rows[0].attempts).toEqual(priorAttempts);
    expect(rows[0].evidence).toEqual(priorEvidence);
    expect(rows[0].reconciliationHistory.at(-1)).toMatchObject({
      kind: 'dependent_exact_assertion_ratification',
      assertionStepId: 'choice-readback',
      assertionId: 'choice-readback-exact',
      priorActionOutcome: 'failed',
      priorExecutionError: true,
    });
    expect(rows[1]).toMatchObject({
      actionOutcome: 'succeeded',
      assertionOutcome: 'matched',
      status: 'pass',
    });
    expect(journal.selectNextRunnableStep(rows)?.stepId).toBe('continue-flow');
  });

  it.each(['not_matched', 'uncheckable'])(
    'never ratifies an evidence-uncertain action from a %s readback',
    (outcome) => {
      let rows = uncertainActionAndReadback();
      const priorAttempts = rows[0].attempts;
      const priorEvidence = rows[0].evidence;

      rows = journal.recordAssertionOutcome(rows, 'choice-readback', {
        assertionId: 'choice-readback-exact',
        outcome,
        matched: outcome === 'not_matched' ? false : null,
        status: outcome === 'not_matched' ? 'fail' : 'uncheckable',
        kind: 'value',
        comparator: 'equals',
        expected: 'Choice Alpha',
        actual: outcome === 'not_matched' ? 'Choice Beta' : null,
        source: 'exact_control_readback',
      });

      expect(rows[0]).toMatchObject({
        actionOutcome: 'failed',
        executionError: true,
        failureType: 'evidence_missing',
      });
      expect(rows[0].attempts).toEqual(priorAttempts);
      expect(rows[0].evidence).toEqual(priorEvidence);
      expect(rows[0].reconciliationHistory).toEqual([]);
    },
  );

  it('does not ratify from a partial-match assertion', () => {
    let rows = uncertainActionAndReadback();
    rows = journal.recordAssertionOutcome(rows, 'choice-readback', {
      assertionId: 'choice-readback-contains',
      outcome: 'matched',
      matched: true,
      status: 'pass',
      kind: 'text',
      comparator: 'contains',
      expected: 'Choice',
      actual: 'Choice Alpha',
      source: 'control_text_assertion',
    });

    expect(rows[0]).toMatchObject({
      actionOutcome: 'failed',
      executionError: true,
      failureType: 'evidence_missing',
    });
    expect(rows[0].reconciliationHistory).toEqual([]);
  });
});
