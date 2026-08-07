const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
async function go() {
  const xssIds = ['f385a169-0416-4f7c-8655-68217404587a', '57019e00-add1-446b-997e-3570b91c454c'];
  const rr = await p.runResult.findMany({
    where: { runId: '2fda1038-bece-43f2-add9-0a7b0817dda3', testCaseId: { in: xssIds } },
    select: { id: true, status: true, testCaseId: true, assertionCheckResults: true }
  });
  rr.forEach(r => {
    console.log(`\n--- tcId=${r.testCaseId.slice(0,8)} status=${r.status} rrId=${r.id.slice(0,8)} ---`);
    try {
      const acr = JSON.parse(r.assertionCheckResults || '[]');
      acr.forEach(a => console.log(`  contractRef=${a.contractRef}: outcome=${a.outcome} text="${a.text?.slice(0,60)}" domGrounded=${a.domGrounded} priority=${a.priority}`));
    } catch(e) { console.log('  parse error:', e.message); }
  });
  await p.$disconnect();
}
go().catch(e => { console.error(e.message); p.$disconnect(); });
