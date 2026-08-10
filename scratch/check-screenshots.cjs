const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const run = await p.run.findFirst({ orderBy: { startedAt: 'desc' } });
  const result = await p.runResult.findFirst({ where: { runId: run.id } });
  const shots = JSON.parse(result.screenshots || '[]');
  console.log('Screenshots:', shots.map(s => s.path));
  await p.$disconnect();
})();
