'use strict';

const universalActionKernel = require('./universalActionKernel');
const controlActionAdapter = require('./controlActionAdapter');
const controlStateProbe = require('./controlStateProbe');
const dropdownTransaction = require('./dropdownTransaction');
const calendarCandidateProbe = require('./calendarCandidateProbe');
const calendarTimeTransaction = require('./calendarTimeTransaction');
const browserEventBroker = require('./browserEventBroker');
const genericClickExecution = require('./genericClickExecution');
const pageFingerprint = require('./pageFingerprint');
const typedAssertionComparator = require('./typedAssertionComparator');
const waitContract = require('./waitContract');
const actionLocatorResolver = require('./actionLocatorResolver');
const browserEvidenceAdapterRegistry = require('./browserEvidenceAdapterRegistry');
const { isPresenceConditionalAction } = require('./conditionalActionIntent');

const LIVE_ASSERTION_TYPES = new Set([
  'TEXT', 'FORBIDDEN_TEXT', 'REGEX', 'NUMBER', 'CURRENCY', 'DATE', 'TIME', 'DATE_TIME', 'DATETIME',
  'URL', 'VISIBLE', 'HIDDEN', 'ATTRIBUTE', 'VALUE', 'SELECTED', 'CHECKED', 'COUNT',
  'TABLE', 'TABLE_ROW', 'TABLE_CELL', 'TABLE_COLUMN', 'TABLE_QUERY', 'COLLECTION', 'COLLECTION_MEMBERSHIP',
  'RELATIONSHIP', 'ASSERTRELATIONSHIP', 'TEMPORAL_RELATIONSHIP', 'TEMPORALRELATIONSHIP',
  'TEMPORALCOMPARISON', 'ASSERTTEMPORAL',
]);

