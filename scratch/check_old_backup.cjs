const { PrismaClient } = require('../server/node_modules/@prisma/client');
const path = require('path');
const dbPath = path.resolve(__dirname, '..', 'prisma', 'dev.before-scenario-recovery-20260621-010032.db').split(path.sep).join('/');
const prisma = new PrismaClient({ datasources: { db: { url: 'file:' + dbPath } } });
(async () => {
  const projects = await prisma.project.findMany({ select: { id: true, name: true, createdAt: true } });
  console.log(JSON.stringify(projects, null, 2));
  await prisma.$disconnect();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
