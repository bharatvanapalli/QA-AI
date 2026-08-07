'use strict';
// OBSERVE-ONLY: attach to the run the user just triggered. No /execute trigger.
const path = require('path');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const fs = require('fs');
const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
let WebSocket; try { WebSocket = require(path.join(ROOT, 'server', 'node_modules', 'ws')); } catch { WebSocket = require('ws'); }
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const LOG = path.join(ROOT, '_run_observe.log');
fs.writeFileSync(LOG, '');
const log = (line) => { const s = `[${new Date().toISOString()}] ${line}`; fs.appendFileSync(LOG, s + '\n'); };

function summarize(ev) {
  if (!ev || typeof ev !== 'object') return String(ev);
  const t = ev.type || '?';
  const bits = [];
  for (const k of ['phase', 'level', 'tcId', 'caseId', 'runId', 'status', 'step', 'stepIndex', 'stepOrdinal', 'kind', 'matched', 'check', 'state']) {
    if (ev[k] != null) bits.push(`${k}=${typeof ev[k] === 'object' ? JSON.stringify(ev[k]) : ev[k]}`);
  }
  let msg = ev.message || ev.detail || '';
  if (typeof msg === 'object') msg = JSON.stringify(msg);
  if (msg && msg.length > 500) msg = msg.slice(0, 500) + '…';
  return `${t} ${bits.join(' ')}${msg ? ' :: ' + msg : ''}`;
}

(async () => {
  const proj = await prisma.project.findUnique({ where: { id: PROJECT_ID }, select: { userId: true, name: true } });
  const user = await prisma.user.findUnique({ where: { id: proj.userId }, select: { id: true, email: true, role: true } });
  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role || 'user' }, process.env.JWT_SECRET, { expiresIn: '2h' });
  const cookie = `token=${token}`;
  const start = await prisma.run.findFirst({ where: { projectId: PROJECT_ID }, orderBy: { startedAt: 'desc' }, select: { id: true, status: true } });
  log(`ATTACH project="${proj.name}" latestRun=${start && start.id} status=${start && start.status}`);

  const ws = new WebSocket('ws://localhost:5000', { headers: { Cookie: cookie } });
  ws.on('open', () => log('WS connected (observe-only)'));
  ws.on('message', (raw) => { let ev; try { ev = JSON.parse(raw.toString()); } catch { return; } if (ev && ev.type === 'connected') return; log('WS  ' + summarize(ev)); });
  ws.on('error', (e) => log('WS error: ' + (e && e.message)));
  ws.on('close', () => log('WS closed'));

  const DEADLINE = Date.now() + 14 * 60 * 1000;
  let lastStatus = null;
  while (Date.now() < DEADLINE) {
    await new Promise((r) => setTimeout(r, 5000));
    const latest = await prisma.run.findFirst({ where: { projectId: PROJECT_ID }, orderBy: { startedAt: 'desc' }, select: { id: true, status: true, passed: true, failed: true, blocked: true } });
    if (latest && latest.status !== lastStatus) { lastStatus = latest.status; log(`DB run=${latest.id} status=${latest.status} pass=${latest.passed} fail=${latest.failed} blocked=${latest.blocked}`); }
    if (latest && ['completed', 'failed', 'cancelled', 'error'].includes(String(latest.status))) {
      await new Promise((r) => setTimeout(r, 5000));
      log(`TERMINAL run=${latest.id} status=${latest.status}`);
      break;
    }
  }
  try { ws.close(); } catch {}
  await prisma.$disconnect();
  setTimeout(() => process.exit(0), 1000);
})().catch((e) => { log('FATAL ' + (e && e.stack || e)); process.exit(1); });
