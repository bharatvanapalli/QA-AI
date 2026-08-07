'use strict';
const path = require('path'); const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { PrismaClient } = require(path.join(ROOT, 'server', 'node_modules', '@prisma', 'client'));
const p = new PrismaClient();
const PID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

(async () => {
  const run = await p.run.findFirst({ where: { projectId: PID }, orderBy: { startedAt: 'desc' }, select: { id: true } });
  const rr = await p.runResult.findFirst({ where: { runId: run.id, testCase: { name: { contains: 'valid credentials' } } },
    select: { actionGraphJson: true, executionContractJson: true, stepResults: true } });
  for (const field of ['actionGraphJson', 'executionContractJson', 'stepResults']) {
    const v = parse(rr?.[field]);
    if (!v) { console.log(`${field}: (null/unparseable, len=${(rr?.[field]||'').length})`); continue; }
    console.log(`\n========== ${field} ==========`);
    // Find any array of steps/actions/entries and print kernel/gap/codegenLocator
    const arr = Array.isArray(v) ? v : (v.trail || v.actions || v.steps || v.entries || v.graph || null);
    if (Array.isArray(arr)) {
      arr.forEach((e, i) => {
        const kernel = e.actionLocatorKernel || e.kernel || null;
        const gap = e.actionLocatorGap || e.gap || null;
        const cg = e.codegenLocator || null;
        const al = e.actionLocator || null;
        if (/fill|click|type|press/i.test(e.tool || e.action || e.type || '') || kernel || gap || cg) {
          console.log(`  [${i}] tool=${e.tool || e.action || e.type} el="${(e.element || e.elementLabel || e.target || '').toString().slice(0,30)}" ref=${e.ref || e.targetRef || (e.args && (e.args.ref||e.args.target)) || '-'}`);
          if (kernel) console.log(`        kernel.status=${kernel.status} source=${kernel.source}`);
          if (cg) console.log(`        codegenLocator.expr=${(cg.expression || cg.frameworkExpressions?.playwright || '').slice(0,80)} src=${cg.verificationSource}`);
          if (al) console.log(`        actionLocator.expr=${(al.expression || al.frameworkExpressions?.playwright || '').slice(0,80)} verified=${al.verified}`);
          if (gap) console.log(`        GAP: ${gap.type || gap.code} :: ${(gap.detail||'').slice(0,90)}`);
        }
      });
    } else {
      console.log('  top keys:', Object.keys(v));
      console.log(JSON.stringify(v, null, 2).slice(0, 800));
    }
  }
  await p.$disconnect();
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
