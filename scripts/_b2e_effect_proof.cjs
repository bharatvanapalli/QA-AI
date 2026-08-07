'use strict';
/*
 * B-2e LIVE integration proof for the precision dispatch path (hooks 5/6 + effect
 * proof). Drives a REAL OrangeHRM login and calls the SAME conductorPrecisionBridge
 * .captureAction the conductor now calls on every action — with REAL before/after
 * EFFECT_PROBE_FN fingerprints. Proves: fill → value readback proven; click Login
 * → navigation proven; each yields a PrecisionActionRecord. Flag ON.
 */
process.env.QAAI_CERTIFIED_ACTION_TARGETS = '1';
const { chromium } = require('playwright');
const bridge = require('../server/services/conductorPrecisionBridge');
const { EFFECT_PROBE_FN } = require('../server/services/postActionEffectProof');
const { DOM_ATLAS_FN } = require('../server/services/cdpSidecar');

const BASE = 'https://opensource-demo.orangehrmlive.com/web/index.php';
async function launch() {
  for (const ch of ['chrome', 'msedge']) { try { return await chromium.launch({ headless: true, channel: ch, args: ['--no-sandbox'] }); } catch (_) {} }
  return chromium.launch({ headless: true, args: ['--no-sandbox'] });
}
const probe = (page) => page.evaluate(`(${EFFECT_PROBE_FN})()`);

(async () => {
  const browser = await launch();
  const page = await browser.newPage();
  const out = { flag: bridge.enabled(), records: [] };
  const cap = (label, rec) => out.records.push({
    label, status: rec && rec.certification && rec.certification.status,
    effect: rec && rec.effectProof && { expected: rec.effectProof.expected, proven: rec.effectProof.proven, kind: rec.effectProof.kind, reason: rec.effectProof.reason },
    locator: rec && rec.locatorPromotionStatus,
    locatorExpr: rec && rec.codeReadyIntent && rec.codeReadyIntent.target && ((rec.codeReadyIntent.target.locator && rec.codeReadyIntent.target.locator.expression) || (rec.codeReadyIntent.target.candidateLocator && rec.codeReadyIntent.target.candidateLocator.expression)) || null,
  });
  try {
    await page.goto(`${BASE}/auth/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByPlaceholder('Username').waitFor({ state: 'visible', timeout: 30000 });
    const atlas = await page.evaluate(`(${DOM_ATLAS_FN})()`);
    const uEntry = (atlas || []).find((e) => e.placeholder === 'Username') || {};

    // ── fill Username → value readback effect proof ──
    let before = await probe(page);
    await page.getByPlaceholder('Username').fill('Admin');
    let after = await probe(page);
    cap('type Username', bridge.captureAction({
      toolName: 'browser_type', args: { text: 'Admin', element: 'Username' }, targetLabel: 'Username',
      placeholder: 'Username', targetTestId: uEntry.testId, targetIdAttr: uEntry.idAttr, inputType: 'text',
      effect: { before, after, valueAfter: after && after.activeValue },
    }));

    // ── fill Password ──
    before = await probe(page);
    await page.getByPlaceholder('Password').fill('admin123');
    after = await probe(page);
    cap('type Password', bridge.captureAction({
      toolName: 'browser_type', args: { text: 'admin123', element: 'Password' }, targetLabel: 'Password',
      placeholder: 'Password', inputType: 'password',
      effect: { before, after, valueAfter: after && after.activeValue },
    }));

    // ── click Login → navigation effect proof ──
    before = await probe(page);
    await page.getByRole('button', { name: 'Login' }).click();
    await page.waitForURL(/dashboard/, { timeout: 20000 }).catch(() => {});
    after = await probe(page);
    cap('click Login', bridge.captureAction({
      toolName: 'browser_click', args: { element: 'Login' }, targetLabel: 'Login',
      effect: { before, after },
    }));

    console.log('B2E_EFFECT_JSON_START');
    console.log(JSON.stringify(out, null, 2));
    console.log('B2E_EFFECT_JSON_END');
  } catch (e) { console.log('B2E_EFFECT_ERROR', String(e && e.message || e)); }
  finally { await browser.close().catch(() => {}); }
})();
