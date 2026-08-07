'use strict';
// Trigger a LIVE execution run of the current generation and observe it serially.
// Captures step.* / assertion.* / verdict.* / browser.session* / conductor logs with
// their FIELDS (to spot missing step numbers / validation checks), counts how many
// browser sessions are open AT ONCE (must be 1 — serial), and times the gaps between
// steps (to quantify slowness). Runs for a bounded window then CANCELS the run so it
// does not keep executing.
const path = require('path');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const fs = require('fs');
const jwt = require('jsonwebtoken');
let WebSocket; try { WebSocket = require(path.join(ROOT, 'server', 'node_modules', 'ws')); } catch { WebSocket = require('ws'); }
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const BASE = 'http://localhost:5000';
const CSRF = 'exec-obs-csrf';
const OBSERVE_MS = Number(process.env.OBSERVE_MS || 180000); // ~3 min window
const LOG = path.join(ROOT, '_exec_obs.log');
fs.writeFileSync(LOG, '');
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const log = (l) => { fs.appendFileSync(LOG, `[${ts()}s] ${l}\n`); };

const openSessions = new Set();
let maxConcurrent = 0;
let lastStepAt = Date.now();
const stepEvents = [];

function summarize(ev) {
  const t = ev.type || '?';
  if (/frame|screencast|snapshot\.preview|heartbeat|ping|pong/i.test(t)) return null;
  if (t === 'browser.session') { openSessions.add(ev.sessionId); maxConcurrent = Math.max(maxConcurrent, openSessions.size); return `BROWSER.OPEN session=${String(ev.sessionId).slice(0,8)} | NOW OPEN=${openSessions.size} (max=${maxConcurrent})`; }
  if (t === 'browser.session.end') { openSessions.delete(ev.sessionId); return `BROWSER.CLOSE session=${String(ev.sessionId).slice(0,8)} | NOW OPEN=${openSessions.size}`; }
  if (/^step\./.test(t)) {
    const gap = ((Date.now() - lastStepAt) / 1000).toFixed(1); lastStepAt = Date.now();
    const idx = ev.stepIndex ?? ev.index ?? ev.stepNumber ?? ev.step ?? '∅';
    const desc = ev.description || ev.label || ev.summary || ev.message || ev.text || '';
    const tc = ev.tcId ? ` tc=${String(ev.tcId).slice(0,8)}` : '';
    const hasNum = (idx !== '∅' && idx !== undefined && idx !== null);
    stepEvents.push({ t, hasNum, hasDesc: !!desc });
    return `${t} [+${gap}s]${tc} stepNum=${idx}${hasNum?'':' «MISSING-NUM»'} | ${String(desc).slice(0,90)}${desc?'':' «MISSING-DESC»'}`;
  }
  if (/assertion|verdict/.test(t)) {
    const desc = ev.message || ev.description || ev.evidence || ev.reason || JSON.stringify(ev).slice(0,120);
    return `${t} | ${String(desc).slice(0,120)}`;
  }
  if (t === 'agent.phase.log') {
    const m = ev.message || ''; if (/frame|screencast/i.test(m)) return null;
    return `LOG[${ev.level||'info'}] ${String(m).slice(0,160)}`;
  }
  if (/run\.(start|complete|status)|agent\.phase\.(start|complete)/.test(t)) return `${t} ${ev.phase||''} ${ev.status||''}`;
  return null;
}

(async () => {
  const proj = await prisma.project.findUnique({ where: { id: PROJECT_ID }, select: { userId: true } });
  const user = await prisma.user.findUnique({ where: { id: proj.userId }, select: { id: true, email: true, role: true } });
  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role || 'user' }, process.env.JWT_SECRET, { expiresIn: '4h' });
  const H = { 'Content-Type': 'application/json', 'x-xsrf-token': CSRF, Cookie: `token=${token}; XSRF-TOKEN=${CSRF}` };

  const ws = new WebSocket('ws://localhost:5000', { headers: { Cookie: `token=${token}` } });
  ws.on('open', () => log('WS connected'));
  ws.on('message', (raw) => { let ev; try { ev = JSON.parse(raw.toString()); } catch { return; } if (ev?.type === 'connected') return; const line = summarize(ev); if (line) log('WS ' + line); });
  ws.on('error', (e) => log('WS error ' + e.message));
  await new Promise((r) => setTimeout(r, 1200));

  log('POST /agents/execute (run APPROVED cases of the CURRENT generation — no architect/regeneration) …');
  try {
    const r = await fetch(`${BASE}/api/projects/${PROJECT_ID}/agents/execute`, { method: 'POST', headers: H, body: JSON.stringify({}) });
    const b = await r.json().catch(() => ({}));
    log(`/start → HTTP ${r.status} :: ${JSON.stringify(b).slice(0, 240)}`);
    if (r.status === 409) { log('RUN ALREADY IN PROGRESS — will still observe, then cancel.'); }
  } catch (e) { log('start ERR ' + e.message); }

  await new Promise((r) => setTimeout(r, OBSERVE_MS));

  // Stop observing — cancel the run so it does not keep executing.
  log('OBSERVE window elapsed — cancelling run.');
  try {
    const r = await fetch(`${BASE}/api/projects/${PROJECT_ID}/agents/cancel`, { method: 'POST', headers: H, body: JSON.stringify({}) });
    log(`/cancel → HTTP ${r.status}`);
  } catch (e) { log('cancel ERR ' + e.message); }

  const numbered = stepEvents.filter((s) => s.hasNum).length;
  const described = stepEvents.filter((s) => s.hasDesc).length;
  log(`\n──── SUMMARY ────`);
  log(`max browser sessions open at once = ${maxConcurrent} (serial target = 1)`);
  log(`step events=${stepEvents.length} | with-number=${numbered} | MISSING-number=${stepEvents.length - numbered} | with-desc=${described} | MISSING-desc=${stepEvents.length - described}`);
  try { ws.close(); } catch {}
  await prisma.$disconnect();
  setTimeout(() => process.exit(0), 800);
})().catch((e) => { log('FATAL ' + (e && e.stack || e)); process.exit(1); });
