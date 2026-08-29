const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function seed() {
  console.log('--- Seeding New_Odyssey project and test suite ---');
  const seedFilePath = path.join(__dirname, 'new_odyssey_seed.json');
  if (!fs.existsSync(seedFilePath)) {
    console.error('Seed file not found at:', seedFilePath);
    process.exit(1);
  }

  const seedData = JSON.parse(fs.readFileSync(seedFilePath, 'utf8'));

  // 1. Ensure a default demo user exists
  const email = 'qa@odysseylogistics.com';
  let user = await prisma.user.findFirst({
    where: { email }
  });
  if (!user) {
    const passwordHash = await bcrypt.hash('Password123!', 10);
    user = await prisma.user.create({
      data: {
        email,
        firstName: 'QA',
        lastName: 'Lead',
        passwordHash
      }
    });
    console.log('Created default user:', user.email);
  }

  // 2. Ensure an organization exists
  let org = await prisma.organization.findFirst({
    where: { ownerId: user.id }
  });
  if (!org) {
    org = await prisma.organization.create({
      data: {
        name: 'Default Org',
        slug: 'default-org',
        ownerId: user.id
      }
    });
    console.log('Created default organization:', org.id);
  }

  // Ensure membership and currentOrgId
  const membership = await prisma.orgMembership.findFirst({
    where: { userId: user.id, orgId: org.id }
  });
  if (!membership) {
    await prisma.orgMembership.create({
      data: {
        userId: user.id,
        orgId: org.id,
        role: 'owner'
      }
    });
  }
  if (user.currentOrgId !== org.id) {
    await prisma.user.update({
      where: { id: user.id },
      data: { currentOrgId: org.id }
    });
  }

  // 3. Upsert Project New_Odyssey
  let project = await prisma.project.findFirst({
    where: {
      name: seedData.project.name,
      orgId: org.id
    }
  });

  if (!project) {
    project = await prisma.project.create({
      data: {
        name: seedData.project.name,
        targetUrl: seedData.project.targetUrl || 'https://qa.linx.odysseylogistics.com',
        orgId: org.id,
        userId: user.id,
        contextViewport: seedData.project.contextViewport,
        contextLocale: seedData.project.contextLocale,
        autoAcceptDialogs: seedData.project.autoAcceptDialogs !== undefined ? seedData.project.autoAcceptDialogs : true
      }
    });
    console.log('Created project:', project.name, 'with ID:', project.id);
  } else {
    console.log('Project already exists:', project.name, 'with ID:', project.id);
  }

  // 4. Upsert Test Cases
  for (const tc of seedData.project.testCases) {
    const existing = await prisma.testCase.findFirst({
      where: {
        projectId: project.id,
        name: tc.name
      }
    });

    const stepStr = typeof tc.steps === 'string' ? tc.steps : JSON.stringify(tc.steps);
    const parsedSteps = typeof tc.steps === 'string' ? JSON.parse(tc.steps) : tc.steps;

    if (!existing) {
      await prisma.testCase.create({
        data: {
          projectId: project.id,
          name: tc.name,
          type: tc.type || 'functional',
          module: tc.module || 'Orders',
          confidence: tc.confidence || 95,
          status: tc.status || 'approved',
          assertions: tc.assertions || '[]',
          steps: stepStr
        }
      });
      console.log(`  + Seeded test case: "${tc.name}" (${parsedSteps ? parsedSteps.length : 0} steps)`);
    } else {
      await prisma.testCase.update({
        where: { id: existing.id },
        data: {
          steps: stepStr,
          status: tc.status || 'approved'
        }
      });
      console.log(`  * Updated test case: "${tc.name}" (${parsedSteps ? parsedSteps.length : 0} steps)`);
    }
  }

  console.log('Seeding completed successfully!');
}

seed().catch(err => {
  console.error('Seed error:', err);
  process.exit(1);
}).finally(() => prisma.$disconnect());
