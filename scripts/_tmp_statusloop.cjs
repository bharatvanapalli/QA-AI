const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient();
prisma.run.findMany({
  where: { projectId: '465f2d08-c8b5-469a-af41-9c0ba2a2ce93' },
  orderBy: { startedAt: 'desc' },
  take: 1,
  select: { id: true, status: true, passed: true, failed: true, blocked: true, needsHuman: true, startedAt: true }
}).then(rs => { 
  const r = rs[0];
  const elapsed = r ? Math.round((Date.now() - new Date(r.startedAt)) / 1000) : 0;
  console.log(r.id + '|' + r.status + '|' + r.passed + '|' + r.failed + '|' + r.blocked + '|' + elapsed);
  return prisma.$disconnect(); 
}).catch(e => { console.error('ERR:' + e.message); return prisma.$disconnect(); process.exit(1); });
