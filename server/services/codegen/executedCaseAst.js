'use strict';

const crypto = require('crypto');
const waitContractService = require('../waitContract');
const replayContract = require('./_replayContract');

const AST_SCHEMA = 'qaai-executed-case-ast/1';
const WAIT_SCHEMA = 'qaai-wait-contract/1';

const ACTION_NODE_TYPES = new Set([
  'Navigate',
  'NavigateBack',
  'NavigateForward',
  'Reload',
  'Fill',
  'Type',
  'Select',
  'Check',
  'Uncheck',
  'Click',
  'DoubleClick',
  'TripleClick',
  'Press',
  'Hover',
  'Drag',
  'Upload',
  'WaitForState',
  'Screenshot',
  'Popup',
  'Download',
  'HandleDialog',
  'Resize',
  'Close',
]);

const ASSERTION_NODE_TYPES = new Set([
  'AssertUrl',
  'AssertText',
  'AssertNumber',
  'AssertVisible',
  'AssertHidden',
]);

const LOCATOR_REQUIRED = new Set([
  'Fill',
  'Type',
  'Select',
  'Check',
  'Uncheck',
  'Click',
  'DoubleClick',
  'TripleClick',
  'Press',
  'Hover',
  'Drag',
  'Upload',
  'Popup',
  'Download',
  'AssertText',
  'AssertNumber',
  'AssertVisible',
  'AssertHidden',
]);

const WAIT_REQUIRED = new Set([
  'Navigate',
  'NavigateBack',
  'NavigateForward',
  'Reload',
  'Fill',
  'Type',
  'Select',
  'Check',
  'Uncheck',
  'Click',
  'DoubleClick',
  'TripleClick',
  'Popup',
  'Download',
  'WaitForState',
]);

// A failed, blocked, or needs-human website result can still have a faithfully
// executed prefix. Output compilation keeps that prefix enabled and records the
// website verdict separately. Only an intentionally skipped/non-executable case
// has no runnable execution lane.
const NON_EXECUTABLE_STATUSES = new Set(['skipped', 'not_executable']);
const SECRET_KEY_RE = /(?:^|[_\-.])(password|passwd|passcode|secret|token|api[_-]?key|authorization|credential|private[_-]?key)(?:$|[_\-.])/i;
const SECRET_TEXT_RES = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}\b/i,
  /\b(?:password|passwd|passcode|secret|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /(?:[?&](?:access_token|auth_token|api_key|password)=)[^&#\s]+/i,
];

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch (_) { return fallback; }
}

function clean(value, limit = 300) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return limit && text.length > limit ? text.slice(0, limit) : text;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

function shortHash(value, length = 12) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value), 'utf8').digest('hex').slice(0, length);
}

