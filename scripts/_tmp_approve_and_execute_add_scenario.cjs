'use strict';

const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const prisma = require('../server/prisma');

const PROJECT_ID = 'f8168938-ac0a-42fe-9c30-2f820aaee9dd';
const GENERATION_ID = '9d952135-19af-4626-ae83-696c0796588e';
const CASE_ID = '6ab6e82a-9784-4654-bb37-90d1c787e36d';
const BASE_URL = process.env.QAAI_BASE_URL || 'http://127.0.0.1:5011';

async function requestJson(url, method, body, cookie, csrf) {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', cookie, 'x-xsrf-token': csrf },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  if (!response.ok) {
    const error = new Error(`${response.status} ${response.statusText}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

(async () => {
  const project = await prisma.project.findUnique({
    where: { id: PROJECT_ID },
    select: { user: { select: { id: true, email: true, role: true } } },
  });
  const testCase = await prisma.testCase.findFirst({
    where: { id: CASE_ID, projectId: PROJECT_ID, generationId: GENERATION_ID },
    select: { id: true, readinessStatus: true, runEligibility: true },
  });
  if (!project || !project.user || !testCase
    || testCase.readinessStatus !== 'ready'
    || testCase.runEligibility !== 'allowed') {
    throw new Error('Verified S2 is not ready for API approval/execution.');
  }
  const token = jwt.sign(
    { sub: project.user.id, email: project.user.email, role: project.user.role },
    process.env.JWT_SECRET,
    { expiresIn: '15m' },
  );
  const csrf = crypto.randomBytes(32).toString('hex');
  const cookie = `token=${encodeURIComponent(token)}; XSRF-TOKEN=${csrf}`;
  const approval = await requestJson(
    `${BASE_URL}/api/projects/${PROJECT_ID}/test-cases/${CASE_ID}`,
    'PUT',
    { status: 'approved' },
    cookie,
    csrf,
  );
  process.stdout.write(`${JSON.stringify({
    stage: 'case_approved',
    caseId: approval.testCase && approval.testCase.id,
    status: approval.testCase && approval.testCase.status,
    readinessStatus: approval.testCase && approval.testCase.readinessStatus,
    runEligibility: approval.testCase && approval.testCase.runEligibility,
  })}\n`);
  const execution = await requestJson(
    `${BASE_URL}/api/projects/${PROJECT_ID}/agents/execute`,
    'POST',
    { generationId: GENERATION_ID, runMode: 'sequential' },
    cookie,
    csrf,
  );
  process.stdout.write(`${JSON.stringify({ stage: 'execution_accepted', ...execution })}\n`);
})()
  .finally(() => prisma.$disconnect());
