'use strict';

const crypto = require('crypto');
const mcp = require('./mcp');
const {
  captureStructuralLocator,
  buildLocatorEvidenceRecord,
} = require('./actionLocatorResolver');
const {
  RESOLUTION_STATUS,
} = require('./browserTransactionController');
const {
  PROOF_STATUS,
  EVIDENCE_TIER,
} = require('./browserProofContract');
const {
  SNAPSHOT_SOURCE,
  SNAPSHOT_STATUS,
  createBrowserSnapshotLifecycle,
} = require('./browserSnapshotLifecycle');
const {
  normalizeTime,
  normalizeDate,
  selectionValue,
} = require('./controllerCompositeProtocols');
const {
  OBSERVER_ROLE,
  observation,
} = require('./browserTransactionAuthority');
const {
  buildBoundTemporalOwnerReadFunction,
} = require('./semanticTemporalSelection');
const {
  buildBoundSelectionOwnerReadFunction,
  buildBoundPopupOwnershipReadFunction,
  evaluateSelectionOwnerReadback,
} = require('./semanticSelectionState');
const {
  buildBoundTextInputReadFunction,
  evaluateTextInputReadback,
} = require('./semanticTextInputState');
const {
  assertionContractOf,
} = require('./universalActionKernel');
const {
  OUTCOMES: ASSERTION_OUTCOMES,
  compareTypedAssertion,
} = require('./typedAssertionComparator');

const MCP_ADAPTER_VERSION = 'qaai-controller-mcp-runtime-adapter-v1';
const GENERIC_WORDS = new Set([
  'a', 'an', 'and', 'application', 'button', 'calendar', 'control', 'current',
  'dropdown', 'enter', 'field', 'input', 'microsoft', 'on', 'option', 'page',
  'picker', 'screen', 'section', 'stable', 'state', 'that', 'the', 'to', 'with', 'your',
  'selected', 'visible', 'first', 'second', 'third', 'fourth', 'fifth', 'label',
]);

class ControllerMcpRuntimeAdapterError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ControllerMcpRuntimeAdapterError';
    this.code = code;
    Object.assign(this, details);
  }
}

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function token(value) {
  return clean(value).toLocaleLowerCase('en-US');
}

function snapshotScalar(value) {
  const normalized = clean(value);
  if (!normalized) return normalized;
  if (normalized.startsWith('"') && normalized.endsWith('"')) {
    try {
      const decoded = JSON.parse(normalized);
      return typeof decoded === 'string' ? clean(decoded) : normalized;
    } catch (_) {
      return normalized.slice(1, -1);
    }
  }
  if (normalized.startsWith("'") && normalized.endsWith("'")) {
    return normalized.slice(1, -1).replace(/\\'/g, "'");
  }
  return normalized;
}

function controllerAssertionContract(operation = {}) {
  const target = clean(
    operation?.targetIdentity?.accessibleName
      || operation?.targetIdentity?.label
      || operation?.target,
  );
  return assertionContractOf({
    ...operation,
    action: operation.type,
    target,
    // Compiled assertion operations carry their expected value in `.value`
    // (the same field convention action operations use for plannedText) —
    // not `.expected`. Falling back to it here is what compareTypedAssertion
    // actually reads as `payload.expected`; without it, every flat-authored
    // AssertValue/AssertText step (e.g. LetCode's) compared against
    // `undefined` and came back "exact_proof_unavailable" regardless of the
    // real field value.
    expected: operation.expected ?? operation.value,
    verify: operation.verify,
    comparator: operation.comparator,
  });
}

function assertionPayload(contract = {}) {
  return contract?.payload && typeof contract.payload === 'object'
    ? contract.payload
    : contract;
}

function assertionTargetName(contract = {}, operation = {}) {
  const payload = assertionPayload(contract);
  const target = payload.target || payload.element;
  return clean(
    typeof target === 'string'
      ? target
      : target?.name || target?.label || target?.accessibleName
        || operation?.targetIdentity?.accessibleName
        || operation?.targetIdentity?.label,
  );
}

function assertionTargetRole(contract = {}) {
  const payload = assertionPayload(contract);
  const target = payload.target || payload.element;
  return clean(typeof target === 'object' ? target?.role : null).toLowerCase() || null;
}

function assertionRoleAllowed(contract, candidate) {
  const type = clean(contract?.type || contract?.kind).toUpperCase();
  const targetName = token(assertionTargetName(contract));
  const role = token(candidate?.role);
  const explicitRole = assertionTargetRole(contract);
  if (explicitRole) {
    if (explicitRole === 'document') return ['document', 'main', 'region', 'heading'].includes(role);
    if (explicitRole === 'listbox') return ['listbox', 'option', 'menu', 'menuitem', 'listitem'].includes(role);
    if (role !== explicitRole) return false;
  }
  if (type === 'COLLECTION') {
    return ['listbox', 'option', 'menu', 'menuitem', 'listitem', 'radio'].includes(role);
  }
  if (['VALUE', 'DATE', 'TIME', 'DATE_TIME', 'DATETIME'].includes(type)) {
    return ['combobox', 'textbox', 'searchbox', 'spinbutton'].includes(role);
  }
  if (/\bheading\b/.test(targetName)) return role === 'heading';
  if (/\boption\b/.test(targetName)) return ['option', 'menuitem', 'listitem', 'radio'].includes(role);
  if (/\b(?:button|control)\b/.test(targetName)) {
    return ['button', 'link', 'menuitem', 'tab', 'radio', 'checkbox'].includes(role);
  }
  return true;
}

function assertionTargetOperation(operation, contract, targetName) {
  const role = assertionTargetRole(contract);
  return {
    ...operation,
    targetIdentity: {
      ...(operation?.targetIdentity || {}),
      accessibleName: targetName,
      label: targetName,
      role: role && !['document', 'listbox'].includes(role) ? role : null,
    },
    targetAliases: [targetName],
    expected: null,
    payload: null,
    verify: null,
  };
}

function rankedAssertionTargets(operation, contract, candidates = [], explicitTarget = null) {
  const targetName = clean(explicitTarget || assertionTargetName(contract, operation));
  if (!targetName) return [];
  const targetOperation = assertionTargetOperation(operation, contract, targetName);
  return rankSemanticCandidates(targetOperation, candidates)
    .filter((entry) => assertionRoleAllowed(contract, entry.candidate));
}

function uniqueBestAssertionTarget(operation, contract, candidates = [], explicitTarget = null) {
  const ranked = rankedAssertionTargets(operation, contract, candidates, explicitTarget);
  if (!ranked.length) return { status: 'missing', candidate: null, ranked };
  const bestScore = ranked[0].score;
  const best = ranked.filter((entry) => entry.score === bestScore);
  if (best.length !== 1) return { status: 'ambiguous', candidate: null, ranked };
  return { status: 'resolved', candidate: best[0].candidate, ranked };
}

function snapshotOwnerValue(snapshotText, candidate, targetName = '') {
  if (!candidate?.ref) return null;
  const line = lineForRef(snapshotText, candidate.ref);
  const suffix = snapshotScalar(line.match(/\]\s*:\s*(.+)$/)?.[1]);
  if (suffix) return suffix;
  // Some elements (e.g. LetCode's read-only "What is inside the text box")
  // render their value as a nested child line ("- text: ortonikc") instead
  // of inline after the ref's colon — reproduced live on 2026-08-07, where
  // this always returned null despite the value being visibly present on
  // the page. extractCandidateValue() already walks child lines for exactly
  // this shape (used by the Append/Clear detection above); reuse it instead
  // of re-deriving the same parsing logic here.
  const childValue = clean(extractCandidateValue(snapshotText, candidate.ref, candidate));
  if (childValue) return childValue;
  const observedName = clean(candidate.accessibleName || candidate.name);
  if (!observedName) return null;
  const targetLexical = lexicalMatchScore(targetName, observedName);
  const structuralNames = [
    ...(Array.isArray(candidate.controlLabels) ? candidate.controlLabels : []),
    ...(Array.isArray(candidate.scopeLabels) ? candidate.scopeLabels : []),
    ...(Array.isArray(candidate.semanticNames) ? candidate.semanticNames : []),
  ].map(clean).filter((name) => name && token(name) !== token(observedName));
  const labelLexical = Math.max(
    0,
    ...structuralNames.map((label) => lexicalMatchScore(targetName, label)),
    lexicalMatchScore(targetName, structuralNames.join(' ')),
  );
  return labelLexical >= 650 && targetLexical < 650 ? observedName : null;
}

function assertionResult(comparison, details = {}) {
  const matched = comparison?.outcome === ASSERTION_OUTCOMES.MATCHED || comparison?.matched === true
    ? true
    : comparison?.outcome === ASSERTION_OUTCOMES.NOT_MATCHED || comparison?.matched === false
      ? false
      : null;
  const sensitive = /\b(?:password|passcode|secret|token|credential|api[_ -]?key)\b/i
    .test(clean(details.target));
  const summarize = (value) => {
    if (sensitive && value != null) return '[REDACTED]';
    if (value == null) return null;
    const serialized = typeof value === 'string'
      ? clean(value)
      : clean(JSON.stringify(value));
    return serialized.slice(0, 240) || null;
  };
  const expected = summarize(comparison?.expected);
  const observed = summarize(comparison?.actual);
  const baseReason = clean(comparison?.reason) || 'typed_assertion_uncheckable';
  const reason = matched === false && (expected || observed)
    ? `${baseReason}:expected=${expected || '[unavailable]'}:observed=${observed || '[unavailable]'}`
    : baseReason;
  return Object.freeze({
    matched,
    reason,
    assertionType: clean(details.assertionType) || null,
    target: clean(details.target) || null,
    observedKind: clean(details.observedKind) || null,
    candidateRef: clean(details.candidateRef) || null,
    expected,
    observed,
  });
}

function temporalRelationshipActual({ operation, contract, snapshotText, candidates }) {
  const payload = assertionPayload(contract);
  const operands = Array.isArray(payload.operands) ? payload.operands : [];
  const actualOperands = [];
  for (const operand of operands) {
    const parts = Array.isArray(operand?.parts) ? operand.parts : [];
    const datePart = parts.find((part) => token(part?.kind) === 'date') || parts[0];
    const timePart = parts.find((part) => token(part?.kind) === 'time') || parts[1];
    if (!datePart?.name || !timePart?.name) return null;
    const dateContract = { type: 'DATE', payload: { target: { name: datePart.name } } };
    const timeContract = { type: 'TIME', payload: { target: { name: timePart.name } } };
    const dateOwner = uniqueBestAssertionTarget(operation, dateContract, candidates, datePart.name);
    const timeOwner = uniqueBestAssertionTarget(operation, timeContract, candidates, timePart.name);
    if (dateOwner.status !== 'resolved' || timeOwner.status !== 'resolved') return null;
    const dateValue = snapshotOwnerValue(snapshotText, dateOwner.candidate, datePart.name);
    const timeValue = snapshotOwnerValue(snapshotText, timeOwner.candidate, timePart.name);
    const normalizedDate = normalizeDate(dateValue);
    const normalizedTime = normalizeTime(timeValue);
    if (!normalizedDate || !normalizedTime) return null;
    actualOperands.push({
      name: clean(operand?.name) || `${datePart.name} / ${timePart.name}`,
      value: `${normalizedDate}T${normalizedTime}:00`,
      status: 'observed',
    });
  }
  return actualOperands.length >= 2 ? { operands: actualOperands } : null;
}

function evaluateControllerAssertionSnapshot({
  operation,
  snapshotText,
  snapshotUrl,
  candidates = [],
} = {}) {
  if (operation?.kind !== 'assertion') return null;
  const contract = controllerAssertionContract(operation);
  const payload = assertionPayload(contract);
  const type = clean(contract?.type || contract?.kind).toUpperCase()
    .replace(/^ASSERTVALUE$/, 'VALUE')
    .replace(/^ASSERTTEXT$/, 'TEXT')
    .replace(/^ASSERTVISIBLE$/, 'VISIBLE')
    .replace(/^ASSERTHIDDEN$/, 'HIDDEN');
  const targetName = assertionTargetName(contract, operation);

  // VALUE/TEXT used to short-circuit here with a hand-rolled comparison
  // (ranked[0] with no ambiguity check, a bare substring match, no real
  // comparator) that packaged its result as `{ observed }` while
  // assertionResult() below reads `comparison.actual` — so the real
  // observed value was silently dropped and every VALUE/TEXT failure
  // reported observed=[unavailable] regardless of what was actually read.
  // Falling through to the shared owner-resolution + compareTypedAssertion
  // path (used by every other assertion type) fixes both: it surfaces
  // ambiguous/missing targets explicitly instead of guessing at ranked[0],
  // reads the value straight from the snapshot line, and returns `.actual`
  // in the shape assertionResult already expects.

  if (['DISABLED', 'ASSERTDISABLED', 'READONLY', 'ASSERTREADONLY', 'STATE'].includes(type)) {
    const ranked = rankedAssertionTargets(operation, contract, candidates);
    const targetCandidate = ranked[0]?.candidate;
    const line = targetCandidate ? lineForRef(snapshotText, targetCandidate.ref) : '';
    const isDisabledOrReadonly = targetCandidate
      ? Boolean(
        targetCandidate.disabled
        || targetCandidate.readonly
        || targetCandidate.attributes?.disabled
        || targetCandidate.attributes?.readonly
        || /\bdisabled\b|\breadonly\b|aria-disabled\s*=\s*["']?true|aria-readonly\s*=\s*["']?true/i.test(line)
      )
      : true;
    return assertionResult({ matched: isDisabledOrReadonly, expected: 'disabled', actual: isDisabledOrReadonly ? 'disabled' : 'enabled' }, {
      assertionType: type,
      target: targetName,
      observedKind: 'candidate-state',
      candidateRef: targetCandidate?.ref,
    });
  }

  if (type === 'VISIBLE' || type === 'HIDDEN') {
    const ranked = rankedAssertionTargets(operation, contract, candidates);
    const matchedCandidate = ranked[0]?.candidate || null;
    const subject = targetName
      .replace(/^no\s+/i, '')
      .replace(/\s+(?:page|heading|section|control|option|field)$/i, '');
    // A trailing `|| true` here previously made `visible` unconditionally
    // true, so every HIDDEN assertion (expects visible=false) failed on
    // every website regardless of the real page state — VISIBLE happened
    // to look fine only because true already matched its expectation.
    // When a semantic candidate is found, trust ITS OWN visible flag from
    // the live snapshot rather than treating "a match exists" as proof of
    // visibility; only fall back to the page-level text-presence heuristic
    // when nothing matched at all.
    const visible = matchedCandidate
      ? matchedCandidate.visible !== false
      : (/\bpage\b/i.test(targetName)
        && semanticTextPresent(`${snapshotUrl || ''} ${snapshotText || ''}`, subject));
    return assertionResult(compareTypedAssertion(contract, { visible }), {
      assertionType: type,
      target: targetName,
      observedKind: matchedCandidate ? 'semantic-candidate' : 'page-semantic-state',
      candidateRef: matchedCandidate?.ref,
    });
  }

  if (type === 'COLLECTION' || type === 'COLLECTION_MEMBERSHIP') {
    const optionRoles = new Set(['option', 'menuitem', 'listitem', 'radio']);
    const items = candidates
      .filter((candidate) => optionRoles.has(token(candidate?.role)))
      .map((candidate) => clean(candidate.accessibleName || candidate.name))
      .filter(Boolean);
    return assertionResult(compareTypedAssertion(contract, items), {
      assertionType: type,
      target: targetName,
      observedKind: 'visible-scoped-collection',
    });
  }

  if (type === 'TEMPORAL_RELATIONSHIP'
    || type === 'TEMPORALRELATIONSHIP'
    || type === 'TEMPORALCOMPARISON'
    || type === 'ASSERTTEMPORAL') {
    const actual = temporalRelationshipActual({
      operation,
      contract,
      snapshotText,
      candidates,
    });
    return assertionResult(compareTypedAssertion(contract, actual), {
      assertionType: type,
      target: targetName,
      observedKind: 'normalized-temporal-owner-values',
    });
  }

  if (type === 'ATTRIBUTE') {
    const ranked = rankedAssertionTargets(operation, contract, candidates);
    if (!ranked.length) {
      return Object.freeze({
        matched: null,
        reason: 'typed_assertion_target_missing',
        assertionType: type,
        target: targetName || null,
        observedKind: null,
        candidateRef: null,
      });
    }
    const bestScore = ranked[0].score;
    const best = ranked.filter((entry) => entry.score === bestScore);
    const stateEvidence = best
      .map((entry) => ({
        candidate: entry.candidate,
        expanded: accordionStateFromSnapshot(operation, snapshotText, entry.candidate),
      }))
      .filter((entry) => entry.expanded != null);
    const states = new Set(stateEvidence.map((entry) => entry.expanded));
    if (states.size > 1) {
      return Object.freeze({
        matched: null,
        reason: 'typed_assertion_attribute_state_conflicting',
        assertionType: type,
        target: targetName || null,
        observedKind: 'conflicting-semantic-aria-state',
        candidateRef: null,
      });
    }
    if (!stateEvidence.length && best.length > 1) {
      return Object.freeze({
        matched: null,
        reason: 'typed_assertion_target_ambiguous',
        assertionType: type,
        target: targetName || null,
        observedKind: null,
        candidateRef: null,
      });
    }
    const selected = stateEvidence[0] || { candidate: best[0].candidate, expanded: null };
    const expanded = selected.expanded;
    const actual = expanded == null ? null : {
      attributes: { 'aria-expanded': String(expanded) },
    };
    return assertionResult(compareTypedAssertion(contract, actual), {
      assertionType: type,
      target: targetName,
      observedKind: stateEvidence.length > 1
        ? 'corroborated-semantic-aria-state'
        : 'exact-owner-aria-state',
      candidateRef: selected.candidate.ref,
    });
  }

  const owner = uniqueBestAssertionTarget(operation, contract, candidates);
  if (owner.status !== 'resolved') {
    return Object.freeze({
      matched: null,
      reason: `typed_assertion_target_${owner.status}`,
      assertionType: type || null,
      target: targetName || null,
      observedKind: null,
      candidateRef: null,
    });
  }

  const observedValue = snapshotOwnerValue(snapshotText, owner.candidate, targetName);
  if (type === 'VALUE'
    && temporalControlFamily(targetName) === 'time'
    && temporalControlFamily(targetName) !== 'time_zone') {
    const expectedValue = payload.expectedValue ?? payload.expected;
    const expectedTime = normalizeTime(expectedValue);
    const observedTime = normalizeTime(observedValue);
    if (expectedTime && observedTime) {
      return Object.freeze({
        matched: expectedTime === observedTime,
        reason: expectedTime === observedTime
          ? 'normalized_time_assertion_matched'
          : 'normalized_time_assertion_not_matched',
        assertionType: type,
        target: targetName,
        observedKind: 'normalized-owner-value',
        candidateRef: owner.candidate.ref,
      });
    }
  }
  const comparison = compareTypedAssertion(contract, observedValue);
  return assertionResult(comparison, {
    assertionType: type,
    target: targetName,
    observedKind: 'exact-owner-value',
    candidateRef: owner.candidate.ref,
  });
}

function exactFillAcknowledgment({
  operation,
  resolution,
  plan,
  delivery,
  ownerVisible,
} = {}) {
  const type = clean(operation?.type);
  const mutationTool = clean(plan?.mutation?.toolName);
  const ownerRef = clean(resolution?.target?.ref);
  const mutationTarget = clean(plan?.mutation?.args?.target);
  const acknowledgmentKind = clean(delivery?.acknowledgmentKind);
  return ownerVisible === true
    && ['Fill', 'Type', 'Clear'].includes(type)
    && ['browser_fill', 'browser_type'].includes(mutationTool)
    && Boolean(ownerRef)
    && mutationTarget === ownerRef
    && clean(delivery?.deliveryStatus).toUpperCase() === 'DELIVERED'
    && delivery?.browserAcknowledged === true
    && ['browser_fill_returned', 'browser_type_returned'].includes(acknowledgmentKind);
}

function protectedPasswordAcknowledgment(input = {}) {
  return exactFillAcknowledgment(input)
    && input.delivery?.protectedInputNonEmpty === true;
}

function words(value) {
  return token(value)
    .replace(/\btimezone\b/g, 'time zone')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word && !GENERIC_WORDS.has(word));
}

