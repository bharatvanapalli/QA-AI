'use strict';

const crypto = require('crypto');

const VERSION = 'CaseInstanceV1';
const SECRET_NAME_RE = /(?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|authorization|cookie|session)/i;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function digest(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function cleanName(value, fallback = 'value') {
  const normalized = String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function isSensitive(name, definition = {}) {
  return definition.sensitive === true
    || definition.classification === 'sensitive'
    || definition.kind === 'credential'
    || SECRET_NAME_RE.test(String(name || ''));
}

function envReference(name, definition = {}) {
  const explicit = definition.environmentReference
    || definition.envReference
    || definition.reference
    || definition.credentialReference;
  if (explicit && /^(?:env|credential):/i.test(String(explicit))) return String(explicit);
  return `env:QAAI_INLINE_${cleanName(name).replace(/[.-]+/g, '_').toUpperCase()}`;
}

function definitionsFromCaseContract(caseContract) {
  const source = caseContract?.inlineData
    || caseContract?.dataDictionary
    || caseContract?.data
    || [];
  if (Array.isArray(source)) {
    return source.reduce((map, item, index) => {
      if (!item || typeof item !== 'object') return map;
      const name = cleanName(item.name || item.key || item.id, `value_${index + 1}`);
      map[name] = { ...item, name };
      return map;
    }, {});
  }
  return Object.entries(source || {}).reduce((map, [name, item]) => {
    map[cleanName(name)] = item && typeof item === 'object'
      ? { ...item, name: cleanName(name) }
      : { name: cleanName(name), value: item };
    return map;
  }, {});
}

function rowValues(dataRow) {
  if (!dataRow || typeof dataRow !== 'object') return {};
  const fields = Array.isArray(dataRow.fields) ? dataRow.fields : null;
  if (fields) {
    return fields.reduce((map, field, index) => {
      if (!field || typeof field !== 'object') return map;
      const name = cleanName(field.name || field.key || field.column || field.id, `value_${index + 1}`);
      map[name] = field.value ?? field.resolvedValue ?? field.rawValue ?? null;
      return map;
    }, {});
  }
  const blockedKeys = new Set(['id', 'rowId', 'rowIndex', 'index', 'name', 'label', 'metadata', 'source']);
  return Object.entries(dataRow).reduce((map, [name, value]) => {
    if (!blockedKeys.has(name) && (value == null || typeof value !== 'object')) map[cleanName(name)] = value;
    return map;
  }, {});
}

function buildBindings(caseContract, dataRow) {
  const definitions = definitionsFromCaseContract(caseContract);
  const values = rowValues(dataRow);
  const names = new Set([...Object.keys(definitions), ...Object.keys(values)]);
  return Array.from(names).sort().map((name) => {
    const definition = definitions[name] || { name };
    const sensitive = isSensitive(name, definition);
    const boundStepIds = definition.boundStepIds
      || definition.stepIds
      || definition.consumedBy
      || (definition.boundStepId ? [definition.boundStepId] : []);
    const consumed = definition.consumed !== false && (boundStepIds.length > 0 || definition.used === true);
    const binding = {
      name,
      classification: sensitive ? 'sensitive' : 'normal',
      reference: sensitive ? envReference(name, definition) : `fixture:${name}`,
      boundStepIds: Array.from(new Set(boundStepIds.map(String))),
      consumed,
    };
    if (!sensitive && Object.prototype.hasOwnProperty.call(values, name)) binding.value = values[name];
    if (sensitive) binding.value = undefined;
    return binding;
  });
}

function contractSteps(caseContract, executionContract) {
  const source = Array.isArray(caseContract?.steps) && caseContract.steps.length
    ? caseContract.steps
    : (executionContract?.nodes || executionContract?.steps || []);
  return source.map((step, index) => {
    const stepId = String(step.stepId || step.id || `step-${index + 1}`);
    const dependencies = step.dependencyStepIds
      || step.dependsOn
      || step.dependencies
      || (step.predecessorStepId ? [step.predecessorStepId] : []);
    return {
      stepId,
      ordinal: Number(step.ordinal || step.index || index + 1),
      dependencyStepIds: Array.from(new Set((Array.isArray(dependencies) ? dependencies : [dependencies]).filter(Boolean).map(String))),
      flowImpact: step.flowImpact || (step.independent ? 'independent' : 'dependent'),
      failureBehavior: step.failureBehavior || step.onFailure || 'stop_descendants',
      boundDataReferences: Array.from(new Set((step.boundDataReferences || step.dataReferences || []).map(String))),
    };
  });
}

function buildCaseInstanceV1({
  testCase,
  caseContract,
  executionContract,
  generationId,
  dataRow,
  dataRowIndex = 0,
  credentialProfileRef = null,
} = {}) {
  if (!testCase?.id) throw new Error('CaseInstanceV1 requires an exact testCase.id');
  if (!generationId) throw new Error('CaseInstanceV1 requires an explicit generationId');

  const semanticContract = caseContract || {};
  const steps = contractSteps(semanticContract, executionContract);
  const inlineDataBindings = buildBindings(semanticContract, dataRow);
  const caseRevisionPayload = {
    caseId: testCase.id,
    generationId,
    updatedAt: testCase.updatedAt || null,
    contract: semanticContract,
    executionNodes: executionContract?.nodes || executionContract?.steps || [],
  };
  const initialState = semanticContract.initialState || testCase.preconditions || 'unspecified';
  const expectedFinalState = semanticContract.expectedFinalState
    || semanticContract.finalState
    || testCase.expectedResult
    || 'unspecified';
  const sessionRequirement = semanticContract.sessionRequirement || 'fresh';
  const continuationCaseId = semanticContract.continueFromCaseId
    || semanticContract.sessionPlan?.continueFromCaseId
    || null;

  return {
    version: VERSION,
    instanceId: digest({
      caseId: testCase.id,
      generationId,
      dataRowIndex,
      bindings: inlineDataBindings.map(({ name, reference, value }) => ({ name, reference, value })),
    }),
    generationId: String(generationId),
    caseId: String(testCase.id),
    caseRevision: {
      hash: digest(caseRevisionPayload),
      updatedAt: testCase.updatedAt || null,
    },
    dataRowIndex: Number(dataRowIndex) || 0,
    inlineDataBindings,
    unusedDataReferences: inlineDataBindings.filter((binding) => !binding.consumed).map((binding) => binding.reference),
    authProfileRef: credentialProfileRef || semanticContract.authProfileRef || null,
    initialState,
    expectedFinalState,
    sessionPlan: {
      requirement: continuationCaseId ? 'continue_from_case' : sessionRequirement,
      continueFromCaseId: continuationCaseId,
      producesAuthenticatedState: Boolean(semanticContract.producesAuthenticatedState),
    },
    stepDependencyGraph: steps,
  };
}

function attachCaseInstanceV1(executionContract, options) {
  const contract = executionContract && typeof executionContract === 'object'
    ? executionContract
    : {};
  return {
    ...contract,
    caseInstanceV1: buildCaseInstanceV1({ ...options, executionContract: contract }),
  };
}

module.exports = {
  VERSION,
  buildCaseInstanceV1,
  attachCaseInstanceV1,
  buildBindings,
  isSensitive,
};
