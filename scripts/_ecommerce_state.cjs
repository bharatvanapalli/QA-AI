'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const { PrismaClient } = require(path.join(__dirname, '..', 'server', 'node_modules', '@prisma', 'client'));
const prisma = new PrismaClient();

const PROJECT_ID = '4cc6772c-ea93-4c26-b478-48d779d1fccb';
const USER_ID = 'a5d916cd-4178-4bcc-b409-c885a389e843';
const USER_EMAIL = 'bharatvanapalli8@gmail.com';

(async () => {
  const token = jwt.sign({ sub: USER_ID, email: USER_EMAIL, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '2h' });
  console.log('TOKEN=' + token);

  const scenarioCount = await prisma.testScenario.count({ where: { projectId: PROJECT_ID } });
  const testCaseCount = await prisma.testCase.count({ where: { scenario: { projectId: PROJECT_ID } } });
  console.log('\ntestScenarios:', scenarioCount, '| testCases:', testCaseCount);

  const latestGen = await prisma.scenarioGeneration.findFirst({
    where: { projectId: PROJECT_ID },
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true, label: true, isCurrent: true, scenarioCount: true, caseCount: true }
  });
  console.log('\nlatestGeneration:', JSON.stringify(latestGen));

  const latestRun = await prisma.run.findFirst({
    where: { projectId: PROJECT_ID },
    orderBy: { startedAt: 'desc' },
    select: { id: true, status: true, startedAt: true }
  });
  console.log('latestRun:', JSON.stringify(latestRun));

  if (latestRun) {
    const results = await prisma.runResult.groupBy({
      by: ['status'],
      where: { runId: latestRun.id },
      _count: { status: true }
    });
    console.log('lastRun results by status:', JSON.stringify(results));

    const specsWithCode = await prisma.runResult.count({
      where: { runId: latestRun.id, specCode: { not: null } }
    });
    console.log('resultsWithSpecCode:', specsWithCode);
  }

  const proj = await prisma.project.findUnique({
    where: { id: PROJECT_ID },
    select: { framework: true, aiProvider: true, execMode: true, testCredentials: true }
  });
  console.log('\nprojectSettings:', JSON.stringify(proj));

  await prisma.$disconnect();
})().catch(async e => { console.error(e.message); await prisma.$disconnect(); process.exit(1); });
