'use strict';

const prisma = require('../server/prisma');
const { runConductorWithRetries, reloadScenariosForFailingCases } = require('../server/services/agents/conductorRunner');

async function triggerLiveRun() {
  console.log('Fetching Odyssey project from database...');
  const project = await prisma.project.findUnique({
    where: { id: '1582559f-364f-4d0e-bfde-fd18832fdaa7' }
  });

  if (!project) {
    console.error('Odyssey project not found in database.');
    process.exit(1);
  }

  console.log(`Found project: ${project.name} (${project.id})`);

  const case1Id = '4af44607-e59b-4cd4-85a2-68dc1e89cdc9';
  const case2Id = 'c7dabb04-0fef-4530-bad8-8c0f6622ed64';
  const testCaseIds = [case1Id, case2Id];

  await prisma.testCase.updateMany({
    where: { id: { in: testCaseIds } },
    data: { status: 'approved' }
  });

  console.log(`Loading scenarios for test cases: ${testCaseIds.join(', ')}...`);
  const scenarios = await reloadScenariosForFailingCases(testCaseIds, project.id);
  console.log(`Loaded ${scenarios.length} scenarios.`);

  const user = await prisma.user.findFirst();
  const userId = user ? user.id : project.userId;

  const send = (msg) => {
    if (msg.message) {
      console.log(`[${msg.phase || 'conductor'}] ${msg.level || 'info'}: ${msg.message}`);
    } else {
      console.log(`[${msg.phase || 'conductor'}] Event: ${msg.type}`);
    }
  };

  console.log('\n=================== STARTING LIVE CONDUCTOR EXECUTION ===================');
  const result = await runConductorWithRetries({
    project,
    scenarios,
    plan: { id: 'live-smoke-plan', name: 'Live Smoke Plan' },
    userId,
    send,
    apiKey: process.env.ANTHROPIC_API_KEY || 'byok',
    model: 'claude-3-5-sonnet-20241022',
    provider: 'anthropic'
  });

  console.log('\n=================== LIVE CONDUCTOR EXECUTION COMPLETED ===================');
}

triggerLiveRun().catch((err) => {
  console.error('Trigger live run error:', err);
  process.exit(1);
});
