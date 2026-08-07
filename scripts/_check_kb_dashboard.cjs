const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
  // Find KB entries for the user dropdown/avatar at the dashboard
  const entries = await prisma.knowledgeBaseLocator.findMany({
    where: { projectId: PROJECT_ID, pageUrl: { contains: 'dashboard' } },
    orderBy: { occurrences: 'desc' },
    select: { id: true, element: true, selector: true, role: true, accessibleName: true, pageUrl: true, healthScore: true, occurrences: true, strategy: true, intent: true },
  });
  console.log('KB entries for dashboard URLs:', entries.length);
  for (const e of entries) {
    console.log(`  h:${e.healthScore} occ:${e.occurrences} | ${e.element}`);
    console.log(`     role:${e.role} name:${e.accessibleName} strategy:${e.strategy} | sel:${(e.selector || '').slice(0, 80)}`);
  }

  // Also check user dropdown globally
  const avatarEntries = await prisma.knowledgeBaseLocator.findMany({
    where: { projectId: PROJECT_ID, element: { contains: 'dropdown' } },
    orderBy: { occurrences: 'desc' },
    take: 10,
    select: { id: true, element: true, selector: true, role: true, accessibleName: true, pageUrl: true, healthScore: true, occurrences: true },
  });
  console.log('\nKB entries with "dropdown" in element:', avatarEntries.length);
  for (const e of avatarEntries) {
    console.log(`  h:${e.healthScore} | ${e.element} @ ${(e.pageUrl || '').slice(-40)}`);
    console.log(`     role:${e.role} name:${e.accessibleName} | sel:${(e.selector || '').slice(0, 80)}`);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
