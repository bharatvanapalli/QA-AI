import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
try {
  const integrations = await p.integration.findMany({
    select: { type: true, status: true, lastValidatedAt: true, lastError: true }
  });
  console.log('=== Integrations ===');
  console.log(JSON.stringify(integrations, null, 2));

  const usage = await p.userDailyUsage.findMany({
    select: { userId: true, date: true, provider: true, inputTokens: true, outputTokens: true, callCount: true, blockedCount: true },
    orderBy: { date: 'desc' },
    take: 10,
  });
  console.log('\n=== Daily Usage (last 10 rows) ===');
  console.log(JSON.stringify(usage, null, 2));
} finally {
  await p.$disconnect();
}
