const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
async function go() {
  // Look at the cc13d9c4 test case and its run results
  const results = await p.runResult.findMany({
    where: { runId: '2fda1038-bece-43f2-add9-0a7b0817dda3', testCaseId: { startsWith: 'cc13d9c4' } },
    select: { id: true, status: true, dataRowIndex: true, dataRowLabel: true, dataSetName: true, exportMeta: true }
  });
  console.log('cc13d9c4 results:', JSON.stringify(results, null, 2));
  
  // Also check assertionCheckResults for the XSS case
  const xss = await p.runResult.findMany({
    where: { runId: '2fda1038-bece-43f2-add9-0a7b0817dda3' },
    select: { id: true, status: true, testCaseId: true }
  });
  const xssCase = xss.find(r => r.testCaseId === 'bfcb1edc' || r.testCaseId === '2e96cee0' || r.testCaseId === '6edf9a3d');
  if (!xssCase) console.log('XSS case not found by guess, check all IDs:', xss.map(r=>r.testCaseId.slice(0,8)).join(', '));
  
  await p.$disconnect();
}
go().catch(e => { console.error(e.message); p.$disconnect(); });
