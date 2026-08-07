'use strict';

/**
 * Shared login helper — authored ONCE per run, reused by every case.
 *
 * WHY THIS EXISTS
 * In a large export, many page objects each re-authored login
 * independently. Because each came from a separate codegen LLM call, the
 * locators drifted: some used input[name='username'] (correct), 18 used
 * getByLabel(/username/i) (some apps have no <label>, so it never matched and
 * the case failed before the behaviour under test). That per-case variance is
 * the single biggest reason "some cases pass and some fail" in an exported
 * suite — login is the same flow every time, so it must be authored ONCE.
 *
 * This module:
 *   1. extractLoginContext() — pulls the login slice out of the run's action
 *      trail (the login URL, the typed username/password, the submit, and the
 *      first post-login URL). This grounds both the credential profile and the
 *      helper in what ACTUALLY logged in.
 *   2. ensureAuthModule() — idempotently writes a single shared login helper
 *      for the framework (utils/auth.ts / .js, a Java Auth util, or a shared
 *      BDD "I am logged in" step). It makes ONE grounded LLM call to author the
 *      correct app-specific locators; if that call fails or returns garbage it
 *      falls back to a robust multi-strategy template — so it can NEVER break a
 *      run.
 *   3. authPromptBlock() — the instruction injected into each per-case prompt
 *      telling it to CALL the shared helper and NOT re-author login.
 */

const { recoverOne } = require('./_recoverJson');

// ── trail extraction ──────────────────────────────────────────────────────

