'use strict';
/**
 * CROSS-SITE proof: run the SAME codegen pipeline against a DIFFERENT website
 * (saucedemo.com, not OrangeHRM) to show the fixes are app-agnostic. Authors a
 * fresh login from saucedemo's trace, replays its locators, generates a spec.
 * Writes into playwright/xsite/saucedemo (generation only; run separately).
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const codegen = require('../server/services/codegen');
const envContract = require('../server/services/codegen/_env');
const loginLib = require('../server/services/codegen/_login');
const locatorsLib = require('../server/services/codegen/_locators');
const { resolveAiCredentials } = require('../server/lib/resolveAiCredentials');
const { getProvider } = require('../server/lib/llmProvider');
const { elementLabelFromArgs } = require('../server/services/agents/conductor');

const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920'; // only used to resolve the API key
const USER = 'a5d916cd-4178-4bcc-b409-c885a389e843';
const DIR = path.join(__dirname, '..', 'playwright', 'xsite', 'saucedemo');
const targetUrl = 'https://www.saucedemo.com';
const framework = 'playwright-pom';

// A realistic saucedemo case: log in, land on the inventory page.
const scenario = { name: 'SauceDemo login', module: 'auth', category: 'functional' };
const testCase = {
  id: 'sauce0001', name: 'Login as standard user and verify the Products inventory page', type: 'positive',
  steps: ['Go to the site', 'Enter username and password', 'Click Login', 'Verify the Products page'],
  declaredAssertions: JSON.stringify([
    { id: 'SD-1', type: 'TEXT', criticality: 'must', payload: { expectedText: 'Products' } },
    { id: 'SD-2', type: 'URL', criticality: 'must', payload: { expectedUrl: 'inventory' }, targetUrl: '/inventory.html' },
  ]),
};
const actionPlan = {
  caseStatus: 'pass',
  summary: 'login then verify inventory',
  actions: [
    { tool: 'browser_navigate', args: { url: targetUrl + '/' } },
    { tool: 'browser_type', args: { element: 'Username', text: 'standard_user' } },
    { tool: 'browser_type', args: { element: 'Password', text: 'secret_sauce' } },
    { tool: 'browser_click', args: { element: 'Login' } },
  ],
};
// KB rows as recordSuccessfulLocator would have captured them on saucedemo.
const kbRows = [
  { element: 'Username', role: 'textbox', accessibleName: 'Username', selector: 'getByPlaceholder("Username")', strategy: 'placeholder', healthScore: 100, occurrences: 5, pageUrl: '/' },
  { element: 'Password', role: null, accessibleName: 'Password', selector: 'getByPlaceholder("Password")', strategy: 'placeholder', healthScore: 100, occurrences: 5, pageUrl: '/' },
  { element: 'Login', role: 'button', accessibleName: 'Login', selector: 'getByRole("button", { name: "Login" })', strategy: 'role', healthScore: 100, occurrences: 5, pageUrl: '/' },
];

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const credProfile = envContract.buildCredentialProfile({ observed: { username: 'standard_user', password: 'secret_sauce', name: 'standard' } });
  const loginContext = loginLib.extractLoginContext(actionPlan, targetUrl);
  console.log(`Cross-site target: ${targetUrl}  ·  login path ${loginContext.loginPath}  ·  creds ${credProfile.users[0].username}`);

  const { provider: providerName, apiKey, model } = await resolveAiCredentials(USER, await prisma.project.findUnique({ where: { id: PROJECT } }));
  const provider = getProvider(providerName);

  require('../server/services/codegen/pom').ensureProjectShell(DIR, { targetUrl, credProfile });
  const authInfo = await loginLib.ensureAuthModule({ projectRoot: DIR, framework, provider, apiKey, model, loginContext, credProfile, targetUrl, fs, path });

  const { actions, manifest } = locatorsLib.buildManifest({ actions: actionPlan.actions, kbRows, labelOf: (a) => elementLabelFromArgs(a.tool, a.args || {}), lang: 'ts' });
  actionPlan.actions = actions; actionPlan.locatorManifest = manifest;

  console.log(`Generating spec via ${providerName}/${model} …`);
  let code = await codegen.generate({ framework, provider, apiKey, model, scenario, testCase, actionPlan, targetUrl, knownPopups: [], credProfile, authInfo });
  try { code = require('../server/services/codegen/_sanitize').sanitizeGenerated(code); } catch (_) {}
  const lay = codegen.layoutFor(framework, scenario, testCase);
  const split = require('../server/services/codegen/pom').splitFiles(code, lay);
  for (const [rel, content] of Object.entries(split)) { if (!content) continue; const full = path.join(DIR, rel); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content, 'utf8'); }

  // show the authored login + the spec
  console.log('\n=== utils/auth.ts (authored fresh for saucedemo) ===');
  console.log(fs.readFileSync(path.join(DIR, 'utils/auth.ts'), 'utf8').split('\n').slice(0, 30).map((l) => '  | ' + l).join('\n'));
  console.log('\n=== ' + lay.testFile + ' ===');
  console.log(fs.readFileSync(path.join(DIR, lay.testFile), 'utf8').split('\n').map((l) => '  | ' + l).join('\n'));
  console.log('\nGenerated into ' + DIR);
  await prisma.$disconnect();
})().catch((e) => { console.error('ERR', e.message, e.stack); prisma.$disconnect(); process.exit(1); });
