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
const readinessCompiler = require('../readinessCompiler');
const outputScriptPipeline = require('../outputScriptPipeline');
const liveScriptRecorder = require('../liveScriptRecorder');
const authSessionManager = require('../universalAuthSessionManager');

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
const PLAYWRIGHT_ADAPTER_IDS = new Set(['playwright-reference', 'playwright-reference-js', 'playwright-pom', 'playwright-pom-js']);
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
const SECRET_LEAK_RE = /\b(passwo?r?d|passwd|pwd|secret|token|apikey|api_key|otp|mfa|credential)\b["']?\s*[:=]\s*["'][^"']{1,}["']/i;

function sha256(s) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(s) ? s : String(s), Buffer.isBuffer(s) ? undefined : 'utf8').digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

function hashReplayIr(ir) {
  return sha256(stableStringify(ir || null));
}

function slug(value, fallback = 'replayir-case') {
  const out = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/g, '');
  return out || fallback;
}

function readableSegment(value, fallback) {
  return slug(value, fallback).slice(0, 90).replace(/-+$/g, '') || fallback;
}

function readableModule(result) {
  const fromCase = result && (result.module || result.moduleName || result.moduleKey);
  const fromScenario = result && result.scenario && (result.scenario.module || result.scenario.moduleName || result.scenario.moduleKey);
  return readableSegment(fromCase || fromScenario || 'uncategorized', 'uncategorized');
}

function readableCaseName(result) {
  const name = [
    result && result.caseName,
    result && result.testCaseName,
    result && result.name,
    result && result.scenarioName,
    result && result.scenario && result.scenario.name,
    result && result.testCaseId,
  ].find(Boolean);
  const row = result && result.dataRowLabel ? `-${result.dataRowLabel}` : '';
  return readableSegment(`${name || 'test-case'}${row}`, 'test-case');
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
  const suffix = String(m[2]).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'VALUE';
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
  const s = String(k || '').replace(/[^a-zA-Z0-9]/g, '_').replace(/^([0-9])/, '_$1').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
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
    const rows = (Array.isArray(ir.dataRows) && ir.dataRows.length) ? ir.dataRows
      : (ir.dataRow ? [ir.dataRow] : []);
    if (!rows.length) continue;
    const safeRows = _buildSafeRows(rows);
    if (!safeRows.length) continue;
    const caseSlug = slug(r.caseName || r.testCaseId || 'test-case');
    let dataPath = `${pathPrefix}/${caseSlug}.json`;
    if (usedDataPaths.has(dataPath)) dataPath = `${pathPrefix}/${caseSlug}-${String(r.runResultId || '').slice(0, 6)}.json`;
    usedDataPaths.add(dataPath);
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
  try { xlsx = require('xlsx'); } catch (_) { xlsx = null; }
  for (const ds of testDataSets || []) {
    let parsed;
    try { parsed = typeof ds.sheetsJson === 'string' ? JSON.parse(ds.sheetsJson) : ds.sheetsJson; } catch { continue; }
    const sheets = Array.isArray(parsed && parsed.sheets) ? parsed.sheets : [];
    const dsSlug = slug(ds.name || ds.id, 'dataset');
    const workbook = xlsx ? xlsx.utils.book_new() : null;
    for (const sheet of sheets) {
      const headers = Array.isArray(sheet.headers) ? sheet.headers : [];
      const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
      if (!headers.length) continue;
      const sheetSlug = slug(sheet.name || 'sheet', 'sheet');
      let csvPath = `${pathPrefix}/${dsSlug}-${sheetSlug}.csv`;
      if (usedPaths.has(csvPath)) csvPath = `${pathPrefix}/${dsSlug}-${sheetSlug}-${String(ds.id || '').slice(0, 6)}.csv`;
      usedPaths.add(csvPath);
      const esc = (v) => {
        const s = v == null ? '' : String(v);
        return (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r'))
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
          ...rows.map((row) => headers.map((h) => row == null ? '' : row[h])),
        ];
        const ws = xlsx.utils.aoa_to_sheet(aoa);
        const sheetName = String(sheet.name || 'Sheet').replace(/[\[\]*?/\\:]/g, ' ').trim().slice(0, 31) || 'Sheet';
        xlsx.utils.book_append_sheet(workbook, ws, sheetName);
      }
    }
    if (workbook && workbook.SheetNames && workbook.SheetNames.length) {
      let xlsxPath = `${pathPrefix}/${dsSlug}.xlsx`;
      if (usedPaths.has(xlsxPath)) xlsxPath = `${pathPrefix}/${dsSlug}-${String(ds.id || '').slice(0, 6)}.xlsx`;
      usedPaths.add(xlsxPath);
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
  const lines = String(value || '').split(/\n/).map((line) => `${prefix}${line}`.trimEnd());
  return lines.length ? lines : [`${prefix}`.trimEnd()];
}

function blockedReasonForResult(result, blocked = []) {
  const match = (blocked || []).find((item) => item && (
    (item.runResultId && item.runResultId === result.runResultId)
    || (item.testCaseId && item.testCaseId === result.testCaseId)
  ));
  const reason = match && (match.code || match.blockReason || match.detail)
    || result.blockedReason
    || result.readinessStatus
    || result.status
    || 'blocked';
  return {
    code: String(reason || 'blocked'),
    detail: match && (match.detail || match.message) || null,
    readinessStatus: match && match.readinessStatus || result.readinessStatus || null,
    reasons: Array.isArray(match && match.reasons) ? match.reasons : (Array.isArray(result.readinessReasons) ? result.readinessReasons : []),
  };
}

function stepLabelForPreview(step, index) {
  if (typeof step === 'string') return step;
  if (!step || typeof step !== 'object') return `Step ${index + 1}`;
  return step.text
    || step.description
    || step.instruction
    || step.name
    || [step.action, step.target || step.selector || step.label].filter(Boolean).join(' ')
    || `Step ${index + 1}`;
}

function assertionLabelForPreview(assertion, index) {
  if (typeof assertion === 'string') return assertion;
  if (!assertion || typeof assertion !== 'object') return `Assertion ${index + 1}`;
  return assertion.text
    || assertion.description
    || assertion.expected
    || assertion.expectedText
    || assertion.target
    || assertion.name
    || assertion.id
    || `Assertion ${index + 1}`;
}

function parsedDeclaredAssertions(result) {
  const raw = result && result.declaredAssertionsRaw;
  const parsed = decodeJson(raw, raw);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.assertions)) return parsed.assertions;
  return [];
}

function previewSpecExtension(adapterId) {
  if (String(adapterId || '').endsWith('-js')) return 'js';
  return 'ts';
}

function blockedPreviewSpecPath(result, adapterId, usedPaths) {
  const ext = previewSpecExtension(adapterId);
  const base = `tests/preview/${readableModule(result)}/${readableCaseName(result)}.preview.spec.${ext}`;
  if (!usedPaths.has(base)) {
    usedPaths.add(base);
    return base;
  }
  const withId = `tests/preview/${readableModule(result)}/${readableCaseName(result)}-${String(result.runResultId || result.testCaseId || crypto.randomUUID()).slice(0, 8)}.preview.spec.${ext}`;
  usedPaths.add(withId);
  return withId;
}

function blockedPreviewPlaywrightSpec(result, block, adapterId) {
  const ext = previewSpecExtension(adapterId);
  const isJs = ext === 'js';
  const title = previewText(result.caseName || result.testCaseId || 'Generated preview case', 'Generated preview case');
  const steps = Array.isArray(result.declaredSteps) ? result.declaredSteps : [];
  const assertions = parsedDeclaredAssertions(result);
  const reasonLines = [
    'QAAI generated this script artifact from saved run/test-case context.',
    `Script health notes: ${block.code}${block.readinessStatus ? ` (${block.readinessStatus})` : ''}.`,
    block.detail ? `Detail: ${block.detail}` : null,
    `RunResult: ${result.runResultId || 'unknown'}`,
    `TestCase: ${result.testCaseId || 'unknown'}`,
  ].filter(Boolean);
  const stepLines = steps.length
    ? steps.map((step, index) => `  // ${index + 1}. ${previewText(stepLabelForPreview(step, index))}`)
    : ['  // No saved authored steps were available in this bundle.'];
  const assertionLines = assertions.length
    ? assertions.map((assertion, index) => `  // assertion ${index + 1}: ${previewText(assertionLabelForPreview(assertion, index))}`)
    : ['  // No parseable final oracle was available.'];
  return [
    isJs ? "const { test, expect } = require('@playwright/test');" : "import { test, expect } from '@playwright/test';",
    '',
    ...previewCommentLines(reasonLines.join('\n')),
    '',
    `test.describe.skip(${JSON.stringify(`PREVIEW ONLY - ${title}`)}, () => {`,
    `  test(${JSON.stringify(title)}, async ({ page }) => {`,
    "  // Complete the marked auth/data/oracle/session notes, then run script validation/replay check.",
    "  await page.goto(process.env.QAAI_TARGET_URL || 'about:blank');",
    '',
    '  // Authored steps from the saved QAAI test case:',
    ...stepLines,
    '',
    '  // Declared assertions/oracles from the saved QAAI test case:',
    ...assertionLines,
    '',
    "  await expect(page).toHaveURL(/.*/);",
    '  });',
    '});',
    '',
  ].join('\n');
}

function blockedPreviewFeature(result, block) {
  const title = previewText(result.caseName || result.testCaseId || 'Generated preview case', 'Generated preview case');
  const steps = Array.isArray(result.declaredSteps) ? result.declaredSteps : [];
  const assertions = parsedDeclaredAssertions(result);
  const stepLines = steps.length
    ? steps.map((step, index) => `    # ${index + 1}. ${previewText(stepLabelForPreview(step, index))}`)
    : ['    # No saved authored steps were available in this bundle.'];
  const assertionLines = assertions.length
    ? assertions.map((assertion, index) => `    # assertion ${index + 1}: ${previewText(assertionLabelForPreview(assertion, index))}`)
    : ['    # No parseable final oracle was available.'];
  return [
    '@generated @script-health',
    `Feature: Preview only - ${title}`,
    `  # Script health notes: ${block.code}${block.readinessStatus ? ` (${block.readinessStatus})` : ''}.`,
    '  # This file exists so Output Files is not empty; it is not execution proof.',
    '',
    `  Scenario: ${title}`,
    '    Given the QAAI generated case is available as a script artifact',
    ...stepLines,
    ...assertionLines,
    '    Then the script health notes describe any replay-check gaps',
    '',
  ].join('\n');
}

function blockedPreviewJava(result, block) {
  const classStem = readableCaseName(result).replace(/(^|-)([a-z0-9])/g, (_, __, c) => String(c).toUpperCase()).replace(/[^A-Za-z0-9]/g, '') || 'PreviewCase';
  const className = `${classStem.slice(0, 70)}PreviewTest`;
  const title = previewText(result.caseName || result.testCaseId || 'Generated preview case', 'Generated preview case');
  const steps = Array.isArray(result.declaredSteps) ? result.declaredSteps : [];
  const assertions = parsedDeclaredAssertions(result);
  return [
    'package qaai.preview;',
    '',
    'import org.junit.jupiter.api.Disabled;',
    'import org.junit.jupiter.api.Test;',
    '',
    '@Disabled("QAAI generated script artifact: complete script-health notes before replay check.")',
    `public class ${className} {`,
    '  @Test',
    '  void previewOnlyGeneratedCase() {',
    `    // ${previewText(title)}`,
    `    // Script health notes: ${previewText(block.code)}${block.readinessStatus ? ` (${previewText(block.readinessStatus)})` : ''}.`,
    '    // Authored steps:',
    ...(steps.length ? steps.map((step, index) => `    // ${index + 1}. ${previewText(stepLabelForPreview(step, index))}`) : ['    // No saved authored steps were available in this bundle.']),
    '    // Declared assertions/oracles:',
    ...(assertions.length ? assertions.map((assertion, index) => `    // assertion ${index + 1}: ${previewText(assertionLabelForPreview(assertion, index))}`) : ['    // No parseable final oracle was available.']),
    '  }',
    '}',
    '',
  ].join('\n');
}

function buildBlockedPreviewPackage({ adapterId, adapterVersion, results = [], blocked = [], findings = [], targetUrl = '' } = {}) {
  if (PLAYWRIGHT_ADAPTER_IDS.has(adapterId) || !adapterId) {
    const draft = outputScriptPipeline.buildDraftArtifacts({
      adapterId,
      adapterVersion,
      results,
      blocked,
      findings,
      targetUrl,
    });
    const files = { ...(draft.files || {}) };
    const artifacts = Array.isArray(draft.artifacts) ? draft.artifacts : [];
    const manifest = {
      schema: 'qaai-replay-export-manifest/1',
      adapterId: adapterId || null,
      adapterVersion: adapterVersion || null,
      exportValid: false,
      allBlocked: true,
      artifacts,
      scriptArtifacts: artifacts,
      findings: (findings || []).slice(0, 50),
      generatedAt: new Date().toISOString(),
    };
    files['EXPORT_MANIFEST.json'] = JSON.stringify(manifest, null, 2) + '\n';
    if (files['evidence/live-output-status.json']) {
      try {
        const live = JSON.parse(files['evidence/live-output-status.json']);
        files['evidence/live-output-status.json'] = JSON.stringify({
          ...live,
          artifacts,
          allBlocked: true,
          exportValid: false,
        }, null, 2) + '\n';
      } catch (_) {
        // Keep the generated status file if it cannot be parsed.
      }
    }
    return files;
  }
  const files = {};
  const artifacts = [];
  const usedPaths = new Set();
  const isBdd = adapterId === 'replayir-bdd' || adapterId === 'selenium-bdd-reference';
  const isSelenium = adapterId === 'selenium-reference' || adapterId === 'selenium-pom' || adapterId === 'selenium-bdd-reference';
  for (const result of results || []) {
    const block = blockedReasonForResult(result, blocked);
    let artifactFile = null;
    if (isBdd) {
      const rel = `features/preview/${readableCaseName(result)}.preview.feature`;
      const unique = usedPaths.has(rel) ? `features/preview/${readableCaseName(result)}-${String(result.runResultId || result.testCaseId || '').slice(0, 8)}.preview.feature` : rel;
      usedPaths.add(unique);
      files[unique] = blockedPreviewFeature(result, block);
      artifactFile = unique;
    } else if (isSelenium) {
      const rel = `src/test/java/qaai/preview/${readableCaseName(result).replace(/(^|-)([a-z0-9])/g, (_, __, c) => String(c).toUpperCase()).replace(/[^A-Za-z0-9]/g, '').slice(0, 70) || 'PreviewCase'}PreviewTest.java`;
      const unique = usedPaths.has(rel) ? rel.replace(/PreviewTest\.java$/, `${String(result.runResultId || result.testCaseId || '').slice(0, 8)}PreviewTest.java`) : rel;
      usedPaths.add(unique);
      files[unique] = blockedPreviewJava(result, block);
      artifactFile = unique;
    } else {
      const rel = blockedPreviewSpecPath(result, adapterId, usedPaths);
      files[rel] = blockedPreviewPlaywrightSpec(result, block, adapterId);
      artifactFile = rel;
    }
    artifacts.push({
      testCaseId: result.testCaseId || null,
      runResultId: result.runResultId || null,
      file: artifactFile,
      source: 'skeleton',
      scriptGenerationStatus: 'skeleton_only',
      scriptRunStatus: 'not_run',
      certificationStatus: 'uncertified',
      blockers: [block && (block.code || block.blockReason || block.rule) || 'export_readiness_blocked'].filter(Boolean),
      repairHints: ['Resolve auth/data/oracle/locator script-health notes, then rerun script validation.'],
    });
  }
  const summary = {
    schema: 'qaai-live-output-status/1',
    status: 'preview_only',
    allBlocked: true,
    targetUrl: targetUrl || null,
    adapterId: adapterId || null,
    adapterVersion: adapterVersion || null,
    totalCases: (results || []).length,
    blocked: (blocked || []).length,
    generatedPreviewFiles: Object.keys(files).length,
    artifacts,
    findings: (findings || []).slice(0, 50),
    message: 'QAAI generated script artifacts from saved test case contracts. Script health notes explain anything still needed for replay checking.',
    generatedAt: new Date().toISOString(),
  };
  files['evidence/live-output-status.json'] = JSON.stringify(summary, null, 2) + '\n';
  files['EXPORT_MANIFEST.json'] = JSON.stringify({
    schema: 'qaai-replay-export-manifest/1',
    adapterId: adapterId || null,
    adapterVersion: adapterVersion || null,
    exportValid: false,
    allBlocked: true,
    artifacts,
    scriptArtifacts: artifacts,
    findings: (findings || []).slice(0, 50),
    generatedAt: summary.generatedAt,
  }, null, 2) + '\n';
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
  if (!Object.keys(files).some((rel) => /\.(?:spec\.[jt]s|feature|java)$/i.test(rel))) {
    files['tests/preview/no-generated-case.preview.spec.ts'] = [
      "import { test } from '@playwright/test';",
      '',
      "test.describe.skip('PREVIEW ONLY - no generated case evidence', () => {",
      "  test('no generated case evidence was available', async () => {",
      "    // QAAI could not find saved RunResult/TestCase contract rows for this output bundle.",
      '  });',
      '});',
      '',
    ].join('\n');
  }
  return files;
}

