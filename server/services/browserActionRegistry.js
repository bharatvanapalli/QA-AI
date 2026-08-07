'use strict';

const browserMutationTaxonomy = require('./browserMutationTaxonomy');

const CODEGEN_FALLBACKS = Object.freeze({
  EMIT_PLAYWRIGHT: 'emit_playwright',
  EMIT_FIXME: 'emit_fixme',
  EMIT_MANUAL_GATE: 'emit_manual_gate',
  BLOCK_CERTIFICATION: 'block_certification',
});

const RUNTIME_STATUSES = Object.freeze({
  PASS_CLEAN: 'runtime_pass_clean',
  PASS_HEALED: 'runtime_pass_healed',
  FAILED_AFTER_HEALING_BUDGET: 'runtime_failed_after_healing_budget',
  FAILED_APPLICATION_DEFECT: 'runtime_failed_application_defect',
  FAILED_SETUP_DEFECT: 'runtime_failed_setup_defect',
});

const CERTIFICATION_STATUSES = Object.freeze({
  CERTIFIED: 'certified',
  PREVIEW_NOT_CERTIFIED: 'preview_not_certified',
  BLOCKED_MISSING_EVIDENCE: 'cert_blocked_missing_evidence',
  BLOCKED_UNMAPPED_ACTION: 'cert_blocked_unmapped_action',
  BLOCKED_LOCATOR_UNSTABLE: 'cert_blocked_locator_unstable',
  BLOCKED_DATA_BINDING: 'cert_blocked_data_binding',
  BLOCKED_VERDICT_DIVERGENCE: 'cert_blocked_verdict_divergence',
});

const SCRIPT_STATUSES = Object.freeze({
  PREVIEW_AVAILABLE: 'preview_available',
  CERTIFIED_AVAILABLE: 'certified_available',
  BLOCKED_MISSING_REPLAYIR: 'blocked_missing_replayir',
  BLOCKED_UNMAPPED_ACTION: 'blocked_unmapped_action',
  BLOCKED_UNSCOPED_LOCATOR: 'blocked_unscoped_locator',
  BLOCKED_MISSING_DATA_BINDING: 'blocked_missing_data_binding',
  BLOCKED_VERDICT_DIVERGENCE: 'blocked_verdict_divergence',
});

function entry(tool, canonicalAction, options = {}) {
  const mutationPolicy = browserMutationTaxonomy.mutationPolicyForTool(tool);
  return Object.freeze({
    tool,
    canonicalAction,
    stepClasses: Object.freeze([...(options.stepClasses || [])]),
    mutationPolicy,
    mutatesPage: mutationPolicy === browserMutationTaxonomy.MUTATION_POLICY.MUTATION
      || (mutationPolicy === browserMutationTaxonomy.MUTATION_POLICY.UNREGISTERED && !!options.mutatesPage),
    exportable: options.exportable !== false,
    replayIrMapping: options.replayIrMapping || null,
    codegenFallback: options.codegenFallback || CODEGEN_FALLBACKS.EMIT_PLAYWRIGHT,
    evidenceRequired: Object.freeze([...(options.evidenceRequired || [])]),
    healingAllowed: !!options.healingAllowed,
    failurePolicy: options.failurePolicy || 'block_certification_if_unproven',
    kind: options.kind || 'action',
  });
}

