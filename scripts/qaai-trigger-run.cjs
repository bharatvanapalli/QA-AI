'use strict';
/**
 * Trigger a live Conductor run directly via signed JWT + CSRF, bypassing the
 * browser UI. Built because the interactive UI can't easily be driven by an
 * automation session, and this backend requires an authenticated session
 * cookie + double-submit CSRF token for any mutating route.
 *
 * Requires the backend to be running (npm run dev / restart-backend.ps1)
 * with the root .env loaded (same JWT_SECRET the server itself reads).
 *
 * Usage:
 *   node scripts/qaai-trigger-run.js --project <projectId> --cases <id1,id2> [--generation <genId>] [--user <userId>]
 *
 * Defaults to the New_Odyssey reference project/cases used throughout the
 * 2026-08-05 output-files session if no flags are passed:
 *   projectId    1582559f-364f-4d0e-bfde-fd18832fdaa7
 *   generationId d486351a-6070-47d1-b8b5-2c8bc4156abb
 *   testCaseIds  4af44607-e59b-4cd4-85a2-68dc1e89cdc9 (login),
 *                c7dabb04-0fef-4530-bad8-8c0f6622ed64 (order)
 *
 * The POST returns 202 immediately — the run itself executes async in the
 * background. Use qaai-inspect-run.js to poll for completion and inspect
 * results afterward.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const prisma = require('../server/prisma');

function argValue(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const PROJECT_ID = argValue('--project', '1582559f-364f-4d0e-bfde-fd18832fdaa7');
const GENERATION_ID = argValue('--generation', 'd486351a-6070-47d1-b8b5-2c8bc4156abb');
const TEST_CASE_IDS = argValue(
  '--cases',
  '4af44607-e59b-4cd4-85a2-68dc1e89cdc9,c7dabb04-0fef-4530-bad8-8c0f6622ed64',
).split(',').map((s) => s.trim()).filter(Boolean);
const EXPLICIT_USER_ID = argValue('--user', null);
const BASE_URL = argValue('--base-url', 'http://localhost:5000');

(async () => {
  const project = await prisma.project.findUnique({ where: { id: PROJECT_ID }, select: { id: true, orgId: true } });
  if (!project) throw new Error(`Project ${PROJECT_ID} not found.`);

  let user;
  if (EXPLICIT_USER_ID) {
    user = await prisma.user.findUnique({ where: { id: EXPLICIT_USER_ID }, select: { id: true, email: true, role: true, currentOrgId: true } });
  } else {
    // Any user whose currentOrgId matches the project's org can drive it —
    // requireOrg resolves org purely from the user row, not from the JWT.
    user = await prisma.user.findFirst({ where: { currentOrgId: project.orgId }, select: { id: true, email: true, role: true, currentOrgId: true } });
  }
  if (!user) throw new Error(`No user found with currentOrgId=${project.orgId}. Pass --user <id> explicitly.`);
  if (user.currentOrgId !== project.orgId) throw new Error(`User ${user.id}'s currentOrgId does not match project org ${project.orgId}.`);

  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '15m' });
  const csrf = crypto.randomBytes(32).toString('hex');

  const res = await fetch(`${BASE_URL}/api/projects/${PROJECT_ID}/agents/run-smoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `token=${token}; XSRF-TOKEN=${csrf}`,
      'X-XSRF-Token': csrf,
    },
    body: JSON.stringify({ testCaseIds: TEST_CASE_IDS, generationId: GENERATION_ID }),
  });
  const body = await res.json().catch(() => null);
  console.log('STATUS:', res.status);
  console.log('BODY:', JSON.stringify(body));
  if (res.status === 202) {
    const latest = await prisma.run.findFirst({ where: { projectId: PROJECT_ID }, orderBy: { startedAt: 'desc' }, select: { id: true, status: true } });
    console.log('LIKELY_RUN_ID:', latest?.id, '(confirm by re-querying — a race with a concurrent run is possible)');
  }
})().catch((err) => {
  console.error('TRIGGER_FAILED:', err.message);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
