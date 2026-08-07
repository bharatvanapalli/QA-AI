'use strict';

const pageFingerprint = require('./pageFingerprint');

const SCHEMA = 'qaai_wait_contract_v1';
const DEFAULT_TIMEOUTS = Object.freeze({ action: 10_000, assertion: 10_000, navigation: 20_000, stabilization: 5_000 });
const POLL_INTERVAL_MS = 250;
const STABLE_OBSERVATIONS = 2;
const WAIT_UTILITY_SCHEMA = 'qaai_wait_utility_v1';
const TYPED_WAIT_KINDS = Object.freeze([
  'url',
  'visible',
  'hidden',
  'enabled',
  'disabled',
  'text',
  'title',
  'pageState',
  'loadState',
  'duration',
]);

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function actionOf(step = {}) {
  return clean(step.action || step.type || step.kind || step.stepKind).toLowerCase();
}

function targetOf(step = {}) {
  return clean(step.element || step.target || step.field || step.locator_hint || step.locatorHint);
}

function operationCheckOf(step = {}) {
  return step.operationCheck || step.syncState || step.sync_state || null;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function ownValue(source, keys) {
  const record = objectValue(source);
  if (!record) return { found: false, value: undefined };
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return { found: true, value: record[key] };
  }
  return { found: false, value: undefined };
}

function finiteNumber(value, { minimum = 0, integer = true } = {}) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum) return null;
  return integer ? Math.floor(number) : number;
}

function normalizeRecovery(value) {
  if (typeof value === 'string') {
    const action = clean(value).toLowerCase();
    return action ? { action, maxAttempts: 1 } : null;
  }
  const record = objectValue(value);
  if (!record) return null;
  const action = clean(record.action || record.type || record.kind).toLowerCase();
  if (!action) return null;
  const maxAttempts = finiteNumber(record.maxAttempts, { minimum: 0 });
  const normalized = {
    ...record,
    action,
    maxAttempts: maxAttempts == null ? 1 : maxAttempts,
  };
  for (const key of ['retryAfterMs', 'timeoutMs']) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const number = finiteNumber(record[key], { minimum: 0 });
    if (number == null) delete normalized[key];
    else normalized[key] = number;
  }
  return normalized;
}

function canonicalWaitKind(value, source = {}) {
  const raw = clean(value).toLowerCase().replace(/[\s_-]+/g, '');
  if (/^(url|navigation|urlchange|urlpattern|urlorpagefingerprint)$/.test(raw)) return 'url';
  if (/^(hidden|detached|absent|notvisible)$/.test(raw)) return 'hidden';
  if (/^(disabled|readonly|noteditable)$/.test(raw)) return 'disabled';
  if (/visible|attached|present|displayed/.test(raw)) return 'visible';
  if (/enabled|actionable|editable/.test(raw)) return 'enabled';
  if (/^(text|textcontent|containstext|hastext)$/.test(raw)) return 'text';
  if (/^(title|pagetitle)$/.test(raw)) return 'title';
  if (/^(pagestate|domstate|state|stabilization|stable|pageready|fingerprintstable)$/.test(raw)) return 'pageState';
  if (/^(loadstate|load|domcontentloaded|networkidle|commit)$/.test(raw)) return 'loadState';
  if (/^(duration|timeout|delay|sleep|fixed)$/.test(raw)) return 'duration';
  const expected = objectValue(source.expected);
  if (expected && (expected.urlPattern || expected.url)) return 'url';
  if (source.durationMs != null || source.delayMs != null || source.sleepMs != null) return 'duration';
  if (source.loadState || source.waitUntil) return 'loadState';
  return clean(value || 'pageState') || 'pageState';
}

/**
 * Losslessly normalize an already executed wait contract for persistence/codegen.
 * This function never infers an executable wait from an authored plan. Its caller
 * must supply the contract attached to an executed occurrence.
 */
