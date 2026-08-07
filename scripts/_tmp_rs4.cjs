const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
async function go() {
  const run = await p.run.findFirst({
    where: { id: '2fda1038-bece-43f2-add9-0a7b0817dda3' },
    select: { status: true, passed: true, failed: true, blocked: true, needsHuman: true, completedAt: true }
  });
  console.log('run:', JSON.stringify(run));
  const cases = await p.runResult.findMany({
    where: { runId: '2fda1038-bece-43f2-add9-0a7b0817dda3' },
    select: { id: true, status: true, testCaseId: true },
    orderBy: { updatedAt: 'desc' }
  });
  console.log('total runResults:', cases.length);
  const byStatus = {};
  cases.forEach(c => { byStatus[c.status] = (byStatus[c.status]||0)+1; });
  console.log('by status:', JSON.stringify(byStatus));
  cases.filter(c => c.status === 'fail').forEach(c => console.log(`  FAIL: tcId=${c.testCaseId?.slice(0,8)} | id=${c.id?.slice(0,8)}`));
  await p.$disconnect();
}
go().catch(e => { console.error(e.message); p.$disconnect(); });
