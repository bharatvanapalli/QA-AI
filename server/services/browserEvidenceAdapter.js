'use strict';

const crypto = require('crypto');
const eventRecorder = require('./inPageEventRecorder');

const SCHEMA_VERSION = 'qaai.browser-evidence.v1';
const CAPTURE_PHASES = Object.freeze(['pre', 'action', 'post']);
const SOURCE_AUTHORITY = Object.freeze({
  playwright: Object.freeze({
    level: 'authoritative_observation',
    rank: 90,
    proves: Object.freeze(['locator_resolution', 'actionability', 'framework_readback']),
    doesNotProve: Object.freeze(['requested_target_intent']),
  }),
  cdp: Object.freeze({
    level: 'authoritative_observation',
    rank: 90,
    proves: Object.freeze(['browser_node_identity', 'frame_identity', 'layout', 'hit_test']),
    doesNotProve: Object.freeze(['requested_target_intent']),
  }),
  accessibility: Object.freeze({
    level: 'authoritative_observation',
    rank: 85,
    proves: Object.freeze(['accessibility_role', 'accessibility_name', 'accessibility_state']),
    doesNotProve: Object.freeze(['requested_target_intent']),
  }),
  dom: Object.freeze({
    level: 'direct_observation',
    rank: 80,
    proves: Object.freeze(['dom_identity', 'dom_state', 'control_value']),
    doesNotProve: Object.freeze(['requested_target_intent']),
  }),
  browser_event: Object.freeze({
    level: 'corroborating',
    rank: 70,
    proves: Object.freeze(['browser_event_observed', 'event_target_path']),
    doesNotProve: Object.freeze(['requested_target_intent']),
  }),
  screenshot: Object.freeze({
    level: 'supporting',
    rank: 30,
    proves: Object.freeze(['rendered_visual_context']),
    doesNotProve: Object.freeze(['requested_target_intent', 'dom_identity', 'control_value']),
  }),
  suggestion: Object.freeze({
    level: 'advisory',
    rank: 10,
    proves: Object.freeze([]),
    doesNotProve: Object.freeze(['requested_target_intent', 'browser_observation']),
  }),
  unknown: Object.freeze({
    level: 'unclassified',
    rank: 0,
    proves: Object.freeze([]),
    doesNotProve: Object.freeze(['requested_target_intent', 'browser_observation']),
  }),
});

const SENSITIVE_KEY_RE = /(?:password|passwd|passphrase|secret|token|api[_-]?key|authorization|cookie|session(?:id)?|otp|pin|credential|client[_-]?secret)/i;
const STABLE_ATTRIBUTE_NAMES = new Set([
  'id', 'name', 'type', 'role', 'title', 'alt', 'placeholder',
  'data-testid', 'data-test-id', 'data-qaai-id', 'data-qaai-role', 'data-qaai-row-key',
  'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns',
  'aria-expanded', 'aria-selected', 'aria-checked', 'aria-disabled', 'aria-hidden',
  'disabled', 'readonly', 'contenteditable', 'value',
]);

function cloneAuthority(authority) {
  return {
    level: authority.level,
    rank: authority.rank,
    proves: Array.from(authority.proves),
    doesNotProve: Array.from(authority.doesNotProve),
  };
}

function sourceAuthority(source) {
  const key = String(source || '').toLowerCase();
  if (key.includes('playwright')) return cloneAuthority(SOURCE_AUTHORITY.playwright);
  if (key.includes('cdp') || key.includes('devtools')) return cloneAuthority(SOURCE_AUTHORITY.cdp);
  if (key === 'ax' || key.includes('accessibility')) return cloneAuthority(SOURCE_AUTHORITY.accessibility);
  if (key.includes('dom')) return cloneAuthority(SOURCE_AUTHORITY.dom);
  if (key.includes('event')) return cloneAuthority(SOURCE_AUTHORITY.browser_event);
  if (key.includes('screenshot') || key.includes('visual')) return cloneAuthority(SOURCE_AUTHORITY.screenshot);
  if (key.includes('stagehand') || key.includes('model') || key.includes('suggest')) return cloneAuthority(SOURCE_AUTHORITY.suggestion);
  return cloneAuthority(SOURCE_AUTHORITY.unknown);
}

function stableId(prefix = 'evidence') {
  return `${prefix}-${crypto.randomUUID()}`;
}

function finiteNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function triState(value) {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function sanitizeString(value, maxLength = 1000) {
  return eventRecorder.sanitizeText(value, { maxLength });
}

function normalizeValueRef(value) {
  if (!value) return null;
  const candidate = typeof value === 'object'
    ? value.valueRef || value.ref || value.id || value.key || null
    : value;
  const normalized = sanitizeString(candidate, 300);
  if (!normalized || /\s/.test(normalized) || normalized.includes('[REDACTED]')) return null;
  return normalized;
}

function knownSensitiveValues(request = {}) {
  const values = [];
  const add = (value) => {
    const candidate = value && typeof value === 'object' && Object.hasOwn(value, 'value')
      ? value.value
      : value;
    if (typeof candidate === 'string' && candidate.length > 0) values.push(candidate);
  };
  add(request.expectedValue);
  add(request.value);
  for (const key of ['password', 'passwd', 'passphrase', 'secret', 'token', 'authorization', 'credential', 'otp', 'pin']) {
    add(request[key]);
  }
  return Array.from(new Set(values)).sort((left, right) => right.length - left.length);
}

function buildPrivacyContext(request = {}, { fingerprintSalt = 'qaai-browser-evidence' } = {}) {
  const sensitive = Boolean(request.sensitive)
    || isSensitiveIdentity(request)
    || SENSITIVE_KEY_RE.test([request.targetDescription, request.controlType, request.inputType]
      .filter(Boolean).join(' '));
  const expectedObject = request.expectedValue && typeof request.expectedValue === 'object'
    ? request.expectedValue
    : {};
  const valueRef = normalizeValueRef(
    request.valueRef
      || request.expectedValueRef
      || request.binding?.valueRef
      || expectedObject.valueRef,
  );
  return {
    sensitive,
    valueRef,
    valueRefRequired: sensitive,
    valueRefMissing: Boolean(sensitive && !valueRef),
    persistence: sensitive ? 'value_ref_only' : 'literal_allowed',
    fingerprintSalt,
    knownSecrets: sensitive ? knownSensitiveValues(request) : [],
  };
}

function redactKnownSecrets(value, privacyContext = {}, maxLength = 1000) {
  if (value == null) return value;
  let output = String(value);
  for (const secret of privacyContext.knownSecrets || []) {
    if (secret) output = output.split(secret).join('[REDACTED]');
  }
  return sanitizeString(output, maxLength);
}

function isSensitiveIdentity(input) {
  if (!input || typeof input !== 'object') return false;
  return eventRecorder.isSensitiveDescriptor(input)
    || SENSITIVE_KEY_RE.test([
      input.name,
      input.label,
      input.ariaLabel,
      input.placeholder,
      input.inputType,
      input.type,
      input.locator,
    ].filter(Boolean).join(' '));
}

function normalizeObservedValue(value, {
  sensitive = false,
  fingerprintSalt = 'qaai-browser-evidence',
  valueRef = null,
  privacyContext = null,
} = {}) {
  if (value == null) {
    return {
      value: null,
      valueRef: sensitive ? normalizeValueRef(valueRef || privacyContext?.valueRef) : null,
      valueFingerprint: null,
      redacted: Boolean(sensitive),
      persistedLiteral: false,
    };
  }
  const raw = typeof value === 'object' && value !== null && Object.hasOwn(value, 'value')
    ? value.value
    : value;
  const suppliedFingerprint = typeof value === 'object' && value !== null
    ? value.valueFingerprint || value.fingerprint
    : null;
  const valueFingerprint = suppliedFingerprint && typeof suppliedFingerprint === 'object'
    ? {
      algorithm: sanitizeString(suppliedFingerprint.algorithm, 40),
      digest: sanitizeString(suppliedFingerprint.digest, 160),
      length: finiteNumber(suppliedFingerprint.length),
      present: Boolean(suppliedFingerprint.present),
      sensitive: Boolean(suppliedFingerprint.sensitive || sensitive),
    }
    : eventRecorder.fingerprintValue(raw, { salt: fingerprintSalt, sensitive });
  return {
    value: sensitive ? null : redactKnownSecrets(raw, privacyContext || {}, 1000),
    valueRef: sensitive ? normalizeValueRef(valueRef || privacyContext?.valueRef) : null,
    valueFingerprint,
    redacted: Boolean(sensitive),
    persistedLiteral: !sensitive,
  };
}

function normalizeAttributes(attributes, { sensitive = false, fingerprintSalt, privacyContext } = {}) {
  if (!attributes) return {};
  const entries = Array.isArray(attributes)
    ? Array.from({ length: Math.floor(attributes.length / 2) }, (_, index) => [attributes[index * 2], attributes[index * 2 + 1]])
    : Object.entries(attributes);
  const normalized = {};
  for (const [rawName, rawValue] of entries) {
    const name = String(rawName || '').toLowerCase();
    if (!STABLE_ATTRIBUTE_NAMES.has(name)) continue;
    if (name === 'value') {
      normalized[name] = normalizeObservedValue(rawValue, {
        sensitive,
        fingerprintSalt,
        valueRef: privacyContext?.valueRef,
        privacyContext,
      });
      continue;
    }
    normalized[name] = redactKnownSecrets(rawValue, privacyContext || {}, 500);
  }
  return normalized;
}

function normalizeBounds(input) {
  if (!input || typeof input !== 'object') return null;
  if (Array.isArray(input)) {
    const numbers = input.map(finiteNumber).filter((value) => value != null);
    return numbers.length ? { points: numbers } : null;
  }
  const x = finiteNumber(input.x ?? input.left);
  const y = finiteNumber(input.y ?? input.top);
  const width = finiteNumber(input.width);
  const height = finiteNumber(input.height);
  if ([x, y, width, height].every((value) => value == null)) return null;
  return { x, y, width, height };
}

function normalizePath(input, options = {}) {
  return (Array.isArray(input) ? input : [])
    .slice(0, 32)
    .map((entry) => {
      if (typeof entry === 'string') return redactKnownSecrets(entry, options.privacyContext || {}, 300);
      if (!entry || typeof entry !== 'object') return null;
      return {
        frameId: redactKnownSecrets(entry.frameId || null, options.privacyContext || {}, 160),
        url: eventRecorder.sanitizeUrl(redactKnownSecrets(entry.url || '', options.privacyContext || {}, 1000)),
        backendNodeId: finiteNumber(entry.backendNodeId),
        nodeId: finiteNumber(entry.nodeId),
        tagName: sanitizeString(entry.tagName || entry.localName || null, 80)?.toLowerCase() || null,
        role: sanitizeString(entry.role || null, 120),
        name: redactKnownSecrets(entry.name || entry.ariaLabel || null, options.privacyContext || {}, 300),
        selectorHint: redactKnownSecrets(entry.selectorHint || entry.selector || null, options.privacyContext || {}, 500),
      };
    })
    .filter(Boolean);
}

function normalizeSemanticIdentity(input, options = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const attributes = source.attributes || source.attrs || {};
  const sensitive = Boolean(options.sensitive) || isSensitiveIdentity({ ...source, ...attributes });
  const normalizedAttributes = normalizeAttributes(attributes, {
    sensitive,
    fingerprintSalt: options.fingerprintSalt,
    privacyContext: options.privacyContext,
  });
  const field = (direct, attributeName, max = 300) => redactKnownSecrets(
    source[direct] ?? normalizedAttributes[attributeName] ?? null,
    options.privacyContext || {},
    max,
  );
  return {
    tagName: field('tagName', 'tagName', 80)?.toLowerCase()
      || field('localName', 'localName', 80)?.toLowerCase()
      || null,
    role: field('role', 'role', 120)?.toLowerCase() || null,
    name: field('name', 'aria-label') || field('ariaLabel', 'aria-label'),
    label: field('label', 'aria-labelledby'),
    description: field('description', 'aria-describedby', 500),
    placeholder: field('placeholder', 'placeholder'),
    title: field('title', 'title'),
    alt: field('alt', 'alt'),
    testId: source.testId
      ? sanitizeString(source.testId, 200)
      : normalizedAttributes['data-testid'] || normalizedAttributes['data-test-id'] || normalizedAttributes['data-qaai-id'] || null,
    inputType: (field('inputType', 'type', 80) || field('type', 'type', 80))?.toLowerCase() || null,
    id: field('id', 'id', 200),
    attributes: normalizedAttributes,
    sensitive,
  };
}

function normalizeState(input, options = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const identity = options.identity || normalizeSemanticIdentity(source, options);
  const sensitive = Boolean(options.sensitive ?? identity.sensitive);
  const observedValue = normalizeObservedValue(
    source.value ?? source.currentValue ?? source.inputValue ?? source.displayedValue ?? null,
    {
      sensitive,
      fingerprintSalt: options.fingerprintSalt,
      valueRef: options.privacyContext?.valueRef,
      privacyContext: options.privacyContext,
    },
  );
  return {
    visible: triState(source.visible ?? source.isVisible),
    hidden: triState(source.hidden ?? source.isHidden),
    enabled: triState(source.enabled ?? (source.disabled == null ? null : !source.disabled)),
    disabled: triState(source.disabled),
    editable: triState(source.editable ?? source.isEditable),
    readOnly: triState(source.readOnly ?? source.readonly),
    focused: triState(source.focused),
    expanded: triState(source.expanded ?? source.ariaExpanded),
    selected: triState(source.selected ?? source.ariaSelected),
    checked: triState(source.checked ?? source.ariaChecked),
    receivesEvents: triState(source.receivesEvents ?? source.hitTarget),
    stable: triState(source.stable),
    value: observedValue.value,
    valueRef: observedValue.valueRef,
    valueFingerprint: observedValue.valueFingerprint,
    valueRedacted: observedValue.redacted,
    valueLiteralPersisted: observedValue.persistedLiteral,
  };
}

function normalizeLocator(locator, { privacyContext = null } = {}) {
  if (!locator) return null;
  if (typeof locator === 'string') {
    return { strategy: null, expression: redactKnownSecrets(locator, privacyContext || {}, 1000) };
  }
  return {
    strategy: redactKnownSecrets(locator.strategy || locator.kind || locator.source || null, privacyContext || {}, 100),
    expression: redactKnownSecrets(locator.expression || locator.locator || locator.selector || null, privacyContext || {}, 1000),
    count: finiteNumber(locator.count ?? locator.matchCount),
    unique: triState(locator.unique ?? (locator.count == null ? null : Number(locator.count) === 1)),
  };
}

function normalizePlaywrightEvidence(input, options = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const targetSource = source.target || source.element || source;
  const identity = normalizeSemanticIdentity(targetSource, options);
  return {
    locator: normalizeLocator(source.locator || source.locatorEvidence || source.selector, {
      privacyContext: options.privacyContext,
    }),
    identity,
    state: normalizeState({ ...targetSource, ...(source.state || {}), ...(source.actionability || {}) }, {
      ...options,
      identity,
    }),
    bounds: normalizeBounds(source.boundingBox || source.bounds || targetSource.boundingBox),
    action: {
      type: sanitizeString(source.action?.type || source.actionType || null, 100),
      dispatched: triState(source.action?.dispatched ?? source.dispatched),
      completed: triState(source.action?.completed ?? source.completed),
      error: redactKnownSecrets(source.action?.error || source.error || null, options.privacyContext || {}, 1000),
    },
  };
}

function normalizeHitTest(input) {
  if (!input || typeof input !== 'object') return null;
  return {
    backendNodeId: finiteNumber(input.backendNodeId ?? input.hitBackendNodeId),
    nodeId: finiteNumber(input.nodeId ?? input.hitNodeId),
    sameNode: triState(input.sameNode ?? input.matchesResolvedNode),
    receivesEvents: triState(input.receivesEvents),
    x: finiteNumber(input.x),
    y: finiteNumber(input.y),
  };
}

function normalizeCdpEvidence(input, options = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const identity = normalizeSemanticIdentity(source, options);
  return {
    backendNodeId: finiteNumber(source.backendNodeId ?? source.backendDOMNodeId),
    nodeId: finiteNumber(source.nodeId),
    frameId: redactKnownSecrets(source.frameId || null, options.privacyContext || {}, 200),
    loaderId: redactKnownSecrets(source.loaderId || null, options.privacyContext || {}, 200),
    framePath: normalizePath(source.framePath, options),
    shadowPath: normalizePath(source.shadowPath, options),
    identity,
    state: normalizeState(source, { ...options, identity }),
    bounds: normalizeBounds(source.boundingBox || source.bounds || source.boxModel?.content),
    hitTest: normalizeHitTest(source.hitTest),
    documentUrl: eventRecorder.sanitizeUrl(redactKnownSecrets(
      source.documentUrl || source.url || '',
      options.privacyContext || {},
      1000,
    )),
  };
}

function normalizeAxPropertyMap(properties) {
  if (!properties) return {};
  if (!Array.isArray(properties)) return { ...properties };
  return properties.reduce((result, property) => {
    const name = property?.name;
    if (name) result[name] = property?.value?.value ?? property?.value ?? null;
    return result;
  }, {});
}

function normalizeAxEvidence(input, options = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const properties = normalizeAxPropertyMap(source.properties);
  const merged = {
    ...source,
    role: source.role?.value ?? source.role,
    name: source.name?.value ?? source.name,
    description: source.description?.value ?? source.description,
    value: source.value?.value ?? source.value,
    expanded: source.expanded ?? properties.expanded,
    selected: source.selected ?? properties.selected,
    checked: source.checked ?? properties.checked,
    disabled: source.disabled ?? properties.disabled,
    focused: source.focused ?? properties.focused,
    hidden: source.hidden ?? properties.hidden,
  };
  const identity = normalizeSemanticIdentity(merged, options);
  return {
    axNodeId: sanitizeString(source.nodeId || source.axNodeId || null, 200),
    backendNodeId: finiteNumber(source.backendNodeId ?? source.backendDOMNodeId),
    parentId: sanitizeString(source.parentId || null, 200),
    childIds: (Array.isArray(source.childIds) ? source.childIds : []).map((value) => sanitizeString(value, 200)),
    identity,
    state: normalizeState(merged, { ...options, identity }),
  };
}

function normalizeDomEvidence(input, options = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const identity = normalizeSemanticIdentity(source, options);
  return {
    nodeId: finiteNumber(source.nodeId),
    backendNodeId: finiteNumber(source.backendNodeId ?? source.backendDOMNodeId),
    frameId: redactKnownSecrets(source.frameId || null, options.privacyContext || {}, 200),
    framePath: normalizePath(source.framePath, options),
    shadowPath: normalizePath(source.shadowPath, options),
    identity,
    state: normalizeState(source, { ...options, identity }),
    bounds: normalizeBounds(source.boundingRect || source.boundingBox || source.bounds),
    owner: normalizeSemanticIdentity(source.owner || {}, options),
    popup: normalizeSemanticIdentity(source.popup || {}, options),
  };
}

function normalizeScreenshotEvidence(input, options = {}) {
  if (!input || typeof input !== 'object') return null;
  const privacyContext = options.privacyContext || {};
  const redacted = triState(input.redacted);
  const suppressed = Boolean(privacyContext.sensitive && redacted !== true);
  return {
    artifactRef: suppressed
      ? null
      : redactKnownSecrets(input.artifactRef || input.path || input.ref || null, privacyContext, 1000),
    sha256: !suppressed && /^[a-f0-9]{64}$/i.test(String(input.sha256 || ''))
      ? String(input.sha256).toLowerCase()
      : null,
    width: finiteNumber(input.width),
    height: finiteNumber(input.height),
    capturedAt: Number.isFinite(Number(input.capturedAt)) ? Number(input.capturedAt) : null,
    redacted,
    suppressed,
    suppressionReason: suppressed ? 'sensitive_capture_requires_explicit_redaction' : null,
  };
}

function normalizeSourceFacts(source, raw, options = {}) {
  const key = String(source || '').toLowerCase();
  if (key.includes('playwright')) return normalizePlaywrightEvidence(raw, options);
  if (key.includes('cdp') || key.includes('devtools')) return normalizeCdpEvidence(raw, options);
  if (key === 'ax' || key.includes('accessibility')) return normalizeAxEvidence(raw, options);
  if (key.includes('dom')) return normalizeDomEvidence(raw, options);
  if (key.includes('event')) {
    return {
      events: eventRecorder.normalizeRecorderEvents(raw?.events || raw, {
        ...options,
        defaultValueRef: options.privacyContext?.valueRef || null,
      }),
    };
  }
  if (key.includes('screenshot') || key.includes('visual')) return normalizeScreenshotEvidence(raw, options);
  return toSerializable(raw, options);
}

function redactSensitiveScalar(value, key, options) {
  const fingerprint = eventRecorder.fingerprintValue(value, {
    salt: options.fingerprintSalt || 'qaai-browser-evidence',
    sensitive: true,
  });
  return {
    redacted: true,
    key: sanitizeString(key, 100),
    valueRef: normalizeValueRef(options.privacyContext?.valueRef),
    valueFingerprint: fingerprint,
    persistedLiteral: false,
  };
}

function toSerializable(input, options = {}, state = {
  seen: new WeakSet(),
  inheritedSensitive: Boolean(options.sensitive),
  key: '',
}) {
  if (input == null || typeof input === 'boolean' || typeof input === 'number' || typeof input === 'string') {
    if ((state.inheritedSensitive || SENSITIVE_KEY_RE.test(state.key)) && typeof input === 'string') {
      return redactSensitiveScalar(input, state.key, options);
    }
    return typeof input === 'string'
      ? redactKnownSecrets(input, options.privacyContext || {}, 5000)
      : input;
  }
  if (typeof input === 'bigint') return input.toString();
  if (input instanceof Date) return input.toISOString();
  if (Buffer.isBuffer(input) || ArrayBuffer.isView(input)) {
    return { omittedBinary: true, byteLength: input.byteLength };
  }
  if (typeof input === 'function' || typeof input === 'symbol' || typeof input === 'undefined') return null;
  if (typeof input !== 'object') return redactKnownSecrets(input, options.privacyContext || {}, 5000);
  if (state.seen.has(input)) return '[Circular]';
  state.seen.add(input);
  if (Array.isArray(input)) {
    return input.map((value) => toSerializable(value, options, {
      seen: state.seen,
      inheritedSensitive: state.inheritedSensitive,
      key: state.key,
    }));
  }
  const objectSensitive = state.inheritedSensitive || isSensitiveIdentity(input);
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'function' || typeof value === 'undefined') continue;
    const keySensitive = objectSensitive && /^(?:value|currentValue|inputValue|displayedValue)$/i.test(key)
      || SENSITIVE_KEY_RE.test(key);
    output[key] = toSerializable(value, options, {
      seen: state.seen,
      inheritedSensitive: keySensitive,
      key,
    });
  }
  return output;
}

