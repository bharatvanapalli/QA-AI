'use strict';

/**
 * Browser service — headed Chromium with CDP screencast + element picker.
 *
 * - startSession(): launches a real Playwright chromium browser, opens a context+page,
 *   navigates to the targetUrl, hooks Page.startScreencast over CDP, and forwards
 *   frames to the caller via onFrame(base64Jpeg, meta).
 * - executeAction(): runs a single agent-tool call (navigate/click/fill/expect_visible/...)
 * - screenshot(): captures a still and saves it to /artifacts/<runId>/
 * - armPicker(): injects the element-picker overlay JS; the user can hover/click
 *   to pick a locator and we return a ranked candidate list.
 *
 * If Playwright/Chromium isn't available the import is lazy and startSession()
 * throws with a clean error code — Conductor falls back to dry-run mode.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'playwright', 'test-results', 'live');
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

let _playwright = null;
function getPlaywright() {
  if (_playwright !== null) return _playwright;
  try {
    _playwright = require('playwright');
  } catch (_) {
    try {
      _playwright = require('@playwright/test');
    } catch (__) {
      _playwright = false;
    }
  }
  return _playwright;
}

/**
 * Start a live browser session.
 * @returns {Promise<{ id, browser, context, page, cdp, onFrame, viewport, pickerArmed: boolean, frameCount: number, viewport }>}
 */
async function startSession({ userId, targetUrl, onFrame }) {
  const pw = getPlaywright();
  if (!pw) {
    const err = new Error('Playwright not installed');
    err.code = 'PLAYWRIGHT_MISSING';
    throw err;
  }

  const viewport = { width: 1280, height: 720 };
  const browser = await pw.chromium.launch({
    headless: false,
    args: ['--no-default-browser-check', '--no-first-run', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  // CDP screencast
  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 60,
    maxWidth: viewport.width,
    maxHeight: viewport.height,
    everyNthFrame: 2,
  });
  cdp.on('Page.screencastFrame', async (params) => {
    try {
      if (onFrame) onFrame(params.data, { sessionId: params.sessionId, ts: Date.now() });
      await cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId });
    } catch (_) {}
  });

  // Network log — populated for the duration of one test case, cleared between cases.
  const networkLog = [];
  page.on('response', async (response) => {
    try {
      const req = response.request();
      networkLog.push({
        url: response.url(),
        method: req.method(),
        status: response.status(),
        ms: Date.now(),
        resourceType: req.resourceType(),
      });
      // Cap to last 500 entries to bound memory
      if (networkLog.length > 500) networkLog.splice(0, networkLog.length - 500);
    } catch (_) {}
  });

  // Navigate to initial URL
  if (targetUrl) {
    try { await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }); } catch (_) {}
  }

  const session = {
    id: crypto.randomBytes(8).toString('hex'),
    userId,
    browser,
    context,
    page,
    cdp,
    viewport,
    pickerArmed: false,
    pickerCallback: null,
    frameCount: 0,
    networkLog,
  };
  return session;
}

/**
 * Start a fresh network capture window. Returns the array reference so the
 * caller can read the entries at any point.
 */
function startNetworkCapture(session) {
  session.networkLog.length = 0;
  return session.networkLog;
}

function getNetworkSnapshot(session) {
  // Return a defensive copy
  return session.networkLog.map((e) => ({ ...e }));
}

async function stopSession(session) {
  try { await session.cdp.send('Page.stopScreencast'); } catch (_) {}
  try { await session.context.close(); } catch (_) {}
  try { await session.browser.close(); } catch (_) {}
}

/**
 * Execute an agent-tool action.
 * Locators in `action.args.locator` are Playwright locator EXPRESSIONS as strings,
 * e.g. 'getByRole("button", { name: "Sign in" })'. We safely eval them against `page`.
 */
