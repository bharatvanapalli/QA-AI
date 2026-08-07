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
  // List all projects
  const projRes = await fetch(`${BASE}/api/projects`, { headers: makeHeaders() });
  const projData = await projRes.json();
  console.log('Projects:');
  (projData.projects || projData || []).forEach(p => console.log(`  ${p.id} "${p.name}"`));

  // Check runs for the OrangeHRM project
  const runsRes = await fetch(`${BASE}/api/projects/${PROJECT_ID}/runs`, { headers: makeHeaders() });
  const runsBody = await runsRes.text();
  console.log(`\nRuns HTTP ${runsRes.status}: ${runsBody.slice(0, 500)}`);
})().catch(e => { console.error(e); process.exit(1); });
