'use strict';
const path = require('path'); const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { PrismaClient } = require(path.join(ROOT, 'server', 'node_modules', '@prisma', 'client'));
const p = new PrismaClient();
const PID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

(async () => {
  const run = await p.run.findFirst({ where: { projectId: PID }, orderBy: { startedAt: 'desc' }, select: { id: true } });
  const rr = await p.runResult.findFirst({ where: { runId: run.id, testCase: { name: { contains: 'valid credentials' } } }, select: { replayIrJson: true } });
  const outer = parse(rr?.replayIrJson);
  const ir = outer?.ir || outer;
  const acts = Array.isArray(ir?.actions) ? ir.actions : (Array.isArray(ir?.steps) ? ir.steps : []);
  console.log('outer keys:', Object.keys(outer || {}));
  console.log('ir keys:', Object.keys(ir || {}));
  console.log(`\n=== RAW action objects (fill/click only) ===`);
  acts.filter((a) => /fill|click|type/i.test(a.tool || a.action || a.type || '')).slice(0, 3).forEach((a, i) => {
    console.log(`\n----- action ${i} (keys: ${Object.keys(a).join(', ')}) -----`);
    console.log(JSON.stringify(a, null, 2).slice(0, 1500));
  });
  await p.$disconnect();
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
