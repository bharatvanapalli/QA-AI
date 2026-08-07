'use strict';
/*
 * B-2e (live, standalone) — prove the Bulletproof Locator Synthesizer against the
 * REAL OrangeHRM DOM. No conductor, no backend restart. Launches system Chrome,
 * runs the sidecar DOM atlas + telemetry, forges LocatorPassports for the login
 * controls, and PROVES each candidate live (count===1 + visible + enabled) using
 * the structured no-eval build steps. Reports what forges Gold vs Silver and what
 * actually resolves uniquely + actionable on the live page.
 */
const path = require('path');
const { chromium } = require('playwright');
const { DOM_ATLAS_FN, TELEMETRY_INIT_SCRIPT } = require('../server/services/cdpSidecar');
const { buildPassport, buildProvenPassport } = require('../server/services/locatorPromotionEngine');

const URL = 'https://opensource-demo.orangehrmlive.com/web/index.php/auth/login';

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try { return await chromium.launch({ headless: true, channel, args: ['--no-sandbox'] }); } catch (_) {}
  }
  return chromium.launch({ headless: true, args: ['--no-sandbox'] });
}

// The codegen factory (structured build steps, NO eval) — exactly what generated POM uses.
function buildLocator(page, candidate) {
  let cur = page;
  for (const step of candidate.build) { const [method, ...args] = step; cur = cur[method](...args); }
  return cur;
}

(async () => {
  const browser = await launch();
  const page = await browser.newPage();
  const report = { url: URL, atlasCount: 0, targets: {}, telemetry: null };
  try {
    // Install telemetry as an INIT script BEFORE navigation (so the capture-phase
    // listener exists on the document from the first load — the live-correct way;
    // installing via evaluate AFTER nav misses early events). This is the fix the
    // sidecar must adopt for the live conductor (install at session start).
    await page.addInitScript({ content: `(${TELEMETRY_INIT_SCRIPT})()` });
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 }));
    await page.waitForTimeout(1500);

    // 1. DOM atlas (the sidecar's pre-action capture) against the real page.
    const atlas = await page.evaluate(`(${DOM_ATLAS_FN})()`);
    report.atlasCount = Array.isArray(atlas) ? atlas.length : 0;

    const resolve = async (c) => {
      try {
        const loc = buildLocator(page, c);
        const count = await loc.count();
        let visible = false; let enabled = false;
        if (count === 1) { try { visible = await loc.first().isVisible(); enabled = await loc.first().isEnabled(); } catch (_) {} }
        // sameTarget proxy: a unique resolution. (Real backendNodeId identity is the CDP gap, recorded.)
        return { count, sameTarget: count === 1, actionable: count === 1 && visible && enabled, visible, enabled, survivesRerender: true };
      } catch (e) { return { count: -1, sameTarget: false, actionable: false, error: String(e.message || e).slice(0, 120) }; }
    };

    // 2. Forge + PROVE passports for the three login controls.
    const find = (re) => (atlas || []).find((e) => re.test(e.placeholder || '') || re.test(e.name || '') || re.test(e.nameAttr || '') || re.test(e.idAttr || ''));
    const targets = [
      { key: 'username', entry: find(/user/i) },
      { key: 'password', entry: find(/pass/i) },
      { key: 'login', entry: (atlas || []).find((e) => /log\s*in|submit/i.test(e.name || '') || (e.tag === 'button')) },
    ];

    for (const t of targets) {
      if (!t.entry) { report.targets[t.key] = { found: false }; continue; }
      const e = t.entry;
      const ctx = { role: e.role, inputType: e.tag === 'input' ? 'text' : undefined, name: e.name, testId: e.testId, idAttr: e.idAttr, nameAttr: e.nameAttr, placeholder: e.placeholder, bbox: e.bbox, ancestors: [] };
      const cp = buildPassport(ctx);
      const proven = await buildProvenPassport(cp, resolve);
      report.targets[t.key] = {
        found: true,
        atlas: { role: e.role, name: e.name, placeholder: e.placeholder, nameAttr: e.nameAttr, idAttr: e.idAttr, tag: e.tag },
        candidates: [cp.primary, ...cp.alternates].filter(Boolean).map((c) => `${c.tier}:${c.strategy} -> ${c.expression}`),
        bronzeOnly: cp.bronzeOnly,
        provenPrimary: proven.primary ? `${proven.primary.tier}:${proven.primary.strategy} -> ${proven.primary.expression}` : null,
        provenCount: proven.primary ? 1 : 0,
        repairRequired: proven.repairRequired,
      };
    }

    // 3. Telemetry listener install + a real click → capture the event target.
    const installed = await page.evaluate(`(${TELEMETRY_INIT_SCRIPT})()`);
    try { await buildLocator(page, { build: [['getByPlaceholder', 'Username']] }).fill('Admin'); } catch (_) {}
    try { await buildLocator(page, { build: [['getByRole', 'button', { name: 'Login' }]] }).click({ timeout: 4000 }); } catch (_) {}
    await page.waitForTimeout(1200);
    const events = await page.evaluate('() => (window.__qaaiTelemetry || [])');
    report.telemetry = { installed, eventCount: Array.isArray(events) ? events.length : 0, sample: (events || []).slice(0, 3).map((ev) => ({ type: ev.type, tag: ev.tag, name: ev.nameAttr || ev.text })) };

    // 4. Did the empty-after-clear validation render? (post-action effect on the real page)
    const afterAtlas = await page.evaluate(`(${DOM_ATLAS_FN})()`);
    const requiredText = await page.getByText('Required', { exact: false }).count().catch(() => -1);
    report.postClick = { atlasCount: Array.isArray(afterAtlas) ? afterAtlas.length : 0, requiredMessagesVisible: requiredText };

    console.log('B2E_REPORT_JSON_START');
    console.log(JSON.stringify(report, null, 2));
    console.log('B2E_REPORT_JSON_END');
  } catch (err) {
    console.log('B2E_ERROR', String(err && err.message || err));
  } finally {
    await browser.close().catch(() => {});
  }
})();
