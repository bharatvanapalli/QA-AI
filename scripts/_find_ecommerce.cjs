'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const { PrismaClient } = require(path.join(__dirname, '..', 'server', 'node_modules', '@prisma', 'client'));
const prisma = new PrismaClient();
(async () => {
  // All projects, all orgs
  const projects = await prisma.project.findMany({
    select: { id: true, targetUrl: true, environment: true, orgId: true },
    orderBy: { createdAt: 'desc' }
  });
  console.log('ALL PROJECTS:');
  console.log(JSON.stringify(projects, null, 2));

  // All users
  const users = await prisma.user.findMany({ select: { id: true, email: true, currentOrgId: true } });
  console.log('\nALL USERS:');
  console.log(JSON.stringify(users, null, 2));

  // Mint token for first user
  if (users.length > 0) {
    const u = users[0];
    const token = jwt.sign({ sub: u.id, email: u.email, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '2h' });
    console.log('\nTOKEN=' + token);
  }
  await prisma.$disconnect();
})().catch(async e => { console.error(e.message); await prisma.$disconnect(); process.exit(1); });
