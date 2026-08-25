'use strict';

const fs = require('fs');
const path = require('path');

const {
  createProofContract,
} = require('./browserProofContract');
const {
  SNAPSHOT_SOURCE,
} = require('./browserSnapshotLifecycle');
const {
  createDropdownProtocol,
  createCalendarProtocol,
  createTimeProtocol,
  normalizeTime,
} = require('./controllerCompositeProtocols');
const {
  buildSemanticTargetRevealFunction,
} = require('./semanticTargetReveal');
const {
  buildBoundTextInputRevealFunction,
} = require('./semanticTextInputState');
const {
  buildBoundActivationRecoveryFunction,
} = require('./semanticActivationState');
const {
  detectDesignSystemSignature,
} = require('./controllerDesignSystemSignatures');

const ADAPTER_REGISTRY_VERSION = 'qaai-controller-typed-adapter-registry-v1';

const ADAPTER_KIND = Object.freeze({
  TEXT_INPUT: 'TEXT_INPUT',
  PASSWORD_INPUT: 'PASSWORD_INPUT',
  BUTTON_OR_LINK: 'BUTTON_OR_LINK',
  NATIVE_SELECT: 'NATIVE_SELECT',
  CUSTOM_SELECT: 'CUSTOM_SELECT',
  AUTOCOMPLETE: 'AUTOCOMPLETE',
  DATE: 'DATE',
  TIME: 'TIME',
  BOOLEAN: 'BOOLEAN',
  ACCORDION: 'ACCORDION',
  COLLECTION: 'COLLECTION',
  CONTEXT: 'CONTEXT',
  DIALOG: 'DIALOG',
  UPLOAD: 'UPLOAD',
  NAVIGATION: 'NAVIGATION',
  KEYBOARD: 'KEYBOARD',
  ASSERTION: 'ASSERTION',
  SYNCHRONIZATION: 'SYNCHRONIZATION',
  REVEAL: 'REVEAL',
  GENERIC: 'GENERIC',
});

const CLAIM = Object.freeze({
  SAME_OWNER_VALUE: 'same_owner_value',
  SAME_PASSWORD_OWNER: 'same_password_owner',
  PROTECTED_NON_EMPTY: 'protected_non_empty',
  FILL_ACKNOWLEDGED: 'fill_acknowledged',
  INPUT_EVENT_OBSERVED: 'input_event_observed',
  SUBMIT_ACTIONABLE: 'submit_actionable',
  AUTHORED_DESTINATION: 'authored_destination',
  NEXT_REQUIRED_CONTROL_ACTIONABLE: 'next_required_control_actionable',
  NEXT_AUTHORED_ACTION_CONTROL_ACTIONABLE: 'next_authored_action_control_actionable',
  EXACT_NAVIGATION_TARGET: 'exact_navigation_target',
  PAGE_TRANSITION_COMMITTED: 'page_transition_committed',
  ASSOCIATED_POPUP_OPEN: 'associated_popup_open',
  OWNER_SELECTED_VALUE: 'owner_selected_value',
  EXACT_OPTION_SELECTED: 'exact_option_selected',
  OWNER_STATE_COMMITTED: 'owner_state_committed',
  NORMALIZED_DATE_OWNER_VALUE: 'normalized_date_owner_value',
  NORMALIZED_TIME_OWNER_VALUE: 'normalized_time_owner_value',
  BOOLEAN_OWNER_STATE: 'boolean_owner_state',
  ACCORDION_OWNER_STATE: 'accordion_owner_state',
  TOOLTIP_VISIBLE: 'tooltip_visible',
  ACCESSIBLE_DESCRIPTION: 'accessible_description',
  UPLOAD_OWNER_STATE: 'upload_owner_state',
  DIALOG_STATE: 'dialog_state',
  CONTEXT_STATE: 'context_state',
  COLLECTION_ASSERTION: 'collection_assertion',
  ASSERTION_MATCHED: 'assertion_matched',
  WAIT_STATE_REACHED: 'wait_state_reached',
  TARGET_VISIBLE: 'target_visible',
});

class ControllerTypedAdapterError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ControllerTypedAdapterError';
    this.code = code;
    Object.assign(this, details);
  }
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function targetIdentityOf(operation, resolution) {
  return resolution?.target?.identity
    || resolution?.targetIdentity
    || operation?.targetIdentity
    || {};
}

function resolvedRef(resolution) {
  return clean(
    resolution?.target?.ref
      || resolution?.ref
      || resolution?.target?.reference,
  ) || null;
}

function resolvedInteractionRef(resolution) {
  return clean(
    resolution?.target?.interactionRef
      || resolution?.target?.triggerRef,
  ) || resolvedRef(resolution);
}

function roleToken(identity = {}) {
  return clean(identity.role).toLowerCase();
}

function controlTypeToken(identity = {}) {
  return clean(identity.controlType || identity.inputType || identity.type).toLowerCase();
}

function adapterHint(resolution = {}) {
  return clean(
    resolution.adapterKind
      || resolution.target?.adapterKind
      || resolution.target?.controlFamily,
  ).toUpperCase();
}

const STRATEGY_LADDERS = Object.freeze({
  [ADAPTER_KIND.NATIVE_SELECT]: [ADAPTER_KIND.NATIVE_SELECT, ADAPTER_KIND.CUSTOM_SELECT, ADAPTER_KIND.AUTOCOMPLETE],
  [ADAPTER_KIND.CUSTOM_SELECT]: [ADAPTER_KIND.CUSTOM_SELECT, ADAPTER_KIND.AUTOCOMPLETE, ADAPTER_KIND.TEXT_INPUT],
  [ADAPTER_KIND.AUTOCOMPLETE]: [ADAPTER_KIND.AUTOCOMPLETE, ADAPTER_KIND.CUSTOM_SELECT, ADAPTER_KIND.TEXT_INPUT],
  [ADAPTER_KIND.DATE]: [ADAPTER_KIND.DATE, ADAPTER_KIND.TEXT_INPUT],
  [ADAPTER_KIND.TIME]: [ADAPTER_KIND.TIME, ADAPTER_KIND.CUSTOM_SELECT, ADAPTER_KIND.TEXT_INPUT],
  [ADAPTER_KIND.BUTTON_OR_LINK]: [ADAPTER_KIND.BUTTON_OR_LINK, ADAPTER_KIND.KEYBOARD, ADAPTER_KIND.GENERIC],
  [ADAPTER_KIND.TEXT_INPUT]: [ADAPTER_KIND.TEXT_INPUT, ADAPTER_KIND.KEYBOARD],
});

