'use strict';

/**
 * Production Playwright POM JavaScript adapter.
 *
 * ReplayIR deliberately keeps unmatched runtime operations as evidence when their
 * runtime ids do not equal the approved authored ids. That is the correct IR
 * safety posture, but runnable JavaScript must not discard a verified locator just
 * because the ids came from different identity namespaces. This adapter performs
 * one final, JS-only projection:
 *
 *   - authored operations remain authoritative and appear exactly once;
 *   - a verified evidence locator may be attached only to a unique compatible
 *     authored operation/target match;
 *   - unmatched runtime observations remain diagnostic-only and never execute;
 *   - runtime-required operations execute only with authored occurrence or contract backing;
 *   - attached duplicates and explicit browser utilities never leak as annotations;
 *   - the observed initial page becomes an evidence-backed setup navigation;
 *   - optional authored controls remain conditional;
 *   - page ownership is derived from authored context and observed URLs.
 *
 * The shared TypeScript adapter receives the original inputs unchanged.
 */
const actionLocatorResolver = require('../../actionLocatorResolver');

const STANDARD_OUTPUT_PROFILE = 'playwright-pom-js-v1';
const DROP_FROM_RUNNABLE_SPEC = Symbol('dropFromRunnableSpec');
const ATTACHED_RUNTIME_DUPLICATE = Symbol('attachedRuntimeDuplicate');
const ATTACHED_AUTHORED_STEP = Symbol('attachedAuthoredStep');

const ACTION_ALIASES = new Map([
  ['click', 'click'],
  ['tap', 'click'],
  ['doubleclick', 'doubleClick'],
  ['double click', 'doubleClick'],
  ['tripleclick', 'tripleClick'],
  ['triple click', 'tripleClick'],
  ['fill', 'fill'],
  ['enter', 'fill'],
  ['input', 'fill'],
  ['type', 'type'],
  ['select', 'selectOption'],
  ['selectoption', 'selectOption'],
  ['select option', 'selectOption'],
  ['check', 'check'],
  ['uncheck', 'uncheck'],
  ['press', 'press'],
  ['hover', 'hover'],
  ['drag', 'drag'],
  ['upload', 'upload'],
  ['navigate', 'navigate'],
  ['goto', 'navigate'],
  ['go to', 'navigate'],
  ['open', 'navigate'],
  ['navigate back', 'navigateBack'],
  ['navigateback', 'navigateBack'],
  ['go back', 'navigateBack'],
  ['back', 'navigateBack'],
  ['navigate forward', 'navigateForward'],
  ['navigateforward', 'navigateForward'],
  ['go forward', 'navigateForward'],
  ['forward', 'navigateForward'],
  ['handle dialog', 'handleDialog'],
  ['handledialog', 'handleDialog'],
  ['accept dialog', 'handleDialog'],
  ['dismiss dialog', 'handleDialog'],
  ['resize', 'resize'],
  ['set viewport', 'resize'],
  ['close', 'close'],
  ['close page', 'close'],
  ['wait', 'waitFor'],
  ['waitfor', 'waitFor'],
  ['wait for', 'waitFor'],
]);

const TARGETED_POM_ACTIONS = new Set([
  'click',
  'doubleClick',
  'tripleClick',
  'fill',
  'type',
  'selectOption',
  'check',
  'uncheck',
  'press',
  'hover',
  'drag',
  'upload',
]);

const TARGETLESS_POM_ACTIONS = new Set([
  'navigate',
  'navigateBack',
  'navigateForward',
  'handleDialog',
  'resize',
  'close',
]);

const AUTHORED_POM_ACTIONS = new Set([...TARGETED_POM_ACTIONS, ...TARGETLESS_POM_ACTIONS]);

const TARGET_STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'this',
  'that',
  'your',
  'my',
  'our',
  'click',
  'tap',
  'double',
  'triple',
  'fill',
  'enter',
  'input',
  'type',
  'select',
  'choose',
  'check',
  'uncheck',
  'press',
  'hover',
  'drag',
  'upload',
  'wait',
  'navigate',
  'open',
  'go',
  'to',
  'for',
  'on',
  'from',
  'within',
  'button',
  'link',
  'textbox',
  'inputbox',
  'inputfield',
  'field',
  'control',
  'element',
  'menuitem',
  'checkbox',
  'radio',
  'combobox',
  'option',
  'tab',
  'heading',
  'label',
  'page',
  'screen',
  'form',
]);

const PAGE_CONTEXT_FIELDS = [
  'pageUrl',
  'pageUrlBefore',
  'pageUrlAfter',
  'frameChain',
  'framePath',
  'frameLocator',
  'frameIdentity',
  'shadowHostChain',
  'shadowHostPath',
  'shadowPath',
  'shadowRootChain',
  'popupIdentity',
  'pageIdentity',
  'pageAlias',
  'tabAlias',
  'contextTransition',
  'tabId',
  'browserContextId',
  'popup',
  'newTab',
  'transitionKind',
  'navigationKind',
];

const PAGE_NAME_FIELDS = [
  'authoredPageName',
  'semanticPageName',
  'pageRole',
  'pageName',
  'expectedPage',
  'expectedPageTitle',
  'pageTitle',
  'pageHeading',
];

const GENERIC_HOST_PARTS = new Set([
  'www',
  'app',
  'apps',
  'application',
  'portal',
  'login',
  'signin',
  'signon',
  'auth',
  'oauth',
  'account',
  'accounts',
  'id',
  'identity',
  'secure',
  'sso',
  'example',
  'sample',
  'demo',
]);

const PUBLIC_SUFFIX_PARTS = new Set([
  'com',
  'org',
  'net',
  'edu',
  'gov',
  'io',
  'ai',
  'co',
  'uk',
  'in',
  'de',
  'fr',
  'au',
  'ca',
  'jp',
  'dev',
  'test',
  'local',
  'localhost',
]);

const GENERIC_ROUTE_PARTS = new Set([
  'auth',
  'authentication',
  'authorize',
  'authorization',
  'callback',
  'common',
  'connect',
  'identity',
  'login',
  'logout',
  'oauth',
  'oauth2',
  'oidc',
  'redirect',
  'signin',
  'sign-in',
  'signon',
  'sso',
  'tenant',
  'user',
  'users',
]);

function normalizedAction(value) {
  const raw = String(value || '')
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  return ACTION_ALIASES.get(raw) || raw.replace(/\s+/g, '');
}

const OPTIONAL_ACTION_TEXT_FIELDS = [
  'action',
  'operation',
  'authoredOperation',
  'originalAction',
  'instruction',
  'description',
  'narration',
  'text',
  'label',
  'name',
];

function optionalActionDirective(value) {
  const text = String(value == null ? '' : value)
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  if (!text) return false;
  if (/\boptional(?:ly)?\b/.test(text)) return true;
  if (/\bwhere\s+available\b/.test(text)) return true;

  const conditional = text.match(
    /\b(?:if|when)\b(.{0,96}?)\b(?:visible|present|available|shown|displayed|found|exists?|appears?|applicable)\b/,
  );
  if (!conditional) return false;
  return !/\b(?:not|never)\b/.test(conditional[1]);
}

function authoredActionIsOptional(...sources) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    if (
      source.optional === true ||
      source.ifPresent === true ||
      source.ifVisible === true ||
      source.optionalAbsent === true ||
      ['continue', 'skip', 'ignore'].includes(
        String(source.optionalAbsent == null ? '' : source.optionalAbsent).trim().toLowerCase(),
      )
    )
      return true;
    for (const field of OPTIONAL_ACTION_TEXT_FIELDS) {
      if (optionalActionDirective(source[field])) return true;
    }
    if (source.stepAuthoring && typeof source.stepAuthoring === 'object') {
      for (const field of OPTIONAL_ACTION_TEXT_FIELDS) {
        if (optionalActionDirective(source.stepAuthoring[field])) return true;
      }
    }
    for (const nested of [
      source.payload,
      source.metadata,
      source.actionContract,
      source.contract,
    ]) {
      if (!nested || typeof nested !== 'object') continue;
      if (authoredActionIsOptional(nested)) return true;
    }
  }
  return false;
}

function applyAuthoredActionOptionality(target, ...sources) {
  if (target && authoredActionIsOptional(target, ...sources)) target.optional = true;
}

const ASSERTION_OPERATION_TOKENS = new Set([
  'assert',
  'assertion',
  'expect',
  'validate',
  'validation',
  'verify',
  'verification',
]);

function assertionOperationToken(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function isDeclaredAssertionStep(step) {
  if (!step || typeof step !== 'object') return false;
  const kind = assertionOperationToken(step.kind || step.stepKind || step.disposition);
  if (kind === 'assertion' || kind === 'assert') return true;
  const op = assertionOperationToken(step.op);
  if (op === 'assert' || op === 'assertion') return true;
  const operation = assertionOperationToken(
    step.authoredOperation ||
      step.originalAction ||
      step.action ||
      step.operation ||
      step.type,
  );
  if (ASSERTION_OPERATION_TOKENS.has(operation)) return true;
  return !!(
    step.assertionContract ||
    step.assertionType ||
    step.expectedOutcome ||
    step.assertionId
  );
}

function assertionChannelFromContract(step) {
  const payload = step && step.payload && typeof step.payload === 'object' ? step.payload : {};
  const expectedOutcome = step && step.expectedOutcome && typeof step.expectedOutcome === 'object'
    ? step.expectedOutcome
    : {};
  const raw = String(
    step && (step.channel || step.assertionType || step.expectedKind) ||
      expectedOutcome.kind ||
      payload.channel ||
      payload.assertionType ||
      payload.type ||
      '',
  ).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  if (/URL|ROUTE|LOCATION/.test(raw)) return 'URL';
  if (/FORBIDDEN.*TEXT|TEXT.*ABSENT|NOT.*TEXT/.test(raw)) return 'FORBIDDEN_TEXT';
  if (/FORBIDDEN.*ROLE|ROLE.*ABSENT/.test(raw)) return 'FORBIDDEN_ROLE';
  if (/HIDDEN|NOT_VISIBLE|ABSENT/.test(raw)) return 'HIDDEN';
  if (/VISIBLE|PRESENT|DISPLAYED/.test(raw)) return 'VISIBLE';
  if (/READ.?ONLY/.test(raw)) return 'READ_ONLY';
  if (/EDITABLE/.test(raw)) return 'EDITABLE';
  if (/DISABLED/.test(raw)) return 'DISABLED';
  if (/ENABLED/.test(raw)) return 'ENABLED';
  if (/CHECKED/.test(raw)) return 'CHECKED';
  if (/ATTRIBUTE/.test(raw)) return 'ATTRIBUTE';
  if (/COUNT/.test(raw)) return 'COUNT';
  if (/NUMBER|NUMERIC|AMOUNT/.test(raw)) return 'NUMBER';
  if (/VALUE|SELECTED/.test(raw)) return 'VALUE';
  if (/ROLE/.test(raw)) return 'UI_ROLE';
  if (/PAGE|STATE/.test(raw)) return 'PAGE';
  return 'UI_TEXT';
}

function expectedValueFromSignals(...sources) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const field of [
      'text',
      'value',
      'count',
      'checked',
      'url',
      'attributeValue',
      'heading',
      'title',
    ]) {
      const values = Array.isArray(source[field]) ? source[field] : [source[field]];
      const value = values.find((candidate) =>
        candidate !== undefined &&
        candidate !== null &&
        !(typeof candidate === 'string' && candidate.trim() === ''),
      );
      if (value !== undefined) return value;
    }
    const role = Array.isArray(source.role) ? source.role[0] : source.role;
    if (role && typeof role === 'object') {
      const value = role.name || role.expectedName || role.text || role.label;
      if (value != null && String(value).trim()) return value;
    }
  }
  return null;
}

function assertionExpectedFromContract(step) {
  const payload = step && step.payload && typeof step.payload === 'object' ? step.payload : {};
  const expectedOutcome = step && step.expectedOutcome && typeof step.expectedOutcome === 'object'
    ? step.expectedOutcome
    : {};
  return (step && (
    step.expected ??
    step.expectedText ??
    step.expectedValue ??
    step.expectedCount ??
    step.expectedChecked
  )) ?? expectedOutcome.expected ?? expectedOutcome.expectedText ?? expectedOutcome.expectedValue ??
    payload.expected ?? payload.expectedText ?? payload.expectedValue ?? payload.expectedCount ??
    payload.expectedChecked ?? expectedValueFromSignals(
      step && step.expectedSignals,
      payload.expectedSignals,
      expectedOutcome.expectedSignals,
    );
}

const OCCURRENCE_IDENTITY_NESTED_FIELDS = [
  'actionIdentity',
  'actionDispatchIdentity',
  'occurrenceIdentity',
  'stepAuthoring',
  'locatorEvidenceV2',
  'metadata',
  'provenance',
];

function identityValueSet(sources, fields) {
  const values = new Set();
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const field of fields) {
      const value = source[field];
      if (value == null || String(value).trim() === '') continue;
      values.add(String(value).trim());
    }
  }
  return values;
}

function occurrenceIdentitySources(value) {
  const direct =
    value && (value.step || value.resolve || value.declared)
      ? [value.step, value.resolve, value.declared]
      : [value];
  const sources = direct.filter((source) => source && typeof source === 'object');
  for (const source of [...sources]) {
    for (const field of OCCURRENCE_IDENTITY_NESTED_FIELDS) {
      if (source[field] && typeof source[field] === 'object') sources.push(source[field]);
    }
    for (const locatorField of ['actionLocator', 'locatorRecipe']) {
      const locator = source[locatorField];
      if (!locator || typeof locator !== 'object') continue;
      sources.push(locator);
      for (const field of OCCURRENCE_IDENTITY_NESTED_FIELDS) {
        if (locator[field] && typeof locator[field] === 'object') sources.push(locator[field]);
      }
    }
  }
  return sources;
}

function fillMissingIdentityScope(identity, scope) {
  if (!scope || typeof scope !== 'object') return identity;
  if (!identity.runIds.size) {
    identity.runIds = identityValueSet(
      [scope],
      ['runId', 'testRunId', 'runResultId', 'executionRunId'],
    );
  }
  if (!identity.caseIds.size) {
    identity.caseIds = identityValueSet([scope], ['caseId', 'testCaseId', 'sourceCaseId']);
  }
  return identity;
}

function occurrenceIdentityFor(value, scope = null) {
  const sources = occurrenceIdentitySources(value);
  const identity = fillMissingIdentityScope(
    {
      runIds: identityValueSet(sources, ['runId', 'testRunId', 'runResultId', 'executionRunId']),
      caseIds: identityValueSet(sources, ['caseId', 'testCaseId', 'sourceCaseId']),
      occurrenceIds: identityValueSet(sources, ['actionOccurrenceId', 'sourceActionOccurrenceId']),
      authoredActionIds: identityValueSet(sources, ['authoredActionId', 'sourceAuthoredActionId']),
      occurrenceKeys: identityValueSet(sources, ['occurrenceKey', 'sourceOccurrenceKey']),
      sequences: identityValueSet(sources, [
        'sequenceIndex',
        'authoredSequenceIndex',
        'sourceSequenceIndex',
      ]),
      ordinals: identityValueSet(sources, [
        'occurrenceOrdinal',
        'authoredOccurrenceOrdinal',
        'sourceOccurrenceOrdinal',
        'ordinal',
      ]),
      operations: new Set(),
    },
    (value && value.scope) || scope,
  );
  const operationValues = identityValueSet(sources, ['operation', 'action']);
  const directOperation =
    (value && value.action) || (value && value.step && value.step.action) || (value && value.op);
  if (directOperation != null && String(directOperation).trim())
    operationValues.add(String(directOperation));
  for (const operation of operationValues) {
    const normalized = normalizedAction(operation);
    if (normalized) identity.operations.add(normalized);
  }
  identity.stable =
    identity.occurrenceIds.size > 0 ||
    identity.authoredActionIds.size > 0 ||
    identity.occurrenceKeys.size > 0 ||
    ((identity.sequences.size > 0 || identity.ordinals.size > 0) &&
      (identity.runIds.size > 0 || identity.caseIds.size > 0));
  return identity;
}

function setsOverlap(left, right) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function compatibleWhenShared(left, right) {
  return !left.size || !right.size || setsOverlap(left, right);
}

function stableOccurrenceRelationship(leftValue, rightValue, scope = null) {
  return immutableOccurrenceRelationship(leftValue, rightValue, scope);
}

function immutableOccurrenceRelationship(leftValue, rightValue, scope = null) {
  const left = occurrenceIdentityFor(leftValue, scope);
  const right = occurrenceIdentityFor(rightValue, scope);
  const sharedOccurrenceId = setsOverlap(left.occurrenceIds, right.occurrenceIds);
  const sharedOccurrenceKey = setsOverlap(left.occurrenceKeys, right.occurrenceKeys);
  if (!sharedOccurrenceId && !sharedOccurrenceKey) return false;
  for (const field of ['runIds', 'caseIds', 'operations']) {
    if (!compatibleWhenShared(left[field], right[field])) return false;
  }
  if (
    left.occurrenceIds.size &&
    right.occurrenceIds.size &&
    !sharedOccurrenceId
  )
    return false;
  if (
    left.occurrenceKeys.size &&
    right.occurrenceKeys.size &&
    !sharedOccurrenceKey
  )
    return false;
  return true;
}