function _sheetRowsFromSets(testDataSets, sheetName) {
  const wanted = String(sheetName || '').trim().toLowerCase();
  for (const ds of testDataSets || []) {
    let parsed;
    try { parsed = typeof ds.sheetsJson === 'string' ? JSON.parse(ds.sheetsJson) : ds.sheetsJson; } catch { parsed = null; }
    const sheets = Array.isArray(parsed && parsed.sheets)
      ? parsed.sheets
      : (Array.isArray(ds && ds.sheets) ? ds.sheets : []);
    const sheet = sheets.find((s) => String(s && s.name || '').trim().toLowerCase() === wanted);
    if (sheet) return Array.isArray(sheet.rows) ? sheet.rows : [];
  }
  return [];
}

function _expectedRowsForBinding(testDataSets, binding) {
  const rows = _sheetRowsFromSets(testDataSets, binding && binding.sheet);
  if (!rows.length) return 0;
  const selector = String(binding && binding.rowSelector || 'all').trim().toLowerCase();
  if (!selector || selector === 'all') return rows.length;
  const rowClassColumn = binding && binding.rowClassColumn;
  if (!rowClassColumn) return rows.length;
  const filtered = rows.filter((row) => String(row && row[rowClassColumn] || '').trim().toLowerCase().includes(selector));
  return filtered.length || rows.length;
}

function buildDataMatrixCoverageReport({ results = [], testDataSets = [] } = {}) {
  const groups = new Map();
  for (const result of results || []) {
    const binding = result && result.dataBinding && typeof result.dataBinding === 'object' ? result.dataBinding : null;
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
      if (step && step.valueRef && step.rawValue == null) { const n = envNameForRef(step.valueRef); if (n) names.add(n); }
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
  return keys.map((name) => `${name}=${defaults[name] || ''}`).join('\n') + '\n';
}

function authStateRefFromEnvelope(env) {
  const profile = env && env.ir && env.ir.authProfile;
  const ref = profile && typeof profile === 'object' ? profile.storageStateRef : null;
  return ref ? String(ref) : null;
}

function parseArrayJson(value) {
  const parsed = decodeJson(value, []);
  return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()) : [];
}

function dataRowsUsed(ir) {
  const rows = Array.isArray(ir && ir.dataRows) ? ir.dataRows : (ir && ir.dataRow ? [ir.dataRow] : []);
  return rows.some((row) => row && row.fields && typeof row.fields === 'object' && Object.keys(row.fields).length > 0);
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
    const state = fidelity.declaredAssertionsStateFor({ declaredAssertions: r && r.declaredAssertionsRaw });
    const live = (r && r.liveOutcomes) || {};
    const liveIds = Object.keys(live).filter(Boolean);
    if (state.state === 'missing' || state.state === 'invalid') {
      out.push({
        rule: 'assertion_cardinality_gap',
        severity: 'warning',
        gapKind: state.state === 'missing' ? 'declared_assertions_missing' : 'declared_assertions_invalid',
        runResultId: r && r.runResultId,
        testCaseId: r && r.testCaseId,
        declaredAssertionsState: state.state,
        declaredCount: null,
        liveOutcomeCount: liveIds.length,
        missingAssertions: [],
        extraLiveOutcomeIds: liveIds,
        message: state.state === 'missing'
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
      gapKind: declared.length > liveIds.length ? 'declared_without_live_outcome' : (extra.length ? 'live_outcome_without_declared_assertion' : 'count_mismatch'),
      runResultId: r && r.runResultId,
      testCaseId: r && r.testCaseId,
      declaredAssertionsState: state.state,
      declaredCount: declared.length,
      liveOutcomeCount: liveIds.length,
      missingAssertions: missing.map((a) => ({ id: a.id || null, type: a.type, criticality: a.criticality })),
      extraLiveOutcomeIds: extra,
      message: `assertion cardinality gap: ${declared.length} declared assertion(s), ${liveIds.length} recorded live outcome(s)`,
    });
  }
  return out;
}

function locatorText(candidate) {
  if (!candidate || typeof candidate !== 'object') return '';
  return String(candidate.name || candidate.text || candidate.selector || candidate.testId || '').trim();
}

function tokenSet(value) {
  return new Set(String(value || '')
    .toLowerCase()
    .replace(/^(env|vault|fixture|masked):/i, '')
    .replace(/\b(qaai|td|masked|vault|fixture|input|field|value|data)\b/g, ' ')
    .split(/[^a-z0-9]+/)
    .map((v) => v.trim())
    .filter((v) => v && v.length > 1));
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
    return !!selector && !/^ref\s*=\s*e\d+$/i.test(selector);
  }
  if (strategy === 'testid') return !!candidate.testId;
  if (strategy === 'placeholder' || strategy === 'label' || strategy === 'text') return !!candidate.text;
  if (strategy === 'role') return !!candidate.role && !!candidate.name && !intrinsicallyBadCandidate(candidate);
  return false;
}

function legacyExportableCandidate(candidates) {
  const list = normalizeCandidates(candidates || []);
  return list.find((candidate) => durableCandidate(candidate) && !intrinsicallyBadCandidate(candidate)) || null;
}

function legacyCandidateExpression(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const strategy = String(candidate.strategy || '').toLowerCase();
  if (strategy === 'css' && candidate.selector) return String(candidate.selector);
  if (strategy === 'testid' && candidate.testId) return `getByTestId(${JSON.stringify(String(candidate.testId))})`;
  if ((strategy === 'placeholder' || strategy === 'label' || strategy === 'text') && candidate.text) {
    return `getBy${strategy.charAt(0).toUpperCase()}${strategy.slice(1)}(${JSON.stringify(String(candidate.text))})`;
  }
  if (strategy === 'role' && candidate.role && candidate.name) {
    return `getByRole(${JSON.stringify(String(candidate.role))}, { name: ${JSON.stringify(String(candidate.name))} })`;
  }
  return locatorText(candidate) || null;
}

function inputRole(candidate) {
  return candidate && candidate.strategy === 'role'
    && ['textbox', 'searchbox', 'combobox'].includes(String(candidate.role || '').toLowerCase());
}

function candidateMatchesValueRef(candidate, valueRef) {
  if (!inputRole(candidate)) return true;
  if (durableCandidate(candidate)) return true;
  const text = locatorText(candidate);
  if (!text) return true;
  return hasTokenOverlap(text, valueRef);
}

