const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const run = await prisma.runResult.findUnique({
    where: { id: '8f2c9406-a66a-4854-a8c3-2c7d0a6913c2' }
  });
  console.log(`Status: ${run.status}`);
  console.log(`Error: ${run.error}`);
  console.log(`Summary: ${run.summary}`);
  console.log(`Logs:`, run.logs ? JSON.parse(run.logs).slice(-10) : 'none');
}

main().finally(() => prisma.$disconnect());
