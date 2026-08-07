const { PrismaClient } = require('.prisma/client');
const prisma = new PrismaClient();
const projectId = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
async function main() {
  const reqs = await prisma.$queryRawUnsafe(
    "SELECT id, title, type, filePath, createdAt FROM Requirement WHERE projectId = ? ORDER BY createdAt",
    projectId
  );
  console.log('=== Requirement ===');
  console.log(JSON.stringify(reqs, null, 2));
  await prisma.$disconnect();
}
main().catch(console.error);
