const { PrismaClient } = require('c:\\Users\\2461898\\Downloads\\qaai_fixed\\qaai_fixed\\qaai_fixed\\server\\node_modules\\.prisma\\client');
const db = new PrismaClient();
async function main() {
  const pid = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
  const runs = await db.run.findMany({
    where: { projectId: pid },
    orderBy: { startedAt: 'desc' },
    take: 3,
    select: { id: true, status: true, passed: true, failed: true, blocked: true, needsHuman: true, startedAt: true }
  });
  console.log(JSON.stringify(runs, null, 2));
  await db.$disconnect();
}
main().catch(e => { console.error(e.message); process.exit(1); });
