'use strict';
/**
 * Canonical defensive interaction helpers shipped into EVERY generated export
 * bundle. The sanitizer rewrites `.click()` → `clickFirstVisible(...)` and
 * injects `import { clickFirstVisible, safeClick, safeGoto } from '…/utils/test-helpers'`
 * into every spec. If this file is absent from the package, `npx playwright test`
 * fails at collection with "Cannot find module '../utils/test-helpers'". So the
 * assembler MUST emit it alongside the specs. Dependency-free on purpose.
 *
 * Single source of truth so the ReplayIR export, the POM scaffold and the JS
 * scaffold never drift apart on helper behaviour.
 */
const BODY = `async function findFirstVisible(candidates, timeout = 2000) {
  for (const loc of candidates) {
    try { if (await loc.isVisible({ timeout }).catch(() => false)) return loc; } catch (_) {}
  }
  return null;
}

async function safeGoto(page, url, opts = {}) {
  const attempts = Number(opts.retries ?? 3);
  const timeout = Number(opts.timeout ?? 30000);
  const waitUntil = opts.waitUntil || 'domcontentloaded';
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { await page.goto(url, { waitUntil, timeout }); return; }
    catch (err) { lastErr = err; if (i < attempts - 1) { await page.waitForLoadState('domcontentloaded').catch(() => {}); } }
  }
  throw lastErr;
}

async function safeClickWithOpts(locator, opts) {
  const timeout = (opts && opts.timeout) || 5000;
  const clickOpts = { timeout };
  if (opts && opts.clickCount != null) clickOpts.clickCount = opts.clickCount;
  try {
    await locator.waitFor({ state: 'visible', timeout }).catch(() => { throw new Error('locator not visible for click'); });
    await locator.click(clickOpts);
  } catch (err) {
    try { await locator.scrollIntoViewIfNeeded(); await locator.waitFor({ state: 'visible', timeout: 1500 }); await locator.click(clickOpts); }
    catch (err2) { throw err2 || err; }
  }
}

async function clickFirstVisible(locatorOrPage, selectorsArgOrOpts, timeout = 2000) {
  if (Array.isArray(selectorsArgOrOpts)) {
    const candidates = selectorsArgOrOpts.map((s) => (typeof s === 'string' ? locatorOrPage.locator(s) : s));
    const found = await findFirstVisible(candidates, timeout);
    if (!found) throw new Error('no visible selector found from candidates');
    await safeClickWithOpts(found);
  } else {
    const opts = (selectorsArgOrOpts && typeof selectorsArgOrOpts === 'object') ? selectorsArgOrOpts : {};
    await safeClickWithOpts(locatorOrPage, { timeout: opts.timeout || timeout, clickCount: opts.clickCount });
  }
}`;

/** Return the helper file body for the requested module style ('ts' = ESM, 'js' = CJS, 'esm-js' = ESM JS). */
function testHelpersFile(ext = 'ts') {
  if (ext === 'js') {
    return `// QAAI defensive helpers for generated Playwright specs (CommonJS).\n${BODY}\n\nmodule.exports = { findFirstVisible, safeGoto, safeClick: safeClickWithOpts, safeClickWithOpts, clickFirstVisible };\n`;
  }
  // TS/ESM and JS/ESM: identical bodies, exported. Plain-JS bodies are valid TypeScript.
  return `// QAAI defensive helpers for generated Playwright specs.\n${BODY.replace(/^async function /gm, 'export async function ')}\nexport { safeClickWithOpts as safeClick };\n`;
}

module.exports = { testHelpersFile };