async function executeAction(session, action) {
  const { page } = session;
  const tool = action.tool;
  const args = action.args || {};

  if (tool === 'navigate') {
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    return;
  }
  if (tool === 'press') {
    await page.keyboard.press(args.key);
    return;
  }
  if (tool === 'snapshot') {
    return; // Screenshots taken externally
  }
  if (tool === 'expect_api') {
    // Look at the network log captured during the test for a matching response.
    const want = args || {};
    const matches = (session.networkLog || []).filter((e) => {
      if (want.urlContains && !e.url.includes(want.urlContains)) return false;
      if (want.method && e.method.toUpperCase() !== want.method.toUpperCase()) return false;
      if (want.status && Number(e.status) !== Number(want.status)) return false;
      if (want.statusRange) {
        const lo = Number(want.statusRange[0] ?? 200);
        const hi = Number(want.statusRange[1] ?? 299);
        if (e.status < lo || e.status > hi) return false;
      }
      return true;
    });
    if (matches.length === 0) {
      const err = new Error(`API assertion failed: no response matched ${JSON.stringify(want)}`);
      err.code = 'API_ASSERTION_FAILED';
      throw err;
    }
    return;
  }
  if (tool === 'expect_dom') {
    // Assert a DOM attribute / property value on a locator (e.g. disabled, value, aria-expanded).
    const locator = await safeResolveLocator(page, args.locator);
    if (!locator) {
      const err = new Error(`Locator invalid: ${args.locator}`);
      err.code = 'LOCATOR_INVALID';
      throw err;
    }
    const attr = args.attribute || 'value';
    const want = String(args.value ?? args.valueContains ?? '');
    let got;
    try {
      if (attr === 'value' || attr === 'textContent' || attr === 'innerText') {
        got = await locator.first().inputValue({ timeout: 5_000 }).catch(() => null);
        if (got == null) got = await locator.first().innerText({ timeout: 5_000 });
      } else {
        got = await locator.first().getAttribute(attr, { timeout: 5_000 });
      }
    } catch (err) {
      if (err.name === 'TimeoutError') {
        err.code = 'LOCATOR_NOT_FOUND';
      }
      throw err;
    }
    const ok = args.valueContains
      ? String(got || '').toLowerCase().includes(want.toLowerCase())
      : String(got) === want;
    if (!ok) {
      const err = new Error(`DOM assertion failed: ${attr}="${got}" did not match "${want}"`);
      err.code = 'ASSERTION_FAILED';
      throw err;
    }
    return;
  }

  // Locator-based actions
  const locator = await safeResolveLocator(page, args.locator);
  if (!locator) {
    const err = new Error(`Locator could not be resolved: ${args.locator}`);
    err.code = 'LOCATOR_INVALID';
    throw err;
  }

  try {
    if (tool === 'click')           return await locator.click({ timeout: 8_000 });
    if (tool === 'fill')            return await locator.fill(args.value ?? '', { timeout: 8_000 });
    if (tool === 'wait_for')        return await locator.waitFor({ state: args.state || 'visible', timeout: 10_000 });
    if (tool === 'expect_visible')  return await locator.first().waitFor({ state: 'visible', timeout: 5_000 });
    if (tool === 'expect_text') {
      const text = await locator.first().innerText({ timeout: 5_000 });
      if (!String(text).toLowerCase().includes(String(args.text || '').toLowerCase())) {
        const err = new Error(`Text "${args.text}" not found in element (saw: "${text.slice(0, 60)}…")`);
        err.code = 'ASSERTION_FAILED';
        throw err;
      }
      return;
    }
  } catch (err) {
    if (err.name === 'TimeoutError' || /timeout/i.test(err.message)) {
      err.code = err.code || 'LOCATOR_NOT_FOUND';
    }
    throw err;
  }

  const err = new Error(`Unsupported tool: ${tool}`);
  err.code = 'UNSUPPORTED_TOOL';
  throw err;
}

/**
 * Safely resolve a Playwright locator-expression string against `page`.
 * Accepts: getByRole(...), getByTestId(...), getByLabel(...), getByText(...),
 *          getByPlaceholder(...), getByTitle(...), locator(<selector>)
 */
async function safeResolveLocator(page, expr) {
  if (!expr || typeof expr !== 'string') return null;
  const trimmed = expr.trim();

  // Match a chain like `getByRole("button", { name: "Sign in" }).first()`
  // We allow a single optional .first() / .last() / .nth(N) chain.
  const FN_RE = /^(getBy(?:Role|TestId|Label|Text|Placeholder|Title|AltText))\((.*)\)(?:\.(first|last|nth)\(([^)]*)\))?$/s;
  const m = trimmed.match(FN_RE);
  if (m) {
    const [, fnName, argsStr, chain, chainArg] = m;
    const args = parseLocatorArgs(argsStr);
    let l;
    try {
      l = page[fnName](...args);
    } catch (e) {
      return null;
    }
    if (chain === 'first') l = l.first();
    else if (chain === 'last') l = l.last();
    else if (chain === 'nth') {
      const n = parseInt(chainArg, 10);
      l = Number.isFinite(n) ? l.nth(n) : l.first();
    }
    return l;
  }
  // Fallback: page.locator("...") or raw CSS
  const LOC_RE = /^locator\(['"]([^'"]+)['"]\)$/;
  const lm = trimmed.match(LOC_RE);
  if (lm) return page.locator(lm[1]);
  // Last resort: assume the whole string is a CSS selector
  return page.locator(trimmed);
}

