'use strict';

/**
 * Framework: playwright-pom (Playwright + Page Object Model).
 *
 * Produces TWO files per scenario:
 *   - pages/<module>/<Module>Page.ts    The Page Object class (locators + actions)
 *   - tests/<module>/<id>.spec.ts        The test file that uses the Page Object
 *
 * Also exposes ensureProjectShell() which writes one-time shared files
 * (playwright.config.ts, fixtures/, utils/, package.json, tsconfig) the first
 * time a project gets generated code.
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

let SYSTEM_PROMPT = `You are a senior SDET writing a Playwright TypeScript test using a strict Page Object Model.

You MUST output a single JSON object with two top-level keys: "pageObject" and "test".
Each value has shape { "path": "<relative/path/from/project-root>", "content": "<full file contents>" }.

Strict rules for the Page Object (pageObject.content):
- One TypeScript class named <Module>Page (PascalCase). import { type Page, type Locator } from '@playwright/test'.
- Declare locators as TYPED readonly fields (private readonly firstName: Locator;) and ASSIGN them INSIDE the constructor body, AFTER this.page = page, using the page PARAMETER:
    constructor(page: Page) {
      this.page = page;
      this.firstName = page.locator("input[name='firstName']");
    }
- CRITICAL — NEVER initialise a class field inline with this.page (e.g. private readonly x = this.page.locator(...)). Class field initialisers run BEFORE the constructor body, so this.page is still undefined there and EVERY test crashes on construction with "Cannot read properties of undefined (reading 'locator')". Locators MUST be assigned in the constructor body using the page parameter.
- Each PUBLIC method models a behaviour ("addToCart()", "submitForm()") — but do NOT author login (see LOGIN below)
- Use resilient locators: page.getByRole, page.getByTestId — NOT raw CSS where avoidable.
- LOCATOR DISCIPLINE: do NOT use page.getByLabel unless the field has a REAL associated <label> element. Many inputs (login username/password especially) have only a name/placeholder — locate those with page.locator("input[name='...']"), page.getByPlaceholder(...), or page.getByRole('textbox', { name }). A getByLabel that matches nothing fails the whole case before the behaviour under test.
- No page.waitForTimeout — use locator.waitFor / expect.toBeVisible({timeout})

Strict rules for the test (test.content):
- import { test, expect } from '@playwright/test'
- import the Page Object from a relative path
- Each test() instantiates the Page Object and calls its methods
- Layer assertions where applicable: UI (toBeVisible/toHaveText/toHaveURL) + DOM attribute checks. Prefer web-first auto-retrying assertions; do NOT assert by waiting on a network response (see WAITS).
- Credentials and login come from the SHARED modules described in the CREDENTIALS and LOGIN sections below — never inline credentials, never invent env-var names.
- No console.log, no debugger, no test.only/skip

PLAYWRIGHT DEPTH — use the framework's native power, but ONLY to express what the action plan actually verified (never invent checks, steps, or data):
- Group the flow with test.step('readable name', async () => { ... }) so the HTML report reads as named steps.
- Pick the web-first assertion that MATCHES the check — not always toBeVisible: toHaveURL, toHaveText/toContainText, toHaveValue, toHaveCount, toHaveAttribute, toBeEnabled/Disabled/Checked/Editable/Hidden, toHaveTitle. These auto-retry, so no manual wait is needed before them.
- When several INDEPENDENT end-state checks apply, use expect.soft(...) for the non-critical ones so a single failure doesn't mask the others (the test still fails overall).
- Prefer getByRole with an accessible name; refine with .filter({ hasText }) / .nth() only when necessary. Avoid raw CSS/XPath.
- Reuse the configured trace/screenshot/video — don't reconfigure them in the spec.

NO INVENTED HELPERS — never generate custom assertion or support utilities:
- Do NOT generate helper functions named assertTextPresent, assertVisible, checkText, assertContains, or any other custom assertion wrapper. These wrappers scope incorrectly (scoping to page.locator('main') misses sidebar navigation such as "Reports" / "Settings"), add a redundant layer over Playwright's auto-retrying assertions, and diverge from the VERDICT FIDELITY contract.
- Do NOT emit a support/replayir.ts, support/helpers.ts, utils/helpers.ts, or any file that is not in the expected files list. The project already provides utils/auth.ts, utils/env.ts, utils/test-helpers.ts — do not create siblings.
- Write all assertions INLINE using the OR-chain specified in VERDICT FIDELITY. Use page.getByText(...) directly — NEVER scope to page.locator('main') or page.locator('[role="main"]') for a text presence check; nav/sidebar content lives outside main and such scoping silently fails for it.

END-TO-END COMPLETENESS — the spec must be runnable top to bottom with NO manual edits:
- Reproduce the FULL flow the action plan recorded, in order: navigation → any setup/preconditions → the actions under test → assertions → a final screenshot. Do not omit steps that the agent actually performed.
- Navigation: use relative paths against baseURL (await page.goto('/login')) — never hard-code the origin, baseURL is configured.
- FIRST STATEMENT INVARIANT: The very first \`await\` in the test body MUST be either \`await page.goto(...)\` OR \`await login(page)\` (when a LOGIN section is present). NEVER begin with a locator interaction — the page is blank until navigated. IMPORTANT LOGIN EXCEPTION: when a LOGIN section is present, \`await login(page)\` is the correct first statement — login() calls page.goto() internally and handles navigation to the login URL, filling credentials, clicking submit, and waiting for the post-login page. Do NOT add a separate goto before login():

    // CORRECT — login() navigates internally
    test('...', async ({ page }) => {
      await login(page);
      // ... assertions here
    });

    // WRONG — duplicate navigation, page starts at wrong URL for login()
    test('...', async ({ page }) => {
      await page.goto('/auth/login');
      await login(page);   // login() also navigates, first goto was wasted
      // ...
    });
- Every assertion declared on the test case MUST have a matching expect(...). Never claim a behaviour you didn't assert.
- End the test with: await page.screenshot({ path: 'test-results/<caseSlug>.png' });

WAITS & TIMING — deterministic, never arbitrary:
- NEVER use page.waitForTimeout / hard sleeps. Use auto-waiting locators, expect(...).toBeVisible({ timeout }), locator.waitFor({ state, timeout }), or page.waitForURL(...) for navigation.
- Give every explicit wait an EXPLICIT timeout (e.g. { timeout: 10_000 }) so a slow environment fails with a clear message instead of hanging.
- DO NOT use page.waitForResponse with a guessed URL or status code. It hangs for the FULL timeout when the guess is even slightly wrong (wrong path, 201 vs 200, redirect) — this is the single biggest cause of false failures in generated specs. Instead, assert the visible OUTCOME of the backend call with an auto-retrying web-first assertion (toHaveURL, toBeVisible, toHaveText, toHaveCount) or page.waitForURL for a navigation. Only use page.waitForResponse when the action plan recorded the EXACT response URL that fired.
- NAVIGATION WAITS: after a click that navigates, prefer waiting for a CONFIRMING ELEMENT (await someLocator.waitFor({ state: 'visible' })). If you wait on the URL, prefer a REGEX: page.waitForURL(/\/module\//) — regex handles query params and path variants correctly. If you use a glob, keep it BROAD: '**/module/**'. NEVER embed query params in a glob (e.g. '**/products**search=X**') — globs do NOT support query-param literals and always fail at runtime; use regex instead: waitForURL(/\/products.*search=X/). NEVER guess a specific sub-route.

