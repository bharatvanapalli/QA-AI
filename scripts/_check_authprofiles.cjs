'use strict';
const path = require('path');
const { PrismaClient } = require(path.join(__dirname, '..', 'server', 'node_modules', '@prisma', 'client'));
const db = new PrismaClient();

(async () => {
  const [profiles, secCase, project] = await Promise.all([
    db.authProfile.findMany({ select: { id: true, name: true, strategy: true, disposition: true, credentialRef: true, projectId: true } }),
    db.testCase.findFirst({ where: { name: { contains: 'security' } }, select: { id: true, name: true, authProfile: true, dataBindingJson: true } }),
    db.project.findFirst({ select: { id: true, name: true, testCredentials: true } }),
  ]);
  console.log('AUTH_PROFILES:', JSON.stringify(profiles, null, 2));
  console.log('\nSECURITY TC:', JSON.stringify(secCase, null, 2));
  console.log('\nPROJECT testCredentials:', project && project.testCredentials);
  await db.$disconnect();
})().catch(e => { console.error(String(e)); process.exit(1); });
