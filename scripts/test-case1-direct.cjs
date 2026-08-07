'use strict';
const prisma = require('../server/prisma');
const controllerConductor = require('../server/services/agents/controllerConductor');

(async () => {
  try {
    const project = await prisma.project.findFirst({
      where: { name: { contains: 'letcode' } },
      include: {
        scenarios: {
          include: { cases: true },
        },
      },
    });

    const case1Scenario = project.scenarios.find(s => s.name.includes('Edit Fields') || s.cases.some(c => c.name.includes('Edit Fields')));
    console.log('Running Case 1 Scenario:', case1Scenario.name);

    const result = await controllerConductor.run({
      projectId: project.id,
      userId: project.userId,
      orgId: project.orgId || null,
      scenarios: [case1Scenario],
      runMode: 'thorough',
      send: (msg) => {
        if (msg?.type === 'agent.phase.log') {
          console.log(`[Conductor ${msg.level}] ${msg.message}`);
        } else {
          console.log('[WS MSG]', msg.type, msg.status || '');
        }
      },
    });

    console.log('RUN RESULT:', JSON.stringify(result, null, 2));
    await prisma.$disconnect();
  } catch (err) {
    console.error('Case 1 Error:', err);
    process.exit(1);
  }
})();
