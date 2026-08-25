'use strict';

const TAXONOMY_VERSION = 'qaai-controller-browser-mutation-taxonomy-v1';

const OPERATION_CLASS = Object.freeze({
  MUTATION: 'MUTATION',
  OBSERVATION: 'OBSERVATION',
  REJECTED: 'REJECTED',
});

const ALWAYS_MUTATING_TOOLS = new Set([
  'browser_navigate', 'browser_navigate_back', 'browser_navigate_forward', 'browser_reload',
  'browser_go_back', 'browser_go_forward', 'NavigateBack', 'GoBack',
  'browser_click', 'browser_double_click', 'browser_triple_click',
  'browser_mouse_click', 'browser_click_xy', 'browser_mouse_down', 'browser_mouse_up',
  'browser_type', 'browser_fill', 'browser_fill_form',
  'browser_select', 'browser_select_option', 'browser_check', 'browser_uncheck',
  'browser_press_key', 'browser_hover', 'browser_drag', 'browser_scroll',
  'browser_file_upload', 'browser_upload_file', 'browser_handle_dialog',
  'browser_resize', 'browser_close', 'browser_install',
  'browser_evaluate', 'browser_run_code', 'browser_run_code_unsafe',
  'ClickAndHold', 'browser_click_and_hold', 'Print', 'Inspect', 'ReadAndPrint', 'PressKey',
  'SwitchTab', 'CloseTab', 'NewTab', 'SwitchFrame', 'browser_switch_tab', 'browser_close_tab',
  'playwright_context_new_page', 'playwright_page_goto', 'playwright_page_bring_to_front',
  'playwright_frame_install_event_recorder',
  'playwright_locator_add_capture_marker', 'playwright_locator_remove_capture_marker',
  'deterministic_dom_fill', 'deterministic_dom_fill_recovery',
  'deterministic_dom_date_commit',
  'deterministic_dom_click', 'deterministic_dom_click_recovery',
  'deterministic_dom_select', 'deterministic_dom_select_recovery',
  'vision_click_canvas',
]);

const OBSERVATION_TOOLS = new Set([
  'browser_snapshot', 'browser_take_screenshot', 'browser_screenshot',
  'browser_wait_for', 'browser_wait_for_selector',
  'browser_console_messages', 'browser_network_requests',
  'browser_get_url', 'browser_get_title',
]);

const READ_ONLY_CDP_COMMAND = /^(?:Accessibility\.(?:getFullAXTree|getPartialAXTree|getRootAXNode|getChildAXNodes|queryAXTree)|DOM\.(?:describeNode|getDocument|getFlattenedDocument|getOuterHTML|getAttributes|getBoxModel|getContentQuads|getNodeForLocation|querySelector|querySelectorAll|resolveNode|performSearch|getSearchResults|discardSearchResults)|Runtime\.(?:evaluate|getProperties|globalLexicalScopeNames)|Page\.(?:captureScreenshot|getNavigationHistory|getLayoutMetrics|getFrameTree)|Network\.(?:getAllCookies|getCookies|getRequestPostData|getResponseBody|getResponseBodyForInterception|searchInResponseBody)|Storage\.(?:getCookies|getUsageAndQuota|trackCacheStorageForOrigin|trackIndexedDBForOrigin))$/;

class ControllerBrowserMutationTaxonomyError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ControllerBrowserMutationTaxonomyError';
    this.code = code;
    Object.assign(this, details);
  }
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function classification(operationClass, toolName, reason) {
  return Object.freeze({
    schemaVersion: TAXONOMY_VERSION,
    operationClass,
    toolName,
    reason,
    requiresControllerMutationPermit: operationClass === OPERATION_CLASS.MUTATION,
  });
}

function classifyControllerBrowserTool(name, args = {}) {
  const toolName = clean(name);
  if (ALWAYS_MUTATING_TOOLS.has(toolName)) {
    return classification(OPERATION_CLASS.MUTATION, toolName, (
      ['browser_evaluate', 'browser_run_code', 'browser_run_code_unsafe'].includes(toolName)
        ? 'executable_browser_code_is_mutation_authorized_by_default'
        : 'registered_browser_mutation'
    ));
  }
  if (OBSERVATION_TOOLS.has(toolName)) {
    return classification(OPERATION_CLASS.OBSERVATION, toolName, 'registered_browser_observation');
  }
  if (toolName === 'browser_tabs') {
    return String(args.action || 'list').toLowerCase() === 'list'
      ? classification(OPERATION_CLASS.OBSERVATION, toolName, 'tab_list_observation')
      : classification(OPERATION_CLASS.MUTATION, toolName, 'tab_state_change');
  }
  if (toolName === 'browser_execute_cdp_command') {
    const command = clean(args.command);
    return command && READ_ONLY_CDP_COMMAND.test(command)
      ? classification(OPERATION_CLASS.OBSERVATION, toolName, 'allowlisted_read_only_cdp_command')
      : classification(OPERATION_CLASS.MUTATION, toolName, 'cdp_command_not_allowlisted_read_only');
  }
  return classification(
    OPERATION_CLASS.REJECTED,
    toolName,
    toolName
      ? 'browser_tool_not_registered_in_controller_taxonomy'
      : 'browser_tool_name_missing',
  );
}

function assertControllerMutationTool(name, args = {}) {
  const result = classifyControllerBrowserTool(name, args);
  if (result.operationClass !== OPERATION_CLASS.MUTATION) {
    throw new ControllerBrowserMutationTaxonomyError(
      result.operationClass === OPERATION_CLASS.OBSERVATION
        ? 'Observation tools cannot pass through the mutation gateway.'
        : 'Unregistered browser tools cannot be dispatched.',
      result.operationClass === OPERATION_CLASS.OBSERVATION
        ? 'CONTROLLER_GATEWAY_OBSERVATION_TOOL_FORBIDDEN'
        : 'CONTROLLER_GATEWAY_TOOL_UNREGISTERED',
      { toolName: result.toolName || null, reason: result.reason },
    );
  }
  return result;
}

module.exports = {
  TAXONOMY_VERSION,
  OPERATION_CLASS,
  ALWAYS_MUTATING_TOOLS,
  OBSERVATION_TOOLS,
  READ_ONLY_CDP_COMMAND,
  ControllerBrowserMutationTaxonomyError,
  classifyControllerBrowserTool,
  assertControllerMutationTool,
};