function getNextLadderStrategy(currentKind, ladderIndex = 0) {
  const ladder = STRATEGY_LADDERS[currentKind] || [currentKind];
  const nextIndex = Number(ladderIndex || 0) + 1;
  if (nextIndex < ladder.length) {
    return { kind: ladder[nextIndex], ladderIndex: nextIndex };
  }
  return null;
}

function classifyLiveWidget(resolution = {}, operation = {}, context = {}) {
  const identity = targetIdentityOf(operation, resolution);
  const role = roleToken(identity);
  const controlType = controlTypeToken(identity);
  const tagName = String(identity.tagName || resolution.target?.tagName || '').toUpperCase();
  const attributes = identity.attributes || resolution.target?.attributes || {};
  const hasPopup = Boolean(attributes['aria-haspopup'] || attributes.haspopup || identity.ariaHasPopup || identity.hasPopup);
  const expanded = Boolean(attributes['aria-expanded'] === 'true' || attributes['aria-expanded'] === true || identity.ariaExpanded);
  const inputType = String(attributes.type || identity.type || controlType || '').toLowerCase();
  const type = clean(operation.type);
  // 1. Text / Password Input Family:
  if (['Fill', 'Type', 'Append', 'ClearAndType', 'TypeSequentially', 'Clear'].includes(type)) {
    if (inputType === 'password' || /password|passwd/i.test(identity.accessibleName || '')) {
      return ADAPTER_KIND.PASSWORD_INPUT;
    }
    if (inputType === 'date') return ADAPTER_KIND.DATE;
    if (inputType === 'time') return ADAPTER_KIND.TIME;
    return ADAPTER_KIND.TEXT_INPUT;
  }

  // 2. Temporal (Date / Time) Family:
  if (type === 'Date' || inputType === 'date' || role === 'datepicker') return ADAPTER_KIND.DATE;
  if (['Time', 'DateTime'].includes(type) || inputType === 'time') return ADAPTER_KIND.TIME;

  // 3. Design System Framework Signature Match:
  const dsSignature = detectDesignSystemSignature(identity, resolution);
  if (dsSignature && dsSignature.adapterKind && (type !== 'Click' || hasPopup || role === 'combobox')) {
    return dsSignature.adapterKind;
  }

  // 4. Select / Dropdown Family:
  if (['Select', 'SelectMultiple', 'MultiSelect'].includes(type) || (type !== 'Click' && (hasPopup || role === 'combobox'))) {
    if (tagName === 'SELECT') return ADAPTER_KIND.NATIVE_SELECT;
    if (role === 'searchbox' || /autocomplete|typeahead/.test(controlType) || /autocomplete|typeahead/.test(inputType)) {
      return ADAPTER_KIND.AUTOCOMPLETE;
    }
    if (['checkbox', 'radio', 'switch'].includes(role) || ['checkbox', 'radio', 'switch'].includes(controlType)) {
      return ADAPTER_KIND.BOOLEAN;
    }
    return ADAPTER_KIND.CUSTOM_SELECT;
  }

  // 5. Boolean (Checkbox / Radio / Switch):
  if (['Check', 'Uncheck', 'Radio'].includes(type) || ['checkbox', 'radio', 'switch'].includes(role)) {
    return ADAPTER_KIND.BOOLEAN;
  }

  // 6. Accordion (Expand / Collapse):
  if (['Expand', 'Collapse'].includes(type) || (expanded !== undefined && role === 'button' && (attributes['aria-controls'] || attributes['data-target']))) {
    return ADAPTER_KIND.ACCORDION;
  }

  // 7. Dialog:
  if (['Close', 'AcceptAlert', 'DismissAlert', 'TypeAlert'].includes(type) || role === 'dialog') {
    return ADAPTER_KIND.DIALOG;
  }

  // 8. Button or Link:
  if (['Click', 'DoubleClick', 'Submit', 'Download', 'Hover', 'RightClick'].includes(type) || ['button', 'link'].includes(role) || tagName === 'BUTTON' || tagName === 'A') {
    return ADAPTER_KIND.BUTTON_OR_LINK;
  }

  return null;
}

