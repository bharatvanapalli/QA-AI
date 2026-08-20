'use strict';

const {
  VERSION: PLAN_VERSION,
  validateTestDesignPlanV1,
  stableStringify,
  sha256,
  digestSensitiveLiteral,
  normalizeOracleKind,
} = require('./testDesignPlanV1');
const caseContractV1 = require('./caseContractV1');
const controlActionAdapter = require('./controlActionAdapter');
const inlineCaseInstanceContract = require('./inlineCaseInstanceContract');
const waitContract = require('./waitContract');

const VERSION = 'TestDesignStepCompilationV1';
const COMPILATION_ERROR_CODE = 'TEST_DESIGN_STEP_COMPILATION_FAILED';
const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*\}\}/g;
const SECRET_FIELD_RE = /(?:^|[^a-z0-9])(?:pass(?:word)?|pwd|secret|token|api[_ -]?key|credential|otp|mfa|pin)(?:$|[^a-z0-9])/i;

class TestDesignStepCompilationError extends Error {
  constructor(message, findings = [], report = null) {
    super(message);
    this.name = 'TestDesignStepCompilationError';
    this.code = COMPILATION_ERROR_CODE;
    this.status = 422;
    this.findings = Array.isArray(findings) ? findings : [];
    this.report = report;
  }
}

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function norm(value) {
  return clean(value).toLowerCase();
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(stableStringify(value));
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

function normalizeToken(value) {
  return clean(value)
    .replace(/^\{\{\s*/, '')
    .replace(/\s*\}\}$/, '')
    .replace(/^data\./i, '')
    .toLowerCase();
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    if (value == null || value === '') continue;
    const key = typeof value === 'string' ? value : stableStringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function tokensIn(value) {
  const text = String(value == null ? '' : value);
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = TOKEN_RE.exec(text)) !== null) out.push(normalizeToken(match[1]));
  return unique(out.filter(Boolean));
}

