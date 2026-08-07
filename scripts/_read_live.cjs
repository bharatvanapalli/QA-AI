const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  // Find the most recent run (including currently running)
  const runs = await p.run.findMany({
    orderBy: { startedAt: 'desc' },
    take: 5,
    select: { id: true, status: true, startedAt: true, passed: true, failed: true, blocked: true }
  });

  runs.forEach(r => console.log('RUN', r.id.substring(0,8), '| status:', r.status, '| P/F/B:', r.passed, r.failed, r.blocked, '| at:', r.startedAt));

  const runId = runs[0].id;
  console.log('\nReading run:', runId);

  // Get all results with stepResults
  const results = await p.runResult.findMany({
    where: { runId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, testCaseId: true, status: true, error: true,
      mechanicalVerdictReason: true, agentClaimedVerdict: true, flipDirection: true,
      stepResults: true, richTraceFile: true, assertionCheckResults: true
    }
  });

  console.log('Results so far:', results.length);

  // Print summary
  const counts = {};
  results.forEach(r => counts[r.status] = (counts[r.status]||0)+1);
  console.log('Counts:', JSON.stringify(counts));

  // Find a fail or interesting result with stepResults
  const withSteps = results.filter(r => r.stepResults);
  console.log('With stepResults:', withSteps.length);

  if (withSteps.length > 0) {
    // Prefer a fail or flip
    const interesting = withSteps.find(r => r.status === 'fail' || r.flipDirection) || withSteps[0];
    console.log('\n=== Case', interesting.id.substring(0,8), '| status:', interesting.status, '| agent:', interesting.agentClaimedVerdict, '===');
    console.log('mech:', interesting.mechanicalVerdictReason, '| flip:', interesting.flipDirection);

    const steps = typeof interesting.stepResults === 'string' ? JSON.parse(interesting.stepResults) : interesting.stepResults;
    if (Array.isArray(steps)) {
      console.log('Steps count:', steps.length);
      steps.forEach((s, i) => {
        const keys = Object.keys(s);
        console.log('['+i+'] keys:', keys.join(','));
        console.log('    ', JSON.stringify(s).substring(0, 300));
      });
    } else {
      console.log('stepResults:', JSON.stringify(steps).substring(0, 500));
    }
  }

  // Also check for a richTraceFile
  const withTrace = results.find(r => r.richTraceFile);
  if (withTrace) {
    console.log('\nrichTraceFile:', withTrace.richTraceFile);
  }

  // Print full details for each result
  console.log('\n--- ALL RESULTS ---');
  for (const r of results) {
    const acr = r.assertionCheckResults ? (typeof r.assertionCheckResults === 'string' ? JSON.parse(r.assertionCheckResults) : r.assertionCheckResults) : [];
    console.log('\n[TC:', r.testCaseId.substring(0,8), '] status:', r.status, '| agent:', r.agentClaimedVerdict, '| mech:', r.mechanicalVerdictReason, '| error:', (r.error||'').substring(0,80));
    acr.forEach(a => {
      console.log('  ACR:', a.assertionId?.substring(0,12), '| outcome:', a.outcome, '| crit:', a.criticality, '| reason:', a.reason, '| source:', a.source, '| type:', a.type);
    });
  }
}

main().catch(console.error).finally(() => p.$disconnect());
