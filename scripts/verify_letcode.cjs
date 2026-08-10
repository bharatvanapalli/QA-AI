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
  
  const testCase = await prisma.testCase.findFirst({
    where: { projectId: project.id, status: 'approved' },
  });
  
  if (!testCase) {
    console.log('No approved test cases found in LetCode project');
    return;
  }
  
  const user = await prisma.user.findFirst();
  
  console.log('Test Case:', testCase.name);
  
  const { runControllerConductorOnce } = require('../server/services/controllerConductorRunner.js');
  
  try {
    const outcome = await runControllerConductorOnce({
      project,
      userId: user.id,
      scenarios: [{ cases: [testCase] }]
    });
    console.log('Conductor Finished. Run ID:', outcome.runId);
    
    const runResult = await prisma.runResult.findFirst({
      where: { runId: outcome.runId, testCaseId: testCase.id },
    });
    
    if (runResult && runResult.stepResults) {
      const results = JSON.parse(runResult.stepResults);
      console.log('Step Results Overview:');
      results.forEach(r => {
         console.log(`Step: ${r.stepId} - Result: ${r.status}`);
         if(r.actions) {
            r.actions.forEach(a => {
                console.log(`  Action: ${a.toolName} ${a.actionText || ''} -> ${a.result?.isError ? 'Error' : 'Success'}`);
                if (a.result?.isError && a.result?.content) {
                   console.log(`    Error Details: ${JSON.stringify(a.result.content)}`);
                }
            });
         }
      });
    } else {
      console.log('No run result or step results found');
    }
  } catch (err) {
    console.error('Error running conductor:', err);
  } finally {
    await prisma.$disconnect();
  }
}

run();