function stepIdentity(step) {
  if (!step || typeof step !== 'object') return null;
  const value = step.contractStepId || step.stepId || step.id || step.targetRef || null;
  return value == null || String(value).trim() === '' ? null : String(value);
}

function declaredIdentity(step) {
  if (!step || typeof step !== 'object') return null;
  const value = step.id || step.stepId || step.contractStepId || null;
  return value == null || String(value).trim() === '' ? null : String(value);
}

function isEvidenceOnly(step) {
  if (!step || typeof step !== 'object') return false;
  const origin = String(step.origin || '').toLowerCase();
  const isAuthoritativeExecutedWait =
    step.op === 'waitFor' &&
    origin === 'executed_case_ast' &&
    step.executed === true &&
    String(step.executionOutcome || '').toLowerCase() === 'succeeded';
  if (isAuthoritativeExecutedWait) return false;
  return (
    step.authored === false ||
    step.evidenceOnly === true ||
    origin === 'unmatched_runtime_evidence' ||
    origin === 'unbound_runtime_evidence'
  );
}

const POSITIVE_EXECUTION_STATES = new Set([
  'complete',
  'completed',
  'matched',
  'pass',
  'passed',
  'success',
  'succeeded',
]);
const NEGATIVE_EXECUTION_STATES = new Set([
  'blocked',
  'cancelled',
  'canceled',
  'error',
  'fail',
  'failed',
  'failure',
  'not_matched',
  'skipped',
  'timed_out',
  'timeout',
]);
const TRUSTED_RUNTIME_ORIGINS = new Set([
  'canonical_live_script_ledger',
  'runtime_evidence',
  'runtime_required_operation',
  'verified_runtime_action',
]);

function normalizedExecutionState(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function positiveActionExecutionProof(step) {
  if (!step || step.op !== 'act' || step.diagnosticOnly === true || step.executable === false)
    return false;
  const statuses = [
    step.status,
    step.executionStatus,
    step.runtimeStatus,
    step.actionStatus,
    step.outcome,
    step.resultStatus,
  ]
    .map(normalizedExecutionState)
    .filter(Boolean);
  const explicitFailure = step.ok === false || step.success === false || step.executed === false;
  if (explicitFailure || statuses.some((status) => NEGATIVE_EXECUTION_STATES.has(status)))
    return false;
  const explicitSuccess =
    step.ok === true ||
    step.success === true ||
    step.executed === true ||
    statuses.some((status) => POSITIVE_EXECUTION_STATES.has(status));
  if (!explicitSuccess) return false;
  return !!(
    step.canonicalExecution === true ||
    step.canonicalLiveLedger === true ||
    step.runtimeEvidence === true ||
    step.observedOnly === true ||
    step.captureEvidenceHydrated === true ||
    String(step.actionEvidenceId || step.executionEvidenceId || '').trim() ||
    TRUSTED_RUNTIME_ORIGINS.has(normalizedExecutionState(step.origin))
  );
}

function evaluatedAssertionEvidence(step) {
  if (!step || typeof step !== 'object') return false;
  if (step.checked === true || typeof step.matched === 'boolean') return true;
  if (String(step.assertionEvidenceId || '').trim()) return true;
  if (step.evaluated !== true) return false;
  return [
    step.assertionSource,
    step.evidenceSource,
    step.verificationSource,
    step.source,
    step.origin,
    step.operationClass,
    step.kind,
  ]
    .map(normalizedExecutionState)
    .some((source) => source.includes('assert'));
}

function nearestResolve(steps, actIndex, target) {
  if (!target) return null;
  for (let index = actIndex - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step && step.op === 'resolve' && step.as === target) return { step, index };
  }
  for (let index = actIndex + 1; index < steps.length; index += 1) {
    const step = steps[index];
    if (step && step.op === 'resolve' && step.as === target) return { step, index };
  }
  return null;
}

function primaryLocator(recipe) {
  if (!recipe || typeof recipe !== 'object') return null;
  return actionLocatorResolver.primaryActionLocator(recipe) || recipe;
}

