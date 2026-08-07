const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
async function go() {
  const rr = await p.runResult.findFirst({
    where: { runId: '2fda1038-bece-43f2-add9-0a7b0817dda3', testCaseId: 'f385a169-0416-4f7c-8655-68217404587a' },
    select: { assertionCheckResults: true, replayIrJson: true }
  });
  const acr = JSON.parse(rr.assertionCheckResults || '[]');
  console.log('ACR first item keys:', Object.keys(acr[0] || {}));
  console.log('ACR[0]:', JSON.stringify(acr[0], null, 2));
  // Also get the replayIrJson structure for assertions
  const ir = rr.replayIrJson ? JSON.parse(rr.replayIrJson) : null;
  if (ir) {
    const steps = ir.steps || [];
    const assertions = steps.flatMap(s => (s.assertions||[]).map(a => ({
      id: a.id, text: a.text, outcome: a.outcome, type: a.type
    })));
    console.log('\nIR assertions:', JSON.stringify(assertions, null, 2));
  }
  await p.$disconnect();
}
go().catch(e => { console.error(e.message); p.$disconnect(); });