const ACTIONS = [
  entry('browser_navigate', 'navigate', {
    stepClasses: ['navigate'],
    mutatesPage: true,
    replayIrMapping: 'navigate',
    evidenceRequired: ['url'],
    failurePolicy: 'block_runtime_on_failure',
  }),
  entry('browser_navigate_back', 'navigateBack', {
    mutatesPage: true,
    replayIrMapping: 'navigateBack',
    evidenceRequired: ['page_history'],
    failurePolicy: 'preview_only_if_context_switch_unproven',
  }),
  entry('browser_navigate_forward', 'navigateForward', {
    mutatesPage: true,
    replayIrMapping: 'navigateForward',
    evidenceRequired: ['page_history'],
    failurePolicy: 'preview_only_if_context_switch_unproven',
  }),
  entry('browser_click', 'click', {
    stepClasses: ['click', 'select'],
    mutatesPage: true,
    replayIrMapping: 'click',
    evidenceRequired: ['action_locator'],
    healingAllowed: true,
  }),
  entry('browser_mouse_click', 'click', {
    stepClasses: ['click'],
    mutatesPage: true,
    exportable: false,
    evidenceRequired: ['action_locator_or_coordinates'],
    healingAllowed: true,
    codegenFallback: CODEGEN_FALLBACKS.EMIT_FIXME,
  }),
  entry('browser_click_xy', 'click', {
    stepClasses: ['click'],
    mutatesPage: true,
    exportable: false,
    evidenceRequired: ['action_locator_or_coordinates'],
    healingAllowed: true,
    codegenFallback: CODEGEN_FALLBACKS.EMIT_FIXME,
  }),
  entry('browser_mouse_down', 'manual', {
    stepClasses: ['drag'],
    mutatesPage: true,
    exportable: false,
    codegenFallback: CODEGEN_FALLBACKS.EMIT_FIXME,
    evidenceRequired: ['pointer_state', 'coordinates_or_locator'],
    healingAllowed: false,
    failurePolicy: 'preview_fixme_until_export_safe_drag_exists',
  }),
  entry('browser_mouse_up', 'manual', {
    stepClasses: ['drag'],
    mutatesPage: true,
    exportable: false,
    codegenFallback: CODEGEN_FALLBACKS.EMIT_FIXME,
    evidenceRequired: ['pointer_state', 'coordinates_or_locator'],
    healingAllowed: false,
    failurePolicy: 'preview_fixme_until_export_safe_drag_exists',
  }),
  entry('browser_double_click', 'doubleClick', {
    stepClasses: ['click', 'select'],
    mutatesPage: true,
    replayIrMapping: 'doubleClick',
    evidenceRequired: ['action_locator'],
    healingAllowed: true,
  }),
  entry('browser_triple_click', 'tripleClick', {
    stepClasses: ['click'],
    mutatesPage: true,
    replayIrMapping: 'tripleClick',
    evidenceRequired: ['action_locator'],
    healingAllowed: true,
  }),
  entry('browser_type', 'type', {
    stepClasses: ['fill'],
    mutatesPage: true,
    replayIrMapping: 'type',
    evidenceRequired: ['action_locator', 'value_ref'],
    healingAllowed: true,
  }),
  entry('browser_fill', 'fill', {
    stepClasses: ['fill', 'select'],
    mutatesPage: true,
    replayIrMapping: 'fill',
    evidenceRequired: ['action_locator', 'value_ref'],
    healingAllowed: true,
  }),
  entry('browser_fill_form', 'fill', {
    stepClasses: ['fill'],
    mutatesPage: true,
    replayIrMapping: 'fill',
    evidenceRequired: ['field_action_locators', 'value_refs'],
    healingAllowed: true,
  }),
  entry('browser_select_option', 'selectOption', {
    stepClasses: ['select'],
    mutatesPage: true,
    replayIrMapping: 'selectOption',
    evidenceRequired: ['action_locator', 'value_ref'],
    healingAllowed: true,
  }),
  entry('browser_select', 'selectOption', {
    stepClasses: ['select'],
    mutatesPage: true,
    replayIrMapping: 'selectOption',
    evidenceRequired: ['action_locator', 'value_ref'],
    healingAllowed: true,
  }),
  entry('browser_press_key', 'press', {
    stepClasses: ['click'],
    mutatesPage: true,
    replayIrMapping: 'press',
    evidenceRequired: ['key'],
    codegenFallback: CODEGEN_FALLBACKS.BLOCK_CERTIFICATION,
    failurePolicy: 'drop_if_standalone_press_is_only_navigation_helper',
  }),
  entry('browser_hover', 'hover', {
    stepClasses: ['hover'],
    mutatesPage: false,
    replayIrMapping: 'hover',
    evidenceRequired: ['action_locator'],
    healingAllowed: true,
  }),
  entry('browser_wait_for_selector', 'wait', {
    stepClasses: ['wait'],
    mutatesPage: false,
    replayIrMapping: 'waitFor',
    evidenceRequired: ['wait_condition', 'action_locator'],
    healingAllowed: true,
    failurePolicy: 'preserve_authored_wait_contract',
  }),
  entry('browser_drag', 'drag', {
    stepClasses: ['drag'],
    mutatesPage: true,
    replayIrMapping: 'drag',
    evidenceRequired: ['source_locator', 'target_locator'],
    healingAllowed: true,
  }),
  entry('browser_file_upload', 'upload', {
    stepClasses: ['upload'],
    mutatesPage: true,
    replayIrMapping: 'upload',
    evidenceRequired: ['action_locator', 'file_ref'],
    healingAllowed: true,
  }),
  entry('browser_upload_file', 'upload', {
    stepClasses: ['upload'],
    mutatesPage: true,
    replayIrMapping: 'upload',
    evidenceRequired: ['action_locator', 'file_ref'],
    healingAllowed: true,
  }),
  entry('browser_check', 'check', {
    stepClasses: ['click'],
    mutatesPage: true,
    replayIrMapping: 'check',
    evidenceRequired: ['action_locator'],
    healingAllowed: true,
  }),
  entry('browser_uncheck', 'uncheck', {
    stepClasses: ['click'],
    mutatesPage: true,
    replayIrMapping: 'uncheck',
    evidenceRequired: ['action_locator'],
    healingAllowed: true,
  }),
  entry('browser_handle_dialog', 'handleDialog', {
    stepClasses: ['dialog'],
    mutatesPage: true,
    replayIrMapping: 'handleDialog',
    evidenceRequired: ['dialog_state'],
    codegenFallback: CODEGEN_FALLBACKS.EMIT_PLAYWRIGHT,
  }),
  entry('browser_resize', 'resize', {
    stepClasses: ['resize'],
    mutatesPage: true,
    replayIrMapping: 'resize',
    evidenceRequired: ['viewport'],
    codegenFallback: CODEGEN_FALLBACKS.EMIT_PLAYWRIGHT,
  }),
  entry('browser_close', 'close', {
    mutatesPage: true,
    replayIrMapping: 'close',
    evidenceRequired: ['browser_context'],
    codegenFallback: CODEGEN_FALLBACKS.EMIT_PLAYWRIGHT,
  }),
  entry('deterministic_dom_fill', 'fill', {
    stepClasses: ['fill'],
    mutatesPage: true,
    replayIrMapping: 'fill',
    evidenceRequired: ['dom_target', 'value_ref', 'readback_or_effect'],
    healingAllowed: true,
  }),
  entry('deterministic_dom_fill_recovery', 'fill', {
    stepClasses: ['fill'],
    mutatesPage: true,
    replayIrMapping: 'fill',
    evidenceRequired: ['dom_target', 'value_ref', 'recovery_reason'],
    healingAllowed: true,
  }),
  entry('deterministic_dom_date_commit', 'fill', {
    stepClasses: ['fill'],
    mutatesPage: true,
    replayIrMapping: 'fill',
    evidenceRequired: ['dom_target', 'value_ref', 'readback_or_effect'],
    healingAllowed: true,
  }),
  entry('deterministic_dom_click', 'click', {
    stepClasses: ['click'],
    mutatesPage: true,
    replayIrMapping: 'click',
    evidenceRequired: ['dom_target', 'effect_proof'],
    healingAllowed: true,
  }),
  entry('deterministic_dom_click_recovery', 'click', {
    stepClasses: ['click'],
    mutatesPage: true,
    replayIrMapping: 'click',
    evidenceRequired: ['dom_target', 'recovery_reason', 'effect_proof'],
    healingAllowed: true,
  }),
  entry('deterministic_dom_select', 'select', {
    stepClasses: ['select'],
    mutatesPage: true,
    replayIrMapping: 'selectOption',
    evidenceRequired: ['dom_target', 'value_ref', 'selection_readback'],
    healingAllowed: true,
  }),
  entry('deterministic_dom_select_recovery', 'select', {
    stepClasses: ['select'],
    mutatesPage: true,
    replayIrMapping: 'selectOption',
    evidenceRequired: ['dom_target', 'value_ref', 'recovery_reason'],
    healingAllowed: true,
  }),
  entry('vision_click_canvas', 'click', {
    stepClasses: ['click'],
    mutatesPage: true,
    exportable: false,
    codegenFallback: CODEGEN_FALLBACKS.EMIT_FIXME,
    evidenceRequired: ['screenshot', 'coordinates', 'vision_reason'],
    healingAllowed: true,
    failurePolicy: 'preview_fixme_until_manual_locator_exists',
  }),
  entry('browser_scroll', 'scroll', {
    mutatesPage: false,
    exportable: false,
    codegenFallback: CODEGEN_FALLBACKS.EMIT_FIXME,
    evidenceRequired: ['scroll_delta_or_target'],
    failurePolicy: 'diagnostic_only_until_playwright_scroll_contract_exists',
  }),
  entry('browser_wait_for', 'waitFor', {
    stepClasses: ['wait'],
    mutatesPage: false,
    replayIrMapping: 'waitFor',
    evidenceRequired: ['wait_condition'],
    healingAllowed: false,
    failurePolicy: 'preserve_authored_wait_contract',
  }),
];