function normalizeTypedWaitContract(value, fallback = {}) {
  const primary = objectValue(value) || {};
  const defaults = objectValue(fallback) || {};
  const source = { ...defaults, ...primary };
  const condition = objectValue(source.condition);
  const expectedRecord = objectValue(source.expected);
  const kind = canonicalWaitKind(
    source.kind || source.type || source.state || source.effect || condition?.kind,
    source,
  );
  const defaultTimeout = kind === 'url' ? DEFAULT_TIMEOUTS.navigation : DEFAULT_TIMEOUTS.action;
  const timeoutMs = finiteNumber(source.timeoutMs ?? source.timeout, { minimum: 0 }) ?? defaultTimeout;
  const pollIntervalMs = finiteNumber(
    source.pollIntervalMs ?? source.pollMs ?? source.retryIntervalMs,
    { minimum: 1 },
  ) || POLL_INTERVAL_MS;
  const stableObservations = finiteNumber(source.stableObservations, { minimum: 1 }) || STABLE_OBSERVATIONS;
  const expected = source.expected
    ?? source.value
    ?? source.pattern
    ?? source.urlPattern
    ?? source.url
    ?? source.state
    ?? null;
  const normalized = {
    ...source,
    schema: source.schema || SCHEMA,
    kind,
    expected,
    timeoutMs,
    pollIntervalMs,
    stableObservations,
    armBeforeAction: source.armBeforeAction === true || kind === 'url',
  };
  const refreshAfterMs = finiteNumber(
    source.refreshAfterMs ?? source.reloadAfterMs,
    { minimum: 0 },
  );
  if (refreshAfterMs != null) normalized.refreshAfterMs = refreshAfterMs;
  const durationMs = finiteNumber(
    source.durationMs ?? source.delayMs ?? source.sleepMs
      ?? (kind === 'duration' ? expectedRecord?.durationMs ?? expected : null),
    { minimum: 0 },
  );
  if (durationMs != null) normalized.durationMs = durationMs;
  const recovery = normalizeRecovery(source.recovery);
  if (recovery) normalized.recovery = recovery;
  else if (Object.prototype.hasOwnProperty.call(source, 'recovery')) delete normalized.recovery;
  delete normalized.timeout;
  delete normalized.pollMs;
  delete normalized.reloadAfterMs;
  delete normalized.delayMs;
  delete normalized.sleepMs;
  return normalized;
}

function applyAuthoredWait(step, inferred) {
  const check = objectValue(operationCheckOf(step));
  const authored = objectValue(step && step.waitContract);
  const out = authored ? { ...inferred, ...authored } : { ...inferred };
  const authoredOrCheck = (keys) => {
    const direct = ownValue(authored, keys);
    return direct.found ? direct : ownValue(check, keys);
  };

  const timeout = authoredOrCheck(['timeoutMs', 'timeout']);
  if (timeout.found) {
    const timeoutMs = finiteNumber(timeout.value, { minimum: 0 });
    out.timeoutMs = timeoutMs == null ? inferred.timeoutMs : timeoutMs;
  }

  const poll = authoredOrCheck(['pollIntervalMs', 'pollMs']);
  if (poll.found) {
    const pollIntervalMs = finiteNumber(poll.value, { minimum: 1 });
    out.pollIntervalMs = pollIntervalMs == null ? inferred.pollIntervalMs : pollIntervalMs;
  }

  const stable = authoredOrCheck(['stableObservations']);
  if (stable.found) {
    const stableObservations = finiteNumber(stable.value, { minimum: 1 });
    out.stableObservations = stableObservations == null ? inferred.stableObservations : stableObservations;
  }

  const refresh = authoredOrCheck(['refreshAfterMs']);
  if (refresh.found) {
    const refreshAfterMs = finiteNumber(refresh.value, { minimum: 0 });
    if (refreshAfterMs == null) delete out.refreshAfterMs;
    else out.refreshAfterMs = refreshAfterMs;
  }

  const recovery = authoredOrCheck(['recovery']);
  if (recovery.found) {
    const normalized = normalizeRecovery(recovery.value);
    if (normalized) out.recovery = normalized;
    else delete out.recovery;
  }

  out.schema = SCHEMA;
  out.kind = clean(out.kind || inferred.kind || 'none').toLowerCase();
  delete out.timeout;
  delete out.pollMs;
  return out;
}

