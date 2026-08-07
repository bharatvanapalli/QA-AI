'use strict';

const packageValidate = require('../_packageValidate');
const regressionCorpus = require('./regressionCorpus');
const { normalizeCandidates, labelForCandidates } = require('./_candidateNormalize');
const actionLocatorResolver = require('../../actionLocatorResolver');

const ADAPTER_ID = 'playwright-reference';

function q(value) {
  return JSON.stringify(value == null ? '' : String(value));
}

function slug(value, fallback = 'replayir-case') {
  const out = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return out || fallback;
}

function ident(value, fallback = 'target') {
  const base = String(value || fallback)
    .replace(/[^A-Za-z0-9_$]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part, index) => {
      const clean = part.replace(/[^A-Za-z0-9_$]/g, '');
      if (!clean) return '';
      return index === 0
        ? clean.charAt(0).toLowerCase() + clean.slice(1)
        : clean.charAt(0).toUpperCase() + clean.slice(1);
    })
    .join('');
  const safe = base || fallback;
  return /^[A-Za-z_$]/.test(safe) ? safe : `v${safe}`;
}

// Derive a readable camelCase variable name from the best normalized locator candidate.
// Falls back to ident(fallback) when no usable candidate exists.
// Handles duplicates externally (caller tracks usedNames and appends a counter).
function semanticVarName(candidates, fallback) {
  const norm = normalizeCandidates(candidates || []);
  const best =
    norm.find((c) => c.strategy === 'role' && c.name) ||
    norm.find((c) => c.strategy === 'placeholder' && c.text) ||
    norm.find((c) => c.strategy === 'label' && c.text) ||
    norm.find((c) => c.strategy === 'text' && c.text) ||
    norm.find((c) => c.name || c.text || c.testId);
  if (!best) return ident(fallback || 'target');
  const label = best.name || best.text || best.testId || String(fallback || 'target');
  const suffix =
    best.strategy === 'role' && best.role
      ? best.role
      : best.strategy === 'placeholder'
        ? 'field'
        : '';
  return ident(suffix ? `${label} ${suffix}` : label);
}

