'use strict';
const path = require('path'); process.chdir(path.join(__dirname, '..'));
const { PrismaClient } = require('@prisma/client'); const p = new PrismaClient();
const tda = require('../server/services/testDataAuthoring');
const ctx = require('../server/services/testDataContext');
const PID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const J = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
(async () => {
  const g = await p.scenarioGeneration.findFirst({ where: { projectId: PID, isCurrent: true }, orderBy: { version: 'desc' } });
  const scenRows = await p.testScenario.findMany({ where: { projectId: PID, generationId: g.id }, select: { id: true, name: true, module: true, cases: { select: { name: true, steps: true, dataBindingJson: true }, orderBy: { createdAt: 'asc' } } } });
  // Reconstruct the in-memory shape bindUncoveredDataSheets expects.
  const scenarios = scenRows.map((s) => ({ name: s.name, module: s.module, cases: s.cases.map((c) => ({ name: c.name, steps: J(c.steps, []) || [], dataBinding: J(c.dataBindingJson, null) })) }));
  const testData = await ctx.loadTestDataContext(PID);

  // Inspect: which sheets are variation? what fill-step elements do candidate cases have?
  const bindings = tda.bindingsFor(testData);
  console.log('bindings:', bindings.map((b) => b.sheet).join(', '));
  // Show fill-step elements across all cases (to see what matchFillStepRole sees)
  const fillElements = new Set();
  for (const sc of scenarios) for (const c of sc.cases) for (const st of c.steps) {
    if (/fill|type|enter/i.test(String(st.action || ''))) fillElements.add(`${st.action}:${st.element || st.target || '?'}`);
  }
  console.log('distinct fill steps seen:', [...fillElements].slice(0, 20).join(' | '));

  const before = scenarios.flatMap((s) => s.cases).filter((c) => c.dataBinding && c.dataBinding.sheet).length;
  const stats = tda.bindUncoveredDataSheets(scenarios, testData, {});
  const after = scenarios.flatMap((s) => s.cases).filter((c) => c.dataBinding && c.dataBinding.sheet).length;
  console.log('\nbindUncoveredDataSheets stats:', JSON.stringify(stats));
  console.log(`bound cases before=${before} after=${after}`);
  // Show any case that got bound + its parameterized steps
  for (const sc of scenarios) for (const c of sc.cases) {
    if (c.dataBinding && c.dataBinding.source === 'synthesized_coverage') {
      console.log(`  BOUND: "${c.name}" → ${c.dataBinding.sheet} | fill values:`, c.steps.filter((s)=>/fill/i.test(String(s.action||''))).map((s)=>s.value).join(', '));
    }
  }
  await p.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
