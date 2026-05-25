'use strict';
const prisma = require('../prisma');
(async () => {
  const userCount = await prisma.user.count();
  const orgCount = await prisma.organization.count();
  const memCount = await prisma.orgMembership.count();
  const usersWithOrg = await prisma.user.count({ where: { currentOrgId: { not: null } } });
  const projectsTagged = await prisma.project.count({ where: { orgId: { not: null } } });
  const projectsUntagged = await prisma.project.count({ where: { orgId: null } });
  console.log({ userCount, orgCount, memCount, usersWithOrg, projectsTagged, projectsUntagged });
  if (orgCount > 0) {
    const sample = await prisma.organization.findFirst({ select: { id: true, name: true, slug: true, ownerId: true } });
    console.log('sample org:', sample);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
