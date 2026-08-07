'use strict';

const SCHEMA = 'qaai_universal_control_v1';

const CONTROL_TYPES = Object.freeze([
  'textbox',
  'password',
  'contenteditable',
  'button',
  'link',
  'native_select',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'autocomplete',
  'multiselect',
  'date_input',
  'date_picker',
  'time_input',
  'time_picker',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'accordion',
  'tab',
  'dialog',
  'menu',
  'tooltip',
  'tree',
  'table',
  'grid',
  'file_input',
  'drag_source',
  'drop_target',
  'download',
  'canvas',
  'unknown',
]);

const TRANSACTION_STATES = Object.freeze([
  'unresolved',
  'resolved',
  'precondition_proven',
  'dispatching',
  'dispatched',
  'observing',
  'committed',
  'validation_failed',
  'dependent_blocked',
  'uncertain',
]);

const GENERIC_IDENTITY_TOKENS = new Set([
  'field', 'control', 'input', 'button', 'link', 'dropdown', 'drop', 'down',
  'menu', 'option', 'calendar', 'picker', 'select', 'selection', 'textbox',
  'box', 'item', 'icon', 'value', 'the', 'a', 'an', 'on',
]);

const IDENTITY_CONTRADICTION_PAIRS = Object.freeze([
  ['early', 'late'],
  ['pickup', 'delivery'],
  ['inbound', 'outbound'],
  ['before', 'after'],
  ['start', 'end'],
  ['minimum', 'maximum'],
]);

const MINIMUM_SEMANTIC_IDENTITY_SCORE = 0.6;
const DISTINCTIVE_IDENTITY_TOKENS = new Set([
  'date', 'email', 'password', 'phone', 'secret', 'time', 'timezone', 'username',
]);

const ACTION_COMPATIBILITY = Object.freeze({
  fill: new Set(['textbox', 'password', 'contenteditable', 'autocomplete', 'combobox', 'spinbutton', 'date_input', 'time_input']),
  type: new Set(['textbox', 'password', 'contenteditable', 'autocomplete', 'spinbutton']),
  select: new Set(['native_select', 'combobox', 'listbox', 'option', 'menuitem', 'autocomplete', 'multiselect', 'radio', 'time_picker']),
  date: new Set(['date_input', 'date_picker']),
  time: new Set(['time_input', 'time_picker', 'combobox', 'listbox']),
  check: new Set(['checkbox', 'radio', 'switch']),
  uncheck: new Set(['checkbox', 'switch']),
  expand: new Set(['accordion', 'button', 'combobox', 'multiselect', 'menu', 'tree']),
  collapse: new Set(['accordion', 'button', 'combobox', 'multiselect', 'menu', 'tree']),
  hover: new Set(CONTROL_TYPES),
  click: new Set(CONTROL_TYPES),
  press: new Set(CONTROL_TYPES),
});

function clean(value, max = 500) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizedToken(value) {
  return clean(value, 120).toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function identityTokens(value) {
  return normalizedToken(value)
    .split(/\s+/)
    .filter((item) => item && !GENERIC_IDENTITY_TOKENS.has(item));
}

function uniqueStrings(values, max = 240) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((item) => clean(item, max))
    .filter(Boolean))];
}

function normalizeElementRef(input = null) {
  if (!input || typeof input !== 'object') return null;
  const attributes = input.attributes && typeof input.attributes === 'object'
    ? { ...input.attributes }
    : {};
  const labels = uniqueStrings([
    ...(Array.isArray(input.labels) ? input.labels : []),
    input.label,
    input.accessibleName,
    input.name,
    input.placeholder,
    input.title,
    ...(Array.isArray(input.associatedLabels) ? input.associatedLabels : []),
  ]);
  return {
    ref: clean(input.ref || input.id || input.nodeId, 160) || null,
    backendNodeId: Number.isFinite(Number(input.backendNodeId)) ? Number(input.backendNodeId) : null,
    frameId: clean(input.frameId, 160) || null,
    framePath: Array.isArray(input.framePath) ? [...input.framePath] : [],
    shadowPath: Array.isArray(input.shadowPath) ? [...input.shadowPath] : [],
    tag: clean(input.tag || input.tagName, 80).toLowerCase() || null,
    inputType: clean(input.inputType || input.type, 80).toLowerCase() || null,
    role: clean(input.role, 80).toLowerCase() || null,
    labels,
    attributes,
    visible: input.visible === true,
    enabled: input.enabled !== false && input.disabled !== true,
    editable: input.editable === true,
    expanded: typeof input.expanded === 'boolean' ? input.expanded : null,
    selected: typeof input.selected === 'boolean' ? input.selected : null,
    checked: typeof input.checked === 'boolean' ? input.checked : null,
    value: input.sensitive === true ? null : (input.value ?? null),
    valueRef: clean(input.valueRef, 240) || null,
    sensitive: input.sensitive === true,
  };
}