function stringsIn(value, path = [], out = []) {
  if (typeof value === 'string') {
    out.push({ path: path.join('.'), value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => stringsIn(entry, [...path, String(index)], out));
    return out;
  }
  if (value && typeof value === 'object') {
    Object.keys(value).forEach((key) => stringsIn(value[key], [...path, key], out));
  }
  return out;
}

function actionName(step) {
  return clean(step && (step.action || step.verb || step.actionType || step.type || step.kind));
}

function normalizedAction(step) {
  return norm(actionName(step)).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function isInputAction(step) {
  const action = normalizedAction(step);
  return /^(?:fill|type|enter|input|select|select_option|choose|pick|set_value)$/.test(action);
}

function isSingleTargetValueAction(step) {
  const action = normalizedAction(step);
  return /^(?:fill|type|enter|input|select|select_option|choose|pick|set_value|date|set_date|upload|set_files)$/.test(action);
}

function actionBucket(value) {
  const action = typeof value === 'object' ? normalizedAction(value) : norm(value).replace(/[^a-z0-9]+/g, '_');
  if (/^(?:fill|type|enter|input|set_value)$/.test(action)) return 'fill';
  if (/^(?:select|select_option|choose|pick)$/.test(action)) return 'select';
  if (/^(?:check|tick|checkbox)$/.test(action)) return 'check';
  if (/^(?:navigate|goto|go_to|open|visit)$/.test(action)) return 'navigate';
  if (/^(?:click|press|submit)$/.test(action)) return 'click';
  return action;
}

function validateActionTopology(caseObj, casePlan, findings) {
  const planned = (Array.isArray(casePlan && casePlan.actionTopology) ? casePlan.actionTopology : [])
    .map(actionBucket)
    .filter(Boolean);
  const steps = parseArray(caseObj && caseObj.steps);
  if (!steps.length) {
    findings.push({
      code: 'test_design_steps_missing',
      severity: 'error',
      planCaseId: casePlan.planCaseId,
      detail: 'The candidate emitted no executable steps for the planned case.',
    });
    return;
  }
  if (!planned.length) return;
  const actual = steps.filter((step) => !isAssertionStep(step)).map(actionBucket).filter(Boolean);
  if (stableStringify(actual) !== stableStringify(planned)) {
    findings.push({
      code: 'test_design_action_topology_drift',
      severity: 'error',
      planCaseId: casePlan.planCaseId,
      expected: planned,
      actual,
      detail: 'Candidate action order/count differs from the frozen pre-step case topology.',
    });
  }
}

function normalizedAuthoredStepDataRefs(step) {
  const explicitRefs = Array.isArray(step && step.dataRefs) ? step.dataRefs : [];
  return unique([
    ...explicitRefs.map(normalizeToken),
    ...stepValues(step).flatMap(tokensIn),
  ].filter(Boolean)).sort();
}

function normalizedDispatchedStepDataRefs(step) {
  // Candidate metadata is evidence, not the browser payload. Only placeholders
  // present in the value/input fields that the action dispatches can satisfy an
  // authored per-step binding. This prevents a model from declaring dataRefs
  // while sending a literal or a different token to the field.
  return unique(stepValues(step).flatMap(tokensIn).filter(Boolean)).sort();
}

function explicitDispatchValues(step) {
  const values = [];
  if (!step || typeof step !== 'object') return values;
  for (const key of ['value', 'input']) {
    if (Object.prototype.hasOwnProperty.call(step, key) && step[key] != null) values.push(step[key]);
  }
  if (Array.isArray(step.values)) values.push(...step.values);
  if (step.payload && typeof step.payload === 'object') {
    for (const key of ['value', 'input', 'text']) {
      if (Object.prototype.hasOwnProperty.call(step.payload, key) && step.payload[key] != null) {
        values.push(step.payload[key]);
      }
    }
  }
  return values.filter((value) => value != null).map(String);
}

function sensitiveTokensForCase(casePlan) {
  return new Set((Array.isArray(casePlan && casePlan.dataPlan && casePlan.dataPlan.bindings)
    ? casePlan.dataPlan.bindings
    : [])
    .filter((binding) => binding && binding.classification === 'sensitive')
    .map((binding) => normalizeToken(binding.token || binding.dataRef))
    .filter(Boolean));
}

function diagnosticStepSummary(step, { redact = false } = {}) {
  const explicitValues = explicitDispatchValues(step);
  return {
    stepId: clean(step && (step.id || step.stepId || step.contractStepId || step.caseContractStepId)) || null,
    action: actionName(step) || null,
    target: clean(stepTarget(step)) || null,
    text: redact ? '[redacted]' : (clean(step && step.text).slice(0, 240) || null),
    values: redact
      ? explicitValues.map(() => '[redacted]')
      : explicitValues.slice(0, 4).map((value) => clean(value).slice(0, 160)),
  };
}

function canonicalTargetIdentity(value) {
  return norm(value)
    .replace(/\b(?:field|input|box|dropdown|selector|button|link|option|control)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function targetsCompatible(authoredTarget, candidateTarget) {
  const authored = canonicalTargetIdentity(authoredTarget);
  const candidate = canonicalTargetIdentity(candidateTarget);
  if (!authored || !candidate) return true;
  return authored === candidate;
}

function inlineTokenProofs(casePlan, resolution) {
  const classificationByToken = new Map((Array.isArray(casePlan && casePlan.dataPlan && casePlan.dataPlan.bindings)
    ? casePlan.dataPlan.bindings
    : [])
    .map((binding) => [
      normalizeToken(binding && (binding.token || binding.dataRef)),
      binding && binding.classification === 'sensitive' ? 'sensitive' : 'normal',
    ]));
  const instances = Array.isArray(resolution && resolution.instances) ? resolution.instances : [];
  const proofs = new Map();
  for (const token of Array.isArray(resolution && resolution.executableTokens) ? resolution.executableTokens : []) {
    const values = unique(instances
      .filter((instance) => instance && instance.literalValues
        && Object.prototype.hasOwnProperty.call(instance.literalValues, token))
      .map((instance) => String(instance.literalValues[token])));
    proofs.set(token, {
      token,
      classification: classificationByToken.get(token) || 'normal',
      values,
    });
  }
  return proofs;
}

function provenInlineTokenForValue(value, expectedTokens, proofs) {
  if (value == null || typeof value === 'object') return null;
  const literal = String(value);
  if (!literal || tokensIn(literal).length || isSafeReference(literal)) return null;
  const matches = unique((expectedTokens || []).filter((token) => {
    const proof = proofs.get(token);
    return proof
      && proof.classification !== 'sensitive'
      && proof.values.length === 1
      && proof.values[0] === literal;
  }));
  return matches.length === 1 ? matches[0] : null;
}

function isLiteralBoundaryChar(value) {
  return value != null && /[a-zA-Z0-9_]/.test(String(value));
}

function boundarySafeLiteralOccurrences(text, literal) {
  const source = String(text == null ? '' : text);
  const needle = String(literal == null ? '' : literal);
  const occurrences = [];
  if (!source || !needle) return occurrences;
  let fromIndex = 0;
  while (fromIndex <= source.length - needle.length) {
    const index = source.indexOf(needle, fromIndex);
    if (index < 0) break;
    const before = index > 0 ? source[index - 1] : null;
    const afterIndex = index + needle.length;
    const after = afterIndex < source.length ? source[afterIndex] : null;
    const leftSafe = !isLiteralBoundaryChar(needle[0]) || !isLiteralBoundaryChar(before);
    const rightSafe = !isLiteralBoundaryChar(needle[needle.length - 1]) || !isLiteralBoundaryChar(after);
    if (leftSafe && rightSafe) occurrences.push({ index, end: afterIndex });
    fromIndex = index + Math.max(needle.length, 1);
  }
  return occurrences;
}

function canonicalizeInlineNarrative(value, expectedTokens, proofs) {
  if (typeof value !== 'string' || !value || tokensIn(value).length) return value;
  const candidatesByLiteral = new Map();
  for (const token of expectedTokens || []) {
    const proof = proofs.get(token);
    if (!proof || proof.classification === 'sensitive' || proof.values.length !== 1) continue;
    const literal = proof.values[0];
    const tokens = candidatesByLiteral.get(literal) || [];
    tokens.push(token);
    candidatesByLiteral.set(literal, tokens);
  }
  const replacements = [];
  for (const [literal, candidateTokens] of candidatesByLiteral.entries()) {
    // The same authored literal bound to two refs is not enough evidence to
    // choose either one. Leave it untouched so the normal drift check fails.
    if (unique(candidateTokens).length !== 1) continue;
    const token = candidateTokens[0];
    for (const occurrence of boundarySafeLiteralOccurrences(value, literal)) {
      replacements.push({ ...occurrence, literal, token });
    }
  }
  if (!replacements.length) return value;
  replacements.sort((a, b) => a.index - b.index || b.end - a.end);
  const selected = [];
  for (const replacement of replacements) {
    const overlap = selected.some((entry) => replacement.index < entry.end && replacement.end > entry.index);
    if (overlap) return value;
    selected.push(replacement);
  }
  let canonical = value;
  for (const replacement of selected.sort((a, b) => b.index - a.index)) {
    canonical = `${canonical.slice(0, replacement.index)}{{${replacement.token}}}${canonical.slice(replacement.end)}`;
  }
  return canonical;
}

function canonicalizeInlineDispatchValues(step, expectedTokens, proofs) {
  const canonical = clone(step && typeof step === 'object' ? step : { text: step });
  const replace = (value) => {
    const token = provenInlineTokenForValue(value, expectedTokens, proofs);
    return token ? `{{${token}}}` : value;
  };
  let hasExplicitDispatchValue = false;
  for (const key of ['value', 'input']) {
    if (canonical[key] == null) continue;
    hasExplicitDispatchValue = true;
    canonical[key] = replace(canonical[key]);
  }
  if (Array.isArray(canonical.values)) {
    hasExplicitDispatchValue = true;
    canonical.values = canonical.values.map(replace);
  }
  if (canonical.payload && typeof canonical.payload === 'object') {
    for (const key of ['value', 'input', 'text']) {
      if (canonical.payload[key] == null) continue;
      hasExplicitDispatchValue = true;
      canonical.payload[key] = key === 'text'
        ? canonicalizeInlineNarrative(canonical.payload[key], expectedTokens, proofs)
        : replace(canonical.payload[key]);
    }
  }
  if (!hasExplicitDispatchValue && isInputAction(canonical) && canonical.text != null) {
    canonical.text = canonicalizeInlineNarrative(canonical.text, expectedTokens, proofs);
  }
  return canonical;
}

// Add Scenario may truthfully emit the exact authored inline value instead of
// a model-facing {{token}}.  Convert only whole dispatched values that are
// proven by the same ordinal CaseContractV1 step and the process-local source
// authority.  No substring replacement, source-order guessing, or sensitive
// literal promotion is permitted.  The ordinary strict validators then run on
// this compiler-owned canonical form and the executable projection is restored
// to literals after validation.
function canonicalizeProvenInlineCandidate(caseObj, casePlan, proceduralFlowContract) {
  const canonical = clone(caseObj);
  const resolution = inlineLiteralResolution(casePlan, proceduralFlowContract);
  if (!resolution.applicable || !resolution.ok || !resolution.instances.length) {
    return { caseObj: canonical, resolution };
  }
  const contract = casePlan && casePlan.caseContractV1;
  const authoredSteps = Array.isArray(contract && contract.steps)
    ? contract.steps.filter((step) => !isAssertionStep(step))
    : [];
  const candidateSteps = parseArray(canonical && canonical.steps);
  const candidateActionIndexes = candidateSteps
    .map((step, index) => ({ step, index }))
    .filter((entry) => !isAssertionStep(entry.step));
  if (authoredSteps.length !== candidateActionIndexes.length) {
    return { caseObj: canonical, resolution };
  }
  const proofs = inlineTokenProofs(casePlan, resolution);
  authoredSteps.forEach((authoredStep, index) => {
    const expectedTokens = normalizedAuthoredStepDataRefs(authoredStep);
    if (!expectedTokens.length) return;
    const candidateIndex = candidateActionIndexes[index].index;
    candidateSteps[candidateIndex] = canonicalizeInlineDispatchValues(
      candidateSteps[candidateIndex],
      expectedTokens,
      proofs,
    );
  });
  canonical.steps = candidateSteps;
  return { caseObj: canonical, resolution };
}

function validateCaseContractStepDataBindings(caseObj, casePlan, findings) {
  const contract = casePlan && casePlan.caseContractV1;
  const authoredSteps = Array.isArray(contract && contract.steps)
    ? contract.steps.filter((step) => !isAssertionStep(step))
    : [];
  if (!authoredSteps.length) return;

  const candidateSteps = parseArray(caseObj && caseObj.steps)
    .filter((step) => !isAssertionStep(step));
  if (candidateSteps.length !== authoredSteps.length) return;

  authoredSteps.forEach((authoredStep, index) => {
    const candidateStep = candidateSteps[index];
    const expected = normalizedAuthoredStepDataRefs(authoredStep);
    const actual = normalizedDispatchedStepDataRefs(candidateStep);
    const explicitValues = explicitDispatchValues(candidateStep);
    const authoredExplicitValues = new Set(explicitDispatchValues(authoredStep));
    const unresolvedExplicitValues = explicitValues.filter((value) => (
      tokensIn(value).length === 0
      && !isSafeReference(value)
      && !authoredExplicitValues.has(value)
    ));
    const sensitiveTokens = sensitiveTokensForCase(casePlan);
    const redact = expected.some((token) => sensitiveTokens.has(token))
      || SECRET_FIELD_RE.test(`${stepTarget(authoredStep)} ${stepTarget(candidateStep)}`);
    const authoredTarget = authoredStepTarget(authoredStep);
    const candidateTarget = stepTarget(candidateStep);
    const authoredAction = actionName(authoredStep);
    const candidateAction = actionName(candidateStep);
    const ambiguousAuthoredValueBinding = isSingleTargetValueAction(authoredStep)
      && expected.length > 1
      && explicitValues.length <= 1;
    const unexpectedTokens = actual.filter((token) => !expected.includes(token));
    const missingTokens = actual.length ? expected.filter((token) => !actual.includes(token)) : [];
    let reason = null;
    let detail = null;

    if (ambiguousAuthoredValueBinding) {
      reason = 'authored_value_binding_ambiguous';
      detail = 'A single-target value action cannot be compiled from multiple competing authored data references.';
    } else if (authoredAction && candidateAction && actionBucket(authoredAction) !== actionBucket(candidateAction)) {
      reason = 'candidate_action_contradicts_authored_step';
      detail = 'Candidate action contradicts the action authorized by the authored CaseContractV1 step.';
    } else if (!targetsCompatible(authoredTarget, candidateTarget)) {
      reason = 'candidate_target_contradicts_authored_step';
      detail = 'Candidate target contradicts the explicit target in the authored CaseContractV1 step.';
    } else if (unexpectedTokens.length || missingTokens.length) {
      reason = unexpectedTokens.length
        ? 'candidate_uses_unauthorized_data_reference'
        : 'candidate_data_reference_set_incomplete';
      detail = 'Candidate dispatch payload contradicts the data references authorized for this authored step.';
    } else if (unresolvedExplicitValues.length) {
      reason = expected.length
        ? 'candidate_explicit_value_not_authorized'
        : 'candidate_introduced_unplanned_value';
      detail = expected.length
        ? 'Candidate supplied an explicit value that could not be proven from this step\'s authored data references.'
        : 'Candidate introduced an explicit value for a step that has no authored data binding.';
    }

    // Absence is not drift: the immutable contract supplies the binding during
    // compilation. Candidate metadata is allowed to omit values and dataRefs,
    // but it may never contradict the authored contract.
    if (!reason) return;
    const stepOrdinal = Number(authoredStep && authoredStep.ordinal) || index + 1;
    findings.push({
      code: 'test_design_step_data_binding_drift',
      severity: 'error',
      planCaseId: casePlan.planCaseId,
      stepOrdinal,
      contractStepId: clean(authoredStep && (authoredStep.id || authoredStep.stepId)) || null,
      expectedDataRefs: expected.map((token) => `data.${token}`),
      actualDataRefs: actual.map((token) => `data.${token}`),
      observedValues: redact
        ? unresolvedExplicitValues.map(() => '[redacted]')
        : unresolvedExplicitValues.slice(0, 4).map((value) => clean(value).slice(0, 160)),
      authoredStep: diagnosticStepSummary(authoredStep, { redact }),
      candidateStep: diagnosticStepSummary(candidateStep, { redact }),
      resolutionDecision: 'rejected_candidate_contradiction',
      reason,
      detail,
      message: `Step ${stepOrdinal} rejected: ${detail}`,
    });
  });
}

function stepTarget(step) {
  const explicit = clean(step && (step.target || step.element || step.field || step.label || step.locatorHint || step.locator_hint));
  if (explicit) return explicit;
  const identity = step && step.targetIdentity;
  if (!identity || typeof identity !== 'object') return '';
  return clean(identity.label || identity.accessibleName || identity.name || identity.text || identity.testId);
}

function authoredStepTarget(step) {
  const explicit = stepTarget(step);
  if (explicit) return explicit;
  const text = clean(step && step.text);
  if (!text) return '';
  const action = actionName(step);
  const url = (text.match(/https?:\/\/[^\s),.;]+|\/[^\s),.;]+/) || [])[0];
  const inputTarget = (text.match(/\b(?:in|into|for)\s+(?:the\s+)?(.+?)(?:\s+(?:field|input|box|dropdown|selector)\b|[.;]|$)/i) || [])[1];
  const clickTarget = text
    .replace(/^\s*(?:click|press|tap|choose|check|select|hover(?:\s+over)?)\s+/i, '')
    .replace(/[.;]\s*$/, '')
    .trim();
  const assertionTarget = text
    .replace(/^\s*(?:verify|assert|expect)(?:\s+that)?\s+/i, '')
    .replace(/\s+(?:is\s+)?(?:visible|shown|displayed|hidden|absent|not\s+visible)\.?$/i, '')
    .replace(/[.;]\s*$/, '')
    .trim();
  if (/^navigate$/i.test(action)) return clean(url || text);
  if (/^(?:fill|type|select)$/i.test(action)) return clean(inputTarget || clickTarget || text);
  if (/^assert/i.test(action)) return clean(assertionTarget || text);
  return clean(clickTarget || text);
}

function stepValues(step) {
  const values = [];
  if (!step || typeof step !== 'object') return values;
  for (const key of ['value', 'input']) {
    if (step[key] != null) values.push(step[key]);
  }
  if (Array.isArray(step.values)) values.push(...step.values);
  if (step.payload && typeof step.payload === 'object') {
    for (const key of ['value', 'input', 'text']) {
      if (step.payload[key] != null) values.push(step.payload[key]);
    }
  }
  if (!values.length && isInputAction(step) && step.text != null) values.push(step.text);
  return values.filter((value) => value != null).map(String);
}

function isSafeReference(value) {
  const text = clean(value);
  return /\{\{\s*[a-zA-Z_][a-zA-Z0-9_.-]*\s*\}\}/.test(text)
    || /^\$[A-Z_][A-Z0-9_]*$/.test(text)
    || /^env:[A-Z_][A-Z0-9_]*$/i.test(text)
    || /^vault:[a-zA-Z0-9_.:/-]+$/i.test(text)
    || /^fixture:[a-zA-Z0-9_.:/-]+$/i.test(text)
    || /^process\.env\.[A-Z_][A-Z0-9_]*$/i.test(text);
}

function planCases(plan) {
  const out = [];
  for (const scenario of Array.isArray(plan && plan.scenarios) ? plan.scenarios : []) {
    for (const casePlan of Array.isArray(scenario && scenario.cases) ? scenario.cases : []) {
      out.push({ scenario, casePlan });
    }
  }
  return out;
}

function candidateInventory({ candidateScenarios, scenarios, candidateCases, cases } = {}) {
  const sourceScenarios = Array.isArray(candidateScenarios)
    ? candidateScenarios
    : (Array.isArray(scenarios) ? scenarios : []);
  const sourceCases = Array.isArray(candidateCases)
    ? candidateCases
    : (Array.isArray(cases) ? cases : []);
  const out = [];
  if (sourceScenarios.length) {
    for (const [scenarioIndex, scenario] of sourceScenarios.entries()) {
      if (scenario && Array.isArray(scenario.cases)) {
        for (const [caseIndex, caseObj] of scenario.cases.entries()) {
          out.push({ scenario, scenarioIndex, caseObj, caseIndex });
        }
      } else if (scenario && typeof scenario === 'object') {
        out.push({ scenario: null, scenarioIndex, caseObj: scenario, caseIndex: 0 });
      }
    }
  } else {
    sourceCases.forEach((caseObj, caseIndex) => out.push({ scenario: null, scenarioIndex: 0, caseObj, caseIndex }));
  }
  return out;
}

function channelFromValue(value) {
  const raw = norm(value).replace(/[^a-z0-9]+/g, '_');
  const compact = raw.replace(/_/g, '');
  if (!raw) return null;
  if (compact.includes('url') || compact.includes('destination')) return 'url';
  if (compact.includes('number') || compact.includes('numeric') || compact.includes('count')) return 'number';
  if (compact.includes('hidden') || compact.includes('invisible')) return 'hidden';
  if (compact.includes('visible') || compact.includes('visibility')) return 'visible';
  if (compact.includes('validation') || compact.includes('errormessage')) return 'validation_message';
  if (compact.includes('selected')) return 'selected';
  if (compact.includes('checked')) return 'checked';
  if (compact.includes('value')) return 'value';
  if (compact.includes('popup')) return 'popup';
  if (compact.includes('download')) return 'download';
  if (compact.includes('text') || compact.includes('content') || compact.includes('message')) return 'text';
  if (compact.includes('statechange') || compact === 'state') return 'state_change';
  const normalized = normalizeOracleKind(raw);
  return normalized && normalized !== 'state_change' ? normalized : (raw === 'state_change' ? 'state_change' : null);
}

function channelFromAssertion(assertion) {
  if (!assertion || typeof assertion !== 'object') return null;
  const payload = assertion.payload && typeof assertion.payload === 'object' ? assertion.payload : {};
  if (payload.expectedUrlPattern != null || payload.expectedUrl != null) return 'url';
  if (payload.expectedNumber != null) return 'number';
  if (payload.expectedVisible != null) return payload.expectedVisible === false ? 'hidden' : 'visible';
  if (payload.expectedHidden != null) return payload.expectedHidden === false ? 'visible' : 'hidden';
  if (payload.expectedText != null) return 'text';
  const verify = assertion.verify && typeof assertion.verify === 'object' ? assertion.verify : {};
  for (const value of [payload.channel, assertion.channel, assertion.kind, assertion.type, assertion.assertionType, assertion.actionType, assertion.action, verify.kind, verify.type]) {
    const channel = channelFromValue(value);
    if (channel) return channel;
  }
  return null;
}

function isAssertionStep(step) {
  const action = normalizedAction(step);
  return /^(?:assert|verify|expect)(?:_|$)/.test(action)
    || /^assert(?:url|text|number|visible|hidden|value|selected|checked)$/i.test(action.replace(/_/g, ''))
    || norm(step && step.kind) === 'assertion';
}

function assertionTarget(assertion) {
  const explicit = clean(assertion && (assertion.target || assertion.label || assertion.element || assertion.field));
  if (explicit) return explicit;
  const identity = assertion && assertion.targetIdentity;
  return clean(identity && (identity.label || identity.accessibleName || identity.name || identity.text || identity.testId));
}

function assertionExpected(assertion) {
  if (!assertion || typeof assertion !== 'object') return undefined;
  if (assertion.expected !== undefined) return assertion.expected;
  const payload = assertion.payload && typeof assertion.payload === 'object' ? assertion.payload : {};
  for (const key of ['expectedUrlPattern', 'expectedUrl', 'expectedText', 'expectedNumber', 'expectedValue', 'expectedItems', 'expectedValues', 'expectedVisible', 'expectedHidden', 'value', 'text']) {
    if (payload[key] !== undefined) return payload[key];
  }
  const expectedOperand = Array.isArray(payload.operands)
    ? payload.operands.find((operand) => operand && operand.role === 'expected')
    : null;
  if (expectedOperand) {
    for (const key of ['value', 'items', 'ref', 'property']) {
      if (expectedOperand[key] !== undefined) return expectedOperand[key];
    }
  }
  if (assertion.verify && assertion.verify.expected !== undefined) return assertion.verify.expected;
  return undefined;
}

function assertionEntries(caseObj) {
  const rows = [];
  parseArray(caseObj && caseObj.declaredAssertions).forEach((assertion, index) => {
    if (assertion && typeof assertion === 'object') rows.push({ assertion, source: 'declaredAssertions', index, channel: channelFromAssertion(assertion) });
  });
  parseArray(caseObj && caseObj.oracles).forEach((assertion, index) => {
    if (assertion && typeof assertion === 'object') rows.push({ assertion, source: 'oracles', index, channel: channelFromAssertion(assertion) });
  });
  parseArray(caseObj && caseObj.steps).forEach((step, index) => {
    if (step && typeof step === 'object' && isAssertionStep(step)) rows.push({ assertion: step, source: 'steps', index, channel: channelFromAssertion(step) });
  });
  const deduped = new Map();
  for (const row of rows) {
    const ref = clean(row.assertion.oracleRef || row.assertion.id);
    const key = ref
      ? `ref:${ref}:${row.channel || 'unknown'}`
      : stableStringify({ channel: row.channel, target: assertionTarget(row.assertion), expected: assertionExpected(row.assertion) });
    if (!deduped.has(key) || (deduped.get(key).source !== 'declaredAssertions' && row.source === 'declaredAssertions')) deduped.set(key, row);
  }
  return Array.from(deduped.values());
}

function allowedTokensFor(casePlan) {
  const dataPlan = casePlan && casePlan.dataPlan || {};
  return new Set(unique([
    ...(Array.isArray(dataPlan.allowedTokens) ? dataPlan.allowedTokens : []),
    ...(Array.isArray(dataPlan.bindings) ? dataPlan.bindings.flatMap((binding) => [binding && binding.token, binding && binding.dataRef]) : []),
    ...(Array.isArray(casePlan && casePlan.oracles) ? casePlan.oracles.flatMap((oracle) => [oracle && oracle.token, oracle && oracle.dataRef]) : []),
  ]).map(normalizeToken).filter(Boolean));
}

function validateTokens(caseObj, casePlan, findings) {
  const allowed = allowedTokensFor(casePlan);
  const surfaces = [
    ...parseArray(caseObj && caseObj.steps).map((value, index) => ({ source: 'step', index: index + 1, value })),
    ...parseArray(caseObj && caseObj.declaredAssertions).map((value, index) => ({ source: 'assertion', index: index + 1, value })),
    ...parseArray(caseObj && caseObj.oracles).map((value, index) => ({ source: 'oracle', index: index + 1, value })),
  ];
  for (const surface of surfaces) {
    for (const entry of stringsIn(surface.value)) {
      for (const token of tokensIn(entry.value)) {
        if (!allowed.has(token)) {
          findings.push({
            code: 'test_design_unknown_token',
            severity: 'error',
            planCaseId: casePlan.planCaseId,
            source: surface.source,
            ordinal: surface.index,
            path: entry.path,
            token,
            detail: `{{${token}}} is not declared by the immutable data/oracle plan.`,
          });
        }
      }
    }
  }
}

function validateSensitiveLiterals(caseObj, casePlan, findings) {
  const dataPlan = casePlan && casePlan.dataPlan || {};
  const forbidden = new Set(Array.isArray(dataPlan.sensitiveLiteralDigests) ? dataPlan.sensitiveLiteralDigests : []);
  for (const [index, step] of parseArray(caseObj && caseObj.steps).entries()) {
    if (!isInputAction(step)) continue;
    const target = stepTarget(step);
    for (const value of stepValues(step)) {
      if (!clean(value) || isSafeReference(value)) continue;
      const digest = digestSensitiveLiteral(value, dataPlan.workbookHash);
      if (forbidden.has(digest) || SECRET_FIELD_RE.test(` ${target} `)) {
        findings.push({
          code: 'test_design_sensitive_literal',
          severity: 'error',
          planCaseId: casePlan.planCaseId,
          stepOrdinal: index + 1,
          field: target || null,
          detail: 'A sensitive input is a raw literal; use the plan token or an environment/credential reference.',
        });
      }
    }
  }
  const assertionSurfaces = [
    ...parseArray(caseObj && caseObj.declaredAssertions),
    ...parseArray(caseObj && caseObj.oracles),
  ];
  assertionSurfaces.forEach((assertion, index) => {
    const expected = assertionExpected(assertion);
    if (expected == null || typeof expected === 'object' || isSafeReference(expected)) return;
    if (forbidden.has(digestSensitiveLiteral(expected, dataPlan.workbookHash))) {
      findings.push({
        code: 'test_design_sensitive_literal',
        severity: 'error',
        planCaseId: casePlan.planCaseId,
        assertionOrdinal: index + 1,
        detail: 'An assertion contains a raw sensitive workbook value.',
      });
    }
  });
}

function validateAssertionChannels(caseObj, casePlan, findings) {
  const planned = Array.isArray(casePlan && casePlan.oracles) ? casePlan.oracles : [];
  const candidates = assertionEntries(caseObj);
  const used = new Set();
  const matches = new Map();
  const plannedChannels = new Set(planned.map((oracle) => normalizeOracleKind(oracle.kind)));

  for (const oracle of planned) {
    const expectedChannel = normalizeOracleKind(oracle.kind);
    const exactIndex = candidates.findIndex((candidate, index) => (
      !used.has(index)
      && clean(candidate.assertion.oracleRef || candidate.assertion.id) === clean(oracle.oracleRef)
    ));
    if (exactIndex >= 0) {
      const candidate = candidates[exactIndex];
      used.add(exactIndex);
      if (candidate.channel !== expectedChannel) {
        findings.push({
          code: 'test_design_assertion_channel_drift',
          severity: 'error',
          planCaseId: casePlan.planCaseId,
          oracleRef: oracle.oracleRef,
          expectedChannel,
          actualChannel: candidate.channel || 'unknown',
          detail: 'A planned assertion may not be compiled through a different semantic channel.',
        });
      } else {
        matches.set(oracle.oracleRef, candidate);
      }
      continue;
    }
    const channelIndex = candidates.findIndex((candidate, index) => !used.has(index) && candidate.channel === expectedChannel);
    if (channelIndex >= 0) {
      used.add(channelIndex);
      matches.set(oracle.oracleRef, candidates[channelIndex]);
      continue;
    }
    if (oracle.required !== false) {
      const actualChannels = unique(candidates.filter((_, index) => !used.has(index)).map((candidate) => candidate.channel).filter(Boolean));
      findings.push({
        code: actualChannels.length ? 'test_design_assertion_channel_drift' : 'test_design_required_assertion_missing',
        severity: 'error',
        planCaseId: casePlan.planCaseId,
        oracleRef: oracle.oracleRef,
        expectedChannel,
        actualChannels,
        detail: actualChannels.length
          ? 'The candidate has assertions, but none uses the planned semantic channel.'
          : 'The candidate omitted a required planned assertion.',
      });
    }
  }

  for (const [index, candidate] of candidates.entries()) {
    if (used.has(index) || !candidate.channel) continue;
    const assertion = candidate.assertion || {};
    const payload = assertion.payload && typeof assertion.payload === 'object' ? assertion.payload : {};
    const projectedValue = payload.expectedText != null ? payload.expectedText : payload.unexpectedText;
    const isServerOwnedLegacyProjection = candidate.source === 'declaredAssertions'
      && norm(assertion.provenance) === 'case_contract_pack'
      && candidate.channel === 'text'
      && planned.some((oracle) => {
        const channel = normalizeOracleKind(oracle.kind);
        if (!['number', 'visible', 'hidden'].includes(channel) || !matches.has(oracle.oracleRef)) return false;
        const semanticValue = channel === 'number'
          ? oracle.expected
          : (oracle.target == null ? oracle.expected : oracle.target);
        return norm(projectedValue) === norm(semanticValue);
      });
    // The deterministic CaseContract helper retains a legacy TEXT/FORBIDDEN_TEXT
    // verdict projection for older consumers while also emitting the authored
    // typed assertion step. Once that typed step matched the immutable oracle,
    // discard only the equivalent server-owned projection; never let it turn a
    // visible/hidden/number oracle into a text assertion.
    if (isServerOwnedLegacyProjection) continue;
    const explicitRef = clean(candidate.assertion.oracleRef);
    if (explicitRef || !plannedChannels.has(candidate.channel)) {
      findings.push({
        code: 'test_design_unplanned_assertion_channel',
        severity: 'error',
        planCaseId: casePlan.planCaseId,
        oracleRef: explicitRef || null,
        actualChannel: candidate.channel,
        detail: 'The candidate introduced an assertion channel that is not in the design plan.',
      });
    }
  }
  return matches;
}

function assertionTypeFor(channel) {
  const types = {
    url: 'URL',
    text: 'TEXT',
    validation_message: 'TEXT',
    number: 'NUMBER',
    visible: 'VISIBLE',
    hidden: 'HIDDEN',
    value: 'VALUE',
    selected: 'SELECTED',
    checked: 'CHECKED',
    popup: 'POPUP',
    download: 'DOWNLOAD',
    state_change: 'STATE_CHANGE',
  };
  return types[channel] || channel.toUpperCase();
}

function payloadForOracle(oracle, basePayload) {
  const payload = {
    ...(basePayload && typeof basePayload === 'object' ? clone(basePayload) : {}),
    ...(oracle && oracle.payload && typeof oracle.payload === 'object' ? clone(oracle.payload) : {}),
  };
  for (const key of ['expectedUrlPattern', 'expectedUrl', 'expectedText', 'expectedNumber', 'expectedValue', 'expectedVisible', 'expectedHidden']) delete payload[key];
  const channel = normalizeOracleKind(oracle.kind);
  if (channel === 'url' && oracle.expected != null) payload.expectedUrlPattern = clone(oracle.expected);
  else if ((channel === 'text' || channel === 'validation_message') && oracle.expected != null) payload.expectedText = clone(oracle.expected);
  else if (channel === 'number' && oracle.expected != null) payload.expectedNumber = clone(oracle.expected);
  else if (channel === 'visible') payload.expectedVisible = oracle.expected !== false;
  else if (channel === 'hidden') payload.expectedHidden = oracle.expected !== false;
  else if (channel === 'collection' && oracle.expected != null && payload.expectedItems == null) payload.expectedItems = clone(oracle.expected);
  else if (oracle.expected != null) payload.expectedValue = clone(oracle.expected);
  return payload;
}

function canonicalAssertions(casePlan, matches) {
  const authoredById = new Map((Array.isArray(casePlan?.caseContractV1?.assertions)
    ? casePlan.caseContractV1.assertions
    : []).map((assertion) => [clean(assertion && assertion.id), assertion]));
  return (Array.isArray(casePlan.oracles) ? casePlan.oracles : []).map((oracle) => {
    const matched = matches.get(oracle.oracleRef);
    const base = matched && matched.source === 'declaredAssertions' ? clone(matched.assertion) : {};
    const channel = normalizeOracleKind(oracle.kind);
    const authored = authoredById.get(clean(oracle.oracleRef)) || null;
    const payload = payloadForOracle(oracle, base.payload);
    if (payload && typeof payload === 'object' && payload.target == null && oracle.target != null) {
      payload.target = clone(oracle.target);
    }
    if (authored && payload && typeof payload === 'object') {
      if (authored.comparator != null) payload.comparator = clone(authored.comparator);
      if (Array.isArray(authored.payload?.operands)) payload.operands = clone(authored.payload.operands);
      if (authored.type === 'AssertEnabled') payload.expectedEnabled = true;
      if (authored.type === 'AssertDisabled') payload.expectedEnabled = false;
    }
    return {
      ...base,
      id: clean(base.id) || oracle.oracleRef,
      oracleRef: oracle.oracleRef,
      kind: channel,
      channel,
      type: assertionTypeFor(channel),
      target: clone(oracle.target),
      expected: clone(oracle.expected),
      required: oracle.required !== false,
      payload,
      semanticType: authored ? authored.type : null,
      comparator: authored ? clone(authored.comparator) : null,
      semanticPayload: authored ? clone(authored.payload) : null,
      targetIdentity: authored ? clone(authored.targetIdentity) : null,
      sourceQuote: authored ? clean(authored.sourceQuote) || null : null,
      sourceSpan: authored ? clone(authored.sourceSpan || null) : null,
      sourceClauseRefs: authored ? clone(authored.sourceClauseRefs || []) : [],
      dataRefs: authored ? clone(authored.dataRefs || []) : clone(base.dataRefs || []),
      failureBehavior: authored ? clone(authored.failureBehavior) : null,
      stepId: authored ? clone(authored.stepId) : null,
    };
  });
}

const AUTHORED_CONTROL_METADATA = Object.freeze({
  date: ['value', 'date', 'controlKind', 'widgetKind', 'dateKind', 'variant', 'inputType'],
  scroll: ['scrollMode', 'boundary', 'direction', 'deltaX', 'deltaY', 'visibilityThreshold'],
  radio: ['value', 'checked', 'idempotent'],
  expand: ['idempotent', 'expectedState'],
  collapse: ['idempotent', 'expectedState'],
});

function projectAuthoredControlMetadata(projected, authoredStep) {
  const controlKind = controlActionAdapter.actionKind(authoredStep);
  const keys = AUTHORED_CONTROL_METADATA[controlKind] || [];
  for (const key of keys) {
    if (authoredStep && authoredStep[key] !== undefined) {
      projected[key] = clone(authoredStep[key]);
    }
  }
  return projected;
}

function compileSteps(caseObj, casePlan) {
  const candidateSteps = parseArray(caseObj && caseObj.steps);
  const authoredSteps = Array.isArray(casePlan && casePlan.caseContractV1 && casePlan.caseContractV1.steps)
    ? casePlan.caseContractV1.steps
    : [];
  if (!authoredSteps.length) {
    return waitContract.attachWaitUtilitiesToSteps(candidateSteps.map((rawStep, index) => {
      const step = clone(rawStep && typeof rawStep === 'object' ? rawStep : { text: rawStep });
      const tokens = unique(stringsIn(step).flatMap((entry) => tokensIn(entry.value)));
      const ordinal = index + 1;
      return {
        ...step,
        id: clean(step.id || step.stepId || step.contractStepId)
          || `${casePlan.planCaseId}_step_${String(ordinal).padStart(3, '0')}`,
        ordinal,
        dataRefs: tokens.map((token) => `data.${token}`),
      };
    }));
  }

  const candidateActions = candidateSteps.filter((step) => !isAssertionStep(step));
  const candidateAssertions = candidateSteps.filter((step) => isAssertionStep(step));
  let actionIndex = 0;
  let assertionIndex = 0;
  return waitContract.attachWaitUtilitiesToSteps(authoredSteps.map((rawAuthoredStep, index) => {
    const authoredStep = clone(rawAuthoredStep && typeof rawAuthoredStep === 'object'
      ? rawAuthoredStep
      : { text: rawAuthoredStep });
    const assertion = isAssertionStep(authoredStep);
    const rawCandidateStep = assertion
      ? candidateAssertions[assertionIndex++]
      : candidateActions[actionIndex++];
    const candidateStep = clone(rawCandidateStep && typeof rawCandidateStep === 'object'
      ? rawCandidateStep
      : {});
    const ordinal = Number(authoredStep.ordinal) || index + 1;
    const authoredAction = actionName(authoredStep) || actionName(candidateStep) || 'Click';
    const authoredTarget = authoredStepTarget(authoredStep);
    const tokens = normalizedAuthoredStepDataRefs(authoredStep);
    const dataRefs = tokens.map((token) => `data.${token}`);
    const stableStepId = clean(authoredStep.id || authoredStep.stepId || authoredStep.contractStepId)
      || `${casePlan.planCaseId}_step_${String(ordinal).padStart(3, '0')}`;
    const projected = {
      ...candidateStep,
      id: stableStepId,
      caseContractStepId: stableStepId,
      ordinal,
      order: ordinal,
      action: authoredAction,
      type: authoredAction,
      text: clean(authoredStep.text) || clean(candidateStep.text),
      dataRefs,
    };
    if (authoredTarget) {
      projected.target = authoredTarget;
      projected.element = authoredTarget;
    }
    for (const key of [
      'dependsOn', 'failureBehavior', 'flowImpact', 'expected', 'expectedState',
      'targetIdentity', 'selectionCriteria', 'value', 'valueRef', 'values', 'comparator', 'payload',
      'expectedItems', 'expectedValues', 'orderMatters', 'operands', 'relation',
      'sourceQuote', 'sourceSpan', 'sourceClauseRefs', 'postcondition', 'waitContract',
    ]) {
      if (authoredStep[key] !== undefined) projected[key] = clone(authoredStep[key]);
    }
    projectAuthoredControlMetadata(projected, authoredStep);
    if (isInputAction(authoredStep) && tokens.length === 1
      && !Object.prototype.hasOwnProperty.call(authoredStep, 'value')) {
      projected.value = `{{${tokens[0]}}}`;
    }
    return projected;
  }));
}

function inlineLiteralResolution(casePlan, proceduralFlowContract) {
  const dataPlan = casePlan && casePlan.dataPlan;
  if (!dataPlan || dataPlan.mode !== 'inline') {
    return { applicable: false, ok: true, reason: 'not_inline', literalValues: null, instances: [], executableTokens: [] };
  }
  // Inline executable projections require the original process-local source
  // authority. Persisting a tokenized compatibility case would only defer the
  // failure to runtime, where no truthful literal instance could be rebuilt.
  if (!proceduralFlowContract) {
    return {
      applicable: true,
      ok: false,
      code: 'test_design_inline_literal_resolution_incomplete',
      reason: 'source_not_supplied',
      dataRefs: [],
      instances: [],
      executableTokens: [],
    };
  }

  const envelope = proceduralFlowContract
    && proceduralFlowContract.caseContractV1
    && typeof proceduralFlowContract.caseContractV1 === 'object'
    ? proceduralFlowContract.caseContractV1
    : null;
  const contractId = clean(casePlan.caseContractV1 && casePlan.caseContractV1.id);
  if (!envelope || !contractId || !Array.isArray(envelope.cases)) {
    return {
      applicable: true,
      ok: false,
      code: 'test_design_inline_literal_resolution_incomplete',
      reason: 'source_contract_missing',
      dataRefs: [],
    };
  }

  const sourceCase = envelope.cases.find((entry) => clean(entry && entry.id) === contractId);
  if (!sourceCase) {
    return {
      applicable: true,
      ok: false,
      code: 'test_design_inline_literal_resolution_incomplete',
      reason: 'source_case_missing',
      dataRefs: [],
    };
  }
  const rawBindings = typeof caseContractV1.rawBindingsForCase === 'function'
    ? caseContractV1.rawBindingsForCase(envelope, contractId)
    : null;
  if (!(rawBindings instanceof Map)) {
    return {
      applicable: true,
      ok: false,
      code: 'test_design_inline_literal_resolution_incomplete',
      reason: 'source_bindings_missing',
      dataRefs: [],
    };
  }
  const rawRows = typeof caseContractV1.rawRowsForCase === 'function'
    ? caseContractV1.rawRowsForCase(envelope, contractId)
    : null;
  if (!Array.isArray(rawRows)) {
    return {
      applicable: true,
      ok: false,
      code: 'test_design_inline_literal_resolution_incomplete',
      reason: 'source_rows_missing',
      dataRefs: [],
    };
  }

  const allowedTokens = new Set((Array.isArray(dataPlan.allowedTokens) ? dataPlan.allowedTokens : [])
    .map(normalizeToken)
    .filter(Boolean));
  const executableTokens = new Set(stringsIn({
    name: sourceCase.name,
    steps: sourceCase.steps,
    assertions: sourceCase.assertions,
  }).flatMap((entry) => tokensIn(entry.value)).filter((token) => allowedTokens.has(token)));
  for (const dataRef of [
    ...(Array.isArray(sourceCase.steps) ? sourceCase.steps : []).flatMap((step) => (
      Array.isArray(step && step.dataRefs) ? step.dataRefs : []
    )),
    ...(Array.isArray(sourceCase.assertions) ? sourceCase.assertions : []).flatMap((assertion) => (
      Array.isArray(assertion && assertion.dataRefs) ? assertion.dataRefs : []
    )),
  ]) {
    const token = normalizeToken(dataRef);
    if (allowedTokens.has(token)) executableTokens.add(token);
  }
  if (!executableTokens.size) {
    return { applicable: true, ok: true, literalValues: {}, instances: [], executableTokens: [] };
  }

  const normalizedBindings = new Map([...rawBindings.entries()]
    .map(([rawToken, authoredValues]) => [normalizeToken(rawToken), authoredValues]));
  const aggregateMissing = [];
  const ambiguous = [];
  for (const token of executableTokens) {
    const authoredValues = normalizedBindings.get(token);
    const distinctValues = unique((Array.isArray(authoredValues) ? authoredValues : [])
      .filter((value) => value != null && String(value).length > 0)
      .map(String));
    // A single executable case cannot truthfully inline two different values
    // for one token unless those values belong to explicit, row-keyed table
    // instances. Repeated scalar assignments remain ambiguous and must never be
    // resolved by source order.
    if (distinctValues.length === 0) {
      aggregateMissing.push(token);
      continue;
    }
    if (distinctValues.length > 1 && rawRows.length <= 1) {
      ambiguous.push(token);
    }
  }
  if (ambiguous.length) {
    return {
      applicable: true,
      ok: false,
      code: 'test_design_inline_literal_resolution_ambiguous',
      reason: 'multiple_authored_values',
      dataRefs: ambiguous.map((token) => `data.${token}`),
    };
  }
  if (aggregateMissing.length) {
    return {
      applicable: true,
      ok: false,
      code: 'test_design_inline_literal_resolution_incomplete',
      reason: 'authored_value_missing',
      dataRefs: aggregateMissing.map((token) => `data.${token}`),
    };
  }

  const planRows = Array.isArray(dataPlan.rows) ? dataPlan.rows : [];
  const planRowIds = (Array.isArray(dataPlan.rowIds) ? dataPlan.rowIds : []).map(clean);
  const rowIdsFromPlanRows = planRows.map((row) => clean(row && row.id));
  if (!planRows.length || planRowIds.length !== planRows.length
    || stableStringify(planRowIds) !== stableStringify(rowIdsFromPlanRows)) {
    return {
      applicable: true,
      ok: false,
      code: 'test_design_inline_row_inventory_mismatch',
      reason: 'planned_row_inventory_invalid',
      rowIds: rowIdsFromPlanRows,
      dataRefs: [...executableTokens].map((token) => `data.${token}`),
    };
  }
  const rawRowsById = new Map();
  const duplicateRawRowIds = [];
  for (const rawRow of rawRows) {
    const rowId = clean(rawRow && rawRow.id);
    if (!rowId || rawRowsById.has(rowId)) {
      duplicateRawRowIds.push(rowId || null);
      continue;
    }
    rawRowsById.set(rowId, rawRow);
  }
  if (duplicateRawRowIds.length || rawRowsById.size !== planRowIds.length
    || planRowIds.some((rowId) => !rawRowsById.has(rowId))) {
    return {
      applicable: true,
      ok: false,
      code: 'test_design_inline_row_inventory_mismatch',
      reason: duplicateRawRowIds.length ? 'source_row_id_duplicate' : 'source_rows_do_not_match_plan',
      rowIds: duplicateRawRowIds.length ? duplicateRawRowIds : planRowIds,
      dataRefs: [...executableTokens].map((token) => `data.${token}`),
    };
  }

  const classificationByToken = new Map((Array.isArray(dataPlan.bindings) ? dataPlan.bindings : [])
    .map((binding) => [normalizeToken(binding && (binding.token || binding.dataRef)), binding && binding.classification]));
  const instances = [];
  for (const [index, planRow] of planRows.entries()) {
    const rowId = clean(planRow && planRow.id);
    const rawRow = rawRowsById.get(rowId);
    const rawRowBindings = rawRow && rawRow.bindings && typeof rawRow.bindings === 'object'
      ? rawRow.bindings
      : {};
    const publicBindings = planRow && planRow.bindings && typeof planRow.bindings === 'object'
      ? planRow.bindings
      : {};
    const literalValues = {};
    const missing = [];
    const publicMismatches = [];
    for (const token of executableTokens) {
      if (!Object.prototype.hasOwnProperty.call(rawRowBindings, token)
        || rawRowBindings[token] == null || String(rawRowBindings[token]).length === 0) {
        missing.push(token);
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(publicBindings, token)) {
        publicMismatches.push(token);
        continue;
      }
      const rawValue = String(rawRowBindings[token]);
      const publicBinding = publicBindings[token];
      const sensitive = classificationByToken.get(token) === 'sensitive';
      const publicValid = sensitive
        ? !!(publicBinding && publicBinding.kind === 'environment' && clean(publicBinding.name))
        : !!(publicBinding && publicBinding.kind === 'inline' && String(publicBinding.value) === rawValue);
      if (!publicValid) {
        publicMismatches.push(token);
        continue;
      }
      literalValues[token] = rawValue;
    }
    if (missing.length || publicMismatches.length) {
      return {
        applicable: true,
        ok: false,
        code: missing.length
          ? 'test_design_inline_literal_resolution_incomplete'
          : 'test_design_inline_public_binding_mismatch',
        reason: missing.length ? 'row_authored_value_missing' : 'row_public_binding_invalid',
        rowId,
        dataRefs: unique([...missing, ...publicMismatches]).map((token) => `data.${token}`),
      };
    }
    instances.push({
      rowId,
      ordinal: index + 1,
      literalValues,
      publicBindings: clone(publicBindings),
    });
  }
  return {
    applicable: true,
    ok: true,
    literalValues: instances[0] ? clone(instances[0].literalValues) : {},
    instances,
    executableTokens: [...executableTokens],
  };
}

function inlineLiteralFinding(casePlan, resolution) {
  return {
    code: resolution.code || 'test_design_inline_literal_resolution_incomplete',
    severity: 'error',
    planCaseId: casePlan && casePlan.planCaseId || null,
    dataRefs: clone(resolution.dataRefs || []),
    rowId: resolution.rowId || null,
    rowIds: clone(resolution.rowIds || []),
    reason: resolution.reason || 'inline_literal_resolution_failed',
    detail: 'The supplied in-memory procedural source cannot resolve every inline executable reference to exactly one authored value.',
  };
}

function validateInlineLiteralProjection(casePlan, proceduralFlowContract, findings) {
  const resolution = inlineLiteralResolution(casePlan, proceduralFlowContract);
  if (resolution.applicable && !resolution.ok) findings.push(inlineLiteralFinding(casePlan, resolution));
  return resolution;
}

function inlineLiteralValues(casePlan, proceduralFlowContract) {
  const resolution = inlineLiteralResolution(casePlan, proceduralFlowContract);
  return resolution.ok ? resolution.literalValues : null;
}

function materializeInlineTokens(value, literalValues) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*\}\}/g, (match, rawToken) => {
      const token = normalizeToken(rawToken);
      return Object.prototype.hasOwnProperty.call(literalValues, token)
        ? String(literalValues[token])
        : match;
    });
  }
  if (Array.isArray(value)) return value.map((entry) => materializeInlineTokens(entry, literalValues));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .map(([key, entry]) => [key, materializeInlineTokens(entry, literalValues)]));
}