function semanticWords(value) {
  return words(value).map((word) => (
    word.length > 3 && word.endsWith('s') && !word.endsWith('ss')
      ? word.slice(0, -1)
      : word
  ));
}

function textOfResult(result) {
  const text = String(result?.text || mcp.textOfContent(result?.content) || '').trim();
  const splitIndex = text.indexOf('### Ran Playwright code');
  if (splitIndex !== -1) {
    return text.substring(0, splitIndex).trim();
  }
  return text;
}

function evaluatePayload(result) {
  let value = typeof mcp.parseEvaluateReturnValue === 'function'
    ? mcp.parseEvaluateReturnValue(textOfResult(result))
    : null;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (_) {
      return null;
    }
  }
  return value && typeof value === 'object' ? value : null;
}

function diagnosticSnapshotPreview(snapshotText, candidateCount) {
  if (Number(candidateCount) > 0) return null;
  return String(snapshotText || '')
    .replace(/(\bvalue\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s\]]+)/gi, '$1"[redacted]"')
    .replace(/(\b(?:password|secret|token)\b\s*[:=]\s*)([^\s,\]}]+)/gi, '$1[redacted]')
    .slice(0, 1_500);
}

function sanitizeSnapshotLine(line) {
  return String(line || '')
    .replace(/(\bvalue\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s\]]+)/gi, '$1"[redacted]"')
    .replace(/(\b(?:password|secret|token)\b\s*[:=]\s*)([^\s,\]}]+)/gi, '$1[redacted]')
    .slice(0, 500);
}

function structuralExcerpt(snapshotText, refs = [], {
  radius = 14,
  maxLines = 160,
} = {}) {
  const lines = String(snapshotText || '').split(/\r?\n/);
  const wanted = new Set((Array.isArray(refs) ? refs : []).map(clean).filter(Boolean));
  const indexes = [];
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = mcp.parseSnapshotLine(lines[index]);
    if (parsed?.ref && wanted.has(clean(parsed.ref))) indexes.push(index);
  }
  const selected = new Set();
  for (const index of indexes) {
    for (
      let cursor = Math.max(0, index - radius);
      cursor <= Math.min(lines.length - 1, index + radius);
      cursor += 1
    ) {
      selected.add(cursor);
      if (selected.size >= maxLines) break;
    }
    if (selected.size >= maxLines) break;
  }
  return Object.freeze(
    [...selected]
      .sort((left, right) => left - right)
      .slice(0, maxLines)
      .map((index) => `${index + 1}:${sanitizeSnapshotLine(lines[index])}`),
  );
}

function pageMetadata(snapshotText) {
  const url = snapshotText.match(/(?:^|\n)\s*-\s*Page URL:\s*(\S+)/i)?.[1]
    || snapshotText.match(/(?:^|\n)\s*Page URL:\s*(\S+)/i)?.[1]
    || null;
  const title = snapshotText.match(/(?:^|\n)\s*-\s*Page Title:\s*(.+)$/im)?.[1]
    || snapshotText.match(/(?:^|\n)\s*Page Title:\s*(.+)$/im)?.[1]
    || null;
  return { url: clean(url) || null, title: clean(title) || null };
}

function structuralLabelText(line) {
  const parsed = mcp.parseSnapshotLine(line);
  if (!parsed) return null;
  const role = token(parsed.role);
  if (!new Set(['text', 'label', 'paragraph', 'heading', 'statictext', 'generic']).has(role)) {
    return null;
  }
  if (clean(parsed.name)) return clean(parsed.name);
  const structuralRest = clean(parsed.rest).replace(/\[[^\]]+\]/g, ' ');
  const colonText = structuralRest.match(/:\s*(.+)$/)?.[1] || '';
  return clean(
    colonText
      .replace(/\s+\[[^\]]+\].*$/, '')
      .replace(/^["'“”]|["'“”]$/g, ''),
  ) || null;
}

function structuralLabelHints(snapshotText) {
  const lines = String(snapshotText || '').split(/\r?\n/);
  const hints = new Map();
  const interactiveRoles = new Set([
    'button', 'link', 'menuitem', 'tab',
    'textbox', 'searchbox', 'spinbutton', 'combobox',
    'checkbox', 'radio', 'switch',
  ]);
  for (let index = 0; index < lines.length; index += 1) {
    const owner = mcp.parseSnapshotLine(lines[index]);
    const ownerRole = token(owner?.role);
    const ownerName = clean(owner?.name);
    const ownerPlaceholder = clean(owner?.placeholder);
    const nameIsPlaceholder = Boolean(
      ownerName
      && ownerPlaceholder
      && token(ownerName) === token(ownerPlaceholder),
    );
    const nameLooksLikePrompt = /^(?:enter|type|search|select|choose|pick|add)\b/i.test(ownerName);
    // Custom selects commonly expose the selected value as the combobox's
    // accessible name. That value is browser truth about state, not the
    // control's semantic identity, so retain the nearest visible field label
    // for every combobox. Other distinctly named controls remain untouched.
    const valueNamedCombobox = ownerRole === 'combobox';
    if (!owner?.ref
      || !interactiveRoles.has(ownerRole)
      || (ownerName && !nameIsPlaceholder && !nameLooksLikePrompt && !valueNamedCombobox)) continue;
    const ownerDepth = (lines[index].match(/^(\s*)/) || ['', ''])[1].length;
    const minimumPriorDepth = valueNamedCombobox ? ownerDepth - 6 : ownerDepth;
    const labels = new Set();
    let climbedAncestorDepth = null;
    for (let cursor = index - 1; cursor >= Math.max(0, index - 12); cursor -= 1) {
      const prior = mcp.parseSnapshotLine(lines[cursor]);
      if (!prior) continue;
      const priorDepth = (lines[cursor].match(/^(\s*)/) || ['', ''])[1].length;
      // A selected-value combobox is usually nested in one or two anonymous
      // wrappers below its visible label. Permit a bounded climb through those
      // wrappers, while refusing to borrow labels from broader scopes.
      if (priorDepth < minimumPriorDepth) break;
      if (climbedAncestorDepth != null && priorDepth > climbedAncestorDepth) break;
      if (priorDepth < ownerDepth) climbedAncestorDepth = priorDepth;
      if (prior?.ref
        && interactiveRoles.has(token(prior.role))
        && priorDepth <= ownerDepth
        && labels.size) break;
      const label = structuralLabelText(lines[cursor]);
      if (!label
        || label.length > 160
        || priorDepth > ownerDepth + 10
        || priorDepth < minimumPriorDepth) continue;
      labels.add(label);
      if (ownerName) break;
      if (labels.size >= 4) break;
    }
    for (let cursor = index + 1; cursor <= Math.min(lines.length - 1, index + 12); cursor += 1) {
      const following = mcp.parseSnapshotLine(lines[cursor]);
      if (!following) continue;
      const followingDepth = (lines[cursor].match(/^(\s*)/) || ['', ''])[1].length;
      if (followingDepth <= ownerDepth) break;
      const label = structuralLabelText(lines[cursor]);
      if (!label || label.length > 160 || followingDepth > ownerDepth + 10) continue;
      labels.add(label);
      if (labels.size >= 4) break;
    }
    if (labels.size) hints.set(owner.ref, Object.freeze([...labels]));
  }
  return hints;
}

function structuralScopeHints(snapshotText) {
  const lines = String(snapshotText || '').split(/\r?\n/);
  const hints = new Map();
  const containerRoles = new Set([
    'generic', 'group', 'region', 'form', 'list', 'listitem',
    'row', 'cell', 'gridcell', 'dialog',
  ]);
  const interactiveRoles = new Set([
    'button', 'link', 'menuitem', 'tab',
    'textbox', 'searchbox', 'spinbutton', 'combobox',
    'checkbox', 'radio', 'switch',
  ]);
  const stack = [];

  const popCompletedScope = () => {
    const completed = stack.pop();
    const parent = stack[stack.length - 1];
    if (!completed?.primaryLabel
      || completed.primaryLabelInherited
      || temporalControlFamily(completed.primaryLabel) !== 'date_time'
      || !parent
      || parent.primaryLabel) return;
    // Component libraries commonly render a group heading in one child row
    // and its controls in a following sibling row. Carry that direct heading
    // up one structural level so the controls retain their group identity,
    // but never cascade an inherited label into broader page containers.
    parent.primaryLabel = completed.primaryLabel;
    parent.primaryLabelInherited = true;
  };

  for (const line of lines) {
    const parsed = mcp.parseSnapshotLine(line);
    if (!parsed) continue;
    const depth = (line.match(/^(\s*)/) || ['', ''])[1].length;
    while (stack.length && stack[stack.length - 1].depth >= depth) {
      popCompletedScope();
    }

    const label = structuralLabelText(line);
    if (label && stack.length) {
      const nearest = stack[stack.length - 1];
      if (!nearest.primaryLabel) {
        nearest.primaryLabel = label;
        nearest.primaryLabelInherited = false;
      }
    }

    const role = token(parsed.role);
    if (parsed.ref && interactiveRoles.has(role)) {
      const labels = [
        ...new Set(stack.map((entry) => clean(entry.primaryLabel)).filter(Boolean)),
      ];
      if (labels.length) hints.set(parsed.ref, Object.freeze(labels));
    }

    if (containerRoles.has(role)) {
      stack.push({
        depth,
        primaryLabel: clean(parsed.name) || label || null,
        primaryLabelInherited: false,
      });
    }
  }
  return hints;
}

function interactionTriggerHints(snapshotText) {
  const lines = String(snapshotText || '').split(/\r?\n/);
  const hints = new Map();
  const ownerRoles = new Set(['combobox', 'searchbox', 'textbox']);
  for (let index = 0; index < lines.length; index += 1) {
    const owner = mcp.parseSnapshotLine(lines[index]);
    if (!owner?.ref || !ownerRoles.has(token(owner.role))) continue;
    const ownerDepth = (lines[index].match(/^(\s*)/) || ['', ''])[1].length;
    const siblingButtons = [];
    for (let cursor = index + 1; cursor <= Math.min(lines.length - 1, index + 8); cursor += 1) {
      const candidate = mcp.parseSnapshotLine(lines[cursor]);
      if (!candidate) continue;
      const candidateDepth = (lines[cursor].match(/^(\s*)/) || ['', ''])[1].length;
      if (candidateDepth < ownerDepth) break;
      if (candidateDepth === ownerDepth
        && candidate?.ref
        && token(candidate.role) === 'button') {
        const name = token(candidate.name);
        if (!/\b(?:clear|delete|dismiss|remove|reset)\b/.test(name)) {
          siblingButtons.push({
            ref: candidate.ref,
            explicitTrigger: /\b(?:dropdown\s+trigger|menu\s+trigger|open(?:\s+options?|\s+menu)?|show\s+options?|toggle|expand)\b/.test(name),
            unnamed: !name,
          });
        }
        continue;
      }
      if (candidateDepth === ownerDepth
        && candidate?.ref
        && ['combobox', 'searchbox', 'textbox'].includes(token(candidate.role))) {
        break;
      }
    }
    const explicit = siblingButtons.filter((candidate) => candidate.explicitTrigger);
    const safeCandidates = explicit.length ? explicit : siblingButtons.filter((candidate) => candidate.unnamed);
    if (safeCandidates.length === 1) hints.set(owner.ref, safeCandidates[0].ref);
  }
  return hints;
}

function dedupeCandidates(snapshotText, epoch) {
  const byRef = new Map();
  const structuralHints = structuralLabelHints(snapshotText);
  const scopeHints = structuralScopeHints(snapshotText);
  const triggerHints = interactionTriggerHints(snapshotText);
  for (const candidate of mcp.parseMcpSnapshotToCandidates(snapshotText)) {
    const ref = clean(candidate.ref);
    if (!ref) continue;
    const prior = byRef.get(ref);
    const next = {
      ref,
      reference: ref,
      accessibleName: clean(candidate.name) || null,
      name: clean(candidate.name) || null,
      role: clean(candidate.role) || null,
      section: clean(candidate.parentName) || null,
      form: clean(candidate.parentRole) === 'form' ? clean(candidate.parentName) || null : null,
      strategy: candidate.strategy,
      stability: Number(candidate.stability) || 0,
      actionable: true,
      visible: true,
      disabled: false,
      browserEpoch: epoch,
      source: SNAPSHOT_SOURCE.BROWSER_SNAPSHOT,
      factRef: `snapshot:${epoch}:ref:${ref}`,
      interactionRef: triggerHints.get(ref) || null,
      controlLabels: Object.freeze([...(structuralHints.get(ref) || [])]),
      scopeLabels: Object.freeze([...(scopeHints.get(ref) || [])]),
      semanticNames: Object.freeze([
        ...new Set([
          clean(candidate.name),
          clean(candidate.placeholder),
          clean(candidate.parentName),
          ...(scopeHints.get(ref) || []),
          ...(structuralHints.get(ref) || []),
        ].filter(Boolean)),
      ]),
    };
    if (!prior) {
      byRef.set(ref, Object.freeze(next));
      continue;
    }
    const preferred = Number(prior.stability) >= Number(next.stability) ? prior : next;
    byRef.set(ref, Object.freeze({
      ...preferred,
      section: prior.section || next.section || null,
      form: prior.form || next.form || null,
      interactionRef: prior.interactionRef || next.interactionRef || null,
      controlLabels: Object.freeze([
        ...new Set([
          ...(Array.isArray(prior.controlLabels) ? prior.controlLabels : []),
          ...(Array.isArray(next.controlLabels) ? next.controlLabels : []),
        ].map(clean).filter(Boolean)),
      ]),
      scopeLabels: Object.freeze([
        ...new Set([
          ...(Array.isArray(prior.scopeLabels) ? prior.scopeLabels : []),
          ...(Array.isArray(next.scopeLabels) ? next.scopeLabels : []),
        ].map(clean).filter(Boolean)),
      ]),
      semanticNames: Object.freeze([
        ...new Set([
          ...(Array.isArray(prior.semanticNames) ? prior.semanticNames : []),
          ...(Array.isArray(next.semanticNames) ? next.semanticNames : []),
        ].map(clean).filter(Boolean)),
      ]),
    }));
  }
  return Object.freeze([...byRef.values()]);
}

function roleSetFor(operation) {
  switch (operation.type) {
    case 'Fill':
    case 'Type':
    case 'Clear':
      return new Set(['textbox', 'searchbox', 'spinbutton', 'combobox']);
    case 'Select':
    case 'Date':
    case 'Time':
    case 'DateTime':
      return new Set(['combobox', 'textbox', 'button']);
    case 'Radio':
      return new Set(['radio']);
    case 'Check':
    case 'Uncheck':
      return new Set(['checkbox', 'switch']);
    case 'Expand':
    case 'Collapse':
      return new Set(['button', 'tab']);
    case 'Click':
    case 'Submit':
    case 'DoubleClick':
      if (token(operation?.operationCheck?.kind) === 'menu_opened') {
        return new Set([
          'combobox', 'searchbox', 'textbox',
          'button', 'link', 'menuitem', 'tab',
        ]);
      }
      return new Set(['button', 'link', 'menuitem', 'tab', 'radio', 'checkbox']);
    default:
      return null;
  }
}

function quotedLiterals(value) {
  const text = clean(value);
  if (!text) return [];
  const literals = [];
  const pattern = /["“”']([^"“”']{2,160})["“”']/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const literal = clean(match[1]);
    if (literal) literals.push(literal);
  }
  return literals;
}

function targetNamesFor(operation) {
  const explicitLabels = [
    operation?.targetIdentity?.accessibleName,
    operation?.targetIdentity?.label,
  ].map(clean).filter(Boolean);
  const rawAliases = [
    ...(Array.isArray(operation?.targetAliases) ? operation.targetAliases : []),
    operation?.expected,
    operation?.payload,
  ].map(clean).filter(Boolean);

  const quoted = [...explicitLabels, ...rawAliases].flatMap(quotedLiterals);

  return [
    ...new Set([
      ...explicitLabels,
      ...quoted,
      ...rawAliases,
    ]),
  ];
}

function lexicalMatchScore(authoredName, candidateName) {
  if (!authoredName || !candidateName) return 0;
  if (token(authoredName) === token(candidateName)) return 1_200;
  const authoredWords = semanticWords(authoredName);
  const candidateWords = semanticWords(candidateName);
  if (!authoredWords.length || !candidateWords.length) return 0;
  const authoredSet = new Set(authoredWords);
  const candidateSet = new Set(candidateWords);
  const shared = [...authoredSet].filter((word) => candidateSet.has(word));
  const authoredInCandidate = [...authoredSet].every((word) => candidateSet.has(word));
  const candidateInAuthored = [...candidateSet].every((word) => authoredSet.has(word));
  if (authoredInCandidate && candidateInAuthored) return 1_100;
  if (authoredInCandidate) return 860 - Math.min(120, (candidateSet.size - authoredSet.size) * 15);
  if (candidateInAuthored
    && candidateSet.size >= 1
    && candidateSet.size / authoredSet.size >= 0.5) {
    return 760 - Math.min(100, (authoredSet.size - candidateSet.size) * 20);
  }
  const overallCoverage = shared.length / Math.max(authoredSet.size, candidateSet.size);
  const candidateCoverage = candidateSet.size > 0 ? shared.length / candidateSet.size : 0;
  if (shared.length >= 2 && overallCoverage >= 0.7) {
    return Math.round(650 + (overallCoverage * 80));
  }
  // `authoredName` can be a full planner-authored instruction sentence
  // (e.g. "...click its header or expand control and wait for it to open..."),
  // while `candidateName` is a concise UI label (e.g. "Save Changes", "Add
  // Reference"). If candidate words are ~fully contained in the authored
  // sentence (candidateCoverage >= 0.8), allow the match even when
  // overallCoverage is low relative to a long instruction — but only for
  // candidates with >= 2 words. A single-word candidate ("Open", "Add",
  // "Save") always hits candidateCoverage = 1.0 off ONE incidental shared
  // verb — reproduced live: an unrelated "Open" button scored as an exact
  // match for an Expand operation purely because the authored instruction
  // said "...wait for it to open...". Requiring 2+ candidate words means the
  // bypass only fires on genuine multi-word label containment, not a single
  // common-verb coincidence.
  if (shared.length >= 1 && (overallCoverage >= 0.3 || (candidateCoverage >= 0.8 && candidateSet.size >= 2))) {
    const effectiveCoverage = Math.max(overallCoverage, candidateCoverage * 0.7);
    return Math.round(500 + (shared.length * 100) + (effectiveCoverage * 50));
  }
  return 0;
}

