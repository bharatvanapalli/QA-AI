'use strict';

const { normalize, renderLocator, renderHelperFile, renderPromptBlock } = require('../knownPopups');

let failures = 0;
function expect(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) console.log(`  PASS  ${label}`);
  else { console.log(`  FAIL  ${label}`); console.log(`        expected: ${JSON.stringify(expected)}`); console.log(`        actual:   ${JSON.stringify(actual)}`); failures += 1; }
}
function expectIncludes(label, actual, fragment) {
  const ok = typeof actual === 'string' && actual.includes(fragment);
  if (ok) console.log(`  PASS  ${label}`);
  else { console.log(`  FAIL  ${label}  (no '${fragment}' in output)`); failures += 1; }
}

console.log('normalize — happy path');
{
  const { ok, normalized } = normalize([
    { name: 'Cookie banner', matcher: { strategy: 'role', role: 'button', value: 'Accept all' }, scope: 'global' },
  ]);
  expect('ok', ok, true);
  expect('one record', normalized.length, 1);
  expect('strategy preserved', normalized[0].matcher.strategy, 'role');
}

console.log('normalize — drops invalid');
{
  const { issues, normalized } = normalize([
    { name: '', matcher: { strategy: 'role', role: 'button', value: 'X' } },        // missing name
    { name: 'B', matcher: { strategy: 'invalid', value: 'X' } },                    // bad strategy
    { name: 'C', matcher: { strategy: 'role', value: 'X' } },                       // role w/o role field
    { name: 'D', matcher: { strategy: 'text', value: 'OK' } },                      // valid
  ]);
  expect('three issues', issues.length, 3);
  expect('one normalized', normalized.length, 1);
  expect('valid record kept', normalized[0].name, 'D');
}

console.log('renderLocator — every strategy');
expect('role',   renderLocator({ strategy: 'role',   value: 'Accept', role: 'button' }), `page.getByRole('button', { name: 'Accept' })`);
expect('text',   renderLocator({ strategy: 'text',   value: 'Close' }),                  `page.getByText('Close')`);
expect('label',  renderLocator({ strategy: 'label',  value: 'Close dialog' }),           `page.getByLabel('Close dialog')`);
expect('testId', renderLocator({ strategy: 'testId', value: 'cookie-banner-close' }),    `page.getByTestId('cookie-banner-close')`);
expect('css',    renderLocator({ strategy: 'css',    value: '.modal-close' }),           `page.locator('.modal-close')`);

console.log('renderLocator — regex passthrough');
expect('role + regex',
  renderLocator({ strategy: 'role', value: '/accept all/i', role: 'button' }),
  `page.getByRole('button', { name: /accept all/i })`);

console.log('renderHelperFile — emits import + function');
{
  const { rel, content } = renderHelperFile([
    { name: 'Cookie banner', matcher: { strategy: 'role', value: 'Accept', role: 'button' }, scope: 'global', afterDismiss: 'wait-hidden' },
    { name: 'Newsletter',    matcher: { strategy: 'css',  value: '.modal .close' },          scope: 'global', afterDismiss: null },
  ]);
  expect('path', rel, 'utils/known-popups.ts');
  expectIncludes('import Page from @playwright/test', content, "import { Page } from '@playwright/test'");
  expectIncludes('exports dismissKnownPopups', content, 'export async function dismissKnownPopups(page: Page)');
  expectIncludes('cookie banner label',          content, '// 1. Cookie banner');
  expectIncludes('newsletter label',             content, '// 2. Newsletter');
  expectIncludes('uses isVisible guard',         content, 'isVisible({ timeout: 1500 })');
  expectIncludes('wait-hidden after dismiss',    content, "waitFor({ state: 'hidden'");
}

console.log('renderHelperFile — empty array → safe no-op file');
{
  const { content } = renderHelperFile([]);
  expectIncludes('comment for no popups', content, 'No project-level popups declared.');
}

console.log('renderPromptBlock — empty → empty string');
expect('empty input', renderPromptBlock([]), '');

console.log('renderPromptBlock — populated produces agent-readable block');
{
  const block = renderPromptBlock([
    { name: 'Cookie banner', matcher: { strategy: 'role', role: 'button', value: 'Accept all' }, scope: 'global' },
  ]);
  expectIncludes('header',           block, '## KNOWN POPUPS');
  expectIncludes('lists popup name', block, 'Cookie banner');
  expectIncludes('shows matcher',    block, "getByRole('button', { name: 'Accept all' })");
}

console.log('');
if (failures > 0) { console.log(`FAILED — ${failures}`); process.exit(1); }
console.log('OK — all assertions passed');
