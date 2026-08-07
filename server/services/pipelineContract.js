'use strict';

// Central execution doctrine for the agent pipeline. Keep these rules pure so
// routes, conductor, export, and tests can share the same contract.
const browserActionRegistry = require('./browserActionRegistry');

const ROLE_CONTRACT = Object.freeze({
  architect: 'author_candidate_contract',
  planner: 'order_explicit_dependencies_only',
  conductor: 'execute_current_approved_step_only',
  critic: 'diagnose_and_suggest_only',
  supervisor: 'diagnose_and_suggest_only',
  projectMemory: 'locator_resolution_only',
  exporter: 'emit_approved_and_recorded_actions_only',
});

function autoApplyAgentRewritesEnabled(env = process.env) {
  return env && env.QAAI_AUTO_APPLY_AGENT_REWRITES === 'on';
}

function actionVerb(step = {}) {
  return String(step.action || step.verb || '').trim().toLowerCase();
}

const STEP_UTILITY_TOOLS = browserActionRegistry.utilityToolSet();

const FILL_TOOLS = browserActionRegistry.toolsForStepClass('fill');
const CLICK_TOOLS = browserActionRegistry.toolsForStepClass('click');
const FILL_PREPARATION_CLICK_TOOLS = new Set(['browser_click', 'browser_double_click', 'browser_triple_click']);
const SELECT_TOOLS = browserActionRegistry.toolsForStepClass('select');
const NAVIGATE_TOOLS = browserActionRegistry.toolsForStepClass('navigate');
const HOVER_TOOLS = browserActionRegistry.toolsForStepClass('hover');
const DRAG_TOOLS = browserActionRegistry.toolsForStepClass('drag');
const UPLOAD_TOOLS = browserActionRegistry.toolsForStepClass('upload');
const DIALOG_TOOLS = browserActionRegistry.toolsForStepClass('dialog');
const RESIZE_TOOLS = browserActionRegistry.toolsForStepClass('resize');

// Keep deterministic DOM recovery tools visible in the shared contract, not only
// indirectly through the action registry. These names are runtime metadata, but
// they still complete the same canonical fill/click/select step classes.
for (const tool of ['deterministic_dom_fill', 'deterministic_dom_fill_recovery']) FILL_TOOLS.add(tool);
for (const tool of ['deterministic_dom_click', 'deterministic_dom_click_recovery']) CLICK_TOOLS.add(tool);
for (const tool of ['deterministic_dom_select', 'deterministic_dom_select_recovery']) SELECT_TOOLS.add(tool);

function isFillOrTypeStep(step = {}) {
  return /^(?:fill|type|enter|input)$/.test(actionVerb(step));
}

function looksLikeUrl(value) {
  return /^(?:https?:\/\/|\/|\.\/|\.\.\/)/i.test(String(value || '').trim());
}

function isNavigateStep(step = {}) {
  const verb = actionVerb(step);
  if (/^(?:navigate|visit|load|goto|go)$/.test(verb)) return true;
  if (/go\s+to|open\s+(?:url|page|route)|load\s+(?:url|page|route)/.test(verb)) return true;
  if (verb === 'open' && looksLikeUrl(step.value || step.url || step.element || step.target)) return true;
  return false;
}

function isToggleStep(step = {}) {
  const verb = actionVerb(step);
  if (verb === 'uncheck') return true;
  if (verb !== 'check') return false;
  const role = String(
    step.role
      || step.targetRole
      || step.controlRole
      || step.controlType
      || step.operationContract?.role
      || '',
  ).trim().toLowerCase();
  if (/^(?:checkbox|radio|switch|menuitemcheckbox|menuitemradio)$/.test(role)) return true;
  const target = String([
    step.element,
    step.target,
    step.label,
    step.locator_hint,
    step.operationContract?.target,
  ].filter(Boolean).join(' ')).toLowerCase();
  if (/\b(?:checkbox|radio|switch|toggle)\b/.test(target)) return true;
  return typeof step.checked === 'boolean'
    || typeof step.expectedChecked === 'boolean'
    || typeof step.operationContract?.checked === 'boolean';
}

function isClickStep(step = {}) {
  const verb = actionVerb(step);
  if (isToggleStep(step)) return true;
  if (/^(?:click|tap|press|submit|save|create|add|delete|remove|edit|open)$/.test(verb)) return !isNavigateStep(step);
  return false;
}

function isSelectStep(step = {}) {
  const verb = actionVerb(step);
  return /^(?:select|choose|pick)$/.test(verb);
}