function inferAdapterKind(operation = {}, resolution = {}, context = {}) {
  if (operation.kind === 'assertion') {
    const role = roleToken(targetIdentityOf(operation, resolution));
    return ['table', 'grid', 'treegrid', 'list'].includes(role)
      ? ADAPTER_KIND.COLLECTION
      : ADAPTER_KIND.ASSERTION;
  }
  if (operation.kind === 'synchronization' || operation.type === 'WaitForState') {
    return ADAPTER_KIND.SYNCHRONIZATION;
  }
  if (context?.strategyOverride && Object.values(ADAPTER_KIND).includes(context.strategyOverride)) {
    return context.strategyOverride;
  }
  const identity = targetIdentityOf(operation, resolution);
  const role = roleToken(identity);
  const controlType = controlTypeToken(identity);
  const type = clean(operation.type);

  // The authored operation carries the durable semantic intent. A resolver
  // hint is an observation about the current DOM shape and may be stale after
  // a rerender (for example, a time combobox reported as a generic custom
  // select). Recognize strongly typed authored intent before accepting that
  // hint so the proof protocol remains aligned with the requested value.
  if (type === 'Select') {
    const authoredIdentity = operation.targetIdentity || {};
    const semanticTarget = clean([
      authoredIdentity.accessibleName,
      authoredIdentity.label,
      identity.accessibleName,
      identity.label,
      operation.target,
      ...(Array.isArray(operation.targetAliases) ? operation.targetAliases : []),
    ].filter(Boolean).join(' '));
    const selectedValue = operation.value
      ?? operation.selection?.value
      ?? operation.selection?.label;
    if (
      /\btime\b/i.test(semanticTarget)
      && !/\btime\s*zone\b|\btimezone\b/i.test(semanticTarget)
      && normalizeTime(selectedValue)
    ) {
      return ADAPTER_KIND.TIME;
    }
  }

  // Precedence 1: Stored winning recipe from KnowledgeBaseLocator (type-family guarded)
  if (context?.recipeAdapterKind && Object.values(ADAPTER_KIND).includes(context.recipeAdapterKind)) {
    if (['Date', 'DateTime'].includes(type) && context.recipeAdapterKind !== ADAPTER_KIND.DATE) {
      // Do not allow a generic button recipe to override a Date operation
    } else if (type === 'Time' && context.recipeAdapterKind !== ADAPTER_KIND.TIME) {
      // Do not allow a generic button recipe to override a Time operation
    } else if (['Fill', 'Type', 'Append', 'ClearAndType'].includes(type) && ![ADAPTER_KIND.TEXT_INPUT, ADAPTER_KIND.PASSWORD_INPUT].includes(context.recipeAdapterKind)) {
      // Do not allow a button recipe to override text input
    } else {
      return context.recipeAdapterKind;
    }
  }

  // Precedence 2: Live Runtime Classification from real DOM
  const liveClassification = classifyLiveWidget(resolution, operation, context);
  if (liveClassification && Object.values(ADAPTER_KIND).includes(liveClassification)) {
    return liveClassification;
  }

  const hint = context.ignoreResolvedAdapterHint === true ? '' : adapterHint(resolution);
  if (Object.values(ADAPTER_KIND).includes(hint)) return hint;

  if (['Navigate', 'GoBack', 'NavigateBack', 'GoForward', 'NavigateForward', 'Refresh', 'Reload'].includes(type)) return ADAPTER_KIND.NAVIGATION;
  if (type === 'Scroll') return ADAPTER_KIND.REVEAL;
  if (type === 'Upload') return ADAPTER_KIND.UPLOAD;
  if (['SwitchContext', 'SwitchFrame', 'SwitchTab', 'NewTab', 'CloseTab'].includes(type) || ['frame', 'browser_context'].includes(role)) return ADAPTER_KIND.CONTEXT;
  const targetLower = clean(
    identity.target ||
    identity.accessibleName ||
    identity.label ||
    operation.target ||
    operation.element ||
    operation.text ||
    operation.authoredAction ||
    operation.payload ||
    operation.targetIdentity?.label ||
    operation.targetIdentity?.accessibleName
  ).toLowerCase();
  const hasActiveNativeDialog = Boolean(
    context?.hasActiveNativeDialog ||
    context?.session?.activeNativeDialog ||
    context?.session?.liveCdp?.activeNativeDialog ||
    context?.session?.lastDialog ||
    context?.session?.liveCdp?.lastDialog
  );
  if (['Close', 'AcceptAlert', 'DismissAlert', 'TypeAlert'].includes(type) || role === 'dialog' || (['Fill', 'Type'].includes(type) && (/\b(?:prompt|alert|native\s*dialog)\b/i.test(targetLower) || hasActiveNativeDialog))) return ADAPTER_KIND.DIALOG;
  if (type === 'Date') return ADAPTER_KIND.DATE;
  if (['Time', 'DateTime'].includes(type)) return ADAPTER_KIND.TIME;
  if (['Select', 'SelectMultiple', 'MultiSelect'].includes(type)) {
    if (['searchbox'].includes(role) || /autocomplete|typeahead/.test(controlType)) return ADAPTER_KIND.AUTOCOMPLETE;
    if (['checkbox', 'radio', 'switch'].includes(role) || ['checkbox', 'radio', 'switch'].includes(controlType)) return ADAPTER_KIND.BOOLEAN;
    return ADAPTER_KIND.NATIVE_SELECT;
  }
  if (['PressKey', 'KeyPress', 'Press'].includes(type) || ['browser_press_key'].includes(operation.mutationTool)) return ADAPTER_KIND.KEYBOARD;
  if (['Navigate', 'GoBack', 'NavigateBack', 'GoForward', 'NavigateForward', 'Refresh', 'Reload'].includes(type)) return ADAPTER_KIND.NAVIGATION;
  if (['Fill', 'Type', 'Append', 'ClearAndType', 'TypeSequentially', 'Clear'].includes(type)) {
    return controlType === 'password' || /password|passwd/.test(clean(identity.accessibleName))
      ? ADAPTER_KIND.PASSWORD_INPUT
      : ADAPTER_KIND.TEXT_INPUT;
  }
  if (['Check', 'Uncheck', 'Radio'].includes(type)) return ADAPTER_KIND.BOOLEAN;
  if (['Expand', 'Collapse'].includes(type)) return ADAPTER_KIND.ACCORDION;
  if (['Print', 'Inspect', 'ReadAndPrint'].includes(type)) return ADAPTER_KIND.REVEAL;
  if (['table', 'grid', 'treegrid', 'list'].includes(role)) return ADAPTER_KIND.COLLECTION;
  if (['Click', 'DoubleClick', 'Submit', 'Download', 'Hover', 'ClickAndHold', 'RightClick', 'MiddleClick'].includes(type)
    || ['button', 'link'].includes(role)) return ADAPTER_KIND.BUTTON_OR_LINK;
  if (['checkbox', 'radio', 'switch'].includes(role)) return ADAPTER_KIND.BOOLEAN;
  return ADAPTER_KIND.GENERIC;
}