LOCATOR HYGIENE — avoid these exact generation mistakes:
- Names in getByRole / getByText MUST be trimmed — NEVER include leading or trailing whitespace. If the visible text has an icon prefix or mixed capitalisation, use a case-insensitive regex: getByRole('link', { name: /Products/i }) — NOT getByRole('link', { name: ' Products' }).
- NEVER add .catch(() => {}) after a Playwright assertion or waitForURL — it silently swallows failures and hides real defects. The ONLY legitimate use is inside an isVisible guard: if (await locator.isVisible({ timeout: 2000 }).catch(() => false)).
- NEVER emit MCP tool names as code (browser_triple_click, browser_double_click, browser_click, browser_type, etc.). When an action carries a "playwrightHint" field, use that expression verbatim.

COMMENTS — clean and purposeful:
- Add a short comment above each logical block describing the user intent in plain language (e.g. "// Submit the login form and wait for the dashboard to load"). One comment per step/group — not per line. No noise, no restating the obvious.

POPUP HANDLING — defensive by default:
- If the action trail shows the agent clicking a "Close" / "Accept" / "Got it" / "Dismiss" / "Decline" / "Maybe later" / "No thanks" / "X" type element, treat that as a popup dismissal (NOT a behavioural step under test).
- DO NOT emit the popup click as an unconditional step — re-running the spec on a day the popup doesn't appear would crash.
- INSTEAD wrap it defensively:
    const popup = page.getByRole('button', { name: /accept|close|got it|dismiss/i });
    if (await popup.isVisible({ timeout: 2000 }).catch(() => false)) {
      await popup.click();
    }
