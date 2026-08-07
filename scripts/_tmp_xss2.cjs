const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
async function go() {
  // Find XSS test cases by name
  const cases = await p.testCase.findMany({
    where: { name: { contains: 'XSS', mode: 'insensitive' } },
    select: { id: true, name: true, declaredAssertions: true }
  });
  console.log('XSS cases:', cases.map(c=>c.id+' | '+c.name.slice(0,60)));
  
  if (cases.length) {
    // Get assertionCheckResults
    const xssIds = cases.map(c => c.id);
    const rr = await p.runResult.findMany({
      where: { runId: '2fda1038-bece-43f2-add9-0a7b0817dda3', testCaseId: { in: xssIds } },
      select: { id: true, status: true, testCaseId: true, assertionCheckResults: true }
    });
    rr.forEach(r => {
      console.log(`\n--- tcId=${r.testCaseId.slice(0,8)} status=${r.status} rrId=${r.id.slice(0,8)} ---`);
      try {
        const acr = JSON.parse(r.assertionCheckResults || '[]');
        acr.forEach(a => console.log(`  ASN=${a.contractRef||a.id}: outcome=${a.outcome} text="${a.text?.slice(0,40)}" source=${a.source||'n/a'}`));
      } catch(e) { console.log('  (parse error:', e.message, ')'); }
    });
  }
  await p.$disconnect();
}
go().catch(e => { console.error(e.message); p.$disconnect(); });
