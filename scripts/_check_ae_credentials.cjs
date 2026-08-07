'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { PrismaClient } = require(path.join(__dirname, '..', 'server', 'node_modules', '@prisma', 'client'));
const prisma = new PrismaClient();

const PROJECT_ID = '4cc6772c-ea93-4c26-b478-48d779d1fccb';
const USER_ID = 'a5d916cd-4178-4bcc-b409-c885a389e843';
const ORG_ID = 'org-a5d916cd-4178-4bcc-b409-c885a389e843';

(async () => {
  const proj = await prisma.project.findUnique({
    where: { id: PROJECT_ID },
    select: { framework: true, aiProvider: true, execMode: true, testCredentials: true, verdictMode: true }
  });
  console.log('Project settings:', JSON.stringify(proj, null, 2));

  // Integrations - use all fields
  const integrations = await prisma.integration.findMany({
    where: { userId: USER_ID },
    select: { id: true, type: true, status: true, config: true }
  });
  console.log('\nIntegrations:', JSON.stringify(integrations.map(i => ({ type: i.type, status: i.status })), null, 2));

  // Test cases count
  const gen = await prisma.scenarioGeneration.findFirst({
    where: { projectId: PROJECT_ID, isCurrent: true },
    select: { id: true, label: true, caseCount: true }
  });
  console.log('\nCurrent gen:', JSON.stringify(gen));

  const approvedCount = await prisma.testCase.count({
    where: { scenario: { projectId: PROJECT_ID, generationId: gen.id }, status: 'approved' }
  });
  const totalCount = await prisma.testCase.count({
    where: { scenario: { projectId: PROJECT_ID, generationId: gen.id } }
  });
  const allStatus = await prisma.testCase.groupBy({
    by: ['status'],
    where: { scenario: { projectId: PROJECT_ID, generationId: gen.id } },
    _count: { status: true }
  });
  console.log(`Approved: ${approvedCount}/${totalCount}`);
  console.log('By status:', JSON.stringify(allStatus));

  await prisma.$disconnect();
})().catch(async e => { console.error(e.message); await prisma.$disconnect(); process.exit(1); });
