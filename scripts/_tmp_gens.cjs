const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient();
prisma.scenarioGeneration.findMany({
  where: { projectId: '465f2d08-c8b5-469a-af41-9c0ba2a2ce93' },
  select: { id: true, isCurrent: true, caseCount: true, scenarioCount: true, version: true },
  orderBy: { version: 'desc' },
  take: 3
}).then(gs => { console.log(JSON.stringify(gs, null, 2)); return prisma.$disconnect(); })
  .catch(e => { console.error(e.message); return prisma.$disconnect(); });