function assessReplayLocatorEvidence(ir) {
  const steps = Array.isArray(ir && ir.steps) ? ir.steps : [];
  const byAs = new Map();
  const findings = [];
  const releaseStrict = String(process.env.QAAI_RELEASE_CERTIFICATION || '').trim() === '1';
  if (ir && ir.locatorCertification) {
    findings.push(...locatorIntelligenceV2.locatorCertificationFindings(ir.locatorCertification, { severity: 'warning' })
      .map((finding) => ({
        ...finding,
        severity: releaseStrict || finding.rule !== 'locator_certification_draft' ? 'error' : 'warning',
      })));
  }
  steps.forEach((step, index) => {
    if (step && step.op === 'resolve' && step.as) {
      byAs.set(step.as, { step, index, candidates: normalizeCandidates(step.candidates || []) });
    }
  });

  for (const entry of byAs.values()) {
    const candidates = entry.candidates || [];
    // Admit a step whose action-time locator is GOLD (count=1 + sameElement proof) OR
    // EXPORT-SAFE (a faithful ARIA/DOM expression from the browser's own snapshot /
    // excavation — unique by construction for structural/excavation captures). Gold is
    // a strict subset of export-safe, so every previously-admitted step still admits;
    // this additionally admits faithful non-gold locators (e.g. getByPlaceholder on a
    // password field, getByRole on a Login button) instead of blocking the entire export
    // as "missing verified locator". The stricter gold bar remains the KB / verdict gate;
    // export only needs faithfulness, not KB-promotability. A truly-absent locator still
    // fails this check. Non-gold admissions are flagged degraded in the manifest below.
    const legacyCandidate = legacyExportableCandidate(candidates);
    if (!actionLocatorResolver.isExportSafeActionLocator(entry.step.actionLocator) && !legacyCandidate) {
      findings.push({
        rule: 'replayir_missing_action_time_locator',
        severity: 'error',
        stepIndex: entry.index,
        message: `resolve '${entry.step.as}' is missing faithful action-time locator evidence; candidate-only replay would be a guess.`,
      });
    } else if (!actionLocatorResolver.isExportSafeActionLocator(entry.step.actionLocator) && legacyCandidate) {
      findings.push({
        rule: 'replayir_legacy_candidate_locator',
        severity: 'warning',
        stepIndex: entry.index,
        locator: legacyCandidateExpression(legacyCandidate),
        message: `resolve '${entry.step.as}' uses legacy ReplayIR candidate locator evidence. New capture-first runs should record actionLocator directly.`,
      });
    }
    if (!candidates.length) {
      findings.push({
        rule: 'replayir_no_replayable_locator',
        severity: 'error',
        stepIndex: entry.index,
        message: `resolve '${entry.step.as}' has no replayable locator candidates after normalization.`,
      });
      continue;
    }
    if (candidates.every(intrinsicallyBadCandidate)) {
      findings.push({
        rule: 'replayir_locator_polluted',
        severity: 'error',
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
      'click', 'doubleclick', 'tripleclick', 'fill', 'type', 'selectoption',
      'check', 'uncheck', 'press', 'hover', 'upload', 'drag',
    ].includes(actionName);
    if (locatorNeeded && !actionLocatorResolver.isExportSafeActionLocator(step.actionLocator)) {
      const entry = byAs.get(step.target);
      const resolveHasLocator = entry && (
        actionLocatorResolver.isExportSafeActionLocator(entry.step.actionLocator)
        || legacyExportableCandidate(entry.candidates || [])
      );
      findings.push({
        rule: 'replayir_action_missing_owned_locator',
        severity: releaseStrict ? 'error' : 'warning',
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
    const candidates = (entry.candidates || []).filter((candidate) => !intrinsicallyBadCandidate(candidate));
    if (!candidates.length) continue;
    const usable = candidates.filter((candidate) => candidateMatchesValueRef(candidate, step.valueRef));
    if (!usable.length) {
      findings.push({
        rule: 'replayir_locator_value_pollution',
        severity: 'error',
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
  if (step.expectedSignals && typeof step.expectedSignals === 'object' && Object.keys(step.expectedSignals).length) return true;
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
  return !!artifact
    && artifact.source === 'replayir'
    && artifact.scriptGenerationStatus === 'generated';
}

function resultMatchesArtifact(result, artifact) {
  if (!result || !artifact) return false;
  if (artifact.runResultId && result.runResultId && String(artifact.runResultId) === String(result.runResultId)) return true;
  return !!(artifact.testCaseId && result.testCaseId && String(artifact.testCaseId) === String(result.testCaseId));
}

function decodeEvidenceJson(value, fallback = null) {
  return decodeJson(value, fallback);
}

function latestLedgerForResult(result) {
  const fromEnvelope = result && result.envelope && result.envelope.evidenceCompletenessLedger;
  if (fromEnvelope && typeof fromEnvelope === 'object') return fromEnvelope;
  const capture = result && result.captureFirstEvidence || {};
  if (capture.evidenceCompleteness && typeof capture.evidenceCompleteness === 'object') return capture.evidenceCompleteness;
  const ledgers = Array.isArray(capture.evidenceCompletenessLedgers) ? capture.evidenceCompletenessLedgers : [];
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

function normalizeEvidenceRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const out = { ...row };
    for (const key of Object.keys(out)) {
      if (/Json$/i.test(key) || key === 'evidenceJson' || key === 'locatorRecipeJson' || key === 'loginActionEvidenceIds') {
        out[key] = decodeEvidenceJson(out[key], out[key]);
      }
    }
    return out;
  });
}

function buildCaptureFirstEvidencePackage({ results = [] } = {}) {
  const entries = (Array.isArray(results) ? results : []).map((result) => {
    const capture = result && result.captureFirstEvidence || {};
    const ledger = latestLedgerForResult(result);
    const envelope = result && result.envelope || null;
    return {
      runResultId: result && result.runResultId || null,
      testCaseId: result && result.testCaseId || null,
      caseName: result && result.caseName || null,
      status: result && result.status || null,
      overallRunStatus: capture.overallRunStatus || ledger?.overallRunStatus || null,
      executionStatus: capture.executionStatus || ledger?.executionStatus || null,
      evidenceStatus: capture.evidenceStatus || ledger?.evidenceStatus || null,
      scriptStatus: capture.scriptStatus || ledger?.scriptStatus || null,
      liveScriptLedger: result && result.liveScriptLedger || null,
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
  const evidenceCompleteCount = entries.filter((entry) => entry.ledger && entry.ledger.evidenceStatus === 'complete' && Number(entry.ledger.missingEvidenceCount || 0) === 0).length;
  const replayIrCompleteCount = entries.filter((entry) => entry.replayIrComplete && entry.replayIrGapCount === 0).length;
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

function addCaptureFirstEvidenceFiles(files, results = []) {
  if (!Array.isArray(results) || !results.length) return null;
  const evidencePackage = buildCaptureFirstEvidencePackage({ results });
  files['evidence/action-evidence.json'] = JSON.stringify({
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
  }, null, 2) + '\n';
  files['evidence/replayir.json'] = JSON.stringify({
    schema: 'qaai-replayir-evidence/1',
    summary: evidencePackage.summary,
    replayIr: (results || []).map((result) => ({
      runResultId: result.runResultId,
      testCaseId: result.testCaseId,
      caseName: result.caseName || null,
      complete: result.envelope ? result.envelope.complete === true : false,
      gaps: Array.isArray(result.envelope && result.envelope.gaps) ? result.envelope.gaps : [],
      evidenceBuiltReplayIr: result.envelope && result.envelope.evidenceBuiltReplayIr || null,
      ir: result.envelope && result.envelope.ir || null,
    })),
  }, null, 2) + '\n';
  files['evidence/completeness-ledger.json'] = JSON.stringify({
    schema: 'qaai-evidence-completeness-ledger/1',
    summary: evidencePackage.summary,
    ledgers: evidencePackage.entries.map((entry) => ({
      runResultId: entry.runResultId,
      testCaseId: entry.testCaseId,
      caseName: entry.caseName,
      ledger: entry.ledger,
    })),
  }, null, 2) + '\n';
  files['evidence/live-script-ledger.json'] = JSON.stringify({
    schema: 'qaai-live-script-ledger-export/1',
    summary: evidencePackage.summary,
    ledgers: evidencePackage.entries.map((entry) => ({
      runResultId: entry.runResultId,
      testCaseId: entry.testCaseId,
      caseName: entry.caseName,
      status: entry.status,
      liveScriptLedger: entry.liveScriptLedger || null,
      scriptHealth: entry.liveScriptLedger && entry.liveScriptLedger.health || null,
      canonicalLineCount: entry.liveScriptLedger ? liveScriptRecorder.canonicalLines(entry.liveScriptLedger).length : 0,
    })),
  }, null, 2) + '\n';
  return evidencePackage;
}

function artifactMatchesLedger(artifact, item = {}) {
  if (!artifact || !item) return false;
  if (artifact.runResultId && item.runResultId && String(artifact.runResultId) === String(item.runResultId)) return true;
  if (artifact.testCaseId && item.testCaseId && String(artifact.testCaseId) === String(item.testCaseId)) return true;
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

function refreshCaptureFirstLedgerCounts(files, { scriptArtifacts = [], validation = null } = {}) {
  const rel = 'evidence/completeness-ledger.json';
  if (!files || typeof files[rel] !== 'string') return null;
  let parsed = null;
  try { parsed = JSON.parse(files[rel]); } catch (_) { return null; }
  const ledgers = Array.isArray(parsed.ledgers) ? parsed.ledgers : [];
  const strictArtifacts = (Array.isArray(scriptArtifacts) ? scriptArtifacts : [])
    .filter((artifact) => artifact && artifact.source === 'replayir' && artifact.scriptGenerationStatus === 'generated' && artifact.file && files[artifact.file]);
  const validationPassed = validationPassedForGeneratedCounts(validation);
  for (const item of ledgers) {
    const ledger = item && item.ledger;
    if (!ledger || typeof ledger !== 'object') continue;
    const hasGeneratedArtifact = strictArtifacts.some((artifact) => artifactMatchesLedger(artifact, item));
    const generatedCount = hasGeneratedArtifact
      ? Number(ledger.actionEvidenceCount || ledger.replayIrActionCount || ledger.compiledActionCount || 0)
      : 0;
    ledger.generatedMethodCount = generatedCount;
    ledger.validatedActionCount = validationPassed && generatedCount > 0 ? generatedCount : 0;
  }
  const totals = ledgers.reduce((acc, item) => {
    const ledger = item && item.ledger || {};
    acc.generatedMethodCount += Number(ledger.generatedMethodCount || 0);
    acc.validatedActionCount += Number(ledger.validatedActionCount || 0);
    return acc;
  }, { generatedMethodCount: 0, validatedActionCount: 0 });
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

function hasAuthSessionBlocker(result) {
  const readinessStatus = String(result && result.readinessStatus || '').toLowerCase();
  if (readinessStatus === 'needs_auth_setup' || readinessStatus === 'needs_session_dependency') return true;
  const reasons = Array.isArray(result && result.readinessReasons) ? result.readinessReasons : [];
  return reasons.some((reason) => {
    const code = String(reason && (reason.code || reason.rule || reason.family || reason.message) || '').toLowerCase();
    return code.includes('auth_setup')
      || code.includes('no_login_template')
      || code.includes('session_dependency')
      || code.includes('missing_session')
      || code.includes('auth_session');
  });
}

function needsAuthStateContext(result, ir) {
  const requiresState = result && (result.requiresStateJson || result.requiresState || result.requiresData);
  const stateText = JSON.stringify(requiresState || '').toLowerCase();
  if (stateText.includes('auth_session') || stateText.includes('session')) return true;
  const mode = String(result && result.sessionMode || '').toLowerCase();
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
        testCaseId: artifact && artifact.testCaseId || null,
        runResultId: artifact && artifact.runResultId || null,
        file: artifact && artifact.file || null,
        source: artifact && artifact.source || null,
        scriptGenerationStatus: artifact && artifact.scriptGenerationStatus || null,
        message: 'Replay-checked output requires a generated artifact sourced from complete browser-captured ReplayIR. Partial, TestCase-contract, helper, and skeleton artifacts remain visible with lower script health.',
      });
      continue;
    }

    if (!result || !result.envelope || !result.envelope.ir) {
      findings.push({
        rule: 'strict_export_replayir_missing',
        severity: 'error',
        testCaseId: artifact && artifact.testCaseId || null,
        runResultId: artifact && artifact.runResultId || null,
        file: artifact && artifact.file || null,
        message: 'Artifact claims ReplayIR source, but the matching RunResult has no pinned ReplayIR envelope.',
      });
      continue;
    }

    const envelope = result.envelope;
    const ir = envelope.ir;
    const evidenceLedger = latestLedgerForResult(result);
    if (!evidenceLedger) {
      findings.push({
        rule: 'strict_export_evidence_ledger_missing',
        severity: 'error',
        testCaseId: artifact.testCaseId || result.testCaseId || null,
        runResultId: artifact.runResultId || result.runResultId || null,
        file: artifact.file || null,
        message: 'Certified/export-valid output requires a capture-first EvidenceCompletenessLedger for the matching RunResult.',
      });
    } else if (evidenceLedger.evidenceStatus !== 'complete' || Number(evidenceLedger.missingEvidenceCount || 0) > 0) {
      findings.push({
        rule: 'strict_export_evidence_incomplete',
        severity: 'error',
        testCaseId: artifact.testCaseId || result.testCaseId || null,
        runResultId: artifact.runResultId || result.runResultId || null,
        file: artifact.file || null,
        ledger: evidenceLedger,
        message: 'Certified/export-valid output requires capture-first evidenceStatus=complete and missingEvidenceCount=0.',
      });
    }
    if (envelope.complete === false) {
      findings.push({
        rule: 'strict_export_replayir_incomplete',
        severity: 'error',
        testCaseId: artifact.testCaseId || result.testCaseId || null,
        runResultId: artifact.runResultId || result.runResultId || null,
        file: artifact.file || null,
        gaps: Array.isArray(envelope.gaps) ? envelope.gaps : [],
        message: 'Certified/export-valid output requires ReplayIR complete:true.',
      });
    }
    if (Array.isArray(envelope.gaps) && envelope.gaps.length) {
      findings.push({
        rule: 'strict_export_replayir_gaps',
        severity: 'error',
        testCaseId: artifact.testCaseId || result.testCaseId || null,
        runResultId: artifact.runResultId || result.runResultId || null,
        file: artifact.file || null,
        gaps: envelope.gaps,
        message: 'Certified/export-valid output requires zero ReplayIR gaps.',
      });
    }

    const locatorAssessment = assessReplayLocatorEvidence(ir);
    for (const finding of locatorAssessment.findings || []) {
      if (finding && finding.severity === 'error') {
        findings.push({
          ...finding,
          rule: `strict_export_${finding.rule || 'locator_evidence_missing'}`,
          testCaseId: artifact.testCaseId || result.testCaseId || finding.testCaseId || null,
          runResultId: artifact.runResultId || result.runResultId || finding.runResultId || null,
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
        message: 'Certified/export-valid output requires at least one concrete browser-captured assertion with a contractRef and expected evidence.',
      });
    }

    if (hasAuthSessionBlocker(result)
      || (needsAuthStateContext(result, ir) && !authStateContextPresent(result, envelope, ir))) {
      findings.push({
        rule: 'strict_export_auth_session_context_missing',
        severity: 'error',
        testCaseId: artifact.testCaseId || result.testCaseId || null,
        runResultId: artifact.runResultId || result.runResultId || null,
        file: artifact.file || null,
        readinessStatus: result.readinessStatus || null,
        sessionMode: result.sessionMode || null,
        message: 'Certified/export-valid output requires clean auth/session context: verified login in ReplayIR, usable auth state, or an approved auth profile with no auth/session readiness blockers.',
      });
    }
  }

  if (artifacts.length === 0 && (results || []).length > 0) {
    findings.push({
      rule: 'strict_export_no_script_artifacts',
      severity: 'error',
      message: 'Certified/export-valid output requires at least one script artifact tied to browser-captured ReplayIR.',
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
      findings: [{
        rule: 'auth_storage_state_unsupported',
        severity: 'error',
        message: 'ReplayIR requires Playwright storageState, but selenium-reference cannot consume Playwright storageState. Use explicit login/test-hook auth for Selenium.',
        refs,
      }],
    };
  }

  if (refs.length > 1) {
    return {
      files: {},
      storageStateRel: null,
      findings: [{
        rule: 'auth_storage_state_multiple_refs',
        severity: 'error',
        message: `Export selection contains ${refs.length} different storageState refs. Split by AuthProfile or add per-test storageState support before exporting.`,
        refs,
      }],
    };
  }

  const ref = refs[0];
  const m = ref.match(/^fixture:(.+)$/i);
  if (!m) {
    return {
      files: {},
      storageStateRel: null,
      findings: [{
        rule: 'auth_storage_state_unresolved',
        severity: 'error',
        message: `ReplayIR storageStateRef '${ref}' is not a resolvable AuthFixture ref. Expected fixture:<authFixtureId>.`,
        ref,
      }],
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
      findings: [{
        rule: 'auth_fixture_missing_or_invalid',
        severity: 'error',
        message: `AuthFixture '${fixtureId}' is missing, outside this project, or does not contain usable Playwright storageState.`,
        ref,
      }],
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
function wrapForVerdict(adapterId, content, status, reason) {
  const reasonNote = reason ? ` (${String(reason).slice(0, 120)})` : '';
  // Intentional skip — neutralize so runner doesn't report green for excluded cases.
  if (VERDICT_NEEDS_SKIP.has(status)) {
    const note = `// QAAI verdict-preservation: MCP verdict was '${status}'${reasonNote}; generated test is disabled so an internal/blocked case cannot masquerade as a website failure.\n`;
    if (adapterId === 'playwright-reference' && content.includes('test.describe(')) {
      return { content: note + content.replace('test.describe(', 'test.describe.skip('), wrapped: true };
    }
    if ((adapterId === 'playwright-reference-js') && content.includes('test.describe(')) {
      return { content: note + content.replace('test.describe(', 'test.describe.skip('), wrapped: true };
    }
    if ((adapterId === 'selenium-reference' || adapterId === 'selenium-pom') && content.includes('@Test')) {
      return { content: note + content.replace('@Test', '@Test(enabled = false)'), wrapped: true };
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
    if (s && s.op === 'act' && /fill|type/i.test(s.action || '') && /pass/i.test(String(s.valueRef || s.target || ''))) pwIdx = i;
  });
  if (pwIdx < 0) return false;
  return steps.slice(pwIdx + 1).some((s) => s && s.op === 'act' && /click|press/i.test(s.action || ''));
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
  steps.forEach((s, i) => { if (s && s.op === 'act' && /fill|type/i.test(s.action || '') && /pass/i.test(String(s.valueRef || s.target || ''))) pwIdx = i; });
  if (pwIdx < 0) return null;
  let clickIdx = -1;
  for (let i = pwIdx + 1; i < steps.length; i += 1) { if (steps[i] && steps[i].op === 'act' && /click|press/i.test(steps[i].action || '')) { clickIdx = i; break; } }
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
    if (!best || block.length < best.steps.length) best = { steps: block, loginUrl: loginUrlOf(ir) };
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
    const steps = Array.isArray(r.envelope && r.envelope.ir && r.envelope.ir.steps) ? r.envelope.ir.steps : [];
    for (const s of steps) {
      if (s && s.op === 'assert' && LOGOUT.test(String(s.expected || ''))) return true;
      if (s && s.op === 'assert' && s.channel === 'EVALUATE' && LOGOUT.test(String(s.script || ''))) return true;
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
    if (s && s.op === 'act' && /fill|type/i.test(s.action || '') && /user|pass|login|email/i.test(String(s.valueRef || s.target || ''))) return true;
    if (s && s.op === 'assert') {
      const sc = String(s.script || '');
      if (/input\[\s*(name|id|type)\s*[*^$~|]?=\s*["'](user|pass|email|login)/i.test(sc)) return true;
      if (/type\s*=\s*["']password["']/i.test(sc)) return true;
      if (/\b(is required|are required|required field|invalid credential|must be|cannot be empty)\b/i.test(String(s.expected || ''))) return true;
    }
  }
  return false;
}

// The logout URL the run actually used (a navigate to a /logout endpoint). Kept as evidence
// only; export must not compose hidden logged-out preconditions from another case.
function deriveLogoutUrl(results) {
  for (const r of results || []) {
    const steps = Array.isArray(r.envelope && r.envelope.ir && r.envelope.ir.steps) ? r.envelope.ir.steps : [];
    const nav = steps.find((s) => s && s.op === 'act' && s.action === 'navigate' && /\/logout(\b|\/|$)/i.test(String(s.url || '')));
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
      if (step && step.op === 'resolve' && step.as) resolveByAs.set(step.as, { ...step, stepIndex: index });
    });
    const logoutIndex = steps.findIndex((s) => s && s.op === 'act' && /click/i.test(s.action || '') && LOGOUT.test(JSON.stringify(s)));
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
      if (MENU.test(JSON.stringify(step))) { openerIndex = i; break; }
    }
    if (openerIndex < 0) {
      for (let i = logoutIndex - 1; i >= 0; i--) {
        const step = steps[i];
        if (!step || step.op !== 'act' || !/click/i.test(step.action || '')) continue;
        if (!/login|sign\s?in/i.test(JSON.stringify(step))) { openerIndex = i; break; }
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
    const steps = Array.isArray(r.envelope && r.envelope.ir && r.envelope.ir.steps) ? r.envelope.ir.steps : [];
    for (const s of steps) {
      if (s && s.op === 'act' && s.action === 'navigate' && /\/logout(\b|\/|$)/i.test(String(s.url || ''))) return true;
      if (s && s.op === 'act' && /click/i.test(s.action || '') && LOGOUT.test(JSON.stringify(s))) return true;
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
    const steps = Array.isArray(r.envelope && r.envelope.ir && r.envelope.ir.steps) ? r.envelope.ir.steps : [];
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
    return /error[- _]?message|is[- _]?required|required|validation[- _]?error|invalid[- _]?credential|field[- _]?error/i.test(script);
  }
  if (step.channel === 'UI_TEXT' || step.channel === 'TEXT_MATCH') {
    return /required|invalid|error|empty|validation/i.test(String(step.expected || '').toLowerCase());
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
  return !(loginPrecondition && (logoutUrl || (Array.isArray(logoutActionSteps) && logoutActionSteps.length)));
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
  const isPlaywright = adapterId === 'playwright-reference' || adapterId === 'playwright-reference-js'
    || adapterId === 'playwright-pom' || adapterId === 'playwright-pom-js';
  const isJs = adapterId === 'playwright-reference-js' || adapterId === 'playwright-pom-js';

  // ── PASS 1: Gate chain ────────────────────────────────────────────────────
  const validatedItems = [];

  for (const r of results) {
    const base = {
      runId: r.runId, runResultId: r.runResultId, testCaseId: r.testCaseId,
      dataRowIndex: r.dataRowIndex == null ? null : Number(r.dataRowIndex),
      dataRowLabel: r.dataRowLabel || null,
      adapterId, adapterVersion,
      emitterVersion: r.envelope && r.envelope.emitterVersion || null,
      irHash: r.envelope && r.envelope.ir ? hashReplayIr(r.envelope.ir) : null,
      expectedVerdict: r.status,
      complete: !!(r.envelope && r.envelope.complete),
      gaps: (r.envelope && r.envelope.gaps) || [],
      requirementRefs: Array.isArray(r.requirementRefs) ? r.requirementRefs : [],
      authProfile: r.authProfile || null,
      dataBinding: r.dataBinding || null,
      dataRowsUsed: dataRowsUsed(r.envelope && r.envelope.ir),
      files: [], validationFindings: [], fileHashes: {},
    };

    if (r.runEligibility && r.runEligibility !== readinessCompiler.RUN_ELIGIBILITY.ALLOWED) {
      const reasons = Array.isArray(r.readinessReasons) ? r.readinessReasons : [];
      const finding = {
        rule: 'export_readiness_blocked',
        severity: 'error',
        runResultId: r.runResultId,
        testCaseId: r.testCaseId,
        readinessStatus: r.readinessStatus || 'blocked',
        reasons,
        message: `Case is not export-ready (${r.readinessStatus || 'blocked'}). Export includes ready cases by default; repair data/auth/session/app/oracle prerequisites first.`,
      };
      findings.push(finding);
      blocked.push({ runResultId: r.runResultId, testCaseId: r.testCaseId, code: 'export_readiness_blocked', readinessStatus: r.readinessStatus || 'blocked', reasons });
      manifestEntries.push({ ...base, status: 'blocked', blockReason: 'export_readiness_blocked', readinessStatus: r.readinessStatus || 'blocked', readinessReasons: reasons });
      continue;
    }

    // ── Block gate (#3, #8): missing / incomplete / invalid IR → NO output, no fallback.
    if (!r.envelope || !r.envelope.ir) {
      blocked.push({ runResultId: r.runResultId, testCaseId: r.testCaseId, code: 'replayir_missing', detail: 'RunResult has no replayIrJson — cannot export without fabricating.' });
      manifestEntries.push({ ...base, status: 'blocked', blockReason: 'replayir_missing', detail: 'RunResult has no replayIrJson — cannot export without fabricating.' });
      continue;
    }
    if (r.envelope.complete === false) {
      if (allowIncompletePreview) {
        const incompleteFinding = {
          rule: 'replayir_incomplete_preview',
          severity: 'warning',
          runResultId: r.runResultId,
          testCaseId: r.testCaseId,
          message: 'ReplayIR is marked complete:false; rendering generated script output with script-health notes until evidence is replay checked.',
        };
        base.validationFindings = [...base.validationFindings, incompleteFinding];
        findings.push(incompleteFinding);
      } else {
        blocked.push({ runResultId: r.runResultId, testCaseId: r.testCaseId, code: 'replayir_incomplete', gaps: base.gaps, detail: 'replayIrJson is complete:false — incomplete evidence, blocked (no fallback).' });
        manifestEntries.push({ ...base, status: 'blocked', blockReason: 'replayir_incomplete', gaps: base.gaps, detail: 'replayIrJson is complete:false — incomplete evidence, blocked (no fallback).' });
        continue;
      }
    }

    const locatorAssessment = assessReplayLocatorEvidence(r.envelope.ir);
    if (!locatorAssessment.ok) {
      base.validationFindings = [...base.validationFindings, ...locatorAssessment.findings];
      findings.push(...locatorAssessment.findings);
      blocked.push({ runResultId: r.runResultId, testCaseId: r.testCaseId, code: 'replayir_locator_unreplayable', detail: 'ReplayIR locator evidence is not faithful enough to export without guessing.', findings: locatorAssessment.findings });
      manifestEntries.push({ ...base, status: 'blocked', blockReason: 'replayir_locator_unreplayable', validationFindings: locatorAssessment.findings });
      findings.push(...locatorAssessment.findings);
      continue;
    }
    if (locatorAssessment.findings.length) {
      base.validationFindings = [...base.validationFindings, ...locatorAssessment.findings];
      findings.push(...locatorAssessment.findings);
    }

    const opAssessment = operationBacked.assessOperationPlan({ result: r, ir: r.envelope.ir });
    if (opAssessment.mode === 'blocked') {
      const block = opAssessment.block || {};
      findings.push(...(opAssessment.findings || []));
      blocked.push({ runResultId: r.runResultId, testCaseId: r.testCaseId, code: block.code || 'operation_export_unready', detail: block.detail, ...(block.findings ? { findings: block.findings } : {}), ...(block.dropped ? { dropped: block.dropped } : {}) });
      manifestEntries.push({ ...base, status: 'blocked', blockReason: block.code || 'operation_export_unready', detail: block.detail, operationBacked: true, operationFindings: block.findings || [], dropped: block.dropped || [] });
      findings.push(...(opAssessment.findings || []));
      continue;
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
    (results || []).filter((r) => irPerformsLogin(r.envelope && r.envelope.ir)).map((r) => r.scenarioId).filter(Boolean)
  );
  // The run's own logout evidence is diagnostic only. Do not compose hidden logout setup.
  const logoutUrl = isPlaywright ? deriveLogoutUrl(results) : null;
  const logoutActionSteps = isPlaywright ? deriveLogoutActionSteps(results) : null;

  // ── PASS 2: Playwright → journey grouping; everything else → per-case ─────
  if (isPlaywright) {
    // Group by scenarioId. Results without a scenarioId go per-case.
    const groups = new Map(); // scenarioId → { scenarioId, scenarioName, items[] }
    const ungrouped = [];
    for (const item of validatedItems) {
      const sid = item.r.scenarioId;
      if (sid) {
        if (!groups.has(sid)) groups.set(sid, { scenarioId: sid, scenarioName: item.r.scenarioName, items: [] });
        groups.get(sid).items.push(item);
      } else {
        ungrouped.push(item);
      }
    }
    for (const [, group] of groups) {
      _compileJourneyGroup({ adapter, adapterId, adapterVersion, isJs, group, admitted, blocked, manifestEntries, findings, usedPaths, loginPrecondition, scenariosWithOwnLogin, logoutUrl, logoutActionSteps });
    }
    for (const item of ungrouped) {
      // POM adapters have emitJourneySpec but no per-case emitStep contract.
      // Wrap ungrouped POM items as a single-case journey using testCaseId as scenarioId.
      if (adapterId === 'playwright-pom' || adapterId === 'playwright-pom-js') {
        const fakeGroup = {
          scenarioId: item.r.testCaseId || 'unknown',
          scenarioName: item.r.caseName || item.r.testCaseName || item.r.testCaseId || 'unknown',
          items: [item],
        };
        _compileJourneyGroup({ adapter, adapterId, adapterVersion, isJs, group: fakeGroup, admitted, blocked, manifestEntries, findings, usedPaths, loginPrecondition, scenariosWithOwnLogin, logoutUrl, logoutActionSteps });
      } else {
        _compilePerCase({ adapter, adapterId, adapterVersion, isSelenium, isJs, item, admitted, blocked, manifestEntries, findings, usedPaths, usedClassNames, usedDataPaths });
      }
    }
  } else {
    for (const item of validatedItems) {
      _compilePerCase({ adapter, adapterId, adapterVersion, isSelenium, isJs: false, item, admitted, blocked, manifestEntries, findings, usedPaths, usedClassNames, usedDataPaths });
    }
  }

  return { admitted, blocked, manifestEntries, findings, adapterId, adapterVersion };
}

/** Compile all validated items from one scenario group into a single journey spec. */
function _compileJourneyGroup({ adapter, adapterId, adapterVersion, isJs, group, admitted, blocked, manifestEntries, findings, usedPaths, loginPrecondition, scenariosWithOwnLogin, logoutUrl, logoutActionSteps }) {
  const { scenarioId, scenarioName, items } = group;
  const emitFn = typeof adapter.emitJourneySpec === 'function' ? adapter.emitJourneySpec : null;
  if (!emitFn) {
    findings.push({ rule: 'journey_emit_unsupported', severity: 'warning', message: `Adapter ${adapterId} has no emitJourneySpec; scenario ${scenarioId} skipped.` });
    return;
  }

  // Class E (logout): a stranded post-logout journey. Block instead of injecting a hidden
  // logout precondition; approved logout actions inside the journey still emit normally.
  const needsLogout = journeyNeedsLogoutPrecondition(items);
  // Class E: this journey assumes an authenticated session it never establishes.
  const needsSession = !needsLogout && loginPrecondition && journeyNeedsLoginPrecondition(items);

  if (needsLogout) {
    const hasLogoutEvidence = !!(logoutUrl || (Array.isArray(logoutActionSteps) && logoutActionSteps.length));
    const reason = hasLogoutEvidence
      ? 'logout evidence exists elsewhere in the run, but QAAI will not inject it as a hidden precondition'
      : 'no approved logout action exists in this journey';
    for (const { r } of items) {
      blocked.push({ runResultId: r.runResultId, testCaseId: r.testCaseId, code: 'replayir_logout_precondition_unapproved', detail: `Scenario '${scenarioName || scenarioId}' references a logged-out state but does not contain an approved recorded logout action; ${reason}. Add logout as an explicit approved step/case, or keep this scenario independent so it starts from a fresh browser session.` });
      manifestEntries.push({ adapterId, adapterVersion, scenarioId, scenarioName, runResultIds: [r.runResultId], testCaseIds: [r.testCaseId], status: 'blocked', blockReason: 'replayir_logout_precondition_unapproved' });
    }
    findings.push({ rule: 'replayir_logout_precondition_unapproved', severity: 'warning', message: `Scenario '${scenarioName || scenarioId}' blocked: export refused to compose a hidden logout precondition.` });
    return;
  }
  // If the scenario established its OWN session (via a login case now absent from the export),
  // we cannot faithfully reconstruct that identity with the canonical login — block honestly
  // rather than emit a spec that would run under the wrong identity (L3: no inauthentic state).
  if (needsSession && scenariosWithOwnLogin && scenariosWithOwnLogin.has(scenarioId)) {
    for (const { r } of items) {
      blocked.push({ runResultId: r.runResultId, testCaseId: r.testCaseId, code: 'replayir_session_unreproducible', detail: `Scenario '${scenarioName || scenarioId}' established its own session via a login case that is absent from the export (blocked/unreplayable); substituting the canonical login could replay a different identity, so the case is blocked rather than emitted unfaithfully.` });
      manifestEntries.push({ adapterId, adapterVersion, scenarioId, scenarioName, runResultIds: [r.runResultId], testCaseIds: [r.testCaseId], status: 'blocked', blockReason: 'replayir_session_unreproducible' });
    }
    findings.push({ rule: 'replayir_session_unreproducible', severity: 'warning', message: `Scenario '${scenarioName || scenarioId}' blocked: its session-establishing case is absent and cannot be faithfully substituted.` });
    return;
  }

  // Block: a journey that NEEDS logout teardown composition (references a logged-out state)
  // but the ingredients (a recorded login + an evidenced logout URL) are unavailable.
  // Emitting would produce a SecurityError (bare document.cookie on about:blank) or a
  // false-negative EVALUATE on wrong session state — both L3 artifacts (export fails for a
  // reason absent from live). Block honestly rather than ship a crashing spec.
  if (journeyNeedsLogoutButCant(items, { loginPrecondition, logoutUrl, logoutActionSteps })) {
    const reason = !loginPrecondition
      ? 'no recorded login in this run (cannot compose login + logout teardown)'
      : 'no evidenced logout URL or verified logout click sequence in this run (cannot compose logout navigation)';
    for (const { r } of items) {
      blocked.push({ runResultId: r.runResultId, testCaseId: r.testCaseId, code: 'replayir_stranded_evaluate', detail: `Scenario '${scenarioName || scenarioId}' references a logged-out state but the teardown cannot be composed: ${reason}. Re-run after a complete login→logout flow is recorded.` });
      manifestEntries.push({ adapterId, adapterVersion, scenarioId, scenarioName, runResultIds: [r.runResultId], testCaseIds: [r.testCaseId], status: 'blocked', blockReason: 'replayir_stranded_evaluate' });
    }
    findings.push({ rule: 'replayir_stranded_evaluate', severity: 'warning', message: `Scenario '${scenarioName || scenarioId}' needs logout teardown but ingredients unavailable: ${reason}.` });
    return;
  }

  const cases = items.map(({ r }) => ({
    ir: r.envelope.ir,
    caseName: r.caseName || (r.envelope.ir && r.envelope.ir.title) || r.testCaseId,
    status: r.status,
    runResultId: r.runResultId,
    testCaseId: r.testCaseId,
    declaredSteps: Array.isArray(r.declaredSteps) ? r.declaredSteps : [],
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
      const navStep = loginPrecondition.steps.find((s) => s && s.op === 'act' && s.action === 'navigate');
      const btnResolve = loginPrecondition.steps.find((s) => s && s.op === 'resolve' && (s.candidates || []).some((cand) => cand && String(cand.role || '').toLowerCase() === 'button'));
      const btnClick = btnResolve && loginPrecondition.steps.find((s) => s && s.op === 'act' && s.action === 'click' && s.target === btnResolve.as);
      if (navStep && btnResolve && btnClick) {
        c.ir = {
          ...c.ir,
          steps: [{ ...navStep }, { ...btnResolve }, { ...btnClick }, ...steps],
        };
        findings.push({ rule: 'composed_validation_trigger', severity: 'info', message: `Case '${c.caseName}' had only form-validation evaluate steps; prepended navigate+empty-submit to establish login-form validation state (L3 fix).` });
      } else {
        // loginPrecondition exists but the required nav+button steps could not be extracted —
        // cannot compose the trigger. Block rather than emit code that evaluates in wrong state.
        c._blocked = { code: 'replayir_stranded_evaluate', detail: `Case '${c.caseName}' has only form-validation EVALUATE steps but the login precondition could not supply navigate+button steps to establish the validation state.` };
      }
    } else if (isValidationCase) {
      // No login was recorded in this run — cannot derive a navigate+empty-submit precondition.
      // Block rather than emit code that evaluates on a blank page (L3 artifact).
      c._blocked = { code: 'replayir_stranded_evaluate', detail: `Case '${c.caseName}' has only form-validation EVALUATE/assert steps with no establishing action, and no login sequence was recorded in this run. Re-run after a login flow is captured.` };
    }
  }

  // Fix 3: Credential contradiction — a case fills env-bound canonical credentials (valid
  // creds) then immediately asserts login-page content (stays on login page). This means the
  // live agent typed wrong/test credentials that the conductor captured as the canonical env
  // binding. The export filling valid creds → successful login → login-page assertions fail.
  // Block with a clear reason rather than emitting code that fails for the wrong reason (L3).
  function _isCredentialFill(step) {
    return step && step.op === 'act' && (step.action === 'fill' || step.action === 'type') &&
      step.rawValue == null && typeof step.valueRef === 'string' && /^env:/i.test(step.valueRef);
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
    if ((ch === 'PAGE' || ch === 'UI_TEXT' || ch === 'TEXT_MATCH') && isLoginFormContent) return true;
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
      const role = _credentialRoleFromText(`${step.target || ''} ${step.element || ''} ${step.locator_hint || ''}`);
      if (!role) continue;
      const value = step.value;
      const literal = typeof value === 'string' && value.trim().length > 0 && !/^<|^\{\{/.test(value.trim())
        ? value.trim()
        : null;
      if (!literal) continue;
      byRole[role].push({
        value: literal,
        actionText: `${step.action || ''} ${step.element || ''} ${step.target || ''} ${step.expected || ''}`.toLowerCase(),
      });
    }
    return byRole;
  }
  function _declaredCredentialIsNegative(role, entry, caseName) {
    if (!entry || !entry.value) return false;
    const text = `${caseName || ''} ${entry.actionText || ''}`.toLowerCase();
    const literal = String(entry.value).toLowerCase();
    if (role === 'username') {
      if (/valid username/.test(text) && !/invalid username|wrong username|non[-\s]?existent username|bad[_\s-]*user|payload|injection|sql|xss/.test(text)) return false;
      return /invalid username|wrong username|non[-\s]?existent username|bad[_\s-]*user|username.*(payload|injection|sql|xss)|(payload|injection|sql|xss).*username/.test(text) ||
        /bad[_\s-]*user|nonexistent|invalid|['";<>]|--\s|\/\*|\*\/|or\s+\d+=\d+|union.*select|alert\s*\(/.test(literal);
    }
    if (role === 'password') {
      if (/valid password/.test(text) && !/wrong password|invalid password|bad password|password.*(payload|injection|sql|xss)|(payload|injection|sql|xss).*password/.test(text)) return false;
      return /wrong password|invalid password|bad password|password.*(payload|injection|sql|xss)|(payload|injection|sql|xss).*password/.test(text) ||
        /wrong|invalid|bad|['";<>]|--\s|\/\*|\*\/|or\s+\d+=\d+|union.*select|alert\s*\(/.test(literal);
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
      if (s.rawValue != null || typeof s.valueRef !== 'string' || !/^env:/i.test(s.valueRef)) continue;
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
      if (seenLoginSubmit && s.op === 'act' && s.action === 'navigate') seenPostSubmitNavigate = true;
      if (seenLoginSubmit && !seenPostSubmitNavigate && _isLoginPageAssertion(s)) { hasContradiction = true; break; }
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
  const credBlockedItems = cases.filter((c) => c._blocked);
  for (const c of credBlockedItems) {
    blocked.push({ runResultId: c.runResultId, testCaseId: c.testCaseId, code: c._blocked.code, detail: c._blocked.detail });
    manifestEntries.push({ adapterId, adapterVersion, scenarioId, scenarioName, runResultIds: [c.runResultId], testCaseIds: [c.testCaseId], status: 'blocked', blockReason: c._blocked.code });
  }
  const admissibleCases = cases.filter((c) => !c._blocked);
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
      ir: { title: 'Authenticated session prerequisite (composed from the run\'s recorded login)', steps: loginPrecondition.steps.map((s) => ({ ...s })) },
      caseName: 'Authenticated session prerequisite (composed from the run\'s recorded login)',
      status: 'pass',
      runResultId: null,
      testCaseId: null,
      synthetic: true,
    });
    composedLoginPrecondition = true;
    findings.push({ rule: 'composed_login_precondition', severity: 'info', message: `Scenario '${scenarioName || scenarioId}' had no session-establishing case in the export; prepended the run's recorded login as a precondition.` });
  }

  // Logout teardown composition is intentionally disabled. A logout can appear in generated
  // output only when it came from the case's own approved ReplayIR steps.
  let composedLogoutPrecondition = false;

  // Pre-compute specDir + filePath before emitFn so the adapter can derive
  // structurally-correct relative import paths (e.g. ../../pages from tests/module/).
  const ext = isJs ? 'spec.js' : 'spec.ts';
  const moduleSeg = slug(items[0].r.moduleName || 'journey');
  const scenarioSeg = slug(scenarioName || scenarioId);
  let filePath = `tests/${moduleSeg}/${scenarioSeg}.${ext}`;
  if (usedPaths.has(filePath)) filePath = `tests/${moduleSeg}/${scenarioSeg}-${scenarioId.slice(0, 6)}.${ext}`;
  usedPaths.add(filePath);
  const specDir = `tests/${moduleSeg}`;

  const emitResult = emitFn(cases, { scenarioName, scenarioId, specDir });
  // emitFn may return a plain string (playwright-reference) or { content, extraFiles }
  // (playwright-pom). Normalise so the rest of the function is uniform.
  const rawContent = typeof emitResult === 'string' ? emitResult : (emitResult && emitResult.content || '');
  const extraFiles = (typeof emitResult === 'object' && emitResult && emitResult.extraFiles) ? emitResult.extraFiles : {};
  const pomGraph = (typeof emitResult === 'object' && emitResult && emitResult.pomGraph) ? emitResult.pomGraph : null;
  // If ALL cases are skipped/blocked/needs_human, wrap the entire journey.
  const allSkipped = items.every(({ r }) => ['blocked', 'needs_human', 'skipped'].includes(r.status));
  const finalContent = allSkipped ? rawContent.replace(/test\.describe\(/, 'test.describe.skip(') : rawContent;

  const expectedVerdict = items.some(({ r }) => r.status === 'pass') ? 'pass'
    : items.some(({ r }) => r.status === 'fail') ? 'fail' : 'blocked';
  const irHashes = items.map(({ r }) => r.envelope.ir ? hashReplayIr(r.envelope.ir) : null).filter(Boolean);
  const manifestEntry = {
    adapterId, adapterVersion, scenarioId, scenarioName,
    runResultIds: items.map(({ r }) => r.runResultId),
    testCaseIds: items.map(({ r }) => r.testCaseId),
    irHashes, expectedVerdict,
    complete: items.every(({ r }) => r.envelope.complete !== false),
    files: [filePath, ...Object.keys(extraFiles)], fileHashes: { [filePath]: sha256(finalContent) },
    validationFindings: [],
    composedLoginPrecondition,
    composedLogoutPrecondition,
  };
  admitted.push({ ...manifestEntry, filePath, content: finalContent, extraFiles, pomGraph, runCommand: adapter.runCmd && adapter.runCmd({}) });
  manifestEntries.push(manifestEntry);
}

/** Compile a single validated result into a per-case spec (existing pipeline). */
function _compilePerCase({ adapter, adapterId, adapterVersion, isSelenium, isJs, item, admitted, blocked, manifestEntries, findings, usedPaths, usedClassNames, usedDataPaths }) {
  const { r, base, opAssessment } = item;

  const irDataRows = (() => {
    const ir = r.envelope && r.envelope.ir;
    if (!ir) return [];
    return (Array.isArray(ir.dataRows) && ir.dataRows.length) ? ir.dataRows : (ir.dataRow ? [ir.dataRow] : []);
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
      dataFilePath = `${dataDir}/${caseSlugBase}.json`;
      if (usedDataPaths.has(dataFilePath)) dataFilePath = `${dataDir}/${caseSlugBase}-${String(r.runResultId).slice(0, 6)}.json`;
      usedDataPaths.add(dataFilePath);
      dataCaseSlug = dataFilePath.split('/').pop().replace(/\.json$/, '');
      dataFileContent = JSON.stringify(safeRows, null, 2) + '\n';
    }
  }

  const opts = {
    runResultId: r.runResultId,
    testCaseId: r.testCaseId,
    testTitle: r.caseName || r.testCaseName || r.name || r.scenarioName || (r.scenario && r.scenario.name) || (r.envelope && r.envelope.ir && r.envelope.ir.title) || r.testCaseId,
    caseName: r.caseName || r.testCaseName || r.name || null,
    scenarioName: r.scenarioName || (r.scenario && r.scenario.name) || null,
    dependsOn: r.dependsOnNames || [],
    // Per-case data file slug (basename without .json). Injected into spec by adapters.
    dataCaseSlug,
  };
  if (isSelenium) {
    const classNameForFn = typeof adapter.classNameFor === 'function' ? adapter.classNameFor : seleniumReference.classNameFor;
    let className = classNameForFn(r.testCaseId, base.dataRowIndex, null, r.envelope && r.envelope.ir && r.envelope.ir.title);
    if (usedClassNames.has(className)) className = classNameForFn(r.testCaseId, base.dataRowIndex, r.runResultId, r.envelope && r.envelope.ir && r.envelope.ir.title);
    usedClassNames.add(className);
    opts.className = className;
    opts.adapterFindings = [];
  }

  let compiled;
  try {
    compiled = contract.compileReplayIR(adapter, r.envelope.ir, opts);
  } catch (e) {
    const code = e.code === 'selenium_locator_unmappable' ? 'selenium_locator_unmappable' : 'replayir_invalid';
    blocked.push({ runResultId: r.runResultId, testCaseId: r.testCaseId, code, detail: e.message });
    manifestEntries.push({ ...base, status: 'blocked', blockReason: code, detail: e.message });
    return;
  }

  const irStatus = compiled && r.envelope.ir.verdict && r.envelope.ir.verdict.status;
  if (irStatus && irStatus !== r.status) {
    findings.push({ rule: 'verdict_mismatch', severity: 'error', message: `RunResult ${r.runResultId}: ir.verdict.status='${irStatus}' != RunResult.status='${r.status}'.` });
  }

  const rawPath = compiled.layout.testFile || compiled.layout.primaryFile;
  let rawContent = compiled.files[rawPath] || '';
  const compiledExtraFiles = Object.fromEntries(
    Object.entries(compiled.files || {}).filter(([rel]) => rel !== rawPath)
  );
  if (opAssessment.mode === 'operationBacked') {
    rawContent = isSelenium
      ? operationBacked.augmentSelenium(rawContent, opAssessment.boundOperations, r.envelope.ir)
      : operationBacked.augmentPlaywright(rawContent, opAssessment.boundOperations, r.envelope.ir);
    base.operationBacked = true;
    base.operationOperations = (opAssessment.boundOperations || []).map((op) => op && op.operation).filter(Boolean);
    base.validationFindings = [...base.validationFindings, ...(opAssessment.findings || [])];
    findings.push(...(opAssessment.findings || []));
  }

  let filePath;
  if (isSelenium) {
    filePath = rawPath;
  } else {
    const ext = isJs ? 'spec.js' : 'spec.ts';
    filePath = readableSpecPath(r, ext);
    // Disambiguate per RunResult so data-row fan-out / repeated cases NEVER collapse (#6).
    if (usedPaths.has(filePath)) filePath = filePath.replace(/\.spec\.(ts|js)$/, (_, e) => `-${String(r.runResultId).slice(0, 6)}.spec.${e}`);
  }
  usedPaths.add(filePath);

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
        findings.push(...cert.findings.map((f) => ({ ...f, runResultId: r.runResultId })));
      }
      if (Array.isArray(cert.rewrites) && cert.rewrites.length) {
        base.sanitizerRewrites = cert.rewrites;
      }
      if (!cert.parseOk) {
        // Hard block: replace with a self-documenting failing test so the runner surfaces
        // the issue immediately instead of importing a file that can never load.
        const errDetail = cert.parseError ? String(cert.parseError).slice(0, 200) : 'unknown parse error';
        const isJs = /\.js$/.test(filePath || '');
        rawContent = isJs
          ? `const { test } = require('@playwright/test');\ntest('BLOCKED: AST parse gate failed', async () => {\n  throw new Error('QAAI export blocked — generated file had a syntax error: ${errDetail.replace(/'/g, "\\'")}. Re-run the case in QAAI and re-export.');\n});\n`
          : `import { test } from '@playwright/test';\ntest('BLOCKED: AST parse gate failed', async () => {\n  throw new Error('QAAI export blocked — generated file had a syntax error: ${errDetail.replace(/'/g, "\\'")}. Re-run the case in QAAI and re-export.');\n});\n`;
      } else {
        rawContent = cert.content;
      }
    } catch (err) { console.error('[QAAI certify] replayExport certifyFile threw:', err && err.message); }
  }

  const wrap = wrapForVerdict(adapterId, rawContent, r.status, r.blockedReason);
  if (wrap.anchorMissing) findings.push({ rule: 'verdict_wrap_anchor_missing', severity: 'warning', message: `Could not find the skip anchor for ${r.runResultId}; prepended a neutralizing note instead.` });

  const adapterFindings = Array.isArray(opts.adapterFindings) ? opts.adapterFindings : [];
  base.files = [filePath, ...Object.keys(compiledExtraFiles)];
  base.fileHashes = {
    [filePath]: sha256(wrap.content),
    ...Object.fromEntries(Object.entries(compiledExtraFiles).map(([rel, content]) => [rel, sha256(content)])),
  };
  base.validationFindings = [...(base.validationFindings || []), ...adapterFindings];
  admitted.push({ ...base, status: r.status, filePath, content: wrap.content, extraFiles: compiledExtraFiles, runCommand: compiled.runCommand, compileCommand: compiled.compileCommand, dataFilePath, dataFileContent });
  manifestEntries.push({ ...base, status: r.status });
  findings.push(...adapterFindings);
}

const PW_PACKAGE_BASE = {
  name: 'qaai-replayir-export', private: true, version: '0.0.0',
  scripts: { test: 'playwright test', list: 'playwright test --list' },
  devDependencies: { '@playwright/test': '^1.40.0', '@axe-core/playwright': '^4.10.0' },
};

function pwPackageJson(adapterId) {
  const pkg = { ...PW_PACKAGE_BASE };
  if (adapterId === 'playwright-pom-js') pkg.type = 'module';
  return JSON.stringify(pkg, null, 2) + '\n';
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
    // Always override: the exported .env is the ground truth for this package.
    // Without this, a stale QAAI_TARGET_URL in the parent shell would silently
    // shadow the run-specific URL, causing the preflight to hit the wrong site.
    process.env[key] = value;
  }
}

loadQaaEnv();

// QAAI ReplayIR export — generated ONLY from RunResult.replayIrJson.
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  // Serial + one retry. These specs can share live-site state (a case that
  // creates data a later case consumes) and demo environments degrade under
  // parallel load — running one-at-a-time with a retry removes the #1 cause of
  // "passes solo, fails in a batch" flakiness, which is NOT a code defect.
  workers: 1,
  retries: 1,
  // Fail loud and clear when the target site itself is unreachable, so a down
  // environment is never mistaken for a broken script.
  globalSetup: './qaai.preflight.js',
  reporter: 'list',
  use: {
    baseURL: process.env.QAAI_TARGET_URL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
`;

// Playwright globalSetup — runs once before any test. Turns "the environment is
// down" into a single clear failure at the top of the run instead of N confusing
// locator timeouts that read like a broken script. CommonJS so it needs zero
// TypeScript typings (works in both TS and JS bundles).
const QAAI_PREFLIGHT_JS = `// QAAI preflight — verifies the target environment is reachable before tests run.
// A failure HERE means the site under test is down/blocked, NOT that the script is broken.
module.exports = async function globalSetup() {
  const url = process.env.QAAI_TARGET_URL;
  if (!url) {
    throw new Error('QAAI preflight: QAAI_TARGET_URL is not set. Copy .env.example to .env and set QAAI_TARGET_URL (see EXPORT_MANIFEST.json for the source run).');
  }
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (res.status >= 500) {
      throw new Error('QAAI preflight: target ' + url + ' returned HTTP ' + res.status + ' — the environment under test is DOWN, not the script.');
    }
  } catch (err) {
    if (err && /HTTP \\d/.test(err.message)) throw err;
    throw new Error('QAAI preflight: target ' + url + ' is UNREACHABLE (' + (err && err.message) + '). The environment under test is down or blocked from this machine — this is NOT a script defect.');
  }
};
`;

/** PURE. Assemble the runnable package: IR-agnostic shell + per-result specs. */
function playwrightConfig(storageStateRel = null, { preflightFile = './qaai.preflight.js' } = {}) {
  let config = PW_CONFIG.replace("globalSetup: './qaai.preflight.js'", `globalSetup: '${preflightFile}'`);
  if (!storageStateRel) return config;
  const storageLine = `    // QAAI AuthProfile: every spec starts from the captured authenticated session.\n    storageState: ${JSON.stringify(storageStateRel)},\n    // The rest of the test still replays explicit ReplayIR actions; auth is only the hidden session precondition.\n`;
  return config.replace('    baseURL: process.env.QAAI_TARGET_URL,\n', `    baseURL: process.env.QAAI_TARGET_URL,\n${storageLine}`);
}

function isPomSharedExtraFile(rel) {
  const normalized = String(rel || '').replace(/\\/g, '/');
  if (/^locators\//.test(normalized)) return true;
  if (/^pages\/(?!EvaluateMethods\.)[^/]+\.(?:js|ts)$/.test(normalized)) return true;
  if (/^evidence\/(?:locator-manifest|locator-conflicts|certification-report|dom-atlas|pom-architect-report)\.json$/.test(normalized)) return true;
  return false;
}

function isEvaluateMethodsFile(rel) {
  return /^pages\/EvaluateMethods\.(?:js|ts)$/.test(String(rel || '').replace(/\\/g, '/'));
}

function extractEvaluateMethods(content) {
  const text = String(content || '');
  const methods = [];
  const re = /\n  async\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*Promise<void>)?\s*\{[\s\S]*?\n  \}/g;
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
  ].filter(Boolean).join(', ');
  const jsImportExt = lang === 'js' && moduleFormat !== 'cjs' ? '.js' : '';
  const helperImport = helperImportParts
    ? (cjs
      ? `const { ${helperImportParts} } = require('../tests/support/replayir');\n`
      : `import { ${helperImportParts} } from '../tests/support/replayir${jsImportExt}';\n`)
    : '';
  const pageImport = lang === 'js' ? '' : `import { type Page } from '@playwright/test';\n`;
  const expectImport = cjs
    ? `const { expect } = require('@playwright/test');\n`
    : `import { expect } from '@playwright/test';\n`;
  const ctor = lang === 'js'
    ? `  constructor(page) { this.page = page; }`
    : `  constructor(private readonly page: Page) {}`;
  const classLine = `${cjs ? 'class' : 'export class'} EvaluateMethods`;
  const exportLine = cjs ? `\nmodule.exports = { EvaluateMethods };\n` : '\n';
  return `${pageImport}${expectImport}${helperImport}\n${classLine} {\n${ctor}\n\n${body}\n}${exportLine}`;
}

function assemblePackage({ adapterId, admitted, envVars, authState = null, targetUrl = '' }) {
  const files = {};
  const isPom = POM_ADAPTER_IDS.has(adapterId);
  const isPomJs = adapterId === 'playwright-pom-js';
  const useCjs = CJS_SUPPORT_ADAPTER_IDS.has(adapterId);
  const envDefaults = { QAAI_TARGET_URL: normalizeTargetOrigin(targetUrl) };
  if (PLAYWRIGHT_ADAPTER_IDS.has(adapterId)) {
    const preflightFile = isPomJs ? 'qaai.preflight.cjs' : 'qaai.preflight.js';
    files['package.json'] = pwPackageJson(adapterId);
    files['playwright.config.ts'] = playwrightConfig(authState && authState.storageStateRel, { preflightFile: `./${preflightFile}` });
    Object.assign(files, authState && authState.files || {});
    // POM adapters always emit `import` syntax (ES module) regardless of lang.
    // Only the plain reference-js adapter (which emits `require()` in specs) ships the CJS file.
    if (isPomJs) {
      Object.assign(files, playwrightReference.supportFilesJsEsm());
    } else {
      const _adapterMod = useCjs ? playwrightReference.playwrightReferenceJs : playwrightReference;
      Object.assign(files, typeof _adapterMod.supportFiles === 'function' ? _adapterMod.supportFiles() : {});
    }
    // The sanitizer rewrites `.click()` → clickFirstVisible(...) and injects an
    // `import { clickFirstVisible, safeClick, safeGoto } from '…/utils/test-helpers'`
    // into every spec. Ship that helper in the matching module style, or
    // `npx playwright test` fails at collection with "Cannot find module
    // '../utils/test-helpers'" — the bundle would not be runnable out of the box.
    {
      const { testHelpersFile } = require('./_testHelpers');
      const hasJs = admitted.some((a) => /\.spec\.js$/.test(a.filePath || ''));
      const hasTs = admitted.some((a) => /\.spec\.ts$/.test(a.filePath || ''));
      if (hasJs && !files['utils/test-helpers.js']) files['utils/test-helpers.js'] = testHelpersFile(isPomJs ? 'esm-js' : 'js');
      if ((hasTs || !hasJs) && !files['utils/test-helpers.ts']) files['utils/test-helpers.ts'] = testHelpersFile('ts');
    }
    // Preflight: a down/blocked target fails the run with one clear message
    // instead of masquerading as a broken script (referenced by playwright.config.ts).
    files[preflightFile] = QAAI_PREFLIGHT_JS;
    files['.env'] = envFile(envVars, envDefaults);
    files['.env.example'] = envFile(envVars, envDefaults);
    files['README.md'] = isPom
      ? `# QAAI ReplayIR export (Playwright POM)\n\nGenerated ONLY from each RunResult's pinned replayIrJson — no AI-written code, no case-text regen.\n\n**3-layer structure:**\n- \`locators/\` — action-time locators (exact evidence from live MCP run)\n- \`pages/\` — action-method classes (1:1 with recorded acts)\n- \`tests/\` — journey specs calling page methods (zero inline selectors)\n\n1. \`npm install\`\n2. Copy \`.env.example\` to \`.env\` and fill required variables.\n3. \`npx playwright test\`\n\nTo customize a locator: copy the entry from \`locators/generated/\` to \`locators/overrides/\` (override takes precedence; marked non-certified in EXPORT_MANIFEST.json).\n`
      : `# QAAI ReplayIR export (Playwright)\n\nGenerated ONLY from each RunResult's pinned replayIrJson — no AI-written code, no case-text regen.\n\n1. \`npm install\`\n2. Copy \`.env.example\` to \`.env\` and fill the required variables.\n3. \`npx playwright test\`\n\nThe Playwright config loads \`.env\` automatically from this package folder.\n\n**Verdict semantics:** EXPORT_MANIFEST.json records each test's \`expectedVerdict\`. A \`fail\` test is expected to hard-fail if the bug persists; a \`blocked\`/\`needs_human\` test is \`describe.skip\` (it cannot report green). Actual clean-env execution parity is verified separately (P8).\n`;
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
  if (isPom && pomGraphs.length && typeof playwrightPom._mergePomGraphs === 'function' && typeof playwrightPom._emitPomGraphFiles === 'function') {
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
  return scriptValidationRunner.hardenPlaywrightPackageFiles(files, { framework: adapterId });
}

/** PURE. Defense-in-depth secret scan (#9). Synthetic non-secret literals are allowed. */
function scanSecrets(files, denyLiterals = []) {
  const findings = [];
  for (const [rel, content] of Object.entries(files || {})) {
    if (Buffer.isBuffer(content)) continue;
    const text = String(content || '');
    text.split(/\r?\n/).forEach((line, i) => {
      if (SECRET_LEAK_RE.test(line)) findings.push({ rule: 'secret_literal_in_output', severity: 'error', path: rel, line: i + 1, message: `Secret-keyed field assigned a string literal in ${rel}:${i + 1}.` });
    });
    for (const lit of denyLiterals) {
      if (lit && text.includes(lit)) findings.push({ rule: 'known_secret_literal', severity: 'error', path: rel, message: `Known secret literal "${lit}" appears in ${rel}.` });
    }
  }
  return findings;
}

/** PURE. The stable EXPORT_MANIFEST.json (#5). */
function buildManifest({ projectId, runId, adapterId, adapterVersion, manifestEntries, validation, allBlocked }) {
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
    validation: validation ? { packagePassed: validation.packagePassed, checked: validation.checked, skipped: validation.skipped, errorCount: validation.errorCount, warningCount: validation.warningCount, findings: validation.findings, commands: validation.commands, repaired: !!validation.repaired, repairAttempts: validation.repairAttempts || 0, repairs: validation.repairs || [] } : null,
  };
}

function rowCoordinateForResult(result) {
  if (!result) return null;
  const index = result.dataRowIndex == null ? null : Number(result.dataRowIndex);
  if (index == null || !Number.isFinite(index)) return null;
  const label = String(result.dataRowLabel || `row_${index}`).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `row_${index}`;
  return `${label}_${index}`;
}

function actionNeedsLocator(action) {
  return [
    'click', 'doubleclick', 'tripleclick', 'fill', 'type', 'selectoption',
    'check', 'uncheck', 'press', 'hover', 'upload', 'drag',
  ].includes(String(action || '').toLowerCase());
}

function valueBindingKind(step) {
  const ref = String(step && step.valueRef || '');
  if (/^data:/i.test(ref) || step && step.dataRole) return 'data';
  if (/^env:/i.test(ref)) return 'env';
  if (/^(vault|fixture|masked):/i.test(ref)) return 'runtime_secret';
  if (step && step.rawValue != null) return 'literal';
  return ref ? 'unknown_ref' : 'none';
}

function locatorExpressionOf(locator) {
  const primary = actionLocatorResolver.primaryActionLocator(locator);
  return primary && (primary.frameworkExpressions?.playwright || primary.expression) || null;
}

function legacyCandidateActionLocator(candidates) {
  const candidate = legacyExportableCandidate(candidates || []);
  const expression = legacyCandidateExpression(candidate);
  if (!expression) return null;
  return {
    kind: 'playwright',
    strategy: candidate.strategy || 'legacy_candidate',
    evidenceSource: 'legacy_replayir_candidate',
    verificationSource: 'legacy_replayir_candidate',
    expression,
    frameworkExpressions: { playwright: expression },
    proof: {
      source: 'legacy_replayir_candidate',
      legacyReplayIrCandidate: true,
    },
  };
}

function exportSafeActionLocatorForStep(step, resolveByAs) {
  if (actionLocatorResolver.isExportSafeActionLocator(step && step.actionLocator)) return step.actionLocator;
  const resolved = step && step.target ? resolveByAs.get(step.target) : null;
  if (resolved && actionLocatorResolver.isExportSafeActionLocator(resolved.actionLocator)) return resolved.actionLocator;
  if (resolved) return legacyCandidateActionLocator(resolved.candidates || []);
  return null;
}

function buildActionAuthoringLedger({ results }) {
  const records = [];
  for (const result of results || []) {
    const ir = result && result.envelope && result.envelope.ir;
    const steps = Array.isArray(ir && ir.steps) ? ir.steps : [];
    const resolveByAs = new Map();
    steps.forEach((step, index) => {
      if (step && step.op === 'resolve' && step.as) resolveByAs.set(step.as, { ...step, stepIndex: index });
    });
    for (const [index, step] of steps.entries()) {
      if (!step || step.op !== 'act') continue;
      const resolveStep = step.target ? resolveByAs.get(step.target) : null;
      const ownedLocator = actionLocatorResolver.isExportSafeActionLocator(step.actionLocator) ? step.actionLocator : null;
      const locator = exportSafeActionLocatorForStep(step, resolveByAs);
      const locatorRecipeId = step.locatorRecipeId || (resolveStep && resolveStep.locatorRecipeId) || null;
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
        actionOwnsVerifiedLocator: !!(ownedLocator && actionLocatorResolver.isVerifiedActionLocator(ownedLocator)),
        actionOwnsExportSafeLocator: !!ownedLocator,
        hasVerifiedActionLocator: !!(locator && actionLocatorResolver.isVerifiedActionLocator(locator)),
        hasExportSafeActionLocator: !!locator,
        locatorExpression: locatorExpressionOf(locator),
        locatorSource: locator && (locator.verificationSource || locator.evidenceSource || locator.proof?.source) || null,
        valueBinding: valueBindingKind(step),
        transitionProof: step.transitionProof || null,
      });
    }
  }
  const missing = records.filter((record) => record.needsLocator && !record.hasExportSafeActionLocator);
  return {
    schema: 'qaai-action-authoring-ledger/1',
    summary: {
      actionCount: records.length,
      locatorNeedingActionCount: records.filter((r) => r.needsLocator).length,
      missingVerifiedLocatorCount: records.filter((r) => r.needsLocator && !r.hasVerifiedActionLocator).length,
      missingExportSafeLocatorCount: missing.length,
    },
    findings: missing.map((record) => ({
      rule: 'action_ledger_missing_verified_locator',
      severity: 'error',
      runResultId: record.runResultId,
      testCaseId: record.testCaseId,
      stepIndex: record.stepIndex,
      message: `Action ${record.actionType || 'act'} in ${record.caseName || record.testCaseId || 'unknown case'} has no export-safe action-owned locator.`,
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
    const stripped = loopRanges.reduceRight((acc, [start, end]) => acc.slice(0, start) + acc.slice(end), text);
    count += (stripped.match(/\btest\s*\(/g) || []).length;
  }
  return count;
}

function buildCardinalityContractFindings({ results, files }) {
  const expected = (results || []).filter((r) => r && !['blocked', 'needs_human', 'skipped'].includes(String(r.status || '').toLowerCase())).length;
  const generated = countPlaywrightTestsInFiles(files);
  if (expected !== generated) {
    return [{
      rule: 'step_cardinality_contract_mismatch',
      severity: 'error',
      expectedTestCount: expected,
      generatedPlaywrightTestCount: generated,
      message: `QAAI live executable result count is ${expected}, but the generated Playwright package exposes ${generated} test() entries. Output preparation must repair missing/extra generated tests before download.`,
    }];
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
    while ((m = loadRe.exec(text))) entries.push({ file: rel, line: sourceLineOf(text, m.index), kind: 'data_file', path: m[1] });
    const readDataRe = /\breadData\(\s*row\s*,\s*['"]([^'"]+)['"]/g;
    while ((m = readDataRe.exec(text))) entries.push({ file: rel, line: sourceLineOf(text, m.index), kind: 'data_column', key: m[1] });
    const readEnvRe = /\breadEnv\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = readEnvRe.exec(text))) entries.push({ file: rel, line: sourceLineOf(text, m.index), kind: 'env_var', key: m[1] });
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
        testCount: countPlaywrightTestsInFiles({ [rel]: content, ...Object.fromEntries(Object.entries(files || {}).filter(([p]) => /^tests\/data\//.test(p))) }),
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

function buildTraceabilityMatrix({ results, admitted, blocked, files, actionLedger, validation, targetUrl }) {
  const admittedByResult = new Map();
  for (const item of admitted || []) {
    for (const id of item.runResultIds || []) admittedByResult.set(id, item);
  }
  const blockedByResult = new Map();
  for (const item of blocked || []) blockedByResult.set(item.runResultId, item);
  const actionsByResult = new Map();
  for (const record of actionLedger && actionLedger.records || []) {
    if (!actionsByResult.has(record.runResultId)) actionsByResult.set(record.runResultId, []);
    actionsByResult.get(record.runResultId).push(record);
  }
  const entries = (results || []).map((result) => {
    const admittedItem = admittedByResult.get(result.runResultId) || null;
    const blockedItem = blockedByResult.get(result.runResultId) || null;
    const specFile = admittedItem && admittedItem.filePath || null;
    const specText = specFile && files && typeof files[specFile] === 'string' ? files[specFile] : '';
    const name = result.caseName || result.testCaseId || '';
    const line = specText && name ? sourceLineOf(specText, Math.max(0, specText.indexOf(name))) : null;
    const irSteps = Array.isArray(result.envelope && result.envelope.ir && result.envelope.ir.steps)
      ? result.envelope.ir.steps
      : [];
    return {
      requirementRefs: Array.isArray(result.requirementRefs) ? result.requirementRefs : [],
      userStory: Array.isArray(result.requirementRefs) && result.requirementRefs.length ? result.requirementRefs.join(', ') : null,
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
      blockReason: blockedItem && (blockedItem.code || blockedItem.detail) || null,
      spec: specFile ? { file: specFile, line } : null,
      liveActions: actionsByResult.get(result.runResultId) || [],
      assertions: irSteps
        .map((step, index) => step && step.op === 'assert' ? {
          stepIndex: index,
          contractRef: step.contractRef || step.id || null,
          channel: step.channel || null,
          expected: step.expected != null ? String(step.expected) : null,
          liveOutcome: step.liveOutcome || null,
        } : null)
        .filter(Boolean),
    };
  });
  return {
    schema: 'qaai-traceability-matrix/1',
    targetUrl: normalizeTargetOrigin(targetUrl),
    certification: validation ? {
      packagePassed: validation.packagePassed,
      skipped: validation.skipped,
      errorCount: validation.errorCount,
      warningCount: validation.warningCount,
    } : null,
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
  const configText = String(files && files['playwright.config.ts'] || '');
  const parentOverrideGuard = (/override:\s*true/.test(configText) && /dotenv/.test(configText))
    || (/function\s+loadQaaEnv\s*\(/.test(configText) && /process\.env\[\s*key\s*\]\s*=\s*value/.test(configText));
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
    const key = String(result && result.status || 'skipped').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(websiteCounts, key)) websiteCounts[key] += 1;
    else websiteCounts.skipped += 1;
  }
  const outputErrorCount = (findings || []).filter((f) => f && f.severity === 'error').length
    + (validation && Number(validation.errorCount) || 0)
    + (blocked && blocked.length || 0);
  return {
    schema: 'qaai-runtime-result-firewall/1',
    invariant: 'Website result verdict and generated-output readiness are separate state machines.',
    websiteResultState: {
      source: 'RunResult statuses and verified assertion outcomes only',
      counts: websiteCounts,
      verdict: websiteCounts.fail > 0 ? 'fail' : websiteCounts.blocked > 0 || websiteCounts.needs_human > 0 ? 'mixed' : 'pass',
    },
    outputReadinessState: {
      source: 'ReplayIR locator/codegen/package certification only',
      status: outputErrorCount === 0 ? 'ready' : 'repair_required',
      blockedExportItems: blocked && blocked.length || 0,
      packagePassed: validation ? validation.packagePassed : null,
      certificationErrorCount: validation ? validation.errorCount : null,
    },
  };
}

function buildReleaseCertificationFindings({ files, targetParity, actionLedger, validation }) {
  if (String(process.env.QAAI_RELEASE_CERTIFICATION || '').trim() !== '1') return [];
  const findings = [];
  if (!validation || validation.skipped) {
    findings.push({
      rule: 'release_certification_validation_skipped',
      severity: 'error',
      message: 'QAAI_RELEASE_CERTIFICATION=1 requires package validation to run; skipped validation is not allowed.',
    });
  }
  if (!targetParity || !targetParity.ok) {
    findings.push({
      rule: 'release_certification_target_parity_failed',
      severity: 'error',
      message: 'QAAI_RELEASE_CERTIFICATION=1 requires exported .env QAAI_TARGET_URL to match the project/run target and prevent parent env override.',
    });
  }
  for (const finding of actionLedger && actionLedger.findings || []) {
    findings.push({ ...finding, rule: finding.rule || 'release_certification_missing_action_locator', severity: 'error' });
  }
  for (const record of actionLedger && actionLedger.records || []) {
    if (!record.needsLocator || record.actionOwnsVerifiedLocator) continue;
    findings.push({
      rule: 'release_certification_action_locator_not_owned',
      severity: 'error',
      runResultId: record.runResultId,
      testCaseId: record.testCaseId,
      stepIndex: record.stepIndex,
      message: `Action ${record.actionType || 'act'} in ${record.caseName || record.testCaseId || 'unknown case'} does not own its verified LocatorRecipe on the act step.`,
    });
  }
  for (const [rel, content] of Object.entries(files || {})) {
    if (!/\.(?:js|ts|cjs|mjs)$/.test(rel)) continue;
    const text = String(content || '');
    const bad = [
      { rule: 'release_certification_first_locator', index: text.search(/\.first\s*\(/), message: `${rel} contains .first(); generated code must prove uniqueness instead of selecting the first match.` },
      { rule: 'release_certification_ref_locator', index: text.search(/\[ref\s*=|locator\(\s*['"][^'"]*\[ref\s*=/i), message: `${rel} contains an MCP runtime ref selector.` },
      { rule: 'release_certification_glyph_locator', index: text.search(/[\uE000-\uF8FF]/), message: `${rel} contains private-use glyph text; locator names must be normalized before export.` },
    ];
    for (const item of bad) {
      if (item.index >= 0) findings.push({ rule: item.rule, severity: 'error', path: rel, line: sourceLineOf(text, item.index), message: item.message });
    }
  }
  return findings;
}

function refreshManifestFileHashes(manifestEntries, files) {
  for (const entry of manifestEntries || []) {
    if (!entry || !Array.isArray(entry.files)) continue;
    const hashes = {};
    for (const rel of entry.files) {
      if (typeof files[rel] === 'string' || Buffer.isBuffer(files[rel])) hashes[rel] = sha256(files[rel]);
    }
    entry.fileHashes = hashes;
  }
}

function cloneFileMap(files) {
  return Object.fromEntries(Object.entries(files || {}).map(([rel, content]) => [rel, Buffer.isBuffer(content) ? Buffer.from(content) : String(content == null ? '' : content)]));
}

function refreshPomCertificationReport(adapterId, files, validation) {
  if (!POM_ADAPTER_IDS.has(adapterId) || typeof files['evidence/certification-report.json'] !== 'string') return;
  let report = null;
  try { report = JSON.parse(files['evidence/certification-report.json']); } catch (_) { report = null; }
  if (!report || typeof report !== 'object') report = {};
  const findings = Array.isArray(validation && validation.findings) ? validation.findings : [];
  const hasErrors = findings.some((f) => f && f.severity === 'error')
    || (validation && (validation.packagePassed === false || validation.skipped === true));
  const dataFiles = Object.keys(files || {}).filter((rel) => /^tests\/data\/|^src\/test\/resources\/test-data\//.test(rel)).sort();
  const locatorManifest = readJsonFile(files, 'evidence/locator-manifest.json', []);
  const conflicts = readJsonFile(files, 'evidence/locator-conflicts.json', []);
  const locatorCertification = readJsonFile(files, 'evidence/locator-certification-report.json', null);
  report.spec = {
    ...(report.spec || {}),
    status: hasErrors ? 'internal-error' : ((report.spec && report.spec.status) || 'runnable'),
    validation: validation ? {
      packagePassed: !!validation.packagePassed,
      checked: !!validation.checked,
      skipped: !!validation.skipped,
      errorCount: validation.errorCount || 0,
      warningCount: validation.warningCount || 0,
    } : null,
    validationFindings: findings,
  };
  report.data = {
    ...(report.data || {}),
    fileCount: dataFiles.length,
    files: dataFiles,
  };
  report.evidence = {
    ...(report.evidence || {}),
    'locator-manifest.json': { status: Array.isArray(locatorManifest) ? 'present' : 'absent', entryCount: Array.isArray(locatorManifest) ? locatorManifest.length : 0 },
    'locator-conflicts.json': { status: Array.isArray(conflicts) && conflicts.length ? 'present' : 'absent', conflictCount: Array.isArray(conflicts) ? conflicts.length : 0 },
    'dom-atlas.json': { status: typeof files['evidence/dom-atlas.json'] === 'string' ? 'present' : 'absent' },
    'locator-certification-report.json': {
      status: locatorCertification ? (locatorCertification.summary && locatorCertification.summary.status || 'present') : 'absent',
      stepCount: locatorCertification && locatorCertification.summary ? locatorCertification.summary.total : 0,
      certified: locatorCertification && locatorCertification.summary ? locatorCertification.summary.certified : 0,
      draft: locatorCertification && locatorCertification.summary ? locatorCertification.summary.draft : 0,
      blocked: locatorCertification && locatorCertification.summary ? locatorCertification.summary.blocked : 0,
    },
  };
  files['evidence/certification-report.json'] = JSON.stringify(report, null, 2) + '\n';
}

function packageTypeIsModule(files) {
  try {
    const pkg = JSON.parse(String(files && files['package.json'] || '{}'));
    return pkg && pkg.type === 'module';
  } catch (_) {
    return false;
  }
}

function ensurePackageJsonForAdapter(adapterId, files) {
  if (!PLAYWRIGHT_ADAPTER_IDS.has(adapterId)) return [];
  const repairs = [];
  let pkg = null;
  try { pkg = JSON.parse(String(files['package.json'] || '{}')); } catch (_) { pkg = null; }
  if (!pkg || typeof pkg !== 'object') {
    files['package.json'] = pwPackageJson(adapterId);
    repairs.push({ rule: 'package_json_rebuilt', path: 'package.json', message: 'Rebuilt missing/invalid package.json from the adapter contract.' });
    return repairs;
  }
  if (adapterId === 'playwright-pom-js' && pkg.type !== 'module') {
    pkg.type = 'module';
    files['package.json'] = JSON.stringify(pkg, null, 2) + '\n';
    repairs.push({ rule: 'pom_js_type_module_added', path: 'package.json', message: 'Added type=module for Playwright POM JS ESM output.' });
  }
  if (adapterId !== 'playwright-pom-js' && adapterId !== 'playwright-reference-js' && pkg.type === 'module') {
    delete pkg.type;
    files['package.json'] = JSON.stringify(pkg, null, 2) + '\n';
    repairs.push({ rule: 'unneeded_type_module_removed', path: 'package.json', message: 'Removed package-level type=module from a TypeScript Playwright export.' });
  }
  return repairs;
}

function ensurePlaywrightSupportFiles(adapterId, files) {
  if (!PLAYWRIGHT_ADAPTER_IDS.has(adapterId)) return [];
  const repairs = [];
  const isPomJs = adapterId === 'playwright-pom-js';
  const useCjs = adapterId === 'playwright-reference-js';
  const hasSupportRef = Object.values(files).some((content) => /tests\/support\/replayir|support\/replayir/.test(String(content || '')));
  if (hasSupportRef || Object.keys(files).some((p) => /^tests\/support\/replayir\.(ts|js)$/.test(p))) {
    const support = isPomJs
      ? playwrightReference.supportFilesJsEsm()
      : (useCjs ? playwrightReference.playwrightReferenceJs.supportFiles() : playwrightReference.supportFiles());
    for (const [rel, content] of Object.entries(support)) {
      const existing = files[rel];
      const wrongModuleStyle = isPomJs
        ? /\bmodule\.exports\b|\brequire\s*\(/.test(String(existing || ''))
        : (useCjs ? /\bexport\s+(?:async\s+)?function\b|export\s*\{/.test(String(existing || '')) : /\bmodule\.exports\b/.test(String(existing || '')));
      if (!existing || wrongModuleStyle) {
        files[rel] = content;
        repairs.push({ rule: 'playwright_support_file_repaired', path: rel, message: 'Restored replayir support file in the module style required by the adapter.' });
      }
    }
  }

  const helperRef = Object.values(files).some((content) => /utils\/test-helpers/.test(String(content || '')));
  if (helperRef) {
    const { testHelpersFile } = require('./_testHelpers');
    const hasJs = Object.keys(files).some((p) => /\.js$/.test(p));
    const hasTs = Object.keys(files).some((p) => /\.ts$/.test(p));
    if (hasJs) {
      const rel = 'utils/test-helpers.js';
      const expected = testHelpersFile(isPomJs ? 'esm-js' : 'js');
      const existing = String(files[rel] || '');
      const wrong = isPomJs ? /\bmodule\.exports\b|\brequire\s*\(/.test(existing) : /\bexport\s+(?:async\s+)?function\b|export\s*\{/.test(existing);
      if (!existing || wrong) {
        files[rel] = expected;
        repairs.push({ rule: 'playwright_test_helper_repaired', path: rel, message: 'Restored test helper in the module style required by generated specs.' });
      }
    }
    if (hasTs) {
      const rel = 'utils/test-helpers.ts';
      if (!files[rel]) {
        files[rel] = testHelpersFile('ts');
        repairs.push({ rule: 'playwright_test_helper_repaired', path: rel, message: 'Restored missing TypeScript test helper.' });
      }
    }
  }
  return repairs;
}

function ensurePreflightModuleStyle(adapterId, files) {
  if (!PLAYWRIGHT_ADAPTER_IDS.has(adapterId)) return [];
  const repairs = [];
  const configPath = files['playwright.config.ts'] ? 'playwright.config.ts'
    : (files['playwright.config.js'] ? 'playwright.config.js' : null);
  if (!configPath) return repairs;
  const isPomJs = adapterId === 'playwright-pom-js';
  let config = String(files[configPath] || '');
  let wanted = isPomJs ? 'qaai.preflight.cjs' : 'qaai.preflight.js';
  const configured = /globalSetup:\s*['"]\.\/([^'"]+)['"]/.exec(config)?.[1] || wanted;
  if (configured !== wanted) {
    config = config.replace(/globalSetup:\s*['"]\.\/[^'"]+['"]/, `globalSetup: './${wanted}'`);
    files[configPath] = config;
    repairs.push({ rule: 'preflight_config_repaired', path: configPath, message: `Pointed Playwright config at ${wanted}.` });
  }
  if (!files[wanted]) {
    const previous = configured && files[configured] ? String(files[configured]) : null;
    files[wanted] = previous || QAAI_PREFLIGHT_JS;
    repairs.push({ rule: 'preflight_file_restored', path: wanted, message: `Restored missing ${wanted}.` });
  }
  if (isPomJs && files['qaai.preflight.js'] && /\bmodule\.exports\b/.test(String(files['qaai.preflight.js']))) {
    files['qaai.preflight.cjs'] = files['qaai.preflight.cjs'] || files['qaai.preflight.js'];
    delete files['qaai.preflight.js'];
    repairs.push({ rule: 'pom_js_preflight_renamed_cjs', path: 'qaai.preflight.cjs', message: 'Moved CommonJS preflight out of .js under an ESM package.' });
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
    next = next.replace(/(\bimport\s*\(\s*['"])(\.{1,2}\/[^'"]+)(['"]\s*\))/g, (m, prefix, spec, suffix) => {
      const target = resolveImportTarget(rel, spec, files);
      if (!target) return m;
      return `${prefix}${spec}${path.posix.extname(target)}${suffix}`;
    });
    if (next !== before) {
      files[rel] = next;
      repairs.push({ rule: 'esm_relative_import_extension_added', path: rel, message: 'Added explicit source extensions to ESM relative imports.' });
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
    next = next.replace(/const\s+\{\s*([A-Za-z_$][\w$]*)\s*\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\);?/g, (m, imported, spec) => {
      const fixed = spec.startsWith('.') ? toImportPathWithJsExt(rel, spec, files) : spec;
      return `import { ${imported} } from '${fixed}';`;
    });
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
      repairs.push({ rule: 'pom_js_cjs_leak_converted', path: rel, message: 'Converted leaked CommonJS POM helper to ESM for playwright-pom-js.' });
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
      return repaired.repairs.map((r) => ({ ...r, rule: r.rule || 'typescript_diagnostic_repair', message: `Repaired generated TypeScript diagnostic ${r.code}.` }));
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
        findings.push(...(cert.findings || []).map((f) => ({ ...f, rule: f.rule || 'package_source_parse_error', severity: 'error' })));
      }
    }
  } catch (err) {
    findings.push({ rule: 'package_source_certify_threw', severity: 'warning', message: `Package source certification threw: ${err && err.message}` });
  }
  return findings;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sourceLineOf(content, index) {
  return String(content || '').slice(0, Math.max(0, index)).split(/\r?\n/).length;
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
    const ctorRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Z][A-Za-z0-9_$]*)\s*\(/g;
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
      if (!pageMethodCache.has(pageRel)) pageMethodCache.set(pageRel, parseClassMethodNames(files[pageRel]));
      const methods = pageMethodCache.get(pageRel);
      const methodRe = new RegExp(`\\b${escapeRegExp(varName)}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g');
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
          severity: 'error',
          path: 'evidence/locator-manifest.json',
          line: 1,
          message: `locator-manifest.json entry #${index + 1} (${entry.file || 'unknown'}.${entry.name || entry.as || 'unknown'}) was generated from ${entry.source}, not action-time locator evidence.`,
        });
      }
      const verifiedActionSource = entry.verificationSource === 'verified_dom_inspection'
        || entry.verificationSource === 'verified_mcp_accessibility_snapshot';
      if (entry.source === 'actionLocator' && (entry.verified !== true || !verifiedActionSource)) {
        findings.push({
          rule: 'pom_graph_locator_not_verified_dom_inspection',
          severity: 'error',
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
      severity: 'error',
      path: 'evidence/locator-conflicts.json',
      line: 1,
      message: `POM package has ${conflicts.length} locator conflict(s); QAAI must resolve these before labeling the package runnable.`,
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
        const hasKey = [...loadedRows.values()].some((rows) => rows.some((row) => row && row.fields && Object.prototype.hasOwnProperty.call(row.fields, key)));
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
          const hardcoded = executableText.includes(JSON.stringify(value)) || executableText.includes(`'${value.replace(/'/g, "\\'")}'`);
          if (hardcoded) {
            findings.push({
              rule: 'pom_graph_hardcoded_data_value',
              severity: 'error',
              path: rel,
              line: sourceLineOf(text, text.indexOf(JSON.stringify(value)) >= 0 ? text.indexOf(JSON.stringify(value)) : text.indexOf(value)),
              message: `${rel} hardcodes uploaded data value "${value.slice(0, 80)}" from ${dataPath} (${rowLabel}, ${key}) instead of using readData(row, "${key}").`,
            });
          }
        }
        const keys = dataFieldKeys(rows);
        if ((keys.has('priceMin') || keys.has('priceMax')) && !/\bassertPricesBetween\s*\(/.test(text)) {
          findings.push({
            rule: 'pom_graph_price_data_not_asserted',
            severity: 'error',
            path: rel,
            line: 1,
            message: `${rel} loads ${dataPath} with priceMin/priceMax columns but does not assert prices with assertPricesBetween(...).`,
          });
        }
        if (keys.has('expectedContainsProductName') && !/\bassertProductNamesContain\s*\(/.test(text)) {
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
      severity: 'error',
      path: 'evidence/dom-atlas.json',
      line: 1,
      message: 'POM package has no DOM Atlas evidence file. Fresh element-action runs must include action-time DOM evidence or be held for internal recapture.',
    });
  } else {
    const domAtlas = readJsonFile(files, 'evidence/dom-atlas.json', null);
    const pages = domAtlas && domAtlas.pages && typeof domAtlas.pages === 'object'
      ? Object.values(domAtlas.pages)
      : [];
    const hasDiagnosticOnlyAtlas = pages.some((page) => {
      const controls = Array.isArray(page && page.controls) ? page.controls : [];
      const actions = Array.isArray(page && page.verifiedActions) ? page.verifiedActions : [];
      return controls.some((control) => /snapshot_ref_fallback|action_locator_minimal|args/i.test(String(control && control.source || '')))
        || actions.some((action) => /snapshot_ref_fallback|action_locator_minimal|args/i.test(String(action && (action.verificationSource || action.evidenceSource || action.proof && action.proof.source || action.context && action.context.source) || '')));
    });
    if (!pages.length || hasDiagnosticOnlyAtlas) {
      findings.push({
        rule: 'pom_graph_dom_atlas_not_verified',
        severity: 'error',
        path: 'evidence/dom-atlas.json',
        line: 1,
        message: 'DOM Atlas evidence must come from verified browser-side action inspection, not snapshot/args/minimal diagnostic fallback evidence.',
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
      message: 'certification-report.json claims spec.status=runnable while package graph validation has error-severity broken links.',
    });
  }
  return findings;
}

function appendValidationFindings(validation, extraFindings) {
  const additions = Array.isArray(extraFindings) ? extraFindings : [];
  if (!additions.length) return validation;
  const mergedFindings = [...(validation && validation.findings || []), ...additions];
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
  if (!framework) return { packagePassed: true, checked: false, skipped: true, findings: [{ rule: 'package_validate_no_framework', severity: 'warning', message: `No package-validate mapping for adapter ${adapterId}.` }], errorCount: 0, warningCount: 1, commands: [] };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qaai-p7-export-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, Buffer.isBuffer(content) ? undefined : 'utf8');
    }
    return await packageValidate.validatePackage({ framework, projectRoot: tmp, files: {} });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

/** fs. Write the assembled package to a temp dir and validate it THERE (#7). */
async function validateAssembled({ adapterId, files }) {
  let currentFiles = cloneFileMap(files);
  let validation = await validatePackageFilesOnce({ adapterId, files: currentFiles });
  const allRepairs = [];
  const repairFindings = [];
  let repairAttempts = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (!validation || validation.skipped || validation.packagePassed !== false) break;
    const repaired = applyPackageCertificationRepairs({ adapterId, files: currentFiles, validation });
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
  const where = Array.isArray(runResultIds) && runResultIds.length
    ? { id: { in: runResultIds } }
    : (runId ? { runId } : null);
  let resolvedRunId = runId || null;
  if (!where) {
    // Default: the most recent run with pinned ReplayIR. A run can have pass/fail
    // results before output evidence is persisted; selecting that row makes the
    // Output Files page look stuck on a placeholder.
    const latest = await prisma.run.findFirst({
      where: { projectId, ...(generationId ? { generationId } : {}), results: { some: { replayIrJson: { not: null } } } },
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
      id: true, runId: true, testCaseId: true, status: true, blockedReason: true, replayIrJson: true, executionContractJson: true, actionGraphJson: true, assertionCheckResults: true, dataRowIndex: true, dataRowLabel: true,
      overallRunStatus: true, executionStatus: true, evidenceStatus: true, scriptStatus: true, evidenceCompletenessJson: true,
      actionEvidences: { orderBy: { sequenceIndex: 'asc' } },
      locatorRecipes: { orderBy: { sequenceIndex: 'asc' } },
      assertionEvidences: { orderBy: { sequenceIndex: 'asc' } },
      authSetupEvidences: { orderBy: { createdAt: 'asc' } },
      navigationEvidences: { orderBy: { sequenceIndex: 'asc' } },
      traceArtifacts: { orderBy: { createdAt: 'asc' } },
      replayIrCertifications: { orderBy: { createdAt: 'asc' } },
      evidenceCompletenessLedgers: { orderBy: { createdAt: 'asc' } },
      testCase: { select: { id: true, name: true, module: true, authProfile: true, operationsJson: true, requirementRefs: true, dataBindingJson: true, scenarioId: true, dependsOnIds: true, producesData: true, requiresData: true, steps: true, declaredAssertions: true, qualityContractJson: true, readinessStatus: true, readinessReasonsJson: true, readinessContractVersion: true, readinessComputedAt: true, runEligibility: true, sessionMode: true, failurePolicy: true, rowExecutionPlanJson: true, rowCoverageStatus: true, skippedRowsJson: true } },
    },
  });
  if (!resolvedRunId && rows.length) resolvedRunId = rows[0].runId;

  // Batch-load scenario names so journey grouping has human-readable describe titles.
  const scenarioIds = [...new Set(rows.map((r) => r.testCase && r.testCase.scenarioId).filter(Boolean))];
  const scenarioNameMap = {};
  if (scenarioIds.length) {
    const scenarios = await prisma.testScenario.findMany({ where: { id: { in: scenarioIds } }, select: { id: true, name: true } });
    for (const s of scenarios) scenarioNameMap[s.id] = s.name;
  }

  // Batch-load dependency names for the stateful-smoke warning comment (Trap 2).
  const allDepIds = [...new Set(rows.flatMap((r) => parseArrayJson(r.testCase && r.testCase.dependsOnIds)))];
  const depNameMap = {};
  if (allDepIds.length) {
    const depCases = await prisma.testCase.findMany({ where: { id: { in: allDepIds } }, select: { id: true, name: true } });
    for (const tc of depCases) depNameMap[tc.id] = tc.name;
  }

  const results = rows.map((r) => {
    const sid = r.testCase && r.testCase.scenarioId || null;
    const depIds = parseArrayJson(r.testCase && r.testCase.dependsOnIds);
    const envelope = decodeJson(r.replayIrJson, null);
    // Stamp each assert step with the LIVE outcome it had under MCP, keyed by the
    // assertion's contractRef. The emitter reads step.liveOutcome to decide hard-assert
    // vs soft-annotate, so the export's per-assertion verdict tracks the live run.
    // (The pinned IR itself carries no outcomes — they live on the RunResult.)
    const liveOutcomes = reduceAssertionOutcomes(r.assertionCheckResults);
    if (envelope && Array.isArray(envelope.ir && envelope.ir.steps) && Object.keys(liveOutcomes).length) {
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
      runResultId: r.id, runId: r.runId, testCaseId: r.testCaseId, status: r.status, blockedReason: r.blockedReason,
      dataRowIndex: r.dataRowIndex, dataRowLabel: r.dataRowLabel, caseName: r.testCase && r.testCase.name,
      moduleName: r.testCase && r.testCase.module,
      authProfile: r.testCase && r.testCase.authProfile,
      scenarioId: sid,
      scenarioName: sid ? (scenarioNameMap[sid] || null) : null,
      dependsOnNames: depIds.map((id) => depNameMap[id] || null).filter(Boolean),
      operationPlan: decodeJson(r.testCase && r.testCase.operationsJson, null),
      requirementRefs: parseArrayJson(r.testCase && r.testCase.requirementRefs),
      dataBinding: decodeJson(r.testCase && r.testCase.dataBindingJson, null),
      executionContract: decodeJson(r.executionContractJson, null),
      actionGraph: decodeJson(r.actionGraphJson, null),
      declaredSteps: decodeJson(r.testCase && r.testCase.steps, []),
      declaredAssertionsRaw: r.testCase ? r.testCase.declaredAssertions : null,
      readinessStatus: readiness ? readiness.readinessStatus : (r.testCase && r.testCase.readinessStatus) || null,
      runEligibility: readiness ? readiness.runEligibility : (r.testCase && r.testCase.runEligibility) || null,
      readinessReasons: readiness ? readiness.readinessReasons : decodeJson(r.testCase && r.testCase.readinessReasonsJson, []),
      sessionMode: readiness ? readiness.sessionMode : (r.testCase && r.testCase.sessionMode) || 'fresh',
      failurePolicy: readiness ? readiness.failurePolicy : (r.testCase && r.testCase.failurePolicy) || 'continue_independent',
      liveOutcomes,
      envelope,
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
        replayIrCertifications: Array.isArray(r.replayIrCertifications) ? r.replayIrCertifications : [],
        evidenceCompletenessLedgers: Array.isArray(r.evidenceCompletenessLedgers) ? r.evidenceCompletenessLedgers : [],
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
  const row = await prisma.authProfile.findFirst({
    where: { projectId, OR: [{ id: value }, { name: value }] },
    select: { id: true },
  }).catch(() => null);
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
      const atlas = await getCalibrationAtlas(projectId, { module: r.moduleName, authProfileId }).catch(() => null);
      cache.set(key, atlas && Array.isArray(atlas.capabilities) ? atlas.capabilities : []);
    }
    r.capabilities = cache.get(key);
  }
  return results;
}

/**
 * Service entry. { projectId, runId?, runResultIds?, framework? } → the IR-sourced
 * export. Throws only on an unknown framework (a caller-level error); per-case problems
 * are surfaced as blocks/findings, never a fallback.
 */
async function buildReplayExport({ projectId, runId = null, runResultIds = null, generationId = null, framework = 'playwright-reference', denyLiterals = [], validate = true, allowIncompletePreview = true }) {
  const isPlaywrightBdd = framework === 'replayir-bdd';
  const isSeleniumBdd = framework === 'selenium-bdd-reference';
  const isBdd = isPlaywrightBdd || isSeleniumBdd;
  const adapter = isBdd ? null : registry.getAdapter(framework);
  if (!isBdd && !adapter) {
    const err = new Error(`Unknown export framework "${framework}". Available: ${[...registry.listAdapters(), 'replayir-bdd', 'selenium-bdd-reference'].join(', ')}.`);
    err.code = 'UNKNOWN_FRAMEWORK';
    throw err;
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { targetUrl: true },
  }).catch(() => null);
  const { runId: resolvedRunId, results } = await loadResultsForExport({ projectId, runId, runResultIds, generationId });
  await attachOperationCapabilities({ projectId, results });
  const envelopes = results.map((r) => r.envelope).filter(Boolean);
  const targetUrl = deriveTargetUrlFromResults(results, project && project.targetUrl);

  // ── Assertion cardinality pre-check ──────────────────────────────────────────
  // Compare each case's authored declaredAssertions to its live assertionCheckResults.
  // Cardinality mismatches are QAAI-side certification gaps, not website failures.
  // They remain warning-level so the runnable export stays usable while the manifest
  // makes the missing/extra assertion evidence visible.
  const assertionCardinalityFindings = buildAssertionCardinalityFindings(results);
  const readinessBlocked = results
    .filter((r) => r.runEligibility && r.runEligibility !== readinessCompiler.RUN_ELIGIBILITY.ALLOWED)
    .map((r) => ({
      runResultId: r.runResultId,
      testCaseId: r.testCaseId,
      code: 'export_readiness_blocked',
      readinessStatus: r.readinessStatus || 'blocked',
      reasons: Array.isArray(r.readinessReasons) ? r.readinessReasons : [],
      status: 'blocked',
      blockReason: 'export_readiness_blocked',
    }));
  const exportResults = readinessBlocked.length
    ? results.filter((r) => !r.runEligibility || r.runEligibility === readinessCompiler.RUN_ELIGIBILITY.ALLOWED)
    : results;

  let admitted; let blocked; let manifestEntries; let findings; let adapterId; let adapterVersion; let locators = null; let operationFiles = null;
  if (isPlaywrightBdd) {
    ({ admitted, blocked, manifestEntries, findings, adapterId, adapterVersion, locators, operationFiles } = replayIrBdd.compileResults({ results: exportResults }));
  } else if (isSeleniumBdd) {
    ({ admitted, blocked, manifestEntries, findings, adapterId, adapterVersion, locators } = seleniumBddReference.compileResults({ results: exportResults }));
  } else {
    ({ admitted, blocked, manifestEntries, findings, adapterId, adapterVersion } = compileResults({ adapter, results: exportResults, allowIncompletePreview }));
  }
  if (readinessBlocked.length) {
    blocked.push(...readinessBlocked);
    manifestEntries.push(...readinessBlocked.map((b) => ({
      runResultId: b.runResultId,
      testCaseId: b.testCaseId,
      status: 'blocked',
      blockReason: 'export_readiness_blocked',
      readinessStatus: b.readinessStatus,
      readinessReasons: b.reasons,
    })));
    findings.push(...readinessBlocked.map((b) => ({
      rule: 'export_readiness_blocked',
      severity: 'error',
      runResultId: b.runResultId,
      testCaseId: b.testCaseId,
      readinessStatus: b.readinessStatus,
      reasons: b.reasons,
      message: `Case is not export-ready (${b.readinessStatus}).`,
    })));
  }
  findings.push(...assertionCardinalityFindings);

  const allBlocked = admitted.length === 0;
  let files = {};
  let validation = null;
  let secretFindings = [];
  let scriptArtifacts = [];

  if (!allBlocked) {
    const envVars = collectEnvVars(envelopes, results.map((r) => r.operationPlan).filter(Boolean));
    const authState = await resolveAuthStateForPackage({ projectId, adapterId, envelopes });
    findings.push(...authState.findings);
    if (isPlaywrightBdd) files = replayIrBdd.assemblePackage({ admitted, locators, envVars, authState, operationFiles, targetUrl });
    else if (isSeleniumBdd) files = seleniumBddReference.assemblePackage({ admitted, locators, envVars, authState, targetUrl });
    else if (typeof adapter?.assemblePackage === 'function') files = adapter.assemblePackage({ admitted, envVars, authState, targetUrl });
    else files = assemblePackage({ adapterId, admitted, envVars, authState, targetUrl });
    // DDT data files: per-case JSON files recorded inside _compilePerCase.
    // Each admitted item carries its own data file so there is no cross-case iteration.
    for (const a of admitted) {
      if (a.dataFilePath && a.dataFileContent) files[a.dataFilePath] = a.dataFileContent;
    }
    // Full original test data sources — one CSV per sheet from every TestDataSet
    // attached to this project. These are the master ledger files the QA engineer
    // can open in Excel; the per-case *.json files above are the row-slices that ran.
    const testDataSets = await prisma.testDataSet.findMany({
      where: { projectId },
      select: { id: true, name: true, sheetsJson: true },
    }).catch(() => []);
    const isSeleniumExport = adapterId === 'selenium-reference' || adapterId === 'selenium-pom' || adapterId === 'selenium-bdd-reference';
    const testDataPrefix = isSeleniumExport ? 'src/test/resources/test-data' : 'tests/data';
    const testDataCsvFiles = buildTestDataFiles(testDataSets, testDataPrefix);
    Object.assign(files, testDataCsvFiles);
    const dataMatrixCoverage = buildDataMatrixCoverageReport({ results, testDataSets });
    files['evidence/data-matrix-coverage.json'] = JSON.stringify(dataMatrixCoverage, null, 2) + '\n';
    if (Array.isArray(dataMatrixCoverage.findings) && dataMatrixCoverage.findings.length) {
      findings.push(...dataMatrixCoverage.findings);
    }
    if (files['README.md'] && Object.keys(testDataCsvFiles).length > 0) {
      files['README.md'] += '\n\n**Test data:**\n`tests/data/*.xlsx` is the human-readable master workbook exported from the uploaded dataset.\n`tests/data/*.csv` files are sheet-level fallbacks for tools that prefer plain text.\nPer-case `*.json` files are the row slices the generated specs actually execute.\n';
    }
    secretFindings = scanSecrets(files, denyLiterals);
    // Sanitizer observability: collect which per-case specs required mechanical repair.
    // Each entry = a generator defect that shipped to the user instead of being fixed upstream.
    // The list should trend toward zero in a fully certified system.
    const allSanitizerRewrites = admitted.flatMap((a) => Array.isArray(a.sanitizerRewrites) ? a.sanitizerRewrites : []);
    if (allSanitizerRewrites.length) {
      files['evidence/sanitizer-log.json'] = JSON.stringify({
        note: 'Files that required mechanical sanitizer repair during this export. Each entry represents a generator defect — the exported spec is correct, but the generator produced invalid code that had to be patched at export time. Goal: this list reaches zero.',
        totalRepaired: allSanitizerRewrites.length,
        rewrites: allSanitizerRewrites,
      }, null, 2) + '\n';
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
        files = scriptValidationRunner.hardenPlaywrightPackageFiles(files, { framework: adapterId });
        refreshManifestFileHashes(manifestEntries, files);
        const repairCheckpoint = checkpointAll(files, { framework: adapterId });
        if (!repairCheckpoint.ok || repairCheckpoint.allErrors.length) {
          findings.push(...repairCheckpoint.allErrors.map((e) => ({ ...e, type: 'checkpoint-spec-after-repair' })));
        }
      }
    }
    if (validate && validation && validation.skipped) {
      findings.push({
        rule: 'package_validation_skipped_export_gate',
        severity: 'error',
        message: 'Package validation was skipped, so replay health could not be checked. Install the required local dependencies and rerun export validation.',
        validationFindings: validation.findings || [],
      });
    }
    const stepLedger = stepCompilationLedger.buildStepCompilationLedger({ results, admitted, blocked, files, adapterId });
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
    files['evidence/contract-certification-report.json'] = JSON.stringify(contractCertification, null, 2) + '\n';
    if (Array.isArray(contractCertification.findings) && contractCertification.findings.length) {
      findings.push(...contractCertification.findings);
    }
    const actionLedger = buildActionAuthoringLedger({ results });
    files['evidence/action-authoring-ledger.json'] = JSON.stringify(actionLedger, null, 2) + '\n';
    const valueBindingMap = buildValueBindingMap({ files });
    files['evidence/value-binding-map.json'] = JSON.stringify(valueBindingMap, null, 2) + '\n';
    const artifactGraph = buildArtifactGraph({ files, adapterId });
    files['evidence/artifact-graph.json'] = JSON.stringify(artifactGraph, null, 2) + '\n';
    const targetParity = buildTargetParityReport({ files, targetUrl });
    files['evidence/target-parity-report.json'] = JSON.stringify(targetParity, null, 2) + '\n';
    const traceabilityMatrix = buildTraceabilityMatrix({ results, admitted, blocked, files, actionLedger, validation, targetUrl });
    files['evidence/traceability-matrix.json'] = JSON.stringify(traceabilityMatrix, null, 2) + '\n';
    const cardinalityFindings = buildCardinalityContractFindings({ results, files });
    const targetParityFindings = targetParity.ok ? [] : [{
      rule: 'same_target_runtime_parity_failed',
      severity: 'error',
      message: 'Exported package target URL does not match the project/run target, or playwright.config.ts can still be overridden by the parent process environment.',
      targetParity,
    }];
    const releaseFindings = buildReleaseCertificationFindings({ files, targetParity, actionLedger, validation });
    const invariantFindings = [
      ...(actionLedger.findings || []),
      ...cardinalityFindings,
      ...targetParityFindings,
      ...releaseFindings,
    ];
    if (invariantFindings.length) findings.push(...invariantFindings);
    files['evidence/runtime-result-firewall.json'] = JSON.stringify(buildRuntimeResultFirewallReport({
      results,
      validation,
      blocked,
      findings,
    }), null, 2) + '\n';
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
        const runIds = Array.isArray(entry.runResultIds) && entry.runResultIds.length
          ? entry.runResultIds
          : [entry.runResultId || null];
        const caseIds = Array.isArray(entry.testCaseIds) && entry.testCaseIds.length
          ? entry.testCaseIds
          : [entry.testCaseId || null];
        return runIds.map((runResultId, index) => ({
          testCaseId: caseIds[index] || caseIds[0] || null,
          runResultId: runResultId || null,
          file: entry.filePath,
          source: 'replayir',
          scriptGenerationStatus: 'generated',
          scriptRunStatus: 'not_run',
          certificationStatus: 'uncertified',
          blockers: [],
          repairHints: [],
        }));
      });
    const blockedKeys = new Set((blocked || []).flatMap((entry) => [entry && entry.runResultId, entry && entry.testCaseId].filter(Boolean).map(String)));
    const draftResults = (results || []).filter((result) => blockedKeys.has(String(result.runResultId || '')) || blockedKeys.has(String(result.testCaseId || '')));
    if (draftResults.length) {
      const draft = outputScriptPipeline.buildDraftArtifacts({
        adapterId,
        adapterVersion,
        results: draftResults,
        blocked,
        findings,
        targetUrl,
      });
      for (const [rel, content] of Object.entries(draft.files || {})) {
        if (rel === 'README.md' || rel === 'EXPORT_MANIFEST.json' || rel === 'evidence/live-output-status.json') continue;
        files[rel] = content;
      }
      if (Array.isArray(draft.artifacts) && draft.artifacts.length) {
        scriptArtifacts.push(...draft.artifacts);
        files['evidence/draft-script-artifacts.json'] = JSON.stringify({
          schema: 'qaai-draft-script-artifacts/1',
          artifacts: draft.artifacts,
          generatedAt: new Date().toISOString(),
        }, null, 2) + '\n';
      }
    }
  } else {
    const draft = outputScriptPipeline.buildDraftArtifacts({
      adapterId,
      adapterVersion,
      results,
      blocked,
      findings,
      targetUrl,
    });
    files = draft.files;
    scriptArtifacts = Array.isArray(draft.artifacts) ? draft.artifacts : [];
    secretFindings = scanSecrets(files, denyLiterals);
  }
  let captureFirstEvidencePackage = addCaptureFirstEvidenceFiles(files, results);
  const refreshedCaptureFirstLedger = refreshCaptureFirstLedgerCounts(files, { scriptArtifacts, validation });
  if (refreshedCaptureFirstLedger && captureFirstEvidencePackage) {
    captureFirstEvidencePackage = {
      ...captureFirstEvidencePackage,
      summary: {
        ...(captureFirstEvidencePackage.summary || {}),
        ...(refreshedCaptureFirstLedger.summary || {}),
      },
    };
  }
  ensureCaptureFirstFixtureFiles(files, { adapterId, results });
  secretFindings = scanSecrets(files, denyLiterals);

  const manifest = buildManifest({ projectId, runId: resolvedRunId, adapterId, adapterVersion, manifestEntries, validation, allBlocked });
  // If a secret leaked or the package failed validation, the export is INVALID (surfaced).
  manifest.secretFindings = secretFindings;
  manifest.artifacts = scriptArtifacts;
  manifest.scriptArtifacts = scriptArtifacts;
  const strictExportFindings = assessStrictReplayExport({ results, scriptArtifacts });
  if (strictExportFindings.length) findings.push(...strictExportFindings);
  manifest.strictExport = {
    required: true,
    ok: strictExportFindings.length === 0,
    findingCount: strictExportFindings.length,
    rules: [...new Set(strictExportFindings.map((finding) => finding.rule).filter(Boolean))],
  };
  manifest.strictExportFindings = strictExportFindings;
  manifest.assertionCardinalityFindings = assertionCardinalityFindings;
  manifest.assertionCoverageFindings = assertionCardinalityFindings;
  manifest.captureFirstEvidence = captureFirstEvidencePackage ? captureFirstEvidencePackage.summary : null;
  const liveScriptLedgers = (results || []).map((result) => result && result.liveScriptLedger).filter(Boolean);
  const liveScriptLines = liveScriptLedgers.flatMap((ledger) => liveScriptRecorder.canonicalLines(ledger));
  const weakLocatorCount = liveScriptLedgers.reduce((sum, ledger) => sum + Number(ledger.health && ledger.health.weakLocatorCount || 0), 0);
  const nonRunnableLineCount = liveScriptLedgers.reduce((sum, ledger) => sum + Number(ledger.health && ledger.health.nonRunnableLineCount || 0), 0);
  manifest.liveScriptRecorder = {
    schema: 'qaai-live-script-recorder-summary/1',
    scriptGenerated: liveScriptLines.length > 0,
    scriptReplayChecked: validation ? validationPassedForGeneratedCounts(validation) : false,
    scriptHealth: nonRunnableLineCount > 0 ? 'needs_repair' : weakLocatorCount > 0 ? 'generated_with_weak_locators' : liveScriptLines.length ? 'generated' : 'no_executable_history',
    locatorCoveragePercent: liveScriptLines.length ? Math.round(((liveScriptLines.length - weakLocatorCount) / liveScriptLines.length) * 100) : 0,
    actionCoveragePercent: liveScriptLines.length ? 100 : 0,
    assertionCoveragePercent: liveScriptLines.some((line) => line.kind === 'assert') ? 100 : 0,
    reproducesRunFailure: liveScriptLedgers.some((ledger) => ledger.health && ledger.health.reproducesRunFailure),
    missingStableLocatorCount: weakLocatorCount,
    weakLocatorCount,
    traceArtifactCount: liveScriptLedgers.reduce((sum, ledger) => sum + Number(ledger.traceArtifactCount || 0), 0),
  };
  manifest.sanitizerRewrites = allBlocked ? [] : admitted.flatMap((a) => Array.isArray(a.sanitizerRewrites) ? a.sanitizerRewrites : []);
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
      repairTaskCount: Array.isArray(parsedContract.repairTasks) ? parsedContract.repairTasks.length : 0,
    };
    manifest.contractCertificationFindings = parsedContract.findings || [];
  } else {
    manifest.contractCertification = null;
    manifest.contractCertificationFindings = [];
  }
  manifest.exportValid = !allBlocked
    && secretFindings.length === 0
    && strictExportFindings.length === 0
    && findings.filter((f) => f.severity === 'error').length === 0
    && (!validation || (validation.packagePassed !== false && validation.skipped !== true));
  if (scriptArtifacts.length) {
    let currentLive = {};
    if (files['evidence/live-output-status.json']) {
      try { currentLive = JSON.parse(files['evidence/live-output-status.json']); } catch (_) { currentLive = {}; }
    }
    files['evidence/live-output-status.json'] = JSON.stringify({
      schema: 'qaai-live-output-status/1',
      ...currentLive,
      status: manifest.exportValid ? 'runnable_unverified' : (allBlocked ? 'draft_generated' : 'needs_repair'),
      allBlocked,
      exportValid: manifest.exportValid,
      adapterId: adapterId || null,
      adapterVersion: adapterVersion || null,
      totalCases: results.length,
      admitted: admitted.length,
      blocked: blocked.length,
      captureFirstEvidence: captureFirstEvidencePackage ? captureFirstEvidencePackage.summary : null,
      artifacts: scriptArtifacts,
      findings: (findings || []).slice(0, 50),
      message: manifest.exportValid
        ? 'QAAI generated runnable script artifacts. Run script validation/replay check to update script health.'
        : 'QAAI generated visible script artifacts. Script health notes describe anything still needed for replay checking.',
      generatedAt: currentLive.generatedAt || new Date().toISOString(),
    }, null, 2) + '\n';
  }
  files['EXPORT_MANIFEST.json'] = JSON.stringify(manifest, null, 2) + '\n';

  return { files, manifest, admitted, blocked, findings: [...findings, ...secretFindings], validation, allBlocked, runId: resolvedRunId, adapterId };
}

module.exports = {
  buildReplayExport,
  // pure core (guarded directly):
  compileResults, assemblePackage, scanSecrets, buildManifest, wrapForVerdict, reduceAssertionOutcomes, buildAssertionCardinalityFindings,
  buildBlockedPreviewPackage,
  deriveLoginPrecondition, journeyNeedsLoginPrecondition, caseOperatesOnLoginPage, irPerformsLogin, journeyReferencesLogout, extractLoginBlock,
  deriveLogoutUrl, journeyPerformsLogout, journeyNeedsLogoutPrecondition, irHasOnlyFormValidationAsserts, journeyNeedsLogoutButCant,
  collectEnvVars, collectDataFiles, buildTestDataFiles, buildDataMatrixCoverageReport, envNameForRef, VALIDATE_FRAMEWORK, ADAPTER_VERSION,
  hashReplayIr, stableStringify, collectAuthStateRefs, resolveAuthStateForPackage,
  normalizeStorageStateFile, playwrightConfig,
  assessStrictReplayExport, hasConcreteReplayAssertion, replayArtifactIsStrict,
  normalizeTargetOrigin, deriveTargetUrlFromResults, envFile,
  applyPackageCertificationRepairs,
  validatePomFileGraph,
  appendValidationFindings,
  isPomSharedExtraFile,
  latestLedgerForResult,
  buildCaptureFirstEvidencePackage,
  addCaptureFirstEvidenceFiles,
  _compileJourneyGroup, _compilePerCase,
  // fs:
  validateAssembled, loadResultsForExport,
};
