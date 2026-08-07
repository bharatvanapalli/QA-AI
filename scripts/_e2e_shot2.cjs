'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { chromium } = require('playwright');

const EMAIL = 'bharatvanapalli8@gmail.com';
const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const RUN_ID = '15fa3e3b-62ac-413c-95b4-791e0665bbe8';
const APP = 'http://localhost:5173';
const OUT = path.join(__dirname, '..', 'playwright', 'test-results', 'e2e-shots');
const prisma = new PrismaClient();

async function launch() {
  for (const ch of ['chrome', 'msedge']) {
    try { return await chromium.launch({ headless: true, channel: ch, args: ['--no-sandbox'] }); }
    catch (_) {}
  }
  return chromium.launch({ headless: true, args: ['--no-sandbox'] });
}

async function shot(page, route, name, wait = 1500) {
  await page.goto(APP + route, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(wait);
  const dest = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: dest, fullPage: true });
  console.log(`  ✓ ${name.padEnd(25)} → ${page.url().replace(APP, '')}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const user = await prisma.user.findFirst({ where: { email: EMAIL }, select: { id: true, email: true, role: true } });
  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '2h' });

  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
  await ctx.addCookies([{ name: 'token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
  await ctx.addInitScript((pid) => { try { localStorage.setItem('qaai.currentProjectId', pid); } catch (_) {} }, PROJECT_ID);

  const page = await ctx.newPage();
  console.log(`\nE2E deep shots — ${EMAIL}`);
  console.log('='.repeat(60));

  try {
    // Reports with specific run
    await shot(page, `/reports?runId=${RUN_ID}`, 'A_reports_run', 2000);

    // Scroll down on reports to see the full case list
    await page.evaluate(() => window.scrollTo(0, 600));
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, 'B_reports_scrolled.png'), fullPage: false });
    console.log(`  ✓ B_reports_scrolled`);

    // Click on a FAIL case to see Verdict & Evidence tab
    const failRow = page.locator('text=fail').first();
    if (await failRow.count()) {
      await failRow.click().catch(() => {});
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(OUT, 'C_fail_case_detail.png'), fullPage: true });
      console.log(`  ✓ C_fail_case_detail`);
      // Click Verdict & Evidence tab
      const verdictTab = page.locator('button:has-text("Verdict"), [role="tab"]:has-text("Verdict")').first();
      if (await verdictTab.count()) {
        await verdictTab.click().catch(() => {});
        await page.waitForTimeout(800);
        await page.screenshot({ path: path.join(OUT, 'D_verdict_evidence.png'), fullPage: true });
        console.log(`  ✓ D_verdict_evidence`);
      }
    }

    // Blocked page - try the actual route from the app
    await shot(page, '/blocked-items', 'E_blocked_items');

    // Try /blocked directly
    await shot(page, '/blocked', 'F_blocked_direct');

    // Run Suite page
    await shot(page, '/run-suite', 'G_run_suite');

    // Knowledge Base
    await shot(page, '/knowledge-base', 'H_knowledge_base');

    console.log('\n  Done. Saved to playwright/test-results/e2e-shots/');
  } finally {
    await browser.close().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
})().catch(async (e) => { console.error('ERROR:', e.message); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
