'use strict';
const { PrismaClient } = require('../server/node_modules/.prisma/client');
const p = new PrismaClient();

const TARGET_PAGES = [
  'https://letcode.in/edit',
  'https://letcode.in/button',
  'https://letcode.in/dropdowns',
  'https://letcode.in/alert',
  'https://letcode.in/frame',
  'https://letcode.in/radio',
  'https://letcode.in/window',
];

async function main() {
  const cal = await p.calibration.findFirst({
    where: { status: 'complete' },
    orderBy: { createdAt: 'desc' },
    select: { id: true }
  });

  const pages = await p.calibrationPage.findMany({
    where: { calibrationId: cal.id, url: { in: TARGET_PAGES } },
    select: { url: true, pageRole: true, elementsJson: true, textCorpus: true, substatesJson: true }
  });

  for (const pg of pages) {
    const elements = JSON.parse(pg.elementsJson || '[]');
    const text = JSON.parse(pg.textCorpus || '[]');
    const substates = JSON.parse(pg.substatesJson || '[]');
    console.log('\n========================================');
    console.log('PAGE:', pg.url);
    console.log('Role:', pg.pageRole);
    console.log('--- ALL ELEMENTS (' + elements.length + ') ---');
    elements.forEach(e => console.log('  ' + e.semanticLabel));
    console.log('--- TEXT CORPUS SAMPLE (first 20) ---');
    text.slice(0, 20).forEach(t => console.log('  "' + t + '"'));
    console.log('--- SUBSTATES ---', substates.length);
  }
}

main().catch(console.error).finally(() => p.$disconnect());