function observedIdentityFromSources(sources) {
  const sorted = (Array.isArray(sources) ? sources : [])
    .filter((source) => source?.status === 'captured' && source?.facts)
    .sort((left, right) => (right.authority?.rank || 0) - (left.authority?.rank || 0));
  const identity = {};
  const provenance = {};
  const assign = (key, value, source) => {
    if (identity[key] == null && value != null && value !== '') {
      identity[key] = value;
      provenance[key] = source;
    }
  };
  for (const source of sorted) {
    const facts = source.facts;
    const candidate = facts.identity || facts.target?.identity || null;
    if (!candidate) continue;
    for (const key of ['tagName', 'role', 'name', 'label', 'description', 'placeholder', 'title', 'alt', 'testId', 'inputType', 'id']) {
      assign(key, candidate[key], source.source);
    }
    assign('sensitive', candidate.sensitive, source.source);
  }
  return {
    facts: identity,
    provenance,
    intentAssessment: 'not_performed',
    intentMatch: null,
    note: 'Observed browser identity only; target-intent matching belongs to the semantic resolver.',
  };
}

function correlateSourceIdentity(sources) {
  const captured = (Array.isArray(sources) ? sources : [])
    .filter((entry) => entry?.status === 'captured' && entry?.facts);
  const observations = captured.map((entry) => ({
    source: entry.source,
    backendNodeId: finiteNumber(entry.facts.backendNodeId ?? entry.facts.identity?.backendNodeId),
    frameId: sanitizeString(entry.facts.frameId || null, 200),
    framePath: Array.isArray(entry.facts.framePath) ? entry.facts.framePath : [],
    shadowPath: Array.isArray(entry.facts.shadowPath) ? entry.facts.shadowPath : [],
    tagName: entry.facts.identity?.tagName || null,
    role: entry.facts.identity?.role || null,
    name: entry.facts.identity?.name || null,
  }));
  const agreement = (field) => {
    const facts = observations.filter((entry) => entry[field] != null && entry[field] !== '');
    const values = Array.from(new Set(facts.map((entry) => String(entry[field]))));
    return {
      status: values.length > 1 ? 'conflict' : facts.length >= 2 ? 'matched' : 'insufficient',
      value: values.length === 1 ? facts[0][field] : null,
      sources: facts.map((entry) => entry.source),
      observedValues: values,
    };
  };
  const fieldConflicts = {};
  for (const field of ['tagName', 'role', 'name']) {
    const result = agreement(field);
    if (result.status === 'conflict') fieldConflicts[field] = result.observedValues;
  }
  const pathSource = observations.find((entry) => entry.framePath.length || entry.shadowPath.length) || null;
  return {
    backendNode: agreement('backendNodeId'),
    frame: agreement('frameId'),
    framePath: pathSource?.framePath || [],
    shadowPath: pathSource?.shadowPath || [],
    fieldConflicts,
    semanticIntentAssessment: 'not_performed',
    note: 'Cross-source browser identity correlation only; requested-intent matching is external.',
  };
}

