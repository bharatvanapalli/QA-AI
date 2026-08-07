'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const BASE = 'http://localhost:5000';
const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const USER = { sub: 'a5d916cd-4178-4bcc-b409-c885a389e843', email: 'bharatvanapalli8@gmail.com', role: 'user' };

function makeHeaders() {
  const token = jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: '2h' });
  const csrf = crypto.randomBytes(16).toString('hex');
  return { Cookie: `token=${token}; XSRF-TOKEN=${csrf}`, 'x-xsrf-token': csrf };
}

(async () => {
  // Get the latest run
  const runsRes = await fetch(`${BASE}/api/runs?projectId=${PROJECT_ID}`, { headers: makeHeaders() });
  const runsData = await runsRes.json();
  const runs = (runsData.runs || []).slice(0, 3);
  if (!runs.length) { console.log('No runs found'); return; }

  const latestRun = runs[0];
  console.log('Latest runs:');
  runs.forEach(r => console.log(`  ${r.id} status=${r.status} pass=${r.passed} fail=${r.failed} blocked=${r.blocked} created=${r.createdAt}`));

  if (latestRun.status === 'running') {
    console.log(`\nPolling run ${latestRun.id}...`);
    const start = Date.now();
    while (Date.now() - start < 3600000) {
      await new Promise(r => setTimeout(r, 15000));
      const statusRes = await fetch(`${BASE}/api/runs/${latestRun.id}/status`, { headers: makeHeaders() });
      const statusData = await statusRes.json().catch(() => ({}));
      const status = statusData?.status || statusData?.run?.status;
      const pass = statusData?.run?.passed ?? statusData?.passed ?? '?';
      const fail = statusData?.run?.failed ?? statusData?.failed ?? '?';
      const blocked = statusData?.run?.blocked ?? statusData?.blocked ?? '?';
      const elapsed = Math.round((Date.now() - start) / 1000);
      process.stdout.write(`\r  [${elapsed}s] status=${status} pass=${pass} fail=${fail} blocked=${blocked}   `);
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        console.log(`\nDone: ${status}`);
        break;
      }
    }
  } else {
    console.log(`\nRun is already ${latestRun.status}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
