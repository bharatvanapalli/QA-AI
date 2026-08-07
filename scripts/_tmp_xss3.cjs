const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
async function go() {
  // Find XSS test cases - SQLite doesn't support mode:insensitive
  const cases = await p.testCase.findMany({
    where: { name: { contains: 'XSS' } },
    select: { id: true, name: true, declaredAssertions: true }
  });
  console.log('XSS cases count:', cases.length);
  cases.forEach(c => console.log('  '+c.id+' | '+c.name.slice(0,80)));
  
  // Also check assertion polarity from the IR via replayIrJson on a run result
  // Find a run result that has XSS in the test name
  const allResults = await p.runResult.findMany({
    where: { runId: '2fda1038-bece-43f2-add9-0a7b0817dda3' },
    select: { id: true, testCaseId: true, assertionCheckResults: true }
  });
  // Identify XSS case by its assertionCheckResults
  for (const r of allResults) {
    try {
      const acr = JSON.parse(r.assertionCheckResults || '[]');
      const hasXss = acr.some(a => a.text && (a.text.toLowerCase().includes('xss') || a.text.toLowerCase().includes('alert')));
      if (hasXss) {
        console.log(`\n--- XSS result tcId=${r.testCaseId.slice(0,8)} rrId=${r.id.slice(0,8)} ---`);
        acr.forEach(a => console.log(`  contractRef=${a.contractRef}: outcome=${a.outcome} text="${a.text?.slice(0,50)}" domGrounded=${a.domGrounded}`));
      }
    } catch(e) {}
  }
  await p.$disconnect();
}
go().catch(e => { console.error(e.message); p.$disconnect(); });
