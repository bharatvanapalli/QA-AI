'use strict';
/**
 * Export checkpoint — records diagnostics without withholding generated files.
 *
 * Two checks run on every emitted spec:
 *   1. AST parse  — acorn parse catches syntax errors that would crash `npx playwright test`
 *                   and reports them next to the retained output.
 *   2. Selector leak — POM specs must not contain raw resolveLocator() calls or bare
 *                      el1/el2 inline variable assignments. A POM spec leaking inline
 *                      locators means the page-object compiler failed to map a step and
 *                      fell back to the runtime resolver — the fallback is visible so the
 *                      user knows to review.
 *
 * PURE — no file I/O, no DB. Input: { path, content, framework }.
 * Output: { ok: true, retained: true, content, errors: [{ code, message }] }
 */

let _acorn;
function getAcorn() {
  if (!_acorn) {
    try { _acorn = require('acorn'); } catch {
      // acorn may not be present in older installs — degrade gracefully: skip AST check
      _acorn = null;
    }
  }
  return _acorn;
}

// Selector-leak patterns that indicate a POM spec fell back to inline resolution.
// Generic: keyed off code patterns, never site-specific strings.
const POM_LEAK_PATTERNS = [
  { code: 'inline-resolve-locator', re: /\bresolveLocator\s*\(/, detail: 'resolveLocator() call in POM spec — step not mapped to a page method; regenerate after re-running' },
  { code: 'inline-el-variable', re: /\bconst\s+el\d+\s*=/, detail: 'raw el1/el2 inline variable — step not mapped to a page method' },
  { code: 'force-true-fill', re: /\.fill\([^)]*,\s*\{\s*force:\s*true\s*\}/, detail: '{ force: true } on fill — masks real UI overlay defects; remove or investigate the overlay' },
  { code: 'force-true-click', re: /\.click\(\s*\{\s*force:\s*true\s*\}/, detail: '{ force: true } on click — masks real UI overlay defects; remove or investigate the overlay' },
];

// For non-POM (flat reference) specs — only check for broken syntax and obvious force:true leaks.
const FLAT_LEAK_PATTERNS = [
  { code: 'force-true-fill', re: /\.fill\([^)]*,\s*\{\s*force:\s*true\s*\}/, detail: '{ force: true } on fill — masks real UI overlay defects' },
  { code: 'force-true-click', re: /\.click\(\s*\{\s*force:\s*true\s*\}/, detail: '{ force: true } on click — masks real UI overlay defects' },
];

/**
 * @param {object} opts
 * @param {string} opts.path     - file path (used in error messages only)
 * @param {string} opts.content  - file content to check
 * @param {string} [opts.framework] - 'playwright-pom' | 'playwright-reference' | etc.
 * @param {boolean} [opts.strict] - retained for API compatibility; diagnostics never block output
 * @returns {{ ok: true, retained: true, content: string, errors: Array<{code:string,message:string,severity:'warn',originalSeverity?:'error'}> }}
 */
function checkpoint({ path, content, framework, strict = false }) {
  const errors = [];
  const filePath = path || 'unknown';
  const src = String(content || '');

  // ── 1. AST parse ────────────────────────────────────────────────────────────
  const acorn = getAcorn();
  if (acorn) {
    // Strip TypeScript syntax for parsing — acorn is JS-only.
    // Simple approach: remove type annotations that would cause parse errors.
    // This is NOT a full TypeScript parser — just enough to let acorn parse the structure.
    const jsApprox = src
      .replace(/:\s*(string|number|boolean|any|void|Page|Locator|DataRow)\b/g, '')  // param/return types
      .replace(/\btype\s+\w+\s*=[^;]+;/g, '')  // type aliases
      .replace(/<[A-Za-z][A-Za-z0-9]*>/g, '')   // generic params
      .replace(/\bimport\s+type\s+/g, 'import '); // import type → import

    try {
      acorn.parse(jsApprox, { ecmaVersion: 2022, sourceType: 'module' });
    } catch (parseErr) {
      // Re-try as CommonJS script (for playwright-reference-js output)
      try {
        acorn.parse(jsApprox, { ecmaVersion: 2022, sourceType: 'script' });
      } catch {
        errors.push({
          code: 'syntax-error',
          severity: 'warn',
          originalSeverity: 'error',
          message: `${filePath}: syntax error — ${String(parseErr && parseErr.message || parseErr).split('\n')[0]}`,
        });
      }
    }
  }

  // ── 2. Selector / quality leak scan ────────────────────────────────────────
  const isPom = String(framework || '').includes('pom');
  const patterns = isPom ? POM_LEAK_PATTERNS : FLAT_LEAK_PATTERNS;

  // Check only the test body — skip import/require lines to avoid false positives
  // on imported function NAMES (e.g. `import { resolveLocator }` has the word in it).
  const bodyLines = src.split('\n').filter((l) => {
    const t = l.trimStart();
    return !t.startsWith('import ') && !t.startsWith('const {') && !t.startsWith('//');
  }).join('\n');

  for (const pat of patterns) {
    if (pat.re.test(bodyLines)) {
      errors.push({
        code: pat.code,
        severity: 'warn',
        ...(strict ? { originalSeverity: 'error' } : {}),
        message: `${filePath}: ${pat.detail}`,
      });
    }
  }

  return {
    ok: true,
    retained: true,
    content: src,
    diagnostics: errors,
    errors,
  };
}

/**
 * Run checkpoint over a map of { path: content } and return a summary.
 * @param {Record<string,string>} files
 * @param {object} [opts]
 * @returns {{ ok: true, retained: true, files: Record<string,string>, byFile: Record<string,{ok,retained,content,errors}>, allErrors: Array }}
 */
function checkpointAll(files, opts = {}) {
  const byFile = {};
  const allErrors = [];
  for (const [path, content] of Object.entries(files || {})) {
    // Only check spec files — support/locator/page files are emitted deterministically
    if (!/\.spec\.(ts|js)$/.test(path)) continue;
    const result = checkpoint({ path, content, ...opts });
    byFile[path] = result;
    allErrors.push(...result.errors);
  }
  return {
    ok: true,
    retained: true,
    files: { ...(files || {}) },
    byFile,
    diagnostics: allErrors,
    allErrors,
  };
}

module.exports = { checkpoint, checkpointAll };
