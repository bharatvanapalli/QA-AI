'use strict';

const MUTATION_POLICY = Object.freeze({
  MUTATION: 'mutation',
  OBSERVATION: 'observation',
  CONDITIONAL: 'conditional',
  UNREGISTERED: 'unregistered',
});

const ALWAYS_MUTATING_BROWSER_TOOLS = new Set([
  'browser_navigate', 'browser_navigate_back', 'browser_navigate_forward', 'browser_reload',
  'browser_click', 'browser_double_click', 'browser_triple_click',
  'browser_mouse_click', 'browser_click_xy', 'browser_mouse_down', 'browser_mouse_up',
  'browser_type', 'browser_fill', 'browser_fill_form',
  'browser_select', 'browser_select_option', 'browser_check', 'browser_uncheck',
  'browser_press_key', 'browser_hover', 'browser_drag', 'browser_scroll',
  'browser_file_upload', 'browser_upload_file', 'browser_handle_dialog',
  'browser_resize', 'browser_close', 'browser_install',
  'playwright_context_new_page', 'playwright_page_goto', 'playwright_page_bring_to_front',
  'playwright_frame_install_event_recorder',
  'playwright_locator_add_capture_marker', 'playwright_locator_remove_capture_marker',
  'deterministic_dom_fill', 'deterministic_dom_fill_recovery',
  'deterministic_dom_date_commit',
  'deterministic_dom_click', 'deterministic_dom_click_recovery',
  'deterministic_dom_select', 'deterministic_dom_select_recovery',
  'vision_click_canvas',
]);

const CONDITIONAL_MUTATION_TOOLS = new Set([
  'browser_tabs',
  'browser_evaluate', 'browser_run_code', 'browser_run_code_unsafe',
  'browser_execute_cdp_command',
]);

const OBSERVATION_ONLY_BROWSER_TOOLS = new Set([
  'browser_snapshot', 'browser_take_screenshot', 'browser_screenshot',
  'browser_wait_for', 'browser_wait_for_selector',
  'browser_console_messages', 'browser_network_requests',
  'browser_get_url', 'browser_get_title',
  'assertion_check', 'final_verdict', 'remember_credential', 'human_input',
]);

const SEMANTIC_TARGET_MUTATION_TOOLS = new Set([
  'browser_click', 'browser_double_click', 'browser_triple_click',
  'browser_mouse_click', 'browser_click_xy', 'browser_mouse_down', 'browser_mouse_up',
  'browser_type', 'browser_fill', 'browser_fill_form',
  'browser_select', 'browser_select_option', 'browser_check', 'browser_uncheck',
  'browser_hover', 'browser_drag', 'browser_file_upload', 'browser_upload_file',
  'deterministic_dom_fill', 'deterministic_dom_fill_recovery',
  'deterministic_dom_date_commit',
  'deterministic_dom_click', 'deterministic_dom_click_recovery',
  'deterministic_dom_select', 'deterministic_dom_select_recovery',
  'vision_click_canvas',
]);
const TARGET_CAPABLE_MUTATION_TOOLS = new Set([
  ...SEMANTIC_TARGET_MUTATION_TOOLS,
  'browser_press_key', 'browser_scroll',
]);
const POTENTIALLY_MUTATING_BROWSER_TOOLS = new Set([
  ...ALWAYS_MUTATING_BROWSER_TOOLS,
  ...CONDITIONAL_MUTATION_TOOLS,
]);

