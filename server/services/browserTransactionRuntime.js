'use strict';

const {
  CONTROLLER_STATE,
  FAILURE_ATTRIBUTION,
  createTerminalDecision,
} = require('./browserTransactionContract');
const {
  CONTROLLER_CAPABILITY,
  createControllerAuthority,
} = require('./browserTransactionAuthority');
const {
  createBrowserTransactionController,
} = require('./browserTransactionController');
const {
  createControllerExecutionScheduler,
} = require('./controllerExecutionScheduler');
const {
  createBrowserTransactionEventJournal,
} = require('./browserTransactionEventJournal');
const {
  createControllerResumeReconciler,
} = require('./controllerResumeReconciler');
const {
  createInMemoryVerdictRepository,
  projectControllerVerdict,
  persistControllerVerdict,
} = require('./controllerVerdictProjector');
const {
  projectAssertionDecision,
} = require('./controllerAssertionProjection');

const RUNTIME_VERSION = 'qaai-browser-transaction-runtime-v1';
const DEFAULT_RECOVERY_SLEEP = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

class BrowserTransactionRuntimeError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'BrowserTransactionRuntimeError';
    this.code = code;
    Object.assign(this, details);
  }
}

function createBrowserTransactionRuntime({
  controllerOptions,
  journal = createBrowserTransactionEventJournal(),
  verdictRepository = createInMemoryVerdictRepository(),
  heartbeat = () => {},
  recoverySleep = DEFAULT_RECOVERY_SLEEP,
  // Phase 30.0.1 — called immediately after an action-kind operation commits,
  // while the browser is still on the exact page/state that operation acted
  // on. Capturing here (not in a post-case batch) is required for
  // correctness: MCP snapshot refs are reused across later snapshots, so a
  // ref resolved after the case has navigated to later pages can silently
  // resolve to a DIFFERENT element (confirmed live: an Email Address field's
  // ref later matched an unrelated logo on the post-login dashboard). Bounded
  // internally by the adapter's own timeout so a slow verification call
  // degrades to "unverified", never a stall.
  captureLocatorEvidence = async () => null,
} = {}) {
  if (!controllerOptions || typeof controllerOptions !== 'object') {
    throw new TypeError('BrowserTransactionRuntime requires controller dependencies.');
  }

  const runCase = async ({
    operationContract,
    scopeId,
    context = {},
  } = {}) => {
    const authority = createControllerAuthority();
    const scheduler = createControllerExecutionScheduler({
      operationContract,
      authority,
    });
    const resume = createControllerResumeReconciler({ journal });
    const controller = createBrowserTransactionController({
      ...controllerOptions,
      controllerAuthority: authority,
      resumeReconciler: controllerOptions.resumeReconciler || resume.reconcile,
      heartbeat: (event) => {
        heartbeat(event);
        controllerOptions.heartbeat?.(event);
      },
    });
    const operationResults = [];
    const verifiedLocators = new Map();
    const orderedOperations = operationContract.operations.slice().sort((left, right) => (
      Number(left.ordinal || 0) - Number(right.ordinal || 0)
    ));
    const operationIndex = new Map(
      orderedOperations.map((operation, index) => [operation.operationId, index]),
    );

    while (true) {
      const operation = scheduler.claimNext();
      if (!operation) break;
      const index = operationIndex.get(operation.operationId) ?? -1;
      const operationDeadlineMs = typeof context.deadlineForOperation === 'function'
        ? context.deadlineForOperation(operation)
        : context.deadlineMs;
      const operationObservationAttempts = typeof context.observationAttemptsForOperation === 'function'
        ? context.observationAttemptsForOperation(operation)
        : context.maxObservationAttempts;
      const operationResolutionAttempts = typeof context.resolutionAttemptsForOperation === 'function'
        ? context.resolutionAttemptsForOperation(operation)
        : context.maxResolutionAttempts;
      const operationContext = Object.freeze({
        ...context,
        ...(operationDeadlineMs == null ? {} : { deadlineMs: operationDeadlineMs }),
        ...(operationObservationAttempts == null
          ? {}
          : { maxObservationAttempts: operationObservationAttempts }),
        ...(operationResolutionAttempts == null
          ? {}
          : { maxResolutionAttempts: operationResolutionAttempts }),
        laterOperations: Object.freeze(index >= 0 ? orderedOperations.slice(index + 1) : []),
        nextOperation: index >= 0 ? orderedOperations[index + 1] || null : null,
      });
      let result;
      let decision;
      let recoveryCycle = 0;
      let priorRecoveryReason = null;
      let activeOperation = operation;
      let controllerRecoveryDirective = null;
      let activationRecoveryAttempted = false;
      const maxAutonomousRecoveryCycles = Math.max(
        1,
        Math.min(8, Number(context.maxAutonomousRecoveryCycles) || 3),
      );
      while (true) {
        const preDispatchMutationAlreadyAttempted = recoveryCycle > 0
          && /(?:BROWSER_TRANSACTION_EXACT_OWNER_REVEAL_DEADLINE|exact_owner_reveal)/i
            .test(String(priorRecoveryReason || ''));
        const recoveryContext = recoveryCycle > 0
          ? Object.freeze({
              ...operationContext,
              autonomousRecoveryCycle: recoveryCycle,
              autonomousRecoveryReason: priorRecoveryReason,
              forceFreshSnapshot: true,
              resumeCompositePhases: true,
              ignoreResolvedAdapterHint: true,
              preDispatchMutationAlreadyAttempted,
              controllerRecoveryDirective,
              activationRecoveryAttempted,
            })
          : operationContext;
        try {
          result = await controller.execute(activeOperation, recoveryContext);
        } catch (error) {
          // This is the outermost wrapper around the entire controller
          // execution (dispatch + observe + proof) for every operation type.
          // Any unhandled exception anywhere in that path lands here and was
          // previously reduced to a bare error.name (e.g. a generic
          // "TypeError" with no stack, no line, no clue which of the many
          // possible causes it was) — reproduced live on 2026-08-07 for a
          // Clear-action step where the real defect was invisible without
          // manually adding instrumentation. Logging it here means any
          // future occurrence is immediately diagnosable from server.err.log.
          console.error(
            `[browserTransactionRuntime] controller.execute threw for ${activeOperation.operationId} (kind=${activeOperation.kind}, type=${activeOperation.type}):`,
            error,
          );
          const controllerErrorDecision = createTerminalDecision({
            operationId: activeOperation.operationId,
            actionOccurrenceId: activeOperation.actionOccurrenceId,
            operationKind: activeOperation.kind,
            state: CONTROLLER_STATE.EXECUTION_ERROR,
            attribution: FAILURE_ATTRIBUTION.QAAI_EXECUTION,
            reason: error?.code || error?.name || 'controller_unhandled_execution_error',
          });
          result = Object.freeze({ terminalDecision: controllerErrorDecision, error });
        }
        decision = result.terminalDecision;
        if (!decision) {
          throw new BrowserTransactionRuntimeError(
            'Controller returned without a terminal operation decision.',
            'BROWSER_TRANSACTION_RUNTIME_TERMINAL_DECISION_REQUIRED',
            { operationId: operation.operationId },
          );
        }

        const authorizedTermination = decision.continuation?.terminationReason || null;
        const requiresAutonomousRecovery = operation.kind === 'action'
          && decision.state === CONTROLLER_STATE.EXECUTION_ERROR
          && !authorizedTermination;
        if (!requiresAutonomousRecovery) break;

        if (result.authoredMutationDispatched === true
          && !result.recoveryRecommendation) {
          heartbeat({
            runtimeVersion: RUNTIME_VERSION,
            scopeId,
            operationId: operation.operationId,
            actionOccurrenceId: activeOperation.actionOccurrenceId,
            state: CONTROLLER_STATE.EXECUTION_ERROR,
            phase: 'observation_reconciliation_exhausted',
            reason: decision.reason || 'qaai_execution_uncertainty',
            duplicateMutationForbidden: true,
            recoveryMutationAuthorized: false,
            runTerminationAuthorized: false,
          });
          break;
        }

        if (recoveryCycle >= maxAutonomousRecoveryCycles) {
          heartbeat({
            runtimeVersion: RUNTIME_VERSION,
            scopeId,
            operationId: operation.operationId,
            actionOccurrenceId: operation.actionOccurrenceId,
            state: CONTROLLER_STATE.EXECUTION_ERROR,
            phase: 'autonomous_recovery_exhausted',
            reason: decision.reason || priorRecoveryReason || 'qaai_execution_uncertainty',
            recoveryCycle,
            maxAutonomousRecoveryCycles,
            runTerminationAuthorized: false,
          });
          break;
        }

        recoveryCycle += 1;
        priorRecoveryReason = decision.reason || 'qaai_execution_uncertainty';
        if (result.recoveryRecommendation
          && activationRecoveryAttempted !== true) {
          controllerRecoveryDirective = result.recoveryRecommendation.directive;
          activationRecoveryAttempted = true;
          activeOperation = Object.freeze({
            ...operation,
            actionOccurrenceId: result?.recoveryRecommendation?.recoveryOccurrenceId
              || `${operation.actionOccurrenceId}:recovery:${recoveryCycle}`,
          });
        }
        heartbeat({
          runtimeVersion: RUNTIME_VERSION,
          scopeId,
          operationId: operation.operationId,
          actionOccurrenceId: operation.actionOccurrenceId,
          state: CONTROLLER_STATE.RECONCILING,
          phase: 'autonomous_recovery',
          reason: priorRecoveryReason,
          recoveryCycle,
          forceFreshSnapshot: true,
          duplicateMutationForbidden: true,
          recoveryMutationAuthorized: Boolean(controllerRecoveryDirective),
          recoveryOccurrenceId: controllerRecoveryDirective
            ? activeOperation.actionOccurrenceId
            : null,
        });
        const recoveryDelayMs = Math.min(2_000, 125 * (2 ** Math.min(recoveryCycle - 1, 4)));
        await recoverySleep(recoveryDelayMs);
      }
      const assertionProjection = operation.kind === 'assertion'
        ? projectAssertionDecision({
            assertion: operation,
            decision,
            operationContract,
            priorOperationResults: operationResults,
          })
        : null;
      if (assertionProjection?.projected === true) {
        decision = assertionProjection.terminalDecision;
        result = Object.freeze({
          ...result,
          terminalDecision: decision,
          assertionProjection,
        });
      }
      try {
        await journal.appendControllerEvent({
          authority,
          capability: decision.state === CONTROLLER_STATE.COMMITTED
            ? CONTROLLER_CAPABILITY.COMMIT_OPERATION
            : CONTROLLER_CAPABILITY.DECIDE_CONTINUATION,
          event: {
            eventType: 'TERMINAL_DECISION',
            occurrenceKey: `${decision.actionOccurrenceId}::action`,
            operationId: operation.operationId,
            actionOccurrenceId: decision.actionOccurrenceId,
            state: decision.state,
            terminalDecision: decision,
            factRefs: decision.proofRefs,
          },
        });
      } catch (journalError) {
        // `decision` above is already the true, final outcome of this operation —
        // proof-recording is evidence, not verdict. A journal write hiccup (disk,
        // permission, integrity) must only cost Output Files one proof record
        // later; it must never fail or block the live case.
        heartbeat({
          runtimeVersion: RUNTIME_VERSION,
          scopeId,
          operationId: operation.operationId,
          actionOccurrenceId: decision.actionOccurrenceId,
          state: decision.state,
          phase: 'evidence_write_degraded',
          reason: journalError?.code || journalError?.message || 'journal_append_failed',
          evidenceDegraded: true,
          runTerminationAuthorized: false,
        });
      }
      scheduler.recordDecision(decision);
      operationResults.push(Object.freeze({
        operationId: operation.operationId,
        terminalDecision: decision,
      }));
      if (
        (operation.kind === 'action' || operation.kind === 'assertion')
        && decision.state === CONTROLLER_STATE.COMMITTED
      ) {
        try {
          // For composite protocols (Select/Radio-style dropdowns), the
          // trigger/owner ref a plain resolve would report is not what the
          // step actually committed against — decision.composite carries the
          // dynamically-resolved option ref the mutation really dispatched
          // to, when one exists (see controllerCompositeExecutor.js).
          const captured = await captureLocatorEvidence(
            operation.operationId,
            decision.composite?.committedCandidate || null,
          );
          if (captured) verifiedLocators.set(operation.operationId, captured);
        } catch (_) {
          // Never let evidence capture affect the run — same rule as the
          // journal/verdict degradation above.
        }
      }
      heartbeat({
        runtimeVersion: RUNTIME_VERSION,
        scopeId,
        operationId: operation.operationId,
        actionOccurrenceId: operation.actionOccurrenceId,
        state: decision.state,
        commitDisposition: decision.commitDisposition || null,
        continuationDisposition: decision.continuation?.disposition || null,
        attribution: decision.attribution || null,
        reason: decision.reason || null,
        terminationReason: decision.terminationReason || null,
        proofRefs: Array.isArray(decision.proofRefs) ? decision.proofRefs : [],
      });
      if (decision.state === CONTROLLER_STATE.MANUAL_BOUNDARY
        || decision.state === CONTROLLER_STATE.CANCELLED) break;
    }

    const schedulerSnapshot = scheduler.snapshot();
    if (schedulerSnapshot.paused) {
      return Object.freeze({
        runtimeVersion: RUNTIME_VERSION,
        scopeId,
        paused: true,
        schedulerSnapshot,
        operationResults: Object.freeze(operationResults),
        verifiedLocators,
        verdict: null,
      });
    }
    if (!schedulerSnapshot.complete && !schedulerSnapshot.cancelled) {
      throw new BrowserTransactionRuntimeError(
        'Controller scheduler reached a non-terminal state with no runnable operation.',
        'BROWSER_TRANSACTION_RUNTIME_SCHEDULER_DEADLOCK',
        { scopeId, schedulerSnapshot },
      );
    }
    const projection = projectControllerVerdict({ scopeId, schedulerSnapshot });
    let persistedVerdict;
    try {
      persistedVerdict = await persistControllerVerdict({
        authority,
        projection,
        repository: verdictRepository,
        journal,
      });
    } catch (persistError) {
      // Same rule as the per-operation journal write above: `projection` is
      // already the true, final case verdict computed from real scheduler/
      // decision facts. A verdict-repository write failure (disk hiccup, file
      // lock) is an evidence-persistence problem, not an execution problem —
      // it must not fail the case.
      heartbeat({
        runtimeVersion: RUNTIME_VERSION,
        scopeId,
        phase: 'verdict_persistence_degraded',
        reason: persistError?.code || persistError?.message || 'verdict_persist_failed',
        evidenceDegraded: true,
        runTerminationAuthorized: false,
      });
      persistedVerdict = Object.freeze({
        persisted: false, idempotent: false, degraded: true, verdict: projection,
      });
    }
    return Object.freeze({
      runtimeVersion: RUNTIME_VERSION,
      scopeId,
      paused: false,
      schedulerSnapshot,
      operationResults: Object.freeze(operationResults),
      verifiedLocators,
      verdict: persistedVerdict.verdict,
    });
  };

  return Object.freeze({
    runtimeVersion: RUNTIME_VERSION,
    runCase,
  });
}

module.exports = {
  RUNTIME_VERSION,
  BrowserTransactionRuntimeError,
  createBrowserTransactionRuntime,
};