function normalizeRequest(request = {}, options = {}) {
  const privacyContext = options.privacyContext || buildPrivacyContext(request, options);
  const expectedSensitive = privacyContext.sensitive;
  return {
    actionOccurrenceId: sanitizeString(request.actionOccurrenceId || request.occurrenceId || null, 200),
    stepId: sanitizeString(request.stepId || request.contractStepId || null, 200),
    attemptId: sanitizeString(request.actionAttemptId || request.attemptId || null, 200),
    retryOfActionEvidenceId: sanitizeString(request.retryOfActionEvidenceId || null, 200),
    actionType: sanitizeString(request.actionType || request.action || null, 100),
    controlType: sanitizeString(request.controlType || null, 100),
    targetDescription: redactKnownSecrets(
      request.targetDescription || request.target || null,
      privacyContext,
      500,
    ),
    expectedValue: normalizeObservedValue(request.expectedValue ?? request.value ?? null, {
      sensitive: expectedSensitive,
      fingerprintSalt: options.fingerprintSalt,
      valueRef: privacyContext.valueRef,
      privacyContext,
    }),
    privacy: {
      sensitive: privacyContext.sensitive,
      persistence: privacyContext.persistence,
      valueRef: privacyContext.valueRef,
      valueRefRequired: privacyContext.valueRefRequired,
      valueRefMissing: privacyContext.valueRefMissing,
      rawLiteralPersisted: false,
    },
    semanticIntentStatus: 'unassessed',
  };
}

