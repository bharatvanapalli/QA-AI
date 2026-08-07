const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient();
prisma.run.findMany({
  where: { projectId: { in: ['9675bfde-acb2-4eda-aaed-b6694b88f920', '465f2d08-c8b5-469a-af41-9c0ba2a2ce93'] } },
  select: { id: true, projectId: true, status: true, startedAt: true },
  orderBy: { startedAt: 'desc' },
  take: 8
}).then(rs => { console.log(JSON.stringify(rs, null, 2)); return prisma.$disconnect(); })
  .catch(e => { console.error(e.message); return prisma.$disconnect(); });