function inlineTokenLabels(casePlan) {
  const bindings = Array.isArray(casePlan && casePlan.caseContractV1 && casePlan.caseContractV1.dataBindings)
    ? casePlan.caseContractV1.dataBindings
    : [];
  return new Map(bindings.map((binding) => [
    normalizeToken(binding && (binding.name || binding.token || binding.dataRef)),
    clean(binding && binding.label),
  ]).filter(([token, label]) => token && label));
}

function canonicalizeInlineLabelNarrative(value, expectedTokens, labels) {
  if (typeof value !== 'string' || !value || tokensIn(value).length) return value;
  const lowerValue = value.toLowerCase();
  const replacements = [];
  for (const token of unique(expectedTokens || [])) {
    const label = labels.get(token);
    if (!label) continue;
    for (const occurrence of boundarySafeLiteralOccurrences(lowerValue, label.toLowerCase())) {
      replacements.push({ ...occurrence, token });
    }
  }
  if (!replacements.length) return value;
  replacements.sort((a, b) => a.index - b.index || b.end - a.end);
  const selected = [];
  for (const replacement of replacements) {
    const overlap = selected.some((entry) => replacement.index < entry.end && replacement.end > entry.index);
    if (overlap) return value;
    selected.push(replacement);
  }
  let canonical = value;
  for (const replacement of selected.sort((a, b) => b.index - a.index)) {
    canonical = `${canonical.slice(0, replacement.index)}{{${replacement.token}}}${canonical.slice(replacement.end)}`;
  }
  return canonical;
}

