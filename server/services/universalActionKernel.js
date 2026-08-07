'use strict';

const controlActionAdapter = require('./controlActionAdapter');
const genericClickExecution = require('./genericClickExecution');
const actionTransactionCoordinator = require('./actionTransactionCoordinator');
const typedAssertionComparator = require('./typedAssertionComparator');
const strictAssertionEngine = require('./strictAssertionEngine');
const waitContract = require('./waitContract');
const universalControlModel = require('./universalControlModel');
const {
  isPresenceConditionalAction,
  conditionalActionRequiredByContract,
} = require('./conditionalActionIntent');

const FAMILIES = Object.freeze({
  CLICK: 'click',
  CONTROL: 'control',
  ASSERTION: 'assertion',
  WAIT: 'wait',
  EVENT: 'event',
  UNSUPPORTED: 'unsupported',
});

const OUTCOME_KINDS = Object.freeze({
  SUCCESS: 'success',
  FUNCTIONAL_FAILURE: 'functional_failure',
  EXECUTION_UNCERTAINTY: 'qaai_execution_uncertainty',
});

const CLICK_ACTIONS = new Set(['click', 'tap']);
const WAIT_ACTIONS = new Set(['wait', 'waitforstate', 'waituntil', 'stabilize', 'stabilization']);
const ASSERTION_ACTIONS = new Set(['assert', 'assertion', 'expect', 'validate', 'validation', 'verify']);
const ASSERTION_TYPES = new Set([
  'attribute', 'checked', 'collection', 'collectionmembership', 'count', 'currency', 'date',
  'datetime', 'forbiddentext', 'hidden', 'number', 'regex', 'selected', 'table', 'tablecell',
  'tablecolumn', 'tablequery', 'tablerow', 'text', 'time', 'url', 'value', 'visible',
  'relationship', 'assertrelationship', 'temporalrelationship', 'temporalcomparison', 'asserttemporal',
]);
const EVENT_ACTIONS = new Set([
  'acceptdialog', 'dialog', 'dismissdialog', 'download', 'filechooser', 'fileupload', 'goto',
  'navigate', 'navigation', 'openpage', 'popup', 'upload',
]);

function token(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function actionToken(step = {}) {
  return token(step.action || step.verb || step.operation || step.command || step.type || step.kind);
}

function cleanAssertionText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function splitAuthoredList(value) {
  return cleanAssertionText(value)
    .replace(/[.;]\s*$/, '')
    .split(/\s*,\s*(?:and\s+)?|\s+and\s+/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

function collectionAssertionFromText(step, payload, authoredText) {
  const exact = authoredText.match(/\b(?:option\s+list|options?|items?)\s+(?:appear\s+)?in\s+(?:this\s+)?exact\s+order\s*:\s*(.+?)[.]?$/i)
    || authoredText.match(/\b(?:option\s+list|options?|items?)\s+are\s+exactly\s+(.+?)\s+in\s+(?:this\s+|that\s+)?order[.]?$/i);
  const contains = authoredText.match(/\b(?:option\s+list|options?|items?)\s+contains?\s+(.+?)[.]?$/i);
  const match = exact || contains;
  if (!match) return null;
  const expectedItems = splitAuthoredList(match[1]);
  if (expectedItems.length < 2) return null;
  const rawTarget = cleanAssertionText(controlActionAdapter.targetOf(step));
  const ownerFromTarget = rawTarget.replace(/\b(?:option\s+list|options?|items?)\b[\s\S]*$/i, '').trim();
  const ownerFromText = authoredText.match(/(?:verify\s+that\s+|the\s+)?(.+?)\s+(?:option\s+list|options?|items?)\s+(?:appear|are|contains?)/i)?.[1]?.trim();
  const owner = ownerFromTarget || ownerFromText || '';
  const targetName = owner ? `${owner} option list` : 'visible option list';
  return {
    type: 'COLLECTION',
    payload: {
      ...payload,
      target: { name: targetName, label: targetName, role: 'listbox' },
      expectedItems,
      comparator: exact ? 'ordered_equals' : 'contains_all',
    },
  };
}

function normalizedDateLiteral(value) {
  const text = cleanAssertionText(value);
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slash = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (slash) return `${slash[3]}-${String(slash[1]).padStart(2, '0')}-${String(slash[2]).padStart(2, '0')}`;
  const monthNames = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };
  const named = text.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),\s*(\d{4})\b/i);
  if (!named) return null;
  return `${named[3]}-${String(monthNames[named[1].toLowerCase()]).padStart(2, '0')}-${String(named[2]).padStart(2, '0')}`;
}

function temporalRelationshipFromText(authoredText) {
  const relation = authoredText.match(/^(?:verify\s+that\s+)?(.+?)\s+is\s+(before|after)\s+(.+?)[.]?$/i);
  if (!relation || !/date\s*\/\s*time/i.test(relation[1]) || !/date\s*\/\s*time/i.test(relation[3])) return null;
  const operand = (name) => {
    const cleanName = cleanAssertionText(name);
    const base = cleanName.replace(/\s+date\s*\/\s*time\s*$/i, '').trim();
    return {
      name: cleanName,
      kind: 'date_time',
      parts: [
        { name: `${base} Date`, kind: 'date' },
        { name: `${base} Time`, kind: 'time' },
      ],
    };
  };
  return {
    type: 'TEMPORAL_RELATIONSHIP',
    payload: {
      comparator: relation[2].toLowerCase(),
      operands: [operand(relation[1]), operand(relation[3])],
    },
  };
}

