const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const run = await p.run.findFirst({ orderBy: { startedAt: 'desc' } });
  const result = await p.runResult.findFirst({ where: { runId: run.id } });
  const shots = JSON.parse(result.screenshots || '[]');
  console.log('Screenshots keys:', shots.map(s => Object.keys(s)));
  console.log('Screenshots full:', JSON.stringify(shots, null, 2));
  await p.$disconnect();
})();
