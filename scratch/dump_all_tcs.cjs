const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const tcs = await prisma.testCase.findMany();
  for (const tc of tcs) {
    console.log(tc.id, tc.name);
  }
  await prisma.$disconnect();
}
run();
