'use strict';
/**
 * verify_runnable_specs.cjs — guard for the 100%-runnable spec guarantee across all frameworks.
 *
 * Tests enforcement gates without network/DB:
 *   1.  sanitizeJsTs is idempotent on a pre-sanitized spec
 *   2.  sanitizeJsTs converts a glob waitForURL to regex
 *   3.  lint catches leaked MCP tool name (no-leaked-mcp-tool-name → error)
 *   4.  lint catches missing @playwright/test import (requires-playwright-import → error)
 *   5.  buildManifest annotates kbMiss:true when KB has no match
 *   6.  buildManifest does NOT annotate kbMiss when KB has a matching row
 *   7.  locatorPromptBlock emits an editable kbMiss warning
 *   8.  locatorPromptBlock requires one non-positional semantic guess
 *   9.  locatorPromptBlock bans getByRole('heading'|'listitem'|'generic') for kbMiss
 *   10. pom.js SYSTEM_PROMPT contains FIRST STATEMENT INVARIANT
 *   11. playwrightJs.js SYSTEM_PROMPT contains FIRST STATEMENT INVARIANT
 *   12. pom.js test-helpers: clickFirstVisible handles single-locator form
 *   13. playwrightJs.js test-helpers: clickFirstVisible handles single-locator form
 *   14. playwrightBdd.js SYSTEM_PROMPT contains FIRST STATEMENT INVARIANT
 *   15. playwrightBdd.js validate: stubs steps when MCP tool leaks
 *   16. playwrightBdd.js validate: step binding count check present
 *   17. selenium.js SYSTEM_PROMPT contains FIRST STATEMENT INVARIANT
 *   18. selenium.js validate: catches missing @Test annotation
 *   19. selenium.js validate: catches class name mismatch
 *   20. seleniumBdd.js SYSTEM_PROMPT contains FIRST STATEMENT INVARIANT
 *   21. seleniumBdd.js validate: step binding count check present
 *   22. seleniumBdd.js validate: feature file structure check present
 *
 * Exit 0 = all checks passed. Exit 1 = at least one failure.
 */

const path = require('path');
const root = path.join(__dirname, '..');