/**
 * Very lightweight argument parser for getByX() calls.
 *   getByRole("button", { name: "Sign in" })  →  ['button', { name: 'Sign in' }]
 *   getByTestId("cart")                       →  ['cart']
 *   getByText(/welcome/i)                     →  [/welcome/i]
 */
function parseLocatorArgs(raw) {
  // Replace double-quoted strings with single-quoted to make JSON-ish parsing easier
  const src = `[${raw}]`;
  // Try strict JSON first
  try {
    return JSON.parse(src);
  } catch (_) {}
  // Try a relaxed eval restricted to literals
  try {
    // eslint-disable-next-line no-new-func
    return Function(`"use strict";return (${src});`)();
  } catch (_) {
    // Fallback: split by top-level comma
    return raw.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
  }
}

/**
 * Take a screenshot of the page and save it under /artifacts/live/.
 * Returns the URL path to be embedded in RunResult.screenshots.
 */
async function screenshot(session, label) {
  try {
    const safe = String(label || crypto.randomBytes(4).toString('hex')).replace(/[^a-zA-Z0-9_-]/g, '_');
    const file = path.join(ARTIFACT_DIR, `${safe}.png`);
    await session.page.screenshot({ path: file, fullPage: false });
    return '/artifacts/live/' + path.basename(file);
  } catch (_) {
    return null;
  }
}

/**
 * Arm the element picker. Injects overlay JS that highlights hovered elements
 * and, on click, computes ranked locator candidates and POSTs them back via
 * `window.__qaai_pick(candidates)` — which we wire to `pickerCallback`.
 */
async function armPicker(session, callback) {
  const { page } = session;
  if (session.pickerArmed) {
    // Re-bind callback
    session.pickerCallback = callback;
    return;
  }
  await page.exposeFunction('__qaai_pick', (candidates) => {
    if (session.pickerCallback) session.pickerCallback(candidates);
  });
  await page.evaluate(() => {
    if (window.__qaai_pickerInstalled) return;
    window.__qaai_pickerInstalled = true;

    const style = document.createElement('style');
    style.textContent = `
      .__qaai_hover_outline { outline: 2px solid #10b981 !important; outline-offset: 1px !important; cursor: crosshair !important; }
      #__qaai_picker_banner {
        position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
        background: rgba(16,185,129,0.95); color: white; font: 600 12px/1.4 system-ui;
        padding: 8px 12px; text-align: center; letter-spacing: 0.04em; text-transform: uppercase;
      }
    `;
    document.head.appendChild(style);

    const banner = document.createElement('div');
    banner.id = '__qaai_picker_banner';
    banner.textContent = 'PICK MODE — hover an element, click to capture';
    document.body.appendChild(banner);

    let last = null;
    const clearOutline = () => { if (last) last.classList.remove('__qaai_hover_outline'); last = null; };
    const onMove = (e) => {
      const el = e.target;
      if (!el || el === banner) return;
      if (el === last) return;
      clearOutline();
      el.classList.add('__qaai_hover_outline');
      last = el;
    };
    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = e.target;
      if (!el || el === banner) return;
      const candidates = computeLocators(el);
      window.__qaai_pick(candidates);
      // Tear down on capture
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      banner.remove();
      style.remove();
      clearOutline();
      window.__qaai_pickerInstalled = false;
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);

    function computeLocators(el) {
      const out = [];
      const role = el.getAttribute('role') || implicitRole(el);
      const name = el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 60);
      const testId = el.getAttribute('data-testid');
      const placeholder = el.getAttribute('placeholder');
      const title = el.getAttribute('title');
      const idAttr = el.getAttribute('id');

      if (testId) out.push({ strategy: 'testid', expression: `getByTestId("${testId}")`, stability: 98 });
      if (role && name) out.push({ strategy: 'role', expression: `getByRole("${role}", { name: ${JSON.stringify(name)} })`, stability: 92 });
      if (placeholder) out.push({ strategy: 'placeholder', expression: `getByPlaceholder(${JSON.stringify(placeholder)})`, stability: 80 });
      if (title) out.push({ strategy: 'title', expression: `getByTitle(${JSON.stringify(title)})`, stability: 75 });
      if (name && name.length < 80 && /\S/.test(name)) out.push({ strategy: 'text', expression: `getByText(${JSON.stringify(name)})`, stability: 65 });
      if (idAttr) out.push({ strategy: 'css', expression: `locator("#${idAttr}")`, stability: 60 });

      // CSS fallback
      out.push({ strategy: 'css', expression: `locator(${JSON.stringify(cssPath(el))})`, stability: 30 });
      return out;

      function implicitRole(e) {
        const tag = e.tagName.toLowerCase();
        return ({ button: 'button', a: 'link', input: 'textbox', textarea: 'textbox', select: 'combobox' })[tag] || null;
      }
      function cssPath(e) {
        const parts = [];
        while (e && e !== document.body && parts.length < 6) {
          let part = e.tagName.toLowerCase();
          if (e.id) { part += `#${e.id}`; parts.unshift(part); break; }
          if (e.className && typeof e.className === 'string') part += '.' + e.className.split(/\s+/).slice(0, 2).join('.');
          parts.unshift(part);
          e = e.parentElement;
        }
        return parts.join(' > ');
      }
    }
  });
  session.pickerArmed = true;
  session.pickerCallback = callback;
}

