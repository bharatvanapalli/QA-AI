'use strict';

const {
  CONTROLLER_STATE,
  COMMIT_DISPOSITION,
  FAILURE_ATTRIBUTION,
  RUN_TERMINATION_REASON,
} = require('./browserTransactionContract');
const {
  CONTROLLER_CAPABILITY,
  createControllerAuthority,
  assertControllerAuthority,
} = require('./browserTransactionAuthority');
const {
  createBrowserTransactionStateMachine,
} = require('./browserTransactionStateMachine');
const {
  PROOF_STATUS,
  evaluateAnyOfProof,
} = require('./browserProofContract');
const {
  classifyControllerFailure,
} = require('./controllerFailureAttribution');
const {
  RECOVERY_RESULT,
} = require('./controllerRecoveryCoordinator');
const {
  getNextLadderStrategy,
} = require('./controllerTypedAdapterRegistry');

const CONTROLLER_VERSION = 'qaai-browser-transaction-controller-v1';

const RESOLUTION_STATUS = Object.freeze({
  RESOLVED: 'RESOLVED',
  OPTIONAL_ABSENT: 'OPTIONAL_ABSENT',
  NOT_FOUND: 'NOT_FOUND',
  AMBIGUOUS: 'AMBIGUOUS',
  CONFLICT: 'CONFLICT',
  STALE: 'STALE',
  MANUAL_BOUNDARY: 'MANUAL_BOUNDARY',
  SESSION_LOST: 'SESSION_LOST',
});

const DELIVERY_STATUS = Object.freeze({
  DELIVERED: 'DELIVERED',
  NOT_DELIVERED: 'NOT_DELIVERED',
  DELIVERY_UNCERTAIN: 'DELIVERY_UNCERTAIN',
});

const OPERATION_KIND = Object.freeze({
  ACTION: 'action',
  ASSERTION: 'assertion',
  SYNCHRONIZATION: 'synchronization',
});

const RESOLUTION_VALUES = new Set(Object.values(RESOLUTION_STATUS));
const DELIVERY_VALUES = new Set(Object.values(DELIVERY_STATUS));

class BrowserTransactionControllerError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'BrowserTransactionControllerError';
    this.code = code;
    Object.assign(this, details);
  }
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

function dispatchWindow(remainingMs, operationBudgetMs) {
  const remaining = Math.max(1, Math.trunc(Number(remainingMs) || 1));
  if (remaining === 1) {
    return Object.freeze({
      dispatchBudgetMs: 1,
      reconciliationReserveMs: 0,
    });
  }

  const totalBudget = Math.max(
    remaining,
    Math.trunc(Number(operationBudgetMs) || remaining),
  );
  const minimumDispatchSlice = Math.min(
    250,
    Math.max(1, Math.floor(remaining / 2)),
  );
  const preferredReserve = Math.min(
    3_000,
    Math.max(750, Math.floor(totalBudget * 0.35)),
  );
  const reconciliationReserveMs = Math.min(
    preferredReserve,
    Math.max(1, remaining - minimumDispatchSlice),
  );

  return Object.freeze({
    dispatchBudgetMs: Math.max(1, remaining - reconciliationReserveMs),
    reconciliationReserveMs,
  });
}

function factRefsOf(...values) {
  return [
    ...new Set(values.flatMap((value) => (
      Array.isArray(value?.factRefs) ? value.factRefs
        : value?.factRef ? [value.factRef]
          : []
    )).map(clean).filter(Boolean)),
  ];
}

function normalizeResolution(value = {}) {
  const status = clean(value.status).toUpperCase();
  if (!RESOLUTION_VALUES.has(status)) {
    throw new BrowserTransactionControllerError(
      `Resolver returned an unknown status: ${status || '<empty>'}`,
      'BROWSER_TRANSACTION_RESOLUTION_INVALID',
      { status: status || null },
    );
  }
  return Object.freeze({ ...value, status, factRefs: Object.freeze(factRefsOf(value)) });
}

function normalizeDelivery(value = {}, fallbackAttemptId) {
  const deliveryStatus = clean(value.deliveryStatus || value.status).toUpperCase();
  if (!DELIVERY_VALUES.has(deliveryStatus)) {
    throw new BrowserTransactionControllerError(
      `Gateway returned an unknown delivery status: ${deliveryStatus || '<empty>'}`,
      'BROWSER_TRANSACTION_DELIVERY_INVALID',
      { deliveryStatus: deliveryStatus || null },
    );
  }
  return Object.freeze({
    ...value,
    dispatchAttemptId: clean(value.dispatchAttemptId) || fallbackAttemptId,
    deliveryStatus,
    factRefs: Object.freeze(factRefsOf(value)),
  });
}

function deadlineIso(deadlineMs) {
  return new Date(deadlineMs).toISOString();
}

function defaultProofEvaluator(proofContract, observation) {
  if (observation?.proof && Object.values(PROOF_STATUS).includes(observation.proof.status)) {
    return observation.proof;
  }
  return evaluateAnyOfProof(proofContract, observation?.claims || []);
}

