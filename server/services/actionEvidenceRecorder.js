'use strict';

const crypto = require('crypto');
const executionAuthoringCompiler = require('./executionAuthoringCompiler');
const actionLocatorResolver = require('./actionLocatorResolver');
const { encodeJson } = require('./jsonField');
const featureFlags = require('./generationFeatureFlags');
const liveScriptRecorder = require('./liveScriptRecorder');
const authSessionManager = require('./universalAuthSessionManager');

const SCHEMA_VERSION = 'qaai-action-evidence-v1';
const CHOKEPOINT_SCHEMA_VERSION = 'qaai-action-evidence-chokepoint-v1';
const liveScriptLedgerByTrail = new WeakMap();

const EXPORTABLE_TOOLS = new Set([
  'browser_navigate',
  'browser_click',
  'browser_double_click',
  'browser_triple_click',
  'browser_type',
  'browser_fill',
  'browser_fill_form',
  'browser_select_option',
  'browser_check',
  'browser_uncheck',
  'browser_upload_file',
  'assertion_check',
]);

const UTILITY_TOOLS = new Set([
  'browser_snapshot',
  'browser_wait_for',
  'browser_evaluate',
  'browser_network_requests',
  'browser_console_messages',
  'browser_press_key',
  'browser_resize',
  'browser_take_screenshot',
]);

const MANUAL_GATE_PATTERNS = [
  /captcha/i,
  /mfa/i,
  /multi[-_\s]?factor/i,
  /one[-_\s]?time/i,
  /otp/i,
  /manual/i,
  /native dialog/i,
  /canvas/i,
];

function stableStringify(value) {
  if (value == null) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value)).digest('hex');
}

function shortHash(value) {
  return hash(value).slice(0, 16);
}

function makeId(prefix, value) {
  return `${prefix}_${shortHash(value)}_${crypto.randomUUID().slice(0, 8)}`;
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function textOf(value) {
  return String(value == null ? '' : value).trim();
}

function envFlagOn(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(raw));
}

function isSensitiveName(name) {
  return /pass|pwd|secret|token|otp|mfa|authorization|cookie|session|credential/i.test(textOf(name));
}

function valueRefFor({ value, label, index = 0, source = 'action' } = {}) {
  if (value == null || String(value).length === 0) return null;
  const name = textOf(label) || `${source}-${index}`;
  const prefix = isSensitiveName(name) || isSensitiveName(value) ? 'secret' : 'value';
  return `${prefix}:${shortHash(`${source}:${name}:${String(value)}`)}`;
}

function redactArgs(args = {}) {
  if (!isObject(args)) return args;
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === 'fields' && Array.isArray(value)) {
      out.fields = value.map((field, index) => {
        if (!isObject(field)) return field;
        const label = field.element || field.label || field.name || field.placeholder || field.type || `field ${index + 1}`;
        const clone = { ...field };
        if ('value' in clone || 'text' in clone || 'input' in clone) {
          clone.valueRef = valueRefFor({ value: clone.value ?? clone.text ?? clone.input, label, index, source: 'field' });
          delete clone.value;
          delete clone.text;
          delete clone.input;
        }
        return clone;
      });
      continue;
    }
    if (['value', 'text', 'input', 'password', 'token', 'secret'].includes(key) || isSensitiveName(key)) {
      out.valueRef = valueRefFor({ value, label: key, source: 'arg' });
      continue;
    }
    out[key] = value;
  }
  return out;
}

function actionKindFor(toolName) {
  const tool = textOf(toolName);
  if (tool === 'browser_navigate') return 'navigate';
  if (tool === 'browser_fill_form') return 'fill_form';
  if (tool === 'browser_type' || tool === 'browser_fill') return 'fill';
  if (tool === 'browser_select_option') return 'select';
  if (tool === 'browser_check') return 'check';
  if (tool === 'browser_uncheck') return 'uncheck';
  if (tool === 'browser_upload_file') return 'upload';
  if (tool === 'assertion_check') return 'assert';
  if (tool.includes('click')) return 'click';
  return tool.replace(/^browser_/, '') || 'unknown';
}

function isExportableTool(toolName, entry = {}) {
  if (EXPORTABLE_TOOLS.has(toolName)) return true;
  if (toolName === 'browser_evaluate') {
    const source = textOf(entry.source || entry.qaaiSource || entry.args?.source);
    return /deterministic_dom_(fill|click|select|check|upload)/i.test(source);
  }
  return false;
}

function isUtilityTool(toolName) {
  return UTILITY_TOOLS.has(toolName);
}

function copyIfPresent(target, source, targetKey, sourceKeys) {
  if (!isObject(target) || !isObject(source)) return false;
  if (target[targetKey] != null) return false;
  const keys = Array.isArray(sourceKeys) ? sourceKeys : [sourceKeys];
  for (const key of keys) {
    if (source[key] != null) {
      target[targetKey] = source[key];
      return true;
    }
  }
  return false;
}