// Pull a relative path from an absolute or relative URL.
function relPath(url) {
  if (!url) return null;
  try {
    if (/^https?:\/\//i.test(url)) return new URL(url).pathname || '/';
    return url.startsWith('/') ? url : '/' + url;
  } catch (_) { return null; }
}

function looksLikeLoginUrl(u) {
  return /login|signin|sign-in|auth/i.test(String(u || ''));
}

// Identify a field by whatever the MCP action recorded (element description,
// ref label, narration, or explicit field name).
function fieldHint(a) {
  const args = a.args || {};
  return [args.element, args.ref, args.name, args.field, a.narration]
    .filter(Boolean).map(String).join(' ').toLowerCase();
}

/**
 * Extract the login context from a codegen actionPlan ({ actions:[{tool,args,...}] }).
 * Best-effort and defensive — any field may be missing.
 * @returns {{ loginPath, postLoginUrlHint, observed:{username,password}, slice:Array }}
 */
function extractLoginContext(actionPlan, targetUrl) {
  const actions = Array.isArray(actionPlan?.actions) ? actionPlan.actions : [];
  let loginPath = null;
  let postLoginUrlHint = null;
  let username = '';
  let password = '';
  let sawLoginNav = false;
  const slice = [];

  for (const a of actions) {
    const tool = a.tool || '';
    const args = a.args || {};
    if (tool === 'browser_navigate' && args.url) {
      const rp = relPath(args.url);
      if (!loginPath && looksLikeLoginUrl(args.url)) { loginPath = rp; sawLoginNav = true; slice.push(a); continue; }
      if (sawLoginNav && !postLoginUrlHint && !looksLikeLoginUrl(args.url)) { postLoginUrlHint = rp; break; }
    }
    if (tool === 'browser_type' || tool === 'browser_fill' || tool === 'browser_fill_form') {
      const hint = fieldHint(a);
      const text = args.text != null ? String(args.text) : (args.value != null ? String(args.value) : '');
      if (/pass/i.test(hint) && text) { password = password || text; slice.push(a); continue; }
      if (/(user|email|login)/i.test(hint) && text) { username = username || text; slice.push(a); continue; }
      // browser_fill_form carries a fields array
      if (Array.isArray(args.fields)) {
        for (const f of args.fields) {
          const fh = [f.name, f.element, f.ref].filter(Boolean).join(' ').toLowerCase();
          if (/pass/i.test(fh) && f.value) password = password || String(f.value);
          else if (/(user|email|login)/i.test(fh) && f.value) username = username || String(f.value);
        }
        slice.push(a);
      }
    }
    if (tool === 'browser_click') {
      const hint = fieldHint(a);
      if (/(login|sign\s*in|submit|log\s*in)/i.test(hint)) { slice.push(a); }
    }
  }

  if (!loginPath) {
    // Derive from the target URL if the agent never explicitly navigated to a
    // login path (some apps redirect root → /login automatically).
    loginPath = relPath(targetUrl) || '/';
  }
  return { loginPath, postLoginUrlHint, observed: { username, password }, slice };
}

// ── helper authoring ───────────────────────────────────────────────────────

// Which framework gets a shared auth helper, and where it lives.
const AUTH_LAYOUT = {
  'playwright-pom':      { lang: 'ts', file: 'utils/auth.ts',  importFromSpec: '../../utils/auth', kind: 'pw' },
  'playwright-flat':     { lang: 'ts', file: 'utils/auth.ts',  importFromSpec: '../../utils/auth', kind: 'pw' },
  'playwright-js':       { lang: 'js', file: 'utils/auth.js',  importFromSpec: '../../utils/auth', kind: 'pw' },
  'playwright-bdd':      { lang: 'ts', file: 'utils/auth.ts',  importFromSpec: '../utils/auth', kind: 'pw' },
  'cucumber-playwright': { lang: 'ts', file: 'utils/auth.ts',  importFromSpec: '../utils/auth', kind: 'pw' },
  'selenium-java':       { lang: 'java', file: 'src/main/java/com/qaai/util/Auth.java', importFromSpec: 'com.qaai.util.Auth', kind: 'selenium' },
  'selenium-bdd':        { lang: 'java', file: 'src/main/java/com/qaai/util/Auth.java', importFromSpec: 'com.qaai.util.Auth', kind: 'selenium' },
};

function authLayoutFor(framework) { return AUTH_LAYOUT[framework] || null; }

// Deterministic, app-agnostic fallback helper. Tries the stable strategies in
// order (name attr → placeholder → role+name → label) so it works on the
// majority of login forms even without an LLM. Never throws on a missing field.
function fallbackHelperTs(ctx, credProfile) {
  const path = ctx.loginPath || '/';
  const post = ctx.postLoginUrlHint && !/login|auth/i.test(ctx.postLoginUrlHint) ? ctx.postLoginUrlHint : '/dashboard';
  return `import { Page } from '@playwright/test';
import { QAAI_USERNAME, QAAI_PASSWORD } from './env';

/**
 * Single source of truth for authentication. Authored once and reused by every
 * spec — do NOT re-implement login in a page object or test.
 */
async function fillFirst(page: Page, value: string, candidates: Array<() => ReturnType<Page['locator']>>) {
  for (const make of candidates) {
    const loc = make().first();
    // waitFor (not count) so a SPA that renders the form AFTER load still works.
    try { await loc.waitFor({ state: 'visible', timeout: 10_000 }); await loc.fill(value); return; }
    catch { /* try next strategy */ }
  }
  throw new Error('Login field not found with any known strategy');
}

function looksLikeLoginPage(url: string): boolean {
  return /login|signin|sign-in|\\/auth/i.test(url);
}

async function isAlreadyLoggedIn(page: Page): Promise<boolean> {
  try {
    await page.goto(${JSON.stringify(post)}, { waitUntil: 'domcontentloaded', timeout: 8000 });
    return !looksLikeLoginPage(page.url());
  } catch { return false; }
}

async function doLogin(page: Page, username: string, password: string): Promise<void> {
  await page.goto(${JSON.stringify(path)}, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await fillFirst(page, username, [
    () => page.locator("input[name='username']"),
    () => page.getByPlaceholder(/username|email/i),
    () => page.getByRole('textbox', { name: /username|email/i }),
  ]);
  await fillFirst(page, password, [
    () => page.locator("input[name='password']"),
    () => page.getByPlaceholder(/password/i),
    () => page.locator("input[type='password']"),
  ]);
  await page.getByRole('button', { name: /log\\s*in|sign\\s*in|submit/i }).first().click();
  await page.waitForURL(${JSON.stringify('**' + post + '**')}, { timeout: 15_000 });
}

export async function login(page: Page, username: string = QAAI_USERNAME, password: string = QAAI_PASSWORD): Promise<void> {
  // Skip re-login when the session is already valid (same browser context reuse across tests).
  if (await isAlreadyLoggedIn(page)) return;

  // Retry once — covers transient load failures on a slow real-world app.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await doLogin(page, username, password);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < 1) {
        // Brief recovery: navigate to root and wait for the page to settle before retrying.
        await page.goto('/').catch(() => {});
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      }
    }
  }
  throw lastErr;
}
`;
}

function fallbackHelperJs(ctx, credProfile) {
  const path = ctx.loginPath || '/';
  const post = ctx.postLoginUrlHint && !/login|auth/i.test(ctx.postLoginUrlHint) ? ctx.postLoginUrlHint : '/dashboard';
  return `const { QAAI_USERNAME, QAAI_PASSWORD } = require('./env');

/**
 * Single source of truth for authentication. Authored once and reused by every
 * spec — do NOT re-implement login in a page object or test.
 */
async function fillFirst(page, value, candidates) {
  for (const make of candidates) {
    const loc = make().first();
    // waitFor (not count) so a SPA that renders the form AFTER load still works.
    try { await loc.waitFor({ state: 'visible', timeout: 10_000 }); await loc.fill(value); return; }
    catch { /* try next strategy */ }
  }
  throw new Error('Login field not found with any known strategy');
}

function looksLikeLoginPage(url) {
  return /login|signin|sign-in|\\/auth/i.test(url);
}

async function isAlreadyLoggedIn(page) {
  try {
    await page.goto(${JSON.stringify(post)}, { waitUntil: 'domcontentloaded', timeout: 8000 });
    return !looksLikeLoginPage(page.url());
  } catch { return false; }
}

async function doLogin(page, username, password) {
  await page.goto(${JSON.stringify(path)}, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await fillFirst(page, username, [
    () => page.locator("input[name='username']"),
    () => page.getByPlaceholder(/username|email/i),
    () => page.getByRole('textbox', { name: /username|email/i }),
  ]);
  await fillFirst(page, password, [
    () => page.locator("input[name='password']"),
    () => page.getByPlaceholder(/password/i),
    () => page.locator("input[type='password']"),
  ]);
  await page.getByRole('button', { name: /log\\s*in|sign\\s*in|submit/i }).first().click();
  await page.waitForURL(${JSON.stringify('**' + post + '**')}, { timeout: 15_000 });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} [username]
 * @param {string} [password]
 */
async function login(page, username = QAAI_USERNAME, password = QAAI_PASSWORD) {
  // Skip re-login when the session is already valid (same browser context reuse across tests).
  if (await isAlreadyLoggedIn(page)) return;

  // Retry once — covers transient load failures on a slow real-world app.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await doLogin(page, username, password);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < 1) {
        // Brief recovery: navigate to root and wait for the page to settle before retrying.
        await page.goto('/').catch(() => {});
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      }
    }
  }
  throw lastErr;
}

module.exports = { login };
`;
}

function fallbackHelperJava(ctx) {
  const loginPath = ctx.loginPath || '/';
  const post = ctx.postLoginUrlHint || '';
  return `package com.qaai.util;

import org.openqa.selenium.By;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.support.ui.ExpectedConditions;
import org.openqa.selenium.support.ui.WebDriverWait;

import java.time.Duration;

/** Shared login helper generated once per QAAI run. */
public final class Auth {
    private Auth() { }

    public static void login(WebDriver driver) {
        login(driver, Config.username(), Config.password());
    }

    public static void login(WebDriver driver, String username, String password) {
        WebDriverWait wait = new WebDriverWait(driver, Duration.ofSeconds(15));
        driver.get(join(Config.baseUrl(), ${JSON.stringify(loginPath)}));

        WebElement user = firstVisible(driver,
                By.name("username"),
                By.name("email"),
                By.cssSelector("input[name='username']"),
                By.cssSelector("input[name='email']"),
                By.cssSelector("input[type='email']"),
                By.cssSelector("input[placeholder*='Username' i], input[placeholder*='Email' i]"));
        user.clear();
        user.sendKeys(username);

        WebElement pass = firstVisible(driver,
                By.name("password"),
                By.cssSelector("input[name='password']"),
                By.cssSelector("input[type='password']"),
                By.cssSelector("input[placeholder*='Password' i]"));
        pass.clear();
        pass.sendKeys(password);

        WebElement submit = wait.until(ExpectedConditions.elementToBeClickable(firstPresent(driver,
                By.cssSelector("button[type='submit']"),
                By.cssSelector("input[type='submit']"),
                By.xpath("//button[contains(translate(normalize-space(.), 'LOGIN SIGN', 'login sign'), 'login') or contains(translate(normalize-space(.), 'LOGIN SIGN', 'login sign'), 'sign in')]"))));
        submit.click();

        try {
            if (!${JSON.stringify(post)}.isEmpty()) {
                wait.until(ExpectedConditions.urlContains(${JSON.stringify(post.replace(/^\//, ''))}));
            } else {
                wait.until(ExpectedConditions.not(ExpectedConditions.urlContains(${JSON.stringify(loginPath.replace(/^\//, ''))})));
            }
        } catch (Exception ignored) {
            // Some SPAs complete login without a URL change; subsequent page assertions own the verdict.
        }
    }

    private static WebElement firstVisible(WebDriver driver, By... locators) {
        WebDriverWait wait = new WebDriverWait(driver, Duration.ofSeconds(15));
        for (By locator : locators) {
            try {
                WebElement el = wait.until(ExpectedConditions.visibilityOfElementLocated(locator));
                if (el != null) return el;
            } catch (Exception ignored) {
                // try next strategy
            }
        }
        throw new IllegalStateException("Login field not found with any known strategy");
    }

    private static By firstPresent(WebDriver driver, By... locators) {
        for (By locator : locators) {
            try {
                if (!driver.findElements(locator).isEmpty()) return locator;
            } catch (Exception ignored) {
                // try next strategy
            }
        }
        throw new IllegalStateException("Login submit control not found with any known strategy");
    }

    private static String join(String base, String path) {
        if (base.endsWith("/") && path.startsWith("/")) return base.substring(0, base.length() - 1) + path;
        if (!base.endsWith("/") && !path.startsWith("/")) return base + "/" + path;
        return base + path;
    }
}
`;
}

const AUTH_SYSTEM_PROMPT = `You are a senior SDET writing the ONE shared login helper for a Playwright suite. Every test imports and calls this — it must be correct and resilient.

You receive: the login slice of a real recorded run (the navigation to the login page, the fields the agent typed into, the submit it clicked, and the first page it reached after login). Output the single helper file ONLY, as a JSON object: { "auth": { "content": "<full file>" } }. No markdown fences, no prose.

Hard rules:
- Export an async function login(page, username, password) with the credential constants as defaults (TypeScript: import { QAAI_USERNAME, QAAI_PASSWORD } from './env'; JavaScript: const { QAAI_USERNAME, QAAI_PASSWORD } = require('./env'); and module.exports = { login }).
- Navigate with a RELATIVE path (baseURL is configured): await page.goto('<login path from the trail>').
- Locate the username/password fields by the MOST STABLE attribute visible in the trail: an input name attribute (input[name='username']) is best; otherwise getByPlaceholder or getByRole('textbox', { name }). Do NOT use getByLabel unless the form genuinely has associated <label> elements — most login forms do not.
- The app may be a SPA that renders the login form AFTER initial load. Before filling, wait for the first field to be visible with a generous timeout (await usernameLocator.waitFor({ state: 'visible', timeout: 15000 })) so a slow/cold login does not fail before the form paints. Do not assume the field exists immediately after goto.
- Click the submit control by its accessible name/role (getByRole('button', { name: /.../i })).
- After clicking submit, wait for navigation with page.waitForURL(<post-login pattern>, { timeout: 15000 }) wrapped so a redirect variation does not hard-fail. NEVER use page.waitForResponse with a guessed URL — it hangs when the guess is wrong. NEVER use page.waitForTimeout.
- No console.log. Keep it to the single login function (a tiny private helper is fine).`;

function buildAuthUserMsg({ ctx, credProfile, lang, targetUrl }) {
  const p = credProfile.users[0] || {};
  return JSON.stringify({
    language: lang === 'js' ? 'JavaScript (CommonJS)' : 'TypeScript',
    targetUrl,
    loginPath: ctx.loginPath,
    postLoginUrlHint: ctx.postLoginUrlHint,
    primaryUserEnv: { username: 'QAAI_USERNAME', password: 'QAAI_PASSWORD' },
    primaryUserName: p.name || 'default',
    recordedLoginSlice: ctx.slice.map((a) => ({ tool: a.tool, args: a.args || {} })),
  }, null, 2);
}

/**
 * Idempotently ensure a shared login helper exists in the run's project dir.
 * Returns { created, authImportPath, helperName } or null when the framework
 * does not use a shared helper. NEVER throws — falls back to a template.
 *
 * @param {object} deps  { fs, path }  (injected so this module stays pure of fs)
 */
async function ensureAuthModule({
  projectRoot, framework, provider, apiKey, model,
  loginContext, credProfile, targetUrl, fs, path, send, tcId,
}) {
  const lay = authLayoutFor(framework);
  if (!lay) return null; // framework has no shared-helper support (yet)

  const full = path.join(projectRoot, lay.file);
  const result = { created: false, authImportPath: lay.importFromSpec, helperName: 'login', file: lay.file };
  if (fs.existsSync(full)) return result; // authored already this run — reuse

  let content = '';
  // 1) grounded LLM authoring for Playwright (best — correct app-specific locators).
  // Java helpers use a deterministic Selenium template for now; the Playwright
  // prompt is intentionally not reused for Java.
  try {
    if (provider && lay.lang !== 'java') {
      const resp = await provider.complete({
        apiKey, model, maxTokens: 1500,
        system: AUTH_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildAuthUserMsg({ ctx: loginContext, credProfile, lang: lay.lang, targetUrl }) }],
      });
      const raw = (resp.content?.[0]?.text || '').trim();
      const parsed = recoverOne(raw, 'auth');
      const authContent = parsed?.content || null;
      if (authContent && /login/.test(authContent) && /env/.test(authContent)) content = authContent.trim();
    }
  } catch (_) { /* fall through to template */ }

  // 2) deterministic fallback — robust multi-strategy login
  if (!content) {
    content = lay.lang === 'java'
      ? fallbackHelperJava(loginContext, credProfile)
      : lay.lang === 'js'
        ? fallbackHelperJs(loginContext, credProfile)
        : fallbackHelperTs(loginContext, credProfile);
  }

  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content.endsWith('\n') ? content : content + '\n', 'utf8');
    result.created = true;
    if (send) send({ type: 'agent.phase.log', phase: 'conductor', level: 'spec-write', message: `   🔐 Shared login helper: ${lay.file}`, tcId });
  } catch (_) { return null; }
  return result;
}

