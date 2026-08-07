'use strict';

const browserActionRegistry = require('./browserActionRegistry');

const SCHEMA = 'qaai_control_action_v1';
const MAX_RETRIES = 2;

const ACTION_KINDS = Object.freeze([
  'fill',
  'type',
  'select',
  'check',
  'uncheck',
  'radio',
  'hover',
  'press',
  'date',
  'scroll',
  'expand',
  'collapse',
]);

const IDEMPOTENCY_MODES = Object.freeze([
  'set_exact_value',
  'ensure_exact_state',
  'effect_bound',
  'non_idempotent',
]);

const RETRY_REASONS = Object.freeze([
  'stale_target',
  'dispatch_error',
  'postcondition_not_met',
  'target_detached',
]);

/**
 * @typedef {'fill'|'type'|'select'|'check'|'uncheck'|'radio'|'hover'|'press'|'date'|'scroll'|'expand'|'collapse'} ControlActionKind
 * @typedef {{
 *   label: string|null,
 *   roleHints: string[],
 *   tagHints: string[],
 *   scope: object|null,
 *   freshObservationRequired: boolean,
 *   unique: {count:number, sameElement:boolean},
 *   failClosed: boolean,
 * }} ControlResolutionInput
 * @typedef {{
 *   id: string,
 *   toolName: string,
 *   resolutionToolName: string|null,
 *   args: object,
 *   resolution: ControlResolutionInput|null,
 *   freshObservationRequired: boolean,
 *   allowUtilityDispatch?: boolean,
 *   branch?: string|null,
 *   semanticTarget?: object|null,
 * }} ControlDispatchPhase
 * @typedef {{
 *   mode: 'set_exact_value'|'ensure_exact_state'|'effect_bound'|'non_idempotent',
 *   expectedState: unknown,
 *   retrySafe: boolean,
 *   alreadySatisfiedIsSuccess: boolean,
 * }} ControlIdempotencyContract
 * @typedef {{
 *   kind: string,
 *   expected: unknown,
 *   exact: boolean,
 *   source: string,
 * }} ExactPostconditionContract
 * @typedef {{
 *   maxRetries: number,
 *   retryOn: string[],
 *   freshObservationBeforeRetry: boolean,
 *   reResolveBeforeRetry: boolean,
 *   backoffMs: number,
 * }} BoundedRetryPolicy
 * @typedef {{
 *   schema: string,
 *   kind: ControlActionKind,
 *   target: string|null,
 *   phases: ControlDispatchPhase[],
 *   idempotency: ControlIdempotencyContract,
 *   postcondition: ExactPostconditionContract,
 *   retryPolicy: BoundedRetryPolicy,
 *   waitContract: object,
 * }} ControlActionPlan
 */

function clean(value, max = 500) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeText(value) {
  return clean(value, 2000).toLocaleLowerCase();
}

function exactTextMatch(actual, expected) {
  return normalizeText(actual) === normalizeText(expected);
}

