const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const tc = await prisma.testCase.findFirst({ where: { name: { contains: 'Edit Fields' } } });
  console.log('--- CASE ASSERTIONS ---');
  console.log(JSON.parse(tc.assertions));
}

main().finally(() => prisma.$disconnect());
