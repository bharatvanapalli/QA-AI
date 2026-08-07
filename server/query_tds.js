const { PrismaClient } = require('.prisma/client');
const prisma = new PrismaClient();
const projectId = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const ser = (v) => JSON.stringify(v, (k, val) => typeof val === 'bigint' ? val.toString() : val, 2);
async function main() {
  // TestDataSet
  const tds = await prisma.$queryRawUnsafe(
    "SELECT id, name, rowCount, uploadedAt, substr(sheetsJson,1,2000) as sheetsPreview, mappingJson FROM TestDataSet WHERE projectId = ? ORDER BY uploadedAt",
    projectId
  );
  console.log('=== TestDataSet ===');
  console.log(ser(tds));
  
  await prisma.$disconnect();
}
main().catch(console.error);
