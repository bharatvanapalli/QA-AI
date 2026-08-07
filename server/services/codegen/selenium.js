'use strict';

/**
 * Framework: selenium-java (Selenium 4 + TestNG + Maven, Page Object Model).
 *
 * Produces a COMPLETE, runnable Maven project — open in IntelliJ/VS Code and
 * `mvn test` with no edits. Per test case it emits TWO Java files:
 *   - src/main/java/com/qaai/pages/<Module>Page.java   Page Object (By locators + actions)
 *   - src/test/java/com/qaai/tests/<Name>Test.java      TestNG test extending BaseTest
 *
 * ensureProjectShell() writes the one-time scaffold: pom.xml, testng.xml, a
 * BaseTest with driver lifecycle, a config reader, and .gitignore. Selenium
 * 4.6+ ships Selenium Manager, so the matching ChromeDriver is auto-resolved —
 * no WebDriverManager dependency and no manual driver download required.
 *
 * The model is prompted for the same { pageObject, test } JSON envelope the
 * Playwright generators use, so it shares the robust _recoverJson parser and
 * the same "never write a JSON blob to a source file" guarantee.
 */

const fs = require('fs');
const path = require('path');
const { parseGeneratedJson } = require('./_recoverJson');
const envContract = require('./_env');
const fidelity = require('./_fidelity');
const locators = require('./_locators');
const { authPromptBlock } = require('./_login');

const BASE_PACKAGE = 'com.qaai';
const PKG_PATH = 'com/qaai';

const SYSTEM_PROMPT = `You are a senior SDET writing Selenium 4 + Java tests with TestNG and a strict Page Object Model.

You MUST output a single JSON object with two top-level keys: "pageObject" and "test".
Each value has shape { "path": "<relative/path/from/project-root>", "content": "<full file contents>" }.

PAGE OBJECT (pageObject.content) — package ${BASE_PACKAGE}.pages:
- package ${BASE_PACKAGE}.pages;
- One public class named EXACTLY as given in expectedFiles.pageObject.className (PascalCase). Do NOT rename it — the file name must match the class name or it will not compile.
- Fields: a private final WebDriver driver; a private final WebDriverWait wait; and a private final By per element.
- Constructor: public <ClassName>(WebDriver driver) { this.driver = driver; this.wait = new WebDriverWait(driver, Duration.ofSeconds(15)); }
- Locators are private final By fields — NEVER inline By in the test class. Prefer By.cssSelector / By.id / By.name; use By.xpath only when there is no stable alternative.
- LOGIN FIELDS: locate by their name attribute — By.name("username"), By.name("password") — or By.cssSelector("input[name='password']"). These are the most stable; never use a brittle absolute XPath for login.
- Each PUBLIC method models a behaviour ("login(String user, String pass)", "addToCart()"). Wait for the element before acting: wait.until(ExpectedConditions.elementToBeClickable(locator)).
- NO Thread.sleep — always use WebDriverWait + ExpectedConditions.
- Import what you use (org.openqa.selenium.*, org.openqa.selenium.support.ui.*, java.time.Duration).

TEST CLASS (test.content) — package ${BASE_PACKAGE}.tests:
- package ${BASE_PACKAGE}.tests;
- import ${BASE_PACKAGE}.base.BaseTest;  import ${BASE_PACKAGE}.pages.*;  import ${BASE_PACKAGE}.util.Config;
- import org.testng.annotations.Test; import static org.testng.Assert.*;
- The test class is named EXACTLY as given in expectedFiles.test.className. public class <ClassName> extends BaseTest { ... }
- BaseTest already provides: a ready WebDriver "driver", a WebDriverWait "wait", and "baseUrl". Do NOT create or quit the driver — BaseTest's @BeforeMethod/@AfterMethod handle the full lifecycle and a failure screenshot.
- Each @Test method reproduces the FULL end-to-end flow in order: navigate (driver.get(baseUrl + "/path")) -> any setup -> the actions under test (via Page Object methods) -> assertions. Do not omit steps the agent actually performed.
- FIRST STATEMENT INVARIANT: The very FIRST statement in every @Test method body MUST be driver.get(baseUrl + "/path"). Navigate FIRST, then any setup, then actions. NEVER call findElement / wait / click before driver.get() — the browser has no page loaded and every findElement will throw NoSuchElementException immediately.
- Every declared assertion MUST have a matching TestNG assert (assertEquals / assertTrue / assertThat). Never claim a behaviour you did not assert.
- @Test(description = "...") describing the scenario clearly.

TESTNG + SELENIUM DEPTH — use the framework's native power, but ONLY to express what the action plan actually verified (never invent assertions, data providers, or cases):
- Choose the TestNG assertion that MATCHES the check: assertEquals / assertTrue / assertNotNull / assertNotEquals — always with a message argument explaining the expectation.
- When several INDEPENDENT end-state checks apply, use org.testng.asserts.SoftAssert and call softAssert.assertAll() at the very end, so one failure doesn't mask the others.
- Use the RIGHT Selenium tool for the interaction the agent performed: org.openqa.selenium.support.ui.Select for <select> dropdowns; org.openqa.selenium.interactions.Actions for hover / drag-and-drop / right-click / key chords; JavascriptExecutor ONLY as a last resort when no standard interaction works.
- If the scenario provides a category, tag the test: @Test(groups = "<category>", description = "...").

WAITS & TIMING:
- NEVER Thread.sleep. Use WebDriverWait + ExpectedConditions, choosing the condition that matches intent (visibilityOfElementLocated, elementToBeClickable, textToBePresentInElement, urlContains). Every wait inherits the 15s default — fine.

COMMENTS — clean and purposeful:
- One short comment above each logical block describing the user intent in plain language. Not per line. No noise.

POPUP / COOKIE BANNERS — defensive:
- If the action trail shows the agent dismissing a cookie/consent/"Close"/"Accept"/"Got it" element, do NOT make it an unconditional step (it may not appear on re-run). Wrap it defensively, e.g.:
    java.util.List<org.openqa.selenium.WebElement> banner = driver.findElements(By.cssSelector("#cookie-accept"));
    if (!banner.isEmpty() && banner.get(0).isDisplayed()) { banner.get(0).click(); }

CREDENTIALS — use the shared contract ONLY:
- Read credentials from com.qaai.util.Config: Config.username() and Config.password(). It already falls back to the project's configured values, so the suite runs with no setup.
- NEVER hardcode credentials. NEVER call System.getenv with an invented variable name. NEVER use an empty-string fallback (that submits a blank login).
- Navigation base URL stays as BaseTest's baseUrl (driver.get(baseUrl + "/path")).

DATA DEPENDENCIES — when testCase.dependsOnIds is non-empty:
- Replay any declared prerequisite creation/setup before the dependent actions and reuse the same values. Preserve every Page Object method, action, and assertion in the generated source.
- Never use SkipException, @Test(enabled = false), a conditional early return, or omit dependent code because prerequisite data is absent.
- If the approved evidence cannot safely recreate the prerequisite, keep the complete flow and make a non-destructive prerequisite check fail explicitly with a TestNG assertion whose message starts "QAAI_PREREQUISITE_MISSING:".

Output ONLY the JSON object — no markdown fences, no other text.`;

