'use strict';
const path = require('path'); process.chdir(path.join(__dirname, '..'));
const { PrismaClient } = require('@prisma/client'); const p = new PrismaClient();
(async () => {
  const g = await p.scenarioGeneration.findFirst({ where: { projectId: '465f2d08-c8b5-469a-af41-9c0ba2a2ce93', isCurrent: true }, orderBy: { version: 'desc' } });
  const c = await p.testCase.findFirst({ where: { generationId: g.id, NOT: { steps: null } }, select: { name: true, steps: true, dataBindingJson: true } });
  console.log('gen v' + g.version, '| case:', c.name);
  console.log('dataBindingJson:', c.dataBindingJson);
  const steps = JSON.parse(c.steps || '[]');
  console.log('step count:', steps.length);
  console.log('step[0] keys:', Object.keys(steps[0] || {}).join(', '));
  console.log('first 2 steps:\n', JSON.stringify(steps.slice(0, 2), null, 1));
  // scan all cases for any verify / dataBinding present at all
  const all = await p.testCase.findMany({ where: { generationId: g.id, NOT: { steps: null } }, select: { steps: true, dataBindingJson: true } });
  let anyVerify = 0, anyBind = 0;
  for (const x of all) { if (x.dataBindingJson) anyBind++; const ss = JSON.parse(x.steps || '[]'); if (ss.some((s) => s && s.verify)) anyVerify++; }
  console.log(`\nacross ${all.length} cases: with verify field=${anyVerify}, with dataBindingJson=${anyBind}`);
  await p.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
