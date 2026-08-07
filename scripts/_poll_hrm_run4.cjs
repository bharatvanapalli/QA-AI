const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const BASE = 'http://localhost:5000';
const RUN_ID = 'cb2836e8-5b06-4044-8328-a4a506d9b98c';
const USER = { sub: 'a5d916cd-4178-4bcc-b409-c885a389e843', email: 'bharatvanapalli8@gmail.com', role: 'user' };

function makeHeaders() {
  const token = jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: '2h' });
  const csrf = crypto.randomBytes(16).toString('hex');
  return { 'Content-Type': 'application/json', Cookie: `token=${token}; XSRF-TOKEN=${csrf}`, 'x-xsrf-token': csrf };
}

async function poll(intervalMs = 15000, maxWaitMs = 7200000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`${BASE}/api/runs/${RUN_ID}`, { headers: makeHeaders() });
    const body = await res.json().catch(() => ({}));
    const run = body?.run || body;
    const status = run?.status;
    const pass = run?.passed ?? '?';
    const fail = run?.failed ?? '?';
    const blocked = run?.blocked ?? '?';
    const nh = run?.needsHuman ?? '?';
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`[${new Date().toISOString()}] [${elapsed}s] status=${status} pass=${pass} fail=${fail} blocked=${blocked} nh=${nh}`);
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      console.log('\nFINAL:', JSON.stringify(run, null, 2));
      return run;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  console.log('TIMEOUT');
  return null;
}

poll().catch(e => { console.error('ERR:', e.message); process.exit(1); });
