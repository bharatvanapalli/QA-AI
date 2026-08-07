'use strict';

const crypto = require('node:crypto');
const browserMutationTaxonomy = require('./browserMutationTaxonomy');

const PERMIT_VERSION = 'ActionExecutionPermitV2';
const DEFAULT_TTL_MS = 30_000;
const LANDING_ORACLE_SCHEMA = 'qaai-authored-landing-oracle-v1';
const SDK_CALL_AUTHORIZATION = Symbol('qaai.actionExecutionGateway.sdkCallAuthorization');
const INTERNAL_GATEWAY_OPTION_KEYS = new Set([
  'authoredNextState', 'authoredNextStates', 'waitForLandingOracle',
  'observeLandingOracle', 'landingOracleTimeoutMs', 'landingOraclePollIntervalMs',
  'landingOracleStableObservations',
  'requireActionableTarget', 'observeTargetActionability',
  'targetActionabilityTimeoutMs', 'targetActionabilityPollIntervalMs',
  'requireVerifiedTarget', 'targetAuthorization',
  'enforceExactlyOnce', 'mutationPhaseId', 'transactionId', 'operationId',
  'origin', 'authoredStepIndex', 'positiveNonDeliveryProof',
]);
const EDITABLE_TARGET_TOOLS = new Set(['browser_type', 'browser_fill', 'browser_fill_form']);
const MUTATING_BROWSER_TOOLS = browserMutationTaxonomy.POTENTIALLY_MUTATING_BROWSER_TOOLS;
const SEMANTIC_TARGET_MUTATION_TOOLS = browserMutationTaxonomy.SEMANTIC_TARGET_MUTATION_TOOLS;
const EVALUATE_MUTATION_RE = browserMutationTaxonomy.EVALUATE_MUTATION_RE;

class ActionExecutionGatewayError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ActionExecutionGatewayError';
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

const isMutatingBrowserEvaluate = browserMutationTaxonomy.isMutatingBrowserEvaluate;
const isMutatingTool = browserMutationTaxonomy.isMutatingTool;

function requiresVerifiedSemanticTarget(name, args = {}) {
  const toolName = String(name || '');
  if (!isMutatingTool(toolName, args)) return false;
  if (SEMANTIC_TARGET_MUTATION_TOOLS.has(toolName)) return true;
  if (isMutatingBrowserEvaluate(toolName, args)) return true;
  if (!['browser_press_key', 'browser_scroll'].includes(toolName)) return false;
  return targetActionabilityRequirements(toolName, args).required === true;
}

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function stepIdentity(step = {}) {
  return clean(step.id || step.stepId || step.contractStepId || step.caseContractStepId) || null;
}

function authoredUrlOf(step = {}) {
  const expected = step.expected && typeof step.expected === 'object' ? step.expected : {};
  const operationCheck = step.operationCheck && typeof step.operationCheck === 'object' ? step.operationCheck : {};
  const wait = step.waitContract && typeof step.waitContract === 'object' ? step.waitContract : {};
  return clean(
    step.url || step.targetUrl || step.href || step.urlPattern || step.expectedUrl
      || operationCheck.url || operationCheck.urlPattern || operationCheck.expectedUrl
      || wait.url || wait.urlPattern || wait.expectedUrl
      || expected.url || expected.urlPattern || expected.expectedUrl,
  ) || null;
}

function authoredTargetOf(step = {}) {
  const identity = step.targetIdentity && typeof step.targetIdentity === 'object' ? step.targetIdentity : {};
  const wait = step.waitContract && typeof step.waitContract === 'object' ? step.waitContract : {};
  const condition = step.condition && typeof step.condition === 'object' ? step.condition : {};
  return clean(
    identity.accessibleName || identity.name || identity.label
      || condition.target || wait.target
      || step.target || step.element || step.field || step.label || step.name,
  ) || null;
}

function targetRoleOf(step = {}) {
  const identity = step.targetIdentity && typeof step.targetIdentity === 'object' ? step.targetIdentity : {};
  return clean(identity.role || step.targetRole || step.role || step.controlRole) || null;
}

function genericPageTarget(target) {
  return /^(?:(?:the|a)\s+)?(?:destination|next|current|resulting|loaded)?\s*(?:page|screen|state|ui|application)$/i
    .test(clean(target));
}

function deriveLandingOracle({ authoredNextState = null, authoredNextStates = [] } = {}) {
  const candidates = [
    ...(Array.isArray(authoredNextStates) ? authoredNextStates : []),
    ...(authoredNextState ? [authoredNextState] : []),
  ].filter((step, index, list) => step && typeof step === 'object' && list.indexOf(step) === index);
  for (const step of candidates) {
    const urlPattern = authoredUrlOf(step);
    if (urlPattern) {
      return Object.freeze({
        schema: LANDING_ORACLE_SCHEMA,
        kind: 'url',
        urlPattern,
        sourceStepId: stepIdentity(step),
        source: 'authored_next_state',
      });
    }
    const target = authoredTargetOf(step);
    if (!target || genericPageTarget(target)) continue;
    return Object.freeze({
      schema: LANDING_ORACLE_SCHEMA,
      kind: 'control_actionable',
      target,
      role: targetRoleOf(step),
      sourceStepId: stepIdentity(step),
      source: 'authored_next_state',
    });
  }
  return null;
}

