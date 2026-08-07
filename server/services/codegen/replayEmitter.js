'use strict';
/**
 * Mechanical ReplayIR emitter.
 *
 * Emits the FROZEN ReplayIR (validated by adapters/frameworkAdapter.js#validateReplayIR,
 * compiled by compileReplayIR) from what MCP ACTUALLY DID — the recorded tool trail
 * (toolResults via _replayTrace.reconstructTrail), the case's declared assertions, the
 * recorded assertion_check outcomes, and the case verdict. NOT from an LLM narrative of
 * what it thinks happened.
 *
 * Replay fidelity rules enforced here and by the validator:
 *  - recorded browser evidence is the executable authority          → trail/outcomes first
 *  - authored operations without an exact executed occurrence remain diagnostic findings
 *  - an executed locator action may use an annotated semantic fallback only when capture evidence is absent
 *  - sensitive act values use valueRef (env:/vault:/fixture:/masked:); explicit non-secret test inputs may stay literal
 *  - every evaluated assertion maps to its declared contract         → assert.contractRef = assertion.id
 *  - dataRows are ROLE-keyed (the P4↔P6 bridge), not Excel headers → fields keyed by role; masked/restricted → ref
 *  - auth binds to a first-class AuthProfile, not loose login text → ir.authProfile (resolved)
 *  - human input is an explicit IR disposition                     → humanInput {manual_gate|test_hook|unsupported}
 *  - a failed/blocked run keeps its verdict so export can't go green→ verdict.status = recorded status (preserved)
 *  - structural contract defects remain visible to the caller       → caller runs validateReplayIR/compileReplayIR
 *
 * Pure: no LLM, no prisma, no fs. The conductor / smoke pass the recorded facts in.
 */

// Stamped into the persisted envelope ({ir, complete, gaps, emittedAt, emitterVersion})
// so a stored IR can be re-validated against / re-emitted by a known emitter revision.
const EMITTER_VERSION = 'p6-emitter-1';
const actionLocatorResolver = require('../actionLocatorResolver');
const replayLocatorContract = require('./_verifiedActionLocator');
const browserActionRegistry = require('../browserActionRegistry');
const executionAuthoringCompiler = require('../executionAuthoringCompiler');
const locatorIntelligenceV2 = require('../locatorIntelligenceV2');
const pageAtlas = require('../pageAtlas');
const waitContractService = require('../waitContract');

const VALUE_ACTIONS = new Set(['fill', 'type', 'press', 'selectOption', 'upload']); // ACTIONS_REQUIRING_VALUE_REF
const NEEDS_LOCATOR = new Set([
  'click',
  'doubleClick',
  'tripleClick',
  'fill',
  'type',
  'selectOption',
  'press',
  'hover',
  'waitFor',
  'drag',
  'upload',
  'check',
  'uncheck',
]);

// MCP browser tool → ReplayIR act.action
const TOOL_ACTION = {
  browser_navigate: 'navigate',
  browser_navigate_back: 'navigateBack',
  browser_navigate_forward: 'navigateForward',
  browser_reload: 'reload',
  browser_refresh: 'reload',
  browser_wait_for: 'waitFor',
  browser_wait_for_selector: 'waitFor',
  browser_wait_for_state: 'waitFor',
  browser_wait_for_text: 'waitFor',
  browser_wait_for_url: 'waitFor',
  browser_click: 'click',
  browser_mouse_click: 'click',
  browser_click_xy: 'click',
  browser_double_click: 'doubleClick',
  // LEGACY-TRACE TRANSLATOR: conductor emits no browser_triple_click; this maps a
  // historical recorded trace to 'tripleClick' (→ Playwright clickCount:3) for export.
  browser_triple_click: 'tripleClick',
  browser_type: 'fill',
  browser_fill: 'fill',
  browser_fill_form: 'fill',
  browser_select_option: 'selectOption',
  browser_select: 'selectOption',
  browser_press_key: 'press',
  browser_hover: 'hover',
  browser_drag: 'drag',
  browser_file_upload: 'upload',
  browser_check: 'check',
  browser_uncheck: 'uncheck',
  browser_handle_dialog: 'handleDialog',
  browser_resize: 'resize',
  browser_close: 'close',
};
Object.assign(TOOL_ACTION, browserActionRegistry.replayToolActionMap());

// declaredAssertion.type → frozen assert.channel (ASSERT_CHANNELS)
const CHANNEL = {
  TEXT: 'UI_TEXT',
  UI_TEXT: 'UI_TEXT',
  ROLE: 'UI_ROLE',
  UI_ROLE: 'UI_ROLE',
  PAGE: 'PAGE',
  URL: 'URL',
  DOWNLOAD: 'DOWNLOAD',
  EVALUATE: 'EVALUATE',
  FORBIDDEN_TEXT: 'FORBIDDEN_TEXT',
  FORBIDDEN_ROLE: 'FORBIDDEN_ROLE',
  API: 'API',
  DB_READ: 'DB_READ',
  EMAIL_SMS: 'EMAIL_SMS',
  PDF: 'PDF',
  AUDIT_LOG: 'AUDIT_LOG',
  ASYNC_JOB: 'ASYNC_JOB',
};
const CHANNELS_REQUIRING_EXPECTED = new Set([
  'UI_TEXT',
  'UI_ROLE',
  'PAGE',
  'URL',
  'FORBIDDEN_TEXT',
  'FORBIDDEN_ROLE',
]);

const VERDICT = {
  pass: 'pass',
  fail: 'fail',
  blocked: 'blocked',
  needs_human: 'fail',
  skipped: 'skipped',
};
const ASSERT_OUTCOME = { matched: 'pass', not_matched: 'fail', uncheckable: 'fail' };

function locatorGapFromTrail(action, fallback = {}) {
  const gap =
    action && action.actionLocatorGap && typeof action.actionLocatorGap === 'object'
      ? action.actionLocatorGap
      : null;
  if (!gap) return null;
  return {
    code: gap.code || gap.type || 'locator_gap',
    type: gap.type || gap.code || 'locator_gap',
    reason: gap.reason || 'excavation_failed',
    where: action.tool || gap.toolName || fallback.where || 'mutating_action',
    pageUrl: action.pageUrl || action.pageUrlBefore || gap.pageUrl || null,
    narration: fallback.narration || gap.elementLabel || null,
    elementLabel: fallback.elementLabel || gap.elementLabel || null,
    ref: gap.ref || null,
    coordinate: gap.coordinate || null,
    strategiesTried: Array.isArray(gap.strategiesTried) ? gap.strategiesTried : [],
    transient: !!gap.transient,
    detail: gap.detail || 'No locator candidate verified count=1 and sameElement=true.',
  };
}

function isLocatorOnlyGap(gap) {
  const code = String((gap && (gap.code || gap.type)) || '').toLowerCase();
  return /locator|target_resolution|excavation/.test(code);
}

function normRefName(label) {
  return (
    String(label || 'field')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'FIELD'
  );
}

// Normalize a string for fuzzy role matching: lowercase, collapse spaces/hyphens/underscores.
// "First Name" → "firstname", "first_name" → "firstname", "username" → "username".
function normRole(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

// Resolve the data-row role for a fill step. Priority:
//   1. Exact match on fType (f.type from MCP) — handles architect-assigned semantic roles.
//   2. Label normalized match: "Username" → "username" ≈ role "username".
//   3. Value match for non-secret fields — last resort when label differs from role name.
// Returns the matching role key string or null.
function resolveDataRole(fType, label, enteredValue, dataRowFields, isSecret) {
  if (!dataRowFields || !Object.keys(dataRowFields).length) return null;
  if (fType && Object.prototype.hasOwnProperty.call(dataRowFields, fType)) return fType;
  const nl = normRole(label);
  if (nl) {
    for (const role of Object.keys(dataRowFields)) {
      if (normRole(role) === nl) return role;
    }
  }
  if (!isSecret && enteredValue != null && String(enteredValue).trim()) {
    const val = String(enteredValue).trim();
    for (const [role, fieldVal] of Object.entries(dataRowFields)) {
      if (String(fieldVal) === val) return role;
    }
  }
  return null;
}

// Safe JS identifier key for a data-row role.
function toSafeDataRole(role) {
  return (
    String(role)
      .replace(/[^a-zA-Z0-9]/g, '_')
      .replace(/^([0-9])/, '_$1')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || 'field'
  );
}

const INTERNAL_LOCATOR_ID_RE = /^(?:el(?:ement)?|ref|node|target|field)[_-]?\d+$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ELEMENT_NOUN_RE =
  /(?:button|field|textbox|input|link|tab|menu(?:item)?|icon|checkbox|radio|dropdown|combobox|option|heading|image|row|cell|dialog|target)$/i;

function isInternalLocatorIdentity(value) {
  const text = String(value || '').trim();
  return (
    !text ||
    INTERNAL_LOCATOR_ID_RE.test(text) ||
    UUID_RE.test(text) ||
    /^(?:[0-9a-f]{16,}|[a-z]+_[0-9a-f]{12,})$/i.test(text)
  );
}

function semanticCamelCase(value, fallback = 'pageElement') {
  const words = String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return fallback;
  const joined = words
    .map((word, index) => {
      const normalized = word.charAt(0).toUpperCase() + word.slice(1);
      return index === 0 ? normalized.charAt(0).toLowerCase() + normalized.slice(1) : normalized;
    })
    .join('');
  return /^[A-Za-z_$]/.test(joined) ? joined : `element${joined}`;
}

function locatorRoleNoun(role, action) {
  const normalized = String(role || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  const nouns = {
    textbox: 'Field',
    searchbox: 'Field',
    button: 'Button',
    link: 'Link',
    checkbox: 'Checkbox',
    radio: 'RadioButton',
    combobox: 'Dropdown',
    tab: 'Tab',
    menuitem: 'MenuItem',
    option: 'Option',
    heading: 'Heading',
    img: 'Image',
    image: 'Image',
    row: 'Row',
    cell: 'Cell',
    dialog: 'Dialog',
  };
  if (nouns[normalized]) return nouns[normalized];
  if (['fill', 'type', 'upload'].includes(action)) return 'Field';
  if (action === 'selectOption') return 'Dropdown';
  if (['check', 'uncheck'].includes(action)) return 'Checkbox';
  if (action === 'waitFor') return 'Target';
  return '';
}

function semanticLocatorRefBase({ label, action, roleHint, candidates = [], qualifier = '' } = {}) {
  const candidateRole = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => candidate && candidate.role)
    .find(Boolean);
  let phrase = String(label || '').trim();
  if (isInternalLocatorIdentity(phrase)) phrase = '';
  phrase = phrase
    .replace(
      /^\s*(?:click|double[- ]?click|triple[- ]?click|fill|enter|type|hover|select|choose|upload|check|uncheck|open|verify|assert|wait(?:\s+for)?|navigate(?:\s+to)?)\s+/i,
      '',
    )
    .replace(/["'`]+/g, ' ')
    .trim();
  const noun = locatorRoleNoun(roleHint || candidateRole, action);
  if (phrase && noun && !ELEMENT_NOUN_RE.test(phrase.replace(/[^A-Za-z0-9]+$/g, '')))
    phrase += ` ${noun}`;
  if (qualifier) phrase = `${phrase || action || 'page element'} ${qualifier}`;
  if (!phrase) phrase = `${action || 'page'} ${noun || 'element'}`;
  return semanticCamelCase(phrase, 'pageElement');
}

function createSemanticLocatorRefAllocator() {
  const counts = new Map();
  return (details) => {
    const base = semanticLocatorRefBase(details);
    const count = (counts.get(base) || 0) + 1;
    counts.set(base, count);
    return count === 1 ? base : `${base}${count}`;
  };
}

function dataFieldsOf(dataRow) {
  if (!dataRow || typeof dataRow !== 'object') return {};
  const fields =
    dataRow.fields && typeof dataRow.fields === 'object' && !Array.isArray(dataRow.fields)
      ? dataRow.fields
      : null;
  if (fields && Object.keys(fields).length) return fields;
  return dataRow.inputs && typeof dataRow.inputs === 'object' && !Array.isArray(dataRow.inputs)
    ? dataRow.inputs
    : fields || {};
}

function cloned(value) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return value;
  }
}

function waitObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function waitSources(value) {
  const source = waitObject(value);
  if (!source) return [];
  return [
    waitObject(source.syncState || source.sync_state),
    waitObject(source.operationCheck),
    waitObject(source.waitContract),
    source,
  ].filter(Boolean);
}

function waitNumber(value, { minimum = 0 } = {}) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? Math.floor(number) : null;
}

function waitMetadataFrom(...values) {
  const metadata = {};
  for (const value of values) {
    for (const source of waitSources(value)) {
      const timeoutMs = waitNumber(source.timeoutMs ?? source.timeout, { minimum: 0 });
      if (timeoutMs != null) metadata.timeoutMs = timeoutMs;
      const refreshAfterMs = waitNumber(source.refreshAfterMs, { minimum: 0 });
      if (refreshAfterMs != null) metadata.refreshAfterMs = refreshAfterMs;
      const pollMs = waitNumber(source.pollIntervalMs ?? source.pollMs, { minimum: 1 });
      if (pollMs != null) metadata.pollIntervalMs = pollMs;
      const stableObservations = waitNumber(source.stableObservations, { minimum: 1 });
      if (stableObservations != null) metadata.stableObservations = stableObservations;
      if (Object.prototype.hasOwnProperty.call(source, 'recovery')) {
        if (
          source.recovery &&
          (typeof source.recovery === 'object' || typeof source.recovery === 'string')
        ) {
          metadata.recovery = cloned(source.recovery);
        } else {
          delete metadata.recovery;
        }
      }
    }
  }
  return metadata;
}

function executedWaitContractFrom(entry, fallback = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const args = waitObject(entry.args) || {};
  const explicit = [
    args.waitContract,
    entry.waitContract,
    entry.operationCheck?.waitContract,
    entry.syncState?.waitContract,
  ].find((value) => waitObject(value));
  const action = String(TOOL_ACTION[entry.tool] || entry.action || '').trim();
  const waitTool = action === 'waitFor' || /^browser_wait_for(?:_|$)/.test(String(entry.tool || ''));
  if (!explicit && !waitTool && !Object.keys(fallback || {}).length) return null;
  const requestedState = args.state || args.waitState || entry.state || entry.waitState
    || entry.operationCheck?.kind || entry.syncState?.kind || null;
  const inferred = {
    ...fallback,
    ...(requestedState ? { kind: requestedState } : {}),
    ...(args.urlPattern || args.expectedUrl || args.url
      ? { kind: 'url', expected: args.urlPattern || args.expectedUrl || args.url }
      : {}),
    ...(args.text || args.expectedText
      ? { kind: 'text', expected: args.expectedText || args.text }
      : {}),
    ...(args.title || args.expectedTitle
      ? { kind: 'title', expected: args.expectedTitle || args.title }
      : {}),
    ...(args.loadState || args.waitUntil
      ? { kind: 'loadState', expected: args.loadState || args.waitUntil }
      : {}),
    ...(args.durationMs != null || args.delayMs != null
      ? { kind: 'duration', durationMs: args.durationMs ?? args.delayMs }
      : {}),
    ...waitMetadataFrom(args, entry),
  };
  return waitContractService.normalizeTypedWaitContract(explicit || inferred, inferred);
}

function waitConditionFromContract(contract, targetRef = null) {
  if (!contract) return null;
  const condition = cloned(contract);
  delete condition.schema;
  if (targetRef && condition.target == null) condition.target = targetRef;
  if (condition.kind === 'url' && condition.pattern == null) {
    const expected = waitObject(condition.expected);
    condition.pattern = expected?.urlPattern || expected?.url || condition.expected || null;
  }
  if (condition.kind === 'text' && condition.text == null) {
    const expected = waitObject(condition.expected);
    condition.text = expected?.text || expected?.value || condition.expected || null;
  }
  if (condition.kind === 'title' && condition.title == null) {
    const expected = waitObject(condition.expected);
    condition.title = expected?.title || expected?.value || condition.expected || null;
  }
  if (condition.kind === 'loadState' && condition.state == null) {
    const expected = waitObject(condition.expected);
    condition.state = expected?.readiness || expected?.state || condition.expected || null;
  }
  return condition;
}

function browserEventEvidenceFrom(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return [
    entry.browserEventEvidence,
    entry.operationResult?.browserEventEvidence,
    entry.operationResult?.eventEvidence,
    entry.eventEvidence,
  ].find((value) => value && typeof value === 'object' && !Array.isArray(value)) || null;
}

function eventObservedUrl(evidence) {
  return evidence?.selectedEvent?.url
    || evidence?.activePageAdoption?.url
    || evidence?.pageEvidence?.after?.url
    || null;
}

