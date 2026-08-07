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
  const filePath = 'tests/authentication/account-lockout-after-repeated-failed-attempts.spec.js';
  const fileRes = await fetch(
    `${BASE}/api/projects/${PROJECT_ID}/output-files/file/${encodeURIComponent(filePath)}?source=replayir&runId=${OLD_RUN_ID}`,
    { headers: makeHeaders() }
  );
  const wrapper = await fileRes.json().catch(() => ({}));
  const content = wrapper.content || wrapper;

  console.log('=== account-lockout spec ===\n');
  content.split('\n').forEach((l, i) => console.log(`${String(i+1).padStart(3)}: ${l}`));

  const elVars = content.match(/const el\d+\s*=/g) || [];
  const resolveLocators = (content.match(/await resolveLocator\s*\(/g) || []).length;
  const inlineLocators = (content.match(/page\.(getByRole|getByText|locator)\s*\(/g) || []).length;
  // Count how many times usernameTextbox is declared (should be 1 if Q11 works)
  const usernameDeclares = (content.match(/const usernameTextbox\s*=/g) || []).length;
  const passwordDeclares = (content.match(/const passwordTextbox\s*=/g) || []).length;
  const loginBtnDeclares = (content.match(/const loginButton\s*=/g) || []).length;

  console.log('\n--- QUALITY CHECKS ---');
  console.log(`Q1 inline locators: ${inlineLocators === 0 ? '✓ PASS' : 'FAIL: ' + inlineLocators}`);
  console.log(`Q2 el1/el2 vars: ${elVars.length === 0 ? '✓ PASS' : 'FAIL: ' + elVars.join(',')}`);
  console.log(`Q11 usernameTextbox declarations: ${usernameDeclares} (want 1)`);
  console.log(`Q11 passwordTextbox declarations: ${passwordDeclares} (want 1)`);
  console.log(`Q11 loginButton declarations: ${loginBtnDeclares} (want 1)`);
  console.log(`Total resolveLocator calls: ${resolveLocators}`);
})().catch(e => { console.error(String(e)); process.exit(1); });
