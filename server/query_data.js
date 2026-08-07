const { PrismaClient } = require('.prisma/client');
const prisma = new PrismaClient();
const projectId = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const ser = (v) => JSON.stringify(v, (k, val) => typeof val === 'bigint' ? val.toString() : val, 2);
async function main() {
  // Documents
  const docs = await prisma.$queryRawUnsafe(
    "SELECT id, name, mimeType, sizeBytes, category, uploadedAt, substr(content,1,500) as contentPreview FROM Document WHERE projectId = ? ORDER BY uploadedAt",
    projectId
  );
  console.log('=== Documents ===');
  console.log(ser(docs));
  
  // Requirement
  const reqs = await prisma.$queryRawUnsafe(
    "SELECT id, sourceType, sourceIdentifier, title, category, pulledAt, substr(content,1,500) as contentPreview FROM Requirement WHERE projectId = ? ORDER BY pulledAt",
    projectId
  );
  console.log('=== Requirements ===');
  console.log(ser(reqs));
  
  await prisma.$disconnect();
}
main().catch(console.error);
