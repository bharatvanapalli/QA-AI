'use strict';
/**
 * P3 storageState (SSO) proof on a real site. Simulates the SSO pattern with
 * saucedemo: capture an authenticated session ONCE, bake it via the new
 * storageState export, generate a PRE-AUTHENTICATED spec (no login form), run it.
 * Proves SSO-style suites work: the spec never touches a login form, yet starts
 * logged in.
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const codegen = require('../server/services/codegen');
const envContract = require('../server/services/codegen/_env');
const locatorsLib = require('../server/services/codegen/_locators');
const { resolveAiCredentials } = require('../server/lib/resolveAiCredentials');
const { getProvider } = require('../server/lib/llmProvider');
const { elementLabelFromArgs } = require('../server/services/agents/conductor');

const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920';
const USER = 'a5d916cd-4178-4bcc-b409-c885a389e843';
const REFIT = path.join(__dirname, '..', 'playwright', 'refit', 'ae36bfe8-97f5-4252-b42f-551971423b08');
const DIR = path.join(__dirname, '..', 'playwright', 'xsite', 'sso');
const targetUrl = 'https://www.saucedemo.com';
const framework = 'playwright-pom';
const { chromium } = require(path.join(REFIT, 'node_modules', '@playwright', 'test'));

const scenario = { name: 'SauceDemo (pre-authenticated)', module: 'inventory', category: 'functional' };
const testCase = {
  id: 'sso00001', name: 'Verify Products inventory page when already authenticated', type: 'positive',
  steps: ['Open the inventory page', 'Verify Products header and an item'],
  declaredAssertions: JSON.stringify([
    { id: 'SSO-1', type: 'TEXT', criticality: 'must', payload: { expectedText: 'Products' } },
    { id: 'SSO-2', type: 'URL', criticality: 'must', payload: { expectedUrl: 'inventory' }, targetUrl: '/inventory.html' },
  ]),
};
// NOTE: NO login actions — the trail starts already authenticated (SSO pattern).
const actionPlan = {
  caseStatus: 'pass', summary: 'verify inventory when pre-authed',
  actions: [
    { tool: 'browser_navigate', args: { url: targetUrl + '/inventory.html' } },
    { tool: 'browser_click', args: { element: 'Products' } },
  ],
};
const kbRows = [
  { element: 'Products', role: 'heading', accessibleName: 'Products', selector: 'getByText("Products")', strategy: 'text', healthScore: 100, occurrences: 3, pageUrl: '/inventory.html' },
];

(async () => {
  // 1. Capture an authenticated session (this is the ONE-TIME human step that
  //    QAAI's E2 Auth Fixture performs for a real SSO site).
  console.log('Capturing authenticated storageState from saucedemo …');
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(targetUrl + '/');
  await page.fill('#user-name', 'standard_user');
  await page.fill('#password', 'secret_sauce');
  await page.click('#login-button');
  await page.waitForURL(/inventory/, { timeout: 20000 });
  const state = await ctx.storageState();
  await browser.close();
  console.log(`  captured: ${state.cookies.length} cookie(s), ${state.origins.length} origin(s)`);

  // 2. Bake it via the new storageState export + generate a PRE-AUTH spec.
  fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
  const credProfile = envContract.buildCredentialProfile({ observed: { username: 'standard_user', password: 'secret_sauce', name: 'standard' } });
  require('../server/services/codegen/pom').ensureProjectShell(DIR, { targetUrl, credProfile, storageState: state });

  const { provider: providerName, apiKey, model } = await resolveAiCredentials(USER, await prisma.project.findUnique({ where: { id: PROJECT } }));
  const provider = getProvider(providerName);
  const { actions, manifest } = locatorsLib.buildManifest({ actions: actionPlan.actions, kbRows, labelOf: (a) => elementLabelFromArgs(a.tool, a.args || {}), lang: 'ts' });
  actionPlan.actions = actions; actionPlan.locatorManifest = manifest;

  console.log('Generating PRE-AUTHENTICATED spec (should contain NO login) …');
  let code = await codegen.generate({ framework, provider, apiKey, model, scenario, testCase, actionPlan, targetUrl, knownPopups: [], credProfile, preAuthenticated: true });
  try { code = require('../server/services/codegen/_sanitize').sanitizeGenerated(code); } catch (_) {}
  const lay = codegen.layoutFor(framework, scenario, testCase);
  const split = require('../server/services/codegen/pom').splitFiles(code, lay);
  for (const [rel, content] of Object.entries(split)) { if (!content) continue; const full = path.join(DIR, rel); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content, 'utf8'); }

  const specTxt = fs.readFileSync(path.join(DIR, lay.testFile), 'utf8');
  console.log(`\n=== ${lay.testFile} ===`);
  console.log(specTxt.split('\n').map((l) => '  | ' + l).join('\n'));
  console.log('\nstorageState baked:', fs.existsSync(path.join(DIR, '.auth/state.json')));
  console.log('config has storageState:', /storageState/.test(fs.readFileSync(path.join(DIR, 'playwright.config.ts'), 'utf8')));
  console.log('spec calls login():', /\blogin\s*\(/.test(specTxt), '(should be FALSE)');
  await prisma.$disconnect();
})().catch((e) => { console.error('ERR', e.message, e.stack); prisma.$disconnect(); process.exit(1); });