function canonicalizeInlineExactLabel(value, expectedTokens, labels) {
  if (typeof value !== 'string' || !value || tokensIn(value).length) return value;
  const matches = unique((expectedTokens || []).filter((token) => {
    const label = labels.get(token);
    return label && norm(value) === norm(label);
  }));
  return matches.length === 1 ? `{{${matches[0]}}}` : value;
}

function canonicalizeInlineExpectedValue(value, expectedTokens, labels) {
  if (typeof value !== 'string' || !value) return value;
  const canonical = canonicalizeInlineLabelNarrative(value, expectedTokens, labels);
  const bound = tokensIn(canonical).filter((token) => (expectedTokens || []).includes(token));
  return bound.length === 1 ? `{{${bound[0]}}}` : canonical;
}

function canonicalizeInlineAssertionObject(
  value,
  expectedTokens,
  labels,
  key = '',
  { preserveTargetIdentity = false } = {},
) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeInlineAssertionObject(
      entry,
      expectedTokens,
      labels,
      key,
      { preserveTargetIdentity },
    ));
  }
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') return value;
    if (['expected', 'expectedText', 'unexpectedText', 'equals', 'value'].includes(key)) {
      return canonicalizeInlineExpectedValue(value, expectedTokens, labels);
    }
    if (['target', 'name', 'label', 'pageName', 'element', 'field', 'control'].includes(key)) {
      return preserveTargetIdentity
        ? value
        : canonicalizeInlineExactLabel(value, expectedTokens, labels);
    }
    return canonicalizeInlineLabelNarrative(value, expectedTokens, labels);
  }
  return Object.fromEntries(Object.entries(value).map(([childKey, entry]) => [
    childKey,
    canonicalizeInlineAssertionObject(
      entry,
      expectedTokens,
      labels,
      childKey,
      { preserveTargetIdentity },
    ),
  ]));
}

