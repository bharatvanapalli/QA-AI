'use strict';
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const runs = await p.run.findMany({
    orderBy: { startedAt: 'desc' },
    take: 3,
    include: {
      results: {
        include: {
          testCase: { select: { name: true } },
        },
      },
      project: { select: { name: true } },
    },
  });

  for (const r of runs) {
    console.log(`\n======================================================`);
    console.log(`Run ID: ${r.id} | Project: ${r.project?.name} | Status: ${r.status}`);
    console.log(`Started: ${r.startedAt?.toISOString()} | Completed: ${r.completedAt?.toISOString()}`);
    console.log(`Counters → passed: ${r.passed} | failed: ${r.failed} | blocked: ${r.blocked} | skipped: ${r.skipped}`);
    console.log(`RunResults (${r.results.length}):`);
    for (const res of r.results) {
      console.log(`  - TestCase: [${res.testCase?.order}] ${res.testCase?.title}`);
      console.log(`    Result Status: ${res.status} | Duration: ${res.durationMs}ms`);
      if (res.error) console.log(`    Error: ${res.error}`);
      try {
        const screens = JSON.parse(res.screenshots || '[]');
        console.log(`    Screenshots count: ${screens.length}`);
        if (screens.length > 0) {
          console.log(`    First screenshot: ${screens[0]}`);
          console.log(`    Last screenshot: ${screens[screens.length - 1]}`);
        }
      } catch (e) {
        console.log(`    Screenshots raw: ${res.screenshots}`);
      }
      try {
        const steps = JSON.parse(res.stepResults || '[]');
        console.log(`    stepResults count: ${steps.length}`);
        steps.forEach((s, idx) => {
          console.log(`      [Step ${s.index ?? idx + 1}] ${s.status} - ${(s.error || s.reason || s.action || '').slice(0, 80)}`);
        });
      } catch (e) {
        console.log(`    stepResults raw: ${res.stepResults?.slice(0, 100)}`);
      }
    }
  }
}

main().catch(console.error).finally(() => p.$disconnect());
