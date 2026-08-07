'use strict';

const {
  OBSERVER_ROLE,
} = require('./browserTransactionAuthority');
const {
  SNAPSHOT_STATUS,
} = require('./browserSnapshotLifecycle');
const {
  authorizeRecoveryDirective,
} = require('./controllerRecoveryDirectives');
const {
  PROPOSAL_KIND,
  PROPOSAL_STATUS,
  normalizeHealerProposal,
  normalizeCriticProposal,
  verifyRecoveryProposal,
  recoveryDirectiveFromVerifiedProposal,
} = require('./controllerRecoveryProposals');

const RECOVERY_COORDINATOR_VERSION = 'qaai-controller-recovery-coordinator-v1';

const RECOVERY_RESULT = Object.freeze({
  RECOVERED_TARGET: 'RECOVERED_TARGET',
  RETRY_RESOLUTION: 'RETRY_RESOLUTION',
  UNRECOVERED: 'UNRECOVERED',
  SESSION_LOST: 'SESSION_LOST',
  MANUAL_BOUNDARY: 'MANUAL_BOUNDARY',
});

class ControllerRecoveryCoordinatorError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ControllerRecoveryCoordinatorError';
    this.code = code;
    Object.assign(this, details);
  }
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function factRefsOf(...values) {
  return Object.freeze([
    ...new Set(values.flatMap((value) => (
      Array.isArray(value?.factRefs)
        ? value.factRefs
        : value?.factRef ? [value.factRef] : []
    )).map(clean).filter(Boolean)),
  ]);
}

function providerForRole(role, healerPropose, criticPropose) {
  if (role === OBSERVER_ROLE.HEALER) return healerPropose;
  if (role === OBSERVER_ROLE.CRITIC) return criticPropose;
  return null;
}

function normalizerForRole(role) {
  return role === OBSERVER_ROLE.HEALER
    ? normalizeHealerProposal
    : normalizeCriticProposal;
}

function roleForResolution(resolution) {
  return resolution?.status === 'CONFLICT'
    ? OBSERVER_ROLE.CRITIC
    : OBSERVER_ROLE.HEALER;
}

function recoveryResolution(verifiedProposal, snapshot) {
  const verifiedTarget = verifiedProposal.targetResolution?.target;
  const rawCandidate = (snapshot?.candidates || []).find((candidate) => (
    clean(candidate?.ref || candidate?.reference) === clean(verifiedTarget?.ref)
  )) || null;
  return Object.freeze({
    status: 'RESOLVED',
    target: Object.freeze({
      ref: clean(verifiedTarget?.ref) || null,
      interactionRef: clean(rawCandidate?.interactionRef) || null,
      identity: verifiedTarget?.identity || rawCandidate?.identity || rawCandidate || {},
      candidate: rawCandidate || verifiedTarget,
    }),
    browserEpoch: snapshot?.browserEpoch || null,
    reason: 'controller_verified_recovery_target',
    factRefs: factRefsOf(
      snapshot,
      verifiedProposal,
      verifiedProposal.targetResolution,
    ),
    recovery: Object.freeze({
      proposalId: verifiedProposal.proposal.proposalId,
      proposalRole: verifiedProposal.proposal.role,
      proposalKind: verifiedProposal.proposal.proposalKind,
    }),
  });
}

function recoveryMutationForProposal(verifiedProposal) {
  const action = verifiedProposal?.proposal?.proposedAction || {};
  const targetRef = clean(verifiedProposal?.targetResolution?.target?.ref);
  const actionType = clean(action.type).toLowerCase();
  if (!targetRef || !['click', 'dismiss', 'close'].includes(actionType)) return null;
  return Object.freeze({
    toolName: 'browser_click',
    args: Object.freeze({ target: targetRef }),
    phaseId: 'verified_recovery',
  });
}

