const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  const res = await prisma.runResult.findFirst({ where: { runId: '354c86a7-995d-4133-9364-bd26d138c3cb' } });
  const results = JSON.parse(res.stepResults);
  console.log('Step 3 contextTransition guess:', results.find(r => r.index === 3).contextEvidence?.guess);
  await prisma.$disconnect();
}
run();
