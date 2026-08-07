const path = require('path');
const clientPath = path.resolve(__dirname, '../server/node_modules/.prisma/client');
const { PrismaClient } = require(clientPath);
const dbPath = path.resolve(__dirname, '../server/prisma/dev.db');
const db = new PrismaClient({ datasources: { db: { url: 'file:' + dbPath + '?mode=ro' } } });
async function main() {
  const run = await db.run.findUnique({
    where: { id: 'cb2836e8-5b06-4044-8328-a4a506d9b98c' },
    select: { id: true, status: true, passed: true, failed: true, blocked: true, needsHuman: true }
  });
  console.log('Run:', JSON.stringify(run));
  const total = await db.testResult.count({ where: { runId: 'cb2836e8-5b06-4044-8328-a4a506d9b98c' } });
  console.log('Total results:', total);
  const withSpec = await db.testResult.count({ where: { runId: 'cb2836e8-5b06-4044-8328-a4a506d9b98c', specCode: { not: null } } });
  console.log('Results with specCode:', withSpec);
}
main().catch(e => console.error(e)).finally(() => db.$disconnect());