- When the user message includes a "knownPopupsBlock" section, IMPORT and CALL the dismissKnownPopups helper in test.beforeEach:
    import { dismissKnownPopups } from '../../utils/known-popups';
    test.beforeEach(async ({ page }) => { await dismissKnownPopups(page); });
  The helper file is already generated separately — DO NOT inline its body.

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

1. Declare a typed \`readData\` helper immediately after the imports (before test.describe):
     function readData(row: Record<string, string>, key: string): string {
       const v = row?.fields?.[key] ?? null;
       if (v === null) throw new Error(\`QAAI_DDT_MISSING_FIELD: no field "\${key}" in row — available: \${Object.keys(row?.fields ?? {}).join(', ')}\`);
       return String(v);
     }

2. Inside test.describe, BEFORE the test() call, declare the data rows verbatim from actionPlan.dataRows:
     const dataRows: { label: string; fields: Record<string, string> }[] = [/* paste actionPlan.dataRows content */];

3. Wrap ALL test() calls in a for-loop over dataRows:
     for (const row of dataRows) {
       test(\`<case name> — \${row.label ?? 'row'}\`, async ({ page }) => {
         // test body
       });
     }

4. For any fill/type action where the action object carries a \`dataRole\` field, emit:
     readData(row, '<dataRole value>')
   instead of the literal value or the env accessor. The dataRole string is the key into row.fields.

5. For any assertion whose expected value originated from a DDT fill (dataExpected field on the assertion), emit readData(row, '<dataExpected role>') so each iteration asserts the correct per-row value.

If actionPlan.dataRows is absent, empty, or all entries have empty fields, skip the loop entirely and write the test normally.`;

// Additional guidance to prevent the model from inventing non-Playwright tools
// and to map high-level actions to Playwright primitives.
SYSTEM_PROMPT += "\n\n## TOOL MAPPING and PRIMITIVES\n- Do NOT emit non-Playwright tool names such as 'browser_triple_click', 'browser_double_click', or any custom tool token. Map high-level actions to Playwright primitives:\n  - triple click -> await locator.click({ clickCount: 3 })\n  - double click -> await locator.dblclick()\n  - click -> await locator.click()\n  - fill/type -> await locator.fill(...) / await locator.type(...)\n  - press -> await locator.press(...)\n  - selectOption -> await locator.selectOption(...)\n- If you reference a helper function, you MUST also emit that helper file in the JSON output. Do not reference helpers you do not provide.\n";

