const { PrismaClient } = require('.prisma/client');
const prisma = new PrismaClient();
const projectId = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const ser = (v) => JSON.stringify(v, (k, val) => typeof val === 'bigint' ? val.toString() : val, 2);
async function main() {
  // Full document content
  const docs = await prisma.$queryRawUnsafe(
    "SELECT id, name, category, content FROM Document WHERE projectId = ? ORDER BY uploadedAt",
    projectId
  );
  for (const doc of docs) {
    console.log('\n=== DOCUMENT: ' + doc.name + ' [' + doc.category + '] ===');
    console.log(doc.content);
  }
  await prisma.$disconnect();
}
main().catch(console.error);