let failures = 0;
function check(label, pass, detail) {
  if (pass) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// ── 1+2: sanitize ────────────────────────────────────────────────────────────
const { sanitizeJsTs } = require(path.join(root, 'server/services/codegen/_sanitize'));

// Already-sanitized spec (safeGoto in place, regex waitForURL) — sanitizeJsTs must be idempotent on it.
const validSpec = `import { test, expect } from '@playwright/test';
test('login', async ({ page }) => {
  await safeGoto(page, '/login');
  await page.waitForURL(/dashboard/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});`;
check('sanitizeJsTs is idempotent on a pre-sanitized spec', sanitizeJsTs(validSpec) === validSpec);

const globSpec = `await page.waitForURL('**/products', { timeout: 10000 });`;
const sanitised = sanitizeJsTs(globSpec);
check(
  'sanitizeJsTs converts glob waitForURL to regex',
  sanitised.includes('waitForURL(/') && !sanitised.includes("waitForURL('"),
  `got: ${sanitised.trim()}`,
);

// ── 3+4: lint gates ──────────────────────────────────────────────────────────
const { lint } = require(path.join(root, 'server/services/lintGates'));

const mcpLeakSpec = `import { test, expect } from '@playwright/test';
test('t', async ({ page }) => {
  await page.goto('/');
  await browser_click({ selector: '#btn' });
  await expect(page.getByRole('button')).toBeVisible();
  await page.screenshot({ path: 'r.png' });
});`;
const mcpResult = lint(mcpLeakSpec, { framework: 'playwright-pom', caseStatus: 'pass' });
check(
  'lint catches leaked MCP tool name (error severity)',
  mcpResult.findings.some((f) => f.rule === 'no-leaked-mcp-tool-name' && f.severity === 'error'),
  `errorCount=${mcpResult.errorCount}`,
);

const noImportSpec = `test('t', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button')).toBeVisible();
  await page.screenshot({ path: 'r.png' });
});`;
const importResult = lint(noImportSpec, { framework: 'playwright-pom', caseStatus: 'pass' });
check(
  'lint catches missing @playwright/test import (error severity)',
  importResult.findings.some((f) => f.rule === 'requires-playwright-import' && f.severity === 'error'),
  `errorCount=${importResult.errorCount}`,
);

// ── 5: buildManifest kbMiss annotation ───────────────────────────────────────
const { buildManifest } = require(path.join(root, 'server/services/codegen/_locators'));

const actions = [
  { tool: 'browser_click', args: { element: 'Submit button' }, narration: 'Click submit' },
  { tool: 'browser_fill_form', args: { element: 'Username field' }, narration: 'Fill username' },
];
// Empty KB — every action should get kbMiss:true
const { actions: enriched } = buildManifest({
  actions,
  kbRows: [],
  labelOf: (a) => a.args && a.args.element,
  lang: 'ts',
});
const allMissed = enriched.every((a) => a.kbMiss === true);
check(
  'buildManifest annotates kbMiss:true when KB has no match',
  allMissed,
  `enriched[0].kbMiss=${enriched[0] && enriched[0].kbMiss}, enriched[1].kbMiss=${enriched[1] && enriched[1].kbMiss}`,
);

// ── 6: buildManifest does NOT annotate kbMiss when KB has a matching row ─────
const kbRows = [{
  element: 'Submit button',
  role: 'button',
  accessibleName: 'Submit',
  selector: null,
  healthScore: 100,
  occurrences: 5,
  pageUrl: null,
}];
const { actions: enrichedWithHit } = buildManifest({
  actions: [actions[0]],
  kbRows,
  labelOf: (a) => a.args && a.args.element,
  lang: 'ts',
});
check(
  'buildManifest does NOT annotate kbMiss when KB has a matching row',
  enrichedWithHit[0] && enrichedWithHit[0].kbMiss == null && enrichedWithHit[0].locator != null,
  `kbMiss=${enrichedWithHit[0] && enrichedWithHit[0].kbMiss}, locator=${JSON.stringify(enrichedWithHit[0] && enrichedWithHit[0].locator)}`,
);

// ── 7-9: locatorPromptBlock kbMiss semantic-guess guidance ───────────────────
const { locatorPromptBlock } = require(path.join(root, 'server/services/codegen/_locators'));
const promptTs = locatorPromptBlock({ lang: 'ts' });
check(
  'locatorPromptBlock emits an editable kbMiss warning',
  promptTs.includes('QAAI_GUESSED_LOCATOR') && promptTs.includes('live DOM evidence was unavailable'),
  'expected the explicit editable guessed-locator warning in prompt block',
);
check(
  'locatorPromptBlock requires one non-positional semantic guess',
  promptTs.includes('exactly ONE') && promptTs.includes('.first()') && promptTs.includes(':nth-child()'),
  'expected one-locator guidance plus positional-locator prohibitions',
);
check(
  'locatorPromptBlock bans guessed structural roles for kbMiss',
  promptTs.includes("'heading'") && promptTs.includes("'listitem'"),
  'expected structural role ban in prompt block',
);

// ── 10: pom.js SYSTEM_PROMPT contains FIRST STATEMENT INVARIANT ──────────────
const pomSrc = require('fs').readFileSync(path.join(root, 'server/services/codegen/pom.js'), 'utf8');
check(
  'pom.js SYSTEM_PROMPT contains FIRST STATEMENT INVARIANT',
  pomSrc.includes('FIRST STATEMENT INVARIANT'),
  'string "FIRST STATEMENT INVARIANT" not found in pom.js',
);

// ── 11: playwrightJs.js SYSTEM_PROMPT contains FIRST STATEMENT INVARIANT ─────
const jsSrc = require('fs').readFileSync(path.join(root, 'server/services/codegen/playwrightJs.js'), 'utf8');
check(
  'playwrightJs.js SYSTEM_PROMPT contains FIRST STATEMENT INVARIANT',
  jsSrc.includes('FIRST STATEMENT INVARIANT'),
  'string "FIRST STATEMENT INVARIANT" not found in playwrightJs.js',
);

// ── 12-13: clickFirstVisible handles single-locator form ─────────────────────
check(
  'pom.js test-helpers: clickFirstVisible handles single-locator form',
  pomSrc.includes('Array.isArray(selectorsArgOrOpts)'),
  'expected overloaded clickFirstVisible in pom.js test-helpers',
);
check(
  'playwrightJs.js test-helpers: clickFirstVisible handles single-locator form',
  jsSrc.includes('Array.isArray(selectorsArgOrOpts)'),
  'expected overloaded clickFirstVisible in playwrightJs.js test-helpers',
);

// ── 14-16: playwrightBdd FIRST STATEMENT INVARIANT + validation gates ────────
const bddSrc = require('fs').readFileSync(path.join(root, 'server/services/codegen/playwrightBdd.js'), 'utf8');
check(
  'playwrightBdd.js SYSTEM_PROMPT contains FIRST STATEMENT INVARIANT',
  bddSrc.includes('FIRST STATEMENT INVARIANT'),
  'string "FIRST STATEMENT INVARIANT" not found in playwrightBdd.js',
);
check(
  'playwrightBdd.js validate: stubs steps when MCP tool leaks',
  bddSrc.includes('MCP tool name') && bddSrc.includes('CODEGEN VALIDATION FAILED'),
  'expected MCP leak detection + CODEGEN VALIDATION FAILED stub in playwrightBdd.js',
);
check(
  'playwrightBdd.js validate: step binding count check present',
  bddSrc.includes('Step binding mismatch'),
  'expected step binding mismatch check in playwrightBdd.js',
);

// ── 17-19: selenium FIRST STATEMENT INVARIANT + validation gates ─────────────
const seleniumSrc = require('fs').readFileSync(path.join(root, 'server/services/codegen/selenium.js'), 'utf8');
check(
  'selenium.js SYSTEM_PROMPT contains FIRST STATEMENT INVARIANT',
  seleniumSrc.includes('FIRST STATEMENT INVARIANT'),
  'string "FIRST STATEMENT INVARIANT" not found in selenium.js',
);
check(
  'selenium.js validate: catches missing @Test annotation',
  seleniumSrc.includes('No @Test annotation'),
  'expected @Test presence check in selenium.js post-generate validation',
);
check(
  'selenium.js validate: catches class name mismatch',
  seleniumSrc.includes('Class name mismatch'),
  'expected class name mismatch check in selenium.js post-generate validation',
);

// ── 20-22: seleniumBdd FIRST STATEMENT INVARIANT + validation gates ───────────
const seleniumBddSrc = require('fs').readFileSync(path.join(root, 'server/services/codegen/seleniumBdd.js'), 'utf8');
check(
  'seleniumBdd.js SYSTEM_PROMPT contains FIRST STATEMENT INVARIANT',
  seleniumBddSrc.includes('FIRST STATEMENT INVARIANT'),
  'string "FIRST STATEMENT INVARIANT" not found in seleniumBdd.js',
);
check(
  'seleniumBdd.js validate: step binding count check present',
  seleniumBddSrc.includes('Step binding mismatch'),
  'expected step binding mismatch check in seleniumBdd.js',
);
check(
  'seleniumBdd.js validate: feature file structure check present',
  seleniumBddSrc.includes('Feature file missing') && seleniumBddSrc.includes('Feature file contains no Scenario'),
  'expected Feature:/Scenario: structure checks in seleniumBdd.js',
);

// ── Result ────────────────────────────────────────────────────────────────────
console.log('');
if (failures === 0) {
  console.log('All runnable-spec gates verified. ✓');
  process.exit(0);
} else {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
