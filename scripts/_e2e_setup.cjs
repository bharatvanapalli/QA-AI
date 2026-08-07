const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
async function main() {
  const user = await p.user.findFirst({ where: { email: 'bharatvanapalli8@gmail.com' }, select: { id: true, email: true, role: true, currentOrgId: true } });
  if (!user) { console.log('USER NOT FOUND'); return; }
  console.log('user:', JSON.stringify(user));

  const projects = await p.project.findMany({ where: { orgId: user.currentOrgId }, select: { id: true, name: true, targetUrl: true }, orderBy: { createdAt: 'desc' } });
  console.log('projects:', JSON.stringify(projects, null, 2));

  const orangeProject = projects.find(p => p.name && p.name.toLowerCase().includes('orange'));
  if (orangeProject) console.log('\nORANGE PROJECT ID:', orangeProject.id);
}
main().catch(console.error).finally(() => p.$disconnect());
