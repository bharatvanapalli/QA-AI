'use strict';
/**
 * Deterministic Selenium BDD/Cucumber-JVM adapter.
 *
 * Route B for Selenium BDD: generate Gherkin + Java glue from pinned ReplayIR,
 * not from model-authored prose. This closes the previous gap where
 * `selenium-bdd` existed only as the legacy LLM generator.
 */
const crypto = require('crypto');
const contract = require('./frameworkAdapter');
const seleniumReference = require('./seleniumReference');
const packageValidate = require('../_packageValidate');
const { normalizeCandidate, normalizeCandidates, labelForCandidates } = require('./_candidateNormalize');

const ADAPTER_ID = 'selenium-bdd-reference';
const ADAPTER_VERSION = 'selenium-bdd-reference-1';
const VALIDATE_FRAMEWORK = 'selenium-bdd';
const BASE_PACKAGE = 'com.qaai';
const STEPS_PACKAGE = `${BASE_PACKAGE}.steps`;
const BDD_PACKAGE = `${BASE_PACKAGE}.bdd`;
const SUPPORT_PACKAGE = seleniumReference.PACKAGE || 'com.qaai.replayir';
const SUPPORT_PACKAGE_PATH = SUPPORT_PACKAGE.replace(/\./g, '/');
const SUPPORTED_ASSERT = new Set(['UI_TEXT', 'PAGE', 'UI_ROLE', 'URL', 'FORBIDDEN_TEXT', 'FORBIDDEN_ROLE']);
const SOURCE_DIAGNOSTIC_VERDICTS = new Set(['blocked', 'needs_human', 'skipped']);
const BDD_RECOVERABLE_REPLAYIR_RULES = new Set([
  'replayir_step_unknown_op',
  'replayir_resolve_no_candidates',
  'replayir_assert_no_contract_ref',
  'replayir_assert_bad_channel',
  'replayir_assert_expected_missing',
  'replayir_human_input_bad_disposition',
  'replayir_value_ref_required',
  'replayir_value_ref_unsafe',
]);

function sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

function hashReplayIr(ir) {
  return sha256(stableStringify(ir || null));
}

function slug(value, fallback = 'case') {
  const out = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/g, '');
  return out || fallback;
}

function semanticCaseName(result, ir = null) {
  return String(
    result && (result.caseName || result.scenarioName)
      || ir && ir.title
      || result && result.moduleName
      || 'QAAI generated scenario'
  ).trim() || 'QAAI generated scenario';
}

