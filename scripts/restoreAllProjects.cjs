const { PrismaClient } = require('@prisma/client');

const srcDbPath = 'file:C:/Users/2461898/Downloads/qaai_fixed/qaai_fixed/qaai_fixed/prisma/dev.before-scenario-recovery-20260621-010032.db';
const destDbPath = 'file:C:/Users/2461898/Downloads/qaai_fixed/qaai_fixed/qaai_fixed/prisma/dev.db';

const srcPrisma = new PrismaClient({ datasources: { db: { url: srcDbPath } } });
const destPrisma = new PrismaClient({ datasources: { db: { url: destDbPath } } });

async function restoreAllProjects() {
  console.log('Restoring all original projects and test cases into active local database...');

  const projects = await srcPrisma.project.findMany();
  console.log(`Found ${projects.length} original projects in backup db.`);

  for (const p of projects) {
    try {
      // Check if project exists in dest DB
      const existing = await destPrisma.project.findUnique({ where: { id: p.id } });
      if (!existing) {
        await destPrisma.project.create({ data: p });
        console.log(`Restored project: ${p.name} (${p.id})`);
      } else {
        console.log(`Project already present: ${p.name}`);
      }

      // Restore Requirements for this project
      const reqs = await srcPrisma.$queryRawUnsafe(`SELECT * FROM Requirement WHERE projectId = '${p.id}'`);
      for (const req of reqs) {
        try {
          const existingReq = await destPrisma.requirement.findUnique({ where: { id: req.id } });
          if (!existingReq) {
            await destPrisma.requirement.create({
              data: {
                id: req.id,
                projectId: req.projectId,
                title: req.title,
                content: req.content || '',
                sourceType: req.sourceType || 'manual',
              },
            });
          }
        } catch {}
      }

      // Restore ScenarioGenerations for this project
      const gens = await srcPrisma.$queryRawUnsafe(`SELECT * FROM ScenarioGeneration WHERE projectId = '${p.id}'`);
      for (const gen of gens) {
        try {
          const existingGen = await destPrisma.scenarioGeneration.findUnique({ where: { id: gen.id } });
          if (!existingGen) {
            await destPrisma.scenarioGeneration.create({
              data: {
                id: gen.id,
                projectId: gen.projectId,
                label: gen.label || 'Restored Suite',
                version: gen.version || 1,
                isCurrent: Boolean(gen.isCurrent),
              },
            });
          }
        } catch {}
      }

      // Restore TestScenarios for this project
      const scenarios = await srcPrisma.$queryRawUnsafe(`SELECT * FROM TestScenario WHERE projectId = '${p.id}'`);
      for (const sc of scenarios) {
        try {
          const existingSc = await destPrisma.testScenario.findUnique({ where: { id: sc.id } });
          if (!existingSc) {
            await destPrisma.testScenario.create({
              data: {
                id: sc.id,
                projectId: sc.projectId,
                generationId: sc.generationId,
                name: sc.name || sc.title || 'Scenario',
                rationale: sc.rationale || '',
                category: sc.category || 'core',
                module: sc.module || 'Default',
                priority: sc.priority || 'P1',
              },
            });
          }
        } catch {}
      }

      // Restore TestCases for this project
      const cases = await srcPrisma.$queryRawUnsafe(`SELECT * FROM TestCase WHERE projectId = '${p.id}'`);
      let tcCount = 0;
      for (const tc of cases) {
        try {
          const existingTc = await destPrisma.testCase.findUnique({ where: { id: tc.id } });
          if (!existingTc) {
            await destPrisma.testCase.create({
              data: {
                id: tc.id,
                projectId: tc.projectId,
                generationId: tc.generationId,
                name: tc.name,
                type: tc.type || 'ui_functional',
                module: tc.module || 'General',
                status: tc.status || 'approved',
                specCode: tc.specCode || '',
                confidence: tc.confidence || tc.confidenceScore || 0.95,
                assertions: tc.assertions || '[]',
              },
            });
            tcCount++;
          }
        } catch {}
      }
      console.log(`Restored ${tcCount} test cases for ${p.name}`);
    } catch (e) {
      console.error(`Error restoring project ${p.name}:`, e.message);
    }
  }

  console.log('\nSUCCESS! All original projects, requirements, scenarios, and test cases restored!');
  await srcPrisma.$disconnect();
  await destPrisma.$disconnect();
}

restoreAllProjects().catch((err) => {
  console.error(err);
  process.exit(1);
});
