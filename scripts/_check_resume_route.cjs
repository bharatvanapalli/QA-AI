require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
async function main() {
  const runs = await db.run.findMany({
    orderBy: { startedAt: 'desc' }, take: 5,
    select: { id: true, status: true, passed: true, failed: true, skipped: true, projectId: true, startedAt: true },
  });
  console.log('=== Recent runs ===');
  console.log(JSON.stringify(runs, null, 2));

  // Check if resume route is actually registered by loading the router
  const router = require('../server/routes/agents.js');
  const routes = router.stack
    .filter(l => l.route)
    .map(l => l.route.stack[0].method.toUpperCase() + ' ' + l.route.path);
  console.log('\n=== Registered routes ===');
  console.log(routes.join('\n'));

  await db.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
