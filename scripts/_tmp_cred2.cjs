const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
async function go() {
  const tc = await p.testCase.findFirst({
    where: { id: { startsWith: 'cc13d9c4' } },
    select: { name: true, dataBindingJson: true, requiresData: true }
  });
  console.log('name:', tc.name);
  console.log('requiresData:', tc.requiresData?.slice(0,200));
  console.log('dataBindingJson:', tc.dataBindingJson?.slice(0,200));
  
  // Also check if test data exists in DB
  const ds = await p.testDataSet.findMany({
    where: { projectId: '465f2d08-c8b5-469a-af41-9c0ba2a2ce93', name: { contains: 'AuthProfile' } },
    select: { id: true, name: true, rows: true }
  });
  console.log('\nDatasets:', ds.length);
  ds.forEach(d => console.log(`  ${d.name}: ${d.rows?.slice(0,100)}`));
  await p.$disconnect();
}
go().catch(e => { console.error(e.message); p.$disconnect(); });