function finiteInteger(value, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function normalizeRetryPolicy(input = {}, defaults = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const baseline = defaults && typeof defaults === 'object' ? defaults : {};
  const retryOn = Array.isArray(source.retryOn)
    ? source.retryOn
    : Array.isArray(baseline.retryOn)
      ? baseline.retryOn
      : RETRY_REASONS;
  return {
    maxRetries: finiteInteger(source.maxRetries, finiteInteger(baseline.maxRetries, 1, 0, MAX_RETRIES), 0, MAX_RETRIES),
    retryOn: [...new Set(retryOn.map((item) => clean(item, 80)).filter(Boolean))],
    freshObservationBeforeRetry: source.freshObservationBeforeRetry !== false
      && baseline.freshObservationBeforeRetry !== false,
    reResolveBeforeRetry: source.reResolveBeforeRetry !== false
      && baseline.reResolveBeforeRetry !== false,
    backoffMs: finiteInteger(source.backoffMs, finiteInteger(baseline.backoffMs, 0, 0, 5_000), 0, 5_000),
  };
}

function buildResolutionInput({ label = null, roleHints = [], tagHints = [], scope = null, required = true } = {}) {
  if (!required) return null;
  return {
    label: clean(label, 240) || null,
    roleHints: [...new Set((roleHints || []).map((item) => clean(item, 80).toLowerCase()).filter(Boolean))],
    tagHints: [...new Set((tagHints || []).map((item) => clean(item, 80).toLowerCase()).filter(Boolean))],
    scope: scope && typeof scope === 'object' ? { ...scope } : null,
    freshObservationRequired: true,
    unique: { count: 1, sameElement: true },
    failClosed: true,
  };
}

function buildIdempotency({ mode, expectedState = null, retrySafe = false, alreadySatisfiedIsSuccess = true } = {}) {
  if (!IDEMPOTENCY_MODES.includes(mode)) throw new Error(`Unsupported idempotency mode: ${mode}`);
  return {
    mode,
    expectedState,
    retrySafe: retrySafe === true,
    alreadySatisfiedIsSuccess: alreadySatisfiedIsSuccess !== false,
  };
}

function buildPostcondition({ kind, expected = null, source = 'exact_target_readback' } = {}) {
  const normalizedKind = clean(kind, 120).toLowerCase();
  if (!normalizedKind) throw new Error('Control action postcondition kind is required.');
  return {
    kind: normalizedKind,
    expected,
    exact: true,
    source: clean(source, 120) || 'exact_target_readback',
  };
}

function registryIssueForPhase(phase) {
  if (!phase || typeof phase !== 'object') return 'dispatch phase must be an object';
  if (!clean(phase.id, 120)) return 'dispatch phase id is required';
  const entry = browserActionRegistry.getActionEntry(phase.toolName);
  if (!entry) return `dispatch tool is not registered: ${phase.toolName || '(missing)'}`;
  if (entry.kind === 'utility' && phase.allowUtilityDispatch !== true) {
    return `utility tool cannot dispatch this phase without an explicit adapter allowance: ${phase.toolName}`;
  }
  if (phase.resolution) {
    const resolutionTool = phase.resolutionToolName || phase.toolName;
    if (!browserActionRegistry.getActionEntry(resolutionTool)) {
      return `resolution tool is not registered: ${resolutionTool}`;
    }
    if (phase.resolution.unique?.count !== 1 || phase.resolution.unique?.sameElement !== true) {
      return `resolution must require count=1 and sameElement=true: ${phase.id}`;
    }
    if (phase.resolution.freshObservationRequired !== true || phase.resolution.failClosed !== true) {
      return `resolution must be fresh and fail closed: ${phase.id}`;
    }
  }
  return null;
}

function validateControlActionPlan(plan) {
  const issues = [];
  if (!plan || typeof plan !== 'object') return ['control action plan must be an object'];
  if (plan.schema !== SCHEMA) issues.push(`invalid schema: ${plan.schema || '(missing)'}`);
  if (!ACTION_KINDS.includes(plan.kind)) issues.push(`unsupported action kind: ${plan.kind || '(missing)'}`);
  if (!Array.isArray(plan.phases) || plan.phases.length === 0) issues.push('at least one dispatch phase is required');
  for (const phase of plan.phases || []) {
    const issue = registryIssueForPhase(phase);
    if (issue) issues.push(issue);
  }
  if (!plan.idempotency || !IDEMPOTENCY_MODES.includes(plan.idempotency.mode)) issues.push('valid idempotency contract is required');
  if (!plan.postcondition || plan.postcondition.exact !== true || !plan.postcondition.kind) issues.push('exact postcondition contract is required');
  if (!plan.retryPolicy || plan.retryPolicy.maxRetries < 0 || plan.retryPolicy.maxRetries > MAX_RETRIES) issues.push(`retry policy must be bounded to 0..${MAX_RETRIES}`);
  if (!plan.waitContract || typeof plan.waitContract !== 'object') issues.push('wait contract is required');
  return issues;
}

function assertControlActionPlan(plan) {
  const issues = validateControlActionPlan(plan);
  if (issues.length) throw new Error(`Invalid control action plan: ${issues.join('; ')}`);
  return plan;
}

function retryDecision({ plan, retryCount = 0, reason = 'postcondition_not_met', proof = null } = {}) {
  if (!plan || !plan.retryPolicy || !plan.idempotency) {
    return { retry: false, reason: 'missing_retry_contract' };
  }
  if (proof && proof.matched === true) return { retry: false, reason: 'postcondition_already_proven' };
  if (plan.idempotency.retrySafe !== true) return { retry: false, reason: 'action_not_retry_safe' };
  const used = finiteInteger(retryCount, 0, 0, MAX_RETRIES);
  if (used >= plan.retryPolicy.maxRetries) return { retry: false, reason: 'retry_budget_exhausted' };
  if (!plan.retryPolicy.retryOn.includes(reason)) return { retry: false, reason: 'reason_not_retryable' };
  return {
    retry: true,
    reason: 'bounded_retry_allowed',
    nextRetryCount: used + 1,
    freshObservationRequired: plan.retryPolicy.freshObservationBeforeRetry === true,
    reResolveRequired: plan.retryPolicy.reResolveBeforeRetry === true,
    backoffMs: plan.retryPolicy.backoffMs,
  };
}

module.exports = {
  SCHEMA,
  MAX_RETRIES,
  ACTION_KINDS,
  IDEMPOTENCY_MODES,
  RETRY_REASONS,
  clean,
  normalizeText,
  exactTextMatch,
  normalizeRetryPolicy,
  buildResolutionInput,
  buildIdempotency,
  buildPostcondition,
  validateControlActionPlan,
  assertControlActionPlan,
  retryDecision,
};