const UTILITY_ACTIONS = [
  entry('browser_snapshot', 'observe', {
    exportable: false,
    codegenFallback: CODEGEN_FALLBACKS.BLOCK_CERTIFICATION,
    evidenceRequired: ['snapshot'],
    kind: 'utility',
    failurePolicy: 'diagnostic_only',
  }),
  entry('browser_take_screenshot', 'observe', {
    exportable: false,
    codegenFallback: CODEGEN_FALLBACKS.BLOCK_CERTIFICATION,
    evidenceRequired: ['screenshot'],
    kind: 'utility',
    failurePolicy: 'diagnostic_only',
  }),
  entry('browser_evaluate', 'observe', {
    exportable: false,
    codegenFallback: CODEGEN_FALLBACKS.BLOCK_CERTIFICATION,
    evidenceRequired: ['evaluation_result'],
    kind: 'utility',
    failurePolicy: 'diagnostic_only',
  }),
  entry('browser_run_code', 'observe', {
    exportable: false,
    codegenFallback: CODEGEN_FALLBACKS.BLOCK_CERTIFICATION,
    evidenceRequired: ['evaluation_result'],
    kind: 'utility',
    failurePolicy: 'diagnostic_only',
  }),
  entry('browser_run_code_unsafe', 'observe', {
    exportable: false,
    codegenFallback: CODEGEN_FALLBACKS.BLOCK_CERTIFICATION,
    evidenceRequired: ['evaluation_result'],
    kind: 'utility',
    failurePolicy: 'diagnostic_only',
  }),
  entry('assertion_check', 'assert', {
    exportable: false,
    codegenFallback: CODEGEN_FALLBACKS.BLOCK_CERTIFICATION,
    evidenceRequired: ['assertion_outcome'],
    kind: 'utility',
    failurePolicy: 'assertion_channel_handles_export',
  }),
  entry('final_verdict', 'manual', {
    exportable: false,
    codegenFallback: CODEGEN_FALLBACKS.BLOCK_CERTIFICATION,
    evidenceRequired: ['verdict'],
    kind: 'utility',
    failurePolicy: 'diagnostic_only',
  }),
  entry('remember_credential', 'manual', {
    exportable: false,
    codegenFallback: CODEGEN_FALLBACKS.BLOCK_CERTIFICATION,
    evidenceRequired: ['credential_ref'],
    kind: 'utility',
    failurePolicy: 'diagnostic_only',
  }),
  entry('human_input', 'manual', {
    exportable: false,
    codegenFallback: CODEGEN_FALLBACKS.EMIT_MANUAL_GATE,
    evidenceRequired: ['manual_disposition'],
    kind: 'utility',
    failurePolicy: 'manual_gate',
  }),
];

