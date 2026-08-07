const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
async function go() {
  // find by partial id
  const rr = await p.runResult.findFirst({
    where: { runId: '2fda1038-bece-43f2-add9-0a7b0817dda3', testCaseId: { startsWith: 'ea49563b' } },
    select: { id: true, status: true, replayIrJson: true }
  });
  if (!rr) { console.log('not found'); return; }
  console.log('Found rrId='+rr.id.slice(0,8)+' status='+rr.status);
  const outer = JSON.parse(rr.replayIrJson || '{}');
  const ir = outer.ir || outer;
  const steps = ir.steps || [];
  console.log('Steps count:', steps.length);
  steps.forEach((s, i) => {
    if (s.op === 'act') console.log(`  [${i}] act action=${s.action} url=${s.url?.slice(-50) || ''}`);
    else if (s.op === 'resolve') console.log(`  [${i}] resolve label=${s.label}`);
    else if (s.op === 'assert') console.log(`  [${i}] assert channel=${s.channel} expected="${s.expected?.slice?.(0,50) || ''}"`);
    else console.log(`  [${i}] ${s.op}`);
  });
  await p.$disconnect();
}
go().catch(e => { console.error(e.message); p.$disconnect(); });
