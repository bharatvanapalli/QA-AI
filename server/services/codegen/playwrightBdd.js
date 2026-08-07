'use strict';

/**
 * Framework: playwright-bdd (Cucumber-style BDD on top of Playwright via the
 * `playwright-bdd` package — https://github.com/vitalets/playwright-bdd).
 *
 * Per test case it emits TWO files:
 *   - features/<module>/<case>.feature   Gherkin scenario
 *   - steps/<case>.steps.ts              Step definitions via createBdd()
 *
 * ensureProjectShell() writes a complete project: playwright.config.ts wired
 * with defineBddConfig, package.json (playwright-bdd + @playwright/test),
 * tsconfig, README, .gitignore. Run with `npm test` (→ bddgen && playwright
 * test). Step definitions get Playwright's `page` fixture, so the full
 * Playwright power (web-first assertions, traces) is available inside BDD.
 *
 * Step files are emitted ONE PER CASE (unique slug) so concurrent cases never
 * overwrite each other. playwright-bdd matches steps to features by step text
 * globally — if two selected cases declare the IDENTICAL step sentence you may
 * get a duplicate-step error; merge those steps by hand (standard BDD hygiene,
 * noted in the README).
 */

const fs = require('fs');
const path = require('path');
const { recoverTwo } = require('./_recoverJson');
const envContract = require('./_env');
const fidelity = require('./_fidelity');
const locators = require('./_locators');
const { authPromptBlock } = require('./_login');

const SYSTEM_PROMPT = `You are a senior SDET writing BDD tests with the "playwright-bdd" package (Cucumber Gherkin running on Playwright's test runner).

You MUST output a single JSON object with two top-level keys: "feature" and "steps".
Each value has shape { "path": "<relative/path/from/project-root>", "content": "<full file contents>" }.

FEATURE (feature.content) — Gherkin:
- Feature: <module> — a one-line description.
- ONE Scenario that reproduces this test case (use Scenario Outline + Examples only if the action plan genuinely repeated with different data).
- Given / When / Then / And steps in plain business language. Keep step sentences specific so they don't collide with other scenarios.
- Tag the scenario with @<category> if a category is provided.

STEPS (steps.content) — TypeScript using playwright-bdd:
- import { createBdd } from 'playwright-bdd';
- import { expect } from '@playwright/test';
- const { Given, When, Then } = createBdd();
- Implement EVERY step in the feature, in order. Each step fn receives Playwright fixtures: Given('...', async ({ page }) => { ... }).
- FIRST STATEMENT INVARIANT: The step function that implements the FIRST Given step (which establishes the starting page) MUST have \`await page.goto('/path')\` as its very first \`await\`. Use the URL from the browser_navigate action if present in the action plan; default to \`await page.goto('/')\` if no navigate action exists. NEVER call getByRole / getByText / locator interactions before navigating — the page is blank until goto() fires and every locator will timeout.
- Navigation: await page.goto('/path') against the configured baseURL — never hard-code the origin.
- Use resilient locators: page.getByRole / getByTestId. Do NOT use page.getByLabel unless the field has a real associated <label> — login username/password usually have only a name/placeholder, so locate those with page.locator("input[name='...']"), page.getByPlaceholder(...), or page.getByRole('textbox', { name }).
- Assertions: web-first expect(...) — toHaveURL, toHaveText/toContainText, toBeVisible, toHaveValue, toHaveCount, toBeEnabled/Checked — matched to the declared assertion. They auto-retry; no manual waits.
- NEVER use page.waitForTimeout. NEVER use page.waitForResponse with a guessed URL/status (it hangs when wrong) — wait for the visible outcome or page.waitForURL instead. No console.log, no test.only.
- One short comment above each step body describing intent.
- CREDENTIALS: import the shared env module — import { QAAI_USERNAME, QAAI_PASSWORD } from '../utils/env'; — and use those. NEVER read process.env directly, NEVER invent env-var names, NEVER use a ?? '' empty fallback.

DATA DEPENDENCIES — when testCase.dependsOnIds is non-empty:
- Replay any declared prerequisite creation/setup before the dependent actions and reuse the same values. Preserve every approved Gherkin step and every step implementation.
- Never emit test.skip/test.fixme, an @skip tag, a conditional early return, or omit a dependent step because prerequisite data is absent.
- If the approved evidence cannot safely recreate the prerequisite, keep the full scenario source and make the prerequisite check an explicit failing expect assertion whose message starts "QAAI_PREREQUISITE_MISSING:".

FAITHFUL ONLY: implement exactly the steps the action plan actually performed and the assertions actually declared. Do not invent extra scenarios, steps, or data.

Output ONLY the JSON object — no markdown fences, no other text.`;

function slug(s, fallback) {
  const out = String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return out || fallback;
}

