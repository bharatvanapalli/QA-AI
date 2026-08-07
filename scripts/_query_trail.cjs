'use strict';
const { PrismaClient } = require('../node_modules/@prisma/client');
const db = new PrismaClient();
async function main() {
  const rr = await db.runResult.findFirst({
    where: { testCaseId: 'cc13d9c4-862c-4243-ad7a-e348c37b9beb' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, actionTrail: true, error: true }
  });
  if (!rr) { console.log('No result yet'); await db.$disconnect(); return; }
  let trail = [];
  try { trail = JSON.parse(rr.actionTrail || '[]'); } catch(_) {}
  console.log('Status:', rr.status, '| Trail entries:', trail.length);
  console.log('RunResult ID:', rr.id);
  if (rr.error) console.log('Error:', rr.error.slice(0, 200));
  trail.forEach((e, i) => {
    const err = e.error ? e.error.slice(0, 100) : '';
    console.log(i, 'turn:', e.turn, 'tool:', e.tool, 'ok:', e.ok, err ? ('ERR: ' + err) : '');
  });
  await db.$disconnect();
}
main().catch(e => { console.error(e.message); process.exit(1); });
