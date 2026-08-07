const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient();
prisma.run.findMany({
  where: { id: '2fda1038-bece-43f2-add9-0a7b0817dda3' },
  select: { id: true, status: true, passed: true, failed: true, blocked: true, needsHuman: true, startedAt: true, completedAt: true }
}).then(rs => { 
  const r = rs[0];
  const elapsed = r ? Math.round((Date.now() - new Date(r.startedAt)) / 1000) : 0;
  console.log(JSON.stringify({ ...r, elapsed }, null, 2));
  return prisma.$disconnect(); 
}).catch(e => { console.error(e.message); return prisma.$disconnect(); });
