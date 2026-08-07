'use strict';
const path = require('path'); const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
const { PrismaClient } = require('@prisma/client'); const p = new PrismaClient();
const PID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const BASE = 'http://localhost:5000'; const CSRF = 'inv-csrf';
const J = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
(async () => {
  const proj = await p.project.findUnique({ where: { id: PID }, select: { userId: true } });
  const user = await p.user.findUnique({ where: { id: proj.userId }, select: { id: true, email: true, role: true } });
  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role || 'user' }, process.env.JWT_SECRET, { expiresIn: '2h' });
  const H = { 'Content-Type': 'application/json', 'x-xsrf-token': CSRF, Cookie: `token=${token}; XSRF-TOKEN=${CSRF}` };
  // 1) approve-all
  const r = await fetch(`${BASE}/api/projects/${PID}/test-cases/approve-all`, { method: 'POST', headers: H, body: '{}' });
  const b = await r.json().catch(() => ({}));
  console.log('approve-all →', r.status, JSON.stringify(b));
  // 2) inventory current gen
  const g = await p.scenarioGeneration.findFirst({ where: { projectId: PID, isCurrent: true }, orderBy: { version: 'desc' } });
  const scen = await p.testScenario.findMany({ where: { projectId: PID, generationId: g.id }, orderBy: { createdAt: 'asc' }, select: { name: true, cases: { select: { id: true, name: true, status: true, type: true, steps: true, dataBindingJson: true, businessRisk: true }, orderBy: { createdAt: 'asc' } } } });
  const rows = [];
  for (const s of scen) for (const c of s.cases) {
    const steps = J(c.steps, []) || [];
    const db = J(c.dataBindingJson, null);
    rows.push({ id: c.id, scenario: s.name, name: c.name, steps: steps.length, type: c.type, risk: c.businessRisk, sheet: db && db.sheet || '', status: c.status });
  }
  rows.sort((a, b2) => b2.steps - a.steps);
  console.log(`\n=== gen v${g.version} — ${rows.length} cases (sorted by step count desc) ===`);
  for (const r2 of rows) {
    console.log(`${String(r2.steps).padStart(2)}st [${r2.risk}] ${r2.sheet ? '{' + r2.sheet + '} ' : ''}${r2.name}  ::SC:: ${r2.scenario}  ::ID:: ${r2.id}`);
  }
  await p.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
