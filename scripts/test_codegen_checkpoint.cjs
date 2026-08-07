'use strict';
/**
 * Guard for the export CHECKPOINT (sanitize → dedupe → AST-parse) and the
 * self-contained helper bundle. Run: node scripts/test_codegen_checkpoint.cjs
 *
 * Covers the "broken unrunnable script" classes we keep hitting:
 *  - Duplicate declaration X  (concat / inject / model double-import)
 *  - file does not parse       (certify must catch + flag, not silently ship)
 *  - missing utils/test-helpers (bundle must contain what the sanitizer imports)
 */
const parser = require('@babel/parser');
const { sanitizeJsTs, dedupeImportDeclarations } = require('../server/services/codegen/_sanitize');
const { certifyFile } = require('../server/services/codegen/_certify');
const { testHelpersFile } = require('../server/services/codegen/_testHelpers');

const PARSE_OPTS = {
  sourceType: 'module', errorRecovery: false, allowImportExportEverywhere: true,
  plugins: ['typescript', 'jsx', 'objectRestSpread', 'optionalChaining', 'nullishCoalescingOperator', 'topLevelAwait'],
};
function parses(code) { try { parser.parse(code, PARSE_OPTS); return true; } catch (_) { return false; } }

let passed = 0, failed = 0;
function check(label, cond, detail) {
  if (cond) { console.log(`PASS: ${label}`); passed++; }
  else { console.log(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

// ── 1. The exact reported bug: duplicate clickFirstVisible import (concat) ──
const dupConcat = [
  "import { test, expect } from '@playwright/test';",
  "import { clickFirstVisible, safeClick, safeGoto } from '../../utils/test-helpers';",
  "import { clickFirstVisible, safeClick, safeGoto } from '../../utils/test-helpers';",
  "test('x', async ({ page }) => { await clickFirstVisible(page.getByRole('button', { name: 'Save' })); });",
].join('\n');
check('duplicate ESM import THROWS before dedupe (Babel: Duplicate declaration)', !parses(dupConcat));
const dedup1 = dedupeImportDeclarations(dupConcat);
check('after dedupe: parses', parses(dedup1));
check('after dedupe: exactly one test-helpers import', (dedup1.match(/utils\/test-helpers/g) || []).length === 1, dedup1);

// ── 2. import + require collision for the same module (model + injection) ──
const mixed = [
  "const { test, expect } = require('@playwright/test');",
  "import { clickFirstVisible } from '../../utils/test-helpers';",
  "const { clickFirstVisible } = require('../../utils/test-helpers');",
  "test('x', async ({ page }) => {});",
].join('\n');
const dedupMixed = dedupeImportDeclarations(mixed);
check('import+require collision collapses to one test-helpers decl', (dedupMixed.match(/utils\/test-helpers/g) || []).length === 1, dedupMixed);
check('import+require collision: parses after dedupe', parses(dedupMixed));

// ── 3. two @playwright/test requires collapse ──
const dupReq = [
  "const { test, expect } = require('@playwright/test');",
  "const { test, expect } = require('@playwright/test');",
  "test('x', async () => {});",
].join('\n');
check('duplicate require collapses + parses', parses(dedupeImportDeclarations(dupReq)));

// ── 4. partial-overlap import merge (union of names, one statement) ──
const partial = [
  "import { a } from 'M';",
  "import { b } from 'M';",
  "console.log(a, b);",
].join('\n');
const merged = dedupeImportDeclarations(partial);
check('partial imports merge to one statement', (merged.match(/from 'M'/g) || []).length === 1, merged);
check('partial merge keeps both names', /\{\s*a,\s*b\s*\}/.test(merged), merged);

// ── 5. single import is left untouched (no over-collapsing) ──
const single = "import { test, expect } from '@playwright/test';\ntest('x', async () => {});";
check('single import unchanged', dedupeImportDeclarations(single) === single);

// ── 6. certifyFile flags a genuinely un-parseable file (does NOT ship silently) ──
const broken = "import { test } from '@playwright/test';\ntest('x', async ({ page }) => { await page.click('a' ; });"; // stray (
const certBroken = certifyFile({ relPath: 'tests/x.spec.ts', content: broken });
check('certify: broken file → parseOk=false', certBroken.parseOk === false);
check('certify: broken file → spec_parse_error finding', certBroken.findings.some((f) => f.rule === 'spec_parse_error' && f.severity === 'error'));

// ── 7. certifyFile repairs the dup-import file so it parses AND parseOk=true ──
const certDup = certifyFile({ relPath: 'tests/authentication/journey.spec.ts', content: dupConcat });
check('certify: dup-import file repaired → parseOk=true', certDup.parseOk === true, certDup.parseError || '');
check('certify: repaired content actually parses', parses(certDup.content));

// ── 8. bundled helper files parse and export the symbols the sanitizer imports ──
const ts = testHelpersFile('ts'), js = testHelpersFile('js');
check('test-helpers.ts parses', parses(ts));
check('test-helpers.js parses', parses(js));
check('test-helpers.ts exports clickFirstVisible/safeClick/safeGoto',
  /export async function clickFirstVisible/.test(ts) && /export async function safeClick/.test(ts) && /export async function safeGoto/.test(ts));
const jsExportLine = (js.match(/module\.exports\s*=\s*\{[^}]*\}/) || [''])[0];
check('test-helpers.js exports the trio via module.exports',
  ['clickFirstVisible', 'safeClick', 'safeGoto'].every((n) => new RegExp(`\\b${n}\\b`).test(jsExportLine)), jsExportLine);

// ── 9. non-JS files pass through certify untouched (no false parse errors) ──
const feature = certifyFile({ relPath: 'features/login.feature', content: 'Feature: Login\n  Scenario: ok\n    Given I am on the page\n' });
check('certify: .feature file → parseOk=true (not JS-parsed)', feature.parseOk === true && feature.findings.length === 0);

// ── 10. ReplayIR support: assertTextPresent matches accessible names + isn't <main>-scoped ──
// (faithful to how the agent verified in-run; topbar/sidebar labels are accessible
//  names outside <main>, so the old getByText-in-main check failed passing runs)
try {
  const ref = require('../server/services/codegen/adapters/playwrightReference.js');
  const maps = [];
  if (typeof ref.supportFiles === 'function') maps.push(ref.supportFiles());
  for (const v of Object.values(ref)) if (v && typeof v === 'object' && typeof v.supportFiles === 'function') maps.push(v.supportFiles());
  let files = 0, good = 0;
  for (const m of maps) for (const [f, c] of Object.entries(m || {})) {
    if (!/replayir\.(ts|js)$/.test(f)) continue;
    files++;
    const mainScoped = /assertTextPresent[\s\S]{0,400}?main, \[role="main"\][\s\S]{0,200}?getByText/.test(c);
    if (parses(c) && c.includes('aria-label*') && !mainScoped) good++;
  }
  check('replayir support: parses + accessible-name match + not <main>-scoped', files >= 1 && good === files, `${good}/${files} files good`);
} catch (e) { check('replayir support loads', false, e.message); }

// ── 11. Hybrid noise-trim: emitted ReplayIR specs carry no telemetry / internal-trace noise ──
try {
  const ref = require('../server/services/codegen/adapters/playwrightReference.js');
  const blob = [
    ref.emitStep({ action: 'navigate', url: 'https://x/login' }),
    ref.emitStep({ action: 'click', target: 'el1' }),
    ref.emitSetup({ title: 'T' }, { runResultId: 'RR', testCaseId: 'TC', testTitle: 'My Test' }),
  ].join('\n');
  const noise = ['_t0', 'perf:navigate', 'QAAI RunResult', 'QAAI TestCase', 'context narrowed to:'].filter((t) => blob.includes(t));
  const keepsHelpers = blob.includes("from '../support/replayir'") && blob.includes('await page.goto(');
  check('emitted specs are noise-trimmed but keep helpers', noise.length === 0 && keepsHelpers, noise.length ? 'leaked: ' + noise.join(',') : 'helpers missing');
} catch (e) { check('noise-trim check loads', false, e.message); }

// ── 12. Presence assertions use .first() (strict-mode safety found by live E2E) ──
// A compound/multi-match locator + toContainText/toBeVisible throws "strict mode
// violation: resolved to N elements". Presence checks must .first(); forbidden/count
// checks (toHaveCount(0)) must NOT (that would weaken them to "first doesn't match").
try {
  const ref = require('../server/services/codegen/adapters/playwrightReference.js');
  const a = ref.emitAssertion({ channel: 'TEXT', expected: 'Admin', scope: { selector: '.oxd-sidepanel, [class*="sidebar"]' }, contractRef: 'ASN-1' });
  const b = ref.emitAssertion({ channel: 'TEXT', target: 'el1', expected: 'Admin' });
  const c = ref.emitAssertion({ channel: 'PAGE', target: 'el1' });
  const f = ref.emitAssertion({ channel: 'FORBIDDEN_TEXT', expected: 'Bad', scope: { selector: '.x' } });
  check('scoped presence toContainText uses .first()', /\.first\(\)\)\.toContainText/.test(a), a);
  check('target presence toContainText uses .first()', /\.first\(\)\)\.toContainText/.test(b), b);
  check('PAGE visibility uses .first()', /\.first\(\)\)\.toBeVisible/.test(c), c);
  check('forbidden/count check stays multi-match (no .first)', !/\.first\(\)/.test(f) && /toHaveCount\(0/.test(f), f);
} catch (e) { check('emitAssertion .first() check loads', false, e.message); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