// Turn a free-text label into a valid PascalCase Java identifier.
function javaIdent(s, fallback = 'App') {
  const parts = String(s || '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  let id = parts.join('').slice(0, 60);
  // Java identifiers can't start with a digit.
  if (!id || !/^[A-Za-z]/.test(id)) id = fallback + id;
  return id || fallback;
}

// A stable PascalCase identifier derived from the TEST CASE (not the module),
// so page object + test class are PER-CASE and never collide. Falls back to a
// short id-based name for unnamed cases.
function caseIdentBase(testCase) {
  const base = javaIdent(testCase.name, '');
  return base && /^[A-Za-z]/.test(base) ? base : 'Case' + (testCase.id || '').slice(0, 6);
}

function testClassName(testCase) {
  const base = caseIdentBase(testCase);
  return base.endsWith('Test') ? base : base + 'Test';
}

// PER-CASE page object class. A per-MODULE PimPage.java is clobbered
// last-write-wins when N cases each author their own PimPage with different
// methods → every test but the last fails to compile (missing methods). A
// per-case class name (LoginValidPage, …) guarantees each test ships with the
// exact page object it was generated against. See codegen/pom.js.
function pageClassName(testCase) {
  const base = caseIdentBase(testCase);
  return base.endsWith('Page') ? base : base + 'Page';
}

function layout(scenario, testCase) {
  const pageCls = pageClassName(testCase);
  const testCls = testClassName(testCase);
  return {
    primaryFile: `src/test/java/${PKG_PATH}/tests/${testCls}.java`,
    extras: [`src/main/java/${PKG_PATH}/pages/${pageCls}.java`],
    pageObjectFile: `src/main/java/${PKG_PATH}/pages/${pageCls}.java`,
    testFile: `src/test/java/${PKG_PATH}/tests/${testCls}.java`,
    className: pageCls,
    testClassName: testCls,
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
    expectedFiles: {
      pageObject: { path: lay.pageObjectFile, className: lay.className },
      test: { path: lay.testFile, className: lay.testClassName },
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

  if (!parsed || (!parsed.pageContent && !parsed.testContent)) {
    const reason = parsed === null
      ? 'model did not return the expected { pageObject, test } JSON object'
      : 'model returned JSON but neither pageObject.content nor test.content was present';
    return (
      `// ─── Page Object: ${lay.pageObjectFile} ───\n` +
      `// QAAI CODEGEN FAILED — ${reason}.\n` +
      `// The test PASSED in the agent run; only the spec emission failed.\n` +
      `// Re-merge this case from Governance to regenerate. Raw model output preserved below:\n` +
      rawText.split('\n').map((l) => `//   ${l}`).join('\n') + '\n\n' +
      `// ─── Test: ${lay.testFile} ───\n` +
      `// QAAI CODEGEN FAILED — see Page Object file header above.\n`
    );
  }

  // Post-generate structural validation — catches crashes before files reach disk.
  const validationErrors = [];

  // 1. No @Test annotation — entire suite will be skipped by TestNG
  if (parsed.testContent && !/@Test/.test(parsed.testContent)) {
    validationErrors.push('No @Test annotation found in test class');
  }
  // 2. Class name must match the filename or it will not compile
  if (parsed.testContent) {
    const classMatch = parsed.testContent.match(/public\s+class\s+(\w+)/);
    if (classMatch && classMatch[1] !== lay.testClassName) {
      validationErrors.push(`Class name mismatch: model generated "${classMatch[1]}" but file expects "${lay.testClassName}"`);
    }
  }
  // 3. Leaked MCP tool name in Java source
  const allJava = (parsed.pageContent || '') + (parsed.testContent || '');
  if (/\bbrowser_(?:click|fill|navigate|scroll|snapshot)\s*[({]/.test(allJava)) {
    validationErrors.push('MCP tool name (browser_click etc.) leaked into Java source');
  }
  // 4. Raw JSON envelope written as Java source
  if (/^\s*\{[\s\S]{0,80}["'](pageObject|test)["']\s*:/.test(allJava)) {
    validationErrors.push('Raw codegen JSON envelope written as Java source instead of split into real code');
  }

  if (validationErrors.length > 0) {
    const summary = validationErrors.map((e, i) => `// ${i + 1}. ${e}`).join('\n');
    const stub = `// QAAI CODEGEN VALIDATION FAILED — ${validationErrors.length} structural error(s):\n${summary}\n// Re-export from Governance to regenerate.\n`;
    if (parsed.testContent) {
      parsed.testContent = stub + parsed.testContent.split('\n').map((l) => `// ${l}`).join('\n') + '\n';
    }
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
 * Ensure the Maven project scaffold exists. Idempotent.
 * @param {string} rootDir
 * @param {object} [opts]  { targetUrl } — baked into BaseTest as the default base URL.
 */
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
  <artifactId>qaai-selenium-tests</artifactId>
  <version>1.0.0</version>
  <packaging>jar</packaging>

  <properties>
    <maven.compiler.source>17</maven.compiler.source>
    <maven.compiler.target>17</maven.compiler.target>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <selenium.version>4.18.1</selenium.version>
    <testng.version>7.10.2</testng.version>
  </properties>

  <dependencies>
    <dependency>
      <groupId>org.seleniumhq.selenium</groupId>
      <artifactId>selenium-java</artifactId>
      <version>\${selenium.version}</version>
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
        <configuration>
          <suiteXmlFiles>
            <suiteXmlFile>testng.xml</suiteXmlFile>
          </suiteXmlFiles>
        </configuration>
      </plugin>
    </plugins>
  </build>
</project>
`);

  writeIfMissing('testng.xml',
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE suite SYSTEM "https://testng.org/testng-1.0.dtd">
<suite name="QAAI Selenium Suite" verbose="1">
  <test name="All Tests">
    <packages>
      <package name="${BASE_PACKAGE}.tests"/>
    </packages>
  </test>
</suite>
`);

  writeIfMissing(`src/main/java/${PKG_PATH}/base/BaseTest.java`,
`package ${BASE_PACKAGE}.base;

import org.openqa.selenium.OutputType;
import org.openqa.selenium.TakesScreenshot;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.chrome.ChromeDriver;
import org.openqa.selenium.chrome.ChromeOptions;
import org.openqa.selenium.support.ui.WebDriverWait;
import org.testng.ITestResult;
import org.testng.annotations.AfterMethod;
import org.testng.annotations.BeforeMethod;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;

/**
 * Shared lifecycle for every test. Selenium 4 auto-resolves the matching
 * ChromeDriver via Selenium Manager, so no driver download/setup is needed.
 */
public class BaseTest {
    protected WebDriver driver;
    protected WebDriverWait wait;
    // Base URL is baked from the QAAI project Target URL; override at runtime
    // with -Dqaai.targetUrl=... or the QAAI_TARGET_URL environment variable.
    protected String baseUrl;

    @BeforeMethod(alwaysRun = true)
    public void setUp() {
        String envUrl = System.getenv("QAAI_TARGET_URL");
        baseUrl = System.getProperty("qaai.targetUrl",
                envUrl != null && !envUrl.isEmpty() ? envUrl : ${JSON.stringify(baseUrl)});

        ChromeOptions options = new ChromeOptions();
        // Run headless in CI; headed locally so you can watch the flow.
        if (System.getenv("CI") != null) {
            options.addArguments("--headless=new");
        }
        options.addArguments("--window-size=1280,720", "--remote-allow-origins=*");

        driver = new ChromeDriver(options);
        driver.manage().timeouts().implicitlyWait(Duration.ofSeconds(5));
        wait = new WebDriverWait(driver, Duration.ofSeconds(15));
    }

    @AfterMethod(alwaysRun = true)
    public void tearDown(ITestResult result) {
        try {
            if (driver != null && !result.isSuccess()) {
                captureScreenshot(result.getName());
            }
        } finally {
            if (driver != null) {
                driver.quit();
            }
        }
    }

    /** Save a PNG under test-results/ for evidence/debugging. */
    protected void captureScreenshot(String name) {
        try {
            File src = ((TakesScreenshot) driver).getScreenshotAs(OutputType.FILE);
            Path dir = Path.of("test-results");
            Files.createDirectories(dir);
            Files.copy(src.toPath(), dir.resolve(name + ".png"));
        } catch (Exception ignored) {
            // Screenshot is best-effort — never fail a test because of it.
        }
    }
}
`);

  // Config.java — the ONE credential contract. Bakes the project's configured /
  // observed credentials as fallbacks and reads QAAI_* env vars for overrides,
  // so the suite runs with no setup and every test uses Config.username() /
  // Config.password() instead of inventing its own getenv names.
  const profile = (opts.credProfile && Array.isArray(opts.credProfile.users))
    ? opts.credProfile : { users: [], hasCreds: false };
  writeIfMissing(`src/main/java/${PKG_PATH}/util/Config.java`, envContract.renderJavaConfig(profile, BASE_PACKAGE, { baseUrl }));

  writeIfMissing('.gitignore',
`target/
test-results/
*.iml
.idea/
.vscode/
`);

  writeIfMissing('README.md',
`# QAAI Selenium + TestNG suite

Complete Maven project exported from QAAI. Open in IntelliJ IDEA or VS Code
(with the Java extension pack) and run — no edits required.

## Run

\`\`\`bash
mvn test
\`\`\`

The base URL (\`${baseUrl}\`) is baked into \`BaseTest\`. Override it without
editing code:

\`\`\`bash
mvn test -Dqaai.targetUrl=https://staging.example.com
# or
QAAI_TARGET_URL=https://staging.example.com mvn test
\`\`\`

Selenium 4 auto-downloads the matching ChromeDriver (Selenium Manager) — you
only need a local Chrome/Chromium and JDK 17+.

## Layout

\`\`\`
src/main/java/com/qaai/pages/   Page Object classes (By locators + actions)
src/main/java/com/qaai/base/    BaseTest — driver lifecycle + failure screenshots
src/test/java/com/qaai/tests/   TestNG @Test classes, one per test case
testng.xml                      Suite definition (runs the tests package)
pom.xml                         Maven build (Selenium ${'4.18.1'}, TestNG)
\`\`\`
`);

  return created;
}

module.exports = { generate, layout, splitFiles, ensureProjectShell, SYSTEM_PROMPT };
