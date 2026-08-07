'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const BASE = 'http://localhost:5000';
const RUN_ID = 'a0d7891d-dc96-424e-b1b2-15856d19dae5';
const USER = { sub: 'a5d916cd-4178-4bcc-b409-c885a389e843', email: 'bharatvanapalli8@gmail.com', role: 'user' };

function makeHeaders() {
  const token = jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: '2h' });
  const csrf = crypto.randomBytes(16).toString('hex');
  return { 'Content-Type': 'application/json', Cookie: `token=${token}; XSRF-TOKEN=${csrf}`, 'x-xsrf-token': csrf };
}

(async () => {
  const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
  const res = await fetch(`${BASE}/api/projects/${PROJECT_ID}/agents/cancel`, { method: 'POST', headers: makeHeaders(), body: JSON.stringify({}) });
  const body = await res.json().catch(() => ({}));
  console.log(`Cancel HTTP ${res.status}:`, JSON.stringify(body));
})().catch(e => { console.error(String(e)); process.exit(1); });