function canonicalizeInlineExecutableBindings(compiled, casePlan) {
  const canonical = clone(compiled);
  const labels = inlineTokenLabels(casePlan);
  if (!labels.size) return canonical;
  canonical.steps = parseArray(canonical.steps).map((step) => {
    if (!isAssertionStep(step)) return step;
    const expectedTokens = normalizedAuthoredStepDataRefs(step);
    return expectedTokens.length
      ? canonicalizeInlineAssertionObject(
        step,
        expectedTokens,
        labels,
        '',
        { preserveTargetIdentity: true },
      )
      : step;
  });
  // declaredAssertions is the immutable semantic ledger. Keep its target
  // identity and payload byte-for-byte aligned with CaseContractV1; the
  // executable row value belongs in the step/oracle projection instead.
  canonical.declaredAssertions = parseArray(canonical.declaredAssertions);
  canonical.oracles = parseArray(canonical.oracles).map((oracle) => {
    const expectedTokens = unique([
      normalizeToken(oracle && oracle.token),
      ...stringsIn(oracle).flatMap((entry) => tokensIn(entry.value)),
    ]);
    return expectedTokens.length
      ? canonicalizeInlineAssertionObject(oracle, expectedTokens, labels)
      : oracle;
  });
  const assertionTokens = unique((Array.isArray(casePlan && casePlan.caseContractV1
    && casePlan.caseContractV1.assertions) ? casePlan.caseContractV1.assertions : [])
    .flatMap((assertion) => Array.isArray(assertion && assertion.dataRefs)
      ? assertion.dataRefs.map(normalizeToken)
      : []));
  if (assertionTokens.length) {
    canonical.assertions = canonicalizeInlineLabelNarrative(
      canonical.assertions,
      assertionTokens,
      labels,
    );
  }
  return canonical;
}