function expectedUrl(step = {}) {
  const check = operationCheckOf(step) || {};
  const condition = check.condition || {};
  return clean(
    step.expectedUrlPattern || step.urlPattern || condition.urlPattern || condition.expectedUrl
    || (/^https?:\/\//i.test(clean(step.value)) ? step.value : ''),
  ) || null;
}

function effectFromCheck(check = {}) {
  const source = check && typeof check === 'object' ? check : {};
  const kind = clean(source.kind || source.type).toLowerCase();
  if (/hidden|closed|dismissed/.test(kind)) return 'hidden';
  if (/enabled/.test(kind)) return 'enabled';
  if (/selected|selection/.test(kind)) return 'selected';
  if (/checked/.test(kind)) return 'checked';
  if (/dialog|modal/.test(kind)) return 'dialog';
  if (/toast|alert|message/.test(kind)) return 'toast';
  if (/table|row|record|count/.test(kind)) return 'table_change';
  if (/value/.test(kind)) return 'value_change';
  if (/visible|ready|present/.test(kind)) return 'visible';
  if (/url|navigation|destination/.test(kind)) return 'navigation';
  return null;
}

function buildWaitContract(step = {}) {
  const action = actionOf(step);
  const target = targetOf(step);
  const check = operationCheckOf(step);
  const urlPattern = expectedUrl(step);
  const base = {
    schema: SCHEMA,
    action,
    target: target || null,
    pollIntervalMs: POLL_INTERVAL_MS,
    stableObservations: STABLE_OBSERVATIONS,
    armBeforeAction: false,
    timeoutMs: DEFAULT_TIMEOUTS.action,
    expected: null,
    sensitive: /pass|pwd|secret|token|api[_ -]?key/i.test(target),
  };
  const finish = (contract) => applyAuthoredWait(step, contract);

  if (/download/.test(action) || /download/.test(clean(check && check.kind))) {
    return finish({ ...base, kind: 'event', armBeforeAction: true, timeoutMs: DEFAULT_TIMEOUTS.action, expected: { event: 'download' } });
  }
  if (/popup|new tab|new window/.test(action) || /popup/.test(clean(check && check.kind))) {
    return finish({ ...base, kind: 'event', armBeforeAction: true, timeoutMs: DEFAULT_TIMEOUTS.action, expected: { event: 'popup' } });
  }
  if (/navigate|goto|open url/.test(action)) {
    return finish({ ...base, kind: 'navigation', armBeforeAction: true, timeoutMs: DEFAULT_TIMEOUTS.navigation, expected: { readiness: 'domcontentloaded', urlPattern, fingerprint: step.expectedFingerprint || null } });
  }
  if (/fill|type|enter/.test(action)) {
    return finish({ ...base, kind: 'value', expected: { effect: 'value_exact', valueRef: step.dataRef || step.valueRef || step.dataBinding || null } });
  }
  if (/select|choose|pick/.test(action)) {
    return finish({ ...base, kind: 'selection', expected: { effect: 'selected', valueRef: step.dataRef || step.valueRef || step.dataBinding || null } });
  }
  if (/check|radio|toggle|switch/.test(action)) {
    return finish({ ...base, kind: 'checked', expected: { effect: 'checked', checked: step.checked !== false } });
  }
  if (/click|press|submit|tap/.test(action)) {
    const effect = urlPattern ? 'navigation' : (effectFromCheck(check) || 'fingerprint_change');
    return finish({
      ...base,
      kind: effect === 'navigation' ? 'navigation' : 'dom_effect',
      armBeforeAction: effect === 'navigation',
      timeoutMs: effect === 'navigation' ? DEFAULT_TIMEOUTS.navigation : DEFAULT_TIMEOUTS.action,
      expected: { effect, urlPattern, condition: check && check.condition || null },
    });
  }
  if (/assert|verify|validate|expect|confirm/.test(action) || step.kind === 'assertion') {
    return finish({ ...base, kind: 'assertion', timeoutMs: DEFAULT_TIMEOUTS.assertion, expected: { effect: effectFromCheck(check) || step.expectedKind || 'matched' } });
  }
  if (/wait/.test(action)) {
    return finish({ ...base, kind: 'stabilization', timeoutMs: DEFAULT_TIMEOUTS.stabilization, expected: { effect: effectFromCheck(check) || 'fingerprint_stable' } });
  }
  return finish({ ...base, kind: 'none', timeoutMs: 0, expected: { effect: 'not_applicable' } });
}

function isWaitForStateStep(step = {}) {
  const action = actionOf(step).replace(/[^a-z0-9]+/g, '');
  return ['wait', 'waitfor', 'waitforstate', 'waituntil', 'stabilize', 'stabilization', 'synchronize'].includes(action);
}

function attachWaitUtilitiesToSteps(steps = []) {
  const projected = (Array.isArray(steps) ? steps : []).map((step) => (
    step && typeof step === 'object' ? { ...step } : step
  ));
  const pendingWaitIndexes = [];
  for (let index = 0; index < projected.length; index += 1) {
    const step = projected[index];
    if (!step || typeof step !== 'object') continue;
    if (isWaitForStateStep(step)) {
      projected[index] = {
        ...step,
        runtimeUtility: true,
        executionRole: 'synchronization',
        emitsStepVerdict: false,
        verdictPolicy: 'none',
        waitContract: buildWaitContract(step),
        attachedToStepId: null,
      };
      pendingWaitIndexes.push(index);
      continue;
    }
    if (!pendingWaitIndexes.length) continue;
    const stepId = step.id || step.stepId || step.contractStepId || `step-${index + 1}`;
    const utilities = pendingWaitIndexes.map((waitIndex) => {
      const waitStep = projected[waitIndex];
      projected[waitIndex] = { ...waitStep, attachedToStepId: stepId };
      return {
        schema: WAIT_UTILITY_SCHEMA,
        waitStepId: waitStep.id || waitStep.stepId || waitStep.contractStepId || `wait-${waitIndex + 1}`,
        attachedToStepId: stepId,
        sourceQuote: waitStep.sourceQuote || null,
        sourceClauseRefs: Array.isArray(waitStep.sourceClauseRefs) ? [...waitStep.sourceClauseRefs] : [],
        waitContract: { ...(waitStep.waitContract || buildWaitContract(waitStep)) },
        emitsStepVerdict: false,
      };
    });
    projected[index] = {
      ...step,
      preconditionWaitUtilities: [
        ...(Array.isArray(step.preconditionWaitUtilities) ? step.preconditionWaitUtilities : []),
        ...utilities,
      ],
    };
    pendingWaitIndexes.length = 0;
  }
  return projected;
}

function urlMatches(actual, pattern) {
  if (!pattern) return true;
  const value = clean(actual);
  try {
    if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
      const end = pattern.lastIndexOf('/');
      return new RegExp(pattern.slice(1, end), pattern.slice(end + 1)).test(value);
    }
  } catch (_) {}
  const normalizedPattern = clean(pattern).replace(/^\*+|\*+$/g, '');
  return normalizedPattern ? value.toLowerCase().includes(normalizedPattern.toLowerCase()) : true;
}

