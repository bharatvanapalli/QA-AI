const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const project = await prisma.project.findFirst({
    where: { name: { contains: 'LetCode' } },
  });
  
  if (!project) {
    console.log('No LetCode project found');
    return;
  }
  
  // Ensure status is approved so conductor can run it
  await prisma.testCase.updateMany({
    where: { projectId: project.id, name: 'LetCode Dialog Flow' },
    data: { status: 'approved' }
  });

  const testCase = await prisma.testCase.findFirst({
    where: { projectId: project.id, name: 'LetCode Dialog Flow' },
  });
  
  if (!testCase) {
    console.log('No LetCode Dialog Flow test case found');
    return;
  }
  
  const user = await prisma.user.findFirst();
  
  console.log('Target Test Case:', testCase.name, 'ID:', testCase.id);
  console.log('Project autoAcceptDialogs:', project.autoAcceptDialogs);
  
  const { runControllerConductorOnce } = require('../server/services/controllerConductorRunner.js');
  
  try {
    const outcome = await runControllerConductorOnce({
      project,
      userId: user ? user.id : project.userId,
      scenarios: [{ cases: [testCase] }]
    });
    console.log('\n=================== CONDUCTOR FINISHED ===================');
    console.log('New Run ID:', outcome.runId);
    
    const runResult = await prisma.runResult.findFirst({
      where: { runId: outcome.runId, testCaseId: testCase.id },
    });
    
    if (runResult) {
      console.log('RunResult Verdict Status:', runResult.status);
      const results = JSON.parse(runResult.stepResults || '[]');
      console.log('Step Results Overview:');
      results.forEach(r => {
         console.log(`Step ${r.index || r.stepId}: ${r.action || r.type} -> Status: ${r.status} ${r.reason ? '(' + r.reason + ')' : ''}`);
      });
    } else {
      console.log('No run result found for this run');
    }
  } catch (err) {
    console.error('Error running conductor:', err);
  } finally {
    await prisma.$disconnect();
  }
}

run();