function createCaptureEnvelope({
  phase,
  request = {},
  sources = [],
  capturedAt = Date.now(),
  evidenceId = stableId('browser-evidence'),
  options = {},
} = {}) {
  if (!CAPTURE_PHASES.includes(phase)) throw new Error(`Unsupported browser evidence phase: ${phase}`);
  const privacyContext = options.privacyContext || buildPrivacyContext(request, options);
  const normalizedSources = toSerializable(sources, { ...options, privacyContext });
  const normalizedRequest = normalizeRequest(request, { ...options, privacyContext });
  return {
    schemaVersion: SCHEMA_VERSION,
    evidenceId: sanitizeString(evidenceId, 200),
    phase,
    capturedAt: Number(capturedAt),
    request: normalizedRequest,
    sources: normalizedSources,
    observedIdentity: observedIdentityFromSources(normalizedSources),
    sourceCorrelation: correlateSourceIdentity(normalizedSources),
    privacy: normalizedRequest.privacy,
    semanticIntentClaimed: false,
  };
}

class BrowserEvidenceAdapter {
  constructor({ now = Date.now, idFactory = stableId, fingerprintSalt = 'qaai-browser-evidence' } = {}) {
    this.now = now;
    this.idFactory = idFactory;
    this.fingerprintSalt = fingerprintSalt;
  }

