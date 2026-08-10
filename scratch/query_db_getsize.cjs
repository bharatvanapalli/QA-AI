const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const results = await prisma.runResult.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5
  });
  for (const r of results) {
    const steps = JSON.parse(r.stepsJson || '[]');
    const getsize = steps.find(s => s.action === 'GetSize' || s.action === 'Semantic');
    if (getsize) {
      console.log('Found GetSize/Semantic in run result:', r.id);
      console.log(JSON.stringify(getsize, null, 2));
      return;
    }
  }
  console.log('No GetSize found in last 5 runs');
}
main().finally(() => prisma.$disconnect());