function normalizedUrlPattern(pattern) {
  return clean(pattern).replace(/^\*+|\*+$/g, '');
}

function evaluateLandingOracleObservation({ oracle, observation } = {}) {
  if (!oracle || !observation || observation.fresh === false) {
    return { matched: false, reason: 'fresh_targeted_observation_unavailable' };
  }
  if (oracle.kind === 'url') {
    const actual = clean(observation.url);
    const pattern = normalizedUrlPattern(oracle.urlPattern);
    let matched = false;
    try {
      if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
        const end = pattern.lastIndexOf('/');
        matched = new RegExp(pattern.slice(1, end), pattern.slice(end + 1)).test(actual);
      } else {
        matched = !!actual && !!pattern && actual.toLowerCase().includes(pattern.toLowerCase());
      }
    } catch (_) {}
    return { matched, reason: matched ? 'authored_url_reached' : 'authored_url_not_reached' };
  }
  const matched = observation.matched === true || observation.actionable === true;
  return {
    matched,
    reason: matched
      ? 'authored_next_control_actionable'
      : clean(observation.reason) || 'authored_next_control_not_actionable',
  };
}

function transportOptions(options = {}) {
  return Object.fromEntries(
    Object.entries(options || {}).filter(([key]) => !INTERNAL_GATEWAY_OPTION_KEYS.has(key)),
  );
}

