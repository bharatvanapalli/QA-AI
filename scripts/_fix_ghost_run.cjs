'use strict';
const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
(async () => {
  // Mark all stuck running/pending runs as cancelled so the UI stops showing them as active
  const result = await p.run.updateMany({
    where: { status: { in: ['running', 'pending'] } },
    data: {
      status: 'cancelled',
      completedAt: new Date(),
    }
  });
  console.log('Fixed ghost runs:', result.count);
  await p.$disconnect();
})().catch(async e => { console.error(e.message); await p.$disconnect(); });
