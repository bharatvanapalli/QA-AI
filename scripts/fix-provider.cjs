'use strict';
const { PrismaClient } = require('../server/node_modules/.prisma/client');
const p = new PrismaClient();

async function main() {
  // Show current state
  const projects = await p.project.findMany({ select: { id: true, name: true, aiProvider: true } });
  console.log('Current projects:', JSON.stringify(projects, null, 2));

  // Set ALL projects to copilot
  const updated = await p.project.updateMany({
    where: {},
    data: { aiProvider: 'copilot' },
  });
  console.log('Updated projects to copilot:', updated);

  const after = await p.project.findMany({ select: { id: true, name: true, aiProvider: true } });
  console.log('After fix:', JSON.stringify(after, null, 2));
}

main().catch(console.error).finally(() => p.$disconnect());