function locatorExpression(recipe) {
  const primary = primaryLocator(recipe);
  return String(
    primary?.frameworkExpressions?.playwright ||
      primary?.expression ||
      primary?.primaryExpression ||
      '',
  )
    .replace(/^page\./, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function backendNodeId(identity) {
  const value = Number(identity && identity.backendNodeId);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function transientLocatorExpression(expression) {
  const normalized = String(expression || '').toLowerCase();
  return (
    !normalized ||
    normalized.includes('data-qaai-cdp-action-target') ||
    normalized.includes('data-qaai-cdp-candidate-') ||
    /#pn_id_\d+\b/.test(normalized)
  );
}

function candidateNodeId(candidate) {
  const proof = candidate?.proof && typeof candidate.proof === 'object' ? candidate.proof : {};
  return (
    backendNodeId(proof.targetIdentity) ||
    backendNodeId(proof.matchedIdentity) ||
    Number(proof.expectedBackendNodeId) ||
    Number(proof.matchedBackendNodeId) ||
    backendNodeId(candidate?.matchedCapture?.identity) ||
    backendNodeId(candidate?.matchedCapture)
  );
}

function candidateProvesExactNode(candidate, expectedNodeId) {
  if (!candidate || !expectedNodeId) return false;
  const proof = candidate.proof && typeof candidate.proof === 'object' ? candidate.proof : {};
  const targetNodeId =
    backendNodeId(proof.targetIdentity) || Number(proof.expectedBackendNodeId) || null;
  const matchedNodeId =
    backendNodeId(proof.matchedIdentity) || Number(proof.matchedBackendNodeId) || null;
  return (
    candidate.verified === true &&
    Number(candidate.count) === 1 &&
    proof.verified === true &&
    proof.backendNodeVerified === true &&
    proof.sameElement === true &&
    Number(proof.count) === 1 &&
    targetNodeId === expectedNodeId &&
    matchedNodeId === expectedNodeId
  );
}

function authoritativeAtlasCandidates(domAtlas) {
  const byBackendNodeId = new Map();
  const pages = domAtlas?.pages && typeof domAtlas.pages === 'object'
    ? Object.values(domAtlas.pages)
    : [];
  for (const pageEntry of pages) {
    const verifiedActions = Array.isArray(pageEntry?.verifiedActions)
      ? pageEntry.verifiedActions
      : [];
    for (const action of verifiedActions) {
      const pre = action?.context?.authoritativeCdp?.pre;
      const candidates = [
        ...(Array.isArray(pre?.verifiedCandidates) ? pre.verifiedCandidates : []),
        ...(pre?.selectedCandidate ? [pre.selectedCandidate] : []),
      ];
      for (const candidate of candidates) {
        const nodeId = candidateNodeId(candidate);
        if (!nodeId || !candidateProvesExactNode(candidate, nodeId)) continue;
        const records = byBackendNodeId.get(nodeId) || [];
        if (!records.some((record) => locatorExpression(record) === locatorExpression(candidate))) {
          records.push(candidate);
          byBackendNodeId.set(nodeId, records);
        }
      }
    }
  }
  return byBackendNodeId;
}

function stableCssAttribute(attributes) {
  if (!attributes || typeof attributes !== 'object') return null;
  const priorities = [
    'data-testid',
    'data-test',
    'data-qa',
    'formcontrolname',
    'name',
    'inputid',
    'placeholder',
    'aria-label',
    'id',
  ];
  for (const name of priorities) {
    const value = String(attributes[name] == null ? '' : attributes[name]).trim();
    if (!value || /qaai-cdp/i.test(name) || /qaai-cdp/i.test(value)) continue;
    if (name === 'id' && /^(?:pn_id_|mat-|react-select-|ember|headlessui-).*\d/i.test(value)) {
      continue;
    }
    return { name, value };
  }
  return null;
}

function cssQuoted(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function stableTargetClass(attributes) {
  const tokens = String(attributes?.class || '')
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) =>
      !/^(?:p-element|p-ripple|p-component|ng-star-inserted|ng-[\w-]+|active|open|selected|disabled)$/i.test(
        token,
      ),
    );
  return (
    tokens.find((token) => /(?:dropdown|trigger|toggle|submit|checkbox|radio|input|option)/i.test(token)) ||
    tokens.find((token) => token.length >= 6) ||
    null
  );
}

function capturedStructuralCandidate(candidates, expectedNodeId) {
  for (const candidate of candidates || []) {
    if (!candidateProvesExactNode(candidate, expectedNodeId)) continue;
    const capture = candidate.matchedCapture;
    const target = capture?.node;
    const ancestry = Array.isArray(capture?.ancestry) ? capture.ancestry : [];
    if (!target || !ancestry.length) continue;
    const scopeNode = ancestry.find((node) => stableCssAttribute(node?.attributes));
    const scopeAttribute = stableCssAttribute(scopeNode?.attributes);
    if (!scopeNode || !scopeAttribute) continue;
    const targetTag = String(target.localName || target.nodeName || '').toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(targetTag)) continue;
    const targetAttribute = stableCssAttribute(target.attributes);
    const targetClass = stableTargetClass(target.attributes);
    let targetSelector = targetTag;
    if (targetAttribute) {
      targetSelector += `[${targetAttribute.name}='${cssQuoted(targetAttribute.value)}']`;
    } else if (targetClass) {
      targetSelector += `.${targetClass.replace(/[^a-z0-9_-]/gi, '')}`;
    } else {
      continue;
    }
    const scopeTag = String(scopeNode.localName || scopeNode.nodeName || '').toLowerCase();
    const scopeSelector = `${/^[a-z][a-z0-9-]*$/.test(scopeTag) ? scopeTag : ''}[${
      scopeAttribute.name
    }='${cssQuoted(scopeAttribute.value)}']`;
    const expression = `locator(${JSON.stringify(scopeSelector)}).locator(${JSON.stringify(
      targetSelector,
    )})`;
    return {
      ...candidate,
      strategy: 'authoritative_cdp_structural_scope',
      expression,
      selector: `${scopeSelector} ${targetSelector}`,
      proof: {
        ...(candidate.proof || {}),
        derivedFromAuthoritativeCapture: true,
        capturedBackendNodeId: expectedNodeId,
        expressionVerification: 'authoritative_cdp_snapshot_structure',
      },
    };
  }
  return null;
}

function preferredDurableCandidate(primaryCandidate, atlasCandidates, expectedNodeId) {
  if (!transientLocatorExpression(locatorExpression(primaryCandidate))) return primaryCandidate;
  const durable = (atlasCandidates || []).find(
    (candidate) =>
      candidateProvesExactNode(candidate, expectedNodeId) &&
      !transientLocatorExpression(locatorExpression(candidate)),
  );
  return durable || capturedStructuralCandidate(atlasCandidates, expectedNodeId) || primaryCandidate;
}

function canonicalPersistedCdpCandidate(primary) {
  if (!primary || typeof primary !== 'object') return null;
  const expression = locatorExpression(primary);
  const proof = primary.proof && typeof primary.proof === 'object' ? primary.proof : {};
  const source = String(
    primary.verificationSource || primary.evidenceSource || proof.source || primary.source || '',
  );
  const targetNodeId = backendNodeId(proof.targetIdentity || primary.targetIdentity);
  const matchedNodeId = backendNodeId(proof.matchedIdentity || primary.matchedIdentity);
  const captureBinding = primary.captureBinding || primary.context?.captureBinding || null;
  const pre = primary.captureEvidence?.pre || null;

  if (
    primary.schemaVersion !== 'qaai-locator-recipe-v1' ||
    source !== 'authoritative_chromium_cdp' ||
    primary.verified !== true ||
    proof.verified !== true ||
    Number(proof.count) !== 1 ||
    proof.sameElement !== true ||
    proof.actionTimeResolved !== true ||
    proof.identityVerified !== true ||
    proof.stableAcrossSnapshots !== true ||
    !expression ||
    !targetNodeId ||
    targetNodeId !== matchedNodeId ||
    captureBinding?.kind !== 'mcp_bound_ref' ||
    Number(captureBinding.backendNodeId) !== targetNodeId ||
    pre?.captured !== true ||
    pre?.authoritative !== true ||
    pre?.source !== 'chromium_cdp' ||
    backendNodeId(pre.identity || pre) !== targetNodeId
  ) {
    return null;
  }

  return (Array.isArray(primary.candidates) ? primary.candidates : []).find((candidate) => {
    const candidateExpression = locatorExpression(candidate);
    const candidateProof = candidate?.proof && typeof candidate.proof === 'object'
      ? candidate.proof
      : {};
    const candidateTargetId = backendNodeId(candidateProof.targetIdentity);
    const candidateMatchedId = backendNodeId(candidateProof.matchedIdentity);
    return (
      candidateExpression === expression &&
      candidateProof.verified === true &&
      candidateProof.authoritativeCdpVerified === true &&
      candidateProof.backendNodeVerified === true &&
      candidateProof.actionTimeResolved === true &&
      candidateProof.identityVerified === true &&
      candidateProof.sameElement === true &&
      candidateProof.sameElementAcrossSnapshots === true &&
      candidateProof.stableAcrossSnapshots === true &&
      Number(candidateProof.count) === 1 &&
      Number(candidateProof.countBefore) === 1 &&
      Number(candidateProof.countAfter) === 1 &&
      candidateTargetId === targetNodeId &&
      candidateMatchedId === targetNodeId &&
      Number(candidateProof.expectedBackendNodeId) === targetNodeId &&
      Number(candidateProof.matchedBackendNodeId) === targetNodeId &&
      Number(candidateProof.backendNodeIdBefore) === targetNodeId &&
      Number(candidateProof.backendNodeIdAfter) === targetNodeId
    );
  }) || null;
}

function canonicalizePersistedActionLocator(recipe, atlasCandidatesByNodeId = new Map()) {
  if (!recipe || typeof recipe !== 'object') return recipe;
  if (recipe.kind === 'multi' && Array.isArray(recipe.fields)) {
    return {
      ...recipe,
      fields: recipe.fields.map((field) =>
        field?.actionLocator
          ? {
              ...field,
              actionLocator: canonicalizePersistedActionLocator(
                field.actionLocator,
                atlasCandidatesByNodeId,
              ),
            }
          : field,
      ),
    };
  }
  if (recipe.kind === 'drag') {
    return {
      ...recipe,
      dragSourceLocator: canonicalizePersistedActionLocator(
        recipe.dragSourceLocator,
        atlasCandidatesByNodeId,
      ),
      dragTargetLocator: canonicalizePersistedActionLocator(
        recipe.dragTargetLocator,
        atlasCandidatesByNodeId,
      ),
    };
  }

  const primary = primaryLocator(recipe);
  const candidate = canonicalPersistedCdpCandidate(primary);
  if (!candidate) return recipe;
  const targetNodeId = backendNodeId(primary.proof?.targetIdentity);
  const preferredCandidate = preferredDurableCandidate(
    candidate,
    atlasCandidatesByNodeId.get(targetNodeId) || [],
    targetNodeId,
  );
  const preferredExpression = locatorExpression(preferredCandidate);
  const candidateProof = preferredCandidate.proof;
  const proof = { ...candidateProof, ...(primary.proof || {}) };
  const matchedIdentity = proof.matchedIdentity || proof.targetIdentity;
  const captureEvidence = primary.captureEvidence && typeof primary.captureEvidence === 'object'
    ? primary.captureEvidence
    : {};
  const post = captureEvidence.post || {
    schema: 'qaai-authoritative-cdp-action-target/1',
    captured: true,
    authoritative: true,
    source: 'chromium_cdp',
    phase: 'post_action_stabilized',
    backendNodeId: backendNodeId(matchedIdentity),
    identity: matchedIdentity,
  };
  const normalized = {
    ...primary,
    expression: preferredExpression,
    primaryExpression: preferredExpression,
    frameworkExpressions: {
      ...(primary.frameworkExpressions || {}),
      playwright: preferredExpression,
    },
    verificationSource:
      primary.verificationSource || primary.evidenceSource || proof.source || primary.source,
    evidenceSource:
      primary.evidenceSource || primary.verificationSource || proof.source || primary.source,
    proof,
    captureEvidence: { ...captureEvidence, post },
    locatorProvenance: {
      ...(primary.locatorProvenance || {}),
      source: 'authoritative_chromium_cdp',
      strategy: preferredCandidate.strategy || primary.locatorProvenance?.strategy || null,
      backendNodeId: targetNodeId,
      ...(preferredExpression !== locatorExpression(candidate)
        ? {
            replacedTransientExpression: locatorExpression(candidate),
            durableExpressionSelectedFromDomAtlas: true,
          }
        : {}),
    },
    candidates: [
      preferredCandidate,
      ...(Array.isArray(primary.candidates)
        ? primary.candidates.filter(
            (existing) => locatorExpression(existing) !== preferredExpression,
          )
        : []),
    ],
  };
  return primary === recipe ? normalized : { ...recipe, ...normalized };
}

function canonicalizePersistedLocatorEvidence(steps, domAtlas) {
  const atlasCandidatesByNodeId = authoritativeAtlasCandidates(domAtlas);
  const locatorFields = [
    'actionLocator',
    'locatorRecipe',
    'dragSourceLocator',
    'dragTargetLocator',
    'destinationActionLocator',
    'destinationLocatorRecipe',
  ];
  for (const step of steps || []) {
    if (!step || typeof step !== 'object') continue;
    for (const field of locatorFields) {
      if (step[field] && typeof step[field] === 'object') {
        step[field] = canonicalizePersistedActionLocator(
          step[field],
          atlasCandidatesByNodeId,
        );
      }
    }
  }
}

function verifiedRecipe(record) {
  const candidates = [
    record && record.step && record.step.actionLocator,
    record && record.resolve && record.resolve.actionLocator,
    record && record.step && record.step.locatorRecipe,
    record && record.resolve && record.resolve.locatorRecipe,
  ];
  return candidates.find((recipe) => actionLocatorResolver.isVerifiedActionLocator(recipe)) || null;
}

function locatorTargetFacts(recipe) {
  const primary = primaryLocator(recipe);
  return primary && primary.targetFacts && typeof primary.targetFacts === 'object'
    ? primary.targetFacts
    : {};
}

function cleanTargetText(value) {
  return String(value == null ? '' : value)
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, ' ')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function targetTokens(value) {
  const tokens = cleanTargetText(value).split(' ').filter(Boolean);
  return new Set(tokens.filter((token) => !TARGET_STOP_WORDS.has(token)));
}

function targetTextCandidates(record) {
  const step = (record && record.step) || {};
  const resolve = (record && record.resolve) || {};
  const declared = (record && record.declared) || {};
  const recipe = verifiedRecipe(record) || step.actionLocator || resolve.actionLocator || null;
  const facts = locatorTargetFacts(recipe);
  const primary = primaryLocator(recipe) || {};
  const values = [
    declared.target,
    declared.element,
    declared.label,
    declared.name,
    declared.text,
    declared.plannedText,
    declared.description,
    resolve.elementLabel,
    resolve.narration,
    resolve.targetLabel,
    resolve.targetName,
    step.elementLabel,
    step.narration,
    step.targetLabel,
    step.targetName,
    facts.accessibleName,
    facts.label,
    facts.placeholder,
    facts.text,
    facts.testId,
    primary.elementLabel,
    primary.accessibleName,
  ];
  for (const candidate of Array.isArray(resolve.candidates) ? resolve.candidates : []) {
    values.push(
      candidate && (candidate.name || candidate.text || candidate.label || candidate.testId),
    );
  }
  return Array.from(
    new Set(values.map((value) => String(value == null ? '' : value).trim()).filter(Boolean)),
  );
}

function roleForRecord(record) {
  const recipe =
    verifiedRecipe(record) || record?.step?.actionLocator || record?.resolve?.actionLocator || null;
  const facts = locatorTargetFacts(recipe);
  const candidates = Array.isArray(record?.resolve?.candidates) ? record.resolve.candidates : [];
  return String(
    facts.role ||
      record?.declared?.role ||
      record?.declared?.targetRole ||
      record?.resolve?.role ||
      candidates.find((candidate) => candidate && candidate.role)?.role ||
      '',
  ).toLowerCase();
}

function compatibleRoles(left, right) {
  if (!left || !right || left === right) return true;
  const textEntryRoles = new Set(['textbox', 'searchbox']);
  return textEntryRoles.has(left) && textEntryRoles.has(right);
}

function semanticSimilarity(leftRecord, rightRecord) {
  const leftValues = targetTextCandidates(leftRecord);
  const rightValues = targetTextCandidates(rightRecord);
  let best = 0;
  for (const leftValue of leftValues) {
    const leftClean = cleanTargetText(leftValue);
    const leftTokens = targetTokens(leftValue);
    if (!leftTokens.size) continue;
    for (const rightValue of rightValues) {
      const rightClean = cleanTargetText(rightValue);
      const rightTokens = targetTokens(rightValue);
      if (!rightTokens.size) continue;
      if (leftClean === rightClean) return 1;
      let intersection = 0;
      for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
      if (!intersection) continue;
      const containment = intersection / Math.min(leftTokens.size, rightTokens.size);
      const dice = (2 * intersection) / (leftTokens.size + rightTokens.size);
      let score = containment * 0.7 + dice * 0.3;
      if (intersection === 1 && Math.min(leftTokens.size, rightTokens.size) === 1)
        score = Math.max(score, 0.82);
      if (score > best) best = score;
    }
  }
  return best;
}

function identitySet(record) {
  const step = (record && record.step) || {};
  const resolve = (record && record.resolve) || {};
  const runtimeSourceId = step.sourceContractStepId || resolve.sourceContractStepId || null;
  const projectedId = step.contractStepId || resolve.contractStepId || null;
  // Partial ReplayIR reconstruction can project one runtime operation onto the
  // first authored step it encounters. When the original runtime identity is
  // retained separately, using the projection for matching would silently
  // attach a locator to the wrong one of repeated semantic actions.
  if (
    record &&
    record.evidenceOnly &&
    runtimeSourceId &&
    projectedId &&
    String(runtimeSourceId) !== String(projectedId)
  ) {
    return new Set([String(runtimeSourceId)]);
  }
  const values = [
    step.contractStepId,
    step.sourceContractStepId,
    step.stepAuthoringId,
    resolve.contractStepId,
    resolve.sourceContractStepId,
    resolve.stepAuthoringId,
  ];
  return new Set(values.filter((value) => value != null && String(value).trim()).map(String));
}

function identitiesOverlap(left, right) {
  const leftIds = identitySet(left);
  if (!leftIds.size) return false;
  for (const id of identitySet(right)) if (leftIds.has(id)) return true;
  return false;
}

function matchScore(authored, evidence) {
  if (!authored || !evidence || authored.action !== evidence.action) return -1;
  if (!verifiedRecipe(evidence)) return -1;
  if (!compatibleRoles(roleForRecord(authored), roleForRecord(evidence))) return -1;
  const runtimeSourceId =
    evidence.step?.sourceContractStepId || evidence.resolve?.sourceContractStepId || null;
  const projectedId = evidence.step?.contractStepId || evidence.resolve?.contractStepId || null;
  if (
    evidence.evidenceOnly &&
    runtimeSourceId &&
    projectedId &&
    String(runtimeSourceId) !== String(projectedId)
  ) {
    const authoredIds = identitySet(authored);
    if (authoredIds.has(String(projectedId)) && !authoredIds.has(String(runtimeSourceId)))
      return -1;
  }
  const occurrenceRelationship = stableOccurrenceRelationship(authored, evidence);
  if (occurrenceRelationship === false) return -1;
  if (occurrenceRelationship === true) return 3;
  if (identitiesOverlap(authored, evidence)) return 2;
  return semanticSimilarity(authored, evidence);
}

function uniquelyBest(scored) {
  const ordered = scored
    .filter((entry) => entry.score >= 0.8)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  if (!ordered.length) return null;
  if (ordered[0].score >= 2) return ordered[0];
  if (ordered.length > 1 && Math.abs(ordered[0].score - ordered[1].score) < 0.08) return null;
  return ordered[0];
}

function copyPageContext(target, evidenceRecord) {
  const primary = primaryLocator(verifiedRecipe(evidenceRecord));
  const sources = [
    evidenceRecord?.resolve,
    evidenceRecord?.step,
    primary,
    primary?.context,
  ];
  for (const field of PAGE_CONTEXT_FIELDS) {
    if (target[field] != null) continue;
    const source = sources.find((candidate) => candidate && candidate[field] != null);
    if (source) target[field] = source[field];
  }
  if (!target.pageUrl) target.pageUrl = pageUrlFromCapturedContext(...sources) || target.pageUrl;
}

function pageUrlFromCapturedContext(...sources) {
  const queue = sources.filter((source) => source && typeof source === 'object');
  const seen = new Set();
  while (queue.length) {
    const source = queue.shift();
    if (!source || typeof source !== 'object' || seen.has(source)) continue;
    seen.add(source);
    for (const field of ['pageUrl', 'url', 'documentUrl']) {
      const value = stableObservedUrl(source[field]);
      if (value) return value;
    }
    for (const field of [
      'pageIdentity',
      'captureBinding',
      'fingerprint',
      'context',
      'contextEvidence',
      'proof',
      'targetIdentity',
      'matchedIdentity',
    ]) {
      if (source[field] && typeof source[field] === 'object') queue.push(source[field]);
    }
  }
  return null;
}

function promoteEmbeddedLocatorContext(steps) {
  for (const step of steps || []) {
    if (!step || !['resolve', 'act', 'assert', 'waitFor'].includes(step.op)) continue;
    const recipe = step.actionLocator || step.locatorRecipe || null;
    const primary = primaryLocator(recipe);
    const sources = [
      primary,
      primary?.context,
      recipe,
      recipe?.context,
      step.pageIdentity,
      step.captureBinding,
      step.proof,
    ];
    for (const field of PAGE_CONTEXT_FIELDS) {
      if (step[field] != null) continue;
      const source = sources.find((candidate) => candidate && candidate[field] != null);
      if (source) step[field] = source[field];
    }
    if (!step.pageUrl) step.pageUrl = pageUrlFromCapturedContext(...sources) || step.pageUrl;
  }
}

function clearGuessedState(step) {
  if (!step || typeof step !== 'object') return;
  delete step.guessedLocator;
  delete step.guessed;
  delete step.guessedLocatorCandidates;
  delete step.guessedLocatorFields;
  delete step.locatorProvenance;
  if (String(step.locatorConfidence || '').toLowerCase() === 'guessed')
    delete step.locatorConfidence;
}

function mergeAttachedEvidenceContext(authored, evidence) {
  copyPageContext(authored.step, evidence);
  if (authored.resolve) {
    copyPageContext(authored.resolve, evidence);
  }
  for (const field of [
    'button',
    'modifiers',
    'clickCount',
    'optionValues',
    'filePaths',
    'destinationTarget',
  ]) {
    if (authored.step[field] == null && evidence.step && evidence.step[field] != null)
      authored.step[field] = evidence.step[field];
  }
  const evidenceValueRef = String(evidence?.step?.valueRef || '').trim();
  if (
    authored.step.valueRef == null &&
    /^(?:env|vault|fixture|masked|data):[^\s]+$/i.test(evidenceValueRef)
  ) {
    authored.step.valueRef = evidenceValueRef;
  }
  const evidenceValueBinding = evidence?.step?.valueBinding;
  const safeBindingKinds = new Set([
    'literal',
    'secret_env',
    'workbook_column',
    'runtime_output',
    'dependency_output',
    'generated_value',
  ]);
  if (
    authored.step.valueBinding == null &&
    evidenceValueBinding &&
    typeof evidenceValueBinding === 'object' &&
    safeBindingKinds.has(String(evidenceValueBinding.kind || '').toLowerCase())
  ) {
    authored.step.valueBinding = { ...evidenceValueBinding };
  }
}

function attachVerifiedEvidence(authored, evidence) {
  const recipe = verifiedRecipe(evidence);
  if (!recipe) return false;
  authored.step.actionLocator = recipe;
  clearGuessedState(authored.step);
  mergeAttachedEvidenceContext(authored, evidence);
  if (authored.resolve) {
    authored.resolve.actionLocator = recipe;
    const capturedCandidates =
      Array.isArray(evidence.resolve?.candidates) && evidence.resolve.candidates.length
        ? evidence.resolve.candidates
        : actionLocatorResolver.candidatesFromActionLocator(recipe);
    if (Array.isArray(capturedCandidates) && capturedCandidates.length)
      authored.resolve.candidates = capturedCandidates;
    clearGuessedState(authored.resolve);
  }
  return true;
}

function declaredStepMap(declaredSteps) {
  const map = new Map();
  for (const step of Array.isArray(declaredSteps) ? declaredSteps : []) {
    const id = declaredIdentity(step);
    if (id && !map.has(id)) map.set(id, step);
  }
  return map;
}

function semanticIdentifier(value, fallback = 'target') {
  const words = cleanTargetText(value).split(' ').filter(Boolean);
  if (!words.length) return fallback;
  const [first, ...rest] = words;
  return `${first}${rest.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('')}`;
}

function semanticRoleForAction(action) {
  if (['fill', 'type'].includes(action)) return 'textbox';
  if (['check', 'uncheck'].includes(action)) return 'checkbox';
  if (action === 'selectOption') return 'combobox';
  if (action === 'press') return 'textbox';
  return 'button';
}

function semanticIdentifierWithRole(value, role, fallback = 'target') {
  const identifier = semanticIdentifier(value, fallback);
  const normalizedRole = String(role || '').trim().toLowerCase();
  if (!normalizedRole) return identifier;
  const roleSuffix = normalizedRole.charAt(0).toUpperCase() + normalizedRole.slice(1);
  return identifier.toLowerCase().endsWith(normalizedRole)
    ? identifier
    : `${identifier}${roleSuffix}`;
}

function allocateSemanticAlias(aliases, baseAlias) {
  const base = String(baseAlias || 'guessedControl').trim() || 'guessedControl';
  if (!aliases.has(base)) {
    aliases.add(base);
    return base;
  }
  for (const suffix of ['Alternate', 'Secondary', 'Additional']) {
    const candidate = `${base}${suffix}`;
    if (!aliases.has(candidate)) {
      aliases.add(candidate);
      return candidate;
    }
  }
  let candidate = `${base}Alternative`;
  while (aliases.has(candidate)) candidate += 'Alternative';
  aliases.add(candidate);
  return candidate;
}

function countBy(values, keyFor) {
  const counts = new Map();
  for (const value of values || []) {
    const key = keyFor(value);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function declaredWaitPayload(step) {
  if (!step || typeof step !== 'object') return null;
  for (const candidate of [
    step.waitContract,
    step.wait,
    step.condition,
    step.payload && step.payload.waitContract,
    step.payload && step.payload.wait,
    step.payload && step.payload.condition,
  ]) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate;
  }
  return null;
}

function isDeclaredWaitStep(step) {
  if (!step || typeof step !== 'object') return false;
  if (step.waitContract && typeof step.waitContract === 'object') return true;
  const operation = normalizedContractToken(
    step.op ||
      step.operation ||
      step.authoredOperation ||
      step.originalAction ||
      step.action ||
      step.type,
  );
  return new Set(['wait', 'wait_for', 'waitfor', 'browser_wait_for']).has(operation);
}

function declaredWaitKey(step) {
  const id = declaredIdentity(step);
  return id && isDeclaredWaitStep(step) ? id : null;
}

function emittedWaitKey(step) {
  if (!step || step.op !== 'waitFor' || isEvidenceOnly(step)) return null;
  return step.waitContractId || step.contractStepId || step.stepId || step.id || null;
}

function copyDeclaredOccurrenceIdentity(target, declared) {
  for (const field of [
    'runId',
    'testRunId',
    'runResultId',
    'executionRunId',
    'caseId',
    'testCaseId',
    'sourceCaseId',
    'actionOccurrenceId',
    'sourceActionOccurrenceId',
    'authoredActionId',
    'sourceAuthoredActionId',
    'occurrenceKey',
    'sourceOccurrenceKey',
    'sequenceIndex',
    'authoredSequenceIndex',
    'sourceSequenceIndex',
    'occurrenceOrdinal',
    'authoredOccurrenceOrdinal',
    'sourceOccurrenceOrdinal',
    'actionIdentity',
    'actionDispatchIdentity',
    'stepAuthoring',
  ]) {
    if (target[field] == null && declared && declared[field] != null)
      target[field] = declared[field];
  }
}

function ensureDeclaredWaitOccurrenceIdentities(declaredSteps, scope) {
  const ordinals = new Map();
  for (const [index, step] of (Array.isArray(declaredSteps) ? declaredSteps : []).entries()) {
    if (!isDeclaredWaitStep(step)) continue;
    const id = declaredIdentity(step);
    if (!id) continue;
    const ordinal = (ordinals.get(id) || 0) + 1;
    ordinals.set(id, ordinal);
    if (occurrenceIdentityFor(step, scope).stable) continue;
    const sequenceIndex = Number(step.sequenceIndex || step.authoredSequenceIndex) || index + 1;
    const runId = String((scope && scope.runId) || 'authored-run');
    const caseId = String((scope && scope.caseId) || 'authored-case');
    step.sequenceIndex = sequenceIndex;
    step.occurrenceOrdinal = ordinal;
    step.operation = 'waitFor';
    step.waitContractId = step.waitContractId || id;
    step.occurrenceKey = `${runId}:${caseId}:${sequenceIndex}:waitFor:${ordinal}`;
  }
}

function declaredActionKey(step) {
  if (isDeclaredWaitStep(step) || isDeclaredAssertionStep(step)) return null;
  const id = declaredIdentity(step);
  const action = normalizedAction(
    step && (step.authoredOperation || step.originalAction || step.action),
  );
  return id && action ? `${id}\u0000${action}` : null;
}

function emittedActionKey(step) {
  const id = stepIdentity(step);
  const action = normalizedAction(
    step && (step.authoredOperation || step.originalAction || step.action),
  );
  return id && action ? `${id}\u0000${action}` : null;
}

function deterministicSupportedAction(step) {
  const original = normalizedAction(step && step.action);
  if (AUTHORED_POM_ACTIONS.has(original)) return { action: original, original, reason: null };
  const explicit = [
    step && step.playwrightAction,
    step && step.compilerAction,
    step && step.operationContract && step.operationContract.playwrightAction,
    step && step.compilerOperation && step.compilerOperation.playwrightAction,
  ]
    .map(normalizedAction)
    .find((action) => AUTHORED_POM_ACTIONS.has(action));
  if (explicit) return { action: explicit, original, reason: 'explicit_playwright_action' };
  if (step && (step.url || step.href || step.destination)) {
    return { action: 'navigate', original, reason: 'authored_url_contract' };
  }
  if (step && (step.width != null || step.height != null || step.viewport)) {
    return { action: 'resize', original, reason: 'authored_viewport_contract' };
  }
  if (step && (step.accept != null || step.promptText != null || step.dialog === true)) {
    return { action: 'handleDialog', original, reason: 'authored_dialog_contract' };
  }
  if (step && (step.filePaths != null || step.files != null || step.filePath != null)) {
    return { action: 'upload', original, reason: 'authored_file_contract' };
  }
  if (step && (step.optionValues != null || step.options != null)) {
    return { action: 'selectOption', original, reason: 'authored_option_contract' };
  }
  if (step && (step.key != null || step.keys != null || step.keyboardValue != null)) {
    return { action: 'press', original, reason: 'authored_keyboard_contract' };
  }
  if (
    step &&
    (step.value != null ||
      step.valueRef != null ||
      step.valueBinding != null ||
      step.rawValue != null)
  ) {
    return { action: 'fill', original, reason: 'authored_value_contract' };
  }
  return { action: 'click', original, reason: 'generic_target_activation' };
}

function applyCompilerOwnedActionNormalization(step, decision) {
  if (!step || !decision || !decision.action) return;
  step.action = decision.action;
  if (!decision.original || AUTHORED_POM_ACTIONS.has(decision.original)) return;
  step.authoredOperation = decision.original;
  step.compilerOwnedGenericOperation = true;
  step.operationNormalization = {
    from: decision.original,
    to: decision.action,
    reason: decision.reason || 'deterministic_supported_normalization',
  };
}

function normalizeAuthoredActions(steps, declaredById) {
  for (const step of steps || []) {
    if (!step || step.op !== 'act' || isEvidenceOnly(step) || !step.action) continue;
    const declared = declaredById.get(stepIdentity(step)) || null;
    if (isDeclaredAssertionStep(step) || isDeclaredAssertionStep(declared)) continue;
    // Positively executed runtime evidence owns the operation. Authored metadata
    // may enrich the action, but it must never turn an observed click into a
    // select/fill (or otherwise replace what the browser actually executed).
    const source = declared
      ? { ...declared, ...step, action: step.action }
      : step;
    applyAuthoredActionOptionality(step, source, declared);
    const decision = deterministicSupportedAction(source);
    applyCompilerOwnedActionNormalization(step, decision);
    if (declared) copyDeclaredActionPayload(step, declared);
    if (declared && !step.targetLabel) {
      step.targetLabel =
        declared.target ||
        declared.element ||
        declared.label ||
        declared.name ||
        declared.text ||
        null;
    }
  }
}

function ensureDeclaredStepIdentities(declaredSteps) {
  const aliases = new Set();
  for (const [index, step] of (Array.isArray(declaredSteps) ? declaredSteps : []).entries()) {
    if (!step || typeof step !== 'object' || declaredIdentity(step)) continue;
    const action = normalizedAction(step.action) || 'operation';
    const label =
      step.target ||
      step.element ||
      step.label ||
      step.name ||
      step.text ||
      step.description ||
      action;
    const base = `authored-${semanticIdentifier(action, 'operation')}-${semanticIdentifier(label, 'step')}`;
    let identity = base;
    for (const suffix of ['alternate', 'secondary', 'additional']) {
      if (!aliases.has(identity)) break;
      identity = `${base}-${suffix}`;
    }
    while (aliases.has(identity)) identity = `${identity}-alternative`;
    aliases.add(identity);
    step.contractStepId = identity || `authored-operation-${index + 1}`;
  }
}

function copyDeclaredActionPayload(target, declared) {
  for (const field of [
    'url',
    'href',
    'destination',
    'value',
    'valueRef',
    'valueBinding',
    'rawValue',
    'accept',
    'promptText',
    'width',
    'height',
    'viewport',
    'optional',
    'optionalAbsent',
    'ifPresent',
    'ifVisible',
    'timeoutMs',
    'redirectExpected',
    'runId',
    'testRunId',
    'runResultId',
    'executionRunId',
    'caseId',
    'testCaseId',
    'sourceCaseId',
    'actionOccurrenceId',
    'sourceActionOccurrenceId',
    'authoredActionId',
    'occurrenceKey',
    'sequenceIndex',
    'authoredSequenceIndex',
    'occurrenceOrdinal',
    'actionIdentity',
    'actionDispatchIdentity',
    'stepAuthoring',
    ...PAGE_NAME_FIELDS,
  ]) {
    if (target[field] == null && declared && declared[field] != null)
      target[field] = declared[field];
  }
}

function materializeTargetlessAuthoredActions(steps) {
  const aliases = new Set(
    steps.filter((step) => step && step.op === 'resolve' && step.as).map((step) => String(step.as)),
  );

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const action = normalizedAction(step && step.action);
    if (
      !step ||
      step.op !== 'act' ||
      isEvidenceOnly(step) ||
      !TARGETED_POM_ACTIONS.has(action) ||
      String(step.target || '').trim()
    )
      continue;
    if (!positiveActionExecutionProof(step)) {
      step[DROP_FROM_RUNNABLE_SPEC] = true;
      step.executable = false;
      step.diagnosticOnly = true;
      continue;
    }

    const recipe = step.actionLocator || step.locatorRecipe || null;
    const primary = primaryLocator(recipe);
    const facts = locatorTargetFacts(recipe);
    const verified = actionLocatorResolver.isVerifiedActionLocator(recipe);
    if (!verified) {
      step[DROP_FROM_RUNNABLE_SPEC] = true;
      step.executable = false;
      step.diagnosticOnly = true;
      step.failureBoundary = {
        code: 'missing_authoritative_action_locator',
        operation: action,
        contractStepId: stepIdentity(step),
        actionOccurrenceId: step.actionOccurrenceId || null,
        message: 'The executed action had no same-node verified action-time locator, so it was retained as diagnostics instead of being guessed into runnable code.',
      };
      step.upstreamConductorRequirement = {
        code: 'UPSTREAM_CONDUCTOR_REQUIREMENT',
        consumer: 'playwrightPomJsStandardProfile.materializeTargetlessAuthoredActions',
        requiredFields: [
          'actionLocator.frameworkExpressions.playwright',
          'actionLocator.proof.actionTimeResolved',
          'actionLocator.proof.sameElement',
          'actionLocator.proof.count',
          'actionOccurrenceId',
        ],
        requiredValues: {
          'actionLocator.proof.actionTimeResolved': true,
          'actionLocator.proof.sameElement': true,
          'actionLocator.proof.count': 1,
        },
      };
      continue;
    }
    const rawLabel = [
      facts.accessibleName,
      facts.label,
      facts.placeholder,
      facts.text,
      facts.testId,
      primary && primary.elementLabel,
      step.targetLabel,
      step.elementLabel,
      step.accessibleName,
      step.label,
      step.element,
      step.name,
    ].find((value) => String(value || '').trim());
    const role = String(facts.role || semanticRoleForAction(action)).toLowerCase();
    const targetLabel = cleanTargetText(rawLabel) || `Captured ${role}`;
    const baseAlias = semanticIdentifierWithRole(targetLabel, role, 'captured');
    const alias = allocateSemanticAlias(aliases, baseAlias);
    const capturedCandidates = actionLocatorResolver.candidatesFromActionLocator(recipe);
    steps.splice(index, 0, {
      op: 'resolve',
      as: alias,
      contractStepId: stepIdentity(step),
      elementLabel: targetLabel,
      candidates: capturedCandidates,
      actionLocator: recipe,
      locatorConfidence: 'verified',
      authored: true,
    });
    index += 1;
    step.target = alias;
    step.targetLabel = targetLabel;
    clearGuessedState(step);
  }
}

function markMissingAuthoritativeLocator(step, action, resolve = null, role = 'target') {
  if (!step || typeof step !== 'object') return;
  step[DROP_FROM_RUNNABLE_SPEC] = true;
  step.executable = false;
  step.diagnosticOnly = true;
  step.failureBoundary = {
    code: 'missing_authoritative_action_locator',
    operation: action,
    targetRole: role,
    contractStepId: stepIdentity(step),
    actionOccurrenceId: step.actionOccurrenceId || null,
    message: `The executed ${action} action had no same-node verified ${role} locator, so QAAI preserved the boundary as diagnostics instead of generating a narrative locator.`,
  };
  step.upstreamConductorRequirement = {
    code: 'UPSTREAM_CONDUCTOR_REQUIREMENT',
    consumer: 'playwrightPomJsStandardProfile.enforceVerifiedRunnableLocators',
    operation: action,
    targetRole: role,
    requiredFields: [
      'actionLocator.frameworkExpressions.playwright',
      'actionLocator.proof.actionTimeResolved',
      'actionLocator.proof.sameElement',
      'actionLocator.proof.count',
      'actionOccurrenceId',
    ],
    requiredValues: {
      'actionLocator.proof.actionTimeResolved': true,
      'actionLocator.proof.sameElement': true,
      'actionLocator.proof.count': 1,
    },
  };
  if (resolve && typeof resolve === 'object') {
    resolve[DROP_FROM_RUNNABLE_SPEC] = true;
    resolve.executable = false;
    resolve.diagnosticOnly = true;
    resolve.failureBoundary = { ...step.failureBoundary };
    resolve.upstreamConductorRequirement = { ...step.upstreamConductorRequirement };
  }
}

function enforceVerifiedRunnableLocators(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const resolves = new Map(
    list.filter((step) => step && step.op === 'resolve' && step.as).map((step) => [String(step.as), step]),
  );
  for (const step of list) {
    const action = normalizedAction(step && step.action);
    if (!step || step.op !== 'act' || !TARGETED_POM_ACTIONS.has(action)) continue;
    if (step[DROP_FROM_RUNNABLE_SPEC] === true || step.diagnosticOnly === true || step.executable === false)
      continue;
    const targetRoles = action === 'drag'
      ? [['source', step.target], ['destination', step.destinationTarget]]
      : [['target', step.target]];
    for (const [role, ref] of targetRoles) {
      const resolve = ref != null ? resolves.get(String(ref)) || null : null;
      const recipeCandidates = role === 'destination'
        ? [
            step.dragTargetLocator,
            step.destinationActionLocator,
            resolve && resolve.actionLocator,
            resolve && resolve.locatorRecipe,
          ]
        : [
            step.dragSourceLocator,
            step.actionLocator,
            step.locatorRecipe,
            resolve && resolve.actionLocator,
            resolve && resolve.locatorRecipe,
          ];
      const recipe = recipeCandidates.find((candidate) =>
        actionLocatorResolver.isVerifiedActionLocator(candidate));
      if (!recipe) {
        markMissingAuthoritativeLocator(step, action, resolve, role);
        break;
      }
      if (resolve) {
        resolve.actionLocator = recipe;
        resolve.locatorConfidence = 'verified';
        clearGuessedState(resolve);
      }
      if (!step.actionLocator && role === 'target') step.actionLocator = recipe;
      clearGuessedState(step);
    }
  }
}

function buildActionRecords(steps, declaredById, occurrenceScope = null) {
  const records = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!step || step.op !== 'act' || !step.action) continue;
    const resolved = nearestResolve(steps, index, step.target);
    const id = stepIdentity(step) || stepIdentity(resolved && resolved.step);
    records.push({
      action: normalizedAction(step.authoredOperation || step.originalAction || step.action),
      step,
      stepIndex: index,
      resolve: (resolved && resolved.step) || null,
      resolveIndex: resolved && resolved.index,
      declared: (id && declaredById.get(id)) || null,
      evidenceOnly: isEvidenceOnly(step),
      scope: occurrenceScope,
      used: false,
    });
  }
  return records;
}

