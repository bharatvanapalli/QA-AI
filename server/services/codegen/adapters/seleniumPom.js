'use strict';
/**
 * Deterministic Selenium POM adapter.
 *
 * This is the Java/TestNG equivalent of the Playwright POM export shape:
 *   src/main/java/com/qaai/pom/locators/*Locators.java  - recorded candidate ladders
 *   src/main/java/com/qaai/pom/pages/*Page.java         - page object methods
 *   src/test/java/com/qaai/pom/tests/*Test.java         - TestNG specs calling page methods
 *
 * It deliberately reuses the Selenium reference adapter's proven support layer
 * (BaseTest, EnvReader, DataReader, LocatorCandidate, LocatorResolver) and only
 * changes the generated application-test architecture.
 */
const packageValidate = require('../_packageValidate');
const regressionCorpus = require('./regressionCorpus');
const seleniumReference = require('./seleniumReference');
const { normalizeCandidate, normalizeCandidates, labelForCandidates } = require('./_candidateNormalize');

const ADAPTER_ID = 'selenium-pom';
const ADAPTER_VERSION = 'selenium-pom-1';
const VALIDATE_FRAMEWORK = 'selenium-java';
const SUPPORT_PACKAGE = seleniumReference.PACKAGE || 'com.qaai.replayir';
const TEST_PACKAGE = 'com.qaai.pom.tests';
const PAGE_PACKAGE = 'com.qaai.pom.pages';
const LOCATOR_PACKAGE = 'com.qaai.pom.locators';
const SUPPORT_PACKAGE_PATH = SUPPORT_PACKAGE.replace(/\./g, '/');
const TEST_PACKAGE_PATH = TEST_PACKAGE.replace(/\./g, '/');
const PAGE_PACKAGE_PATH = PAGE_PACKAGE.replace(/\./g, '/');
const LOCATOR_PACKAGE_PATH = LOCATOR_PACKAGE.replace(/\./g, '/');

const ACTION_VERB = {
  fill: 'fill', click: 'click', doubleClick: 'doubleClick', tripleClick: 'tripleClick',
  selectOption: 'select', check: 'check', uncheck: 'uncheck', press: 'press',
  hover: 'hover', drag: 'drag', upload: 'upload',
};
const ROLE_SUFFIXES_STRIP = [
  'Button', 'Link', 'MenuItem', 'Tab', 'Checkbox', 'Radio', 'Select', 'Option',
  'Heading', 'Image', 'Input', 'SearchInput', 'Element',
];
const KEY_MAP = {
  enter: 'Keys.ENTER',
  tab: 'Keys.TAB',
  escape: 'Keys.ESCAPE',
  esc: 'Keys.ESCAPE',
  backspace: 'Keys.BACK_SPACE',
  delete: 'Keys.DELETE',
  arrowdown: 'Keys.ARROW_DOWN',
  arrowup: 'Keys.ARROW_UP',
  arrowleft: 'Keys.ARROW_LEFT',
  arrowright: 'Keys.ARROW_RIGHT',
  space: 'Keys.SPACE',
};

function jstr(value) {
  const s = value == null ? '' : String(value);
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
}

