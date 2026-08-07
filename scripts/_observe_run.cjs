'use strict';
// Observe+trigger harness: signs a JWT for the project owner, opens a WS observer
// that logs every broadcast event with timestamps, triggers /execute, and polls the
// DB until the freshly-created run finishes. Writes events to _run_observe.log.
const path = require('path');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const fs = require('fs');
const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
let WebSocket; try { WebSocket = require(path.join(ROOT, 'server', 'node_modules', 'ws')); } catch { WebSocket = require('ws'); }
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const BASE = 'http://localhost:5000';
const LOG = path.join(ROOT, '_run_observe.log');
const CSRF = 'obs-csrf-token';
fs.writeFileSync(LOG, '');
const log = (line) => { const s = `[${new Date().toISOString()}] ${line}`; fs.appendFileSync(LOG, s + '\n'); console.log(s); };

function summarize(ev) {
  if (!ev || typeof ev !== 'object') return String(ev);
  const t = ev.type || '?';
  const bits = [];
  for (const k of ['phase', 'level', 'tcId', 'caseId', 'runId', 'status', 'step', 'stepIndex', 'stepOrdinal', 'kind', 'matched', 'check', 'state']) {
    if (ev[k] != null) bits.push(`${k}=${typeof ev[k] === 'object' ? JSON.stringify(ev[k]) : ev[k]}`);
  }
  let msg = ev.message || ev.detail || '';
  if (typeof msg === 'object') msg = JSON.stringify(msg);
  if (msg && msg.length > 400) msg = msg.slice(0, 400) + '…';
  return `${t} ${bits.join(' ')}${msg ? ' :: ' + msg : ''}`;
}

(async () => {
  const proj = await prisma.project.findUnique({ where: { id: PROJECT_ID }, select: { id: true, name: true, userId: true } });
  if (!proj) { log('PROJECT NOT FOUND'); process.exit(1); }
  const user = await prisma.user.findUnique({ where: { id: proj.userId }, select: { id: true, email: true, role: true } });
  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role || 'user' }, process.env.JWT_SECRET, { expiresIn: '2h' });
  log(`project="${proj.name}" owner=${user.email} role=${user.role}`);

  // baseline: latest run before trigger
  const before = await prisma.run.findFirst({ where: { projectId: PROJECT_ID }, orderBy: { startedAt: 'desc' }, select: { id: true } });
  const beforeId = before && before.id;
  log(`latest run BEFORE trigger: ${beforeId}`);

  const cookie = `token=${token}; XSRF-TOKEN=${CSRF}`;
  const ws = new WebSocket(`ws://localhost:5000`, { headers: { Cookie: cookie } });
  let wsOpen = false;
  ws.on('open', () => { wsOpen = true; log('WS connected'); });
  ws.on('message', (raw) => {
    let ev; try { ev = JSON.parse(raw.toString()); } catch { return; }
    if (ev && ev.type === 'connected') return;
    log('WS  ' + summarize(ev));
  });
  ws.on('error', (e) => log('WS error: ' + (e && e.message)));
  ws.on('close', () => log('WS closed'));

  await new Promise((r) => setTimeout(r, 1500));

  // trigger /execute
  log('POST /execute …');
  try {
    const res = await fetch(`${BASE}/api/projects/${PROJECT_ID}/agents/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-xsrf-token': CSRF, Cookie: cookie },
      body: JSON.stringify({}),
    });
    const body = await res.json().catch(() => ({}));
    log(`/execute → HTTP ${res.status} :: ${JSON.stringify(body).slice(0, 300)}`);
    if (res.status >= 400) { log('TRIGGER FAILED'); }
  } catch (e) { log('trigger error: ' + (e && e.message)); }

  // poll DB for a NEW run reaching a terminal state
  const DEADLINE = Date.now() + 13 * 60 * 1000;
  let newRunId = null;
  while (Date.now() < DEADLINE) {
    await new Promise((r) => setTimeout(r, 5000));
    const latest = await prisma.run.findFirst({ where: { projectId: PROJECT_ID }, orderBy: { startedAt: 'desc' }, select: { id: true, status: true, passed: true, failed: true, blocked: true } });
    if (latest && latest.id !== beforeId) {
      if (latest.id !== newRunId) { newRunId = latest.id; log(`NEW RUN detected: ${newRunId} status=${latest.status}`); }
      if (['completed', 'failed', 'cancelled', 'error'].includes(String(latest.status))) {
        log(`RUN TERMINAL: ${newRunId} status=${latest.status} pass=${latest.passed} fail=${latest.failed} blocked=${latest.blocked}`);
        await new Promise((r) => setTimeout(r, 4000)); // let final WS + codegen flush
        break;
      }
    }
  }
  log(`DONE. newRunId=${newRunId}`);
  try { ws.close(); } catch {}
  await prisma.$disconnect();
  setTimeout(() => process.exit(0), 1000);
})().catch((e) => { log('FATAL ' + (e && e.stack || e)); process.exit(1); });
