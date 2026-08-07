'use strict';
// FULL (complete-mode) generation across ALL functionality in the uploaded BRD/user-stories +
// every test-data sheet — the final, non-focus run. Observes live; polls until populated.
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
const CSRF = 'full-gen-csrf';
const LOG = path.join(ROOT, '_full_gen.log');
fs.writeFileSync(LOG, '');
const log = (l) => fs.appendFileSync(LOG, `[${new Date().toISOString().slice(11, 19)}] ${l}\n`);
function sum(ev) { if (!ev || typeof ev !== 'object') return String(ev); const t = ev.type || '?'; const b = []; for (const k of ['phase', 'level', 'status', 'scenarios', 'cases', 'code']) if (ev[k] != null) b.push(`${k}=${typeof ev[k] === 'object' ? JSON.stringify(ev[k]) : ev[k]}`); let m = ev.message || ev.detail || ''; if (typeof m === 'object') m = JSON.stringify(m); if (m && m.length > 400) m = m.slice(0, 400) + '…'; return `${t} ${b.join(' ')}${m ? ' :: ' + m : ''}`; }

// Complete mode: cover EVERYTHING the documents describe, across all functionalities + all sheets.
const directive = 'COMPLETE suite — generate scenarios for ALL functionality described in the uploaded BRD/user stories and exercise EVERY uploaded test-data sheet (authentication, role-based access control, form validation, negative auth, security, expected results). Cover positive, negative, edge, boundary and security cases. Bind every data-driven case to its sheet and rows.';
const sessionGuidance = `[GENERATION MODE — Complete]: ${directive}`;

(async () => {
  const proj = await prisma.project.findUnique({ where: { id: PROJECT_ID }, select: { userId: true } });
  const user = await prisma.user.findUnique({ where: { id: proj.userId }, select: { id: true, email: true, role: true } });
  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role || 'user' }, process.env.JWT_SECRET, { expiresIn: '3h' });
  const H = { 'Content-Type': 'application/json', 'x-xsrf-token': CSRF, Cookie: `token=${token}; XSRF-TOKEN=${CSRF}` };
  const beforeGen = await prisma.scenarioGeneration.findFirst({ where: { projectId: PROJECT_ID, isCurrent: true }, orderBy: { version: 'desc' }, select: { version: true } });
  const beforeVer = beforeGen ? beforeGen.version : 0;
  log(`current version=${beforeVer}; triggering COMPLETE generation (replace:true, reuse atlas)`);

  const ws = new WebSocket('ws://localhost:5000', { headers: { Cookie: `token=${token}` } });
  ws.on('open', () => log('WS connected'));
  ws.on('message', (raw) => { let ev; try { ev = JSON.parse(raw.toString()); } catch { return; } if (ev && ev.type === 'connected') return; const t = ev.type || ''; if (/frame|snapshot\.preview|download|heartbeat|ping/i.test(t)) return; log('WS ' + sum(ev)); });
  ws.on('error', (e) => log('WS error ' + e.message));
  await new Promise((r) => setTimeout(r, 1200));

  log('POST /scenarios/generate …');
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/api/projects/${PROJECT_ID}/scenarios/generate`, { method: 'POST', headers: H, body: JSON.stringify({ replace: true, forceAtlasRefresh: false, sessionGuidance }) });
    const b = await r.json().catch(() => ({}));
    log(`/generate → HTTP ${r.status} in ${((Date.now() - t0) / 1000).toFixed(0)}s :: ${JSON.stringify(b).slice(0, 300)}`);
  } catch (e) { log('generate ERR ' + e.message); }

  const DEADLINE = Date.now() + 10 * 60 * 1000; let done = false;
  while (Date.now() < DEADLINE) {
    await new Promise((r) => setTimeout(r, 5000));
    const g = await prisma.scenarioGeneration.findFirst({ where: { projectId: PROJECT_ID, isCurrent: true }, orderBy: { version: 'desc' }, select: { id: true, version: true } });
    if (g && g.version > beforeVer) {
      const scn = await prisma.testScenario.count({ where: { projectId: PROJECT_ID, generationId: g.id } });
      const cws = await prisma.testCase.count({ where: { projectId: PROJECT_ID, generationId: g.id, NOT: { steps: null } } });
      if (!done) { done = true; log(`NEW GENERATION v${g.version} (${g.id}) scenarios=${scn} casesWithSteps=${cws}`); }
      if (cws >= scn && scn > 0) { await new Promise((r) => setTimeout(r, 3000)); log(`FULL_GEN_DONE v${g.version} scenarios=${scn} casesWithSteps=${cws} genId=${g.id}`); break; }
    }
  }
  if (!done) log('FULL_GEN_TIMEOUT');
  try { ws.close(); } catch {}
  await prisma.$disconnect();
  setTimeout(() => process.exit(0), 1000);
})().catch((e) => { log('FATAL ' + (e && e.stack || e)); process.exit(1); });
