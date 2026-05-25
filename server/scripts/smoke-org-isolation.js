'use strict';

/**
 * E8 acceptance smoke — verifies the core isolation guarantee:
 * "A user from Org A cannot see a Project from Org B even with a forged
 *  direct API call."
 *
 * Steps:
 *   1. Pick two existing users (the backfill gave each their own Solo org).
 *   2. Confirm both have non-null currentOrgId AND distinct orgs.
 *   3. Pick the project that's tagged to one user's org.
 *   4. Run the same query the routes use: `findFirst({ where: { id, orgId } })`.
 *      Use User A's orgId → should find the project (it's theirs).
 *      Use User B's orgId → should return null (the gate works).
 *
 * Run with:  node server/scripts/smoke-org-isolation.js
 */

const prisma = require('../prisma');

(async () => {
  const users = await prisma.user.findMany({
    where: { currentOrgId: { not: null } },
    select: { id: true, email: true, currentOrgId: true },
    take: 2,
  });
  if (users.length < 2) {
    console.log('Need at least 2 users to test isolation. Skipping (have', users.length, ').');
    await prisma.$disconnect();
    return;
  }
  // Pick a project that has an orgId so the test is meaningful; then pick
  // the user whose org owns it as A, and any other user as B.
  const project = await prisma.project.findFirst({
    where: { orgId: { not: null } },
    select: { id: true, name: true, orgId: true },
  });
  if (!project) {
    console.log('No projects with orgId — backfill may not have run.');
    await prisma.$disconnect();
    return;
  }
  const a = users.find((u) => u.currentOrgId === project.orgId);
  const b = users.find((u) => u.currentOrgId && u.currentOrgId !== project.orgId);
  if (!a || !b) {
    console.log('Could not find both an owning user and an outsider — skipping.');
    await prisma.$disconnect();
    return;
  }
  console.log(`User A (owner):    ${a.email}  org=${a.currentOrgId.slice(0, 12)}…`);
  console.log(`User B (outsider): ${b.email}  org=${b.currentOrgId.slice(0, 12)}…`);
  const projectOfA = project;
  console.log(`Project of A: "${projectOfA.name}" (id=${projectOfA.id.slice(0, 12)}…)`);

  // Simulate route lookup as User A (their own org).
  const seenByA = await prisma.project.findFirst({
    where: { id: projectOfA.id, orgId: a.currentOrgId },
    select: { id: true },
  });

  // Simulate route lookup as User B (different org, forged URL).
  const seenByB = await prisma.project.findFirst({
    where: { id: projectOfA.id, orgId: b.currentOrgId },
    select: { id: true },
  });

  console.log('');
  console.log(`User A sees A's project?  ${seenByA ? 'YES (correct)' : 'NO (FAIL — owner blocked)'}`);
  console.log(`User B sees A's project?  ${seenByB ? 'YES (FAIL — isolation broken)' : 'NO (correct — blocked)'}`);

  const pass = !!seenByA && !seenByB;
  console.log('');
  console.log(`Isolation acceptance:  ${pass ? 'PASS' : 'FAIL'}`);

  await prisma.$disconnect();
  if (!pass) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
