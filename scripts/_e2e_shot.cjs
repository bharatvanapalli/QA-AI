'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { chromium } = require('playwright');

const EMAIL = 'bharatvanapalli8@gmail.com';
const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const APP = 'http://localhost:5173';
const OUT = path.join(__dirname, '..', 'playwright', 'test-results', 'e2e-shots');
const prisma = new PrismaClient();

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try { return await chromium.launch({ headless: true, channel, args: ['--no-sandbox'] }); }
    catch (_) {}
  }
  return chromium.launch({ headless: true, args: ['--no-sandbox'] });
}

async function shot(page, route, name) {
  await page.goto(APP + route, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const dest = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: dest, fullPage: true });
  const url = page.url();
  console.log(`  ✓ ${name.padEnd(20)} ${url.replace(APP, '')}`);
  return dest;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const user = await prisma.user.findFirst({ where: { email: EMAIL }, select: { id: true, email: true, role: true } });
  if (!user) throw new Error('User not found: ' + EMAIL);
  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '2h' });

  const browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, baseURL: APP });
  await context.addCookies([{ name: 'token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
  await context.addInitScript((pid) => {
    try { localStorage.setItem('qaai.currentProjectId', pid); } catch (_) {}
  }, PROJECT_ID);

  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  console.log(`\nE2E shots — ${EMAIL} / project ${PROJECT_ID}`);
  console.log('='.repeat(60));

  try {
    await shot(page, '/overview',      '01_overview');
    await shot(page, '/test-cases',    '02_test_cases');
    await shot(page, '/reports',       '03_reports');
    await shot(page, '/blocked',       '04_blocked');
    await shot(page, '/live-pipeline', '05_live_pipeline');
    await shot(page, '/project-setup', '06_project_setup');
    await shot(page, '/output-files',  '07_output_files');

    // Click into the most recent report detail
    await page.goto(APP + '/reports', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
    // Click the first run row
    const firstRun = page.locator('table tbody tr, [data-testid="run-row"], .run-row').first();
    if (await firstRun.count() > 0) {
      await firstRun.click().catch(() => {});
      await page.waitForTimeout(1200);
      await page.screenshot({ path: path.join(OUT, '08_report_detail.png'), fullPage: true });
      console.log(`  ✓ ${'08_report_detail'.padEnd(20)} (report expanded)`);
    }

    const appErrors = errors.filter(e => !/favicon|websocket|ws:\/\/|ResizeObserver|React DevTools/i.test(e));
    console.log(`\n  Console errors: ${appErrors.length}`);
    if (appErrors.length) appErrors.slice(0, 5).forEach(e => console.log('    ' + e.substring(0, 120)));
    console.log(`\n  All shots saved to: playwright/test-results/e2e-shots/`);
  } finally {
    await browser.close().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
})().catch(async (e) => {
  console.error('E2E SHOT ERROR:', e.message);
  try { await prisma.$disconnect(); } catch (_) {}
  process.exit(1);
});
