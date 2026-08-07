const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
async function go() {
  // Find the XSS test cases
  const cases = await p.testCase.findMany({
    where: { title: { contains: 'XSS', mode: 'insensitive' } },
    select: { id: true, title: true }
  });
  console.log('XSS cases:', JSON.stringify(cases, null, 2));
  
  // Get assertionCheckResults for XSS run results
  const xssIds = cases.map(c => c.id);
  const rr = await p.runResult.findMany({
    where: { runId: '2fda1038-bece-43f2-add9-0a7b0817dda3', testCaseId: { in: xssIds } },
    select: { id: true, status: true, testCaseId: true, assertionCheckResults: true }
  });
  rr.forEach(r => {
    console.log(`\n--- tcId=${r.testCaseId.slice(0,8)} status=${r.status} ---`);
    try {
      const acr = JSON.parse(r.assertionCheckResults || '[]');
      acr.forEach(a => console.log(`  ${a.contractRef||a.id}: outcome=${a.outcome} text=${a.text?.slice(0,30)}`));
    } catch(e) { console.log('  (parse error)'); }
  });
  await p.$disconnect();
}
go().catch(e => { console.error(e.message); p.$disconnect(); });
