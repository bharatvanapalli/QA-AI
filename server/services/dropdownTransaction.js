'use strict';

const actionTransactionCoordinator = require('./actionTransactionCoordinator');
const controlAdapterRegistry = require('./controlAdapterRegistry');
const universalControlModel = require('./universalControlModel');

const SCHEMA = 'qaai_dropdown_transaction_v1';

const STATES = Object.freeze({
  CLOSED: 'CLOSED',
  OPENING: 'OPENING',
  OPEN: 'OPEN',
  SELECTING: 'SELECTING',
  VALUE_COMMITTED: 'VALUE_COMMITTED',
});

const MATCH_MODES = Object.freeze({
  EXACT: 'exact',
  CONTAINS: 'contains',
});

const SUPPORTED_CONTROL_TYPES = new Set([
  'native_select',
  'combobox',
  'listbox',
  'autocomplete',
]);

function clean(value, max = 500) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function timestamp(now) {
  const value = typeof now === 'function' ? now() : Date.now();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return new Date(Number(value)).toISOString();
}

function normalizedText(value, caseSensitive = true) {
  const text = clean(value, 1000);
  return caseSensitive ? text : text.toLocaleLowerCase();
}

function normalizeMatchMode(value) {
  return clean(value, 40).toLowerCase() === MATCH_MODES.CONTAINS
    ? MATCH_MODES.CONTAINS
    : MATCH_MODES.EXACT;
}

