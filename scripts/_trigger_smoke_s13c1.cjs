/**
 * Triggers a smoke run for S13·C1 and streams the live action trail.
 * Usage: node scripts/_trigger_smoke_s13c1.cjs
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const BASE       = 'http://localhost:5000';
const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const TC_ID      = 'cc13d9c4-862c-4243-ad7a-e348c37b9beb';
const USER       = { sub: 'a5d916cd-4178-4bcc-b409-c885a389e843', email: 'bharatvanapalli8@gmail.com', role: 'user' };

function headers() {
  const token = jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: '2h' });
  const csrf  = crypto.randomBytes(16).toString('hex');
  return {
    'Content-Type': 'application/json',
    Cookie: `token=${token}; XSRF-TOKEN=${csrf}`,
    'x-xsrf-token': csrf,
    'x-org-id': 'org-a5d916cd-4178-4bcc-b409-c885a389e843',
  };
}

(async () => {
  console.log('[trigger] TC:', TC_ID.slice(0,8), '— Verify logout redirects Admin and ESS user to login page');

  // 1. Fire the smoke run
  const res = await fetch(`${BASE}/api/projects/${PROJECT_ID}/agents/run-smoke`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ testCaseIds: [TC_ID] }),
  });
  const body = await res.json().catch(() => ({}));
  console.log(`[trigger] run-smoke → ${res.status}  ${JSON.stringify(body).slice(0, 300)}`);
  if (!res.ok) { process.exit(1); }

  // 2. Poll for the live RunResult every 4 seconds
  console.log('[trigger] Polling for live run results...\n');
  let prevTrailLen = 0;
  let stableCount  = 0;
  let runId        = null;

  for (let i = 0; i < 90; i++) {          // up to 6 minutes
    await new Promise(r => setTimeout(r, 4000));

    // Find the latest run for this project
    const latestRun = await prisma.run.findFirst({
      where: { projectId: PROJECT_ID },
      orderBy: { startedAt: 'desc' },
      select: { id: true, status: true, startedAt: true, passed: true, failed: true, blocked: true },
    });
    if (!latestRun) { process.stdout.write('.'); continue; }
    runId = latestRun.id;

    // Find RunResult for our test case
    const rr = await prisma.runResult.findFirst({
      where: { runId: latestRun.id, testCaseId: TC_ID },
      select: { id: true, status: true, actionTrail: true, error: true, startedAt: true, completedAt: true },
      orderBy: { startedAt: 'desc' },
    });
    if (!rr) { process.stdout.write('.'); continue; }

    let trail = [];
    try { trail = JSON.parse(rr.actionTrail || '[]'); } catch (_) {}

    if (trail.length > prevTrailLen) {
      const newEntries = trail.slice(prevTrailLen);
      for (const entry of newEntries) {
        const turn  = String(entry.turn ?? '?').padStart(2);
        const tool  = String(entry.tool || 'narrate').padEnd(25);
        const ok    = entry.ok === false ? '✗' : entry.ok === true ? '✓' : '·';
        const narr  = String(entry.narration || entry.args?.url || JSON.stringify(entry.args || {}).slice(0, 80) || '').slice(0, 100);
        const errPart = entry.error ? ` | ERR: ${String(entry.error).slice(0, 80)}` : '';
        console.log(`  [t${turn}] ${ok} ${tool} ${narr}${errPart}`);
      }
      prevTrailLen = trail.length;
      stableCount  = 0;
    } else {
      stableCount++;
    }

    if (rr.status && rr.status !== 'running') {
      console.log(`\n[result] STATUS: ${rr.status.toUpperCase()}  |  error: ${rr.error || 'none'}`);
      console.log(`[result] RunId: ${latestRun.id}  |  RunResultId: ${rr.id}`);
      break;
    }

    if (stableCount >= 10) {
      console.log('\n[trigger] No new trail entries for 40s — run may have stalled. Check server logs.');
      break;
    }
  }

  await prisma.$disconnect();
})().catch(e => { console.error('ERR', e.message, e.stack?.split('\n')[1]); prisma.$disconnect(); process.exit(1); });
