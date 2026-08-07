'use strict';
// Fresh single-case rerun of the Alice ESS-user case (a306ab75) to PROVE the
// display-gap fixes: DB blockedReason=test_data_invalid, error is the HUMAN
// explanation (not "mechanical_v1: step_blocked"), the value-entering step is
// BLOCKED (not a misleading PASS) and carries an `error` field, dependents
// blocked. No improvisation (no invented names), no navigation away.
const path = require('path'); const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const fs = require('fs');
const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
let WebSocket; try { WebSocket = require(path.join(ROOT, 'server', 'node_modules', 'ws')); } catch { WebSocket = require('ws'); }
const { PrismaClient } = require(path.join(ROOT, 'server', 'node_modules', '@prisma', 'client'));
const p = new PrismaClient();

const PID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const CASE = 'a306ab75-d150-42a2-a330-6cb8deb11a82'; // Admin creates ESS user → Employee Name=Alice (No Records)
const BASE = 'http://localhost:5000'; const CSRF = 'alice-csrf';
const LOG = path.join(ROOT, '_rerun_alice.log');
fs.writeFileSync(LOG, '');
const log = (l) => { const s = `[${new Date().toISOString()}] ${l}`; fs.appendFileSync(LOG, s + '\n'); console.log(s); };

(async () => {
  const proj = await p.project.findUnique({ where: { id: PID }, select: { userId: true } });
  const user = await p.user.findUnique({ where: { id: proj.userId }, select: { id: true, email: true, role: true } });
  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role || 'user' }, process.env.JWT_SECRET, { expiresIn: '3h' });
  const H = { 'Content-Type': 'application/json', 'x-xsrf-token': CSRF, Cookie: `token=${token}; XSRF-TOKEN=${CSRF}` };
  const before = await p.run.findFirst({ where: { projectId: PID }, orderBy: { startedAt: 'desc' }, select: { id: true } });
  const beforeId = before && before.id;

  const ws = new WebSocket('ws://localhost:5000', { headers: { Cookie: `token=${token}` } });
  ws.on('open', () => log('WS connected'));
  ws.on('message', (raw) => { let ev; try { ev = JSON.parse(raw.toString()); } catch { return; } const t = ev.type || ''; if (/browser\.frame|snapshot\.preview|download|connected|live/i.test(t)) return; const b = []; for (const k of ['phase', 'tcId', 'status', 'stepIndex', 'kind', 'matched']) if (ev[k] != null) b.push(`${k}=${ev[k]}`); let m = ev.message || ''; if (m && m.length > 220) m = m.slice(0, 220); log(`WS ${t} ${b.join(' ')}${m ? ' :: ' + m : ''}`); });
  await new Promise((r) => setTimeout(r, 1200));

  log(`POST /run-smoke {sequential, case=${CASE.slice(0,8)}}`);
  try { const r = await fetch(`${BASE}/api/projects/${PID}/agents/run-smoke`, { method: 'POST', headers: H, body: JSON.stringify({ testCaseIds: [CASE], runMode: 'sequential' }) }); const b = await r.json().catch(() => ({})); log(`/run-smoke → HTTP ${r.status} :: ${JSON.stringify(b).slice(0, 220)}`); }
  catch (e) { log('run-smoke err ' + e.message); }

  const DEADLINE = Date.now() + 12 * 60 * 1000; let newId = null;
  while (Date.now() < DEADLINE) {
    await new Promise((r) => setTimeout(r, 5000));
    const latest = await p.run.findFirst({ where: { projectId: PID }, orderBy: { startedAt: 'desc' }, select: { id: true, status: true, passed: true, failed: true, blocked: true } });
    if (latest && latest.id !== beforeId) {
      if (latest.id !== newId) { newId = latest.id; log(`NEW RUN ${newId} status=${latest.status}`); }
      if (['completed', 'failed', 'cancelled', 'error'].includes(String(latest.status))) { await new Promise((r) => setTimeout(r, 4000)); log(`TERMINAL ${newId} status=${latest.status} pass=${latest.passed} fail=${latest.failed} blocked=${latest.blocked}`); break; }
    }
  }

  // ── Verdict inspection ──────────────────────────────────────────────
  if (newId) {
    const rr = await p.runResult.findFirst({ where: { runId: newId, testCaseId: CASE }, orderBy: { createdAt: 'desc' } });
    if (!rr) { log('NO runResult for this case in the new run'); }
    else {
      log('======== VERDICT (DB) ========');
      log(`rrId=${rr.id.slice(0,8)} status=${rr.status} blockedReason=${rr.blockedReason}`);
      log(`error=${JSON.stringify(rr.error)}`);
      log(`mechanicalVerdictReason=${JSON.stringify(rr.mechanicalVerdictReason)}`);
      let steps = [];
      try { steps = JSON.parse(rr.stepResults || '[]'); } catch {}
      log(`stepResults: ${steps.length} steps`);
      steps.forEach((s, i) => {
        const ev = s.error || s.evidence || s.reason || '';
        log(`  step ${i + 1}: status=${s.status||'-'} reason=${s.reason||'-'} | err/ev="${String(ev).slice(0,140)}"`);
      });
      // Pass/fail of the proof
      const blockedSrc = steps.findIndex((s) => s && s.reason === 'test_data_invalid');
      const checks = {
        'blockedReason==test_data_invalid': rr.blockedReason === 'test_data_invalid',
        'error is human (no mechanical_v1)': typeof rr.error === 'string' && !/mechanical_v1/.test(rr.error),
        'a step is blocked test_data_invalid (not all-pass)': blockedSrc >= 0,
        'blocked source step carries error field': blockedSrc >= 0 && typeof steps[blockedSrc].error === 'string' && steps[blockedSrc].error.length > 0,
        'no invented value (gaurav/dilbag) in error': !/gaurav|dilbag/i.test(JSON.stringify(rr.error) + JSON.stringify(steps)),
      };
      log('======== PROOF CHECKS ========');
      Object.entries(checks).forEach(([k, v]) => log(`  ${v ? 'PASS' : 'FAIL'}  ${k}`));
    }
  }
  log(`RERUN_ALICE_DONE newRunId=${newId}`);
  try { ws.close(); } catch {}
  await p.$disconnect();
  setTimeout(() => process.exit(0), 800);
})().catch((e) => { log('FATAL ' + (e && e.stack || e)); process.exit(1); });
