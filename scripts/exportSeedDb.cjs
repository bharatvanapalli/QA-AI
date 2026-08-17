const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');

async function exportSeedDb() {
  const seedPath = path.join(process.cwd(), 'prisma', 'clean_seed.db');
  if (fs.existsSync(seedPath)) {
    fs.unlinkSync(seedPath);
  }

  // 1. Create a fresh DB schema file
  process.env.DATABASE_URL = `file:${seedPath}`;
  execSync('npx prisma db push --skip-generate', { stdio: 'inherit' });

  const mainPrisma = new PrismaClient();
  const seedPrisma = new PrismaClient({
    datasources: { db: { url: `file:${seedPath}` } },
  });

  console.log('Copying user, org, project New_Odyssey, requirements, and test cases...');

  // Copy User & Org
  const users = await mainPrisma.user.findMany();
  for (const u of users) {
    await seedPrisma.user.create({ data: u });
  }

  const orgs = await mainPrisma.org.findMany();
  for (const o of orgs) {
    await seedPrisma.org.create({ data: o });
  }

  const orgMembers = await mainPrisma.orgMember.findMany();
  for (const om of orgMembers) {
    await seedPrisma.orgMember.create({ data: om });
  }

  const secrets = await mainPrisma.secret.findMany();
  for (const s of secrets) {
    await seedPrisma.secret.create({ data: s });
  }

  const integrations = await mainPrisma.integration.findMany();
  for (const i of integrations) {
    await seedPrisma.integration.create({ data: i });
  }

  // Copy Projects
  const projects = await mainPrisma.project.findMany();
  for (const proj of projects) {
    await seedPrisma.project.create({ data: proj });
  }

  // Copy Generations & TestCases for New_Odyssey
  const generations = await mainPrisma.scenarioGeneration.findMany();
  for (const gen of generations) {
    await seedPrisma.scenarioGeneration.create({ data: gen });
  }

  const requirements = await mainPrisma.requirement.findMany();
  for (const req of requirements) {
    await seedPrisma.requirement.create({ data: req });
  }

  const testCases = await mainPrisma.testCase.findMany();
  for (const tc of testCases) {
    await seedPrisma.testCase.create({ data: tc });
  }

  await mainPrisma.$disconnect();
  await seedPrisma.$disconnect();

  const seedSizeMB = (fs.statSync(seedPath).size / (1024 * 1024)).toFixed(2);
  console.log(`\nSUCCESS! Created clean seed database: prisma/clean_seed.db (${seedSizeMB} MB)`);

  // Replace dev.db with clean_seed.db
  const devDbPath = path.join(process.cwd(), 'prisma', 'dev.db');
  fs.copyFileSync(seedPath, devDbPath);
  fs.unlinkSync(seedPath);

  const devSizeMB = (fs.statSync(devDbPath).size / (1024 * 1024)).toFixed(2);
  console.log(`Overwrote prisma/dev.db with lightweight seed database (${devSizeMB} MB)`);
}

exportSeedDb().catch((err) => {
  console.error(err);
  process.exit(1);
});
