'use strict';

const crypto = require('crypto');
const actionLocatorResolver = require('./actionLocatorResolver');
const locatorIntelligenceV2 = require('./locatorIntelligenceV2');

const LOCATOR_RECIPE_SCHEMA_VERSION = 'qaai-locator-recipe-v1';
const STEP_AUTHORING_SCHEMA_VERSION = 'qaai-step-authoring-v1';
const STEP_INTENT_HASH_VERSION = 'qaai-step-intent-v1';
const ACTION_IDENTITY_SCHEMA_VERSION = 'qaai-action-identity-v1';

const MUTATING_ELEMENT_TOOLS = actionLocatorResolver.MUTATING_ELEMENT_TOOLS;

const TOOL_TO_ACTION = {
  browser_click: 'click',
  browser_mouse_click: 'click',
  browser_click_xy: 'click',
  browser_double_click: 'doubleClick',
  // LEGACY-TRACE: conductor emits no browser_triple_click; this maps a historical
  // recorded trace to the 'tripleClick' action (→ codegen clickCount:3). Translation
  // of old traces only — it cannot cause a live browser_triple_click tool call.
  browser_triple_click: 'tripleClick',
  browser_type: 'fill',
  browser_fill: 'fill',
  browser_fill_form: 'fill',
  browser_select_option: 'selectOption',
  browser_select: 'selectOption',
  browser_hover: 'hover',
  browser_drag: 'drag',
  browser_file_upload: 'upload',
  browser_check: 'check',
  browser_uncheck: 'uncheck',
};

function clean(value, limit = 240) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return limit && text.length > limit ? text.slice(0, limit) : text;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function shortHash(value) {
  return sha256(value).slice(0, 16);
}