function moduleClassName(module) {
  return (module || 'app')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

// Clean a free-text label into a tidy kebab-case slug for file/dir names.
// Collapses separators, trims dashes, caps length so the full path stays well
// under Windows's MAX_PATH (260) even when the run folder is deep.
function cleanSlug(s, fallback = 'app') {
  const out = String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')   // any run of non-alphanumerics → single dash
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return out || fallback;
}

/**
 * Build a clean, human-readable spec filename from the test case name —
 * directly readable and related to the behaviour under test.
 *
 *   "Login with valid standard_user credentials" → "login-with-valid-standard-user-credentials"
 *
 * No opaque id suffix: names derive from the case (which the Architect names
 * distinctly per scenario) so the unzipped tree reads like a hand-written
 * suite. The id is only used as a last-resort fallback for an unnamed case.
 */
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
  // The page object is PER-CASE, not per-module. A single shared
  // pages/<module>/<Module>Page.ts is clobbered (last-write-wins) when N cases
  // in the same module each independently author their OWN <Module>Page with
  // different methods — only the last case's file survives, so every other
  // spec calls methods that don't exist ("pimPage.gotoLogin is not a function",
  // ".login is not a function", …) and the whole suite fails on line 1. Giving
  // each case its own page-object FILE (the class name can stay <Module>Page —
  // separate .ts files are separate modules, no collision) guarantees every
  // spec ships with the exact page object it was generated against. The spec's
  // import path is driven by pageObjectFile below, so it points at the per-case
  // file automatically.
  const pageObjectFile = `pages/${moduleSlug}/${slug}.page.ts`;
  return {
    primaryFile: `tests/${moduleSlug}/${slug}.spec.ts`,
    extras: [pageObjectFile],
    pageObjectFile,
    testFile: `tests/${moduleSlug}/${slug}.spec.ts`,
    className: `${cls}Page`,
    moduleSlug,
  };
}