function authoredStepOrdinal(value) {
  if (!value || typeof value !== 'object') return null;
  for (const candidate of [
    value.authoredStepOrdinal,
    value.stepOrdinal,
    value.order,
    value.stepNumber,
  ]) {
    const numeric = Number(candidate);
    if (Number.isInteger(numeric) && numeric > 0) return numeric;
  }
  for (const candidate of [
    value.contractStepId,
    value.sourceContractStepId,
    value.stepId,
    value.id,
  ]) {
    const raw = String(candidate == null ? '' : candidate);
    const match = raw.match(/(?:^|[_:-])step[_:-]?(\d+)(?:$|[_:-])/i);
    if (match && Number(match[1]) > 0) return Number(match[1]);
  }
  return null;
}

function bindDeclaredActionOccurrencesFromVerifiedEvidence(
  steps,
  declaredSteps,
  declaredById,
  occurrenceScope,
) {
  const actionRecords = buildActionRecords(steps, declaredById, occurrenceScope);
  const evidenceRecords = actionRecords.filter(
    (record) =>
      record.evidenceOnly &&
      verifiedRecipe(record) &&
      (occurrenceIdentityFor(record, occurrenceScope).occurrenceIds.size > 0 ||
        occurrenceIdentityFor(record, occurrenceScope).occurrenceKeys.size > 0),
  );
  for (const declared of Array.isArray(declaredSteps) ? declaredSteps : []) {
    if (!declared || isDeclaredWaitStep(declared) || isDeclaredAssertionStep(declared)) continue;
    const action = deterministicSupportedAction(declared).action;
    if (!action) continue;
    const existingAuthored = actionRecords.filter(
      (record) =>
        !record.evidenceOnly &&
        record.action === action &&
        immutableOccurrenceRelationship(declared, record, occurrenceScope),
    );
    if (existingAuthored.length) continue;
    const candidates = evidenceRecords.filter(
      (record) =>
        record.action === action &&
        immutableOccurrenceRelationship(declared, record, occurrenceScope),
    );
    if (candidates.length !== 1) continue;
    const selected = candidates[0];
    copyDeclaredOccurrenceIdentity(declared, selected.step);
    copyDeclaredOccurrenceIdentity(declared, selected.resolve);
    const authoredId = declaredIdentity(declared);
    const runtimeId = stepIdentity(selected.step) || stepIdentity(selected.resolve);
    if (runtimeId && authoredId && String(runtimeId) !== String(authoredId)) {
      if (!selected.step.sourceContractStepId)
        selected.step.sourceContractStepId = String(runtimeId);
      if (selected.resolve && !selected.resolve.sourceContractStepId)
        selected.resolve.sourceContractStepId = String(runtimeId);
    }
    selected.step.contractStepId = authoredId;
    selected.step.authored = true;
    selected.step.evidenceOnly = false;
    selected.step.executable = true;
    selected.step.diagnosticOnly = false;
    selected.step.canonicalExecution = true;
    selected.step.origin = 'verified_runtime_action';
    applyAuthoredActionOptionality(selected.step, declared);
    copyDeclaredActionPayload(selected.step, declared);
    if (selected.step.valueRef != null || selected.step.valueBinding != null) {
      delete selected.step.rawValue;
      delete selected.step.value;
    }
    if (selected.resolve) {
      selected.resolve.contractStepId = authoredId;
      selected.resolve.authored = true;
      selected.resolve.evidenceOnly = false;
      selected.resolve.executable = true;
      selected.resolve.diagnosticOnly = false;
      selected.resolve.canonicalExecution = true;
      selected.resolve.origin = 'verified_runtime_action';
    }
  }
}

function applyDeclaredMetadata(record) {
  const declared = record && record.declared;
  if (!declared) return;
  applyAuthoredActionOptionality(record.step, declared);
  const timeoutMs = Number(declared.timeoutMs || declared.waitContract?.timeoutMs);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0 && record.step.timeoutMs == null)
    record.step.timeoutMs = Math.floor(timeoutMs);
  for (const field of PAGE_NAME_FIELDS) {
    if (record.resolve && record.resolve[field] == null && declared[field] != null)
      record.resolve[field] = declared[field];
    if (record.step && record.step[field] == null && declared[field] != null)
      record.step[field] = declared[field];
  }
}

