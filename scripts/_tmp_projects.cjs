const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient();
prisma.project.findMany({ select: { id: true, name: true, targetUrl: true } })
  .then(ps => { console.log(JSON.stringify(ps, null, 2)); return prisma.$disconnect(); })
  .catch(e => { console.error(e.message); return prisma.$disconnect(); });