  async startRun(context = {}) {
    return {
      adapter: this.constructor.name,
      startedAt: this.now(),
      runId: sanitizeString(context.runId || context.runResultId || null, 200),
    };
  }

  async stopRun(context = {}) {
    return {
      adapter: this.constructor.name,
      stoppedAt: this.now(),
      runId: sanitizeString(context.runId || context.runResultId || null, 200),
    };
  }

  async beforeAction(request = {}) {
    return this.capturePhase('pre', request);
  }

  async captureAction(request = {}) {
    return this.capturePhase('action', request);
  }

  async afterAction(request = {}) {
    return this.capturePhase('post', request);
  }

  async capturePhase() {
    throw new Error('BrowserEvidenceAdapter.capturePhase must be implemented by an adapter');
  }

  async captureLocatorEvidence(request = {}) {
    return this.beforeAction(request);
  }

  async captureNavigationEvidence(request = {}) {
    return this.afterAction({ ...request, actionType: request.actionType || 'navigate' });
  }

  async captureNetworkEvidence() {
    return null;
  }
}

function bindCapture(source) {
  if (typeof source === 'function') return source;
  if (source && typeof source.capture === 'function') return source.capture.bind(source);
  if (source && typeof source.drain === 'function') return source.drain.bind(source);
  return null;
}

