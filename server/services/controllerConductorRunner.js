'use strict';

const prisma = require('../prisma');
const { encodeJson } = require('./jsonField');
const controllerConductor = require('./agents/controllerConductor');

const RUNNER_VERSION = 'qaai-controller-conductor-runner-v1';

async function runControllerConductorOnce({
  project,
  sprintId = null,
  scenarios,
  plan,
  userId,
  send = () => {},
  cancelToken = null,
  verifierMode = 'deterministic',
  existingRunId = null,
  resumeMode = false,
  generationId = null,
} = {}) {
  if (!project?.id || !userId) {
    throw new TypeError('Controller Conductor runner requires project and user identity.');
  }
  send({
    type: 'agent.phase.start',
    phase: 'conductor',
    label: 'Browser Transaction Controller',
    attempt: 1,
  });
  const agentRun = await prisma.agentRun.create({
    data: {
      projectId: project.id,
      userId,
      phase: 'conductor.controller',
    },
  });
  try {
    const outcome = await controllerConductor.run({
      userId,
      projectId: project.id,
      sprintId,
      scenarios,
      plan,
      framework: project.framework || 'playwright-pom',
      targetUrl: project.targetUrl || process.env.QAAI_TARGET_URL || null,
      send,
      cancelToken,
      projectConfig: project,
      verifierMode,
      existingRunId,
      resumeMode,
      generationId,
    });
    await prisma.agentRun.update({
      where: { id: agentRun.id },
      data: {
        status: outcome.paused ? 'running' : 'complete',
        output: encodeJson({
          runnerVersion: RUNNER_VERSION,
          runId: outcome.runId,
          summary: outcome.summary,
          paused: outcome.paused,
        }),
        completedAt: outcome.paused ? null : new Date(),
      },
    });
    send({
      type: 'agent.phase.complete',
      phase: 'conductor',
      attempt: 1,
      output: {
        runId: outcome.runId,
        summary: outcome.summary,
        paused: outcome.paused,
      },
    });
    return outcome;
  } catch (error) {
    await prisma.agentRun.update({
      where: { id: agentRun.id },
      data: {
        status: 'failed',
        error: String(error?.message || error).slice(0, 4_000),
        completedAt: new Date(),
      },
    }).catch(() => null);
    send({
      type: 'agent.phase.complete',
      phase: 'conductor',
      attempt: 1,
      error: error.message,
    });
    throw error;
  }
}

module.exports = {
  RUNNER_VERSION,
  runControllerConductorOnce,
};