function markAttachedDuplicate(record, authoredRecord) {
  record.used = true;
  record.step[ATTACHED_RUNTIME_DUPLICATE] = true;
  record.step[ATTACHED_AUTHORED_STEP] = (authoredRecord && authoredRecord.step) || null;
  if (record.resolve) record.resolve[ATTACHED_RUNTIME_DUPLICATE] = true;
}

function classifyUnmatchedRuntimeRecords(records) {
  for (const record of records.filter((candidate) => candidate.evidenceOnly)) {
    if (record.used) continue;
    if (record.action === 'navigate') continue;
    const origin = String((record.step && record.step.origin) || '')
      .trim()
      .toLowerCase();
    const status = String(
      (record.step && (record.step.status || record.step.runtimeStatus || '')) || '',
    )
      .trim()
      .toLowerCase();
    const explicitlyFailed =
      record.step &&
      (record.step.ok === false ||
        record.step.success === false ||
        ['fail', 'failed', 'error', 'blocked', 'skipped', 'cancelled', 'canceled'].includes(
          status,
        ));
    const helperOnly =
      record.step &&
      (record.step.helperOperation === true ||
        record.step.diagnosticOnly === true ||
        /diagnostic|probe|helper/.test(
          String(record.step.operationClass || record.step.kind || '').toLowerCase(),
        ));
    const identity = occurrenceIdentityFor(record);
    const scopeRunIds = identityValueSet(
      [record.scope],
      ['runId', 'testRunId', 'runResultId', 'executionRunId'],
    );
    const scopeCaseIds = identityValueSet([record.scope], ['caseId', 'testCaseId', 'sourceCaseId']);
    const currentScope =
      compatibleWhenShared(identity.runIds, scopeRunIds) &&
      compatibleWhenShared(identity.caseIds, scopeCaseIds);
    const canonicalLedger =
      origin === 'canonical_live_script_ledger' || record.step.canonicalLiveLedger === true;
    const successfulRequiredRuntime =
      record.step.required === true &&
      (record.step.runtimeEvidence === true ||
        record.step.observedOnly === true ||
        origin === 'runtime_required_operation');
    if (
      verifiedRecipe(record) &&
      !explicitlyFailed &&
      !helperOnly &&
      currentScope &&
      (canonicalLedger || successfulRequiredRuntime)
    ) {
      const decision = deterministicSupportedAction(record.step);
      applyCompilerOwnedActionNormalization(record.step, decision);
      const runtimeSourceId =
        record.step.sourceContractStepId || record.resolve?.sourceContractStepId || null;
      if (runtimeSourceId && String(runtimeSourceId) !== String(record.step.contractStepId || '')) {
        record.step.contractStepId = String(runtimeSourceId);
        if (record.resolve) record.resolve.contractStepId = String(runtimeSourceId);
      }
      record.evidenceOnly = false;
      record.step.authored = true;
      record.step.evidenceOnly = false;
      record.step.executable = true;
      record.step.diagnosticOnly = false;
      record.step.canonicalExecution = true;
      record.step.origin = 'verified_runtime_action';
      if (record.resolve) {
        record.resolve.authored = true;
        record.resolve.evidenceOnly = false;
        record.resolve.executable = true;
        record.resolve.diagnosticOnly = false;
        record.resolve.canonicalExecution = true;
        record.resolve.origin = 'verified_runtime_action';
      }
      continue;
    }
    // Failed or unverified runtime records remain available for diagnostics,
    // but cannot become runnable browser behavior.
    record.step[DROP_FROM_RUNNABLE_SPEC] = true;
    if (record.resolve) record.resolve[DROP_FROM_RUNNABLE_SPEC] = true;
  }
}

function reconcileVerifiedEvidence(records) {
  const authored = records.filter((record) => !record.evidenceOnly);
  const evidence = records.filter((record) => record.evidenceOnly && verifiedRecipe(record));
  for (const record of authored) applyDeclaredMetadata(record);
  for (const authoredRecord of authored) {
    const matches = evidence.filter(
      (candidate) =>
        !candidate.used &&
        authoredRecord.action === candidate.action &&
        immutableOccurrenceRelationship(authoredRecord, candidate, authoredRecord.scope),
    );
    if (matches.length !== 1) continue;
    const selected = matches[0];
    const attached = verifiedRecipe(authoredRecord)
      ? (mergeAttachedEvidenceContext(authoredRecord, selected), true)
      : attachVerifiedEvidence(authoredRecord, selected);
    if (attached) markAttachedDuplicate(selected, authoredRecord);
  }

  classifyUnmatchedRuntimeRecords(records);
}

const CONTINUATION_SESSION_MODES = new Set([
  'continue_from_dependency',
  'continue_session',
  'dependency_continuation',
  'existing_session',
  'inherit_session',
  'same_session',
  'shared_scenario',
]);

function normalizedContractToken(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function explicitContinuationContract(caseItem, ir) {
  const directSources = [caseItem, ir].filter((source) => source && typeof source === 'object');
  for (const source of directSources) {
    if (
      source.continueSession === true ||
      source.continueFromDependency === true ||
      source.requiresExistingSession === true ||
      source.sameSession === true ||
      source.preserveCurrentSession === true
    )
      return true;
    for (const field of [
      'sessionMode',
      'continuationMode',
      'dependencyMode',
      'browserSessionMode',
      'sessionDisposition',
      'sessionRequirement',
    ]) {
      if (CONTINUATION_SESSION_MODES.has(normalizedContractToken(source[field]))) return true;
    }
  }

  const contractSources = directSources
    .flatMap((source) => [
      source.continuation,
      source.continuationContract,
      source.session,
      source.sessionContract,
      source.dependencyContract,
      source.executionContract,
    ])
    .filter((source) => source && typeof source === 'object');
  for (const source of contractSources) {
    if (
      source.enabled === true ||
      source.continueSession === true ||
      source.continueFromDependency === true ||
      source.requiresExistingSession === true ||
      source.sameSession === true
    )
      return true;
    for (const field of ['mode', 'kind', 'type', 'disposition', 'requirement', 'sessionMode']) {
      if (CONTINUATION_SESSION_MODES.has(normalizedContractToken(source[field]))) return true;
    }
  }
  return false;
}

function mergeRuntimeOperation(authored, evidence) {
  if (authored.op === 'waitFor') {
    authored.condition = { ...(evidence.condition || {}), ...(authored.condition || {}) };
  }
  for (const field of ['liveOutcome', 'actual', 'observedValue', 'runtimeStatus']) {
    if (authored[field] == null && evidence[field] != null) authored[field] = evidence[field];
  }
  evidence[ATTACHED_RUNTIME_DUPLICATE] = true;
}

function applyDeclaredWaitDefinition(step, declared) {
  if (!step || step.op !== 'waitFor') return;
  if (!declared) return;
  const id = declaredIdentity(declared);
  if (!step.contractStepId && id) step.contractStepId = id;
  if (!step.waitContractId && id) step.waitContractId = id;
  const authoredCondition = declared.waitContract || declared.condition || {};
  // The authored contract defines the exported step. Runtime evidence may add
  // observed outcome fields, but it must not replace an authored target,
  // matcher, or timeout during partial-ReplayIR reconciliation.
  step.condition = { ...(step.condition || {}), ...authoredCondition };
  const timeoutMs = Number(declared.timeoutMs || authoredCondition.timeoutMs);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    step.condition.timeoutMs = Math.floor(timeoutMs);
  }
  copyDeclaredOccurrenceIdentity(step, declared);
  step.authored = true;
}

function applyDeclaredWaitContract(step, declaredById) {
  if (!step || step.op !== 'waitFor') return;
  const id = stepIdentity(step);
  const declared = id && declaredById.get(id);
  applyDeclaredWaitDefinition(step, declared);
}

function declaredAssertionContracts(caseItem, ir) {
  const sources = [
    caseItem && caseItem.declaredAssertions,
    caseItem && caseItem.declaredAssertionsRaw,
    caseItem && caseItem.assertionContracts,
    caseItem && caseItem.declaredAssertionContracts,
    ir && ir.declaredAssertions,
  ];
  const contracts = [];
  for (const source of sources) {
    let values = source;
    if (typeof values === 'string') {
      try {
        values = JSON.parse(values);
      } catch {
        values = null;
      }
    }
    if (!Array.isArray(values)) continue;
    for (const [index, raw] of values.entries()) {
      if (!raw || typeof raw !== 'object') continue;
      const payload = raw.payload && typeof raw.payload === 'object' ? raw.payload : raw;
      const id =
        raw.id ||
        raw.contractStepId ||
        raw.assertionId ||
        payload.id ||
        payload.contractStepId ||
        `authored-assertion-${semanticIdentifier(payload.description || payload.instruction || raw.description || raw.instruction || index + 1, 'contract')}`;
      const declaredChannel =
        raw.channel || raw.type || raw.assertionType || payload.channel || payload.type || null;
      const channel = assertionChannelFromContract({ ...raw, payload, channel: declaredChannel });
      const expected =
        payload.expectedText ??
        payload.expected ??
        payload.expectedValue ??
        payload.expectedCount ??
        payload.expectedChecked ??
        raw.expectedText ??
        raw.expected ??
        raw.expectedValue ??
        raw.expectedCount ??
        raw.expectedChecked ??
        expectedValueFromSignals(
          raw.expectedSignals,
          payload.expectedSignals,
          raw.expectedOutcome && raw.expectedOutcome.expectedSignals,
        );
      const target = payload.target ?? payload.element ?? payload.field ?? payload.label ??
        raw.target ?? raw.element ?? raw.field ?? raw.label ?? null;
      const timeoutMs = Number(payload.timeoutMs ?? raw.timeoutMs);
      const flowCritical = payload.flowCritical === true || raw.flowCritical === true;
      const contractText = [
        payload.description,
        payload.instruction,
        payload.assertion,
        payload.check,
        raw.description,
        raw.instruction,
        raw.assertion,
        raw.check,
      ].find((value) => value != null && String(value).trim());
      if (!id && !channel && expected == null && target == null) continue;
      contracts.push({
        id: id == null ? null : String(id),
        channel: channel == null ? null : String(channel),
        expected,
        target,
        timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : null,
        flowCritical,
        contractText: contractText == null ? null : String(contractText).trim(),
        expectedSignals: {
          ...((raw.expectedSignals && typeof raw.expectedSignals === 'object') ? raw.expectedSignals : {}),
          ...((payload.expectedSignals && typeof payload.expectedSignals === 'object') ? payload.expectedSignals : {}),
        },
        payload: { ...payload },
      });
    }
  }
  const knownIds = new Set(contracts.map((contract) => contract && contract.id).filter(Boolean));
  for (const [index, raw] of (Array.isArray(caseItem && caseItem.declaredSteps)
    ? caseItem.declaredSteps
    : []).entries()) {
    if (!isDeclaredAssertionStep(raw)) continue;
    const payload = raw.payload && typeof raw.payload === 'object' ? raw.payload : raw;
    const id = declaredIdentity(raw) ||
      `authored-assertion-${semanticIdentifier(raw.description || raw.instruction || index + 1, 'contract')}`;
    if (knownIds.has(String(id))) continue;
    const timeoutMs = Number(raw.timeoutMs ?? payload.timeoutMs);
    const contractText = [
      raw.description,
      raw.instruction,
      raw.assertion,
      raw.check,
      raw.plannedText,
      payload.description,
      payload.instruction,
      payload.assertion,
      payload.check,
    ].find((value) => value != null && String(value).trim());
    contracts.push({
      id: String(id),
      channel: assertionChannelFromContract(raw),
      expected: assertionExpectedFromContract(raw),
      target: raw.target ?? raw.element ?? raw.field ?? raw.label ?? payload.target ?? null,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : null,
      flowCritical: raw.flowCritical === true || payload.flowCritical === true,
      contractText: contractText == null ? null : String(contractText).trim(),
      payload: { ...payload },
    });
    knownIds.add(String(id));
  }
  // Export hydration may expose the same authored contract both on the case
  // (`declaredAssertionsRaw`) and on ReplayIR (`ir.declaredAssertions`). Those
  // are two projections of one contract, not two authored occurrences. Keep
  // the first complete projection per stable id so a second normalization pass
  // is idempotent and cannot materialize a duplicate assertion.
  const uniqueContracts = [];
  const contractIndexes = new Map();
  for (const contract of contracts) {
    const id = contract && contract.id ? String(contract.id) : null;
    if (!id || !contractIndexes.has(id)) {
      if (id) contractIndexes.set(id, uniqueContracts.length);
      uniqueContracts.push(contract);
      continue;
    }
    const index = contractIndexes.get(id);
    const existing = uniqueContracts[index];
    uniqueContracts[index] = {
      ...contract,
      ...existing,
      payload: { ...(contract && contract.payload || {}), ...(existing && existing.payload || {}) },
    };
  }
  return uniqueContracts;
}

function promoteMisclassifiedAssertionActs(steps, declaredById, assertionContracts) {
  const contractsById = new Map(
    (assertionContracts || [])
      .filter((contract) => contract && contract.id)
      .map((contract) => [String(contract.id), contract]),
  );
  for (const step of steps || []) {
    if (!step || step.op !== 'act' || isEvidenceOnly(step)) continue;
    const id = stepIdentity(step);
    const declared = id && declaredById.get(id) || null;
    const contract = id && contractsById.get(String(id)) || null;
    if (!contract && !isDeclaredAssertionStep(step) && !isDeclaredAssertionStep(declared)) continue;

    if (!evaluatedAssertionEvidence(step)) {
      step.authored = false;
      step.evidenceOnly = true;
      step.executable = false;
      step.diagnosticOnly = true;
      step.origin = 'assertion_not_evaluated';
      step[DROP_FROM_RUNNABLE_SPEC] = true;
      continue;
    }

    step.op = 'assert';
    step.authored = true;
    step.origin = step.origin || 'authored_assertion_recovery';
    step.channel = step.channel || assertionChannelFromContract(contract || declared || step);
    const expected = assertionExpectedFromContract(contract || declared || step);
    if (step.expected == null && expected != null) step.expected = expected;
    if (!step.contractRef && id) step.contractRef = id;
    delete step.action;
    delete step.authoredOperation;
    delete step.compilerOwnedGenericOperation;
    delete step.operationNormalization;
    if (contract) applyDeclaredAssertionContract(step, contract);
  }
}

function declaredAssertionForStep(step, contracts, usedContracts) {
  const ids = new Set(
    [
      step.assertionId,
      step.contractRef,
      step.contractStepId,
      step.sourceContractStepId,
      step.stepAuthoringId,
    ]
      .filter((value) => value != null && String(value).trim())
      .map(String),
  );
  if (!ids.size) return null;
  const exact = contracts.filter(
    (contract) =>
      !usedContracts.has(contract) &&
      contract &&
      contract.id != null &&
      ids.has(String(contract.id)),
  );
  return exact.length === 1 ? exact[0] : null;
}

function applyDeclaredAssertionContract(step, contract) {
  if (!step || !contract) return;
  if (!step.contractStepId && contract.id) step.contractStepId = contract.id;
  if (!step.contractRef && contract.id) step.contractRef = contract.id;
  const authoritativeExecutedAssertion =
    step.origin === 'executed_case_ast_assertion'
    && step.executed === true
    && step.executionStatus === 'evaluated'
    && ['matched', 'not_matched', 'failed'].includes(String(step.liveOutcome || '').toLowerCase());
  if (authoritativeExecutedAssertion) {
    if (contract.timeoutMs != null && step.timeoutMs == null) step.timeoutMs = contract.timeoutMs;
    if (contract.flowCritical) step.flowCritical = true;
    if (contract.contractText && !step.authoredContractText) {
      step.authoredContractText = contract.contractText;
    }
    delete step.missingAuthoredExpected;
    return;
  }
  if (contract.channel) step.channel = contract.channel;
  if (contract.target != null) step.target = contract.target;
  if (contract.expected != null) step.expected = contract.expected;
  if (contract.expectedSignals && Object.keys(contract.expectedSignals).length) {
    step.expectedSignals = {
      ...(step.expectedSignals && typeof step.expectedSignals === 'object' ? step.expectedSignals : {}),
      ...contract.expectedSignals,
    };
  }
  if (contract.timeoutMs != null) step.timeoutMs = contract.timeoutMs;
  if (contract.flowCritical) step.flowCritical = true;
  if (contract.contractText) step.authoredContractText = contract.contractText;
  for (const field of [
    'attributeName',
    'name',
    'comparator',
    'operator',
    'matcher',
    'expectedValue',
    'expectedCount',
    'expectedChecked',
    'expectedSelected',
  ]) {
    if (step[field] == null && contract.payload && contract.payload[field] != null) {
      step[field] = contract.payload[field];
    }
  }
  const expectedRequired = new Set([
    'UI_TEXT', 'URL', 'FORBIDDEN_TEXT', 'VALUE', 'NUMBER', 'COUNT', 'ATTRIBUTE', 'SELECTED',
  ]).has(String(step.channel || 'UI_TEXT').trim().toUpperCase());
  if (expectedRequired && (contract.expected == null || String(contract.expected).trim() === '')) {
    step.missingAuthoredExpected = true;
  } else {
    delete step.missingAuthoredExpected;
  }
}

