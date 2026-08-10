const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const project = await prisma.project.findUnique({
    where: { id: 'c6a3a436-1c10-4462-9b61-f8b2ab71ebb0' },
    select: { id: true, contextHeadless: true, triggerConfigJson: true }
  });
  console.log(JSON.stringify(project, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