function roleIntentScore(operation, candidate) {
  const authoredRole = clean(operation.targetIdentity?.role).toLowerCase();
  const role = clean(candidate.role).toLowerCase();
  if (authoredRole && authoredRole !== role) return null;
  const compatibleRoles = roleSetFor(operation);
  if (compatibleRoles && role && !compatibleRoles.has(role)) return null;

  let score = 0;
  const targetText = token(targetNamesFor(operation)[0]);
  const checkKind = token(operation?.operationCheck?.kind);
  if (['Fill', 'Type', 'Clear'].includes(operation.type)) {
    score += role === 'textbox' ? 180
      : role === 'searchbox' ? 170
        : role === 'spinbutton' ? 160
          : role === 'combobox' ? 120
            : 0;
  } else if (['Select', 'Time'].includes(operation.type)) {
    score += role === 'combobox' ? 210 : role === 'button' ? 120 : role === 'textbox' ? 90 : 0;
  } else if (['Date', 'DateTime'].includes(operation.type)) {
    score += role === 'textbox' ? 320 : role === 'combobox' ? 290 : role === 'button' ? 150 : 0;
  } else if (operation.type === 'Expand') {
    score += role === 'button' ? 190 : role === 'tab' ? 120 : 0;
  } else if (['Click', 'Submit', 'DoubleClick'].includes(operation.type)) {
    if (checkKind === 'menu_opened') {
      score += role === 'combobox' ? 240
        : role === 'button' ? 220
          : role === 'menuitem' ? 180
            : role === 'link' ? 20
              : 0;
    } else {
      score += role === 'button' ? 130 : role === 'link' ? 120 : role === 'menuitem' ? 110 : 0;
    }
  } else if (operation.type === 'Scroll') {
    score += role === 'region' ? 100 : role === 'group' ? 90 : role === 'heading' ? 80 : 0;
  }

  if (/\b(?:dropdown|combobox|listbox)\b/.test(targetText)) {
    score += role === 'combobox' ? 150 : role === 'button' ? 100 : role === 'textbox' ? 50 : 0;
  }
  if (/\b(?:calendar|date picker)\b/.test(targetText)) {
    score += role === 'button' ? 140 : role === 'textbox' ? 100 : 0;
  }
  if (/\b(?:field|textbox|input)\b/.test(targetText)) {
    score += role === 'textbox' ? 110
      : role === 'searchbox' ? 100
        : role === 'spinbutton' ? 90
          : role === 'combobox' ? 70
            : 0;
  }
  return score;
}

function contextIntentScore(operation, candidate) {
  let score = 0;
  for (const field of ['form', 'section']) {
    const authored = clean(operation?.targetIdentity?.[field]);
    const observed = clean(candidate?.[field]);
    if (!authored || !observed) continue;
    const lexical = lexicalMatchScore(authored, observed);
    score += lexical >= 900 ? 140 : lexical >= 650 ? 70 : -160;
  }
  return score;
}

function candidateIdentityNames(candidate) {
  return [
    candidate?.accessibleName,
    candidate?.name,
    candidate?.placeholder,
    candidate?.value,
    candidate?.id,
    ...(Array.isArray(candidate?.semanticNames) ? candidate.semanticNames : []),
    candidate?.section,
    candidate?.form,
  ].map(clean).filter(Boolean);
}

function candidateLocalIdentityNames(candidate) {
  return [
    candidate?.accessibleName,
    candidate?.name,
    candidate?.placeholder,
    candidate?.value,
    candidate?.id,
    ...(Array.isArray(candidate?.controlLabels) ? candidate.controlLabels : []),
  ].map(clean).filter(Boolean);
}

const TEMPORAL_CONTROL_WORDS = new Set([
  'calendar', 'combobox', 'control', 'date', 'dropdown', 'field',
  'input', 'picker', 'select', 'time', 'timezone', 'zone',
]);

function temporalControlFamily(value) {
  const normalized = token(value).replace(/\btimezone\b/g, 'time zone');
  if (/\btime\s+zone\b/.test(normalized)) return 'time_zone';
  const hasDate = /\bdate\b/.test(normalized);
  const hasTime = /\btime\b/.test(normalized);
  if (hasDate && hasTime) return 'date_time';
  if (hasDate) return 'date';
  if (hasTime) return 'time';
  return null;
}

function candidateLocalTemporalFamily(candidate) {
  const scopeLabels = Array.isArray(candidate?.scopeLabels)
    ? candidate.scopeLabels.map(clean).filter(Boolean)
    : [];
  const controlLabels = Array.isArray(candidate?.controlLabels)
    ? candidate.controlLabels.map(clean).filter(Boolean)
    : [];
  const structuralLabels = [
    ...controlLabels.slice().reverse(),
    ...scopeLabels.slice().reverse(),
  ];
  for (const label of structuralLabels) {
    const family = temporalControlFamily(label);
    if (family && family !== 'date_time') return family;
  }
  for (const label of candidateLocalIdentityNames(candidate)) {
    const family = temporalControlFamily(label);
    if (family) return family;
  }
  return null;
}

function temporalQualifierWords(value) {
  return semanticWords(value)
    .filter((word) => !TEMPORAL_CONTROL_WORDS.has(word));
}

function candidateTemporalCoordinate(candidate) {
  // The control's own semantic identity is more specific than any ancestor
  // heading such as "Planning Date/Time". Ancestor scope may disambiguate an
  // otherwise generic owner, but it must never override an exact local owner.
  const localCoordinate = candidateLocalIdentityNames(candidate)
    .find((label) => temporalControlFamily(label) === 'date_time');
  if (localCoordinate) return temporalQualifierWords(localCoordinate);

  const scopeLabels = Array.isArray(candidate?.scopeLabels)
    ? candidate.scopeLabels.map(clean).filter(Boolean)
    : [];
  const coordinate = scopeLabels
    .slice()
    .reverse()
    .find((label) => temporalControlFamily(label) === 'date_time');
  if (coordinate) return temporalQualifierWords(coordinate);
  return [];
}

function temporalOwnerCompatible(operation, candidate) {
  const authoredName = targetNamesFor(operation)[0];
  const authoredFamily = temporalControlFamily(authoredName);
  if (!authoredFamily) return true;

  const observedFamily = candidateLocalTemporalFamily(candidate);
  if (observedFamily === 'time_zone' && authoredFamily !== 'time_zone') return false;
  if (authoredFamily === 'time_zone' && observedFamily !== 'time_zone') return false;
  if (authoredFamily === 'date' && observedFamily === 'time') return false;
  if (authoredFamily === 'time' && observedFamily === 'date') return false;

  const authoredQualifiers = temporalQualifierWords(authoredName);
  const observedCoordinate = candidateTemporalCoordinate(candidate);
  if (!authoredQualifiers.length || !observedCoordinate.length) return true;
  const observedWords = new Set(observedCoordinate);
  return authoredQualifiers.every((word) => observedWords.has(word));
}

function semanticControlFamilyCompatible(operation, candidate) {
  if (!temporalOwnerCompatible(operation, candidate)) return false;
  const authored = targetNamesFor(operation)
    .map((value) => token(value).replace(/\btimezone\b/g, 'time zone'))
    .join(' ');
  const observed = candidateIdentityNames(candidate)
    .map((value) => token(value).replace(/\btimezone\b/g, 'time zone'))
    .join(' ');
  const observedLocal = candidateLocalIdentityNames(candidate)
    .map((value) => token(value).replace(/\btimezone\b/g, 'time zone'))
    .join(' ');
  const authoredTimeZone = /\btime\s+zone\b/.test(authored);
  const observedTimeZone = /\btime\s+zone\b/.test(observed);
  const observedLocalTimeZone = /\btime\s+zone\b/.test(observedLocal);
  if (authoredTimeZone) return observedLocalTimeZone || (!observedLocal && observedTimeZone);
  return true;
}

function scoreSemanticCandidate(operation, candidate) {
  if (!semanticControlFamilyCompatible(operation, candidate)) return null;
  const candidateNames = candidateIdentityNames(candidate);
  const compositeCandidateName = clean(candidateNames.join(' '));
  const lexicalCandidateNames = compositeCandidateName
    ? [...candidateNames, compositeCandidateName]
    : candidateNames;
  const lexicalScore = Math.max(
    0,
    ...targetNamesFor(operation).flatMap((name) => (
      lexicalCandidateNames.map((candidateName) => lexicalMatchScore(name, candidateName))
    )),
  );
  if (!lexicalScore) return null;
  const roleScore = roleIntentScore(operation, candidate);
  if (roleScore == null) return null;
  const reference = clean(operation?.targetIdentity?.reference);
  if (reference && reference !== clean(candidate.ref || candidate.reference)) return null;
  return lexicalScore
    + roleScore
    + contextIntentScore(operation, candidate)
    + Math.min(40, Math.max(0, Number(candidate.stability) || 0) / 3)
    + (reference ? 500 : 0);
}

function rankSemanticCandidates(operation, candidates = []) {
  return (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => ({
      candidate,
      score: scoreSemanticCandidate(operation, candidate),
    }))
    .filter((entry) => Number.isFinite(entry.score) && entry.score >= 650)
    .sort((left, right) => (
      right.score - left.score
      || clean(left.candidate.ref).localeCompare(clean(right.candidate.ref))
    ));
}

function diagnosticCandidatesForOperation(operation, candidates = []) {
  const targetWords = new Set(
    targetNamesFor(operation).slice(0, 2).flatMap(semanticWords),
  );
  const interactiveRoles = new Set([
    'button', 'link', 'menuitem', 'tab',
    'textbox', 'searchbox', 'spinbutton', 'combobox',
    'checkbox', 'radio', 'switch',
  ]);
  return (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => {
      const names = [
        candidate.accessibleName,
        ...(Array.isArray(candidate.semanticNames) ? candidate.semanticNames : []),
        candidate.section,
        candidate.form,
      ].map(clean).filter(Boolean);
      const candidateWords = new Set(names.flatMap(semanticWords));
      const sharedWordCount = [...targetWords]
        .filter((word) => candidateWords.has(word))
        .length;
      const compatible = roleIntentScore(operation, candidate) != null;
      return {
        candidate,
        sharedWordCount,
        compatible,
        interactive: interactiveRoles.has(token(candidate.role)),
      };
    })
    .filter((entry) => entry.sharedWordCount > 0 || entry.compatible)
    .sort((left, right) => (
      right.sharedWordCount - left.sharedWordCount
        || Number(right.compatible) - Number(left.compatible)
        || Number(right.interactive) - Number(left.interactive)
        || clean(left.candidate.ref).localeCompare(clean(right.candidate.ref))
    ))
    .slice(0, 24)
    .map(({ candidate, sharedWordCount }) => Object.freeze({
      ref: candidate.ref,
      role: candidate.role,
      accessibleName: candidate.accessibleName || null,
      name: candidate.accessibleName
        || (Array.isArray(candidate.semanticNames) ? candidate.semanticNames[0] : null)
        || null,
      semanticNames: Object.freeze(
        (Array.isArray(candidate.semanticNames) ? candidate.semanticNames : [])
          .map(clean)
          .filter(Boolean)
          .slice(0, 4),
      ),
      section: candidate.section || null,
      form: candidate.form || null,
      sharedWordCount,
    }));
}

function proposeTargetRecoveryFromSnapshot({
  operation,
  snapshot,
  candidates = [],
} = {}) {
  const diagnostics = diagnosticCandidatesForOperation(operation, candidates)
    .filter((candidate) => Number(candidate.sharedWordCount) > 0);
  if (!diagnostics.length) return null;
  const first = diagnostics[0];
  const second = diagnostics[1] || null;
  if (second
    && Number(first.sharedWordCount) === Number(second.sharedWordCount)) {
    return null;
  }
  const candidate = candidates.find((item) => clean(item?.ref) === clean(first.ref));
  if (!candidate) return null;
  const accessibleName = clean(
    candidate.accessibleName
      || candidate.name
      || candidate.semanticNames?.[0],
  );
  if (!accessibleName) return null;
  return Object.freeze({
    proposalKind: 'TARGET_REPAIR',
    targetIdentity: Object.freeze({
      accessibleName,
      role: clean(candidate.role) || null,
      form: clean(candidate.form) || null,
      section: clean(candidate.section) || null,
      controlType: clean(candidate.controlType) || null,
      backendNodeId: clean(candidate.backendNodeId) || null,
    }),
    actionType: operation.type,
    supportingFactRefs: Object.freeze([
      ...new Set([
        ...(Array.isArray(candidate.factRefs) ? candidate.factRefs : []),
        ...(candidate.factRef ? [candidate.factRef] : []),
        ...(Array.isArray(snapshot?.factRefs) ? snapshot.factRefs : []),
      ].map(clean).filter(Boolean)),
    ]),
    observedUnexpectedState: 'authored target required a verified live semantic repair',
  });
}

function semanticCandidateMatches(operation, candidate) {
  const authoredName = clean(operation.targetIdentity?.accessibleName || operation.targetIdentity?.label);
  if (!authoredName) return false;
  return Number.isFinite(scoreSemanticCandidate(operation, candidate));
}

function lineForRef(snapshotText, ref) {
  return snapshotText.split(/\r?\n/).find((line) => (
    new RegExp(`\\[ref=${String(ref).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`).test(line)
  )) || '';
}

function expectedStrings(value) {
  if (value == null) return [];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [clean(value)].filter(Boolean);
  }
  if (Array.isArray(value)) return value.flatMap(expectedStrings);
  if (typeof value !== 'object') return [];
  return [
    value.text,
    value.visibleText,
    value.title,
    value.titleIncludes,
    value.url,
    value.urlPattern,
    value.target,
    value.expected,
    value.value,
  ].flatMap(expectedStrings);
}

function snapshotContains(snapshotText, value) {
  const haystack = token(snapshotText);
  return expectedStrings(value).some((expected) => haystack.includes(token(expected)));
}

function conditionSubject(predicate, suffix) {
  return clean(predicate)
    .replace(/^the\s+/i, '')
    .replace(suffix, '')
    .replace(/\s+(?:prompt|section|control|option|field)$/i, '')
    .trim();
}

function semanticTextPresent(snapshotText, subject) {
  const subjectWords = words(subject);
  if (!subjectWords.length) return false;
  const haystackWords = words(snapshotText);
  return subjectWords.every((word) => haystackWords.includes(word));
}

function candidateIsVisible(candidate) {
  if (!candidate) return false;
  if (candidate.hidden === true || candidate.visible === false) return false;
  if (candidate.bounds && (candidate.bounds.width === 0 || candidate.bounds.height === 0)) return false;
  return true;
}

function narrowByVisibility(matches) {
  if (matches.length <= 1) return matches;
  const visible = matches.filter(candidateIsVisible);
  return visible.length ? visible : matches;
}

function narrowByState(matches, stateFilter) {
  if (matches.length <= 1) return matches;
  const visibleMatches = narrowByVisibility(matches);
  if (typeof stateFilter !== 'function' || visibleMatches.length <= 1) return visibleMatches;
  const stateful = visibleMatches.filter(stateFilter);
  return stateful.length ? stateful : visibleMatches;
}

function candidatesForCondition(operation, candidates, subject, stateFilter) {
  const exactOperationCandidates = candidates.filter((candidate) => (
    semanticCandidateMatches(operation, candidate)
  ));
  if (exactOperationCandidates.length) return narrowByState(exactOperationCandidates, stateFilter);
  const subjectWords = words(subject);
  const wordMatches = candidates.filter((candidate) => {
    const candidateWords = words(candidate.accessibleName || candidate.name);
    return subjectWords.length > 0
      && subjectWords.every((word) => candidateWords.includes(word));
  });
  return narrowByState(wordMatches, stateFilter);
}

function candidateCarriesExpandState(snapshotText, candidate) {
  const role = clean(candidate.role).toLowerCase();
  const parentRole = clean(candidate?.parentRole || candidate?.containerRole).toLowerCase();
  if (['button', 'tab'].includes(role) || ['button', 'tab'].includes(parentRole)) return true;
  const line = lineForRef(snapshotText, candidate.ref);
  return /\[expanded(?:=|\])|expanded\s*(?:=|:)\s*(?:true|false)|\bcollapsed\b/i.test(line);
}

function extractCandidateValue(snapshotText, ref, candidate = null) {
  if (candidate?.value) return clean(candidate.value);
  if (candidate?.accessibleValue) return clean(candidate.accessibleValue);
  if (candidate?.text) return clean(candidate.text);
  if (!snapshotText) return '';

  const lines = String(snapshotText || '').split(/\r?\n/);
  let idx = -1;
  if (ref) {
    const refPattern = new RegExp(`\\[ref=${String(ref).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\]`);
    idx = lines.findIndex((l) => refPattern.test(l));
  }
  if (idx === -1 && candidate?.label) {
    const cleanLabel = String(candidate.label).split(/and press|whose current|field/i)[0].trim();
    if (cleanLabel) {
      const labelPattern = new RegExp(`textbox\\s+["']?${cleanLabel.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}`, 'i');
      idx = lines.findIndex((l) => labelPattern.test(l));
    }
  }
  if (idx === -1) return '';

  const currentLine = lines[idx] || '';
  // Match `: value` at line end, or `[ref=e2]: value`, or `: value [ref=e2]`
  const colonMatch = currentLine.match(/:\s*["']?([^"'\],\]\n\r]+)["']?\s*(?:\[ref=\w+\])?$/i)
    || currentLine.match(/\[ref=\w+\]\s*:\s*["']?([^"'\],\]\n\r]+)["']?/i);
  if (colonMatch) {
    const val = (colonMatch[1] || '').trim();
    if (val && !/^(textbox|searchbox|button|combobox|input)$/i.test(val)) return val;
  }

  const inlineMatch = currentLine.match(/(?:value|val)\s*[:=]\s*["']?([^"'\],\]\n\r]+)["']?|\[value\s*[:=]\s*["']?([^"'\],\]\n\r]+)["']?\]/i);
  if (inlineMatch) {
    const val = (inlineMatch[1] || inlineMatch[2] || '').trim();
    if (val && !/^(textbox|searchbox|button|combobox)$/i.test(val)) return val;
  }

  for (let i = idx + 1; i < Math.min(lines.length, idx + 5); i++) {
    const childLine = lines[i] || '';
    if (/^\s*-\s+(?:textbox|generic|button|input|textarea|link|heading|list)/i.test(childLine) && i > idx + 1) break;
    const textMatch = childLine.match(/^\s*-\s*(?:text|\/value|value)\s*:\s*["']?([^"'\n\r]+)["']?/i);
    if (textMatch) {
      const val = (textMatch[1] || '').trim();
      if (val) return val;
    }
  }
  return '';
}