async function generate({ provider, apiKey, model, scenario, testCase, actionPlan, targetUrl, knownPopups, credProfile, authInfo, preAuthenticated }) {
  const lay = layout(scenario, testCase);
  // Normalise the project's declared popups once; the codegen prompt
  // gets a flag telling Claude whether to emit the beforeEach hook +
  // helper import. The helper file itself is emitted by the caller
  // (persistResultAndCodegen) so it lives at utils/known-popups.ts and
  // every spec in the run imports the same source of truth.
  const norm = knownPopupsLib.normalize(knownPopups);
  const hasPopups = norm.normalized.length > 0;

  // Compose the dynamic system prompt: the static rules + the project-specific
  // CREDENTIALS contract (exact env-var names + shared accessor) and, when a
  // shared login helper was authored for this run, the LOGIN directive telling
  // the model to CALL it instead of re-authoring login. These two blocks are
  // what stop the model inventing 14 different env-var names and 17 different
  // login implementations across the cases of one suite.
  let system = SYSTEM_PROMPT;
  if (preAuthenticated) {
    // SSO / pre-authenticated suite: the session is baked via storageState, so
    // there is NO login to author or call — skip the credential + auth blocks.
    system += `\n\n${storageStateLib.preAuthPromptBlock()}`;
  } else {
    if (credProfile) system += `\n\n${envContract.promptBlock(credProfile, { lang: 'ts', accessorImportPath: '../../utils/env' })}`;
    // NEGATIVE-PATH exception appended after CREDENTIALS so the LLM reads it last
    // and it overrides the "use readEnv" rule for negative tests.
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
    if (authInfo && authInfo.authImportPath) system += `\n\n${authPromptBlock(authInfo.authImportPath, 'ts')}`;
  }
  system += `\n\n${fidelity.fidelityBlock({ lang: 'ts' })}`;
  system += `\n\n${locators.locatorPromptBlock({ lang: 'ts' })}`;

  // The STRUCTURED verdict contract (type/criticality/expected value) the run's
  // verdict was computed from — what the spec must assert to reach the same
  // verdict. testCase.assertions (a freeform sentence) is kept only as a hint.
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
      ? `The operator declared ${norm.normalized.length} project-level popup(s) for this site. Emit the dismissKnownPopups beforeEach hook (see system prompt). Popup names: ${norm.normalized.map((p) => p.name).join(', ')}.`
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

  // If the model returned a test file, ensure the generated test imports our
  // defensive helpers so emitted specs can call `clickFirstVisible`/`safeClick`.
  try {
    if (parsed && parsed.testContent) {
      const testPath = parsed.testPath || lay.testFile || 'tests/spec.ts';
      const depth = testPath.split('/').length - 1;
      const relPrefix = depth > 0 ? '../'.repeat(depth) : './';
      const helperImportPath = (relPrefix + 'utils/test-helpers').replace(/\\/g, '/');
      // Guard against "Duplicate declaration clickFirstVisible" (AST parse error
      // that blocks certification → no spec/page-object written). Only inject the
      // helper import when the spec neither imports from utils/test-helpers NOR
      // already DECLARES clickFirstVisible itself (the LLM/sanitizer sometimes
      // emits a local function/const, or another pass already injected the
      // import — adding a second binding for the same name fails to parse).
      const alreadyDeclaresHelper = /(?:async\s+)?function\s+clickFirstVisible\b/.test(parsed.testContent)
        || /\b(?:const|let|var)\s+clickFirstVisible\b/.test(parsed.testContent)
        || /import\s*\{[^}]*\bclickFirstVisible\b[^}]*\}/.test(parsed.testContent);
      if (!/utils\/test-helpers/.test(parsed.testContent) && !alreadyDeclaresHelper) {
        parsed.testContent = `import { clickFirstVisible, safeClick, safeGoto } from '${helperImportPath}';\n` + parsed.testContent;
      } else if (/utils\/test-helpers/.test(parsed.testContent) && !/safeGoto/.test(parsed.testContent)) {
        parsed.testContent = parsed.testContent.replace(/import\s+\{([^}]*)\}\s+from\s+['"][^'"]*utils\/test-helpers[^'"]*['"];?/,
          (_m, names) => `import { ${names.trim()}, safeGoto } from '${helperImportPath}';`);
      }
    }
  } catch (_) {}

  // If we could not recover a Page Object OR a test from the model's output,
  // we must NOT fall back to writing the raw response as a .ts file — that is
  // how a JSON blob ends up in the Output Files page. Emit a clearly-marked
  // TypeScript stub instead so the reviewer sees WHY codegen failed and can
  // re-merge from Governance, rather than a wall of unparseable JSON.
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

  // Concatenated view (for the Reports → Generated spec panel + lint).
  const concat =
    `// ─── Page Object: ${parsed.pagePath || lay.pageObjectFile} ───\n` +
    `${parsed.pageContent || ''}\n\n` +
    `// ─── Test: ${parsed.testPath || lay.testFile} ───\n` +
    `${parsed.testContent || ''}\n`;

  return concat;
}

/**
 * Returns a parsed { pageObject, test } map from a generated concat blob,
 * for callers that want to write each file separately.
 */
function splitFiles(concat, lay) {
  const result = { pages: '', test: '' };
  const m = concat.match(/^\/\/ ─── Page Object:.*?───\n([\s\S]*?)\n\n\/\/ ─── Test:.*?───\n([\s\S]*)$/);
  if (m) {
    result.pages = m[1].trimEnd();
    result.test  = m[2].trimEnd();
  } else {
    result.test = concat;
  }
  return {
    [lay.pageObjectFile]: result.pages,
    [lay.testFile]:       result.test,
  };
}

