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
  // Get the output files manifest for the old run to find blocked entries
  const res = await fetch(
    `${BASE}/api/projects/${PROJECT_ID}/output-files/?source=replayir&runId=${OLD_RUN_ID}`,
    { headers: makeHeaders() }
  );
  const data = await res.json().catch(() => ({}));

  // Find entries with replayir_no_replayable_locator
  const manifest = data?.workspace?.files?.['EXPORT_MANIFEST.json'];
  if (manifest) {
    const m = JSON.parse(manifest);
    const blocked = m.entries.filter(e => e.blockReason === 'replayir_no_replayable_locator');
    console.log(`\nBlocked entries (${blocked.length}):`);
    blocked.forEach(e => {
      console.log(`  scenario: "${e.scenarioName}" (${e.scenarioId})`);
      console.log(`    caseId: ${e.caseId}`);
    });

    // Also show run results
    const runRes = await fetch(`${BASE}/api/runs?projectId=${PROJECT_ID}&limit=5`, { headers: makeHeaders() });
    const runData = await runRes.json().catch(() => ({}));
    console.log('\nRecent runs:');
    (runData.runs || []).slice(0,3).forEach(r =>
      console.log(`  ${r.id} ${r.status} pass=${r.passed} fail=${r.failed} blocked=${r.blocked}`)
    );
  } else {
    // Show top-level structure
    console.log('Workspace keys:', Object.keys(data?.workspace?.files || {}).slice(0, 10));
    console.log('Full data (first 2k):', JSON.stringify(data).slice(0, 2000));
  }
})().catch(e => { console.error(String(e)); process.exit(1); });
