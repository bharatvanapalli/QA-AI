'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const BASE = 'http://localhost:5000';
const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const OLD_RUN_ID = 'cb2836e8-5b06-4044-8328-a4a506d9b98c';
const USER = { sub: 'a5d916cd-4178-4bcc-b409-c885a389e843', email: 'bharatvanapalli8@gmail.com', role: 'user' };

function makeHeaders() {
  const token = jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: '2h' });
  const csrf = crypto.randomBytes(16).toString('hex');
  return { Cookie: `token=${token}; XSRF-TOKEN=${csrf}`, 'x-xsrf-token': csrf };
}

(async () => {
  const filePath = 'tests/authentication/admin-navigation-and-role-based-menu-visibility.spec.js';
  const fileRes = await fetch(
    `${BASE}/api/projects/${PROJECT_ID}/output-files/file/${encodeURIComponent(filePath)}?source=replayir&runId=${OLD_RUN_ID}`,
    { headers: makeHeaders() }
  );
  const wrapper = await fileRes.json().catch(() => ({}));
  const content = wrapper.content || wrapper;

  console.log('=== admin-navigation spec ===\n');
  content.split('\n').forEach((l, i) => console.log(`${String(i+1).padStart(3)}: ${l}`));

  // Checks
  const inlineLocators = content.match(/page\.(getByRole|getByText|getByLabel|getByPlaceholder|locator)\s*\(/g) || [];
  const elVars = content.match(/const el\d+\s*=/g) || [];
  const resolveLocators = content.match(/await resolveLocator\s*\(/g) || [];
  const asnHashes = content.match(/ASN-[a-f0-9]+/g) || [];
  const profileMenuHandled = /userProfile|profile.*button|menu.*button/i.test(content);

  console.log('\n--- QUALITY CHECKS ---');
  console.log(`Q1 inline page.getByRole/locator: ${inlineLocators.length === 0 ? '✓ PASS' : 'FAIL: ' + inlineLocators.length}`);
  console.log(`Q2 el1/el2 vars: ${elVars.length === 0 ? '✓ PASS' : 'FAIL: ' + elVars.join(',')}`);
  console.log(`Q3 ASN hashes: ${asnHashes.length === 0 ? '✓ PASS' : 'FAIL: ' + asnHashes.length}`);
  console.log(`resolveLocator calls: ${resolveLocators.length}`);
  console.log(`Profile/menu button handled: ${profileMenuHandled}`);
})().catch(e => { console.error(String(e)); process.exit(1); });
