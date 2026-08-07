import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  CONTROLLER_STATE,
} = require('../../server/services/browserTransactionContract');
const {
  createControllerAuthority,
} = require('../../server/services/browserTransactionAuthority');
const {
  SCHEDULE_STATE,
} = require('../../server/services/controllerExecutionScheduler');
const {
  CASE_VERDICT,
  projectControllerVerdict,
  createInMemoryVerdictRepository,
  persistControllerVerdict,
} = require('../../server/services/controllerVerdictProjector');

function schedulerSnapshot(states) {
  return {
    paused: false,
    cancelled: false,
    records: states.map((state, index) => ({
      operationId: `operation:${index + 1}`,
      scheduleState: SCHEDULE_STATE.TERMINAL,
      terminalState: state,
    })),
  };
}

describe('controller verdict projector', () => {
  it('projects assertion failure only after execution finishes', () => {
    expect(projectControllerVerdict({
      scopeId: 'case:login',
      schedulerSnapshot: schedulerSnapshot([
        CONTROLLER_STATE.ASSERTION_FAILED,
        CONTROLLER_STATE.COMMITTED,
      ]),
    })).toMatchObject({
      verdict: CASE_VERDICT.FAIL,
      counts: { assertionFailed: 1, committed: 1 },
    });
  });

  it('makes a persisted verdict write-once', async () => {
    const repository = createInMemoryVerdictRepository();
    const authority = createControllerAuthority();
    const first = projectControllerVerdict({
      scopeId: 'case:login',
      schedulerSnapshot: schedulerSnapshot([CONTROLLER_STATE.COMMITTED]),
    });
    await persistControllerVerdict({ authority, projection: first, repository });
    const conflicting = projectControllerVerdict({
      scopeId: 'case:login',
      schedulerSnapshot: schedulerSnapshot([CONTROLLER_STATE.ASSERTION_FAILED]),
    });
    await expect(persistControllerVerdict({
      authority,
      projection: conflicting,
      repository,
    })).rejects.toMatchObject({
      code: 'CONTROLLER_VERDICT_WRITE_ONCE_VIOLATION',
    });
  });

  it('does not let synchronization uncertainty assign the case verdict', () => {
    const projection = projectControllerVerdict({
      scopeId: 'case:wait-then-fill',
      schedulerSnapshot: {
        paused: false,
        cancelled: false,
        records: [{
          operationId: 'wait:email-page',
          kind: 'synchronization',
          scheduleState: SCHEDULE_STATE.TERMINAL,
          terminalState: CONTROLLER_STATE.EXECUTION_ERROR,
        }, {
          operationId: 'action:fill-email',
          kind: 'action',
          scheduleState: SCHEDULE_STATE.TERMINAL,
          terminalState: CONTROLLER_STATE.COMMITTED,
        }],
      },
    });
    expect(projection).toMatchObject({
      verdict: CASE_VERDICT.PASS,
      counts: { synchronizationInconclusive: 1, executionError: 1, committed: 1 },
    });
  });

  it('continues after a recoverable action error without fabricating a passing case verdict', () => {
    const projection = projectControllerVerdict({
      scopeId: 'case:authenticated',
      schedulerSnapshot: {
        paused: false,
        cancelled: false,
        records: [{
          operationId: 'action:sign-in',
          kind: 'action',
          scheduleState: SCHEDULE_STATE.TERMINAL,
          terminalState: CONTROLLER_STATE.EXECUTION_ERROR,
          skipDependents: false,
        }, {
          operationId: 'assertion:welcome',
          kind: 'assertion',
          scheduleState: SCHEDULE_STATE.TERMINAL,
          terminalState: CONTROLLER_STATE.COMMITTED,
          skipDependents: false,
        }],
      },
    });
    expect(projection).toMatchObject({
      verdict: CASE_VERDICT.EXECUTION_ERROR,
      counts: {
        recoverableExecutionError: 1,
        executionError: 1,
        committed: 1,
      },
    });
  });
});
