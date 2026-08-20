'use strict';
const { PrismaClient } = require('../server/node_modules/.prisma/client');
const p = new PrismaClient();

async function main() {
  // Get the latest calibration
  const cal = await p.calibration.findFirst({
    where: { status: 'complete' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, startUrl: true, createdAt: true, pagesCount: true }
  });
  console.log('Latest calibration:', JSON.stringify(cal, null, 2));

  if (!cal) { console.log('No calibration found'); return; }

  // Get all pages crawled
  const pages = await p.calibrationPage.findMany({
    where: { calibrationId: cal.id },
    select: { url: true, pageRole: true, elementsJson: true, textCorpus: true, capabilitiesJson: true }
  });

  for (const pg of pages) {
    const elements = JSON.parse(pg.elementsJson || '[]');
    const text = JSON.parse(pg.textCorpus || '[]');
    const caps = JSON.parse(pg.capabilitiesJson || '[]');
    console.log('\n=== PAGE:', pg.url, '===');
    console.log('Role:', pg.pageRole);
    console.log('Elements count:', elements.length);
    console.log('Elements:', elements.map(e => e.semanticLabel).join(', '));
    console.log('Text labels count:', text.length);
    console.log('Text sample (first 10):', text.slice(0, 10).join(' | '));
    console.log('Capabilities:', caps.length);
  }
}

main().catch(console.error).finally(() => p.$disconnect());
