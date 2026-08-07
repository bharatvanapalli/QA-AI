require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
async function main() {
  // Find conductor AgentRun failures
  const conductorFails = await db.agentRun.findMany({
    where: { phase: { startsWith: 'conductor' }, status: 'failed' },
    orderBy: { completedAt: 'desc' },
    take: 5
  });
  console.log('=== Recent conductor AgentRun failures ===');
  console.log(JSON.stringify(conductorFails.map(r => ({
    id: r.id,
    phase: r.phase,
    status: r.status,
    error: r.error ? r.error.slice(0, 500) : null,
    completedAt: r.completedAt
  })), null, 2));

  // Also get the most recent 3 runs with full conductor result
  const recentRuns = await db.run.findMany({
    orderBy: { startedAt: 'desc' },
    take: 5,
    select: { id: true, status: true, startedAt: true, passed: true, failed: true, blocked: true, skipped: true }
  });
  console.log('\n=== 5 most recent runs ===');
  console.log(JSON.stringify(recentRuns, null, 2));

  await db.$disconnect();
}
main().catch(e => { console.error(e.message); process.exit(1); });
