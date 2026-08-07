'use strict';

const path = require('path');
const harness = require(path.join(__dirname, '..', 'server', 'services', 'universalRuntimeReliabilityHarness'));

async function main() {
  const runCount = Math.max(1, Math.floor(Number(process.env.QAAI_LIVE_RELIABILITY_RUNS) || 5));
  const result = await harness.runLiveBrowserGroupedAcceptance({ runCount });
  const summary = {
    passed: result.passed,
    requiredConsecutive: result.acceptance.requiredConsecutive,
    maxConsecutive: result.acceptance.maxConsecutive,
    runs: result.runs.map((run) => ({
      index: run.index,
      passed: run.benchmarkPassed
        && run.zeroDuplicateStateChangingActions
        && run.sessionIdentityPreserved
        && run.scriptParityPassed,
      zeroDuplicateStateChangingActions: run.zeroDuplicateStateChangingActions,
      sessionIdentityPreserved: run.sessionIdentityPreserved,
      validationContinued: run.validationContinued,
      inboundSelectionEventCount: run.inboundSelectionEventCount,
      freightTermObserved: run.freightTermObserved,
      scriptParityPassed: run.scriptParityPassed,
    })),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
