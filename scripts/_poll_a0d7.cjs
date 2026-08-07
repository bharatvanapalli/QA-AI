'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const BASE = 'http://localhost:5000';
const RUN_ID = 'a0d7891d-dc96-424e-b1b2-15856d19dae5';
const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const USER = { sub: 'a5d916cd-4178-4bcc-b409-c885a389e843', email: 'bharatvanapalli8@gmail.com', role: 'user' };

function makeHeaders() {
  const token = jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: '2h' });
  const csrf = crypto.randomBytes(16).toString('hex');
  return { Cookie: `token=${token}; XSRF-TOKEN=${csrf}`, 'x-xsrf-token': csrf };
}

(async () => {
  const start = Date.now();
  while (Date.now() - start < 3600000) {
    const res = await fetch(`${BASE}/api/runs/${RUN_ID}`, { headers: makeHeaders() });
    const data = await res.json().catch(() => ({}));
    const run = data?.run || data;
    const status = run?.status;
    const pass = run?.passed ?? '?';
    const fail = run?.failed ?? '?';
    const blocked = run?.blocked ?? '?';
    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r  [${elapsed}s] status=${status} pass=${pass} fail=${fail} blocked=${blocked}   `);
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      console.log(`\nFinal: ${JSON.stringify({ status, pass, fail, blocked })}`);
      break;
    }
    if (status === undefined) {
      // Try the list endpoint as fallback
      const listRes = await fetch(`${BASE}/api/runs?projectId=${PROJECT_ID}&limit=5`, { headers: makeHeaders() });
      const listData = await listRes.json().catch(() => ({}));
      const found = (listData.runs || []).find(r => r.id === RUN_ID);
      if (found) {
        process.stdout.write(`\r  [${elapsed}s] status=${found.status} pass=${found.passed} fail=${found.failed} blocked=${found.blocked}   `);
        if (found.status === 'completed' || found.status === 'failed' || found.status === 'cancelled') {
          console.log(`\nFinal: ${JSON.stringify({ status: found.status, pass: found.passed, fail: found.failed, blocked: found.blocked })}`);
          break;
        }
      }
    }
    await new Promise(r => setTimeout(r, 15000));
  }
})().catch(e => { console.error(String(e)); process.exit(1); });
