'use strict';
/**
 * P6 LIVE ACTIVATION — trigger half. Approves the SMALL approved slice (1-3 cases)
 * and fires the REAL /agents/execute route (planner + conductor run in the backend
 * process, where P6 emission is wired). Read the result with _p6_live_inspect.cjs
 * AFTER the run completes. Faithful live path — no DB shortcuts for the trigger.
 *
 *   node scripts/_p6_live_trigger.cjs
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const API = process.env.QAAI_API || 'http://localhost:5000';
const PID = '9675bfde-acb2-4eda-aaed-b6694b88f920'; // Orange HRM
const OWNER = 'a5d916cd-4178-4bcc-b409-c885a389e843';
// Smallest reliable, self-contained, deps=0 slice (each owns its own login):
const CASE_IDS = [
  'e3183ae3-b4fe-43ae-a796-7354e20745f6', // Valid Login → dashboard (TEXT,TEXT) — expect PASS
  '148a9de6-4db3-4883-8cdd-c035166e088d', // Invalid Credentials error (PAGE,TEXT)
];

(async () => {
  const user = await prisma.user.findUnique({ where: { id: OWNER }, select: { id: true, email: true, role: true, currentOrgId: true } });
  if (!user) throw new Error('owner user not found');
  console.log(`owner: ${user.email}  currentOrgId=${user.currentOrgId}`);
  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '2h' });
  const csrf = crypto.randomBytes(32).toString('hex');
  const headers = {
    'content-type': 'application/json',
    'cookie': `token=${token}; XSRF-TOKEN=${csrf}`,
    'x-xsrf-token': csrf,
  };

  // Pre-flight: confirm auth + org resolve for this project (else getProject 404s).
  const pre = await fetch(`${API}/api/projects/${PID}`, { headers });
  console.log(`pre-flight GET /projects/${PID.slice(0, 8)} → ${pre.status}`);
  if (pre.status !== 200) { console.error('AUTH/ORG check failed — aborting before any mutation.'); process.exit(2); }

  // Stamp BEFORE the trigger so the inspector can find the NEW run unambiguously.
  const triggerAt = new Date();
  const lastRunBefore = await prisma.run.findFirst({ where: { projectId: PID }, orderBy: { startedAt: 'desc' }, select: { id: true } });

  // Step 1 — approve exactly the small slice (real bulk-update route).
  const appRes = await fetch(`${API}/api/projects/${PID}/test-cases/bulk-update`, {
    method: 'POST', headers, body: JSON.stringify({ ids: CASE_IDS, status: 'approved' }),
  });
  const appJson = await appRes.json().catch(() => ({}));
  console.log(`approve bulk-update → ${appRes.status}  ${JSON.stringify(appJson)}`);
  if (!appJson.success || appJson.updated !== CASE_IDS.length) {
    console.error(`expected updated=${CASE_IDS.length}; aborting.`); process.exit(3);
  }

  // Step 2 — fire the real execute route (planner + conductor in the backend process).
  const exRes = await fetch(`${API}/api/projects/${PID}/agents/execute`, { method: 'POST', headers, body: '{}' });
  const exJson = await exRes.json().catch(() => ({}));
  console.log(`execute → ${exRes.status}  ${JSON.stringify(exJson)}`);
  if (exRes.status !== 202) { console.error('execute did not accept (expected 202).'); process.exit(4); }

  console.log(`\nTRIGGERED at ${triggerAt.toISOString()}`);
  console.log(`lastRunBefore=${lastRunBefore?.id || '(none)'}`);
  console.log(`approved+running cases: ${CASE_IDS.join(', ')}`);
  console.log('Run executes in the backend process. Poll Run status, then run _p6_live_inspect.cjs.');
  await prisma.$disconnect();
})().catch(async (e) => { console.error('TRIGGER ERROR', e); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
