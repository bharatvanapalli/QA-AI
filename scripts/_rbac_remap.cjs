'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const BASE = 'http://localhost:5000';
const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';

(async () => {
  const proj = await prisma.project.findUnique({ where: { id: PROJECT_ID }, select: { userId: true } });
  const user = await prisma.user.findUnique({ where: { id: proj.userId }, select: { id: true, email: true, role: true } });
  const tds = await prisma.testDataSet.findFirst({ where: { projectId: PROJECT_ID }, orderBy: { uploadedAt: 'desc' }, select: { id: true } });
  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role || 'user' }, process.env.JWT_SECRET, { expiresIn: '2h' });
  const csrf = crypto.randomBytes(16).toString('hex');
  const H = { 'Content-Type': 'application/json', 'x-xsrf-token': csrf, Cookie: `token=${token}; XSRF-TOKEN=${csrf}` };

  console.log(`POST /test-data/${tds.id}/map …`);
  const t0 = Date.now();
  const r = await fetch(`${BASE}/api/projects/${PROJECT_ID}/test-data/${tds.id}/map`, { method: 'POST', headers: H, body: '{}' });
  const b = await r.json().catch(() => ({}));
  console.log(`→ HTTP ${r.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(JSON.stringify(b).slice(0, 400));

  // Verify the new mapping purposes/modules
  const row = await prisma.testDataSet.findUnique({ where: { id: tds.id }, select: { mappingJson: true } });
  let mapping; try { mapping = JSON.parse(row.mappingJson); } catch { mapping = null; }
  const bindings = Array.isArray(mapping?.bindings) ? mapping.bindings : [];
  console.log('\n=== RE-MAPPED BINDINGS ===');
  for (const bd of bindings) {
    console.log(`  "${bd.sheet}" purpose=${bd.purpose} module=${bd.module?.name || bd.module || '-'} shared=${bd.shared ?? bd.module?.shared} expectedCol=${bd.expectedColumn || '-'}`);
    console.log(`      columnToField=${JSON.stringify(bd.columnToField || {})}`);
  }
  await prisma.$disconnect();
})().catch(e => { console.error('ERR', e.message); prisma.$disconnect(); process.exit(1); });