/**
 * Ensure the project's shared fixtures + base config exist. Idempotent.
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

  writeIfMissing('playwright.config.ts',
`import { defineConfig, devices } from '@playwright/test';
// Load .env (credentials + target URL) so values can be overridden per-environment
// without editing code. The accessors in utils/env.ts also bake working defaults.
import 'dotenv/config';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: 1,
  // Exported e2e suites share ONE app instance and ONE test login. Running them
  // in parallel causes session collisions and flaky timeouts on a shared
  // backend, and cases authored as a sequence may share data. Serial by default
  // for reliable, faithful results; bump once your cases are isolated:
  //   PW_WORKERS=4 npx playwright test
  fullyParallel: false,
  workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : 1,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    // baseURL is baked from the QAAI project's Target URL; override at runtime
    // with QAAI_TARGET_URL=... npx playwright test
    baseURL: process.env.QAAI_TARGET_URL || ${JSON.stringify(baseUrl)},${storageStateUseLine}
    headless: true,
    viewport: { width: 1280, height: 720 },
    screenshot: 'on',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
    // Generous timeouts so a slow real-world app fails on a true defect, not on
    // latency. Tighten for a fast app if you prefer quicker feedback.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
`);

  writeIfMissing('fixtures/test-fixtures.ts',
`import { test as base } from '@playwright/test';

/**
 * Shared fixtures. Add Page Object factories or test data builders here.
 */