function captureRequestForProvider(request = {}, privacyContext = {}) {
  const output = { ...request };
  if (privacyContext.sensitive) {
    for (const key of [
      'value', 'expectedValue', 'inputValue', 'currentValue', 'displayedValue',
      'password', 'passwd', 'passphrase', 'secret', 'token', 'authorization',
      'credential', 'otp', 'pin',
    ]) {
      delete output[key];
    }
    output.valueRef = privacyContext.valueRef;
    output.sensitive = true;
  }
  if (typeof output.targetDescription === 'string') {
    output.targetDescription = redactKnownSecrets(output.targetDescription, privacyContext, 500);
  }
  if (typeof output.target === 'string') {
    output.target = redactKnownSecrets(output.target, privacyContext, 500);
  }
  output.privacy = {
    sensitive: Boolean(privacyContext.sensitive),
    persistence: privacyContext.persistence || 'literal_allowed',
    valueRef: privacyContext.valueRef || null,
    valueRefMissing: Boolean(privacyContext.valueRefMissing),
  };
  return output;
}

class PlaywrightCdpEvidenceAdapter extends BrowserEvidenceAdapter {
  constructor({
    capturePlaywright,
    captureCdp,
    captureAx,
    captureDom,
    captureEvents,
    captureScreenshot,
    lifecycle = {},
    ...baseOptions
  } = {}) {
    super(baseOptions);
    this.captures = {
      playwright: bindCapture(capturePlaywright),
      cdp: bindCapture(captureCdp),
      accessibility: bindCapture(captureAx),
      dom: bindCapture(captureDom),
      browser_event: bindCapture(captureEvents),
      screenshot: bindCapture(captureScreenshot),
    };
    this.lifecycle = lifecycle;
  }

