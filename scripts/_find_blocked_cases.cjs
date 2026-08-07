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
  // Get the run with results
  const res = await fetch(`${BASE}/api/runs/${OLD_RUN_ID}`, { headers: makeHeaders() });
  const data = await res.json().catch(() => ({}));
  const run = data.run || data;

  // Find blocked results
  const results = run.results || run.runResults || [];
  console.log(`Total results: ${results.length}`);

  const blocked = results.filter(r => r.status === 'blocked');
  const notBlocked = results.filter(r => r.status !== 'blocked');
  console.log(`Blocked: ${blocked.length}, Not blocked: ${notBlocked.length}`);

  // For replayir export, which ones couldn't generate specs?
  // Let's check the replayIrJson for blocked entries
  blocked.forEach(r => {
    const hasIr = r.replayIrJson && r.replayIrJson !== 'null';
    console.log(`  BLOCKED: case="${r.testCase?.name || r.testCaseId}" status=${r.status} hasIr=${hasIr}`);
  });

  // Show the scenario/case IDs for blocked ones
  if (blocked.length === 0) {
    console.log('\nNo blocked results. Showing all:');
    results.slice(0, 5).forEach(r => {
      console.log(`  ${r.status}: ${r.testCase?.name || r.testCaseId}`);
    });
  }
})().catch(e => { console.error(String(e)); process.exit(1); });