const REGISTRY = Object.freeze([...ACTIONS, ...UTILITY_ACTIONS].reduce((acc, action) => {
  if (acc[action.tool]) throw new Error(`Duplicate browser action registry tool: ${action.tool}`);
  acc[action.tool] = action;
  return acc;
}, {}));

function getActionEntry(tool) {
  return REGISTRY[String(tool || '')] || null;
}

function requireActionEntry(tool) {
  const found = getActionEntry(tool);
  if (!found) throw new Error(`Unregistered browser action tool: ${tool}`);
  return found;
}

function isRegisteredTool(tool) {
  return !!getActionEntry(tool);
}

function isUtilityTool(tool) {
  const found = getActionEntry(tool);
  return !!found && found.kind === 'utility';
}

function isRuntimeActionTool(tool) {
  const found = getActionEntry(tool);
  return !!found && found.kind !== 'utility';
}

function toolsForStepClass(stepClass) {
  const cls = String(stepClass || '');
  return new Set(Object.values(REGISTRY)
    .filter((item) => item.kind !== 'utility' && item.stepClasses.includes(cls))
    .map((item) => item.tool));
}

function utilityToolSet() {
  return new Set(Object.values(REGISTRY)
    .filter((item) => item.kind === 'utility')
    .map((item) => item.tool));
}

