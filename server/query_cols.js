const { PrismaClient } = require('.prisma/client');
const prisma = new PrismaClient();
const projectId = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const ser = (v) => JSON.stringify(v, (k, val) => typeof val === 'bigint' ? val.toString() : val, 2);
async function main() {
  const clauseCols = await prisma.$queryRawUnsafe("PRAGMA table_info(RequirementClause)");
  console.log('RequirementClause cols:', ser(clauseCols));
  
  const reqCols = await prisma.$queryRawUnsafe("PRAGMA table_info(Requirement)");
  console.log('Requirement cols:', ser(reqCols));
  
  const docCols = await prisma.$queryRawUnsafe("PRAGMA table_info(Document)");
  console.log('Document cols:', ser(docCols));
  
  const tdsCols = await prisma.$queryRawUnsafe("PRAGMA table_info(TestDataSet)");
  console.log('TestDataSet cols:', ser(tdsCols));
  
  const tdmCols = await prisma.$queryRawUnsafe("PRAGMA table_info(TestDataMapping)");
  console.log('TestDataMapping cols:', ser(tdmCols));
  
  await prisma.$disconnect();
}
main().catch(console.error);
