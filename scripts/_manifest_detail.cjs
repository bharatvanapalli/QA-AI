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
  const manifestRes = await fetch(
    `${BASE}/api/projects/${PROJECT_ID}/output-files/file/EXPORT_MANIFEST.json?source=replayir&runId=${OLD_RUN_ID}`,
    { headers: makeHeaders() }
  );
  const wrapper = await manifestRes.json().catch(() => ({}));
  const m = wrapper.content ? JSON.parse(wrapper.content) : wrapper;
  const entries = m?.entries || [];

  console.log(`\n=== ALL MANIFEST ENTRIES (${entries.length}) ===\n`);
  entries.forEach((e, i) => {
    const exported = !e.blockReason && e.files && e.files.length > 0;
    const status = exported ? 'EXPORT' : `BLOCK:${e.blockReason || 'unknown'}`;
    console.log(`[${i+1}] ${status}`);
    console.log(`     scenario: "${e.scenarioName}" (${e.scenarioId || 'n/a'})`);
    console.log(`     case: "${e.caseName}" (${e.caseId || 'n/a'})`);
    if (e.validationFindings && e.validationFindings.length > 0) {
      console.log(`     findings: ${e.validationFindings.slice(0,2).map(f => f.rule + ':' + f.message?.slice(0,60)).join('; ')}`);
    }
    if (e.files && e.files.length > 0) {
      console.log(`     files: ${e.files.join(', ')}`);
    }
  });
})().catch(e => { console.error(String(e)); process.exit(1); });