function classifyAssertionProvenance(steps, declaredSteps, assertionContracts) {
  const declaredAssertions = (Array.isArray(declaredSteps) ? declaredSteps : [])
    .filter(isDeclaredAssertionStep);
  const declaredIds = new Set(
    declaredAssertions.map(declaredIdentity).filter(Boolean).map(String),
  );
  const contractIds = new Set(
    (assertionContracts || []).map((contract) => contract && contract.id).filter(Boolean).map(String),
  );
  if (!declaredAssertions.length && !contractIds.size) return;
  for (const step of steps || []) {
    if (!step || step.op !== 'assert') continue;
    const id = stepIdentity(step);
    if ((id && declaredIds.has(String(id))) || (id && contractIds.has(String(id)))) continue;
    const authoritativeExecutedAssertion =
      step.origin === 'executed_case_ast_assertion'
      && step.executed === true
      && step.executionStatus === 'evaluated'
      && ['matched', 'not_matched', 'failed'].includes(String(step.liveOutcome || '').toLowerCase());
    if (authoritativeExecutedAssertion) continue;
    // Some compiler inputs carry the complete authored assertion stream in
    // ReplayIR and use declaredAssertionsRaw only to enrich selected matcher
    // contracts (for example checked/count/attribute payloads). In that shape,
    // the partial enrichment list is not an allow-list. Preserve explicit
    // authored IR assertions unless an authored Verify/Validate step list exists;
    // that declared-step list remains the strict authority for rejecting runtime
    // assertion fragments that merely claim authored status.
    if (!declaredAssertions.length && step.authored === true && !isEvidenceOnly(step)) continue;

    step.authored = false;
    step.evidenceOnly = true;
    step.diagnosticOnly = true;
    step.executable = false;
    step.origin = 'unmatched_runtime_evidence';
    delete step.authoredAssertionCandidateId;
    step[DROP_FROM_RUNNABLE_SPEC] = true;
  }
}

function assertionSemanticKey(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/\b(?:button|option|link|field|input|textbox|control|element|icon|menu|item|prompt|heading)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function verifiedResolveSemanticKeys(resolve) {
  if (!resolve || resolve.op !== 'resolve' || isEvidenceOnly(resolve)) return new Set();
  const recipe = resolve.actionLocator || resolve.locatorRecipe || null;
  if (!actionLocatorResolver.isVerifiedActionLocator(recipe)) return new Set();
  const facts = locatorTargetFacts(recipe);
  return new Set([
    resolve.elementLabel,
    resolve.targetLabel,
    resolve.label,
    resolve.as,
    facts.accessibleName,
    facts.label,
    facts.text,
    facts.placeholder,
    facts.testId,
  ].map(assertionSemanticKey).filter(Boolean));
}

function concreteQuotedSignals(value) {
  if (typeof value !== 'string') return [];
  const found = [];
  const pattern = /(["'])([^\r\n"']{2,})\1/g;
  for (const match of value.matchAll(pattern)) {
    const text = String(match[2] || '').replace(/\s+/g, ' ').trim();
    if (text && !found.includes(text)) found.push(text);
  }
  return found;
}

function assertionHasVisibilityIntent(step) {
  const text = [
    step && step.expected,
    step && step.authoredContractText,
    step && step.description,
    step && step.instruction,
  ].filter((value) => typeof value === 'string').join(' ');
  return /\b(?:visible|displayed|shown|present|appears?|exists?)\b/i.test(text);
}

function normalizeAuthoredAssertionSemantics(steps) {
  const verifiedResolves = (steps || [])
    .filter((step) => verifiedResolveSemanticKeys(step).size > 0)
    .map((step) => ({ step, keys: verifiedResolveSemanticKeys(step) }));

  for (const step of steps || []) {
    if (!step || step.op !== 'assert' || isEvidenceOnly(step)) continue;
    const target = String(step.target || '').trim();
    const targetAlreadyResolved = target && (steps || []).some(
      (candidate) => candidate && candidate.op === 'resolve' && candidate.as === target && !isEvidenceOnly(candidate),
    );
    let rebound = false;
    if (target && !targetAlreadyResolved) {
      const key = assertionSemanticKey(target);
      const matches = key
        ? verifiedResolves.filter((candidate) => candidate.keys.has(key))
        : [];
      if (matches.length === 1) {
        step.target = matches[0].step.as;
        rebound = true;
        if (assertionHasVisibilityIntent(step)) step.channel = 'VISIBLE';
      }
    }

    const quotedSignals = concreteQuotedSignals(step.expected)
      .concat(concreteQuotedSignals(step.authoredContractText))
      .filter((value, index, values) => values.indexOf(value) === index);
    if (!rebound && quotedSignals.length) {
      step.target = null;
      step.channel = 'PAGE';
      step.expectedSignals = {
        ...(step.expectedSignals && typeof step.expectedSignals === 'object' ? step.expectedSignals : {}),
        text: quotedSignals,
      };
    }
  }
}

function comparablePageLocation(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const absolute = new URL(raw);
    return { origin: absolute.origin, path: `${absolute.pathname}${absolute.search}` };
  } catch {
    try {
      const relative = new URL(raw, 'https://qaai.invalid');
      return { origin: null, path: `${relative.pathname}${relative.search}` };
    } catch {
      return null;
    }
  }
}

function samePageLocation(left, right) {
  const a = comparablePageLocation(left);
  const b = comparablePageLocation(right);
  if (!a || !b || a.path !== b.path) return false;
  return !a.origin || !b.origin || a.origin === b.origin;
}

function rebindNarrativePageReadiness(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const resolves = new Map(
    list.filter((step) => step && step.op === 'resolve' && step.as).map((step) => [String(step.as), step]),
  );
  for (const [waitIndex, wait] of list.entries()) {
    if (!wait || wait.op !== 'waitFor' || isEvidenceOnly(wait) || !wait.condition?.target) continue;
    const currentResolve = resolves.get(String(wait.condition.target));
    if (!currentResolve || currentResolve.guessedLocator !== true) continue;
    const narrative = String(currentResolve.elementLabel || currentResolve.targetLabel || currentResolve.as || '');
    if (!/\b(?:page|screen|view|dashboard|workspace|portal)\b/i.test(narrative)) continue;

    const waitOrdinal = authoredStepOrdinal(wait);
    const ordinalNavigations = waitOrdinal
      ? list.map((candidate, index) => ({ candidate, index })).filter(
          ({ candidate }) => candidate && candidate.op === 'act' &&
            normalizedAction(candidate.action) === 'navigate' &&
            authoredStepOrdinal(candidate) === waitOrdinal,
        )
      : [];
    let navigateIndex = ordinalNavigations.length === 1 ? ordinalNavigations[0].index : -1;
    for (let index = waitIndex - 1; index >= 0; index -= 1) {
      if (navigateIndex >= 0) break;
      const candidate = list[index];
      if (candidate && candidate.op === 'act' && normalizedAction(candidate.action) === 'navigate') {
        navigateIndex = index;
        break;
      }
    }
    if (navigateIndex < 0) continue;
    const navigate = list[navigateIndex];
    const destination = navigate.url || navigate.href || navigate.destination || navigate.value;
    const candidates = [];
    for (const [actIndex, act] of list.entries()) {
      if (!act || act.op !== 'act' || !act.target) continue;
      if (!waitOrdinal && actIndex <= navigateIndex) continue;
      const resolve = resolves.get(String(act.target));
      if (!resolve || verifiedResolveSemanticKeys(resolve).size === 0) continue;
      const candidateLocation = resolve.pageUrl || act.pageUrlBefore || act.pageUrl;
      const sameDestination = samePageLocation(destination, candidateLocation);
      const nextAuthoredOccurrence = waitOrdinal && authoredStepOrdinal(act) === waitOrdinal + 1;
      if (!sameDestination && !nextAuthoredOccurrence) continue;
      candidates.push({ actIndex, resolve, sameDestination });
    }
    candidates.sort((a, b) => Number(b.sameDestination) - Number(a.sameDestination) || a.actIndex - b.actIndex);
    if (!candidates.length) continue;
    const best = candidates[0];
    const equallyStrong = candidates.filter(
      (candidate) => candidate.sameDestination === best.sameDestination && candidate.actIndex === best.actIndex,
    );
    if (equallyStrong.length !== 1) continue;
    wait.condition.target = best.resolve.as;
  }
}

function reconcileAssertionsAndWaits(
  steps,
  declaredById,
  assertionContracts = [],
  occurrenceScope = null,
) {
  const authoredAssertionById = new Map();
  for (let index = (steps || []).length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (!step || step.op !== 'assert' || isEvidenceOnly(step)) continue;
    const id = step.contractRef || step.contractStepId || step.assertionId || null;
    if (!id) continue;
    const key = String(id);
    const existing = authoredAssertionById.get(key);
    if (!existing) {
      authoredAssertionById.set(key, step);
      continue;
    }
    // A hydrated case can project one authored assertion twice: the richer IR
    // step carries contractStepId + contractRef while the raw-contract projection
    // carries only contractRef. A stable contract id denotes one authored
    // occurrence, so merge missing metadata and remove the duplicate projection.
    const richer = [existing, step].sort((left, right) =>
      Number(Boolean(right.contractStepId)) - Number(Boolean(left.contractStepId))
      || Object.keys(right).length - Object.keys(left).length,
    )[0];
    const other = richer === existing ? step : existing;
    for (const [field, value] of Object.entries(other)) {
      if (richer[field] == null && value != null) richer[field] = value;
    }
    if (richer !== existing) authoredAssertionById.set(key, richer);
    const remove = richer === step ? existing : step;
    const removeIndex = steps.indexOf(remove);
    if (removeIndex >= 0) steps.splice(removeIndex, 1);
  }
  const operations = steps.filter(
    (step) => step && (step.op === 'assert' || step.op === 'waitFor'),
  );
  const authored = operations.filter((step) => !isEvidenceOnly(step));
  const evidence = operations.filter((step) => isEvidenceOnly(step));
  const usedAuthored = new Set();
  const usedEvidence = new Set();
  const usedAssertionContracts = new Set();
  for (const step of authored) {
    applyDeclaredWaitContract(step, declaredById);
    if (step.op === 'assert') {
      const contract = declaredAssertionForStep(step, assertionContracts, usedAssertionContracts);
      if (contract) {
        applyDeclaredAssertionContract(step, contract);
        usedAssertionContracts.add(contract);
      }
    }
  }

  for (const runtimeStep of evidence) {
    const matches = authored.filter(
      (candidate) =>
        candidate.op === runtimeStep.op &&
        !usedAuthored.has(candidate) &&
        stableOccurrenceRelationship(candidate, runtimeStep, occurrenceScope),
    );
    if (matches.length !== 1) continue;
    mergeRuntimeOperation(matches[0], runtimeStep);
    usedAuthored.add(matches[0]);
    usedEvidence.add(runtimeStep);
  }

  for (const runtimeStep of evidence.filter((step) => !usedEvidence.has(step))) {
    // An unmatched runtime wait/assertion is observation evidence, not an
    // authored test operation. Never upgrade it into the runnable stream.
    runtimeStep[DROP_FROM_RUNNABLE_SPEC] = true;
  }
  // Assertion contracts enrich assertions that execution actually produced.
  // They must never create a new executable assertion from authored prose.
}

function stableObservedUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || /^(?:about:blank|data:|javascript:)/i.test(raw)) return null;
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return raw.startsWith('/') ? raw : null;
  }
}

function observedInitialUrl(ir, records, steps) {
  const transition = (Array.isArray(ir.contextTransitions) ? ir.contextTransitions : []).find(
    (entry) => entry && String(entry.kind || '').toLowerCase() === 'observed_start_state',
  );
  const sources = [
    transition && (transition.observedUrl || transition.url),
    ...records
      .sort((a, b) => a.stepIndex - b.stepIndex)
      .flatMap((record) => [
        record.resolve && record.resolve.pageUrl,
        record.step && (record.step.pageUrl || record.step.pageUrlBefore),
      ]),
    ...steps.filter((step) => step && step.op === 'resolve').map((step) => step.pageUrl),
  ];
  for (const source of sources) {
    const stable = stableObservedUrl(source);
    if (stable) return stable;
  }
  return null;
}

function semanticPageValue(value) {
  if (value == null || (typeof value !== 'string' && typeof value !== 'number')) return null;
  const text = String(value).trim();
  return text && cleanTargetText(text) ? text : null;
}

function capturedPageName(resolve) {
  const recipe = resolve && (resolve.actionLocator || resolve.locatorRecipe);
  const primary = primaryLocator(recipe);
  const sources = [
    resolve && resolve.pageIdentity,
    primary && primary.pageIdentity,
    recipe && recipe.pageIdentity,
    primary && primary.contextEvidence,
    recipe && recipe.contextEvidence,
    primary && primary.domAtlas && primary.domAtlas.page,
    recipe && recipe.domAtlas && recipe.domAtlas.page,
  ].filter(Boolean);
  for (const source of sources) {
    const direct = semanticPageValue(source);
    if (direct) return direct;
    if (!source || typeof source !== 'object') continue;
    for (const field of [
      'authoredPageName',
      'semanticPageName',
      'pageRole',
      'pageName',
      'expectedPageTitle',
      'pageTitle',
      'documentTitle',
      'title',
      'heading',
    ]) {
      const value = semanticPageValue(source[field]);
      if (value) return value;
    }
  }
  return null;
}

function explicitPageName(resolve, declared) {
  const captured = capturedPageName(resolve);
  if (captured) return captured;
  for (const source of [resolve, declared]) {
    for (const field of PAGE_NAME_FIELDS) {
      const value = semanticPageValue(source && source[field]);
      if (value) return value;
    }
  }
  return null;
}

