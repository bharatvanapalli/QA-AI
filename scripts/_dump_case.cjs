// Raw dump of steps + declaredAssertions JSON for a given S#·C# label.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { buildCaseNumbering } = require('../server/lib/caseNumbering');
const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920';
const GEN = process.env.GEN || 'bd055b74-c9de-448b-b2b4-4f88927f1b9a';
const WANT = (process.argv[2] || 'S2 · C1').replace(/\s+/g, ' ');

(async () => {
  try {
    const scns = await prisma.testScenario.findMany({ where: { projectId: PROJECT, generationId: GEN }, include: { cases: true } });
    const num = buildCaseNumbering(scns);
    let id = null;
    for (const [cid, label] of num.caseLabelById) if (label.replace(/\s+/g, ' ') === WANT) id = cid;
    if (!id) { console.log(`no case ${WANT}`); return; }
    const tc = await prisma.testCase.findUnique({ where: { id } });
    console.log(`${WANT}  "${tc.name}"`);
    console.log('\n── STEPS ──');
    console.log(JSON.stringify(JSON.parse(tc.steps || '[]'), null, 2));
    console.log('\n── declaredAssertions ──');
    console.log(JSON.stringify(JSON.parse(tc.declaredAssertions || '[]'), null, 2));
  } catch (e) { console.error('ERR', e.message); } finally { await prisma.$disconnect(); process.exit(0); }
})();
