'use strict';

const { decodeJson } = require('./jsonField');
const dependencyGraph = require('./dependencyGraph');

function normalizedTokens(values) {
  return new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean));
}

function scenarioDependencies(value) {
  if (Array.isArray(value)) return value;
  return decodeJson(value, []) || [];
}

function findScenarioDeletionBlockers({
  scenarioId,
  scenarioName,
  caseIds = [],
  survivingScenarios = [],
  survivingCases = [],
} = {}) {
  const scenarioTokens = normalizedTokens([scenarioId, scenarioName]);
  const deletedCaseIds = new Set((Array.isArray(caseIds) ? caseIds : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean));

  const scenarioDependents = (Array.isArray(survivingScenarios) ? survivingScenarios : [])
    .filter((candidate) => scenarioDependencies(candidate && candidate.dependencyOn)
      .some((dependency) => scenarioTokens.has(String(dependency || '').trim().toLowerCase())))
    .map((candidate) => ({ id: candidate.id, name: candidate.name || null }));

  const caseDependents = (Array.isArray(survivingCases) ? survivingCases : [])
    .filter((candidate) => dependencyGraph.decodeDeps(candidate && candidate.dependsOnIds)
      .some((dependencyId) => deletedCaseIds.has(String(dependencyId || '').trim())))
    .map((candidate) => ({
      id: candidate.id,
      name: candidate.name || null,
      scenarioId: candidate.scenarioId || null,
    }));

  return {
    blocked: scenarioDependents.length > 0 || caseDependents.length > 0,
    scenarioDependents,
    caseDependents,
  };
}

function scenarioDeletionBlockedError(blockers) {
  const scenarioCount = Array.isArray(blockers && blockers.scenarioDependents)
    ? blockers.scenarioDependents.length
    : 0;
  const caseCount = Array.isArray(blockers && blockers.caseDependents)
    ? blockers.caseDependents.length
    : 0;
  const error = new Error(
    `Cannot delete this scenario because ${scenarioCount} scenario(s) and ${caseCount} case(s) still depend on it. Delete or re-plan those dependents first.`,
  );
  error.code = 'SCENARIO_HAS_DEPENDENTS';
  error.status = 409;
  error.details = blockers;
  return error;
}

module.exports = {
  findScenarioDeletionBlockers,
  scenarioDeletionBlockedError,
};