function createControllerRecoveryCoordinator({
  acquireSnapshot,
  currentEpoch,
  healerPropose = null,
  criticPropose = null,
  gateway = null,
  now = Date.now,
  heartbeat = () => {},
} = {}) {
  if (typeof acquireSnapshot !== 'function' || typeof currentEpoch !== 'function') {
    throw new TypeError('Controller recovery requires snapshot acquisition and browser epoch facts.');
  }

  const recoverResolution = async ({
    authority,
    operation,
    resolution,
    context = {},
    remainingMs = 2_000,
    attempt = 1,
  } = {}) => {
    const snapshotResult = await acquireSnapshot({
      forceFresh: true,
      remainingMs,
      minimumCandidateCount: 1,
      reason: `controller-recovery:${operation.operationId}`,
    });
    if (snapshotResult?.status === SNAPSHOT_STATUS.SESSION_LOST) {
      return Object.freeze({
        status: RECOVERY_RESULT.SESSION_LOST,
        reason: snapshotResult.reason || 'browser_session_lost',
        factRefs: factRefsOf(snapshotResult),
      });
    }
    if (snapshotResult?.status !== SNAPSHOT_STATUS.VALID) {
      return Object.freeze({
        status: RECOVERY_RESULT.UNRECOVERED,
        reason: snapshotResult?.reason || 'recovery_snapshot_unavailable',
        factRefs: factRefsOf(snapshotResult),
      });
    }

    const snapshot = snapshotResult.snapshot;
    const browserEpoch = clean(snapshot?.browserEpoch || currentEpoch());
    const role = roleForResolution(resolution);
    const propose = providerForRole(role, healerPropose, criticPropose);
    if (typeof propose !== 'function') {
      return Object.freeze({
        status: RECOVERY_RESULT.UNRECOVERED,
        reason: role === OBSERVER_ROLE.HEALER
          ? 'healer_proposal_unavailable'
          : 'critic_proposal_unavailable',
        factRefs: factRefsOf(snapshot),
      });
    }

    let rawProposal;
    try {
      rawProposal = await propose({
        operation,
        resolution,
        browserEpoch,
        snapshot,
        candidates: snapshot.candidates || [],
        context,
        remainingMs,
      });
    } catch (error) {
      return Object.freeze({
        status: RECOVERY_RESULT.UNRECOVERED,
        reason: clean(error?.code || error?.name) || 'recovery_proposal_failed',
        factRefs: factRefsOf(snapshot, error),
      });
    }
    if (!rawProposal) {
      return Object.freeze({
        status: RECOVERY_RESULT.UNRECOVERED,
        reason: 'recovery_proposal_not_offered',
        factRefs: factRefsOf(snapshot),
      });
    }

    const typedProposal = normalizerForRole(role)(rawProposal, {
      operation,
      browserEpoch,
      now: Number(now()),
    });
    const verifiedProposal = verifyRecoveryProposal({
      proposal: typedProposal,
      operation,
      browserEpoch,
      candidates: snapshot.candidates || [],
      evidenceFactRefs: factRefsOf(snapshot),
      now: Number(now()),
    });
    heartbeat(Object.freeze({
      recoveryCoordinatorVersion: RECOVERY_COORDINATOR_VERSION,
      operationId: operation.operationId,
      proposalId: typedProposal.proposalId,
      proposalRole: role,
      proposalStatus: verifiedProposal.status,
      reason: verifiedProposal.reason,
    }));
    if (verifiedProposal.status !== PROPOSAL_STATUS.VERIFIED) {
      return Object.freeze({
        status: RECOVERY_RESULT.UNRECOVERED,
        reason: verifiedProposal.reason,
        factRefs: factRefsOf(snapshot, verifiedProposal),
      });
    }

    const directive = recoveryDirectiveFromVerifiedProposal({
      verifiedProposal,
      operation,
      attempt,
      maxAttempts: 3,
    });
    const authorization = authorizeRecoveryDirective({
      authority,
      directive,
      browserEpoch,
      now: Number(now()),
    });
    if (typedProposal.proposalKind === PROPOSAL_KIND.MANUAL_BOUNDARY) {
      return Object.freeze({
        status: RECOVERY_RESULT.MANUAL_BOUNDARY,
        reason: verifiedProposal.reason,
        factRefs: factRefsOf(snapshot, verifiedProposal),
      });
    }
    if (typedProposal.proposalKind === PROPOSAL_KIND.TARGET_REPAIR) {
      return Object.freeze({
        status: RECOVERY_RESULT.RECOVERED_TARGET,
        resolution: recoveryResolution(verifiedProposal, snapshot),
        directive,
        authorization,
        factRefs: factRefsOf(snapshot, verifiedProposal),
      });
    }

    const mutation = recoveryMutationForProposal(verifiedProposal);
    if (!mutation || !gateway || typeof gateway.dispatch !== 'function') {
      return Object.freeze({
        status: RECOVERY_RESULT.UNRECOVERED,
        reason: 'verified_recovery_mutation_not_supported',
        factRefs: factRefsOf(snapshot, verifiedProposal),
      });
    }
    const recoveryOperation = Object.freeze({
      ...operation,
      operationId: `${operation.operationId}:recovery:${attempt}`,
      actionOccurrenceId: authorization.recoveryOccurrenceId,
      kind: 'action',
      required: false,
    });
    const delivery = await gateway.dispatch({
      authority,
      operation: recoveryOperation,
      plan: Object.freeze({ mutation }),
      context,
      remainingMs,
    });
    if (delivery.deliveryStatus === 'NOT_DELIVERED') {
      return Object.freeze({
        status: RECOVERY_RESULT.UNRECOVERED,
        reason: delivery.reason || 'verified_recovery_not_delivered',
        factRefs: factRefsOf(snapshot, verifiedProposal, delivery),
        positivelyNotDelivered: true,
      });
    }
    return Object.freeze({
      status: RECOVERY_RESULT.RETRY_RESOLUTION,
      reason: delivery.deliveryStatus === 'DELIVERY_UNCERTAIN'
        ? 'verified_recovery_delivery_uncertain_observe_only'
        : 'verified_recovery_delivered',
      directive,
      authorization,
      delivery,
      factRefs: factRefsOf(snapshot, verifiedProposal, delivery),
    });
  };

  return Object.freeze({
    recoveryCoordinatorVersion: RECOVERY_COORDINATOR_VERSION,
    recoverResolution,
  });
}

module.exports = {
  RECOVERY_COORDINATOR_VERSION,
  RECOVERY_RESULT,
  ControllerRecoveryCoordinatorError,
  recoveryMutationForProposal,
  createControllerRecoveryCoordinator,
};