function candidateCarriesSelectionState(snapshotText, candidate) {
  const role = clean(candidate.role).toLowerCase();
  if (['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab'].includes(role)) {
    return true;
  }
  const line = lineForRef(snapshotText, candidate.ref);
  return /\bchecked\b|\bselected\b|aria-checked\s*=|aria-selected\s*=/i.test(line);
}

function accordionStateFromSnapshot(operation, snapshotText, candidate) {
  if (!candidate?.ref) return null;
  const line = lineForRef(snapshotText, candidate.ref);
  if (!line) return null;
  if (/\bcollapsed\b|expanded\s*(?:=|:)?\s*false|\[expanded=false\]/i.test(line)) {
    return false;
  }
  if (/\bexpanded\b(?:\s*(?:=|:)?\s*true)?|\[expanded\]/i.test(line)) {
    return true;
  }
  const role = clean(candidate.role).toLowerCase();
  const typedAccordion = ['Expand', 'Collapse'].includes(clean(operation?.type));
  if (typedAccordion && ['button', 'tab'].includes(role)) {
    // Playwright's accessibility snapshot emits `[expanded]` for the true state
    // and omits it for the false state. This inference is restricted to an exact
    // typed accordion owner; an arbitrary button must never acquire toggle state.
    return false;
  }
  return null;
}

