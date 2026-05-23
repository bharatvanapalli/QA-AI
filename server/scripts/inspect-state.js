'use strict';

/**
 * One-off DB inspector — answers "what's actually in this database right now"
 * so we can see whether a 'delete' really deleted the rows or just hid them.
 */

const prisma = require('../prisma');

async function main() {
  const [projects, tcCount, prCount, runCount, resultCount] = await Promise.all([
    prisma.project.findMany({
      select: {
        id: true, name: true, environment: true, aiProvider: true, createdAt: true, updatedAt: true,
        _count: { select: { testCases: true, runs: true, prs: true, requirements: true, documents: true } },
      },
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.testCase.count(),
    prisma.governancePR.count(),
    prisma.run.count(),
    prisma.runResult.count(),
  ]);

  console.log(`Projects in DB: ${projects.length}`);
  for (const p of projects) {
    console.log(`  - ${p.name}  id=${p.id}  provider=${p.aiProvider}  TCs=${p._count.testCases}  Runs=${p._count.runs}  PRs=${p._count.prs}  Reqs=${p._count.requirements}  Docs=${p._count.documents}`);
  }
  console.log('');
  console.log(`Global totals: testCases=${tcCount}, governancePRs=${prCount}, runs=${runCount}, runResults=${resultCount}`);

  // Are there orphan PRs (testCaseId NULL but projectId pointing at a deleted project)?
  const orphanPRs = await prisma.governancePR.findMany({
    where: { testCaseId: null },
    select: { id: true, filename: true, projectId: true, status: true, createdAt: true },
    take: 10,
  });
  if (orphanPRs.length) {
    console.log(`\nPRs with NULL testCaseId (regen leftover): ${orphanPRs.length}`);
    for (const p of orphanPRs) console.log(`  - ${p.filename}  status=${p.status}  projectId=${p.projectId}`);
  }

  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
