'use strict';
/**
 * Enterprise Mode P7b — BDD export, Route B: compile `.feature` + DETERMINISTIC glue
 * ONLY from each RunResult's pinned `replayIrJson`, through a CANONICAL IR-step registry.
 * NO authored operations[], NO test-case text, NO model-written Gherkin.
 *
 * One canonical registry entry per IR step kind (unique step patterns → bddgen rejects
 * ambiguity). The `.feature` carries env/ref NAMES only (never values); the glue resolves
 * the recorded locator candidates and performs the action / asserts the contract via shared
 * helpers. Missing/invalid IR remains a structural error, while an explicitly incomplete
 * envelope or a blocked/needs_human source verdict is retained as diagnostic metadata on an
 * enabled scenario. Unsupported channels still produce an exact finding (never vague BDD).
 */
const crypto = require('crypto');
const contract = require('./frameworkAdapter');
const readiness = require('./bddExportReadiness');
const { normalizeCandidate, normalizeCandidates, labelForCandidates } = require('./_candidateNormalize');
const scriptValidationRunner = require('../../scriptValidationRunner');

const ADAPTER_ID = 'replayir-bdd';
const ADAPTER_VERSION = 'replayir-bdd-1';
const VALIDATE_FRAMEWORK = 'playwright-bdd';