function routeKeyFromUrl(url) {
  if (!url) return '/';
  try {
    const parsed = new URL(String(url));
    return parsed.pathname || '/';
  } catch (_) {
    return String(url).replace(/[?#].*$/, '') || '/';
  }
}

function normalizeActionType(toolName) {
  return TOOL_TO_ACTION[String(toolName || '')] || String(toolName || '').replace(/^browser_/, '') || 'action';
}

function positiveSequence(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/**
 * Build the immutable identity for one authored action occurrence. The
 * sequence index is deliberately part of the identity: two consecutive
 * clicks on the same target are two actions, even when every semantic field
 * and locator is identical.
 */
function buildActionIdentity({
  testCaseId = null,
  contractStepId = null,
  authoredActionId = null,
  sequenceIndex = null,
  toolUseId = null,
  toolName = null,
  operation = null,
} = {}) {
  const caseId = clean(testCaseId, 180) || null;
  const contractId = clean(contractStepId, 180) || null;
  const sequence = positiveSequence(sequenceIndex, null);
  const tool = clean(toolName, 120) || null;
  const op = clean(operation || normalizeActionType(toolName), 80) || 'action';
  const useId = clean(toolUseId, 180) || null;
  const identitySeed = stableStringify({
    schemaVersion: ACTION_IDENTITY_SCHEMA_VERSION,
    caseId,
    contractStepId: contractId,
    sequenceIndex: sequence,
    toolName: tool,
    operation: op,
  });
  const actionId = clean(authoredActionId, 180) || `action_${shortHash(identitySeed)}`;
  return {
    schemaVersion: ACTION_IDENTITY_SCHEMA_VERSION,
    caseId,
    contractStepId: contractId,
    authoredActionId: actionId,
    sequenceIndex: sequence,
    toolUseId: useId,
    toolName: tool,
    operation: op,
    occurrenceKey: `${caseId || 'case'}:${contractId || 'step'}:${sequence == null ? 'sequence-unknown' : sequence}:${op}`,
  };
}

function primaryActionLocator(actionLocator) {
  return actionLocatorResolver.primaryActionLocator(actionLocator);
}

function expressionOf(actionLocator) {
  const primary = primaryActionLocator(actionLocator);
  return primary && (primary.frameworkExpressions?.playwright || primary.expression) || null;
}

function seleniumExpressionOf(actionLocator) {
  const primary = primaryActionLocator(actionLocator);
  return primary && primary.frameworkExpressions && primary.frameworkExpressions.selenium || null;
}

function normalizeTargetFacts(facts) {
  const source = facts && typeof facts === 'object' ? facts : {};
  const rawAccessibleName = clean(source.rawAccessibleName || source.accessibleName || source.text || source.name || '');
  const normalizedAccessibleName = actionLocatorResolver.cleanAccessibleName(
    source.normalizedAccessibleName || source.accessibleName || rawAccessibleName
  );
  return {
    tag: clean(source.tag || source.tagName || ''),
    role: clean(source.role || source.ariaRole || ''),
    rawAccessibleName: rawAccessibleName || null,
    normalizedAccessibleName: normalizedAccessibleName || null,
    accessibleName: normalizedAccessibleName || null,
    placeholder: actionLocatorResolver.cleanAccessibleName(source.placeholder || '') || null,
    label: actionLocatorResolver.cleanAccessibleName(source.label || source.labelText || '') || null,
    testId: clean(source.testId || source.dataTestId || source['data-testid'] || ''),
    nameAttr: clean(source.nameAttr || source.name || ''),
    title: actionLocatorResolver.cleanAccessibleName(source.title || '') || null,
    alt: actionLocatorResolver.cleanAccessibleName(source.alt || '') || null,
    type: clean(source.type || ''),
    href: clean(source.href || ''),
    id: clean(source.id || source.idAttr || ''),
    selector: clean(source.selector || ''),
    stableAttributes: source.stableAttributes && typeof source.stableAttributes === 'object' ? { ...source.stableAttributes } : {},
    testIds: source.testIds && typeof source.testIds === 'object' ? { ...source.testIds } : {},
  };
}

function normalizeContext(context) {
  const source = context && typeof context === 'object' ? context : {};
  const normalizePath = (value) => (Array.isArray(value) ? value : [])
    .map((item) => clean(item && typeof item === 'object' ? item.selector : item))
    .filter(Boolean)
    .slice(0, 8);
  const cloneChain = (value) => (Array.isArray(value) ? value : [])
    .slice(0, 16)
    .map((item) => (item && typeof item === 'object' ? { ...item } : item));
  const framePath = normalizePath(source.framePath || source.frameChain || source.frames);
  const shadowPath = normalizePath(
    source.shadowPath
      || source.shadowHostPath
      || source.shadowHostChain
      || source.shadowRoot?.shadowPath,
  );
  const frameChain = cloneChain(source.frameChain || source.cdpFramePath);
  const shadowHostChain = cloneChain(source.shadowHostChain || source.cdpShadowPath);
  const shadowRootChain = cloneChain(source.shadowRootChain || source.shadowRoots);
  return {
    formSelector: clean(source.formSelector || ''),
    formAction: clean(source.formAction || ''),
    tableSelector: clean(source.tableSelector || ''),
    rowSelector: clean(source.rowSelector || ''),
    rowText: actionLocatorResolver.cleanAccessibleName(source.rowText || '') || null,
    cardSelector: clean(source.cardSelector || ''),
    cardText: actionLocatorResolver.cleanAccessibleName(source.cardText || '') || null,
    dialogSelector: clean(source.dialogSelector || ''),
    dialogName: actionLocatorResolver.cleanAccessibleName(source.dialogName || '') || null,
    landmarkSelector: clean(source.landmarkSelector || source.sidebarSelector || ''),
    frameSelector: clean(source.frameSelector || framePath[framePath.length - 1] || ''),
    framePath,
    frameChain,
    framePathMissing: source.framePathMissing === true || source.frameSelectorMissing === true,
    shadowHostSelector: clean(source.shadowHostSelector || source.shadowRoot?.hostSelector || shadowPath[shadowPath.length - 1] || ''),
    shadowPath,
    shadowHostPath: shadowPath.slice(),
    shadowHostChain,
    shadowRootChain,
    shadowPathMissing: source.shadowPathMissing === true || source.shadowRoot?.shadowPathMissing === true,
    containerSelector: clean(source.containerSelector || ''),
    containerText: actionLocatorResolver.cleanAccessibleName(source.containerText || '') || null,
    parentRole: actionLocatorResolver.cleanAccessibleName(source.parentRole || '') || null,
    parentName: actionLocatorResolver.cleanAccessibleName(source.parentName || '') || null,
    nearbyText: Array.isArray(source.nearbyText)
      ? source.nearbyText.map((item) => actionLocatorResolver.cleanAccessibleName(item)).filter(Boolean).slice(0, 8)
      : [],
    pageAlias: clean(source.pageAlias || ''),
    tabAlias: clean(source.tabAlias || ''),
    popupIdentity: source.popupIdentity && typeof source.popupIdentity === 'object' ? { ...source.popupIdentity } : null,
    pageIdentity: source.pageIdentity && typeof source.pageIdentity === 'object' ? { ...source.pageIdentity } : null,
    frameIdentity: source.frameIdentity && typeof source.frameIdentity === 'object' ? { ...source.frameIdentity } : null,
    browserContextId: clean(source.browserContextId || ''),
    targetIdentity: source.targetIdentity && typeof source.targetIdentity === 'object' ? { ...source.targetIdentity } : null,
    actedNodeFingerprint: source.actedNodeFingerprint && typeof source.actedNodeFingerprint === 'object' ? { ...source.actedNodeFingerprint } : null,
    captureBinding: source.captureBinding && typeof source.captureBinding === 'object' ? { ...source.captureBinding } : null,
    containerScope: clean(source.containerScope || ''),
    repeatedFieldScope: clean(source.repeatedFieldScope || source.fieldScope || ''),
    contextTransition: source.contextTransition && typeof source.contextTransition === 'object' ? { ...source.contextTransition } : null,
  };
}

function locatorRecipeQuality(expression, primary) {
  const issues = [];
  if (!expression) issues.push('missing_expression');
  if (expression && expression.includes('.first()')) issues.push('uses_first');
  if (expression && /\[ref\s*=|locator\(\s*['"][^'"]*\[ref\s*=/i.test(expression)) issues.push('mcp_ref_leak');
  if (expression && actionLocatorResolver.containsGlyphContamination(expression)) issues.push('glyph_contamination');
  if (expression && /^getByRole\(\s*["'][^"']+["']\s*\)$/i.test(expression)) issues.push('role_only');
  if (primary && primary.strategy === 'role' && actionLocatorResolver.isGlyphOnlyName(primary.targetFacts?.accessibleName || primary.elementLabel)) {
    issues.push('glyph_only_role_name');
  }
  return {
    exportSafe: issues.length === 0,
    issues,
  };
}

function buildLocatorRecipe(actionLocator) {
  const primary = primaryActionLocator(actionLocator);
  if (!primary) return null;
  const expression = expressionOf(primary);
  const facts = normalizeTargetFacts(primary.targetFacts || {});
  const context = normalizeContext(primary.context || {});
  const proof = primary.proof && typeof primary.proof === 'object' ? primary.proof : {};
  const verified = actionLocatorResolver.isVerifiedActionLocator(primary);
  const quality = locatorRecipeQuality(expression, primary);
  const fingerprint = locatorIntelligenceV2.buildLocatorFingerprint({
    expression,
    strategy: primary.strategy || 'actionLocator',
    targetFacts: facts,
    context,
    pageUrl: primary.pageUrl,
  });
  const frameworkExpressions = {
    playwright: expression,
    ...(seleniumExpressionOf(primary) ? { selenium: seleniumExpressionOf(primary) } : {}),
  };
  const idSeed = stableStringify({
    expression,
    strategy: primary.strategy || null,
    facts: {
      role: facts.role,
      name: facts.normalizedAccessibleName,
      placeholder: facts.placeholder,
      testId: facts.testId,
      nameAttr: facts.nameAttr,
    },
    context,
  });
  return {
    schemaVersion: LOCATOR_RECIPE_SCHEMA_VERSION,
    id: `loc_${shortHash(idSeed)}`,
    kind: 'playwright',
    primaryExpression: expression,
    frameworkExpressions,
    strategy: primary.strategy || 'actionLocator',
    fingerprint,
    targetFacts: facts,
    context,
    proof: {
      count: proof.count ?? null,
      sameElement: proof.sameElement === true,
      visible: proof.visible ?? null,
      enabled: proof.enabled ?? null,
      verified,
      source: primary.verificationSource || primary.evidenceSource || proof.source || null,
      actionTimeResolved: proof.actionTimeResolved === true,
      resolutionMode: proof.resolutionMode || null,
      identityVerified: proof.identityVerified === true,
      targetIdentity: proof.targetIdentity && typeof proof.targetIdentity === 'object' ? { ...proof.targetIdentity } : null,
      matchedIdentity: proof.matchedIdentity && typeof proof.matchedIdentity === 'object' ? { ...proof.matchedIdentity } : null,
      stableAcrossSnapshots: proof.stableAcrossSnapshots === true,
      countBefore: Number.isFinite(Number(proof.countBefore)) ? Number(proof.countBefore) : null,
      countAfter: Number.isFinite(Number(proof.countAfter)) ? Number(proof.countAfter) : null,
    },
    source: primary.verificationSource || primary.evidenceSource || proof.source || null,
    verified,
    verificationStatus: verified ? 'verified' : 'unverified',
    guess: primary.guess && typeof primary.guess === 'object' ? { ...primary.guess } : null,
    actedNodeFingerprint: primary.actedNodeFingerprint || context.actedNodeFingerprint || null,
    targetIdentity: primary.targetIdentity || context.targetIdentity || proof.targetIdentity || null,
    contextEvidence: primary.contextEvidence && typeof primary.contextEvidence === 'object' ? { ...primary.contextEvidence } : null,
    exportSafe: quality.exportSafe && actionLocatorResolver.isExportSafeActionLocator(primary),
    qualityIssues: Array.from(new Set([...quality.issues, ...(verified ? [] : ['unverified_action_node'])])),
    candidates: Array.isArray(primary.allCandidates) ? primary.allCandidates.slice(0, 25) : [],
  };
}

function declaredStepText(declaredStep) {
  if (declaredStep == null) return '';
  if (typeof declaredStep === 'string') return clean(declaredStep);
  if (typeof declaredStep !== 'object') return clean(declaredStep);
  return clean(
    declaredStep.text || declaredStep.step || declaredStep.description || declaredStep.expected ||
    declaredStep.name || declaredStep.title ||
    [declaredStep.action, declaredStep.target || declaredStep.element || declaredStep.field].filter(Boolean).join(' ')
  );
}

function dataBindingFromArgs(args = {}, declaredStep = null) {
  const fromStep = declaredStep && typeof declaredStep === 'object'
    ? (declaredStep.dataBinding || declaredStep.data || declaredStep.bindings || null)
    : null;
  if (fromStep) return fromStep;
  if (args.dataRole) return { isDataBound: true, sourceColumn: args.dataRole, source: 'args.dataRole' };
  if (args.valueRef && /^data:/i.test(String(args.valueRef))) {
    return { isDataBound: true, sourceColumn: String(args.valueRef).replace(/^data:/i, ''), source: 'args.valueRef' };
  }
  if (Array.isArray(args.fields)) {
    const fields = args.fields
      .map((field) => field && (field.dataRole || field.type || field.name || field.label))
      .filter(Boolean)
      .map((column) => ({ column: String(column) }));
    if (fields.length) return { isDataBound: true, fields, source: 'args.fields' };
  }
  return { isDataBound: false, sourceColumn: null, literalValue: clean(args.text ?? args.value ?? '') || null };
}

function buildStepIntentHash({ toolName, args = {}, actionLocator = null, pageUrl = null, declaredStep = null } = {}) {
  const primary = primaryActionLocator(actionLocator) || {};
  const facts = normalizeTargetFacts(primary.targetFacts || {});
  const context = normalizeContext(primary.context || {});
  const hashParts = {
    version: STEP_INTENT_HASH_VERSION,
    actionType: normalizeActionType(toolName),
    routeKey: routeKeyFromUrl(pageUrl || primary.pageUrl),
    targetIdentity: {
      role: facts.role || null,
      accessibleName: facts.normalizedAccessibleName || null,
      placeholder: facts.placeholder || null,
      label: facts.label || null,
      testId: facts.testId || null,
      nameAttr: facts.nameAttr || null,
      title: facts.title || null,
      alt: facts.alt || null,
    },
    structuralAnchors: {
      formSelector: context.formSelector || null,
      formAction: context.formAction || null,
      tableSelector: context.tableSelector || null,
      rowText: context.rowText || null,
      cardSelector: context.cardSelector || null,
      dialogSelector: context.dialogSelector || null,
      landmarkSelector: context.landmarkSelector || null,
      nearbyText: context.nearbyText || [],
    },
    declaredTargetText: actionLocatorResolver.cleanAccessibleName(
      declaredStepText(declaredStep) || args.element || args.label || args.name || args.placeholder || ''
    ) || null,
  };
  const canonical = stableStringify(hashParts);
  return {
    version: STEP_INTENT_HASH_VERSION,
    hash: sha256(canonical),
    parts: hashParts,
  };
}

function snapshotDigest(text) {
  const cleaned = clean(text || '', 20_000);
  return cleaned ? sha256(cleaned) : null;
}

function buildTransitionProof({ beforeSnapshot = '', afterSnapshot = '', beforeUrl = null, afterUrl = null, result = null, actionType = null } = {}) {
  const beforeDigest = snapshotDigest(beforeSnapshot);
  const afterDigest = snapshotDigest(afterSnapshot);
  const urlChanged = !!beforeUrl && !!afterUrl && String(beforeUrl) !== String(afterUrl);
  const snapshotChanged = !!beforeDigest && !!afterDigest && beforeDigest !== afterDigest;
  const actionSucceeded = !(result && result.isError);
  const mutationRequired = ['click', 'doubleClick', 'tripleClick', 'selectOption', 'drag', 'upload', 'check', 'uncheck'].includes(String(actionType || ''));
  return {
    schemaVersion: 'qaai-transition-proof-v1',
    actionSucceeded,
    beforeUrl: beforeUrl || null,
    afterUrl: afterUrl || null,
    urlChanged,
    snapshotChanged,
    beforeSnapshotDigest: beforeDigest,
    afterSnapshotDigest: afterDigest,
    observedOutcome: urlChanged ? 'url_changed' : (snapshotChanged ? 'dom_changed' : (actionSucceeded ? 'action_completed_no_visible_delta' : 'action_failed')),
    mutationRequired,
    proofSatisfied: actionSucceeded && (!mutationRequired || urlChanged || snapshotChanged || ['fill', 'hover'].includes(String(actionType || ''))),
  };
}

function createDraft({
  testCaseId = null,
  plannedStepId = null,
  contractStepId = null,
  authoredActionId = null,
  sequenceIndex = null,
  toolUseId = null,
  operation = null,
  stepOrdinal = null,
  businessIntent = '',
  toolName,
  args = {},
  pageUrl = null,
  declaredStep = null,
  actionLocator = null,
} = {}) {
  const actionType = normalizeActionType(toolName);
  const intent = buildStepIntentHash({ toolName, args, actionLocator, pageUrl, declaredStep });
  const declared = declaredStep && typeof declaredStep === 'object' ? declaredStep : {};
  const stableContractStepId = contractStepId
    || plannedStepId
    || declared.contractStepId
    || declared.stepId
    || declared.id
    || (stepOrdinal != null ? String(stepOrdinal) : null);
  const stableSequence = positiveSequence(
    sequenceIndex
      ?? declared.sequenceIndex
      ?? declared.actionSequenceIndex
      ?? declared.occurrenceIndex
      ?? stepOrdinal,
    null
  );
  const actionIdentity = buildActionIdentity({
    testCaseId,
    contractStepId: stableContractStepId,
    authoredActionId: authoredActionId || declared.authoredActionId || declared.actionId,
    sequenceIndex: stableSequence,
    toolUseId: toolUseId || declared.toolUseId,
    toolName,
    operation: operation || actionType,
  });
  return {
    schemaVersion: STEP_AUTHORING_SCHEMA_VERSION,
    recordType: 'StepAuthoringDraft',
    id: `draft_${shortHash(stableStringify({ actionIdentity, intent: intent.hash }))}`,
    testCaseId,
    plannedStepId: plannedStepId || (stepOrdinal != null ? String(stepOrdinal) : null),
    contractStepId: actionIdentity.contractStepId,
    authoredActionId: actionIdentity.authoredActionId,
    sequenceIndex: actionIdentity.sequenceIndex,
    toolUseId: actionIdentity.toolUseId,
    operation: actionIdentity.operation,
    actionIdentity,
    stepOrdinal: stepOrdinal == null ? null : Number(stepOrdinal),
    businessIntent: clean(businessIntent || declaredStepText(declaredStep) || args.element || args.label || args.name || toolName, 300),
    actionType,
    toolName: toolName || null,
    pageUrl: pageUrl || null,
    stepIntentHashVersion: intent.version,
    stepIntentHash: intent.hash,
    hashParts: intent.parts,
    dataBinding: dataBindingFromArgs(args, declaredStep),
    status: 'draft',
  };
}

function commitAction({ draft, actionLocator, codegenLocator = null, result = null, beforeSnapshot = '', afterSnapshot = '', beforeUrl = null, afterUrl = null, actualToolCalls = [], pomMetadata = null, locatorIntelligenceV2Enabled = false, locatorEvidenceContext = null } = {}) {
  // Build the recipe from the GOLD actionLocator; if there is none (live-ref dispatch
  // or a nameless/custom element), fall back to an export-safe CODEGEN locator so the
  // certified graph still carries a per-step recipe instead of dropping to NONE /
  // requires_repair with no expression. The codegen fallback never satisfies the
  // `verifiedLocator` gate below (it is not gold), so `status` stays accurate while the
  // recipe — and therefore a runnable export — is preserved. Generic; no site strings.
  const locatorRecipe = buildLocatorRecipe(actionLocator) || buildLocatorRecipe(codegenLocator);
  const actionType = draft && draft.actionType || normalizeActionType(actualToolCalls[actualToolCalls.length - 1]?.toolName);
  const transitionProof = buildTransitionProof({ beforeSnapshot, afterSnapshot, beforeUrl, afterUrl, result, actionType });
  const verifiedLocator = !!locatorRecipe
    && locatorRecipe.proof.verified === true
    && locatorRecipe.proof.sameElement === true
    && locatorRecipe.proof.count === 1
    && locatorRecipe.exportSafe === true
    && actionLocatorResolver.isVerifiedActionLocator(actionLocator);
  const actionSucceeded = !(result && result.isError);
  const status = actionSucceeded && verifiedLocator ? 'captured' : 'requires_repair';
  const locatorEvidenceV2 = locatorIntelligenceV2Enabled
    ? locatorIntelligenceV2.buildLocatorEvidenceBundle({
      actionLocator,
      codegenLocator,
      toolName: draft?.toolName || actualToolCalls[actualToolCalls.length - 1]?.toolName || null,
      stepOrdinal: draft?.stepOrdinal ?? locatorEvidenceContext?.stepOrdinal ?? null,
      elementLabel: locatorEvidenceContext?.elementLabel || draft?.businessIntent || null,
      pageUrl: beforeUrl || draft?.pageUrl || locatorEvidenceContext?.pageUrl || null,
    })
    : null;
  const toolCalls = Array.isArray(actualToolCalls) ? actualToolCalls : [];
  const primaryToolCall = toolCalls.find((call) => call && (
    call.toolUseId || call.toolCallId || call.callId || call.id
  )) || toolCalls[toolCalls.length - 1] || null;
  const authoredIdentity = draft && draft.actionIdentity
    ? draft.actionIdentity
    : buildActionIdentity({
        testCaseId: draft && draft.testCaseId,
        contractStepId: draft && (draft.contractStepId || draft.plannedStepId),
        authoredActionId: draft && draft.authoredActionId,
        sequenceIndex: draft && (draft.sequenceIndex ?? draft.stepOrdinal),
        toolName: draft && draft.toolName,
        operation: actionType,
      });
  const runtimeIdentity = {
    ...authoredIdentity,
    toolUseId: clean(primaryToolCall && (
      primaryToolCall.toolUseId || primaryToolCall.toolCallId || primaryToolCall.callId || primaryToolCall.id
    ), 180) || authoredIdentity.toolUseId || null,
    runtimeActionId: `runtime_${shortHash(stableStringify({
      authoredActionId: authoredIdentity.authoredActionId,
      sequenceIndex: authoredIdentity.sequenceIndex,
      toolUseId: primaryToolCall && (
        primaryToolCall.toolUseId || primaryToolCall.toolCallId || primaryToolCall.callId || primaryToolCall.id
      ) || null,
      toolName: primaryToolCall && primaryToolCall.toolName || authoredIdentity.toolName,
      operation: actionType,
    }))}`,
  };
  return {
    ...(draft || createDraft({})),
    recordType: 'StepAuthoringRecord',
    id: `step_${shortHash(stableStringify({ actionIdentity: runtimeIdentity, locator: locatorRecipe && locatorRecipe.id, status }))}`,
    status,
    contractStepId: runtimeIdentity.contractStepId,
    authoredActionId: runtimeIdentity.authoredActionId,
    sequenceIndex: runtimeIdentity.sequenceIndex,
    toolUseId: runtimeIdentity.toolUseId,
    operation: runtimeIdentity.operation,
    actionIdentity: runtimeIdentity,
    actualToolCalls: toolCalls,
    locatorRecipe,
    ...(locatorEvidenceV2 ? { locatorEvidenceV2 } : {}),
    assertionContract: null,
    transitionProof,
    pomMetadata: pomMetadata || null,
    exportDecision: status === 'captured' ? 'committed_business_step' : 'internal_repair_required',
    reason: status === 'captured'
      ? 'Live action succeeded with clean same-element locator evidence.'
      : 'Live action did not produce clean committed authoring evidence.',
  };
}

function classifyTrailEntry(entry) {
  if (!entry || typeof entry !== 'object') return 'unknown';
  if (!MUTATING_ELEMENT_TOOLS.has(entry.tool)) return 'evidence_only';
  if (entry.stepAuthoring && entry.stepAuthoring.status === 'captured') return 'business_step';
  if (entry.ok === false) return 'failed_attempt';
  if (/popup|dialog|dismiss|close/i.test(clean(entry.narration || entry.args?.element || entry.args?.label || ''))) return 'popup_dismissal';
  return 'requires_repair';
}

function compileTrailAuthoringReport({ trail = [], plannedSteps = [] } = {}) {
  const records = [];
  const gaps = [];
  for (const [index, entry] of (trail || []).entries()) {
    if (!entry || !MUTATING_ELEMENT_TOOLS.has(entry.tool)) continue;
    const record = entry.stepAuthoring || null;
    const classification = classifyTrailEntry(entry);
    if (record) records.push(record);
    if (!record || record.status !== 'captured') {
      gaps.push({
        index,
        toolName: entry.tool,
        classification,
        elementLabel: clean(entry.args?.element || entry.args?.label || entry.args?.name || entry.narration || ''),
        pageUrl: entry.pageUrl || null,
        reason: record && record.reason || 'No committed StepAuthoringRecord was attached to this business action.',
      });
    }
  }
  return {
    schemaVersion: 'qaai-authoring-report-v1',
    plannedStepCount: Array.isArray(plannedSteps) ? plannedSteps.length : 0,
    businessActionCount: records.length,
    gapCount: gaps.length,
    records,
    gaps,
  };
}

module.exports = {
  LOCATOR_RECIPE_SCHEMA_VERSION,
  STEP_AUTHORING_SCHEMA_VERSION,
  STEP_INTENT_HASH_VERSION,
  ACTION_IDENTITY_SCHEMA_VERSION,
  TOOL_TO_ACTION,
  normalizeActionType,
  buildActionIdentity,
  buildLocatorRecipe,
  buildStepIntentHash,
  buildTransitionProof,
  createDraft,
  commitAction,
  classifyTrailEntry,
  compileTrailAuthoringReport,
};
