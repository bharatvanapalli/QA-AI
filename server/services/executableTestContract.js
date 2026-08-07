'use strict';

const crypto = require('crypto');
const actionLocatorResolver = require('./actionLocatorResolver');
const { normaliseOperationCheck } = require('../lib/stepShape');
const executedCaseAst = require('./codegen/executedCaseAst');
const waitContract = require('./waitContract');

const CONTRACT_SCHEMA = 'qaai-executable-test-contract/1';
const ACTION_GRAPH_SCHEMA = 'qaai-certified-action-graph/1';
const CERTIFICATION_SCHEMA = 'qaai-contract-export-certification/1';
const CASE_INSTANCE_SCHEMA = 'CaseInstanceV1';
const SENSITIVE_KEY_RE = /(?:password|passwd|passcode|secret|token|api[_-]?key|access[_-]?key|authorization|credential|private[_-]?key|otp|pin)/i;

const ACTION_WORDS = [
  ['navigate', /\b(open|go to|navigate|load|visit)\b/i],
  ['click', /\b(click|press|tap|select)\b/i],
  ['fill', /\b(fill|type|enter|input|provide)\b/i],
  ['assert', /\b(verify|assert|expect|should|must|validate|confirm|check)\b/i],
  ['wait', /\b(wait|appear|display|visible|shown)\b/i],
];

const REPAIR_CATEGORIES = new Set([
  'missing_locator_recipe',
  'unscoped_locator',
  'hidden_target_missing_trigger',
  'missing_data_binding',
  'assertion_contract_defect',
  'assertion_translation_gap',
  'page_method_missing',
  'step_parity_gap',
]);

function clean(value, limit = 260) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return limit && text.length > limit ? text.slice(0, limit) : text;
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch (_) { return fallback; }
}

function cloneValue(value) {
  if (value == null) return value;
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch (_) { /* fall through */ }
  }
  try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 16);
}

function sensitiveName(value) {
  return SENSITIVE_KEY_RE.test(String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2'));
}

function publicBinding(value, key = '') {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (sensitiveName(key)) {
    const descriptor = value && typeof value === 'object' ? value : {};
    const source = descriptor.source && typeof descriptor.source === 'object' ? descriptor.source : {};
    const explicitName = clean(
      source.name
      || descriptor.envName
      || descriptor.environmentRef
      || descriptor.envRef
      || (String(descriptor.kind || '').toLowerCase() === 'environment' ? descriptor.name : '')
      || '',
      120,
    );
    const normalizedName = clean(explicitName || key || 'VALUE', 120)
      .replace(/^env:/i, '')
      .replace(/[^A-Za-z0-9_]+/g, '_')
      .toUpperCase();
    return {
      kind: 'environment',
      name: explicitName ? normalizedName : `QAAI_INLINE_${normalizedName}`,
      sensitive: true,
    };
  }
  if (typeof value === 'string') return clean(value, 1000);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => publicBinding(item, key));
  if (typeof value !== 'object') return clean(value, 300);
  const classification = String(value.classification || value.kind || '').toLowerCase();
  const sensitive = value.sensitive === true || /sensitive|secret|credential/.test(classification) || sensitiveName(value.name || value.label || key);
  if (sensitive) {
    const source = value.source && typeof value.source === 'object' ? value.source : {};
    const explicitName = clean(value.envName || value.environmentRef || value.envRef || source.name || '', 120);
    const normalizedName = clean(explicitName || value.name || key || 'VALUE', 120)
      .replace(/^env:/i, '')
      .replace(/[^A-Za-z0-9_]+/g, '_')
      .toUpperCase();
    return { kind: 'environment', name: explicitName ? normalizedName : `QAAI_INLINE_${normalizedName}`, sensitive: true };
  }
  const out = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, 100)) {
    out[childKey] = publicBinding(childValue, childKey);
  }
  return out;
}

function caseContractFrom(testCase) {
  const quality = parseJson(testCase && testCase.qualityContractJson, {}) || {};
  return quality.caseContractV1 && typeof quality.caseContractV1 === 'object'
    ? quality.caseContractV1
    : null;
}

function compiledCaseRevisionFrom(testCase) {
  const quality = parseJson(testCase && testCase.qualityContractJson, {}) || {};
  const qualityLineage = quality.testDesignPlan && typeof quality.testDesignPlan === 'object'
    ? quality.testDesignPlan
    : {};
  const persistedLineage = parseJson(testCase && testCase.testDesignPlanRef, {}) || {};
  return clean(
    testCase && testCase.compiledCaseRevision
    || qualityLineage.compiledCaseRevision
    || persistedLineage.compiledCaseRevision
    || '',
    200,
  ) || null;
}

function generationIdFrom(testCase) {
  return testCase && (
    testCase.generationId
    || testCase.scenario && testCase.scenario.generationId
    || testCase.testScenario && testCase.testScenario.generationId
  ) || null;
}

function contractIdentityError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  error.details = details;
  return error;
}

function recordIdentityValues(record, collection = 'steps') {
  if (!record || typeof record !== 'object') return [];
  const values = collection === 'assertions'
    ? [record.assertionId, record.id, record.planAssertionId, record.contractAssertionId]
    : [record.stepId, record.id, record.planStepId, record.contractStepId, record.sourceContractStepId];
  return [...new Set(values
    .filter((value) => value !== null && value !== undefined && String(value).trim())
    .map(String))];
}

function assertionStepRelationValues(record) {
  if (!record || typeof record !== 'object') return [];
  return [...new Set([record.stepId, record.planStepId]
    .filter((value) => value !== null && value !== undefined && String(value).trim())
    .map(String))];
}

function nodeStepIdentityValues(node) {
  const raw = node && node.raw && typeof node.raw === 'object' ? node.raw : {};
  return [...new Set([
    node && node.persistedStepId,
    node && node.stepId,
    raw.stepId,
    raw.id,
    raw.planStepId,
    raw.contractStepId,
    raw.sourceContractStepId,
  ].filter((value) => value !== null && value !== undefined && String(value).trim()).map(String))];
}

function nodeAssertionIdentityValues(node) {
  const raw = node && node.raw && typeof node.raw === 'object' ? node.raw : {};
  const assertionContract = node && node.assertionContract && typeof node.assertionContract === 'object'
    ? node.assertionContract
    : {};
  return [...new Set([
    node && node.persistedAssertionId,
    node && node.assertionId,
    node && node.oracleRef,
    assertionContract.assertionId,
    raw.assertionId,
    raw.oracleRef,
    raw.planAssertionId,
  ].filter((value) => value !== null && value !== undefined && String(value).trim()).map(String))];
}

function linkedCaseContractNode(node, authored, linkedAssertion = null) {
  const dataRefs = Array.isArray(authored.dataRefs) ? authored.dataRefs.map(String) : [];
  return {
    ...node,
    caseContractStepId: authored.stepId || authored.id || authored.assertionId || null,
    caseContractAssertionId: linkedAssertion
      ? linkedAssertion.assertionId || linkedAssertion.id || null
      : authored.assertionId || null,
    dependencies: Array.isArray(authored.dependsOn) ? authored.dependsOn.map(String) : [],
    flowImpact: authored.flowImpact || null,
    failureBehavior: authored.failureBehavior || null,
    typedStep: authored.type || null,
    dataRefs,
    dataBinding: dataRefs.length
      ? { isDataBound: true, refs: dataRefs }
      : node.dataBinding,
  };
}

