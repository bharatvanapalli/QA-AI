'use strict';

const crypto = require('node:crypto');
const {
  CONTROLLER_CAPABILITY,
  assertControllerAuthority,
} = require('./browserTransactionAuthority');
const {
  assertControllerMutationTool,
} = require('./controllerBrowserMutationTaxonomy');

const GATEWAY_VERSION = 'qaai-controller-action-execution-gateway-v1';
const TRANSPORT_PERMIT_VERSION = 'qaai-browser-transport-permit-v1';

const DELIVERY_STATUS = Object.freeze({
  DELIVERED: 'DELIVERED',
  NOT_DELIVERED: 'NOT_DELIVERED',
  DELIVERY_UNCERTAIN: 'DELIVERY_UNCERTAIN',
});

class ControllerActionExecutionGatewayError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ControllerActionExecutionGatewayError';
    this.code = code;
    Object.assign(this, details);
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value)), 'utf8').digest('hex');
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function createInMemoryDispatchJournal() {
  const events = [];
  return Object.freeze({
    appendDispatchEvent: async (event) => {
      events.push(Object.freeze({ ...event }));
      return { persisted: true };
    },
    eventsForOccurrence: async (occurrenceKey) => (
      events.filter((event) => event.occurrenceKey === occurrenceKey)
    ),
    allEvents: () => events.slice(),
  });
}

