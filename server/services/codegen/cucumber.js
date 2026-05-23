'use strict';

/**
 * Framework: cucumber-playwright (BDD / Gherkin .feature + step definitions).
 */

const SYSTEM_PROMPT = `You are a senior SDET writing Cucumber (BDD) tests with Playwright.

Given a scenario, a test case, an action plan, and a target URL, emit TWO files
as a single JSON object:

{
  "feature": "path: features/<module>/<slug>.feature\\ncontent: <Gherkin>",
  "steps":   "path: step-definitions/<module>.steps.ts\\ncontent: <TypeScript>"
}

Strict rules for the .feature file:
- Tag every scenario with @<priority> (e.g. @P0) and @<category> (e.g. @negative)
- Feature: <module-name> high-level description
- Background only if shared setup applies
- Use Given/When/Then/And appropriately
- Use Scenario Outline + Examples for parameterised cases

Strict rules for the .steps.ts file:
- import { Given, When, Then } from '@cucumber/cucumber'
- import { expect } from '@playwright/test'
- World context provides 'this.page' (Playwright Page)
- Use getByRole/getByTestId locators — never bare CSS where avoidable
- No page.waitForTimeout, no console.log, no debugger
- No credentials inline — use process.env.<NAME>

Output ONLY the JSON object — no markdown fences, no other text.
Use the "primary" key to indicate which file is the primary spec for governance review.`;

async function generate({ provider, apiKey, model, scenario, testCase, actionPlan, targetUrl }) {
  const userMsg = JSON.stringify({
    targetUrl,
    scenario: { name: scenario.name, module: scenario.module, priority: scenario.priority, category: scenario.category, rationale: scenario.rationale },
    testCase: { name: testCase.name, type: testCase.type, assertions: testCase.assertions },
    actionPlan,
  }, null, 2);

  const resp = await provider.complete({
    apiKey,
    model,
    maxTokens: 3000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMsg }],
  });
  const text = (resp.content?.[0]?.text || '').trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```\s*$/i, '');

  // Try to JSON-parse; if Claude returned just the feature file, fall back to that.
  try {
    const parsed = JSON.parse(text);
    // Concatenate for review/lint — feature first, steps second.
    return `# ─── ${parsed.feature?.split('\n')[0] || 'feature'} ───\n${stripPath(parsed.feature)}\n\n` +
           `// ─── ${parsed.steps?.split('\n')[0] || 'step definitions'} ───\n${stripPath(parsed.steps)}\n`;
  } catch (_) {
    return text;
  }
}

function stripPath(s) {
  if (!s) return '';
  return String(s).replace(/^path:\s*[^\n]+\ncontent:\s*/m, '');
}

function layout(scenario, testCase) {
  const slug = (testCase.id || 'tc').replace(/[^a-zA-Z0-9_-]/g, '_');
  return {
    primaryFile: `features/${scenario.module}/${slug}.feature`,
    extras: [`step-definitions/${scenario.module}.steps.ts`],
  };
}

module.exports = { generate, layout, SYSTEM_PROMPT };