export const test = base;
export { expect } from '@playwright/test';
`);

  // utils/env.ts — the ONE credential contract for the whole suite. When the
  // project has a credential profile (configured users, or creds observed in
  // the run), bake the real values as fallbacks AND emit a real .env so the
  // suite runs with zero setup; otherwise emit a clearly-marked placeholder.
  const profile = (opts.credProfile && Array.isArray(opts.credProfile.users))
    ? opts.credProfile : { users: [], hasCreds: false };
  writeIfMissing('utils/env.ts', envContract.renderEnvAccessorTs(profile, { baseUrl }));
  writeIfMissing('.env', envContract.renderDotenv(profile, { targetUrl: baseUrl }));
  writeIfMissing('.env.example', envContract.renderDotenvExample(profile, { targetUrl: baseUrl }));
  writeIfMissing('.gitignore', 'node_modules/\ntest-results/\nplaywright-report/\n.env\n');

  // Lightweight runtime helpers used by generated specs. These provide a
  // consistent, defensive pattern for selecting the first visible locator
  // from a list and for clicking with a small retry/visibility guard. The
  // generator templates may import these to reduce flaky brittle click logic.
  writeIfMissing('utils/test-helpers.ts',
    'import type { Locator, Page } from "@playwright/test";\n\n' +
    'export async function findFirstVisible(candidates: Locator[], timeout = 2000): Promise<Locator | null> {\n' +
    '  for (const loc of candidates) {\n' +
    '    try {\n' +
    '      if (await loc.isVisible({ timeout }).catch(() => false)) return loc;\n' +
    '    } catch (_) {}\n' +
    '  }\n' +
    '  return null;\n' +
    '}\n\n' +
    'export async function safeGoto(page: Page, url: string, opts: { retries?: number; timeout?: number; waitUntil?: "load" | "domcontentloaded" | "networkidle" } = {}) {\n' +
    '  const attempts = Number(opts.retries ?? 3);\n' +
    '  const timeout = Number(opts.timeout ?? 30000);\n' +
    '  const waitUntil = opts.waitUntil ?? "domcontentloaded";\n' +
    '  let lastErr: unknown;\n' +
    '  for (let i = 0; i < attempts; i++) {\n' +
    '    try {\n' +
    '      await page.goto(url, { waitUntil, timeout });\n' +
    '      return;\n' +
    '    } catch (err) {\n' +
    '      lastErr = err;\n' +
    '      if (i < attempts - 1) {\n' +
    '        await page.waitForLoadState("domcontentloaded").catch(() => {});\n' +
    '      }\n' +
    '    }\n' +
    '  }\n' +
    '  throw lastErr;\n' +
    '}\n\n' +
    'export async function safeClick(locator: Locator, opts?: { timeout?: number; clickCount?: number }) {\n' +
    '  const timeout = opts?.timeout ?? 5000;\n' +
    '  const clickOpts: Parameters<Locator["click"]>[0] = { timeout };\n' +
    '  if (opts?.clickCount != null) clickOpts.clickCount = opts.clickCount;\n' +
    '  try {\n' +
    '    await locator.waitFor({ state: "visible", timeout }).catch(() => { throw new Error("locator not visible for click"); });\n' +
    '    await locator.click(clickOpts);\n' +
    '  } catch (err) {\n' +
    '    try {\n' +
    '      await locator.scrollIntoViewIfNeeded();\n' +
    '      await locator.waitFor({ state: "visible", timeout: 1500 });\n' +
    '      await locator.click(clickOpts);\n' +
    '    } catch (err2) {\n' +
    '      throw err2 || err;\n' +
    '    }\n' +
    '  }\n' +
    '}\n\n' +
    '// Handles two call forms:\n' +
    '//   clickFirstVisible(locator)                    — single-locator (sanitizer .click() replacement)\n' +
    '//   clickFirstVisible(locator, { clickCount: 2 }) — with click options (sanitizer .dblclick() replacement)\n' +
    '//   clickFirstVisible(page, [loc1, loc2])          — multi-candidate (legacy)\n' +
    'export async function clickFirstVisible(\n' +
    '  locatorOrPage: Locator | Page,\n' +
    '  selectorsArgOrOpts?: (string | Locator)[] | { timeout?: number; clickCount?: number },\n' +
    '  timeout = 2000\n' +
    '): Promise<void> {\n' +
    '  if (Array.isArray(selectorsArgOrOpts)) {\n' +
    '    const page = locatorOrPage as Page;\n' +
    '    const candidates: Locator[] = selectorsArgOrOpts.map((s) => (typeof s === "string" ? page.locator(s) : s));\n' +
    '    const found = await findFirstVisible(candidates, timeout);\n' +
    '    if (!found) throw new Error("no visible selector found from candidates");\n' +
    '    await safeClick(found);\n' +
    '  } else {\n' +
    '    const opts = (selectorsArgOrOpts && !Array.isArray(selectorsArgOrOpts))\n' +
    '      ? selectorsArgOrOpts as { timeout?: number; clickCount?: number }\n' +
    '      : {};\n' +
    '    await safeClick(locatorOrPage as Locator, { timeout: opts.timeout ?? timeout, clickCount: opts.clickCount });\n' +
    '  }\n' +
    '}'
  );

  writeIfMissing('package.json', JSON.stringify({
    name: 'qaai-playwright-tests',
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
      typescript: '^5.4.0',
    },
  }, null, 2) + '\n');

  writeIfMissing('tsconfig.json', JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'commonjs',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      moduleResolution: 'node',
      resolveJsonModule: true,
    },
    include: ['tests/**/*', 'pages/**/*', 'fixtures/**/*', 'utils/**/*'],
  }, null, 2) + '\n');

  return created;
}

// ── Journey codegen (P1) — a dependsOnIds chain → ONE POM artifact:
// locators/ + pages/ + tests/. Uses persisted ReplayIR, not the legacy flat LLM
// journey prompt, so dependency journeys follow the same POM architecture as
// certified ReplayIR exports.
function generateJourney(opts) { return journeyLib.generatePlaywrightPomJourney({ ...opts, lang: 'ts' }); }
function layoutJourney(scenario, journeyCases) { return journeyLib.journeyLayout(scenario, journeyCases, 'ts'); }
function splitFilesJourney(content, lay) { return journeyLib.splitFilesJourney(content, lay); }

module.exports = { generate, layout, splitFiles, ensureProjectShell, parseGeneratedJson, SYSTEM_PROMPT, generateJourney, layoutJourney, splitFilesJourney };