function evaluateOptionalCondition(operation, snapshotText, candidates = []) {
  const predicate = clean(operation?.condition?.predicate);
  if (!predicate) return Object.freeze({ value: true, reason: 'no_optional_predicate' });

  if (/\s+is\s+visible$/i.test(predicate)) {
    const subject = conditionSubject(predicate, /\s+is\s+visible$/i);
    const visible = semanticTextPresent(snapshotText, subject);
    return Object.freeze({
      value: visible,
      reason: visible ? 'optional_subject_visible' : 'optional_subject_absent',
      subject,
    });
  }

  if (/\s+is\s+collapsed$/i.test(predicate)) {
    const subject = conditionSubject(predicate, /\s+is\s+collapsed$/i);
    const matched = candidatesForCondition(
      operation,
      candidates,
      subject,
      (candidate) => candidateCarriesExpandState(snapshotText, candidate),
    );
    if (matched.length !== 1) {
      return Object.freeze({
        value: null,
        reason: matched.length > 1
          ? 'optional_collapsed_owner_ambiguous'
          : 'optional_collapsed_owner_not_found',
        subject,
      });
    }
    const expanded = accordionStateFromSnapshot(operation, snapshotText, matched[0]);
    if (expanded === false) {
      return Object.freeze({ value: true, reason: 'optional_owner_collapsed', subject });
    }
    if (expanded === true) {
      return Object.freeze({ value: false, reason: 'optional_owner_already_expanded', subject });
    }
    return Object.freeze({ value: null, reason: 'optional_collapsed_state_unavailable', subject });
  }

  if (/\s+is\s+not\s+already\s+selected$/i.test(predicate)) {
    const subject = conditionSubject(predicate, /\s+is\s+not\s+already\s+selected$/i);
    const matched = candidatesForCondition(
      operation,
      candidates,
      subject,
      (candidate) => candidateCarriesSelectionState(snapshotText, candidate),
    );
    if (matched.length !== 1) {
      return Object.freeze({
        value: null,
        reason: matched.length > 1
          ? 'optional_selected_owner_ambiguous'
          : 'optional_selected_owner_not_found',
        subject,
      });
    }
    const line = lineForRef(snapshotText, matched[0].ref);
    const selected = /\bchecked\b|\bselected\b|aria-checked\s*=\s*["']?true/i.test(line);
    return Object.freeze({
      value: !selected,
      reason: selected ? 'optional_owner_already_selected' : 'optional_owner_not_selected',
      subject,
    });
  }

  if (snapshotContains(snapshotText, predicate)) {
    return Object.freeze({ value: true, reason: 'optional_predicate_exactly_observed' });
  }
  return Object.freeze({ value: null, reason: 'optional_predicate_uncheckable' });
}

function candidateForOperation(operation, candidates) {
  const ranked = rankSemanticCandidates(operation, candidates);
  if (!ranked.length) return { status: RESOLUTION_STATUS.NOT_FOUND, candidates: [] };
  return {
    status: RESOLUTION_STATUS.RESOLVED,
    candidate: ranked[0].candidate,
    score: ranked[0].score,
  };
}

function firstLaterSemanticOperation(laterOperations = []) {
  return (Array.isArray(laterOperations) ? laterOperations : []).find((operation) => (
    operation?.kind !== 'synchronization'
      && operation?.type !== 'WaitForState'
      && Boolean(clean(
        operation?.targetIdentity?.accessibleName
          || operation?.targetIdentity?.label
          || operation?.target,
      ))
  )) || null;
}

function firstLaterActionOperation(laterOperations = []) {
  return (Array.isArray(laterOperations) ? laterOperations : []).find((operation) => (
    operation?.kind === 'action'
      && operation?.type !== 'WaitForState'
      && Boolean(clean(
        operation?.targetIdentity?.accessibleName
          || operation?.targetIdentity?.label
          || operation?.target,
      ))
  )) || null;
}

function exactNextRequiredControl({
  phase,
  ownerVisible,
  laterOperations,
  candidates,
} = {}) {
  const nextOperation = firstLaterActionOperation(laterOperations);
  if (!nextOperation) return false;
  const resolved = candidateForOperation(
    nextOperation,
    Array.isArray(candidates) ? candidates : [],
  ).status === RESOLUTION_STATUS.RESOLVED;
  if (!resolved) return false;
  return phase !== 'pre_dispatch' || ownerVisible !== true;
}

function exactNextAuthoredActionControl({
  phase,
  ownerVisible,
  laterOperations,
  candidates,
} = {}) {
  const nextOperation = firstLaterActionOperation(laterOperations);
  if (!nextOperation) return false;
  const resolved = candidateForOperation(
    nextOperation,
    Array.isArray(candidates) ? candidates : [],
  ).status === RESOLUTION_STATUS.RESOLVED;
  if (!resolved) return false;
  return phase !== 'pre_dispatch' || ownerVisible !== true;
}

function exactAuthoredDestinationReached({
  operation,
  phase,
  ownerVisible,
  snapshotText,
} = {}) {
  const reached = snapshotContains(snapshotText, operation?.destination);
  if (!reached) return false;
  if (phase !== 'pre_dispatch') return true;

  // A source control often shares text with its destination ("Orders" is both
  // a navigation link and a page heading). Its presence before dispatch is not
  // proof that navigation already happened. Pre-dispatch satisfaction is valid
  // only when the exact source owner has disappeared and a destination fact is
  // independently observable.
  return ownerVisible === false;
}

function exactLaterAuthoredAssertion({
  laterOperations,
  snapshotText,
  candidates,
} = {}) {
  return (Array.isArray(laterOperations) ? laterOperations : [])
    .filter((candidate) => candidate?.kind === 'assertion')
    .some((candidate) => (
      candidateForOperation(
        candidate,
        Array.isArray(candidates) ? candidates : [],
      ).status === RESOLUTION_STATUS.RESOLVED
        || targetNamesFor(candidate).some((name) => snapshotContains(snapshotText, name))
    ));
}

function exactWaitStateReached({
  operation,
  snapshotText,
  candidates,
} = {}) {
  const authoredWait = clean(
    operation?.targetIdentity?.accessibleName
      || operation?.targetIdentity?.label
      || operation?.target,
  );
  if (/^(?:inspect|check|observe)\s+the\s+current\s+page\s+for\b/i.test(authoredWait)) {
    return Boolean(clean(snapshotText));
  }
  const targetName = clean(
    operation?.targetIdentity?.accessibleName
      || operation?.targetIdentity?.label,
  );
  const targetReached = Boolean(targetName) && (
    candidateForOperation(
      operation,
      Array.isArray(candidates) ? candidates : [],
    ).status === RESOLUTION_STATUS.RESOLVED
      || snapshotContains(snapshotText, targetName)
  );
  return targetReached
    || snapshotContains(snapshotText, operation?.expected)
    || snapshotContains(snapshotText, operation?.destination);
}

function exactPageTransitionCommitted({
  phase,
  preDispatchObservation,
  currentUrl,
} = {}) {
  const preDispatchUrl = clean(preDispatchObservation?.url);
  const observedUrl = clean(currentUrl);
  // Not gated on operation.operationCheck.kind === 'page_ready' — an
  // authoring flag the Architect almost never sets on a plain "Click the X
  // button" step even when clicking X does navigate, which made this claim
  // structurally unreachable for most navigating clicks (LetCode's "Goto
  // Home" click timed out because of exactly this).
  // Not gated on ownerVisible === false either — a persistent nav link
  // (e.g. "Goto Home" present in the header on every page, including the
  // home page itself) never disappears, so that condition blocked this
  // claim even after the operationCheck fix. A genuine URL change is
  // sufficient evidence of a real transition on its own.
  return phase === 'post_dispatch'
    && Boolean(preDispatchUrl)
    && Boolean(observedUrl)
    && token(preDispatchUrl) !== token(observedUrl);
}

function minimumCandidateCountForObservation(operation, phase) {
  if (operation?.type === 'Navigate') return 0;
  if (phase === 'post_dispatch'
    && clean(operation?.operationCheck?.kind).toLowerCase() === 'page_ready') return 0;
  return 1;
}

function popupAssociationEvidence({
  phase,
  ownerRef,
  ownerExpanded,
  popupCandidates = [],
  preDispatchObservation = null,
  popupOwnershipReadback = null,
} = {}) {
  const currentPopupCandidates = Array.isArray(popupCandidates) ? popupCandidates : [];
  if (!currentPopupCandidates.length) {
    return Object.freeze({
      matched: false,
      reason: 'popup_surface_not_observed',
      newPopupCandidateCount: 0,
    });
  }

  const exactOwnerRef = clean(ownerRef);
  const explicitOwnedCandidates = currentPopupCandidates.filter((candidate) => clean(
    candidate?.ownerRef
      || candidate?.ownerBackendNodeId
      || candidate?.associatedOwnerId
      || candidate?.ownerIdentity?.ref
      || candidate?.ownerIdentity?.backendNodeId,
  ));
  if (explicitOwnedCandidates.length) {
    const matched = explicitOwnedCandidates.some((candidate) => clean(
      candidate?.ownerRef
        || candidate?.ownerBackendNodeId
        || candidate?.associatedOwnerId
        || candidate?.ownerIdentity?.ref
        || candidate?.ownerIdentity?.backendNodeId,
    ) === exactOwnerRef);
    return Object.freeze({
      matched,
      reason: matched
        ? 'popup_explicitly_owned_by_exact_control'
        : 'popup_explicitly_owned_by_different_control',
      newPopupCandidateCount: 0,
    });
  }

  const exactControlledPopupCount = Number(popupOwnershipReadback?.controlledPopupCount) || 0;
  if (popupOwnershipReadback?.ok === true && exactControlledPopupCount > 0) {
    return Object.freeze({
      matched: true,
      reason: 'exact_owner_controls_visible_popup',
      newPopupCandidateCount: 0,
    });
  }
  return Object.freeze({
    matched: false,
    reason: ownerExpanded === true
      ? 'expanded_owner_popup_relationship_unproven'
      : 'popup_owner_correlation_unavailable',
    newPopupCandidateCount: 0,
  });
}

function claim(claimId, status, factRef, reason, tier = EVIDENCE_TIER.EXACT_LIVE_OWNER_OR_DESTINATION) {
  return Object.freeze({
    claimId,
    status,
    tier,
    source: String(factRef || '').includes('controller-dom-readback')
      ? 'controller_dom_readback'
      : 'controller_mcp_snapshot',
    factRef,
    fresh: true,
    reason,
  });
}

function createControllerMcpRuntimeAdapter({
  session,
  operations = [],
  cancelToken = null,
  journal = null,
  now = Date.now,
  send = () => {},
} = {}) {
  if (!session?.client || session.authorityMode !== 'browser_transaction_controller') {
    throw new ControllerMcpRuntimeAdapterError(
      'Controller MCP adapter requires an exclusive controller-authority session.',
      'CONTROLLER_MCP_AUTHORITY_MODE_REQUIRED',
    );
  }
  let browserEpoch = 1;
  let latest = null;
  // Phase 30.0 — passive locator-evidence capture. The resolver below already
  // finds the exact MCP ref it is about to act on; this map only *remembers*
  // that ref per operation so a post-case, non-blocking hook (see
  // captureVerifiedLocator) can independently re-verify a codegen-grade
  // Playwright locator for it afterward. Nothing here changes what the
  // resolver returns or how dispatch behaves.
  const resolvedRefByOperation = new Map();

  const rawCall = async (toolName, args, remainingMs) => {
    if (session.closed || cancelToken?.cancelled || cancelToken?.signal?.aborted) {
      throw new ControllerMcpRuntimeAdapterError(
        'Browser session is no longer available.',
        'CONTROLLER_MCP_SESSION_LOST',
      );
    }
    const timeoutMs = Math.max(100, Math.min(60_000, Number(remainingMs) || 5_000));
    let timer;
    try {
      return await Promise.race([
        session.client.callTool(
          { name: toolName, arguments: args || {} },
          undefined,
          { signal: cancelToken?.signal || undefined, timeout: timeoutMs },
        ),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`Raw controller MCP ${toolName} exceeded ${timeoutMs}ms.`);
            error.code = 'CONTROLLER_MCP_TRANSPORT_TIMEOUT';
            reject(error);
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const capture = async ({ remainingMs } = {}) => {
    if (session.closed) return { sessionLost: true, browserAlive: false, sources: [] };
    let result;
    try {
      result = await rawCall('browser_snapshot', {}, remainingMs);
    } catch (error) {
      return {
        captureError: error,
        browserEpoch: String(browserEpoch),
        capturedAtMs: Number(now()),
        sources: [],
      };
    }
    const snapshotText = textOfResult(result);
    const metadata = pageMetadata(snapshotText);
    if (snapshotText) {
      session.lastSnapshot = snapshotText;
      if (metadata.url) session.currentUrl = metadata.url;
    }
    const snapshotId = `controller-snapshot:${crypto.randomUUID()}`;
    const candidates = dedupeCandidates(snapshotText, browserEpoch);
    latest = Object.freeze({
      snapshotId,
      snapshotText,
      candidates,
      url: metadata.url || session.currentUrl || null,
      title: metadata.title || null,
      capturedAtMs: Number(now()),
      browserEpoch: String(browserEpoch),
      sources: Object.freeze([
        SNAPSHOT_SOURCE.BROWSER_SNAPSHOT,
        SNAPSHOT_SOURCE.DOM,
        SNAPSHOT_SOURCE.ACCESSIBILITY,
        SNAPSHOT_SOURCE.PLAYWRIGHT,
      ]),
      domNodeCount: candidates.length,
      axNodeCount: candidates.length,
      factRefs: Object.freeze([`fact:${snapshotId}`]),
      failed: result?.isError === true,
      captureError: result?.isError === true ? textOfResult(result) || 'browser_snapshot_error' : null,
    });
    return latest;
  };

  const snapshots = createBrowserSnapshotLifecycle({
    capture,
    now,
    maxAgeMs: 1_250,
    defaultAttempts: 5,
    retryIntervalMs: 250,
    heartbeat: (event) => send({
      type: 'controller.snapshot',
      ...event,
      snapshotId: latest?.snapshotId || null,
      browserEpoch: latest?.browserEpoch || String(browserEpoch),
      url: latest?.url || session.currentUrl || null,
      title: latest?.title || null,
      candidateCount: latest?.candidates?.length || 0,
      snapshotCharCount: latest?.snapshotText?.length || 0,
      snapshotLineCount: latest?.snapshotText
        ? latest.snapshotText.split(/\r?\n/).length
        : 0,
      snapshotPreview: diagnosticSnapshotPreview(
        latest?.snapshotText,
        latest?.candidates?.length || 0,
      ),
      candidates: Object.freeze((latest?.candidates || []).slice(0, 40).map((candidate) => ({
        ref: candidate.ref,
        role: candidate.role,
        name: candidate.accessibleName || candidate.name || null,
        section: candidate.section || null,
      }))),
    }),
  });

  const acquire = async ({
    forceFresh = false,
    remainingMs = 2_000,
    minimumCandidateCount = 0,
    reason,
  } = {}) => {
    const deadlineAtMs = Number(now()) + Math.max(100, Number(remainingMs) || 2_000);
    return snapshots.acquire({
      browserEpoch: String(browserEpoch),
      requiredSources: [
        SNAPSHOT_SOURCE.BROWSER_SNAPSHOT,
        SNAPSHOT_SOURCE.DOM,
        SNAPSHOT_SOURCE.ACCESSIBILITY,
        SNAPSHOT_SOURCE.PLAYWRIGHT,
      ],
      forceFresh,
      minimumCandidateCount,
      deadlineAtMs,
      reason,
    });
  };

  const resolver = async ({ operation, remainingMs, context = {} }) => {
    if (cancelToken?.cancelled || cancelToken?.signal?.aborted) {
      return {
        status: RESOLUTION_STATUS.SESSION_LOST,
        reason: 'user_cancelled',
        factRefs: [],
      };
    }
    if (session.closed) {
      return {
        status: RESOLUTION_STATUS.SESSION_LOST,
        reason: 'browser_session_lost',
        factRefs: [],
      };
    }
    const isTargetOptional = ['Navigate', 'Scroll', 'PressKey', 'Screenshot', 'SwitchContext'].includes(operation.type)
      || (!operation.targetIdentity?.label && !operation.targetIdentity?.accessibleName && !operation.targetIdentity?.reference);
    if (operation.kind !== 'action' || isTargetOptional) {
      return {
        status: RESOLUTION_STATUS.RESOLVED,
        target: {
          ref: null,
          identity: operation.targetIdentity || {},
          synthetic: true,
        },
        factRefs: [],
      };
    }
    let snapshot = await acquire({
      forceFresh: context.forceFreshSnapshot === true,
      remainingMs,
      minimumCandidateCount: 1,
      reason: `resolve:${operation.operationId}`,
    });
    if (snapshot.status === SNAPSHOT_STATUS.SESSION_LOST) {
      return { status: RESOLUTION_STATUS.SESSION_LOST, reason: snapshot.reason, factRefs: snapshot.factRefs };
    }
    if (snapshot.status !== SNAPSHOT_STATUS.VALID) {
      return { status: RESOLUTION_STATUS.STALE, reason: snapshot.reason, factRefs: snapshot.factRefs };
    }
    if (operation.optional && operation.condition?.predicate) {
      let condition = evaluateOptionalCondition(
        operation,
        snapshot.snapshot.snapshotText,
        snapshot.snapshot.candidates,
      );
      if (condition.value == null) {
        snapshot = await acquire({
          forceFresh: true,
          remainingMs,
          minimumCandidateCount: 1,
          reason: `optional-condition:${operation.operationId}`,
        });
        if (snapshot.status === SNAPSHOT_STATUS.SESSION_LOST) {
          return { status: RESOLUTION_STATUS.SESSION_LOST, reason: snapshot.reason, factRefs: snapshot.factRefs };
        }
        if (snapshot.status !== SNAPSHOT_STATUS.VALID) {
          return { status: RESOLUTION_STATUS.STALE, reason: snapshot.reason, factRefs: snapshot.factRefs };
        }
        condition = evaluateOptionalCondition(
          operation,
          snapshot.snapshot.snapshotText,
          snapshot.snapshot.candidates,
        );
      }
      if (condition.value === false) {
        return {
          status: RESOLUTION_STATUS.OPTIONAL_ABSENT,
          reason: condition.reason,
          factRefs: snapshot.factRefs,
        };
      }
      if (condition.value == null) {
        return {
          status: RESOLUTION_STATUS.STALE,
          reason: condition.reason,
          factRefs: snapshot.factRefs,
        };
      }
    }
    const resolved = candidateForOperation(operation, snapshot.snapshot.candidates);
    if (resolved.status !== RESOLUTION_STATUS.RESOLVED) {
      const diagnosticCandidates = diagnosticCandidatesForOperation(
        operation,
        snapshot.snapshot.candidates,
      );
      send({
        type: 'controller.resolution-diagnostic',
        operationId: operation.operationId,
        resolutionStatus: resolved.status,
        reason: resolved.status === RESOLUTION_STATUS.AMBIGUOUS
          ? 'multiple_semantic_snapshot_targets'
          : 'semantic_snapshot_target_not_found',
        browserEpoch: snapshot.snapshot.browserEpoch,
        url: snapshot.snapshot.url || null,
        target: clean(
          operation?.targetIdentity?.accessibleName
            || operation?.targetIdentity?.label,
        ) || null,
        candidateCount: snapshot.snapshot.candidates.length,
        candidates: Object.freeze(diagnosticCandidates),
      });
      if (journal?.appendObservation) {
        await journal.appendObservation(observation(OBSERVER_ROLE.RESOLVER, {
          eventType: 'SEMANTIC_RESOLUTION_DIAGNOSTIC',
          operationId: operation.operationId,
          resolutionStatus: resolved.status,
          reason: resolved.status === RESOLUTION_STATUS.AMBIGUOUS
            ? 'multiple_semantic_snapshot_targets'
            : 'semantic_snapshot_target_not_found',
          browserEpoch: snapshot.snapshot.browserEpoch,
          url: snapshot.snapshot.url || null,
          target: clean(
            operation?.targetIdentity?.accessibleName
              || operation?.targetIdentity?.label,
          ) || null,
          candidateCount: snapshot.snapshot.candidates.length,
          candidates: diagnosticCandidates,
          structuralExcerpt: structuralExcerpt(
            snapshot.snapshot.snapshotText,
            diagnosticCandidates.map((candidate) => candidate.ref),
          ),
        })).catch(() => null);
      }
      return {
        status: resolved.status,
        reason: resolved.status === RESOLUTION_STATUS.AMBIGUOUS
          ? 'multiple_semantic_snapshot_targets'
          : 'semantic_snapshot_target_not_found',
        matchingCandidates: resolved.candidates,
        factRefs: snapshot.factRefs,
      };
    }
    const temporalTargetName = clean(
      operation?.targetIdentity?.accessibleName
        || operation?.targetIdentity?.label,
    );
    const clockValuedSelect = operation.type === 'Select'
      && Boolean(normalizeTime(operation.value || selectionValue(operation.selection)))
      && /\btime\b/i.test(temporalTargetName)
      && !/\btime\s*zone\b|\btimezone\b/i.test(temporalTargetName);
    if (['Date', 'DateTime', 'Time'].includes(operation.type) || clockValuedSelect) {
      const temporalKind = ['Date', 'DateTime'].includes(operation.type) ? 'DATE' : 'TIME';
      const dateResolutionDiagnostic = {
        type: 'controller.resolution-diagnostic',
        operationId: operation.operationId,
        resolutionStatus: resolved.status,
        reason: `typed_${temporalKind.toLowerCase()}_owner_resolved`,
        ref: resolved.candidate.ref,
        interactionRef: resolved.candidate.interactionRef || null,
        role: resolved.candidate.role,
        name: resolved.candidate.accessibleName || resolved.candidate.name || null,
        section: resolved.candidate.section || null,
      };
      send(dateResolutionDiagnostic);
      if (journal?.appendObservation) {
        await journal.appendObservation(observation(OBSERVER_ROLE.RESOLVER, {
          eventType: `TYPED_${temporalKind}_OWNER_RESOLVED`,
          ...dateResolutionDiagnostic,
        })).catch(() => null);
      }
    }
    if (resolved.candidate.ref) {
      // Side-observation only — does not affect this function's return value.
      // contractStepId/actionOccurrenceId are carried through so the later
      // capture can be bound to this exact authored step (see
      // captureVerifiedLocator) — without them the evidence module correctly
      // refuses to mark even a fully-proven locator as verified/persistable.
      resolvedRefByOperation.set(operation.operationId, {
        ref: resolved.candidate.ref,
        candidate: resolved.candidate,
        elementLabel: temporalTargetName
          || clean(operation?.targetIdentity?.accessibleName || operation?.targetIdentity?.label)
          || null,
        toolName: operation.type || null,
        actionText: clean(operation.action || operation.authoredAction || operation.text || operation.payload) || null,
        pageUrl: snapshot.snapshot.url || null,
        contractStepId: clean(operation.authoredStepId || operation.assertionId) || null,
        actionOccurrenceId: clean(operation.actionOccurrenceId) || null,
      });
    }
    return {
      status: RESOLUTION_STATUS.RESOLVED,
      target: {
        ref: resolved.candidate.ref,
        interactionRef: resolved.candidate.interactionRef || null,
        identity: {
          accessibleName: resolved.candidate.accessibleName,
          role: resolved.candidate.role,
          form: resolved.candidate.form,
          section: resolved.candidate.section,
          framePath: [],
          backendNodeId: null,
        },
        candidate: resolved.candidate,
      },
      factRefs: Object.freeze([...snapshot.factRefs, resolved.candidate.factRef]),
    };
  };

  const observer = async ({
    operation,
    resolution,
    plan,
    phase,
    attempt = 0,
    remainingMs,
    delivery = null,
    context = {},
  }) => {
    const snapshotResult = await acquire({
      forceFresh: phase !== 'pre_dispatch',
      remainingMs,
      minimumCandidateCount: minimumCandidateCountForObservation(operation, phase),
      reason: `observe:${operation.operationId}:${phase}`,
    });
    if (snapshotResult.status === SNAPSHOT_STATUS.SESSION_LOST) {
      return { sessionLost: true, claims: [], factRefs: snapshotResult.factRefs };
    }
    if (snapshotResult.status !== SNAPSHOT_STATUS.VALID) {
      return { claims: [], factRefs: snapshotResult.factRefs, observationStatus: snapshotResult.status };
    }
    const snapshot = snapshotResult.snapshot;
    const snapshotText = snapshot.snapshotText;
    const candidates = snapshot.candidates;
    const resolutionOwnerRef = resolution?.target?.ref;
    const originalOwnerCandidate = resolutionOwnerRef
      ? candidates.find((candidate) => (
        clean(candidate.ref) === clean(resolutionOwnerRef)
          && semanticCandidateMatches(operation, candidate)
      ))
      : null;
    const rerenderedOwnerResolution = !originalOwnerCandidate && phase !== 'pre_dispatch'
      ? candidateForOperation(operation, candidates)
      : null;
    const ownerCandidate = originalOwnerCandidate
      || (rerenderedOwnerResolution?.status === RESOLUTION_STATUS.RESOLVED
        ? rerenderedOwnerResolution.candidate
        : null);
    const ownerRef = ownerCandidate?.ref || resolutionOwnerRef;
    const ownerLine = ownerRef ? lineForRef(snapshotText, ownerRef) : '';
    const authoredSelection = selectionValue(operation.selection);
    let textInputOwnerReadback = null;
    let textInputOwnerFactRef = null;
    const textInputReadbackRequired = clean(plan?.adapterKind).toUpperCase() === 'TEXT_INPUT'
      && ['Fill', 'Type', 'Clear'].includes(clean(operation?.type));
    const isAppendTextOp = Boolean(
      operation?.targetIdentity?.label && /\bappend\b/i.test(operation.targetIdentity.label)
    );
    // Reconstructing the full expected string (pre-append value + fragment)
    // requires the field's value from BEFORE the mutation ran — by the time
    // this observer runs post-dispatch, the field already holds the final
    // text, so re-deriving "existing" from that same snapshot was circular
    // and unreliable. Checking that the result ends with the authored
    // fragment sidesteps needing the prior value at all.
    const appendFragmentValue = clean(plan?.mutation?.args?.text ?? operation?.value ?? '');
    const expectedTextInputValue = isAppendTextOp && appendFragmentValue
      ? appendFragmentValue
      : plan?.proofMetadata?.expectedValue
        ?? plan?.mutation?.args?.text
        ?? operation?.value
        ?? '';
    const textInputMatchMode = isAppendTextOp && appendFragmentValue ? 'endsWith' : 'exact';
    if (textInputReadbackRequired && ownerCandidate && phase !== 'pre_dispatch') {
      const accessibleName = clean(
        ownerCandidate.accessibleName
          || ownerCandidate.name
          || operation?.targetIdentity?.accessibleName
          || operation?.targetIdentity?.label,
      );
      if (accessibleName) {
        try {
          const result = await rawCall('browser_evaluate', {
            element: accessibleName,
            target: ownerRef,
            function: buildBoundTextInputReadFunction({
              expectedValue: expectedTextInputValue,
              actionType: operation.type,
              matchMode: textInputMatchMode,
            }),
          }, Math.min(Math.max(100, Number(remainingMs) || 2_000), 2_000));
          textInputOwnerReadback = evaluatePayload(result);
          textInputOwnerFactRef = `fact:controller-dom-readback:text-input:${crypto.randomUUID()}`;
          const textInputOwnerState = evaluateTextInputReadback({
            readback: textInputOwnerReadback,
            expectedValue: expectedTextInputValue,
            actionType: operation.type,
          });
          if (journal?.appendObservation) {
            await journal.appendObservation(observation(OBSERVER_ROLE.EVIDENCE_READER, {
              eventType: 'EXACT_TEXT_INPUT_OWNER_DOM_READBACK',
              operationId: operation.operationId,
              phase,
              attempt,
              factRef: textInputOwnerFactRef,
              ok: textInputOwnerReadback?.ok === true,
              reason: textInputOwnerState.reason,
              candidateCount: Number(textInputOwnerReadback?.candidateCount) || 0,
              accessibleName,
              role: clean(textInputOwnerReadback?.role) || ownerCandidate.role || null,
              inputType: clean(textInputOwnerReadback?.inputType) || null,
              matched: textInputOwnerState.valueMatched === true,
              ownerStateCommitted: textInputOwnerState.ownerStateCommitted === true,
              stableAcrossSettle: textInputOwnerReadback?.stableAcrossSettle === true,
              ownerConnected: textInputOwnerReadback?.ownerConnected === true,
              matchMode: clean(textInputOwnerReadback?.matchMode) || null,
              valuePresent: textInputOwnerReadback?.valuePresent === true,
              valueLength: Number(textInputOwnerReadback?.valueLength) || 0,
              digitCount: Number(textInputOwnerReadback?.digitCount) || 0,
              disabled: textInputOwnerReadback?.disabled === true,
              readOnly: textInputOwnerReadback?.readOnly === true,
              invalid: textInputOwnerReadback?.invalid === true,
            })).catch(() => null);
          }
        } catch (error) {
          textInputOwnerFactRef = `fact:controller-dom-readback:text-input:${crypto.randomUUID()}`;
          textInputOwnerReadback = {
            ok: false,
            reason: clean(error?.code || error?.name) || 'text_input_owner_readback_failed',
          };
          if (journal?.appendObservation) {
            await journal.appendObservation(observation(OBSERVER_ROLE.EVIDENCE_READER, {
              eventType: 'EXACT_TEXT_INPUT_OWNER_DOM_READBACK',
              operationId: operation.operationId,
              phase,
              attempt,
              factRef: textInputOwnerFactRef,
              ok: false,
              reason: textInputOwnerReadback.reason,
              errorMessage: clean(error?.message).slice(0, 240) || null,
              candidateCount: 0,
              accessibleName,
              matched: false,
              ownerStateCommitted: false,
            })).catch(() => null);
          }
        }
      }
    }
    const textInputOwnerState = textInputReadbackRequired
      ? evaluateTextInputReadback({
        readback: textInputOwnerReadback,
        expectedValue: expectedTextInputValue,
        actionType: operation.type,
      })
      : null;
    let temporalOwnerReadback = null;
    let temporalOwnerFactRef = null;
    const temporalProtocolClaim = clean(plan?.protocolPhase?.requiredClaim);
    if (
      ['normalized_date_owner_value', 'normalized_time_owner_value']
        .includes(temporalProtocolClaim)
      && ownerCandidate
    ) {
      const accessibleName = clean(
        ownerCandidate.accessibleName
          || ownerCandidate.name
          || operation?.targetIdentity?.accessibleName
          || operation?.targetIdentity?.label,
      );
      if (accessibleName) {
        try {
          const result = await rawCall('browser_evaluate', {
            element: accessibleName,
            target: ownerRef,
            function: buildBoundTemporalOwnerReadFunction({
              valueKind: temporalProtocolClaim === 'normalized_time_owner_value'
                ? 'time'
                : 'date',
            }),
          }, Math.min(Math.max(100, Number(remainingMs) || 1_000), 1_500));
          temporalOwnerReadback = evaluatePayload(result);
          temporalOwnerFactRef = `fact:controller-dom-readback:${crypto.randomUUID()}`;
          if (journal?.appendObservation) {
            await journal.appendObservation(observation(OBSERVER_ROLE.EVIDENCE_READER, {
              eventType: 'EXACT_TEMPORAL_OWNER_DOM_READBACK',
              operationId: operation.operationId,
              phase,
              factRef: temporalOwnerFactRef,
              ok: temporalOwnerReadback?.ok === true,
              reason: clean(temporalOwnerReadback?.reason) || 'temporal_owner_readback_unavailable',
              candidateCount: Number(temporalOwnerReadback?.candidateCount) || 0,
              accessibleName: clean(temporalOwnerReadback?.accessibleName) || accessibleName,
              role: clean(temporalOwnerReadback?.role) || null,
              value: clean(temporalOwnerReadback?.value) || null,
              valueCandidateCount: Number(temporalOwnerReadback?.valueCandidateCount) || 0,
              normalizedTemporal: temporalProtocolClaim === 'normalized_time_owner_value'
                ? normalizeTime(temporalOwnerReadback?.value)
                : normalizeDate(temporalOwnerReadback?.value),
            })).catch(() => null);
          }
        } catch (_) {
          temporalOwnerReadback = null;
        }
      }
    }
    let selectionOwnerReadback = null;
    let selectionOwnerFactRef = null;
    let popupOwnershipReadback = null;
    let popupOwnershipFactRef = null;
    const protocolClaim = clean(plan?.protocolPhase?.requiredClaim);
    const selectionAdapterKind = clean(plan?.adapterKind).toUpperCase();
    const selectionOwnerReadbackRequired = authoredSelection != null
      && ['AUTOCOMPLETE', 'CUSTOM_SELECT', 'NATIVE_SELECT'].includes(selectionAdapterKind);
    if (selectionOwnerReadbackRequired && ownerCandidate) {
      const accessibleName = clean(
        ownerCandidate.accessibleName
          || ownerCandidate.name
          || operation?.targetIdentity?.accessibleName
          || operation?.targetIdentity?.label,
      );
      if (accessibleName) {
        try {
          const result = await rawCall('browser_evaluate', {
            element: accessibleName,
            target: ownerRef,
            function: buildBoundSelectionOwnerReadFunction({
              expectedSelection: authoredSelection,
            }),
          }, Math.min(Math.max(100, Number(remainingMs) || 1_000), 1_500));
          selectionOwnerReadback = evaluatePayload(result);
          popupOwnershipReadback = selectionOwnerReadback;
          selectionOwnerFactRef = `fact:controller-selection-owner-readback:${crypto.randomUUID()}`;
          if (journal?.appendObservation) {
            await journal.appendObservation(observation(OBSERVER_ROLE.EVIDENCE_READER, {
              eventType: 'EXACT_SELECTION_OWNER_DOM_READBACK',
              operationId: operation.operationId,
              phase,
              factRef: selectionOwnerFactRef,
              ok: selectionOwnerReadback?.ok === true,
              reason: clean(selectionOwnerReadback?.reason)
                || 'selection_owner_readback_unavailable',
              candidateCount: Number(selectionOwnerReadback?.candidateCount) || 0,
              valueCandidateCount: Number(selectionOwnerReadback?.valueCandidateCount) || 0,
              accessibleName,
              role: clean(selectionOwnerReadback?.role) || ownerCandidate.role || null,
              values: (Array.isArray(selectionOwnerReadback?.values)
                ? selectionOwnerReadback.values
                : [])
                .slice(0, 8)
                .map((entry) => ({
                  value: clean(entry?.value ?? entry),
                  source: clean(entry?.source) || null,
                })),
              matched: selectionOwnerReadback?.matched === true,
              popupOpen: selectionOwnerReadback?.popupOpen === true,
              ownerExpanded: selectionOwnerReadback?.ownerExpanded === true,
              controlledPopupCount: Number(selectionOwnerReadback?.controlledPopupCount) || 0,
              ownedOptionNames: (Array.isArray(selectionOwnerReadback?.ownedOptionNames)
                ? selectionOwnerReadback.ownedOptionNames
                : []).slice(0, 40).map(clean).filter(Boolean),
              invalid: selectionOwnerReadback?.invalid === true,
            })).catch(() => null);
          }
        } catch (_) {
          selectionOwnerReadback = null;
        }
      }
    }
    const popupOwnershipRequired = clean(operation?.operationCheck?.kind).toLowerCase() === 'menu_opened'
      || protocolClaim === 'associated_popup_open';
    if (popupOwnershipRequired && ownerCandidate && !popupOwnershipReadback) {
      const accessibleName = clean(
        ownerCandidate.accessibleName
          || ownerCandidate.name
          || operation?.targetIdentity?.accessibleName
          || operation?.targetIdentity?.label,
      );
      if (accessibleName) {
        try {
          const result = await rawCall('browser_evaluate', {
            element: accessibleName,
            target: ownerRef,
            function: buildBoundPopupOwnershipReadFunction(),
          }, Math.min(Math.max(100, Number(remainingMs) || 1_000), 1_500));
          popupOwnershipReadback = evaluatePayload(result);
          popupOwnershipFactRef = `fact:controller-popup-ownership:${crypto.randomUUID()}`;
          if (journal?.appendObservation) {
            await journal.appendObservation(observation(OBSERVER_ROLE.EVIDENCE_READER, {
              eventType: 'EXACT_POPUP_OWNER_DOM_RELATION',
              operationId: operation.operationId,
              phase,
              factRef: popupOwnershipFactRef,
              ok: popupOwnershipReadback?.ok === true,
              reason: clean(popupOwnershipReadback?.reason) || 'popup_owner_relation_unavailable',
              accessibleName,
              ownerExpanded: popupOwnershipReadback?.ownerExpanded === true,
              controlledPopupCount: Number(popupOwnershipReadback?.controlledPopupCount) || 0,
              relationIds: (Array.isArray(popupOwnershipReadback?.relationIds)
                ? popupOwnershipReadback.relationIds
                : []).slice(0, 8).map(clean).filter(Boolean),
              ownedOptionNames: (Array.isArray(popupOwnershipReadback?.ownedOptionNames)
                ? popupOwnershipReadback.ownedOptionNames
                : []).slice(0, 40).map(clean).filter(Boolean),
            })).catch(() => null);
          }
        } catch (_) {
          popupOwnershipReadback = null;
        }
      }
    }
    const selectionOwnerState = selectionOwnerReadbackRequired
      ? evaluateSelectionOwnerReadback({
        readback: selectionOwnerReadback,
        expectedSelection: authoredSelection,
      })
      : null;
    const semanticOwnerReresolved = Boolean(ownerCandidate && !originalOwnerCandidate);
    if (semanticOwnerReresolved) {
      send({
        type: 'controller.proof-diagnostic',
        operationId: operation.operationId,
        phase,
        message: 'same_semantic_owner_reresolved_after_rerender',
        priorRef: resolutionOwnerRef || null,
        currentRef: ownerCandidate.ref,
        role: ownerCandidate.role,
        name: ownerCandidate.accessibleName || ownerCandidate.name || null,
      });
    }
    const factRef = snapshot.factRefs[0];
    const claims = [];
    const add = (claimId, matched, reason, tier) => claims.push(claim(
      claimId,
      matched === true ? PROOF_STATUS.MATCHED
        : matched === false ? PROOF_STATUS.MISMATCH
          : PROOF_STATUS.UNKNOWN,
      factRef,
      reason,
      tier,
    ));
    const ownerVisible = Boolean(ownerCandidate && ownerLine);
    const selected = authoredSelection;
    const nextRequiredControlMatched = exactNextRequiredControl({
      phase,
      ownerVisible,
      laterOperations: context.laterOperations,
      candidates,
    });
    const nextAuthoredActionControlMatched = exactNextAuthoredActionControl({
      phase,
      ownerVisible,
      laterOperations: context.laterOperations,
      candidates,
    });
    const laterAuthoredAssertionMatched = operation.kind === 'synchronization'
      ? exactLaterAuthoredAssertion({
        laterOperations: context.laterOperations,
        snapshotText,
        candidates,
      })
      : false;
    const destinationReached = exactAuthoredDestinationReached({
      operation,
      phase,
      ownerVisible,
      snapshotText,
    });
    const pageTransitionCommitted = exactPageTransitionCommitted({
      operation,
      phase,
      ownerVisible,
      preDispatchObservation: context.preDispatchObservation,
      currentUrl: snapshot.url,
    });
    const expectedValue = plan.proofMetadata?.expectedValue ?? operation.value ?? null;
    const ownerValueMatched = textInputReadbackRequired
      ? textInputOwnerState?.ownerStateCommitted === true
      : expectedValue != null
        && ownerVisible
        && token(ownerLine).includes(token(expectedValue));
    const protectedNonEmpty = ownerVisible
      && /\bpassword\b/i.test(ownerLine)
      && /(?:value\s*=\s*["'][^"']+|•{2,}|\*{2,})/i.test(ownerLine);
    const protectedAcknowledgedNonEmpty = ownerVisible
      && /\bpassword\b/i.test(ownerLine)
      && protectedPasswordAcknowledgment({
        operation,
        resolution,
        plan,
        delivery,
        ownerVisible,
      });
    const submitActionable = candidates.some((candidate) => (
      candidate.role === 'button'
        && /\b(?:sign in|submit|continue|next)\b/i.test(clean(
          candidate.accessibleName || candidate.name,
        ))
    ));
    const selectionMatched = selectionOwnerState?.valueMatched === true;
    const selectionOwnerCommitted = selectionOwnerState?.ownerStateCommitted === true;
    const exactOptionSelected = selectionOwnerCommitted
      && phase !== 'pre_dispatch'
      && delivery != null
      && clean(delivery?.deliveryStatus).toUpperCase() !== 'NOT_DELIVERED';
    const snapshotDateMatched = operation.value != null
      && ownerVisible
      && normalizeDate(ownerLine.match(/\d{1,4}[/-]\d{1,2}[/-]\d{1,4}/)?.[0]) === normalizeDate(operation.value);
    const domDateMatched = operation.value != null
      && temporalOwnerReadback?.ok === true
      && normalizeDate(temporalOwnerReadback.value) === normalizeDate(operation.value);
    const dateMatched = snapshotDateMatched || domDateMatched;
    const timeMatch = operation.value != null
      && ownerVisible
      && normalizeTime(ownerLine.match(/\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?/i)?.[0]) === normalizeTime(operation.value);
    const domTimeMatched = operation.value != null
      && temporalOwnerReadback?.ok === true
      && normalizeTime(temporalOwnerReadback.value) === normalizeTime(operation.value);
    const typedAssertionObservation = operation.kind === 'assertion'
      ? evaluateControllerAssertionSnapshot({
        operation,
        snapshotText,
        snapshotUrl: snapshot.url,
        candidates,
      })
      : null;
    if (typedAssertionObservation) {
      if (journal?.appendObservation) {
        await journal.appendObservation(observation(OBSERVER_ROLE.EVIDENCE_READER, {
          eventType: 'TYPED_ASSERTION_OBSERVATION',
          operationId: operation.operationId,
          phase,
          attempt,
          factRef: snapshot.factRefs[0],
          matched: typedAssertionObservation.matched,
          reason: typedAssertionObservation.reason,
          assertionType: typedAssertionObservation.assertionType,
          target: typedAssertionObservation.target,
          observedKind: typedAssertionObservation.observedKind,
          candidateRef: typedAssertionObservation.candidateRef,
          expected: typedAssertionObservation.expected,
          observed: typedAssertionObservation.observed,
        })).catch(() => null);
      }

      if (typedAssertionObservation.candidateRef && phase !== 'pre_dispatch') {
        try {
          const isMatched = typedAssertionObservation.matched === true;
          const highlightFunc = `function highlightElement(element) {
            try {
              const origOutline = element.style.outline;
              const origBoxShadow = element.style.boxShadow;
              element.style.outline = '3px solid ${isMatched ? '#10b981' : '#f59e0b'}';
              element.style.boxShadow = '0 0 10px ${isMatched ? 'rgba(16, 185, 129, 0.8)' : 'rgba(245, 158, 11, 0.8)'}';
              setTimeout(() => {
                try {
                  element.style.outline = origOutline;
                  element.style.boxShadow = origBoxShadow;
                } catch (_) {}
              }, 2000);
            } catch (_) {}
          }`;
          rawCall('browser_evaluate', {
            element: clean(typedAssertionObservation.target) || 'element',
            target: typedAssertionObservation.candidateRef,
            function: highlightFunc,
          }, 1000).catch(() => {});
        } catch (_) {}
      }

      const targetLabel = clean(typedAssertionObservation.target || operation?.targetIdentity?.accessibleName || operation?.targetIdentity?.label || 'element');
      const assertionType = clean(operation?.type || typedAssertionObservation?.assertionType).toUpperCase();
      const expectedVal = clean(operation?.value || typedAssertionObservation?.expected);
      const isMatched = typedAssertionObservation.matched === true;

      let narration = 'Evaluated assertion';
      if (['DISABLED', 'ASSERTDISABLED'].includes(assertionType)) {
        narration = `Verified "${targetLabel}" field is disabled`;
      } else if (['READONLY', 'ASSERTREADONLY'].includes(assertionType)) {
        narration = `Verified "${targetLabel}" field is read-only`;
      } else if (['VALUE', 'ASSERTVALUE'].includes(assertionType)) {
        narration = expectedVal ? `Verified value "${expectedVal}" in "${targetLabel}"` : `Verified value in "${targetLabel}"`;
      } else if (['TEXT', 'ASSERTTEXT'].includes(assertionType)) {
        narration = expectedVal ? `Verified text "${expectedVal}" in "${targetLabel}"` : `Verified text in "${targetLabel}"`;
      } else if (['VISIBLE'].includes(assertionType)) {
        narration = `Verified "${targetLabel}" is visible`;
      } else if (['HIDDEN'].includes(assertionType)) {
        narration = `Verified "${targetLabel}" is hidden`;
      }

      send({
        type: 'browser.action',
        tool: `assertion_${assertionType.toLowerCase()}`,
        args: { element: targetLabel, value: expectedVal },
        narration,
        actionStatus: isMatched ? 'executed' : 'failed',
        ts: Date.now(),
      });
    }
    if (typedAssertionObservation?.candidateRef) {
      // Side-observation only, mirroring resolver()'s action-kind capture —
      // does not affect this function's return value or the assertion
      // decision. evaluateControllerAssertionSnapshot() already resolves the
      // exact element it checked; the last write here (from the attempt
      // that actually matched) is what captureVerifiedLocator reads once the
      // case has terminally committed.
      resolvedRefByOperation.set(operation.operationId, {
        ref: typedAssertionObservation.candidateRef,
        elementLabel: clean(typedAssertionObservation.target) || null,
        toolName: clean(operation.action || operation.type) || null,
        pageUrl: snapshot.url || null,
        contractStepId: clean(operation.authoredStepId || operation.assertionId) || null,
        actionOccurrenceId: clean(operation.actionOccurrenceId) || null,
      });
    }
    const assertionVisible = operation.targetIdentity
      ? candidateForOperation(operation, candidates).status === RESOLUTION_STATUS.RESOLVED
        || snapshotContains(snapshotText, operation.targetIdentity.accessibleName)
      : snapshotContains(snapshotText, operation.expected || operation.payload);
    const targetVisible = operation.targetIdentity
      ? candidateForOperation(operation, candidates).status === RESOLUTION_STATUS.RESOLVED
        || snapshotContains(
          snapshotText,
          operation.targetIdentity.accessibleName || operation.targetIdentity.label,
        )
      : snapshotContains(snapshotText, operation.target);
    const assertionMatched = typedAssertionObservation
      ? typedAssertionObservation.matched
      : operation.type === 'AssertHidden'
        ? !assertionVisible
        : operation.type === 'AssertText'
          ? snapshotContains(snapshotText, operation.expected || operation.payload || operation.targetIdentity?.accessibleName)
          : operation.type === 'AssertDisabled'
            ? (ownerLine ? /\bdisabled\b|aria-disabled\s*=\s*["']?true/i.test(ownerLine) : false)
            : operation.type === 'AssertReadonly'
              ? (ownerLine ? /\breadonly\b|aria-readonly\s*=\s*["']?true/i.test(ownerLine) : false)
              : operation.type === 'AssertValue' || operation.type === 'GetValue'
                ? snapshotContains(snapshotText, operation.expected || operation.value || operation.payload)
                : assertionVisible;
    const waitStateReached = exactWaitStateReached({
      operation,
      snapshotText,
      candidates,
    });
    const optionRoles = new Set(['option', 'menuitem', 'listitem', 'radio']);
    const popupCandidates = candidates.filter((candidate) => (
      ['listbox', 'menu', 'dialog'].includes(candidate.role)
        || optionRoles.has(candidate.role)
    ));
    const popupVisible = popupCandidates.length > 0;
    const ownerExpanded = popupOwnershipReadback?.ownerExpanded === true
      || (ownerVisible && (
        /\bexpanded\b/i.test(ownerLine)
        || /\baria-expanded\s*=\s*["']?true/i.test(ownerLine)
      ));
    const accordionOwnerExpanded = ownerVisible
      ? accordionStateFromSnapshot(operation, snapshotText, ownerCandidate)
      : null;
    const popupAssociation = popupAssociationEvidence({
      phase,
      ownerRef,
      ownerExpanded,
      popupCandidates,
      preDispatchObservation: context.preDispatchObservation,
      popupOwnershipReadback,
    });
    const associatedPopupOpen = Boolean(ownerVisible && popupAssociation.matched);
    const exactDynamicCandidate = Boolean(plan?.protocolPhase?.dynamicCandidate);
    if (protocolClaim === 'normalized_date_owner_value') {
      const alternatives = diagnosticCandidatesForOperation(operation, candidates).slice(0, 12);
      const dateReadbackDiagnostic = {
        type: 'controller.proof-diagnostic',
        operationId: operation.operationId,
        claimId: protocolClaim,
        phase,
        message: 'typed_date_owner_readback',
        originalRef: resolutionOwnerRef || null,
        currentRef: ownerRef || null,
        ownerRole: ownerCandidate?.role || null,
        ownerName: ownerCandidate?.accessibleName || ownerCandidate?.name || null,
        ownerLine: sanitizeSnapshotLine(ownerLine),
        rerenderResolutionStatus: rerenderedOwnerResolution?.status || null,
        candidates: Object.freeze(alternatives.map((candidate) => ({
          ref: candidate.ref,
          role: candidate.role,
          name: candidate.accessibleName || candidate.name || null,
          section: candidate.section || null,
        }))),
      };
      send(dateReadbackDiagnostic);
      if (journal?.appendObservation) {
        await journal.appendObservation(observation(OBSERVER_ROLE.EVIDENCE_READER, {
          eventType: 'TYPED_DATE_OWNER_READBACK',
          ...dateReadbackDiagnostic,
        })).catch(() => null);
      }
    }
    if (exactDynamicCandidate) {
      const candidateKind = clean(plan.protocolPhase.dynamicCandidate);
      const requested = candidateKind === 'option'
        ? selectionValue(plan?.protocol?.metadata?.selection)
        : candidateKind === 'time'
        ? plan?.protocol?.metadata?.normalizedTime
        : plan?.protocol?.metadata?.[candidateKind];
      const relevant = candidates.filter((candidate) => {
        const role = clean(candidate?.role).toLowerCase();
        const name = clean(
          candidate?.accessibleName
            || candidate?.name
            || candidate?.label
            || candidate?.text
            || candidate?.value,
        );
        if (candidateKind === 'time') {
          return ['option', 'menuitem', 'listitem', 'radio'].includes(role)
            || /\b\d{1,2}:\d{2}\b/.test(name);
        }
        if (candidateKind === 'option') {
          const requestedTime = normalizeTime(requested);
          if (requestedTime) {
            return ['option', 'menuitem', 'listitem', 'radio'].includes(role)
              || /\b\d{1,2}:\d{2}\b/.test(name);
          }
          return ['option', 'menuitem', 'listitem', 'radio'].includes(role)
            || name.toLocaleLowerCase('en-US').includes(
              String(requested || '').toLocaleLowerCase('en-US'),
            );
        }
        if (candidateKind === 'year') {
          if (token(name) === token(requested)) return true;
          return ['dialog', 'grid', 'gridcell', 'heading', 'button', 'option', 'listitem'].includes(role)
            && (
              name.includes(String(requested || ''))
              || /\b\d{4}\b/.test(name)
              || /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(name)
              || /\b(?:calendar|date|month|year|previous|next|select)\b/i.test(name)
              || ['dialog', 'grid'].includes(role)
            );
        }
        return name.toLocaleLowerCase('en-US').includes(
          String(requested || '').toLocaleLowerCase('en-US'),
        );
      });
      send({
        type: 'controller.proof-diagnostic',
        operationId: operation.operationId,
        claimId: protocolClaim,
        phase,
        message: `dynamic_candidate_observation:${candidateKind}`,
        requested: requested || null,
        candidateCount: relevant.length,
        candidates: Object.freeze(relevant.slice(0, 80).map((candidate) => ({
          ref: candidate.ref,
          role: candidate.role,
          name: candidate.accessibleName || candidate.name || null,
          section: candidate.section || null,
        }))),
      });
      if (journal?.appendObservation) {
        await journal.appendObservation(observation(OBSERVER_ROLE.EVIDENCE_READER, {
          eventType: 'DYNAMIC_CANDIDATE_OBSERVATION',
          operationId: operation.operationId,
          claimId: protocolClaim,
          phase,
          candidateKind,
          requested: candidateKind === 'time' ? normalizeTime(requested) : clean(requested),
          candidateCount: relevant.length,
          candidates: relevant.slice(0, 40).map((candidate) => ({
            ref: candidate.ref,
            role: candidate.role,
            name: candidate.accessibleName || candidate.name || null,
            section: candidate.section || null,
          })),
        })).catch(() => null);
      }
    }
    if (clean(operation?.operationCheck?.kind).toLowerCase() === 'menu_opened'
      || protocolClaim === 'associated_popup_open') {
      const preCandidateRefs = new Set(
        (Array.isArray(context.preDispatchObservation?.candidates)
          ? context.preDispatchObservation.candidates
          : [])
          .map((candidate) => clean(candidate?.ref || candidate?.reference))
          .filter(Boolean),
      );
      const candidateDelta = phase === 'post_dispatch'
        ? candidates.filter((candidate) => {
          const ref = clean(candidate?.ref || candidate?.reference);
          return ref && !preCandidateRefs.has(ref);
        })
        : [];
      send({
        type: 'controller.proof-diagnostic',
        operationId: operation.operationId,
        claimId: 'associated_popup_open',
        phase,
        message: `associated_popup_open:${popupAssociation.reason}`,
        ownerRef: ownerRef || null,
        ownerVisible,
        ownerExpanded,
        popupCandidateCount: popupCandidates.length,
        newPopupCandidateCount: popupAssociation.newPopupCandidateCount,
        candidateCount: candidateDelta.length,
        candidates: Object.freeze(candidateDelta.slice(0, 40).map((candidate) => ({
          ref: candidate.ref,
          role: candidate.role,
          name: candidate.accessibleName || candidate.name || null,
          section: candidate.section || null,
        }))),
      });
    }

    for (const alternative of plan.proofContract?.alternatives || []) {
      for (const claimId of alternative.allOf || []) {
        switch (claimId) {
          case 'same_owner_value':
            claims.push(claim(
              claimId,
              ownerValueMatched === true
                ? PROOF_STATUS.MATCHED
                : textInputOwnerState?.valueMatched === false
                  ? PROOF_STATUS.MISMATCH
                  : PROOF_STATUS.UNKNOWN,
              textInputOwnerFactRef || factRef,
              textInputOwnerState?.reason || 'same owner exact value readback unavailable',
            ));
            break;
          case 'same_password_owner':
            add(claimId, ownerVisible && /\bpassword\b/i.test(ownerLine), 'same password owner observed');
            break;
          case 'protected_non_empty':
            add(
              claimId,
              protectedNonEmpty || protectedAcknowledgedNonEmpty || null,
              'protected non-empty input fact',
            );
            break;
          case 'fill_acknowledged':
            add(
              claimId,
              exactFillAcknowledgment({
                operation,
                resolution,
                plan,
                delivery,
                ownerVisible,
              }) || null,
              'exact owner correlated browser fill acknowledgment',
              EVIDENCE_TIER.BROWSER_EVENT,
            );
            break;
          case 'input_event_observed':
            add(
              claimId,
              ownerVisible && delivery?.inputEventObserved === true
                ? true
                : null,
              'exact owner input event observation',
              EVIDENCE_TIER.BROWSER_EVENT,
            );
            break;
          case 'submit_actionable':
            add(claimId, submitActionable || null, 'authored submit control actionable');
            break;
          case 'authored_destination':
            add(claimId, destinationReached || null, 'authored destination observation');
            break;
          case 'next_required_control_actionable':
            add(
              claimId,
              nextRequiredControlMatched || null,
              'first later authored semantic control actionable',
            );
            break;
          case 'next_authored_action_control_actionable':
            add(
              claimId,
              nextAuthoredActionControlMatched || null,
              'first later authored action control actionable',
            );
            break;
          case 'exact_navigation_target':
            add(claimId, operation.type === 'Navigate'
              ? token(snapshot.url).startsWith(token(operation.value))
              : null, 'exact navigation target');
            break;
          case 'page_transition_committed':
            add(
              claimId,
              pageTransitionCommitted || null,
              'authored page-ready activation changed URL and removed the exact prior owner',
            );
            break;
          case 'associated_popup_open':
            add(
              claimId,
              associatedPopupOpen || null,
              popupAssociation.reason,
            );
            break;
          case 'owner_selected_value':
            add(
              claimId,
              selectionOwnerState?.valueMatched ?? null,
              selectionOwnerState?.reason || 'exact selection owner readback unavailable',
            );
            break;
          case 'exact_option_selected':
            add(
              claimId,
              exactOptionSelected || null,
              exactOptionSelected
                ? 'exact option dispatch followed by committed owner readback'
                : selectionOwnerState?.reason || 'exact option selection not proven',
            );
            break;
          case 'owner_state_committed':
            add(
              claimId,
              selectionOwnerState?.ownerStateCommitted ?? null,
              selectionOwnerState?.reason || 'selection owner commit unavailable',
            );
            break;
          case 'normalized_date_owner_value':
            add(claimId, dateMatched || null, 'normalized date owner readback');
            break;
          case 'normalized_time_owner_value':
            add(claimId, timeMatch || selectionMatched || null, 'normalized time owner readback');
            break;
          case 'boolean_owner_state':
            add(claimId, ownerVisible && /\bchecked\b/i.test(ownerLine), 'boolean owner state');
            break;
          case 'accordion_owner_state':
            add(
              claimId,
              accordionOwnerExpanded == null
                ? null
                : accordionOwnerExpanded === Boolean(plan?.proofMetadata?.expectedExpanded),
              'exact typed accordion owner state',
            );
            break;
          case 'assertion_matched':
          case 'collection_assertion':
            add(
              claimId,
              typedAssertionObservation
                ? typedAssertionObservation.matched
                : assertionMatched,
              typedAssertionObservation?.reason || 'authored assertion against fresh snapshot',
            );
            break;
          case 'wait_state_reached':
            add(
              claimId,
              waitStateReached
                || nextRequiredControlMatched
                || laterAuthoredAssertionMatched
                || null,
              'exact authored wait state, first subsequent control, or downstream authored assertion reached',
            );
            break;
          case 'target_visible':
            add(claimId, targetVisible || null, 'authored semantic target visible after reveal');
            break;
          default:
            add(claimId, null, 'claim requires typed protocol observation');
        }
      }
    }

    if (protocolClaim) {
      const protocolMatched = protocolClaim === 'same_owner_actionable'
        ? ownerVisible
        : protocolClaim === 'associated_popup_open'
          ? associatedPopupOpen
          : protocolClaim === 'owner_selected_value'
            ? selectionMatched
            : protocolClaim === 'owner_state_committed'
              ? selectionOwnerCommitted
            : protocolClaim === 'normalized_date_owner_value'
              ? dateMatched
              : protocolClaim === 'normalized_time_owner_value'
              ? timeMatch || domTimeMatched || selectionMatched
                : /phase_committed$/.test(protocolClaim)
                  ? popupVisible
                  : exactDynamicCandidate
                    ? candidates.length > 0
                    : null;
      if (
        (
          protocolClaim === 'normalized_date_owner_value' && domDateMatched
          || protocolClaim === 'normalized_time_owner_value' && domTimeMatched
        )
        && temporalOwnerFactRef
      ) {
        claims.push(claim(
          protocolClaim,
          PROOF_STATUS.MATCHED,
          temporalOwnerFactRef,
          'exact normalized DOM value from the bound temporal owner',
        ));
      } else {
        add(protocolClaim, protocolMatched || null, `typed protocol claim ${protocolClaim}`);
      }
    }

    return Object.freeze({
      snapshotId: snapshot.snapshotId,
      browserEpoch: snapshot.browserEpoch,
      snapshotText,
      url: snapshot.url,
      title: snapshot.title,
      actionRecoveryState: Object.freeze({
        exactOwnerPresent: ownerVisible,
        semanticOwnerReresolved,
        sourceUrlUnchanged: phase === 'post_dispatch'
          && Boolean(context.preDispatchObservation?.url)
          && token(context.preDispatchObservation.url) === token(snapshot.url),
        authoredDestinationReached: destinationReached === true,
        nextRequiredControlReached: nextRequiredControlMatched === true,
        pageTransitionCommitted: pageTransitionCommitted === true,
        sourceStateUnchanged: phase === 'post_dispatch'
          && ownerVisible
          && Boolean(context.preDispatchObservation?.url)
          && token(context.preDispatchObservation.url) === token(snapshot.url)
          && destinationReached !== true
          && nextRequiredControlMatched !== true
          && pageTransitionCommitted !== true,
      }),
      claims: Object.freeze(claims),
      candidates,
      popupOwnership: Object.freeze({
        proven: popupOwnershipReadback?.ok === true
          && Number(popupOwnershipReadback?.controlledPopupCount) > 0,
        ownerExpanded: popupOwnershipReadback?.ownerExpanded === true,
        controlledPopupCount: Number(popupOwnershipReadback?.controlledPopupCount) || 0,
        relationIds: Object.freeze((Array.isArray(popupOwnershipReadback?.relationIds)
          ? popupOwnershipReadback.relationIds
          : []).map(clean).filter(Boolean)),
        ownedOptionNames: Object.freeze((Array.isArray(popupOwnershipReadback?.ownedOptionNames)
          ? popupOwnershipReadback.ownedOptionNames
          : []).map(clean).filter(Boolean)),
      }),
      factRefs: Object.freeze([
        ...snapshot.factRefs,
        ...(textInputOwnerFactRef ? [textInputOwnerFactRef] : []),
        ...(temporalOwnerFactRef ? [temporalOwnerFactRef] : []),
        ...(selectionOwnerFactRef ? [selectionOwnerFactRef] : []),
        ...(popupOwnershipFactRef ? [popupOwnershipFactRef] : []),
      ]),
    });
  };

  const transport = async ({
    session: transportSession,
    toolName,
    args,
    authorization,
    remainingMs,
  }) => {
    if (transportSession !== session
      || authorization?.authorized !== true
      || authorization.toolName !== toolName) {
      const error = new ControllerMcpRuntimeAdapterError(
        'Raw MCP mutation requires the gateway exact transport authorization.',
        'CONTROLLER_MCP_GATEWAY_AUTHORIZATION_REQUIRED',
      );
      error.delivered = false;
      error.positivelyNotDelivered = true;
      error.proven = true;
      throw error;
    }
    const operationId = authorization?.operationId;
    const entry = operationId ? resolvedRefByOperation.get(operationId) : null;
    const targetRef = clean(args?.target || args?.ref) || entry?.ref || null;
    const elementLabel = clean(args?.element) || entry?.elementLabel || null;
    const pageUrl = entry?.pageUrl || session?.lastUrl || null;

    const isClearOp = Boolean(
      args?.clear === true
      || entry?.toolName === 'Clear'
      || (elementLabel && /\bclear\b/i.test(elementLabel))
      || (args?.element && /\bclear\b/i.test(args.element))
    ) && (toolName === 'browser_type' || toolName === 'browser_fill');

    const isClickAndHoldOp = Boolean(
      entry?.toolName === 'ClickAndHold'
      || toolName === 'browser_click_and_hold'
    );

    const sdkToolName = toolName === 'browser_fill' ? 'browser_type' : toolName;
    // controllerTypedAdapterRegistry.js freezes mutation.args (Object.freeze),
    // and normaliseToolArgs() returns that same frozen reference untouched
    // whenever no target rewrite is needed (e.g. every browser_navigate call,
    // and any click/type whose target already needs no rewriting). Mutating
    // it in place below threw "Cannot add property target, object is not
    // extensible" on every such call, silently swallowed by the outer gateway
    // catch into a generic "delivery uncertain" — no operation ever reached
    // the browser. Spread into a fresh, always-extensible object first.
    const normalized = { ...(mcp.normaliseToolArgs(sdkToolName, args || {}, session).args || {}) };

    // Restore normalized properties based on our computations
    normalized.target = normalized.target || targetRef;
    normalized.element = normalized.element || elementLabel;

    const isAppendOp = Boolean(
      args?.append === true
      || entry?.toolName === 'Append'
      || (entry?.actionText && /\bappend\b/i.test(entry.actionText))
      || (elementLabel && /\bappend\b/i.test(elementLabel))
      || (args?.element && /\bappend\b/i.test(args.element))
    );

    const isSemanticOp = Boolean(
      entry?.toolName === 'Semantic'
      || (entry?.actionText && /\bsemantic\b/i.test(entry.actionText))
    );

    if (isAppendOp && (normalized.text != null || args?.text != null || args?.value != null)) {
      const snapshotText = session.lastSnapshot || '';
      const existingVal = clean(entry?.candidate?.value) || extractCandidateValue(snapshotText, targetRef, entry?.candidate);
      const textToAppend = normalized.text != null ? normalized.text : (args?.text != null ? args.text : args?.value || '');
      if (existingVal && !textToAppend.startsWith(existingVal)) {
        normalized.text = `${existingVal}${textToAppend}`;
      }
    }

    if (isClearOp) {
      normalized.text = '';
      normalized.value = '';
    }

    // Phase 30.0.2 — pre-dispatch locator capture for navigation-triggering clicks.
    // Only browser_click can trigger a full-page navigation that destroys the DOM
    // before the post-commit captureVerifiedLocator call runs. browser_type/
    // browser_fill keep the element alive throughout; browser_select_option goes
    // through the composite protocol (committedCandidate); browser_hover has no
    // navigation effect. Running captureStructuralLocator before every one of those
    // would add an awaited browser_evaluate round-trip before every mutating action
    // in the live pipeline — a blanket slowdown not justified by the narrow gap
    // being fixed here. Limit to browser_click only.
    if (['browser_click', 'browser_fill', 'browser_type'].includes(toolName) && targetRef && !session?.closed && session?.client) {
      try {
        const preDispatchCaptured = await Promise.race([
          captureStructuralLocator({
            session,
            ref: targetRef,
            element: elementLabel,
            pageUrl,
            toolName: entry?.toolName || toolName,
          }),
          new Promise((resolve) => setTimeout(() => resolve(null), Math.min(2_000, Math.max(500, Number(remainingMs) || 2_000)))),
        ]);
        if (preDispatchCaptured && entry) {
          entry.preVerifiedLocator = preDispatchCaptured;
        }
      } catch (_) {}
    }

    let result;
    if (sdkToolName === 'browser_navigate' && session.liveCdp?.context && normalized.url) {
      // browser_navigate's own MCP tool call can hang indefinitely waiting on its
      // post-navigation snapshot response (see the session-bootstrap comment in
      // server/services/mcp.js) — every later MCP call on this same stdio channel
      // then queues behind it and comes back with an empty accessibility tree,
      // reproduced live on 2026-08-07 for an authored Navigate step (every
      // subsequent step failed with snapshot_interaction_tree_empty). Bypass it
      // here the same way the initial session-bootstrap navigation already does:
      // drive the live-CDP Playwright page directly instead of going through MCP.
      try {
        let page = session.liveCdp.context.pages()[0] || null;
        if (!page) page = await session.liveCdp.context.newPage();
        await page.goto(normalized.url, {
          waitUntil: 'domcontentloaded',
          timeout: Math.max(1_000, Math.min(60_000, Number(remainingMs) || 30_000)),
        });
        session.currentUrl = page.url() || normalized.url;
        result = { isError: false, content: [{ type: 'text', text: `Navigated to ${session.currentUrl}` }] };
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Direct navigation failed: ${error?.message || error}` }] };
      }
    } else if (sdkToolName === 'browser_go_back' && session.liveCdp?.context) {
      try {
        let page = session.liveCdp.context.pages()[0] || null;
        if (page) await page.goBack({ waitUntil: 'domcontentloaded', timeout: Math.max(1_000, Math.min(60_000, Number(remainingMs) || 30_000)) });
        session.currentUrl = page?.url() || session.currentUrl;
        result = { isError: false, content: [{ type: 'text', text: `Navigated back to ${session.currentUrl}` }] };
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Direct navigation failed: ${error?.message || error}` }] };
      }
    } else if (sdkToolName === 'browser_go_forward' && session.liveCdp?.context) {
      try {
        let page = session.liveCdp.context.pages()[0] || null;
        if (page) await page.goForward({ waitUntil: 'domcontentloaded', timeout: Math.max(1_000, Math.min(60_000, Number(remainingMs) || 30_000)) });
        session.currentUrl = page?.url() || session.currentUrl;
        result = { isError: false, content: [{ type: 'text', text: `Navigated forward to ${session.currentUrl}` }] };
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Direct navigation failed: ${error?.message || error}` }] };
      }
    } else if (sdkToolName === 'browser_reload' && session.liveCdp?.context) {
      try {
        let page = session.liveCdp.context.pages()[0] || null;
        if (page) await page.reload({ waitUntil: 'domcontentloaded', timeout: Math.max(1_000, Math.min(60_000, Number(remainingMs) || 30_000)) });
        session.currentUrl = page?.url() || session.currentUrl;
        result = { isError: false, content: [{ type: 'text', text: `Refreshed page ${session.currentUrl}` }] };
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Direct navigation failed: ${error?.message || error}` }] };
      }
    } else if (isSemanticOp && session.client && targetRef) {
      try {
        result = await session.client.callTool(
          {
            name: 'browser_evaluate',
            arguments: {
              target: targetRef,
              function: `(el) => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return 'x=' + Math.round(rect.x) + ', y=' + Math.round(rect.y) + ', width=' + Math.round(rect.width) + ', height=' + Math.round(rect.height) + ', color=' + style.color + ', backgroundColor=' + style.backgroundColor + ', disabled=' + (el.disabled || el.getAttribute('aria-disabled') === 'true');
              }`
            }
          }
        );
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Semantic operation failed: ${error?.message || error}` }] };
      }
    } else if (isClearOp && session.liveCdp?.context && targetRef) {
      // Clear operation: browser_fill does not exist on the installed @playwright/mcp
      // server (confirmed by journal DELIVERY_RECORDED: Tool "browser_fill" not found).
      // Playwright's native locator.fill('') is the correct way to clear a field —
      // it selects all existing content and replaces it with empty string. Drive the
      // live-CDP context directly just like Navigate/GoBack/GoForward/Reload above.
      try {
        const page = session.liveCdp.context.pages()[0] || null;
        if (page) {
          // reveal-owner (the preDispatchMutation) already focused the target element.
          // Use Playwright's native fill('') on the currently-focused element — it
          // properly triggers React/Vue synthetic events, unlike manual nativeInputValueSetter.
          // ':focus' is CSS for document.activeElement, so this directly clears whichever
          // input reveal-owner just focused, with no ref-resolution needed.
          await page.locator(':focus').fill('', { timeout: 3000 });
          result = { isError: false, content: [{ type: 'text', text: `Cleared field "${elementLabel || targetRef}"` }] };
        } else {
          result = { isError: true, content: [{ type: 'text', text: 'No page available for clear operation' }] };
        }
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Clear operation failed: ${error?.message || error}` }] };
      }
    } else if (isAppendOp && session.liveCdp?.context && targetRef && normalized.text != null) {
      // Append operation: browser_type at cursor position is unreliable — if reveal-owner
      // focused the element with cursor at position 0, typing the full combined string
      // (existingVal + fragment) at position 0 doubles the content. Use page.fill()
      // on the focused element instead, which always replaces the full value atomically.
      // normalized.text is already set to `${existingVal}${textToAppend}` above.
      try {
        const page = session.liveCdp.context.pages()[0] || null;
        if (page) {
          const fullValue = String(normalized.text);
          await page.locator(':focus').fill(fullValue, { timeout: 3000 });
          result = { isError: false, content: [{ type: 'text', text: `Appended to field "${elementLabel || targetRef}": value is now "${fullValue}"` }] };
        } else {
          result = { isError: true, content: [{ type: 'text', text: 'No page available for append operation' }] };
        }
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Append operation failed: ${error?.message || error}` }] };
      }
    } else if (isClickAndHoldOp && session.liveCdp?.context && targetRef) {
      try {
        const page = session.liveCdp.context.pages()[0] || null;
        if (page) {
          const clickAndHoldFunc = `async function clickAndHold(element) {
            try {
              const dispatch = (type) => {
                const ev = new MouseEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  view: window,
                  buttons: 1
                });
                element.dispatchEvent(ev);
                
                if (window.PointerEvent) {
                  const pev = new PointerEvent(type.replace('mouse', 'pointer'), {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    buttons: 1,
                    pointerType: 'mouse'
                  });
                  element.dispatchEvent(pev);
                }
              };
              dispatch('mousedown');
              await new Promise((resolve) => setTimeout(resolve, 2000));
              try {
                dispatch('mouseup');
                const clickEv = new MouseEvent('click', {
                  bubbles: true,
                  cancelable: true,
                  view: window
                });
                element.dispatchEvent(clickEv);
              } catch (_) {}
              return { ok: true };
            } catch (err) {
              return { ok: false, error: err.message };
            }
          }`;
          // Previously called rawEvaluateBoundRef(), a function that does
          // not exist anywhere in this file — every ClickAndHold hit a
          // ReferenceError ("rawEvaluateBoundRef is not defined") on every
          // attempt. rawCall('browser_evaluate', ...) is the same helper
          // reveal-owner and the readback functions already use
          // successfully elsewhere in this file.
          result = await rawCall('browser_evaluate', {
            target: targetRef,
            element: elementLabel,
            function: clickAndHoldFunc,
          }, remainingMs);
          if (!result || result.isError) {
            throw new Error(result?.content?.[0]?.text || 'Click and hold evaluation failed');
          }
        } else {
          throw new Error('No page available for click and hold');
        }
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Click and hold failed: ${error?.message || error}` }] };
      }
    } else {
      result = await rawCall(sdkToolName, normalized, remainingMs);
    }
    browserEpoch += 1;
    snapshots.invalidate({ browserEpoch: String(browserEpoch), reason: `mutation:${sdkToolName}` });

    if (result && !result.isError && toolName.startsWith('browser_') && !['browser_snapshot', 'browser_take_screenshot'].includes(toolName)) {
      try {
        const shot = await mcp.captureLiveEvidenceScreenshot(session, { label: `${toolName}_evidence` });
        if (shot) {
          if (!session.screenshots) session.screenshots = [];
          session.screenshots.push({
            ...shot,
            path: shot.artifactRef,
            label: `${toolName}_evidence`,
          });
        }
      } catch (_) {}
    }

    if (toolName.startsWith('browser_') && !['browser_snapshot', 'browser_take_screenshot', 'browser_evaluate'].includes(toolName)) {
      const label = elementLabel || clean(normalized?.element || normalized?.label || normalized?.target || normalized?.url || normalized?.key || '');
      const conciseTarget = label ? ` · ${label.slice(0, 80)}` : '';
      let narration = 'Perform browser action';
      const textVal = clean(normalized?.text || normalized?.value || args?.text || args?.value);
      if (isAppendOp) {
        narration = textVal ? `Appended "${textVal}" to "${label || 'field'}"` : `Appended text to "${label || 'field'}"`;
      } else if (isClearOp) {
        narration = `Cleared "${label || 'field'}" field`;
      } else if (/right_click|rightclick/i.test(toolName) || /right\s*click/i.test(entry?.actionText || '')) {
        narration = `Right-clicked "${label || 'element'}"`;
      } else if (/hold|long_press/i.test(toolName) || /hold/i.test(entry?.actionText || '')) {
        narration = `Clicked and held "${label || 'element'}"`;
      } else if (/go_back|back/i.test(entry?.actionText || '')) {
        narration = `Navigated back to previous page`;
      } else if (/go_forward|forward/i.test(entry?.actionText || '')) {
        narration = `Navigated forward to next page`;
      } else if (/refresh|reload/i.test(entry?.actionText || '')) {
        narration = `Refreshed page`;
      } else if (/accept\s*alert|confirm\s*alert/i.test(entry?.actionText || '')) {
        narration = `Accepted browser alert dialog`;
      } else if (/dismiss\s*alert|cancel\s*alert/i.test(entry?.actionText || '')) {
        narration = `Dismissed browser alert dialog`;
      } else if (/type\s*alert|prompt/i.test(entry?.actionText || '')) {
        narration = textVal ? `Entered "${textVal}" into alert prompt and accepted` : `Responded to alert prompt`;
      } else if (/copy/i.test(entry?.actionText || '')) {
        narration = `Copied "${label || 'element text'}" to clipboard`;
      } else if (/paste/i.test(entry?.actionText || '')) {
        narration = `Pasted clipboard contents into "${label || 'field'}"`;
      } else if (/extract/i.test(entry?.actionText || '')) {
        narration = `Extracted data from "${label || 'element'}" into variable`;
      } else if (isSemanticOp) {
        let propsStr = '';
        const resText = textOfResult(result);
        if (resText) {
          const w = resText.match(/width=([\d\.]+)/)?.[1];
          const h = resText.match(/height=([\d\.]+)/)?.[1];
          const c = resText.match(/color=(rgb[^\)]+\)|#[^\,]+|[a-zA-Z]+)/)?.[1];
          const bg = resText.match(/backgroundColor=(rgba?[^\)]+\)|#[^\,]+|[a-zA-Z]+)/)?.[1];
          const d = resText.match(/disabled=(true|false)/)?.[1];
          const parts = [];
          if (w) parts.push(`width: ${w}px`);
          if (h) parts.push(`height: ${h}px`);
          if (c) parts.push(`color: ${c}`);
          if (bg && bg !== 'rgba(0, 0, 0, 0)') parts.push(`bg: ${bg}`);
          if (d === 'true') parts.push('disabled');
          if (parts.length > 0) {
            propsStr = ` (${parts.join(', ')})`;
          }
        }
        narration = `Extracted properties for "${label || 'element'}"${propsStr}`;
      } else if (/switch\s*tab|switch\s*window/i.test(entry?.actionText || '')) {
        narration = `Switched focus to tab/window "${label || 'target'}"`;
      } else if (/switch\s*frame|iframe/i.test(entry?.actionText || '')) {
        narration = `Switched focus into frame "${label || 'iframe'}"`;
      } else if (/access\s*shadow|shadow/i.test(entry?.actionText || '')) {
        narration = `Accessed Shadow DOM root for "${label || 'component'}"`;
      } else if (/fill|type/i.test(toolName)) {
        narration = textVal ? `Entered "${textVal}" into "${label || 'field'}"` : `Filled "${label || 'field'}"`;
      } else if (/click/i.test(toolName)) {
        narration = `Clicked "${label || 'control'}"`;
      } else if (/select/i.test(toolName)) {
        const optionVal = clean(normalized?.option || normalized?.text || label);
        narration = `Selected "${optionVal}"`;
      } else if (/navigate|goto/i.test(toolName)) {
        narration = `Navigated to ${normalized.url || label || 'requested page'}`;
      } else if (/scroll/i.test(toolName)) {
        narration = label ? `Scrolled "${label}" into view` : `Scrolled page`;
      } else if (/hover/i.test(toolName)) {
        narration = `Hovered over "${label || 'element'}"`;
      } else if (/press/i.test(toolName)) {
        narration = `Pressed ${normalized.key || label || 'key'} key`;
      } else if (/check/i.test(toolName)) {
        narration = `Checked "${label || 'checkbox'}"`;
      } else if (/upload/i.test(toolName)) {
        narration = `Uploaded file to "${label || 'field'}"`;
      } else if (/wait/i.test(toolName)) {
        narration = `Waited for page element to settle`;
      }

      send({
        type: 'browser.action',
        tool: toolName,
        args: normalized,
        narration,
        actionStatus: result?.isError ? 'failed' : 'executed',
        ts: Date.now(),
      });
    }
    const responseText = isSemanticOp ? '' : textOfResult(result);
    const semanticEvaluation = sdkToolName === 'browser_evaluate'
      ? evaluatePayload(result)
      : null;
    let semanticFactRef = null;
    if (semanticEvaluation && journal?.appendObservation) {
      semanticFactRef = `fact:controller-semantic-evaluate:${crypto.randomUUID()}`;
      await journal.appendObservation(observation(OBSERVER_ROLE.ADAPTER, {
        eventType: 'SEMANTIC_EVALUATE_ACKNOWLEDGMENT',
        operationId: authorization.operationId,
        occurrenceKey: authorization.occurrenceKey,
        factRef: semanticFactRef,
        ok: semanticEvaluation.ok === true,
        reason: clean(semanticEvaluation.reason) || null,
        kind: clean(semanticEvaluation.kind) || null,
        candidateCount: Number(semanticEvaluation.candidateCount) || 0,
        actionPerformed: semanticEvaluation.actionPerformed === true,
        expectedSelectionMatched: semanticEvaluation.expectedSelectionMatched === true,
        ownerMatched: semanticEvaluation.ownerMatched === true,
        selectedLabel: clean(semanticEvaluation.selectedLabel).slice(0, 160) || null,
        ownerRole: clean(semanticEvaluation.ownerRole) || null,
        ownerText: clean(semanticEvaluation.ownerText).slice(0, 120) || null,
        observedValues: Object.freeze(
          (Array.isArray(semanticEvaluation.observedValues)
            ? semanticEvaluation.observedValues
            : [])
            .map((value) => clean(value))
            .filter((value) => /^\d{2}:\d{2}$/.test(value))
            .slice(0, 24),
        ),
        scrollableCount: Number(semanticEvaluation.scrollableCount) || 0,
        scanCount: Number(semanticEvaluation.scanCount) || 0,
        startScrollTop: Number(semanticEvaluation.startScrollTop) || 0,
        endScrollTop: Number(semanticEvaluation.endScrollTop) || 0,
        controlledSurfaceCount: Number(semanticEvaluation.controlledSurfaceCount) || 0,
        controlledTimeSurfaceCount: Number(semanticEvaluation.controlledTimeSurfaceCount) || 0,
        fallbackTimeSurfaceCount: Number(semanticEvaluation.fallbackTimeSurfaceCount) || 0,
        controlShapes: Object.freeze(
          (Array.isArray(semanticEvaluation.controlShapes)
            ? semanticEvaluation.controlShapes
            : [])
            .slice(0, 16)
            .map((shape) => Object.freeze({
              tag: clean(shape?.tag).slice(0, 24) || null,
              role: clean(shape?.role).slice(0, 40) || null,
              type: clean(shape?.type).slice(0, 24) || null,
              identity: clean(shape?.identity).slice(0, 80) || null,
              valueKind: ['time', 'date', 'other', 'empty'].includes(clean(shape?.valueKind))
                ? clean(shape.valueKind)
                : null,
              sameOwner: shape?.sameOwner === true,
              hasPopup: shape?.hasPopup === true,
            })),
        ),
      })).catch(() => null);
    }
    if (responseText && mcp.isSnapshotText(responseText)) {
      session.lastSnapshot = responseText;
    }
    if (semanticEvaluation && semanticEvaluation.ok === false) {
      return Object.freeze({
        delivered: false,
        positivelyNotDelivered: true,
        proven: true,
        recoverable: true,
        isError: true,
        reason: clean(semanticEvaluation.reason) || 'semantic_browser_evaluate_not_delivered',
        browserAcknowledged: false,
        acknowledgmentKind: null,
        inputEventObserved: false,
        protectedInputNonEmpty: false,
        responseText,
      });
    }
    const semanticEvaluationAcknowledged = semanticEvaluation?.ok === true;
    const semanticAcknowledgment = semanticEvaluation
      ? Object.freeze({
        ok: semanticEvaluation.ok === true,
        reason: clean(semanticEvaluation.reason) || null,
        actionPerformed: semanticEvaluation.actionPerformed === true,
        expectedSelectionMatched: semanticEvaluation.expectedSelectionMatched === true,
        ownerMatched: semanticEvaluation.ownerMatched === true,
        selectedLabel: clean(semanticEvaluation.selectedLabel).slice(0, 160) || null,
        factRefs: Object.freeze(semanticFactRef ? [semanticFactRef] : []),
      })
      : null;
    return Object.freeze({
      delivered: result?.isError !== true,
      isError: result?.isError === true,
      reason: result?.isError === true
        ? responseText || 'mcp_tool_error'
        : semanticEvaluationAcknowledged
          ? clean(semanticEvaluation.reason) || 'semantic_browser_evaluate_acknowledged'
          : 'raw_mcp_transport_returned',
      browserAcknowledged: result?.isError !== true
        && (
          ['browser_fill', 'browser_type'].includes(toolName)
          || semanticEvaluationAcknowledged
        ),
      acknowledgmentKind: result?.isError !== true
        ? ['browser_fill', 'browser_type'].includes(toolName)
          ? `${toolName}_returned`
          : semanticEvaluationAcknowledged
            ? 'browser_evaluate_semantic_acknowledgment'
            : null
        : null,
      inputEventObserved: false,
      protectedInputNonEmpty: result?.isError !== true
        && ['browser_fill', 'browser_type'].includes(toolName)
        && typeof args?.text === 'string'
        && args.text.length > 0,
      semanticAcknowledgment,
      factRefs: Object.freeze(semanticFactRef ? [semanticFactRef] : []),
      responseText,
    });
  };

  const proposeTargetRecovery = async ({
    operation,
    snapshot,
    candidates = [],
  } = {}) => proposeTargetRecoveryFromSnapshot({ operation, snapshot, candidates });

  // Phase 30.0 — the only consumer of resolvedRefByOperation. Called strictly
  // after a case's operation loop has already committed (see
  // controllerConductor.js), never from inside resolve/dispatch. It
  // independently re-verifies a real, exportable Playwright locator for the
  // exact element the controller already proved it acted on — it cannot
  // throw, retry a mutation, or influence any decision; a miss just means
  // this one step's generated-output locator stays unverified.
  const captureVerifiedLocator = async (operationId, { timeoutMs = 6_000, committedCandidate = null } = {}) => {
    const entry = resolvedRefByOperation.get(operationId);
    // For composite protocols (Select/Radio-style dropdowns), a plain
    // resolver() capture only ever sees the trigger/owner element — the
    // actual chosen option is resolved dynamically deep inside the
    // composite protocol executor and is never routed through resolver().
    // committedCandidate carries that real ref when one exists (see
    // controllerCompositeExecutor.js); it takes priority over the entry's
    // ref, which — for these operations — is the trigger, not the choice.
    const ref = clean(committedCandidate?.ref) || entry?.ref;
    if (!ref || session.closed) {
      if (entry?.preVerifiedLocator && !committedCandidate?.ref) {
        if (!entry?.contractStepId) return entry.preVerifiedLocator;
        const provenNotYetBound = { ...entry.preVerifiedLocator, verified: true, diagnosticOnly: false };
        return buildLocatorEvidenceRecord({
          actionLocator: provenNotYetBound,
          contractStepId: entry.contractStepId,
          actionOccurrenceId: entry.actionOccurrenceId,
        }).locator;
      }
      return null;
    }
    const elementLabel = clean(committedCandidate?.accessibleName) || entry?.elementLabel || null;
    try {
      // Bounded so one slow/hung browser_evaluate can never stall the run —
      // a timeout here just means this one step's locator stays unverified.
      let captured = null;
      if (committedCandidate?.ref) {
        captured = await Promise.race([
          captureStructuralLocator({
            session,
            ref,
            element: elementLabel,
            pageUrl: entry?.pageUrl,
            toolName: entry?.toolName,
          }),
          new Promise((resolve) => setTimeout(() => resolve(null), Math.max(500, timeoutMs))),
        ]);
      } else if (entry?.preVerifiedLocator) {
        captured = entry.preVerifiedLocator;
      } else {
        captured = await Promise.race([
          captureStructuralLocator({
            session,
            ref,
            element: elementLabel,
            pageUrl: entry?.pageUrl,
            toolName: entry?.toolName,
          }),
          new Promise((resolve) => setTimeout(() => resolve(null), Math.max(500, timeoutMs))),
        ]);
      }
      if (!captured && entry?.preVerifiedLocator && !committedCandidate?.ref) {
        captured = entry.preVerifiedLocator;
      }
      if (!captured) return null;
      // captureStructuralLocator has no authored-contract identity of its own
      // to attach, so it always comes back through its own internal
      // propagateLocatorEvidence pass unbound/diagnostic-only (identityStatus
      // 'missing_contract_step_id') even when the underlying DOM proof is
      // solid — that first pass is correct in isolation. Rebinding it to the
      // exact operation it was captured for is what makes a genuinely-proven
      // locator countable as verified/persistable. Re-wrapping the ALREADY
      // diagnostic-marked object would stay diagnostic forever — isVerified
      // ActionLocator() short-circuits on primary.diagnosticOnly === true
      // before it ever looks at the (still-true) nested proof — so the prior
      // diagnostic marking is cleared here, from the real proof it already
      // carries, before the identity-bound rewrap.
      if (!entry?.contractStepId) return captured;
      const provenNotYetBound = { ...captured, verified: true, diagnosticOnly: false };
      return buildLocatorEvidenceRecord({
        actionLocator: provenNotYetBound,
        contractStepId: entry.contractStepId,
        actionOccurrenceId: entry.actionOccurrenceId,
      }).locator;
    } catch (_) {
      if (entry?.preVerifiedLocator && !committedCandidate?.ref) {
        if (!entry?.contractStepId) return entry.preVerifiedLocator;
        const provenNotYetBound = { ...entry.preVerifiedLocator, verified: true, diagnosticOnly: false };
        return buildLocatorEvidenceRecord({
          actionLocator: provenNotYetBound,
          contractStepId: entry.contractStepId,
          actionOccurrenceId: entry.actionOccurrenceId,
        }).locator;
      }
      return null;
    }
  };

  return Object.freeze({
    adapterVersion: MCP_ADAPTER_VERSION,
    resolver,
    observer,
    transport,
    acquireSnapshot: acquire,
    currentEpoch: () => String(browserEpoch),
    latestSnapshot: () => latest,
    proposeTargetRecovery,
    captureVerifiedLocator,
  });
}