function esc(value) {
  return String(value == null ? '' : value).replace(/\*\//g, '* /').replace(/[\r\n]+/g, ' ').trim();
}

function ident(value, fallback = 'item') {
  const base = String(value || fallback)
    .replace(/[^A-Za-z0-9_$]+/g, ' ').trim().split(/\s+/).filter(Boolean)
    .map((part, i) => {
      const c = part.replace(/[^A-Za-z0-9_$]/g, '');
      if (!c) return '';
      return i === 0 ? c.charAt(0).toLowerCase() + c.slice(1) : c.charAt(0).toUpperCase() + c.slice(1);
    })
    .join('');
  const safe = base || fallback;
  return /^[A-Za-z_$]/.test(safe) ? safe : `v${safe}`;
}

function classIdent(value, fallback = 'Generated') {
  let out = String(value || fallback).replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  if (!out) out = fallback;
  if (!/^[A-Za-z]/.test(out)) out = `C${out}`;
  return out.slice(0, 100);
}

function classNameFor(caseId, rowIndex, rrId, title) {
  const base = seleniumReference.classNameFor(caseId, rowIndex, rrId, title);
  return classIdent(base, 'GeneratedCaseTest');
}

function stripRoleSuffix(name) {
  for (const s of ROLE_SUFFIXES_STRIP) {
    if (name.endsWith(s) && name.length > s.length) return name.slice(0, -s.length);
  }
  return name;
}

function cap(value) {
  const s = String(value || '');
  return s.charAt(0).toUpperCase() + s.slice(1);
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

function methodNameFor(action, semanticName) {
  const verb = ACTION_VERB[action] || action || 'do';
  return verb + cap(stripRoleSuffix(semanticName || 'Element'));
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

function valueExpr(step) {
  const ref = String(step && step.valueRef || '');
  const m = ref.match(/^(env|vault|fixture|masked):(.+)$/i);
  if (!m) return step && step.rawValue != null
    ? jstr(step.rawValue)
    : `EnvReader.required(${jstr(seleniumReference.requiredRuntimeKey(null, step, false))})`;
  const kind = m[1].toLowerCase();
  return `EnvReader.required(${jstr(kind === 'env' ? m[2] : envNameFromRef(kind, m[2]))})`;
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

function keysExpr(key) {
  const k = String(key || '').toLowerCase().replace(/\s+/g, '');
  return KEY_MAP[k] || jstr(String(key || ''));
}

function regexFromGlob(p) {
  return String(p || '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '.*');
}

function firstSignal(value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstSignal(item);
      if (found != null) return found;
    }
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const s = String(value).trim();
    return s ? s : null;
  }
  if (typeof value === 'object') return value;
  return null;
}

function pageSignals(step) {
  const payload = step && step.payload && typeof step.payload === 'object' ? step.payload : {};
  return (step && step.expectedSignals && typeof step.expectedSignals === 'object' && step.expectedSignals)
    || (payload.expectedSignals && typeof payload.expectedSignals === 'object' && payload.expectedSignals)
    || (step && step.signals && typeof step.signals === 'object' && step.signals)
    || (payload.signals && typeof payload.signals === 'object' && payload.signals)
    || null;
}

function emitPageSignalAssertion(step, msg) {
  const payload = step && step.payload && typeof step.payload === 'object' ? step.payload : {};
  const primary = (step && step.primaryIndicator && typeof step.primaryIndicator === 'object' && step.primaryIndicator)
    || (payload.primaryIndicator && typeof payload.primaryIndicator === 'object' && payload.primaryIndicator)
    || null;
  const signals = pageSignals(step) || {};
  const candidates = [];
  if (primary) candidates.push(primary);
  candidates.push(
    { role: firstSignal(signals.heading) ? 'heading' : null, name: firstSignal(signals.heading) },
    { role: firstSignal(signals.title) ? 'heading' : null, name: firstSignal(signals.title) },
    firstSignal(signals.role),
    { url: firstSignal(signals.url) },
    { text: firstSignal(signals.text) },
  );
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === 'string') return seleniumReference.emitBooleanAssertion(step, 'assertTrue', `seesText(${jstr(candidate)})`, msg);
    if (candidate.url) return seleniumReference.emitBooleanAssertion(step, 'assertTrue', `urlMatches(${jstr(String(candidate.url))})`, msg);
    const role = candidate.role || candidate.expectedRole;
    const name = candidate.name || candidate.expectedName || candidate.text || candidate.label;
    if (role && name) {
      return seleniumReference.emitBooleanAssertion(step, 'assertTrue', `LocatorResolver.resolve(driver, new LocatorCandidate[]{ LocatorCandidate.role(${jstr(role)}, ${jstr(name)}) }, ${jstr('PAGE signal ' + name)}).isDisplayed()`, msg);
    }
    const heading = candidate.heading || candidate.title;
    if (heading) return seleniumReference.emitBooleanAssertion(step, 'assertTrue', `seesText(${jstr(heading)})`, msg);
    if (candidate.text) return seleniumReference.emitBooleanAssertion(step, 'assertTrue', `seesText(${jstr(candidate.text)})`, msg);
  }
  return null;
}

function waitMs(c, fallback = 10000) {
  const n = Number(c && c.timeoutMs);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function javaStringArray(items) {
  return `new String[]{ ${items.map(jstr).join(', ')} }`;
}

function semanticNameFor(candidates, fallback) {
  const normalized = normalizeCandidates(candidates);
  for (const n of normalized) {
    if (!n) continue;
    const role = String(n.role || '').toLowerCase();
    const source = seleniumReference.safeSemanticPhrase(n.name || n.text || n.testId || fallback) || 'page element';
    let suffix = 'Element';
    if (n.strategy === 'role') {
      if (!n.name) continue;
      if (role === 'button') suffix = 'Button';
      else if (role === 'link') suffix = 'Link';
      else if (role === 'textbox' || role === 'searchbox') suffix = 'Input';
      else if (role === 'checkbox') suffix = 'Checkbox';
      else if (role === 'radio') suffix = 'Radio';
      else if (role === 'heading') suffix = 'Heading';
    } else if (n.strategy === 'label' || n.strategy === 'placeholder') {
      suffix = 'Input';
    } else if (n.strategy === 'testId') {
      suffix = 'Element';
    }
    return ident(`${source} ${suffix}`, fallback || 'element');
  }
  return ident(fallback || labelForCandidates(candidates) || 'element', 'element');
}

function pomState(opts = {}) {
  if (!opts.seleniumPom) {
    const testClassName = opts.className || 'ReplayTest';
    opts.seleniumPom = {
      testClassName,
      pageClassName: testClassName.replace(/Test$/, '') + 'Page',
      locatorsClassName: testClassName.replace(/Test$/, '') + 'Locators',
      aliases: new Map(),
      locators: new Map(),
      methods: new Map(),
    };
  }
  return opts.seleniumPom;
}

function uniqueName(base, used) {
  let name = ident(base, 'element');
  let n = 2;
  while (used.has(name)) {
    const semantic = seleniumReference.semanticOrdinal(n);
    const root = ident(base, 'element');
    name = `${semantic.charAt(0).toLowerCase()}${semantic.slice(1)}${cap(root)}`;
    n += 1;
  }
  used.add(name);
  return name;
}

function candidateFactory(c) {
  const n = normalizeCandidate(c) || {};
  if (n.strategy === 'role' && !n.name) return null;
  return seleniumReference.candidateFactory(c);
}

function locatorFactories(candidates, opts, label, step, ir) {
  const exprs = [];
  const actionEvidence = seleniumReference.actionLocatorEvidence(step, ir);
  if (actionEvidence?.verified) return {
    factories: [actionEvidence.factory],
    guessed: false,
    label,
    source: actionEvidence.source,
  };
  const fallback = seleniumReference.guessedLocatorCandidate(candidates, step, ir);
  exprs.push(fallback.factory);
  if (actionEvidence?.factory) exprs.push(actionEvidence.factory);
  for (const c of normalizeCandidates(candidates)) {
    const f = candidateFactory(c);
    if (f) exprs.push(f);
    else if (opts && Array.isArray(opts.adapterFindings)) {
      const n = normalizeCandidate(c) || {};
      opts.adapterFindings.push({
        rule: `selenium_pom_strategy_unsupported:${n.strategy || 'unknown'}`,
        severity: 'warning',
        message: `Locator candidate for "${esc(label)}" was not stable enough for Selenium POM and was dropped.`,
        engine: 'selenium-pom-adapter',
      });
    }
  }
  if (opts && Array.isArray(opts.adapterFindings)) {
    opts.adapterFindings.push({
      rule: 'selenium_pom_locator_semantic_fallback',
      severity: 'warning',
      message: `No stable live locator was available for "${esc(fallback.label)}"; emitted an editable semantic role/name locator.`,
      engine: 'selenium-pom-adapter',
    });
  }
  return {
    factories: [...new Set(exprs)],
    guessed: true,
    label: fallback.label,
    source: actionEvidence?.source
      ? `candidate locator evidence was not action-time verified (${actionEvidence.source})`
      : 'candidate locator evidence was not action-time verified because live DOM evidence was unavailable',
  };
}

function emitSetup(ir, opts = {}) {
  const state = pomState(opts);
  return `package ${TEST_PACKAGE};

import ${PAGE_PACKAGE}.${state.pageClassName};
import ${SUPPORT_PACKAGE}.BaseTest;
import ${SUPPORT_PACKAGE}.DataReader;
import ${SUPPORT_PACKAGE}.EnvReader;
import ${SUPPORT_PACKAGE}.LocatorCandidate;
import ${SUPPORT_PACKAGE}.LocatorResolver;
import org.openqa.selenium.JavascriptExecutor;
import org.openqa.selenium.Keys;
import org.openqa.selenium.support.ui.ExpectedConditions;
import org.openqa.selenium.support.ui.WebDriverWait;
import org.testng.Assert;
import org.testng.asserts.SoftAssert;
import org.testng.annotations.DataProvider;
import org.testng.annotations.Test;
import java.time.Duration;
import java.util.Map;

/** QAAI Selenium POM export generated from the authored flow "${esc(ir.title || 'Selenium case')}". */
public class ${state.testClassName} extends BaseTest {
${seleniumReference.sessionLifecycleOverrides(opts)}

  private ${state.pageClassName} page;`;
}

function emitRetryPolicy() {
  return '';
}

function emitDataProvider(rows, replayIR, opts = {}) {
  const note = Array.isArray(rows) && rows.length
    ? `    // data row(s): ${esc(rows.map((r) => r.label || ('Row ' + r.index)).join(' | '))}\n`
    : '';
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
  rememberExportedDataKeys(opts, [], false);
  return `  ${testAnnotation(opts)}
  public void replay() throws Exception {
${note}    SoftAssert qaaiSoft = new SoftAssert();`.replace(/\n+$/, '');
}

function emitAuth(authProfile, ir, opts = {}) {
  const state = pomState(opts);
  const id = typeof authProfile === 'string' ? authProfile : (authProfile && authProfile.id) || 'unknown';
  return `    // Auth profile ${esc(id)}; BaseTest owns driver lifecycle.
    page = new ${state.pageClassName}(driver);`;
}

function emitLocatorResolver(candidates, step, ir, opts = {}) {
  const state = pomState(opts);
  const requestedLabel = labelForCandidates(candidates);
  const resolved = locatorFactories(candidates, opts, requestedLabel, step, ir);
  const label = resolved.label;
  const factories = resolved.factories;
  const used = new Set(state.locators.keys());
  const semanticFallback = seleniumReference.safeSemanticPhrase(step && (step.elementLabel || step.narration || step.as)) || 'page element';
  const locatorName = uniqueName(semanticNameFor(candidates, semanticFallback), used);
  const guessed = resolved.guessed || !!(step && (step.guessedLocator || step.locatorProvenance?.kind === 'qaai_guessed_locator'));
  state.locators.set(locatorName, { label, factories, guessed, source: resolved.source });
  if (step && step.as) {
    state.aliases.set(step.as, locatorName);
  }
  return `    // resolved '${esc(label)}' through ${state.pageClassName}.${locatorName}()`;
}

function ensureTarget(step, opts, ir) {
  const state = pomState(opts);
  const locatorName = step && step.target ? state.aliases.get(step.target) : null;
  if (locatorName) return locatorName;
  const fallback = seleniumReference.guessedLocatorCandidate([], { ...step, as: step && step.target }, ir);
  const used = new Set(state.locators.keys());
  const guessedName = uniqueName(semanticNameFor([
    { strategy: 'role', role: fallback.role, name: fallback.label },
  ], step && step.target || 'pageElement'), used);
  state.locators.set(guessedName, {
    label: fallback.label,
    factories: [fallback.factory],
    guessed: true,
    source: 'The authored wait target had no action-time verified DOM locator; QAAI emitted an editable semantic role/name candidate.',
  });
  if (step && step.target) state.aliases.set(step.target, guessedName);
  if (opts && Array.isArray(opts.adapterFindings)) {
    opts.adapterFindings.push({
      rule: 'selenium_pom_locator_semantic_fallback',
      severity: 'warning',
      message: `Target "${esc(fallback.label)}" had no resolve step; emitted an editable semantic role/name locator.`,
      engine: 'selenium-pom-adapter',
    });
  }
  return guessedName;
}

function recordActionMethod(step, opts, locatorName, destinationLocatorName = null) {
  const state = pomState(opts);
  const action = String(step.action || '');
  if (!ACTION_VERB[action]) return null;
  const methodName = methodNameFor(action, locatorName);
  if (!state.methods.has(methodName)) state.methods.set(methodName, { action, locatorName, destinationLocatorName });
  return methodName;
}

function emitStep(step, ir, opts = {}) {
  const a = step.action;
  if (step && step.authored === false && a !== 'navigate') {
    const identity = step.contractStepId || step.sourceContractStepId || 'unmatched runtime operation';
    return `    // QAAI_RUNTIME_EVIDENCE: Observed ${esc(a || 'runtime operation')} evidence (${esc(identity)}) was not replayed because it had no exact authored contract identity and operation match.`;
  }
  if (a === 'navigate') return seleniumReference.emitNavigation(step);
  if (a === 'navigateBack') return '    driver.navigate().back();';
  if (a === 'navigateForward') return '    driver.navigate().forward();';
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
  if (!step.target) {
    return seleniumReference.emitExecutableDiagnostic(`Selenium POM could not execute targetless authored action "${a || 'unknown'}". The step remains in order and later independent steps will continue.`, step);
  }
  const locatorName = ensureTarget(step, opts, ir);
  const destinationLocatorName = a === 'drag'
    ? ensureTarget({ ...step, target: step.destinationTarget }, opts, ir)
    : null;
  const methodName = recordActionMethod(step, opts, locatorName, destinationLocatorName);
  if (!methodName) {
    return seleniumReference.emitExecutableDiagnostic(`Selenium POM has no dedicated primitive for authored action "${a || 'unknown'}". The step remains in order and later independent steps will continue.`, step);
  }
  const rowKey = !isEnvironmentValueRef(step && step.valueRef)
    ? exportedDataKey(opts, explicitDataRole(step))
    : null;
  const explicitBinding = seleniumReference.typedBinding(step, opts, ir, false);
  const value = explicitBinding
    ? seleniumReference.bindingExpression(step, opts, ir, false).expression
    : rowKey
      ? `DataReader.required(row, ${jstr(rowKey)})`
      : valueExpr(step);
  if (['click', 'doubleClick', 'tripleClick'].includes(a)) {
    const button = ['left', 'middle', 'right'].includes(String(step.button || '').toLowerCase())
      ? String(step.button).toLowerCase()
      : 'left';
    const modifiers = (Array.isArray(step.modifiers) ? step.modifiers : []).map((item) => jstr(String(item)));
    return `    page.${methodName}(${[jstr(button), ...modifiers].join(', ')});`;
  }
  if (a === 'selectOption') {
    const values = Array.isArray(step.optionValues) && step.optionValues.length
      ? step.optionValues.map((item) => jstr(String(item))).join(', ')
      : value;
    return `    page.${methodName}(${values});`;
  }
  if (a === 'upload') {
    const paths = Array.isArray(step.filePaths) && step.filePaths.length
      ? step.filePaths.map((item) => jstr(String(item))).join(', ')
      : value;
    return `    page.${methodName}(${paths});`;
  }
  if (a === 'fill') return `    page.${methodName}(${value});`;
  if (a === 'press') return step.key ? `    page.${methodName}(${keysExpr(step.key)});` : `    page.${methodName}(${value});`;
  return `    page.${methodName}();`;
}

function emitWait(condition, step, ir, opts = {}) {
  const c = condition || {};
  const ms = waitMs(c);
  if (c.kind === 'url' && c.pattern) {
    return seleniumReference.emitWaitWithReloadRecovery(c, (timeoutExpression) => `new WebDriverWait(driver, Duration.ofMillis(${timeoutExpression})).until(ExpectedConditions.urlMatches(${jstr(regexFromGlob(c.pattern))}));`);
  }
  if (c.kind === 'visible' && c.target) {
    const state = pomState(opts);
    const existing = state.aliases.get(c.target);
    const locatorName = existing || ensureTarget({ ...step, target: c.target, action: 'waitFor' }, opts, ir);
    return seleniumReference.emitWaitWithReloadRecovery(c, (timeoutExpression) => `new WebDriverWait(driver, Duration.ofMillis(${timeoutExpression})).until(ExpectedConditions.visibilityOf(page.${locatorName}()));`);
  }
  if (c.kind === 'networkidle') {
    if (seleniumReference.seleniumReloadRecovery(c, ms)) {
      return seleniumReference.emitWaitWithReloadRecovery(c, (timeoutExpression) => `new WebDriverWait(driver, Duration.ofMillis(${timeoutExpression})).until(d -> "complete".equals(String.valueOf(((JavascriptExecutor) d).executeScript("return document.readyState"))));`);
    }
    return `    try { Thread.sleep(${Math.min(ms, 3000)}); } catch (InterruptedException ignored) {}`;
  }
  return seleniumReference.emitExecutableDiagnostic(`Selenium POM could not faithfully execute authored wait condition "${c.kind || 'unknown'}" within ${ms} ms. The step remains in order and later independent steps will continue.`, step);
}

function emitPopupHandling(known, step, ir, opts = {}) {
  const exprs = [];
  for (const c of known || []) {
    const f = candidateFactory(c);
    if (f) exprs.push(f);
  }
  return `    page.dismissKnownPopups(new ${SUPPORT_PACKAGE}.LocatorCandidate[]{ ${exprs.join(', ')} });`;
}

function expectedExpr(step, opts = {}) {
  const typed = seleniumReference.typedBinding(step, opts, opts && opts.replayIR, true);
  if (typed) return seleniumReference.bindingExpression(step, opts, opts && opts.replayIR, true).expression;
  if (step.expectedRef && step.channel !== 'URL' && isEnvironmentValueRef(step.expectedRef)) {
    return `EnvReader.required(${jstr(envKeyFromRef(step.expectedRef, 'QAAI_EXPECTED'))})`;
  }
  const requestedKey = step.dataExpected
    || (step.dataBinding && step.dataBinding.expectedColumn)
    || dataRoleFromRef(step.expectedRef);
  const rowKey = exportedDataKey(opts, requestedKey);
  if (rowKey) return `DataReader.required(row, ${jstr(rowKey)})`;
  return step.expected == null
    ? `EnvReader.required(${jstr(seleniumReference.requiredRuntimeKey(null, step, true))})`
    : jstr(String(step.expected));
}

function emitAssertion(step, ir, opts = {}) {
  opts.replayIR = ir;
  const channel = String(step.channel || '').toUpperCase();
  const hasExpected = step.expected != null && String(step.expected).trim() !== '';
  const hasExpectedRef = !!step.expectedRef || !!step.dataExpected
    || !!(step.dataBinding && step.dataBinding.expectedColumn);
  if (seleniumReference.UNSUPPORTED_CHANNELS.has(channel) || (!hasExpected && !hasExpectedRef)) {
    return seleniumReference.emitAssertion(step, ir, opts);
  }
  if (!step.target) {
    const ch0 = String(step.channel || '').toUpperCase();
    if (ch0 === 'PAGE') {
      const msg0 = jstr(`${step.channel || 'ASSERT'} ${step.contractRef || ''}: ${String(step.expected == null ? '' : step.expected)}`);
      return emitPageSignalAssertion(step, msg0) || seleniumReference.emitAssertion(step, ir, opts);
    }
    return seleniumReference.emitAssertion(step, ir, opts);
  }
  const locatorName = ensureTarget(step, opts, ir);
  const exp = expectedExpr(step, opts);
  const msg = jstr(`${step.channel || 'ASSERT'} ${step.contractRef || ''}: ${String(step.expected == null ? '' : step.expected)}`);
  const ch = String(step.channel || '').toUpperCase();
  if (ch === 'URL') return seleniumReference.emitBooleanAssertion(step, 'assertTrue', `urlMatches(${exp})`, msg);
  if (ch === 'FORBIDDEN_TEXT') return seleniumReference.emitBooleanAssertion(step, 'assertFalse', `page.${locatorName}TextContains(${exp})`, msg);
  if (ch === 'FORBIDDEN_ROLE') return seleniumReference.emitBooleanAssertion(step, 'assertTrue', `page.${locatorName}IsAbsentOrHidden()`, msg);
  if (ch === 'PAGE') {
    return emitPageSignalAssertion(step, msg)
      || seleniumReference.emitBooleanAssertion(step, 'assertTrue', `page.isVisible(page.${locatorName}())`, msg);
  }
  if (ch === 'UI_ROLE') return seleniumReference.emitBooleanAssertion(step, 'assertTrue', `page.isVisible(page.${locatorName}())`, msg);
  return seleniumReference.emitBooleanAssertion(step, 'assertTrue', `page.textOf(page.${locatorName}()).contains(${exp})`, msg);
}

function emitHumanInput(disposition, step, ir, opts) {
  return seleniumReference.emitHumanInput(disposition, step, ir, opts);
}

function emitTeardown(ir) {
  return `    captureScreenshot(${jstr(String(ir.title || ir.caseId || 'selenium-pom'))});
    qaaiSoft.assertAll();
  }
}`;
}

function fileLayout(ir, opts = {}) {
  const className = opts.className || classNameFor(ir.caseId, null, null, ir.title);
  const p = `src/test/java/${TEST_PACKAGE_PATH}/${className}.java`;
  return { primaryFile: p, testFile: p, className, packageName: TEST_PACKAGE };
}

function compileCmd() { return { cmd: 'mvn', args: ['-q', '-DskipTests', 'test-compile'] }; }
function runCmd() { return { cmd: 'mvn', args: ['test'] }; }
async function validatePackage(opts = {}) { return packageValidate.validatePackage({ ...opts, framework: VALIDATE_FRAMEWORK }); }

function emitLocatorClass(state) {
  const lines = [
    `package ${LOCATOR_PACKAGE};`,
    ``,
    `import ${SUPPORT_PACKAGE}.LocatorCandidate;`,
    ``,
    `/** Recorded action-time locator candidates for ${state.pageClassName}. */`,
    `public final class ${state.locatorsClassName} {`,
    `  private ${state.locatorsClassName}() {}`,
    ``,
  ];
  for (const [name, entry] of state.locators.entries()) {
    if (entry.guessed) {
      lines.push(`  // QAAI_GUESSED_LOCATOR: ${esc(entry.source || 'Live DOM evidence was unavailable.')}`);
      lines.push(`  // The complete authored step is preserved. Replace only this locator if it does not match the intended element.`);
    }
    lines.push(`  public static LocatorCandidate[] ${name}() {`);
    lines.push(`    return new LocatorCandidate[]{ ${entry.factories.join(', ')} };`);
    lines.push(`  }`);
    lines.push('');
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

function emitPageAction(methodName, method) {
  const loc = `${method.locatorName}()`;
  if (method.action === 'fill') {
    return `  public void ${methodName}(String value) {\n    WebElement el = ${loc};\n    el.clear();\n    el.sendKeys(value);\n  }`;
  }
  if (method.action === 'click') return `  public void ${methodName}(String button, String... modifiers) {\n    performClick(${loc}, button, 1, modifiers);\n  }`;
  if (method.action === 'doubleClick') return `  public void ${methodName}(String button, String... modifiers) {\n    performClick(${loc}, button, 2, modifiers);\n  }`;
  if (method.action === 'tripleClick') return `  public void ${methodName}(String button, String... modifiers) {\n    performClick(${loc}, button, 3, modifiers);\n  }`;
  if (method.action === 'selectOption') return `  public void ${methodName}(String... values) {\n    Select select = new Select(${loc});\n    if (values.length > 1 && !select.isMultiple()) System.err.println(${jstr('QAAI_WARNING: Multiple recorded option values target a single-select element; the last value will remain selected.')});\n    for (String value : values) select.selectByVisibleText(value);\n  }`;
  if (method.action === 'check') return `  public void ${methodName}() {\n    WebElement el = ${loc};\n    if (!el.isSelected()) el.click();\n  }`;
  if (method.action === 'uncheck') return `  public void ${methodName}() {\n    WebElement el = ${loc};\n    if (el.isSelected()) el.click();\n  }`;
  if (method.action === 'press') return `  public void ${methodName}(CharSequence value) {\n    ${loc}.sendKeys(value);\n  }`;
  if (method.action === 'hover') return `  public void ${methodName}() {\n    new org.openqa.selenium.interactions.Actions(driver).moveToElement(${loc}).perform();\n  }`;
  if (method.action === 'drag') return `  public void ${methodName}() {\n    new org.openqa.selenium.interactions.Actions(driver).dragAndDrop(${loc}, ${method.destinationLocatorName}()).perform();\n  }`;
  if (method.action === 'upload') return `  public void ${methodName}(String... paths) {\n    ${loc}.sendKeys(String.join("\\n", paths));\n  }`;
  return '';
}

function emitPageClass(state) {
  const hasClickMethods = [...state.methods.values()].some((method) => method && ['click', 'doubleClick', 'tripleClick'].includes(method.action));
  const lines = [
    `package ${PAGE_PACKAGE};`,
    ``,
    `import ${LOCATOR_PACKAGE}.${state.locatorsClassName};`,
    `import ${SUPPORT_PACKAGE}.LocatorCandidate;`,
    `import ${SUPPORT_PACKAGE}.LocatorResolver;`,
    `import org.openqa.selenium.WebDriver;`,
    `import org.openqa.selenium.WebElement;`,
    `import org.openqa.selenium.support.ui.Select;`,
    ``,
    `/** Page object generated from ReplayIR locator evidence. */`,
    `public class ${state.pageClassName} {`,
    `  private final WebDriver driver;`,
    ``,
    `  public ${state.pageClassName}(WebDriver driver) {`,
    `    this.driver = driver;`,
    `  }`,
    ``,
  ];
  for (const [name, entry] of state.locators.entries()) {
    lines.push(`  public WebElement ${name}() {`);
    lines.push(`    return LocatorResolver.resolve(driver, ${state.locatorsClassName}.${name}(), ${jstr(entry.label || name)});`);
    lines.push(`  }`);
    lines.push('');
    lines.push(`  public boolean ${name}IsAbsentOrHidden() {`);
    lines.push(`    try { return !${name}().isDisplayed(); } catch (RuntimeException e) { return true; }`);
    lines.push(`  }`);
    lines.push('');
    lines.push(`  public boolean ${name}TextContains(String expected) {`);
    lines.push(`    try { return textOf(${name}()).contains(expected); } catch (RuntimeException e) { return false; }`);
    lines.push(`  }`);
    lines.push('');
  }
  lines.push(`  public String textOf(WebElement el) {`);
  lines.push(`    String text = el.getText();`);
  lines.push(`    if (text == null || text.isEmpty()) {`);
  lines.push(`      String value = el.getAttribute("value");`);
  lines.push(`      return value == null ? "" : value;`);
  lines.push(`    }`);
  lines.push(`    return text;`);
  lines.push(`  }`);
  lines.push('');
  lines.push(`  public boolean isVisible(WebElement el) {`);
  lines.push(`    try { return el.isDisplayed(); } catch (RuntimeException e) { return false; }`);
  lines.push(`  }`);
  lines.push('');
  lines.push(`  public void dismissKnownPopups(LocatorCandidate[] candidates) {`);
  lines.push(`    LocatorResolver.dismissKnownPopups(driver, candidates);`);
  lines.push(`  }`);
  if (state.methods.size) {
    lines.push('');
  for (const [methodName, method] of state.methods.entries()) {
      lines.push(emitPageAction(methodName, method));
    lines.push('');
  }
  if (hasClickMethods) {
    lines.push(`  private void performClick(WebElement element, String button, int clickCount, String... modifiers) {`);
    lines.push(`    java.util.List<CharSequence> keys = new java.util.ArrayList<>();`);
    lines.push(`    boolean alt = false, control = false, meta = false, shift = false;`);
    lines.push(`    for (String modifier : modifiers) {`);
    lines.push(`      String key = modifier == null ? "" : modifier.replaceAll("[^A-Za-z]", "").toLowerCase();`);
    lines.push(`      if (key.equals("alt")) { keys.add(org.openqa.selenium.Keys.ALT); alt = true; }`);
    lines.push(`      else if (key.equals("shift")) { keys.add(org.openqa.selenium.Keys.SHIFT); shift = true; }`);
    lines.push(`      else if (key.equals("meta") || key.equals("command") || key.equals("cmd")) { keys.add(org.openqa.selenium.Keys.COMMAND); meta = true; }`);
    lines.push(`      else if (key.equals("control") || key.equals("ctrl") || key.equals("controlormeta")) { keys.add(org.openqa.selenium.Keys.CONTROL); control = true; }`);
    lines.push(`    }`);
    lines.push(`    if ("middle".equalsIgnoreCase(button)) {`);
    lines.push(`      // QAAI_WARNING: Selenium has no high-level middle-click primitive; dispatch an executable DOM auxclick equivalent.`);
    lines.push(`      ((org.openqa.selenium.JavascriptExecutor) driver).executeScript("arguments[0].dispatchEvent(new MouseEvent('auxclick',{bubbles:true,cancelable:true,button:1,detail:arguments[1],altKey:arguments[2],ctrlKey:arguments[3],metaKey:arguments[4],shiftKey:arguments[5]}));", element, clickCount, alt, control, meta, shift);`);
    lines.push(`      return;`);
    lines.push(`    }`);
    lines.push(`    org.openqa.selenium.interactions.Actions actions = new org.openqa.selenium.interactions.Actions(driver);`);
    lines.push(`    for (CharSequence key : keys) actions.keyDown(key);`);
    lines.push(`    if ("right".equalsIgnoreCase(button)) for (int i = 0; i < clickCount; i++) actions.contextClick(element);`);
    lines.push(`    else if (clickCount == 2) actions.doubleClick(element);`);
    lines.push(`    else for (int i = 0; i < clickCount; i++) actions.click(element);`);
    lines.push(`    for (int i = keys.size() - 1; i >= 0; i--) actions.keyUp(keys.get(i));`);
    lines.push(`    actions.perform();`);
    lines.push(`  }`);
    lines.push('');
  }
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

function supportFiles(replayIR, opts = {}) {
  const state = pomState(opts);
  return {
    [`src/main/java/${LOCATOR_PACKAGE_PATH}/${state.locatorsClassName}.java`]: emitLocatorClass(state),
    [`src/main/java/${PAGE_PACKAGE_PATH}/${state.pageClassName}.java`]: emitPageClass(state),
  };
}

function testngXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE suite SYSTEM "https://testng.org/testng-1.0.dtd">
<suite name="QAAI Selenium POM Export" verbose="1">
  <test name="selenium-pom">
    <packages>
      <package name="${TEST_PACKAGE}"/>
    </packages>
  </test>
</suite>
`;
}

function readmeMd(envVars) {
  const lines = (envVars || []).map((n) => `   - \`${n}\``).join('\n');
  return `# QAAI ReplayIR export (Selenium POM)

Generated only from pinned ReplayIR. No AI-written Java and no case-text regeneration.

**3-layer structure:**
- \`src/main/java/com/qaai/pom/locators/\` - recorded locator candidates
- \`src/main/java/com/qaai/pom/pages/\` - page object methods
- \`src/test/java/com/qaai/pom/tests/\` - TestNG specs calling page methods

1. Install JDK 11+ and Maven.
2. Export required environment variables:
${lines || '   - (none)'}
3. Run \`mvn test-compile\` to validate, then \`mvn test\`.
`;
}

function assemblePackage({ admitted, envVars }) {
  const files = seleniumReference.assemblePackage({ admitted: [], envVars });
  for (const javaFile of ['LocatorCandidate.java', 'LocatorResolver.java']) {
    const testPath = `src/test/java/${SUPPORT_PACKAGE_PATH}/${javaFile}`;
    const mainPath = `src/main/java/${SUPPORT_PACKAGE_PATH}/${javaFile}`;
    if (files[testPath]) {
      files[mainPath] = files[testPath];
      delete files[testPath];
    }
  }
  files['testng.xml'] = testngXml();
  files['README.md'] = readmeMd(envVars);
  for (const a of admitted || []) {
    files[a.filePath] = a.content;
    if (a.extraFiles) Object.assign(files, a.extraFiles);
  }
  return files;
}

module.exports = {
  id: ADAPTER_ID,
  ADAPTER_ID,
  ADAPTER_VERSION,
  VALIDATE_FRAMEWORK,
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
  supportFiles,
  assemblePackage,
  regressionCorpus: () => regressionCorpus.forAdapter('selenium-reference'),
  classNameFor,
  candidateFactory,
};
