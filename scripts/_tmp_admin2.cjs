const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
async function go() {
  const rr = await p.runResult.findFirst({
    where: { runId: '2fda1038-bece-43f2-add9-0a7b0817dda3', testCaseId: 'ea49563b-a0f7-45e8-9a08-3bcd6e073c4e' },
    select: { replayIrJson: true }
  });
  const outer = JSON.parse(rr.replayIrJson || '{}');
  const ir = outer.ir || outer;
  const steps = ir.steps || [];
  console.log('Steps for Admin dashboard case:');
  steps.forEach((s, i) => {
    if (s.op === 'act') console.log(`  [${i}] act action=${s.action} url=${s.url?.slice(-40)}`);
    else if (s.op === 'resolve') console.log(`  [${i}] resolve label=${s.label} cand0=${JSON.stringify(s.candidates?.[0])?.slice(0,80)}`);
    else if (s.op === 'assert') console.log(`  [${i}] assert channel=${s.channel} expected=${s.expected?.slice?.(0,40)}`);
    else console.log(`  [${i}] ${s.op}`);
  });
  await p.$disconnect();
}
go().catch(e => { console.error(e.message); p.$disconnect(); });
