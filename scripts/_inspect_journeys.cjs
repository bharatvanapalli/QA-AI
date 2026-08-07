'use strict';
// No credits. Find a validation target: a run whose cases form a dependsOnIds
// chain AND have persisted richTrace files (so we can reconstruct + journey-gen).
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const journeys = require('../server/services/codegen/_journeys');
const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920';

(async () => {
  // 1. Any cases with dependsOnIds at all?
  const withDeps = await prisma.testCase.findMany({
    where: { projectId: PROJECT, dependsOnIds: { not: null } },
    select: { id: true, name: true, dependsOnIds: true },
  });
  const realDeps = withDeps.filter((c) => journeys.decodeDeps(c.dependsOnIds).length > 0);
  console.log(`Cases with dependsOnIds set: ${realDeps.length} / ${withDeps.length} non-null`);
  for (const c of realDeps.slice(0, 12)) {
    console.log(`   ${c.id.slice(0, 8)} "${c.name.slice(0, 50)}" → deps ${JSON.stringify(journeys.decodeDeps(c.dependsOnIds).map((d) => d.slice(0, 8)))}`);
  }

  // 2. Recent runs + trace coverage.
  const runs = await prisma.run.findMany({
    where: { projectId: PROJECT }, orderBy: { startedAt: 'desc' }, take: 8,
    select: { id: true, startedAt: true, status: true, passed: true, failed: true, blocked: true },
  });
  console.log(`\nRecent runs:`);
  for (const r of runs) {
    const rrs = await prisma.runResult.findMany({ where: { runId: r.id }, select: { richTraceFile: true, testCaseId: true } });
    const traced = rrs.filter((x) => x.richTraceFile).length;
    // Does this run contain a dependency chain?
    const caseIds = rrs.map((x) => x.testCaseId).filter(Boolean);
    const cases = await prisma.testCase.findMany({ where: { id: { in: caseIds } }, select: { id: true, name: true, dependsOnIds: true } });
    const plan = journeys.planJourneys(cases).filter((j) => j.isJourney);
    console.log(`   ${r.id.slice(0, 8)} ${r.status} · ${rrs.length} results (${traced} traced) · journeys-in-run: ${plan.length}`);
    for (const j of plan.slice(0, 3)) {
      const names = j.caseIds.map((id) => (cases.find((c) => c.id === id)?.name || id).slice(0, 28));
      console.log(`        chain: ${names.join('  →  ')}`);
    }
  }

  // 3. Heuristic: any create+search-like case names (potential manual chain)?
  const all = await prisma.testCase.findMany({ where: { projectId: PROJECT }, select: { id: true, name: true } });
  const creates = all.filter((c) => /add|create|new\b/i.test(c.name));
  const searches = all.filter((c) => /search|find|view|list|filter/i.test(c.name));
  console.log(`\nCreate-like cases: ${creates.length} · Search/view-like cases: ${searches.length}`);
  for (const c of creates.slice(0, 5)) console.log(`   CREATE ${c.id.slice(0, 8)} "${c.name.slice(0, 50)}"`);
  for (const c of searches.slice(0, 5)) console.log(`   SEARCH ${c.id.slice(0, 8)} "${c.name.slice(0, 50)}"`);

  await prisma.$disconnect();
})().catch((e) => { console.error('ERR', e.message); prisma.$disconnect(); process.exit(1); });