function evaluate(contract, before = null, after = null) {
  const expected = contract && contract.expected || {};
  if (!contract || contract.kind === 'none') return { matched: true, reason: 'no_wait_required', observed: after };
  if (contract.kind === 'navigation') {
    const matched = urlMatches(after && after.url, expected.urlPattern)
      && (!expected.fingerprint || pageFingerprint.equivalent(expected.fingerprint, after && after.fingerprint || after));
    return { matched, reason: matched ? 'navigation_observed' : 'navigation_destination_not_observed', observed: after };
  }
  if (contract.kind === 'value') {
    const matched = after && after.valueConfirmed === true;
    return { matched, reason: matched ? 'value_readback_confirmed' : 'value_readback_not_confirmed', observed: contract.sensitive ? { valueConfirmed: !!(after && after.valueConfirmed) } : after };
  }
  if (contract.kind === 'selection') {
    const matched = after && (after.selected === true || after.selectionConfirmed === true);
    return { matched, reason: matched ? 'selection_confirmed' : 'selection_not_confirmed', observed: after };
  }
  if (contract.kind === 'checked') {
    const matched = after && after.checked === expected.checked;
    return { matched, reason: matched ? 'checked_state_confirmed' : 'checked_state_not_confirmed', observed: after };
  }
  if (contract.kind === 'event') {
    const matched = after && after.event === expected.event;
    return { matched, reason: matched ? `${expected.event}_observed` : `${expected.event}_not_observed`, observed: after };
  }
  if (contract.kind === 'dom_effect') {
    const effect = expected.effect;
    const explicit = after && (after.effect === effect || after.effects && after.effects.includes(effect));
    const fingerprintChanged = before && after && !pageFingerprint.equivalent(before.fingerprint || before, after.fingerprint || after);
    const matched = !!(explicit || (effect === 'fingerprint_change' && fingerprintChanged));
    return { matched, reason: matched ? `${effect}_observed` : `${effect}_not_observed`, observed: after };
  }
  if (contract.kind === 'stabilization') {
    const matched = before && after && pageFingerprint.equivalent(before.fingerprint || before, after.fingerprint || after);
    return { matched, reason: matched ? 'fingerprint_stable' : 'fingerprint_unstable', observed: after };
  }
  return { matched: after && after.matched === true, reason: after && after.matched === true ? 'assertion_matched' : 'assertion_not_matched', observed: after };
}

