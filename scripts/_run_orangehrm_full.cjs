'use strict';
/**
 * Start a full run of OrangeHRM Module Testing (all 29 cases in current generation).
 * Uses the same conductor+verdict engine as the UI "Run" button.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { PrismaClient } = require(path.join(__dirname, '..', 'server', 'node_modules', '@prisma', 'client'));
const prisma = new PrismaClient();

const BASE = 'http://localhost:5000';
const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const GEN_ID = 'ec58007b-23e3-43a0-b5fd-8714b01dad8d';
const USER = { sub: 'a5d916cd-4178-4bcc-b409-c885a389e843', email: 'bharatvanapalli8@gmail.com', role: 'user' };

function makeHeaders() {
  const token = jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: '2h' });
  const csrf = crypto.randomBytes(16).toString('hex');
  return {
    'Content-Type': 'application/json',
    Cookie: `token=${token}; XSRF-TOKEN=${csrf}`,
    'x-xsrf-token': csrf,
  };
}

async function pollRun(runId, intervalMs = 8000, maxWaitMs = 600000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`${BASE}/api/runs/${runId}/status`, { headers: makeHeaders() });
    const body = await res.json().catch(() => ({}));
    const status = body?.status || body?.run?.status;
    const pass = body?.run?.passed ?? body?.passed ?? '?';
    const fail = body?.run?.failed ?? body?.failed ?? '?';
    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r  [${elapsed}s] status=${status} pass=${pass} fail=${fail}   `);
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      console.log('');
      return body?.run || body;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  console.log('\n  TIMEOUT waiting for run');
  return null;
}

(async () => {
  try {
    // Get automatable cases in current generation
    const scenarios = await prisma.testScenario.findMany({
      where: { projectId: PROJECT_ID, generationId: GEN_ID },
      include: { cases: true },
    });
    const cases = scenarios.flatMap(s => s.cases);
    const automatable = cases.filter(c => (c.automatability || 'automatable') === 'automatable');
    console.log(`\nTotal cases: ${cases.length}, automatable: ${automatable.length}`);
    console.log(`Scenarios: ${scenarios.map(s => s.name).join(', ')}\n`);

    // Approve all automatable cases
    const ids = automatable.map(c => c.id);
    const approveRes = await fetch(`${BASE}/api/projects/${PROJECT_ID}/test-cases/bulk-update`, {
      method: 'POST',
      headers: makeHeaders(),
      body: JSON.stringify({ ids, status: 'approved' }),
    });
    const approveBody = await approveRes.json().catch(() => ({}));
    console.log(`Approve: HTTP ${approveRes.status}, updated=${approveBody.updated}`);
    if (!approveRes.ok) {
      console.error('Approve failed:', JSON.stringify(approveBody));
      process.exit(1);
    }

    // Start the run
    const execRes = await fetch(`${BASE}/api/projects/${PROJECT_ID}/agents/execute`, {
      method: 'POST',
      headers: makeHeaders(),
      body: JSON.stringify({}),
    });
    const execBody = await execRes.json().catch(() => ({}));
    console.log(`Execute: HTTP ${execRes.status}`);
    if (!execRes.ok) {
      console.error('Execute failed:', JSON.stringify(execBody).slice(0, 400));
      process.exit(1);
    }

    const runId = execBody?.runId || execBody?.run?.id || execBody?.id;
    if (!runId) {
      console.error('No run ID in response:', JSON.stringify(execBody).slice(0, 400));
      process.exit(1);
    }
    console.log(`\nRun started: ${runId}`);
    console.log('Polling for completion...\n');

    const finalRun = await pollRun(runId);
    if (finalRun) {
      console.log(`\nFinal status: ${finalRun.status}`);
      console.log(`Results: pass=${finalRun.passed} fail=${finalRun.failed} blocked=${finalRun.blocked} needsHuman=${finalRun.needsHuman}`);
    }

    console.log(`\nRun ID for export: ${runId}`);
  } catch (e) {
    console.error('ERR:', e.message);
    console.error(e.stack?.split('\n').slice(0, 5).join('\n'));
  } finally {
    await prisma.$disconnect();
  }
})();
