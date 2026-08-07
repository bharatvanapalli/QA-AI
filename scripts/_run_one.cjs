'use strict';
// Fresh single-case run of admin-login (f3555978) to capture per-action locator-capture
// telemetry (_capture_trace.log, QAAI_CAPTURE_TRACE=1) and re-inspect the resulting IR.
const path = require('path'); const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const fs = require('fs');
const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
let WebSocket; try { WebSocket = require(path.join(ROOT, 'server', 'node_modules', 'ws')); } catch { WebSocket = require('ws'); }
const { PrismaClient } = require(path.join(ROOT, 'server', 'node_modules', '@prisma', 'client'));
const p = new PrismaClient();

const PID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const CASE = 'f3555978-578d-4369-b57f-12479fc67c61'; // Admin login (data-driven)
const BASE = 'http://localhost:5000'; const CSRF = 'one-csrf';
const LOG = path.join(ROOT, '_run_one.log');
fs.writeFileSync(LOG, '');
const log = (l) => { const s = `[${new Date().toISOString()}] ${l}`; fs.appendFileSync(LOG, s + '\n'); };

(async () => {
  const proj = await p.project.findUnique({ where: { id: PID }, select: { userId: true } });
  const user = await p.user.findUnique({ where: { id: proj.userId }, select: { id: true, email: true, role: true } });
  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role || 'user' }, process.env.JWT_SECRET, { expiresIn: '3h' });
  const H = { 'Content-Type': 'application/json', 'x-xsrf-token': CSRF, Cookie: `token=${token}; XSRF-TOKEN=${CSRF}` };
  const before = await p.run.findFirst({ where: { projectId: PID }, orderBy: { startedAt: 'desc' }, select: { id: true } });
  const beforeId = before && before.id;

  const ws = new WebSocket('ws://localhost:5000', { headers: { Cookie: `token=${token}` } });
  ws.on('open', () => log('WS connected'));
  ws.on('message', (raw) => { let ev; try { ev = JSON.parse(raw.toString()); } catch { return; } const t = ev.type || ''; if (/browser\.frame|snapshot\.preview|download|connected/i.test(t)) return; const b = []; for (const k of ['phase', 'tcId', 'status', 'stepIndex', 'kind', 'matched']) if (ev[k] != null) b.push(`${k}=${ev[k]}`); let m = ev.message || ''; if (m && m.length > 200) m = m.slice(0, 200); log(`WS ${t} ${b.join(' ')}${m ? ' :: ' + m : ''}`); });
  await new Promise((r) => setTimeout(r, 1200));

  log(`POST /run-smoke {sequential, 1 case}`);
  try { const r = await fetch(`${BASE}/api/projects/${PID}/agents/run-smoke`, { method: 'POST', headers: H, body: JSON.stringify({ testCaseIds: [CASE], runMode: 'sequential' }) }); const b = await r.json().catch(() => ({})); log(`/run-smoke → HTTP ${r.status} :: ${JSON.stringify(b).slice(0, 200)}`); }
  catch (e) { log('run-smoke err ' + e.message); }

  const DEADLINE = Date.now() + 8 * 60 * 1000; let newId = null;
  while (Date.now() < DEADLINE) {
    await new Promise((r) => setTimeout(r, 5000));
    const latest = await p.run.findFirst({ where: { projectId: PID }, orderBy: { startedAt: 'desc' }, select: { id: true, status: true, passed: true, failed: true, blocked: true } });
    if (latest && latest.id !== beforeId) {
      if (latest.id !== newId) { newId = latest.id; log(`NEW RUN ${newId} status=${latest.status}`); }
      if (['completed', 'failed', 'cancelled', 'error'].includes(String(latest.status))) { await new Promise((r) => setTimeout(r, 4000)); log(`TERMINAL ${newId} status=${latest.status} pass=${latest.passed} fail=${latest.failed} blocked=${latest.blocked}`); break; }
    }
  }
  log(`RUN_ONE_DONE newRunId=${newId}`);
  try { ws.close(); } catch {}
  await p.$disconnect();
  setTimeout(() => process.exit(0), 800);
})().catch((e) => { log('FATAL ' + (e && e.stack || e)); process.exit(1); });