function isHoverStep(step = {}) {
  return actionVerb(step) === 'hover';
}

function isDragStep(step = {}) {
  return /^(?:drag|drop|draganddrop|drag_and_drop)$/.test(actionVerb(step));
}

function isUploadStep(step = {}) {
  return /^(?:upload|attach)$/.test(actionVerb(step));
}

function isDialogStep(step = {}) {
  const verb = actionVerb(step);
  return /^(?:accept|dismiss|confirm|cancel|handle)$/.test(verb)
    && /\b(dialog|alert|confirm|prompt)\b/i.test(String(step.element || step.target || step.expected || ''));
}

function isResizeStep(step = {}) {
  return /^(?:resize|setviewport|set_viewport)$/.test(actionVerb(step));
}

function isVerificationStep(step = {}) {
  return !isToggleStep(step) && /^(?:verify|check|assert|expect|validate)$/.test(actionVerb(step));
}

function stepCompletionKind(step = {}) {
  if (!step || !actionVerb(step)) return 'unknown';
  if (isFillOrTypeStep(step)) return 'fill';
  if (isNavigateStep(step)) return 'navigate';
  if (isSelectStep(step)) return 'select';
  if (isClickStep(step)) return 'click';
  if (isHoverStep(step)) return 'hover';
  if (isDragStep(step)) return 'drag';
  if (isUploadStep(step)) return 'upload';
  if (isDialogStep(step)) return 'dialog';
  if (isResizeStep(step)) return 'resize';
  if (isVerificationStep(step)) return 'verify';
  return 'unknown';
}

function isStepUtilityTool(toolName) {
  return STEP_UTILITY_TOOLS.has(String(toolName || ''));
}

function toolCanCompleteStep(toolName, step = {}) {
  const tool = String(toolName || '');
  if (!step || !actionVerb(step)) return true;
  switch (stepCompletionKind(step)) {
    case 'fill':
      return FILL_TOOLS.has(tool);
    case 'navigate':
      return NAVIGATE_TOOLS.has(tool);
    case 'select':
      return SELECT_TOOLS.has(tool);
    case 'click':
      return CLICK_TOOLS.has(tool);
    case 'hover':
      return HOVER_TOOLS.has(tool);
    case 'drag':
      return DRAG_TOOLS.has(tool);
    case 'upload':
      return UPLOAD_TOOLS.has(tool);
    case 'dialog':
      return DIALOG_TOOLS.has(tool);
    case 'resize':
      return RESIZE_TOOLS.has(tool);
    case 'verify':
      return false;
    default:
      return true;
  }
}

function stepCompletionBlockReason({ toolName, step = {}, stepNo = null } = {}) {
  if (toolCanCompleteStep(toolName, step)) return null;
  const ordinal = Number.isFinite(Number(stepNo)) ? Number(stepNo) : '?';
  const target = step.element || step.target || step.locator_hint || 'the current input';
  const kind = stepCompletionKind(step);
  const action = actionVerb(step) || kind;
  const toolAdvice = {
    fill: 'Use browser_type or browser_fill_form with the approved value.',
    navigate: 'Use browser_navigate only for an approved Navigate/Open URL step.',
    select: 'Use browser_select_option for native selects, or complete the custom dropdown with browser_click on the control and option.',
    click: 'Use browser_click on the current visible ref.',
    hover: 'Use browser_hover on the current visible ref.',
    drag: 'Use browser_drag with the approved source and target refs.',
    upload: 'Use browser_file_upload on the file input.',
    dialog: 'Use browser_handle_dialog for the active native dialog.',
    resize: 'Use browser_resize with the approved viewport.',
    verify: 'Observe the current page state and emit the approved step verdict; do not mutate the page.',
  }[kind] || 'Use the approved browser tool for this step.';
  return {
    code: 'wrong_tool_for_step_completion',
    actionKind: kind,
    message: `Step ${ordinal} is a ${action || kind} step for "${target}"; ${toolName} cannot complete it. ${toolAdvice}`,
  };
}

// Tokens that carry NO element identity — shared between an approved step target and
// a tool's element label without proving they are the SAME control. Stripped before
// the identity comparison so "Username field" vs "Dashboard link" don't match on the
// generic noun ("field"/"link"). Generic UI vocabulary, never a site value.
const IDENTITY_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'link', 'button', 'btn', 'field', 'input', 'menu', 'item',
  'icon', 'tab', 'page', 'control', 'element', 'box', 'textbox', 'area', 'section',
  'left', 'right', 'top', 'bottom', 'side', 'nav', 'navigation', 'submit', 'open', 'goto',
  'click', 'select', 'option', 'label', 'text', 'value', 'current', 'visible', 'row', 'cell',
]);

