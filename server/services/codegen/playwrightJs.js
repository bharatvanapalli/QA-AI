'use strict';

/**
 * Framework: playwright-js (Playwright + Page Object Model, plain JavaScript).
 *
 * The JavaScript sibling of codegen/pom.js. Produces TWO files per scenario:
 *   - pages/<module>/<Module>Page.js   The Page Object class (locators + actions)
 *   - tests/<module>/<id>.spec.js       The test file that uses the Page Object
 *
 * Output is idiomatic modern JS (ESM-free CommonJS-friendly imports via
 * `@playwright/test`, no type annotations, JSDoc where it helps). A matching
 * JavaScript project shell (playwright.config.js, jsconfig.json, package.json)
 * is emitted by ensureProjectShell().
 *
 * Parsing reuses the same defensive recovery the TS generator got: strict JSON
 * → outermost-brace JSON → regex salvage of literal-newline-broken content.
 * A raw JSON blob is NEVER written into a .js file.
 */

const fs = require('fs');
const path = require('path');
const knownPopupsLib = require('../knownPopups');
const { parseGeneratedJson } = require('./_recoverJson');
const envContract = require('./_env');
const { authPromptBlock } = require('./_login');
const fidelity = require('./_fidelity');
const locators = require('./_locators');
const journeyLib = require('./_journey');
const storageStateLib = require('./_storageState');

