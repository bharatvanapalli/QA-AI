'use strict';
const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
(async () => {
  const runs = await p.run.findMany({
    where: { status: { in: ['running', 'pending'] } },
    orderBy: { startedAt: 'desc' },
    take: 5,
    include: { project: { select: { name: true } } }
  });
  console.log('STUCK RUNS:', JSON.stringify(runs.map(r => ({
    id: r.id, status: r.status,
    project: r.project && r.project.name,
    createdAt: r.createdAt, updatedAt: r.updatedAt
  })), null, 2));

  // Also check the most recent run regardless of status
  const recent = await p.run.findFirst({
    orderBy: { startedAt: 'desc' },
    include: { project: { select: { name: true } } }
  });
  if (recent) {
    console.log('MOST RECENT RUN:', JSON.stringify({
      id: recent.id, status: recent.status,
      project: recent.project && recent.project.name,
      createdAt: recent.createdAt, updatedAt: recent.updatedAt,
      error: recent.error
    }, null, 2));
  }
  await p.$disconnect();
})().catch(async e => { console.error(e.message); await p.$disconnect(); });
