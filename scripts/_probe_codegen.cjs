const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920';
(async () => {
  const proj = await prisma.project.findUnique({ where: { id: PROJECT }, select: { name:true, targetUrl:true, testCredentials:true, framework:true } });
  console.log('=== PROJECT ===');
  console.log('name:', proj.name, '| framework:', proj.framework, '| targetUrl:', proj.targetUrl);
  console.log('testCredentials:', proj.testCredentials);

  const total = await prisma.knowledgeBaseLocator.count({where:{projectId:PROJECT}});
  const kb = await prisma.knowledgeBaseLocator.findMany({
    where: { projectId: PROJECT },
    orderBy: [{ healthScore: 'desc' }, { occurrences: 'desc' }],
    take: 30,
    select: { element:true, selector:true, strategy:true, role:true, accessibleName:true, intent:true, healthScore:true, pageUrl:true },
  });
  console.log('\n=== KB LOCATORS (top 30 of', total, ') ===');
  for (const r of kb) console.log(JSON.stringify(r));

  const run = await prisma.run.findFirst({ where: { projectId: PROJECT }, orderBy: { startedAt:'desc' }, select:{id:true} });
  const rr = await prisma.runResult.findFirst({ where: { runId: run.id, status:'pass' }, select: { actionTrail:true, testCase:{ select:{ name:true } } } });
  console.log('\n=== SAMPLE actionTrail (run', run.id.slice(0,8), '·', rr?.testCase?.name, ') ===');
  let trail; try { trail = JSON.parse(rr.actionTrail||'[]'); } catch { trail = []; }
  for (const a of trail.slice(0, 16)) console.log(JSON.stringify({ tool:a.tool, args:a.args, ok:a.ok }));
})().catch(e=>console.error(e)).finally(()=>prisma.$disconnect());