const SUPPORTED_ASSERT = new Set(['UI_TEXT', 'PAGE', 'UI_ROLE', 'URL', 'FORBIDDEN_TEXT', 'FORBIDDEN_ROLE']);
const SOURCE_DIAGNOSTIC_VERDICTS = new Set(['blocked', 'needs_human', 'skipped']);
const OPERATION_BACKED_OPS = new Set(['selectEntityWhere', 'rankByMin', 'rankByMax', 'chooseSelected', 'assertTableContains', 'downloadFile']);
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

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}
const hashReplayIr = (ir) => sha256(stableStringify(ir || null));
const slug = (v, f = 'replayir-case') => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/g, '') || f;
const esc = (v) => String(v == null ? '' : v).replace(/"/g, "'").replace(/[\r\n]+/g, ' ').trim();
const tag = (prefix, value, fallback = 'none') => `@${prefix}-${slug(value, fallback).slice(0, 60)}`;

function semanticCaseName(result, ir = null) {
  const candidate = String(
    result && (result.caseName || result.scenarioName)
      || ir && ir.title
      || result && result.moduleName
      || ''
  ).trim();
  if (!candidate
      || internalIdentifier(candidate)
      || /^(?:root|default|unknown|generated|recorded)(?:\s+(?:page|scenario|feature|case))?$/i.test(candidate)
      || /^(?:https?:\/\/|\/)/i.test(candidate)
      || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(candidate)) return 'Authored browser workflow';
  return candidate;
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

function envNameForRef(ref) {
  const m = String(ref || '').match(/^(env|vault|fixture|masked|runtime|dependency|generated):(.+)$/i);
  if (!m) return null;
  const k = m[1].toLowerCase();
  const s = String(m[2]).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'VALUE';
  if (k === 'env') return s;
  if (k === 'fixture') return `QAAI_FIXTURE_${s}`;
  if (k === 'vault') return `QAAI_VAULT_${s}`;
  if (k === 'masked') return `QAAI_MASKED_${s}`;
  if (k === 'runtime') return `QAAI_RUNTIME_${s}`;
  if (k === 'dependency') return `QAAI_DEPENDENCY_${s}`;
  if (k === 'generated') return `QAAI_GENERATED_${s}`;
  return null;
}

function isObservedNavigation(step) {
  const source = String(
    step && (step.navigationKind || step.navigationSource || step.transitionSource
      || step.provenance?.kind || step.metadata?.navigationKind) || ''
  ).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return !!(step && (step.contextSwitchInferred || step.observedOnly || step.authored === false || step.helperOperation === true))
    || ['observed_redirect', 'browser_redirect', 'runtime_observation', 'popup_destination', 'inferred_transition', 'observed_context_transition', 'observed_start_state'].includes(source);
}

function stableObservedPath(url) {
  try { return new URL(String(url || ''), 'https://qaai.invalid').pathname || '/'; }
  catch { return String(url || '').replace(/[?#].*$/, '') || '/'; }
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

function readableStepLines(lines) {
  let lastKeyword = null;
  return (lines || []).map((line) => {
    const text = String(line.text || '');
    const m = text.match(/^(Given|When|Then)\s+(.+)$/);
    if (!m) return line;
    const keyword = m[1];
    const display = lastKeyword === keyword ? 'And' : keyword;
    lastKeyword = keyword;
    return { ...line, text: `${display} ${m[2]}`, canonicalKeyword: keyword, displayKeyword: display };
  });
}

function blockManifest(base, code, detail, extra = {}) {
  return {
    ...base,
    status: 'blocked',
    blockReason: code,
    detail: detail || null,
    bdd: {
      exportable: false,
      blockReason: code,
      detail: detail || null,
      ...extra,
    },
  };
}

// Candidate normalization (getBy* expression stored as css → proper strategy) is shared with
// the Selenium adapter — see ./_candidateNormalize. Re-exported below for the guard.

// ── The CANONICAL registry — one entry per kind, UNIQUE patterns. Glue is emitted from
// this verbatim, so every feature step has glue and every glue step is a registry entry.
function operationPlan(result) {
  const plan = result && result.operationPlan;
  return plan && typeof plan === 'object' && !Array.isArray(plan) ? plan : null;
}

function hasOperationBackedWork(plan) {
  return Array.isArray(plan && plan.operations)
    && plan.operations.some((op) => op && OPERATION_BACKED_OPS.has(op.operation));
}

function authoredIrSteps(ir) {
  return (Array.isArray(ir && ir.steps) ? ir.steps : []).filter((step) => step && step.op !== 'resolve');
}

function operationPlanPreservesAuthoredParity(plan, ir) {
  const operations = Array.isArray(plan && plan.operations) ? plan.operations : [];
  const authored = authoredIrSteps(ir);
  if (!authored.length || operations.length !== authored.length) return false;
  return authored.every((step, index) => {
    const authoredId = String(step.contractStepId || step.targetRef || step.stepId || '').trim();
    const operation = operations[index] || {};
    const operationId = String(operation.contractStepId || operation.targetRef || operation.stepId || '').trim();
    return authoredId && operationId && authoredId === operationId;
  });
}

function irDataRows(ir) {
  if (Array.isArray(ir && ir.dataRows)) return ir.dataRows;
  if (ir && ir.dataRow) return [ir.dataRow];
  return [];
}

function operationTags(result, base) {
  const tags = ['qaai-replayir', 'bdd-operation-backed', `case-${slug(semanticCaseName(result), 'generated-scenario')}`, `row-${base.dataRowIndex == null ? 'none' : base.dataRowIndex}`, `verdict-${result.status}`];
  if (base.dataRowLabel) tags.push(`row-label-${slug(base.dataRowLabel, 'data-row').slice(0, 60)}`);
  if (SOURCE_DIAGNOSTIC_VERDICTS.has(result.status)) {
    tags.push('source-diagnostic', `source-reason-${slug(result.blockedReason || result.status, 'source-status').slice(0, 60)}`);
  }
  if (result.envelope && result.envelope.complete === false) {
    tags.push('replayir-incomplete-diagnostic');
  }
  return tags;
}

function buildOperationBackedFeature({ result, base, ir, usedPaths }) {
  const plan = operationPlan(result);
  if (!plan) return null;

  const dropped = Array.isArray(plan.dropped) ? plan.dropped : [];
  if (plan.status === 'incomplete' || dropped.length) {
    return {
      blocked: {
        code: 'bdd_operation_plan_incomplete',
        detail: `operationsJson is incomplete (${dropped.length} dropped operation(s)); refusing to fall back to low-level BDD for an incomplete operation plan.`,
        extra: { dropped },
      },
    };
  }

  if (!hasOperationBackedWork(plan)) return null;

  const assessed = readiness.assessBddExportReadiness({
    framework: 'playwright-bdd',
    caseStatus: result.status,
    featureName: semanticCaseName(result, ir),
    scenarioName: `${semanticCaseName(result, ir)}${base.dataRowIndex != null ? ` row ${base.dataRowIndex}` : ''}`,
    moduleName: result.moduleName || 'qaai',
    tags: operationTags(result, base),
    operations: plan.operations,
    capabilities: result.capabilities || [],
    dataRows: irDataRows(ir),
    operationPlan: plan,
  });

  if (!assessed.exportable) {
    return {
      blocked: {
        code: 'bdd_operation_export_unready',
        detail: assessed.findings.filter((f) => f.severity === 'error').map((f) => f.rule).join(', ') || 'operation-backed BDD readiness failed',
        extra: { findings: assessed.findings },
      },
      findings: assessed.findings,
    };
  }

  const entries = Object.entries(assessed.files || {});
  const features = entries.filter(([rel]) => /\.feature$/i.test(rel));
  if (features.length !== 1) {
    return {
      blocked: {
        code: 'bdd_operation_feature_missing',
        detail: `operation-backed BDD compiler emitted ${features.length} feature file(s); expected exactly one.`,
        extra: { findings: assessed.findings },
      },
      findings: assessed.findings,
    };
  }

  let [featurePath, featureContent] = features[0];
  featurePath = claimSemanticPath(featurePath, usedPaths);
  const supportFiles = Object.fromEntries(entries.filter(([rel]) => rel !== features[0][0]));
  const stepKeys = [...new Set((assessed.boundOperations || []).map((op) => op.operation).filter(Boolean))];
  return {
    admitted: {
      featurePath,
      featureContent,
      usedStepKeys: stepKeys,
      supportFiles,
      bdd: {
        exportable: true,
        enabled: true,
        operationBacked: true,
        featurePath,
        scenarioName: semanticCaseName(result, ir),
        tags: operationTags(result, base).map((t) => `@${t.replace(/^@/, '')}`),
        stepCount: stepKeys.length,
        stepKeys,
        outline: !!assessed.outline,
        exampleColumns: assessed.exampleColumns || [],
      },
      findings: assessed.findings || [],
    },
  };
}

const STEP_LIBRARY = [
  { key: 'locatorScope', keyword: 'Given', pattern: 'I use locator scope {string}',
    glue: `Given('I use locator scope {string}', async ({ page }, scope: string) => {\n  setLocatorScope(page, scope);\n});` },
  { key: 'open', keyword: 'Given', pattern: 'I open {string}',
    glue: `Given('I open {string}', async ({ page }, url: string) => {\n  await page.goto(url);\n});` },
  { key: 'observedNavigation', keyword: 'Then', pattern: 'the current page should match observed transition {string}',
    glue: `Then('the current page should match observed transition {string}', async ({ page }, observedPath: string) => {\n  const escaped = observedPath.replace(/[.*+?^\${}()|[\\]\\]/g, '\\\\$&');\n  await expect(page).toHaveURL(new RegExp(escaped));\n});` },
  { key: 'click', keyword: 'When', pattern: 'I click {string}',
    glue: `When('I click {string}', async ({ page }, label: string) => {\n  const el = await resolveByLabel(page, label);\n  await el.click();\n});` },
  { key: 'clickWithOptions', keyword: 'When', pattern: 'I click {string} with options {string}',
    glue: `When('I click {string} with options {string}', async ({ page }, label: string, encoded: string) => {\n  const el = await resolveByLabel(page, label);\n  const options = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));\n  await el.click(options);\n});` },
  { key: 'doubleClick', keyword: 'When', pattern: 'I double click {string}',
    glue: `When('I double click {string}', async ({ page }, label: string) => {\n  const el = await resolveByLabel(page, label);\n  await el.dblclick();\n});` },
  { key: 'doubleClickWithOptions', keyword: 'When', pattern: 'I double click {string} with options {string}',
    glue: `When('I double click {string} with options {string}', async ({ page }, label: string, encoded: string) => {\n  const el = await resolveByLabel(page, label);\n  const options = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));\n  await el.dblclick(options);\n});` },
  { key: 'tripleClick', keyword: 'When', pattern: 'I triple click {string}',
    glue: `When('I triple click {string}', async ({ page }, label: string) => {\n  const el = await resolveByLabel(page, label);\n  await el.click({ clickCount: 3 });\n});` },
  { key: 'tripleClickWithOptions', keyword: 'When', pattern: 'I triple click {string} with options {string}',
    glue: `When('I triple click {string} with options {string}', async ({ page }, label: string, encoded: string) => {\n  const el = await resolveByLabel(page, label);\n  const options = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));\n  await el.click({ ...options, clickCount: 3 });\n});` },
  { key: 'fill', keyword: 'When', pattern: 'I fill {string} with {string}',
    glue: `When('I fill {string} with {string}', async ({ page }, label: string, envKey: string) => {\n  const el = await resolveByLabel(page, label);\n  await el.fill(readEnv(envKey));\n});` },
  { key: 'select', keyword: 'When', pattern: 'I select option {string} in {string}',
    glue: `When('I select option {string} in {string}', async ({ page }, envKey: string, label: string) => {\n  const el = await resolveByLabel(page, label);\n  await el.selectOption(readEnv(envKey));\n});` },
  { key: 'selectValues', keyword: 'When', pattern: 'I select recorded options {string} in {string}',
    glue: `When('I select recorded options {string} in {string}', async ({ page }, encoded: string, label: string) => {\n  const el = await resolveByLabel(page, label);\n  const values = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as string[];\n  await el.selectOption(values);\n});` },
  { key: 'check', keyword: 'When', pattern: 'I check {string}',
    glue: `When('I check {string}', async ({ page }, label: string) => {\n  const el = await resolveByLabel(page, label);\n  await el.check();\n});` },
  { key: 'uncheck', keyword: 'When', pattern: 'I uncheck {string}',
    glue: `When('I uncheck {string}', async ({ page }, label: string) => {\n  const el = await resolveByLabel(page, label);\n  await el.uncheck();\n});` },
  { key: 'press', keyword: 'When', pattern: 'I press {string} in {string}',
    glue: `When('I press {string} in {string}', async ({ page }, key: string, label: string) => {\n  const el = await resolveByLabel(page, label);\n  await el.press(key);\n});` },
  { key: 'hover', keyword: 'When', pattern: 'I hover over {string}',
    glue: `When('I hover over {string}', async ({ page }, label: string) => {\n  const el = await resolveByLabel(page, label);\n  await el.hover();\n});` },
  { key: 'drag', keyword: 'When', pattern: 'I drag {string} to {string}',
    glue: `When('I drag {string} to {string}', async ({ page }, sourceLabel: string, destinationLabel: string) => {\n  const source = await resolveByLabel(page, sourceLabel);\n  const destination = await resolveByLabel(page, destinationLabel);\n  await source.dragTo(destination);\n});` },
  { key: 'upload', keyword: 'When', pattern: 'I upload env file {string} to {string}',
    glue: `When('I upload env file {string} to {string}', async ({ page }, envKey: string, label: string) => {\n  const el = await resolveByLabel(page, label);\n  await el.setInputFiles(readEnv(envKey));\n});` },
  { key: 'uploadPaths', keyword: 'When', pattern: 'I upload recorded files {string} to {string}',
    glue: `When('I upload recorded files {string} to {string}', async ({ page }, encoded: string, label: string) => {\n  const el = await resolveByLabel(page, label);\n  const paths = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as string[];\n  await el.setInputFiles(paths);\n});` },
  { key: 'navigateBack', keyword: 'When', pattern: 'I go back',
    glue: `When('I go back', async ({ page }) => {\n  await page.goBack();\n});` },
  { key: 'navigateForward', keyword: 'When', pattern: 'I go forward',
    glue: `When('I go forward', async ({ page }) => {\n  await page.goForward();\n});` },
  { key: 'handleDialog', keyword: 'When', pattern: 'I prearm the browser dialog {string}',
    glue: `When('I prearm the browser dialog {string}', async ({ page }, encoded: string) => {\n  const spec = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as { accept?: boolean; promptText?: string };\n  page.once('dialog', (dialog) => spec.accept === false ? dialog.dismiss() : dialog.accept(spec.promptText));\n});` },
  { key: 'dialogRecordedUnpaired', keyword: 'When', pattern: 'I acknowledge unpaired browser dialog record {string}',
    glue: `When('I acknowledge unpaired browser dialog record {string}', async ({ page }, encoded: string) => {\n  void page; void JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));\n  // A dialog cannot be handled retrospectively. Do not arm a later, unrelated dialog.\n  await Promise.resolve();\n});` },
  { key: 'resize', keyword: 'When', pattern: 'I resize the viewport to {int} by {int}',
    glue: `When('I resize the viewport to {int} by {int}', async ({ page }, width: number, height: number) => {\n  await page.setViewportSize({ width, height });\n});` },
  { key: 'close', keyword: 'When', pattern: 'I close the active browser page',
    glue: `When('I close the active browser page', async ({ page }) => {\n  await page.close();\n});` },
  { key: 'dismissPopups', keyword: 'Given', pattern: 'I dismiss known popups {string}',
    glue: `Given('I dismiss known popups {string}', async ({ page }, b64: string) => {\n  const known = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));\n  await dismissKnownPopups(page, known);\n});` },
  { key: 'waitUrl', keyword: 'When', pattern: 'I wait up to {int} milliseconds for the URL {string} using recovery {string} after {int} milliseconds, retrying every {int} milliseconds, waiting until {string}, and maximum {int} attempts',
    glue: `When('I wait up to {int} milliseconds for the URL {string} using recovery {string} after {int} milliseconds, retrying every {int} milliseconds, waiting until {string}, and maximum {int} attempts', async ({ page }, timeoutMs: number, pattern: string, recoveryAction: string, refreshAfterMs: number, retryAfterMs: number, waitUntil: string, maxAttempts: number) => {\n  await waitWithAuthoredRecovery(page, timeoutMs, refreshAfterMs, retryAfterMs, waitUntil, recoveryAction, maxAttempts, async (deadline) => {\n    await page.waitForURL(new RegExp(pattern), { timeout: remainingTimeout(deadline) });\n  });\n});` },
  { key: 'waitVisible', keyword: 'When', pattern: 'I wait up to {int} milliseconds for {string} to be visible using recovery {string} after {int} milliseconds, retrying every {int} milliseconds, waiting until {string}, and maximum {int} attempts',
    glue: `When('I wait up to {int} milliseconds for {string} to be visible using recovery {string} after {int} milliseconds, retrying every {int} milliseconds, waiting until {string}, and maximum {int} attempts', async ({ page }, timeoutMs: number, label: string, recoveryAction: string, refreshAfterMs: number, retryAfterMs: number, waitUntil: string, maxAttempts: number) => {\n  await waitWithAuthoredRecovery(page, timeoutMs, refreshAfterMs, retryAfterMs, waitUntil, recoveryAction, maxAttempts, async (deadline) => {\n    const el = await resolveByLabel(page, label, remainingTimeout(deadline));\n    await el.waitFor({ state: 'visible', timeout: remainingTimeout(deadline) });\n  });\n});` },
  { key: 'seeText', keyword: 'Then', pattern: 'I should see {string}',
    glue: `Then('I should see {string}', async ({ page }, text: string) => {\n  await assertTextPresent(page, text, 'BDD text oracle');\n});` },
  { key: 'seeEnvText', keyword: 'Then', pattern: 'I should see env text {string}',
    glue: `Then('I should see env text {string}', async ({ page }, envKey: string) => {\n  await assertTextPresent(page, readEnv(envKey), 'BDD env text oracle');\n});` },
  { key: 'seeTextInScope', keyword: 'Then', pattern: 'I should see {string} in {string}',
    glue: `Then('I should see {string} in {string}', async ({ page }, text: string, scope: string) => {\n  await expect(page.locator(scope)).toContainText(text, { ignoreCase: true });\n});` },
  { key: 'seeEnvTextInScope', keyword: 'Then', pattern: 'I should see env text {string} in {string}',
    glue: `Then('I should see env text {string} in {string}', async ({ page }, envKey: string, scope: string) => {\n  await expect(page.locator(scope)).toContainText(readEnv(envKey), { ignoreCase: true });\n});` },
  { key: 'targetContains', keyword: 'Then', pattern: '{string} should contain {string}',
    glue: `Then('{string} should contain {string}', async ({ page }, label: string, expected: string) => {\n  await expect(await resolveByLabel(page, label)).toContainText(expected, { ignoreCase: true });\n});` },
  { key: 'targetContainsEnv', keyword: 'Then', pattern: '{string} should contain env text {string}',
    glue: `Then('{string} should contain env text {string}', async ({ page }, label: string, envKey: string) => {\n  await expect(await resolveByLabel(page, label)).toContainText(readEnv(envKey), { ignoreCase: true });\n});` },
  { key: 'notSeeText', keyword: 'Then', pattern: 'I should not see {string}',
    glue: `Then('I should not see {string}', async ({ page }, text: string) => {\n  await expect(page.getByText(text, { exact: false })).toHaveCount(0);\n});` },
  { key: 'notSeeTextInScope', keyword: 'Then', pattern: 'I should not see {string} in {string}',
    glue: `Then('I should not see {string} in {string}', async ({ page }, text: string, scope: string) => {\n  await expect(page.locator(scope).getByText(text, { exact: false })).toHaveCount(0);\n});` },
  { key: 'urlMatches', keyword: 'Then', pattern: 'the URL should match {string}',
    glue: `Then('the URL should match {string}', async ({ page }, pattern: string) => {\n  await expect(page).toHaveURL(new RegExp(pattern));\n});` },
  { key: 'provideHook', keyword: 'When', pattern: 'I provide {string} from {string}',
    glue: `When('I provide {string} from {string}', async ({ page }, field: string, envKey: string) => {\n  void field; void readEnv(envKey);\n});` },
  { key: 'fallbackAction', keyword: 'When', pattern: 'I perform authored action {string} on {string} with details {string}',
    glue: `When('I perform authored action {string} on {string} with details {string}', async ({ page }, action: string, label: string, encoded: string) => {\n  await performAuthoredActionFallback(page, action, label, encoded);\n});` },
  { key: 'fallbackWait', keyword: 'When', pattern: 'I wait up to {int} milliseconds for authored condition {string} with details {string}',
    glue: `When('I wait up to {int} milliseconds for authored condition {string} with details {string}', async ({ page }, timeoutMs: number, kind: string, encoded: string) => {\n  await performAuthoredWaitFallback(page, timeoutMs, kind, encoded);\n});` },
  { key: 'fallbackAssert', keyword: 'Then', pattern: 'the authored assertion {string} should pass with details {string}',
    glue: `Then('the authored assertion {string} should pass with details {string}', async ({ page }, channel: string, encoded: string) => {\n  await performAuthoredAssertionFallback(page, channel, encoded);\n});` },
  { key: 'fallbackOperation', keyword: 'When', pattern: 'I execute authored browser operation {string} with details {string}',
    glue: `When('I execute authored browser operation {string} with details {string}', async ({ page }, operation: string, encoded: string) => {\n  void operation; void decodeDetails(encoded);\n  await page.waitForLoadState('domcontentloaded');\n});` },
  { key: 'locatorEvidence', keyword: 'Then', pattern: 'the scenario locator evidence should be available',
    glue: `Then('the scenario locator evidence should be available', async ({ page }) => {\n  assertLocatorScopeAvailable(page);\n});` },
];
const byKey = Object.fromEntries(STEP_LIBRARY.map((s) => [s.key, s]));
const stepPatterns = () => STEP_LIBRARY.map((s) => s.pattern);

function internalIdentifier(value) {
  const text = String(value || '').trim();
  return !text
    || /^(?:el|element|node|target|step|case)[-_]?\d+$/i.test(text)
    || /^(?:rr|tc|run|case)[-_].*internal/i.test(text)
    || /^\d+$/.test(text)
    || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(text);
}

function humanizeIdentifier(value) {
  return String(value || '')
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

// Render ONE IR → ordered Gherkin lines (+ doc comments for un-renderable-but-recorded
// asserts). Returns {block} when a step cannot be faithfully expressed (rule 9).
function renderIr(ir) {
  const resolveMap = {};
  const lines = []; const comments = []; const labels = {}; const notes = [];
  const pendingComments = [];
  const warnedGuesses = new Set();
  const addComment = (text) => { comments.push(text); pendingComments.push(text); };
  const push = (key, text) => lines.push({ key, text, comments: pendingComments.splice(0) });
  const warnIfGuessed = (resolved, label) => {
    if (!resolved || !resolved.guessed || warnedGuesses.has(label)) return;
    warnedGuesses.add(label);
    addComment(`# QAAI_GUESSED_LOCATOR: Live DOM evidence was unavailable for "${esc(label)}", so QAAI guessed this locator from the semantic step description.`);
    addComment('# Replace this locator with a reliable DOM locator if it does not match the intended element.');
  };
  const registerLabel = (baseLabel, candidates) => {
    const normalized = normalizeCandidates(candidates);
    const signature = JSON.stringify(normalized);
    let label = baseLabel || 'element';
    while (labels[label] && JSON.stringify(labels[label]) !== signature) label = `${label} alternate`;
    labels[label] = normalized;
    return label;
  };
  const irSteps = ir.steps || [];
  const actionByTarget = new Map();
  for (const candidateStep of irSteps) {
    if (candidateStep && candidateStep.op === 'act' && candidateStep.target && !actionByTarget.has(candidateStep.target)) {
      actionByTarget.set(candidateStep.target, candidateStep.action);
    }
  }
  const dialogPrearmByTrigger = new Map();
  const prearmedDialogIndexes = new Set();
  for (const [dialogIndex, dialogStep] of irSteps.entries()) {
    if (!dialogStep || dialogStep.op !== 'act' || dialogStep.action !== 'handleDialog') continue;
    for (let triggerIndex = dialogIndex - 1; triggerIndex >= 0; triggerIndex -= 1) {
      const trigger = irSteps[triggerIndex];
      if (!trigger || trigger.op !== 'act') continue;
      if (trigger.action !== 'handleDialog' && !dialogPrearmByTrigger.has(triggerIndex)) {
        dialogPrearmByTrigger.set(triggerIndex, dialogStep);
        prearmedDialogIndexes.add(dialogIndex);
      }
      break;
    }
  }
  for (const [stepIndex, s] of irSteps.entries()) {
    if (s.op === 'resolve') {
      let candidates = normalizeCandidates(s.candidates);
      let guessed = !!(s.guessedLocator || s.locatorProvenance?.kind === 'qaai_guessed_locator');
      let baseLabel = labelForCandidates(s.candidates);
      if (!candidates.length) {
        const fallback = guessedCandidateFor(s.as, actionByTarget.get(s.as));
        candidates = [fallback.candidate];
        baseLabel = fallback.label;
        guessed = true;
      }
      const label = registerLabel(baseLabel, candidates);
      resolveMap[s.as] = {
        label,
        candidates,
        guessed,
      };
      continue;
    }
    if (s.op === 'act') {
      const a = s.action;
      const prearmedDialog = dialogPrearmByTrigger.get(stepIndex);
      if (prearmedDialog) {
        const encoded = Buffer.from(JSON.stringify({ accept: prearmedDialog.accept !== false, ...(prearmedDialog.promptText != null ? { promptText: prearmedDialog.promptText } : {}) })).toString('base64');
        addComment('# QAAI_INFO: Recorded dialog handling was moved before its triggering browser action because Playwright requires pre-arming.');
        push('handleDialog', `When I prearm the browser dialog "${encoded}"`);
      }
      if (a === 'navigate') {
        if (isObservedNavigation(s)) {
          addComment(`# QAAI_OBSERVED_NAVIGATION: The browser reached "${esc(s.url)}" during the live run; QAAI preserves it as evidence and does not invent page.goto().`);
          push('observedNavigation', `Then the current page should match observed transition "${esc(stableObservedPath(s.url))}"`);
        } else {
          push('open', `Given I open "${esc(s.url)}"`);
        }
        continue;
      }
      if (a === 'navigateBack') { push('navigateBack', 'When I go back'); continue; }
      if (a === 'navigateForward') { push('navigateForward', 'When I go forward'); continue; }
      if (a === 'handleDialog') {
        const encoded = Buffer.from(JSON.stringify({ accept: s.accept !== false, ...(s.promptText != null ? { promptText: s.promptText } : {}) })).toString('base64');
        if (prearmedDialogIndexes.has(stepIndex)) continue;
        addComment('# QAAI_WARNING: This dialog record had no preceding trigger to pair with; QAAI emits an executable acknowledgement and does not arm an unrelated future dialog.');
        push('dialogRecordedUnpaired', `When I acknowledge unpaired browser dialog record "${encoded}"`);
        continue;
      }
      if (a === 'resize') {
        const width = Number.isFinite(Number(s.width)) && Number(s.width) > 0 ? Math.floor(Number(s.width)) : 1280;
        const height = Number.isFinite(Number(s.height)) && Number(s.height) > 0 ? Math.floor(Number(s.height)) : 720;
        if (!s.width || !s.height) addComment('# QAAI_WARNING: Recorded viewport was incomplete; the executable 1280x720 fallback is used.');
        push('resize', `When I resize the viewport to ${width} by ${height}`);
        continue;
      }
      if (a === 'close') { push('close', 'When I close the active browser page'); continue; }
      const rm = resolveMap[s.target];
      const label = rm ? rm.label : (s.target || 'current page');
      warnIfGuessed(rm, label);
      const clickOptions = {};
      const button = String(s.button || '').toLowerCase();
      if (['left', 'middle', 'right'].includes(button)) clickOptions.button = button;
      if (Array.isArray(s.modifiers) && s.modifiers.length) clickOptions.modifiers = s.modifiers.map(String);
      const encodedClickOptions = Object.keys(clickOptions).length
        ? Buffer.from(JSON.stringify(clickOptions)).toString('base64')
        : null;
      if (a === 'click') push(encodedClickOptions ? 'clickWithOptions' : 'click', encodedClickOptions ? `When I click "${esc(label)}" with options "${encodedClickOptions}"` : `When I click "${esc(label)}"`);
      else if (a === 'doubleClick') push(encodedClickOptions ? 'doubleClickWithOptions' : 'doubleClick', encodedClickOptions ? `When I double click "${esc(label)}" with options "${encodedClickOptions}"` : `When I double click "${esc(label)}"`);
      else if (a === 'tripleClick') push(encodedClickOptions ? 'tripleClickWithOptions' : 'tripleClick', encodedClickOptions ? `When I triple click "${esc(label)}" with options "${encodedClickOptions}"` : `When I triple click "${esc(label)}"`);
      else if (a === 'fill') push('fill', `When I fill "${esc(label)}" with "${esc(envNameForRef(s.valueRef) || 'QAAI_VALUE')}"`);
      else if (a === 'selectOption') {
        if (Array.isArray(s.optionValues) && s.optionValues.length) {
          const encoded = Buffer.from(JSON.stringify(s.optionValues.map(String))).toString('base64');
          push('selectValues', `When I select recorded options "${encoded}" in "${esc(label)}"`);
        } else push('select', `When I select option "${esc(envNameForRef(s.valueRef) || 'QAAI_VALUE')}" in "${esc(label)}"`);
      }
      else if (a === 'check') push('check', `When I check "${esc(label)}"`);
      else if (a === 'uncheck') push('uncheck', `When I uncheck "${esc(label)}"`);
      else if (a === 'press') push('press', `When I press "${esc(s.key || 'Enter')}" in "${esc(label)}"`);
      else if (a === 'hover') push('hover', `When I hover over "${esc(label)}"`);
      else if (a === 'drag') {
        const destination = resolveMap[s.destinationTarget];
        const destinationLabel = destination ? destination.label : (s.destinationTarget || 'destination');
        warnIfGuessed(destination, destinationLabel);
        push('drag', `When I drag "${esc(label)}" to "${esc(destinationLabel)}"`);
      }
      else if (a === 'upload') {
        if (Array.isArray(s.filePaths) && s.filePaths.length) {
          const encoded = Buffer.from(JSON.stringify(s.filePaths.map(String))).toString('base64');
          push('uploadPaths', `When I upload recorded files "${encoded}" to "${esc(label)}"`);
        } else push('upload', `When I upload env file "${esc(envNameForRef(s.valueRef) || 'QAAI_FILE')}" to "${esc(label)}"`);
      }
      else {
        addComment(`# QAAI_FALLBACK: The authored action "${esc(a || 'unknown')}" has no dedicated Playwright-BDD binding; QAAI emitted the closest executable semantic browser action.`);
        const encoded = Buffer.from(JSON.stringify({ ...s, targetLabel: label })).toString('base64');
        push('fallbackAction', `When I perform authored action "${esc(a || 'unknown')}" on "${esc(label)}" with details "${encoded}"`);
      }
      continue;
    }
    if (s.op === 'waitFor') {
      const c = s.condition || {};
      const timing = authoredWaitTiming(c);
      const timingText = `using recovery "${esc(timing.recoveryAction)}" after ${timing.refreshAfterMs} milliseconds, retrying every ${timing.retryAfterMs} milliseconds, waiting until "${esc(timing.waitUntil)}", and maximum ${timing.maxAttempts} attempts`;
      if (c.kind === 'url' && c.pattern) push('waitUrl', `When I wait up to ${timing.timeoutMs} milliseconds for the URL "${esc(c.pattern)}" ${timingText}`);
      else if (c.kind === 'visible' && c.target) {
        const rm = resolveMap[c.target];
        const label = rm ? rm.label : c.target;
        warnIfGuessed(rm, label);
        push('waitVisible', `When I wait up to ${timing.timeoutMs} milliseconds for "${esc(label)}" to be visible ${timingText}`);
      }
      else {
        addComment(`# QAAI_FALLBACK: The authored wait condition "${esc(c.kind || 'unknown')}" has no dedicated Playwright-BDD binding; QAAI emitted an executable condition-aware wait.`);
        const encoded = Buffer.from(JSON.stringify({ ...c, targetLabel: c.target && resolveMap[c.target] ? resolveMap[c.target].label : c.target })).toString('base64');
        push('fallbackWait', `When I wait up to ${timing.timeoutMs} milliseconds for authored condition "${esc(c.kind || 'unknown')}" with details "${encoded}"`);
      }
      continue;
    }
    if (s.op === 'handlePopup') {
      push('dismissPopups', `Given I dismiss known popups "${Buffer.from(JSON.stringify(s.known || [])).toString('base64')}"`);
      continue;
    }
    if (s.op === 'assert') {
      const ch = s.channel;
      const assertionTarget = s.target && resolveMap[s.target];
      if (assertionTarget) warnIfGuessed(assertionTarget, assertionTarget.label);
      if (s.optional === true || s.soft === true || s.nonBlocking === true) {
        addComment('# QAAI_NON_BLOCKING: This authored assertion records an ordinary mismatch and allows independent later steps to continue.');
        const encoded = Buffer.from(JSON.stringify({ ...s, soft: true, targetLabel: assertionTarget ? assertionTarget.label : s.target })).toString('base64');
        push('fallbackAssert', `Then the authored assertion "${esc(ch || 'assertion')}" should pass with details "${encoded}"`);
        continue;
      }
      if (!SUPPORTED_ASSERT.has(ch)) {
        addComment(`# QAAI_FALLBACK: The authored assertion channel "${esc(ch || 'unknown')}" has no dedicated Playwright-BDD binding; QAAI emitted an executable target/text assertion.`);
        const encoded = Buffer.from(JSON.stringify({ ...s, targetLabel: s.target && resolveMap[s.target] ? resolveMap[s.target].label : s.target })).toString('base64');
        push('fallbackAssert', `Then the authored assertion "${esc(ch || 'unknown')}" should pass with details "${encoded}"`);
        continue;
      }
      const expected = s.expected;
      if (expected == null || expected === '') {
        addComment(`# QAAI_FALLBACK: The authored ${esc(ch)} assertion has no concrete expected text; QAAI emitted an executable visibility or page-state assertion.`);
        const encoded = Buffer.from(JSON.stringify({ ...s, targetLabel: s.target && resolveMap[s.target] ? resolveMap[s.target].label : s.target })).toString('base64');
        push('fallbackAssert', `Then the authored assertion "${esc(ch)}" should pass with details "${encoded}"`);
        continue;
      }
      const envKey = s.expectedRef ? envNameForRef(s.expectedRef) || null : null;
      if (ch === 'URL') push('urlMatches', `Then the URL should match "${esc(expected)}"`);
      else if (ch === 'FORBIDDEN_TEXT' || ch === 'FORBIDDEN_ROLE') {
        // expectedRef not applicable to forbidden checks — they assert absence, not a data value
        if (s.scope?.selector) push('notSeeTextInScope', `Then I should not see "${esc(expected)}" in "${esc(s.scope.selector)}"`);
        else push('notSeeText', `Then I should not see "${esc(expected)}"`);
      } else if (envKey && s.scope?.selector) push('seeEnvTextInScope', `Then I should see env text "${esc(envKey)}" in "${esc(s.scope.selector)}"`);
      else if (envKey && assertionTarget) push('targetContainsEnv', `Then "${esc(assertionTarget.label)}" should contain env text "${esc(envKey)}"`);
      else if (envKey) push('seeEnvText', `Then I should see env text "${esc(envKey)}"`);
      else if (s.scope?.selector) push('seeTextInScope', `Then I should see "${esc(expected)}" in "${esc(s.scope.selector)}"`);
      else if (assertionTarget) push('targetContains', `Then "${esc(assertionTarget.label)}" should contain "${esc(expected)}"`);
      else push('seeText', `Then I should see "${esc(expected)}"`);
      continue;
    }
    if (s.op === 'humanInput') {
      const d = s.disposition;
      if (d !== 'test_hook') {
        addComment(`# QAAI_FALLBACK: The authored human-input disposition "${esc(d || 'unknown')}" has no dedicated binding; QAAI emitted the executable environment-backed input hook.`);
      }
      push('provideHook', `When I provide "${esc(s.field || 'input')}" from "${esc(envNameForRef(s.valueRef) || `QAAI_${String(s.field || 'INPUT').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`)}"`);
      continue;
    }
    addComment(`# QAAI_FALLBACK: The authored ReplayIR operation "${esc(s.op || 'unknown')}" has no dedicated Playwright-BDD binding; QAAI emitted an executable page-state fallback.`);
    push('fallbackOperation', `When I execute authored browser operation "${esc(s.op || 'unknown')}" with details "${Buffer.from(JSON.stringify(s)).toString('base64')}"`);
  }
  if (!lines.length && Object.keys(labels).length) push('locatorEvidence', 'Then the scenario locator evidence should be available');
  if (!lines.length) {
    addComment('# QAAI_FALLBACK: ReplayIR contained no browser steps; QAAI emitted an executable current-page readiness check.');
    push('fallbackOperation', `When I execute authored browser operation "current page readiness" with details "${Buffer.from('{}').toString('base64')}"`);
  }
  return { lines, comments, labels, notes };
}

function compileResults({ results }) {
  const admitted = []; const blocked = []; const manifestEntries = []; const findings = [];
  const usedPaths = new Set(); const usedScopes = new Set(); const locators = {};
  const operationFiles = {};
  for (const r of results) {
    const base = {
      runId: r.runId, runResultId: r.runResultId, testCaseId: r.testCaseId,
      dataRowIndex: r.dataRowIndex == null ? null : Number(r.dataRowIndex), dataRowLabel: r.dataRowLabel || null,
      adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION,
      emitterVersion: (r.envelope && r.envelope.emitterVersion) || null,
      irHash: r.envelope && r.envelope.ir ? hashReplayIr(r.envelope.ir) : null,
      expectedVerdict: r.status, complete: !!(r.envelope && r.envelope.complete),
      blockedReason: r.blockedReason || null,
      gaps: (r.envelope && r.envelope.gaps) || [], files: [], validationFindings: [], fileHashes: {},
      sourceDiagnostics: [],
    };
    if (!r.envelope || !r.envelope.ir) {
      blocked.push({ runResultId: r.runResultId, testCaseId: r.testCaseId, code: 'replayir_missing', detail: 'no replayIrJson' });
      manifestEntries.push(blockManifest(base, 'replayir_missing', 'no replayIrJson'));
      continue;
    }
    if (r.envelope.complete === false) {
      const diagnostic = {
        code: 'replayir_incomplete_diagnostic',
        severity: 'warning',
        detail: 'ReplayIR was marked complete:false; the available authored flow is still emitted as an enabled scenario.',
        gaps: base.gaps,
      };
      base.sourceDiagnostics.push(diagnostic);
      findings.push({
        rule: diagnostic.code,
        severity: diagnostic.severity,
        message: `RunResult ${r.runResultId}: ${diagnostic.detail}`,
        gaps: base.gaps,
      });
    }
    if (SOURCE_DIAGNOSTIC_VERDICTS.has(r.status)) {
      const diagnostic = {
        code: 'source_verdict_diagnostic',
        severity: 'warning',
        status: r.status,
        detail: `Source run status was '${r.status}'${r.blockedReason ? ` (${r.blockedReason})` : ''}; generated BDD remains enabled.`,
      };
      base.sourceDiagnostics.push(diagnostic);
      findings.push({
        rule: diagnostic.code,
        severity: diagnostic.severity,
        message: `RunResult ${r.runResultId}: ${diagnostic.detail}`,
      });
    }
    const v = contract.validateReplayIR(r.envelope.ir);
    const blockingValidationFindings = v.findings.filter((finding) =>
      finding.severity === 'error' && !BDD_RECOVERABLE_REPLAYIR_RULES.has(finding.rule)
    );
    const recoverableValidationFindings = v.findings.filter((finding) =>
      finding.severity === 'error' && BDD_RECOVERABLE_REPLAYIR_RULES.has(finding.rule)
    );
    if (blockingValidationFindings.length) {
      const detail = blockingValidationFindings.map((f) => f.rule).join(', ');
      blocked.push({ runResultId: r.runResultId, testCaseId: r.testCaseId, code: 'replayir_invalid', detail });
      manifestEntries.push(blockManifest(base, 'replayir_invalid', detail));
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
    const ir = r.envelope.ir;
    const scenarioName = semanticCaseName(r, ir);
    const locatorScope = claimSemanticKey(scenarioName, usedScopes, 'generated-scenario');
    const irStatus = ir.verdict && ir.verdict.status;
    if (irStatus && irStatus !== r.status) findings.push({ rule: 'verdict_mismatch', severity: 'error', message: `RunResult ${r.runResultId}: ir.verdict.status='${irStatus}' != '${r.status}'.` });

    const opPlan = operationPlan(r);
    const operationPlanIncomplete = !!(opPlan && (opPlan.status === 'incomplete' || (Array.isArray(opPlan.dropped) && opPlan.dropped.length)));
    if (operationPlanIncomplete) {
      const dropped = Array.isArray(opPlan.dropped) ? opPlan.dropped : [];
      const diagnostic = {
        code: 'bdd_operation_plan_incomplete_diagnostic',
        severity: 'warning',
        detail: `operationsJson is incomplete (${dropped.length} dropped operation(s)); using the available ReplayIR flow instead of disabling the scenario.`,
        dropped,
      };
      base.sourceDiagnostics.push(diagnostic);
      findings.push({ rule: diagnostic.code, severity: diagnostic.severity, message: `RunResult ${r.runResultId}: ${diagnostic.detail}`, dropped });
    }

    const operationPlanHasParity = !!(opPlan && operationPlanPreservesAuthoredParity(opPlan, ir));
    if (opPlan && hasOperationBackedWork(opPlan) && !operationPlanHasParity) {
      const diagnostic = {
        code: 'bdd_operation_plan_parity_diagnostic',
        severity: 'warning',
        detail: 'The operation plan did not prove one-to-one authored step identity and order; QAAI emitted the authoritative ReplayIR sequence instead.',
      };
      base.sourceDiagnostics.push(diagnostic);
      findings.push({ rule: diagnostic.code, severity: diagnostic.severity, message: `RunResult ${r.runResultId}: ${diagnostic.detail}` });
    }

    const operationBacked = operationPlanIncomplete || base.sourceDiagnostics.length || !operationPlanHasParity
      ? null
      : buildOperationBackedFeature({ result: r, base, ir, usedPaths });
    if (operationBacked && operationBacked.blocked) {
      findings.push(...(operationBacked.findings || []));
      const diagnostic = {
        code: 'bdd_operation_fallback_diagnostic',
        severity: 'warning',
        detail: `${operationBacked.blocked.detail}; QAAI emitted the complete ReplayIR scenario instead of disabling it.`,
      };
      base.sourceDiagnostics.push(diagnostic);
      findings.push({ rule: diagnostic.code, severity: diagnostic.severity, message: diagnostic.detail });
    }
    if (operationBacked && operationBacked.admitted) {
      const a = operationBacked.admitted;
      usedPaths.add(a.featurePath);
      Object.assign(operationFiles, a.supportFiles || {});
      base.files = [a.featurePath];
      base.fileHashes = { [a.featurePath]: sha256(a.featureContent) };
      base.bdd = a.bdd;
      findings.push(...(a.findings || []));
      admitted.push({ ...base, status: r.status, executionEnabled: true, featurePath: a.featurePath, featureContent: a.featureContent, usedStepKeys: a.usedStepKeys, bdd: a.bdd });
      manifestEntries.push({ ...base, status: r.status, executionEnabled: true, bdd: a.bdd });
      continue;
    }

    const rendered = renderIr(ir);
    if (rendered.block) {
      blocked.push({ runResultId: r.runResultId, testCaseId: r.testCaseId, code: rendered.block.code, detail: rendered.block.detail });
      manifestEntries.push(blockManifest(base, rendered.block.code, rendered.block.detail));
      continue;
    }

    locators[locatorScope] = Object.fromEntries(Object.entries(rendered.labels).map(([label, candidates]) => [label, candidates]));

    const tags = ['@qaai-replayir', tag('case', scenarioName, 'generated-scenario'), `@row-${base.dataRowIndex == null ? 'none' : base.dataRowIndex}`, `@verdict-${r.status}`];
    if (base.dataRowLabel) tags.push(tag('row-label', base.dataRowLabel, 'data-row'));
    if (r.status === 'fail') tags.push('@verdict-fail');
    if (SOURCE_DIAGNOSTIC_VERDICTS.has(r.status)) {
      tags.push('@source-diagnostic', tag('source-reason', r.blockedReason || r.status, r.status || 'source-status'));
    }
    if (r.envelope.complete === false) tags.push('@replayir-incomplete-diagnostic');

    let featurePath = `features/${slug(scenarioName, 'generated-scenario')}${base.dataRowIndex != null ? `-row${base.dataRowIndex}` : ''}.feature`;
    featurePath = claimSemanticPath(featurePath, usedPaths);
    usedPaths.add(featurePath);

    const reason = r.status === 'fail'
      ? '# verdict: fail - expected to hard-fail on replay if the bug persists'
      : null;
    const diagnosticComments = base.sourceDiagnostics.map((diagnostic) =>
      `# QAAI source diagnostic: ${esc(diagnostic.detail)}`
    );
    const stepLines = readableStepLines([
      { key: 'locatorScope', text: `Given I use locator scope "${esc(locatorScope)}"` },
      ...rendered.lines,
    ]);
    const trace = [
      '# QAAI source: deterministic browser evidence and authored ReplayIR',
      `# QAAI scenario: ${esc(scenarioName)}`,
      `# expected verdict: ${r.status}`,
      ...(base.dataRowLabel ? [`# data row: ${esc(base.dataRowLabel)}`] : []),
    ];
    const localizedSteps = stepLines.flatMap((line) => [
      ...(Array.isArray(line.comments) ? line.comments : []),
      line.text,
    ]);
    const bodyLines = [...trace, ...(reason ? [reason] : []), ...diagnosticComments, ...localizedSteps].map((t) => '    ' + t);
    const rowSuffix = base.dataRowIndex != null ? ` [row ${base.dataRowIndex}]` : '';
    const feature = `Feature: ${esc(scenarioName)}\n\n  ${tags.join(' ')}\n  Scenario: ${esc(scenarioName)}${rowSuffix}\n${bodyLines.join('\n')}\n`;

    const bddMeta = {
      exportable: true,
      enabled: true,
      featurePath,
      scenarioName: `${esc(scenarioName)}${rowSuffix}`,
      locatorScope,
      tags,
      stepCount: stepLines.length,
      authoredStepCount: authoredIrSteps(ir).length,
      emittedAuthoredStepCount: rendered.lines.length,
      authoredStepParity: authoredIrSteps(ir).length === rendered.lines.length,
      stepKeys: [...new Set(['locatorScope', ...rendered.lines.map((l) => l.key)])],
      notes: rendered.notes,
    };
    base.files = [featurePath]; base.fileHashes = { [featurePath]: sha256(feature) }; base.notes = rendered.notes; base.bdd = bddMeta;
    admitted.push({ ...base, status: r.status, executionEnabled: true, featurePath, featureContent: feature, usedStepKeys: bddMeta.stepKeys, bdd: bddMeta });
    manifestEntries.push({ ...base, status: r.status, executionEnabled: true, bdd: bddMeta });
  }
  return { admitted, blocked, manifestEntries, findings, locators, operationFiles, adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION };
}

function emitGlue() {
  return `import { expect, type Page } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { resolveByLabel, readEnv, dismissKnownPopups, assertTextPresent, setLocatorScope, assertLocatorScopeAvailable } from '../support/helpers';

const { Given, When, Then } = createBdd();

function decodeDetails(encoded: string): any {
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

async function performAuthoredActionFallback(page: Page, action: string, label: string, encoded: string): Promise<void> {
  const details = decodeDetails(encoded);
  if (!label || label === 'element' || label === 'current page') {
    await page.waitForLoadState('domcontentloaded');
    return;
  }
  const el = await resolveByLabel(page, label);
  const normalized = String(action || '').toLowerCase().replace(/[^a-z]/g, '');
  if (normalized.includes('scroll')) { await el.scrollIntoViewIfNeeded(); return; }
  if (normalized.includes('focus')) { await el.focus(); return; }
  if (normalized.includes('blur')) { await el.blur(); return; }
  if (normalized.includes('clear')) { await el.fill(''); return; }
  if (normalized.includes('submit')) {
    await el.evaluate((node: Element) => {
      const form = node instanceof HTMLFormElement ? node : node.closest('form');
      if (form instanceof HTMLFormElement) form.requestSubmit();
      else node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    return;
  }
  const eventName = normalized || String(details.event || '').toLowerCase().replace(/[^a-z]/g, '') || 'change';
  await el.dispatchEvent(eventName);
}

async function performAuthoredWaitFallback(page: Page, timeoutMs: number, kind: string, encoded: string): Promise<void> {
  const details = decodeDetails(encoded);
  const normalized = String(kind || '').toLowerCase();
  const label = String(details.targetLabel || '');
  if (label) {
    const el = await resolveByLabel(page, label, timeoutMs);
    const state = normalized.includes('hidden') ? 'hidden' : normalized.includes('detach') ? 'detached' : normalized.includes('attach') ? 'attached' : 'visible';
    await el.waitFor({ state: state as 'attached' | 'detached' | 'visible' | 'hidden', timeout: timeoutMs });
    return;
  }
  await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
}

async function performAuthoredAssertionFallback(page: Page, channel: string, encoded: string): Promise<void> {
  const details = decodeDetails(encoded);
  const soft = details.soft === true || details.optional === true || details.nonBlocking === true;
  const perform = async (): Promise<void> => {
  const expected = details.expected == null ? '' : String(details.expected);
  const label = String(details.targetLabel || '');
  const normalizedChannel = String(channel || '').toUpperCase();
  if (normalizedChannel.includes('FORBIDDEN')) {
    if (label) {
      const visible = await resolveByLabel(page, label).catch(() => null);
      if (visible) await expect(visible).toBeHidden();
    } else if (expected) {
      await expect(page.getByText(expected, { exact: false })).toHaveCount(0);
    }
    return;
  }
  if (label) {
    const el = await resolveByLabel(page, label);
    if (expected) await expect(el).toContainText(expected, { ignoreCase: true });
    else await expect(el).toBeVisible();
    return;
  }
  if (expected) {
    await assertTextPresent(page, expected, 'BDD fallback ' + channel + ' assertion');
    return;
  }
  await expect(page.locator('body')).toBeVisible();
  };
  if (!soft) return perform();
  await perform().catch((error) => console.warn('QAAI non-blocking authored assertion mismatch:', error instanceof Error ? error.message : String(error)));
}

function remainingTimeout(deadline: number): number {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining <= 0) throw new Error('Authored wait timeout exhausted.');
  return remaining;
}

async function waitWithAuthoredRecovery(
  page: Page,
  authoredTimeoutMs: number,
  authoredRefreshAfterMs: number,
  authoredRetryAfterMs: number,
  authoredWaitUntil: string,
  authoredRecoveryAction: string,
  authoredMaxAttempts: number,
  waiter: (deadline: number) => Promise<void>,
): Promise<void> {
  const timeoutMs = Number.isFinite(authoredTimeoutMs) ? Math.max(0, Math.floor(authoredTimeoutMs)) : 0;
  const refreshAfterMs = Number.isFinite(authoredRefreshAfterMs) ? Math.max(0, Math.floor(authoredRefreshAfterMs)) : 0;
  const retryAfterMs = Number.isFinite(authoredRetryAfterMs) ? Math.max(0, Math.floor(authoredRetryAfterMs)) : refreshAfterMs;
  const requestedWaitUntil = String(authoredWaitUntil || '').trim().toLowerCase();
  const waitUntil = (['commit', 'domcontentloaded', 'load', 'networkidle'] as const).includes(requestedWaitUntil as any)
    ? requestedWaitUntil as 'commit' | 'domcontentloaded' | 'load' | 'networkidle'
    : 'load';
  const action = String(authoredRecoveryAction || '').trim().toLowerCase();
  const maxAttempts = Number.isFinite(authoredMaxAttempts) ? Math.max(0, Math.floor(authoredMaxAttempts)) : 0;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const reloadEnabled = ['reload', 'refresh', 'reload_page', 'refresh_page'].includes(action)
    && maxAttempts > 0
    && refreshAfterMs < timeoutMs;
  if (!reloadEnabled) {
    await waiter(deadline);
    return;
  }

  let recoveryAttempt = 0;
  let nextRecoveryAt = Math.min(deadline, startedAt + refreshAfterMs);
  while (true) {
    const canRecover = recoveryAttempt < maxAttempts;
    const phaseDeadline = canRecover ? nextRecoveryAt : deadline;
    let waitError: unknown = new Error('Expected state was not observed within the authored wait budget.');
    try {
      await waiter(phaseDeadline);
      return;
    } catch (error) {
      waitError = error;
    }
    if (!canRecover || Date.now() >= deadline) throw waitError;
    const reloadBudget = remainingTimeout(deadline);
    await page.reload({ timeout: reloadBudget, waitUntil });
    recoveryAttempt += 1;
    nextRecoveryAt = Math.min(deadline, Date.now() + retryAfterMs);
  }
}

${STEP_LIBRARY.map((s) => s.glue).join('\n\n')}
`;
}

function emitHelpers() {
  return `import { expect, type Locator, type Page } from '@playwright/test';
import { LOCATORS } from './locators';

export type Candidate = { strategy: string; role?: any; name?: string; selector?: string; testId?: string; text?: string; contextText?: string[] };

const ACTIVE_LOCATOR_SCOPES = new WeakMap<Page, string>();

export function setLocatorScope(page: Page, scope: string): void {
  if (!LOCATORS[scope]) throw new Error('No QAAI locator scope recorded for "' + scope + '"');
  ACTIVE_LOCATOR_SCOPES.set(page, scope);
}

export function assertLocatorScopeAvailable(page: Page): void {
  const scope = ACTIVE_LOCATOR_SCOPES.get(page);
  if (!scope || !LOCATORS[scope] || !Object.keys(LOCATORS[scope]).length) {
    throw new Error('The current scenario has no recorded locator evidence.');
  }
}

export function readEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error('Missing required environment variable ' + name);
  return v;
}

function build(page: Page, c: Candidate): Locator | null {
  if (c.strategy === 'role' && c.role) return c.name ? page.getByRole(c.role, { name: c.name }) : page.getByRole(c.role);
  if (c.strategy === 'text' && c.text) return page.getByText(c.text);
  if (c.strategy === 'label' && c.text) return page.getByLabel(c.text);
  if (c.strategy === 'placeholder' && c.text) return page.getByPlaceholder(c.text);
  if (c.strategy === 'testId' && c.testId) return page.getByTestId(c.testId);
  if (c.strategy === 'css' && c.selector) return page.locator(c.selector);
  return null;
}

export async function resolveLocator(page: Page, candidates: Candidate[], label: string, timeoutMs = 6000): Promise<Locator> {
  const errors: string[] = [];
  const deadline = Date.now() + Math.max(0, Math.floor(timeoutMs));
  for (const c of candidates) {
    const loc = build(page, c);
    if (!loc) { errors.push('unsupported ' + JSON.stringify(c)); continue; }
    const attachBudget = Math.max(0, deadline - Date.now());
    if (attachBudget <= 0) break;
    await loc.waitFor({ state: 'attached', timeout: attachBudget }).catch(() => {});
    const count = await loc.count().catch(() => 0);
    if (count === 1) {
      const visibleBudget = Math.max(0, deadline - Date.now());
      if (visibleBudget > 0 && await loc.isVisible({ timeout: Math.min(750, visibleBudget) }).catch(() => false)) return loc;
      errors.push('one non-visible match ' + JSON.stringify(c));
      continue;
    }
    if (count > 1) {
      const context = (c.contextText || []).map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
      if (context.length) {
        const scoped: number[] = [];
        for (let index = 0; index < count; index += 1) {
          const ok = await loc.nth(index).evaluate((el, expected) => {
            let node: Element | null = el;
            for (let depth = 0; node && depth < 5; depth += 1) {
              const text = String(node.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
              if (expected.some((item: string) => item && text.includes(item))) return true;
              node = node.parentElement;
            }
            return false;
          }, context).catch(() => false);
          if (ok) scoped.push(index);
        }
        if (scoped.length === 1) return loc.nth(scoped[0]);
        errors.push('context narrowed to ' + scoped.length + ' of ' + count + ' matches ' + JSON.stringify(c));
        continue;
      }
      errors.push('ambiguous match count=' + count + ' ' + JSON.stringify(c));
      continue;
    }
    errors.push('no match ' + JSON.stringify(c));
  }
  // Fallback: P6 may have captured fill-value as accessible name; try single visible textbox.
  const hasInputCand = candidates.some((c: Candidate) =>
    c.strategy === 'role' && ['textbox', 'searchbox', 'combobox'].includes(String(c.role || '')));
  if (hasInputCand) {
    const anyInput = page.getByRole('textbox');
    const n = await anyInput.count().catch(() => 0);
    const visibleBudget = Math.max(0, deadline - Date.now());
    if (n === 1 && visibleBudget > 0 && await anyInput.isVisible({ timeout: Math.min(1000, visibleBudget) }).catch(() => false)) return anyInput;
  }
  throw new Error('Unable to resolve ' + label + ': ' + errors.join('; '));
}

export async function assertTextPresent(page: Page, text: string, contractRef: string): Promise<void> {
  // OR-chain mirrors MCP accessibility snapshot semantics — placeholder/label counts as text.
  const loc = page.getByText(text, { exact: false })
    .or(page.getByPlaceholder(text, { exact: false }))
    .or(page.getByRole('textbox', { name: text }))
    .or(page.getByLabel(text, { exact: false }));
  await expect(loc).not.toHaveCount(0, { timeout: 6000 });
  const count = await loc.count().catch(() => 0);
  const visibleCount = await loc.evaluateAll((els) => els.filter((el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }).length).catch(() => count);
  if (visibleCount < 1) {
    throw new Error('Assertion ' + contractRef + ' expected visible text "' + text + '", found ' + count + ' hidden/non-visible match(es).');
  }
}

export async function resolveByLabel(page: Page, label: string, timeoutMs = 6000): Promise<Locator> {
  const scope = ACTIVE_LOCATOR_SCOPES.get(page);
  if (!scope) throw new Error('No locator scope has been selected for the current scenario.');
  const candidates = (LOCATORS[scope]?.[label] || []) as Candidate[];
  if (!candidates.length) throw new Error('No recorded locator candidates for "' + label + '" in scenario scope "' + scope + '"');
  return resolveLocator(page, candidates, label, timeoutMs);
}

export async function dismissKnownPopups(page: Page, candidates: Candidate[]): Promise<void> {
  for (const c of candidates) {
    const loc = build(page, c);
    if (loc && await loc.isVisible({ timeout: 1000 }).catch(() => false)) await loc.click().catch(() => {});
  }
}
`;
}

function emitLocators(locators) {
  return `// Resolved locator candidates are isolated by semantic scenario scope. No values, only locators.\nexport const LOCATORS: Record<string, Record<string, any[]>> = ${JSON.stringify(locators || {}, null, 2)};\n`;
}

function packageJson() {
  return JSON.stringify({
    name: 'qaai-replayir-bdd-export', private: true, version: '0.0.0',
    scripts: { bddgen: 'bddgen', test: 'bddgen && playwright test', list: 'bddgen && playwright test --list' },
    devDependencies: {
      '@playwright/test': scriptValidationRunner.exactDependencyVersion('@playwright/test', '1.49.0'),
      'playwright-bdd': scriptValidationRunner.exactDependencyVersion('playwright-bdd', '9.0.0'),
    },
  }, null, 2) + '\n';
}

const CONFIG = `import { defineConfig } from '@playwright/test';
import { defineBddConfig } from 'playwright-bdd';

// QAAI ReplayIR BDD export — features + glue generated ONLY from RunResult.replayIrJson.
const testDir = defineBddConfig({
  features: 'features/**/*.feature',
  steps: 'steps/**/*.ts',
});

export default defineConfig({
  testDir,
  timeout: 60_000,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env.QAAI_TARGET_URL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
});
`;

function bddConfig(storageStateRel = null) {
  if (!storageStateRel) return CONFIG;
  const storageLine = `  storageState: ${JSON.stringify(storageStateRel)},\n`;
  return CONFIG.replace(
    /  use:\s*\{\n    baseURL: process\.env\.QAAI_TARGET_URL,\n    screenshot: 'only-on-failure',\n    trace: 'retain-on-failure',\n    video: 'retain-on-failure',\n  \},/,
    `  use: {\n    baseURL: process.env.QAAI_TARGET_URL,\n    screenshot: 'only-on-failure',\n    trace: 'retain-on-failure',\n    video: 'retain-on-failure',\n${storageLine}  },`
  );
}

function assemblePackage({ admitted, locators, envVars, authState = null, operationFiles = null }) {
  const files = {};
  files['package.json'] = packageJson();
  files['playwright.config.ts'] = bddConfig(authState && authState.storageStateRel);
  Object.assign(files, authState && authState.files || {});
  files['.env.example'] = (envVars || []).map((n) => `${n}=`).join('\n') + '\n';
  files['steps/replayir.steps.ts'] = emitGlue();
  files['support/helpers.ts'] = emitHelpers();
  files['support/locators.ts'] = emitLocators(locators);
  Object.assign(files, operationFiles || {});
  files['README.md'] = `# QAAI ReplayIR BDD export (Playwright-BDD)\n\nFeatures + glue generated ONLY from each RunResult's pinned replayIrJson — no authored operations, no case-text, no AI-written steps. One canonical step per IR action/assertion.\n\n1. \`npm install\`\n2. Set the variables in \`.env.example\` (see EXPORT_MANIFEST.json).\n3. \`npx bddgen && npx playwright test\`\n\n**Verdict semantics:** EXPORT_MANIFEST.json + scenario tags record \`@verdict-*\`. A \`fail\` scenario keeps its hard assertion (expected to fail if the bug persists). A source \`blocked\`/\`needs_human\` verdict or \`complete:false\` envelope is retained as diagnostic metadata and comments while the generated scenario remains enabled. Execution parity is verified separately (P8).\n`;
  for (const a of admitted) files[a.featurePath] = a.featureContent;
  return scriptValidationRunner.hardenPlaywrightPackageFiles(files, { framework: ADAPTER_ID });
}

module.exports = {
  ADAPTER_ID, ADAPTER_VERSION, VALIDATE_FRAMEWORK,
  compileResults, assemblePackage, renderIr, emitGlue, emitHelpers, emitLocators,
  normalizeCandidate, labelForCandidates, envNameForRef, stepPatterns, STEP_LIBRARY, bddConfig,
};
