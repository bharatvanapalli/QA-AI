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
  return { Cookie: `token=${token}; XSRF-TOKEN=${csrf}`, 'x-xsrf-token': csrf, 'Content-Type': 'application/json' };
}

(async () => {
  // Fetch the manifest
  const r = await fetch(
    `${BASE}/api/projects/${PROJECT_ID}/output-files/file/EXPORT_MANIFEST.json?source=replayir&runId=${OLD_RUN_ID}`,
    { headers: makeHeaders() }
  );
  const body = await r.json().catch(() => ({}));
  const m = body.content ? JSON.parse(body.content) : body;
  const entries = m?.entries || [];

  const blocked = entries.filter(e => e.blockReason);
  const exported = entries.filter(e => !e.blockReason && e.files && e.files.length > 0);

  console.log(`Total: ${entries.length}  Exported: ${exported.length}  Blocked: ${blocked.length}`);
  console.log('\nBlocked:');
  blocked.forEach(e => console.log(`  [${e.blockReason}] "${e.caseName || e.scenarioName}"`));

  // Check if Invalid Credentials case is now exported
  const invalidCred = entries.filter(e => /invalid.cred|invalid.*login/i.test(e.caseName || e.scenarioName || ''));
  console.log('\nInvalid-credentials entries:');
  invalidCred.forEach(e => {
    const status = e.blockReason ? `BLOCKED:${e.blockReason}` : `EXPORTED (${(e.files||[]).join(', ')})`;
    console.log(`  "${e.caseName || e.scenarioName}" → ${status}`);
  });

  // If exported, read the spec and check for literal invalid creds
  const invalidCredExported = exported.find(e => /invalid.cred|invalid.*login/i.test(e.caseName || e.scenarioName || ''));
  if (invalidCredExported && invalidCredExported.files && invalidCredExported.files.length) {
    const specPath = invalidCredExported.files.find(f => f.endsWith('.spec.js'));
    if (specPath) {
      const specR = await fetch(
        `${BASE}/api/projects/${PROJECT_ID}/output-files/file/${encodeURIComponent(specPath)}?source=replayir&runId=${OLD_RUN_ID}`,
        { headers: makeHeaders() }
      );
      const specBody = await specR.json().catch(() => ({}));
      const content = specBody.content || '';
      console.log('\n--- Invalid-credentials spec (first 60 lines) ---');
      content.split('\n').slice(0, 60).forEach((l, i) => console.log(`${String(i+1).padStart(3)}: ${l}`));

      const hasInvalidUser = /invalid_user@example\.com|WrongPassword/i.test(content);
      const hasEnvCred = /process\.env\.(QAAI_USERNAME|QAAI_PASSWORD)/i.test(content);
      console.log(`\nQ8: literal invalid credentials: ${hasInvalidUser ? '✓ PASS' : 'FAIL — no placeholder found'}`);
      console.log(`Q8: env creds still used: ${hasEnvCred ? 'WARN — env refs present' : '✓ CLEAN'}`);
    }
  }
})().catch(e => { console.error(String(e)); process.exit(1); });
