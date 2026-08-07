'use strict';
// Serial smoke run of the selected BENCHMARK edge-case/flow cases. runMode sequential
// (one at a time, no parallel, no rate-limit). Observes the WS chain + polls to terminal.
const path = require('path'); const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const fs = require('fs');
const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
let WebSocket; try { WebSocket = require(path.join(ROOT, 'server', 'node_modules', 'ws')); } catch { WebSocket = require('ws'); }
const { PrismaClient } = require('@prisma/client'); const p = new PrismaClient();

const PID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const BASE = 'http://localhost:5000'; const CSRF = 'smoke-csrf';
const LOG = path.join(ROOT, '_smoke_observe.log');
const TEST_CASE_IDS = [
  'f3555978-578d-4369-b57f-12479fc67c61', // Admin login (AuthProfiles, data-driven, per-row reset)
  '0e445403-9fb3-4d7e-b4c5-d584bd18d4d6', // Admin logout redirect
  '6773b1db-c635-45fe-9bcf-34f857c2478f', // Post-logout /dashboard redirect (session security)
  '8bd867de-aa20-45a5-995c-be812cc6eb74', // Admin session persists across navigation
  'e1fcc7a3-e2fe-49f8-a61d-66d5fe3d0a57', // SQL injection OR-payload (SecurityAuth, data-driven)
];
fs.writeFileSync(LOG, '');
const log = (l) => { const s = `[${new Date().toISOString()}] ${l}`; fs.appendFileSync(LOG, s + '\n'); };
function sum(ev){ if(!ev||typeof ev!=='object') return String(ev); const t=ev.type||'?'; const b=[]; for(const k of ['phase','level','tcId','status','stepIndex','kind','matched']) if(ev[k]!=null) b.push(`${k}=${typeof ev[k]==='object'?JSON.stringify(ev[k]):ev[k]}`); let m=ev.message||ev.detail||''; if(typeof m==='object') m=JSON.stringify(m); if(m&&m.length>300) m=m.slice(0,300)+'…'; return `${t} ${b.join(' ')}${m?' :: '+m:''}`; }

(async () => {
  const proj = await p.project.findUnique({ where: { id: PID }, select: { userId: true } });
  const user = await p.user.findUnique({ where: { id: proj.userId }, select: { id: true, email: true, role: true } });
  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role || 'user' }, process.env.JWT_SECRET, { expiresIn: '3h' });
  const H = { 'Content-Type': 'application/json', 'x-xsrf-token': CSRF, Cookie: `token=${token}; XSRF-TOKEN=${CSRF}` };
  const before = await p.run.findFirst({ where: { projectId: PID }, orderBy: { startedAt: 'desc' }, select: { id: true } });
  const beforeId = before && before.id;

  const ws = new WebSocket('ws://localhost:5000', { headers: { Cookie: `token=${token}` } });
  ws.on('open', () => log('WS connected'));
  ws.on('message', (raw) => { let ev; try{ev=JSON.parse(raw.toString());}catch{return;} if(ev&&ev.type==='connected') return; const t=ev.type||''; if(/browser\.frame|snapshot\.preview|download/i.test(t)) return; log('WS '+sum(ev)); });
  ws.on('error', (e) => log('WS error '+e.message));
  await new Promise((r)=>setTimeout(r,1500));

  log(`POST /run-smoke {sequential, ${TEST_CASE_IDS.length} cases} …`);
  try { const r = await fetch(`${BASE}/api/projects/${PID}/agents/run-smoke`, { method:'POST', headers:H, body: JSON.stringify({ testCaseIds: TEST_CASE_IDS, runMode: 'sequential' }) }); const b=await r.json().catch(()=>({})); log(`/run-smoke → HTTP ${r.status} :: ${JSON.stringify(b).slice(0,300)}`); }
  catch(e){ log('run-smoke err '+e.message); }

  const DEADLINE = Date.now() + 25*60*1000; let newId=null;
  while (Date.now() < DEADLINE) {
    await new Promise((r)=>setTimeout(r,6000));
    const latest = await p.run.findFirst({ where: { projectId: PID }, orderBy: { startedAt: 'desc' }, select: { id: true, status: true, passed: true, failed: true, blocked: true } });
    if (latest && latest.id !== beforeId) {
      if (latest.id !== newId) { newId = latest.id; log(`NEW SMOKE RUN ${newId} status=${latest.status}`); }
      if (['completed','failed','cancelled','error'].includes(String(latest.status))) { await new Promise((r)=>setTimeout(r,5000)); log(`SMOKE TERMINAL ${newId} status=${latest.status} pass=${latest.passed} fail=${latest.failed} blocked=${latest.blocked}`); break; }
    }
  }
  log(`SMOKE_DONE newRunId=${newId}`);
  try { ws.close(); } catch {}
  await p.$disconnect();
  setTimeout(()=>process.exit(0),1000);
})().catch((e)=>{ log('FATAL '+(e&&e.stack||e)); process.exit(1); });
