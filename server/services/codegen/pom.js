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

const SYSTEM_PROMPT = `You are a senior SDET writing a Playwright TypeScript test using a strict Page Object Model.

You MUST output a single JSON object with two top-level keys: "pageObject" and "test".
Each value has shape { "path": "<relative/path/from/project-root>", "content": "<full file contents>" }.

Strict rules for the Page Object (pageObject.content):
- One TypeScript class named <Module>Page (PascalCase)
- Constructor takes a Playwright Page and stores it as readonly
- ALL locators are private readonly fields on the class — never inline in tests
- Each PUBLIC method models a behaviour ("login(email, password)", "addToCart()")
- Use resilient locators: page.getByRole, page.getByTestId, page.getByLabel — NOT raw CSS where avoidable
- No page.waitForTimeout — use locator.waitFor / expect.toBeVisible({timeout})

Strict rules for the test (test.content):
- import { test, expect } from '@playwright/test'
- import the Page Object from a relative path
- Each test() instantiates the Page Object and calls its methods
- Three-layer assertions where applicable: UI (toBeVisible/toHaveText) + DOM attribute checks + a page.waitForResponse() for any backend call
- No credentials in source — use process.env.<NAME>
- No console.log, no debugger, no test.only/skip

Output ONLY a single JSON object with "pageObject" and "test". NO markdown fences. NO explanation.`;

function moduleClassName(module) {
  return (module || 'app')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

function layout(scenario, testCase) {
  const slug = (testCase.id || 'tc').replace(/[^a-zA-Z0-9_-]/g, '_');
  const moduleSlug = (scenario.module || 'app').toLowerCase().replace(/[^a-z0-9]/g, '-');
  const cls = moduleClassName(scenario.module);
  return {
    primaryFile: `tests/${moduleSlug}/${slug}.spec.ts`,
    extras: [`pages/${moduleSlug}/${cls}Page.ts`],
    pageObjectFile: `pages/${moduleSlug}/${cls}Page.ts`,
    testFile: `tests/${moduleSlug}/${slug}.spec.ts`,
    className: `${cls}Page`,
    moduleSlug,
  };
}

async function generate({ provider, apiKey, model, scenario, testCase, actionPlan, targetUrl }) {
  const lay = layout(scenario, testCase);
  const userMsg = JSON.stringify({
    targetUrl,
    scenario: { name: scenario.name, module: scenario.module, category: scenario.category, rationale: scenario.rationale },
    testCase: { name: testCase.name, type: testCase.type, assertions: testCase.assertions, steps: testCase.steps || [] },
    actionPlan,
    expectedFiles: {
      pageObject: { path: lay.pageObjectFile, className: lay.className },
      test: { path: lay.testFile },
    },
  }, null, 2);

  const resp = await provider.complete({
    apiKey,
    model,
    maxTokens: 4000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMsg }],
  });
  const text = (resp.content?.[0]?.text || '').trim()
    .replace(/^```(?:json)?\n?/i, '').replace(/\n?```\s*$/i, '');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Treat the whole output as the test file content; no separate page object.
    return text;
  }

  // Concatenated view (for the Reports → Generated spec panel + lint).
  const concat =
    `// ─── Page Object: ${parsed.pageObject?.path || lay.pageObjectFile} ───\n` +
    `${parsed.pageObject?.content || ''}\n\n` +
    `// ─── Test: ${parsed.test?.path || lay.testFile} ───\n` +
    `${parsed.test?.content || ''}\n`;

  // Attach the raw files map so the caller can write each separately.
  // Use a String wrapper so we can attach the property.
  const result = new String(concat);
  result.__files = {
    [parsed.pageObject?.path || lay.pageObjectFile]: parsed.pageObject?.content || '',
    [parsed.test?.path || lay.testFile]: parsed.test?.content || '',
  };
  // Return a primitive-friendly string but with the __files attached via valueOf shenanigans.
  // To keep the API simple, return a real string AND export a getFiles helper.
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
 */
function ensureProjectShell(rootDir) {
  const created = [];
  const writeIfMissing = (rel, content) => {
    const full = path.join(rootDir, rel);
    if (fs.existsSync(full)) return;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    created.push(rel);
  };

  writeIfMissing('playwright.config.ts',
`import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 1,
  workers: process.env.CI ? 2 : 4,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: process.env.QAAI_TARGET_URL || 'https://demo.playwright.dev/todomvc',
    headless: true,
    viewport: { width: 1280, height: 720 },
    screenshot: 'on',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
    actionTimeout: 8_000,
    navigationTimeout: 15_000,
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

  writeIfMissing('utils/env.ts',
`/**
 * Centralised access to environment-based test data. Never inline credentials.
 */
export const TEST_EMAIL    = process.env.TEST_EMAIL    ?? 'demo@example.com';
export const TEST_PASSWORD = process.env.TEST_PASSWORD ?? 'changeme';
export const BASE_URL      = process.env.QAAI_TARGET_URL ?? 'https://demo.playwright.dev/todomvc';
`);

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

module.exports = { generate, layout, splitFiles, ensureProjectShell, SYSTEM_PROMPT };