let SYSTEM_PROMPT = `You are a senior SDET writing a Playwright test in plain JavaScript (NOT TypeScript) using a strict Page Object Model.

You MUST output a single JSON object with two top-level keys: "pageObject" and "test".
Each value has shape { "path": "<relative/path/from/project-root>", "content": "<full file contents>" }.

Strict rules for the Page Object (pageObject.content):
- Plain JavaScript — NO TypeScript. No type annotations, no interfaces, no "readonly", no ": Locator", no generics.
- One class named <Module>Page (PascalCase), exported via "module.exports = { <Module>Page };" at the end.
- The constructor takes a Playwright "page" and stores it as "this.page".
- Initialise all locators INSIDE the constructor body as "this.<name> = page.getByRole(...)" using the page PARAMETER, AFTER this.page = page. NEVER use a class field initialiser that reads this.page (e.g. "x = this.page.locator(...)") — field initialisers run before the constructor body, so this.page is undefined there and every test crashes with "Cannot read properties of undefined".
- Each public method models a behaviour ("async addToCart() {}") — but do NOT author login (see LOGIN below).
- Use resilient locators: page.getByRole, page.getByTestId — NOT raw CSS where avoidable.
- LOCATOR DISCIPLINE: do NOT use page.getByLabel unless the field has a REAL associated <label>. Login username/password inputs usually have only a name/placeholder — locate them with page.locator("input[name='...']"), page.getByPlaceholder(...), or page.getByRole('textbox', { name }). A getByLabel matching nothing fails the case before the behaviour under test.
- No page.waitForTimeout — use locator.waitFor / expect(...).toBeVisible({ timeout }).
- Use JSDoc comments (/** @param {string} value */) instead of TypeScript types where documentation helps.

Strict rules for the test (test.content):
- const { test, expect } = require('@playwright/test');
- const { <Module>Page } = require('<relative path to the page object>');
- Each test() instantiates the Page Object and calls its methods.
- Layer assertions where applicable: UI (toBeVisible/toHaveText/toHaveURL) + DOM attribute checks. Prefer web-first auto-retrying assertions; do NOT assert by waiting on a network response (see WAITS).
- Credentials and login come from the SHARED modules described in the CREDENTIALS and LOGIN sections below — never inline credentials, never invent env-var names.
- No console.log, no debugger, no test.only/skip.

PLAYWRIGHT DEPTH — use the framework's native power, but ONLY to express what the action plan actually verified (never invent checks, steps, or data):
- Group the flow with test.step('readable name', async () => { ... }) so the HTML report reads as named steps.
- Pick the web-first assertion that MATCHES the check — not always toBeVisible: toHaveURL, toHaveText/toContainText, toHaveValue, toHaveCount, toHaveAttribute, toBeEnabled/Disabled/Checked/Editable/Hidden, toHaveTitle. These auto-retry, so no manual wait is needed before them.
- When several INDEPENDENT end-state checks apply, use expect.soft(...) for the non-critical ones so one failure doesn't mask the others (the test still fails overall).
- Prefer getByRole with an accessible name; refine with .filter({ hasText }) / .nth() only when necessary. Avoid raw CSS/XPath.
- Reuse the configured trace/screenshot/video — don't reconfigure them in the spec.

END-TO-END COMPLETENESS — the spec must be runnable top to bottom with NO manual edits:
- Reproduce the FULL flow the action plan recorded, in order: navigation → any setup/preconditions → the actions under test → assertions → a final screenshot. Do not omit steps the agent actually performed.
- Navigation: use relative paths against baseURL (await page.goto('/login')) — never hard-code the origin.
- FIRST STATEMENT INVARIANT: The very first \`await\` in the test body MUST be either \`await page.goto(...)\` OR \`await login(page)\` (when a LOGIN section is present below). NEVER begin with a locator interaction — the page is blank until navigated.
  - IMPORTANT LOGIN EXCEPTION: when a LOGIN section is present, \`await login(page)\` MUST be the first statement — login() calls page.goto('/login') internally, fills the shared credentials, clicks the Login button, and waits for the post-login page. Do NOT emit a separate page.goto() before login():
    // CORRECT
    test('...', async ({ page }) => { await login(page); /* authenticated — proceed */ });
    // WRONG — login() already navigates; adding a goto first skips login or navigates to a protected URL unauthenticated
    test('...', async ({ page }) => { await page.goto('/some/module'); await login(page); }); // DO NOT DO THIS
  - If NO LOGIN section is present (negative-path test where login is under test, or no auth needed), the first \`await\` MUST be \`await page.goto(...)\`. Use the login URL from the setup navigates in the action plan, or \`await page.goto('/')\` as a safe default. NEVER start with a navigate to a protected/module URL if the session has not been established.
- Every assertion declared on the test case MUST have a matching expect(...). Never claim a behaviour you didn't assert.
- End the test with: await page.screenshot({ path: 'test-results/<caseSlug>.png' });

WAITS & TIMING — deterministic, never arbitrary:
- NEVER use page.waitForTimeout / hard sleeps. Use auto-waiting locators, expect(...).toBeVisible({ timeout }), locator.waitFor({ state, timeout }), or page.waitForURL(...).
- Give every explicit wait an EXPLICIT timeout (e.g. { timeout: 10_000 }).
- DO NOT use page.waitForResponse with a guessed URL or status code. It hangs for the FULL timeout when the guess is even slightly wrong — the single biggest cause of false failures in generated specs. Assert the visible OUTCOME instead with an auto-retrying web-first assertion (toHaveURL, toBeVisible, toHaveText) or page.waitForURL. Only use waitForResponse when the action plan recorded the EXACT response URL.
- NAVIGATION WAITS: after a navigating click, prefer waiting for a CONFIRMING ELEMENT (await someLocator.waitFor({ state: 'visible' })). If you wait on the URL, prefer a REGEX: page.waitForURL(/\/module\//) — regex handles query params and path variants correctly. If you use a glob, keep it BROAD: '**/module/**'. NEVER embed query params in a glob (e.g. '**/products**search=X**') — globs do NOT support query-param literals and always fail at runtime; use regex instead: waitForURL(/\/products.*search=X/). NEVER guess a specific sub-route.

LOCATOR HYGIENE — avoid these exact generation mistakes:
- Names in getByRole / getByText MUST be trimmed — NEVER include leading or trailing whitespace. If the visible text has an icon prefix or mixed capitalisation, use a case-insensitive regex: getByRole('link', { name: /Products/i }) — NOT getByRole('link', { name: ' Products' }).
- NEVER add .catch(() => {}) after a Playwright assertion or waitForURL — it silently swallows failures and hides real defects. The ONLY legitimate use is inside an isVisible guard: if (await locator.isVisible({ timeout: 2000 }).catch(() => false)).
- NEVER emit MCP tool names as code (browser_triple_click, browser_double_click, browser_click, browser_type, etc.). When an action carries a "playwrightHint" field, use that expression verbatim.

COMMENTS — clean and purposeful:
- Add a short comment above each logical block describing the user intent in plain language. One comment per step/group, not per line. No noise.

POPUP HANDLING — defensive by default:
- If the action trail shows the agent clicking a "Close" / "Accept" / "Got it" / "Dismiss" / "Decline" / "Maybe later" / "No thanks" / "X" type element, treat that as a popup dismissal (NOT a behavioural step under test).
- DO NOT emit the popup click as an unconditional step — re-running the spec on a day the popup doesn't appear would crash.
- INSTEAD wrap it defensively:
    const popup = page.getByRole('button', { name: /accept|close|got it|dismiss/i });
    if (await popup.isVisible({ timeout: 2000 }).catch(() => false)) {
      await popup.click();
    }
- When the user message includes a "knownPopupsBlock" section, add a test.beforeEach that defensively dismisses each named popup inline (JS, no external helper import).

Output ONLY a single JSON object with "pageObject" and "test". NO markdown fences. NO explanation.`;

