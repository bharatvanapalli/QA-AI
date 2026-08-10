const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const runs = await prisma.runResult.findMany({
    orderBy: { createdAt: 'desc' },
    take: 1,
    include: { actionEvidences: true }
  });
  console.log(JSON.stringify(runs, null, 2));
}
main().finally(() => prisma.$disconnect());