function applyBrowserEventProjection(step, trailNode) {
  if (!step || step.op !== 'act') return step;
  const evidence = browserEventEvidenceFrom(trailNode);
  const observedConsequenceUrl = trailNode.observedConsequenceUrl
    || trailNode.operationResult?.observedConsequenceUrl
    || (evidence && ['navigation', 'page_change', 'popup'].includes(evidence.eventKind)
      ? eventObservedUrl(evidence)
      : null);
  if (observedConsequenceUrl) step.observedConsequenceUrl = String(observedConsequenceUrl);
  if (!evidence) return step;
  const eventKind = String(evidence.eventKind || '').trim().toLowerCase();
  step.browserEventEvidence = cloned(evidence);
  step.browserEvent = {
    schema: evidence.schema || 'qaai_browser_event_evidence_v1',
    kind: eventKind || null,
    status: evidence.status || null,
    matched: typeof evidence.matched === 'boolean' ? evidence.matched : null,
    expected: cloned(evidence.expected || null),
    selectedEvent: cloned(evidence.selectedEvent || null),
    timing: cloned(evidence.timing || null),
    trigger: cloned(evidence.trigger || null),
    journal: cloned(evidence.journal || null),
    certification: cloned(evidence.certification || null),
  };
  if (eventKind === 'popup') {
    step.opensPopup = true;
    if (eventObservedUrl(evidence)) step.popupExpectedUrl = String(eventObservedUrl(evidence));
    step.popupIdentity = {
      pageId: evidence.selectedEvent?.pageId || evidence.activePageAdoption?.pageId || null,
      tabIndex: evidence.selectedEvent?.tabIndex ?? evidence.activePageAdoption?.tabIndex ?? null,
      url: eventObservedUrl(evidence),
      adopted: evidence.activePageAdoption?.adopted === true,
    };
  } else if (eventKind === 'download') {
    step.downloadEvidence = cloned({
      expected: evidence.expected || null,
      file: evidence.selectedEvent || null,
      status: evidence.status || null,
    });
  } else if (eventKind === 'dialog') {
    const selected = evidence.selectedEvent || {};
    step.dialogEvidence = cloned({
      expected: evidence.expected || null,
      observed: selected,
      status: evidence.status || null,
    });
    if (selected.dialogType || evidence.expected?.dialogType)
      step.dialogType = selected.dialogType || evidence.expected.dialogType;
    if (selected.message || evidence.expected?.messagePattern)
      step.expectedMessage = selected.message || evidence.expected.messagePattern;
  }
  return step;
}

function applyWaitMetadata(condition, ...values) {
  return { ...(condition || {}), ...waitMetadataFrom(...values) };
}

function expectedWaitPattern(...values) {
  for (const value of values) {
    for (const source of [...waitSources(value)].reverse()) {
      const expected =
        source.expected && typeof source.expected === 'object' ? source.expected : null;
      const nestedCondition =
        source.condition && typeof source.condition === 'object' ? source.condition : null;
      const candidate =
        source.urlPattern ||
        source.pattern ||
        source.expectedUrl ||
        source.url ||
        (expected && (expected.urlPattern || expected.pattern || expected.url)) ||
        (nestedCondition &&
          (nestedCondition.urlPattern || nestedCondition.pattern || nestedCondition.expectedUrl));
      if (candidate) return String(candidate);
    }
  }
  return null;
}

function replayConditionForRuntimeWait(entry, targetRef) {
  const typed = executedWaitContractFrom(entry);
  if (typed) return waitConditionFromContract(typed, targetRef);
  const args = waitObject(entry?.args) || {};
  const pattern = expectedWaitPattern(args, entry);
  let condition;
  if (pattern) {
    condition = { kind: 'url', pattern };
  } else {
    const requestedState = String(
      args.state || args.waitState || entry?.state || entry?.waitState || 'visible',
    ).trim().toLowerCase();
    const kind = ['visible', 'hidden', 'attached', 'detached'].includes(requestedState)
      ? requestedState
      : 'visible';
    condition = { kind, target: targetRef };
  }
  const withMetadata = applyWaitMetadata(condition, args, entry);
  if (withMetadata.timeoutMs == null) withMetadata.timeoutMs = 10_000;
  return withMetadata;
}

function plannedStepIdentity(step) {
  if (!step || typeof step !== 'object') return null;
  const value = step.id || step.stepId || step.contractStepId || null;
  return value == null || String(value).trim() === '' ? null : String(value);
}