function valueFor(operation, context) {
  if (operation.valueRef) {
    if (typeof context?.resolveValueRef !== 'function') {
      throw new ControllerTypedAdapterError(
        'Value reference requires a runtime value resolver.',
        'CONTROLLER_ADAPTER_VALUE_RESOLVER_REQUIRED',
        { operationId: operation.operationId, valueRef: operation.valueRef },
      );
    }
    const resolved = context.resolveValueRef(operation.valueRef);
    if (resolved !== undefined && resolved !== null && resolved !== '') return resolved;
  }
  return operation.value;
}

function proof(id, alternatives) {
  return createProofContract({ id, alternatives });
}

function mutation(toolName, args, phaseId = 'action') {
  return Object.freeze({
    toolName,
    args: Object.freeze({ ...args }),
    phaseId,
  });
}

function phase(phaseId, kind, mutationValue, proofContract) {
  return Object.freeze({
    phaseId,
    kind,
    mutation: mutationValue,
    proofContract,
  });
}

function commonPlan(operation, adapterKind, details = {}) {
  return Object.freeze({
    schemaVersion: ADAPTER_REGISTRY_VERSION,
    adapterKind,
    operationId: operation.operationId,
    requiredSources: Object.freeze(details.requiredSources || [
      SNAPSHOT_SOURCE.BROWSER_SNAPSHOT,
      SNAPSHOT_SOURCE.DOM,
    ]),
    mutation: details.mutation || null,
    recoveryMutation: details.recoveryMutation || null,
    preDispatchMutation: details.preDispatchMutation || null,
    phases: Object.freeze(details.phases || []),
    protocol: details.protocol || null,
    proofContract: details.proofContract,
    proofMetadata: Object.freeze(details.proofMetadata || {}),
    recoveryOptions: Object.freeze(details.recoveryOptions || []),
    privacy: Object.freeze(details.privacy || { sensitive: false }),
  });
}

function planTextInput(operation, resolution, context) {
  const ref = resolvedRef(resolution);
  const isClear = operation.type === 'Clear';
  const isAppend = operation.type === 'Append';
  const value = isClear ? '' : valueFor(operation, context);
  const identity = targetIdentityOf(operation, resolution);
  const accessibleName = clean(
    identity.accessibleName
      || identity.label
      || operation.target,
  );
  return commonPlan(operation, ADAPTER_KIND.TEXT_INPUT, {
    preDispatchMutation: isClear ? null : mutation('browser_evaluate', {
      element: accessibleName || undefined,
      target: ref,
      function: buildBoundTextInputRevealFunction(),
    }, 'reveal-owner'),
    mutation: mutation('browser_type', {
      target: ref,
      text: value,
      element: accessibleName || undefined,
      clear: isClear ? true : undefined,
      append: isAppend ? true : undefined,
    }),
    proofContract: proof(`${operation.operationId}:text-input`, [
      { id: 'same-owner-readback', allOf: [CLAIM.SAME_OWNER_VALUE] },
    ]),
    proofMetadata: {
      expectedValue: value,
      exactOwnerRequired: true,
      exactOwnerRevealRequired: true,
      browserAcknowledgmentIsDeliveryOnly: true,
      isAppend,
      isClear,
    },
    recoveryOptions: ['REFRESH_SNAPSHOT', 'RERESOLVE_SAME_TARGET'],
  });
}

function planPasswordInput(operation, resolution, context) {
  const ref = resolvedRef(resolution);
  const value = valueFor(operation, context);
  return commonPlan(operation, ADAPTER_KIND.PASSWORD_INPUT, {
    // Same 'browser_fill' does-not-exist issue as planTextInput above.
    mutation: mutation('browser_type', { target: ref, text: value }),
    proofContract: proof(`${operation.operationId}:password-input`, [
      {
        id: 'protected-ack',
        allOf: [
          CLAIM.SAME_PASSWORD_OWNER,
          CLAIM.PROTECTED_NON_EMPTY,
          CLAIM.FILL_ACKNOWLEDGED,
          CLAIM.SUBMIT_ACTIONABLE,
        ],
      },
      {
        id: 'protected-input-event',
        allOf: [
          CLAIM.SAME_PASSWORD_OWNER,
          CLAIM.PROTECTED_NON_EMPTY,
          CLAIM.INPUT_EVENT_OBSERVED,
          CLAIM.SUBMIT_ACTIONABLE,
        ],
      },
    ]),
    proofMetadata: {
      exactOwnerRequired: true,
      plaintextReadbackForbidden: true,
      valueRef: operation.valueRef || null,
    },
    privacy: { sensitive: true, persistence: 'value_ref_and_protected_fingerprint_only' },
    requiredSources: [
      SNAPSHOT_SOURCE.PLAYWRIGHT,
      SNAPSHOT_SOURCE.DOM,
      SNAPSHOT_SOURCE.EVENT,
    ],
    recoveryOptions: ['REFRESH_SNAPSHOT', 'RERESOLVE_SAME_TARGET'],
  });
}

