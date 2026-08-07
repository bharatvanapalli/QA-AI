'use strict';

const universalControlModel = require('./universalControlModel');

const SCHEMA = 'qaai_control_adapter_registry_v1';

const ACTION_ALIASES = Object.freeze({
  enter: 'fill',
  input: 'fill',
  set: 'fill',
  choose: 'select',
  pick: 'select',
  calendar: 'date',
  datepicker: 'date',
  setdate: 'date',
  keypress: 'press',
  keyboard: 'press',
  mouseover: 'hover',
  selectradio: 'radio',
  ensureexpanded: 'expand',
  ensurecollapsed: 'collapse',
  attach: 'upload',
  fileupload: 'upload',
  draganddrop: 'drag_drop',
  waitfor: 'wait',
  waitforevent: 'wait',
});

const CONTEXT_KINDS = new Set([
  'iframe',
  'shadow_dom',
  'new_tab',
  'new_window',
  'native_dialog',
  'download',
]);

function adapter(definition) {
  return Object.freeze({
    schema: SCHEMA,
    websiteNeutral: true,
    executionSurface: 'playwright',
    contextBoundaries: Object.freeze(['main_frame', 'iframe', 'shadow_dom']),
    ...definition,
    controlTypes: Object.freeze([...(definition.controlTypes || [])]),
    actions: Object.freeze([...(definition.actions || [])]),
    stateMachine: Object.freeze([...(definition.stateMachine || [])]),
    requiredNodes: Object.freeze([...(definition.requiredNodes || [])]),
    evidenceChannels: Object.freeze([...(definition.evidenceChannels || [])]),
    postconditions: Object.freeze([...(definition.postconditions || [])]),
    contextBoundaries: Object.freeze([...(definition.contextBoundaries || ['main_frame', 'iframe', 'shadow_dom'])]),
  });
}

