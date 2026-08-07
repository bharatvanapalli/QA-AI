'use strict';

const RESUME_VERSION = 'qaai-controller-resume-reconciler-v1';

const RESUME_STATUS = Object.freeze({
  NEW_OPERATION: 'NEW_OPERATION',
  RECONCILE_BEFORE_ANY_DISPATCH: 'RECONCILE_BEFORE_ANY_DISPATCH',
  TERMINAL_DECISION_RESTORED: 'TERMINAL_DECISION_RESTORED',
});

const DELIVERY_STATUS = Object.freeze({
  DELIVERED: 'DELIVERED',
  NOT_DELIVERED: 'NOT_DELIVERED',
  DELIVERY_UNCERTAIN: 'DELIVERY_UNCERTAIN',
});

class ControllerResumeReconcilerError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ControllerResumeReconcilerError';
    this.code = code;
    Object.assign(this, details);
  }
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function eventFactRefs(events) {
  return Object.freeze([
    ...new Set(events.flatMap((event) => (
      Array.isArray(event.factRefs) ? event.factRefs : event.factRef ? [event.factRef] : []
    )).map(clean).filter(Boolean)),
  ]);
}

function createControllerResumeReconciler({ journal } = {}) {
  if (!journal || typeof journal.eventsForOccurrence !== 'function') {
    throw new TypeError('ControllerResumeReconciler requires an append-only event journal.');
  }

  const reconcile = async ({ operation, plan } = {}) => {
    const actionOccurrenceId = clean(operation?.actionOccurrenceId);
    const operationId = clean(operation?.operationId);
    const phaseId = clean(plan?.mutation?.phaseId || plan?.phaseId) || 'action';
    if (!actionOccurrenceId || !operationId) {
      throw new ControllerResumeReconcilerError(
        'Resume reconciliation requires operation and occurrence identity.',
        'CONTROLLER_RESUME_IDENTITY_REQUIRED',
      );
    }
    const occurrenceKey = `${actionOccurrenceId}::${phaseId}`;
    const events = await journal.eventsForOccurrence(occurrenceKey);
    const related = events.filter((event) => (
      !event.operationId || event.operationId === operationId
    ));
    if (!related.length) {
      return Object.freeze({
        schemaVersion: RESUME_VERSION,
        status: RESUME_STATUS.NEW_OPERATION,
        occurrenceKey,
        mayDispatch: true,
        mustReconcile: false,
        terminalDecision: null,
        delivery: null,
        factRefs: Object.freeze([]),
        reason: 'no_persisted_occurrence',
      });
    }

    const terminalEvent = [...related].reverse().find((event) => (
      event.eventType === 'TERMINAL_DECISION'
      && (event.terminalDecision || event.state)
    ));
    if (terminalEvent) {
      const terminalDecision = terminalEvent.terminalDecision || {
        operationId,
        actionOccurrenceId,
        state: terminalEvent.state,
        commitDisposition: terminalEvent.commitDisposition || null,
        attribution: terminalEvent.attribution || null,
        reason: terminalEvent.reason || null,
        proofRefs: terminalEvent.proofRefs || terminalEvent.factRefs || [],
        terminationReason: terminalEvent.terminationReason || null,
      };
      return Object.freeze({
        schemaVersion: RESUME_VERSION,
        status: RESUME_STATUS.TERMINAL_DECISION_RESTORED,
        occurrenceKey,
        mayDispatch: false,
        mustReconcile: false,
        terminalDecision: Object.freeze({ ...terminalDecision }),
        delivery: null,
        factRefs: eventFactRefs(related),
        reason: 'terminal_controller_decision_restored',
      });
    }

    const deliveryEvent = [...related].reverse().find((event) => (
      event.eventType === 'DELIVERY_RECORDED'
    ));
    const dispatchEvent = [...related].reverse().find((event) => (
      event.eventType === 'DISPATCH_STARTED'
      || event.eventType === 'DISPATCH_INTENT_PERSISTED'
    ));
    if (!deliveryEvent && !dispatchEvent) {
      throw new ControllerResumeReconcilerError(
        'Persisted occurrence has no recognized dispatch or terminal facts.',
        'CONTROLLER_RESUME_JOURNAL_STATE_INVALID',
        { occurrenceKey, eventTypes: related.map((event) => event.eventType) },
      );
    }
    const deliveryStatus = deliveryEvent?.deliveryStatus === DELIVERY_STATUS.DELIVERED
      ? DELIVERY_STATUS.DELIVERED
      : deliveryEvent?.deliveryStatus === DELIVERY_STATUS.NOT_DELIVERED
        ? DELIVERY_STATUS.NOT_DELIVERED
        : DELIVERY_STATUS.DELIVERY_UNCERTAIN;
    return Object.freeze({
      schemaVersion: RESUME_VERSION,
      status: RESUME_STATUS.RECONCILE_BEFORE_ANY_DISPATCH,
      occurrenceKey,
      mayDispatch: false,
      mustReconcile: true,
      terminalDecision: null,
      delivery: Object.freeze({
        dispatchAttemptId: clean(
          deliveryEvent?.dispatchAttemptId || dispatchEvent?.dispatchAttemptId,
        ) || `resume:${occurrenceKey}`,
        deliveryStatus,
        reason: deliveryEvent?.reason || (
          deliveryStatus === DELIVERY_STATUS.NOT_DELIVERED
            ? 'persisted_positive_non_delivery'
            : 'persisted_dispatch_requires_reconciliation'
        ),
        factRefs: eventFactRefs(related),
      }),
      factRefs: eventFactRefs(related),
      reason: 'persisted_dispatch_reconciles_before_any_possible_redispatch',
    });
  };

  return Object.freeze({ reconcile });
}

module.exports = {
  RESUME_VERSION,
  RESUME_STATUS,
  DELIVERY_STATUS,
  ControllerResumeReconcilerError,
  createControllerResumeReconciler,
};
