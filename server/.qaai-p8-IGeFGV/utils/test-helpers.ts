// QAAI defensive helpers for generated Playwright specs.
export async function findFirstVisible(candidates, timeout = 2000) {
  for (const loc of candidates) {
    try { if (await loc.isVisible({ timeout }).catch(() => false)) return loc; } catch (_) {}
  }
  return null;
}

export async function safeGoto(page, url, opts = {}) {
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

export async function safeClick(locator, opts) {
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

export async function clickFirstVisible(locatorOrPage, selectorsArgOrOpts, timeout = 2000) {
  if (Array.isArray(selectorsArgOrOpts)) {
    const candidates = selectorsArgOrOpts.map((s) => (typeof s === 'string' ? locatorOrPage.locator(s) : s));
    const found = await findFirstVisible(candidates, timeout);
    if (!found) throw new Error('no visible selector found from candidates');
    await safeClick(found);
  } else {
    const opts = (selectorsArgOrOpts && typeof selectorsArgOrOpts === 'object') ? selectorsArgOrOpts : {};
    await safeClick(locatorOrPage, { timeout: opts.timeout || timeout, clickCount: opts.clickCount });
  }
}
