'use strict';
// Run the 20-step NON-LOGIN benchmark (Admin creates ESS user...) and capture every
// step checkpoint verdict (kind/matched/reason/evidence) so we can see step 8 (the
// former text-block) AND the full rich journey (dropdowns, autocomplete, form, table).
const path = require('path'); const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const fs = require('fs');
const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
let WebSocket; try { WebSocket = require(path.join(ROOT, 'server', 'node_modules', 'ws')); } catch { WebSocket = require('ws'); }
const { PrismaClient } = require(path.join(ROOT, 'server', 'node_modules', '@prisma', 'client'));
const p = new PrismaClient();

const PID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const CASE = 'a306ab75-d150-42a2-a330-6cb8deb11a82'; // Admin creates ESS user, verifies list, logs out (20 steps)
const BASE = 'http://localhost:5000'; const CSRF = 'bench-csrf';
const LOG = path.join(ROOT, '_run_benchmark.log');
fs.writeFileSync(LOG, '');
const log = (l) => { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${l}\n`); };

(async () => {
  const proj = await p.project.findUnique({ where: { id: PID }, select: { userId: true } });
  const user = await p.user.findUnique({ where: { id: proj.userId }, select: { id: true, email: true, role: true } });
  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role || 'user' }, process.env.JWT_SECRET, { expiresIn: '3h' });
  const H = { 'Content-Type': 'application/json', 'x-xsrf-token': CSRF, Cookie: `token=${token}; XSRF-TOKEN=${CSRF}` };
  const before = await p.run.findFirst({ where: { projectId: PID }, orderBy: { startedAt: 'desc' }, select: { id: true } });
  const beforeId = before && before.id;

  const ws = new WebSocket('ws://localhost:5000', { headers: { Cookie: `token=${token}` } });
  ws.on('open', () => log('WS connected'));
  ws.on('message', (raw) => {
    let ev; try { ev = JSON.parse(raw.toString()); } catch { return; }
    const t = ev.type || '';
    if (/browser\.frame|snapshot\.preview|download|connected|frame/i.test(t)) return;
    if (t === 'step.operationCheck' || t === 'step.complete' || t === 'result') {
      const b = [];
      for (const k of ['stepIndex', 'status', 'kind', 'matched', 'reason']) if (ev[k] != null) b.push(`${k}=${ev[k]}`);
      let m = ev.evidence || ev.message || ev.error || '';
      if (typeof m === 'object') m = JSON.stringify(m);
      if (m && m.length > 220) m = m.slice(0, 220);
      log(`${t} ${b.join(' ')}${m ? ' :: ' + m : ''}`);
    }
  });
  await new Promise((r) => setTimeout(r, 1200));

  log(`POST /run-smoke {sequential, CASE=${CASE}}`);
  try { const r = await fetch(`${BASE}/api/projects/${PID}/agents/run-smoke`, { method: 'POST', headers: H, body: JSON.stringify({ testCaseIds: [CASE], runMode: 'sequential' }) }); const bd = await r.json().catch(() => ({})); log(`/run-smoke → HTTP ${r.status} :: ${JSON.stringify(bd).slice(0, 200)}`); }
  catch (e) { log('run-smoke err ' + e.message); }

  const DEADLINE = Date.now() + 12 * 60 * 1000; let newId = null;
  while (Date.now() < DEADLINE) {
    await new Promise((r) => setTimeout(r, 6000));
    const latest = await p.run.findFirst({ where: { projectId: PID }, orderBy: { startedAt: 'desc' }, select: { id: true, status: true, passed: true, failed: true, blocked: true } });
    if (latest && latest.id !== beforeId) {
      if (latest.id !== newId) { newId = latest.id; log(`NEW RUN ${newId} status=${latest.status}`); }
      if (['completed', 'failed', 'cancelled', 'error'].includes(String(latest.status))) { await new Promise((r) => setTimeout(r, 5000)); log(`TERMINAL ${newId} status=${latest.status} pass=${latest.passed} fail=${latest.failed} blocked=${latest.blocked}`); break; }
    }
  }
  log(`BENCH_DONE newRunId=${newId}`);
  try { ws.close(); } catch {}
  await p.$disconnect();
  setTimeout(() => process.exit(0), 800);
})().catch((e) => { log('FATAL ' + (e && e.stack || e)); process.exit(1); });