function layout(scenario, testCase) {
  const moduleSlug = slug(scenario.module, 'app');
  const caseSlug = slug(testCase.name, (testCase.id || 'case').slice(0, 8));
  return {
    primaryFile: `features/${moduleSlug}/${caseSlug}.feature`,
    extras: [`steps/${caseSlug}.steps.ts`],
    featureFile: `features/${moduleSlug}/${caseSlug}.feature`,
    stepsFile: `steps/${caseSlug}.steps.ts`,
    // testFile points at the steps so the lint/preview picks the code file.
    testFile: `steps/${caseSlug}.steps.ts`,
    moduleSlug,
    caseSlug,
  };
}

async function generate({ provider, apiKey, model, scenario, testCase, actionPlan, targetUrl, credProfile, authInfo }) {
  const lay = layout(scenario, testCase);
  // Steps live in steps/<case>.steps.ts → the shared env module is at ../utils/env.
  let system = SYSTEM_PROMPT;
  if (credProfile) system += `\n\n${envContract.promptBlock(credProfile, { lang: 'ts', accessorImportPath: '../utils/env' })}`;
  if (authInfo && authInfo.authImportPath) system += `\n\n${authPromptBlock(authInfo.authImportPath, 'ts')}`;
  system += `\n\n${fidelity.fidelityBlock({ lang: 'ts' })}`;
  system += `\n\n${locators.locatorPromptBlock({ lang: 'ts' })}`;
  const declaredAssertions = fidelity.declaredAssertionsFor(testCase);
  const userMsg = JSON.stringify({
    targetUrl,
    caseStatus: actionPlan && actionPlan.caseStatus,
    scenario: { name: scenario.name, module: scenario.module, category: scenario.category, rationale: scenario.rationale },
    testCase: { name: testCase.name, type: testCase.type, dependsOnIds: testCase.dependsOnIds || [], declaredAssertions, assertionsHint: testCase.assertions, steps: testCase.steps || [] },
    assertionDigest: fidelity.assertionDigest(declaredAssertions),
    resolvedLocators: locators.manifestDigest(actionPlan && actionPlan.locatorManifest),
    actionPlan,
    expectedFiles: { feature: { path: lay.featureFile }, steps: { path: lay.stepsFile } },
  }, null, 2);

  const resp = await provider.complete({ apiKey, model, maxTokens: 4000, system, messages: [{ role: 'user', content: userMsg }] });
  const rawText = (resp.content?.[0]?.text || '').trim();
  const parsed = recoverTwo(rawText, 'feature', 'steps');

  if (!parsed || (!parsed.aContent && !parsed.bContent)) {
    const reason = parsed === null ? 'model did not return the expected { feature, steps } JSON object'
      : 'model returned JSON but neither feature.content nor steps.content was present';
    return (
      `# ─── Feature: ${lay.featureFile} ───\n` +
      `# QAAI CODEGEN FAILED — ${reason}. Re-merge from Governance to regenerate.\n` +
      rawText.split('\n').map((l) => `#   ${l}`).join('\n') + '\n\n' +
      `// ─── Steps: ${lay.stepsFile} ───\n` +
      `// QAAI CODEGEN FAILED — see feature file header above.\n`
    );
  }

  // Post-generate validation — catch crashes before files reach disk.
  const validationErrors = [];

  // 1. Leaked MCP tool name in steps
  if (parsed.bContent && /\bbrowser_(?:click|fill_form|navigate|scroll|snapshot|type)\s*[({]/.test(parsed.bContent)) {
    validationErrors.push('MCP tool name (browser_click etc.) leaked into steps TypeScript');
  }
  // 2. Raw JSON envelope mistakenly written as source
  if (parsed.bContent && /^\s*\{[\s\S]{0,80}["'](feature|steps)["']\s*:/.test(parsed.bContent)) {
    validationErrors.push('Raw codegen JSON envelope written as steps source instead of split into real code');
  }
  // 3. No Given/When/Then step definitions at all
  if (parsed.bContent && !/\b(?:Given|When|Then)\s*\(/.test(parsed.bContent)) {
    validationErrors.push('Steps file contains no Given()/When()/Then() step definitions');
  }
  // 4. Feature step count vs step definition count (binding mismatch)
  if (parsed.aContent && parsed.bContent) {
    const featureStepCount = (parsed.aContent.match(/^\s*(?:Given|When|Then|And|But)\s+/mg) || []).length;
    const defCount = (parsed.bContent.match(/\b(?:Given|When|Then|And)\s*\(/g) || []).length;
    if (featureStepCount > 0 && defCount < featureStepCount) {
      validationErrors.push(`Step binding mismatch: feature has ${featureStepCount} step(s) but steps file defines only ${defCount} step definition(s)`);
    }
  }

  if (validationErrors.length > 0) {
    const summary = validationErrors.map((e, i) => `// ${i + 1}. ${e}`).join('\n');
    const stubSteps = `// QAAI CODEGEN VALIDATION FAILED — ${validationErrors.length} error(s):\n${summary}\n// Re-export from Governance to regenerate. Raw output preserved:\n` +
      (parsed.bContent || '').split('\n').map((l) => `// ${l}`).join('\n') + '\n';
    parsed.bContent = stubSteps;
  }

  return (
    `# ─── Feature: ${parsed.aPath || lay.featureFile} ───\n` +
    `${parsed.aContent || ''}\n\n` +
    `// ─── Steps: ${parsed.bPath || lay.stepsFile} ───\n` +
    `${parsed.bContent || ''}\n`
  );
}

function splitFiles(concat, lay) {
  const m = concat.match(/^# ─── Feature:.*?───\n([\s\S]*?)\n\n\/\/ ─── Steps:.*?───\n([\s\S]*)$/);
  if (m) {
    return { [lay.featureFile]: m[1].trimEnd(), [lay.stepsFile]: m[2].trimEnd() };
  }
  // Couldn't split (e.g. annotated rerun header prepended) — write as feature.
  return { [lay.featureFile]: concat };
}

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

  writeIfMissing('playwright.config.ts',
`import { defineConfig, devices } from '@playwright/test';
import { defineBddConfig } from 'playwright-bdd';
// Load .env (credentials + target URL); utils/env.ts also bakes working defaults.
import 'dotenv/config';

// playwright-bdd turns features/ + steps/ into runnable Playwright tests.
const testDir = defineBddConfig({
  features: 'features/**/*.feature',
  steps: 'steps/**/*.ts',
});

export default defineConfig({
  testDir,
  timeout: 60_000,
  retries: 1,
  // Serial by default: shared app instance + one login; bump with PW_WORKERS=4.
  fullyParallel: false,
  workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : 1,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    // Baked from the QAAI project Target URL; override with QAAI_TARGET_URL=...
    baseURL: process.env.QAAI_TARGET_URL || ${JSON.stringify(baseUrl)},
    headless: true,
    viewport: { width: 1280, height: 720 },
    screenshot: 'on',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
`);

  writeIfMissing('package.json', JSON.stringify({
    name: 'qaai-playwright-bdd-tests',
    version: '1.0.0',
    private: true,
    scripts: {
      // bddgen materialises the .feature files into Playwright tests, then we run them.
      test: 'bddgen && playwright test',
      'test:ui': 'bddgen && playwright test --ui',
      report: 'playwright show-report',
    },
    devDependencies: {
      '@playwright/test': '^1.48.0',
      'playwright-bdd': '^8.0.0',
      dotenv: '^16.4.5',
      typescript: '^5.4.0',
    },
  }, null, 2) + '\n');

  // utils/env.ts — the ONE credential contract, shared by every step file. Bakes
  // real values + emits a real .env so the suite runs with zero setup.
  const profile = (opts.credProfile && Array.isArray(opts.credProfile.users))
    ? opts.credProfile : { users: [], hasCreds: false };
  writeIfMissing('utils/env.ts', envContract.renderEnvAccessorTs(profile, { baseUrl }));
  writeIfMissing('.env', envContract.renderDotenv(profile, { targetUrl: baseUrl }));
  writeIfMissing('.env.example', envContract.renderDotenvExample(profile, { targetUrl: baseUrl }));

  writeIfMissing('tsconfig.json', JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'commonjs', strict: true, esModuleInterop: true,
      skipLibCheck: true, moduleResolution: 'node', resolveJsonModule: true,
    },
    include: ['features/**/*', 'steps/**/*'],
  }, null, 2) + '\n');

  writeIfMissing('.gitignore', 'node_modules/\ntest-results/\nplaywright-report/\n.features-gen/\n.env\n');

  writeIfMissing('README.md',
`# QAAI Playwright BDD suite

Cucumber-style BDD running on Playwright via the \`playwright-bdd\` package.
Open in VS Code and run — no edits required.

## Run

\`\`\`bash
npm install
npx playwright install chromium
npm test          # = bddgen && playwright test
\`\`\`

Base URL (\`${baseUrl}\`) is baked into playwright.config.ts. Override:

\`\`\`bash
QAAI_TARGET_URL=https://staging.example.com npm test
\`\`\`

## Layout

\`\`\`
features/   Gherkin .feature files (one per scenario)
steps/      Step definitions (createBdd()), one file per scenario
playwright.config.ts   defineBddConfig + Playwright config
\`\`\`

Note: step definitions match by step text globally. If two scenarios declare
the IDENTICAL step sentence, merge those step functions into one file to avoid
a duplicate-step error.
`);

  return created;
}

module.exports = { generate, layout, splitFiles, ensureProjectShell, SYSTEM_PROMPT };
