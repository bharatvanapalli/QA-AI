'use strict';

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

  const hint = context.ignoreResolvedAdapterHint === true ? '' : adapterHint(resolution);
  if (Object.values(ADAPTER_KIND).includes(hint)) return hint;

  if (['Navigate', 'GoBack', 'GoForward', 'Refresh'].includes(type)) return ADAPTER_KIND.NAVIGATION;
  if (type === 'Scroll') return ADAPTER_KIND.REVEAL;
  if (type === 'Upload') return ADAPTER_KIND.UPLOAD;
  if (['SwitchContext'].includes(type) || ['frame', 'browser_context'].includes(role)) return ADAPTER_KIND.CONTEXT;
  if (type === 'Close' || role === 'dialog') return ADAPTER_KIND.DIALOG;
  if (type === 'Date') return ADAPTER_KIND.DATE;
  if (['Time', 'DateTime'].includes(type)) return ADAPTER_KIND.TIME;
  if (type === 'Select') {
    if (['select', 'select-one', 'native_select'].includes(controlType)) return ADAPTER_KIND.NATIVE_SELECT;
    if (['searchbox'].includes(role) || /autocomplete|typeahead/.test(controlType)) return ADAPTER_KIND.AUTOCOMPLETE;
    return ADAPTER_KIND.CUSTOM_SELECT;
  }
  if (['Fill', 'Type', 'Clear'].includes(type)) {
    return controlType === 'password' || /password|passwd/.test(clean(identity.accessibleName))
      ? ADAPTER_KIND.PASSWORD_INPUT
      : ADAPTER_KIND.TEXT_INPUT;
  }
  if (['Check', 'Uncheck', 'Radio'].includes(type)) return ADAPTER_KIND.BOOLEAN;
  if (['Expand', 'Collapse'].includes(type)) return ADAPTER_KIND.ACCORDION;
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
  const value = operation.type === 'Clear' ? '' : valueFor(operation, context);
  const identity = targetIdentityOf(operation, resolution);
  const accessibleName = clean(
    identity.accessibleName
      || identity.label
      || operation.target,
  );
  return commonPlan(operation, ADAPTER_KIND.TEXT_INPUT, {
    preDispatchMutation: mutation('browser_evaluate', {
      element: accessibleName || undefined,
      target: ref,
      function: buildBoundTextInputRevealFunction(),
    }, 'reveal-owner'),
    // 'browser_fill' is not a real tool on the installed @playwright/mcp
    // server, so every Clear/Fill dispatch using it was transport-rejected
    // with "Tool \"browser_fill\" not found" and silently left the field
    // untouched. browser_type IS real, and controllerMcpRuntimeAdapter.js's
    // transport() already has a dedicated isClearOp bypass (triggered by
    // args.text === '') that drives the live-CDP page directly via
    // page.evaluate — more reliable than routing through the MCP tool's
    // own ref resolution. Emitting browser_type with an empty string here
    // is what makes THAT bypass trigger; do not swap in a different tool
    // name/arg shape for Clear or it stops matching isClearOp entirely.
    mutation: mutation('browser_type', { target: ref, text: value, element: accessibleName || undefined }),
    proofContract: proof(`${operation.operationId}:text-input`, [
      { id: 'same-owner-readback', allOf: [CLAIM.SAME_OWNER_VALUE] },
    ]),
    proofMetadata: {
      expectedValue: value,
      exactOwnerRequired: true,
      exactOwnerRevealRequired: true,
      browserAcknowledgmentIsDeliveryOnly: true,
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
  const toolName = isClickAndHold ? 'browser_evaluate'
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
      function: `async (el) => {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        await new Promise((resolve) => setTimeout(resolve, 600));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        return { ok: true };
      }`,
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
        { id: 'authored-destination', allOf: [CLAIM.AUTHORED_DESTINATION] },
        { id: 'next-required-control', allOf: [CLAIM.NEXT_REQUIRED_CONTROL_ACTIONABLE] },
        { id: 'navigation-target', allOf: [CLAIM.EXACT_NAVIGATION_TARGET] },
        { id: 'page-transition', allOf: [CLAIM.PAGE_TRANSITION_COMMITTED] },
      ]),
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
  return commonPlan(operation, ADAPTER_KIND.NATIVE_SELECT, {
    mutation: mutation('browser_select_option', {
      target: resolvedRef(resolution),
      selection: operation.selection,
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
      expected ? 'browser_check' : 'browser_uncheck',
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

function planUpload(operation, resolution, context) {
  return commonPlan(operation, ADAPTER_KIND.UPLOAD, {
    mutation: mutation('browser_file_upload', {
      target: resolvedRef(resolution),
      files: valueFor(operation, context),
    }),
    proofContract: proof(`${operation.operationId}:upload`, [
      { id: 'same-owner-files', allOf: [CLAIM.UPLOAD_OWNER_STATE] },
    ]),
    proofMetadata: { exactOwnerRequired: true },
    recoveryOptions: ['REFRESH_SNAPSHOT', 'RERESOLVE_SAME_TARGET'],
  });
}

function planNavigation(operation) {
  let sdkToolName = 'browser_navigate';
  if (operation.type === 'GoBack') sdkToolName = 'browser_go_back';
  if (operation.type === 'GoForward') sdkToolName = 'browser_go_forward';
  if (operation.type === 'Refresh') sdkToolName = 'browser_reload';

  const isDirectNavigate = operation.type === 'Navigate';

  return commonPlan(operation, ADAPTER_KIND.NAVIGATION, {
    mutation: mutation(sdkToolName, { url: operation.value || operation.destination || operation.targetIdentity?.label || operation.targetIdentity?.accessibleName || '' }),
    // GoBack/GoForward/Refresh have no authored destination URL and can't
    // be checked against CLAIM.EXACT_NAVIGATION_TARGET, but they still need
    // AT LEAST one proof alternative — an empty alternatives array is a
    // structurally invalid proof contract (BROWSER_PROOF_CONTRACT_INVALID),
    // so every GoBack failed before ever getting to the browser at all.
    // next-required-control (does the next authored step's target become
    // resolvable) is the one alternative that still applies without a URL.
    proofContract: proof(`${operation.operationId}:navigation`, isDirectNavigate ? [
      { id: 'authored-destination', allOf: [CLAIM.AUTHORED_DESTINATION] },
      { id: 'next-required-control', allOf: [CLAIM.NEXT_REQUIRED_CONTROL_ACTIONABLE] },
      { id: 'exact-url', allOf: [CLAIM.EXACT_NAVIGATION_TARGET] },
    ] : [
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

function planReveal(operation) {
  const identity = operation.targetIdentity || {};
  const label = clean(
    identity.accessibleName
      || identity.label
      || operation.target,
  );
  return commonPlan(operation, ADAPTER_KIND.REVEAL, {
    mutation: mutation('browser_evaluate', {
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
      observationFirst: true,
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
    case ADAPTER_KIND.DIALOG:
      return commonPlan(operation, kind, {
        mutation: mutation('browser_handle_dialog', { action: operation.type === 'Close' ? 'dismiss' : 'accept' }),
        proofContract: proof(`${operation.operationId}:dialog`, [
          { id: 'dialog-state', allOf: [CLAIM.DIALOG_STATE] },
        ]),
        recoveryOptions: ['REFRESH_SNAPSHOT'],
      });
    case ADAPTER_KIND.CONTEXT:
      return commonPlan(operation, kind, {
        mutation: mutation('browser_tabs', { action: 'select', target: resolvedRef(resolution) }),
        proofContract: proof(`${operation.operationId}:context`, [
          { id: 'context-state', allOf: [CLAIM.CONTEXT_STATE] },
        ]),
        recoveryOptions: ['REFRESH_SNAPSHOT'],
      });
    default:
      return planGeneric(operation, resolution);
  }
}

module.exports = {
  ADAPTER_REGISTRY_VERSION,
  ADAPTER_KIND,
  CLAIM,
  ControllerTypedAdapterError,
  inferAdapterKind,
  createTypedAdapterPlan,
};
