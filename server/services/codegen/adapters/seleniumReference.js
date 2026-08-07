'use strict';
/**
 * Enterprise Mode P7c — Selenium reference adapter. A FIRST-CLASS ReplayIR adapter (not a
 * "translate the Playwright spec to Java" attempt): it emits Selenium 4 + TestNG Java ONLY
 * from each RunResult's pinned `replayIrJson`, through the frozen FrameworkAdapter contract
 * (`compileReplayIR` assembles one test class from the per-step emit* chunks).
 *
 * Honesty floor (user rules + [[structural-fixes-over-tactical]]):
 *  - Locators: role/css/testId/text/placeholder/label map deterministically. `getByRole` →
 *    a bounded ARIA heuristic (role attribute / accessible name over text/aria-label/label),
 *    NOT an invented CSS selector. If NO candidate of a resolve step maps → THROW
 *    `selenium_locator_unmappable` so the result is BLOCKED (never fabricate a selector).
 *  - Assert channels Selenium cannot faithfully replay (API/DB_READ/EMAIL_SMS/DOWNLOAD/PDF/
 *    AUDIT_LOG/ASYNC_JOB/EVALUATE) → a throwing stub + an exact finding
 *    `selenium_channel_unsupported:<channel>` (the package still compiles; the test can never
 *    report green).
 *  - Secrets: valueRefs resolve via EnvReader (System.getenv); never an inline literal.
 *
 * The IR-agnostic Maven/TestNG SHELL (pom.xml, testng.xml, BaseTest, LocatorResolver,
 * LocatorCandidate, EnvReader) is assembled by assemblePackage() below — the adapter owns its
 * framework's shell, like replayIrBdd.
 */
const packageValidate = require('../_packageValidate');
const regressionCorpus = require('./regressionCorpus');
const actionLocatorResolver = require('../../actionLocatorResolver');
const { normalizeCandidate, normalizeCandidates, labelForCandidates } = require('./_candidateNormalize');

const ADAPTER_ID = 'selenium-reference';
const ADAPTER_VERSION = 'selenium-reference-1';
const VALIDATE_FRAMEWORK = 'selenium-java';
const PACKAGE = 'com.qaai.replayir';
const PACKAGE_PATH = PACKAGE.replace(/\./g, '/');

const UNSUPPORTED_CHANNELS = new Set(['API', 'DB_READ', 'EMAIL_SMS', 'DOWNLOAD', 'PDF', 'AUDIT_LOG', 'ASYNC_JOB', 'EVALUATE']);

// ── string helpers ──────────────────────────────────────────────────────────
function jstr(value) {
  const s = value == null ? '' : String(value);
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
}
function esc(value) {
  return String(value == null ? '' : value).replace(/\*\//g, '* /').replace(/[\r\n]+/g, ' ').trim();
}
function slug(value, fallback = 'replayir-case') {
  const out = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/g, '');
  return out || fallback;
}
function ident(value, fallback = 'el') {
  const base = String(value || fallback)
    .replace(/[^A-Za-z0-9_$]+/g, ' ').trim().split(/\s+/).filter(Boolean)
    .map((part, i) => { const c = part.replace(/[^A-Za-z0-9_$]/g, ''); if (!c) return ''; return i === 0 ? c.charAt(0).toLowerCase() + c.slice(1) : c.charAt(0).toUpperCase() + c.slice(1); })
    .join('');
  const safe = base || fallback;
  return /^[A-Za-z_$]/.test(safe) ? safe : `v${safe}`;
}

function safeSemanticPhrase(value) {
  let text = String(value || '').trim();
  if (!text) return '';
  text = text
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, ' ')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, ' ')
    .replace(/\b(?:password|passcode|secret|token|api[ _-]?key|otp|pin)\s*[:=]\s*\S+/gi, '$1')
    .replace(/\b[0-9a-f]{16,}\b/gi, ' ')
    .replace(/\b\d{4,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/\bpassword\b/i.test(text)) return 'Password';
  return text;
}

function semanticOrdinal(index) {
  return ['', '', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'][index]
    || `Alternate${index}`;
}

const INTERNAL_REF_RE = /^(?:el(?:ement)?|ref|node|target|field)[_-]?\d+$/i;
const UUID_REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JAVA_RESERVED = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class',
  'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final',
  'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int',
  'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public',
  'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this',
  'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'true', 'false', 'null',
]);

function isInternalReference(value) {
  const text = String(value || '').trim();
  return !text || INTERNAL_REF_RE.test(text) || UUID_REF_RE.test(text)
    || /^(?:[0-9a-f]{16,}|[a-z]+_[0-9a-f]{12,})$/i.test(text);
}

function javaIdentifier(value, fallback = 'pageElement') {
  const name = ident(value, fallback);
  return JAVA_RESERVED.has(name) ? `${name}Element` : name;
}

function seleniumRoleNoun(role, action) {
  const normalized = String(role || '').toLowerCase().replace(/[^a-z]/g, '');
  const nouns = {
    textbox: 'Field', searchbox: 'Field', button: 'Button', link: 'Link',
    checkbox: 'Checkbox', radio: 'RadioButton', combobox: 'Dropdown',
    tab: 'Tab', menuitem: 'MenuItem', option: 'Option', heading: 'Heading',
    img: 'Image', image: 'Image', row: 'Row', cell: 'Cell', dialog: 'Dialog',
  };
  if (nouns[normalized]) return nouns[normalized];
  if (['fill', 'type', 'upload'].includes(action)) return 'Field';
  if (action === 'selectOption') return 'Dropdown';
  if (['check', 'uncheck'].includes(action)) return 'Checkbox';
  if (action === 'waitFor') return 'Target';
  return '';
}

