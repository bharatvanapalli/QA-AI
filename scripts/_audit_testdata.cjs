'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const J = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

(async () => {
  const sets = await prisma.testDataSet.findMany({ where: { projectId: PROJECT_ID }, select: { id: true, name: true, sheetsJson: true, mappingJson: true, rowCount: true } });
  console.log(`\n=== TEST DATA SETS (${sets.length}) ===`);
  const sheetRowCounts = {};
  for (const s of sets) {
    const parsed = J(s.sheetsJson, {});
    const sheets = parsed.sheets || [];
    console.log(`\nDataSet "${s.name}" rowCount=${s.rowCount} mapping=${s.mappingJson ? 'present' : 'NONE'}`);
    for (const sh of sheets) {
      const rc = (sh.rows || []).length;
      sheetRowCounts[sh.name] = rc;
      console.log(`  · sheet "${sh.name}" rows=${rc} headers=[${(sh.headers || []).join(', ')}]`);
    }
    const m = J(s.mappingJson, null);
    if (m) console.log(`  mapping keys: ${Object.keys(m).join(', ')}`);
  }

  // current generation
  const gen = await prisma.scenarioGeneration.findFirst({ where: { projectId: PROJECT_ID, isCurrent: true }, orderBy: { version: 'desc' }, select: { id: true, version: true } });
  console.log(`\n=== CURRENT GENERATION: v${gen && gen.version} (${gen && gen.id}) ===`);

  const scenarios = await prisma.testScenario.findMany({
    where: { projectId: PROJECT_ID, ...(gen ? { generationId: gen.id } : {}) },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, cases: { select: { id: true, name: true, status: true, dataBindingJson: true, authProfile: true, steps: true }, orderBy: { createdAt: 'asc' } } },
  });
  console.log(`\n=== SCENARIOS (${scenarios.length}) + per-case data binding & coverage ===`);
  const boundSheets = {};
  let totalCases = 0, boundCases = 0, withVerify = 0, totalSteps = 0;
  for (const sc of scenarios) {
    console.log(`\nS: ${sc.name}  (${sc.cases.length} cases)`);
    for (const c of sc.cases) {
      totalCases++;
      const db = J(c.dataBindingJson, null);
      const steps = J(c.steps, []) || [];
      totalSteps += steps.length;
      const verifySteps = steps.filter((s) => s && s.verify && s.verify.kind && s.verify.kind !== 'none').length;
      const anyVerify = steps.some((s) => s && s.verify);
      if (anyVerify) withVerify++;
      const sheet = db && (db.sheet || db.sheetName);
      if (sheet) { boundSheets[sheet] = (boundSheets[sheet] || 0) + 1; boundCases++; }
      console.log(`   - [${c.status}] ${c.name}`);
      console.log(`       auth=${c.authProfile || '-'} | dataBinding=${db ? JSON.stringify(db) : 'NONE'} | steps=${steps.length} typedVerify=${anyVerify ? 'YES' : 'no'}(${verifySteps} typed)`);
    }
  }

  console.log(`\n=== COVERAGE SUMMARY ===`);
  console.log(`cases=${totalCases} | data-bound cases=${boundCases} | cases with typed verify=${withVerify} | total steps=${totalSteps}`);
  console.log(`sheet row inventory:`, JSON.stringify(sheetRowCounts));
  console.log(`sheets referenced by cases:`, JSON.stringify(boundSheets));
  const unused = Object.keys(sheetRowCounts).filter((s) => !boundSheets[s]);
  console.log(`sheets present but NOT bound by any case: ${unused.length ? unused.join(', ') : '(none)'}`);
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
