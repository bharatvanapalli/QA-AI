const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const tc = await prisma.testCase.findUnique({
    where: { id: '86398d13-d6b2-4330-8a96-c95dfd217da9' }
  });
  console.log(JSON.stringify(JSON.parse(tc.steps), null, 2));
  await prisma.$disconnect();
}
run();
