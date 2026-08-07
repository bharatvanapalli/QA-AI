const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient();
(async () => {
  if (process.env.NODE_ENV !== 'demo' && process.env.QAAI_ALLOW_DEMO_KB_SEED !== '1') {
    console.error('Refusing to run demo KB seed outside NODE_ENV=demo. Set QAAI_ALLOW_DEMO_KB_SEED=1 for an explicit local demo override.');
    await prisma.$disconnect();
    process.exit(1);
  }
  const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';

  // OrangeHRM user avatar - stable CSS class selector (works on any page)
  const AVATAR_SELECTOR = 'locator(".oxd-userdropdown-tab")';

  const avatarPages = [
    'https://opensource-demo.orangehrmlive.com/web/index.php/dashboard/index',
    'https://opensource-demo.orangehrmlive.com/web/index.php/admin/viewSystemUsers',
  ];
  for (const pageUrl of avatarPages) {
    await prisma.knowledgeBaseLocator.upsert({
      where: { projectId_element_pageUrl: { projectId: PROJECT_ID, element: 'user dropdown trigger in top navigation', pageUrl } },
      update: { selector: AVATAR_SELECTOR, strategy: 'css', role: 'button', accessibleName: null, healthScore: 80, occurrences: 5 },
      create: { projectId: PROJECT_ID, element: 'user dropdown trigger in top navigation', selector: AVATAR_SELECTOR, strategy: 'css', role: 'button', accessibleName: null, pageUrl, healthScore: 80, occurrences: 5 },
    });
    console.log('Seeded user avatar locator for', pageUrl.slice(-40));
  }

  // Verify
  const all = await prisma.knowledgeBaseLocator.findMany({
    where: { projectId: PROJECT_ID, element: 'user dropdown trigger in top navigation' },
    select: { element: true, selector: true, pageUrl: true, healthScore: true },
  });
  console.log('\nVerified KB entries for user avatar:');
  for (const e of all) console.log(' ', e.healthScore, e.element, '@', e.pageUrl?.slice(-40));

  await prisma.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
