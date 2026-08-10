const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  const fact = await prisma.traceArtifact.findFirst({
    where: { id: '660cd4c7-b406-4ccb-895a-ecbbcf9d2c02' }
  });
  if (fact) {
     console.log(fact.artifactJson);
  } else {
     console.log('not found');
  }
  await prisma.$disconnect();
}
run();