function materializeInlineExecutableProjection(compiled, casePlan, proceduralFlowContract) {
  const resolution = inlineLiteralResolution(casePlan, proceduralFlowContract);
  if (!resolution.applicable) return compiled;
  if (!resolution.ok) {
    throw new TestDesignStepCompilationError(
      'Inline executable values could not be resolved from the supplied procedural source.',
      [inlineLiteralFinding(casePlan, resolution)],
    );
  }
  if (!resolution.instances.length) return compiled;
  const canonicalExecutable = canonicalizeInlineExecutableBindings(compiled, casePlan);

  // CaseContractV1, DataPlan and dataBinding intentionally retain compiler
  // tokens as immutable lineage. Each executable row projection is restored to
  // the exact values authored in the in-memory text requirement.
  const instancePlans = resolution.instances.map((instance) => {
    const executableProjection = {
      name: materializeInlineTokens(canonicalExecutable.name == null ? '' : canonicalExecutable.name, instance.literalValues),
      assertions: materializeInlineTokens(canonicalExecutable.assertions == null ? '' : canonicalExecutable.assertions, instance.literalValues),
      operations: materializeInlineTokens(canonicalExecutable.operations == null ? [] : canonicalExecutable.operations, instance.literalValues),
      oracles: materializeInlineTokens(canonicalExecutable.oracles == null ? [] : canonicalExecutable.oracles, instance.literalValues),
      declaredAssertions: materializeInlineTokens(
        canonicalExecutable.declaredAssertions == null ? [] : canonicalExecutable.declaredAssertions,
        instance.literalValues,
      ),
      steps: materializeInlineTokens(canonicalExecutable.steps == null ? [] : canonicalExecutable.steps, instance.literalValues),
    };
    const remaining = unique(stringsIn(executableProjection).flatMap((entry) => tokensIn(entry.value)))
      .filter((token) => resolution.executableTokens.includes(token));
    if (remaining.length) {
      throw new TestDesignStepCompilationError(
        'Inline executable projection retained unresolved authored references.',
        [inlineLiteralFinding(casePlan, {
          code: 'test_design_inline_literal_projection_unresolved',
          reason: 'executable_token_remained',
          rowId: instance.rowId,
          dataRefs: remaining.map((token) => `data.${token}`),
        })],
      );
    }
    const instancePlanId = inlineCaseInstanceContract.instancePlanId({
      planCaseId: casePlan.planCaseId,
      inlineRevision: casePlan.dataPlan.inlineRevision,
      rowId: instance.rowId,
    });
    const instanceRevision = inlineCaseInstanceContract.instanceRevision({
      instancePlanId,
      planCaseId: casePlan.planCaseId,
      inlineRevision: casePlan.dataPlan.inlineRevision,
      rowId: instance.rowId,
      ordinal: instance.ordinal,
      executableProjection,
    });
    return {
      instancePlanId,
      rowId: instance.rowId,
      ordinal: instance.ordinal,
      instanceRevision,
      inputs: clone(instance.literalValues),
      publicBindings: clone(instance.publicBindings),
      executableProjection,
    };
  });
  const defaultInstance = instancePlans[0];
  return {
    ...compiled,
    ...clone(defaultInstance.executableProjection),
    rowExecutionPlan: {
      ...(compiled.rowExecutionPlan || {}),
      executionMode: instancePlans.length > 1 ? 'per_row' : 'single',
      rowIds: instancePlans.map((instance) => instance.rowId),
      defaultInstanceId: defaultInstance.instancePlanId,
      instances: instancePlans,
    },
  };
}

// Digest the compiler-owned executable contract, not the model-authored prose
// around it.  This revision is stamped after strict compilation and checked
// again at the persistence boundary so keeping an old plan/case lineage cannot
// conceal a later mutation to steps, assertions, session state, or data pins.
function compiledCaseSemanticProjection(caseObj = {}) {
  return {
    version: VERSION,
    planCaseId: clean(caseObj.planCaseId) || null,
    planRevision: clean(caseObj.planRevision) || null,
    caseRevision: clean(caseObj.caseRevision) || null,
    intent: caseObj.intent == null ? null : clone(caseObj.intent),
    module: caseObj.module == null ? null : clone(caseObj.module),
    storyId: caseObj.storyId == null ? null : clone(caseObj.storyId),
    requirementRefs: clone(parseArray(caseObj.requirementRefs)),
    requirementRevisions: clone(parseArray(caseObj.requirementRevisions)),
    coverageRef: caseObj.coverageRef == null ? null : clone(caseObj.coverageRef),
    primaryCoverageRef: caseObj.primaryCoverageRef == null ? null : clone(caseObj.primaryCoverageRef),
    coverageRefs: clone(parseArray(caseObj.coverageRefs)),
    supportingCoverageRefs: clone(parseArray(caseObj.supportingCoverageRefs)),
    coverageDisposition: caseObj.coverageDisposition == null ? null : clone(caseObj.coverageDisposition),
    initialState: clone(caseObj.initialState == null ? null : caseObj.initialState),
    expectedFinalState: clone(caseObj.expectedFinalState == null ? null : caseObj.expectedFinalState),
    sessionRequirement: clone(caseObj.sessionRequirement == null ? null : caseObj.sessionRequirement),
    dependencies: clone(parseArray(caseObj.dependencies)),
    dependsOnIds: clone(parseArray(caseObj.dependsOnIds)),
    dependsOnNames: clone(parseArray(caseObj.dependsOnNames)),
    sessionMode: caseObj.sessionMode == null ? null : clone(caseObj.sessionMode),
    failurePolicy: caseObj.failurePolicy == null ? null : clone(caseObj.failurePolicy),
    authProfile: caseObj.authProfile == null ? null : clone(caseObj.authProfile),
    credentialHint: caseObj.credentialHint == null ? null : clone(caseObj.credentialHint),
    automatability: caseObj.automatability == null ? null : clone(caseObj.automatability),
    operations: clone(parseArray(caseObj.operations)),
    operationsDropped: clone(parseArray(caseObj.operationsDropped)),
    operationStatus: caseObj.operationStatus == null ? null : clone(caseObj.operationStatus),
    dataBinding: clone(caseObj.dataBinding == null ? null : caseObj.dataBinding),
    rowExecutionPlan: clone(caseObj.rowExecutionPlan == null ? null : caseObj.rowExecutionPlan),
    oracles: clone(parseArray(caseObj.oracles)),
    declaredAssertions: clone(parseArray(caseObj.declaredAssertions)),
    assertions: caseObj.assertions == null ? null : clone(caseObj.assertions),
    caseContractV1: clone(caseObj.caseContractV1 == null ? null : caseObj.caseContractV1),
    steps: clone(parseArray(caseObj.steps)),
  };
}

function compiledCaseRevision(caseObj = {}) {
  return sha256(compiledCaseSemanticProjection(caseObj));
}

