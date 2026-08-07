const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
async function go() {
  const rr = await p.runResult.findFirst({
    where: { runId: '2fda1038-bece-43f2-add9-0a7b0817dda3', testCaseId: 'f385a169-0416-4f7c-8655-68217404587a' },
    select: { replayIrJson: true }
  });
  const ir = JSON.parse(rr.replayIrJson || '{}');
  console.log('IR keys:', Object.keys(ir));
  // Look for all assertions in the IR
  const steps = ir.steps || ir.cases || ir.testCases || [];
  console.log('steps count:', steps.length);
  if (steps.length) {
    steps.forEach((s,si) => {
      const asns = s.assertions || [];
      asns.forEach(a => {
        console.log(`  step[${si}] ASN=${a.id} type=${a.type} primitive=${a.primitive} text="${a.text?.slice?.(0,60)}" evaluateCode="${a.evaluateCode?.slice?.(0,80)}"`);
      });
    });
  } else {
    // Look at the top-level keys more carefully
    console.log('IR structure sample:', JSON.stringify(ir).slice(0, 500));
  }
  await p.$disconnect();
}
go().catch(e => { console.error(e.message); p.$disconnect(); });