function contextualPageName(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const match = text.match(
    /\b(?:on|from|within)\s+(?:the\s+)?(.+?)(?:\s+(?:page|screen|form))?\s*$/i,
  );
  if (!match) return null;
  const cleaned = match[1]
    .replace(/\b(?:button|link|textbox|input|field|control|element)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned && cleanTargetText(cleaned) ? cleaned : null;
}

function hostnamePageName(value) {
  try {
    const hostname = new URL(String(value || '')).hostname.toLowerCase();
    const parts = hostname
      .split('.')
      .filter((part) => part && !PUBLIC_SUFFIX_PARTS.has(part) && !GENERIC_HOST_PARTS.has(part));
    const selected = parts[parts.length - 1];
    if (!selected) return null;
    return selected
      .replace(/(online|cloud|identity|accounts|account|auth)$/i, ' $1')
      .replace(/[^a-z0-9]+/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return null;
  }
}

function urlOrigin(value) {
  try {
    return new URL(String(value || '')).origin;
  } catch {
    return '';
  }
}

function urlPath(value) {
  try {
    return new URL(String(value || '')).pathname || '/';
  } catch {
    return String(value || '').replace(/[?#].*$/, '') || '/';
  }
}

function isRootPath(value) {
  return /^\/?$/.test(urlPath(value));
}

function hasMeaningfulRoute(value) {
  const segments = urlPath(value)
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
  return segments.some((segment) => {
    if (GENERIC_ROUTE_PARTS.has(segment)) return false;
    if (/^v?\d+(?:\.\d+)*$/.test(segment)) return false;
    if (/^\d+$/.test(segment)) return false;
    if (/^[0-9a-f]{16,}$/i.test(segment)) return false;
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) return false;
    return /[a-z]/i.test(segment);
  });
}

function popupTransition(step) {
  if (!step || typeof step !== 'object') return false;
  const values = [step.transitionKind, step.navigationKind, step.kind].map((value) =>
    String(value || '')
      .toLowerCase()
      .replace(/[\s-]+/g, '_'),
  );
  return (
    step.popup === true ||
    step.newTab === true ||
    !!step.popupIdentity ||
    values.some((value) =>
      ['popup', 'popup_context', 'popup_destination', 'new_tab', 'newtab'].includes(value),
    )
  );
}

function urlLocationKey(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.toString();
  } catch {
    return String(value || '');
  }
}

function projectObservedTransitions(steps, initialUrl) {
  let previousAuthoredInteraction = null;
  for (const step of steps) {
    if (step && step.op === 'act' && step.action === 'navigate' && isEvidenceOnly(step)) {
      const destination = stableObservedUrl(step.url || step.pageUrlAfter || step.pageUrl);
      if (
        previousAuthoredInteraction &&
        destination &&
        urlLocationKey(destination) !== urlLocationKey(initialUrl)
      ) {
        if (popupTransition(step)) {
          previousAuthoredInteraction.opensPopup = true;
          previousAuthoredInteraction.popupExpectedUrl = destination;
        } else {
          previousAuthoredInteraction.observedConsequenceUrl = destination;
        }
      }
      continue;
    }

    if (!step || step.op !== 'act') continue;
    if (step[ATTACHED_RUNTIME_DUPLICATE]) {
      previousAuthoredInteraction = step[ATTACHED_AUTHORED_STEP] || previousAuthoredInteraction;
      continue;
    }
    if (step[DROP_FROM_RUNNABLE_SPEC] || isEvidenceOnly(step)) continue;
    if (step.action !== 'navigate') previousAuthoredInteraction = step;
    const destination = stableObservedUrl(step.pageUrlAfter);
    const source = stableObservedUrl(step.pageUrl || step.pageUrlBefore);
    if (!destination || (source && urlLocationKey(destination) === urlLocationKey(source)))
      continue;
    if (popupTransition(step)) {
      step.opensPopup = true;
      step.popupExpectedUrl = destination;
    } else {
      step.observedConsequenceUrl = destination;
    }
  }

  const projected = [];
  for (const step of steps) {
    if (!step) continue;
    if (step[DROP_FROM_RUNNABLE_SPEC] || step[ATTACHED_RUNTIME_DUPLICATE]) continue;
    if (step.op === 'act' && step.action === 'navigate' && isEvidenceOnly(step)) continue;
    // Observed transitions remain provenance on the authored action. They must
    // never become executable waits or navigations unless the authored contract
    // already contains that operation.
    projected.push(step);
  }
  return projected;
}

function nearestSubsequentResolvedPageUrl(steps, startIndex) {
  for (let index = startIndex; index < steps.length; index += 1) {
    const candidate = steps[index];
    if (!candidate) continue;
    if (candidate.op === 'act') return null;
    if (candidate.op !== 'resolve') continue;
    return stableObservedUrl(
      candidate.pageUrl
        || candidate.pageUrlBefore
        || candidate.pageIdentity?.url
        || candidate.actionLocator?.context?.documentUrl,
    );
  }
  return null;
}

function assignPageOwnership(steps, declaredById, initialUrl) {
  const originLabels = new Map();
  const initialOrigin = urlOrigin(initialUrl);
  let currentUrl = initialUrl || null;
  let transitionPending = false;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step && step.op === 'act') {
      if (step.action === 'navigate' && step.url) currentUrl = step.url;
      else if (stableObservedUrl(step.pageUrlAfter)) currentUrl = step.pageUrlAfter;
      transitionPending = true;
    }
    if (!step || !['resolve', 'assert', 'waitFor'].includes(step.op)) continue;
    if (
      !step.pageUrl
      && transitionPending
      && (step.op === 'assert' || step.op === 'waitFor')
    ) {
      const observedNextUrl = nearestSubsequentResolvedPageUrl(steps, index + 1);
      if (observedNextUrl) currentUrl = observedNextUrl;
    }
    if (!step.pageUrl && currentUrl) step.pageUrl = currentUrl;
    const id = stepIdentity(step);
    const declared = (id && declaredById.get(id)) || null;
    const explicit = explicitPageName(step, declared);
    const contextual = [
      declared && (declared.target || declared.element || declared.text || declared.description),
      step.elementLabel,
      step.narration,
    ]
      .map(contextualPageName)
      .find(Boolean);
    const origin = urlOrigin(step.pageUrl);
    if (
      origin &&
      (explicit || (!hasMeaningfulRoute(step.pageUrl) && contextual)) &&
      !originLabels.has(origin)
    ) {
      originLabels.set(origin, explicit || contextual);
    }
    if (step.op === 'resolve') transitionPending = false;
  }

  currentUrl = initialUrl || null;
  for (const step of steps) {
    if (step && step.op === 'act') {
      if (step.action === 'navigate' && step.url) currentUrl = step.url;
      else if (stableObservedUrl(step.pageUrlAfter)) currentUrl = step.pageUrlAfter;
    }
    if (!step || step.op !== 'resolve') continue;
    if (!step.pageUrl && currentUrl) step.pageUrl = currentUrl;
    const id = stepIdentity(step);
    const declared = (id && declaredById.get(id)) || null;
    const explicit = explicitPageName(step, declared);
    if (explicit) {
      const existingDirectName = PAGE_NAME_FIELDS.map((field) =>
        semanticPageValue(step[field]),
      ).find(Boolean);
      if (!existingDirectName) step.semanticPageName = explicit;
      continue;
    }
    const origin = urlOrigin(step.pageUrl);
    if (origin && initialOrigin && origin !== initialOrigin) {
      const capturedHostLabel = originLabels.get(origin) || hostnamePageName(step.pageUrl);
      if (capturedHostLabel) step.semanticPageName = capturedHostLabel;
      continue;
    }
    if (hasMeaningfulRoute(step.pageUrl)) continue;
    const label = originLabels.get(origin) || hostnamePageName(step.pageUrl);
    if (label) step.semanticPageName = label;
  }
}

