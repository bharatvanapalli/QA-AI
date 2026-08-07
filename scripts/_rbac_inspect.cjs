'use strict';
// Baseline inspector for the OrangeHRM project: provider, test-data sheets,
// requirements/user-stories, current generation, and a sample of current cases'
// dataBinding + automatability (the broken "before" state). Read-only.
const path = require('path');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const PROJECT_ID = process.argv[2] || '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';

function parse(v) { if (!v) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } }

(async () => {
  const p = await prisma.project.findUnique({ where: { id: PROJECT_ID } });
  if (!p) { console.log('NO PROJECT', PROJECT_ID); const all = await prisma.project.findMany({ select: { id: true, name: true } }); all.forEach(x => console.log('  ', x.id, x.name)); process.exit(0); }
  console.log('PROJECT:', p.id, '|', p.name);
  console.log('targetUrl:', p.targetUrl);
  // Print any provider/model/key-ish fields without dumping secret values
  const provKeys = Object.keys(p).filter(k => /provider|model|llm|apikey|api_key|gemini|anthropic|vault/i.test(k));
  console.log('provider-ish fields:', provKeys.map(k => `${k}=${typeof p[k] === 'string' && p[k].length > 20 ? '<set:' + p[k].length + '>' : p[k]}`).join(' | '));

  // Test data
  const tds = await prisma.testDataSet.findFirst({ where: { projectId: PROJECT_ID }, orderBy: { uploadedAt: 'desc' } });
  if (!tds) console.log('\nNO TEST DATA SET');
  else {
    const sheets = parse(tds.sheetsJson);
    const arr = Array.isArray(sheets?.sheets) ? sheets.sheets : Array.isArray(sheets) ? sheets : [];
    console.log(`\nTEST DATA: ${arr.length} sheets (set ${tds.id})`);
    for (const s of arr) {
      const headers = s.headers || (s.rows && s.rows[0] ? Object.keys(s.rows[0]) : []);
      const rc = Array.isArray(s.rows) ? s.rows.length : (s.rowCount || 0);
      console.log(`  - "${s.name}" rows=${rc} headers=[${(headers || []).join(', ')}]`);
    }
    // mapping
    const mapping = parse(tds.mappingJson);
    if (mapping) {
      const bindings = Array.isArray(mapping.bindings) ? mapping.bindings : Array.isArray(mapping) ? mapping : [];
      console.log(`\nMAPPING: ${bindings.length} bindings`);
      for (const b of bindings) {
        console.log(`  - sheet="${b.sheet}" purpose=${b.purpose} module=${b.module?.name || b.module} required=${b.required} expectedCol=${b.expectedColumn || '-'} columnToField=${JSON.stringify(b.columnToField || {})}`);
      }
    } else console.log('\nMAPPING: none');
  }

  // Requirements / user stories
  const reqCount = await prisma.requirement?.count?.({ where: { projectId: PROJECT_ID } }).catch(() => null);
  const docs = await prisma.document?.findMany?.({ where: { projectId: PROJECT_ID }, select: { name: true, kind: true } }).catch(() => []);
  console.log('\nrequirements:', reqCount, '| documents:', JSON.stringify(docs));

  // Current generation
  const gen = await prisma.scenarioGeneration.findFirst({ where: { projectId: PROJECT_ID, isCurrent: true }, orderBy: { version: 'desc' } });
  console.log('\nCURRENT GENERATION:', gen ? `v${gen.version} id=${gen.id} label="${gen.label || ''}"` : 'none');
  if (gen) {
    const scn = await prisma.testScenario.count({ where: { projectId: PROJECT_ID, generationId: gen.id } });
    const cases = await prisma.testCase.findMany({ where: { projectId: PROJECT_ID, generationId: gen.id }, select: { id: true, name: true, automatability: true, automatabilityReason: true, dataBindingJson: true } });
    console.log(`scenarios=${scn} cases=${cases.length}`);
    let manual = 0, incomplete = 0, withErr = 0, tokenCorrupt = 0;
    const re = /([a-z])\{\{[^}]+\}\}([a-z])|\{\{\{\{|\}\}\}\}/i;
    for (const c of cases) {
      if (c.automatability === 'manual') manual++;
      const db = parse(c.dataBindingJson);
      if (db && db.status === 'incomplete') incomplete++;
      const errs = (db && Array.isArray(db.findings)) ? db.findings.filter(f => f.severity === 'error') : [];
      if (errs.length) withErr++;
      if (re.test(c.name || '')) tokenCorrupt++;
    }
    console.log(`BASELINE BROKEN COUNTS → manual=${manual} status:incomplete=${incomplete} hasErrorFinding=${withErr} nameTokenCorrupt=${tokenCorrupt}`);
    // Sample 3 cases
    console.log('\nSAMPLE CASES:');
    for (const c of cases.slice(0, 4)) {
      const db = parse(c.dataBindingJson);
      console.log(`  • "${c.name}"`);
      console.log(`    automatability=${c.automatability} reason=${(c.automatabilityReason || '').slice(0, 90)}`);
      console.log(`    dataBinding=${JSON.stringify(db).slice(0, 240)}`);
    }
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); prisma.$disconnect(); process.exit(1); });