/**
 * The per-case prompt instruction: USE the shared helper, don't re-author login.
 * @param {string} importPath  e.g. '../../utils/auth'
 * @param {string} lang  'ts' | 'js'
 */
function authPromptBlock(importPath, lang = 'ts') {
  if (lang === 'java') {
    return `## LOGIN — use the shared helper, do NOT re-author it
- A verified Selenium login helper already exists. Import it: import ${importPath};
- When the flow needs an authenticated session, call \`Auth.login(driver);\` at the start of the TestNG test or Cucumber step. It navigates to the login page, fills Config.username()/Config.password(), submits, and waits for the post-login page.
- Do NOT create login locators or duplicate username/password handling in each generated case. Your generated page object/steps cover ONLY the behaviour under test AFTER login.`;
  }
  const imp = lang === 'js'
    ? `const { login } = require('${importPath}');`
    : `import { login } from '${importPath}';`;
  return `## LOGIN — use the shared helper, do NOT re-author it
- A verified login helper already exists. Import it: ${imp}
- When the flow needs an authenticated session, call \`await login(page);\` at the start (or in test.beforeEach). It navigates to the login page, fills the shared credentials, submits, and waits for the post-login page.
- Do NOT create a LoginPage, gotoLogin(), or any login locators of your own. Do NOT use getByLabel for username/password. Your page object and test cover ONLY the behaviour under test AFTER login.

NEGATIVE CREDENTIAL EXCEPTION — rejected-login test cases ONLY:
If the test case name or scenario explicitly tests that the app REJECTS a bad login (name/rationale contains "invalid", "wrong", "incorrect", "empty", "empty password", "negative", "lockout", "brute"):
- Do NOT call login() or readEnv() — they would log in successfully and make the negative assertion impossible.
- Instead: emit the credential fills INLINE using the ACTUAL values recorded in the action plan (the args.text or args.value field of each browser_fill / browser_type action). If the agent typed an empty string, use \`''\`. If the agent typed a wrong password, use that exact string.
- ALWAYS emit the Login button click AFTER the credential fills. The validation error or rejection can ONLY appear after the form is submitted. A spec that fills credentials without clicking Login never triggers any error and always fails.
- Required sequence: await page.goto('/login') → fill username (actual value) → fill password (actual value) → click Login button → assert error / rejection.
This exception applies ONLY when login rejection is the SUBJECT of the test. Any test that ends on an authenticated page still calls \`await login(page)\` first.`;
}

module.exports = {
  extractLoginContext,
  authLayoutFor,
  ensureAuthModule,
  authPromptBlock,
  // exported for tests
  fallbackHelperTs,
  fallbackHelperJs,
  fallbackHelperJava,
};
