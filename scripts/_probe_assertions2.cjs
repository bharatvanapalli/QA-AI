const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920';
(async () => {
  const tcs = await prisma.testCase.findMany({ where: { projectId: PROJECT }, take: 80, select: { name:true, assertions:true, declaredAssertions:true, steps:true } });
  let withDecl = 0, withAssert = 0, both = 0;
  let sample = null;
  for (const tc of tcs) {
    const d = tc.declaredAssertions, a = tc.assertions;
    const dHas = d && d !== '[]' && d !== 'null';
    const aHas = a && a !== '[]' && a !== 'null';
    if (dHas) withDecl++; if (aHas) withAssert++; if (dHas && aHas) both++;
    if (!sample && dHas) sample = tc;
  }
  console.log('cases sampled:', tcs.length);
  console.log('with declaredAssertions:', withDecl, '| with assertions:', withAssert, '| both:', both);
  if (sample) {
    console.log('\nSAMPLE:', sample.name.slice(0,50));
    console.log('  assertions field      =', JSON.stringify(sample.assertions)?.slice(0,120));
    console.log('  declaredAssertions[0] =', (()=>{try{return JSON.stringify(JSON.parse(sample.declaredAssertions)[0]).slice(0,200)}catch{return '(parse)'}})());
    console.log('  steps field           =', JSON.stringify(sample.steps)?.slice(0,160));
  }
})().catch(e=>console.error(e.message)).finally(()=>prisma.$disconnect());