function token(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function exactSnapshotRef(value) {
  const ref = String(value == null ? '' : value).trim();
  return /^(?:f\d+)?e\d+$/i.test(ref) ? ref : null;
}

function normalizedControlBindingKey(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(?:dropdown|combobox|listbox|menu|options?|option list|calendar|date picker|time picker|field|input|control|button|link)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dispatchedControlRef(dispatched, phase = {}) {
  const locator = dispatched?.qaaiActionLocator || dispatched?.result?.qaaiActionLocator || null;
  const locatorFields = locator?.kind === 'multi' && Array.isArray(locator.fields)
    ? locator.fields
    : [];
  const phaseFields = Array.isArray(phase?.args?.fields) ? phase.args.fields : [];
  const resolvedArgs = dispatched?.resolvedArgs
    || dispatched?.qaaiResolvedArgs
    || dispatched?.result?.qaaiResolvedArgs
    || null;
  const resolvedFields = Array.isArray(resolvedArgs?.fields) ? resolvedArgs.fields : [];
  const candidates = [
    dispatched?.resolvedTarget,
    dispatched?.target,
    resolvedArgs?.ref,
    resolvedArgs?.target,
    locator?.ref,
    ...locatorFields.flatMap((field) => [field?.ref, field?.target, field?.actionLocator?.ref]),
    phase?.args?.ref,
    phase?.args?.target,
    ...phaseFields.flatMap((field) => [field?.ref, field?.target]),
    ...resolvedFields.flatMap((field) => [field?.ref, field?.target]),
  ];
  return candidates.map(exactSnapshotRef).find(Boolean) || null;
}

function temporalIntentForStep(step = {}, plan = {}) {
  if (plan.kind === 'date') return 'date';
  if (plan.kind !== 'select') return null;
  const target = String(controlActionAdapter.targetOf(step) || '').toLowerCase();
  if (/\btime\s*zone\b|\btimezone\b/.test(target)) return 'timezone';
  const expected = plan.postcondition?.expected ?? plan.value ?? step.value ?? step.expectedValue;
  if (/\btime\b/.test(target) && calendarTimeTransaction.normalizeTimeValue(expected)) return 'time';
  return null;
}

function eventKindForStep(step = {}) {
  const action = universalActionKernel.actionToken(step);
  // Presence-conditional clicks must evaluate their authored on-false skip
  // branch before any event wrapper is armed. Otherwise an absent optional
  // prompt is misclassified as a failed navigation trigger.
  if (['click', 'tap'].includes(action) && isPresenceConditionalAction(step)) return null;
  // An explicitly authored option-row click must resolve and dispatch that
  // exact option before any broad page_ready metadata can wrap it as a
  // navigation event. Selecting an option may update page state, but it is
  // still a control action rather than a navigation trigger.
  if (['click', 'tap'].includes(action) && genericClickExecution.parseAuthoredOptionClickIntent(
    step.target || step.element || step.control || '',
  )) return null;
  const explicit = [
    step.eventKind, step.expectedEventKind, step.event?.kind,
    step.operationCheck?.eventKind, step.operationCheck?.kind,
    step.waitContract?.eventKind, step.waitContract?.kind,
    step.expectedKind,
  ].map(token).filter(Boolean);
  const joined = explicit.join(' ');
  if (/popup|newpage/.test(joined)) return 'popup';
  if (/download/.test(joined)) return 'download';
  if (/filechooser/.test(joined)) return 'file_chooser';
  if (/upload|fileupload/.test(joined)) return 'upload';
  if (/dialog|alert|confirm|prompt/.test(joined)) return 'dialog';
  if (/pagechange|fingerprintchanged/.test(joined)) return 'page_change';
  // page_ready is a post-action condition, not proof that a browser navigation
  // event must be observed. Ordinary clicks with a page_ready check stay on
  // Click authority, where URL/DOM/landing-oracle evidence can reconcile the
  // outcome. Only an explicitly authored navigation event uses the event
  // broker; otherwise delayed or missing telemetry could veto a delivered
  // click before the destination state is inspected.
  if (/navigation|navigate|urlchanged/.test(joined)) return 'navigation';
  if (['download', 'popup', 'upload', 'fileupload', 'filechooser', 'dialog', 'navigate', 'navigation', 'goto', 'openpage'].includes(action)) {
    return {
      fileupload: 'upload', filechooser: 'file_chooser', navigate: 'navigation',
      goto: 'navigation', openpage: 'navigation',
    }[action] || action;
  }
  return null;
}

function requireHook(hooks, name) {
  if (typeof hooks?.[name] !== 'function') throw new TypeError(`conductor universal runtime requires hooks.${name}()`);
}

function extractAttributeNames(plan) {
  const expected = plan?.postcondition?.expected;
  return expected && typeof expected === 'object' && expected.kind === 'attribute' && expected.name
    ? [expected.name]
    : [];
}

const CONTROL_KIND_PROBE_FUNCTION = `(element) => {
  if (!element || element.nodeType !== 1) return { found: false };
  return {
    found: true,
    tagName: String(element.tagName || '').toLowerCase(),
    inputType: String(element.getAttribute?.('type') || '').toLowerCase(),
    role: String(element.getAttribute?.('role') || '').toLowerCase(),
    readOnly: element.readOnly === true || element.getAttribute?.('aria-readonly') === 'true',
    disabled: element.disabled === true || element.getAttribute?.('aria-disabled') === 'true',
    contentEditable: element.isContentEditable === true,
  };
}`;

function buildVirtualizedOptionRevealFunction(position = 0) {
  const ratio = Math.max(0, Math.min(1, Number(position || 0)));
  return `(element) => {
    const owner = element && element.nodeType === 1 ? element : null;
    if (!owner) return { ok: false, reason: 'owner_missing' };
    const visible = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
    };
    const controlledIds = [owner.getAttribute('aria-controls'), owner.getAttribute('aria-owns')]
      .filter(Boolean).flatMap((value) => String(value).split(/\\s+/)).filter(Boolean);
    const controlled = controlledIds.map((id) => document.getElementById(id)).filter(visible);
    const rolePopups = Array.from(document.querySelectorAll('[role="listbox"], [role="menu"], [role="tree"]'))
      .filter(visible);
    const popupCandidates = Array.from(new Set([...controlled, ...rolePopups]));
    if (!popupCandidates.length) return { ok: false, reason: 'visible_popup_missing' };
    const ownerRect = owner.getBoundingClientRect();
    const popup = popupCandidates
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const controlledBonus = controlled.includes(node) ? 100000 : 0;
        const optionBonus = node.querySelectorAll('[role="option"], [role^="menuitem"], [role="treeitem"]').length * 100;
        const distance = Math.abs(rect.left - ownerRect.left) + Math.abs(rect.top - ownerRect.bottom);
        return { node, score: controlledBonus + optionBonus - distance };
      })
      .sort((left, right) => right.score - left.score)[0]?.node;
    if (!popup) return { ok: false, reason: 'owner_popup_not_correlated' };
    const descendants = [popup, ...popup.querySelectorAll('*')];
    const scrollable = descendants
      .filter((node) => {
        if (!visible(node) || node.scrollHeight <= node.clientHeight + 2) return false;
        const overflow = getComputedStyle(node).overflowY;
        return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
      })
      .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight))[0];
    if (!scrollable) return { ok: false, reason: 'popup_not_scrollable' };
    const maxScroll = Math.max(0, scrollable.scrollHeight - scrollable.clientHeight);
    const before = scrollable.scrollTop;
    scrollable.scrollTop = Math.round(maxScroll * ${ratio});
    scrollable.dispatchEvent(new Event('scroll', { bubbles: true }));
    return {
      ok: true,
      reason: 'owner_scoped_option_panel_repositioned',
      before,
      after: scrollable.scrollTop,
      maxScroll,
      ratio: ${ratio},
      controlledPopup: controlled.includes(popup),
    };
  }`;
}

function buildVirtualizedTimeOptionRevealFunction(expectedValue, offset = 0) {
  const normalized = calendarTimeTransaction.normalizeTimeValue(expectedValue);
  if (!normalized) return null;
  const [hour, minute] = normalized.split(':').map(Number);
  const baseRatio = (hour * 60 + minute) / ((24 * 60) - 1);
  return buildVirtualizedOptionRevealFunction(baseRatio + Number(offset || 0));
}

function branchAcceptsControl(branch, facts = {}) {
  const tagName = String(facts.tagName || '').toLowerCase();
  const inputType = String(facts.inputType || '').toLowerCase();
  if (branch === 'target_is_native_select') return tagName === 'select';
  if (branch === 'target_is_aria_or_custom') return tagName !== 'select';
  if (branch === 'target_is_native_date_input') return tagName === 'input' && inputType === 'date';
  if (branch === 'target_is_semantic_calendar') return !(tagName === 'input' && inputType === 'date');
  return true;
}

function createConductorUniversalRuntime({
  hooks = {},
  eventAdapters = null,
  evidenceAdapter = null,
  evidenceRegistry = null,
  evidenceRequest = {},
} = {}) {
  requireHook(hooks, 'snapshot');
  requireHook(hooks, 'evaluate');
  requireHook(hooks, 'resolveRef');
  requireHook(hooks, 'dispatch');
  requireHook(hooks, 'dispatchEvent');
  requireHook(hooks, 'seal');

  const evidenceAdapterOptions = {
    capturePlaywright: async ({ phase, request }) => {
      if (typeof hooks.capturePlaywrightEvidence === 'function') {
        return hooks.capturePlaywrightEvidence({ phase, request });
      }
      const resolution = request.resolution || {};
      const locator = resolution.actionLocator || resolution.qaaiActionLocator || resolution.locator || null;
      const identity = resolution.semanticIdentity || resolution.identity || {};
      if (!locator && !Object.keys(identity).length) return null;
      return {
        locator,
        target: {
          tagName: identity.tagName || null,
          role: identity.role || locator?.role || null,
          name: identity.name || locator?.accessibleName || locator?.label || null,
          visible: request.observation?.visible !== false,
          enabled: request.observation?.enabled !== false,
          editable: request.observation?.editable === true,
        },
        action: {
          type: request.actionType || null,
          dispatched: phase !== 'pre',
          completed: phase === 'post',
        },
      };
    },
    captureCdp: async ({ phase, request }) => {
      if (typeof hooks.captureCdpEvidence === 'function') return hooks.captureCdpEvidence({ phase, request });
      return request.dispatched?.qaaiActionEvidence?.authoritativeCdp
        || request.resolution?.actionEvidence?.authoritativeCdp
        || request.resolution?.qaaiActionEvidence?.authoritativeCdp
        || null;
    },
    captureAx: async ({ phase, request }) => {
      if (typeof hooks.captureAxEvidence === 'function') return hooks.captureAxEvidence({ phase, request });
      const locator = request.resolution?.actionLocator || request.resolution?.qaaiActionLocator || null;
      if (!locator) return null;
      return {
        backendDOMNodeId: locator.backendNodeId || null,
        role: { value: locator.role || null },
        name: { value: locator.accessibleName || locator.label || null },
      };
    },
    captureDom: async ({ phase, request }) => {
      if (typeof hooks.captureDomEvidence === 'function') return hooks.captureDomEvidence({ phase, request });
      return request.dispatched?.qaaiActionEvidence?.domFacts
        || request.observation?.domFacts
        || request.resolution?.domFacts
        || null;
    },
    captureEvents: async ({ phase, request }) => {
      if (typeof hooks.captureBrowserEvents === 'function') return hooks.captureBrowserEvents({ phase, request });
      return request.dispatched?.browserEventEvidence || request.dispatched?.qaaiBrowserEvents || null;
    },
    captureScreenshot: typeof hooks.captureEvidenceScreenshot === 'function'
      ? ({ phase, request }) => hooks.captureEvidenceScreenshot({ phase, request })
      : null,
  };
  const activeEvidenceRegistry = evidenceRegistry
    || browserEvidenceAdapterRegistry.createBrowserEvidenceAdapterRegistry({
      defaults: {
        playwrightCdp: {
          cdpAvailable: hooks.cdpAvailable === true || typeof hooks.captureCdpEvidence === 'function',
        },
      },
    });
  const evidenceNegotiation = evidenceAdapter
    ? Object.freeze({
      status: 'ready',
      authoritativeAdapter: {
        id: 'explicit-runtime-adapter',
        kind: 'authoritative',
        proofMode: 'explicit',
        canCreateActionEvidence: true,
      },
      assists: [],
      confidencePolicy: {
        canonicalEvidenceRequired: true,
        advisoryCanRaiseConfidenceAlone: false,
        advisoryCanCreateActionEvidence: false,
      },
    })
    : activeEvidenceRegistry.negotiate({
      browser: evidenceRequest.browser || hooks.browserName || hooks.browser || 'chromium',
      surface: evidenceRequest.surface || hooks.surfaceType || 'dom',
      requiredCapabilities: evidenceRequest.requiredCapabilities,
      optionalCapabilities: evidenceRequest.optionalCapabilities,
      requestedAssists: evidenceRequest.requestedAssists,
    });
  const createdEvidenceAdapter = evidenceAdapter
    ? { status: 'ready', adapter: evidenceAdapter, manualGate: null }
    : activeEvidenceRegistry.createAuthoritativeAdapter(evidenceNegotiation, evidenceAdapterOptions);
  if (!createdEvidenceAdapter.adapter) {
    const code = createdEvidenceAdapter.manualGate?.code || 'EVIDENCE_ADAPTER_UNAVAILABLE';
    throw new Error(`${code}: deterministic browser evidence adapter is required`);
  }
  const activeEvidenceAdapter = createdEvidenceAdapter.adapter;
  // Authored flows often split one control transaction into Click -> Wait ->
  // Select/Date. Retain the verified owner from the opener so the typed action
  // does not have to rediscover it while an overlay has changed the AX tree.
  // Every reuse is revalidated against the live element before dispatch.
  const verifiedControlOwners = new Map();

  const broker = browserEventBroker.createBrowserEventBroker({ adapters: eventAdapters || {} });
  const eventAdapter = {
    canHandle: (step) => !!eventKindForStep(step),
    async execute(options = {}) {
      const step = options.step || {};
      const eventKind = eventKindForStep(step);
      if (!eventKind) return { handled: false, family: 'event', reason: 'typed_event_contract_missing' };
      let contract;
      try {
        contract = browserEventBroker.buildEventContract({
          ...step,
          eventKind,
          waitContract: step.waitContract,
          expected: {
            ...(step.expected && typeof step.expected === 'object' ? step.expected : {}),
            ...(step.operationCheck?.expected && typeof step.operationCheck.expected === 'object' ? step.operationCheck.expected : {}),
          },
          actionId: options.actionId,
        });
      } catch (_) {
        return { handled: true, family: 'event', status: 'blocked', terminal: true, reason: 'typed_event_contract_invalid' };
      }
      const evidence = await broker.execute({
        actionId: options.actionId,
        contract,
        trigger: () => hooks.dispatchEvent({ step, eventKind, contract, options }),
      });
      const status = evidence.matched === true ? 'pass' : evidence.matched === false ? 'fail' : 'blocked';
      const outcomeKind = status === 'pass'
        ? universalActionKernel.OUTCOME_KINDS.SUCCESS
        : status === 'fail'
          ? universalActionKernel.OUTCOME_KINDS.FUNCTIONAL_FAILURE
          : universalActionKernel.OUTCOME_KINDS.EXECUTION_UNCERTAINTY;
      const payload = {
        family: universalActionKernel.FAMILIES.EVENT,
        status,
        outcomeKind,
        reason: evidence.reason || `${eventKind}_event_result`,
        record: evidence,
        diagnostics: { schema: 'qaai_universal_event_attempt_v1', eventKind, evidence },
        actionOutcome: evidence.trigger?.started === true ? (status === 'pass' ? 'succeeded' : 'failed') : 'not_executed',
        assertionOutcome: evidence.matched === true ? 'matched' : evidence.matched === false ? 'not_matched' : 'uncheckable',
        runtimeToolName: evidence.trigger?.toolName || null,
      };
      const sealed = await options.seal(payload);
      const sealedRow = sealed?.sealed || sealed || null;
      const sealedStatus = token(sealedRow?.status);
      const sealedContinuation = token(sealedRow?.continuationOutcome);
      const sealedRejected = status === 'pass' && sealedRow && (
        ['blocked', 'fail', 'failed', 'error'].includes(sealedStatus)
        || token(sealedRow.actionOutcome) === 'failed'
        || sealedRow.executionError === true
        || ['stopcase', 'stopdescendants'].includes(sealedContinuation)
      );
      if (status === 'pass' && !sealedRejected) {
        return { handled: true, family: 'event', status, outcomeKind, reason: payload.reason, record: evidence, terminal: false };
      }
      const continuation = genericClickExecution.decideDependencyScopedContinuation({
        step,
        sealed: sealedRow,
        hasRunnableStep: sealed?.hasRunnableStep === true,
      });
      return {
        handled: true,
        family: 'event',
        status: sealedRejected ? 'blocked' : status,
        outcomeKind: sealedRejected ? universalActionKernel.OUTCOME_KINDS.EXECUTION_UNCERTAINTY : outcomeKind,
        reason: sealedRejected
          ? (sealedRow?.continuationReason || sealedRow?.reason || sealedRow?.error || 'execution_journal_rejected_success')
          : payload.reason,
        record: evidence,
        terminal: continuation.terminal,
        continuation,
      };
    },
  };

  async function calendarFacts(snapshotText) {
    const raw = await hooks.evaluate({
      function: calendarCandidateProbe.CALENDAR_CANDIDATE_FUNCTION,
      source: 'semantic_calendar_candidate_probe',
    });
    const parsed = raw && typeof raw === 'object' ? raw : {};
    return {
      semanticCandidates: calendarCandidateProbe.attachSnapshotRefs(parsed.candidates || [], snapshotText),
      calendarState: parsed.calendarState || null,
    };
  }

  async function runControl({ step, idx, actionId, suppliedPlan = null }) {
    const planForWait = suppliedPlan || controlActionAdapter.buildControlActionPlan(step);
    const kind = planForWait.kind;
    let primaryRef = null;
    let beforePage = null;
    let lastDispatchState = null;
    const snapshots = { beforeOpen: '', afterOpen: '', afterSelect: '' };
    const controlBindingKey = normalizedControlBindingKey(controlActionAdapter.targetOf(step));
    const revealedPhaseIds = new Set();
    const persistedTransaction = typeof hooks.readActionTransaction === 'function'
      ? await hooks.readActionTransaction({ idx, step, actionId })
      : null;
    let dropdownTracker = null;
    let dropdownOwnerRef = null;
    let reusedVerifiedOwnerBinding = false;
    let temporalControlFailure = null;
    const dropdownExpectedValue = planForWait.postcondition?.expected
      ?? planForWait.value
      ?? planForWait.expectedValue
      ?? step.value
      ?? step.expectedValue;
    const dropdownExpectedOptions = [
      step.expectedOptions,
      step.optionOrder,
      step.verify?.expectedOptions,
      step.assertion?.expectedOptions,
    ].find(Array.isArray) || [];
    const temporalIntent = temporalIntentForStep(step, planForWait);
    const temporalExpected = planForWait.postcondition?.expected
      ?? planForWait.value ?? step.value ?? step.expectedValue;
    const temporalTracker = temporalIntent
      ? calendarTimeTransaction.createTemporalRuntimeTracker({
          intentKind: temporalIntent,
          expected: temporalExpected,
          matchMode: planForWait.metadata?.optionMatch || (temporalIntent === 'timezone' ? 'contains' : 'exact'),
          dateOrder: step.dateOrder || step.localeOrder,
          now: hooks.now,
        })
      : null;
    const acceptTemporalControl = (resolution = null) => {
      if (!temporalTracker || temporalTracker.snapshot().controlValidation) return null;
      const resolved = resolution?.resolvedCandidate?.resolvedControl
        || resolution?.semanticResolution?.candidate?.resolvedControl
        || resolution?.candidate?.resolvedControl
        || null;
      return resolved ? temporalTracker.acceptControl(resolved) : null;
    };
    const captureDropdownState = async (ref, source) => {
      if (kind !== 'select' || !ref) return null;
      const captured = await hooks.evaluate({
        function: controlStateProbe.dropdownStateFunction({ ownerRef: ref }),
        element: controlActionAdapter.targetOf(step),
        target: ref,
        source,
      });
      if (!captured || typeof captured !== 'object') return captured;
      if (captured.owner || captured.ownerElement || captured.control) return captured;

      // Keep older/native evidence providers useful while the browser-side
      // probe supplies the richer owner/popup shape in live execution.
      const owner = {
        ref,
        role: token(captured.role || 'combobox'),
        tag: token(captured.tag || captured.tagName),
        label: controlActionAdapter.targetOf(step),
        selectedValue: captured.selectedValue ?? captured.selectedLabel ?? null,
        displayedValue: captured.selectedText ?? captured.displayedValue ?? captured.renderedValue ?? null,
        value: captured.value ?? captured.actualValue ?? captured.valueAfter ?? null,
        expanded: captured.expanded ?? captured.ariaExpanded ?? null,
        visible: captured.visible !== false,
        enabled: captured.disabled !== true,
        attributes: captured.attributes && typeof captured.attributes === 'object'
          ? captured.attributes
          : {},
      };
      return {
        available: captured.available !== false,
        owner,
        trigger: owner,
        valueNode: owner,
        popups: Array.isArray(captured.popups) ? captured.popups : [],
        visibleOptions: Array.isArray(captured.visibleOptions)
          ? captured.visibleOptions
          : Array.isArray(captured.options) ? captured.options : [],
        nativeSelectReady: captured.nativeSelectReady === true,
        eventEvidence: captured.eventEvidence || null,
      };
    };
    const ensureDropdownTracker = async (resolution, ref) => {
      if (kind !== 'select' || dropdownTracker || !ref) return dropdownTracker;
      const resolved = resolution?.resolvedCandidate?.resolvedControl
        || resolution?.semanticResolution?.candidate?.resolvedControl
        || resolution?.candidate?.resolvedControl
        || null;
      const facts = resolved ? null : await hooks.evaluate({
        function: CONTROL_KIND_PROBE_FUNCTION,
        element: controlActionAdapter.targetOf(step),
        target: ref,
        source: 'dropdown_transaction_owner_probe',
      });
      const role = token(resolved?.ownerElement?.role || facts?.role || step.targetRole || step.role || 'combobox');
      const tag = token(resolved?.ownerElement?.tag || facts?.tagName || step.targetTag || step.tag);
      const fallbackControlType = tag === 'select' ? 'native_select'
        : role === 'listbox' ? 'listbox'
          : ['textbox', 'searchbox', 'spinbutton'].includes(role) ? 'autocomplete' : 'combobox';
      const labels = [controlActionAdapter.targetOf(step)];
      const control = resolved && dropdownTransaction.SUPPORTED_CONTROL_TYPES.has(resolved.controlType)
        ? resolved
        : {
            controlType: fallbackControlType,
            requestedAction: 'select',
            requestedTarget: controlActionAdapter.targetOf(step),
            ownerElement: { ref, role, tag, labels, visible: facts?.visible !== false, enabled: facts?.disabled !== true },
            interactionElement: { ref, role, tag, labels, visible: facts?.visible !== false, enabled: facts?.disabled !== true },
            valueElement: { ref, role, tag, labels, visible: facts?.visible !== false, enabled: facts?.disabled !== true },
          };
      if (temporalTracker) {
        const validation = temporalTracker.acceptControl(control);
        if (validation.ok !== true) {
          temporalControlFailure = validation;
          return null;
        }
      }
      dropdownTracker = dropdownTransaction.createDropdownRuntimeTracker({
        control,
        expectedValue: dropdownExpectedValue,
        expectedOptions: dropdownExpectedOptions,
        matchMode: planForWait.metadata?.optionMatch || 'exact',
        caseSensitive: step.caseSensitive !== false,
        expectPopupClose: step.expectPopupClose !== false,
        now: hooks.now,
      });
      dropdownOwnerRef = ref;
      const before = await captureDropdownState(ref, 'dropdown_transaction_before_open');
      if (before) {
        dropdownTracker.captureClosed(before);
        // A previous authored Click/Wait/Assert step may have already opened
        // this owner. Adopt that fresh owner-scoped state instead of sending a
        // second click or keyboard gesture during the Select transaction.
        dropdownTracker.proveOpened(before);
      }
      if (resolution?.phaseAlreadySatisfied === true
        && dropdownTracker.snapshot().state !== dropdownTransaction.STATES.OPEN) {
        dropdownTracker.acceptOpenedEvidence({
          reason: 'semantic_owner_open_state_proven',
          ownerRef: ref,
          fulfilledBy: resolution.fulfilledBy || resolution.code || 'semantic_resolution',
        });
      }
      return dropdownTracker;
    };
    const dropdownPhaseKind = (phase = {}) => {
      const phaseId = token(phase.id);
      if (phaseId === 'selectnativeoption') return 'select';
      if (phaseId === 'chooseexactoption' || phaseId === 'choosematchingoption'
        || phaseId.includes('typeaheadexactoption')) return 'select';
      if (phaseId === 'openchoicecontrol' || phaseId === 'openchoicecontrolkeyboardassist') return 'open';
      return null;
    };
    const dropdownIsProvenOpen = () => dropdownTracker?.snapshot?.().state
      === dropdownTransaction.STATES.OPEN;
    const beforeDropdownDispatch = (phase, resolution = null) => {
      if (!dropdownTracker) return;
      const phaseKind = dropdownPhaseKind(phase);
      if (phaseKind === 'open') dropdownTracker.markOpening();
      if (phaseKind === 'select') {
        dropdownTracker.markSelecting(
          resolution?.resolvedCandidate || resolution?.semanticResolution?.candidate || null,
        );
      }
    };
    const afterDropdownDispatch = async (phase, dispatched) => {
      if (!dropdownTracker || !dropdownOwnerRef) return;
      const ok = dispatched?.ok === true || dispatched?.isError === false || dispatched?.result?.isError === false;
      if (!ok) return;
      const phaseKind = dropdownPhaseKind(phase);
      if (!phaseKind) return;
      const state = await captureDropdownState(
        dropdownOwnerRef,
        `dropdown_transaction_after_${phaseKind}`,
      );
      if (!state) return;
      if (phaseKind === 'open') dropdownTracker.proveOpened(state);
      else dropdownTracker.proveCommitted(state);
    };
    const ownerRoleHints = kind === 'select'
      ? ['combobox', 'listbox', 'textbox', 'searchbox', 'spinbutton']
      : Array.from(new Set((planForWait.phases || [])
        .filter((candidatePhase) => token(candidatePhase?.semanticTarget?.kind) !== 'option')
        .flatMap((candidatePhase) => candidatePhase?.resolution?.roleHints || [])));
    const resolveObservedOwnerRef = async (observed, source) => {
      const ownerLabel = controlActionAdapter.targetOf(step);
      const verifiedOwner = controlBindingKey ? verifiedControlOwners.get(controlBindingKey) : null;
      if (verifiedOwner?.ref) {
        const facts = await hooks.evaluate({
          function: CONTROL_KIND_PROBE_FUNCTION,
          element: ownerLabel,
          target: verifiedOwner.ref,
          source: `${source}_verified_owner_binding`,
        });
        const role = token(facts?.role);
        const roleAccepted = !ownerRoleHints.length || !role || ownerRoleHints.map(token).includes(role);
        if (facts?.found === true && facts.disabled !== true && roleAccepted) {
          reusedVerifiedOwnerBinding = true;
          return verifiedOwner.ref;
        }
        verifiedControlOwners.delete(controlBindingKey);
      }
      let ownerResolution = actionLocatorResolver.resolveSemanticActionTarget(observed.snapshotText, {
        label: ownerLabel,
        roleHints: ownerRoleHints,
        requireRef: true,
      });
      if (ownerResolution?.ok !== true) {
        const domEvidence = await hooks.evaluate({
          function: actionLocatorResolver.SEMANTIC_CONTROL_DOM_EVIDENCE_FUNCTION,
          source: `${source}_dom_evidence`,
        });
        if (Array.isArray(domEvidence?.candidates)) {
          ownerResolution = actionLocatorResolver.resolveSemanticActionTarget(observed.snapshotText, {
            label: ownerLabel,
            roleHints: ownerRoleHints,
            requireRef: true,
            domEvidence,
          });
        }
      }
      if (ownerResolution?.ok === true && ownerResolution.ref) return ownerResolution.ref;
      return hooks.resolveRef({
        step: { ...step, target: ownerLabel, element: ownerLabel },
        toolName: kind === 'fill' || kind === 'type' || kind === 'date' ? 'browser_fill_form' : 'browser_hover',
        snapshotText: observed.snapshotText,
        source,
      });
    };
    const captureSemanticOwnerState = async (source) => {
      const domEvidence = await hooks.evaluate({
        function: actionLocatorResolver.SEMANTIC_CONTROL_DOM_EVIDENCE_FUNCTION,
        source,
      });
      if (!Array.isArray(domEvidence?.candidates)) return null;
      const surfaceWords = new Set([
        'field', 'input', 'control', 'button', 'link', 'dropdown', 'selector',
        'select', 'menu', 'calendar', 'picker', 'option', 'textbox', 'combobox',
      ]);
      const words = (value) => String(value == null ? '' : value)
        .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
        .filter((word) => word && !surfaceWords.has(word));
      const wanted = words(controlActionAdapter.targetOf(step));
      if (!wanted.length) return null;
      const acceptedRoles = new Set((ownerRoleHints || []).map(token).filter(Boolean));
      const ranked = domEvidence.candidates
        .filter((candidate) => candidate && candidate.visible !== false && candidate.enabled !== false)
        .filter((candidate) => !acceptedRoles.size || acceptedRoles.has(token(candidate.role)))
        .map((candidate) => {
          const identities = [
            candidate.accessibleName,
            ...(Array.isArray(candidate.associatedLabels) ? candidate.associatedLabels : []),
            candidate.placeholder,
            candidate.nameAttr,
            candidate.id,
            candidate.testid,
          ].filter(Boolean);
          const identityWords = new Set(identities.flatMap(words));
          const matched = wanted.filter((word) => identityWords.has(word)).length;
          const coverage = matched / wanted.length;
          const exact = identities.some((identity) => words(identity).join(' ') === wanted.join(' '));
          const concreteValues = [
            candidate.value,
            candidate.selectedValue,
            candidate.selectedText,
            candidate.checked,
            candidate.ariaChecked,
          ];
          const stateStrength = concreteValues.reduce((total, value) => (
            value !== null && value !== undefined && String(value).trim() !== ''
              ? total + 1
              : total
          ), 0);
          return { candidate, score: exact ? 2 : coverage, stateStrength };
        })
        .filter((entry) => entry.score >= 1)
        .sort((a, b) => b.score - a.score || b.stateStrength - a.stateStrength);
      if (!ranked.length || (ranked[1]
        && ranked[1].score === ranked[0].score
        && ranked[1].stateStrength === ranked[0].stateStrength)) return null;
      const candidate = ranked[0].candidate;
      return {
        found: true,
        visible: candidate.visible !== false,
        enabled: candidate.enabled !== false,
        value: candidate.value ?? null,
        valueAfter: candidate.value ?? null,
        actualValue: candidate.value ?? null,
        inputValue: candidate.value ?? null,
        selectedValue: candidate.selectedValue ?? candidate.value ?? null,
        selectedText: candidate.selectedText ?? null,
        selectedValues: candidate.selectedValue == null ? [] : [candidate.selectedValue],
        selectedTexts: candidate.selectedText == null ? [] : [candidate.selectedText],
        ariaExpanded: candidate.ariaExpanded ?? null,
        expanded: candidate.semanticExpanded ?? null,
        checked: candidate.checked ?? null,
        ariaChecked: candidate.ariaChecked ?? null,
        semanticOwnerEvidence: true,
      };
    };

    const outcome = await universalActionKernel.executeControlAction({
      step,
      plan: planForWait,
      persistedTransaction,
      transactionContext: {
        ...(hooks.transactionContext || {}),
        stepId: step.id || step.stepId || step.contractStepId || actionId || null,
        sequenceIndex: idx,
        actionOccurrenceId: actionId || step.actionOccurrenceId || null,
      },
      persistTransaction: typeof hooks.persistActionTransaction === 'function'
        ? (transaction) => hooks.persistActionTransaction({ idx, step, actionId, transaction })
        : null,
      maxPostconditionObservations: 1,
      maxFreshPostconditionAttempts: 1,
      evidenceAdapter: activeEvidenceAdapter,
      observe: async ({ phase, controlPhase, attempt, retry }) => {
        // Exact owner-state readback is stronger than another accessibility
        // snapshot after a verified action. Some browser transports delay that
        // snapshot even though the acted control is immediately readable.
        let observed = phase === 'postcondition' && primaryRef
          ? {
              snapshotText: '',
              fresh: false,
              source: `universal_${kind}_postcondition_direct_readback`,
              directReadbackFallback: true,
            }
          : await hooks.snapshot({
              source: `universal_${kind}_${phase}_${controlPhase?.id || 'result'}_${attempt}`,
              phase, controlPhase, attempt, retry,
            });
        if (!observed?.snapshotText) {
          // A delivered action can outlive a temporarily unavailable AX snapshot.
          // Preserve the already-authorized owner ref for an exact DOM readback;
          // never redispatch merely because the observation channel is delayed.
          if (phase !== 'postcondition' || !primaryRef) return null;
          observed = {
            ...(observed || {}),
            snapshotText: '',
            fresh: false,
            source: `universal_${kind}_postcondition_direct_readback`,
            directReadbackFallback: true,
          };
        }
        if (!snapshots.beforeOpen) snapshots.beforeOpen = observed.snapshotText;
        if (controlPhase?.id === 'choose-exact-option') snapshots.afterOpen = observed.snapshotText;
        let semantic = {};
        if (String(controlPhase?.semanticTarget?.kind || '').startsWith('calendar_')) {
          semantic = await calendarFacts(observed.snapshotText);
        }

        if (kind === 'scroll' && !beforePage) {
          beforePage = await hooks.evaluate({ function: controlStateProbe.PAGE_STATE_FUNCTION, source: 'control_page_state_before' }) || null;
        }
        if (phase !== 'postcondition') {
          let ownerState = null;
          let dropdownState = null;
          const targetScroll = kind === 'scroll' && planForWait.variant === 'target';
          if (kind !== 'scroll' || targetScroll) {
            const ownerRef = await resolveObservedOwnerRef(observed, 'semantic_control_pre_dispatch');
            if (ownerRef) {
              primaryRef = ownerRef;
              ownerState = await hooks.evaluate({
                function: controlStateProbe.elementStateFunction({ attributeNames: extractAttributeNames(planForWait) }),
                element: controlActionAdapter.targetOf(step),
                target: ownerRef,
                source: 'control_exact_state_before',
              });
              if (kind === 'select') {
                if (reusedVerifiedOwnerBinding) await ensureDropdownTracker(null, ownerRef);
                dropdownState = await captureDropdownState(ownerRef, 'dropdown_transaction_precondition');
              }
            }
          } else {
            ownerState = beforePage;
          }
          return {
            ...observed,
            ...(ownerState
              ? controlStateProbe.buildControlObservation({ kind, before: ownerState, after: ownerState })
              : {}),
            ...(dropdownState ? { dropdownState } : {}),
            fresh: true,
            ...semantic,
          };
        }

        let currentRef = primaryRef;
        if (kind !== 'scroll') {
          const refreshed = await resolveObservedOwnerRef(observed, 'semantic_control_postcondition');
          if (refreshed) currentRef = refreshed;
        }
        const readAfter = async () => {
          if (!currentRef) {
            return kind === 'scroll'
              ? hooks.evaluate({ function: controlStateProbe.PAGE_STATE_FUNCTION, source: 'control_page_state_after' })
              : captureSemanticOwnerState('control_semantic_state_after');
          }
          const exact = await hooks.evaluate({
            function: controlStateProbe.elementStateFunction({ attributeNames: extractAttributeNames(planForWait) }),
            element: controlActionAdapter.targetOf(step), target: currentRef, source: 'control_exact_state_after',
          });
          return exact && exact.found !== false
            ? exact
            : captureSemanticOwnerState('control_semantic_state_after');
        };
        const timeoutMs = Math.max(500, Number(planForWait.waitContract?.timeoutMs) || 10_000);
        const pollIntervalMs = Math.max(1, Number(planForWait.waitContract?.pollIntervalMs) || 250);
        const stableRequired = Math.max(2, Number(planForWait.waitContract?.stableObservations) || 2);
        const startedAt = typeof hooks.now === 'function' ? hooks.now() : Date.now();
        let after = null;
        let previousKey = null;
        let stable = 0;
        let pollCount = 0;
        let matchedDuringPoll = false;
        const maxPolls = Math.max(stableRequired, Math.ceil(timeoutMs / pollIntervalMs) + 1);
        do {
          pollCount += 1;
          after = await readAfter();
          const key = after && typeof after === 'object' ? JSON.stringify(after) : null;
          stable = key && key === previousKey ? stable + 1 : (key ? 1 : 0);
          previousKey = key;
          const candidateObservation = {
            ...observed,
            ...controlStateProbe.buildControlObservation({ kind, before: beforePage, after, dispatchResult: lastDispatchState }),
            fresh: true,
            snapshotBeforeOpen: snapshots.beforeOpen,
            snapshotAfterOpen: snapshots.afterOpen,
            snapshotAfterSelect: observed.snapshotText,
            snapshotAfter: observed.snapshotText,
          };
          const candidateProof = controlActionAdapter.proveControlAction(planForWait, candidateObservation);
          if (candidateProof.matched === true) {
            matchedDuringPoll = true;
            break;
          }
          const now = typeof hooks.now === 'function' ? hooks.now() : Date.now();
          if (now - startedAt >= timeoutMs || pollCount >= maxPolls) break;
          if (typeof hooks.sleep === 'function') await hooks.sleep(pollIntervalMs);
          else await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        } while ((typeof hooks.now === 'function' ? hooks.now() : Date.now()) - startedAt <= timeoutMs);
        if (!after || (!matchedDuringPoll && stable < stableRequired && pollCount < maxPolls)) return null;
        snapshots.afterSelect = observed.snapshotText;
        let dropdownState = kind === 'select' && currentRef
          ? await captureDropdownState(currentRef, 'dropdown_transaction_postcondition')
          : null;
        if (dropdownState && after && typeof after === 'object') {
          const exactReadback = {};
          const selectedValue = after.selectedValue ?? after.selectedLabel;
          const displayedValue = after.selectedText ?? after.displayedValue ?? after.renderedValue;
          const value = after.value ?? after.actualValue ?? after.valueAfter;
          if (selectedValue != null && String(selectedValue).trim() !== '') exactReadback.selectedValue = selectedValue;
          if (displayedValue != null && String(displayedValue).trim() !== '') exactReadback.displayedValue = displayedValue;
          if (value != null && String(value).trim() !== '') exactReadback.value = value;
          dropdownState = {
            ...dropdownState,
            owner: { ...(dropdownState.owner || {}), ...exactReadback },
            valueNode: { ...(dropdownState.valueNode || dropdownState.owner || {}), ...exactReadback },
          };
        }
        return {
          ...observed,
          ...controlStateProbe.buildControlObservation({ kind, before: beforePage, after, dispatchResult: lastDispatchState }),
          ...(dropdownState ? { dropdownState } : {}),
          fresh: true,
          snapshotBeforeOpen: snapshots.beforeOpen,
          snapshotAfterOpen: snapshots.afterOpen,
          snapshotAfterSelect: snapshots.afterSelect,
          snapshotAfter: observed.snapshotText,
        };
      },
      resolve: async ({ plan, phase, snapshotText, observation, completedPhaseIds = [] }) => {
        if (String(phase.semanticTarget?.kind || '').startsWith('calendar_')) {
          return controlActionAdapter.resolvePhaseTarget({
            plan, phaseId: phase.id, snapshotText,
            semanticCandidates: observation.semanticCandidates || [],
            calendarState: observation.calendarState || null,
          });
        }
        if (kind === 'select' && dropdownPhaseKind(phase) === 'open' && dropdownIsProvenOpen()) {
          return {
            ok: true,
            ref: dropdownOwnerRef,
            candidateCount: 1,
            confidenceMargin: 1,
            phaseAlreadySatisfied: true,
            fulfilledBy: 'fresh_owner_scoped_popup_open_proof',
          };
        }
        const semanticTarget = phase.semanticTarget && typeof phase.semanticTarget === 'object'
          ? { ...phase.semanticTarget }
          : null;
        const roleHints = Array.isArray(phase.resolution?.roleHints)
          ? [...phase.resolution.roleHints]
          : [];
        const ownerScope = phase.resolution?.scope && typeof phase.resolution.scope === 'object'
          ? { ...phase.resolution.scope }
          : null;
        const ownerInteractionConfirmed = !!ownerScope?.openedByPhase
          && completedPhaseIds.includes(ownerScope.openedByPhase);
        const phaseLabel = token(semanticTarget?.kind) === 'option' && semanticTarget.name
          ? semanticTarget.name
          : phase.resolution?.label;
        const phaseStep = {
          ...step,
          target: phaseLabel,
          element: phaseLabel,
          targetRole: roleHints[0] || step.targetRole || step.role || null,
          targetRoleHints: roleHints,
          targetScope: ownerScope,
          semanticTarget,
          ownerInteractionConfirmed,
          contextTokens: ownerScope?.ownerTarget
            ? [ownerScope.ownerTarget]
            : (step.contextTokens || step.targetContextTokens || null),
        };
        let hookRef = await hooks.resolveRef({
          step: phaseStep,
          toolName: phase.resolutionToolName,
          snapshotText,
          phase,
        });
        let utilityHookRef = phase.allowUtilityDispatch === true && hookRef ? hookRef : null;
        const semanticContract = {
          label: phaseLabel,
          roleHints,
          ownerScope,
          semanticTarget,
          phaseId: phase.id,
          snapshotBefore: snapshots.beforeOpen,
          ownerInteractionConfirmed,
        };
        const resolveWithDomEvidence = async (currentSnapshotText) => {
          let resolved = actionLocatorResolver.resolveSemanticActionTarget(
            currentSnapshotText,
            semanticContract,
          );
          if (resolved?.ok !== true && !utilityHookRef) {
            const domEvidence = await hooks.evaluate({
              function: actionLocatorResolver.SEMANTIC_CONTROL_DOM_EVIDENCE_FUNCTION,
              source: 'semantic_control_dom_evidence',
            });
            if (Array.isArray(domEvidence?.candidates)) {
              resolved = actionLocatorResolver.resolveSemanticActionTarget(currentSnapshotText, {
                ...semanticContract,
                domEvidence,
              });
            }
          }
          return resolved;
        };
        let resolutionSnapshotText = snapshotText;
        let semanticResolution = await resolveWithDomEvidence(resolutionSnapshotText);
        let revealedRuntimeRef = null;
        const ownerScopedOption = token(semanticTarget?.kind) === 'option' && !!ownerScope?.ownerTarget;
        let temporalOptionRevealAttempted = false;
        if (
          semanticResolution?.ok !== true
          && semanticResolution?.ambiguous !== true
          && Number(semanticResolution?.candidateCount || 0) === 0
          && ownerScopedOption
          && ownerInteractionConfirmed
          && ['time', 'timezone'].includes(temporalIntent)
          && dropdownOwnerRef
        ) {
          temporalOptionRevealAttempted = true;
          const revealPositions = temporalIntent === 'time'
            ? [0, -0.04, 0.04, -0.08, 0.08]
            : [0, 0.25, 0.5, 0.75, 1];
          for (let revealIndex = 0; revealIndex < revealPositions.length; revealIndex += 1) {
            const revealFunction = temporalIntent === 'time'
              ? buildVirtualizedTimeOptionRevealFunction(semanticTarget.name, revealPositions[revealIndex])
              : buildVirtualizedOptionRevealFunction(revealPositions[revealIndex]);
            if (!revealFunction) break;
            const reveal = await hooks.evaluate({
              function: revealFunction,
              element: ownerScope.ownerTarget,
              target: dropdownOwnerRef,
              source: `virtualized_${temporalIntent}_option_reveal_${revealIndex + 1}`,
            });
            if (reveal?.ok !== true) break;
            if (typeof hooks.sleep === 'function') await hooks.sleep(150);
            else await new Promise((resolve) => setTimeout(resolve, 150));
            const refreshed = await hooks.snapshot({
              source: `virtualized_${temporalIntent}_option_revealed_${revealIndex + 1}`,
              phase: 'target_reveal',
              controlPhase: phase,
              poll: revealIndex,
            });
            if (!refreshed?.snapshotText) continue;
            resolutionSnapshotText = refreshed.snapshotText;
            semanticResolution = await resolveWithDomEvidence(resolutionSnapshotText);
            if (semanticResolution?.ok === true || semanticResolution?.ambiguous === true) break;
          }
        }
        if (
          semanticResolution?.ok !== true
          && semanticResolution?.ambiguous === true
          && ownerScopedOption
          && token(semanticTarget?.match) === 'contains'
          && Array.isArray(semanticResolution?.candidates)
          && semanticResolution.candidates.length > 0
        ) {
          const firstVisibleMatch = semanticResolution.candidates.find((candidate) => (
            candidate?.ref && candidate?.visible !== false && candidate?.enabled !== false
          ));
          if (firstVisibleMatch) {
            semanticResolution = {
              ...semanticResolution,
              ok: true,
              ambiguous: false,
              unique: true,
              candidateCount: 1,
              candidates: [firstVisibleMatch],
              confidenceMargin: 1,
              ref: firstVisibleMatch.ref,
              resolvedCandidate: firstVisibleMatch,
              code: 'deterministic_owner_scoped_contains_match',
              fulfilledBy: 'first_visible_owner_scoped_contains_match',
            };
          }
        }
        if (
          semanticResolution?.ok !== true
          && !utilityHookRef
          && semanticResolution?.ambiguous !== true
          && Number(semanticResolution?.candidateCount || 0) === 0
          && semanticTarget?.optionalAssist !== true
          && typeof hooks.revealTarget === 'function'
          && !revealedPhaseIds.has(phase.id)
        ) {
          revealedPhaseIds.add(phase.id);
          const reveal = await hooks.revealTarget({
            step: phaseStep,
            plan,
            phase,
            label: phaseLabel,
            roleHints,
            semanticTarget,
          });
          if (reveal?.ok === true && reveal?.visible === true) {
            const releaseRuntimeBinding = async () => {
              if (!reveal.runtimeBinding || typeof hooks.releaseRevealedTarget !== 'function') {
                return { ok: true, skipped: true };
              }
              return hooks.releaseRevealedTarget({
                runtimeBinding: reveal.runtimeBinding,
                step: phaseStep,
                plan,
                phase,
              });
            };
            if (kind === 'scroll' && phase.id === 'scroll-target-into-view') {
              const released = await releaseRuntimeBinding();
              if (released?.ok !== true) {
                return {
                  ok: false,
                  ref: null,
                  code: 'revealed_target_release_failed',
                  candidateCount: 0,
                };
              }
              return {
                ok: true,
                ref: null,
                candidateCount: Number(reveal.candidateCount || 1),
                confidenceMargin: Number(reveal.confidenceMargin || 1),
                phaseAlreadySatisfied: true,
                resolutionNotRequired: true,
                fulfilledBy: 'deterministic_semantic_target_reveal',
                reveal,
              };
            }
            const refreshed = await hooks.snapshot({
              source: `universal_${kind}_target_revealed_${phase.id}`,
              phase: 'target_reveal',
              controlPhase: phase,
            });
            if (refreshed?.snapshotText) {
              resolutionSnapshotText = refreshed.snapshotText;
              hookRef = await hooks.resolveRef({
                step: phaseStep,
                toolName: phase.resolutionToolName,
                snapshotText: resolutionSnapshotText,
                phase,
              });
              revealedRuntimeRef = hookRef || null;
              utilityHookRef = phase.allowUtilityDispatch === true && hookRef ? hookRef : null;
              semanticResolution = await resolveWithDomEvidence(resolutionSnapshotText);
            }
            const released = await releaseRuntimeBinding();
            if (released?.ok !== true) {
              semanticResolution = {
                ok: false,
                ref: null,
                code: 'revealed_target_release_failed',
                candidateCount: 0,
              };
            } else if (semanticResolution?.ok !== true && revealedRuntimeRef) {
              // The unique browser-side reveal already proved identity and the
              // refreshed snapshot bound that node to a live ref. Keep that
              // verified handoff instead of asking a second resolver to
              // rediscover the control after the temporary alias is removed.
              semanticResolution = {
                ok: true,
                ref: revealedRuntimeRef,
                code: 'runtime_bound_semantic_target',
                candidateCount: 1,
                confidenceMargin: Number(reveal.confidenceMargin || 1),
                fulfilledBy: 'runtime_bound_semantic_reveal',
                resolvedCandidate: {
                  ref: revealedRuntimeRef,
                  role: reveal.role || roleHints[0] || null,
                  name: phaseLabel,
                  label: phaseLabel,
                  source: 'runtime_bound_semantic_reveal',
                },
              };
            }
          }
        }
        if (
          semanticResolution?.ok !== true
          && !utilityHookRef
          && semanticResolution?.ambiguous !== true
          && Number(semanticResolution?.candidateCount || 0) === 0
          && semanticTarget?.optionalAssist !== true
        ) {
          const targetWaitMs = temporalOptionRevealAttempted
            ? 1_200
            : Math.min(5_000, Math.max(500, Number(plan.waitContract?.timeoutMs) || 5_000));
          const pollIntervalMs = Math.min(500, Math.max(100, Number(plan.waitContract?.pollIntervalMs) || 250));
          const maxPolls = Math.max(1, Math.ceil(targetWaitMs / pollIntervalMs));
          for (let poll = 0; poll < maxPolls; poll += 1) {
            if (typeof hooks.sleep === 'function') await hooks.sleep(pollIntervalMs);
            else await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
            const refreshed = await hooks.snapshot({
              source: `universal_${kind}_target_wait_${phase.id}_${poll + 1}`,
              phase: 'target_wait',
              controlPhase: phase,
              poll,
            });
            if (!refreshed?.snapshotText) continue;
            resolutionSnapshotText = refreshed.snapshotText;
            hookRef = await hooks.resolveRef({
              step: phaseStep,
              toolName: phase.resolutionToolName,
              snapshotText: resolutionSnapshotText,
              phase,
            });
            utilityHookRef = phase.allowUtilityDispatch === true && hookRef ? hookRef : null;
            semanticResolution = await resolveWithDomEvidence(resolutionSnapshotText);
            if (semanticResolution?.ok === true || utilityHookRef || semanticResolution?.ambiguous === true) break;
          }
        }
        if (semanticTarget?.optionalAssist === true && semanticResolution?.ok !== true) {
          semanticResolution = {
            ok: true,
            ref: null,
            code: 'optional_semantic_assist_unavailable',
            candidateCount: 0,
            phaseAlreadySatisfied: true,
            fulfilledBy: 'optional_assist_skipped',
          };
        }
        let ownerTypeaheadFallback = null;
        if (
          semanticResolution?.ok !== true
          && semanticResolution?.ambiguous !== true
          && Number(semanticResolution?.candidateCount || 0) === 0
          && ownerScopedOption
          && ownerInteractionConfirmed
        ) {
          const ownerLabel = ownerScope.ownerTarget;
          const ownerResolution = actionLocatorResolver.resolveSemanticActionTarget(resolutionSnapshotText, {
            label: ownerLabel,
            roleHints: ['combobox', 'textbox', 'searchbox', 'spinbutton'],
            requireRef: true,
            ownerScope: null,
            semanticTarget: {
              kind: 'control_opener',
              controlKind: 'choice',
              ownerTarget: ownerLabel,
            },
            phaseId: `${phase.id}-owner-typeahead`,
          });
          const ownerCandidate = ownerResolution?.resolvedCandidate
            || ownerResolution?.semanticResolution?.candidate
            || ownerResolution?.candidate
            || null;
          const ownerRole = token(ownerCandidate?.role || ownerResolution?.role);
          const ownerFacts = ownerResolution?.ok === true && ownerResolution.ref
            ? await hooks.evaluate({
                function: CONTROL_KIND_PROBE_FUNCTION,
                element: ownerLabel,
                target: ownerResolution.ref,
                source: 'owner_typeahead_editability_probe',
              })
            : null;
          const editableOwner = ownerFacts?.found === true
            && ownerFacts.disabled !== true
            && ownerFacts.readOnly !== true
            && (
              ['input', 'textarea'].includes(token(ownerFacts.tagName))
              || ownerFacts.contentEditable === true
            );
          if (ownerResolution?.ok === true
            && ownerResolution.ref
            && editableOwner
            && ['combobox', 'textbox', 'searchbox', 'spinbutton'].includes(ownerRole)) {
            ownerTypeaheadFallback = {
              ownerRef: ownerResolution.ref,
              ownerLabel,
              value: semanticTarget.name,
              match: semanticTarget.match || 'exact',
              role: ownerRole,
            };
          }
        }
        const resolution = semanticResolution?.ok === true
          ? semanticResolution
          : utilityHookRef
            ? {
                ok: true,
                ref: utilityHookRef,
                candidateCount: 1,
                confidenceMargin: 1,
                fulfilledBy: 'fresh_verified_utility_ref',
              }
          : ownerTypeaheadFallback
            ? {
                ok: true,
                ref: ownerTypeaheadFallback.ownerRef,
                candidateCount: 1,
                confidenceMargin: 1,
                fulfilledBy: 'scoped_owner_typeahead',
                typeaheadFallback: ownerTypeaheadFallback,
              }
          : semanticResolution?.ambiguous === true || ownerScopedOption
            ? semanticResolution
            : semanticResolution;
        const ref = resolution?.ok === true ? resolution.ref : null;
        if (temporalTracker) {
          temporalTracker.recordResolution(phase.id, resolution);
          const semanticKind = token(semanticTarget?.kind);
          if (ref && !['option', 'calendarposition', 'calendarday'].includes(semanticKind)) {
            const validation = acceptTemporalControl(resolution);
            if (validation && validation.ok !== true) {
              return {
                ok: false,
                code: validation.code,
                candidateCount: 0,
                temporalValidation: validation,
              };
            }
          }
        }
        if (kind === 'select' && ref && token(semanticTarget?.kind) !== 'option') {
          await ensureDropdownTracker(resolution, ref);
          if (temporalControlFailure) {
            return {
              ok: false,
              code: temporalControlFailure.code,
              candidateCount: 0,
              temporalValidation: temporalControlFailure,
            };
          }
          if (dropdownPhaseKind(phase) === 'open' && dropdownIsProvenOpen()) {
            return {
              ...resolution,
              ref,
              phaseAlreadySatisfied: true,
              fulfilledBy: 'fresh_owner_scoped_popup_open_proof',
            };
          }
        }
        if (kind === 'select' && ref && token(semanticTarget?.kind) === 'option' && dropdownTracker) {
          const openState = await captureDropdownState(
            dropdownOwnerRef,
            'dropdown_transaction_before_option_dispatch',
          );
          const openProof = openState ? dropdownTracker.proveOpened(openState) : null;
          if (openProof?.matched !== true && ownerInteractionConfirmed) {
            dropdownTracker.acceptOpenedEvidence({
              reason: 'owner_scoped_option_resolved',
              optionRef: ref,
              ownerRef: dropdownOwnerRef,
              visibleOptions: openState?.visibleOptions || [],
              popup: openState?.popups?.length === 1 ? openState.popups[0] : null,
            });
          }
        }
        if (
          ref
          && semanticTarget?.optionalAssist === true
          && primaryRef
          && ref === primaryRef
          && completedPhaseIds.length > 0
        ) {
          return {
            ...resolution,
            phaseAlreadySatisfied: true,
            fulfilledBy: 'owner_dispatch_already_used_associated_trigger',
          };
        }
        if (ref && phase.branch) {
          const facts = await hooks.evaluate({
            function: CONTROL_KIND_PROBE_FUNCTION,
            element: phase.resolution?.label,
            target: ref,
            source: 'control_dispatch_branch_probe',
          });
          if (facts?.found === true && !branchAcceptsControl(phase.branch, facts)) {
            return {
              ok: false,
              inapplicable: true,
              code: 'target_kind_mismatch',
              candidateCount: 0,
              facts,
            };
          }
        }
        if (ref && !primaryRef && phase.resolution?.label === plan.target) primaryRef = ref;
        return ref || (resolution?.ok === true && resolution?.phaseAlreadySatisfied === true)
          ? resolution
          : {
              ok: false,
              code: resolution?.code || 'unique_live_target_not_proven',
              ambiguous: resolution?.ambiguous === true,
              unique: resolution?.unique,
              candidateCount: Number.isFinite(Number(resolution?.candidateCount))
                ? Number(resolution.candidateCount)
                : 0,
              confidenceMargin: resolution?.confidenceMargin,
              candidates: resolution?.candidates || [],
            };
      },
      dispatch: async ({ plan, phase, rawPhase, resolution, attempt, retry }) => {
        const dispatchPhase = rawPhase || phase || {};
        const dispatchesOwner = token(dispatchPhase?.semanticTarget?.kind) !== 'option';
        if (dispatchesOwner && !primaryRef) {
          primaryRef = exactSnapshotRef(resolution?.ref)
            || dispatchedControlRef(null, phase)
            || null;
        }
        if (resolution?.typeaheadFallback) {
          const fallback = resolution.typeaheadFallback;
          const exactOptionContract = {
            label: fallback.value,
            roleHints: ['option', 'menuitemradio', 'menuitemcheckbox', 'treeitem'],
            ownerScope: { ownerTarget: fallback.ownerLabel },
            semanticTarget: { kind: 'option', name: fallback.value, match: fallback.match || 'exact' },
            phaseId: `${rawPhase.id}-typeahead-exact-option`,
            ownerInteractionConfirmed: true,
          };
          const waitForExactOption = async (source, maxAttempts = 8) => {
            for (let poll = 0; poll < maxAttempts; poll += 1) {
              const refreshed = await hooks.snapshot({
                source,
                phase: 'after_owner_typeahead',
                poll,
              });
              const exactOption = actionLocatorResolver.resolveSemanticActionTarget(
                refreshed?.snapshotText || '',
                exactOptionContract,
              );
              if (exactOption?.ok === true && exactOption.ref) return exactOption;
              if (poll + 1 < maxAttempts) {
                if (typeof hooks.sleep === 'function') await hooks.sleep(300);
                else await new Promise((resolve) => setTimeout(resolve, 300));
              }
            }
            return null;
          };
          const clickExactOption = async (exactOption) => {
            const clickPhase = controlActionAdapter.bindResolvedTarget({
              ...rawPhase,
              id: `${rawPhase.id}-typeahead-exact-option`,
              toolName: 'browser_click',
              resolutionToolName: 'browser_click',
              args: { element: fallback.value, target: null },
            }, exactOption.ref);
            beforeDropdownDispatch(clickPhase, exactOption);
            if (temporalTracker) temporalTracker.beforeDispatch(clickPhase.id, exactOption);
            const dispatched = await hooks.dispatch({
              step, plan, phase: clickPhase, rawPhase, resolution: exactOption, attempt, retry,
              semanticOperation: { kind: 'owner_typeahead_exact_option_click', value: fallback.value },
            });
            await afterDropdownDispatch(clickPhase, dispatched);
            if (temporalTracker) temporalTracker.afterDispatch(clickPhase.id, dispatched);
            return dispatched;
          };

          // A preceding authored Fill commonly opened this suggestion list.
          // Preserve that query and allow its exact option to arrive before
          // replacing the field value with a fallback search.
          let exactOption = await waitForExactOption('owner_typeahead_existing_query');
          if (exactOption) return clickExactOption(exactOption);

          const selectExistingPhase = controlActionAdapter.bindResolvedTarget({
            ...rawPhase,
            id: `${rawPhase.id}-typeahead-select-existing`,
            toolName: 'browser_press_key',
            resolutionToolName: 'browser_click',
            args: { element: fallback.ownerLabel, target: null, key: 'Control+A' },
          }, fallback.ownerRef);
          const selectedExisting = await hooks.dispatch({
            step, plan, phase: selectExistingPhase, rawPhase, resolution, attempt, retry,
            semanticOperation: { kind: 'owner_typeahead_select_existing', value: fallback.value },
          });
          const selectSucceeded = selectedExisting?.ok === true
            || selectedExisting?.isError === false
            || selectedExisting?.result?.isError === false;
          if (!selectSucceeded) return selectedExisting;
          const typePhase = controlActionAdapter.bindResolvedTarget({
            ...rawPhase,
            id: `${rawPhase.id}-typeahead-value`,
            toolName: 'browser_type',
            resolutionToolName: 'browser_type',
            args: { element: fallback.ownerLabel, target: null, text: fallback.value, slowly: true },
          }, fallback.ownerRef);
          const typed = await hooks.dispatch({
            step, plan, phase: typePhase, rawPhase, resolution, attempt, retry,
            semanticOperation: { kind: 'owner_typeahead_fill', value: fallback.value },
          });
          const typeSucceeded = typed?.ok === true || typed?.isError === false || typed?.result?.isError === false;
          if (!typeSucceeded) return typed;
          exactOption = await waitForExactOption('owner_typeahead_exact_option', 12);
          if (exactOption) return clickExactOption(exactOption);
          const reselectUncommittedPhase = controlActionAdapter.bindResolvedTarget({
            ...rawPhase,
            id: `${rawPhase.id}-typeahead-cleanup-select`,
            toolName: 'browser_press_key',
            resolutionToolName: 'browser_click',
            args: { element: fallback.ownerLabel, target: null, key: 'Control+A' },
          }, fallback.ownerRef);
          await hooks.dispatch({
            step, plan, phase: reselectUncommittedPhase, rawPhase, resolution, attempt, retry,
            semanticOperation: { kind: 'owner_typeahead_cleanup_select', value: fallback.value },
          });
          const clearUncommittedPhase = controlActionAdapter.bindResolvedTarget({
            ...rawPhase,
            id: `${rawPhase.id}-typeahead-cleanup-clear`,
            toolName: 'browser_press_key',
            resolutionToolName: 'browser_click',
            args: { element: fallback.ownerLabel, target: null, key: 'Backspace' },
          }, fallback.ownerRef);
          await hooks.dispatch({
            step, plan, phase: clearUncommittedPhase, rawPhase, resolution, attempt, retry,
            semanticOperation: { kind: 'owner_typeahead_cleanup_clear', value: fallback.value },
          });
          return {
            ok: false,
            isError: true,
            reason: 'exact_option_not_observed_after_typeahead',
            code: 'exact_option_not_observed_after_typeahead',
          };
        }
        const semantic = resolution?.semanticResolution || resolution;
        if (semantic?.alreadySatisfied === true || semantic?.phaseAlreadySatisfied === true) {
          return { ok: true, semanticAlreadySatisfied: true, toolName: 'generic_transition_already_satisfied' };
        }
        if (Array.isArray(semantic?.operations) && semantic.operations.length) {
          let final = { ok: true };
          const semanticOperationTrace = [];
          let currentSemantic = semantic;
          const calendarPositionPhase = token(dispatchPhase?.semanticTarget?.kind) === 'calendarposition';
          const targetDateParts = dispatchPhase?.semanticTarget?.dateParts || null;
          const targetMonthIndex = Number.isInteger(Number(targetDateParts?.year))
            && Number.isInteger(Number(targetDateParts?.month))
            ? Number(targetDateParts.year) * 12 + Number(targetDateParts.month) - 1
            : null;
          const waitForCalendarAdvance = async (previousDelta) => {
            if (!calendarPositionPhase || targetMonthIndex == null) return null;
            const numericDelta = Number(previousDelta);
            const previousMonthIndex = Number.isFinite(numericDelta)
              ? targetMonthIndex - numericDelta
              : null;
            for (let poll = 0; poll < 12; poll += 1) {
              const refreshed = await hooks.snapshot({
                source: 'semantic_calendar_state_settle',
                phase: 'post_dispatch',
                controlPhase: rawPhase,
                attempt,
                retry,
                poll,
              });
              if (refreshed?.snapshotText) {
                const facts = await calendarFacts(refreshed.snapshotText);
                const year = Number(facts.calendarState?.year);
                const month = Number(facts.calendarState?.month);
                const monthIndex = Number.isInteger(year) && Number.isInteger(month) && month >= 1 && month <= 12
                  ? year * 12 + month - 1
                  : null;
                if (monthIndex != null && (previousMonthIndex == null || monthIndex !== previousMonthIndex)) {
                  return { refreshed, facts };
                }
              }
              if (poll < 11) {
                if (typeof hooks.sleep === 'function') await hooks.sleep(150);
                else await new Promise((resolve) => setTimeout(resolve, 150));
              }
            }
            return null;
          };
          for (const operation of semantic.operations) {
            let repeat = Math.max(1, Math.min(240, Number(operation.repeat) || 1));
            let candidate = operation.candidate;
            while (repeat-- > 0) {
              if (!candidate?.ref) return { ok: false, reason: 'semantic_control_ref_unavailable' };
              const bound = controlActionAdapter.bindResolvedTarget(
                { ...rawPhase, args: { ...(rawPhase.args || {}), element: candidate.name || rawPhase.args?.element || plan.target } },
                candidate.ref,
              );
              if (temporalTracker) temporalTracker.beforeDispatch(rawPhase.id, { operation, candidate });
              final = await hooks.dispatch({ step, plan, phase: bound, rawPhase, resolution, attempt, retry, semanticOperation: operation });
              semanticOperationTrace.push({
                kind: operation.kind || null,
                candidate: {
                  ref: candidate.ref || null,
                  role: candidate.role || null,
                  name: candidate.name || candidate.label || null,
                  dateParts: candidate.dateParts || null,
                  currentMonth: candidate.currentMonth === true,
                  hitTarget: candidate.hitTarget === true,
                },
                ok: final?.ok === true || final?.isError === false || final?.result?.isError === false,
                reason: final?.reason || final?.error || null,
              });
              if (temporalTracker) temporalTracker.afterDispatch(rawPhase.id, final);
              if (final?.ok !== true && final?.isError !== false && final?.result?.isError !== false) return final;
              const settledCalendar = operation.kind === 'navigate_month'
                ? await waitForCalendarAdvance(currentSemantic?.deltaMonths)
                : null;
              if (repeat > 0) {
                const refreshed = settledCalendar?.refreshed
                  || await hooks.snapshot({ source: 'semantic_calendar_repeat_refresh', phase: 'pre_dispatch', controlPhase: rawPhase, attempt, retry });
                if (!refreshed?.snapshotText) return { ok: false, reason: 'semantic_calendar_refresh_unavailable' };
                const facts = settledCalendar?.facts || await calendarFacts(refreshed.snapshotText);
                const next = await controlActionAdapter.resolvePhaseTarget({
                  plan, phaseId: rawPhase.id, snapshotText: refreshed.snapshotText,
                  semanticCandidates: facts.semanticCandidates, calendarState: facts.calendarState,
                });
                if (next?.semanticResolution?.alreadySatisfied === true) break;
                currentSemantic = next?.semanticResolution || currentSemantic;
                candidate = next?.semanticResolution?.operations?.[0]?.candidate || next?.resolvedCandidate || null;
              }
            }
          }
          return { ...final, qaaiSemanticOperations: semanticOperationTrace };
        }
        const semanticCandidate = semantic?.candidate || resolution?.resolvedCandidate || null;
        if (
          semanticCandidate?.ref
          && token(dispatchPhase?.semanticTarget?.kind) === 'calendarday'
        ) {
          const semanticOperation = {
            kind: token(dispatchPhase?.semanticTarget?.kind) || 'semantic_target',
            candidate: semanticCandidate,
          };
          const bound = controlActionAdapter.bindResolvedTarget(
            {
              ...dispatchPhase,
              args: {
                ...(dispatchPhase.args || {}),
                element: semanticCandidate.name || semanticCandidate.label
                  || dispatchPhase.args?.element || plan.target,
              },
            },
            semanticCandidate.ref,
          );
          if (temporalTracker) temporalTracker.beforeDispatch(dispatchPhase.id, semanticOperation);
          const dispatched = await hooks.dispatch({
            step,
            plan,
            phase: bound,
            rawPhase,
            resolution,
            attempt,
            retry,
            semanticOperation,
          });
          if (temporalTracker) temporalTracker.afterDispatch(dispatchPhase.id, dispatched);
          return {
            ...dispatched,
            qaaiSemanticOperations: [{
              kind: semanticOperation.kind,
              candidate: {
                ref: semanticCandidate.ref,
                role: semanticCandidate.role || null,
                name: semanticCandidate.name || semanticCandidate.label || null,
                dateParts: semanticCandidate.dateParts || null,
                currentMonth: semanticCandidate.currentMonth === true,
                hitTarget: semanticCandidate.hitTarget === true,
              },
              ok: dispatched?.ok === true
                || dispatched?.isError === false
                || dispatched?.result?.isError === false,
              reason: dispatched?.reason || dispatched?.error || null,
            }],
          };
        }
        beforeDropdownDispatch(rawPhase || phase, resolution);
        if (temporalTracker) temporalTracker.beforeDispatch((rawPhase || phase).id, resolution);
        const dispatched = await hooks.dispatch({ step, plan, phase, rawPhase, resolution, attempt, retry });
        if (dispatchesOwner && !primaryRef) {
          primaryRef = dispatchedControlRef(dispatched, phase);
        }
        const ownerDispatchDelivered = dispatched?.ok === true
          || dispatched?.isError === false
          || dispatched?.result?.isError === false;
        if (
          ownerDispatchDelivered
          && planForWait?.metadata?.semanticControlOpener === true
          && primaryRef
          && controlBindingKey
        ) {
          verifiedControlOwners.set(controlBindingKey, {
            ref: primaryRef,
            target: controlActionAdapter.targetOf(step),
            sequenceIndex: idx,
          });
        }
        await afterDropdownDispatch(rawPhase || phase, dispatched);
        if (temporalTracker) temporalTracker.afterDispatch((rawPhase || phase).id, dispatched);
        lastDispatchState = dispatched?.parsed || dispatched?.state || null;
        return dispatched;
      },
      prove: ({ plan, observation }) => {
        let dropdownProof = null;
        if (plan?.kind === 'select' && dropdownTracker && observation?.dropdownState) {
          dropdownProof = dropdownTracker.proveCommitted(observation.dropdownState);
        }
        if (temporalTracker) {
          const temporalProof = temporalTracker.proveCommitted(observation?.dropdownState || observation);
          if (temporalProof.checked === true) {
            return {
              kind: `${temporalTracker.intentKind}_exact`,
              ...temporalProof,
              status: temporalProof.matched === true ? 'pass' : 'fail',
            };
          }
        }
        if (dropdownProof?.checked === true && dropdownProof.matched !== true) {
          return {
            kind: plan.postcondition?.kind || 'selection_exact',
            ...dropdownProof,
            status: 'fail',
          };
        }
        if (dropdownProof?.checked === true) {
          return {
            kind: plan.postcondition?.kind || 'selection_exact',
            ...dropdownProof,
            status: dropdownProof.matched === true ? 'pass' : 'fail',
          };
        }
        return plan?.metadata?.semanticControlOpener === true
          ? actionLocatorResolver.proveSemanticControlOpen(plan, observation)
          : controlActionAdapter.proveControlAction(plan, observation);
      },
      seal: (payload) => hooks.seal({ idx, step, actionId, payload }),
    });
    if (dropdownTracker && outcome?.diagnostics) {
      outcome.diagnostics.dropdownTransaction = dropdownTracker.snapshot();
    }
    if (temporalTracker && outcome?.diagnostics) {
      outcome.diagnostics.temporalTransaction = temporalTracker.snapshot();
    }
    if (
      outcome?.status === 'pass'
      && planForWait?.metadata?.semanticControlOpener === true
      && primaryRef
      && controlBindingKey
    ) {
      verifiedControlOwners.set(controlBindingKey, {
        ref: primaryRef,
        target: controlActionAdapter.targetOf(step),
        sequenceIndex: idx,
      });
    } else if (outcome?.status === 'pass' && ['select', 'date'].includes(kind) && controlBindingKey) {
      verifiedControlOwners.delete(controlBindingKey);
    }
    return { handled: true, terminal: outcome.terminal === true, reason: outcome.reason, outcome };
  }

  function waitAssertionFor(step, contract) {
    const effect = token(contract?.expected?.effect);
    const typeByEffect = {
      visible: 'VISIBLE', hidden: 'HIDDEN', selected: 'SELECTED', checked: 'CHECKED',
      value: 'VALUE', valueexact: 'VALUE', valuechange: 'VALUE', enabled: 'ATTRIBUTE',
    };
    const type = typeByEffect[effect];
    const target = controlActionAdapter.targetOf(step);
    if (!type || !target) return null;
    const payload = {
      target: { label: target, name: target },
      expected: contract?.expected?.value ?? contract?.expected?.checked ?? true,
    };
    if (effect === 'enabled') {
      payload.attribute = 'disabled';
      payload.expected = false;
    }
    return { type, payload };
  }

  async function runWait({ step, idx, actionId }) {
    const contract = waitContract.buildWaitContract(step);
    const typedWaitAssertion = waitAssertionFor(step, contract);
    const outcome = await universalActionKernel.executeWaitForState({
      step,
      waitContract: contract,
      now: typeof hooks.now === 'function' ? hooks.now : Date.now,
      sleep: typeof hooks.sleep === 'function' ? hooks.sleep : undefined,
      observeWait: async ({ phase }) => {
        if (typedWaitAssertion && typeof hooks.readAssertion === 'function') {
          const observed = await hooks.readAssertion({ step, assertion: typedWaitAssertion, requireFresh: true });
          if (!observed?.fresh) return null;
          if (observed.uncheckable === true) return { fresh: true, matched: false, reason: observed.reason };
          const actual = Object.prototype.hasOwnProperty.call(observed, 'actual') ? observed.actual : observed;
          const comparison = typedAssertionComparator.compareTypedAssertion(typedWaitAssertion, actual);
          return {
            fresh: true,
            matched: comparison.outcome === typedAssertionComparator.OUTCOMES.MATCHED,
            reason: comparison.reason,
            actual: comparison.actual,
          };
        }
        const observed = await hooks.snapshot({ source: `universal_wait_${phase}`, phase });
        if (!observed?.snapshotText && !observed?.fingerprint) return null;
        const fingerprint = observed.fingerprint || pageFingerprint.fromSnapshotText(
          observed.snapshotText || '',
          { url: observed.url || '', title: observed.title || '' },
        );
        return { fresh: true, url: observed.url || fingerprint.url || '', fingerprint };
      },
      seal: (payload) => hooks.seal({ idx, step, actionId, payload }),
    });
    return { handled: true, terminal: outcome.terminal === true, reason: outcome.reason, outcome };
  }

  function isRelationshipAssertion(assertion) {
    return ['relationship', 'assertrelationship', 'temporalrelationship', 'temporalcomparison', 'asserttemporal']
      .includes(token(assertion?.type || assertion?.kind));
  }

  function operandAssertion(operand = {}) {
    const kind = token(operand.kind || operand.type || operand.temporalType);
    if (kind === 'temporal' && operand.value !== undefined) return null;
    if (['literal', 'number', 'boolean', 'text', 'duration', 'count'].includes(kind) && operand.value !== undefined) return null;
    const name = String(operand.name || operand.ref || operand.label || '').trim();
    if (!name) return null;
    const type = kind === 'date' ? 'DATE' : kind === 'time' ? 'TIME'
      : ['datetime', 'date_time'].includes(kind) ? 'DATE_TIME' : 'VALUE';
    return {
      type,
      payload: {
        target: { name, label: name, ...(operand.role ? { role: operand.role } : {}) },
      },
    };
  }

  function scalarAssertionValue(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return value.value ?? value.actual ?? value.inputValue ?? value.selectedText ?? value.text ?? value;
  }

  async function readRelationshipPart(step, part) {
    const assertion = operandAssertion(part);
    if (!assertion) return Object.prototype.hasOwnProperty.call(part || {}, 'value')
      ? { status: 'resolved', value: part.value, source: 'typed_literal' }
      : { status: 'missing', value: null, reason: 'operand_part_contract_missing' };
    let observed = null;
    try { observed = await hooks.readAssertion({ step, assertion, requireFresh: true }); } catch (_) {}
    if (!observed?.fresh) return { status: 'unavailable', value: null, reason: 'fresh_operand_evidence_unavailable' };
    if (observed.uncheckable === true) {
      return {
        status: /ambiguous/i.test(String(observed.reason || '')) ? 'ambiguous'
          : /not_observed|missing/i.test(String(observed.reason || '')) ? 'missing' : 'uncheckable',
        value: null,
        reason: observed.reason || 'operand_uncheckable',
      };
    }
    return {
      status: 'resolved',
      value: scalarAssertionValue(Object.prototype.hasOwnProperty.call(observed, 'actual') ? observed.actual : observed),
      source: 'exact_target_evidence',
    };
  }

  async function readRelationshipAssertion(step, assertion) {
    const payload = assertion?.payload && typeof assertion.payload === 'object' ? assertion.payload : assertion || {};
    const operands = Array.isArray(payload.operands) ? payload.operands : [];
    if (operands.length < 2) {
      return { fresh: true, actual: { operands: [] } };
    }
    const actualOperands = [];
    for (let index = 0; index < operands.length; index += 1) {
      const operand = operands[index] || {};
      const name = String(operand.name || operand.ref || operand.label || `operand_${index + 1}`).trim();
      if (Array.isArray(operand.parts) && operand.parts.length) {
        const resolvedParts = [];
        for (const part of operand.parts) resolvedParts.push(await readRelationshipPart(step, part || {}));
        const unresolved = resolvedParts.find((part) => part.status !== 'resolved' || part.value == null || part.value === '');
        actualOperands.push(unresolved
          ? { name, role: operand.role || null, status: unresolved.status, value: null, reason: unresolved.reason }
          : {
              name,
              role: operand.role || null,
              status: 'resolved',
              value: resolvedParts.map((part) => String(part.value).trim()).join(' '),
              source: 'compound_exact_target_evidence',
            });
        continue;
      }
      const probeAssertion = operandAssertion(operand);
      if (!probeAssertion) {
        if (Object.prototype.hasOwnProperty.call(operand, 'value')) {
          actualOperands.push({ name, role: operand.role || null, status: 'resolved', value: operand.value, source: 'typed_literal' });
        } else {
          actualOperands.push({ name, role: operand.role || null, status: 'missing', value: null, source: 'operand_contract' });
        }
        continue;
      }
      let observed = null;
      try { observed = await hooks.readAssertion({ step, assertion: probeAssertion, requireFresh: true }); } catch (_) {}
      if (!observed?.fresh) {
        actualOperands.push({ name, role: operand.role || null, status: 'unavailable', value: null, reason: 'fresh_operand_evidence_unavailable' });
      } else if (observed.uncheckable === true) {
        const status = /ambiguous/i.test(String(observed.reason || '')) ? 'ambiguous'
          : /not_observed|missing/i.test(String(observed.reason || '')) ? 'missing' : 'uncheckable';
        actualOperands.push({ name, role: operand.role || null, status, value: null, reason: observed.reason || 'operand_uncheckable' });
      } else {
        actualOperands.push({
          name,
          role: operand.role || null,
          status: 'resolved',
          value: Object.prototype.hasOwnProperty.call(observed, 'actual') ? observed.actual : observed,
          source: 'exact_target_evidence',
        });
      }
    }
    const resolved = actualOperands.filter((operand) => operand.status === 'resolved' && operand.value != null);
    const assertionType = token(assertion?.type || assertion?.kind);
    const temporal = assertionType.includes('temporal');
    const numeric = !temporal && resolved.slice(0, 2).every((operand) => Number.isFinite(Number(operand.value)));
    const valueType = temporal ? 'datetime' : numeric ? 'number' : 'string';
    const evidenceChannels = resolved.length >= 2 ? [{
      kind: temporal ? 'temporal_relationship' : 'typed_relationship',
      scopeMatched: true,
      readback: true,
      leftTargetMatched: true,
      rightTargetMatched: true,
      leftReadback: true,
      rightReadback: true,
      left: { type: valueType, value: resolved[0].value },
      right: { type: valueType, value: resolved[1].value },
      source: 'exact_target_relationship_readback',
    }] : [];
    return { fresh: true, actual: { operands: actualOperands }, evidenceChannels };
  }

  async function readAssertionWithBoundedPolling(step, assertion) {
    const contract = waitContract.buildWaitContract(step);
    const timeoutMs = Math.max(500, Math.min(10_000, Number(contract?.timeoutMs) || 10_000));
    const pollIntervalMs = Math.max(25, Math.min(500, Number(contract?.pollIntervalMs) || 250));
    const startedAt = typeof hooks.now === 'function' ? hooks.now() : Date.now();
    let last = null;
    do {
      try { last = await hooks.readAssertion({ step, assertion, requireFresh: true }); } catch (_) { last = null; }
      if (last?.fresh && last.uncheckable !== true) {
        const actual = Object.prototype.hasOwnProperty.call(last, 'actual') ? last.actual : last;
        const comparison = typedAssertionComparator.compareTypedAssertion(assertion, actual);
        if (comparison.outcome === typedAssertionComparator.OUTCOMES.MATCHED) return last;
      }
      const now = typeof hooks.now === 'function' ? hooks.now() : Date.now();
      if (now - startedAt >= timeoutMs) break;
      if (typeof hooks.sleep === 'function') await hooks.sleep(pollIntervalMs);
      else await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    } while ((typeof hooks.now === 'function' ? hooks.now() : Date.now()) - startedAt <= timeoutMs);
    return last;
  }

  async function executeRun({ idx, step, fillOnly = false, actionId = null } = {}) {
    const family = universalActionKernel.classifyActionFamily(step, { eventAdapter });
    const optionalAbsent = await universalActionKernel.executeOptionalPresencePreflight({
      step,
      family,
      eventAdapter,
      resolveOptionalPresence: hooks.resolveOptionalPresence,
      seal: (payload) => hooks.seal({ idx, step, actionId, payload }),
    });
    if (optionalAbsent) {
      return {
        handled: optionalAbsent.handled === true,
        terminal: optionalAbsent.terminal === true,
        reason: optionalAbsent.reason,
        outcome: optionalAbsent,
      };
    }
    const openerIntent = family === universalActionKernel.FAMILIES.CLICK
      && !isPresenceConditionalAction(step)
      ? universalActionKernel.controlOpenerIntent(step)
      : null;
    if (openerIntent && !fillOnly) {
      return runControl({
        step,
        idx,
        actionId,
        suppliedPlan: universalActionKernel.buildControlOpenerPlan(step, openerIntent),
      });
    }
    if (family === universalActionKernel.FAMILIES.CONTROL) {
      const kind = controlActionAdapter.actionKind(step);
      if (fillOnly && kind !== 'fill' && kind !== 'type') return { handled: false, reason: 'not_fill' };
      return runControl({ step, idx, actionId });
    }
    if (family === universalActionKernel.FAMILIES.WAIT && !fillOnly) {
      return runWait({ step, idx, actionId });
    }
    if (family === universalActionKernel.FAMILIES.EVENT && !fillOnly) {
      const outcome = await universalActionKernel.executeUniversalAction({
        step, eventAdapter, actionId, evidenceAdapter: activeEvidenceAdapter,
        seal: (payload) => hooks.seal({ idx, step, actionId, payload }),
      });
      return { handled: outcome.handled === true, terminal: outcome.terminal === true, reason: outcome.reason, outcome };
    }
    if (family === universalActionKernel.FAMILIES.ASSERTION && !fillOnly && typeof hooks.readAssertion === 'function') {
      const assertion = universalActionKernel.assertionContractOf(step);
      const type = String(assertion?.type || assertion?.kind || '').toUpperCase();
      if (!LIVE_ASSERTION_TYPES.has(type)) return { handled: false, reason: 'operational_verify_uses_existing_authority' };
      const outcome = await universalActionKernel.executeUniversalAction({
        step,
        assertion,
        strictAssertionEvidenceRequired: true,
        observeAssertion: ({ requireFresh }) => isRelationshipAssertion(assertion)
          ? readRelationshipAssertion(step, assertion)
          : readAssertionWithBoundedPolling(step, assertion),
        seal: (payload) => hooks.seal({ idx, step, actionId, payload }),
      });
      return { handled: outcome.handled === true, terminal: outcome.terminal === true, reason: outcome.reason, outcome };
    }
    return { handled: false, reason: `family_${family}_uses_existing_authority` };
  }

  async function run(context = {}) {
    const result = await executeRun(context);
    const selectedAssists = evidenceNegotiation.assists || [];
    const advisoryHints = selectedAssists.length
      ? await activeEvidenceRegistry.collectAdvisoryHints(evidenceNegotiation, {
        actionId: context.actionId || null,
        action: universalActionKernel.actionToken(context.step || {}),
        target: controlActionAdapter.targetOf(context.step || {}) || null,
        step: context.step || null,
      })
      : [];
    const evidenceRouting = {
      schemaVersion: 'qaai.runtime-evidence-routing.v1',
      authoritativeAdapter: evidenceNegotiation.authoritativeAdapter,
      confidencePolicy: evidenceNegotiation.confidencePolicy,
      advisoryHints,
    };
    if (!result?.outcome) return { ...result, evidenceRouting };
    return {
      ...result,
      evidenceRouting,
      outcome: {
        ...result.outcome,
        diagnostics: {
          ...(result.outcome.diagnostics || {}),
          evidenceRouting,
        },
      },
    };
  }

  return {
    run,
    eventAdapter,
    evidenceAdapter: activeEvidenceAdapter,
    evidenceRegistry: activeEvidenceRegistry,
    evidenceNegotiation,
    dispose: () => broker.dispose(),
  };
}

module.exports = {
  eventKindForStep,
  createConductorUniversalRuntime,
};