function linkCaseContractNodes(nodes, caseContract, { strictIdentity = false } = {}) {
  if (!caseContract || typeof caseContract !== 'object') return nodes;
  const authoredSteps = Array.isArray(caseContract.steps) ? caseContract.steps : [];
  const authoredAssertions = Array.isArray(caseContract.assertions) ? caseContract.assertions : [];
  const stepRecords = authoredSteps.map((record, index) => ({
    collection: 'steps',
    index,
    record,
    identities: recordIdentityValues(record, 'steps'),
    relations: [],
  }));
  const assertionRecords = authoredAssertions.map((record, index) => ({
    collection: 'assertions',
    index,
    record,
    identities: recordIdentityValues(record, 'assertions'),
    relations: assertionStepRelationValues(record),
  }));
  const authoredRecords = [...stepRecords, ...assertionRecords];
  const hasAuthoredIdentities = authoredRecords.some((entry) => entry.identities.length);
  const usedAuthored = new Set();
  const lastIndex = { steps: -1, assertions: -1 };
  let actionIndex = 0;
  let assertionIndex = 0;
  const linked = nodes.map((node, nodeIndex) => {
    const stepIdentities = nodeStepIdentityValues(node);
    const assertionIdentities = nodeAssertionIdentityValues(node);
    const exactSteps = stepIdentities.length
      ? stepRecords.filter((entry) => entry.identities.some((identity) => stepIdentities.includes(identity)))
      : [];
    const exactAssertions = assertionIdentities.length
      ? assertionRecords.filter((entry) => entry.identities.some((identity) => assertionIdentities.includes(identity)))
      : [];
    const relatedAssertions = node.kind === 'assertion' && stepIdentities.length
      ? assertionRecords.filter((entry) => entry.relations.some((identity) => stepIdentities.includes(identity)))
      : [];
    // Persisted browser steps always bind to the immutable CaseContract step first.
    // A linked assertion's stepId is a relationship, never a competing identity.
    const exact = exactSteps.length
      ? exactSteps
      : exactAssertions.length
        ? exactAssertions
        : relatedAssertions;
    let selected = exact.length === 1 ? exact[0] : null;

    if (strictIdentity && exact.length !== 1) {
      throw contractIdentityError(
        exact.length > 1 ? 'EXECUTION_CONTRACT_IDENTITY_AMBIGUOUS' : 'EXECUTION_CONTRACT_IDENTITY_DRIFT',
        exact.length > 1
          ? 'A persisted execution node matches more than one immutable CaseContract record.'
          : 'A persisted execution node does not match its immutable CaseContract identity.',
        {
          nodeIndex,
          nodeIdentities: { steps: stepIdentities, assertions: assertionIdentities },
          matches: exact.map((entry) => ({ collection: entry.collection, index: entry.index, identities: entry.identities })),
        },
      );
    }

    if (!selected && !strictIdentity) {
      const authored = node.kind === 'assertion'
        ? authoredAssertions[assertionIndex++] || authoredSteps.find((step) => step && step.id === node.caseContractStepId) || null
        : authoredSteps[actionIndex++] || null;
      if (authored) {
        const collection = authoredAssertions.includes(authored) ? 'assertions' : 'steps';
        const index = collection === 'assertions' ? authoredAssertions.indexOf(authored) : authoredSteps.indexOf(authored);
        selected = { collection, index, record: authored, identities: recordIdentityValues(authored, collection) };
      }
    }

    const authored = selected && selected.record;
    if (!authored) return node;
    const authoredKey = `${selected.collection}:${selected.index}`;
    if (strictIdentity && (usedAuthored.has(authoredKey) || selected.index <= lastIndex[selected.collection])) {
      throw contractIdentityError(
        'EXECUTION_CONTRACT_ORDER_DRIFT',
        'Persisted execution node order does not match the immutable CaseContract order.',
        { nodeIndex, collection: selected.collection, authoredIndex: selected.index, previousAuthoredIndex: lastIndex[selected.collection] },
      );
    }
    usedAuthored.add(authoredKey);
    lastIndex[selected.collection] = selected.index;
    let linkedAssertion = null;
    if (selected.collection === 'steps' && node.kind === 'assertion') {
      const selectedStepIdentities = selected.identities;
      const linkedAssertionEntries = assertionRecords.filter((entry) => (
        entry.relations.some((identity) => selectedStepIdentities.includes(identity))
      ));
      if (strictIdentity && linkedAssertionEntries.length > 1) {
        throw contractIdentityError(
          'EXECUTION_CONTRACT_IDENTITY_AMBIGUOUS',
          'An immutable CaseContract step is linked to more than one assertion record.',
          { nodeIndex, stepIdentities: selectedStepIdentities, assertionIndexes: linkedAssertionEntries.map((entry) => entry.index) },
        );
      }
      if (linkedAssertionEntries.length === 1) {
        const assertionEntry = linkedAssertionEntries[0];
        linkedAssertion = assertionEntry.record;
        usedAuthored.add(`assertions:${assertionEntry.index}`);
        lastIndex.assertions = Math.max(lastIndex.assertions, assertionEntry.index);
      }
    }
    return linkedCaseContractNode(node, authored, linkedAssertion);
  });

  if (strictIdentity && hasAuthoredIdentities) {
    const omitted = authoredRecords
      .filter((entry) => entry.identities.length && !usedAuthored.has(`${entry.collection}:${entry.index}`))
      .map((entry) => ({ collection: entry.collection, index: entry.index, identities: entry.identities }));
    if (omitted.length) {
      throw contractIdentityError(
        'EXECUTION_CONTRACT_IDENTITY_DRIFT',
        'One or more immutable CaseContract records are missing from the persisted execution nodes.',
        { omitted },
      );
    }
  }
  return linked;
}

function hydrateInlineInstanceMetadata(dataRow) {
  if (!dataRow || typeof dataRow !== 'object') return dataRow;
  const bridge = dataRow.evidenceContract && dataRow.evidenceContract.kind === 'inline_case_instance_v1'
    ? dataRow.evidenceContract
    : null;
  if (!bridge) return dataRow;
  return {
    ...dataRow,
    rowId: bridge.rowId || dataRow.rowId || null,
    ordinal: Number.isInteger(bridge.ordinal) ? bridge.ordinal : dataRow.ordinal,
    instancePlanId: bridge.instancePlanId || dataRow.instancePlanId || null,
    instanceRevision: bridge.instanceRevision || dataRow.instanceRevision || null,
    inlineRevision: bridge.inlineRevision || dataRow.inlineRevision || null,
    defaultInstanceId: bridge.defaultInstanceId || dataRow.defaultInstanceId || null,
    publicBindings: bridge.publicBindings || dataRow.publicBindings || {},
    inlineInstance: true,
  };
}

function buildCaseInstanceV1({ testCase, caseContract, dataRow, nodes, runId, runResultId }) {
  dataRow = hydrateInlineInstanceMetadata(dataRow);
  const generationId = generationIdFrom(testCase);
  const rowFields = publicBinding(dataRow && (dataRow.fields || dataRow.inputs) || {}, 'fields');
  const rowPublicBindings = publicBinding(dataRow && dataRow.publicBindings || {}, 'publicBindings');
  const instanceInputs = { ...rowFields };
  for (const [name, binding] of Object.entries(rowPublicBindings || {})) {
    instanceInputs[name] = binding;
  }
  const definitions = Array.isArray(caseContract && caseContract.dataBindings)
    ? caseContract.dataBindings
    : [];
  const inlineData = {};
  for (const definition of definitions) {
    if (!definition || !definition.id) continue;
    const source = definition.source && typeof definition.source === 'object' ? definition.source : {};
    const raw = Object.prototype.hasOwnProperty.call(instanceInputs, definition.name)
      ? instanceInputs[definition.name]
      : source;
    inlineData[definition.id] = publicBinding({
      name: definition.name,
      label: definition.label,
      classification: definition.classification || 'normal',
      source: raw,
    }, definition.name || definition.id);
  }
  const definedNames = new Set(definitions.map((definition) => String(definition && definition.name || '')).filter(Boolean));
  for (const [name, binding] of Object.entries(instanceInputs)) {
    if (definedNames.has(name)) continue;
    inlineData[`data.${name}`] = publicBinding({
      name,
      classification: sensitiveName(name) ? 'sensitive' : 'normal',
      source: binding,
    }, name);
  }
  const session = caseContract && caseContract.sessionRequirement || {};
  const authoredSessionMode = clean(session.mode || 'fresh', 80) || 'fresh';
  const persistedSessionMode = clean(testCase && testCase.sessionMode || '', 80);
  const runtimeSessionMode = ['continue_from_dependency', 'shared_scenario', 'setup_only', 'fresh'].includes(persistedSessionMode)
    ? persistedSessionMode
    : authoredSessionMode === 'continue_from_case' || authoredSessionMode === 'continue_from_dependency'
      ? 'continue_from_dependency'
      : 'fresh';
  const authProfileRef = testCase && (
    testCase.authProfileRef
    || testCase.authProfileId
    || testCase.credentialProfileRef
    || testCase.credentialProfileId
  ) || null;
  const persistedCompiledRevision = compiledCaseRevisionFrom(testCase);
  const revisionSource = {
    testCaseId: testCase && testCase.id || null,
    generationId,
    caseContract: caseContract || null,
    steps: parseJson(testCase && testCase.steps, []),
    assertions: parseJson(testCase && testCase.declaredAssertions, []),
  };
  const dataRowId = dataRow
    ? (dataRow.rowId || `${dataRow.setName || 'data'}:${dataRow.index == null ? 'row' : dataRow.index}:${dataRow.label || ''}`)
    : null;
  const instance = {
    version: CASE_INSTANCE_SCHEMA,
    runId: runId || null,
    runResultId: runResultId || null,
    testCaseId: testCase && testCase.id || null,
    generationId,
    caseContractId: caseContract && caseContract.id || null,
    caseRevision: persistedCompiledRevision || `case_revision_${shortHash(stableStringify(revisionSource))}`,
    dataRowId,
    dataRowOrdinal: dataRow && Number.isInteger(dataRow.ordinal) ? dataRow.ordinal : null,
    instancePlanId: dataRow && dataRow.instancePlanId || null,
    instanceRevision: dataRow && dataRow.instanceRevision || null,
    inlineRevision: dataRow && dataRow.inlineRevision || null,
    defaultInstanceId: dataRow && dataRow.defaultInstanceId || null,
    inputs: instanceInputs,
    publicBindings: rowPublicBindings,
    inlineData,
    authProfileRef: authProfileRef ? { id: clean(authProfileRef, 160) } : null,
    initialState: publicBinding(caseContract && caseContract.initialState || null, 'initialState'),
    finalState: publicBinding(caseContract && caseContract.expectedFinalState || null, 'finalState'),
    sessionPlan: {
      mode: runtimeSessionMode,
      authoredMode: authoredSessionMode,
      predecessorCaseRefs: Array.isArray(session.dependsOnCaseRefs)
        ? session.dependsOnCaseRefs.map(String)
        : session.predecessorCaseId ? [String(session.predecessorCaseId)] : [],
      predecessorCaseIds: parseJson(testCase && testCase.dependsOnIds, []) || [],
      producesAuthenticatedState: session.producesAuthenticatedState === true,
    },
    stepDependencyGraph: nodes.map((node) => ({
      stepId: node.caseContractStepId || node.contractStepId,
      dependsOn: Array.isArray(node.dependencies) ? node.dependencies : [],
      failureBehavior: node.failureBehavior || null,
      flowImpact: node.flowImpact || null,
    })),
  };
  return withCaseInstanceId(instance);
}

