'use strict';

const crypto = require('crypto');
const actionLocatorResolver = require('./actionLocatorResolver');
const browserActionRegistry = require('./browserActionRegistry');

const SCHEMA_VERSION = 'qaai-live-script-ledger-v1';
const GUESSED_LOCATOR_WARNING = 'QAAI could not fetch this locator from the live DOM. This locator was guessed from the step role and functionality; replace it with a reliable DOM locator if needed.';

const EXPORTABLE_KINDS = new Set([
  'navigate',
  'navigateBack',
  'navigateForward',
  'fill',
  'type',
  'click',
  'doubleClick',
  'tripleClick',
  'hover',
  'selectOption',
  'check',
  'uncheck',
  'drag',
  'upload',
  'handleDialog',
  'resize',
  'close',
  'assert',
  'waitFor',
  'press',
]);

const UTILITY_TOOLS = new Set([
  'browser_snapshot',
  'browser_evaluate',
  'browser_network_requests',
  'browser_console_messages',
  'browser_take_screenshot',
  'debug_scan',
  'accessibility_scan',
  'dom_probe',
]);

function sha(value) {
  return crypto.createHash('sha1').update(String(value == null ? '' : value)).digest('hex').slice(0, 12);
}

function nowIso() {
  return new Date().toISOString();
}

function text(value) {
  return String(value == null ? '' : value).trim();
}

function decodeMaybeJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch (_) { return fallback; }
}

function safeLabel(value, fallback = 'target') {
  return text(value).replace(/\s+/g, ' ').slice(0, 120) || fallback;
}

function isInternalTargetLabel(value) {
  return /^(?:el|element|ref|node|target|control)[-_]?\d+$/i.test(text(value));
}

function publicTargetLabel(value, kind = 'action') {
  const label = safeLabel(value, '');
  if (label && !isInternalTargetLabel(label)) return label;
  const normalized = text(kind).toLowerCase();
  if (['fill', 'type'].includes(normalized)) return 'input field';
  if (normalized === 'select') return 'selection field';
  if (['check', 'uncheck'].includes(normalized)) return 'checkbox';
  if (['click', 'doubleclick', 'tripleclick'].includes(normalized)) return 'interactive button';
  if (normalized === 'hover') return 'interactive element';
  if (normalized === 'waitfor') return 'expected page element';
  return `${normalized || 'action'} target`;
}

function words(value, fallback = 'item') {
  const parts = text(value).toLowerCase().match(/[a-z0-9]+/g) || [];
  return parts.length ? parts : [fallback];
}

