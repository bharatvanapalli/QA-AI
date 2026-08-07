const { PrismaClient } = require('.prisma/client');
const prisma = new PrismaClient();
const projectId = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const ser = (v) => JSON.stringify(v, (k, val) => typeof val === 'bigint' ? val.toString() : val, 2);
async function main() {
  const clauses = await prisma.$queryRawUnsafe(
    "SELECT id, sourceType, sourceDocId, excerpt, behaviourText, coverageDisposition, createdAt FROM RequirementClause WHERE projectId = ? ORDER BY createdAt",
    projectId
  );
  console.log('Total RequirementClauses:', clauses.length);
  console.log(ser(clauses));
  await prisma.$disconnect();
}
main().catch(console.error);
