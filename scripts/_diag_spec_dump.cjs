'use strict';
const path = require('path'); const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { PrismaClient } = require(path.join(ROOT, 'server', 'node_modules', '@prisma', 'client'));
const p = new PrismaClient();
const PID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

(async () => {
  const run = await p.run.findFirst({ where: { projectId: PID }, orderBy: { startedAt: 'desc' }, select: { id: true } });

  // 1. Full specCode of the admin-login PR (the simplest happy path)
  const pr = await p.governancePR.findFirst({ where: { runId: run.id, filename: { contains: 'admin-logs-in' } }, select: { filename: true, specCode: true } });
  console.log('================ FULL specCode:', pr.filename, '================');
  console.log(pr.specCode);
  console.log('================ (', (pr.specCode || '').length, 'bytes ) ================\n');

  // 2. The IR for that same case — true top-level structure + first action shape
  const rr = await p.runResult.findFirst({ where: { runId: run.id, testCase: { name: { contains: 'valid credentials' } } },
    select: { replayIrJson: true, exportMeta: true } });
  const ir = parse(rr?.replayIrJson);
  if (ir) {
    console.log('IR top-level keys:', Object.keys(ir));
    for (const k of Object.keys(ir)) {
      const v = ir[k];
      if (Array.isArray(v)) console.log(`  ir.${k} = Array(${v.length})` + (v.length ? ` first=${JSON.stringify(v[0]).slice(0, 240)}` : ''));
    }
  } else { console.log('IR: null/unparseable'); }

  console.log('\n================ FULL exportMeta ================');
  console.log(JSON.stringify(parse(rr?.exportMeta), null, 2).slice(0, 4000));

  await p.$disconnect();
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
