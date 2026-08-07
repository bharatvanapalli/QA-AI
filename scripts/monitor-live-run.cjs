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

    if (!project || !project.scenarios.length) {
      console.error('Project or scenarios not found!');
      process.exit(1);
    }

    const userId = project.userId;
    const scenarios = project.scenarios;
    const totalCasesCount = scenarios.reduce((a, s) => a + (s.cases?.length || 0), 0);

    console.log(`Starting execution run for project "${project.name}" (${project.id}) with ${scenarios.length} scenarios containing ${totalCasesCount} cases...`);

    // Clean up any stale active runs
    await prisma.run.updateMany({
      where: { projectId: project.id, status: 'running' },
      data: { status: 'cancelled', completedAt: new Date() },
    });

    let activeRunId = null;
    let monitoringInterval = null;
    let runInterrupted = false;

    // Start Conductor in background Promise
    const conductorPromise = controllerConductor.run({
      projectId: project.id,
      userId,
      orgId: project.orgId || null,
      scenarios,
      runMode: 'thorough',
      send: (msg) => {
        if (msg?.type === 'run.counters') {
          console.log(`[EVENT run.counters] Run: ${msg.runId} | Passed: ${msg.passed} | Failed: ${msg.failed} | Blocked: ${msg.blocked}`);
        } else if (msg?.type === 'agent.phase.log') {
          console.log(`[Conductor ${msg.level}] ${msg.message}`);
        }
      },
    });

    // Start live monitoring loop every 2 seconds
    monitoringInterval = setInterval(async () => {
      if (runInterrupted) return;

      try {
        const latestRun = await prisma.run.findFirst({
          where: { projectId: project.id },
          orderBy: { startedAt: 'desc' },
          include: {
            results: {
              include: { testCase: true },
            },
          },
        });

        if (!latestRun) return;
        activeRunId = latestRun.id;

        const results = latestRun.results || [];
        console.log(`[LIVE MONITOR] Run ${latestRun.id.slice(0, 8)} | Status: ${latestRun.status} | Passed: ${latestRun.passed} | Failed: ${latestRun.failed} | Blocked: ${latestRun.blocked} | Executed: ${results.length}/${totalCasesCount}`);

        // Log problematic cases for live action trail without interrupting suite execution
        const problematicResults = results.filter(r => r.status === 'blocked' || r.status === 'fail');
        if (problematicResults.length > 0 && !runInterrupted) {
          problematicResults.forEach((r, idx) => {
            console.log(`[ACTION TRAIL NOTICE] Case "${r.testCase?.name || r.testCaseId}" reported ${r.status}. Mismatch/Reason: ${r.error || r.blockedReason || 'Assertion mismatch — proceeding with remaining steps'}`);
          });
        }

        if (latestRun.status === 'complete' || latestRun.status === 'cancelled') {
          console.log(`\nRUN FINISHED WITH STATUS: ${latestRun.status}`);
          clearInterval(monitoringInterval);
          await prisma.$disconnect();
          process.exit(0);
        }
      } catch (monErr) {
        console.error('Monitoring error:', monErr);
      }
    }, 2000);

    await conductorPromise;
    clearInterval(monitoringInterval);
    await prisma.$disconnect();
  } catch (err) {
    console.error('Execution monitor error:', err);
    process.exit(1);
  }
})();