function planButton(operation, resolution, context = {}) {
  // browser_click_and_hold is not a real @playwright/mcp tool — there is
  // no native "hold for N ms" primitive. Dispatching synthetic
  // mousedown/mouseup DOM events via browser_evaluate (a tool that always
  // exists) reproduces the same interaction a real long-press produces,
  // since sites detect "held" state via those standard bubbling events
  // (e.g. LetCode's "Button Hold!" flips to "Button has been long
  // pressed" on exactly this sequence).
  const isClickAndHold = operation.type === 'ClickAndHold';
  const exactActivationRef = resolvedInteractionRef(resolution);
  const toolName = isClickAndHold ? 'ClickAndHold'
    : operation.type === 'DoubleClick' ? 'browser_click'
      : operation.type === 'Hover' ? 'browser_hover'
        : 'browser_click';
  const isHover = operation.type === 'Hover';
  const clickButton = operation.type === 'RightClick' ? 'right'
    : operation.type === 'MiddleClick' ? 'middle'
      : undefined;
  const opensPopup = clean(operation?.operationCheck?.kind).toLowerCase() === 'menu_opened';
  const ownerRole = clean(
    resolution?.target?.identity?.role
      || resolution?.target?.role,
  ).toLowerCase();
  const requiresOwnerCorrelatedPopup = opensPopup
    && ['combobox', 'searchbox', 'textbox'].includes(ownerRole);
  const recoveryEligible = operation.type === 'Click' && !opensPopup
    && ['button', 'link', 'menuitem', 'tab'].includes(ownerRole);
  const recoveryMutation = recoveryEligible
    ? mutation('browser_evaluate', {
      target: exactActivationRef,
      function: buildBoundActivationRecoveryFunction(),
    }, 'recovery-activation')
    : null;
  const recoveryRequested = context.controllerRecoveryDirective
    === 'ACTIVATE_PROVEN_UNCHANGED_TARGET';
  const mutationArgs = isClickAndHold
    ? {
      target: exactActivationRef,
      element: operation.target || operation.element || 'Button',
      toolName: 'ClickAndHold',
      duration: 2500,
    }
    : {
      target: exactActivationRef,
      ...(operation.type === 'DoubleClick' ? { doubleClick: true } : {}),
      ...(clickButton ? { button: clickButton } : {}),
    };
  return commonPlan(operation, ADAPTER_KIND.BUTTON_OR_LINK, {
    mutation: recoveryRequested && recoveryMutation
      ? recoveryMutation
      : mutation(toolName, mutationArgs),
    recoveryMutation: recoveryRequested ? null : recoveryMutation,
    proofContract: isHover
      ? proof(`${operation.operationId}:hover`, [
        { id: 'visual-tooltip', allOf: [CLAIM.TOOLTIP_VISIBLE] },
        { id: 'accessible-description', allOf: [CLAIM.ACCESSIBLE_DESCRIPTION] },
      ])
      : opensPopup
        ? proof(`${operation.operationId}:popup-open`, [
          { id: 'associated-popup', allOf: [CLAIM.ASSOCIATED_POPUP_OPEN] },
          ...(!requiresOwnerCorrelatedPopup
            ? [{
              id: 'next-authored-menu-control',
              allOf: [CLAIM.NEXT_AUTHORED_ACTION_CONTROL_ACTIONABLE],
            }]
            : []),
        ])
      : proof(`${operation.operationId}:activation`, [
        ...(isClickAndHold ? [{ id: 'button-long-pressed', allOf: [CLAIM.SAME_OWNER_VALUE] }] : []),
        { id: 'authored-destination', allOf: [CLAIM.AUTHORED_DESTINATION] },
        { id: 'next-required-control', allOf: [CLAIM.NEXT_REQUIRED_CONTROL_ACTIONABLE] },
        { id: 'navigation-target', allOf: [CLAIM.EXACT_NAVIGATION_TARGET] },
        { id: 'page-transition', allOf: [CLAIM.PAGE_TRANSITION_COMMITTED] },
        { id: 'dialog-state', allOf: [CLAIM.DIALOG_STATE] },
      ]),
    proofMetadata: isClickAndHold
      ? { expectedValue: 'Button has been long pressed' }
      : undefined,
    requiredSources: isHover
      ? [SNAPSHOT_SOURCE.DOM, SNAPSHOT_SOURCE.ACCESSIBILITY, SNAPSHOT_SOURCE.SCREENSHOT]
      : [SNAPSHOT_SOURCE.BROWSER_SNAPSHOT, SNAPSHOT_SOURCE.DOM, SNAPSHOT_SOURCE.ACCESSIBILITY],
    recoveryOptions: opensPopup
      ? [
        'REFRESH_SNAPSHOT',
        'RERESOLVE_SAME_TARGET',
        ...(requiresOwnerCorrelatedPopup
          ? ['REOPEN_ASSOCIATED_POPUP']
          : ['REQUEST_HEALER_PROPOSAL']),
      ]
      : ['REFRESH_SNAPSHOT', 'RERESOLVE_SAME_TARGET', 'REQUEST_HEALER_PROPOSAL'],
  });
}

function planNativeSelect(operation, resolution) {
  const accessibleName = clean(
    operation.element
    || operation.targetIdentity?.accessibleName
    || operation.targetIdentity?.label
    || operation.target
    || ''
  );
  return commonPlan(operation, ADAPTER_KIND.NATIVE_SELECT, {
    mutation: mutation('browser_select_option', {
      target: resolvedRef(resolution),
      selection: operation.selection,
      value: operation.value || operation.selection?.value || null,
      values: operation.values || (operation.value ? [operation.value] : null),
      element: accessibleName || undefined,
    }),
    proofContract: proof(`${operation.operationId}:native-select`, [
      {
        id: 'preexisting-owner-commit',
        allOf: [CLAIM.OWNER_SELECTED_VALUE, CLAIM.OWNER_STATE_COMMITTED],
      },
      { id: 'option-owner-commit', allOf: [CLAIM.EXACT_OPTION_SELECTED, CLAIM.OWNER_STATE_COMMITTED] },
    ]),
    proofMetadata: { selection: operation.selection, exactOwnerRequired: true },
    requiredSources: [SNAPSHOT_SOURCE.PLAYWRIGHT, SNAPSHOT_SOURCE.DOM, SNAPSHOT_SOURCE.ACCESSIBILITY],
    recoveryOptions: ['REFRESH_SNAPSHOT', 'RERESOLVE_SAME_TARGET'],
  });
}