function canonicalStepOrder(steps, declaredSteps) {
  const rank = new Map();
  const declared = Array.isArray(declaredSteps) ? declaredSteps : [];
  for (const [index, step] of declared.entries()) {
    const id = declaredIdentity(step);
    if (id && !rank.has(id)) rank.set(id, index);
  }
  const declaredRankFor = (step) => {
    for (const identity of [
      stepIdentity(step),
      step && step.sourceContractStepId,
      step && step.waitContractId,
      step && step.assertionContractId,
    ]) {
      if (identity != null && rank.has(String(identity))) return rank.get(String(identity));
    }
    const ordinal = authoredStepOrdinal(step);
    return Number.isInteger(ordinal) && ordinal > 0 && ordinal <= declared.length
      ? ordinal - 1
      : null;
  };
  const priority = { resolve: 0, act: 1, waitFor: 2, assert: 3 };
  return steps
    .map((step, index) => ({ step, index }))
    .sort((left, right) => {
      const leftSetup =
        left.step && left.step.setupOperation === true && left.step.action === 'navigate';
      const rightSetup =
        right.step && right.step.setupOperation === true && right.step.action === 'navigate';
      if (leftSetup !== rightSetup) return leftSetup ? -1 : 1;
      const leftRank = declaredRankFor(left.step);
      const rightRank = declaredRankFor(right.step);
      if (leftRank != null && rightRank != null && leftRank !== rightRank)
        return leftRank - rightRank;
      if (leftRank != null && rightRank != null) {
        const leftPriority = priority[left.step.op] == null ? 1 : priority[left.step.op];
        const rightPriority = priority[right.step.op] == null ? 1 : priority[right.step.op];
        if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.step);
}

function partialRunBoundaryEvidence(caseItem, originalIr, executableSteps, declaredSteps) {
  const evidenceStatus = String(
    caseItem?.evidenceBuiltReplayIr?.evidenceStatus ||
      originalIr?.evidenceBuiltReplayIr?.evidenceStatus ||
      '',
  ).toLowerCase();
  const gaps = [
    ...(Array.isArray(caseItem?.gaps) ? caseItem.gaps : []),
    ...(Array.isArray(originalIr?.gaps) ? originalIr.gaps : []),
  ];
  const explicitFailureBoundary =
    caseItem?.failureBoundary ||
    originalIr?.failureBoundary ||
    (originalIr?.steps || []).find((step) => step?.failureBoundary)?.failureBoundary ||
    null;
  const incomplete =
    !!explicitFailureBoundary ||
    ['capture_failed', 'interrupted', 'partial', 'failed'].includes(evidenceStatus);
  if (!incomplete) return null;

  const executed = (Array.isArray(executableSteps) ? executableSteps : [])
    .filter((step) => step && step.executable !== false && !isEvidenceOnly(step))
    .map((step) => ({
      step,
      ordinal: authoredStepOrdinal(step),
      identity: stepIdentity(step),
    }))
    .filter((entry) => Number.isInteger(entry.ordinal) && entry.ordinal > 0)
    .sort((left, right) => left.ordinal - right.ordinal);
  const lastExecuted = executed[executed.length - 1] || null;
  if (!lastExecuted) return null;

  const nextDeclared = (Array.isArray(declaredSteps) ? declaredSteps : [])
    .map((step) => ({ step, ordinal: authoredStepOrdinal(step) }))
    .filter(
      (entry) =>
        Number.isInteger(entry.ordinal) && entry.ordinal > lastExecuted.ordinal,
    )
    .sort((left, right) => left.ordinal - right.ordinal)[0] || null;
  const gapCodes = [...new Set(gaps.map((gap) => String(gap?.code || '').trim()).filter(Boolean))];
  const missingEvidenceCount = Number(
    caseItem?.evidenceBuiltReplayIr?.missingEvidenceCount ||
      originalIr?.evidenceBuiltReplayIr?.missingEvidenceCount ||
      0,
  );
  const nextIdentity = nextDeclared ? declaredIdentity(nextDeclared.step) : null;

  return {
    op: 'evidence',
    kind: 'partial_run_boundary',
    executable: false,
    diagnosticOnly: true,
    failureBoundary: {
      code: 'partial_run_evidence_boundary',
      boundaryType: 'after_last_positively_executed_step',
      afterAuthoredStepNumber: lastExecuted.ordinal,
      afterContractStepId: lastExecuted.identity || null,
      nextAuthoredStepNumber: nextDeclared?.ordinal || lastExecuted.ordinal + 1,
      nextContractStepId: nextIdentity || null,
      nextPlannedText: nextDeclared
        ? String(
            nextDeclared.step?.text ||
              nextDeclared.step?.description ||
              nextDeclared.step?.instruction ||
              '',
          ).trim() || null
        : null,
      evidenceStatus: evidenceStatus || 'incomplete',
      gapCodes,
      missingEvidenceCount,
    },
    ...(!nextIdentity
      ? {
          upstreamConductorRequirement: {
            code: 'UPSTREAM_CONDUCTOR_REQUIREMENT',
            consumer: 'playwrightPomJsStandardProfile.partialRunBoundaryEvidence',
            requiredFields: [
              'declaredSteps[].id',
              'declaredSteps[].text',
              'executedStep.contractStepId',
            ],
          },
        }
      : {}),
  };
}

function authoredOccurrenceId(step) {
  return (
    (step && step.actionIdentity && step.actionIdentity.authoredActionId) ||
    (step && (step.authoredActionId || step.actionId)) ||
    null
  );
}

function runtimeRequiredOperationHasAuthoredBacking(step, declaredById) {
  if (String((step && step.origin) || '').toLowerCase() !== 'runtime_required_operation')
    return true;
  if (!step || step.authored !== true || step.evidenceOnly === true) return false;
  if (authoredOccurrenceId(step)) return true;
  const id = stepIdentity(step);
  return !!(id && declaredById.has(id));
}

function diagnosticRuntimeEvidence(steps, declaredById) {
  return steps
    .filter(
      (step) =>
        isEvidenceOnly(step) ||
        step?.[DROP_FROM_RUNNABLE_SPEC] === true ||
        step?.diagnosticOnly === true ||
        step?.executable === false ||
        !runtimeRequiredOperationHasAuthoredBacking(step, declaredById),
    )
    .map((step) => ({
      ...step,
      executable: false,
      diagnosticOnly: true,
    }));
}

function pruneEvidenceAndUnusedResolves(steps, declaredSteps) {
  const declaredById = declaredStepMap(declaredSteps);
  const withoutEvidence = steps.filter(
    (step) =>
      step &&
      step[DROP_FROM_RUNNABLE_SPEC] !== true &&
      step[ATTACHED_RUNTIME_DUPLICATE] !== true &&
      !isEvidenceOnly(step) &&
      runtimeRequiredOperationHasAuthoredBacking(step, declaredById),
  );

  const ordered = canonicalStepOrder(withoutEvidence, declaredSteps);
  // Runtime duplicates were already marked above. Do not signature-dedupe the
  // remaining authored stream: two intentionally repeated clicks/assertions can
  // have identical operation, target, and contract identifiers and must still be
  // emitted twice in authored order.
  const deduped = ordered;

  const referenced = new Set();
  for (const step of deduped) {
    if (step.op === 'act') {
      if (step.target) referenced.add(step.target);
      if (step.destinationTarget) referenced.add(step.destinationTarget);
    } else if (step.op === 'assert' && step.target) referenced.add(step.target);
    else if (step.op === 'waitFor' && step.condition?.target) referenced.add(step.condition.target);
  }
  return deduped.filter((step) => step.op !== 'resolve' || referenced.has(step.as));
}

function occurrenceScopeForCase(caseItem, ir) {
  return {
    runId:
      (caseItem &&
        (caseItem.runId ||
          caseItem.testRunId ||
          caseItem.runResultId ||
          caseItem.executionRunId)) ||
      (ir && (ir.runId || ir.testRunId || ir.runResultId || ir.executionRunId)) ||
      null,
    caseId:
      (caseItem && (caseItem.caseId || caseItem.testCaseId || caseItem.sourceCaseId)) ||
      (ir && (ir.caseId || ir.testCaseId || ir.sourceCaseId)) ||
      null,
  };
}

function prepareCaseForStandardOutput(caseItem) {
  const originalIr = caseItem && caseItem.ir && typeof caseItem.ir === 'object' ? caseItem.ir : {};
  const declaredSteps = Array.isArray(caseItem && caseItem.declaredSteps)
    ? caseItem.declaredSteps.map((step) => ({ ...step }))
    : [];
  const steps = Array.isArray(originalIr.steps)
    ? originalIr.steps.map((step) => ({
        ...step,
        ...(step && step.condition && typeof step.condition === 'object'
          ? { condition: { ...step.condition } }
          : {}),
      }))
    : [];
  const occurrenceScope = occurrenceScopeForCase(caseItem, originalIr);
  canonicalizePersistedLocatorEvidence(steps, originalIr.domAtlas);
  ensureDeclaredStepIdentities(declaredSteps);
  ensureDeclaredWaitOccurrenceIdentities(declaredSteps, occurrenceScope);
  const declaredById = declaredStepMap(declaredSteps);
  bindDeclaredActionOccurrencesFromVerifiedEvidence(
    steps,
    declaredSteps,
    declaredById,
    occurrenceScope,
  );
  const runtimeEvidence = [
    ...(Array.isArray(originalIr.runtimeEvidence) ? originalIr.runtimeEvidence : []),
    ...diagnosticRuntimeEvidence(steps, declaredById),
  ].map((step) => ({
    ...step,
    executable: false,
    diagnosticOnly: true,
  }));
  const assertionContracts = declaredAssertionContracts(caseItem, originalIr);
  promoteMisclassifiedAssertionActs(steps, declaredById, assertionContracts);
  classifyAssertionProvenance(steps, declaredSteps, assertionContracts);
  normalizeAuthoredActions(steps, declaredById);
  promoteEmbeddedLocatorContext(steps);
  // Declared steps are intent metadata. Missing actions are reported by parity
  // evidence; they are never synthesized into the executable stream.
  materializeTargetlessAuthoredActions(steps);
  const records = buildActionRecords(steps, declaredById, occurrenceScope);
  reconcileVerifiedEvidence(records);
  promoteEmbeddedLocatorContext(steps);
  // Reconciliation can promote an unmatched, successfully executed action only
  // when its exact action-time locator has same-node verification. Materialize a
  // target afterwards so promoted targetless actions still receive one central
  // page-object locator, method, and spec call.
  materializeTargetlessAuthoredActions(steps);
  enforceVerifiedRunnableLocators(steps);
  const postLocatorEnforcementEvidence = diagnosticRuntimeEvidence(steps, declaredById);
  // Wait contracts may enrich executed waits during reconciliation, but an
  // unexecuted authored wait must not be materialized as runnable code.
  reconcileAssertionsAndWaits(steps, declaredById, assertionContracts, occurrenceScope);
  normalizeAuthoredAssertionSemantics(steps);
  rebindNarrativePageReadiness(steps);

  const initialUrl = observedInitialUrl(originalIr, records, steps);
  const projectedSteps = projectObservedTransitions(steps, initialUrl);
  assignPageOwnership(projectedSteps, declaredById, initialUrl);
  const normalizedSteps = pruneEvidenceAndUnusedResolves(projectedSteps, declaredSteps);
  const partialBoundary = partialRunBoundaryEvidence(
    caseItem,
    originalIr,
    normalizedSteps,
    declaredSteps,
  );
  const finalRuntimeEvidence = [
    ...runtimeEvidence,
    ...postLocatorEnforcementEvidence,
    ...diagnosticRuntimeEvidence(projectedSteps, declaredById),
    ...(partialBoundary ? [partialBoundary] : []),
  ].filter((step, index, all) => {
    const identity = [
      step && step.op,
      step && step.action,
      stepIdentity(step),
      step && step.actionOccurrenceId,
      step && step.failureBoundary && step.failureBoundary.code,
    ].map((value) => String(value || '')).join('\u0001');
    return all.findIndex((candidate) => [
      candidate && candidate.op,
      candidate && candidate.action,
      stepIdentity(candidate),
      candidate && candidate.actionOccurrenceId,
      candidate && candidate.failureBoundary && candidate.failureBoundary.code,
    ].map((value) => String(value || '')).join('\u0001') === identity) === index;
  });
  const ir = {
    ...originalIr,
    steps: normalizedSteps,
    ...(finalRuntimeEvidence.length ? { runtimeEvidence: finalRuntimeEvidence } : {}),
  };
  delete ir.locatorCertification;

  return {
    ...caseItem,
    declaredSteps,
    ir,
  };
}

function cloneCaseForStandardOutput(caseItem) {
  if (!caseItem || typeof caseItem !== 'object') return caseItem;
  if (typeof globalThis.structuredClone === 'function') {
    try {
      return globalThis.structuredClone(caseItem);
    } catch (_) {}
  }
  return JSON.parse(JSON.stringify(caseItem));
}

function prepareCasesForStandardOutput(cases) {
  return (Array.isArray(cases) ? cases : []).map((caseItem) =>
    prepareCaseForStandardOutput(cloneCaseForStandardOutput(caseItem)),
  );
}

const SUPPORT_HELPERS = new Set([
  'assertTextPresent',
  'assertScopedText',
  'dismissKnownPopups',
  'readEnv',
  'readData',
  'missingBindingValue',
  'readRuntimeOutput',
  'readDependencyOutput',
  'generateDeterministicValue',
  'loadDataRows',
  'resolveLocator',
  'checkAccessibility',
  'evaluateSettled',
  'waitForStableObservations',
]);

function importedSupportHelpers(output) {
  const source = [output && output.content, ...Object.values((output && output.extraFiles) || {})]
    .filter((value) => typeof value === 'string')
    .join('\n');
  const names = new Set();
  const patterns = [
    /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*support\/replayir\.js['"]/g,
    /const\s*\{([^}]*)\}\s*=\s*require\(['"][^'"]*support\/replayir(?:\.js)?['"]\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      for (const part of String(match[1] || '').split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0];
        if (SUPPORT_HELPERS.has(name)) names.add(name);
      }
    }
  }
  return names;
}

function minimalSupportSource(names, cjs = false) {
  const requested = new Set(names || []);
  const chunks = [];
  const needsExpect = ['assertTextPresent', 'assertScopedText'].some((name) => requested.has(name));
  const needsFiles = requested.has('loadDataRows');
  if (needsExpect)
    chunks.push(
      cjs
        ? "const { expect } = require('@playwright/test');"
        : "import { expect } from '@playwright/test';",
    );
  if (needsFiles)
    chunks.push(
      cjs
        ? "const fs = require('node:fs');\nconst path = require('node:path');"
        : "import fs from 'node:fs';\nimport path from 'node:path';",
    );

  if (requested.has('assertTextPresent'))
    chunks.push(`async function assertTextPresent(page, text, _hint = '', timeoutMs = 10000) {
  const expected = String(text);
  const matches = page.getByText(expected, { exact: false });
  await expect.poll(async () => {
    const count = await matches.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      if (await matches.nth(index).isVisible().catch(() => false)) return true;
    }
    return false;
  }, {
    timeout: timeoutMs,
    message: 'Expected visible rendered text "' + expected + '" anywhere on the page.',
  }).toBe(true);
}`);
  if (requested.has('assertScopedText'))
    chunks.push(`async function assertScopedText(page, selector, expected, timeout = 10000) {
  await expect(page.locator(selector)).toContainText(String(expected), { timeout });
}`);
  if (requested.has('readEnv'))
    chunks.push(`function readEnv(name) {
  const value = process.env[name];
  if (value == null || String(value).trim() === '') throw new Error(\`Missing or blank required environment variable \${name}\`);
  return value;
}`);
  if (
    requested.has('missingBindingValue') ||
    requested.has('readRuntimeOutput') ||
    requested.has('readDependencyOutput')
  )
    chunks.push(`function missingBindingValue(kind, key) {
  throw new Error(\`QAAI binding \${kind}: required value "\${key}" is unavailable\`);
}`);
  if (requested.has('readRuntimeOutput') || requested.has('readDependencyOutput'))
    chunks.push(`function bindingContext() {
  const globalContext = globalThis.__QAAI_BINDING_CONTEXT__;
  if (globalContext && typeof globalContext === 'object') return globalContext;
  const raw = process.env.QAAI_BINDING_CONTEXT;
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('QAAI_BINDING_CONTEXT must contain a JSON object.');
  return parsed;
}`);
  if (requested.has('readRuntimeOutput'))
    chunks.push(`function readRuntimeOutput(key) {
  const value = bindingContext().runtimeOutputs && bindingContext().runtimeOutputs[key];
  return value == null ? missingBindingValue('runtime_output', key) : value;
}`);
  if (requested.has('readDependencyOutput'))
    chunks.push(`function readDependencyOutput(dependencyCaseId, key) {
  const dependency = bindingContext().dependencyOutputs && bindingContext().dependencyOutputs[dependencyCaseId];
  const value = dependency && dependency[key];
  return value == null ? missingBindingValue('dependency_output', dependencyCaseId + '.' + key) : value;
}`);
  if (requested.has('readData'))
    chunks.push(`function readData(row, key, options = {}) {
  const required = options.required !== false;
  const type = options.type || 'string';
  const raw = row && row.fields && row.fields[key];
  const label = row && row.label || 'data row';
  const explicitBlank = raw === '<empty>' || raw === '<blank>' || raw === '<null>';
  if (raw == null || raw === '' || explicitBlank) {
    if (!required) return options.defaultValue != null ? options.defaultValue : (type === 'number' ? 0 : type === 'boolean' ? false : '');
    if (explicitBlank && type === 'string') return '';
    throw new Error(\`QAAI data contract: required field "\${key}" is empty for \${label}\`);
  }
  const value = String(raw).trim();
  if (type === 'number') {
    const numeric = Number(value.replace(/,/g, ''));
    if (!Number.isFinite(numeric)) throw new Error(\`QAAI data contract: field "\${key}" for \${label} must be numeric, got "\${value}"\`);
    return numeric;
  }
  if (type === 'boolean') {
    if (/^(true|1|yes|y)$/i.test(value)) return true;
    if (/^(false|0|no|n)$/i.test(value)) return false;
    throw new Error(\`QAAI data contract: field "\${key}" for \${label} must be boolean, got "\${value}"\`);
  }
  return value;
}`);
  if (requested.has('generateDeterministicValue'))
    chunks.push(`function generateDeterministicValue(contract = {}) {
  const canonical = (value) => value && typeof value === 'object'
    ? JSON.stringify(value, Object.keys(value).sort())
    : String(value);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const length = Number.isFinite(Number(contract.length)) && Number(contract.length) > 0 ? Math.floor(Number(contract.length)) : 12;
  let state = 2166136261;
  for (const character of canonical(contract)) { state ^= character.charCodeAt(0); state = Math.imul(state, 16777619) >>> 0; }
  let generated = '';
  for (let index = 0; index < length; index += 1) { state = Math.imul(state ^ (index + 1), 16777619) >>> 0; generated += alphabet[state % alphabet.length]; }
  return String(contract.prefix || '') + generated;
}`);
  if (requested.has('loadDataRows'))
    chunks.push(`function loadDataRows(relativePath) {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(\`Data file \${relativePath} must contain an array of rows\`);
  return parsed;
}`);
  if (requested.has('resolveLocator'))
    chunks.push(`async function resolveLocator(page, candidates, label = 'element') {
  for (const candidate of candidates || []) {
    const locator = candidate && candidate.strategy === 'role'
      ? page.getByRole(candidate.role, candidate.name ? { name: candidate.name, exact: true } : {})
      : candidate && candidate.selector ? page.locator(candidate.selector) : null;
    if (locator && await locator.count() === 1) return locator;
  }
  throw new Error(\`Unable to resolve a unique locator for \${label}\`);
}`);
  if (requested.has('checkAccessibility'))
    chunks.push(`async function checkAccessibility(page, minImpact = 'critical') {
  const levels = { minor: 0, moderate: 1, serious: 2, critical: 3 };
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const results = await new AxeBuilder({ page }).analyze();
  const threshold = levels[minImpact] == null ? levels.critical : levels[minImpact];
  const violations = results.violations.filter((violation) => (levels[violation.impact || 'critical'] || 3) >= threshold);
  if (violations.length) throw new Error('Accessibility violations: ' + violations.map((violation) => violation.id).join(', '));
}`);
  if (requested.has('evaluateSettled'))
    chunks.push(`async function evaluateSettled(page, fn) {
  try { await page.waitForLoadState('load', { timeout: 8000 }); } catch (error) {
    if (!/timeout/i.test(String(error && error.message))) throw error;
  }
  try { return await page.evaluate(fn); } catch (error) {
    if (!/Execution context was destroyed|context was destroyed|navigation|detached/i.test(String(error && error.message))) throw error;
    await page.waitForLoadState('load', { timeout: 8000 });
    return page.evaluate(fn);
  }
}`);
  if (requested.has('waitForStableObservations'))
    chunks.push(`async function waitForStableObservations(page, options, observe) {
  const timeoutMs = Math.max(1, Math.floor(Number(options && options.timeoutMs) || 1));
  const observations = Math.max(1, Math.floor(Number(options && options.observations) || 1));
  const pollIntervalMs = Math.max(0, Math.floor(Number(options && options.pollIntervalMs) || 0));
  const deadline = Date.now() + timeoutMs;
  for (let index = 0; index < observations; index += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error('Authored stability budget exhausted before all observations completed.');
    await observe(remainingMs);
    if (index + 1 < observations) {
      const delayMs = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}`);

  const exports = [...requested].filter((name) => SUPPORT_HELPERS.has(name));
  if (exports.length)
    chunks.push(
      cjs ? `module.exports = { ${exports.join(', ')} };` : `export { ${exports.join(', ')} };`,
    );
  return `${chunks.filter(Boolean).join('\n\n')}\n`;
}

function removeStandardTelemetryCalls(source) {
  let result = String(source || '');
  const needle = 'test.info().annotations.push(';
  let searchFrom = 0;
  while (searchFrom < result.length) {
    const callStart = result.indexOf(needle, searchFrom);
    if (callStart < 0) break;
    let cursor = callStart + needle.length;
    let depth = 1;
    let quote = null;
    let escaped = false;
    for (; cursor < result.length && depth > 0; cursor += 1) {
      const character = result[cursor];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'" || character === '`') {
        quote = character;
      } else if (character === '(') {
        depth += 1;
      } else if (character === ')') {
        depth -= 1;
      }
    }
    if (depth !== 0) {
      searchFrom = callStart + needle.length;
      continue;
    }
    let removeEnd = cursor;
    if (result[removeEnd] === ';') removeEnd += 1;
    while (result[removeEnd] === ' ' || result[removeEnd] === '\t') removeEnd += 1;
    const lineStart = result.lastIndexOf('\n', callStart - 1) + 1;
    const prefix = result.slice(lineStart, callStart);
    let removeStart = callStart;
    if (/^[ \t]*$/.test(prefix)) {
      removeStart = lineStart;
      if (result[removeEnd] === '\r') removeEnd += 1;
      if (result[removeEnd] === '\n') removeEnd += 1;
    }
    result = result.slice(0, removeStart) + result.slice(removeEnd);
    searchFrom = removeStart;
  }
  return result;
}

function currentGeneratedTestTitle(source, offset) {
  const prefix = String(source || '').slice(0, Math.max(0, offset));
  const matcher = /\btest\(\s*("(?:\\.|[^"\\])*")/g;
  let title = null;
  let match;
  while ((match = matcher.exec(prefix)) !== null) {
    try {
      title = JSON.parse(match[1]);
    } catch (_) {
      title = null;
    }
  }
  return title;
}

function readableContractIdentity(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text))
    return null;
  if (/^(?:case_step|runtime-attempt|kernel-|attempt-|action-evidence-)/i.test(text)) return null;
  return text;
}

function publicDeterministicContract(contract, testTitle) {
  const source =
    contract && typeof contract === 'object' && !Array.isArray(contract) ? contract : {};
  const result = { ...source };
  const readableCase = readableContractIdentity(result.caseId);
  const readableStep = readableContractIdentity(result.stepId);
  delete result.caseId;
  delete result.stepId;
  delete result.contractStepId;
  delete result.runtimeActionId;
  delete result.actionEvidenceId;
  const semanticScope = [
    readableContractIdentity(testTitle),
    readableCase,
    readableStep,
    readableContractIdentity(result.name),
  ].filter(Boolean);
  if (semanticScope.length) result.scope = [...new Set(semanticScope)].join(' / ');
  return result;
}

function rewriteStandardDeterministicContracts(source) {
  let result = String(source || '');
  const needle = 'generateDeterministicValue(';
  let searchFrom = 0;
  while (searchFrom < result.length) {
    const callStart = result.indexOf(needle, searchFrom);
    if (callStart < 0) break;
    const argumentStart = callStart + needle.length;
    let cursor = argumentStart;
    let depth = 1;
    let quote = null;
    let escaped = false;
    for (; cursor < result.length && depth > 0; cursor += 1) {
      const character = result[cursor];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'" || character === '`') quote = character;
      else if (character === '(') depth += 1;
      else if (character === ')') depth -= 1;
    }
    if (depth !== 0) {
      searchFrom = argumentStart;
      continue;
    }
    const argumentEnd = cursor - 1;
    const rawArgument = result.slice(argumentStart, argumentEnd).trim();
    try {
      const parsed = JSON.parse(rawArgument);
      const title = currentGeneratedTestTitle(result, callStart);
      const replacement = JSON.stringify(publicDeterministicContract(parsed, title));
      result = result.slice(0, argumentStart) + replacement + result.slice(argumentEnd);
      searchFrom = argumentStart + replacement.length + 1;
    } catch (_) {
      searchFrom = cursor;
    }
  }
  return result;
}

function normalizeCorruptedGeneratedText(source) {
  return String(source == null ? '' : source)
    .replace(/\u00e2\u201d\u20ac/g, '-')
    .replace(/\u00e2\u20ac\u201d/g, '--')
    .replace(/\u00e2\u2020\u2019/g, '->')
    .replace(/\u00e2\u2020\u2014/g, '<->')
    .replace(/\u00c2\u00a7/g, 'Section ')
    .replace(/\u00e2[^\x00-\x7f]{2}/g, '-')
    .replace(/\u00c2(?=[^\x00-\x7f])/g, '');
}

function asciiSafeGeneratedFormatting(source, markdown = false) {
  return normalizeCorruptedGeneratedText(source)
    .split('\n')
    .map((line) => {
      const formattingOnly = markdown || /^\s*(?:\/\/|\/\*|\*|#)/.test(line);
      if (!formattingOnly) return line;
      return line
        .replace(/[\u2500-\u257f]/g, '-')
        .replace(/[\u2010-\u2015]/g, '-')
        .replace(/\u2192/g, '->')
        .replace(/\u2194/g, '<->')
        .replace(/\u00a7/g, 'Section ');
    })
    .join('\n');
}

function sanitizeStandardUserSource(source, filePath = '') {
  const sanitized = rewriteStandardDeterministicContracts(removeStandardTelemetryCalls(source)).replace(
    /^[ \t]*\/\/ STATUS: DRAFT[^\r\n]*(?:\r?\n)?/gim,
    '',
  );
  return asciiSafeGeneratedFormatting(sanitized, /\.md$/i.test(String(filePath || '')));
}

function isStandardUserSourceFile(filePath) {
  return /\.(?:cjs|mjs|js|ts|md)$/i.test(String(filePath || ''));
}

function finalizeStandardOutput(output) {
  if (!output || typeof output !== 'object') return output;
  const supportPath = 'tests/support/replayir.js';
  const content = sanitizeStandardUserSource(output.content, 'generated.spec.js');
  const extraFiles = Object.fromEntries(
    Object.entries(output.extraFiles || {}).map(([filePath, fileSource]) => [
      filePath,
      isStandardUserSourceFile(filePath) ? sanitizeStandardUserSource(fileSource, filePath) : fileSource,
    ]),
  );
  const sanitizedOutput = { ...output, content, extraFiles };
  const supportNames = importedSupportHelpers(sanitizedOutput);
  if (supportNames.size) {
    const cjs = /\brequire\(['"][^'"]*support\/replayir(?:\.js)?['"]\)/.test(String(content || ''));
    extraFiles[supportPath] = sanitizeStandardUserSource(
      minimalSupportSource(supportNames, cjs),
      supportPath,
    );
  } else {
    delete extraFiles[supportPath];
  }
  return {
    ...output,
    content,
    extraFiles,
  };
}

module.exports = {
  prepareCasesForStandardOutput,
  finalizeStandardOutput,
  _prepareCaseForStandardOutput: prepareCaseForStandardOutput,
  _minimalSupportSource: minimalSupportSource,
  _semanticSimilarity: semanticSimilarity,
  _stableObservedUrl: stableObservedUrl,
  _sanitizeStandardUserSource: sanitizeStandardUserSource,
};
