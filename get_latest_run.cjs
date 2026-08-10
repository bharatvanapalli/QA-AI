const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const run = await prisma.run.findFirst({
    orderBy: { startedAt: 'desc' },
    include: {
      results: {
        include: { testCase: true }
      }
    }
  });
  console.log(JSON.stringify(run, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