function identityTokens(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !IDENTITY_STOPWORDS.has(t));
}

/**
 * TARGET-IDENTITY gate for a click/select step. Tool CLASS alone (browser_click) is not
 * enough: clicking "Username" must NOT complete "Click the Dashboard menu link". This
 * proves the element the tool ACTED ON matches the step's resolved target/value.
 *
 * Match rule (generic, keyed on identity tokens, never a site string):
 *   • If the step carries a concrete VALUE (e.g. a data-driven {{menulabel}} → "Dashboard"),
 *     that value is the PRIMARY identity — the tool's element label MUST contain one of its
 *     tokens.
 *   • Otherwise the tool's element label must share an identity token with the step's
 *     target/element/locator_hint nouns.
 *   • When the tool passed NO element label, or the step has no identifying text, we cannot
 *     judge → do NOT over-block (returns matched:true).
 *
 * @returns {{ matched: boolean, expected?: string[], actual?: string[] }}
 */
function clickTargetMatchesStep(step = {}, toolArgs = {}) {
  const actualLabel = String((toolArgs && (toolArgs.element || toolArgs.text)) || '').trim();
  if (!actualLabel) return { matched: true, reason: 'no_actual_label' };
  const actual = new Set(identityTokens(actualLabel));
  if (!actual.size) return { matched: true, reason: 'no_actual_identity' };

  const valueTokens = identityTokens(step && step.value != null ? step.value : '');
  if (valueTokens.length) {
    const hit = valueTokens.some((t) => actual.has(t));
    return hit ? { matched: true } : { matched: false, expected: valueTokens, actual: [...actual] };
  }
  const targetTokens = identityTokens([step && step.element, step && step.target, step && step.locator_hint].filter(Boolean).join(' '));
  if (!targetTokens.length) return { matched: true, reason: 'no_expected_identity' };
  const hit = targetTokens.some((t) => actual.has(t));
  return hit ? { matched: true } : { matched: false, expected: targetTokens, actual: [...actual] };
}

function fillTargetMatchesStep(step = {}, toolArgs = {}) {
  const actualLabels = [];
  if (toolArgs && Array.isArray(toolArgs.fields)) {
    for (const field of toolArgs.fields) {
      if (!field || typeof field !== 'object') continue;
      const label = String(field.element || field.label || field.name || field.field || '').trim();
      if (label) actualLabels.push(label);
    }
  } else {
    const label = String((toolArgs && (toolArgs.element || toolArgs.label || toolArgs.name || toolArgs.field)) || '').trim();
    if (label) actualLabels.push(label);
  }
  if (!actualLabels.length) return { matched: true, reason: 'no_actual_label' };

  const expectedTokens = identityTokens([
    step && step.element,
    step && step.target,
    step && step.locator_hint,
    step && step.field,
    step && step.fieldRole,
    step && step.verify && step.verify.field && step.verify.field.name,
  ].filter(Boolean).join(' '));
  if (!expectedTokens.length) return { matched: true, reason: 'no_expected_identity' };

  const expected = new Set(expectedTokens);
  const misses = [];
  for (const label of actualLabels) {
    const actual = identityTokens(label);
    if (!actual.length) continue;
    const hit = actual.some((t) => expected.has(t)) || expectedTokens.some((t) => actual.includes(t));
    if (!hit) misses.push({ label, actual });
  }
  if (!misses.length) return { matched: true };
  return { matched: false, expected: expectedTokens, actual: misses.flatMap((m) => m.actual), labels: misses.map((m) => m.label) };
}

function isFillPreparationClickTool(toolName, step = {}, toolArgs = {}) {
  const tool = String(toolName || '');
  if (!FILL_PREPARATION_CLICK_TOOLS.has(tool)) return false;
  if (!isFillOrTypeStep(step)) return false;
  const idMatch = fillTargetMatchesStep(step, toolArgs);
  return !idMatch || idMatch.matched !== false;
}

module.exports = {
  ROLE_CONTRACT,
  autoApplyAgentRewritesEnabled,
  actionVerb,
  stepCompletionKind,
  isStepUtilityTool,
  isToggleStep,
  isFillOrTypeStep,
  isNavigateStep,
  isClickStep,
  isSelectStep,
  toolCanCompleteStep,
  stepCompletionBlockReason,
  isFillPreparationClickTool,
  clickTargetMatchesStep,
  fillTargetMatchesStep,
  identityTokens,
};
