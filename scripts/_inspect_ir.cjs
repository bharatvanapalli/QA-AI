'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const RUN_ID = process.argv[2] || '25556eab-0c61-4bd3-ac76-f86b996d4730';

function exprOf(node) {
  if (!node) return null;
  const al = node.actionLocator;
  const fromAl = al && (al.frameworkExpressions && al.frameworkExpressions.playwright || al.expression);
  if (fromAl) return fromAl;
  const c = node.candidates && node.candidates[0];
  if (!c) return null;
  if (c.expression) return c.expression;
  if (c.selector) return c.selector;
  if (c.strategy === 'role' && c.role && c.name) return `getByRole("${c.role}", { name: "${c.name}" })`;
  if (c.strategy === 'testId' && c.testId) return `getByTestId("${c.testId}")`;
  if (c.strategy === 'placeholder' && c.text) return `getByPlaceholder("${c.text}")`;
  if (c.text) return `getByText("${c.text}")`;
  return null;
}

(async () => {
  const run = await prisma.run.findUnique({ where: { id: RUN_ID }, select: { id: true, status: true, startedAt: true, completedAt: true, passed: true, failed: true, blocked: true } });
  console.log('RUN', RUN_ID, JSON.stringify(run));
  const results = await prisma.runResult.findMany({ where: { runId: RUN_ID }, select: { id: true, testCaseId: true, status: true, updatedAt: true, replayIrJson: true } });
  for (const r of results) {
    let env = null; try { env = JSON.parse(r.replayIrJson); } catch {}
    const ir = env && (env.ir || env);
    if (!ir || !ir.steps) { console.log(`\nresult ${r.id} status=${r.status} — NO IR`); continue; }
    const resolves = ir.steps.filter((s) => s.op === 'resolve');
    const withExpr = resolves.filter((s) => exprOf(s)).length;
    console.log(`\nresult ${r.id} status=${r.status} updated=${r.updatedAt && r.updatedAt.toISOString()} | complete=${env.complete} steps=${ir.steps.length} resolves=${resolves.length} withLocator=${withExpr} gaps=${(env.gaps||[]).length}`);
    let n = 0;
    for (const s of resolves) { n++; console.log(`  ${String(n).padStart(2)}. ${s.elementLabel || s.narration} [${s.locatorConfidence||'gold'}] → ${exprOf(s) || '(NONE)'}`); }
    for (const g of (env.gaps || [])) console.log(`  GAP [${g.code}] ${g.elementLabel||g.narration} ref=${g.ref||''}`);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