async function pollUntilStable({
  contract,
  observe,
  before = null,
  recover = null,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!contract || typeof observe !== 'function') throw new TypeError('contract and observe are required');
  const startedAt = now();
  const timeoutMs = finiteNumber(contract.timeoutMs, { minimum: 0 }) ?? 0;
  const deadline = startedAt + timeoutMs;
  const pollIntervalMs = finiteNumber(contract.pollIntervalMs || contract.pollMs, { minimum: 1 }) || POLL_INTERVAL_MS;
  const stableObservations = finiteNumber(contract.stableObservations, { minimum: 1 }) || STABLE_OBSERVATIONS;
  const recovery = normalizeRecovery(contract.recovery);
  const refreshAfterMs = finiteNumber(contract.refreshAfterMs, { minimum: 0 });
  const recoveryEnabled = typeof recover === 'function'
    && recovery
    && recovery.maxAttempts > 0
    && refreshAfterMs != null
    && refreshAfterMs < timeoutMs;
  const recoveryIntervalMs = recoveryEnabled
    ? finiteNumber(recovery.retryAfterMs, { minimum: 1 }) || Math.max(1, refreshAfterMs)
    : null;
  let nextRecoveryAt = recoveryEnabled ? startedAt + refreshAfterMs : null;
  let recoveryAttempts = 0;
  const recoveries = [];
  let consecutive = 0;
  let previous = null;
  let last = null;
  while (true) {
    last = await observe();
    const verdict = evaluate(contract, before, last);
    // Count consecutive semantic matches, not byte-identical observations.
    // Browser fingerprints intentionally carry volatile audit metadata such as
    // observedAt; comparing the whole observation made a stable page time out
    // with the contradictory reason `timeout:fingerprint_stable`.
    consecutive = verdict.matched ? consecutive + 1 : 0;
    if (consecutive >= stableObservations) {
      return {
        ...verdict,
        timedOut: false,
        observations: consecutive,
        durationMs: now() - startedAt,
        recoveryAttempts,
        recoveries,
      };
    }
    previous = last;
    const observedAt = now();
    if (observedAt >= deadline) break;

    if (recoveryEnabled
      && verdict.matched !== true
      && nextRecoveryAt != null
      && observedAt >= nextRecoveryAt
      && recoveryAttempts < recovery.maxAttempts) {
      const attempt = recoveryAttempts + 1;
      const remainingMs = Math.max(0, deadline - observedAt);
      const entry = {
        attempt,
        action: recovery.action,
        elapsedMs: observedAt - startedAt,
        remainingMs,
        outcome: 'succeeded',
      };
      try {
        const evidence = await recover({
          contract,
          recovery,
          attempt,
          elapsedMs: entry.elapsedMs,
          remainingMs,
          deadline,
          lastObservation: last,
          lastVerdict: verdict,
        });
        if (evidence !== undefined) entry.evidence = evidence;
      } catch (error) {
        entry.outcome = 'failed';
        entry.error = clean(error && error.message || error, 300) || 'recovery_failed';
      }
      recoveryAttempts = attempt;
      recoveries.push(entry);
      consecutive = 0;
      previous = null;
      nextRecoveryAt = recoveryAttempts < recovery.maxAttempts ? now() + recoveryIntervalMs : null;
      continue;
    }

    const current = now();
    const remainingMs = deadline - current;
    if (remainingMs <= 0) break;
    const untilRecoveryMs = nextRecoveryAt == null ? remainingMs : Math.max(0, nextRecoveryAt - current);
    const sleepMs = Math.min(pollIntervalMs, remainingMs, untilRecoveryMs || pollIntervalMs);
    await sleep(Math.max(1, sleepMs));
  }
  const verdict = evaluate(contract, before, last);
  return {
    ...verdict,
    matched: false,
    timedOut: true,
    reason: `timeout:${verdict.reason}`,
    observations: consecutive,
    durationMs: now() - startedAt,
    recoveryAttempts,
    recoveries,
  };
}