function planCustomSelect(operation, resolution, adapterKind = ADAPTER_KIND.CUSTOM_SELECT) {
  const ownerRef = resolvedRef(resolution);
  const triggerRef = resolvedInteractionRef(resolution);
  const openProof = proof(`${operation.operationId}:popup-open`, [
    { id: 'associated-popup', allOf: ['associated_popup_open'] },
  ]);
  const selectionProof = proof(`${operation.operationId}:selection`, [
    {
      id: 'preexisting-owner-commit',
      allOf: [CLAIM.OWNER_SELECTED_VALUE, CLAIM.OWNER_STATE_COMMITTED],
    },
    { id: 'option-owner-commit', allOf: [CLAIM.EXACT_OPTION_SELECTED, CLAIM.OWNER_STATE_COMMITTED] },
  ]);
  const compositeProtocol = createDropdownProtocol({
    operation,
    ownerRef,
    triggerRef,
    autocomplete: adapterKind === ADAPTER_KIND.AUTOCOMPLETE,
    atomicSelection: adapterKind !== ADAPTER_KIND.AUTOCOMPLETE,
  });
  return commonPlan(operation, adapterKind, {
    phases: compositeProtocol.phases,
    protocol: compositeProtocol,
    proofContract: selectionProof,
    proofMetadata: {
      ownerRef,
      triggerRef,
      selection: operation.selection,
      popupOwnerCorrelationRequired: true,
      popupOpenAloneNeverCommits: true,
    },
    requiredSources: [SNAPSHOT_SOURCE.PLAYWRIGHT, SNAPSHOT_SOURCE.DOM, SNAPSHOT_SOURCE.ACCESSIBILITY],
    recoveryOptions: ['REFRESH_SNAPSHOT', 'RERESOLVE_SAME_TARGET', 'REOPEN_ASSOCIATED_POPUP'],
  });
}

function planTemporal(operation, resolution, adapterKind) {
  const claim = adapterKind === ADAPTER_KIND.DATE
    ? CLAIM.NORMALIZED_DATE_OWNER_VALUE
    : CLAIM.NORMALIZED_TIME_OWNER_VALUE;
  const kind = adapterKind === ADAPTER_KIND.DATE ? 'DATE' : 'TIME';
  const finalProof = proof(`${operation.operationId}:${kind.toLowerCase()}`, [
    { id: 'normalized-owner-readback', allOf: [claim] },
  ]);
  const compositeProtocol = adapterKind === ADAPTER_KIND.DATE
    ? createCalendarProtocol({
      operation,
      ownerRef: resolvedRef(resolution),
      triggerRef: resolvedInteractionRef(resolution),
      ownerAccessibleName: clean(
        targetIdentityOf(operation, resolution).accessibleName
          || targetIdentityOf(operation, resolution).label,
      ),
    })
    : createTimeProtocol({
      operation,
      ownerRef: resolvedRef(resolution),
      ownerAccessibleName: clean(
        targetIdentityOf(operation, resolution).accessibleName
          || targetIdentityOf(operation, resolution).label,
      ),
    });
  return commonPlan(operation, adapterKind, {
    phases: compositeProtocol.phases,
    protocol: compositeProtocol,
    proofContract: finalProof,
    proofMetadata: {
      expectedNormalizedValue: operation.value,
      exactOwnerRequired: true,
      popupOpenAloneNeverCommits: true,
    },
    requiredSources: [SNAPSHOT_SOURCE.PLAYWRIGHT, SNAPSHOT_SOURCE.DOM, SNAPSHOT_SOURCE.ACCESSIBILITY],
    recoveryOptions: ['REFRESH_SNAPSHOT', 'RERESOLVE_SAME_TARGET', 'RESTORE_PREREQUISITE_VALUE'],
  });
}

function planBoolean(operation, resolution) {
  const expected = operation.type === 'Uncheck' ? false : true;
  return commonPlan(operation, ADAPTER_KIND.BOOLEAN, {
    mutation: mutation(
      'browser_click',
      { target: resolvedRef(resolution) },
    ),
    proofContract: proof(`${operation.operationId}:boolean`, [
      { id: 'same-owner-state', allOf: [CLAIM.BOOLEAN_OWNER_STATE] },
    ]),
    proofMetadata: { expected, exactOwnerRequired: true },
    recoveryOptions: ['REFRESH_SNAPSHOT', 'RERESOLVE_SAME_TARGET'],
  });
}

function planAccordion(operation, resolution) {
  return commonPlan(operation, ADAPTER_KIND.ACCORDION, {
    mutation: mutation('browser_click', { target: resolvedRef(resolution) }),
    proofContract: proof(`${operation.operationId}:accordion`, [
      { id: 'same-owner-expanded-state', allOf: [CLAIM.ACCORDION_OWNER_STATE] },
    ]),
    proofMetadata: { expectedExpanded: operation.type !== 'Collapse', exactOwnerRequired: true },
    recoveryOptions: ['REFRESH_SNAPSHOT', 'RERESOLVE_SAME_TARGET'],
  });
}

