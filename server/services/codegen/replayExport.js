'use strict';
/**
 * Enterprise Mode P7 — IR-sourced export. Compiles framework packages ONLY from
 * `RunResult.replayIrJson` (the pinned P6 envelope) through the frozen framework
 * adapters (`compileReplayIR`). NO legacy-codegen fallback, NO regen from case
 * text, NO adapter improvisation — the user's hard rule.
 *
 * Scope (do NOT overclaim): P7 proves IR-only export + compile/list/package
 * validation + no secret leakage + manifest verdict PRESERVATION. Actual clean-env
 * EXECUTION parity is P8.
 *
 * Layered so the guard can test the pure core with hand-built envelopes (no DB, no
 * browser) and the live smoke exercises buildReplayExport against real RunResults:
 *   compileResults()  → admit/block + compile + verdict-preservation wrap   (PURE)
 *   assemblePackage() → IR-agnostic shell + per-result spec files           (PURE)
 *   scanSecrets()     → defense-in-depth leak scan                          (PURE)
 *   buildManifest()   → the stable EXPORT_MANIFEST.json                     (PURE)
 *   validateAssembled() → write a temp package + _packageValidate           (fs)
 *   buildReplayExport() → DB load → the above → {files, manifest, ...}       (service)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const prisma = require('../../prisma');
const contract = require('./adapters/frameworkAdapter');
const registry = require('./adapters');
const replayIrBdd = require('./adapters/replayIrBdd');
const seleniumBddReference = require('./adapters/seleniumBddReference');
const seleniumReference = require('./adapters/seleniumReference');
const seleniumPom = require('./adapters/seleniumPom');
const playwrightReference = require('./adapters/playwrightReference');
const playwrightPom = require('./adapters/playwrightPom');
const operationBacked = require('./adapters/operationBacked');
const { normalizeCandidates } = require('./adapters/_candidateNormalize');
const packageValidate = require('./_packageValidate');
const replayLocatorContract = require('./_replayContract');
const storageStateLib = require('./_storageState');
const { checkpointAll } = require('./adapters/exportCheckpoint');
const { decodeJson } = require('../jsonField');
const { getCalibrationAtlas } = require('../agents/calibrator');
const actionLocatorResolver = require('../actionLocatorResolver');
const fidelity = require('./_fidelity');
const stepCompilationLedger = require('./stepCompilationLedger');
const executableTestContract = require('../executableTestContract');
const locatorIntelligenceV2 = require('../locatorIntelligenceV2');
const scriptValidationRunner = require('../scriptValidationRunner');
const generatedOutputQuality = require('../generatedOutputQuality');
const readinessCompiler = require('../readinessCompiler');
const liveScriptRecorder = require('../liveScriptRecorder');
const authSessionManager = require('../universalAuthSessionManager');
const replayEmitter = require('./replayEmitter');
const outputReadiness = require('../outputReadiness');
const envContract = require('./_env');
const evidenceConsistency = require('./evidenceConsistency');
const evidenceReplayIr = require('../evidenceReplayIr');
const liveReplayCodegen = require('./liveReplayCodegen');

// adapterId → the framework key _packageValidate understands.
const VALIDATE_FRAMEWORK = {
  'playwright-reference': 'playwright-pom',
  'playwright-reference-js': 'playwright-pom',
  'playwright-pom': 'playwright-pom',
  'playwright-pom-js': 'playwright-pom',
  'replayir-bdd': 'playwright-bdd',
  'selenium-bdd-reference': 'selenium-bdd',
  'selenium-reference': 'selenium-java',
  'selenium-pom': 'selenium-java',
};
// Explicit adapter classification sets — source of truth for assemblePackage().
// Add a new Playwright adapter here when it lands; the compiler will catch missing cases
// via the guard in scripts/verify_codegen_contract.cjs ([14] section).
const PLAYWRIGHT_ADAPTER_IDS = new Set([
  'playwright-reference',
  'playwright-reference-js',
  'playwright-pom',
  'playwright-pom-js',
]);
// POM adapters always emit `import` syntax (ES module) regardless of lang.
const POM_ADAPTER_IDS = new Set(['playwright-pom', 'playwright-pom-js']);
// The single non-POM JS adapter emits `require()` specs and ships the CommonJS support file.
const CJS_SUPPORT_ADAPTER_IDS = new Set(['playwright-reference-js']);
// adapterId → a stable version stamp for the manifest (adapters don't self-version yet).
const ADAPTER_VERSION = {
  'playwright-reference': 'playwright-reference-1',
  'playwright-reference-js': 'playwright-reference-js-1',
  'selenium-bdd-reference': 'selenium-bdd-reference-1',
  'selenium-reference': 'selenium-reference-1',
  'selenium-pom': 'selenium-pom-1',
};

// A secret-KEYED field assigned a STRING LITERAL (not a readEnv/process.env/System.getenv
// call — those aren't quoted right after the separator). Defense-in-depth: the contract
// already forbids inline values, this catches an adapter/shell hardcoding one anyway.
const SECRET_LEAK_RE =
  /(?:^\s*|[{,]\s*|\b(?:const|let|var)\s+|\.\s*)["']?(passwo?r?d|passwd|pwd|secret|token|apikey|api_key|otp|mfa|credential)\b["']?\s*[:=]\s*["'][^"']{1,}["']/i;

function indexIsInsideQuotedLiteral(text, targetIndex) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < targetIndex; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
  }
  return quote !== null;
}

function lineContainsSecretLiteralAssignment(line) {
  const matcher = new RegExp(SECRET_LEAK_RE.source, `${SECRET_LEAK_RE.flags}g`);
  let match;
  while ((match = matcher.exec(line)) !== null) {
    if (!indexIsInsideQuotedLiteral(line, match.index)
        && !String(match[0]).includes('__QAAI_REDACTED__')) return true;
    if (match[0].length === 0) matcher.lastIndex += 1;
  }
  return false;
}

function sha256(s) {
  return crypto
    .createHash('sha256')
    .update(Buffer.isBuffer(s) ? s : String(s), Buffer.isBuffer(s) ? undefined : 'utf8')
    .digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + stableStringify(value[key]))
      .join(',') +
    '}'
  );
}

function hashReplayIr(ir) {
  return sha256(stableStringify(ir || null));
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

function semanticSpecSlug(value, fallback = 'test-journey') {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) return fallback;
  if (normalized.length <= 80) return normalized;
  const capped = normalized.slice(0, 80).replace(/-+$/g, '');
  const lastBoundary = capped.lastIndexOf('-');
  const completeTokenSlug = (lastBoundary > 0 ? capped.slice(0, lastBoundary) : capped) || fallback;
  const tokens = completeTokenSlug.split('-');
  const danglingConnectors = new Set(['and', 'or', 'to']);
  while (tokens.length > 1 && danglingConnectors.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join('-') || fallback;
}

function readableSegment(value, fallback) {
  return slug(value, fallback).slice(0, 90).replace(/-+$/g, '') || fallback;
}

const INTERNAL_UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

function humanReadableText(value, fallback = 'Generated test case') {
  const text = String(value || '')
    .replace(INTERNAL_UUID_RE, ' ')
    .replace(/\b(?:run[-_ ]?result|test[-_ ]?case|rr|tc)[-_: ]+[a-f0-9][a-f0-9_-]{5,}\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text && !internalTargetName(text) ? text : fallback;
}

function semanticResultTitle(result, fallback = 'Generated test case') {
  return humanReadableText(
    [
      result && result.caseName,
      result && result.testCaseName,
      result && result.name,
      result && result.scenarioName,
      result && result.scenario && result.scenario.name,
      result && result.envelope && result.envelope.ir && result.envelope.ir.title,
    ].find(Boolean),
    fallback,
  );
}

function uniqueSemanticPath(desiredPath, usedPaths) {
  if (!usedPaths.has(desiredPath)) {
    usedPaths.add(desiredPath);
    return desiredPath;
  }
  const suffixMatch = String(desiredPath).match(
    /(\.diagnostic\.[^.]+|\.preview\.spec\.[^.]+|\.spec\.[^.]+|\.feature|\.java|\.json|\.xlsx|\.csv)$/i,
  );
  const suffix = suffixMatch ? suffixMatch[1] : '';
  const stem = suffix ? desiredPath.slice(0, -suffix.length) : desiredPath;
  let duplicate = 2;
  let candidate = `${stem}-${duplicate}${suffix}`;
  while (usedPaths.has(candidate)) candidate = `${stem}-${++duplicate}${suffix}`;
  usedPaths.add(candidate);
  return candidate;
}

function readableModule(result) {
  const fromCase = result && (result.module || result.moduleName || result.moduleKey);
  const fromScenario =
    result &&
    result.scenario &&
    (result.scenario.module || result.scenario.moduleName || result.scenario.moduleKey);
  return readableSegment(fromCase || fromScenario || 'uncategorized', 'uncategorized');
}

function readableCaseName(result) {
  const name = [
    result && result.caseName,
    result && result.testCaseName,
    result && result.name,
    result && result.scenarioName,
    result && result.scenario && result.scenario.name,
  ].find(Boolean);
  const row = result && result.dataRowLabel ? `-${result.dataRowLabel}` : '';
  return readableSegment(`${humanReadableText(name, 'test-case')}${row}`, 'test-case');
}

function jsLiteral(value) {
  return JSON.stringify(String(value == null ? '' : value));
}

function readableSpecPath(result, ext = 'spec.ts') {
  return `tests/${readableModule(result)}/${readableCaseName(result)}.${ext}`;
}

// The env var name the adapter's readEnv() will look up for a given valueRef — kept
// in sync with playwrightReference.envNameFromRef so .env.example lists the right keys.
function envNameForRef(ref) {
  const m = String(ref || '').match(/^(env|vault|fixture|masked):(.+)$/i);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const suffix =
    String(m[2])
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'VALUE';
  if (kind === 'env') return suffix;
  if (kind === 'fixture') return `QAAI_FIXTURE_${suffix}`;
  if (kind === 'vault') return `QAAI_VAULT_${suffix}`;
  if (kind === 'masked') return `QAAI_MASKED_${suffix}`;
  return null;
}

/**
 * Normalize a data-row field role key to a safe JS identifier.
 * "First Name" → "First_Name", "1st-field" → "_1st_field", "email address" → "email_address".
 * Must match the normalization applied in replayEmitter.js when tagging step.dataRole.
 */
function toSafeDataKey(k) {
  const s = String(k || '')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/^([0-9])/, '_$1')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || 'field';
}

/**
 * Strip env:/vault:/masked:/fixture: refs, force-cast to String, and normalize keys.
 * Shared by collectDataFiles and _compilePerCase.
 */
function _buildSafeRows(rows) {
  const safeRows = [];
  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue;
    const safeFields = {};
    for (const [role, val] of Object.entries(row.fields || {})) {
      if (typeof val === 'string' && /^(?:env|vault|masked|fixture):/i.test(val)) continue;
      safeFields[toSafeDataKey(role)] = String(val);
    }
    if (!Object.keys(safeFields).length) continue;
    const index = row.index != null ? Number(row.index) : 0;
    safeRows.push({ index, label: row.label || `Row ${index}`, fields: safeFields });
  }
  return safeRows;
}

/**
 * Build per-CASE JSON data files from ir.dataRow/ir.dataRows in the result set.
 * Returns a `files` object keyed by path. One file per RunResult — never a shared
 * per-module file — so each exported spec only iterates the exact rows it ran.
 *
 * Trap 1 prevention: per-module files caused cross-pollination where Case A (Admin)
 * would also iterate Case B (ESS) rows from the same shared file. Per-case isolation
 * guarantees each spec loops only over the data it was actually executed with.
 */
function collectDataFiles(results, pathPrefix = 'tests/data') {
  const files = {};
  const usedDataPaths = new Set();
  for (const r of results || []) {
    const ir = r.envelope && r.envelope.ir;
    if (!ir) continue;
    const rows =
      Array.isArray(ir.dataRows) && ir.dataRows.length
        ? ir.dataRows
        : ir.dataRow
          ? [ir.dataRow]
          : [];
    if (!rows.length) continue;
    const safeRows = _buildSafeRows(rows);
    if (!safeRows.length) continue;
    const caseSlug = slug(semanticResultTitle(r, 'test-case'));
    const dataPath = uniqueSemanticPath(`${pathPrefix}/${caseSlug}.json`, usedDataPaths);
    files[dataPath] = JSON.stringify(safeRows, null, 2) + '\n';
  }
  return files;
}

/**
 * Pure. Given TestDataSet DB rows (from prisma.testDataSet.findMany), emit one
 * CSV file per sheet at `<pathPrefix>/<dataset-slug>-<sheet-slug>.csv`.
 *
 * These are the full original uploaded datasets — every row, every column —
 * so the exported project ships alongside the real test data source. The
 * per-case *.json files that specs import are row-slices; these CSVs are the
 * master ledger the QA engineer can open in Excel and inspect or extend.
 */
function buildTestDataFiles(testDataSets, pathPrefix = 'tests/data') {
  const files = {};
  const usedPaths = new Set();
  let xlsx = null;
  try {
    xlsx = require('xlsx');
  } catch (_) {
    xlsx = null;
  }
  for (const ds of testDataSets || []) {
    let parsed;
    try {
      parsed = typeof ds.sheetsJson === 'string' ? JSON.parse(ds.sheetsJson) : ds.sheetsJson;
    } catch {
      continue;
    }
    const sheets = Array.isArray(parsed && parsed.sheets) ? parsed.sheets : [];
    const dsSlug = slug(humanReadableText(ds.name, 'dataset'), 'dataset');
    const workbook = xlsx ? xlsx.utils.book_new() : null;
    for (const sheet of sheets) {
      const headers = Array.isArray(sheet.headers) ? sheet.headers : [];
      const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
      if (!headers.length) continue;
      const sheetSlug = slug(sheet.name || 'sheet', 'sheet');
      const csvPath = uniqueSemanticPath(`${pathPrefix}/${dsSlug}-${sheetSlug}.csv`, usedPaths);
      const esc = (v) => {
        const s = v == null ? '' : String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')
          ? '"' + s.replace(/"/g, '""') + '"'
          : s;
      };
      const lines = [
        headers.map(esc).join(','),
        ...rows.map((row) => headers.map((h) => esc(row == null ? null : row[h])).join(',')),
      ];
      files[csvPath] = lines.join('\n') + '\n';
      if (workbook) {
        const aoa = [
          headers,
          ...rows.map((row) => headers.map((h) => (row == null ? '' : row[h]))),
        ];
        const ws = xlsx.utils.aoa_to_sheet(aoa);
        const sheetName =
          String(sheet.name || 'Sheet')
            .replace(/[\[\]*?/\\:]/g, ' ')
            .trim()
            .slice(0, 31) || 'Sheet';
        xlsx.utils.book_append_sheet(workbook, ws, sheetName);
      }
    }
    if (workbook && workbook.SheetNames && workbook.SheetNames.length) {
      const xlsxPath = uniqueSemanticPath(`${pathPrefix}/${dsSlug}.xlsx`, usedPaths);
      files[xlsxPath] = xlsx.write(workbook, { bookType: 'xlsx', type: 'buffer' });
    }
  }
  return files;
}

function previewText(value, fallback = '') {
  return String(value == null ? fallback : value)
    .replace(/\r/g, '')
    .replace(/\u0000/g, '')
    .slice(0, 500);
}

function previewCommentLines(value, prefix = '// ') {
  const lines = String(value || '')
    .split(/\n/)
    .map((line) => `${prefix}${line}`.trimEnd());
  return lines.length ? lines : [`${prefix}`.trimEnd()];
}

function blockedReasonForResult(result, blocked = []) {
  const match = (blocked || []).find(
    (item) =>
      item &&
      ((item.runResultId && item.runResultId === result.runResultId) ||
        (item.testCaseId && item.testCaseId === result.testCaseId)),
  );
  const reason =
    (match && (match.code || match.blockReason || match.detail)) ||
    result.blockedReason ||
    result.readinessStatus ||
    result.status ||
    'blocked';
  return {
    code: String(reason || 'blocked'),
    detail: (match && (match.detail || match.message)) || null,
    readinessStatus: (match && match.readinessStatus) || result.readinessStatus || null,
    reasons: Array.isArray(match && match.reasons)
      ? match.reasons
      : Array.isArray(result.readinessReasons)
        ? result.readinessReasons
        : [],
  };
}

function stepLabelForPreview(step, index) {
  if (typeof step === 'string') return step;
  if (!step || typeof step !== 'object') return `Step ${index + 1}`;
  return (
    step.authoredText ||
    step.userAuthoredText ||
    step.raw?.authoredText ||
    step.text ||
    step.description ||
    step.instruction ||
    step.name ||
    [step.action, step.target || step.selector || step.label].filter(Boolean).join(' ') ||
    `Step ${index + 1}`
  );
}

function assertionLabelForPreview(assertion, index) {
  if (typeof assertion === 'string') return assertion;
  if (!assertion || typeof assertion !== 'object') return `Assertion ${index + 1}`;
  return (
    assertion.text ||
    assertion.description ||
    assertion.expected ||
    assertion.expectedText ||
    assertion.target ||
    assertion.name ||
    assertion.id ||
    `Assertion ${index + 1}`
  );
}

function parsedDeclaredAssertions(result) {
  const raw = result && result.declaredAssertionsRaw;
  const parsed = decodeJson(raw, raw);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.assertions)) return parsed.assertions;
  return [];
}

function fallbackTargetLabel(step, index) {
  const raw = step && typeof step.raw === 'object' ? step.raw : {};
  const action = authoredActionForExport(step) || step?.action || 'interaction';
  if (String(action).toLowerCase() === 'navigate') return 'target application';
  const supplied =
    step &&
    (step.targetLabel ||
      step.elementLabel ||
      step.target ||
      step.element ||
      step.field ||
      step.label ||
      step.name ||
      raw.target ||
      raw.element);
  return humanReadableText(
    supplied,
    semanticActionLabel({ action }) || `authored step ${index + 1}`,
  );
}

function fallbackValue(step) {
  const raw = step && typeof step.raw === 'object' ? step.raw : {};
  return (
    step?.rawValue ??
    step?.value ??
    step?.valueToken ??
    step?.valueRef ??
    step?.input ??
    step?.textValue ??
    raw.rawValue ??
    raw.value ??
    raw.valueToken ??
    raw.valueRef
  );
}

function fallbackSteps(result) {
  const irSteps = Array.isArray(result?.envelope?.ir?.steps) ? result.envelope.ir.steps : [];
  const resolves = new Map(
    irSteps
      .filter((step) => step?.op === 'resolve' && step.as != null)
      .map((step) => [String(step.as), step]),
  );
  return irSteps.flatMap((step) => {
    if (
      !step ||
      step.op === 'resolve' ||
      step.op === 'assert' ||
      !replayStepHasPositiveExecutionProvenance(step)
    )
      return [];
    const resolve = step.target != null ? resolves.get(String(step.target)) : null;
    const target =
      resolve?.elementLabel ||
      resolve?.label ||
      resolve?.candidates?.find(Boolean)?.name ||
      resolve?.candidates?.find(Boolean)?.text ||
      step.targetLabel ||
      step.elementLabel ||
      step.target;
    if (step.op === 'waitFor') return [{ ...step, action: 'wait', target }];
    if (step.op === 'act') return [{ ...step, target }];
    return [step];
  });
}

function fallbackAssertions(result) {
  return (result?.envelope?.ir?.steps || []).filter(
    (step) => step?.op === 'assert' && replayStepHasPositiveExecutionProvenance(step),
  );
}

function resultHasPositiveExecution(result) {
  const steps = result?.envelope?.ir?.steps;
  return Array.isArray(steps) && steps.some(replayStepHasPositiveExecutionProvenance);
}

function fallbackDependencies(result) {
  const names = dependencyValues(result?.dependsOnNames).map((name) =>
    humanReadableText(name, 'Authored prerequisite'),
  );
  if (names.length) return names;
  return dependencyValues(result?.dependsOnIds).map(() => 'Authored prerequisite');
}

function semanticEnvName(label, fallback = 'VALUE') {
  const suffix =
    String(label || fallback)
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || fallback;
  return `QAAI_${suffix}`;
}

function fallbackValueBinding(step, label) {
  const value = fallbackValue(step);
  const envRef = typeof value === 'string' && value.match(/^(?:env|vault|fixture|masked):(.+)$/i);
  if (envRef)
    return {
      expression: `requiredEnv(${jsLiteral(envNameForRef(value) || semanticEnvName(envRef[1]))})`,
      javaExpression: `EnvReader.read(${jsLiteral(envNameForRef(value) || semanticEnvName(envRef[1]))})`,
      display: `{env:${envNameForRef(value) || semanticEnvName(envRef[1])}}`,
    };
  const token = typeof value === 'string' && value.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
  if (token) {
    const envName = semanticEnvName(token[1]);
    return {
      expression: `requiredEnv(${jsLiteral(envName)})`,
      javaExpression: `EnvReader.read(${jsLiteral(envName)})`,
      display: `{env:${envName}}`,
    };
  }
  const sensitive = /passw|secret|token|credential|otp|mfa/i.test(
    `${label || ''} ${step?.name || ''}`,
  );
  if (value == null || value === '' || sensitive) {
    const envName = semanticEnvName(label);
    return {
      expression: `requiredEnv(${jsLiteral(envName)})`,
      javaExpression: `EnvReader.read(${jsLiteral(envName)})`,
      display: `{env:${envName}}`,
    };
  }
  return { expression: jsLiteral(value), javaExpression: jsLiteral(value), display: String(value) };
}

function fallbackAssertionExpected(assertion) {
  const payload = assertion && typeof assertion.payload === 'object' ? assertion.payload : {};
  return (
    assertion?.expected ??
    assertion?.expectedText ??
    assertion?.value ??
    payload.expectedText ??
    payload.expectedUrlPattern ??
    payload.expected ??
    payload.text
  );
}

function fallbackAssertionTarget(assertion, index) {
  const payload = assertion && typeof assertion.payload === 'object' ? assertion.payload : {};
  return humanReadableText(
    assertion?.target ||
      assertion?.element ||
      assertion?.label ||
      payload.target ||
      payload.element,
    fallbackAssertionExpected(assertion) || `expected page state ${index + 1}`,
  );
}

function previewSpecExtension(adapterId) {
  if (String(adapterId || '').endsWith('-js')) return 'js';
  return 'ts';
}

function blockedPreviewSpecPath(result, adapterId, usedPaths) {
  const ext = previewSpecExtension(adapterId);
  const base = `tests/diagnostics/${readableModule(result)}/${readableCaseName(result)}.diagnostic.${ext}`;
  return uniqueSemanticPath(base, usedPaths);
}

function blockedPreviewPlaywrightSpec(result, block, adapterId, targetUrl = '') {
  const isCjs = adapterId === 'playwright-reference-js';
  const diagnostic = {
    schema: 'qaai-playwright-diagnostic/1',
    status: 'diagnostic_only',
    executable: false,
    discoveredByPlaywright: false,
    title: semanticResultTitle(result),
    runResultId: result?.runResultId || null,
    testCaseId: result?.testCaseId || null,
    sourceStatus: result?.status || null,
    reason: previewText(block?.code, 'source_execution_unavailable'),
    detail: previewText(block?.detail || block?.message, ''),
    targetUrl: targetUrl || null,
    message:
      'No Playwright test was emitted because no positively executed browser action, observed wait, or evaluated assertion was available.',
  };
  const literal = JSON.stringify(diagnostic, null, 2);
  return isCjs
    ? `// QAAI diagnostic artifact. This file is intentionally outside Playwright test discovery.\nmodule.exports = Object.freeze(${literal});\n`
    : `// QAAI diagnostic artifact. This file is intentionally outside Playwright test discovery.\nexport const qaaiDiagnostic = Object.freeze(${literal});\n`;
}

function gherkinValue(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ');
}

function blockedPreviewFeature(result, block, targetUrl = '') {
  const title = semanticResultTitle(result);
  const lines = [
    '@generated @runnable-unverified',
    `Feature: ${title}`,
    `  # Source-run diagnostic: ${previewText(block.code)}. The scenario remains enabled.`,
    '',
    `  Scenario: ${title}`,
  ];
  fallbackDependencies(result).forEach((dependency) =>
    lines.push(`    Given QAAI prerequisite "${gherkinValue(dependency)}" is recorded`),
  );
  fallbackSteps(result).forEach((step, index) => {
    const action = authoredActionForExport(step) || String(step?.action || 'unknown');
    const normalized = String(action)
      .replace(/[^a-z]/gi, '')
      .toLowerCase();
    const label = fallbackTargetLabel(step, index);
    if (normalized === 'navigate' || normalized === 'goto') {
      const url =
        step?.url || step?.targetUrl || step?.raw?.url || step?.raw?.targetUrl || targetUrl;
      if (url) lines.push(`    Given QAAI opens "${gherkinValue(url)}"`);
      else
        lines.push(
          `    When QAAI reports unresolved authored operation "${gherkinValue(`Navigation URL missing for ${label}`)}"`,
        );
    } else if (normalized === 'wait' || normalized === 'waitfor') {
      const timeout = Number(
        step?.timeoutMs ?? step?.waitContract?.timeoutMs ?? step?.condition?.timeoutMs ?? 10_000,
      );
      lines.push(
        `    When QAAI waits for "${gherkinValue(label)}" up to ${Number.isFinite(timeout) && timeout > 0 ? timeout : 10_000} milliseconds`,
      );
    } else {
      const needsValue = ['fill', 'type', 'selectoption', 'press', 'upload'].includes(normalized);
      const binding = needsValue ? fallbackValueBinding(step, label) : { display: '' };
      lines.push(
        `    When QAAI performs "${gherkinValue(action)}" on "${gherkinValue(label)}" with "${gherkinValue(binding.display)}"`,
      );
    }
  });
  fallbackAssertions(result).forEach((assertion, index) => {
    const expected = fallbackAssertionExpected(assertion);
    const target = fallbackAssertionTarget(assertion, index);
    const type = String(
      assertion?.channel || assertion?.type || assertion?.kind || '',
    ).toUpperCase();
    if (expected == null || expected === '')
      lines.push(
        `    Then QAAI reports unresolved authored operation "${gherkinValue(`Expected value missing for ${target}`)}"`,
      );
    else if (type.includes('URL') || assertion?.payload?.expectedUrlPattern)
      lines.push(`    Then QAAI URL contains "${gherkinValue(expected)}"`);
    else
      lines.push(
        `    Then QAAI expects "${gherkinValue(expected)}" from "${gherkinValue(target)}"`,
      );
  });
  if (!fallbackSteps(result).length && !fallbackAssertions(result).length) {
    lines.push(
      '    Then QAAI reports unresolved authored operation "No saved authored steps or assertions were available"',
    );
  }
  lines.push('    Then QAAI finalizes authored diagnostics');
  return lines.concat('').join('\n');
}

function fallbackPlaywrightBddGlue() {
  return `import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';

const { Given, When, Then } = createBdd();

function requiredValue(value: string): string {
  const match = String(value || '').match(/^\\{env:([^}]+)\\}$/);
  if (!match) return value;
  const resolved = process.env[match[1]];
  if (!resolved) throw new Error('Missing required environment value: ' + match[1]);
  return resolved;
}

function guessed(page: any, label: string, action: string) {
  const name = new RegExp(label.replace(/[.*+?^{}$()|[\\]\\\\]/g, '\\\\$&'), 'i');
  const normalized = action.toLowerCase().replace(/[^a-z]/g, '');
  // QAAI_GUESSED_LOCATOR: role/function inference used because verified DOM evidence was unavailable.
  if (normalized === 'fill' || normalized === 'type') return page.getByRole('textbox', { name }).first();
  if (normalized === 'selectoption') return page.getByRole('combobox', { name }).first();
  if (normalized === 'check' || normalized === 'uncheck') return page.getByRole('checkbox', { name }).first();
  if (normalized.includes('click')) return page.getByRole('button', { name }).first();
  return page.getByText(name).first();
}

Given('QAAI prerequisite {string} is recorded', async ({}, dependency: string) => {
  void dependency;
});

Given('QAAI opens {string}', async ({ page }, url: string) => {
  await page.goto(url);
});

When('QAAI waits for {string} up to {int} milliseconds', async ({ page }, label: string, timeout: number) => {
  await guessed(page, label, 'hover').waitFor({ state: 'visible', timeout });
});

When('QAAI performs {string} on {string} with {string}', async ({ page }, action: string, label: string, supplied: string) => {
  const normalized = action.toLowerCase().replace(/[^a-z]/g, '');
  if (normalized === 'navigateback') { await page.goBack(); return; }
  if (normalized === 'navigateforward') { await page.goForward(); return; }
  const supported = ['fill', 'type', 'click', 'doubleclick', 'tripleclick', 'hover', 'selectoption', 'check', 'uncheck', 'press', 'upload'];
  if (!supported.includes(normalized)) {
    expect.soft(false, 'QAAI could not compile non-locator operation: ' + action + ' on ' + label).toBe(true);
    return;
  }
  const element = guessed(page, label, normalized);
  const value = ['fill', 'type', 'selectoption', 'press', 'upload'].includes(normalized) ? requiredValue(supplied) : supplied;
  if (normalized === 'fill' || normalized === 'type') await element.fill(value);
  else if (normalized === 'click') await element.click();
  else if (normalized === 'doubleclick') await element.dblclick();
  else if (normalized === 'tripleclick') await element.click({ clickCount: 3 });
  else if (normalized === 'hover') await element.hover();
  else if (normalized === 'selectoption') await element.selectOption(value);
  else if (normalized === 'check') await element.check();
  else if (normalized === 'uncheck') await element.uncheck();
  else if (normalized === 'press') await element.press(value);
  else if (normalized === 'upload') await element.setInputFiles(value);
});

Then('QAAI URL contains {string}', async ({ page }, expected: string) => {
  await expect.soft(page).toHaveURL(new RegExp(expected, 'i'));
});

Then('QAAI expects {string} from {string}', async ({ page }, expected: string, label: string) => {
  // QAAI_GUESSED_LOCATOR: assertion target inferred from authored semantics.
  await expect.soft(guessed(page, label, 'hover')).toContainText(expected);
});

Then('QAAI reports unresolved authored operation {string}', async ({}, detail: string) => {
  expect.soft(false, detail).toBe(true);
});

Then('QAAI finalizes authored diagnostics', async () => {});
`;
}

function fallbackSeleniumBddGlue() {
  return `package com.qaai.steps;

import com.qaai.bdd.BddWorld;
import com.qaai.replayir.EnvReader;
import io.cucumber.java.en.Given;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;
import java.time.Duration;
import org.openqa.selenium.By;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.interactions.Actions;
import org.openqa.selenium.support.ui.ExpectedConditions;
import org.openqa.selenium.support.ui.Select;
import org.openqa.selenium.support.ui.WebDriverWait;
import org.testng.Reporter;
import org.testng.asserts.SoftAssert;

public class RunnableFallbackSteps {
  private final SoftAssert soft = new SoftAssert();

  private String value(String supplied) {
    if (supplied != null && supplied.startsWith("{env:") && supplied.endsWith("}")) {
      return EnvReader.read(supplied.substring(5, supplied.length() - 1));
    }
    return supplied;
  }

  private WebElement guessed(String label, String action) {
    String safe = label.replace("'", "’");
    String normalized = action.toLowerCase().replaceAll("[^a-z]", "");
    String xpath;
    // QAAI_GUESSED_LOCATOR: role/function inference used because verified DOM evidence was unavailable.
    if (normalized.equals("fill") || normalized.equals("type")) xpath = "//input[@aria-label='" + safe + "' or @placeholder='" + safe + "' or @name='" + safe + "'] | //textarea[@aria-label='" + safe + "' or @placeholder='" + safe + "']";
    else if (normalized.equals("selectoption")) xpath = "//select[@aria-label='" + safe + "' or @name='" + safe + "']";
    else if (normalized.equals("check") || normalized.equals("uncheck")) xpath = "//*[@role='checkbox' and (@aria-label='" + safe + "' or normalize-space(.)='" + safe + "')] | //input[@type='checkbox' and @aria-label='" + safe + "']";
    else if (normalized.contains("click")) xpath = "//*[@role='button' and (@aria-label='" + safe + "' or normalize-space(.)='" + safe + "')] | //button[normalize-space(.)='" + safe + "']";
    else xpath = "//*[normalize-space(.)='" + safe + "' or @aria-label='" + safe + "']";
    return new WebDriverWait(BddWorld.driver(), Duration.ofSeconds(10)).until(ExpectedConditions.visibilityOfElementLocated(By.xpath(xpath)));
  }

  @Given("QAAI prerequisite {string} is recorded")
  public void prerequisite(String dependency) { Reporter.log("Dependency: " + dependency); }

  @Given("QAAI opens {string}")
  public void open(String url) { BddWorld.driver().get(url); }

  @When("QAAI waits for {string} up to {int} milliseconds")
  public void waitFor(String label, int timeout) {
    new WebDriverWait(BddWorld.driver(), Duration.ofMillis(timeout)).until(ExpectedConditions.visibilityOf(guessed(label, "hover")));
  }

  @When("QAAI performs {string} on {string} with {string}")
  public void perform(String action, String label, String supplied) {
    String normalized = action.toLowerCase().replaceAll("[^a-z]", "");
    if (normalized.equals("navigateback")) { BddWorld.driver().navigate().back(); return; }
    if (normalized.equals("navigateforward")) { BddWorld.driver().navigate().forward(); return; }
    if (!(normalized.equals("fill") || normalized.equals("type") || normalized.equals("click") || normalized.equals("doubleclick") || normalized.equals("tripleclick") || normalized.equals("hover") || normalized.equals("selectoption") || normalized.equals("check") || normalized.equals("uncheck") || normalized.equals("press") || normalized.equals("upload"))) {
      soft.assertTrue(false, "QAAI could not compile non-locator operation: " + action + " on " + label);
      return;
    }
    WebElement element = guessed(label, normalized);
    String resolved = (normalized.equals("fill") || normalized.equals("type") || normalized.equals("selectoption") || normalized.equals("press") || normalized.equals("upload")) ? value(supplied) : supplied;
    if (normalized.equals("fill") || normalized.equals("type")) { element.clear(); element.sendKeys(resolved); }
    else if (normalized.equals("click")) element.click();
    else if (normalized.equals("doubleclick")) new Actions(BddWorld.driver()).doubleClick(element).perform();
    else if (normalized.equals("tripleclick")) new Actions(BddWorld.driver()).click(element).click(element).click(element).perform();
    else if (normalized.equals("hover")) new Actions(BddWorld.driver()).moveToElement(element).perform();
    else if (normalized.equals("selectoption")) new Select(element).selectByVisibleText(resolved);
    else if (normalized.equals("check")) { if (!element.isSelected()) element.click(); }
    else if (normalized.equals("uncheck")) { if (element.isSelected()) element.click(); }
    else if (normalized.equals("press") || normalized.equals("upload")) element.sendKeys(resolved);
  }

  @Then("QAAI URL contains {string}")
  public void urlContains(String expected) { soft.assertTrue(BddWorld.driver().getCurrentUrl().toLowerCase().contains(expected.toLowerCase()), "Expected URL to contain " + expected); }

  @Then("QAAI expects {string} from {string}")
  public void expectText(String expected, String label) {
    WebElement element = guessed(label, "hover");
    soft.assertTrue((element.getText() + " " + String.valueOf(element.getAttribute("value"))).contains(expected), "Expected " + label + " to contain " + expected);
  }

  @Then("QAAI reports unresolved authored operation {string}")
  public void unresolved(String detail) { soft.assertTrue(false, detail); }

  @Then("QAAI finalizes authored diagnostics")
  public void finish() { soft.assertAll(); }
}
`;
}

function seleniumXpath(label, action) {
  const literal = String(label || '').replace(/'/g, "', \"'\", '");
  const normalized = String(action || '').toLowerCase();
  if (['fill', 'type'].includes(normalized))
    return `//input[@aria-label='${literal}' or @placeholder='${literal}' or @name='${literal}'] | //textarea[@aria-label='${literal}' or @placeholder='${literal}' or @name='${literal}']`;
  if (normalized === 'selectoption')
    return `//select[@aria-label='${literal}' or @name='${literal}']`;
  if (['check', 'uncheck'].includes(normalized))
    return `//*[@role='checkbox' and (@aria-label='${literal}' or normalize-space(.)='${literal}')] | //input[@type='checkbox' and (@aria-label='${literal}' or @name='${literal}')]`;
  if (['click', 'doubleclick', 'tripleclick'].includes(normalized))
    return `//*[@role='button' and (@aria-label='${literal}' or normalize-space(.)='${literal}')] | //button[@aria-label='${literal}' or normalize-space(.)='${literal}']`;
  return `//*[normalize-space(.)='${literal}' or @aria-label='${literal}']`;
}

function emitFallbackSeleniumStep(step, index, usedRefs, targetUrl) {
  const action = authoredActionForExport(step) || String(step?.action || '');
  const normalized = String(action)
    .replace(/[^a-z]/gi, '')
    .toLowerCase();
  const label = fallbackTargetLabel(step, index);
  const lines = [
    `    Reporter.log(${jsLiteral(`${index + 1}. ${humanReadableText(step?.description || `${action} ${label}`, `Authored step ${index + 1}`)}`)});`,
  ];
  if (normalized === 'navigate' || normalized === 'goto') {
    const url = step?.url || step?.targetUrl || step?.raw?.url || step?.raw?.targetUrl || targetUrl;
    if (url) lines.push(`    driver.get(${jsLiteral(url)});`);
    else
      lines.push(
        `    soft.assertTrue(false, ${jsLiteral(`QAAI could not compile navigation because its URL is missing: ${label}`)});`,
      );
    return lines;
  }
  if (normalized === 'navigateback') {
    lines.push('    driver.navigate().back();');
    return lines;
  }
  if (normalized === 'navigateforward') {
    lines.push('    driver.navigate().forward();');
    return lines;
  }
  if (normalized === 'wait' || normalized === 'waitfor') {
    const timeout = Number(
      step?.timeoutMs ?? step?.waitContract?.timeoutMs ?? step?.condition?.timeoutMs ?? 10_000,
    );
    lines.push(
      '    // QAAI_GUESSED_LOCATOR: wait target inferred from authored semantics; replace with a DOM-verified locator if needed.',
    );
    lines.push(
      `    new WebDriverWait(driver, Duration.ofMillis(${Number.isFinite(timeout) && timeout > 0 ? timeout : 10_000}L)).until(ExpectedConditions.visibilityOfElementLocated(By.xpath(${jsLiteral(seleniumXpath(label, 'hover'))})));`,
    );
    return lines;
  }
  if (
    ![
      'fill',
      'type',
      'click',
      'doubleclick',
      'tripleclick',
      'hover',
      'selectoption',
      'check',
      'uncheck',
      'press',
      'upload',
    ].includes(normalized)
  ) {
    lines.push(
      `    soft.assertTrue(false, ${jsLiteral(`QAAI could not compile the non-locator operation '${action || 'unknown'}' for '${label}'. The authored step is preserved for repair.`)});`,
    );
    return lines;
  }
  const ref = semanticResolveRef(label, normalized, usedRefs);
  lines.push(
    '    // QAAI_GUESSED_LOCATOR: QAAI inferred this locator from the authored role/function because verified DOM evidence was unavailable. Replace it with a DOM-verified locator if it does not match.',
  );
  lines.push(
    `    WebElement ${ref} = new WebDriverWait(driver, Duration.ofSeconds(10)).until(ExpectedConditions.visibilityOfElementLocated(By.xpath(${jsLiteral(seleniumXpath(label, normalized))})));`,
  );
  const binding = fallbackValueBinding(step, label);
  if (normalized === 'fill' || normalized === 'type')
    lines.push(`    ${ref}.clear();`, `    ${ref}.sendKeys(${binding.javaExpression});`);
  else if (normalized === 'click') lines.push(`    ${ref}.click();`);
  else if (normalized === 'doubleclick')
    lines.push(`    new Actions(driver).doubleClick(${ref}).perform();`);
  else if (normalized === 'tripleclick')
    lines.push(`    new Actions(driver).click(${ref}).click(${ref}).click(${ref}).perform();`);
  else if (normalized === 'hover')
    lines.push(`    new Actions(driver).moveToElement(${ref}).perform();`);
  else if (normalized === 'selectoption')
    lines.push(`    new Select(${ref}).selectByVisibleText(${binding.javaExpression});`);
  else if (normalized === 'check') lines.push(`    if (!${ref}.isSelected()) ${ref}.click();`);
  else if (normalized === 'uncheck') lines.push(`    if (${ref}.isSelected()) ${ref}.click();`);
  else if (normalized === 'press') lines.push(`    ${ref}.sendKeys(${binding.javaExpression});`);
  else if (normalized === 'upload') lines.push(`    ${ref}.sendKeys(${binding.javaExpression});`);
  return lines;
}

function blockedPreviewJava(result, block, className, targetUrl = '') {
  const title = semanticResultTitle(result);
  const usedRefs = new Set();
  const lines = [
    'package com.qaai.replayir;',
    '',
    'import java.time.Duration;',
    'import org.openqa.selenium.By;',
    'import org.openqa.selenium.WebElement;',
    'import org.openqa.selenium.interactions.Actions;',
    'import org.openqa.selenium.support.ui.ExpectedConditions;',
    'import org.openqa.selenium.support.ui.Select;',
    'import org.openqa.selenium.support.ui.WebDriverWait;',
    'import org.testng.Reporter;',
    'import org.testng.annotations.Test;',
    'import org.testng.asserts.SoftAssert;',
    '',
    `public class ${className} extends BaseTest {`,
    '  @Test',
    '  public void replayAuthoredFlow() {',
    '    SoftAssert soft = new SoftAssert();',
    `    Reporter.log(${jsLiteral(`Source-run diagnostic: ${previewText(block.code)}. The test remains enabled.`)});`,
  ];
  fallbackDependencies(result).forEach((dependency) =>
    lines.push(`    Reporter.log(${jsLiteral(`Dependency: ${dependency}`)});`),
  );
  fallbackSteps(result).forEach((step, index) =>
    lines.push(...emitFallbackSeleniumStep(step, index, usedRefs, targetUrl)),
  );
  fallbackAssertions(result).forEach((assertion, index) => {
    const expected = fallbackAssertionExpected(assertion);
    const target = fallbackAssertionTarget(assertion, index);
    const type = String(
      assertion?.channel || assertion?.type || assertion?.kind || '',
    ).toUpperCase();
    if (expected == null || expected === '')
      lines.push(
        `    soft.assertTrue(false, ${jsLiteral(`QAAI could not compile assertion because its expected value is missing: ${target}`)});`,
      );
    else if (type.includes('URL') || assertion?.payload?.expectedUrlPattern)
      lines.push(
        `    soft.assertTrue(driver.getCurrentUrl().toLowerCase().contains(${jsLiteral(String(expected).toLowerCase())}), ${jsLiteral(`Expected URL to contain ${expected}`)});`,
      );
    else {
      const ref = semanticResolveRef(target, 'hover', usedRefs);
      lines.push(
        '    // QAAI_GUESSED_LOCATOR: assertion target inferred from authored semantics because verified DOM evidence was unavailable.',
      );
      lines.push(
        `    WebElement ${ref} = new WebDriverWait(driver, Duration.ofSeconds(10)).until(ExpectedConditions.visibilityOfElementLocated(By.xpath(${jsLiteral(seleniumXpath(target, 'hover'))})));`,
      );
      lines.push(
        `    soft.assertTrue((${ref}.getText() + " " + String.valueOf(${ref}.getAttribute("value"))).contains(${jsLiteral(String(expected))}), ${jsLiteral(`Expected ${target} to contain ${expected}`)});`,
      );
    }
  });
  if (!fallbackSteps(result).length && !fallbackAssertions(result).length)
    lines.push(
      '    soft.assertTrue(false, "QAAI has no saved authored steps or assertions for this case. Add the source contract and regenerate.");',
    );
  lines.push('    soft.assertAll();', '  }', '}', '');
  return lines.join('\n');
}

function buildBlockedPreviewPackage({
  adapterId,
  adapterVersion,
  results = [],
  blocked = [],
  findings = [],
  targetUrl = '',
  envDefaults = {},
} = {}) {
  const preparedResults = (results || []).map((result) => prepareResultForExport(result));
  const executablePreparedResults = preparedResults.filter(resultHasPositiveExecution);
  const diagnosticPreparedResults = preparedResults.filter(
    (result) => !resultHasPositiveExecution(result),
  );
  try {
    let compiled = null;
    let selectedAdapter = null;
    if (adapterId === 'replayir-bdd' && executablePreparedResults.length) {
      compiled = replayIrBdd.compileResults({ results: executablePreparedResults });
    } else if (adapterId === 'selenium-bdd-reference' && executablePreparedResults.length) {
      compiled = seleniumBddReference.compileResults({ results: executablePreparedResults });
    } else if (executablePreparedResults.length) {
      selectedAdapter = registry.getAdapter(adapterId || 'playwright-reference');
      if (selectedAdapter)
        compiled = compileResults({
          adapter: selectedAdapter,
          results: executablePreparedResults,
          allowIncompletePreview: true,
        });
    }
    if (compiled && Array.isArray(compiled.admitted) && compiled.admitted.length) {
      const envVars = collectEnvVars(
        preparedResults.map((result) => result.envelope).filter(Boolean),
      );
      const authState = { files: {}, storageStateRel: null, findings: [] };
      let files;
      if (adapterId === 'replayir-bdd') {
        files = replayIrBdd.assemblePackage({
          admitted: compiled.admitted,
          locators: compiled.locators,
          envVars,
          authState,
          operationFiles: compiled.operationFiles,
          targetUrl,
        });
      } else if (adapterId === 'selenium-bdd-reference') {
        files = seleniumBddReference.assemblePackage({
          admitted: compiled.admitted,
          locators: compiled.locators,
          envVars,
          authState,
          targetUrl,
        });
      } else if (typeof selectedAdapter?.assemblePackage === 'function') {
        files = selectedAdapter.assemblePackage({
          admitted: compiled.admitted,
          envVars,
          authState,
          targetUrl,
          envDefaults,
        });
      } else {
        files = assemblePackage({
          adapterId: compiled.adapterId || adapterId,
          admitted: compiled.admitted,
          envVars,
          authState,
          targetUrl,
          envDefaults,
        });
      }
      for (const admitted of compiled.admitted) {
        if (admitted.dataFilePath && admitted.dataFileContent)
          files[admitted.dataFilePath] = admitted.dataFileContent;
      }
      const effectiveAdapterId = compiled.adapterId || adapterId || '';
      const artifactEntries = compiled.admitted
        .map((entry) => ({
          ...entry,
          filePath: entry && (entry.filePath || entry.featurePath),
        }))
        .filter(
          (entry) =>
            entry &&
            entry.filePath &&
            Object.prototype.hasOwnProperty.call(files, entry.filePath) &&
            String(files[entry.filePath] == null ? '' : files[entry.filePath]).trim().length > 0,
        );
      const isFrameworkRunnableArtifact = (entry) => {
        const rel = String((entry && entry.filePath) || '');
        if (effectiveAdapterId === 'selenium-reference' || effectiveAdapterId === 'selenium-pom') {
          return /Test\.java$/i.test(rel) && !/BaseTest\.java$/i.test(rel);
        }
        if (
          effectiveAdapterId === 'replayir-bdd' ||
          effectiveAdapterId === 'selenium-bdd-reference'
        ) {
          return /\.feature$/i.test(rel);
        }
        if (PLAYWRIGHT_ADAPTER_IDS.has(effectiveAdapterId)) {
          return /\.spec\.[cm]?[jt]sx?$/i.test(rel);
        }
        return true;
      };
      const hasCompleteRunnableCoverage =
        compiled.admitted.length > 0 &&
        artifactEntries.length === compiled.admitted.length &&
        artifactEntries.every(
          (entry) => entry.diagnosticOnly === true || isFrameworkRunnableArtifact(entry),
        );
      if (hasCompleteRunnableCoverage) {
        const artifacts = artifactEntries.flatMap((entry) => {
          const diagnosticOnly = entry.diagnosticOnly === true;
          const runResultIds =
            Array.isArray(entry.runResultIds) && entry.runResultIds.length
              ? entry.runResultIds
              : [entry.runResultId || null];
          const testCaseIds =
            Array.isArray(entry.testCaseIds) && entry.testCaseIds.length
              ? entry.testCaseIds
              : [entry.testCaseId || null];
          return runResultIds.map((runResultId, index) => ({
            runResultId,
            testCaseId: testCaseIds[index] || testCaseIds[0] || null,
            file: entry.filePath,
            source: diagnosticOnly ? 'adapter_diagnostic' : 'replayir',
            scriptGenerationStatus: diagnosticOnly
              ? 'generated_with_diagnostics'
              : 'generated',
            scriptRunStatus: 'not_run',
            certificationStatus: diagnosticOnly ? 'diagnostic_only' : 'uncertified',
            blockers: [],
            repairHints: [],
          }));
        });
        if (diagnosticPreparedResults.length) {
          const usedDiagnosticPaths = new Set(Object.keys(files));
          const usedDiagnosticClassNames = new Set();
          for (const result of diagnosticPreparedResults) {
            const block = blockedReasonForResult(result, blocked);
            let artifactFile = null;
            if (
              effectiveAdapterId === 'replayir-bdd' ||
              effectiveAdapterId === 'selenium-bdd-reference'
            ) {
              artifactFile = uniqueSemanticPath(
                `features/${readableCaseName(result)}.feature`,
                usedDiagnosticPaths,
              );
              files[artifactFile] = blockedPreviewFeature(result, block, targetUrl);
            } else if (
              effectiveAdapterId === 'selenium-reference' ||
              effectiveAdapterId === 'selenium-pom'
            ) {
              const classStem =
                readableCaseName(result)
                  .replace(/(^|-)([a-z0-9])/g, (_, __, c) => String(c).toUpperCase())
                  .replace(/[^A-Za-z0-9]/g, '')
                  .slice(0, 70) || 'GeneratedCase';
              let className = `${classStem}Test`;
              let duplicate = 2;
              while (usedDiagnosticClassNames.has(className))
                className = `${classStem}${duplicate++}Test`;
              usedDiagnosticClassNames.add(className);
              artifactFile = uniqueSemanticPath(
                `src/test/java/com/qaai/replayir/${className}.java`,
                usedDiagnosticPaths,
              );
              files[artifactFile] = blockedPreviewJava(
                result,
                block,
                className,
                targetUrl,
              );
            } else {
              artifactFile = blockedPreviewSpecPath(
                result,
                effectiveAdapterId,
                usedDiagnosticPaths,
              );
              files[artifactFile] = blockedPreviewPlaywrightSpec(
                result,
                block,
                effectiveAdapterId,
                targetUrl,
              );
            }
            artifacts.push({
              testCaseId: result.testCaseId || null,
              runResultId: result.runResultId || null,
              file: artifactFile,
              source: 'authored_contract_diagnostic',
              scriptGenerationStatus: 'generated_with_diagnostics',
              scriptRunStatus: 'not_run',
              certificationStatus: 'diagnostic_only',
              blockers: [],
              repairHints: [],
            });
          }
        }
        const runArtifactPlane = buildRunArtifactPlane({ results: preparedResults });
        files['evidence/run-artifact-plane.json'] =
          JSON.stringify(runArtifactPlane, null, 2) + '\n';
        const immutableContract = buildImmutableExecutionEvidenceContract({
          results: preparedResults,
        });
        files['evidence/immutable-execution-evidence-contract.json'] =
          JSON.stringify(immutableContract, null, 2) + '\n';
        files['evidence/upstream-conductor-requirements.json'] =
          JSON.stringify(
            {
              schema: 'qaai-upstream-conductor-requirements/1',
              summary: immutableContract.summary,
              requirements: immutableContract.upstreamRequirements,
            },
            null,
            2,
          ) + '\n';
        const materializationStatus = buildPostRunMaterializationStatus({
          results: preparedResults,
        });
        files['evidence/post-run-materialization-status.json'] =
          JSON.stringify(materializationStatus, null, 2) + '\n';
        const manifest = {
          schema: 'qaai-replay-export-manifest/1',
          adapterId: compiled.adapterId || adapterId || null,
          adapterVersion: compiled.adapterVersion || adapterVersion || null,
          exportValid: false,
          outputAvailable: artifacts.length > 0,
          validationStatus: 'not_run',
          runnable: false,
          certified: false,
          allBlocked: false,
          entries: compiled.manifestEntries || [],
          artifacts,
          scriptArtifacts: artifacts,
          runArtifactPlane: runArtifactPlane.summary,
          immutableExecutionEvidence: immutableContract.summary,
          postRunMaterialization: materializationStatus.summary,
          findings: [...(compiled.findings || []), ...(findings || [])].slice(0, 100),
          sourceRunDiagnostics: blocked || [],
          generatedAt: new Date().toISOString(),
        };
        files['evidence/live-output-status.json'] =
          JSON.stringify(
            {
              schema: 'qaai-live-output-status/1',
              status: 'generated_draft',
              allBlocked: false,
              outputAvailable: manifest.outputAvailable,
              exportValid: false,
              validationStatus: 'not_run',
              runnable: false,
              certified: false,
              adapterId: manifest.adapterId,
              artifacts,
              scriptArtifacts: artifacts,
              runArtifactPlane: runArtifactPlane.summary,
              immutableExecutionEvidence: immutableContract.summary,
              postRunMaterialization: materializationStatus.summary,
              findings: manifest.findings,
              generatedAt: manifest.generatedAt,
            },
            null,
            2,
          ) + '\n';
        files['EXPORT_MANIFEST.json'] = JSON.stringify(manifest, null, 2) + '\n';
        return files;
      }
    }
  } catch (error) {
    // The legacy diagnostic artifact below remains a last-resort representation
    // only when the selected framework adapter itself cannot render any case.
  }
  let files = {};
  const artifacts = [];
  const usedPaths = new Set();
  const usedClassNames = new Set();
  const frameworkEntries = [];
  const isBdd = adapterId === 'replayir-bdd' || adapterId === 'selenium-bdd-reference';
  const isSelenium =
    adapterId === 'selenium-reference' ||
    adapterId === 'selenium-pom' ||
    adapterId === 'selenium-bdd-reference';
  const fallbackResults = preparedResults.length
    ? preparedResults
    : [
        {
          caseName: 'Missing authored source contract',
          moduleName: 'Generated diagnostics',
          status: 'needs_human',
          declaredSteps: [],
          declaredAssertionsRaw: '[]',
          readinessStatus: 'source_contract_missing',
        },
      ];
  for (const result of fallbackResults) {
    const block = blockedReasonForResult(result, blocked);
    let artifactFile = null;
    if (isBdd) {
      const unique = uniqueSemanticPath(`features/${readableCaseName(result)}.feature`, usedPaths);
      const featureContent = blockedPreviewFeature(result, block, targetUrl);
      files[unique] = featureContent;
      frameworkEntries.push(
        adapterId === 'replayir-bdd'
          ? { featurePath: unique, featureContent }
          : { filePath: unique, content: featureContent },
      );
      artifactFile = unique;
    } else if (isSelenium) {
      const classStem =
        readableCaseName(result)
          .replace(/(^|-)([a-z0-9])/g, (_, __, c) => String(c).toUpperCase())
          .replace(/[^A-Za-z0-9]/g, '')
          .slice(0, 70) || 'GeneratedCase';
      let className = `${classStem}Test`;
      let duplicate = 2;
      while (usedClassNames.has(className)) className = `${classStem}${duplicate++}Test`;
      usedClassNames.add(className);
      const unique = `src/test/java/com/qaai/replayir/${className}.java`;
      const content = blockedPreviewJava(result, block, className, targetUrl);
      files[unique] = content;
      frameworkEntries.push({ filePath: unique, content });
      artifactFile = unique;
    } else {
      const rel = blockedPreviewSpecPath(result, adapterId, usedPaths);
      const content = blockedPreviewPlaywrightSpec(result, block, adapterId, targetUrl);
      files[rel] = content;
      frameworkEntries.push({ filePath: rel, content });
      artifactFile = rel;
    }
    artifacts.push({
      testCaseId: result.testCaseId || null,
      runResultId: result.runResultId || null,
      file: artifactFile,
      source: 'authored_contract_diagnostic',
      scriptGenerationStatus: 'generated_with_diagnostics',
      scriptRunStatus: 'not_run',
      certificationStatus: 'diagnostic_only',
      blockers: [],
      repairHints: [],
    });
  }
  try {
    if (adapterId === 'replayir-bdd') {
      files = replayIrBdd.assemblePackage({
        admitted: frameworkEntries,
        locators: {},
        envVars: [],
        authState: null,
        operationFiles: null,
        targetUrl,
      });
      files['steps/replayir.steps.ts'] = fallbackPlaywrightBddGlue();
    } else if (adapterId === 'selenium-bdd-reference') {
      files = seleniumBddReference.assemblePackage({
        admitted: frameworkEntries,
        locators: new Map(),
        envVars: [],
        targetUrl,
      });
      files['src/test/java/com/qaai/steps/RunnableFallbackSteps.java'] = fallbackSeleniumBddGlue();
    } else if (isSelenium) {
      const fallbackAdapter = registry.getAdapter(adapterId) || seleniumReference;
      files =
        typeof fallbackAdapter.assemblePackage === 'function'
          ? fallbackAdapter.assemblePackage({ admitted: frameworkEntries, envVars: [], targetUrl })
          : seleniumReference.assemblePackage({
              admitted: frameworkEntries,
              envVars: [],
              targetUrl,
            });
    } else {
      files = assemblePackage({
        adapterId: adapterId || 'playwright-reference',
        admitted: frameworkEntries,
        envVars: [],
        authState: null,
        targetUrl,
      });
    }
  } catch (error) {
    // Keep the already-rendered selected-framework files when only shell assembly fails.
    files = Object.fromEntries(
      frameworkEntries.flatMap((entry) => {
        const rel = entry.filePath || entry.featurePath;
        const content = entry.content || entry.featureContent;
        return rel ? [[rel, content]] : [];
      }),
    );
  }
  const fallbackOutputAvailable = artifacts.length > 0;
  const runArtifactPlane = buildRunArtifactPlane({ results: fallbackResults });
  files['evidence/run-artifact-plane.json'] = JSON.stringify(runArtifactPlane, null, 2) + '\n';
  const immutableContract = buildImmutableExecutionEvidenceContract({ results: fallbackResults });
  files['evidence/immutable-execution-evidence-contract.json'] =
    JSON.stringify(immutableContract, null, 2) + '\n';
  files['evidence/upstream-conductor-requirements.json'] =
    JSON.stringify(
      {
        schema: 'qaai-upstream-conductor-requirements/1',
        summary: immutableContract.summary,
        requirements: immutableContract.upstreamRequirements,
      },
      null,
      2,
    ) + '\n';
  const materializationStatus = buildPostRunMaterializationStatus({ results: fallbackResults });
  files['evidence/post-run-materialization-status.json'] =
    JSON.stringify(materializationStatus, null, 2) + '\n';
  const summary = {
    schema: 'qaai-live-output-status/1',
    status: fallbackOutputAvailable ? 'generated_draft' : 'no_source_cases',
    allBlocked: false,
    outputAvailable: fallbackOutputAvailable,
    exportValid: false,
    validationStatus: 'not_run',
    runnable: false,
    certified: false,
    targetUrl: targetUrl || null,
    adapterId: adapterId || null,
    adapterVersion: adapterVersion || null,
    totalCases: (results || []).length,
    blocked: (blocked || []).length,
    generatedScriptFiles: Object.keys(files).length,
    artifacts,
    scriptArtifacts: artifacts,
    runArtifactPlane: runArtifactPlane.summary,
    immutableExecutionEvidence: immutableContract.summary,
    postRunMaterialization: materializationStatus.summary,
    findings: (findings || []).slice(0, 50),
    message:
      'QAAI preserved available executed evidence and authored diagnostics. Diagnostic artifacts are downloadable but are not Playwright tests.',
    generatedAt: new Date().toISOString(),
  };
  files['evidence/live-output-status.json'] = JSON.stringify(summary, null, 2) + '\n';
  files['EXPORT_MANIFEST.json'] =
    JSON.stringify(
      {
        schema: 'qaai-replay-export-manifest/1',
        adapterId: adapterId || null,
        adapterVersion: adapterVersion || null,
        exportValid: false,
        outputAvailable: fallbackOutputAvailable,
        validationStatus: 'not_run',
        runnable: false,
        certified: false,
        allBlocked: false,
        artifacts,
        scriptArtifacts: artifacts,
        runArtifactPlane: runArtifactPlane.summary,
        immutableExecutionEvidence: immutableContract.summary,
        postRunMaterialization: materializationStatus.summary,
        findings: (findings || []).slice(0, 50),
        generatedAt: summary.generatedAt,
      },
      null,
      2,
    ) + '\n';
  files['README.md'] = [
    '# QAAI generated script output bundle',
    '',
    'This bundle is visible whenever QAAI has saved case or run context.',
    '',
    '- Generated files preserve the selected framework shape whenever enough context exists.',
    '- Script health notes are preserved in EXPORT_MANIFEST.json and evidence/live-output-status.json.',
    '- Use the Output Files assistant to improve files when health notes remain, then rerun script validation.',
    '',
    `Adapter: ${adapterId || 'unknown'}`,
    `Target URL: ${targetUrl || 'unknown'}`,
    `Preview files: ${Object.keys(files).filter((p) => p !== 'README.md' && !p.startsWith('evidence/')).length}`,
    '',
  ].join('\n');
  return files;
}

function _sheetRowsFromSets(testDataSets, sheetName) {
  const wanted = String(sheetName || '')
    .trim()
    .toLowerCase();
  for (const ds of testDataSets || []) {
    let parsed;
    try {
      parsed = typeof ds.sheetsJson === 'string' ? JSON.parse(ds.sheetsJson) : ds.sheetsJson;
    } catch {
      parsed = null;
    }
    const sheets = Array.isArray(parsed && parsed.sheets)
      ? parsed.sheets
      : Array.isArray(ds && ds.sheets)
        ? ds.sheets
        : [];
    const sheet = sheets.find(
      (s) =>
        String((s && s.name) || '')
          .trim()
          .toLowerCase() === wanted,
    );
    if (sheet) return Array.isArray(sheet.rows) ? sheet.rows : [];
  }
  return [];
}

function _expectedRowsForBinding(testDataSets, binding) {
  const rows = _sheetRowsFromSets(testDataSets, binding && binding.sheet);
  if (!rows.length) return 0;
  const selector = String((binding && binding.rowSelector) || 'all')
    .trim()
    .toLowerCase();
  if (!selector || selector === 'all') return rows.length;
  const rowClassColumn = binding && binding.rowClassColumn;
  if (!rowClassColumn) return rows.length;
  const filtered = rows.filter((row) =>
    String((row && row[rowClassColumn]) || '')
      .trim()
      .toLowerCase()
      .includes(selector),
  );
  return filtered.length || rows.length;
}

function buildDataMatrixCoverageReport({ results = [], testDataSets = [] } = {}) {
  const groups = new Map();
  for (const result of results || []) {
    const binding =
      result && result.dataBinding && typeof result.dataBinding === 'object'
        ? result.dataBinding
        : null;
    if (!binding || !binding.sheet) continue;
    const key = `${result.testCaseId || 'case'}\u0001${binding.sheet}\u0001${binding.rowSelector || 'all'}`;
    if (!groups.has(key)) {
      groups.set(key, {
        testCaseId: result.testCaseId || null,
        caseName: result.caseName || null,
        sheet: binding.sheet,
        rowSelector: binding.rowSelector || 'all',
        expectedRows: _expectedRowsForBinding(testDataSets, binding),
        exportedRows: new Set(),
        runResultIds: [],
      });
    }
    const group = groups.get(key);
    if (result.dataRowIndex != null) group.exportedRows.add(Number(result.dataRowIndex));
    group.runResultIds.push(result.runResultId || result.id || null);
  }

  const cases = [];
  const findings = [];
  for (const group of groups.values()) {
    const exportedCount = group.exportedRows.size || group.runResultIds.length;
    const row = {
      testCaseId: group.testCaseId,
      caseName: group.caseName,
      sheet: group.sheet,
      rowSelector: group.rowSelector,
      expectedRows: group.expectedRows,
      exportedRows: exportedCount,
      runResultIds: group.runResultIds.filter(Boolean),
      ok: group.expectedRows === 0 || exportedCount >= group.expectedRows,
    };
    cases.push(row);
    if (!row.ok) {
      findings.push({
        rule: 'data_matrix_export_incomplete',
        severity: 'error',
        testCaseId: row.testCaseId,
        sheet: row.sheet,
        message: `Data-bound case exported ${row.exportedRows}/${row.expectedRows} row iteration(s) for sheet "${row.sheet}". Rerun the case so every selected data row has recorded ReplayIR before exporting.`,
      });
    }
  }
  return {
    ok: findings.length === 0,
    caseCount: cases.length,
    cases,
    findings,
  };
}

function collectEnvRefs(value, names) {
  if (value == null) return;
  if (typeof value === 'string') {
    const n = envNameForRef(value);
    if (n) names.add(n);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectEnvRefs(item, names));
    return;
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((item) => collectEnvRefs(item, names));
  }
}

function collectEnvVars(envelopes, operationPlans = []) {
  const names = new Set(['QAAI_TARGET_URL']);
  for (const env of envelopes) {
    for (const step of (env && env.ir && env.ir.steps) || []) {
      if (step && step.valueRef && step.rawValue == null) {
        const n = envNameForRef(step.valueRef);
        if (n) names.add(n);
      }
    }
    collectEnvRefs(env && env.ir && env.ir.dataRow, names);
    collectEnvRefs(env && env.ir && env.ir.dataRows, names);
  }
  for (const plan of operationPlans || []) {
    collectEnvRefs(plan && plan.operations, names);
  }
  return [...names].sort();
}

function normalizeTargetOrigin(value) {
  if (!value || typeof value !== 'string') return '';
  const raw = value.trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return u.origin;
  } catch (_) {
    return raw.replace(/\/+$/, '');
  }
}

function deriveTargetUrlFromResults(results, fallback = '') {
  const projectTarget = normalizeTargetOrigin(fallback);
  if (projectTarget) return projectTarget;
  for (const r of results || []) {
    const steps = (r && r.envelope && r.envelope.ir && r.envelope.ir.steps) || [];
    for (const step of steps) {
      const value = step && (step.url || step.pageUrl || step.pageUrlBefore);
      const normalized = normalizeTargetOrigin(value);
      if (normalized) return normalized;
    }
  }
  return '';
}

function envFile(envVars = [], defaults = {}) {
  const keys = [...new Set(envVars || [])].sort();
  return (
    keys
      .map((name) => {
        const value = Object.prototype.hasOwnProperty.call(defaults || {}, name)
          ? defaults[name]
          : '';
        return `${name}=${String(value == null ? '' : value).replace(/[\r\n]+/g, ' ')}`;
      })
      .join('\n') + '\n'
  );
}

function envDefaultsFromFile(content) {
  const defaults = {};
  for (const line of String(content || '').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) defaults[match[1]] = match[2];
  }
  return defaults;
}

function filterEnvFilesToGeneratedReferences(files) {
  if (!files || (typeof files['.env'] !== 'string' && typeof files['.env.example'] !== 'string'))
    return files;
  const referenced = new Set(['QAAI_TARGET_URL']);
  const readEnvRe = /\breadEnv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)/g;
  const processEnvDotRe = /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
  const processEnvBracketRe = /\bprocess\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g;
  for (const [rel, content] of Object.entries(files)) {
    if (!/\.(?:js|ts|cjs|mjs)$/.test(rel) || /^evidence\//.test(rel)) continue;
    const text = String(content || '');
    for (const expression of [readEnvRe, processEnvDotRe, processEnvBracketRe]) {
      expression.lastIndex = 0;
      let match;
      while ((match = expression.exec(text))) referenced.add(match[1]);
    }
  }
  const envDefaults = envDefaultsFromFile(files['.env']);
  const keys = [...referenced].sort();
  return {
    ...files,
    '.env': envFile(keys, envDefaults),
    '.env.example': envFile(keys, {}),
  };
}

function credentialRoleFromText(value) {
  const text = String(value || '').toLowerCase();
  if (/password|pass\b|pwd/.test(text)) return 'password';
  if (/username|user\b|login|email|phone|skype/.test(text)) return 'username';
  return null;
}

function declaredCredentialFills(declaredSteps) {
  const byRole = { username: [], password: [] };
  for (const step of Array.isArray(declaredSteps) ? declaredSteps : []) {
    if (!step) continue;
    const action = String(step.action || '').toLowerCase();
    if (!['fill', 'type', 'enter'].includes(action)) continue;
    const role = credentialRoleFromText(
      `${step.target || ''} ${step.element || ''} ${step.locator_hint || ''}`,
    );
    if (!role) continue;
    const candidate = step.value ?? step.text ?? step.input;
    const value = typeof candidate === 'string' ? candidate.trim() : '';
    if (!value || /^<|^\{\{/.test(value)) continue;
    byRole[role].push({
      value,
      actionText:
        `${step.action || ''} ${step.element || ''} ${step.target || ''} ${step.expected || ''}`.toLowerCase(),
    });
  }
  return byRole;
}

function declaredCredentialIsNegative(role, entry, caseName) {
  if (!entry || !entry.value) return false;
  const text = `${caseName || ''} ${entry.actionText || ''}`.toLowerCase();
  const literal = String(entry.value).toLowerCase();
  if (role === 'username') {
    if (
      /valid username/.test(text) &&
      !/invalid username|wrong username|non[-\s]?existent username|bad[_\s-]*user|payload|injection|sql|xss/.test(
        text,
      )
    )
      return false;
    return (
      /invalid username|wrong username|non[-\s]?existent username|bad[_\s-]*user|username.*(payload|injection|sql|xss)|(payload|injection|sql|xss).*username/.test(
        text,
      ) ||
      /bad[_\s-]*user|nonexistent|invalid|['";<>]|--\s|\/\*|\*\/|or\s+\d+=\d+|union.*select|alert\s*\(/.test(
        literal,
      )
    );
  }
  if (role === 'password') {
    if (
      /valid password/.test(text) &&
      !/wrong password|invalid password|bad password|password.*(payload|injection|sql|xss)|(payload|injection|sql|xss).*password/.test(
        text,
      )
    )
      return false;
    return (
      /wrong password|invalid password|bad password|password.*(payload|injection|sql|xss)|(payload|injection|sql|xss).*password/.test(
        text,
      ) ||
      /wrong|invalid|bad|['";<>]|--\s|\/\*|\*\/|or\s+\d+=\d+|union.*select|alert\s*\(/.test(literal)
    );
  }
  return false;
}

function credentialEnvNames(index) {
  return index === 0
    ? { username: envContract.PRIMARY_USER_ENV, password: envContract.PRIMARY_PASS_ENV }
    : { username: `QAAI_USER${index + 1}_USERNAME`, password: `QAAI_USER${index + 1}_PASSWORD` };
}

function bindCredentialEnvironment({ testCredentials = null, results = [] } = {}) {
  const profile = envContract.buildCredentialProfile({ testCredentials });
  const slots = profile.users.map((user, index) => ({
    index,
    username: String(user.username || ''),
    password: String(user.password || ''),
    env: { username: user.userEnv, password: user.passEnv },
  }));
  const defaults = {};
  for (const slot of slots) {
    if (slot.username) defaults[slot.env.username] = slot.username;
    if (slot.password) defaults[slot.env.password] = slot.password;
  }

  const findOrCreateSlot = (username, password) => {
    const exact = slots.find(
      (slot) =>
        (!username || slot.username === username) && (!password || slot.password === password),
    );
    if (exact) return exact;
    const env = credentialEnvNames(slots.length);
    const slot = { index: slots.length, username: username || '', password: password || '', env };
    slots.push(slot);
    return slot;
  };

  for (const result of Array.isArray(results) ? results : []) {
    const steps = result && result.envelope && result.envelope.ir && result.envelope.ir.steps;
    if (!Array.isArray(steps)) continue;
    const declaredByRole = declaredCredentialFills(result.declaredSteps);
    const bindings = { username: [], password: [] };
    const cursor = { username: 0, password: 0 };
    for (const step of steps) {
      if (
        !step ||
        step.op !== 'act' ||
        !['fill', 'type'].includes(step.action) ||
        step.rawValue != null
      )
        continue;
      const envName = typeof step.valueRef === 'string' ? envNameForRef(step.valueRef) : null;
      const role = credentialRoleFromText(`${envName || ''} ${step.target || ''}`);
      if (!envName || !role || !/^QAAI_(?:USER\d+_)?(?:USERNAME|PASSWORD)$/.test(envName)) continue;
      const entry = declaredByRole[role][cursor[role]++] || null;
      if (!entry || declaredCredentialIsNegative(role, entry, result.caseName)) continue;
      bindings[role].push({ step, value: entry.value });
    }
    const pairCount = Math.max(bindings.username.length, bindings.password.length);
    for (let index = 0; index < pairCount; index += 1) {
      const usernameBinding = bindings.username[index] || null;
      const passwordBinding = bindings.password[index] || null;
      const slot = findOrCreateSlot(
        usernameBinding && usernameBinding.value,
        passwordBinding && passwordBinding.value,
      );
      if (usernameBinding) {
        usernameBinding.step.valueRef = `env:${slot.env.username}`;
        if (!slot.username) slot.username = usernameBinding.value;
        defaults[slot.env.username] = usernameBinding.value;
      }
      if (passwordBinding) {
        passwordBinding.step.valueRef = `env:${slot.env.password}`;
        if (!slot.password) slot.password = passwordBinding.value;
        defaults[slot.env.password] = passwordBinding.value;
      }
    }
  }
  return {
    defaults,
    credentialValues: new Set(Object.values(defaults).filter((value) => String(value).trim())),
  };
}

function authStateRefFromEnvelope(env) {
  const profile = env && env.ir && env.ir.authProfile;
  const ref = profile && typeof profile === 'object' ? profile.storageStateRef : null;
  return ref ? String(ref) : null;
}

function parseArrayJson(value) {
  const parsed = decodeJson(value, []);
  return Array.isArray(parsed)
    ? parsed.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim())
    : [];
}

function dataRowsUsed(ir) {
  const rows = Array.isArray(ir && ir.dataRows)
    ? ir.dataRows
    : ir && ir.dataRow
      ? [ir.dataRow]
      : [];
  return rows.some(
    (row) =>
      row && row.fields && typeof row.fields === 'object' && Object.keys(row.fields).length > 0,
  );
}

// Reduce the live assertion-check log (RunResult.assertionCheckResults — possibly many
// observations per assertion, from different sources/timestamps) to ONE effective
// outcome per assertionId. This is what makes the export honour the live VERDICT per
// assertion instead of blindly hard-asserting everything:
//   not_matched  — the assertion failed live (a real defect) → export must reproduce it
//   matched      — verified live → export hard-asserts (it should pass)
//   uncheckable  — live could not verify it (e.g. transient_window_missed) → export must
//                  NOT fabricate a hard gate the live run never resolved (would fail for a
//                  reason absent from live — the L3 artifact class). Annotate only.
// Priority: a real mismatch dominates a positive check, which dominates uncheckable.
function reduceAssertionOutcomes(value) {
  const parsed = decodeJson(value, null);
  if (!parsed) return {};
  const arr = Array.isArray(parsed) ? parsed : Object.values(parsed);
  const rank = { uncheckable: 0, matched: 1, not_matched: 2 };
  const byId = {};
  for (const a of arr) {
    if (!a || typeof a !== 'object') continue;
    const id = a.assertionId || a.id;
    const outcome = a.outcome || a.result;
    if (!id || !(outcome in rank)) continue;
    const existing = byId[id];
    if (!existing || rank[outcome] > rank[existing.outcome]) {
      // domGrounded: carry through — false means text matched only via
      // browser_evaluate cache or semantic rescue, not from the ARIA snapshot.
      // Once false, stays false (a higher-rank outcome doesn't un-set it).
      byId[id] = {
        outcome,
        domGrounded: a.domGrounded !== false && (!existing || existing.domGrounded !== false),
      };
    }
  }
  return byId;
}

function buildAssertionCardinalityFindings(results = []) {
  const out = [];
  for (const r of results || []) {
    const state = fidelity.declaredAssertionsStateFor({
      declaredAssertions: r && r.declaredAssertionsRaw,
    });
    const live = (r && r.liveOutcomes) || {};
    const liveIds = Object.keys(live).filter(Boolean);
    if (state.state === 'missing' || state.state === 'invalid') {
      out.push({
        rule: 'assertion_cardinality_gap',
        severity: 'warning',
        gapKind:
          state.state === 'missing' ? 'declared_assertions_missing' : 'declared_assertions_invalid',
        runResultId: r && r.runResultId,
        testCaseId: r && r.testCaseId,
        declaredAssertionsState: state.state,
        declaredCount: null,
        liveOutcomeCount: liveIds.length,
        missingAssertions: [],
        extraLiveOutcomeIds: liveIds,
        message:
          state.state === 'missing'
            ? `declaredAssertions is missing; cannot certify assertion cardinality (${liveIds.length} live outcome(s) recorded)`
            : `declaredAssertions is invalid (${state.error || 'invalid'}); cannot certify assertion cardinality (${liveIds.length} live outcome(s) recorded)`,
      });
      continue;
    }

    const declared = state.declared || [];
    const declaredIds = new Set(declared.map((a) => a && a.id).filter(Boolean));
    const missing = declared.filter((a) => !a.id || !(a.id in live));
    const extra = liveIds.filter((id) => !declaredIds.has(id));
    if (declared.length === liveIds.length && missing.length === 0 && extra.length === 0) continue;
    out.push({
      rule: 'assertion_cardinality_gap',
      severity: 'warning',
      gapKind:
        declared.length > liveIds.length
          ? 'declared_without_live_outcome'
          : extra.length
            ? 'live_outcome_without_declared_assertion'
            : 'count_mismatch',
      runResultId: r && r.runResultId,
      testCaseId: r && r.testCaseId,
      declaredAssertionsState: state.state,
      declaredCount: declared.length,
      liveOutcomeCount: liveIds.length,
      missingAssertions: missing.map((a) => ({
        id: a.id || null,
        type: a.type,
        criticality: a.criticality,
      })),
      extraLiveOutcomeIds: extra,
      message: `assertion cardinality gap: ${declared.length} declared assertion(s), ${liveIds.length} recorded live outcome(s)`,
    });
  }
  return out;
}

function locatorText(candidate) {
  if (!candidate || typeof candidate !== 'object') return '';
  return String(
    candidate.name || candidate.text || candidate.selector || candidate.testId || '',
  ).trim();
}

function tokenSet(value) {
  return new Set(
    String(value || '')
      .toLowerCase()
      .replace(/^(env|vault|fixture|masked):/i, '')
      .replace(/\b(qaai|td|masked|vault|fixture|input|field|value|data)\b/g, ' ')
      .split(/[^a-z0-9]+/)
      .map((v) => v.trim())
      .filter((v) => v && v.length > 1),
  );
}

function hasTokenOverlap(a, b) {
  const aa = tokenSet(a);
  const bb = tokenSet(b);
  if (!aa.size || !bb.size) return false;
  for (const token of aa) {
    if (bb.has(token)) return true;
  }
  return false;
}

function hasRepeatedSingleChar(value) {
  const text = String(value || '').trim();
  return text.length >= 40 && new Set(text).size <= 2;
}

function intrinsicallyBadCandidate(candidate) {
  const text = locatorText(candidate);
  if (!text) return false;
  if (text.length > 120) return true;
  if (hasRepeatedSingleChar(text)) return true;
  if (/[<>]/.test(text) || /script/i.test(text)) return true;
  if (/[\u0080-\u00ff]/.test(text)) return true;
  if (/^[^a-z0-9]+$/i.test(text) && text.length >= 3) return true;
  return false;
}

function durableCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  const strategy = String(candidate.strategy || '').toLowerCase();
  if (strategy === 'css') {
    const selector = String(candidate.selector || '').trim();
    return (
      !!selector &&
      !/^ref\s*=\s*e\d+$/i.test(selector) &&
      !locatorExpressionIsUnstable(selector) &&
      !/(?:^|[#="'_-])[0-9a-f]{16,}(?:$|["'\] .:#_-])/i.test(selector)
    );
  }
  if (strategy === 'testid') return !!candidate.testId;
  if (strategy === 'placeholder' || strategy === 'label' || strategy === 'text')
    return !!candidate.text;
  if (strategy === 'role')
    return !!candidate.role && !!candidate.name && !intrinsicallyBadCandidate(candidate);
  return false;
}

function legacyExportableCandidate(candidates) {
  const list = normalizeCandidates(candidates || []);
  return (
    list.find(
      (candidate) => durableCandidate(candidate) && !intrinsicallyBadCandidate(candidate),
    ) || null
  );
}

function legacyCandidateExpression(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const strategy = String(candidate.strategy || '').toLowerCase();
  if (strategy === 'css' && candidate.selector) return String(candidate.selector);
  if (strategy === 'testid' && candidate.testId)
    return `getByTestId(${JSON.stringify(String(candidate.testId))})`;
  if (
    (strategy === 'placeholder' || strategy === 'label' || strategy === 'text') &&
    candidate.text
  ) {
    return `getBy${strategy.charAt(0).toUpperCase()}${strategy.slice(1)}(${JSON.stringify(String(candidate.text))})`;
  }
  if (strategy === 'role' && candidate.role && candidate.name) {
    return `getByRole(${JSON.stringify(String(candidate.role))}, { name: ${JSON.stringify(String(candidate.name))} })`;
  }
  return locatorText(candidate) || null;
}

function inputRole(candidate) {
  return (
    candidate &&
    candidate.strategy === 'role' &&
    ['textbox', 'searchbox', 'combobox'].includes(String(candidate.role || '').toLowerCase())
  );
}

function candidateMatchesValueRef(candidate, valueRef) {
  if (!inputRole(candidate)) return true;
  if (durableCandidate(candidate)) return true;
  const text = locatorText(candidate);
  if (!text) return true;
  return hasTokenOverlap(text, valueRef);
}

function isGuessedLocatorStep(step) {
  return !!(
    step &&
    (step.guessedLocator === true ||
      step.locatorConfidence === 'guessed' ||
      step.locatorProvenance?.kind === 'qaai_guessed_locator' ||
      (Array.isArray(step.candidates) &&
        step.candidates.some(
          (candidate) => candidate && candidate.provenance === 'qaai_guessed_locator',
        )))
  );
}

function isLocatorOnlyGap(gap) {
  const code = String(
    (gap && (gap.code || gap.type || gap.rule || gap.reason)) || '',
  ).toLowerCase();
  return (
    /locator|target_resolution|excavation/.test(code) &&
    !/runtime_ref|\[ref|secret|syntax|method|step_parity|data_ref/.test(code)
  );
}

function guessedResolveCount(ir) {
  return (Array.isArray(ir && ir.steps) ? ir.steps : []).filter(
    (step) => step && step.op === 'resolve' && isGuessedLocatorStep(step),
  ).length;
}

function downgradeAdvisoryLocatorFinding(finding) {
  if (!finding || typeof finding !== 'object') return finding;
  const rule = String(finding.rule || finding.code || '').toLowerCase();
  const advisory = [
    'missing_locator_recipe',
    'unscoped_locator',
    'ast_locator_missing',
    'action_ledger_missing_verified_locator',
    'locator_certification',
    'locator_evidence_missing',
    'missing_action_time_locator',
    'action_missing_owned_locator',
  ].some((token) => rule.includes(token));
  if (!advisory || /runtime_ref|secret|syntax|missing_locator_(?:file|key)/.test(rule))
    return finding;
  return { ...finding, severity: 'warning', nonBlocking: true };
}

function assessReplayLocatorEvidence(ir) {
  const steps = Array.isArray(ir && ir.steps) ? ir.steps : [];
  const byAs = new Map();
  const findings = [];
  if (ir && ir.locatorCertification) {
    findings.push(
      ...locatorIntelligenceV2
        .locatorCertificationFindings(ir.locatorCertification, { severity: 'warning' })
        .map((finding) => ({
          ...finding,
          severity: 'warning',
        })),
    );
  }
  steps.forEach((step, index) => {
    if (step && step.op === 'resolve' && step.as) {
      byAs.set(step.as, { step, index, candidates: normalizeCandidates(step.candidates || []) });
    }
  });

  for (const entry of byAs.values()) {
    const candidates = entry.candidates || [];
    if (!replayLocatorContract.isVerifiedActionLocator(entry.step.actionLocator)) {
      findings.push({
        rule: 'replayir_missing_action_time_locator',
        category: 'platform_evidence_integrity_failure',
        severity: 'warning',
        nonBlocking: true,
        stepIndex: entry.index,
        message: `resolve '${entry.step.as}' is missing exact-node verified action-time locator evidence; candidates remain diagnostic and are never promoted into runnable code.`,
      });
    }
    if (!candidates.length) {
      findings.push({
        rule: 'replayir_no_replayable_locator',
        severity: 'warning',
        nonBlocking: true,
        stepIndex: entry.index,
        message: `resolve '${entry.step.as}' has no replayable locator candidates after normalization.`,
      });
      continue;
    }
    if (candidates.every(intrinsicallyBadCandidate)) {
      findings.push({
        rule: 'replayir_locator_polluted',
        severity: 'warning',
        nonBlocking: true,
        stepIndex: entry.index,
        candidates: candidates.map(locatorText).filter(Boolean).slice(0, 5),
        message: `resolve '${entry.step.as}' contains only polluted locator candidates.`,
      });
    }
  }

  for (const [index, step] of steps.entries()) {
    if (!step || step.op !== 'act' || !step.target) continue;
    const actionName = String(step.action || '').toLowerCase();
    const locatorNeeded = [
      'click',
      'doubleclick',
      'tripleclick',
      'fill',
      'type',
      'selectoption',
      'check',
      'uncheck',
      'press',
      'hover',
      'upload',
      'drag',
    ].includes(actionName);
    if (locatorNeeded && !replayLocatorContract.isVerifiedActionLocator(step.actionLocator)) {
      const entry = byAs.get(step.target);
      const resolveHasLocator =
        entry &&
        replayLocatorContract.isVerifiedActionLocator(entry.step.actionLocator);
      findings.push({
        rule: 'replayir_action_missing_owned_locator',
        category: 'platform_evidence_integrity_failure',
        severity: 'warning',
        nonBlocking: true,
        stepIndex: index,
        resolveIndex: entry ? entry.index : null,
        message: resolveHasLocator
          ? `act '${step.action}' targets '${step.target}' but does not own its verified LocatorRecipe; export can only be certified after action-level locator ownership is recorded.`
          : `act '${step.action}' targets '${step.target}' without verified action-level locator evidence.`,
      });
    }
    if (!step.valueRef) continue;
    const action = String(step.action || '').toLowerCase();
    if (!['fill', 'type', 'selectoption'].includes(action)) continue;
    const entry = byAs.get(step.target);
    if (!entry) continue;
    const candidates = (entry.candidates || []).filter(
      (candidate) => !intrinsicallyBadCandidate(candidate),
    );
    if (!candidates.length) continue;
    const usable = candidates.filter((candidate) =>
      candidateMatchesValueRef(candidate, step.valueRef),
    );
    if (!usable.length) {
      findings.push({
        rule: 'replayir_locator_value_pollution',
        severity: 'warning',
        nonBlocking: true,
        stepIndex: entry.index,
        actionIndex: index,
        valueRef: step.valueRef,
        candidates: candidates.map(locatorText).filter(Boolean).slice(0, 5),
        message: `fill/select target '${step.target}' appears to use the entered value as its locator name instead of a page label/placeholder/selector.`,
      });
    }
  }

  return { ok: !findings.some((finding) => finding && finding.severity === 'error'), findings };
}

function concreteAssertionExpected(step) {
  if (!step || typeof step !== 'object') return false;
  if (step.expected != null && String(step.expected).trim() !== '') return true;
  if (step.expectedRef != null && String(step.expectedRef).trim() !== '') return true;
  if (step.dataExpected != null && String(step.dataExpected).trim() !== '') return true;
  if (
    step.expectedSignals &&
    typeof step.expectedSignals === 'object' &&
    Object.keys(step.expectedSignals).length
  )
    return true;
  if (step.script && String(step.script).trim() !== '') return true;
  return false;
}

function hasConcreteReplayAssertion(ir) {
  const steps = Array.isArray(ir && ir.steps) ? ir.steps : [];
  return steps.some((step) => {
    if (!step || step.op !== 'assert') return false;
    const channel = String(step.channel || '').toUpperCase();
    if (!channel || channel === 'ACTION_COMPLETED') return false;
    return !!(step.contractRef || step.id) && concreteAssertionExpected(step);
  });
}

function replayArtifactIsStrict(artifact) {
  return (
    !!artifact && artifact.source === 'replayir' && artifact.scriptGenerationStatus === 'generated'
  );
}

function resultMatchesArtifact(result, artifact) {
  if (!result || !artifact) return false;
  if (
    artifact.runResultId &&
    result.runResultId &&
    String(artifact.runResultId) === String(result.runResultId)
  )
    return true;
  return !!(
    artifact.testCaseId &&
    result.testCaseId &&
    String(artifact.testCaseId) === String(result.testCaseId)
  );
}

function decodeEvidenceJson(value, fallback = null) {
  return decodeJson(value, fallback);
}

function latestLedgerForResult(result) {
  const fromEnvelope = result && result.envelope && result.envelope.evidenceCompletenessLedger;
  if (fromEnvelope && typeof fromEnvelope === 'object') return fromEnvelope;
  const capture = (result && result.captureFirstEvidence) || {};
  if (capture.evidenceCompleteness && typeof capture.evidenceCompleteness === 'object')
    return capture.evidenceCompleteness;
  const ledgers = Array.isArray(capture.evidenceCompletenessLedgers)
    ? capture.evidenceCompletenessLedgers
    : [];
  const latest = ledgers[ledgers.length - 1];
  if (!latest) return null;
  const parsed = decodeEvidenceJson(latest.ledgerJson, null);
  if (parsed && typeof parsed === 'object') return parsed;
  return {
    runResultId: latest.runResultId || result.runResultId || null,
    testCaseId: latest.testCaseId || result.testCaseId || null,
    plannedExecutableStepCount: latest.plannedExecutableStepCount || 0,
    actionEvidenceCount: latest.actionEvidenceCount || 0,
    replayIrActionCount: latest.replayIrActionCount || 0,
    compiledActionCount: latest.compiledActionCount || 0,
    generatedMethodCount: latest.generatedMethodCount || 0,
    validatedActionCount: latest.validatedActionCount || 0,
    plannedAssertionCount: latest.plannedAssertionCount || 0,
    assertionEvidenceCount: latest.assertionEvidenceCount || 0,
    finalAssertionEvidenceCount: latest.finalAssertionEvidenceCount || 0,
    missingEvidenceCount: latest.missingEvidenceCount || 0,
    manualGateCount: latest.manualGateCount || 0,
    evidenceStatus: latest.missingEvidenceCount === 0 ? 'complete' : 'capture_failed',
  };
}

function validHistoricalArtifactPath(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || /^\[object\s+object\]$/i.test(normalized)) return null;
  if (/^[\[{]/.test(normalized)) {
    try {
      const decoded = JSON.parse(normalized);
      if (decoded && typeof decoded === 'object') return null;
    } catch (_) {
      // A legitimate path can begin with a bracket. Keep non-JSON strings.
    }
  }
  return normalized;
}

function sanitizeHistoricalArtifactPaths(value) {
  if (Array.isArray(value)) return value.map((entry) => sanitizeHistoricalArtifactPaths(entry));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/^(?:path|filePath|tracePath|artifactPath)$/i.test(key)) {
      const normalized = validHistoricalArtifactPath(raw);
      if (normalized) out[key] = normalized;
      continue;
    }
    out[key] = sanitizeHistoricalArtifactPaths(raw);
  }
  return out;
}

function normalizeEvidenceRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const out = { ...row };
    for (const key of Object.keys(out)) {
      if (
        /Json$/i.test(key) ||
        key === 'evidenceJson' ||
        key === 'locatorRecipeJson' ||
        key === 'loginActionEvidenceIds'
      ) {
        out[key] = decodeEvidenceJson(out[key], out[key]);
      }
    }
    return sanitizeHistoricalArtifactPaths(out);
  });
}

function buildCaptureFirstEvidencePackage({ results = [] } = {}) {
  const entries = (Array.isArray(results) ? results : []).map((result) => {
    const capture = (result && result.captureFirstEvidence) || {};
    const ledger = latestLedgerForResult(result);
    const envelope = (result && result.envelope) || null;
    return {
      runResultId: (result && result.runResultId) || null,
      testCaseId: (result && result.testCaseId) || null,
      caseName: (result && result.caseName) || null,
      status: (result && result.status) || null,
      overallRunStatus: capture.overallRunStatus || ledger?.overallRunStatus || null,
      executionStatus: capture.executionStatus || ledger?.executionStatus || null,
      evidenceStatus: capture.evidenceStatus || ledger?.evidenceStatus || null,
      scriptStatus: capture.scriptStatus || ledger?.scriptStatus || null,
      liveScriptLedger: (result && result.liveScriptLedger) || null,
      replayIrComplete: envelope ? envelope.complete === true : false,
      replayIrGapCount: Array.isArray(envelope && envelope.gaps) ? envelope.gaps.length : 0,
      ledger,
      actionEvidences: normalizeEvidenceRows(capture.actionEvidences),
      locatorRecipes: normalizeEvidenceRows(capture.locatorRecipes),
      assertionEvidences: normalizeEvidenceRows(capture.assertionEvidences),
      authSetupEvidences: normalizeEvidenceRows(capture.authSetupEvidences),
      navigationEvidences: normalizeEvidenceRows(capture.navigationEvidences),
      traceArtifacts: normalizeEvidenceRows(capture.traceArtifacts),
      replayIrCertifications: normalizeEvidenceRows(capture.replayIrCertifications),
    };
  });
  const missingLedgerCount = entries.filter((entry) => !entry.ledger).length;
  const evidenceCompleteCount = entries.filter(
    (entry) =>
      entry.ledger &&
      entry.ledger.evidenceStatus === 'complete' &&
      Number(entry.ledger.missingEvidenceCount || 0) === 0,
  ).length;
  const replayIrCompleteCount = entries.filter(
    (entry) => entry.replayIrComplete && entry.replayIrGapCount === 0,
  ).length;
  return {
    schema: 'qaai-capture-first-evidence/1',
    summary: {
      resultCount: entries.length,
      evidenceCompleteCount,
      replayIrCompleteCount,
      missingLedgerCount,
      generatedAt: new Date().toISOString(),
    },
    entries,
  };
}

function explicitGuessedLocatorManifestEntry(entry) {
  const source = String(entry?.source || '').toLowerCase();
  const provenance = String(
    entry?.locatorProvenance?.kind || entry?.locatorProvenance?.source || '',
  ).toLowerCase();
  return /qaai[_-]?guessed|semantic.*guess/.test(`${source} ${provenance}`);
}

function refreshFinalLocatorEvidenceMetrics(files, results = []) {
  let manifest = [];
  try {
    const parsed = JSON.parse(files?.['evidence/locator-manifest.json'] || '[]');
    manifest = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch (_) {
    return;
  }
  if (!manifest.length) return;
  for (const result of Array.isArray(results) ? results : []) {
    const caseKeys = new Set(
      [result?.runResultId, result?.testCaseId].filter(Boolean).map((value) => String(value)),
    );
    const entries = manifest.filter((entry) => caseKeys.has(String(entry?.caseKey || '')));
    if (!entries.length || !result?.envelope) continue;
    const guessedLocatorCount = entries.filter(explicitGuessedLocatorManifestEntry).length;
    const verifiedLocatorCount = entries.filter(
      (entry) => entry?.verified === true || entry?.verificationStatus === 'verified',
    ).length;
    const contractBackedLocatorCount = entries.filter(
      (entry) => String(entry?.source || '') === 'authoredAssertionContract',
    ).length;
    const missingLocatorCount = entries.filter(
      (entry) => !String(entry?.expr || entry?.expression || '').trim(),
    ).length;
    result.envelope.evidenceBuiltReplayIr = {
      ...(result.envelope.evidenceBuiltReplayIr || {}),
      emittedLocatorCount: entries.length,
      verifiedLocatorCount,
      contractBackedLocatorCount,
      guessedLocatorCount,
      missingLocatorCount,
    };
  }
}

const FINAL_LOCATOR_METRIC_NAMES = Object.freeze([
  'emittedLocatorCount',
  'verifiedLocatorCount',
  'contractBackedLocatorCount',
  'guessedLocatorCount',
  'missingLocatorCount',
]);

function finalLocatorMetricsForResult(result) {
  const metrics = result?.envelope?.evidenceBuiltReplayIr;
  if (!metrics || typeof metrics !== 'object') return null;
  return Object.fromEntries(
    FINAL_LOCATOR_METRIC_NAMES
      .filter((name) => Number.isFinite(Number(metrics[name])))
      .map((name) => [name, Number(metrics[name])]),
  );
}

function applyFinalLocatorMetricsToLedger(ledger, metrics) {
  if (!ledger || typeof ledger !== 'object' || !metrics) return ledger;
  for (const [name, value] of Object.entries(metrics)) {
    const capturedName = `captured${name.charAt(0).toUpperCase()}${name.slice(1)}`;
    if (ledger[capturedName] === undefined && ledger[name] !== undefined) {
      ledger[capturedName] = ledger[name];
    }
    ledger[name] = value;
  }
  return ledger;
}

function exportedActionTransactions(result = {}) {
  const decoded = decodeJson(result.stepResults, result.stepResults);
  const rows = Array.isArray(decoded) ? decoded : [];
  return rows
    .map((row, index) => {
      const transaction = row?.actionTransaction;
      if (!transaction || typeof transaction !== 'object') return null;
      const outcome = transaction.canonicalOutcome && typeof transaction.canonicalOutcome === 'object'
        ? transaction.canonicalOutcome
        : null;
      return {
        transactionId: transaction.transactionId || null,
        actionOccurrenceId: transaction.actionOccurrenceId || null,
        stepId: transaction.stepId || row.stepId || row.id || null,
        sequenceIndex: Number.isFinite(Number(transaction.sequenceIndex))
          ? Number(transaction.sequenceIndex)
          : index,
        actionKind: transaction.action?.kind || row.action || row.type || null,
        target: transaction.action?.target || row.target || row.element || null,
        status: transaction.status || null,
        dispatchStatus: transaction.dispatchStatus || null,
        dispatchTimestamp: transaction.dispatchTimestamp || null,
        dispatchAttemptCount: Number(transaction.dispatchAttemptCount || 0),
        canonicalOutcome: outcome ? {
          status: outcome.status || null,
          outcomeKind: outcome.outcomeKind || null,
          matched: outcome.matched === true ? true : outcome.matched === false ? false : null,
          checked: outcome.checked === true,
          reason: outcome.reason || null,
          continuation: outcome.continuation || null,
          completedAt: outcome.completedAt || null,
        } : null,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.sequenceIndex - right.sequenceIndex);
}

function rowHasAny(row, keys = []) {
  return keys.some((key) => {
    const value = row && row[key];
    return value != null && String(value).trim().length > 0;
  });
}

function buildImmutableExecutionEvidenceContract({ results = [] } = {}) {
  const entries = [];
  const upstreamRequirements = [];
  const addRequirement = (entry, field, detail) => {
    const requirement = {
      code: 'UPSTREAM_CONDUCTOR_REQUIREMENT',
      field,
      consumer: 'Output Files ReplayIR -> ActionGraph -> Playwright POM projection',
      runResultId: entry.runResultId,
      testCaseId: entry.testCaseId,
      detail,
      nonBlocking: true,
    };
    entry.missingFields.push(field);
    entry.requirements.push(requirement);
    upstreamRequirements.push(requirement);
  };

  for (const result of results || []) {
    const capture = result?.captureFirstEvidence || {};
    const actionEvidences = normalizeEvidenceRows(capture.actionEvidences);
    const locatorRecipes = normalizeEvidenceRows(capture.locatorRecipes);
    const assertionEvidences = normalizeEvidenceRows(capture.assertionEvidences);
    const transactions = exportedActionTransactions(result);
    const committedTransactions = transactions.filter((transaction) =>
      /committed|passed|success/i.test(String(transaction.status || transaction.canonicalOutcome?.status || '')),
    );
    const entry = {
      runId: result?.runId || null,
      runResultId: result?.runResultId || result?.id || null,
      testCaseId: result?.testCaseId || null,
      caseName: result?.caseName || null,
      status: result?.status || null,
      evidenceAuthority: 'committed_browser_truth_only',
      synchronousWriteRequired: true,
      heavyMaterializationAllowedInline: false,
      actionEvidenceCount: actionEvidences.length,
      locatorRecipeCount: locatorRecipes.length,
      assertionEvidenceCount: assertionEvidences.length,
      transactionCount: transactions.length,
      committedTransactionCount: committedTransactions.length,
      missingFields: [],
      requirements: [],
    };

    if (!entry.runResultId) {
      addRequirement(entry, 'runResultId', 'Every evidence row must preserve the RunResult identity.');
    }
    if (!entry.testCaseId) {
      addRequirement(entry, 'testCaseId', 'Every evidence row must preserve the TestCase identity.');
    }
    if (!actionEvidences.length && !committedTransactions.length && /pass|fail|blocked|needs_human/i.test(String(result?.status || ''))) {
      addRequirement(
        entry,
        'actionEvidences[] or stepResults[].actionTransaction',
        'Persist at least one immutable action/transaction record for every executed browser operation.',
      );
    }
    for (const [index, transaction] of committedTransactions.entries()) {
      if (!transaction.transactionId)
        addRequirement(entry, `stepResults[${index}].actionTransaction.transactionId`, 'Committed action transaction must carry a stable transactionId.');
      if (!transaction.actionOccurrenceId)
        addRequirement(entry, `stepResults[${index}].actionTransaction.actionOccurrenceId`, 'Committed action transaction must carry actionOccurrenceId for exactly-once projection.');
      if (!transaction.stepId)
        addRequirement(entry, `stepResults[${index}].actionTransaction.stepId`, 'Committed action transaction must retain authored/runtime step identity.');
      if (!transaction.canonicalOutcome)
        addRequirement(entry, `stepResults[${index}].actionTransaction.canonicalOutcome`, 'Committed action transaction must retain browser-truth outcome.');
    }
    for (const [index, row] of actionEvidences.entries()) {
      if (!rowHasAny(row, ['actionOccurrenceId', 'occurrenceKey']))
        addRequirement(entry, `actionEvidences[${index}].actionOccurrenceId`, 'Action evidence must retain occurrence identity.');
      if (!rowHasAny(row, ['operationId', 'stepId', 'contractStepId']))
        addRequirement(entry, `actionEvidences[${index}].operationId`, 'Action evidence must retain the authored/runtime operation id.');
      if (!rowHasAny(row, ['action', 'operation', 'toolName', 'tool']))
        addRequirement(entry, `actionEvidences[${index}].action`, 'Action evidence must retain the browser operation kind.');
    }
    entry.complete = entry.missingFields.length === 0;
    entries.push(entry);
  }

  return {
    schema: 'qaai-immutable-execution-evidence-contract/1',
    authority: 'downstream_output_contract',
    summary: {
      resultCount: entries.length,
      completeCount: entries.filter((entry) => entry.complete).length,
      incompleteCount: entries.filter((entry) => !entry.complete).length,
      upstreamRequirementCount: upstreamRequirements.length,
    },
    invariants: [
      'The tiny immutable evidence record is the only synchronous Output-required write at resolve/commit time.',
      'ReplayIR, ActionGraph, code generation, screenshots, videos, and package validation are post-run materialization work.',
      'Missing immutable evidence is reported as an upstream requirement; Output Files must not fabricate actions, assertions, or locators from narration.',
    ],
    upstreamRequirements,
    entries,
  };
}

function materializationDigest(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value == null ? null : value))
    .digest('hex');
}

function buildPostRunMaterializationStatus({ results = [] } = {}) {
  const immutable = buildImmutableExecutionEvidenceContract({ results });
  const requirements = [];
  const entries = (results || []).map((result) => {
    const immutableEntry =
      immutable.entries.find(
        (entry) =>
          (entry.runResultId && entry.runResultId === (result.runResultId || result.id)) ||
          (entry.testCaseId && entry.testCaseId === result.testCaseId),
      ) || null;
    const executionContractPresent = !!result.executionContract;
    const actionGraphPresent = !!result.actionGraph;
    const replayIrPresent = !!(result.envelope && result.sourceReplayIrMissing !== true);
    const positiveExecution = resultHasPositiveExecution(result);
    const durableFactsAvailable = !!immutableEntry && immutableEntry.complete === true;
    const replayIrRecoverable = !replayIrPresent && positiveExecution && durableFactsAvailable;
    const missing = [];
    if (!executionContractPresent) missing.push('executionContractJson');
    if (!actionGraphPresent) missing.push('actionGraphJson');
    if (!replayIrPresent) missing.push('replayIrJson');
    const status =
      missing.length === 0
        ? 'materialized'
        : replayIrRecoverable
          ? 'materialization_pending'
          : 'upstream_evidence_required';
    const entry = {
      runId: result.runId || null,
      runResultId: result.runResultId || result.id || null,
      testCaseId: result.testCaseId || null,
      caseName: result.caseName || null,
      status,
      idempotencyKey: materializationDigest({
        runResultId: result.runResultId || result.id || null,
        testCaseId: result.testCaseId || null,
        actionEvidenceCount: Number(immutableEntry?.actionEvidenceCount || 0),
        locatorRecipeCount: Number(immutableEntry?.locatorRecipeCount || 0),
        assertionEvidenceCount: Number(immutableEntry?.assertionEvidenceCount || 0),
        transactionCount: Number(immutableEntry?.transactionCount || 0),
      }),
      restartable: true,
      inlineExecutionGate: false,
      fields: {
        executionContractJson: {
          present: executionContractPresent,
          source: executionContractPresent ? 'persisted_run_result' : 'missing',
        },
        actionGraphJson: {
          present: actionGraphPresent,
          source: actionGraphPresent ? 'persisted_run_result' : 'missing',
        },
        replayIrJson: {
          present: replayIrPresent,
          source: replayIrPresent ? 'persisted_run_result' : 'missing',
          recoverableFromCommittedFacts: replayIrRecoverable,
        },
      },
      missing,
      immutableEvidenceComplete: durableFactsAvailable,
    };
    if (missing.length && !replayIrRecoverable) {
      requirements.push({
        code: 'UPSTREAM_CONDUCTOR_REQUIREMENT',
        field: missing.join(','),
        consumer: 'post-run ActionGraph/ReplayIR materializer',
        runResultId: entry.runResultId,
        testCaseId: entry.testCaseId,
        detail:
          'Persist immutable committed execution facts so Output Files can materialize executionContractJson, actionGraphJson, and replayIrJson after the run without fabricating.',
        nonBlocking: true,
      });
    }
    return entry;
  });
  const byStatus = entries.reduce((acc, entry) => {
    acc[entry.status] = (acc[entry.status] || 0) + 1;
    return acc;
  }, {});
  return {
    schema: 'qaai-post-run-materialization-status/1',
    authority: 'post_run_output_materializer',
    synchronousBrowserGate: false,
    idempotent: true,
    restartable: true,
    summary: {
      resultCount: entries.length,
      materializedCount: byStatus.materialized || 0,
      pendingCount: byStatus.materialization_pending || 0,
      upstreamRequirementCount: requirements.length,
      byStatus,
    },
    invariants: [
      'Materialization runs after browser execution from persisted committed facts.',
      'Materialization failure must not rewrite source run verdicts or block Output Files visibility.',
      'Repair/regenerate may rebuild from durable facts only; if facts are absent, rerun is required.',
    ],
    upstreamRequirements: requirements,
    entries,
  };
}

function addCaptureFirstEvidenceFiles(files, results = []) {
  if (!Array.isArray(results) || !results.length) return null;
  refreshFinalLocatorEvidenceMetrics(files, results);
  const evidencePackage = buildCaptureFirstEvidencePackage({ results });
  for (const entry of evidencePackage.entries || []) {
    const result = results.find((candidate) => artifactMatchesLedger(candidate, entry));
    applyFinalLocatorMetricsToLedger(entry.ledger, finalLocatorMetricsForResult(result));
  }
  files['evidence/action-evidence.json'] =
    JSON.stringify(
      {
        schema: evidencePackage.schema,
        summary: evidencePackage.summary,
        entries: evidencePackage.entries.map((entry) => ({
          runResultId: entry.runResultId,
          testCaseId: entry.testCaseId,
          caseName: entry.caseName,
          status: entry.status,
          overallRunStatus: entry.overallRunStatus,
          executionStatus: entry.executionStatus,
          evidenceStatus: entry.evidenceStatus,
          actionEvidences: entry.actionEvidences,
          locatorRecipes: entry.locatorRecipes,
          assertionEvidences: entry.assertionEvidences,
          authSetupEvidences: entry.authSetupEvidences,
          navigationEvidences: entry.navigationEvidences,
          traceArtifacts: entry.traceArtifacts,
        })),
      },
      null,
      2,
    ) + '\n';
  files['evidence/replayir.json'] =
    JSON.stringify(
      {
        schema: 'qaai-replayir-evidence/1',
        summary: evidencePackage.summary,
        replayIr: (results || []).map((result) => ({
          runResultId: result.runResultId,
          testCaseId: result.testCaseId,
          caseName: result.caseName || null,
          complete: result.envelope ? result.envelope.complete === true : false,
          gaps: Array.isArray(result.envelope && result.envelope.gaps) ? result.envelope.gaps : [],
          evidenceBuiltReplayIr: (result.envelope && result.envelope.evidenceBuiltReplayIr) || null,
          ir: (result.envelope && result.envelope.ir) || null,
        })),
      },
      null,
      2,
    ) + '\n';
  files['evidence/completeness-ledger.json'] =
    JSON.stringify(
      {
        schema: 'qaai-evidence-completeness-ledger/1',
        summary: evidencePackage.summary,
        ledgers: evidencePackage.entries.map((entry) => ({
          runResultId: entry.runResultId,
          testCaseId: entry.testCaseId,
          caseName: entry.caseName,
          ledger: entry.ledger,
        })),
      },
      null,
      2,
    ) + '\n';
  files['evidence/live-script-ledger.json'] =
    JSON.stringify(
      {
        schema: 'qaai-live-script-ledger-export/1',
        summary: evidencePackage.summary,
        ledgers: evidencePackage.entries.map((entry) => ({
          runResultId: entry.runResultId,
          testCaseId: entry.testCaseId,
          caseName: entry.caseName,
          status: entry.status,
          liveScriptLedger: entry.liveScriptLedger || null,
          scriptHealth: (entry.liveScriptLedger && entry.liveScriptLedger.health) || null,
          canonicalLineCount: entry.liveScriptLedger
            ? liveScriptRecorder.canonicalLines(entry.liveScriptLedger).length
            : 0,
        })),
      },
      null,
      2,
    ) + '\n';
  const transactionEntries = (results || []).map((result) => {
    const transactions = exportedActionTransactions(result);
    return {
      runResultId: result.runResultId || result.id || null,
      testCaseId: result.testCaseId || null,
      caseName: result.caseName || null,
      transactionCount: transactions.length,
      committedCount: transactions.filter((item) => item.status === 'committed').length,
      failedCount: transactions.filter((item) => item.status === 'failed').length,
      blockedCount: transactions.filter((item) => item.status === 'blocked').length,
      dispatchAttemptCount: transactions.reduce((sum, item) => sum + item.dispatchAttemptCount, 0),
      transactions,
    };
  });
  files['evidence/action-transactions.json'] = JSON.stringify({
    schema: 'qaai-action-transaction-export/1',
    summary: {
      resultCount: transactionEntries.length,
      transactionCount: transactionEntries.reduce((sum, entry) => sum + entry.transactionCount, 0),
      dispatchAttemptCount: transactionEntries.reduce((sum, entry) => sum + entry.dispatchAttemptCount, 0),
    },
    entries: transactionEntries,
  }, null, 2) + '\n';
  const immutableContract = buildImmutableExecutionEvidenceContract({ results });
  files['evidence/immutable-execution-evidence-contract.json'] =
    JSON.stringify(immutableContract, null, 2) + '\n';
  files['evidence/upstream-conductor-requirements.json'] =
    JSON.stringify(
      {
        schema: 'qaai-upstream-conductor-requirements/1',
        summary: immutableContract.summary,
        requirements: immutableContract.upstreamRequirements,
      },
      null,
      2,
    ) + '\n';
  const materializationStatus = buildPostRunMaterializationStatus({ results });
  files['evidence/post-run-materialization-status.json'] =
    JSON.stringify(materializationStatus, null, 2) + '\n';
  return {
    ...evidencePackage,
    immutableExecutionEvidence: immutableContract.summary,
    postRunMaterialization: materializationStatus.summary,
  };
}

function artifactMatchesLedger(artifact, item = {}) {
  if (!artifact || !item) return false;
  if (
    artifact.runResultId &&
    item.runResultId &&
    String(artifact.runResultId) === String(item.runResultId)
  )
    return true;
  if (
    artifact.testCaseId &&
    item.testCaseId &&
    String(artifact.testCaseId) === String(item.testCaseId)
  )
    return true;
  return false;
}

function validationPassedForGeneratedCounts(validation) {
  if (!validation) return false;
  if (validation.skipped === true) return false;
  if (validation.packagePassed === false) return false;
  const errorCount = Number(validation.errorCount || 0);
  if (Number.isFinite(errorCount) && errorCount > 0) return false;
  return true;
}

function refreshCaptureFirstLedgerCounts(
  files,
  { scriptArtifacts = [], validation = null, results = [] } = {},
) {
  const rel = 'evidence/completeness-ledger.json';
  if (!files || typeof files[rel] !== 'string') return null;
  let parsed = null;
  try {
    parsed = JSON.parse(files[rel]);
  } catch (_) {
    return null;
  }
  const ledgers = Array.isArray(parsed.ledgers) ? parsed.ledgers : [];
  const strictArtifacts = (Array.isArray(scriptArtifacts) ? scriptArtifacts : []).filter(
    (artifact) =>
      artifact &&
      artifact.source === 'replayir' &&
      artifact.scriptGenerationStatus === 'generated' &&
      artifact.file &&
      files[artifact.file],
  );
  const validationPassed = validationPassedForGeneratedCounts(validation);
  for (const item of ledgers) {
    const ledger = item && item.ledger;
    if (!ledger || typeof ledger !== 'object') continue;
    const result = (Array.isArray(results) ? results : []).find((candidate) =>
      artifactMatchesLedger(candidate, item),
    );
    applyFinalLocatorMetricsToLedger(ledger, finalLocatorMetricsForResult(result));
    const hasGeneratedArtifact = strictArtifacts.some((artifact) =>
      artifactMatchesLedger(artifact, item),
    );
    const generatedCount = hasGeneratedArtifact
      ? Number(
          ledger.actionEvidenceCount ||
            ledger.replayIrActionCount ||
            ledger.compiledActionCount ||
            0,
        )
      : 0;
    ledger.generatedMethodCount = generatedCount;
    ledger.validatedActionCount = validationPassed && generatedCount > 0 ? generatedCount : 0;
  }
  const totals = ledgers.reduce(
    (acc, item) => {
      const ledger = (item && item.ledger) || {};
      acc.generatedMethodCount += Number(ledger.generatedMethodCount || 0);
      acc.validatedActionCount += Number(ledger.validatedActionCount || 0);
      for (const name of FINAL_LOCATOR_METRIC_NAMES) {
        acc[name] += Number(ledger[name] || 0);
      }
      return acc;
    },
    {
      generatedMethodCount: 0,
      validatedActionCount: 0,
      emittedLocatorCount: 0,
      verifiedLocatorCount: 0,
      contractBackedLocatorCount: 0,
      guessedLocatorCount: 0,
      missingLocatorCount: 0,
    },
  );
  parsed.summary = { ...(parsed.summary || {}), ...totals };
  files[rel] = JSON.stringify(parsed, null, 2) + '\n';
  return parsed;
}

function ensureCaptureFirstFixtureFiles(files, { adapterId = null, results = [] } = {}) {
  if (!files || typeof files !== 'object') return;
  if (!POM_ADAPTER_IDS.has(adapterId)) return;
  const authScaffold = authSessionManager.buildAuthFixtureScaffold({ results, adapterId });
  Object.assign(files, authScaffold.files || {});
  if (!files['fixtures/data/README.md']) {
    files['fixtures/data/README.md'] = [
      '# Data fixtures',
      '',
      'QAAI maps generated scripts to approved test-data rows here.',
      'Draft/proposed mappings remain visible in evidence, but they are not replay-checked runnable data.',
      '',
    ].join('\n');
  }
}

function pruneUnreferencedAuthSetup(files) {
  const repairs = [];
  for (const setupPath of ['fixtures/auth/auth.setup.ts', 'fixtures/auth/auth.setup.js']) {
    if (typeof files?.[setupPath] !== 'string') continue;
    const referenced = Object.entries(files).some(([rel, content]) => {
      if (rel === setupPath || typeof content !== 'string') return false;
      if (/\bauth\.setup\.(?:ts|js)\b|fixtures\/auth\/auth\.setup/i.test(content)) return true;
      if (!/^playwright\.config\.(?:ts|js)$/.test(rel)) return false;
      return /\btestMatch\b[^\n]*(?:setup|auth)|\bdependencies\s*:\s*\[[^\]]*setup|\bname\s*:\s*['"][^'"]*setup/i.test(
        content,
      );
    });
    if (referenced) continue;
    delete files[setupPath];
    repairs.push({
      rule: 'pom_graph_unreferenced_auth_setup_removed',
      path: setupPath,
      message: `${setupPath} was omitted because the generated Playwright package has no setup project or source reference to it.`,
    });
  }
  return repairs;
}

function hasAuthSessionBlocker(result) {
  const readinessStatus = String((result && result.readinessStatus) || '').toLowerCase();
  if (readinessStatus === 'needs_auth_setup' || readinessStatus === 'needs_session_dependency')
    return true;
  const reasons = Array.isArray(result && result.readinessReasons) ? result.readinessReasons : [];
  return reasons.some((reason) => {
    const code = String(
      (reason && (reason.code || reason.rule || reason.family || reason.message)) || '',
    ).toLowerCase();
    return (
      code.includes('auth_setup') ||
      code.includes('no_login_template') ||
      code.includes('session_dependency') ||
      code.includes('missing_session') ||
      code.includes('auth_session')
    );
  });
}

function needsAuthStateContext(result, ir) {
  const requiresState =
    result && (result.requiresStateJson || result.requiresState || result.requiresData);
  const stateText = JSON.stringify(requiresState || '').toLowerCase();
  if (stateText.includes('auth_session') || stateText.includes('session')) return true;
  const mode = String((result && result.sessionMode) || '').toLowerCase();
  return mode === 'continue_from_dependency' || mode === 'shared_scenario';
}

function authStateContextPresent(result, envelope, ir) {
  if (result && result.authProfile) return true;
  if (authStateRefFromEnvelope(envelope)) return true;
  if (irPerformsLogin(ir)) return true;
  return false;
}

function assessStrictReplayExport({ results = [], scriptArtifacts = [] } = {}) {
  const findings = [];
  const artifacts = Array.isArray(scriptArtifacts) ? scriptArtifacts : [];
  const artifactResults = artifacts.map((artifact) => ({
    artifact,
    result: (results || []).find((candidate) => resultMatchesArtifact(candidate, artifact)),
  }));

  for (const { artifact, result } of artifactResults) {
    if (!replayArtifactIsStrict(artifact)) {
      findings.push({
        rule: 'strict_export_non_replayir_artifact',
        severity: 'error',
        testCaseId: (artifact && artifact.testCaseId) || null,
        runResultId: (artifact && artifact.runResultId) || null,
        file: (artifact && artifact.file) || null,
        source: (artifact && artifact.source) || null,
        scriptGenerationStatus: (artifact && artifact.scriptGenerationStatus) || null,
        message:
          'Replay-checked output requires a generated artifact sourced from complete browser-captured ReplayIR. Partial, TestCase-contract, helper, and skeleton artifacts remain visible with lower script health.',
      });
      continue;
    }

    if (!result || !result.envelope || !result.envelope.ir) {
      findings.push({
        rule: 'strict_export_replayir_missing',
        severity: 'error',
        testCaseId: (artifact && artifact.testCaseId) || null,
        runResultId: (artifact && artifact.runResultId) || null,
        file: (artifact && artifact.file) || null,
        message:
          'Artifact claims ReplayIR source, but the matching RunResult has no pinned ReplayIR envelope.',
      });
      continue;
    }

    const envelope = result.envelope;
    const ir = envelope.ir;
    const guessedLocators = guessedResolveCount(ir);
    const evidenceLedger = latestLedgerForResult(result);
    if (!evidenceLedger) {
      findings.push({
        rule: 'strict_export_evidence_ledger_missing',
        severity: 'error',
        testCaseId: artifact.testCaseId || result.testCaseId || null,
        runResultId: artifact.runResultId || result.runResultId || null,
        file: artifact.file || null,
        message:
          'Certified/export-valid output requires a capture-first EvidenceCompletenessLedger for the matching RunResult.',
      });
    } else if (
      evidenceLedger.evidenceStatus !== 'complete' ||
      Number(evidenceLedger.missingEvidenceCount || 0) > 0
    ) {
      const locatorMissing = Number(evidenceLedger.missingLocatorCount || 0);
      const nonLocatorMissing = [
        'missingActionEvidenceCount',
        'missingAssertionCount',
        'parseFailedAssertionCount',
        'missingNavigationEvidenceCount',
        'missingAuthSetupCount',
      ].reduce((sum, key) => sum + Number(evidenceLedger[key] || 0), 0);
      const locatorOnly =
        locatorMissing > 0 && nonLocatorMissing === 0 && guessedLocators >= locatorMissing;
      findings.push({
        rule: locatorOnly
          ? 'strict_export_locator_evidence_guessed'
          : 'strict_export_evidence_incomplete',
        severity: locatorOnly ? 'warning' : 'error',
        nonBlocking: locatorOnly,
        testCaseId: artifact.testCaseId || result.testCaseId || null,
        runResultId: artifact.runResultId || result.runResultId || null,
        file: artifact.file || null,
        ledger: evidenceLedger,
        message: locatorOnly
          ? 'Durable locator evidence was unavailable, but QAAI emitted editable guessed locators for every affected action.'
          : 'Export requires complete non-locator action, assertion, navigation, auth, and data evidence.',
      });
    }
    if (envelope.complete === false) {
      const envelopeGaps = Array.isArray(envelope.gaps) ? envelope.gaps : [];
      const locatorOnly =
        envelopeGaps.length > 0 && envelopeGaps.every(isLocatorOnlyGap) && guessedLocators > 0;
      findings.push({
        rule: locatorOnly
          ? 'strict_export_locator_gaps_guessed'
          : 'strict_export_replayir_incomplete',
        severity: locatorOnly ? 'warning' : 'error',
        nonBlocking: locatorOnly,
        testCaseId: artifact.testCaseId || result.testCaseId || null,
        runResultId: artifact.runResultId || result.runResultId || null,
        file: artifact.file || null,
        gaps: envelopeGaps,
        message: locatorOnly
          ? 'ReplayIR locator gaps were represented by editable QAAI-guessed locators.'
          : 'Export requires ReplayIR complete:true for non-locator evidence.',
      });
    }
    if (Array.isArray(envelope.gaps) && envelope.gaps.length) {
      const locatorGaps = envelope.gaps.filter(isLocatorOnlyGap);
      const blockingGaps = envelope.gaps.filter((gap) => !isLocatorOnlyGap(gap));
      if (locatorGaps.length)
        findings.push({
          rule: 'strict_export_locator_gaps_guessed',
          severity: guessedLocators > 0 ? 'warning' : 'error',
          nonBlocking: guessedLocators > 0,
          testCaseId: artifact.testCaseId || result.testCaseId || null,
          runResultId: artifact.runResultId || result.runResultId || null,
          file: artifact.file || null,
          gaps: locatorGaps,
          message:
            guessedLocators > 0
              ? 'Locator-only ReplayIR gaps are represented by editable QAAI-guessed locators.'
              : 'Locator gaps have no generated fallback locator.',
        });
      if (blockingGaps.length)
        findings.push({
          rule: 'strict_export_replayir_gaps',
          severity: 'error',
          testCaseId: artifact.testCaseId || result.testCaseId || null,
          runResultId: artifact.runResultId || result.runResultId || null,
          file: artifact.file || null,
          gaps: blockingGaps,
          message: 'Export contains non-locator ReplayIR gaps.',
        });
    }

    const locatorAssessment = assessReplayLocatorEvidence(ir);
    for (const finding of locatorAssessment.findings || []) {
      if (finding && (finding.severity === 'error' || finding.severity === 'warning')) {
        const normalized = downgradeAdvisoryLocatorFinding(finding);
        findings.push({
          ...normalized,
          rule: `strict_export_${normalized.rule || 'locator_evidence_missing'}`,
          testCaseId: artifact.testCaseId || result.testCaseId || normalized.testCaseId || null,
          runResultId: artifact.runResultId || result.runResultId || normalized.runResultId || null,
          file: artifact.file || null,
        });
      }
    }

    if (!hasConcreteReplayAssertion(ir)) {
      findings.push({
        rule: 'strict_export_assertion_evidence_missing',
        severity: 'error',
        testCaseId: artifact.testCaseId || result.testCaseId || null,
        runResultId: artifact.runResultId || result.runResultId || null,
        file: artifact.file || null,
        message:
          'Certified/export-valid output requires at least one concrete browser-captured assertion with a contractRef and expected evidence.',
      });
    }

    if (
      hasAuthSessionBlocker(result) ||
      (needsAuthStateContext(result, ir) && !authStateContextPresent(result, envelope, ir))
    ) {
      findings.push({
        rule: 'strict_export_auth_session_context_missing',
        severity: 'error',
        testCaseId: artifact.testCaseId || result.testCaseId || null,
        runResultId: artifact.runResultId || result.runResultId || null,
        file: artifact.file || null,
        readinessStatus: result.readinessStatus || null,
        sessionMode: result.sessionMode || null,
        message:
          'Certified/export-valid output requires clean auth/session context: verified login in ReplayIR, usable auth state, or an approved auth profile with no auth/session readiness blockers.',
      });
    }
  }

  if (artifacts.length === 0 && (results || []).length > 0) {
    findings.push({
      rule: 'strict_export_no_script_artifacts',
      severity: 'error',
      message:
        'Certified/export-valid output requires at least one script artifact tied to browser-captured ReplayIR.',
    });
  }

  return findings;
}

function collectAuthStateRefs(envelopes) {
  const refs = new Set();
  for (const env of envelopes || []) {
    const ref = authStateRefFromEnvelope(env);
    if (ref) refs.add(ref);
  }
  return [...refs].sort();
}

function normalizeStorageStateFile(stateJson) {
  if (!storageStateLib.isUsableState(stateJson)) return null;
  const obj = typeof stateJson === 'string' ? JSON.parse(stateJson) : stateJson;
  return JSON.stringify(obj, null, 2) + '\n';
}

async function resolveAuthStateForPackage({ projectId, adapterId, envelopes }) {
  const refs = collectAuthStateRefs(envelopes);
  if (!refs.length) return { files: {}, storageStateRel: null, findings: [] };

  if (adapterId === 'selenium-reference' || adapterId === 'selenium-pom') {
    return {
      files: {},
      storageStateRel: null,
      findings: [
        {
          rule: 'auth_storage_state_unsupported',
          severity: 'error',
          message:
            'ReplayIR requires Playwright storageState, but selenium-reference cannot consume Playwright storageState. Use explicit login/test-hook auth for Selenium.',
          refs,
        },
      ],
    };
  }

  if (refs.length > 1) {
    return {
      files: {},
      storageStateRel: null,
      findings: [
        {
          rule: 'auth_storage_state_multiple_refs',
          severity: 'error',
          message: `Export selection contains ${refs.length} different storageState refs. Split by AuthProfile or add per-test storageState support before exporting.`,
          refs,
        },
      ],
    };
  }

  const ref = refs[0];
  const m = ref.match(/^fixture:(.+)$/i);
  if (!m) {
    return {
      files: {},
      storageStateRel: null,
      findings: [
        {
          rule: 'auth_storage_state_unresolved',
          severity: 'error',
          message: `ReplayIR storageStateRef '${ref}' is not a resolvable AuthFixture ref. Expected fixture:<authFixtureId>.`,
          ref,
        },
      ],
    };
  }

  const fixtureId = m[1];
  const fixture = await prisma.authFixture.findFirst({
    where: { id: fixtureId, projectId },
    select: { id: true, name: true, storageState: true },
  });
  const content = fixture ? normalizeStorageStateFile(fixture.storageState) : null;
  if (!content) {
    return {
      files: {},
      storageStateRel: null,
      findings: [
        {
          rule: 'auth_fixture_missing_or_invalid',
          severity: 'error',
          message: `AuthFixture '${fixtureId}' is missing, outside this project, or does not contain usable Playwright storageState.`,
          ref,
        },
      ],
    };
  }

  return {
    files: { [storageStateLib.STATE_REL]: content },
    storageStateRel: storageStateLib.STATE_REL,
    findings: [],
    ref,
    fixtureId,
  };
}

// Blocked, needs_human, and skipped cases must not be exported as runnable website
// failures. They are QAAI-side certification gaps or intentionally excluded cases,
// so the generated runner entry is disabled and the manifest carries the reason.
const VERDICT_NEEDS_SKIP = new Set(['blocked', 'needs_human', 'skipped']);

// Verdict fidelity: pass and fail emit as-is (natural pass/fail on replay).
// Blocked/needs_human/skipped are neutralized so they cannot report green or false
// website red; the reason remains visible in EXPORT_MANIFEST.json and comments.
function wrapForVerdict(adapterId, content, status, reason, hasExecutedContent = false) {
  const reasonNote = reason ? ` (${String(reason).slice(0, 120)})` : '';
  // Intentional skip — neutralize so runner doesn't report green for excluded cases.
  if (VERDICT_NEEDS_SKIP.has(status)) {
    const executionNote = hasExecutedContent
      ? 'Only positively executed occurrences and evaluated assertions are emitted; unexecuted authoring remains diagnostic.'
      : 'No executed browser actions or evaluated assertions were available; this file is diagnostic only.';
    const note = `// QAAI source-run diagnostic: status was '${status}'${reasonNote}. ${executionNote}\n`;
    if (adapterId === 'playwright-reference' && content.includes('test.describe(')) {
      return { content: note + content, wrapped: true };
    }
    if (adapterId === 'playwright-reference-js' && content.includes('test.describe(')) {
      return { content: note + content, wrapped: true };
    }
    if (
      (adapterId === 'selenium-reference' || adapterId === 'selenium-pom') &&
      content.includes('@Test')
    ) {
      return { content: note + content, wrapped: true };
    }
    return { content: note + content, wrapped: true, anchorMissing: true };
  }
  // pass / fail — emit unchanged.
  return { content, wrapped: false };
}

// ── Class E: setup-chain (login) precondition composition ─────────────────────
// A case is "stranded" when the LIVE run established its session in a PRIOR case that is
// absent from THIS export (e.g. the login case was blocked on a locator) — the standalone
// spec then opens on a blank/unauthenticated context and fails for a reason that was never
// a live failure (L3 artifact). The faithful fix is to RECONSTRUCT the session the live run
// actually used by reusing the run's own recorded login steps as a prepended precondition —
// never inventing credentials or a profile that did not exist (that would be the L3 breach).
//
// All detection is keyed off IR STRUCTURE + universal auth concepts (login / logout), never
// any site-specific string.

// Does this IR perform a login itself? (a password fill followed by a click submit)
function irPerformsLogin(ir) {
  const steps = Array.isArray(ir && ir.steps) ? ir.steps : [];
  let pwIdx = -1;
  steps.forEach((s, i) => {
    if (
      s &&
      s.op === 'act' &&
      /fill|type/i.test(s.action || '') &&
      /pass/i.test(String(s.valueRef || s.target || ''))
    )
      pwIdx = i;
  });
  if (pwIdx < 0) return false;
  return steps
    .slice(pwIdx + 1)
    .some((s) => s && s.op === 'act' && /click|press/i.test(s.action || ''));
}

// The login URL is the navigate target inside a login-performing IR.
function loginUrlOf(ir) {
  const steps = Array.isArray(ir && ir.steps) ? ir.steps : [];
  const nav = steps.find((s) => s && s.op === 'act' && s.action === 'navigate' && s.url);
  return nav ? String(nav.url) : null;
}

// Slice JUST the login prefix from a login-performing IR: from the start through the click
// that submits the credentials (drops any post-login assertions/navigation the case added).
function extractLoginBlock(ir) {
  const steps = Array.isArray(ir && ir.steps) ? ir.steps : [];
  let pwIdx = -1;
  steps.forEach((s, i) => {
    if (
      s &&
      s.op === 'act' &&
      /fill|type/i.test(s.action || '') &&
      /pass/i.test(String(s.valueRef || s.target || ''))
    )
      pwIdx = i;
  });
  if (pwIdx < 0) return null;
  let clickIdx = -1;
  for (let i = pwIdx + 1; i < steps.length; i += 1) {
    if (steps[i] && steps[i].op === 'act' && /click|press/i.test(steps[i].action || '')) {
      clickIdx = i;
      break;
    }
  }
  if (clickIdx < 0) return null;
  // include the resolve step that defines the click target if it precedes the slice end (it does)
  return steps.slice(0, clickIdx + 1).map((s) => ({ ...s }));
}

// Derive ONE canonical login precondition for the run: the login-performing case with the
// SHORTEST login prefix (cleanest, avoids complex multi-fill setup flows). Returns
// { steps, loginUrl } or null when the run never logged in (→ cannot compose, stays blocked).
function deriveLoginPrecondition(results) {
  let best = null;
  for (const r of results || []) {
    const ir = r && r.envelope && r.envelope.ir;
    if (!ir || !irPerformsLogin(ir)) continue;
    const block = extractLoginBlock(ir);
    if (!block || !block.length) continue;
    if (!best || block.length < best.steps.length)
      best = { steps: block, loginUrl: loginUrlOf(ir) };
  }
  return best;
}

// Does the journey reference a logout / sign-out anywhere (case names, assertion expected
// text, evaluate scripts)? Such a journey expects a logged-OUT state — composing a LOGIN
// precondition would invert its premise, so it is excluded (universal auth concept, not a
// site string).
function journeyReferencesLogout(items) {
  const LOGOUT = /log\s?out|sign\s?out|signed out|logged out/i;
  for (const { r } of items || []) {
    if (LOGOUT.test(String(r.caseName || ''))) return true;
    const steps = Array.isArray(r.envelope && r.envelope.ir && r.envelope.ir.steps)
      ? r.envelope.ir.steps
      : [];
    for (const s of steps) {
      if (s && s.op === 'assert' && LOGOUT.test(String(s.expected || ''))) return true;
      if (s && s.op === 'assert' && s.channel === 'EVALUATE' && LOGOUT.test(String(s.script || '')))
        return true;
    }
  }
  return false;
}

// Does this case operate ON the login page (so it expected the UNauthenticated login context,
// NOT an inherited session)? Keyed off login-FORM interaction, never the URL — a logged-in
// case can navigate to the login URL too (it just redirects to the dashboard). Signals:
//   - fills a credential field (valueRef/target names a user/pass/email/login field), or
//   - asserts a credential INPUT exists (querySelector input[name/type=...user|pass...]/
//     type="password"), or
//   - asserts login-validation copy ("... is required", "invalid credentials", ...).
// All universal auth-form concepts, never a site-specific string.
function caseOperatesOnLoginPage(ir) {
  const steps = Array.isArray(ir && ir.steps) ? ir.steps : [];
  for (const s of steps) {
    if (
      s &&
      s.op === 'act' &&
      /fill|type/i.test(s.action || '') &&
      /user|pass|login|email/i.test(String(s.valueRef || s.target || ''))
    )
      return true;
    if (s && s.op === 'assert') {
      const sc = String(s.script || '');
      if (/input\[\s*(name|id|type)\s*[*^$~|]?=\s*["'](user|pass|email|login)/i.test(sc))
        return true;
      if (/type\s*=\s*["']password["']/i.test(sc)) return true;
      if (
        /\b(is required|are required|required field|invalid credential|must be|cannot be empty)\b/i.test(
          String(s.expected || ''),
        )
      )
        return true;
    }
  }
  return false;
}

// The logout URL the run actually used (a navigate to a /logout endpoint). Kept as evidence
// only; export must not compose hidden logged-out preconditions from another case.
function deriveLogoutUrl(results) {
  for (const r of results || []) {
    const steps = Array.isArray(r.envelope && r.envelope.ir && r.envelope.ir.steps)
      ? r.envelope.ir.steps
      : [];
    const nav = steps.find(
      (s) =>
        s &&
        s.op === 'act' &&
        s.action === 'navigate' &&
        /\/logout(\b|\/|$)/i.test(String(s.url || '')),
    );
    if (nav) return String(nav.url);
  }
  return null;
}

function deriveLogoutActionSteps(results) {
  const LOGOUT = /log\s?out|sign\s?out/i;
  const MENU = /user|profile|account|avatar|dropdown|menu/i;
  for (const r of results || []) {
    if (!r || !r.envelope || r.envelope.complete === false) continue;
    const steps = Array.isArray(r.envelope.ir && r.envelope.ir.steps) ? r.envelope.ir.steps : [];
    if (!steps.length) continue;
    const resolveByAs = new Map();
    steps.forEach((step, index) => {
      if (step && step.op === 'resolve' && step.as)
        resolveByAs.set(step.as, { ...step, stepIndex: index });
    });
    const logoutIndex = steps.findIndex(
      (s) => s && s.op === 'act' && /click/i.test(s.action || '') && LOGOUT.test(JSON.stringify(s)),
    );
    if (logoutIndex < 0) continue;
    const selected = new Set();
    const includeActWithResolve = (index) => {
      if (index == null || index < 0 || !steps[index]) return;
      const step = steps[index];
      const resolved = step.target ? resolveByAs.get(step.target) : null;
      if (resolved && resolved.stepIndex != null) selected.add(resolved.stepIndex);
      selected.add(index);
    };
    let openerIndex = -1;
    for (let i = logoutIndex - 1; i >= 0; i--) {
      const step = steps[i];
      if (!step || step.op !== 'act' || !/click/i.test(step.action || '')) continue;
      if (MENU.test(JSON.stringify(step))) {
        openerIndex = i;
        break;
      }
    }
    if (openerIndex < 0) {
      for (let i = logoutIndex - 1; i >= 0; i--) {
        const step = steps[i];
        if (!step || step.op !== 'act' || !/click/i.test(step.action || '')) continue;
        if (!/login|sign\s?in/i.test(JSON.stringify(step))) {
          openerIndex = i;
          break;
        }
      }
    }
    includeActWithResolve(openerIndex);
    includeActWithResolve(logoutIndex);
    const out = [...selected].sort((a, b) => a - b).map((i) => ({ ...steps[i] }));
    if (!out.length) continue;
    const selectedResolveByAs = new Map();
    out.forEach((step) => {
      if (step && step.op === 'resolve' && step.as) selectedResolveByAs.set(step.as, step);
    });
    const safe = out.every((step) => {
      if (!step || step.op !== 'act' || !actionNeedsLocator(step.action)) return true;
      if (actionLocatorResolver.isVerifiedActionLocator(step.actionLocator)) return true;
      const resolved = step.target ? selectedResolveByAs.get(step.target) : null;
      return !!(resolved && actionLocatorResolver.isVerifiedActionLocator(resolved.actionLocator));
    });
    if (safe) return out;
  }
  return null;
}

// Does the journey itself perform the logout (navigate to a logout URL, or click a logout-named
// control)? If so it establishes its own logged-out state and needs no composed teardown.
function journeyPerformsLogout(items) {
  const LOGOUT = /log\s?out|sign\s?out/i;
  for (const { r } of items || []) {
    const steps = Array.isArray(r.envelope && r.envelope.ir && r.envelope.ir.steps)
      ? r.envelope.ir.steps
      : [];
    for (const s of steps) {
      if (
        s &&
        s.op === 'act' &&
        s.action === 'navigate' &&
        /\/logout(\b|\/|$)/i.test(String(s.url || ''))
      )
        return true;
      if (s && s.op === 'act' && /click/i.test(s.action || '') && LOGOUT.test(JSON.stringify(s)))
        return true;
    }
  }
  return false;
}

// A post-logout journey is stranded when it asserts a logged-OUT state (references logout) but
// no admitted case logs in OR performs the logout. We block this instead of composing hidden
// login/logout setup outside the approved case contract.
function journeyNeedsLogoutPrecondition(items) {
  if (!items || !items.length) return false;
  if (!journeyReferencesLogout(items)) return false;
  if (items.some(({ r }) => irPerformsLogin(r.envelope && r.envelope.ir))) return false;
  if (journeyPerformsLogout(items)) return false;
  return true;
}

// Does this journey need a composed login precondition? True when, in the admitted set, NO
// case logs in, no case references logout, and NO case operates on the login page — i.e. the
// journey assumes an inherited authenticated session it never establishes (the session-
// establishing case was blocked/excluded, or the session came from cross-scenario inheritance).
// Login-page negative tests are excluded by caseOperatesOnLoginPage even when they navigate to
// the login URL; authenticated cases that also navigate to the login URL (which redirects when
// logged in) are correctly still triggered.
function journeyNeedsLoginPrecondition(items /*, loginUrl */) {
  if (!items || !items.length) return false;
  if (items.some(({ r }) => irPerformsLogin(r.envelope && r.envelope.ir))) return false;
  if (journeyReferencesLogout(items)) return false;
  if (items.some(({ r }) => caseOperatesOnLoginPage(r.envelope && r.envelope.ir))) return false;
  // remaining: at least one case actually acts/asserts (assumes a session it didn't establish)
  return items.some(({ r }) => {
    const steps = Array.isArray(r.envelope && r.envelope.ir && r.envelope.ir.steps)
      ? r.envelope.ir.steps
      : [];
    return steps.some((s) => s && (s.op === 'act' || s.op === 'assert' || s.op === 'resolve'));
  });
}

// ── Class B: stranded EVALUATE predicates (exported for guard + used by _compileJourneyGroup) ──

// Returns true when a step is a form-validation assertion: an EVALUATE channel assert whose
// script checks login-form error/validation content, or a UI_TEXT/TEXT_MATCH assert whose
// expected value is a validation-error phrase. These are assertions that only make sense AFTER
// a form submission — not after login/navigation.
// IMPORTANT: generic EVALUATE assertions (e.g. checking admin nav items, dashboard widgets)
// must NOT be classified as form-validation — they work via the inherited authenticated session
// from the preceding case in the serial journey. Unconditionally classifying all EVALUATE as
// form-validation causes the codegen to incorrectly inject a login flow into those cases,
// which breaks them when the session is already active (auth/login redirects away from the
// login form, so the Login button is no longer present on the redirected page).
function _isFormValidationAssertion(step) {
  if (!step || step.op !== 'assert') return false;
  if (step.channel === 'EVALUATE') {
    // Only classify as form-validation if the script specifically checks for login-form
    // error messages or validation state (e.g. ".oxd-input-field-error-message", "Required",
    // "Invalid credentials"). Generic scripts (nav checks, widget presence, etc.) are excluded.
    const script = String(step.script || step.expected || '');
    return /error[- _]?message|is[- _]?required|required|validation[- _]?error|invalid[- _]?credential|field[- _]?error/i.test(
      script,
    );
  }
  if (step.channel === 'UI_TEXT' || step.channel === 'TEXT_MATCH') {
    return /required|invalid|error|empty|validation/i.test(
      String(step.expected || '').toLowerCase(),
    );
  }
  return false;
}

// Returns true when an IR has NO act steps (no navigate, no click, no fill) AND every assert
// step is a form-validation assertion. Such a case is "stranded": the page state it is checking
// was established by a prior case's action (e.g. an empty-submit click), not by steps in this IR.
// Standalone, it would evaluate on a blank or wrong-state page → SecurityError or false result.
function irHasOnlyFormValidationAsserts(ir) {
  const steps = Array.isArray(ir && ir.steps) ? ir.steps : [];
  if (!steps.length) return false;
  if (steps.some((s) => s && s.op === 'act')) return false;
  const assertSteps = steps.filter((s) => s && s.op === 'assert');
  if (!assertSteps.length) return false;
  return assertSteps.every(_isFormValidationAssertion);
}

// Legacy predicate retained for callers/tests: true when a journey references a logged-out
// state it does not establish itself and cannot even point to recorded logout evidence.
function journeyNeedsLogoutButCant(items, { loginPrecondition, logoutUrl, logoutActionSteps }) {
  if (!journeyNeedsLogoutPrecondition(items)) return false;
  return !(
    loginPrecondition &&
    (logoutUrl || (Array.isArray(logoutActionSteps) && logoutActionSteps.length))
  );
}

/**
 * PURE. results: [{ runResultId, testCaseId, runId, status, dataRowIndex, dataRowLabel,
 *   caseName, scenarioId, scenarioName, envelope }].
 *
 * Two-pass compilation:
 *   PASS 1 — validate every result through all IR / locator / operation gates.
 *   PASS 2 — Playwright adapters group validated results by scenarioId and emit
 *             journey specs (all cases as sequential test.step() blocks in one file).
 *             Non-Playwright and ungrouped results fall through to per-case compilation.
 */
const LOCATOR_DEPENDENT_ACTIONS = new Set([
  'fill',
  'type',
  'click',
  'doubleClick',
  'tripleClick',
  'hover',
  'selectOption',
  'check',
  'uncheck',
  'upload',
  'press',
  'drag',
  'download',
  'popup',
]);

function internalTargetName(value) {
  return /^(?:el|element|ref|node|target|control)[-_]?\d+$/i.test(String(value || '').trim());
}

function semanticActionLabel(step = {}) {
  const supplied = [step.targetLabel, step.elementLabel, step.label, step.narration, step.name]
    .map((value) => String(value || '').trim())
    .find((value) => value && !internalTargetName(value));
  if (supplied) return supplied;
  const action = String(step.action || '').toLowerCase();
  if (['fill', 'type'].includes(action)) return 'input field';
  if (action === 'selectoption') return 'selection field';
  if (['check', 'uncheck'].includes(action)) return 'checkbox';
  if (['click', 'doubleclick', 'tripleclick'].includes(action)) return 'interactive button';
  if (action === 'hover') return 'interactive element';
  return `${action || 'action'} target`;
}

function resolveHasExecutableLocator(resolve = {}) {
  if (
    (resolve.actionLocator && !locatorStructureIsUnstable(resolve.actionLocator)) ||
    (resolve.locatorRecipe && !locatorStructureIsUnstable(resolve.locatorRecipe)) ||
    (resolve.locatorProvenance?.chosenExpression &&
      !locatorExpressionIsUnstable(resolve.locatorProvenance.chosenExpression))
  )
    return true;
  return (
    Array.isArray(resolve.candidates) &&
    resolve.candidates.some(
      (candidate) =>
        candidate &&
        !candidateLeaksInternalName(candidate) &&
        (candidate.expression ||
          candidate.selector ||
          candidate.testId ||
          (candidate.strategy === 'role' && candidate.role && (candidate.name || candidate.text)) ||
          (['label', 'placeholder', 'text'].includes(candidate.strategy) &&
            (candidate.text || candidate.name))),
    )
  );
}

function locatorExpressionIsUnstable(value) {
  const text = String(value || '');
  if (!text) return false;
  return (
    /(?:^|[^a-z0-9])(?:el|element|ref|node|target|control)[-_]?\d+(?:[^a-z0-9]|$)/i.test(text) ||
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(text) ||
    /(?:\.nth\s*\(|:nth-(?:child|of-type)\s*\(|\bnth\s*=)/i.test(text)
  );
}

function locatorStructureIsUnstable(value) {
  if (!value) return false;
  if (typeof value === 'string') return locatorExpressionIsUnstable(value);
  try {
    return locatorExpressionIsUnstable(JSON.stringify(value));
  } catch (_) {
    return true;
  }
}

function candidateLeaksInternalName(candidate = {}) {
  const value = candidate.name || candidate.text || candidate.testId || candidate.selector || '';
  return (
    internalTargetName(value) ||
    locatorExpressionIsUnstable(value) ||
    locatorExpressionIsUnstable(candidate.expression)
  );
}

function semanticResolveRef(label, action, usedRefs) {
  const words = String(label || `${action || 'action'} target`)
    .trim()
    .replace(/[^a-zA-Z0-9]+(.)?/g, (_, next) => (next ? next.toUpperCase() : ''))
    .replace(/^[^a-zA-Z]+/, '');
  const actionSuffix = ['fill', 'type'].includes(String(action || '').toLowerCase())
    ? 'Field'
    : ['click', 'doubleclick', 'tripleclick'].includes(String(action || '').toLowerCase())
      ? 'Button'
      : 'Element';
  const lower = words
    ? words.charAt(0).toLowerCase() + words.slice(1)
    : `interactive${actionSuffix}`;
  const base = lower.toLowerCase().endsWith(actionSuffix.toLowerCase())
    ? lower
    : `${lower}${actionSuffix}`;
  let ref = base;
  let duplicate = 2;
  while (usedRefs.has(ref)) ref = `${base}${duplicate++}`;
  usedRefs.add(ref);
  return ref;
}

function evidenceText(value) {
  return value == null ? '' : String(value).trim();
}

function evidenceJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  return decodeJson(value, fallback);
}

const POSITIVE_EXECUTION_STATUSES = new Set([
  'complete',
  'completed',
  'executed',
  'ok',
  'pass',
  'passed',
  'succeeded',
  'success',
]);

const NEGATIVE_EXECUTION_STATUSES = new Set([
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
  'skipped',
  'timed_out',
  'timeout',
  'unknown',
]);

function normalizedEvidenceStatus(value) {
  return evidenceText(value).toLowerCase().replace(/[\s-]+/g, '_');
}

function evidenceStatuses(...sources) {
  const values = [];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const field of [
      'status',
      'executionStatus',
      'runtimeStatus',
      'actionStatus',
      'outcome',
      'resultStatus',
    ]) {
      const value = normalizedEvidenceStatus(source[field]);
      if (value) values.push(value);
    }
  }
  return values;
}

function successfulActionEvidence(row) {
  const detail = evidenceJson(row?.evidenceJson, {}) || {};
  const explicitSuccess = row?.ok === true || row?.success === true || detail.ok === true || detail.success === true;
  const explicitFailure = row?.ok === false || row?.success === false || detail.ok === false || detail.success === false;
  const statuses = evidenceStatuses(row, detail);
  return (
    !explicitFailure &&
    !statuses.some((status) => NEGATIVE_EXECUTION_STATUSES.has(status)) &&
    (explicitSuccess || statuses.some((status) => POSITIVE_EXECUTION_STATUSES.has(status)))
  );
}

function evaluatedAssertionEvidence(row) {
  const detail = evidenceJson(row?.evidenceJson, {}) || {};
  if (typeof row?.matched === 'boolean' || typeof detail.matched === 'boolean') return true;
  if (row?.checked === true || detail.checked === true || detail.evaluated === true) return true;
  if (['matched', 'not_matched'].includes(normalizedEvidenceStatus(row?.liveOutcome))) return true;
  return evidenceStatuses(row, detail).some(
    (status) =>
      POSITIVE_EXECUTION_STATUSES.has(status) ||
      ['fail', 'failed', 'failure', 'not_matched'].includes(status),
  );
}

function verifiedObservedNavigationOutcome(step) {
  if (
    !step ||
    step.observedOnly !== true ||
    normalizedReplayAction(step.action) !== 'navigate'
  ) return false;
  const transitionKind = normalizedEvidenceStatus(
    step.transitionKind || step.navigationKind || step.kind,
  );
  const observedUrl = usableHttpNavigationUrl(
    step.pageUrlAfter || step.resolvedUrl || step.finalUrl,
  );
  return !!(
    observedUrl &&
    ['popup', 'popup_context', 'popup_destination', 'new_tab', 'newtab', 'redirect', 'observed']
      .includes(transitionKind)
  );
}

function replayStepHasPositiveExecutionProvenance(step) {
  if (!step || !['act', 'waitFor', 'assert'].includes(step.op)) return false;
  if (
    step.evidenceOnly === true ||
    step.diagnosticOnly === true ||
    step.executable === false ||
    step.synthesizedFromContract === true
  )
    return false;
  const trustedRuntimeProvenance = (
    step.canonicalExecution === true ||
    step.canonicalLiveLedger === true ||
    step.observedOnly === true ||
    step.runtimeEvidence === true
  ) || new Set([
    'runtime_evidence',
    'canonical_live_script_ledger',
    'unbound_runtime_evidence',
    'verified_runtime_action',
  ]).has(normalizedEvidenceStatus(step.origin));
  if (!trustedRuntimeProvenance) return false;
  if (step.op === 'assert') return evaluatedAssertionEvidence(step);
  return successfulActionEvidence(step) || verifiedObservedNavigationOutcome(step);
}

function evidenceIdentity(value = {}) {
  const nested = value.actionIdentity && typeof value.actionIdentity === 'object'
    ? value.actionIdentity
    : {};
  return {
    contractStepId: evidenceText(value.contractStepId || value.contractRef || nested.contractStepId),
    actionOccurrenceId: evidenceText(value.actionOccurrenceId || nested.actionOccurrenceId),
    occurrenceKey: evidenceText(value.occurrenceKey || nested.occurrenceKey),
  };
}

function evidenceScopeMatches(row, result) {
  return !!(
    row
    && evidenceText(result?.runResultId)
    && evidenceText(result?.testCaseId)
    && evidenceText(row.runResultId) === evidenceText(result.runResultId)
    && evidenceText(row.testCaseId) === evidenceText(result.testCaseId)
  );
}

function authoritativeLocatorRecipe(row, recipe) {
  if (!row || !recipe || typeof recipe !== 'object') return false;
  const proof = recipe.proof && typeof recipe.proof === 'object' ? recipe.proof : {};
  const chosenExpression = evidenceText(
    recipe.primaryExpression
      || recipe.frameworkExpressions?.playwright
      || row.primaryExpression,
  );
  return !!(
    chosenExpression
    && recipe.verified === true
    && proof.verified === true
    && proof.actionTimeResolved === true
    && proof.sameElement === true
    && proof.identityVerified === true
    && Number(proof.count) === 1
    && row.sameElementProof === true
    && Number(row.countBefore) === 1
    && Number(row.countAfter) === 1
    && replayLocatorContract.isVerifiedActionLocator(recipe)
  );
}

function exactActionEvidenceMatch(step, actionEvidence) {
  const stepIdentity = evidenceIdentity(step);
  const evidenceIdentityValue = evidenceIdentity(actionEvidence);
  const stepOperation = normalizedReplayAction(step.action || step.operation);
  const evidenceOperation = normalizedReplayAction(
    actionEvidence.operation || actionEvidence.actionKind || actionEvidence.toolName,
  );
  if (!stepOperation || !evidenceOperation || stepOperation !== evidenceOperation) return false;
  if (
    !stepIdentity.contractStepId
    || !evidenceIdentityValue.contractStepId
    || stepIdentity.contractStepId !== evidenceIdentityValue.contractStepId
  ) return false;
  if (stepIdentity.actionOccurrenceId || evidenceIdentityValue.actionOccurrenceId) {
    return !!(
      stepIdentity.actionOccurrenceId
      && evidenceIdentityValue.actionOccurrenceId
      && stepIdentity.actionOccurrenceId === evidenceIdentityValue.actionOccurrenceId
    );
  }
  if (stepIdentity.occurrenceKey || evidenceIdentityValue.occurrenceKey) {
    return !!(
      stepIdentity.occurrenceKey
      && evidenceIdentityValue.occurrenceKey
      && stepIdentity.occurrenceKey === evidenceIdentityValue.occurrenceKey
    );
  }
  return true;
}

function captureEvidenceStepOrdinal(value, fallback = null) {
  if (!value || typeof value !== 'object') return fallback;
  for (const candidate of [
    value.authoredStepOrdinal,
    value.stepOrdinal,
    value.order,
    value.stepNumber,
    value.sequenceIndex,
  ]) {
    const numeric = Number(candidate);
    if (Number.isInteger(numeric) && numeric > 0) return numeric;
  }
  for (const candidate of [
    value.contractStepId,
    value.contractRef,
    value.stepId,
    value.id,
  ]) {
    const raw = String(candidate == null ? '' : candidate);
    const match = raw.match(/(?:^|[_:-])step[_:-]?(\d+)(?:$|[_:-])/i);
    if (match && Number(match[1]) > 0) return Number(match[1]);
  }
  return fallback;
}

function usableHttpNavigationUrl(value) {
  const url = evidenceText(value);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  } catch (_) {
    return null;
  }
  return url;
}

function verifiedRequestedNavigation(row) {
  if (!row || typeof row !== 'object') return null;
  const detail = evidenceJson(row.evidenceJson, {}) || {};
  const requestedUrl = usableHttpNavigationUrl(
    row.requestedUrl || row.requestUrl || detail.requestedUrl || detail.requestUrl,
  );
  if (!requestedUrl) return null;
  const resolvedUrl = evidenceText(
    row.resolvedUrl || row.finalUrl || detail.resolvedUrl || detail.finalUrl,
  );
  if (resolvedUrl) {
    try {
      const parsed = new URL(resolvedUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    } catch (_) {
      return null;
    }
  }
  const loadStateProof =
    row.loadStateProof ||
    row.navigationProof ||
    detail.loadStateProof ||
    detail.navigationProof ||
    null;
  const corroborated =
    !!resolvedUrl ||
    !!loadStateProof ||
    row.landingVisibleConfirmed === true ||
    detail.landingVisibleConfirmed === true ||
    row.succeeded === true ||
    row.success === true;
  if (!corroborated || row.succeeded === false || row.success === false) return null;
  return requestedUrl;
}

function navigationOccurrenceCompatible(declared, row, declaredIndex) {
  const declaredIdentity = evidenceIdentity(declared);
  const rowIdentity = evidenceIdentity(row);
  if (
    declaredIdentity.contractStepId &&
    rowIdentity.contractStepId &&
    declaredIdentity.contractStepId === rowIdentity.contractStepId
  ) return true;
  const declaredOrdinal = captureEvidenceStepOrdinal(declared, declaredIndex + 1);
  const rowOrdinal = captureEvidenceStepOrdinal(row, null);
  if (!declaredOrdinal || !rowOrdinal || declaredOrdinal !== rowOrdinal) return false;
  if (
    declaredIdentity.actionOccurrenceId ||
    rowIdentity.actionOccurrenceId
  ) {
    if (
      declaredIdentity.actionOccurrenceId &&
      rowIdentity.actionOccurrenceId &&
      declaredIdentity.actionOccurrenceId !== rowIdentity.actionOccurrenceId
    ) return false;
  }
  if (declaredIdentity.occurrenceKey || rowIdentity.occurrenceKey) {
    if (
      declaredIdentity.occurrenceKey &&
      rowIdentity.occurrenceKey &&
      declaredIdentity.occurrenceKey !== rowIdentity.occurrenceKey
    ) return false;
  }
  return true;
}

function copyNavigationEvidenceIdentity(target, row) {
  const nested = row?.actionIdentity && typeof row.actionIdentity === 'object'
    ? row.actionIdentity
    : {};
  for (const field of [
    'runId',
    'runResultId',
    'testCaseId',
    'caseId',
    'actionOccurrenceId',
    'authoredActionId',
    'occurrenceKey',
    'sequenceIndex',
    'occurrenceOrdinal',
  ]) {
    const value = row?.[field] ?? nested[field];
    if (target[field] == null && value != null) target[field] = value;
  }
  const sourceContractStepId = evidenceIdentity(row).contractStepId;
  if (target.sourceContractStepId == null && sourceContractStepId)
    target.sourceContractStepId = sourceContractStepId;
}

function hydrateNavigationEvidence(result, evidence, steps) {
  const rows = (Array.isArray(evidence.navigationEvidences)
    ? evidence.navigationEvidences
    : [])
    .filter((row) => evidenceScopeMatches(row, result))
    .map((row) => ({ row, requestedUrl: verifiedRequestedNavigation(row) }))
    .filter((entry) => !!entry.requestedUrl);
  if (!rows.length) return 0;
  const declaredNavigations = (Array.isArray(result.declaredSteps) ? result.declaredSteps : [])
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => normalizedReplayAction(step?.action || step?.operation) === 'navigate');
  let hydrated = 0;
  for (const { step: declared, index } of declaredNavigations) {
    const explicitUrl = usableHttpNavigationUrl(
      declared.url || declared.href || declared.destination || declared.value,
    );
    if (explicitUrl) continue;
    const matches = rows.filter(({ row }) => navigationOccurrenceCompatible(declared, row, index));
    if (matches.length !== 1) continue;
    const { row, requestedUrl } = matches[0];
    const declaredId = evidenceText(
      declared.contractStepId || declared.stepId || declared.id,
    );
    let navigation = steps.find((candidate) =>
      candidate?.op === 'act' &&
      normalizedReplayAction(candidate.action) === 'navigate' &&
      !candidate.evidenceOnly &&
      (!declaredId || evidenceText(candidate.contractStepId || candidate.stepId || candidate.id) === declaredId),
    );
    if (!navigation) {
      navigation = {
        op: 'act',
        action: 'navigate',
        contractStepId: declaredId || evidenceIdentity(row).contractStepId,
        authored: true,
      };
      steps.push(navigation);
    }
    if (!evidenceText(navigation.url || navigation.href || navigation.destination))
      navigation.url = requestedUrl;
    copyNavigationEvidenceIdentity(navigation, row);
    navigation.navigationEvidenceId = row.id || null;
    navigation.captureEvidenceHydrated = true;
    navigation.canonicalExecution = true;
    navigation.success = true;
    navigation.executionStatus = 'passed';
    navigation.origin = navigation.origin || 'runtime_evidence';
    hydrated += 1;
  }
  return hydrated;
}

function hydrateReplayIrFromCaptureEvidence(result) {
  const evidence = result?.captureFirstEvidence;
  if (!result || !evidence || typeof evidence !== 'object') return result;
  const ir = result.envelope?.ir;
  const steps = Array.isArray(ir?.steps) ? ir.steps : [];
  const actionRows = (Array.isArray(evidence.actionEvidences) ? evidence.actionEvidences : [])
    .filter((row) => evidenceScopeMatches(row, result) && successfulActionEvidence(row));
  const recipeRows = (Array.isArray(evidence.locatorRecipes) ? evidence.locatorRecipes : [])
    .filter((row) => evidenceScopeMatches(row, result));
  const recipeById = new Map(recipeRows.map((row) => [evidenceText(row.id), row]));
  const resolveByRef = new Map(
    steps
      .filter((step) => step?.op === 'resolve' && step.as != null)
      .map((step) => [String(step.as), step]),
  );
  const hydratedLocatorEvidenceIds = new Set();
  const claimedActionEvidenceRows = new Set();
  let locatorCount = 0;
  const navigationCount = hydrateNavigationEvidence(result, evidence, steps);

  for (const act of steps.filter((step) => step?.op === 'act' && LOCATOR_DEPENDENT_ACTIONS.has(step.action))) {
    const actIdentity = evidenceIdentity(act);
    const hasOccurrenceIdentity = !!(actIdentity.actionOccurrenceId || actIdentity.occurrenceKey);
    if (!hasOccurrenceIdentity) {
      const operation = normalizedReplayAction(act.action || act.operation);
      const peers = steps.filter((candidate) => {
        if (!candidate || candidate.op !== 'act') return false;
        const identity = evidenceIdentity(candidate);
        return identity.contractStepId === actIdentity.contractStepId
          && normalizedReplayAction(candidate.action || candidate.operation) === operation;
      });
      if (peers.length !== 1) continue;
    }
    const matches = actionRows.filter(
      (row) => !claimedActionEvidenceRows.has(row) && exactActionEvidenceMatch(act, row),
    );
    if (matches.length !== 1) continue;
    const actionRow = matches[0];
    const recipeRow = recipeById.get(evidenceText(actionRow.locatorRecipeId));
    if (!recipeRow || !evidenceText(actionRow.locatorRecipeId)) continue;
    if (evidenceText(recipeRow.contractStepId) !== evidenceIdentity(actionRow).contractStepId) continue;
    const recipe = evidenceJson(recipeRow.locatorRecipeJson, null);
    if (!authoritativeLocatorRecipe(recipeRow, recipe)) continue;
    const resolve = act.target != null ? resolveByRef.get(String(act.target)) : null;
    if (!resolve) continue;
    const resolveIdentity = evidenceIdentity(resolve);
    if (
      resolveIdentity.contractStepId
      && resolveIdentity.contractStepId !== actIdentity.contractStepId
    ) continue;
    if (
      resolveIdentity.actionOccurrenceId
      && resolveIdentity.actionOccurrenceId !== actIdentity.actionOccurrenceId
    ) continue;
    const chosenExpression = recipe.primaryExpression
      || recipe.frameworkExpressions?.playwright
      || recipeRow.primaryExpression;
    const provenance = {
      ...(recipe.provenance && typeof recipe.provenance === 'object' ? recipe.provenance : {}),
      source: recipe.source || recipeRow.source || 'capture_first_evidence',
      chosenExpression,
      verified: true,
      actionTimeResolved: true,
      sameElement: true,
      identityVerified: true,
      locatorRecipeId: recipeRow.id,
      actionEvidenceId: actionRow.id,
    };
    for (const step of [resolve, act]) {
      step.locatorRecipe = recipe;
      step.actionLocator = recipe;
      step.locatorProvenance = provenance;
      step.guessedLocator = false;
      step.locatorConfidence = 'verified';
      step.captureEvidenceHydrated = true;
      step.canonicalExecution = true;
      step.success = true;
      step.executionStatus = 'passed';
      step.origin = step.origin || 'runtime_evidence';
      step.locatorRecipeId = recipeRow.id;
      step.actionEvidenceId = actionRow.id;
    }
    hydratedLocatorEvidenceIds.add(evidenceText(actionRow.id));
    claimedActionEvidenceRows.add(actionRow);
    locatorCount += 1;
  }

  const assertionRows = (Array.isArray(evidence.assertionEvidences) ? evidence.assertionEvidences : [])
    .filter((row) => {
      if (
        !evidenceScopeMatches(row, result) ||
        !evaluatedAssertionEvidence(row) ||
        !evidenceText(row.assertionId)
      ) {
        return false;
      }
      const detail = evidenceJson(row.evidenceJson, {}) || {};
      return detail.parseFailed !== true && detail.concrete !== false;
    });
  const assertionSteps = steps.filter((step) => step?.op === 'assert');
  const hydratedAssertionIds = new Set();
  result.liveOutcomes = result.liveOutcomes && typeof result.liveOutcomes === 'object'
    ? result.liveOutcomes
    : {};
  for (const row of assertionRows) {
    const assertionId = evidenceText(row.assertionId);
    const matches = assertionSteps.filter((step) => {
      const stepId = evidenceText(step.assertionId || step.contractRef || step.id || replayStepIdentity(step));
      return stepId === assertionId;
    });
    if (matches.length > 1) continue;
    const expected = evidenceJson(row.expectedJson, row.expectedJson);
    const actual = evidenceJson(row.actualJson, row.actualJson);
    const detail = evidenceJson(row.evidenceJson, {}) || {};
    const matched =
      typeof row.matched === 'boolean'
        ? row.matched
        : typeof detail.matched === 'boolean'
          ? detail.matched
          : successfulActionEvidence(row);
    result.liveOutcomes[assertionId] = {
      ...(result.liveOutcomes[assertionId] || {}),
      id: assertionId,
      assertionId,
      outcome: matched ? 'matched' : 'not_matched',
      matched,
      checked: true,
      expected,
      actual,
      source: row.source || 'capture_first_assertion_evidence',
      assertionEvidenceId: row.id,
    };
    if (matches.length === 1) {
      Object.assign(matches[0], {
        assertionId,
        expected,
        actual,
        liveOutcome: matched ? 'matched' : 'not_matched',
        matched,
        checked: true,
        outcome: matched ? 'matched' : 'not_matched',
        assertionEvidenceId: row.id,
        captureEvidenceHydrated: true,
        canonicalExecution: true,
        origin: matches[0].origin || 'runtime_evidence',
      });
    }
    hydratedAssertionIds.add(assertionId);
  }

  if (result.envelope && Array.isArray(result.envelope.gaps) && hydratedAssertionIds.size) {
    result.envelope.gaps = result.envelope.gaps.filter((gap) => {
      if (gap?.code !== 'assertion_translation_gap') return true;
      const identity = evidenceText(gap.where || gap.assertionId || gap.contractRef);
      return !hydratedAssertionIds.has(identity);
    });
  }
  result.captureEvidenceHydration = {
    locatorCount,
    navigationCount,
    assertionCount: hydratedAssertionIds.size,
    actionEvidenceIds: [...hydratedLocatorEvidenceIds],
    assertionIds: [...hydratedAssertionIds],
  };
  return result;
}

function completeReplayIrLocators(result) {
  const ir = result && result.envelope && result.envelope.ir;
  if (!ir || !Array.isArray(ir.steps)) return result;
  const resolves = new Map();
  for (const step of ir.steps) {
    if (step && step.op === 'resolve' && step.as != null) resolves.set(String(step.as), step);
  }
  const usedRefs = new Set(resolves.keys());
  const evidenceIntegrityGaps = [];
  const exactLocator = (...values) => values.find(
    (value) => replayLocatorContract.isVerifiedActionLocator(value),
  ) || null;
  const clearUnverifiedLocatorMaterial = (resolve) => {
    if (!resolve || typeof resolve !== 'object') return;
    if (!resolve.captureEvidenceHydrated && locatorStructureIsUnstable(resolve.actionLocator)) delete resolve.actionLocator;
    if (!resolve.captureEvidenceHydrated && locatorStructureIsUnstable(resolve.locatorRecipe)) delete resolve.locatorRecipe;
    const verified = exactLocator(resolve.actionLocator, resolve.locatorRecipe);
    if (!verified) {
      delete resolve.actionLocator;
      delete resolve.locatorRecipe;
      delete resolve.candidates;
      delete resolve.locatorProvenance;
      delete resolve.locatorConfidence;
      delete resolve.guessedLocator;
      resolve.diagnosticOnly = true;
      resolve.executable = false;
      resolve.evidenceIntegrityStatus = 'exact_action_locator_missing';
    } else {
      resolve.actionLocator = verified;
      resolve.locatorRecipe = verified;
      resolve.guessedLocator = false;
      resolve.locatorConfidence = 'verified';
      delete resolve.diagnosticOnly;
      delete resolve.evidenceIntegrityStatus;
    }
  };
  for (const resolve of resolves.values()) clearUnverifiedLocatorMaterial(resolve);

  const recordEvidenceIntegrityGap = (action, resolve = null) => {
    const identity = evidenceIdentity(action);
    const where = identity.actionOccurrenceId
      || identity.occurrenceKey
      || identity.contractStepId
      || replayStepIdentity(action)
      || `runtime-action-${evidenceIntegrityGaps.length + 1}`;
    const gap = {
      code: 'platform_action_locator_evidence_missing',
      category: 'platform_evidence_integrity_failure',
      where,
      contractStepId: identity.contractStepId || null,
      actionOccurrenceId: identity.actionOccurrenceId || null,
      occurrenceKey: identity.occurrenceKey || null,
      operation: normalizedReplayAction(action && (action.action || action.operation)) || null,
      performed: true,
      nonBlocking: true,
      detail: 'The browser action succeeded, but no persisted exact-node verified locator could be closed from the available Output evidence sources. The action remains diagnostic and no locator was guessed.',
    };
    evidenceIntegrityGaps.push(gap);
    if (resolve && typeof resolve === 'object') resolve.evidenceIntegrityGap = gap;
    if (action && typeof action === 'object') action.evidenceIntegrityGap = gap;
  };

  for (const [ref, resolve] of resolves) {
    if (exactLocator(resolve.actionLocator, resolve.locatorRecipe)) continue;
    const consumers = ir.steps.filter(
      (step) => step && step.op === 'act' && String(step.target || '') === ref
        && replayStepHasPositiveExecutionProvenance(step),
    );
    for (const consumer of consumers) {
      const recovered = exactLocator(consumer.actionLocator, consumer.locatorRecipe);
      if (recovered) {
        resolve.actionLocator = recovered;
        resolve.locatorRecipe = recovered;
        resolve.guessedLocator = false;
        resolve.locatorConfidence = 'verified';
        delete resolve.diagnosticOnly;
        delete resolve.evidenceIntegrityStatus;
        continue;
      }
      recordEvidenceIntegrityGap(consumer, resolve);
    }
  }
  const completed = [];
  for (const original of ir.steps) {
    if (!original || original.op !== 'act' || !LOCATOR_DEPENDENT_ACTIONS.has(original.action)) {
      completed.push(original);
      continue;
    }
    if (!replayStepHasPositiveExecutionProvenance(original)) {
      completed.push(original);
      continue;
    }
    let action = original;
    let resolve = action.target != null ? resolves.get(String(action.target)) || null : null;
    if (resolve) clearUnverifiedLocatorMaterial(resolve);
    if (!resolve) {
      const recovered = exactLocator(action.actionLocator, action.locatorRecipe);
      if (recovered) {
        const semanticLabel = semanticActionLabel(action);
        const stableRef = semanticResolveRef(semanticLabel, action.action, usedRefs);
        resolve = {
          op: 'resolve',
          as: stableRef,
          elementLabel: semanticLabel,
          actionLocator: recovered,
          locatorRecipe: recovered,
          guessedLocator: false,
          locatorConfidence: 'verified',
          contractStepId: action.contractStepId || action.contractRef || null,
          actionOccurrenceId: action.actionOccurrenceId || action.actionIdentity?.actionOccurrenceId || null,
          occurrenceKey: action.occurrenceKey || action.actionIdentity?.occurrenceKey || null,
          captureEvidenceHydrated: action.captureEvidenceHydrated === true,
          canonicalExecution: true,
          origin: 'runtime_evidence_projection',
        };
        resolves.set(stableRef, resolve);
        action = { ...action, target: stableRef };
        completed.push(resolve);
      } else if (!action.evidenceIntegrityGap) {
        recordEvidenceIntegrityGap(action);
      }
    }
    if (!resolve || !exactLocator(resolve.actionLocator, resolve.locatorRecipe)) {
      action = {
        ...action,
        diagnosticOnly: true,
        evidenceOnly: action.authored === true ? false : true,
        executable: false,
        evidenceIntegrityStatus: 'exact_action_locator_missing',
      };
    }
    completed.push(action);
  }
  ir.steps = completed;
  if (evidenceIntegrityGaps.length) {
    const mergeGaps = (current) => [...(Array.isArray(current) ? current : []), ...evidenceIntegrityGaps]
      .filter((gap, index, all) => all.findIndex((candidate) =>
        candidate && gap && candidate.code === gap.code && candidate.where === gap.where,
      ) === index);
    ir.gaps = mergeGaps(ir.gaps);
    ir.complete = false;
    result.envelope.gaps = mergeGaps(result.envelope.gaps);
    result.envelope.complete = false;
  }
  result.outputEvidenceIntegrity = {
    schema: 'qaai-output-evidence-integrity/1',
    exactLocatorGapCount: evidenceIntegrityGaps.length,
    gaps: evidenceIntegrityGaps,
  };
  return result;
}

function trailFromLiveLedger(result) {
  const ledger = result && result.liveScriptLedger;
  if (!ledger) return [];
  return liveScriptRecorder
    .canonicalLines(ledger)
    .filter(
      (line) =>
        line &&
        line.kind !== 'assert' &&
        line.source !== 'NavigationEvidence',
    )
    .map((line) => ({
      tool: line.tool || `browser_${line.kind}`,
      canonicalLiveLedger: true,
      contractStepId: line.contractStepId || null,
      sourceContractStepId: line.sourceContractStepId || null,
      actionOccurrenceId: line.actionOccurrenceId || null,
      sourceActionOccurrenceId: line.sourceActionOccurrenceId || null,
      authoredActionId: line.authoredActionId || null,
      occurrenceKey: line.occurrenceKey || null,
      occurrenceOrdinal: line.occurrenceOrdinal || null,
      authoredSequenceIndex: line.authoredSequenceIndex || null,
      actionAttemptId: line.actionAttemptId || null,
      actionIdentity: line.actionIdentity || null,
      actionDispatchIdentity: line.actionDispatchIdentity || null,
      stepAuthoring: line.stepAuthoring || null,
      args: {
        element: line.label || null,
        valueRef: line.valueRef || null,
        url:
          line.kind === 'navigate'
            ? line.metadata?.requestedUrl || line.metadata?.pageUrl || null
            : null,
      },
      actionLocator: actionLocatorResolver.isVerifiedActionLocator(line.locatorProvenance)
        ? line.locatorProvenance
        : line.locatorExpression
          ? {
            expression: line.locatorExpression,
            frameworkExpressions: { playwright: line.locatorExpression },
            verified: false,
            verificationSource:
              line.locatorGuessed === true ? 'qaai_guessed_locator' : 'live_script_ledger_unverified',
            }
          : null,
      ok: !line.failureBoundary,
    }));
}

function trailFromCaptureFirstEvidence(result) {
  const capture = result?.captureFirstEvidence;
  if (!capture || typeof capture !== 'object') return [];
  const actionRows = (Array.isArray(capture.actionEvidences) ? capture.actionEvidences : [])
    .filter((row) => evidenceScopeMatches(row, result) && successfulActionEvidence(row));
  const recipeRows = (Array.isArray(capture.locatorRecipes) ? capture.locatorRecipes : [])
    .filter((row) => evidenceScopeMatches(row, result));
  const recipeById = new Map(recipeRows.map((row) => [evidenceText(row.id), row]));

  return actionRows.map((row) => {
    const detail = evidenceJson(row.evidenceJson, {}) || {};
    const identity = evidenceIdentity(row);
    const recipeId = evidenceText(row.locatorRecipeId);
    const recipeRow = recipeId ? recipeById.get(recipeId) : null;
    const recipe = recipeRow ? evidenceJson(recipeRow.locatorRecipeJson, null) : null;
    const recipeIdentity = recipeRow ? evidenceIdentity(recipeRow) : {};
    const sameContract =
      !identity.contractStepId ||
      !recipeIdentity.contractStepId ||
      identity.contractStepId === recipeIdentity.contractStepId;
    const sameOccurrence =
      (!identity.actionOccurrenceId ||
        !recipeIdentity.actionOccurrenceId ||
        identity.actionOccurrenceId === recipeIdentity.actionOccurrenceId) &&
      (!identity.occurrenceKey ||
        !recipeIdentity.occurrenceKey ||
        identity.occurrenceKey === recipeIdentity.occurrenceKey);
    const exactRecipe =
      recipeRow &&
      recipeId &&
      sameContract &&
      sameOccurrence &&
      replayLocatorContract.isVerifiedActionLocator(recipe)
        ? recipe
        : null;
    const args = {
      ...((detail.args && typeof detail.args === 'object') ? detail.args : {}),
    };
    if (args.element == null) {
      args.element =
        detail.elementLabel ||
        detail.targetLabel ||
        row.elementLabel ||
        row.targetLabel ||
        null;
    }
    return {
      tool:
        evidenceText(row.toolName || row.tool) ||
        `browser_${evidenceText(row.actionKind || row.operation || 'action')}`,
      args,
      ok: true,
      status: row.status || 'passed',
      canonicalCaptureFirstEvidence: true,
      runResultId: row.runResultId || result.runResultId || null,
      testCaseId: row.testCaseId || result.testCaseId || null,
      contractStepId: identity.contractStepId || null,
      actionOccurrenceId: identity.actionOccurrenceId || null,
      occurrenceKey: identity.occurrenceKey || null,
      occurrenceOrdinal: row.occurrenceOrdinal || row.actionIdentity?.occurrenceOrdinal || null,
      authoredSequenceIndex:
        row.authoredSequenceIndex || row.sequenceIndex || row.actionIdentity?.sequenceIndex || null,
      authoredActionId: row.authoredActionId || row.actionIdentity?.authoredActionId || null,
      actionIdentity: row.actionIdentity || null,
      actionEvidenceId: row.id || null,
      locatorRecipeId: recipeId || null,
      actionLocator: exactRecipe,
      locatorRecipe: exactRecipe,
      locatorEvidenceV2: exactRecipe
        ? {
            source: 'capture_first_evidence',
            actionEvidenceId: row.id || null,
            locatorRecipeId: recipeId,
            actionLocator: exactRecipe,
          }
        : null,
    };
  });
}

function mergeExecutedEvidenceTrails(ledgerTrail, captureTrail) {
  const merged = Array.isArray(ledgerTrail) ? ledgerTrail.map((entry) => ({ ...entry })) : [];
  for (const captured of Array.isArray(captureTrail) ? captureTrail : []) {
    const capturedIdentity = evidenceIdentity(captured);
    const capturedOperation = normalizedReplayAction(
      captured.action || captured.operation || captured.tool,
    );
    const matchIndex = merged.findIndex((existing) => {
      const existingIdentity = evidenceIdentity(existing);
      const existingOperation = normalizedReplayAction(
        existing.action || existing.operation || existing.tool,
      );
      if (capturedOperation !== existingOperation) return false;
      if (capturedIdentity.occurrenceKey && existingIdentity.occurrenceKey)
        return capturedIdentity.occurrenceKey === existingIdentity.occurrenceKey;
      if (capturedIdentity.actionOccurrenceId && existingIdentity.actionOccurrenceId)
        return capturedIdentity.actionOccurrenceId === existingIdentity.actionOccurrenceId;
      return false;
    });
    if (matchIndex < 0) {
      merged.push(captured);
      continue;
    }
    merged[matchIndex] = {
      ...merged[matchIndex],
      ...captured,
      args: { ...(merged[matchIndex].args || {}), ...(captured.args || {}) },
      actionLocator:
        captured.actionLocator || merged[matchIndex].actionLocator || null,
      locatorRecipe:
        captured.locatorRecipe || merged[matchIndex].locatorRecipe || null,
    };
  }
  return merged;
}

function assertionsFromLiveLedger(result) {
  const ledger = result && result.liveScriptLedger;
  if (!ledger) return [];
  return liveScriptRecorder
    .canonicalLines(ledger)
    .filter((line) => line && line.kind === 'assert')
    .map((line, index) => {
      const id =
        line.metadata?.assertionId ||
        line.contractStepId ||
        line.id ||
        `ledger-assertion-${index + 1}`;
      const matched =
        typeof line.metadata?.assertionPassed === 'boolean'
          ? line.metadata.assertionPassed
          : !line.failureBoundary;
      const expected = line.metadata?.expected ?? line.failureBoundary?.expected ?? line.label;
      const actual = line.metadata?.actual ?? line.failureBoundary?.actual ?? null;
      return {
        id,
        assertionId: id,
        assertionEvidenceId: line.metadata?.assertionEvidenceId || null,
        type: line.metadata?.expectedUrlPattern ? 'URL' : 'UI_TEXT',
        payload: line.metadata?.expectedUrlPattern
          ? { expectedUrlPattern: line.metadata.expectedUrlPattern }
          : { expectedText: expected ?? 'expected page state' },
        matched,
        checked: true,
        outcome: matched ? 'matched' : 'not_matched',
        expected,
        actual,
        evidence: actual ?? line.label ?? null,
      };
    });
}

function refreshPreparedOccurrenceParity(result) {
  const ir = result?.envelope?.ir;
  const capture = result?.captureFirstEvidence;
  const actionEvidences = Array.isArray(capture?.actionEvidences)
    ? capture.actionEvidences
    : [];
  if (!ir || !Array.isArray(ir.steps) || !actionEvidences.length) return result;
  const runResultId = String(result.runResultId || '').trim();
  const testCaseId = String(result.testCaseId || ir.caseId || '').trim();
  if (!runResultId || !testCaseId) return result;
  const canonicalization = evidenceReplayIr.canonicalizeReplayTrailOccurrences({
    trail: trailFromLiveLedger(result),
    runResultId,
    testCaseId,
  });
  const emit = { ir, findings: [] };
  const refreshed = evidenceReplayIr.applyAuthoredOccurrenceParityInvariant({
    emit,
    evidence: {
      runResultId,
      testCaseId,
      actionEvidences,
      locatorRecipes: Array.isArray(capture?.locatorRecipes) ? capture.locatorRecipes : [],
      ledger: latestLedgerForResult(result),
    },
    canonicalization,
  });
  const report = refreshed?.report;
  if (!report) return result;
  result.envelope.evidenceBuiltReplayIr = {
    ...(result.envelope.evidenceBuiltReplayIr || {}),
    authoredOccurrenceParity: {
      schemaVersion: report.schemaVersion,
      satisfied: report.satisfied,
      expectedAuthoredOccurrenceCount: report.expectedAuthoredOccurrenceCount,
      matchedAuthoredOccurrenceCount: report.matchedAuthoredOccurrenceCount,
      missingAuthoredOccurrenceCount: report.missingAuthoredOccurrenceCount,
      duplicateReplayOccurrenceCount: report.duplicateReplayOccurrenceCount,
      retryOrDiagnosticAttemptCount: report.retryOrDiagnosticAttemptCount,
      foreignOccurrenceCount: report.foreignOccurrenceCount,
    },
  };
  return result;
}

function authoredActionForExport(step = {}) {
  const raw = step && typeof step.raw === 'object' ? step.raw : {};
  const source = String(
    step.action ||
      step.actionType ||
      raw.action ||
      step.type ||
      step.kind ||
      step.plannedText ||
      step.text ||
      '',
  )
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  if (/^(navigate|go) back\b/.test(source)) return 'navigateBack';
  if (/^(navigate|go) forward\b/.test(source)) return 'navigateForward';
  if (/^(navigate|go to|open url|visit)\b/.test(source)) return 'navigate';
  if (/^(fill|type|enter|input)\b/.test(source)) return 'fill';
  if (/^(select|choose)\b/.test(source)) return 'selectOption';
  if (/^(check|tick)\b/.test(source)) return 'check';
  if (/^(uncheck|untick)\b/.test(source)) return 'uncheck';
  if (/^(double click|doubleclick)\b/.test(source)) return 'doubleClick';
  if (/^(triple click|tripleclick)\b/.test(source)) return 'tripleClick';
  if (/^(click|tap|submit)\b/.test(source)) return 'click';
  if (/^hover\b/.test(source)) return 'hover';
  if (/^(drag|move)\b/.test(source)) return 'drag';
  if (/^(upload|attach)\b/.test(source)) return 'upload';
  if (/^(press|key)\b/.test(source)) return 'press';
  if (/^(handle|accept|dismiss).*(dialog|alert|confirm|prompt)\b/.test(source))
    return 'handleDialog';
  if (/^(resize|set viewport)\b/.test(source)) return 'resize';
  if (/^close\b/.test(source)) return 'close';
  if (/^wait\b/.test(source)) return 'waitFor';
  return null;
}

function authoredStepId(step, index) {
  return String(step?.contractStepId || step?.stepId || step?.id || `planned-step-${index + 1}`);
}

function emitterAuthoredAction(action) {
  return (
    {
      navigateBack: 'navigate back',
      navigateForward: 'navigate forward',
      selectOption: 'select',
      doubleClick: 'double click',
      tripleClick: 'triple click',
      handleDialog: 'handle dialog',
      waitFor: 'wait',
    }[action] || action
  );
}

function authoredStepsForExport(result) {
  const contractSteps = Array.isArray(result?.executionContract?.steps)
    ? result.executionContract.steps
    : Array.isArray(result?.executionContract?.nodes)
      ? result.executionContract.nodes
      : [];
  const declaredSteps = Array.isArray(result?.declaredSteps) ? result.declaredSteps : [];
  if (!contractSteps.length) return declaredSteps;

  const contractIdentityValues = (step) => [
    step?.contractStepId,
    step?.stepId,
    step?.id,
    step?.sourceStepId,
    step?.sourceContractStepId,
    step?.authoredStepId,
    step?.contractRef,
    step?.raw?.contractStepId,
    step?.raw?.stepId,
    step?.raw?.id,
  ].filter((value) => value != null).map(String);
  const contractOrdinal = (step, fallback) => Number(
    step?.stepOrdinal ?? step?.ordinal ?? step?.order ?? step?.sequenceIndex ?? fallback,
  );
  const usedContractIndexes = new Set();

  const mergeStep = (contractStep, declared, index) => {
    const persistedStepId = declared && (
      declared.contractStepId || declared.stepId || declared.id
    );
    const stableId = contractStep
      ? authoredStepId(contractStep, index)
      : String(persistedStepId || `planned-step-${index + 1}`);
    const raw = contractStep && typeof contractStep.raw === 'object' ? contractStep.raw : {};
    const existingSourceStepId = contractStep && (
      contractStep.sourceStepId || contractStep.sourceContractStepId || contractStep.authoredStepId
    );
    const sourceStepId = existingSourceStepId || (
      persistedStepId && String(persistedStepId) !== String(stableId)
        ? persistedStepId
        : null
    );
    const action = authoredActionForExport({ ...contractStep, ...(declared || {}) });
    const suppliedType = declared?.type || contractStep?.type;
    const type = /^(?:action|step)$/i.test(String(suppliedType || '')) ? undefined : suppliedType;
    const mergedStep = {
      ...raw,
      ...(contractStep || {}),
      ...(declared || {}),
      id: stableId,
      contractStepId: stableId,
      ...(sourceStepId ? { sourceStepId: String(sourceStepId) } : {}),
      type,
      action:
        emitterAuthoredAction(action) ||
        declared?.action ||
        contractStep?.actionType ||
        contractStep?.action ||
        raw.action,
      target:
        declared?.target || declared?.element || contractStep?.target || raw.target || raw.element,
      url: declared?.url || declared?.targetUrl || contractStep?.url || raw.url || raw.targetUrl,
      description: declared?.description || contractStep?.plannedText || contractStep?.description,
      authoredText:
        declared?.authoredText ||
        declared?.userAuthoredText ||
        contractStep?.authoredText ||
        contractStep?.userAuthoredText ||
        raw.authoredText ||
        declared?.description ||
        contractStep?.plannedText ||
        contractStep?.description ||
        null,
      logicalStepId:
        declared?.logicalStepId ||
        contractStep?.logicalStepId ||
        raw.logicalStepId ||
        stableId,
      atomicOrdinal:
        declared?.atomicOrdinal ??
        contractStep?.atomicOrdinal ??
        raw.atomicOrdinal ??
        null,
      atomicCount:
        declared?.atomicCount ??
        contractStep?.atomicCount ??
        raw.atomicCount ??
        null,
      dependsOn:
        declared?.dependsOn ??
        declared?.dependsOnStepIds ??
        contractStep?.dependsOn ??
        contractStep?.dependsOnStepIds,
    };
    const declaredAction = authoredActionForExport(declared || {});
    const declaredWait = declaredAction === 'waitFor' || /^wait\b/i.test(String(declared?.action || ''));
    if (!declaredWait && declared?.waitContract == null) delete mergedStep.waitContract;
    return mergedStep;
  };

  // Persisted authored steps define user-visible cardinality. Execution-contract
  // fragments may enrich those occurrences, but internal waits/assertion probes
  // must never become additional authored steps.
  if (declaredSteps.length) {
    return declaredSteps.map((declared, index) => {
      const declaredId = String(
        declared?.contractStepId || declared?.stepId || declared?.id || '',
      );
      let contractIndex = contractSteps.findIndex((step, candidateIndex) =>
        !usedContractIndexes.has(candidateIndex)
        && declaredId
        && contractIdentityValues(step).includes(declaredId),
      );
      if (contractIndex < 0) {
        const declaredOrdinal = Number(
          declared?.stepOrdinal ?? declared?.ordinal ?? declared?.order ?? index + 1,
        );
        contractIndex = contractSteps.findIndex((step, candidateIndex) =>
          !usedContractIndexes.has(candidateIndex)
          && Number.isFinite(declaredOrdinal)
          && contractOrdinal(step, candidateIndex + 1) === declaredOrdinal,
        );
      }
      if (contractIndex < 0 && contractSteps[index] && !usedContractIndexes.has(index)) {
        contractIndex = index;
      }
      if (contractIndex >= 0) usedContractIndexes.add(contractIndex);
      return mergeStep(contractIndex >= 0 ? contractSteps[contractIndex] : null, declared, index);
    });
  }
  return contractSteps.map((contractStep, index) => mergeStep(contractStep, null, index));
}

function authoredTraceIdentityValues(step) {
  return [
    step?.contractStepId,
    step?.stepId,
    step?.id,
    step?.nodeId,
    step?.sourceStepId,
    step?.sourceContractStepId,
    step?.authoredStepId,
    step?.contractRef,
    step?.actionIdentity?.contractStepId,
    step?.actionIdentity?.authoredActionId,
    step?.raw?.contractStepId,
    step?.raw?.stepId,
    step?.raw?.id,
  ].filter((value) => value != null && value !== '').map(String);
}

function authoredTraceText(step, index) {
  if (typeof step === 'string') return step;
  return (
    step?.authoredText ||
    step?.userAuthoredText ||
    step?.raw?.authoredText ||
    step?.plannedText ||
    step?.text ||
    step?.description ||
    step?.instruction ||
    step?.name ||
    [step?.action, step?.target || step?.element].filter(Boolean).join(' ') ||
    `Step ${index + 1}`
  );
}

function interpretedTraceText(step, index) {
  return (
    step?.plannedText ||
    step?.text ||
    step?.description ||
    step?.instruction ||
    [step?.action, step?.target || step?.element].filter(Boolean).join(' ') ||
    authoredTraceText(step, index)
  );
}

function replayRuntimeTraceAction(step, resolves, index) {
  const resolve = step?.target != null ? resolves.get(String(step.target)) : null;
  return {
    index,
    replayStepId: replayStepIdentity(step) || step?.id || null,
    contractStepId:
      step?.contractStepId ||
      step?.sourceContractStepId ||
      step?.sourceStepId ||
      null,
    op: step?.op || null,
    action: step?.action || step?.channel || null,
    target:
      resolve?.elementLabel ||
      resolve?.label ||
      resolve?.candidates?.find(Boolean)?.name ||
      resolve?.candidates?.find(Boolean)?.text ||
      step?.targetLabel ||
      step?.elementLabel ||
      (step?.target != null ? String(step.target) : null),
    expected: step?.expected ?? step?.value ?? null,
    executionProvenance: step?.executionProvenance || step?.provenance || null,
  };
}

/**
 * Preserve authored intent as traceability metadata only. Runtime actions remain
 * sourced from positively executed ReplayIR, so this projection cannot turn
 * narration into executable code or bypass locator evidence policy.
 */
function buildAuthoredRuntimeTraceability(result) {
  const planned = authoredStepsForExport(result);
  const irSteps = Array.isArray(result?.envelope?.ir?.steps) ? result.envelope.ir.steps : [];
  const resolves = new Map(
    irSteps
      .filter((step) => step?.op === 'resolve' && step.as != null)
      .map((step) => [String(step.as), step]),
  );
  const executable = irSteps.filter((step) => (
    step
    && step.op !== 'resolve'
    && replayStepHasPositiveExecutionProvenance(step)
  ));
  const runtimeByAuthoredId = new Map();
  executable.forEach((step, index) => {
    authoredTraceIdentityValues(step).forEach((identity) => {
      if (!runtimeByAuthoredId.has(identity)) runtimeByAuthoredId.set(identity, []);
      runtimeByAuthoredId.get(identity).push({ step, index });
    });
  });

  const groups = [];
  const byLogicalId = new Map();
  planned.forEach((step, index) => {
    const physicalIds = authoredTraceIdentityValues(step);
    const physicalId = physicalIds[0] || `planned-step-${index + 1}`;
    const logicalId = String(step?.logicalStepId || step?.logicalId || physicalId);
    let group = byLogicalId.get(logicalId);
    if (!group) {
      group = {
        logicalStepId: logicalId,
        authoredText: authoredTraceText(step, index),
        interpretedAtomicActions: [],
        runtimeActions: [],
        runtimeActionKeys: new Set(),
      };
      groups.push(group);
      byLogicalId.set(logicalId, group);
    }
    group.interpretedAtomicActions.push({
      stepId: physicalId,
      atomicOrdinal: Number(step?.atomicOrdinal ?? group.interpretedAtomicActions.length + 1),
      action: authoredActionForExport(step) || step?.action || step?.type || null,
      text: interpretedTraceText(step, index),
      target: step?.target || step?.element || null,
    });

    const matches = [];
    for (const identity of physicalIds) {
      for (const match of runtimeByAuthoredId.get(identity) || []) {
        if (!matches.includes(match)) matches.push(match);
      }
    }
    for (const match of matches) {
      const projected = replayRuntimeTraceAction(match.step, resolves, match.index);
      const key = `${projected.index}:${projected.replayStepId || ''}:${projected.op || ''}`;
      if (group.runtimeActionKeys.has(key)) continue;
      group.runtimeActionKeys.add(key);
      group.runtimeActions.push(projected);
    }
  });

  return groups.map(({ runtimeActionKeys, ...group }) => ({
    ...group,
    runtimeActions: group.runtimeActions.sort((left, right) => left.index - right.index),
    executionAuthority: 'positively_executed_replay_ir',
  }));
}

function buildAuthoredRuntimeTraceabilityDocument(results = []) {
  const entries = (Array.isArray(results) ? results : []).map((result) => ({
    runResultId: result?.runResultId || null,
    testCaseId: result?.testCaseId || null,
    caseName: result?.caseName || null,
    authoredSteps: buildAuthoredRuntimeTraceability(result),
  }));
  return {
    schema: 'qaai-authored-runtime-traceability/1',
    executableAuthority: 'positively_executed_replay_ir',
    entries,
  };
}

function assertionExportPayload(assertion) {
  return assertion?.payload && typeof assertion.payload === 'object' && !Array.isArray(assertion.payload)
    ? assertion.payload
    : {};
}

function meaningfulAssertionExportValue(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some(meaningfulAssertionExportValue);
  if (typeof value === 'object') return Object.values(value).some(meaningfulAssertionExportValue);
  return false;
}

function assertionExpectedForExport(assertion) {
  const payload = assertionExportPayload(assertion);
  const values = [
    payload.expectedText,
    payload.expected,
    payload.expectedValue,
    payload.expectedCount,
    payload.expectedChecked,
    payload.expectedSelected,
    assertion?.expectedText,
    assertion?.expected,
    assertion?.expectedValue,
    assertion?.expectedCount,
    assertion?.expectedChecked,
    assertion?.expectedSelected,
    assertion?.postcondition?.expected,
  ];
  for (const value of values) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = assertionExpectedForExport(value);
      if (meaningfulAssertionExportValue(nested)) return nested;
      continue;
    }
    if (meaningfulAssertionExportValue(value)) return value;
  }
  return null;
}

function assertionTargetForExport(assertion) {
  const payload = assertionExportPayload(assertion);
  return [
    payload.target,
    payload.element,
    payload.field,
    payload.label,
    assertion?.target,
    assertion?.element,
    assertion?.field,
    assertion?.label,
  ].find(meaningfulAssertionExportValue) ?? null;
}

function assertionSignalsForExport(assertion) {
  const payload = assertionExportPayload(assertion);
  return [
    payload.expectedSignals,
    payload.signals,
    payload.primaryIndicator,
    assertion?.expectedSignals,
    assertion?.signals,
    assertion?.primaryIndicator,
  ].find(meaningfulAssertionExportValue) ?? null;
}

function assertionScopeForExport(assertion) {
  const payload = assertionExportPayload(assertion);
  return [payload.scope, payload.selector, assertion?.scope, assertion?.selector].find(
    meaningfulAssertionExportValue,
  ) ?? null;
}

function assertionContractTextForExport(assertion) {
  const payload = assertionExportPayload(assertion);
  const text = [
    payload.description,
    payload.instruction,
    payload.assertion,
    payload.check,
    payload.plannedText,
    assertion?.description,
    assertion?.instruction,
    assertion?.assertion,
    assertion?.check,
    assertion?.plannedText,
  ].find(meaningfulAssertionExportValue);
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  if (/^(?:(?:declared|authored|ui[_ -]?text|page|text)\s+)?assertion(?:\s+contract)?$/i.test(normalized)) {
    return null;
  }
  return normalized;
}

function usableAssertionForExport(assertion) {
  return !!(
    assertion &&
    typeof assertion === 'object' &&
    (meaningfulAssertionExportValue(assertionTargetForExport(assertion)) ||
      meaningfulAssertionExportValue(assertionExpectedForExport(assertion)) ||
      meaningfulAssertionExportValue(assertionSignalsForExport(assertion)) ||
      meaningfulAssertionExportValue(assertionScopeForExport(assertion)) ||
      assertionContractTextForExport(assertion))
  );
}

function assertionSemanticKeyForExport(assertion) {
  const type = String(assertion?.type || assertion?.assertionType || assertion?.channel || 'UI_TEXT')
    .trim()
    .toUpperCase();
  return stableStringify([
    type,
    assertionTargetForExport(assertion),
    assertionExpectedForExport(assertion),
    assertionSignalsForExport(assertion),
    assertionScopeForExport(assertion),
    assertionContractTextForExport(assertion),
  ]);
}

function mergeAssertionExportRecords(preferred, fallback) {
  const merged = {
    ...(fallback || {}),
    ...(preferred || {}),
    payload: {
      ...assertionExportPayload(fallback),
      ...assertionExportPayload(preferred),
    },
  };
  for (const field of [
    'target',
    'element',
    'field',
    'label',
    'expectedText',
    'expected',
    'expectedValue',
    'expectedCount',
    'expectedChecked',
    'expectedSelected',
    'expectedSignals',
    'signals',
    'primaryIndicator',
    'scope',
    'selector',
    'description',
    'instruction',
    'assertion',
    'check',
    'plannedText',
  ]) {
    if (!meaningfulAssertionExportValue(merged[field]) && meaningfulAssertionExportValue(fallback?.[field])) {
      merged[field] = fallback[field];
    }
  }
  return merged;
}

function mergeUsableAssertionsForExport(assertions) {
  const merged = [];
  for (const assertion of assertions.filter(usableAssertionForExport)) {
    const id = assertion?.id || assertion?.contractStepId || assertion?.assertionId || null;
    const semanticKey = assertionSemanticKeyForExport(assertion);
    const existingIndex = merged.findIndex((candidate) => {
      const candidateId = candidate?.id || candidate?.contractStepId || candidate?.assertionId || null;
      return (id && candidateId && String(id) === String(candidateId)) ||
        assertionSemanticKeyForExport(candidate) === semanticKey;
    });
    if (existingIndex < 0) {
      merged.push(assertion);
    } else {
      merged[existingIndex] = mergeAssertionExportRecords(merged[existingIndex], assertion);
    }
  }
  return merged;
}

function executionContractAssertionsForExport(result) {
  const contractSteps = Array.isArray(result?.executionContract?.steps)
    ? result.executionContract.steps
    : Array.isArray(result?.executionContract?.nodes)
      ? result.executionContract.nodes
      : [];
  return contractSteps.flatMap((step, index) => {
    const kind = String(step?.kind || step?.nodeType || '').toLowerCase();
    if (kind !== 'assertion' && kind !== 'assert') return [];
    const raw = step && typeof step.raw === 'object' ? step.raw : {};
    const payload = {
      ...(raw.payload && typeof raw.payload === 'object' ? raw.payload : {}),
      ...(step.payload && typeof step.payload === 'object' ? step.payload : {}),
    };
    const expected = assertionExpectedForExport({ ...raw, ...step, payload });
    const target = assertionTargetForExport({ ...raw, ...step, payload });
    const type = step.assertionType || raw.assertionType || raw.type || 'UI_TEXT';
    const sourceStepId = [
      step.sourceStepId,
      step.sourceContractStepId,
      step.authoredStepId,
      raw.sourceStepId,
      raw.sourceContractStepId,
      raw.authoredStepId,
      payload.sourceStepId,
      payload.sourceContractStepId,
      payload.authoredStepId,
    ].find(meaningfulAssertionExportValue);
    if (target != null && !meaningfulAssertionExportValue(assertionTargetForExport({ payload }))) {
      payload.target = target;
    }
    if (expected != null && !meaningfulAssertionExportValue(assertionExpectedForExport({ payload }))) {
      payload.expectedText = expected;
    }
    return [
      {
        id: sourceStepId ? String(sourceStepId) : authoredStepId(step, index),
        type,
        ...(sourceStepId ? { sourceStepId: String(sourceStepId) } : {}),
        ...(target != null ? { target } : {}),
        ...(expected != null ? { expected } : {}),
        ...(assertionContractTextForExport({ ...raw, ...step, payload })
          ? { description: assertionContractTextForExport({ ...raw, ...step, payload }) }
          : {}),
        payload,
      },
    ];
  });
}

function isExplicitAuthoredAssertionStep(step) {
  if (!step || typeof step !== 'object') return false;
  const kind = String(
    step.action || step.operation || step.op || step.kind || step.nodeType || step.type || '',
  ).trim().toLowerCase().replace(/[^a-z]+/g, '');
  return ['verify', 'validate', 'assert', 'assertion', 'expect'].includes(kind);
}

function declaredAssertionsForExport(result) {
  const decoded = decodeJson(result?.declaredAssertionsRaw, []);
  const stored = Array.isArray(decoded) ? decoded : [];
  const explicitAssertions = (Array.isArray(result?.declaredSteps) ? result.declaredSteps : [])
    .filter(isExplicitAuthoredAssertionStep);
  const explicitIds = new Set(
    explicitAssertions
      .map((step) => step && (step.id || step.contractStepId || step.stepId))
      .filter(meaningfulAssertionExportValue)
      .map(String),
  );
  const executionAssertions = executionContractAssertionsForExport(result);
  const admissibleExecutionAssertions = explicitAssertions.length
    ? executionAssertions.filter((assertion) => {
        const id = assertion && (assertion.id || assertion.contractStepId || assertion.assertionId);
        const sourceStepId = assertion && (
          assertion.sourceStepId || assertion.sourceContractStepId || assertion.authoredStepId
        );
        return (id && explicitIds.has(String(id))) ||
          (sourceStepId && explicitIds.has(String(sourceStepId)));
      })
    : executionAssertions;
  return mergeUsableAssertionsForExport([
    ...stored,
    ...admissibleExecutionAssertions,
  ]);
}

function replayStepIdentity(step = {}) {
  return step.contractStepId || step.contractRef || step.targetRef || step.stepId || null;
}

function replayStepOccurrenceIdentity(step = {}) {
  const actionIdentity = step.actionIdentity && typeof step.actionIdentity === 'object'
    ? step.actionIdentity
    : {};
  const dispatchIdentity = step.actionDispatchIdentity && typeof step.actionDispatchIdentity === 'object'
    ? step.actionDispatchIdentity
    : {};
  return (
    step.actionOccurrenceId ||
    actionIdentity.actionOccurrenceId ||
    dispatchIdentity.actionOccurrenceId ||
    step.occurrenceKey ||
    actionIdentity.occurrenceKey ||
    dispatchIdentity.occurrenceKey ||
    null
  );
}

function replayUnitOccurrenceIdentity(unit) {
  const primaryOccurrence = replayStepOccurrenceIdentity(unit?.primary || {});
  if (primaryOccurrence) return String(primaryOccurrence);
  return String(
    (unit?.steps || [])
      .map((step) => replayStepOccurrenceIdentity(step))
      .find(Boolean) ||
      '',
  );
}

function replayAssertionIdentity(step = {}) {
  return (
    step.assertionId ||
    step.contractRef ||
    step.id ||
    replayStepIdentity(step) ||
    step.assertionEvidenceId ||
    null
  );
}

function replayStepReferences(step = {}) {
  return [step.target, step.destinationTarget, step.condition?.target, step.sourceTarget]
    .filter((value) => value != null)
    .map(String);
}

function replayUnits(steps = []) {
  const indexed = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step && typeof step === 'object');
  const resolves = new Map(
    indexed
      .filter(({ step }) => step.op === 'resolve' && step.as != null)
      .map((entry) => [String(entry.step.as), entry]),
  );
  const usedResolveIndexes = new Set();
  const units = [];
  for (const entry of indexed) {
    if (entry.step.op === 'resolve') continue;
    const attached = [];
    for (const ref of replayStepReferences(entry.step)) {
      const resolve = resolves.get(ref);
      if (resolve && !usedResolveIndexes.has(resolve.index)) {
        attached.push(resolve);
        usedResolveIndexes.add(resolve.index);
      }
    }
    const sameId = replayStepIdentity(entry.step);
    if (sameId) {
      for (const resolve of resolves.values()) {
        if (
          !usedResolveIndexes.has(resolve.index) &&
          String(replayStepIdentity(resolve.step) || '') === String(sameId)
        ) {
          attached.push(resolve);
          usedResolveIndexes.add(resolve.index);
        }
      }
    }
    const members = [...attached, entry].sort((a, b) => a.index - b.index);
    units.push({
      order: Math.min(...members.map((member) => member.index)),
      primary: entry.step,
      steps: members.map((member) => member.step),
      id: sameId || attached.map((member) => replayStepIdentity(member.step)).find(Boolean) || null,
    });
  }
  for (const resolve of resolves.values()) {
    if (!usedResolveIndexes.has(resolve.index)) {
      units.push({
        order: resolve.index,
        primary: resolve.step,
        steps: [resolve.step],
        id: replayStepIdentity(resolve.step),
      });
    }
  }
  return units.sort((a, b) => a.order - b.order);
}

function normalizedReplayAction(value) {
  const action = String(value || '')
    .replace(/[^a-z0-9]+/gi, '')
    .toLowerCase();
  if (['type', 'enter', 'input'].includes(action)) return 'fill';
  if (['wait', 'waitforstate'].includes(action)) return 'waitfor';
  return action;
}

function replayUnitAction(unit) {
  const step = unit?.primary || {};
  if (step.op === 'act') return normalizedReplayAction(step.action);
  if (step.op === 'waitFor') return 'waitfor';
  if (step.op === 'assert') return 'assert';
  return normalizedReplayAction(step.op);
}

function replayUnitLabel(unit) {
  const primary = unit?.primary || {};
  if (primary.action === 'navigate') return String(primary.url || '');
  const resolve = (unit?.steps || []).find((step) => step && step.op === 'resolve');
  const candidate = Array.isArray(resolve?.candidates) ? resolve.candidates.find(Boolean) : null;
  return String(
    primary.targetLabel ||
      primary.elementLabel ||
      primary.narration ||
      primary.name ||
      resolve?.elementLabel ||
      resolve?.narration ||
      resolve?.name ||
      candidate?.name ||
      candidate?.text ||
      candidate?.selector ||
      primary.expected ||
      primary.url ||
      '',
  );
}

function semanticWords(value) {
  return new Set(
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter(
        (word) =>
          word.length > 1 &&
          !['the', 'a', 'an', 'on', 'in', 'to', 'button', 'field', 'element'].includes(word),
      ),
  );
}

function replayLabelsLikelySame(left, right) {
  const a = String(left || '')
    .trim()
    .toLowerCase();
  const b = String(right || '')
    .trim()
    .toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  const aw = semanticWords(a);
  const bw = semanticWords(b);
  if (!aw.size || !bw.size) return false;
  const intersection = [...aw].filter((word) => bw.has(word)).length;
  const smaller = Math.min(aw.size, bw.size);
  const union = new Set([...aw, ...bw]).size;
  // One shared word (for example "Microsoft" or "user") is not an identity.
  // A semantic fallback is allowed only when the complete smaller phrase is
  // contained by the larger phrase and the two descriptions remain strongly
  // similar. Ambiguous repeated controls are intentionally left unmatched so
  // the authored ordinal/identity reconstruction can preserve both actions.
  return (
    intersection === smaller && (smaller >= 2 || aw.size === bw.size) && intersection / union >= 0.6
  );
}

function uniqueSemanticReplayMatch(units, used, descriptor) {
  const matches = units
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit, index }) => !used.has(index) && replayUnitMatchesDescriptor(unit, descriptor));
  return matches.length === 1 ? matches : [];
}

function authoredDescriptor(step, index) {
  const action = normalizedReplayAction(authoredActionForExport(step));
  const raw = step && typeof step.raw === 'object' ? step.raw : {};
  return {
    id: authoredStepId(step, index),
    action,
    label:
      action === 'navigate'
        ? String(step.url || step.targetUrl || raw.url || raw.targetUrl || '')
        : String(
            step.target ||
              step.element ||
              step.field ||
              step.label ||
              step.plannedText ||
              step.description ||
              raw.target ||
              raw.element ||
              '',
          ),
  };
}

function replayUnitMatchesDescriptor(unit, descriptor) {
  if (!unit || !descriptor) return false;
  if (unit.id && String(unit.id) === String(descriptor.id)) return true;
  if (!descriptor.action || replayUnitAction(unit) !== descriptor.action) return false;
  return replayLabelsLikelySame(replayUnitLabel(unit), descriptor.label);
}

function replayUnitPrimaryKey(unit) {
  const primary = unit?.primary || {};
  const identity = unit?.id || '';
  const occurrenceIdentity = replayUnitOccurrenceIdentity(unit);
  if (occurrenceIdentity) {
    return `occurrence:${occurrenceIdentity}:${primary.op || ''}:${normalizedReplayAction(
      primary.action || primary.op,
    )}`;
  }
  if (primary.op === 'assert')
    return `assert:${replayAssertionIdentity(primary) || identity}`;
  return `${primary.op || ''}:${normalizedReplayAction(primary.action || primary.op)}:${identity}:${String(primary.url || replayUnitLabel(unit) || '')}`;
}

function withAuthoredIdentity(unit, descriptor) {
  if (!unit || !descriptor?.id) return unit;
  return {
    ...unit,
    id: descriptor.id,
    steps: unit.steps.map((step) => {
      if (!step || step.op === 'assert') return step;
      const prior = replayStepIdentity(step);
      return {
        ...step,
        ...(prior && String(prior) !== String(descriptor.id)
          ? { sourceContractStepId: step.sourceContractStepId || prior }
          : {}),
        contractStepId: descriptor.id,
        targetRef: descriptor.id,
      };
    }),
  };
}

function mergePartialReplaySteps(existingSteps, reconstructedSteps, authoredSteps) {
  const existingUnits = replayUnits(existingSteps);
  const reconstructedUnits = replayUnits(reconstructedSteps);
  const existingUsed = new Set();
  const reconstructedUsed = new Set();
  const selectedUnits = [];

  const addUnits = (units) => {
    for (const unit of units) {
      const key = replayUnitPrimaryKey(unit);
      if (!selectedUnits.some((selected) => replayUnitPrimaryKey(selected) === key))
        selectedUnits.push(unit);
    }
  };

  authoredSteps
    .map(authoredDescriptor)
    .filter((descriptor) => descriptor.action)
    .forEach((descriptor) => {
      const exactExisting = existingUnits
        .map((unit, index) => ({ unit, index }))
        .filter(
          ({ unit, index }) =>
            !existingUsed.has(index) && unit.id && String(unit.id) === descriptor.id,
        );
      const chosenExisting = exactExisting;
      for (const entry of chosenExisting) existingUsed.add(entry.index);

      const exactReconstructed = reconstructedUnits
        .map((unit, index) => ({ unit, index }))
        .filter(
          ({ unit, index }) =>
            !reconstructedUsed.has(index) && unit.id && String(unit.id) === descriptor.id,
        );
      const chosenReconstructed = exactReconstructed;

      if (chosenExisting.length) {
        addUnits(chosenExisting.map(({ unit }) => withAuthoredIdentity(unit, descriptor)));
        const existingKinds = new Set(chosenExisting.map(({ unit }) => replayUnitAction(unit)));
        const companions = chosenReconstructed.filter(
          ({ unit }) => !existingKinds.has(replayUnitAction(unit)),
        );
        for (const entry of chosenReconstructed) reconstructedUsed.add(entry.index);
        addUnits(companions.map(({ unit }) => withAuthoredIdentity(unit, descriptor)));
      } else {
        for (const entry of chosenReconstructed) reconstructedUsed.add(entry.index);
        addUnits(chosenReconstructed.map(({ unit }) => withAuthoredIdentity(unit, descriptor)));
      }
    });

  addUnits(existingUnits.filter((_, index) => !existingUsed.has(index)));
  for (const [index, unit] of reconstructedUnits.entries()) {
    if (reconstructedUsed.has(index)) continue;
    const reconstructedOccurrence = replayUnitOccurrenceIdentity(unit);
    const conflictingExecutedOccurrence = selectedUnits.some((selected) => {
      if (!unit.id || !selected.id || String(unit.id) !== String(selected.id)) return false;
      if (replayUnitAction(unit) !== replayUnitAction(selected)) return false;
      const selectedOccurrence = replayUnitOccurrenceIdentity(selected);
      return Boolean(
        selectedOccurrence &&
        reconstructedOccurrence &&
        selectedOccurrence !== reconstructedOccurrence,
      );
    });
    if (conflictingExecutedOccurrence) continue;
    const duplicate = selectedUnits.some(
      (selected) => replayUnitPrimaryKey(selected) === replayUnitPrimaryKey(unit),
    );
    if (!duplicate) selectedUnits.push(unit);
  }

  const emitted = [];
  const emittedKeys = new Set();
  for (const unit of selectedUnits) {
    for (const step of unit.steps) {
      const identity = replayStepIdentity(step) || '';
      const occurrenceIdentity = replayStepOccurrenceIdentity(step) || '';
      const key =
        step.op === 'resolve'
          ? `resolve:${occurrenceIdentity}:${step.as || ''}:${identity}:${step.locatorProvenance?.chosenExpression || step.actionLocator?.expression || ''}`
          : step.op === 'assert'
            ? `assert:${replayAssertionIdentity(step) || identity}`
          : `${step.op || ''}:${step.action || ''}:${occurrenceIdentity}:${identity}:${step.target || ''}:${step.url || ''}:${step.contractRef || ''}`;
      if (!emittedKeys.has(key)) {
        emitted.push(step);
        emittedKeys.add(key);
      }
    }
  }
  return emitted;
}

function executedReplayStepsOnly(steps) {
  const input = Array.isArray(steps) ? steps : [];
  const executable = input.filter(replayStepHasPositiveExecutionProvenance);
  const referenced = new Set();
  for (const step of executable) {
    if (step.op === 'act') {
      if (step.target != null) referenced.add(String(step.target));
      if (step.destinationTarget != null) referenced.add(String(step.destinationTarget));
    } else if (step.op === 'waitFor' && step.condition?.target != null) {
      referenced.add(String(step.condition.target));
    } else if (step.op === 'assert' && step.target != null) {
      referenced.add(String(step.target));
    }
  }
  return input.filter((step) => {
    if (!step) return false;
    if (step.op === 'resolve') return step.as != null && referenced.has(String(step.as));
    if (['act', 'waitFor', 'assert'].includes(step.op))
      return replayStepHasPositiveExecutionProvenance(step);
    return false;
  });
}

function prepareResultForExport(result, credentialValues = null) {
  if (!result || typeof result !== 'object') return result;
  if (
    !result.liveScriptLedger ||
    typeof result.liveScriptLedger !== 'object' ||
    result.liveScriptLedger.derivedForExport === true
  ) {
    const sourceResult = result.liveScriptLedger?.derivedForExport === true
      ? { ...result, liveScriptLedger: null }
      : result;
    result.liveScriptLedger = liveScriptRecorder.buildLedgerFromResult(sourceResult);
    Object.defineProperty(result.liveScriptLedger, 'derivedForExport', {
      value: true,
      configurable: true,
      writable: true,
      enumerable: false,
    });
  }
  hydrateReplayIrFromCaptureEvidence(result);
  const currentSteps = result.envelope && result.envelope.ir && result.envelope.ir.steps;
  const hasCurrentSteps = Array.isArray(currentSteps) && currentSteps.length > 0;
  const executedCurrentStream = executedReplayStepsOnly(hasCurrentSteps ? currentSteps : []);
  const successfulPersistedActions = (
    Array.isArray(result.captureFirstEvidence?.actionEvidences)
      ? result.captureFirstEvidence.actionEvidences
      : []
  ).filter((row) => evidenceScopeMatches(row, result) && successfulActionEvidence(row));
  const matchedPersistedActs = (hasCurrentSteps ? currentSteps : []).filter(
    (step) =>
      step &&
      step.op === 'act' &&
      successfulPersistedActions.some((row) => exactActionEvidenceMatch(step, row)),
  );
  const matchedPersistedTargets = new Set(
    matchedPersistedActs
      .map((step) => (step.target == null ? null : String(step.target)))
      .filter(Boolean),
  );
  const persistedOccurrenceStream = (hasCurrentSteps ? currentSteps : []).filter(
    (step) =>
      matchedPersistedActs.includes(step) ||
      (step && step.op === 'resolve' && matchedPersistedTargets.has(String(step.as || ''))),
  );
  const currentEvidenceStream = [...executedCurrentStream, ...persistedOccurrenceStream].filter(
    (step, index, all) => all.indexOf(step) === index,
  );
  const executableCurrentSteps = executedCurrentStream.filter((step) =>
    replayStepHasPositiveExecutionProvenance(step),
  );
  const hasExecutableCurrentSteps = executableCurrentSteps.length > 0;
  const plannedSteps = authoredStepsForExport(result);
  const declaredAssertions = declaredAssertionsForExport(result);
  // From this boundary onward, code generation must use the immutable execution
  // contract identity. Preserve the persisted UI step id as sourceStepId, but do
  // not let parallel case_step_* and hashed identities describe one occurrence.
  result.declaredSteps = plannedSteps;
  // Standard-profile reconciliation consumes this normalized list after ReplayIR recovery.
  // Keep the raw persisted field untouched for auditability, but never let an unusable raw
  // placeholder hide richer execution-contract assertions from downstream code generation.
  result.declaredAssertions = declaredAssertions;
  const currentActionKeys = new Set(
    executableCurrentSteps
      .filter((step) => step && step.op === 'act')
      .map(
        (step) =>
          `${String(replayStepIdentity(step) || '')}:${normalizedReplayAction(step.action)}`,
      ),
  );
  const currentAssertionRefs = new Set(
    executableCurrentSteps
      .filter((step) => step && step.op === 'assert')
      .map((step) => String(step.contractRef || step.assertionId || replayStepIdentity(step) || ''))
      .filter(Boolean),
  );
  const missingAuthoredAction = plannedSteps
    .map(authoredDescriptor)
    .filter((descriptor) => descriptor.action)
    .some((descriptor) => !currentActionKeys.has(`${descriptor.id}:${descriptor.action}`));
  const missingAuthoredAssertion = (
    Array.isArray(declaredAssertions) ? declaredAssertions : []
  ).some(
    (assertion) => assertion && assertion.id && !currentAssertionRefs.has(String(assertion.id)),
  );
  const executedTrail = mergeExecutedEvidenceTrails(
    trailFromLiveLedger(result),
    trailFromCaptureFirstEvidence(result),
  );
  const ledgerAssertions = assertionsFromLiveLedger(result);
  // Authored/planned steps describe intent, but they are not execution evidence.
  // Only reconstruct an empty ReplayIR from immutable live execution records. A
  // partial executed prefix must remain partial; otherwise unexecuted narration
  // is silently converted into actions, waits, assertions, and guessed locators.
  const hasExecutedLedgerEvidence = executedTrail.length > 0 || ledgerAssertions.length > 0;
  const requiresExecutedEvidenceReconstruction = hasExecutedLedgerEvidence;
  const previousEnvelope =
    result.envelope && typeof result.envelope === 'object' ? result.envelope : {};
  const authoredParity = {
    executionAuthority: 'executed_occurrences_only',
    plannedActionMissingFromExecution: missingAuthoredAction,
    plannedAssertionMissingFromExecution: missingAuthoredAssertion,
    plannedStepCount: plannedSteps.length,
    executedReplayStepCount: executableCurrentSteps.length,
    liveTrailEntryCount: executedTrail.length,
    liveAssertionEntryCount: ledgerAssertions.length,
  };
  if (requiresExecutedEvidenceReconstruction) {
    const emitted = replayEmitter.buildReplayIR({
      caseId: result.testCaseId || result.runResultId || 'generated-case',
      title: result.caseName || result.testCaseName || 'Generated test case',
      trail: executedTrail,
      plannedSteps: [],
      declaredSteps: [],
      caseContractV1: { steps: [] },
      declaredAssertions: ledgerAssertions,
      assertionOutcomes: [
        ...ledgerAssertions.map((assertion) => ({
          assertionId: assertion.assertionId || assertion.id,
          outcome: assertion.outcome,
          matched: assertion.matched,
          checked: assertion.checked,
          actual: assertion.actual,
          evidence: assertion.evidence,
        })),
        ...Object.entries(result.liveOutcomes || {}).map(([id, value]) => ({
          id,
          assertionId: value?.assertionId || id,
          ...(value || {}),
        })),
      ],
      verdictStatus: result.status || 'fail',
      authProfile: result.authProfile || null,
      credentialValues,
    });
    const previousIr =
      previousEnvelope.ir && typeof previousEnvelope.ir === 'object' ? previousEnvelope.ir : {};
    const existingFindings = Array.isArray(previousEnvelope.findings)
      ? previousEnvelope.findings
      : [];
    const emittedFindings = Array.isArray(emitted.findings) ? emitted.findings : [];
    const existingGaps = Array.isArray(previousEnvelope.gaps) ? previousEnvelope.gaps : [];
    const emittedGaps = Array.isArray(emitted.gaps) ? emitted.gaps : [];
    const mergedGaps = [...existingGaps, ...emittedGaps].filter((gap, index, values) => {
      const key = JSON.stringify([gap && gap.code, gap && gap.where, gap && gap.detail]);
      return (
        values.findIndex(
          (candidate) =>
            JSON.stringify([
              candidate && candidate.code,
              candidate && candidate.where,
              candidate && candidate.detail,
            ]) === key,
        ) === index
      );
    });
    // `executedTrail` is produced exclusively from canonical live-ledger lines.
    // replayEmitter preserves their runtime origin and immutable identity, but
    // its ReplayIR shape does not carry the line's `ok: true` outcome. Restore
    // that explicit positive outcome at this trusted reconstruction boundary;
    // failed/diagnostic actions never enter `executedTrail`.
    const reconstructedSteps = (emitted.ir?.steps || []).map((step) => {
      if (!step || !['act', 'waitFor'].includes(step.op)) return step;
      return {
        ...step,
        success: true,
        executionStatus: 'passed',
      };
    });
    const projectedExecutedOccurrences = new Set(
      reconstructedSteps
        .filter((step) => step && step.op === 'act')
        .map((step) => {
          const identity = evidenceIdentity(step);
          const occurrence = identity.actionOccurrenceId || identity.occurrenceKey;
          const operation = normalizedReplayAction(step.action || step.operation);
          return occurrence && operation ? `${occurrence}\u0000${operation}` : null;
        })
        .filter(Boolean),
    );
    // An executed ledger line can lose its exact-node locator upstream while
    // still retaining immutable occurrence identity. Preserve that performed
    // action as a diagnostic boundary; never promote its expression to a
    // verified locator or runnable POM method.
    for (const entry of executedTrail) {
      const identity = evidenceIdentity(entry);
      const occurrence = identity.actionOccurrenceId || identity.occurrenceKey;
      const actionSource = entry.action
        || entry.operation
        || String(entry.tool || '').replace(/^browser[_-]?/i, '');
      const action = normalizedReplayAction(actionSource);
      if (!occurrence || !action) continue;
      const key = `${occurrence}\u0000${action}`;
      if (projectedExecutedOccurrences.has(key)) continue;
      reconstructedSteps.push({
        op: 'act',
        action,
        target: entry.args?.element || entry.args?.target || null,
        contractStepId: identity.contractStepId || null,
        actionOccurrenceId: identity.actionOccurrenceId || null,
        occurrenceKey: identity.occurrenceKey || null,
        occurrenceOrdinal: entry.occurrenceOrdinal || entry.actionIdentity?.occurrenceOrdinal || null,
        actionIdentity: entry.actionIdentity || null,
        authored: !!identity.contractStepId,
        evidenceOnly: !identity.contractStepId,
        diagnosticOnly: true,
        executable: false,
        success: true,
        executionStatus: 'passed',
        canonicalExecution: true,
        origin: 'executed_evidence_without_exact_locator',
        evidenceIntegrityStatus: 'exact_action_locator_missing',
      });
      projectedExecutedOccurrences.add(key);
    }
    const mergedExecutedSteps = mergePartialReplaySteps(
      currentEvidenceStream,
      reconstructedSteps,
      plannedSteps,
    );
    const reconstructedActionKeys = new Set(
      mergedExecutedSteps
        .filter((step) => step && step.op === 'act')
        .map((step) => `${String(replayStepIdentity(step) || '')}:${normalizedReplayAction(step.action)}`),
    );
    const reconstructedAssertionRefs = new Set(
      mergedExecutedSteps
        .filter((step) => step && step.op === 'assert')
        .map((step) => String(step.contractRef || step.assertionId || replayStepIdentity(step) || ''))
        .filter(Boolean),
    );
    const reconstructedMissingAuthoredAction = plannedSteps
      .map(authoredDescriptor)
      .filter((descriptor) => descriptor.action)
      .some((descriptor) => !reconstructedActionKeys.has(`${descriptor.id}:${descriptor.action}`));
    const reconstructedMissingAuthoredAssertion = declaredAssertions.some(
      (assertion) =>
        assertion &&
        assertion.id &&
        !reconstructedAssertionRefs.has(String(assertion.id)),
    );
    const reconstructedParity = {
      ...authoredParity,
      plannedActionMissingFromExecution: reconstructedMissingAuthoredAction,
      plannedAssertionMissingFromExecution: reconstructedMissingAuthoredAssertion,
      executedReplayStepCount: mergedExecutedSteps.filter(
        (step) => step && ['act', 'waitFor', 'assert'].includes(step.op),
      ).length,
    };
    result.envelope = {
      ...previousEnvelope,
      emitterVersion: previousEnvelope.emitterVersion || replayEmitter.EMITTER_VERSION,
      ir: { ...(emitted.ir || {}), ...previousIr, steps: mergedExecutedSteps },
      complete:
        previousEnvelope.complete === true &&
        emitted.complete === true &&
        !reconstructedMissingAuthoredAction &&
        !reconstructedMissingAuthoredAssertion,
      gaps: mergedGaps,
      findings: [...existingFindings, ...emittedFindings],
      reconstructedForExport: true,
      reconstructedFromExecutedEvidence: true,
      completedPartialReplayIr: false,
      reconstructedMissingAuthoredActions: reconstructedMissingAuthoredAction,
      reconstructedMissingAuthoredAssertions: reconstructedMissingAuthoredAssertion,
      authoredParity: reconstructedParity,
    };
  } else {
    result.envelope = {
      ...previousEnvelope,
      ir: {
        ...((previousEnvelope.ir && typeof previousEnvelope.ir === 'object')
          ? previousEnvelope.ir
          : {}),
        steps: executedCurrentStream,
      },
      complete:
        previousEnvelope.complete === true &&
        !missingAuthoredAction &&
        !missingAuthoredAssertion,
      reconstructedForExport: previousEnvelope.reconstructedForExport === true,
      reconstructedFromExecutedEvidence:
        previousEnvelope.reconstructedFromExecutedEvidence === true,
      completedPartialReplayIr: false,
      reconstructedMissingAuthoredActions: missingAuthoredAction,
      reconstructedMissingAuthoredAssertions: missingAuthoredAssertion,
      authoredParity,
    };
  }
  const hydrated = hydrateReplayIrFromCaptureEvidence(result);
  refreshPreparedOccurrenceParity(hydrated);
  return completeReplayIrLocators(hydrated);
}

function dependencyValues(value) {
  if (Array.isArray(value)) {
    return [
      ...new Set(
        value
          .filter((entry) => typeof entry === 'string' && entry.trim())
          .map((entry) => entry.trim()),
      ),
    ];
  }
  return parseArrayJson(value);
}

function semanticCaseName(result) {
  return (
    String(
      (result && (result.caseName || result.testCaseName || result.name)) ||
        (result && result.envelope && result.envelope.ir && result.envelope.ir.title) ||
        'Test case',
    ).trim() || 'Test case'
  );
}

function semanticJourneyName(items) {
  const scenarioNames = [];
  const caseNames = [];
  for (const item of items) {
    const result = (item && item.r) || {};
    const scenarioName = String(
      result.scenarioName || (result.scenario && result.scenario.name) || '',
    ).trim();
    const caseName = semanticCaseName(result);
    if (scenarioName && !scenarioNames.includes(scenarioName)) scenarioNames.push(scenarioName);
    if (caseName && !caseNames.includes(caseName)) caseNames.push(caseName);
  }
  const names = scenarioNames.length ? scenarioNames : caseNames;
  return names.join(' -> ') || 'Test journey';
}

/**
 * IDs are authoritative dependency references. Exact human case names are a compatibility
 * fallback for persisted results that pre-date dependsOnIds in the export model.
 */
function buildResultDependencyGraph(validatedItems) {
  const items = Array.isArray(validatedItems) ? validatedItems : [];
  const originalIndex = new Map(items.map((item, index) => [item, index]));
  const parents = new Map(items.map((item) => [item, new Set()]));
  const children = new Map(items.map((item) => [item, new Set()]));
  const byId = new Map();
  const byExactName = new Map();

  const appendIndex = (map, key, item) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  };
  for (const item of items) {
    appendIndex(byId, String((item.r && item.r.testCaseId) || '').trim(), item);
    appendIndex(byExactName, semanticCaseName(item.r), item);
  }

  const addEdge = (parent, child) => {
    if (!parent || !child || parent === child) return;
    parents.get(child).add(parent);
    children.get(parent).add(child);
  };
  for (const child of items) {
    const result = child.r || {};
    const resolved = new Set();
    for (const dependencyId of dependencyValues(result.dependsOnIds)) {
      for (const parent of byId.get(dependencyId) || []) resolved.add(parent);
    }
    for (const dependencyName of dependencyValues(result.dependsOnNames)) {
      for (const parent of byExactName.get(dependencyName) || []) resolved.add(parent);
    }
    for (const parent of resolved) addEdge(parent, child);
  }

  // Preserve existing same-scenario journeys, then merge those journeys when an explicit
  // dependency crosses scenario boundaries. Only dependency edges influence execution order.
  const unionParent = items.map((_, index) => index);
  const find = (index) => {
    let current = index;
    while (unionParent[current] !== current) {
      unionParent[current] = unionParent[unionParent[current]];
      current = unionParent[current];
    }
    return current;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) unionParent[rightRoot] = leftRoot;
  };
  const firstByScenario = new Map();
  for (const item of items) {
    const index = originalIndex.get(item);
    const scenarioId = String((item.r && item.r.scenarioId) || '').trim();
    if (scenarioId) {
      if (firstByScenario.has(scenarioId)) union(firstByScenario.get(scenarioId), index);
      else firstByScenario.set(scenarioId, index);
    }
    for (const parent of parents.get(item)) union(originalIndex.get(parent), index);
  }

  const componentMap = new Map();
  for (const item of items) {
    const root = find(originalIndex.get(item));
    if (!componentMap.has(root)) componentMap.set(root, []);
    componentMap.get(root).push(item);
  }

  const findings = [];
  const components = [...componentMap.values()]
    .sort((left, right) => originalIndex.get(left[0]) - originalIndex.get(right[0]))
    .map((component) => {
      const memberSet = new Set(component);
      const indegree = new Map(
        component.map((item) => [
          item,
          [...parents.get(item)].filter((parent) => memberSet.has(parent)).length,
        ]),
      );
      const ready = component
        .filter((item) => indegree.get(item) === 0)
        .sort((left, right) => originalIndex.get(left) - originalIndex.get(right));
      const ordered = [];
      while (ready.length) {
        const item = ready.shift();
        ordered.push(item);
        for (const child of [...children.get(item)].sort(
          (left, right) => originalIndex.get(left) - originalIndex.get(right),
        )) {
          if (!memberSet.has(child)) continue;
          indegree.set(child, indegree.get(child) - 1);
          if (indegree.get(child) === 0) {
            ready.push(child);
            ready.sort((left, right) => originalIndex.get(left) - originalIndex.get(right));
          }
        }
      }
      if (ordered.length !== component.length) {
        const remaining = component
          .filter((item) => !ordered.includes(item))
          .sort((left, right) => originalIndex.get(left) - originalIndex.get(right));
        ordered.push(...remaining);
        findings.push({
          rule: 'dependency_cycle_diagnostic',
          severity: 'warning',
          nonBlocking: true,
          message: `Dependency cycle detected in '${semanticJourneyName(component)}'; preserved authored case order without disabling output.`,
        });
      }
      return ordered;
    });

  return {
    parents,
    children,
    components,
    findings,
    hasDependents: (item) => !!(children.get(item) && children.get(item).size),
    dependencyNames: (item) =>
      [...(parents.get(item) || [])].map((parent) => semanticCaseName(parent.r)),
  };
}

function isContinuationSession(result) {
  const mode = String((result && result.sessionMode) || '')
    .trim()
    .toLowerCase();
  return mode === 'continue_from_dependency' || mode === 'continue-from-dependency';
}

function executedAstStepId(node) {
  return String(
    (node && (node.stepId || node.contractStepId || node.authoredActionId)) || '',
  ).trim();
}

function executedAstOutcome(node) {
  return String(
    (node && node.journal && node.journal.actionOutcome) ||
      (node && node.executionOutcome) ||
      '',
  )
    .trim()
    .toLowerCase();
}

function normalizedAssertionTarget(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(?:the|selected|visible|exactly|field|control|button|dropdown|section|page|heading|calendar)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function visibleAssertionText(node, targetLabel) {
  const planned = String((node && node.plannedText) || '').trim();
  const quoted = planned.match(/(?:visible\s+)?text\s+["']([^"']+)["']/i);
  if (quoted) return quoted[1].trim();
  const direct = planned.match(/^\s*(?:the\s+)?(.+?)\s+(?:heading|section)\s+is\s+(?:displayed|visible(?:\s+and\s+enabled)?)\.?\s*$/i);
  if (direct) return direct[1].trim();
  const target = String(targetLabel || '').trim();
  return /^(?:visible text|text)\s+/i.test(target)
    ? target.replace(/^(?:visible text|text)\s+/i, '').replace(/^["']|["']$/g, '').trim()
    : null;
}

function exactBoundAssertionRole(action, expectedState, dataRows) {
  const binding = action && action.dataBinding;
  if (!binding || binding.isDataBound !== true || !binding.sourceColumn) return null;
  const sourceColumn = String(binding.sourceColumn).trim();
  if (!sourceColumn) return null;
  const matchesOwnRow = (Array.isArray(dataRows) ? dataRows : []).some((row) => {
    const fields = row && row.fields && typeof row.fields === 'object' ? row.fields : null;
    if (!fields || !Object.prototype.hasOwnProperty.call(fields, sourceColumn)) return false;
    const boundValue = fields[sourceColumn];
    if (boundValue == null || typeof boundValue === 'object') return false;
    return String(boundValue) === String(expectedState);
  });
  return matchesOwnRow ? (action.dataRole || action.dataExpected || sourceColumn) : null;
}

function evaluatedAssertionStepFromAst(node, { resolveEntries, actionByTarget, dataRows }) {
  const journal = (node && node.journal) || {};
  const assertion = (node && node.assertion) || {};
  const assertionOutcome = String(journal.assertionOutcome || assertion.outcome || '').toLowerCase();
  if (!['matched', 'not_matched', 'failed'].includes(assertionOutcome)) return null;
  const attempts = Array.isArray(journal.attempts) ? journal.attempts : [];
  const attempt = attempts.find((item) => item && item.waitContract) || attempts[0] || {};
  const waitContract = attempt.waitContract || {};
  const assertionAction = String(waitContract.action || '').toLowerCase();
  const targetLabel = String(attempt.target || '').trim();
  const targetKey = normalizedAssertionTarget(targetLabel);
  const matchingResolves = resolveEntries.filter((entry) => {
    if (!targetKey || !entry.key) return false;
    return entry.key === targetKey;
  });
  const targetRef = matchingResolves.length === 1 ? matchingResolves[0].step.as : null;
  const expectedState = journal.expectedState;
  const observedState = journal.observedState ?? assertion.observed;
  const sensitive = waitContract.sensitive === true || expectedState === '[REDACTED]' || observedState === '[REDACTED]';
  const base = {
    op: 'assert',
    contractStepId: executedAstStepId(node) || null,
    contractRef: executedAstStepId(node) || null,
    target: targetRef,
    targetLabel: targetLabel || null,
    liveOutcome: assertionOutcome,
    executionStatus: 'evaluated',
    authored: true,
    executed: true,
    executionOutcome: 'succeeded',
    liveDomGrounded: true,
    comparator: assertion.comparator || 'equals',
    continuationPolicy: assertion.continuationPolicy || 'continue',
    origin: 'executed_case_ast_assertion',
  };

  if (assertionAction === 'assertvisible') {
    if (targetRef) return { ...base, channel: 'VISIBLE', expected: true };
    const text = visibleAssertionText(node, targetLabel);
    return text ? { ...base, target: null, channel: 'UI_TEXT', expected: text } : null;
  }

  if (assertionAction === 'asserttext') {
    if (targetRef) {
      const action = actionByTarget.get(targetRef) || null;
      const valueAction = action && ['fill', 'type', 'selectOption'].includes(String(action.action || ''));
      const mayReuseActionValue =
        valueAction &&
        action.valueRef &&
        (/\bcontains\s+exactly\b/i.test(String(node.plannedText || '')) || sensitive);
      if (mayReuseActionValue) {
        return {
          ...base,
          channel: 'VALUE',
          expectedRef: action.valueRef,
          dataBinding: action.dataBinding || null,
          dataRole: action.dataRole || action.dataExpected || null,
          sensitive,
        };
      }
      if (valueAction && expectedState != null && expectedState !== '[REDACTED]' && typeof expectedState !== 'object') {
        const boundRole = exactBoundAssertionRole(action, expectedState, dataRows);
        return {
          ...base,
          channel: 'VALUE',
          expected: expectedState,
          ...(boundRole
            ? {
                dataBinding: action.dataBinding,
                dataRole: boundRole,
                dataExpected: boundRole,
              }
            : {}),
        };
      }
      return null;
    }
    if (expectedState != null && expectedState !== '[REDACTED]' && typeof expectedState !== 'object') {
      return { ...base, target: null, channel: 'UI_TEXT', expected: expectedState };
    }
  }
  return null;
}

function projectPlaywrightPomResultThroughExecutedAst(result) {
  const ast = result && result.executedCaseAst;
  const envelope = result && result.envelope;
  const originalIr = envelope && envelope.ir;
  // AST validation is aggregate: one unsupported authored assertion/action can
  // invalidate the document while other nodes still carry exact journal
  // outcomes. Consume only those safe nodes instead of bypassing the entire
  // runtime projection because an unrelated node is diagnostic-only.
  if (!ast || !Array.isArray(ast.nodes) || !originalIr) return result;

  const originalSteps = Array.isArray(originalIr.steps) ? originalIr.steps : [];
  const nodes = (Array.isArray(ast.nodes) ? ast.nodes : [])
    .filter(Boolean)
    .slice()
    .sort((left, right) => Number(left.ordinal || 0) - Number(right.ordinal || 0));
  const failedOutcomes = new Set(['failed', 'interrupted', 'cancelled', 'canceled', 'blocked']);
  const failureNode = nodes.find((node) => failedOutcomes.has(executedAstOutcome(node))) || null;
  const failureOrdinal = failureNode ? Number(failureNode.ordinal || Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
  const sourceStepsById = new Map();
  for (const step of originalSteps) {
    const id = String((step && (step.contractStepId || step.id)) || '').trim();
    if (!id) continue;
    if (!sourceStepsById.has(id)) sourceStepsById.set(id, []);
    sourceStepsById.get(id).push(step);
  }
  const resolveEntries = originalSteps
    .filter((step) => step && step.op === 'resolve' && step.as)
    .map((step) => ({
      step,
      key: normalizedAssertionTarget(
        step.elementLabel || step.targetLabel || step.label || step.name || step.as,
      ),
    }));
  const actionByTarget = new Map(
    originalSteps
      .filter((step) => step && step.op === 'act' && step.target)
      .map((step) => [step.target, step]),
  );
  const astTargets = ast && ast.symbolTable && ast.symbolTable.targets
    ? ast.symbolTable.targets
    : {};

  const projectedSteps = [];
  const projectedSourceSteps = new Set();
  const projectionGaps = [];
  let succeededNodeCount = 0;
  let executableActionCount = 0;
  let successfulWaitCount = 0;
  let executableAssertionCount = 0;

  for (const node of nodes) {
    const ordinal = Number(node.ordinal || 0);
    if (ordinal >= failureOrdinal || executedAstOutcome(node) !== 'succeeded') continue;
    succeededNodeCount += 1;
    const nodeId = executedAstStepId(node);
    const nodeType = String(node.type || '').trim();
    if (nodeType === 'WaitForState' && node.waitContract) {
      projectedSteps.push({
        op: 'waitFor',
        condition: { ...node.waitContract },
        contractStepId: nodeId || `executed-wait-${ordinal}`,
        actionOccurrenceId: node.actionOccurrenceId || node.occurrenceKey || null,
        occurrenceKey: node.occurrenceKey || node.actionOccurrenceId || null,
        sequenceIndex: ordinal,
        authored: false,
        executed: true,
        executionOutcome: 'succeeded',
        origin: 'executed_case_ast',
      });
      successfulWaitCount += 1;
      continue;
    }

    const isAssertion = /Assertion$/.test(nodeType) || /^Assert/.test(nodeType);
    if (isAssertion) {
      const assertionStep = evaluatedAssertionStepFromAst(node, {
        resolveEntries,
        actionByTarget,
        dataRows: originalIr.dataRows,
      });
      if (assertionStep) {
        projectedSteps.push({ ...assertionStep, sequenceIndex: ordinal });
        executableAssertionCount += 1;
      } else {
        projectionGaps.push({
          code: 'evaluated_assertion_not_projectable',
          where: nodeId || `executed-ast-ordinal-${ordinal}`,
          detail: `The evaluated assertion at ordinal ${ordinal} had no exact Playwright target/value contract. It remains diagnostic and was not converted into guessed code.`,
          nonBlocking: true,
        });
      }
      continue;
    }

    let sourceSteps = nodeId ? sourceStepsById.get(nodeId) || [] : [];
    const hasStableNodeIdentity = !!(
      (node.actionIdentity?.occurrenceIdentitySource !== 'allocator_fallback'
        && (node.actionOccurrenceId || node.occurrenceKey || node.authoredActionId))
      || (nodeId && !/^step-\d+(?:__occurrence_\d+(?:_\d+)?)?$/.test(nodeId))
    );
    if (!sourceSteps.length && !hasStableNodeIdentity && Number.isInteger(node.sourceReplayIndex)) {
      const indexedAction = originalSteps[node.sourceReplayIndex];
      if (indexedAction && indexedAction.op === 'act') {
        let indexedResolve = null;
        if (indexedAction.target) {
          for (let index = node.sourceReplayIndex - 1; index >= 0; index -= 1) {
            const candidate = originalSteps[index];
            if (candidate && candidate.op === 'resolve' && candidate.as === indexedAction.target) {
              indexedResolve = candidate;
              break;
            }
          }
        }
        sourceSteps = indexedResolve ? [indexedResolve, indexedAction] : [indexedAction];
      }
    }
    const target = node.targetId && astTargets[node.targetId];
    if (node.targetId && (!target || target.verified !== true || target.guessed === true)) {
      projectionGaps.push({
        code: 'executed_action_locator_not_exact_node_verified',
        where: nodeId || `executed-ast-ordinal-${ordinal}`,
        detail: `The successful ${nodeType || 'action'} at ordinal ${ordinal} has no exact-node verified action-time locator. It remains diagnostic and was not converted into guessed code.`,
        nonBlocking: true,
      });
      continue;
    }
    let executableSourceSteps = sourceSteps;
    if (nodeType === 'Drag' && node.destinationTargetRef) {
      const destinationTarget = node.destinationTargetId && astTargets[node.destinationTargetId];
      const destinationResolve = originalSteps.find(
        (step) => step && step.op === 'resolve' && String(step.as || '') === String(node.destinationTargetRef),
      );
      if (!destinationTarget
        || destinationTarget.verified !== true
        || destinationTarget.guessed === true
        || !destinationResolve) {
        projectionGaps.push({
          code: 'executed_drag_destination_not_exact_node_verified',
          where: nodeId || `executed-ast-ordinal-${ordinal}`,
          detail: `The successful Drag at ordinal ${ordinal} has no exact-node verified destination locator. It remains diagnostic and was not converted into guessed code.`,
          nonBlocking: true,
        });
        continue;
      }
      const firstActIndex = executableSourceSteps.findIndex((step) => step && step.op === 'act');
      executableSourceSteps = executableSourceSteps.includes(destinationResolve)
        ? executableSourceSteps
        : firstActIndex >= 0
          ? [
              ...executableSourceSteps.slice(0, firstActIndex),
              destinationResolve,
              ...executableSourceSteps.slice(firstActIndex),
            ]
          : [...executableSourceSteps, destinationResolve];
    }
    const actionSteps = executableSourceSteps.filter((step) => step && step.op === 'act');
    if (actionSteps.length) {
      for (const step of executableSourceSteps) {
        if (!step || !['resolve', 'act'].includes(step.op) || projectedSourceSteps.has(step)) continue;
        projectedSourceSteps.add(step);
        projectedSteps.push({
          ...step,
          executed: true,
          executionOutcome: 'succeeded',
          executedAstOrdinal: ordinal,
          origin: step.origin || 'executed_case_ast_projection',
        });
      }
      executableActionCount += actionSteps.length;
      continue;
    }

    if (!isAssertion && nodeType !== 'WaitForState') {
      projectionGaps.push({
        code: 'executed_action_missing_replayir_evidence',
        where: nodeId || `executed-ast-ordinal-${ordinal}`,
        detail: `The browser recorded a successful ${nodeType || 'action'} at ordinal ${ordinal}, but no verified ReplayIR action was available. It remains diagnostic and was not replaced by guessed code.`,
        nonBlocking: true,
      });
    }
  }

  const retainedNonActionSteps = originalSteps.filter(
    (step) => step && !['resolve', 'act', 'waitFor'].includes(step.op),
  );
  if (failureNode) {
    projectionGaps.push({
      code: 'executed_action_failure_boundary',
      where: executedAstStepId(failureNode) || `executed-ast-ordinal-${failureOrdinal}`,
      detail: `Executable output stops before runtime ordinal ${failureOrdinal}: ${String(failureNode.plannedText || failureNode.type || 'browser action').trim()}.`,
      nonBlocking: true,
      failureBoundary: {
        ordinal: failureOrdinal,
        stepId: executedAstStepId(failureNode) || null,
        type: failureNode.type || null,
        operation: failureNode.operation || null,
        plannedText: failureNode.plannedText || null,
        outcome: executedAstOutcome(failureNode) || 'failed',
      },
    });
  }

  const existingGaps = [
    ...(Array.isArray(envelope.gaps) ? envelope.gaps : []),
    ...(Array.isArray(originalIr.gaps) ? originalIr.gaps : []),
  ];
  const gaps = [...existingGaps, ...projectionGaps].filter((gap, index, all) => {
    const key = JSON.stringify([gap && gap.code, gap && gap.where, gap && gap.detail]);
    return all.findIndex((candidate) => JSON.stringify([
      candidate && candidate.code,
      candidate && candidate.where,
      candidate && candidate.detail,
    ]) === key) === index;
  });
  const complete = envelope.complete !== false && originalIr.complete !== false && gaps.length === 0;
  result.envelope = {
    ...envelope,
    complete,
    gaps,
    ir: {
      ...originalIr,
      complete,
      gaps,
      steps: [...projectedSteps, ...retainedNonActionSteps],
      executedCaseAstProjection: {
        schema: 'qaai-executed-case-ast-projection/1',
        astId: ast.astId || null,
        astValidationValid: ast.validation && ast.validation.valid === true,
        succeededNodeCount,
        executableActionCount,
        successfulWaitCount,
        executableAssertionCount,
        firstFailureOrdinal: failureNode ? failureOrdinal : null,
        diagnosticsOnlyMissingActionCount: projectionGaps.filter(
          (gap) => gap.code === 'executed_action_missing_replayir_evidence',
        ).length,
      },
    },
  };
  return result;
}

function compileResults({ adapter, results, allowIncompletePreview = false }) {
  const admitted = [];
  const blocked = [];
  const manifestEntries = [];
  const findings = [];
  const usedPaths = new Set();
  const usedDataPaths = new Set();
  const usedClassNames = new Set();
  const adapterId = adapter && adapter.id;
  const adapterVersion = ADAPTER_VERSION[adapterId] || `${adapterId}-1`;
  const isSelenium = adapterId === 'selenium-reference' || adapterId === 'selenium-pom';
  const isPlaywright =
    adapterId === 'playwright-reference' ||
    adapterId === 'playwright-reference-js' ||
    adapterId === 'playwright-pom' ||
    adapterId === 'playwright-pom-js';
  const isJs = adapterId === 'playwright-reference-js' || adapterId === 'playwright-pom-js';

  // ── PASS 1: Gate chain ────────────────────────────────────────────────────
  const validatedItems = [];

  for (const r of results) {
    const base = {
      runId: r.runId,
      runResultId: r.runResultId,
      testCaseId: r.testCaseId,
      dataRowIndex: r.dataRowIndex == null ? null : Number(r.dataRowIndex),
      dataRowLabel: r.dataRowLabel || null,
      adapterId,
      adapterVersion,
      emitterVersion: (r.envelope && r.envelope.emitterVersion) || null,
      irHash: r.envelope && r.envelope.ir ? hashReplayIr(r.envelope.ir) : null,
      expectedVerdict: r.status,
      complete: !!(r.envelope && r.envelope.complete),
      gaps: (r.envelope && r.envelope.gaps) || [],
      requirementRefs: Array.isArray(r.requirementRefs) ? r.requirementRefs : [],
      authProfile: r.authProfile || null,
      dataBinding: r.dataBinding || null,
      dependsOnIds: dependencyValues(r.dependsOnIds),
      dependsOnNames: dependencyValues(r.dependsOnNames),
      sessionMode: r.sessionMode || 'fresh',
      dataRowsUsed: dataRowsUsed(r.envelope && r.envelope.ir),
      files: [],
      validationFindings: [],
      fileHashes: {},
    };

    if (r.runEligibility && r.runEligibility !== readinessCompiler.RUN_ELIGIBILITY.ALLOWED) {
      const reasons = Array.isArray(r.readinessReasons) ? r.readinessReasons : [];
      const finding = {
        rule: 'export_readiness_diagnostic',
        severity: 'warning',
        nonBlocking: true,
        runResultId: r.runResultId,
        testCaseId: r.testCaseId,
        readinessStatus: r.readinessStatus || 'blocked',
        reasons,
        message: `Source readiness is '${r.readinessStatus || 'blocked'}'. QAAI preserved positively executed evidence and recorded unavailable authoring as diagnostics.`,
      };
      base.validationFindings = [...base.validationFindings, finding];
      findings.push(finding);
    }

    // ── Block gate (#3, #8): missing / incomplete / invalid IR → NO output, no fallback.
    if (!r.envelope || !r.envelope.ir || (r.sourceReplayIrMissing && !resultHasPositiveExecution(r))) {
      const replayIrMissingDetail = r.sourceReplayIrMissing
        ? 'RunResult has no replayIrJson and no durable committed execution evidence was available to materialize one without fabricating.'
        : 'RunResult has no replayIrJson — cannot export without fabricating.';
      blocked.push({
        runResultId: r.runResultId,
        testCaseId: r.testCaseId,
        code: 'replayir_missing',
        detail: replayIrMissingDetail,
      });
      manifestEntries.push({
        ...base,
        status: 'blocked',
        blockReason: 'replayir_missing',
        detail: replayIrMissingDetail,
      });
      continue;
    }
    if (r.envelope.complete === false) {
      const incompleteFinding = {
        rule: 'replayir_source_evidence_incomplete',
        severity: 'warning',
        nonBlocking: true,
        runResultId: r.runResultId,
        testCaseId: r.testCaseId,
        message:
          'Source evidence is marked complete:false; QAAI preserved positively executed evidence and recorded the remaining evidence gaps as diagnostics.',
      };
      base.validationFindings = [...base.validationFindings, incompleteFinding];
      findings.push(incompleteFinding);
    }
    if (!resultHasPositiveExecution(r)) {
      const detail =
        'ReplayIR contains no positively executed browser action, observed wait, or evaluated assertion. It is preserved as an authored-contract diagnostic, not executable code.';
      blocked.push({
        runResultId: r.runResultId,
        testCaseId: r.testCaseId,
        code: 'replayir_zero_execution_provenance',
        detail,
      });
      manifestEntries.push({
        ...base,
        status: 'diagnostic_only',
        blockReason: 'replayir_zero_execution_provenance',
        detail,
      });
      continue;
    }

    const locatorAssessment = assessReplayLocatorEvidence(r.envelope.ir);
    if (!locatorAssessment.ok) {
      const locatorDiagnostics = (locatorAssessment.findings || []).map((finding) => ({
        ...finding,
        severity: 'warning',
        nonBlocking: true,
      }));
      base.validationFindings = [...base.validationFindings, ...locatorDiagnostics];
      findings.push(...locatorDiagnostics);
    }
    if (locatorAssessment.ok && locatorAssessment.findings.length) {
      base.validationFindings = [...base.validationFindings, ...locatorAssessment.findings];
      findings.push(...locatorAssessment.findings);
    }

    let opAssessment = operationBacked.assessOperationPlan({ result: r, ir: r.envelope.ir });
    if (opAssessment.mode === 'blocked') {
      const block = opAssessment.block || {};
      const diagnostics = [
        ...(opAssessment.findings || []),
        {
          rule: block.code || 'operation_export_unready',
          severity: 'warning',
          nonBlocking: true,
          runResultId: r.runResultId,
          testCaseId: r.testCaseId,
          message:
            block.detail ||
            'Operation-backed enhancement was unavailable; emitted the normal authored ReplayIR actions instead.',
        },
      ].map((finding) => ({ ...finding, severity: 'warning', nonBlocking: true }));
      base.validationFindings = [...base.validationFindings, ...diagnostics];
      findings.push(...diagnostics);
      opAssessment = { mode: 'replayir', findings: diagnostics, degradedFromOperationBacked: true };
    }

    validatedItems.push({ r, base, opAssessment });
  }

  // Class E: derive ONE canonical login precondition from the run's own recorded login
  // steps (any case that logged in — even one later blocked). Reused to reconstruct the
  // session for journeys whose session-establishing case is absent from this export.
  const loginPrecondition = isPlaywright ? deriveLoginPrecondition(results) : null;
  // Scenarios that established their OWN session via a login case (admitted OR blocked). If a
  // stranded journey's scenario is in this set, its session identity was scenario-specific —
  // substituting the canonical login could replay a DIFFERENT identity (e.g. an ESS user that
  // only existed mid-run), so we BLOCK rather than compose unfaithfully (L3). Stranded journeys
  // whose scenario is NOT in this set relied on cross-scenario/global inheritance → safe to
  // compose the canonical login.
  const scenariosWithOwnLogin = new Set(
    (results || [])
      .filter((r) => irPerformsLogin(r.envelope && r.envelope.ir))
      .map((r) => r.scenarioId)
      .filter(Boolean),
  );
  // The run's own logout evidence is diagnostic only. Do not compose hidden logout setup.
  const logoutUrl = isPlaywright ? deriveLogoutUrl(results) : null;
  const logoutActionSteps = isPlaywright ? deriveLogoutActionSteps(results) : null;
  const dependencyGraph = buildResultDependencyGraph(validatedItems);
  findings.push(...dependencyGraph.findings);

  // ── PASS 2: Playwright → journey grouping; everything else → per-case ─────
  if (isPlaywright) {
    const ungrouped = [];
    const groups = [];
    for (const component of dependencyGraph.components) {
      const hasScenario = component.some((item) => !!item.r.scenarioId);
      const hasDependencyEdge = component.some(
        (item) =>
          (dependencyGraph.parents.get(item) || new Set()).size > 0 ||
          (dependencyGraph.children.get(item) || new Set()).size > 0,
      );
      if (component.length === 1 && !hasScenario && !hasDependencyEdge) {
        ungrouped.push(component[0]);
        continue;
      }
      const scenarioIds = [...new Set(component.map((item) => item.r.scenarioId).filter(Boolean))];
      const scenarioName = semanticJourneyName(component);
      groups.push({
        // Internal grouping identity only. User-visible titles and paths are semantic.
        scenarioId:
          scenarioIds.length === 1
            ? scenarioIds[0]
            : `dependency-${slug(scenarioName, 'test-journey')}`,
        scenarioName,
        items: component,
      });
    }
    for (const group of groups) {
      _compileJourneyGroup({
        adapter,
        adapterId,
        adapterVersion,
        isJs,
        group,
        admitted,
        blocked,
        manifestEntries,
        findings,
        usedPaths,
        loginPrecondition,
        scenariosWithOwnLogin,
        logoutUrl,
        logoutActionSteps,
      });
    }
    for (const item of ungrouped) {
      // POM adapters have emitJourneySpec but no per-case emitStep contract.
      // Wrap ungrouped POM items as a single-case journey using testCaseId as scenarioId.
      if (adapterId === 'playwright-pom' || adapterId === 'playwright-pom-js') {
        const fakeGroup = {
          scenarioId: `case-${slug(semanticResultTitle(item.r), 'generated-test-case')}`,
          scenarioName: semanticResultTitle(item.r),
          items: [item],
        };
        _compileJourneyGroup({
          adapter,
          adapterId,
          adapterVersion,
          isJs,
          group: fakeGroup,
          admitted,
          blocked,
          manifestEntries,
          findings,
          usedPaths,
          loginPrecondition,
          scenariosWithOwnLogin,
          logoutUrl,
          logoutActionSteps,
        });
      } else {
        _compilePerCase({
          adapter,
          adapterId,
          adapterVersion,
          isSelenium,
          isJs,
          item,
          admitted,
          blocked,
          manifestEntries,
          findings,
          usedPaths,
          usedClassNames,
          usedDataPaths,
          dependencyGraph,
        });
      }
    }
  } else {
    for (const item of validatedItems) {
      _compilePerCase({
        adapter,
        adapterId,
        adapterVersion,
        isSelenium,
        isJs: false,
        item,
        admitted,
        blocked,
        manifestEntries,
        findings,
        usedPaths,
        usedClassNames,
        usedDataPaths,
        dependencyGraph,
      });
    }
  }

  return { admitted, blocked, manifestEntries, findings, adapterId, adapterVersion };
}

function _emitJourneyDiagnosticArtifacts({
  adapterId,
  adapterVersion,
  scenarioId,
  scenarioName,
  items,
  admitted,
  manifestEntries,
  findings,
  usedPaths,
  code,
  detail,
}) {
  const groupFinding = {
    rule: code,
    severity: 'warning',
    nonBlocking: true,
    scenarioId: scenarioId || null,
    message: detail,
  };
  findings.push(groupFinding);

  for (const item of items) {
    const { r, base } = item;
    const filePath = blockedPreviewSpecPath(r, adapterId, usedPaths);
    const content = blockedPreviewPlaywrightSpec(
      r,
      { code, detail, readinessStatus: 'generated_draft' },
      adapterId,
      deriveTargetUrlFromResults([r], ''),
    );
    const caseFinding = {
      ...groupFinding,
      runResultId: r.runResultId || null,
      testCaseId: r.testCaseId || null,
    };
    const manifestEntry = {
      ...base,
      adapterId,
      adapterVersion,
      scenarioId: scenarioId || r.scenarioId || null,
      scenarioName: scenarioName || r.scenarioName || null,
      expectedVerdict: r.status,
      status: 'diagnostic_only',
      diagnosticOnly: true,
      diagnosticReason: code,
      files: [filePath],
      fileHashes: { [filePath]: sha256(content) },
      validationFindings: [...(base.validationFindings || []), caseFinding],
    };
    admitted.push({
      ...manifestEntry,
      filePath,
      content,
      extraFiles: {},
      runCommand: null,
    });
    manifestEntries.push(manifestEntry);
  }
}

/** Compile all validated items from one scenario group into a single journey spec. */
function _compileJourneyGroup({
  adapter,
  adapterId,
  adapterVersion,
  isJs,
  group,
  admitted,
  blocked,
  manifestEntries,
  findings,
  usedPaths,
  loginPrecondition,
  scenariosWithOwnLogin,
  logoutUrl,
  logoutActionSteps,
}) {
  const { scenarioId, scenarioName, items } = group;
  const emitFn = typeof adapter.emitJourneySpec === 'function' ? adapter.emitJourneySpec : null;
  if (!emitFn) {
    _emitJourneyDiagnosticArtifacts({
      adapterId,
      adapterVersion,
      scenarioId,
      scenarioName,
      items,
      admitted,
      manifestEntries,
      findings,
      usedPaths,
      code: 'journey_emit_unsupported_diagnostic',
      detail: `Adapter ${adapterId} has no journey emitter. QAAI preserved every case as a downloadable non-test diagnostic and did not synthesize normal per-case specs.`,
    });
    return;
  }

  // Class E (logout): a stranded post-logout journey. Block instead of injecting a hidden
  // logout precondition; approved logout actions inside the journey still emit normally.
  const needsLogout = journeyNeedsLogoutPrecondition(items);
  // Class E: this journey assumes an authenticated session it never establishes.
  const needsSession = !needsLogout && loginPrecondition && journeyNeedsLoginPrecondition(items);

  if (needsLogout) {
    findings.push({
      rule: 'replayir_logout_precondition_diagnostic',
      severity: 'warning',
      nonBlocking: true,
      message: `Scenario '${scenarioName || scenarioId}' references a logged-out state without an explicit local teardown; the authored flow remains enabled and no hidden logout action was invented.`,
    });
  }
  // If the scenario established its OWN session (via a login case now absent from the export),
  // we cannot faithfully reconstruct that identity with the canonical login — block honestly
  // rather than emit a spec that would run under the wrong identity (L3: no inauthentic state).
  if (needsSession && scenariosWithOwnLogin && scenariosWithOwnLogin.has(scenarioId)) {
    findings.push({
      rule: 'replayir_session_precondition_diagnostic',
      severity: 'warning',
      nonBlocking: true,
      message: `Scenario '${scenarioName || scenarioId}' depends on its authored session-establishing flow; the generated journey remains enabled and does not substitute another identity.`,
    });
  }

  // Block: a journey that NEEDS logout teardown composition (references a logged-out state)
  // but the ingredients (a recorded login + an evidenced logout URL) are unavailable.
  // Emitting would produce a SecurityError (bare document.cookie on about:blank) or a
  // false-negative EVALUATE on wrong session state — both L3 artifacts (export fails for a
  // reason absent from live). Block honestly rather than ship a crashing spec.
  const logoutCompositionUnavailable = journeyNeedsLogoutButCant(items, {
    loginPrecondition,
    logoutUrl,
    logoutActionSteps,
  });
  if (logoutCompositionUnavailable) {
    findings.push({
      rule: 'replayir_logout_composition_diagnostic',
      severity: 'warning',
      nonBlocking: true,
      message: `Scenario '${scenarioName || scenarioId}' has no reusable logout composition evidence; the authored flow remains enabled and no hidden action was invented.`,
    });
  }

  const cases = items.map(({ r }) => ({
    ir: r.envelope.ir,
    caseName: r.caseName || (r.envelope.ir && r.envelope.ir.title) || r.testCaseId,
    status: r.status,
    runResultId: r.runResultId,
    testCaseId: r.testCaseId,
    declaredSteps: Array.isArray(r.declaredSteps) ? r.declaredSteps : [],
    ...(adapterId === 'playwright-pom-js'
      ? {
          sessionMode: r.sessionMode || 'fresh',
          dependsOnIds: dependencyValues(r.dependsOnIds),
          dependsOnNames: dependencyValues(r.dependsOnNames),
        }
      : {}),
  }));

  // Fix 2: Stranded evaluate — a case whose IR has ONLY assert/evaluate steps with no
  // preceding navigate or action, AND whose assertions specifically check login-page
  // validation state (DOM evaluates that inspect form error spans, or EVALUATE channel
  // assertions). In the live run the agent inherited page state from a prior case on the
  // login page; standalone the evaluate runs on a blank page and fails for a reason absent
  // from live (L3 artifact). Compose a minimal "navigate + submit-empty" precondition so
  // the login form is loaded and the validation error is triggered.
  // IMPORTANT: cases that only have UI_TEXT/PAGE assertions checking app content (e.g. sidebar
  // nav items such as "Settings" or "Reports") are NOT injected — they work via the inherited authenticated
  // session from the preceding case in the serial journey. Injecting login-page navigation
  // for those cases would break them (login page has no nav items).
  for (const c of cases) {
    // irHasOnlyFormValidationAsserts: no act steps + all asserts are validation-type.
    // When true, the page state the EVALUATE needs was established by a prior case's action
    // (e.g. an empty-submit click) not by steps in this IR → stranded standalone.
    const isValidationCase = irHasOnlyFormValidationAsserts(c.ir);
    if (isValidationCase && loginPrecondition && loginPrecondition.steps) {
      // Compose a "navigate + empty-submit" precondition: reuse the run's recorded login nav +
      // the login-button click (without the fill steps) to trigger form-validation error messages.
      const steps = Array.isArray(c.ir && c.ir.steps) ? c.ir.steps : [];
      const navStep = loginPrecondition.steps.find(
        (s) => s && s.op === 'act' && s.action === 'navigate',
      );
      const btnResolve = loginPrecondition.steps.find(
        (s) =>
          s &&
          s.op === 'resolve' &&
          (s.candidates || []).some(
            (cand) => cand && String(cand.role || '').toLowerCase() === 'button',
          ),
      );
      const btnClick =
        btnResolve &&
        loginPrecondition.steps.find(
          (s) => s && s.op === 'act' && s.action === 'click' && s.target === btnResolve.as,
        );
      if (navStep && btnResolve && btnClick) {
        c.ir = {
          ...c.ir,
          steps: [{ ...navStep }, { ...btnResolve }, { ...btnClick }, ...steps],
        };
        findings.push({
          rule: 'composed_validation_trigger',
          severity: 'info',
          message: `Case '${c.caseName}' had only form-validation evaluate steps; prepended navigate+empty-submit to establish login-form validation state (L3 fix).`,
        });
      } else {
        // loginPrecondition exists but the required nav+button steps could not be extracted —
        // cannot compose the trigger. Block rather than emit code that evaluates in wrong state.
        c._blocked = {
          code: 'replayir_stranded_evaluate',
          detail: `Case '${c.caseName}' has only form-validation EVALUATE steps but the login precondition could not supply navigate+button steps to establish the validation state.`,
        };
      }
    } else if (isValidationCase) {
      // No login was recorded in this run — cannot derive a navigate+empty-submit precondition.
      // Block rather than emit code that evaluates on a blank page (L3 artifact).
      c._blocked = {
        code: 'replayir_stranded_evaluate',
        detail: `Case '${c.caseName}' has only form-validation EVALUATE/assert steps with no establishing action, and no login sequence was recorded in this run. Re-run after a login flow is captured.`,
      };
    }
  }

  // Fix 3: Credential contradiction — a case fills env-bound canonical credentials (valid
  // creds) then immediately asserts login-page content (stays on login page). This means the
  // live agent typed wrong/test credentials that the conductor captured as the canonical env
  // binding. The export filling valid creds → successful login → login-page assertions fail.
  // Block with a clear reason rather than emitting code that fails for the wrong reason (L3).
  function _isCredentialFill(step) {
    return (
      step &&
      step.op === 'act' &&
      (step.action === 'fill' || step.action === 'type') &&
      step.rawValue == null &&
      typeof step.valueRef === 'string' &&
      /^env:/i.test(step.valueRef)
    );
  }
  function _isLoginPageAssertion(step) {
    // Returns true only when the assertion is checking for login-FORM content — i.e.
    // content that would only appear on the login page (the form labels "Username" / "Password"),
    // meaning the page did NOT redirect away after the credential submit.
    // A PAGE assertion checking for "Dashboard" or other post-login content must NOT match here.
    if (!step || step.op !== 'assert') return false;
    const ch = String(step.channel || '').toUpperCase();
    const expected = String(step.expected || '').toLowerCase();
    // Login-form labels: if the assertion checks "Username" or "Password" text after a submit,
    // the page is still showing the login form (redirect would have removed these form fields).
    const isLoginFormContent = expected === 'username' || expected === 'password';
    if ((ch === 'PAGE' || ch === 'UI_TEXT' || ch === 'TEXT_MATCH') && isLoginFormContent)
      return true;
    return false;
  }
  function _credentialRoleFromText(value) {
    const text = String(value || '').toLowerCase();
    if (/password|pass\b|pwd/.test(text)) return 'password';
    if (/username|user\b|login|email/.test(text)) return 'username';
    return null;
  }
  function _credentialRoleForEnvFill(step) {
    if (!step || typeof step.valueRef !== 'string') return null;
    return _credentialRoleFromText(step.valueRef);
  }
  function _declaredCredentialFills(declaredSteps) {
    const byRole = { username: [], password: [] };
    for (const step of Array.isArray(declaredSteps) ? declaredSteps : []) {
      if (!step) continue;
      const action = String(step.action || '').toLowerCase();
      if (action !== 'fill' && action !== 'type' && action !== 'enter') continue;
      const role = _credentialRoleFromText(
        `${step.target || ''} ${step.element || ''} ${step.locator_hint || ''}`,
      );
      if (!role) continue;
      const value = step.value;
      const literal =
        typeof value === 'string' && value.trim().length > 0 && !/^<|^\{\{/.test(value.trim())
          ? value.trim()
          : null;
      if (!literal) continue;
      byRole[role].push({
        value: literal,
        actionText:
          `${step.action || ''} ${step.element || ''} ${step.target || ''} ${step.expected || ''}`.toLowerCase(),
      });
    }
    return byRole;
  }
  function _declaredCredentialIsNegative(role, entry, caseName) {
    if (!entry || !entry.value) return false;
    const text = `${caseName || ''} ${entry.actionText || ''}`.toLowerCase();
    const literal = String(entry.value).toLowerCase();
    if (role === 'username') {
      if (
        /valid username/.test(text) &&
        !/invalid username|wrong username|non[-\s]?existent username|bad[_\s-]*user|payload|injection|sql|xss/.test(
          text,
        )
      )
        return false;
      return (
        /invalid username|wrong username|non[-\s]?existent username|bad[_\s-]*user|username.*(payload|injection|sql|xss)|(payload|injection|sql|xss).*username/.test(
          text,
        ) ||
        /bad[_\s-]*user|nonexistent|invalid|['";<>]|--\s|\/\*|\*\/|or\s+\d+=\d+|union.*select|alert\s*\(/.test(
          literal,
        )
      );
    }
    if (role === 'password') {
      if (
        /valid password/.test(text) &&
        !/wrong password|invalid password|bad password|password.*(payload|injection|sql|xss)|(payload|injection|sql|xss).*password/.test(
          text,
        )
      )
        return false;
      return (
        /wrong password|invalid password|bad password|password.*(payload|injection|sql|xss)|(payload|injection|sql|xss).*password/.test(
          text,
        ) ||
        /wrong|invalid|bad|['";<>]|--\s|\/\*|\*\/|or\s+\d+=\d+|union.*select|alert\s*\(/.test(
          literal,
        )
      );
    }
    return false;
  }
  function _repairEnvCredentialFillsFromDeclared(caseObj, steps) {
    const declaredByRole = _declaredCredentialFills(caseObj.declaredSteps);
    const cursor = { username: 0, password: 0 };
    let repaired = 0;
    const repairedRoles = new Set();
    for (const s of steps) {
      if (!s || s.op !== 'act' || (s.action !== 'fill' && s.action !== 'type')) continue;
      if (s.rawValue != null || typeof s.valueRef !== 'string' || !/^env:/i.test(s.valueRef))
        continue;
      const role = _credentialRoleForEnvFill(s);
      if (!role) continue;
      const entry = declaredByRole[role][cursor[role]++] || null;
      if (!_declaredCredentialIsNegative(role, entry, caseObj.caseName)) continue;
      s.rawValue = entry.value;
      delete s.valueRef;
      repaired += 1;
      repairedRoles.add(role);
    }
    return { repaired, repairedRoles: [...repairedRoles] };
  }
  for (const c of cases) {
    if (c.synthetic) continue;
    const steps = Array.isArray(c.ir && c.ir.steps) ? c.ir.steps : [];
    const credFills = steps.filter(_isCredentialFill);
    const hasUsernameEnv = credFills.some((s) => /username|user$/i.test(String(s.valueRef || '')));
    const hasPasswordEnv = credFills.some((s) => /password|pass$/i.test(String(s.valueRef || '')));
    if (!(hasUsernameEnv && hasPasswordEnv)) continue;
    // Both username and password are env-bound. Check if there's a login-page assertion
    // AFTER the credential submit click WITHOUT a subsequent navigate (meaning the page
    // didn't redirect away after login — impossible with valid credentials).
    // Note: seenLoginSubmit is set on the first click AFTER fills are seen; the initial
    // goto-login navigate does NOT count as "navigating away from login".
    let seenLoginSubmit = false;
    let seenPostSubmitNavigate = false;
    let hasContradiction = false;
    for (const s of steps) {
      if (!s) continue;
      if (!seenLoginSubmit && s.op === 'act' && s.action === 'click') {
        // Count this as the login-form submit only if cred fills have already been seen.
        seenLoginSubmit = true;
      }
      if (seenLoginSubmit && s.op === 'act' && s.action === 'navigate')
        seenPostSubmitNavigate = true;
      if (seenLoginSubmit && !seenPostSubmitNavigate && _isLoginPageAssertion(s)) {
        hasContradiction = true;
        break;
      }
    }
    if (hasContradiction) {
      // Substitute only negative credential literals that were declared by the test design,
      // preserving repeated attempts in order (bad_user_1, bad_user_2, ...). Valid credential
      // fields stay env-bound. Never invent placeholder credentials.
      const repair = _repairEnvCredentialFillsFromDeclared(c, steps);
      if (!repair.repaired) {
        c._blocked = {
          code: 'replayir_negative_credential_fixture_missing',
          detail: `Case '${c.caseName}' stayed on the login page after credential submit, but ReplayIR only has canonical env credentials and no declared negative credential literal. QAAI must reacquire the exact username/password fixture instead of inventing placeholder credentials.`,
        };
        continue;
      }
      findings.push({
        rule: 'replayir_credential_gap_resolved',
        severity: 'info',
        message: `Case '${c.caseName}': credential contradiction resolved using ${repair.repaired} declared negative ${repair.repaired === 1 ? 'credential value' : 'credential values'} (${repair.repairedRoles.join(', ')}); no placeholder credentials were invented.`,
      });
    }
  }
  // Credential contradictions without declared negative fixture values are blocked for
  // output readiness. The website verdict remains whatever the live assertions proved.
  const credBlockedItems = [];
  for (const c of cases.filter((candidate) => candidate._blocked)) {
    findings.push({
      rule: c._blocked.code || 'replayir_source_data_diagnostic',
      severity: 'warning',
      nonBlocking: true,
      message:
        c._blocked.detail ||
        `Case '${c.caseName}' has a source-data diagnostic; the authored flow remains enabled.`,
    });
  }
  for (const c of credBlockedItems) {
    blocked.push({
      runResultId: c.runResultId,
      testCaseId: c.testCaseId,
      code: c._blocked.code,
      detail: c._blocked.detail,
    });
    manifestEntries.push({
      adapterId,
      adapterVersion,
      scenarioId,
      scenarioName,
      runResultIds: [c.runResultId],
      testCaseIds: [c.testCaseId],
      status: 'blocked',
      blockReason: c._blocked.code,
    });
  }
  const admissibleCases = [...cases];
  if (admissibleCases.length === 0) {
    return;
  }
  cases.length = 0;
  admissibleCases.forEach((c) => cases.push(c));

  // The journey relied on cross-scenario / global session inheritance (no login case of its
  // own). Reconstruct that session by prepending the run's own recorded login steps as a
  // synthetic first case — faithful replay of the session the live run used, no invented creds.
  let composedLoginPrecondition = false;
  if (needsSession) {
    cases.unshift({
      ir: {
        title: "Authenticated session prerequisite (composed from the run's recorded login)",
        steps: loginPrecondition.steps.map((s) => ({ ...s })),
      },
      caseName: "Authenticated session prerequisite (composed from the run's recorded login)",
      status: 'pass',
      runResultId: null,
      testCaseId: null,
      synthetic: true,
    });
    composedLoginPrecondition = true;
    findings.push({
      rule: 'composed_login_precondition',
      severity: 'info',
      message: `Scenario '${scenarioName || scenarioId}' had no session-establishing case in the export; prepended the run's recorded login as a precondition.`,
    });
  }

  // Logout teardown composition is intentionally disabled. A logout can appear in generated
  // output only when it came from the case's own approved ReplayIR steps.
  let composedLogoutPrecondition = false;

  // Pre-compute specDir + filePath before emitFn so the adapter can derive
  // structurally-correct relative import paths (e.g. ../../pages from tests/module/).
  const ext = isJs ? 'spec.js' : 'spec.ts';
  const moduleSeg = slug(items[0].r.moduleName || 'journey');
  const scenarioSeg = semanticSpecSlug(scenarioName || scenarioId);
  const specDir = `tests/${moduleSeg}`;

  let emitResult;
  try {
    emitResult = emitFn(cases, { scenarioName, scenarioId, specDir });
  } catch (error) {
    const detail = String(error?.message || error || 'unknown journey emitter failure').slice(
      0,
      500,
    );
    _emitJourneyDiagnosticArtifacts({
      adapterId,
      adapterVersion,
      scenarioId,
      scenarioName,
      items,
      admitted,
      manifestEntries,
      findings,
      usedPaths,
      code: 'journey_emit_failed_diagnostic',
      detail: `Adapter ${adapterId} failed to emit the journey (${detail}). QAAI preserved every case as a downloadable non-test diagnostic and did not synthesize normal per-case specs.`,
    });
    return;
  }
  const filePath = uniqueSemanticPath(`tests/${moduleSeg}/${scenarioSeg}.${ext}`, usedPaths);
  // emitFn may return a plain string (playwright-reference) or { content, extraFiles }
  // (playwright-pom). Normalise so the rest of the function is uniform.
  const rawContent =
    typeof emitResult === 'string' ? emitResult : (emitResult && emitResult.content) || '';
  const extraFiles =
    typeof emitResult === 'object' && emitResult && emitResult.extraFiles
      ? emitResult.extraFiles
      : {};
  const pomGraph =
    typeof emitResult === 'object' && emitResult && emitResult.pomGraph
      ? emitResult.pomGraph
      : null;
  // If ALL cases are skipped/blocked/needs_human, wrap the entire journey.
  const finalContent = rawContent;

  const expectedVerdict = items.some(({ r }) => r.status === 'pass')
    ? 'pass'
    : items.some(({ r }) => r.status === 'fail')
      ? 'fail'
      : 'blocked';
  const irHashes = items
    .map(({ r }) => (r.envelope.ir ? hashReplayIr(r.envelope.ir) : null))
    .filter(Boolean);
  const manifestEntry = {
    adapterId,
    adapterVersion,
    scenarioId,
    scenarioName,
    runResultIds: items.map(({ r }) => r.runResultId),
    testCaseIds: items.map(({ r }) => r.testCaseId),
    irHashes,
    expectedVerdict,
    complete: items.every(({ r }) => r.envelope.complete !== false),
    files: [filePath, ...Object.keys(extraFiles)],
    fileHashes: { [filePath]: sha256(finalContent) },
    validationFindings: [],
    composedLoginPrecondition,
    composedLogoutPrecondition,
  };
  admitted.push({
    ...manifestEntry,
    filePath,
    content: finalContent,
    extraFiles,
    pomGraph,
    runCommand: adapter.runCmd && adapter.runCmd({}),
  });
  manifestEntries.push(manifestEntry);
}

/** Compile a single validated result into a per-case spec (existing pipeline). */
function _compilePerCase({
  adapter,
  adapterId,
  adapterVersion,
  isSelenium,
  isJs,
  item,
  admitted,
  blocked,
  manifestEntries,
  findings,
  usedPaths,
  usedClassNames,
  usedDataPaths,
  dependencyGraph = null,
}) {
  const { r, base, opAssessment } = item;

  const irDataRows = (() => {
    const ir = r.envelope && r.envelope.ir;
    if (!ir) return [];
    return Array.isArray(ir.dataRows) && ir.dataRows.length
      ? ir.dataRows
      : ir.dataRow
        ? [ir.dataRow]
        : [];
  })();

  // Per-case DDT file: one JSON file per RunResult, containing only the rows this case ran.
  // Using per-case isolation (not per-module) prevents cross-pollination: a case designed for
  // an Admin row must not iterate ESS rows just because they share a module data file.
  let dataCaseSlug = null;
  let dataFilePath = null;
  let dataFileContent = null;
  if (irDataRows.length && usedDataPaths) {
    const safeRows = _buildSafeRows(irDataRows);
    if (safeRows.length) {
      const caseSlugBase = readableCaseName(r);
      const dataDir = isSelenium ? 'src/test/resources/test-data' : 'tests/data';
      dataFilePath = uniqueSemanticPath(`${dataDir}/${caseSlugBase}.json`, usedDataPaths);
      dataCaseSlug = dataFilePath
        .split('/')
        .pop()
        .replace(/\.json$/, '');
      dataFileContent = JSON.stringify(safeRows, null, 2) + '\n';
    }
  }

  const opts = {
    runResultId: r.runResultId,
    testCaseId: r.testCaseId,
    testTitle: semanticResultTitle(r),
    caseName: r.caseName || r.testCaseName || r.name || null,
    scenarioName: r.scenarioName || (r.scenario && r.scenario.name) || null,
    dependsOn: [
      ...new Set([
        ...dependencyValues(r.dependsOnNames),
        ...(dependencyGraph ? dependencyGraph.dependencyNames(item) : []),
      ]),
    ],
    // Per-case data file slug (basename without .json). Injected into spec by adapters.
    dataCaseSlug,
  };
  if (isSelenium) {
    const classNameForFn =
      typeof adapter.classNameFor === 'function'
        ? adapter.classNameFor
        : seleniumReference.classNameFor;
    const semanticTitle = semanticResultTitle(r);
    let duplicate = 1;
    let className = classNameForFn(semanticTitle, base.dataRowIndex, null, semanticTitle);
    while (usedClassNames.has(className)) {
      duplicate += 1;
      className = classNameForFn(
        `${semanticTitle} ${duplicate}`,
        base.dataRowIndex,
        null,
        `${semanticTitle} ${duplicate}`,
      );
    }
    usedClassNames.add(className);
    opts.className = className;
    opts.adapterFindings = [];
    opts.continueSession = isContinuationSession(r);
    opts.preserveSessionForDependents = !!(dependencyGraph && dependencyGraph.hasDependents(item));
    base.continueSession = opts.continueSession;
    base.preserveSessionForDependents = opts.preserveSessionForDependents;
  }

  let compiled;
  try {
    compiled = contract.compileReplayIR(adapter, r.envelope.ir, opts);
  } catch (e) {
    const code =
      e.code === 'selenium_locator_unmappable' ? 'selenium_locator_unmappable' : 'replayir_invalid';
    const diagnostic = blockedReasonForResult(r, [{ code, detail: e.message }]);
    let filePath;
    let content;
    if (isSelenium) {
      const classStem =
        readableCaseName(r)
          .replace(/(^|-)([a-z0-9])/g, (_, __, c) => String(c).toUpperCase())
          .replace(/[^A-Za-z0-9]/g, '')
          .slice(0, 70) || 'GeneratedCase';
      let className = `${classStem}Test`;
      let duplicate = 2;
      while (usedClassNames.has(className)) className = `${classStem}${duplicate++}Test`;
      usedClassNames.add(className);
      filePath = `src/test/java/com/qaai/replayir/${className}.java`;
      content = blockedPreviewJava(r, diagnostic, className, deriveTargetUrlFromResults([r], ''));
    } else {
      filePath = blockedPreviewSpecPath(r, adapterId, usedPaths);
      content = blockedPreviewPlaywrightSpec(
        r,
        diagnostic,
        adapterId,
        deriveTargetUrlFromResults([r], ''),
      );
      base.diagnosticOnly = true;
      base.diagnosticReason = code;
    }
    const compileFinding = {
      rule: isSelenium
        ? 'selected_adapter_compile_repaired'
        : 'selected_adapter_compile_diagnostic',
      severity: 'warning',
      nonBlocking: true,
      runResultId: r.runResultId,
      testCaseId: r.testCaseId,
      message: isSelenium
        ? `The selected adapter could not compile its primary source (${e.message}); QAAI emitted the selected framework's existing diagnostic representation.`
        : `The selected Playwright adapter could not compile its primary source (${e.message}); QAAI emitted a downloadable non-test diagnostic artifact and did not synthesize a guessed fallback spec.`,
    };
    base.files = [filePath];
    base.fileHashes = { [filePath]: sha256(content) };
    base.validationFindings = [...(base.validationFindings || []), compileFinding];
    admitted.push({
      ...base,
      status: r.status,
      filePath,
      content,
      extraFiles: {},
      dataFilePath,
      dataFileContent,
    });
    manifestEntries.push({ ...base, status: r.status });
    findings.push(compileFinding);
    return;
  }

  const irStatus = compiled && r.envelope.ir.verdict && r.envelope.ir.verdict.status;
  if (irStatus && irStatus !== r.status) {
    findings.push({
      rule: 'verdict_mismatch',
      severity: 'error',
      message: `RunResult ${r.runResultId}: ir.verdict.status='${irStatus}' != RunResult.status='${r.status}'.`,
    });
  }

  const rawPath = compiled.layout.testFile || compiled.layout.primaryFile;
  let rawContent = compiled.files[rawPath] || '';
  const compiledExtraFiles = Object.fromEntries(
    Object.entries(compiled.files || {}).filter(([rel]) => rel !== rawPath),
  );
  if (opAssessment.mode === 'operationBacked') {
    rawContent = isSelenium
      ? operationBacked.augmentSelenium(rawContent, opAssessment.boundOperations, r.envelope.ir)
      : operationBacked.augmentPlaywright(rawContent, opAssessment.boundOperations, r.envelope.ir);
    base.operationBacked = true;
    base.operationOperations = (opAssessment.boundOperations || [])
      .map((op) => op && op.operation)
      .filter(Boolean);
    base.validationFindings = [...base.validationFindings, ...(opAssessment.findings || [])];
    findings.push(...(opAssessment.findings || []));
  }

  let filePath;
  if (isSelenium) {
    filePath = rawPath;
  } else {
    const ext = isJs ? 'spec.js' : 'spec.ts';
    filePath = uniqueSemanticPath(readableSpecPath(r, ext), usedPaths);
  }
  if (isSelenium) usedPaths.add(filePath);

  // Apply the same sanitizer that runs on LLM-generated code: catches descriptor-text
  // getByText() locators, broken URL regexes, and other mechanical issues that can slip
  // through the ReplayIR adapter when KB labels contain agent narration text.
  if (!isSelenium) {
    // CHECKPOINT: sanitize + AST-parse every file before it is admitted. A parse
    // failure becomes an error-severity finding (which flips exportValid=false)
    // instead of shipping an un-loadable spec. Runs in the per-file loop that
    // BOTH the Output Files tab and the ZIP flow through, so neither escapes it.
    try {
      const { certifyFile } = require('./_certify');
      const cert = certifyFile({ relPath: filePath || '', content: rawContent });
      if (Array.isArray(cert.findings) && cert.findings.length) {
        findings.push(
          ...cert.findings.map((f) => ({
            ...f,
            ...(cert.parseOk ? {} : { severity: 'warning', nonBlocking: true }),
            runResultId: r.runResultId,
          })),
        );
      }
      if (Array.isArray(cert.rewrites) && cert.rewrites.length) {
        base.sanitizerRewrites = cert.rewrites;
      }
      const originalGeneratedSource = rawContent;
      if (!cert.parseOk) {
        rawContent = originalGeneratedSource;
      } else {
        rawContent = cert.content;
      }
      if (!cert.parseOk) {
        const errDetail = cert.parseError
          ? String(cert.parseError).slice(0, 200)
          : 'unknown parse error';
        const evidencePath = uniqueSemanticPath(
          `evidence/unparsed-source/${readableModule(r)}/${readableCaseName(r)}.generated-source.txt`,
          usedPaths,
        );
        compiledExtraFiles[evidencePath] = originalGeneratedSource;
        filePath = blockedPreviewSpecPath(r, adapterId, usedPaths);
        rawContent = blockedPreviewPlaywrightSpec(
          r,
          {
            code: 'generated_source_syntax_diagnostic',
            detail: errDetail,
            readinessStatus: 'generated_draft',
          },
          adapterId,
          deriveTargetUrlFromResults([r], ''),
        );
        base.diagnosticOnly = true;
        base.diagnosticReason = 'generated_source_syntax_diagnostic';
        findings.push({
          rule: 'generated_source_syntax_diagnostic',
          severity: 'warning',
          nonBlocking: true,
          runResultId: r.runResultId,
          testCaseId: r.testCaseId,
          evidenceFile: evidencePath,
          message: `The adapter source did not parse, so QAAI preserved it as evidence and emitted a downloadable non-test diagnostic artifact (${errDetail}). No guessed fallback spec was synthesized.`,
        });
      }
    } catch (err) {
      console.error('[QAAI certify] replayExport certifyFile threw:', err && err.message);
    }
  }

  const wrap = base.diagnosticOnly
    ? { content: rawContent, anchorMissing: false }
    : wrapForVerdict(
        adapterId,
        rawContent,
        r.status,
        r.blockedReason,
        resultHasPositiveExecution(r),
      );
  if (wrap.anchorMissing)
    findings.push({
      rule: 'verdict_wrap_anchor_missing',
      severity: 'warning',
      message: `Could not find the skip anchor for ${r.runResultId}; prepended a neutralizing note instead.`,
    });

  const adapterFindings = Array.isArray(opts.adapterFindings) ? opts.adapterFindings : [];
  base.files = [filePath, ...Object.keys(compiledExtraFiles)];
  base.fileHashes = {
    [filePath]: sha256(wrap.content),
    ...Object.fromEntries(
      Object.entries(compiledExtraFiles).map(([rel, content]) => [rel, sha256(content)]),
    ),
  };
  base.validationFindings = [...(base.validationFindings || []), ...adapterFindings];
  admitted.push({
    ...base,
    status: r.status,
    filePath,
    content: wrap.content,
    extraFiles: compiledExtraFiles,
    runCommand: compiled.runCommand,
    compileCommand: compiled.compileCommand,
    dataFilePath,
    dataFileContent,
  });
  manifestEntries.push({ ...base, status: r.status });
  findings.push(...adapterFindings);
}

const PW_PACKAGE_BASE = {
  name: 'qaai-replayir-export',
  private: true,
  version: '0.0.0',
  scripts: { test: 'playwright test', list: 'playwright test --list' },
  devDependencies: {
    '@playwright/test': '1.61.1',
    '@axe-core/playwright': '4.12.1',
  },
};

const PLAYWRIGHT_POM_JS_TEMPLATE_DIR = path.join(__dirname, 'templates', 'playwright-pom-js');
const PLAYWRIGHT_POM_JS_PACKAGE_PATH = path.join(PLAYWRIGHT_POM_JS_TEMPLATE_DIR, 'package.json');
const PLAYWRIGHT_POM_JS_LOCK_PATH = path.join(PLAYWRIGHT_POM_JS_TEMPLATE_DIR, 'package-lock.json');

function readPlaywrightPomJsTemplateFile(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  return source.endsWith('\n') ? source : `${source}\n`;
}

function dependencySections(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    dependencies:
      source.dependencies && typeof source.dependencies === 'object' ? source.dependencies : {},
    devDependencies:
      source.devDependencies && typeof source.devDependencies === 'object'
        ? source.devDependencies
        : {},
    optionalDependencies:
      source.optionalDependencies && typeof source.optionalDependencies === 'object'
        ? source.optionalDependencies
        : {},
  };
}

function stableDependencyMap(value) {
  return Object.fromEntries(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));
}

function inspectPlaywrightPomJsPackageContract({ packageSource, lockSource } = {}) {
  const findings = [];
  let pkg = null;
  let lock = null;
  try {
    pkg = JSON.parse(String(packageSource || ''));
  } catch (error) {
    findings.push({
      rule: 'pom_js_package_json_invalid',
      message: `package.json is not valid JSON: ${error && error.message}`,
    });
  }
  try {
    lock = JSON.parse(String(lockSource || ''));
  } catch (error) {
    findings.push({
      rule: 'pom_js_package_lock_invalid',
      message: `package-lock.json is not valid JSON: ${error && error.message}`,
    });
  }
  if (!pkg || !lock) return { ok: false, pkg, lock, findings };

  if (pkg.type !== 'module')
    findings.push({
      rule: 'pom_js_package_not_esm',
      message: 'package.json must declare type=module.',
    });
  if (lock.lockfileVersion !== 3)
    findings.push({
      rule: 'pom_js_package_lock_version',
      message: 'package-lock.json must use lockfileVersion 3.',
    });
  const root = lock.packages && lock.packages[''];
  if (!root || typeof root !== 'object') {
    findings.push({
      rule: 'pom_js_package_lock_root_missing',
      message: 'package-lock.json is missing packages[""].',
    });
    return { ok: false, pkg, lock, findings };
  }
  if (root.name !== pkg.name || root.version !== pkg.version) {
    findings.push({
      rule: 'pom_js_package_lock_identity_mismatch',
      message: 'package-lock root name/version must match package.json.',
    });
  }

  const packageSections = dependencySections(pkg);
  const lockSections = dependencySections(root);
  for (const section of Object.keys(packageSections)) {
    const expected = stableDependencyMap(packageSections[section]);
    const actual = stableDependencyMap(lockSections[section]);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      findings.push({
        rule: 'pom_js_package_lock_root_mismatch',
        section,
        message: `package-lock root ${section} must exactly match package.json.`,
      });
    }
    for (const [name, version] of Object.entries(expected)) {
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version))) {
        findings.push({
          rule: 'pom_js_dependency_not_exact',
          dependency: name,
          message: `${name} must use an exact version.`,
        });
        continue;
      }
      const locked = lock.packages[`node_modules/${name}`];
      if (!locked || locked.version !== version) {
        findings.push({
          rule: 'pom_js_dependency_lock_version_mismatch',
          dependency: name,
          message: `${name} must be locked at exactly ${version}.`,
        });
      }
      if (!locked || !/^sha512-[A-Za-z0-9+/=]+$/.test(String(locked.integrity || ''))) {
        findings.push({
          rule: 'pom_js_dependency_lock_integrity_missing',
          dependency: name,
          message: `${name} must have sha512 integrity in package-lock.json.`,
        });
      }
    }
  }
  return { ok: findings.length === 0, pkg, lock, findings };
}

function playwrightPomJsTemplateContract() {
  const packageSource = readPlaywrightPomJsTemplateFile(PLAYWRIGHT_POM_JS_PACKAGE_PATH);
  const lockSource = readPlaywrightPomJsTemplateFile(PLAYWRIGHT_POM_JS_LOCK_PATH);
  const inspection = inspectPlaywrightPomJsPackageContract({ packageSource, lockSource });
  if (!inspection.ok) {
    throw new Error(
      `QAAI Playwright POM JS package template is invalid: ${inspection.findings.map((finding) => finding.rule).join(', ')}`,
    );
  }
  return { packageSource, lockSource };
}

function pwPackageJson(adapterId) {
  if (adapterId === 'playwright-pom-js') return playwrightPomJsTemplateContract().packageSource;
  const pkg = {
    ...PW_PACKAGE_BASE,
    scripts: { ...PW_PACKAGE_BASE.scripts },
    devDependencies: { ...PW_PACKAGE_BASE.devDependencies },
  };
  if (adapterId === 'playwright-pom') {
    pkg.scripts.typecheck = 'tsc --noEmit -p tsconfig.json';
    pkg.devDependencies['@types/node'] = '^20.0.0';
    pkg.devDependencies.typescript = '^5.4.0';
  }
  return JSON.stringify(pkg, null, 2) + '\n';
}

function pwPomJsPackageLock() {
  return playwrightPomJsTemplateContract().lockSource;
}

function pwPomTsConfig() {
  return (
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'commonjs',
          moduleResolution: 'node',
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          skipLibCheck: true,
          resolveJsonModule: true,
          types: ['node'],
        },
        include: [
          'playwright.config.ts',
          'tests/**/*.ts',
          'pages/**/*.ts',
          'locators/**/*.ts',
          'fixtures/**/*.ts',
          'utils/**/*.ts',
        ],
        exclude: ['node_modules', 'test-results', 'playwright-report'],
      },
      null,
      2,
    ) + '\n'
  );
}

const PW_CONFIG = `import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

function loadQaaEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\\r?\\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Runtime/CI values (including GitHub secrets) are authoritative. The
    // bundled .env is only a local fallback and blank placeholders must never
    // erase a value supplied by the execution environment.
    if (!value) continue;
    if (process.env[key] != null && String(process.env[key]).trim() !== '') continue;
    process.env[key] = value;
  }
}

loadQaaEnv();

// QAAI ReplayIR export - generated ONLY from RunResult.replayIrJson.
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  // Serial + one retry. These specs can share live-site state (a case that
  // creates data a later case consumes) and demo environments degrade under
  // parallel load - running one-at-a-time with a retry removes the #1 cause of
  // "passes solo, fails in a batch" flakiness, which is NOT a code defect.
  workers: 1,
  retries: 1,
  // Non-blocking target reachability diagnostic. Chromium navigation remains
  // authoritative because Node and browser proxy/TLS policy can differ.
  globalSetup: './qaai.preflight.js',
  reporter: 'list',
  use: {
    baseURL: process.env.QAAI_TARGET_URL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
`;

function playwrightTestTimeoutMs(admitted = []) {
  let maximumAwaitCount = 0;
  for (const item of admitted || []) {
    const awaitCount = (String(item && item.content || '').match(/\bawait\b/g) || []).length;
    maximumAwaitCount = Math.max(maximumAwaitCount, awaitCount);
  }
  const derived = 60_000 + maximumAwaitCount * 2_500;
  return Math.min(600_000, Math.max(60_000, Math.ceil(derived / 10_000) * 10_000));
}

// Playwright globalSetup - diagnostic only. Node fetch reachability can differ
// from Chromium under corporate proxy/TLS policy, so it must never prevent the
// authored browser flow from running. CommonJS works in both TS and JS bundles.
const QAAI_PREFLIGHT_JS = `// QAAI preflight - non-blocking target reachability diagnostic.
// Browser navigation remains authoritative; this check never blocks test collection.
module.exports = async function globalSetup() {
  const url = process.env.QAAI_TARGET_URL;
  if (!url) {
    console.warn('QAAI preflight warning: QAAI_TARGET_URL is not set; the authored browser navigation will report the actual result.');
    return;
  }
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (res.status >= 500) {
      console.warn('QAAI preflight warning: target ' + url + ' returned HTTP ' + res.status + '; continuing with browser execution.');
    }
  } catch (err) {
    console.warn('QAAI preflight warning: Node could not reach ' + url + ' (' + (err && err.message) + '); continuing because Chromium navigation is authoritative.');
  }
};
`;

/** PURE. Assemble the runnable package: IR-agnostic shell + per-result specs. */
function playwrightConfig(
  storageStateRel = null,
  { preflightFile = './qaai.preflight.js', testTimeoutMs = 60_000 } = {},
) {
  let config = PW_CONFIG.replace(
    "globalSetup: './qaai.preflight.js'",
    `globalSetup: '${preflightFile}'`,
  );
  config = config.replace('timeout: 60_000', `timeout: ${testTimeoutMs}`);
  if (!storageStateRel) return config;
  const storageLine = `    // QAAI AuthProfile: every spec starts from the captured authenticated session.\n    storageState: ${JSON.stringify(storageStateRel)},\n    // The rest of the test still replays explicit ReplayIR actions; auth is only the hidden session precondition.\n`;
  return config.replace(
    '    baseURL: process.env.QAAI_TARGET_URL,\n',
    `    baseURL: process.env.QAAI_TARGET_URL,\n${storageLine}`,
  );
}

function isPomSharedExtraFile(rel) {
  const normalized = String(rel || '').replace(/\\/g, '/');
  if (/^locators\//.test(normalized)) return true;
  if (/^pages\/(?!EvaluateMethods\.)[^/]+\.(?:js|ts)$/.test(normalized)) return true;
  if (
    /^evidence\/(?:locator-manifest|locator-conflicts|certification-report|dom-atlas|pom-architect-report)\.json$/.test(
      normalized,
    )
  )
    return true;
  return false;
}

function isEvaluateMethodsFile(rel) {
  return /^pages\/EvaluateMethods\.(?:js|ts)$/.test(String(rel || '').replace(/\\/g, '/'));
}

function extractEvaluateMethods(content) {
  const text = String(content || '');
  const methods = [];
  const re =
    /\n  async\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*Promise<void>)?\s*\{[\s\S]*?\n  \}/g;
  let m;
  while ((m = re.exec(text))) {
    methods.push({ name: m[1], body: m[0].trimStart() });
  }
  return methods;
}

function mergeEvaluateMethodsFiles(entries, { lang = 'ts', moduleFormat = 'esm' } = {}) {
  if (!Array.isArray(entries) || !entries.length) return null;
  const cjs = lang === 'js' && moduleFormat === 'cjs';
  const methodsByName = new Map();
  for (const entry of entries) {
    for (const method of extractEvaluateMethods(entry && entry.content)) {
      if (!methodsByName.has(method.name)) methodsByName.set(method.name, method.body);
    }
  }
  const methods = [...methodsByName.values()];
  if (!methods.length) return null;
  const body = methods.join('\n\n');
  const needsAssertText = /\bassertTextPresent\s*\(/.test(body);
  const needsEvalSettled = /\bevaluateSettled\s*\(/.test(body);
  const helperImportParts = [
    needsAssertText && 'assertTextPresent',
    needsEvalSettled && 'evaluateSettled',
  ]
    .filter(Boolean)
    .join(', ');
  const jsImportExt = lang === 'js' && moduleFormat !== 'cjs' ? '.js' : '';
  const helperImport = helperImportParts
    ? cjs
      ? `const { ${helperImportParts} } = require('../tests/support/replayir');\n`
      : `import { ${helperImportParts} } from '../tests/support/replayir${jsImportExt}';\n`
    : '';
  const pageImport = lang === 'js' ? '' : `import { type Page } from '@playwright/test';\n`;
  const expectImport = cjs
    ? `const { expect } = require('@playwright/test');\n`
    : `import { expect } from '@playwright/test';\n`;
  const ctor =
    lang === 'js'
      ? `  constructor(page) { this.page = page; }`
      : `  constructor(private readonly page: Page) {}`;
  const classLine = `${cjs ? 'class' : 'export class'} EvaluateMethods`;
  const exportLine = cjs ? `\nmodule.exports = { EvaluateMethods };\n` : '\n';
  return `${pageImport}${expectImport}${helperImport}\n${classLine} {\n${ctor}\n\n${body}\n}${exportLine}`;
}

function assemblePackage({
  adapterId,
  adapterVersion = null,
  admitted,
  envVars,
  authState = null,
  targetUrl = '',
  envDefaults = {},
}) {
  const files = {};
  const isPom = POM_ADAPTER_IDS.has(adapterId);
  const isPomJs = adapterId === 'playwright-pom-js';
  const useCjs = CJS_SUPPORT_ADAPTER_IDS.has(adapterId);
  const resolvedEnvDefaults = {
    ...(envDefaults || {}),
    QAAI_TARGET_URL: normalizeTargetOrigin(targetUrl),
  };
  if (PLAYWRIGHT_ADAPTER_IDS.has(adapterId)) {
    const preflightFile = isPomJs ? 'qaai.preflight.cjs' : 'qaai.preflight.js';
    files['package.json'] = pwPackageJson(adapterId);
    if (isPomJs) files['package-lock.json'] = pwPomJsPackageLock();
    if (adapterId === 'playwright-pom') files['tsconfig.json'] = pwPomTsConfig();
    files['playwright.config.ts'] = playwrightConfig(authState && authState.storageStateRel, {
      preflightFile: `./${preflightFile}`,
      testTimeoutMs: playwrightTestTimeoutMs(admitted),
    });
    Object.assign(files, (authState && authState.files) || {});
    // POM adapters always emit `import` syntax (ES module) regardless of lang.
    // Only the plain reference-js adapter (which emits `require()` in specs) ships the CJS file.
    if (isPomJs) {
      Object.assign(files, playwrightReference.supportFilesJsEsm());
    } else {
      const _adapterMod = useCjs ? playwrightReference.playwrightReferenceJs : playwrightReference;
      Object.assign(
        files,
        typeof _adapterMod.supportFiles === 'function' ? _adapterMod.supportFiles() : {},
      );
    }
    // The sanitizer rewrites `.click()` → clickFirstVisible(...) and injects an
    // `import { clickFirstVisible, safeClick, safeGoto } from '…/utils/test-helpers'`
    // into every spec. Ship that helper in the matching module style, or
    // `npx playwright test` fails at collection with "Cannot find module
    // '../utils/test-helpers'" — the bundle would not be runnable out of the box.
    // Preflight is a non-blocking Node reachability diagnostic. Browser
    // navigation remains authoritative because proxy/TLS policy can differ.
    files[preflightFile] = QAAI_PREFLIGHT_JS;
    files['.env'] = envFile(envVars, resolvedEnvDefaults);
    files['.env.example'] = envFile(envVars, {});
    files['README.md'] = isPom
      ? `# QAAI ReplayIR export (Playwright POM)\n\nGenerated ONLY from each RunResult's pinned replayIrJson - no AI-written code, no case-text regen.\n\n**3-layer structure:**\n- \`locators/\` - action-time locators (exact evidence from live MCP run)\n- \`pages/\` - action-method classes (1:1 with recorded acts)\n- \`tests/\` - journey specs calling page methods (zero inline selectors)\n\n1. \`${isPomJs ? 'npm ci' : 'npm install'}\`\n2. Review the generated \`.env\`; QAAI populates authorized credentials when supplied. \`.env.example\` documents keys only.\n3. \`npx playwright test\`\n\nTo customize a locator: create the corresponding file under \`locators/overrides/\`, then edit the non-overwritten \`locators/<page>.locators.*\` shim to re-export that override. Overrides are recorded as non-certified in \`EXPORT_MANIFEST.json\`.\n`
      : `# QAAI ReplayIR generated script bundle (Playwright)\n\nGenerated from canonical ReplayIR and the authored test contract through the selected Playwright adapter.\n\n1. \`npm install\`\n2. Review the generated \`.env\`; QAAI populates authorized credentials when supplied. \`.env.example\` documents keys only.\n3. \`npx playwright test\`\n\nThe Playwright config loads \`.env\` automatically from this package folder.\n\n**Source-run diagnostics:** EXPORT_MANIFEST.json records the original verdict and evidence health. Generated tests remain enabled for \`blocked\`, \`needs_human\`, failed, and incomplete source runs. Actions without exact action-time locator evidence remain visible as non-executable diagnostics and are never converted into guessed runnable selectors.\n`;
  }
  const pomGraphs = [];
  const evaluateMethodFiles = [];
  for (const a of admitted) {
    files[a.filePath] = a.content;
    if (isPom && a.pomGraph) pomGraphs.push(a.pomGraph);
    // POM adapter emits shared locators/pages/evidence per journey for compatibility.
    // The final package must render those shared files once from the merged graph; a
    // blind Object.assign here can overwrite ProductsPage.js with a partial scenario.
    if (a.extraFiles) {
      for (const [rel, content] of Object.entries(a.extraFiles)) {
        if (isPom && isEvaluateMethodsFile(rel)) {
          evaluateMethodFiles.push({ rel, content });
          continue;
        }
        if (isPom && a.pomGraph && isPomSharedExtraFile(rel)) continue;
        files[rel] = content;
      }
    }
  }
  if (
    isPom &&
    pomGraphs.length &&
    typeof playwrightPom._mergePomGraphs === 'function' &&
    typeof playwrightPom._emitPomGraphFiles === 'function'
  ) {
    const mergedGraph = playwrightPom._mergePomGraphs(pomGraphs, {
      lang: isPomJs ? 'js' : 'ts',
      moduleFormat: 'esm',
    });
    Object.assign(files, playwrightPom._emitPomGraphFiles(mergedGraph));
  }
  if (isPom && evaluateMethodFiles.length) {
    const fe = isPomJs ? '.js' : '.ts';
    const mergedEvaluateMethods = mergeEvaluateMethodsFiles(evaluateMethodFiles, {
      lang: isPomJs ? 'js' : 'ts',
      moduleFormat: 'esm',
    });
    if (mergedEvaluateMethods) files[`pages/EvaluateMethods${fe}`] = mergedEvaluateMethods;
  }
  const hardenedFiles = scriptValidationRunner.hardenPlaywrightPackageFiles(files, {
    framework: adapterId,
  });
  // Package hardening may infer dependency versions from the QAAI server
  // checkout. Generated packages must instead retain the selected renderer's
  // own reproducible dependency contract.
  ensurePackageJsonForAdapter(adapterId, hardenedFiles);
  hardenedFiles['evidence/output-activation-receipt.json'] =
    JSON.stringify(
      buildOutputActivationReceipt({
        adapterId,
        adapterVersion,
        scriptArtifacts: (admitted || []).map((entry) => entry && entry.filePath),
        allBlocked: false,
      }),
      null,
      2,
    ) + '\n';
  return hardenedFiles;
}

/** PURE. Defense-in-depth secret scan (#9). Synthetic non-secret literals are allowed. */
function buildExecutedCaseAstEvidence({ results = [], generationId = null } = {}) {
  const files = {};
  const findings = [];
  const entries = [];
  const usedPaths = new Set();
  for (const [index, result] of (results || []).entries()) {
    const executionContract = (result && result.executionContract) || null;
    const actionGraph = (result && result.actionGraph) || null;
    if (!executionContract && !actionGraph) {
      entries.push({
        runResultId: (result && result.runResultId) || null,
        testCaseId: (result && result.testCaseId) || null,
        status: 'not_available',
        reason: 'execution_contract_missing',
      });
      findings.push({
        rule: 'executed_case_ast_source_missing',
        severity: 'warning',
        runResultId: (result && result.runResultId) || null,
        testCaseId: (result && result.testCaseId) || null,
        message:
          'Legacy result has no execution contract/action graph, so ExecutedCaseASTV1 evidence is unavailable.',
      });
      continue;
    }
    const ast = (result && result.executedCaseAst) || executableTestContract.buildExecutedCaseAstV1({
      executionContract,
      caseInstance: (executionContract && executionContract.caseInstanceV1) || null,
      actionGraph,
      replayEnvelope: (result && result.envelope) || null,
      stepResults: (result && result.stepResults) || [],
      runResult: result,
      runResultId: (result && result.runResultId) || null,
      testCaseId: (result && result.testCaseId) || null,
      caseName: (result && result.caseName) || null,
      generationId: (executionContract && executionContract.generationId) || generationId || null,
      status: (result && result.status) || null,
    });
    const validation = ast.validation && typeof ast.validation.valid === 'boolean'
      ? ast.validation
      : executableTestContract.validateExecutedCaseAstV1(ast);
    ast.validation = validation;
    const stem = slug(
      `${(result && result.caseName) || 'case'}-${(result && result.runResultId) || index + 1}`,
      `case-${index + 1}`,
    );
    let file = `evidence/executed-case-asts/${stem}.json`;
    let suffix = 2;
    while (usedPaths.has(file)) file = `evidence/executed-case-asts/${stem}-${suffix++}.json`;
    usedPaths.add(file);
    const content = JSON.stringify(ast, null, 2) + '\n';
    files[file] = content;
    entries.push({
      runResultId: (result && result.runResultId) || null,
      testCaseId: (result && result.testCaseId) || null,
      astId: ast.astId,
      file,
      sha256: sha256(content),
      status: validation.valid ? 'validated' : 'invalid',
      enabled: ast.case && ast.case.enabled === true,
      expectedVerdict: (ast.case && ast.case.expectedVerdict) || null,
      nodeCount: Array.isArray(ast.nodes) ? ast.nodes.length : 0,
      actionCount: (validation.summary && validation.summary.actions) || 0,
      assertionCount: (validation.summary && validation.summary.assertions) || 0,
      enabledProductFailures:
        (validation.summary && validation.summary.enabledProductFailures) || 0,
      rendererTargets: ['playwright-pom-js', 'playwright-pom'],
    });
    if (!validation.valid) {
      findings.push(
        ...validation.findings.map((finding) => ({
          ...downgradeAdvisoryLocatorFinding(finding),
          runResultId: (result && result.runResultId) || null,
          testCaseId: (result && result.testCaseId) || null,
          astId: ast.astId,
          path: finding.path || file,
        })),
      );
    }
  }
  const validated = entries.filter((entry) => entry.status === 'validated');
  const invalid = entries.filter((entry) => entry.status === 'invalid');
  const inventory = {
    schema: 'qaai-executed-case-ast-inventory/1',
    generationId: generationId || null,
    caseCount: entries.length,
    astCount: entries.filter((entry) => entry.astId).length,
    validatedCount: validated.length,
    invalidCount: invalid.length,
    enabledTestCount: entries.filter((entry) => entry.enabled).length,
    enabledProductFailureCount: entries.reduce(
      (sum, entry) => sum + Number(entry.enabledProductFailures || 0),
      0,
    ),
    sharedRendererContract: {
      javascript: 'playwright-pom-js',
      typescript: 'playwright-pom',
      source: 'ExecutedCaseASTV1',
      secondConductorRunRequired: false,
    },
    entries,
  };
  files['evidence/executed-case-ast-inventory.json'] = JSON.stringify(inventory, null, 2) + '\n';
  return { files, findings, inventory, astsValid: invalid.length === 0 };
}

function buildImmutableBundleEvidence(files, { adapterId = null, astInventory = null } = {}) {
  const payload = Object.keys(files || {})
    .filter((file) => file !== 'EXPORT_MANIFEST.json'
      && file !== 'evidence/bundle-integrity.json'
      && file !== 'evidence/live-output-status.json')
    .sort()
    .map((file) => {
      const content = files[file];
      const bytes = Buffer.isBuffer(content)
        ? content.length
        : Buffer.byteLength(String(content || ''), 'utf8');
      return { file, sha256: sha256(content), bytes };
    });
  const bundleId = `bundle_${sha256(stableStringify({ adapterId, payload })).slice(0, 24)}`;
  return {
    schema: 'qaai-immutable-output-bundle/1',
    bundleId,
    adapterId: adapterId || null,
    hashAlgorithm: 'sha256',
    hashScope: 'immutable package files; excludes EXPORT_MANIFEST.json, evidence/bundle-integrity.json, and dynamic evidence/live-output-status.json',
    fileCount: payload.length,
    fileHashes: Object.fromEntries(payload.map((entry) => [entry.file, entry.sha256])),
    files: payload,
    executedCaseAstIds: (astInventory && Array.isArray(astInventory.entries)
      ? astInventory.entries
      : []
    )
      .map((entry) => entry && entry.astId)
      .filter(Boolean),
  };
}

function scanSecrets(files, denyLiterals = []) {
  const findings = [];
  for (const [rel, content] of Object.entries(files || {})) {
    if (Buffer.isBuffer(content)) continue;
    const text = String(content || '');
    text.split(/\r?\n/).forEach((line, i) => {
      if (lineContainsSecretLiteralAssignment(line))
        findings.push({
          rule: 'secret_literal_in_output',
          severity: 'error',
          path: rel,
          line: i + 1,
          message: `Secret-keyed field assigned a string literal in ${rel}:${i + 1}.`,
        });
    });
    for (const lit of denyLiterals) {
      if (lit && text.includes(lit))
        findings.push({
          rule: 'known_secret_literal',
          severity: 'error',
          path: rel,
          message: `Known secret literal "${lit}" appears in ${rel}.`,
        });
    }
  }
  return findings;
}

function redactSecretLiteralsInFiles(files, denyLiterals = []) {
  const redacted = { ...(files || {}) };
  const deny = [...new Set((denyLiterals || []).filter(Boolean).map((value) => String(value)))];
  const assignment = /((?:^\s*|[{,]\s*|\b(?:const|let|var)\s+|\.\s*)["']?(passwo?r?d|passwd|pwd|secret|token|apikey|api_key|otp|mfa|credential)\b["']?\s*[:=]\s*)(["'])([^"']+)\3/gi;
  for (const [rel, content] of Object.entries(redacted)) {
    if (Buffer.isBuffer(content)) continue;
    const isJson = /\.json$/i.test(rel);
    let text = String(content || '');
    for (const literal of deny) text = text.split(literal).join('__QAAI_REDACTED__');
    text = text
      .split(/\r?\n/)
      .map((line) => line.replace(assignment, (_match, prefix, key, quote) => {
        if (isJson) return `${prefix}${quote}__QAAI_REDACTED__${quote}`;
        const envName = `QAAI_${String(key).replace(/[^a-z0-9]+/gi, '_').toUpperCase()}`;
        return `${prefix}process.env.${envName}`;
      }))
      .join('\n');
    redacted[rel] = text;
  }
  return redacted;
}

/** PURE. The stable EXPORT_MANIFEST.json (#5). */
function buildManifest({
  projectId,
  runId,
  adapterId,
  adapterVersion,
  manifestEntries,
  validation,
  allBlocked,
}) {
  return {
    schema: 'qaai-replayir-export/1',
    generatedAt: new Date().toISOString(),
    projectId: projectId || null,
    runId: runId || null,
    adapterId: adapterId || null,
    adapterVersion: adapterVersion || null,
    allBlocked: !!allBlocked,
    packagePassed: validation ? !!validation.packagePassed : null,
    entries: manifestEntries,
    validation: validation
      ? {
          packagePassed: validation.packagePassed,
          checked: validation.checked,
          skipped: validation.skipped,
          errorCount: validation.errorCount,
          warningCount: validation.warningCount,
          findings: validation.findings,
          commands: validation.commands,
          repaired: !!validation.repaired,
          repairAttempts: validation.repairAttempts || 0,
          repairs: validation.repairs || [],
        }
      : null,
  };
}

function refreshManifestEntryFileHashes(manifestEntries, files) {
  const missingFiles = [];
  let hashedFileCount = 0;
  const entries = (manifestEntries || []).map((entry) => {
    const declaredFiles = [
      ...new Set([
        ...(Array.isArray(entry && entry.files) ? entry.files : []),
        ...Object.keys((entry && entry.fileHashes) || {}),
      ].filter(Boolean)),
    ];
    const fileHashes = {};
    for (const file of declaredFiles) {
      if (!Object.prototype.hasOwnProperty.call(files || {}, file)) {
        missingFiles.push({
          runResultId: (entry && entry.runResultId) || null,
          testCaseId: (entry && entry.testCaseId) || null,
          file,
        });
        continue;
      }
      fileHashes[file] = sha256(files[file]);
      hashedFileCount += 1;
    }
    return {
      ...entry,
      fileHashes,
      fileHashSource: 'final-package-bytes',
    };
  });
  return {
    entries,
    summary: {
      schema: 'qaai-manifest-source-hash-parity/1',
      verified: missingFiles.length === 0,
      entryCount: entries.length,
      hashedFileCount,
      missingFileCount: missingFiles.length,
      missingFiles,
    },
  };
}

function buildOutputActivationReceipt({
  adapterId,
  adapterVersion,
  scriptArtifacts,
  allBlocked,
}) {
  const artifacts = [...new Set((scriptArtifacts || []).filter(Boolean))].sort();
  return {
    schema: 'qaai-output-activation-receipt/1',
    active: true,
    selectedFramework: {
      adapterId: adapterId || null,
      adapterVersion: adapterVersion || null,
    },
    compilerChain: {
      canonicalIr: 'ExecutableCaseIR',
      replayProjection: 'prepareReplayIrForExport',
      frameworkCompilation: 'selected-framework-adapter',
      packageBoundary: 'buildReplayExport',
    },
    evidencePolicy: {
      executableActionsRequirePositiveExecution: true,
      executableLocatorsRequireExactNodeVerification: true,
      narrativeLocatorGuessingAllowed: false,
      authoredOnlyIntentIsDiagnostic: true,
    },
    output: {
      artifactCount: artifacts.length,
      artifacts,
      outputAvailable: artifacts.length > 0,
      sourceRunCompletelyBlocked: !!allBlocked,
    },
  };
}

function rowCoordinateForResult(result) {
  if (!result) return null;
  const index = result.dataRowIndex == null ? null : Number(result.dataRowIndex);
  if (index == null || !Number.isFinite(index)) return null;
  const label =
    String(result.dataRowLabel || `row_${index}`)
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || `row_${index}`;
  return `${label}_${index}`;
}

function actionNeedsLocator(action) {
  return [
    'click',
    'doubleclick',
    'tripleclick',
    'fill',
    'type',
    'selectoption',
    'check',
    'uncheck',
    'press',
    'hover',
    'upload',
    'drag',
  ].includes(String(action || '').toLowerCase());
}

function valueBindingKind(step) {
  const ref = String((step && step.valueRef) || '');
  if (/^data:/i.test(ref) || (step && step.dataRole)) return 'data';
  if (/^env:/i.test(ref)) return 'env';
  if (/^(vault|fixture|masked):/i.test(ref)) return 'runtime_secret';
  if (step && step.rawValue != null) return 'literal';
  return ref ? 'unknown_ref' : 'none';
}

function locatorExpressionOf(locator) {
  const primary = actionLocatorResolver.primaryActionLocator(locator);
  return (primary && (primary.frameworkExpressions?.playwright || primary.expression)) || null;
}

function exportSafeActionLocatorForStep(step, resolveByAs) {
  if (replayLocatorContract.isVerifiedActionLocator(step && step.actionLocator))
    return step.actionLocator;
  const resolved = step && step.target ? resolveByAs.get(step.target) : null;
  if (resolved && replayLocatorContract.isVerifiedActionLocator(resolved.actionLocator))
    return resolved.actionLocator;
  return null;
}

function buildActionAuthoringLedger({ results }) {
  const records = [];
  for (const result of results || []) {
    const ir = result && result.envelope && result.envelope.ir;
    const steps = Array.isArray(ir && ir.steps) ? ir.steps : [];
    const resolveByAs = new Map();
    steps.forEach((step, index) => {
      if (step && step.op === 'resolve' && step.as)
        resolveByAs.set(step.as, { ...step, stepIndex: index });
    });
    for (const [index, step] of steps.entries()) {
      if (!step || step.op !== 'act') continue;
      const resolveStep = step.target ? resolveByAs.get(step.target) : null;
      const ownedLocator = replayLocatorContract.isVerifiedActionLocator(step.actionLocator)
        ? step.actionLocator
        : null;
      const locator = exportSafeActionLocatorForStep(step, resolveByAs);
      const hasVerifiedActionLocator = !!(
        locator && replayLocatorContract.isVerifiedActionLocator(locator)
      );
      const locatorRecipeId =
        step.locatorRecipeId || (resolveStep && resolveStep.locatorRecipeId) || null;
      const stepIntentHash = step.stepIntentHash || null;
      const rowCoordinateId = rowCoordinateForResult(result);
      const keyParts = [
        result.testCaseId || 'unknown_case',
        step.stepAuthoringId || `step_${index + 1}`,
        stepIntentHash || 'no_intent_hash',
        rowCoordinateId || 'static',
        step.action || 'act',
        locatorRecipeId || 'no_locator_recipe',
      ];
      records.push({
        matrixKey: keyParts.join('::'),
        runResultId: result.runResultId || null,
        testCaseId: result.testCaseId || null,
        caseName: result.caseName || null,
        stepIndex: index,
        plannedStepId: step.stepAuthoringId || null,
        stepIntentHash,
        rowCoordinateId,
        actionType: step.action || null,
        target: step.target || null,
        locatorRecipeId,
        needsLocator: actionNeedsLocator(step.action),
        actionOwnsVerifiedLocator: !!(
          ownedLocator && replayLocatorContract.isVerifiedActionLocator(ownedLocator)
        ),
        actionOwnsExportSafeLocator: !!ownedLocator,
        hasVerifiedActionLocator,
        hasExportSafeActionLocator: !!locator,
        locatorExpression: locatorExpressionOf(locator),
        locatorSource:
          (locator &&
            (locator.verificationSource || locator.evidenceSource || locator.proof?.source)) ||
          null,
        usesGuessedLocator: false,
        valueBinding: valueBindingKind(step),
        transitionProof: step.transitionProof || null,
      });
    }
  }
  const missing = records.filter(
    (record) => record.needsLocator && !record.hasExportSafeActionLocator,
  );
  return {
    schema: 'qaai-action-authoring-ledger/1',
    summary: {
      actionCount: records.length,
      locatorNeedingActionCount: records.filter((r) => r.needsLocator).length,
      missingVerifiedLocatorCount: records.filter(
        (r) => r.needsLocator && !r.hasVerifiedActionLocator,
      ).length,
      missingExportSafeLocatorCount: missing.length,
    },
    findings: missing.map((record) => ({
      rule: 'action_ledger_missing_verified_locator',
      category: 'platform_evidence_integrity_failure',
      severity: 'warning',
      nonBlocking: true,
      runResultId: record.runResultId,
      testCaseId: record.testCaseId,
      stepIndex: record.stepIndex,
      message: `Action ${record.actionType || 'act'} in ${record.caseName || record.testCaseId || 'unknown case'} has no exact-node verified action-owned locator.`,
    })),
    records,
  };
}

function countPlaywrightTestsInFiles(files) {
  let count = 0;
  for (const [rel, content] of Object.entries(files || {})) {
    if (!/^tests\/.+\.spec\.(?:js|ts)$/.test(rel)) continue;
    const text = String(content || '');
    const dataVars = new Map();
    let m;
    const loadRe = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*loadDataRows\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = loadRe.exec(text))) {
      const rows = readDataRowsFile(files, m[2]);
      dataVars.set(m[1], Array.isArray(rows) && rows.length ? rows.length : 1);
    }
    const loopRe = /for\s*\(\s*const\s+row\s+of\s+([A-Za-z_$][\w$]*)\s*\)\s*\{[\s\S]*?\btest\s*\(/g;
    const loopRanges = [];
    while ((m = loopRe.exec(text))) {
      count += dataVars.get(m[1]) || 1;
      loopRanges.push([m.index, loopRe.lastIndex]);
    }
    const stripped = loopRanges.reduceRight(
      (acc, [start, end]) => acc.slice(0, start) + acc.slice(end),
      text,
    );
    count += (stripped.match(/\btest\s*\(/g) || []).length;
  }
  return count;
}

function buildCardinalityContractFindings({ results, files }) {
  const expected = (results || []).filter(
    (r) =>
      r && !['blocked', 'needs_human', 'skipped'].includes(String(r.status || '').toLowerCase()),
  ).length;
  const generated = countPlaywrightTestsInFiles(files);
  if (expected !== generated) {
    return [
      {
        rule: 'step_cardinality_contract_mismatch',
        severity: 'error',
        expectedTestCount: expected,
        generatedPlaywrightTestCount: generated,
        message: `QAAI live executable result count is ${expected}, but the generated Playwright package exposes ${generated} test() entries. Output preparation must repair missing/extra generated tests before download.`,
      },
    ];
  }
  return [];
}

function buildValueBindingMap({ files }) {
  const entries = [];
  for (const [rel, content] of Object.entries(files || {})) {
    if (!/\.(?:js|ts|cjs|mjs)$/.test(rel)) continue;
    const text = String(content || '');
    let m;
    const loadRe = /\bloadDataRows\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = loadRe.exec(text)))
      entries.push({ file: rel, line: sourceLineOf(text, m.index), kind: 'data_file', path: m[1] });
    const readDataRe = /\breadData\(\s*row\s*,\s*['"]([^'"]+)['"]/g;
    while ((m = readDataRe.exec(text)))
      entries.push({
        file: rel,
        line: sourceLineOf(text, m.index),
        kind: 'data_column',
        key: m[1],
      });
    const readEnvRe = /\breadEnv\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = readEnvRe.exec(text)))
      entries.push({ file: rel, line: sourceLineOf(text, m.index), kind: 'env_var', key: m[1] });
  }
  return {
    schema: 'qaai-value-binding-map/1',
    summary: {
      entries: entries.length,
      dataColumns: entries.filter((e) => e.kind === 'data_column').length,
      envVars: entries.filter((e) => e.kind === 'env_var').length,
    },
    entries,
  };
}

function buildArtifactGraph({ files, adapterId }) {
  const specs = [];
  const pages = [];
  const locators = [];
  for (const [rel, content] of Object.entries(files || {})) {
    const text = String(content || '');
    if (/^tests\/.+\.spec\.(?:js|ts)$/.test(rel)) {
      const calls = [];
      const callRe = /\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g;
      let m;
      while ((m = callRe.exec(text))) {
        if (['test', 'expect', 'page'].includes(m[1])) continue;
        calls.push({ object: m[1], method: m[2], line: sourceLineOf(text, m.index) });
      }
      specs.push({
        file: rel,
        testCount: countPlaywrightTestsInFiles({
          [rel]: content,
          ...Object.fromEntries(
            Object.entries(files || {}).filter(([p]) => /^tests\/data\//.test(p)),
          ),
        }),
        calls,
      });
    } else if (/^pages\/.+\.(?:js|ts)$/.test(rel)) {
      pages.push({ file: rel, methods: [...parseClassMethodNames(text)].sort() });
    } else if (/^locators\/generated\/.+\.generated\.locators\.(?:js|ts)$/.test(rel)) {
      locators.push({ file: rel, keys: [...parseGeneratedLocatorKeys(text)].sort() });
    }
  }
  return {
    schema: 'qaai-output-artifact-graph/1',
    adapterId,
    summary: {
      specs: specs.length,
      pages: pages.length,
      locatorFiles: locators.length,
      generatedPlaywrightTests: countPlaywrightTestsInFiles(files),
    },
    specs,
    pages,
    locators,
  };
}

function normalizeRunArtifactKind(row, fallback = 'TRACE') {
  const raw = String(
    row?.artifactKind ||
      row?.kind ||
      row?.type ||
      row?.mediaType ||
      row?.mimeType ||
      fallback ||
      '',
  ).toLowerCase();
  if (/video|webm|mp4|screencast/.test(raw)) return 'RUN_VIDEO';
  if (/assert/.test(raw) && /screen|image|png|jpeg|jpg/.test(raw))
    return 'ASSERTION_SCREENSHOT';
  if (/fail|error/.test(raw) && /screen|image|png|jpeg|jpg/.test(raw))
    return 'FAILURE_SCREENSHOT';
  if (/final/.test(raw) && /screen|image|png|jpeg|jpg/.test(raw))
    return 'FINAL_STATE_SCREENSHOT';
  if (/screen|image|png|jpeg|jpg/.test(raw)) return 'STEP_SCREENSHOT';
  if (/trace|zip/.test(raw)) return 'TRACE';
  return String(fallback || 'TRACE').toUpperCase();
}

function normalizeArtifactCaptureStatus(row, hasPointer) {
  const raw = String(row?.captureStatus || row?.status || row?.state || '').toLowerCase();
  if (/ready|complete|completed|captured|saved|success/.test(raw)) return 'READY';
  if (/capturing|processing|uploading|finalizing/.test(raw)) return 'FINALIZING';
  if (/pending|queued/.test(raw)) return 'PENDING';
  if (/unavailable|degraded|failed|error|missing|skipped/.test(raw)) return 'DEGRADED';
  return hasPointer ? 'READY' : 'DEGRADED';
}

function artifactPointer(row) {
  for (const key of [
    'storageKey',
    'path',
    'relPath',
    'artifactPath',
    'tracePath',
    'screenshotPath',
    'videoPath',
    'artifactRef',
    'screenshotRef',
    'url',
  ]) {
    const value = row && row[key];
    if (typeof value === 'string' && value.trim()) return { key, value: value.trim() };
  }
  return null;
}

function buildRunArtifactPlane({ results } = {}) {
  const artifacts = [];
  const seen = new Set();
  const add = (result, row, fallbackKind, phase) => {
    if (!result || !row || typeof row !== 'object') return;
    const pointer = artifactPointer(row);
    const kind = normalizeRunArtifactKind(row, fallbackKind);
    const captureStatus = normalizeArtifactCaptureStatus(row, !!pointer);
    const key = JSON.stringify([
      result.runResultId || null,
      row.id || row.operationId || row.actionOccurrenceId || row.assertionId || null,
      kind,
      pointer?.value || null,
      phase || null,
    ]);
    if (seen.has(key)) return;
    seen.add(key);
    artifacts.push({
      runId: result.runId || null,
      runResultId: result.runResultId || null,
      testCaseId: result.testCaseId || null,
      operationId: row.operationId || row.stepId || row.contractStepId || null,
      actionOccurrenceId: row.actionOccurrenceId || row.occurrenceKey || null,
      assertionId: row.assertionId || row.contractRef || null,
      artifactKind: kind,
      phase: phase || null,
      timestamp: row.timestamp || row.createdAt || row.updatedAt || null,
      storageKey: pointer && pointer.key === 'storageKey' ? pointer.value : null,
      path: pointer && pointer.key !== 'storageKey' ? pointer.value : null,
      mimeType: row.mimeType || null,
      byteSize: row.byteSize == null ? null : Number(row.byteSize),
      sha256: row.sha256 || row.hash || null,
      captureStatus,
      captureError: row.captureError || row.error || row.reason || null,
      passive: true,
      affectsExecution: false,
      affectsVerdict: false,
      affectsOutputVisibility: false,
    });
  };
  for (const result of results || []) {
    const evidence = result?.captureFirstEvidence || {};
    for (const row of evidence.traceArtifacts || []) add(result, row, 'TRACE', 'run_trace');
    for (const row of evidence.actionEvidences || []) {
      add(result, row, 'STEP_SCREENSHOT', 'action_evidence');
    }
    for (const row of evidence.assertionEvidences || []) {
      add(result, row, 'ASSERTION_SCREENSHOT', 'assertion_evidence');
    }
    for (const row of evidence.navigationEvidences || []) {
      add(result, row, 'FINAL_STATE_SCREENSHOT', 'navigation_evidence');
    }
  }
  const countsByStatus = artifacts.reduce((acc, artifact) => {
    acc[artifact.captureStatus] = (acc[artifact.captureStatus] || 0) + 1;
    return acc;
  }, {});
  const countsByKind = artifacts.reduce((acc, artifact) => {
    acc[artifact.artifactKind] = (acc[artifact.artifactKind] || 0) + 1;
    return acc;
  }, {});
  return {
    schema: 'qaai-run-artifact-plane/1',
    authority: 'passive_observer',
    executionAuthority: false,
    verdictAuthority: false,
    outputVisibilityAuthority: false,
    invariants: [
      'Artifact capture must not click, fill, select, retry, heal, or release browser steps.',
      'Artifact absence is represented as DEGRADED metadata and must not change source run verdicts.',
      'Output Files must remain visible even when media, screenshots, traces, or certification are unavailable.',
    ],
    states: ['PENDING', 'CAPTURING', 'FINALIZING', 'READY', 'DEGRADED'],
    summary: {
      total: artifacts.length,
      byStatus: countsByStatus,
      byKind: countsByKind,
      degraded: countsByStatus.DEGRADED || 0,
      ready: countsByStatus.READY || 0,
    },
    artifacts,
  };
}

function buildTraceabilityMatrix({
  results,
  admitted,
  blocked,
  files,
  actionLedger,
  validation,
  targetUrl,
}) {
  const admittedByResult = new Map();
  for (const item of admitted || []) {
    for (const id of item.runResultIds || []) admittedByResult.set(id, item);
  }
  const blockedByResult = new Map();
  for (const item of blocked || []) blockedByResult.set(item.runResultId, item);
  const actionsByResult = new Map();
  for (const record of (actionLedger && actionLedger.records) || []) {
    if (!actionsByResult.has(record.runResultId)) actionsByResult.set(record.runResultId, []);
    actionsByResult.get(record.runResultId).push(record);
  }
  const entries = (results || []).map((result) => {
    const admittedItem = admittedByResult.get(result.runResultId) || null;
    const blockedItem = blockedByResult.get(result.runResultId) || null;
    const specFile = (admittedItem && admittedItem.filePath) || null;
    const specText =
      specFile && files && typeof files[specFile] === 'string' ? files[specFile] : '';
    const name = result.caseName || result.testCaseId || '';
    const line =
      specText && name ? sourceLineOf(specText, Math.max(0, specText.indexOf(name))) : null;
    const irSteps = Array.isArray(result.envelope && result.envelope.ir && result.envelope.ir.steps)
      ? result.envelope.ir.steps
      : [];
    return {
      requirementRefs: Array.isArray(result.requirementRefs) ? result.requirementRefs : [],
      userStory:
        Array.isArray(result.requirementRefs) && result.requirementRefs.length
          ? result.requirementRefs.join(', ')
          : null,
      testCaseId: result.testCaseId || null,
      testCaseName: result.caseName || null,
      runResultId: result.runResultId || null,
      dataRow: {
        index: result.dataRowIndex == null ? null : Number(result.dataRowIndex),
        label: result.dataRowLabel || null,
        rowCoordinateId: rowCoordinateForResult(result),
      },
      websiteVerdict: result.status || null,
      outputReadiness: admittedItem ? 'admitted' : 'repair_required',
      blockReason: (blockedItem && (blockedItem.code || blockedItem.detail)) || null,
      spec: specFile ? { file: specFile, line } : null,
      liveActions: actionsByResult.get(result.runResultId) || [],
      authoredSteps: buildAuthoredRuntimeTraceability(result),
      assertions: irSteps
        .map((step, index) =>
          step && step.op === 'assert'
            ? {
                stepIndex: index,
                contractRef: step.contractRef || step.id || null,
                channel: step.channel || null,
                expected: step.expected != null ? String(step.expected) : null,
                liveOutcome: step.liveOutcome || null,
              }
            : null,
        )
        .filter(Boolean),
    };
  });
  return {
    schema: 'qaai-traceability-matrix/1',
    targetUrl: normalizeTargetOrigin(targetUrl),
    certification: validation
      ? {
          packagePassed: validation.packagePassed,
          skipped: validation.skipped,
          errorCount: validation.errorCount,
          warningCount: validation.warningCount,
        }
      : null,
    entries,
  };
}

function envValueFromFile(content, key) {
  const re = new RegExp(`^${escapeRegExp(key)}=(.*)$`, 'm');
  const m = String(content || '').match(re);
  return m ? m[1].trim() : null;
}

function buildTargetParityReport({ files, targetUrl }) {
  const expected = normalizeTargetOrigin(targetUrl);
  const envTarget = envValueFromFile(files && files['.env'], 'QAAI_TARGET_URL');
  const configText = String((files && files['playwright.config.ts']) || '');
  const parentOverrideGuard =
    (/override:\s*true/.test(configText) && /dotenv/.test(configText)) ||
    (/function\s+loadQaaEnv\s*\(/.test(configText) &&
      /process\.env\[\s*key\s*\]\s*=\s*value/.test(configText));
  const ok = !!expected && envTarget === expected && parentOverrideGuard;
  return {
    schema: 'qaai-target-parity/1',
    ok,
    expectedTargetUrl: expected,
    envTargetUrl: envTarget,
    parentEnvOverrideGuard: parentOverrideGuard,
  };
}

function buildRuntimeResultFirewallReport({ results, validation, blocked, findings }) {
  const websiteCounts = { pass: 0, fail: 0, blocked: 0, skipped: 0, needs_human: 0 };
  for (const result of results || []) {
    const key = String((result && result.status) || 'skipped').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(websiteCounts, key)) websiteCounts[key] += 1;
    else websiteCounts.skipped += 1;
  }
  const outputErrorCount =
    (findings || []).filter((f) => f && f.severity === 'error').length +
    ((validation && Number(validation.errorCount)) || 0) +
    ((blocked && blocked.length) || 0);
  return {
    schema: 'qaai-runtime-result-firewall/1',
    invariant: 'Website result verdict and generated-output readiness are separate state machines.',
    websiteResultState: {
      source: 'RunResult statuses and verified assertion outcomes only',
      counts: websiteCounts,
      verdict:
        websiteCounts.fail > 0
          ? 'fail'
          : websiteCounts.blocked > 0 || websiteCounts.needs_human > 0
            ? 'mixed'
            : 'pass',
    },
    outputReadinessState: {
      source: 'ReplayIR locator/codegen/package certification only',
      status: outputErrorCount === 0 ? 'ready' : 'repair_required',
      blockedExportItems: (blocked && blocked.length) || 0,
      packagePassed: validation ? validation.packagePassed : null,
      certificationErrorCount: validation ? validation.errorCount : null,
    },
  };
}

function refreshManifestFileHashes(manifestEntries, files) {
  for (const entry of manifestEntries || []) {
    if (!entry || !Array.isArray(entry.files)) continue;
    const hashes = {};
    for (const rel of entry.files) {
      if (typeof files[rel] === 'string' || Buffer.isBuffer(files[rel]))
        hashes[rel] = sha256(files[rel]);
    }
    entry.fileHashes = hashes;
  }
}

function cloneFileMap(files) {
  return Object.fromEntries(
    Object.entries(files || {}).map(([rel, content]) => [
      rel,
      Buffer.isBuffer(content) ? Buffer.from(content) : String(content == null ? '' : content),
    ]),
  );
}

function refreshPomCertificationReport(adapterId, files, validation) {
  if (
    !POM_ADAPTER_IDS.has(adapterId) ||
    typeof files['evidence/certification-report.json'] !== 'string'
  )
    return;
  let report = null;
  try {
    report = JSON.parse(files['evidence/certification-report.json']);
  } catch (_) {
    report = null;
  }
  if (!report || typeof report !== 'object') report = {};
  const findings = Array.isArray(validation && validation.findings) ? validation.findings : [];
  const hasErrors =
    findings.some((f) => f && f.severity === 'error') ||
    (validation && (validation.packagePassed === false || validation.skipped === true));
  const dataFiles = Object.keys(files || {})
    .filter((rel) => /^tests\/data\/|^src\/test\/resources\/test-data\//.test(rel))
    .sort();
  const locatorManifest = readJsonFile(files, 'evidence/locator-manifest.json', []);
  const conflicts = readJsonFile(files, 'evidence/locator-conflicts.json', []);
  const locatorCertification = readJsonFile(
    files,
    'evidence/locator-certification-report.json',
    null,
  );
  report.spec = {
    ...(report.spec || {}),
    status: hasErrors ? 'internal-error' : (report.spec && report.spec.status) || 'runnable',
    validation: validation
      ? {
          packagePassed: !!validation.packagePassed,
          checked: !!validation.checked,
          skipped: !!validation.skipped,
          errorCount: validation.errorCount || 0,
          warningCount: validation.warningCount || 0,
        }
      : null,
    validationFindings: findings,
  };
  report.data = {
    ...(report.data || {}),
    fileCount: dataFiles.length,
    files: dataFiles,
  };
  report.evidence = {
    ...(report.evidence || {}),
    'locator-manifest.json': {
      status: Array.isArray(locatorManifest) ? 'present' : 'absent',
      entryCount: Array.isArray(locatorManifest) ? locatorManifest.length : 0,
    },
    'locator-conflicts.json': {
      status: Array.isArray(conflicts) && conflicts.length ? 'present' : 'absent',
      conflictCount: Array.isArray(conflicts) ? conflicts.length : 0,
    },
    'dom-atlas.json': {
      status: typeof files['evidence/dom-atlas.json'] === 'string' ? 'present' : 'absent',
    },
    'locator-certification-report.json': {
      status: locatorCertification
        ? (locatorCertification.summary && locatorCertification.summary.status) || 'present'
        : 'absent',
      stepCount:
        locatorCertification && locatorCertification.summary
          ? locatorCertification.summary.total
          : 0,
      certified:
        locatorCertification && locatorCertification.summary
          ? locatorCertification.summary.certified
          : 0,
      draft:
        locatorCertification && locatorCertification.summary
          ? locatorCertification.summary.draft
          : 0,
      blocked:
        locatorCertification && locatorCertification.summary
          ? locatorCertification.summary.blocked
          : 0,
    },
  };
  files['evidence/certification-report.json'] = JSON.stringify(report, null, 2) + '\n';
}

function packageTypeIsModule(files) {
  try {
    const pkg = JSON.parse(String((files && files['package.json']) || '{}'));
    return pkg && pkg.type === 'module';
  } catch (_) {
    return false;
  }
}

function ensurePackageJsonForAdapter(adapterId, files) {
  if (!PLAYWRIGHT_ADAPTER_IDS.has(adapterId)) return [];
  const repairs = [];
  if (adapterId === 'playwright-pom-js') {
    const inspection = inspectPlaywrightPomJsPackageContract({
      packageSource: files['package.json'],
      lockSource: files['package-lock.json'],
    });
    if (!inspection.ok) {
      const template = playwrightPomJsTemplateContract();
      files['package.json'] = template.packageSource;
      files['package-lock.json'] = template.lockSource;
      repairs.push({
        rule: 'pom_js_package_contract_restored',
        path: 'package.json',
        relatedPath: 'package-lock.json',
        findings: inspection.findings,
        message:
          'Restored package.json and package-lock.json together from the authoritative Playwright POM JS template.',
      });
    }
    return repairs;
  }
  let pkg = null;
  try {
    pkg = JSON.parse(String(files['package.json'] || '{}'));
  } catch (_) {
    pkg = null;
  }
  if (!pkg || typeof pkg !== 'object') {
    files['package.json'] = pwPackageJson(adapterId);
    repairs.push({
      rule: 'package_json_rebuilt',
      path: 'package.json',
      message: 'Rebuilt missing/invalid package.json from the adapter contract.',
    });
    return repairs;
  }
  if (adapterId === 'playwright-pom') {
    const canonical = JSON.parse(pwPackageJson(adapterId));
    const packageContractMatches =
      JSON.stringify(pkg.scripts || {}) === JSON.stringify(canonical.scripts || {}) &&
      JSON.stringify(pkg.devDependencies || {}) ===
        JSON.stringify(canonical.devDependencies || {});
    if (!packageContractMatches) {
      pkg.scripts = canonical.scripts;
      pkg.devDependencies = canonical.devDependencies;
      files['package.json'] = JSON.stringify(pkg, null, 2) + '\n';
      repairs.push({
        rule: 'pom_ts_package_contract_restored',
        path: 'package.json',
        message:
          'Restored the Playwright POM TypeScript scripts and dependency versions after package hardening.',
      });
    }
  }
  if (
    adapterId !== 'playwright-pom-js' &&
    adapterId !== 'playwright-reference-js' &&
    pkg.type === 'module'
  ) {
    delete pkg.type;
    files['package.json'] = JSON.stringify(pkg, null, 2) + '\n';
    repairs.push({
      rule: 'unneeded_type_module_removed',
      path: 'package.json',
      message: 'Removed package-level type=module from a TypeScript Playwright export.',
    });
  }
  return repairs;
}

function ensurePlaywrightSupportFiles(adapterId, files) {
  if (!PLAYWRIGHT_ADAPTER_IDS.has(adapterId)) return [];
  const repairs = [];
  const isPomJs = adapterId === 'playwright-pom-js';
  const useCjs = adapterId === 'playwright-reference-js';
  const hasSupportRef = Object.values(files).some((content) =>
    /tests\/support\/replayir|support\/replayir/.test(String(content || '')),
  );
  if (
    hasSupportRef ||
    Object.keys(files).some((p) => /^tests\/support\/replayir\.(ts|js)$/.test(p))
  ) {
    const support = isPomJs
      ? playwrightReference.supportFilesJsEsm()
      : useCjs
        ? playwrightReference.playwrightReferenceJs.supportFiles()
        : playwrightReference.supportFiles();
    for (const [rel, content] of Object.entries(support)) {
      const existing = files[rel];
      const wrongModuleStyle = isPomJs
        ? /\bmodule\.exports\b|\brequire\s*\(/.test(String(existing || ''))
        : useCjs
          ? /\bexport\s+(?:async\s+)?function\b|export\s*\{/.test(String(existing || ''))
          : /\bmodule\.exports\b/.test(String(existing || ''));
      if (!existing || wrongModuleStyle) {
        files[rel] = content;
        repairs.push({
          rule: 'playwright_support_file_repaired',
          path: rel,
          message: 'Restored replayir support file in the module style required by the adapter.',
        });
      }
    }
  }

  const helperRef = Object.values(files).some((content) =>
    /utils\/test-helpers/.test(String(content || '')),
  );
  if (helperRef) {
    const { testHelpersFile } = require('./_testHelpers');
    const hasJs = Object.keys(files).some((p) => /\.js$/.test(p));
    const hasTs = Object.keys(files).some((p) => /\.ts$/.test(p));
    if (hasJs) {
      const rel = 'utils/test-helpers.js';
      const expected = testHelpersFile(isPomJs ? 'esm-js' : 'js');
      const existing = String(files[rel] || '');
      const wrong = isPomJs
        ? /\bmodule\.exports\b|\brequire\s*\(/.test(existing)
        : /\bexport\s+(?:async\s+)?function\b|export\s*\{/.test(existing);
      if (!existing || wrong) {
        files[rel] = expected;
        repairs.push({
          rule: 'playwright_test_helper_repaired',
          path: rel,
          message: 'Restored test helper in the module style required by generated specs.',
        });
      }
    }
    if (hasTs) {
      const rel = 'utils/test-helpers.ts';
      if (!files[rel]) {
        files[rel] = testHelpersFile('ts');
        repairs.push({
          rule: 'playwright_test_helper_repaired',
          path: rel,
          message: 'Restored missing TypeScript test helper.',
        });
      }
    }
  }
  return repairs;
}

function ensurePreflightModuleStyle(adapterId, files) {
  if (!PLAYWRIGHT_ADAPTER_IDS.has(adapterId)) return [];
  const repairs = [];
  const configPath = files['playwright.config.ts']
    ? 'playwright.config.ts'
    : files['playwright.config.js']
      ? 'playwright.config.js'
      : null;
  if (!configPath) return repairs;
  const isPomJs = adapterId === 'playwright-pom-js';
  let config = String(files[configPath] || '');
  let wanted = isPomJs ? 'qaai.preflight.cjs' : 'qaai.preflight.js';
  const configured = /globalSetup:\s*['"]\.\/([^'"]+)['"]/.exec(config)?.[1] || wanted;
  if (configured !== wanted) {
    config = config.replace(/globalSetup:\s*['"]\.\/[^'"]+['"]/, `globalSetup: './${wanted}'`);
    files[configPath] = config;
    repairs.push({
      rule: 'preflight_config_repaired',
      path: configPath,
      message: `Pointed Playwright config at ${wanted}.`,
    });
  }
  if (!files[wanted]) {
    const previous = configured && files[configured] ? String(files[configured]) : null;
    files[wanted] = previous || QAAI_PREFLIGHT_JS;
    repairs.push({
      rule: 'preflight_file_restored',
      path: wanted,
      message: `Restored missing ${wanted}.`,
    });
  }
  if (
    isPomJs &&
    files['qaai.preflight.js'] &&
    /\bmodule\.exports\b/.test(String(files['qaai.preflight.js']))
  ) {
    files['qaai.preflight.cjs'] = files['qaai.preflight.cjs'] || files['qaai.preflight.js'];
    delete files['qaai.preflight.js'];
    repairs.push({
      rule: 'pom_js_preflight_renamed_cjs',
      path: 'qaai.preflight.cjs',
      message: 'Moved CommonJS preflight out of .js under an ESM package.',
    });
  }
  return repairs;
}

function hasSourceExtension(spec) {
  return /\.(?:mjs|cjs|js|jsx|ts|tsx|json)$/i.test(String(spec || ''));
}

function resolveImportTarget(fromRel, spec, files) {
  if (!spec || !spec.startsWith('.')) return null;
  if (hasSourceExtension(spec)) return null;
  const fromDir = path.posix.dirname(String(fromRel || '').replace(/\\/g, '/'));
  const base = path.posix.normalize(path.posix.join(fromDir, spec));
  const candidates = [`${base}.js`, `${base}.cjs`];
  return candidates.find((rel) => Object.prototype.hasOwnProperty.call(files, rel)) || null;
}

function repairEsmImportExtensions(files) {
  const repairs = [];
  if (!packageTypeIsModule(files)) return repairs;
  for (const [rel, content] of Object.entries(files)) {
    if (!/\.js$/.test(rel)) continue;
    let next = String(content || '');
    const before = next;
    next = next.replace(/(\bfrom\s*['"])(\.{1,2}\/[^'"]+)(['"])/g, (m, prefix, spec, suffix) => {
      const target = resolveImportTarget(rel, spec, files);
      if (!target) return m;
      return `${prefix}${spec}${path.posix.extname(target)}${suffix}`;
    });
    next = next.replace(
      /(\bimport\s*\(\s*['"])(\.{1,2}\/[^'"]+)(['"]\s*\))/g,
      (m, prefix, spec, suffix) => {
        const target = resolveImportTarget(rel, spec, files);
        if (!target) return m;
        return `${prefix}${spec}${path.posix.extname(target)}${suffix}`;
      },
    );
    if (next !== before) {
      files[rel] = next;
      repairs.push({
        rule: 'esm_relative_import_extension_added',
        path: rel,
        message: 'Added explicit source extensions to ESM relative imports.',
      });
    }
  }
  return repairs;
}

function toImportPathWithJsExt(fromRel, spec, files) {
  const target = resolveImportTarget(fromRel, spec, files);
  if (!target) return spec;
  return `${spec}${path.posix.extname(target)}`;
}

function repairPomJsCommonJsLeaks(adapterId, files) {
  const repairs = [];
  if (adapterId !== 'playwright-pom-js' || !packageTypeIsModule(files)) return repairs;
  for (const [rel, content] of Object.entries(files)) {
    if (!/^(?:pages|locators)\//.test(rel) || !/\.js$/.test(rel)) continue;
    let next = String(content || '');
    const before = next;

    next = next.replace(/module\.exports\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\);?/g, (m, spec) => {
      const fixed = toImportPathWithJsExt(rel, spec, files);
      return `export * from '${fixed}';`;
    });
    next = next.replace(
      /const\s+\{\s*([A-Za-z_$][\w$]*)\s*\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\);?/g,
      (m, imported, spec) => {
        const fixed = spec.startsWith('.') ? toImportPathWithJsExt(rel, spec, files) : spec;
        return `import { ${imported} } from '${fixed}';`;
      },
    );
    next = next.replace(/(^|\n)class\s+([A-Za-z_$][\w$]*)\s*\{/m, (m, prefix, name) => {
      if (!new RegExp(`module\\.exports\\s*=\\s*\\{\\s*${name}\\s*\\}`).test(next)) return m;
      return `${prefix}export class ${name} {`;
    });
    next = next.replace(/(^|\n)const\s+([A-Za-z_$][\w$]*)\s*=\s*\{/m, (m, prefix, name) => {
      if (!new RegExp(`module\\.exports\\s*=\\s*\\{\\s*${name}\\s*\\}`).test(next)) return m;
      return `${prefix}export const ${name} = {`;
    });
    next = next.replace(/\n?module\.exports\s*=\s*\{\s*[A-Za-z_$][\w$]*\s*\};?\s*$/m, '\n');

    if (next !== before) {
      files[rel] = next;
      repairs.push({
        rule: 'pom_js_cjs_leak_converted',
        path: rel,
        message: 'Converted leaked CommonJS POM helper to ESM for playwright-pom-js.',
      });
    }
  }
  return repairs;
}

function validationDiagnostics(validation) {
  return (validation && Array.isArray(validation.commands) ? validation.commands : [])
    .map((c) => `${c.cmd || ''}\n${c.output || ''}`)
    .join('\n\n');
}

function repairTypescriptDiagnosticsFromValidation(files, validation) {
  const diagnostics = validationDiagnostics(validation);
  if (!diagnostics || !/TS\d+/.test(diagnostics)) return [];
  try {
    const { repairTypeScriptDiagnostics } = require('./_certify');
    const repaired = repairTypeScriptDiagnostics(files, diagnostics);
    if (repaired && repaired.repairs && repaired.repairs.length) {
      Object.assign(files, repaired.files);
      return repaired.repairs.map((r) => ({
        ...r,
        rule: r.rule || 'typescript_diagnostic_repair',
        message: `Repaired generated TypeScript diagnostic ${r.code}.`,
      }));
    }
  } catch (_) {}
  return [];
}

function certifyPackageSourceFiles(files) {
  const findings = [];
  try {
    const { certifyFile } = require('./_certify');
    for (const [rel, content] of Object.entries(files || {})) {
      if (!/\.(?:cjs|mjs|js|jsx|ts|tsx)$/.test(rel)) continue;
      const cert = certifyFile({ relPath: rel, content, sanitize: false });
      if (!cert.parseOk) {
        findings.push(
          ...(cert.findings || []).map((f) => ({
            ...f,
            rule: f.rule || 'package_source_parse_error',
            severity: 'error',
          })),
        );
      }
    }
  } catch (err) {
    findings.push({
      rule: 'package_source_certify_threw',
      severity: 'warning',
      message: `Package source certification threw: ${err && err.message}`,
    });
  }
  return findings;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sourceLineOf(content, index) {
  return String(content || '')
    .slice(0, Math.max(0, index))
    .split(/\r?\n/).length;
}

function parseClassMethodNames(content) {
  const names = new Set();
  const text = String(content || '');
  let m;
  const identRe = /(?:^|\n)\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{/g;
  while ((m = identRe.exec(text))) names.add(m[1]);
  const quotedRe = /(?:^|\n)\s*(?:async\s+)?(['"])([^'"]+)\1\s*\([^)]*\)\s*(?::[^{]+)?\{/g;
  while ((m = quotedRe.exec(text))) names.add(m[2]);
  return names;
}

function parseGeneratedLocatorKeys(content) {
  const keys = new Set();
  for (const line of String(content || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*:\s*\(/);
    if (m) keys.add(m[2] || m[3]);
  }
  return keys;
}

function packageEnvKeys(files) {
  const keys = new Set();
  for (const rel of ['.env.example', '.env']) {
    const content = files && files[rel];
    if (typeof content !== 'string') continue;
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (m) keys.add(m[1]);
    }
  }
  return keys;
}

function readJsonFile(files, rel, fallback = null) {
  try {
    if (!files || typeof files[rel] !== 'string') return fallback;
    return JSON.parse(files[rel]);
  } catch (_) {
    return fallback;
  }
}

function readDataRowsFile(files, rel) {
  try {
    if (!files || typeof files[rel] !== 'string') return null;
    const parsed = JSON.parse(files[rel]);
    return Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function dataFieldValues(rows) {
  const out = [];
  for (const row of rows || []) {
    const fields = row && row.fields && typeof row.fields === 'object' ? row.fields : {};
    for (const [key, raw] of Object.entries(fields)) {
      if (raw == null) continue;
      const value = String(raw).trim();
      if (!value || value.length < 3) continue;
      if (/^(pass|fail|true|false|yes|no|ok)$/i.test(value)) continue;
      out.push({ key, value, rowLabel: row.label || `Row ${row.index || 0}` });
    }
  }
  return out;
}

function dataFieldKeys(rows) {
  const keys = new Set();
  for (const row of rows || []) {
    const fields = row && row.fields && typeof row.fields === 'object' ? row.fields : {};
    for (const key of Object.keys(fields)) keys.add(key);
  }
  return keys;
}

function repairUniqueHardcodedDataBindings(files) {
  const repairs = [];
  for (const [rel, rawContent] of Object.entries(files || {})) {
    if (!/^tests\/.+\.spec\.(?:js|ts)$/.test(rel)) continue;
    const original = String(rawContent || '');
    if (!/\bfor\s*\(\s*const\s+row\s+of\b/.test(original)) continue;

    const dataPaths = [];
    let loadMatch;
    const loadRe = /\bloadDataRows\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((loadMatch = loadRe.exec(original))) dataPaths.push(loadMatch[1]);
    if (!dataPaths.length) continue;

    const candidatesByValue = new Map();
    for (const dataPath of dataPaths) {
      const rows = readDataRowsFile(files, dataPath);
      if (!rows) continue;
      for (const { key, value } of dataFieldValues(rows)) {
        const candidates = candidatesByValue.get(value) || new Map();
        candidates.set(`${dataPath}\u0000${key}`, { dataPath, key });
        candidatesByValue.set(value, candidates);
      }
    }

    let changed = false;
    const lines = original.split(/\r?\n/).map((line, index) => {
      if (!/\bawait\b/.test(line) || /\breadData\(\s*row\s*,/.test(line)) return line;
      let nextLine = line;
      for (const [value, candidates] of candidatesByValue) {
        if (candidates.size !== 1) continue;
        const [{ key, dataPath }] = [...candidates.values()];
        const replacement = `readData(row, ${JSON.stringify(key)})`;
        const literals = [
          JSON.stringify(value),
          `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`,
          `\`${value.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``,
        ];
        let replaced = false;
        for (const literal of literals) {
          if (!nextLine.includes(literal)) continue;
          nextLine = nextLine.split(literal).join(replacement);
          replaced = true;
        }
        if (!replaced) continue;
        changed = true;
        repairs.push({
          rule: 'pom_graph_hardcoded_data_value_bound',
          path: rel,
          line: index + 1,
          dataPath,
          key,
          message: `${rel} now reads the uniquely matched fixture column "${key}" instead of embedding its literal value.`,
        });
      }
      return nextLine;
    });
    if (changed) files[rel] = `${lines.join('\n').replace(/\n+$/, '')}\n`;
  }
  return repairs;
}

function validatePomFileGraph(adapterId, files) {
  if (!POM_ADAPTER_IDS.has(adapterId)) return [];
  const findings = [];
  const pageMethodCache = new Map();
  const locatorKeyCache = new Map();
  const pageFileForClass = (className) => {
    for (const ext of ['js', 'ts']) {
      const rel = `pages/${className}.${ext}`;
      if (typeof files[rel] === 'string') return rel;
    }
    return null;
  };
  const locatorKeysForStem = (stem) => {
    if (locatorKeyCache.has(stem)) return locatorKeyCache.get(stem);
    const merged = new Set();
    for (const ext of ['js', 'ts']) {
      const rel = `locators/generated/${stem}.generated.locators.${ext}`;
      if (typeof files[rel] === 'string') {
        for (const key of parseGeneratedLocatorKeys(files[rel])) merged.add(key);
      }
    }
    locatorKeyCache.set(stem, merged);
    return merged;
  };

  for (const [rel, content] of Object.entries(files || {})) {
    if (!/^tests\/.+\.spec\.(?:js|ts)$/.test(rel)) continue;
    const text = String(content || '');
    const pageVars = new Map();
    let m;
    const ctorRe =
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Z][A-Za-z0-9_$]*)\s*\(/g;
    while ((m = ctorRe.exec(text))) pageVars.set(m[1], { className: m[2], index: m.index });
    for (const [varName, meta] of pageVars) {
      const pageRel = pageFileForClass(meta.className);
      if (!pageRel) {
        findings.push({
          rule: 'pom_graph_missing_page_file',
          severity: 'error',
          path: rel,
          line: sourceLineOf(text, meta.index),
          message: `Spec constructs ${meta.className}, but pages/${meta.className}.js or .ts is absent.`,
        });
        continue;
      }
      if (!pageMethodCache.has(pageRel))
        pageMethodCache.set(pageRel, parseClassMethodNames(files[pageRel]));
      const methods = pageMethodCache.get(pageRel);
      const methodRe = new RegExp(
        `\\b${escapeRegExp(varName)}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`,
        'g',
      );
      let call;
      while ((call = methodRe.exec(text))) {
        const method = call[1];
        if (['constructor'].includes(method)) continue;
        if (!methods.has(method)) {
          findings.push({
            rule: 'pom_graph_missing_page_method',
            severity: 'error',
            path: rel,
            line: sourceLineOf(text, call.index),
            message: `Spec calls ${varName}.${method}(), but ${pageRel} does not define ${method}().`,
          });
        }
      }
    }
  }

  for (const [rel, content] of Object.entries(files || {})) {
    if (!/^pages\/(?!EvaluateMethods\.)[^/]+\.(?:js|ts)$/.test(rel)) continue;
    const text = String(content || '');
    let m;
    const importRe = /\{\s*([A-Za-z_$][\w$]*Locators)\s*\}/g;
    const seenConsts = new Set();
    while ((m = importRe.exec(text))) seenConsts.add(m[1]);
    for (const constName of seenConsts) {
      const stem = constName.replace(/Locators$/, '');
      const keys = locatorKeysForStem(stem);
      if (!keys.size) {
        findings.push({
          rule: 'pom_graph_missing_locator_file',
          severity: 'error',
          path: rel,
          line: 1,
          message: `${rel} imports ${constName}, but locators/generated/${stem}.generated.locators.js or .ts is absent or empty.`,
        });
      }
      const dotRe = new RegExp(`\\b${escapeRegExp(constName)}\\.([A-Za-z_$][\\w$]*)`, 'g');
      const bracketRe = new RegExp(`\\b${escapeRegExp(constName)}\\[(['"])([^'"]+)\\1\\]`, 'g');
      let ref;
      while ((ref = dotRe.exec(text))) {
        if (!keys.has(ref[1])) {
          findings.push({
            rule: 'pom_graph_missing_locator_key',
            severity: 'error',
            path: rel,
            line: sourceLineOf(text, ref.index),
            message: `${rel} references ${constName}.${ref[1]}, but the generated locator file does not contain key "${ref[1]}".`,
          });
        }
      }
      while ((ref = bracketRe.exec(text))) {
        if (!keys.has(ref[2])) {
          findings.push({
            rule: 'pom_graph_missing_locator_key',
            severity: 'error',
            path: rel,
            line: sourceLineOf(text, ref.index),
            message: `${rel} references ${constName}[${JSON.stringify(ref[2])}], but the generated locator file does not contain key "${ref[2]}".`,
          });
        }
      }
    }
  }

  const locatorFileCount = Object.entries(files || {})
    .filter(([rel]) => /^locators\/generated\/.+\.generated\.locators\.(?:js|ts)$/.test(rel))
    .reduce((sum, [, content]) => sum + parseGeneratedLocatorKeys(content).size, 0);
  const manifest = readJsonFile(files, 'evidence/locator-manifest.json', null);
  if (Array.isArray(manifest) && manifest.length !== locatorFileCount) {
    findings.push({
      rule: 'pom_graph_manifest_count_mismatch',
      severity: 'error',
      path: 'evidence/locator-manifest.json',
      line: 1,
      message: `locator-manifest.json has ${manifest.length} entries, but final generated locator files expose ${locatorFileCount} keys.`,
    });
  } else if (!Array.isArray(manifest)) {
    findings.push({
      rule: 'pom_graph_manifest_missing',
      severity: 'error',
      path: 'evidence/locator-manifest.json',
      line: 1,
      message: 'POM package is missing a parseable evidence/locator-manifest.json.',
    });
  } else {
    for (const [index, entry] of manifest.entries()) {
      if (!entry || entry.status === 'weak') continue;
      if (entry.source && entry.source !== 'actionLocator') {
        findings.push({
          rule: 'pom_graph_locator_not_action_time',
          severity: 'warning',
          path: 'evidence/locator-manifest.json',
          line: 1,
          message: `locator-manifest.json entry #${index + 1} (${entry.file || 'unknown'}.${entry.name || entry.as || 'unknown'}) was generated from ${entry.source}, not action-time locator evidence.`,
        });
      }
      const proof = entry.proof && typeof entry.proof === 'object' ? entry.proof : {};
      const targetIdentity =
        proof.targetIdentity && typeof proof.targetIdentity === 'object'
          ? proof.targetIdentity
          : null;
      const matchedIdentity =
        proof.matchedIdentity && typeof proof.matchedIdentity === 'object'
          ? proof.matchedIdentity
          : null;
      const source = entry.verificationSource || entry.evidenceSource || proof.source || null;
      const verifiedDomNode =
        (source === 'verified_dom_inspection' || source === 'active_dom_excavation') &&
        proof.identityVerified === true &&
        !!targetIdentity?.documentId &&
        !!targetIdentity?.nodeId &&
        targetIdentity.documentId === matchedIdentity?.documentId &&
        targetIdentity.nodeId === matchedIdentity?.nodeId;
      const verifiedAuthoritativeCdp =
        source === 'authoritative_chromium_cdp' &&
        proof.verified === true &&
        proof.actionTimeResolved === true &&
        proof.sameElement === true &&
        proof.identityVerified === true &&
        proof.stableAcrossSnapshots === true &&
        Number(proof.count) === 1 &&
        Number(proof.countBefore) === 1 &&
        Number(proof.countAfter) === 1 &&
        targetIdentity?.scheme === 'qaai-cdp-backend-node-v1' &&
        matchedIdentity?.scheme === targetIdentity.scheme &&
        Number(targetIdentity.backendNodeId) > 0 &&
        Number(targetIdentity.backendNodeId) === Number(matchedIdentity.backendNodeId);
      const verifiedActionSource = verifiedDomNode || verifiedAuthoritativeCdp;
      if (entry.source === 'actionLocator' && (entry.verified !== true || !verifiedActionSource)) {
        findings.push({
          rule: 'pom_graph_locator_not_verified_dom_inspection',
          severity: 'warning',
          path: 'evidence/locator-manifest.json',
          line: 1,
          message: `locator-manifest.json entry #${index + 1} (${entry.file || 'unknown'}.${entry.name || entry.as || 'unknown'}) is not backed by verified action-time locator evidence.`,
        });
      }
    }
  }

  const conflicts = readJsonFile(files, 'evidence/locator-conflicts.json', []);
  if (Array.isArray(conflicts) && conflicts.length) {
    findings.push({
      rule: 'pom_graph_locator_conflicts',
      severity: 'warning',
      path: 'evidence/locator-conflicts.json',
      line: 1,
      message: `POM package has ${conflicts.length} locator conflict(s). QAAI emitted editable locator entries and preserved the complete script; review the marked locator choices if replay selects the wrong element.`,
    });
  }

  const declaredEnv = packageEnvKeys(files);
  for (const [rel, content] of Object.entries(files || {})) {
    if (!/\.(?:js|ts|cjs|mjs)$/.test(rel)) continue;
    const text = String(content || '');
    const runtimeRefIndex = text.search(/\[ref\s*=|locator\(\s*['"][^'"]*\[ref\s*=/i);
    if (runtimeRefIndex >= 0) {
      findings.push({
        rule: 'pom_graph_runtime_ref_leak',
        severity: 'error',
        path: rel,
        line: sourceLineOf(text, runtimeRefIndex),
        message: `${rel} contains an MCP runtime ref selector. Generated code must use stable website selectors, never [ref=eN] tokens.`,
      });
    }
    let m;
    const readEnvRe = /\breadEnv\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = readEnvRe.exec(text))) {
      if (!declaredEnv.has(m[1])) {
        findings.push({
          rule: 'pom_graph_missing_env_var',
          severity: 'error',
          path: rel,
          line: sourceLineOf(text, m.index),
          message: `${rel} reads env ${m[1]}, but .env.example does not declare it.`,
        });
      }
    }
    if (/qaai-uncheckable/i.test(text)) {
      findings.push({
        rule: 'pom_graph_uncheckable_annotation',
        severity: 'error',
        path: rel,
        line: sourceLineOf(text, text.search(/qaai-uncheckable/i)),
        message: `${rel} contains a qaai-uncheckable annotation instead of a faithful replayable assertion.`,
      });
    }

    if (/^tests\/.+\.spec\.(?:js|ts)$/.test(rel)) {
      const dataPaths = [];
      let loadMatch;
      const loadRe = /\bloadDataRows\(\s*['"]([^'"]+)['"]\s*\)/g;
      while ((loadMatch = loadRe.exec(text))) dataPaths.push(loadMatch[1]);
      if (dataPaths.length && !/\breadData\(\s*row\s*,/.test(text)) {
        findings.push({
          rule: 'pom_graph_data_loaded_but_not_bound',
          severity: 'error',
          path: rel,
          line: sourceLineOf(text, text.indexOf('loadDataRows(')),
          message: `${rel} loads data rows but never uses readData(row, "..."). Data-driven generated specs must preserve row/column bindings.`,
        });
      }
      const loadedRows = new Map();
      for (const dataPath of dataPaths) {
        const rows = readDataRowsFile(files, dataPath);
        if (!rows) {
          findings.push({
            rule: 'pom_graph_missing_data_file',
            severity: 'error',
            path: rel,
            line: sourceLineOf(text, text.indexOf(dataPath)),
            message: `${rel} loads data file ${dataPath}, but that file is missing or is not a JSON row array.`,
          });
        } else {
          loadedRows.set(dataPath, rows);
        }
      }
      let dataMatch;
      const readDataRe = /\breadData\(\s*row\s*,\s*['"]([^'"]+)['"]/g;
      while ((dataMatch = readDataRe.exec(text))) {
        const key = dataMatch[1];
        if (!loadedRows.size) {
          findings.push({
            rule: 'pom_graph_read_data_without_file',
            severity: 'error',
            path: rel,
            line: sourceLineOf(text, dataMatch.index),
            message: `${rel} reads data column "${key}" but does not load a JSON data row file.`,
          });
          continue;
        }
        const hasKey = [...loadedRows.values()].some((rows) =>
          rows.some(
            (row) => row && row.fields && Object.prototype.hasOwnProperty.call(row.fields, key),
          ),
        );
        if (!hasKey) {
          findings.push({
            rule: 'pom_graph_missing_data_column',
            severity: 'error',
            path: rel,
            line: sourceLineOf(text, dataMatch.index),
            message: `${rel} reads data column "${key}", but none of its loaded JSON data rows contain that field.`,
          });
        }
      }
      for (const [dataPath, rows] of loadedRows) {
        const executableText = text
          .split(/\r?\n/)
          .filter((line) => !/^\s*test(?:\.describe)?\s*\(/.test(line))
          .join('\n');
        for (const { key, value, rowLabel } of dataFieldValues(rows)) {
          const hardcoded =
            executableText.includes(JSON.stringify(value)) ||
            executableText.includes(`'${value.replace(/'/g, "\\'")}'`);
          if (hardcoded) {
            findings.push({
              rule: 'pom_graph_hardcoded_data_value',
              severity: 'error',
              path: rel,
              line: sourceLineOf(
                text,
                text.indexOf(JSON.stringify(value)) >= 0
                  ? text.indexOf(JSON.stringify(value))
                  : text.indexOf(value),
              ),
              message: `${rel} hardcodes uploaded data value "${value.slice(0, 80)}" from ${dataPath} (${rowLabel}, ${key}) instead of using readData(row, "${key}").`,
            });
          }
        }
        const keys = dataFieldKeys(rows);
        if (
          (keys.has('priceMin') || keys.has('priceMax')) &&
          !/\bassertPricesBetween\s*\(/.test(text)
        ) {
          findings.push({
            rule: 'pom_graph_price_data_not_asserted',
            severity: 'error',
            path: rel,
            line: 1,
            message: `${rel} loads ${dataPath} with priceMin/priceMax columns but does not assert prices with assertPricesBetween(...).`,
          });
        }
        if (
          keys.has('expectedContainsProductName') &&
          !/\bassertProductNamesContain\s*\(/.test(text)
        ) {
          findings.push({
            rule: 'pom_graph_product_name_data_not_asserted',
            severity: 'error',
            path: rel,
            line: 1,
            message: `${rel} loads ${dataPath} with expectedContainsProductName but does not assert product names with assertProductNamesContain(...).`,
          });
        }
        if (keys.has('assertProductCategory') && !/\bassertProductCategory\s*\(/.test(text)) {
          findings.push({
            rule: 'pom_graph_product_category_data_not_asserted',
            severity: 'error',
            path: rel,
            line: 1,
            message: `${rel} loads ${dataPath} with assertProductCategory but does not assert category with assertProductCategory(...).`,
          });
        }
      }
    }
  }

  if (typeof files['evidence/dom-atlas.json'] !== 'string') {
    findings.push({
      rule: 'pom_graph_dom_atlas_absent',
      severity: 'warning',
      nonBlocking: true,
      path: 'evidence/dom-atlas.json',
      line: 1,
      message:
        'POM package has no DOM Atlas evidence file. Fresh element-action runs must include action-time DOM evidence or be held for internal recapture.',
    });
  } else {
    const domAtlas = readJsonFile(files, 'evidence/dom-atlas.json', null);
    const pages =
      domAtlas && domAtlas.pages && typeof domAtlas.pages === 'object'
        ? Object.values(domAtlas.pages)
        : [];
    const hasDiagnosticOnlyAtlas = pages.some((page) => {
      const controls = Array.isArray(page && page.controls) ? page.controls : [];
      const actions = Array.isArray(page && page.verifiedActions) ? page.verifiedActions : [];
      const hasAuthoritativeAction = actions.some((action) => {
        const proof = (action && (action.proof || action.verificationProof)) || {};
        return action && action.verified === true
          && proof.sameElement === true
          && Number(proof.count) === 1
          && proof.identityVerified === true;
      });
      if (hasAuthoritativeAction) return false;
      return (
        controls.some((control) =>
          /snapshot_ref_fallback|action_locator_minimal|args/i.test(
            String((control && control.source) || ''),
          ),
        ) ||
        actions.some((action) =>
          /snapshot_ref_fallback|action_locator_minimal|args/i.test(
            String(
              (action &&
                (action.verificationSource ||
                  action.evidenceSource ||
                  (action.proof && action.proof.source) ||
                  (action.context && action.context.source))) ||
                '',
            ),
          ),
        )
      );
    });
    if (!pages.length || hasDiagnosticOnlyAtlas) {
      findings.push({
        rule: 'pom_graph_dom_atlas_not_verified',
        severity: 'warning',
        nonBlocking: true,
        path: 'evidence/dom-atlas.json',
        line: 1,
        message:
          'DOM Atlas evidence must come from verified browser-side action inspection, not snapshot/args/minimal diagnostic fallback evidence.',
      });
    }
  }

  const report = readJsonFile(files, 'evidence/certification-report.json', null);
  const hasGraphError = findings.some((f) => f.severity === 'error');
  if (hasGraphError && report && report.spec && report.spec.status === 'runnable') {
    findings.push({
      rule: 'pom_graph_report_false_runnable',
      severity: 'error',
      path: 'evidence/certification-report.json',
      line: 1,
      message:
        'certification-report.json claims spec.status=runnable while package graph validation has error-severity broken links.',
    });
  }
  return findings;
}

function appendValidationFindings(validation, extraFindings) {
  const additions = Array.isArray(extraFindings) ? extraFindings : [];
  if (!additions.length) return validation;
  const mergedFindings = [...((validation && validation.findings) || []), ...additions];
  const errorCount = mergedFindings.filter((f) => f && f.severity === 'error').length;
  const warningCount = mergedFindings.filter((f) => f && f.severity === 'warning').length;
  return {
    ...(validation || { checked: false, skipped: true, commands: [] }),
    packagePassed: errorCount === 0 && (!validation || validation.packagePassed !== false),
    findings: mergedFindings,
    errorCount,
    warningCount,
  };
}

function applyPackageCertificationRepairs({ adapterId, files, validation = null } = {}) {
  const next = cloneFileMap(files);
  const repairs = [];
  repairs.push(...ensurePackageJsonForAdapter(adapterId, next));
  repairs.push(...ensurePlaywrightSupportFiles(adapterId, next));
  repairs.push(...ensurePreflightModuleStyle(adapterId, next));
  repairs.push(...repairPomJsCommonJsLeaks(adapterId, next));
  repairs.push(...repairEsmImportExtensions(next));
  repairs.push(...repairTypescriptDiagnosticsFromValidation(next, validation));
  repairs.push(...repairUniqueHardcodedDataBindings(next));
  repairs.push(...pruneUnreferencedAuthSetup(next));
  const parseFindings = certifyPackageSourceFiles(next);
  return {
    files: next,
    repairs,
    findings: parseFindings,
    changed: repairs.length > 0,
  };
}

async function validatePackageFilesOnce({ adapterId, files }) {
  const framework = VALIDATE_FRAMEWORK[adapterId];
  if (!framework)
    return {
      packagePassed: true,
      checked: false,
      skipped: true,
      findings: [
        {
          rule: 'package_validate_no_framework',
          severity: 'warning',
          message: `No package-validate mapping for adapter ${adapterId}.`,
        },
      ],
      errorCount: 0,
      warningCount: 1,
      commands: [],
    };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qaai-p7-export-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, Buffer.isBuffer(content) ? undefined : 'utf8');
    }
    return await packageValidate.validatePackage({ framework, projectRoot: tmp, files: {} });
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (_) {}
  }
}

/** fs. Write the assembled package to a temp dir and validate it THERE (#7). */
async function validateAssembled({ adapterId, files }) {
  let currentFiles = cloneFileMap(files);
  const allRepairs = [];
  const repairFindings = [];
  let repairAttempts = 0;

  const deterministicRepairs = applyPackageCertificationRepairs({
    adapterId,
    files: currentFiles,
  });
  repairFindings.push(...(deterministicRepairs.findings || []));
  if (deterministicRepairs.changed) {
    repairAttempts += 1;
    allRepairs.push(...deterministicRepairs.repairs);
    currentFiles = deterministicRepairs.files;
  }
  let validation = await validatePackageFilesOnce({ adapterId, files: currentFiles });

  for (let attempt = 0; attempt < 2; attempt++) {
    if (!validation || validation.skipped || validation.packagePassed !== false) break;
    const repaired = applyPackageCertificationRepairs({
      adapterId,
      files: currentFiles,
      validation,
    });
    repairFindings.push(...(repaired.findings || []));
    if (!repaired.changed) break;
    repairAttempts += 1;
    allRepairs.push(...repaired.repairs);
    currentFiles = repaired.files;
    validation = await validatePackageFilesOnce({ adapterId, files: currentFiles });
    if (validation.packagePassed !== false) break;
  }

  const repairWarnings = allRepairs.map((r) => ({
    rule: r.rule || 'export_certification_auto_repair',
    severity: 'warning',
    path: r.path || r.relPath || null,
    line: r.line || null,
    message: r.message || 'QAAI repaired generated package files before export certification.',
    repair: r,
  }));
  let graphFindings = validatePomFileGraph(adapterId, currentFiles);
  let mergedFindings = [
    ...(validation.findings || []),
    ...repairWarnings,
    ...repairFindings,
    ...graphFindings,
  ];
  let interimErrorCount = mergedFindings.filter((f) => f.severity === 'error').length;
  let interimWarningCount = mergedFindings.filter((f) => f.severity === 'warning').length;
  refreshPomCertificationReport(adapterId, currentFiles, {
    ...validation,
    packagePassed: interimErrorCount === 0 && validation.packagePassed !== false,
    findings: mergedFindings,
    errorCount: interimErrorCount,
    warningCount: interimWarningCount,
  });
  graphFindings = validatePomFileGraph(adapterId, currentFiles);
  mergedFindings = [
    ...(validation.findings || []),
    ...repairWarnings,
    ...repairFindings,
    ...graphFindings,
  ];
  const errorCount = mergedFindings.filter((f) => f.severity === 'error').length;
  const warningCount = mergedFindings.filter((f) => f.severity === 'warning').length;
  return {
    ...validation,
    packagePassed: errorCount === 0 && validation.packagePassed !== false,
    findings: mergedFindings,
    errorCount,
    warningCount,
    repaired: allRepairs.length > 0,
    repairAttempts,
    repairs: allRepairs,
    repairedFiles: allRepairs.length > 0 ? currentFiles : null,
  };
}

async function loadResultsForExport({ projectId, runId, runResultIds, generationId = null }) {
  const where =
    Array.isArray(runResultIds) && runResultIds.length
      ? { id: { in: runResultIds } }
      : runId
        ? { runId }
        : null;
  let resolvedRunId = runId || null;
  if (!where) {
    // Default: the most recent actual run. Missing ReplayIR is represented by a
    // visible diagnostic package below; selecting an older ReplayIR-bearing row
    // makes Output Files lie about what just happened.
    const latest = await prisma.run.findFirst({
      where: {
        projectId,
        ...(generationId ? { generationId } : {}),
      },
      orderBy: { startedAt: 'desc' },
      select: { id: true },
    });
    if (!latest) return { runId: null, results: [] };
    resolvedRunId = latest.id;
  }
  const rows = await prisma.runResult.findMany({
    where: where || { runId: resolvedRunId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      runId: true,
      testCaseId: true,
      status: true,
      blockedReason: true,
      replayIrJson: true,
      executionContractJson: true,
      actionGraphJson: true,
      stepResults: true,
      assertionCheckResults: true,
      dataRowIndex: true,
      dataRowLabel: true,
      overallRunStatus: true,
      executionStatus: true,
      evidenceStatus: true,
      scriptStatus: true,
      evidenceCompletenessJson: true,
      actionEvidences: { orderBy: { sequenceIndex: 'asc' } },
      locatorRecipes: { orderBy: { sequenceIndex: 'asc' } },
      assertionEvidences: { orderBy: { sequenceIndex: 'asc' } },
      authSetupEvidences: { orderBy: { createdAt: 'asc' } },
      navigationEvidences: { orderBy: { sequenceIndex: 'asc' } },
      traceArtifacts: { orderBy: { createdAt: 'asc' } },
      replayIrCertifications: { orderBy: { createdAt: 'asc' } },
      evidenceCompletenessLedgers: { orderBy: { createdAt: 'asc' } },
      testCase: {
        select: {
          id: true,
          name: true,
          module: true,
          authProfile: true,
          operationsJson: true,
          requirementRefs: true,
          dataBindingJson: true,
          scenarioId: true,
          dependsOnIds: true,
          producesData: true,
          requiresData: true,
          steps: true,
          declaredAssertions: true,
          qualityContractJson: true,
          readinessStatus: true,
          readinessReasonsJson: true,
          readinessContractVersion: true,
          readinessComputedAt: true,
          runEligibility: true,
          sessionMode: true,
          failurePolicy: true,
          rowExecutionPlanJson: true,
          rowCoverageStatus: true,
          skippedRowsJson: true,
        },
      },
    },
  });
  if (!resolvedRunId && rows.length) resolvedRunId = rows[0].runId;

  // Batch-load scenario names so journey grouping has human-readable describe titles.
  const scenarioIds = [
    ...new Set(rows.map((r) => r.testCase && r.testCase.scenarioId).filter(Boolean)),
  ];
  const scenarioNameMap = {};
  if (scenarioIds.length) {
    const scenarios = await prisma.testScenario.findMany({
      where: { id: { in: scenarioIds } },
      select: { id: true, name: true },
    });
    for (const s of scenarios) scenarioNameMap[s.id] = s.name;
  }

  // Batch-load dependency names for the stateful-smoke warning comment (Trap 2).
  const allDepIds = [
    ...new Set(rows.flatMap((r) => parseArrayJson(r.testCase && r.testCase.dependsOnIds))),
  ];
  const depNameMap = {};
  if (allDepIds.length) {
    const depCases = await prisma.testCase.findMany({
      where: { id: { in: allDepIds } },
      select: { id: true, name: true },
    });
    for (const tc of depCases) depNameMap[tc.id] = tc.name;
  }

  const results = rows.map((r) => {
    const sid = (r.testCase && r.testCase.scenarioId) || null;
    const depIds = parseArrayJson(r.testCase && r.testCase.dependsOnIds);
    const replayIrPersisted =
      r.replayIrJson != null &&
      (typeof r.replayIrJson !== 'string' || r.replayIrJson.trim().length > 0);
    const envelope = decodeJson(r.replayIrJson, null);
    // Stamp each assert step with the LIVE outcome it had under MCP, keyed by the
    // assertion's contractRef. The emitter reads step.liveOutcome to decide hard-assert
    // vs soft-annotate, so the export's per-assertion verdict tracks the live run.
    // (The pinned IR itself carries no outcomes — they live on the RunResult.)
    const liveOutcomes = reduceAssertionOutcomes(r.assertionCheckResults);
    if (
      envelope &&
      Array.isArray(envelope.ir && envelope.ir.steps) &&
      Object.keys(liveOutcomes).length
    ) {
      for (const step of envelope.ir.steps) {
        if (step && step.op === 'assert') {
          const ref = step.contractRef || step.id;
          if (ref && ref in liveOutcomes) {
            const lo = liveOutcomes[ref];
            step.liveOutcome = lo.outcome;
            // Propagate domGrounded so the codegen can distinguish ARIA-snapshot matches
            // (assertTextPresent works) from eval-cache / semantic-rescue matches (uncheckable).
            if (lo.domGrounded === false) step.liveDomGrounded = false;
          }
        }
      }
    }
    const readiness = r.testCase ? readinessCompiler.compileCaseReadiness(r.testCase) : null;
    const result = {
      runResultId: r.id,
      runId: r.runId,
      testCaseId: r.testCaseId,
      status: r.status,
      blockedReason: r.blockedReason,
      dataRowIndex: r.dataRowIndex,
      dataRowLabel: r.dataRowLabel,
      caseName: r.testCase && r.testCase.name,
      moduleName: r.testCase && r.testCase.module,
      authProfile: r.testCase && r.testCase.authProfile,
      scenarioId: sid,
      scenarioName: sid ? scenarioNameMap[sid] || null : null,
      dependsOnIds: depIds,
      dependsOnNames: depIds.map((id) => depNameMap[id] || null).filter(Boolean),
      operationPlan: decodeJson(r.testCase && r.testCase.operationsJson, null),
      requirementRefs: parseArrayJson(r.testCase && r.testCase.requirementRefs),
      dataBinding: decodeJson(r.testCase && r.testCase.dataBindingJson, null),
      executionContract: decodeJson(r.executionContractJson, null),
      actionGraph: decodeJson(r.actionGraphJson, null),
      stepResults: decodeJson(r.stepResults, []),
      declaredSteps: decodeJson(r.testCase && r.testCase.steps, []),
      declaredAssertionsRaw: r.testCase ? r.testCase.declaredAssertions : null,
      readinessStatus: readiness
        ? readiness.readinessStatus
        : (r.testCase && r.testCase.readinessStatus) || null,
      runEligibility: readiness
        ? readiness.runEligibility
        : (r.testCase && r.testCase.runEligibility) || null,
      readinessReasons: readiness
        ? readiness.readinessReasons
        : decodeJson(r.testCase && r.testCase.readinessReasonsJson, []),
      sessionMode: readiness
        ? readiness.sessionMode
        : (r.testCase && r.testCase.sessionMode) || 'fresh',
      failurePolicy: readiness
        ? readiness.failurePolicy
        : (r.testCase && r.testCase.failurePolicy) || 'continue_independent',
      liveOutcomes,
      envelope,
      sourceReplayIrMissing: !replayIrPersisted,
      captureFirstEvidence: {
        overallRunStatus: r.overallRunStatus || null,
        executionStatus: r.executionStatus || null,
        evidenceStatus: r.evidenceStatus || null,
        scriptStatus: r.scriptStatus || null,
        evidenceCompleteness: decodeJson(r.evidenceCompletenessJson, null),
        actionEvidences: Array.isArray(r.actionEvidences) ? r.actionEvidences : [],
        locatorRecipes: Array.isArray(r.locatorRecipes) ? r.locatorRecipes : [],
        assertionEvidences: Array.isArray(r.assertionEvidences) ? r.assertionEvidences : [],
        authSetupEvidences: Array.isArray(r.authSetupEvidences) ? r.authSetupEvidences : [],
        navigationEvidences: Array.isArray(r.navigationEvidences) ? r.navigationEvidences : [],
        traceArtifacts: Array.isArray(r.traceArtifacts) ? r.traceArtifacts : [],
        replayIrCertifications: Array.isArray(r.replayIrCertifications)
          ? r.replayIrCertifications
          : [],
        evidenceCompletenessLedgers: Array.isArray(r.evidenceCompletenessLedgers)
          ? r.evidenceCompletenessLedgers
          : [],
      },
    };
    result.liveScriptLedger = liveScriptRecorder.buildLedgerFromResult(result);
    return result;
  });
  return { runId: resolvedRunId, results };
}

async function authProfileIdForName(projectId, authProfile) {
  const value = String(authProfile || '').trim();
  if (!value) return null;
  const row = await prisma.authProfile
    .findFirst({
      where: { projectId, OR: [{ id: value }, { name: value }] },
      select: { id: true },
    })
    .catch(() => null);
  return row ? row.id : null;
}

async function attachOperationCapabilities({ projectId, results }) {
  const cache = new Map();
  for (const r of results || []) {
    const plan = r && r.operationPlan;
    const hasOps = plan && Array.isArray(plan.operations) && plan.operations.length;
    if (!hasOps || !r.moduleName) continue;
    const authProfileId = await authProfileIdForName(projectId, r.authProfile);
    const key = `${String(r.moduleName).toLowerCase()}::${authProfileId || ''}`;
    if (!cache.has(key)) {
      const atlas = await getCalibrationAtlas(projectId, {
        module: r.moduleName,
        authProfileId,
      }).catch(() => null);
      cache.set(key, atlas && Array.isArray(atlas.capabilities) ? atlas.capabilities : []);
    }
    r.capabilities = cache.get(key);
  }
  return results;
}

function combineSiblingPomExports({ javascript, typescript } = {}) {
  if (!javascript || !typescript) {
    const err = new Error(
      'Both JavaScript and TypeScript exports are required for a sibling POM bundle.',
    );
    err.code = 'SIBLING_EXPORT_INCOMPLETE';
    throw err;
  }
  const files = {};
  for (const [language, child] of [
    ['javascript', javascript],
    ['typescript', typescript],
  ]) {
    for (const [rel, content] of Object.entries(child.files || {})) {
      files[`${language}/${rel}`] = content;
    }
  }
  const findings = [
    ...(javascript.findings || []).map((finding) => ({ ...finding, renderer: 'javascript' })),
    ...(typescript.findings || []).map((finding) => ({ ...finding, renderer: 'typescript' })),
  ];
  const manifest = {
    schema: 'qaai-sibling-pom-export/1',
    adapterId: 'playwright-pom-dual',
    source: 'ExecutedCaseASTV1',
    secondConductorRunRequired: false,
    runId: javascript.runId || typescript.runId || null,
    exportValid:
      javascript.manifest?.exportValid === true && typescript.manifest?.exportValid === true,
    renderers: {
      javascript: {
        adapterId: javascript.adapterId,
        bundleId: javascript.bundleId,
        root: 'javascript/',
      },
      typescript: {
        adapterId: typescript.adapterId,
        bundleId: typescript.bundleId,
        root: 'typescript/',
      },
    },
    enabledTestCounts: {
      javascript: Number(javascript.manifest?.executedCaseAst?.enabledTestCount || 0),
      typescript: Number(typescript.manifest?.executedCaseAst?.enabledTestCount || 0),
    },
  };
  manifest.testInventoryParity =
    manifest.enabledTestCounts.javascript === manifest.enabledTestCounts.typescript;
  if (!manifest.testInventoryParity) {
    findings.push({
      rule: 'sibling_enabled_test_inventory_mismatch',
      severity: 'error',
      message: `JavaScript lists ${manifest.enabledTestCounts.javascript} enabled tests while TypeScript lists ${manifest.enabledTestCounts.typescript}.`,
    });
    manifest.exportValid = false;
  }
  const bundleIntegrity = buildImmutableBundleEvidence(files, { adapterId: manifest.adapterId });
  files['evidence/bundle-integrity.json'] = JSON.stringify(bundleIntegrity, null, 2) + '\n';
  manifest.bundleId = bundleIntegrity.bundleId;
  manifest.fileHashes = bundleIntegrity.fileHashes;
  files['EXPORT_MANIFEST.json'] = JSON.stringify(manifest, null, 2) + '\n';
  return {
    files,
    manifest,
    bundleId: bundleIntegrity.bundleId,
    bundleIntegrity,
    admitted: javascript.admitted || [],
    blocked: [...(javascript.blocked || []), ...(typescript.blocked || [])],
    findings,
    validation: {
      javascript: javascript.validation || null,
      typescript: typescript.validation || null,
    },
    // "allBlocked" is true only when neither renderer produced an executable sibling.
    // A diagnostic in one language must never hide the other language's generated files.
    allBlocked: javascript.allBlocked === true && typescript.allBlocked === true,
    runId: manifest.runId,
    adapterId: manifest.adapterId,
    siblingExports: { javascript, typescript },
  };
}

// A qaai-controller-replay-v1 run's operationId is stamped
// `action:<caseId>:<stepId>` / `assertion:<caseId>:<assertionId>`
// (operationContractV2.js) — a shape the old actionTrail schema never
// produced. This is the one unambiguous signal available without touching
// any of the legacy-specific fields below. result.stepResults here is
// already the decodeJson()-parsed array (see loadResultsForExport), not a
// raw JSON string.
function isControllerReplaySchema(results) {
  return Array.isArray(results) && results.some((result) => {
    const steps = result?.stepResults;
    return Array.isArray(steps)
      && steps.length > 0
      && /^(?:action|assertion):/.test(String(steps[0]?.operationId || ''));
  });
}

/**
 * qaai-controller-replay-v1 runs are structurally incompatible with this
 * file's actionTrail-shaped pipeline (POM AST, BDD, credential binding,
 * _replayContract validation — all built for the old evidence shape, which
 * is why that path renders these runs as "zero execution provenance" even
 * when fully passing; see PHASE_LOG 2026-08-05). Delegate to the dedicated
 * live-evidence generator instead, and adapt its return shape to what
 * buildReplayExport's callers (outputFiles.js) already expect.
 */
async function buildLiveReplayExportCompat({ projectId, runId, framework, credentialValues }) {
  const pkg = await liveReplayCodegen.buildLiveReplayPackage({ projectId, runId, framework });
  const files = redactSecretLiteralsInFiles(pkg.files, [...(credentialValues || [])]);
  let manifest = {};
  try {
    manifest = JSON.parse(files['EXPORT_MANIFEST.json']) || {};
  } catch (_) {
    manifest = {};
  }
  return {
    files,
    manifest,
    bundleId: runId || null,
    bundleIntegrity: null,
    admitted: pkg.admitted,
    blocked: pkg.blocked,
    findings: [],
    validation: null,
    allBlocked: pkg.allBlocked,
    runId: runId || null,
    adapterId: framework,
  };
}

/**
 * Service entry. { projectId, runId?, runResultIds?, framework? } → the IR-sourced
 * export. Throws only on an unknown framework (a caller-level error); per-case problems
 * are surfaced as blocks/findings, never a fallback.
 */
async function buildReplayExport({
  projectId,
  runId = null,
  runResultIds = null,
  generationId = null,
  framework = 'playwright-reference',
  denyLiterals = [],
  validate = true,
  allowIncompletePreview = true,
}) {
  if (framework === 'playwright-pom-dual') {
    const shared = {
      projectId,
      runId,
      runResultIds,
      generationId,
      denyLiterals,
      validate,
      allowIncompletePreview,
    };
    const javascript = await buildReplayExport({ ...shared, framework: 'playwright-pom-js' });
    const typescript = await buildReplayExport({ ...shared, framework: 'playwright-pom' });
    return combineSiblingPomExports({ javascript, typescript });
  }
  const isPlaywrightBdd = framework === 'replayir-bdd';
  const isSeleniumBdd = framework === 'selenium-bdd-reference';
  const isBdd = isPlaywrightBdd || isSeleniumBdd;
  const adapter = isBdd ? null : registry.getAdapter(framework);
  if (!isBdd && !adapter) {
    const err = new Error(
      `Unknown export framework "${framework}". Available: ${[...registry.listAdapters(), 'replayir-bdd', 'selenium-bdd-reference'].join(', ')}.`,
    );
    err.code = 'UNKNOWN_FRAMEWORK';
    throw err;
  }

  const project = await prisma.project
    .findUnique({
      where: { id: projectId },
      select: { targetUrl: true, testCredentials: true },
    })
    .catch(() => null);
  const { runId: resolvedRunId, results } = await loadResultsForExport({
    projectId,
    runId,
    runResultIds,
    generationId,
  });
  const initialCredentialProfile = envContract.buildCredentialProfile({
    testCredentials: project && project.testCredentials,
  });
  const credentialValues = new Set(
    initialCredentialProfile.users
      .flatMap((user) => [user.username, user.password])
      .filter((value) => value && String(value).trim())
      .map((value) => String(value).trim()),
  );
  // See isControllerReplaySchema/buildLiveReplayExportCompat above. Intercepts
  // and routes all four Playwright live-replay frameworks: reference, reference-js, pom, pom-js.
  const LIVE_REPLAY_FRAMEWORKS = new Set([
    'playwright-reference',
    'playwright-reference-js',
    'playwright-pom',
    'playwright-pom-js',
  ]);
  if (LIVE_REPLAY_FRAMEWORKS.has(framework) && isControllerReplaySchema(results)) {
    return buildLiveReplayExportCompat({ projectId, runId: resolvedRunId, framework, credentialValues });
  }
  for (const result of results)
    prepareResultForExport(result, credentialValues.size ? credentialValues : null);
  if (POM_ADAPTER_IDS.has(framework)) {
    for (const result of results) {
      const executionContract = result && result.executionContract;
      const actionGraph = result && result.actionGraph;
      const replayIr = result && result.envelope && result.envelope.ir;
      if (!executionContract && !actionGraph && !replayIr) continue;
      const ast = executableTestContract.buildExecutedCaseAstV1({
        executionContract,
        caseInstance: (executionContract && executionContract.caseInstanceV1) || null,
        actionGraph,
        replayEnvelope: (result && result.envelope) || null,
        stepResults: (result && result.stepResults) || [],
        runResult: result,
        runResultId: (result && result.runResultId) || null,
        testCaseId: (result && result.testCaseId) || null,
        caseName: (result && result.caseName) || null,
        generationId: (executionContract && executionContract.generationId) || generationId || null,
        status: (result && result.status) || null,
      });
      ast.validation = executableTestContract.validateExecutedCaseAstV1(ast);
      result.executedCaseAst = ast;
      projectPlaywrightPomResultThroughExecutedAst(result);
    }
  }
  const credentialEnvironment = bindCredentialEnvironment({
    testCredentials: project && project.testCredentials,
    results,
  });
  await attachOperationCapabilities({ projectId, results });
  const envelopes = results.map((r) => r.envelope).filter(Boolean);
  const targetUrl = deriveTargetUrlFromResults(results, project && project.targetUrl);

  // ── Assertion cardinality pre-check ──────────────────────────────────────────
  // Compare each case's authored declaredAssertions to its live assertionCheckResults.
  // Cardinality mismatches are QAAI-side certification gaps, not website failures.
  // They remain warning-level so the runnable export stays usable while the manifest
  // makes the missing/extra assertion evidence visible.
  const assertionCardinalityFindings = buildAssertionCardinalityFindings(results);
  const readinessDiagnostics = results
    .filter(
      (r) => r.runEligibility && r.runEligibility !== readinessCompiler.RUN_ELIGIBILITY.ALLOWED,
    )
    .map((r) => ({
      runResultId: r.runResultId,
      testCaseId: r.testCaseId,
      code: 'export_readiness_diagnostic',
      readinessStatus: r.readinessStatus || 'blocked',
      reasons: Array.isArray(r.readinessReasons) ? r.readinessReasons : [],
      severity: 'warning',
      nonBlocking: true,
    }));
  const exportResults = results;

  let admitted;
  let blocked;
  let manifestEntries;
  let findings;
  let adapterId;
  let adapterVersion;
  let locators = null;
  let operationFiles = null;
  if (isPlaywrightBdd) {
    ({
      admitted,
      blocked,
      manifestEntries,
      findings,
      adapterId,
      adapterVersion,
      locators,
      operationFiles,
    } = replayIrBdd.compileResults({ results: exportResults }));
  } else if (isSeleniumBdd) {
    ({ admitted, blocked, manifestEntries, findings, adapterId, adapterVersion, locators } =
      seleniumBddReference.compileResults({ results: exportResults }));
  } else {
    ({ admitted, blocked, manifestEntries, findings, adapterId, adapterVersion } = compileResults({
      adapter,
      results: exportResults,
      allowIncompletePreview,
    }));
  }
  if (readinessDiagnostics.length) {
    findings.push(
      ...readinessDiagnostics.map((diagnostic) => ({
        rule: 'export_readiness_diagnostic',
        severity: 'warning',
        nonBlocking: true,
        runResultId: diagnostic.runResultId,
        testCaseId: diagnostic.testCaseId,
        readinessStatus: diagnostic.readinessStatus,
        reasons: diagnostic.reasons,
        message: `Source readiness is '${diagnostic.readinessStatus}'. Script generation continued through the selected framework adapter.`,
      })),
    );
  }
  findings.push(...assertionCardinalityFindings);

  let allBlocked = admitted.length === 0;
  let files = {};
  let validation = null;
  let secretFindings = [];
  let scriptArtifacts = [];

  if (!allBlocked) {
    const envVars = collectEnvVars(envelopes, results.map((r) => r.operationPlan).filter(Boolean));
    const authState = await resolveAuthStateForPackage({ projectId, adapterId, envelopes });
    findings.push(...authState.findings);
    if (isPlaywrightBdd)
      files = replayIrBdd.assemblePackage({
        admitted,
        locators,
        envVars,
        authState,
        operationFiles,
        targetUrl,
        envDefaults: credentialEnvironment.defaults,
      });
    else if (isSeleniumBdd)
      files = seleniumBddReference.assemblePackage({
        admitted,
        locators,
        envVars,
        authState,
        targetUrl,
      });
    else if (typeof adapter?.assemblePackage === 'function')
      files = adapter.assemblePackage({
        admitted,
        envVars,
        authState,
        targetUrl,
        envDefaults: credentialEnvironment.defaults,
      });
    else
      files = assemblePackage({
        adapterId,
        admitted,
        envVars,
        authState,
        targetUrl,
        envDefaults: credentialEnvironment.defaults,
      });
    // DDT data files: per-case JSON files recorded inside _compilePerCase.
    // Each admitted item carries its own data file so there is no cross-case iteration.
    for (const a of admitted) {
      if (a.dataFilePath && a.dataFileContent) files[a.dataFilePath] = a.dataFileContent;
    }
    // Full original test data sources — one CSV per sheet from every TestDataSet
    // attached to this project. These are the master ledger files the QA engineer
    // can open in Excel; the per-case *.json files above are the row-slices that ran.
    const testDataSets = await prisma.testDataSet
      .findMany({
        where: { projectId },
        select: { id: true, name: true, sheetsJson: true },
      })
      .catch(() => []);
    const isSeleniumExport =
      adapterId === 'selenium-reference' ||
      adapterId === 'selenium-pom' ||
      adapterId === 'selenium-bdd-reference';
    const testDataPrefix = isSeleniumExport ? 'src/test/resources/test-data' : 'tests/data';
    const testDataCsvFiles = buildTestDataFiles(testDataSets, testDataPrefix);
    Object.assign(files, testDataCsvFiles);
    const dataMatrixCoverage = buildDataMatrixCoverageReport({ results, testDataSets });
    files['evidence/data-matrix-coverage.json'] =
      JSON.stringify(dataMatrixCoverage, null, 2) + '\n';
    if (Array.isArray(dataMatrixCoverage.findings) && dataMatrixCoverage.findings.length) {
      findings.push(...dataMatrixCoverage.findings);
    }
    if (files['README.md'] && Object.keys(testDataCsvFiles).length > 0) {
      files['README.md'] +=
        '\n\n**Test data:**\n`tests/data/*.xlsx` is the human-readable master workbook exported from the uploaded dataset.\n`tests/data/*.csv` files are sheet-level fallbacks for tools that prefer plain text.\nPer-case `*.json` files are the row slices the generated specs actually execute.\n';
    }
    files = evidenceConsistency.reconcileGeneratedEvidence({ files, adapterId });
    secretFindings = scanSecrets(files, denyLiterals);
    // Sanitizer observability: collect which per-case specs required mechanical repair.
    // Each entry = a generator defect that shipped to the user instead of being fixed upstream.
    // The list should trend toward zero in a fully certified system.
    const allSanitizerRewrites = admitted.flatMap((a) =>
      Array.isArray(a.sanitizerRewrites) ? a.sanitizerRewrites : [],
    );
    if (allSanitizerRewrites.length) {
      files['evidence/sanitizer-log.json'] =
        JSON.stringify(
          {
            note: 'Files that required mechanical sanitizer repair during this export. Each entry represents a generator defect — the exported spec is correct, but the generator produced invalid code that had to be patched at export time. Goal: this list reaches zero.',
            totalRepaired: allSanitizerRewrites.length,
            rewrites: allSanitizerRewrites,
          },
          null,
          2,
        ) + '\n';
    }
    // Spec checkpoint: AST parse + selector-leak scan on every emitted spec.
    // Syntax errors block the export (severity: 'error'). Quality warnings (force:true,
    // inline resolveLocator in POM) surface in findings but don't block.
    const cpResult = checkpointAll(files, { framework: adapterId });
    if (!cpResult.ok || cpResult.allErrors.length) {
      findings.push(...cpResult.allErrors.map((e) => ({ ...e, type: 'checkpoint-spec' })));
    }
    if (validate) {
      validation = await validateAssembled({ adapterId, files });
      if (validation && validation.repairedFiles) {
        files = validation.repairedFiles;
        files = scriptValidationRunner.hardenPlaywrightPackageFiles(files, {
          framework: adapterId,
        });
        files = evidenceConsistency.reconcileGeneratedEvidence({ files, adapterId });
        refreshManifestFileHashes(manifestEntries, files);
        const repairCheckpoint = checkpointAll(files, { framework: adapterId });
        if (!repairCheckpoint.ok || repairCheckpoint.allErrors.length) {
          findings.push(
            ...repairCheckpoint.allErrors.map((e) => ({
              ...e,
              type: 'checkpoint-spec-after-repair',
            })),
          );
        }
      }
    }
    if (validate && validation && validation.skipped) {
      findings.push({
        rule: 'package_validation_skipped_export_gate',
        severity: 'warning',
        nonBlocking: true,
        message:
          'Package validation was skipped, so replay health could not be checked. Install the required local dependencies and rerun export validation.',
        validationFindings: validation.findings || [],
      });
    }
    const stepLedger = stepCompilationLedger.buildStepCompilationLedger({
      results,
      admitted,
      blocked,
      files,
      adapterId,
    });
    files['evidence/step-parity-report.json'] = JSON.stringify(stepLedger, null, 2) + '\n';
    if (Array.isArray(stepLedger.findings) && stepLedger.findings.length) {
      findings.push(...stepLedger.findings);
    }
    const contractCertification = executableTestContract.certifyContractExport({
      results,
      files,
      validation,
      stepLedger,
    });
    contractCertification.findings = (contractCertification.findings || []).map(
      downgradeAdvisoryLocatorFinding,
    );
    contractCertification.errorCount = contractCertification.findings.filter(
      (finding) => finding && finding.severity === 'error',
    ).length;
    contractCertification.warningCount = contractCertification.findings.filter(
      (finding) => finding && finding.severity === 'warning',
    ).length;
    contractCertification.packagePassed =
      contractCertification.errorCount === 0 && (!validation || validation.packagePassed !== false);
    files['evidence/contract-certification-report.json'] =
      JSON.stringify(contractCertification, null, 2) + '\n';
    if (Array.isArray(contractCertification.findings) && contractCertification.findings.length) {
      findings.push(...contractCertification.findings);
    }
    const actionLedger = buildActionAuthoringLedger({ results });
    files['evidence/action-authoring-ledger.json'] = JSON.stringify(actionLedger, null, 2) + '\n';
    const valueBindingMap = buildValueBindingMap({ files });
    files['evidence/value-binding-map.json'] = JSON.stringify(valueBindingMap, null, 2) + '\n';
    const runArtifactPlane = buildRunArtifactPlane({ results });
    files['evidence/run-artifact-plane.json'] = JSON.stringify(runArtifactPlane, null, 2) + '\n';
    const artifactGraph = buildArtifactGraph({ files, adapterId });
    files['evidence/artifact-graph.json'] = JSON.stringify(artifactGraph, null, 2) + '\n';
    const targetParity = buildTargetParityReport({ files, targetUrl });
    files['evidence/target-parity-report.json'] = JSON.stringify(targetParity, null, 2) + '\n';
    const traceabilityMatrix = buildTraceabilityMatrix({
      results,
      admitted,
      blocked,
      files,
      actionLedger,
      validation,
      targetUrl,
    });
    files['evidence/traceability-matrix.json'] = JSON.stringify(traceabilityMatrix, null, 2) + '\n';
    const cardinalityFindings = buildCardinalityContractFindings({ results, files });
    const targetParityFindings = targetParity.ok
      ? []
      : [
          {
            rule: 'same_target_runtime_parity_failed',
            severity: 'error',
            message:
              'Exported package target URL does not match the project/run target, or playwright.config.ts can still be overridden by the parent process environment.',
            targetParity,
          },
        ];
    const invariantFindings = [
      ...(actionLedger.findings || []),
      ...cardinalityFindings,
      ...targetParityFindings,
    ];
    if (invariantFindings.length) findings.push(...invariantFindings);
    files['evidence/runtime-result-firewall.json'] =
      JSON.stringify(
        buildRuntimeResultFirewallReport({
          results,
          validation,
          blocked,
          findings,
        }),
        null,
        2,
      ) + '\n';
    if (validate && validation) {
      validation = appendValidationFindings(validation, [
        ...(stepLedger.findings || []),
        ...(contractCertification.findings || []),
        ...invariantFindings,
      ]);
      refreshPomCertificationReport(adapterId, files, validation);
    }
    scriptArtifacts = admitted
      .filter((entry) => entry && entry.filePath)
      .flatMap((entry) => {
        const diagnosticOnly = entry.diagnosticOnly === true;
        const runIds =
          Array.isArray(entry.runResultIds) && entry.runResultIds.length
            ? entry.runResultIds
            : [entry.runResultId || null];
        const caseIds =
          Array.isArray(entry.testCaseIds) && entry.testCaseIds.length
            ? entry.testCaseIds
            : [entry.testCaseId || null];
        return runIds.map((runResultId, index) => ({
          testCaseId: caseIds[index] || caseIds[0] || null,
          runResultId: runResultId || null,
          file: entry.filePath,
          source: diagnosticOnly ? 'adapter_diagnostic' : 'replayir',
          scriptGenerationStatus: diagnosticOnly
            ? 'generated_with_diagnostics'
            : 'generated',
          scriptRunStatus: 'not_run',
          certificationStatus: diagnosticOnly ? 'diagnostic_only' : 'uncertified',
          blockers: [],
          repairHints: [],
        }));
      });
    const diagnosticResults = exportResults.filter(
      (result) => !resultHasPositiveExecution(result),
    );
    if (diagnosticResults.length) {
      const diagnosticPackage = buildBlockedPreviewPackage({
        adapterId,
        adapterVersion,
        results: diagnosticResults,
        blocked,
        findings,
        targetUrl,
        envDefaults: credentialEnvironment.defaults,
      });
      let diagnosticManifest = {};
      try {
        diagnosticManifest = JSON.parse(diagnosticPackage['EXPORT_MANIFEST.json'] || '{}');
      } catch (_) {
        diagnosticManifest = {};
      }
      const diagnosticArtifacts = Array.isArray(diagnosticManifest.scriptArtifacts)
        ? diagnosticManifest.scriptArtifacts
        : Array.isArray(diagnosticManifest.artifacts)
          ? diagnosticManifest.artifacts
          : [];
      const usedArtifactPaths = new Set(Object.keys(files));
      for (const artifact of diagnosticArtifacts) {
        const sourcePath = artifact && artifact.file;
        if (!sourcePath || !Object.prototype.hasOwnProperty.call(diagnosticPackage, sourcePath))
          continue;
        let targetPath = sourcePath;
        let content = diagnosticPackage[sourcePath];
        if (usedArtifactPaths.has(targetPath)) {
          if (/\.java$/i.test(targetPath)) {
            const classMatch = String(content).match(/\bpublic\s+class\s+([A-Za-z_$][\w$]*)/);
            const originalClass = classMatch && classMatch[1];
            const directory = targetPath.replace(/[^/]+$/, '');
            let suffix = 2;
            let replacementClass = `${originalClass || 'GeneratedCase'}Diagnostic${suffix}`;
            targetPath = `${directory}${replacementClass}.java`;
            while (usedArtifactPaths.has(targetPath)) {
              suffix += 1;
              replacementClass = `${originalClass || 'GeneratedCase'}Diagnostic${suffix}`;
              targetPath = `${directory}${replacementClass}.java`;
            }
            if (originalClass)
              content = String(content).replace(
                new RegExp(`\\b${originalClass}\\b`, 'g'),
                replacementClass,
              );
          } else {
            targetPath = uniqueSemanticPath(targetPath, usedArtifactPaths);
          }
        }
        usedArtifactPaths.add(targetPath);
        files[targetPath] = content;
        scriptArtifacts.push({
          ...artifact,
          file: targetPath,
          source: 'authored_contract_diagnostic',
          scriptGenerationStatus: 'generated_with_diagnostics',
          certificationStatus: 'diagnostic_only',
        });
      }
    }
  } else {
    files = buildBlockedPreviewPackage({
      adapterId,
      adapterVersion,
      results: exportResults,
      blocked,
      findings,
      targetUrl,
      envDefaults: credentialEnvironment.defaults,
    });
    let selectedManifest = {};
    try {
      selectedManifest = JSON.parse(files['EXPORT_MANIFEST.json'] || '{}');
    } catch (_) {
      selectedManifest = {};
    }
    scriptArtifacts = Array.isArray(selectedManifest.scriptArtifacts)
      ? selectedManifest.scriptArtifacts
      : Array.isArray(selectedManifest.artifacts)
        ? selectedManifest.artifacts
        : [];
    if (scriptArtifacts.length) {
      allBlocked = false;
      adapterId = selectedManifest.adapterId || adapterId;
      adapterVersion = selectedManifest.adapterVersion || adapterVersion;
      if (Array.isArray(selectedManifest.entries) && selectedManifest.entries.length)
        manifestEntries = selectedManifest.entries;
    }
    secretFindings = scanSecrets(files, denyLiterals);
  }
  files['evidence/authored-runtime-traceability.json'] =
    JSON.stringify(buildAuthoredRuntimeTraceabilityDocument(results), null, 2) + '\n';
  let captureFirstEvidencePackage = addCaptureFirstEvidenceFiles(files, results);
  const refreshedCaptureFirstLedger = refreshCaptureFirstLedgerCounts(files, {
    scriptArtifacts,
    validation,
    results,
  });
  if (refreshedCaptureFirstLedger && captureFirstEvidencePackage) {
    captureFirstEvidencePackage = {
      ...captureFirstEvidencePackage,
      summary: {
        ...(captureFirstEvidencePackage.summary || {}),
        ...(refreshedCaptureFirstLedger.summary || {}),
      },
    };
  }
  const executedAstEvidence = buildExecutedCaseAstEvidence({ results, generationId });
  Object.assign(files, executedAstEvidence.files);
  findings.push(...executedAstEvidence.findings);
  ensureCaptureFirstFixtureFiles(files, { adapterId, results });
  pruneUnreferencedAuthSetup(files);
  if (adapterId === 'playwright-pom-js') files = filterEnvFilesToGeneratedReferences(files);
  files = await generatedOutputQuality.formatGeneratedFileMap(files);
  files = redactSecretLiteralsInFiles(files, denyLiterals);
  secretFindings = scanSecrets(files, denyLiterals).map((finding) => ({
    ...finding,
    severity: 'warning',
    nonBlocking: true,
  }));

  const sourceHashParity = refreshManifestEntryFileHashes(manifestEntries, files);
  manifestEntries = sourceHashParity.entries;
  const manifest = buildManifest({
    projectId,
    runId: resolvedRunId,
    adapterId,
    adapterVersion,
    manifestEntries,
    validation,
    allBlocked,
  });
  manifest.sourceHashParity = sourceHashParity.summary;
  // If a secret leaked or the package failed validation, the export is INVALID (surfaced).
  manifest.secretFindings = secretFindings;
  manifest.artifacts = scriptArtifacts;
  manifest.scriptArtifacts = scriptArtifacts;
  try {
    const runArtifactPlane = JSON.parse(files['evidence/run-artifact-plane.json'] || '{}');
    manifest.runArtifactPlane = runArtifactPlane.summary || null;
  } catch (_) {
    manifest.runArtifactPlane = null;
  }
  const strictExportFindings = assessStrictReplayExport({ results, scriptArtifacts }).map(
    (finding) => ({
      ...finding,
      severity: 'warning',
      nonBlocking: true,
    }),
  );
  if (strictExportFindings.length) findings.push(...strictExportFindings);
  const strictExportErrors = strictExportFindings.filter(
    (finding) => finding && finding.severity === 'error',
  );
  manifest.strictExport = {
    required: false,
    diagnosticsOnly: true,
    ok: strictExportErrors.length === 0,
    findingCount: strictExportFindings.length,
    errorCount: strictExportErrors.length,
    warningCount: strictExportFindings.filter(
      (finding) => finding && finding.severity === 'warning',
    ).length,
    rules: [...new Set(strictExportFindings.map((finding) => finding.rule).filter(Boolean))],
  };
  manifest.strictExportFindings = strictExportFindings;
  manifest.assertionCardinalityFindings = assertionCardinalityFindings;
  manifest.assertionCoverageFindings = assertionCardinalityFindings;
  manifest.captureFirstEvidence = captureFirstEvidencePackage
    ? captureFirstEvidencePackage.summary
    : null;
  manifest.immutableExecutionEvidence = captureFirstEvidencePackage
    ? captureFirstEvidencePackage.immutableExecutionEvidence || null
    : null;
  manifest.postRunMaterialization = captureFirstEvidencePackage
    ? captureFirstEvidencePackage.postRunMaterialization || null
    : null;
  manifest.executedCaseAst = {
    schema: executedAstEvidence.inventory.schema,
    source: 'ExecutedCaseASTV1',
    astCount: executedAstEvidence.inventory.astCount,
    validatedCount: executedAstEvidence.inventory.validatedCount,
    invalidCount: executedAstEvidence.inventory.invalidCount,
    enabledTestCount: executedAstEvidence.inventory.enabledTestCount,
    enabledProductFailureCount: executedAstEvidence.inventory.enabledProductFailureCount,
    renderers: executedAstEvidence.inventory.sharedRendererContract,
  };
  const liveScriptLedgers = (results || [])
    .map((result) => result && result.liveScriptLedger)
    .filter(Boolean);
  const liveScriptLines = liveScriptLedgers.flatMap((ledger) =>
    liveScriptRecorder.canonicalLines(ledger),
  );
  const weakLocatorCount = liveScriptLedgers.reduce(
    (sum, ledger) => sum + Number((ledger.health && ledger.health.weakLocatorCount) || 0),
    0,
  );
  const nonRunnableLineCount = liveScriptLedgers.reduce(
    (sum, ledger) => sum + Number((ledger.health && ledger.health.nonRunnableLineCount) || 0),
    0,
  );
  manifest.liveScriptRecorder = {
    schema: 'qaai-live-script-recorder-summary/1',
    scriptGenerated: liveScriptLines.length > 0,
    scriptReplayChecked: validation ? validationPassedForGeneratedCounts(validation) : false,
    scriptHealth:
      nonRunnableLineCount > 0
        ? 'needs_repair'
        : weakLocatorCount > 0
          ? 'generated_with_weak_locators'
          : liveScriptLines.length
            ? 'generated'
            : 'no_executable_history',
    locatorCoveragePercent: liveScriptLines.length
      ? Math.round(((liveScriptLines.length - weakLocatorCount) / liveScriptLines.length) * 100)
      : 0,
    actionCoveragePercent: liveScriptLines.length ? 100 : 0,
    assertionCoveragePercent: liveScriptLines.some((line) => line.kind === 'assert') ? 100 : 0,
    reproducesRunFailure: liveScriptLedgers.some(
      (ledger) => ledger.health && ledger.health.reproducesRunFailure,
    ),
    missingStableLocatorCount: weakLocatorCount,
    weakLocatorCount,
    traceArtifactCount: liveScriptLedgers.reduce(
      (sum, ledger) => sum + Number(ledger.traceArtifactCount || 0),
      0,
    ),
  };
  manifest.sanitizerRewrites = allBlocked
    ? []
    : admitted.flatMap((a) => (Array.isArray(a.sanitizerRewrites) ? a.sanitizerRewrites : []));
  if (!allBlocked && files['evidence/step-parity-report.json']) {
    const parsedStepLedger = JSON.parse(files['evidence/step-parity-report.json']);
    manifest.stepCompilationLedger = parsedStepLedger.summary || null;
    manifest.stepCompilationFindings = parsedStepLedger.findings || [];
  } else {
    manifest.stepCompilationLedger = null;
    manifest.stepCompilationFindings = [];
  }
  if (!allBlocked && files['evidence/contract-certification-report.json']) {
    const parsedContract = JSON.parse(files['evidence/contract-certification-report.json']);
    manifest.contractCertification = {
      contractFirstActive: !!parsedContract.contractFirstActive,
      packagePassed: parsedContract.packagePassed,
      executableResultCount: parsedContract.executableResultCount,
      generatedRunnableTestCount: parsedContract.generatedRunnableTestCount,
      errorCount: parsedContract.errorCount || 0,
      repairTaskCount: Array.isArray(parsedContract.repairTasks)
        ? parsedContract.repairTasks.length
        : 0,
    };
    manifest.contractCertificationFindings = parsedContract.findings || [];
  } else {
    manifest.contractCertification = null;
    manifest.contractCertificationFindings = [];
  }
  const packageValidationPassed =
    !!validation &&
    validation.skipped !== true &&
    validation.packagePassed === true &&
    Number(validation.errorCount || 0) === 0;
  const contractValidationPassed =
    !!manifest.contractCertification &&
    manifest.contractCertification.packagePassed === true &&
    Number(manifest.contractCertification.errorCount || 0) === 0;
  const locatorReadiness = outputReadiness.summarizeLocatorReadiness(files);
  const outputErrorFindings = [...(findings || []), ...secretFindings].filter(
    (finding) => finding && finding.severity === 'error',
  );
  manifest.outputAvailable = scriptArtifacts.length > 0;
  manifest.packagePassed = packageValidationPassed;
  manifest.packageValidationStatus = !validation
    ? 'not_checked'
    : validation.skipped === true
      ? 'skipped'
      : packageValidationPassed
        ? 'passed'
        : 'failed';
  manifest.scriptRunStatus = 'not_run';
  manifest.exportValid =
    !allBlocked &&
    packageValidationPassed &&
    contractValidationPassed &&
    outputErrorFindings.length === 0 &&
    locatorReadiness.allVerified;
  const readiness = outputReadiness.evaluateOutputReadiness({
    outputAvailable: manifest.outputAvailable,
    preparing: 0,
    failedSafety: 0,
    exportValid: manifest.exportValid,
    packagePassed: manifest.packagePassed,
    contractCertification: manifest.contractCertification,
    contractFindings: manifest.contractCertificationFindings,
    errorFindings: outputErrorFindings,
    files,
    scriptValidation: null,
  });
  manifest.readiness = readiness;
  manifest.downloadable = readiness.downloadable;
  manifest.runnable = readiness.runnable;
  manifest.certified = readiness.certified;
  if (scriptArtifacts.length) {
    let currentLive = {};
    if (files['evidence/live-output-status.json']) {
      try {
        currentLive = JSON.parse(files['evidence/live-output-status.json']);
      } catch (_) {
        currentLive = {};
      }
    }
    files['evidence/live-output-status.json'] =
      JSON.stringify(
        {
          schema: 'qaai-live-output-status/1',
          ...currentLive,
          status: manifest.exportValid ? 'generated_not_run' : 'generated_draft',
          allBlocked,
          exportValid: manifest.exportValid,
          packagePassed: manifest.packagePassed,
          packageValidationStatus: manifest.packageValidationStatus,
          scriptRunStatus: manifest.scriptRunStatus,
          outputAvailable: manifest.outputAvailable,
          downloadable: readiness.downloadable,
          runnable: readiness.runnable,
          certified: readiness.certified,
          readiness,
          adapterId: adapterId || null,
          adapterVersion: adapterVersion || null,
          totalCases: results.length,
          admitted: admitted.length || scriptArtifacts.length,
          blocked: blocked.length,
          captureFirstEvidence: captureFirstEvidencePackage
            ? captureFirstEvidencePackage.summary
            : null,
          immutableExecutionEvidence: manifest.immutableExecutionEvidence,
          postRunMaterialization: manifest.postRunMaterialization,
          runArtifactPlane: manifest.runArtifactPlane,
          artifacts: scriptArtifacts,
          scriptArtifacts,
          findings: (findings || []).slice(0, 50),
          message: manifest.exportValid
            ? 'QAAI generated and statically validated script artifacts. Run Playwright validation to establish runnable status.'
            : 'QAAI generated visible script artifacts. Readiness gaps describe what still needs verification; files remain downloadable.',
          generatedAt: currentLive.generatedAt || new Date().toISOString(),
        },
        null,
        2,
      ) + '\n';
  }
  const activationReceipt = buildOutputActivationReceipt({
    adapterId,
    adapterVersion,
    scriptArtifacts,
    allBlocked,
  });
  files['evidence/output-activation-receipt.json'] =
    JSON.stringify(activationReceipt, null, 2) + '\n';
  manifest.activationReceipt = {
    file: 'evidence/output-activation-receipt.json',
    schema: activationReceipt.schema,
    active: activationReceipt.active,
    adapterId: activationReceipt.selectedFramework.adapterId,
    artifactCount: activationReceipt.output.artifactCount,
  };
  const bundleIntegrity = buildImmutableBundleEvidence(files, {
    adapterId,
    astInventory: executedAstEvidence.inventory,
  });
  files['evidence/bundle-integrity.json'] = JSON.stringify(bundleIntegrity, null, 2) + '\n';
  manifest.bundleId = bundleIntegrity.bundleId;
  manifest.bundleIntegrityFile = 'evidence/bundle-integrity.json';
  manifest.fileHashes = bundleIntegrity.fileHashes;
  files['EXPORT_MANIFEST.json'] = JSON.stringify(manifest, null, 2) + '\n';

  return {
    files,
    manifest,
    bundleId: bundleIntegrity.bundleId,
    bundleIntegrity,
    admitted,
    blocked,
    findings: [...findings, ...secretFindings],
    validation,
    allBlocked,
    runId: resolvedRunId,
    adapterId,
  };
}

module.exports = {
  buildReplayExport,
  // pure core (guarded directly):
  compileResults,
  assemblePackage,
  scanSecrets,
  redactSecretLiteralsInFiles,
  buildManifest,
  wrapForVerdict,
  reduceAssertionOutcomes,
  buildAssertionCardinalityFindings,
  buildExecutedCaseAstEvidence,
  projectPlaywrightPomResultThroughExecutedAst,
  projectPlaywrightPomJsResultThroughExecutedAst: projectPlaywrightPomResultThroughExecutedAst,
  buildOutputActivationReceipt,
  refreshManifestEntryFileHashes,
  buildImmutableBundleEvidence,
  combineSiblingPomExports,
  buildBlockedPreviewPackage,
  deriveLoginPrecondition,
  journeyNeedsLoginPrecondition,
  caseOperatesOnLoginPage,
  irPerformsLogin,
  journeyReferencesLogout,
  extractLoginBlock,
  deriveLogoutUrl,
  journeyPerformsLogout,
  journeyNeedsLogoutPrecondition,
  irHasOnlyFormValidationAsserts,
  journeyNeedsLogoutButCant,
  collectEnvVars,
  filterEnvFilesToGeneratedReferences,
  collectDataFiles,
  buildTestDataFiles,
  buildDataMatrixCoverageReport,
  authoredStepsForExport,
  buildAuthoredRuntimeTraceability,
  buildAuthoredRuntimeTraceabilityDocument,
  buildTraceabilityMatrix,
  envNameForRef,
  VALIDATE_FRAMEWORK,
  ADAPTER_VERSION,
  hashReplayIr,
  stableStringify,
  collectAuthStateRefs,
  resolveAuthStateForPackage,
  normalizeStorageStateFile,
  playwrightConfig,
  playwrightTestTimeoutMs,
  assessStrictReplayExport,
  hasConcreteReplayAssertion,
  replayArtifactIsStrict,
  normalizeTargetOrigin,
  deriveTargetUrlFromResults,
  envFile,
  bindCredentialEnvironment,
  applyPackageCertificationRepairs,
  validatePomFileGraph,
  appendValidationFindings,
  isPomSharedExtraFile,
  latestLedgerForResult,
  buildCaptureFirstEvidencePackage,
  _normalizeEvidenceRows: normalizeEvidenceRows,
  buildActionAuthoringLedger,
  addCaptureFirstEvidenceFiles,
  prepareResultForExport,
  hydrateReplayIrFromCaptureEvidence,
  completeReplayIrLocators,
  _compileJourneyGroup,
  _compilePerCase,
  // fs:
  validateAssembled,
  loadResultsForExport,
};