function targetActionabilityRequirements(toolName, args = {}) {
  const name = clean(toolName);
  const refs = [];
  const append = (value) => {
    const ref = clean(value);
    if (ref && !refs.includes(ref)) refs.push(ref);
  };
  append(args.target);
  append(args.ref);
  append(args.startRef);
  append(args.endRef);
  append(args.sourceRef);
  append(args.destinationRef);
  for (const field of Array.isArray(args.fields) ? args.fields : []) {
    append(field?.target);
    append(field?.ref);
  }
  return Object.freeze({
    required: isMutatingTool(name, args) && refs.length > 0,
    toolName: name,
    refs: Object.freeze(refs),
    editable: EDITABLE_TARGET_TOOLS.has(name),
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function evaluateTargetActionabilitySnapshot({ requirements, snapshotText } = {}) {
  if (!requirements?.required) return { matched: true, fresh: true, reason: 'target_actionability_not_required' };
  const text = String(snapshotText || '');
  if (!text.trim()) return { matched: false, fresh: false, reason: 'fresh_target_snapshot_unavailable' };
  for (const ref of requirements.refs || []) {
    const line = text.split(/\r?\n/).find((entry) => new RegExp(`\\[ref=(?:"|')?${escapeRegExp(ref)}(?:"|')?\\]`, 'i').test(entry));
    if (!line) return { matched: false, fresh: true, reason: 'exact_target_ref_not_visible' };
    if (/\[(?:disabled|hidden)(?:=[^\]]+)?\]|aria-disabled\s*=\s*["']?true/i.test(line)) {
      return { matched: false, fresh: true, reason: 'exact_target_not_actionable' };
    }
    if (requirements.editable
      && (/\[readonly(?:=[^\]]+)?\]|aria-readonly\s*=\s*["']?true/i.test(line)
        || !/\b(?:textbox|searchbox|combobox|spinbutton)\b/i.test(line))) {
      return { matched: false, fresh: true, reason: 'exact_target_not_editable' };
    }
  }
  return { matched: true, fresh: true, reason: requirements.editable ? 'exact_target_editable' : 'exact_target_actionable' };
}

function createActionExecutionGateway({
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const permits = new Map();
  const sessionIds = new WeakMap();
  const protectedClients = new WeakMap();
  const sdkAuthorizationTokens = new WeakSet();
  let sessionSequence = 0;

  const sessionId = (session) => {
    if (!session || typeof session !== 'object') return null;
    if (!sessionIds.has(session)) sessionIds.set(session, `gateway-session-${++sessionSequence}`);
    return sessionIds.get(session);
  };

  const occurrenceKey = (actionOccurrenceId, mutationPhaseId = 'action') => (
    `${String(actionOccurrenceId || '').trim()}::${String(mutationPhaseId || 'action').trim() || 'action'}`
  );

  const persistOccurrenceState = async (session, state) => {
    state.updatedAt = Number(now());
    if (!session.actionExecutionOccurrenceState || typeof session.actionExecutionOccurrenceState !== 'object') {
      session.actionExecutionOccurrenceState = Object.create(null);
    }
    session.actionExecutionOccurrenceState[state.occurrenceKey] = { ...state };
    if (typeof session.persistActionExecutionOccurrence === 'function') {
      const persisted = await session.persistActionExecutionOccurrence({ ...state });
      if (persisted?.persisted === false) {
        throw new ActionExecutionGatewayError(
          'Action occurrence durability was refused; browser dispatch is not permitted.',
          'ACTION_EXECUTION_PERSISTENCE_REQUIRED',
          { occurrenceKey: state.occurrenceKey, reason: persisted.reason || null },
        );
      }
    }
  };

  const loadOccurrenceState = async (session, key) => {
    const cached = session?.actionExecutionOccurrenceState?.[key] || null;
    if (cached) return cached;
    if (typeof session?.loadActionExecutionOccurrence !== 'function') return null;
    const loaded = await session.loadActionExecutionOccurrence({ occurrenceKey: key });
    if (!loaded) return null;
    if (loaded.schemaVersion !== 'qaai-action-execution-occurrence-v1' || loaded.occurrenceKey !== key) {
      throw new ActionExecutionGatewayError(
        'Persisted action occurrence identity is incompatible with this dispatch.',
        'ACTION_EXECUTION_PERSISTED_OCCURRENCE_INVALID',
        { occurrenceKey: key },
      );
    }
    if (!session.actionExecutionOccurrenceState || typeof session.actionExecutionOccurrenceState !== 'object') {
      session.actionExecutionOccurrenceState = Object.create(null);
    }
    session.actionExecutionOccurrenceState[key] = { ...loaded };
    return session.actionExecutionOccurrenceState[key];
  };

  const awaitLandingOracle = async ({
    oracle,
    observe,
    timeoutMs = 5_000,
    pollIntervalMs = 250,
    stableObservations = 1,
  } = {}) => {
    if (!oracle || typeof observe !== 'function') return null;
    const startedAt = Number(now());
    const deadline = startedAt + Math.max(0, Math.min(15_000, Number(timeoutMs) || 5_000));
    const required = Math.max(1, Math.min(3, Number(stableObservations) || 1));
    let attempts = 0;
    let consecutive = 0;
    let reason = 'authored_landing_oracle_unobserved';
    do {
      attempts += 1;
      let observation = null;
      try {
        observation = await observe({
          oracle,
          attempt: attempts,
          remainingMs: Math.max(0, deadline - Number(now())),
        });
      } catch (error) {
        reason = clean(error?.code || error?.name || 'landing_oracle_observer_error');
      }
      const evaluated = evaluateLandingOracleObservation({ oracle, observation });
      reason = evaluated.reason;
      consecutive = evaluated.matched ? consecutive + 1 : 0;
      if (consecutive >= required) {
        return {
          schema: LANDING_ORACLE_SCHEMA,
          matched: true,
          kind: oracle.kind,
          targetDigest: digest(
            oracle.kind === 'url' ? oracle.urlPattern : { target: oracle.target, role: oracle.role },
          ),
          sourceStepId: oracle.sourceStepId,
          attempts,
          reason,
          observedAt: Number(now()),
        };
      }
      const remainingMs = deadline - Number(now());
      if (remainingMs <= 0) break;
      await sleep(Math.min(Math.max(1, Number(pollIntervalMs) || 250), remainingMs));
    } while (Number(now()) <= deadline);
    return {
      schema: LANDING_ORACLE_SCHEMA,
      matched: false,
      kind: oracle.kind,
      targetDigest: digest(
        oracle.kind === 'url' ? oracle.urlPattern : { target: oracle.target, role: oracle.role },
      ),
      sourceStepId: oracle.sourceStepId,
      attempts,
      reason: `timeout:${reason}`,
      observedAt: Number(now()),
    };
  };

  const awaitTargetActionability = async ({
    requirements,
    observe,
    timeoutMs = 5_000,
    pollIntervalMs = 250,
  } = {}) => {
    if (!requirements?.required) return null;
    if (typeof observe !== 'function') {
      return {
        schema: 'qaai-target-actionability-v1',
        matched: false,
        editable: requirements.editable,
        targetDigest: digest({ toolName: requirements.toolName, refs: requirements.refs }),
        attempts: 0,
        reason: 'target_actionability_observer_required',
        observedAt: Number(now()),
      };
    }
    const deadline = Number(now()) + Math.max(0, Math.min(15_000, Number(timeoutMs) || 5_000));
    let attempts = 0;
    let reason = 'target_actionability_unobserved';
    do {
      attempts += 1;
      let observation = null;
      try {
        observation = await observe({
          requirements,
          attempt: attempts,
          remainingMs: Math.max(0, deadline - Number(now())),
        });
      } catch (error) {
        reason = clean(error?.code || error?.name || 'target_actionability_observer_error');
      }
      const evaluated = observation && typeof observation.matched === 'boolean'
        ? observation
        : evaluateTargetActionabilitySnapshot({
            requirements,
            snapshotText: observation?.snapshotText,
          });
      reason = clean(evaluated?.reason) || 'target_actionability_unconfirmed';
      if (evaluated?.matched === true) {
        return {
          schema: 'qaai-target-actionability-v1',
          matched: true,
          editable: requirements.editable,
          targetDigest: digest({ toolName: requirements.toolName, refs: requirements.refs }),
          attempts,
          reason,
          observedAt: Number(now()),
        };
      }
      const remainingMs = deadline - Number(now());
      if (remainingMs <= 0) break;
      await sleep(Math.min(Math.max(1, Number(pollIntervalMs) || 250), remainingMs));
    } while (Number(now()) <= deadline);
    return {
      schema: 'qaai-target-actionability-v1',
      matched: false,
      editable: requirements.editable,
      targetDigest: digest({ toolName: requirements.toolName, refs: requirements.refs }),
      attempts,
      reason: `timeout:${reason}`,
      observedAt: Number(now()),
    };
  };

  const beginExactlyOnceDispatch = async ({ session, toolName, args = {}, options = {}, actionOccurrenceId, source }) => {
    const phaseId = String(options.mutationPhaseId || 'action').trim() || 'action';
    const key = occurrenceKey(actionOccurrenceId, phaseId);
    const existing = await loadOccurrenceState(session, key);
    const argsDigest = digest(args || {});
    const positiveNonDelivery = options.positiveNonDeliveryProof === true
      || options.positiveNonDeliveryProof?.proven === true
      || options.positiveNonDeliveryProof?.positivelyNotDelivered === true;
    if (existing) {
      if (existing.toolName !== String(toolName) || existing.argsDigest !== argsDigest) {
        throw new ActionExecutionGatewayError(
          'An action occurrence cannot be reused for a different browser mutation.',
          'ACTION_EXECUTION_OCCURRENCE_MISMATCH',
          { actionOccurrenceId, mutationPhaseId: phaseId, toolName },
        );
      }
      if (existing.status !== 'not_delivered' || !positiveNonDelivery) {
        throw new ActionExecutionGatewayError(
          'Duplicate browser dispatch blocked; reconcile browser state and retry observation instead.',
          'ACTION_EXECUTION_DUPLICATE_DISPATCH_BLOCKED',
          { actionOccurrenceId, mutationPhaseId: phaseId, toolName, priorStatus: existing.status },
        );
      }
    }
    const state = existing || {
      schemaVersion: 'qaai-action-execution-occurrence-v1',
      occurrenceKey: key,
      actionOccurrenceId: String(actionOccurrenceId),
      transactionId: String(options.transactionId || `transaction:${actionOccurrenceId}`),
      operationId: String(options.operationId || `${actionOccurrenceId}:${phaseId}`),
      mutationPhaseId: phaseId,
      authoredStepIndex: Number.isFinite(Number(options.authoredStepIndex)) ? Number(options.authoredStepIndex) : null,
      toolName: String(toolName),
      argsDigest,
      source: String(source || options.source || 'action_execution_gateway'),
      status: 'intent_persisted',
      intentPersistedAt: Number(now()),
      dispatchAttemptCount: 0,
      browserEventObservedAt: null,
      postconditionObservedAt: null,
      committedAt: null,
    };
    if (existing) {
      state.status = 'intent_persisted';
      state.positiveNonDeliveryProvenAt = Number(now());
    }
    await persistOccurrenceState(session, state);
    state.status = 'dispatch_started';
    state.dispatchAttemptCount += 1;
    state.dispatchStartedAt = Number(now());
    await persistOccurrenceState(session, state);
    return state;
  };

  const finishExactlyOnceDispatch = async (session, state, result, error = null) => {
    if (!state) return;
    if (error) {
      state.status = 'delivery_uncertain';
      state.dispatchErrorCode = String(error?.code || error?.name || 'BROWSER_DISPATCH_ERROR');
    } else if (result?.delivered === false
      && (result?.positivelyNotDelivered === true || result?.proven === true)) {
      state.status = 'not_delivered';
      state.positiveNonDeliveryProvenAt = Number(now());
    } else if (result?.isError === true) {
      state.status = 'delivery_uncertain';
      state.dispatchErrorCode = String(result?.code || result?.errorCode || 'MCP_ACTION_ERROR');
    } else {
      state.status = 'dispatched';
      state.dispatchedAt = Number(now());
    }
    if (result?.browserEventEvidence || result?.qaaiBrowserEvents || result?.qaaiActionEvidence?.browserEvent) {
      state.browserEventObservedAt = Number(now());
    }
    await persistOccurrenceState(session, state);
  };

  const recordOccurrencePostcondition = async ({ session, actionOccurrenceId, mutationPhaseId = 'action', proof = {} } = {}) => {
    const key = occurrenceKey(actionOccurrenceId, mutationPhaseId);
    const state = await loadOccurrenceState(session, key);
    if (!state) throw new ActionExecutionGatewayError('Action occurrence is unavailable for postcondition recording.', 'ACTION_EXECUTION_OCCURRENCE_NOT_FOUND', { actionOccurrenceId, mutationPhaseId });
    state.postconditionObservedAt = Number(now());
    state.postconditionMatched = proof?.matched === true ? true : proof?.matched === false ? false : null;
    state.postconditionReason = String(proof?.reason || 'postcondition_observed').slice(0, 240);
    state.status = proof?.matched === true ? 'postcondition_observed' : state.status;
    await persistOccurrenceState(session, state);
    return { ...state };
  };

  const commitOccurrence = async ({ session, actionOccurrenceId, mutationPhaseId = 'action' } = {}) => {
    const key = occurrenceKey(actionOccurrenceId, mutationPhaseId);
    const state = await loadOccurrenceState(session, key);
    if (!state) throw new ActionExecutionGatewayError('Action occurrence is unavailable for commit.', 'ACTION_EXECUTION_OCCURRENCE_NOT_FOUND', { actionOccurrenceId, mutationPhaseId });
    if (state.postconditionMatched !== true) throw new ActionExecutionGatewayError('Action occurrence cannot commit without a matched postcondition.', 'ACTION_EXECUTION_POSTCONDITION_REQUIRED', { actionOccurrenceId, mutationPhaseId });
    state.status = 'committed';
    state.committedAt = Number(now());
    await persistOccurrenceState(session, state);
    return { ...state };
  };

  const reconcileOccurrenceOnResume = async ({
    session,
    actionOccurrenceId,
    mutationPhaseId = 'action',
    toolName = null,
    args = null,
    observe,
    provePostcondition = null,
    maxObservationAttempts = 3,
  } = {}) => {
    if (typeof observe !== 'function') throw new TypeError('resume reconciliation requires an observe callback');
    const key = occurrenceKey(actionOccurrenceId, mutationPhaseId);
    const state = await loadOccurrenceState(session, key);
    if (!state) return { found: false, reconciled: false, shouldRedispatch: false, reason: 'occurrence_not_found' };
    if ((toolName && state.toolName !== String(toolName))
      || (args && state.argsDigest !== digest(args || {}))) {
      throw new ActionExecutionGatewayError(
        'Persisted action occurrence does not match the resumed mutation.',
        'ACTION_EXECUTION_OCCURRENCE_MISMATCH',
        { actionOccurrenceId, mutationPhaseId, toolName },
      );
    }
    if (state.status === 'committed') {
      return { found: true, reconciled: false, committed: true, shouldRedispatch: false, state: { ...state } };
    }
    const attempts = Math.max(1, Math.min(10, Number(maxObservationAttempts) || 3));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let observation = null;
      let proof = null;
      try {
        observation = await observe({
          actionOccurrenceId: String(actionOccurrenceId),
          mutationPhaseId: String(mutationPhaseId),
          attempt,
          state: { ...state },
        });
        proof = typeof provePostcondition === 'function'
          ? await provePostcondition({ observation, state: { ...state }, attempt })
          : observation;
      } catch (error) {
        proof = { matched: null, checked: false, reason: error?.code || error?.name || 'resume_observation_error' };
      }
      state.reconciliationAttemptCount = Number(state.reconciliationAttemptCount || 0) + 1;
      state.lastReconciliationAt = Number(now());
      const positiveNonDelivery = proof?.positiveNonDeliveryProof === true
        || proof?.positivelyNotDelivered === true
        || proof?.delivered === false && proof?.proven === true;
      if (positiveNonDelivery) {
        state.status = 'not_delivered';
        state.positiveNonDeliveryProvenAt = Number(now());
        await persistOccurrenceState(session, state);
        return { found: true, reconciled: true, shouldRedispatch: true, reason: 'positive_non_delivery_proven', state: { ...state } };
      }
      if (proof?.matched === true) {
        state.postconditionObservedAt = Number(now());
        state.postconditionMatched = true;
        state.postconditionReason = String(proof?.reason || 'resume_postcondition_observed').slice(0, 240);
        state.status = 'committed';
        state.committedAt = Number(now());
        await persistOccurrenceState(session, state);
        return { found: true, reconciled: true, committed: true, shouldRedispatch: false, reason: state.postconditionReason, state: { ...state } };
      }
      if (proof?.matched === false && proof?.checked === true) {
        state.postconditionObservedAt = Number(now());
        state.postconditionMatched = false;
        state.postconditionReason = String(proof?.reason || 'resume_postcondition_mismatch').slice(0, 240);
        state.status = 'postcondition_failed';
        await persistOccurrenceState(session, state);
        return { found: true, reconciled: true, committed: false, shouldRedispatch: false, functionalFailure: true, reason: state.postconditionReason, state: { ...state } };
      }
      state.status = 'reconciliation_pending';
      await persistOccurrenceState(session, state);
    }
    return { found: true, reconciled: true, committed: false, shouldRedispatch: false, reason: 'resume_postcondition_unproven', state: { ...state } };
  };

  const issueExecutionPermit = ({
    session,
    toolName,
    args = {},
    actionOccurrenceId,
    transactionId,
    operationId,
    origin,
    phase = 'action',
    attempt = 1,
    source = 'action_execution_gateway',
  } = {}) => {
    if (!session || typeof session !== 'object') throw new ActionExecutionGatewayError('Execution permit requires a live MCP session.', 'ACTION_EXECUTION_PERMIT_SESSION_REQUIRED');
    if (!isMutatingTool(toolName, args)) throw new ActionExecutionGatewayError('Execution permits are issued only for mutating browser tools.', 'ACTION_EXECUTION_PERMIT_MUTATION_REQUIRED', { toolName });
    const occurrence = String(actionOccurrenceId || '').trim();
    if (!occurrence) throw new ActionExecutionGatewayError('Execution permit requires an actionOccurrenceId.', 'ACTION_EXECUTION_PERMIT_OCCURRENCE_REQUIRED', { toolName });
    const permitId = crypto.randomUUID();
    const issuedAt = Number(now());
    const normalizedPhase = String(phase || 'action').trim() || 'action';
    const normalizedTransactionId = String(transactionId || `transaction:${occurrence}`).trim();
    const normalizedOperationId = String(operationId || `${occurrence}:${normalizedPhase}`).trim();
    const normalizedOrigin = String(origin || source || 'action_execution_gateway').trim();
    const normalizedAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
    permits.set(permitId, {
      permitId,
      sessionId: sessionId(session),
      toolName: String(toolName),
      argsDigest: digest(args || {}),
      actionOccurrenceId: occurrence,
      transactionId: normalizedTransactionId,
      operationId: normalizedOperationId,
      origin: normalizedOrigin,
      phase: normalizedPhase,
      attempt: normalizedAttempt,
      source: String(source || 'action_execution_gateway'),
      issuedAt,
      expiresAt: issuedAt + Math.max(1, Number(ttlMs) || DEFAULT_TTL_MS),
      consumedAt: null,
    });
    return Object.freeze({ version: PERMIT_VERSION, permitId });
  };

  const consumeExecutionPermit = ({ session, toolName, args = {}, permit } = {}) => {
    const permitId = permit && permit.version === PERMIT_VERSION ? permit.permitId : null;
    const state = permitId && permits.get(permitId);
    if (!state) throw new ActionExecutionGatewayError('Mutating MCP call requires a valid coordinator-issued execution permit.', 'ACTION_EXECUTION_PERMIT_REQUIRED', { toolName });
    if (state.consumedAt != null) throw new ActionExecutionGatewayError('Execution permit has already been consumed.', 'ACTION_EXECUTION_PERMIT_REUSED', { toolName, actionOccurrenceId: state.actionOccurrenceId });
    if (Number(now()) > state.expiresAt) throw new ActionExecutionGatewayError('Execution permit expired before dispatch.', 'ACTION_EXECUTION_PERMIT_EXPIRED', { toolName, actionOccurrenceId: state.actionOccurrenceId });
    if (state.sessionId !== sessionId(session)) throw new ActionExecutionGatewayError('Execution permit belongs to a different browser session.', 'ACTION_EXECUTION_PERMIT_SESSION_MISMATCH', { toolName, actionOccurrenceId: state.actionOccurrenceId });
    if (state.toolName !== String(toolName)) throw new ActionExecutionGatewayError('Execution permit does not authorize this browser tool.', 'ACTION_EXECUTION_PERMIT_TOOL_MISMATCH', { expectedToolName: state.toolName, toolName, actionOccurrenceId: state.actionOccurrenceId });
    if (state.argsDigest !== digest(args || {})) throw new ActionExecutionGatewayError('Execution permit does not authorize these browser arguments.', 'ACTION_EXECUTION_PERMIT_ARGS_MISMATCH', { toolName, actionOccurrenceId: state.actionOccurrenceId });
    state.consumedAt = Number(now());
    return { ...state };
  };

  const authorizeMcpCall = ({ session, toolName, args = {}, permit } = {}) => {
    if (!isMutatingTool(toolName, args)) return { authorized: true, mutating: false, permit: null };
    const consumed = consumeExecutionPermit({ session, toolName, args, permit });
    return { authorized: true, mutating: true, permit: consumed };
  };

  const authorizeTargetForMutation = ({ toolName, args = {}, options = {} } = {}) => {
    const required = requiresVerifiedSemanticTarget(toolName, args)
      || options.requireVerifiedTarget === true;
    if (!isMutatingTool(toolName, args) || !required) {
      return { authorized: true, required: false, targetAuthorization: null };
    }
    if (process.env.QAAI_DEMO_BYPASS_TARGET_GUARDS === '1') {
      return {
        authorized: true,
        required: false,
        targetAuthorization: options.targetAuthorization || null,
        demoBypass: true,
      };
    }
    const targetAuthorization = options.targetAuthorization && typeof options.targetAuthorization === 'object'
      ? options.targetAuthorization
      : null;
    const allowed = targetAuthorization?.liveMutationAllowed === true
      && targetAuthorization?.diagnosticOnly !== true
      && targetAuthorization?.isGuess !== true;
    if (!allowed) {
      throw new ActionExecutionGatewayError(
        'Live browser mutation requires a verified semantic target; weak, diagnostic, or guessed target evidence is observation-only.',
        'ACTION_EXECUTION_TARGET_UNVERIFIED',
        {
          toolName,
          targetStatus: targetAuthorization?.status || 'missing',
          targetReason: targetAuthorization?.reason || 'verified_target_authorization_missing',
        },
      );
    }
    return { authorized: true, required: true, targetAuthorization };
  };

  const dispatchMcpTool = async ({ callTool, session, toolName, args = {}, options = {}, actionOccurrenceId, source } = {}) => {
    if (typeof callTool !== 'function') throw new TypeError('ActionExecutionGateway requires callTool().');
    if (!isMutatingTool(toolName, args)) return callTool(session, toolName, args, options);
    authorizeTargetForMutation({ toolName, args, options });
    const actionabilityRequirements = targetActionabilityRequirements(toolName, args);
    const targetActionabilityEvidence = options.requireActionableTarget === true
      ? await awaitTargetActionability({
          requirements: actionabilityRequirements,
          observe: options.observeTargetActionability,
          timeoutMs: options.targetActionabilityTimeoutMs,
          pollIntervalMs: options.targetActionabilityPollIntervalMs,
        })
      : null;
    if (targetActionabilityEvidence && targetActionabilityEvidence.matched !== true) {
      throw new ActionExecutionGatewayError(
        'The exact semantic target did not become visible and actionable within the bounded pre-dispatch wait.',
        'ACTION_EXECUTION_TARGET_NOT_ACTIONABLE',
        {
          toolName,
          targetDigest: targetActionabilityEvidence.targetDigest,
          targetReason: targetActionabilityEvidence.reason,
          editableRequired: targetActionabilityEvidence.editable,
        },
      );
    }
    const occurrenceState = await beginExactlyOnceDispatch({
      session, toolName, args, options, actionOccurrenceId, source,
    });
    if (occurrenceState && targetActionabilityEvidence) {
      occurrenceState.targetActionabilityMatched = true;
      occurrenceState.targetActionabilityEditable = targetActionabilityEvidence.editable;
      occurrenceState.targetActionabilityTargetDigest = targetActionabilityEvidence.targetDigest;
      occurrenceState.targetActionabilityReason = targetActionabilityEvidence.reason;
      occurrenceState.targetActionabilityObservedAt = targetActionabilityEvidence.observedAt;
      await persistOccurrenceState(session, occurrenceState);
    }
    const executionPermit = issueExecutionPermit({
      session,
      toolName,
      args,
      actionOccurrenceId,
      transactionId: occurrenceState.transactionId,
      operationId: occurrenceState.operationId,
      origin: source || options.origin,
      phase: occurrenceState.mutationPhaseId,
      attempt: occurrenceState.dispatchAttemptCount,
      source,
    });
    try {
      const result = await callTool(session, toolName, args, {
        ...transportOptions(options),
        executionPermit,
      });
      await finishExactlyOnceDispatch(session, occurrenceState, result);
      const oracle = options.waitForLandingOracle === true
        ? deriveLandingOracle({
            authoredNextState: options.authoredNextState,
            authoredNextStates: options.authoredNextStates,
          })
        : null;
      const landingEvidence = result?.isError === true ? null : await awaitLandingOracle({
        oracle,
        observe: options.observeLandingOracle,
        timeoutMs: options.landingOracleTimeoutMs,
        pollIntervalMs: options.landingOraclePollIntervalMs,
        stableObservations: options.landingOracleStableObservations,
      });
      if (landingEvidence && occurrenceState) {
        occurrenceState.landingOracleKind = landingEvidence.kind;
        occurrenceState.landingOracleTargetDigest = landingEvidence.targetDigest;
        occurrenceState.landingOracleMatched = landingEvidence.matched;
        occurrenceState.landingOracleReason = landingEvidence.reason;
        occurrenceState.landingOracleObservedAt = landingEvidence.observedAt;
        await persistOccurrenceState(session, occurrenceState);
      }
      if (result && typeof result === 'object') {
        return {
          ...result,
          ...(targetActionabilityEvidence
            ? { qaaiTargetActionabilityEvidence: targetActionabilityEvidence }
            : {}),
          ...(landingEvidence ? { qaaiLandingOracleEvidence: landingEvidence } : {}),
        };
      }
      return result;
    } catch (error) {
      await finishExactlyOnceDispatch(session, occurrenceState, null, error);
      throw error;
    }
  };

  const dispatchBrowserMutation = async ({
    session,
    mutationName,
    args = {},
    actionOccurrenceId,
    source = 'playwright_gateway',
    dispatch,
    transactionId,
    operationId,
    phase,
  } = {}) => {
    if (typeof dispatch !== 'function') throw new TypeError('ActionExecutionGateway requires a browser mutation dispatch function.');
    const options = {
      enforceExactlyOnce: true,
      mutationPhaseId: String(phase || mutationName || 'browser_adapter').trim(),
      transactionId,
      operationId,
      origin: source,
    };
    const occurrenceState = await beginExactlyOnceDispatch({
      session,
      toolName: mutationName,
      args,
      options,
      actionOccurrenceId,
      source,
    });
    const permit = issueExecutionPermit({
      session,
      toolName: mutationName,
      args,
      actionOccurrenceId,
      transactionId: occurrenceState.transactionId,
      operationId: occurrenceState.operationId,
      origin: source,
      phase: occurrenceState.mutationPhaseId,
      attempt: occurrenceState.dispatchAttemptCount,
      source,
    });
    const authorization = consumeExecutionPermit({
      session, toolName: mutationName, args, permit,
    });
    if (!Array.isArray(session.actionExecutionGatewayTrail)) session.actionExecutionGatewayTrail = [];
    const trailEntry = {
      actionOccurrenceId: authorization.actionOccurrenceId,
      toolName: authorization.toolName,
      source: authorization.source,
      transactionId: authorization.transactionId,
      operationId: authorization.operationId,
      phase: authorization.phase,
      attempt: authorization.attempt,
      permitId: authorization.permitId,
      authorizedAt: authorization.consumedAt,
      dispatchStartedAt: Number(now()),
      browserAdapter: true,
    };
    session.actionExecutionGatewayTrail.push(trailEntry);
    if (session.actionExecutionGatewayTrail.length > 2_000) session.actionExecutionGatewayTrail.shift();
    try {
      const result = await dispatch();
      trailEntry.dispatchCompletedAt = Number(now());
      await finishExactlyOnceDispatch(session, occurrenceState, result);
      return result;
    } catch (error) {
      trailEntry.dispatchFailedAt = Number(now());
      trailEntry.errorCode = String(error?.code || error?.name || 'BROWSER_MUTATION_FAILED');
      await finishExactlyOnceDispatch(session, occurrenceState, null, error);
      throw error;
    }
  };

  const markSdkCallAuthorized = (requestOptions = {}, { session, authorization } = {}) => {
    const permitId = authorization?.permitId || null;
    const state = permitId ? permits.get(permitId) : null;
    if (!state || state.consumedAt == null || state.sessionId !== sessionId(session)) {
      throw new ActionExecutionGatewayError('SDK dispatch marker requires a consumed execution permit.', 'ACTION_EXECUTION_SDK_AUTHORIZATION_REQUIRED');
    }
    const options = requestOptions && typeof requestOptions === 'object' ? requestOptions : {};
    const token = Object.freeze({
      permitId,
      sessionId: state.sessionId,
      toolName: state.toolName,
      argsDigest: state.argsDigest,
    });
    sdkAuthorizationTokens.add(token);
    Object.defineProperty(options, SDK_CALL_AUTHORIZATION, {
      value: token,
      configurable: true,
      enumerable: false,
      writable: false,
    });
    return options;
  };

  const sdkCallIsAuthorized = (requestOptions, { session, toolName, args = {} } = {}) => {
    const token = requestOptions?.[SDK_CALL_AUTHORIZATION];
    if (!token || !sdkAuthorizationTokens.has(token)) return false;
    sdkAuthorizationTokens.delete(token);
    return token
      && token.sessionId === sessionId(session)
      && token.toolName === String(toolName || '')
      && token.argsDigest === digest(args || {});
  };

  const protectMcpSessionClient = (session, { source = 'mcp_sdk_boundary' } = {}) => {
    if (!session || typeof session !== 'object' || !session.client || typeof session.client.callTool !== 'function') {
      throw new ActionExecutionGatewayError('Cannot protect an MCP session without a callable SDK client.', 'ACTION_EXECUTION_CLIENT_REQUIRED');
    }
    const existing = protectedClients.get(session);
    if (existing?.client === session.client && session.client.callTool === existing.protectedCallTool) return session.client;

    const client = session.client;
    const rawCallTool = client.callTool.bind(client);
    let rawSequence = 0;
    const protectedCallTool = async (request = {}, responseSchema, requestOptions) => {
      const toolName = String(request?.name || '');
      const args = request?.arguments || {};
      if (isMutatingTool(toolName, args) && !sdkCallIsAuthorized(requestOptions, { session, toolName, args })) {
        const bypassAttemptId = `raw-sdk:${session.id || sessionId(session)}:${toolName}:${++rawSequence}`;
        if (!Array.isArray(session.actionExecutionGatewayTrail)) session.actionExecutionGatewayTrail = [];
        session.actionExecutionGatewayTrail.push({
          bypassAttemptId,
          toolName,
          source,
          rawSdkCaller: true,
          blocked: true,
          blockedAt: Number(now()),
          reason: 'coordinator_execution_permit_required',
        });
        if (session.actionExecutionGatewayTrail.length > 2_000) session.actionExecutionGatewayTrail.shift();
        throw new ActionExecutionGatewayError(
          'Direct mutating MCP SDK calls are forbidden; dispatch through ActionExecutionGateway with a coordinator-issued permit.',
          'ACTION_EXECUTION_GATEWAY_BYPASS',
          { toolName, bypassAttemptId },
        );
      }
      return rawCallTool(request, responseSchema, requestOptions);
    };
    Object.defineProperty(protectedCallTool, 'qaaiActionExecutionGatewayProtected', { value: true });
    client.callTool = protectedCallTool;
    protectedClients.set(session, { client, rawCallTool, protectedCallTool });
    session.executionGatewayRequired = true;
    return client;
  };

  return {
    issueExecutionPermit,
    consumeExecutionPermit,
    authorizeMcpCall,
    authorizeTargetForMutation,
    dispatchMcpTool,
    recordOccurrencePostcondition,
    commitOccurrence,
    reconcileOccurrenceOnResume,
    dispatchBrowserMutation,
    markSdkCallAuthorized,
    sdkCallIsAuthorized,
    protectMcpSessionClient,
    pendingPermitCount: () => [...permits.values()].filter((permit) => permit.consumedAt == null).length,
    deriveLandingOracle,
    evaluateLandingOracleObservation,
    awaitLandingOracle,
    targetActionabilityRequirements,
    evaluateTargetActionabilitySnapshot,
    awaitTargetActionability,
  };
}

const defaultGateway = createActionExecutionGateway();

module.exports = {
  PERMIT_VERSION,
  LANDING_ORACLE_SCHEMA,
  MUTATING_BROWSER_TOOLS,
  SEMANTIC_TARGET_MUTATION_TOOLS,
  EVALUATE_MUTATION_RE,
  ActionExecutionGatewayError,
  isMutatingBrowserEvaluate,
  isMutatingTool,
  requiresVerifiedSemanticTarget,
  deriveLandingOracle,
  evaluateLandingOracleObservation,
  targetActionabilityRequirements,
  evaluateTargetActionabilitySnapshot,
  createActionExecutionGateway,
  defaultGateway,
  dispatchMcpTool: defaultGateway.dispatchMcpTool,
  recordOccurrencePostcondition: defaultGateway.recordOccurrencePostcondition,
  commitOccurrence: defaultGateway.commitOccurrence,
  reconcileOccurrenceOnResume: defaultGateway.reconcileOccurrenceOnResume,
  dispatchBrowserMutation: defaultGateway.dispatchBrowserMutation,
  awaitLandingOracle: defaultGateway.awaitLandingOracle,
  awaitTargetActionability: defaultGateway.awaitTargetActionability,
  markSdkCallAuthorized: defaultGateway.markSdkCallAuthorized,
  protectMcpSessionClient: defaultGateway.protectMcpSessionClient,
};
