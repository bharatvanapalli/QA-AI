const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const TC = 'a306ab75-d150-42a2-a330-6cb8deb11a82';
const PID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
function dec(s) { try { return JSON.parse(s); } catch (_) { return null; } }
(async () => {
  try {
    const run = await p.run.findFirst({ where: { projectId: PID }, orderBy: { startedAt: 'desc' }, select: { id: true, status: true, startedAt: true } });
    console.log('latest run', run && run.id, run && run.status, run && run.startedAt && run.startedAt.toISOString());
    const rr = await p.runResult.findFirst({
      where: { runId: run.id, testCaseId: TC },
      select: { id: true, status: true, replayIrJson: true, exportMeta: true },
    });
    if (!rr) { console.log('NO RESULT for a306ab75 in latest run'); return; }
    console.log('RunResult', rr.id, 'status=', rr.status);
    const ir = dec(rr.replayIrJson);
    if (!ir) { console.log('replayIrJson: NULL/unparseable'); return; }
    console.log('replayIrJson keys:', Object.keys(ir).join(', '));
    console.log('hasPrecision:', ir.hasPrecision === true);
    console.log('precisionSummary:', JSON.stringify(ir.precisionSummary || null));
    const recs = Array.isArray(ir.precisionRecords) ? ir.precisionRecords : [];
    console.log('precisionRecords:', recs.length);
    recs.forEach((r, i) => {
      const loc = r.codeReadyIntent && r.codeReadyIntent.target;
      const expr = (loc && loc.locator && loc.locator.expression) || (loc && loc.candidateLocator && loc.candidateLocator.expression) || null;
      console.log(`  #${i + 1} ${r.action && r.action.verb}/${r.action && r.action.tool} :: status=${r.certification && r.certification.status} effect=${r.effect && r.effect.kind}(obs=${r.effect && r.effect.observed}) loc=${r.locatorPromotionStatus} resolve=${r.resolveDecision ? r.resolveDecision.decision : 'none'} [${expr || '-'}]`);
    });
    const em = dec(rr.exportMeta);
    console.log('exportMeta.state:', em && (em.state || em.status || JSON.stringify(em).slice(0, 80)));
  } catch (e) { console.log('ERR', e.message); } finally { await p.$disconnect(); }
})();
