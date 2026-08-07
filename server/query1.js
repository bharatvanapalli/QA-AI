const { PrismaClient } = require('.prisma/client');
const prisma = new PrismaClient();
const projectId = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
async function main() {
  // RequirementClause
  const clauses = await prisma.$queryRawUnsafe(
    "SELECT id, title, content, createdAt FROM RequirementClause WHERE projectId = ? ORDER BY createdAt",
    projectId
  );
  console.log('=== RequirementClause ===');
  console.log(JSON.stringify(clauses, null, 2));
  await prisma.$disconnect();
}
main().catch(console.error);
