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
  // Fetch the EXPORT_MANIFEST.json file directly
  const manifestRes = await fetch(
    `${BASE}/api/projects/${PROJECT_ID}/output-files/file/EXPORT_MANIFEST.json?source=replayir&runId=${OLD_RUN_ID}`,
    { headers: makeHeaders() }
  );
  console.log('Manifest HTTP:', manifestRes.status);
  const body = await manifestRes.text();

  let manifest;
  try { manifest = JSON.parse(body); } catch { console.log('Not JSON, first 1k:', body.slice(0, 1000)); return; }

  // The manifest file content might be embedded in a wrapper
  const m = manifest.content ? JSON.parse(manifest.content) : manifest;
  const entries = m?.entries || [];

  const blocked = entries.filter(e => e.blockReason || (e.files && e.files.length === 0));
  const exported = entries.filter(e => !e.blockReason && e.files && e.files.length > 0);

  console.log(`\nTotal manifest entries: ${entries.length}`);
  console.log(`Exported: ${exported.length}, Blocked/empty: ${blocked.length}`);

  if (blocked.length > 0) {
    console.log('\nBlocked entries:');
    blocked.forEach(e => {
      console.log(`  "${e.scenarioName || e.caseId}" reason="${e.blockReason || 'empty-files'}" files=${JSON.stringify(e.files || [])}`);
    });
  }

  if (exported.length > 0) {
    console.log('\nExported entries (first 5):');
    exported.slice(0, 5).forEach(e => {
      console.log(`  "${e.scenarioName || e.caseId}" files=${JSON.stringify(e.files || [])}`);
    });
  }
})().catch(e => { console.error(String(e)); process.exit(1); });
