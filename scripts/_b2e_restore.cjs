const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const RUN = 'b044ef5c-babd-4611-bcd6-8a7cc4870f61';
const PID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
(async () => {
  try {
    const r = await p.run.update({ where: { id: RUN }, data: { status: 'cancelled', completedAt: new Date() } }).catch((e) => ({ err: e.message }));
    console.log('run ->', r.err ? 'ERR ' + r.err : 'cancelled');
    const u = await p.testCase.updateMany({ where: { projectId: PID, status: 'running' }, data: { status: 'approved' } });
    console.log('cases running->approved:', u.count);
  } catch (e) { console.log('ERR', e.message); } finally { await p.$disconnect(); }
})();
