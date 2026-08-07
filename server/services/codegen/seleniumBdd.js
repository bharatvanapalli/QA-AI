'use strict';

/**
 * Framework: selenium-bdd (Cucumber-JVM + TestNG + Selenium 4 + Maven).
 *
 * Per test case it emits TWO files:
 *   - src/test/resources/features/<module>/<case>.feature   Gherkin scenario
 *   - src/test/java/com/qaai/steps/<Case>Steps.java          Step definitions
 *
 * ensureProjectShell() writes the complete Maven scaffold so `mvn test` runs
 * with no edits: pom.xml (cucumber-java + cucumber-testng + selenium + testng),
 * a TestNG cucumber runner, Hooks (driver lifecycle + failure screenshot), and
 * a thread-safe DriverManager. Selenium 4 auto-resolves the ChromeDriver
 * (Selenium Manager) — only JDK 17 + Chrome are needed.
 *
 * Step files are ONE PER CASE (unique class name) so cases don't overwrite each
 * other. Cucumber-JVM matches steps by text globally; identical step sentences
 * across two scenarios cause a DuplicateStepDefinition error — merge by hand
 * (standard BDD hygiene, noted in the README).
 */

const fs = require('fs');
const path = require('path');
const { recoverTwo } = require('./_recoverJson');
const envContract = require('./_env');
const fidelity = require('./_fidelity');
const locators = require('./_locators');
const { authPromptBlock } = require('./_login');

const BASE_PACKAGE = 'com.qaai';
const PKG_PATH = 'com/qaai';

const SYSTEM_PROMPT = `You are a senior SDET writing BDD tests with Cucumber-JVM + TestNG + Selenium 4 (Java, Maven, Page Object optional).

You MUST output a single JSON object with two top-level keys: "feature" and "steps".
Each value has shape { "path": "<relative/path/from/project-root>", "content": "<full file contents>" }.

FEATURE (feature.content) — Gherkin:
- Feature: <module> — one-line description.
- ONE Scenario reproducing this test case (Scenario Outline + Examples only if the action plan genuinely repeated with different data).
- Given / When / Then / And in plain business language; keep sentences specific so they don't collide with other scenarios.
- Tag with @<category> if a category is provided.

STEPS (steps.content) — Java, package ${BASE_PACKAGE}.steps:
- package ${BASE_PACKAGE}.steps;
- import io.cucumber.java.en.{Given, When, Then, And};
- import static org.testng.Assert.*;
- import org.openqa.selenium.*; import org.openqa.selenium.support.ui.{WebDriverWait, ExpectedConditions}; import java.time.Duration;
- import ${BASE_PACKAGE}.util.DriverManager;  import ${BASE_PACKAGE}.util.Config;
- public class <Case>Steps { } — the class name is supplied by the caller.
- Get the browser via WebDriver driver = DriverManager.getDriver(); base URL via DriverManager.getBaseUrl(). Do NOT create or quit the driver — Hooks handle the lifecycle + failure screenshot.
- Implement EVERY step in the feature, in order, with @Given/@When/@Then annotations whose regex/text matches the Gherkin exactly.
- FIRST STATEMENT INVARIANT: In the step method annotated with @Given that starts the scenario (the one that establishes the starting page), the FIRST statement MUST be driver.get(DriverManager.getBaseUrl() + "/path"). NEVER call findElement / wait / click before driver.get() — the browser has no page loaded and every findElement will throw NoSuchElementException immediately.
- Navigation: driver.get(DriverManager.getBaseUrl() + "/path").
- Waits: new WebDriverWait(driver, Duration.ofSeconds(15)) + ExpectedConditions — NEVER Thread.sleep.
- Locators: prefer By.cssSelector / By.id; By.xpath only when unavoidable. LOGIN fields: By.name("username") / By.name("password") / By.cssSelector("input[name='password']") — never a brittle absolute XPath.
- Assertions: TestNG Assert.* with a message argument, matched to the declared assertion.
- One short comment per step body describing intent.
- CREDENTIALS: read from the shared Config — Config.username() and Config.password(). It already falls back to the project's configured values. NEVER call System.getenv with an invented name, NEVER hardcode credentials, NEVER use an empty-string fallback.

DATA DEPENDENCIES — when testCase.dependsOnIds is non-empty:
- Replay any declared prerequisite creation/setup before the dependent actions and reuse the same values. Preserve every approved Gherkin step and Java step definition.
- Never use SkipException, @Ignore/@Disabled, a conditional early return, or omit dependent code because prerequisite data is absent.
- If the approved evidence cannot safely recreate the prerequisite, keep the complete scenario source and make the prerequisite check fail explicitly with a TestNG assertion whose message starts "QAAI_PREREQUISITE_MISSING:".

FAITHFUL ONLY: implement exactly the steps the action plan performed and the assertions declared. Do not invent scenarios, steps, or data.

Output ONLY the JSON object — no markdown fences, no other text.`;

