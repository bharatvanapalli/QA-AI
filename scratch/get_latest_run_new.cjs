const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const fs = require('fs');

async function main() {
  const run = await prisma.run.findFirst({
    orderBy: { startedAt: 'desc' },
    include: { results: true }
  });
  fs.writeFileSync('scratch/run_details_new.json', JSON.stringify(run, null, 2), 'utf8');
}
main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
