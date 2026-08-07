'use strict';
/**
 * Reusable visual/browser screenshot tool — mints a byte-identical session token
 * (no password, no mutation) for the first currentOrg user and screenshots ANY
 * SPA route via system Chrome. For closing visible-UI bugs + the cross-page
 * run-state audit ([[ui-audit-open-items]], [[browser-ux-smoke-capability]]).
 *
 *   node scripts/_ux_shot.cjs <route> [name] [projectId]
 *   node scripts/_ux_shot.cjs /profile profile
 *   node scripts/_ux_shot.cjs /reports reports <projectId>
 *
 * Output: playwright/test-results/ux-shots/<name>.png + console-error report.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { chromium } = require('playwright');

const route = process.argv[2] || '/overview';
const name = (process.argv[3] || route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'shot');
const projectId = process.argv[4] || null;
const APP = process.env.QAAI_UX_APP || 'http://localhost:5173';
const OUT = path.join(__dirname, '..', 'playwright', 'test-results', 'ux-shots');
const prisma = new PrismaClient();

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try { return await chromium.launch({ headless: true, channel, args: ['--no-sandbox'] }); }
    catch (_) {}
  }
  return chromium.launch({ headless: true, args: ['--no-sandbox'] });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const user = await prisma.user.findFirst({ where: { currentOrgId: { not: null } }, orderBy: { createdAt: 'asc' }, select: { id: true, email: true, role: true } });
  if (!user) throw new Error('No user with a currentOrgId.');
  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '2h' });

  const browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, baseURL: APP });
  await context.addCookies([{ name: 'token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
  if (projectId) await context.addInitScript((pid) => { try { localStorage.setItem('qaai.currentProjectId', pid); } catch (_) {} }, projectId);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  try {
    await page.goto(APP + route, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(700);
    const dest = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: dest, fullPage: true });
    const appErrors = errors.filter((e) => !/favicon|websocket|ws:\/\/|ResizeObserver|React DevTools/i.test(e));
    console.log(`\n  route   : ${route}  (as ${user.email})`);
    console.log(`  url     : ${page.url()}`);
    console.log(`  saved   : ${path.relative(path.join(__dirname, '..'), dest)}`);
    console.log(`  console : ${appErrors.length} app error(s)${appErrors.length ? ' — ' + appErrors.slice(0, 3).join(' | ') : ''}\n`);
  } finally {
    await browser.close().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
})().catch(async (e) => { console.error('UX SHOT ERROR:', e.message); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