// Fail closed for executable JavaScript. The observation lane may contain reads,
// but any recognizable behavioral, DOM, storage, navigation, pointer, or style
// write makes the operation a mutation requiring a coordinator transaction.
const EVALUATE_MUTATION_RE = /(?:\.click\s*\(|\.dblclick\s*\(|\.focus\s*\(|\.blur\s*\(|\.submit\s*\(|\.requestSubmit\s*\(|\.reset\s*\(|\.scrollIntoView\s*\(|dispatchEvent\s*\(|execCommand\s*\(|\.(?:value|checked|selected|selectedIndex|innerHTML|outerHTML|textContent|innerText|className|id|src|href)\s*=(?!=|>)|\.(?:style|dataset)\.[\w$-]+\s*=(?!=|>)|\.classList\.(?:add|remove|replace|toggle)\s*\(|(?:set|remove|toggle)Attribute\s*\(|(?:append|appendChild|prepend|before|after|replaceWith|replaceChildren|replaceChild|insertBefore|insertAdjacent(?:Element|HTML|Text)|remove|removeChild)\s*\(|Object\.(?:assign|defineProperty|defineProperties)\s*\(\s*(?:document|window|location|history|localStorage|sessionStorage|[^,]*(?:style|dataset|classList))|Reflect\.set\s*\(|(?:localStorage|sessionStorage)\.(?:setItem|removeItem|clear)\s*\(|document\.cookie\s*=(?!=|>)|(?:window\.)?scroll(?:To|By)\s*\(|history\.(?:pushState|replaceState|back|forward|go)\s*\(|(?:window\.)?location(?:\.(?:href|hash|search))?\s*=(?!=|>)|location\.(?:assign|replace|reload)\s*\(|window\.open\s*\(|window\.close\s*\(|new\s+(?:KeyboardEvent|MouseEvent|PointerEvent|InputEvent|SubmitEvent)\s*\()/i;

const READ_ONLY_CDP_COMMAND_RE = /^(?:Accessibility\.(?:get|query)|DOM\.(?:describeNode|get|query|resolveNode|performSearch|getSearchResults)|Runtime\.(?:getProperties|globalLexicalScopeNames)|Page\.(?:captureScreenshot|getNavigationHistory|getLayoutMetrics)|Network\.(?:get|searchInResponseBody)|Storage\.(?:get|trackCacheStorageForOrigin|trackIndexedDBForOrigin))/i;

function executableSource(args = {}) {
  return String(args.function || args.expression || args.script || args.code || '');
}

function isMutatingBrowserEvaluate(name, args = {}) {
  return ['browser_evaluate', 'browser_run_code', 'browser_run_code_unsafe'].includes(String(name || ''))
    && EVALUATE_MUTATION_RE.test(executableSource(args));
}

function isMutatingCdpCommand(args = {}) {
  const command = String(args.command || '').trim();
  if (!command) return true;
  return !READ_ONLY_CDP_COMMAND_RE.test(command);
}

function mutationPolicyForTool(name) {
  const toolName = String(name || '');
  if (ALWAYS_MUTATING_BROWSER_TOOLS.has(toolName)) return MUTATION_POLICY.MUTATION;
  if (CONDITIONAL_MUTATION_TOOLS.has(toolName)) return MUTATION_POLICY.CONDITIONAL;
  if (OBSERVATION_ONLY_BROWSER_TOOLS.has(toolName)) return MUTATION_POLICY.OBSERVATION;
  return MUTATION_POLICY.UNREGISTERED;
}

function isMutatingTool(name, args = {}) {
  const toolName = String(name || '');
  const policy = mutationPolicyForTool(toolName);
  if (policy === MUTATION_POLICY.MUTATION) return true;
  if (policy !== MUTATION_POLICY.CONDITIONAL) return false;
  if (toolName === 'browser_tabs') return String(args.action || 'list').toLowerCase() !== 'list';
  if (toolName === 'browser_execute_cdp_command') return isMutatingCdpCommand(args);
  return isMutatingBrowserEvaluate(toolName, args);
}

function isObservationOnlyTool(name, args = {}) {
  const policy = mutationPolicyForTool(name);
  if (policy === MUTATION_POLICY.OBSERVATION) return true;
  return policy === MUTATION_POLICY.CONDITIONAL && !isMutatingTool(name, args);
}

module.exports = {
  MUTATION_POLICY,
  ALWAYS_MUTATING_BROWSER_TOOLS,
  CONDITIONAL_MUTATION_TOOLS,
  OBSERVATION_ONLY_BROWSER_TOOLS,
  SEMANTIC_TARGET_MUTATION_TOOLS,
  TARGET_CAPABLE_MUTATION_TOOLS,
  POTENTIALLY_MUTATING_BROWSER_TOOLS,
  EVALUATE_MUTATION_RE,
  READ_ONLY_CDP_COMMAND_RE,
  executableSource,
  isMutatingBrowserEvaluate,
  isMutatingCdpCommand,
  mutationPolicyForTool,
  isMutatingTool,
  isObservationOnlyTool,
};
