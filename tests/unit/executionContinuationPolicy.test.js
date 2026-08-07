import { describe, expect, it } from 'vitest';
import policy from '../../server/services/executionContinuationPolicy';

const {
  CONTINUATION_OUTCOME,
  decideContinuation,
  evaluateDependentCaseStart,
  evaluateSessionContinuity,
} = policy;

describe('executionContinuationPolicy', () => {
  describe('wait synchronization', () => {
    it('treats WaitForState as internal synchronization without a step verdict', () => {
      const result = decideContinuation({
        kind: 'WaitForState',
        status: 'satisfied',
      });

      expect(result).toMatchObject({
        outcome: CONTINUATION_OUTCOME.CONTINUE,
        continueExecution: true,
        synchronizationOnly: true,
        stepVerdict: null,
        reason: 'synchronization_satisfied',
      });
    });

    it('retries observation without redispatch while synchronization is pending', () => {
      const result = decideContinuation({
        kind: 'wait_for_state',
        evidenceStatus: 'temporarily_unavailable',
      });

      expect(result).toMatchObject({
        outcome: CONTINUATION_OUTCOME.RETRY_OBSERVATION,
        retryObservation: true,
        redispatchAction: false,
        synchronizationOnly: true,
        stepVerdict: null,
      });
    });

    it('does not turn an exhausted wait budget into a failed or blocked verdict', () => {
      const result = decideContinuation({
        kind: 'WaitForState',
        status: 'not_satisfied',
        observationBudgetExhausted: true,
      });

      expect(result).toMatchObject({
        outcome: CONTINUATION_OUTCOME.CONTINUE,
        continueExecution: true,
        synchronizationOnly: true,
        synchronizationTimedOut: true,
        stepVerdict: null,
        blockDependents: false,
      });
    });
  });

  describe('assertion continuation', () => {
    it.each(['assert_text', 'count', 'visual', 'ui_match'])(
      'records %s mismatch as failed and continues independent steps',
      (kind) => {
        const result = decideContinuation({ kind, status: 'mismatch' });

        expect(result).toMatchObject({
          outcome: CONTINUATION_OUTCOME.CONTINUE,
          continueExecution: true,
          continueIndependent: true,
          blockDependents: false,
          stepVerdict: 'failed',
          nonBlockingValidationFailure: true,
        });
      },
    );

    it('retries only assertion observation when evidence is temporarily unavailable', () => {
      const result = decideContinuation({
        kind: 'assert_visible',
        evidence: { status: 'snapshot_temporarily_unavailable' },
      });

      expect(result).toMatchObject({
        outcome: CONTINUATION_OUTCOME.RETRY_OBSERVATION,
        retryObservation: true,
        redispatchAction: false,
        stepVerdict: null,
      });
    });

    it('records exhausted inconclusive assertion evidence without blocking', () => {
      const result = decideContinuation({
        kind: 'assert_visible',
        evidenceStatus: 'temporarily_unavailable',
        observationBudgetExhausted: true,
      });

      expect(result).toMatchObject({
        outcome: CONTINUATION_OUTCOME.CONTINUE,
        stepVerdict: 'unverified',
        blockDependents: false,
      });
    });
  });

  describe('actions, navigation, and optional targets', () => {
    it('blocks only dependent steps when a required input action is proven impossible', () => {
      const result = decideContinuation({
        kind: 'fill',
        status: 'failed',
        required: true,
        inabilityProven: true,
      });

      expect(result).toMatchObject({
        outcome: CONTINUATION_OUTCOME.BLOCK_DEPENDENTS,
        continueExecution: false,
        continueIndependent: true,
        blockDependents: true,
        stopRun: false,
        scope: 'step_dependents',
        reason: 'required_action_inability_proven',
      });
    });

    it('blocks session-dependent steps for a proven required navigation failure', () => {
      const result = decideContinuation({
        kind: 'navigation',
        status: 'failed',
        required: true,
        failureProven: true,
      });

      expect(result).toMatchObject({
        outcome: CONTINUATION_OUTCOME.BLOCK_DEPENDENTS,
        continueIndependent: true,
        scope: 'session_dependents',
        reason: 'required_navigation_failure_proven',
      });
    });

    it('never redispatches an action merely because evidence is temporarily unavailable', () => {
      const result = decideContinuation({
        kind: 'select',
        observation: { status: 'capture_pending' },
      });

      expect(result).toMatchObject({
        outcome: CONTINUATION_OUTCOME.RETRY_OBSERVATION,
        retryObservation: true,
        redispatchAction: false,
      });
    });

    it('skips an absent optional target and continues', () => {
      const result = decideContinuation({
        kind: 'click',
        optional: true,
        targetPresent: false,
      });

      expect(result).toMatchObject({
        outcome: CONTINUATION_OUTCOME.CONTINUE,
        stepVerdict: 'skipped',
        optionalTargetAbsent: true,
        blockDependents: false,
        reason: 'optional_target_absent',
      });
    });

    it('records an independent optional action failure without blocking', () => {
      const result = decideContinuation({
        kind: 'click',
        required: false,
        status: 'failed',
      });

      expect(result).toMatchObject({
        outcome: CONTINUATION_OUTCOME.CONTINUE,
        stepVerdict: 'failed',
        blockDependents: false,
      });
    });
  });

  describe('environment and session impossibility', () => {
    it('returns environment_issue for a proven issue that does not make the run impossible', () => {
      const result = decideContinuation({
        kind: 'environment',
        status: 'failed',
        proven: true,
        impossible: false,
      });

      expect(result).toMatchObject({
        outcome: CONTINUATION_OUTCOME.ENVIRONMENT_ISSUE,
        stopRun: false,
        scope: 'environment',
      });
    });

    it('uses stop_run only for proven environment impossibility', () => {
      const result = decideContinuation({
        kind: 'environment',
        failureProven: true,
        runImpossible: true,
      });

      expect(result).toMatchObject({
        outcome: CONTINUATION_OUTCOME.STOP_RUN,
        stopRun: true,
        continueIndependent: false,
        scope: 'run',
        reason: 'proven_environment_impossibility',
      });
    });

    it('blocks only session dependents for a proven recoverable session failure', () => {
      const result = decideContinuation({
        kind: 'session',
        status: 'failed',
        proven: true,
      });

      expect(result).toMatchObject({
        outcome: CONTINUATION_OUTCOME.BLOCK_DEPENDENTS,
        stopRun: false,
        scope: 'session_dependents',
        reason: 'proven_session_failure',
      });
    });
  });

  describe('dependent-case session continuation', () => {
    function sessionContext() {
      return {
        browser: { id: 'browser-object' },
        context: { id: 'context-object' },
        page: { id: 'page-object' },
        sessionToken: 'continuation-token',
      };
    }

    it('reuses the exact prior browser, context, page, and session token', () => {
      const context = sessionContext();
      const result = evaluateDependentCaseStart({
        previousCase: {
          committed: true,
          sessionUsable: true,
          sessionContext: context,
        },
      });

      expect(result).toMatchObject({
        outcome: CONTINUATION_OUTCOME.CONTINUE,
        continueExecution: true,
        reason: 'dependency_committed_session_preserved',
        nonBlockingAssertionFailuresAllowed: true,
      });
      expect(result.contextToReuse).toBe(context);
      expect(result.sessionContinuity.mustReuseExactContext).toBe(true);
    });

    it('starts a dependent case after non-blocking assertion failures', () => {
      const context = sessionContext();
      const result = evaluateDependentCaseStart({
        previousCase: {
          terminalState: { committed: true },
          sessionContext: context,
          failures: [
            { kind: 'assertion', blocking: false, outcome: 'continue' },
            { kind: 'assertion', blocking: false, outcome: 'continue' },
          ],
        },
        nextSessionContext: context,
      });

      expect(result).toMatchObject({
        outcome: CONTINUATION_OUTCOME.CONTINUE,
        blockDependents: false,
        nonBlockingAssertionFailuresAllowed: true,
      });
    });

    it('rejects a dependent case when any browser-session identity changes', () => {
      const previous = sessionContext();
      const next = { ...previous, page: { id: 'replacement-page' } };
      const continuity = evaluateSessionContinuity(previous, next);
      const result = evaluateDependentCaseStart({
        previousCase: { committed: true, sessionContext: previous },
        nextSessionContext: next,
      });

      expect(continuity).toMatchObject({
        valid: false,
        reason: 'session_continuity_mismatch',
        mismatches: ['page'],
      });
      expect(result).toMatchObject({
        outcome: CONTINUATION_OUTCOME.BLOCK_DEPENDENTS,
        scope: 'session_dependents',
        reason: 'session_continuity_mismatch',
      });
    });

    it('does not start a dependent case before the prior terminal state is committed', () => {
      const result = evaluateDependentCaseStart({
        previousCase: {
          committed: false,
          sessionContext: sessionContext(),
        },
      });

      expect(result).toMatchObject({
        outcome: CONTINUATION_OUTCOME.BLOCK_DEPENDENTS,
        scope: 'case_dependents',
        reason: 'dependency_terminal_state_not_committed',
      });
    });

    it('blocks dependent cases after a genuinely blocking prior action failure', () => {
      const result = evaluateDependentCaseStart({
        previousCase: {
          committed: true,
          sessionContext: sessionContext(),
          failures: [{ kind: 'action', blocking: true }],
        },
      });

      expect(result).toMatchObject({
        outcome: CONTINUATION_OUTCOME.BLOCK_DEPENDENTS,
        scope: 'case_dependents',
        reason: 'dependency_has_blocking_failure',
      });
    });
  });
});
