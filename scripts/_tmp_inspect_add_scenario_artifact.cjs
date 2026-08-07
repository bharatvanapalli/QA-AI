'use strict';

const { PrismaClient } = require('@prisma/client');
const controlActionAdapter = require('../server/services/controlActionAdapter');

const prisma = new PrismaClient();
const generationId = '9d952135-19af-4626-ae83-696c0796588e';

(async () => {
  const generation = await prisma.scenarioGeneration.findUnique({
    where: { id: generationId },
    select: {
      id: true,
      coveragePlanJson: true,
      scenarios: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          name: true,
          createdAt: true,
          cases: {
            select: {
              id: true,
              name: true,
              sessionMode: true,
              dependsOnIds: true,
              readinessStatus: true,
              readinessReasonsJson: true,
              runEligibility: true,
              failurePolicy: true,
              declaredAssertions: true,
              steps: true,
            },
          },
        },
      },
    },
  });
  const scenarioSummaries = generation.scenarios.map((scenario) => ({
    id: scenario.id,
    name: scenario.name,
    createdAt: scenario.createdAt,
    cases: scenario.cases.map((testCase) => {
      const assertions = JSON.parse(testCase.declaredAssertions || '[]');
      const steps = JSON.parse(testCase.steps || '[]');
      const reasons = JSON.parse(testCase.readinessReasonsJson || '[]');
      return {
        id: testCase.id,
        name: testCase.name,
        sessionMode: testCase.sessionMode,
        dependsOnIds: JSON.parse(testCase.dependsOnIds || '[]'),
        failurePolicy: testCase.failurePolicy,
        readinessStatus: testCase.readinessStatus,
        runEligibility: testCase.runEligibility,
        stepCount: steps.length,
        assertionCount: assertions.length,
        parseFailedCount: assertions.filter((assertion) => assertion.parseFailed === true).length,
        assertionTypes: [...new Set(assertions.map((assertion) => assertion.type))].sort(),
        reasonCodes: reasons.map((reason) => reason.code || reason.reasonCode || reason).filter(Boolean),
        firstSteps: steps.slice(0, 6).map((step) => ({
          ordinal: step.ordinal,
          action: step.action || step.type,
          target: step.target || step.description,
          expected: step.expected || null,
          verify: step.verify || null,
        })),
        controlSteps: steps
          .filter((step) => ['Select', 'Radio', 'Date', 'Time', 'DateTime'].includes(step.action || step.type))
          .map((step) => {
            let adapterError = null;
            let adapterPlan = null;
            try {
              adapterPlan = controlActionAdapter.buildControlActionPlan(step);
            } catch (error) {
              adapterError = error.message;
            }
            return {
              order: step.order || step.ordinal,
              action: step.action || step.type,
              target: step.target || step.element,
              value: Object.prototype.hasOwnProperty.call(step, 'value') ? step.value : null,
              selectionCriteria: step.selectionCriteria || null,
              adapterError,
              adapterPlan: adapterPlan ? {
                variant: adapterPlan.variant,
                postcondition: adapterPlan.postcondition,
                metadata: adapterPlan.metadata,
              } : null,
            };
          }),
      };
    }),
  }));
  process.stdout.write(`${JSON.stringify({
    scenarios: scenarioSummaries,
  }, null, 2)}\n`);
})()
  .finally(() => prisma.$disconnect());
