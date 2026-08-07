'use strict';

const {
  CONTRACT_VERSION: CASE_CONTRACT_VERSION,
  sanitizeForPersistence,
  tokenName,
} = require('./caseContractV1');
const {
  SCHEMA_VERSION,
  CONTRACT_VERSION,
} = require('./reliability/contracts');

const BRIDGE_VERSION = 1;
const DATA_ALIGNMENT_ERROR = 'CASE_CONTRACT_DATA_ALIGNMENT_REVIEW_REQUIRED';
const INVALID_INPUT_ERROR = 'CASE_CONTRACT_PLANNING_INPUT_INVALID';

class CaseContractPlanningBridgeError extends Error {
  constructor(message, {
    code = INVALID_INPUT_ERROR,
    status = 422,
    findings = [],
  } = {}) {
    super(message);
    this.name = 'CaseContractPlanningBridgeError';
    this.code = code;
    this.status = status;
    this.findings = clone(findings);
  }
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function caseDependenciesFor(caseContract) {
  const session = caseContract && caseContract.sessionRequirement && typeof caseContract.sessionRequirement === 'object'
    ? caseContract.sessionRequirement
    : {};
  const dependencies = [
    ...asArray(caseContract && caseContract.dependencies),
    ...asArray(session.dependsOnCaseRefs),
  ];
  if (['continue_from_case', 'continue_from_dependency'].includes(session.mode) && session.predecessorCaseId) {
    dependencies.push(session.predecessorCaseId);
  }
  return [...new Set(dependencies.map(nonEmpty).filter(Boolean))];
}

function nonEmpty(value) {
  const text = String(value == null ? '' : value).trim();
  return text || null;
}

function normalizeItemType(value) {
  return String(value == null ? '' : value)
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
}

function isDataBoundItem(item) {
  return normalizeItemType(item && item.type) === 'DATA_BOUND';
}

function isBridgeRequiredItem(item) {
  return Boolean(
    item
    && item.caseContractBridge
    && item.caseContractBridge.role === 'required_case',
  );
}

function coverageRefFor(item) {
  return nonEmpty(
    item && (
      item.manifestItemId
      || item.coverageRef
      || item.coverageItemId
      || item.id
    ),
  );
}

function packCoverageRef(pack) {
  return nonEmpty(
    pack && (
      pack.coverageRef
      || pack.manifestItemId
      || pack.coverageItemId
    ),
  );
}

function resolveEnvelope(input = {}) {
  const candidates = [
    input.proceduralFlowContract && input.proceduralFlowContract.caseContractV1,
    input.caseContractEnvelope,
    input.caseContractV1,
    input.caseContract,
    input.proceduralFlowContract,
  ];
  const envelope = candidates.find((candidate) => (
    candidate
    && typeof candidate === 'object'
    && Array.isArray(candidate.cases)
  ));

  if (!envelope || envelope.version !== CASE_CONTRACT_VERSION || !envelope.cases.length) {
    throw new CaseContractPlanningBridgeError(
      'A non-empty CaseContractV1 envelope is required before planning coverage or steps.',
      {
        findings: [{
          expectedVersion: CASE_CONTRACT_VERSION,
          receivedVersion: envelope && envelope.version || null,
          caseCount: envelope && Array.isArray(envelope.cases) ? envelope.cases.length : 0,
        }],
      },
    );
  }

  const duplicateIds = [];
  const seen = new Set();
  envelope.cases.forEach((caseContract, index) => {
    const id = nonEmpty(caseContract && caseContract.id);
    if (!id || seen.has(id)) duplicateIds.push({ index, id });
    if (id) seen.add(id);
  });
  if (duplicateIds.length) {
    throw new CaseContractPlanningBridgeError(
      'Every CaseContractV1 case must have a unique stable id before planning.',
      { findings: duplicateIds },
    );
  }

  return sanitizeForPersistence(envelope);
}

function dataAlignmentError({ caseCount, dataBoundItemCount, reason, coverageRefs = [] }) {
  return new CaseContractPlanningBridgeError(
    'Uploaded test data cannot be assigned to authored cases without guessing. Review the case-to-data alignment.',
    {
      code: DATA_ALIGNMENT_ERROR,
      status: 422,
      findings: [{
        reason,
        caseCount,
        dataBoundItemCount,
        coverageRefs,
      }],
    },
  );
}

function resolveDataInheritance({ cases, originalItems, existingPacks }) {
  const dataItems = originalItems.filter(isDataBoundItem);
  if (dataItems.length > 1) {
    throw dataAlignmentError({
      caseCount: cases.length,
      dataBoundItemCount: dataItems.length,
      reason: 'multiple_data_bound_items',
      coverageRefs: dataItems.map(coverageRefFor),
    });
  }
  if (dataItems.length === 1 && cases.length !== 1) {
    throw dataAlignmentError({
      caseCount: cases.length,
      dataBoundItemCount: 1,
      reason: 'case_data_cardinality_is_not_one_to_one',
      coverageRefs: dataItems.map(coverageRefFor),
    });
  }
  if (!dataItems.length) return null;

  const item = dataItems[0];
  const sourceCoverageRef = coverageRefFor(item);
  const matchingPacks = sourceCoverageRef
    ? existingPacks.filter((pack) => packCoverageRef(pack) === sourceCoverageRef)
    : [];
  if (matchingPacks.length > 1) {
    throw dataAlignmentError({
      caseCount: cases.length,
      dataBoundItemCount: 1,
      reason: 'multiple_exact_row_intents_for_data_item',
      coverageRefs: [sourceCoverageRef],
    });
  }

  const dataSource = clone(item.dataSource || null);
  const rowIntent = matchingPacks.length === 1 && matchingPacks[0].rowIntent
    ? clone(matchingPacks[0].rowIntent)
    : {
      sheet: dataSource && dataSource.sheet || null,
      rowSelector: dataSource && dataSource.rowSelector || null,
      rowIds: clone(
        dataSource && (
          asArray(dataSource.rowIds).length
            ? dataSource.rowIds
            : dataSource.rows
        ) || [],
      ),
      rowSource: dataSource && (
        asArray(dataSource.rowIds).length || asArray(dataSource.rows).length
      ) ? 'coverage_manifest' : 'needs_mapping',
    };

  return {
    sourceCoverageRef,
    dataSource,
    rowIntent,
    alignmentRef: clone(item.alignmentRef || null),
  };
}

function orderedDataRefs(caseContract) {
  const refs = [];
  const seen = new Set();
  const sources = [
    ...asArray(caseContract.steps),
    ...asArray(caseContract.assertions),
  ];
  for (const source of sources) {
    for (const ref of asArray(source && source.dataRefs)) {
      const cleanRef = nonEmpty(ref);
      if (!cleanRef || seen.has(cleanRef)) continue;
      seen.add(cleanRef);
      refs.push(cleanRef);
    }
  }
  return refs;
}

function bindingName(binding, dataRef) {
  return nonEmpty(binding && (binding.name || binding.label))
    || nonEmpty(String(dataRef || '').replace(/^data\./i, ''));
}

function dataContractFor(caseContract) {
  const bindings = asArray(caseContract.dataBindings);
  const bindingById = new Map(
    bindings
      .filter((binding) => binding && binding.id)
      .map((binding) => [String(binding.id), binding]),
  );
  const dataRefs = orderedDataRefs(caseContract);
  const requiredFields = [];
  const semanticTokenMap = {};
  const dataReferenceMap = {};

  for (const dataRef of dataRefs) {
    const binding = bindingById.get(dataRef);
    const name = bindingName(binding, dataRef);
    if (!name) continue;
    if (!requiredFields.includes(name)) requiredFields.push(name);
    const normalizedToken = tokenName(name);
    const token = normalizedToken ? `{{${normalizedToken}}}` : null;
    if (token && !semanticTokenMap[name]) semanticTokenMap[name] = token;
    dataReferenceMap[dataRef] = {
      name,
      token,
      classification: binding && binding.classification || 'normal',
      source: clone(binding && binding.source || null),
    };
  }

  return {
    requiredDataRefs: dataRefs,
    requiredFields,
    dataBindings: clone(bindings),
    dataRows: clone(asArray(caseContract.dataRows)),
    unusedDataRefs: clone(asArray(caseContract.unusedDataRefs)),
    semanticTokenMap,
    semanticTokens: clone(semanticTokenMap),
    dataReferenceMap,
  };
}

function assertionKind(type) {
  const byType = {
    AssertUrl: 'url',
    AssertText: 'text',
    AssertNumber: 'number',
    AssertVisible: 'visible',
    AssertHidden: 'hidden',
  };
  if (byType[type]) return byType[type];
  return String(type || 'assertion')
    .replace(/^Assert/i, '')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase() || 'assertion';
}

function hasOwn(record, key) {
  return Boolean(record && Object.prototype.hasOwnProperty.call(record, key));
}

function assertionTarget(assertion, kind, fallbackText) {
  if (hasOwn(assertion, 'target') && assertion.target != null && assertion.target !== '') {
    return clone(assertion.target);
  }
  const identity = assertion && assertion.targetIdentity;
  if (identity && typeof identity === 'object') {
    for (const key of ['label', 'accessibleName', 'name', 'text', 'testId']) {
      const value = nonEmpty(identity[key]);
      if (value) return value;
    }
  }
  return kind === 'url' ? 'url' : fallbackText;
}

function assertionExpected(assertion, kind, fallbackText) {
  for (const key of ['expected', 'expectedItems', 'expectedValues', 'expectedState', 'operands']) {
    if (hasOwn(assertion, key)) return clone(assertion[key]);
  }
  const payload = assertion && assertion.payload;
  if (payload && typeof payload === 'object') {
    for (const key of [
      'expectedUrlPattern', 'expectedUrl', 'expectedText', 'expectedNumber',
      'expectedDate', 'expectedTime', 'expectedDateTime', 'expectedValue',
      'expectedItems', 'expectedValues', 'expectedCount', 'expected',
    ]) {
      if (hasOwn(payload, key)) return clone(payload[key]);
    }
    const expectedOperand = asArray(payload.operands).find((operand) => operand && operand.role === 'expected');
    if (expectedOperand) {
      for (const key of ['value', 'items', 'ref', 'property']) {
        if (hasOwn(expectedOperand, key)) return clone(expectedOperand[key]);
      }
    }
    if (nonEmpty(payload.channel)) return null;
  }
  return kind === 'visible' || kind === 'hidden' ? true : fallbackText;
}

function assertionPayload(assertion) {
  const payload = assertion && assertion.payload && typeof assertion.payload === 'object'
    ? clone(assertion.payload)
    : {};
  for (const key of [
    'expectedItems', 'expectedValues', 'orderMatters', 'allowAdditionalItems',
    'operands', 'relation', 'unit', 'tolerance', 'attribute', 'attributeName',
  ]) {
    if (hasOwn(assertion, key) && !hasOwn(payload, key)) payload[key] = clone(assertion[key]);
  }
  return payload;
}

function oracleFromAssertion(assertion, index) {
  const type = assertion && assertion.type || 'Assertion';
  const kind = nonEmpty(assertion && (
    assertion.kind
    || assertion.channel
  )) || assertionKind(type) || nonEmpty(assertion && assertion.payload && assertion.payload.channel);
  const text = nonEmpty(assertion && assertion.text) || type;
  const dataRefs = clone(asArray(assertion && assertion.dataRefs));
  const target = assertionTarget(assertion, kind, text);
  const expected = assertionExpected(assertion, kind, text);
  const oracle = {
    schemaVersion: SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    id: nonEmpty(assertion && assertion.id) || `assertion-${index + 1}`,
    assertionId: nonEmpty(assertion && assertion.id) || null,
    assertionType: type,
    ordinal: Number.isFinite(Number(assertion && assertion.ordinal))
      ? Number(assertion.ordinal)
      : index + 1,
    stepId: nonEmpty(assertion && assertion.stepId),
    kind,
    target,
    targetIdentity: clone(assertion && assertion.targetIdentity || null),
    expected,
    comparator: nonEmpty(assertion && assertion.comparator),
    payload: assertionPayload(assertion),
    expectedItems: clone(assertion && assertion.expectedItems),
    expectedValues: clone(assertion && assertion.expectedValues),
    orderMatters: assertion && assertion.orderMatters === true,
    operands: clone(assertion && assertion.operands),
    relation: nonEmpty(assertion && assertion.relation),
    plannedText: text,
    sourceQuote: nonEmpty(assertion && assertion.sourceQuote),
    sourceSpan: clone(assertion && assertion.sourceSpan || null),
    sourceClauseRefs: clone(asArray(assertion && assertion.sourceClauseRefs)),
    failureBehavior: nonEmpty(assertion && assertion.failureBehavior),
    dataRefs,
    source: 'case_contract_v1',
    required: assertion && assertion.required === false ? false : true,
  };
  if (dataRefs.length === 1) {
    oracle.token = tokenName(dataRefs[0].replace(/^data\./i, ''));
  }
  return oracle;
}

function assertionsFor(caseContract) {
  if (asArray(caseContract.assertions).length) return asArray(caseContract.assertions);
  return asArray(caseContract.steps).filter((step) => /^Assert/i.test(step && step.type || ''));
}

function stepContractFor(caseContract) {
  const steps = asArray(caseContract.steps);
  const actionSteps = steps.filter((step) => !/^Assert/i.test(step && step.type || ''));
  const stepDependencies = steps.map((step, index) => ({
    stepId: nonEmpty(step && step.id) || `step-${index + 1}`,
    ordinal: Number.isFinite(Number(step && step.ordinal)) ? Number(step.ordinal) : index + 1,
    dependsOn: clone(asArray(step && step.dependsOn)),
    flowImpact: nonEmpty(step && step.flowImpact),
  }));
  const stepFailureBehavior = steps.map((step, index) => ({
    stepId: nonEmpty(step && step.id) || `step-${index + 1}`,
    ordinal: Number.isFinite(Number(step && step.ordinal)) ? Number(step.ordinal) : index + 1,
    failureBehavior: nonEmpty(step && step.failureBehavior) || 'continue',
  }));

  return {
    requiredActions: actionSteps.map((step) => step.type),
    requiredActionSteps: clone(actionSteps),
    stepDependencies,
    stepFailureBehavior,
    dependencyGraph: Object.fromEntries(
      stepDependencies.map((entry) => [entry.stepId, clone(entry.dependsOn)]),
    ),
    failureBehavior: Object.fromEntries(
      stepFailureBehavior.map((entry) => [entry.stepId, entry.failureBehavior]),
    ),
  };
}

function buildCaseProjection(caseContract, index, dataInheritance, sourceDigest) {
  const sanitizedCase = sanitizeForPersistence(caseContract);
  const coverageRef = `case-contract::${sanitizedCase.id}`;
  const stepContract = stepContractFor(sanitizedCase);
  const dataContract = dataContractFor(sanitizedCase);
  const requiredOracles = assertionsFor(sanitizedCase).map(oracleFromAssertion);
  const dataSource = dataInheritance ? clone(dataInheritance.dataSource) : null;
  const alignmentRef = dataInheritance ? clone(dataInheritance.alignmentRef) : null;
  const rowIntent = dataInheritance
    ? clone(dataInheritance.rowIntent)
    : {
      sheet: null,
      rowSelector: null,
      rowIds: [],
      rowSource: 'inline_or_no_data',
    };
  const storyRef = {
    id: nonEmpty(sanitizedCase.externalId) || sanitizedCase.id,
    title: nonEmpty(sanitizedCase.name) || sanitizedCase.id,
    source: 'case_contract_v1',
    moduleHint: nonEmpty(sanitizedCase.module),
  };
  const bridgeMetadata = {
    version: BRIDGE_VERSION,
    role: 'required_case',
    caseId: sanitizedCase.id,
    caseOrdinal: index + 1,
    authoredScenarioId: nonEmpty(sanitizedCase.authoredScenario && sanitizedCase.authoredScenario.id),
    authoredScenarioOrdinal: sanitizedCase.authoredScenario
      && Number.isFinite(Number(sanitizedCase.authoredScenario.ordinal))
      ? Number(sanitizedCase.authoredScenario.ordinal)
      : null,
    sourceDigest: sourceDigest || null,
    inheritedDataCoverageRef: dataInheritance && dataInheritance.sourceCoverageRef || null,
  };
  const caseDependencies = caseDependenciesFor(sanitizedCase);

  const coverageItem = {
    manifestItemId: coverageRef,
    priority: 1,
    type: dataInheritance ? 'DATA_BOUND' : 'STANDARD',
    required: true,
    advisory: false,
    confidence: 'exact',
    storyRef,
    dataSource,
    alignmentRef,
    requiredCoverage: {
      kind: 'case_contract_v1',
      caseId: sanitizedCase.id,
      stepCount: asArray(sanitizedCase.steps).length,
      actionCount: stepContract.requiredActions.length,
      assertionCount: requiredOracles.length,
    },
    strategy: 'Preserve the authored CaseContractV1 topology, data references, dependencies, and assertions exactly.',
    requiredFields: clone(dataContract.requiredFields),
    requiredActions: clone(stepContract.requiredActions),
    requiredOracles: clone(requiredOracles),
    initialState: clone(sanitizedCase.initialState || null),
    expectedFinalState: clone(sanitizedCase.expectedFinalState || null),
    authoredScenario: clone(sanitizedCase.authoredScenario || null),
    sessionRequirement: clone(sanitizedCase.sessionRequirement || null),
    dependencies: clone(caseDependencies),
    failurePolicy: clone(sanitizedCase.failurePolicy || null),
    caseContractBridge: bridgeMetadata,
  };

  const pack = {
    schemaVersion: SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    coverageRef,
    type: dataInheritance ? 'data_bound' : 'case_contract_v1',
    required: true,
    advisory: false,
    aliases: [],
    storyId: storyRef.id,
    module: storyRef.moduleHint,
    title: storyRef.title,
    pageIntent: nonEmpty(sanitizedCase.intent) || storyRef.title,
    initialState: clone(sanitizedCase.initialState || null),
    expectedFinalState: clone(sanitizedCase.expectedFinalState || null),
    authoredScenario: clone(sanitizedCase.authoredScenario || null),
    sessionRequirement: clone(sanitizedCase.sessionRequirement || null),
    dependencies: clone(caseDependencies),
    caseDependencies: clone(caseDependencies),
    failurePolicy: clone(sanitizedCase.failurePolicy || null),
    ...stepContract,
    ...dataContract,
    dataSource,
    alignmentRef,
    rowIntent,
    rowIntents: rowIntent && rowIntent.rowSelector ? [rowIntent.rowSelector] : [],
    requiredOracle: requiredOracles[0] || null,
    requiredOracles,
    allowedPages: [],
    allowedCapabilities: [],
    authPreconditions: [],
    capabilityHints: [],
    caseContractV1: sanitizedCase,
    caseContractBridge: bridgeMetadata,
  };

  return { coverageItem, pack };
}

function advisoryProjection(item) {
  return {
    ...clone(item),
    required: false,
    advisory: true,
    caseContractBridge: {
      ...clone(item && item.caseContractBridge || {}),
      version: BRIDGE_VERSION,
      role: 'advisory_source',
      reason: 'case_contract_v1_is_authoritative',
    },
  };
}

function buildCaseContractPlanningBridge(input = {}) {
  const envelope = resolveEnvelope(input);
  const currentManifest = input.coverageManifest && typeof input.coverageManifest === 'object'
    ? input.coverageManifest
    : input.manifest && typeof input.manifest === 'object'
      ? input.manifest
      : {};
  const existingPacks = asArray(input.caseContractPacks || input.existingCaseContractPacks);
  const originalItems = asArray(currentManifest.items)
    .filter((item) => !isBridgeRequiredItem(item))
    .map(clone);
  const dataInheritance = resolveDataInheritance({
    cases: envelope.cases,
    originalItems,
    existingPacks,
  });
  const sourceDigest = nonEmpty(envelope.source && envelope.source.digest);
  const projections = envelope.cases.map((caseContract, index) => buildCaseProjection(
    caseContract,
    index,
    dataInheritance,
    sourceDigest,
  ));
  const advisoryItems = originalItems.map(advisoryProjection);
  const items = [
    ...projections.map((projection) => projection.coverageItem),
    ...advisoryItems,
  ];

  const coverageManifest = {
    ...clone(currentManifest),
    sourceMode: 'case_contract_v1',
    itemCount: items.length,
    requiredCount: projections.length,
    advisoryCount: advisoryItems.length,
    items,
    caseContractBridge: {
      version: BRIDGE_VERSION,
      caseContractVersion: CASE_CONTRACT_VERSION,
      sourceDigest: sourceDigest || null,
      requiredCaseCount: projections.length,
      advisorySourceItemCount: advisoryItems.length,
      dataAlignment: dataInheritance
        ? {
          mode: 'one_case_one_data_bound_item',
          sourceCoverageRef: dataInheritance.sourceCoverageRef,
        }
        : { mode: 'inline_or_no_uploaded_data' },
    },
  };

  return {
    coverageManifest,
    caseContractPacks: projections.map((projection) => projection.pack),
  };
}

module.exports = {
  BRIDGE_VERSION,
  CASE_CONTRACT_DATA_ALIGNMENT_REVIEW_REQUIRED: DATA_ALIGNMENT_ERROR,
  CASE_CONTRACT_PLANNING_INPUT_INVALID: INVALID_INPUT_ERROR,
  CaseContractPlanningBridgeError,
  buildCaseContractPlanningBridge,
  bridgeCaseContractPlanning: buildCaseContractPlanningBridge,
  buildPlanningBridge: buildCaseContractPlanningBridge,
  _private: {
    assertionKind,
    dataContractFor,
    isDataBoundItem,
    oracleFromAssertion,
    resolveDataInheritance,
    resolveEnvelope,
    stepContractFor,
  },
};
