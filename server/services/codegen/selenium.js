'use strict';

/**
 * Framework: selenium-java (Selenium 4 + JUnit 5 + Maven, Page Object Model).
 */

const SYSTEM_PROMPT = `You are a senior SDET writing Selenium 4 + Java (Maven, JUnit 5) tests with the Page Object Model.

Given a scenario, a test case, an action plan, and a target URL, emit TWO Java files
as a single JSON object:

{
  "testClass": "package: com.qaai.<module>\\nfile: src/test/java/com/qaai/<module>/<Name>Test.java\\ncontent: <Java>",
  "pageObject": "package: com.qaai.pages\\nfile: src/main/java/com/qaai/pages/<Module>Page.java\\ncontent: <Java>"
}

Strict rules for the test class:
- import org.junit.jupiter.api.{Test, BeforeEach, AfterEach, DisplayName}
- import org.openqa.selenium.WebDriver
- import org.openqa.selenium.chrome.ChromeDriver
- import static org.junit.jupiter.api.Assertions.*
- Use @BeforeEach setUp() and @AfterEach tearDown(); call driver.quit() in teardown
- All assertions via JUnit (assertTrue, assertEquals, etc.) — no AssertJ unless explicitly added
- No Thread.sleep — use WebDriverWait with ExpectedConditions
- @DisplayName describing the scenario+case clearly

Strict rules for the Page Object class:
- All locators live HERE as private By fields, never in the test class
- Each public method represents a behaviour ("login(email, password)", "addToCart()")
- Prefer By.cssSelector, By.id; fall back to By.xpath only when necessary
- Constructor takes WebDriver and stores it
- Use WebDriverWait for sync; never Thread.sleep

Common rules:
- No credentials in source — use System.getenv("VARNAME")
- No System.out.println in committed tests

Output ONLY the JSON object — no markdown fences, no other text.`;

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
    maxTokens: 4000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMsg }],
  });
  const text = (resp.content?.[0]?.text || '').trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```\s*$/i, '');

  try {
    const parsed = JSON.parse(text);
    const stripPath = (s) => String(s || '').replace(/^(?:package|file):\s*[^\n]+\n/gm, '').replace(/^content:\s*/m, '');
    return `// ─── Test class ───\n${stripPath(parsed.testClass)}\n\n// ─── Page Object ───\n${stripPath(parsed.pageObject)}\n`;
  } catch (_) {
    return text;
  }
}

function layout(scenario, testCase) {
  const moduleTitle = scenario.module.charAt(0).toUpperCase() + scenario.module.slice(1);
  const className = (testCase.name || 'Test')
    .replace(/[^a-zA-Z0-9 ]+/g, '')
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
    .slice(0, 50) || 'Test';
  return {
    primaryFile: `src/test/java/com/qaai/${scenario.module}/${className}Test.java`,
    extras: [`src/main/java/com/qaai/pages/${moduleTitle}Page.java`],
  };
}

module.exports = { generate, layout, SYSTEM_PROMPT };