function words(value) {
  return clean(value, 180)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function camel(value, fallback = 'value') {
  const parts = words(value);
  if (!parts.length) return fallback;
  return parts.map((part, index) => {
    const lower = part.toLowerCase();
    return index === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join('');
}

function pascal(value, fallback = 'Value') {
  const out = camel(value, fallback.charAt(0).toLowerCase() + fallback.slice(1));
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function snakeUpper(value, fallback = 'VALUE') {
  const out = words(value).map((part) => part.toUpperCase()).join('_');
  return out || fallback;
}

function idPart(value, fallback = 'item') {
  const out = words(value).map((part) => part.toLowerCase()).join('-');
  return out || fallback;
}

function uniqueName(base, used) {
  const stem = base || 'symbol';
  let candidate = stem;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${stem}${suffix++}`;
  used.add(candidate);
  return candidate;
}

function isSensitiveKey(key) {
  const normalized = String(key || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return SECRET_KEY_RE.test(normalized);
}

function containsSecretText(value) {
  const text = String(value == null ? '' : value);
  return SECRET_TEXT_RES.some((pattern) => pattern.test(text));
}

function redactString(value, state) {
  let text = String(value == null ? '' : value);
  let changed = false;
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}\b/gi, () => {
    changed = true;
    return 'Bearer [REDACTED]';
  });
  text = text.replace(/([?&](?:access_token|auth_token|api_key|password)=)[^&#\s]+/gi, (_, prefix) => {
    changed = true;
    return `${prefix}[REDACTED]`;
  });
  text = text.replace(/\b((?:password|passwd|passcode|secret|token|api[_-]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi, (_, prefix) => {
    changed = true;
    return `${prefix}[REDACTED]`;
  });
  text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, () => {
    changed = true;
    return '[REDACTED_JWT]';
  });
  if (changed && state) state.redactedCount += 1;
  return text;
}

function redactDeep(value, state, key = '', depth = 0) {
  if (depth > 8) return '[TRUNCATED]';
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (isSensitiveKey(key)) {
      if (state) state.redactedCount += 1;
      return '[REDACTED]';
    }
    return redactString(clean(value, 2000), state);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactDeep(item, state, key, depth + 1));
  if (typeof value !== 'object') return clean(value, 300);
  const out = {};
  const contextLabel = [value.target, value.field, value.element, value.label, value.name, value.dataRef, value.binding]
    .filter((item) => typeof item === 'string')
    .join('_');
  const sensitiveContext = isSensitiveKey(key)
    || isSensitiveKey(contextLabel)
    || value.sensitive === true
    || /secret|sensitive|credential/i.test(String(value.classification || ''));
  for (const [childKey, childValue] of Object.entries(value).slice(0, 100)) {
    if (isSensitiveKey(childKey) || sensitiveContext && /^(?:value|text|input|expected|actual|readback|content|data)$/i.test(childKey)) {
      if (state) state.redactedCount += 1;
      out[childKey] = '[REDACTED]';
    } else {
      out[childKey] = redactDeep(childValue, state, childKey, depth + 1);
    }
  }
  return out;
}

function replaySteps(envelope) {
  const parsed = parseJson(envelope, {});
  const ir = parsed && parsed.ir ? parsed.ir : parsed;
  return Array.isArray(ir && ir.steps) ? ir.steps.filter((step) => step && typeof step === 'object') : [];
}

function journalRows(value) {
  const parsed = parseJson(value, []);
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  for (const key of ['steps', 'stepResults', 'results', 'events', 'journal']) {
    if (Array.isArray(parsed[key])) return parsed[key];
  }
  return [];
}

function locatorExpression(value) {
  if (!value || typeof value !== 'object') return null;
  return clean(
    value.primary
      || value.expression
      || value.expr
      || value.frameworkExpressions && value.frameworkExpressions.playwright
      || value.locatorExpression
      || value.chosenExpression,
    1000
  ) || null;
}

function guessedLocatorProvenance(replay, resolve) {
  const provenance = replay && replay.locatorProvenance && typeof replay.locatorProvenance === 'object'
    ? replay.locatorProvenance
    : resolve && resolve.locatorProvenance && typeof resolve.locatorProvenance === 'object'
      ? resolve.locatorProvenance
      : null;
  const guessed = replay && (replay.guessedLocator === true || replay.locatorConfidence === 'guessed')
    || resolve && (resolve.guessedLocator === true || resolve.locatorConfidence === 'guessed')
    || provenance && String(provenance.kind || provenance.source || '').toLowerCase().includes('guess');
  return guessed ? (provenance || { kind: 'qaai_guessed_locator', confidence: 'unverified' }) : null;
}

function playwrightExpressionFromCandidate(value) {
  if (!value || typeof value !== 'object') return null;
  const candidate = value.candidate && typeof value.candidate === 'object' ? value.candidate : value;
  const direct = locatorExpression(candidate);
  if (direct) return direct;
  const strategy = String(candidate.strategy || '').trim().toLowerCase();
  const quoted = (input) => JSON.stringify(String(input));
  if (strategy === 'role' && candidate.role && candidate.name) {
    return `getByRole(${quoted(candidate.role)}, { name: ${quoted(candidate.name)} })`;
  }
  if (strategy === 'label' && candidate.text) return `getByLabel(${quoted(candidate.text)})`;
  if (strategy === 'placeholder' && candidate.text) return `getByPlaceholder(${quoted(candidate.text)})`;
  if (strategy === 'text' && candidate.text) return `getByText(${quoted(candidate.text)})`;
  if ((strategy === 'testid' || strategy === 'test_id') && (candidate.testId || candidate.testid)) {
    return `getByTestId(${quoted(candidate.testId || candidate.testid)})`;
  }
  if (strategy === 'title' && (candidate.text || candidate.title)) {
    return `getByTitle(${quoted(candidate.text || candidate.title)})`;
  }
  if ((strategy === 'alt' || strategy === 'alttext') && (candidate.text || candidate.alt)) {
    return `getByAltText(${quoted(candidate.text || candidate.alt)})`;
  }
  if (strategy === 'css' && candidate.selector) {
    const selector = String(candidate.selector).trim();
    if (/^(?:page\.)?(?:locator|getByRole|getByLabel|getByPlaceholder|getByText|getByTestId|getByTitle|getByAltText|frameLocator)\s*\(/.test(selector)) {
      return selector.replace(/^page\./, '');
    }
    return `locator(${quoted(selector)})`;
  }
  return null;
}

function cloneExactEvidence(value) {
  if (value == null) return value;
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch (_) { /* fall through */ }
  }
  try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
}

function presentValue(...values) {
  return values.find((value) => value !== undefined && value !== null) ?? null;
}

function locatorContextProjection(locator) {
  const raw = locator && typeof locator === 'object' ? locator : {};
  const candidate = raw.candidate && typeof raw.candidate === 'object' ? raw.candidate : {};
  const context = raw.context && typeof raw.context === 'object'
    ? raw.context
    : candidate.context && typeof candidate.context === 'object'
      ? candidate.context
      : null;
  const proof = raw.proof && typeof raw.proof === 'object'
    ? raw.proof
    : candidate.proof && typeof candidate.proof === 'object'
      ? candidate.proof
      : null;
  const authoritativeCdp = presentValue(
    context && context.authoritativeCdp,
    raw.authoritativeCdp,
    candidate.authoritativeCdp
  );
  const pre = authoritativeCdp && authoritativeCdp.pre && typeof authoritativeCdp.pre === 'object'
    ? authoritativeCdp.pre
    : null;
  const cdpNodeIdentity = presentValue(
    raw.targetIdentity,
    candidate.targetIdentity,
    proof && proof.targetIdentity,
    pre && pre.identity
  );
  const targetFacts = raw.targetFacts && typeof raw.targetFacts === 'object'
    ? raw.targetFacts
    : candidate.targetFacts && typeof candidate.targetFacts === 'object'
      ? candidate.targetFacts
      : null;
  const pageIdentity = presentValue(
    context && context.pageIdentity,
    raw.pageIdentity,
    candidate.pageIdentity,
    pre && pre.pageIdentity
  );
  const popupIdentity = presentValue(
    context && context.popupIdentity,
    raw.popupIdentity,
    candidate.popupIdentity,
    pre && pre.popupIdentity
  );
  const frameIdentity = presentValue(
    context && context.frameIdentity,
    raw.frameIdentity,
    candidate.frameIdentity,
    pre && pre.frameIdentity
  );
  const frameChain = presentValue(
    context && context.framePath,
    context && context.frameChain,
    context && context.cdpFramePath,
    raw.frameChain,
    raw.framePath,
    candidate.frameChain,
    candidate.framePath,
    pre && pre.framePathSelectors,
    pre && pre.framePath
  );
  const shadowHostChain = presentValue(
    context && context.shadowHostChain,
    context && context.shadowHostPath,
    context && context.shadowPath,
    context && context.cdpShadowPath,
    raw.shadowHostChain,
    raw.shadowHostPath,
    raw.shadowPath,
    candidate.shadowHostChain,
    candidate.shadowHostPath,
    candidate.shadowPath,
    pre && pre.shadowPath
  );
  const shadowRootChain = presentValue(
    context && context.shadowRootChain,
    context && context.shadowRoots,
    raw.shadowRootChain,
    raw.shadowRoots,
    candidate.shadowRootChain,
    candidate.shadowRoots
  );
  const backendNodeId = presentValue(
    raw.backendNodeId,
    candidate.backendNodeId,
    targetFacts && targetFacts.cdpBackendNodeId,
    proof && proof.backendNodeId,
    proof && proof.targetIdentity && proof.targetIdentity.backendNodeId,
    cdpNodeIdentity && cdpNodeIdentity.backendNodeId,
    pre && pre.backendNodeId,
    pre && pre.identity && pre.identity.backendNodeId
  );
  const frameId = presentValue(
    raw.frameId,
    candidate.frameId,
    targetFacts && targetFacts.cdpFrameId,
    frameIdentity && frameIdentity.frameId,
    cdpNodeIdentity && cdpNodeIdentity.frameId,
    pre && pre.identity && pre.identity.frameId
  );
  return {
    browserContext: cloneExactEvidence(context),
    pageIdentity: cloneExactEvidence(pageIdentity),
    popupIdentity: cloneExactEvidence(popupIdentity),
    pageAlias: presentValue(context && context.pageAlias, raw.pageAlias, candidate.pageAlias),
    tabAlias: presentValue(context && context.tabAlias, raw.tabAlias, candidate.tabAlias),
    frameIdentity: cloneExactEvidence(frameIdentity),
    frameId: cloneExactEvidence(frameId),
    frameChain: cloneExactEvidence(frameChain),
    shadowHostChain: cloneExactEvidence(shadowHostChain),
    shadowRootChain: cloneExactEvidence(shadowRootChain),
    backendNodeId: cloneExactEvidence(backendNodeId),
    cdpNodeIdentity: cloneExactEvidence(cdpNodeIdentity),
    authoritativeCdp: cloneExactEvidence(authoritativeCdp),
  };
}

function locatorRecord(candidate, {
  guessed = false,
  provenance = null,
  source = null,
  evidenceKind = 'locatorEvidence',
} = {}) {
  if (guessed || !replayContract.isVerifiedActionLocator(candidate)) return null;
  const expression = locatorExpression(candidate) || playwrightExpressionFromCandidate(candidate);
  if (!expression) return null;
  const exactLocatorEvidence = cloneExactEvidence(candidate);
  const value = candidate && candidate.candidate && typeof candidate.candidate === 'object'
    ? candidate.candidate
    : candidate || {};
  const contextProjection = locatorContextProjection(candidate);
  const proof = candidate && candidate.proof && typeof candidate.proof === 'object'
    ? candidate.proof
    : value.proof && typeof value.proof === 'object'
      ? value.proof
      : null;
  const exactProvenance = provenance
    || candidate && candidate.locatorProvenance
    || value.locatorProvenance
    || null;
  return {
    expression,
    verified: true,
    source: guessed
      ? clean(provenance && (provenance.kind || provenance.source), 120) || 'qaai_guessed_locator'
      : clean(source || candidate && (candidate.source || candidate.verificationSource || candidate.evidenceSource)
        || value.source || value.verificationSource || value.evidenceSource || proof && proof.source, 120) || null,
    role: clean(value.role || value.targetFacts && value.targetFacts.role, 80) || null,
    accessibleName: clean(
      value.accessibleName
        || value.name
        || value.text
        || value.targetFacts && value.targetFacts.accessibleName
        || provenance && provenance.semanticLabel,
      180
    ) || null,
    scope: clean(value.scope || value.containerScope || value.context && (
      value.context.formSelector
      || value.context.dialogSelector
      || value.context.tableSelector
      || value.context.landmarkSelector
    ), 300) || null,
    guessed,
    locatorConfidence: guessed ? clean(provenance && provenance.confidence, 80) || 'unverified' : null,
    locatorProvenance: cloneExactEvidence(exactProvenance),
    locatorEvidenceKind: evidenceKind,
    locatorEvidence: exactLocatorEvidence,
    actionLocator: evidenceKind === 'actionLocator' ? exactLocatorEvidence : cloneExactEvidence(candidate && candidate.actionLocator),
    locatorRecipe: evidenceKind === 'locatorRecipe' ? exactLocatorEvidence : cloneExactEvidence(candidate && candidate.locatorRecipe),
    frameworkExpressions: cloneExactEvidence(candidate && candidate.frameworkExpressions || value.frameworkExpressions || null),
    verificationSource: presentValue(candidate && candidate.verificationSource, value.verificationSource),
    proof: cloneExactEvidence(proof),
    uniquenessProof: cloneExactEvidence(candidate && candidate.uniquenessProof || value.uniquenessProof || null),
    targetIdentity: cloneExactEvidence(candidate && candidate.targetIdentity || value.targetIdentity || null),
    targetFacts: cloneExactEvidence(candidate && candidate.targetFacts || value.targetFacts || null),
    contextEvidence: cloneExactEvidence(candidate && candidate.contextEvidence || value.contextEvidence || null),
    domAtlas: cloneExactEvidence(candidate && candidate.domAtlas || value.domAtlas || null),
    ...contextProjection,
  };
}

function locatorFrom(base, replay, resolve) {
  const candidates = [
    { value: replay && replay.actionLocator, evidenceKind: 'actionLocator' },
    { value: replay && replay.locatorRecipe, evidenceKind: 'locatorRecipe' },
    { value: base && base.locatorRecipe, evidenceKind: 'locatorRecipe' },
    { value: base && base.actionLocator, evidenceKind: 'actionLocator' },
    { value: resolve && resolve.actionLocator, evidenceKind: 'actionLocator' },
    { value: resolve && resolve.locatorRecipe, evidenceKind: 'locatorRecipe' },
  ];
  for (const entry of candidates) {
    const record = locatorRecord(entry.value, { evidenceKind: entry.evidenceKind });
    if (record) return record;
  }
  return null;
}

function locatorAstProjection(locator) {
  if (!locator || typeof locator !== 'object') return {};
  return {
    locatorExpression: locator.expression || null,
    locatorEvidenceKind: locator.locatorEvidenceKind || null,
    locatorEvidence: locator.locatorEvidence || null,
    actionLocator: locator.actionLocator || null,
    locatorRecipe: locator.locatorRecipe || null,
    frameworkExpressions: locator.frameworkExpressions || null,
    verificationSource: locator.verificationSource || null,
    proof: locator.proof || null,
    locatorProof: locator.proof || null,
    uniquenessProof: locator.uniquenessProof || null,
    targetIdentity: locator.targetIdentity || null,
    targetFacts: locator.targetFacts || null,
    browserContext: locator.browserContext || null,
    pageIdentity: locator.pageIdentity || null,
    popupIdentity: locator.popupIdentity || null,
    pageAlias: locator.pageAlias || null,
    tabAlias: locator.tabAlias || null,
    frameIdentity: locator.frameIdentity || null,
    frameId: locator.frameId || null,
    frameChain: locator.frameChain || null,
    shadowHostChain: locator.shadowHostChain || null,
    shadowRootChain: locator.shadowRootChain || null,
    backendNodeId: locator.backendNodeId || null,
    cdpNodeIdentity: locator.cdpNodeIdentity || null,
    authoritativeCdp: locator.authoritativeCdp || null,
    contextEvidence: locator.contextEvidence || null,
    domAtlas: locator.domAtlas || null,
    locatorProvenance: locator.locatorProvenance || null,
  };
}

function locatorContextKey(locator) {
  if (!locator || typeof locator !== 'object') return '';
  return stableStringify({
    pageIdentity: locator.pageIdentity || null,
    popupIdentity: locator.popupIdentity || null,
    pageAlias: locator.pageAlias || null,
    tabAlias: locator.tabAlias || null,
    frameIdentity: locator.frameIdentity || null,
    frameId: locator.frameId || null,
    frameChain: locator.frameChain || null,
    shadowHostChain: locator.shadowHostChain || null,
    shadowRootChain: locator.shadowRootChain || null,
    backendNodeId: locator.backendNodeId || null,
    cdpNodeIdentity: locator.cdpNodeIdentity || null,
  });
}

function normalizeActionType(value) {
  const action = String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
  if (/^(navigate|goto|go_to|open|visit|load)$/.test(action)) return 'Navigate';
  if (/^(navigate_back|go_back|back)$/.test(action)) return 'NavigateBack';
  if (/^(navigate_forward|go_forward|forward)$/.test(action)) return 'NavigateForward';
  if (/^(reload|refresh|reload_page|refresh_page)$/.test(action)) return 'Reload';
  if (/^(fill|set_value|input)$/.test(action)) return 'Fill';
  if (/^(type|press_sequentially)$/.test(action)) return 'Type';
  if (/^(select|select_option|selectoption|choose)$/.test(action)) return 'Select';
  if (/^(check|set_checked|checkbox|radio)$/.test(action)) return 'Check';
  if (/^(uncheck|set_unchecked)$/.test(action)) return 'Uncheck';
  if (/^(double_click|doubleclick|dblclick)$/.test(action)) return 'DoubleClick';
  if (/^(triple_click|tripleclick)$/.test(action)) return 'TripleClick';
  if (/^(press|press_key|keyboard_press)$/.test(action)) return 'Press';
  if (/^(drag|drag_to|draganddrop|drag_and_drop)$/.test(action)) return 'Drag';
  if (/^(upload|file_upload|set_input_files|setinputfiles)$/.test(action)) return 'Upload';
  if (/^(click|tap)$/.test(action)
    || /^(?:click|press|tap|dismiss|close|accept|confirm)_if_(?:visible|present|available)$/.test(action)
    || /^(?:optional_)?(?:click|press|tap|dismiss|close|accept|confirm)_optional$/.test(action)) return 'Click';
  if (/^hover$/.test(action)) return 'Hover';
  if (/^(wait|wait_for|wait_for_state|waitforstate|browser_wait_for_selector|browser_wait_for_state|browser_wait_for_text|browser_wait_for_url)$/.test(action)) return 'WaitForState';
  if (/^(screenshot|capture_screenshot)$/.test(action)) return 'Screenshot';
  if (/^(popup|expect_popup|open_popup)$/.test(action)) return 'Popup';
  if (/^(download|expect_download)$/.test(action)) return 'Download';
  if (/^(handle_dialog|accept_dialog|dismiss_dialog|dialog|alert|confirm|prompt)$/.test(action)) return 'HandleDialog';
  if (/^(resize|set_viewport_size|set_viewport)$/.test(action)) return 'Resize';
  if (/^(close|close_page|close_tab|close_context)$/.test(action)) return 'Close';
  return null;
}

function authoredActionOperation(base, replay) {
  const raw = base && base.raw && typeof base.raw === 'object' ? base.raw : {};
  const authoredContract = replay && replay.authoredContract && typeof replay.authoredContract === 'object'
    ? replay.authoredContract
    : {};
  return clean(
    base && base.actionIdentity && base.actionIdentity.operation
      || base && base.operation
      || base && base.authoredOperation
      || base && base.actionType
      || raw.authoredOperation
      || raw.operation
      || raw.action
      || raw.type
      || replay && replay.authoredOperation
      || replay && replay.actionIdentity && replay.actionIdentity.operation
      || replay && replay.operation
      || authoredContract.action
      || authoredContract.type
      || replay && replay.op === 'waitFor' && 'waitFor'
      || replay && replay.action,
    120
  ) || null;
}

function optionalActionMetadata(base, replay) {
  const raw = base && base.raw && typeof base.raw === 'object' ? base.raw : {};
  const authoredContract = replay && replay.authoredContract && typeof replay.authoredContract === 'object'
    ? replay.authoredContract
    : {};
  const operation = authoredActionOperation(base, replay);
  const optional = [base, raw, replay, authoredContract].filter(Boolean).some((value) => (
    value.optional === true
    || value.ifPresent === true
    || value.ifVisible === true
    || value.required === false
  )) || /(?:^|_)(?:if_(?:visible|present|available)|optional)(?:_|$)/i.test(String(operation || ''));
  if (!optional) return null;
  return {
    optional: true,
    kind: /if_visible/i.test(String(operation || '')) ? 'if_visible' : 'if_present',
    authoredOperation: operation,
  };
}

function structuredAssertionSignals(base, replay) {
  const raw = base && base.raw && typeof base.raw === 'object' ? base.raw : {};
  const payload = raw.payload && typeof raw.payload === 'object' ? raw.payload : {};
  const outcome = base && base.expectedOutcome && typeof base.expectedOutcome === 'object'
    ? base.expectedOutcome
    : {};
  const contract = base && base.assertionContract && typeof base.assertionContract === 'object'
    ? base.assertionContract
    : {};
  const normalize = (value) => {
    if (value == null) return {};
    if (Array.isArray(value)) return { text: cloneExactEvidence(value) };
    if (typeof value === 'object') return cloneExactEvidence(value);
    return { text: [value] };
  };
  const sources = [
    normalize(outcome.expectedSignals),
    normalize(contract.expectedSignals),
    normalize(raw.expectedSignals),
    normalize(payload.expectedSignals),
    normalize(replay && replay.expectedSignals),
  ];
  const merged = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value == null) continue;
      merged[key] = cloneExactEvidence(value);
    }
  }
  const authoredText = [
    replay && replay.expectedText,
    raw.expectedText,
    payload.expectedText,
    payload.expected,
    payload.value,
    payload.text,
  ]
    .map((value) => clean(value, 400))
    .filter(Boolean);
  if (authoredText.length && !Array.isArray(merged.text)) merged.text = authoredText;
  return merged;
}

function assertionSignalTexts(base, replay) {
  const signals = structuredAssertionSignals(base, replay);
  const values = Array.isArray(signals.text) ? signals.text : signals.text == null ? [] : [signals.text];
  return values.map((value) => clean(value, 400)).filter(Boolean);
}

function assertionProjectionIsNonApplicable(base, replay) {
  const raw = base && base.raw && typeof base.raw === 'object' ? base.raw : {};
  const values = [base, raw, replay].filter((value) => value && typeof value === 'object');
  const outcome = values.map((value) => clean(
    value.outcome || value.assertionOutcome || value.status || value.disposition,
    80
  ).toLowerCase()).find(Boolean);
  return values.some((value) => value.synthetic === true
      || value.synthesized === true
      || value.synthesizedFromContract === true
      || value.notApplicable === true
      || value.applicable === false)
    || outcome === 'not_applicable';
}

function authoredAssertionLocator(base, replay, assertionType) {
  if (!['AssertText', 'AssertNumber', 'AssertVisible', 'AssertHidden'].includes(assertionType)) return null;
  const signal = assertionSignalTexts(base, replay)[0];
  if (!signal) return null;
  const expression = `getByText(${JSON.stringify(signal)}, { exact: false })`;
  return {
    expression,
    verified: false,
    guessed: false,
    source: 'authored_assertion_contract',
    locatorConfidence: 'authored',
    accessibleName: signal,
    locatorEvidenceKind: 'authoredAssertionContract',
    locatorEvidence: {
      schemaVersion: 'qaai-authored-assertion-target-v1',
      source: 'authored_assertion_contract',
      expectedText: signal,
    },
  };
}

function normalizeAssertionType(channel) {
  const value = String(channel || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  if (/URL|ROUTE|LOCATION/.test(value)) return 'AssertUrl';
  if (/NUMBER|COUNT|NUMERIC|AMOUNT/.test(value)) return 'AssertNumber';
  if (/HIDDEN|NOT_VISIBLE|ABSENT/.test(value)) return 'AssertHidden';
  if (/VISIBLE|PRESENT|DISPLAYED/.test(value)) return 'AssertVisible';
  if (/ENABLED|DISABLED|EDITABLE|READ_?ONLY|CHECKED|UNCHECKED/.test(value)) return 'AssertVisible';
  if (/^(PAGE|PAGE_STATE|STATE)$/.test(value)) return 'AssertVisible';
  if (/TEXT|CONTENT|MESSAGE|LABEL|TITLE|VALUE|SELECTED|ATTRIBUTE/.test(value)) return 'AssertText';
  return null;
}

function isAssertionBase(base, replay) {
  return replay && replay.op === 'assert'
    || base && base.kind === 'assertion'
    || /assert|verify|expect|validate/.test(String(base && (base.actionType || base.type || base.kind) || '').toLowerCase());
}

function expectedValueResolution(base, replay, sourceDataByKey, assertionType) {
  const raw = base && base.raw && typeof base.raw === 'object' ? base.raw : {};
  const payload = raw.payload && typeof raw.payload === 'object' ? raw.payload : {};
  const contract = base && base.assertionContract && typeof base.assertionContract === 'object'
    ? base.assertionContract
    : {};
  const outcome = base && base.expectedOutcome && typeof base.expectedOutcome === 'object'
    ? base.expectedOutcome
    : {};
  const structuredSignals = structuredAssertionSignals(base, replay);
  const replaySignalText = Array.isArray(structuredSignals.text)
    ? structuredSignals.text.find((value) => value != null && String(value).trim())
    : null;
  const candidates = [
    ['replay.expectedSignals.text', replaySignalText],
    ['replay.expected', replay && replay.expected],
    ['replay.expectedText', replay && replay.expectedText],
    ['replay.expectedValue', replay && replay.expectedValue],
    ['replay.expectedCount', replay && replay.expectedCount],
    ['replay.expectedChecked', replay && replay.expectedChecked],
    ['assertionContract.expected', contract.expected],
    ['assertionContract.value', contract.value],
    ['expectedOutcome.expected', outcome.expected],
    ['expectedOutcome.expectedText', outcome.expectedText],
    ['expectedOutcome.expectedUrl', outcome.expectedUrl],
    ['expectedOutcome.expectedPage', outcome.expectedPage],
    ['base.expected', base && base.expected],
    ['raw.expected', raw.expected],
    ['raw.expectedResult', raw.expectedResult],
    ['raw.expectedValue', raw.expectedValue],
    ['raw.expectedText', raw.expectedText],
    ['raw.expectedUrl', raw.expectedUrl],
    ['raw.value', raw.value],
    ['payload.expected', payload.expected],
    ['payload.expectedText', payload.expectedText],
    ['payload.expectedUrl', payload.expectedUrl],
    ['payload.value', payload.value],
    ['payload.expectedValue', payload.expectedValue],
    ['payload.expectedCount', payload.expectedCount],
    ['payload.expectedChecked', payload.expectedChecked],
  ];
  const literal = candidates.find(([, value]) => value != null && (typeof value !== 'string' || value.trim() !== ''));
  if (literal) return { resolved: true, value: literal[1], source: literal[0], bindingKey: null };

  const bindingRaw = replay && (replay.dataExpected || replay.expectedRef)
    || contract.dataExpected
    || contract.expectedRef
    || outcome.dataExpected
    || raw.dataExpected
    || raw.expectedRef
    || base && base.dataBinding && (
      base.dataBinding.expectedColumn || base.dataBinding.sourceColumn || base.dataBinding.column || base.dataBinding.key
    )
    || null;
  const binding = valueRefParts(bindingRaw);
  if (binding) {
    const sourceEntry = sourceDataByKey && sourceDataByKey.get(String(binding.key).toLowerCase());
    const descriptor = sourceEntry ? descriptorParts(sourceEntry) : null;
    if (descriptor && descriptor.value != null && descriptor.sensitive !== true && binding.kind !== 'env') {
      return {
        resolved: true,
        value: descriptor.value,
        source: `${sourceEntry.source}:${sourceEntry.key}`,
        bindingKey: binding.key,
      };
    }
    return {
      resolved: true,
      value: null,
      source: binding.kind === 'env' ? 'environment_binding' : 'data_binding',
      bindingKey: binding.key,
      binding,
    };
  }

  if (assertionType === 'AssertVisible' || assertionType === 'AssertHidden') {
    return { resolved: true, value: true, source: 'assertion_channel_semantics', bindingKey: null };
  }

  const contractText = clean(
    replay && replay.authoredContractText
      || contract.description || contract.instruction || contract.assertion || contract.check
      || raw.description || raw.instruction || raw.assertion || raw.check
      || base && (base.plannedText || base.text),
    600
  ) || null;
  return {
    resolved: false,
    value: null,
    source: null,
    bindingKey: null,
    contractText,
    reason: 'No concrete expected value or authored data binding was present in the assertion contract.',
  };
}

function normalizedPolicy(value) {
  return clean(value, 120).toLowerCase().replace(/[\s-]+/g, '_');
}

function assertionContinuationPolicy(base, replay, executionContract, caseInstance) {
  const raw = base && base.raw && typeof base.raw === 'object' ? base.raw : {};
  const contract = base && base.assertionContract && typeof base.assertionContract === 'object'
    ? base.assertionContract
    : {};
  const containers = [base, raw, contract, base && base.expectedOutcome, replay].filter((value) => value && typeof value === 'object');
  const hardFlags = [
    'flowCritical', 'isFlowCritical', 'flowCriticalAssertion', 'hardAssertion',
    'blocksFlow', 'blocksDependentFlow', 'dependencyPrerequisite',
    'isDependencyPrerequisite', 'requiredForNextStep', 'stopOnFailure',
  ];
  if (containers.some((container) => hardFlags.some((flag) => container[flag] === true))) {
    return { hard: true, policy: 'stop_descendants', source: 'authored_flow_critical_flag' };
  }
  const softFlags = ['softAssertion', 'continueOnFailure', 'continueIndependent', 'nonBlocking'];
  if (containers.some((container) => softFlags.some((flag) => container[flag] === true))) {
    return { hard: false, policy: 'continue_independent', source: 'authored_continue_flag' };
  }
  const policies = containers.flatMap((container) => [
    container.failurePolicy,
    container.onFailure,
    container.assertionMode,
    container.continuationPolicy,
  ]).concat([
    executionContract && executionContract.failurePolicy,
    executionContract && executionContract.caseContract && executionContract.caseContract.failurePolicy,
    caseInstance && caseInstance.failurePolicy,
  ]).map((value) => {
    if (value && typeof value === 'object') {
      return normalizedPolicy(value.onAssertionFailure || value.default || value.policy || '');
    }
    return normalizedPolicy(value);
  }).filter(Boolean);
  const hard = policies.find((policy) => [
    'block_dependents', 'stop_descendants', 'stop_dependent_flow', 'stop_case',
    'fail_fast', 'abort', 'hard',
  ].includes(policy));
  if (hard) return { hard: true, policy: hard, source: 'authored_failure_policy' };
  const soft = policies.find((policy) => [
    'continue', 'continue_independent', 'continue_on_failure', 'record_and_continue', 'soft',
  ].includes(policy));
  if (soft) return { hard: false, policy: soft, source: 'authored_failure_policy' };
  return { hard: true, policy: 'hard', source: 'legacy_default' };
}

const ACTION_IDENTITY_NESTED_KEYS = Object.freeze([
  'actionIdentity',
  'actionDispatchIdentity',
  'stepAuthoring',
]);

function actionIdentitySources(value) {
  if (!value || typeof value !== 'object') return [];
  const nested = ACTION_IDENTITY_NESTED_KEYS
    .map((key) => value[key])
    .filter((entry) => entry && typeof entry === 'object');
  return [...nested, value];
}

function firstIdentityValue(values, keys) {
  for (const value of values) {
    for (const key of keys) {
      if (value && value[key] != null && value[key] !== '') return value[key];
    }
  }
  return null;
}

function identityInteger(values, keys) {
  const raw = firstIdentityValue(values, keys);
  if (raw == null || raw === '') return null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? Math.floor(numeric) : null;
}

function optionalIdentityNumber(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : null;
}

function capturedActionIdentity(value, { assertion = false } = {}) {
  const sources = actionIdentitySources(value);
  const contractKeys = assertion
    ? ['contractStepId', 'contractRef', 'assertionId', 'stepId', 'id']
    : ['contractStepId', 'contractRef', 'stepId', 'id'];
  return {
    caseId: clean(firstIdentityValue(sources, ['caseId', 'testCaseId']), 180) || null,
    contractStepId: clean(firstIdentityValue(sources, contractKeys), 180) || null,
    sourceContractStepId: clean(firstIdentityValue(sources, ['sourceContractStepId']), 180) || null,
    authoredActionId: clean(firstIdentityValue(sources, ['authoredActionId', 'actionId']), 180) || null,
    actionOccurrenceId: clean(firstIdentityValue(sources, ['actionOccurrenceId']), 240) || null,
    sourceActionOccurrenceId: clean(firstIdentityValue(sources, ['sourceActionOccurrenceId']), 240) || null,
    sequenceIndex: identityInteger(sources, ['sequenceIndex', 'actionSequenceIndex', 'stepOrdinal', 'ordinal']),
    authoredSequenceIndex: identityInteger(sources, ['authoredSequenceIndex']),
    occurrenceOrdinal: identityInteger(sources, ['occurrenceOrdinal']),
    occurrenceKey: clean(firstIdentityValue(sources, ['occurrenceKey']), 400) || null,
    toolUseId: clean(firstIdentityValue(sources, ['toolUseId']), 180) || null,
    toolName: clean(firstIdentityValue(sources, ['toolName']), 120) || null,
    operation: clean(firstIdentityValue(sources, ['operation', 'action', 'actionType']), 80) || null,
  };
}

function occurrenceIdAliases(identity) {
  return new Set([
    identity && identity.actionOccurrenceId,
    identity && identity.sourceActionOccurrenceId,
  ].filter(Boolean).map(String));
}

function hasStableOccurrenceIdentity(identity) {
  return occurrenceIdAliases(identity).size > 0 || Boolean(identity && identity.occurrenceKey);
}

function sameStableOccurrence(left, right) {
  const leftIds = occurrenceIdAliases(left);
  const rightIds = occurrenceIdAliases(right);
  for (const id of leftIds) if (rightIds.has(id)) return true;
  return Boolean(
    left && right
      && left.occurrenceKey
      && right.occurrenceKey
      && left.occurrenceKey === right.occurrenceKey
  );
}

function occurrenceIdentityIsForeign(authored, replay) {
  if (!authored || !replay) return false;
  if (authored.caseId && replay.caseId && authored.caseId !== replay.caseId) return true;
  const authoredIds = occurrenceIdAliases(authored);
  const replayIds = occurrenceIdAliases(replay);
  if (authoredIds.size && replayIds.size && !sameStableOccurrence(authored, replay)) return true;
  if (authored.occurrenceKey && replay.occurrenceKey && authored.occurrenceKey !== replay.occurrenceKey) return true;
  return false;
}

function actionIdentityFor(base, replay, { caseId = null, ordinal = null, operation = null } = {}) {
  const baseIdentity = capturedActionIdentity(base);
  const replayIdentity = capturedActionIdentity(replay);
  const contractStepId = baseIdentity.contractStepId || replayIdentity.contractStepId || null;
  const sourceContractStepId = baseIdentity.sourceContractStepId || replayIdentity.sourceContractStepId || null;
  const sequenceIndex = baseIdentity.sequenceIndex ?? replayIdentity.sequenceIndex ?? ordinal;
  const sequence = Number.isFinite(Number(sequenceIndex)) ? Math.floor(Number(sequenceIndex)) : null;
  const authoredSequenceIndex = baseIdentity.authoredSequenceIndex
    ?? replayIdentity.authoredSequenceIndex
    ?? sequence;
  const occurrenceOrdinal = baseIdentity.occurrenceOrdinal
    ?? replayIdentity.occurrenceOrdinal
    ?? authoredSequenceIndex
    ?? sequence
    ?? ordinal;
  const toolName = baseIdentity.toolName || replayIdentity.toolName || null;
  const op = clean(baseIdentity.operation || operation || replayIdentity.operation, 80) || 'action';
  const effectiveCaseId = clean(baseIdentity.caseId || replayIdentity.caseId || caseId, 180) || null;
  const occurrenceIdentitySource = hasStableOccurrenceIdentity(baseIdentity)
    || hasStableOccurrenceIdentity(replayIdentity)
    || Boolean(baseIdentity.authoredActionId || replayIdentity.authoredActionId)
    ? 'captured'
    : 'allocator_fallback';
  const authoredActionId = baseIdentity.authoredActionId
    || replayIdentity.authoredActionId
    || `action_${shortHash(stableStringify({
      caseId: effectiveCaseId,
      contractStepId,
      sourceContractStepId,
      sequenceIndex: sequence,
      authoredSequenceIndex,
      occurrenceOrdinal,
      toolName,
      operation: op,
    }), 16)}`;
  const occurrenceKey = baseIdentity.occurrenceKey
    || replayIdentity.occurrenceKey
    || `${effectiveCaseId || 'case'}:${contractStepId || 'step'}:${authoredSequenceIndex == null ? 'sequence-unknown' : authoredSequenceIndex}:${op}`;
  const actionOccurrenceId = baseIdentity.actionOccurrenceId
    || replayIdentity.actionOccurrenceId
    || `occurrence_${shortHash(stableStringify({
      caseId: effectiveCaseId,
      contractStepId,
      sourceContractStepId,
      authoredActionId,
      authoredSequenceIndex,
      occurrenceOrdinal,
      occurrenceKey,
      operation: op,
    }), 20)}`;
  return {
    schemaVersion: 'qaai-action-identity-v1',
    occurrenceIdentitySource,
    caseId: effectiveCaseId,
    contractStepId,
    sourceContractStepId,
    authoredActionId,
    actionOccurrenceId,
    sourceActionOccurrenceId: baseIdentity.sourceActionOccurrenceId || replayIdentity.sourceActionOccurrenceId || null,
    sequenceIndex: sequence,
    authoredSequenceIndex: Number.isFinite(Number(authoredSequenceIndex)) ? Math.floor(Number(authoredSequenceIndex)) : null,
    occurrenceOrdinal,
    toolUseId: baseIdentity.toolUseId || replayIdentity.toolUseId || null,
    toolName,
    operation: op,
    occurrenceKey,
  };
}

function dataSources(executionContract, caseInstance) {
  const sources = [];
  const addObject = (value, source) => {
    const parsed = parseJson(value, null);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    for (const [key, descriptor] of Object.entries(parsed)) sources.push({ key, descriptor, source });
  };
  addObject(executionContract && executionContract.dataRow && executionContract.dataRow.fields, 'execution_contract_row');
  addObject(caseInstance && caseInstance.inlineData, 'case_instance_inline_data');
  addObject(caseInstance && caseInstance.dataDictionary, 'case_instance_data_dictionary');
  addObject(caseInstance && caseInstance.data, 'case_instance_data');
  addObject(caseInstance && caseInstance.fields, 'case_instance_fields');
  return sources;
}

function descriptorParts(entry) {
  const descriptor = entry && entry.descriptor;
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    return { value: descriptor, sensitive: isSensitiveKey(entry && entry.key), envRef: null };
  }
  const classification = String(descriptor.classification || descriptor.kind || '').toLowerCase();
  return {
    value: Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : descriptor.defaultValue,
    sensitive: descriptor.sensitive === true || /secret|sensitive|credential/.test(classification) || isSensitiveKey(entry && entry.key),
    envRef: descriptor.envRef || descriptor.environmentRef || descriptor.credentialRef || null,
  };
}

function valueRefParts(valueRef) {
  const raw = clean(valueRef, 240);
  if (!raw) return null;
  const env = raw.match(/^env:([A-Za-z_][A-Za-z0-9_]*)$/i);
  if (env) return { key: env[1], kind: 'env', envName: env[1].toUpperCase() };
  const fixture = raw.match(/^(?:fixture|data):(.+)$/i);
  if (fixture) return { key: fixture[1], kind: 'fixture' };
  const moustache = raw.match(/^\{\{\s*([^}]+)\s*\}\}$/);
  return { key: moustache ? moustache[1] : raw, kind: isSensitiveKey(raw) ? 'env' : 'fixture' };
}

function explicitBinding(base, replay) {
  const binding = base && base.dataBinding && typeof base.dataBinding === 'object' ? base.dataBinding : null;
  const raw = replay && (replay.valueRef || replay.dataRef)
    || binding && (binding.ref || binding.dataRef || binding.sourceColumn || binding.column || binding.key)
    || base && base.raw && (base.raw.valueRef || base.raw.dataRef || base.raw.sourceColumn)
    || null;
  return valueRefParts(raw);
}

function literalActionValue(base, replay) {
  if (replay && Object.prototype.hasOwnProperty.call(replay, 'value') && replay.value != null) return replay.value;
  const raw = base && base.raw && typeof base.raw === 'object' ? base.raw : {};
  if (Object.prototype.hasOwnProperty.call(raw, 'value') && raw.value != null) return raw.value;
  return null;
}

function normalizeOutcome(value, allowed, fallback) {
  const normalized = String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, '_');
  return allowed.has(normalized) ? normalized : fallback;
}

function journalFor(base, replay, journal, ordinal, used) {
  const ids = new Set([
    base && base.contractStepId,
    base && base.stepId,
    base && base.id,
    base && base.assertionId,
    replay && replay.contractRef,
    replay && replay.stepId,
    replay && replay.id,
  ].filter(Boolean).map(String));
  let index = journal.findIndex((row, rowIndex) => {
    if (used.has(rowIndex) || !row || typeof row !== 'object') return false;
    const rowId = row.contractStepId || row.stepId || row.plannedStepId || row.assertionId || row.id;
    return rowId != null && ids.has(String(rowId));
  });
  if (index < 0) {
    const assertion = isAssertionBase(base, replay);
    const expectedType = assertion
      ? normalizeAssertionType(replay && replay.channel
        || base && base.expectedKind
        || base && base.expectedOutcome && base.expectedOutcome.kind
        || base && base.raw && (base.raw.channel || base.raw.kind || base.raw.type))
      : normalizeActionType(base && base.actionType
        || base && base.raw && (base.raw.action || base.raw.type)
        || replay && replay.action);
    index = journal.findIndex((row, rowIndex) => {
      if (used.has(rowIndex) || !row || typeof row !== 'object') return false;
      if (Number(row.stepOrdinal || row.ordinal || row.sequence || row.index + 1) !== ordinal) return false;
      const rowTool = String(row.actionType || row.action || row.toolName || row.tool || row.kind || '')
        .replace(/^(?:browser_|deterministic_dom_)/i, '');
      if (assertion) return /assert|verify|expect|validation/i.test(rowTool) || row.assertionOutcome != null;
      const rowType = normalizeActionType(rowTool);
      return !expectedType || !rowType || rowType === expectedType;
    });
  }
  if (index < 0) return null;
  used.add(index);
  return journal[index];
}

function waitRecord(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return value ? { kind: clean(value, 120) } : null;
}

function explicitWait(base, replay, row) {
  const rawBase = base && base.raw && typeof base.raw === 'object' ? base.raw : null;
  const sources = [
    row && row.expectedState,
    row && row.postcondition,
    row && row.waitContract,
    rawBase && (rawBase.syncState || rawBase.sync_state),
    rawBase && rawBase.operationCheck,
    rawBase && rawBase.postcondition,
    rawBase && rawBase.waitContract,
    base && (base.syncState || base.sync_state),
    base && base.operationCheck,
    base && base.postcondition,
    base && base.waitContract,
    replay && replay.expectedEffect,
    replay && replay.postcondition,
    replay && replay.condition,
    replay && replay.waitContract,
  ];
  let merged = null;
  for (const source of sources) {
    const record = waitRecord(source);
    if (record) merged = { ...(merged || {}), ...record };
  }
  return merged;
}

function contractNumber(value, fallback, { minimum = 0 } = {}) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? Math.floor(number) : fallback;
}

function normalizedRecovery(value) {
  if (typeof value === 'string') {
    const action = clean(value, 80).toLowerCase();
    return action ? { action, maxAttempts: 1 } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const action = clean(value.action || value.type || value.kind, 80).toLowerCase();
  if (!action) return null;
  return {
    ...value,
    action,
    maxAttempts: contractNumber(value.maxAttempts, 1, { minimum: 0 }),
  };
}

function explicitBrowserEventEvidence(base, replay, row) {
  const raw = base && base.raw && typeof base.raw === 'object' ? base.raw : {};
  return [
    row && row.browserEventEvidence,
    replay && replay.browserEventEvidence,
    raw.browserEventEvidence,
    base && base.browserEventEvidence,
  ].find((value) => value && typeof value === 'object' && !Array.isArray(value)) || null;
}

function navigationProjection(type, base, replay, row, waitContract, redactionState) {
  if (!['Navigate', 'NavigateBack', 'NavigateForward', 'Reload'].includes(type)) return null;
  const raw = base && base.raw && typeof base.raw === 'object' ? base.raw : {};
  const supplied = replay && replay.navigation && typeof replay.navigation === 'object'
    ? replay.navigation
    : raw.navigation && typeof raw.navigation === 'object'
      ? raw.navigation
      : {};
  const kind = supplied.kind || ({
    Navigate: 'direct',
    NavigateBack: 'back',
    NavigateForward: 'forward',
    Reload: 'reload',
  })[type];
  const url = supplied.url ?? replay?.url ?? raw.url ?? base?.url ?? null;
  const observedConsequenceUrl = supplied.observedConsequenceUrl
    ?? replay?.observedConsequenceUrl
    ?? row?.observedConsequenceUrl
    ?? null;
  return redactDeep({
    ...supplied,
    kind,
    url,
    observedConsequenceUrl,
    timeoutMs: supplied.timeoutMs ?? waitContract?.timeoutMs ?? null,
    waitUntil: supplied.waitUntil ?? waitContract?.waitUntil ?? waitContract?.expected?.readiness ?? null,
    sameSession: supplied.sameSession !== false,
  }, redactionState);
}

function normalizeWaitContract(type, base, replay, row, dataRef, redactionState) {
  const provided = explicitWait(base, replay, row);
  let contract = provided ? redactDeep(provided, redactionState) : null;
  if (contract) {
    const normalized = waitContractService.normalizeTypedWaitContract(contract);
    const pollMs = contractNumber(normalized.pollIntervalMs, 250, { minimum: 1 });
    const recovery = normalizedRecovery(normalized.recovery);
    contract = {
      ...normalized,
      schema: WAIT_SCHEMA,
      pollMs,
      ...(recovery ? { recovery } : {}),
    };
    return contract;
  }
  if (type === 'Navigate') {
    const url = replay && (replay.url || replay.target) || base && base.raw && (base.raw.url || base.raw.target) || null;
    return {
      schema: WAIT_SCHEMA,
      kind: 'url_or_page_fingerprint',
      expected: url == null ? null : redactString(clean(url, 1000), redactionState),
      timeoutMs: 20_000,
      pollMs: 250,
      stableObservations: 2,
      armBeforeAction: true,
    };
  }
  if (type === 'Fill' || type === 'Type') {
    return { schema: WAIT_SCHEMA, kind: 'value', expectedDataRef: dataRef || null, timeoutMs: 10_000, pollMs: 250, stableObservations: 2, armBeforeAction: false };
  }
  if (type === 'Select') {
    return { schema: WAIT_SCHEMA, kind: 'selected', expectedDataRef: dataRef || null, timeoutMs: 10_000, pollMs: 250, stableObservations: 2, armBeforeAction: false };
  }
  if (type === 'Check') {
    return { schema: WAIT_SCHEMA, kind: 'checked', expected: true, timeoutMs: 10_000, pollMs: 250, stableObservations: 2, armBeforeAction: false };
  }
  if (type === 'Uncheck') {
    return { schema: WAIT_SCHEMA, kind: 'checked', expected: false, timeoutMs: 10_000, pollMs: 250, stableObservations: 2, armBeforeAction: false };
  }
  if (type === 'Popup') {
    return { schema: WAIT_SCHEMA, kind: 'popup', expected: 'popup', timeoutMs: 10_000, pollMs: 250, stableObservations: 2, armBeforeAction: true };
  }
  if (type === 'Download') {
    return { schema: WAIT_SCHEMA, kind: 'download', expected: 'download', timeoutMs: 10_000, pollMs: 250, stableObservations: 2, armBeforeAction: true };
  }
  if (type === 'WaitForState') {
    return { schema: WAIT_SCHEMA, kind: 'dom_state', expected: null, timeoutMs: 10_000, pollMs: 250, stableObservations: 2, armBeforeAction: false };
  }
  return null;
}

function journalProjection(row, replay, redactionState) {
  const actionAllowed = new Set(['succeeded', 'failed', 'not_executed']);
  const assertionAllowed = new Set(['matched', 'not_matched', 'uncheckable', 'not_applicable']);
  const continuationAllowed = new Set(['continue', 'retry', 'stop_descendants', 'stop_case']);
  const inferredAction = replay && replay.op === 'assert' ? 'not_executed' : replay ? 'succeeded' : 'not_executed';
  const inferredAssertion = replay && replay.op === 'assert'
    ? normalizeOutcome(replay.liveOutcome, assertionAllowed, 'uncheckable')
    : 'not_applicable';
  if (!row) {
    return {
      actionOutcome: inferredAction,
      assertionOutcome: inferredAssertion,
      continuationOutcome: 'continue',
      reason: null,
      attempts: [],
      expectedState: null,
      observedState: null,
      evidence: {},
    };
  }
  const actionOutcome = normalizeOutcome(
    row.actionOutcome || row.actionStatus || (row.ok === true ? 'succeeded' : row.ok === false ? 'failed' : null),
    actionAllowed,
    inferredAction
  );
  const assertionOutcome = normalizeOutcome(
    row.assertionOutcome || row.checkOutcome || row.outcome,
    assertionAllowed,
    inferredAssertion
  );
  return {
    actionOutcome,
    assertionOutcome,
    continuationOutcome: normalizeOutcome(row.continuationOutcome || row.continuation || row.decision, continuationAllowed, 'continue'),
    reason: clean(redactString(row.continuationReason || row.reason || row.error || '', redactionState), 600) || null,
    attempts: redactDeep(Array.isArray(row.attemptHistory) ? row.attemptHistory : Array.isArray(row.attempts) ? row.attempts : [], redactionState),
    expectedState: redactDeep(row.expectedState ?? row.expected ?? null, redactionState),
    observedState: redactDeep(row.observedState ?? row.actual ?? null, redactionState),
    evidence: redactDeep({
      beforeFingerprint: row.beforeFingerprint || null,
      afterFingerprint: row.afterFingerprint || null,
      screenshotRef: row.screenshotRef || row.screenshot || null,
      traceRef: row.traceRef || row.trace || null,
      durationMs: row.durationMs ?? row.duration ?? null,
    }, redactionState),
  };
}

function failureClassification(row) {
  const text = clean(row && (row.failureClassification || row.failureType || row.errorType || row.reason), 300).toLowerCase();
  if (/qaai|execution_error|locator|infrastructure|harness|uncheckable|not_executed/.test(text)) return 'qaai_execution_error';
  if (/product|website|validation|mismatch|not_matched|functional/.test(text)) return 'product_failure';
  return null;
}

function baseNodeIdentityRefs(value) {
  if (!value || typeof value !== 'object') return new Set();
  const identity = capturedActionIdentity(value, { assertion: isAssertionBase(value, null) });
  return contractIdentityRefs(value, identity, isAssertionBase(value, null));
}

function mergeContractAndGraphNode(contractNode, graphNode) {
  if (!graphNode) return contractNode;
  const merged = {
    ...graphNode,
    ...contractNode,
    raw: {
      ...(graphNode.raw && typeof graphNode.raw === 'object' ? graphNode.raw : {}),
      ...(contractNode.raw && typeof contractNode.raw === 'object' ? contractNode.raw : {}),
    },
  };
  const enrichmentFields = [
    'actionIdentity',
    'actionLocator',
    'locatorRecipe',
    'assertionContract',
    'targetIdentity',
    'targetFacts',
    'waitContract',
    'postcondition',
    'browserEventEvidence',
    'dataBinding',
    'expectedOutcome',
  ];
  for (const field of enrichmentFields) {
    if (contractNode[field] == null && graphNode[field] != null) merged[field] = graphNode[field];
  }
  return merged;
}

function baseNodes(executionContract, actionGraph) {
  const contract = executionContract && Array.isArray(executionContract.nodes) ? executionContract.nodes : [];
  const graph = actionGraph && Array.isArray(actionGraph.nodes) ? actionGraph.nodes : [];
  if (!contract.length) return graph.slice().sort((a, b) => Number(a.stepOrdinal || 0) - Number(b.stepOrdinal || 0));
  if (!graph.length) return contract.slice().sort((a, b) => Number(a.stepOrdinal || 0) - Number(b.stepOrdinal || 0));
  const usedContract = new Set();
  const authoritative = graph.map((graphNode) => {
    const graphRefs = baseNodeIdentityRefs(graphNode);
    const candidates = contract.map((contractNode, index) => ({ contractNode, index }))
      .filter(({ contractNode, index }) => !usedContract.has(index)
        && setsIntersect(graphRefs, baseNodeIdentityRefs(contractNode)));
    if (candidates.length !== 1) return graphNode;
    usedContract.add(candidates[0].index);
    return mergeContractAndGraphNode(graphNode, candidates[0].contractNode);
  });
  return authoritative.slice().sort((a, b) => Number(a.stepOrdinal || 0) - Number(b.stepOrdinal || 0));
}

function semanticMatchTokens(value) {
  const ignored = new Set([
    'a', 'an', 'and', 'at', 'click', 'double', 'enter', 'field', 'fill', 'for',
    'in', 'input', 'into', 'on', 'select', 'submit', 'the', 'to', 'type',
  ]);
  return new Set(String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/)
    .filter((word) => word && !ignored.has(word)));
}

function semanticReplayMatchScore(base, step, resolveByAs) {
  const resolve = step && step.target != null ? resolveByAs.get(String(step.target)) : null;
  const locator = step && (step.actionLocator || step.locatorRecipe)
    || resolve && (resolve.actionLocator || resolve.locatorRecipe)
    || null;
  const authored = [
    base && base.plannedText,
    base && base.pageIntent,
    base && base.raw && (base.raw.target || base.raw.element || base.raw.field || base.raw.label),
  ].filter(Boolean).join(' ');
  const replayText = [
    step && step.targetLabel,
    step && step.element,
    resolve && (resolve.elementLabel || resolve.narration || resolve.element || resolve.label),
    locator && (locator.accessibleName || locator.name || locator.text),
    locator && locator.targetFacts && locator.targetFacts.accessibleName,
  ].filter(Boolean).join(' ');
  const expected = semanticMatchTokens(authored);
  const observed = semanticMatchTokens(replayText);
  if (!expected.size || !observed.size) return 0;
  let score = 0;
  for (const token of expected) if (observed.has(token)) score += 1;
  return score;
}

function contractIdentityRefs(value, identity, assertion = false) {
  return new Set([
    identity && identity.contractStepId,
    identity && identity.sourceContractStepId,
    value && value.contractRef,
    value && value.contractStepId,
    value && value.caseContractStepId,
    value && value.sourceContractStepId,
    value && value.sourceCaseContractStepId,
    assertion && value && value.assertionId,
    value && value.stepId,
    value && value.id,
  ].filter(Boolean).map(String));
}

function setsIntersect(left, right) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function matchReplayStep(base, acts, assertions, usedActs, usedAssertions, resolveByAs, caseId = null) {
  const assertion = isAssertionBase(base, null);
  const pool = assertion ? assertions : acts;
  const used = assertion ? usedAssertions : usedActs;
  const authoredIdentity = capturedActionIdentity(base, { assertion });
  if (!authoredIdentity.caseId && caseId) authoredIdentity.caseId = clean(caseId, 180) || null;
  const refs = contractIdentityRefs(base, authoredIdentity, assertion);
  const authoredActionId = authoredIdentity.authoredActionId;
  const baseSequence = optionalIdentityNumber(authoredIdentity.authoredSequenceIndex ?? authoredIdentity.sequenceIndex);
  const expectedOperation = assertion
    ? normalizeAssertionType(base && base.expectedKind
      || base && base.expectedOutcome && base.expectedOutcome.kind
      || base && base.raw && (base.raw.channel || base.raw.kind || base.raw.type))
    : normalizeActionType(base && base.actionType || base && base.raw && (base.raw.action || base.raw.type));

  const identityForReplay = (step) => capturedActionIdentity(step, { assertion });
  const replayOperationFor = (step) => assertion
    ? normalizeAssertionType(step && step.channel)
    : normalizeActionType(step && step.action);
  const operationMatches = (step) => {
    const replayOperation = replayOperationFor(step);
    return !(expectedOperation && replayOperation && replayOperation !== expectedOperation);
  };
  const identityCompatible = (step, { semantic = false } = {}) => {
    if (!step) return false;
    const replayIdentity = identityForReplay(step);
    if (occurrenceIdentityIsForeign(authoredIdentity, replayIdentity)) return false;
    if (authoredActionId && replayIdentity.authoredActionId && authoredActionId !== replayIdentity.authoredActionId) return false;
    if (semantic) {
      const exactOccurrence = sameStableOccurrence(authoredIdentity, replayIdentity);
      const exactAuthoredAction = Boolean(
        authoredActionId
          && replayIdentity.authoredActionId
          && authoredActionId === replayIdentity.authoredActionId
      );
      if ((hasStableOccurrenceIdentity(authoredIdentity) || hasStableOccurrenceIdentity(replayIdentity))
        && !exactOccurrence
        && !exactAuthoredAction) return false;
    }
    return true;
  };
  const available = (step, stepIndex, options) => !used.has(stepIndex)
    && operationMatches(step)
    && identityCompatible(step, options);

  let index = hasStableOccurrenceIdentity(authoredIdentity)
    ? pool.findIndex((step, stepIndex) => available(step, stepIndex) && sameStableOccurrence(authoredIdentity, identityForReplay(step)))
    : -1;
  if (index < 0 && authoredActionId) index = pool.findIndex((step, stepIndex) => {
    if (!available(step, stepIndex)) return false;
    return identityForReplay(step).authoredActionId === authoredActionId;
  });
  if (index < 0) index = pool.findIndex((step, stepIndex) => {
    if (!available(step, stepIndex)) return false;
    const replayIdentity = identityForReplay(step);
    const replayRefs = contractIdentityRefs(step, replayIdentity, assertion);
    if (!setsIntersect(refs, replayRefs)) return false;
    const replaySequence = optionalIdentityNumber(replayIdentity.authoredSequenceIndex ?? replayIdentity.sequenceIndex);
    if (Number.isFinite(baseSequence) && Number.isFinite(replaySequence) && baseSequence !== replaySequence) return false;
    const baseOccurrenceOrdinal = optionalIdentityNumber(authoredIdentity.occurrenceOrdinal);
    const replayOccurrenceOrdinal = optionalIdentityNumber(replayIdentity.occurrenceOrdinal);
    if (Number.isFinite(baseOccurrenceOrdinal)
      && Number.isFinite(replayOccurrenceOrdinal)
      && baseOccurrenceOrdinal !== replayOccurrenceOrdinal) return false;
    return true;
  });
  if (index < 0 && refs.size > 0) {
    const sameContractCandidates = pool.map((step, stepIndex) => {
      if (!available(step, stepIndex)) return -1;
      const replayIdentity = identityForReplay(step);
      const replayRefs = contractIdentityRefs(step, replayIdentity, assertion);
      return setsIntersect(refs, replayRefs) ? stepIndex : -1;
    }).filter((stepIndex) => stepIndex >= 0);
    // Authored step ordinals and executable action sequences are separate domains:
    // assertion-only authored steps do not consume an action sequence. A unique
    // same-contract/same-operation candidate is authoritative even when those
    // numbers differ. Repeated candidates remain occurrence-identity strict.
    if (sameContractCandidates.length === 1) index = sameContractCandidates[0];
  }
  if (index < 0) {
    const expectedType = expectedOperation;
    const poolHasContractIdentity = pool.some((step) => contractIdentityRefs(
      step,
      identityForReplay(step),
      assertion
    ).size > 0);
    const compatible = expectedType ? pool.map((step, stepIndex) => {
      const replayType = replayOperationFor(step);
      return available(step, stepIndex, { semantic: true }) && replayType === expectedType ? stepIndex : -1;
    }).filter((stepIndex) => stepIndex >= 0) : [];
    if (compatible.length === 1) {
      const semanticScore = semanticReplayMatchScore(base, pool[compatible[0]], resolveByAs);
      if (semanticScore > 0
        || (refs.size === 0
          && !poolHasContractIdentity
          && !hasStableOccurrenceIdentity(authoredIdentity)
          && !hasStableOccurrenceIdentity(identityForReplay(pool[compatible[0]])))) index = compatible[0];
    } else if (compatible.length > 1) {
      const ranked = compatible.map((stepIndex) => ({
        stepIndex,
        score: semanticReplayMatchScore(base, pool[stepIndex], resolveByAs),
      })).sort((left, right) => right.score - left.score);
      if (ranked[0].score > 0 && (!ranked[1] || ranked[0].score > ranked[1].score)) {
        index = ranked[0].stepIndex;
      } else if (ranked[0].score > 0
        && !hasStableOccurrenceIdentity(authoredIdentity)
        && compatible.every((stepIndex) => !hasStableOccurrenceIdentity(identityForReplay(pool[stepIndex])))) {
        // Legacy envelopes without occurrence identity retain authored order.
        // Any stable occurrence identity removes this positional fallback.
        index = compatible[0];
      }
    }
  }
  if (index < 0) return null;
  used.add(index);
  return pool[index];
}

function firstFailureBoundary(nodes = []) {
  for (const [index, node] of (nodes || []).entries()) {
    const journal = node && node.journal || {};
    const assertion = node && node.assertion || null;
    const actionFailed = journal.actionOutcome === 'failed';
    const assertionFailed = assertion && ['not_matched', 'uncheckable'].includes(assertion.outcome);
    const stopped = ['stop_case', 'stop_descendants'].includes(journal.continuationOutcome);
    if (!actionFailed && !assertionFailed && !stopped) continue;
    return {
      stepId: node.stepId || null,
      contractStepId: node.contractStepId || null,
      sourceReplayIndex: Number.isInteger(node.sourceReplayIndex) ? node.sourceReplayIndex : null,
      ordinal: Number(node.ordinal) || index + 1,
      kind: node.kind || null,
      type: node.type || null,
      actionOutcome: journal.actionOutcome || null,
      assertionOutcome: assertion ? assertion.outcome || null : journal.assertionOutcome || null,
      continuationOutcome: journal.continuationOutcome || null,
      failureClassification: assertion && assertion.failureClassification || null,
      includedInExecutablePrefix: true,
    };
  }
  return null;
}

function executedPrefixProjection(nodes = [], unmatchedAuthoredOperations = []) {
  const boundary = firstFailureBoundary(nodes);
  const boundaryIndex = boundary
    ? nodes.findIndex((node) => node && node.stepId === boundary.stepId)
    : -1;
  const prefixNodes = boundaryIndex >= 0 ? nodes.slice(0, boundaryIndex + 1) : nodes.slice();
  return {
    schema: 'qaai-executed-prefix-projection/1',
    generatedFromExecutedBrowserEvidenceOnly: true,
    failureBoundary: boundary,
    executableNodeCount: prefixNodes.length,
    totalProjectedNodeCount: nodes.length,
    unmatchedAuthoredCount: unmatchedAuthoredOperations.length,
    stepIds: prefixNodes.map((node) => node.stepId).filter(Boolean),
    stoppedBeforeAuthoredSteps: unmatchedAuthoredOperations.length > 0,
  };
}

function buildExecutedCaseAstV1(input = {}) {
  const executionContract = parseJson(input.executionContract ?? input.executionContractJson, {}) || {};
  const caseInstance = parseJson(input.caseInstance ?? input.caseInstanceJson ?? executionContract.caseInstance, {}) || {};
  const actionGraph = parseJson(input.actionGraph ?? input.actionGraphJson, {}) || {};
  const replayEnvelope = parseJson(input.replayEnvelope ?? input.replayIrJson ?? input.envelope, {}) || {};
  const journal = journalRows(input.stepJournal ?? input.stepResults ?? input.journal ?? (input.runResult && input.runResult.stepResults));
  const redactionState = { redactedCount: 0 };
  const caseId = caseInstance.testCaseId || caseInstance.caseId || executionContract.testCaseId || input.testCaseId || null;
  const replay = replaySteps(replayEnvelope);
  const resolveByAs = new Map(replay.filter((step) => step.op === 'resolve' && step.as).map((step) => [String(step.as), step]));
  const acts = replay.filter((step) => step.op === 'act' || step.op === 'waitFor');
  const assertions = replay.filter((step) => step.op === 'assert');
  const usedActs = new Set();
  const usedAssertions = new Set();
  const usedJournal = new Set();
  const sourceNodes = baseNodes(executionContract, actionGraph);
  const authoredWork = sourceNodes.map((base) => {
    const matched = matchReplayStep(base, acts, assertions, usedActs, usedAssertions, resolveByAs, caseId);
    return {
      base,
      replay: matched,
      sourceReplayIndex: matched ? replay.indexOf(matched) : null,
    };
  });
  const unmatchedAuthoredOperations = authoredWork.filter((item) => !item.replay).map((item) => ({
    contractStepId: clean(
      item.base && (item.base.contractStepId || item.base.caseContractStepId || item.base.stepId || item.base.id),
      180
    ) || null,
    stepOrdinal: Number(item.base && item.base.stepOrdinal) || null,
    kind: isAssertionBase(item.base, null) ? 'assertion' : 'action',
    plannedText: clean(item.base && (item.base.plannedText || item.base.text), 600) || null,
    reason: 'No positively executed ReplayIR occurrence was available; authored intent remains diagnostic-only.',
  }));
  const work = authoredWork.filter((item) => Boolean(item.replay)
    && (!isAssertionBase(item.base, item.replay)
      || !assertionProjectionIsNonApplicable(item.base, item.replay)));
  const matchedReplay = new Set(work.map((item) => item.replay).filter(Boolean));
  const retryReplayEvidence = [];
  if (!sourceNodes.length) replay.forEach((step, sourceReplayIndex) => {
    if ((step.op !== 'act' && step.op !== 'waitFor' && step.op !== 'assert') || matchedReplay.has(step) || step.origin === 'inferred_helper') return;
    if (step.op === 'act' || step.op === 'waitFor') {
      const identity = capturedActionIdentity(step);
      const stableOccurrence = identity.actionOccurrenceId || identity.occurrenceKey || null;
      if (stableOccurrence) {
        const prior = work.find((item) => sameStableOccurrence(identity, capturedActionIdentity(item.replay)));
        if (prior) {
          retryReplayEvidence.push(step);
          return;
        }
      }
    }
    work.push({ base: {}, replay: step, sourceReplayIndex });
  });

  const sourceData = dataSources(executionContract, caseInstance);
  const sourceDataByKey = new Map(sourceData.map((entry) => [String(entry.key).toLowerCase(), entry]));
  const symbolTable = { targets: {}, methods: {}, steps: {}, data: {} };
  const targetKeyToId = new Map();
  const methodKeyToId = new Map();
  const dataKeyToId = new Map();
  const usedLocatorNames = new Set();
  const usedMethodNames = new Set();
  const usedStepIds = new Set();
  const nodes = [];

  function registerData(binding, literal, targetLabel) {
    if (!binding && literal == null) return null;
    const key = clean(binding && binding.key || targetLabel || 'value', 160) || 'value';
    const sourceEntry = sourceDataByKey.get(key.toLowerCase());
    const sourceDescriptor = sourceEntry ? descriptorParts(sourceEntry) : null;
    const sensitive = binding && binding.kind === 'env'
      || sourceDescriptor && sourceDescriptor.sensitive
      || isSensitiveKey(key)
      || isSensitiveKey(targetLabel);
    const existingKey = `${sensitive ? 'env' : 'fixture'}:${key.toLowerCase()}`;
    if (dataKeyToId.has(existingKey)) return dataKeyToId.get(existingKey);
    const dataId = `data_${idPart(key)}_${shortHash(existingKey, 8)}`;
    const envRef = sourceDescriptor && sourceDescriptor.envRef;
    const envName = binding && binding.envName
      || (envRef && String(envRef).replace(/^env:/i, ''))
      || snakeUpper(key, 'QAAI_VALUE');
    const rawValue = sourceDescriptor && sourceDescriptor.value !== undefined ? sourceDescriptor.value : literal;
    symbolTable.data[dataId] = sensitive ? {
      id: dataId,
      name: key,
      kind: 'env',
      envName,
      sensitive: true,
      source: sourceEntry && sourceEntry.source || 'action_binding',
    } : {
      id: dataId,
      name: key,
      kind: 'fixture',
      fixtureKey: key,
      sensitive: false,
      source: sourceEntry && sourceEntry.source || 'action_binding',
      ...(rawValue !== undefined ? { value: redactDeep(rawValue, redactionState, key) } : {}),
    };
    dataKeyToId.set(existingKey, dataId);
    return dataId;
  }

  function registerTarget(label, locator, stepId) {
    const targetLabel = clean(label || locator && locator.accessibleName || 'page', 180) || 'page';
    const key = `${targetLabel.toLowerCase()}|${locator && locator.expression || ''}|${shortHash(locatorContextKey(locator), 16)}`;
    if (targetKeyToId.has(key)) return targetKeyToId.get(key);
    const targetId = `target_${idPart(targetLabel)}_${shortHash(key, 8)}`;
    const locatorConstant = uniqueName(`${camel(targetLabel, 'target')}Locator`, usedLocatorNames);
    symbolTable.targets[targetId] = {
      id: targetId,
      label: targetLabel,
      locatorConstant,
      expression: locator && locator.expression || null,
      verified: locator ? locator.verified === true : false,
      source: locator && locator.source || null,
      guessed: locator ? locator.guessed === true : false,
      locatorConfidence: locator && locator.locatorConfidence || null,
      role: locator && locator.role || null,
      accessibleName: locator && locator.accessibleName || null,
      scope: locator && locator.scope || null,
      ...locatorAstProjection(locator),
      stepIds: stepId ? [stepId] : [],
    };
    targetKeyToId.set(key, targetId);
    return targetId;
  }

  function registerMethod(type, targetId, targetLabel, stepId) {
    const key = `${type}:${targetId || targetLabel || 'page'}`;
    if (methodKeyToId.has(key)) {
      const methodId = methodKeyToId.get(key);
      if (!symbolTable.methods[methodId].stepIds.includes(stepId)) symbolTable.methods[methodId].stepIds.push(stepId);
      return methodId;
    }
    const name = uniqueName(`${type.charAt(0).toLowerCase() + type.slice(1)}${pascal(targetLabel || 'Page')}`, usedMethodNames);
    const methodId = `method_${idPart(name)}_${shortHash(key, 8)}`;
    symbolTable.methods[methodId] = { id: methodId, name, actionType: type, targetId: targetId || null, stepIds: [stepId] };
    methodKeyToId.set(key, methodId);
    return methodId;
  }

  for (const [index, item] of work.entries()) {
    const base = item.base || {};
    const replayStep = item.replay || null;
    const assertion = isAssertionBase(base, replayStep);
    const rawChannel = replayStep && replayStep.channel
      || base.expectedKind
      || base.expectedOutcome && base.expectedOutcome.kind
      || base.raw && (base.raw.channel || base.raw.kind || base.raw.type)
      || (assertion ? 'TEXT' : null);
    const type = assertion
      ? normalizeAssertionType(rawChannel)
      : normalizeActionType(authoredActionOperation(base, replayStep));
    const ordinal = Number(base.stepOrdinal || index + 1);
    const preferredStepId = clean(
      base.contractStepId || replayStep && (replayStep.contractRef || replayStep.stepId || replayStep.id) || `step-${ordinal}`,
      180
    ) || `step-${ordinal}`;
    let stepId = preferredStepId;
    if (usedStepIds.has(stepId)) {
      const baseOccurrenceIdentity = capturedActionIdentity(base);
      const replayOccurrenceIdentity = capturedActionIdentity(replayStep);
      const occurrence = Number(
        baseOccurrenceIdentity.occurrenceOrdinal
          ?? replayOccurrenceIdentity.occurrenceOrdinal
          ?? baseOccurrenceIdentity.authoredSequenceIndex
          ?? replayOccurrenceIdentity.authoredSequenceIndex
          ?? baseOccurrenceIdentity.sequenceIndex
          ?? replayOccurrenceIdentity.sequenceIndex
          ?? ordinal
      );
      const suffix = Number.isFinite(occurrence) ? Math.floor(occurrence) : index + 1;
      stepId = `${preferredStepId}__occurrence_${suffix}`;
      let collision = 2;
      while (usedStepIds.has(stepId)) stepId = `${preferredStepId}__occurrence_${suffix}_${collision++}`;
    }
    usedStepIds.add(stepId);
    const resolve = replayStep && replayStep.target != null ? resolveByAs.get(String(replayStep.target)) : null;
    const targetLabel = clean(
      base.raw && (base.raw.target || base.raw.element || base.raw.field || base.raw.label)
        || base.pageIntent
        || resolve && (resolve.elementLabel || resolve.narration || resolve.element || resolve.label)
        || replayStep && (replayStep.targetLabel || replayStep.element || replayStep.target)
      || (type === 'AssertUrl' || ['Navigate', 'NavigateBack', 'NavigateForward', 'Reload'].includes(type) ? 'page' : 'target'),
      180
    );
    const row = journalFor(base, replayStep, journal, ordinal, usedJournal);
    const journalEntry = journalProjection(row, replayStep, redactionState);
    if (assertion && !replayStep && row && journalEntry.assertionOutcome === 'not_applicable') continue;
    const locator = locatorFrom(base, replayStep, resolve)
      || (assertion ? authoredAssertionLocator(base, replayStep, type) : null);
    const targetId = type && (LOCATOR_REQUIRED.has(type) || locator)
      ? registerTarget(targetLabel, locator, stepId)
      : null;
    if (targetId && !symbolTable.targets[targetId].stepIds.includes(stepId)) symbolTable.targets[targetId].stepIds.push(stepId);
    const destinationTargetRef = type === 'Drag' && replayStep
      ? clean(replayStep.destinationTarget || replayStep.destination || replayStep.toTarget, 180) || null
      : null;
    const destinationResolve = destinationTargetRef ? resolveByAs.get(destinationTargetRef) : null;
    const destinationLocator = destinationResolve
      ? locatorFrom({}, {
          actionLocator: replayStep && replayStep.destinationActionLocator,
          locatorRecipe: replayStep && replayStep.destinationLocatorRecipe,
        }, destinationResolve)
      : null;
    const destinationTargetLabel = destinationTargetRef
      ? clean(destinationResolve && (
          destinationResolve.elementLabel
          || destinationResolve.narration
          || destinationResolve.element
          || destinationResolve.label
        ) || destinationTargetRef, 180)
      : null;
    const destinationTargetId = destinationTargetRef
      ? registerTarget(destinationTargetLabel, destinationLocator, stepId)
      : null;
    const binding = explicitBinding(base, replayStep);
    const literal = literalActionValue(base, replayStep);
    const dataRef = type && ['Fill', 'Type', 'Select', 'Press', 'Upload'].includes(type)
      ? registerData(binding, literal, targetLabel)
      : null;
    const methodId = type && ACTION_NODE_TYPES.has(type) ? registerMethod(type, targetId, targetLabel, stepId) : null;
    const waitContract = type ? normalizeWaitContract(type, base, replayStep, row, dataRef, redactionState) : null;
    const observedAssertion = journalEntry.assertionOutcome;
    const classification = failureClassification(row)
      || (observedAssertion === 'not_matched' ? 'product_failure' : observedAssertion === 'uncheckable' ? 'qaai_execution_error' : null);
    const expectedResolution = assertion
      ? expectedValueResolution(base, replayStep, sourceDataByKey, type)
      : null;
    const expected = assertion ? redactDeep(expectedResolution.value, redactionState, 'expected') : null;
    const expectedSignals = assertion
      ? redactDeep(structuredAssertionSignals(base, replayStep), redactionState, 'expectedSignals')
      : null;
    const continuation = assertion
      ? assertionContinuationPolicy(base, replayStep, executionContract, caseInstance)
      : null;
    const actionIdentity = !assertion && type
      ? actionIdentityFor(base, replayStep, { caseId, ordinal, operation: type })
      : null;
    const eventEvidence = !assertion
      ? explicitBrowserEventEvidence(base, replayStep, row)
      : null;
    const projectedEventEvidence = eventEvidence
      ? redactDeep({
          ...eventEvidence,
          occurrenceIdentity: cloneExactEvidence(actionIdentity),
        }, redactionState)
      : null;
    const navigation = !assertion
      ? navigationProjection(type, base, replayStep, row, waitContract, redactionState)
      : null;
    const optionalAction = !assertion ? optionalActionMetadata(base, replayStep) : null;
    const node = {
      stepId,
      sourceReplayIndex: Number.isInteger(item.sourceReplayIndex)
        ? item.sourceReplayIndex
        : null,
      contractStepId: actionIdentity && actionIdentity.contractStepId
        || clean(base.contractStepId || replayStep && replayStep.contractStepId, 180)
        || stepId,
      sourceContractStepId: actionIdentity && actionIdentity.sourceContractStepId
        || clean(base.sourceContractStepId || replayStep && replayStep.sourceContractStepId, 180)
        || null,
      origin: clean(base.origin || replayStep && replayStep.origin || (sourceNodes.length ? 'authored' : 'legacy'), 80),
      authored: sourceNodes.length > 0 || base.authored === true || replayStep && replayStep.authored === true,
      ordinal,
      sequenceIndex: actionIdentity ? actionIdentity.sequenceIndex : ordinal,
      authoredSequenceIndex: actionIdentity ? actionIdentity.authoredSequenceIndex : null,
      occurrenceOrdinal: actionIdentity ? actionIdentity.occurrenceOrdinal : null,
      authoredActionId: actionIdentity ? actionIdentity.authoredActionId : null,
      actionOccurrenceId: actionIdentity ? actionIdentity.actionOccurrenceId : null,
      sourceActionOccurrenceId: actionIdentity ? actionIdentity.sourceActionOccurrenceId : null,
      occurrenceKey: actionIdentity ? actionIdentity.occurrenceKey : null,
      toolUseId: actionIdentity ? actionIdentity.toolUseId : null,
      operation: actionIdentity ? actionIdentity.operation : null,
      actionIdentity,
      authoredOperation: !assertion ? authoredActionOperation(base, replayStep) : null,
      optional: optionalAction ? true : false,
      actionGuard: optionalAction,
      ...locatorAstProjection(locator),
      kind: assertion ? 'assertion' : 'action',
      type: type || (assertion ? 'UnsupportedAssertion' : 'UnsupportedAction'),
      plannedText: clean(base.plannedText || base.text || replayStep && (replayStep.label || replayStep.description) || `${type || 'Unsupported'} step`, 600),
      targetId,
      destinationTargetId,
      destinationTargetRef,
      methodId,
      dataRef,
      dependencies: Array.isArray(base.dependencies) ? base.dependencies.map(String) : [],
      waitContract,
      navigation,
      observedConsequenceUrl: !assertion
        ? redactString(replayStep && replayStep.observedConsequenceUrl || row && row.observedConsequenceUrl || '', redactionState) || null
        : null,
      browserEventEvidence: projectedEventEvidence,
      browserEvent: !assertion && replayStep && replayStep.browserEvent
        ? redactDeep(replayStep.browserEvent, redactionState)
        : null,
      popupIdentity: !assertion
        ? replayStep && replayStep.popupIdentity
          ? redactDeep(replayStep.popupIdentity, redactionState)
          : locator && locator.popupIdentity
            ? redactDeep(locator.popupIdentity, redactionState)
            : null
        : null,
      popupExpectedUrl: !assertion && replayStep && replayStep.popupExpectedUrl
        ? redactString(replayStep.popupExpectedUrl, redactionState)
        : null,
      downloadEvidence: !assertion && replayStep && replayStep.downloadEvidence
        ? redactDeep(replayStep.downloadEvidence, redactionState)
        : null,
      dialogEvidence: !assertion && replayStep && replayStep.dialogEvidence
        ? redactDeep(replayStep.dialogEvidence, redactionState)
        : null,
      dialogType: !assertion && replayStep && replayStep.dialogType || null,
      expectedMessage: !assertion && replayStep && replayStep.expectedMessage
        ? redactString(replayStep.expectedMessage, redactionState)
        : null,
      assertion: assertion ? {
        schemaVersion: 'qaai-assertion-contract-v1',
        contractStepId: clean(
          base.contractStepId
            || base.caseContractStepId
            || replayStep && (replayStep.contractRef || replayStep.contractStepId || replayStep.stepId),
          180
        ) || stepId,
        assertionId: clean(
          base.assertionId || base.persistedAssertionId || replayStep && replayStep.assertionId,
          180
        ) || null,
        channel: clean(rawChannel, 100) || 'TEXT',
        comparator: clean(replayStep && replayStep.comparator || base.expectedOutcome && base.expectedOutcome.comparator || base.raw && base.raw.comparator || 'equals', 80),
        polarity: clean(replayStep && replayStep.polarity || base.expectedOutcome && base.expectedOutcome.polarity || 'must_match', 80),
        expected,
        expectedSignals,
        targetIdentity: cloneExactEvidence(
          replayStep && replayStep.targetIdentity
            || replayStep && replayStep.actionLocator && replayStep.actionLocator.targetIdentity
            || base.targetIdentity
            || locator && locator.targetIdentity
            || null
        ),
        expectedResolution: redactDeep({
          resolved: expectedResolution.resolved,
          source: expectedResolution.source,
          bindingKey: expectedResolution.bindingKey,
          binding: expectedResolution.binding || null,
          contractText: expectedResolution.contractText || null,
          reason: expectedResolution.reason || null,
        }, redactionState),
        unresolvedExpected: expectedResolution.resolved !== true,
        authoredContractText: expectedResolution.contractText || null,
        observed: journalEntry.observedState,
        outcome: observedAssertion,
        enabled: true,
        hard: continuation.hard,
        continuationPolicy: continuation.policy,
        continuationPolicySource: continuation.source,
        failureClassification: classification,
        productFailure: classification === 'product_failure',
      } : null,
      journal: journalEntry,
    };
    nodes.push(node);
    symbolTable.steps[stepId] = {
      stepId,
      ordinal,
      nodeType: node.type,
      targetId,
      methodId,
      dataRefs: dataRef ? [dataRef] : [],
      assertionChannel: assertion ? node.assertion.channel : null,
      actionOccurrenceId: actionIdentity ? actionIdentity.actionOccurrenceId : null,
      sourceActionOccurrenceId: actionIdentity ? actionIdentity.sourceActionOccurrenceId : null,
      authoredActionId: actionIdentity ? actionIdentity.authoredActionId : null,
      authoredSequenceIndex: actionIdentity ? actionIdentity.authoredSequenceIndex : null,
      occurrenceOrdinal: actionIdentity ? actionIdentity.occurrenceOrdinal : null,
      occurrenceKey: actionIdentity ? actionIdentity.occurrenceKey : null,
      actionIdentity,
    };
  }

  const status = clean(input.status || input.runResult && input.runResult.status || caseInstance.status || actionGraph.status || 'unknown', 80).toLowerCase();
  const executedPrefix = executedPrefixProjection(nodes, unmatchedAuthoredOperations);
  const ast = {
    schema: AST_SCHEMA,
    astId: `ecast_${shortHash(stableStringify({
      contractId: executionContract.contractId || null,
      caseInstanceId: caseInstance.id || caseInstance.caseInstanceId || null,
      replay: replay.map((step) => {
        const locatorEvidence = step.actionLocator || step.locatorRecipe || null;
        return [
          step.op,
          step.action || step.channel || null,
          step.target || step.contractRef || null,
          step.actionIdentity && step.actionIdentity.authoredActionId || step.authoredActionId || null,
          step.actionIdentity && step.actionIdentity.actionOccurrenceId || step.actionOccurrenceId || null,
          step.actionIdentity && step.actionIdentity.sourceActionOccurrenceId || step.sourceActionOccurrenceId || null,
          step.actionIdentity && step.actionIdentity.occurrenceKey || step.occurrenceKey || null,
          (step.actionIdentity && step.actionIdentity.sequenceIndex) ?? step.sequenceIndex ?? null,
          locatorEvidence ? locatorExpression(locatorEvidence) : null,
          locatorEvidence ? shortHash(stableStringify(locatorEvidence), 20) : null,
        ];
      }),
      journal: journal.map((row) => [row && (row.stepId || row.contractStepId || row.ordinal), row && (row.actionOutcome || row.assertionOutcome || row.outcome)]),
    }), 16)}`,
    case: {
      caseId,
      caseInstanceId: caseInstance.id || caseInstance.caseInstanceId || executionContract.runResultId || input.runResultId || null,
      name: clean(caseInstance.name || caseInstance.caseName || executionContract.testCaseName || input.caseName || 'Executed case', 240),
      revision: caseInstance.revision || caseInstance.caseRevision || executionContract.revision || null,
      generationId: caseInstance.generationId || executionContract.generationId || input.generationId || null,
      status,
      enabled: !NON_EXECUTABLE_STATUSES.has(status),
      expectedVerdict: nodes.some((node) => node.assertion && node.assertion.productFailure) ? 'fail' : status === 'failed' || status === 'fail' ? 'fail' : 'pass',
      executedPrefix: {
        executableNodeCount: executedPrefix.executableNodeCount,
        totalProjectedNodeCount: executedPrefix.totalProjectedNodeCount,
        failureBoundary: executedPrefix.failureBoundary,
      },
      initialState: redactDeep(caseInstance.initialState || executionContract.initialState || null, redactionState),
      finalState: redactDeep(caseInstance.finalState || executionContract.finalState || null, redactionState),
      sessionPlan: redactDeep(caseInstance.sessionPlan || executionContract.sessionPlan || null, redactionState),
    },
    nodes,
    symbolTable,
    source: {
      contractId: executionContract.contractId || null,
      actionGraphSchema: actionGraph.schema || null,
      replaySchema: replayEnvelope.schema || replayEnvelope.ir && replayEnvelope.ir.schema || null,
      journalStepCount: journal.length,
      contextTransitions: redactDeep(replayEnvelope.contextTransitions || replayEnvelope.ir && replayEnvelope.ir.contextTransitions || [] , redactionState),
      unmatchedReplayOperations: (sourceNodes.length
        ? replay.filter((step) => (step.op === 'act' || step.op === 'waitFor' || step.op === 'assert') && !matchedReplay.has(step))
        : retryReplayEvidence).map((step) => {
          const identity = capturedActionIdentity(step, { assertion: step && step.op === 'assert' });
          return {
            op: step.op,
            action: step.action || null,
            contractStepId: identity.contractStepId,
            sourceContractStepId: identity.sourceContractStepId,
            authoredActionId: identity.authoredActionId,
            actionOccurrenceId: identity.actionOccurrenceId,
            sourceActionOccurrenceId: identity.sourceActionOccurrenceId,
            authoredSequenceIndex: identity.authoredSequenceIndex,
            occurrenceOrdinal: identity.occurrenceOrdinal,
            occurrenceKey: identity.occurrenceKey,
            origin: step.origin || 'unbound_runtime_evidence',
          };
        }),
      unmatchedAuthoredOperations,
      executedPrefix,
      failureBoundary: executedPrefix.failureBoundary,
    },
    redaction: {
      rawSecretsIncluded: false,
      redactedValueCount: redactionState.redactedCount,
    },
  };
  ast.validation = validateExecutedCaseAstV1(ast);
  return ast;
}

function scanSecretFindings(value, findings, path = '$', key = '', depth = 0) {
  if (depth > 10 || value == null) return;
  if (typeof value === 'string') {
    if (value === '[REDACTED]' || value === '[REDACTED_JWT]' || /^env:[A-Za-z_][A-Za-z0-9_]*$/i.test(value)) return;
    if (containsSecretText(value) || isSensitiveKey(key) && value !== 'env') {
      findings.push({ rule: 'ast_unresolved_secret', severity: 'error', path, message: `Potential raw secret remains at ${path}; bind it to an environment reference.` });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanSecretFindings(item, findings, `${path}[${index}]`, key, depth + 1));
    return;
  }
  if (typeof value !== 'object') return;
  for (const [childKey, childValue] of Object.entries(value)) {
    if (path === '$' && childKey === 'validation') continue;
    scanSecretFindings(childValue, findings, `${path}.${childKey}`, childKey, depth + 1);
  }
}

function validateExecutedCaseAstV1(ast) {
  const findings = [];
  const add = (rule, message, stepId = null, path = null) => findings.push({ rule, severity: 'error', stepId, path, message });
  if (!ast || ast.schema !== AST_SCHEMA) add('ast_schema_invalid', `Expected schema ${AST_SCHEMA}.`, null, '$.schema');
  const nodes = ast && Array.isArray(ast.nodes) ? ast.nodes : [];
  const symbols = ast && ast.symbolTable && typeof ast.symbolTable === 'object' ? ast.symbolTable : {};
  const targets = symbols.targets || {};
  const methods = symbols.methods || {};
  const steps = symbols.steps || {};
  const data = symbols.data || {};
  const seenSteps = new Set();
  const seenActionOccurrences = new Map();
  const seenOccurrenceKeys = new Map();
  for (const node of nodes) {
    const stepId = node && node.stepId || null;
    if (!stepId) add('ast_step_id_missing', 'Every AST node requires a stable stepId.');
    else if (seenSteps.has(stepId)) add('ast_step_id_duplicate', `Duplicate stepId ${stepId}.`, stepId);
    else seenSteps.add(stepId);
    const supported = ACTION_NODE_TYPES.has(node && node.type) || ASSERTION_NODE_TYPES.has(node && node.type);
    if (!supported) add('ast_node_type_unsupported', `Unsupported AST node type ${node && node.type || '(missing)'}.`, stepId);
    if (ACTION_NODE_TYPES.has(node && node.type)) {
      if (!node.methodId || !methods[node.methodId]) add('ast_method_missing', `Action ${node.type} has no compiler-owned page method.`, stepId);
      else if (!Array.isArray(methods[node.methodId].stepIds) || !methods[node.methodId].stepIds.includes(stepId)) {
        add('ast_method_step_unresolved', `Method ${node.methodId} does not resolve step ${stepId}.`, stepId);
      }
      const identity = node && node.actionIdentity && typeof node.actionIdentity === 'object'
        ? node.actionIdentity
        : null;
      if (!identity) {
        add('ast_action_identity_missing', `Action ${node.type} has no immutable occurrence identity.`, stepId);
      } else {
        if (!identity.actionOccurrenceId) add('ast_action_occurrence_id_missing', `Action ${node.type} has no actionOccurrenceId.`, stepId);
        if (!identity.occurrenceKey) add('ast_action_occurrence_key_missing', `Action ${node.type} has no occurrenceKey.`, stepId);
        if (!Number.isFinite(Number(identity.authoredSequenceIndex))) {
          add('ast_authored_sequence_missing', `Action ${node.type} has no authoredSequenceIndex.`, stepId);
        }
        const stringFields = [
          'contractStepId',
          'sourceContractStepId',
          'authoredActionId',
          'actionOccurrenceId',
          'sourceActionOccurrenceId',
          'occurrenceKey',
          'toolUseId',
          'operation',
        ];
        const numericFields = ['sequenceIndex', 'authoredSequenceIndex', 'occurrenceOrdinal'];
        for (const field of stringFields) {
          if (node[field] != null && identity[field] != null && String(node[field]) !== String(identity[field])) {
            add('ast_action_identity_mismatch', `Node ${field} does not match actionIdentity.${field}.`, stepId, `$.nodes.${stepId}.${field}`);
          }
        }
        for (const field of numericFields) {
          if (node[field] != null && identity[field] != null && Number(node[field]) !== Number(identity[field])) {
            add('ast_action_identity_mismatch', `Node ${field} does not match actionIdentity.${field}.`, stepId, `$.nodes.${stepId}.${field}`);
          }
        }
        const stepSymbolIdentity = stepId && steps[stepId] && steps[stepId].actionIdentity;
        if (stepSymbolIdentity && identity.actionOccurrenceId && stepSymbolIdentity.actionOccurrenceId !== identity.actionOccurrenceId) {
          add('ast_step_identity_mismatch', 'The step symbol resolves a different action occurrence.', stepId, `$.symbolTable.steps.${stepId}.actionIdentity`);
        }
        if (identity.actionOccurrenceId) {
          const priorStep = seenActionOccurrences.get(identity.actionOccurrenceId);
          if (priorStep) {
            add('ast_action_occurrence_duplicate', `Action occurrence ${identity.actionOccurrenceId} is executable in both ${priorStep} and ${stepId}.`, stepId);
          } else {
            seenActionOccurrences.set(identity.actionOccurrenceId, stepId);
          }
        }
        if (identity.occurrenceKey) {
          const priorStep = seenOccurrenceKeys.get(identity.occurrenceKey);
          if (priorStep) {
            add('ast_action_occurrence_key_duplicate', `Occurrence key ${identity.occurrenceKey} is executable in both ${priorStep} and ${stepId}.`, stepId);
          } else {
            seenOccurrenceKeys.set(identity.occurrenceKey, stepId);
          }
        }
      }
    }
    if (LOCATOR_REQUIRED.has(node && node.type)) {
      const target = node.targetId && targets[node.targetId];
      if (!target || !target.expression) add('ast_locator_missing', `${node.type} requires an action-time locator.`, stepId);
      else if (ASSERTION_NODE_TYPES.has(node && node.type)) {
        const assertionContractBacked = target.locatorEvidenceKind === 'authoredAssertionContract'
          && target.source === 'authored_assertion_contract'
          && target.guessed !== true;
        if (target.guessed === true || target.verified !== true && !assertionContractBacked) {
          add('ast_assertion_locator_not_contract_backed', `${node.type} requires an exact-node locator or deterministic assertion contract target.`, stepId);
        }
      } else if (target.verified !== true || target.guessed === true) {
        add('ast_locator_not_exact_node_verified', `${node.type} requires an exact-node verified action-time locator.`, stepId);
      }
    }
    if (node && node.type === 'Drag') {
      const destination = node.destinationTargetId && targets[node.destinationTargetId];
      if (!destination || !destination.expression) {
        add('ast_drag_destination_locator_missing', 'Drag requires an exact destination locator.', stepId);
      } else if (destination.verified !== true || destination.guessed === true) {
        add('ast_drag_destination_not_exact_node_verified', 'Drag destination requires an exact-node verified action-time locator.', stepId);
      }
    }
    if (WAIT_REQUIRED.has(node && node.type)) {
      if (!node.waitContract || node.waitContract.schema !== WAIT_SCHEMA || !node.waitContract.kind) {
        add('ast_wait_postcondition_missing', `${node.type} requires an explicit wait or postcondition.`, stepId);
      }
    }
    if (node && node.dataRef && !data[node.dataRef]) add('ast_data_ref_unresolved', `Data reference ${node.dataRef} is absent from the symbol table.`, stepId);
    if (!stepId || !steps[stepId]) add('ast_step_symbol_missing', `Step ${stepId || '(missing)'} is absent from the compiler symbol table.`, stepId);
    if (node && node.assertion && node.assertion.productFailure) {
      if (ast.case && ast.case.enabled !== true || node.assertion.enabled !== true) {
        add('ast_product_failure_disabled', 'A product failure must remain enabled; its authored continuation policy decides whether execution continues.', stepId);
      }
    }
  }
  for (const [dataId, symbol] of Object.entries(data)) {
    if (symbol && symbol.sensitive === true && (symbol.kind !== 'env' || !symbol.envName || Object.prototype.hasOwnProperty.call(symbol, 'value'))) {
      add('ast_sensitive_data_not_env', `Sensitive data ${dataId} must be an environment reference with no literal value.`, null, `$.symbolTable.data.${dataId}`);
    }
  }
  scanSecretFindings(ast, findings);
  return {
    schema: 'qaai-executed-case-ast-validation/1',
    valid: findings.length === 0,
    errorCount: findings.length,
    findings,
    summary: {
      nodes: nodes.length,
      actions: nodes.filter((node) => ACTION_NODE_TYPES.has(node.type)).length,
      assertions: nodes.filter((node) => ASSERTION_NODE_TYPES.has(node.type)).length,
      targets: Object.keys(targets).length,
      methods: Object.keys(methods).length,
      dataRefs: Object.keys(data).length,
      enabledProductFailures: nodes.filter((node) => node.assertion && node.assertion.productFailure && node.assertion.enabled).length,
    },
  };
}

module.exports = {
  AST_SCHEMA,
  WAIT_SCHEMA,
  ACTION_NODE_TYPES,
  ASSERTION_NODE_TYPES,
  buildExecutedCaseAstV1,
  validateExecutedCaseAstV1,
  stableStringify,
};