function inferControlType(input = {}) {
  const explicit = clean(input.controlType, 80).toLowerCase();
  if (CONTROL_TYPES.includes(explicit) && explicit !== 'unknown') return explicit;

  const role = clean(input.role, 80).toLowerCase();
  const tag = clean(input.tag || input.tagName, 80).toLowerCase();
  const type = clean(input.inputType || input.type, 80).toLowerCase();
  const hasPopup = clean(input.ariaHasPopup || input.attributes?.['aria-haspopup'], 80).toLowerCase();
  const autocomplete = clean(input.autocomplete || input.attributes?.['aria-autocomplete'], 80).toLowerCase();

  if (tag === 'input' && type === 'password') return 'password';
  if (tag === 'input' && type === 'date') return 'date_input';
  if (tag === 'input' && type === 'time') return 'time_input';
  if (tag === 'input' && type === 'file') return 'file_input';
  if (tag === 'select') return input.multiple === true ? 'multiselect' : 'native_select';
  if (input.contentEditable === true || role === 'textbox' && input.multiline === true) return 'contenteditable';
  if (role === 'combobox' && autocomplete && autocomplete !== 'none') return 'autocomplete';
  if (role === 'combobox' && hasPopup === 'dialog' && /date/.test(clean(input.intentKind, 80))) return 'date_picker';
  if (role === 'combobox') return input.multiselectable === true ? 'multiselect' : 'combobox';
  if (role === 'listbox') return 'listbox';
  if (role === 'option') return 'option';
  if (role === 'menuitem' || role === 'menuitemradio' || role === 'menuitemcheckbox' || role === 'treeitem') return 'menuitem';
  if (role === 'textbox' || role === 'searchbox') return 'textbox';
  if (role === 'spinbutton') return 'spinbutton';
  if (role === 'checkbox') return 'checkbox';
  if (role === 'radio') return 'radio';
  if (role === 'switch') return 'switch';
  if (role === 'slider') return 'slider';
  if (role === 'button') return 'button';
  if (role === 'link') return 'link';
  if (role === 'tab') return 'tab';
  if (role === 'dialog') return 'dialog';
  if (role === 'menu' || role === 'menuitem') return 'menu';
  if (role === 'tooltip') return 'tooltip';
  if (role === 'tree' || role === 'treeitem') return 'tree';
  if (role === 'grid') return 'grid';
  if (role === 'table') return 'table';
  if (tag === 'canvas') return 'canvas';
  if (tag === 'button') return 'button';
  if (tag === 'a') return 'link';
  if (tag === 'textarea' || tag === 'input') return 'textbox';
  return 'unknown';
}

function createUniversalControl(input = {}) {
  const ownerNode = normalizeElementRef(input.ownerNode || input.ownerElement || input.owner || input.element);
  const interactionNode = normalizeElementRef(
    input.interactionNode || input.interactionElement || input.trigger
      || input.ownerNode || input.ownerElement || input.owner || input.element,
  );
  const popupNode = normalizeElementRef(input.popupNode || input.popupElement || input.popup);
  const valueNode = normalizeElementRef(
    input.valueNode || input.valueElement || input.ownerNode || input.ownerElement || input.owner || input.element,
  );
  const controlType = inferControlType({
    ...(ownerNode || {}),
    ...(input.controlFacts || {}),
    controlType: input.controlType,
    intentKind: input.intentKind,
  });
  const sensitive = input.sensitive === true || ownerNode?.sensitive === true;
  const control = {
    schema: SCHEMA,
    controlType,
    requestedAction: clean(input.requestedAction || input.action, 80).toLowerCase() || null,
    requestedTarget: clean(input.requestedTarget || input.target || input.label, 240) || null,
    ownerNode,
    interactionNode,
    popupNode,
    valueNode,
    // Compatibility aliases remain read-only views of the canonical node
    // roles while existing adapters migrate to ResolvedControl terminology.
    ownerElement: ownerNode,
    interactionElement: interactionNode,
    popupElement: popupNode,
    optionContainer: normalizeElementRef(input.optionContainer),
    valueElement: valueNode,
    currentValue: sensitive ? null : (input.currentValue ?? valueNode?.value ?? null),
    expectedValue: sensitive ? null : (input.expectedValue ?? null),
    valueRef: clean(input.valueRef || ownerNode?.valueRef, 240) || null,
    sensitive,
    postcondition: input.postcondition && typeof input.postcondition === 'object'
      ? { ...input.postcondition }
      : null,
    transactionState: TRANSACTION_STATES.includes(input.transactionState)
      ? input.transactionState
      : 'unresolved',
    relationships: {
      ownerToTrigger: clean(input.relationships?.ownerToTrigger, 120) || null,
      ownerToPopup: clean(input.relationships?.ownerToPopup, 120) || null,
      popupToOptions: clean(input.relationships?.popupToOptions, 120) || null,
    },
  };
  control.semanticMatch = compareSemanticIdentity(control);
  return control;
}