function claimSemanticKey(baseValue, used, fallback = 'generated-scenario') {
  const base = slug(baseValue, fallback);
  let candidate = base;
  let ordinal = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${ordinal}`;
    ordinal += 1;
  }
  used.add(candidate);
  return candidate;
}

function claimSemanticPath(pathValue, usedPaths) {
  if (!usedPaths.has(pathValue)) return pathValue;
  const match = String(pathValue).match(/^(.*?)(\.[^.\/]+)$/);
  const stem = match ? match[1] : String(pathValue);
  const extension = match ? match[2] : '';
  let ordinal = 2;
  let candidate = `${stem}-${ordinal}${extension}`;
  while (usedPaths.has(candidate)) {
    ordinal += 1;
    candidate = `${stem}-${ordinal}${extension}`;
  }
  return candidate;
}

function regexFromGlob(p) {
  return String(p || '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '.*');
}

function gq(value) {
  return String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function authoredWaitTiming(condition, fallbackTimeoutMs = 10000) {
  const c = condition && typeof condition === 'object' ? condition : {};
  const timeout = Number(c.timeoutMs);
  const timeoutMs = Number.isFinite(timeout) && timeout >= 0 ? Math.floor(timeout) : fallbackTimeoutMs;
  const refresh = Number(c.refreshAfterMs);
  const refreshAfterMs = Number.isFinite(refresh) && refresh >= 0 ? Math.floor(refresh) : 0;
  const rawRecovery = typeof c.recovery === 'string' ? { action: c.recovery } : c.recovery;
  const recoveryAction = rawRecovery && typeof rawRecovery === 'object'
    ? String(rawRecovery.action || rawRecovery.type || rawRecovery.kind || 'none').trim().toLowerCase() || 'none'
    : 'none';
  const attempts = Number(rawRecovery && rawRecovery.maxAttempts);
  const maxAttempts = Number.isFinite(attempts) && attempts >= 0
    ? Math.floor(attempts)
    : (recoveryAction === 'none' ? 0 : 1);
  const retry = Number(rawRecovery && rawRecovery.retryAfterMs);
  const retryAfterMs = Number.isFinite(retry) && retry >= 0
    ? Math.floor(retry)
    : refreshAfterMs;
  const waitUntil = rawRecovery && typeof rawRecovery.waitUntil === 'string'
    ? rawRecovery.waitUntil.trim().toLowerCase() || 'load'
    : 'load';
  return { timeoutMs, refreshAfterMs, recoveryAction, maxAttempts, retryAfterMs, waitUntil };
}

function jstr(value) {
  const s = value == null ? '' : String(value);
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
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

function candidateFactory(c) {
  return seleniumReference.candidateFactory(c);
}

function factoriesFor(candidates, label, step, ir) {
  const out = [];
  const actionEvidence = seleniumReference.actionLocatorEvidence(step, ir);
  if (actionEvidence) out.push(actionEvidence.factory);
  for (const c of actionEvidence?.verified ? [] : normalizeCandidates(candidates)) {
    const f = candidateFactory(c);
    if (f) out.push(f);
  }
  if (!out.length) {
    const fallback = seleniumReference.guessedLocatorCandidate(candidates, step, ir);
    return { factories: [fallback.factory], guessed: true, source: 'live DOM evidence was unavailable' };
  }
  return {
    factories: [...new Set(out)],
    guessed: !actionEvidence?.verified,
    source: actionEvidence?.source || 'candidate locator evidence was not action-time verified',
  };
}

function internalIdentifier(value) {
  const text = String(value || '').trim();
  return !text || /^(?:el|element|node|target|step)[-_]?\d+$/i.test(text) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(text);
}

function humanizeIdentifier(value) {
  return seleniumReference.safeSemanticPhrase(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (letter) => letter.toUpperCase());
}

function guessedCandidateFor(alias, action) {
  const normalizedAction = String(action || '').toLowerCase();
  const namedAlias = internalIdentifier(alias) ? '' : humanizeIdentifier(alias);
  if (['fill', 'type', 'press'].includes(normalizedAction)) {
    return { label: namedAlias || 'Text input', candidate: { strategy: 'role', role: 'textbox', ...(namedAlias ? { name: namedAlias } : {}) } };
  }
  if (normalizedAction === 'selectoption') {
    return { label: namedAlias || 'Selection field', candidate: { strategy: 'role', role: 'combobox', ...(namedAlias ? { name: namedAlias } : {}) } };
  }
  if (['check', 'uncheck'].includes(normalizedAction)) {
    return { label: namedAlias || 'Checkbox', candidate: { strategy: 'role', role: 'checkbox', ...(namedAlias ? { name: namedAlias } : {}) } };
  }
  return { label: namedAlias || 'Clickable control', candidate: { strategy: 'role', role: 'button', ...(namedAlias ? { name: namedAlias } : {}) } };
}

function bindingToken(step, ir, options, expected, rowKeys) {
  const binding = seleniumReference.typedBinding(step, options, ir, expected);
  const raw = expected ? step && step.expected : step && step.rawValue;
  if (binding && binding.kind === 'literal') {
    return { kind: 'value', value: String(Object.prototype.hasOwnProperty.call(binding, 'value') ? binding.value : raw) };
  }
  if (binding && binding.kind === 'secret_env') {
    return { kind: 'env', value: envKeyFromRef(binding.reference, seleniumReference.requiredRuntimeKey(binding, step, expected)) };
  }
  if (seleniumReference.provenWorkbookColumn(binding)) {
    const key = safeFieldName(binding.column);
    if (rowKeys && rowKeys.has(key)) return { kind: 'value', value: `<${key}>` };
    return { kind: 'env', value: seleniumReference.requiredRuntimeKey(binding, step, expected) };
  }
  if (binding && ['runtime_output', 'dependency_output', 'generated_value'].includes(binding.kind)) {
    return { kind: 'env', value: seleniumReference.requiredRuntimeKey(binding, step, expected) };
  }
  return null;
}

function expectedValue(step, ir, options, rowKeys) {
  const typed = bindingToken(step, ir, options, true, rowKeys);
  if (typed) return typed.kind === 'env' ? `{env:${typed.value}}` : typed.value;
  if (step.dataExpected && rowKeys && rowKeys.has(safeFieldName(step.dataExpected))) return `<${safeFieldName(step.dataExpected)}>`;
  if (step.expectedRef && step.channel !== 'URL') return `{env:${envKeyFromRef(step.expectedRef, 'QAAI_EXPECTED')}}`;
  return step.expected == null
    ? `{env:${seleniumReference.requiredRuntimeKey(null, step, true)}}`
    : String(step.expected);
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

function pageSignalFeatureLine(step) {
  const payload = step && step.payload && typeof step.payload === 'object' ? step.payload : {};
  const primary = (step && step.primaryIndicator && typeof step.primaryIndicator === 'object' && step.primaryIndicator)
    || (payload.primaryIndicator && typeof payload.primaryIndicator === 'object' && payload.primaryIndicator)
    || null;
  const signals = pageSignals(step) || {};
  const candidates = [];
  if (primary) candidates.push(primary);
  candidates.push(
    { text: firstSignal(signals.heading) },
    { text: firstSignal(signals.title) },
    firstSignal(signals.role),
    { url: firstSignal(signals.url) },
    { text: firstSignal(signals.text) },
  );
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === 'string') return `    Then I should see "${gq(candidate)}"`;
    if (candidate.url) return `    Then the URL should match "${gq(regexFromGlob(candidate.url))}"`;
    const name = candidate.name || candidate.expectedName || candidate.text || candidate.label || candidate.heading || candidate.title;
    if (name) return `    Then I should see "${gq(name)}"`;
  }
  return null;
}

function valueToken(step, ir, options, rowKeys) {
  const typed = bindingToken(step, ir, options, false, rowKeys);
  if (typed) return typed;
  if (step.dataRole && rowKeys && rowKeys.has(safeFieldName(step.dataRole))) return { kind: 'value', value: `<${safeFieldName(step.dataRole)}>` };
  if (step.rawValue != null) return { kind: 'value', value: String(step.rawValue) };
  return { kind: 'env', value: envKeyFromRef(step.valueRef, seleniumReference.requiredRuntimeKey(null, step, false)) };
}

function dataRows(ir) {
  const rows = Array.isArray(ir && ir.dataRows) ? ir.dataRows : (ir && ir.dataRow ? [ir.dataRow] : []);
  return rows.filter((r) => r && r.fields && Object.keys(r.fields).length);
}

function safeFieldName(key) {
  return String(key || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'field';
}

function usedDataKeys(ir) {
  const out = new Set();
  for (const step of (ir && ir.steps) || []) {
    if (!step) continue;
    if (step.dataRole) out.add(safeFieldName(step.dataRole));
    if (step.dataExpected) out.add(safeFieldName(step.dataExpected));
    for (const binding of [step.valueBinding, step.expectedBinding]) {
      if (seleniumReference.provenWorkbookColumn(binding)) out.add(safeFieldName(binding.column));
    }
  }
  return [...out];
}

function renderExamples(rows, keys = []) {
  if (!rows.length) return '';
  if (!keys.length) return '';
  const lines = ['    Examples:', `      | ${keys.join(' | ')} |`];
  for (const row of rows) {
    const fields = row.fields || {};
    const lower = Object.fromEntries(Object.entries(fields).map(([k, v]) => [safeFieldName(k).toLowerCase(), v]));
    lines.push(`      | ${keys.map((k) => String(lower[k.toLowerCase()]).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')).join(' | ')} |`);
  }
  return '\n' + lines.join('\n');
}

function resolveMap(ir, locatorCatalog, locatorScope) {
  const aliases = new Map();
  aliases.guessed = new Set();
  aliases.provenance = new Map();
  const scopedCatalog = locatorCatalog.get(locatorScope) || new Map();
  locatorCatalog.set(locatorScope, scopedCatalog);
  const actionByTarget = new Map();
  for (const candidateStep of ir.steps || []) {
    if (candidateStep && candidateStep.op === 'act' && candidateStep.target && !actionByTarget.has(candidateStep.target)) {
      actionByTarget.set(candidateStep.target, candidateStep.action);
    }
  }
  for (const step of (ir.steps || [])) {
    if (!step || step.op !== 'resolve') continue;
    let normalized = normalizeCandidates(step.candidates);
    let base = labelForCandidates(step.candidates);
    let guessedByFallback = false;
    const actionEvidence = seleniumReference.actionLocatorEvidence(step, ir);
    if (!normalized.length && !actionEvidence) {
      const fallback = guessedCandidateFor(step.as, actionByTarget.get(step.as));
      normalized = [fallback.candidate];
      base = fallback.label;
      guessedByFallback = true;
    }
    base = base || (internalIdentifier(step.as) ? 'Interactive control' : humanizeIdentifier(step.as));
    let label = base;
    let suffix = 2;
    const mapped = factoriesFor(normalized, base, step, ir);
    const factories = mapped.factories;
    while (scopedCatalog.has(label)) {
      label = `${seleniumReference.semanticOrdinal(suffix)} ${base}`;
      suffix += 1;
    }
    scopedCatalog.set(label, factories);
    if (step.as) aliases.set(step.as, label);
    if (guessedByFallback || mapped.guessed || step.guessedLocator || step.locatorProvenance?.kind === 'qaai_guessed_locator') aliases.guessed.add(label);
    aliases.provenance.set(label, mapped.source || 'live DOM evidence was unavailable');
  }
  return aliases;
}

function featurePath(result, scenarioName = null) {
  return `src/test/resources/features/${slug(result.moduleName || 'module')}/${slug(scenarioName || semanticCaseName(result), 'generated-scenario')}.feature`;
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

function renderFeature(result, locatorCatalog, options = {}) {
  const ir = result.envelope.ir;
  const scenarioName = semanticCaseName(result, ir);
  const locatorScope = options.locatorScope || slug(scenarioName, 'generated-scenario');
  const aliases = resolveMap(ir, locatorCatalog, locatorScope);
  const requestedExampleKeys = usedDataKeys(ir);
  const rows = requestedExampleKeys.length
    ? dataRows(ir).filter((row) => {
      const normalized = Object.fromEntries(Object.entries(row.fields || {}).map(([key, value]) => [safeFieldName(key).toLowerCase(), value]));
      return requestedExampleKeys.every((key) => normalized[key.toLowerCase()] != null && String(normalized[key.toLowerCase()]).length > 0);
    })
    : [];
  const exampleKeys = rows.length ? requestedExampleKeys : [];
  const rowKeys = new Set(exampleKeys);
  const scenarioKeyword = rows.length ? 'Scenario Outline' : 'Scenario';
  const tags = [
    '@qaai',
    `@case-${slug(scenarioName, 'generated-scenario')}`,
    `@expected-${slug(result.status || 'unknown')}`,
  ];
  if (SOURCE_DIAGNOSTIC_VERDICTS.has(result.status)) tags.push('@source-diagnostic');
  if (result.envelope && result.envelope.complete === false) tags.push('@replayir-incomplete-diagnostic');
  const lines = [
    `Feature: ${result.scenarioName || result.moduleName || 'QAAI Selenium BDD Export'}`,
    `  # Source: ReplayIR only. Expected verdict: ${result.status || 'unknown'}.`,
    ...(SOURCE_DIAGNOSTIC_VERDICTS.has(result.status)
      ? [`  # QAAI source diagnostic: Source run status was '${result.status}'${result.blockedReason ? ` (${result.blockedReason})` : ''}; generated BDD remains enabled.`]
      : []),
    ...(result.envelope && result.envelope.complete === false
      ? ['  # QAAI source diagnostic: ReplayIR was marked complete:false; the available authored flow is still emitted as an enabled scenario.']
      : []),
    '',
    `  ${tags.join(' ')}`,
    `  ${scenarioKeyword}: ${scenarioName}`,
    `    Given I use locator scope "${gq(locatorScope)}"`,
  ];
  let lastResolveOnly = false;
  const warnedGuesses = new Set();
  const actionLabel = (target) => aliases.get(target) || target || 'element';
  const warnIfGuessed = (target) => {
    const label = actionLabel(target);
    if (!aliases.guessed.has(label) || warnedGuesses.has(label)) return;
    warnedGuesses.add(label);
    lines.push(`    # QAAI_GUESSED_LOCATOR: ${gq(aliases.provenance.get(label) || 'Live DOM evidence was unavailable')} for "${gq(label)}".`);
    lines.push('    # The complete authored step is preserved. Replace only this locator if it does not match the intended element.');
  };
  for (const step of ir.steps || []) {
    if (!step) continue;
    if (step.op === 'resolve') {
      lastResolveOnly = true;
      continue;
    }
    if (step.op === 'act') {
      if (step.action === 'navigate' && seleniumReference.observedNavigation(step)) {
        lines.push('    # QAAI_OBSERVED_NAVIGATION: The preceding authored action caused this browser transition; no second navigation is invented.');
        lines.push(`    Then the browser should already be at URL containing "${gq(observedUrlSignal(step.url))}"`);
      }
      else if (step.action === 'navigate') lines.push(`    Given I open "${gq(step.url || '')}"`);
      else if (['click', 'doubleClick', 'tripleClick'].includes(step.action)) {
        warnIfGuessed(step.target);
        const label = gq(actionLabel(step.target));
        const button = ['left', 'middle', 'right'].includes(String(step.button || '').toLowerCase()) ? String(step.button).toLowerCase() : 'left';
        const modifiers = Array.isArray(step.modifiers) ? step.modifiers.map(String) : [];
        const hasOptions = step.button != null || modifiers.length > 0;
        const encodedModifiers = Buffer.from(modifiers.join('\0')).toString('base64');
        const verb = step.action === 'doubleClick' ? 'double click' : step.action === 'tripleClick' ? 'triple click' : 'click';
        lines.push(hasOptions
          ? `    When I ${verb} "${label}" with button "${button}" and modifiers "${encodedModifiers}"`
          : `    When I ${verb} "${label}"`);
      }
      else if (step.action === 'fill' || step.action === 'type') {
        warnIfGuessed(step.target);
        const v = valueToken(step, ir, options, rowKeys);
        lines.push(v.kind === 'env'
          ? `    When I fill "${gq(actionLabel(step.target))}" with env "${gq(v.value)}"`
          : `    When I fill "${gq(actionLabel(step.target))}" with value "${gq(v.value)}"`);
      } else if (step.action === 'selectOption') {
        warnIfGuessed(step.target);
        if (Array.isArray(step.optionValues) && step.optionValues.length) {
          const encoded = Buffer.from(step.optionValues.map(String).join('\0')).toString('base64');
          lines.push(`    When I select recorded values "${encoded}" in "${gq(actionLabel(step.target))}"`);
        } else {
          const v = valueToken(step, ir, options, rowKeys);
          lines.push(v.kind === 'env'
            ? `    When I select env "${gq(v.value)}" in "${gq(actionLabel(step.target))}"`
            : `    When I select value "${gq(v.value)}" in "${gq(actionLabel(step.target))}"`);
        }
      } else if (step.action === 'check') { warnIfGuessed(step.target); lines.push(`    When I check "${gq(actionLabel(step.target))}"`); }
      else if (step.action === 'uncheck') { warnIfGuessed(step.target); lines.push(`    When I uncheck "${gq(actionLabel(step.target))}"`); }
      else if (step.action === 'press') { warnIfGuessed(step.target); lines.push(`    When I press "${gq(step.key || step.valueRef || '')}" in "${gq(actionLabel(step.target))}"`); }
      else if (step.action === 'hover') { warnIfGuessed(step.target); lines.push(`    When I hover over "${gq(actionLabel(step.target))}"`); }
      else if (step.action === 'drag') {
        warnIfGuessed(step.target);
        warnIfGuessed(step.destinationTarget);
        lines.push(`    When I drag "${gq(actionLabel(step.target))}" to "${gq(actionLabel(step.destinationTarget))}"`);
      }
      else if (step.action === 'upload') {
        warnIfGuessed(step.target);
        if (Array.isArray(step.filePaths) && step.filePaths.length) {
          const encoded = Buffer.from(step.filePaths.map(String).join('\0')).toString('base64');
          lines.push(`    When I upload recorded files "${encoded}" to "${gq(actionLabel(step.target))}"`);
        } else {
          const v = valueToken(step, ir, options, rowKeys);
          lines.push(v.kind === 'env'
            ? `    When I upload env "${gq(v.value)}" to "${gq(actionLabel(step.target))}"`
            : `    When I upload value "${gq(v.value)}" to "${gq(actionLabel(step.target))}"`);
        }
      }
      else if (step.action === 'navigateBack') lines.push('    When I go back');
      else if (step.action === 'navigateForward') lines.push('    When I go forward');
      else if (step.action === 'handleDialog') {
        if (step.accept === false) lines.push('    When I dismiss the browser dialog');
        else if (step.promptText != null) lines.push(`    When I accept the browser dialog with prompt "${gq(step.promptText)}"`);
        else lines.push('    When I accept the browser dialog');
      }
      else if (step.action === 'resize') {
        const width = Number.isFinite(Number(step.width)) && Number(step.width) > 0 ? Math.floor(Number(step.width)) : 1280;
        const height = Number.isFinite(Number(step.height)) && Number(step.height) > 0 ? Math.floor(Number(step.height)) : 720;
        if (!step.width || !step.height) lines.push('    # QAAI_WARNING: Recorded viewport was incomplete; the executable 1280x720 fallback is used.');
        lines.push(`    When I resize the viewport to ${width} by ${height}`);
      }
      else if (step.action === 'close') lines.push('    When I close the active browser window');
      else {
        const label = step.target ? actionLabel(step.target) : 'current page';
        warnIfGuessed(step.target);
        const encoded = Buffer.from(JSON.stringify({ ...step, targetLabel: label })).toString('base64');
        lines.push(`    # QAAI_FALLBACK: The authored action "${gq(step.action || 'unknown')}" has no dedicated Selenium-BDD binding; QAAI emitted the closest executable semantic browser action.`);
        lines.push(`    When I perform authored action "${gq(step.action || 'unknown')}" on "${gq(label)}" with details "${encoded}"`);
      }
      lastResolveOnly = false;
    } else if (step.op === 'waitFor') {
      const timing = authoredWaitTiming(step.condition);
      const timingText = `using recovery "${gq(timing.recoveryAction)}" after ${timing.refreshAfterMs} milliseconds, retrying every ${timing.retryAfterMs} milliseconds, waiting until "${gq(timing.waitUntil)}", and maximum ${timing.maxAttempts} attempts`;
      if (step.condition && step.condition.kind === 'url' && step.condition.pattern) lines.push(`    When I wait up to ${timing.timeoutMs} milliseconds for URL pattern "${gq(regexFromGlob(step.condition.pattern))}" ${timingText}`);
      else if (step.condition && step.condition.kind === 'visible' && step.condition.target) {
        warnIfGuessed(step.condition.target);
        lines.push(`    When I wait up to ${timing.timeoutMs} milliseconds for "${gq(aliases.get(step.condition.target) || step.condition.target || 'element')}" to be visible ${timingText}`);
      }
      else {
        const condition = step.condition || {};
        if (condition.target) warnIfGuessed(condition.target);
        const targetLabel = aliases.get(condition.target) || condition.target || 'current page';
        const encoded = Buffer.from(JSON.stringify({ ...condition, targetLabel })).toString('base64');
        lines.push(`    # QAAI_FALLBACK: The authored wait condition "${gq(condition.kind || 'unknown')}" has no dedicated Selenium-BDD binding; QAAI emitted an executable condition-aware wait.`);
        lines.push(`    When I wait up to ${timing.timeoutMs} milliseconds for authored condition "${gq(condition.kind || 'unknown')}" on "${gq(targetLabel)}" with details "${encoded}"`);
      }
      lastResolveOnly = false;
    } else if (step.op === 'assert') {
      if (step.target) warnIfGuessed(step.target);
      const pageSignalLine = step.channel === 'PAGE' ? pageSignalFeatureLine(step) : null;
      const missingExpected = step.expected == null && !step.expectedRef && !step.dataExpected;
      if (!SUPPORTED_ASSERT.has(step.channel) || (missingExpected && !pageSignalLine)) {
        const targetLabel = aliases.get(step.target) || step.target || 'current page';
        const fallbackExpected = expectedValue(step, ir, options, rowKeys);
        const encoded = Buffer.from(JSON.stringify({ ...step, targetLabel })).toString('base64');
        lines.push(`    # QAAI_FALLBACK: The authored assertion channel "${gq(step.channel || 'unknown')}" has no dedicated Selenium-BDD binding or concrete expected value; QAAI emitted an executable target/text assertion.`);
        lines.push(`    Then the authored assertion "${gq(step.channel || 'unknown')}" on "${gq(targetLabel)}" should pass with expected "${gq(fallbackExpected)}" and details "${encoded}"`);
        lastResolveOnly = false;
        continue;
      }
      const expected = expectedValue(step, ir, options, rowKeys);
      if (step.channel === 'PAGE') {
        lines.push(pageSignalLine || (step.target
          ? `    Then "${gq(aliases.get(step.target) || step.target || 'element')}" should contain "${gq(expected)}"`
          : `    Then I should see "${gq(expected)}"`));
      } else if (step.channel === 'URL') lines.push(`    Then the URL should match "${gq(regexFromGlob(expected))}"`);
      else if (step.channel === 'FORBIDDEN_TEXT') lines.push(`    Then I should not see "${gq(expected)}"`);
      else if (step.channel === 'FORBIDDEN_ROLE') lines.push(`    Then "${gq(aliases.get(step.target) || step.target || expected || 'element')}" should be hidden`);
      else if (step.target) lines.push(`    Then "${gq(aliases.get(step.target) || step.target || 'element')}" should contain "${gq(expected)}"`);
      else lines.push(`    Then I should see "${gq(expected)}"`);
      lastResolveOnly = false;
    } else if (step.op === 'humanInput') {
      if (step.disposition !== 'test_hook') lines.push(`    # QAAI_FALLBACK: The authored human-input disposition "${gq(step.disposition || 'unknown')}" has no dedicated binding; QAAI emitted the executable environment-backed input hook.`);
      lines.push(`    When I provide manual input "${gq(step.field || 'human input')}" from env "${gq(envKeyFromRef(step.valueRef, `QAAI_${String(step.field || 'INPUT').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`))}"`);
      lastResolveOnly = false;
    } else if (step.op === 'handlePopup') {
      lines.push('    When I dismiss known popups');
      lastResolveOnly = false;
    } else {
      const genericAction = String(step.action || step.verb || step.operation || '').trim();
      const genericTarget = step.target || step.element || step.label || step.name || null;
      const executableGenericAction = /(?:click|tap|hover|scroll|focus|blur|clear|submit|check|uncheck)/i.test(genericAction);
      if (genericAction && genericTarget && executableGenericAction) {
        const targetLabel = aliases.get(genericTarget) || genericTarget;
        warnIfGuessed(genericTarget);
        const encoded = Buffer.from(JSON.stringify({ ...step, targetLabel })).toString('base64');
        lines.push(`    # QAAI_FALLBACK: The authored ReplayIR operation "${gq(step.op || 'unknown')}" is executed through its own semantic action and target metadata.`);
        lines.push(`    When I perform authored action "${gq(genericAction)}" on "${gq(targetLabel)}" with details "${encoded}"`);
      } else {
        lines.push(`    # QAAI_UNSUPPORTED_OPERATION: The authored ReplayIR operation "${gq(step.op || 'unknown')}" lacks enough action/target metadata for an honest generic Selenium operation. This step fails locally instead of reporting false success.`);
        lines.push(`    When I execute authored browser operation "${gq(step.op || 'unknown')}" with details "${Buffer.from(JSON.stringify(step)).toString('base64')}"`);
      }
      lastResolveOnly = false;
    }
  }
  if (lastResolveOnly) lines.push('    Then the recorded locator evidence should be available');
  return lines.join('\n') + renderExamples(rows, exampleKeys) + '\n';
}

function compileResults({ results }) {
  const admitted = [];
  const blocked = [];
  const manifestEntries = [];
  const findings = [];
  const locatorCatalog = new Map();
  const usedScopes = new Set();
  const usedPaths = new Set();
  for (const r of results || []) {
    const base = {
      adapterId: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      runId: r.runId,
      runResultId: r.runResultId,
      testCaseId: r.testCaseId,
      expectedVerdict: r.status,
      complete: !!(r.envelope && r.envelope.complete),
      irHash: r.envelope && r.envelope.ir ? hashReplayIr(r.envelope.ir) : null,
      files: [],
      fileHashes: {},
      validationFindings: [],
      sourceDiagnostics: [],
    };
    if (!r.envelope || !r.envelope.ir) {
      blocked.push({ runResultId: r.runResultId, testCaseId: r.testCaseId, code: 'replayir_missing', detail: 'RunResult has no replayIrJson.' });
      manifestEntries.push({ ...base, status: 'blocked', blockReason: 'replayir_missing' });
      continue;
    }
    if (r.envelope.complete === false) {
      const diagnostic = {
        code: 'replayir_incomplete_diagnostic',
        severity: 'warning',
        detail: 'ReplayIR was marked complete:false; the available authored flow is still emitted as an enabled scenario.',
        gaps: r.envelope.gaps || [],
      };
      base.sourceDiagnostics.push(diagnostic);
      findings.push({ rule: diagnostic.code, severity: diagnostic.severity, message: `RunResult ${r.runResultId}: ${diagnostic.detail}`, gaps: diagnostic.gaps });
    }
    if (SOURCE_DIAGNOSTIC_VERDICTS.has(r.status)) {
      const diagnostic = {
        code: 'source_verdict_diagnostic',
        severity: 'warning',
        status: r.status,
        detail: `Source run status was '${r.status}'${r.blockedReason ? ` (${r.blockedReason})` : ''}; generated BDD remains enabled.`,
      };
      base.sourceDiagnostics.push(diagnostic);
      findings.push({ rule: diagnostic.code, severity: diagnostic.severity, message: `RunResult ${r.runResultId}: ${diagnostic.detail}` });
    }
    const irCheck = contract.validateReplayIR(r.envelope.ir);
    const blockingValidationFindings = irCheck.findings.filter((finding) =>
      finding.severity === 'error' && !BDD_RECOVERABLE_REPLAYIR_RULES.has(finding.rule)
    );
    const recoverableValidationFindings = irCheck.findings.filter((finding) =>
      finding.severity === 'error' && BDD_RECOVERABLE_REPLAYIR_RULES.has(finding.rule)
    );
    if (blockingValidationFindings.length) {
      blocked.push({ runResultId: r.runResultId, testCaseId: r.testCaseId, code: 'replayir_invalid', findings: blockingValidationFindings });
      manifestEntries.push({ ...base, status: 'blocked', blockReason: 'replayir_invalid', validationFindings: blockingValidationFindings });
      findings.push(...blockingValidationFindings);
      continue;
    }
    if (recoverableValidationFindings.length) {
      const diagnostic = {
        code: 'bdd_replayir_step_fallback_diagnostic',
        severity: 'warning',
        detail: `QAAI converted ${recoverableValidationFindings.length} unsupported or incomplete authored step variant(s) into executable BDD fallbacks.`,
        rules: recoverableValidationFindings.map((finding) => finding.rule),
      };
      base.sourceDiagnostics.push(diagnostic);
      findings.push({ ...diagnostic, rule: diagnostic.code, message: diagnostic.detail });
    }
    const scenarioName = semanticCaseName(r, r.envelope.ir);
    const locatorScope = claimSemanticKey(scenarioName, usedScopes, 'generated-scenario');
    let content;
    try {
      content = renderFeature(r, locatorCatalog, { locatorScope });
    } catch (e) {
      const code = e.code === 'selenium_bdd_locator_unmappable' ? 'selenium_bdd_locator_unmappable'
        : (e.code === 'bdd_channel_unsupported' ? 'bdd_channel_unsupported' : 'replayir_invalid');
      blocked.push({ runResultId: r.runResultId, testCaseId: r.testCaseId, code, detail: e.message });
      manifestEntries.push({ ...base, status: 'blocked', blockReason: code, detail: e.message });
      continue;
    }
    const path = claimSemanticPath(featurePath(r, scenarioName), usedPaths);
    usedPaths.add(path);
    const entry = {
      ...base,
      status: r.status,
      executionEnabled: true,
      files: [path],
      fileHashes: { [path]: sha256(content) },
      bdd: { framework: 'selenium-bdd', featureFile: path, enabled: true, locatorScope, scenarioName },
    };
    admitted.push({ ...entry, filePath: path, content });
    manifestEntries.push(entry);
  }
  return { admitted, blocked, manifestEntries, findings, locators: locatorCatalog, adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION };
}

const POM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.qaai</groupId>
  <artifactId>qaai-selenium-bdd-replayir-export</artifactId>
  <version>0.0.0</version>
  <packaging>jar</packaging>
  <properties>
    <maven.compiler.release>11</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <selenium.version>4.18.1</selenium.version>
    <testng.version>7.10.2</testng.version>
    <cucumber.version>7.33.0</cucumber.version>
  </properties>
  <dependencies>
    <dependency><groupId>org.seleniumhq.selenium</groupId><artifactId>selenium-java</artifactId><version>\${selenium.version}</version></dependency>
    <dependency><groupId>org.testng</groupId><artifactId>testng</artifactId><version>\${testng.version}</version></dependency>
    <dependency><groupId>io.cucumber</groupId><artifactId>cucumber-java</artifactId><version>\${cucumber.version}</version></dependency>
    <dependency><groupId>io.cucumber</groupId><artifactId>cucumber-testng</artifactId><version>\${cucumber.version}</version></dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.2.5</version>
        <configuration>
          <suiteXmlFiles><suiteXmlFile>testng.xml</suiteXmlFile></suiteXmlFiles>
        </configuration>
      </plugin>
    </plugins>
  </build>
</project>
`;

const TESTNG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE suite SYSTEM "https://testng.org/testng-1.0.dtd">
<suite name="QAAI Selenium BDD Export" verbose="1">
  <test name="selenium-bdd">
    <classes>
      <class name="${BASE_PACKAGE}.runner.TestRunner"/>
    </classes>
  </test>
</suite>
`;

const TEST_RUNNER = `package ${BASE_PACKAGE}.runner;

import io.cucumber.testng.AbstractTestNGCucumberTests;
import io.cucumber.testng.CucumberOptions;

@CucumberOptions(
    features = "src/test/resources/features",
    glue = { "${STEPS_PACKAGE}" },
    plugin = { "pretty", "html:target/cucumber-report.html", "json:target/cucumber-report.json" }
)
public class TestRunner extends AbstractTestNGCucumberTests {
}
`;

const BDD_WORLD = `package ${BDD_PACKAGE};

import org.openqa.selenium.By;
import org.openqa.selenium.OutputType;
import org.openqa.selenium.TakesScreenshot;
import org.openqa.selenium.TimeoutException;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.chrome.ChromeDriver;
import org.openqa.selenium.chrome.ChromeOptions;
import org.openqa.selenium.support.ui.WebDriverWait;
import ${SUPPORT_PACKAGE}.LocatorCandidate;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;

public final class BddWorld {
  private static final ThreadLocal<WebDriver> DRIVER = new ThreadLocal<>();
  private BddWorld() {}

  public static void startDriver() {
    ChromeOptions options = new ChromeOptions();
    String headless = System.getenv("QAAI_HEADLESS");
    if (headless == null || !headless.equalsIgnoreCase("false")) options.addArguments("--headless=new");
    options.addArguments("--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,900");
    WebDriver driver = new ChromeDriver(options);
    driver.manage().timeouts().implicitlyWait(Duration.ofSeconds(5));
    driver.manage().timeouts().pageLoadTimeout(Duration.ofSeconds(60));
    DRIVER.set(driver);
  }

  public static WebDriver driver() {
    WebDriver driver = DRIVER.get();
    if (driver == null) throw new IllegalStateException("WebDriver has not been started.");
    return driver;
  }

  public static void quitDriver() {
    WebDriver driver = DRIVER.get();
    if (driver != null) driver.quit();
    DRIVER.remove();
  }

  public static boolean seesText(String text) {
    try {
      return new WebDriverWait(driver(), Duration.ofSeconds(8))
        .until(d -> !d.findElements(${SUPPORT_PACKAGE}.LocatorResolver.textContains(text)).isEmpty());
    } catch (TimeoutException e) {
      return false;
    }
  }

  public static boolean urlMatches(String pattern) {
    try {
      return new WebDriverWait(driver(), Duration.ofSeconds(8))
        .until(d -> urlMatchesNow(d.getCurrentUrl(), pattern));
    } catch (TimeoutException e) {
      return false;
    }
  }

  public static boolean urlMatchesNow(String url, String pattern) {
    if (url == null) return false;
    try { if (Pattern.compile(pattern).matcher(url).find()) return true; } catch (RuntimeException ignored) {}
    return url.contains(pattern);
  }

  private static String xpathLiteral(String value) {
    return org.openqa.selenium.support.ui.Quotes.escape(value == null ? "" : value);
  }

  private static List<By> candidateBys(LocatorCandidate candidate) {
    List<By> out = new ArrayList<>();
    if (candidate == null || candidate.strategy == null) return out;
    String strategy = candidate.strategy.toLowerCase(Locale.ROOT);
    if ("css".equals(strategy) && candidate.selector != null) {
      out.add(By.cssSelector(candidate.selector));
    } else if ("testid".equals(strategy) && candidate.testId != null) {
      out.add(By.xpath("//*[@data-testid=" + xpathLiteral(candidate.testId) + "]"));
    } else if ("text".equals(strategy) && candidate.text != null) {
      out.add(By.xpath("//*[contains(normalize-space(.), " + xpathLiteral(candidate.text) + ")]"));
    } else if ("placeholder".equals(strategy) && candidate.text != null) {
      out.add(By.xpath("//*[@placeholder=" + xpathLiteral(candidate.text) + "]"));
    } else if ("label".equals(strategy) && candidate.text != null) {
      String value = xpathLiteral(candidate.text);
      out.add(By.xpath("//*[@aria-label=" + value + " or @placeholder=" + value + "] | //label[normalize-space(.)=" + value + "]//*[self::input or self::textarea or self::select] | //label[normalize-space(.)=" + value + "]/following::*[self::input or self::textarea or self::select][1]"));
    } else if ("role".equals(strategy) && candidate.role != null) {
      String role = candidate.role.toLowerCase(Locale.ROOT);
      String rolePredicate;
      if ("button".equals(role)) rolePredicate = "self::button or @role='button' or (self::input and (@type='button' or @type='submit' or @type='reset'))";
      else if ("link".equals(role)) rolePredicate = "self::a or @role='link'";
      else if ("textbox".equals(role) || "searchbox".equals(role)) rolePredicate = "self::textarea or (self::input and (not(@type) or @type='text' or @type='email' or @type='search' or @type='password')) or @role='textbox' or @role='searchbox'";
      else rolePredicate = "@role=" + xpathLiteral(role);
      String namePredicate = candidate.name == null ? "" : " and (@aria-label=" + xpathLiteral(candidate.name) + " or @placeholder=" + xpathLiteral(candidate.name) + " or normalize-space(.)=" + xpathLiteral(candidate.name) + ")";
      out.add(By.xpath("//*[(" + rolePredicate + ")" + namePredicate + "]"));
    }
    return out;
  }

  public static boolean visibleNow(String label) {
    for (LocatorCandidate candidate : LocatorCatalog.candidatesFor(label)) {
      for (By by : candidateBys(candidate)) {
        try {
          for (WebElement element : driver().findElements(by)) {
            try { if (element.isDisplayed()) return true; } catch (RuntimeException ignored) {}
          }
        } catch (RuntimeException ignored) {}
      }
    }
    return false;
  }

  private static long safeDeadline(long startedAt, long timeoutMs) {
    long bounded = Math.max(0L, timeoutMs);
    return bounded > Long.MAX_VALUE - startedAt ? Long.MAX_VALUE : startedAt + bounded;
  }

  private static boolean pollUntil(BooleanSupplier condition, long deadline) {
    while (true) {
      try { if (condition.getAsBoolean()) return true; } catch (RuntimeException ignored) {}
      long remaining = deadline - System.currentTimeMillis();
      if (remaining <= 0) return false;
      try {
        Thread.sleep(Math.min(100L, remaining));
      } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
        throw new IllegalStateException("Interrupted while waiting for the authored browser state.", interrupted);
      }
    }
  }

  private static boolean pageReadyFor(String authoredWaitUntil) {
    String waitUntil = authoredWaitUntil == null ? "load" : authoredWaitUntil.trim().toLowerCase(Locale.ROOT);
    if ("commit".equals(waitUntil)) return true;
    try {
      Object value = ((org.openqa.selenium.JavascriptExecutor) driver()).executeScript("return document.readyState");
      String readyState = value == null ? "" : value.toString().toLowerCase(Locale.ROOT);
      if ("domcontentloaded".equals(waitUntil)) return "interactive".equals(readyState) || "complete".equals(readyState);
      // Selenium has no native network-idle navigation state. Waiting for the
      // completed document is the deterministic executable lower bound; the
      // authored application condition is still polled inside the same deadline.
      return "complete".equals(readyState);
    } catch (RuntimeException ignored) {
      return false;
    }
  }

  public static void waitWithAuthoredRecovery(
      long authoredTimeoutMs,
      long authoredRefreshAfterMs,
      long authoredRetryAfterMs,
      String authoredWaitUntil,
      String authoredRecoveryAction,
      long authoredMaxAttempts,
      BooleanSupplier condition,
      String description) {
    long timeoutMs = Math.max(0L, authoredTimeoutMs);
    long refreshAfterMs = Math.max(0L, authoredRefreshAfterMs);
    long retryAfterMs = Math.max(0L, authoredRetryAfterMs);
    String action = authoredRecoveryAction == null ? "" : authoredRecoveryAction.trim().toLowerCase(Locale.ROOT);
    long startedAt = System.currentTimeMillis();
    long deadline = safeDeadline(startedAt, timeoutMs);
    boolean reloadEnabled = ("reload".equals(action) || "refresh".equals(action) || "reload_page".equals(action) || "refresh_page".equals(action))
        && authoredMaxAttempts > 0
        && refreshAfterMs < timeoutMs;
    WebDriver activeDriver = driver();
    Duration previousImplicitWait = activeDriver.manage().timeouts().getImplicitWaitTimeout();
    Duration previousPageLoadTimeout = activeDriver.manage().timeouts().getPageLoadTimeout();
    activeDriver.manage().timeouts().implicitlyWait(Duration.ZERO);
    try {
      long recoveryAttempts = 0;
      long nextRecoveryAt = reloadEnabled ? Math.min(deadline, safeDeadline(startedAt, refreshAfterMs)) : deadline;
      while (true) {
        boolean canRecover = reloadEnabled && recoveryAttempts < authoredMaxAttempts;
        long phaseDeadline = canRecover ? nextRecoveryAt : deadline;
        if (pollUntil(condition, phaseDeadline)) return;
        long reloadBudget = deadline - System.currentTimeMillis();
        if (!canRecover || reloadBudget <= 0) {
          throw new AssertionError("Timed out after " + timeoutMs + " ms waiting for " + description + " after " + recoveryAttempts + " authored reload attempt(s).");
        }
        activeDriver.manage().timeouts().pageLoadTimeout(Duration.ofMillis(Math.max(1L, reloadBudget)));
        try {
          activeDriver.navigate().refresh();
        } catch (TimeoutException ignored) {
          // The next condition check decides the result using any budget that remains.
        } finally {
          activeDriver.manage().timeouts().pageLoadTimeout(previousPageLoadTimeout);
        }
        if (!pollUntil(() -> pageReadyFor(authoredWaitUntil), deadline)) {
          throw new AssertionError("Authored reload readiness '" + authoredWaitUntil + "' was not reached inside the original wait deadline.");
        }
        recoveryAttempts += 1;
        nextRecoveryAt = Math.min(deadline, safeDeadline(System.currentTimeMillis(), retryAfterMs));
      }
    } finally {
      activeDriver.manage().timeouts().implicitlyWait(previousImplicitWait);
    }
  }

  public static void screenshot(String name) {
    try {
      File src = ((TakesScreenshot) driver()).getScreenshotAs(OutputType.FILE);
      Files.createDirectories(Paths.get("target", "screenshots"));
      Files.copy(src.toPath(), Paths.get("target", "screenshots", name + ".png"));
    } catch (Exception ignored) {}
  }
}
`;

function locatorCatalogJava(locators) {
  const lines = [
    `package ${BDD_PACKAGE};`,
    ``,
    `import ${SUPPORT_PACKAGE}.LocatorCandidate;`,
    `import java.util.HashMap;`,
    `import java.util.Map;`,
    ``,
    `public final class LocatorCatalog {`,
    `  private static final Map<String, LocatorCandidate[]> LOCATORS = new HashMap<>();`,
    `  static {`,
  ];
  for (const [scope, scopedLocators] of locators || new Map()) {
    for (const [label, factories] of scopedLocators || new Map()) {
      lines.push(`    LOCATORS.put(${jstr(`${scope}::${label}`)}, new LocatorCandidate[]{ ${factories.join(', ')} });`);
    }
  }
  lines.push(
    `  }`,
    `  private LocatorCatalog() {}`,
    `  public static LocatorCandidate[] candidatesFor(String scope, String label) {`,
    `    LocatorCandidate[] candidates = LOCATORS.get(scope + "::" + label);`,
    `    if (candidates == null) throw new IllegalArgumentException("No QAAI locator candidates recorded for " + label + " in scenario scope " + scope);`,
    `    return candidates;`,
    `  }`,
    `}`,
    ``,
  );
  return lines.join('\n');
}

const HOOKS = `package ${STEPS_PACKAGE};

import ${BDD_PACKAGE}.BddWorld;
import io.cucumber.java.After;
import io.cucumber.java.Before;
import io.cucumber.java.Scenario;

public class Hooks {
  @Before
  public void before() {
    BddWorld.startDriver();
  }

  @After
  public void after(Scenario scenario) {
    if (scenario.isFailed()) BddWorld.screenshot(scenario.getName().replaceAll("[^A-Za-z0-9_-]+", "-"));
    BddWorld.quitDriver();
  }
}
`;

const STEPS = `package ${STEPS_PACKAGE};

import ${BDD_PACKAGE}.BddWorld;
import ${BDD_PACKAGE}.LocatorCatalog;
import ${SUPPORT_PACKAGE}.EnvReader;
import ${SUPPORT_PACKAGE}.LocatorResolver;
import io.cucumber.java.en.Given;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;
import org.openqa.selenium.Keys;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.support.ui.Select;
import org.testng.Assert;

public class ReplayIrSteps {
  private String locatorScope;

  private WebElement element(String label) {
    if (locatorScope == null || locatorScope.isEmpty()) throw new IllegalStateException("No locator scope selected for the current scenario.");
    return LocatorResolver.resolve(BddWorld.driver(), LocatorCatalog.candidatesFor(locatorScope, label), label);
  }

  private String textOf(WebElement el) {
    String text = el.getText();
    if (text == null || text.isEmpty()) {
      String value = el.getAttribute("value");
      return value == null ? "" : value;
    }
    return text;
  }

  private String resolvedExpected(String value) {
    if (value != null && value.startsWith("{env:") && value.endsWith("}")) {
      return EnvReader.read(value.substring(5, value.length() - 1));
    }
    return value;
  }

  private boolean absentOrHidden(String label) {
    try {
      return !element(label).isDisplayed();
    } catch (RuntimeException e) {
      return true;
    }
  }

  @Given("I use locator scope {string}")
  public void useLocatorScope(String scope) {
    this.locatorScope = scope;
  }

  @Given("I open {string}")
  public void open(String url) {
    BddWorld.driver().get(url);
  }

  @Then("the browser should already be at URL containing {string}")
  public void browserShouldAlreadyBeAtUrl(String expectedPath) {
    String currentUrl = BddWorld.driver().getCurrentUrl();
    Assert.assertTrue(currentUrl != null && currentUrl.contains(expectedPath),
        "Expected the observed browser URL to contain " + expectedPath + " but was " + currentUrl);
  }

  @When("I fill {string} with env {string}")
  public void fillWithEnv(String label, String envName) {
    WebElement el = element(label);
    el.clear();
    el.sendKeys(EnvReader.read(envName));
  }

  @When("I fill {string} with value {string}")
  public void fillWithValue(String label, String value) {
    WebElement el = element(label);
    el.clear();
    el.sendKeys(value);
  }

  @When("I click {string}")
  public void click(String label) {
    element(label).click();
  }

  @When("I double click {string}")
  public void doubleClick(String label) {
    new org.openqa.selenium.interactions.Actions(BddWorld.driver()).doubleClick(element(label)).perform();
  }

  @When("I triple click {string}")
  public void tripleClick(String label) {
    WebElement el = element(label);
    // QAAI_WARNING: Selenium has no direct triple-click primitive; execute three clicks in one Actions chain.
    new org.openqa.selenium.interactions.Actions(BddWorld.driver()).click(el).click(el).click(el).perform();
  }

  @When("I click {string} with button {string} and modifiers {string}")
  public void clickWithOptions(String label, String button, String encodedModifiers) {
    performClick(label, button, 1, encodedModifiers);
  }

  @When("I double click {string} with button {string} and modifiers {string}")
  public void doubleClickWithOptions(String label, String button, String encodedModifiers) {
    performClick(label, button, 2, encodedModifiers);
  }

  @When("I triple click {string} with button {string} and modifiers {string}")
  public void tripleClickWithOptions(String label, String button, String encodedModifiers) {
    performClick(label, button, 3, encodedModifiers);
  }

  private void performClick(String label, String button, int clickCount, String encodedModifiers) {
    String decoded = new String(java.util.Base64.getDecoder().decode(encodedModifiers), java.nio.charset.StandardCharsets.UTF_8);
    String[] modifiers = decoded.isEmpty() ? new String[0] : decoded.split("\\u0000", -1);
    java.util.List<CharSequence> keys = new java.util.ArrayList<>();
    boolean alt = false, control = false, meta = false, shift = false;
    for (String modifier : modifiers) {
      String key = modifier == null ? "" : modifier.replaceAll("[^A-Za-z]", "").toLowerCase();
      if (key.equals("alt")) { keys.add(Keys.ALT); alt = true; }
      else if (key.equals("shift")) { keys.add(Keys.SHIFT); shift = true; }
      else if (key.equals("meta") || key.equals("command") || key.equals("cmd")) { keys.add(Keys.COMMAND); meta = true; }
      else if (key.equals("control") || key.equals("ctrl") || key.equals("controlormeta")) { keys.add(Keys.CONTROL); control = true; }
    }
    WebElement el = element(label);
    if ("middle".equalsIgnoreCase(button)) {
      // QAAI_WARNING: Selenium has no high-level middle-click primitive; dispatch an executable DOM auxclick equivalent.
      ((org.openqa.selenium.JavascriptExecutor) BddWorld.driver()).executeScript("arguments[0].dispatchEvent(new MouseEvent('auxclick',{bubbles:true,cancelable:true,button:1,detail:arguments[1],altKey:arguments[2],ctrlKey:arguments[3],metaKey:arguments[4],shiftKey:arguments[5]}));", el, clickCount, alt, control, meta, shift);
      return;
    }
    org.openqa.selenium.interactions.Actions actions = new org.openqa.selenium.interactions.Actions(BddWorld.driver());
    for (CharSequence key : keys) actions.keyDown(key);
    if ("right".equalsIgnoreCase(button)) for (int i = 0; i < clickCount; i++) actions.contextClick(el);
    else if (clickCount == 2) actions.doubleClick(el);
    else for (int i = 0; i < clickCount; i++) actions.click(el);
    for (int i = keys.size() - 1; i >= 0; i--) actions.keyUp(keys.get(i));
    actions.perform();
  }

  @When("I select env {string} in {string}")
  public void selectEnv(String envName, String label) {
    new Select(element(label)).selectByVisibleText(EnvReader.read(envName));
  }

  @When("I select value {string} in {string}")
  public void selectValue(String value, String label) {
    new Select(element(label)).selectByVisibleText(value);
  }

  @When("I select recorded values {string} in {string}")
  public void selectRecordedValues(String encoded, String label) {
    String decoded = new String(java.util.Base64.getDecoder().decode(encoded), java.nio.charset.StandardCharsets.UTF_8);
    String[] values = decoded.split("\\u0000", -1);
    Select select = new Select(element(label));
    if (values.length > 1 && !select.isMultiple()) System.err.println("QAAI_WARNING: Multiple recorded option values target a single-select element; the last value will remain selected.");
    for (String value : values) select.selectByVisibleText(value);
  }

  @When("I check {string}")
  public void check(String label) {
    WebElement el = element(label);
    if (!el.isSelected()) el.click();
  }

  @When("I uncheck {string}")
  public void uncheck(String label) {
    WebElement el = element(label);
    if (el.isSelected()) el.click();
  }

  @When("I press {string} in {string}")
  public void press(String key, String label) {
    String k = key == null ? "" : key.toLowerCase().replaceAll("\\\\s+", "");
    CharSequence value = "enter".equals(k) ? Keys.ENTER : ("tab".equals(k) ? Keys.TAB : key);
    element(label).sendKeys(value);
  }

  @When("I hover over {string}")
  public void hover(String label) {
    new org.openqa.selenium.interactions.Actions(BddWorld.driver()).moveToElement(element(label)).perform();
  }

  @When("I drag {string} to {string}")
  public void drag(String sourceLabel, String destinationLabel) {
    new org.openqa.selenium.interactions.Actions(BddWorld.driver())
      .dragAndDrop(element(sourceLabel), element(destinationLabel)).perform();
  }

  @When("I upload env {string} to {string}")
  public void uploadEnv(String envName, String label) {
    element(label).sendKeys(EnvReader.read(envName));
  }

  @When("I upload value {string} to {string}")
  public void uploadValue(String value, String label) {
    element(label).sendKeys(value);
  }

  @When("I upload recorded files {string} to {string}")
  public void uploadRecordedFiles(String encoded, String label) {
    String decoded = new String(java.util.Base64.getDecoder().decode(encoded), java.nio.charset.StandardCharsets.UTF_8);
    String[] paths = decoded.split("\\u0000", -1);
    element(label).sendKeys(String.join("\\n", paths));
  }

  @When("I go back")
  public void goBack() {
    BddWorld.driver().navigate().back();
  }

  @When("I go forward")
  public void goForward() {
    BddWorld.driver().navigate().forward();
  }

  @When("I accept the browser dialog")
  public void acceptDialog() {
    BddWorld.driver().switchTo().alert().accept();
  }

  @When("I accept the browser dialog with prompt {string}")
  public void acceptPromptDialog(String promptText) {
    org.openqa.selenium.Alert dialog = BddWorld.driver().switchTo().alert();
    dialog.sendKeys(promptText);
    dialog.accept();
  }

  @When("I dismiss the browser dialog")
  public void dismissDialog() {
    BddWorld.driver().switchTo().alert().dismiss();
  }

  @When("I resize the viewport to {int} by {int}")
  public void resizeViewport(int width, int height) {
    BddWorld.driver().manage().window().setSize(new org.openqa.selenium.Dimension(width, height));
  }

  @When("I close the active browser window")
  public void closeWindow() {
    BddWorld.driver().close();
  }

  @When("I dismiss known popups")
  public void dismissKnownPopups() {
    // Executable, website-neutral fallback for common modal/cookie/consent controls.
    String xpath = "//*[@role='dialog']//*[self::button or @role='button'] | //button | //*[@role='button']";
    for (WebElement candidate : BddWorld.driver().findElements(org.openqa.selenium.By.xpath(xpath))) {
      try {
        if (!candidate.isDisplayed() || !candidate.isEnabled()) continue;
        String text = String.join(" ", candidate.getText(), candidate.getAttribute("aria-label"), candidate.getAttribute("title")).toLowerCase();
        if (text.matches(".*\\b(close|dismiss|accept|allow|agree|got it|not now|cancel|continue)\\b.*")) {
          candidate.click();
          return;
        }
      } catch (RuntimeException ignored) {}
    }
    // Closest executable equivalent when no known control is visible.
    new org.openqa.selenium.interactions.Actions(BddWorld.driver()).sendKeys(Keys.ESCAPE).perform();
  }

  @When("I perform authored action {string} on {string} with details {string}")
  public void performAuthoredActionFallback(String action, String label, String encodedDetails) {
    String normalized = action == null ? "" : action.replaceAll("[^A-Za-z]", "").toLowerCase();
    if ("current page".equals(label)) {
      throw new UnsupportedOperationException("QAAI_UNSUPPORTED_AUTHORED_ACTION: " + action + " requires a semantic target; details=" + encodedDetails);
    }
    WebElement el = element(label);
    if (normalized.contains("doubleclick")) {
      new org.openqa.selenium.interactions.Actions(BddWorld.driver()).doubleClick(el).perform();
    } else if (normalized.contains("click") || normalized.contains("tap")) {
      el.click();
    } else if (normalized.contains("hover")) {
      new org.openqa.selenium.interactions.Actions(BddWorld.driver()).moveToElement(el).perform();
    } else if (normalized.contains("uncheck")) {
      if (el.isSelected()) el.click();
    } else if (normalized.contains("check")) {
      if (!el.isSelected()) el.click();
    } else if (normalized.contains("scroll")) {
      ((org.openqa.selenium.JavascriptExecutor) BddWorld.driver()).executeScript("arguments[0].scrollIntoView({block:'center'});", el);
    } else if (normalized.contains("focus")) {
      ((org.openqa.selenium.JavascriptExecutor) BddWorld.driver()).executeScript("arguments[0].focus();", el);
    } else if (normalized.contains("blur")) {
      ((org.openqa.selenium.JavascriptExecutor) BddWorld.driver()).executeScript("arguments[0].blur();", el);
    } else if (normalized.contains("clear")) {
      el.clear();
    } else if (normalized.contains("submit")) {
      ((org.openqa.selenium.JavascriptExecutor) BddWorld.driver()).executeScript("const form=arguments[0].form||arguments[0].closest('form'); if(form&&form.requestSubmit){form.requestSubmit();}else{arguments[0].dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}", el);
    } else {
      throw new UnsupportedOperationException("QAAI_UNSUPPORTED_AUTHORED_ACTION: " + action + " on " + label + "; details=" + encodedDetails);
    }
  }

  @When("I wait up to {long} milliseconds for authored condition {string} on {string} with details {string}")
  public void waitForAuthoredConditionFallback(long timeoutMs, String condition, String label, String encodedDetails) {
    if ("current page".equals(label)) {
      BddWorld.waitWithAuthoredRecovery(timeoutMs, 0L, 0L, "domcontentloaded", "none", 0L,
          () -> BddWorld.driver().getTitle() != null, "current page readiness");
      return;
    }
    String normalized = condition == null ? "" : condition.toLowerCase();
    BddWorld.waitWithAuthoredRecovery(timeoutMs, 0L, 0L, "domcontentloaded", "none", 0L,
        () -> normalized.contains("hidden") ? absentOrHidden(label) : element(label).isDisplayed(),
        "authored condition " + condition + " on " + label);
  }

  @Then("the authored assertion {string} on {string} should pass with expected {string} and details {string}")
  public void authoredAssertionFallback(String channel, String label, String expected, String encodedDetails) {
    String resolved = resolvedExpected(expected);
    String normalizedChannel = channel == null ? "" : channel.toUpperCase();
    if (normalizedChannel.contains("FORBIDDEN")) {
      if (!"current page".equals(label)) Assert.assertTrue(absentOrHidden(label), "Expected fallback assertion target to be hidden or absent: " + label);
      else if (resolved != null && !resolved.isEmpty()) Assert.assertFalse(BddWorld.seesText(resolved), "Forbidden fallback page text: " + resolved);
      return;
    }
    if (!"current page".equals(label)) {
      if (resolved != null && !resolved.isEmpty()) {
        Assert.assertTrue(textOf(element(label)).contains(resolved), "Expected fallback assertion text in " + label + ": " + resolved);
      } else {
        Assert.assertTrue(element(label).isDisplayed(), "Expected fallback assertion target to be visible: " + label);
      }
    } else if (resolved != null && !resolved.isEmpty()) {
      Assert.assertTrue(BddWorld.seesText(resolved), "Expected fallback page text: " + resolved);
    } else {
      Assert.assertNotNull(BddWorld.driver().getTitle(), "Expected the current page to remain available for " + channel);
    }
  }

  @When("I execute authored browser operation {string} with details {string}")
  public void executeAuthoredBrowserOperationFallback(String operation, String encodedDetails) {
    throw new UnsupportedOperationException("QAAI_UNSUPPORTED_AUTHORED_OPERATION: " + operation + "; details=" + encodedDetails);
  }

  @When("I wait up to {long} milliseconds for URL pattern {string} using recovery {string} after {long} milliseconds, retrying every {long} milliseconds, waiting until {string}, and maximum {long} attempts")
  public void waitForUrl(long timeoutMs, String pattern, String recoveryAction, long refreshAfterMs, long retryAfterMs, String waitUntil, long maxAttempts) {
    BddWorld.waitWithAuthoredRecovery(
        timeoutMs,
        refreshAfterMs,
        retryAfterMs,
        waitUntil,
        recoveryAction,
        maxAttempts,
        () -> BddWorld.urlMatchesNow(BddWorld.driver().getCurrentUrl(), pattern),
        "URL pattern " + pattern);
  }

  @When("I wait up to {long} milliseconds for {string} to be visible using recovery {string} after {long} milliseconds, retrying every {long} milliseconds, waiting until {string}, and maximum {long} attempts")
  public void waitForVisible(long timeoutMs, String label, String recoveryAction, long refreshAfterMs, long retryAfterMs, String waitUntil, long maxAttempts) {
    BddWorld.waitWithAuthoredRecovery(
        timeoutMs,
        refreshAfterMs,
        retryAfterMs,
        waitUntil,
        recoveryAction,
        maxAttempts,
        () -> BddWorld.visibleNow(label),
        "visible element " + label);
  }

  @Then("I should see {string}")
  public void shouldSee(String text) {
    Assert.assertTrue(BddWorld.seesText(resolvedExpected(text)), "Expected page text: " + text);
  }

  @Then("I should not see {string}")
  public void shouldNotSee(String text) {
    Assert.assertFalse(BddWorld.seesText(resolvedExpected(text)), "Forbidden page text: " + text);
  }

  @Then("{string} should be visible")
  public void shouldBeVisible(String label) {
    Assert.assertTrue(element(label).isDisplayed(), "Expected visible element: " + label);
  }

  @Then("{string} should be hidden")
  public void shouldBeHidden(String label) {
    Assert.assertTrue(absentOrHidden(label), "Expected hidden or absent element: " + label);
  }

  @Then("{string} should contain {string}")
  public void shouldContain(String label, String expected) {
    Assert.assertTrue(textOf(element(label)).contains(resolvedExpected(expected)), "Expected text in " + label + ": " + expected);
  }

  @Then("the URL should match {string}")
  public void urlShouldMatch(String pattern) {
    Assert.assertTrue(BddWorld.urlMatches(pattern), "Expected URL to match: " + pattern);
  }

  @When("I provide manual input {string} from env {string}")
  public void provideManualInputFromEnv(String field, String envName) {
    String value = EnvReader.read(envName);
    if (value.isEmpty()) throw new IllegalStateException("Missing manual input for " + field);
  }

  @Then("the recorded locator evidence should be available")
  public void locatorEvidenceAvailable() {
    // Marker step for resolve-only evidence. It is intentionally a no-op.
  }
}
`;

function readmeMd(envVars) {
  const lines = (envVars || []).map((n) => `   - \`${n}\``).join('\n');
  return `# QAAI ReplayIR export (Selenium BDD / Cucumber-JVM)

Generated only from pinned ReplayIR. Feature files and Java glue are deterministic.

1. Install JDK 11+ and Maven.
2. Export required environment variables:
${lines || '   - (none)'}
3. Run \`mvn test-compile\` to validate, then \`mvn test\`.

Source \`blocked\`/\`needs_human\` verdicts and \`complete:false\` envelopes are retained as diagnostic comments and tags. Generated scenarios remain enabled and are not filtered by TestRunner.
`;
}

async function validatePackage(opts = {}) {
  return packageValidate.validatePackage({ ...opts, framework: VALIDATE_FRAMEWORK });
}

function assemblePackage({ admitted, locators, envVars }) {
  const files = seleniumReference.assemblePackage({ admitted: [], envVars });
  for (const javaFile of ['LocatorCandidate.java', 'LocatorResolver.java']) {
    const testPath = `src/test/java/${SUPPORT_PACKAGE_PATH}/${javaFile}`;
    const mainPath = `src/main/java/${SUPPORT_PACKAGE_PATH}/${javaFile}`;
    if (files[testPath]) {
      files[mainPath] = files[testPath];
      delete files[testPath];
    }
  }
  files['pom.xml'] = POM_XML;
  files['testng.xml'] = TESTNG_XML;
  files[`src/test/java/${BASE_PACKAGE.replace(/\./g, '/')}/runner/TestRunner.java`] = TEST_RUNNER;
  files[`src/main/java/${BDD_PACKAGE.replace(/\./g, '/')}/BddWorld.java`] = BDD_WORLD;
  files[`src/main/java/${BDD_PACKAGE.replace(/\./g, '/')}/LocatorCatalog.java`] = locatorCatalogJava(locators);
  files[`src/test/java/${STEPS_PACKAGE.replace(/\./g, '/')}/Hooks.java`] = HOOKS;
  files[`src/test/java/${STEPS_PACKAGE.replace(/\./g, '/')}/ReplayIrSteps.java`] = STEPS;
  files['README.md'] = readmeMd(envVars);
  files['.env.example'] = (envVars || []).map((n) => `${n}=`).join('\n') + '\n';
  for (const a of admitted || []) files[a.filePath] = a.content;
  return files;
}

module.exports = {
  id: ADAPTER_ID,
  ADAPTER_ID,
  ADAPTER_VERSION,
  VALIDATE_FRAMEWORK,
  SUPPORTED_ASSERT,
  compileResults,
  assemblePackage,
  validatePackage,
  renderFeature,
  locatorCatalogJava,
};
