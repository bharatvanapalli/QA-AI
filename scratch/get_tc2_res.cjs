const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const fs = require('fs');

async function main() {
  const tc2Res = await prisma.runResult.findUnique({
    where: { id: '6f29ba78-2f77-45a6-ac92-24fbdb1d7977' }
  });
  const tc1Res = await prisma.runResult.findUnique({
    where: { id: '4d2ef37b-306b-4ee0-9f3c-6095ad3a325b' }
  });
  fs.writeFileSync('scratch/run_tc2.json', JSON.stringify(tc2Res, null, 2), 'utf8');
  fs.writeFileSync('scratch/run_tc1.json', JSON.stringify(tc1Res, null, 2), 'utf8');
}
main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
