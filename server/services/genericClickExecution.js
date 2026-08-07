'use strict';

const actionTransactionCoordinator = require('./actionTransactionCoordinator');

const { isPresenceConditionalAction } = require('./conditionalActionIntent');

const pageFingerprint = require('./pageFingerprint');
const { resolveClickableControl } = require('./clickTargetResolver');
const { genericTransitionAlreadySatisfied } = require('./transitionState');

const STATES = Object.freeze({
  OBSERVE_BEFORE: 'observe_before',
  RESOLVE: 'resolve',
  DISPATCH: 'dispatch',
  OBSERVE_AFTER: 'observe_after',
  PROVE: 'prove',
  RECONCILE: 'reconcile',
  RERESOLVE: 'reresolve',
  RETRY: 'retry',
  FINAL_PROOF: 'final_proof',
  COMPLETE: 'complete',
  FAILED: 'failed',
});

const SAFE_CHANNELS = new Set([
  'active_page',
  'control',
  'dialog',
  'dom',
  'field',
  'fingerprint',
  'heading',
  'landmark',
  'origin',
  'page',
  'selected',
  'text',
  'title',
  'url',
  'value',
  'visibility',
]);

const SAFE_OUTCOME_REASONS = new Set([
  'click_effect_not_proven',
  'click_retry_dispatch_failed',
  'clickable_control_not_resolved',
  'declared_transition_already_satisfied',
  'fresh_click_reconciliation_observation_unavailable',
  'fresh_post_retry_observation_unavailable',
  'fresh_pre_click_observation_unavailable',
]);

const ORDINAL_VALUES = Object.freeze({
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
});

const ORDINAL_TOKEN_PATTERN = [
  ...Object.keys(ORDINAL_VALUES),
  '\\d+(?:st|nd|rd|th)?',
].join('|');

function authoredOrdinalValue(token) {
  const normalized = String(token || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(ORDINAL_VALUES, normalized)) {
    return ORDINAL_VALUES[normalized];
  }
  const numeric = Number.parseInt(normalized, 10);
  return Number.isInteger(numeric) && numeric > 0 && numeric <= 100 ? numeric : null;
}

