'use strict';
const prisma = require('../server/prisma');

(async () => {
  try {
    const project = await prisma.project.findFirst({
      where: { name: { contains: 'letcode' } },
      include: {
        runs: {
          orderBy: { startedAt: 'desc' },
          take: 1,
          include: {
            results: {
              include: { testCase: true },
            },
          },
        },
      },
    });

    const latestRun = project?.runs[0];
    if (!latestRun) {
      console.log('No runs found.');
      process.exit(0);
    }

    console.log(`=== LATEST RUN DETAILS (${latestRun.id}) ===`);
    console.log(`Status: ${latestRun.status}, Passed: ${latestRun.passed}, Failed: ${latestRun.failed}, Blocked: ${latestRun.blocked}`);

    const results = latestRun.results || [];
    console.log(`Total results in run: ${results.length}`);

    results.forEach((r, idx) => {
      console.log(`\n[Result ${idx + 1}] Case: "${r.testCase?.name}"`);
      console.log(`  Status: ${r.status}`);
      console.log(`  BlockedReason: ${r.blockedReason}`);
      console.log(`  Error: ${r.error}`);
    });

    await prisma.$disconnect();
  } catch (err) {
    console.error('Error:', err);
  }
})();