function propagateActionEvidenceFields(entry = {}, result = {}) {
  if (!isObject(entry) || !isObject(result)) {
    return {
      qaaiActionLocator: false,
      qaaiActionEvidence: false,
      codegenLocator: false,
      locatorDiagnostic: false,
      actionLocatorGap: false,
    };
  }
  const propagated = {
    qaaiActionLocator: copyIfPresent(entry, result, 'qaaiActionLocator', ['qaaiActionLocator', 'actionLocator']),
    qaaiActionEvidence: copyIfPresent(entry, result, 'qaaiActionEvidence', ['qaaiActionEvidence', 'actionEvidence']),
    codegenLocator: copyIfPresent(entry, result, 'codegenLocator', ['codegenLocator']),
    locatorDiagnostic: copyIfPresent(entry, result, 'locatorDiagnostic', ['locatorDiagnostic', 'diagnostic']),
    actionLocatorGap: copyIfPresent(entry, result, 'actionLocatorGap', ['actionLocatorGap', 'gap']),
  };
  if (entry.qaaiActionLocator && !entry.actionLocator) entry.actionLocator = entry.qaaiActionLocator;
  if (entry.qaaiActionEvidence?.gap && !entry.actionLocatorGap) entry.actionLocatorGap = entry.qaaiActionEvidence.gap;
  return propagated;
}

function isManualGate(entry = {}) {
  const blob = [
    entry.tool,
    entry.narration,
    entry.error,
    entry.blockedReason,
    entry.args && Object.values(entry.args).join(' '),
  ].filter(Boolean).join(' ');
  return MANUAL_GATE_PATTERNS.some((pattern) => pattern.test(blob));
}

function contractStepIdFor(entry = {}) {
  return entry.contractStepId || entry.contractNodeId || entry.stepAuthoring?.contractStepId || entry.stepAuthoring?.plannedStepId || null;
}

function snapshotRefFrom(value, fallback = null) {
  const text = textOf(value);
  if (!text) return fallback;
  return `snapshot:${shortHash(text)}`;
}

function transitionProofFor(entry = {}) {
  return entry.transitionProof || entry.stepAuthoring?.transitionProof || entry.actionLocatorKernel?.transitionProof || null;
}

function locatorFromEntry(entry = {}, field = null, fieldIndex = null) {
  if (field) {
    const multi = entry.actionLocator && entry.actionLocator.kind === 'multi' && Array.isArray(entry.actionLocator.fields)
      ? entry.actionLocator.fields[fieldIndex] || null
      : null;
    return field.actionLocator
      || multi?.actionLocator
      || (Array.isArray(entry.fieldCodegenLocators) ? entry.fieldCodegenLocators[fieldIndex] : null)
      || field.codegenLocator
      || (Array.isArray(entry.fieldLocatorDiagnostics) ? entry.fieldLocatorDiagnostics[fieldIndex] : null)
      || field.locatorDiagnostic
      || (Array.isArray(entry.args?.fields) && entry.args.fields.length === 1 ? (entry.actionLocator || entry.codegenLocator || entry.locatorDiagnostic) : null)
      || null;
  }
  return entry.actionLocator || entry.codegenLocator || entry.locatorDiagnostic || entry.qaaiActionLocator || null;
}

function buildLocatorRecord({ runResultId, testCaseId, sequenceIndex, contractStepId, locator }) {
  const recipe = executionAuthoringCompiler.buildLocatorRecipe(locator);
  if (!recipe) return null;
  const primaryExpression = recipe.primaryExpression || recipe.frameworkExpressions?.playwright || null;
  return {
    id: makeId('locrec', `${runResultId}:${sequenceIndex}:${primaryExpression || recipe.id}`),
    runResultId,
    testCaseId,
    sequenceIndex,
    contractStepId,
    source: recipe.source || recipe.proof?.source || null,
    expressionByFramework: encodeJson(recipe.frameworkExpressions || {}),
    primaryExpression,
    strategy: recipe.strategy || null,
    countBefore: Number.isFinite(recipe.proof?.count) ? recipe.proof.count : null,
    countAfter: Number.isFinite(recipe.proof?.count) ? recipe.proof.count : null,
    sameElementProof: recipe.proof?.sameElement === true,
    visible: recipe.proof?.visible == null ? null : !!recipe.proof.visible,
    enabled: recipe.proof?.enabled == null ? null : !!recipe.proof.enabled,
    editableWhenRequired: null,
    framePathJson: recipe.context?.framePath ? encodeJson(recipe.context.framePath) : null,
    shadowPathJson: recipe.context?.shadowPath ? encodeJson(recipe.context.shadowPath) : null,
    locatorRecipeJson: encodeJson(recipe),
    _recipe: recipe,
  };
}

function replayActionCount(replayEnvelope) {
  const steps = replayEnvelope?.ir?.steps || replayEnvelope?.steps || [];
  if (!Array.isArray(steps)) return 0;
  return steps.filter((step) => step && (step.op === 'act' || step.op === 'assert')).length;
}

function compiledActionCount(actionGraph) {
  const nodes = actionGraph?.nodes || actionGraph?.actions || [];
  if (!Array.isArray(nodes)) return 0;
  return nodes.filter((node) => node && node.exportable !== false && !/utility|readback/i.test(textOf(node.kind || node.type))).length;
}

function plannedExecutableCount(executionContract, fallbackCount) {
  const nodes = executionContract?.nodes || [];
  if (!Array.isArray(nodes) || !nodes.length) return fallbackCount;
  return nodes.filter((node) => {
    if (!node) return false;
    if (node.exportable === false || node.manualGate === true) return false;
    const kind = textOf(node.kind || node.type || node.action || node.toolName);
    return kind && !/utility|snapshot|wait|readback/i.test(kind);
  }).length;
}