SYSTEM_PROMPT += `\n\nCONTRACT BOUNDARY - NO INVENTED LOGOUT:
- Do NOT add cleanup, teardown, logout, sign-out, profile-menu clicks, or session-reset actions unless they are explicitly present in actionPlan.actions or the approved testCase.steps.
- Ending on an authenticated dashboard is valid. Playwright creates a fresh browser context per test, so generated specs do not need logout cleanup.`;

SYSTEM_PROMPT += `\n\nDATA DEPENDENCIES — when testCase.dependsOnIds is non-empty:
- This spec requires data created by prior cases (e.g. a record, account, or entry created upstream).
- Preserve the entire dependency flow and the dependent case. NEVER use test.skip, test.fixme, a conditional early return, or omitted actions merely because prerequisite data is absent.
- When the approved action plan or test-case steps include creation/setup for the prerequisite, replay that declared setup before the dependent actions and reuse the same captured/generated values. For a full dependency journey, keep every upstream case as an ordered test.step in the same test.
- If the declared evidence does not contain enough information to create the prerequisite safely, emit a non-destructive test.beforeAll check INSIDE test.describe and make absence an explicit failing assertion:

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      await login(page); // shared helper already imported
      await page.goto('/path/to/data'); // REPLACE with actual path inferred from action plan
      const found = await page.getByText('expected-value', { exact: false })
        .isVisible({ timeout: 5000 }).catch(() => false);
      expect(found, 'QAAI_PREREQUISITE_MISSING: declared upstream data was not found').toBe(true);
    } finally {
      await page.close();
    }
  });

- Replace the placeholder path and 'expected-value' with what the action plan shows was created upstream.
- Keep every dependent Page Object method, action, and assertion in the generated source even when this precondition assertion can fail at runtime. A visible failure is required; a silent skip is forbidden.
- Do NOT emit this beforeAll when dependsOnIds is empty.`;

SYSTEM_PROMPT += `\n\nDATA-DRIVEN TESTS — when actionPlan.dataRows is present:
Check \`actionPlan.dataRows\`. If it is a non-empty array and at least one entry has a non-empty \`fields\` object, this is a data-driven test case. Apply ALL of the following:

1. Declare a \`readData\` helper immediately after the imports (before test.describe):
     function readData(row, key) {
       const v = row && row.fields && row.fields[key] != null ? row.fields[key] : null;
       if (v === null) throw new Error(\`QAAI_DDT_MISSING_FIELD: no field "\${key}" in row — available: \${Object.keys((row && row.fields) || {}).join(', ')}\`);
       return String(v);
     }

2. Inside test.describe, BEFORE the test() call, declare the data rows verbatim from actionPlan.dataRows:
     const dataRows = [/* paste actionPlan.dataRows content here */];

3. Wrap ALL test() calls in a for-loop over dataRows:
     for (const row of dataRows) {
       test(\`<case name> — \${row.label || 'row'}\`, async ({ page }) => {
         // test body
       });
     }

4. For any fill/type action where the action object carries a \`dataRole\` field, emit:
     readData(row, '<dataRole value>')
   instead of the literal value or readEnv(). The dataRole string is the key into row.fields.

5. For any assertion whose expected value originated from a DDT fill (dataExpected field on the assertion), emit readData(row, '<dataExpected role>') so each iteration asserts the correct per-row value.

If actionPlan.dataRows is absent, empty, or all entries have empty fields, skip the loop entirely and write the test normally using literal values from the action plan.

**CRITICAL — readData scope invariant**: \`readData(row, key)\` is ONLY valid INSIDE a \`for (const row of dataRows)\` loop. If you emit any \`readData(row, ...)\` call, you MUST also emit the loop that defines \`row\`. If \`actionPlan.dataRows\` is absent or empty, do NOT emit \`readData(row, ...)\` at all — use the literal fill values from the action plan args instead. A \`readData()\` call outside a loop causes an instant \`ReferenceError: row is not defined\` at runtime.`;