function caseInstanceIdentity(instance) {
  return {
    runId: instance && instance.runId || null,
    runResultId: instance && instance.runResultId || null,
    testCaseId: instance && instance.testCaseId || null,
    generationId: instance && instance.generationId || null,
    caseRevision: instance && instance.caseRevision || null,
    dataRowId: instance && instance.dataRowId || null,
    instancePlanId: instance && instance.instancePlanId || null,
    instanceRevision: instance && instance.instanceRevision || null,
    inlineRevision: instance && instance.inlineRevision || null,
  };
}

function withCaseInstanceId(instance) {
  return {
    ...instance,
    id: `case_instance_${shortHash(stableStringify(caseInstanceIdentity(instance)))}`,
  };
}

function normalizeStep(raw, index) {
  if (typeof raw === 'string') {
    return { id: `step-${index + 1}`, text: clean(raw), authoredText: raw, raw };
  }
  const step = raw && typeof raw === 'object' ? raw : {};
  const authoredText = [
    step.authoredText,
    step.authored_text,
    step.instruction,
    step.description,
    step.text,
  ].find((value) => typeof value === 'string') || '';
  const text = clean(
    authoredText ||
    step.text || step.step || step.description || step.expected || step.name || step.title ||
    [step.action, step.target || step.element || step.field].filter(Boolean).join(' ')
  ) || `Planned step ${index + 1}`;
  return {
    id: clean(
      step.id || step.stepId || step.plannedStepId || step.contractStepId || step.sourceContractStepId || `step-${index + 1}`,
      180,
    ),
    text,
    authoredText,
    raw: step,
  };
}

function inferKind(step) {
  const raw = step && step.raw && typeof step.raw === 'object' ? step.raw : {};
  if (isVerificationPointRaw(raw)) return 'assertion';
  if (operationCheckForStep(raw)) return 'action';
  const explicit = String(raw.kind || raw.type || raw.action || '').toLowerCase();
  if (/assert|verify|expect|validate/.test(explicit)) return 'assertion';
  if (/precondition|setup/.test(explicit)) return 'precondition';
  if (/wait/.test(explicit)) return 'action';
  const text = step && step.text || '';
  if (ACTION_WORDS.find(([name, re]) => name === 'assert' && re.test(text))) return 'assertion';
  return 'action';
}

function inferActionType(step) {
  const raw = step && step.raw && typeof step.raw === 'object' ? step.raw : {};
  const explicit = clean(raw.action || raw.type || raw.kind || '', 80);
  if (explicit) {
    const lower = explicit.toLowerCase();
    if (/navigate|open|goto|go_to|visit/.test(lower)) return 'navigate';
    if (/fill|type|enter|input/.test(lower)) return 'fill';
    if (/click|press|tap|select/.test(lower)) return 'click';
    if (/wait/.test(lower)) return 'wait';
    if (/assert|verify|expect|validate/.test(lower)) return 'assert';
    return lower.replace(/[^a-z0-9]+/g, '_') || 'action';
  }
  for (const [name, re] of ACTION_WORDS) {
    if (re.test(step && step.text || '')) return name === 'assert' ? 'assert' : name;
  }
  return 'action';
}

