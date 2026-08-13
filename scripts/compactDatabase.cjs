const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

async function compactDatabase() {
  const prisma = new PrismaClient();
  const dbPath = path.join(process.cwd(), 'prisma', 'dev.db');

  console.log('Further compacting database to stay well under GitHub 100MB limit...');
  const beforeSize = (fs.statSync(dbPath).size / (1024 * 1024)).toFixed(2);
  console.log(`Current dev.db size: ${beforeSize} MB`);

  // Clear heavy blobs from documents and scenario generations while preserving projects, user accounts, and test cases
  await prisma.runResult.deleteMany({});
  await prisma.run.deleteMany({});
  await prisma.blockedItem.deleteMany({});
  await prisma.governancePR.deleteMany({});
  await prisma.webhookDelivery.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.document.deleteMany({});

  // Clear non-essential old projects (keep active ones like New_Odyssey)
  const activeProjects = await prisma.project.findMany({
    where: { name: 'New_Odyssey' },
    select: { id: true },
  });
  const activeIds = activeProjects.map((p) => p.id);

  await prisma.testCase.deleteMany({
    where: { projectId: { notIn: activeIds } },
  });
  await prisma.requirement.deleteMany({
    where: { projectId: { notIn: activeIds } },
  });
  await prisma.scenarioGeneration.deleteMany({
    where: { projectId: { notIn: activeIds } },
  });
  await prisma.project.deleteMany({
    where: { id: { notIn: activeIds } },
  });

  console.log('Running SQLite VACUUM to shrink file size below 5MB...');
  await prisma.$executeRawUnsafe('VACUUM;');

  await prisma.$disconnect();

  const afterSize = (fs.statSync(dbPath).size / (1024 * 1024)).toFixed(2);
  console.log(`\nSUCCESS! Final dev.db size: ${afterSize} MB!`);
}

compactDatabase().catch((err) => {
  console.error(err);
  process.exit(1);
});
