'use strict';
// Clean single-case TS-13 rerun to validate Phase A. NO cancel (backend restarted
// to clear the cancel registry). Waits for the real end-of-execution signal
// (final_verdict) rather than a new run id (in-place rerun reuses the run).
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
const CSRF = 'pa-csrf';
const LOG = path.join(ROOT, '_pa_observe.log');
fs.writeFileSync(LOG, '');
const log = (l) => { const s = `[${new Date().toISOString()}] ${l}`; fs.appendFileSync(LOG, s + '\n'); };
function sum(ev){ if(!ev||typeof ev!=='object') return String(ev); const t=ev.type||'?'; const b=[]; for(const k of ['phase','level','tcId','status','stepIndex','kind','matched']) if(ev[k]!=null) b.push(`${k}=${typeof ev[k]==='object'?JSON.stringify(ev[k]):ev[k]}`); let m=ev.message||ev.detail||''; if(typeof m==='object') m=JSON.stringify(m); if(m&&m.length>300) m=m.slice(0,300)+'…'; return `${t} ${b.join(' ')}${m?' :: '+m:''}`; }

(async () => {
  const proj = await prisma.project.findUnique({ where: { id: PROJECT_ID }, select: { userId: true } });
  const user = await prisma.user.findUnique({ where: { id: proj.userId }, select: { id: true, email: true, role: true } });
  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role || 'user' }, process.env.JWT_SECRET, { expiresIn: '2h' });
  const H = { 'Content-Type': 'application/json', 'x-xsrf-token': CSRF, Cookie: `token=${token}; XSRF-TOKEN=${CSRF}` };

  const ws = new WebSocket('ws://localhost:5000', { headers: { Cookie: `token=${token}` } });
  let sawFinalVerdict = false; let opChecks = 0;
  ws.on('open', () => log('WS connected'));
  ws.on('message', (raw) => { let ev; try{ev=JSON.parse(raw.toString());}catch{return;} if(ev&&ev.type==='connected') return; const line=sum(ev); log('WS '+line); if(/final_verdict accepted/.test(line)) sawFinalVerdict=true; if(ev.type==='step.operationCheck') opChecks++; });
  ws.on('error', (e) => log('WS error '+e.message));
  await new Promise((r)=>setTimeout(r,1500));

  log(`POST rerun TS-13 …`);
  try { const r = await fetch(`${BASE}/api/projects/${PROJECT_ID}/agents/runs/${PRIOR_RUN}/cases/${TS13_CASE}/rerun`, { method:'POST', headers:H, body: JSON.stringify({ note:'Phase A clean validation' }) }); const b=await r.json().catch(()=>({})); log(`rerun → HTTP ${r.status} :: ${JSON.stringify(b).slice(0,200)}`); } catch(e){ log('rerun err '+e.message); }

  const t0 = Date.now(); const DEADLINE = t0 + 11*60*1000;
  while (Date.now() < DEADLINE) {
    await new Promise((r)=>setTimeout(r,5000));
    // Real execution end: final_verdict seen AND we observed fresh operationChecks AND >90s elapsed (skip the instant reset burst).
    if (sawFinalVerdict && opChecks >= 3 && (Date.now()-t0) > 90000) { await new Promise((r)=>setTimeout(r,8000)); log(`PA_TERMINAL final_verdict seen, opChecks=${opChecks}`); break; }
  }
  // authoritative DB read
  const res = await prisma.runResult.findFirst({ where: { runId: PRIOR_RUN, testCaseId: TS13_CASE }, select: { status: true } });
  log(`PA_DONE resultStatus=${res && res.status} opChecks=${opChecks} finalVerdict=${sawFinalVerdict}`);
  try { ws.close(); } catch {}
  await prisma.$disconnect();
  setTimeout(()=>process.exit(0),1000);
})().catch((e)=>{ log('FATAL '+(e&&e.stack||e)); process.exit(1); });