  async startRun(context = {}) {
    const base = await super.startRun(context);
    const result = typeof this.lifecycle.startRun === 'function'
      ? await this.lifecycle.startRun(context)
      : null;
    return { ...base, lifecycle: toSerializable(result, { fingerprintSalt: this.fingerprintSalt }) };
  }

  async stopRun(context = {}) {
    const result = typeof this.lifecycle.stopRun === 'function'
      ? await this.lifecycle.stopRun(context)
      : null;
    const base = await super.stopRun(context);
    return { ...base, lifecycle: toSerializable(result, { fingerprintSalt: this.fingerprintSalt }) };
  }

  async captureSource(source, capture, phase, request) {
    const authority = sourceAuthority(source);
    const privacyContext = buildPrivacyContext(request, { fingerprintSalt: this.fingerprintSalt });
    if (!capture) {
      return { source, authority, status: 'unavailable', capturedAt: this.now(), facts: null };
    }
    try {
      const raw = await capture({
        phase,
        request: captureRequestForProvider(request, privacyContext),
      });
      if (raw == null) {
        return { source, authority, status: 'unavailable', capturedAt: this.now(), facts: null };
      }
      return {
        source,
        authority,
        status: 'captured',
        capturedAt: this.now(),
        facts: normalizeSourceFacts(source, raw, {
          fingerprintSalt: this.fingerprintSalt,
          privacyContext,
          sensitive: privacyContext.sensitive,
        }),
      };
    } catch (error) {
      return {
        source,
        authority,
        status: 'capture_error',
        capturedAt: this.now(),
        facts: null,
        error: {
          name: sanitizeString(error?.name || 'Error', 100),
          message: redactKnownSecrets(
            error?.message || 'Evidence capture failed',
            privacyContext,
            1000,
          ),
        },
      };
    }
  }

  async capturePhase(phase, request = {}) {
    if (!CAPTURE_PHASES.includes(phase)) throw new Error(`Unsupported browser evidence phase: ${phase}`);
    const sources = [];
    for (const [source, capture] of Object.entries(this.captures)) {
      sources.push(await this.captureSource(source, capture, phase, request));
    }
    const privacyContext = buildPrivacyContext(request, { fingerprintSalt: this.fingerprintSalt });
    return createCaptureEnvelope({
      phase,
      request,
      sources,
      capturedAt: this.now(),
      evidenceId: this.idFactory('browser-evidence'),
      options: { fingerprintSalt: this.fingerprintSalt, privacyContext },
    });
  }
}

module.exports = {
  SCHEMA_VERSION,
  CAPTURE_PHASES,
  SOURCE_AUTHORITY,
  BrowserEvidenceAdapter,
  PlaywrightCdpEvidenceAdapter,
  sourceAuthority,
  normalizeValueRef,
  buildPrivacyContext,
  redactKnownSecrets,
  normalizeObservedValue,
  normalizeAttributes,
  normalizeBounds,
  normalizePath,
  normalizeSemanticIdentity,
  normalizeState,
  normalizeLocator,
  normalizePlaywrightEvidence,
  normalizeHitTest,
  normalizeCdpEvidence,
  normalizeAxEvidence,
  normalizeDomEvidence,
  normalizeScreenshotEvidence,
  normalizeSourceFacts,
  observedIdentityFromSources,
  correlateSourceIdentity,
  captureRequestForProvider,
  createCaptureEnvelope,
  toSerializable,
};
