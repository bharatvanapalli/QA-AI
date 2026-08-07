const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
async function go() {
  // Find test cases for admin-successful-login scenario
  const cases = await p.testCase.findMany({
    where: { name: { contains: 'Admin' } },
    select: { id: true, name: true }
  });
  // Find the two admin login cases in this run
  const runResults = await p.runResult.findMany({
    where: { runId: '2fda1038-bece-43f2-add9-0a7b0817dda3' },
    select: { id: true, status: true, testCaseId: true }
  });
  // Find cases with "Admin dashboard" or "Admin login" in name
  const adminCases = cases.filter(c => c.name.toLowerCase().includes('admin'));
  console.log('Admin test cases:');
  adminCases.forEach(c => {
    const rr = runResults.find(r => r.testCaseId === c.id);
    if (rr) console.log(`  ${c.id.slice(0,8)} | ${c.name} | status=${rr?.status}`);
  });
  
  // Now get the second admin case's replayIrJson to see step 2
  // Looking for "Admin dashboard" case
  const dashboardCase = cases.find(c => c.name.toLowerCase().includes('dashboard'));
  if (dashboardCase) {
    const rr = runResults.find(r => r.testCaseId === dashboardCase.id);
    if (rr) {
      const full = await p.runResult.findFirst({ where: { id: rr.id }, select: { replayIrJson: true } });
      const outer = JSON.parse(full.replayIrJson || '{}');
      const ir = outer.ir || outer;
      const steps = ir.steps || [];
      steps.forEach((s, i) => {
        if (s.op === 'resolve') console.log(`step[${i}] resolve label=${s.label} candidates=${JSON.stringify(s.candidates?.[0])?.slice(0,100)}`);
      });
    }
  }
  await p.$disconnect();
}
go().catch(e => { console.error(e.message); p.$disconnect(); });
