import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const proposal = require('../../server/services/controllerRecoveryProposals');

const operation = {
  operationId: 'action:login:sign-in',
  actionOccurrenceId: 'occurrence:action:login:sign-in:1',
  targetIdentity: { role: 'button', accessibleName: 'Sign in' },
};

describe('controller recovery proposals', () => {
  it('verifies a Healer locator proposal against live semantic facts', () => {
    const typed = proposal.normalizeHealerProposal({
      proposalKind: proposal.PROPOSAL_KIND.TARGET_REPAIR,
      targetIdentity: { role: 'button', accessibleName: 'Sign in' },
      actionType: 'Click',
      supportingFactRefs: ['snapshot:auth-form'],
    }, {
      operation,
      browserEpoch: 'epoch:1',
      now: 100,
    });
    const verified = proposal.verifyRecoveryProposal({
      proposal: typed,
      operation,
      browserEpoch: 'epoch:1',
      now: 101,
      evidenceFactRefs: ['snapshot:auth-form'],
      candidates: [{
        source: 'ax',
        browserEpoch: 'epoch:1',
        ref: 'e79',
        identity: { role: 'button', accessibleName: 'Sign in', backendNodeId: 79 },
        connected: true,
        actionable: true,
        factRef: 'ax:79',
      }],
    });
    expect(verified).toMatchObject({
      status: proposal.PROPOSAL_STATUS.VERIFIED,
      targetResolution: { status: 'RESOLVED', target: { ref: 'e79' } },
    });
    expect(typed).toMatchObject({
      mayMutateBrowser: false,
      mayChangeVerdict: false,
      mayStopExecution: false,
    });
  });

  it('rejects stale proposals before they can become directives', () => {
    const typed = proposal.normalizeCriticProposal({
      targetIdentity: { role: 'button', accessibleName: 'Dismiss' },
      supportingFactRefs: ['snapshot:dialog'],
    }, {
      operation,
      browserEpoch: 'epoch:1',
      now: 100,
      ttlMs: 100,
    });
    const verified = proposal.verifyRecoveryProposal({
      proposal: typed,
      operation,
      browserEpoch: 'epoch:2',
      now: 101,
    });
    expect(verified.status).toBe(proposal.PROPOSAL_STATUS.STALE);
    expect(() => proposal.recoveryDirectiveFromVerifiedProposal({
      verifiedProposal: verified,
      operation,
    })).toThrowError(expect.objectContaining({
      code: 'CONTROLLER_RECOVERY_PROPOSAL_NOT_VERIFIED',
    }));
  });

  it('requires supporting browser evidence', () => {
    expect(() => proposal.normalizeHealerProposal({
      targetIdentity: { role: 'button', accessibleName: 'Sign in' },
    }, {
      operation,
      browserEpoch: 'epoch:1',
      now: 100,
    })).toThrowError(expect.objectContaining({
      code: 'CONTROLLER_RECOVERY_PROPOSAL_EVIDENCE_REQUIRED',
    }));
  });

  it('rejects a target repair that changes the authored semantic target', () => {
    const typed = proposal.normalizeHealerProposal({
      targetIdentity: { role: 'button', accessibleName: 'Delete account' },
      supportingFactRefs: ['snapshot:auth-form'],
    }, {
      operation,
      browserEpoch: 'epoch:1',
      now: 100,
    });
    const verified = proposal.verifyRecoveryProposal({
      proposal: typed,
      operation,
      browserEpoch: 'epoch:1',
      now: 101,
      evidenceFactRefs: ['snapshot:auth-form'],
      candidates: [{
        source: 'ax',
        browserEpoch: 'epoch:1',
        ref: 'e-danger',
        identity: { role: 'button', accessibleName: 'Delete account' },
        connected: true,
        actionable: true,
        factRef: 'ax:danger',
      }],
    });
    expect(verified).toMatchObject({
      status: proposal.PROPOSAL_STATUS.REJECTED,
      reason: 'proposal_changes_authored_target_identity',
    });
  });
});