module.exports = {
  MCP_ADAPTER_VERSION,
  ControllerMcpRuntimeAdapterError,
  words,
  semanticWords,
  lexicalMatchScore,
  scoreSemanticCandidate,
  semanticControlFamilyCompatible,
  rankSemanticCandidates,
  diagnosticCandidatesForOperation,
  proposeTargetRecoveryFromSnapshot,
  structuralLabelText,
  structuralLabelHints,
  structuralScopeHints,
  interactionTriggerHints,
  semanticCandidateMatches,
  candidateForOperation,
  quotedLiterals,
  targetNamesFor,
  firstLaterSemanticOperation,
  firstLaterActionOperation,
  exactNextRequiredControl,
  exactNextAuthoredActionControl,
  exactAuthoredDestinationReached,
  exactLaterAuthoredAssertion,
  exactWaitStateReached,
  exactPageTransitionCommitted,
  minimumCandidateCountForObservation,
  popupAssociationEvidence,
  accordionStateFromSnapshot,
  evaluateOptionalCondition,
  diagnosticSnapshotPreview,
  evaluatePayload,
  sanitizeSnapshotLine,
  structuralExcerpt,
  dedupeCandidates,
  exactFillAcknowledgment,
  protectedPasswordAcknowledgment,
  controllerAssertionContract,
  assertionTargetName,
  evaluateControllerAssertionSnapshot,
  createControllerMcpRuntimeAdapter,
};
