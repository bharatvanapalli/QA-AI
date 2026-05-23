'use strict';

/**
 * Clean-slate script. Removes any demo project from the target user's account
 * so they can start with their OWN documents. Creates nothing.
 *
 * Usage: node prisma/seed.cjs <email>
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const prisma = require('../server/prisma');

const TARGET_EMAIL = process.argv[2] || 'bharatvanapalli8@gmail.com';

async function main() {
  console.log(`\n→ Wiping demo data for ${TARGET_EMAIL}\n`);

  const user = await prisma.user.findUnique({ where: { email: TARGET_EMAIL } });
  if (!user) {
    console.error(`✗ User ${TARGET_EMAIL} not found.`);
    process.exit(1);
  }
  console.log(`  User: ${user.id}`);

  // Delete any demo-prefixed project (cascades to docs, requirements,
  // scenarios, cases, runs, results, PRs, blocked items, KB, discrepancies).
  const prior = await prisma.project.findMany({
    where: { userId: user.id, name: { startsWith: 'Demo:' } },
  });
  for (const p of prior) {
    await prisma.project.delete({ where: { id: p.id } });
    console.log(`  Removed demo project: ${p.name} (${p.id})`);
  }

  console.log(`\n✅ Clean slate. Open http://localhost:5173 and:`);
  console.log(`   1. Project Setup → New project → name it, set target URL`);
  console.log(`   2. Run Suite → upload your own BRD / User Stories / Release Notes`);
  console.log(`   3. Click "Generate scenarios & test cases"\n`);
}

main()
  .catch((err) => { console.error('\n✗ Failed:', err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