function unwrapExactAuthoredValue(value) {
  const trimmed = String(value || '').trim();
  const quoted = trimmed.match(/^(["'])([\s\S]+)\1$/);
  return {
    exactValue: String(quoted ? quoted[2] : trimmed).trim(),
    quoted: !!quoted,
  };
}

/**
 * Parse only explicit authored option-row clicks. Ordinary controls that merely
 * contain the word "option" must remain on the normal click-resolution path.
 */
function parseAuthoredOptionClickIntent(authoredTarget) {
  const originalTarget = String(authoredTarget || '').replace(/\s+/g, ' ').trim();
  if (!originalTarget || !/\boptions?\b/i.test(originalTarget)) return null;

  const target = originalTarget
    .replace(/^(?:click|tap|activate|choose|select)\s+(?:on\s+)?/i, '')
    .replace(/^the\s+/i, '')
    .trim();
  const match = target.match(new RegExp(
    `^(?:(${ORDINAL_TOKEN_PATTERN})\\s+)?(.*?)\\s*option\\s*`
      + `(?:,|:|\\s+-\\s+|\\s+(?:named|labelled|labeled)\\s+)\\s*(.+)$`,
    'i',
  ));
  if (!match) return null;

  const ordinalText = String(match[1] || '').trim().toLowerCase() || null;
  const ordinal = authoredOrdinalValue(ordinalText);
  const ownerLabel = String(match[2] || '')
    .replace(/^the\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim() || null;
  const unwrapped = unwrapExactAuthoredValue(match[3]);
  const exactValue = unwrapped.exactValue;

  if (!exactValue || exactValue.length > 240) return null;
  if (!ownerLabel && !ordinal && !unwrapped.quoted) return null;
  if (/^(?:that|which|where|when|if|to|from|in|on|with)\b/i.test(exactValue)) return null;
  if (/\b(?:and|then)\s+(?:verify|validate|assert|click|choose|select|wait)\b/i.test(exactValue)) return null;
  if (/\{\{[^}]+\}\}|<[^>]+>/.test(exactValue)) return null;

  return {
    kind: 'authored_option_click',
    originalTarget,
    ownerLabel,
    ordinal,
    ordinalText,
    exactValue,
    exactValueQuoted: unwrapped.quoted,
  };
}

function optionClickResolutionContract(intent, step = {}) {
  if (!intent) return null;
  const contextTokens = [];
  if (intent.ownerLabel) contextTokens.push(intent.ownerLabel);
  const supplied = step.contextTokens || step.targetContextTokens || null;
  if (Array.isArray(supplied)) contextTokens.push(...supplied.filter(Boolean));
  else if (supplied) contextTokens.push(supplied);
  return {
    authoredLabel: intent.exactValue,
    contextTokens,
    role: 'option',
  };
}

function attachOptionIntent(resolution, intent, contract) {
  if (!intent || !resolution || typeof resolution !== 'object') return resolution;
  return {
    ...resolution,
    authoredOptionIntent: intent,
    resolutionTarget: contract,
  };
}

function safeEnum(value, allowed, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function safeChannel(value) {
  return safeEnum(value, SAFE_CHANNELS, 'other');
}

function safeResolutionReason(resolution) {
  if (resolution?.ok === true) return 'clickable_control_resolved';
  if (resolution?.reason === 'ambiguous_clickable_control') return 'ambiguous_clickable_control';
  if (resolution?.reason === 'no_clickable_control') return 'no_clickable_control';
  return 'clickable_control_not_resolved';
}

function safeTransitionReason(transition) {
  return transition?.satisfied === true
    ? 'declared_transition_already_satisfied'
    : 'transition_not_proven';
}

function safeEffectStatus(record) {
  if (record?.matched === true) return 'matched';
  if (record?.checked === true) return 'not_matched';
  return 'uncheckable';
}

function safeEffectKind(record) {
  return record?.kind === 'oracle' ? 'oracle' : 'effect_check';
}

function safeEffectReason(record) {
  if (record?.reason === 'optional_target_absent') return record.reason;
  if (record?.reason === 'authored_fingerprint_change_observed') return record.reason;
  if (record?.reason === 'click_dispatched_fingerprint_changed_next_verify') return record.reason;
  if (record?.matched === true) return 'effect_proven';
  if (record?.checked === true) return 'effect_not_matched';
  return 'effect_uncheckable';
}

function safeOutcomeReason(reason, status) {
  const normalized = String(reason || '').trim().toLowerCase();
  if (normalized === 'optional_target_absent') return normalized;
  if (SAFE_OUTCOME_REASONS.has(normalized)) return normalized;
  if (normalized === 'ambiguous_clickable_control') return normalized;
  if (normalized === 'no_clickable_control') return normalized;
  if (normalized === 'clickable_control_resolved') return normalized;
  if (normalized === 'effect_proven') return normalized;
  if (normalized === 'effect_not_matched') return normalized;
  if (normalized === 'effect_uncheckable') return normalized;
  if (normalized === 'authored_fingerprint_change_observed') return normalized;
  if (normalized === 'click_dispatched_fingerprint_changed_next_verify') return normalized;
  if (status === 'pass') return 'click_effect_proven';
  if (status === 'fail') return 'click_effect_failed';
  return 'click_execution_blocked';
}

function safeRecordForSeal(record) {
  if (!record || typeof record !== 'object') return record;
  const safe = {
    ...record,
    status: safeEffectStatus(record),
    kind: safeEffectKind(record),
    reason: safeEffectReason(record),
  };
  if (typeof safe.evidence === 'string') safe.evidence = safe.reason;
  return safe;
}

function safeObservationForSeal(observation, source, fingerprint) {
  return {
    source,
    fresh: observation?.fresh === true,
    usable: !!observation?.snapshotText && observation?.fresh === true,
    fingerprint: compactFingerprint(fingerprint),
  };
}

function safeDispatchForSeal(dispatched, diagnostics) {
  const lastAttempt = diagnostics.dispatches[diagnostics.dispatches.length - 1] || null;
  return {
    ok: dispatched?.ok === true,
    attempt: lastAttempt?.attempt || null,
    retry: lastAttempt?.retry === true,
    reason: lastAttempt?.reason || 'dispatch_not_attempted',
    trailEntry: dispatched?.trailEntry || null,
  };
}

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`generic click execution requires ${name}()`);
}

function compactFingerprint(fingerprint) {
  if (!fingerprint || typeof fingerprint !== 'object') return null;
  return {
    schema: fingerprint.schema || null,
    structuralHash: fingerprint.structuralHash || null,
    observedAt: fingerprint.observedAt || null,
  };
}

function safeTransactionForSeal(transaction) {
  if (!transaction || typeof transaction !== 'object') return null;
  const hydrated = actionTransactionCoordinator.hydrateActionTransaction(transaction);
  const observations = (hydrated.observations || []).map((observation) => {
    const proof = observation?.proof && typeof observation.proof === 'object'
      ? observation.proof
      : null;
    return {
      ...observation,
      proof: proof ? {
        matched: proof.matched === true ? true : proof.matched === false ? false : null,
        checked: proof.checked === true,
        terminal: proof.terminal === true,
        status: safeEffectStatus(proof),
        kind: safeEffectKind(proof),
        reason: safeEffectReason(proof),
        evidence: safeEffectReason(proof),
      } : null,
    };
  });
  const canonical = hydrated.canonicalOutcome && typeof hydrated.canonicalOutcome === 'object'
    ? hydrated.canonicalOutcome
    : null;
  const canonicalStatus = canonical?.status === 'passed'
    ? 'pass'
    : canonical?.outcomeKind === actionTransactionCoordinator.OUTCOME_KIND.FUNCTIONAL_FAILURE
      ? 'fail'
      : 'blocked';
  return {
    ...hydrated,
    observations,
    canonicalOutcome: canonical ? {
      ...canonical,
      reason: safeOutcomeReason(canonical.reason, canonicalStatus),
      evidence: safeRecordForSeal(canonical.evidence),
    } : null,
  };
}

function fingerprintFor(observation) {
  if (!observation || !observation.snapshotText) return null;
  return pageFingerprint.fromSnapshotText({
    url: observation.url || null,
    title: observation.title || null,
    snapshotText: observation.snapshotText,
  });
}

function safeResolution(resolution) {
  const candidates = Array.isArray(resolution?.candidates) ? resolution.candidates : [];
  return {
    ok: resolution?.ok === true,
    reason: safeResolutionReason(resolution),
    authoritative: resolution?.authoritativeVerified === true,
    candidateCount: candidates.length,
    confidenceMargin: Number.isFinite(Number(resolution?.confidenceMargin))
      ? Number(resolution.confidenceMargin)
      : null,
    candidates: candidates.slice(0, 5).map((candidate) => ({
      role: candidate?.role || null,
      score: Number.isFinite(Number(candidate?.score)) ? Number(candidate.score) : null,
      nameHitCount: Number.isFinite(Number(candidate?.nameHitCount)) ? Number(candidate.nameHitCount) : 0,
      contextHitCount: Number.isFinite(Number(candidate?.contextHitCount)) ? Number(candidate.contextHitCount) : 0,
      roleMatch: candidate?.roleMatch === true ? true : candidate?.roleMatch === false ? false : null,
    })),
  };
}

function positiveBackendNodeId(...values) {
  for (const value of values) {
    const id = Number(value);
    if (Number.isInteger(id) && id > 0) return id;
  }
  return null;
}

function verifiedAuthoritativeResolution(resolution) {
  if (!resolution || resolution.ok !== true || !resolution.ref || !resolution.actionLocator) return null;
  const locator = resolution.actionLocator;
  const primary = locator.kind === 'multi'
    ? locator.fields?.find((field) => field?.actionLocator)?.actionLocator || null
    : locator;
  if (!primary || primary.diagnosticOnly === true || primary.guess?.isGuess === true) return null;
  const proof = primary.proof && typeof primary.proof === 'object' ? primary.proof : {};
  const context = primary.context && typeof primary.context === 'object' ? primary.context : {};
  const source = primary.verificationSource || primary.evidenceSource || proof.source || null;
  if (source !== 'authoritative_chromium_cdp') return null;
  if (
    primary.verified !== true
    || proof.verified !== true
    || proof.sameElement !== true
    || proof.authoritativeCdpVerified !== true
    || proof.backendNodeVerified !== true
    || proof.stableAcrossSnapshots !== true
  ) return null;
  const captureBinding = primary.captureBinding || context.captureBinding || null;
  if (captureBinding?.kind !== 'mcp_bound_ref' || String(captureBinding.ref || '') !== String(resolution.ref)) {
    return null;
  }
  const expectedBackendNodeId = positiveBackendNodeId(
    proof.expectedBackendNodeId,
    proof.targetIdentity?.backendNodeId,
    primary.targetFacts?.cdpBackendNodeId,
    context.authoritativeCdp?.pre?.identity?.backendNodeId,
  );
  const matchedBackendNodeId = positiveBackendNodeId(
    proof.matchedBackendNodeId,
    proof.matchedIdentity?.backendNodeId,
  );
  const backendNodeIdBefore = positiveBackendNodeId(
    proof.backendNodeIdBefore,
    context.authoritativeCdp?.reverification?.backendNodeIdBefore,
    context.authoritativeCdp?.pre?.identity?.backendNodeId,
  );
  const backendNodeIdAfter = positiveBackendNodeId(
    proof.backendNodeIdAfter,
    context.authoritativeCdp?.reverification?.backendNodeIdAfter,
    context.authoritativeCdp?.pre?.stabilization?.backendNodeIdAfter,
  );
  if (!expectedBackendNodeId || !matchedBackendNodeId || !backendNodeIdBefore || !backendNodeIdAfter) return null;
  if (new Set([
    expectedBackendNodeId,
    matchedBackendNodeId,
    backendNodeIdBefore,
    backendNodeIdAfter,
  ]).size !== 1) return null;
  return {
    ...resolution,
    ok: true,
    reason: 'authoritative_clickable_control_resolved',
    authoritativeVerified: true,
    expectedBackendNodeId,
  };
}

function isVerifyStep(step = {}) {
  return /\b(?:verify|check|assert|confirm|validate)\b/i.test(String(step.action || step.kind || step.type || ''));
}

function explicitlyDelegatesToStableFingerprintChange(step = {}, proofSteps = []) {
  const operationKind = String(
    step.operationCheck?.kind
    || step.expectedKind
    || step.transition?.kind
    || '',
  ).trim().toLowerCase();
  const explicitFingerprintChange = [
    'fingerprint_change',
    'fingerprint_changed',
    'page_fingerprint_change',
    'page_fingerprint_changed',
  ].includes(operationKind);
  const nextVerify = proofSteps.slice(1).some(isVerifyStep);
  return { explicitFingerprintChange, nextVerify, delegated: explicitFingerprintChange || nextVerify };
}

function delegatedFingerprintRecord({ step, proofSteps, beforeFingerprint, currentFingerprint, dispatched }) {
  if (dispatched?.ok !== true || !beforeFingerprint || !currentFingerprint) return null;
  const delegation = explicitlyDelegatesToStableFingerprintChange(step, proofSteps);
  if (!delegation.delegated) return null;
  const effect = pageFingerprint.diff(beforeFingerprint, currentFingerprint);
  if (effect?.changed !== true || !currentFingerprint.structuralHash) return null;
  return {
    status: 'pass',
    matched: true,
    checked: true,
    reason: delegation.explicitFingerprintChange
      ? 'authored_fingerprint_change_observed'
      : 'click_dispatched_fingerprint_changed_next_verify',
    evidence: delegation.explicitFingerprintChange
      ? 'The successful click produced the explicitly authored stable page-fingerprint change.'
      : 'The successful click produced a stable page-fingerprint change; the following authored Verify step owns the business assertion.',
    kind: 'operation_check',
    required: true,
    observedState: {
      delegatedToNextVerify: delegation.nextVerify,
      explicitFingerprintChange: delegation.explicitFingerprintChange,
      pageEffect: {
        changed: true,
        channels: Array.isArray(effect.channels) ? effect.channels.slice(0, 12) : [],
      },
    },
  };
}

function safeTransition(transition, transitionIndex, phase) {
  const match = transition?.evidence?.match || null;
  return {
    phase,
    transitionIndex,
    satisfied: transition?.satisfied === true,
    reason: safeTransitionReason(transition),
    checked: match?.checked === true,
    matched: match?.matched === true,
    channels: Array.isArray(match?.checks)
      ? match.checks.slice(0, 12).map((check) => ({
          channel: safeChannel(check?.channel),
          matched: check?.matched === true,
        }))
      : [],
    pageEffect: transition?.evidence?.pageEffect
      ? {
          changed: transition.evidence.pageEffect.changed === true,
          channels: Array.isArray(transition.evidence.pageEffect.channels)
            ? transition.evidence.pageEffect.channels.slice(0, 12).map(safeChannel)
            : [],
        }
      : null,
  };
}

function decideDependencyScopedContinuation({
  sealed = null,
  hasRunnableStep = false,
} = {}) {
  const journalOutcome = String(sealed?.continuationOutcome || '').toLowerCase();
  if (journalOutcome === 'stop_case') {
    return { terminal: true, outcome: 'stop_case', reason: 'central_policy_stopped_run' };
  }
  if (hasRunnableStep) {
    return {
      terminal: false,
      outcome: journalOutcome || 'continue',
      reason: 'independent_runnable_step_available',
    };
  }
  return {
    terminal: true,
    outcome: journalOutcome || 'stop_descendants',
    reason: 'no_runnable_step_after_dependency_seal',
  };
}

function transitionRecord(transition) {
  return {
    status: 'pass',
    matched: true,
    checked: true,
    reason: 'declared_transition_already_satisfied',
    evidence: 'Fresh page evidence matched every channel in the typed expected state.',
    kind: 'operation_check',
    required: true,
    observedState: transition.evidence || null,
    genericClickTransition: true,
  };
}

async function executeGenericClick({
  step = {},
  target = '',
  transitionSteps = [],
  observe,
  dispatch,
  resolveAuthoritative,
  prepareAuthoredOption,
  proveEffect,
  seal,
  sleep,
  persistTransaction,
  persistedTransaction,
  transactionContext = {},
  evidenceAdapter = null,
} = {}) {
  requireFunction(observe, 'observe');
  requireFunction(dispatch, 'dispatch');
  requireFunction(seal, 'seal');

  const proofSteps = (Array.isArray(transitionSteps) ? transitionSteps : [transitionSteps])
    .filter((candidate) => candidate && typeof candidate === 'object');
  if (!proofSteps.length) proofSteps.push(step);

  const authoredOptionIntent = parseAuthoredOptionClickIntent(
    target || step.target || step.element || step.control || '',
  );
  const authoredOptionResolutionTarget = optionClickResolutionContract(authoredOptionIntent, step);

  const diagnostics = {
    schema: 'generic_click_attempt_v1',
    authoredOptionIntent,
    states: [],
    observations: [],
    resolutions: [],
    dispatches: [],
    transitions: [],
    effectProofs: [],
    browserEvidence: [],
    final: null,
  };
  let beforeObservation = null;
  let beforeFingerprint = null;
  let latestObservation = null;
  let latestFingerprint = null;
  let latestDispatch = null;
  const actionOccurrenceId = transactionContext.actionOccurrenceId
    || transactionContext.occurrenceId
    || `${step.id || step.stepId || 'step'}:${transactionContext.sequenceIndex ?? step.sequenceIndex ?? step.stepIndex ?? 0}`;
  const captureEvidence = async (method, request) => {
    if (!evidenceAdapter || typeof evidenceAdapter[method] !== 'function') return null;
    try {
      const evidence = await evidenceAdapter[method]({
        actionOccurrenceId,
        stepId: transactionContext.stepId || step.id || step.stepId || null,
        actionAttemptId: `${actionOccurrenceId}:click:1`,
        actionType: 'click',
        controlType: 'command',
        targetDescription: target,
        ...request,
      });
      if (evidence) diagnostics.browserEvidence.push(evidence);
      return evidence || null;
    } catch (error) {
      diagnostics.browserEvidence.push({
        phase: method,
        status: 'capture_error',
        error: { name: error?.name || 'Error', message: 'Browser evidence capture failed' },
      });
      return null;
    }
  };

  const enter = (state) => diagnostics.states.push(state);
  const observeFresh = async (phase) => {
    enter(phase === 'pre_dispatch' ? STATES.OBSERVE_BEFORE
      : phase === 'reconcile' ? STATES.RECONCILE
        : phase === 'post_retry' ? STATES.FINAL_PROOF : STATES.OBSERVE_AFTER);
    let observation = null;
    try { observation = await observe({ phase, requireFresh: true }); } catch (_) {}
    const usable = !!observation?.snapshotText && observation?.fresh === true;
    const fingerprint = usable ? fingerprintFor(observation) : null;
    diagnostics.observations.push({
      phase,
      source: `fresh_${phase}_observation`,
      fresh: observation?.fresh === true,
      usable,
      fingerprint: compactFingerprint(fingerprint),
    });
    return usable ? { observation, fingerprint } : null;
  };

  const resolveFresh = async (observed, phase) => {
    enter(phase === 'retry' ? STATES.RERESOLVE : STATES.RESOLVE);
    const resolutionTarget = authoredOptionResolutionTarget || {
      authoredLabel: target,
      contextTokens: step.contextTokens || step.targetContextTokens || null,
      role: step.targetRole || step.role || null,
    };
    let resolution = attachOptionIntent(
      resolveClickableControl(observed.observation.snapshotText, resolutionTarget),
      authoredOptionIntent,
      resolutionTarget,
    );
    const semanticCandidates = Array.isArray(resolution?.candidates) ? resolution.candidates : [];
    const semanticAmbiguous = resolution?.reason === 'ambiguous_clickable_control';
    if (!semanticAmbiguous
      && typeof resolveAuthoritative === 'function'
      && (resolution?.ok === true || semanticCandidates.length === 0)) {
      let authoritative = null;
      try {
        authoritative = await resolveAuthoritative({
          phase,
          step,
          target: authoredOptionIntent?.exactValue || target,
          originalTarget: target,
          authoredOptionIntent,
          resolutionTarget,
          observation: observed.observation,
          fingerprint: observed.fingerprint,
          semanticResolution: resolution,
        });
      } catch (_) {}
      const verified = verifiedAuthoritativeResolution(authoritative);
      resolution = attachOptionIntent(verified || (resolution?.ok === true ? {
        ...resolution,
        ok: false,
        reason: 'authoritative_semantic_target_unverified',
      } : resolution), authoredOptionIntent, resolutionTarget);
    }
    diagnostics.resolutions.push({ phase, ...safeResolution(resolution) });
    return resolution;
  };

  const proveFresh = async ({ observed, dispatched, phase, allowEffectProof = true }) => {
    enter(phase === 'post_retry' ? STATES.FINAL_PROOF : STATES.PROVE);
    for (let index = 0; index < proofSteps.length; index += 1) {
      const transition = genericTransitionAlreadySatisfied({
        step: proofSteps[index],
        beforeFingerprint,
        currentFingerprint: observed?.fingerprint || null,
      });
      diagnostics.transitions.push(safeTransition(transition, index, phase));
      if (transition.satisfied) {
        return { matched: true, record: transitionRecord(transition), transition };
      }
    }
    const delegatedRecord = delegatedFingerprintRecord({
      step,
      proofSteps,
      beforeFingerprint,
      currentFingerprint: observed?.fingerprint || null,
      dispatched,
    });
    if (delegatedRecord) return { matched: true, record: delegatedRecord, transition: null };
    if (!allowEffectProof || typeof proveEffect !== 'function' || !observed) {
      return { matched: false, record: null, transition: null };
    }
    let effect = null;
    try {
      effect = await proveEffect({
        phase,
        step,
        observation: observed.observation,
        fingerprint: observed.fingerprint,
        beforeObservation,
        beforeFingerprint,
        dispatch: dispatched,
      });
    } catch (_) {}
    const record = effect?.record || effect || null;
    diagnostics.effectProofs.push({
      phase,
      matched: record?.matched === true,
      checked: record?.checked === true,
      status: safeEffectStatus(record),
      kind: safeEffectKind(record),
      reason: safeEffectReason(record),
    });
    return { matched: record?.matched === true, record, transition: null };
  };

  const dispatchOnce = async ({ resolution, observed, attempt }) => {
    enter(attempt === 1 ? STATES.DISPATCH : STATES.RETRY);
    let dispatched = null;
    try {
      dispatched = await dispatch({
        attempt,
        retry: attempt === 2,
        resolution,
        observation: observed.observation,
        fingerprint: observed.fingerprint,
      });
    } catch (error) {
      dispatched = { ok: false, error };
    }
    const ok = dispatched?.ok === true || dispatched?.result?.isError === false;
    diagnostics.dispatches.push({
      attempt,
      retry: attempt === 2,
      attempted: true,
      ok,
      reason: ok ? 'dispatch_succeeded' : 'dispatch_failed',
    });
    return { ...(dispatched || {}), ok };
  };

  const finish = async ({ status, reason, record = null, internalOperationCompletion = false }) => {
    enter(status === 'pass' ? STATES.COMPLETE : STATES.FAILED);
    const afterFingerprint = latestFingerprint || beforeFingerprint;
    const pageEffect = beforeFingerprint && afterFingerprint
      ? pageFingerprint.diff(beforeFingerprint, afterFingerprint)
      : null;
    const projectedReason = safeOutcomeReason(reason, status);
    const projectedRecord = safeRecordForSeal(record);
    diagnostics.final = {
      status,
      reason: projectedReason,
      dispatched: diagnostics.dispatches.length > 0,
      retried: diagnostics.dispatches.some((item) => item.retry === true),
      pageEffect: pageEffect
          ? { changed: pageEffect.changed === true, channels: (pageEffect.channels || []).map(safeChannel) }
        : null,
    };
    const sealedPageEffect = pageEffect
      ? { changed: pageEffect.changed === true, channels: (pageEffect.channels || []).map(safeChannel) }
      : null;
    const sealedContext = await seal({
      status,
      reason: projectedReason,
      record: projectedRecord,
      diagnostics,
      dispatch: safeDispatchForSeal(latestDispatch, diagnostics),
      beforeObservation: safeObservationForSeal(
        beforeObservation,
        'fresh_pre_dispatch_observation',
        beforeFingerprint,
      ),
      afterObservation: safeObservationForSeal(
        latestObservation,
        'fresh_post_action_observation',
        afterFingerprint,
      ),
      beforeFingerprint: compactFingerprint(beforeFingerprint),
      afterFingerprint: compactFingerprint(afterFingerprint),
      pageEffect: sealedPageEffect,
      internalOperationCompletion,
    });
    if (status === 'pass') {
      return { handled: true, terminal: false, reason: projectedReason, record: projectedRecord, diagnostics };
    }
    const continuation = decideDependencyScopedContinuation({
      step,
      sealed: sealedContext?.sealed || sealedContext || null,
      hasRunnableStep: sealedContext?.hasRunnableStep === true,
    });
    return {
      handled: true,
      terminal: continuation.terminal,
      reason: projectedReason,
      record: projectedRecord,
      diagnostics,
      continuation,
    };
  };

  let initial = await observeFresh('pre_dispatch');
  if (!initial) return finish({ status: 'blocked', reason: 'fresh_pre_click_observation_unavailable' });
  beforeObservation = initial.observation;
  beforeFingerprint = initial.fingerprint;
  latestObservation = initial.observation;
  latestFingerprint = initial.fingerprint;

  const alreadySatisfied = await proveFresh({
    observed: initial,
    dispatched: null,
    phase: 'pre_dispatch',
    allowEffectProof: false,
  });
  if (alreadySatisfied.matched) {
    return finish({
      status: 'pass',
      reason: 'declared_transition_already_satisfied',
      record: alreadySatisfied.record,
      internalOperationCompletion: true,
    });
  }

  let resolution = await resolveFresh(initial, 'initial');
  if ((!resolution.ok || !resolution.ref) && authoredOptionIntent) {
    const pause = typeof sleep === 'function' ? sleep : async () => {};
    const preparationAttempts = typeof prepareAuthoredOption === 'function' ? 3 : 1;
    for (let optionAttempt = 1;
      optionAttempt <= preparationAttempts && (!resolution.ok || !resolution.ref);
      optionAttempt += 1) {
      if (optionAttempt > 1) await pause(Math.min(2000, 500 * (2 ** (optionAttempt - 2))));
      if (typeof prepareAuthoredOption === 'function') {
        try {
          await prepareAuthoredOption({
            step,
            authoredOptionIntent,
            resolutionTarget: authoredOptionResolutionTarget,
            observation: latestObservation || initial.observation,
            fingerprint: latestFingerprint || initial.fingerprint,
            attempt: optionAttempt,
          });
        } catch (_) {}
      }
      for (let poll = 0; poll < 8 && (!resolution.ok || !resolution.ref); poll += 1) {
        await pause(300);
        const phase = `option_wait_${optionAttempt}_${poll + 1}`;
        const awaited = await observeFresh(phase);
        if (!awaited) continue;
        latestObservation = awaited.observation;
        latestFingerprint = awaited.fingerprint;
        resolution = await resolveFresh(awaited, phase);
        if (resolution.ok && resolution.ref) initial = awaited;
      }
    }
  }
  if (!resolution.ok || !resolution.ref) {
    const candidates = Array.isArray(resolution?.candidates) ? resolution.candidates : [];
    const targetProvenAbsent = candidates.length === 0
      && !/ambiguous/i.test(String(resolution?.reason || ''));
    if (targetProvenAbsent && isPresenceConditionalAction(step)) {
      return finish({
        status: 'pass',
        reason: 'optional_target_absent',
        internalOperationCompletion: true,
        record: {
          status: 'pass',
          matched: true,
          checked: true,
          reason: 'optional_target_absent',
          evidence: 'The conditionally present control was not visible in the fresh browser snapshot, so the authored on-false skip branch was satisfied without dispatching a click.',
          kind: 'operation_check',
          required: false,
          optionalAbsent: true,
        },
      });
    }
    return finish({ status: 'blocked', reason: resolution.reason || 'clickable_control_not_resolved' });
  }

  let lastProofRecord = null;
  const reconciliationPollMs = 500;
  const maxReconciliationPolls = proofSteps.length > 1 ? 30 : 5;
  const coordinated = await actionTransactionCoordinator.coordinateActionTransaction({
    ...transactionContext,
    persistedTransaction,
    stepId: transactionContext.stepId || step.id || step.stepId || null,
    sequenceIndex: transactionContext.sequenceIndex ?? step.sequenceIndex ?? step.stepIndex ?? null,
    action: { kind: 'click', target },
    target,
    failureMode: actionTransactionCoordinator.FAILURE_MODE.DEPENDENT_BLOCK,
    maxDispatchAttempts: 1,
    maxObservationAttempts: maxReconciliationPolls,
    observationIntervalMs: reconciliationPollMs,
    sleep,
    persist: persistTransaction,
    capturePreState: async () => ({
      observation: beforeObservation,
      fingerprint: compactFingerprint(beforeFingerprint),
      resolution: safeResolution(resolution),
    }),
    dispatch: async ({ attempt }) => {
      await captureEvidence('beforeAction', {
        actionAttemptId: `${actionOccurrenceId}:click:${attempt}`,
        observation: beforeObservation,
        resolution,
      });
      latestDispatch = await dispatchOnce({ resolution, observed: initial, attempt });
      await captureEvidence('captureAction', {
        actionAttemptId: `${actionOccurrenceId}:click:${attempt}`,
        observation: initial.observation,
        resolution,
        dispatched: latestDispatch,
      });
      if (!latestDispatch.ok) {
        const error = new Error('click_dispatch_delivery_uncertain');
        error.dispatchResult = latestDispatch;
        throw error;
      }
      return { delivered: true, result: latestDispatch };
    },
    observe: async ({ phase }) => {
      const candidate = await observeFresh(phase === 'resume_reconcile' ? 'reconcile' : 'post_dispatch');
      if (!candidate) return null;
      latestObservation = candidate.observation;
      latestFingerprint = candidate.fingerprint;
      await captureEvidence('afterAction', {
        actionAttemptId: `${actionOccurrenceId}:click:1`,
        observation: candidate.observation,
        resolution,
        dispatched: latestDispatch,
      });
      return candidate;
    },
    provePostcondition: async ({ observation, transaction }) => {
      const observed = observation?.data || null;
      if (!observed?.observation) {
        return { matched: null, checked: false, terminal: false, reason: 'fresh_click_observation_unavailable' };
      }
      const proof = await proveFresh({
        observed,
        dispatched: latestDispatch,
        phase: transaction.dispatchAttemptCount > 0 ? 'reconcile' : 'pre_dispatch',
        allowEffectProof: true,
      });
      lastProofRecord = proof.record || null;
      return {
        matched: proof.matched === true ? true : proof.record?.matched === false ? false : null,
        checked: proof.record?.checked === true || proof.matched === true,
        terminal: proof.matched === true,
        reason: proof.record?.reason || (proof.matched ? 'click_effect_proven' : 'click_effect_not_yet_proven'),
        evidence: proof.record || null,
      };
    },
  });
  diagnostics.transaction = safeTransactionForSeal(coordinated.transaction);
  const outcome = coordinated.outcome || coordinated.transaction?.canonicalOutcome || null;
  if (outcome?.status === 'passed') {
    return finish({
      status: 'pass',
      reason: outcome.reason || 'click_effect_proven',
      record: lastProofRecord || outcome.evidence || null,
    });
  }
  return finish({
    status: outcome?.outcomeKind === actionTransactionCoordinator.OUTCOME_KIND.FUNCTIONAL_FAILURE ? 'fail' : 'blocked',
    reason: outcome?.reason || (latestDispatch?.ok ? 'click_effect_not_proven' : 'click_dispatch_delivery_uncertain'),
    record: lastProofRecord || outcome?.evidence || null,
  });
}

module.exports = {
  STATES,
  compactFingerprint,
  decideDependencyScopedContinuation,
  executeGenericClick,
  parseAuthoredOptionClickIntent,
};
