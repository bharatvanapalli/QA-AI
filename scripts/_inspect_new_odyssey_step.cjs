'use strict';

const path = require('path');
const { PrismaClient } = require(path.join(__dirname, '..', 'server', 'node_modules', '@prisma', 'client'));

const db = new PrismaClient();
const PROJECT_ID = '1582559f-364f-4d0e-bfde-fd18832fdaa7';

function decode(value, fallback = []) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function compactResolution(entry = {}) {
  const value = entry?.value || entry?.resolution || entry;
  const semantic = value?.semanticResolution || value;
  const candidate = semantic?.candidate || value?.resolvedCandidate || value?.candidate || null;
  return {
    phase: entry?.phase || entry?.phaseId || entry?.name || null,
    alreadySatisfied: semantic?.alreadySatisfied === true || semantic?.phaseAlreadySatisfied === true,
    deltaMonths: semantic?.deltaMonths ?? null,
    candidate: candidate && {
      ref: candidate.ref || null,
      name: candidate.name || candidate.label || null,
      role: candidate.role || null,
      date: candidate.date || candidate.isoDate || candidate.value || null,
      disabled: candidate.disabled ?? null,
    },
    operations: Array.isArray(semantic?.operations)
      ? semantic.operations.map((operation) => ({
          kind: operation.kind || null,
          repeat: operation.repeat || null,
          candidate: operation.candidate && {
            ref: operation.candidate.ref || null,
            name: operation.candidate.name || operation.candidate.label || null,
            role: operation.candidate.role || null,
            date: operation.candidate.date || operation.candidate.isoDate || operation.candidate.value || null,
          },
        }))
      : [],
  };
}

(async () => {
  const requestedIndex = Number(process.argv[2] || 46);
  const run = await db.run.findFirst({ where: { projectId: PROJECT_ID }, orderBy: { startedAt: 'desc' } });
  const results = await db.runResult.findMany({ where: { runId: run.id }, orderBy: { createdAt: 'asc' } });
  const ownerResult = results.find((result) => decode(result.stepResults).some(
    (candidate) => Number(candidate?.index) === requestedIndex,
  ));
  const steps = decode(ownerResult?.stepResults);
  const step = steps.find((candidate) => Number(candidate?.index) === requestedIndex);
  if (!step) throw new Error(`Step ${requestedIndex} was not found`);
  const transaction = step.actionTransaction || {};
  const diagnostics = step.universalActionDiagnostics || transaction.diagnostics || {};
  const resolutions = diagnostics.resolutions || diagnostics.resolutionHistory || [];
  const temporal = diagnostics.temporalRuntime || diagnostics.temporal || diagnostics.calendar || null;
  const actionGraph = decode(ownerResult?.actionGraphJson, {});
  const graphNodes = actionGraph.nodes || actionGraph.actions || actionGraph.steps || [];
  const graphNode = Array.isArray(graphNodes)
    ? graphNodes.find((node) => Number(node?.sequenceIndex ?? node?.index ?? node?.ordinal) === requestedIndex)
    : null;
  console.log(JSON.stringify({
    runId: run.id,
    index: step.index,
    plannedText: step.plannedText,
    status: step.status,
    executionError: step.executionError || step.executionErrorReason || step.error || null,
    stepKeys: Object.keys(step),
    attempts: (step.attempts || []).map((attempt) => {
      const attemptDiagnostics = attempt.universalActionDiagnostics || {};
      return {
        tool: attempt.tool || null,
        actualOutcome: attempt.actualOutcome || null,
        reason: attempt.reason || null,
        diagnosticsKeys: Object.keys(attemptDiagnostics),
        rawResolutions: attemptDiagnostics.resolutions || [],
        resolutions: (attemptDiagnostics.resolutions || []).map(compactResolution),
        dispatches: attemptDiagnostics.dispatches || [],
        proofs: attemptDiagnostics.proofs || [],
        observations: (attemptDiagnostics.observations || []).map((observation) => ({
          phase: observation.phase || null,
          controlPhaseId: observation.controlPhaseId || null,
          attempt: observation.attempt || null,
          fresh: observation.fresh ?? null,
          source: observation.source || null,
          hasSnapshot: observation.hasSnapshot ?? null,
        })),
      };
    }),
    transaction: {
      canonicalOutcome: transaction.canonicalOutcome || transaction.outcome || null,
      reason: transaction.reason || null,
      dispatchStatus: transaction.dispatchStatus || null,
      dispatchAttempts: (transaction.dispatchAttempts || []).map((attempt) => ({
        phase: attempt.phase || attempt.phaseId || null,
        status: attempt.status || attempt.dispatchStatus || null,
        ok: attempt.ok ?? attempt.result?.ok ?? null,
        reason: attempt.reason || attempt.error || null,
        target: attempt.target || attempt.args?.target || null,
      })),
    },
    diagnosticsKeys: Object.keys(diagnostics),
    resolutions: (Array.isArray(resolutions) ? resolutions : Object.values(resolutions || {})).map(compactResolution),
    temporal,
    observedState: step.observedState || null,
    operationCheck: step.operationCheck || null,
    actionGraphKeys: Object.keys(actionGraph),
    graphNode,
    graphNodeCount: Array.isArray(graphNodes) ? graphNodes.length : 0,
    graphNodeSampleKeys: Array.isArray(graphNodes) && graphNodes[44] ? Object.keys(graphNodes[44]) : [],
    graphNodeSample: Array.isArray(graphNodes) ? graphNodes[44] || null : null,
    graphNodeSummary: Array.isArray(graphNodes) ? graphNodes.slice(35, 50).map((node) => ({
      id: node.id || node.stepId || null,
      sequenceIndex: node.sequenceIndex ?? node.index ?? node.ordinal ?? null,
      action: node.action || node.actionType || node.kind || null,
      target: node.target || node.controlTarget || null,
      status: node.status || node.outcome || null,
    })) : [],
  }, null, 2));
})().finally(() => db.$disconnect());