function createControllerActionExecutionGateway({
  transport,
  journal = createInMemoryDispatchJournal(),
  now = Date.now,
} = {}) {
  if (typeof transport !== 'function') {
    throw new TypeError('ControllerActionExecutionGateway requires a transport function.');
  }
  if (!journal
    || typeof journal.appendDispatchEvent !== 'function'
    || typeof journal.eventsForOccurrence !== 'function') {
    throw new TypeError('ControllerActionExecutionGateway requires an append-only dispatch journal.');
  }

  const transportPermits = new Map();
  const consumedTransportPermits = new WeakSet();

  const append = async (event) => {
    const record = Object.freeze({
      schemaVersion: GATEWAY_VERSION,
      occurredAt: new Date(Number(now())).toISOString(),
      ...event,
    });
    const persisted = await journal.appendDispatchEvent(record);
    if (persisted?.persisted === false) {
      throw new ControllerActionExecutionGatewayError(
        'Dispatch fact was not durably persisted; transport invocation is forbidden.',
        'CONTROLLER_GATEWAY_DURABILITY_REQUIRED',
        { occurrenceKey: event.occurrenceKey, eventType: event.eventType },
      );
    }
    return record;
  };

  const issueTransportPermit = ({ occurrenceKey, operationId, toolName, argsDigest }) => {
    const permitId = crypto.randomUUID();
    const permit = Object.freeze({
      schemaVersion: TRANSPORT_PERMIT_VERSION,
      permitId,
    });
    transportPermits.set(permitId, {
      occurrenceKey,
      operationId,
      toolName,
      argsDigest,
      consumed: false,
    });
    return permit;
  };

  const consumeTransportPermit = ({ permit, operationId, toolName, args }) => {
    const permitId = permit?.schemaVersion === TRANSPORT_PERMIT_VERSION
      ? permit.permitId
      : null;
    const state = permitId ? transportPermits.get(permitId) : null;
    if (!state || state.consumed || consumedTransportPermits.has(permit)) {
      throw new ControllerActionExecutionGatewayError(
        'Raw browser transport requires a valid single-use gateway permit.',
        'CONTROLLER_GATEWAY_TRANSPORT_PERMIT_REQUIRED',
        { operationId: clean(operationId) || null, toolName: clean(toolName) || null },
      );
    }
    if (state.operationId !== clean(operationId)
      || state.toolName !== clean(toolName)
      || state.argsDigest !== digest(args || {})) {
      throw new ControllerActionExecutionGatewayError(
        'Browser transport permit does not match this exact mutation.',
        'CONTROLLER_GATEWAY_TRANSPORT_PERMIT_MISMATCH',
        { operationId: clean(operationId) || null, toolName: clean(toolName) || null },
      );
    }
    state.consumed = true;
    consumedTransportPermits.add(permit);
    return Object.freeze({
      authorized: true,
      occurrenceKey: state.occurrenceKey,
      operationId: state.operationId,
      toolName: state.toolName,
      argsDigest: state.argsDigest,
    });
  };

  const dispatch = async ({
    authority,
    operation,
    plan,
    context = {},
    remainingMs = null,
  } = {}) => {
    assertControllerAuthority(authority, CONTROLLER_CAPABILITY.AUTHORIZE_MUTATION);
    const operationId = clean(operation?.operationId);
    const actionOccurrenceId = clean(operation?.actionOccurrenceId);
    const mutation = plan?.mutation && typeof plan.mutation === 'object' ? plan.mutation : {};
    const toolName = clean(mutation.toolName || mutation.name);
    const args = mutation.args && typeof mutation.args === 'object' ? mutation.args : {};
    const phaseId = clean(mutation.phaseId || plan?.phaseId) || 'action';
    if (!operationId || !actionOccurrenceId || !toolName) {
      throw new ControllerActionExecutionGatewayError(
        'Controller dispatch requires operation, occurrence, and mutation tool identity.',
        'CONTROLLER_GATEWAY_DISPATCH_IDENTITY_REQUIRED',
        {
          operationId: operationId || null,
          actionOccurrenceId: actionOccurrenceId || null,
          toolName: toolName || null,
        },
      );
    }
    assertControllerMutationTool(toolName, args);

    const occurrenceKey = `${actionOccurrenceId}::${phaseId}`;
    const argsDigest = digest(args);
    const existing = await journal.eventsForOccurrence(occurrenceKey);
    const isTerminallyCommitted = existing.some((event) => (
      event.eventType === 'DISPATCH_COMMITTED'
      || event.eventType === 'DISPATCH_FAILED'
    ));
    if (isTerminallyCommitted) {
      throw new ControllerActionExecutionGatewayError(
        'The same action occurrence cannot be dispatched twice.',
        'CONTROLLER_GATEWAY_DUPLICATE_OCCURRENCE',
        {
          occurrenceKey,
          operationId,
          actionOccurrenceId,
          priorEventTypes: existing.map((event) => event.eventType),
        },
      );
    }

    await append({
      eventType: 'DISPATCH_INTENT_PERSISTED',
      occurrenceKey,
      operationId,
      actionOccurrenceId,
      phaseId,
      toolName,
      argsDigest,
    });
    const dispatchAttemptId = `dispatch:${actionOccurrenceId}:${phaseId}:1`;
    await append({
      eventType: 'DISPATCH_STARTED',
      occurrenceKey,
      operationId,
      actionOccurrenceId,
      phaseId,
      toolName,
      argsDigest,
      dispatchAttemptId,
    });

    const permit = issueTransportPermit({
      occurrenceKey,
      operationId,
      toolName,
      argsDigest,
    });
    const authorization = consumeTransportPermit({
      permit,
      operationId,
      toolName,
      args,
    });

    let result = null;
    let deliveryStatus = DELIVERY_STATUS.DELIVERY_UNCERTAIN;
    let reason = 'transport_delivery_uncertain';
    let browserAcknowledged = false;
    let acknowledgmentKind = null;
    let inputEventObserved = false;
    let protectedInputNonEmpty = false;
    let recoverable = false;
    let semanticAcknowledgment = null;
    let transportFactRefs = [];
    try {
      result = await transport({
        session: context.session || null,
        toolName,
        args,
        authorization,
        remainingMs,
      });
      if (result?.delivered === false
        && (result?.positivelyNotDelivered === true || result?.proven === true)) {
        deliveryStatus = DELIVERY_STATUS.NOT_DELIVERED;
        reason = clean(result.reason) || 'transport_positive_non_delivery';
        recoverable = result?.recoverable === true;
      } else if (result?.isError === true) {
        deliveryStatus = DELIVERY_STATUS.DELIVERY_UNCERTAIN;
        reason = clean(result.code || result.errorCode || result.reason) || 'transport_error_delivery_uncertain';
      } else {
        deliveryStatus = DELIVERY_STATUS.DELIVERED;
        reason = clean(result?.reason) || 'transport_returned';
        browserAcknowledged = result?.browserAcknowledged === true;
        acknowledgmentKind = browserAcknowledged
          ? clean(result?.acknowledgmentKind) || null
          : null;
        inputEventObserved = result?.inputEventObserved === true;
        protectedInputNonEmpty = browserAcknowledged
          && result?.protectedInputNonEmpty === true;
        semanticAcknowledgment = result?.semanticAcknowledgment
          && typeof result.semanticAcknowledgment === 'object'
          ? Object.freeze({
            ok: result.semanticAcknowledgment.ok === true,
            reason: clean(result.semanticAcknowledgment.reason) || null,
            actionPerformed: result.semanticAcknowledgment.actionPerformed === true,
            expectedSelectionMatched: result.semanticAcknowledgment.expectedSelectionMatched === true,
            ownerMatched: result.semanticAcknowledgment.ownerMatched === true,
            selectedLabel: clean(result.semanticAcknowledgment.selectedLabel).slice(0, 160) || null,
          })
          : null;
        transportFactRefs = (Array.isArray(result?.factRefs) ? result.factRefs : [])
          .map(clean)
          .filter(Boolean);
      }
    } catch (error) {
      const positivelyNotDelivered = error?.positivelyNotDelivered === true
        || error?.delivered === false && error?.proven === true;
      deliveryStatus = positivelyNotDelivered
        ? DELIVERY_STATUS.NOT_DELIVERED
        : DELIVERY_STATUS.DELIVERY_UNCERTAIN;
      reason = clean(error?.code || error?.name) || (
        positivelyNotDelivered
          ? 'transport_positive_non_delivery'
          : 'transport_exception_delivery_uncertain'
      );
    }

    const deliveryFactRef = `${occurrenceKey}:delivery:1`;
    await append({
      eventType: 'DELIVERY_RECORDED',
      occurrenceKey,
      operationId,
      actionOccurrenceId,
      phaseId,
      toolName,
      argsDigest,
      dispatchAttemptId,
      deliveryStatus,
      reason,
      browserAcknowledged,
      acknowledgmentKind,
      inputEventObserved,
      protectedInputNonEmpty,
      recoverable,
      semanticAcknowledgment,
      factRef: deliveryFactRef,
    });
    return Object.freeze({
      schemaVersion: GATEWAY_VERSION,
      dispatchAttemptId,
      deliveryStatus,
      reason,
      browserAcknowledged,
      acknowledgmentKind,
      inputEventObserved,
      protectedInputNonEmpty,
      recoverable,
      semanticAcknowledgment,
      factRefs: Object.freeze([...new Set([deliveryFactRef, ...transportFactRefs])]),
    });
  };

  return Object.freeze({
    gatewayVersion: GATEWAY_VERSION,
    dispatch,
    consumeTransportPermit,
  });
}

module.exports = {
  GATEWAY_VERSION,
  TRANSPORT_PERMIT_VERSION,
  DELIVERY_STATUS,
  ControllerActionExecutionGatewayError,
  digest,
  createInMemoryDispatchJournal,
  createControllerActionExecutionGateway,
};
