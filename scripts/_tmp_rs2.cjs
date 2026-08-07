const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
p.run.findFirst({ where: { id: '2fda1038-bece-43f2-add9-0a7b0817dda3' },
  select: { status: true, passed: true, failed: true, blocked: true, needsHuman: true, completedAt: true }
}).then(r => { console.log(r.status+'|pass='+r.passed+'/24|fail='+r.failed+'|done='+!!r.completedAt); p.$disconnect(); })
.catch(e => { console.error(e.message); p.$disconnect(); });
