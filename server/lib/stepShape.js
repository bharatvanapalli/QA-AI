'use strict';

const { normalizeStepsInput } = require('../services/reliability/contracts');

// One authored test case may contain a long, continuous business flow. Keep
// this limit shared with Architect so prompt guidance and normalization cannot
// drift back to a small-case assumption. Over-limit cases are rejected by the
// authoring boundary rather than silently truncated.
const MAX_AUTHORED_CASE_STEPS = 100;

/**
 * Phase F.3 — canonical TestCase step shape.
 *
 * BACKGROUND (the bug this exists to kill):
 *
 * Before this module existed, the Architect emitted approved-step objects shaped
 * `{ action, target, value, expected }` where `target` was a free-form blob —
 * sometimes a human description ("Login button"), sometimes a CSS selector
 * ("#username"), sometimes a role+name string (`button "Login"`).
 *
 * The Conductor JSON-stringified these step objects and embedded them in the
 * agent prompt as "approved steps". Claude reads the prompt, sees `target:` on
 * every step, and copies the same field name when it calls MCP tools — passing
 * e.g. `browser_click({ target: "ref=e59" })`. But official Microsoft
 * `@playwright/mcp` tools take `element` + `ref`, NOT `target`. Every such call
 * fails with "Unknown engine 'ref'" or "Unexpected token while parsing CSS";
 * the agent retries, burns turns, eventually hits the loop / turn-ceiling
 * guard, and the case ends up blocked or failed. We were watching the agent
 * fight our own prompt.
 *
 * FIX:
 *
 * Steps now carry TWO orthogonal fields with clear semantics:
 *
 *   - element       : human description ("Login submit button"). Maps DIRECTLY
 *                     to the official tool's `element` parameter. This is the
 *                     PRIMARY field every Conductor / Critic / Supervisor read
 *                     should use.
 *   - locator_hint  : OPTIONAL CSS selector hint. The Architect supplies this
 *                     when it has a confident selector; the agent uses it to
 *                     disambiguate inside the snapshot when role+name is
 *                     ambiguous. NEVER passed as a tool argument — it's a hint
 *                     for the agent, not a contract.
 *
 * The `target` field is RETAINED on the output of this normalizer (set to
 * whichever of element/locator_hint is non-null) so legacy renderers continue
 * to work without throwing. New consumers should prefer `element` /
 * `locator_hint` explicitly.
 *
 * BACKWARDS-COMPAT READ:
 *
 * Existing approved test cases in the DB store steps as
 * `{ action, target, value, expected }`. When this normalizer reads a legacy
 * step, it splits `target` into the new fields:
 *
 *   - If `target` looks like a CSS selector / XPath / role-name expression
 *     → put it in locator_hint, leave element null (the agent uses snapshot
 *     to resolve a description from the hint).
 *   - Otherwise → put it in element (it was a description all along).
 *
 * Heuristic for "looks like CSS": starts with `#`, `.`, `[`, contains `::`,
 * `:has-text`, `:nth-`, or matches the role-name pattern `<word> "<text>"`.
 * Tunable; on a miss the agent still gets a usable string in element.
 *
 * Idempotent: passing an already-new-shape step through returns the same
 * shape unchanged.
 */