function plannedAssertionCount(testCase, executionContract) {
  const declared = Array.isArray(testCase?.declaredAssertions) ? testCase.declaredAssertions : [];
  if (declared.length) return declared.length;
  const nodes = executionContract?.nodes || [];
  if (!Array.isArray(nodes)) return 0;
  return nodes.filter((node) => /assert|verify|oracle/i.test(textOf(node?.kind || node?.type || node?.action))).length;
}

function assertionOutcomeHasParseFailure(item) {
  const text = [
    item?.status,
    item?.outcome,
    item?.effective,
    item?.reason,
    item?.error,
    item?.parseStatus,
    item?.evidence,
  ].map(textOf).join(' ');
  return /parse[_\s-]?failed|invalid[_\s-]?assertion|malformed|unparseable|unparsed/i.test(text);
}

function assertionEvidenceIsConcrete(item) {
  if (!item) return false;
  if (assertionOutcomeHasParseFailure(item)) return false;
  if (item.expected == null && item.actual == null && item.evidence == null) return false;
  if (/placeholder|todo|unknown|as expected|page ready/i.test(`${item.expected || ''} ${item.actual || ''}`)) return false;
  return true;
}

function buildAssertionEvidence({ runResultId, testCaseId, assertionOutcomes = [] }) {
  return (Array.isArray(assertionOutcomes) ? assertionOutcomes : []).map((item, index) => {
    const matched = item?.outcome === 'matched' || item?.matched === true || item?.effective === 'matched';
    const parseFailed = assertionOutcomeHasParseFailure(item);
    const concrete = assertionEvidenceIsConcrete(item);
    return {
      id: makeId('assert', `${runResultId}:${item?.assertionId || index}`),
      runResultId,
      testCaseId,
      assertionId: item?.assertionId || item?.id || null,
      sequenceIndex: index,
      kind: item?.kind || item?.assertionType || item?.type || null,
      locatorRecipeId: null,
      expectedJson: item?.expected == null ? null : encodeJson(item.expected),
      actualJson: item?.actual == null ? null : encodeJson(item.actual),
      matched,
      containerScopeJson: item?.containerScope ? encodeJson(item.containerScope) : null,
      source: item?.source || null,
      evidenceJson: encodeJson({
        schemaVersion: SCHEMA_VERSION,
        reason: item?.reason || null,
        evidence: item?.evidence || null,
        effective: item?.effective || null,
        parseFailed,
        concrete,
      }),
    };
  });
}

function assertionEvidenceIsComplete(row) {
  if (!row) return false;
  const evidence = parseMaybeJson(row.evidenceJson) || {};
  if (evidence.parseFailed === true) return false;
  if (evidence.concrete === false) return false;
  return row.expectedJson != null || row.actualJson != null || /"evidence":(?!null)/.test(row.evidenceJson || '');
}

function navigationEvidenceFor({ runResultId, testCaseId, entry, sequenceIndex }) {
  const args = entry.args || {};
  const requestedUrl = args.url || entry.requestedUrl || null;
  const resolvedUrl = entry.pageUrlAfter || entry.afterUrl || entry.pageUrl || entry.currentUrl || requestedUrl || null;
  const landing = entry.landingVerification && typeof entry.landingVerification === 'object'
    ? entry.landingVerification
    : null;
  const postNavigationOracle = entry.postNavigationOracle || (landing && landing.checked ? {
    kind: 'visible',
    source: 'landing_verification',
    target: landing.target || null,
    matched: landing.matched === true,
    reason: landing.reason || null,
  } : null);
  const loadStateProof = entry.loadStateProof
    || (landing && landing.matched === true ? 'landing_visible_confirmed' : null)
    || (entry.ok === false ? 'navigation_failed' : 'navigation_dispatched');
  return {
    id: makeId('nav', `${runResultId}:${sequenceIndex}:${requestedUrl || resolvedUrl || ''}`),
    runResultId,
    testCaseId,
    sequenceIndex,
    contractStepId: contractStepIdFor(entry),
    requestedUrl: requestedUrl == null ? null : String(requestedUrl),
    resolvedUrl: resolvedUrl == null ? null : String(resolvedUrl),
    redirectChainJson: entry.redirectChain ? encodeJson(entry.redirectChain) : null,
    allowedOriginProof: entry.allowedOriginProof || null,
    loadStateProof,
    postNavigationOracleJson: postNavigationOracle ? encodeJson(postNavigationOracle) : null,
    evidenceJson: encodeJson({
      schemaVersion: SCHEMA_VERSION,
      toolName: entry.tool,
      args: redactArgs(args),
      pageUrlBefore: entry.pageUrlBefore || null,
      pageUrlAfter: entry.pageUrlAfter || entry.pageUrl || null,
    }),
  };
}

function navigationEvidenceIsComplete(row) {
  if (!row) return false;
  return !!(
    row.requestedUrl
    && row.resolvedUrl
    && row.loadStateProof
    && !/^navigation_dispatched$/i.test(String(row.loadStateProof))
    && row.postNavigationOracleJson
  );
}