function pascalCase(value, fallback = 'Item') {
  return words(value, fallback).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

function camelCase(value, fallback = 'item') {
  const p = pascalCase(value, fallback);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

function uniqueName(base, used) {
  const root = camelCase(base || 'item', 'item');
  let name = root;
  let index = 2;
  while (used.has(name)) {
    name = `${root}${index}`;
    index += 1;
  }
  used.add(name);
  return name;
}

function jsLiteral(value) {
  return JSON.stringify(String(value == null ? '' : value));
}

function envNameFromRef(ref, fallback = 'QAAI_VALUE') {
  const raw = text(ref);
  if (!raw) return fallback;
  const m = raw.match(/^(?:env|vault|fixture|masked|data|secret|value):(.+)$/i);
  const body = (m ? m[1] : raw).replace(/[{}]/g, '');
  const safe = body.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'VALUE';
  if (/^vault:/i.test(raw)) return `QAAI_VAULT_${safe}`;
  if (/^fixture:/i.test(raw)) return `QAAI_FIXTURE_${safe}`;
  if (/^masked:/i.test(raw)) return `QAAI_MASKED_${safe}`;
  if (/^data:/i.test(raw)) return `QAAI_DATA_${safe}`;
  if (/^secret:/i.test(raw)) return `QAAI_SECRET_${safe}`;
  return safe.startsWith('QAAI_') ? safe : `QAAI_${safe}`;
}

function runtimeValueExpression(valueRef, fallbackName = 'QAAI_VALUE') {
  return `runtimeValue(${jsLiteral(envNameFromRef(valueRef, fallbackName))})`;
}

function normalizeLocatorExpression(expression) {
  const raw = text(expression);
  if (!raw) return null;
  if (/^page\./.test(raw)) return raw;
  if (/^(?:locator|getByRole|getByLabel|getByPlaceholder|getByText|getByTestId|getByTitle|getByAltText|frameLocator)\s*\(/.test(raw)) {
    return `page.${raw}`;
  }
  if (/^(?:css=|xpath=|text=|#[\w-]+|\.[\w-]+|\[.+\]|\/{1,2})/.test(raw)) {
    return `page.locator(${jsLiteral(raw)})`;
  }
  return null;
}

function locatorExpressionFromRecipe(locator) {
  if (!locator) return null;
  if (typeof locator === 'string') return normalizeLocatorExpression(locator);
  const primary = actionLocatorResolver.primaryActionLocator(locator);
  return normalizeLocatorExpression(primary?.frameworkExpressions?.playwright)
    || normalizeLocatorExpression(primary?.expression)
    || normalizeLocatorExpression(primary?.selector)
    || normalizeLocatorExpression(locator.frameworkExpressions?.playwright)
    || normalizeLocatorExpression(locator.primaryExpression)
    || normalizeLocatorExpression(locator.expression)
    || normalizeLocatorExpression(locator.selector)
    || normalizeLocatorExpression(locator.locator)
    || normalizeLocatorExpression(locator.playwright);
}

function locatorExpressionFromCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const direct = normalizeLocatorExpression(candidate.expression)
    || normalizeLocatorExpression(candidate.frameworkExpressions?.playwright)
    || normalizeLocatorExpression(candidate.selectorExpression);
  if (direct) return direct;
  const strategy = text(candidate.strategy).toLowerCase();
  if (strategy === 'role' && candidate.role && (candidate.name || candidate.text)) {
    return `page.getByRole(${jsLiteral(candidate.role)}, { name: ${jsLiteral(candidate.name || candidate.text)} })`;
  }
  if (strategy === 'label' && (candidate.text || candidate.name)) return `page.getByLabel(${jsLiteral(candidate.text || candidate.name)})`;
  if (strategy === 'placeholder' && (candidate.text || candidate.name)) return `page.getByPlaceholder(${jsLiteral(candidate.text || candidate.name)})`;
  if (strategy === 'text' && (candidate.text || candidate.name)) return `page.getByText(${jsLiteral(candidate.text || candidate.name)}, { exact: false })`;
  if ((strategy === 'testid' || strategy === 'test_id') && (candidate.testId || candidate.value)) {
    return `page.getByTestId(${jsLiteral(candidate.testId || candidate.value)})`;
  }
  if ((strategy === 'css' || strategy === 'xpath') && candidate.selector) return `page.locator(${jsLiteral(candidate.selector)})`;
  return null;
}

function locatorExpressionFromResolve(resolve) {
  if (!resolve || typeof resolve !== 'object') return null;
  return locatorExpressionFromRecipe(resolve.actionLocator)
    || locatorExpressionFromRecipe(resolve.locatorRecipe)
    || normalizeLocatorExpression(resolve.locatorProvenance?.chosenExpression)
    || (Array.isArray(resolve.candidates)
      ? resolve.candidates.map(locatorExpressionFromCandidate).find(Boolean) || null
      : null);
}

function semanticLabelFromResolve(resolve, fallback) {
  return safeLabel(
    resolve && (resolve.elementLabel
      || resolve.narration
      || resolve.label
      || resolve.name
      || resolve.locatorProvenance?.semanticLabel
      || resolve.actionLocator?.targetFacts?.accessibleName)
      || fallback,
    'target',
  );
}

function locatorStrategyFromExpression(expression) {
  const raw = text(expression);
  if (!raw) return 'missing';
  if (/getByTestId\s*\(/i.test(raw) || /\[(?:data-testid|data-test-id|data-test|data-qa|data-cy|data-pw|data-automation-id)=/i.test(raw)) return 'testid';
  if (/getByRole\s*\([^)]*name\s*:/i.test(raw)) return 'role_name';
  if (/getByLabel\s*\(/i.test(raw)) return 'label';
  if (/getByPlaceholder\s*\(/i.test(raw)) return 'placeholder';
  if (/getByTitle\s*\(/i.test(raw)) return 'title';
  if (/getByAltText\s*\(/i.test(raw)) return 'alt';
  if (/locator\s*\([^)]*\[(?:aria-label|name|autocomplete|placeholder|title|alt|href|type)=/i.test(raw)) return 'stable_attribute';
  if (/locator\s*\([^)]*\)\s*\.\s*getBy(?:Role|Label|Placeholder|Text|TestId|Title|AltText)\s*\(/i.test(raw)) return 'scoped_semantic';
  if (/getByText\s*\(/i.test(raw)) return 'visible_text';
  if (/locator\s*\(/i.test(raw)) return 'scoped_css';
  return 'unknown';
}

function locatorWarningsForExpression(expression, locator = {}) {
  locator = locator && typeof locator === 'object' ? locator : {};
  const raw = text(expression);
  const warnings = [];
  if (!raw) {
    warnings.push('missing_locator');
    return warnings;
  }
  if (/:(?:nth-of-type|nth-child)\s*\(/i.test(raw) || /\.nth\s*\(/i.test(raw)) warnings.push('structural_position_selector');
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(raw)) warnings.push('dynamic_uuid');
  if (/\b(?:css|ng|mui|chakra|ant|sc|emotion|jss|v|svelte|module)[_-]?[a-z]*[_-][A-Za-z0-9_-]{5,}\b/.test(raw)) warnings.push('generated_class_like_selector');
  if (/(?:user|session|tenant|account|token|auth)[_-]?[0-9a-f]{6,}/i.test(raw)) warnings.push('session_specific_selector');
  if (/getByText\s*\(\s*['"`][^'"`]*(?:@|Welcome\s+\w+|[0-9]{4,}|user\s+\w+)/i.test(raw)) warnings.push('session_or_data_specific_text');

  const proof = locator && typeof locator === 'object' ? locator.proof || locator.evidence || locator.verification || {} : {};
  const count = Number(proof.count ?? proof.matchCount ?? locator.count ?? locator.matchCount);
  if (Number.isFinite(count) && count > 1) warnings.push('hidden_or_duplicate_matches');
  if (proof.visible === false || locator.visible === false) warnings.push('not_visible_at_capture');
  if (locator.uniqueBeforeNavigationOnly || locator.uniqueOnlyBeforeNavigation) warnings.push('unique_only_before_navigation');
  return [...new Set(warnings)];
}

function normalizeLocatorStrategy(strategy, expression, locator = {}) {
  const raw = String(strategy || 'unknown')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/-/g, '_');
  if (['testid', 'test_id', 'data_testid', 'data_test_id', 'data_test', 'data_qa', 'data_cy', 'data_pw', 'data_automation_id'].includes(raw)) return 'testid';
  if (raw === 'role' && (locator.name || /getByRole\s*\([^)]*name\s*:/i.test(String(expression || '')))) return 'role_name';
  if (raw === 'css_attr' || raw === 'css_stable_attr') return 'stable_attribute';
  if (/^scoped_(role|label|placeholder)$/.test(raw)) return 'scoped_semantic';
  if (/^scoped_css$/.test(raw)) return 'scoped_css';
  return raw;
}

function assessLocatorHealth(expression, locator = {}, { fallbackUsed = false } = {}) {
  locator = locator && typeof locator === 'object' ? locator : {};
  const normalized = normalizeLocatorExpression(expression);
  const strategy = normalizeLocatorStrategy(
    locator?.strategy || locator?.locatorStrategy || locatorStrategyFromExpression(normalized || expression),
    normalized || expression,
    locator,
  );
  const warnings = locatorWarningsForExpression(normalized || expression, locator);
  let stability = 'weak';
  if (!normalized) stability = 'weak';
  else if (['testid', 'role_name', 'label'].includes(strategy)) stability = 'strong';
  else if (['placeholder', 'title', 'alt', 'stable_attribute', 'scoped_semantic'].includes(strategy)) stability = 'medium';
  else if (strategy === 'visible_text') stability = 'medium';
  else if (strategy === 'scoped_css') stability = 'medium';

  if (fallbackUsed) stability = 'weak';
  if (warnings.some((w) => ['structural_position_selector', 'dynamic_uuid', 'generated_class_like_selector', 'hidden_or_duplicate_matches', 'not_visible_at_capture', 'unique_only_before_navigation'].includes(w))) {
    stability = 'weak';
  } else if (warnings.length && stability === 'strong') {
    stability = 'medium';
  }

  return {
    expression: normalized || null,
    locatorStability: stability,
    locatorSource: strategy || 'unknown',
    locatorWarnings: warnings,
    fallbackUsed: !!fallbackUsed,
  };
}

function locatorFromEntry(entry = {}, result = {}) {
  return locatorExpressionFromRecipe(entry.actionLocator)
    || locatorExpressionFromRecipe(entry.qaaiActionLocator)
    || locatorExpressionFromRecipe(entry.codegenLocator)
    || locatorExpressionFromRecipe(entry.locatorDiagnostic)
    || locatorExpressionFromRecipe(result.qaaiActionLocator)
    || locatorExpressionFromRecipe(result.actionLocator)
    || locatorExpressionFromRecipe(result.codegenLocator)
    || locatorExpressionFromRecipe(result.locatorRecipe);
}

function locatorRecipeFromEntry(entry = {}, result = {}) {
  return entry.actionLocator
    || entry.qaaiActionLocator
    || entry.codegenLocator
    || entry.locatorDiagnostic
    || result.qaaiActionLocator
    || result.actionLocator
    || result.codegenLocator
    || result.locatorRecipe
    || null;
}

function locatorFromEvidence(evidence = {}, recipes = []) {
  const directRecipe = evidence.actionLocator
    || evidence.locatorRecipe
    || decodeMaybeJson(evidence.locatorRecipeJson, null);
  const direct = locatorExpressionFromRecipe(directRecipe);
  if (direct) {
    return {
      expression: direct,
      recipe: directRecipe,
      verified: actionLocatorResolver.isVerifiedActionLocator(directRecipe),
    };
  }
  const matching = recipes.find((recipe) => {
    if (!recipe) return false;
    if (evidence.locatorRecipeId && recipe.id && String(recipe.id) === String(evidence.locatorRecipeId)) return true;
    return linesShareOccurrenceIdentity(evidence, recipe);
  });
  const matchedRecipe = decodeMaybeJson(matching?.locatorRecipeJson, null) || matching || null;
  const expression = locatorExpressionFromRecipe(matchedRecipe);
  return {
    expression: expression || null,
    recipe: matchedRecipe,
    verified: !!expression && actionLocatorResolver.isVerifiedActionLocator(matchedRecipe),
  };
}

function weakFallbackLocator(target, kind = 'action') {
  const label = publicTargetLabel(target, kind);
  const normalizedKind = text(kind).toLowerCase();
  if (!label) return { expression: 'page.locator("body")', stability: 'weak', reason: 'no_target' };
  if (isInternalTargetLabel(target)) {
    if (['fill', 'type'].includes(normalizedKind)) return { expression: 'page.getByRole("textbox").first()', stability: 'weak', reason: 'semantic_role_fallback' };
    if (normalizedKind === 'select') return { expression: 'page.getByRole("combobox").first()', stability: 'weak', reason: 'semantic_role_fallback' };
    if (['check', 'uncheck'].includes(normalizedKind)) return { expression: 'page.getByRole("checkbox").first()', stability: 'weak', reason: 'semantic_role_fallback' };
    if (['click', 'doubleclick', 'tripleclick'].includes(normalizedKind)) return { expression: 'page.getByRole("button").first()', stability: 'weak', reason: 'semantic_role_fallback' };
    return { expression: 'page.locator("[role], button, a, input, select, textarea").first()', stability: 'weak', reason: 'semantic_role_fallback' };
  }
  const escaped = jsLiteral(label);
  if (/email|username|password|phone|skype|field|textbox|input/i.test(label)) {
    return { expression: `page.getByLabel(${escaped})`, stability: 'weak', reason: 'label_text_fallback' };
  }
  if (/button|continue|next|submit|sign in|save|cancel|search|add|delete|edit/i.test(label)) {
    return { expression: `page.getByRole('button', { name: ${escaped} })`, stability: 'weak', reason: 'role_name_fallback' };
  }
  return { expression: `page.getByText(${escaped}).first()`, stability: 'weak', reason: 'text_fallback' };
}

function deterministicDomActionKind(toolName, entry = {}) {
  const tool = text(toolName || entry.tool || entry.toolName);
  const direct = tool.match(/^deterministic_dom_(fill|click|select|check|upload)(?:_recovery)?$/i);
  if (direct) return direct[1].toLowerCase();
  if (tool !== 'browser_evaluate') return null;
  const source = text(entry.source || entry.qaaiSource || entry.args?.source);
  const legacy = source.match(/deterministic_dom_(fill|click|select|check|upload)/i);
  return legacy ? legacy[1].toLowerCase() : null;
}

function actionKindForTool(toolName, entry = {}) {
  const tool = text(toolName || entry.tool || entry.toolName);
  if (tool === 'browser_fill_form') return 'fill_form';
  if (tool === 'assertion_check') return 'assert';
  const deterministicKind = deterministicDomActionKind(tool, entry);
  if (deterministicKind) return deterministicKind === 'select' ? 'selectOption' : deterministicKind;
  const registered = browserActionRegistry.getActionEntry(tool);
  if (registered && registered.kind !== 'utility') {
    const replayKind = text(registered.replayIrMapping || registered.canonicalAction);
    return replayKind || text(registered.canonicalAction) || 'unknown';
  }
  if (tool === 'browser_upload_file') return 'upload';
  return tool.replace(/^browser_/, '') || text(entry.action || entry.type) || 'unknown';
}

const RUNTIME_TOOL_FOR_ACTION_KIND = Object.freeze({
  navigate: 'browser_navigate',
  navigateBack: 'browser_navigate_back',
  navigateForward: 'browser_navigate_forward',
  click: 'browser_click',
  doubleClick: 'browser_double_click',
  tripleClick: 'browser_triple_click',
  fill: 'browser_fill',
  type: 'browser_type',
  selectOption: 'browser_select_option',
  check: 'browser_check',
  uncheck: 'browser_uncheck',
  press: 'browser_press_key',
  hover: 'browser_hover',
  drag: 'browser_drag',
  upload: 'browser_file_upload',
  handleDialog: 'browser_handle_dialog',
  resize: 'browser_resize',
  close: 'browser_close',
  waitFor: 'browser_wait_for',
});

function runtimeToolForActionKind(kind) {
  return RUNTIME_TOOL_FOR_ACTION_KIND[text(kind)] || `browser_${text(kind) || 'unknown'}`;
}

function isUtilityTool(toolName) {
  const tool = text(toolName);
  return UTILITY_TOOLS.has(tool) || browserActionRegistry.isUtilityTool(tool);
}

function isExportableKind(kind) {
  return EXPORTABLE_KINDS.has(text(kind));
}

function isExportableTool(toolName, entry = {}) {
  const tool = text(toolName);
  const registered = browserActionRegistry.getActionEntry(tool);
  if (registered) {
    return registered.kind !== 'utility'
      && registered.exportable === true
      && isExportableKind(actionKindForTool(tool, entry));
  }
  if (isExportableKind(actionKindForTool(tool, entry))) return true;
  if (tool === 'browser_evaluate') {
    const source = text(entry.source || entry.qaaiSource || entry.args?.source);
    return /deterministic_dom_(fill|click|select|check|upload)/i.test(source);
  }
  return false;
}

function explicitValueRefFromArgs(args = {}) {
  if (!args || typeof args !== 'object') return null;
  return args.valueRef || args.valueToken || args.dataRole || args.fieldRole || null;
}

function literalValueFromArgs(args = {}) {
  if (!args || typeof args !== 'object') return undefined;
  for (const key of ['value', 'text', 'input']) {
    if (Object.prototype.hasOwnProperty.call(args, key) && args[key] != null) return args[key];
  }
  return undefined;
}

function valueBindingForArgs(args = {}, target = '', fallbackName = 'QAAI_VALUE') {
  const explicitRef = explicitValueRefFromArgs(args);
  if (explicitRef) {
    const valueRef = envNameFromRef(explicitRef, fallbackName);
    return { valueRef, literalValue: undefined, expression: runtimeValueExpression(valueRef, fallbackName) };
  }
  const sensitive = args.sensitive === true
    || args.secret === true
    || /password|passcode|secret|token|credential|one[- ]?time|\botp\b|\bpin\b/i.test(text(target));
  if (sensitive) {
    const valueRef = envNameFromRef(null, fallbackName === 'QAAI_VALUE' ? 'QAAI_SECRET_VALUE' : fallbackName);
    return { valueRef, literalValue: undefined, expression: runtimeValueExpression(valueRef, fallbackName) };
  }
  const literalValue = literalValueFromArgs(args);
  if (literalValue !== undefined) {
    return { valueRef: null, literalValue, expression: jsLiteral(literalValue) };
  }
  const valueRef = envNameFromRef(null, fallbackName);
  return { valueRef, literalValue: undefined, expression: runtimeValueExpression(valueRef, fallbackName) };
}

function commandFor({ kind, locator, args = {}, target = '' }) {
  if (kind === 'navigate') {
    const url = args.url || args.href || args.targetUrl || target || '';
    return {
      playwright: `await page.goto(${url ? jsLiteral(url) : 'process.env.QAAI_TARGET_URL || "about:blank"'});`,
      concrete: true,
    };
  }
  if (kind === 'navigateBack') return { playwright: 'await page.goBack();', concrete: true };
  if (kind === 'navigateForward') return { playwright: 'await page.goForward();', concrete: true };
  if (kind === 'resize') {
    const viewport = args.viewport && typeof args.viewport === 'object' ? args.viewport : args;
    const width = Number(viewport.width);
    const height = Number(viewport.height);
    if (Number.isFinite(width) && Number.isFinite(height)) {
      return { playwright: `await page.setViewportSize({ width: ${Math.floor(width)}, height: ${Math.floor(height)} });`, concrete: true };
    }
    return { playwright: '// Unable to emit resize without a concrete width and height.', concrete: false };
  }
  if (kind === 'close') return { playwright: 'await page.close();', concrete: true };
  if (kind === 'handleDialog') {
    const accept = args.accept !== false && String(args.action || '').toLowerCase() !== 'dismiss';
    const promptText = args.promptText == null ? null : args.promptText;
    const handler = accept
      ? `dialog.accept(${promptText == null ? '' : jsLiteral(promptText)})`
      : 'dialog.dismiss()';
    return { playwright: `page.once('dialog', (dialog) => ${handler});`, concrete: true };
  }
  if (kind === 'assert') {
    const expected = args.expectedText || args.expected || args.assertion || target || '';
    if (args.expectedUrlPattern) {
      return { playwright: `await expect(page).toHaveURL(new RegExp(${jsLiteral(args.expectedUrlPattern)}));`, concrete: true };
    }
    if (locator && !expected) return { playwright: `await expect(${locator}).toBeVisible();`, concrete: true };
    if (locator) return { playwright: `await expect(${locator}).toContainText(${jsLiteral(expected)});`, concrete: true };
    return {
      playwright: `await expect(page.getByText(${jsLiteral(expected || 'QAAI assertion boundary')})).toBeVisible();`,
      concrete: true,
    };
  }
  if (kind === 'waitFor') {
    const timeoutMs = Number(args.timeoutMs || args.timeout);
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? `, timeout: ${Math.floor(timeoutMs)}` : '';
    if (locator) return { playwright: `await ${locator}.waitFor({ state: ${jsLiteral(args.state || 'visible')}${timeout} });`, concrete: true };
    if (args.text) return { playwright: `await page.getByText(${jsLiteral(args.text)}, { exact: false }).waitFor({ state: 'visible'${timeout} });`, concrete: true };
    if (args.textGone) return { playwright: `await page.getByText(${jsLiteral(args.textGone)}, { exact: false }).waitFor({ state: 'hidden'${timeout} });`, concrete: true };
    const seconds = Number(args.time ?? args.seconds);
    if (Number.isFinite(seconds) && seconds >= 0) return { playwright: `await page.waitForTimeout(${Math.floor(seconds * 1000)});`, concrete: true };
    return { playwright: '// Unable to emit authored wait without a concrete condition.', concrete: false };
  }
  if (kind === 'press' && !locator) {
    return { playwright: `await page.keyboard.press(${jsLiteral(args.key || args.value || 'Enter')});`, concrete: true };
  }
  if (!locator) {
    return { playwright: `// Unable to emit concrete ${kind} command without a target.`, concrete: false };
  }
  if (kind === 'click') return { playwright: `await ${locator}.click();`, concrete: true };
  if (kind === 'doubleClick') return { playwright: `await ${locator}.dblclick();`, concrete: true };
  if (kind === 'tripleClick') return { playwright: `await ${locator}.click({ clickCount: 3 });`, concrete: true };
  if (kind === 'hover') return { playwright: `await ${locator}.hover();`, concrete: true };
  if (kind === 'fill') return { playwright: `await ${locator}.fill(${valueBindingForArgs(args, target, 'QAAI_VALUE').expression});`, concrete: true };
  if (kind === 'type') return { playwright: `await ${locator}.pressSequentially(${valueBindingForArgs(args, target, 'QAAI_VALUE').expression});`, concrete: true };
  if (kind === 'selectOption') return { playwright: `await ${locator}.selectOption(${valueBindingForArgs(args, target, 'QAAI_SELECT_VALUE').expression});`, concrete: true };
  if (kind === 'check') return { playwright: `await ${locator}.check();`, concrete: true };
  if (kind === 'uncheck') return { playwright: `await ${locator}.uncheck();`, concrete: true };
  if (kind === 'upload') return { playwright: `await ${locator}.setInputFiles(${valueBindingForArgs(args, target, 'QAAI_UPLOAD_FILE').expression});`, concrete: true };
  if (kind === 'press') return { playwright: `await ${locator}.press(${jsLiteral(args.key || args.value || 'Enter')});`, concrete: true };
  if (kind === 'drag') {
    const sourceLocator = args.__dragSourceLocator || null;
    const targetLocator = args.__dragTargetLocator || locator;
    if (sourceLocator && targetLocator) {
      return { playwright: `await ${sourceLocator}.dragTo(${targetLocator});`, concrete: true };
    }
    return { playwright: '// Unable to emit drag until both action-time endpoint locators are verified.', concrete: false };
  }
  return { playwright: `// Unsupported action ${kind} on ${locator}`, concrete: false };
}

function newLedger(seed = {}) {
  return {
    schema: SCHEMA_VERSION,
    runResultId: seed.runResultId || null,
    testCaseId: seed.testCaseId || null,
    scriptMode: seed.scriptMode || 'interrupted_run_script',
    lines: [],
    utilityMetadata: [],
    health: {
      scriptConfidence: seed.scriptConfidence || 'medium',
      scriptHealth: seed.scriptHealth || 'generated',
      replayParity: seed.replayParity || 'not_checked',
      locatorStability: seed.locatorStability || 'unknown',
      weakLocatorCount: 0,
      missingStableLocatorCount: 0,
      nonRunnableLineCount: 0,
      reproducesRunFailure: false,
    },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function rebindLedger(ledger, { runResultId = null, testCaseId = null, scriptMode = null } = {}) {
  if (!ledger || typeof ledger !== 'object') return ledger;
  if (runResultId) ledger.runResultId = runResultId;
  if (testCaseId) ledger.testCaseId = testCaseId;
  if (scriptMode) ledger.scriptMode = scriptMode;
  for (const line of Array.isArray(ledger.lines) ? ledger.lines : []) {
    if (!line || typeof line !== 'object') continue;
    if (runResultId && (!line.runResultId || line.runResultId === 'shadow')) line.runResultId = runResultId;
    if (testCaseId && !line.testCaseId) line.testCaseId = testCaseId;
  }
  ledger.updatedAt = nowIso();
  refreshHealth(ledger);
  return ledger;
}

function scriptModeForStatus(status, { interrupted = false } = {}) {
  const normalized = text(status).toLowerCase();
  if (interrupted || /cancel|interrupt|timeout|aborted/.test(normalized)) return 'interrupted_run_script';
  if (normalized === 'fail' || normalized === 'failed') return 'failed_run_script';
  if (normalized === 'pass' || normalized === 'passed') return 'passed_run_script';
  return 'interrupted_run_script';
}

function lineIdFor(seed) {
  return `sl_${sha(JSON.stringify(seed))}_${crypto.randomUUID().slice(0, 8)}`;
}

function appendUtilityMetadata(ledger, entry = {}) {
  const attachedTo = [...(ledger.lines || [])].reverse().find((line) => line && line.canonical)?.id
    || [...(ledger.lines || [])].reverse().find((line) => line)?.id
    || null;
  ledger.utilityMetadata.push({
    id: lineIdFor({ utility: entry.tool, at: Date.now(), attachedTo }),
    attachedToScriptLineId: attachedTo,
    tool: entry.tool || entry.toolName || 'utility',
    label: safeLabel(entry.args?.element || entry.args?.target || entry.narration || entry.tool || 'utility action'),
    timestamp: nowIso(),
    source: entry.source || entry.qaaiSource || null,
  });
  ledger.updatedAt = nowIso();
  return ledger;
}

function appendScriptLine(ledger, input = {}) {
  if (!ledger || typeof ledger !== 'object') throw new Error('appendScriptLine requires a ledger');
  const entry = input.trailEntry || input.entry || {};
  const result = input.result || {};
  const tool = entry.tool || entry.toolName || input.tool;
  const kind = input.kind || actionKindForTool(tool, entry);
  const registered = browserActionRegistry.getActionEntry(tool);
  // assertion_check is deliberately a utility at the browser-tool boundary,
  // but evaluated assertions enter this recorder through their dedicated
  // assertion channel and must remain executable assertion lines.
  if (kind !== 'assert' && registered && registered.exportable !== true) return appendUtilityMetadata(ledger, entry);
  if (kind !== 'assert' && isUtilityTool(tool) && !isExportableTool(tool, entry)) return appendUtilityMetadata(ledger, entry);
  if (!isExportableKind(kind) && kind !== 'fill_form') return appendUtilityMetadata(ledger, entry);

  if (kind === 'fill_form' && Array.isArray(entry.args?.fields)) {
    for (const [index, field] of entry.args.fields.entries()) {
      const fieldLocator = locatorExpressionFromRecipe(field.actionLocator)
        || locatorExpressionFromRecipe(field.codegenLocator)
        || locatorFromEntry(entry, result);
      appendScriptLine(ledger, {
        ...input,
        trailEntry: {
          ...entry,
          tool: 'browser_fill',
          args: {
            ...field,
            element: field.element || field.label || field.name || field.placeholder || `field ${index + 1}`,
            ...((field.valueRef || field.dataRole || field.fieldRole)
              ? { valueRef: field.valueRef || field.dataRole || field.fieldRole }
              : {}),
          },
          actionLocator: field.actionLocator || entry.actionLocator,
          codegenLocator: field.codegenLocator || entry.codegenLocator,
        },
        kind: 'fill',
      });
    }
    return ledger;
  }

  const rawTarget = entry.args?.element || entry.args?.target || entry.args?.label || input.target || result.elementLabel || kind;
  const target = publicTargetLabel(rawTarget, kind);
  const locatorRecipe = input.locatorRecipe || locatorRecipeFromEntry(entry, result);
  let locator = input.locatorExpression || locatorFromEntry(entry, result);
  let locatorFallbackReason = input.locatorFallbackReason || null;
  let fallbackUsed = input.locatorFallbackUsed === true || input.locatorGuessed === true;
  const hasExplicitTarget = !!text(entry.args?.element || entry.args?.target || entry.args?.label || entry.args?.ref);
  const targetless = ['navigate', 'navigateBack', 'navigateForward', 'handleDialog', 'resize', 'close', 'assert'].includes(kind)
    || (kind === 'press' && !hasExplicitTarget)
    || (kind === 'waitFor' && !!(entry.args?.text || entry.args?.textGone || entry.args?.time != null || entry.args?.seconds != null));
  if (!locator && !targetless && kind !== 'drag') {
    const fallback = weakFallbackLocator(rawTarget, kind);
    locator = fallback.expression;
    locatorFallbackReason = fallback.reason;
    fallbackUsed = true;
  }
  const locatorGuessed = input.locatorGuessed === true || fallbackUsed;
  const locatorProvenance = input.locatorProvenance || (locatorGuessed ? {
    kind: 'qaai_guessed_locator',
    source: 'semantic_role_fallback',
    confidence: 'unverified',
    semanticLabel: target,
    chosenExpression: locator,
    warning: GUESSED_LOCATOR_WARNING,
  } : null);
  const locatorHealth = assessLocatorHealth(locator, locatorRecipe, { fallbackUsed: locatorGuessed });
  const dragContract = input.locatorRecipe || entry.actionLocator || entry.codegenLocator || null;
  const commandArgs = kind === 'drag'
    ? {
        ...(entry.args || {}),
        __dragSourceLocator: locatorExpressionFromRecipe(dragContract?.dragSourceLocator),
        __dragTargetLocator: locatorExpressionFromRecipe(dragContract?.dragTargetLocator) || locator,
      }
    : (entry.args || {});
  const command = commandFor({ kind, locator, args: commandArgs, target });
  const valueBinding = ['fill', 'type', 'selectOption', 'upload'].includes(kind)
    ? valueBindingForArgs(entry.args || {}, target, kind === 'selectOption' ? 'QAAI_SELECT_VALUE' : kind === 'upload' ? 'QAAI_UPLOAD_FILE' : 'QAAI_VALUE')
    : null;
  const inferredFailureBoundary = kind === 'assert' && entry.ok === false
    ? {
        expected: entry.args?.expectedText || entry.args?.expected || entry.args?.assertion || target || null,
        actual: entry.args?.actualText || entry.args?.actual || entry.actual || result.actual || null,
      }
    : null;
  const failureBoundary = input.failureBoundary || inferredFailureBoundary || null;
  const attemptStatus = input.attemptStatus
    || (failureBoundary ? 'canonical' : (entry.ok === false || entry.error ? 'attempted' : 'canonical'));
  const canonical = input.canonical != null ? !!input.canonical : attemptStatus === 'canonical' && command.concrete;
  const line = {
    id: input.id || lineIdFor({ tool, kind, target, stepIndex: entry.stepIndex, retryOf: input.retryOfScriptLineId || null }),
    runResultId: input.runResultId || ledger.runResultId || null,
    testCaseId: input.testCaseId || ledger.testCaseId || null,
    sequenceIndex: input.sequenceIndex ?? ledger.lines.length,
    contractStepId: input.contractStepId || entry.contractStepId || entry.stepAuthoring?.contractStepId || null,
    sourceContractStepId:
      input.sourceContractStepId || entry.sourceContractStepId || entry.stepAuthoring?.sourceContractStepId || null,
    actionOccurrenceId:
      input.actionOccurrenceId || entry.actionOccurrenceId || entry.actionIdentity?.actionOccurrenceId || null,
    sourceActionOccurrenceId:
      input.sourceActionOccurrenceId || entry.sourceActionOccurrenceId || entry.actionIdentity?.sourceActionOccurrenceId || null,
    authoredActionId:
      input.authoredActionId || entry.authoredActionId || entry.actionIdentity?.authoredActionId || null,
    occurrenceKey:
      input.occurrenceKey || entry.occurrenceKey || entry.actionIdentity?.occurrenceKey || null,
    occurrenceOrdinal:
      input.occurrenceOrdinal || entry.occurrenceOrdinal || entry.actionIdentity?.occurrenceOrdinal || null,
    authoredSequenceIndex:
      input.authoredSequenceIndex || entry.authoredSequenceIndex || entry.actionIdentity?.sequenceIndex || null,
    actionIdentity:
      input.actionIdentity || entry.actionIdentity || null,
    actionDispatchIdentity:
      input.actionDispatchIdentity || entry.actionDispatchIdentity || null,
    stepAuthoring:
      input.stepAuthoring || entry.stepAuthoring || null,
    actionAttemptId: input.actionAttemptId || entry.actionAttemptId || entry.toolUseId || null,
    retryOfScriptLineId: input.retryOfScriptLineId || null,
    retryOfActionEvidenceId: input.retryOfActionEvidenceId || entry.retryOfActionEvidenceId || null,
    attemptStatus,
    canonical,
    kind,
    tool,
    label: target,
    locatorExpression: locator || null,
    locatorStability: locatorHealth.locatorStability,
    locatorSource: locatorHealth.locatorSource,
    locatorWarnings: [...new Set([
      ...locatorHealth.locatorWarnings,
      ...(Array.isArray(input.locatorWarnings) ? input.locatorWarnings : []),
    ])],
    locatorFallbackUsed: locatorHealth.fallbackUsed,
    locatorFallbackReason,
    locatorGuessed,
    locatorProvenance,
    command,
    valueRef: valueBinding?.valueRef || null,
    literalValue: valueBinding?.literalValue,
    failureBoundary,
    source: input.source || 'recordExecutableAction',
    metadata: {
      pageUrl: entry.pageUrl || result.pageUrl || null,
      requestedUrl: kind === 'navigate' ? entry.args?.url || entry.args?.href || entry.args?.targetUrl || null : null,
      postcondition: entry.postcondition || entry.landingVerification || null,
      waitStrategy: entry.waitStrategy || null,
      dependsOnStepIds: Array.isArray(input.dependsOnStepIds) ? input.dependsOnStepIds.map(String) : [],
      synthesizedFromContract: input.synthesizedFromContract === true,
      assertionEvaluated: kind === 'assert' && typeof entry.ok === 'boolean',
      assertionPassed: kind === 'assert' && typeof entry.ok === 'boolean' ? entry.ok === true : null,
      ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
    },
    createdAt: nowIso(),
  };
  ledger.lines.push(line);
  ledger.updatedAt = nowIso();
  refreshHealth(ledger);
  if (entry && typeof entry === 'object') entry.liveScriptLine = line;
  return ledger;
}

function canonicalLines(ledger = {}) {
  const lines = Array.isArray(ledger.lines) ? ledger.lines : [];
  const replacements = new Set(lines.map((line) => line.retryOfScriptLineId).filter(Boolean));
  const rejectedStatuses = new Set([
    'attempted',
    'blocked',
    'cancelled',
    'canceled',
    'diagnostic',
    'error',
    'errored',
    'failed',
    'failure',
    'not_matched',
    'skipped',
    'timed_out',
    'timeout',
    'unknown',
  ]);
  return lines.filter((line) => {
    if (!line || line.canonical !== true || replacements.has(line.id)) return false;
    const evaluatedAssertion = line.kind === 'assert' && line.metadata?.assertionEvaluated === true;
    const status = text(line.attemptStatus || line.status).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (rejectedStatuses.has(status) && !evaluatedAssertion) return false;
    if (line.failureBoundary && !evaluatedAssertion) return false;
    if (line.evidenceOnly === true || line.diagnosticOnly === true || line.executable === false) return false;
    if (line.metadata?.evidenceOnly === true || line.metadata?.diagnosticOnly === true || line.metadata?.executable === false) return false;
    return true;
  });
}

const POSITIVE_OUTCOME_VALUES = new Set([
  'complete',
  'completed',
  'executed',
  'matched',
  'ok',
  'pass',
  'passed',
  'succeeded',
  'success',
]);

const NEGATIVE_OUTCOME_VALUES = new Set([
  'aborted',
  'blocked',
  'cancelled',
  'canceled',
  'diagnostic',
  'error',
  'errored',
  'fail',
  'failed',
  'failure',
  'not_matched',
  'skipped',
  'timed_out',
  'timeout',
  'unknown',
]);

function normalizedOutcome(value) {
  return text(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function outcomeValues(...sources) {
  const fields = ['status', 'executionStatus', 'runtimeStatus', 'attemptStatus', 'liveOutcome', 'outcome', 'resultStatus', 'completionStatus', 'state'];
  const values = [];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const field of fields) {
      const value = normalizedOutcome(source[field]);
      if (value) values.push(value);
    }
    if (source.result && typeof source.result === 'object') values.push(...outcomeValues(source.result));
  }
  return values;
}

function hasPositiveOutcome(...sources) {
  return sources.some((source) => source && typeof source === 'object' && (
    source.ok === true || source.success === true || source.passed === true
  )) || outcomeValues(...sources).some((value) => POSITIVE_OUTCOME_VALUES.has(value));
}

function hasNegativeOutcome(...sources) {
  return sources.some((source) => source && typeof source === 'object' && (
    source.ok === false || source.success === false || source.passed === false
  )) || outcomeValues(...sources).some((value) => NEGATIVE_OUTCOME_VALUES.has(value));
}

function replayStepHasExecutionMarker(step, resolve = null) {
  const sources = [step, resolve, step?.provenance, step?.executionProvenance, step?.runtimeEvidence];
  return sources.some((source) => source && typeof source === 'object' && (
    source.canonicalExecution === true ||
    source.canonicalLiveLedger === true ||
    source.observedOnly === true ||
    source.runtimeEvidence === true ||
    source.captureEvidenceHydrated === true
  ));
}

function replayStepExecutionProof(step, resolve = null) {
  return replayStepHasExecutionMarker(step, resolve)
    && hasPositiveOutcome(step, step?.runtimeEvidence, resolve, resolve?.runtimeEvidence)
    && !hasNegativeOutcome(step, step?.runtimeEvidence, resolve, resolve?.runtimeEvidence);
}

function replayStepDiagnosticReason(step, resolve = null) {
  if (step?.evidenceOnly === true || resolve?.evidenceOnly === true) return 'evidence_only_without_execution_proof';
  if (step?.diagnosticOnly === true || resolve?.diagnosticOnly === true) return 'diagnostic_only_without_execution_proof';
  if (step?.executable === false || resolve?.executable === false) return 'non_executable_without_execution_proof';
  if (step?.synthesizedFromContract === true || resolve?.synthesizedFromContract === true) return 'contract_synthesis_without_execution_proof';
  const provenance = [step?.origin, resolve?.origin, step?.provenance, resolve?.provenance]
    .map((value) => normalizedOutcome(typeof value === 'string' ? value : value?.kind || value?.source))
    .filter(Boolean);
  if (provenance.some((value) => value.includes('authored_contract_recovery') || value.includes('unexecuted') || value.includes('plan'))) {
    return 'unexecuted_authoring_without_execution_proof';
  }
  return 'replayir_without_execution_proof';
}

function refreshHealth(ledger) {
  const emitted = canonicalLines(ledger);
  const weakLocatorCount = emitted.filter((line) => line.locatorStability === 'weak').length;
  const mediumLocatorCount = emitted.filter((line) => line.locatorStability === 'medium').length;
  const missingStableLocatorCount = emitted.filter((line) =>
    line.locatorExpression && line.locatorStability !== 'strong').length;
  const nonRunnableLineCount = emitted.filter((line) => !line.command?.concrete).length;
  const failed = ledger.scriptMode === 'failed_run_script'
    || emitted.some((line) => line.failureBoundary || line.attemptStatus === 'attempted');
  ledger.health = {
    ...(ledger.health || {}),
    scriptConfidence: nonRunnableLineCount > 0 ? 'low' : (weakLocatorCount > 0 || mediumLocatorCount > 0) ? 'medium' : 'high',
    scriptHealth: nonRunnableLineCount > 0 ? 'needs_repair' : weakLocatorCount > 0 ? 'generated_with_weak_locators' : 'generated',
    replayParity: ledger.health?.replayParity || 'not_checked',
    locatorStability: weakLocatorCount > 0 ? 'weak' : mediumLocatorCount > 0 ? 'medium' : emitted.length ? 'strong' : 'unknown',
    weakLocatorCount,
    mediumLocatorCount,
    missingStableLocatorCount,
    nonRunnableLineCount,
    reproducesRunFailure: failed,
  };
  return ledger.health;
}

function buildLedgerFromTrail({ trail = [], status = 'blocked', runResultId = null, testCaseId = null } = {}) {
  const ledger = newLedger({ runResultId, testCaseId, scriptMode: scriptModeForStatus(status) });
  for (const entry of Array.isArray(trail) ? trail : []) appendScriptLine(ledger, { trailEntry: entry, runResultId, testCaseId });
  refreshHealth(ledger);
  return ledger;
}

function locatorStrength(line = {}) {
  if (!line.locatorExpression) return 0;
  if (line.locatorGuessed === true || line.locatorFallbackUsed === true || line.locatorStability === 'weak') return 1;
  if (line.locatorStability === 'medium') return 2;
  return 3;
}

function compatibleLineKind(left, right) {
  const normalize = (value) => {
    const raw = text(value).toLowerCase();
    if (raw === 'selectoption') return 'select';
    if (raw === 'type') return 'fill';
    return raw;
  };
  return normalize(left) === normalize(right);
}

function replaceCommandLocator(command, previousLocator, nextLocator) {
  if (!command || typeof command !== 'object' || !previousLocator || !nextLocator || previousLocator === nextLocator) return command;
  const playwright = text(command.playwright);
  if (!playwright || !playwright.includes(previousLocator)) return command;
  return { ...command, playwright: playwright.replace(previousLocator, nextLocator) };
}

function lineOccurrenceIdentities(line = {}) {
  const nested = [line.actionIdentity, line.actionDispatchIdentity, line.stepAuthoring]
    .filter((value) => value && typeof value === 'object');
  return new Set([
    line.actionOccurrenceId,
    line.occurrenceKey,
    ...nested.flatMap((value) => [
      value.actionOccurrenceId,
      value.occurrenceKey,
    ]),
  ].filter((value) => value != null && String(value).trim()).map(String));
}

function linesShareOccurrenceIdentity(left, right) {
  const ownValues = (line, field) => new Set([
    line?.[field],
    line?.actionIdentity?.[field],
    line?.actionDispatchIdentity?.[field],
    line?.stepAuthoring?.[field],
  ].filter((value) => value != null && String(value).trim()).map(String));
  const intersects = (leftValues, rightValues) =>
    leftValues.size > 0 && rightValues.size > 0 &&
    [...rightValues].some((identity) => leftValues.has(identity));
  if (intersects(ownValues(left, 'actionOccurrenceId'), ownValues(right, 'actionOccurrenceId'))) {
    return true;
  }
  return intersects(ownValues(left, 'occurrenceKey'), ownValues(right, 'occurrenceKey'));
}

function legacyMergeKey(line = {}) {
  const contractStepId = text(line.contractStepId);
  const kind = text(line.kind).toLowerCase();
  return contractStepId && kind ? `${contractStepId}\u0000${kind}` : null;
}

function mergeReplayIrLedger(replayLedger, evidenceLedger) {
  if (!evidenceLedger || !Array.isArray(evidenceLedger.lines) || evidenceLedger.lines.length === 0) return replayLedger;
  const evidenceLines = canonicalLines(evidenceLedger);
  const used = new Set();
  const replayLegacyCounts = new Map();
  const evidenceLegacyCounts = new Map();
  for (const line of replayLedger.lines || []) {
    const key = legacyMergeKey(line);
    if (key) replayLegacyCounts.set(key, (replayLegacyCounts.get(key) || 0) + 1);
  }
  for (const line of evidenceLines) {
    const key = legacyMergeKey(line);
    if (key) evidenceLegacyCounts.set(key, (evidenceLegacyCounts.get(key) || 0) + 1);
  }
  replayLedger.lines = replayLedger.lines.map((replayLine, index) => {
    const replayIdentities = lineOccurrenceIdentities(replayLine);
    let evidenceLine = replayIdentities.size
      ? evidenceLines.find((candidate) => !used.has(candidate.id)
        && compatibleLineKind(candidate.kind, replayLine.kind)
        && linesShareOccurrenceIdentity(replayLine, candidate))
      : null;
    const legacyKey = legacyMergeKey(replayLine);
    if (
      !evidenceLine &&
      replayIdentities.size === 0 &&
      legacyKey &&
      replayLegacyCounts.get(legacyKey) === 1 &&
      evidenceLegacyCounts.get(legacyKey) === 1
    ) {
      evidenceLine = evidenceLines.find((candidate) => !used.has(candidate.id)
        && legacyMergeKey(candidate) === legacyKey
        && compatibleLineKind(candidate.kind, replayLine.kind));
    }
    if (!evidenceLine && replayIdentities.size === 0 && !replayLine.contractStepId) {
      evidenceLine = evidenceLines.find((candidate) => !used.has(candidate.id)
        && !candidate.contractStepId
        && lineOccurrenceIdentities(candidate).size === 0
        && compatibleLineKind(candidate.kind, replayLine.kind)
        && !isInternalTargetLabel(candidate.label)
        && text(candidate.label).toLowerCase() === text(replayLine.label).toLowerCase());
    }
    if (!evidenceLine) return { ...replayLine, sequenceIndex: index };
    used.add(evidenceLine.id);

    const exactOccurrenceMatch = linesShareOccurrenceIdentity(replayLine, evidenceLine);
    const useEvidenceLocator =
      locatorStrength(evidenceLine) > locatorStrength(replayLine) ||
      (exactOccurrenceMatch &&
        !!evidenceLine.locatorExpression &&
        locatorStrength(evidenceLine) >= locatorStrength(replayLine));
    const locatorExpression = useEvidenceLocator ? evidenceLine.locatorExpression : replayLine.locatorExpression;
    const evidenceLocatorIsVerified = useEvidenceLocator && evidenceLine.locatorGuessed !== true && evidenceLine.locatorFallbackUsed !== true;
    return {
      ...replayLine,
      sequenceIndex: index,
      actionAttemptId: evidenceLine.actionAttemptId || replayLine.actionAttemptId,
      retryOfScriptLineId: evidenceLine.retryOfScriptLineId || replayLine.retryOfScriptLineId,
      retryOfActionEvidenceId: evidenceLine.retryOfActionEvidenceId || replayLine.retryOfActionEvidenceId,
      attemptStatus: evidenceLine.attemptStatus,
      canonical: true,
      locatorExpression,
      locatorStability: useEvidenceLocator ? evidenceLine.locatorStability : replayLine.locatorStability,
      locatorSource: useEvidenceLocator ? evidenceLine.locatorSource : replayLine.locatorSource,
      locatorWarnings: [...new Set([...(replayLine.locatorWarnings || []), ...(evidenceLine.locatorWarnings || [])])],
      locatorFallbackUsed: evidenceLocatorIsVerified ? false : replayLine.locatorFallbackUsed,
      locatorFallbackReason: evidenceLocatorIsVerified ? null : replayLine.locatorFallbackReason,
      locatorGuessed: evidenceLocatorIsVerified ? false : replayLine.locatorGuessed,
      locatorProvenance: evidenceLocatorIsVerified
        ? evidenceLine.locatorProvenance || { kind: 'captured_live_dom', source: evidenceLine.locatorSource || 'live_script_ledger' }
        : replayLine.locatorProvenance,
      command: useEvidenceLocator
        ? replaceCommandLocator(replayLine.command, replayLine.locatorExpression, evidenceLine.locatorExpression)
        : replayLine.command,
      failureBoundary: evidenceLine.failureBoundary || null,
      source: `ReplayIR+${evidenceLine.source || 'LiveScriptLedger'}`,
      metadata: {
        ...(replayLine.metadata || {}),
        ...(evidenceLine.metadata || {}),
        diagnosticOnly: false,
        evidenceOnly: false,
        executable: true,
        evidenceLineId: evidenceLine.id || null,
      },
    };
  });
  const unmatchedEvidence = evidenceLedger.lines.filter((line) => line && !used.has(line.id));
  replayLedger.lines.push(...unmatchedEvidence.map((line, offset) => ({
    ...line,
    sequenceIndex: replayLedger.lines.length + offset,
  })));
  replayLedger.utilityMetadata = Array.isArray(evidenceLedger.utilityMetadata) ? evidenceLedger.utilityMetadata : [];
  refreshHealth(replayLedger);
  return replayLedger;
}

function buildLedgerFromResult(result = {}) {
  const persistedLedger = result.captureFirstEvidence?.evidenceCompleteness?.liveScriptLedger
    || result.captureFirstEvidence?.evidenceCompleteness?.scriptLedger
    || result.evidenceCompleteness?.liveScriptLedger
    || result.evidenceCompleteness?.scriptLedger
    || null;
  const suppliedLedger = result.liveScriptLedger && typeof result.liveScriptLedger === 'object'
    ? result.liveScriptLedger
    : persistedLedger && typeof persistedLedger === 'object' ? persistedLedger : null;
  let ledger;
  if (suppliedLedger) {
    ledger = rebindLedger(suppliedLedger, {
      runResultId: result.runResultId || result.id || suppliedLedger.runResultId || null,
      testCaseId: result.testCaseId || suppliedLedger.testCaseId || null,
      scriptMode: suppliedLedger.scriptMode || scriptModeForStatus(result.status || result.executionStatus),
    });
  } else {
    ledger = newLedger({
      runResultId: result.runResultId || result.id || null,
      testCaseId: result.testCaseId || null,
      scriptMode: scriptModeForStatus(result.status || result.executionStatus),
    });
  }
  if (suppliedLedger) {
    refreshHealth(ledger);
    return ledger;
  }
  const capture = result.captureFirstEvidence || {};
  const runResultId = text(result.runResultId || result.id);
  const testCaseId = text(result.testCaseId);
  const matchesResultScope = (row) => {
    if (!row || typeof row !== 'object') return false;
    if (runResultId && (!row.runResultId || text(row.runResultId) !== runResultId)) return false;
    if (testCaseId && (!row.testCaseId || text(row.testCaseId) !== testCaseId)) return false;
    return true;
  };
  const recipes = (Array.isArray(capture.locatorRecipes) ? capture.locatorRecipes : [])
    .filter(matchesResultScope);
  const evidences = (Array.isArray(capture.actionEvidences) ? capture.actionEvidences : [])
    .filter(matchesResultScope);
  for (const evidence of evidences) {
    const evidenceJson = decodeMaybeJson(evidence.evidenceJson, {}) || {};
    const positiveOutcome = hasPositiveOutcome(evidence, evidenceJson) && !hasNegativeOutcome(evidence, evidenceJson);
    const authoredIdentity = evidenceJson.authoredIdentity && typeof evidenceJson.authoredIdentity === 'object'
      ? evidenceJson.authoredIdentity
      : {};
    const kind = actionKindForTool(
      evidence.toolName ||
        evidence.actionKind ||
        evidence.operation ||
        evidence.actionType ||
        evidence.kind ||
        evidence.action,
      evidence,
    );
    const locatorEvidence = locatorFromEvidence(evidence, recipes);
    const locator = locatorEvidence.expression;
    const args = {
      element: evidenceJson.elementLabel || evidenceJson.target || evidence.elementLabel || evidence.target || evidence.actionType || kind,
      valueRef: evidence.valueRef || null,
      url: evidenceJson.url || evidenceJson.requestedUrl || evidence.url || evidence.requestedUrl || null,
    };
    appendScriptLine(ledger, {
      kind,
      locatorExpression: locator,
      trailEntry: {
        tool: evidence.toolName || `browser_${kind}`,
        contractStepId: evidence.contractStepId || authoredIdentity.contractStepId || null,
        sourceContractStepId:
          evidence.sourceContractStepId || authoredIdentity.sourceContractStepId || null,
        actionOccurrenceId:
          evidence.actionOccurrenceId || authoredIdentity.actionOccurrenceId || null,
        sourceActionOccurrenceId:
          evidence.sourceActionOccurrenceId || authoredIdentity.sourceActionOccurrenceId || null,
        authoredActionId: evidence.authoredActionId || authoredIdentity.authoredActionId || null,
        occurrenceKey: evidence.occurrenceKey || authoredIdentity.occurrenceKey || null,
        occurrenceOrdinal:
          evidence.occurrenceOrdinal || authoredIdentity.occurrenceOrdinal || null,
        authoredSequenceIndex:
          evidence.authoredSequenceIndex || authoredIdentity.sequenceIndex || null,
        actionAttemptId:
          evidence.actionAttemptId || authoredIdentity.toolUseId || evidence.toolUseId || null,
        actionIdentity: {
          ...authoredIdentity,
          contractStepId: evidence.contractStepId || authoredIdentity.contractStepId || null,
          actionOccurrenceId:
            evidence.actionOccurrenceId || authoredIdentity.actionOccurrenceId || null,
        },
        args,
        ok: positiveOutcome,
        pageUrl: evidence.pageUrl || null,
      },
      attemptStatus: positiveOutcome ? 'canonical' : (hasNegativeOutcome(evidence, evidenceJson) ? 'failed' : 'unknown'),
      canonical: positiveOutcome,
      metadata: {
        diagnosticOnly: !positiveOutcome,
        evidenceOnly: !positiveOutcome,
        executable: positiveOutcome,
        evidenceOutcome: outcomeValues(evidence, evidenceJson)[0] || 'unknown',
      },
      locatorProvenance: locator
        ? {
            kind: 'captured_action_evidence',
            source: 'ActionEvidence',
            verified: locatorEvidence.verified,
            actionTimeResolved: locatorEvidence.verified,
          }
        : null,
      source: 'ActionEvidence',
    });
  }
  const navs = (Array.isArray(capture.navigationEvidences) ? capture.navigationEvidences : [])
    .filter(matchesResultScope);
  if (!ledger.lines.some((line) => line.kind === 'navigate')) {
  for (const nav of navs) {
      const navJson = decodeMaybeJson(nav.evidenceJson, {}) || {};
      appendScriptLine(ledger, {
        kind: 'navigate',
        trailEntry: {
          tool: 'browser_navigate',
          args: { url: nav.requestedUrl || nav.resolvedUrl || navJson.requestedUrl || navJson.resolvedUrl || result.targetUrl || '' },
          ok: true,
          landingVerification: nav.postNavigationOracle || null,
        },
        source: 'NavigationEvidence',
      });
    }
  }
  const assertions = (Array.isArray(capture.assertionEvidences) ? capture.assertionEvidences : [])
    .filter(matchesResultScope);
  for (const assertion of assertions) {
    const expected = decodeMaybeJson(assertion.expectedJson, assertion.expectedJson);
    const actual = decodeMaybeJson(assertion.actualJson, assertion.actualJson);
    const assertionJson = decodeMaybeJson(assertion.evidenceJson, {}) || {};
    const passedStatus = hasPositiveOutcome(assertion, assertionJson) && !hasNegativeOutcome(assertion, assertionJson);
    const evaluatedPass = assertion.matched === true || passedStatus;
    const evaluatedFailure = assertion.matched === false || hasNegativeOutcome(assertion, assertionJson);
    const assertionEvaluated = evaluatedPass || evaluatedFailure;
    appendScriptLine(ledger, {
      kind: 'assert',
      contractStepId: assertion.assertionId || assertion.contractStepId || null,
      trailEntry: {
        tool: 'assertion_check',
        contractStepId: assertion.assertionId || assertion.contractStepId || null,
        args: {
          expectedText: expected || assertion.expectedValue || assertion.expected || assertion.target || assertion.assertionId || 'QAAI assertion boundary',
        },
        ok: evaluatedPass,
      },
      attemptStatus: assertionEvaluated ? 'canonical' : 'unknown',
      canonical: assertionEvaluated,
      metadata: {
        diagnosticOnly: !assertionEvaluated,
        evidenceOnly: !assertionEvaluated,
        executable: assertionEvaluated,
        assertionEvaluated,
        assertionPassed: evaluatedPass,
        assertionId: assertion.assertionId || assertion.contractStepId || null,
        assertionEvidenceId: assertion.id || null,
        expected,
        actual,
        evidenceOutcome: assertion.matched === true ? 'matched' : assertion.matched === false ? 'not_matched' : outcomeValues(assertion, assertionJson)[0] || 'unknown',
      },
      failureBoundary: evaluatedFailure ? {
        assertionId: assertion.assertionId || null,
        expected,
        actual: actual || assertion.actualValue || null,
      } : null,
      source: 'AssertionEvidence',
    });
  }
  if (Array.isArray(result.envelope?.ir?.steps) && result.envelope.ir.steps.length) {
    const evidenceLedger = ledger;
    ledger = newLedger({
      runResultId: result.runResultId || result.id || evidenceLedger.runResultId || null,
      testCaseId: result.testCaseId || evidenceLedger.testCaseId || null,
      scriptMode: evidenceLedger.scriptMode || scriptModeForStatus(result.status || result.executionStatus),
    });
    const irSteps = result.envelope.ir.steps;
    const resolveByAs = new Map(irSteps
      .filter((step) => step && step.op === 'resolve' && step.as)
      .map((step) => [String(step.as), step]));
    for (const step of irSteps) {
      if (!step || step.op === 'resolve') continue;
      if (step.op === 'act') {
        const resolve = step.target != null ? resolveByAs.get(String(step.target)) || null : null;
        const executionProven = replayStepExecutionProof(step, resolve);
        const label = semanticLabelFromResolve(resolve, step.targetLabel || step.elementLabel || step.label || step.action);
        const guessed = !!(resolve && (resolve.guessedLocator === true
          || resolve.locatorConfidence === 'guessed'
          || resolve.locatorProvenance?.kind === 'qaai_guessed_locator'));
        appendScriptLine(ledger, {
          kind: step.action,
          locatorExpression: locatorExpressionFromRecipe(step.actionLocator) || locatorExpressionFromResolve(resolve),
          locatorRecipe: step.actionLocator || resolve?.actionLocator || resolve?.candidates?.[0] || null,
          contractStepId: step.contractStepId || step.contractRef || null,
          sourceContractStepId: step.sourceContractStepId || resolve?.sourceContractStepId || null,
          actionOccurrenceId: step.actionOccurrenceId || resolve?.actionOccurrenceId || null,
          sourceActionOccurrenceId:
            step.sourceActionOccurrenceId || resolve?.sourceActionOccurrenceId || null,
          authoredActionId: step.authoredActionId || resolve?.authoredActionId || null,
          occurrenceKey: step.occurrenceKey || resolve?.occurrenceKey || null,
          occurrenceOrdinal: step.occurrenceOrdinal || resolve?.occurrenceOrdinal || null,
          authoredSequenceIndex:
            step.authoredSequenceIndex || step.sequenceIndex || resolve?.authoredSequenceIndex || null,
          actionAttemptId: step.actionAttemptId || step.toolUseId || null,
          actionIdentity: step.actionIdentity || resolve?.actionIdentity || null,
          actionDispatchIdentity:
            step.actionDispatchIdentity || resolve?.actionDispatchIdentity || null,
          stepAuthoring: step.stepAuthoring || resolve?.stepAuthoring || null,
          dependsOnStepIds: step.dependsOnStepIds,
          synthesizedFromContract: step.synthesizedFromContract === true,
          attemptStatus: executionProven ? 'canonical' : (hasNegativeOutcome(step, resolve) ? 'failed' : 'diagnostic'),
          canonical: executionProven,
          locatorGuessed: guessed,
          locatorFallbackUsed: guessed,
          locatorFallbackReason: guessed ? 'qaai_guessed_locator' : null,
          locatorProvenance: step.locatorProvenance || resolve?.locatorProvenance || null,
          locatorWarnings: guessed ? ['qaai_guessed_locator_requires_review'] : [],
          trailEntry: {
            tool: runtimeToolForActionKind(step.action),
            contractStepId: step.contractStepId || step.contractRef || null,
            args: {
              element: label,
              valueRef: step.valueRef,
              url: step.url || null,
              key: step.key || null,
            },
            ok: step.liveOutcome !== 'not_matched' && step.executionStatus !== 'failed',
          },
          metadata: {
            diagnosticOnly: !executionProven,
            evidenceOnly: !executionProven,
            executable: executionProven,
            assertionId: step.assertionId || step.contractRef || step.contractStepId || null,
            assertionEvidenceId: step.assertionEvidenceId || null,
            expected: step.expected,
            actual: step.actual,
            assertionEvaluated: executionProven,
            assertionPassed: step.liveOutcome !== 'not_matched',
            diagnosticReason: executionProven ? null : replayStepDiagnosticReason(step, resolve),
          },
          source: 'ReplayIR',
        });
      } else if (step.op === 'waitFor') {
        const targetRef = step.condition && step.condition.target || step.target || null;
        const resolve = targetRef != null ? resolveByAs.get(String(targetRef)) || null : null;
        const executionProven = replayStepExecutionProof(step, resolve);
        const label = semanticLabelFromResolve(resolve, step.label || targetRef || 'expected page state');
        const guessed = !!(resolve && (resolve.guessedLocator === true || resolve.locatorProvenance?.kind === 'qaai_guessed_locator'));
        appendScriptLine(ledger, {
          kind: 'waitFor',
          locatorExpression: locatorExpressionFromResolve(resolve),
          locatorRecipe: resolve?.actionLocator || resolve?.candidates?.[0] || null,
          contractStepId: step.contractStepId || null,
          sourceContractStepId: step.sourceContractStepId || null,
          actionOccurrenceId: step.actionOccurrenceId || null,
          sourceActionOccurrenceId: step.sourceActionOccurrenceId || null,
          authoredActionId: step.authoredActionId || null,
          occurrenceKey: step.occurrenceKey || null,
          occurrenceOrdinal: step.occurrenceOrdinal || null,
          authoredSequenceIndex: step.authoredSequenceIndex || step.sequenceIndex || null,
          actionAttemptId: step.actionAttemptId || step.toolUseId || null,
          actionIdentity: step.actionIdentity || null,
          stepAuthoring: step.stepAuthoring || null,
          dependsOnStepIds: step.dependsOnStepIds,
          synthesizedFromContract: step.synthesizedFromContract === true,
          attemptStatus: executionProven ? 'canonical' : (hasNegativeOutcome(step, resolve) ? 'failed' : 'diagnostic'),
          canonical: executionProven,
          locatorGuessed: guessed,
          locatorFallbackUsed: guessed,
          locatorFallbackReason: guessed ? 'qaai_guessed_locator' : null,
          locatorProvenance: resolve?.locatorProvenance || null,
          trailEntry: {
            tool: 'browser_wait_for_selector',
            contractStepId: step.contractStepId || null,
            args: { element: label },
            ok: true,
            waitStrategy: step.condition || null,
          },
          metadata: {
            diagnosticOnly: !executionProven,
            evidenceOnly: !executionProven,
            executable: executionProven,
            diagnosticReason: executionProven ? null : replayStepDiagnosticReason(step, resolve),
          },
          source: 'ReplayIR',
        });
      } else if (step.op === 'assert') {
        const resolve = step.target != null ? resolveByAs.get(String(step.target)) || null : null;
        const executionProven = replayStepExecutionProof(step, resolve);
        const label = semanticLabelFromResolve(resolve, step.targetLabel || step.elementLabel || step.target || step.expected || 'assertion');
        appendScriptLine(ledger, {
          kind: 'assert',
          locatorExpression: locatorExpressionFromResolve(resolve),
          locatorRecipe: resolve?.actionLocator || resolve?.candidates?.[0] || null,
          contractStepId: step.contractStepId || step.contractRef || null,
          sourceContractStepId: step.sourceContractStepId || null,
          actionOccurrenceId: step.actionOccurrenceId || null,
          sourceActionOccurrenceId: step.sourceActionOccurrenceId || null,
          authoredActionId: step.authoredActionId || null,
          occurrenceKey: step.occurrenceKey || null,
          occurrenceOrdinal: step.occurrenceOrdinal || null,
          authoredSequenceIndex: step.authoredSequenceIndex || step.sequenceIndex || null,
          actionAttemptId: step.actionAttemptId || step.toolUseId || null,
          actionIdentity: step.actionIdentity || null,
          stepAuthoring: step.stepAuthoring || null,
          dependsOnStepIds: step.dependsOnStepIds,
          synthesizedFromContract: step.synthesizedFromContract === true,
          attemptStatus: executionProven ? 'canonical' : (hasNegativeOutcome(step, resolve) ? 'failed' : 'diagnostic'),
          canonical: executionProven,
          trailEntry: {
            tool: 'assertion_check',
            contractStepId: step.contractStepId || step.contractRef || null,
            args: {
              element: label,
              expectedText: step.expected || step.dataExpected || null,
              expectedUrlPattern: step.channel === 'URL' ? step.expected : null,
            },
            ok: step.liveOutcome !== 'not_matched',
          },
          failureBoundary: step.liveOutcome === 'not_matched' ? { contractRef: step.contractRef || null } : null,
          metadata: {
            diagnosticOnly: !executionProven,
            evidenceOnly: !executionProven,
            executable: executionProven,
            diagnosticReason: executionProven ? null : replayStepDiagnosticReason(step, resolve),
          },
          source: 'ReplayIR',
        });
      }
    }
    ledger = mergeReplayIrLedger(ledger, evidenceLedger);
  }
  refreshHealth(ledger);
  return ledger;
}

function compileLedgerToPlaywrightSpec({ ledger, title = 'QAAI recorded run', targetUrl = '', js = false } = {}) {
  const emitted = canonicalLines(ledger);
  const importLine = js
    ? "const { test, expect } = require('@playwright/test');"
    : "import { test, expect } from '@playwright/test';";
  const lines = [
    importLine,
    '',
    'const runtimeValue = (name, fallback) => {',
    '  const value = process.env[name];',
    '  if (value != null && value !== "") return value;',
    '  if (fallback !== undefined) return fallback;',
    '  throw new Error(`Missing required runtime value: ${name}`);',
    '};',
    '',
    `test(${jsLiteral(title)}, async ({ page }) => {`,
  ];
  if (!emitted.some((line) => line.kind === 'navigate')) {
    lines.push(`  await page.goto(process.env.QAAI_TARGET_URL || ${targetUrl ? jsLiteral(targetUrl) : '"about:blank"'});`);
  }
  for (const line of emitted) {
    lines.push(`  // ${line.sequenceIndex + 1}. ${line.label}${line.locatorStability === 'weak' ? ' (weak locator fallback)' : ''}`);
    lines.push(`  ${line.command.playwright}`);
  }
  if (!emitted.length) {
    lines.push('  // No executable history was available for this run.');
  }
  lines.push('});', '');
  return lines.join('\n');
}

function compileLedgerToPlaywrightPomPackage({
  ledger,
  title = 'QAAI recorded run',
  targetUrl = '',
  moduleName = 'Recorded',
  pageClassName = '',
  locatorsExportName = '',
  locatorsImportPath = '',
  pageImportPath = '',
  js = false,
} = {}) {
  const emitted = canonicalLines(ledger);
  const className = pageClassName || `${pascalCase(moduleName || 'recorded', 'Recorded')}Page`;
  const exportName = locatorsExportName || `${camelCase(moduleName || 'recorded', 'recorded')}Locators`;
  const locatorUsed = new Set();
  const methodUsed = new Set();
  const locatableLines = emitted
    .filter((line) => line.locatorExpression && [
      'click', 'doubleClick', 'tripleClick', 'hover', 'fill', 'type', 'selectOption',
      'check', 'uncheck', 'upload', 'press', 'waitFor',
    ].includes(line.kind))
    .map((line) => {
      const locatorName = uniqueName(`${line.label || line.kind} locator`, locatorUsed);
      const methodName = uniqueName(`${line.kind} ${line.label || 'target'}`, methodUsed);
      return { line, locatorName, methodName };
    });
  const locatorById = new Map(locatableLines.map((item) => [item.line.id, item]));

  const locatorLines = [
    `export const ${exportName} = {`,
  ];
  for (const item of locatableLines) {
    if (item.line.locatorGuessed) {
      locatorLines.push('  // QAAI_GUESSED_LOCATOR: Live DOM evidence was unavailable, so QAAI guessed this locator from the semantic step description.');
      locatorLines.push('  // Replace this locator with a reliable DOM locator if it does not match the intended element.');
    }
    locatorLines.push(`  ${item.locatorName}: (page) => ${item.line.locatorExpression},`);
  }
  locatorLines.push('};', '');

  const pageLines = [
    `import { ${exportName} } from ${jsLiteral(locatorsImportPath || '../locators/generated/recorded.generated.locators.js')};`,
    '',
    `export class ${className} {`,
    '  constructor(page) {',
    '    this.page = page;',
    '  }',
    '',
  ];
  for (const item of locatableLines) {
    const { line, locatorName, methodName } = item;
    pageLines.push(`  ${locatorName}() { return ${exportName}.${locatorName}(this.page); }`);
    if (line.kind === 'fill') {
      pageLines.push(`  async ${methodName}(value) { await this.${locatorName}().fill(value); }`);
    } else if (line.kind === 'type') {
      pageLines.push(`  async ${methodName}(value) { await this.${locatorName}().pressSequentially(value); }`);
    } else if (line.kind === 'selectOption') {
      pageLines.push(`  async ${methodName}(value) { await this.${locatorName}().selectOption(value); }`);
    } else if (line.kind === 'upload') {
      pageLines.push(`  async ${methodName}(filePath) { await this.${locatorName}().setInputFiles(filePath); }`);
    } else if (line.kind === 'press') {
      pageLines.push(`  async ${methodName}(key) { await this.${locatorName}().press(key); }`);
    } else if (line.kind === 'waitFor') {
      pageLines.push(`  async ${methodName}() { await this.${locatorName}().waitFor({ state: 'visible' }); }`);
    } else if (line.kind === 'doubleClick') {
      pageLines.push(`  async ${methodName}() { await this.${locatorName}().dblclick(); }`);
    } else if (line.kind === 'tripleClick') {
      pageLines.push(`  async ${methodName}() { await this.${locatorName}().click({ clickCount: 3 }); }`);
    } else {
      pageLines.push(`  async ${methodName}() { await this.${locatorName}().${line.kind}(); }`);
    }
    pageLines.push('');
  }
  pageLines.push('}', '');

  const specLines = [
    "import { test, expect } from '@playwright/test';",
    `import { ${className} } from ${jsLiteral(pageImportPath || '../../pages/RecordedPage.js')};`,
    '',
    'const runtimeValue = (name, fallback) => {',
    '  const value = process.env[name];',
    '  if (value != null && value !== "") return value;',
    '  if (fallback !== undefined) return fallback;',
    '  throw new Error(`Missing required runtime value: ${name}`);',
    '};',
    '',
    `test(${jsLiteral(title)}, async ({ page }) => {`,
    `  const recordedPage = new ${className}(page);`,
  ];
  if (!emitted.some((line) => line.kind === 'navigate')) {
    specLines.push(`  await page.goto(process.env.QAAI_TARGET_URL || ${targetUrl ? jsLiteral(targetUrl) : '"about:blank"'});`);
  }
  for (const line of emitted) {
    specLines.push(`  // ${line.sequenceIndex + 1}. ${line.label}${line.locatorStability === 'weak' ? ' (weak locator fallback)' : ''}`);
    const mapped = locatorById.get(line.id);
    if (line.kind === 'navigate' || line.kind === 'assert' || !mapped) {
      specLines.push(`  ${line.command.playwright}`);
    } else if (line.kind === 'fill' || line.kind === 'type' || line.kind === 'selectOption' || line.kind === 'upload') {
      const valueExpression = line.valueRef
        ? runtimeValueExpression(line.valueRef)
        : line.literalValue !== undefined
          ? jsLiteral(line.literalValue)
          : runtimeValueExpression(null, line.kind === 'selectOption' ? 'QAAI_SELECT_VALUE' : line.kind === 'upload' ? 'QAAI_UPLOAD_FILE' : 'QAAI_VALUE');
      specLines.push(`  await recordedPage.${mapped.methodName}(${valueExpression});`);
    } else if (line.kind === 'press') {
      specLines.push(`  await recordedPage.${mapped.methodName}(${jsLiteral(line.metadata?.key || 'Enter')});`);
    } else {
      specLines.push(`  await recordedPage.${mapped.methodName}();`);
    }
  }
  if (!emitted.length) specLines.push('  // No executable history was available for this run.');
  specLines.push('});', '');

  return {
    specContent: specLines.join('\n'),
    pageContent: pageLines.join('\n'),
    locatorContent: locatorLines.join('\n'),
    pageClassName: className,
    locatorsExportName: exportName,
    locatableLineCount: locatableLines.length,
  };
}

module.exports = {
  SCHEMA_VERSION,
  EXPORTABLE_KINDS,
  UTILITY_TOOLS,
  newLedger,
  appendScriptLine,
  appendUtilityMetadata,
  buildLedgerFromTrail,
  buildLedgerFromResult,
  compileLedgerToPlaywrightSpec,
  compileLedgerToPlaywrightPomPackage,
  rebindLedger,
  canonicalLines,
  refreshHealth,
  assessLocatorHealth,
  scriptModeForStatus,
  isExportableTool,
  isUtilityTool,
  normalizeLocatorExpression,
};
