'use strict';
// FOCUSED complex-interaction generation, APPENDED to the current generation (keeps the validated
// auth/RBAC regression) and REUSING the fresh atlas (no re-crawl). Small batch → completes well
// within the request timeout → persists reliably. Observes events; polls until the case count grows.
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
const CSRF = 'cx-append-csrf';
const LOG = path.join(ROOT, '_complex_append.log');
fs.writeFileSync(LOG, '');
const log = (l) => fs.appendFileSync(LOG, `[${new Date().toISOString().slice(11, 19)}] ${l}\n`);
function sum(ev) { if (!ev || typeof ev !== 'object') return String(ev); const t = ev.type || '?'; const b = []; for (const k of ['phase', 'level', 'scenarios', 'cases']) if (ev[k] != null) b.push(`${k}=${ev[k]}`); let m = ev.message || ev.detail || ''; if (typeof m === 'object') m = JSON.stringify(m); if (m && m.length > 360) m = m.slice(0, 360) + '…'; return `${t} ${b.join(' ')}${m ? ' :: ' + m : ''}`; }

const directive = 'Generate 6 to 8 FOCUSED COMPLEX-INTERACTION test scenarios for OrangeHRM\'s interactive forms found in the SITE CONTEXT atlas — these are IN ADDITION to existing login/RBAC cases. Cover: (1) PIM Add Employee — fill first/middle/last name, toggle "Create Login Details", and the status/role dropdown; submit and verify. (2) Employee List search — type a partial name into the autocomplete/typeahead and pick a suggestion; select a dropdown filter; search and verify results. (3) Leave Apply — select a Leave Type from the dropdown and pick From/To dates in the date pickers; submit and verify. (4) Recruitment Add Candidate — fill name/email, select a vacancy dropdown, and verify. (5) A negative form case — submit a required-field form with a field left empty and assert the field-level validation error. Each step is ONE atomic action with the matching typed verify (selected/value/checked/text). Keep it concise — at most 8 scenarios, 2-3 cases each — so the suite is focused. Use representative values; no auth data sheet applies to these module forms.';
const sessionGuidance = `[GENERATION MODE — Focus]: ${directive}`;

(async () => {
  const proj = await prisma.project.findUnique({ where: { id: PROJECT_ID }, select: { userId: true } });
  const user = await prisma.user.findUnique({ where: { id: proj.userId }, select: { id: true, email: true, role: true } });
  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role || 'user' }, process.env.JWT_SECRET, { expiresIn: '3h' });
  const H = { 'Content-Type': 'application/json', 'x-xsrf-token': CSRF, Cookie: `token=${token}; XSRF-TOKEN=${CSRF}` };
  const curGen = await prisma.scenarioGeneration.findFirst({ where: { projectId: PROJECT_ID, isCurrent: true }, orderBy: { version: 'desc' }, select: { id: true, version: true } });
  const beforeCases = await prisma.testCase.count({ where: { projectId: PROJECT_ID, generationId: curGen.id } });
  log(`current v${curGen.version} cases=${beforeCases}; appending focused COMPLEX scenarios (reuse atlas)`);

  const ws = new WebSocket('ws://localhost:5000', { headers: { Cookie: `token=${token}` } });
  ws.on('open', () => log('WS connected'));
  ws.on('message', (raw) => { let ev; try { ev = JSON.parse(raw.toString()); } catch { return; } if (ev && ev.type === 'connected') return; const t = ev.type || ''; if (/frame|snapshot\.preview|heartbeat|ping|architect\.progress/i.test(t)) return; log('WS ' + sum(ev)); });
  ws.on('error', (e) => log('WS error ' + e.message));
  await new Promise((r) => setTimeout(r, 1200));

  log('POST /scenarios/generate {appendToCurrent:true, forceAtlasRefresh:false} …');
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/api/projects/${PROJECT_ID}/scenarios/generate`, { method: 'POST', headers: H, body: JSON.stringify({ appendToCurrent: true, forceAtlasRefresh: false, sessionGuidance }) });
    const b = await r.json().catch(() => ({}));
    log(`/generate → HTTP ${r.status} in ${((Date.now() - t0) / 1000).toFixed(0)}s :: ${JSON.stringify(b).slice(0, 300)}`);
  } catch (e) { log('generate ERR ' + e.message); }

  const DEADLINE = Date.now() + 7 * 60 * 1000; let done = false;
  while (Date.now() < DEADLINE) {
    await new Promise((r) => setTimeout(r, 5000));
    const g = await prisma.scenarioGeneration.findFirst({ where: { projectId: PROJECT_ID, isCurrent: true }, orderBy: { version: 'desc' }, select: { id: true, version: true } });
    const cases = await prisma.testCase.count({ where: { projectId: PROJECT_ID, generationId: g.id } });
    const scn = await prisma.testScenario.count({ where: { projectId: PROJECT_ID, generationId: g.id } });
    const cws = await prisma.testCase.count({ where: { projectId: PROJECT_ID, generationId: g.id, NOT: { steps: null } } });
    if ((g.version > curGen.version || cases > beforeCases) && cws >= scn && scn > 0) {
      if (!done) { done = true; await new Promise((r) => setTimeout(r, 3000)); log(`COMPLEX_APPEND_DONE v${g.version} scenarios=${scn} cases=${cases} (was ${beforeCases})`); break; }
    }
  }
  if (!done) log('COMPLEX_APPEND_TIMEOUT');
  try { ws.close(); } catch {}
  await prisma.$disconnect();
  setTimeout(() => process.exit(0), 1000);
})().catch((e) => { log('FATAL ' + (e && e.stack || e)); process.exit(1); });
