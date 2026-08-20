'use strict';
const { PrismaClient } = require('../server/node_modules/.prisma/client');
const p = new PrismaClient();
const { runCalibrator } = require('../server/services/agents/calibrator');

async function main() {
  const project = await p.project.findFirst({ where: { name: 'New_LetCode' } });
  if (!project) { console.log('Project New_LetCode not found'); return; }

  console.log('Starting test calibration for project:', project.id);

  const cal = await p.calibration.create({
    data: { projectId: project.id, startUrl: 'https://letcode.in', status: 'running' }
  });

  const explicitSeedUrls = [
    'https://letcode.in/edit',
    'https://letcode.in/button',
    'https://letcode.in/dropdowns',
    'https://letcode.in/alert',
    'https://letcode.in/frame',
    'https://letcode.in/radio',
    'https://letcode.in/window',
  ];

  await runCalibrator({
    projectId: project.id,
    userId: 'test-user',
    calibrationId: cal.id,
    startUrl: 'https://letcode.in',
    crawlMode: 'deep',
    explicitSeedUrls,
    send: (msg) => {
      if (msg.type === 'agent.phase.log') {
        console.log(`[LOG] ${msg.level}: ${msg.message}`);
      }
    }
  });

  console.log('\n--- CALIBRATION RESULTS ---');
  const pages = await p.calibrationPage.findMany({
    where: { calibrationId: cal.id },
    select: { url: true, pageRole: true, elementsJson: true, textCorpus: true }
  });

  for (const pg of pages) {
    const elements = JSON.parse(pg.elementsJson || '[]');
    const text = JSON.parse(pg.textCorpus || '[]');
    console.log(`\nURL: ${pg.url}`);
    console.log(`Role: ${pg.pageRole}`);
    console.log(`Elements Count: ${elements.length}`);
    console.log(`Frame Elements: ${elements.filter(e => e.semanticLabel.includes('[frame]')).length}`);
    console.log(`Sample Elements:`, elements.slice(0, 8).map(e => e.semanticLabel));
  }
}

main().catch(console.error).finally(() => p.$disconnect());