function methodNameForStep(step) {
  const action = inferActionType(step);
  const raw = step && step.raw && typeof step.raw === 'object' ? step.raw : {};
  const target = clean(raw.element || raw.target || raw.field || raw.label || raw.name || step.text, 80)
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .map((part, index) => index === 0 ? part.toLowerCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('');
  return `${action}${target ? target.charAt(0).toUpperCase() + target.slice(1) : 'Step'}`;
}

function dataBindingForStep(step, dataRow) {
  const raw = step && step.raw && typeof step.raw === 'object' ? step.raw : {};
  if (raw.dataBinding && raw.dataBinding.isDataBound) {
    return raw.dataBinding;
  }
  const explicit = raw.data || raw.bindings || null;
  if (explicit && explicit.isDataBound) return explicit;
  return { isDataBound: false };
}

function isVerificationPointRaw(raw) {
  if (!raw || typeof raw !== 'object') return false;
  return raw.verificationPoint === true
    || raw.verifyAsOracle === true
    || raw.businessAssertion === true
    || !!raw.oracleRef
    || !!raw.oracle_ref
    || !!raw.assertionRef
    || !!raw.assertionId
    || (raw.oracle && typeof raw.oracle === 'object');
}

function oracleRefForStep(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw.oracleRef || raw.oracle_ref || raw.assertionRef || raw.assertionId
    || (raw.oracle && typeof raw.oracle === 'object' ? raw.oracle.id || raw.oracle.ref || raw.oracle.assertionId : null);
  return value == null || value === '' ? null : clean(value, 120);
}

function operationCheckForStep(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return normaliseOperationCheck(raw.operationCheck || raw.syncState || raw.sync_state, {
    expected: raw.expected || raw.expectedResult || raw.expectedOutcome || raw.expectedText || null,
    expectedKind: raw.expectedKind || raw.expected_kind || raw.assertionKind || null,
    action: raw.action || raw.verb || null,
    element: raw.element || raw.target || raw.field || raw.label || null,
    locator_hint: raw.locator_hint || raw.selector || null,
    value: raw.value || raw.text || null,
    verificationPoint: isVerificationPointRaw(raw),
  });
}

function expectedOutcomeForAssertion(assertion, testCase) {
  if (!assertion || typeof assertion !== 'object') return null;
  const payload = assertion.payload && typeof assertion.payload === 'object' ? assertion.payload : {};
  const type = clean(assertion.type || assertion.kind || assertion.channel || '', 60).toUpperCase();
  const rawExpected = assertion.expectedPage || assertion.pageName || assertion.expectedUrl ||
    assertion.expectedText || assertion.value || assertion.expected || assertion.text ||
    payload.expectedText || payload.expected || payload.value || payload.text || null;
  const expected = rawExpected == null ? null : clean(rawExpected, 220);
  const polarity = String(assertion.polarity || assertion.operator || '').toLowerCase().includes('not')
    || type.startsWith('FORBIDDEN')
    ? 'must_not_match'
    : 'must_match';
  return {
    kind: type || 'ASSERTION',
    polarity,
    expectedPage: assertion.expectedPage || assertion.pageName || null,
    expectedSignals: (assertion.expectedSignals && typeof assertion.expectedSignals === 'object')
      ? cloneValue(assertion.expectedSignals)
      : (payload.expectedSignals && typeof payload.expectedSignals === 'object')
        ? cloneValue(payload.expectedSignals)
      : expected ? { text: [expected] } : {},
    expected,
    scope: assertion.scope || assertion.pageScope || null,
    source: assertion.provenance || assertion.source || 'declared_assertion',
    requirementRefs: parseJson(testCase && testCase.requirementRefs, []),
  };
}

function assertionIdentityKeys(assertion) {
  if (!assertion || typeof assertion !== 'object') return [];
  const raw = assertion.raw && typeof assertion.raw === 'object' ? assertion.raw : assertion;
  const payload = raw.payload && typeof raw.payload === 'object' ? raw.payload : {};
  const outcome = assertion.expectedOutcome && typeof assertion.expectedOutcome === 'object'
    ? assertion.expectedOutcome
    : {};
  const contract = assertion.assertionContract && typeof assertion.assertionContract === 'object'
    ? assertion.assertionContract
    : {};
  const ids = [
    assertion.assertionId,
    assertion.oracleRef,
    contract.assertionId,
    raw.assertionId,
    raw.oracleRef,
    raw.id,
    raw.stepId,
    raw.planStepId,
  ].map((value) => clean(value || '', 220).toLowerCase()).filter(Boolean);
  const channel = clean(
    raw.channel || raw.type || raw.kind || assertion.expectedKind || outcome.kind || '',
    80,
  ).toLowerCase();
  const signalObject = outcome.expectedSignals || contract.expectedSignals || raw.expectedSignals || payload.expectedSignals || {};
  const signalText = Array.isArray(signalObject.text) ? signalObject.text[0] : signalObject.text;
  const expected = clean(
    raw.expectedText || raw.expected || raw.value || raw.text ||
    payload.expectedText || payload.expected || payload.value || payload.text ||
    outcome.expected || signalText || '',
    400,
  ).toLowerCase();
  const target = clean(raw.targetIdentity || raw.target || raw.element || raw.field || '', 220).toLowerCase();
  const keys = ids.map((id) => `id:${id}`);
  if (channel || expected || target) keys.push(`semantic:${channel}|${expected}|${target}`);
  return [...new Set(keys)];
}

function buildExecutionContract({
  testCase,
  declaredSteps = null,
  declaredAssertions = null,
  dataRow = null,
  runId = null,
  runResultId = null,
} = {}) {
  dataRow = hydrateInlineInstanceMetadata(dataRow);
  const caseContract = caseContractFrom(testCase);
  const steps = (Array.isArray(declaredSteps) ? declaredSteps : parseJson(testCase && testCase.steps, []))
    .map(normalizeStep);
  const assertions = Array.isArray(declaredAssertions) ? declaredAssertions : parseJson(testCase && testCase.declaredAssertions, []);
  const rowCoordinateId = dataRow
    ? (dataRow.rowId || dataRow.instancePlanId || `${dataRow.setName || 'data'}:${dataRow.index == null ? 'row' : dataRow.index}:${dataRow.label || ''}`)
    : null;
  const nodes = [];
  for (const [index, step] of steps.entries()) {
    const kind = inferKind(step);
    const operationCheck = operationCheckForStep(step.raw);
    const oracleRef = oracleRefForStep(step.raw);
    const verificationPoint = isVerificationPointRaw(step.raw);
    nodes.push({
      contractStepId: `${testCase && testCase.id || 'case'}:step:${index + 1}:${shortHash(step.text)}`,
      persistedStepId: step.id || null,
      testCaseId: testCase && testCase.id || null,
      runResultId: runResultId || null,
      dataRowId: rowCoordinateId,
      rowCoordinateId,
      stepOrdinal: index + 1,
      kind,
      actionType: kind === 'assertion' ? 'assert' : inferActionType(step),
      pageIntent: clean(step.raw && (step.raw.page || step.raw.pageIntent || step.raw.module) || testCase && testCase.module || '', 80) || null,
      methodName: methodNameForStep(step),
      locatorRecipe: null,
      dataBinding: dataBindingForStep(step, dataRow),
      operationCheck,
      syncState: operationCheck,
      waitContract: waitContract.buildWaitContract(step.raw),
      oracleRef,
      verificationPoint,
      expectedKind: step.raw && (step.raw.expectedKind || step.raw.expected_kind || step.raw.assertionKind) || null,
      expectedOutcome: kind === 'assertion' ? expectedOutcomeForAssertion(step.raw || {}, testCase) : null,
      assertionContract: kind === 'assertion' ? {
        schemaVersion: 'qaai-assertion-contract-v1',
        assertionId: oracleRef || step.raw && step.raw.assertionId || null,
        expected: step.raw && (step.raw.expected || step.raw.value) || null,
        expectedSignals: step.raw && step.raw.expectedSignals && typeof step.raw.expectedSignals === 'object'
          ? cloneValue(step.raw.expectedSignals)
          : null,
        targetIdentity: step.raw && step.raw.targetIdentity || null,
      } : null,
      proofRequired: kind !== 'precondition',
      certificationStatus: 'planned',
      plannedText: step.text,
      authoredText: step.authoredText || step.text,
      interpretation: step.raw && step.raw.interpretation && typeof step.raw.interpretation === 'object'
        ? cloneValue(step.raw.interpretation)
        : null,
      atomicActions: step.raw && Array.isArray(step.raw.atomicActions)
        ? cloneValue(step.raw.atomicActions)
        : [],
      executionMode: clean(step.raw && step.raw.executionMode || '', 40) || null,
      interpretationDiagnostics: step.raw && Array.isArray(step.raw.interpretationDiagnostics)
        ? cloneValue(step.raw.interpretationDiagnostics)
        : [],
      raw: step.raw,
    });
  }
  const stepAssertionKeys = new Set(nodes
    .filter((node) => node.kind === 'assertion')
    .flatMap(assertionIdentityKeys));
  const representedStepIds = new Set(nodes
    .filter((node) => node.kind === 'assertion')
    .flatMap(nodeStepIdentityValues));
  const caseContractAssertions = caseContract && Array.isArray(caseContract.assertions)
    ? caseContract.assertions
    : [];
  const persistedCompiledRevision = compiledCaseRevisionFrom(testCase);
  for (const [index, assertion] of assertions.entries()) {
    if (!assertion || assertion.parseFailed) continue;
    const declarationKeys = assertionIdentityKeys(assertion);
    if (declarationKeys.some((key) => stepAssertionKeys.has(key))) continue;
    const declarationIdentities = recordIdentityValues(assertion, 'assertions');
    const authoredAssertion = caseContractAssertions.find((entry) => (
      recordIdentityValues(entry, 'assertions').some((identity) => declarationIdentities.includes(identity))
    ));
    // Runtime assertion recovery is allowed to enrich verification, but a
    // revision-pinned CaseContract cannot gain new immutable execution nodes
    // after compilation. Keep supplemental assertions in the verifier channel
    // and out of strict execution-node identity linking.
    if (persistedCompiledRevision && !authoredAssertion) continue;
    if (authoredAssertion && assertionStepRelationValues(authoredAssertion).some((stepId) => representedStepIds.has(stepId))) {
      continue;
    }
    declarationKeys.forEach((key) => stepAssertionKeys.add(key));
    const payload = assertion.payload && typeof assertion.payload === 'object' ? assertion.payload : {};
    nodes.push({
      contractStepId: `${testCase && testCase.id || 'case'}:assertion:${assertion.id || index + 1}`,
      assertionId: assertion.id || null,
      persistedAssertionId: assertion.id || null,
      testCaseId: testCase && testCase.id || null,
      runResultId: runResultId || null,
      dataRowId: rowCoordinateId,
      rowCoordinateId,
      stepOrdinal: steps.length + index + 1,
      kind: 'assertion',
      actionType: 'assert',
      pageIntent: clean(assertion.page || assertion.pageName || testCase && testCase.module || '', 80) || null,
      methodName: methodNameForStep({ text: assertion.id || assertion.expectedText || assertion.value || 'assertion', raw: { action: 'assert' } }),
      locatorRecipe: null,
      dataBinding: assertion.dataBinding || (assertion.dataExpected ? { isDataBound: true, sourceColumn: assertion.dataExpected } : { isDataBound: false }),
      expectedOutcome: expectedOutcomeForAssertion(assertion, testCase),
      assertionContract: {
        schemaVersion: 'qaai-assertion-contract-v1',
        assertionId: assertion.id || null,
        expected: assertion.expected ?? assertion.value ?? assertion.expectedText ?? payload.expectedText ?? payload.expected ?? null,
        expectedSignals: assertion.expectedSignals && typeof assertion.expectedSignals === 'object'
          ? cloneValue(assertion.expectedSignals)
          : payload.expectedSignals && typeof payload.expectedSignals === 'object'
            ? cloneValue(payload.expectedSignals)
          : null,
        targetIdentity: assertion.targetIdentity || null,
      },
      waitContract: waitContract.buildWaitContract({ ...assertion, action: 'assert', kind: 'assertion' }),
      proofRequired: true,
      certificationStatus: 'planned',
      plannedText: clean(assertion.description || assertion.assertion || assertion.expectedText || assertion.value || assertion.id || 'Declared assertion'),
      raw: assertion,
    });
  }
  const linkedNodes = linkCaseContractNodes(nodes, caseContract, { strictIdentity: !!persistedCompiledRevision });
  const caseInstanceV1 = buildCaseInstanceV1({
    testCase,
    caseContract,
    dataRow,
    nodes: linkedNodes,
    runId,
    runResultId,
  });
  const dataRowPublicBindings = dataRow
    ? publicBinding(dataRow.publicBindings || {}, 'publicBindings')
    : null;
  const dataRowPublicFields = dataRow
    ? {
      ...publicBinding(dataRow.fields || dataRow.inputs || {}, 'fields'),
      ...(dataRowPublicBindings || {}),
    }
    : null;
  return {
    schema: CONTRACT_SCHEMA,
    contractId: `etc_${shortHash(stableStringify({
      runId,
      testCaseId: testCase && testCase.id,
      rowCoordinateId,
      nodes: nodes.map((n) => [n.contractStepId, n.plannedText]),
    }))}`,
    runId: runId || null,
    runResultId: runResultId || null,
    testCaseId: testCase && testCase.id || null,
    testCaseName: testCase && testCase.name || null,
    generationId: caseInstanceV1.generationId,
    revision: caseInstanceV1.caseRevision,
    initialState: caseInstanceV1.initialState,
    finalState: caseInstanceV1.finalState,
    sessionPlan: caseInstanceV1.sessionPlan,
    caseInstanceV1,
    dataRow: dataRow ? {
      index: dataRow.index == null ? null : Number(dataRow.index),
      label: dataRow.label || null,
      setName: dataRow.setName || null,
      rowId: dataRow.rowId || null,
      ordinal: Number.isInteger(dataRow.ordinal) ? dataRow.ordinal : null,
      instancePlanId: dataRow.instancePlanId || null,
      instanceRevision: dataRow.instanceRevision || null,
      inlineRevision: dataRow.inlineRevision || null,
      defaultInstanceId: dataRow.defaultInstanceId || null,
      inlineInstance: dataRow.inlineInstance === true,
      fields: dataRowPublicFields,
      publicBindings: dataRowPublicBindings,
    } : null,
    nodes: linkedNodes,
    createdAt: new Date().toISOString(),
  };
}

function attachRunResultId(contract, runResultId) {
  if (!contract || typeof contract !== 'object' || !runResultId) return contract;
  const caseInstanceV1 = contract.caseInstanceV1 && typeof contract.caseInstanceV1 === 'object'
    ? withCaseInstanceId({ ...contract.caseInstanceV1, runResultId })
    : contract.caseInstanceV1 || null;
  return {
    ...contract,
    runResultId,
    caseInstanceV1,
    nodes: Array.isArray(contract.nodes)
      ? contract.nodes.map((node) => ({ ...node, runResultId }))
      : [],
  };
}

function replaySteps(envelope) {
  const ir = envelope && envelope.ir ? envelope.ir : envelope;
  return Array.isArray(ir && ir.steps) ? ir.steps : [];
}

function locatorRecipeFromStep(step) {
  if (!step || typeof step !== 'object') return null;
  const actionLocator = step.actionLocator || step.locatorRecipe || null;
  if (actionLocator) {
    try {
      const primary = actionLocatorResolver.primaryActionLocator(actionLocator);
      if (primary) {
        const expression = primary.frameworkExpressions?.playwright || primary.expression || null;
        const proof = primary.proof || {};
        return {
          primary: expression,
          fallback: Array.isArray(primary.allCandidates) ? primary.allCandidates.slice(0, 5) : [],
          role: primary.targetFacts?.role || primary.role || null,
          accessibleName: primary.targetFacts?.accessibleName || primary.accessibleName || primary.name || null,
          testId: primary.targetFacts?.testId || null,
          css: expression && /locator\(/.test(expression) ? expression : null,
          containerScope: primary.context?.formSelector || primary.context?.dialogSelector || primary.context?.tableSelector || primary.context?.landmarkSelector || null,
          pageRoute: primary.pageUrl || step.pageUrl || null,
          uniquenessProof: { count: proof.count ?? null, sameElement: proof.sameElement === true },
          visibilityProof: { visible: proof.visible ?? null, enabled: proof.enabled ?? null },
          sourceStepId: step.id || step.as || null,
          verified: primary.verified === true || proof.verified === true,
          source: primary.verificationSource || primary.evidenceSource || proof.source || null,
        };
      }
    } catch (_) {}
  }
  const candidates = Array.isArray(step.candidates) ? step.candidates : [];
  const best = candidates.find((c) => c && (c.expr || c.expression || c.frameworkExpressions?.playwright)) || null;
  if (!best) return null;
  const expr = best.frameworkExpressions?.playwright || best.expr || best.expression || null;
  return {
    primary: expr,
    fallback: candidates.slice(0, 5),
    role: best.role || null,
    accessibleName: best.name || best.accessibleName || null,
    testId: best.testId || null,
    css: best.selector || null,
    containerScope: best.scope || best.containerScope || null,
    pageRoute: step.pageUrl || null,
    uniquenessProof: { count: best.count ?? null, sameElement: best.sameElement === true },
    visibilityProof: { visible: best.visible ?? null, enabled: best.enabled ?? null },
    sourceStepId: step.id || step.as || null,
    verified: best.verified === true,
    source: best.source || null,
  };
}

function proofForReplayStep(step) {
  const recipe = locatorRecipeFromStep(step);
  if (!recipe) return null;
  return {
    locatorCount: recipe.uniquenessProof && recipe.uniquenessProof.count,
    sameElement: recipe.uniquenessProof && recipe.uniquenessProof.sameElement,
    visible: recipe.visibilityProof && recipe.visibilityProof.visible,
    enabled: recipe.visibilityProof && recipe.visibilityProof.enabled,
    source: recipe.source,
  };
}

function replayActionIdentities(step, resolve = null) {
  return [...new Set([
    step && step.actionIdentity && step.actionIdentity.actionOccurrenceId,
    step && step.actionIdentity && step.actionIdentity.sourceActionOccurrenceId,
    step && step.actionIdentity && step.actionIdentity.occurrenceKey,
    step && step.actionOccurrenceId,
    step && step.sourceActionOccurrenceId,
    step && step.occurrenceKey,
    step && step.actionIdentity && step.actionIdentity.authoredActionId,
    step && (step.authoredActionId || step.actionId),
    step && step.contractStepId,
    step && step.targetRef,
    resolve && resolve.actionIdentity && resolve.actionIdentity.actionOccurrenceId,
    resolve && resolve.actionIdentity && resolve.actionIdentity.sourceActionOccurrenceId,
    resolve && resolve.actionIdentity && resolve.actionIdentity.occurrenceKey,
    resolve && resolve.actionOccurrenceId,
    resolve && resolve.sourceActionOccurrenceId,
    resolve && resolve.occurrenceKey,
    resolve && resolve.actionIdentity && resolve.actionIdentity.authoredActionId,
    resolve && (resolve.authoredActionId || resolve.actionId),
    resolve && resolve.contractStepId,
    resolve && resolve.targetRef,
  ].filter((value) => value != null && String(value).trim()).map(String))];
}

function contractNodeIdentities(node) {
  return [...new Set([
    node && node.actionIdentity && node.actionIdentity.actionOccurrenceId,
    node && node.actionIdentity && node.actionIdentity.sourceActionOccurrenceId,
    node && node.actionIdentity && node.actionIdentity.occurrenceKey,
    node && node.actionOccurrenceId,
    node && node.sourceActionOccurrenceId,
    node && node.occurrenceKey,
    node && node.actionIdentity && node.actionIdentity.authoredActionId,
    node && (node.authoredActionId || node.actionId),
    node && node.contractStepId,
    node && node.caseContractStepId,
    node && node.stepId,
    node && node.id,
  ].filter((value) => value != null && String(value).trim()).map(String))];
}

function authoredActionIdFor(value) {
  return value && value.actionIdentity && value.actionIdentity.authoredActionId
    || value && (value.authoredActionId || value.actionId)
    || null;
}

function replayOccurrenceKey(step, resolve = null) {
  const occurrenceId = step && step.actionIdentity && (
    step.actionIdentity.actionOccurrenceId || step.actionIdentity.sourceActionOccurrenceId
  ) || step && (step.actionOccurrenceId || step.sourceActionOccurrenceId)
    || resolve && resolve.actionIdentity && (
      resolve.actionIdentity.actionOccurrenceId || resolve.actionIdentity.sourceActionOccurrenceId
    ) || resolve && (resolve.actionOccurrenceId || resolve.sourceActionOccurrenceId);
  if (occurrenceId) return `occurrence:${occurrenceId}`;
  const immutableKey = step && step.actionIdentity && step.actionIdentity.occurrenceKey
    || step && step.occurrenceKey
    || resolve && resolve.actionIdentity && resolve.actionIdentity.occurrenceKey
    || resolve && resolve.occurrenceKey;
  if (immutableKey) return `occurrence-key:${immutableKey}`;
  const actionId = authoredActionIdFor(step) || authoredActionIdFor(resolve);
  if (actionId) return `action:${actionId}`;
  const contractId = step && (step.contractStepId || step.targetRef)
    || resolve && (resolve.contractStepId || resolve.targetRef)
    || null;
  const sequence = Number(
    (step && step.actionIdentity && step.actionIdentity.sequenceIndex)
      ?? (step && (step.sequenceIndex ?? step.actionSequenceIndex))
      ?? (resolve && resolve.actionIdentity && resolve.actionIdentity.sequenceIndex)
      ?? (resolve && (resolve.sequenceIndex ?? resolve.actionSequenceIndex))
  );
  if (!contractId || !Number.isFinite(sequence)) return null;
  return `contract:${contractId}:sequence:${Math.floor(sequence)}:operation:${step && step.action || 'act'}`;
}

function replayActionIsSynthetic(step, resolve = null) {
  return !!(step && step.synthesizedFromContract === true)
    || !!(resolve && resolve.synthesizedFromContract === true);
}

function assertionProjectionIsNonApplicable(node, replayStep = null, outcome = null) {
  if (!node || node.kind !== 'assertion') return false;
  const raw = node && node.raw && typeof node.raw === 'object' ? node.raw : {};
  const values = [node, raw, replayStep, outcome].filter((value) => value && typeof value === 'object');
  const disposition = values.map((value) => clean(
    value.outcome || value.assertionOutcome || value.status || value.disposition,
    80
  ).toLowerCase()).find(Boolean);
  return values.some((value) => value.synthetic === true
      || value.synthesized === true
      || value.synthesizedFromContract === true
      || value.notApplicable === true
      || value.applicable === false)
    || disposition === 'not_applicable';
}

function mapReplayToContractNodes(contract, envelope, assertionOutcomes = []) {
  const nodes = (contract && Array.isArray(contract.nodes) ? contract.nodes : []).map((n) => ({ ...n }));
  const replay = replaySteps(envelope);
  const resolveByAs = new Map();
  const outcomesByAssertion = new Map();
  for (const outcome of assertionOutcomes || []) {
    const id = outcome && (outcome.assertionId || outcome.id);
    if (id) outcomesByAssertion.set(id, outcome);
  }
  for (const step of replay) {
    if (step && step.op === 'resolve' && step.as) resolveByAs.set(step.as, step);
  }
  const actionNodes = nodes.filter((node) => node && node.kind !== 'assertion');
  const replayActs = replay.filter((step) => step && step.op === 'act');
  const consumedActionNodes = new Set();
  const consumedAssertionNodes = new Set();
  const realReplayOccurrences = new Set();
  for (const replayAct of replayActs) {
    const replayResolve = replayAct.target ? resolveByAs.get(replayAct.target) : null;
    if (replayActionIsSynthetic(replayAct, replayResolve)) continue;
    const occurrenceKey = replayOccurrenceKey(replayAct, replayResolve);
    if (occurrenceKey) realReplayOccurrences.add(occurrenceKey);
  }
  const hasActionIdentity = replayActs.some((step) => {
    const resolve = step.target ? resolveByAs.get(step.target) : null;
    return replayActionIdentities(step, resolve).length > 0;
  });
  let actionCursor = 0;
  let assertCursor = 0;
  for (const step of replay) {
    if (!step || typeof step !== 'object') continue;
    if (step.op === 'resolve' && step.as) {
      resolveByAs.set(step.as, step);
      continue;
    }
    if (step.op === 'act') {
      const resolve = step.target ? resolveByAs.get(step.target) : null;
      const identities = replayActionIdentities(step, resolve);
      const synthetic = replayActionIsSynthetic(step, resolve);
      // When both runtime evidence and a contract-synthesized compatibility act
      // exist for one authored occurrence, the runtime act is authoritative.
      // Skipping the synthetic copy prevents the doubled runtime+case_step flow.
      const occurrenceKey = replayOccurrenceKey(step, resolve);
      if (synthetic && occurrenceKey && realReplayOccurrences.has(occurrenceKey)) continue;
      const replayActionId = authoredActionIdFor(step) || authoredActionIdFor(resolve);
      let targetNode = null;
      if (hasActionIdentity && occurrenceKey) {
        targetNode = actionNodes.find((node) => !consumedActionNodes.has(node)
          && replayOccurrenceKey(node) === occurrenceKey) || null;
      }
      if (hasActionIdentity && replayActionId) {
        targetNode = targetNode || actionNodes.find((node) => !consumedActionNodes.has(node) && authoredActionIdFor(node) === replayActionId) || null;
      }
      if (!targetNode && hasActionIdentity) {
        targetNode = actionNodes.find((node) => {
            if (consumedActionNodes.has(node)) return false;
            const nodeIds = contractNodeIdentities(node);
            return identities.some((identity) => nodeIds.includes(identity));
          }) || null;
      }
      if (!targetNode && !hasActionIdentity) {
        while (actionCursor < actionNodes.length && consumedActionNodes.has(actionNodes[actionCursor])) actionCursor += 1;
        targetNode = actionNodes[actionCursor++] || null;
      }
      // Once a replay carries stable action identities, an unbound setup action
      // (for example the browser bootstrap navigate) is setup evidence only. It
      // must never consume Step 1 or shift every later action onto the wrong node.
      if (!targetNode) continue;
      consumedActionNodes.add(targetNode);
      const recipe = locatorRecipeFromStep(step) || locatorRecipeFromStep(resolve);
      const sourceIdentity = step.actionIdentity && typeof step.actionIdentity === 'object'
        ? step.actionIdentity
        : {};
      const replayContractStepId = sourceIdentity.contractStepId
        || step.contractStepId
        || step.targetRef
        || resolve && resolve.actionIdentity && resolve.actionIdentity.contractStepId
        || resolve && (resolve.contractStepId || resolve.targetRef)
        || targetNode.contractStepId
        || null;
      const actionOccurrenceId = sourceIdentity.actionOccurrenceId || step.actionOccurrenceId || null;
      const sourceActionOccurrenceId = sourceIdentity.sourceActionOccurrenceId || step.sourceActionOccurrenceId || null;
      const mappedOccurrenceKey = sourceIdentity.occurrenceKey || step.occurrenceKey || null;
      targetNode.replayStep = {
        op: step.op,
        action: step.action || null,
        target: step.target || null,
        contractStepId: replayContractStepId,
        authoredActionId: sourceIdentity.authoredActionId || step.authoredActionId || step.actionId || null,
        actionOccurrenceId,
        sourceActionOccurrenceId,
        occurrenceKey: mappedOccurrenceKey,
        sequenceIndex: sourceIdentity.sequenceIndex ?? step.sequenceIndex ?? targetNode.stepOrdinal ?? null,
        toolUseId: sourceIdentity.toolUseId || step.toolUseId || null,
        toolName: sourceIdentity.toolName || step.toolName || step.tool || null,
        operation: sourceIdentity.operation || step.action || null,
        actionIdentity: {
          schemaVersion: 'qaai-action-identity-v1',
          caseId: sourceIdentity.caseId || targetNode.testCaseId || null,
          contractStepId: replayContractStepId,
          authoredActionId: sourceIdentity.authoredActionId || step.authoredActionId || step.actionId || null,
          actionOccurrenceId,
          sourceActionOccurrenceId,
          occurrenceKey: mappedOccurrenceKey,
          sequenceIndex: sourceIdentity.sequenceIndex ?? step.sequenceIndex ?? targetNode.stepOrdinal ?? null,
          toolUseId: sourceIdentity.toolUseId || step.toolUseId || null,
          toolName: sourceIdentity.toolName || step.toolName || step.tool || null,
          operation: sourceIdentity.operation || step.action || null,
        },
        synthesizedFromContract: synthetic,
      };
      targetNode.actionIdentity = targetNode.replayStep.actionIdentity;
      if (synthetic) {
        // Contract reconciliation keeps the authored method visible in draft
        // output, but it is not proof that the browser executed that method.
        // Clear any carried fields so a missing action cannot inherit a prior
        // step's tool, locator, fulfillment, or proof and become certified.
        targetNode.toolName = null;
        targetNode.locatorRecipe = null;
        targetNode.proof = null;
        targetNode.contractFulfillment = null;
        targetNode.certificationStatus = 'requires_repair';
      } else {
        const replayProof = proofForReplayStep(step) || proofForReplayStep(resolve) || null;
        targetNode.locatorRecipe = recipe || targetNode.locatorRecipe || null;
        targetNode.proof = {
          ...(targetNode.proof || {}),
          ...(replayProof || {}),
          actionExecuted: true,
          synthetic: false,
          source: replayProof && replayProof.source || 'recorded_replay_action',
        };
        targetNode.certificationStatus = recipe || step.action === 'navigate' || step.action === 'navigateBack' || step.action === 'navigateForward'
          ? 'certified'
          : 'requires_repair';
      }
      continue;
    }
    if (step.op === 'assert') {
      const assertionNodes = nodes.filter((n) => n.kind === 'assertion');
      const assertionRefs = [...new Set([
        step.contractRef,
        step.contractStepId,
        step.stepId,
        step.assertionId,
        step.id,
      ].filter(Boolean).map(String))];
      const byId = assertionRefs.length
        ? assertionNodes.find((node) => !consumedAssertionNodes.has(node)
          && contractNodeIdentities(node).some((identity) => assertionRefs.includes(identity)))
        : null;
      let targetNode = byId || null;
      if (!targetNode && assertionRefs.length === 0) {
        while (assertCursor < assertionNodes.length && consumedAssertionNodes.has(assertionNodes[assertCursor])) assertCursor += 1;
        targetNode = assertionNodes[assertCursor++] || null;
      }
      if (!targetNode) continue;
      consumedAssertionNodes.add(targetNode);
      targetNode.replayStep = {
        op: step.op,
        channel: step.channel || null,
        contractRef: step.contractRef || null,
        expected: step.expected ?? null,
        expectedSignals: step.expectedSignals || null,
        comparator: step.comparator || null,
        polarity: step.polarity || null,
        target: step.target || null,
      };
      const signalText = step.expectedSignals && Array.isArray(step.expectedSignals.text)
        ? step.expectedSignals.text.find((value) => value != null && String(value).trim())
        : null;
      targetNode.expectedOutcome = {
        ...(targetNode.expectedOutcome || {}),
        kind: step.channel || targetNode.expectedOutcome?.kind || 'ASSERTION',
        expected: signalText != null
          ? clean(signalText, 220)
          : step.expected != null
            ? clean(step.expected, 220)
            : targetNode.expectedOutcome?.expected || null,
        expectedSignals: step.expectedSignals && typeof step.expectedSignals === 'object'
          ? cloneValue(step.expectedSignals)
          : targetNode.expectedOutcome?.expectedSignals || {},
        polarity: /^FORBIDDEN_/i.test(String(step.channel || '')) ? 'must_not_match' : targetNode.expectedOutcome?.polarity || 'must_match',
      };
      const outcome = outcomesByAssertion.get(step.contractRef) || (step.liveOutcome ? { outcome: step.liveOutcome } : null);
      if (assertionProjectionIsNonApplicable(targetNode, step, outcome)) {
        targetNode.certificationStatus = 'not_applicable';
        targetNode.proof = outcome ? { assertionOutcome: 'not_applicable', domGrounded: outcome.domGrounded ?? step.liveDomGrounded ?? null } : null;
        continue;
      }
      const exactSignals = step.expectedSignals && typeof step.expectedSignals === 'object'
        ? cloneValue(step.expectedSignals)
        : targetNode.expectedOutcome && targetNode.expectedOutcome.expectedSignals && typeof targetNode.expectedOutcome.expectedSignals === 'object'
          ? cloneValue(targetNode.expectedOutcome.expectedSignals)
          : {};
      targetNode.assertionContract = {
        schemaVersion: 'qaai-assertion-contract-v1',
        contractStepId: step.contractRef || step.contractStepId || targetNode.contractStepId || null,
        assertionId: step.assertionId || targetNode.assertionId || null,
        channel: step.channel || targetNode.expectedOutcome && targetNode.expectedOutcome.kind || 'ASSERTION',
        comparator: step.comparator || targetNode.expectedOutcome && targetNode.expectedOutcome.comparator || null,
        polarity: step.polarity || targetNode.expectedOutcome && targetNode.expectedOutcome.polarity || 'must_match',
        expected: signalText != null
          ? clean(signalText, 220)
          : (step.expected ?? (targetNode.expectedOutcome && targetNode.expectedOutcome.expected) ?? null),
        expectedSignals: exactSignals,
        targetIdentity: cloneValue(step.targetIdentity || targetNode.targetIdentity || null),
      };
      targetNode.proof = outcome ? { assertionOutcome: outcome.outcome || null, domGrounded: outcome.domGrounded ?? step.liveDomGrounded ?? null } : null;
      targetNode.certificationStatus = assertionIsTranslatable(targetNode) ? 'certified' : 'requires_repair';
    }
  }
  for (const node of nodes) {
    if (assertionProjectionIsNonApplicable(node, node.replayStep, node.proof)) {
      node.certificationStatus = 'not_applicable';
      continue;
    }
    if (node && node.kind === 'assertion' && assertionIsTranslatable(node)) {
      node.certificationStatus = 'certified';
    }
  }
  return nodes;
}

function assertionIsTranslatable(node) {
  if (!node || node.kind !== 'assertion') return false;
  const expected = node.expectedOutcome && node.expectedOutcome.expected;
  const expectedSignals = node.expectedOutcome && node.expectedOutcome.expectedSignals;
  const raw = node.raw && typeof node.raw === 'object' ? node.raw : {};
  const channel = clean(
    node.replayStep && node.replayStep.channel
      || node.expectedOutcome && node.expectedOutcome.kind
      || raw.channel
      || raw.type
      || raw.kind,
    100
  ).toUpperCase();
  const supportedChannel = /URL|ROUTE|LOCATION|TEXT|CONTENT|MESSAGE|LABEL|TITLE|VALUE|SELECTED|ATTRIBUTE|NUMBER|COUNT|NUMERIC|AMOUNT|VISIBLE|PRESENT|DISPLAYED|HIDDEN|NOT_VISIBLE|ABSENT|PAGE|STATE/.test(channel);
  const hasExpected = expected !== null && expected !== undefined && (typeof expected !== 'string' || expected.trim() !== '')
    || Array.isArray(expectedSignals) && expectedSignals.some((value) => value !== null && value !== undefined && String(value).trim())
    || node.replayStep && node.replayStep.expectedSignals && Object.values(node.replayStep.expectedSignals).some((value) => (
      Array.isArray(value) ? value.some((entry) => String(entry || '').trim()) : String(value || '').trim()
    ));
  return supportedChannel && hasExpected;
}

function repairTaskForNode(node, detail) {
  let category = 'step_parity_gap';
  const recipe = node && node.locatorRecipe;
  if (node && node.kind === 'assertion' && node.certificationStatus !== 'certified') category = 'assertion_translation_gap';
  if (node && node.kind !== 'assertion' && !recipe && node.actionType !== 'navigate') category = 'missing_locator_recipe';
  if (recipe && !recipe.containerScope && /getByRole\(\s*["'](?:button|option|menuitem|textbox|combobox)["']/i.test(String(recipe.primary || ''))) category = 'unscoped_locator';
  return {
    category,
    testCaseId: node && node.testCaseId || null,
    dataRowId: node && node.dataRowId || null,
    contractStepId: node && node.contractStepId || null,
    expectedFix: expectedFixForCategory(category),
    evidence: detail || (node && node.plannedText) || null,
    owner: 'qaai_platform',
  };
}

function expectedFixForCategory(category) {
  switch (category) {
    case 'missing_locator_recipe': return 'Recapture action-time locator proof while the page is live.';
    case 'unscoped_locator': return 'Add page/container scope and uniqueness proof to the locator recipe.';
    case 'hidden_target_missing_trigger': return 'Insert and certify the trigger action before the hidden target action.';
    case 'missing_data_binding': return 'Bind the value to an uploaded/declarative data column and render readData(row, column).';
    case 'assertion_contract_defect': return 'Repair only the contradictory assertion contract and rerun or revalidate.';
    case 'assertion_translation_gap': return 'Translate the declared assertion into a certified Playwright/POM assertion method.';
    case 'page_method_missing': return 'Generate the missing page-object method from the certified action node.';
    default: return 'Repair the contract/action graph until planned, executed, and generated steps match.';
  }
}

function buildActionGraph({
  contract,
  replayEnvelope = null,
  assertionOutcomes = [],
  status = null,
  error = null,
  runResultId = null,
} = {}) {
  const base = contract || buildExecutionContract({});
  const nodes = mapReplayToContractNodes(base, replayEnvelope, assertionOutcomes);
  const repairTasks = [];
  for (const node of nodes) {
    if (assertionProjectionIsNonApplicable(node, node.replayStep, node.proof)) continue;
    if (node.proofRequired && node.certificationStatus !== 'certified') {
      repairTasks.push(repairTaskForNode(node));
    }
    if (node.locatorRecipe && node.certificationStatus === 'certified') {
      const task = repairTaskForNode(node);
      if (task.category === 'unscoped_locator') repairTasks.push(task);
    }
    if (node.dataBinding && node.dataBinding.isDataBound === false && nodeRequiresDataBinding(node) && base.dataRow) {
      repairTasks.push({ ...repairTaskForNode(node), category: 'missing_data_binding', expectedFix: expectedFixForCategory('missing_data_binding') });
    }
  }
  return {
    schema: ACTION_GRAPH_SCHEMA,
    contractId: base.contractId || null,
    runId: base.runId || null,
    runResultId: runResultId || base.runResultId || null,
    testCaseId: base.testCaseId || null,
    status,
    error: error || null,
    nodes,
    repairTasks: repairTasks.filter((task) => REPAIR_CATEGORIES.has(task.category)),
    complete: repairTasks.length === 0,
    certifiedAt: repairTasks.length === 0 ? new Date().toISOString() : null,
    generatedAt: new Date().toISOString(),
  };
}

function executableResultCount(results) {
  return (results || []).filter((r) => !['skipped', 'needs_human'].includes(String(r && r.status || '').toLowerCase())).length;
}

function dataFilePathFromSpec(specRel, dataPath) {
  const normalized = String(dataPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.startsWith('tests/data/')) return normalized;
  const parts = String(specRel || '').split('/');
  parts.pop();
  const prefix = parts.join('/');
  const joined = `${prefix ? `${prefix}/` : ''}${normalized}`;
  const out = [];
  for (const part of joined.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function rowsForDataPath(files, specRel, dataPath) {
  const rel = dataFilePathFromSpec(specRel, dataPath);
  const parsed = parseJson(files && files[rel], null);
  return Array.isArray(parsed) && parsed.length ? parsed.length : 1;
}

function generatedRunnableTestCount(files) {
  let count = 0;
  for (const [rel, content] of Object.entries(files || {})) {
    if (!/^tests\/.+\.spec\.(?:js|ts)$/i.test(rel)) continue;
    const text = String(content || '');
    const dataVars = new Map();
    let m;
    const loadRe = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*loadDataRows\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = loadRe.exec(text))) dataVars.set(m[1], rowsForDataPath(files, rel, m[2]));
    const loopRanges = [];
    const loopRe = /for\s*\(\s*const\s+row\s+of\s+([A-Za-z_$][\w$]*)\s*\)\s*\{[\s\S]*?\btest\s*\(/g;
    while ((m = loopRe.exec(text))) {
      count += dataVars.get(m[1]) || 1;
      loopRanges.push([m.index, loopRe.lastIndex]);
    }
    const stripped = loopRanges.reduceRight((acc, [start, end]) => acc.slice(0, start) + acc.slice(end), text);
    const journeySteps = (stripped.match(/\btest\.step\s*\(/g) || []).length;
    count += journeySteps || (stripped.match(/\btest\s*\(/g) || []).length;
  }
  return count;
}

function normalizedContractStep(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  const step = raw.match(/(?:^|[:_-])step(?:[:_-])?(\d+)(?:[:_-]|$)/i);
  if (step) return `step${step[1]}`;
  return raw.replace(/[^a-z0-9]+/g, '');
}

function nodeRequiresDataBinding(node) {
  const raw = node?.raw && typeof node.raw === 'object' ? node.raw : {};
  if (raw.value == null) return false;
  const operation = String(
    node?.actionType || raw.action || raw.type || raw.kind || '',
  ).trim().toLowerCase();
  return /^(?:fill|type|enter|input|select|selectoption|choose|upload|setinputfiles|setvalue)$/.test(
    operation.replace(/[^a-z0-9]+/g, ''),
  );
}

function ledgerRowForTask(task, result, stepLedger) {
  const taskIdentity = normalizedContractStep(task && task.contractStepId);
  const caseLedger = (stepLedger && stepLedger.cases || []).find((item) =>
    item && (!result.testCaseId || item.testCaseId === result.testCaseId));
  const rows = Array.isArray(caseLedger && caseLedger.ledger) ? caseLedger.ledger : [];
  return rows.find((item) => item && taskIdentity
    && normalizedContractStep(item.contractStepId || item.plannedStepId) === taskIdentity) || null;
}

function assertionTaskHasPositiveRuntimeProof(task, result) {
  const taskIdentity = normalizedContractStep(task && task.contractStepId);
  const nodes = Array.isArray(result?.actionGraph?.nodes) ? result.actionGraph.nodes : [];
  const node = nodes.find((candidate) => candidate && taskIdentity
    && normalizedContractStep(candidate.contractStepId) === taskIdentity);
  if (!node) return false;
  const proof = node.proof && typeof node.proof === 'object' ? node.proof : {};
  const outcome = String(
    proof.assertionOutcome || node.replayStep?.liveOutcome || node.replayStep?.outcome || '',
  ).trim().toLowerCase();
  return !!outcome && !['uncheckable', 'not_applicable', 'not_evaluated', 'unknown'].includes(outcome);
}

function currentRepairResolution({ task, result, stepLedger, locatorManifest }) {
  const category = String(task && task.category || '');
  const taskIdentity = normalizedContractStep(task && task.contractStepId);
  const row = ledgerRowForTask(task, result, stepLedger);
  const exported = row && row.exportStatus === 'exported' && row.status !== 'requires_repair';

  if (category === 'missing_data_binding') {
    const nodes = Array.isArray(result?.actionGraph?.nodes) ? result.actionGraph.nodes : [];
    const node = nodes.find((candidate) => candidate && taskIdentity
      && normalizedContractStep(candidate.contractStepId) === taskIdentity);
    if (node && !nodeRequiresDataBinding(node)) return true;
  }
  if (category === 'step_parity_gap') return !!exported;
  if (category === 'assertion_translation_gap' && exported) {
    return /^(?:assert|expect|verify)/i.test(String(row.exportedPageMethod || ''));
  }
  if (category === 'missing_locator_recipe' && exported) {
    return (locatorManifest || []).some((entry) => {
      if (!entry
        || normalizedContractStep(entry.contractStepId || entry.stepAuthoringId) !== taskIdentity) {
        return false;
      }
      if (entry.verified === true) return true;
      const optionalGuarded = /dismiss[_\s-]*if[_\s-]*visible|if[_\s-]*present|optional/i.test(
        String(row.operation || row.replayAction || row.plannedText || ''),
      );
      const explicitGuess = /qaai[_-]?guessed|semantic.*guess/i.test(
        `${entry.source || ''} ${entry.provenance?.kind || ''} ${entry.locatorProvenance?.kind || ''}`,
      );
      const deterministicEvidenceExhausted = entry.provenance?.deterministicEvidenceExhausted === true
        || entry.locatorProvenance?.deterministicEvidenceExhausted === true;
      const executableExpression = !!clean(entry.expr || entry.expression, 2000);
      return optionalGuarded
        && explicitGuess
        && deterministicEvidenceExhausted
        && executableExpression;
    });
  }
  const parityComplete = !!(stepLedger && stepLedger.summary
    && Number(stepLedger.summary.blockedInternal || 0) === 0
    && Number(stepLedger.summary.replayOnly || 0) === 0
    && Number(stepLedger.summary.exported || 0) === Number(stepLedger.summary.totalPlannedSteps || 0));
  if (category === 'assertion_translation_gap'
      && /:assertion:\d+$/i.test(String(task && task.contractStepId || ''))
      && parityComplete
      && !row) return true;
  return false;
}

function certifyContractExport({ results = [], files = {}, validation = null, stepLedger = null } = {}) {
  const findings = [];
  const active = (results || []).filter((r) => r && (r.executionContract || r.actionGraph));
  const contractFirstActive = active.length > 0;
  if (!contractFirstActive) {
    return {
      schema: CERTIFICATION_SCHEMA,
      contractFirstActive: false,
      packagePassed: validation ? validation.packagePassed : null,
      findings: [],
      repairTasks: [],
      executableResultCount: executableResultCount(results),
      generatedRunnableTestCount: generatedRunnableTestCount(files),
    };
  }
  const repairTasks = [];
  const locatorManifest = parseJson(files && files['evidence/locator-manifest.json'], []);
  for (const result of active) {
    if (!result.executionContract) {
      findings.push({
        rule: 'contract_missing_execution_contract',
        severity: 'error',
        runResultId: result.runResultId,
        testCaseId: result.testCaseId,
        message: `RunResult ${result.runResultId} has no executionContractJson. Certified codegen cannot prove planned intent.`,
      });
    }
    if (!result.actionGraph) {
      findings.push({
        rule: 'contract_missing_action_graph',
        severity: 'error',
        runResultId: result.runResultId,
        testCaseId: result.testCaseId,
        message: `RunResult ${result.runResultId} has no actionGraphJson. Certified codegen cannot prove browser execution mapped to the contract.`,
      });
      continue;
    }
    const tasks = Array.isArray(result.actionGraph.repairTasks) ? result.actionGraph.repairTasks : [];
    for (const task of tasks) {
      if (currentRepairResolution({
        task,
        result,
        stepLedger,
        locatorManifest: Array.isArray(locatorManifest) ? locatorManifest : [],
      })) continue;
      const taskRow = ledgerRowForTask(task, result, stepLedger);
      const postBoundaryDiagnostic = taskRow?.status === 'diagnostic_only_post_boundary';
      const authoredAssertionDiagnostic = task.category === 'assertion_translation_gap'
        && !assertionTaskHasPositiveRuntimeProof(task, result);
      if (postBoundaryDiagnostic || authoredAssertionDiagnostic) {
        const diagnosticTask = { ...task, diagnosticOnly: true };
        repairTasks.push(diagnosticTask);
        findings.push({
          rule: `contract_diagnostic:${task.category || 'unknown'}`,
          severity: 'warning',
          nonBlocking: true,
          diagnosticOnly: true,
          runResultId: result.runResultId,
          testCaseId: result.testCaseId,
          contractStepId: task.contractStepId || null,
          message: postBoundaryDiagnostic
            ? `${task.category || 'contract_gap'}: authored intent is after the recorded execution boundary and was not emitted as runnable code.`
            : `${task.category || 'assertion_gap'}: no positive evaluated runtime assertion evidence exists, so authored intent remains diagnostic instead of guessed runnable code.`,
        });
        continue;
      }
      repairTasks.push(task);
      const nonBlocking = task.category === 'missing_locator_recipe';
      findings.push({
        rule: `contract_repair_required:${task.category || 'unknown'}`,
        severity: nonBlocking ? 'warning' : 'error',
        nonBlocking,
        runResultId: result.runResultId,
        testCaseId: result.testCaseId,
        contractStepId: task.contractStepId || null,
        message: `${task.category || 'contract_gap'}: ${task.expectedFix || 'QAAI must repair this contract node before certification.'}`,
      });
    }
  }
  const ledgerSummary = stepLedger && stepLedger.summary || null;
  if (ledgerSummary && Number(ledgerSummary.blockedInternal || 0) > 0) {
    findings.push({
      rule: 'contract_step_parity_gap',
      severity: 'error',
      path: 'evidence/step-parity-report.json',
      message: `${ledgerSummary.blockedInternal} planned/executed step(s) still lack generated-code proof.`,
    });
  }
  const runnable = generatedRunnableTestCount(files);
  const executable = executableResultCount(results);
  if (runnable !== executable) {
    findings.push({
      rule: 'contract_cardinality_mismatch',
      severity: 'error',
      message: `Generated runnable test count (${runnable}) does not match executable result count (${executable}).`,
    });
  }
  for (const rel of Object.keys(files || {})) {
    if (/^pages\/EvaluateMethods\.(?:js|ts)$/i.test(rel)) {
      findings.push({
        rule: 'contract_debug_evaluate_methods_in_certified_package',
        severity: 'error',
        path: rel,
        message: 'Certified POM output must not include debug EvaluateMethods. Translate EVALUATE assertions into contract assertion methods or keep them in evidence/debug only.',
      });
    }
  }
  const errorCount = findings.filter((f) => f.severity === 'error').length;
  return {
    schema: CERTIFICATION_SCHEMA,
    contractFirstActive: true,
    packagePassed: errorCount === 0 && (!validation || validation.packagePassed !== false),
    errorCount,
    warningCount: findings.filter((f) => f.severity === 'warning').length,
    findings,
    repairTasks,
    executableResultCount: executable,
    generatedRunnableTestCount: runnable,
  };
}

module.exports = {
  CONTRACT_SCHEMA,
  ACTION_GRAPH_SCHEMA,
  CERTIFICATION_SCHEMA,
  buildExecutionContract,
  attachRunResultId,
  buildActionGraph,
  certifyContractExport,
  buildExecutedCaseAstV1: executedCaseAst.buildExecutedCaseAstV1,
  validateExecutedCaseAstV1: executedCaseAst.validateExecutedCaseAstV1,
  _repairTaskForNode: repairTaskForNode,
};