function replayToolActionMap() {
  return Object.freeze(Object.values(REGISTRY).reduce((acc, item) => {
    if (item.exportable && item.replayIrMapping) acc[item.tool] = item.replayIrMapping;
    return acc;
  }, {}));
}

function stepToolSetsForClasses(classes) {
  return Object.freeze((Array.isArray(classes) ? classes : []).reduce((acc, cls) => {
    acc[cls] = toolsForStepClass(cls);
    return acc;
  }, {}));
}

function codegenFallbackForTool(tool) {
  const found = getActionEntry(tool);
  return found ? found.codegenFallback : CODEGEN_FALLBACKS.BLOCK_CERTIFICATION;
}

function validateRegistry() {
  const issues = [];
  for (const item of Object.values(REGISTRY)) {
    if (!item.tool) issues.push({ code: 'missing_tool', tool: item.tool });
    if (!item.canonicalAction) issues.push({ code: 'missing_canonical_action', tool: item.tool });
    if (item.mutationPolicy === browserMutationTaxonomy.MUTATION_POLICY.UNREGISTERED) {
      issues.push({ code: 'missing_canonical_mutation_taxonomy', tool: item.tool });
    }
    if (item.mutatesPage !== (item.mutationPolicy === browserMutationTaxonomy.MUTATION_POLICY.MUTATION)) {
      issues.push({ code: 'mutation_taxonomy_mismatch', tool: item.tool, mutationPolicy: item.mutationPolicy });
    }
    if (!Object.values(CODEGEN_FALLBACKS).includes(item.codegenFallback)) {
      issues.push({ code: 'invalid_codegen_fallback', tool: item.tool, codegenFallback: item.codegenFallback });
    }
    if (item.kind !== 'utility' && item.exportable && !item.replayIrMapping) {
      issues.push({ code: 'missing_replay_mapping', tool: item.tool });
    }
    if (!item.exportable && item.codegenFallback === CODEGEN_FALLBACKS.EMIT_PLAYWRIGHT) {
      issues.push({ code: 'non_exportable_emits_playwright', tool: item.tool });
    }
  }
  return issues;
}

module.exports = {
  CODEGEN_FALLBACKS,
  RUNTIME_STATUSES,
  CERTIFICATION_STATUSES,
  SCRIPT_STATUSES,
  REGISTRY,
  getActionEntry,
  requireActionEntry,
  isRegisteredTool,
  isUtilityTool,
  isRuntimeActionTool,
  toolsForStepClass,
  utilityToolSet,
  replayToolActionMap,
  stepToolSetsForClasses,
  codegenFallbackForTool,
  validateRegistry,
};