function semanticIdentity(control) {
  const ownerNode = control?.ownerNode || control?.ownerElement;
  const interactionNode = control?.interactionNode || control?.interactionElement;
  const valueNode = control?.valueNode || control?.valueElement;
  const labels = uniqueStrings([
    ...(ownerNode?.labels || []),
    ...(interactionNode?.labels || []),
    ...(valueNode?.labels || []),
  ]);
  return {
    requested: clean(control?.requestedTarget, 240) || null,
    resolvedLabels: labels,
    requestedTokens: identityTokens(control?.requestedTarget),
    // Tokenize each label independently. Joining first lets a long ancestor
    // label consume normalizedToken's length budget and truncate a later,
    // exact field/trigger label.
    resolvedTokens: [...new Set(labels.flatMap((label) => identityTokens(label)))],
    resolvedTokenSets: labels.map((label) => ({
      label,
      tokens: identityTokens(label),
    })),
  };
}

function semanticContradictions(requestedTokens, resolvedTokens) {
  const requested = new Set(requestedTokens || []);
  const resolved = new Set(resolvedTokens || []);
  return IDENTITY_CONTRADICTION_PAIRS.flatMap(([left, right]) => {
    const requestedLeftOnly = requested.has(left) && !requested.has(right);
    const requestedRightOnly = requested.has(right) && !requested.has(left);
    const resolvedLeftOnly = resolved.has(left) && !resolved.has(right);
    const resolvedRightOnly = resolved.has(right) && !resolved.has(left);
    if (requestedLeftOnly && resolvedRightOnly) return [`${left}_versus_${right}`];
    if (requestedRightOnly && resolvedLeftOnly) return [`${right}_versus_${left}`];
    return [];
  });
}

function compareSemanticIdentity(control) {
  const action = clean(control?.requestedAction, 80).toLowerCase();
  const type = clean(control?.controlType, 80).toLowerCase() || 'unknown';
  const compatible = !ACTION_COMPATIBILITY[action] || ACTION_COMPATIBILITY[action].has(type);
  if (!compatible) {
    return {
      ok: false,
      code: 'semantic_control_type_mismatch',
      action,
      controlType: type,
      score: 0,
      minimumScore: MINIMUM_SEMANTIC_IDENTITY_SCORE,
      identity: semanticIdentity(control),
    };
  }

  const identity = semanticIdentity(control);
  const requested = new Set(identity.requestedTokens);
  const scoredLabels = identity.resolvedTokenSets.map(({ label, tokens }) => {
    const resolved = new Set(tokens);
    const overlap = [...requested].filter((item) => resolved.has(item));
    const coverage = requested.size ? overlap.length / requested.size : 1;
    const precision = resolved.size ? overlap.length / resolved.size : 0;
    return {
      label,
      tokens,
      overlap,
      coverage,
      precision,
      score: Number((coverage * 0.7 + precision * 0.3).toFixed(6)),
      contradictions: semanticContradictions([...requested], tokens),
    };
  }).sort((left, right) => right.score - left.score);
  const best = scoredLabels[0] || {
    label: null, tokens: [], overlap: [], coverage: 0, precision: 0, score: 0, contradictions: [],
  };
  const contradictions = [...new Set(scoredLabels.flatMap((entry) => entry.contradictions || []))];
  const distinctiveOverlap = best.overlap.some((item) => DISTINCTIVE_IDENTITY_TOKENS.has(item));
  const minimumScore = distinctiveOverlap ? 0.25 : MINIMUM_SEMANTIC_IDENTITY_SCORE;
  const identityMatched = requested.size === 0
    || (best.overlap.length > 0
      && best.score >= minimumScore
      && contradictions.length === 0);
  if (!identityMatched) {
    return {
      ok: false,
      code: 'semantic_control_identity_mismatch',
      action,
      controlType: type,
      score: best.score,
      minimumScore,
      identity,
      overlap: best.overlap,
      matchedLabel: best.label,
      contradictions,
    };
  }
  return {
    ok: true,
    code: 'semantic_control_identity_matched',
    action,
    controlType: type,
    score: requested.size === 0 ? 1 : best.score,
    minimumScore,
    identity,
    overlap: best.overlap,
    matchedLabel: best.label,
    contradictions: [],
  };
}

function validateUniversalControl(control) {
  const issues = [];
  if (!control || typeof control !== 'object') return ['control must be an object'];
  if (control.schema !== SCHEMA) issues.push('invalid universal control schema');
  if (!CONTROL_TYPES.includes(control.controlType)) issues.push('unsupported control type');
  if (!control.requestedAction) issues.push('requested action is required');
  if (!control.requestedTarget) issues.push('requested target is required');
  if (!control.ownerNode) issues.push('owner node is required');
  if (!control.interactionNode) issues.push('interaction node is required');
  if (!control.valueNode) issues.push('value node is required');
  const identity = compareSemanticIdentity(control);
  if (!identity.ok) issues.push(identity.code);
  if (control.sensitive && control.expectedValue != null) issues.push('sensitive expected value must use valueRef');
  if (control.sensitive && !control.valueRef) issues.push('sensitive control requires valueRef');
  return issues;
}

module.exports = {
  SCHEMA,
  CONTROL_TYPES,
  TRANSACTION_STATES,
  ACTION_COMPATIBILITY,
  MINIMUM_SEMANTIC_IDENTITY_SCORE,
  clean,
  identityTokens,
  normalizeElementRef,
  inferControlType,
  createUniversalControl,
  semanticIdentity,
  compareSemanticIdentity,
  validateUniversalControl,
};
