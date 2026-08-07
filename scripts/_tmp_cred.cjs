const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
async function go() {
  const rr = await p.runResult.findFirst({
    where: { id: 'c2f3f57d-7453-4153-91e7-d5791d1cf56b' }, // row 1 admin
    select: { replayIrJson: true, status: true, dataRowLabel: true }
  });
  console.log('Row 1 admin status='+rr.status+' label='+rr.dataRowLabel);
  const outer = JSON.parse(rr.replayIrJson || '{}');
  const ir = outer.ir || outer;
  const steps = ir.steps || [];
  steps.forEach((s, i) => {
    if (s.op === 'act') console.log(`  [${i}] act action=${s.action} url=${s.url?.slice(-50)||''} target=${s.target||''}`);
    else if (s.op === 'resolve') console.log(`  [${i}] resolve label=${s.label}`);
    else if (s.op === 'assert') console.log(`  [${i}] assert channel=${s.channel} expected="${s.expected?.slice?.(0,50)||''}"`);
    else console.log(`  [${i}] ${s.op}`);
  });
  await p.$disconnect();
}
go().catch(e => { console.error(e.message); p.$disconnect(); });
