'use strict';
// Cancel the in-flight (rate-limited) suite, then rerun ONLY TS-13 (single case,
// no parallel load → no Claude rate-limit) and observe it to terminal.
const path = require('path');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const fs = require('fs');
const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
let WebSocket; try { WebSocket = require(path.join(ROOT, 'server', 'node_modules', 'ws')); } catch { WebSocket = require('ws'); }
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const TS13_CASE = 'cc13d9c4-862c-4243-ad7a-e348c37b9beb';
const PRIOR_RUN = '25556eab-0c61-4bd3-ac76-f86b996d4730';
const BASE = 'http://localhost:5000';
const CSRF = 'rerun-csrf';
const LOG = path.join(ROOT, '_rerun_observe.log');
fs.writeFileSync(LOG, '');
const log = (l) => { const s = `[${new Date().toISOString()}] ${l}`; fs.appendFileSync(LOG, s + '\n'); };

function summarize(ev) {
  if (!ev || typeof ev !== 'object') return String(ev);
  const t = ev.type || '?'; const bits = [];
  for (const k of ['phase','level','tcId','runId','status','stepIndex','kind','matched']) if (ev[k] != null) bits.push(`${k}=${typeof ev[k]==='object'?JSON.stringify(ev[k]):ev[k]}`);
  let m = ev.message || ev.detail || ''; if (typeof m === 'object') m = JSON.stringify(m); if (m && m.length > 350) m = m.slice(0,350)+'…';
  return `${t} ${bits.join(' ')}${m?' :: '+m:''}`;
}

(async () => {
  const proj = await prisma.project.findUnique({ where: { id: PROJECT_ID }, select: { userId: true } });
  const user = await prisma.user.findUnique({ where: { id: proj.userId }, select: { id: true, email: true, role: true } });
  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role || 'user' }, process.env.JWT_SECRET, { expiresIn: '2h' });
  const cookie = `token=${token}; XSRF-TOKEN=${CSRF}`;
  const H = { 'Content-Type': 'application/json', 'x-xsrf-token': CSRF, Cookie: cookie };

  // 1. cancel
  log('POST /cancel …');
  try { const r = await fetch(`${BASE}/api/projects/${PROJECT_ID}/agents/cancel`, { method: 'POST', headers: H, body: '{}' }); log(`/cancel → ${r.status}`); } catch (e) { log('cancel err ' + e.message); }

  // 2. wait until no running run
  for (let i = 0; i < 18; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const running = await prisma.run.findFirst({ where: { projectId: PROJECT_ID, status: 'running' }, select: { id: true } });
    if (!running) { log('no running run — clear to rerun'); break; }
    log('still winding down…');
  }
  const before = await prisma.run.findFirst({ where: { projectId: PROJECT_ID }, orderBy: { startedAt: 'desc' }, select: { id: true } });
  const beforeId = before && before.id;

  // 3. WS observe
  const ws = new WebSocket('ws://localhost:5000', { headers: { Cookie: `token=${token}` } });
  ws.on('open', () => log('WS connected'));
  ws.on('message', (raw) => { let ev; try { ev = JSON.parse(raw.toString()); } catch { return; } if (ev && ev.type==='connected') return; log('WS  ' + summarize(ev)); });
  ws.on('error', (e) => log('WS error ' + e.message));
  await new Promise((r) => setTimeout(r, 1500));

  // 4. single-case rerun
  log(`POST rerun TS-13 (case ${TS13_CASE}) …`);
  try {
    const r = await fetch(`${BASE}/api/projects/${PROJECT_ID}/agents/runs/${PRIOR_RUN}/cases/${TS13_CASE}/rerun`, { method: 'POST', headers: H, body: JSON.stringify({ note: 'Phase A validation' }) });
    const b = await r.json().catch(() => ({}));
    log(`rerun → HTTP ${r.status} :: ${JSON.stringify(b).slice(0,250)}`);
  } catch (e) { log('rerun err ' + e.message); }

  // 5. poll to terminal
  const DEADLINE = Date.now() + 11 * 60 * 1000; let newId = null;
  while (Date.now() < DEADLINE) {
    await new Promise((r) => setTimeout(r, 5000));
    const latest = await prisma.run.findFirst({ where: { projectId: PROJECT_ID }, orderBy: { startedAt: 'desc' }, select: { id: true, status: true, passed: true, failed: true, blocked: true } });
    if (latest && latest.id !== beforeId) {
      if (latest.id !== newId) { newId = latest.id; log(`NEW RERUN: ${newId} status=${latest.status}`); }
      if (['completed','failed','cancelled','error'].includes(String(latest.status))) { await new Promise((r)=>setTimeout(r,4000)); log(`RERUN TERMINAL ${newId} status=${latest.status} pass=${latest.passed} fail=${latest.failed} blocked=${latest.blocked}`); break; }
    }
  }
  log(`RERUN_DONE newRunId=${newId}`);
  try { ws.close(); } catch {}
  await prisma.$disconnect();
  setTimeout(() => process.exit(0), 1000);
})().catch((e) => { log('FATAL ' + (e && e.stack || e)); process.exit(1); });
