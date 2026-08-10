const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const tc = await prisma.testCase.findUnique({
    where: { id: 'd7b7cf88-c106-4b06-9d04-abe4c6e4cfcc' } // Navigate to OrangeHRM...
  });
  console.log(JSON.stringify(JSON.parse(tc.steps), null, 2));
  await prisma.$disconnect();
}
run();
