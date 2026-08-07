'use strict';
const path = require('path'); const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { PrismaClient } = require(path.join(ROOT, 'server', 'node_modules', '@prisma', 'client'));
const p = new PrismaClient();
const PID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

(async () => {
  const run = await p.run.findFirst({ where: { projectId: PID }, orderBy: { startedAt: 'desc' }, select: { id: true } });
  const rr = await p.runResult.findFirst({ where: { runId: run.id, testCase: { name: { contains: 'valid credentials' } } },
    select: { actionGraphJson: true, replayIrJson: true } });
  const ag = parse(rr?.actionGraphJson);
  console.log('RUN', run.id);
  console.log('\n=== actionGraph nodes (action kind only) ===');
  for (const n of (ag?.nodes || [])) {
    if (n.kind !== 'action') continue;
    const al = n.actionLocator || n.locator || null;
    console.log(`\n[ord ${n.stepOrdinal}] ${n.actionType} "${(n.target||'').slice(0,30)}" method=${n.methodName}`);
    console.log(`   keys: ${Object.keys(n).join(', ')}`);
    console.log(`   actionLocator: ${al ? (al.expression || al.frameworkExpressions?.playwright || JSON.stringify(al).slice(0,80)) : 'NONE'}`);
    console.log(`   locatorRecipe: ${n.locatorRecipe ? JSON.stringify(n.locatorRecipe).slice(0, 260) : 'NONE'}`);
    console.log(`   replayStep: ${n.replayStep ? JSON.stringify(n.replayStep).slice(0, 260) : 'NONE'}`);
    console.log(`   certificationStatus: ${n.certificationStatus}  proofRequired: ${n.proofRequired}`);
  }
  await p.$disconnect();
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