const CONTROL_ADAPTERS = Object.freeze([
  adapter({
    id: 'text-input-v1',
    family: 'input',
    controlTypes: ['textbox', 'password', 'contenteditable', 'spinbutton'],
    actions: ['fill', 'type', 'press', 'click', 'hover'],
    stateMachine: ['READY', 'FOCUSED', 'VALUE_DISPATCHED', 'VALUE_COMMITTED'],
    requiredNodes: ['ownerElement', 'interactionElement', 'valueElement'],
    evidenceChannels: ['owner_identity', 'playwright_actionability', 'input_event', 'owner_control_value'],
    postconditions: ['value_exact', 'value_ref_populated', 'focus_exact'],
  }),
  adapter({
    id: 'native-select-v1',
    family: 'choice',
    controlTypes: ['native_select'],
    actions: ['select', 'click', 'hover'],
    stateMachine: ['READY', 'SELECTION_DISPATCHED', 'VALUE_COMMITTED'],
    requiredNodes: ['ownerElement', 'interactionElement', 'valueElement'],
    evidenceChannels: ['owner_identity', 'playwright_actionability', 'input_event', 'change_event', 'owner_selected_value'],
    postconditions: ['selection_exact', 'selection_contains'],
  }),
  adapter({
    id: 'popup-choice-v1',
    family: 'choice',
    controlTypes: ['combobox', 'listbox', 'option', 'menuitem', 'autocomplete', 'multiselect'],
    actions: ['fill', 'type', 'select', 'press', 'click', 'hover'],
    stateMachine: ['CLOSED', 'OPENING', 'OPEN', 'SELECTING', 'VALUE_COMMITTED'],
    requiredNodes: ['ownerElement', 'interactionElement', 'popupElement', 'optionContainer', 'valueElement'],
    evidenceChannels: ['owner_identity', 'aria_expanded', 'popup_relationship', 'visible_options', 'actual_event_target', 'owner_selected_value'],
    postconditions: ['popup_open_exact', 'option_list_exact', 'selection_exact', 'selection_contains'],
  }),
  adapter({
    id: 'date-control-v1',
    family: 'date',
    controlTypes: ['date_input', 'date_picker'],
    actions: ['date', 'fill', 'click', 'press', 'hover'],
    stateMachine: ['CLOSED', 'OPENING', 'OPEN', 'POSITIONING', 'DAY_SELECTING', 'VALUE_COMMITTED'],
    requiredNodes: ['ownerElement', 'interactionElement', 'valueElement'],
    evidenceChannels: ['owner_identity', 'popup_relationship', 'calendar_grid', 'actual_event_target', 'owner_control_value'],
    postconditions: ['date_exact'],
  }),
  adapter({
    id: 'time-control-v1',
    family: 'time',
    controlTypes: ['time_input', 'time_picker'],
    actions: ['time', 'fill', 'select', 'click', 'press', 'hover'],
    stateMachine: ['CLOSED', 'OPENING', 'OPEN', 'TIME_SELECTING', 'VALUE_COMMITTED'],
    requiredNodes: ['ownerElement', 'interactionElement', 'valueElement'],
    evidenceChannels: ['owner_identity', 'popup_relationship', 'visible_options', 'actual_event_target', 'owner_control_value'],
    postconditions: ['time_exact', 'selection_contains'],
  }),
  adapter({
    id: 'toggle-control-v1',
    family: 'toggle',
    controlTypes: ['checkbox', 'radio', 'switch'],
    actions: ['check', 'uncheck', 'radio', 'select', 'click', 'press', 'hover'],
    stateMachine: ['READY', 'STATE_DISPATCHED', 'STATE_COMMITTED'],
    requiredNodes: ['ownerElement', 'interactionElement', 'valueElement'],
    evidenceChannels: ['owner_identity', 'playwright_actionability', 'input_event', 'change_event', 'checked_state'],
    postconditions: ['checked_exact', 'selected_exact'],
  }),
  adapter({
    id: 'disclosure-control-v1',
    family: 'container',
    controlTypes: ['accordion', 'tab', 'tree'],
    actions: ['expand', 'collapse', 'select', 'click', 'press', 'hover'],
    stateMachine: ['READY', 'STATE_DISPATCHED', 'STATE_COMMITTED'],
    requiredNodes: ['ownerElement', 'interactionElement', 'valueElement'],
    evidenceChannels: ['owner_identity', 'aria_expanded', 'aria_selected', 'owned_region_visibility'],
    postconditions: ['expanded_exact', 'selected_exact', 'target_visible_exact'],
  }),
  adapter({
    id: 'command-control-v1',
    family: 'command',
    controlTypes: ['button', 'link'],
    actions: ['click', 'press', 'hover'],
    stateMachine: ['READY', 'DISPATCHED', 'EFFECT_OBSERVED'],
    requiredNodes: ['ownerElement', 'interactionElement'],
    evidenceChannels: ['owner_identity', 'playwright_actionability', 'actual_event_target', 'declared_postcondition'],
    postconditions: ['navigation_exact', 'page_ready_exact', 'declared_effect_exact'],
  }),
  adapter({
    id: 'overlay-control-v1',
    family: 'container',
    controlTypes: ['dialog', 'menu', 'tooltip'],
    actions: ['click', 'press', 'hover', 'expand', 'collapse'],
    stateMachine: ['CLOSED', 'OPENING', 'OPEN', 'CLOSING', 'CLOSED'],
    requiredNodes: ['ownerElement', 'interactionElement'],
    evidenceChannels: ['owner_identity', 'aria_relationship', 'visible_overlay', 'focus_scope'],
    postconditions: ['visible_exact', 'hidden_exact', 'tooltip_exact'],
  }),
  adapter({
    id: 'grid-table-v1',
    family: 'grid',
    controlTypes: ['table', 'grid'],
    actions: ['click', 'select', 'press', 'hover'],
    stateMachine: ['READY', 'ROW_SCOPED', 'CELL_SCOPED', 'DISPATCHED', 'ROW_STATE_COMMITTED'],
    requiredNodes: ['ownerElement', 'interactionElement'],
    evidenceChannels: ['owner_identity', 'row_anchor', 'cell_identity', 'actual_event_target', 'scoped_collection'],
    postconditions: ['row_value_exact', 'cell_value_exact', 'count_exact', 'ordered_list_exact'],
  }),
  adapter({
    id: 'file-transfer-v1',
    family: 'upload',
    controlTypes: ['file_input', 'download'],
    actions: ['upload', 'download', 'click'],
    stateMachine: ['READY', 'TRANSFER_DISPATCHED', 'TRANSFER_EVENT_OBSERVED', 'TRANSFER_COMMITTED'],
    requiredNodes: ['ownerElement', 'interactionElement'],
    evidenceChannels: ['owner_identity', 'file_chooser_event', 'download_event', 'filename_readback'],
    postconditions: ['upload_exact', 'download_exact'],
    contextBoundaries: ['main_frame', 'iframe', 'shadow_dom', 'browser_event'],
  }),
  adapter({
    id: 'drag-drop-v1',
    family: 'rich',
    controlTypes: ['drag_source', 'drop_target'],
    actions: ['drag', 'drop', 'drag_drop', 'hover'],
    stateMachine: ['READY', 'POINTER_DOWN', 'DRAGGING', 'DROPPED', 'EFFECT_OBSERVED'],
    requiredNodes: ['ownerElement', 'interactionElement'],
    evidenceChannels: ['source_identity', 'target_identity', 'pointer_event_path', 'drop_event', 'declared_postcondition'],
    postconditions: ['drop_effect_exact'],
  }),
  adapter({
    id: 'browser-context-v1',
    family: 'browser_context',
    controlTypes: [],
    contextKinds: ['iframe', 'shadow_dom', 'new_tab', 'new_window', 'native_dialog', 'download'],
    actions: ['enter', 'switch', 'accept', 'dismiss', 'wait', 'download', 'click'],
    stateMachine: ['READY', 'EVENT_ARMED', 'DISPATCHED', 'CONTEXT_BOUND', 'EFFECT_OBSERVED'],
    requiredNodes: [],
    evidenceChannels: ['browser_event', 'frame_path', 'shadow_path', 'page_identity', 'dialog_or_download_payload'],
    postconditions: ['context_exact', 'event_exact'],
    contextBoundaries: ['main_frame', 'iframe', 'shadow_dom', 'browser_event'],
  }),
  adapter({
    id: 'canvas-visual-v1',
    family: 'visual',
    controlTypes: ['canvas'],
    actions: ['click', 'hover', 'drag', 'drag_drop'],
    stateMachine: ['READY', 'VISUAL_TARGET_PROVEN', 'DISPATCHED', 'VISUAL_EFFECT_OBSERVED'],
    requiredNodes: ['ownerElement', 'interactionElement'],
    evidenceChannels: ['visual_target', 'hit_test', 'actual_event_target', 'visual_postcondition'],
    postconditions: ['visual_effect_exact'],
    executionSurface: 'visual_assist',
  }),
  adapter({
    id: 'scroll-utility-v1',
    family: 'utility',
    controlTypes: [],
    actions: ['scroll'],
    stateMachine: ['READY', 'SCROLL_DISPATCHED', 'POSITION_OBSERVED'],
    requiredNodes: [],
    evidenceChannels: ['scroll_position', 'target_intersection'],
    postconditions: ['scroll_position_exact', 'target_visible_exact'],
  }),
]);

