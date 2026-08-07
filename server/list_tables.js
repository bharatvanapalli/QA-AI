const { PrismaClient } = require('.prisma/client');
const prisma = new PrismaClient();
async function main() {
  const tables = await prisma.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table'");
  console.log(JSON.stringify(tables, null, 2));
  await prisma.$disconnect();
}
main().catch(console.error);