function escapeRegex(value) {
  return String(value == null ? '' : value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isInternalElementName(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  return (
    /^(?:el|element|target|node|ref)[-_ ]?\d*$/i.test(text) ||
    /^qaai[-_:]/i.test(text) ||
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(text)
  );
}

function readableAuthoredLabel(step, destination = false) {
  const values = destination
    ? [
        step && step.destinationLabel,
        step && step.destinationName,
        step && step.destinationText,
        step && step.destinationTarget,
      ]
    : [
        step && step.accessibleName,
        step && step.targetLabel,
        step && step.targetName,
        step && step.targetText,
        step && step.elementLabel,
        step && step.elementName,
        step && step.label,
        step && step.target,
        step && step.description,
        step && step.instruction,
      ];
  for (const value of values) {
    if (isInternalElementName(value)) continue;
    const cleaned = String(value || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(
        /^\s*(?:click|double\s*click|triple\s*click|fill|type|enter|select|check|uncheck|press|hover|drag|upload)\s+(?:on\s+|into\s+|the\s+)?/i,
        '',
      )
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned && !isInternalElementName(cleaned)) return cleaned;
  }
  return '';
}

function guessedLocatorForAction(step, destination = false) {
  const action = String((step && step.action) || 'interact');
  const label = readableAuthoredLabel(step, destination);
  const identifierLabel = label
    .replace(
      /\s+(?:button|link|field|input|textbox|checkbox|combobox|menu\s*item|element)\s*$/i,
      '',
    )
    .trim();
  const authoredRole =
    !destination && /^[a-z][a-z0-9_-]*$/i.test(String((step && step.role) || ''))
      ? String(step.role).toLowerCase()
      : '';
  const role =
    authoredRole ||
    {
      fill: 'textbox',
      type: 'textbox',
      press: 'textbox',
      selectOption: 'combobox',
      check: 'checkbox',
      uncheck: 'checkbox',
      click: 'button',
      doubleClick: 'button',
      tripleClick: 'button',
      hover: 'button',
      drag: 'button',
    }[action] ||
    'button';
  const semanticName = ident(
    identifierLabel ? `${identifierLabel} ${role}` : `${role} for ${action}`,
  );
  if (action === 'upload' && !label) {
    return { name: 'fileInput', expression: 'page.locator(\'input[type="file"]\')' };
  }
  if (label) {
    return {
      name: semanticName,
      expression: `page.getByRole(${q(role)}, { name: new RegExp(${q(escapeRegex(label))}, 'i') })`,
    };
  }
  return { name: semanticName, expression: `page.getByRole(${q(role)})` };
}

function candidatesForActionReference(source, ref) {
  if (Array.isArray(source)) return normalizeCandidates(source);
  if (!source || !Array.isArray(source.steps) || !ref) return [];
  const resolve = source.steps.find(
    (item) => item && item.op === 'resolve' && String(item.as) === String(ref),
  );
  return normalizeCandidates((resolve && resolve.candidates) || []);
}

function qaaiFallback(kind, detail, indent = '      ') {
  const message = `QAAI_FALLBACK_${String(kind || 'STEP').toUpperCase()}: ${detail}`;
  return `${indent}test.info().annotations.push({ type: 'qaai-fallback', description: ${q(message)} });\n${indent}expect.soft(false, ${q(message)}).toBe(true);`;
}

function candidateLiteral(candidates) {
  return JSON.stringify(candidates || [], null, 2)
    .split('\n')
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join('\n');
}

function timeout(condition, fallback = 10000) {
  const n = Number(condition && condition.timeoutMs);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function reloadRecovery(condition, totalTimeoutMs) {
  const c = condition && typeof condition === 'object' ? condition : {};
  const rawRecovery = typeof c.recovery === 'string' ? { action: c.recovery } : c.recovery;
  if (!rawRecovery || typeof rawRecovery !== 'object') return null;
  const action = String(rawRecovery.action || rawRecovery.type || rawRecovery.kind || '')
    .trim()
    .toLowerCase();
  if (!['reload', 'refresh', 'reload_page', 'refresh_page'].includes(action)) return null;
  const refreshAfterMs = Number(c.refreshAfterMs);
  if (!Number.isFinite(refreshAfterMs) || refreshAfterMs <= 0 || refreshAfterMs >= totalTimeoutMs)
    return null;
  const attempts = Number(rawRecovery.maxAttempts);
  const maxAttempts = Number.isFinite(attempts) && attempts >= 0 ? Math.floor(attempts) : 1;
  if (maxAttempts < 1) return null;
  const retry = Number(rawRecovery.retryAfterMs);
  const retryAfterMs =
    Number.isFinite(retry) && retry > 0 ? Math.floor(retry) : Math.floor(refreshAfterMs);
  const waitUntil = ['commit', 'domcontentloaded', 'load', 'networkidle'].includes(
    String(rawRecovery.waitUntil || '').toLowerCase(),
  )
    ? String(rawRecovery.waitUntil).toLowerCase()
    : null;
  return {
    refreshAfterMs: Math.floor(refreshAfterMs),
    retryAfterMs,
    maxAttempts,
    waitUntil,
  };
}

function emitWaitWithReloadRecovery(condition, renderWait, fallbackTimeoutMs = 10000) {
  const totalTimeoutMs = timeout(condition, fallbackTimeoutMs);
  const recovery = reloadRecovery(condition, totalTimeoutMs);
  if (!recovery) return `      ${renderWait(String(totalTimeoutMs))}`;
  const reloadOptions = recovery.waitUntil
    ? `{ timeout: _qaaiReloadBudget, waitUntil: ${q(recovery.waitUntil)} }`
    : '{ timeout: _qaaiReloadBudget }';
  return [
    '      {',
    `        const _qaaiWaitDeadline = Date.now() + ${totalTimeoutMs};`,
    `        const _qaaiInitialRecoveryAfterMs = ${recovery.refreshAfterMs};`,
    `        const _qaaiRetryAfterMs = ${recovery.retryAfterMs};`,
    `        const _qaaiRecoveryLimit = ${recovery.maxAttempts};`,
    '        let _qaaiRecoveryAttempt = 0;',
    '        while (true) {',
    '          const _qaaiRemainingBudget = _qaaiWaitDeadline - Date.now();',
    "          if (_qaaiRemainingBudget <= 0) throw new Error('Authored wait budget exhausted before the expected state was observed.');",
    '          const _qaaiCanRecover = _qaaiRecoveryAttempt < _qaaiRecoveryLimit;',
    '          const _qaaiRecoveryWindow = _qaaiRecoveryAttempt === 0 ? _qaaiInitialRecoveryAfterMs : _qaaiRetryAfterMs;',
    '          const _qaaiWaitBudget = _qaaiCanRecover ? Math.min(_qaaiRecoveryWindow, _qaaiRemainingBudget) : _qaaiRemainingBudget;',
    '          try {',
    `            ${renderWait('_qaaiWaitBudget')}`,
    '            break;',
    '          } catch (_qaaiWaitError) {',
    '            if (!_qaaiCanRecover || Date.now() >= _qaaiWaitDeadline) throw _qaaiWaitError;',
    '            _qaaiRecoveryAttempt += 1;',
    '            const _qaaiReloadBudget = _qaaiWaitDeadline - Date.now();',
    '            if (_qaaiReloadBudget <= 0) throw _qaaiWaitError;',
    `            await page.reload(${reloadOptions});`,
    '            if (Date.now() >= _qaaiWaitDeadline) throw _qaaiWaitError;',
    '          }',
    '        }',
    '      }',
  ].join('\n');
}

function envNameFromRef(kind, body) {
  const suffix =
    String(body || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'VALUE';
  if (kind === 'fixture') return `QAAI_FIXTURE_${suffix}`;
  if (kind === 'vault') return `QAAI_VAULT_${suffix}`;
  if (kind === 'masked') return `QAAI_MASKED_${suffix}`;
  return suffix;
}

function envKeyFromRef(ref, fallback) {
  const match = String(ref || '').match(/^(env|vault|fixture|masked):(.+)$/i);
  if (!match) return fallback;
  const kind = match[1].toLowerCase();
  const body = match[2];
  return kind === 'env' ? body : envNameFromRef(kind, body);
}

function valueExpression(step) {
  const ref = String(step.valueRef || '');
  const match = ref.match(/^(env|vault|fixture|masked):(.+)$/i);
  // Environment-backed references always win over any diagnostic rawValue copy.
  // Safe inline values are literal only when no protected reference exists.
  if (!match) return step.rawValue != null ? q(step.rawValue) : 'undefined';
  const kind = match[1].toLowerCase();
  const body = match[2];
  if (kind === 'env') return `readEnv(${q(body)})`;
  return `readEnv(${q(envNameFromRef(kind, body))})`;
}

const TYPED_BINDING_KINDS = new Set([
  'literal',
  'secret_env',
  'workbook_column',
  'runtime_output',
  'dependency_output',
  'generated_value',
]);

function own(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}
function bindingText(...values) {
  const found = values.find((value) => value != null && String(value).trim());
  return found == null ? null : String(found).trim();
}
function stableBindingKey(step, prefix) {
  const suffix =
    bindingText(
      step && (step.contractStepId || step.stepId || step.id || step.target || step.action),
      'VALUE',
    )
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'VALUE';
  return `${prefix}_${suffix}`;
}
function literalExpression(value) {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}
function authoredLiteral(step, binding, purpose) {
  if (own(binding, 'value')) return binding.value;
  if (own(binding, 'literal')) return binding.literal;
  if (purpose === 'expected' && own(step, 'expected')) return step.expected;
  if (own(step, 'rawValue')) return step.rawValue;
  if (own(step, 'value')) return step.value;
  return undefined;
}
function warningExpression(message, expression) {
  const safe = String(message || '')
    .replace(/\*\//g, '* /')
    .replace(/\s+/g, ' ')
    .trim();
  return `/* QAAI_BINDING_DIAGNOSTIC: ${safe} */ ${expression}`;
}
function usableWorkbookProof(binding, context, column) {
  const metadata =
    context && context.bindingMetadata && typeof context.bindingMetadata === 'object'
      ? context.bindingMetadata
      : {};
  const bindingId = bindingText(binding.bindingId, binding.id, binding.proofId, column);
  const candidates = [
    binding.proof,
    binding.bindingMetadata,
    bindingId && metadata.bindings && metadata.bindings[bindingId],
    column && metadata.workbookColumns && metadata.workbookColumns[column],
    column && metadata.columns && metadata.columns[column],
  ].filter(Boolean);
  return candidates.some((proof) => {
    if (proof === true) return true;
    if (!proof || typeof proof !== 'object') return false;
    const proofCaseId = bindingText(proof.caseId, proof.testCaseId);
    if (proofCaseId && context && context.caseId && proofCaseId !== String(context.caseId))
      return false;
    const status = String(proof.status || '').toLowerCase();
    return (
      proof.usable === true ||
      proof.proven === true ||
      proof.verified === true ||
      ['usable', 'proven', 'verified'].includes(status)
    );
  });
}
function typedBindingExpression(step, binding, context = {}, purpose = 'value') {
  if (!binding || typeof binding !== 'object') return null;
  const kind = String(binding.kind || '').toLowerCase();
  if (!TYPED_BINDING_KINDS.has(kind)) return null;
  const fallback = authoredLiteral(step || {}, binding, purpose);
  if (kind === 'literal') {
    return fallback === undefined
      ? warningExpression(
          'literal binding has no authored value',
          `missingBindingValue('literal', ${q(stableBindingKey(step, 'LITERAL'))})`,
        )
      : literalExpression(fallback);
  }
  if (kind === 'secret_env') {
    const raw = bindingText(
      binding.envKey,
      binding.environmentVariable,
      binding.name,
      binding.key,
      binding.ref,
    );
    const key =
      raw && /^env:/i.test(raw)
        ? raw.replace(/^env:/i, '')
        : raw || stableBindingKey(step, 'QAAI_SECRET');
    return warningExpression(
      `secret_env reads ${key} and throws when missing; no secret is embedded`,
      `readEnv(${q(key)})`,
    );
  }
  if (kind === 'workbook_column') {
    const column = bindingText(
      binding.column,
      binding.sourceColumn,
      binding.columnName,
      binding.key,
    );
    const rowKey = context.hasDataLoop && column ? exportedDataKey(context.keys, column) : null;
    if (rowKey && usableWorkbookProof(binding, context, column))
      return `readData(row, ${q(rowKey)})`;
    const expression =
      fallback === undefined
        ? `missingBindingValue('workbook_column', ${q(stableBindingKey(step, 'WORKBOOK'))})`
        : literalExpression(fallback);
    return warningExpression(
      'workbook_column lacks case-scoped usable-row proof; authored literal is retained',
      expression,
    );
  }
  if (kind === 'runtime_output') {
    const key =
      bindingText(binding.output, binding.outputKey, binding.name, binding.key) ||
      stableBindingKey(step, 'RUNTIME');
    return warningExpression(
      `runtime_output ${key} throws when unavailable`,
      `readRuntimeOutput(${q(key)})`,
    );
  }
  if (kind === 'dependency_output') {
    const dependencyCaseId =
      bindingText(binding.dependencyCaseId, binding.dependsOnCaseId, binding.sourceCaseId) ||
      'dependency';
    const key =
      bindingText(binding.output, binding.outputKey, binding.name, binding.key) ||
      stableBindingKey(step, 'OUTPUT');
    return warningExpression(
      `dependency_output ${dependencyCaseId}.${key} throws when unavailable`,
      `readDependencyOutput(${q(dependencyCaseId)}, ${q(key)})`,
    );
  }
  const contract = binding.contract ||
    binding.generationContract ||
    binding.generator || {
      name: bindingText(binding.name, stableBindingKey(step, 'GENERATED')),
      prefix: binding.prefix,
      length: binding.length,
      seed: binding.seed,
    };
  return `generateDeterministicValue(${JSON.stringify({ ...contract, caseId: context.caseId || null, stepId: (step && (step.contractStepId || step.stepId || step.id)) || null })})`;
}

function isEnvironmentValueRef(ref) {
  return /^(?:env|vault|fixture|masked):/i.test(String(ref || ''));
}

function isEnvironmentBackedDataValue(value) {
  if (typeof value === 'string') return isEnvironmentValueRef(value.trim());
  if (!value || typeof value !== 'object') return false;
  const kind = String(
    value.kind || value.type || (value.source && value.source.kind) || '',
  ).toLowerCase();
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
  const usable = (rows || []).filter(
    (row) => row && row.fields && Object.keys(row.fields).length > 0,
  );
  if (!usable.length) return new Map();
  const common = new Map();
  for (const [key, value] of Object.entries(usable[0].fields)) {
    if (!isEnvironmentBackedDataValue(value)) common.set(String(key).toLowerCase(), String(key));
  }
  for (const row of usable.slice(1)) {
    const keys = new Set(
      Object.entries(row.fields)
        .filter(([, value]) => !isEnvironmentBackedDataValue(value))
        .map(([key]) => String(key).toLowerCase()),
    );
    for (const key of [...common.keys()]) {
      if (!keys.has(key)) common.delete(key);
    }
  }
  return common;
}

function exportedDataKey(keyMap, requested) {
  if (!requested || !(keyMap instanceof Map)) return null;
  return keyMap.get(String(requested).toLowerCase()) || null;
}

function rememberExportedDataKeys(opts, rows, providerEnabled) {
  if (!opts || typeof opts !== 'object') return;
  opts._qaaiDataProviderEnabled = !!providerEnabled;
  opts._qaaiExportedDataKeys = providerEnabled ? commonExportedDataKeys(rows) : new Map();
}

function dataContext(replayOrContext, opts = null) {
  if (
    replayOrContext &&
    typeof replayOrContext === 'object' &&
    Object.prototype.hasOwnProperty.call(replayOrContext, 'hasDataLoop')
  ) {
    const rows = replayOrContext.dataRow
      ? [replayOrContext.dataRow]
      : replayOrContext.dataRows || [];
    return {
      hasDataLoop: replayOrContext.hasDataLoop === true,
      keys: commonExportedDataKeys(rows),
      bindingMetadata: replayOrContext.bindingMetadata || {},
      caseId: replayOrContext.caseId || replayOrContext.testCaseId || null,
    };
  }
  const options = opts && typeof opts === 'object' ? opts : {};
  return {
    hasDataLoop: options._qaaiDataProviderEnabled === true,
    keys: options._qaaiExportedDataKeys instanceof Map ? options._qaaiExportedDataKeys : new Map(),
    bindingMetadata:
      options.bindingMetadata || (replayOrContext && replayOrContext.bindingMetadata) || {},
    caseId:
      options.caseId ||
      (replayOrContext && (replayOrContext.caseId || replayOrContext.testCaseId)) ||
      null,
  };
}

const SUPPORT_FILE = `import { expect, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export type LocatorCandidate = {
  strategy: 'role' | 'css' | 'testId' | 'text' | 'placeholder' | 'label';
  role?: Parameters<Page['getByRole']>[0];
  name?: string;
  selector?: string;
  testId?: string;
  text?: string;
  contextText?: string[];
};

export type DataRow = { index: number; label: string; fields?: Record<string, string> };
export type ReadDataOptions = { type?: 'string' | 'number' | 'boolean'; required?: boolean; defaultValue?: string | number | boolean };

export function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(\`Missing required environment variable \${name}\`);
  return value;
}

export type QaaiBindingContext = {
  runtimeOutputs?: Record<string, unknown>;
  dependencyOutputs?: Record<string, Record<string, unknown>>;
};

export type GeneratedValueContract = {
  name?: string;
  prefix?: string;
  length?: number;
  seed?: string;
  caseId?: string | null;
  stepId?: string | null;
  [key: string]: unknown;
};

function qaaiBindingContext(): QaaiBindingContext {
  const globalContext = (globalThis as typeof globalThis & { __QAAI_BINDING_CONTEXT__?: QaaiBindingContext }).__QAAI_BINDING_CONTEXT__;
  if (globalContext && typeof globalContext === 'object') return globalContext;
  const raw = process.env.QAAI_BINDING_CONTEXT;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as QaaiBindingContext;
  } catch (error) {
    throw new Error('QAAI binding context: QAAI_BINDING_CONTEXT must be valid JSON: ' + String((error as Error)?.message || error));
  }
  throw new Error('QAAI binding context: QAAI_BINDING_CONTEXT must contain a JSON object');
}

export function missingBindingValue(kind: string, key: string): never {
  throw new Error('QAAI binding ' + kind + ': required value "' + key + '" is unavailable');
}

export function readRuntimeOutput(key: string): any {
  const value = qaaiBindingContext().runtimeOutputs?.[key];
  if (value == null) return missingBindingValue('runtime_output', key);
  return value;
}

export function readDependencyOutput(dependencyCaseId: string, key: string): any {
  const value = qaaiBindingContext().dependencyOutputs?.[dependencyCaseId]?.[key];
  if (value == null) return missingBindingValue('dependency_output', dependencyCaseId + '.' + key);
  return value;
}

function canonicalBindingSeed(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalBindingSeed).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value as Record<string, unknown>).sort().map((key) => JSON.stringify(key) + ':' + canonicalBindingSeed((value as Record<string, unknown>)[key])).join(',') + '}';
  }
  return JSON.stringify(value) ?? String(value);
}

export function generateDeterministicValue(contract: GeneratedValueContract = {}): string {
  const prefix = contract.prefix == null ? '' : String(contract.prefix);
  const requestedLength = Number(contract.length);
  const length = Number.isFinite(requestedLength) && requestedLength > 0 ? Math.floor(requestedLength) : 12;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const seed = canonicalBindingSeed(contract);
  let state = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 16777619) >>> 0;
  }
  let generated = '';
  for (let index = 0; index < length; index += 1) {
    state ^= index + 1;
    state = Math.imul(state, 16777619) >>> 0;
    generated += alphabet[state % alphabet.length];
  }
  return prefix + generated;
}

export function readData(row: DataRow, key: string, options: ReadDataOptions = {}): any {
  const required = options.required !== false;
  const type = options.type || 'string';
  const raw = row?.fields?.[key];
  const label = row?.label || 'data row';
  const explicitBlank = raw === '<empty>' || raw === '<blank>' || raw === '<null>';
  if (raw == null || raw === '' || explicitBlank) {
    if (!required) return options.defaultValue ?? (type === 'number' ? 0 : type === 'boolean' ? false : '');
    if (explicitBlank && type === 'string') return '';
    throw new Error(\`QAAI data contract: required field "\${key}" is empty for \${label}\`);
  }
  const value = String(raw).trim();
  if (type === 'number') {
    const normalized = value.replace(/,/g, '');
    const num = Number(normalized);
    if (!Number.isFinite(num)) throw new Error(\`QAAI data contract: field "\${key}" for \${label} must be numeric, got "\${value}"\`);
    return num;
  }
  if (type === 'boolean') {
    if (/^(true|1|yes|y)$/i.test(value)) return true;
    if (/^(false|0|no|n)$/i.test(value)) return false;
    throw new Error(\`QAAI data contract: field "\${key}" for \${label} must be boolean, got "\${value}"\`);
  }
  return value;
}

export function loadDataRows(relPath: string): DataRow[] {
  const full = path.resolve(process.cwd(), relPath);
  const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(\`Data file \${relPath} must contain an array of rows\`);
  return parsed as DataRow[];
}

export async function resolveLocator(page: Page, candidates: LocatorCandidate[], label: string): Promise<Locator> {
  const errors: string[] = [];
  for (const c of candidates) {
    let locator: Locator | null = null;
    if (c.strategy === 'role' && c.role && c.name && String(c.name).trim()) locator = page.getByRole(c.role, { name: c.name });
    if (c.strategy === 'css' && c.selector) locator = page.locator(c.selector);
    if (c.strategy === 'testId' && c.testId) locator = page.getByTestId(c.testId);
    if (c.strategy === 'text' && c.text) locator = page.getByText(c.text);
    if (c.strategy === 'placeholder' && c.text) locator = page.getByPlaceholder(c.text);
    if (c.strategy === 'label' && c.text) locator = page.getByLabel(c.text);
    if (!locator) {
      errors.push(\`unsupported candidate \${JSON.stringify(c)}\`);
      continue;
    }
    await locator.waitFor({ state: 'attached', timeout: 12000 }).catch(() => {});
    const count = await locator.count().catch(() => 0);
    if (count === 1) {
      if (await locator.isVisible({ timeout: 750 }).catch(() => false)) return locator;
      errors.push(\`candidate matched one non-visible element: \${JSON.stringify(c)}\`);
      continue;
    }
    if (count > 1) {
      if (c.strategy === 'role' && c.role && c.name) {
        const exactL = page.getByRole(c.role, { name: c.name, exact: true });
        const exactN = await exactL.count().catch(() => 0);
        if (exactN === 1 && await exactL.isVisible({ timeout: 750 }).catch(() => false)) return exactL;
        if (exactN !== 1) {
          const lname = c.name.toLowerCase();
          const prefixFiltered = [];
          for (let idx = 0; idx < count; idx++) {
            const acc = await locator.nth(idx).evaluate((el) => {
              return (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/^\\W+/, '').toLowerCase();
            }).catch(() => '');
            if (acc === lname) prefixFiltered.push(idx);
          }
          if (prefixFiltered.length === 1 && await locator.nth(prefixFiltered[0]).isVisible({ timeout: 750 }).catch(() => false)) {
            return locator.nth(prefixFiltered[0]);
          }
        }
      }
      const context = (c.contextText || []).map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
      if (context.length) {
        const scoped: number[] = [];
        for (let index = 0; index < count; index += 1) {
          const ok = await locator.nth(index).evaluate((el, expected) => {
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
        if (scoped.length === 1) return locator.nth(scoped[0]);
        errors.push(\`candidate context narrowed to \${scoped.length} of \${count} matches for \${JSON.stringify(c)}\`);
        continue;
      }
      errors.push(\`candidate ambiguous: matched \${count} elements for \${JSON.stringify(c)}\`);
      continue;
    }
    if (count === 0 && c.strategy === 'role' && c.role && c.name) {
      const ctxItems = (c.contextText || []).map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
      if (ctxItems.length) {
        const roleAny = page.getByRole(c.role);
        const roleAnyCount = await roleAny.count().catch(() => 0);
        if (roleAnyCount > 0 && roleAnyCount <= 30) {
          const sibMatch: number[] = [];
          for (let i = 0; i < roleAnyCount; i++) {
            const matched = await roleAny.nth(i).evaluate((el, ctx) => {
              let node: Element | null = el;
              for (let depth = 0; node && depth < 8; depth++) {
                if (node.parentElement) {
                  for (const sib of node.parentElement.children) {
                    if (sib === node) continue;
                    const attrs = [
                      sib.getAttribute('placeholder'),
                      sib.getAttribute('aria-label'),
                      sib.getAttribute('title'),
                      sib.getAttribute('name')
                    ].filter(Boolean).join(' ').toLowerCase();
                    if ((ctx as string[]).some((c) => attrs.includes(c))) return true;
                  }
                }
                node = node.parentElement;
              }
              return false;
            }, ctxItems).catch(() => false);
            if (matched) sibMatch.push(i);
          }
          if (sibMatch.length === 1) {
            const el = roleAny.nth(sibMatch[0]);
            if (await el.isVisible({ timeout: 750 }).catch(() => false)) return el;
          }
        }
      }
    }
    errors.push(\`candidate matched \${count}: \${JSON.stringify(c)}\`);
  }
  throw new Error(\`Unable to resolve \${label}: \${errors.join('; ')}\`);
}

export async function assertTextPresent(page: Page, text: string, _hint: string, timeoutMs: number): Promise<void> {
  const expected = String(text);
  const matches = page.getByText(expected, { exact: false });
  await expect.poll(async () => {
    const count = await matches.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      if (await matches.nth(index).isVisible().catch(() => false)) return true;
    }
    return false;
  }, {
    timeout: timeoutMs,
    message: 'Expected visible rendered text "' + expected + '" anywhere on the page.',
  }).toBe(true);
}

export async function assertScopedText(page: Page, selector: string, text: string, timeoutMs: number): Promise<void> {
  const scope = page.locator(selector);
  await expect(scope, 'assertion scope must exist before checking text').not.toHaveCount(0, { timeout: timeoutMs });
  await expect(scope.filter({ hasText: String(text) }), 'scoped assertion text must appear inside the recorded container').not.toHaveCount(0, { timeout: timeoutMs });
}

export async function dismissKnownPopups(page: Page, candidates: LocatorCandidate[]): Promise<void> {
  for (const c of candidates) {
    const locator = await resolveLocator(page, [c], 'known popup').catch(() => null);
    if (locator && await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
      await locator.click();
    }
  }
}

async function dismissCommonOverlays(page: Page): Promise<void> {
  await page.keyboard.press('Escape').catch(() => {});
  const closeByRole = page.getByRole('button', { name: /^(close|dismiss|no thanks|not now|skip|×|x)$/i });
  const count = Math.min(await closeByRole.count().catch(() => 0), 5);
  for (let i = 0; i < count; i += 1) {
    const btn = closeByRole.nth(i);
    if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
      await btn.click({ timeout: 1000 }).catch(() => {});
    }
  }
}

export async function safeClick(page: Page, locator: Locator, popupCandidates: LocatorCandidate[] = []): Promise<void> {
  try {
    await locator.click();
    return;
  } catch (err) {
    const message = String((err as Error)?.message || err || '');
    if (!/intercept|obscur|covered|receives pointer events|not visible|detached|timeout/i.test(message)) throw err;
    await dismissKnownPopups(page, popupCandidates).catch(() => {});
    await dismissCommonOverlays(page).catch(() => {});
    await locator.click();
  }
}

export async function safeFill(page: Page, locator: Locator, value: unknown, popupCandidates: LocatorCandidate[] = []): Promise<void> {
  const text = value == null ? '' : String(value);
  try {
    await locator.fill(text);
    return;
  } catch (err) {
    const message = String((err as Error)?.message || err || '');
    if (!/intercept|obscur|covered|not visible|detached|timeout|editable|focus/i.test(message)) throw err;
    await dismissKnownPopups(page, popupCandidates).catch(() => {});
    await dismissCommonOverlays(page).catch(() => {});
    await locator.fill(text);
  }
}

// Impact ladder — violations at or above the minimum level fail the test.
const _A11Y_IMPACT: Record<string, number> = { minor: 0, moderate: 1, serious: 2, critical: 3 };

export async function checkAccessibility(page: Page, minImpact: string = 'critical'): Promise<void> {
  const minLevel = _A11Y_IMPACT[minImpact] ?? 3;
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations.filter(
    (v) => (_A11Y_IMPACT[v.impact ?? 'critical'] ?? 3) >= minLevel
  );
  if (violations.length > 0) {
    const summary = violations.map((v) => \`\${v.id}(\${v.impact}): \${v.description}\`).join('\\n  ');
    throw new Error(\`Accessibility violations [\${violations.length}] at impact >= "\${minImpact}":\\n  \${summary}\`);
  }
}

// EVALUATE fidelity: the live agent observed the page in a SETTLED state. Re-run the recorded
// browser script against a quiesced page and survive a mid-evaluate navigation by retrying once.
// Uses 'load' (not 'networkidle') — networkidle hangs permanently on ad-heavy SPAs that keep
// background trackers running, and resolves before render on fast SPAs. 'load' is deterministic.
export async function evaluateSettled(page: Page, fn: any): Promise<any> {
  await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
  try {
    return await page.evaluate(fn);
  } catch (e: any) {
    if (/Execution context was destroyed|context was destroyed|navigation|detached/i.test(String(e && e.message))) {
      await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
      return await page.evaluate(fn);
    }
    throw e;
  }
}
`;

function displayTitle(ir, opts = {}) {
  return String(
    opts.testTitle ||
      opts.caseName ||
      opts.scenarioName ||
      ir.title ||
      ir.name ||
      ir.caseId ||
      'ReplayIR test',
  ).trim();
}

function emitSetup(ir, opts = {}) {
  const title = displayTitle(ir, opts);
  const rr = opts.runResultId ? `\n// QAAI RunResult: ${opts.runResultId}` : '';
  const tc = opts.testCaseId ? `\n// QAAI TestCase: ${opts.testCaseId}` : '';
  const deps =
    Array.isArray(opts.dependsOn) && opts.dependsOn.length
      ? `\n// DATA DEPENDENCY: Requires data created by: ${opts.dependsOn.join(', ')}` +
        `\n// Run the full suite in order, or ensure prerequisite data exists when running in isolation.`
      : '';
  // When a per-case data file was exported, require it at file scope so emitDataProvider's
  // for-loop can reference testData without re-reading the file on every test iteration.
  const dataRequire = opts.dataCaseSlug
    ? `// eslint-disable-next-line @typescript-eslint/no-var-requires\nconst testData: DataRow[] = require('../data/${opts.dataCaseSlug}.json');\n`
    : '';
  return `import { test, expect } from '@playwright/test';
import { assertTextPresent, assertScopedText, dismissKnownPopups, readEnv, readData, missingBindingValue, readRuntimeOutput, readDependencyOutput, generateDeterministicValue, resolveLocator, checkAccessibility, evaluateSettled, type DataRow } from '../support/replayir';
${dataRequire}${deps}
test.describe(${q(title)}, () => {`;
}

function emitRetryPolicy() {
  return `  test.describe.configure({ mode: 'serial', retries: 1 });`;
}

function emitDataProvider(rows, replayIR, opts = {}) {
  const title = displayTitle(replayIR || {}, opts);
  const titleForTemplate = title.replace(/[`\\]/g, '\\$&').replace(/\$\{/g, '\\${');
  // When a per-case data file was exported, import it at file scope (emitSetup adds the require).
  // The for-loop WRAPS the test() call (Playwright async-loop constraint: the loop must be
  // at describe scope, not inside the test body, so the runner builds the test tree correctly).
  if (opts.dataCaseSlug) {
    rememberExportedDataKeys(opts, rows, true);
    if (opts) opts._emittedDataLoop = false;
    return `  test.each(testData)(\`${titleForTemplate} [Row $index: $label]\`, async ({ page }, row) => {`;
  }
  // Fallback: inline the rows as a literal (no data file — all fields masked, or non-DDT run).
  const dataRows =
    rows && rows.length
      ? rows.map((row) => ({
          index: row.index,
          label: row.label || `Row ${Number(row.index || 0) + 1}`,
          fields: Object.fromEntries(
            Object.entries(row.fields || {}).filter(
              ([, value]) => !isEnvironmentBackedDataValue(value),
            ),
          ),
        }))
      : [{ index: 0, label: 'default', fields: {} }];
  const singleDefault =
    dataRows.length === 1 && String(dataRows[0].label || '').toLowerCase() === 'default';
  // Non-DDT case: single default row with no data fields.
  // Emit a plain test() without a for-loop — no `row` variable exists, which is correct
  // since no step will call readData(row, ...) when there are no dataRole-tagged fills.
  const hasData = dataRows.some((r) => r.fields && Object.keys(r.fields).length > 0);
  if (singleDefault && !hasData) {
    rememberExportedDataKeys(opts, [], false);
    if (opts) opts._emittedDataLoop = false; // signal to emitTeardown
    return `  test(${q(title)}, async ({ page }) => {`;
  }
  rememberExportedDataKeys(opts, dataRows, hasData);
  if (opts) opts._hasDataRows = true;
  if (opts) opts._emittedDataLoop = false;
  return `  const dataRows: DataRow[] = ${JSON.stringify(dataRows, null, 2).replace(/\n/g, '\n  ')};

  test.each<DataRow>(dataRows)(\`${titleForTemplate} [Row $index: $label]\`, async ({ page }, row: DataRow) => {`;
}

function dialogSteps(ir) {
  return ((ir && ir.steps) || []).filter(
    (step) => step && step.op === 'act' && step.action === 'handleDialog',
  );
}

function dialogPlanNames(ir) {
  const suffix = ident((ir && (ir.caseId || ir.title)) || 'case').replace(/[^A-Za-z0-9_$]/g, '_');
  return {
    plan: `_qaaiDialogPlan_${suffix}`,
    handled: `_qaaiDialogHandled_${suffix}`,
  };
}

function emitDialogPrearm(ir, indent = '      ') {
  const dialogs = dialogSteps(ir);
  if (!dialogs.length) return null;
  const names = dialogPlanNames(ir);
  const plan = dialogs.map((step) => ({
    accept: step.accept !== false,
    ...(step.promptText != null ? { promptText: String(step.promptText) } : {}),
  }));
  return [
    `${indent}// QAAI pre-arms recorded dialog decisions before business actions so the generated script runs as-is.`,
    `${indent}const ${names.plan} = ${JSON.stringify(plan)};`,
    `${indent}let ${names.handled} = 0;`,
    `${indent}page.on('dialog', async (dialog) => {`,
    `${indent}  const spec = ${names.plan}[${names.handled}];`,
    `${indent}  if (!spec) { await dialog.dismiss(); return; }`,
    `${indent}  if (spec.accept === false) await dialog.dismiss();`,
    `${indent}  else await dialog.accept(spec.promptText);`,
    `${indent}  ${names.handled} += 1;`,
    `${indent}});`,
  ].join('\n');
}

function emitDialogAcknowledgement(step, ir, indent = '      ') {
  const dialogs = dialogSteps(ir);
  const index = dialogs.indexOf(step);
  if (index < 0) {
    return `${indent}// QAAI_WARNING: This post-trigger dialog record could not be paired with an IR-level pre-arm plan; no listener is armed here, avoiding accidental handling of a later dialog.\n${indent}await Promise.resolve();`;
  }
  const names = dialogPlanNames(ir);
  return `${indent}await expect.poll(() => ${names.handled}, { message: ${q(`Recorded dialog ${index + 1} was not handled`)}, timeout: 10000 }).toBeGreaterThan(${index});`;
}

function emitAuth(authProfile, replayIR) {
  const id = typeof authProfile === 'string' ? authProfile : authProfile && authProfile.id;
  const strategy =
    typeof authProfile === 'object' && authProfile ? authProfile.strategy : 'unknown';
  const state = typeof authProfile === 'object' && authProfile ? authProfile.storageStateRef : null;
  const note = state
    ? `storageState ${state} must be wired in Playwright config`
    : `auth strategy ${strategy} must be wired by the package shell`;
  const prearm = emitDialogPrearm(replayIR);
  return `  // Auth profile ${id || 'unknown'}: ${note}.${prearm ? `\n${prearm}` : ''}`;
}

// Pick the best deterministic Playwright locator from already-normalized candidates.
// Returns a JS expression like "page.getByRole('link', { name: 'Women' })" or null
// when no single strategy is reliable enough for static emission.
function selectStaticCandidate(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  return (
    candidates.find((c) => (c.strategy === 'testId' || c.strategy === 'testid') && c.testId) ||
    candidates.find((c) => c.strategy === 'role' && c.role && c.name && String(c.name).trim()) ||
    candidates.find((c) => c.strategy === 'label' && c.text) ||
    candidates.find((c) => c.strategy === 'placeholder' && c.text) ||
    candidates.find(
      (c) => c.strategy === 'css' && c.selector && !/^getBy/i.test(String(c.selector)),
    ) ||
    candidates.find((c) => c.strategy === 'text' && c.text) ||
    null
  );
}

function selectStaticLocator(candidates) {
  const selected = selectStaticCandidate(candidates);
  if (!selected) return null;
  if (selected.strategy === 'testId' || selected.strategy === 'testid') {
    return `page.getByTestId(${q(selected.testId)})`;
  }
  if (selected.strategy === 'role')
    return `page.getByRole(${q(selected.role)}, { name: ${q(selected.name)} })`;
  if (selected.strategy === 'label') return `page.getByLabel(${q(selected.text)})`;
  if (selected.strategy === 'placeholder') return `page.getByPlaceholder(${q(selected.text)})`;
  if (selected.strategy === 'css') return `page.locator(${q(selected.selector)})`;
  if (selected.strategy === 'text') return `page.getByText(${q(selected.text)}, { exact: true })`;
  return null;
}

function authoredCandidatesForUnverifiedEmission(candidates, step) {
  const authoredLabel = readableAuthoredLabel(step);
  if (!authoredLabel || !Array.isArray(candidates)) return candidates;
  return candidates.map((candidate) => {
    if (!candidate || typeof candidate !== 'object') return candidate;
    if (candidate.strategy === 'role' && candidate.role && candidate.name) {
      return { ...candidate, name: authoredLabel };
    }
    if (['label', 'placeholder', 'text'].includes(candidate.strategy) && candidate.text) {
      return { ...candidate, text: authoredLabel };
    }
    return candidate;
  });
}

function actionLocatorExpression(step) {
  const recipe = step && (step.actionLocator || step.locatorRecipe);
  if (!recipe || typeof recipe !== 'object') return null;
  const primary = actionLocatorResolver.primaryActionLocator(recipe);
  const raw =
    primary?.frameworkExpressions?.playwright ||
    primary?.expression ||
    recipe.frameworkExpressions?.playwright ||
    recipe.expression ||
    null;
  if (!raw || !actionLocatorResolver.locatorExpressionIsExportSafe(raw)) return null;
  const expression = String(raw).trim();
  return {
    expression: /^page\./.test(expression) ? expression : `page.${expression}`,
    verified: actionLocatorResolver.isVerifiedActionLocator(recipe),
    source:
      primary?.verificationSource ||
      primary?.evidenceSource ||
      primary?.proof?.source ||
      recipe.source ||
      'action locator',
  };
}

function emitLocatorResolver(candidates, step, nameOverride, locatorsMap) {
  // FrameworkAdapter.compileReplayIR calls this as (candidates, step, ir, opts).
  // Journey emission calls it as (candidates, step, nameOverride, locatorsMap).
  // Treat only a string third argument as a variable-name override; otherwise the
  // per-case adapter path must fall back to the step's own `as` value.
  const hasNameOverride = typeof nameOverride === 'string' && nameOverride.trim();
  const name = hasNameOverride ? nameOverride : ident(step.as || step.target || 'target');
  // Q1 compliance: ALL locator resolution goes through resolveLocator() (defined in
  // tests/support/replayir). No raw page.getByRole/getByText/page.locator() inline in
  // the spec body — the runtime probe handles icon-prefixed names, strict-mode ambiguity,
  // and multi-strategy fallback transparently.
  const norm = normalizeCandidates(candidates);
  const actionLocator = actionLocatorExpression(step);
  if (actionLocator && actionLocator.verified) {
    return `      const ${name} = ${actionLocator.expression};`;
  }
  // Verified action-time DOM expressions returned above must remain byte-for-byte
  // faithful. Every remaining path is unverified, so keep the complete authored
  // accessible label even when provisional action-locator metadata also exists.
  const emittedCandidates = authoredCandidatesForUnverifiedEmission(norm, step);
  const fallback =
    selectStaticLocator(emittedCandidates) || (actionLocator && actionLocator.expression) || null;
  const warning = `      // QAAI_UNVERIFIED_LOCATOR: This locator came from ${q(actionLocator?.source || (norm.length ? 'an unverified candidate' : 'a semantic guess'))}; live uniqueness and actionability were not verified.\n      // The complete authored step is preserved. Replace only this locator if it does not match the intended element.\n`;
  if (fallback) return `${warning}      const ${name} = ${fallback};`;
  const guess = guessedLocatorForAction(step);
  if (guess) return `${warning}      const ${name} = ${guess.expression};`;
  if (hasNameOverride && locatorsMap) {
    // D2: hoist selector metadata. The caller owns a LOCATORS block; register this
    // entry and emit a LOCATORS.key reference so the candidate JSON is NOT inline
    // in the business steps.
    locatorsMap[name] = emittedCandidates;
    return `${warning}      const ${name} = await resolveLocator(page, LOCATORS.${name}, ${q(labelForCandidates(emittedCandidates))});`;
  }
  return `${warning}      const ${name} = await resolveLocator(page, ${candidateLiteral(emittedCandidates)}, ${q(labelForCandidates(emittedCandidates))});`;
}

function normalizedPlaywrightModifiers(modifiers) {
  const aliases = {
    alt: 'Alt',
    control: 'Control',
    ctrl: 'Control',
    controlormeta: 'ControlOrMeta',
    meta: 'Meta',
    command: 'Meta',
    cmd: 'Meta',
    shift: 'Shift',
  };
  return Array.from(
    new Set(
      (Array.isArray(modifiers) ? modifiers : [])
        .map(
          (value) =>
            aliases[
              String(value || '')
                .replace(/[^a-z]/gi, '')
                .toLowerCase()
            ] || null,
        )
        .filter(Boolean),
    ),
  );
}

function playwrightClickOptions(step, { clickCount = null, allowClickCount = true } = {}) {
  const options = {};
  const button = String((step && step.button) || '').toLowerCase();
  if (['left', 'middle', 'right'].includes(button)) options.button = button;
  const modifiers = normalizedPlaywrightModifiers(step && step.modifiers);
  if (modifiers.length) options.modifiers = modifiers;
  const count = clickCount == null ? Number(step && step.clickCount) : Number(clickCount);
  if (allowClickCount && Number.isFinite(count) && count > 0)
    options.clickCount = Math.floor(count);
  return Object.keys(options).length ? `(${JSON.stringify(options)})` : '()';
}

function recordedArrayExpression(values, fallback) {
  return Array.isArray(values) && values.length ? JSON.stringify(values.map(String)) : fallback;
}

const LOCATOR_ACTIONS = new Set([
  'fill',
  'type',
  'click',
  'doubleClick',
  'tripleClick',
  'selectOption',
  'check',
  'uncheck',
  'press',
  'hover',
  'drag',
  'upload',
]);

function locatorActionLine(step, target, destination, value) {
  if (step.action === 'fill') return `await ${target}.fill(${value});`;
  if (step.action === 'type') return `await ${target}.pressSequentially(${value});`;
  if (step.action === 'click') return `await ${target}.click${playwrightClickOptions(step)};`;
  if (step.action === 'doubleClick')
    return `await ${target}.dblclick${playwrightClickOptions(step, { allowClickCount: false })};`;
  if (step.action === 'tripleClick')
    return `await ${target}.click${playwrightClickOptions(step, { clickCount: 3 })};`;
  if (step.action === 'selectOption')
    return `await ${target}.selectOption(${recordedArrayExpression(step.optionValues, value)});`;
  if (step.action === 'check') return `await ${target}.check();`;
  if (step.action === 'uncheck') return `await ${target}.uncheck();`;
  if (step.action === 'press') return `await ${target}.press(${value});`;
  if (step.action === 'hover') return `await ${target}.hover();`;
  if (step.action === 'drag') return `await ${target}.dragTo(${destination});`;
  if (step.action === 'upload')
    return `await ${target}.setInputFiles(${recordedArrayExpression(step.filePaths, value)});`;
  return null;
}

function missingActionValue(step) {
  return (
    ['fill', 'type', 'selectOption', 'press', 'upload'].includes(
      String((step && step.action) || ''),
    ) &&
    step &&
    step.rawValue == null &&
    !step.valueRef &&
    !step.valueBinding &&
    !(Array.isArray(step.optionValues) && step.optionValues.length) &&
    !(Array.isArray(step.filePaths) && step.filePaths.length)
  );
}

function isObservedNavigation(step) {
  const source = String(
    (step &&
      (step.navigationKind ||
        step.navigationSource ||
        step.transitionSource ||
        step.provenance?.kind ||
        step.metadata?.navigationKind)) ||
      '',
  )
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return (
    !!(step && (step.contextSwitchInferred || step.observedOnly || step.authored === false)) ||
    [
      'observed_redirect',
      'browser_redirect',
      'runtime_observation',
      'popup_destination',
      'inferred_transition',
    ].includes(source)
  );
}

function isPopupObservedNavigation(step) {
  const sources = [
    step,
    step && step.metadata,
    step && step.provenance,
    step && step.navigation,
  ].filter((value) => value && typeof value === 'object');
  return sources.some(
    (value) =>
      value.popupIdentity ||
      value.popup === true ||
      value.newTab === true ||
      ['popup', 'popup_context', 'popup_destination', 'new_tab', 'newtab'].includes(
        String(value.navigationKind || value.transitionKind || value.kind || '').toLowerCase(),
      ),
  );
}

function nonAuthoredActionEvidence(step) {
  const action = String((step && step.action) || 'runtime operation');
  const identity =
    (step && (step.contractStepId || step.sourceContractStepId)) || 'unmatched runtime operation';
  const detail = `Observed ${action} evidence (${identity}) was not replayed because it had no exact authored contract identity and operation match.`;
  return `      test.info().annotations.push({ type: 'qaai-runtime-evidence', description: ${q(detail)} });`;
}

function stableObservedPath(url) {
  try {
    const parsed = new URL(String(url || ''), 'https://qaai.invalid');
    return parsed.pathname || '/';
  } catch {
    return String(url || '').replace(/[?#].*$/, '') || '/';
  }
}

function emitStep(step, originalCandidates, asToSemantic, loopOpts) {
  const target = (asToSemantic && asToSemantic[step.target]) || ident(step.target || 'target');
  const destination =
    (asToSemantic && asToSemantic[step.destinationTarget]) ||
    ident(step.destinationTarget || 'destination');
  if (step && step.authored === false && step.action !== 'navigate')
    return nonAuthoredActionEvidence(step);
  const replayIR =
    originalCandidates && Array.isArray(originalCandidates.steps)
      ? originalCandidates
      : (loopOpts && loopOpts.replayIR) || null;
  // readData(row, role) requires a data loop (test.each / for-of) to be in scope.
  // In the journey path there is no loop — loopOpts.hasDataLoop === false.
  // In the framework DDT path asToSemantic === opts and opts._emittedDataLoop tracks the loop.
  // Fall back to valueExpression when no loop is active; readData without row is a crash.
  const context = loopOpts
    ? dataContext({
        hasDataLoop: loopOpts.hasDataLoop !== false,
        dataRow: loopOpts.dataRow,
        dataRows: loopOpts.dataRows,
        bindingMetadata: loopOpts.bindingMetadata,
        caseId: loopOpts.caseId || loopOpts.testCaseId,
      })
    : dataContext(originalCandidates, asToSemantic);
  const requestedRole = explicitDataRole(step);
  const rowKey = context.hasDataLoop ? exportedDataKey(context.keys, requestedRole) : null;
  const typedValue = typedBindingExpression(step, step && step.valueBinding, context, 'value');
  const value =
    typedValue ||
    (isEnvironmentValueRef(step && step.valueRef)
      ? valueExpression(step)
      : rowKey
        ? `readData(row, ${q(rowKey)})`
        : valueExpression(step));
  if (step.action === 'navigate') {
    if (isObservedNavigation(step)) {
      const expectedPath = stableObservedPath(step.url || '');
      const popup = isPopupObservedNavigation(step);
      const detail = popup
        ? 'Observed popup/new-tab context switch retained as non-authored evidence; QAAI waits for the observed destination and does not invent a second navigation.'
        : 'Observed browser transition retained as evidence; no direct navigation was invented because this transition was not authored.';
      return `      test.info().annotations.push({ type: ${q(popup ? 'qaai-observed-popup' : 'qaai-observed-navigation')}, description: ${q(detail)} });\n      await page.waitForURL(new RegExp(${q(escapeRegex(expectedPath))}), { timeout: ${timeout(step, 10000)} }).catch(() => {});`;
    }
    // T5.4: emit relative path against QAAI_TARGET_URL so the exported spec is
    // environment-agnostic (staging / prod / local all work without editing URLs).
    // All QAAI navigations are within the project's target app — cross-origin navigates
    // are not a supported scenario so stripping the origin is always safe here.
    let gotoArg;
    try {
      const parsed = new URL(step.url || '');
      const rel = parsed.pathname + parsed.search + parsed.hash;
      gotoArg = `readEnv('QAAI_TARGET_URL') + ${q(rel)}`;
    } catch (_) {
      // Malformed or relative URL — keep as-is
      gotoArg = q(step.url || '');
    }
    // A logout / redirect endpoint immediately 302s elsewhere; the default goto waits for
    // 'load' on the ORIGINAL url and throws net::ERR_ABORTED when the redirect supersedes it.
    // For such navigations commit early and swallow only the benign redirect-abort.
    if (step.redirectExpected) {
      return `      await page.goto(${gotoArg}, { waitUntil: 'commit' }).catch((e) => { if (!String(e && e.message).includes('ERR_ABORTED')) throw e; });`;
    }
    return `      await page.goto(${gotoArg});`;
  }
  if (step.action === 'navigateBack') return `      await page.goBack();`;
  if (step.action === 'navigateForward') return `      await page.goForward();`;
  if (LOCATOR_ACTIONS.has(step.action)) {
    if (missingActionValue(step)) {
      return qaaiFallback(
        'ACTION',
        `Authored ${step.action} step has no executable value. Supply the intended test data; later independent steps will still run.`,
      );
    }
    const targetCandidates = candidatesForActionReference(originalCandidates, step.target);
    const targetMapped = !!(
      step.target &&
      asToSemantic &&
      Object.prototype.hasOwnProperty.call(asToSemantic, step.target)
    );
    const destinationCandidates =
      step.action === 'drag'
        ? candidatesForActionReference(originalCandidates, step.destinationTarget)
        : [];
    const destinationMapped =
      step.action !== 'drag' ||
      !!(
        step.destinationTarget &&
        asToSemantic &&
        Object.prototype.hasOwnProperty.call(asToSemantic, step.destinationTarget)
      );
    const needsTargetGuess = !targetMapped && targetCandidates.length === 0;
    const needsDestinationGuess =
      step.action === 'drag' && !destinationMapped && destinationCandidates.length === 0;
    if (needsTargetGuess || needsDestinationGuess) {
      const guessedTarget = needsTargetGuess ? guessedLocatorForAction(step) : null;
      const guessedDestination = needsDestinationGuess ? guessedLocatorForAction(step, true) : null;
      if (guessedTarget && guessedDestination && guessedTarget.name === guessedDestination.name) {
        guessedDestination.name = `${guessedDestination.name}Destination`;
      }
      const targetName = guessedTarget ? guessedTarget.name : target;
      const destinationName = guessedDestination ? guessedDestination.name : destination;
      const actionLine = locatorActionLine(step, targetName, destinationName, value);
      const declarations = [guessedTarget, guessedDestination]
        .filter(Boolean)
        .map((guess) =>
          [
            '        // QAAI_GUESSED_LOCATOR: No reliable action-time DOM locator was captured for this authored step.',
            '        // Replace this semantic guess with a verified DOM locator if it does not match the intended element.',
            `        const ${guess.name} = ${guess.expression};`,
          ].join('\n'),
        );
      return `      {\n${declarations.join('\n')}\n        ${actionLine}\n      }`;
    }
    return `      ${locatorActionLine(step, target, destination, value)}`;
  }
  if (step.action === 'handleDialog') return emitDialogAcknowledgement(step, replayIR);
  if (step.action === 'resize') {
    const width =
      Number.isFinite(Number(step.width)) && Number(step.width) > 0
        ? Math.floor(Number(step.width))
        : 1280;
    const height =
      Number.isFinite(Number(step.height)) && Number(step.height) > 0
        ? Math.floor(Number(step.height))
        : 720;
    const warning =
      step.width && step.height
        ? ''
        : '      // QAAI_WARNING: The recorded viewport was incomplete; using the executable 1280x720 fallback.\n';
    return `${warning}      await page.setViewportSize({ width: ${width}, height: ${height} });`;
  }
  if (step.action === 'close') return `      await page.close();`;
  return qaaiFallback(
    'ACTION',
    `Playwright cannot represent the authored action "${step.action || 'unspecified'}" exactly. The step was retained as an explicit failure and later independent steps will continue.`,
  );
}

function emitWait(condition, asToSemantic) {
  const c = condition || {};
  if (c.kind === 'url' && c.pattern) {
    const rawPattern = String(c.pattern || '');
    const match = rawPattern.match(/(\/[a-zA-Z0-9_\-\/]+)/);
    if (match)
      return emitWaitWithReloadRecovery(
        c,
        (timeoutExpression) =>
          `await page.waitForURL(${q(`**${match[1]}`)}, { timeout: ${timeoutExpression} });`,
      );
    const pattern = rawPattern;
    // If the pattern looks like a glob or contains query params, prefer a RegExp
    if (pattern.includes('*') || pattern.includes('=') || pattern.includes('?')) {
      // convert simple glob-ish pattern to a regex snippet
      const body = pattern.replace(/^[*]+/, '').replace(/[*]+$/, '').replace(/\*+/g, '.*');
      const escaped = body.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      return emitWaitWithReloadRecovery(
        c,
        (timeoutExpression) =>
          `await page.waitForURL(new RegExp(${q(escaped)}), { timeout: ${timeoutExpression} });`,
      );
    }
    return emitWaitWithReloadRecovery(
      c,
      (timeoutExpression) =>
        `await page.waitForURL(${q(pattern)}, { timeout: ${timeoutExpression} });`,
    );
  }
  if (c.kind === 'visible' && c.target) {
    const targetName = (asToSemantic && asToSemantic[c.target]) || ident(c.target);
    return emitWaitWithReloadRecovery(
      c,
      (timeoutExpression) =>
        `await ${targetName}.waitFor({ state: 'visible', timeout: ${timeoutExpression} });`,
    );
  }
  if (c.kind === 'networkidle') {
    // networkidle hangs permanently on ad-heavy SPAs and resolves before render on fast SPAs.
    // 'load' is deterministic (fires once when all resources are fetched) and survives both.
    if (reloadRecovery(c, timeout(c, 15000))) {
      return emitWaitWithReloadRecovery(
        c,
        (timeoutExpression) =>
          `await page.waitForLoadState('load', { timeout: ${timeoutExpression} });`,
        15000,
      );
    }
    return `      await page.waitForLoadState('load', { timeout: ${timeout(c, 15000)} }).catch(() => {});`;
  }
  return qaaiFallback(
    'WAIT',
    `Playwright cannot represent the authored wait condition "${c.kind || 'unspecified'}" exactly. The wait remains visible as a failed step and later independent steps will continue.`,
  );
}

function emitPopupHandling(known) {
  return `      await dismissKnownPopups(page, ${candidateLiteral(known)});`;
}

// A recorded browser_evaluate script must run IN THE BROWSER (as it did under MCP),
// never eagerly in the Node test process. Interpolating it bare —
// `page.evaluate(${script})` — parses the script as a Node expression, so any browser
// global (document/window/...) throws ReferenceError before the browser is ever asked:
// a crash that was NEVER in the live run. Wrap it so Playwright ships it to the page.
// Generic over the script's syntactic shape only (never any site/page string):
//   - already a function literal (arrow / function) → pass through unchanged
//   - statements containing `return`              → `() => { <script> }`
//   - a bare expression                           → `() => (<script>)`
function evaluateArg(script) {
  const s = String(script == null ? '' : script).trim();
  if (!s) return '() => undefined';
  // An IIFE — (function(){…return…})() or (()=>{…})() — is an EXPRESSION whose `return` is
  // NESTED and which the arrow-`isFn` pattern would wrongly match (then eager-eval in Node) or
  // the `() => { … }` branch would run-and-discard (→ undefined). Detect it FIRST (ends with
  // `)()`) and wrap to RETURN its value. Regression: run bc723b73 emitted both shapes.
  if (/^\(/.test(s) && /\)\s*\(\s*\)\s*;?$/.test(s)) return `() => (${s.replace(/;\s*$/, '')})`;
  const isFn =
    /^\s*(async\s+)?function\b/.test(s) ||
    /^\s*(async\s*)?\([^)]*\)\s*=>/.test(s) ||
    /^\s*(async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(s);
  if (isFn) return s;
  if (/\breturn\b/.test(s)) return `() => { ${s} }`;
  return `() => (${s})`;
}

function readDataExpr(role, type = 'string', context = {}, fallback = null) {
  const rowKey = context.hasDataLoop ? exportedDataKey(context.keys, role) : null;
  if (rowKey) return `readData(row, ${q(rowKey)}, { type: ${q(type)} })`;
  if (fallback != null) return q(fallback);
  return type === 'number' ? '0' : "''";
}

function emitDomainAssertion(step, ms, context = {}) {
  // Website/domain assertions are lowered from their canonical target, scope and
  // expected value. The universal adapter never maps a business-domain label to a
  // hardcoded selector or helper.
  return null;
}

function emitAssertionCore(step, replayOrContext = false, opts = {}) {
  const context =
    typeof replayOrContext === 'boolean'
      ? { hasDataLoop: false, keys: new Map() }
      : dataContext(replayOrContext, opts);
  // AS-IS verdict fidelity.
  //   'matched'     → fall through to the hard assert below (verified live — should pass)
  //   'uncheckable' → executable soft failure with a plain-language annotation; later
  //                   independent steps still run, but the missing check is never hidden.
  //   'not_matched' + must → fall through to hard assert; the live case failed and the export
  //                   must reproduce that failure (L2 fidelity).
  //   'not_matched' + non-must → soft-fail the step and continue later independent steps.
  if (step.liveOutcome === 'uncheckable') {
    const detail = `${step.channel || 'assert'}: QAAI could not reproduce this authored check from the captured evidence. The soft assertion records the failed check and allows later independent steps to continue.`;
    return `      test.info().annotations.push({ type: 'qaai-uncheckable', description: ${q(detail.replace(/\s+/g, ' ').trim())} });
      expect.soft(false, ${q(detail.replace(/\s+/g, ' ').trim())}).toBe(true);`;
  }
  // domGrounded:false — the live assertion matched only via browser_evaluate cache or
  // semantic/vector rescue, NOT by finding the literal text in the ARIA snapshot.
  // assertTextPresent would search the live DOM and fail (the text isn't there as a
  // normal DOM node). Emit uncheckable: the live run verified the intent, the export
  // cannot reproduce the exact mechanism. Only applies to text channels.
  if (
    step.liveDomGrounded === false &&
    (step.channel === 'UI_TEXT' || step.channel === 'FORBIDDEN_TEXT')
  ) {
    const rawText = (step.expected || '').slice(0, 80);
    const detail = `${step.channel}: "${rawText}" matched in live run via browser_evaluate cache or semantic rescue — text is not directly findable in the page DOM by Playwright locators. Re-calibrate to ground this assertion against literal page text.`;
    return `      test.info().annotations.push({ type: 'qaai-uncheckable', description: ${q(detail.replace(/\s+/g, ' ').trim())} });
      expect.soft(false, ${q(detail.replace(/\s+/g, ' ').trim())}).toBe(true);`;
  }
  // not_matched + non-must: the live case still PASSED (degraded pass — the verdict layer
  // demoted the miss because criticality < must). Emitting a hard expect() here would make
  // the export fail when the live run passed — an L3 artifact. Record the miss as an
  // soft assertion so the mismatch remains visible without stopping the remaining flow.
  if (
    step.liveOutcome === 'not_matched' &&
    step.criticality &&
    step.criticality !== 'must' &&
    !isFlowCriticalAssertion(step)
  ) {
    const miss = `${step.channel || 'assert'}: "${String(step.expected || '').slice(0, 80)}" did not match in the live run (${step.criticality} tier). QAAI records this step as failed but continues later independent steps.`;
    return `      test.info().annotations.push({ type: 'qaai-soft-failure', description: ${q(miss)} });
      expect.soft(false, ${q(miss)}).toBe(true);`;
  }
  // Priority: data-row reference > env-ref > hardcoded literal.
  // dataExpected: assertion expected value came from a DDT data row fill — emit
  //   readData(row, role) so each iteration asserts the correct value for that row.
  // expectedRef: expected value came from a credential/env fill — emit readEnv(key).
  // Otherwise: inline the recorded literal.
  const expectedRefIsEnvironment =
    step.expectedRef && step.channel !== 'URL' && isEnvironmentValueRef(step.expectedRef);
  const requestedExpectedKey =
    step.dataExpected ||
    (step.dataBinding && step.dataBinding.expectedColumn) ||
    dataRoleFromRef(step.expectedRef);
  const exportedExpectedKey = context.hasDataLoop
    ? exportedDataKey(context.keys, requestedExpectedKey)
    : null;
  const typedExpected = typedBindingExpression(step, step.expectedBinding, context, 'expected');
  const expected =
    typedExpected ||
    (expectedRefIsEnvironment
      ? `readEnv(${q(envKeyFromRef(step.expectedRef, 'QAAI_EXPECTED'))})`
      : exportedExpectedKey
        ? `readData(row, ${q(exportedExpectedKey)})`
        : q(step.expected));
  const ms = timeout(step, 10000);
  const domainAssertion = emitDomainAssertion(step, ms, context);
  if (domainAssertion) return domainAssertion;
  if (step.channel === 'A11Y') {
    const impact = String(step.expected || 'critical').toLowerCase();
    const safeImpact = ['minor', 'moderate', 'serious', 'critical'].includes(impact)
      ? impact
      : 'critical';
    return `      await checkAccessibility(page, ${q(safeImpact)});`;
  }
  if (step.channel === 'PERFORMANCE') {
    const threshold = Number(step.expected) || 3000;
    return `      { const _navMs = await page.evaluate(() => { try { const e = window.performance.getEntriesByType('navigation')[0]; return e ? Math.round(e.loadEventEnd) : -1; } catch(_) { return -1; } }).catch(() => -1); if (_navMs >= 0) { test.info().annotations.push({ type: 'perf:load', description: \`page load: \${_navMs}ms (budget: ${threshold}ms)\` }); expect(_navMs, ${q(`Page load time (ms) — budget ${threshold}ms`)}).toBeLessThan(${threshold}); } else { test.info().annotations.push({ type: 'perf:unavailable', description: 'Navigation Timing API not available on this page' }); } }`;
  }
  // EVALUATE: the Architect emitted a browser_evaluate assertion (payload.script + expectedReturn).
  // Emit page.evaluate(script) and assert the result matches the expected return value.
  // When no script is stored (old runs emitted before the script threading fix), fall back to
  // a soft annotation so the test doesn't hard-fail on an infrastructure gap.
  if (step.channel === 'EVALUATE') {
    if (step.script) {
      // Normalize .textContent?/.textContent comparisons to be case-insensitive.
      // The live agent matched semantically via MCP; DOM-inspect scripts are case-sensitive
      // and cause L3 artifacts when site capitalization differs from the declaration.
      // Keyed off the DOM pattern only — not string comparisons elsewhere in the script.
      // Normalize .textContent?/.textContent comparisons to be case-insensitive.
      // The live agent matched semantically via MCP; DOM-inspect scripts are case-sensitive
      // and cause L3 artifacts when site capitalization differs from the declaration.
      const normalizedScript = String(step.script)
        .replace(/\.textContent\?\.includes\s*\(/g, '.textContent?.toLowerCase().includes(')
        .replace(/\.textContent\.includes\s*\(/g, '.textContent.toLowerCase().includes(');
      const expectedStr = step.expected != null ? q(String(step.expected)) : 'null';
      const expectsTrue = step.expected === 'true' || step.expected === true;
      // When the expected result is "true", prefer assertTextPresent: assertion_check is a
      // SYNTHETIC tool that verifies against the ARIA snapshot (text search), NOT by executing
      // the authored CSS selector in the browser. The CSS selector may use attribute patterns
      // (input[name=...]) that don't match the site's actual DOM, causing L3 artifacts.
      // Generic rule: extract the text from the .includes('...') call in the script (the value
      // the live agent was checking for) and use assertTextPresent — identical fidelity to
      // what assertion_check does at runtime.
      if (expectsTrue) {
        // Extract the comparison text from .textContent...toLowerCase().includes('...') only.
        // Generic rule: assertTextPresent matches how assertion_check works (ARIA snapshot text search).
        // IMPORTANT: only apply to POSITIVE textContent checks — negated scripts (!expr) verify ABSENCE
        // of a value in the DOM and must use waitForFunction (which correctly returns `!null = true`
        // when the element isn't there). Detect negation by:
        //   1. Script starts with bare `!` (but not `!!` double-negation = positive coercion)
        //   2. Script contains `return !variable` — the .includes() result is assigned to a
        //      variable that the function then returns negated (e.g. XSS check: injected = .some(s
        //      => s.textContent.includes('alert') && !s.src); return !injected → the includes()
        //      fires when alert IS present; the script returns true when it's ABSENT. assertText
        //      would search for "alert" presence and fail correctly — but for the wrong reason).
        const _textContentMatch = normalizedScript.match(
          /\.toLowerCase\(\)\.includes\(\s*['"]([^'"]+)['"]\s*\)/,
        );
        const _compareText = _textContentMatch ? _textContentMatch[1] : null;
        const _isNegated =
          /^!(?!!)/.test(normalizedScript.trim()) || /\breturn\s+!(?!!)/.test(normalizedScript);
        if (_compareText && !_isNegated) {
          return `      await assertTextPresent(page, ${q(_compareText)}, '', ${ms});`;
        }
        // Negated check or no extractable text — fall back to waitForFunction (best-effort).
        return `      {
        await page.waitForFunction(${evaluateArg(normalizedScript)}, null, { timeout: ${ms} }).catch((e) => {
          throw new Error(\`EVALUATE: expected "true" but condition never became truthy within ${ms}ms — \${e.message}\`);
        });
        test.info().annotations.push({ type: 'evaluate-result', description: 'evaluate: true (waitForFunction)' });
      }`;
      }
      return `      {
        const _evalResult = String(await evaluateSettled(page, ${evaluateArg(normalizedScript)}).catch((e) => \`EVALUATE_ERROR:\${e.message}\`));
        test.info().annotations.push({ type: 'evaluate-result', description: \`evaluate: \${_evalResult}\` });
        ${expectedStr !== 'null' ? `expect(_evalResult, ${q(`EVALUATE: expected "${step.expected}"`)}).toContain(${expectedStr});` : `expect(_evalResult, 'EVALUATE: must not error').not.toMatch(/^EVALUATE_ERROR:/);`}
      }`;
    }
    // No script stored: record an executable soft failure so the authored assertion is
    // never silently omitted, while later independent steps can still execute.
    const missingScript = `${step.channel} — evaluation script was not captured; QAAI could not execute this assertion`;
    return `      test.info().annotations.push({ type: 'evaluate-missing', description: ${q(missingScript)} });
      expect.soft(false, ${q(missingScript)}).toBe(true);`;
  }
  if (
    ['API', 'DB_READ', 'EMAIL_SMS', 'DOWNLOAD', 'PDF', 'AUDIT_LOG', 'ASYNC_JOB'].includes(
      step.channel,
    )
  ) {
    return qaaiFallback(
      'ASSERTION',
      `${step.channel} assertion needs a project-specific runtime connector and cannot be executed exactly by the browser-only Playwright adapter. The authored check remains failed and later independent steps will continue.`,
    );
  }
  if (step.channel === 'URL') {
    return `      await expect(page).toHaveURL(new RegExp(${expected}), { timeout: ${ms} });`;
  }
  // No element was resolved for this assertion (the IR oracle is page-level text, not an element)
  // → assert against the PAGE, matching BDD/Selenium. Referencing an undeclared `target` here was
  // a P7-collection-only blind spot P8 execution exposed.
  if (!step.target) {
    if (step.channel === 'FORBIDDEN_TEXT' || step.channel === 'FORBIDDEN_ROLE') {
      if (step.scope?.selector) {
        return `      await expect(page.locator(${q(step.scope.selector)}).getByText(${expected}, { exact: false })).toHaveCount(0, { timeout: ${ms} });`;
      }
      return `      await expect(page.getByText(${expected}, { exact: false })).toHaveCount(0);`;
    }
    if (
      (step.expected == null || step.expected === '') &&
      !step.dataExpected &&
      !(step.expectedRef && step.channel !== 'URL')
    ) {
      const expectedColumn =
        context.hasDataLoop && step.dataBinding && step.dataBinding.expectedColumn
          ? exportedDataKey(context.keys, step.dataBinding.expectedColumn)
          : null;
      if (expectedColumn) {
        if (step.channel === 'PAGE' || step.channel === 'URL') {
          return `      { const expectedValue = readData(row, ${q(expectedColumn)}); if (/^https?:\\/\\//i.test(String(expectedValue || '')) || /^\\//.test(String(expectedValue || ''))) { await expect(page).toHaveURL(new RegExp(String(expectedValue || '.*'))); } else { await expect(page.getByText(String(expectedValue || ''), { exact: false })).toBeVisible(); } }`;
        }
        return `      await expect(page.getByText(String(readData(row, ${q(expectedColumn)}) || ''), { exact: false })).toBeVisible();`;
      }
      const fallbackVal =
        (step.contract && (step.contract.expectedResult || step.contract.expected)) ||
        step.expectedResult ||
        (step.expectedOutcome &&
          (step.expectedOutcome.expectedResult ||
            step.expectedOutcome.expected ||
            step.expectedOutcome.pageName ||
            step.expectedOutcome.expectedPage)) ||
        null;
      if (fallbackVal != null && String(fallbackVal).trim() !== '') {
        const concrete = String(fallbackVal).trim();
        if (
          step.channel === 'PAGE' ||
          step.channel === 'URL' ||
          concrete.startsWith('/') ||
          /^https?:\/\//i.test(concrete)
        ) {
          return `      await expect(page).toHaveURL(new RegExp(${q(concrete)}));`;
        }
        return `      await expect(page.getByText(${q(concrete)}, { exact: false })).toBeVisible();`;
      }
      return `      test.info().annotations.push({ type: 'qaai-unresolved-oracle', description: ${q(`${step.channel} assertion has no concrete expected value; no hard assertion was emitted.`)} });
      expect.soft(false, ${q(`${step.channel} assertion has no concrete expected value; fix the declared assertion or bind an expected data column.`)}).toBeTruthy();`;
    }
    if (step.scope?.selector && (step.channel === 'UI_TEXT' || step.channel === 'PAGE')) {
      return `      await assertScopedText(page, ${q(step.scope.selector)}, ${expected}, ${ms});`;
    }
    // No authored scope selector was provided. Check visible rendered page text;
    // accessibility-only evidence is diagnostic and cannot satisfy a visual assertion.
    return `      await assertTextPresent(page, ${expected}, '', ${ms});`;
  }
  const target = ident(step.target);
  if (step.channel === 'UI_ROLE' || step.channel === 'PAGE') {
    return `      await expect(${target}).toBeVisible({ timeout: ${ms} });`;
  }
  if (step.channel === 'FORBIDDEN_TEXT') {
    return `      await expect(${target}).not.toContainText(${expected}, { timeout: ${ms} });`;
  }
  if (step.channel === 'FORBIDDEN_ROLE') {
    return `      await expect(${target}).toBeHidden({ timeout: ${ms} });`;
  }
  return `      await expect(${target}).toContainText(${expected}, { timeout: ${ms} });`;
}

function isFlowCriticalAssertion(step) {
  const containers = [
    step,
    step && step.metadata,
    step && step.contract,
    step && step.flow,
    step && step.dependency,
    step && step.expectedOutcome,
  ].filter((value) => value && typeof value === 'object');
  const flags = [
    'flowCritical',
    'isFlowCritical',
    'flowCriticalAssertion',
    'hardAssertion',
    'blocksFlow',
    'blocksDependentFlow',
    'dependencyPrerequisite',
    'isDependencyPrerequisite',
    'requiredForNextStep',
    'stopOnFailure',
  ];
  if (containers.some((container) => flags.some((flag) => container[flag] === true))) return true;
  const policies = containers
    .flatMap((container) => [
      container.failurePolicy,
      container.onFailure,
      container.validationMismatch,
      container.requiredInput,
      container.assertionMode,
    ])
    .filter(Boolean)
    .map((value) =>
      String(value)
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_'),
    );
  return policies.some((policy) =>
    [
      'block_dependents',
      'stop_descendants',
      'stop_dependent_flow',
      'fail_fast',
      'abort',
      'hard',
    ].includes(policy),
  );
}

function indentEmission(source, count) {
  const lines = String(source || '')
    .replace(/^\s*\n|\s*$/g, '')
    .split('\n');
  const nonEmpty = lines.filter((line) => line.trim());
  const minimum = nonEmpty.length
    ? Math.min(...nonEmpty.map((line) => (line.match(/^\s*/) || [''])[0].length))
    : 0;
  const prefix = ' '.repeat(count);
  return lines.map((line) => `${prefix}${line.slice(Math.min(minimum, line.length))}`).join('\n');
}

function continueAfterAssertionFailure(step, source) {
  if (!source || isFlowCriticalAssertion(step)) return source;
  if (/\bexpect\.soft\s*\(/.test(source)) return source;
  // A visual-surface miss that was positively confirmed by DOM/accessibility evidence is
  // intentionally a qualified diagnostic, not a fabricated failure.
  if (
    step &&
    step.liveDomGrounded === false &&
    (step.channel === 'UI_TEXT' || step.channel === 'FORBIDDEN_TEXT')
  )
    return source;
  const channel = String((step && step.channel) || 'assertion');
  const expected = String(step && step.expected != null ? step.expected : '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  const prefix = `QAAI_ASSERTION_FAILED: ${channel}${expected ? ` expected "${expected}"` : ''}.`;
  return `      await (async () => {\n${indentEmission(source, 8)}\n      })().catch((_qaaiAssertionError) => {
        const _qaaiAssertionMessage = ${q(prefix)} + ' ' + String(_qaaiAssertionError && _qaaiAssertionError.message || _qaaiAssertionError);
        expect.soft(false, _qaaiAssertionMessage).toBe(true);
      });`;
}

function emitAssertion(step, replayOrContext = false, opts = {}) {
  return continueAfterAssertionFailure(step, emitAssertionCore(step, replayOrContext, opts));
}

function emitHumanInput(disposition, step) {
  const field = ident(step.field || 'humanInput');
  if (disposition === 'test_hook') {
    const ref = envKeyFromRef(step.valueRef, `QAAI_${field.toUpperCase()}`);
    return `      const ${field} = readEnv(${q(ref)});
      test.info().annotations.push({ type: 'human-input', description: ${q(`${field} supplied by test hook`)} });
      void ${field};`;
  }
  if (disposition === 'manual_gate') {
    return qaaiFallback(
      'HUMAN_INPUT',
      `The authored human input "${step.field || 'unspecified'}" requires a manual value. Provide it through a test hook or environment variable; later independent steps will continue.`,
    );
  }
  return qaaiFallback(
    'HUMAN_INPUT',
    `Playwright cannot supply the authored human input "${step.field || 'unspecified'}" automatically. The step remains failed and later independent steps will continue.`,
  );
}

function emitTeardown(ir, opts = {}) {
  const slugTitle = slug(displayTitle(ir, opts));
  // DDT cases use test.each — row is in scope, make the screenshot path unique per row.
  const shot = opts._hasDataRows
    ? `\`test-results/${slugTitle}-\${row.index}.png\``
    : q(`test-results/${slugTitle}.png`);
  // When emitDataProvider skipped the for-loop (single non-DDT case), there is no
  // enclosing loop brace to close — only the test() body and the describe() block.
  const loopClose = opts._emittedDataLoop === false ? '' : '\n  }';
  const failureParity = irRecordedFailure(ir) ? `${failureParityLine(ir)}\n` : '';
  const suffix = `      ${failureParity}      if (!page.isClosed()) await page.screenshot({ path: ${shot}, fullPage: true });\n    });${loopClose}\n});`;
  return suffix;
}

// ── Journey emission (P1) ─────────────────────────────────────────────────────
// Compile all cases from a single scenario into one spec where each case becomes
// a test.step() block. State flows naturally between steps — no page.goto() is
// repeated; the browser stays on whatever page the previous case left it on.

function irRecordedFailure(ir) {
  const status = String(ir?.verdict?.status || ir?.status || '').toLowerCase();
  return status === 'fail' || status === 'failed';
}

function failureParityLine(ir) {
  const verdict = ir?.verdict || {};
  const reason =
    verdict.reason || verdict.summary || verdict.message || 'browser run recorded a failed verdict';
  const message = `QAAI_RUNTIME_PARITY: original browser run failed (${reason}). The generated test records this failure after preserving the full authored flow.`;
  return `      expect.soft(false, ${q(message)}).toBe(true);`;
}

function _journeyStepLines(cases) {
  const lines = [];
  // D2: collect all locator candidate arrays here; after the loop, prepend a LOCATORS
  // const block so selector JSON is physically separated from business steps.
  const locatorsMap = {};
  const usedVarNames = {};

  for (const { ir, caseName, runResultId } of cases) {
    const title = caseName || (ir && (ir.title || ir.caseId)) || 'step';
    const rows = (
      ir && Array.isArray(ir.dataRows) && ir.dataRows.length
        ? ir.dataRows
        : ir && ir.dataRow
          ? [ir.dataRow]
          : []
    ).filter((r) => r && r.fields && Object.keys(r.fields).length);
    const stepRows = rows.length ? rows : [null];
    for (const [rowIndex, row] of stepRows.entries()) {
      const hasDataRow = !!row;
      const rowTitle =
        hasDataRow && stepRows.length > 1
          ? `${title} [Row ${row.index != null ? row.index : rowIndex}: ${row.label || `Row ${rowIndex + 1}`}]`
          : title;
      lines.push('');
      lines.push(`    // ─── ${rowTitle} ${'─'.repeat(Math.max(0, 64 - rowTitle.length))}`);
      lines.push(`    await test.step(${q(rowTitle)}, async () => {`);
      if (hasDataRow) {
        lines.push(
          `      const row: DataRow = ${JSON.stringify(row, null, 2).replace(/\n/g, '\n      ')};`,
        );
      }
      const dialogPrearm = emitDialogPrearm(ir);
      if (dialogPrearm) lines.push(dialogPrearm);
      // Locator declarations are block-scoped inside test.step(); never reuse a
      // locator var from a previous step block.
      const candidateKeyToVar = {};
      const resolveMap = {};
      const asToSemantic = {};
      for (const step of (ir && ir.steps) || []) {
        let line = null;
        if (step.op === 'resolve') {
          resolveMap[step.as] = step.candidates;
          const norm = normalizeCandidates(step.candidates || []);
          const candidateKey = JSON.stringify(norm);
          if (candidateKeyToVar[candidateKey]) {
            // Same element seen before in this journey step — reuse the existing variable.
            asToSemantic[step.as] = candidateKeyToVar[candidateKey];
            line = null;
          } else {
            const baseName = semanticVarName(step.candidates, step.as || step.target || 'target');
            const count = (usedVarNames[baseName] = (usedVarNames[baseName] || 0) + 1);
            const finalName = count === 1 ? baseName : `${baseName}${count}`;
            asToSemantic[step.as] = finalName;
            candidateKeyToVar[candidateKey] = finalName;
            // Pass locatorsMap so emitLocatorResolver registers the candidates there
            // and emits LOCATORS.name instead of inlining the JSON.
            line = emitLocatorResolver(step.candidates, step, finalName, locatorsMap);
          }
        } else if (step.op === 'waitFor') line = emitWait(step.condition, asToSemantic);
        // Row-scoped journey steps declare row inside this test.step so generated
        // actions can use readData(row, "...") without leaking to env refs.
        else if (step.op === 'act')
          line = emitStep(step, resolveMap[step.target] || [], asToSemantic, {
            hasDataLoop: hasDataRow,
            dataRow: row,
            replayIR: ir,
          });
        else if (step.op === 'handlePopup') line = emitPopupHandling(step.known || []);
        else if (step.op === 'assert')
          line = emitAssertion(step, { hasDataLoop: hasDataRow, dataRow: row });
        else if (step.op === 'humanInput') line = emitHumanInput(step.disposition, step);
        if (line != null) lines.push(line);
      }
      if (irRecordedFailure(ir)) {
        lines.push(failureParityLine(ir));
      }
      lines.push(
        `      if (!page.isClosed()) await page.screenshot({ path: ${q(`test-results/${slug(rowTitle)}.png`)}, fullPage: true });`,
      );
      lines.push('    });');
    }
  }

  // D2: emit the LOCATORS block before the first step so all selector JSON lives at
  // the test-body level, not scattered inline through business-logic lines.
  if (Object.keys(locatorsMap).length > 0) {
    const entryLines = Object.entries(locatorsMap).map(([k, v]) => {
      const lit = JSON.stringify(v, null, 2)
        .split('\n')
        .map((line, i) => (i === 0 ? line : `        ${line}`))
        .join('\n');
      return `      ${k}: ${lit},`;
    });
    lines.unshift(...['', '    const LOCATORS = {', ...entryLines, '    };']);
  }

  return lines;
}

function emitJourneySpec(cases, opts = {}) {
  const scenarioName = String(
    opts.scenarioName ||
      (cases[0] && cases[0].ir && (cases[0].ir.title || cases[0].ir.caseId)) ||
      'Journey',
  ).trim();
  const runNote = opts.runId ? `\n// QAAI Run: ${opts.runId}` : '';
  const body = _journeyStepLines(cases).join('\n');
  return `import { test, expect } from '@playwright/test';
import { assertTextPresent, assertScopedText, dismissKnownPopups, readEnv, readData, missingBindingValue, readRuntimeOutput, readDependencyOutput, generateDeterministicValue, resolveLocator, evaluateSettled, type DataRow } from '../support/replayir';
${runNote}
// QAAI Journey Export — test steps share browser state.
// Run as a suite. Individual test.step blocks are not standalone tests.
test.describe(${q(scenarioName)}, () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  test('full journey', async ({ page }) => {${body}
  });
});
`;
}

function emitJourneySpecJs(cases, opts = {}) {
  const scenarioName = String(
    opts.scenarioName ||
      (cases[0] && cases[0].ir && (cases[0].ir.title || cases[0].ir.caseId)) ||
      'Journey',
  ).trim();
  const runNote = opts.runId ? `\n// QAAI Run: ${opts.runId}` : '';
  const body = _journeyStepLines(cases).join('\n');
  return `const { test, expect } = require('@playwright/test');
const { assertTextPresent, assertScopedText, dismissKnownPopups, readEnv, readData, missingBindingValue, readRuntimeOutput, readDependencyOutput, generateDeterministicValue, resolveLocator, evaluateSettled } = require('../support/replayir');
${runNote}
// QAAI Journey Export — test steps share browser state.
// Run as a suite. Individual test.step blocks are not standalone tests.
test.describe(${q(scenarioName)}, () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  test('full journey', async ({ page }) => {${body}
  });
});
`;
}

function fileLayout(ir) {
  return {
    primaryFile: `tests/replayir/${slug(ir.caseId)}.spec.ts`,
    testFile: `tests/replayir/${slug(ir.caseId)}.spec.ts`,
  };
}

function fileLayoutJs(ir) {
  return {
    primaryFile: `tests/replayir/${slug(ir.caseId)}.spec.js`,
    testFile: `tests/replayir/${slug(ir.caseId)}.spec.js`,
  };
}

function compileCmd() {
  return { cmd: 'npx', args: ['playwright', 'test', '--list'] };
}

function runCmd() {
  return { cmd: 'npx', args: ['playwright', 'test'] };
}

function supportFiles() {
  return { 'tests/support/replayir.ts': SUPPORT_FILE };
}

// Plain JavaScript support file — no TypeScript annotations, CommonJS exports.
const SUPPORT_FILE_JS = `const { expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

async function resolveLocator(page, candidates, label) {
  const errors = [];
  for (const c of candidates) {
    let locator = null;
    if (c.strategy === 'role' && c.role && c.name && String(c.name).trim()) locator = page.getByRole(c.role, { name: c.name });
    if (c.strategy === 'css' && c.selector) locator = page.locator(c.selector);
    if (c.strategy === 'testId' && c.testId) locator = page.getByTestId(c.testId);
    if (c.strategy === 'text' && c.text) locator = page.getByText(c.text);
    if (c.strategy === 'placeholder' && c.text) locator = page.getByPlaceholder(c.text);
    if (c.strategy === 'label' && c.text) locator = page.getByLabel(c.text);
    if (!locator) {
      errors.push(\`unsupported candidate \${JSON.stringify(c)}\`);
      continue;
    }
    await locator.waitFor({ state: 'attached', timeout: 12000 }).catch(() => {});
    const count = await locator.count().catch(() => 0);
    if (count === 1) {
      if (await locator.isVisible({ timeout: 750 }).catch(() => false)) return locator;
      errors.push(\`candidate matched one non-visible element: \${JSON.stringify(c)}\`);
      continue;
    }
    if (count > 1) {
      if (c.strategy === 'role' && c.role && c.name) {
        const exactL = page.getByRole(c.role, { name: c.name, exact: true });
        const exactN = await exactL.count().catch(() => 0);
        if (exactN === 1 && await exactL.isVisible({ timeout: 750 }).catch(() => false)) return exactL;
        if (exactN !== 1) {
          const lname = c.name.toLowerCase();
          const prefixFiltered = [];
          for (let idx = 0; idx < count; idx++) {
            const acc = await locator.nth(idx).evaluate((el) => {
              return (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/^\\W+/, '').toLowerCase();
            }).catch(() => '');
            if (acc === lname) prefixFiltered.push(idx);
          }
          if (prefixFiltered.length === 1 && await locator.nth(prefixFiltered[0]).isVisible({ timeout: 750 }).catch(() => false)) {
            return locator.nth(prefixFiltered[0]);
          }
        }
      }
      const context = (c.contextText || []).map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
      if (context.length) {
        const scoped = [];
        for (let index = 0; index < count; index += 1) {
          const ok = await locator.nth(index).evaluate((el, expected) => {
            let node = el;
            for (let depth = 0; node && depth < 5; depth += 1) {
              const text = String(node.textContent || '').replace(/\\\\s+/g, ' ').trim().toLowerCase();
              if (expected.some((item) => item && text.includes(item))) return true;
              node = node.parentElement;
            }
            return false;
          }, context).catch(() => false);
          if (ok) scoped.push(index);
        }
        if (scoped.length === 1) return locator.nth(scoped[0]);
        errors.push(\`candidate context narrowed to \${scoped.length} of \${count} matches for \${JSON.stringify(c)}\`);
        continue;
      }
      errors.push(\`candidate ambiguous: matched \${count} elements for \${JSON.stringify(c)}\`);
      continue;
    }
    // When named-role returns 0 matches the element likely has no accessible name
    // (icon-only buttons, inputs without labels). Fall back to role-only + sibling-
    // attribute proximity: find a same-role element whose parent also contains a
    // sibling with an attribute (placeholder/aria-label/title/name) that matches
    // one of the contextText hints. This handles icon-only submit buttons adjacent
    // to a labeled input without hardcoding any site-specific selector.
    if (count === 0 && c.strategy === 'role' && c.role && c.name) {
      const ctxItems = (c.contextText || []).map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
      if (ctxItems.length) {
        const roleAny = page.getByRole(c.role);
        const roleAnyCount = await roleAny.count().catch(() => 0);
        if (roleAnyCount > 0 && roleAnyCount <= 30) {
          const sibMatch = [];
          for (let i = 0; i < roleAnyCount; i++) {
            const matched = await roleAny.nth(i).evaluate((el, ctx) => {
              let node = el;
              for (let depth = 0; node && depth < 8; depth++) {
                if (node.parentElement) {
                  for (const sib of node.parentElement.children) {
                    if (sib === node) continue;
                    const attrs = [
                      sib.getAttribute('placeholder'),
                      sib.getAttribute('aria-label'),
                      sib.getAttribute('title'),
                      sib.getAttribute('name')
                    ].filter(Boolean).join(' ').toLowerCase();
                    if (ctx.some((c) => attrs.includes(c))) return true;
                  }
                }
                node = node.parentElement;
              }
              return false;
            }, ctxItems).catch(() => false);
            if (matched) sibMatch.push(i);
          }
          if (sibMatch.length === 1) {
            const el = roleAny.nth(sibMatch[0]);
            if (await el.isVisible({ timeout: 750 }).catch(() => false)) return el;
          }
        }
      }
    }
    errors.push(\`candidate matched \${count}: \${JSON.stringify(c)}\`);
  }
  throw new Error(\`Unable to resolve \${label}: \${errors.join('; ')}\`);
}

async function assertTextPresent(page, text, _hint, timeoutMs) {
  const expected = String(text);
  const matches = page.getByText(expected, { exact: false });
  await expect.poll(async () => {
    const count = await matches.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      if (await matches.nth(index).isVisible().catch(() => false)) return true;
    }
    return false;
  }, {
    timeout: timeoutMs,
    message: 'Expected visible rendered text "' + expected + '" anywhere on the page.',
  }).toBe(true);
}

async function assertScopedText(page, selector, text, timeoutMs) {
  const scope = page.locator(selector);
  await expect(scope, 'assertion scope must exist before checking text').not.toHaveCount(0, { timeout: timeoutMs });
  await expect(scope.filter({ hasText: String(text) }), 'scoped assertion text must appear inside the recorded container').not.toHaveCount(0, { timeout: timeoutMs });
}

async function dismissKnownPopups(page, candidates) {
  for (const c of candidates) {
    const locator = await resolveLocator(page, [c], 'known popup').catch(() => null);
    if (locator && await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
      await locator.click();
    }
  }
}

async function dismissCommonOverlays(page) {
  await page.keyboard.press('Escape').catch(() => {});
  const closeByRole = page.getByRole('button', { name: /^(close|dismiss|no thanks|not now|skip|×|x)$/i });
  const count = Math.min(await closeByRole.count().catch(() => 0), 5);
  for (let i = 0; i < count; i += 1) {
    const btn = closeByRole.nth(i);
    if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
      await btn.click({ timeout: 1000 }).catch(() => {});
    }
  }
}

async function safeClick(page, locator, popupCandidates = []) {
  try {
    await locator.click();
    return;
  } catch (err) {
    const message = String((err && err.message) || err || '');
    if (!/intercept|obscur|covered|receives pointer events|not visible|detached|timeout/i.test(message)) throw err;
    await dismissKnownPopups(page, popupCandidates).catch(() => {});
    await dismissCommonOverlays(page).catch(() => {});
    await locator.click();
  }
}

async function safeFill(page, locator, value, popupCandidates = []) {
  const text = value == null ? '' : String(value);
  try {
    await locator.fill(text);
    return;
  } catch (err) {
    const message = String((err && err.message) || err || '');
    if (!/intercept|obscur|covered|not visible|detached|timeout|editable|focus/i.test(message)) throw err;
    await dismissKnownPopups(page, popupCandidates).catch(() => {});
    await dismissCommonOverlays(page).catch(() => {});
    await locator.fill(text);
  }
}

function readEnv(name) {
  const value = process.env[name];
  if (value == null || String(value).trim() === '') throw new Error(\`Missing or blank required environment variable \${name}\`);
  return value;
}

function qaaiBindingContext() {
  const globalContext = globalThis.__QAAI_BINDING_CONTEXT__;
  if (globalContext && typeof globalContext === 'object') return globalContext;
  const raw = process.env.QAAI_BINDING_CONTEXT;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (error) {
    throw new Error('QAAI binding context: QAAI_BINDING_CONTEXT must be valid JSON: ' + String(error && error.message || error));
  }
  throw new Error('QAAI binding context: QAAI_BINDING_CONTEXT must contain a JSON object');
}

function missingBindingValue(kind, key) {
  throw new Error('QAAI binding ' + kind + ': required value "' + key + '" is unavailable');
}

function readRuntimeOutput(key) {
  const context = qaaiBindingContext();
  const value = context.runtimeOutputs && context.runtimeOutputs[key];
  if (value == null) return missingBindingValue('runtime_output', key);
  return value;
}

function readDependencyOutput(dependencyCaseId, key) {
  const context = qaaiBindingContext();
  const dependency = context.dependencyOutputs && context.dependencyOutputs[dependencyCaseId];
  const value = dependency && dependency[key];
  if (value == null) return missingBindingValue('dependency_output', dependencyCaseId + '.' + key);
  return value;
}

function canonicalBindingSeed(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalBindingSeed).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalBindingSeed(value[key])).join(',') + '}';
  }
  const encoded = JSON.stringify(value);
  return encoded == null ? String(value) : encoded;
}

function generateDeterministicValue(contract = {}) {
  const prefix = contract.prefix == null ? '' : String(contract.prefix);
  const requestedLength = Number(contract.length);
  const length = Number.isFinite(requestedLength) && requestedLength > 0 ? Math.floor(requestedLength) : 12;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const seed = canonicalBindingSeed(contract);
  let state = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 16777619) >>> 0;
  }
  let generated = '';
  for (let index = 0; index < length; index += 1) {
    state ^= index + 1;
    state = Math.imul(state, 16777619) >>> 0;
    generated += alphabet[state % alphabet.length];
  }
  return prefix + generated;
}

function readData(row, key, options = {}) {
  const required = options.required !== false;
  const type = options.type || 'string';
  const raw = row && row.fields && row.fields[key];
  const label = row && row.label || 'data row';
  const explicitBlank = raw === '<empty>' || raw === '<blank>' || raw === '<null>';
  if (raw == null || raw === '' || explicitBlank) {
    if (!required) return options.defaultValue != null ? options.defaultValue : (type === 'number' ? 0 : type === 'boolean' ? false : '');
    if (explicitBlank && type === 'string') return '';
    throw new Error(\`QAAI data contract: required field "\${key}" is empty for \${label}\`);
  }
  const value = String(raw).trim();
  if (type === 'number') {
    const num = Number(value.replace(/,/g, ''));
    if (!Number.isFinite(num)) throw new Error(\`QAAI data contract: field "\${key}" for \${label} must be numeric, got "\${value}"\`);
    return num;
  }
  if (type === 'boolean') {
    if (/^(true|1|yes|y)$/i.test(value)) return true;
    if (/^(false|0|no|n)$/i.test(value)) return false;
    throw new Error(\`QAAI data contract: field "\${key}" for \${label} must be boolean, got "\${value}"\`);
  }
  return value;
}

function loadDataRows(relPath) {
  const full = path.resolve(process.cwd(), relPath);
  const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(\`Data file \${relPath} must contain an array of rows\`);
  return parsed;
}

const _A11Y_IMPACT = { minor: 0, moderate: 1, serious: 2, critical: 3 };

async function checkAccessibility(page, minImpact = 'critical') {
  const minLevel = _A11Y_IMPACT[minImpact] != null ? _A11Y_IMPACT[minImpact] : 3;
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations.filter(
    (v) => (_A11Y_IMPACT[v.impact || 'critical'] != null ? _A11Y_IMPACT[v.impact || 'critical'] : 3) >= minLevel
  );
  if (violations.length > 0) {
    const summary = violations.map((v) => \`\${v.id}(\${v.impact}): \${v.description}\`).join('\\n  ');
    throw new Error(\`Accessibility violations [\${violations.length}] at impact >= "\${minImpact}":\\n  \${summary}\`);
  }
}

// EVALUATE fidelity: re-run the recorded browser script against a SETTLED page and survive a
// mid-evaluate navigation by retrying once. Uses 'load' not 'networkidle' — networkidle hangs
// permanently on ad-heavy SPAs and resolves before render on fast SPAs; 'load' is deterministic.
async function evaluateSettled(page, fn) {
  await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
  try {
    return await page.evaluate(fn);
  } catch (e) {
    if (/Execution context was destroyed|context was destroyed|navigation|detached/i.test(String(e && e.message))) {
      await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
      return await page.evaluate(fn);
    }
    throw e;
  }
}

module.exports = { resolveLocator, assertTextPresent, assertScopedText, dismissKnownPopups, safeClick, safeFill, readEnv, readData, missingBindingValue, readRuntimeOutput, readDependencyOutput, generateDeterministicValue, loadDataRows, checkAccessibility, evaluateSettled };
`;

const SUPPORT_FILE_JS_ESM = SUPPORT_FILE_JS.replace(
  "const { expect } = require('@playwright/test');",
  "import { expect } from '@playwright/test';",
)
  .replace(
    "const fs = require('node:fs');\nconst path = require('node:path');",
    "import fs from 'node:fs';\nimport path from 'node:path';",
  )
  .replace(
    '\nmodule.exports = { resolveLocator, assertTextPresent, assertScopedText, dismissKnownPopups, safeClick, safeFill, readEnv, readData, missingBindingValue, readRuntimeOutput, readDependencyOutput, generateDeterministicValue, loadDataRows, checkAccessibility, evaluateSettled };\n',
    '\nexport { resolveLocator, assertTextPresent, assertScopedText, dismissKnownPopups, safeClick, safeFill, readEnv, readData, missingBindingValue, readRuntimeOutput, readDependencyOutput, generateDeterministicValue, loadDataRows, checkAccessibility, evaluateSettled };\n',
  );

function supportFilesJs() {
  return { 'tests/support/replayir.js': SUPPORT_FILE_JS };
}

function supportFilesJsEsm() {
  return { 'tests/support/replayir.js': SUPPORT_FILE_JS_ESM };
}

function emitSetupJs(ir, opts = {}) {
  const title = displayTitle(ir, opts);
  const rr = opts.runResultId ? `\n// QAAI RunResult: ${opts.runResultId}` : '';
  const tc = opts.testCaseId ? `\n// QAAI TestCase: ${opts.testCaseId}` : '';
  const deps =
    Array.isArray(opts.dependsOn) && opts.dependsOn.length
      ? `\n// DATA DEPENDENCY: Requires data created by: ${opts.dependsOn.join(', ')}` +
        `\n// Run the full suite in order, or ensure prerequisite data exists when running in isolation.`
      : '';
  const dataRequire = opts.dataCaseSlug
    ? `const testData = require('../data/${opts.dataCaseSlug}.json');\n`
    : '';
  return `const { test, expect } = require('@playwright/test');
const { assertTextPresent, assertScopedText, dismissKnownPopups, readEnv, readData, missingBindingValue, readRuntimeOutput, readDependencyOutput, generateDeterministicValue, resolveLocator, checkAccessibility, evaluateSettled } = require('../support/replayir');
${dataRequire}${deps}
test.describe(${q(title)}, () => {`;
}

function emitDataProviderJs(rows, replayIR, opts = {}) {
  const title = displayTitle(replayIR || {}, opts);
  const titleForTemplate = title.replace(/[`\\]/g, '\\$&').replace(/\$\{/g, '\\${');
  if (opts.dataCaseSlug) {
    rememberExportedDataKeys(opts, rows, true);
    if (opts) opts._emittedDataLoop = false;
    return `  test.each(testData)(\`${titleForTemplate} [Row $index: $label]\`, async ({ page }, row) => {`;
  }
  const dataRows =
    rows && rows.length
      ? rows.map((row) => ({
          index: row.index,
          label: row.label || `Row ${Number(row.index || 0) + 1}`,
          fields: Object.fromEntries(
            Object.entries(row.fields || {}).filter(
              ([, value]) => !isEnvironmentBackedDataValue(value),
            ),
          ),
        }))
      : [{ index: 0, label: 'default', fields: {} }];
  const singleDefault =
    dataRows.length === 1 && String(dataRows[0].label || '').toLowerCase() === 'default';
  const hasData = dataRows.some((r) => r.fields && Object.keys(r.fields).length > 0);
  if (singleDefault && !hasData) {
    rememberExportedDataKeys(opts, [], false);
    if (opts) opts._emittedDataLoop = false;
    return `  test(${q(title)}, async ({ page }) => {`;
  }
  rememberExportedDataKeys(opts, dataRows, hasData);
  if (opts) opts._hasDataRows = true;
  if (opts) opts._emittedDataLoop = false;
  return `  const dataRows = ${JSON.stringify(dataRows, null, 2).replace(/\n/g, '\n  ')};

  test.each(dataRows)(\`${titleForTemplate} [Row $index: $label]\`, async ({ page }, row) => {`;
}

async function validatePackage(opts = {}) {
  return packageValidate.validatePackage({ ...opts, framework: 'playwright-pom' });
}

// JS-mode adapter — same runtime emit functions, JS-specific wrappers for boilerplate.
const ADAPTER_ID_JS = 'playwright-reference-js';
const playwrightReferenceJs = {
  id: ADAPTER_ID_JS,
  emitSetup: emitSetupJs,
  emitAuth,
  emitLocatorResolver,
  emitStep,
  emitWait,
  emitPopupHandling,
  emitAssertion,
  isFlowCriticalAssertion,
  continueAfterAssertionFailure,
  emitDataProvider: emitDataProviderJs,
  emitRetryPolicy,
  emitHumanInput,
  emitTeardown,
  fileLayout: fileLayoutJs,
  compileCmd,
  runCmd,
  supportFiles: supportFilesJs,
  validatePackage,
  regressionCorpus: () => regressionCorpus.forAdapter(ADAPTER_ID_JS),
  emitJourneySpec: emitJourneySpecJs,
};

module.exports = {
  id: ADAPTER_ID,
  emitSetup,
  emitAuth,
  emitLocatorResolver,
  emitStep,
  emitWait,
  emitPopupHandling,
  emitAssertion,
  isFlowCriticalAssertion,
  continueAfterAssertionFailure,
  emitDataProvider,
  emitRetryPolicy,
  emitHumanInput,
  emitTeardown,
  fileLayout,
  compileCmd,
  runCmd,
  supportFiles,
  supportFilesJsEsm,
  validatePackage,
  regressionCorpus: () => regressionCorpus.forAdapter(ADAPTER_ID),
  emitJourneySpec,
  selectStaticCandidate,
  selectStaticLocator,
  evaluateArg,
  emitDialogPrearm,
  emitDialogAcknowledgement,
  playwrightReferenceJs,
};