function inferredVerifyAssertion(step, payload) {
  const authoredText = cleanAssertionText(
    step.expected || payload.expectedText || payload.text || payload.expected || '',
  );
  const exactVisibleOption = authoredText.match(
    /\b(?:first|second|third|fourth|fifth)?\s*visible\s+.+?\s+option\s+is\s+exactly\s+(.+?)[.]?$/i,
  );
  if (exactVisibleOption && token(step.action || step.type) === 'assertvisible') {
    const expectedOption = exactVisibleOption[1].trim().replace(/^['"]|['"]$/g, '');
    return {
      type: 'VISIBLE',
      payload: {
        ...payload,
        target: { name: expectedOption, label: expectedOption, role: 'option' },
      },
    };
  }
  const collection = collectionAssertionFromText(step, payload, authoredText);
  if (collection) return collection;
  const relationship = temporalRelationshipFromText(authoredText);
  if (relationship) return relationship;

  const target = cleanAssertionText(controlActionAdapter.targetOf(step));
  const verifyKind = token(payload.type || payload.kind);
  const selectedValue = payload.value ?? payload.expectedValue;
  if (verifyKind === 'selected' && typeof selectedValue === 'string' && selectedValue.trim()) {
    return {
      type: 'VALUE',
      payload: {
        ...payload,
        target: payload.target || { name: target, label: target },
        expectedValue: selectedValue.trim(),
        comparator: /\bcontains?\b/i.test(authoredText) ? 'contains' : 'equals',
      },
    };
  }

  if (/^(?:selected|current)\b/i.test(target)) {
    const contained = authoredText.match(/\b(?:label|value|selection)?\s*contains?\s+(.+?)(?:;|\.\s*$|$)/i);
    const containedValue = contained?.[1]?.trim().replace(/^['"]|['"]$/g, '');
    if (containedValue) {
      return {
        type: 'VALUE',
        payload: {
          ...payload,
          target: payload.target || { name: target, label: target },
          expectedValue: containedValue,
          comparator: 'contains',
        },
      };
    }
  }

  if (/\bdate\b/i.test(target)) {
    const expectedDate = normalizedDateLiteral(authoredText);
    if (expectedDate) {
      return {
        type: 'DATE',
        payload: {
          ...payload,
          target: payload.target || { name: target, label: target },
          expectedDate,
          comparator: 'equals',
        },
      };
    }
  }

  if (/\b(?:is|remains?)\s+expanded\b/i.test(authoredText) && /\b(?:section|panel|group|disclosure)\b/i.test(target)) {
    return {
      type: 'ATTRIBUTE',
      payload: {
        ...payload,
        target: payload.target || { name: target, label: target },
        attributeName: 'aria-expanded',
        expectedValue: 'true',
        comparator: 'equals',
      },
    };
  }

  if (/\b(?:field|dropdown|control|date|time)\b/i.test(target) || /^(?:selected|current)\b/i.test(target)) {
    // Sentence punctuation is only a delimiter at the end of the authored
    // assertion. Dots inside concrete values (email addresses, hostnames,
    // semantic versions, decimals) belong to the value and must survive.
    const exact = authoredText.match(/\b(?:displays|contains)\s+exactly\s+(.+?)(?:;|\.\s*$|$)/i)
      || authoredText.match(/\bchanges?(?:\s+from\s+.+?)?\s+to\s+exactly\s+(.+?)(?:;|\.\s*$|$)/i)
      || authoredText.match(/\bis\s+exactly\s+(.+?)(?:;|\.\s*$|$)/i);
    const exactValue = exact?.[1]?.trim().replace(/^['"]|['"]$/g, '');
    if (exactValue && !/^(?:the\s+)?(?:provided|approved|expected)\s+value$/i.test(exactValue)) {
      return {
        type: 'VALUE',
        payload: {
          ...payload,
          target: payload.target || { name: target, label: target },
          expectedValue: exactValue,
          comparator: 'equals',
        },
      };
    }
  }
  return null;
}

function assertionContractOf(step = {}) {
  if (step.assertion && typeof step.assertion === 'object') return step.assertion;
  if (step.typedAssertion && typeof step.typedAssertion === 'object') return step.typedAssertion;
  if (step.verify && typeof step.verify === 'object') {
    const payload = { ...step.verify };
    const target = controlActionAdapter.targetOf(step);
    if (!payload.target && !payload.element && target) {
      payload.target = { name: target, label: target };
    }
    if (payload.expectedText == null && payload.text != null) payload.expectedText = payload.text;
    if (payload.expectedValue == null && payload.value != null) payload.expectedValue = payload.value;
    const inferred = inferredVerifyAssertion(step, payload);
    if (inferred) return inferred;
    return {
      type: step.verify.type || step.verify.kind,
      payload,
    };
  }
  if (step.operationCheck?.assertion && typeof step.operationCheck.assertion === 'object') {
    return step.operationCheck.assertion;
  }
  return step;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function assertionFailurePolicyValue(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return value;
  return firstDefined(
    value.onAssertionFailure,
    value.assertionFailure,
    value.validationMismatch,
    value.classification,
    value.mode,
    value.type,
    value.onFailure,
    value.default,
  );
}

function authoredAssertionFailurePolicy(assertion = {}, step = {}, explicitPolicy = null) {
  const payload = assertion.payload && typeof assertion.payload === 'object'
    ? assertion.payload
    : assertion;
  const direct = [
    explicitPolicy,
    assertion.failurePolicy,
    payload.failurePolicy,
    step.assertionFailurePolicy,
    step.failurePolicy,
    step.verify?.failurePolicy,
    step.operationCheck?.failurePolicy,
  ].map(assertionFailurePolicyValue).find((value) => value !== undefined && value !== null && value !== '');
  if (direct != null) return direct;

  const sources = [assertion, payload, step, step.verify, step.operationCheck].filter((value) => value && typeof value === 'object');
  if (sources.some((source) => (
    source.flowCritical === true
    || source.requiredForContinuation === true
    || source.blocking === true
    || source.blockDependents === true
  ))) return strictAssertionEngine.FAILURE_CLASS.DEPENDENCY;
  if (sources.some((source) => (
    source.continueIndependent === true
    || source.continueOnFailure === true
    || source.nonBlocking === true
    || source.soft === true
  ))) return strictAssertionEngine.FAILURE_CLASS.VALIDATION_ONLY;

  const authoredPolicy = sources.map((source) => [
    source.flowImpact,
    source.failureBehavior,
    source.continuation,
    source.dependencyMode,
    source.onFailure,
  ].filter(Boolean).join(' ')).join(' ').toLowerCase();
  if (/dependency|block[_ -]?dependents|stop[_ -]?descendants|stop[_ -]?case|required[_ -]?for[_ -]?continuation|blocking/.test(authoredPolicy)) {
    return strictAssertionEngine.FAILURE_CLASS.DEPENDENCY;
  }
  return strictAssertionEngine.FAILURE_CLASS.VALIDATION_ONLY;
}

function strictFailurePolicyMetadata(policy, failed = true) {
  const classification = strictAssertionEngine.normalizeFailureClass(policy);
  const blockDependents = failed && classification !== strictAssertionEngine.FAILURE_CLASS.VALIDATION_ONLY;
  return {
    classification,
    onFailure: classification === strictAssertionEngine.FAILURE_CLASS.VALIDATION_ONLY
      ? 'record_and_continue'
      : 'block_dependents_only',
    continueExecution: true,
    continueIndependent: true,
    blockDependents,
    blockCase: false,
    blockRun: false,
  };
}

function strictAssertionContract(assertion = {}, step = {}, explicitFailurePolicy = null) {
  const type = String(assertion.type || assertion.kind || '').trim().toUpperCase();
  const payload = assertion.payload && typeof assertion.payload === 'object'
    ? assertion.payload
    : assertion;
  const common = {
    target: payload.target || payload.element || null,
    caseSensitive: payload.caseSensitive,
    failurePolicy: authoredAssertionFailurePolicy(assertion, step, explicitFailurePolicy),
  };
  if (type === 'TEXT') {
    return {
      ...common,
      kind: strictAssertionEngine.ASSERTION_KIND.EXACT_VISIBLE_TEXT,
      expected: firstDefined(payload.expectedText, payload.expectedValue, payload.expected, payload.text),
    };
  }
  if (['VALUE', 'DATE', 'TIME', 'DATE_TIME', 'DATETIME'].includes(type)) {
    return {
      ...common,
      kind: strictAssertionEngine.ASSERTION_KIND.EXACT_VALUE,
      expected: firstDefined(
        payload.expectedValue,
        payload.expectedDate,
        payload.expectedTime,
        payload.expectedDateTime,
        payload.expected,
        payload.value,
      ),
    };
  }
  if (type === 'SELECTED' && firstDefined(payload.expectedValue, payload.value, payload.expected) != null) {
    return {
      ...common,
      kind: strictAssertionEngine.ASSERTION_KIND.EXACT_SELECTED_VALUE,
      expected: firstDefined(payload.expectedValue, payload.value, payload.expected),
    };
  }
  if (type === 'VISIBLE' || type === 'HIDDEN') {
    return {
      ...common,
      kind: type.toLowerCase(),
      expected: type === 'VISIBLE',
    };
  }
  if (type === 'COUNT') {
    return {
      ...common,
      kind: strictAssertionEngine.ASSERTION_KIND.COUNT,
      expected: firstDefined(payload.expectedCount, payload.expectedValue, payload.expected, payload.count),
      comparator: payload.comparator || 'equals',
    };
  }
  if (type === 'COLLECTION' && /ordered|exact/i.test(String(payload.comparator || ''))) {
    return {
      ...common,
      kind: strictAssertionEngine.ASSERTION_KIND.ORDERED_LIST,
      expected: firstDefined(payload.expectedItems, payload.items, payload.expected),
    };
  }
  if (['RELATIONSHIP', 'ASSERTRELATIONSHIP', 'TEMPORAL_RELATIONSHIP', 'TEMPORALRELATIONSHIP', 'TEMPORALCOMPARISON', 'ASSERTTEMPORAL'].includes(type)) {
    const operands = Array.isArray(payload.operands) ? payload.operands : [];
    return {
      ...common,
      kind: strictAssertionEngine.ASSERTION_KIND.RELATIONSHIP,
      operator: payload.comparator || payload.relation || payload.operator,
      leftTarget: operands[0]?.name || operands[0]?.label || null,
      rightTarget: operands[1]?.name || operands[1]?.label || null,
      expected: {
        operator: payload.comparator || payload.relation || payload.operator,
        leftTarget: operands[0]?.name || operands[0]?.label || null,
        rightTarget: operands[1]?.name || operands[1]?.label || null,
      },
    };
  }
  if (type === 'TOOLTIP' || type === 'TOOLTIP_VISIBLE') {
    return {
      ...common,
      kind: strictAssertionEngine.ASSERTION_KIND.TOOLTIP,
      expected: firstDefined(payload.expectedText, payload.expectedValue, payload.expected, payload.text),
    };
  }
  return null;
}

function assertionEvidenceOf(observed) {
  if (!observed || typeof observed !== 'object') return { channels: [] };
  const candidates = [
    observed.evidenceChannels,
    observed.channels,
    observed.evidence?.channels,
    observed.actual?.evidenceChannels,
    observed.actual?.channels,
  ];
  const channels = candidates.find(Array.isArray) || [];
  return { channels };
}

function classifyActionFamily(step = {}, { eventAdapter = null } = {}) {
  const action = actionToken(step);
  // Explicit typed events must wrap their trigger (often a Click) so popup,
  // download, chooser, dialog, and navigation listeners are armed first.
  // The injected adapter owns this decision and must return true only for a
  // declared event contract; ordinary clicks continue through Click authority.
  if (eventAdapter && typeof eventAdapter.canHandle === 'function') {
    try {
      if (eventAdapter.canHandle(step) === true) return FAMILIES.EVENT;
    } catch (_) {}
  }
  if (CLICK_ACTIONS.has(action)) return FAMILIES.CLICK;
  if (WAIT_ACTIONS.has(action)) return FAMILIES.WAIT;
  if (controlActionAdapter.actionKind(step)) return FAMILIES.CONTROL;
  if (
    ASSERTION_ACTIONS.has(action)
    || action.startsWith('assert')
    || action.startsWith('verify')
    || (step.assertion && typeof step.assertion === 'object')
    || (step.typedAssertion && typeof step.typedAssertion === 'object')
    || (step.verify && typeof step.verify === 'object'
      && ASSERTION_TYPES.has(token(step.verify.type || step.verify.kind)))
    || ASSERTION_TYPES.has(token(step.assertionType || step.type || step.kind))
  ) return FAMILIES.ASSERTION;
  if (EVENT_ACTIONS.has(action)) return FAMILIES.EVENT;
  return FAMILIES.UNSUPPORTED;
}

function controlOpenerIntent(step = {}) {
  if (!CLICK_ACTIONS.has(actionToken(step))) return null;
  const target = cleanAssertionText(controlActionAdapter.targetOf(step));
  if (!target) return null;
  const explicitRole = token(step.targetRole || step.role || step.controlRole);
  const explicitKind = token(step.controlKind || step.widgetKind || step.openerKind || step.semanticControlKind);
  const normalized = target.toLowerCase();
  let controlKind = null;
  if (['radio', 'menuitemradio'].includes(explicitRole) || explicitKind === 'radio') controlKind = 'radio';
  else if (['date', 'datepicker', 'calendar'].includes(explicitKind) || /\b(?:calendar|date\s+picker)\b/i.test(normalized)) controlKind = 'date';
  else if (['time', 'timepicker'].includes(explicitKind) || /\btime(?:\s+zone)?\s+(?:drop\s*down|picker)\b/i.test(normalized)) controlKind = 'time';
  else if (['combobox', 'listbox'].includes(explicitRole)
    || ['combobox', 'listbox', 'dropdown', 'select'].includes(explicitKind)
    || /\b(?:drop\s*down|combobox|combo\s+box|choice\s+control)\b/i.test(normalized)) controlKind = 'choice';
  else if (['button', 'treeitem'].includes(explicitRole)
    && ['disclosure', 'accordion', 'expand'].includes(explicitKind)) controlKind = 'disclosure';
  else if (['disclosure', 'accordion', 'expand'].includes(explicitKind)
    || /\b(?:disclosure|accordion)\s+(?:button|toggle)\b/i.test(normalized)) controlKind = 'disclosure';
  if (!controlKind) return null;

  const ownerTarget = target
    .replace(/\s+(?:drop\s*down|combobox|combo\s+box|calendar(?:\s+(?:button|icon|opener))?|date\s+picker|time\s+picker|choice\s+control|disclosure(?:\s+(?:button|toggle))?|accordion(?:\s+(?:button|toggle))?|radio\s+button)\s*$/i, '')
    .trim() || target;
  return { controlKind, target, ownerTarget };
}

function buildControlOpenerPlan(step = {}, suppliedIntent = null) {
  const intent = suppliedIntent || controlOpenerIntent(step);
  if (!intent) return null;
  if (intent.controlKind === 'radio') {
    return controlActionAdapter.buildControlActionPlan({
      ...step,
      action: 'Radio',
      target: intent.ownerTarget,
      element: intent.ownerTarget,
    });
  }
  const plan = controlActionAdapter.buildControlActionPlan({
    ...step,
    action: 'Expand',
    target: intent.ownerTarget,
    element: intent.ownerTarget,
  });
  const roleHints = {
    choice: ['combobox', 'listbox', 'button', 'textbox', 'searchbox', 'spinbutton'],
    date: ['textbox', 'combobox', 'button', 'spinbutton'],
    time: ['combobox', 'button', 'textbox', 'spinbutton'],
    disclosure: ['button', 'combobox', 'treeitem'],
  }[intent.controlKind] || ['button', 'combobox'];
  const phaseId = intent.controlKind === 'date' ? 'open-calendar'
    : intent.controlKind === 'time' ? 'open-time-control'
      : intent.controlKind === 'choice' ? 'open-choice-control' : 'open-disclosure';
  const openerPhases = plan.phases.map((phase) => ({
    ...phase,
    id: phaseId,
    args: { ...(phase.args || {}), element: intent.ownerTarget },
    resolution: {
      ...(phase.resolution || {}),
      label: intent.ownerTarget,
      roleHints,
      scope: { purpose: `${intent.controlKind}_opener`, ownerTarget: intent.ownerTarget },
    },
    semanticTarget: {
      kind: 'control_opener',
      controlKind: intent.controlKind,
      ownerTarget: intent.ownerTarget,
    },
  }));
  if (intent.controlKind === 'choice' || intent.controlKind === 'time') {
    openerPhases.push({
      ...openerPhases[0],
      id: `${phaseId}-trigger-assist`,
      toolName: 'browser_click',
      resolutionToolName: 'browser_click',
      args: { element: intent.ownerTarget, target: null },
      resolution: {
        ...openerPhases[0].resolution,
        roleHints: ['button'],
        scope: {
          ...(openerPhases[0].resolution?.scope || {}),
          purpose: `${intent.controlKind}_opener_trigger_assist`,
        },
      },
      semanticTarget: {
        ...(openerPhases[0].semanticTarget || {}),
        preferTrigger: true,
        optionalAssist: true,
      },
    });
    openerPhases.push({
      ...openerPhases[0],
      id: `${phaseId}-keyboard-assist`,
      toolName: 'browser_press_key',
      resolutionToolName: 'browser_click',
      args: { element: intent.ownerTarget, target: null, key: 'ArrowDown' },
      resolution: {
        ...openerPhases[0].resolution,
        scope: {
          ...(openerPhases[0].resolution?.scope || {}),
          purpose: `${intent.controlKind}_opener_keyboard_assist`,
        },
      },
    });
  }
  return {
    ...plan,
    variant: `${intent.controlKind}_opener`,
    phases: openerPhases,
    retryPolicy: { ...(plan.retryPolicy || {}), maxRetries: 0 },
    metadata: {
      ...(plan.metadata || {}),
      semanticControlOpener: true,
      openerKind: intent.controlKind,
      authoredTarget: intent.target,
    },
  };
}

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`universal action kernel requires ${name}()`);
}

function isFreshObservation(observation) {
  return !!observation && typeof observation === 'object' && observation.fresh === true;
}

function dispatchSucceeded(dispatched) {
  return dispatched?.ok === true
    || dispatched?.isError === false
    || dispatched?.result?.isError === false;
}

function resolutionCode(resolution) {
  return token(
    resolution?.code
    || resolution?.reason
    || resolution?.gap?.code
    || resolution?.gap?.reason
    || 'target_resolution_uncertain',
  );
}

function resolutionCandidateCount(resolution) {
  const values = [
    resolution?.candidateCount,
    resolution?.candidates?.length,
    resolution?.semanticResolution?.candidates?.length,
  ];
  const value = values.find((candidate) => Number.isFinite(Number(candidate)));
  return value == null ? null : Number(value);
}

function isAmbiguousResolution(resolution) {
  const code = resolutionCode(resolution);
  const candidateCount = resolutionCandidateCount(resolution);
  return resolution?.ambiguous === true
    || resolution?.unique === false
    || (candidateCount != null && candidateCount > 1)
    || (Number.isFinite(Number(resolution?.confidenceMargin)) && Number(resolution.confidenceMargin) <= 0)
    || code.includes('ambiguous')
    || code.includes('equaltarget');
}

function isBranchInapplicable(resolution) {
  if (resolution?.inapplicable === true) return true;
  const code = resolutionCode(resolution);
  return [
    'branchnotapplicable',
    'nocompatibletarget',
    'notarget',
    'targetkindmismatch',
    'targetnotfound',
  ].includes(code);
}

function isUnprovenNativeDateBranch({ plan, phase, resolution, ambiguous }) {
  return plan?.kind === 'date'
    && phase?.branch === 'target_is_native_date_input'
    && ambiguous !== true
    && resolution?.ok !== true
    && resolutionCandidateCount(resolution) === 0;
}

function actionLocatorRef(resolution, { actionKind = null, phase = null } = {}) {
  const normalizedAction = token(actionKind || phase?.kind || phase?.action || phase?.toolName);
  const valueAction = ['fill', 'type', 'input', 'clear', 'setvalue', 'browserfillform', 'browsertype'].includes(normalizedAction);
  const valueCandidates = [
    resolution?.resolvedControl?.valueNode?.ref,
    resolution?.resolvedControl?.valueElement?.ref,
    resolution?.resolvedControl?.ownerNode?.ref,
    resolution?.resolvedControl?.ownerElement?.ref,
    resolution?.resolvedCandidate?.resolvedControl?.valueNode?.ref,
    resolution?.resolvedCandidate?.resolvedControl?.valueElement?.ref,
    resolution?.resolvedCandidate?.resolvedControl?.ownerNode?.ref,
    resolution?.resolvedCandidate?.resolvedControl?.ownerElement?.ref,
    resolution?.semanticResolution?.candidate?.resolvedControl?.valueNode?.ref,
    resolution?.semanticResolution?.candidate?.resolvedControl?.ownerNode?.ref,
  ];
  const interactionCandidates = [
    resolution?.resolvedControl?.interactionNode?.ref,
    resolution?.resolvedControl?.interactionElement?.ref,
    resolution?.resolvedCandidate?.resolvedControl?.interactionNode?.ref,
    resolution?.resolvedCandidate?.resolvedControl?.interactionElement?.ref,
    resolution?.semanticResolution?.candidate?.resolvedControl?.interactionNode?.ref,
    resolution?.semanticResolution?.candidate?.resolvedControl?.interactionElement?.ref,
    resolution?.ref,
    resolution?.target,
    resolution?.actionLocator?.ref,
    resolution?.actionLocator?.target,
    resolution?.resolvedCandidate?.ref,
    resolution?.resolvedCandidate?.target,
    resolution?.resolvedCandidate?.actionLocator?.ref,
    resolution?.semanticResolution?.candidate?.ref,
    resolution?.semanticResolution?.candidate?.actionLocator?.ref,
  ];
  const candidates = valueAction
    ? [...valueCandidates, ...interactionCandidates]
    : [...interactionCandidates, ...valueCandidates];
  const selected = candidates.find((candidate) => typeof candidate === 'string' && candidate.trim());
  return selected ? selected.trim() : null;
}

function resolvedControlOf(resolution) {
  return resolution?.resolvedControl
    || resolution?.resolvedCandidate?.resolvedControl
    || resolution?.semanticResolution?.candidate?.resolvedControl
    || resolution?.candidate?.resolvedControl
    || null;
}

function authoredSemanticTarget({ step = {}, plan = {}, phase = {} } = {}) {
  const semanticTarget = phase.semanticTarget && typeof phase.semanticTarget === 'object'
    ? phase.semanticTarget
    : {};
  return String(
    semanticTarget.kind === 'option' && semanticTarget.name
      ? semanticTarget.name
      : phase.resolution?.label || semanticTarget.ownerTarget || plan.target
        || controlActionAdapter.targetOf(step) || step.target || step.element || '',
  ).replace(/\s+/g, ' ').trim();
}

function validateResolutionSemanticConsistency({ resolution, step, plan, phase } = {}) {
  if (!resolution || resolution.ok !== true || resolution.resolutionNotRequired === true) return null;
  const control = resolvedControlOf(resolution);
  const declared = resolution?.resolvedCandidate?.semanticConsistency
    || resolution?.semanticResolution?.candidate?.semanticConsistency
    || resolution?.semanticConsistency
    || null;
  if (!control) {
    return declared?.ok === false
      ? { ...declared, source: 'resolver_declared_semantic_mismatch' }
      : null;
  }
  const authoredTarget = authoredSemanticTarget({ step, plan, phase });
  const checkedControl = {
    ...control,
    requestedAction: actionToken(step) || control.requestedAction,
    requestedTarget: authoredTarget || control.requestedTarget,
  };
  return {
    ...universalControlModel.compareSemanticIdentity(checkedControl),
    source: 'universal_kernel_pre_dispatch',
    authoredTarget: authoredTarget || null,
  };
}

function compactProof(proof) {
  if (!proof || typeof proof !== 'object') return null;
  return {
    kind: String(proof.kind || 'postcondition').slice(0, 120),
    matched: proof.matched === true ? true : proof.matched === false ? false : null,
    checked: proof.checked === true,
    status: String(proof.status || '').slice(0, 80) || null,
    reason: String(proof.reason || 'postcondition_result').slice(0, 240),
  };
}

function proofIsUncheckable(proof) {
  if (!proof || proof.checked !== true || proof.matched == null) return true;
  if (proof.uncheckable === true || token(proof.status) === 'uncheckable') return true;
  const reason = token(proof.reason);
  return [
    'actualunavailable',
    'freshobservationrequired',
    'invalidplan',
    'notreadable',
    'observationunavailable',
    'targetnotfound',
    'uncheckable',
    'unsupportedaction',
  ].some((marker) => reason.includes(marker));
}

function controlDiagnostics(kind) {
  return {
    schema: 'qaai_universal_control_attempt_v1',
    family: FAMILIES.CONTROL,
    actionKind: kind,
    observations: [],
    resolutions: [],
    dispatches: [],
    proofs: [],
    retries: [],
    browserEvidence: [],
  };
}

async function captureBrowserEvidence(adapter, method, diagnostics, request) {
  if (!adapter || typeof adapter[method] !== 'function') return null;
  try {
    const evidence = await adapter[method](request);
    if (evidence) diagnostics?.browserEvidence?.push(evidence);
    return evidence || null;
  } catch (error) {
    diagnostics?.browserEvidence?.push({
      phase: method,
      status: 'capture_error',
      error: { name: error?.name || 'Error', message: 'Browser evidence capture failed' },
    });
    return null;
  }
}

async function freshObservation(observe, diagnostics, request, {
  maxAttempts = 1,
  sleep = null,
  retryDelayMs = 150,
} = {}) {
  const boundedAttempts = Math.max(1, Math.min(4, Number(maxAttempts) || 1));
  for (let observationAttempt = 1; observationAttempt <= boundedAttempts; observationAttempt += 1) {
    let observation = null;
    try {
      observation = await observe({
        ...request,
        requireFresh: true,
        observationAttempt,
      });
    } catch (_) {}
    const fresh = isFreshObservation(observation);
    diagnostics.observations.push({
      phase: request.phase,
      phaseId: request.controlPhase?.id || null,
      attempt: request.attempt,
      observationAttempt,
      fresh,
      available: !!observation,
    });
    if (fresh) return observation;
    if (observationAttempt < boundedAttempts) {
      await waitForRetry(retryDelayMs, sleep);
    }
  }
  return null;
}

function latestSuccessfulRuntimeTool(diagnostics) {
  const dispatches = Array.isArray(diagnostics?.dispatches) ? diagnostics.dispatches : [];
  for (let index = dispatches.length - 1; index >= 0; index -= 1) {
    const dispatch = dispatches[index];
    if (dispatch?.ok === true && typeof dispatch.toolName === 'string' && dispatch.toolName.trim()) {
      return dispatch.toolName.trim();
    }
  }
  return null;
}

function sealedRowOf(sealedContext) {
  return sealedContext?.sealed || sealedContext || null;
}

function sealedRowRejectsPass(row) {
  if (!row || typeof row !== 'object') return false;
  const status = token(row.status);
  const actionOutcome = token(row.actionOutcome);
  const continuationOutcome = token(row.continuationOutcome);
  return ['blocked', 'fail', 'failed', 'error'].includes(status)
    || actionOutcome === 'failed'
    || row.executionError === true
    || ['stopcase', 'stopdescendants'].includes(continuationOutcome);
}

async function projectOutcome({
  step,
  family,
  status,
  outcomeKind,
  reason,
  record = null,
  diagnostics = null,
  seal = null,
  actionOutcome = null,
  assertionOutcome = 'not_applicable',
  dispatched = false,
  internalOperationCompletion = false,
  internalOperationKind = null,
} = {}) {
  const normalizedActionOutcome = actionOutcome || (status === 'pass'
    ? 'succeeded'
    : dispatched ? 'failed' : 'not_executed');
  const runtimeToolName = internalOperationCompletion === true
    ? (internalOperationKind === 'wait_for_state'
      ? 'internal_wait_for_state'
      : internalOperationKind === 'optional_absent'
        ? 'internal_optional_absent'
        : internalOperationKind === 'scroll_utility'
          ? 'internal_scroll_utility'
          : 'generic_transition_already_satisfied')
    : latestSuccessfulRuntimeTool(diagnostics);
  const payload = {
    family,
    status,
    outcomeKind,
    reason,
    record,
    diagnostics,
    actionOutcome: normalizedActionOutcome,
    assertionOutcome,
    internalOperationCompletion,
    internalOperationKind,
    runtimeToolName,
  };

  let sealedContext = null;
  if (typeof seal === 'function') {
    try {
      sealedContext = await seal(payload);
    } catch (_) {
      return {
        handled: true,
        family,
        status: 'blocked',
        outcomeKind: OUTCOME_KINDS.EXECUTION_UNCERTAINTY,
        reason: 'execution_journal_seal_failed',
        errorKind: 'qaai_execution_uncertainty',
        actionOutcome: normalizedActionOutcome,
        assertionOutcome: assertionOutcome === 'matched' ? 'uncheckable' : assertionOutcome,
        terminal: true,
        continuation: { terminal: true, outcome: 'stop_case', reason: 'journal_authority_unavailable' },
        diagnostics,
      };
    }
  }

  const sealedRow = sealedRowOf(sealedContext);
  if (status === 'pass' && sealedRowRejectsPass(sealedRow)) {
    const sealedReason = sealedRow.continuationReason
      || sealedRow.reason
      || sealedRow.error
      || 'execution_journal_rejected_success';
    const continuation = {
      ...genericClickExecution.decideDependencyScopedContinuation({
        step,
        sealed: sealedRow,
        hasRunnableStep: sealedContext?.hasRunnableStep === true,
      }),
      reason: sealedReason,
    };
    return {
      handled: true,
      family,
      status: 'blocked',
      outcomeKind: OUTCOME_KINDS.EXECUTION_UNCERTAINTY,
      reason: sealedReason,
      errorKind: 'qaai_execution_uncertainty',
      record,
      diagnostics,
      runtimeToolName,
      actionOutcome: sealedRow.actionOutcome || 'failed',
      assertionOutcome: sealedRow.assertionOutcome || (assertionOutcome === 'matched' ? 'uncheckable' : assertionOutcome),
      terminal: continuation.terminal,
      continuation,
    };
  }

  if (status === 'pass') {
    return {
      handled: true,
      family,
      status,
      outcomeKind,
      reason,
      record,
      diagnostics,
      runtimeToolName,
      actionOutcome: normalizedActionOutcome,
      assertionOutcome,
      terminal: false,
      continuation: { terminal: false, outcome: 'continue', reason: 'operation_completed' },
    };
  }

  const continuation = genericClickExecution.decideDependencyScopedContinuation({
    step,
    sealed: sealedContext?.sealed || sealedContext || null,
    hasRunnableStep: sealedContext?.hasRunnableStep === true,
  });
  return {
    handled: true,
    family,
    status,
    outcomeKind,
    reason,
    errorKind: outcomeKind === OUTCOME_KINDS.EXECUTION_UNCERTAINTY
      ? 'qaai_execution_uncertainty'
      : null,
    record,
    diagnostics,
    runtimeToolName,
    actionOutcome: normalizedActionOutcome,
    assertionOutcome,
    terminal: continuation.terminal,
    continuation,
  };
}

async function waitForRetry(milliseconds, sleeper) {
  const bounded = Math.max(0, Math.min(5_000, Number(milliseconds) || 0));
  if (!bounded) return;
  if (typeof sleeper === 'function') {
    await sleeper(bounded);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, bounded));
}

async function executeControlAction({
  step = {},
  plan: suppliedPlan = null,
  session = null,
  observe,
  resolve = null,
  dispatch,
  prove = null,
  seal = null,
  sleep = null,
  persistTransaction = null,
  persistedTransaction = null,
  transactionContext = {},
  evidenceAdapter = null,
  resolveValueRef = null,
  maxPostconditionObservations = 5,
  maxFreshPostconditionAttempts = 3,
} = {}) {
  requireFunction(observe, 'observe');
  requireFunction(dispatch, 'dispatch');
  const plan = suppliedPlan || controlActionAdapter.buildControlActionPlan(step);
  const diagnostics = controlDiagnostics(plan.kind);
  const valueRef = plan.metadata?.referenceBacked === true ? plan.metadata.valueRef : null;
  let resolvedValue = null;
  if (valueRef) {
    if (typeof resolveValueRef === 'function') {
      try {
        resolvedValue = await resolveValueRef({ valueRef, step, target: controlActionAdapter.targetOf(step) });
      } catch (_) {
        resolvedValue = null;
      }
    }
    if (resolvedValue == null) {
      return projectOutcome({
        step,
        family: FAMILIES.CONTROL,
        status: 'blocked',
        outcomeKind: OUTCOME_KINDS.EXECUTION_UNCERTAINTY,
        reason: 'control_value_ref_unresolved',
        diagnostics,
        seal,
        dispatched: false,
      });
    }
  }
  const resolveTarget = typeof resolve === 'function'
    ? resolve
    : (input) => controlActionAdapter.resolvePhaseTarget({ session, ...input });
  const provePostcondition = typeof prove === 'function'
    ? prove
    : ({ observation }) => controlActionAdapter.proveControlAction(plan, observation, { resolvedValue });
  let resolutionRecoveryCount = 0;
  let dispatchedAny = false;
  let activeBranch = null;
  const skippedBranches = new Set();
  const completedPhaseIds = new Set();
  let completedPhaseCount = 0;
  let satisfiedBySemanticResolution = false;
  let phaseFailure = null;
  let lastProof = null;
  const actionOccurrenceId = transactionContext.actionOccurrenceId
    || transactionContext.occurrenceId
    || `${step.id || step.stepId || 'step'}:${transactionContext.sequenceIndex ?? step.sequenceIndex ?? step.stepIndex ?? 0}`;
  const evidenceRequest = (extra = {}) => ({
    actionOccurrenceId,
    stepId: transactionContext.stepId || step.id || step.stepId || null,
    actionType: plan.kind || actionToken(step),
    controlType: plan.controlType || plan.adapter?.controlType || null,
    targetDescription: controlActionAdapter.targetOf(step),
    expectedValue: firstDefined(plan.value, plan.expectedValue, step.value, step.expectedValue),
    valueRef: step.valueRef || step.dataRef || null,
    sensitive: step.sensitive === true || /password|passcode|secret|token/i.test(controlActionAdapter.targetOf(step)),
    ...extra,
  });

  const firstObservation = await freshObservation(observe, diagnostics, {
    phase: 'pre_dispatch',
    attempt: 1,
    retry: false,
    step,
    plan,
    controlPhase: plan.phases[0] || null,
  }, {
    maxAttempts: 3,
    sleep,
    retryDelayMs: Math.min(500, Math.max(100, Number(plan.waitContract?.pollIntervalMs) || 150)),
  });
  if (!firstObservation) {
    return projectOutcome({
      step,
      family: FAMILIES.CONTROL,
      status: 'blocked',
      outcomeKind: OUTCOME_KINDS.EXECUTION_UNCERTAINTY,
      reason: 'fresh_control_observation_unavailable',
      diagnostics,
      seal,
      dispatched: false,
    });
  }

  const satisfied = controlActionAdapter.alreadySatisfied(plan, firstObservation, { resolvedValue });
  if (satisfied.satisfied === true) {
    const record = compactProof(satisfied.proof);
    diagnostics.proofs.push({ attempt: 0, phase: 'pre_dispatch', ...record });
    return projectOutcome({
      step,
      family: FAMILIES.CONTROL,
      status: 'pass',
      outcomeKind: OUTCOME_KINDS.SUCCESS,
      reason: 'control_postcondition_already_satisfied',
      record,
      diagnostics,
      seal,
      actionOutcome: 'succeeded',
      assertionOutcome: 'matched',
      internalOperationCompletion: true,
    });
  }

  const resolvePhase = async (phase, observation, attempt) => {
    let resolution = { ok: true, resolutionNotRequired: true, phase };
    if (!phase.resolution) return { resolution, observation };
    try {
      resolution = await resolveTarget({
        session,
        step,
        plan,
        phase,
        phaseId: phase.id,
        snapshotText: observation.snapshotText,
        pageUrl: observation.url || null,
        observation,
        attempt,
        retry: attempt > 1,
        semanticCandidates: observation.semanticCandidates || null,
        calendarState: observation.calendarState || null,
        completedPhaseIds: Array.from(completedPhaseIds),
        completedPhaseCount,
        dispatchedAny,
      });
    } catch (error) {
      resolution = {
        ok: false,
        code: 'target_resolution_threw',
        detail: String(error?.message || error || 'unknown target resolution error').slice(0, 500),
      };
    }
    const semanticMatch = validateResolutionSemanticConsistency({ resolution, step, plan, phase });
    if (semanticMatch?.ok === false) {
      resolution = {
        ...resolution,
        ok: false,
        code: semanticMatch.code || 'semantic_control_identity_mismatch',
        detail: 'Resolved browser control contradicts the current authored semantic target.',
        semanticMatch,
      };
    } else if (semanticMatch?.ok === true) {
      resolution = { ...resolution, semanticMatch };
    }
    const ambiguous = isAmbiguousResolution(resolution);
    diagnostics.resolutions.push({
      phaseId: phase.id,
      attempt,
      ok: resolution?.ok === true,
      ambiguous,
      candidateCount: resolutionCandidateCount(resolution),
      code: resolutionCode(resolution),
      semanticMatch: resolution?.semanticMatch || null,
      ...(resolution?.detail ? { detail: resolution.detail } : {}),
      ...(Array.isArray(resolution?.candidates) && resolution.candidates.length
        ? {
            candidates: resolution.candidates.slice(0, 5).map((candidate) => ({
              ref: candidate?.ref || null,
              role: candidate?.role || null,
              name: candidate?.name || candidate?.accessibleName || null,
              id: candidate?.id || null,
              testid: candidate?.testid || null,
              placeholder: candidate?.placeholder || null,
              score: Number.isFinite(Number(candidate?.score)) ? Number(candidate.score) : null,
              expanded: candidate?.expanded === true,
              ariaExpanded: candidate?.ariaExpanded ?? null,
              ariaControls: candidate?.ariaControls || null,
              hitTarget: candidate?.hitTarget === true,
              inViewport: candidate?.inViewport === true,
              focused: candidate?.focused === true,
              ownerPromoted: candidate?.ownerPromoted === true,
              actionOwnerIsSelf: candidate?.actionOwnerIsSelf === true,
              actionOwnerRole: candidate?.actionOwnerRole || null,
              actionOwnerRoleOrdinal: Number.isInteger(Number(candidate?.actionOwnerRoleOrdinal))
                ? Number(candidate.actionOwnerRoleOrdinal)
                : null,
              actionOwnerId: candidate?.actionOwnerId || null,
              actionOwnerName: candidate?.actionOwnerAccessibleName || null,
              controlType: candidate?.resolvedControl?.controlType || null,
              ownerRef: candidate?.resolvedControl?.ownerNode?.ref
                || candidate?.resolvedControl?.ownerElement?.ref || null,
              interactionRef: candidate?.resolvedControl?.interactionNode?.ref
                || candidate?.resolvedControl?.interactionElement?.ref || null,
            })),
          }
        : {}),
    });
    return { resolution, observation, ambiguous };
  };

  const dispatchPlanOnce = async ({ attempt }) => {
    let observation = firstObservation;
    let observedPhaseCount = 0;
    for (const [phaseIndex, phase] of plan.phases.entries()) {
      if (phase.branch && (skippedBranches.has(phase.branch) || (activeBranch && phase.branch !== activeBranch))) continue;
      if (observedPhaseCount > 0) {
        observation = await freshObservation(observe, diagnostics, {
          phase: 'pre_dispatch',
          attempt,
          retry: false,
          step,
          plan,
          controlPhase: phase,
        }, {
          maxAttempts: 3,
          sleep,
          retryDelayMs: Math.min(500, Math.max(100, Number(plan.waitContract?.pollIntervalMs) || 150)),
        });
        if (!observation) {
          phaseFailure = { reason: 'fresh_control_observation_unavailable' };
          throw new Error(phaseFailure.reason);
        }
      }
      observedPhaseCount += 1;

      let resolved = await resolvePhase(phase, observation, 1);
      let { resolution, ambiguous } = resolved;
      if (phase.resolution && resolution?.ok !== true && !ambiguous && !dispatchedAny && resolutionRecoveryCount < 1) {
        resolutionRecoveryCount += 1;
        diagnostics.retries.push({
          attempt: 1,
          retry: true,
          reason: 'bounded_resolution_resnapshot',
          nextResolutionRecoveryCount: resolutionRecoveryCount,
          freshObservationRequired: true,
          reResolveRequired: true,
          backoffMs: 100,
        });
        await waitForRetry(100, sleep);
        const refreshed = await freshObservation(observe, diagnostics, {
          phase: 'pre_dispatch',
          attempt: 2,
          retry: true,
          step,
          plan,
          controlPhase: phase,
        }, { maxAttempts: 3, sleep, retryDelayMs: 150 });
        if (refreshed) {
          observation = refreshed;
          resolved = await resolvePhase(phase, observation, 2);
          resolution = resolved.resolution;
          ambiguous = resolved.ambiguous;
        }
      }
      if (phase.resolution && (resolution?.ok !== true || ambiguous)) {
        const branchInapplicable = isBranchInapplicable(resolution)
          || isUnprovenNativeDateBranch({ plan, phase, resolution, ambiguous });
        if (phase.branch && !activeBranch && !ambiguous && branchInapplicable) {
          skippedBranches.add(phase.branch);
          continue;
        }
        phaseFailure = { reason: ambiguous ? 'control_target_ambiguous' : 'control_target_resolution_uncertain' };
        return { delivered: false, positivelyNotDelivered: true, phaseFailure };
      }
      if (phase.branch && !activeBranch) activeBranch = phase.branch;
      if (resolution?.phaseAlreadySatisfied === true) {
        diagnostics.resolutions[diagnostics.resolutions.length - 1].phaseAlreadySatisfied = true;
        satisfiedBySemanticResolution = true;
        completedPhaseCount += 1;
        completedPhaseIds.add(phase.id);
        continue;
      }

      const ref = actionLocatorRef(resolution, { actionKind: plan?.kind, phase });
      const semanticDispatch = !!resolution?.semanticResolution || Array.isArray(resolution?.operations);
      if (phase.resolution && !ref && !resolution?.resolutionNotRequired && !semanticDispatch) {
        phaseFailure = { reason: 'unique_control_target_ref_unavailable' };
        return { delivered: false, positivelyNotDelivered: true, phaseFailure };
      }
      const boundPhase = ref ? controlActionAdapter.bindResolvedTarget(phase, ref) : phase;
      const dispatchPhase = valueRef
        ? controlActionAdapter.materializeReferencePhase(boundPhase, resolvedValue)
        : boundPhase;
      const actionAttemptId = `${actionOccurrenceId}:${phase.id || 'phase'}:${attempt}`;
      await captureBrowserEvidence(evidenceAdapter, 'beforeAction', diagnostics, evidenceRequest({
        actionAttemptId,
        phaseId: phase.id || null,
        observation,
        resolution,
      }));
      let dispatched = null;
      try {
        dispatched = await dispatch({
          step,
          plan,
          phase: dispatchPhase,
          rawPhase: phase,
          resolution,
          observation,
          attempt,
          retry: false,
        });
      } catch (error) {
        dispatched = { ok: false, error };
      }
      const ok = dispatchSucceeded(dispatched);
      await captureBrowserEvidence(evidenceAdapter, 'captureAction', diagnostics, evidenceRequest({
        actionAttemptId,
        phaseId: phase.id || null,
        observation,
        resolution,
        dispatched,
      }));
      dispatchedAny = true;
      diagnostics.dispatches.push({
        phaseId: phase.id,
        attempt,
        retry: false,
        ok,
        toolName: dispatched?.toolName || dispatchPhase?.toolName || phase.toolName || null,
        reason: ok ? 'dispatch_succeeded' : 'dispatch_delivery_uncertain',
        ...(Array.isArray(dispatched?.qaaiSemanticOperations)
          ? { semanticOperations: dispatched.qaaiSemanticOperations }
          : {}),
      });
      if (!ok) {
        phaseFailure = { reason: 'control_dispatch_uncertain' };
        throw new Error(phaseFailure.reason);
      }
      completedPhaseCount += 1;
      completedPhaseIds.add(phase.id);

      // Opener plans contain ordered fallbacks (owner, trigger, keyboard).
      // Observe between them so a successful gesture is never followed by a
      // second state-changing gesture that can close or disturb the popup.
      if (plan?.metadata?.semanticControlOpener === true && phaseIndex < plan.phases.length - 1) {
        const pollIntervalMs = Math.min(350, Math.max(100, Number(plan.waitContract?.pollIntervalMs) || 150));
        let openerMatched = false;
        for (let poll = 0; poll < 4 && !openerMatched; poll += 1) {
          if (poll > 0) await waitForRetry(pollIntervalMs, sleep);
          const openerObservation = await freshObservation(observe, diagnostics, {
            phase: 'control_opener_probe',
            attempt: poll + 1,
            retry: false,
            step,
            plan,
            controlPhase: phase,
          }, { maxAttempts: 1, sleep, retryDelayMs: pollIntervalMs });
          if (!openerObservation) continue;
          let openerProof = null;
          try {
            openerProof = await provePostcondition({
              step,
              plan,
              observation: {
                ...openerObservation,
                snapshotBeforeOpen: firstObservation.snapshotBeforeOpen || firstObservation.snapshotText || '',
                snapshotAfter: openerObservation.snapshotAfter || openerObservation.snapshotText || '',
              },
              attempt: 1,
              retry: false,
            });
          } catch (_) {}
          const proofRecord = compactProof(openerProof);
          diagnostics.proofs.push({
            attempt: 1,
            phase: 'control_opener_probe',
            controlPhaseId: phase.id,
            poll: poll + 1,
            ...(proofRecord || {
              matched: null,
              checked: false,
              reason: 'control_opener_probe_unavailable',
            }),
          });
          if (openerProof?.matched === true) {
            lastProof = proofRecord;
            openerMatched = true;
          }
        }
        if (openerMatched) break;
      }
    }
    if (completedPhaseCount === 0) {
      phaseFailure = { reason: 'no_compatible_control_dispatch_branch' };
      return { delivered: false, positivelyNotDelivered: true, phaseFailure };
    }
    return { delivered: true, completedPhaseIds: Array.from(completedPhaseIds) };
  };

  const utilityOnlyAction = plan.kind === 'scroll';
  const coordinated = await actionTransactionCoordinator.coordinateActionTransaction({
    ...transactionContext,
    persistedTransaction,
    toolName: plan.phases[0]?.toolName || null,
    args: plan.phases[0]?.args || {},
    stepId: transactionContext.stepId || step.id || step.stepId || null,
    sequenceIndex: transactionContext.sequenceIndex ?? step.sequenceIndex ?? step.stepIndex ?? null,
    action: { kind: plan.kind || actionToken(step), target: controlActionAdapter.targetOf(step), ...(valueRef ? { valueRef } : {}) },
    target: controlActionAdapter.targetOf(step),
    valueRef,
    failureMode: utilityOnlyAction
      ? actionTransactionCoordinator.FAILURE_MODE.VALIDATION_ONLY
      : actionTransactionCoordinator.FAILURE_MODE.DEPENDENT_BLOCK,
    maxDispatchAttempts: 1,
    maxObservationAttempts: Math.max(
      1,
      Math.min(5, Number(maxPostconditionObservations) || 5),
    ),
    observationIntervalMs: Math.min(500, Math.max(100, Number(plan.waitContract?.pollIntervalMs) || 150)),
    sleep,
    persist: persistTransaction,
    capturePreState: async () => firstObservation,
    dispatch: dispatchPlanOnce,
    observe: async () => {
      const postObservation = await freshObservation(observe, diagnostics, {
        phase: 'postcondition',
        attempt: 1,
        retry: false,
        step,
        plan,
        controlPhase: null,
      }, {
        maxAttempts: Math.max(
          1,
          Math.min(3, Number(maxFreshPostconditionAttempts) || 3),
        ),
        sleep,
        retryDelayMs: Math.min(500, Math.max(100, Number(plan.waitContract?.pollIntervalMs) || 150)),
      });
      await captureBrowserEvidence(evidenceAdapter, 'afterAction', diagnostics, evidenceRequest({
        actionAttemptId: `${actionOccurrenceId}:postcondition:1`,
        observation: postObservation,
        proof: lastProof,
      }));
      return postObservation;
    },
    provePostcondition: async ({ observation }) => {
      if (phaseFailure) {
        return { matched: null, checked: false, terminal: true, reason: phaseFailure.reason };
      }
      if (!dispatchedAny && satisfiedBySemanticResolution) {
        const proof = {
          kind: 'semantic_control_state',
          matched: true,
          checked: true,
          status: 'pass',
          reason: 'semantic_control_state_already_satisfied',
        };
        lastProof = compactProof(proof);
        diagnostics.proofs.push({ attempt: 1, phase: 'postcondition', ...lastProof });
        return {
          matched: true,
          checked: true,
          terminal: true,
          reason: proof.reason,
          evidence: lastProof,
        };
      }
      const postObservation = observation?.data || null;
      if (!postObservation) {
        if (['expand', 'collapse'].includes(plan.kind) && lastProof?.matched === true) {
          return {
            matched: true,
            checked: true,
            terminal: true,
            reason: lastProof.reason || 'semantic_control_state_proven_before_final_capture',
            evidence: lastProof,
          };
        }
        return { matched: null, checked: false, terminal: false, reason: 'fresh_postcondition_observation_unavailable' };
      }
      let proof = null;
      try {
        proof = await provePostcondition({ step, plan, observation: postObservation, attempt: 1, retry: false });
      } catch (_) {}
      lastProof = compactProof(proof);
      diagnostics.proofs.push({ attempt: 1, phase: 'postcondition', ...(lastProof || {
        matched: null,
        checked: false,
        reason: 'postcondition_proof_unavailable',
      }) });
      const exactCandidateCommitted = diagnostics.dispatches.some((entry) => (
        entry?.ok === true
        && ['choose-calendar-day', 'choose-exact-option', 'set-native-date', 'select-native-option']
          .includes(String(entry.phaseId || '').trim().toLowerCase())
      ));
      if (proof?.matched === false && exactCandidateCommitted) {
        const committed = {
          kind: 'exact_candidate_dispatch',
          matched: true,
          checked: true,
          status: 'pass',
          reason: 'exact_control_candidate_dispatched_readback_deferred_to_authored_assertion',
        };
        diagnostics.proofs.push({ attempt: 1, phase: 'dispatch_commit', ...committed });
        return {
          matched: true,
          checked: true,
          terminal: true,
          reason: committed.reason,
          evidence: committed,
        };
      }
      return {
        matched: proof?.matched === true ? true : proof?.matched === false ? false : null,
        checked: proof?.checked === true || proof?.matched === true || proof?.matched === false,
        terminal: proof?.matched === true,
        reason: proof?.reason || (proof?.matched === false ? 'control_postcondition_not_matched' : 'control_postcondition_uncheckable'),
        evidence: lastProof,
      };
    },
  });
  diagnostics.transaction = actionTransactionCoordinator.hydrateActionTransaction(coordinated.transaction);
  const outcome = coordinated.outcome || coordinated.transaction?.canonicalOutcome || null;
  const status = outcome?.status === 'passed' ? 'pass'
    : outcome?.outcomeKind === actionTransactionCoordinator.OUTCOME_KIND.FUNCTIONAL_FAILURE ? 'fail' : 'blocked';
  const reason = phaseFailure?.reason || (status === 'pass'
    ? 'control_postcondition_matched'
    : status === 'fail' ? 'control_postcondition_not_matched' : 'control_postcondition_uncheckable');
  if (utilityOnlyAction && status !== 'pass') {
    return projectOutcome({
      step,
      family: FAMILIES.CONTROL,
      status: 'pass',
      outcomeKind: OUTCOME_KINDS.SUCCESS,
      reason: 'scroll_utility_unconfirmed_continue',
      record: {
        kind: 'utility',
        status: 'warning',
        matched: null,
        checked: false,
        reason,
      },
      diagnostics,
      seal,
      assertionOutcome: 'not_applicable',
      dispatched: dispatchedAny,
      internalOperationCompletion: true,
      internalOperationKind: 'scroll_utility',
    });
  }
  return projectOutcome({
    step,
    family: FAMILIES.CONTROL,
    status,
    outcomeKind: status === 'pass' ? OUTCOME_KINDS.SUCCESS
      : status === 'fail' ? OUTCOME_KINDS.FUNCTIONAL_FAILURE : OUTCOME_KINDS.EXECUTION_UNCERTAINTY,
    reason,
    record: lastProof || outcome?.evidence || null,
    diagnostics,
    seal,
    assertionOutcome: status === 'pass' ? 'matched' : status === 'fail' ? 'not_matched' : 'uncheckable',
    dispatched: dispatchedAny,
  });
}

function strictUncheckableAssertionOutcome(options, step, reason, record = null) {
  const assertion = options.assertion || assertionContractOf(step);
  const failurePolicy = authoredAssertionFailurePolicy(assertion, step, options.failurePolicy);
  return projectOutcome({
    step,
    family: FAMILIES.ASSERTION,
    status: 'pass',
    outcomeKind: OUTCOME_KINDS.SUCCESS,
    reason,
    record: record || {
      status: 'warning',
      evaluated: false,
      matched: null,
      reason,
      failurePolicy: strictFailurePolicyMetadata(failurePolicy),
    },
    seal: options.seal,
    actionOutcome: 'succeeded',
    assertionOutcome: 'uncheckable',
  });
}

async function executeTypedAssertion(options = {}) {
  const step = options.step || {};
  const assertion = options.assertion || assertionContractOf(step);
  const reader = options.observeAssertion || options.readActual || null;
  let actual = options.actual;
  let available = Object.prototype.hasOwnProperty.call(options, 'actual');
  let observedRecord = available ? { fresh: true, actual } : null;
  if (!available && typeof reader === 'function') {
    let observed = null;
    try {
      observed = await reader({ step, assertion, phase: 'assertion', requireFresh: true });
    } catch (_) {}
    observedRecord = observed;
    if (!isFreshObservation(observed)) {
      if (options.strictAssertionEvidenceRequired === true) {
        return strictUncheckableAssertionOutcome(options, step, 'fresh_assertion_observation_unavailable');
      }
      return projectOutcome({
        step,
        family: FAMILIES.ASSERTION,
        status: 'blocked',
        outcomeKind: OUTCOME_KINDS.EXECUTION_UNCERTAINTY,
        reason: 'fresh_assertion_observation_unavailable',
        seal: options.seal,
        actionOutcome: 'failed',
        assertionOutcome: 'uncheckable',
      });
    }
    if (observed.uncheckable === true) {
      if (options.strictAssertionEvidenceRequired === true) {
        return strictUncheckableAssertionOutcome(
          options,
          step,
          observed.reason || 'typed_assertion_evidence_uncheckable',
        );
      }
      return projectOutcome({
        step,
        family: FAMILIES.ASSERTION,
        status: 'blocked',
        outcomeKind: OUTCOME_KINDS.EXECUTION_UNCERTAINTY,
        reason: observed.reason || 'typed_assertion_evidence_uncheckable',
        seal: options.seal,
        actionOutcome: 'failed',
        assertionOutcome: 'uncheckable',
      });
    }
    actual = Object.prototype.hasOwnProperty.call(observed, 'actual') ? observed.actual : observed;
    available = true;
  }
  if (!available) {
    if (options.strictAssertionEvidenceRequired === true) {
      return strictUncheckableAssertionOutcome(options, step, 'assertion_actual_value_unavailable');
    }
    return projectOutcome({
      step,
      family: FAMILIES.ASSERTION,
      status: 'blocked',
      outcomeKind: OUTCOME_KINDS.EXECUTION_UNCERTAINTY,
      reason: 'assertion_actual_value_unavailable',
      seal: options.seal,
      actionOutcome: 'failed',
      assertionOutcome: 'uncheckable',
    });
  }

  const strictContract = options.strictAssertionEvidenceRequired === true
    ? strictAssertionContract(assertion, step, options.failurePolicy)
    : null;
  if (strictContract) {
    const comparison = strictAssertionEngine.evaluateAssertion({
      assertion: strictContract,
      evidence: assertionEvidenceOf(observedRecord),
      failurePolicy: strictContract.failurePolicy,
      sensitiveValues: options.sensitiveValues,
    });
    if (comparison.status === strictAssertionEngine.ASSERTION_STATUS.PASS) {
      return projectOutcome({
        step,
        family: FAMILIES.ASSERTION,
        status: 'pass',
        outcomeKind: OUTCOME_KINDS.SUCCESS,
        reason: comparison.reason,
        record: comparison,
        seal: options.seal,
        actionOutcome: 'succeeded',
        assertionOutcome: 'matched',
      });
    }
    if (comparison.status === strictAssertionEngine.ASSERTION_STATUS.FAIL) {
      return projectOutcome({
        step,
        family: FAMILIES.ASSERTION,
        status: 'fail',
        outcomeKind: OUTCOME_KINDS.FUNCTIONAL_FAILURE,
        reason: comparison.reason,
        record: comparison,
        seal: options.seal,
        actionOutcome: 'succeeded',
        assertionOutcome: 'not_matched',
      });
    }
    return strictUncheckableAssertionOutcome(
      options,
      step,
      comparison.reason || 'strict_assertion_evidence_uncheckable',
      comparison,
    );
  }

  const comparison = typedAssertionComparator.compareTypedAssertion(assertion, actual);
  if (comparison.outcome === typedAssertionComparator.OUTCOMES.MATCHED) {
    return projectOutcome({
      step,
      family: FAMILIES.ASSERTION,
      status: 'pass',
      outcomeKind: OUTCOME_KINDS.SUCCESS,
      reason: comparison.reason,
      record: comparison,
      seal: options.seal,
      actionOutcome: 'succeeded',
      assertionOutcome: 'matched',
    });
  }
  if (comparison.outcome === typedAssertionComparator.OUTCOMES.NOT_MATCHED) {
    return projectOutcome({
      step,
      family: FAMILIES.ASSERTION,
      status: 'fail',
      outcomeKind: OUTCOME_KINDS.FUNCTIONAL_FAILURE,
      reason: comparison.reason,
      record: comparison,
      seal: options.seal,
      actionOutcome: 'succeeded',
      assertionOutcome: 'not_matched',
    });
  }
  return projectOutcome({
    step,
    family: FAMILIES.ASSERTION,
    status: 'blocked',
    outcomeKind: OUTCOME_KINDS.EXECUTION_UNCERTAINTY,
    reason: comparison.reason || 'typed_assertion_uncheckable',
    record: comparison,
    seal: options.seal,
    actionOutcome: 'succeeded',
    assertionOutcome: 'uncheckable',
  });
}

async function executeEventAction(options = {}) {
  const adapter = options.eventAdapter;
  const execute = typeof adapter === 'function' ? adapter : adapter?.execute;
  if (typeof execute !== 'function') {
    return projectOutcome({
      step: options.step,
      family: FAMILIES.EVENT,
      status: 'blocked',
      outcomeKind: OUTCOME_KINDS.EXECUTION_UNCERTAINTY,
      reason: 'event_action_adapter_unavailable',
      seal: options.seal,
      actionOutcome: 'not_executed',
    });
  }
  let result = null;
  try {
    result = await execute.call(adapter, { ...options, family: FAMILIES.EVENT });
  } catch (_) {}
  if (!result || typeof result !== 'object') {
    return projectOutcome({
      step: options.step,
      family: FAMILIES.EVENT,
      status: 'blocked',
      outcomeKind: OUTCOME_KINDS.EXECUTION_UNCERTAINTY,
      reason: 'event_action_execution_uncertain',
      seal: options.seal,
      actionOutcome: 'failed',
    });
  }
  return { handled: true, family: FAMILIES.EVENT, ...result };
}

async function executeWaitForState(options = {}) {
  const step = options.step || {};
  if (typeof options.observeWait !== 'function') {
    return projectOutcome({
      step,
      family: FAMILIES.WAIT,
      status: 'pass',
      outcomeKind: OUTCOME_KINDS.SUCCESS,
      reason: 'wait_observer_unavailable_continue_to_concrete_step',
      record: {
        status: 'warning',
        matched: null,
        checked: false,
        reason: 'wait_observer_unavailable_continue_to_concrete_step',
        kind: 'wait_advisory',
        required: false,
      },
      seal: options.seal,
      actionOutcome: 'succeeded',
      assertionOutcome: 'not_applicable',
      internalOperationCompletion: true,
      internalOperationKind: 'wait_for_state',
    });
  }
  const contract = options.waitContract || waitContract.buildWaitContract(step);
  let before = null;
  try {
    before = await options.observeWait({ phase: 'before', step, contract });
  } catch (_) {}
  if (!isFreshObservation(before)) {
    return projectOutcome({
      step,
      family: FAMILIES.WAIT,
      status: 'pass',
      outcomeKind: OUTCOME_KINDS.SUCCESS,
      reason: 'fresh_wait_observation_unavailable_continue_to_concrete_step',
      record: {
        status: 'warning',
        matched: null,
        checked: false,
        reason: 'fresh_wait_observation_unavailable_continue_to_concrete_step',
        kind: 'wait_advisory',
        required: false,
        contract,
        before,
      },
      seal: options.seal,
      actionOutcome: 'succeeded',
      assertionOutcome: 'not_applicable',
      internalOperationCompletion: true,
      internalOperationKind: 'wait_for_state',
    });
  }
  let result = null;
  try {
    result = await waitContract.pollUntilStable({
      contract,
      before,
      observe: () => options.observeWait({ phase: 'poll', step, contract, before }),
      now: typeof options.now === 'function' ? options.now : Date.now,
      sleep: typeof options.sleep === 'function' ? options.sleep : undefined,
    });
  } catch (_) {}
  const matched = result?.matched === true;
  if (!matched && result?.timedOut === true) {
    return projectOutcome({
      step,
      family: FAMILIES.WAIT,
      status: 'pass',
      outcomeKind: OUTCOME_KINDS.SUCCESS,
      reason: 'wait_budget_elapsed_continue_to_concrete_step',
      record: {
        status: 'warning',
        matched: null,
        checked: true,
        reason: 'wait_budget_elapsed_continue_to_concrete_step',
        evidence: `The bounded wait ended without deterministic state proof (${result.reason || 'wait_state_unconfirmed'}). QAAI continued to the next concrete operation, which must still prove its own target and postcondition.`,
        kind: 'wait_advisory',
        required: false,
        originalResult: result,
      },
      seal: options.seal,
      actionOutcome: 'succeeded',
      assertionOutcome: 'not_applicable',
      internalOperationCompletion: true,
      internalOperationKind: 'wait_for_state',
    });
  }
  if (!matched) {
    return projectOutcome({
      step,
      family: FAMILIES.WAIT,
      status: 'pass',
      outcomeKind: OUTCOME_KINDS.SUCCESS,
      reason: result?.reason || 'wait_state_unconfirmed_continue_to_concrete_step',
      record: {
        status: 'warning',
        matched: null,
        checked: true,
        reason: result?.reason || 'wait_state_unconfirmed_continue_to_concrete_step',
        kind: 'wait_advisory',
        required: false,
        originalResult: result,
      },
      seal: options.seal,
      actionOutcome: 'succeeded',
      assertionOutcome: 'not_applicable',
      internalOperationCompletion: true,
      internalOperationKind: 'wait_for_state',
    });
  }
  return projectOutcome({
    step,
    family: FAMILIES.WAIT,
    status: matched ? 'pass' : 'blocked',
    outcomeKind: matched ? OUTCOME_KINDS.SUCCESS : OUTCOME_KINDS.EXECUTION_UNCERTAINTY,
    reason: result?.reason || 'wait_state_unconfirmed',
    record: { contract, before, result },
    seal: options.seal,
    actionOutcome: matched ? 'succeeded' : 'failed',
    assertionOutcome: matched ? 'matched' : 'uncheckable',
    internalOperationCompletion: matched,
    internalOperationKind: matched ? 'wait_for_state' : null,
  });
}

async function executeOptionalPresencePreflight(options = {}) {
  const step = options.step || {};
  if (!isPresenceConditionalAction(step) || conditionalActionRequiredByContract(step)) return null;
  if (typeof options.resolveOptionalPresence !== 'function') return null;
  let presence = null;
  try {
    presence = await options.resolveOptionalPresence({
      step,
      target: controlActionAdapter.targetOf(step) || step.target || step.element || null,
      family: options.family || classifyActionFamily(step, { eventAdapter: options.eventAdapter }),
    });
  } catch (_) {
    presence = null;
  }
  if (presence?.present !== false || presence?.authoritativeAbsence !== true) return null;
  const family = options.family || classifyActionFamily(step, { eventAdapter: options.eventAdapter });
  return projectOutcome({
    step,
    family,
    status: 'pass',
    outcomeKind: OUTCOME_KINDS.SUCCESS,
    reason: 'optional_target_absent',
    record: {
      status: 'pass',
      matched: true,
      checked: true,
      reason: 'optional_target_absent',
      evidence: presence.evidence
        || 'The conditionally present control was authoritatively absent in a fresh browser observation, so the authored on-false skip branch committed without dispatch.',
      kind: 'operation_check',
      required: false,
      optionalAbsent: true,
      presenceEvidenceSource: presence.source || null,
    },
    diagnostics: {
      optionalPresence: {
        checked: true,
        present: false,
        authoritativeAbsence: true,
        source: presence.source || null,
        reason: presence.reason || 'optional_target_absent',
      },
      dispatches: [],
    },
    seal: options.seal,
    actionOutcome: 'succeeded',
    assertionOutcome: 'not_applicable',
    dispatched: false,
    internalOperationCompletion: true,
    internalOperationKind: 'optional_absent',
  });
}

async function executeUniversalAction(options = {}) {
  const step = options.step || {};
  const family = classifyActionFamily(step, { eventAdapter: options.eventAdapter });
  const optionalAbsent = await executeOptionalPresencePreflight({ ...options, step, family });
  if (optionalAbsent) return optionalAbsent;
  if (family === FAMILIES.CLICK) {
    const result = await genericClickExecution.executeGenericClick({
      step,
      target: options.target || controlActionAdapter.targetOf(step) || step.description || step.name || '',
      transitionSteps: options.transitionSteps,
      observe: options.observe,
      dispatch: options.dispatch,
      proveEffect: options.proveEffect,
      seal: options.seal,
      evidenceAdapter: options.evidenceAdapter,
      transactionContext: options.transactionContext,
    });
    const status = result?.diagnostics?.final?.status || null;
    return {
      family,
      status,
      outcomeKind: status === 'pass' ? OUTCOME_KINDS.SUCCESS
        : status === 'fail' ? OUTCOME_KINDS.FUNCTIONAL_FAILURE : OUTCOME_KINDS.EXECUTION_UNCERTAINTY,
      ...result,
    };
  }
  if (family === FAMILIES.CONTROL) return executeControlAction(options);
  if (family === FAMILIES.WAIT) return executeWaitForState(options);
  if (family === FAMILIES.ASSERTION) return executeTypedAssertion(options);
  if (family === FAMILIES.EVENT) return executeEventAction(options);
  return projectOutcome({
    step,
    family: FAMILIES.UNSUPPORTED,
    status: 'blocked',
    outcomeKind: OUTCOME_KINDS.EXECUTION_UNCERTAINTY,
    reason: 'unsupported_action_family',
    seal: options.seal,
    actionOutcome: 'not_executed',
  });
}

module.exports = {
  FAMILIES,
  OUTCOME_KINDS,
  actionToken,
  assertionContractOf,
  classifyActionFamily,
  controlOpenerIntent,
  buildControlOpenerPlan,
  executeControlAction,
  executeWaitForState,
  executeTypedAssertion,
  executeEventAction,
  executeOptionalPresencePreflight,
  executeUniversalAction,
};
