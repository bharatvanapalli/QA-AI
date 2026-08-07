'use strict';
// One-time: apply the (proven) parameterize-and-bind pass to the CURRENT generation's
// persisted cases and write the bindings + tokenized steps back to the DB, so the
// serial run iterates the data rows. (Gen-time auto-bind hook is being debugged
// separately; this unblocks end-to-end observation now.)
const path = require('path'); process.chdir(path.join(__dirname, '..'));
const { PrismaClient } = require('@prisma/client'); const p = new PrismaClient();
const tda = require('../server/services/testDataAuthoring');
const ctx = require('../server/services/testDataContext');
const PID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const J = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
(async () => {
  const g = await p.scenarioGeneration.findFirst({ where: { projectId: PID, isCurrent: true }, orderBy: { version: 'desc' } });
  const scenRows = await p.testScenario.findMany({ where: { projectId: PID, generationId: g.id }, select: { id: true, name: true, module: true, cases: { select: { id: true, name: true, steps: true, dataBindingJson: true } } } });
  const idByCase = new Map();
  const scenarios = scenRows.map((s) => ({ name: s.name, module: s.module, cases: s.cases.map((c) => { const obj = { name: c.name, steps: J(c.steps, []) || [], dataBinding: J(c.dataBindingJson, null) }; idByCase.set(obj, c.id); return obj; }) }));
  const testData = await ctx.loadTestDataContext(PID);
  const stats = tda.bindUncoveredDataSheets(scenarios, testData, {});
  console.log('synthesis:', JSON.stringify(stats));
  let written = 0;
  for (const sc of scenarios) for (const c of sc.cases) {
    if (c.dataBinding && c.dataBinding.source === 'synthesized_coverage') {
      const id = idByCase.get(c);
      await p.testCase.update({ where: { id }, data: { dataBindingJson: JSON.stringify(c.dataBinding), steps: JSON.stringify(c.steps) } });
      written++;
      console.log(`  persisted: "${c.name}" → ${c.dataBinding.sheet}`);
    }
  }
  console.log(`gen v${g.version}: persisted ${written} data-driven binding(s).`);
  await p.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
