'use strict';
const prisma = require('./server/prisma');
(async () => {
  try {
    const cases = await prisma.testCase.findMany({ select: { id: true, name: true, steps: true, assertions: true } });
    for (const tc of cases) {
      console.log('=== ' + tc.name + ' (ID: ' + tc.id + ') ===');
      if (tc.steps) {
        try {
          const st = JSON.parse(tc.steps);
          st.forEach((s, i) => {
            const tgt = typeof s.target === 'object' ? JSON.stringify(s.target) : (s.target || '');
            const tgtId = typeof s.targetIdentity === 'object' ? JSON.stringify(s.targetIdentity) : (s.targetIdentity || '');
            console.log('  Step ' + (i+1) + ': action=' + (s.action || s.type || '?') + ' | target=' + (tgt || tgtId).substring(0, 80) + ' | value=' + String(s.value || '').substring(0, 50) + ' | assert=' + (s.assertionType || '') + '=' + String(s.assertionValue || '').substring(0, 50));
          });
        } catch(e) { console.log('  [parse error]', e.message); }
      } else {
        console.log('  [no steps]');
      }
    }

    // Latest run result
    const results = await prisma.runResult.findMany({
      orderBy: { createdAt: 'desc' },
      take: 2,
      include: { testCase: { select: { name: true } } }
    });
    console.log('\n\n=== LATEST RUN RESULTS ===');
    for (const r of results) {
      console.log('\nResult: ' + r.testCase?.name + ' | status=' + r.status);
      console.log('  Error: ' + String(r.errorMessage || '').substring(0, 300));
      if (r.journal) {
        try {
          const j = JSON.parse(r.journal);
          console.log('  Journal length: ' + j.length);
          j.slice(-8).forEach((e, i) => {
            console.log('    [' + (j.length - 8 + i) + '] ' + JSON.stringify(e).substring(0, 280));
          });
        } catch(_) {}
      }
    }
  } finally {
    await prisma['$disconnect']();
  }
})();