const CSS_LIKE_HEAD = /^[#.[]/;
const CSS_LIKE_PSEUDO = /::?[a-z-]+|:has-text|:nth-/i;
const ROLE_NAME = /^[a-z][a-z_-]*\s+["'][^"']+["']\s*$/i;
const EXPECTED_KINDS = new Set([
  'input_state',
  'control_state',
  'action_state',
  'page_state',
  'url_state',
  'visible_text',
  'none',
]);

const OPERATION_CHECK_KIND_BY_EXPECTED_KIND = {
  input_state: 'input_accepted',
  control_state: 'control_state',
  action_state: 'action_completed',
  page_state: 'page_ready',
  url_state: 'url_reached',
  visible_text: 'visible_text_ready',
};

function actionTextFromContext(context = {}) {
  return cleanString(context.action || context.verb || context.toolName || '', 120) || '';
}

function targetTextFromContext(context = {}) {
  return cleanString(
    context.element || context.target || context.field || context.label || context.locator_hint || '',
    180
  );
}

function looksLikeUrlExpectation(value) {
  const text = String(value || '').trim();
  return /^https?:\/\//i.test(text) || /^\//.test(text) || /\b(url|redirect|route|path)\b/i.test(text);
}

function inferOperationKindFromContext(context = {}) {
  const action = actionTextFromContext(context).toLowerCase();
  const target = String(targetTextFromContext(context) || '').toLowerCase();
  const expected = String(context.expected || '').toLowerCase();

  if (/\b(fill|type|enter|input|provide|populate|write)\b/.test(action)) return 'input_accepted';
  if (/\b(select|choose|pick|check|uncheck|toggle|enable|disable|set)\b/.test(action)) return 'control_state';
  if (/\b(color|theme|style|font|css|class)\b/.test(`${action} ${target} ${expected}`)) return 'style_changed';
  if (/\b(menu|dropdown|drop\s*down|popover|drawer)\b/.test(`${target} ${expected}`)
      && /\b(click|open|expand|press|tap)\b/.test(action)) return 'menu_opened';
  if (/\b(navigate|open|visit|go\s*to|load)\b/.test(action)) {
    return looksLikeUrlExpectation(context.expected) ? 'url_reached' : 'page_ready';
  }
  if (/\b(verify|validate|check|confirm)\b/.test(action)) {
    if (looksLikeUrlExpectation(context.expected)) return 'url_reached';
    if (/\b(page|form|screen|loaded|ready|visible|displayed|shown|appears|redirect|dashboard|login|module|heading|navigation|authenticated)\b/.test(expected)) {
      return 'page_ready';
    }
    return 'state_ready';
  }
  if (/\b(click|press|tap|submit|save|continue|next|login|logout)\b/.test(action)) {
    if (looksLikeUrlExpectation(context.expected)) return 'url_reached';
    if (/\b(page|form|screen|loaded|ready|visible|displayed|shown|appears|redirect|dashboard|login)\b/.test(expected)) return 'page_ready';
    return 'action_completed';
  }
  return null;
}

function sentenceForOperationKind(kind, context = {}, fallbackExpected = null) {
  const target = targetTextFromContext(context);
  const expected = cleanString(fallbackExpected || context.expected, 220);
  if (kind === 'input_accepted') {
    return target ? `${target} accepts the provided value` : 'Input accepts the provided value';
  }
  if (kind === 'menu_opened') {
    return expected || (target ? `${target} opens` : 'Menu opens');
  }
  if (kind === 'control_state') {
    return expected || (target ? `${target} reaches the requested state` : 'Control reaches the requested state');
  }
  if (kind === 'style_changed') {
    return expected || (target ? `${target} style changes as requested` : 'Style changes as requested');
  }
  if (kind === 'page_ready') {
    return expected || (target ? `${target} is ready` : 'Page is ready');
  }
  if (kind === 'url_reached') {
    return expected || 'Expected route is reached';
  }
  if (kind === 'action_completed') {
    return expected || (target ? `${target} action completes` : 'Action completes');
  }
  return expected;
}

function looksLikeSelector(s) {
  if (typeof s !== 'string' || !s.length) return false;
  if (CSS_LIKE_HEAD.test(s)) return true;
  if (CSS_LIKE_PSEUDO.test(s)) return true;
  if (ROLE_NAME.test(s)) return true;
  // Compound CSS like "button[type='submit']"
  if (/\[[^\]]+=/.test(s)) return true;
  return false;
}

function normaliseExpectedKind(value) {
  if (typeof value !== 'string') return null;
  const kind = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return EXPECTED_KINDS.has(kind) ? kind : null;
}

function cleanString(value, limit = 220) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, limit) : null;
}

function cloneBoundedObject(value, limit = 4000) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const json = JSON.stringify(value);
    return json.length <= limit ? JSON.parse(json) : null;
  } catch (_) {
    return null;
  }
}

function cloneBoundedArray(value, { itemLimit = 30, byteLimit = 12000 } = {}) {
  if (!Array.isArray(value)) return [];
  try {
    const json = JSON.stringify(value.slice(0, itemLimit));
    return json.length <= byteLimit ? JSON.parse(json) : [];
  } catch (_) {
    return [];
  }
}

