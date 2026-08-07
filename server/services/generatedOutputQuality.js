'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_MAX_FILES = 200;
const ABSOLUTE_MAX_FILES = 2000;
const QUALITY_EXTENSION_RE = /\.(?:cjs|js|json|mjs|ts|ya?ml)$/i;
const ESLINT_EXTENSION_RE = /\.(?:cjs|js|mjs)$/i;

function normalizeMaxFiles(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_MAX_FILES;
  return Math.min(ABSOLUTE_MAX_FILES, Math.max(1, Math.floor(numeric)));
}

function normalizeFileMap(files = {}, maxFiles = DEFAULT_MAX_FILES) {
  const limit = normalizeMaxFiles(maxFiles);
  const entries = Object.entries(files || {})
    .filter(([rel, source]) => QUALITY_EXTENSION_RE.test(String(rel)) && typeof source === 'string')
    .filter(
      ([rel]) =>
        !/(?:^|\/)(?:evidence|node_modules|playwright-report|test-results)(?:\/|$)/i.test(
          String(rel).replace(/\\/g, '/'),
        ),
    )
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length > limit) {
    throw new Error(`Generated-output verification exceeded the ${limit}-file safety limit.`);
  }
  return entries;
}

async function loadTooling() {
  const [eslintModule, prettierModule, prettierConfigModule] = await Promise.all([
    import('eslint'),
    import('prettier'),
    import(pathToFileURL(path.join(REPO_ROOT, 'prettier.generated.config.mjs')).href),
  ]);
  return {
    ESLint: eslintModule.ESLint,
    prettier: prettierModule.default || prettierModule,
    prettierOptions: prettierConfigModule.default || prettierConfigModule,
  };
}

async function verifyGeneratedFileMap(
  files = {},
  { lint = true, format = true, maxFiles = DEFAULT_MAX_FILES } = {},
) {
  const entries = normalizeFileMap(files, maxFiles);
  if (!entries.length) {
    return {
      ok: true,
      files: [],
      lintErrors: 0,
      lintWarnings: 0,
      lintOutput: '',
      unformatted: [],
      issues: [],
    };
  }
  const { ESLint, prettier, prettierOptions } = await loadTooling();
  const results = [];
  const unformatted = [];
  const parserIssues = [];
  if (lint) {
    const eslint = new ESLint({
      cwd: REPO_ROOT,
      overrideConfigFile: path.join(REPO_ROOT, 'eslint.generated.config.js'),
    });
    for (const [rel, source] of entries.filter(([rel]) => ESLINT_EXTENSION_RE.test(rel))) {
      const virtualPath = path.join(REPO_ROOT, '.qaai-generated-output-verification', rel);
      const [result] = await eslint.lintText(source, {
        filePath: virtualPath,
        warnIgnored: false,
      });
      results.push({ ...result, filePath: rel });
    }
  }
  if (format) {
    for (const [rel, source] of entries) {
      const virtualPath = path.join(REPO_ROOT, '.qaai-generated-output-verification', rel);
      try {
        if (
          !(await prettier.check(source, {
            ...prettierOptions,
            filepath: virtualPath,
          }))
        )
          unformatted.push(rel);
      } catch (error) {
        parserIssues.push({
          file: rel,
          line: Number(error?.loc?.start?.line || error?.loc?.line || 1),
          column: Number(error?.loc?.start?.column || error?.loc?.column || 1),
          severity: 'error',
          rule: 'prettier-parse',
          message: String(error?.message || error),
        });
      }
    }
  }
  const lintErrors = results.reduce((sum, result) => sum + Number(result.errorCount || 0), 0);
  const lintWarnings = results.reduce((sum, result) => sum + Number(result.warningCount || 0), 0);
  const lintOutput =
    lint && results.length
      ? await (
          await new ESLint({
            cwd: REPO_ROOT,
            overrideConfigFile: path.join(REPO_ROOT, 'eslint.generated.config.js'),
          }).loadFormatter('stylish')
        ).format(results)
      : '';
  const issues = results.flatMap((result) =>
    (result.messages || []).map((message) => ({
      file: result.filePath,
      line: message.line || 1,
      column: message.column || 1,
      severity: message.severity === 2 ? 'error' : 'warning',
      rule: message.ruleId || 'eslint',
      message: message.message,
    })),
  );
  issues.push(...parserIssues);
  for (const file of unformatted)
    issues.push({
      file,
      line: 1,
      column: 1,
      severity: 'error',
      rule: 'prettier',
      message: 'Generated file is not Prettier-formatted.',
    });
  return {
    ok:
      lintErrors === 0 &&
      unformatted.length === 0 &&
      !issues.some((issue) => issue.severity === 'error'),
    files: entries.map(([rel]) => rel),
    lintErrors,
    lintWarnings,
    lintOutput,
    unformatted,
    issues,
  };
}

async function formatGeneratedFileMap(files = {}, { maxFiles = DEFAULT_MAX_FILES } = {}) {
  const entries = normalizeFileMap(files, maxFiles);
  if (!entries.length) return { ...(files || {}) };
  const { prettier, prettierOptions } = await loadTooling();
  const formatted = { ...(files || {}) };
  for (const [rel, source] of entries) {
    const virtualPath = path.join(REPO_ROOT, '.qaai-generated-output-verification', rel);
    try {
      formatted[rel] = await prettier.format(source, {
        ...prettierOptions,
        filepath: virtualPath,
      });
    } catch (_) {
      // Preserve malformed bytes so verification can report the exact file and parser error.
      formatted[rel] = source;
    }
  }
  return formatted;
}

module.exports = {
  DEFAULT_MAX_FILES,
  normalizeMaxFiles,
  normalizeFileMap,
  formatGeneratedFileMap,
  verifyGeneratedFileMap,
};
