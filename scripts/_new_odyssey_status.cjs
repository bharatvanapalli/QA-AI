'use strict';

const path = require('path');
const { PrismaClient } = require(path.join(__dirname, '..', 'server', 'node_modules', '@prisma', 'client'));
const db = new PrismaClient();
const PROJECT_ID = '1582559f-364f-4d0e-bfde-fd18832fdaa7';

const decode = (value, fallback = []) => {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};

(async () => {
  const run = await db.run.findFirst({ where: { projectId: PROJECT_ID }, orderBy: { startedAt: 'desc' } });
  if (!run) {
    console.log('NO_RUN');
    return;
  }
  const results = await db.runResult.findMany({
    where: { runId: run.id },
    include: { testCase: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const agentRun = await db.agentRun.findFirst({
    where: { projectId: PROJECT_ID, phase: 'conductor', startedAt: { gte: run.startedAt } },
    orderBy: { startedAt: 'desc' },
  });
  const agentLog = decode(agentRun?.log);
  console.log(JSON.stringify({
    runId: run.id,
    status: run.status,
    passed: run.passed,
    failed: run.failed,
    blocked: run.blocked,
    conductor: agentRun ? {
      status: agentRun.status,
      error: agentRun.error,
      logTail: agentLog.slice(-6).map((entry) => entry?.message || entry),
    } : null,
    results: results.map((result) => {
      const steps = decode(result.stepResults);
      const last = steps.at(-1) || null;
      const nonPassing = steps.filter((step) => !['pass', 'passed', 'success', 'skipped'].includes(
        String(step?.status || '').toLowerCase(),
      ));
      return {
        case: result.testCase?.name,
        status: result.status,
        stepCount: steps.length,
        last: last && {
          index: last.index,
          action: last.action || last.kind || null,
          target: last.target || null,
          status: last.status,
          reason: last.reason || last.error || null,
        },
        error: result.error,
        nonPassing: nonPassing.map((step) => ({
          index: step.index,
          action: step.action || step.kind || null,
          target: step.target || step.element || null,
          status: step.status,
          reason: step.reason || step.error || step.blockedReason || null,
        })),
        temporalSteps: steps
          .filter((step) => [50, 51, 53, 56, 60, 61, 63, 64].includes(Number(step?.index)))
          .map((step) => ({
            index: step.index,
            action: step.action || step.kind || null,
            target: step.controlTarget || step.target || step.element || null,
            plannedText: step.plannedText || null,
            status: step.status,
            actionOutcome: step.actionOutcome || null,
            assertionOutcome: step.assertionOutcome || null,
            continuationOutcome: step.continuationOutcome || null,
            reason: step.executionError || step.executionErrorReason || step.error || null,
            expectedState: step.expectedState || null,
            observedState: step.observedState || null,
            operationCheck: step.operationCheck || null,
            transactionOutcome: step.actionTransaction?.canonicalOutcome || step.actionTransaction?.outcome || null,
            transactionReason: step.actionTransaction?.reason || null,
            transactionKeys: Object.keys(step.actionTransaction || {}),
            resolutions: step.actionTransaction?.diagnostics?.resolutions || null,
            evidence: step.evidence || null,
            dispatchAttempts: step.actionTransaction?.dispatchAttempts || null,
          })),
      };
    }),
  }, null, 2));
})().finally(() => db.$disconnect());