function cleanElementLabel(val) {
  if (typeof val !== 'string' || !val.trim()) return null;
  let s = val.trim();
  // Strip leading/trailing quotes
  s = s.replace(/^['"`]+|['"`]+$/g, '').trim();
  // Strip trailing keywords like 'input, ' field, ' button, ' dropdown, input field, etc.
  s = s.replace(/['"`]?\s*(?:input\s*field|field|button|dropdown|combobox|textbox|checkbox|radio\s*button|options?|control|link)\s*$/i, '').trim();
  // Strip any lingering quotes
  s = s.replace(/^['"`]+|['"`]+$/g, '').trim();
  return s || null;
}

function actionFromAuthoredText(value) {
  const text = cleanString(value, 4000);
  if (!text) return null;
  const match = text.match(
    /^(?:(?:given|when|then|and|but|after|before|if|unless)\s+)?(?:the\s+user\s+)?(navigate|open|visit|go\s+to|click\s+and\s+hold|click|press|tap|submit|enter|fill|type|input|append|clear|read|select|multi\s*select|choose|pick|check|uncheck|tick|radio|upload|download|hover|scroll|expand|collapse|wait\s+for\s+state|wait\s+until|wait|verify|validate|assert|expect|confirm|ensure|print|measure|inspect|hold|switch\s+to\s+frame|switch\s+to\s+tab|switch\s+frame|switch\s+tab|switch|close\s+all\s+windows|close\s+all\s+tabs|close\s+tab|close\s+window|close)\b/i
  );
  if (!match) return null;
  const low = match[1].replace(/\s+/g, ' ').trim().toLowerCase();
  if (low === 'go to' || low === 'open' || low === 'visit') return 'Navigate';
  if (low === 'enter' || low === 'type' || low === 'input') return 'Fill';
  if (low === 'read' || low === 'validate' || low === 'assert' || low === 'confirm' || low === 'expect' || low === 'ensure') return 'Verify';
  if (low === 'multi select' || low === 'multiselect') return 'SelectMultiple';
  if (low === 'print' || low === 'measure') return 'Inspect';
  if (low === 'click and hold' || low === 'hold') return 'ClickAndHold';
  if (low === 'switch to frame' || low === 'switch frame') return 'SwitchFrame';
  if (low === 'switch to tab' || low === 'switch tab') return 'SwitchTab';
  if (low === 'close all windows' || low === 'close all tabs') return 'CloseAllTabs';
  if (low === 'close tab' || low === 'close window') return 'CloseTab';
  if (low === 'wait for state' || low === 'wait until') return 'WaitForState';
  if (low === 'tap' || low === 'submit') return 'Click';
  return low.charAt(0).toUpperCase() + low.slice(1);
}

// Preserve an authored wait contract across the persisted-step -> prompt seam.
// Keep the payload generic (including recovery metadata) while bounding the
// amount of untrusted JSON copied into an agent prompt.
function normaliseWaitContract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const json = JSON.stringify(value);
    if (json.length <= 4000) return JSON.parse(json);

    // Oversized diagnostic metadata must not erase the runtime-critical
    // contract. Retain its generic control fields as long as each one fits.
    const out = {};
    const priorityKeys = [
      'schema', 'kind', 'timeoutMs', 'timeout', 'pollIntervalMs', 'pollMs',
      'stableObservations', 'refreshAfterMs', 'recovery', 'condition',
      'expected', 'action', 'target', 'armBeforeAction', 'sensitive',
    ];
    for (const key of priorityKeys) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const candidate = JSON.stringify({ ...out, [key]: value[key] });
      if (candidate.length <= 4000) out[key] = JSON.parse(candidate)[key];
    }
    return Object.keys(out).length ? out : null;
  } catch (_) {
    return null;
  }
}

function normaliseOperationKind(value) {
  const text = cleanString(value, 80);
  return text ? text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'state_ready' : 'state_ready';
}

function normaliseOperationCheck(value, context = {}) {
  const explicit = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const text = explicit ? null : cleanString(value, 220);
  const expectedKind = normaliseExpectedKind(context.expectedKind);
  const inferredKind = !context.verificationPoint && expectedKind !== 'visible_text'
    ? inferOperationKindFromContext(context)
    : null;
  const defaultKind = OPERATION_CHECK_KIND_BY_EXPECTED_KIND[expectedKind] || inferredKind || 'state_ready';

  if (explicit) {
    let expected = cleanString(
      explicit.expected ?? explicit.value ?? explicit.text ?? explicit.label ?? explicit.description ?? context.expected,
      220
    );
    const target = cleanString(
      explicit.target ?? explicit.element ?? explicit.field ?? explicit.control ?? context.element ?? context.locator_hint,
      180
    );
    const kind = normaliseOperationKind(explicit.kind || explicit.type || explicit.check || defaultKind);
    expected = sentenceForOperationKind(kind, context, expected) || expected;
    const out = { kind };
    if (target) out.target = target;
    if (expected) out.expected = expected;
    if (Number.isFinite(Number(explicit.timeoutMs))) out.timeoutMs = Number(explicit.timeoutMs);
    if (typeof explicit.required === 'boolean') out.required = explicit.required;
    if (explicit.source) out.source = cleanString(explicit.source, 80);
    if (explicit.condition && typeof explicit.condition === 'object' && !Array.isArray(explicit.condition)) {
      out.condition = { ...explicit.condition };
    }
    return out;
  }

  if (text) {
    const out = { kind: defaultKind, expected: sentenceForOperationKind(inferredKind, context, text) || text };
    const target = cleanString(context.element || context.locator_hint, 180);
    if (target) out.target = target;
    return out;
  }

  if (context.expected && (expectedKind || inferredKind) && expectedKind !== 'none' && !context.verificationPoint) {
    const expected = cleanString(context.expected, 220);
    if (!expected) return null;
    const out = { kind: defaultKind, expected: sentenceForOperationKind(inferredKind, context, expected) || expected };
    const target = cleanString(context.element || context.locator_hint, 180);
    if (target) out.target = target;
    return out;
  }

  return null;
}

function actionLooksLike(action, re) {
  return re.test(String(action || '').trim().toLowerCase());
}

function urlFromStepContext({ action, value, expected, expectedKind } = {}) {
  if (!actionLooksLike(action, /\b(navigate|open|visit|go\s*to|load|click|submit|save|login|logout)\b/)) return null;
  if (normaliseExpectedKind(expectedKind) === 'url_state') {
    return cleanString(expected || value, 220);
  }
  if (looksLikeUrlExpectation(expected)) return cleanString(expected, 220);
  if (actionLooksLike(action, /\b(navigate|visit|go\s*to|load)\b/) && looksLikeUrlExpectation(value)) {
    return cleanString(value, 220);
  }
  if (actionLooksLike(action, /^open$/) && looksLikeUrlExpectation(value)) {
    return cleanString(value, 220);
  }
  return null;
}

function inferredVerifyForStep({ action, element, value, expected, expectedKind } = {}) {
  const fieldName = cleanString(element, 180);
  const typedValue = cleanString(value, 220);
  if (typedValue && actionLooksLike(action, /\b(fill|type|enter|input|provide|populate|write)\b/)) {
    const field = {};
    if (fieldName) field.name = fieldName;
    if (/\b(textbox|searchbox|combobox|spinbutton|input|field|password|username|email)\b/i.test(fieldName || '')) {
      field.role = 'textbox';
    }
    return { kind: 'value', field, equals: typedValue };
  }
  if (typedValue && actionLooksLike(action, /\b(select|choose|pick)\b/)) {
    const control = {};
    if (fieldName) control.name = fieldName;
    if (/\b(dropdown|combobox|select|status|role|type|option)\b/i.test(fieldName || '')) {
      control.role = 'combobox';
    }
    return { kind: 'selected', control, value: typedValue };
  }
  const url = urlFromStepContext({ action, value, expected, expectedKind });
  if (url) return { kind: 'url', url };
  return null;
}

function strengthenWeakVerify(verify, context = {}) {
  const inferred = inferredVerifyForStep(context);
  if (!inferred) return verify;
  if (!verify) return inferred;
  if (verify.kind === 'none') return inferred;
  return verify;
}

// A url-verify / Navigate value must be a real path, URL, or a bare {{token}} that resolves to one.
// Prose ("Browser navigates to {{role}} URL") can NEVER match the deterministic url checker, so it
// is a guaranteed-broken contract. Generic — keyed on URL shape, never a site string.
function isPathLikeUrl(u) {
  if (typeof u !== 'string') return false;
  const s = u.trim();
  if (!s || /\s/.test(s)) return false; // prose contains spaces
  return /^[a-z]+:\/\//i.test(s) || s.startsWith('/') || /^\{\{[a-zA-Z0-9_]+\}\}$/.test(s);
}

// Collapse redundant '//' in a URL/path (e.g. "/web/index.php//viewAdminModule") while preserving
// the scheme separator "http://". Generic string hygiene.
function collapseUrlSlashes(u) {
  if (typeof u !== 'string') return u;
  return u.replace(/([^:])\/{2,}/g, '$1/');
}

function normaliseOracleRef(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return cleanString(value.id || value.ref || value.assertionId || value.contractRef, 120);
  }
  return cleanString(value, 120);
}

/**
 * Convert any-shape step → canonical { order, action, element, locator_hint,
 * value, expected, target } shape. Returns null when the step is unparseable
 * (no action). Never throws.
 */
function normaliseStepShape(s, fallbackOrder = 0) {
  if (typeof s === 'string') s = { authoredText: s };
  if (!s || typeof s !== 'object') return null;
  const interpretation = cloneBoundedObject(s.interpretation || s.interpreted);
  const authoredText = [
    s.step,
    s.authoredText,
    s.authored_text,
    s.instruction,
    s.description,
    s.text,
  ].find((value) => typeof value === 'string') || '';
  const authoredTextForInference = cleanString(authoredText, 4000);
  const explicitAction = cleanString(s.action || s.verb || s.step || s.actionType || s.type, 120);
  let action = explicitAction
    || cleanString(interpretation && interpretation.action, 120)
    || actionFromAuthoredText(authoredTextForInference)
    || (authoredTextForInference ? 'Interpret' : '');
  if (!action) return null;

  // Map camelCase / human-authored action tokens
  const actionLower = action.toLowerCase().replace(/[^a-z]/g, '');
  if (actionLower === 'entertext' || actionLower === 'typetext' || actionLower === 'inputtext' || actionLower === 'fill' || actionLower === 'type' || actionLower === 'enter' || actionLower === 'write' || actionLower === 'populate') action = 'Fill';
  else if (actionLower === 'appendtext' || actionLower === 'append' || actionLower === 'addtext') action = 'Append';
  else if (actionLower === 'cleartext' || actionLower === 'clear' || actionLower === 'erase' || actionLower === 'empty') action = 'Clear';
  else if (actionLower === 'selectbyvisibletext' || actionLower === 'selectbyvalue' || actionLower === 'selectradio' || actionLower === 'select' || actionLower === 'choose' || actionLower === 'pick') action = 'Select';
  else if (actionLower === 'multiselect' || actionLower === 'selectmultiple' || actionLower === 'choosemultiple') action = 'SelectMultiple';
  else if (actionLower === 'clickandhold' || actionLower === 'hold' || actionLower === 'longpress') action = 'ClickAndHold';
  else if (actionLower === 'doubleclick' || actionLower === 'dblclick') action = 'DoubleClick';
  else if (actionLower === 'rightclick' || actionLower === 'contextclick') action = 'RightClick';
  else if (actionLower === 'hover' || actionLower === 'mouseover' || actionLower === 'moveto') action = 'Hover';
  else if (actionLower === 'presskey' || actionLower === 'hotkey' || actionLower === 'sendkeys' || actionLower === 'keypress' || actionLower === 'typekey' || actionLower === 'hitkey' || actionLower === 'hit') action = 'PressKey';
  else if (actionLower === 'click' || actionLower === 'tap' || actionLower === 'press') action = 'Click';
  else if (actionLower.startsWith('print') || actionLower === 'log' || actionLower === 'display' || actionLower === 'output' || actionLower === 'echo' || actionLower === 'show') action = 'Print';
  else if (actionLower.startsWith('measure') || actionLower.startsWith('examine') || actionLower.startsWith('observe') || actionLower === 'inspect' || actionLower === 'read' || actionLower === 'gettext') action = 'Inspect';
  else if (actionLower === 'acceptalert' || actionLower === 'confirmalert' || actionLower === 'okalert') action = 'AcceptAlert';
  else if (actionLower === 'dismissalert' || actionLower === 'cancelalert') action = 'DismissAlert';
  else if (actionLower === 'typealert' || actionLower === 'promptalert' || actionLower === 'inputalert') action = 'TypeAlert';
  else if (actionLower.includes('alert') || actionLower.includes('dialog')) action = 'HandleAlert';
  else if (actionLower === 'checkcheckbox' || actionLower === 'check' || actionLower === 'tick' || actionLower === 'mark') action = 'Check';
  else if (actionLower === 'uncheck' || actionLower === 'untick' || actionLower === 'unmark') action = 'Uncheck';
  else if (actionLower === 'radio') action = 'Radio';
  else if (actionLower === 'draganddrop' || actionLower === 'drag' || actionLower === 'dragdrop') action = 'DragAndDrop';
  else if (actionLower === 'scrollintoview' || actionLower === 'scrollto' || actionLower === 'scroll') action = 'ScrollIntoView';
  else if (actionLower === 'upload' || actionLower === 'uploadfile' || actionLower === 'attachfile' || actionLower === 'attach') action = 'Upload';
  else if (actionLower === 'download' || actionLower === 'downloadfile') action = 'Download';
  else if (actionLower === 'slider' || actionLower === 'setslider' || actionLower === 'slide') action = 'Slider';
  else if (actionLower === 'screenshot' || actionLower === 'takescreenshot') action = 'Screenshot';
  else if (actionLower === 'evaluate' || actionLower === 'executescript' || actionLower === 'runscript') action = 'Evaluate';
  else if (actionLower === 'extractdata' || actionLower === 'storevariable' || actionLower === 'savedata') action = 'ExtractData';
  else if (actionLower.includes('switch') && actionLower.includes('tab')) action = 'SwitchTab';
  else if (actionLower.includes('switch') && actionLower.includes('frame')) action = 'SwitchFrame';
  else if (actionLower.includes('navigateback') || actionLower.includes('goback')) action = 'NavigateBack';
  else if (actionLower.includes('closeall')) action = 'CloseAllTabs';
  else if (actionLower.includes('close') && (actionLower.includes('tab') || actionLower.includes('window'))) action = 'CloseTab';
  else if (actionLower === 'navigate' || actionLower === 'open' || actionLower === 'visit' || actionLower === 'goto' || actionLower === 'load') action = 'Navigate';
  else if (actionLower === 'waitforstate' || actionLower === 'wait' || actionLower === 'pause' || actionLower === 'sleep') action = 'WaitForState';
  else if (actionLower === 'verify' || actionLower === 'assert' || actionLower === 'validate' || actionLower === 'confirm' || actionLower === 'ensure') action = 'Verify';

  let element = typeof s.element === 'string' && s.element.trim().length
    ? s.element.trim().slice(0, 200)
    : (typeof s.locator === 'string' && s.locator.trim().length
      ? s.locator.trim().slice(0, 200)
      : (typeof s.field === 'string' && s.field.trim().length
        ? s.field.trim().slice(0, 200)
        : (typeof s.button === 'string' && s.button.trim().length
          ? s.button.trim().slice(0, 200)
          : (typeof s.dropdown === 'string' && s.dropdown.trim().length
            ? s.dropdown.trim().slice(0, 200)
            : (typeof s.tab === 'string' && s.tab.trim().length
              ? s.tab.trim().slice(0, 200)
              : (typeof s.property === 'string' && s.property.trim().length
                ? s.property.trim().slice(0, 200)
                : (typeof s.target === 'string' && s.target.trim().length
                  ? s.target.trim().slice(0, 200)
                  : null)))))));
  let locator_hint = typeof s.locator_hint === 'string' && s.locator_hint.trim().length
    ? s.locator_hint.trim().slice(0, 200)
    : null;

  if (action === 'Inspect' && !s.value && s.property) {
    s.value = s.property;
  }
  if (action === 'Inspect' && !s.value && Array.isArray(s.properties)) {
    s.value = s.properties.join(', ');
  }
  if (action === 'SwitchTab' && !s.value && s.tab) {
    s.value = s.tab;
  }
  if (action === 'CloseTab' && !s.value && s.tab) {
    s.value = s.tab;
  }

  // Extract structured parts when action is an authored sentence
  const parsedVerb = actionFromAuthoredText(action);
  if (parsedVerb && (parsedVerb !== action || !element)) {
    const rawActionText = action;
    action = parsedVerb;
    if (!element) {
      const singleQuotes = Array.from(rawActionText.matchAll(/'([^']+)'/g)).map((m) => m[1].trim());
      if (singleQuotes.length > 1 && (parsedVerb === 'Fill' || parsedVerb === 'Append' || parsedVerb === 'Select')) {
        // First quote is value, second is element
        if (!s.value) s.value = singleQuotes[0];
        element = singleQuotes[singleQuotes.length - 1];
      } else if (singleQuotes.length > 0) {
        element = singleQuotes[singleQuotes.length - 1];
      }
    }
    if (!s.value) {
      const doubleQuoteMatch = rawActionText.match(/"([^"]+)"/);
      if (doubleQuoteMatch) {
        s.value = doubleQuoteMatch[1].trim();
      } else if (action === 'Navigate') {
        const urlMatch = rawActionText.match(/https?:\/\/[^\s'"]+/i);
        if (urlMatch) s.value = urlMatch[0].trim();
      }
    }
  }

  const semanticInstruction = !explicitAction
    || s.semanticInstruction === true
    || s.executionMode === 'semantic'
    || action === 'Interpret';
  if (!element && interpretation) {
    element = cleanString(interpretation.target || interpretation.element || interpretation.field, 200);
  }

  // Legacy `target` → split into the new fields when the new ones are empty.
  if (!element && !locator_hint && typeof s.target === 'string' && s.target.trim().length) {
    const t = s.target.trim().slice(0, 200);
    if (looksLikeSelector(t)) {
      locator_hint = t;
    } else {
      element = t;
    }
  }

  // Clean element name from enclosing quotes and trailing keywords (e.g. 'Enter your full Name'input -> Enter your full Name)
  if (element) {
    element = cleanElementLabel(element);
  }

  const interpretedValue = interpretation && (interpretation.value ?? interpretation.input);
  let value = typeof s.value === 'string' && s.value.length
    ? s.value.slice(0, 200)
    : (typeof s.input === 'string' && s.input.length
      ? s.input.slice(0, 200)
      : (typeof s.url === 'string' && s.url.length
        ? s.url.slice(0, 200)
        : (Array.isArray(s.values) && s.values.length
          ? s.values.join(', ')
          : (Array.isArray(s.properties) && s.properties.length
            ? s.properties.join(', ')
            : (typeof s.value === 'boolean' || Number.isFinite(s.value)
              ? s.value
              : (typeof interpretedValue === 'string' || typeof interpretedValue === 'boolean' || Number.isFinite(interpretedValue)
                ? (typeof interpretedValue === 'string' ? interpretedValue.slice(0, 200) : interpretedValue)
                : null))))));

  if (typeof value === 'string') {
    // Strip surrounding quotes if wrapped
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).trim();
    }
  }

  if (!s.verify) {
    const cond = typeof s.condition === 'string' ? s.condition.toLowerCase() : '';
    if (actionLower === 'verifydisabled' || cond === 'disabled') {
      s.verify = { kind: 'disabled' };
    } else if (actionLower === 'verifyreadonly' || cond === 'readonly' || cond === 'read only') {
      s.verify = { kind: 'readonly' };
    } else if (s.expected && typeof s.expected === 'string' && action === 'Verify') {
      s.verify = { kind: 'value', equals: s.expected };
    }
  }
  // Collapse redundant slashes in a URL-shaped Navigate value so a malformed
  // ".../index.php//viewAdminModule" can't ship.
  if (typeof value === 'string' && /^[a-z]+:\/\//i.test(value)) value = collapseUrlSlashes(value);
  const interpretedExpected = interpretation && (interpretation.validation ?? interpretation.expected);
  let expected = typeof s.expected === 'string' && s.expected.length
    ? s.expected.slice(0, 200)
    : (typeof s.validation === 'string' && s.validation.length
      ? s.validation.slice(0, 200)
      : (typeof s.expectedChange === 'string' && s.expectedChange.length
        ? s.expectedChange.slice(0, 200)
        : (typeof s.expected === 'boolean' || Number.isFinite(s.expected)
          ? s.expected
          : (typeof interpretedExpected === 'string' || typeof interpretedExpected === 'boolean' || Number.isFinite(interpretedExpected)
            ? (typeof interpretedExpected === 'string' ? interpretedExpected.slice(0, 200) : interpretedExpected)
            : null))));

  if (typeof expected === 'string') {
    if ((expected.startsWith('"') && expected.endsWith('"')) || (expected.startsWith("'") && expected.endsWith("'"))) {
      expected = expected.slice(1, -1).trim();
    }
  }
  const expectedKind = normaliseExpectedKind(s.expectedKind || s.expected_kind || s.assertionKind);
  const oracleRef = normaliseOracleRef(s.oracleRef || s.oracle_ref || s.assertionId || s.assertionRef || s.oracle);
  const verificationPoint = !!(s.verificationPoint === true
    || s.verifyAsOracle === true
    || s.businessAssertion === true
    || !!oracleRef
    || (s.oracle && typeof s.oracle === 'object' && !Array.isArray(s.oracle)));
  const operationCheck = normaliseOperationCheck(s.operationCheck || s.syncState || s.sync_state, {
    expected,
    expectedKind,
    action,
    element,
    locator_hint,
    value,
    verificationPoint,
  });
  const waitContract = normaliseWaitContract(s.waitContract || s.wait_contract);

  // TYPED VERIFICATION CONTRACT (the universal, deterministic checkpoint). The
  // architect emits `verify` per step and `stepKind` (action|verification); these
  // were previously DROPPED here, so the conductor never saw them and always fell
  // back to the fragile operationCheck heuristics. Carry them through so the
  // conductor's evaluateTypedExpectation runs deterministic checkers.
  let verify = strengthenWeakVerify(normaliseVerify(s.verify), {
    action,
    element,
    value,
    expected,
    expectedKind,
  });
  // Deterministic url-verify hygiene (the LLM is unreliable here): collapse '//', and if the url
  if (!element) {
    if (action === 'NavigateBack' || action === 'NavigateForward') element = 'Browser History';
    else if (action === 'Refresh') element = 'Current Page';
    else if (action === 'SetViewport') element = 'Browser Window';
    else if (action === 'AcceptAlert' || action === 'DismissAlert' || action === 'TypeAlert' || action === 'HandleAlert') element = 'Alert Dialog';
    else if (action === 'CloseAllTabs') element = 'All Windows';
    else if (action === 'CloseTab') element = 'Active Tab';
    else if (action === 'SwitchTab') element = 'New Tab';
    else if (action === 'SwitchFrame') element = 'Target Frame';
  }

  let stepKind = s.stepKind;
  if (stepKind === 'observation' || stepKind === 'verification' || stepKind === 'action') {
    // Valid explicit stepKind
  } else if (/^(inspect|print|read|observe|gettext|readtext)$/i.test(action)) {
    stepKind = 'observation';
  } else if (/^(verify|assert|validate|confirm|check|ensure)$/i.test(action) || actionLower.startsWith('verify') || actionLower.startsWith('assert')) {
    stepKind = 'verification';
  } else {
    stepKind = 'action';
  }
  const contractStepId = cleanString(s.contractStepId || s.contract_step_id || s.stepId || s.step_id || s.id, 180);
  const sourceContractStepId = cleanString(s.sourceContractStepId || s.source_contract_step_id || s.sourceStepId, 180);
  const logicalStepId = cleanString(s.logicalStepId || s.logical_step_id, 180);
  const origin = cleanString(s.origin || s.stepOrigin || s.step_origin, 80);
  const executionMode = cleanString(s.executionMode || (semanticInstruction ? 'semantic' : 'structured'), 40);
  const atomicActions = cloneBoundedArray(s.atomicActions || s.atomic_actions);
  const interpretationDiagnostics = cloneBoundedArray(
    s.interpretationDiagnostics || s.interpretation_diagnostics || s.diagnostics,
    { itemLimit: 20, byteLimit: 8000 }
  );
  const selectionCriteria = s.selectionCriteria && typeof s.selectionCriteria === 'object' && !Array.isArray(s.selectionCriteria)
    ? { ...s.selectionCriteria }
    : null;
  const condition = s.condition && typeof s.condition === 'object' && !Array.isArray(s.condition)
    ? { ...s.condition }
    : null;

  const out = {
    order: Number.isFinite(s.order) ? s.order : fallbackOrder,
    action,
    element,
    locator_hint,
    value,
    values: Array.isArray(s.values) && s.values.length
      ? s.values.map(v => String(v).trim())
      : (action === 'SelectMultiple' && typeof value === 'string' && value.includes(',')
        ? value.split(',').map(v => v.trim()).filter(Boolean)
        : undefined),
    expected,
    expectedKind,
    operationCheck,
    waitContract,
    verificationPoint,
    oracleRef,
    oracle: s.oracle && typeof s.oracle === 'object' && !Array.isArray(s.oracle) ? { ...s.oracle } : null,
    ...(authoredTextForInference ? { authoredText } : {}),
    ...(interpretation ? { interpretation } : {}),
    ...(atomicActions.length ? { atomicActions } : {}),
    ...(executionMode ? { executionMode } : {}),
    ...(semanticInstruction ? { semanticInstruction: true } : {}),
    ...(logicalStepId ? { logicalStepId } : {}),
    ...(Number.isFinite(Number(s.logicalOrdinal)) ? { logicalOrdinal: Number(s.logicalOrdinal) } : {}),
    ...(Number.isFinite(Number(s.atomicOrdinal)) ? { atomicOrdinal: Number(s.atomicOrdinal) } : {}),
    ...(Number.isFinite(Number(s.atomicCount)) ? { atomicCount: Number(s.atomicCount) } : {}),
    ...(interpretationDiagnostics.length ? { interpretationDiagnostics } : {}),
    ...(verify ? { verify } : {}),
    ...(stepKind ? { stepKind } : {}),
    ...(contractStepId ? { contractStepId } : {}),
    ...(sourceContractStepId ? { sourceContractStepId } : {}),
    ...(origin ? { origin } : {}),
    ...(selectionCriteria ? { selectionCriteria } : {}),
    ...(condition ? { condition } : {}),
    ...(s.helperOperation === true ? { helperOperation: true } : {}),
    ...(s.authored === true || s.authored === false ? { authored: s.authored === true } : {}),
    // `target` retained for legacy renderers — derived from whichever new field is set.
    target: element || locator_hint || null,
  };
  return out;
}

// Validate + carry the typed `verify` contract verbatim (bounded). kind ∈
// {none,url,value,selected,checked,visible,hidden,text}. Pass-through so the
// conductor's typed checkers receive the EXACT shape the architect authored
// (field/equals, element{role,name}, control/value, url, text) — no reshaping,
// no drift. Invalid/absent → null (step falls back to legacy heuristics).
function normaliseVerify(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const kind = typeof v.kind === 'string' ? v.kind.trim().toLowerCase() : '';
  const VALID = new Set(['none', 'url', 'value', 'selected', 'checked', 'visible', 'hidden', 'text']);
  if (!VALID.has(kind)) return null;
  try {
    const json = JSON.stringify({ ...v, kind });
    if (json.length > 2000) return { kind };
    return JSON.parse(json);
  } catch (_) { return { kind }; }
}

function coerceStepsArray(stepsInput) {
  const normalized = normalizeStepsInput(stepsInput, { allowSingletonObject: true });
  if (normalized.ok) return normalized.steps;
  if (typeof stepsInput === 'string' && stepsInput.trim()) return [stepsInput.trim()];
  if (stepsInput && typeof stepsInput === 'object') return [stepsInput];
  return [];
}

/** Apply normaliseStepShape across any persisted step shape without dropping non-empty authored instructions. */
function normaliseSteps(stepsInput) {
  const arr = coerceStepsArray(stepsInput);
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const n = normaliseStepShape(arr[i], i + 1);
    if (n) out.push(n);
  }
  return out;
}

/**
 * Serialize a step for inclusion in an LLM prompt. Drops nulls / legacy
 * `target` so the agent sees a clean, canonical shape and learns the right
 * field names.
 */
function serialiseStepForPrompt(s) {
  const norm = normaliseStepShape(s) || s;
  const out = { order: norm.order, action: norm.action };
  if (norm.element) out.element = norm.element;
  if (norm.locator_hint) out.locator_hint = norm.locator_hint;
  if (norm.value !== null && norm.value !== undefined) out.value = norm.value;
  if (norm.expected !== null && norm.expected !== undefined) out.expected = norm.expected;
  if (norm.expectedKind) out.expectedKind = norm.expectedKind;
  if (norm.operationCheck) out.operationCheck = norm.operationCheck;
  if (norm.waitContract) out.waitContract = norm.waitContract;
  if (norm.verificationPoint) out.verificationPoint = true;
  if (norm.oracleRef) out.oracleRef = norm.oracleRef;
  if (norm.oracle) out.oracle = norm.oracle;
  if (norm.verify) out.verify = norm.verify;
  if (norm.stepKind) out.stepKind = norm.stepKind;
  if (norm.contractStepId) out.contractStepId = norm.contractStepId;
  if (norm.sourceContractStepId) out.sourceContractStepId = norm.sourceContractStepId;
  if (norm.origin) out.origin = norm.origin;
  if (norm.selectionCriteria) out.selectionCriteria = norm.selectionCriteria;
  if (norm.condition) out.condition = norm.condition;
  if (norm.authoredText) out.authoredText = norm.authoredText;
  if (norm.interpretation) out.interpretation = norm.interpretation;
  if (Array.isArray(norm.atomicActions) && norm.atomicActions.length) out.atomicActions = norm.atomicActions;
  if (norm.executionMode) out.executionMode = norm.executionMode;
  if (norm.semanticInstruction === true) out.semanticInstruction = true;
  if (norm.semanticInstruction === true || norm.executionMode === 'semantic') {
    out.executionGuidance = 'The authoredText is authoritative. Treat interpretation and atomicActions as execution hints, adapt equivalent live-page labels and controls, use accessibility/page context and bounded recovery, and report failure only after a real execution attempt.';
  }
  if (norm.logicalStepId) out.logicalStepId = norm.logicalStepId;
  if (Number.isFinite(norm.logicalOrdinal)) out.logicalOrdinal = norm.logicalOrdinal;
  if (Number.isFinite(norm.atomicOrdinal)) out.atomicOrdinal = norm.atomicOrdinal;
  if (Number.isFinite(norm.atomicCount)) out.atomicCount = norm.atomicCount;
  if (Array.isArray(norm.interpretationDiagnostics) && norm.interpretationDiagnostics.length) {
    out.interpretationDiagnostics = norm.interpretationDiagnostics;
  }
  if (norm.helperOperation === true) out.helperOperation = true;
  if (norm.authored === true || norm.authored === false) out.authored = norm.authored;
  return out;
}

function serialiseStepsForPrompt(steps) {
  return normaliseSteps(steps).map(serialiseStepForPrompt);
}

module.exports = {
  MAX_AUTHORED_CASE_STEPS,
  normaliseStepShape,
  normaliseSteps,
  serialiseStepForPrompt,
  serialiseStepsForPrompt,
  looksLikeSelector,
  normaliseExpectedKind,
  normaliseOperationCheck,
  normaliseWaitContract,
};