function canonicalDataBinding(casePlan, plan) {
  const dataPlan = casePlan.dataPlan || { mode: 'none' };
  if (dataPlan.mode === 'none') return null;
  if (dataPlan.mode === 'inline') {
    return {
      status: 'complete',
      source: 'case_contract_v1',
      mode: 'inline',
      approved: true,
      inlineRevision: dataPlan.inlineRevision,
      rowSelector: dataPlan.rowSelector,
      rowIds: clone(dataPlan.rowIds || []),
      rows: clone(dataPlan.rows || []),
      bindings: clone(dataPlan.bindings || []),
      planId: plan.planId,
      planRevision: plan.revision,
      planCaseId: casePlan.planCaseId,
      caseRevision: casePlan.caseRevision,
    };
  }
  return {
    status: 'complete',
    source: 'test_design_plan',
    approved: dataPlan.approved === true,
    testDataSetId: dataPlan.testDataSetId,
    mappingId: dataPlan.mappingId,
    mappingVersion: dataPlan.mappingVersion,
    workbookHash: dataPlan.workbookHash,
    datasetRevisionId: dataPlan.datasetRevisionId,
    sheetId: dataPlan.sheetId,
    rowGroupId: dataPlan.rowGroupId,
    sheet: dataPlan.sheet,
    rowSelector: dataPlan.rowSelector,
    rowIds: clone(dataPlan.rowIds || []),
    columnToField: clone(dataPlan.columnToField || {}),
    expectedColumn: dataPlan.expectedColumn || null,
    rowClassColumn: dataPlan.rowClassColumn || null,
    planId: plan.planId,
    planRevision: plan.revision,
    planCaseId: casePlan.planCaseId,
    caseRevision: casePlan.caseRevision,
  };
}

function canonicalRowExecutionPlan(casePlan) {
  const dataPlan = casePlan.dataPlan || {};
  if (dataPlan.mode === 'inline') {
    return {
      version: 1,
      mode: 'inline',
      rowSelector: dataPlan.rowSelector,
      rowIds: clone(dataPlan.rowIds || []),
      executionMode: (dataPlan.rowIds || []).length > 1 ? 'per_row' : 'single',
      skippedRows: [],
      skipReasons: {},
      dataBindingId: dataPlan.inlineRevision,
      inlineRevision: dataPlan.inlineRevision,
    };
  }
  if (dataPlan.mode !== 'matrix') return null;
  return {
    version: 1,
    mode: 'matrix',
    sheet: dataPlan.sheet,
    rowSelector: dataPlan.rowSelector,
    rowIds: clone(dataPlan.rowIds || []),
    dataBindingId: dataPlan.mappingId,
    mappingVersion: dataPlan.mappingVersion,
    workbookHash: dataPlan.workbookHash,
    datasetRevisionId: dataPlan.datasetRevisionId,
    sheetId: dataPlan.sheetId,
    rowGroupId: dataPlan.rowGroupId,
  };
}

function canonicalLineage(plan, casePlan) {
  return {
    version: PLAN_VERSION,
    planId: plan.planId,
    revision: plan.revision,
    planCaseId: casePlan.planCaseId,
    caseRevision: casePlan.caseRevision,
    inputRevisions: clone(plan.inputRevisions),
  };
}

function compileCase(caseObj, casePlan, plan, matches, options = {}) {
  const copy = clone(caseObj);
  const lineage = canonicalLineage(plan, casePlan);
  const dataBinding = canonicalDataBinding(casePlan, plan);
  const rowExecutionPlan = canonicalRowExecutionPlan(casePlan);
  const qualityContract = copy.qualityContract && typeof copy.qualityContract === 'object'
    ? clone(copy.qualityContract)
    : {};
  qualityContract.testDesignPlan = lineage;
  qualityContract.caseContractV1 = casePlan.caseContractV1
    ? clone(casePlan.caseContractV1)
    : {
      version: 'CaseContractV1',
      planId: plan.planId,
      planCaseId: casePlan.planCaseId,
      caseRevision: casePlan.caseRevision,
      initialState: clone(casePlan.initialState),
      expectedFinalState: clone(casePlan.expectedFinalState),
      sessionRequirement: clone(casePlan.sessionRequirement),
      dependencies: clone(casePlan.dependencies || []),
      failurePolicy: clone(casePlan.failurePolicy),
    };
  const sessionMode = casePlan.sessionRequirement && casePlan.sessionRequirement.mode === 'continue_from_case'
    ? 'continue_from_dependency'
    : 'fresh';
  const failurePolicy = typeof casePlan.failurePolicy === 'string'
    ? casePlan.failurePolicy
    : clean(casePlan.failurePolicy && casePlan.failurePolicy.default) || 'dependency_aware';
  const authProfile = clean(options.authProfileName || options.authProfile)
    || clean(copy.authProfile)
    || null;
  let compiled = {
    ...copy,
    planCaseId: casePlan.planCaseId,
    planRevision: plan.revision,
    caseRevision: casePlan.caseRevision,
    intent: casePlan.intent,
    module: casePlan.module,
    storyId: casePlan.storyId,
    requirementRefs: clone(casePlan.requirementRefs || []),
    requirementRevisions: clone(casePlan.requirementRevisions || []),
    coverageRef: casePlan.coverageRef,
    primaryCoverageRef: casePlan.coverageRef,
    coverageRefs: [casePlan.coverageRef],
    initialState: clone(casePlan.initialState),
    expectedFinalState: clone(casePlan.expectedFinalState),
    sessionRequirement: clone(casePlan.sessionRequirement),
    dependencies: clone(casePlan.dependencies || []),
    dependsOnIds: clone(casePlan.dependencies || []),
    sessionMode,
    failurePolicy,
    authProfile,
    caseContractV1: clone(casePlan.caseContractV1 || null),
    dataBinding,
    rowExecutionPlan,
    oracles: clone(casePlan.oracles || []),
    declaredAssertions: canonicalAssertions(casePlan, matches),
    steps: compileSteps(caseObj, casePlan),
    qualityContract,
    testDesignPlanRef: lineage,
  };
  compiled = materializeInlineExecutableProjection(
    compiled,
    casePlan,
    options.proceduralFlowContract || null,
  );
  const revision = compiledCaseRevision(compiled);
  compiled.compiledCaseRevision = revision;
  compiled.qualityContract.testDesignPlan = {
    ...compiled.qualityContract.testDesignPlan,
    compiledCaseRevision: revision,
  };
  compiled.testDesignPlanRef = {
    ...compiled.testDesignPlanRef,
    compiledCaseRevision: revision,
  };
  return compiled;
}

function validateCompiledStepSemantics(caseObj, casePlan, findings) {
  const steps = parseArray(caseObj && caseObj.steps);
  const planCaseId = clean(casePlan && casePlan.planCaseId) || clean(caseObj && caseObj.planCaseId) || null;
  const push = (step, code, detail, extra = {}) => findings.push({
    code,
    severity: 'error',
    stage: 'compiled_step_semantics',
    planCaseId,
    stepId: clean(step && (step.id || step.stepId || step.caseContractStepId)) || null,
    ordinal: Number(step && (step.ordinal || step.order)) || null,
    action: actionName(step) || null,
    detail,
    ...extra,
  });

  for (const step of steps) {
    const action = normalizedAction(step);
    const text = clean(step && (step.text || step.description || step.instruction));
    const assertion = isAssertionStep(step);

    if (assertion
      && /^(?:open|click|press|tap|select|choose|pick|fill|enter|input|type|check|tick|scroll|expand|collapse)\b/i.test(text)
      && /\b(?:verify|assert|validate|confirm|expect)\b/i.test(text)) {
      push(
        step,
        'test_design_compound_assertion_action',
        'An assertion step still contains imperative browser actions. Split the actions and assertion into ordered atomic steps before compilation.',
      );
    }

    if (/^(?:wait|wait_for_state|waitforstate)$/.test(action)
      && (/^(?:open|click|press|tap|select|choose|pick|fill|enter|input|type|check|tick|scroll|expand|collapse)\b/i.test(text)
        || /\bif\b[^.]{0,240}\b(?:click|press|open|expand|collapse)\b/i.test(text))) {
      push(
        step,
        'test_design_imperative_wait_action',
        'A wait step cannot perform an authored browser action. Emit the action explicitly and keep WaitForState observation-only.',
      );
    }

    if (/^assert_?visible$|^assertvisible$/.test(action)
      && /(?:\bno\b|\bnot\b|\bwithout\b)[^.]{0,180}\b(?:visible|displayed|shown|appears?)\b/i.test(text)) {
      push(
        step,
        'test_design_negative_visibility_channel',
        'A negative visibility requirement was compiled as AssertVisible. Use AssertHidden.',
      );
    }

    if (assertion && !/^assert_?url$|^asserturl$/.test(action)) {
      const rawExpected = assertionExpected(step);
      const expected = typeof rawExpected === 'string' ? clean(rawExpected) : '';
      const at = expected && /^\/[A-Za-z0-9_.~-]+(?:\/[A-Za-z0-9_.~-]+)*$/.test(expected)
        ? text.indexOf(expected)
        : -1;
      if (at > 0 && /[A-Za-z0-9_-]/.test(text[at - 1] || '')) {
        push(
          step,
          'test_design_embedded_path_fragment',
          'A slash-delimited fragment inside ordinary authored text was projected as an assertion expectation.',
          { expected },
        );
      }
    }

    const controlKind = controlActionAdapter.actionKind(step);
    if (['date', 'scroll', 'radio', 'expand', 'collapse'].includes(controlKind)) {
      try {
        controlActionAdapter.buildControlActionPlan(step);
      } catch (error) {
        push(
          step,
          'test_design_control_action_contract_invalid',
          `The ${controlKind} action is missing a safe executable contract: ${clean(error && error.message)}`,
        );
      }
    }
  }
}