function actionEvidenceFor({ runResultId, testCaseId, entry, sequenceIndex, locatorRecipeId = null, valueRef = null, field = null, fieldIndex = null }) {
  const args = entry.args || {};
  const toolName = entry.tool || 'unknown';
  const fieldLabel = field && (field.element || field.label || field.name || field.placeholder || field.type);
  return {
    id: makeId('actev', `${runResultId}:${sequenceIndex}:${toolName}:${fieldIndex == null ? '' : fieldIndex}`),
    runResultId,
    testCaseId,
    sequenceIndex,
    contractStepId: contractStepIdFor(entry),
    actionAttemptId: entry.toolUseId || entry.id || `${runResultId}:${sequenceIndex}`,
    retryOfActionEvidenceId: entry.retryOfActionEvidenceId || null,
    stepId: entry.stepId || entry.contractStepId || entry.stepAuthoring?.id || null,
    toolName,
    actionKind: field ? 'fill' : actionKindFor(toolName),
    locatorRecipeId,
    valueRef,
    beforeSnapshotRef: snapshotRefFrom(entry.beforeSnapshot || entry.snapshotBefore || entry.pageSnippetBefore, null),
    actionSnapshotRef: entry.traceEventRef || entry.actionSnapshotRef || null,
    afterSnapshotRef: snapshotRefFrom(entry.afterSnapshot || entry.snapshotAfter || entry.pageSnippet, null),
    traceEventRef: entry.traceEventRef || null,
    transitionProofJson: transitionProofFor(entry) ? encodeJson(transitionProofFor(entry)) : null,
    assertionEvidenceId: null,
    authSetupEvidenceId: null,
    exportable: true,
    evidenceJson: encodeJson({
      schemaVersion: SCHEMA_VERSION,
      ok: entry.ok !== false,
      fieldIndex,
      fieldLabel: fieldLabel || null,
      pageUrl: entry.pageUrl || entry.pageUrlBefore || null,
      pageUrlAfter: entry.pageUrlAfter || null,
      args: redactArgs(field ? { ...field, value: field.value ?? field.text ?? field.input } : args),
      actionLocatorKernel: entry.actionLocatorKernel || entry.qaaiActionEvidence || null,
      actionLocatorGap: entry.actionLocatorGap || null,
      source: entry.source || entry.qaaiSource || null,
    }),
  };
}