function plannedStepOrdinal(step) {
  if (!step || typeof step !== 'object') return null;
  const raw = step.ordinal ?? step.stepOrdinal ?? step.order ?? step.position ?? null;
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function countStepIdentities(steps) {
  const counts = new Map();
  for (const step of steps) {
    const id = plannedStepIdentity(step);
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

function allowsStructuralWaitEnrichment(contractSteps, richSteps, contractIdCounts, richIdCounts) {
  if (contractSteps.length !== richSteps.length || !contractSteps.length) return false;
  if ([...contractIdCounts.values()].some((count) => count !== 1)) return false;
  if ([...richIdCounts.values()].some((count) => count !== 1)) return false;

  const contractIndexById = new Map(
    contractSteps.map((step, index) => [plannedStepIdentity(step), index]).filter(([id]) => id),
  );
  const richIndexById = new Map(
    richSteps.map((step, index) => [plannedStepIdentity(step), index]).filter(([id]) => id),
  );
  for (const [id, contractIndex] of contractIndexById) {
    if (richIndexById.has(id) && richIndexById.get(id) !== contractIndex) return false;
  }

  return contractSteps.every((contractStep, index) => {
    const richStep = richSteps[index];
    const contractAction = plannedReplayAction(contractStep);
    const richAction = plannedReplayAction(richStep);
    if (!contractAction || contractAction !== richAction) return false;
    const contractOrdinal = plannedStepOrdinal(contractStep);
    const richOrdinal = plannedStepOrdinal(richStep);
    if (contractOrdinal != null && contractOrdinal !== index + 1) return false;
    if (richOrdinal != null && richOrdinal !== index + 1) return false;
    return contractOrdinal == null || richOrdinal == null || contractOrdinal === richOrdinal;
  });
}

function enrichContractWaitMetadata(contractStep, richStep) {
  const waitKeys = [
    'waitContract',
    'operationCheck',
    'syncState',
    'sync_state',
    'timeoutMs',
    'timeout',
    'refreshAfterMs',
    'refreshAfter',
    'reloadAfterMs',
    'pollIntervalMs',
    'pollInterval',
    'stableObservations',
    'recovery',
  ];
  const enriched = { ...contractStep };
  for (const key of waitKeys) {
    if (Object.prototype.hasOwnProperty.call(richStep, key)) enriched[key] = cloned(richStep[key]);
  }
  const contractId = plannedStepIdentity(contractStep);
  const richId = plannedStepIdentity(richStep);
  const sourceStepId =
    contractStep.sourceStepId ||
    richStep.sourceStepId ||
    (contractId && richId && contractId !== richId ? richId : null);
  return {
    ...enriched,
    id: contractId || richId || null,
    contractStepId: contractId || richId || null,
    origin: 'authored',
    authored: true,
    ...(sourceStepId ? { sourceStepId } : {}),
  };
}

function reconciledPlannedSteps(input) {
  const contractSteps = Array.isArray(input && input.caseContractV1 && input.caseContractV1.steps)
    ? input.caseContractV1.steps
    : [];
  const richSteps = Array.isArray(input && input.plannedSteps)
    ? input.plannedSteps
    : Array.isArray(input && input.declaredSteps)
      ? input.declaredSteps
      : [];
  if (!contractSteps.length) return richSteps;
  if (!richSteps.length) return contractSteps;
  const contractIdCounts = countStepIdentities(contractSteps);
  const richIdCounts = countStepIdentities(richSteps);
  const richIndexById = new Map(
    richSteps.map((step, index) => [plannedStepIdentity(step), index]).filter(([id]) => id),
  );
  const richById = new Map(
    richSteps
      .map((step) => [plannedStepIdentity(step), step])
      .filter(([id]) => id && richIdCounts.get(id) === 1),
  );
  const contractHasIdentity = contractSteps.some(
    (step) => step && (step.contractStepId || step.stepId || step.id),
  );
  const richHasIdentity = richSteps.some(
    (step) => step && (step.contractStepId || step.stepId || step.id),
  );
  const allowLegacyPositionalMerge = !contractHasIdentity && !richHasIdentity;
  const allowStructuralWaitEnrichment =
    contractHasIdentity &&
    richHasIdentity &&
    allowsStructuralWaitEnrichment(contractSteps, richSteps, contractIdCounts, richIdCounts);
  const consumedRichIndexes = new Set();
  return contractSteps.map((contractStep, index) => {
    if (!contractStep || typeof contractStep !== 'object')
      return allowLegacyPositionalMerge ? richSteps[index] || contractStep : contractStep;
    const contractId = plannedStepIdentity(contractStep);
    const exactRich =
      contractId && contractIdCounts.get(contractId) === 1 ? richById.get(contractId) : null;
    const exactRichIndex = exactRich ? richIndexById.get(contractId) : null;
    if (exactRich && exactRichIndex != null && !consumedRichIndexes.has(exactRichIndex)) {
      consumedRichIndexes.add(exactRichIndex);
    }
    const safeWaitRich =
      !exactRich &&
      allowStructuralWaitEnrichment &&
      plannedReplayAction(contractStep) === 'waitFor' &&
      !consumedRichIndexes.has(index)
        ? richSteps[index]
        : null;
    if (safeWaitRich) {
      consumedRichIndexes.add(index);
      return enrichContractWaitMetadata(contractStep, safeWaitRich);
    }
    const legacyRich =
      !exactRich && allowLegacyPositionalMerge && !consumedRichIndexes.has(index)
        ? richSteps[index]
        : null;
    if (legacyRich) consumedRichIndexes.add(index);
    const rich = exactRich || legacyRich;
    if (!rich || typeof rich !== 'object') return contractStep;
    const richId = plannedStepIdentity(rich);
    return {
      ...contractStep,
      ...rich,
      // CaseContractV1 owns correlation identity. A richer authored step may
      // carry a draft/source id, but it must not replace the stable contract id.
      id: contractId || richId || null,
      contractStepId: contractId || richId || null,
      origin: 'authored',
      authored: true,
      ...(contractId && richId && String(contractId) !== String(richId)
        ? { sourceStepId: richId }
        : {}),
      dependsOn: rich.dependsOn ?? rich.dependsOnStepIds ?? contractStep.dependsOn,
    };
  });
}

function dataBindingOf(value) {
  if (!value || typeof value !== 'object') return null;
  const direct =
    value.dataBinding ||
    value.contractFulfillment?.dataBinding ||
    value.contractContext?.dataBinding ||
    null;
  return direct && typeof direct === 'object' ? direct : null;
}

function dataRoleFromBinding(binding) {
  if (!binding || binding.isDataBound !== true || !binding.sourceColumn) return null;
  return toSafeDataRole(binding.sourceColumn);
}

function applyBindingToReplayStep(step, binding) {
  const role = dataRoleFromBinding(binding);
  if (!role) return step;
  step.dataBinding = cloned(binding);
  step.dataRole = role;
  delete step.rawValue;
  return step;
}

const ACTION_OCCURRENCE_FIELDS = [
  'schemaVersion',
  'caseId',
  'contractStepId',
  'sourceContractStepId',
  'actionOccurrenceId',
  'sourceActionOccurrenceId',
  'authoredActionId',
  'sequenceIndex',
  'occurrenceOrdinal',
  'occurrenceKey',
  'toolUseId',
  'toolName',
  'operation',
];

function actionOccurrenceIdentityFrom(...values) {
  const sources = [];
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    if (value.actionIdentity && typeof value.actionIdentity === 'object')
      sources.push(value.actionIdentity);
    sources.push(value);
  }
  const identity = {};
  for (const field of ACTION_OCCURRENCE_FIELDS) {
    for (const source of sources) {
      if (source[field] == null || source[field] === '') continue;
      identity[field] = cloned(source[field]);
      break;
    }
  }
  const hasOccurrenceIdentity = ['actionOccurrenceId', 'authoredActionId', 'occurrenceKey'].some(
    (field) => identity[field] != null && identity[field] !== '',
  );
  return hasOccurrenceIdentity ? identity : null;
}

function applyActionOccurrenceIdentity(step, identity) {
  if (!step || !identity || typeof identity !== 'object') return step;
  step.actionIdentity = cloned(identity);
  for (const field of ACTION_OCCURRENCE_FIELDS) {
    if (identity[field] != null && identity[field] !== '' && step[field] == null) {
      step[field] = cloned(identity[field]);
    }
  }
  return step;
}

function positiveOccurrenceOrdinal(value, fallback = null) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stableOccurrenceIdentitiesCompatible(candidate, expected) {
  if (!candidate || !expected) return true;
  for (const field of [
    'caseId',
    'contractStepId',
    'actionOccurrenceId',
    'authoredActionId',
    'occurrenceKey',
  ]) {
    if (candidate[field] == null || candidate[field] === '') continue;
    if (expected[field] == null || expected[field] === '') continue;
    if (String(candidate[field]) !== String(expected[field])) return false;
  }
  return true;
}

function plannedActionOccurrenceIdentity({
  caseId,
  planned,
  plannedIndex,
  contractStepId,
  action,
  occurrenceOrdinal,
}) {
  const source = planned && typeof planned === 'object' ? planned : {};
  const existing =
    actionOccurrenceIdentityFrom(
      source,
      source.actionDispatchIdentity,
      source.stepAuthoring,
      source.locatorEvidenceV2,
      source.actionLocator,
    ) || {};
  const sequenceIndex =
    existing.sequenceIndex ??
    source.sequenceIndex ??
    source.actionSequenceIndex ??
    source.occurrenceIndex ??
    plannedStepOrdinal(source) ??
    plannedIndex + 1;
  const canonical = executionAuthoringCompiler.buildActionIdentity({
    testCaseId: existing.caseId || caseId || null,
    contractStepId,
    authoredActionId:
      existing.authoredActionId || source.authoredActionId || source.actionId || null,
    sequenceIndex,
    toolUseId: existing.toolUseId || source.toolUseId || null,
    toolName: existing.toolName || source.toolName || null,
    operation: existing.operation || action,
  });
  const ordinal = positiveOccurrenceOrdinal(
    existing.occurrenceOrdinal ?? source.occurrenceOrdinal ?? source.actionOccurrenceOrdinal,
    occurrenceOrdinal,
  );
  const stableCaseId = existing.caseId || canonical.caseId || caseId || null;
  const sourceContractStepId =
    existing.sourceContractStepId ||
    source.sourceContractStepId ||
    (existing.contractStepId && String(existing.contractStepId) !== String(contractStepId)
      ? existing.contractStepId
      : null);
  const identity = {
    ...canonical,
    ...existing,
    caseId: stableCaseId,
    contractStepId,
    operation: existing.operation || action,
    sequenceIndex: canonical.sequenceIndex,
    authoredActionId: existing.authoredActionId || canonical.authoredActionId,
    actionOccurrenceId: existing.actionOccurrenceId || `${contractStepId}:${action}:${ordinal}`,
    occurrenceOrdinal: ordinal,
    occurrenceKey:
      existing.occurrenceKey || `${stableCaseId || 'case'}:${contractStepId}:${ordinal}:${action}`,
  };
  if (sourceContractStepId) identity.sourceContractStepId = String(sourceContractStepId);
  return identity;
}

function applyContractMetadataToReplayStep(step, trailNode) {
  if (!step || !trailNode || typeof trailNode !== 'object') return step;
  const contractStepId = trailNode.contractStepId || trailNode.stepAuthoring?.plannedStepId || null;
  if (contractStepId && !step.contractStepId) step.contractStepId = contractStepId;
  const sourceContractStepId =
    trailNode.sourceContractStepId || trailNode.stepAuthoring?.sourceContractStepId || null;
  if (sourceContractStepId && !step.sourceContractStepId)
    step.sourceContractStepId = sourceContractStepId;
  const sourceStepId = trailNode.sourceStepId || trailNode.stepAuthoring?.sourceStepId || null;
  if (sourceStepId && !step.sourceStepId) step.sourceStepId = sourceStepId;
  if (!step.origin) {
    step.origin = contractStepId
      ? 'runtime_evidence'
      : trailNode.canonicalLiveLedger === true
        ? 'canonical_live_script_ledger'
        : 'unbound_runtime_evidence';
  }
  if (!contractStepId && trailNode.canonicalLiveLedger === true) {
    step.authored = true;
    step.evidenceOnly = false;
  }
  if (contractStepId && !step.targetRef) step.targetRef = contractStepId;
  if (trailNode.rowCoordinateId && !step.rowCoordinateId)
    step.rowCoordinateId = trailNode.rowCoordinateId;
  if (trailNode.dataRowId && !step.dataRowId) step.dataRowId = trailNode.dataRowId;
  const binding = dataBindingOf(trailNode);
  if (binding && typeof binding === 'object') {
    step.dataBinding = cloned(binding);
  }
  if (step.op === 'resolve') {
    const locatorEvidence =
      trailNode.locatorEvidenceV2 || trailNode.stepAuthoring?.locatorEvidenceV2 || null;
    if (locatorEvidence && typeof locatorEvidence === 'object' && !step.locatorEvidenceV2) {
      step.locatorEvidenceV2 = cloned(locatorEvidence);
    }
  }
  applyBrowserEventProjection(step, trailNode);
  return applyActionOccurrenceIdentity(
    step,
    actionOccurrenceIdentityFrom(
      trailNode,
      trailNode.actionDispatchIdentity,
      trailNode.stepAuthoring,
      trailNode.locatorEvidenceV2,
      trailNode.actionLocator,
    ),
  );
}

function plannedReplayAction(step) {
  const source =
    typeof step === 'string'
      ? step
      : String(step?.type || step?.action || step?.kind || step?.text || '');
  const normalized = source.replace(/[_-]+/g, ' ').trim().toLowerCase();
  if (!normalized) return null;
  if (/^(navigate|go) back\b/.test(normalized)) return 'navigateBack';
  if (/^(navigate|go) forward\b/.test(normalized)) return 'navigateForward';
  if (/^(navigate|go to|open url|visit)\b/.test(normalized)) return 'navigate';
  if (/^(fill|type|enter|input)\b/.test(normalized)) return 'fill';
  if (/^(select|choose)\b/.test(normalized)) return 'selectOption';
  if (/^(check|tick)\b/.test(normalized)) return 'check';
  if (/^(uncheck|untick)\b/.test(normalized)) return 'uncheck';
  if (/^(double click|doubleclick)\b/.test(normalized)) return 'doubleClick';
  if (/^(triple click|tripleclick)\b/.test(normalized)) return 'tripleClick';
  if (/^(click|tap|submit)\b/.test(normalized)) return 'click';
  if (/^(hover)\b/.test(normalized)) return 'hover';
  if (/^(drag|drag and drop|move)\b/.test(normalized)) return 'drag';
  if (/^(upload|attach)\b/.test(normalized)) return 'upload';
  if (/^(press|key)\b/.test(normalized)) return 'press';
  if (/^(handle|accept|dismiss) (the )?(browser )?(dialog|alert|confirm|prompt)\b/.test(normalized))
    return 'handleDialog';
  if (/^(resize|set viewport)\b/.test(normalized)) return 'resize';
  if (/^close\b/.test(normalized)) return 'close';
  if (/^(wait)\b/.test(normalized)) return 'waitFor';
  return 'customAction';
}

function plannedStepText(step) {
  const raw =
    typeof step === 'string'
      ? step
      : String(
          step?.target ||
            step?.element ||
            step?.field ||
            step?.label ||
            step?.text ||
            step?.description ||
            step?.name ||
            step?.type ||
            '',
        );
  return raw
    .replace(/^\s*(?:\d+[.)]|[-*])\s*/, '')
    .replace(
      /^(?:(?:navigate|go\s+to|open\s+(?:url|page)|visit)\s+(?:to\s+)?|(?:fill|type|enter|input|select|choose|check|tick|uncheck|untick|click|tap|submit|hover|upload|attach|press|key|wait(?:\s+for)?)\s+(?:on\s+|into\s+|in\s+|the\s+)?)/i,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function directAssertionFromTrail(entry) {
  const src = entry && (entry.assertOperation || (entry.op === 'assert' ? entry : null));
  if (!src || typeof src !== 'object') return null;
  const contractRef = src.contractRef || src.assertionId || entry.assertionId || null;
  if (!contractRef) return null;
  const binding = dataBindingOf(src) || dataBindingOf(entry);
  const evidence = src.evidence && typeof src.evidence === 'object' ? src.evidence : {};
  const explicitMatched = [src.matched, entry.matched, evidence.matched].find(
    (value) => typeof value === 'boolean',
  );
  const rawOutcome = String(
    src.liveOutcome ||
      src.outcome ||
      evidence.outcome ||
      entry.liveOutcome ||
      entry.outcome ||
      '',
  )
    .trim()
    .toLowerCase();
  const liveOutcome =
    explicitMatched === true || ['matched', 'pass', 'passed'].includes(rawOutcome)
      ? 'matched'
      : explicitMatched === false || ['not_matched', 'fail', 'failed'].includes(rawOutcome)
        ? 'not_matched'
        : rawOutcome || null;
  const evaluated =
    typeof explicitMatched === 'boolean' ||
    src.checked === true ||
    entry.checked === true ||
    evidence.checked === true ||
    ['matched', 'not_matched'].includes(liveOutcome);
  const step = {
    op: 'assert',
    contractRef,
    assertionId: src.assertionId || entry.assertionId || contractRef,
    channel: CHANNEL[src.channel] || src.channel || 'UI_TEXT',
    assertionType: src.assertionType || 'toBeVisible',
    evidence: src.evidence || {
      source: 'assertion_check',
      outcome: liveOutcome || 'uncheckable',
    },
  };
  const expected = src.expected ?? entry.expected ?? evidence.expected;
  const actual = src.actual ?? entry.actual ?? evidence.actual;
  if (expected != null) step.expected = expected;
  if (actual != null) step.actual = actual;
  if (src.assertionEvidenceId || entry.assertionEvidenceId)
    step.assertionEvidenceId = src.assertionEvidenceId || entry.assertionEvidenceId;
  if (evaluated) {
    step.origin = 'runtime_evidence';
    step.canonicalExecution = true;
    step.runtimeEvidence = true;
    step.checked = true;
    if (typeof explicitMatched === 'boolean') step.matched = explicitMatched;
    if (liveOutcome) step.liveOutcome = liveOutcome;
    step.executionStatus =
      liveOutcome === 'not_matched'
        ? 'failed'
        : liveOutcome === 'matched'
          ? 'passed'
          : 'evaluated';
  }
  if (src.locatorExpression) step.locatorExpression = src.locatorExpression;
  if (src.scope && typeof src.scope === 'object') step.scope = cloned(src.scope);
  if (binding && binding.isDataBound === true && binding.sourceColumn) {
    step.dataBinding = cloned(binding);
    step.dataExpected = toSafeDataRole(binding.sourceColumn);
  } else if (src.dataExpected) {
    step.dataExpected = toSafeDataRole(src.dataExpected);
  }
  if (src.rowCoordinateId || entry.rowCoordinateId)
    step.rowCoordinateId = src.rowCoordinateId || entry.rowCoordinateId;
  if (src.contractStepId || entry.contractStepId)
    step.contractStepId = src.contractStepId || entry.contractStepId;
  return step;
}

function operationCheckFromTrail(entry) {
  const outer =
    entry && (entry.operationCheck || entry.stepOperationCheck || entry.syncState || null);
  if (!outer || typeof outer !== 'object') return null;
  const inner =
    outer.operationCheck && typeof outer.operationCheck === 'object' ? outer.operationCheck : outer;
  const expected = inner.expected || outer.expected || null;
  const kind = inner.kind || outer.kind || null;
  if (!expected && !kind) return null;
  const out = {
    kind: kind ? String(kind) : 'state_ready',
  };
  if (expected != null) out.expected = String(expected);
  if (inner.target || outer.target) out.target = String(inner.target || outer.target);
  if (outer.status) out.status = String(outer.status);
  if (outer.matched != null) out.matched = outer.matched === true;
  if (outer.reason) out.reason = String(outer.reason);
  if (outer.evidence) out.evidence = String(outer.evidence).slice(0, 400);
  return { ...out, ...waitMetadataFrom(outer, inner, entry && entry.waitContract) };
}

function operationWaitFromTrail(entry, targetRef = null) {
  const executed = executedWaitContractFrom(entry);
  if (executed) {
    return {
      op: 'waitFor',
      condition: waitConditionFromContract(executed, targetRef),
      waitContract: cloned(executed),
    };
  }
  const check = operationCheckFromTrail(entry);
  if (!check || check.status === 'fail') return null;
  const kind = String(check.kind || '').toLowerCase();
  const expected = String(check.expected || '').trim();
  if (kind.includes('url') || /^https?:\/\//i.test(expected) || /^\//.test(expected)) {
    if (expected)
      return {
        op: 'waitFor',
        condition: applyWaitMetadata({ kind: 'url', pattern: expected }, check, entry),
      };
  }
  if (
    targetRef &&
    /\b(menu|dropdown|drop_down|visible|opened|expanded)\b/i.test(`${kind} ${expected}`)
  ) {
    return {
      op: 'waitFor',
      condition: applyWaitMetadata({ kind: 'visible', target: targetRef }, check, entry),
    };
  }
  return null;
}

function attachOperationCheck(step, entry) {
  const check = operationCheckFromTrail(entry);
  if (!step || !check) return step;
  step.operationCheck = check;
  return step;
}

function valueMatchesRole(expected, fields, role) {
  if (!role || !Object.prototype.hasOwnProperty.call(fields, role)) return false;
  const actual = fields[role];
  if (actual == null || expected == null) return false;
  const a = String(actual).trim().toLowerCase();
  const e = String(expected).trim().toLowerCase();
  return !!a && !!e && (a === e || a.includes(e) || e.includes(a));
}

function rolePresent(fields, role) {
  return (
    !!role &&
    Object.prototype.hasOwnProperty.call(fields, role) &&
    fields[role] != null &&
    String(fields[role]).trim() !== ''
  );
}

function inferExpectedDataRole(expected, fields, preferred = []) {
  for (const role of preferred) {
    if (valueMatchesRole(expected, fields, role)) return toSafeDataRole(role);
  }
  for (const [role, raw] of Object.entries(fields || {})) {
    if (raw == null || expected == null) continue;
    const value = String(raw).trim();
    const needle = String(expected).trim();
    if (!value || !needle) continue;
    if (value.toLowerCase() === needle.toLowerCase()) return toSafeDataRole(role);
  }
  return null;
}

function inferDomainAssertion({ expected, payload, fields, channel }) {
  if (!fields || !Object.keys(fields).length) return null;
  const op = String(
    (payload && (payload.assertOperator || payload.operator || payload.matcher || payload.kind)) ||
      '',
  ).toLowerCase();
  const assertField = String(
    (payload && (payload.assertField || payload.field || payload.targetField)) || '',
  ).toLowerCase();
  const expectedText = String(expected == null ? '' : expected).toLowerCase();

  if (
    (rolePresent(fields, 'priceMin') || rolePresent(fields, 'priceMax')) &&
    (op.includes('between') ||
      assertField.includes('price') ||
      /(^|\b)(rs\.?|price|amount)(\b|$)/i.test(expectedText))
  ) {
    return {
      kind: 'productPriceBetween',
      minRole: rolePresent(fields, 'priceMin') ? 'priceMin' : null,
      maxRole: rolePresent(fields, 'priceMax') ? 'priceMax' : null,
    };
  }

  if (
    rolePresent(fields, 'expectedContainsProductName') &&
    (valueMatchesRole(expected, fields, 'expectedContainsProductName') ||
      assertField.includes('productname') ||
      assertField.includes('product_name'))
  ) {
    return { kind: 'productNameContains', role: 'expectedContainsProductName' };
  }

  if (
    rolePresent(fields, 'productName') &&
    (valueMatchesRole(expected, fields, 'productName') ||
      assertField.includes('productname') ||
      assertField.includes('product_name'))
  ) {
    return { kind: 'productNameContains', role: 'productName' };
  }

  if (
    rolePresent(fields, 'searchName') &&
    (valueMatchesRole(expected, fields, 'searchName') ||
      assertField.includes('productname') ||
      assertField.includes('product_name'))
  ) {
    return { kind: 'productNameContains', role: 'searchName' };
  }

  if (
    rolePresent(fields, 'assertProductCategory') &&
    (valueMatchesRole(expected, fields, 'assertProductCategory') ||
      assertField.includes('category'))
  ) {
    return { kind: 'productCategoryContains', role: 'assertProductCategory' };
  }

  if (
    channel === 'UI_TEXT' &&
    rolePresent(fields, 'expectedContainsProductName') &&
    !expectedText
  ) {
    return { kind: 'productNameContains', role: 'expectedContainsProductName' };
  }
  return null;
}

function sensitivityFor(sensitivity, role, label) {
  if (typeof sensitivity === 'string') return sensitivity;
  if (!sensitivity || typeof sensitivity !== 'object' || Array.isArray(sensitivity))
    return 'synthetic';
  const candidates = [
    role,
    label,
    normRefName(role || label).toLowerCase(),
    normRefName(role || label),
  ]
    .filter((v) => v != null && String(v).trim())
    .map(String);
  for (const key of candidates) {
    if (Object.prototype.hasOwnProperty.call(sensitivity, key)) return sensitivity[key];
  }
  const lowered = new Map(
    Object.entries(sensitivity).map(([k, v]) => [String(k).toLowerCase(), v]),
  );
  for (const key of candidates) {
    const v = lowered.get(String(key).toLowerCase());
    if (v) return v;
  }
  return 'synthetic';
}

// A field's value NEVER becomes an inline literal in an act step. Derive a safe,
// scheme-prefixed ref. Credentials → conventional env names; masked → env:QAAI_TD_*;
// restricted → vault:*; everything else → a derived env name. (The literal, when
// synthetic, lives on dataRow.fields where the data provider supplies it.)
function safeValueRef({ label, role, sensitivity, credentialRefs }) {
  const l = String(label || role || '').toLowerCase();
  if (credentialRefs && role && credentialRefs[role]) return credentialRefs[role];
  if (sensitivity === 'restricted') return 'vault:' + normRefName(role || label).toLowerCase();
  if (sensitivity === 'masked') return 'env:QAAI_TD_' + normRefName(role || label);
  if (/pass|pwd|secret/.test(l)) return 'env:QAAI_PASSWORD';
  if (/user|email|login/.test(l)) return 'env:QAAI_USERNAME';
  if (/otp|mfa|token|code/.test(l)) return 'vault:' + normRefName(role || label).toLowerCase();
  return 'env:QAAI_' + normRefName(role || label);
}

function dedupeCandidates(candidates) {
  const out = [];
  const seen = new Set();
  for (const c of candidates || []) {
    if (!c || typeof c !== 'object') continue;
    const key = JSON.stringify(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function directValue(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    const value = obj[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return null;
}

function compactText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sameMeaning(a, b) {
  const aa = compactText(a).toLowerCase();
  const bb = compactText(b).toLowerCase();
  return !!aa && !!bb && aa === bb;
}

function looksLikeEnteredValue(label, value) {
  const text = compactText(label);
  if (!text) return false;
  if (sameMeaning(text, value)) return true;
  if (text.length > 120) return true;
  if (text.length >= 40 && new Set(text).size <= 2) return true;
  if (/^[^a-z0-9]+$/i.test(text) && text.length >= 3) return true;
  if (/[<>]/.test(text) || /script/i.test(text)) return true;
  return false;
}

// UI-widget descriptor suffixes that don't map 1:1 to ARIA roles. "Profile menu" means
// a <button> that opens a menu — the trigger role is "button". Same for dropdown/toggle/
// avatar/icon/trigger. Without this mapping inferCandidates has no role branch to enter
// and only emits a text candidate. Mapping descriptor nouns to their trigger role gives
// evidence-based and guessed locators a stronger first executable candidate.
const DESCRIPTOR_TO_ARIA = {
  menu: 'button',
  dropdown: 'button',
  'drop-down': 'button',
  toggle: 'button',
  trigger: 'button',
  avatar: 'button',
  icon: 'button',
};

function semanticParts(label, roleHint) {
  const raw = String(label || '').trim();
  const hintedRole = roleHint ? String(roleHint).toLowerCase() : '';
  const suffix =
    /^(.*)\s+(button|link|textbox|checkbox|radio|tab|heading|combobox|menuitem|searchbox|menu|dropdown|drop-down|toggle|trigger|avatar|icon)$/i.exec(
      raw,
    );
  const rawRole = suffix && suffix[2] ? suffix[2].toLowerCase() : hintedRole;
  const semanticRole = DESCRIPTOR_TO_ARIA[rawRole] || rawRole;
  return {
    raw,
    semanticName: suffix && suffix[1] ? suffix[1].trim() : raw,
    semanticRole,
    hadRoleSuffix: !!suffix,
  };
}

function expectedFromSignals(signals) {
  if (signals == null) return null;
  if (typeof signals === 'string' || typeof signals === 'number' || typeof signals === 'boolean') {
    const s = String(signals).trim();
    return s ? s : null;
  }
  if (Array.isArray(signals)) {
    for (const item of signals) {
      const v = expectedFromSignals(item);
      if (v) return v;
    }
    return null;
  }
  if (typeof signals === 'object') {
    for (const key of ['heading', 'title', 'text', 'label', 'name', 'url', 'role', 'selector']) {
      const v = expectedFromSignals(signals[key]);
      if (v) return v;
    }
  }
  return null;
}

function expectedFromPayload(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  // expectedReturn is the EVALUATE-specific field (script returns this value).
  const expected =
    p.expectedText ??
    p.expectedUrl ??
    p.expectedUrlPattern ??
    p.expectedPage ??
    p.pageName ??
    p.expectedLandingPage ??
    p.url ??
    p.expectedRole ??
    p.unexpectedText ??
    p.unexpectedRole ??
    p.expectedReturn ??
    p.value ??
    p.text ??
    p.role ??
    expectedFromSignals(p.expectedSignals) ??
    expectedFromSignals(p.signals) ??
    null;
  if (expected == null) return null;
  const s = String(expected).trim();
  return s ? s : null;
}

function credentialRoleFromText(value) {
  const text = String(value || '').toLowerCase();
  if (/password|pass\b|pwd/.test(text)) return 'password';
  if (/\b(?:username|user\s*name|login(?:\s*(?:id|name))?|email(?:\s*address)?)\b/.test(text)) {
    return 'username';
  }
  if (
    /\buser\b/.test(text) &&
    !/\b(?:search|filter|lookup|list|table|record|profile|role|status|management|link)\b/.test(text)
  ) {
    return 'username';
  }
  return null;
}

function literalValue(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /^<|^\{\{/.test(trimmed)) return null;
  return trimmed;
}

function declaredCredentialIsNegative(role, entry, caseTitle) {
  if (!entry || !entry.value) return false;
  const text = `${caseTitle || ''} ${entry.actionText || ''}`.toLowerCase();
  const literal = String(entry.value || '').toLowerCase();
  const payloadRe = /['";<>]|--\s|\/\*|\*\/|or\s+\d+=\d+|union.*select|alert\s*\(/i;
  if (role === 'username') {
    if (
      /valid username/.test(text) &&
      !/invalid username|wrong username|non[-\s]?existent username|bad[_\s-]*user|payload|injection|sql|xss/.test(
        text,
      )
    )
      return false;
    return (
      /invalid username|wrong username|non[-\s]?existent username|bad[_\s-]*user|username.*(payload|injection|sql|xss)|(payload|injection|sql|xss).*username|invalid email|malformed email/.test(
        text,
      ) ||
      /bad[_\s-]*user|nonexistent|invalid/.test(literal) ||
      payloadRe.test(literal)
    );
  }
  if (role === 'password') {
    if (
      /valid password/.test(text) &&
      !/wrong password|invalid password|bad password|password.*(payload|injection|sql|xss)|(payload|injection|sql|xss).*password/.test(
        text,
      )
    )
      return false;
    return (
      /wrong password|invalid password|bad password|password.*(payload|injection|sql|xss)|(payload|injection|sql|xss).*password/.test(
        text,
      ) ||
      /wrong|invalid|bad/.test(literal) ||
      payloadRe.test(literal)
    );
  }
  return false;
}

function createDeclaredCredentialInputCursor(declaredSteps) {
  const byRole = { username: [], password: [] };
  for (const step of Array.isArray(declaredSteps) ? declaredSteps : []) {
    if (!step) continue;
    const action = String(step.action || step.kind || '').toLowerCase();
    if (
      action &&
      action !== 'fill' &&
      action !== 'type' &&
      action !== 'enter' &&
      action !== 'input'
    )
      continue;
    const role = credentialRoleFromText(
      `${step.target || ''} ${step.element || ''} ${step.label || ''} ${step.locator_hint || ''} ${step.name || ''}`,
    );
    if (!role) continue;
    const value = literalValue(step.value ?? step.text ?? step.input);
    if (!value) continue;
    byRole[role].push({
      value,
      actionText:
        `${step.action || ''} ${step.element || ''} ${step.target || ''} ${step.expected || ''} ${step.description || ''}`.toLowerCase(),
    });
  }
  const cursor = { username: 0, password: 0 };
  return {
    next({ label, value, caseTitle }) {
      const role = credentialRoleFromText(label);
      if (!role) return null;
      const entry = byRole[role][cursor[role]++] || null;
      if (!entry) return null;
      const actual = literalValue(value);
      if (actual && entry.value && actual !== entry.value) return null;
      return declaredCredentialIsNegative(role, entry, caseTitle) ? entry.value : null;
    },
  };
}

function candidateFromSelector(selector) {
  const s = String(selector || '').trim();
  if (!s || /^\(?\s*captured\s*\)?$/i.test(s) || /^\(?\s*unknown\s*\)?$/i.test(s)) return null;
  if (/^ref\s*=\s*e\d+$/i.test(s) || /^e\d+$/i.test(s) || /\[ref\s*=/i.test(s)) return null;

  let m = s.match(/getByRole\(\s*["']([^"']+)["']\s*,\s*\{\s*name:\s*["']([^"']+)["']/i);
  if (m) return { strategy: 'role', role: m[1], name: m[2] };
  m = s.match(/getByRole\(\s*["']([^"']+)["']/i);
  if (m) return { strategy: 'role', role: m[1] };
  m = s.match(/getByText\(\s*["']([^"']+)["']/i);
  if (m) return { strategy: 'text', text: m[1] };
  m = s.match(/getByLabel\(\s*["']([^"']+)["']/i);
  if (m) return { strategy: 'label', text: m[1] };
  m = s.match(/getByPlaceholder\(\s*["']([^"']+)["']/i);
  if (m) return { strategy: 'placeholder', text: m[1] };
  m = s.match(/getByTestId\(\s*["']([^"']+)["']/i);
  if (m) return { strategy: 'testId', testId: m[1] };
  m = s.match(/getByAltText\(\s*["']([^"']+)["']/i);
  if (m) return { strategy: 'css', selector: `[alt="${m[1].replace(/"/g, '\\"')}"]` };
  m = s.match(/getByTitle\(\s*["']([^"']+)["']/i);
  if (m) return { strategy: 'css', selector: `[title="${m[1].replace(/"/g, '\\"')}"]` };
  m = s.match(/locator\(\s*["']([^"']+)["']/i);
  if (m) return { strategy: 'css', selector: m[1] };
  return { strategy: 'css', selector: s };
}

function inferCandidates(label, roleHint) {
  const raw = String(label || '').trim();
  if (!raw) return [];
  const out = [];
  const { semanticName, semanticRole } = semanticParts(raw, roleHint);

  if (semanticRole === 'textbox' || semanticRole === 'combobox' || semanticRole === 'searchbox') {
    out.push({ strategy: 'placeholder', text: semanticName });
    out.push({ strategy: 'label', text: semanticName });
    out.push({ strategy: 'role', role: semanticRole, name: semanticName });
  } else if (semanticRole) {
    out.push({ strategy: 'role', role: semanticRole, name: semanticName });
  }

  if (semanticName && semanticName !== raw) out.push({ strategy: 'text', text: semanticName });
  out.push({ strategy: 'text', text: raw });
  return out;
}

function directCandidates(evidence, roleHint) {
  const out = [];
  const rawFacts = evidence && evidence.facts ? evidence.facts : evidence;
  const facts = rawFacts && rawFacts.facts ? rawFacts.facts : rawFacts;
  const selector = directValue(evidence, ['selector', 'css', 'targetSelector']);
  const fromSelector = candidateFromSelector(selector);
  if (fromSelector) out.push(fromSelector);

  const factSelector = directValue(facts, ['selector']);
  const fromFactSelector = candidateFromSelector(factSelector);
  if (fromFactSelector) out.push(fromFactSelector);

  const testId =
    directValue(evidence, ['testId', 'dataTestId', 'data-testid', 'data-test', 'data-qa']) ||
    directValue(facts, ['testId']);
  if (testId) out.push({ strategy: 'testId', testId });

  const placeholder = directValue(evidence, ['placeholder']) || directValue(facts, ['placeholder']);
  if (placeholder) out.push({ strategy: 'placeholder', text: placeholder });

  const labelText = directValue(evidence, ['label']) || directValue(facts, ['label']);
  if (labelText) out.push({ strategy: 'label', text: labelText });

  const nameAttr = directValue(evidence, ['nameAttr', 'inputName']);
  if (nameAttr)
    out.push({ strategy: 'css', selector: `[name="${nameAttr.replace(/"/g, '\\"')}"]` });

  // The accessible name must NEVER be the value the user typed. On a fill/type the
  // post-action snapshot can surface the entered text as the field's content, and
  // `evidence.text` carries the typed value — using it as a role name produces a
  // nonsense, credential-leaking locator like getByRole('textbox',{name:'admin123'}).
  // Exclude the typed value (text/value) from the accessible-name sources. Generic:
  // keyed off the action's own input value, never a field/site string.
  const typedValue = String(
    directValue(evidence, ['text']) ?? directValue(evidence, ['value']) ?? '',
  ).trim();
  const nameCandidates = ['accessibleName', 'ariaLabel'];
  let accessibleName =
    directValue(evidence, nameCandidates) || directValue(facts, ['accessibleName']);
  // Allow `text` as a name ONLY when it is clearly an element label, not the typed
  // input value (i.e. there was no typed value, so this is a click/link/button text).
  if (!accessibleName && !typedValue)
    accessibleName = directValue(evidence, ['text']) || directValue(facts, ['text']);
  if (accessibleName && typedValue && String(accessibleName).trim() === typedValue)
    accessibleName = null;
  const role = directValue(evidence, ['role', 'type']) || directValue(facts, ['role']) || roleHint;
  if (role && accessibleName)
    out.push({ strategy: 'role', role: String(role).toLowerCase(), name: accessibleName });
  return out;
}

function contextTextFromEvidence(evidence) {
  const rawFacts = evidence && evidence.facts ? evidence.facts : evidence;
  const facts = rawFacts && rawFacts.facts ? rawFacts.facts : rawFacts;
  const nearby = facts && Array.isArray(facts.nearbyText) ? facts.nearbyText : [];
  return nearby
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .slice(0, 8);
}

function findKb(label, kbByElement, roleHint) {
  if (!kbByElement || !label) return null;
  if (kbByElement.get(label)) return kbByElement.get(label);
  const { semanticName } = semanticParts(label, roleHint);
  return semanticName && semanticName !== label ? kbByElement.get(semanticName) || null : null;
}

function fieldDomFacts(actionFacts, field) {
  const fields = actionFacts && Array.isArray(actionFacts.fields) ? actionFacts.fields : [];
  if (!fields.length || !field) return null;
  const ref = field.ref || field.target || null;
  const name = String(field.name || field.label || field.element || '')
    .trim()
    .toLowerCase();
  return (
    fields.find(
      (x) =>
        (ref && (x.ref === ref || (x.facts && x.facts.ref === ref))) ||
        (name &&
          String(x.name || '')
            .trim()
            .toLowerCase() === name),
    ) || null
  );
}

function fieldActionLocator(actionLocator, field, index = null) {
  return actionLocatorResolver.fieldActionLocator(actionLocator, field, index);
}

function isVerifiedActionLocator(actionLocator) {
  return replayLocatorContract.isVerifiedActionLocator(actionLocator);
}

// When an action has no GOLD action locator (count=1 + sameElement proof), fall
// back to the conductor's CODEGEN locator — an export-safe expression captured
// at dispatch (snapshot ref or DOM excavation) for live-ref/custom-widget
// actions. Without this, every action dispatched via the live-ref path (most of
// a run: dropdowns, buttons, form fields) is dropped as `legacy_inert` and the
// exported spec/page-objects end up with only the 1-2 gold-verified locators.
// Only export-safe expressions are accepted (locatorExpressionIsExportSafe
// already excludes .first()/ambiguous), so the cert gate still passes.
function usableReplayLocator(goldLocator, codegenLocator) {
  if (isVerifiedActionLocator(goldLocator)) return goldLocator;
  return isVerifiedActionLocator(codegenLocator) ? codegenLocator : null;
}

function bestReplayLocator(...locators) {
  const candidates = locators.filter((locator) => locator && typeof locator === 'object');
  return candidates.find((locator) => isVerifiedActionLocator(locator)) || null;
}

function repairedReplayLocatorFromEvidence(entry) {
  const evidence =
    entry &&
    (entry.locatorEvidenceV2 ||
      entry.stepAuthoring?.locatorEvidenceV2 ||
      entry.stepAuthoring?.locatorEvidence);
  const repaired = evidence && evidence.repairedActionLocator;
  return isVerifiedActionLocator(repaired) ? repaired : null;
}

function legacyDomFactsReplayLocator(entry) {
  const facts =
    entry && entry.domFacts && entry.domFacts.target && typeof entry.domFacts.target === 'object'
      ? entry.domFacts.target
      : null;
  if (!facts) return null;
  const role = String(facts.role || '')
    .trim()
    .toLowerCase();
  const name = String(
    facts.accessibleName || facts.placeholder || facts.testId || facts.selector || '',
  )
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || /^e\d+$/i.test(name) || /\[ref\s*=|[\uE000-\uF8FF]/u.test(name)) return null;
  let expression = null;
  let strategy = 'legacy_dom_facts';
  if (facts.testId) {
    expression = `getByTestId(${JSON.stringify(String(facts.testId))})`;
    strategy = 'testid';
  } else if (facts.placeholder) {
    expression = `getByPlaceholder(${JSON.stringify(String(facts.placeholder))})`;
    strategy = 'placeholder';
  } else if (role && role !== 'generic' && facts.accessibleName) {
    expression = `getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(String(facts.accessibleName))} })`;
    strategy = 'role';
  } else if (facts.selector && !/\[ref\s*=|^e\d+$/i.test(String(facts.selector))) {
    expression = String(facts.selector);
    strategy = 'css';
  }
  if (!expression || !actionLocatorResolver.locatorExpressionIsExportSafe(expression)) return null;
  return {
    kind: 'playwright',
    strategy,
    expression,
    frameworkExpressions: { playwright: expression },
    verificationSource: 'legacy_dom_facts',
    evidenceSource: 'legacy_dom_facts',
    proof: {
      source: 'legacy_dom_facts',
      legacyReplayTrace: true,
    },
    targetFacts: facts,
  };
}

function certificationFindingsForReplay(locatorCertification) {
  return locatorIntelligenceV2
    .locatorCertificationFindings(locatorCertification, { severity: 'warning' })
    .map((finding) => ({
      ...finding,
      severity: 'warning',
      nonBlocking: true,
    }));
}

function actionLocatorCandidates(actionLocator) {
  if (!isVerifiedActionLocator(actionLocator)) return [];
  const out = actionLocatorResolver.candidatesFromActionLocator(actionLocator);
  const primary = actionLocatorResolver.primaryActionLocator(actionLocator);
  const expr = primary && (primary.frameworkExpressions?.playwright || primary.expression);
  const fromExpr = candidateFromSelector(expr);
  if (fromExpr) out.unshift(fromExpr);
  return dedupeCandidates(out);
}

function actionLocatorForReplay(actionLocator) {
  // Accept GOLD (count=1 + sameElement proof) OR export-safe (a faithful ARIA/DOM
  // expression sourced from the browser's own accessibility snapshot, DOM inspection,
  // DOM excavation, or the snapshot-ref fallback). The deterministic export only needs
  // a FAITHFUL per-step locator — the stricter gold bar stays reserved for KB promotion
  // and the verdict. Without this, every action whose element has no unique role+name
  // (password inputs expose a placeholder but no `textbox` role; custom widgets) was
  // dropped from step.actionLocator even though a real, unique locator was captured —
  // which then tripped the gold-only export gate and blocked the WHOLE export.
  const goldVerified = isVerifiedActionLocator(actionLocator);
  if (!goldVerified) return null;
  const primary = actionLocatorResolver.primaryActionLocator(actionLocator);
  if (!primary) return null;
  const playwright = primary.frameworkExpressions?.playwright || primary.expression || null;
  if (!playwright) return null;
  const domAtlas = actionLocatorResolver.domAtlasFromActionLocator(actionLocator);
  return {
    kind: primary.kind || 'playwright',
    verified: primary.verified === true || primary.proof?.verified === true,
    goldVerified,
    locatorConfidence: 'verified',
    verificationSource:
      primary.verificationSource || primary.evidenceSource || primary.proof?.source || null,
    evidenceSource:
      primary.evidenceSource || primary.verificationSource || primary.proof?.source || null,
    expression: playwright,
    frameworkExpressions: {
      playwright,
      ...(primary.frameworkExpressions?.selenium
        ? { selenium: primary.frameworkExpressions.selenium }
        : {}),
    },
    strategy: primary.strategy || 'actionLocator',
    targetFacts: primary.targetFacts || {},
    context: primary.context || {},
    captureBinding: primary.captureBinding || primary.context?.captureBinding || null,
    proof: primary.proof || {},
    pageUrl: primary.pageUrl || null,
    elementLabel: primary.elementLabel || null,
    ...(domAtlas ? { domAtlas } : {}),
  };
}

function collectReplayDomAtlas(steps) {
  const pages = {};
  for (const step of Array.isArray(steps) ? steps : []) {
    const domAtlas = step && step.actionLocator && step.actionLocator.domAtlas;
    if (!domAtlas || typeof domAtlas !== 'object') continue;
    const page = pageAtlas.normalizeDomAtlasPage(domAtlas, {
      pageUrl: domAtlas.url || step.actionLocator.pageUrl,
    });
    if (!page) continue;
    const key = page.pageKey || page.routeKey || '/';
    pages[key] = pageAtlas.mergeDomAtlasPage(pages[key], page, { pageKey: key });
  }
  return Object.keys(pages).length
    ? { schemaVersion: pageAtlas.DOM_ATLAS_SCHEMA_VERSION, pages }
    : null;
}

// Resolve locator candidates for an action from recorded evidence. Prefers the KB
// row (the selector/role/name the MCP run ACTUALLY resolved against the live DOM).
// This function may return []; the caller then adds an explicit, warned locator guess.
function candidatesFor(label, kbByElement, roleHint, evidence = null) {
  const out = [];
  const skipLabelInference = !!(evidence && evidence.skipLabelInference);
  out.push(...actionLocatorCandidates(evidence && evidence.actionLocator));
  // actionLocatorCandidates() only yields candidates for GOLD locators. When the
  // evidence carries an export-safe NON-gold codegen locator (the caller vetted
  // it via usableReplayLocator), include its expression directly so the emitted
  // page-object locator is the REAL captured selector, not just label inference.
  {
    const al = evidence && evidence.actionLocator;
    const alp = al ? actionLocatorResolver.primaryActionLocator(al) : null;
    const alExpr =
      alp &&
      ((alp.frameworkExpressions && alp.frameworkExpressions.playwright) || alp.expression || null);
    if (alExpr && !isVerifiedActionLocator(al)) {
      const c = candidateFromSelector(alExpr);
      if (c) out.push(c);
    }
  }
  out.push(...directCandidates(evidence, roleHint));
  const kb = findKb(label, kbByElement, roleHint);
  if (kb) {
    const fromSelector = candidateFromSelector(kb.selector);
    if (fromSelector) out.push(fromSelector);
    if (kb.role && kb.accessibleName)
      out.push({ strategy: 'role', role: kb.role, name: kb.accessibleName });
  }
  if (!skipLabelInference) out.push(...inferCandidates(label, roleHint));
  if (label && !skipLabelInference) {
    // Prefer the role the MCP run ACTUALLY resolved this element as — `roleHint`
    // (e.g. a browser_fill_form field's `type:'textbox'`). Else parse a trailing
    // role word from the element description ("Login button"). Text fallback last.
    if (roleHint)
      out.push({ strategy: 'role', role: String(roleHint).toLowerCase(), name: label.trim() });
    else {
      const m =
        /^(.*)\s+(button|link|textbox|checkbox|radio|tab|heading|combobox|menuitem|menu|dropdown|drop-down|toggle|trigger|avatar|icon)$/i.exec(
          label.trim(),
        );
      if (m) {
        const rawRole = m[2].toLowerCase();
        const ariaRole = DESCRIPTOR_TO_ARIA[rawRole] || rawRole;
        out.push({ strategy: 'role', role: ariaRole, name: m[1].trim() });
      }
    }
    out.push({ strategy: 'text', text: label.trim() });
  }
  // May be [] when there is NO recorded evidence (no label, no KB row). The caller
  // preserves the action by emitting an editable guessed locator with provenance.
  // Filter role candidates with empty name — they match ALL nameless elements and
  // cause ambiguous resolution. A button with no accessible name on the page is too
  // broad to be a reliable locator candidate.
  const deduped = dedupeCandidates(out).filter((c) => !(c.strategy === 'role' && c.name === ''));
  // ── Rank by UNIQUENESS-BY-CONSTRUCTION, not by strategy fashion ──────────────
  // resolveLocator tries candidates in order and takes the first that resolves to a
  // single element, so the ORDER decides correctness. A role+name candidate can be
  // ambiguous or mislabeled (e.g. a password input whose accessibility line inherits
  // the adjacent field's name "Username", or two controls sharing a name), and if it
  // leads it silently resolves the WRONG element. So rank strategies that are unique by
  // construction first: testId → #id/[name]/[data-*] css → placeholder → label →
  // role+name → text → generic css. This is fully generic (keyed off strategy + selector
  // shape, never a field/site string). Elements with no placeholder/label/testid (most
  // buttons/links) still lead with role+name, exactly as before — only inputs and
  // shared-name controls change, leading with their unique placeholder/label.
  const strongCss = (sel) =>
    typeof sel === 'string' && /^#|\[name\s*=|\[data-[\w-]+\s*=|\[id\s*=/i.test(sel.trim());
  const rankOf = (c) => {
    switch (c.strategy) {
      case 'testId':
        return 0;
      case 'css':
        return strongCss(c.selector) ? 1 : 6;
      case 'placeholder':
        return 2;
      case 'label':
        return 3;
      case 'role':
        return c.name && String(c.name).trim() ? 4 : 9;
      case 'text':
        return 5;
      default:
        return 7;
    }
  };
  const candidates = deduped
    .map((c, i) => ({ c, i, r: rankOf(c) }))
    .sort((a, b) => a.r - b.r || a.i - b.i) // stable within a rank (preserve capture order)
    .map((x) => x.c);
  const contextText = contextTextFromEvidence(evidence);
  return contextText.length ? candidates.map((c) => ({ ...c, contextText })) : candidates;
}

function normPopups(knownPopups) {
  return (Array.isArray(knownPopups) ? knownPopups : [])
    .map((p) => {
      if (p && p.role) return { strategy: 'role', role: p.role, name: p.name || p.text || '' };
      if (p && (p.text || p.name)) return { strategy: 'text', text: p.text || p.name };
      return { strategy: 'text', text: String(p && p.label ? p.label : p) };
    })
    .filter((p) => p.name !== undefined || p.text !== undefined);
}

const SCRIPTABLE = new Set(Object.keys(TOOL_ACTION));

function verifiedLocatorKey(actionLocator) {
  if (!actionLocatorResolver.isVerifiedActionLocator(actionLocator)) return '';
  if (actionLocator && actionLocator.kind === 'multi' && Array.isArray(actionLocator.fields)) {
    return actionLocator.fields
      .map((field) => {
        const primary = actionLocatorResolver.primaryActionLocator(field && field.actionLocator);
        return (primary && (primary.frameworkExpressions?.playwright || primary.expression)) || '';
      })
      .join('|');
  }
  const primary = actionLocatorResolver.primaryActionLocator(actionLocator);
  return (primary && (primary.frameworkExpressions?.playwright || primary.expression)) || '';
}

function actionValueKey(tool, args = {}) {
  if (tool === 'browser_fill_form' && Array.isArray(args.fields)) {
    return JSON.stringify(
      args.fields.map((f) => ({
        name: f && (f.name || f.label || f.element || ''),
        value: f && (f.value ?? f.text ?? f.input ?? ''),
      })),
    );
  }
  return JSON.stringify({
    text: args.text ?? null,
    value: args.value ?? null,
    values: args.values ?? null,
    files: args.paths ?? args.files ?? args.file ?? null,
    doubleClick: args.doubleClick === true,
    clickCount: args.clickCount ?? null,
    button: args.button ?? null,
    modifiers: Array.isArray(args.modifiers) ? args.modifiers : null,
  });
}

function preserveDuplicateLocatorActions(trail, findings = []) {
  if (!Array.isArray(trail) || trail.length < 2) return trail;
  let last = null;
  const intentionalMultiClickTools = new Set(['browser_double_click', 'browser_triple_click']);
  for (let i = 0; i < trail.length; i += 1) {
    const entry = trail[i];
    if (!entry || entry.ok === false || typeof entry.tool !== 'string') continue;
    if (
      entry.tool === 'assertion_check' ||
      entry.tool === 'browser_navigate' ||
      entry.tool === 'browser_navigate_back' ||
      entry.tool === 'browser_navigate_forward'
    ) {
      last = null;
      continue;
    }
    if (!SCRIPTABLE.has(entry.tool) || !TOOL_ACTION[entry.tool]) continue;
    if (intentionalMultiClickTools.has(entry.tool)) {
      last = null;
      continue;
    }
    const action = TOOL_ACTION[entry.tool];
    if (!NEEDS_LOCATOR.has(action)) {
      last = null;
      continue;
    }
    const locatorKey = verifiedLocatorKey(entry.actionLocator);
    if (!locatorKey) {
      last = null;
      continue;
    }
    const key = JSON.stringify({
      pageUrl: String(entry.pageUrl || entry.pageUrlBefore || '').replace(/[?#].*$/, ''),
      tool: entry.tool,
      action,
      locatorKey,
      value: actionValueKey(entry.tool, entry.args || {}),
    });
    if (last && last.key === key) {
      findings.push({
        code: 'duplicate_action_preserved',
        where: entry.tool,
        detail: `Repeated ${action} on the same verified locator was preserved in ReplayIR so recorded or authored business actions are never silently removed.`,
        classification: 'preserved_action',
        duplicateOfTrailIndex: last.index,
        trailIndex: i,
        action,
      });
    }
    last = { key, index: i };
  }
  return trail;
}

/**
 * Detect a browser context switch (new tab opened via target="_blank") and emit a
 * graceful-degradation navigate step with contextSwitchInferred:true.
 *
 * When the conductor uses browser_tabs to switch to a new tab, the MCP trail does NOT
 * record a navigate step for the tab switch — the next locator action just happens to
 * carry a different pageUrl. This detects that discontinuity and emits a navigate so:
 *   a) subsequent locators find elements on the correct URL, and
 *   b) the adapter can emit a multi-tab comment instructing the user how to fix it.
 *
 * Keyed off URL path changes only (ignores query/hash changes that are normal SPA
 * navigation). Only fires when BOTH the activePageUrl AND the action's pageUrl are known.
 */
function _emitContextSwitchIfNeeded(
  action,
  contextTransitions,
  findings,
  activePageUrl,
  normalizeFn,
) {
  const actionUrl = action && (action.pageUrl || action.pageUrlBefore);
  if (!activePageUrl || !actionUrl) return;
  if (normalizeFn(actionUrl) === normalizeFn(activePageUrl)) return;
  // Already have a navigate to this URL as the last step — no need to re-emit.
  const last = contextTransitions[contextTransitions.length - 1];
  if (last && normalizeFn(last.observedUrl) === normalizeFn(actionUrl)) return;
  contextTransitions.push({
    kind: 'observed_context_transition',
    fromUrl: String(activePageUrl),
    observedUrl: String(actionUrl),
    origin: 'inferred_helper',
    helperOperation: true,
    authored: false,
  });
  // Advisory finding only — the navigate step IS emitted and the adapter annotates it.
  // Using findings (not gaps) so complete:false is not triggered for a handled case.
  findings.push({
    code: 'context_switch_inferred',
    where: action.tool || 'unknown',
    detail: `Action on '${actionUrl}' followed a navigate to '${activePageUrl}' with no recorded URL change — a browser tab switch (target="_blank") likely occurred. The emitter inserts a navigate for faithful replay; this case may need manual adjustment for multi-tab scenarios (see the comment in the emitted spec).`,
  });
}

/**
 * @param input {
 *   caseId, authProfile?, trail, declaredAssertions?, assertionOutcomes?, verdictStatus,
 *   dataRow?, dataRows?, knownPopups?, humanInputs?, kbByElement?(Map), credentialRefs?
 * }
 * @returns { ir, findings:[{code, detail}] }  — `ir` is a ReplayIR object; `findings`
 *          are advisory (e.g. a dropped non-replayable tool). The CALLER runs
 *          validateReplayIR(ir): on any error the export must stop.
 */
function buildReplayIR(input) {
  const {
    caseId,
    title,
    trail = [],
    declaredAssertions = [],
    assertionOutcomes = [],
    verdictStatus = 'pass',
    dataRow = null,
    dataRows = null,
    knownPopups = [],
    humanInputs = [],
    kbByElement = null,
    credentialRefs = null,
    platformGaps = [],
    // Set<string> of KNOWN REAL credential values (usernames + passwords from the project's
    // testCredentials). When a credential-shaped field is filled with a value that is NOT in
    // this set, it is a wrong/test credential (negative-path test) and must be inlined so the
    // exported spec actually submits the wrong value instead of readEnv("QAAI_PASSWORD").
    credentialValues = null,
  } = input || {};
  const findings = [];
  const declaredCredentialInputs = createDeclaredCredentialInputCursor(
    input && (input.declaredSteps || input.plannedSteps || []),
  );
  // GAPS = missing trace evidence we refuse to fabricate (the user's P6 honesty
  // rule). A non-empty `gaps` ⇒ `complete:false` ⇒ the export lane must mark the
  // IR incomplete/unsupported and NOT ship it as a clean replay, surfacing exactly
  // which evidence is missing. Mirrors the P3d operationsJson complete/dropped gate.
  const gaps = [];
  for (const gap of Array.isArray(platformGaps) ? platformGaps : []) {
    if (!gap) continue;
    if (isLocatorOnlyGap(gap)) {
      findings.push({
        ...gap,
        code: 'platform_action_locator_evidence_missing',
        category: 'platform_evidence_integrity_failure',
        severity: 'warning',
        nonBlocking: true,
        detail: String(
          gap.detail ||
            gap.description ||
            'The performed action has no exact-node verified locator evidence. It remains diagnostic and no locator was guessed.',
        ),
      });
      continue;
    }
    gaps.push({
      code: String(gap.code || gap.type || 'platform_certification_gap'),
      where: gap.where || caseId || 'case',
      detail: String(
        gap.detail || gap.description || 'QAAI could not certify this execution evidence.',
      ),
      pageUrl: gap.pageUrl || null,
      narration: gap.narration || null,
      elementLabel: gap.elementLabel || null,
    });
  }
  const steps = [];
  const contextTransitions = [];
  // Labels of steps emitted from an export-safe-but-non-gold locator — deduped so the
  // findings list carries one info entry per distinct element, not one per occurrence.
  const degradedLocatorLabels = new Set();
  const authoringReport = executionAuthoringCompiler.compileTrailAuthoringReport({
    trail: Array.isArray(trail) ? trail : [],
    plannedSteps: Array.isArray(input && input.plannedSteps) ? input.plannedSteps : [],
  });

  const popups = normPopups(knownPopups);
  if (popups.length) {
    gaps.push({
      code: 'authored_popup_intent_requires_executed_evidence',
      category: 'authored_intent_metadata',
      severity: 'info',
      nonBlocking: true,
      where: caseId || 'case',
      detail:
        'Known popup declarations remain diagnostic metadata. QAAI emits a popup dismissal only when the run contains an executed action with an exact-node verified locator.',
      knownPopups: popups,
    });
  }

  const allocateLocatorRef = createSemanticLocatorRefAllocator();
  let emittedNavigation = false;
  // Tracks the page URL of the most recently recorded explicit navigate step.
  // Used to detect browser context switches (new tab via target="_blank") when a
  // locator action's pageUrl differs from this without a preceding navigate step.
  let activePageUrl = null;
  const emitInitialNavigation = (a) => {
    if (emittedNavigation) return;
    const url = a && (a.pageUrl || a.pageUrlBefore);
    if (!url || /^about:blank$/i.test(String(url))) return;
    contextTransitions.push({
      kind: 'observed_start_state',
      observedUrl: String(url),
      origin: 'inferred_helper',
      helperOperation: true,
      authored: false,
    });
    emittedNavigation = true;
    activePageUrl = String(url);
  };
  // Normalize a URL to its path (drops query and hash) for discontinuity comparison.
  // Query params change on navigation within the same page — we only care about cross-origin or
  // cross-path switches that indicate a new browser context (tab switch).
  const normalizeUrlForTabCheck = (u) =>
    String(u || '')
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  // Preserve the action trail one-for-one. Export correctness is owned by explicit
  // contract reconciliation and the compilation ledger, never by silently deleting
  // actions that merely look redundant from surrounding navigation.
  const trailPruned = preserveDuplicateLocatorActions(trail, findings);
  const directAssertionRefs = new Set();
  for (const a of Array.isArray(trailPruned) ? trailPruned : []) {
    if (!a || typeof a.tool !== 'string') continue;
    const directAssert = directAssertionFromTrail(a);
    if (directAssert) {
      steps.push(applyContractMetadataToReplayStep(directAssert, a));
      directAssertionRefs.add(directAssert.contractRef);
      continue;
    }
    if (!SCRIPTABLE.has(a.tool)) {
      const registryEntry = browserActionRegistry.getActionEntry(a.tool);
      if (
        registryEntry &&
        registryEntry.kind !== 'utility' &&
        registryEntry.codegenFallback !== browserActionRegistry.CODEGEN_FALLBACKS.EMIT_PLAYWRIGHT
      ) {
        const detail = `${a.tool} is a registered runtime action but is not certified ReplayIR-exportable; preview generation must use ${registryEntry.codegenFallback}.`;
        findings.push({
          code: 'registered_action_codegen_fallback',
          where: a.tool,
          detail,
          codegenFallback: registryEntry.codegenFallback,
        });
        gaps.push({
          code: 'registered_action_not_exportable',
          where: a.tool,
          detail,
          pageUrl: a.pageUrl || a.pageUrlBefore || null,
          narration: a.narration || a.stepTitle || null,
          elementLabel: (a.args && (a.args.element || a.args.label || a.args.name)) || null,
        });
      } else if (!registryEntry) {
        const detail = `${a.tool} is not registered in the browser action contract; certification must block instead of silently dropping it.`;
        findings.push({
          code: 'unregistered_runtime_action',
          where: a.tool,
          detail,
          codegenFallback: browserActionRegistry.CODEGEN_FALLBACKS.BLOCK_CERTIFICATION,
        });
        gaps.push({
          code: 'unregistered_runtime_action',
          where: a.tool,
          detail,
          pageUrl: a.pageUrl || a.pageUrlBefore || null,
          narration: a.narration || a.stepTitle || null,
          elementLabel: (a.args && (a.args.element || a.args.label || a.args.name)) || null,
        });
      }
      continue;
    } // assertion_check/final_verdict/snapshot/human_input handled separately
    if (a.ok === false) {
      findings.push({
        code: 'failed_action_preserved',
        severity: 'warning',
        detail: `${a.tool} failed during the live run but remains in the generated script so the user can reproduce and repair it.`,
      });
    }
    const args = a.args || {};
    let action = TOOL_ACTION[a.tool];
    // Modern MCP represents a double click as browser_click({ doubleClick:true }).
    // Preserve that payload instead of collapsing it to an ordinary click.
    const recordedClickCount = Number(args.clickCount);
    if (action === 'click' && (args.doubleClick === true || recordedClickCount === 2))
      action = 'doubleClick';
    if (
      ['click', 'doubleClick'].includes(action) &&
      Number.isFinite(recordedClickCount) &&
      recordedClickCount >= 3
    )
      action = 'tripleClick';

    if (action === 'waitFor') {
      const executedWaitContract = executedWaitContractFrom(a);
      const targetRef = args.ref || args.target || args.element || args.selector || null;
      const waitStep = applyContractMetadataToReplayStep({
        op: 'waitFor',
        condition: waitConditionFromContract(executedWaitContract, targetRef),
        waitContract: cloned(executedWaitContract),
      }, a);
      const recordedLocator = actionLocatorForReplay(a.actionLocator);
      if (recordedLocator) waitStep.actionLocator = recordedLocator;
      steps.push(attachOperationCheck(waitStep, a));
      continue;
    }

    if (action === 'navigate' || action === 'navigateBack' || action === 'navigateForward' || action === 'reload') {
      const step = applyContractMetadataToReplayStep(
        attachOperationCheck({ op: 'act', action }, a),
        a,
      );
      if (args.url) step.url = String(args.url);
      const navigationKind = action === 'navigate'
        ? 'direct'
        : action === 'navigateBack'
          ? 'back'
          : action === 'navigateForward'
          ? 'forward'
            : 'reload';
      const explicitNavigationTimeout = [
        args.timeoutMs,
        a.timeoutMs,
        args.waitContract?.timeoutMs,
        a.waitContract?.timeoutMs,
        a.operationCheck?.waitContract?.timeoutMs,
        a.syncState?.waitContract?.timeoutMs,
      ]
        .map((value) => Number(value))
        .find((value) => Number.isFinite(value) && value > 0);
      const navigationWait = executedWaitContractFrom(a, {
        kind: 'url',
        expected: args.url || a.observedConsequenceUrl || null,
        ...(explicitNavigationTimeout ? { timeoutMs: explicitNavigationTimeout } : {}),
        ...(args.waitUntil ? { waitUntil: args.waitUntil } : {}),
      });
      step.navigation = {
        kind: navigationKind,
        url: args.url != null ? String(args.url) : null,
        ...(explicitNavigationTimeout
          ? { timeoutMs: navigationWait?.timeoutMs ?? explicitNavigationTimeout }
          : {}),
        waitUntil: args.waitUntil || navigationWait?.waitUntil || navigationWait?.expected?.readiness || null,
        sameSession: true,
        observedConsequenceUrl: step.observedConsequenceUrl || null,
      };
      // Skip consecutive same-URL navigate — conductor sometimes issues it twice
      const lastStep = steps[steps.length - 1];
      if (!(
        lastStep &&
        lastStep.op === 'act' &&
        lastStep.action === 'navigate' &&
        lastStep.url === step.url
      )) {
        steps.push(step);
        const wait = operationWaitFromTrail(a);
        if (wait) steps.push(applyContractMetadataToReplayStep(wait, a));
      }
      emittedNavigation = true;
      if (args.url) activePageUrl = String(args.url);
      continue;
    }
    if (action === 'handleDialog' || action === 'resize' || action === 'close') {
      const targetlessAct = applyContractMetadataToReplayStep({ op: 'act', action }, a);
      if (action === 'handleDialog') {
        targetlessAct.accept = args.accept !== false;
        if (args.promptText != null) targetlessAct.promptText = String(args.promptText);
      } else if (action === 'resize') {
        const width = Number(args.width);
        const height = Number(args.height);
        if (Number.isFinite(width) && width > 0) targetlessAct.width = Math.floor(width);
        if (Number.isFinite(height) && height > 0) targetlessAct.height = Math.floor(height);
      } else if (action === 'close') {
        targetlessAct.scope = String(args.scope || args.context || 'page');
      }
      steps.push(attachOperationCheck(targetlessAct, a));
      continue;
    }

    // browser_fill_form fills MANY fields in ONE call: args.fields[] = [{name,type,target,value}].
    // It has no single `element`, so the generic single-locator path below would drop it.
    // Expand to per-field resolve+fill so the replay is faithful — every field's name+type
    // is recorded (real evidence, no fabrication) and every value becomes a valueRef (the
    // recorded literal, e.g. a password, NEVER reaches the IR).
    if (Array.isArray(args.fields) && args.fields.length) {
      emitInitialNavigation(a);
      _emitContextSwitchIfNeeded(
        a,
        contextTransitions,
        findings,
        activePageUrl,
        normalizeUrlForTabCheck,
      );
      if (a.pageUrl && activePageUrl !== String(a.pageUrl)) activePageUrl = String(a.pageUrl);
      for (let fieldIndex = 0; fieldIndex < args.fields.length; fieldIndex++) {
        const f = args.fields[fieldIndex];
        const rawLabel = (f && (f.label || f.element || f.name)) || '';
        const enteredValue = f && (f.value ?? f.text ?? f.input ?? '');
        const valueAsLabel = looksLikeEnteredValue(rawLabel, enteredValue);
        const flabel = valueAsLabel ? '' : rawLabel;
        const fieldLocator = fieldActionLocator(a.actionLocator, f, fieldIndex);
        // Per-field export-safe fallback, attributed by field identity (NOT forced
        // null for multi-field forms — that silently dropped every field of an
        // N-field form). Priority: the field's own gold/export-safe locator → its
        // per-field codegen locator (a.fieldCodegenLocators[fieldIndex], captured at
        // dispatch) → its per-field snapshot-derived diagnostic → for a single-field
        // form only, the action-level codegen locator. Never cross-attribute a
        // form-level locator to the wrong field.
        const perFieldCodegen =
          (Array.isArray(a.fieldCodegenLocators) && a.fieldCodegenLocators[fieldIndex]) ||
          (f && f.codegenLocator) ||
          (args.fields.length === 1 ? a.codegenLocator : null);
        const perFieldDiagnostic =
          (f && f.locatorDiagnostic) ||
          (Array.isArray(a.fieldLocatorDiagnostics) && a.fieldLocatorDiagnostics[fieldIndex]) ||
          null;
        const perFieldFacts = fieldDomFacts(a.domFacts, f);
        const perFieldTargetFacts = perFieldFacts?.facts || perFieldFacts;
        const legacyFieldLocator = legacyDomFactsReplayLocator({
          domFacts: { target: perFieldTargetFacts },
        });
        const repairedFieldLocator =
          args.fields.length === 1 ? repairedReplayLocatorFromEvidence(a) : null;
        const verifiedFieldLocator = bestReplayLocator(
          fieldLocator,
          repairedFieldLocator,
          perFieldCodegen,
          legacyFieldLocator,
          perFieldDiagnostic,
        );
        const candidates = actionLocatorCandidates(verifiedFieldLocator);
        if (!verifiedFieldLocator) {
          const locatorGap =
            locatorGapFromTrail(a, {
              narration: a.narration || a.stepTitle || null,
              elementLabel: flabel || rawLabel || null,
              where: a.tool,
            }) || {
              code: 'locator_unverified',
              type: 'locator_unverified',
              reason: 'exact_node_verification_missing',
              where: a.tool,
              pageUrl: a.pageUrl || a.pageUrlBefore || null,
              narration: a.narration || a.stepTitle || null,
              elementLabel: flabel || rawLabel || null,
              ref: (f && (f.ref || f.target)) || null,
              coordinate: null,
              strategiesTried: [],
              transient: false,
              detail:
                'The performed field action has no exact-node verified locator evidence. It remains diagnostic and no locator was guessed.',
            };
          gaps.push(locatorGap);
          findings.push({
            ...locatorGap,
            category: 'platform_evidence_integrity_failure',
            severity: 'warning',
            nonBlocking: true,
            contractStepId: a.contractStepId || a.actionIdentity?.contractStepId || null,
            actionOccurrenceId: a.actionOccurrenceId || a.actionIdentity?.actionOccurrenceId || null,
          });
          continue;
        }
        if (!candidates.length) {
          findings.push({
            code: 'verified_locator_not_renderable',
            category: 'platform_evidence_integrity_failure',
            severity: 'warning',
            nonBlocking: true,
            where: a.tool,
            contractStepId: a.contractStepId || a.actionIdentity?.contractStepId || null,
            actionOccurrenceId: a.actionOccurrenceId || a.actionIdentity?.actionOccurrenceId || null,
            elementLabel: flabel || rawLabel || null,
            detail: 'The exact-node verified field locator could not be represented by the selected Playwright candidate model.',
          });
          continue;
        }
        const as = allocateLocatorRef({
          label: flabel || rawLabel || (f && (f.name || f.type)),
          action: 'fill',
          roleHint: f && f.type,
          candidates,
        });
        const resolveStep = applyContractMetadataToReplayStep(
          {
            op: 'resolve',
            as,
            candidates,
            elementLabel: flabel || rawLabel || (f && (f.name || f.type)) || null,
            narration: flabel || rawLabel || (f && (f.name || f.type)) || null,
            locatorConfidence: 'verified',
          },
          a,
        );
        const replayLocator = actionLocatorForReplay(verifiedFieldLocator);
        if (replayLocator) resolveStep.actionLocator = replayLocator;
        if (a.stepAuthoring) resolveStep.stepAuthoringId = a.stepAuthoring.id || null;
        if (a.locatorRecipe || a.stepAuthoring?.locatorRecipe)
          resolveStep.locatorRecipeId =
            (a.locatorRecipe || a.stepAuthoring.locatorRecipe).id || null;
        steps.push(resolveStep);
        const fillRef = safeValueRef({
          label: flabel || rawLabel,
          role: f && f.type,
          sensitivity: sensitivityFor(
            dataRow && dataRow.sensitivity,
            f && f.type,
            flabel || rawLabel,
          ),
          credentialRefs,
        });
        const formAct = applyContractMetadataToReplayStep(
          { op: 'act', target: as, action: 'fill', valueRef: fillRef },
          a,
        );
        formAct.locatorConfidence = 'verified';
        if (replayLocator) formAct.actionLocator = replayLocator;
        if (resolveStep.locatorRecipeId) formAct.locatorRecipeId = resolveStep.locatorRecipeId;
        if (a.stepAuthoring) {
          formAct.stepAuthoringId = a.stepAuthoring.id || null;
          formAct.stepIntentHash = a.stepAuthoring.stepIntentHash || null;
        }
        if (a.transitionProof || a.stepAuthoring?.transitionProof) {
          formAct.transitionProof = a.transitionProof || a.stepAuthoring.transitionProof;
        }
        // Inline the literal value for synthetic (non-credential) fields so each spec
        // uses the value ACTUALLY typed during the run — not a shared env var.
        const isFormSecret = /pass|pwd|secret|user|email|login|otp|mfa|token|code/i.test(
          String(flabel || rawLabel || (f && f.type) || ''),
        );
        // Security test payloads (SQLi, XSS, etc.) must be inlined verbatim even when the
        // target field name matches the credential regex — they are test inputs, not real
        // credentials. Suppressing them with readEnv('QAAI_USERNAME') produces specs that
        // test nothing (they just submit "Admin" again instead of the injection payload).
        const isSecurityPayload =
          isFormSecret &&
          enteredValue != null &&
          /['";<>]|--\s|\/\*|\*\/|OR\s+\d+=\d+|UNION.*SELECT|alert\s*\(/i.test(
            String(enteredValue),
          );
        // Negative-path detection: a credential-shaped field was filled with a value that
        // is NOT in the set of known real credentials → it is a wrong/empty credential used
        // to test rejection. Inline it verbatim so the spec submits the actual wrong value
        // instead of readEnv("QAAI_PASSWORD") which would log in successfully.
        const isWrongCred =
          isFormSecret &&
          !isSecurityPayload &&
          enteredValue != null &&
          credentialValues instanceof Set &&
          credentialValues.size > 0 &&
          !credentialValues.has(String(enteredValue).trim());
        const declaredNegativeValue = isFormSecret
          ? declaredCredentialInputs.next({
              label: flabel || rawLabel || (f && f.type),
              value: enteredValue,
              caseTitle: title,
            })
          : null;
        if (declaredNegativeValue != null) {
          formAct.rawValue = declaredNegativeValue;
          findings.push({
            code: 'declared_negative_credential_preserved',
            detail: `Preserved declared negative credential/test input for ${flabel || rawLabel || (f && f.type) || 'field'} so export does not substitute canonical env credentials.`,
          });
        } else if (
          (!isFormSecret || isSecurityPayload || isWrongCred) &&
          enteredValue != null &&
          String(enteredValue).trim()
        ) {
          formAct.rawValue = String(enteredValue).trim();
        }
        // Tag with the data-row role when this fill sources from the active data row.
        // Adapters use step.dataRole to emit readData(row, role) rather than an inline
        // literal, converting the replay into a proper data-driven spec that iterates
        // all rows. resolveDataRole tries: exact f.type match, label-normalized match
        // ("Username" → "username"), then value match (non-secret only).
        applyBindingToReplayStep(formAct, dataBindingOf(f) || dataBindingOf(a));
        if (!formAct.dataRole) {
          const role = resolveDataRole(
            f && f.type,
            flabel || rawLabel,
            enteredValue,
            dataFieldsOf(dataRow),
            isFormSecret,
          );
          if (role) {
            formAct.dataRole = toSafeDataRole(role);
            formAct.dataBinding = formAct.dataBinding || {
              isDataBound: true,
              sourceColumn: role,
              source: 'replay_data_row',
            };
            delete formAct.rawValue;
          }
        }
        const authoritativeLiteral =
          declaredNegativeValue != null
            ? declaredNegativeValue
            : (isSecurityPayload || isWrongCred) &&
                enteredValue != null &&
                String(enteredValue).trim()
              ? String(enteredValue).trim()
              : null;
        if (authoritativeLiteral != null) {
          formAct.rawValue = authoritativeLiteral;
          delete formAct.valueRef;
          delete formAct.dataRole;
          delete formAct.dataBinding;
        }
        applyContractMetadataToReplayStep(formAct, a);
        steps.push(formAct);
      }
      continue;
    }

    const label =
      action === 'drag'
        ? args.endElement ||
          args.targetElement ||
          args.targetLabel ||
          args.targetName ||
          args.element ||
          args.name ||
          args.endTarget ||
          args.target ||
          'drop target'
        : args.element || args.name || args.ref || '';
    if (NEEDS_LOCATOR.has(action)) {
      emitInitialNavigation(a);
      _emitContextSwitchIfNeeded(
        a,
        contextTransitions,
        findings,
        activePageUrl,
        normalizeUrlForTabCheck,
      );
      if (a.pageUrl && activePageUrl !== String(a.pageUrl)) activePageUrl = String(a.pageUrl);
      const repairedActionLocator = repairedReplayLocatorFromEvidence(a);
      const verifiedActionLocator = bestReplayLocator(
        a.actionLocator,
        repairedActionLocator,
        a.codegenLocator,
        legacyDomFactsReplayLocator(a),
        a.locatorDiagnostic,
      );
      const candidates = actionLocatorCandidates(verifiedActionLocator);
      if (!verifiedActionLocator) {
        const targetRef = args.ref || args.target || args.element || args.selector || null;
        const wait = operationWaitFromTrail(a, targetRef);
        if (wait) steps.push(applyContractMetadataToReplayStep(wait, a));
        const locatorGap =
          locatorGapFromTrail(a, {
            narration: a.narration || a.stepTitle || null,
            elementLabel: label || args.element || args.name || args.role || null,
            where: a.tool,
          }) || {
            code: 'locator_unverified',
            type: 'locator_unverified',
            reason: 'exact_node_verification_missing',
            where: a.tool,
            pageUrl: a.pageUrl || a.pageUrlBefore || null,
            narration: a.narration || a.stepTitle || null,
            elementLabel: label || args.element || args.name || args.role || null,
            ref: args.ref || null,
            coordinate:
              Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))
                ? { x: Number(args.x), y: Number(args.y) }
                : null,
            strategiesTried: [],
            transient: false,
            detail:
              'The performed action has no exact-node verified locator evidence. It remains diagnostic and no locator was guessed.',
          };
        gaps.push(locatorGap);
        findings.push({
          ...locatorGap,
          category: 'platform_evidence_integrity_failure',
          severity: 'warning',
          nonBlocking: true,
          contractStepId: a.contractStepId || a.actionIdentity?.contractStepId || null,
          actionOccurrenceId: a.actionOccurrenceId || a.actionIdentity?.actionOccurrenceId || null,
        });
        continue;
      }
      if (!candidates.length) {
        const targetRef = args.ref || args.target || args.element || args.selector || null;
        const wait = operationWaitFromTrail(a, targetRef);
        if (wait) steps.push(applyContractMetadataToReplayStep(wait, a));
        findings.push({
          code: 'verified_locator_not_renderable',
          category: 'platform_evidence_integrity_failure',
          severity: 'warning',
          nonBlocking: true,
          where: a.tool,
          contractStepId: a.contractStepId || a.actionIdentity?.contractStepId || null,
          actionOccurrenceId: a.actionOccurrenceId || a.actionIdentity?.actionOccurrenceId || null,
          elementLabel: label || args.element || args.name || args.role || null,
          detail: 'The exact-node verified locator could not be represented by the selected Playwright candidate model.',
        });
        continue;
      }
      const verifiedDragSourceLocator =
        action === 'drag'
          ? bestReplayLocator(a.dragSourceLocator, a.sourceActionLocator)
          : null;
      const dragSourceCandidates = verifiedDragSourceLocator
        ? actionLocatorCandidates(verifiedDragSourceLocator)
        : [];
      if (action === 'drag' && (!verifiedDragSourceLocator || !dragSourceCandidates.length)) {
        findings.push({
          code: !verifiedDragSourceLocator
            ? 'platform_drag_source_locator_evidence_missing'
            : 'verified_drag_source_locator_not_renderable',
          category: 'platform_evidence_integrity_failure',
          severity: 'warning',
          nonBlocking: true,
          where: a.tool,
          contractStepId: a.contractStepId || a.actionIdentity?.contractStepId || null,
          actionOccurrenceId: a.actionOccurrenceId || a.actionIdentity?.actionOccurrenceId || null,
          elementLabel:
            args.startElement || args.sourceElement || args.sourceLabel || args.sourceName || null,
          detail: !verifiedDragSourceLocator
            ? 'The performed drag has no exact-node verified source locator evidence. The drag remains diagnostic and no source locator was guessed.'
            : 'The exact-node verified drag source locator could not be represented by the selected Playwright candidate model.',
        });
        continue;
      }
      const as = allocateLocatorRef({
        label: label || args.element || args.name || args.role,
        action,
        roleHint: args.role,
        candidates,
      });
      const resolveStep = applyContractMetadataToReplayStep(
        {
          op: 'resolve',
          as,
          candidates,
          elementLabel: label || args.element || args.name || args.role || action || null,
          narration: label || args.element || args.name || args.role || action || null,
          locatorConfidence: 'verified',
        },
        a,
      );
      const replayLocator = verifiedActionLocator
        ? actionLocatorForReplay(verifiedActionLocator)
        : null;
      if (replayLocator) resolveStep.actionLocator = replayLocator;
      if (a.stepAuthoring) resolveStep.stepAuthoringId = a.stepAuthoring.id || null;
      if (a.locatorRecipe || a.stepAuthoring?.locatorRecipe)
        resolveStep.locatorRecipeId = (a.locatorRecipe || a.stepAuthoring.locatorRecipe).id || null;
      steps.push(resolveStep);
      if (action === 'waitFor') {
        const waitStep = applyContractMetadataToReplayStep({
          op: 'waitFor',
          condition: replayConditionForRuntimeWait(a, as),
        }, a);
        if (replayLocator) waitStep.actionLocator = replayLocator;
        if (resolveStep.locatorRecipeId) waitStep.locatorRecipeId = resolveStep.locatorRecipeId;
        steps.push(attachOperationCheck(waitStep, a));
        continue;
      }
      let dragSourceResolve = null;
      if (action === 'drag') {
        const recordedSourceLabel =
          args.startElement ||
          args.sourceElement ||
          args.sourceLabel ||
          args.sourceName ||
          args.startTarget ||
          args.source ||
          '';
        const sourceHasSemanticLabel =
          !!recordedSourceLabel && !/^e\d+$/i.test(String(recordedSourceLabel).trim());
        const sourceLabel = sourceHasSemanticLabel ? String(recordedSourceLabel) : 'drag source';
        const sourceAs = allocateLocatorRef({
          label: sourceLabel,
          action: 'drag',
          roleHint: args.sourceRole,
          candidates: dragSourceCandidates,
          qualifier: 'source',
        });
        const sourceReplayLocator = actionLocatorForReplay(verifiedDragSourceLocator);
        dragSourceResolve = applyContractMetadataToReplayStep(
          {
            op: 'resolve',
            as: sourceAs,
            candidates: dragSourceCandidates,
            elementLabel: sourceLabel,
            narration: sourceLabel,
            locatorConfidence: 'verified',
            actionLocator: sourceReplayLocator,
          },
          a,
        );
        steps.push(dragSourceResolve);
      }
      const actTarget = dragSourceResolve ? dragSourceResolve.as : as;
      const act = applyContractMetadataToReplayStep({ op: 'act', target: actTarget, action }, a);
      if (['click', 'doubleClick', 'tripleClick'].includes(action)) {
        const button = String(args.button || '').toLowerCase();
        if (['left', 'middle', 'right'].includes(button)) act.button = button;
        const modifiers = (Array.isArray(args.modifiers) ? args.modifiers : [])
          .map((value) => String(value || '').trim())
          .filter(Boolean);
        if (modifiers.length) act.modifiers = modifiers;
        if (Number.isFinite(recordedClickCount) && recordedClickCount > 0)
          act.clickCount = Math.floor(recordedClickCount);
        else if (action === 'doubleClick') act.clickCount = 2;
        else if (action === 'tripleClick') act.clickCount = 3;
      }
      if (action === 'selectOption') {
        const optionValues = (Array.isArray(args.values) ? args.values : [args.value ?? args.text])
          .filter((value) => value != null)
          .map(String);
        if (optionValues.length) act.optionValues = optionValues;
      }
      if (action === 'upload') {
        const filePaths = (
          Array.isArray(args.paths)
            ? args.paths
            : Array.isArray(args.files)
              ? args.files
              : [args.path ?? args.file ?? args.files]
        )
          .filter((value) => value != null && String(value).trim())
          .map(String);
        if (filePaths.length) act.filePaths = filePaths;
      }
      if (dragSourceResolve) {
        act.destinationTarget = as;
        if (args.startTarget != null) act.sourceRef = String(args.startTarget);
        if (args.endTarget != null) act.destinationRef = String(args.endTarget);
        act.locatorConfidence = 'verified';
        if (dragSourceResolve.actionLocator)
          act.sourceActionLocator = dragSourceResolve.actionLocator;
        if (replayLocator) act.destinationActionLocator = replayLocator;
      }
      if (!dragSourceResolve) act.locatorConfidence = 'verified';
      if (replayLocator && !dragSourceResolve) act.actionLocator = replayLocator;
      if (resolveStep.locatorRecipeId) {
        if (dragSourceResolve) act.destinationLocatorRecipeId = resolveStep.locatorRecipeId;
        else act.locatorRecipeId = resolveStep.locatorRecipeId;
      }
      if (a.stepAuthoring) {
        act.stepAuthoringId = a.stepAuthoring.id || null;
        act.stepIntentHash = a.stepAuthoring.stepIntentHash || null;
      }
      if (a.transitionProof || a.stepAuthoring?.transitionProof) {
        act.transitionProof = a.transitionProof || a.stepAuthoring.transitionProof;
      }
      if (VALUE_ACTIONS.has(action)) {
        act.valueRef = safeValueRef({
          label,
          role: args.role,
          sensitivity: sensitivityFor(dataRow && dataRow.sensitivity, args.role, label),
          credentialRefs,
        });
        // Inline the literal for synthetic (non-credential) fills so tests use the real value
        const rawVal =
          action === 'selectOption' && act.optionValues?.length === 1
            ? act.optionValues[0]
            : action === 'upload' && act.filePaths?.length === 1
              ? act.filePaths[0]
              : (args.text ?? args.value ?? args.key ?? null);
        const isSecret = /pass|pwd|secret|user|email|login|otp|mfa|token|code/i.test(
          String(label || args.role || ''),
        );
        // Security test payloads (SQLi, XSS, etc.) must be inlined even when the field
        // label looks like a credential field — the payload IS the test input.
        const isSecPayload =
          isSecret &&
          rawVal != null &&
          /['";<>]|--\s|\/\*|\*\/|OR\s+\d+=\d+|UNION.*SELECT|alert\s*\(/i.test(String(rawVal));
        // Negative-path: credential-shaped field filled with a value not in the known
        // real credentials set → wrong credential → inline it (same logic as fill_form path).
        const isWrongCredScalar =
          isSecret &&
          !isSecPayload &&
          rawVal != null &&
          credentialValues instanceof Set &&
          credentialValues.size > 0 &&
          !credentialValues.has(String(rawVal).trim());
        const declaredNegativeValue = isSecret
          ? declaredCredentialInputs.next({
              label: label || args.role,
              value: rawVal,
              caseTitle: title,
            })
          : null;
        if (declaredNegativeValue != null) {
          act.rawValue = declaredNegativeValue;
          findings.push({
            code: 'declared_negative_credential_preserved',
            detail: `Preserved declared negative credential/test input for ${label || args.role || 'field'} so export does not substitute canonical env credentials.`,
          });
        } else if (
          (!isSecret || isSecPayload || isWrongCredScalar) &&
          rawVal != null &&
          String(rawVal).trim()
        ) {
          act.rawValue = String(rawVal).trim();
        }
        // Same data-role tagging for scalar fills (browser_fill / browser_type).
        applyBindingToReplayStep(act, dataBindingOf(args) || dataBindingOf(a));
        if (!act.dataRole) {
          const role = resolveDataRole(args.role, label, rawVal, dataFieldsOf(dataRow), isSecret);
          if (role) {
            act.dataRole = toSafeDataRole(role);
            act.dataBinding = act.dataBinding || {
              isDataBound: true,
              sourceColumn: role,
              source: 'replay_data_row',
            };
            delete act.rawValue;
          }
        }
        const authoritativeLiteral =
          declaredNegativeValue != null
            ? declaredNegativeValue
            : (isSecPayload || isWrongCredScalar) && rawVal != null && String(rawVal).trim()
              ? String(rawVal).trim()
              : null;
        if (authoritativeLiteral != null) {
          act.rawValue = authoritativeLiteral;
          delete act.valueRef;
          delete act.dataRole;
          delete act.dataBinding;
        }
        applyContractMetadataToReplayStep(act, a);
      }
      attachOperationCheck(act, a);
      steps.push(act);
      const wait = operationWaitFromTrail(a, as);
      if (wait) steps.push(applyContractMetadataToReplayStep(wait, a));
    } else {
      steps.push(
        applyContractMetadataToReplayStep(
          attachOperationCheck({ op: 'act', action }, a),
          a,
        ),
      );
      const targetRef = args.ref || args.target || args.element || args.selector || null;
      const wait = operationWaitFromTrail(a, targetRef);
      if (wait) steps.push(applyContractMetadataToReplayStep(wait, a));
    }
  }

  // Build fill-literal → env-ref map for expectedRef: when a UI_TEXT assertion's expected
  // value is the same literal that was filled in this case, the codegen can emit
  // readEnv(key) instead of a hardcoded string, keeping fill and assertion in sync.
  // Reconcile authored metadata onto the live trail. The trail is the only
  // executable authority: an authored step that has no executed occurrence is
  // retained as parity evidence, never synthesized into browser behavior.
  const plannedSteps = reconciledPlannedSteps(input);
  const plannedIdentityAuthoritative = plannedSteps.some(
    (step) => step && typeof step === 'object' && (step.contractStepId || step.stepId || step.id),
  );
  const resolveByRef = new Map(
    steps.filter((step) => step && step.op === 'resolve' && step.as).map((step) => [step.as, step]),
  );
  const emittedOperationRecords = steps
    .filter((step) => step && ((step.op === 'act' && step.action) || step.op === 'waitFor'))
    .map((step) => {
      const action = step.op === 'waitFor' ? 'waitFor' : step.action;
      const targetRef = step.op === 'waitFor' ? step.condition?.target : step.target;
      const resolve = targetRef ? resolveByRef.get(targetRef) || null : null;
      const label =
        action === 'navigate'
          ? step.url
          : resolve?.elementLabel ||
            resolve?.narration ||
            step.elementLabel ||
            step.narration ||
            action;
      return {
        step,
        resolve,
        action,
        label,
        identity: actionOccurrenceIdentityFrom(step, resolve),
        consumed: false,
      };
    });
  const plannedOccurrenceOrdinals = new Map();
  const plannedOrderByOccurrence = new Map();
  const plannedOrderByAuthoredAction = new Map();
  const plannedOrderByContract = new Map();

  for (const [plannedIndex, planned] of plannedSteps.entries()) {
    const action = plannedReplayAction(planned);
    if (!action) continue;
    const explicitContractStepId =
      planned && typeof planned === 'object'
        ? planned.id || planned.stepId || planned.contractStepId || null
        : null;
    const contractStepId = String(explicitContractStepId || 'planned-step-' + (plannedIndex + 1));
    const rawDependencies =
      planned && typeof planned === 'object'
        ? planned.dependsOnStepIds || planned.dependsOn || planned.dependencies || []
        : [];
    const dependsOnStepIds = Array.isArray(rawDependencies) ? rawDependencies.map(String) : [];
    const ordinalKey = `${caseId || 'case'}:${contractStepId}:${action}`;
    const nextOccurrenceOrdinal = (plannedOccurrenceOrdinals.get(ordinalKey) || 0) + 1;
    const plannedIdentity = plannedActionOccurrenceIdentity({
      caseId,
      planned,
      plannedIndex,
      contractStepId,
      action,
      occurrenceOrdinal: nextOccurrenceOrdinal,
    });
    plannedOccurrenceOrdinals.set(
      ordinalKey,
      Math.max(
        nextOccurrenceOrdinal,
        positiveOccurrenceOrdinal(plannedIdentity.occurrenceOrdinal, nextOccurrenceOrdinal),
      ),
    );
    if (plannedIdentity.actionOccurrenceId)
      plannedOrderByOccurrence.set(String(plannedIdentity.actionOccurrenceId), plannedIndex);
    if (plannedIdentity.authoredActionId)
      plannedOrderByAuthoredAction.set(String(plannedIdentity.authoredActionId), plannedIndex);
    if (!plannedOrderByContract.has(contractStepId))
      plannedOrderByContract.set(contractStepId, plannedIndex);
    const exact = emittedOperationRecords.find(
      (record) =>
        !record.consumed &&
        String(record.step.contractStepId || '') === contractStepId &&
        record.action === action &&
        stableOccurrenceIdentitiesCompatible(record.identity, plannedIdentity),
    );
    if (exact) {
      exact.consumed = true;
      const mergedIdentity =
        actionOccurrenceIdentityFrom(exact.step, exact.resolve, plannedIdentity) || plannedIdentity;
      applyActionOccurrenceIdentity(exact.step, mergedIdentity);
      exact.step.authored = true;
      exact.step.origin = exact.step.origin || 'runtime_evidence';
      if (dependsOnStepIds.length) exact.step.dependsOnStepIds = dependsOnStepIds;
      if (exact.resolve) {
        applyActionOccurrenceIdentity(exact.resolve, mergedIdentity);
        exact.resolve.authored = true;
        exact.resolve.origin = exact.resolve.origin || 'runtime_evidence';
        if (dependsOnStepIds.length) exact.resolve.dependsOnStepIds = dependsOnStepIds;
      }
      continue;
    }
    const label = plannedStepText(planned) || action + ' target';

    findings.push({
      code: 'planned_step_not_executed',
      severity: 'warning',
      where: contractStepId,
      elementLabel: label,
      detail:
        'The authored step has no exact executed occurrence in the live trail and was not emitted as runnable code.',
    });
    continue;
  }
  if (plannedSteps.length) {
    const plannedOrderForStep = (step) => {
      const identity = actionOccurrenceIdentityFrom(step);
      if (
        identity?.actionOccurrenceId &&
        plannedOrderByOccurrence.has(String(identity.actionOccurrenceId))
      ) {
        return plannedOrderByOccurrence.get(String(identity.actionOccurrenceId));
      }
      if (
        identity?.authoredActionId &&
        plannedOrderByAuthoredAction.has(String(identity.authoredActionId))
      ) {
        return plannedOrderByAuthoredAction.get(String(identity.authoredActionId));
      }
      const contractId = step?.contractStepId == null ? null : String(step.contractStepId);
      return contractId && plannedOrderByContract.has(contractId)
        ? plannedOrderByContract.get(contractId)
        : null;
    };
    const authoredPositions = [];
    const authoredSteps = [];
    for (const [stepIndex, step] of steps.entries()) {
      const plannedOrder = plannedOrderForStep(step);
      if (plannedOrder == null) continue;
      authoredPositions.push(stepIndex);
      authoredSteps.push({ step, plannedOrder, stepIndex });
    }
    authoredSteps.sort(
      (left, right) => left.plannedOrder - right.plannedOrder || left.stepIndex - right.stepIndex,
    );
    authoredPositions.forEach((position, index) => {
      steps[position] = authoredSteps[index].step;
    });
  }
  if (plannedSteps.length) {
    for (const record of emittedOperationRecords) {
      if (record.consumed) continue;
      record.step.origin = record.step.origin || 'runtime_evidence';
      record.step.evidenceOnly = false;
      if (record.resolve) {
        record.resolve.origin = record.resolve.origin || 'runtime_evidence';
        record.resolve.evidenceOnly = false;
      }
      findings.push({
        code: 'runtime_operation_without_authored_match',
        severity: 'info',
        where: record.step.contractStepId || record.step.sourceContractStepId || record.action,
        detail:
          'The executed runtime occurrence had no exact authored identity match and remains executable under its runtime identity.',
      });
    }
  }
  const fillLiteralToRef = new Map();
  // Build fill-literal → dataRole map: when an assertion's expected text equals a value
  // from the data row (i.e. a tagged DDT fill), prefer row-keyed reference over env-var.
  // This is the "Hello, alice" fix: if the case fills username="alice" and asserts
  // that the welcome banner contains "alice", the assertion should emit readData(row,role)
  // so the test stays correct when the loop runs a different row (e.g. username="bob").
  const fillLiteralToDataRole = new Map();
  for (const s of steps) {
    if (s.authored !== false && s.op === 'act' && s.action === 'fill' && s.rawValue) {
      const key = String(s.rawValue).trim().toLowerCase();
      if (s.dataRole) fillLiteralToDataRole.set(key, s.dataRole);
      if (s.valueRef && /^env:/i.test(s.valueRef)) fillLiteralToRef.set(key, s.valueRef);
    }
  }

  // Assertions → assert steps mapped to the declared contract. The recorded outcome
  // (matched/not_matched/uncheckable) becomes evidence + verdict.perAssertionOutcomes.
  const outcomeById = new Map((assertionOutcomes || []).map((o) => [o.assertionId, o]));
  for (const da of declaredAssertions || []) {
    if (!da || !da.id) continue;
    if (directAssertionRefs.has(da.id)) continue;
    const channel = CHANNEL[da.type] || 'EVALUATE';
    const o = outcomeById.get(da.id);
    const outcomeStatus = String(o?.outcome || o?.status || '').trim().toLowerCase();
    const evaluated =
      !!o &&
      (typeof o.matched === 'boolean' ||
        o.checked === true ||
        ['matched', 'not_matched', 'pass', 'passed', 'fail', 'failed'].includes(outcomeStatus));
    if (!evaluated) {
      findings.push({
        code: 'assertion_outcome_not_evaluated',
        severity: 'warning',
        where: da.id,
        detail:
          'The authored assertion has no evaluated runtime outcome and was not emitted as runnable code.',
      });
      continue;
    }
    const payload = da.payload || {};
    const step = {
      op: 'assert',
      contractRef: da.id,
      channel,
      origin: 'runtime_evidence',
      authored: true,
      canonicalExecution: true,
      runtimeEvidence: true,
      checked: true,
      ...(da.contractStepId ? { contractStepId: String(da.contractStepId) } : {}),
      ...(da.sourceContractStepId ? { sourceContractStepId: String(da.sourceContractStepId) } : {}),
    };
    // EVALUATE assertions carry the JS script to run — thread it so the adapter
    // can emit page.evaluate(script) instead of a hard throw.
    if (channel === 'EVALUATE' && payload.script && typeof payload.script === 'string') {
      step.script = payload.script.trim();
    }
    if (channel === 'PAGE') {
      if (payload.expectedSignals && typeof payload.expectedSignals === 'object')
        step.expectedSignals = payload.expectedSignals;
      if (payload.signals && typeof payload.signals === 'object') step.signals = payload.signals;
      if (payload.primaryIndicator && typeof payload.primaryIndicator === 'object')
        step.primaryIndicator = payload.primaryIndicator;
    }
    const authoredExpected = expectedFromPayload(payload);
    const expected =
      authoredExpected != null && String(authoredExpected).trim() !== ''
        ? authoredExpected
        : o?.expected ?? o?.expectedValue ?? o?.expectedText ?? null;
    const explicitMatched = typeof o?.matched === 'boolean' ? o.matched : null;
    const assertionPassed =
      explicitMatched === true || ['matched', 'pass', 'passed'].includes(outcomeStatus);
    const assertionFailed =
      explicitMatched === false || ['not_matched', 'fail', 'failed'].includes(outcomeStatus);
    const actual = o?.actual ?? o?.actualValue ?? o?.actualText ?? null;
    step.assertionId = o?.assertionId || da.id;
    if (o?.assertionEvidenceId || o?.id)
      step.assertionEvidenceId = o.assertionEvidenceId || o.id;
    if (explicitMatched != null) step.matched = explicitMatched;
    step.liveOutcome = assertionFailed ? 'not_matched' : assertionPassed ? 'matched' : outcomeStatus;
    step.executionStatus = assertionFailed ? 'failed' : assertionPassed ? 'passed' : 'evaluated';
    if (actual != null) step.actual = actual;
    if (expected != null) {
      step.expected = expected;
      const assertionBinding =
        dataBindingOf(o) || dataBindingOf(da) || (payload && dataBindingOf(payload));
      const boundExpectedRole = dataRoleFromBinding(assertionBinding);
      if (boundExpectedRole) {
        step.dataBinding = cloned(assertionBinding);
        step.dataExpected = boundExpectedRole;
      }
      const fields = dataFieldsOf(dataRow);
      const domainAssertion = inferDomainAssertion({ expected, payload, fields, channel });
      if (domainAssertion) {
        step.domainAssertion = domainAssertion;
        if (domainAssertion.role && !step.dataExpected)
          step.dataExpected = toSafeDataRole(domainAssertion.role);
      }
      if (channel === 'UI_TEXT' || channel === 'FORBIDDEN_TEXT') {
        const literal = String(expected).trim().toLowerCase();
        // Prefer the data-row reference: if the expected value matches a DDT fill
        // (e.g. assert "Hello, alice" after filling username="alice"), tag with the
        // data role so codegen emits readData(row, role) — surviving row iteration.
        const dataRole = fillLiteralToDataRole.get(literal);
        if (dataRole && !step.dataExpected) {
          step.dataExpected = dataRole;
        } else {
          const semanticRole = inferExpectedDataRole(expected, fields, [
            'expectedContainsProductName',
            'assertProductCategory',
            'productName',
            'searchName',
          ]);
          if (semanticRole && !step.dataExpected) step.dataExpected = semanticRole;
          // Fall back to env-ref binding for credential/non-data fills.
          const envRef = fillLiteralToRef.get(literal);
          if (envRef && !step.dataExpected) step.expectedRef = envRef;
        }
      }
    }
    if (
      CHANNELS_REQUIRING_EXPECTED.has(channel) &&
      (expected == null || String(expected).trim() === '') &&
      !step.dataExpected &&
      !(step.dataBinding && step.dataBinding.expectedColumn)
    ) {
      const authoredContractText = [
        payload.description,
        payload.instruction,
        payload.assertion,
        payload.check,
        da.description,
        da.instruction,
        da.assertion,
        da.check,
      ].find((value) => value != null && String(value).trim());
      step.missingAuthoredExpected = true;
      step.authoredContractText = String(authoredContractText || `${channel} assertion`).trim();
      findings.push({
        code: 'missing_assertion_expected_preserved',
        severity: 'warning',
        where: da.id,
        detail: `${channel} assertion '${da.id}' has no concrete expected value. It remains executable as an explicit soft-failing authored-contract assertion so the omission cannot be silent.`,
      });
    }
    // Carry the container scope recorded by the agent during assertion_check.
    // When present, codegen emits a scoped assertion (page.locator(selector)) instead
    // of assertTextPresent — proves the right container contains the value, not just
    // some nav/footer/sidebar element on the page.
    if (
      o &&
      o.containerSelector &&
      typeof o.containerSelector === 'string' &&
      o.containerSelector.trim()
    ) {
      step.scope = { selector: o.containerSelector.trim() };
    }
    // Advisory finding: unscoped text assertions may produce false passes when matching
    // nav/header/footer text. Not a gap (doesn't block export) but surfaced so operators
    // can see which assertions were verified against the whole page.
    if ((channel === 'UI_TEXT' || channel === 'FORBIDDEN_TEXT') && !step.scope) {
      findings.push({
        code: 'unscoped_text_assertion',
        where: da.id,
        detail: `${channel} assertion "${expected != null ? String(expected).slice(0, 60) : '(none)'}": no containerSelector recorded — assertion verified full-page text; false pass from sidebar/nav/footer text is possible.`,
      });
    }
    step.evidence = { source: 'MCP', outcome: o ? o.outcome : 'uncheckable' };
    if (o && o.evidence && typeof o.evidence === 'string')
      step.evidence.snapshotText = o.evidence.slice(0, 400);
    steps.push(step);
  }

  // Human input → explicit disposition (never silently skipped).
  for (const hi of humanInputs || []) {
    if (!hi) continue;
    const disposition = ['manual_gate', 'test_hook', 'unsupported'].includes(hi.disposition)
      ? hi.disposition
      : 'manual_gate';
    const step = { op: 'humanInput', field: hi.field || 'input', disposition };
    if (disposition === 'test_hook')
      step.valueRef =
        hi.valueRef && /^(env|vault|fixture|masked):/i.test(hi.valueRef)
          ? hi.valueRef
          : safeValueRef({ label: hi.field, role: hi.field });
    steps.push(step);
  }

  // dataRows role-keyed; masked/restricted and credential-shaped field VALUES
  // become refs (no test-data leak). Runtime may supply `inputs` before it has
  // assembled `fields`, so project from the same fallback used for role matching.
  const projectRow = (row) => {
    if (!row || typeof row !== 'object') return row;
    const out = {
      index: Number(row.index) || 0,
      label: row.label || `Row ${Number(row.index) || 0}`,
    };
    const credentialSensitivity = (role) => {
      const effectiveRole =
        role === 'expected' && row.expectedColumn
          ? row.expectedColumn
          : role === 'rowClass' && row.rowClassColumn
            ? row.rowClassColumn
            : role;
      const declaredSource = row.fieldSensitivity || row.sensitivity;
      const declared = sensitivityFor(declaredSource, role, effectiveRole);
      const effectiveDeclared =
        declared === 'synthetic' && effectiveRole !== role
          ? sensitivityFor(declaredSource, effectiveRole, effectiveRole)
          : declared;
      const roleText = String(effectiveRole || '');
      if (
        /(pass(word)?|passwd|pwd|secret|token|otp|mfa|pin|api.?key|credential|cvv|ssn|auth)/i.test(
          roleText,
        )
      )
        return 'masked';
      if (
        /(user(name)?|login|email|phone|mobile|passport|aadhaar|national.?id|tax.?id|credit|card|address|dob|birth)/i.test(
          roleText,
        )
      )
        return 'restricted';
      return ['synthetic', 'masked', 'restricted'].includes(String(effectiveDeclared))
        ? effectiveDeclared
        : 'synthetic';
    };
    const provenance = (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const projected = {};
      for (const key of [
        'kind',
        'type',
        'sheet',
        'sheetId',
        'setName',
        'testDataSetId',
        'datasetId',
        'datasetRevisionId',
        'mappingId',
        'mappingVersion',
        'workbookHash',
        'rowGroupId',
        'rowId',
      ]) {
        if (value[key] != null && ['string', 'number', 'boolean'].includes(typeof value[key]))
          projected[key] = value[key];
      }
      return Object.keys(projected).length ? projected : null;
    };
    const sourceFields = { ...dataFieldsOf(row) };
    if (row.expectedColumn && row.expected != null) {
      sourceFields[row.expectedColumn] = row.expected;
      if (!Object.prototype.hasOwnProperty.call(sourceFields, 'expected'))
        sourceFields.expected = row.expected;
    }
    if (row.rowClassColumn && row.rowClass != null) {
      sourceFields[row.rowClassColumn] = row.rowClass;
      if (!Object.prototype.hasOwnProperty.call(sourceFields, 'rowClass'))
        sourceFields.rowClass = row.rowClass;
    }
    const fields = {};
    const sensitivity = {};
    for (const [role, val] of Object.entries(sourceFields)) {
      const roleSensitivity = credentialSensitivity(role);
      sensitivity[role] = roleSensitivity;
      fields[role] =
        roleSensitivity === 'masked' || roleSensitivity === 'restricted'
          ? safeValueRef({ role, sensitivity: roleSensitivity })
          : val;
    }
    out.sensitivity = sensitivity;
    out.fields = fields;
    for (const key of ['setName', 'sheet', 'rowId', 'expectedColumn', 'rowClassColumn']) {
      if (row[key] != null && ['string', 'number', 'boolean'].includes(typeof row[key]))
        out[key] = row[key];
    }
    if (row.expected != null) {
      const expectedRole = row.expectedColumn || 'expected';
      const expectedSensitivity = credentialSensitivity(expectedRole);
      out.expected =
        expectedSensitivity === 'masked' || expectedSensitivity === 'restricted'
          ? safeValueRef({ role: expectedRole, sensitivity: expectedSensitivity })
          : row.expected;
    }
    if (row.rowClass != null) out.rowClass = row.rowClass;
    const bindingRef = provenance(row.dataBindingRef);
    if (bindingRef) out.dataBindingRef = bindingRef;
    const sourceWorkbook = provenance(row.sourceWorkbook || row.source);
    if (sourceWorkbook) {
      out.source = sourceWorkbook;
      out.sourceWorkbook = sourceWorkbook;
    }
    return out;
  };

  const runtimeEvidence = steps
    .filter((step) => step && step.evidenceOnly === true)
    .map((step) => ({
      ...step,
      executable: false,
      diagnosticOnly: true,
    }));
  const executableSteps = steps.filter((step) => !step || step.evidenceOnly !== true);
  const ir = {
    version: 1,
    caseId: caseId || 'UNKNOWN_CASE',
    ...(title ? { title: String(title) } : {}),
    authProfile: input.authProfile || {
      id: 'default',
      strategy: 'none',
      disposition: 'bypass_fixture',
    },
    steps: executableSteps,
    verdict: {
      status: VERDICT[verdictStatus] || 'fail',
      perAssertionOutcomes: (declaredAssertions || [])
        .filter((d) => d && d.id)
        .map((d) => {
          const o = outcomeById.get(d.id);
          return {
            contractRef: d.id,
            status: o ? ASSERT_OUTCOME[o.outcome] || 'fail' : 'needs_human',
          };
        }),
    },
  };
  if (runtimeEvidence.length) ir.runtimeEvidence = runtimeEvidence;
  if (contextTransitions.length) ir.contextTransitions = contextTransitions;
  const replayDomAtlas = collectReplayDomAtlas(executableSteps);
  if (replayDomAtlas) ir.domAtlas = replayDomAtlas;
  if (authoringReport && (authoringReport.records.length || authoringReport.gaps.length)) {
    ir.authoring = authoringReport;
  }
  const locatorCertification = locatorIntelligenceV2.buildLocatorCertificationReport({ ir });
  if (locatorCertification) {
    ir.locatorCertification = locatorCertification;
    const locatorCertificationGaps =
      locatorIntelligenceV2.locatorCertificationGaps(locatorCertification);
    if (locatorCertificationGaps.length) {
      findings.push(
        ...certificationFindingsForReplay(locatorCertification).map((finding) => ({
          ...finding,
          severity: 'warning',
          code: finding.code || 'locator_uncertainty',
        })),
      );
    }
  }
  if (dataRow) ir.dataRow = projectRow(dataRow);
  if (Array.isArray(dataRows) && dataRows.length) ir.dataRows = dataRows.map(projectRow);

  // A non-empty step list is required by the contract. If a case produced no
  // scriptable actions AND no assertions (e.g. a pure did-not-run), it is a GAP —
  // both validateReplayIR (structural) and `complete:false` (evidence) reject it.
  if (!executableSteps.length && !gaps.length)
    gaps.push({ code: 'legacy_inert', where: caseId || 'case', detail: '' });

  // `complete:false` ⇒ the export lane marks this IR incomplete/unsupported and
  // surfaces `gaps` — it never ships an evidence-poor replay as if it were faithful.
  return { ir, findings, complete: gaps.length === 0, gaps };
}

module.exports = {
  buildReplayIR,
  safeValueRef,
  sensitivityFor,
  CHANNEL,
  TOOL_ACTION,
  VERDICT,
  EMITTER_VERSION,
  isInternalLocatorIdentity,
  semanticLocatorRefBase,
  createSemanticLocatorRefAllocator,
};
