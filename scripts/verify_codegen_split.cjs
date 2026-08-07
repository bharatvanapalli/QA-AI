// Zero-credit proof that the codegen split/header fix is correct.
// Reproduces a NON-PASS case (the class that broke): a clean concat body +
// a multi-line step error, then applies the new conductor logic and asserts
// (a) the page object splits out clean, (b) the header is fully line-commented,
// (c) NO error text leaks as live code, (d) no duplicate test/page in one file.
const pom = require('../server/services/codegen/pom.js');

// --- a clean body concat exactly as pom.generate() returns it ---
const layout = {
  pageObjectFile: 'pages/authentication/AuthenticationPage.ts',
  testFile: 'tests/authentication/attempt-login-with-empty-password.spec.ts',
  primaryFile: 'tests/authentication/attempt-login-with-empty-password.spec.ts',
};
const bodyCode =
  `// ─── Page Object: ${layout.pageObjectFile} ───\n` +
  `import { Page, Locator } from '@playwright/test';\n` +
  `export class AuthenticationPage {\n  constructor(private readonly page: Page) {}\n}\n` +
  `\n` +
  `// ─── Test: ${layout.testFile} ───\n` +
  `import { test, expect } from '@playwright/test';\n` +
  `import { AuthenticationPage } from '../../pages/authentication/AuthenticationPage';\n` +
  `test('empty password', async ({ page }) => { const p = new AuthenticationPage(page); });\n`;

// --- the multi-line error that used to leak as code ---
const status = 'fail';
const stepResults = [
  { index: 2, status: 'fail', error: '### Error\nReferenceError: document is not defined\n  at eval' },
];

// --- NEW conductor logic (mirrors persistResultAndCodegen) ---
const oneLine = (s) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
const failedSteps = stepResults.filter((s) => s.status === 'fail' || s.status === 'blocked')
  .map((s) => `step ${s.index}: ${oneLine(s.error || s.status).slice(0, 180)}`).join('; ');
const headerComment = [
  '// QAAI Auto-Authored Spec — one or more approved steps errored during this run.',
  `// Case verdict: ${status.toUpperCase()}.`,
  `// Failing steps: ${failedSteps}`,
  '// Review carefully before merging — the steps captured here are what the agent attempted, not necessarily a correct test.',
  '',
].join('\n');

const split = pom.splitFiles(bodyCode, layout);
const testKey = layout.testFile;
if (headerComment && split[testKey] != null) split[testKey] = headerComment + split[testKey];

const po = split[layout.pageObjectFile] || '';
const spec = split[testKey] || '';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fails++; };

// (a) page object splits out and is CLEAN
ok(po.includes('export class AuthenticationPage'), 'page object file has the class');
ok(!po.includes("import { test, expect }"), 'page object has NO test import (test not dumped into it)');
ok(!po.includes('// Case verdict'), 'page object has NO header comment');

// (b) spec has the class IMPORT but NOT the class DECLARATION (no duplicate)
ok(spec.includes("import { AuthenticationPage }"), 'spec imports the page object');
ok(!spec.includes('export class AuthenticationPage'), 'spec does NOT also declare the class (no duplicate-decl)');

// (c) header present and EVERY non-empty header line is a // comment
ok(spec.startsWith('// QAAI Auto-Authored Spec'), 'spec starts with the header');
ok(headerComment.split('\n').every((l) => l === '' || l.startsWith('//')), 'every header line is commented');

// (d) the multi-line error did NOT leak as live code
ok(!/^\s*ReferenceError/m.test(spec), 'no uncommented "ReferenceError" line leaked into the spec');
ok(spec.includes('Failing steps: step 2: ### Error ReferenceError: document is not defined'),
   'the multi-line error was collapsed to ONE commented line');

console.log(fails === 0 ? '\nALL CHECKS PASSED' : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
