// Read-only: locate the case labelled "S4 · C1" in the latest run's generation,
// then show its STEPS vs its DECLARED ASSERTIONS so we can see where the
// "Employee Name" expectedText actually lives (it's an assertion, not a step).
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { buildCaseNumbering } = require('../server/lib/caseNumbering');
const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920';
const WANT = process.argv[2] || 'S4 · C1';

(async () => {
  try {
    const run = await prisma.run.findFirst({ where: { projectId: PROJECT }, orderBy: { startedAt: 'desc' } });
    const scns = await prisma.testScenario.findMany({
      where: run?.generationId ? { generationId: run.generationId } : { projectId: PROJECT },
      include: { cases: true },
    });
    const num = buildCaseNumbering(scns);
    let caseId = null, scnLabel = null;
    for (const [id, label] of num.caseLabelById) if (label === WANT) caseId = id;
    for (const s of scns) if (num.scenarioLabelById.get(s.id) === WANT.split('·')[0].trim()) scnLabel = s.title || s.name;
    if (!caseId) { console.log(`No case labelled "${WANT}" in generation ${run?.generationId}`); return; }

    const tc = await prisma.testCase.findUnique({ where: { id: caseId } });
    console.log(`SCENARIO: ${scnLabel}`);
    console.log(`CASE ${WANT}: "${tc.name}"  (id ${tc.id.slice(0,8)})`);

    const steps = (() => { try { return JSON.parse(tc.steps || '[]'); } catch { return []; } })();
    console.log(`\n── AUTHORED STEPS (${steps.length}) ──`);
    steps.forEach((s, i) => console.log(`  ${s.order ?? i+1}. ${s.action || ''}${s.target ? `  →target: ${s.target}` : ''}${s.value ? `  =${s.value}` : ''}${s.expected ? `  [expected: ${s.expected}]` : ''}`));

    const decl = (() => { try { return JSON.parse(tc.declaredAssertions || '[]'); } catch { return []; } })();
    console.log(`\n── DECLARED ASSERTIONS (${decl.length}) ← the verdict is computed from THESE ──`);
    decl.forEach((d, i) => console.log(`  ${i+1}. [${d.criticality || '?'}] ${d.type}  expected=${JSON.stringify(d.expectedText || d.expectedUrlPattern || d.expectedRole || d.payload || d.value || '')}  ${d.description ? `“${d.description}”` : ''}`));

    // expectedResults free-text (often where the LLM seeded "Employee Name")
    if (tc.expectedResults) console.log(`\n── expectedResults (free text) ──\n  ${String(tc.expectedResults).replace(/\n/g,'\n  ').slice(0,600)}`);

    // The actual run result + assertion outcomes
    const r = await prisma.runResult.findFirst({
      where: { runId: run.id, testCaseId: caseId }, orderBy: { id: 'desc' },
      select: { status: true, error: true, mechanicalVerdictReason: true, blockedReason: true, assertionCheckResults: true },
    });
    if (r) {
      console.log(`\n── RUN RESULT ──`);
      console.log(`  status=${r.status}  mechReason=${(r.mechanicalVerdictReason||'').slice(0,160)}`);
      console.log(`  blockedReason=${r.blockedReason}`);
      if (r.error) console.log(`  error: ${String(r.error).replace(/\n/g,' ').slice(0,240)}`);
      const oc = (() => { try { return JSON.parse(r.assertionCheckResults || '[]'); } catch { return []; } })();
      console.log(`\n  assertion outcomes (${oc.length}):`);
      oc.forEach((o) => console.log(`    - ${o.outcome}  [${o.criticality||'?'}] exp=${JSON.stringify(o.expectedText||'').slice(0,40)}  ${(o.reason||'').slice(0,90)}`));
    }
  } catch (e) { console.error('ERR', e.message); } finally { await prisma.$disconnect(); process.exit(0); }
})();
