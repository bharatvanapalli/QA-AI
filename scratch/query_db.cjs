const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const result = await prisma.runResult.findFirst({
    where: { testCase: { name: { contains: 'Find Location' } } },
    orderBy: { createdAt: 'desc' },
  });
  if (result) {
    const steps = JSON.parse(result.stepsJson);
    const getsize = steps.find(s => s.action === 'GetSize' || s.action === 'Semantic');
    console.log(JSON.stringify(getsize, null, 2));
  }
}
main().finally(() => prisma.$disconnect());
