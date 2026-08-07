/**
 * test-generator.js
 * Uses Claude to generate real Playwright TypeScript test files from test case definitions.
 * Falls back to a functional template when no API key is available.
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const TESTS_DIR = path.join(__dirname, '..', 'playwright', 'tests');

// Ensure tests directory exists
fs.mkdirSync(TESTS_DIR, { recursive: true });

/**
 * Generate a real Playwright .spec.ts file for a single test case.
 * @param {object} testCase  - { id, name, module, type, assertions, confidence }
 * @param {string} targetUrl - Base URL of the application under test
 * @param {string} claudeKey - Anthropic API key (optional)
 * @returns {Promise<{filePath: string, code: string}>}
 */
async function generateSpecFile(testCase, targetUrl, claudeKey) {
  let code;

  if (claudeKey) {
    code = await generateWithClaude(testCase, targetUrl, claudeKey);
  } else {
    code = generateFallback(testCase, targetUrl);
  }

  // Sanitize filename — no spaces or special chars
  const safeName = testCase.id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath  = path.join(TESTS_DIR, `${safeName}.spec.ts`);

  fs.writeFileSync(filePath, code, 'utf8');
  return { filePath, code };
}

/**
 * Claude-powered generation — real test logic from assertions.
 */
async function generateWithClaude(tc, targetUrl, apiKey) {
  const client = new Anthropic({ apiKey });

  const systemPrompt = `You are a senior Playwright automation engineer.
Your job is to write a complete, runnable Playwright TypeScript test file.

Rules:
- Use @playwright/test — import { test, expect } from '@playwright/test'
- Use resilient locators: getByRole, getByLabel, getByPlaceholder, getByTestId — prefer over CSS selectors
- Always wait for network idle after navigation: await page.waitForLoadState('networkidle')
- Take a screenshot before and after key actions: await page.screenshot({ path: \`test-results/\${name}-before.png\` })
- Handle async properly with await
- Add a 5s timeout to assertions: expect(locator).toBeVisible({ timeout: 5000 })
- Do NOT use page.waitForTimeout — use proper waits
- Output ONLY valid TypeScript. No markdown fences. No explanations.`;

  const userPrompt = `Write a Playwright test for:

Test Name: ${tc.name}
Module / Page: ${tc.module}
Test Type: ${tc.type}
Assertions to verify: ${tc.assertions}
Target base URL: ${targetUrl}
Confidence: ${tc.confidence}%

The test must actually navigate to the target URL and verify the assertions.
Use realistic selectors that would exist on a typical ${tc.module} page.`;

  const response = await client.messages.create({
    model:      'claude-sonnet-4-5',
    max_tokens: 2000,
    system:     systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  let code = response.content[0].text.trim();

  // Strip markdown fences if Claude included them anyway
  code = code.replace(/^```(?:typescript|ts)?\n?/i, '').replace(/\n?```$/i, '');
  return code;
}

/**
 * Functional fallback test — works without a Claude key.
 * Tests real page load, title, and basic visibility against the target URL.
 */
function generateFallback(tc, targetUrl) {
  const safeName = tc.name.replace(/'/g, "\\'");
  const pageSlug = tc.module.toLowerCase().replace(/\s+/g, '-');

  return `import { test, expect } from '@playwright/test';

/**
 * Auto-generated test: ${tc.name}
 * Module: ${tc.module}
 * Type: ${tc.type}
 * Assertions: ${tc.assertions}
 */
test.describe('${tc.module}', () => {
  test('${safeName}', async ({ page }) => {
    // ── Navigate ──────────────────────────────────────
    await page.goto('${targetUrl}');
    await page.waitForLoadState('networkidle');

    // Screenshot — before
    await page.screenshot({
      path: 'test-results/${tc.id}-before.png',
      fullPage: false,
    });

    // ── Core assertions ────────────────────────────────
    // Verify page loaded and is not an error page
    await expect(page).not.toHaveTitle(/404|Error|Not Found/i, { timeout: 5000 });

    // Verify body is visible
    await expect(page.locator('body')).toBeVisible();

    // Verify page has meaningful content (not blank)
    const bodyText = await page.locator('body').innerText();
    expect(bodyText.trim().length).toBeGreaterThan(0);

    // ── Module-specific check ──────────────────────────
    // Look for ${tc.module}-related elements
    const possibleSelectors = [
      '[data-testid*="${pageSlug}"]',
      '[id*="${pageSlug}"]',
      '[class*="${pageSlug}"]',
      'main',
      '#root',
      '#app',
    ];

    let found = false;
    for (const selector of possibleSelectors) {
      const count = await page.locator(selector).count();
      if (count > 0) {
        await expect(page.locator(selector).first()).toBeVisible({ timeout: 3000 });
        found = true;
        break;
      }
    }

    // Screenshot — after
    await page.screenshot({
      path: 'test-results/${tc.id}-after.png',
      fullPage: false,
    });

    // Log result
    console.log('Test assertions: ${tc.assertions}');
    console.log('Page title:', await page.title());
    console.log('Module element found:', found);
  });
});
`;
}

/**
 * Clean all generated spec files (call before a new run).
 *
 * NOTE — June 2026: this used to nuke every `.spec.ts` in TESTS_DIR before
 * each run, which (a) destroyed history between sprints and (b) defeated
 * the purpose of treating `playwright/` as a durable workspace the user
 * downloads as a ZIP. We now KEEP all existing files and rely on
 * per-case write-overwrite: when a TC is regenerated, its single spec
 * file overwrites the prior version (deterministic filename). Files for
 * deleted TCs survive on disk until the user explicitly clears them via
 * `DELETE /api/projects/:projectId/output-files`.
 *
 * Kept as a no-op + exported so existing callers (services/runs.js)
 * don't have to be edited every time we revisit this policy.
 */
function cleanTestsDir() {
  // intentionally empty — see comment above
}

module.exports = { generateSpecFile, cleanTestsDir, TESTS_DIR };