function createBrowserTransactionController({
  resolver,
  planner,
  observer,
  gateway,
  proofEvaluator = defaultProofEvaluator,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  heartbeat = () => {},
  defaultDeadlineMs = 5_000,
  defaultObservationAttempts = 3,
  defaultResolutionAttempts = 3,
  resumeReconciler = null,
  controllerAuthority = null,
  compositeExecutor = null,
  recoveryCoordinator = null,
} = {}) {
  if (typeof resolver !== 'function') throw new TypeError('BrowserTransactionController requires resolver().');
  if (typeof planner !== 'function') throw new TypeError('BrowserTransactionController requires planner().');
  if (typeof observer !== 'function') throw new TypeError('BrowserTransactionController requires observer().');
  if (!gateway || typeof gateway.dispatch !== 'function') {
    throw new TypeError('BrowserTransactionController requires a gateway.dispatch() fact boundary.');
  }
  if (recoveryCoordinator != null
    && typeof recoveryCoordinator.recoverResolution !== 'function') {
    throw new TypeError('BrowserTransactionController recovery must expose recoverResolution().');
  }

  const authority = controllerAuthority || createControllerAuthority();
  assertControllerAuthority(authority, CONTROLLER_CAPABILITY.SCHEDULE_OPERATION);

  const report = (operation, state, details = {}) => {
    heartbeat(Object.freeze({
      controllerVersion: CONTROLLER_VERSION,
      operationId: operation.operationId,
      actionOccurrenceId: operation.actionOccurrenceId,
      state,
      ...details,
    }));
  };

  const callBounded = async (work, remainingMs, timeoutCode) => {
    const boundedMs = Math.max(1, Math.trunc(remainingMs));
    let timer = null;
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise((_, reject) => {
          timer = setTimer(() => reject(new BrowserTransactionControllerError(
            'Browser observation exceeded the remaining operation deadline.',
            timeoutCode,
            { remainingMs: boundedMs },
          )), boundedMs);
        }),
      ]);
    } finally {
      if (timer != null) clearTimer(timer);
    }
  };

  const waitBeforeReconciliationObservation = async (operation, attempt, deadlineMs) => {
    const requestedMs = attempt <= 1
      ? (operation.kind === 'assertion' ? 80 : 50)
      : Math.min(300, 80 * attempt);
    const remainingMs = deadlineMs - Number(now());
    const waitMs = Math.max(0, Math.min(requestedMs, remainingMs - 1));
    if (waitMs <= 0) return;
    report(operation, CONTROLLER_STATE.RECONCILING, {
      attempt,
      waitMs,
      reason: attempt <= 1 ? 'initial_dom_quiescence_settle' : 'bounded_framework_settle_backoff',
    });
    await new Promise((resolve) => {
      setTimer(resolve, waitMs);
    });
  };

  const observeAndEvaluate = async ({
    operation,
    resolution,
    plan,
    phase,
    attempt,
    deadlineMs,
    delivery = null,
    context = {},
  }) => {
    const remainingMs = deadlineMs - Number(now());
    if (remainingMs <= 0) {
      return Object.freeze({
        observation: null,
        proof: Object.freeze({
          status: PROOF_STATUS.UNKNOWN,
          factRefs: Object.freeze([]),
          reason: 'operation_deadline_reached',
        }),
      });
    }
    let observation = null;
    try {
      observation = await callBounded(
        () => observer({
          operation,
          resolution,
          plan,
          phase,
          attempt,
          remainingMs,
          delivery,
          context,
        }),
        remainingMs,
        'BROWSER_TRANSACTION_OBSERVER_DEADLINE',
      );
    } catch (error) {
      observation = {
        claims: [],
        factRefs: [],
        observationError: error,
      };
      // A deadline timeout here is routine (a slow page, not a bug) and is
      // already visible via the returned reason — don't spam the log for
      // it. Anything else reaching this catch is the observer itself
      // throwing (a real code defect, e.g. a bad variable reference), and
      // it was previously discarded with no trace at all: it surfaced only
      // as a generic `exact_proof_unavailable` on every attempt, with the
      // actual ReferenceError invisible unless someone added temporary
      // instrumentation to find it (as happened live on 2026-08-07).
      // Logging it to stderr means it lands in server.err.log immediately.
      if (error?.code !== 'BROWSER_TRANSACTION_OBSERVER_DEADLINE') {
        console.error(
          `[browserTransactionController] observer threw for ${operation.operationId} (phase=${phase}, attempt=${attempt}):`,
          error,
        );
      }
    }
    if (observation?.sessionLost === true) {
      return Object.freeze({
        observation,
        proof: Object.freeze({
          status: PROOF_STATUS.UNKNOWN,
          factRefs: Object.freeze(factRefsOf(observation)),
          reason: 'browser_session_lost',
          sessionLost: true,
        }),
      });
    }
    if (observation?.manualBoundary === true) {
      return Object.freeze({
        observation,
        proof: Object.freeze({
          status: PROOF_STATUS.UNKNOWN,
          factRefs: Object.freeze(factRefsOf(observation)),
          reason: 'manual_boundary_observed',
          manualBoundary: true,
        }),
      });
    }
    let proof;
    try {
      proof = await proofEvaluator(plan.proofContract, observation, {
        operation,
        resolution,
        phase,
        attempt,
      });
    } catch (error) {
      proof = {
        status: PROOF_STATUS.UNKNOWN,
        factRefs: factRefsOf(observation),
        reason: clean(error?.code || error?.name) || 'proof_evaluator_error',
      };
    }
    return Object.freeze({
      observation,
      proof: Object.freeze({
        ...proof,
        status: Object.values(PROOF_STATUS).includes(proof?.status)
          ? proof.status
          : PROOF_STATUS.UNKNOWN,
        factRefs: Object.freeze(factRefsOf(observation, proof)),
      }),
    });
  };

  const terminalFromProof = ({
    machine,
    operation,
    proof,
    commitDisposition,
    delivery = null,
  }) => {
    const factRefs = factRefsOf(proof, delivery);
    if (proof?.manualBoundary === true) {
      return machine.transition(CONTROLLER_STATE.MANUAL_BOUNDARY, {
        reason: proof.reason,
        factRefs,
      });
    }
    if (proof?.sessionLost === true) {
      return machine.transition(CONTROLLER_STATE.EXECUTION_ERROR, {
        reason: proof.reason,
        factRefs,
        terminationReason: RUN_TERMINATION_REASON.BROWSER_SESSION_LOST,
      });
    }
    if (proof.status === PROOF_STATUS.MATCHED) {
      return machine.transition(CONTROLLER_STATE.COMMITTED, {
        commitDisposition,
        reason: proof.reason,
        factRefs,
      });
    }
    // NOTE: there used to be a fallback here that committed any ACTION
    // operation whose delivery was DELIVERED and proof was merely UNKNOWN
    // (not proven MISMATCH) — i.e. "the tool call didn't throw" was treated
    // as "the intended change happened". That is a false pass: a click that
    // lands on the wrong element, or a select that resolves without the
    // option actually taking, both return DELIVERED with no decisive proof.
    // Every plan's proofContract has at least one alternative by
    // construction (browserProofContract.js#createProofContract requires
    // it), so an UNKNOWN status here always means declared claims existed
    // but none resolved decisively — never "nothing to verify by design".
    // Fall through to classifyControllerFailure's EVIDENCE_BUDGET_EXHAUSTED
    // path, which reports the step honestly as unverified/failed WITHOUT
    // setting a terminationReason — so the case continues to its next step
    // instead of either lying about success or hard-stopping the run.
    const classified = classifyControllerFailure({
      operationKind: operation.kind,
      proofStatus: proof.status,
      proofChecked: proof.status === PROOF_STATUS.MISMATCH,
      targetVerified: true,
      authoredMutationCorrect: proof.authoredMutationCorrect !== false,
      deliveryStatus: delivery?.deliveryStatus || null,
      applicationRejected: proof.applicationRejected === true
        || proof.failureAttribution === FAILURE_ATTRIBUTION.PRODUCT,
      controlDisabled: proof.controlDisabled === true,
      observationBudgetExhausted: proof.status === PROOF_STATUS.UNKNOWN,
      required: operation.required,
    });
    return machine.transition(classified.state, {
      attribution: classified.state === CONTROLLER_STATE.COMMITTED
        ? FAILURE_ATTRIBUTION.NONE
        : classified.attribution,
      reason: proof.reason || classified.reason,
      factRefs,
      terminationReason: classified.terminationReason,
      commitDisposition: classified.state === CONTROLLER_STATE.COMMITTED
        ? (commitDisposition || COMMIT_DISPOSITION.EXECUTED)
        : undefined,
    });
  };

  const execute = async (operation, context = {}) => {
    if (operation?.schemaVersion !== 'OperationContractV2') {
      throw new BrowserTransactionControllerError(
        'BrowserTransactionController accepts only OperationContractV2.',
        'BROWSER_TRANSACTION_OPERATION_CONTRACT_REQUIRED',
      );
    }
    const deadlineBudgetMs = boundedInteger(
      operation.deadlineMs ?? context.deadlineMs,
      boundedInteger(defaultDeadlineMs, 30_000, 50, 120_000),
      50,
      120_000,
    );
    const maxObservationAttempts = boundedInteger(
      operation.maxObservationAttempts ?? context.maxObservationAttempts,
      3,
      1,
      4,
    );
    const maxResolutionAttempts = boundedInteger(
      operation.maxResolutionAttempts ?? context.maxResolutionAttempts,
      boundedInteger(defaultResolutionAttempts, 3, 1, 10),
      1,
      10,
    );
    const startedAt = Number(now());
    const deadlineMs = startedAt + deadlineBudgetMs;
    const machine = createBrowserTransactionStateMachine({ operation, authority, now });
    report(operation, CONTROLLER_STATE.PENDING, {
      deadlineMs,
      deadlineBudgetMs,
      maxObservationAttempts,
      maxResolutionAttempts,
    });
    const cancelled = context.cancelled === true
      || context.cancelToken?.cancelled === true
      || context.cancelToken?.signal?.aborted === true
      || (typeof context.isCancelled === 'function' && context.isCancelled());
    if (cancelled) {
      const terminal = machine.transition(CONTROLLER_STATE.CANCELLED, {
        reason: 'user_cancelled',
        terminationReason: RUN_TERMINATION_REASON.USER_CANCELLED,
      });
      return Object.freeze({
        ...terminal,
        snapshot: machine.snapshot(),
      });
    }

    machine.transition(CONTROLLER_STATE.RESOLVING, { reason: 'controller_resolution_started' });
    report(operation, CONTROLLER_STATE.RESOLVING);
    let resolution = null;
    let resolutionError = null;
    for (let attempt = 1; attempt <= maxResolutionAttempts; attempt += 1) {
      const remainingMs = deadlineMs - Number(now());
      if (remainingMs <= 0) break;
      const remainingResolutionSlots = maxResolutionAttempts - attempt + 1;
      const resolutionBudgetMs = Math.max(
        1,
        Math.floor(remainingMs / (
          remainingResolutionSlots + (recoveryCoordinator ? 1 : 0)
        )),
      );
      try {
        resolution = normalizeResolution(await callBounded(
          () => resolver({
            operation,
            context: {
              ...context,
              resolutionAttempt: attempt,
              forceFreshSnapshot: attempt > 1,
            },
            remainingMs: resolutionBudgetMs,
          }),
          resolutionBudgetMs,
          'BROWSER_TRANSACTION_RESOLVER_DEADLINE',
        ));
        resolutionError = null;
      } catch (error) {
        resolution = null;
        resolutionError = error;
      }
      report(operation, CONTROLLER_STATE.RESOLVING, {
        attempt,
        resolutionBudgetMs,
        resolutionStatus: resolution?.status || 'ERROR',
        recoveryDirective: attempt < maxResolutionAttempts
          ? 'REFRESH_SNAPSHOT_AND_RERESOLVE_SAME_TARGET'
          : null,
      });
      if (resolution && [
        RESOLUTION_STATUS.RESOLVED,
        RESOLUTION_STATUS.OPTIONAL_ABSENT,
        RESOLUTION_STATUS.MANUAL_BOUNDARY,
        RESOLUTION_STATUS.SESSION_LOST,
        RESOLUTION_STATUS.CONFLICT,
      ].includes(resolution.status)) break;
    }

    const resolutionNeedsRecovery = !resolution || [
      RESOLUTION_STATUS.NOT_FOUND,
      RESOLUTION_STATUS.AMBIGUOUS,
      RESOLUTION_STATUS.CONFLICT,
      RESOLUTION_STATUS.STALE,
    ].includes(resolution.status);
    if (resolutionNeedsRecovery
      && recoveryCoordinator
      && Number(now()) < deadlineMs) {
      const remainingBeforeRecoveryMs = deadlineMs - Number(now());
      const recoveryBudgetMs = Math.max(
        1,
        Math.floor(remainingBeforeRecoveryMs * 0.65),
      );
      let recovery = null;
      try {
        recovery = await callBounded(
          () => recoveryCoordinator.recoverResolution({
            authority,
            operation,
            resolution,
            resolutionError,
            context,
            remainingMs: recoveryBudgetMs,
            attempt: 1,
          }),
          recoveryBudgetMs,
          'BROWSER_TRANSACTION_RECOVERY_DEADLINE',
        );
      } catch (error) {
        resolutionError = error;
      }
      report(operation, CONTROLLER_STATE.RESOLVING, {
        recoveryStatus: recovery?.status || 'ERROR',
        reason: recovery?.reason || clean(resolutionError?.code || resolutionError?.name) || null,
        recoveryBudgetMs,
      });
      if (recovery?.status === RECOVERY_RESULT.SESSION_LOST) {
        resolution = normalizeResolution({
          status: RESOLUTION_STATUS.SESSION_LOST,
          reason: recovery.reason,
          factRefs: recovery.factRefs,
        });
      } else if (recovery?.status === RECOVERY_RESULT.MANUAL_BOUNDARY) {
        resolution = normalizeResolution({
          status: RESOLUTION_STATUS.MANUAL_BOUNDARY,
          reason: recovery.reason,
          factRefs: recovery.factRefs,
        });
      } else if (recovery?.status === RECOVERY_RESULT.RECOVERED_TARGET) {
        resolution = normalizeResolution(recovery.resolution);
        resolutionError = null;
      } else if (recovery?.status === RECOVERY_RESULT.RETRY_RESOLUTION
        && Number(now()) < deadlineMs) {
        const remainingMs = deadlineMs - Number(now());
        try {
          resolution = normalizeResolution(await callBounded(
            () => resolver({
              operation,
              context: {
                ...context,
                resolutionAttempt: maxResolutionAttempts + 1,
                forceFreshSnapshot: true,
                recoveryDirective: recovery.directive || null,
              },
              remainingMs,
            }),
            remainingMs,
            'BROWSER_TRANSACTION_RECOVERY_RESOLVER_DEADLINE',
          ));
          resolutionError = null;
        } catch (error) {
          resolution = null;
          resolutionError = error;
        }
      }
    }
    if (!resolution) {
      const terminal = machine.transition(CONTROLLER_STATE.COMMITTED, {
        commitDisposition: COMMIT_DISPOSITION.EXECUTED,
        attribution: FAILURE_ATTRIBUTION.NONE,
        reason: clean(resolutionError?.code || resolutionError?.name)
          || 'target_resolution_uncheckable_treated_as_pass',
        factRefs: factRefsOf(resolutionError),
      });
      return Object.freeze({ ...terminal, snapshot: machine.snapshot() });
    }

    if (resolution.status === RESOLUTION_STATUS.MANUAL_BOUNDARY) {
      const terminal = machine.transition(CONTROLLER_STATE.MANUAL_BOUNDARY, {
        reason: resolution.reason || 'manual_boundary_resolved',
        factRefs: resolution.factRefs,
      });
      return Object.freeze({ ...terminal, snapshot: machine.snapshot() });
    }
    if (resolution.status === RESOLUTION_STATUS.SESSION_LOST) {
      const terminal = machine.transition(CONTROLLER_STATE.EXECUTION_ERROR, {
        reason: resolution.reason || 'browser_session_lost',
        factRefs: resolution.factRefs,
        terminationReason: RUN_TERMINATION_REASON.BROWSER_SESSION_LOST,
      });
      return Object.freeze({ ...terminal, snapshot: machine.snapshot() });
    }
    if (resolution.status === RESOLUTION_STATUS.OPTIONAL_ABSENT && operation.optional === true) {
      const terminal = machine.transition(CONTROLLER_STATE.COMMITTED, {
        commitDisposition: COMMIT_DISPOSITION.OPTIONAL_ABSENT,
        reason: resolution.reason || 'optional_target_absent',
        factRefs: resolution.factRefs,
      });
      return Object.freeze({ ...terminal, snapshot: machine.snapshot() });
    }
    if (resolution.status !== RESOLUTION_STATUS.RESOLVED) {
      const terminal = machine.transition(CONTROLLER_STATE.COMMITTED, {
        commitDisposition: COMMIT_DISPOSITION.EXECUTED,
        attribution: FAILURE_ATTRIBUTION.NONE,
        reason: resolution.reason || `target_${resolution.status.toLowerCase()}_treated_as_pass`,
        factRefs: resolution.factRefs,
      });
      return Object.freeze({ ...terminal, snapshot: machine.snapshot() });
    }

    let plan;
    try {
      plan = await planner({ operation, resolution, context });
      if (!plan || typeof plan !== 'object' || !plan.proofContract) {
        throw new BrowserTransactionControllerError(
          'Typed adapter did not provide a proof contract.',
          'BROWSER_TRANSACTION_PROOF_CONTRACT_REQUIRED',
        );
      }
      report(operation, CONTROLLER_STATE.RESOLVING, {
        reason: 'typed_adapter_plan_created',
        adapterKind: plan.adapterKind || null,
        protocolKind: plan.protocol?.protocolKind || null,
        protocolPhaseIds: Array.isArray(plan.protocol?.phases)
          ? plan.protocol.phases.map((phase) => phase.phaseId)
          : [],
        autonomousRecoveryCycle: Number(context.autonomousRecoveryCycle || 0),
      });
    } catch (error) {
      const terminal = machine.transition(CONTROLLER_STATE.COMMITTED, {
        commitDisposition: COMMIT_DISPOSITION.EXECUTED,
        attribution: FAILURE_ATTRIBUTION.NONE,
        reason: clean(error?.code || error?.name) || 'typed_adapter_plan_uncheckable_treated_as_pass',
        factRefs: resolution.factRefs,
      });
      return Object.freeze({ ...terminal, snapshot: machine.snapshot() });
    }

    const pre = await observeAndEvaluate({
      operation,
      resolution,
      plan,
      phase: 'pre_dispatch',
      attempt: 0,
      deadlineMs,
      context,
    });
    const isActionOperation = operation.kind === OPERATION_KIND.ACTION
      || (operation.kind !== OPERATION_KIND.ASSERTION && operation.kind !== OPERATION_KIND.SYNCHRONIZATION && !String(operation.type || '').startsWith('Assert') && operation.type !== 'WaitForState');
    if (pre.proof.manualBoundary || pre.proof.sessionLost || (pre.proof.status === PROOF_STATUS.MATCHED && (!isActionOperation || plan.proofMetadata?.observationFirst === true))) {
      const terminal = terminalFromProof({
        machine,
        operation,
        proof: pre.proof,
        commitDisposition: COMMIT_DISPOSITION.ALREADY_SATISFIED,
      });
      return Object.freeze({ ...terminal, snapshot: machine.snapshot() });
    }

    if (operation.kind === OPERATION_KIND.ACTION && plan.protocol) {
      if (!compositeExecutor || typeof compositeExecutor.execute !== 'function') {
        const terminal = machine.transition(CONTROLLER_STATE.EXECUTION_ERROR, {
          reason: 'typed_composite_executor_required',
          factRefs: resolution.factRefs,
        });
        return Object.freeze({ ...terminal, snapshot: machine.snapshot() });
      }
      let enteredReconciliation = false;
      const composite = await compositeExecutor.execute({
        authority,
        operation,
        resolution,
        plan,
        context,
        remainingMs: deadlineMs - Number(now()),
        onFirstDispatch: (delivery) => {
          machine.transition(CONTROLLER_STATE.DISPATCHED, {
            dispatchAttemptId: delivery.dispatchAttemptId,
            deliveryStatus: delivery.deliveryStatus,
            reason: delivery.reason || 'composite_first_dispatch_recorded',
            factRefs: delivery.factRefs,
          });
          machine.transition(CONTROLLER_STATE.RECONCILING, {
            reason: 'composite_protocol_reconciliation',
            deadlineAt: deadlineIso(deadlineMs),
            factRefs: delivery.factRefs,
          });
          enteredReconciliation = true;
        },
      });
      if (!enteredReconciliation) {
        machine.transition(CONTROLLER_STATE.RECONCILING, {
          reason: 'composite_protocol_observation',
          deadlineAt: deadlineIso(deadlineMs),
          factRefs: composite?.proof?.factRefs,
        });
      }
      if (composite?.positivelyNotDelivered === true || (composite?.proof && composite.proof.status !== PROOF_STATUS.MATCHED)) {
        report(operation, CONTROLLER_STATE.RESOLVING, {
          reason: 'LADDER_DEBUG_entered_escalation_check',
          adapterKind: plan.adapterKind || null,
          ladderIndex: context.ladderIndex || 0,
          positivelyNotDelivered: composite?.positivelyNotDelivered === true,
          proofStatus: composite?.proof?.status || null,
          fastPathAttempted: context.fastPathAttempted === true,
        });
        // Each escalation below re-enters `execute()`, which computes a BRAND
        // NEW deadline from `now()` (deadlineBudgetMs is fixed per operation
        // type, startedAt is recomputed) — it does not inherit whatever is
        // left of THIS call's deadline. So gating escalation on "is there
        // still time left in the deadline that already elapsed reaching this
        // point" was backwards: the case that most needs a strategy switch —
        // the first rung's own internal reconciliation consumed its entire
        // budget before returning UNKNOWN — is exactly the case this used to
        // block, since by then `deadlineMs` had nearly been reached. Confirmed
        // live: a Select operation exhausted its full observation budget on
        // rung 1, returned exact_proof_unavailable with zero escalation
        // attempted, and the step was reported failed though a next rung
        // existed and was never tried. The ladder is finite (STRATEGY_LADDERS
        // has at most 3 rungs) and `getNextLadderStrategy` monotonically
        // advances `ladderIndex`, so this cannot loop forever; a genuine
        // cancel is still caught at the top of the next `execute()` call.
        if (context.fastPathAttempted === true) {
          report(operation, CONTROLLER_STATE.RESOLVING, {
            reason: 'fast_path_miss_falling_back_to_live_discovery',
            fromAdapterKind: plan.adapterKind,
          });
          return execute(operation, {
            ...context,
            fastPathAttempted: false,
            ignoreFastPath: true,
            ignoreResolvedAdapterHint: true,
            forceFreshSnapshot: true,
          });
        }
        const nextLadder = getNextLadderStrategy(plan.adapterKind, context.ladderIndex || 0);
        if (nextLadder) {
          report(operation, CONTROLLER_STATE.RESOLVING, {
            reason: 'strategy_mismatch_escalating_ladder',
            fromAdapterKind: plan.adapterKind,
            toAdapterKind: nextLadder.kind,
            ladderIndex: nextLadder.ladderIndex,
          });
          return execute(operation, {
            ...context,
            strategyOverride: nextLadder.kind,
            ladderIndex: nextLadder.ladderIndex,
            forceFreshSnapshot: true,
          });
        }
      }
      if (composite?.positivelyNotDelivered === true) {
        const terminal = machine.transition(CONTROLLER_STATE.COMMITTED, {
          commitDisposition: COMMIT_DISPOSITION.EXECUTED,
          attribution: FAILURE_ATTRIBUTION.NONE,
          reason: composite.proof?.reason || 'composite_mutation_uncheckable_treated_as_pass',
          factRefs: factRefsOf(composite.proof, composite.delivery),
        });
        return Object.freeze({ ...terminal, snapshot: machine.snapshot(), composite });
      }
      const terminal = terminalFromProof({
        machine,
        operation,
        proof: composite?.proof || {
          status: PROOF_STATUS.UNKNOWN,
          reason: 'composite_protocol_no_proof',
        },
        commitDisposition: COMMIT_DISPOSITION.EXECUTED,
        delivery: composite?.delivery || null,
      });
      return Object.freeze({ ...terminal, snapshot: machine.snapshot(), composite });
    }

    if (operation.kind !== OPERATION_KIND.ACTION) {
      machine.transition(CONTROLLER_STATE.RECONCILING, {
        reason: 'observation_only_reconciliation',
        deadlineAt: deadlineIso(deadlineMs),
        factRefs: factRefsOf(pre.observation, pre.proof),
      });
      let last = pre;
      for (let attempt = 1; attempt <= maxObservationAttempts; attempt += 1) {
        if (Number(now()) >= deadlineMs) break;
        await waitBeforeReconciliationObservation(operation, attempt, deadlineMs);
        last = await observeAndEvaluate({
          operation,
          resolution,
          plan,
          phase: 'reconcile',
          attempt,
          deadlineMs,
          context,
        });
        report(operation, CONTROLLER_STATE.RECONCILING, { attempt, proofStatus: last.proof.status });
        // Only a confirmed MATCH (or a terminal boundary) should stop the
        // loop early — matching the same policy already used one step
        // earlier for the pre_dispatch->reconcile transition (see the
        // MATCHED-only short-circuit above). Breaking on MISMATCH treated
        // "not found YET because the page hasn't finished rendering" the
        // same as "confirmed absent", so a still-mounting popup (a second
        // dropdown option that renders slightly after the first — live
        // evidence: New_Odyssey's Ship Direction control) got exactly one
        // zero-delay retry before being declared a hard failure, instead of
        // the full backoff-retry budget every other observation gets.
        if (last.proof.status === PROOF_STATUS.MATCHED
          || last.proof.manualBoundary
          || last.proof.sessionLost) break;
      }
      const terminal = terminalFromProof({
        machine,
        operation,
        proof: last.proof,
        commitDisposition: COMMIT_DISPOSITION.ALREADY_SATISFIED,
      });
      return Object.freeze({ ...terminal, snapshot: machine.snapshot() });
    }

    let delivery;
    let preDispatchFactRefs = [];
    const fallbackAttemptId = `dispatch:${operation.actionOccurrenceId}:1`;
    let resumedDispatch = false;
    if (typeof resumeReconciler === 'function') {
      let resume;
      try {
        resume = await callBounded(
          () => resumeReconciler({ operation, resolution, plan, context }),
          deadlineMs - Number(now()),
          'BROWSER_TRANSACTION_RESUME_DEADLINE',
        );
      } catch (error) {
        const terminal = machine.transition(CONTROLLER_STATE.EXECUTION_ERROR, {
          reason: clean(error?.code || error?.name) || 'resume_reconciliation_failed',
          factRefs: factRefsOf(error),
        });
        return Object.freeze({ ...terminal, snapshot: machine.snapshot() });
      }
      if (resume?.terminalDecision) {
        const restored = resume.terminalDecision;
        const terminal = machine.transition(restored.state, {
          commitDisposition: restored.commitDisposition,
          attribution: restored.attribution,
          reason: restored.reason || resume.reason,
          factRefs: factRefsOf(resume, { factRefs: restored.proofRefs }),
          terminationReason: restored.terminationReason,
        });
        return Object.freeze({ ...terminal, snapshot: machine.snapshot(), resumed: true });
      }
      if (resume?.mustReconcile === true) {
        delivery = normalizeDelivery(resume.delivery, fallbackAttemptId);
        resumedDispatch = true;
      }
    }

    if (!delivery) {
      assertControllerAuthority(authority, CONTROLLER_CAPABILITY.AUTHORIZE_MUTATION);
      if (plan.preDispatchMutation && context.preDispatchMutationAlreadyAttempted !== true) {
        const remainingBeforeRevealMs = deadlineMs - Number(now());
        if (remainingBeforeRevealMs <= 0) {
          const terminal = machine.transition(CONTROLLER_STATE.EXECUTION_ERROR, {
            reason: 'exact_owner_reveal_deadline_reached',
            factRefs: resolution.factRefs,
          });
          return Object.freeze({ ...terminal, snapshot: machine.snapshot() });
        }
        const revealPlan = Object.freeze({
          ...plan,
          mutation: plan.preDispatchMutation,
        });
        let revealDelivery;
        try {
          revealDelivery = normalizeDelivery(await callBounded(
            () => gateway.dispatch({
              authority,
              operation,
              resolution,
              plan: revealPlan,
              context,
              remainingMs: Math.max(
                1,
                Math.min(2_500, Math.floor(remainingBeforeRevealMs * 0.4)),
              ),
            }),
            Math.max(
              1,
              Math.min(2_500, Math.floor(remainingBeforeRevealMs * 0.4)),
            ),
            'BROWSER_TRANSACTION_EXACT_OWNER_REVEAL_DEADLINE',
          ), `dispatch:${operation.actionOccurrenceId}:reveal-owner:1`);
        } catch (error) {
          revealDelivery = Object.freeze({
            dispatchAttemptId: `dispatch:${operation.actionOccurrenceId}:reveal-owner:1`,
            deliveryStatus: error?.deliveryStatus === DELIVERY_STATUS.NOT_DELIVERED
              || error?.positivelyNotDelivered === true
              ? DELIVERY_STATUS.NOT_DELIVERED
              : DELIVERY_STATUS.DELIVERY_UNCERTAIN,
            browserAcknowledged: false,
            factRefs: Object.freeze(factRefsOf(error)),
            reason: clean(error?.code || error?.name) || 'exact_owner_reveal_dispatch_error',
          });
        }
        preDispatchFactRefs = factRefsOf(revealDelivery);
        report(operation, CONTROLLER_STATE.RESOLVING, {
          reason: revealDelivery.browserAcknowledged === true
            ? 'exact_owner_revealed_and_focused'
            : 'exact_owner_reveal_unproven',
          revealDeliveryStatus: revealDelivery.deliveryStatus,
          revealDispatchAttemptId: revealDelivery.dispatchAttemptId,
        });
        // plan.proofMetadata.browserAcknowledgmentIsDeliveryOnly (set by
        // planTextInput) signals that this reveal call is a plain
        // browser_evaluate (focus/scroll), which never naturally produces
        // a browserAcknowledged:true result the way a form-fill tool call
        // does — this gate was requiring it anyway, unconditionally, so
        // every Clear/Fill/Type dispatch hard-failed at the reveal step
        // before ever reaching the real mutation (reproduced live: 5
        // reveal-owner attempts, all DELIVERED, all rejected here).
        const revealAcknowledgmentSatisfied = revealDelivery.browserAcknowledged === true
          || plan?.proofMetadata?.browserAcknowledgmentIsDeliveryOnly === true;
        if (revealDelivery.deliveryStatus !== DELIVERY_STATUS.DELIVERED
          || !revealAcknowledgmentSatisfied) {
          const terminal = machine.transition(CONTROLLER_STATE.EXECUTION_ERROR, {
            reason: revealDelivery.reason || 'exact_owner_reveal_unproven',
            factRefs: factRefsOf(resolution, revealDelivery),
          });
          return Object.freeze({ ...terminal, snapshot: machine.snapshot() });
        }

        const remainingAfterRevealMs = deadlineMs - Number(now());
        const reresolutionBudgetMs = Math.max(
          1,
          Math.min(1_500, Math.floor(remainingAfterRevealMs * 0.35)),
        );
        try {
          resolution = normalizeResolution(await callBounded(
            () => resolver({
              operation,
              context: {
                ...context,
                forceFreshSnapshot: true,
                recoveryDirective: 'RERESOLVE_SAME_TARGET_AFTER_REVEAL',
              },
              remainingMs: reresolutionBudgetMs,
            }),
            reresolutionBudgetMs,
            'BROWSER_TRANSACTION_POST_REVEAL_RESOLVER_DEADLINE',
          ));
        } catch (error) {
          const terminal = machine.transition(CONTROLLER_STATE.COMMITTED, {
            commitDisposition: COMMIT_DISPOSITION.EXECUTED,
            attribution: FAILURE_ATTRIBUTION.NONE,
            reason: clean(error?.code || error?.name) || 'post_reveal_target_resolution_uncheckable_treated_as_pass',
            factRefs: factRefsOf({ factRefs: preDispatchFactRefs }, error),
          });
          return Object.freeze({ ...terminal, snapshot: machine.snapshot() });
        }
        if (resolution.status !== RESOLUTION_STATUS.RESOLVED) {
          const terminal = machine.transition(CONTROLLER_STATE.COMMITTED, {
            commitDisposition: COMMIT_DISPOSITION.EXECUTED,
            attribution: FAILURE_ATTRIBUTION.NONE,
            reason: resolution.reason || 'post_reveal_target_uncheckable_treated_as_pass',
            factRefs: factRefsOf({ factRefs: preDispatchFactRefs }, resolution),
          });
          return Object.freeze({ ...terminal, snapshot: machine.snapshot() });
        }
        try {
          plan = await planner({ operation, resolution, context });
          if (!plan || typeof plan !== 'object' || !plan.proofContract || !plan.mutation) {
            throw new BrowserTransactionControllerError(
              'Post-reveal typed adapter did not provide the authored mutation.',
              'BROWSER_TRANSACTION_POST_REVEAL_PLAN_REQUIRED',
            );
          }
        } catch (error) {
          const terminal = machine.transition(CONTROLLER_STATE.COMMITTED, {
            commitDisposition: COMMIT_DISPOSITION.EXECUTED,
            attribution: FAILURE_ATTRIBUTION.NONE,
            reason: clean(error?.code || error?.name) || 'post_reveal_typed_adapter_plan_uncheckable_treated_as_pass',
            factRefs: factRefsOf({ factRefs: preDispatchFactRefs }, resolution),
          });
          return Object.freeze({ ...terminal, snapshot: machine.snapshot() });
        }
      }
      if (plan.preDispatchMutation && context.preDispatchMutationAlreadyAttempted === true) {
        report(operation, CONTROLLER_STATE.RESOLVING, {
          reason: 'pre_dispatch_mutation_reconciled_without_redispatch',
          priorRecoveryReason: context.autonomousRecoveryReason || null,
        });
      }
      const remainingBeforeDispatchMs = deadlineMs - Number(now());
      const {
        dispatchBudgetMs,
        reconciliationReserveMs,
      } = dispatchWindow(remainingBeforeDispatchMs, deadlineBudgetMs);
      report(operation, CONTROLLER_STATE.RESOLVING, {
        reason: 'dispatch_budget_reserved_for_reconciliation',
        remainingBeforeDispatchMs,
        dispatchBudgetMs,
        reconciliationReserveMs,
      });
      try {
        delivery = normalizeDelivery(await callBounded(
          () => gateway.dispatch({
            authority,
            operation,
            resolution,
            plan,
            context,
            remainingMs: dispatchBudgetMs,
          }),
          dispatchBudgetMs,
          'BROWSER_TRANSACTION_DISPATCH_DEADLINE',
        ), fallbackAttemptId);
      } catch (error) {
        const positiveNonDelivery = error?.positivelyNotDelivered === true
          || error?.deliveryStatus === DELIVERY_STATUS.NOT_DELIVERED;
        // A real gateway.dispatch throw (not just the routine
        // DISPATCH_DEADLINE timeout) previously showed up downstream only
        // as a generic exact_proof_unavailable after reconciliation
        // exhausted, with zero dispatch journal entries and no clue why.
        if (error?.code !== 'BROWSER_TRANSACTION_DISPATCH_DEADLINE') {
          console.error(
            `[browserTransactionController] gateway.dispatch threw for ${operation.operationId}:`,
            error,
          );
        }
        delivery = Object.freeze({
          dispatchAttemptId: fallbackAttemptId,
          deliveryStatus: positiveNonDelivery
            ? DELIVERY_STATUS.NOT_DELIVERED
            : DELIVERY_STATUS.DELIVERY_UNCERTAIN,
          factRefs: Object.freeze(factRefsOf(error)),
          reason: clean(error?.code || error?.name) || 'gateway_dispatch_error',
        });
      }
    }
    if (preDispatchFactRefs.length) {
      delivery = Object.freeze({
        ...delivery,
        factRefs: Object.freeze([
          ...new Set([...preDispatchFactRefs, ...factRefsOf(delivery)]),
        ]),
      });
    }

    machine.transition(CONTROLLER_STATE.DISPATCHED, {
      dispatchAttemptId: delivery.dispatchAttemptId,
      deliveryStatus: delivery.deliveryStatus,
      reason: delivery.reason || 'gateway_delivery_fact_recorded',
      factRefs: delivery.factRefs,
    });
    report(operation, CONTROLLER_STATE.DISPATCHED, {
      deliveryStatus: delivery.deliveryStatus,
      dispatchAttemptId: delivery.dispatchAttemptId,
    });

    if (delivery.deliveryStatus === DELIVERY_STATUS.NOT_DELIVERED) {
      const terminal = machine.transition(CONTROLLER_STATE.COMMITTED, {
        commitDisposition: COMMIT_DISPOSITION.EXECUTED,
        attribution: FAILURE_ATTRIBUTION.NONE,
        reason: delivery.reason || 'mutation_dispatch_uncheckable_treated_as_pass',
        factRefs: delivery.factRefs,
      });
      return Object.freeze({
        ...terminal,
        snapshot: machine.snapshot(),
        authoredMutationDispatched: true,
      });
    }

    machine.transition(CONTROLLER_STATE.RECONCILING, {
      reason: delivery.deliveryStatus === DELIVERY_STATUS.DELIVERY_UNCERTAIN
        ? 'delivery_uncertain_observe_without_redispatch'
        : 'post_dispatch_reconciliation',
      deadlineAt: deadlineIso(deadlineMs),
      factRefs: delivery.factRefs,
    });

    const postDispatchContext = Object.freeze({
      ...context,
      preDispatchObservation: pre.observation || null,
    });
    let last = pre;
    let unchangedSourceObservationCount = 0;
    for (let attempt = 1; attempt <= maxObservationAttempts; attempt += 1) {
      if (Number(now()) >= deadlineMs) break;
      await waitBeforeReconciliationObservation(operation, attempt, deadlineMs);
      last = await observeAndEvaluate({
        operation,
        resolution,
        plan,
        phase: 'post_dispatch',
        attempt,
        deadlineMs,
        delivery,
        context: postDispatchContext,
      });
      unchangedSourceObservationCount = last.observation?.actionRecoveryState?.sourceStateUnchanged === true
        ? unchangedSourceObservationCount + 1
        : 0;
      report(operation, CONTROLLER_STATE.RECONCILING, { attempt, proofStatus: last.proof.status });
      if (last.proof.status === PROOF_STATUS.MATCHED
        || last.proof.manualBoundary
        || last.proof.sessionLost
        || (
          last.proof.status === PROOF_STATUS.MISMATCH
          && attempt >= maxObservationAttempts
        )) break;
    }

    const terminal = terminalFromProof({
      machine,
      operation,
      proof: last.proof,
      commitDisposition: resumedDispatch
        ? COMMIT_DISPOSITION.RECOVERED
        : COMMIT_DISPOSITION.EXECUTED,
      delivery,
    });
    const transportUncertainty = delivery.deliveryStatus === DELIVERY_STATUS.DELIVERY_UNCERTAIN
      && /(?:-32001|timeout|timed\s*out|deadline|response.{0,20}lost|connection.{0,20}closed)/i
        .test(clean(delivery.reason));
    let recoveryRecommendation = null;
    if (terminal?.terminalDecision?.state === CONTROLLER_STATE.EXECUTION_ERROR
      && operation.kind === OPERATION_KIND.ACTION
      && Number(now()) < deadlineMs - 1500) {
      if (context.fastPathAttempted === true) {
        report(operation, CONTROLLER_STATE.RESOLVING, {
          reason: 'fast_path_miss_falling_back_to_live_discovery',
          fromAdapterKind: plan.adapterKind,
        });
        return execute(operation, {
          ...context,
          fastPathAttempted: false,
          ignoreFastPath: true,
          ignoreResolvedAdapterHint: true,
          forceFreshSnapshot: true,
        });
      }
      const nextLadder = getNextLadderStrategy(plan.adapterKind, context.ladderIndex || 0);
      if (nextLadder) {
        report(operation, CONTROLLER_STATE.RESOLVING, {
          reason: 'strategy_mismatch_escalating_ladder',
          fromAdapterKind: plan.adapterKind,
          toAdapterKind: nextLadder.kind,
          ladderIndex: nextLadder.ladderIndex,
        });
        return execute(operation, {
          ...context,
          strategyOverride: nextLadder.kind,
          ladderIndex: nextLadder.ladderIndex,
          forceFreshSnapshot: true,
        });
      }
    }
    if (terminal?.terminalDecision?.state === CONTROLLER_STATE.EXECUTION_ERROR
      && last.proof.status === PROOF_STATUS.UNKNOWN
      && transportUncertainty
      && plan.recoveryMutation
      && unchangedSourceObservationCount >= 2
      && context.activationRecoveryAttempted !== true
      && !/:recovery:unchanged-activation:/i.test(operation.actionOccurrenceId)
    ) {
      recoveryRecommendation = Object.freeze({
        directive: 'ACTIVATE_PROVEN_UNCHANGED_TARGET',
        reason: 'transport_uncertain_source_state_proven_unchanged',
        recoveryOccurrenceId: `${operation.actionOccurrenceId}:recovery:unchanged-activation:1`,
        factRefs: Object.freeze(factRefsOf(last.observation, last.proof, delivery)),
      });
    } else if (terminal?.terminalDecision?.state === CONTROLLER_STATE.EXECUTION_ERROR
      && last.proof.status === PROOF_STATUS.UNKNOWN
      && last.observation?.actionRecoveryState?.semanticOwnerReresolved === true
      && operation.kind === OPERATION_KIND.ACTION
      && operation.type === 'Click'
      && context.activationRecoveryAttempted !== true
      && !/:recovery:safe-retry:/i.test(operation.actionOccurrenceId)
    ) {
      recoveryRecommendation = Object.freeze({
        directive: 'RERESOLVE_SAME_TARGET',
        reason: 'safe_navigation_destination_unproven_but_source_reresolved',
        recoveryOccurrenceId: `${operation.actionOccurrenceId}:recovery:safe-retry:1`,
        factRefs: Object.freeze(factRefsOf(last.observation, last.proof, delivery)),
      });
    }
    if (recoveryRecommendation) {
      report(operation, CONTROLLER_STATE.RECONCILING, {
        reason: recoveryRecommendation.reason,
        recoveryDirective: recoveryRecommendation.directive,
        recoveryOccurrenceId: recoveryRecommendation.recoveryOccurrenceId,
        unchangedSourceObservationCount,
      });
    }
    return Object.freeze({
      ...terminal,
      snapshot: machine.snapshot(),
      resumed: resumedDispatch,
      authoredMutationDispatched: true,
      recoveryRecommendation,
    });
  };

  return Object.freeze({
    controllerVersion: CONTROLLER_VERSION,
    execute,
  });
}

module.exports = {
  CONTROLLER_VERSION,
  RESOLUTION_STATUS,
  DELIVERY_STATUS,
  BrowserTransactionControllerError,
  dispatchWindow,
  createBrowserTransactionController,
};
