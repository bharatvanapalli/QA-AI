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
  // GET the tree for old run — this will recompile replayIrJson through current code
  const res = await fetch(
    `${BASE}/api/projects/${PROJECT_ID}/output-files/?source=replayir&runId=${OLD_RUN_ID}`,
    { headers: makeHeaders() }
  );
  const data = await res.json().catch(() => ({}));

  // Walk the tree and collect all spec files
  const specFiles = [];
  function walk(node) {
    if (!node) return;
    if (node.type === 'file' && node.kind === 'spec') specFiles.push(node.path);
    (node.children || []).forEach(walk);
  }
  walk(data?.tree);

  console.log(`Spec files in re-export: ${specFiles.length}`);
  specFiles.forEach(f => console.log('  ' + f));

  // Read one spec to verify Q1 (no inline page.getByRole) and Q2 (semantic names)
  if (specFiles.length > 0) {
    const samplePath = specFiles.find(f => f.includes('admin-successful')) || specFiles[0];
    const fileRes = await fetch(
      `${BASE}/api/projects/${PROJECT_ID}/output-files/file/${encodeURIComponent(samplePath)}?source=replayir&runId=${OLD_RUN_ID}`,
      { headers: makeHeaders() }
    );
    if (fileRes.ok) {
      const content = await fileRes.text();
      console.log('\n--- SAMPLE SPEC (first 60 lines) ---');
      content.split('\n').slice(0, 60).forEach((l, i) => console.log(`${String(i+1).padStart(3)}: ${l}`));

      // Q1 check
      const inlineLocators = content.match(/page\.(getByRole|getByText|getByLabel|getByPlaceholder|locator)\s*\(/g) || [];
      console.log(`\nQ1 inline locators in spec body: ${inlineLocators.length}`);
      if (inlineLocators.length > 0) {
        console.log('  FAIL samples:', inlineLocators.slice(0, 3));
      } else {
        console.log('  ✓ PASS — no inline locators');
      }

      // Q2 check
      const elVars = content.match(/const el\d+\s*=/g) || [];
      console.log(`\nQ2 el1/el2 vars: ${elVars.length}`);
      console.log(elVars.length === 0 ? '  ✓ PASS — no el1/el2 names' : '  FAIL: ' + elVars.slice(0, 3).join(', '));
    }
  }
})().catch(e => { console.error(String(e)); process.exit(1); });
