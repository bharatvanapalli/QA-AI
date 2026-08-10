const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const result = await prisma.run.updateMany({
    where: { status: 'running' },
    data: { status: 'cancelled' }
  });
  console.log(`Cancelled ${result.count} hanging runs.`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