// Mirror the TOOL MAPPING block that pom.js carries — JS generator needs the same guard.
SYSTEM_PROMPT += `

## TOOL MAPPING and PRIMITIVES
- Do NOT emit MCP tool names such as browser_triple_click, browser_double_click, or any other browser_* token. Map to Playwright:
  - browser_triple_click / playwrightHint "locator.click({ clickCount: 3 })" → await locator.click({ clickCount: 3 })
  - browser_double_click → await locator.dblclick()
  - browser_click → await locator.click()
  - browser_type / browser_fill_form → await locator.fill(value)
  - browser_press_key → await locator.press(key)
  - browser_select_option → await locator.selectOption(value)
  - browser_scroll → await locator.scrollIntoViewIfNeeded()
  - browser_navigate → await page.goto(url)
- When an action carries a "playwrightHint" field, use that expression verbatim — it is the exact Playwright call.
`;

function moduleClassName(module) {
  return (module || 'app')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

// Clean a free-text label into a tidy kebab-case slug (see codegen/pom.js).
function cleanSlug(s, fallback = 'app') {
  const out = String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return out || fallback;
}

function buildSpecSlug(testCase) {
  return cleanSlug(testCase.name, (testCase.id || 'test-case').slice(0, 8));
}

function logoutAllowedByContract({ testCase, actionPlan }) {
  const haystack = [
    testCase?.name,
    testCase?.assertions,
    testCase?.steps,
    actionPlan?.actions,
  ].map((v) => {
    try { return typeof v === 'string' ? v : JSON.stringify(v || ''); }
    catch (_) { return ''; }
  }).join('\n').toLowerCase();
  return /\b(log\s*out|logout|sign\s*out|signout)\b/.test(haystack);
}

function stripUnexpectedLogoutFromSpec(content, { testCase, actionPlan }) {
  if (!content || logoutAllowedByContract({ testCase, actionPlan })) return content;
  let removed = 0;
  const filtered = String(content).split(/\r?\n/).map((line) => {
    if (/\b(?:clickLogout|logout|signOut)\s*\(/i.test(line)) {
      removed += 1;
      return '// QAAI removed an invented cleanup/logout call that is not in the approved test steps.';
    }
    return line;
  });
  return removed ? filtered.join('\n') : content;
}

function layout(scenario, testCase) {
  const slug = buildSpecSlug(testCase);
  const moduleSlug = cleanSlug(scenario.module, 'app');
  const cls = moduleClassName(scenario.module);
  // PER-CASE page object (not per-module). A shared pages/<m>/<Module>Page.js is
  // clobbered last-write-wins when N cases each author their own <Module>Page
  // with different methods, so every spec but the last calls methods that no
  // longer exist ("X is not a function"). The class name can stay <Module>Page —
  // separate .js files are separate modules, no collision. See codegen/pom.js.
  const pageObjectFile = `pages/${moduleSlug}/${slug}.page.js`;
  return {
    primaryFile: `tests/${moduleSlug}/${slug}.spec.js`,
    extras: [pageObjectFile],
    pageObjectFile,
    testFile: `tests/${moduleSlug}/${slug}.spec.js`,
    className: `${cls}Page`,
    moduleSlug,
  };
}

async function generate({ provider, apiKey, model, scenario, testCase, actionPlan, targetUrl, knownPopups, credProfile, authInfo, preAuthenticated }) {
  const lay = layout(scenario, testCase);
  const norm = knownPopupsLib.normalize(knownPopups);
  const hasPopups = norm.normalized.length > 0;

  // Dynamic system prompt: static rules + project credential contract + (when a
  // shared login helper was authored for this run) the directive to CALL it.
  let system = SYSTEM_PROMPT;
  if (preAuthenticated) {
    // SSO / pre-authenticated suite: the session is baked via storageState, so
    // there is NO login to author or call — skip the credential + auth blocks.
    system += `\n\n${storageStateLib.preAuthPromptBlock()}`;
  } else {
    if (credProfile) system += `\n\n${envContract.promptBlock(credProfile, { lang: 'js', accessorImportPath: '../../utils/env' })}`;
    // NEGATIVE-PATH / BRUTE-FORCE CREDENTIAL EXCEPTION appended AFTER the CREDENTIALS
    // block so it takes ordering precedence — the LLM reads both in sequence and the
    // exception is the last instruction it sees on the topic of credential fills.
    system += `\n\nNEGATIVE-PATH / BRUTE-FORCE CREDENTIAL EXCEPTION:
DETECTION: The server has already determined whether this is a negative-path test. Check the user message JSON:
  - If actionPlan.testIntent === "negative_path" → this IS a negative-path test. Apply the rules below.
  - If actionPlan.testIntent is absent/undefined → this is a normal test. Use login() and readEnv() as normal.
  Do NOT try to infer negative-path intent from the test name yourself — the server has already done it.

When actionPlan.testIntent === "negative_path":
- This test INTENTIONALLY uses wrong or empty credentials to verify that the system rejects them.
- Emit the credential fills and the Login button click INLINE using the ACTUAL fill values recorded in the action plan (the "text" or "value" field of each browser_fill / browser_type action), NOT readEnv('QAAI_USERNAME'/'QAAI_PASSWORD').
- Use literal strings: await el.fill("wrongpassword") or await el.fill("") — whatever the action plan records was actually typed.
- Do NOT call login() — the whole point is to test the failure path, which login() hides.
- If the same step types a valid username then a wrong password, emit BOTH fills inline with their actual recorded values.
- ALWAYS emit the Login button click after the credential fills — the validation error can only appear after form submission.
- This exception OVERRIDES the CREDENTIALS block above.`;
    if (authInfo && authInfo.authImportPath) system += `\n\n${authPromptBlock(authInfo.authImportPath, 'js')}`;
  }
  system += `\n\n${fidelity.fidelityBlock({ lang: 'js' })}`;
  system += `\n\n${locators.locatorPromptBlock({ lang: 'js' })}`;

  const declaredAssertions = fidelity.declaredAssertionsFor(testCase);
  const userMsg = JSON.stringify({
    targetUrl,
    caseStatus: actionPlan && actionPlan.caseStatus,
    scenario: { name: scenario.name, module: scenario.module, category: scenario.category, rationale: scenario.rationale },
    testCase: { name: testCase.name, type: testCase.type, dependsOnIds: testCase.dependsOnIds || [], declaredAssertions, assertionsHint: testCase.assertions, steps: testCase.steps || [] },
    assertionDigest: fidelity.assertionDigest(declaredAssertions),
    resolvedLocators: locators.manifestDigest(actionPlan && actionPlan.locatorManifest),
    actionPlan,
    knownPopupsBlock: hasPopups
      ? `The operator declared ${norm.normalized.length} project-level popup(s) for this site. Emit a test.beforeEach that defensively dismisses them inline (JS). Popup names: ${norm.normalized.map((p) => p.name).join(', ')}.`
      : null,
    expectedFiles: {
      pageObject: { path: lay.pageObjectFile, className: lay.className },
      test: { path: lay.testFile },
    },
  }, null, 2);

  const resp = await provider.complete({
    apiKey,
    model,
    maxTokens: 4000,
    system,
    messages: [{ role: 'user', content: userMsg }],
  });

  const rawText = (resp.content?.[0]?.text || '').trim();
  const parsed = parseGeneratedJson(rawText);
  if (parsed && parsed.testContent) {
    parsed.testContent = stripUnexpectedLogoutFromSpec(parsed.testContent, { testCase, actionPlan });
  }

  if (!parsed || (!parsed.pageContent && !parsed.testContent)) {
    const reason = parsed === null
      ? 'model did not return the expected { pageObject, test } JSON object'
      : 'model returned JSON but neither pageObject.content nor test.content was present';
    return (
      `// ─── Page Object: ${lay.pageObjectFile} ───\n` +
      `// QAAI CODEGEN FAILED — ${reason}.\n` +
      `// The test PASSED in the agent run; only the spec emission failed.\n` +
      `// Re-merge this case from Governance to regenerate. Raw model output preserved below for debugging:\n` +
      rawText.split('\n').map((l) => `//   ${l}`).join('\n') + '\n\n' +
      `// ─── Test: ${lay.testFile} ───\n` +
      `// QAAI CODEGEN FAILED — see Page Object file header above.\n`
    );
  }

  return (
    `// ─── Page Object: ${parsed.pagePath || lay.pageObjectFile} ───\n` +
    `${parsed.pageContent || ''}\n\n` +
    `// ─── Test: ${parsed.testPath || lay.testFile} ───\n` +
    `${parsed.testContent || ''}\n`
  );
}

function splitFiles(concat, lay) {
  const result = { pages: '', test: '' };
  const m = concat.match(/^\/\/ ─── Page Object:.*?───\n([\s\S]*?)\n\n\/\/ ─── Test:.*?───\n([\s\S]*)$/);
  if (m) {
    result.pages = m[1].trimEnd();
    result.test = m[2].trimEnd();
  } else {
    result.test = concat;
  }
  return {
    [lay.pageObjectFile]: result.pages,
    [lay.testFile]: result.test,
  };
}

/**
 * Ensure the project's shared JavaScript shell exists. Idempotent.
 * @param {string} rootDir
 * @param {object} [opts]  { targetUrl } — baked into the config as the default
 *   baseURL so the unzipped project runs without any env setup.
 */
function ensureProjectShell(rootDir, opts = {}) {
  const created = [];
  const baseUrl = opts.targetUrl || 'https://demo.playwright.dev/todomvc';
  const writeIfMissing = (rel, content) => {
    const full = path.join(rootDir, rel);
    if (fs.existsSync(full)) return;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    created.push(rel);
  };

  // P3 — pre-authenticated (SSO) suites: bake the captured session and wire
  // use.storageState so every test starts logged in without a login form.
  const preAuthed = opts.storageState && storageStateLib.isUsableState(opts.storageState);
  if (preAuthed && storageStateLib.writeStorageState(rootDir, opts.storageState, fs, path)) created.push(storageStateLib.STATE_REL);
  const storageStateUseLine = preAuthed ? '\n' + storageStateLib.configUseLine(true) : '';

  writeIfMissing('playwright.config.js',
`const { defineConfig, devices } = require('@playwright/test');
const dotenv = require('dotenv');
// Read .env directly via .parsed so baseURL is never shadowed by a stale
// Windows session variable (dotenv silently skips vars already in process.env
// even with override:true when the parent shell set them before Node started).
const _env = dotenv.config().parsed || {};
const BASE_URL = _env.QAAI_TARGET_URL || ${JSON.stringify(baseUrl)};
// Propagate to process.env so specs that read it directly also see the right value.
process.env.QAAI_TARGET_URL = BASE_URL;

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: 1,
  // Serial by default: exported e2e suites share one app instance + one login;
  // parallel workers collide on a shared backend. Bump with PW_WORKERS=4 once
  // your cases are isolated.
  fullyParallel: false,
  workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : 1,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    // baseURL is baked from the QAAI project's Target URL; override at runtime
    // with QAAI_TARGET_URL=... npx playwright test
    baseURL: BASE_URL,${storageStateUseLine}
    headless: true,
    viewport: { width: 1280, height: 720 },
    screenshot: 'on',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
    // Generous timeouts so a slow real-world app fails on a true defect, not latency.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
`);

  writeIfMissing('fixtures/test-fixtures.js',
`const base = require('@playwright/test');

/**
 * Shared fixtures. Add Page Object factories or test data builders here.
 */
module.exports = {
  test: base.test,
  expect: base.expect,
};
`);

  // utils/env.js — the ONE credential contract. Bakes real values when the
  // project has a credential profile + emits a real .env, so the suite runs
  // with zero setup; otherwise a clearly-marked placeholder.
  const profile = (opts.credProfile && Array.isArray(opts.credProfile.users))
    ? opts.credProfile : { users: [], hasCreds: false };
  writeIfMissing('utils/env.js', envContract.renderEnvAccessorJs(profile, { baseUrl }));
  writeIfMissing('.env', envContract.renderDotenv(profile, { targetUrl: baseUrl }));
  writeIfMissing('.env.example', envContract.renderDotenvExample(profile, { targetUrl: baseUrl }));
  writeIfMissing('.gitignore', 'node_modules/\ntest-results/\nplaywright-report/\n.env\n');

  writeIfMissing('package.json', JSON.stringify({
    name: 'qaai-playwright-tests-js',
    version: '1.0.0',
    private: true,
    scripts: {
      test: 'playwright test',
      'test:headed': 'playwright test --headed',
      'test:ui': 'playwright test --ui',
      report: 'playwright show-report',
    },
    devDependencies: {
      '@playwright/test': '^1.48.0',
      dotenv: '^16.4.5',
    },
  }, null, 2) + '\n');

  writeIfMissing('jsconfig.json', JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'commonjs',
      checkJs: false,
      moduleResolution: 'node',
      resolveJsonModule: true,
    },
    include: ['tests/**/*', 'pages/**/*', 'fixtures/**/*', 'utils/**/*'],
  }, null, 2) + '\n');

  // Defensive JS helpers for generated specs — mirrored to the TS version.
  writeIfMissing('utils/test-helpers.js',
`// Defensive helpers for generated Playwright JS specs.
async function findFirstVisible(candidates, timeout = 2000) {
  for (const loc of candidates) {
    try {
      if (await loc.isVisible({ timeout }).catch(() => false)) return loc;
    } catch (_) {}
  }
  return null;
}

async function safeGoto(page, url, opts = {}) {
  const attempts = Number(opts.retries ?? 3);
  const timeout = Number(opts.timeout ?? 30000);
  const waitUntil = opts.waitUntil || 'domcontentloaded';
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await page.goto(url, { waitUntil, timeout });
      return;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await page.waitForLoadState('domcontentloaded').catch(() => {});
      }
    }
  }
  throw lastErr;
}

async function safeClick(locator, opts) {
  const timeout = (opts && opts.timeout) || 5000;
  const clickOpts = { timeout };
  if (opts && opts.clickCount != null) clickOpts.clickCount = opts.clickCount;
  try {
    await locator.waitFor({ state: 'visible', timeout }).catch(() => { throw new Error('locator not visible for click'); });
    await locator.click(clickOpts);
  } catch (err) {
    try {
      await locator.scrollIntoViewIfNeeded();
      await locator.waitFor({ state: 'visible', timeout: 1500 });
      await locator.click(clickOpts);
    } catch (err2) {
      throw err2 || err;
    }
  }
}

// Handles two call forms:
//   clickFirstVisible(locator)                    — single-locator (sanitizer .click() replacement)
//   clickFirstVisible(locator, { clickCount: 2 }) — with click options (sanitizer .dblclick() replacement)
//   clickFirstVisible(page, [loc1, loc2])          — multi-candidate (legacy)
async function clickFirstVisible(locatorOrPage, selectorsArgOrOpts, timeout = 2000) {
  if (Array.isArray(selectorsArgOrOpts)) {
    const candidates = selectorsArgOrOpts.map((s) => (typeof s === 'string' ? locatorOrPage.locator(s) : s));
    const found = await findFirstVisible(candidates, timeout);
    if (!found) throw new Error('no visible selector found from candidates');
    await safeClick(found);
  } else {
    const opts = (selectorsArgOrOpts && typeof selectorsArgOrOpts === 'object') ? selectorsArgOrOpts : {};
    await safeClick(locatorOrPage, { timeout: opts.timeout || timeout, clickCount: opts.clickCount });
  }
}

module.exports = { findFirstVisible, safeGoto, safeClick, clickFirstVisible };
`);

  return created;
}

// ── Journey codegen (P1) — dependsOnIds chain → ONE CommonJS POM artifact:
// locators/ + pages/ + tests/. The live playwright-js shell is CommonJS, so the
// POM emitter uses require/module.exports here while ReplayIR playwright-pom-js
// keeps its ESM package shape.
function generateJourney(opts) { return journeyLib.generatePlaywrightPomJourney({ ...opts, lang: 'js', moduleFormat: 'cjs' }); }
function layoutJourney(scenario, journeyCases) { return journeyLib.journeyLayout(scenario, journeyCases, 'js'); }
function splitFilesJourney(content, lay) { return journeyLib.splitFilesJourney(content, lay); }

module.exports = { generate, layout, splitFiles, ensureProjectShell, parseGeneratedJson, SYSTEM_PROMPT, generateJourney, layoutJourney, splitFilesJourney };