function getAttribute(node, name) {
  if (!node || typeof node !== 'object') return null;
  const attributes = node.attributes && typeof node.attributes === 'object' ? node.attributes : {};
  const direct = node[name] ?? node[name.replace(/^aria-/, 'aria').replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
  return direct ?? attributes[name] ?? null;
}

function booleanFact(value) {
  if (typeof value === 'boolean') return value;
  const token = clean(value, 20).toLowerCase();
  if (token === 'true') return true;
  if (token === 'false') return false;
  return null;
}

function pathKey(value) {
  if (Array.isArray(value)) return value.map((item) => clean(item, 160)).filter(Boolean).join('>');
  return clean(value, 500);
}

function nodeRef(node) {
  return clean(node?.ref || node?.id || node?.nodeId || node?.attributes?.id, 200) || null;
}

function nodeBackendId(node) {
  const value = Number(node?.backendNodeId);
  return Number.isFinite(value) ? value : null;
}

function nodeLabel(node) {
  return clean(
    node?.accessibleName
      || node?.name
      || node?.label
      || node?.text
      || node?.displayedValue
      || node?.value,
    500,
  );
}

function normalizeNode(node = null) {
  if (!node || typeof node !== 'object') return null;
  const attributes = node.attributes && typeof node.attributes === 'object' ? { ...node.attributes } : {};
  return {
    ref: nodeRef(node),
    backendNodeId: nodeBackendId(node),
    role: clean(node.role, 80).toLowerCase() || null,
    tag: clean(node.tag || node.tagName, 80).toLowerCase() || null,
    label: nodeLabel(node) || null,
    text: clean(node.text ?? node.textContent ?? node.label, 1000) || null,
    value: node.value ?? null,
    selectedValue: node.selectedValue ?? node.selectedLabel ?? null,
    displayedValue: node.displayedValue ?? node.renderedValue ?? null,
    visible: node.visible !== false && node.hidden !== true,
    enabled: node.enabled !== false && node.disabled !== true,
    expanded: booleanFact(node.expanded ?? getAttribute(node, 'aria-expanded')),
    selected: booleanFact(node.selected ?? getAttribute(node, 'aria-selected')),
    frameId: clean(node.frameId, 160) || null,
    framePath: Array.isArray(node.framePath) ? [...node.framePath] : [],
    shadowPath: Array.isArray(node.shadowPath) ? [...node.shadowPath] : [],
    ownerRef: clean(node.ownerRef || node.controlledBy || node.anchorRef || node.triggerRef, 200) || null,
    ownerBackendNodeId: Number.isFinite(Number(node.ownerBackendNodeId || node.anchorBackendNodeId))
      ? Number(node.ownerBackendNodeId || node.anchorBackendNodeId)
      : null,
    newlyVisible: node.newlyVisible === true,
    attributes,
    options: Array.isArray(node.options) ? node.options.map(normalizeOption).filter(Boolean) : [],
  };
}

function normalizeOption(option = null, index = 0) {
  if (option == null) return null;
  if (typeof option !== 'object') {
    const text = clean(option, 1000);
    return text ? { ref: null, backendNodeId: null, role: 'option', text, value: text, visible: true, selected: null, index } : null;
  }
  const text = clean(option.text ?? option.label ?? option.accessibleName ?? option.name ?? option.value, 1000);
  if (!text) return null;
  return {
    ref: nodeRef(option),
    backendNodeId: nodeBackendId(option),
    role: clean(option.role, 80).toLowerCase() || 'option',
    text,
    value: option.value ?? text,
    visible: option.visible !== false && option.hidden !== true,
    selected: booleanFact(option.selected ?? getAttribute(option, 'aria-selected')),
    framePath: Array.isArray(option.framePath) ? [...option.framePath] : [],
    shadowPath: Array.isArray(option.shadowPath) ? [...option.shadowPath] : [],
    index: Number.isInteger(option.index) ? option.index : index,
  };
}

function normalizeObservation(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const owner = normalizeNode(source.owner || source.ownerElement || source.control);
  const trigger = normalizeNode(source.trigger || source.interactionElement || source.owner || source.ownerElement);
  const valueNode = normalizeNode(source.valueNode || source.valueElement || source.owner || source.ownerElement);
  const popupInputs = [
    ...(Array.isArray(source.popups) ? source.popups : []),
    ...(source.popup ? [source.popup] : []),
    ...(source.optionContainer && source.optionContainer !== source.popup ? [source.optionContainer] : []),
  ];
  const popups = popupInputs.map(normalizeNode).filter(Boolean);
  const rootOptions = (Array.isArray(source.visibleOptions) ? source.visibleOptions : [])
    .map(normalizeOption)
    .filter(Boolean);
  return {
    available: source.available !== false,
    owner,
    trigger,
    valueNode,
    popups,
    visibleOptions: rootOptions.filter((option) => option.visible),
    nativeSelectReady: source.nativeSelectReady === true || source.nativePickerOpen === true,
    eventEvidence: source.eventEvidence && typeof source.eventEvidence === 'object'
      ? { ...source.eventEvidence }
      : null,
  };
}

function relationTokens(node) {
  const values = [
    getAttribute(node, 'aria-controls'),
    getAttribute(node, 'aria-owns'),
    node?.controls,
    node?.owns,
  ];
  return new Set(values.flatMap((value) => clean(value, 1000).split(/\s+/)).filter(Boolean));
}

function sameBoundary(left, right) {
  if (!left || !right) return true;
  const leftFrame = pathKey(left.framePath) || clean(left.frameId, 160);
  const rightFrame = pathKey(right.framePath) || clean(right.frameId, 160);
  const leftShadow = pathKey(left.shadowPath);
  const rightShadow = pathKey(right.shadowPath);
  return (!leftFrame || !rightFrame || leftFrame === rightFrame)
    && (!leftShadow || !rightShadow || leftShadow === rightShadow);
}

function sameNode(left, right) {
  if (!left || !right) return false;
  const leftBackend = nodeBackendId(left);
  const rightBackend = nodeBackendId(right);
  if (leftBackend != null && rightBackend != null) return leftBackend === rightBackend;
  const leftRef = nodeRef(left);
  const rightRef = nodeRef(right);
  return !!leftRef && !!rightRef && leftRef === rightRef && sameBoundary(left, right);
}

function popupCorrelation(control, observation, popup, beforeObservation = null) {
  if (!popup?.visible) return { matched: false, reason: 'popup_not_visible' };
  const owner = observation.owner || control.ownerElement;
  const trigger = observation.trigger || control.interactionElement || owner;
  if (!sameBoundary(owner, popup) || !sameBoundary(trigger, popup)) {
    return { matched: false, reason: 'popup_context_mismatch' };
  }

  const popupId = nodeRef(popup);
  const relations = new Set([...relationTokens(owner), ...relationTokens(trigger)]);
  if (popupId && relations.has(popupId)) {
    return { matched: true, reason: 'aria_popup_relationship', popupId };
  }

  const ownerRefs = new Set([nodeRef(owner), nodeRef(trigger)].filter(Boolean));
  if (popup.ownerRef && ownerRefs.has(popup.ownerRef)) {
    return { matched: true, reason: 'popup_owner_reference', popupId };
  }

  const ownerBackendIds = new Set([nodeBackendId(owner), nodeBackendId(trigger)].filter((value) => value != null));
  if (popup.ownerBackendNodeId != null && ownerBackendIds.has(popup.ownerBackendNodeId)) {
    return { matched: true, reason: 'popup_owner_backend_node', popupId };
  }

  const declaredPopup = control.popupElement || control.optionContainer;
  if (declaredPopup && sameNode(declaredPopup, popup)) {
    const beforeVisible = beforeObservation?.popups?.some((item) => sameNode(item, popup) && item.visible) === true;
    if (popup.newlyVisible || !beforeVisible) {
      return { matched: true, reason: 'declared_popup_became_visible', popupId };
    }
  }

  return { matched: false, reason: 'popup_not_correlated_to_owner', popupId };
}

function visibleOptionsFor(observation, popup) {
  const popupOptions = Array.isArray(popup?.options) ? popup.options.filter((option) => option.visible) : [];
  return popupOptions.length ? popupOptions : observation.visibleOptions;
}

function proveOpen(control, beforeRaw, currentRaw) {
  const before = normalizeObservation(beforeRaw);
  const current = normalizeObservation(currentRaw);
  if (!current.available) {
    return { matched: null, checked: false, terminal: false, reason: 'dropdown_open_observation_unavailable' };
  }

  if (control.controlType === 'native_select') {
    const owner = current.owner || control.ownerElement;
    const ready = current.nativeSelectReady || (
      clean(owner?.tag, 40).toLowerCase() === 'select'
      && owner?.visible !== false
      && owner?.enabled !== false
    );
    return {
      matched: ready,
      checked: true,
      terminal: false,
      reason: ready ? 'native_select_selection_surface_ready' : 'native_select_not_actionable',
      evidence: { owner, visibleOptions: visibleOptionsFor(current, null), popup: null, correlation: 'native_select' },
    };
  }

  const candidates = current.popups.filter((popup) => popup.visible);
  const correlated = candidates
    .map((popup) => ({ popup, correlation: popupCorrelation(control, current, popup, before) }))
    .filter((item) => item.correlation.matched);
  const owner = current.owner || control.ownerElement;
  const trigger = current.trigger || control.interactionElement || owner;
  const expanded = owner?.expanded === true || trigger?.expanded === true;

  if (correlated.length > 1) {
    return {
      matched: false,
      checked: true,
      terminal: true,
      reason: 'multiple_correlated_dropdown_popups',
      evidence: { correlatedPopupRefs: correlated.map((item) => nodeRef(item.popup)) },
    };
  }

  if (correlated.length === 1) {
    const selected = correlated[0];
    return {
      matched: true,
      checked: true,
      terminal: true,
      reason: expanded ? 'aria_expanded_and_popup_correlated' : selected.correlation.reason,
      evidence: {
        owner,
        trigger,
        popup: selected.popup,
        optionContainer: selected.popup,
        visibleOptions: visibleOptionsFor(current, selected.popup),
        correlation: selected.correlation,
      },
    };
  }

  const ownerRefs = new Set([nodeRef(owner), nodeRef(trigger)].filter(Boolean));
  const ownerBackendIds = new Set([nodeBackendId(owner), nodeBackendId(trigger)]
    .filter((value) => value != null));
  const newlyVisible = candidates.filter((popup) => popup.newlyVisible === true
    && sameBoundary(owner, popup)
    && sameBoundary(trigger, popup)
    && (!popup.ownerRef || ownerRefs.has(popup.ownerRef))
    && (popup.ownerBackendNodeId == null || ownerBackendIds.has(popup.ownerBackendNodeId)));
  if (newlyVisible.length === 1) {
    const popup = newlyVisible[0];
    return {
      matched: true,
      checked: true,
      terminal: true,
      reason: 'unique_new_popup_after_dropdown_dispatch',
      evidence: {
        owner,
        trigger,
        popup,
        optionContainer: popup,
        visibleOptions: visibleOptionsFor(current, popup),
        correlation: { matched: true, reason: 'unique_new_popup_after_dropdown_dispatch' },
      },
    };
  }

  if (candidates.length > 0) {
    return {
      matched: false,
      checked: true,
      terminal: true,
      reason: 'visible_popup_unrelated_to_dropdown_owner',
      evidence: { owner, trigger, candidatePopupRefs: candidates.map((item) => nodeRef(item)) },
    };
  }

  const relationIds = new Set([...relationTokens(owner), ...relationTokens(trigger)]);
  if (expanded && relationIds.size > 0) {
    return {
      matched: true,
      checked: true,
      terminal: true,
      reason: 'aria_expanded_with_owned_popup_identity',
      evidence: { owner, trigger, popup: null, visibleOptions: current.visibleOptions, relationIds: [...relationIds] },
    };
  }

  return {
    matched: false,
    checked: true,
    terminal: false,
    reason: 'dropdown_open_state_not_proven',
    evidence: { owner, trigger, candidatePopupRefs: candidates.map((item) => nodeRef(item)) },
  };
}

function compareText(actual, expected, mode, caseSensitive) {
  const left = normalizedText(actual, caseSensitive);
  const right = normalizedText(expected, caseSensitive);
  if (!left || !right) return false;
  return mode === MATCH_MODES.CONTAINS ? left.includes(right) : left === right;
}

function inspectOptionOrder(options, expectedOptions, { caseSensitive = true } = {}) {
  const actual = options.filter((option) => option.visible).map((option) => option.text);
  const expected = (Array.isArray(expectedOptions) ? expectedOptions : []).map((value) => clean(value, 1000));
  if (!expected.length) {
    return { checked: false, matched: null, expected: [], actual, reason: 'option_order_not_declared' };
  }
  const matched = actual.length === expected.length
    && actual.every((value, index) => compareText(value, expected[index], MATCH_MODES.EXACT, caseSensitive));
  return {
    checked: true,
    matched,
    expected,
    actual,
    reason: matched ? 'visible_option_order_exact' : 'visible_option_order_mismatch',
    continuation: { shouldContinue: true, blockDependents: false, validationOnly: true },
  };
}

function resolveRequestedOption(options, expectedValue, optionsConfig = {}) {
  const mode = normalizeMatchMode(optionsConfig.matchMode);
  const caseSensitive = optionsConfig.caseSensitive !== false;
  const visible = options.filter((option) => option.visible);
  const exact = visible.filter((option) => compareText(option.text, expectedValue, MATCH_MODES.EXACT, caseSensitive));
  if (exact.length === 1) return { ok: true, option: exact[0], matchMode: MATCH_MODES.EXACT, candidates: exact };
  if (exact.length > 1) return { ok: false, code: 'requested_option_ambiguous', matchMode: MATCH_MODES.EXACT, candidates: exact };
  if (mode === MATCH_MODES.EXACT) return { ok: false, code: 'requested_option_not_found', matchMode: mode, candidates: [] };
  const contained = visible.filter((option) => compareText(option.text, expectedValue, MATCH_MODES.CONTAINS, caseSensitive));
  if (contained.length === 1) return { ok: true, option: contained[0], matchMode: mode, candidates: contained };
  return {
    ok: false,
    code: contained.length ? 'requested_option_ambiguous' : 'requested_option_not_found',
    matchMode: mode,
    candidates: contained,
  };
}

function readOwnerValue(observation, control) {
  const current = normalizeObservation(observation);
  const owner = current.owner || control.ownerElement;
  const valueNode = current.valueNode || control.valueElement || owner;
  const candidates = [
    owner?.selectedValue,
    owner?.displayedValue,
    owner?.value,
    valueNode?.selectedValue,
    valueNode?.displayedValue,
    valueNode?.value,
    current.eventEvidence?.afterValue,
    current.eventEvidence?.selectedValue,
  ].filter((value) => value != null && clean(value, 1000));
  return { owner, valueNode, candidates: [...new Set(candidates.map((value) => clean(value, 1000)))] };
}

function popupClosed(control, observation, openedPopup) {
  if (control.controlType === 'native_select') return { closed: true, reason: 'native_select_has_no_dom_popup_requirement' };
  const current = normalizeObservation(observation);
  const owner = current.owner || control.ownerElement;
  const trigger = current.trigger || control.interactionElement || owner;
  if (owner?.expanded === false || trigger?.expanded === false) {
    return { closed: true, reason: 'aria_expanded_false' };
  }
  if (openedPopup) {
    const matching = current.popups.find((popup) => sameNode(popup, openedPopup));
    if (!matching || matching.visible === false) return { closed: true, reason: 'correlated_popup_hidden_or_removed' };
    return { closed: false, reason: 'correlated_popup_still_visible' };
  }
  return { closed: false, reason: 'popup_close_not_proven' };
}

function proveSelection(control, observation, expectedValue, options = {}) {
  const current = normalizeObservation(observation);
  if (!current.available) {
    return { matched: null, checked: false, terminal: false, reason: 'dropdown_value_observation_unavailable' };
  }
  const matchMode = normalizeMatchMode(options.matchMode);
  const caseSensitive = options.caseSensitive !== false;
  const readback = readOwnerValue(current, control);
  const valueMatched = readback.candidates.some((value) => compareText(value, expectedValue, matchMode, caseSensitive));
  const close = options.expectPopupClose === false
    ? { closed: true, reason: 'popup_close_not_required' }
    : popupClosed(control, current, options.openedPopup);
  return {
    matched: valueMatched && close.closed,
    checked: true,
    terminal: false,
    reason: !valueMatched
      ? 'owner_selected_value_not_committed'
      : close.closed ? 'owner_selected_value_and_popup_close_proven' : close.reason,
    evidence: {
      owner: readback.owner,
      valueNode: readback.valueNode,
      ownerReadback: readback.candidates,
      expectedValue: clean(expectedValue, 1000),
      matchMode,
      popupClose: close,
    },
  };
}

function createDropdownControl(input = {}) {
  const controlInput = input.control && typeof input.control === 'object' ? input.control : input;
  const control = universalControlModel.createUniversalControl({
    ...controlInput,
    requestedAction: 'select',
    expectedValue: input.expectedValue ?? controlInput.expectedValue,
  });
  if (!SUPPORTED_CONTROL_TYPES.has(control.controlType)) {
    throw new Error(`unsupported_dropdown_control_type: ${control.controlType}`);
  }
  const issues = universalControlModel.validateUniversalControl(control);
  if (issues.length) throw new Error(`invalid_dropdown_control: ${issues.join(', ')}`);
  const adapter = controlAdapterRegistry.requireControlAdapter({
    actionKind: 'select',
    controlType: control.controlType,
    role: control.ownerElement?.role,
    tag: control.ownerElement?.tag,
  });
  return { ...control, controlAdapter: adapter.adapter };
}

function createLedger(input = {}) {
  const now = input.now || Date.now;
  const entries = [];
  const append = async (entry) => {
    const record = {
      sequence: entries.length,
      at: timestamp(now),
      ...entry,
    };
    entries.push(record);
    if (typeof input.persistEvidence === 'function') await input.persistEvidence({ schema: SCHEMA, ...record });
    return record;
  };
  return { entries, append };
}

function resultEnvelope(context, overrides = {}) {
  const validationFailures = context.validations.filter((item) => item.checked && item.matched === false);
  return {
    schema: SCHEMA,
    status: overrides.status || 'blocked',
    state: context.state,
    stateHistory: [...context.stateHistory],
    control: context.control,
    selectedOption: context.selectedOption || null,
    validations: [...context.validations],
    validationFailures,
    shouldContinue: overrides.shouldContinue === true,
    blockDependents: overrides.blockDependents !== false,
    reason: overrides.reason || null,
    openTransaction: context.openTransaction || null,
    selectionTransaction: context.selectionTransaction || null,
    evidenceLedger: [...context.ledger.entries],
    canonicalEvidence: { ...context.canonicalEvidence },
  };
}

function createDropdownRuntimeTracker(input = {}) {
  const expectedValue = clean(input.expectedValue ?? input.value, 1000);
  if (!expectedValue) throw new TypeError('expectedValue is required');
  const control = createDropdownControl({ ...input, expectedValue });
  const context = {
    control,
    state: STATES.CLOSED,
    stateHistory: [],
    evidenceLedger: [],
    validations: [],
    canonicalEvidence: {},
    selectedOption: null,
    beforeOpen: null,
    popupCloseLimitationRecorded: false,
  };
  const append = (type, phase, evidence = null) => {
    context.evidenceLedger.push({
      sequence: context.evidenceLedger.length,
      at: timestamp(input.now || Date.now),
      type,
      phase,
      attemptStatus: 'canonical',
      evidence,
    });
  };
  const transition = (state, evidence = null) => {
    if (context.stateHistory.at(-1) !== state) context.stateHistory.push(state);
    context.state = state;
    append('state_transition', state, evidence);
  };
  const normalizeNewPopups = (observation) => {
    const current = normalizeObservation(observation);
    const before = context.beforeOpen || normalizeObservation({ available: false });
    current.popups = current.popups.map((popup) => ({
      ...popup,
      newlyVisible: popup.visible === true
        && !before.popups.some((candidate) => sameNode(candidate, popup) && candidate.visible === true),
    }));
    return current;
  };
  transition(STATES.CLOSED, { controlType: control.controlType, owner: control.ownerElement });
  return {
    control,
    captureClosed(observation) {
      context.beforeOpen = normalizeObservation(observation);
      append('observation', 'before_open', context.beforeOpen);
      return context.beforeOpen;
    },
    markOpening() {
      transition(STATES.OPENING);
    },
    proveOpened(observation) {
      const current = normalizeNewPopups(observation);
      const proof = proveOpen(control, context.beforeOpen, current);
      append('proof', 'open', proof);
      if (proof.matched === true) {
        context.canonicalEvidence.open = proof.evidence;
        transition(STATES.OPEN, proof.evidence);
        const order = inspectOptionOrder(proof.evidence?.visibleOptions || [], input.expectedOptions, {
          caseSensitive: input.caseSensitive !== false,
        });
        context.validations.push({ kind: 'visible_option_order', ...order });
        append('validation', 'option_order', context.validations.at(-1));
        const requested = resolveRequestedOption(proof.evidence?.visibleOptions || [], expectedValue, {
          matchMode: input.matchMode,
          caseSensitive: input.caseSensitive !== false,
        });
        if (requested.ok) context.selectedOption = requested.option;
      }
      return proof;
    },
    acceptOpenedEvidence(evidence = {}) {
      const proof = {
        matched: true,
        checked: true,
        terminal: true,
        reason: evidence.reason || 'owner_scoped_option_resolved',
        evidence,
      };
      append('proof', 'open', proof);
      context.canonicalEvidence.open = evidence;
      transition(STATES.OPEN, evidence);
      return proof;
    },
    markSelecting(option = null) {
      if (option) context.selectedOption = normalizeOption(option);
      transition(STATES.SELECTING, { option: context.selectedOption });
    },
    proveCommitted(observation) {
      const openedPopup = context.canonicalEvidence.open?.popup || null;
      const expectPopupClose = input.expectPopupClose !== false
        && (control.controlType === 'native_select' || !!openedPopup);
      if (input.expectPopupClose !== false
        && control.controlType !== 'native_select'
        && !openedPopup
        && !context.popupCloseLimitationRecorded) {
        context.popupCloseLimitationRecorded = true;
        append('observation_limitation', 'popup_close', {
          code: 'popup_identity_unavailable',
          message: 'Exact owner value remains authoritative; popup close could not be correlated.',
        });
      }
      const proof = proveSelection(control, observation, expectedValue, {
        matchMode: input.matchMode,
        caseSensitive: input.caseSensitive !== false,
        expectPopupClose,
        openedPopup,
      });
      append('proof', 'selection', proof);
      if (proof.matched === true) {
        context.canonicalEvidence.selection = proof.evidence;
        transition(STATES.VALUE_COMMITTED, proof.evidence);
      }
      return proof;
    },
    snapshot() {
      return {
        schema: SCHEMA,
        state: context.state,
        stateHistory: [...context.stateHistory],
        control,
        selectedOption: context.selectedOption,
        validations: [...context.validations],
        validationFailures: context.validations.filter((item) => item.checked && item.matched === false),
        evidenceLedger: [...context.evidenceLedger],
        canonicalEvidence: { ...context.canonicalEvidence },
      };
    },
  };
}

async function executeDropdownTransaction(input = {}) {
  if (typeof input.captureState !== 'function') throw new TypeError('captureState hook is required');
  if (typeof input.dispatchOpen !== 'function') throw new TypeError('dispatchOpen hook is required');
  if (typeof input.dispatchSelect !== 'function') throw new TypeError('dispatchSelect hook is required');
  const expectedValue = clean(input.expectedValue ?? input.value, 1000);
  if (!expectedValue) throw new TypeError('expectedValue is required');

  const control = createDropdownControl({ ...input, expectedValue });
  const ledger = createLedger(input);
  const context = {
    control,
    ledger,
    state: STATES.CLOSED,
    stateHistory: [],
    validations: [],
    canonicalEvidence: {},
    selectedOption: null,
    openTransaction: null,
    selectionTransaction: null,
  };
  const transition = async (state, evidence = null) => {
    context.state = state;
    context.stateHistory.push(state);
    await ledger.append({ type: 'state_transition', phase: state, attemptStatus: 'canonical', evidence });
  };
  await transition(STATES.CLOSED, { controlType: control.controlType, owner: control.ownerElement });

  let openPreState = null;
  await transition(STATES.OPENING);
  const openResult = await actionTransactionCoordinator.coordinateActionTransaction({
    runId: input.runId,
    caseId: input.caseId,
    stepId: input.stepId,
    sequenceIndex: input.sequenceIndex,
    occurrenceIndex: input.occurrenceIndex,
    actionOccurrenceId: input.actionOccurrenceId ? `${input.actionOccurrenceId}:open` : undefined,
    action: { kind: 'open_dropdown', target: control.interactionElement },
    target: control.interactionElement,
    failureMode: actionTransactionCoordinator.FAILURE_MODE.DEPENDENT_BLOCK,
    now: input.now,
    maxDispatchAttempts: 1,
    maxObservationAttempts: input.maxOpenObservations || 5,
    observationIntervalMs: input.observationIntervalMs || 0,
    sleep: input.sleep,
    capturePreState: async () => {
      openPreState = await input.captureState({ phase: 'before_open', control });
      return openPreState;
    },
    dispatch: async ({ transaction }) => {
      await ledger.append({
        type: 'dispatch',
        phase: 'open',
        attemptStatus: 'attempted',
        actionOccurrenceId: transaction.actionOccurrenceId,
        target: control.interactionElement,
      });
      return input.dispatchOpen({ control, transaction });
    },
    observe: async ({ attempt, transaction }) => input.captureState({
      phase: 'observe_open',
      attempt,
      control,
      transaction,
    }),
    provePostcondition: async ({ observation }) => proveOpen(control, openPreState, observation.data),
    persist: async (transaction) => {
      if (typeof input.persistTransaction === 'function') await input.persistTransaction({ phase: 'open', transaction });
    },
  });
  context.openTransaction = openResult.transaction;
  if (openResult.outcome?.status !== 'passed') {
    await ledger.append({
      type: 'open_outcome',
      phase: 'open',
      attemptStatus: 'canonical',
      outcome: openResult.outcome,
    });
    return resultEnvelope(context, {
      status: 'blocked',
      reason: openResult.outcome?.reason || 'dropdown_open_state_not_proven',
      shouldContinue: false,
      blockDependents: true,
    });
  }

  context.canonicalEvidence.open = openResult.outcome.evidence;
  await ledger.append({
    type: 'open_outcome',
    phase: 'open',
    attemptStatus: 'canonical',
    outcome: openResult.outcome,
  });
  await transition(STATES.OPEN, openResult.outcome.evidence);

  const visibleOptions = Array.isArray(openResult.outcome.evidence?.visibleOptions)
    ? openResult.outcome.evidence.visibleOptions.map(normalizeOption).filter(Boolean)
    : [];
  const orderValidation = inspectOptionOrder(visibleOptions, input.expectedOptions, {
    caseSensitive: input.caseSensitive !== false,
  });
  context.validations.push({ kind: 'visible_option_order', ...orderValidation });
  await ledger.append({
    type: 'validation',
    phase: 'option_order',
    attemptStatus: 'canonical',
    validation: context.validations[context.validations.length - 1],
  });

  const requested = resolveRequestedOption(visibleOptions, expectedValue, {
    matchMode: input.matchMode,
    caseSensitive: input.caseSensitive !== false,
  });
  if (!requested.ok) {
    await ledger.append({
      type: 'option_resolution',
      phase: 'select',
      attemptStatus: 'canonical',
      outcome: { code: requested.code, candidates: requested.candidates },
    });
    return resultEnvelope(context, {
      status: 'blocked',
      reason: requested.code,
      shouldContinue: false,
      blockDependents: true,
    });
  }

  context.selectedOption = requested.option;
  await transition(STATES.SELECTING, { option: requested.option, matchMode: requested.matchMode });
  const openedPopup = openResult.outcome.evidence?.popup || null;
  const selectionResult = await actionTransactionCoordinator.coordinateActionTransaction({
    runId: input.runId,
    caseId: input.caseId,
    stepId: input.stepId,
    sequenceIndex: input.sequenceIndex,
    occurrenceIndex: input.occurrenceIndex,
    actionOccurrenceId: input.actionOccurrenceId ? `${input.actionOccurrenceId}:select` : undefined,
    action: { kind: 'select_option', target: requested.option, value: expectedValue },
    target: requested.option,
    failureMode: actionTransactionCoordinator.FAILURE_MODE.DEPENDENT_BLOCK,
    now: input.now,
    maxDispatchAttempts: 1,
    maxObservationAttempts: input.maxSelectObservations || 5,
    observationIntervalMs: input.observationIntervalMs || 0,
    sleep: input.sleep,
    capturePreState: async () => input.captureState({ phase: 'before_select', control, option: requested.option }),
    dispatch: async ({ transaction }) => {
      await ledger.append({
        type: 'dispatch',
        phase: 'select',
        attemptStatus: 'attempted',
        actionOccurrenceId: transaction.actionOccurrenceId,
        option: requested.option,
      });
      return input.dispatchSelect({ control, option: requested.option, matchMode: requested.matchMode, transaction });
    },
    observe: async ({ attempt, transaction }) => input.captureState({
      phase: 'observe_select',
      attempt,
      control,
      option: requested.option,
      transaction,
    }),
    provePostcondition: async ({ observation }) => proveSelection(control, observation.data, expectedValue, {
      matchMode: input.matchMode,
      caseSensitive: input.caseSensitive !== false,
      expectPopupClose: input.expectPopupClose !== false,
      openedPopup,
    }),
    persist: async (transaction) => {
      if (typeof input.persistTransaction === 'function') await input.persistTransaction({ phase: 'select', transaction });
    },
  });
  context.selectionTransaction = selectionResult.transaction;
  await ledger.append({
    type: 'selection_outcome',
    phase: 'select',
    attemptStatus: 'canonical',
    outcome: selectionResult.outcome,
  });

  if (selectionResult.outcome?.status !== 'passed') {
    return resultEnvelope(context, {
      status: 'blocked',
      reason: selectionResult.outcome?.reason || 'dropdown_value_not_committed',
      shouldContinue: false,
      blockDependents: true,
    });
  }

  context.canonicalEvidence.selection = selectionResult.outcome.evidence;
  await transition(STATES.VALUE_COMMITTED, selectionResult.outcome.evidence);
  const hasValidationFailures = context.validations.some((item) => item.checked && item.matched === false);
  return resultEnvelope(context, {
    status: hasValidationFailures ? 'completed_with_validation_failures' : 'passed',
    reason: hasValidationFailures ? 'selection_committed_with_non_blocking_validation_failures' : 'dropdown_value_committed',
    shouldContinue: true,
    blockDependents: false,
  });
}

module.exports = {
  SCHEMA,
  STATES,
  MATCH_MODES,
  SUPPORTED_CONTROL_TYPES,
  normalizeObservation,
  popupCorrelation,
  proveOpen,
  inspectOptionOrder,
  resolveRequestedOption,
  proveSelection,
  createDropdownControl,
  createDropdownRuntimeTracker,
  executeDropdownTransaction,
};