function slug(s, fallback) {
  const out = String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return out || fallback;
}

function javaIdent(s, fallback) {
  const parts = String(s || '').replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  let id = parts.join('').slice(0, 60);
  if (!id || !/^[A-Za-z]/.test(id)) id = (fallback || 'Case') + id;
  return id || (fallback || 'Case');
}

function layout(scenario, testCase) {
  const moduleSlug = slug(scenario.module, 'app');
  const caseSlug = slug(testCase.name, (testCase.id || 'case').slice(0, 8));
  let stepsClass = javaIdent(testCase.name, 'Case');
  if (!stepsClass.endsWith('Steps')) stepsClass += 'Steps';
  return {
    primaryFile: `src/test/resources/features/${moduleSlug}/${caseSlug}.feature`,
    extras: [`src/test/java/${PKG_PATH}/steps/${stepsClass}.java`],
    featureFile: `src/test/resources/features/${moduleSlug}/${caseSlug}.feature`,
    stepsFile: `src/test/java/${PKG_PATH}/steps/${stepsClass}.java`,
    testFile: `src/test/java/${PKG_PATH}/steps/${stepsClass}.java`,
    stepsClass,
    moduleSlug,
  };
}

async function generate({ provider, apiKey, model, scenario, testCase, actionPlan, targetUrl, credProfile, authInfo }) {
  const lay = layout(scenario, testCase);
  let system = SYSTEM_PROMPT;
  if (credProfile) system += `\n\n${envContract.promptBlock(credProfile, { lang: 'java' })}`;
  if (authInfo && authInfo.authImportPath) system += `\n\n${authPromptBlock(authInfo.authImportPath, 'java')}`;
  system += `\n\n${fidelity.fidelityBlock({ lang: 'java' })}\n\n${locators.locatorPromptBlock({ lang: 'java' })}`;
  const declaredAssertions = fidelity.declaredAssertionsFor(testCase);
  const userMsg = JSON.stringify({
    targetUrl,
    caseStatus: actionPlan && actionPlan.caseStatus,
    scenario: { name: scenario.name, module: scenario.module, priority: scenario.priority, category: scenario.category, rationale: scenario.rationale },
    testCase: { name: testCase.name, type: testCase.type, dependsOnIds: testCase.dependsOnIds || [], declaredAssertions, assertionsHint: testCase.assertions, steps: testCase.steps || [] },
    assertionDigest: fidelity.assertionDigest(declaredAssertions),
    resolvedLocators: locators.manifestDigest(actionPlan && actionPlan.locatorManifest),
    actionPlan,
    expectedFiles: { feature: { path: lay.featureFile }, steps: { path: lay.stepsFile, className: lay.stepsClass } },
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

  // Post-generate validation — catches crashes before files reach disk.
  const validationErrors = [];

  // 1. Feature file structure
  if (parsed.aContent) {
    if (!/^\s*Feature:/m.test(parsed.aContent)) validationErrors.push('Feature file missing "Feature:" declaration');
    if (!/\bScenario:/m.test(parsed.aContent)) validationErrors.push('Feature file contains no Scenario:');
  }
  // 2. Steps file structure
  if (parsed.bContent) {
    if (!/@(?:Given|When|Then|And|But)\s*\(/.test(parsed.bContent)) {
      validationErrors.push('Steps file contains no @Given/@When/@Then annotations');
    }
    // Leaked MCP tool name in Java source
    if (/\bbrowser_(?:click|fill|navigate|scroll|snapshot)\s*[({]/.test(parsed.bContent)) {
      validationErrors.push('MCP tool name (browser_click etc.) leaked into Java steps source');
    }
    // Class name must match expected
    const classMatch = parsed.bContent.match(/public\s+class\s+(\w+)/);
    if (classMatch && classMatch[1] !== lay.stepsClass) {
      validationErrors.push(`Steps class name mismatch: model generated "${classMatch[1]}" but file expects "${lay.stepsClass}"`);
    }
  }
  // 3. Step binding: count of feature steps must not exceed count of step definitions
  if (parsed.aContent && parsed.bContent) {
    const featureStepCount = (parsed.aContent.match(/^\s*(?:Given|When|Then|And|But)\s+/mg) || []).length;
    const defCount = (parsed.bContent.match(/@(?:Given|When|Then|And|But)\s*\(/g) || []).length;
    if (featureStepCount > 0 && defCount < featureStepCount) {
      validationErrors.push(`Step binding mismatch: feature has ${featureStepCount} step(s) but steps file defines only ${defCount} step definition(s) — Cucumber will fail with "undefined step"`);
    }
  }

  if (validationErrors.length > 0) {
    const summary = validationErrors.map((e, i) => `# ${i + 1}. ${e}`).join('\n');
    if (parsed.aContent) {
      parsed.aContent = `# QAAI CODEGEN VALIDATION FAILED — ${validationErrors.length} error(s):\n${summary}\n# Re-export from Governance to regenerate.\n` +
        parsed.aContent.split('\n').map((l) => `# ${l}`).join('\n') + '\n';
    }
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
  return { [lay.featureFile]: concat };
}

function ensureProjectShell(rootDir, opts = {}) {
  const created = [];
  const baseUrl = opts.targetUrl || 'https://example.com';
  const writeIfMissing = (rel, content) => {
    const full = path.join(rootDir, rel);
    if (fs.existsSync(full)) return;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    created.push(rel);
  };

  writeIfMissing('pom.xml',
`<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>${BASE_PACKAGE}</groupId>
  <artifactId>qaai-selenium-bdd-tests</artifactId>
  <version>1.0.0</version>
  <packaging>jar</packaging>

  <properties>
    <maven.compiler.source>17</maven.compiler.source>
    <maven.compiler.target>17</maven.compiler.target>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <selenium.version>4.18.1</selenium.version>
    <cucumber.version>7.15.0</cucumber.version>
    <testng.version>7.10.2</testng.version>
  </properties>

  <dependencies>
    <dependency>
      <groupId>org.seleniumhq.selenium</groupId>
      <artifactId>selenium-java</artifactId>
      <version>\${selenium.version}</version>
    </dependency>
    <dependency>
      <groupId>io.cucumber</groupId>
      <artifactId>cucumber-java</artifactId>
      <version>\${cucumber.version}</version>
    </dependency>
    <dependency>
      <groupId>io.cucumber</groupId>
      <artifactId>cucumber-testng</artifactId>
      <version>\${cucumber.version}</version>
    </dependency>
    <dependency>
      <groupId>org.testng</groupId>
      <artifactId>testng</artifactId>
      <version>\${testng.version}</version>
    </dependency>
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.2.5</version>
      </plugin>
    </plugins>
  </build>
</project>
`);

  writeIfMissing(`src/test/java/${PKG_PATH}/runner/TestRunner.java`,
`package ${BASE_PACKAGE}.runner;

import io.cucumber.testng.AbstractTestNGCucumberTests;
import io.cucumber.testng.CucumberOptions;

/**
 * TestNG entry point for Cucumber. Picks up every .feature under
 * src/test/resources/features and binds glue code in ${BASE_PACKAGE}.steps.
 */
@CucumberOptions(
    features = "src/test/resources/features",
    glue = { "${BASE_PACKAGE}.steps" },
    plugin = { "pretty", "html:target/cucumber-report.html", "summary" }
)
public class TestRunner extends AbstractTestNGCucumberTests {
}
`);

  writeIfMissing(`src/main/java/${PKG_PATH}/util/DriverManager.java`,
`package ${BASE_PACKAGE}.util;

import org.openqa.selenium.WebDriver;
import org.openqa.selenium.chrome.ChromeDriver;
import org.openqa.selenium.chrome.ChromeOptions;

import java.time.Duration;

/**
 * Thread-safe WebDriver holder shared by Hooks and the step definitions.
 * Selenium 4 auto-resolves the matching ChromeDriver (Selenium Manager).
 */
public final class DriverManager {
    private static final ThreadLocal<WebDriver> DRIVER = new ThreadLocal<>();

    private DriverManager() { }

    public static WebDriver getDriver() {
        return DRIVER.get();
    }

    public static String getBaseUrl() {
        String env = System.getenv("QAAI_TARGET_URL");
        return System.getProperty("qaai.targetUrl",
                env != null && !env.isEmpty() ? env : ${JSON.stringify(baseUrl)});
    }

    public static void startDriver() {
        ChromeOptions options = new ChromeOptions();
        if (System.getenv("CI") != null) {
            options.addArguments("--headless=new");
        }
        options.addArguments("--window-size=1280,720", "--remote-allow-origins=*");
        WebDriver driver = new ChromeDriver(options);
        driver.manage().timeouts().implicitlyWait(Duration.ofSeconds(5));
        DRIVER.set(driver);
    }

    public static void quitDriver() {
        WebDriver driver = DRIVER.get();
        if (driver != null) {
            driver.quit();
            DRIVER.remove();
        }
    }
}
`);

  writeIfMissing(`src/test/java/${PKG_PATH}/steps/Hooks.java`,
`package ${BASE_PACKAGE}.steps;

import ${BASE_PACKAGE}.util.DriverManager;
import io.cucumber.java.After;
import io.cucumber.java.Before;
import io.cucumber.java.Scenario;
import org.openqa.selenium.OutputType;
import org.openqa.selenium.TakesScreenshot;
import org.openqa.selenium.WebDriver;

/**
 * Per-scenario driver lifecycle. Starts a browser before each scenario and
 * quits after, attaching a screenshot to the report on failure.
 */
public class Hooks {

    @Before
    public void before() {
        DriverManager.startDriver();
    }

    @After
    public void after(Scenario scenario) {
        WebDriver driver = DriverManager.getDriver();
        try {
            if (driver != null && scenario.isFailed()) {
                byte[] png = ((TakesScreenshot) driver).getScreenshotAs(OutputType.BYTES);
                scenario.attach(png, "image/png", scenario.getName());
            }
        } finally {
            DriverManager.quitDriver();
        }
    }
}
`);

  // Config.java — the ONE credential contract. Bakes the project's configured /
  // observed credentials and reads QAAI_* env overrides, so every step uses
  // Config.username() / Config.password() instead of inventing getenv names.
  const profile = (opts.credProfile && Array.isArray(opts.credProfile.users))
    ? opts.credProfile : { users: [], hasCreds: false };
  writeIfMissing(`src/main/java/${PKG_PATH}/util/Config.java`, envContract.renderJavaConfig(profile, BASE_PACKAGE, { baseUrl }));

  writeIfMissing('.gitignore', 'target/\ntest-results/\n*.iml\n.idea/\n.vscode/\n');

  writeIfMissing('README.md',
`# QAAI Selenium BDD suite (Cucumber-JVM + TestNG)

Complete Maven project exported from QAAI. Open in IntelliJ IDEA or VS Code
(Java extension pack) and run — no edits required.

## Run

\`\`\`bash
mvn test
\`\`\`

Base URL (\`${baseUrl}\`) is baked into DriverManager. Override:

\`\`\`bash
mvn test -Dqaai.targetUrl=https://staging.example.com
\`\`\`

Selenium 4 auto-downloads the matching ChromeDriver (Selenium Manager) — you
need a local Chrome/Chromium and JDK 17+.

## Layout

\`\`\`
src/test/resources/features/   Gherkin .feature files (one per scenario)
src/test/java/com/qaai/steps/  Step definitions + Hooks (driver lifecycle)
src/test/java/com/qaai/runner/ TestRunner (TestNG + Cucumber)
src/main/java/com/qaai/util/   DriverManager (thread-safe WebDriver)
pom.xml                        Maven build (cucumber-java/testng, selenium)
\`\`\`

Note: Cucumber matches steps by text globally. If two scenarios declare the
IDENTICAL step sentence, merge those step methods into one class to avoid a
DuplicateStepDefinition error.
`);

  return created;
}

module.exports = { generate, layout, splitFiles, ensureProjectShell, SYSTEM_PROMPT };