function clean(value, max = 120) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeAction(value) {
  const token = clean(value, 80).toLowerCase().replace(/[^a-z0-9]+/g, '');
  return ACTION_ALIASES[token] || token || null;
}

function contextKindOf(input = {}) {
  const raw = clean(input.contextKind || input.surfaceKind || input.eventKind, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
  return CONTEXT_KINDS.has(raw) ? raw : null;
}

function explicitControlType(input = {}) {
  const explicit = clean(input.controlType, 80).toLowerCase().replace(/[^a-z0-9]+/g, '_');
  if (universalControlModel.CONTROL_TYPES.includes(explicit) && explicit !== 'unknown') return explicit;

  const variant = clean(input.controlKind || input.widgetKind || input.selectKind || input.variant, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
  const action = normalizeAction(input.actionKind || input.action || input.verb || input.type || input.kind);
  if (variant === 'native' && action === 'select') return 'native_select';
  if (['autocomplete', 'typeahead'].includes(variant)) return 'autocomplete';
  if (['aria', 'custom', 'listbox'].includes(variant) && action === 'select') return 'combobox';
  if (['semantic', 'calendar', 'datepicker', 'date_picker'].includes(variant) && action === 'date') return 'date_picker';
  if (['time', 'timepicker', 'time_picker'].includes(variant)) return 'time_picker';
  return null;
}

function inferRequestedControlType(input = {}) {
  const explicit = explicitControlType(input);
  if (explicit) return explicit;

  const action = normalizeAction(input.actionKind || input.action || input.verb || input.type || input.kind);
  const variant = clean(input.controlKind || input.widgetKind || input.variant, 80).toLowerCase();
  const inputType = clean(input.inputType, 40).toLowerCase();
  if (action === 'date') return inputType === 'date' || variant === 'native' ? 'date_input' : 'date_picker';
  if (action === 'time') return inputType === 'time' || variant === 'native' ? 'time_input' : 'time_picker';
  if (action === 'expand' || action === 'collapse') {
    const role = clean(input.role || input.targetRole || input.controlRole, 80).toLowerCase();
    return role === 'tree' || role === 'treeitem' ? 'tree' : 'accordion';
  }
  const inferred = universalControlModel.inferControlType({
    role: input.role || input.targetRole || input.controlRole,
    tag: input.tag || input.targetTag,
    inputType: input.inputType,
    attributes: input.attributes,
    intentKind: input.intentKind || action,
    controlType: input.controlType,
    multiple: input.multiple,
    multiselectable: input.multiselectable,
    contentEditable: input.contentEditable,
  });
  if (inferred !== 'unknown') return inferred;

  if (action === 'fill' || action === 'type') return 'textbox';
  if (action === 'select') return 'combobox';
  if (action === 'check' || action === 'uncheck') return 'checkbox';
  if (action === 'radio') return 'radio';
  if (action === 'expand' || action === 'collapse') return 'accordion';
  if (action === 'upload') return 'file_input';
  if (action === 'download') return 'download';
  if (action === 'drag') return 'drag_source';
  if (action === 'drop' || action === 'drag_drop') return 'drop_target';
  if (action === 'click' || action === 'press' || action === 'hover') return 'button';
  return 'unknown';
}

function summaryOf(definition, controlType, contextKind) {
  return {
    schema: SCHEMA,
    id: definition.id,
    family: definition.family,
    controlType: controlType || null,
    contextKind: contextKind || null,
    executionSurface: definition.executionSurface,
    stateMachine: [...definition.stateMachine],
    requiredNodes: [...definition.requiredNodes],
    evidenceChannels: [...definition.evidenceChannels],
    postconditions: [...definition.postconditions],
    contextBoundaries: [...definition.contextBoundaries],
    websiteNeutral: true,
  };
}

function resolveControlAdapter(input = {}) {
  const action = normalizeAction(input.actionKind || input.action || input.verb || input.type || input.kind);
  if (!action) return { ok: false, code: 'control_action_missing', action: null };

  if (action === 'scroll') {
    const definition = CONTROL_ADAPTERS.find((item) => item.id === 'scroll-utility-v1');
    return { ok: true, action, controlType: null, contextKind: null, adapter: summaryOf(definition, null, null) };
  }

  const contextKind = contextKindOf(input);
  if (contextKind) {
    const definition = CONTROL_ADAPTERS.find((item) => item.id === 'browser-context-v1');
    if (!definition.actions.includes(action)) {
      return { ok: false, code: 'control_adapter_action_mismatch', action, contextKind, adapterId: definition.id };
    }
    return { ok: true, action, controlType: null, contextKind, adapter: summaryOf(definition, null, contextKind) };
  }

  const controlType = inferRequestedControlType(input);
  const definition = CONTROL_ADAPTERS.find((item) => item.controlTypes.includes(controlType));
  if (!definition) return { ok: false, code: 'control_adapter_not_found', action, controlType };
  if (!definition.actions.includes(action)) {
    return { ok: false, code: 'control_adapter_action_mismatch', action, controlType, adapterId: definition.id };
  }
  return { ok: true, action, controlType, contextKind: null, adapter: summaryOf(definition, controlType, null) };
}

function requireControlAdapter(input = {}) {
  const resolved = resolveControlAdapter(input);
  if (!resolved.ok) {
    throw new Error(`${resolved.code}: ${resolved.action || '(missing action)'} on ${resolved.controlType || resolved.contextKind || '(unknown control)'}`);
  }
  return resolved;
}

function annotateActionPlan(plan, input = {}) {
  const resolved = requireControlAdapter({
    ...input,
    actionKind: plan?.kind || input.actionKind,
    role: plan?.role || input.role,
    variant: plan?.variant || input.variant,
  });
  return {
    ...plan,
    controlAdapter: resolved.adapter,
    metadata: {
      ...(plan?.metadata || {}),
      controlAdapterId: resolved.adapter.id,
      controlFamily: resolved.adapter.family,
      controlType: resolved.controlType,
      executionSurface: resolved.adapter.executionSurface,
    },
  };
}

module.exports = {
  SCHEMA,
  ACTION_ALIASES,
  CONTEXT_KINDS,
  CONTROL_ADAPTERS,
  normalizeAction,
  inferRequestedControlType,
  resolveControlAdapter,
  requireControlAdapter,
  annotateActionPlan,
};
