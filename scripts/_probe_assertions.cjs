const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920';
(async () => {
  // find a testCase that has assertions; print the shape
  const tcs = await prisma.testCase.findMany({ where: { projectId: PROJECT }, take: 60, select: { id:true, name:true, assertions:true, declaredAssertions:true } });
  let shown = 0;
  for (const tc of tcs) {
    const a = tc.declaredAssertions || tc.assertions;
    if (!a) continue;
    let parsed; try { parsed = typeof a === 'string' ? JSON.parse(a) : a; } catch { parsed = a; }
    if (!parsed || (Array.isArray(parsed) && parsed.length === 0)) continue;
    console.log('\n--- ', tc.name.slice(0,60), ' ---');
    console.log('field used:', tc.declaredAssertions ? 'declaredAssertions' : 'assertions');
    console.log(JSON.stringify(parsed, null, 1).slice(0, 1400));
    if (++shown >= 2) break;
  }
  if (!shown) console.log('No assertions found on first 60 cases');
})().catch(e=>console.error(e.message)).finally(()=>prisma.$disconnect());
