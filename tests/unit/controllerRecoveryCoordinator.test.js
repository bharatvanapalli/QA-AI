import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  createControllerAuthority,
} = require('../../server/services/browserTransactionAuthority');
const {
  RECOVERY_RESULT,
  createControllerRecoveryCoordinator,
} = require('../../server/services/controllerRecoveryCoordinator');

function operation() {
  return {
    schemaVersion: 'OperationContractV2',
    operationId: 'action:login:sign-in',
    actionOccurrenceId: 'occurrence:action:login:sign-in:1',
    kind: 'action',
    type: 'Click',
    targetIdentity: { role: 'button', accessibleName: 'Sign in' },
    required: true,
  };
}

function snapshot(candidates) {
  return {
    status: 'VALID',
    snapshot: {
      browserEpoch: 'epoch:1',
      snapshotText: '- button "Sign in" [ref=e79]',
      candidates,
      factRefs: ['snapshot:auth-form'],
    },
  };
}

describe('controller recovery coordinator', () => {
  it('accepts a verified Healer target as observation without dispatching recovery mutation', async () => {
    const gateway = { dispatch: vi.fn() };
    const coordinator = createControllerRecoveryCoordinator({
      acquireSnapshot: vi.fn().mockResolvedValue(snapshot([{
        source: 'ax',
        browserEpoch: 'epoch:1',
        ref: 'e79',
        role: 'button',
        accessibleName: 'Sign in',
        connected: true,
        actionable: true,
        factRef: 'ax:79',
      }])),
      currentEpoch: () => 'epoch:1',
      healerPropose: vi.fn().mockResolvedValue({
        proposalKind: 'TARGET_REPAIR',
        targetIdentity: { role: 'button', accessibleName: 'Sign in' },
        actionType: 'Click',
        supportingFactRefs: ['snapshot:auth-form'],
      }),
      gateway,
      now: () => 100,
    });

    const result = await coordinator.recoverResolution({
      authority: createControllerAuthority(),
      operation: operation(),
      resolution: { status: 'NOT_FOUND' },
      remainingMs: 1_000,
    });

    expect(result).toMatchObject({
      status: RECOVERY_RESULT.RECOVERED_TARGET,
      resolution: {
        status: 'RESOLVED',
        target: { ref: 'e79' },
      },
      authorization: {
        mayMutateBrowser: false,
        recoveryOccurrenceId: null,
      },
    });
    expect(gateway.dispatch).not.toHaveBeenCalled();
  });

  it('executes a verified Critic recovery with a new exactly-once occurrence', async () => {
    const gateway = {
      dispatch: vi.fn().mockResolvedValue({
        deliveryStatus: 'DELIVERED',
        factRefs: ['recovery:delivery'],
      }),
    };
    const coordinator = createControllerRecoveryCoordinator({
      acquireSnapshot: vi.fn().mockResolvedValue(snapshot([{
        source: 'ax',
        browserEpoch: 'epoch:1',
        ref: 'e-dismiss',
        role: 'button',
        accessibleName: 'Dismiss',
        connected: true,
        actionable: true,
        factRef: 'ax:dismiss',
      }])),
      currentEpoch: () => 'epoch:1',
      criticPropose: vi.fn().mockResolvedValue({
        proposalKind: 'DISMISS_UNEXPECTED_UI',
        targetIdentity: { role: 'button', accessibleName: 'Dismiss' },
        actionType: 'Click',
        supportingFactRefs: ['snapshot:auth-form'],
      }),
      gateway,
      now: () => 100,
    });

    const result = await coordinator.recoverResolution({
      authority: createControllerAuthority(),
      operation: operation(),
      resolution: { status: 'CONFLICT' },
      context: { session: { id: 'session:1' } },
      remainingMs: 1_000,
    });

    expect(result.status).toBe(RECOVERY_RESULT.RETRY_RESOLUTION);
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(gateway.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      operation: expect.objectContaining({
        actionOccurrenceId: expect.stringContaining(':recovery:apply_verified_proposal:1'),
      }),
      plan: {
        mutation: expect.objectContaining({
          toolName: 'browser_click',
          args: { target: 'e-dismiss' },
        }),
      },
    }));
  });
});
