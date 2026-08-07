const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const latestRun = await prisma.run.findFirst({
    where: { project: { name: { contains: 'letcode' } } },
    orderBy: { startedAt: 'desc' },
    include: {
      results: {
        include: { testCase: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!latestRun) {
    console.log('No run found!');
    return;
  }

  console.log(`=== LIVE RUN REPORT: ${latestRun.id} ===`);
  console.log(`Status: ${latestRun.status} | Passed: ${latestRun.passed} | Failed: ${latestRun.failed} | Total Executed: ${latestRun.results.length}/20`);
  console.log('\n--- CASE BY CASE VERDICTS ---');

  latestRun.results.forEach((r, idx) => {
    console.log(`\nCase ${idx + 1}: "${r.testCase?.name}"`);
    console.log(`  Verdict/Status: ${r.status.toUpperCase()}`);
    if (r.error) {
      console.log(`  Reason/Details: ${r.error}`);
    }
  });
}

main().finally(() => prisma.$disconnect());
