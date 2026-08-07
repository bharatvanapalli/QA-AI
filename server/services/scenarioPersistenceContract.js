'use strict';

const { encodeJson } = require('./jsonField');

const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function firstNonBlank(...values) {
  for (const value of values) {
    const normalized = clean(value);
    if (normalized) return normalized;
  }
  return '';
}

class ScenarioPersistenceContractError extends Error {
  constructor(findings = []) {
    super(`Scenario persistence contract failed with ${findings.length} finding(s).`);
    this.name = 'ScenarioPersistenceContractError';
    this.code = 'SCENARIO_PERSISTENCE_CONTRACT_INVALID';
    this.findings = findings;
  }
}

function normalizeScenarioMetadata(scenario = {}, options = {}) {
  const firstCase = Array.isArray(scenario.cases) && scenario.cases[0] && typeof scenario.cases[0] === 'object'
    ? scenario.cases[0]
    : {};
  const name = firstNonBlank(scenario.name, scenario.intent, firstCase.name);
  const findings = [];
  if (!name) {
    findings.push({
      code: 'scenario_name_missing',
      field: 'name',
      message: 'Scenario name is required and could not be derived from name, intent, or the first case.',
    });
  }

  const rawPriority = firstNonBlank(scenario.priority).toUpperCase();
  const priority = PRIORITIES.has(rawPriority) ? rawPriority : 'P1';
  const moduleName = firstNonBlank(
    scenario.module,
    firstCase.module,
    options.defaultModule,
    'Core',
  );
  const category = firstNonBlank(scenario.category, firstCase.category, firstCase.type, 'functional')
    .toLowerCase();
  const rationale = firstNonBlank(
    scenario.rationale,
    scenario.intent,
    name && `Generated scenario: ${name}`,
    'Generated scenario.',
  );
  const source = firstNonBlank(options.source, scenario.source, 'agent').toLowerCase();

  if (findings.length) throw new ScenarioPersistenceContractError(findings);
  return {
    name,
    module: moduleName,
    priority,
    category,
    rationale,
    dependencyOn: encodeJson(scenario.dependencyOn),
    source,
  };
}

function normalizeScenarioPersistenceBatch(scenarios = [], options = {}) {
  const rows = [];
  const findings = [];
  (Array.isArray(scenarios) ? scenarios : []).forEach((scenario, scenarioIndex) => {
    try {
      rows.push({
        scenario,
        metadata: normalizeScenarioMetadata(scenario, options),
      });
    } catch (error) {
      if (!(error instanceof ScenarioPersistenceContractError)) throw error;
      findings.push(...error.findings.map((finding) => ({ ...finding, scenarioIndex })));
    }
  });
  if (findings.length) throw new ScenarioPersistenceContractError(findings);
  return rows;
}

function buildScenarioCreateData({
  scenario,
  metadata,
  projectId,
  generationId = null,
  defaultModule,
  source = 'agent',
} = {}) {
  const normalizedProjectId = clean(projectId);
  if (!normalizedProjectId) {
    throw new ScenarioPersistenceContractError([{
      code: 'scenario_project_missing',
      field: 'project',
      message: 'A project ID is required before a scenario can be persisted.',
    }]);
  }
  const normalized = metadata || normalizeScenarioMetadata(scenario, { defaultModule, source });
  const normalizedGenerationId = clean(generationId);
  return {
    project: { connect: { id: normalizedProjectId } },
    ...(normalizedGenerationId
      ? { generation: { connect: { id: normalizedGenerationId } } }
      : {}),
    ...normalized,
  };
}

module.exports = {
  ScenarioPersistenceContractError,
  normalizeScenarioMetadata,
  normalizeScenarioPersistenceBatch,
  buildScenarioCreateData,
};