function parseMaybeJson(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function findPostLoginOracle({ trail = [], assertionOutcomes = [], testCase = null } = {}) {
  const assertion = (Array.isArray(assertionOutcomes) ? assertionOutcomes : []).find((item) => {
    if (!assertionEvidenceIsConcrete(item)) return false;
    const text = `${item?.kind || ''} ${item?.expected || ''} ${item?.actual || ''} ${item?.reason || ''}`.toLowerCase();
    return /dashboard|home|welcome|signed\s*in|logged\s*in|portal|landing|post[-_\s]?login/.test(text);
  });
  if (assertion) {
    return {
      source: 'assertion_evidence',
      assertionId: assertion.assertionId || assertion.id || null,
      expected: assertion.expected ?? null,
      actual: assertion.actual ?? null,
      matched: assertion.matched === true || assertion.outcome === 'matched' || assertion.effective === 'matched',
    };
  }
  const trailEntry = (Array.isArray(trail) ? trail : []).find((entry) => {
    const text = `${entry?.pageUrlAfter || entry?.pageUrl || ''} ${entry?.stepOperationCheck || ''} ${entry?.observation || ''} ${entry?.resultText || ''}`;
    return /dashboard|home|welcome|portal|post[-_\s]?login/i.test(text);
  });
  if (trailEntry) {
    return {
      source: 'trail',
      pageUrl: trailEntry.pageUrlAfter || trailEntry.pageUrl || null,
      observation: trailEntry.observation || trailEntry.resultText || trailEntry.stepOperationCheck || null,
    };
  }
  const declared = Array.isArray(testCase?.declaredAssertions) ? testCase.declaredAssertions : [];
  const declaredOracle = declared.find((item) => /dashboard|home|welcome|portal|post[-_\s]?login/i.test(`${item?.kind || ''} ${item?.expected || ''} ${item?.text || ''}`));
  if (declaredOracle) {
    return {
      source: 'declared_assertion',
      assertionId: declaredOracle.id || declaredOracle.assertionId || null,
      expected: declaredOracle.expected || declaredOracle.text || null,
    };
  }
  return null;
}

function authRequiredForRun({ testCase = null, trail = [], actionEvidences = [] } = {}) {
  return authSessionManager.authRequiredForRun({ testCase, trail, actionEvidences });
}

function authSetupEvidenceIsComplete(row) {
  return authSessionManager.authSetupEvidenceIsComplete(row);
}

function inferAuthSetupEvidence({ runResultId, testCase, actionEvidences, trail, assertionOutcomes = [] }) {
  const row = authSessionManager.buildAuthSetupEvidenceRow({
    id: makeId('auth', `${runResultId}:${testCase?.authProfile || testCase?.authProfileId || 'inferred'}`),
    runResultId,
    testCase,
    actionEvidences,
    trail,
    assertionOutcomes,
    encodeJson,
    schemaVersion: SCHEMA_VERSION,
  });
  return row ? [row] : [];
}

function buildEvidenceFromTrail({
  runResultId,
  testCase,
  status,
  trail = [],
  executionContract = null,
  replayEnvelope = null,
  actionGraph = null,
  assertionOutcomes = [],
  screenshots = [],
  liveScriptLedger = null,
} = {}) {
  const locatorRecipes = [];
  const actionEvidences = [];
  const navigationEvidences = [];
  const scriptLedger = liveScriptRecorder.rebindLedger(
    liveScriptLedger || liveScriptRecorder.newLedger({
      runResultId,
      testCaseId: testCase?.id || null,
      scriptMode: liveScriptRecorder.scriptModeForStatus(status),
    }),
    {
      runResultId,
      testCaseId: testCase?.id || null,
      scriptMode: liveScriptRecorder.scriptModeForStatus(status),
    },
  );
  const shouldBuildLedgerFromTrail = !liveScriptLedger;
  let manualGateCount = 0;
  let sequenceIndex = 0;

  for (const entry of Array.isArray(trail) ? trail : []) {
    if (!entry || typeof entry !== 'object') continue;
    const toolName = entry.tool || entry.toolName;
    if (!toolName) continue;
    if (shouldBuildLedgerFromTrail) {
      liveScriptRecorder.appendScriptLine(scriptLedger, {
        trailEntry: entry,
        runResultId,
        testCaseId: testCase?.id || null,
        source: 'buildEvidenceFromTrail',
      });
    }
    if (isManualGate(entry)) manualGateCount += 1;
    if (!isExportableTool(toolName, entry)) continue;
    if (toolName === 'browser_navigate') {
      navigationEvidences.push(navigationEvidenceFor({ runResultId, testCaseId: testCase?.id || null, entry, sequenceIndex }));
      actionEvidences.push(actionEvidenceFor({ runResultId, testCaseId: testCase?.id || null, entry, sequenceIndex }));
      sequenceIndex += 1;
      continue;
    }
    if (toolName === 'assertion_check') {
      actionEvidences.push(actionEvidenceFor({ runResultId, testCaseId: testCase?.id || null, entry, sequenceIndex }));
      sequenceIndex += 1;
      continue;
    }
    if (toolName === 'browser_fill_form' && Array.isArray(entry.args?.fields)) {
      entry.args.fields.forEach((field, fieldIndex) => {
        const locator = locatorFromEntry(entry, field, fieldIndex);
        const locatorRecord = buildLocatorRecord({
          runResultId,
          testCaseId: testCase?.id || null,
          sequenceIndex,
          contractStepId: contractStepIdFor(entry),
          locator,
        });
        if (locatorRecord) locatorRecipes.push(locatorRecord);
        actionEvidences.push(actionEvidenceFor({
          runResultId,
          testCaseId: testCase?.id || null,
          entry,
          sequenceIndex,
          locatorRecipeId: locatorRecord?.id || null,
          valueRef: valueRefFor({ value: field.value ?? field.text ?? field.input, label: field.element || field.label || field.name || field.type, index: fieldIndex, source: 'field' }),
          field,
          fieldIndex,
        }));
        sequenceIndex += 1;
      });
      continue;
    }
    const locator = locatorFromEntry(entry);
    const locatorRecord = buildLocatorRecord({
      runResultId,
      testCaseId: testCase?.id || null,
      sequenceIndex,
      contractStepId: contractStepIdFor(entry),
      locator,
    });
    if (locatorRecord) locatorRecipes.push(locatorRecord);
    actionEvidences.push(actionEvidenceFor({
      runResultId,
      testCaseId: testCase?.id || null,
      entry,
      sequenceIndex,
      locatorRecipeId: locatorRecord?.id || null,
      valueRef: valueRefFor({ value: entry.args?.value ?? entry.args?.text ?? entry.args?.input, label: entry.args?.element || entry.args?.label || entry.args?.name || toolName, source: 'arg' }),
    }));
    sequenceIndex += 1;
  }

  const assertionEvidences = buildAssertionEvidence({
    runResultId,
    testCaseId: testCase?.id || null,
    assertionOutcomes,
  });
  const authSetupEvidences = inferAuthSetupEvidence({ runResultId, testCase, actionEvidences, trail, assertionOutcomes });
  const traceArtifacts = [];
  if (Array.isArray(screenshots)) {
    screenshots.filter(Boolean).slice(0, 50).forEach((path, index) => {
      traceArtifacts.push({
        id: makeId('trace', `${runResultId}:screenshot:${index}:${path}`),
        runResultId,
        testCaseId: testCase?.id || null,
        artifactType: 'screenshot',
        path: String(path),
        contentHash: null,
        redactionJson: null,
        expiresAt: null,
        artifactJson: encodeJson({ schemaVersion: SCHEMA_VERSION, index }),
      });
    });
  }

  const locatorRequiredActions = actionEvidences.filter((item) => !['navigate', 'assert'].includes(item.actionKind));
  const missingLocatorCount = locatorRequiredActions.filter((item) => !item.locatorRecipeId).length;
  const plannedAssertions = plannedAssertionCount(testCase, executionContract);
  const completeAssertionEvidences = assertionEvidences.filter(assertionEvidenceIsComplete);
  const parseFailedAssertionCount = assertionEvidences.filter((item) => {
    const evidence = parseMaybeJson(item.evidenceJson) || {};
    return evidence.parseFailed === true;
  }).length;
  const finalAssertions = completeAssertionEvidences.filter((item) => item.matched || /final|must|oracle/i.test(item.evidenceJson || '')).length;
  const replayCount = replayActionCount(replayEnvelope);
  const graphCount = compiledActionCount(actionGraph);
  const plannedCount = plannedExecutableCount(executionContract, actionEvidences.length);
  const missingActionEvidenceCount = Math.max(0, plannedCount - actionEvidences.length);
  const assertionEvidenceRequired = featureFlags.enabled('assertionEvidenceRequired', true);
  const missingAssertionCount = assertionEvidenceRequired
    ? Math.max(Math.max(0, plannedAssertions - completeAssertionEvidences.length), parseFailedAssertionCount)
    : 0;
  const missingNavigationEvidenceCount = navigationEvidences.filter((item) => !navigationEvidenceIsComplete(item)).length;
  const authRequired = authRequiredForRun({ testCase, trail, actionEvidences });
  const authSetupEvidenceRequired = featureFlags.enabled('authSetupEvidenceRequired', true);
  const missingAuthSetupCount = authSetupEvidenceRequired && authRequired && !authSetupEvidences.some(authSetupEvidenceIsComplete) ? 1 : 0;
  const missingEvidenceCount = missingActionEvidenceCount + missingLocatorCount + missingAssertionCount + missingNavigationEvidenceCount + missingAuthSetupCount;
  const evidenceStatus = missingEvidenceCount === 0 ? 'complete' : 'capture_failed';
  const executionStatus = status === 'pass' ? 'passed' : status === 'fail' ? 'failed' : status === 'skipped' ? 'blocked' : 'blocked';
  const overallRunStatus = evidenceStatus === 'complete' ? 'complete' : 'evidence_capture_failed';
  const scriptStatus = replayEnvelope?.complete === true && missingEvidenceCount === 0 ? 'generated' : 'validation_failed';
  const ledger = {
    schemaVersion: 'qaai-evidence-completeness-ledger-v1',
    runResultId,
    testCaseId: testCase?.id || null,
    plannedExecutableStepCount: plannedCount,
    actionEvidenceCount: actionEvidences.length,
    replayIrActionCount: replayCount,
    compiledActionCount: graphCount,
    generatedMethodCount: 0,
    validatedActionCount: 0,
    plannedAssertionCount: plannedAssertions,
    assertionEvidenceCount: completeAssertionEvidences.length,
    rawAssertionEvidenceCount: assertionEvidences.length,
    finalAssertionEvidenceCount: finalAssertions,
    missingEvidenceCount,
    manualGateCount,
    evidenceStatus,
    executionStatus,
    overallRunStatus,
    scriptStatus,
    missingLocatorCount,
    missingActionEvidenceCount,
    missingAssertionCount,
    parseFailedAssertionCount,
    missingNavigationEvidenceCount,
    missingAuthSetupCount,
    authRequired,
    utilityActionCount: (Array.isArray(trail) ? trail : []).filter((entry) => isUtilityTool(entry?.tool)).length,
    scriptMode: scriptLedger.scriptMode,
    scriptHealth: scriptLedger.health?.scriptHealth || null,
    scriptConfidence: scriptLedger.health?.scriptConfidence || null,
    locatorStability: scriptLedger.health?.locatorStability || null,
    weakLocatorCount: scriptLedger.health?.weakLocatorCount || 0,
    nonRunnableLineCount: scriptLedger.health?.nonRunnableLineCount || 0,
    liveScriptLedger: scriptLedger,
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    runResultId,
    testCaseId: testCase?.id || null,
    locatorRecipes,
    actionEvidences,
    assertionEvidences,
    authSetupEvidences,
    traceArtifacts,
    navigationEvidences,
    ledger,
    liveScriptLedger: scriptLedger,
    statuses: { overallRunStatus, executionStatus, evidenceStatus, scriptStatus },
  };
}

async function callPrisma(prisma, delegateName, method, payload) {
  const delegate = prisma?.[delegateName];
  if (!delegate || typeof delegate[method] !== 'function') {
    throw new Error(`Capture-first persistence unavailable: missing prisma.${delegateName}.${method}. Run prisma generate and apply the capture-first migration.`);
  }
  try {
    return await delegate[method](payload);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    throw new Error(`Capture-first persistence failed at prisma.${delegateName}.${method}: ${message}`);
  }
}

async function persistRows(prisma, delegateName, rows) {
  if (!Array.isArray(rows) || !rows.length) return;
  for (const row of rows) {
    const clean = { ...row };
    delete clean._recipe;
    await callPrisma(prisma, delegateName, 'create', { data: clean });
  }
}

async function persistShadowEvidenceRows(prisma, built, ledgerRow) {
  await callPrisma(prisma, 'runResult', 'update', {
    where: { id: built.runResultId },
    data: {
      overallRunStatus: built.statuses.overallRunStatus,
      executionStatus: built.statuses.executionStatus,
      evidenceStatus: built.statuses.evidenceStatus,
      scriptStatus: built.statuses.scriptStatus,
      evidenceCompletenessJson: encodeJson(built.ledger),
    },
  });
  await callPrisma(prisma, 'locatorRecipe', 'deleteMany', { where: { runResultId: built.runResultId } });
  await callPrisma(prisma, 'actionEvidence', 'deleteMany', { where: { runResultId: built.runResultId } });
  await callPrisma(prisma, 'assertionEvidence', 'deleteMany', { where: { runResultId: built.runResultId } });
  await callPrisma(prisma, 'authSetupEvidence', 'deleteMany', { where: { runResultId: built.runResultId } });
  await callPrisma(prisma, 'traceArtifact', 'deleteMany', { where: { runResultId: built.runResultId } });
  await callPrisma(prisma, 'navigationEvidence', 'deleteMany', { where: { runResultId: built.runResultId } });
  await callPrisma(prisma, 'evidenceCompletenessLedger', 'deleteMany', { where: { runResultId: built.runResultId } });
  await persistRows(prisma, 'locatorRecipe', built.locatorRecipes);
  await persistRows(prisma, 'actionEvidence', built.actionEvidences);
  await persistRows(prisma, 'assertionEvidence', built.assertionEvidences);
  await persistRows(prisma, 'authSetupEvidence', built.authSetupEvidences);
  await persistRows(prisma, 'traceArtifact', built.traceArtifacts);
  await persistRows(prisma, 'navigationEvidence', built.navigationEvidences);
  await persistRows(prisma, 'evidenceCompletenessLedger', [ledgerRow]);
}

async function persistShadowEvidence({
  prisma,
  runResultId,
  testCase,
  status,
  trail,
  executionContract,
  replayEnvelope,
  actionGraph,
  assertionOutcomes,
  screenshots,
  liveScriptLedger = null,
} = {}) {
  if (!runResultId) return null;
  if (featureFlags.enabled('recordExecutableActionRequired', true) && !envFlagOn('QAAI_ALLOW_DIRECT_ACTION_TRAIL_LEGACY')) {
    assertNoDirectExecutableTrailAppend(trail);
  }
  const sharedLiveScriptLedger = liveScriptLedger || getLiveScriptLedgerForTrail(trail);
  const built = buildEvidenceFromTrail({
    runResultId,
    testCase,
    status,
    trail,
    executionContract,
    replayEnvelope,
    actionGraph,
    assertionOutcomes,
    screenshots,
    liveScriptLedger: sharedLiveScriptLedger,
  });

  const ledgerRow = {
    id: makeId('ledger', `${runResultId}:${stableStringify(built.ledger)}`),
    runResultId,
    testCaseId: built.testCaseId,
    plannedExecutableStepCount: built.ledger.plannedExecutableStepCount,
    actionEvidenceCount: built.ledger.actionEvidenceCount,
    replayIrActionCount: built.ledger.replayIrActionCount,
    compiledActionCount: built.ledger.compiledActionCount,
    generatedMethodCount: built.ledger.generatedMethodCount,
    validatedActionCount: built.ledger.validatedActionCount,
    plannedAssertionCount: built.ledger.plannedAssertionCount,
    assertionEvidenceCount: built.ledger.assertionEvidenceCount,
    finalAssertionEvidenceCount: built.ledger.finalAssertionEvidenceCount,
    missingEvidenceCount: built.ledger.missingEvidenceCount,
    manualGateCount: built.ledger.manualGateCount,
    ledgerJson: encodeJson(built.ledger),
  };

  if (prisma) {
    if (typeof prisma.$transaction === 'function') {
      await prisma.$transaction((tx) => persistShadowEvidenceRows(tx, built, ledgerRow));
    } else {
      await persistShadowEvidenceRows(prisma, built, ledgerRow);
    }
  }
  return built;
}

function recordExecutableAction(input = {}) {
  const trailEntry = input.trailEntry || input.entry || input;
  const result = input.result || null;
  const propagated = propagateActionEvidenceFields(trailEntry, result || {});
  if (input.liveScriptLedger && trailEntry && typeof trailEntry === 'object' && input.appendLiveScriptLine !== false) {
    liveScriptRecorder.appendScriptLine(input.liveScriptLedger, {
      trailEntry,
      result,
      runResultId: input.runResultId || input.liveScriptLedger.runResultId || 'shadow',
      testCaseId: input.testCase?.id || input.liveScriptLedger.testCaseId || null,
      source: input.source || 'recordExecutableAction',
    });
  }
  const built = buildEvidenceFromTrail({
    runResultId: input.runResultId || 'shadow',
    testCase: input.testCase || null,
    status: input.status || 'blocked',
    trail: [trailEntry],
    executionContract: input.executionContract || null,
    replayEnvelope: input.replayEnvelope || null,
    actionGraph: input.actionGraph || null,
    assertionOutcomes: input.assertionOutcomes || [],
    liveScriptLedger: input.liveScriptLedger || null,
  });
  if (isObject(trailEntry)) {
    const toolName = trailEntry.tool || trailEntry.toolName;
    const exportable = isExportableTool(toolName, trailEntry);
    const scriptLedger = built.liveScriptLedger;
    trailEntry.captureFirst = {
      schemaVersion: CHOKEPOINT_SCHEMA_VERSION,
      recorded: true,
      recordedAt: new Date().toISOString(),
      exportable,
      actionEvidenceComplete: built.ledger.missingEvidenceCount === 0,
      evidenceStatus: built.ledger.evidenceStatus,
      actionEvidenceCount: built.ledger.actionEvidenceCount,
      locatorRecipeCount: built.locatorRecipes.length,
      missingEvidenceCount: built.ledger.missingEvidenceCount,
      missingLocatorCount: built.ledger.missingLocatorCount,
      missingAssertionCount: built.ledger.missingAssertionCount,
      propagated,
      scriptLineId: trailEntry.liveScriptLine && trailEntry.liveScriptLine.id || null,
      scriptMode: scriptLedger.scriptMode,
      scriptHealth: scriptLedger.health && scriptLedger.health.scriptHealth || null,
      locatorStability: scriptLedger.health && scriptLedger.health.locatorStability || null,
    };
    built.scriptLedger = scriptLedger;
  }
  return built;
}

function appendExecutableTrailEntry({
  actionTrail,
  entry,
  result = null,
  runResultId = 'shadow',
  testCase = null,
  status = 'blocked',
  executionContract = null,
  replayEnvelope = null,
  actionGraph = null,
  assertionOutcomes = [],
  liveScriptLedger = null,
} = {}) {
  if (!Array.isArray(actionTrail)) {
    throw new Error('appendExecutableTrailEntry requires an actionTrail array');
  }
  const built = recordExecutableAction({
    runResultId,
    testCase,
    status,
    trailEntry: entry,
    result,
    executionContract,
    replayEnvelope,
    actionGraph,
    assertionOutcomes,
    liveScriptLedger: liveScriptLedger || getOrCreateLiveScriptLedgerForTrail(actionTrail, { runResultId, testCase, status }),
  });
  actionTrail.push(entry);
  return built;
}

function kernelAppendTrail(input = {}) {
  return appendExecutableTrailEntry(input);
}

function createLiveScriptLedger({ runResultId = 'shadow', testCase = null, status = 'blocked' } = {}) {
  return liveScriptRecorder.newLedger({
    runResultId,
    testCaseId: testCase?.id || null,
    scriptMode: liveScriptRecorder.scriptModeForStatus(status),
  });
}

function getLiveScriptLedgerForTrail(actionTrail) {
  return Array.isArray(actionTrail) ? liveScriptLedgerByTrail.get(actionTrail) || null : null;
}

function getOrCreateLiveScriptLedgerForTrail(actionTrail, { runResultId = 'shadow', testCase = null, status = 'blocked' } = {}) {
  if (!Array.isArray(actionTrail)) return null;
  const existing = liveScriptLedgerByTrail.get(actionTrail);
  if (existing) return existing;
  const created = createLiveScriptLedger({ runResultId, testCase, status });
  liveScriptLedgerByTrail.set(actionTrail, created);
  return created;
}

function assertNoDirectExecutableTrailAppend(trail = [], options = {}) {
  const allowLegacy = options.allowLegacy === true;
  if (allowLegacy) return true;
  const offenders = [];
  for (const entry of Array.isArray(trail) ? trail : []) {
    if (!entry || typeof entry !== 'object') continue;
    const toolName = entry.tool || entry.toolName;
    if (!isExportableTool(toolName, entry)) continue;
    if (entry.captureFirst?.recorded === true) continue;
    offenders.push({
      tool: toolName,
      stepIndex: entry.stepIndex ?? null,
      toolUseId: entry.toolUseId || null,
    });
  }
  if (offenders.length) {
    const preview = offenders.slice(0, 5).map((item) => `${item.tool}@${item.stepIndex ?? '?'}`).join(', ');
    const error = new Error(`Executable action trail entries bypassed recordExecutableAction: ${preview}`);
    error.code = 'ACTION_EVIDENCE_CHOKEPOINT_BYPASSED';
    error.offenders = offenders;
    throw error;
  }
  return true;
}

function normalizeRunEvidenceStatus(runResult = {}) {
  if (!runResult || typeof runResult !== 'object') {
    return {
      overallRunStatus: 'diagnostic_only',
      executionStatus: 'blocked',
      evidenceStatus: 'capture_failed',
      scriptStatus: 'validation_failed',
      diagnosticOnly: true,
    };
  }
  const hasCaptureFirstEvidence = !!(
    runResult.evidenceCompletenessJson
    || runResult.evidenceStatus
    || runResult.overallRunStatus
    || (Array.isArray(runResult.actionEvidences) && runResult.actionEvidences.length)
    || (Array.isArray(runResult.evidenceCompletenessLedgers) && runResult.evidenceCompletenessLedgers.length)
  );
  if (!hasCaptureFirstEvidence) {
    return {
      overallRunStatus: 'diagnostic_only',
      executionStatus: runResult.status === 'pass' ? 'passed' : runResult.status === 'fail' ? 'failed' : 'blocked',
      evidenceStatus: 'capture_failed',
      scriptStatus: 'validation_failed',
      diagnosticOnly: true,
    };
  }
  return {
    overallRunStatus: runResult.overallRunStatus || (runResult.evidenceStatus === 'complete' ? 'complete' : 'evidence_capture_failed'),
    executionStatus: runResult.executionStatus || (runResult.status === 'pass' ? 'passed' : runResult.status === 'fail' ? 'failed' : 'blocked'),
    evidenceStatus: runResult.evidenceStatus || 'capture_failed',
    scriptStatus: runResult.scriptStatus || 'validation_failed',
    diagnosticOnly: false,
  };
}

module.exports = {
  SCHEMA_VERSION,
  CHOKEPOINT_SCHEMA_VERSION,
  EXPORTABLE_TOOLS,
  UTILITY_TOOLS,
  buildEvidenceFromTrail,
  persistShadowEvidence,
  recordExecutableAction,
  appendExecutableTrailEntry,
  kernelAppendTrail,
  createLiveScriptLedger,
  getLiveScriptLedgerForTrail,
  assertNoDirectExecutableTrailAppend,
  propagateActionEvidenceFields,
  normalizeRunEvidenceStatus,
  isExportableTool,
};