function ensureSyntheticUploadFixture(rawFileName) {
  const cleanName = String(rawFileName || 'sample_document.pdf').replace(/^["']|["']$/g, '').trim();
  const baseName = path.basename(cleanName) || 'sample_document.pdf';
  const ext = path.extname(baseName).toLowerCase() || '.pdf';
  
  if (fs.existsSync(cleanName)) {
    return cleanName;
  }
  
  const fixturesDir = path.resolve(__dirname, '../../playwright/test-results/fixtures');
  if (!fs.existsSync(fixturesDir)) {
    fs.mkdirSync(fixturesDir, { recursive: true });
  }
  
  const targetPath = path.join(fixturesDir, baseName);
  if (fs.existsSync(targetPath)) {
    return targetPath;
  }
  
  if (ext === '.pdf') {
    const pdfContent = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>>>endobj\nxref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n0000000052 00000 n\n0000000101 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n178\n%%EOF';
    fs.writeFileSync(targetPath, pdfContent, 'binary');
  } else if (ext === '.csv') {
    const csvContent = 'id,name,email,amount,status\n1,Test User,testuser@testqaai.com,150.00,COMPLETED\n2,Sample Order,sample@testqaai.com,275.50,PENDING\n';
    fs.writeFileSync(targetPath, csvContent, 'utf8');
  } else if (ext === '.png') {
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    fs.writeFileSync(targetPath, Buffer.from(pngBase64, 'base64'));
  } else if (ext === '.json') {
    fs.writeFileSync(targetPath, JSON.stringify({ test: true, createdAt: new Date().toISOString() }, null, 2), 'utf8');
  } else {
    fs.writeFileSync(targetPath, `Sample test content for ${baseName}\nCreated at: ${new Date().toISOString()}\n`, 'utf8');
  }
  
  return targetPath;
}

function planUpload(operation, resolution, context) {
  const rawFile = valueFor(operation, context) || operation.value || operation.targetIdentity?.value || 'sample_document.pdf';
  const resolvedFilePath = ensureSyntheticUploadFixture(rawFile);
  return commonPlan(operation, ADAPTER_KIND.UPLOAD, {
    mutation: mutation('browser_file_upload', {
      target: resolvedRef(resolution),
      files: resolvedFilePath,
    }),
    proofContract: proof(`${operation.operationId}:upload`, [
      { id: 'same-owner-files', allOf: [CLAIM.UPLOAD_OWNER_STATE] },
    ]),
    proofMetadata: { exactOwnerRequired: true, filePath: resolvedFilePath },
    recoveryOptions: ['REFRESH_SNAPSHOT', 'RERESOLVE_SAME_TARGET'],
  });
}

function planNavigation(operation) {
  let sdkToolName = 'browser_navigate';
  if (['GoBack', 'NavigateBack'].includes(operation.type)) sdkToolName = 'browser_go_back';
  if (['GoForward', 'NavigateForward'].includes(operation.type)) sdkToolName = 'browser_go_forward';
  if (['Refresh', 'Reload'].includes(operation.type)) sdkToolName = 'browser_reload';

  const isDirectNavigate = operation.type === 'Navigate';
  const navUrl = clean(operation.value || operation.destination || operation.targetIdentity?.label || operation.targetIdentity?.accessibleName || operation.target || '');

  return commonPlan(operation, ADAPTER_KIND.NAVIGATION, {
    mutation: mutation(sdkToolName, { url: navUrl }),
    proofContract: proof(`${operation.operationId}:navigation`, [
      { id: 'exact-url', allOf: [CLAIM.EXACT_NAVIGATION_TARGET] },
      { id: 'authored-destination', allOf: [CLAIM.AUTHORED_DESTINATION] },
      { id: 'next-required-control', allOf: [CLAIM.NEXT_REQUIRED_CONTROL_ACTIONABLE] },
    ]),
    requiredSources: [SNAPSHOT_SOURCE.BROWSER_SNAPSHOT, SNAPSHOT_SOURCE.DOM],
    recoveryOptions: ['REFRESH_SNAPSHOT'],
  });
}

function planObservation(operation, adapterKind) {
  const claim = adapterKind === ADAPTER_KIND.COLLECTION
    ? CLAIM.COLLECTION_ASSERTION
    : operation.kind === 'synchronization'
      ? CLAIM.WAIT_STATE_REACHED
      : CLAIM.ASSERTION_MATCHED;
  return commonPlan(operation, adapterKind, {
    proofContract: proof(`${operation.operationId}:observation`, [
      { id: 'authored-observation', allOf: [claim] },
    ]),
    requiredSources: [SNAPSHOT_SOURCE.BROWSER_SNAPSHOT, SNAPSHOT_SOURCE.DOM, SNAPSHOT_SOURCE.ACCESSIBILITY],
    recoveryOptions: ['REFRESH_SNAPSHOT'],
  });
}

function planKeyboard(operation) {
  const key = clean(operation.key || operation.value || operation.target || 'Tab');
  const accessibleName = clean(
    operation.element
    || operation.targetIdentity?.accessibleName
    || operation.targetIdentity?.label
    || operation.target
    || ''
  );
  return commonPlan(operation, ADAPTER_KIND.KEYBOARD, {
    mutation: mutation('browser_press_key', {
      key,
      element: accessibleName || undefined,
      toolName: 'PressKey',
    }),
    proofContract: proof(`${operation.operationId}:keyboard`, [
      { id: 'next-required-control', allOf: [CLAIM.NEXT_REQUIRED_CONTROL_ACTIONABLE] },
    ]),
    proofMetadata: {
      observationFirst: false,
      exactOwnerRequired: false,
    },
    recoveryOptions: ['REFRESH_SNAPSHOT'],
  });
}

function planReveal(operation) {
  const identity = operation.targetIdentity || {};
  const label = clean(
    operation.element
    || identity.accessibleName
    || identity.label
    || operation.target,
  );
  return commonPlan(operation, ADAPTER_KIND.REVEAL, {
    mutation: mutation('browser_evaluate', {
      element: label,
      target: label,
      toolName: 'Print',
      expected: operation.expected || operation.authoredText || label,
      function: buildSemanticTargetRevealFunction({
        label,
        roleHints: [identity.role, 'region', 'group', 'heading']
          .map(clean)
          .filter(Boolean),
        semanticTarget: {
          kind: 'utility_reveal',
          bindRuntimeAlias: false,
        },
      }),
    }),
    proofContract: proof(`${operation.operationId}:reveal`, [
      { id: 'target-visible', allOf: [CLAIM.TARGET_VISIBLE] },
      { id: 'next-required-control', allOf: [CLAIM.NEXT_REQUIRED_CONTROL_ACTIONABLE] },
    ]),
    proofMetadata: {
      observationFirst: false,
      utilityMutation: true,
      exactOwnerRequired: false,
    },
    recoveryOptions: ['REFRESH_SNAPSHOT', 'RERESOLVE_SAME_TARGET', 'REQUEST_HEALER_PROPOSAL'],
  });
}

function planGeneric(operation, resolution) {
  return commonPlan(operation, ADAPTER_KIND.GENERIC, {
    mutation: mutation('browser_click', { target: resolvedRef(resolution) }),
    proofContract: proof(`${operation.operationId}:generic`, [
      { id: 'authored-destination', allOf: [CLAIM.AUTHORED_DESTINATION] },
      { id: 'next-required-control', allOf: [CLAIM.NEXT_REQUIRED_CONTROL_ACTIONABLE] },
    ]),
    recoveryOptions: ['REFRESH_SNAPSHOT', 'RERESOLVE_SAME_TARGET', 'REQUEST_CRITIC_PROPOSAL'],
  });
}

function createTypedAdapterPlan({ operation, resolution = {}, context = {} } = {}) {
  if (!operation?.operationId || !operation?.actionOccurrenceId) {
    throw new ControllerTypedAdapterError(
      'Typed adapter planning requires OperationContractV2 identity.',
      'CONTROLLER_ADAPTER_OPERATION_IDENTITY_REQUIRED',
    );
  }
  const kind = inferAdapterKind(operation, resolution, context);
  switch (kind) {
    case ADAPTER_KIND.TEXT_INPUT:
      return planTextInput(operation, resolution, context);
    case ADAPTER_KIND.PASSWORD_INPUT:
      return planPasswordInput(operation, resolution, context);
    case ADAPTER_KIND.KEYBOARD:
      return planKeyboard(operation);
    case ADAPTER_KIND.BUTTON_OR_LINK:
      return planButton(operation, resolution, context);
    case ADAPTER_KIND.NATIVE_SELECT:
      return planNativeSelect(operation, resolution);
    case ADAPTER_KIND.CUSTOM_SELECT:
    case ADAPTER_KIND.AUTOCOMPLETE:
      return planCustomSelect(operation, resolution, kind);
    case ADAPTER_KIND.DATE:
    case ADAPTER_KIND.TIME:
      return planTemporal(operation, resolution, kind);
    case ADAPTER_KIND.BOOLEAN:
      return planBoolean(operation, resolution);
    case ADAPTER_KIND.ACCORDION:
      return planAccordion(operation, resolution);
    case ADAPTER_KIND.UPLOAD:
      return planUpload(operation, resolution, context);
    case ADAPTER_KIND.NAVIGATION:
      return planNavigation(operation);
    case ADAPTER_KIND.ASSERTION:
    case ADAPTER_KIND.SYNCHRONIZATION:
    case ADAPTER_KIND.COLLECTION:
      return planObservation(operation, kind);
    case ADAPTER_KIND.REVEAL:
      return planReveal(operation);
    case ADAPTER_KIND.DIALOG: {
      const isDismiss = operation.type === 'DismissAlert' || operation.type === 'Close';
      const promptVal = operation.value || operation.targetIdentity?.value || null;
      if (['Fill', 'Type', 'TypeAlert'].includes(operation.type) && promptVal) {
        return commonPlan(operation, kind, {
          mutation: mutation('browser_handle_dialog', {
            accept: true,
            promptText: String(promptVal),
          }),
          proofContract: proof(`${operation.operationId}:dialog`, [
            { id: 'dialog-state', allOf: [CLAIM.DIALOG_STATE] },
          ]),
          recoveryOptions: ['REFRESH_SNAPSHOT'],
        });
      }
      return commonPlan(operation, kind, {
        mutation: mutation('browser_handle_dialog', {
          accept: !isDismiss,
          ...(promptVal ? { promptText: String(promptVal) } : {}),
        }),
        proofContract: proof(`${operation.operationId}:dialog`, [
          { id: 'dialog-state', allOf: [CLAIM.DIALOG_STATE] },
        ]),
        recoveryOptions: ['REFRESH_SNAPSHOT'],
      });
    }
    case ADAPTER_KIND.CONTEXT: {
      let mutTool = 'browser_tabs';
      let mutArgs = { action: 'select', target: resolvedRef(resolution) };
      if (operation.type === 'SwitchTab') {
        mutTool = 'SwitchTab';
        mutArgs = { target: operation.element || operation.target || 'New Tab' };
      } else if (operation.type === 'CloseTab') {
        mutTool = 'CloseTab';
        mutArgs = { target: operation.element || operation.target || 'Child Window' };
      } else if (operation.type === 'NewTab') {
        mutTool = 'NewTab';
        mutArgs = { url: operation.value || operation.url || '' };
      } else if (operation.type === 'SwitchFrame') {
        mutTool = 'SwitchFrame';
        mutArgs = { target: operation.element || operation.target || '' };
      }
      return commonPlan(operation, kind, {
        mutation: mutation(mutTool, mutArgs),
        proofContract: proof(`${operation.operationId}:context`, [
          { id: 'context-state', allOf: [CLAIM.CONTEXT_STATE] },
        ]),
        recoveryOptions: ['REFRESH_SNAPSHOT'],
      });
    }
    default:
      return planGeneric(operation, resolution);
  }
}

module.exports = {
  ADAPTER_REGISTRY_VERSION,
  ADAPTER_KIND,
  CLAIM,
  STRATEGY_LADDERS,
  ControllerTypedAdapterError,
  inferAdapterKind,
  classifyLiveWidget,
  getNextLadderStrategy,
  detectDesignSystemSignature,
  ensureSyntheticUploadFixture,
  createTypedAdapterPlan,
};