function semanticReferenceBase({ label, role, action, fallback = 'pageElement' } = {}) {
  let phrase = safeSemanticPhrase(label);
  if (isInternalReference(phrase)) phrase = '';
  phrase = phrase
    .replace(/^\s*(?:click|double[- ]?click|triple[- ]?click|fill|enter|type|hover|select|choose|upload|check|uncheck|open|verify|assert|wait(?:\s+for)?|navigate(?:\s+to)?)\s+/i, '')
    .replace(/["'`]+/g, ' ')
    .trim();
  const noun = seleniumRoleNoun(role, action);
  if (phrase && noun && !/(?:button|field|textbox|input|link|tab|menu(?:item)?|icon|checkbox|radio|dropdown|combobox|option|heading|image|row|cell|dialog|target)$/i.test(phrase.replace(/[^A-Za-z0-9]+$/g, ''))) {
    phrase += ` ${noun}`;
  }
  if (!phrase) phrase = `${action || 'page'} ${noun || 'element'}`;
  return javaIdentifier(phrase, fallback);
}

function candidateSemanticDetails(candidates) {
  for (const raw of Array.isArray(candidates) ? candidates : []) {
    const candidate = normalizeCandidate(raw) || {};
    const label = candidate.name || candidate.text || candidate.testId || '';
    if (label && !isInternalReference(label)) return { label, role: candidate.role || '' };
  }
  const role = (Array.isArray(candidates) ? candidates : [])
    .map((raw) => (normalizeCandidate(raw) || {}).role)
    .find(Boolean);
  return { label: '', role: role || '' };
}

function consumerForResolve(ir, ref) {
  const steps = ir && Array.isArray(ir.steps) ? ir.steps : [];
  return steps.find((step) => step && (
    (step.op === 'act' && (String(step.target || '') === ref || String(step.destinationTarget || '') === ref))
    || (step.op === 'waitFor' && String(step.condition && step.condition.target || '') === ref)
  )) || null;
}

const semanticReferenceCache = new WeakMap();

function semanticReferenceMap(ir) {
  if (!ir || typeof ir !== 'object') return new Map();
  if (semanticReferenceCache.has(ir)) return semanticReferenceCache.get(ir);
  const map = new Map();
  const counts = new Map();
  const resolves = Array.isArray(ir.steps) ? ir.steps.filter((step) => step && step.op === 'resolve') : [];
  for (const step of resolves) {
    const rawRef = String(step.as || step.target || '');
    const candidate = candidateSemanticDetails(step.candidates);
    const consumer = consumerForResolve(ir, rawRef);
    const action = consumer && (consumer.op === 'waitFor' ? 'waitFor' : consumer.action);
    const label = step.elementLabel || step.narration || candidate.label || (!isInternalReference(rawRef) ? rawRef : '');
    const base = semanticReferenceBase({ label, role: candidate.role, action });
    const count = (counts.get(base) || 0) + 1;
    counts.set(base, count);
    map.set(rawRef, count === 1 ? base : `${semanticOrdinal(count)}${base.charAt(0).toUpperCase()}${base.slice(1)}`);
  }
  semanticReferenceCache.set(ir, map);
  return map;
}

function semanticReferenceName(ref, ir, fallback = 'pageElement') {
  const rawRef = String(ref || '');
  const mapped = semanticReferenceMap(ir).get(rawRef);
  if (mapped) return mapped;
  if (!isInternalReference(rawRef)) return javaIdentifier(rawRef, fallback);
  return javaIdentifier(fallback, 'pageElement');
}
function classNameFor(caseId, rowIndex, rrId, title) {
  // Test classes are public output: derive a conventional, readable Java type
  // from the authored scenario title and never leak internal replay IDs/prefixes.
  const base = (title && String(title).trim()) || 'Generated case';
  let core = base
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
  if (!core) core = 'GeneratedCase';
  if (!/^[A-Za-z]/.test(core)) core = `Case${core}`;
  const stem = /Test$/i.test(core) ? core.slice(0, -4) : core;
  return `${stem.slice(0, 116) || 'GeneratedCase'}Test`;
}
function envNameFromRef(kind, body) {
  const suffix = String(body || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'VALUE';
  if (kind === 'fixture') return `QAAI_FIXTURE_${suffix}`;
  if (kind === 'vault') return `QAAI_VAULT_${suffix}`;
  if (kind === 'masked') return `QAAI_MASKED_${suffix}`;
  return suffix;
}
function envKeyFromRef(ref, fallback) {
  const m = String(ref || '').match(/^(env|vault|fixture|masked):(.+)$/i);
  if (!m) return fallback;
  const kind = m[1].toLowerCase();
  return kind === 'env' ? m[2] : envNameFromRef(kind, m[2]);
}
function bindingMetadata(opts, ir) {
  return (opts && opts.bindingMetadata)
    || (opts && opts.case && opts.case.bindingMetadata)
    || (ir && ir.bindingMetadata)
    || (ir && ir.case && ir.case.bindingMetadata)
    || null;
}

function stepNumber(step) {
  const raw = step && (step.authoredStepNumber ?? step.stepNumber ?? step.sourceStepNumber ?? step.stepIndex);
  const number = Number(raw);
  if (!Number.isFinite(number)) return null;
  return Object.prototype.hasOwnProperty.call(step, 'stepIndex') && !Object.prototype.hasOwnProperty.call(step, 'stepNumber')
    ? number + 1
    : number;
}

function typedBinding(step, opts, ir, expected = false) {
  if (!step || typeof step !== 'object') return null;
  const direct = expected ? step.expectedBinding : step.valueBinding;
  if (direct && typeof direct === 'object') return direct;
  const metadata = bindingMetadata(opts, ir);
  const entries = metadata && Array.isArray(metadata.entries) ? metadata.entries : [];
  const number = stepNumber(step);
  const preferredKeys = expected
    ? ['expectedValue', 'expected']
    : ['value', 'inputValue', 'selectedValue', 'text', 'input'];
  if (number != null) {
    const exact = entries.find((entry) => entry && Number(entry.step) === number
      && (!entry.key || preferredKeys.includes(entry.key)));
    if (exact) return exact;
  }
  return null;
}

function requiredRuntimeKey(binding, step, expected = false) {
  const raw = String(binding && (binding.reference || binding.column) || '').replace(/^(?:runtime|output|dependency|depends-on|upstream|generated|generator):/i, '');
  let semantic = safeSemanticPhrase(raw || step && (step.elementLabel || step.targetLabel || step.target || step.contractRef) || (expected ? 'EXPECTED' : 'VALUE'));
  if (isInternalReference(semantic)) semantic = expected ? 'EXPECTED' : 'VALUE';
  const suffix = String(semantic || (expected ? 'EXPECTED' : 'VALUE')).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || (expected ? 'EXPECTED' : 'VALUE');
  const kind = String(binding && binding.kind || 'runtime').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return `QAAI_${kind}_${suffix}`;
}

function provenWorkbookColumn(binding) {
  return binding && binding.kind === 'workbook_column'
    && String(binding.sheet || '').trim()
    && String(binding.column || '').trim()
    && Number(binding.usableRowCount || 0) > 0;
}

function bindingExpression(step, opts, ir, expected = false) {
  const binding = typedBinding(step, opts, ir, expected);
  const rawValue = expected ? step && step.expected : step && step.rawValue;
  if (binding && binding.kind === 'literal') {
    const value = Object.prototype.hasOwnProperty.call(binding, 'value') ? binding.value : rawValue;
    if (value != null) return { expression: jstr(value), kind: 'literal' };
  }
  if (binding && binding.kind === 'secret_env') {
    return { expression: `EnvReader.required(${jstr(envKeyFromRef(binding.reference, requiredRuntimeKey(binding, step, expected)))})`, kind: 'secret_env' };
  }
  if (provenWorkbookColumn(binding)) {
    const rowKey = exportedDataKey(opts, binding.column);
    if (rowKey) return { expression: `DataReader.required(row, ${jstr(rowKey)})`, kind: 'workbook_column' };
    return { expression: `EnvReader.required(${jstr(requiredRuntimeKey(binding, step, expected))})`, kind: 'workbook_column_runtime_fallback' };
  }
  if (binding && binding.kind === 'workbook_column') {
    return { expression: `EnvReader.required(${jstr(requiredRuntimeKey(binding, step, expected))})`, kind: 'workbook_column_unproven' };
  }
  if (binding && ['runtime_output', 'dependency_output', 'generated_value'].includes(binding.kind)) {
    return { expression: `EnvReader.required(${jstr(requiredRuntimeKey(binding, step, expected))})`, kind: binding.kind };
  }
  const ref = String(expected ? step && step.expectedRef : step && step.valueRef || '');
  const m = ref.match(/^(env|vault|fixture|masked):(.+)$/i);
  if (m) {
    const kind = m[1].toLowerCase();
    return { expression: `EnvReader.required(${jstr(kind === 'env' ? m[2] : envNameFromRef(kind, m[2]))})`, kind: 'secret_env' };
  }
  if (rawValue != null) return { expression: jstr(rawValue), kind: 'literal' };
  return { expression: `EnvReader.required(${jstr(requiredRuntimeKey(binding, step, expected))})`, kind: 'required_runtime_fallback' };
}

function valueExpr(step, opts, ir) {
  return bindingExpression(step, opts, ir, false).expression;
}

function isEnvironmentValueRef(ref) {
  return /^(?:env|vault|fixture|masked):/i.test(String(ref || ''));
}

function isEnvironmentBackedDataValue(value) {
  if (typeof value === 'string') return isEnvironmentValueRef(value.trim());
  if (!value || typeof value !== 'object') return false;
  const kind = String(value.kind || value.type || (value.source && value.source.kind) || '').toLowerCase();
  return ['environment', 'env', 'vault', 'masked', 'fixture'].includes(kind);
}

function dataRoleFromRef(ref) {
  const match = String(ref || '').match(/^data:(.+)$/i);
  return match ? match[1] : null;
}

function explicitDataRole(step) {
  if (!step) return null;
  if (step.dataBinding && step.dataBinding.isDataBound === true && step.dataBinding.sourceColumn) {
    return String(step.dataBinding.sourceColumn);
  }
  return step.dataRole || dataRoleFromRef(step.valueRef) || null;
}

function commonExportedDataKeys(rows) {
  const usable = (rows || []).filter((row) => row && row.fields && Object.keys(row.fields).length > 0);
  if (!usable.length) return new Map();
  const common = new Map();
  for (const [key, value] of Object.entries(usable[0].fields)) {
    if (!isEnvironmentBackedDataValue(value)) common.set(String(key).toLowerCase(), String(key));
  }
  for (const row of usable.slice(1)) {
    const keys = new Set(Object.entries(row.fields)
      .filter(([, value]) => !isEnvironmentBackedDataValue(value))
      .map(([key]) => String(key).toLowerCase()));
    for (const key of [...common.keys()]) {
      if (!keys.has(key)) common.delete(key);
    }
  }
  return common;
}

function exportedDataKey(opts, requested) {
  if (!requested || !opts || opts._qaaiDataProviderEnabled !== true || !(opts._qaaiExportedDataKeys instanceof Map)) return null;
  return opts._qaaiExportedDataKeys.get(String(requested).toLowerCase()) || null;
}

function rememberExportedDataKeys(opts, rows, providerEnabled) {
  if (!opts || typeof opts !== 'object') return;
  opts._qaaiDataProviderEnabled = !!providerEnabled;
  opts._qaaiExportedDataKeys = providerEnabled ? commonExportedDataKeys(rows) : new Map();
}
const KEY_MAP = { enter: 'Keys.ENTER', tab: 'Keys.TAB', escape: 'Keys.ESCAPE', esc: 'Keys.ESCAPE', backspace: 'Keys.BACK_SPACE', delete: 'Keys.DELETE', arrowdown: 'Keys.ARROW_DOWN', arrowup: 'Keys.ARROW_UP', arrowleft: 'Keys.ARROW_LEFT', arrowright: 'Keys.ARROW_RIGHT', space: 'Keys.SPACE' };
function keysExpr(key) { const k = String(key || '').toLowerCase().replace(/\s+/g, ''); return KEY_MAP[k] || `${jstr(String(key || ''))}`; }
function regexFromGlob(p) { return String(p || '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '.*'); }
function waitMs(c) { const n = Number(c && c.timeoutMs); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10000; }

function seleniumReloadRecovery(condition, totalTimeoutMs) {
  const c = condition && typeof condition === 'object' ? condition : {};
  const rawRecovery = typeof c.recovery === 'string' ? { action: c.recovery } : c.recovery;
  if (!rawRecovery || typeof rawRecovery !== 'object') return null;
  const action = String(rawRecovery.action || rawRecovery.type || rawRecovery.kind || '').trim().toLowerCase();
  if (!['reload', 'refresh', 'reload_page', 'refresh_page'].includes(action)) return null;
  const refreshAfterMs = Number(c.refreshAfterMs);
  if (!Number.isFinite(refreshAfterMs) || refreshAfterMs <= 0 || refreshAfterMs >= totalTimeoutMs) return null;
  const attempts = Number(rawRecovery.maxAttempts);
  const maxAttempts = Number.isFinite(attempts) && attempts >= 0 ? Math.floor(attempts) : 1;
  if (maxAttempts < 1) return null;
  const retry = Number(rawRecovery.retryAfterMs);
  return {
    refreshAfterMs: Math.floor(refreshAfterMs),
    retryAfterMs: Number.isFinite(retry) && retry > 0 ? Math.floor(retry) : Math.floor(refreshAfterMs),
    maxAttempts,
  };
}

function emitWaitWithReloadRecovery(condition, renderWait, fallbackTimeoutMs = 10000) {
  const totalTimeoutMs = (() => {
    const number = Number(condition && condition.timeoutMs);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallbackTimeoutMs;
  })();
  const recovery = seleniumReloadRecovery(condition, totalTimeoutMs);
  if (!recovery) return `    ${renderWait(String(totalTimeoutMs))}`;
  return [
    '    {',
    `      final long qaaiWaitDeadline = System.currentTimeMillis() + ${totalTimeoutMs}L;`,
    `      final long qaaiInitialRecoveryAfterMs = ${recovery.refreshAfterMs}L;`,
    `      final long qaaiRetryAfterMs = ${recovery.retryAfterMs}L;`,
    `      final int qaaiRecoveryLimit = ${recovery.maxAttempts};`,
    '      int qaaiRecoveryAttempt = 0;',
    '      while (true) {',
    '        long qaaiRemainingBudget = qaaiWaitDeadline - System.currentTimeMillis();',
    '        if (qaaiRemainingBudget <= 0L) throw new org.openqa.selenium.TimeoutException("Authored wait budget exhausted before the expected state was observed.");',
    '        boolean qaaiCanRecover = qaaiRecoveryAttempt < qaaiRecoveryLimit;',
    '        long qaaiRecoveryWindow = qaaiRecoveryAttempt == 0 ? qaaiInitialRecoveryAfterMs : qaaiRetryAfterMs;',
    '        long qaaiWaitBudget = qaaiCanRecover ? Math.min(qaaiRecoveryWindow, qaaiRemainingBudget) : qaaiRemainingBudget;',
    '        try {',
    `          ${renderWait('qaaiWaitBudget')}`,
    '          break;',
    '        } catch (org.openqa.selenium.TimeoutException qaaiWaitError) {',
    '          if (!qaaiCanRecover || System.currentTimeMillis() >= qaaiWaitDeadline) throw qaaiWaitError;',
    '          qaaiRecoveryAttempt += 1;',
    '          long qaaiReloadBudget = qaaiWaitDeadline - System.currentTimeMillis();',
    '          if (qaaiReloadBudget <= 0L) throw qaaiWaitError;',
    '          java.time.Duration qaaiPreviousPageLoadTimeout = driver.manage().timeouts().getPageLoadTimeout();',
    '          try {',
    '            driver.manage().timeouts().pageLoadTimeout(Duration.ofMillis(qaaiReloadBudget));',
    '            driver.navigate().refresh();',
    '          } finally {',
    '            driver.manage().timeouts().pageLoadTimeout(qaaiPreviousPageLoadTimeout);',
    '          }',
    '          if (System.currentTimeMillis() >= qaaiWaitDeadline) throw qaaiWaitError;',
    '        }',
    '      }',
    '    }',
  ].join('\n');
}

function testGroupName(value) {
  const safe = String(value || 'case')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'case';
  return `qaai_${safe}`;
}

function testAnnotation(opts = {}, dataProviderName = null) {
  const attrs = [];
  const group = testGroupName(opts.testTitle || opts.caseName || opts.testCaseId || opts.className || 'case');
  attrs.push(`groups = {${jstr(group)}}`);
  const deps = Array.isArray(opts.dependsOn) ? opts.dependsOn.filter(Boolean).map(testGroupName) : [];
  if (deps.length) {
    attrs.push(`dependsOnGroups = {${deps.map(jstr).join(', ')}}`);
    attrs.push('ignoreMissingDependencies = true');
  }
  if (dataProviderName) attrs.push(`dataProvider = ${jstr(dataProviderName)}`);
  return `@Test(${attrs.join(', ')})`;
}

function pushFinding(opts, severity, rule, message) {
  if (opts && Array.isArray(opts.adapterFindings)) opts.adapterFindings.push({ rule, severity, message, engine: 'selenium-adapter' });
}

function isExplicitFlowCritical(step) {
  const sources = [
    step,
    step && step.metadata,
    step && step.policy,
    step && step.contract,
    step && step.execution,
  ].filter((value) => value && typeof value === 'object');
  if (sources.some((value) => value.flowCritical === true
    || value.dependencyPrerequisite === true
    || value.requiredForContinuation === true
    || value.blocking === true)) return true;
  const flowRules = sources
    .flatMap((value) => [value.failureBehavior, value.onFailure, value.continuationOutcome, value.flowRule])
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase());
  return flowRules.some((value) => ['stop_descendants', 'stop_case', 'blocking', 'required_for_continuation'].includes(value));
}

function assertionOwner(step) {
  return isExplicitFlowCritical(step) ? 'Assert' : 'qaaiSoft';
}

function emitExecutableDiagnostic(message, step) {
  const text = jstr(`QAAI_DIAGNOSTIC: ${message}`);
  const failure = isExplicitFlowCritical(step) ? `Assert.fail(${text});` : `qaaiSoft.fail(${text});`;
  return `    System.err.println(${text});\n    ${failure}`;
}

function guessedRoleForAction(action, description = '') {
  const value = String(action || '').toLowerCase();
  const words = String(description || '').toLowerCase();
  if (/\b(?:heading|title)\b/.test(words)) return 'heading';
  if (/\btable\b/.test(words)) return 'table';
  if (/\brow\b/.test(words)) return 'row';
  if (/\btab\b/.test(words)) return 'tab';
  if (/\b(?:menu item|menuitem)\b/.test(words)) return 'menuitem';
  if (/\b(?:link|route)\b/.test(words)) return 'link';
  if (/\b(?:checkbox|toggle)\b/.test(words)) return 'checkbox';
  if (/\b(?:dropdown|combobox|select)\b/.test(words)) return 'combobox';
  if (/\b(?:textbox|input|field|email|password|search)\b/.test(words)) return 'textbox';
  if (/\b(?:dialog|modal|popup)\b/.test(words)) return 'dialog';
  if (/\btooltip\b/.test(words)) return 'tooltip';
  if (/\b(?:status|message|summary|count)\b/.test(words)) return 'status';
  if (/\b(?:image|avatar|profile picture)\b/.test(words)) return 'img';
  if (['fill', 'type', 'press', 'upload'].includes(value)) return 'textbox';
  if (value === 'selectoption') return 'combobox';
  if (['check', 'uncheck'].includes(value)) return 'checkbox';
  if (value === 'navigate') return 'link';
  return 'button';
}

function cleanGuessedAccessibleName(value, role) {
  let text = String(value || '').trim();
  if (isInternalReference(text)) return '';
  text = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^\s*(?:click|double[- ]?click|triple[- ]?click|fill|enter|type|hover|select|choose|upload|check|uncheck|open|verify|assert|wait(?:\s+for)?|navigate(?:\s+to)?)\s+/i, '')
    .replace(/["'`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const suffixes = role === 'textbox'
    ? /\s+(?:field|textbox|input)$/i
    : role === 'combobox'
      ? /\s+(?:dropdown|combobox|select)$/i
      : role === 'checkbox'
        ? /\s+checkbox$/i
        : role === 'link'
          ? /\s+link$/i
          : /\s+(?:button|icon|menu item|menuitem|tab)$/i;
  return text.replace(suffixes, '').trim();
}

function guessedLocatorCandidate(candidates, step, ir) {
  const rawRef = String(step && (step.as || step.target) || '');
  const consumer = step && step.op === 'resolve' ? consumerForResolve(ir, rawRef) : step;
  const details = candidateSemanticDetails(candidates);
  const action = consumer && (consumer.op === 'waitFor' ? 'waitFor' : consumer.action);
  const semanticValues = [
    step && step.elementLabel,
    step && step.narration,
    step && step.label,
    details.label,
    consumer && consumer.elementLabel,
    consumer && consumer.targetLabel,
    consumer && consumer.label,
    consumer && consumer.narration,
    consumer && consumer.description,
    consumer && consumer.plannedText,
    consumer && consumer.raw && consumer.raw.target,
    !isInternalReference(rawRef) ? rawRef : null,
    semanticReferenceName(rawRef, ir, `${action || 'page'}Element`),
  ];
  const descriptor = semanticValues.filter(Boolean).join(' ');
  const role = String(details.role
    || (consumer && (consumer.role || consumer.targetRole || (consumer.element && consumer.element.role)))
    || guessedRoleForAction(action, descriptor));
  let label = '';
  for (const value of semanticValues) {
    label = cleanGuessedAccessibleName(value, role);
    if (label) break;
  }
  if (!label) label = cleanGuessedAccessibleName(`${action || 'page'} ${role}`, role) || 'Page element';
  return { role, label, factory: `LocatorCandidate.role(${jstr(role)}, ${jstr(label)})` };
}

function sessionLifecycleOverrides(opts = {}) {
  const continueSession = opts.continueSession === true;
  const preserveSessionForDependents = opts.preserveSessionForDependents === true;
  return [
    '  @Override',
    `  protected boolean continueSession() { return ${continueSession}; }`,
    '',
    '  @Override',
    `  protected boolean preserveSessionForDependents() { return ${preserveSessionForDependents}; }`,
  ].join('\n');
}

// A normalized candidate → a `LocatorCandidate.x(...)` factory expression, or null when it
// cannot be deterministically mapped (caller drops it with a finding; never invents a By).
function candidateFactory(c) {
  const n = normalizeCandidate(c) || {};
  const context = Array.isArray(n.contextText) && n.contextText.length
    ? `.withContext(new String[]{ ${n.contextText.map(jstr).join(', ')} })`
    : '';
  switch (n.strategy) {
    case 'role': return n.role ? `${n.name ? `LocatorCandidate.role(${jstr(n.role)}, ${jstr(n.name)})` : `LocatorCandidate.roleOnly(${jstr(n.role)})`}${context}` : null;
    case 'css': return n.selector ? `LocatorCandidate.css(${jstr(n.selector)})${context}` : null;
    case 'xpath': return n.selector ? `LocatorCandidate.xpath(${jstr(n.selector)})${context}` : null;
    case 'testId': return n.testId ? `LocatorCandidate.testId(${jstr(n.testId)})${context}` : null;
    case 'text': return n.text ? `LocatorCandidate.text(${jstr(n.text)})${context}` : null;
    case 'placeholder': return n.text ? `LocatorCandidate.placeholder(${jstr(n.text)})${context}` : null;
    case 'label': return n.text ? `LocatorCandidate.label(${jstr(n.text)})${context}` : null;
    default: return null;
  }
}

function parseSeleniumByExpression(expression) {
  const match = String(expression || '').trim().match(/^By\.(cssSelector|xpath)\((.+)\)$/s);
  if (!match) return null;
  let value;
  try { value = JSON.parse(match[2]); } catch (_) { return null; }
  if (typeof value !== 'string' || !value.trim()) return null;
  return {
    factory: match[1] === 'xpath' ? `LocatorCandidate.xpath(${jstr(value)})` : `LocatorCandidate.css(${jstr(value)})`,
    strategy: match[1] === 'xpath' ? 'xpath' : 'css',
    selector: value,
  };
}

function actionLocatorEvidence(step, ir) {
  const consumer = step && step.op === 'resolve'
    ? consumerForResolve(ir, String(step.as || step.target || ''))
    : null;
  const recipe = step && (step.actionLocator || step.locatorRecipe)
    || consumer && (consumer.actionLocator || consumer.locatorRecipe)
    || null;
  if (!recipe || typeof recipe !== 'object') return null;
  const primary = actionLocatorResolver.primaryActionLocator(recipe);
  const expression = primary?.frameworkExpressions?.selenium
    || recipe.frameworkExpressions?.selenium
    || null;
  const parsed = parseSeleniumByExpression(expression);
  if (!parsed) return null;
  return {
    ...parsed,
    verified: actionLocatorResolver.isVerifiedActionLocator(recipe),
    source: primary?.verificationSource || primary?.evidenceSource || primary?.proof?.source
      || recipe.verificationSource || recipe.evidenceSource || recipe.source || 'action-time locator evidence',
  };
}

function observedNavigation(step) {
  const sources = [step, step && step.metadata, step && step.provenance, step && step.navigation]
    .filter((value) => value && typeof value === 'object');
  return sources.some((value) => value.observedOnly === true
    || value.contextSwitchInferred === true
    || value.authored === false
    || ['observed', 'inferred', 'redirect', 'popup_context'].includes(String(value.navigationKind || value.transitionKind || value.kind || '').toLowerCase()));
}

function observedPopupNavigation(step) {
  const sources = [step, step && step.metadata, step && step.provenance, step && step.navigation]
    .filter((value) => value && typeof value === 'object');
  return sources.some((value) => value.popupIdentity
    || value.popup === true
    || value.newTab === true
    || ['popup', 'popup_context', 'popup_destination', 'new_tab', 'newtab']
      .includes(String(value.navigationKind || value.transitionKind || value.kind || '').toLowerCase()));
}

function observedUrlSignal(url) {
  const raw = String(url || '').trim();
  if (!raw) return '/';
  try {
    const parsed = new URL(raw);
    return `${parsed.pathname || '/'}${parsed.hash || ''}`;
  } catch (_) {
    return raw.replace(/[?#].*$/, '') || '/';
  }
}

function emitNavigation(step) {
  const url = String(step && step.url || '');
  if (!observedNavigation(step)) return `    driver.get(${jstr(url)});`;
  const signal = observedUrlSignal(url);
  const popup = observedPopupNavigation(step);
  return [
    popup
      ? '    // QAAI_OBSERVED_POPUP: Observed popup/new-tab context switch retained as non-authored evidence; wait for its destination without inventing a second navigation.'
      : '    // QAAI_OBSERVED_NAVIGATION: The browser reached this location through the preceding authored action; do not invent a second navigation.',
    `    new WebDriverWait(driver, Duration.ofMillis(${waitMs(step && step.condition)})).until(ExpectedConditions.urlContains(${jstr(signal)}));`,
  ].join('\n');
}

// ── the 15 REQUIRED_METHODS ───────────────────────────────────────────────────
function emitSetup(ir, opts = {}) {
  const className = (opts && opts.className) || classNameFor(ir.caseId, null, null, ir.title);
  const mapImport = opts.dataCaseSlug ? '\nimport java.util.Map;' : '';
  return `package ${PACKAGE};

import org.openqa.selenium.Keys;
import org.openqa.selenium.JavascriptExecutor;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.support.ui.ExpectedConditions;
import org.openqa.selenium.support.ui.Select;
import org.openqa.selenium.support.ui.WebDriverWait;
import org.testng.Assert;
import org.testng.asserts.SoftAssert;
import org.testng.annotations.DataProvider;
import org.testng.annotations.Test;
import java.time.Duration;${mapImport}

/** QAAI ReplayIR export generated from the authored flow "${esc(ir.title || 'Selenium case')}". */
public class ${className} extends BaseTest {
${sessionLifecycleOverrides(opts)}`;
}

function emitRetryPolicy() {
  return ''; // TestNG retry needs a shared analyzer; v1 keeps retries off (filtered out).
}

function emitDataProvider(rows, replayIR, opts = {}) {
  const note = Array.isArray(rows) && rows.length
    ? `    // data row(s): ${esc(rows.map((r) => r.label || ('Row ' + r.index)).join(' | '))}\n`
    : '';
  // When a per-case data file was exported, emit a real TestNG @DataProvider that
  // reads from it via DataReader.  The test method receives one Map<String,String> per row.
  if (opts.dataCaseSlug) {
    rememberExportedDataKeys(opts, rows, true);
    const dataPath = `src/test/resources/test-data/${opts.dataCaseSlug}.json`;
    return `  @DataProvider(name = "caseData")
  public Object[][] caseData() {
    return DataReader.readJson(${jstr(dataPath)});
  }

  ${testAnnotation(opts, 'caseData')}
  public void replay(Map<String, String> row) throws Exception {
${note}    SoftAssert qaaiSoft = new SoftAssert();`.replace(/\n+$/, '');
  }
  // Fallback: single-execution @Test (non-DDT run or all fields masked).
  rememberExportedDataKeys(opts, [], false);
  return `  ${testAnnotation(opts)}
  public void replay() throws Exception {
${note}    SoftAssert qaaiSoft = new SoftAssert();`.replace(/\n+$/, '');
}

function emitAuth(authProfile) {
  const id = typeof authProfile === 'string' ? authProfile : (authProfile && authProfile.id) || 'unknown';
  const strategy = (authProfile && typeof authProfile === 'object' && authProfile.strategy) || 'unknown';
  return `    // Auth profile ${esc(id)}: strategy ${esc(strategy)} — driver/session lifecycle provided by BaseTest.`;
}

function emitLocatorResolver(candidates, step, ir, opts = {}) {
  const name = semanticReferenceName(step.as || step.target, ir, 'pageElement');
  let label = labelForCandidates(candidates);
  const exprs = [];
  const actionEvidence = actionLocatorEvidence(step, ir);
  let guessed = !actionEvidence?.verified || !!(step && (step.guessedLocator || step.locatorProvenance?.kind === 'qaai_guessed_locator'));
  if (actionEvidence?.verified) {
    exprs.push(actionEvidence.factory);
  } else {
    const fallback = guessedLocatorCandidate(candidates, step, ir);
    exprs.push(fallback.factory);
    label = fallback.label;
    guessed = true;
    if (actionEvidence?.factory) exprs.push(actionEvidence.factory);
    for (const c of normalizeCandidates(candidates)) {
      const f = candidateFactory(c);
      if (f) exprs.push(f);
      else pushFinding(opts, 'warning', `selenium_strategy_unsupported:${(normalizeCandidate(c) || {}).strategy || 'unknown'}`,
        `Locator candidate for "${esc(label)}" has no deterministic Selenium mapping and was dropped (no invented selector).`);
    }
    pushFinding(opts, 'warning', 'selenium_locator_semantic_fallback',
      `No stable live locator was available for "${esc(label)}"; emitted an editable semantic role/name locator.`);
  }
  const uniqueExprs = [...new Set(exprs)];
  const warning = guessed
    ? `    // QAAI_GUESSED_LOCATOR: ${esc(actionEvidence?.source || (uniqueExprs.length ? 'Candidate locator evidence was not action-time verified.' : 'Live DOM evidence was unavailable.'))}\n    // The complete authored step is preserved. Replace only this locator with a reliable DOM locator if it does not match the intended element.\n`
    : '';
  return `${warning}    WebElement ${name} = LocatorResolver.resolve(driver, new LocatorCandidate[]{ ${uniqueExprs.join(', ')} }, ${jstr(label)});`;
}

function seleniumModifierKeys(modifiers) {
  const aliases = {
    alt: 'Keys.ALT', control: 'Keys.CONTROL', ctrl: 'Keys.CONTROL', controlormeta: 'Keys.CONTROL',
    meta: 'Keys.COMMAND', command: 'Keys.COMMAND', cmd: 'Keys.COMMAND', shift: 'Keys.SHIFT',
  };
  return Array.from(new Set((Array.isArray(modifiers) ? modifiers : [])
    .map((value) => aliases[String(value || '').replace(/[^a-z]/gi, '').toLowerCase()] || null)
    .filter(Boolean)));
}

function emitSeleniumClick(step, target, count) {
  const button = String(step && step.button || 'left').toLowerCase();
  const clicks = Math.max(1, Math.floor(Number(count) || 1));
  const modifiers = seleniumModifierKeys(step && step.modifiers);
  const modifierWarning = (step && step.modifiers || []).some((value) => /controlormeta/i.test(String(value)))
    ? '    // QAAI_WARNING: Selenium Java has no portable ControlOrMeta key; this package uses Control.\n'
    : '';
  if (button === 'middle') {
    const flags = {
      altKey: modifiers.includes('Keys.ALT'),
      ctrlKey: modifiers.includes('Keys.CONTROL'),
      metaKey: modifiers.includes('Keys.COMMAND'),
      shiftKey: modifiers.includes('Keys.SHIFT'),
    };
    const script = `arguments[0].dispatchEvent(new MouseEvent('auxclick',{bubbles:true,cancelable:true,button:1,detail:${clicks},altKey:${flags.altKey},ctrlKey:${flags.ctrlKey},metaKey:${flags.metaKey},shiftKey:${flags.shiftKey}}));`;
    return `${modifierWarning}    // QAAI_WARNING: Selenium has no high-level middle-click primitive; dispatch an executable DOM auxclick equivalent.\n    ((org.openqa.selenium.JavascriptExecutor) driver).executeScript(${jstr(script)}, ${target});`;
  }
  const actions = [];
  for (const key of modifiers) actions.push(`keyDown(${key})`);
  if (button === 'right') {
    for (let index = 0; index < clicks; index++) actions.push(`contextClick(${target})`);
  } else if (clicks === 2) actions.push(`doubleClick(${target})`);
  else {
    for (let index = 0; index < clicks; index++) actions.push(`click(${target})`);
  }
  for (const key of [...modifiers].reverse()) actions.push(`keyUp(${key})`);
  if (button === 'left' && clicks === 1 && !modifiers.length) return `    ${target}.click();`;
  const warning = clicks >= 3
    ? '    // QAAI_WARNING: Selenium has no direct triple-click primitive; emit three executable clicks in one Actions chain.\n'
    : '';
  return `${modifierWarning}${warning}    new org.openqa.selenium.interactions.Actions(driver).${actions.join('.')}.perform();`;
}

function seleniumSelectExpression(step, target, fallback) {
  const values = Array.isArray(step && step.optionValues) ? step.optionValues.map(String) : [];
  if (!values.length) return `    new Select(${target}).selectByVisibleText(${fallback});`;
  const selections = values.map((value) => `qaaiSelect.selectByVisibleText(${jstr(value)});`).join(' ');
  const multiWarning = values.length > 1
    ? ` if (!qaaiSelect.isMultiple()) System.err.println(${jstr('QAAI_WARNING: Multiple recorded option values target a single-select element; Selenium will select them in order and the last value will remain.')});`
    : '';
  return `    { Select qaaiSelect = new Select(${target});${multiWarning} ${selections} }`;
}

function hasResolveFor(ir, ref) {
  return !!(ir && Array.isArray(ir.steps) && ir.steps.some((candidate) => candidate
    && candidate.op === 'resolve' && String(candidate.as || candidate.target || '') === String(ref || '')));
}

function wrapWithGuessedTargets(step, ir, opts, code) {
  const targets = [
    { ref: step && step.target, name: semanticReferenceName(step && step.target, ir, 'pageElement') },
    { ref: step && step.destinationTarget, name: semanticReferenceName(step && step.destinationTarget, ir, 'destinationElement') },
  ].filter((entry, index, values) => entry.ref && !hasResolveFor(ir, entry.ref)
    && values.findIndex((candidate) => String(candidate.ref) === String(entry.ref)) === index);
  if (!targets.length) return code;
  const declarations = targets.map((entry) => {
    const fallback = guessedLocatorCandidate([], { ...step, target: entry.ref }, ir);
    pushFinding(opts, 'warning', 'selenium_locator_semantic_fallback',
      `Action target "${esc(fallback.label)}" had no resolve step; emitted an inline semantic role/name locator.`);
    return [
      '      // QAAI_GUESSED_LOCATOR: Live DOM evidence was unavailable, so QAAI guessed this locator from the semantic step description.',
      '      // Replace this locator with a reliable DOM locator if it does not match the intended element.',
      `      WebElement ${entry.name} = LocatorResolver.resolve(driver, new LocatorCandidate[]{ ${fallback.factory} }, ${jstr(fallback.label)});`,
    ].join('\n');
  }).join('\n');
  const indented = String(code).split('\n').map((line) => `  ${line}`).join('\n');
  return `    {\n${declarations}\n${indented}\n    }`;
}

function emitStep(step, ir, opts = {}) {
  const t = semanticReferenceName(step.target, ir, 'pageElement');
  const destination = semanticReferenceName(step.destinationTarget, ir, 'destinationElement');
  const a = step.action;
  if (step && step.authored === false && a !== 'navigate') {
    const identity = step.contractStepId || step.sourceContractStepId || 'unmatched runtime operation';
    return `    // QAAI_RUNTIME_EVIDENCE: Observed ${esc(a || 'runtime operation')} evidence (${esc(identity)}) was not replayed because it had no exact authored contract identity and operation match.`;
  }
  // When the emitter tagged this step with a data-row role, read from the DataProvider row
  // rather than the env (EnvReader).  Applies to fill and selectOption value steps.
  const rowKey = !isEnvironmentValueRef(step && step.valueRef)
    ? exportedDataKey(opts, explicitDataRole(step))
    : null;
  const explicitBinding = typedBinding(step, opts, ir, false);
  const dataVal = rowKey ? `DataReader.required(row, ${jstr(rowKey)})` : null;
  const boundVal = explicitBinding ? bindingExpression(step, opts, ir, false).expression : null;
  const withTargets = (code) => wrapWithGuessedTargets(step, ir, opts, code);
  if (a === 'navigate') return emitNavigation(step);
  if (a === 'navigateBack') return `    driver.navigate().back();`;
  if (a === 'navigateForward') return `    driver.navigate().forward();`;
  if (a === 'fill') return withTargets(`    ${t}.clear();\n    ${t}.sendKeys(${boundVal || dataVal || valueExpr(step, opts, ir)});`);
  if (a === 'click') return withTargets(emitSeleniumClick(step, t, 1));
  if (a === 'doubleClick') return withTargets(emitSeleniumClick(step, t, 2));
  if (a === 'tripleClick') return withTargets(emitSeleniumClick(step, t, 3));
  if (a === 'selectOption') return withTargets(seleniumSelectExpression(step, t, boundVal || dataVal || valueExpr(step, opts, ir)));
  if (a === 'check') return withTargets(`    if (!${t}.isSelected()) ${t}.click();`);
  if (a === 'uncheck') return withTargets(`    if (${t}.isSelected()) ${t}.click();`);
  if (a === 'press') return withTargets(step.key ? `    ${t}.sendKeys(${keysExpr(step.key)});` : `    ${t}.sendKeys(${boundVal || dataVal || valueExpr(step, opts, ir)});`);
  if (a === 'hover') return withTargets(`    new org.openqa.selenium.interactions.Actions(driver).moveToElement(${t}).perform();`);
  if (a === 'drag') return withTargets(`    new org.openqa.selenium.interactions.Actions(driver).dragAndDrop(${t}, ${destination}).perform();`);
  if (a === 'upload') {
    const paths = Array.isArray(step.filePaths) && step.filePaths.length ? jstr(step.filePaths.map(String).join('\n')) : null;
    return withTargets(`    ${t}.sendKeys(${paths || boundVal || dataVal || valueExpr(step, opts, ir)});`);
  }
  if (a === 'handleDialog') {
    const acceptCall = step.accept === false ? 'qaaiDialog.dismiss();' : 'qaaiDialog.accept();';
    const prompt = step.promptText != null ? ` qaaiDialog.sendKeys(${jstr(step.promptText)});` : '';
    return `    { org.openqa.selenium.Alert qaaiDialog = driver.switchTo().alert();${prompt} ${acceptCall} }`;
  }
  if (a === 'resize') {
    const width = Number.isFinite(Number(step.width)) && Number(step.width) > 0 ? Math.floor(Number(step.width)) : 1280;
    const height = Number.isFinite(Number(step.height)) && Number(step.height) > 0 ? Math.floor(Number(step.height)) : 720;
    const warning = step.width && step.height ? '' : '    // QAAI_WARNING: The recorded viewport was incomplete; using the executable 1280x720 fallback.\n';
    return `${warning}    driver.manage().window().setSize(new org.openqa.selenium.Dimension(${width}, ${height}));`;
  }
  if (a === 'close') return `    driver.close();`;
  pushFinding(opts, 'warning', `selenium_action_unsupported:${a || 'unknown'}`,
    `Authored action ${a || 'unknown'} has no dedicated Selenium primitive; emitted an executable diagnostic.`);
  return emitExecutableDiagnostic(`Selenium could not execute authored action "${a || 'unknown'}". The step remains in order and later independent steps will continue.`, step);
}

function emitWait(condition, step, ir, opts = {}) {
  const c = condition || {};
  const ms = waitMs(c);
  if (c.kind === 'url' && c.pattern) {
    return emitWaitWithReloadRecovery(c, (timeoutExpression) => `new WebDriverWait(driver, Duration.ofMillis(${timeoutExpression})).until(ExpectedConditions.urlMatches(${jstr(regexFromGlob(c.pattern))}));`);
  }
  if (c.kind === 'visible' && c.target) {
    const recovery = seleniumReloadRecovery(c, ms);
    const targetName = semanticReferenceName(c.target, ir, 'visibleTarget');
    const resolve = ir && Array.isArray(ir.steps)
      ? ir.steps.find((candidate) => candidate && candidate.op === 'resolve' && String(candidate.as) === String(c.target))
      : null;
    const factories = (resolve && Array.isArray(resolve.candidates) ? resolve.candidates : []).map(candidateFactory).filter(Boolean);
    let guessed = false;
    if (!factories.length) {
      const fallback = guessedLocatorCandidate(resolve && resolve.candidates, resolve || { ...step, target: c.target }, ir);
      factories.push(fallback.factory);
      guessed = true;
      pushFinding(opts, 'warning', 'selenium_wait_locator_semantic_fallback',
        `Wait target ${targetName} had no stable live locator; emitted an editable semantic role/name locator.`);
    }
    const fallbackLabel = guessedLocatorCandidate(resolve && resolve.candidates, resolve || { ...step, target: c.target }, ir).label;
    const label = guessed ? fallbackLabel : labelForCandidates(resolve && resolve.candidates);
    const warning = guessed
      ? '    // QAAI_GUESSED_LOCATOR: The authored wait had no verified DOM locator; QAAI emitted a semantic role/name fallback.\n'
      : '';
    if (!recovery && resolve && !guessed) {
      return `    new WebDriverWait(driver, Duration.ofMillis(${ms})).until(ExpectedConditions.visibilityOf(${targetName}));`;
    }
    return `${warning}${emitWaitWithReloadRecovery(c, (timeoutExpression) => `new WebDriverWait(driver, Duration.ofMillis(${timeoutExpression})).until(d -> LocatorResolver.resolve(d, new LocatorCandidate[]{ ${factories.join(', ')} }, ${jstr(label)}).isDisplayed());`)}`;
  }
  if (c.kind === 'networkidle') {
    if (seleniumReloadRecovery(c, ms)) {
      return emitWaitWithReloadRecovery(c, (timeoutExpression) => `new WebDriverWait(driver, Duration.ofMillis(${timeoutExpression})).until(d -> "complete".equals(String.valueOf(((JavascriptExecutor) d).executeScript("return document.readyState"))));`);
    }
    return `    // networkidle: Selenium has no precise idle-network signal; sleeping instead.\n    try { Thread.sleep(${Math.min(ms, 3000)}); } catch (InterruptedException ignored) {}`;
  }
  pushFinding(opts, 'warning', `selenium_wait_unsupported:${c.kind || 'unknown'}`,
    `Authored wait ${c.kind || 'unknown'} has no dedicated Selenium primitive; emitted an executable diagnostic.`);
  return emitExecutableDiagnostic(`Selenium could not faithfully execute authored wait condition "${c.kind || 'unknown'}" within ${ms} ms. The step remains in order and later independent steps will continue.`, step);
}

function emitPopupHandling(known) {
  const exprs = [];
  for (const c of known || []) { const f = candidateFactory(c); if (f) exprs.push(f); }
  return `    LocatorResolver.dismissKnownPopups(driver, new LocatorCandidate[]{ ${exprs.join(', ')} });`;
}

function emitBooleanAssertion(step, method, expression, message) {
  const owner = assertionOwner(step);
  const statement = `${owner}.${method}(${expression}, ${message});`;
  if (owner === 'Assert') return `    ${statement}`;
  const unavailable = jstr(`QAAI_DIAGNOSTIC: Selenium could not evaluate ${step.channel || 'authored'} assertion ${step.contractRef || ''}: `);
  return [
    '    try {',
    `      ${statement}`,
    '    } catch (RuntimeException qaaiAssertionError) {',
    `      String qaaiAssertionMessage = ${unavailable} + qaaiAssertionError.getMessage();`,
    '      System.err.println(qaaiAssertionMessage);',
    '      qaaiSoft.fail(qaaiAssertionMessage);',
    '    }',
  ].join('\n');
}

function emitAssertion(step, ir, opts = {}) {
  const ch = step.channel;
  if (UNSUPPORTED_CHANNELS.has(ch)) {
    pushFinding(opts, 'warning', `selenium_channel_unsupported:${ch}`,
      `Assert channel ${ch} (${esc(step.contractRef)}) has no faithful Selenium oracle; emitted an executable diagnostic.`);
    return emitExecutableDiagnostic(`Selenium has no faithful ${ch} oracle for ${step.contractRef || 'this authored assertion'}. The mismatch is recorded and later independent checks will continue.`, step);
  }
  const exp = step.expected;
  const expectedRefIsEnvironment = step.expectedRef && ch !== 'URL' && isEnvironmentValueRef(step.expectedRef);
  const requestedExpectedKey = step.dataExpected
    || (step.dataBinding && step.dataBinding.expectedColumn)
    || dataRoleFromRef(step.expectedRef);
  const rowKey = exportedDataKey(opts, requestedExpectedKey);
  if ((exp == null || exp === '') && !expectedRefIsEnvironment && !rowKey) {
    pushFinding(opts, 'error', 'assert_expected_missing',
      `Assert ${esc(step.contractRef)} (${ch}) recorded with no concrete expected value; refusing to emit a no-op assertion.`);
    return emitExecutableDiagnostic(`${ch} assertion ${step.contractRef || ''} has no concrete expected value. The assertion remains visible as a failure instead of becoming a no-op.`, step);
  }
  // Priority: data-row reference > env-ref > hardcoded literal.
  // dataExpected: assertion expected value came from a DDT data row fill — emit
  //   row.get(role) so each DataProvider iteration asserts the correct value.
  // expectedRef: expected value came from a credential/env fill — emit EnvReader.read().
  const typedExpected = typedBinding(step, opts, ir, true);
  const expExpr = typedExpected
    ? bindingExpression(step, opts, ir, true).expression
    : expectedRefIsEnvironment
      ? `EnvReader.required(${jstr(envKeyFromRef(step.expectedRef, 'QAAI_EXPECTED'))})`
      : (rowKey ? `DataReader.required(row, ${jstr(rowKey)})` : jstr(String(exp == null ? '' : exp)));
  const msg = jstr(`${ch} ${step.contractRef}: ${String(exp)}`);
  if (ch === 'URL') return emitBooleanAssertion(step, 'assertTrue', `urlMatches(${jstr(String(exp))})`, msg);
  if (ch === 'FORBIDDEN_TEXT' || ch === 'FORBIDDEN_ROLE') {
    // expectedRef not applicable to forbidden checks
    if (step.scope?.selector) return emitBooleanAssertion(step, 'assertFalse', `seesTextInScope(${jstr(step.scope.selector)}, ${expExpr})`, msg);
    return emitBooleanAssertion(step, 'assertFalse', `seesText(${expExpr})`, msg);
  }
  // UI_TEXT / UI_ROLE / PAGE — use expExpr so data-bound assertions reference EnvReader when applicable.
  if (step.scope?.selector) return emitBooleanAssertion(step, 'assertTrue', `seesTextInScope(${jstr(step.scope.selector)}, ${expExpr})`, msg);
  return emitBooleanAssertion(step, 'assertTrue', `seesText(${expExpr})`, msg);
}

function emitHumanInput(disposition, step) {
  const field = ident(step.field || 'humanInput');
  if (disposition === 'test_hook') {
    const ref = envKeyFromRef(step.valueRef, `QAAI_${String(step.field || 'INPUT').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`);
    const diagnostic = emitExecutableDiagnostic(`Missing runtime value for authored human-input hook ${step.field || 'humanInput'} (${ref}).`, step)
      .split('\n').map((line) => `  ${line}`).join('\n');
    return `    String ${field} = System.getenv(${jstr(ref)});
    if (${field} == null || ${field}.isEmpty()) {
${diagnostic}
    }`;
  }
  if (disposition === 'manual_gate') {
    return emitExecutableDiagnostic(`The authored step requires manual human input for ${step.field || 'unknown'}. It was not skipped; the unmet input is recorded and later independent steps will continue.`, step);
  }
  return emitExecutableDiagnostic(`Selenium cannot automate the authored human-input variant for ${step.field || 'unknown'}. The unmet input is recorded and later independent steps will continue.`, step);
}

function emitTeardown(ir) {
  return `    captureScreenshot(${jstr(slug(ir.title || ir.caseId, 'selenium-case'))});
    qaaiSoft.assertAll();
  }
}`;
}

function fileLayout(ir, opts = {}) {
  const className = (opts && opts.className) || classNameFor(ir.caseId, null, null, ir.title);
  const p = `src/test/java/${PACKAGE_PATH}/${className}.java`;
  return { primaryFile: p, testFile: p, className, packageName: PACKAGE };
}

function compileCmd() { return { cmd: 'mvn', args: ['-q', '-DskipTests', 'test-compile'] }; }
function runCmd() { return { cmd: 'mvn', args: ['test'] }; }
async function validatePackage(opts = {}) { return packageValidate.validatePackage({ ...opts, framework: VALIDATE_FRAMEWORK }); }

// ── IR-agnostic Maven/TestNG shell ─────────────────────────────────────────────
const POM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.qaai</groupId>
  <artifactId>qaai-replayir-selenium-export</artifactId>
  <version>0.0.0</version>
  <packaging>jar</packaging>

  <properties>
    <maven.compiler.release>11</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <selenium.version>4.18.1</selenium.version>
    <testng.version>7.10.2</testng.version>
  </properties>

  <dependencies>
    <dependency>
      <groupId>org.seleniumhq.selenium</groupId>
      <artifactId>selenium-java</artifactId>
      <version>\${selenium.version}</version>
    </dependency>
    <dependency>
      <groupId>org.testng</groupId>
      <artifactId>testng</artifactId>
      <version>\${testng.version}</version>
    </dependency>
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.2.5</version>
        <configuration>
          <suiteXmlFiles>
            <suiteXmlFile>testng.xml</suiteXmlFile>
          </suiteXmlFiles>
        </configuration>
      </plugin>
    </plugins>
  </build>
</project>
`;

const TESTNG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE suite SYSTEM "https://testng.org/testng-1.0.dtd">
<!-- QAAI ReplayIR Selenium export — discovers every generated @Test in ${PACKAGE}. -->
<suite name="QAAI ReplayIR Selenium Export" verbose="1">
  <test name="replayir">
    <packages>
      <package name="${PACKAGE}"/>
    </packages>
  </test>
</suite>
`;

const DATA_READER_JAVA = String.raw`package ${PACKAGE};

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Reads QAAI DataRow JSON files exported alongside the test specs. */
public final class DataReader {
  private DataReader() {}

  public static String required(Map<String, String> row, String column) {
    if (row == null) throw new IllegalStateException("Missing workbook row for required column " + column);
    String value = row.get(column);
    if (value == null || value.isEmpty()) throw new IllegalStateException("Missing required workbook value for column " + column);
    return value;
  }

  public static Object[][] readJson(String path) {
    try {
      String json = Files.readString(Paths.get(path), StandardCharsets.UTF_8);
      List<Map<String, String>> rows = new Parser(json).parseRows();
      Object[][] data = new Object[rows.size()][1];
      for (int i = 0; i < rows.size(); i++) {
        data[i][0] = rows.get(i);
      }
      return data;
    } catch (IOException e) {
      throw new RuntimeException("Failed to read test data from " + path + ": " + e.getMessage(), e);
    } catch (RuntimeException e) {
      throw new RuntimeException("Invalid QAAI test data JSON in " + path + ": " + e.getMessage(), e);
    }
  }

  private static final class Parser {
    private final String source;
    private int index;

    Parser(String source) {
      this.source = source == null ? "" : source;
    }

    List<Map<String, String>> parseRows() {
      skipWs();
      expect('[');
      List<Map<String, String>> rows = new ArrayList<>();
      skipWs();
      if (peek(']')) {
        index++;
        return rows;
      }
      while (true) {
        rows.add(parseObject());
        skipWs();
        if (peek(',')) {
          index++;
          continue;
        }
        expect(']');
        return rows;
      }
    }

    private Map<String, String> parseObject() {
      expect('{');
      Map<String, String> row = new LinkedHashMap<>();
      skipWs();
      if (peek('}')) {
        index++;
        return row;
      }
      while (true) {
        String key = parseString();
        skipWs();
        expect(':');
        String value = parseValue();
        if (value != null) row.put(key, value);
        skipWs();
        if (peek(',')) {
          index++;
          continue;
        }
        expect('}');
        return row;
      }
    }

    private String parseValue() {
      skipWs();
      if (peek('"')) return parseString();
      if (startsWith("null")) {
        index += 4;
        return null;
      }
      if (startsWith("true")) {
        index += 4;
        return "true";
      }
      if (startsWith("false")) {
        index += 5;
        return "false";
      }
      if (peek('{') || peek('[')) return parseNestedJson();
      int start = index;
      while (index < source.length()) {
        char ch = source.charAt(index);
        if (ch == ',' || ch == '}' || ch == ']' || Character.isWhitespace(ch)) break;
        index++;
      }
      if (start == index) throw error("expected JSON value");
      return source.substring(start, index);
    }

    private String parseNestedJson() {
      int start = index;
      int depth = 0;
      boolean inString = false;
      boolean escaped = false;
      while (index < source.length()) {
        char ch = source.charAt(index++);
        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (ch == '\\') {
            escaped = true;
          } else if (ch == '"') {
            inString = false;
          }
          continue;
        }
        if (ch == '"') {
          inString = true;
        } else if (ch == '{' || ch == '[') {
          depth++;
        } else if (ch == '}' || ch == ']') {
          depth--;
          if (depth == 0) return source.substring(start, index);
        }
      }
      throw error("unterminated nested JSON value");
    }

    private String parseString() {
      expect('"');
      StringBuilder out = new StringBuilder();
      while (index < source.length()) {
        char ch = source.charAt(index++);
        if (ch == '"') return out.toString();
        if (ch != '\\') {
          out.append(ch);
          continue;
        }
        if (index >= source.length()) throw error("unterminated escape");
        char esc = source.charAt(index++);
        switch (esc) {
          case '"': out.append('"'); break;
          case '\\': out.append('\\'); break;
          case '/': out.append('/'); break;
          case 'b': out.append('\b'); break;
          case 'f': out.append('\f'); break;
          case 'n': out.append('\n'); break;
          case 'r': out.append('\r'); break;
          case 't': out.append('\t'); break;
          case 'u':
            if (index + 4 > source.length()) throw error("short unicode escape");
            out.append((char) Integer.parseInt(source.substring(index, index + 4), 16));
            index += 4;
            break;
          default:
            throw error("unsupported escape \\" + esc);
        }
      }
      throw error("unterminated string");
    }

    private void skipWs() {
      while (index < source.length() && Character.isWhitespace(source.charAt(index))) index++;
    }

    private boolean peek(char expected) {
      return index < source.length() && source.charAt(index) == expected;
    }

    private boolean startsWith(String token) {
      return source.startsWith(token, index);
    }

    private void expect(char expected) {
      skipWs();
      if (!peek(expected)) throw error("expected '" + expected + "'");
      index++;
    }

    private IllegalArgumentException error(String message) {
      return new IllegalArgumentException(message + " at offset " + index);
    }
  }
}
`;

const ENV_READER_JAVA = `package ${PACKAGE};

/** Resolves valueRefs from the environment — never an inline credential literal. */
public final class EnvReader {
  private EnvReader() {}

  public static String read(String name) {
    String v = System.getenv(name);
    if (v == null || v.isEmpty()) {
      throw new IllegalStateException("Missing required environment variable " + name);
    }
    return v;
  }

  public static String required(String name) {
    return read(name);
  }
}
`;

const LOCATOR_CANDIDATE_JAVA = `package ${PACKAGE};

/** A single recorded locator candidate, mirroring the frozen ReplayIR candidate strategies. */
public final class LocatorCandidate {
  public final String strategy;
  public final String role;
  public final String name;
  public final String selector;
  public final String testId;
  public final String text;
  public final String[] contextText;

  private LocatorCandidate(String strategy, String role, String name, String selector, String testId, String text, String[] contextText) {
    this.strategy = strategy;
    this.role = role;
    this.name = name;
    this.selector = selector;
    this.testId = testId;
    this.text = text;
    this.contextText = contextText == null ? new String[]{} : contextText;
  }

  public static LocatorCandidate role(String role, String name) { return new LocatorCandidate("role", role, name, null, null, null, null); }
  public static LocatorCandidate roleOnly(String role) { return new LocatorCandidate("role", role, null, null, null, null, null); }
  public static LocatorCandidate css(String selector) { return new LocatorCandidate("css", null, null, selector, null, null, null); }
  public static LocatorCandidate xpath(String selector) { return new LocatorCandidate("xpath", null, null, selector, null, null, null); }
  public static LocatorCandidate testId(String testId) { return new LocatorCandidate("testId", null, null, null, testId, null, null); }
  public static LocatorCandidate text(String text) { return new LocatorCandidate("text", null, null, null, null, text, null); }
  public static LocatorCandidate placeholder(String text) { return new LocatorCandidate("placeholder", null, null, null, null, text, null); }
  public static LocatorCandidate label(String text) { return new LocatorCandidate("label", null, null, null, null, text, null); }

  public LocatorCandidate withContext(String[] contextText) {
    return new LocatorCandidate(strategy, role, name, selector, testId, text, contextText);
  }

  @Override
  public String toString() {
    return strategy + (name != null ? "(" + name + ")" : "") + (role != null ? "[" + role + "]" : "")
        + (selector != null ? "{" + selector + "}" : "") + (testId != null ? "#" + testId : "") + (text != null ? "~" + text : "");
  }
}
`;

const LOCATOR_RESOLVER_JAVA = `package ${PACKAGE};

import org.openqa.selenium.By;
import org.openqa.selenium.JavascriptExecutor;
import org.openqa.selenium.NoSuchElementException;
import org.openqa.selenium.TimeoutException;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.support.ui.WebDriverWait;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/**
 * Resolves a recorded {@link LocatorCandidate} ladder to a live WebElement. Playwright's
 * getByRole maps to a bounded ARIA heuristic (role attribute + accessible name over visible
 * text / aria-label / placeholder / associated label) — NOT an invented CSS selector. A
 * candidate strategy with no deterministic mapping yields no By (it is skipped, never faked).
 *
 * SPA timing: each By is tried immediately (fast path). If the result is empty, a
 * WebDriverWait polls for up to 5 s before moving to the next candidate. This mirrors
 * Playwright's auto-waiting and prevents false "no match" failures on late-rendered DOM.
 */
public final class LocatorResolver {
  private LocatorResolver() {}

  public static WebElement resolve(WebDriver driver, LocatorCandidate[] candidates, String label) {
    List<String> errors = new ArrayList<>();
    for (LocatorCandidate c : candidates) {
      for (By by : bysFor(c)) {
        List<WebElement> found;
        try { found = driver.findElements(by); } catch (RuntimeException e) { errors.add(by + ": " + e.getMessage()); continue; }
        // If nothing found immediately, wait up to 5 s for the DOM to settle (SPA renders).
        if (found.isEmpty()) {
          try {
            new WebDriverWait(driver, Duration.ofMillis(5000))
              .until(d -> !d.findElements(by).isEmpty());
            found = driver.findElements(by);
          } catch (TimeoutException ignored) { /* still empty after wait — continue to next By */ }
          catch (RuntimeException e) { errors.add(by + ": " + e.getMessage()); continue; }
        }
        List<WebElement> displayed = new ArrayList<>();
        for (WebElement el : found) {
          try { if (el.isDisplayed()) displayed.add(el); } catch (RuntimeException ignored) { /* stale */ }
        }
        if (displayed.size() == 1) return displayed.get(0);
        if (displayed.size() > 1) {
          List<WebElement> scoped = filterByContext(driver, displayed, c.contextText);
          if (scoped.size() == 1) return scoped.get(0);
          errors.add(by + ": ambiguous visible match count=" + displayed.size() + ", context match count=" + scoped.size());
          continue;
        }
        if (found.size() == 1) return found.get(0);
        if (found.size() > 1) {
          List<WebElement> scoped = filterByContext(driver, found, c.contextText);
          if (scoped.size() == 1) return scoped.get(0);
          errors.add(by + ": ambiguous hidden/unfiltered match count=" + found.size() + ", context match count=" + scoped.size());
          continue;
        }
        errors.add(by + ": no match");
      }
      errors.add(c.toString());
    }
    throw new NoSuchElementException("Unable to resolve " + label + " from candidates: " + String.join("; ", errors));
  }

  public static void dismissKnownPopups(WebDriver driver, LocatorCandidate[] candidates) {
    for (LocatorCandidate c : candidates) {
      for (By by : bysFor(c)) {
        for (WebElement el : driver.findElements(by)) {
          try { if (el.isDisplayed()) { el.click(); return; } } catch (RuntimeException ignored) { /* not clickable */ }
        }
      }
    }
  }

  static List<WebElement> filterByContext(WebDriver driver, List<WebElement> elements, String[] contextText) {
    List<WebElement> scoped = new ArrayList<>();
    if (contextText == null || contextText.length == 0) return scoped;
    for (WebElement el : elements) {
      if (elementHasContext(driver, el, contextText)) scoped.add(el);
    }
    return scoped;
  }

  static boolean elementHasContext(WebDriver driver, WebElement el, String[] contextText) {
    Object value = ((JavascriptExecutor) driver).executeScript(
      "let node=arguments[0]; const expected=arguments[1].map(x => String(x || '').trim().toLowerCase()).filter(Boolean);"
      + "for (let depth=0; node && depth<5; depth++){"
      + "const text=String(node.textContent || '').replace(/\\\\s+/g, ' ').trim().toLowerCase();"
      + "if (expected.some(x => x && text.includes(x))) return true;"
      + "node=node.parentElement;"
      + "} return false;",
      el,
      contextText
    );
    return Boolean.TRUE.equals(value);
  }

  public static By textContains(String text) {
    String x = xpathLiteral(text);
    return By.xpath("//*[contains(normalize-space(.), " + x + ") and not(.//*[contains(normalize-space(.), " + x + ")])]");
  }

  static List<By> bysFor(LocatorCandidate c) {
    List<By> list = new ArrayList<>();
    if (c == null || c.strategy == null) return list;
    switch (c.strategy) {
      case "css":
        if (c.selector != null && c.selector.startsWith("xpath=")) list.add(By.xpath(c.selector.substring(6)));
        else if (c.selector != null && c.selector.startsWith("//")) list.add(By.xpath(c.selector));
        else if (c.selector != null) list.add(By.cssSelector(c.selector));
        break;
      case "xpath":
        if (c.selector != null) list.add(By.xpath(c.selector));
        break;
      case "testId":
        if (c.testId != null) list.add(By.xpath("//*[@data-testid=" + xpathLiteral(c.testId) + " or @data-test-id=" + xpathLiteral(c.testId) + "]"));
        break;
      case "text":
        if (c.text != null) list.add(textContains(c.text));
        break;
      case "placeholder":
        if (c.text != null) list.add(By.xpath("//*[@placeholder=" + xpathLiteral(c.text) + "]"));
        break;
      case "label":
        if (c.text != null) {
          String x = xpathLiteral(c.text);
          list.add(By.xpath("//label[normalize-space()=" + x + "]/following::input[1]"));
          list.add(By.xpath("//input[@id=(//label[normalize-space()=" + x + "]/@for)]"));
          list.add(By.xpath("//*[@aria-label=" + x + "]"));
        }
        break;
      case "role":
        list.addAll(bysForRole(c.role, c.name));
        break;
      default:
        break;
    }
    return list;
  }

  // Bounded ARIA heuristics for the common roles; a name maps to the accessible name. Unknown
  // roles fall back to the literal [role=...] attribute + accessible name (faithful, generic).
  static List<By> bysForRole(String role, String name) {
    List<By> list = new ArrayList<>();
    String r = role == null ? "" : role.toLowerCase();
    boolean hasName = name != null && !name.isEmpty();
    String x = hasName ? xpathLiteral(name) : null;
    switch (r) {
      case "button":
        if (hasName) {
          list.add(By.xpath("//button[normalize-space()=" + x + " or @aria-label=" + x + " or @title=" + x + "]"));
          list.add(By.xpath("//input[(@type='submit' or @type='button' or @type='reset') and (@value=" + x + " or @aria-label=" + x + ")]"));
          list.add(By.xpath("//*[@role='button' and (normalize-space()=" + x + " or @aria-label=" + x + ")]"));
        } else {
          list.add(By.cssSelector("button, [role=button], input[type=submit], input[type=button]"));
        }
        break;
      case "link":
        if (hasName) {
          list.add(By.xpath("//a[normalize-space()=" + x + " or @aria-label=" + x + "]"));
          list.add(By.xpath("//*[@role='link' and (normalize-space()=" + x + " or @aria-label=" + x + ")]"));
        } else {
          list.add(By.cssSelector("a[href], [role=link]"));
        }
        break;
      case "textbox":
      case "searchbox":
      case "combobox":
        if (hasName) {
          list.add(By.xpath("//input[@aria-label=" + x + " or @placeholder=" + x + " or @name=" + x + " or @title=" + x + "]"));
          list.add(By.xpath("//textarea[@aria-label=" + x + " or @placeholder=" + x + " or @name=" + x + "]"));
          list.add(By.xpath("//label[normalize-space()=" + x + "]/following::input[1]"));
          list.add(By.xpath("//input[@id=(//label[normalize-space()=" + x + "]/@for)]"));
          list.add(By.xpath("//*[@role='" + r + "' and @aria-label=" + x + "]"));
        } else {
          list.add(By.cssSelector("input, textarea, [role=textbox], [role=searchbox], [role=combobox]"));
        }
        break;
      case "checkbox":
      case "radio":
        if (hasName) {
          list.add(By.xpath("//input[@type='" + r + "' and (@aria-label=" + x + " or @name=" + x + ")]"));
          list.add(By.xpath("//label[normalize-space()=" + x + "]/descendant-or-self::input[@type='" + r + "']"));
          list.add(By.xpath("//label[normalize-space()=" + x + "]/preceding::input[@type='" + r + "'][1]"));
        } else {
          list.add(By.cssSelector("input[type=" + r + "]"));
        }
        break;
      case "heading":
        if (hasName) {
          list.add(By.xpath("//*[(self::h1 or self::h2 or self::h3 or self::h4 or self::h5 or self::h6) and normalize-space()=" + x + "]"));
          list.add(By.xpath("//*[@role='heading' and normalize-space()=" + x + "]"));
        } else {
          list.add(By.cssSelector("h1, h2, h3, h4, h5, h6, [role=heading]"));
        }
        break;
      case "tab":
      case "menuitem":
      case "option":
      case "listitem":
      case "cell":
      case "row":
      case "img":
      case "alert":
      case "dialog":
        if (hasName) list.add(By.xpath("//*[@role='" + r + "' and (normalize-space()=" + x + " or @aria-label=" + x + ")]"));
        else list.add(By.cssSelector("[role=" + r + "]"));
        break;
      default:
        if (hasName) list.add(By.xpath("//*[@role=" + xpathLiteral(r) + " and (normalize-space()=" + x + " or @aria-label=" + x + ")]"));
        else if (!r.isEmpty()) list.add(By.xpath("//*[@role=" + xpathLiteral(r) + "]"));
        break;
    }
    return list;
  }

  // XPath string literal that survives embedded quotes (concat() when both ' and " appear).
  static String xpathLiteral(String s) {
    if (s == null) s = "";
    if (!s.contains("'")) return "'" + s + "'";
    if (!s.contains("\\"")) return "\\"" + s + "\\"";
    StringBuilder sb = new StringBuilder("concat(");
    String[] parts = s.split("'", -1);
    for (int i = 0; i < parts.length; i++) {
      if (i > 0) sb.append(", \\"'\\", ");
      sb.append("'").append(parts[i]).append("'");
    }
    sb.append(")");
    return sb.toString();
  }
}
`;

const BASE_TEST_JAVA = `package ${PACKAGE};

import org.openqa.selenium.OutputType;
import org.openqa.selenium.By;
import org.openqa.selenium.TakesScreenshot;
import org.openqa.selenium.TimeoutException;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.chrome.ChromeDriver;
import org.openqa.selenium.chrome.ChromeOptions;
import org.openqa.selenium.support.ui.WebDriverWait;
import org.testng.annotations.AfterMethod;
import org.testng.annotations.AfterSuite;
import org.testng.annotations.BeforeMethod;
import org.testng.annotations.Test;
import java.io.File;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/** Driver lifecycle + shared oracles for the generated ReplayIR Selenium tests. */
public abstract class BaseTest {
  private static final Map<String, WebDriver> PRESERVED_SESSIONS = new ConcurrentHashMap<>();
  protected WebDriver driver;
  private String currentSessionKey;

  /** True only for a case authored to continue from a dependency's browser session. */
  protected boolean continueSession() {
    return false;
  }

  /** True only when a later dependent case must receive this case's browser session. */
  protected boolean preserveSessionForDependents() {
    return false;
  }

  @BeforeMethod(alwaysRun = true)
  public void setUp(Method testMethod) {
    currentSessionKey = testGroup(testMethod);
    if (continueSession()) {
      driver = takeDependencySession(testMethod);
      if (driver == null) {
        throw new IllegalStateException("The authored continuation case could not find its dependency's preserved browser session.");
      }
      if (!isUsable(driver)) {
        closeQuietly(driver);
        driver = null;
        throw new IllegalStateException("The dependency browser session is no longer usable; QAAI will not invent a login or navigation step.");
      }
      return;
    }

    driver = createDriver();
  }

  private WebDriver createDriver() {
    ChromeOptions options = new ChromeOptions();
    String headless = System.getenv("QAAI_HEADLESS");
    if (headless == null || !headless.equalsIgnoreCase("false")) {
      options.addArguments("--headless=new");
    }
    options.addArguments("--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,900");
    WebDriver freshDriver = new ChromeDriver(options);
    freshDriver.manage().timeouts().implicitlyWait(Duration.ofSeconds(5));
    return freshDriver;
  }

  @AfterMethod(alwaysRun = true)
  public void tearDown() {
    if (driver == null) return;
    if (preserveSessionForDependents() && isUsable(driver)) {
      WebDriver replaced = PRESERVED_SESSIONS.put(currentSessionKey, driver);
      if (replaced != null && replaced != driver) closeQuietly(replaced);
      driver = null;
      return;
    }
    closeQuietly(driver);
    driver = null;
  }

  @AfterSuite(alwaysRun = true)
  public void closeUnclaimedDependencySessions() {
    for (WebDriver preserved : PRESERVED_SESSIONS.values()) closeQuietly(preserved);
    PRESERVED_SESSIONS.clear();
  }

  private WebDriver takeDependencySession(Method testMethod) {
    Test contract = testMethod.getAnnotation(Test.class);
    if (contract == null) return null;
    String[] dependencies = contract.dependsOnGroups();
    for (int index = dependencies.length - 1; index >= 0; index--) {
      WebDriver preserved = PRESERVED_SESSIONS.remove(dependencies[index]);
      if (preserved != null) return preserved;
    }
    return null;
  }

  private String testGroup(Method testMethod) {
    Test contract = testMethod.getAnnotation(Test.class);
    if (contract != null && contract.groups().length > 0) return contract.groups()[0];
    return getClass().getName() + "#" + testMethod.getName();
  }

  private boolean isUsable(WebDriver candidate) {
    try {
      return candidate != null && !candidate.getWindowHandles().isEmpty();
    } catch (RuntimeException ignored) {
      return false;
    }
  }

  private static void closeQuietly(WebDriver candidate) {
    if (candidate == null) return;
    try {
      candidate.quit();
    } catch (RuntimeException ignored) {
      // The browser is already closed; teardown must remain idempotent.
    }
  }

  protected boolean seesText(String text) {
    try {
      return new WebDriverWait(driver, Duration.ofSeconds(8))
        .until(d -> !d.findElements(LocatorResolver.textContains(text)).isEmpty());
    } catch (TimeoutException e) {
      return false;
    }
  }

  protected boolean seesTextInScope(String cssSelector, String text) {
    try {
      return new WebDriverWait(driver, Duration.ofSeconds(8)).until(d -> {
        try {
          org.openqa.selenium.WebElement container = d.findElement(By.cssSelector(cssSelector));
          return container.getText().toLowerCase().contains(text.toLowerCase());
        } catch (RuntimeException e) {
          return false;
        }
      });
    } catch (TimeoutException e) {
      return false;
    }
  }

  protected boolean seesUniqueText(String text) {
    try {
      return new WebDriverWait(driver, Duration.ofSeconds(8))
        .until(d -> visibleTextCount(d, text) == 1);
    } catch (TimeoutException e) {
      return false;
    }
  }

  private int visibleTextCount(WebDriver d, String text) {
    int visible = 0;
    for (org.openqa.selenium.WebElement el : d.findElements(LocatorResolver.textContains(text))) {
      try {
        if (el.isDisplayed()) visible++;
      } catch (RuntimeException ignored) { /* stale */ }
    }
    return visible;
  }

  protected boolean urlMatches(String pattern) {
    try {
      return new WebDriverWait(driver, Duration.ofSeconds(8))
        .until(d -> urlMatchesNow(d.getCurrentUrl(), pattern));
    } catch (TimeoutException e) {
      return false;
    }
  }

  private boolean urlMatchesNow(String url, String pattern) {
    if (url == null) return false;
    try {
      if (Pattern.compile(pattern).matcher(url).find()) return true;
    } catch (RuntimeException ignored) { /* not a valid regex — fall back to contains */ }
    return url.contains(pattern);
  }

  protected void captureScreenshot(String name) {
    try {
      File src = ((TakesScreenshot) driver).getScreenshotAs(OutputType.FILE);
      Files.createDirectories(Paths.get("target", "screenshots"));
      Files.copy(src.toPath(), Paths.get("target", "screenshots", name + ".png"));
    } catch (Exception ignored) { /* screenshot is best-effort */ }
  }
}
`;

function readmeMd(envVars) {
  const lines = (envVars || []).map((n) => `   - \`${n}\``).join('\n');
  return `# QAAI ReplayIR export (Selenium 4 + TestNG)

Generated ONLY from each RunResult's pinned replayIrJson — no AI-written Java, no case-text regen.
Locators come from the recorded candidate ladder; getByRole maps to bounded ARIA heuristics.

1. Install JDK 11+ and Maven. Selenium Manager (bundled) provisions the browser driver.
2. Export the required environment variables (also listed in \`.env.example\`):
${lines || '   - (none)'}
3. \`mvn test-compile\` to validate, \`mvn test\` to run.

**Verdict semantics:** EXPORT_MANIFEST.json records each test's \`expectedVerdict\`. Every authored
case remains enabled. Non-flow-critical mismatches and unsupported observations are collected with
TestNG SoftAssert so later independent steps still run; explicitly authored flow prerequisites use
hard assertions. A locator without live evidence is emitted as an editable semantic fallback beside
a \`QAAI_GUESSED_LOCATOR\` comment. Actual clean-env execution parity is verified separately (P8).
`;
}

function assemblePackage({ admitted, envVars }) {
  const files = {};
  files['pom.xml'] = POM_XML;
  files['testng.xml'] = TESTNG_XML;
  files[`src/test/java/${PACKAGE_PATH}/EnvReader.java`] = ENV_READER_JAVA;
  files[`src/test/java/${PACKAGE_PATH}/DataReader.java`] = DATA_READER_JAVA;
  files[`src/test/java/${PACKAGE_PATH}/LocatorCandidate.java`] = LOCATOR_CANDIDATE_JAVA;
  files[`src/test/java/${PACKAGE_PATH}/LocatorResolver.java`] = LOCATOR_RESOLVER_JAVA;
  files[`src/test/java/${PACKAGE_PATH}/BaseTest.java`] = BASE_TEST_JAVA;
  files['.env.example'] = (envVars || []).map((n) => `${n}=`).join('\n') + '\n';
  files['README.md'] = readmeMd(envVars);
  for (const a of admitted || []) files[a.filePath] = a.content;
  return files;
}

module.exports = {
  id: ADAPTER_ID,
  ADAPTER_ID,
  ADAPTER_VERSION,
  VALIDATE_FRAMEWORK,
  PACKAGE,
  emitSetup,
  emitAuth,
  emitLocatorResolver,
  emitStep,
  emitWait,
  emitPopupHandling,
  emitAssertion,
  emitDataProvider,
  emitRetryPolicy,
  emitHumanInput,
  emitTeardown,
  fileLayout,
  compileCmd,
  runCmd,
  validatePackage,
  regressionCorpus: () => regressionCorpus.forAdapter(ADAPTER_ID),
  // helpers reused by replayExport / guards:
  classNameFor,
  candidateFactory,
  isInternalReference,
  semanticReferenceMap,
  semanticReferenceName,
  guessedLocatorCandidate,
  actionLocatorEvidence,
  typedBinding,
  bindingExpression,
  requiredRuntimeKey,
  provenWorkbookColumn,
  emitNavigation,
  observedNavigation,
  safeSemanticPhrase,
  semanticOrdinal,
  isExplicitFlowCritical,
  assertionOwner,
  emitExecutableDiagnostic,
  emitBooleanAssertion,
  seleniumReloadRecovery,
  emitWaitWithReloadRecovery,
  sessionLifecycleOverrides,
  assemblePackage,
  UNSUPPORTED_CHANNELS,
};
