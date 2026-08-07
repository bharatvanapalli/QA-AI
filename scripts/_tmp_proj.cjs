const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient();
prisma.project.findUnique({
  where: { id: '465f2d08-c8b5-469a-af41-9c0ba2a2ce93' },
  select: { id: true, name: true, targetUrl: true, framework: true, testCredentials: true, aiProvider: true, execMode: true }
}).then(p => { console.log(JSON.stringify(p, null, 2)); return prisma.$disconnect(); })
  .catch(e => { console.error(e.message); return prisma.$disconnect(); });
