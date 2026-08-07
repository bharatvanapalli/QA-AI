'use strict';
const { sanitizeJsTs } = require('../server/services/codegen/_sanitize');

const cases = [
  {
    label: 'Suite 1 — bare document expression',
    input: "const _evalResult = String(await page.evaluate(document.cookie.length > 0).catch((e) => `EVALUATE_ERROR:${e.message}`));",
    expectChange: true,
    expectContains: 'page.evaluate(() =>',
  },
  {
    label: 'Suite 8 — bare !! expression',
    input: "const _evalResult = String(await page.evaluate(!!document.querySelector('button[type=\"submit\"][disabled]')));",
    expectChange: true,
    expectContains: 'page.evaluate(() =>',
  },
  {
    label: 'Suite 6 — IIFE',
    input: "const _evalResult = String(await page.evaluate((function(){ var el = document.querySelector('button'); return el ? el.disabled : false; })()).catch((e) => 'err'));",
    expectChange: true,
    expectContains: 'page.evaluate((function',
  },
  {
    label: 'CSS selector with comma (root regression case)',
    input: "const _evalResult = String(await page.evaluate(!!document.querySelector('input[name=\"password\"] ~ span.error-message, span.error-text')).catch((e) => `EVALUATE_ERROR:${e.message}`));",
    expectChange: true,
    expectContains: 'page.evaluate(() =>',
  },
  {
    label: 'Compound && expression',
    input: "const _evalResult = String(await page.evaluate(!document.cookie.includes('orangehrm') && !document.cookie.includes('PHPSESSID')));",
    expectChange: true,
    expectContains: 'page.evaluate(() =>',
  },
  {
    label: 'Optional chain + comparison',
    input: "const _evalResult = String(await page.evaluate(document.querySelector('input[name=\"password\"]')?.type === 'password'));",
    expectChange: true,
    expectContains: 'page.evaluate(() =>',
  },
  {
    label: 'Negated optional chain with regex',
    input: "const _evalResult = String(await page.evaluate(!document.body?.textContent?.match(/Exception|StackTrace/i)));",
    expectChange: true,
    expectContains: 'page.evaluate(() =>',
  },
  {
    label: 'Negated parenthesized group — !(document...) (Rule 8 anchor-gap fix)',
    input: "const _evalResult = String(await page.evaluate(!(document.querySelector('[class*=\"oxd-main-menu\"], nav')?.querySelector('a[href*=\"/admin/\"]') != null)).catch((e) => `EVALUATE_ERROR:${e.message}`));",
    expectChange: true,
    expectContains: 'page.evaluate(() =>',
  },
  {
    label: 'Leading-paren group — (document...) without bang',
    input: "const _evalResult = String(await page.evaluate((document.querySelector('a, b') !== null)));",
    expectChange: true,
    expectContains: 'page.evaluate(() =>',
  },
  {
    label: 'Leave alone — already arrow function',
    input: "const result = await page.evaluate(() => document.cookie);",
    expectChange: false,
  },
  {
    label: 'Rule 9 — readData without loop',
    input: "await el1.fill(readData(row, 'username'));",
    expectChange: true,
    expectContains: 'QAAI_DDT_NO_ROW',
  },
  {
    label: 'Rule 9 — readData WITH loop (should NOT change)',
    input: "for (const row of dataRows) {\n  test('x', async ({ page }) => {\n    await el1.fill(readData(row, 'username'));\n  });\n}",
    expectChange: false,
  },
];

let passed = 0;
let failed = 0;
cases.forEach(({ label, input, expectChange, expectContains }) => {
  const out = sanitizeJsTs(input);
  const changed = out !== input;
  let ok = true;
  const msgs = [];
  if (changed !== expectChange) {
    ok = false;
    msgs.push(`expected changed=${expectChange}, got changed=${changed}`);
  }
  if (expectContains && !out.includes(expectContains)) {
    ok = false;
    msgs.push(`expected output to contain: ${expectContains}`);
  }
  if (ok) {
    console.log(`PASS: ${label}`);
    if (changed) console.log(`  → ${out.slice(0, 120)}`);
    passed++;
  } else {
    console.log(`FAIL: ${label}`);
    msgs.forEach((m) => console.log(`  ✗ ${m}`));
    console.log(`  Input:  ${input.slice(0, 100)}`);
    console.log(`  Output: ${out.slice(0, 120)}`);
    failed++;
  }
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
