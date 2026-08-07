const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient();
(async () => {
  // Reset any TestCase still stuck in 'running' status back to 'approved'
  const result = await prisma.testCase.updateMany({
    where: { status: 'running' },
    data: { status: 'approved' },
  });
  console.log('Reset', result.count, 'stuck TestCase(s) back to approved');
  await prisma.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