function createReloadRecoveryHandler({ reloadCurrentPage, onRecovery = null } = {}) {
  if (typeof reloadCurrentPage !== 'function') throw new TypeError('reloadCurrentPage is required');
  return async (context = {}) => {
    const recovery = normalizeRecovery(context.recovery || context.contract && context.contract.recovery);
    const action = clean(recovery && recovery.action).toLowerCase();
    if (!['reload', 'refresh', 'reload_page', 'refresh_page'].includes(action)) {
      throw new Error(`unsupported_wait_recovery_action:${action || 'missing'}`);
    }
    const remainingMs = finiteNumber(context.remainingMs, { minimum: 0 }) ?? 0;
    if (remainingMs <= 0) throw new Error('wait_recovery_budget_exhausted');
    const request = {
      action: 'reload',
      attempt: context.attempt || 1,
      timeoutMs: remainingMs,
      deadline: context.deadline || null,
      waitUntil: recovery.waitUntil || null,
      sameSession: true,
      contract: context.contract || null,
    };
    if (typeof onRecovery === 'function') await onRecovery({ phase: 'before', ...request });
    const result = await reloadCurrentPage(request);
    if (typeof onRecovery === 'function') await onRecovery({ phase: 'after', ...request, result });
    return { reloaded: true, sameSession: true, timeoutMs: remainingMs, result };
  };
}

async function pollWithAuthoredRecovery(options = {}) {
  const { reloadCurrentPage, onRecovery, recover, ...pollOptions } = options;
  const recoveryHandler = typeof recover === 'function'
    ? recover
    : typeof reloadCurrentPage === 'function'
      ? createReloadRecoveryHandler({ reloadCurrentPage, onRecovery })
      : null;
  return pollUntilStable({ ...pollOptions, recover: recoveryHandler });
}

module.exports = {
  SCHEMA,
  DEFAULT_TIMEOUTS,
  POLL_INTERVAL_MS,
  STABLE_OBSERVATIONS,
  WAIT_UTILITY_SCHEMA,
  TYPED_WAIT_KINDS,
  buildWaitContract,
  normalizeTypedWaitContract,
  isWaitForStateStep,
  attachWaitUtilitiesToSteps,
  createReloadRecoveryHandler,
  evaluate,
  pollUntilStable,
  pollWithAuthoredRecovery,
  urlMatches,
};
