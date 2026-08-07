import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  databaseStatus,
  outcomeAllowsContinuation,
  stepStatus,
} = require('../../server/services/agents/controllerConductor');
const {
  CASE_VERDICT,
} = require('../../server/services/controllerVerdictProjector');

describe('controller Conductor outcome mapping', () => {
  it('persists execution errors as fail rather than needs_human', () => {
    expect(databaseStatus(CASE_VERDICT.EXECUTION_ERROR)).toBe('fail');
    expect(stepStatus('EXECUTION_ERROR')).toBe('fail');
  });

  it('keeps assertion failures fail-but-non-manual', () => {
    expect(databaseStatus(CASE_VERDICT.FAIL)).toBe('fail');
    expect(stepStatus('ASSERTION_FAILED')).toBe('fail');
    expect(stepStatus('PRODUCT_FAILURE')).toBe('fail');
  });

  it('does not turn a bounded execution error into a pause or independent-step stop', () => {
    expect(outcomeAllowsContinuation({
      paused: false,
      operationResults: [{
        terminalDecision: {
          state: 'EXECUTION_ERROR',
          continuation: {
            continueIndependent: true,
            skipDependents: false,
            pause: false,
            terminationReason: null,
          },
        },
      }],
      schedulerSnapshot: {
        paused: false,
        cancelled: false,
        records: [{
          terminalState: 'EXECUTION_ERROR',
          scheduleState: 'TERMINAL',
        }],
      },
    })).toBe(true);
  });

  it('keeps assertion failure non-pausing and continuation-safe', () => {
    expect(outcomeAllowsContinuation({
      paused: false,
      operationResults: [{
        terminalDecision: {
          state: 'ASSERTION_FAILED',
          continuation: {
            continueIndependent: true,
            skipDependents: false,
            pause: false,
            terminationReason: null,
          },
        },
      }],
      schedulerSnapshot: {
        paused: false,
        cancelled: false,
        records: [{
          terminalState: 'ASSERTION_FAILED',
          scheduleState: 'TERMINAL',
        }],
      },
    })).toBe(true);
  });

  it('reserves needs_human exclusively for an explicit manual boundary', () => {
    expect(databaseStatus(CASE_VERDICT.MANUAL_BOUNDARY)).toBe('needs_human');
    expect(stepStatus('MANUAL_BOUNDARY')).toBe('needs_human');

    for (const verdict of [
      CASE_VERDICT.PASS,
      CASE_VERDICT.FAIL,
      CASE_VERDICT.EXECUTION_ERROR,
      CASE_VERDICT.CANCELLED,
      'UNKNOWN_CONTROLLER_VERDICT',
    ]) {
      expect(databaseStatus(verdict)).not.toBe('needs_human');
    }

    for (const state of [
      'COMMITTED',
      'ASSERTION_FAILED',
      'PRODUCT_FAILURE',
      'EXECUTION_ERROR',
      'CANCELLED',
      'UNKNOWN_CONTROLLER_STATE',
    ]) {
      expect(stepStatus(state)).not.toBe('needs_human');
    }
  });
});
