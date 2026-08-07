'use strict';
/**
 * P4a VISUAL / BROWSER UX smoke — the one acceptance slice the deterministic
 * smokes (_smoke_p4a_approval 12/12, _smoke_p4a_acceptance 11/11) cannot cover:
 * does the Approval UI actually RENDER and read as understandable, not broken?
 *
 * Drives the project's own Playwright (root node_modules) via SYSTEM CHROME
 * (channel:'chrome' — no browser download) against the LIVE frontend (:5173) +
 * backend (:5000).
 *
 * SAFE + additive (mirrors _smoke_p4b_authprofile's seed→prove→teardown):
 *   - Auth: mints a byte-identical session token with jwt.sign({sub,email,role},
 *     JWT_SECRET) — exactly what POST /api/auth/login mints. No password, no new user.
 *   - Seeds ONE throwaway scratch project ("__P4A_UX_SMOKE") with 3 datasets that
 *     exercise every approval state (Approved / Draft-changes / un-mapped) and the
 *     synthetic|masked|restricted sensitivity vocabulary, screenshots them, then
 *     DELETES the scratch project (cascade → datasets + mappings) in finally.
 *     The 3 real projects + their data are never touched ([[preserve-trial-data]]).
 *   - Browser actions are READ-ONLY (view + open version history, a GET). It never
 *     clicks Approve/Reject/Save, so the approve mechanics (already proven 11/11 +
 *     12/12) are not re-exercised here — this is purely a render proof.
 *
 * Output: PNG screenshots + console/network report under
 *   playwright/test-results/p4a-ux-smoke/
 *
 *   node scripts/_smoke_p4a_ux.cjs
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { chromium } = require('playwright');

const APP = process.env.QAAI_UX_APP || 'http://localhost:5173';
const OUT = path.join(__dirname, '..', 'playwright', 'test-results', 'p4a-ux-smoke');
const JWT_SECRET = process.env.JWT_SECRET;
const SCRATCH = '__P4A_UX_SMOKE';
const prisma = new PrismaClient();

const shot = (target, name, opts = {}) =>
  target.screenshot({ path: path.join(OUT, name), ...opts }).then(
    () => console.log(`    · saved ${name}`),
    (e) => console.log(`    ! screenshot ${name} failed: ${e.message}`)
  );

// ── seed shapes (the exact JSON the serializer + Approval UI consume) ──────────
const loginMapping = {
  version: 1,
  bindings: [{
    sheet: 'Logins',
    columnToField: { username: 'Username', password: 'Login Password', role: 'Role', email: 'Email' },
    sensitivity: { username: 'synthetic', password: 'masked', role: 'synthetic', email: 'restricted' },
    confidence: 'high',
  }],
  unmapped: [],
};
const checkoutApproved = {
  version: 1,
  bindings: [{
    sheet: 'Orders',
    columnToField: { email: 'Email', cardNumber: 'Card Number', amount: 'Amount' },
    sensitivity: { email: 'restricted', cardNumber: 'restricted', amount: 'synthetic' },
    confidence: 'high',
  }],
  unmapped: [{ sheet: 'Orders', header: 'Coupon' }],
};
// draft = approved + the Coupon column now mapped → canonical differs → 'draft_unapproved_changes'
const checkoutDraft = {
  version: 1,
  bindings: [{
    sheet: 'Orders',
    columnToField: { email: 'Email', cardNumber: 'Card Number', amount: 'Amount', coupon: 'Coupon' },
    sensitivity: { email: 'restricted', cardNumber: 'restricted', amount: 'synthetic', coupon: 'masked' },
    confidence: 'high',
  }],
  unmapped: [],
};
const sheetsJson = (sheets, warnings = []) => JSON.stringify({
  sheets, warnings, rowCount: sheets.reduce((n, s) => n + (s.rows ? s.rows.length : 0), 0),
});

async function seed(projectId) {
  // 1) APPROVED — draft == approved snapshot → green "Approved" badge + ShieldCheck bar.
  const login = await prisma.testDataSet.create({
    data: {
      projectId, name: 'Login Data.xlsx', rowCount: 3,
      sheetsJson: sheetsJson([{
        name: 'Logins',
        headers: ['Username', 'Login Password', 'Role', 'Email'],
        rows: [
          { Username: 'Admin', 'Login Password': 'admin123', Role: 'Admin', Email: 'admin@corp.test' },
          { Username: 'jdoe', 'Login Password': 'P@ssw0rd!', Role: 'Employee', Email: 'jdoe@corp.test' },
          { Username: 'msmith', 'Login Password': 'Spr1ng#2026', Role: 'Manager', Email: 'msmith@corp.test' },
        ],
      }], ['1 blank row skipped while parsing "Logins".']),
      mappingJson: JSON.stringify(loginMapping),
    },
  });
  await prisma.testDataMapping.create({
    data: {
      testDataSetId: login.id, projectId, version: 1, status: 'approved',
      mappingJson: JSON.stringify(loginMapping),
      verificationJson: JSON.stringify({ ok: true, findings: [
        { severity: 'warning', code: 'mapping_unclear', sheet: 'Logins', header: 'Role', detail: 'Role had low classification confidence; approved with a recorded note.' },
      ] }),
      approvalNote: 'Role values cross-checked against the HR access matrix.',
      approvedBy: 'ux-smoke', approvedAt: new Date(),
    },
  });

  // 2) DRAFT CHANGES — approved v1 exists, draft maps an extra column since → warn badge.
  const checkout = await prisma.testDataSet.create({
    data: {
      projectId, name: 'Checkout Data.xlsx', rowCount: 2,
      sheetsJson: sheetsJson([{
        name: 'Orders',
        headers: ['Email', 'Card Number', 'Amount', 'Coupon'],
        rows: [
          { Email: 'buyer@corp.test', 'Card Number': '4111111111111111', Amount: '149.00', Coupon: 'SAVE10' },
          { Email: 'guest@corp.test', 'Card Number': '5500005555555559', Amount: '32.50', Coupon: '' },
        ],
      }]),
      mappingJson: JSON.stringify(checkoutDraft),
    },
  });
  await prisma.testDataMapping.create({
    data: {
      testDataSetId: checkout.id, projectId, version: 1, status: 'approved',
      mappingJson: JSON.stringify(checkoutApproved),
      verificationJson: JSON.stringify({ ok: true, findings: [] }),
      approvedBy: 'ux-smoke', approvedAt: new Date(Date.now() - 3600_000),
    },
  });

  // 3) UN-MAPPED — no draft, no approved → "Run mapping" empty branch + sheet warning bar.
  await prisma.testDataSet.create({
    data: {
      projectId, name: 'Boundary Data.xlsx', rowCount: 4,
      sheetsJson: sheetsJson([{
        name: 'Boundaries',
        headers: ['Field', 'Min', 'Max', 'Invalid'],
        rows: [
          { Field: 'quantity', Min: '1', Max: '99', Invalid: '0' },
          { Field: 'zip', Min: '5', Max: '5', Invalid: 'abcde' },
        ],
      }], ['2 rows had blank cells and were skipped.']),
      mappingJson: null,
    },
  });
}

async function launchBrowser() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      const b = await chromium.launch({ headless: true, channel, args: ['--no-sandbox'] });
      console.log(`  (browser: system ${channel})`);
      return b;
    } catch (e) { console.log(`  (channel ${channel} unavailable: ${e.message.split('\n')[0]})`); }
  }
  return chromium.launch({ headless: true, args: ['--no-sandbox'] }); // bundled fallback
}

(async () => {
  if (!JWT_SECRET) throw new Error('JWT_SECRET missing from .env');
  fs.mkdirSync(OUT, { recursive: true });
  console.log('\n=== P4a visual/browser UX smoke ===\n');

  const user = await prisma.user.findFirst({ where: { currentOrgId: { not: null } }, orderBy: { createdAt: 'asc' }, select: { id: true, email: true, role: true, currentOrgId: true } });
  if (!user) throw new Error('No user with a currentOrgId.');
  console.log(`  user : ${user.email} (${user.role})  org=${user.currentOrgId}`);

  let scratchId = null;
  let browser = null;
  const report = { user: user.email, steps: [] };
  const step = (label, ok, detail) => { report.steps.push({ label, ok, detail: detail || '' }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); };

  try {
    // clean any stale scratch project from a prior interrupted run
    const stale = await prisma.project.findMany({ where: { orgId: user.currentOrgId, name: SCRATCH }, select: { id: true } });
    for (const s of stale) await prisma.project.delete({ where: { id: s.id } }).catch(() => {});

    const project = await prisma.project.create({
      data: { userId: user.id, orgId: user.currentOrgId, name: SCRATCH, targetUrl: 'https://example.test', updatedAt: new Date() },
    });
    scratchId = project.id;
    console.log(`  scratch project: ${scratchId}`);
    await seed(scratchId);
    step('seeded scratch project (3 datasets: approved / draft-changes / un-mapped)', true);

    const token = jwt.sign({ sub: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '2h' });
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2, baseURL: APP });
    await context.addCookies([{ name: 'token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
    await context.addInitScript((pid) => { try { localStorage.setItem('qaai.currentProjectId', pid); } catch (_) {} }, scratchId);

    const page = await context.newPage();
    const consoleErrors = []; const pageErrors = []; const failedRequests = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.request().method()} ${r.url().replace(APP, '')}`); });

    console.log('\n[1] authenticate + land on /run-suite');
    await page.goto(APP + '/run-suite', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    const onLogin = /\/login/.test(page.url());
    step('authenticated (no redirect to /login)', !onLogin, onLogin ? 'token rejected' : page.url());
    if (onLogin) { await shot(page, '00-login-redirect.png'); throw new Error('Token not accepted.'); }

    console.log('\n[2] Test-data / Approval panel renders');
    const tdHeading = page.getByRole('heading', { name: /^Test data$/i });
    await tdHeading.waitFor({ state: 'visible', timeout: 25_000 });
    await tdHeading.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(700);
    step('"Test data" panel heading visible', true);

    const reviewCount = await page.getByText('Mapping review', { exact: true }).count();
    step('"Mapping review" card(s) rendered', reviewCount >= 1, `${reviewCount} card(s)`);
    await shot(page, '01-runsuite-full.png', { fullPage: true });

    console.log('\n[3] approval-state badges legible');
    for (const lbl of ['Approved', 'Draft changes']) {
      const seen = await page.getByText(lbl, { exact: true }).first().isVisible().catch(() => false);
      step(`state badge "${lbl}" visible`, seen);
    }
    // capture each TestDataSet card element (whole approval surface incl. sensitivity controls)
    const cards = page.locator('article').filter({ has: page.locator('header') });
    const n = await cards.count();
    let captured = 0;
    for (let i = 0; i < n; i++) {
      const c = cards.nth(i);
      if (!(await c.isVisible().catch(() => false))) continue;
      await c.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(200);
      await shot(c, `02-card-${i + 1}.png`);
      captured++;
    }
    step('captured per-dataset card elements', captured >= 1, `${captured} card(s)`);

    console.log('\n[4] open Version history (GET /mappings — read-only)');
    const histBtn = page.getByRole('button', { name: 'Version history' }).first();
    if (await histBtn.isVisible().catch(() => false)) {
      await histBtn.scrollIntoViewIfNeeded().catch(() => {});
      await histBtn.click();
      await page.waitForTimeout(1200);
      await shot(page, '03-version-history.png', { fullPage: true });
      step('version-history opened + captured', true);
    } else { step('version-history button present', false, 'no approved set?'); }

    report.console = { errors: consoleErrors.slice(0, 25), pageErrors: pageErrors.slice(0, 25), failedRequests: failedRequests.slice(0, 25) };
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

    console.log('\n--- runtime health ---');
    step('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    const appErrors = consoleErrors.filter((e) => !/favicon|websocket|ws:\/\/|ResizeObserver|Download the React DevTools/i.test(e));
    step('no application console errors', appErrors.length === 0, appErrors.slice(0, 3).join(' | '));
    const apiFails = failedRequests.filter((r) => /\/api\//.test(r) && !/\b404\b/.test(r));
    step('no failed API calls (excl. 404s)', apiFails.length === 0, apiFails.slice(0, 3).join(' | '));

    const failed = report.steps.filter((s) => !s.ok).length;
    console.log(`\n=== ${failed ? 'ATTENTION' : 'PASS'} — ${report.steps.length - failed}/${report.steps.length} checks; screenshots in playwright/test-results/p4a-ux-smoke/ ===\n`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (scratchId) { await prisma.project.delete({ where: { id: scratchId } }).catch((e) => console.log('  ! teardown:', e.message)); console.log('  (deleted scratch project + cascaded datasets/mappings)'); }
    await prisma.$disconnect().catch(() => {});
  }
})().catch(async (e) => {
  console.error('\nUX SMOKE ERROR:', e.message, '\n', e.stack);
  try { if (prisma) await prisma.$disconnect(); } catch (_) {}
  process.exit(1);
});
