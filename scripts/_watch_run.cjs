// Poll the latest run for the PIM project until it reaches a terminal state,
// then print the verdict spread + the fate of the 5 previously-unprovable cases.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { buildCaseNumbering } = require('../server/lib/caseNumbering');
const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920';
const WATCH = new Set(['S5 · C1', 'S7 · C1', 'S8 · C1', 'S9 · C1', 'S10 · C1']); // v2 labels; v3 may differ but PIM-create/personal/contact/emergency cases
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let run = null;
  for (let i = 0; i < 240; i++) { // up to ~120 min at 30s
    run = await prisma.run.findFirst({ where: { projectId: PROJECT }, orderBy: { startedAt: 'desc' } });
    const results = run ? await prisma.runResult.findMany({ where: { runId: run.id } }) : [];
    const done = run && ['completed', 'complete', 'failed', 'cancelled', 'error'].includes(String(run.status || '').toLowerCase());
    if (i % 4 === 0 || done) {
      const by = {};
      results.forEach((r) => { by[r.status] = (by[r.status] || 0) + 1; });
      console.log(`[${new Date().toLocaleTimeString()}] run ${run?.id?.slice(0,8)} status=${run?.status} results=${results.length}  ${JSON.stringify(by)}`);
    }
    if (done) break;
    await sleep(30000);
  }
  if (!run) { console.log('no run found'); process.exit(0); }

  const results = await prisma.runResult.findMany({ where: { runId: run.id } });
  const scns = await prisma.testScenario.findMany({ where: { projectId: PROJECT, generationId: run.generationId }, include: { cases: true } });
  const num = buildCaseNumbering(scns);
  const labelByCase = num.caseLabelById;

  const by = {};
  results.forEach((r) => { by[r.status] = (by[r.status] || 0) + 1; });
  console.log(`\n════════ RUN ${run.id.slice(0,8)} TERMINAL — status=${run.status} ════════`);
  console.log(`verdict spread: ${JSON.stringify(by)}  (total ${results.length})`);

  const nh = results.filter((r) => r.status === 'needs_human');
  console.log(`\nneeds_human: ${nh.length}`);
  nh.forEach((r) => console.log(`  ${labelByCase.get(r.testCaseId) || r.testCaseId.slice(0,8)}  ${(r.mechanicalVerdictReason||r.error||'').slice(0,80)}`));

  console.log(`\nPAGE-bearing / create-flow cases (the ones that were structurally unprovable in v2):`);
  for (const r of results) {
    const label = labelByCase.get(r.testCaseId) || '';
    const tc = scns.flatMap((s) => s.cases).find((c) => c.id === r.testCaseId);
    const decl = (() => { try { return JSON.parse(tc?.declaredAssertions || '[]'); } catch { return []; } })();
    if (decl.some((d) => d.type === 'PAGE')) {
      console.log(`  ${label}  ${r.status}  "${(tc?.name||'').slice(0,46)}"  ${(r.mechanicalVerdictReason||'').slice(0,50)}`);
    }
  }
  await prisma.$disconnect(); process.exit(0);
})().catch((e) => { console.error('watch ERR', e.message); process.exit(1); });
