'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
function parse(v) { if (!v) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } }

(async () => {
  // Requirements / user stories
  const reqs = await prisma.requirement.findMany({ where: { projectId: PROJECT_ID } }).catch(() => []);
  console.log('=== USER STORIES / REQUIREMENTS ===');
  for (const r of reqs) {
    console.log(`\n[${r.refId || r.id}] ${r.title || ''}`);
    const body = (r.text || r.description || r.body || '').toString();
    console.log(body.slice(0, 1400));
  }

  // RBAC + AuthProfiles rows
  const tds = await prisma.testDataSet.findFirst({ where: { projectId: PROJECT_ID }, orderBy: { uploadedAt: 'desc' } });
  const sheets = parse(tds.sheetsJson);
  const arr = Array.isArray(sheets?.sheets) ? sheets.sheets : Array.isArray(sheets) ? sheets : [];
  for (const name of ['RoleAccessControl', 'AuthProfiles']) {
    const s = arr.find(x => x.name === name);
    console.log(`\n=== SHEET ${name} (${s?.rows?.length || 0} rows) ===`);
    (s?.rows || []).forEach((row, i) => console.log(`  row${i}: ${JSON.stringify(row).slice(0, 400)}`));
  }

  // Finding codes on current generation cases
  const gen = await prisma.scenarioGeneration.findFirst({ where: { projectId: PROJECT_ID, isCurrent: true }, orderBy: { version: 'desc' } });
  const cases = await prisma.testCase.findMany({ where: { projectId: PROJECT_ID, generationId: gen.id }, select: { name: true, dataBindingJson: true } });
  const codeCount = {};
  for (const c of cases) {
    const db = parse(c.dataBindingJson);
    for (const f of (db?.findings || [])) {
      const k = `${f.code}|${f.severity}`;
      codeCount[k] = (codeCount[k] || 0) + 1;
    }
  }
  console.log('\n=== FINDING CODES across current cases (code|severity → count) ===');
  Object.entries(codeCount).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${k}: ${n}`));
  // one full finding sample
  const sample = cases.find(c => { const db = parse(c.dataBindingJson); return db?.findings?.length; });
  if (sample) console.log('\nSAMPLE findings for "' + sample.name + '":\n', JSON.stringify(parse(sample.dataBindingJson).findings, null, 1).slice(0, 900));
  await prisma.$disconnect();
})().catch(e => { console.error(e); prisma.$disconnect(); process.exit(1); });
