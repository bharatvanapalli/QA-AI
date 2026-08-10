const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const fs = require('fs');

async function main() {
  const tc = await prisma.testCase.findUnique({
    where: { id: '86398d13-d6b2-4330-8a96-c95dfd217da9' }
  });
  fs.writeFileSync('scratch/tc2.json', JSON.stringify(tc, null, 2), 'utf8');
}
main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
