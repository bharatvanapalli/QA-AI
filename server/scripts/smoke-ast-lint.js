'use strict';

/**
 * E6 smoke test — feeds a deliberately-bad and a canonical-good Playwright
 * spec through the merged regex+AST lint engine. Validates V2 acceptance:
 *   - deliberately-bad spec hits 4+ AST findings
 *   - canonical-good spec produces 0 AST findings
 *   - lint runs in < 500 ms
 *
 * Run with:  node server/scripts/smoke-ast-lint.js
 */

const { lint } = require('../services/lintGates');

const BAD_SPEC = `
import { test, expect } from '@playwright/test';

test('login flow', async ({ page }) => {
  // Rule 1: unawaited page.click — assertion below races the click
  page.click('button[type="submit"]');
  await expect(page.locator('h1')).toHaveText('Welcome');
});

test('checkout — no assertion', async ({ page }) => {
  // Rule 2: per-test expect missing — this test never asserts anything
  await page.goto('/cart');
  await page.click('button.checkout');
});

test('brittle locators', async ({ page }) => {
  // Rule 4: dynamic class — .btn-3a4f9b looks build-generated
  await page.locator('.btn-3a4f9b').click();
  await expect(page.locator('.css-1q2w3e4')).toBeVisible();

  // Rule 5: locator created but never acted on
  page.getByRole('navigation');
});

test('checkout wizard — only terminal assert', async ({ page }) => {
  // Rule 6: low assertion density — 5 interactions, 1 expect()
  await page.goto('/cart');
  await page.getByLabel('Promo code').fill('SAVE10');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.getByLabel('Card number').fill('4242424242424242');
  await page.getByRole('button', { name: 'Pay' }).click();
  await expect(page.getByText('Order confirmed')).toBeVisible();
});

test.afterEach(async ({ page }) => {
  // Rule 3: afterEach without conditional failure screenshot
  console.log('done');
});
`;

const GOOD_SPEC = `
import { test, expect } from '@playwright/test';

test('login flow', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('user@example.com');
  await page.getByLabel('Password').fill(process.env.TEST_PASSWORD || 'x');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== 'passed') {
    await page.screenshot({ path: \`test-results/\${testInfo.title}-fail.png\` });
  }
});
`;

function summarise(label, code) {
  const t0 = Date.now();
  const result = lint(code);
  const elapsed = Date.now() - t0;
  const astFindings = result.findings.filter((f) => f.engine === 'ast');
  const regexFindings = result.findings.filter((f) => f.engine !== 'ast');
  console.log(`\n=== ${label} (${elapsed} ms) ===`);
  console.log(`  AST findings:   ${astFindings.length}`);
  console.log(`  regex findings: ${regexFindings.length}`);
  console.log(`  lintPassed:     ${result.lintPassed}`);
  console.log(`  astParseError:  ${result.astParseError || 'none'}`);
  if (astFindings.length) {
    console.log(`  --- AST findings ---`);
    for (const f of astFindings) {
      console.log(`    [${f.severity}] L${f.line} ${f.rule}`);
      console.log(`        ${f.message.slice(0, 110)}`);
    }
  }
  return { result, elapsed, astFindings: astFindings.length };
}

const bad = summarise('BAD spec', BAD_SPEC);
const good = summarise('GOOD spec', GOOD_SPEC);

console.log('\n=== Acceptance ===');
console.log(`  BAD has 5+ AST findings:  ${bad.astFindings >= 5 ? 'PASS' : 'FAIL'} (got ${bad.astFindings})`);
console.log(`  GOOD has 0 AST findings:  ${good.astFindings === 0 ? 'PASS' : 'FAIL'} (got ${good.astFindings})`);
const badHasDensity = bad.result.findings.some((f) => f.rule === 'ast-low-assertion-density');
console.log(`  BAD triggers density rule: ${badHasDensity ? 'PASS' : 'FAIL'}`);
console.log(`  BAD lint under 500 ms:    ${bad.elapsed < 500 ? 'PASS' : 'FAIL'} (${bad.elapsed} ms)`);
console.log(`  GOOD lint under 500 ms:   ${good.elapsed < 500 ? 'PASS' : 'FAIL'} (${good.elapsed} ms)`);

if (bad.astFindings < 5 || good.astFindings !== 0 || !badHasDensity
    || bad.elapsed >= 500 || good.elapsed >= 500) {
  process.exit(1);
}
