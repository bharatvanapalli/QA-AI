'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const BASE = 'http://localhost:5000';
const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const GENERATION_ID = 'ec58007b-23e3-43a0-b5fd-8714b01dad8d';
const USER = { sub: 'a5d916cd-4178-4bcc-b409-c885a389e843', email: 'bharatvanapalli8@gmail.com', role: 'user' };

function makeHeaders() {
  const token = jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: '2h' });
  const csrf = crypto.randomBytes(16).toString('hex');
  return { Cookie: `token=${token}; XSRF-TOKEN=${csrf}`, 'x-xsrf-token': csrf, 'Content-Type': 'application/json' };
}

(async () => {
  // Get all approved test cases for this generation
  const tcRes = await fetch(
    `${BASE}/api/projects/${PROJECT_ID}/test-cases?generationId=${GENERATION_ID}&status=approved&limit=100`,
    { headers: makeHeaders() }
  );
  const tcData = await tcRes.json().catch(() => ({}));
  const cases = (tcData.testCases || tcData.cases || tcData || []).filter(c => c && c.id && c.status === 'approved');
  console.log(`Approved test cases found: ${cases.length}`);
  if (cases.length === 0) {
    console.log('No approved cases — checking all cases...');
    const allRes = await fetch(
      `${BASE}/api/projects/${PROJECT_ID}/test-cases?generationId=${GENERATION_ID}&limit=100`,
      { headers: makeHeaders() }
    );
    const allData = await allRes.json().catch(() => ({}));
    const allCases = allData.testCases || allData.cases || allData || [];
    console.log(`All cases: ${allCases.length}`);
    const byStatus = {};
    allCases.forEach(c => { byStatus[c.status] = (byStatus[c.status]||0)+1; });
    console.log('By status:', JSON.stringify(byStatus));
    process.exit(0);
  }

  const caseIds = cases.map(c => c.id);
  console.log(`Starting full run with ${caseIds.length} cases...`);

  const runRes = await fetch(
    `${BASE}/api/projects/${PROJECT_ID}/agents/execute`,
    {
      method: 'POST',
      headers: makeHeaders(),
      body: JSON.stringify({ testCaseIds: caseIds, execMode: 'fast' }),
    }
  );
  const runData = await runRes.json().catch(() => ({}));
  console.log(`HTTP ${runRes.status}`);
  console.log(JSON.stringify(runData, null, 2));

  if (runData.runId || runData.run?.id) {
    const runId = runData.runId || runData.run?.id;
    console.log(`\n✓ Run started: ${runId}`);
    console.log(`Poll with: node scripts/_tmp_status.cjs`);
    console.log(`Audit with: node scripts/_audit_checkpoints.cjs ${runId}`);
  }
})().catch(e => { console.error(String(e)); process.exit(1); });
