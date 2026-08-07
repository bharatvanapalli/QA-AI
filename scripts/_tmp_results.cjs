const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient();
prisma.runResult.findMany({
  where: { runId: 'bc723b73-449b-40a5-bff5-8f4171d4034e' },
  select: { id: true, testCaseId: true, status: true, agentClaimedVerdict: true, verdictMode: true },
  orderBy: { id: 'asc' }
}).then(rs => { console.log(JSON.stringify(rs, null, 2)); return prisma.$disconnect(); })
  .catch(e => { console.error(e.message); return prisma.$disconnect(); });
