'use strict';
const path = require('path'); process.chdir(path.join(__dirname, '..'));
const { PrismaClient } = require('@prisma/client'); const p = new PrismaClient();
const arch = require('../server/services/agents/architect.js');
const ctx = require('../server/services/testDataContext');
(async () => {
  const PID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
  const t = await ctx.loadTestDataContext(PID);
  const m = t && t.mapping || {};
  console.log('mapping.strategy:', m.strategy);
  console.log('bindings count:', (m.bindings || []).length, '| unmapped:', (m.unmapped || []).length);
  for (const b of (m.bindings || [])) {
    console.log(`  - sheet="${b.sheet}" scenarioName="${b.scenarioName || ''}" module="${b.module || ''}" columnToField=${JSON.stringify(b.columnToField || {})} expectedColumn="${b.expectedColumn || ''}" purpose="${(b.purpose||'').slice(0,50)}"`);
  }
  // Does buildTestDataBlock produce a block (i.e., does the architect actually receive the data)?
  const block = arch.buildTestDataBlock(t);
  console.log('\nbuildTestDataBlock →', block ? `INJECTED (${block.length} chars)` : 'NULL — architect receives NO test data block!');
  if (block) console.log('--- first 600 chars ---\n' + block.slice(0, 600));
  await p.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
