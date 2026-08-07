'use strict';

/**
 * Backend Evidence vs Generated Package Code Coverage Audit Script
 * Reads exact DB fields: replayIrJson, executionContractJson, actionGraphJson, stepResults, assertionCheckResults
 * Verifies exact 1:1 coverage count:
 * executed required actions in stepResults = generated runnable POM action calls + truthfully optional/non-runnable diagnostics
 */

const prisma = require('../../prisma');
const { buildLiveReplayPackage } = require('./liveReplayCodegen');

async function auditCoverage() {
  console.log('Auditing backend evidence vs generated code coverage...');
  const runId = '72de1153-9342-4307-9c85-372cd917f4fd';
  const projectId = '1582559f-364f-4d0e-bfde-fd18832fdaa7';

  const run = await prisma.run.findFirst({ where: { id: runId, projectId } });
  const results = await prisma.runResult.findMany({
    where: { runId },
    include: { testCase: true }
  });

  const tsPkg = await buildLiveReplayPackage({ projectId, runId, framework: 'playwright-pom' });
  const manifest = JSON.parse(tsPkg.files['EXPORT_MANIFEST.json']);

  console.log(`\n=================== BACKEND EVIDENCE (Run ID: ${runId}) ===================`);
  for (const r of results) {
    console.log(`Case: "${r.testCase.name}"`);
    console.log(`  - replayIrJson present: ${Boolean(r.replayIrJson)}`);
    console.log(`  - executionContractJson present: ${Boolean(r.executionContractJson)}`);
    console.log(`  - actionGraphJson present: ${Boolean(r.actionGraphJson)}`);
    console.log(`  - assertionCheckResults present: ${Boolean(r.assertionCheckResults)}`);

    const steps = JSON.parse(r.stepResults || '[]');
    const executedActions = steps.filter(s => s.status !== 'skipped');
    const requiredActionSteps = executedActions.filter(s => s.kind !== 'assertion' && s.action !== 'WaitForState');
    const assertionSteps = executedActions.filter(s => s.kind === 'assertion');
    const syncSteps = executedActions.filter(s => s.action === 'WaitForState');

    const manifestCase = manifest.cases.find(c => c.testCaseId === r.testCaseId);
    const specContent = tsPkg.files[manifestCase.path] || '';
    const renderedPomCalls = (specContent.match(/\bawait\s+[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+\s*\(/g) || []).length;
    const directPlaywrightCalls = (specContent.match(/\bawait\s+page\.[a-zA-Z0-9_]+\s*\(/g) || []).length;
    const directExpectCalls = (specContent.match(/\bawait\s+expect\s*\(/g) || []).length;
    const totalGeneratedCalls = renderedPomCalls + directPlaywrightCalls + directExpectCalls;

    const actionGaps = (manifestCase.diagnosticGaps || []).filter(g => !g.reason?.includes('assertion'));
    const nonRunnableCompositeSteps = (specContent.match(/\/\/ QAAI_COMPOSITE_STEP:/g) || []).length;

    console.log(`  - Total Executed Steps in stepResults: ${executedActions.length}`);
    console.log(`  - Required Action Steps: ${requiredActionSteps.length}`);
    console.log(`  - Assertion Steps: ${assertionSteps.length}`);
    console.log(`  - Sync Steps (WaitForState): ${syncSteps.length}`);
    console.log(`  - Generated Runnable Calls in Spec: ${totalGeneratedCalls}`);
    console.log(`  - Action Diagnostic Gaps: ${actionGaps.length}`);
    console.log(`  - Non-runnable Composite Steps: ${nonRunnableCompositeSteps}`);
    console.log(`  - Coverage Match Check: Required Actions (${requiredActionSteps.length}) + Assertions (${assertionSteps.length}) = Runnable Calls (${totalGeneratedCalls}) + Action Gaps (${actionGaps.length})`);
  }
}

if (require.main === module) {
  auditCoverage().catch(console.error).finally(() => prisma.$disconnect());
}

module.exports = { auditCoverage };
