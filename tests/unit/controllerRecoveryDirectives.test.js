import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  OBSERVER_ROLE,
  createControllerAuthority,
  proposal,
} = require('../../server/services/browserTransactionAuthority');
const recovery = require('../../server/services/controllerRecoveryDirectives');

function operation() {
  return {
    operationId: 'action:login:sign-in',
    actionOccurrenceId: 'occurrence:action:login:sign-in:1',
  };
}

describe('controller recovery directives', () => {
  it('makes delivery uncertainty observation-only', () => {
    const directive = recovery.createRecoveryDirective({
      operation: operation(),
      issue: recovery.RECOVERY_ISSUE.DELIVERY_UNCERTAIN,
    });
    const authorization = recovery.authorizeRecoveryDirective({
      authority: createControllerAuthority(),
      directive,
    });
    expect(authorization).toMatchObject({
      directive: recovery.RECOVERY_DIRECTIVE.OBSERVE_ONLY,
      mayMutateBrowser: false,
      recoveryOccurrenceId: null,
      mayRedispatchOriginalOccurrence: false,
    });
  });

  it('gives every recovery mutation a new occurrence identity', () => {
    const directive = recovery.createRecoveryDirective({
      operation: operation(),
      issue: recovery.RECOVERY_ISSUE.PREREQUISITE_ERASED,
      attempt: 2,
    });
    const authorization = recovery.authorizeRecoveryDirective({
      authority: createControllerAuthority(),
      directive,
    });
    expect(authorization.recoveryOccurrenceId).not.toBe(operation().actionOccurrenceId);
    expect(authorization.recoveryOccurrenceId).toContain(':recovery:restore_prerequisite_value:2');
  });

  it('keeps Healer output proposal-only until controller authorization', () => {
    const healerProposal = {
      ...proposal(OBSERVER_ROLE.HEALER, {
        target: { role: 'button', name: 'Sign in' },
      }),
      operationId: operation().operationId,
      browserEpoch: 'epoch:1',
      expiresAtMs: 500,
    };
    const directive = recovery.createRecoveryDirective({
      operation: operation(),
      issue: recovery.RECOVERY_ISSUE.TARGET_UNRESOLVED,
      browserEpoch: 'epoch:1',
      proposal: healerProposal,
    });
    expect(directive.mayMutateBrowser).toBe(true);
    expect(() => recovery.authorizeRecoveryDirective({
      authority: createControllerAuthority(),
      directive,
      browserEpoch: 'epoch:2',
      now: 100,
    })).toThrowError(expect.objectContaining({
      code: 'CONTROLLER_RECOVERY_PROPOSAL_EPOCH_STALE',
    }));
  });

  it('accepts a verified target repair without authorizing a separate browser mutation', () => {
    const healerProposal = {
      ...proposal(OBSERVER_ROLE.HEALER, {
        target: { role: 'button', name: 'Sign in' },
      }),
      proposalKind: 'TARGET_REPAIR',
      operationId: operation().operationId,
      browserEpoch: 'epoch:1',
      expiresAtMs: 500,
    };
    const directive = recovery.createRecoveryDirective({
      operation: operation(),
      issue: recovery.RECOVERY_ISSUE.TARGET_UNRESOLVED,
      browserEpoch: 'epoch:1',
      proposal: healerProposal,
    });
    const authorization = recovery.authorizeRecoveryDirective({
      authority: createControllerAuthority(),
      directive,
      browserEpoch: 'epoch:1',
      now: 100,
    });
    expect(authorization).toMatchObject({
      directive: recovery.RECOVERY_DIRECTIVE.ACCEPT_VERIFIED_TARGET,
      mayMutateBrowser: false,
      recoveryOccurrenceId: null,
    });
  });

  it('enforces a bounded recovery budget', () => {
    expect(() => recovery.createRecoveryDirective({
      operation: operation(),
      issue: recovery.RECOVERY_ISSUE.SNAPSHOT_CAPTURE_FAILED,
      attempt: 4,
      maxAttempts: 3,
    })).toThrowError(expect.objectContaining({
      code: 'CONTROLLER_RECOVERY_BUDGET_EXHAUSTED',
    }));
  });
});
