const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
async function go() {
  const tc = await p.testCase.findFirst({
    where: { id: { startsWith: 'ea49563b' } },
    select: { name: true, authProfile: true, operationsJson: true }
  });
  console.log('TC name:', tc.name);
  console.log('authProfile:', tc.authProfile);
  const ops = JSON.parse(tc.operationsJson || '[]');
  console.log('operations count:', ops.length);
  ops.slice(0,3).forEach((o,i) => console.log(`  [${i}] ${JSON.stringify(o).slice(0,100)}`));
  await p.$disconnect();
}
go().catch(e => { console.error(e.message); p.$disconnect(); });