/**
 * Page accessibility snapshot — enumerates every interactable element on the
 * current page with its accessible name, role, testid, placeholder, type, id.
 * This is what Claude needs to write REAL locators instead of guessing.
 */
async function snapshot(session) {
  if (!session?.page) return null;
  try {
    return await session.page.evaluate(() => {
      const selectors = [
        'button', 'a[href]', 'input:not([type="hidden"])', 'textarea', 'select',
        '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="combobox"]',
        '[role="checkbox"]', '[role="radio"]', '[role="tab"]', '[role="menuitem"]',
        '[role="option"]', '[role="searchbox"]',
        '[data-testid]', '[data-test]', '[data-cy]',
        '[contenteditable="true"]', 'label',
      ];

      const implicitRole = (el) => {
        const tag = el.tagName.toLowerCase();
        if (tag === 'button') return 'button';
        if (tag === 'a' && el.href) return 'link';
        if (tag === 'input') {
          const t = (el.type || 'text').toLowerCase();
          if (t === 'checkbox') return 'checkbox';
          if (t === 'radio') return 'radio';
          if (t === 'submit' || t === 'button') return 'button';
          if (t === 'search') return 'searchbox';
          return 'textbox';
        }
        if (tag === 'textarea') return 'textbox';
        if (tag === 'select') return 'combobox';
        return null;
      };

      const accessibleName = (el) => {
        if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const labelEl = document.getElementById(labelledBy);
          if (labelEl) return labelEl.textContent.trim();
        }
        if (el.id) {
          const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (lbl) return lbl.textContent.trim();
        }
        const wrap = el.closest('label');
        if (wrap) return wrap.textContent.trim();
        if (el.title) return el.title;
        if (el.tagName.toLowerCase() === 'input' && el.value &&
            ['button', 'submit'].includes((el.type || '').toLowerCase())) {
          return el.value;
        }
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        return text;
      };

      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
        return true;
      };

      const result = [];
      const seen = new Set();
      let idx = 0;
      const MAX = 100;

      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (idx >= MAX) break;
          if (seen.has(el)) continue;
          seen.add(el);
          if (!isVisible(el)) continue;
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role') || implicitRole(el);
          const name = (accessibleName(el) || '').slice(0, 80).trim();
          const testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy') || null;
          const placeholder = el.getAttribute('placeholder');
          const inputType = el.type || null;
          const id = el.id || null;
          const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
          if (!role && !name && !testId && !placeholder && !id) continue;
          result.push({ idx: idx++, tag, role: role || tag, name, testId, placeholder, inputType, id, disabled });
        }
        if (idx >= MAX) break;
      }

      return {
        url: window.location.href,
        title: document.title,
        heading: document.querySelector('h1, h2')?.textContent?.trim().slice(0, 120) || null,
        elements: result,
      };
    });
  } catch (_) {
    return null;
  }
}

/**
 * Format a snapshot as a compact human/AI-readable text block.
 */
function formatSnapshotForPrompt(snap) {
  if (!snap || !snap.elements?.length) return '(no snapshot available)';
  const lines = [
    `URL: ${snap.url}`,
    `Title: ${snap.title}`,
    snap.heading ? `Heading: ${snap.heading}` : null,
    `Elements (${snap.elements.length} interactable):`,
    ...snap.elements.map((e) => {
      const parts = [`[${e.idx}] ${e.role}`];
      if (e.name) parts.push(`"${e.name}"`);
      if (e.testId) parts.push(`testid="${e.testId}"`);
      if (e.placeholder) parts.push(`placeholder="${e.placeholder}"`);
      if (e.inputType && e.inputType !== 'text') parts.push(`type=${e.inputType}`);
      if (e.id) parts.push(`#${e.id}`);
      if (e.disabled) parts.push('(disabled)');
      return '  ' + parts.join(' ');
    }),
  ].filter(Boolean);
  return lines.join('\n');
}

module.exports = {
  startSession, stopSession, executeAction, screenshot, armPicker,
  startNetworkCapture, getNetworkSnapshot,
  snapshot, formatSnapshotForPrompt,
};