function validateCompiledAssertionParity(caseObj, casePlan, findings) {
  const authored = Array.isArray(casePlan?.caseContractV1?.assertions)
    ? casePlan.caseContractV1.assertions
    : [];
  if (!authored.length) return;
  const compiled = parseArray(caseObj && caseObj.declaredAssertions);
  const planCaseId = clean(casePlan && casePlan.planCaseId) || clean(caseObj && caseObj.planCaseId) || null;
  const push = (assertionId, field, expected, actual, detail) => findings.push({
    code: 'test_design_assertion_ledger_parity',
    severity: 'error',
    stage: 'compiled_assertion_parity',
    planCaseId,
    assertionId: assertionId || null,
    field,
    expected: clone(expected),
    actual: clone(actual),
    detail,
  });
  if (compiled.length !== authored.length) {
    push(null, 'count', authored.length, compiled.length, 'Compiled assertion count must equal the immutable CaseContractV1 assertion count.');
  }
  const compiledByRef = new Map();
  for (const assertion of compiled) {
    const ref = clean(assertion && (assertion.oracleRef || assertion.id));
    if (!ref || compiledByRef.has(ref)) {
      push(ref, 'oracleRef', 'one unique assertion reference', ref || null, 'Every compiled assertion must have one unique immutable assertion reference.');
      continue;
    }
    compiledByRef.set(ref, assertion);
  }
  const fields = [
    ['semanticType', 'type'],
    ['comparator', 'comparator'],
    ['semanticPayload', 'payload'],
    ['targetIdentity', 'targetIdentity'],
    ['sourceQuote', 'sourceQuote'],
    ['sourceSpan', 'sourceSpan'],
    ['sourceClauseRefs', 'sourceClauseRefs'],
    ['failureBehavior', 'failureBehavior'],
    ['stepId', 'stepId'],
    ['dataRefs', 'dataRefs'],
  ];
  for (const source of authored) {
    const assertionId = clean(source && source.id);
    const projected = compiledByRef.get(assertionId);
    if (!projected) {
      push(assertionId, 'oracleRef', assertionId, null, 'An immutable authored assertion is missing from the compiled assertion ledger.');
      continue;
    }
    const semanticExpected = assertionExpected(source);
    if (stableStringify(projected.expected) !== stableStringify(semanticExpected)) {
      push(assertionId, 'expected', semanticExpected, projected.expected, 'Compiled assertion expected meaning must match the immutable authored assertion payload.');
    }
    for (const [compiledField, authoredField] of fields) {
      const expected = source && source[authoredField] !== undefined
        ? source[authoredField]
        : (['sourceClauseRefs', 'dataRefs'].includes(authoredField) ? [] : null);
      const actual = projected[compiledField] !== undefined
        ? projected[compiledField]
        : (['sourceClauseRefs', 'dataRefs'].includes(compiledField) ? [] : null);
      if (stableStringify(actual) !== stableStringify(expected)) {
        push(assertionId, compiledField, expected, actual, 'Compiled assertion semantics must exactly match the immutable authored assertion.');
      }
    }
  }
}

function makeReport(plan, inventory, findings, compiledCount = 0) {
  return {
    version: VERSION,
    planId: plan && plan.planId || null,
    planRevision: plan && plan.revision || null,
    plannedCases: plan ? planCases(plan).length : 0,
    candidateCases: inventory.length,
    compiledCases: compiledCount,
    ok: findings.length === 0,
    findingCount: findings.length,
    findings: clone(findings),
  };
}

function compileCandidateSuite(input = {}) {
  const plan = input.testDesignPlan || input.plan;
  const planValidation = validateTestDesignPlanV1(plan);
  if (!planValidation.ok) {
    const findings = planValidation.findings.map((finding) => ({ ...finding, stage: 'plan_integrity' }));
    throw new TestDesignStepCompilationError('The supplied TestDesignPlanV1 is invalid.', findings, makeReport(plan, [], findings));
  }

  const inventory = candidateInventory(input);
  const plannedRows = planCases(plan);
  const plannedById = new Map(plannedRows.map((row) => [row.casePlan.planCaseId, row]));
  const candidatesById = new Map();
  const findings = [];

  // Auto-align candidate cases with planned cases if planCaseId was not explicitly emitted
  const assignedPlanCaseIds = new Set(inventory.map((e) => clean(e.caseObj && e.caseObj.planCaseId)).filter(Boolean));
  for (let i = 0; i < inventory.length; i++) {
    const entry = inventory[i];
    if (entry.caseObj && !clean(entry.caseObj.planCaseId)) {
      const candidateName = norm(entry.caseObj.name || (entry.scenario && entry.scenario.name) || '');
      const matchedRow = plannedRows.find(
        (row) => !assignedPlanCaseIds.has(row.casePlan.planCaseId)
          && (norm(row.casePlan.title || row.casePlan.name || '') === candidateName
            || candidateName.includes(norm(row.casePlan.title || row.casePlan.name || ''))
            || norm(row.casePlan.title || row.casePlan.name || '').includes(candidateName))
      );
      if (matchedRow) {
        entry.caseObj.planCaseId = matchedRow.casePlan.planCaseId;
        assignedPlanCaseIds.add(matchedRow.casePlan.planCaseId);
        if (entry.scenario && !entry.scenario.planScenarioId && matchedRow.scenario) {
          entry.scenario.planScenarioId = matchedRow.scenario.planScenarioId;
        }
      } else {
        const firstAvailable = plannedRows.find((row) => !assignedPlanCaseIds.has(row.casePlan.planCaseId));
        if (firstAvailable) {
          entry.caseObj.planCaseId = firstAvailable.casePlan.planCaseId;
          assignedPlanCaseIds.add(firstAvailable.casePlan.planCaseId);
          if (entry.scenario && !entry.scenario.planScenarioId && firstAvailable.scenario) {
            entry.scenario.planScenarioId = firstAvailable.scenario.planScenarioId;
          }
        }
      }
    }
  }

  for (const entry of inventory) {
    const planCaseId = clean(entry.caseObj && entry.caseObj.planCaseId);
    if (!planCaseId) {
      findings.push({
        code: 'test_design_candidate_case_id_missing',
        severity: 'error',
        scenarioIndex: entry.scenarioIndex,
        caseIndex: entry.caseIndex,
        detail: 'Every candidate case must emit its exact planCaseId.',
      });
      continue;
    }
    if (!plannedById.has(planCaseId)) {
      findings.push({
        code: 'test_design_extra_case',
        severity: 'error',
        planCaseId,
        detail: 'The candidate case is not present in the immutable design plan.',
      });
      continue;
    }
    if (candidatesById.has(planCaseId)) {
      findings.push({
        code: 'test_design_duplicate_case',
        severity: 'error',
        planCaseId,
        detail: 'A planCaseId must be emitted exactly once.',
      });
      continue;
    }
    candidatesById.set(planCaseId, entry);
  }
  for (const { casePlan } of plannedRows) {
    if (!candidatesById.has(casePlan.planCaseId)) {
      findings.push({
        code: 'test_design_planned_case_missing',
        severity: 'error',
        planCaseId: casePlan.planCaseId,
        detail: 'A planned case is absent from the candidate suite.',
      });
    }
  }

  const matchesByCase = new Map();
  const canonicalEntriesByCase = new Map();
  for (const { casePlan } of plannedRows) {
    const entry = candidatesById.get(casePlan.planCaseId);
    if (!entry) continue;
    const canonicalized = canonicalizeProvenInlineCandidate(
      entry.caseObj,
      casePlan,
      input.proceduralFlowContract || null,
    );
    const canonicalEntry = { ...entry, caseObj: canonicalized.caseObj };
    canonicalEntriesByCase.set(casePlan.planCaseId, canonicalEntry);
    validateTokens(canonicalEntry.caseObj, casePlan, findings);
    validateSensitiveLiterals(canonicalEntry.caseObj, casePlan, findings);
    validateActionTopology(canonicalEntry.caseObj, casePlan, findings);
    validateCaseContractStepDataBindings(canonicalEntry.caseObj, casePlan, findings);
    validateInlineLiteralProjection(casePlan, input.proceduralFlowContract || null, findings);
    matchesByCase.set(casePlan.planCaseId, validateAssertionChannels(canonicalEntry.caseObj, casePlan, findings));
  }

  if (findings.length) {
    throw new TestDesignStepCompilationError(
      'Candidate steps do not conform to the immutable TestDesignPlanV1.',
      findings,
      makeReport(plan, inventory, findings),
    );
  }

  const compiledCases = new Map();
  for (const { casePlan } of plannedRows) {
    const entry = canonicalEntriesByCase.get(casePlan.planCaseId) || candidatesById.get(casePlan.planCaseId);
    const compiledCase = compileCase(
      entry.caseObj,
      casePlan,
      plan,
      matchesByCase.get(casePlan.planCaseId) || new Map(),
      {
        authProfileName: input.authProfileName || input.authProfile || null,
        proceduralFlowContract: input.proceduralFlowContract || null,
      },
    );
    validateCompiledStepSemantics(compiledCase, casePlan, findings);
    validateCompiledAssertionParity(compiledCase, casePlan, findings);
    compiledCases.set(casePlan.planCaseId, compiledCase);
  }

  if (findings.length) {
    throw new TestDesignStepCompilationError(
      'Compiled steps do not satisfy the executable semantic contract.',
      findings,
      makeReport(plan, inventory, findings, compiledCases.size),
    );
  }

  const compiledScenarios = plan.scenarios.map((scenarioPlan) => {
    const firstEntry = (scenarioPlan.cases || []).map((casePlan) => candidatesById.get(casePlan.planCaseId)).find(Boolean);
    const sourceScenario = firstEntry && firstEntry.scenario && typeof firstEntry.scenario === 'object'
      ? clone(firstEntry.scenario)
      : {};
    const sourceCase = firstEntry && firstEntry.caseObj && typeof firstEntry.caseObj === 'object'
      ? firstEntry.caseObj
      : {};
    const scenarioName = clean(scenarioPlan.intent)
      || clean(sourceScenario.name)
      || clean(sourceScenario.intent)
      || clean(sourceCase.name)
      || 'Generated scenario';
    const scenarioModule = clean(scenarioPlan.module)
      || clean(sourceScenario.module)
      || clean(sourceCase.module)
      || 'Core';
    delete sourceScenario.cases;
    return {
      ...sourceScenario,
      planScenarioId: scenarioPlan.planScenarioId,
      name: scenarioName,
      intent: clean(scenarioPlan.intent) || clean(sourceScenario.intent) || scenarioName,
      module: scenarioModule,
      requirementRefs: clone(scenarioPlan.requirementRefs || []),
      cases: (scenarioPlan.cases || []).map((casePlan) => compiledCases.get(casePlan.planCaseId)),
    };
  });
  const compiled = Array.from(compiledCases.values());
  return {
    version: VERSION,
    planId: plan.planId,
    planRevision: plan.revision,
    scenarios: compiledScenarios,
    cases: compiled,
    report: makeReport(plan, inventory, [], compiled.length),
    revision: sha256({
      version: VERSION,
      planId: plan.planId,
      planRevision: plan.revision,
      scenarios: compiledScenarios,
    }),
  };
}

module.exports = {
  VERSION,
  COMPILATION_ERROR_CODE,
  TestDesignStepCompilationError,
  compileCandidateSuite,
  compileTestDesignSteps: compileCandidateSuite,
  compileTestDesignStepSuite: compileCandidateSuite,
  compile: compileCandidateSuite,
  compiledCaseSemanticProjection,
  compiledCaseRevision,
  _private: {
    tokensIn,
    channelFromAssertion,
    assertionEntries,
    validateTokens,
    validateSensitiveLiterals,
    validateActionTopology,
    validateCaseContractStepDataBindings,
    validateAssertionChannels,
    validateCompiledStepSemantics,
    validateCompiledAssertionParity,
    canonicalDataBinding,
    canonicalLineage,
    inlineLiteralResolution,
    validateInlineLiteralProjection,
    inlineLiteralValues,
    materializeInlineTokens,
    materializeInlineExecutableProjection,
    compileSteps,
    projectAuthoredControlMetadata,
  },
};
