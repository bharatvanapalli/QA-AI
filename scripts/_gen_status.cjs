'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const PID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
(async () => {
  const gens = await prisma.scenarioGeneration.findMany({ where: { projectId: PID }, orderBy: { version: 'desc' }, take: 4, select: { id: true, version: true, isCurrent: true, createdAt: true } });
  for (const g of gens) {
    const scn = await prisma.testScenario.count({ where: { projectId: PID, generationId: g.id } });
    const cas = await prisma.testCase.count({ where: { projectId: PID, generationId: g.id } });
    const withSteps = await prisma.testCase.count({ where: { projectId: PID, generationId: g.id, NOT: { steps: null } } });
    console.log(`v${g.version} ${g.isCurrent ? '[CURRENT]' : '         '} scn=${scn} cases=${cas} withSteps=${withSteps} created=${g.createdAt.toISOString().slice(11,19)}`);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e.message); prisma.$disconnect(); process.exit(1); });
