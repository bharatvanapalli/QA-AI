// Read-only: dump a case's latest RunResult detail to diagnose WHY it failed.
// Usage: node diag_case.cjs "<case name substring>"
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920';
(async () => {
  try {
    const q = process.argv[2] || 'empty password';
    // Scope to the CURRENT run's result (project has scenario generations, so a
    // name can match multiple TestCase rows across versions).
    const run = await prisma.run.findFirst({ where: { projectId: PROJECT }, orderBy: { startedAt: 'desc' }, select: { id: true } });
    const r = await prisma.runResult.findFirst({
      where: { runId: run.id, testCase: { name: { contains: q } } },
      orderBy: { id: 'desc' },
      select: { status: true, error: true, mechanicalVerdictReason: true, blockedReason: true, stepResults: true, assertionCheckResults: true, chatHistory: true,
        testCase: { select: { id: true, name: true, declaredAssertions: true } } } });
    if (!r) return console.log('no result in current run matching', q);
    const tc = r.testCase;
    console.log(`CASE: "${tc.name}"`);
    console.log(`status=${r.status} mechReason=${r.mechanicalVerdictReason} blockedReason=${r.blockedReason}`);
    console.log(`error: ${(r.error||'').slice(0,200)}`);
    const decl = (() => { try { return JSON.parse(tc.declaredAssertions||'[]'); } catch { return []; } })();
    console.log(`\ndeclared assertions (${decl.length}):`);
    for (const d of decl.slice(0,8)) console.log(`  - [${d.criticality||'?'}] ${d.type}: ${JSON.stringify(d.expectedText||d.expectedUrlPattern||d.expectedRole||d.payload||'').slice(0,80)}`);
    const steps = (() => { try { return JSON.parse(r.stepResults||'[]'); } catch { return []; } })();
    console.log(`\nsteps (${steps.length}):`);
    for (const s of steps.slice(0,14)) {
      console.log(`  ${s.index}. [${s.status}] ${(s.description||s.action||'').slice(0,70)}`);
      if (s.error) console.log(`       FULL ERR: ${String(s.error).replace(/\n/g,' ').slice(0,300)}`);
    }
    // Tool-result tail from chatHistory — the EXACT text the agent received (incl. raw Playwright errors).
    const chat = (() => { try { return JSON.parse(r.chatHistory||'[]'); } catch { return []; } })();
    console.log(`\nchatHistory tail (${chat.length} entries) — error-bearing tool results:`);
    const flat = [];
    for (const m of chat) {
      const content = Array.isArray(m.content) ? m.content : [m.content];
      for (const c of content) {
        const txt = typeof c === 'string' ? c : (c?.text || (c?.type==='tool_result' ? JSON.stringify(c.content) : ''));
        if (txt && /error|ref=|timeout|intercept|not in the current|hidden|detached/i.test(txt)) flat.push(`[${m.role||'?'}] ${String(txt).replace(/\n/g,' ').slice(0,220)}`);
      }
    }
    for (const line of flat.slice(-10)) console.log('  • ' + line);
    const oc = (() => { try { return JSON.parse(r.assertionCheckResults||'[]'); } catch { return []; } })();
    console.log(`\nassertion outcomes (${oc.length}):`);
    for (const o of oc.slice(0,8)) console.log(`  - ${o.assertionId?.slice(0,8)} ${o.outcome} (${o.source||'?'}) ${(o.reason||'').slice(0,60)}`);
  } catch (e) { console.error('ERR', e.message); } finally { await prisma.$disconnect(); process.exit(0); }
})();
