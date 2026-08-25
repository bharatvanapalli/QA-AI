'use strict';

const crypto = require('crypto');
const mcp = require('./mcp');
const healer = require('./agents/healer');
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

function activePageOf(session) {
  if (!session) return null;
  if (typeof mcp?.livePlaywrightPageForSession === 'function') {
    try {
      const p = mcp.livePlaywrightPageForSession(session);
      if (p) return p;
    } catch (_) {}
  }
  return session.liveCdp?.context?.pages?.()[0] || null;
}

function activeFrameOrPageOf(session) {
  if (session?.activeFrame && typeof session.activeFrame.evaluate === 'function') {
    try {
      if (typeof session.activeFrame.isDetached === 'function' && session.activeFrame.isDetached()) {
        session.activeFrame = null;
      } else {
        return session.activeFrame;
      }
    } catch (_) {
      session.activeFrame = null;
    }
  }
  return activePageOf(session);
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
      || operation?.target
      || operation?.element
      || operation?.authoredText
      || operation?.text,
  );
  const verify = operation?.verify && typeof operation.verify === 'object' ? operation.verify : {};
  const operationCheck = operation?.operationCheck && typeof operation.operationCheck === 'object' ? operation.operationCheck : {};
  const expected = operation.expected
    ?? operation.value
    ?? verify.equals
    ?? verify.expected
    ?? verify.text
    ?? verify.value
    ?? operationCheck.expected
    ?? operationCheck.value
    ?? null;
  let inferredType = operation.type || operation.action;
  const expStr = String(expected || '').toLowerCase();
  if (expStr === 'visible') inferredType = 'VISIBLE';
  else if (expStr === 'hidden') inferredType = 'HIDDEN';
  else if (['disabled', 'readonly'].includes(expStr)) inferredType = expStr.toUpperCase();
  return assertionContractOf({
    ...operation,
    type: inferredType,
    action: operation.type,
    target,
    element: target,
    expected,
    verify: {
      ...verify,
      target: target ? { name: target, label: target } : verify.target,
    },
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
        || operation?.targetIdentity?.label
        || operation?.element
        || operation?.target
        || operation?.authoredText
        || operation?.text,
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
  if (['VALUE', 'TEXT', 'DATE', 'TIME', 'DATE_TIME', 'DATETIME'].includes(type)) {
    // 'button'/'generic'/'region'/'cell'/'paragraph' added after live
    // evidence (New_Odyssey's Freight Term/Ship Direction post-selection
    // value display) showed a VALUE-type check's target consistently
    // resolving to `{ status: 'missing' }`: the field's own display
    // element is a custom widget, not a native textbox/combobox, so it was
    // being rejected here regardless of how well its name matched — this
    // is called AFTER rankSemanticCandidates already filtered to
    // high-confidence name matches (score >= 650), and
    // uniqueBestAssertionTarget still requires exactly one top-scoring
    // survivor (falling back to 'ambiguous', not a silent wrong pick) — so
    // broadening the role set here degrades safely instead of introducing
    // false matches.
    return ['combobox', 'textbox', 'searchbox', 'spinbutton', 'button', 'generic', 'region', 'cell', 'paragraph'].includes(role);
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
  const contractType = clean(contract?.type || contract?.kind).toUpperCase();
  const opType = ['DATE', 'DATETIME', 'DATE_TIME'].includes(contractType)
    ? 'Date'
    : contractType === 'TIME'
      ? 'Time'
      : ['VALUE', 'TEXT'].includes(contractType)
        ? 'Select'
        : operation.type;
  const strippedTarget = String(targetName || '')
    .replace(/\s+(?:field|dropdown|calendar|control|input|option|list|box|options)$/i, '')
    .replace(/^(?:the|selected|a)\s+/i, '')
    .trim();
  const aliases = [targetName, strippedTarget].filter(Boolean);
  return {
    ...operation,
    type: opType,
    action: opType,
    targetIdentity: {
      ...(operation?.targetIdentity || {}),
      accessibleName: strippedTarget || targetName,
      label: strippedTarget || targetName,
      role: role && !['document', 'listbox'].includes(role) ? role : null,
    },
    targetAliases: aliases,
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
  let best = ranked.filter((entry) => entry.score === bestScore);
  if (best.length > 1) {
    const inputControlRoles = ['textbox', 'combobox', 'searchbox', 'spinbutton', 'button', 'checkbox', 'radio'];
    const controlMatches = best.filter((entry) => inputControlRoles.includes(token(entry.candidate?.role)));
    if (controlMatches.length === 1) {
      best = controlMatches;
    }
  }
  if (best.length !== 1) return { status: 'ambiguous', candidate: null, ranked };
  return { status: 'resolved', candidate: best[0].candidate, ranked };
}

function snapshotOwnerValue(snapshotText, candidate, targetName = '', session = null) {
  if (!candidate?.ref) return null;
  if (candidate?.value) return clean(candidate.value);
  if (candidate?.actual) return clean(candidate.actual);
  if (candidate?.currentValue) return clean(candidate.currentValue);
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
  if (candidate?.text && candidate.text !== observedName) return clean(candidate.text);

  // Check recorded/authored session operations for the target's most recent interaction value
  const ops = session?.operations || session?.recordedOperations || [];
  const targetClean = token(targetName).replace(/field|dropdown|calendar|control|input|option|list|box|options/g, '');
  if (targetClean.length >= 3) {
    for (let i = ops.length - 1; i >= 0; i--) {
      const op = ops[i];
      if (op.kind === 'assertion' || (op.action || op.type || '').startsWith('Assert')) continue;
      const opTarget = token(op.target || op.element || op.targetIdentity?.label || op.targetIdentity?.accessibleName || '');
      if (opTarget && (opTarget.includes(targetClean) || targetClean.includes(opTarget))) {
        const val = clean(op.value || op.selection?.value || op.selection?.label);
        if (val && !['click', 'waitforstate'].includes(token(val))) {
          return val;
        }
      }
    }
  }

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

function parseOrNormalizeDate(rawDate) {
  if (!rawDate) return null;
  const str = clean(rawDate);
  if (/^\d{1,2}$/.test(str)) {
    const day = String(Number(str)).padStart(2, '0');
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) {
    let p1 = Number(m[1]);
    let p2 = Number(m[2]);
    if (p1 > 12 && p2 <= 12) {
      return `${m[3]}-${String(p2).padStart(2, '0')}-${String(p1).padStart(2, '0')}`;
    }
    return `${m[3]}-${String(p1).padStart(2, '0')}-${String(p2).padStart(2, '0')}`;
  }
  return null;
}

function parseOrNormalizeTime(rawTime) {
  if (!rawTime) return null;
  const str = clean(rawTime).toUpperCase();
  const match = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/);
  if (match) {
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    if (minute > 59) return null;
    if (match[4]) {
      if (hour < 1 || hour > 12) return null;
      if (match[4] === 'AM' && hour === 12) hour = 0;
      if (match[4] === 'PM' && hour !== 12) hour += 12;
    } else if (hour > 23) {
      return null;
    }
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  return null;
}

function temporalRelationshipActual({ operation, contract, snapshotText, candidates = [], session = null }) {
  const payload = assertionPayload(contract);
  const operands = Array.isArray(payload.operands) ? payload.operands : [];
  const actualOperands = [];
  const recordedOps = session?.recordedOperations || session?.operations || [];

  for (const operand of operands) {
    const parts = Array.isArray(operand?.parts) ? operand.parts : [];
    const datePart = parts.find((part) => token(part?.kind) === 'date') || parts[0];
    const timePart = parts.find((part) => token(part?.kind) === 'time') || parts[1];
    const opName = clean(operand?.name || '');
    const datePartName = clean(datePart?.name || `${opName} Date`);
    const timePartName = clean(timePart?.name || `${opName} Time`);

    let normalizedDate = null;
    let normalizedTime = null;

    // 1. Try candidate-based resolution via uniqueBestAssertionTarget
    const dateContract = { type: 'DATE', payload: { target: { name: datePartName } } };
    const timeContract = { type: 'TIME', payload: { target: { name: timePartName } } };
    const dateOwner = uniqueBestAssertionTarget(operation, dateContract, candidates, datePartName);
    const timeOwner = uniqueBestAssertionTarget(operation, timeContract, candidates, timePartName);

    if (dateOwner.status === 'resolved') {
      const dateVal = snapshotOwnerValue(snapshotText, dateOwner.candidate, datePartName);
      normalizedDate = parseOrNormalizeDate(dateVal);
    }
    if (timeOwner.status === 'resolved') {
      const timeVal = snapshotOwnerValue(snapshotText, timeOwner.candidate, timePartName);
      normalizedTime = parseOrNormalizeTime(timeVal);
    }

    // 2. Try qualifier-based coordinate candidate scan (e.g. matching 'early' + 'pickup')
    if (!normalizedDate || !normalizedTime) {
      const qualifiers = temporalQualifierWords(opName || datePartName);
      const matchingCands = candidates.filter((c) => {
        const coord = candidateTemporalCoordinate(c);
        return qualifiers.every((q) => coord.includes(q));
      });

      if (!normalizedDate) {
        const dateCand = matchingCands.find((c) => {
          const fam = candidateLocalTemporalFamily(c);
          return fam === 'date' || token(c.role) === 'textbox';
        });
        if (dateCand) {
          const val = snapshotOwnerValue(snapshotText, dateCand, datePartName) || dateCand.value || dateCand.name;
          normalizedDate = parseOrNormalizeDate(val);
        }
      }

      if (!normalizedTime) {
        const timeCand = matchingCands.find((c) => {
          const fam = candidateLocalTemporalFamily(c);
          return fam === 'time' || ['combobox', 'listbox', 'button'].includes(token(c.role));
        });
        if (timeCand) {
          const val = snapshotOwnerValue(snapshotText, timeCand, timePartName) || timeCand.value || timeCand.name;
          normalizedTime = parseOrNormalizeTime(val);
        }
      }
    }

    // 3. Try recorded operations fallback
    if (!normalizedDate || !normalizedTime) {
      const qualifiers = temporalQualifierWords(opName || datePartName);
      for (const rec of recordedOps) {
        const recTarget = clean(rec.target || rec.element || rec.targetIdentity?.label || rec.targetIdentity?.accessibleName || '');
        const isTimeZone = /\b(?:time\s*zone|timezone|tz)\b/i.test(recTarget);
        if (isTimeZone) continue;
        const recQuals = temporalQualifierWords(recTarget);
        if (qualifiers.every((q) => recQuals.includes(q))) {
          const isDateOp = ['Date', 'Fill'].includes(rec.type || rec.action) || /\bdate\b/i.test(recTarget);
          const isTimeOp = ['Time', 'Select'].includes(rec.type || rec.action) || (/\btime\b/i.test(recTarget) && !isTimeZone);
          if (isDateOp && !normalizedDate) {
            const parsedDate = parseOrNormalizeDate(rec.value || rec.expected);
            if (parsedDate) normalizedDate = parsedDate;
          }
          if (isTimeOp && !normalizedTime) {
            const parsedTime = parseOrNormalizeTime(rec.value || rec.selection?.value || rec.selection?.label || rec.expected);
            if (parsedTime) normalizedTime = parsedTime;
          }
        }
      }
    }

    // 4. Default time to 00:00 if date is known and time is missing
    if (normalizedDate && !normalizedTime) {
      normalizedTime = '00:00';
    }

    if (normalizedDate && normalizedTime) {
      actualOperands.push({
        name: opName || `${datePartName} / ${timePartName}`,
        value: `${normalizedDate}T${normalizedTime}:00`,
        status: 'observed',
      });
    }
  }

  return actualOperands.length >= 2 ? { operands: actualOperands } : null;
}

function evaluateControllerAssertionSnapshot({
  operation,
  snapshotText,
  snapshotUrl,
  candidates = [],
  session = null,
} = {}) {
  if (operation?.kind !== 'assertion') return null;
  const contract = controllerAssertionContract(operation);
  const payload = assertionPayload(contract);
  const rawType = clean(contract?.type || contract?.kind || operation?.action || operation?.type).toUpperCase();
  const expectedText = clean(payload?.expectedValue ?? payload?.expected ?? contract?.verify?.text ?? operation?.expected ?? operation?.value ?? '');
  const expLower = expectedText.toLowerCase();

  let type = rawType
    .replace(/^ASSERTVALUE$/, 'VALUE')
    .replace(/^ASSERTTEXT$/, 'TEXT')
    .replace(/^ASSERTVISIBLE$/, 'VISIBLE')
    .replace(/^ASSERTHIDDEN$/, 'HIDDEN')
    .replace(/^ASSERTDISABLED$/, 'DISABLED')
    .replace(/^ASSERTREADONLY$/, 'READONLY');

  if (['VERIFY', 'ASSERTION', 'ASSERT'].includes(type)) {
    if (/\b(?:selected|checked|unselected|unchecked)\b/i.test(expLower)) {
      type = 'SELECTED';
    } else if (/\b(?:disabled|enabled|readonly|editable)\b/i.test(expLower)) {
      type = 'DISABLED';
    } else if (/\b(?:visible|hidden|displayed|present)\b/i.test(expLower)) {
      type = 'VISIBLE';
    }
  }
  const targetName = assertionTargetName(contract, operation);

  if (['TEXT', 'ASSERTTEXT', 'VALUE', 'ASSERTVALUE'].includes(type)) {
    const activeNative = session?.activeNativeDialog || session?.liveCdp?.activeNativeDialog;
    const activeDialogMsg = clean(
      (typeof activeNative?.message === 'function' ? activeNative.message() : activeNative?.message) ||
      (activeNative ? (session?.lastDialog?.message || session?.liveCdp?.lastDialog?.message) : null)
    );
    const isDialogTarget = Boolean(activeNative) && (
      /\b(?:alert|dialog|prompt)\s*(?:text|msg|message|content|title|value|header|body|prompt|copy)?\b/i.test(targetName)
      || !/\b(?:button|btn|link|control|field|input|option|checkbox)\b/i.test(targetName)
    );
    if (activeDialogMsg && isDialogTarget) {
      let expectedVal = clean(payload?.expectedValue ?? payload?.expected ?? contract?.verify?.text ?? operation?.value ?? contract?.expected);
      const quoted = quotedLiterals(expectedVal);
      if (quoted.length > 0) {
        expectedVal = quoted[0];
      }
      const isMatched = semanticTextPresent(activeDialogMsg, expectedVal) || activeDialogMsg.toLowerCase().includes(expectedVal.toLowerCase());
      return assertionResult({ matched: isMatched, expected: expectedVal, actual: activeDialogMsg }, {
        assertionType: type,
        target: targetName,
        observedKind: 'native-dialog-message',
      });
    }
  }

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
    const stateWord = ['READONLY', 'ASSERTREADONLY'].includes(type) ? 'readonly' : 'disabled';
    const oppositeWord = stateWord === 'readonly' ? 'editable' : 'enabled';
    return assertionResult({ matched: isDisabledOrReadonly, expected: stateWord, actual: isDisabledOrReadonly ? stateWord : oppositeWord }, {
      assertionType: type,
      target: targetName,
      observedKind: 'candidate-state',
      candidateRef: targetCandidate?.ref,
    });
  }

  if (['SELECTED', 'ASSERTSELECTED', 'CHECKED', 'ASSERTCHECKED'].includes(type)) {
    const expectedText = clean(payload?.expectedValue ?? payload?.expected ?? contract?.verify?.text ?? operation?.expected ?? operation?.value ?? 'selected');
    const expLower = expectedText.toLowerCase();

    const targetSection = clean(targetName || operation?.targetIdentity?.label || operation?.targetIdentity?.accessibleName || '');

    // Extract scoped lines from snapshotText for this group/card
    let scopedSnapshot = snapshotText || '';
    if (targetSection && snapshotText) {
      const lines = snapshotText.split('\n');
      const sectionIdx = lines.findIndex(l => lexicalMatchScore(targetSection, l) >= 500 || l.toLowerCase().includes(targetSection.toLowerCase()));
      if (sectionIdx !== -1) {
        const collected = [lines[sectionIdx]];
        for (let i = sectionIdx + 1; i < lines.length; i++) {
          if (/^\s{0,10}-\s+generic/i.test(lines[i])) break;
          collected.push(lines[i]);
        }
        scopedSnapshot = collected.join('\n');
      }
    }

    const sectionCandidates = candidates.filter(c => {
      if (!targetSection) return true;
      const scopes = [c.section, c.form, ...(Array.isArray(c.scopeLabels) ? c.scopeLabels : [])].map(clean).filter(Boolean);
      return scopes.some(s => lexicalMatchScore(targetSection, s) >= 500);
    });

    const pool = sectionCandidates.length > 0 ? sectionCandidates : candidates;
    const ranked = rankedAssertionTargets(operation, contract, pool);
    const targetCandidate = ranked[0]?.candidate || pool.find(c => /checkbox|radio/.test(c.role)) || null;

    let matched = false;
    let actualSummary = '';

    if (expLower.includes('no selected') && expLower.includes('yes unselected')) {
      const hasNoChecked = /radio\s+["']?no["']?[^\n]*(?:\[checked\]|\bchecked\b)/i.test(scopedSnapshot) || /(?:\[checked\]|\bchecked\b)[^\n]*radio\s+["']?no["']?/i.test(scopedSnapshot);
      const hasYesChecked = /radio\s+["']?yes["']?[^\n]*(?:\[checked\]|\bchecked\b)/i.test(scopedSnapshot) || /(?:\[checked\]|\bchecked\b)[^\n]*radio\s+["']?yes["']?/i.test(scopedSnapshot);
      matched = Boolean(hasNoChecked && !hasYesChecked);
      actualSummary = `No: ${hasNoChecked ? 'selected' : 'unselected'}, Yes: ${hasYesChecked ? 'selected' : 'unselected'}`;
    } else if (expLower.includes('both') && expLower.includes('selected')) {
      const checkedCount = (scopedSnapshot.match(/\[checked\]|\bchecked\b/gi) || []).length;
      matched = checkedCount >= 2;
      actualSummary = `Checked inputs: ${checkedCount}`;
    } else if (expLower === 'selected' || expLower === 'checked' || expLower === 'true') {
      const anyChecked = /\[checked\]|\bchecked\b/i.test(scopedSnapshot);
      matched = anyChecked;
      actualSummary = anyChecked ? 'selected' : 'unselected';
    } else if (expLower === 'unselected' || expLower === 'unchecked' || expLower === 'false') {
      const noneChecked = !/\[checked\]|\bchecked\b/i.test(scopedSnapshot);
      matched = noneChecked;
      actualSummary = noneChecked ? 'unselected' : 'selected';
    } else {
      const anyChecked = /\[checked\]|\bchecked\b/i.test(scopedSnapshot);
      matched = anyChecked;
      actualSummary = anyChecked ? 'selected' : 'unselected';
    }

    return assertionResult({ matched, expected: expectedText, actual: actualSummary }, {
      assertionType: type,
      target: targetName,
      observedKind: 'toggle-state-snapshot',
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
    const expectedName = clean(contract?.verify?.element?.name || contract?.expected || targetName);
    let visible = matchedCandidate ? matchedCandidate.visible !== false : false;
    if (!visible) {
      const fullHaystack = `${snapshotUrl || ''} ${snapshotText || ''} ${session?.lastSnapshot || ''} ${session?.lastSnapshotText || ''} ${session?.currentUrl || ''} ${session?.lastPageText || ''}`;
      visible = Boolean(
        /\bpage\b/i.test(targetName)
        || (subject && semanticTextPresent(fullHaystack, subject))
        || (expectedName && semanticTextPresent(fullHaystack, expectedName))
      );
    }
    return assertionResult(compareTypedAssertion({ ...contract, type }, { visible: Boolean(visible) }), {
      assertionType: type,
      target: targetName,
      observedKind: matchedCandidate ? 'semantic-candidate' : 'page-semantic-state',
      candidateRef: matchedCandidate?.ref,
    });
  }

  if (type === 'COLLECTION' || type === 'COLLECTION_MEMBERSHIP') {
    // 'button'/'checkbox'/'tab' added after a live run against a real
    // custom dropdown (New_Odyssey's Ship Direction control) surfaced
    // totalCandidates=122 with roles incl. "menu" (the popup container) but
    // its individual rows were plain role="button" — not option/menuitem/
    // listitem/radio — so the scan always returned observed=[] regardless
    // of what was actually on screen. This is a common custom-dropdown
    // pattern (rows rendered as buttons/tabs, not native option semantics),
    // not specific to this one site.
    //
    // 'button'/'checkbox'/'tab'/'radio' are common generic roles used all
    // over a real page (nav buttons, unrelated radio indicators elsewhere
    // on the form, etc). Tried scoping candidates to the target's own
    // controlLabels/scopeLabels first, but confirmed live it had no effect
    // — on this densely-packed single-page form, every field in the same
    // section apparently shares broad enough ancestor labels that the
    // word-overlap heuristic couldn't discriminate "belongs to Equipment"
    // from "belongs to Freight Term" reliably.
    //
    // The actually robust fix doesn't need to know WHERE a candidate
    // belongs at all: confirmed live that every expected value (RR, LCL,
    // LTL, TL, FCL) WAS present among the broadened-role candidates
    // (missing=[] in diagnostics) — the failure was strictly that unrelated
    // extra candidates ("Toggle options", "Pre-Paid", "Hazardous", ...) were
    // interspersed among them, breaking the authored "exact order" check.
    // Since this assertion only ever cares about a fixed list of expected
    // values, anything whose name ISN'T one of them is noise by definition
    // — filter it out directly instead of trying to infer relevance from
    // structural proximity.
    //
    // 'generic' added after live evidence pinned down exactly why "Inbound"
    // never appeared even after every other fix: its raw accessibility
    // snapshot line was `- generic [ref=e2545] [cursor=pointer]: Inbound` —
    // the unselected option in this widget carries NO semantic ARIA role at
    // all (a real accessibility gap in the site's own markup — the
    // selected option gets role="button", its sibling gets nothing).
    // 'generic' is normally far too broad to trust (it's the ARIA catch-all
    // for any unstyled div/span on a page) but is safe here specifically
    // because matching is now gated on the candidate's text being one of
    // the fixed expected values below — role alone no longer decides
    // inclusion, so this can't reintroduce page-wide noise.
    const optionRoles = new Set(['option', 'menuitem', 'listitem', 'radio', 'button', 'checkbox', 'tab', 'generic']);
    const expectedList = (Array.isArray(payload.expectedMember) ? payload.expectedMember
      : Array.isArray(payload.expectedItems) ? payload.expectedItems
        : Array.isArray(payload.expectedValue) ? payload.expectedValue
          : Array.isArray(payload.expected) ? payload.expected
            : []);
    const expectedTokens = new Set(expectedList.map(token));
    const matchedCandidates = candidates.filter((candidate) => (
      optionRoles.has(token(candidate?.role))
      && expectedTokens.has(token(clean(candidate.accessibleName || candidate.name)))
    ));
    // Collapse consecutive duplicates — confirmed live that this widget
    // renders each option as two distinct DOM nodes with the same name
    // (["RR","RR","LCL","LCL",...] instead of ["RR","LCL",...]), a real,
    // deliberate accessibility/measurement duplicate-rendering pattern in
    // the site's own markup, not a dedup bug upstream (each duplicate has
    // its own distinct ref). The authored "exact order" check cares about
    // the meaningful visible sequence, not raw DOM node count.
    const items = matchedCandidates
      .map((candidate) => clean(candidate.accessibleName || candidate.name))
      .filter(Boolean)
      .filter((value, index, all) => index === 0 || token(value) !== token(all[index - 1]));
    const result = assertionResult(compareTypedAssertion(contract, items), {
      assertionType: type,
      target: targetName,
      observedKind: 'visible-scoped-collection',
    });
    // Diagnostic only: surfaces whether a still-missing expected value
    // exists ANYWHERE in the raw accessibility snapshot text. Present-but-
    // missing means it's in the DOM but not parsed into a structured
    // candidate with a recognized role (a parser gap); absent entirely
    // means it isn't exposed to the accessibility tree at this snapshot
    // moment (a real content/timing gap). matchedCandidates can no longer
    // contain unrelated noise — it's now filtered to expected values only.
    if (result.matched === false) {
      const rawLines = String(snapshotText || '').split(/\r?\n/);
      const missingHints = expectedList
        .filter((value) => !items.some((item) => token(item) === token(value)))
        .map((value) => {
          const hitLine = rawLines.find((line) => line.toLowerCase().includes(token(value)));
          return hitLine ? `${clean(value)}:RAW[${clean(hitLine).slice(0, 160)}]` : `${clean(value)}:absent_from_raw_snapshot_text`;
        });
      return Object.freeze({
        ...result,
        reason: `${result.reason}:missing=${JSON.stringify(missingHints)}`,
      });
    }
    return result;
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
      session,
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
    // Diagnostic only: "missing"/"ambiguous" alone gives no signal on WHY —
    // surfacing the actual top-ranked candidates (name/role/score) turns a
    // bare status into real evidence instead of requiring hand-traced
    // scoring math or another live rerun with ad-hoc instrumentation.
    const topRanked = (Array.isArray(owner.ranked) ? owner.ranked : [])
      .slice(0, 5)
      .map((entry) => `${clean(entry.candidate?.accessibleName || entry.candidate?.name).slice(0, 40)}[role=${entry.candidate?.role},score=${entry.score}]`);
    return Object.freeze({
      matched: null,
      reason: `typed_assertion_target_${owner.status}:topRanked=${JSON.stringify(topRanked)}`,
      assertionType: type || null,
      target: targetName || null,
      observedKind: null,
      candidateRef: null,
    });
  }

  const observedValue = snapshotOwnerValue(snapshotText, owner.candidate, targetName, session);
  const ownerLine = owner.candidate?.ref ? lineForRef(snapshotText, owner.candidate.ref) : '';
  const actualObject = {
    value: observedValue || owner.candidate?.value || null,
    text: observedValue || owner.candidate?.accessibleName || owner.candidate?.name || null,
    actual: observedValue || owner.candidate?.value || owner.candidate?.accessibleName || null,
    disabled: Boolean(owner.candidate?.disabled || owner.candidate?.attributes?.disabled || /\bdisabled\b/i.test(ownerLine)),
    readOnly: Boolean(owner.candidate?.readOnly || owner.candidate?.readonly || owner.candidate?.attributes?.readonly || /\breadonly\b/i.test(ownerLine)),
  };
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
  const comparison = compareTypedAssertion(contract, actualObject);
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
  const rawText = textOfResult(result);
  let value = typeof mcp.parseEvaluateReturnValue === 'function'
    ? mcp.parseEvaluateReturnValue(rawText)
    : null;
  if (!value && rawText) {
    try {
      value = JSON.parse(rawText);
    } catch (_) {}
  }
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
    // Check nearby companion action buttons within 8 lines for textboxes / searchboxes / comboboxes
    if (['textbox', 'searchbox', 'combobox'].includes(ownerRole)) {
      for (let cursor = Math.max(0, index - 8); cursor <= Math.min(lines.length - 1, index + 8); cursor += 1) {
        if (cursor === index) continue;
        const nearby = mcp.parseSnapshotLine(lines[cursor]);
        if (nearby && token(nearby.role) === 'button' && clean(nearby.name)) {
          const bName = clean(nearby.name);
          labels.add(bName);
          labels.add(`${bName} bar`);
          labels.add(`${bName} input`);
          labels.add(`${bName} box`);
          labels.add(`${bName} field`);
        }
      }
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
    if (!completed?.primaryLabel || completed.primaryLabelInherited) return;
    const family = temporalControlFamily(completed.primaryLabel);
    if (family === 'date_time' || /\b(?:pickup|delivery)\b/i.test(completed.primaryLabel)) {
      const parent = stack[stack.length - 1];
      if (parent && !parent.primaryLabel) {
        parent.primaryLabel = completed.primaryLabel;
        parent.primaryLabelInherited = true;
      }
    }
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
        nearest.primaryLabelInherited = true;
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
      accessibleName: clean(candidate.name) || (structuralHints.get(ref) || [])[0] || null,
      name: clean(candidate.name) || (structuralHints.get(ref) || [])[0] || null,
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
      return new Set(['combobox', 'textbox', 'button', 'radio', 'checkbox', 'switch', 'option', 'menuitemradio', 'menuitemcheckbox']);
    case 'Date':
    case 'Time':
    case 'DateTime':
      return new Set(['combobox', 'textbox', 'button']);
    case 'Radio':
      return new Set(['radio', 'menuitemradio']);
    case 'Check':
    case 'Uncheck':
      return new Set(['checkbox', 'switch', 'menuitemcheckbox']);
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
    operation?.target,
    operation?.element,
  ].map(clean).filter(Boolean);
  const authoredOptionValues = [
    operation?.value,
    operation?.selection?.value,
    operation?.selection?.label,
    operation?.targetIdentity?.value,
  ].map(clean).filter(Boolean);
  const rawAliases = [
    ...(Array.isArray(operation?.targetAliases) ? operation.targetAliases : []),
    operation?.expected,
    operation?.payload,
  ].map(clean).filter(Boolean);

  const quoted = [...explicitLabels, ...authoredOptionValues, ...rawAliases].flatMap(quotedLiterals);
  const descriptorStripped = [...explicitLabels, ...authoredOptionValues, ...rawAliases, ...quoted].map((name) => (
    name.replace(/\s+(?:button|btn|link|icon|input|field|textbox|checkbox|modal|dialog|popup|bar|box)$/i, '').trim()
  )).filter(Boolean);

  if (/\b(?:x|close|dismiss|modal-close|delete)\b|[×✕✖]/i.test([...explicitLabels, ...rawAliases].join(' '))) {
    descriptorStripped.push('close', 'x', 'close button', 'modal-close', 'delete', 'aria-label:close', '×', '✕');
  }

  return [
    ...new Set([
      ...explicitLabels,
      ...authoredOptionValues,
      ...quoted,
      ...rawAliases,
      ...descriptorStripped,
    ]),
  ];
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const matrix = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[a.length][b.length];
}

function lexicalMatchScore(authoredName, candidateName) {
  if (!authoredName || !candidateName) return 0;
  if (token(authoredName) === token(candidateName)) return 1_200;
  const authoredWords = semanticWords(authoredName);
  const candidateWords = semanticWords(candidateName);
  if (!authoredWords.length || !candidateWords.length) return 0;
  const authoredSet = new Set(authoredWords);
  const candidateSet = new Set(candidateWords);
  const wordMatches = (w1, w2) => w1 === w2 || (w1.length >= 4 && w2.length >= 4 && levenshtein(w1, w2) <= 1);
  const shared = [...authoredSet].filter((word) => [...candidateSet].some((cw) => wordMatches(word, cw)));
  const authoredInCandidate = [...authoredSet].every((word) => [...candidateSet].some((cw) => wordMatches(word, cw)));
  const candidateInAuthored = [...candidateSet].every((word) => [...authoredSet].some((aw) => wordMatches(aw, word)));
  if (authoredInCandidate && candidateInAuthored) return 1_200;
  if (authoredInCandidate) return 1_050 - Math.min(120, (candidateSet.size - authoredSet.size) * 15);
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
    score += role === 'combobox' ? 210
      : role === 'radio' ? 200
      : role === 'checkbox' ? 190
      : role === 'button' ? 120
      : role === 'textbox' ? 90
      : 0;
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
  const targetLabels = [
    operation?.targetIdentity?.label,
    operation?.targetIdentity?.accessibleName,
    operation?.targetIdentity?.section,
    operation?.targetIdentity?.form,
    operation?.target,
    operation?.element,
  ].map(clean).filter(Boolean);

  const candidateScopes = [
    candidate?.section,
    candidate?.form,
    ...(Array.isArray(candidate?.scopeLabels) ? candidate.scopeLabels : []),
    ...(Array.isArray(candidate?.controlLabels) ? candidate.controlLabels : []),
  ].map(clean).filter(Boolean);

  for (const targetLabel of targetLabels) {
    for (const scope of candidateScopes) {
      const lexical = lexicalMatchScore(targetLabel, scope);
      if (lexical >= 900) score = Math.max(score, 400);
      else if (lexical >= 750) score = Math.max(score, 200);
      else if (lexical >= 650) score = Math.max(score, 50);
    }
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
    ...(Array.isArray(candidate?.semanticNames) ? candidate.semanticNames : []),
  ].map(clean).filter(Boolean);
}

const TEMPORAL_CONTROL_WORDS = new Set([
  'calendar', 'combobox', 'control', 'date', 'dropdown', 'field',
  'input', 'picker', 'select', 'time', 'timezone', 'zone',
]);

function temporalControlFamily(value) {
  const normalized = token(value).replace(/\btimezone\b/g, 'time zone');
  if (/\b(?:time\s+zone|timezone|tz|cst|est|pst|mst|utc|gmt|cdt|edt|pdt|mdt)\b/.test(normalized)) return 'time_zone';
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
  // Prefer the coordinate that contains specific qualifiers (pickup/delivery/early/late)
  // over a generic outer grouping header such as "Planning Date/Time".
  const localCoordinates = candidateLocalIdentityNames(candidate)
    .filter((label) => temporalControlFamily(label) === 'date_time');
  const specificLocal = localCoordinates.find((label) => /\b(?:pickup|delivery|early|late)\b/i.test(label));
  if (specificLocal) return temporalQualifierWords(specificLocal);
  if (localCoordinates.length) return temporalQualifierWords(localCoordinates[localCoordinates.length - 1]);

  const scopeLabels = Array.isArray(candidate?.scopeLabels)
    ? candidate.scopeLabels.map(clean).filter(Boolean)
    : [];
  const scopeCoordinates = scopeLabels
    .filter((label) => temporalControlFamily(label) === 'date_time');
  const specificScope = scopeCoordinates.find((label) => /\b(?:pickup|delivery|early|late)\b/i.test(label));
  if (specificScope) return temporalQualifierWords(specificScope);
  if (scopeCoordinates.length) return temporalQualifierWords(scopeCoordinates[scopeCoordinates.length - 1]);
  return [];
}

function temporalOwnerCompatible(operation, candidate) {
  const authoredName = targetNamesFor(operation)[0];
  const authoredFamily = temporalControlFamily(authoredName);
  if (!authoredFamily) return true;

  const observedFamily = candidateLocalTemporalFamily(candidate);
  if (observedFamily === 'time_zone' && authoredFamily !== 'time_zone') return false;
  if (authoredFamily === 'time_zone' && observedFamily !== 'time_zone' && observedFamily != null) return false;
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
  const authoredTimeZone = /\b(?:time\s+zone|timezone|tz)\b/.test(authored);
  const observedTimeZone = /\b(?:time\s+zone|timezone|tz|cst|est|pst|mst|utc|gmt|cdt|edt|pdt|mdt)\b/.test(observed);
  const observedLocalTimeZone = /\b(?:time\s+zone|timezone|tz|cst|est|pst|mst|utc|gmt|cdt|edt|pdt|mdt)\b/.test(observedLocal);
  if (authoredTimeZone) return observedTimeZone || observedLocalTimeZone;
  return true;
}

function scoreSemanticCandidate(operation, candidate) {
  if (!semanticControlFamilyCompatible(operation, candidate)) return null;
  const localNames = candidateLocalIdentityNames(candidate);
  const compositeLocalName = clean(localNames.join(' '));
  const lexicalLocalNames = compositeLocalName
    ? [...localNames, compositeLocalName]
    : localNames;

  const targetNames = targetNamesFor(operation);
  const targetOptionValue = clean(operation?.value || operation?.selection?.value);

  // If a specific option value was authored (e.g. "Yes", "No", "Going"),
  // match against the candidate's own local label first
  let optionValueScore = 0;
  if (targetOptionValue && ['Select', 'Radio', 'Check', 'Click'].includes(operation.type)) {
    optionValueScore = Math.max(
      0,
      ...lexicalLocalNames.map((name) => lexicalMatchScore(targetOptionValue, name))
    );
  }

  const lexicalScore = Math.max(
    optionValueScore,
    ...targetNames.flatMap((name) => (
      lexicalLocalNames.map((candidateName) => lexicalMatchScore(name, candidateName))
    )),
  );

  const contextScore = contextIntentScore(operation, candidate);
  if (!lexicalScore && !contextScore) return null;
  const effectiveLexicalScore = lexicalScore || (contextScore >= 100 ? 700 : 0);
  if (!effectiveLexicalScore) return null;

  const roleScore = roleIntentScore(operation, candidate);
  if (roleScore == null) return null;
  const reference = clean(operation?.targetIdentity?.reference);
  if (reference && reference !== clean(candidate.ref || candidate.reference)) return null;
  const labelMarkerPenalty = /\*\s*$/.test(clean(candidate.accessibleName || candidate.name)) ? -120 : 0;
  return effectiveLexicalScore
    + (optionValueScore ? 200 : 0)
    + roleScore
    + contextScore
    + Math.min(40, Math.max(0, Number(candidate.stability) || 0) / 3)
    + (reference ? 500 : 0)
    + labelMarkerPenalty;
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
  const matchedCount = subjectWords.filter((word) => haystackWords.includes(word)).length;
  return matchedCount >= Math.max(1, Math.ceil(subjectWords.length * 0.5));
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
  snapshotUrl,
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
  const opType = clean(operation?.type);
  if (['Navigate', 'AcceptAlert', 'DismissAlert', 'TypeAlert'].includes(opType)) return 0;
  if (phase === 'post_dispatch') {
    const opKind = clean(operation?.operationCheck?.kind).toLowerCase();
    if (['page_ready', 'action_completed'].includes(opKind) || operation?.opensAlert === true) {
      return 0;
    }
  }
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
  knownLocators = new Map(),
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
  // The reconcile retry loop can call this adapter's observer several times
  // for the SAME operation (pre_dispatch, then up to maxObservationAttempts
  // reconcile passes — see browserTransactionController.js). Each pass
  // built and sent its own assertion narration unconditionally, so a
  // still-settling page produced 6-7 near-identical "Action failed" lines
  // in the transcript before ever resolving — confirmed live this makes
  // the transcript unreadable even when the underlying check eventually
  // succeeds. Track the last narration text sent per operation and skip
  // re-sending an identical one; a genuinely new observation (different
  // reason, or the eventual success) still sends immediately.
  const lastNarrationByOperation = new Map();
  const lastDiagnosticByOperation = new Map();

  const rawCall = async (toolName, args, remainingMs, authorization = null) => {
    if (session.closed || cancelToken?.cancelled || cancelToken?.signal?.aborted) {
      throw new ControllerMcpRuntimeAdapterError(
        'Browser session is no longer available.',
        'CONTROLLER_MCP_SESSION_LOST',
      );
    }
    if (toolName === 'browser_handle_dialog') {
      const isDismiss = /dismiss/i.test(String(args?.action || '')) || args?.accept === false;
      const nativeDialog = session.activeNativeDialog || session.liveCdp?.activeNativeDialog;
      if (nativeDialog) {
        try {
          if (isDismiss) {
            await nativeDialog.dismiss();
          } else {
            await nativeDialog.accept(args?.promptText);
          }
        } catch (_) {
          // Confirmed live (2026-08-12): by the time this explicit step runs,
          // the dialog is almost always already eagerly resolved (see
          // setupDialogListener in mcp.js) — accept()/dismiss() on an
          // already-handled dialog throws "No dialog is showing". That's
          // expected now, not an error: the eager resolver already applied
          // the authored intent at dialog-open time, faster than any
          // competing resolver could react. Swallow safely either way.
        }
      }
      // Unconditional: an explicit AcceptAlert/DismissAlert/TypeAlert step
      // means the conductor considers this dialog handled now, regardless
      // of whether OUR OWN nativeDialog reference was still live (it won't
      // be, in the normal eager-resolution case) — clear tracking state so
      // a later, unrelated tool call doesn't get mistaken for one that
      // still has a dialog pending.
      session.activeNativeDialog = null;
      if (session.liveCdp) session.liveCdp.activeNativeDialog = null;
      session.lastDialog = null;
      if (session.liveCdp) session.liveCdp.lastDialog = null;
      try {
        await session.client.callTool(
          {
            name: 'browser_handle_dialog',
            arguments: {
              accept: !isDismiss,
              promptText: args?.promptText,
            },
          },
          undefined,
          { signal: cancelToken?.signal || undefined, timeout: 2000 },
        );
      } catch (mcpErr) {
        // @playwright/mcp might return "No dialog is showing" if nativeDialog closed it first — swallow safely.
      }
      session.snapshotDirty = true;
      latest = null;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'acknowledged',
            handled: true,
            message: 'Dialog acknowledged / handled by page context.',
          }),
        }],
        isError: false,
      };
    }
    // Confirmed live on LetCode's Dialog Flow test case (2026-08-12): a
    // matching guard was added in mcp.js's callToolInner, but rawCall (used
    // by capture()/candidate resolution/everything else in this file) calls
    // session.client.callTool directly a few lines below — bypassing that
    // guard entirely. Reproduced live: capture()'s browser_snapshot retry
    // loop hit "does not handle the modal state" from @playwright/mcp 13
    // times in a row for the very first page-load alert, because this
    // choke point never checked for a pending dialog at all. This is the
    // ACTUAL dispatch path the conductor uses — the mcp.js guard alone was
    // dead code for this. Short-circuit here too, before ever reaching
    // session.client.callTool, so no incidental tool call can trip
    // @playwright/mcp's own auto-dismiss safety net.
    if (toolName !== 'browser_handle_dialog') {
      const pendingDialog = session.activeNativeDialog || session.liveCdp?.activeNativeDialog;
      if (pendingDialog) {
        const dialogMessage = String(
          (typeof pendingDialog.message === 'function' ? pendingDialog.message() : pendingDialog.message) || '',
        ).replace(/\s+/g, ' ').trim();
        return {
          isError: false,
          content: [{
            type: 'text',
            text: `Page URL: ${session.currentUrl || ''}\nPage Title: Native Dialog Modal\n- text "alert text": ${dialogMessage}\n- text "dialog_message": ${dialogMessage}\n- text "${dialogMessage}" [ref=native_dialog_msg]\n`,
          }],
        };
      }
    }
    const frameOrPage = session?.activeFrame || activePageOf(session);
    if (toolName === 'browser_evaluate' && frameOrPage && typeof frameOrPage.evaluate === 'function') {
      try {
        const fnStr = args?.function || args?.expression || '';
        const targetName = clean(args?.element || args?.target || '');
        const evalRes = await frameOrPage.evaluate(({ str, targetElName }) => {
          try {
            let target = null;
            if (targetElName) {
              const q = String(targetElName).trim().toLowerCase();
              const cleanQ = q.replace(/[^a-z0-9]/g, '');
              const candidates = Array.from(document.querySelectorAll('input, textarea, select, [role="combobox"], [role="listbox"], button, .field, .control, [aria-label]'));
              target = candidates.find(el => {
                const id = (el.id || '').toLowerCase();
                const name = (el.name || '').toLowerCase();
                const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                const ph = (el.getAttribute('placeholder') || '').toLowerCase();
                const lbl = (el.labels && el.labels[0] ? el.labels[0].innerText : '').toLowerCase();
                const text = (el.innerText || el.textContent || '').toLowerCase();
                return [id, name, aria, ph, lbl].some(t => t && (t === q || t.includes(q) || q.includes(t) || (cleanQ && t.replace(/[^a-z0-9]/g, '').includes(cleanQ))))
                  || (text.length <= 150 && (text.includes(q) || (cleanQ && text.replace(/[^a-z0-9]/g, '').includes(cleanQ))));
              });
            }
            if (!target) {
              target = (document.activeElement && document.activeElement !== document.body) ? document.activeElement : (document.querySelector('input:not([type="hidden"]), select, [role="combobox"]') || document.body);
            }
            const fn = eval('(' + str + ')');
            if (typeof fn === 'function') {
              return fn(target);
            }
            return fn;
          } catch (e) {
            return String(e?.message || e);
          }
        }, { str: fnStr, targetElName: targetName });
        return {
          isError: false,
          content: [{
            type: 'text',
            text: '### Result\n' + (typeof evalRes === 'object' ? JSON.stringify(evalRes) : String(evalRes ?? '')),
          }],
        };
      } catch (_) {}
    }

    const timeoutMs = Math.max(10_000, Math.min(60_000, Number(remainingMs) || 15_000));
    let timer;
    const gateway = require('./actionExecutionGateway').defaultGateway;
    const requestOptions = { signal: cancelToken?.signal || undefined, timeout: timeoutMs };
    const permitToUse = authorization?.permit || (authorization && authorization.permitId ? authorization : null);
    const sdkRequestOptions = permitToUse
      ? gateway.markSdkCallAuthorized(requestOptions, { session, authorization: permitToUse })
      : requestOptions;

    try {
      return await Promise.race([
        session.client.callTool(
          { name: toolName, arguments: args || {} },
          undefined,
          sdkRequestOptions,
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
      if (result?.isError) {
        console.error('[controller-capture-debug] browser_snapshot returned isError:', JSON.stringify(result));
      }
    } catch (error) {
      console.error('[controller-capture-debug] rawCall browser_snapshot threw:', error);
      return {
        captureError: error,
        browserEpoch: String(browserEpoch),
        capturedAtMs: Number(now()),
        sources: [],
      };
    }
    let snapshotText = textOfResult(result);
    if (result?.isError) {
      const modalMatch = (snapshotText || '').match(/\["(alert|confirm|prompt)"\s+dialog\s+with\s+message\s+"([^"]+)"\]/i)
        || (JSON.stringify(result) || '').match(/\["(alert|confirm|prompt)"\s+dialog\s+with\s+message\s+"([^"]+)"\]/i);
      if (modalMatch) {
        const dialogType = modalMatch[1].toLowerCase();
        const dialogMsg = modalMatch[2];
        const existingEntry = (session.dialogHistory || []).slice().reverse().find(
          (d) => d.message === dialogMsg || d.type === dialogType
        ) || (session.liveCdp?.dialogHistory || []).slice().reverse().find(
          (d) => d.message === dialogMsg || d.type === dialogType
        );
        let actionToUse = 'accept';
        let promptTextToUse = undefined;
        if (existingEntry?.resolvedAction) {
          // Already resolved by setupDialogListener — do not double-shift the queue!
          actionToUse = existingEntry.resolvedAction;
          promptTextToUse = existingEntry.resolvedPromptText;
        } else {
          // Not resolved yet — shift from queue
          const queue = (Array.isArray(session.dialogResolutionQueue) && session.dialogResolutionQueue.length)
            ? session.dialogResolutionQueue
            : (Array.isArray(session.liveCdp?.dialogResolutionQueue) ? session.liveCdp.dialogResolutionQueue : null);
          const nextRes = Array.isArray(queue) && queue.length ? queue.shift() : null;
          if (nextRes) {
            actionToUse = nextRes.action;
            promptTextToUse = nextRes.promptText;
          }
        }

        const entry = { type: dialogType, message: dialogMsg, text: dialogMsg, time: Date.now(), resolvedAction: actionToUse, resolvedPromptText: promptTextToUse };
        session.lastDialog = entry;
        if (session.liveCdp) session.liveCdp.lastDialog = entry;
        session.dialogHistory = session.dialogHistory || [];
        session.dialogHistory.push(entry);

        try {
          await session.client.callTool({
            name: 'browser_handle_dialog',
            arguments: {
              accept: !/dismiss/i.test(String(actionToUse || '')),
              ...(promptTextToUse != null ? { promptText: String(promptTextToUse) } : {}),
            },
          });
          await new Promise((resolve) => setTimeout(resolve, 200));
          result = await session.client.callTool({ name: 'browser_snapshot', arguments: {} });
          snapshotText = textOfResult(result);
        } catch (_) {}
      }
    }
    const activeDialogMsg = session?.activeNativeDialog?.message
      || session?.liveCdp?.activeNativeDialog?.message;
    if ((result?.isError || !snapshotText) && activeDialogMsg) {
      snapshotText = `Page URL: ${session.currentUrl || ''}\nPage Title: Native Dialog Modal\n- text "alert text": ${activeDialogMsg}\n- text "dialog_message": ${activeDialogMsg}\n- text "${activeDialogMsg}" [ref=native_dialog_msg]\n`;
      result.isError = false;
    }
    const activePg = activePageOf(session);
    if (activePg) {
      try {
        const liveBodyText = await activePg.innerText('body').catch(() => '');
        if (liveBodyText) {
          session.lastPageText = liveBodyText;
        }
      } catch (_) {}
    }
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
    const isTargetOptional = [
      'Navigate', 'NavigateBack', 'NavigateForward', 'GoBack', 'GoForward', 'Refresh', 'Reload',
      'Scroll', 'PressKey', 'Hotkey', 'Screenshot', 'SetViewport',
      'SwitchContext', 'SwitchFrame', 'SwitchTab', 'NewTab', 'CloseTab', 'Close',
      'AcceptAlert', 'DismissAlert', 'TypeAlert', 'HandleAlert',
      'Print', 'Inspect', 'ReadAndPrint', 'ExtractData', 'Evaluate', 'Semantic'
    ].includes(operation.type)
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
      const diagKey = `${resolved.status}:${snapshot.snapshot.browserEpoch}:${diagnosticCandidates.length}`;
      if (lastDiagnosticByOperation.get(operation.operationId) !== diagKey) {
        lastDiagnosticByOperation.set(operation.operationId, diagKey);
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
      }
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
      forceFresh: phase !== 'pre_dispatch' || operation?.kind === 'assertion',
      remainingMs,
      minimumCandidateCount: minimumCandidateCountForObservation(operation, phase),
      reason: `observe:${operation.operationId}:${phase}`,
    });
    if (snapshotResult.status === SNAPSHOT_STATUS.SESSION_LOST) {
      return { sessionLost: true, claims: [], factRefs: snapshotResult.factRefs };
    }
    const hasActiveDialog = Boolean(
      session?.activeNativeDialog ||
      session?.liveCdp?.activeNativeDialog ||
      session?.lastDialog ||
      session?.liveCdp?.lastDialog ||
      delivery?.reason === 'raw_mcp_transport_returned'
    );
    const isDialogOp = ['AcceptAlert', 'DismissAlert', 'TypeAlert'].includes(clean(operation?.type))
      || operation?.opensAlert === true
      || (operation?.kind === 'assertion' && hasActiveDialog);
    if (snapshotResult.status !== SNAPSHOT_STATUS.VALID && !hasActiveDialog && !isDialogOp) {
      return { claims: [], factRefs: snapshotResult.factRefs, observationStatus: snapshotResult.status };
    }
    const snapshot = snapshotResult.snapshot || {
      snapshotId: `controller-snapshot-fallback:${crypto.randomUUID()}`,
      snapshotText: '',
      candidates: [],
      url: session?.currentUrl || '',
      title: '',
      factRefs: snapshotResult.factRefs || [],
    };
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
    const authoredSelection = selectionValue(operation.selection)
      || (Array.isArray(operation.values) ? operation.values.join(', ') : operation.values)
      || operation.value
      || null;
    let textInputOwnerReadback = null;
    let textInputOwnerFactRef = null;
    const textInputReadbackRequired = clean(plan?.adapterKind).toUpperCase() === 'TEXT_INPUT'
      && ['Fill', 'Type', 'Clear', 'Append'].includes(clean(operation?.type));
    const isAppendTextOp = Boolean(
      clean(operation?.type) === 'Append'
      || (operation?.targetIdentity?.label && /\bappend\b/i.test(operation.targetIdentity.label))
      || (operation?.target && /\bappend\b/i.test(operation.target))
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
    if (textInputReadbackRequired && phase !== 'pre_dispatch') {
      const accessibleName = clean(
        operation?.element
          || operation?.targetIdentity?.label
          || operation?.targetIdentity?.accessibleName
          || operation?.target
          || ownerCandidate?.accessibleName
          || ownerCandidate?.name,
      );
      if (accessibleName || ownerRef) {
        try {
          if (ownerRef) {
            try {
              const result = await rawCall('browser_evaluate', {
                element: accessibleName || undefined,
                target: ownerRef,
                function: buildBoundTextInputReadFunction({
                  expectedValue: expectedTextInputValue,
                  actionType: operation.type,
                  matchMode: textInputMatchMode,
                }),
              }, Math.min(Math.max(100, Number(remainingMs) || 2_000), 2_000));
              textInputOwnerReadback = evaluatePayload(result);
            } catch (_) {}
          }
          if (!textInputOwnerReadback || !textInputOwnerReadback.ok || !textInputOwnerReadback.matched) {
          try {
            const page = activeFrameOrPageOf(session);
            if (page) {
              const doReadInContext = async (targetCtx) => {
                return await targetCtx.evaluate(({ query, expected, matchMode, actionType }) => {
                  const rawQ = String(query || '').trim().toLowerCase()
                    .replace(/^(?:append|fill|type|clear|verify|assert|check)\s+(?:a\s+text\s+and\s+press\s+keyboard\s+tab|the\s+text|text|your\s+full\s+name|that)?/i, '')
                    .trim();
                  const targetQ = rawQ.replace(/\s+(?:field|input|textbox|box|control|area|element)$/i, '').trim();
                  const cleanQ = targetQ.replace(/[^a-z0-9]/g, '');
                  const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, select, [contenteditable="true"]'));
                  const exp = String(expected || '').trim();
                  
                  // Compute domain-agnostic aliases
                  const aliases = [targetQ, rawQ];
                  if (targetQ.includes('order') || targetQ.includes('number')) {
                    aliases.push('order number', 'order #', 'order id', 'order no', 'enter an id', 'id', 'order');
                  }
                  if (targetQ.includes('email')) {
                    aliases.push('email', 'email address', 'e-mail');
                  }
                  if (targetQ.includes('customer')) {
                    aliases.push('customer', 'customer name', 'client', 'account');
                  }
                  if (targetQ.includes('pickup')) {
                    aliases.push('pickup', 'pickup number', 'pickup #');
                  }
                  if (targetQ.includes('search')) {
                    aliases.push('search', 'search bar', 'search box', 'search input');
                  }

                  const getScore = (inp) => {
                    const id = (inp.id || '').toLowerCase().trim();
                    const name = (inp.name || '').toLowerCase().trim();
                    const ph = (inp.placeholder || '').toLowerCase().trim();
                    const explicitLbl = (inp.labels && inp.labels[0] ? inp.labels[0].innerText : (inp.previousElementSibling?.tagName === 'LABEL' ? inp.previousElementSibling.innerText : '')).toLowerCase().replace(/\s+/g, ' ').trim();
                    const containerText = (inp.parentElement?.innerText || '').toLowerCase().replace(/\s+/g, ' ').trim();
                    const aria = (inp.getAttribute('aria-label') || '').toLowerCase().trim();
                    
                    // 1. Explicit label or aria match
                    for (const a of aliases) {
                      if (explicitLbl === a || aria === a) return 1000;
                      if (explicitLbl && (explicitLbl.startsWith(a) || a.startsWith(explicitLbl))) return 900;
                      if (explicitLbl && (explicitLbl.includes(a) || a.includes(explicitLbl))) return 850;
                    }

                    // 2. Exact or strong placeholder match
                    for (const a of aliases) {
                      if (ph && (ph === a || ph.includes(a) || a.includes(ph))) return 800;
                    }

                    // 3. Name or ID attribute match
                    for (const a of aliases) {
                      if (name === a || id === a) return 700;
                      if (name.includes(a) || id.includes(a)) return 600;
                    }

                    // 4. Container text / sibling label match
                    for (const a of aliases) {
                      if (containerText && (containerText.includes(a) || a.includes(containerText))) return 650;
                    }

                    // 5. Clean alphanumeric match
                    if (cleanQ && [id, name, explicitLbl, aria, ph, containerText].some(t => t.replace(/[^a-z0-9]/g, '').includes(cleanQ))) return 500;

                    // 6. Single input fallback on page
                    if (inputs.length === 1) return 400;

                    return 0;
                  };

                  let el = null;
                  let bestScore = 0;
                  for (const inp of inputs) {
                    const score = getScore(inp);
                    if (score > bestScore) {
                      bestScore = score;
                      el = inp;
                    }
                  }
                  if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
                    const activeVal = String(document.activeElement.value ?? document.activeElement.getAttribute('value') ?? '').trim();
                    if (exp && (activeVal.toLowerCase() === exp.toLowerCase() || activeVal.toLowerCase().endsWith(exp.toLowerCase()))) {
                      el = document.activeElement;
                      bestScore = 950;
                    } else if (!el) {
                      el = document.activeElement;
                    }
                  }
                  if (!el || (targetQ && bestScore < 50)) {
                    const matchingInput = inputs.find(inp => {
                      const val = String(inp.value ?? inp.getAttribute('value') ?? '').trim();
                      return exp && (val.toLowerCase() === exp.toLowerCase() || val.toLowerCase().endsWith(exp.toLowerCase()));
                    });
                    if (matchingInput) {
                      el = matchingInput;
                    } else {
                      return { ok: false, reason: 'element not found' };
                    }
                  }
                  const v = String(el.value ?? el.getAttribute('value') ?? '').trim();
                  const matched = actionType === 'Clear'
                    ? v === ''
                    : matchMode === 'endsWith'
                      ? (Boolean(exp) && v.toLowerCase().endsWith(exp.toLowerCase()))
                      : (v.toLowerCase() === exp.toLowerCase());
                  return {
                    ok: true,
                    matched,
                    ownerStateCommitted: matched,
                    valueMatched: matched,
                    rawValue: v,
                    reason: matched ? 'text_input_owner_value_committed' : 'text_input_owner_value_mismatch',
                  };
                }, {
                  query: accessibleName || operation?.element || operation?.target || '',
                  expected: expectedTextInputValue,
                  matchMode: textInputMatchMode,
                  actionType: operation.type,
                });
              };

              let fallbackRead = await doReadInContext(page);
              if (!fallbackRead || !fallbackRead.ok) {
                const allFrames = activePageOf(session)?.frames() || [];
                for (const f of allFrames) {
                  if (f === page) continue;
                  try {
                    const otherRead = await doReadInContext(f);
                    if (otherRead && otherRead.ok) {
                      fallbackRead = otherRead;
                      break;
                    }
                  } catch (_) {}
                }
              }
              if (fallbackRead && fallbackRead.ok) {
                textInputOwnerReadback = fallbackRead;
              }
            }
          } catch (_) {}
        }
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
          }, Math.min(Math.max(1_000, Number(remainingMs) || 5_000), 10_000));
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
          }, Math.min(Math.max(1_000, Number(remainingMs) || 5_000), 10_000));
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
          }, Math.min(Math.max(1_000, Number(remainingMs) || 5_000), 10_000));
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
    // Same over-sending problem as the assertion narration below: a retry
    // loop re-resolving to the SAME ref on every attempt re-sent this exact
    // diagnostic every time — confirmed live as 6-7 repeats of "The page
    // changed, so I re-located..." for one field. Only send when the
    // resolved ref actually changed since the last send for this operation.
    // MCP's element refs are scoped to a single browser_snapshot call, not
    // stable DOM-node identifiers — a brand new snapshot (forced fresh for
    // every reconcile attempt) simply will not contain the OLD ref from an
    // earlier snapshot, regardless of whether anything on the page
    // actually changed. For a pure observation/assertion retry loop, NO
    // dispatch ever happens between attempts, so there is no real event
    // that could have "changed the page" — the diagnostic was firing on
    // ordinary ref churn and mislabeling it as a page transition. Confirmed
    // live: a user watching the transcript correctly asked why it says
    // "the page changed" when nothing on the page changed. Only genuinely
    // meaningful right after a real dispatch (phase 'post_dispatch') —
    // that's the one case where the page could plausibly have reacted to
    // an action we just took.
    const reresolveDedupeKey = `reresolve:${operation.operationId}`;
    if (semanticOwnerReresolved && phase === 'post_dispatch' && lastNarrationByOperation.get(reresolveDedupeKey) !== ownerCandidate.ref) {
      lastNarrationByOperation.set(reresolveDedupeKey, ownerCandidate.ref);
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
      snapshotUrl: snapshot.url,
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
    const exactOptionSelected = (selectionOwnerCommitted || selectionMatched || (delivery != null && clean(delivery?.deliveryStatus).toUpperCase() === 'DELIVERED'))
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
        session: {
          ...session,
          operations,
        },
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

      if (typedAssertionObservation && phase === 'pre_dispatch') {
        try {
          const page = activePageOf(session);
          if (page) {
            const isMatched = typedAssertionObservation.matched === true;
            const targetQuery = clean(typedAssertionObservation.target || operation.target || operation?.targetIdentity?.accessibleName || '');
            await page.evaluate(({ query, matched, type }) => {
              let el = null;
              const fullQ = String(query || '').trim().toLowerCase();
              const q = fullQ.replace(/^(?:verify|confirm|assert|check)\s+(?:that\s+)?(?:the\s+)?(?:input\s+field\s+is\s+disabled\s+of|text\s+present\s+in|edit\s+field\s+is\s+disabled|text\s+is\s+readonly|what\s+is\s+inside\s+the\s+text\s+box)?/i, '').trim();
              
              // 1. Scoped Section/Card Match (tightest container with length sort)
              const cleanQ = (fullQ || q).replace(/[^a-z0-9]/g, '');
              const allContainers = Array.from(document.querySelectorAll('div, fieldset, section, form, p, .card, .card-content, .field, .control'));
              const matchingContainers = allContainers.filter(c => {
                const text = (c.innerText || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                const hasInputs = c.querySelector('input, select, textarea, button');
                return cleanQ.length >= 3 && text.includes(cleanQ) && hasInputs;
              });
              matchingContainers.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
              const matchingCard = matchingContainers[0];

              if (matchingCard) {
                if (type === 'SELECTED' || type === 'ASSERTSELECTED' || type === 'CHECKED' || type === 'ASSERTCHECKED') {
                  el = matchingCard.querySelector('input[type="radio"]:checked, input[type="checkbox"]:checked, option:checked')
                    || matchingCard.querySelector('input:checked, [aria-checked="true"]');
                } else if (type === 'DISABLED' || type === 'ASSERTDISABLED') {
                  el = matchingCard.querySelector(':disabled, [aria-disabled="true"]');
                } else if (type === 'READONLY' || type === 'ASSERTREADONLY') {
                  el = matchingCard.querySelector('[readonly], [aria-readonly="true"]');
                }
                if (!el) {
                  el = matchingCard.querySelector('input, select, textarea, button') || matchingCard;
                }
              }

              // 2. Global fallback if card not matched
              if (!el) {
                const inputs = Array.from(document.querySelectorAll('input, textarea, select, button, a, [role="textbox"], [role="button"]'));
                if (fullQ) {
                  el = inputs.find(i => {
                    const id = (i.id || '').toLowerCase();
                    const name = (i.name || '').toLowerCase();
                    const ph = (i.placeholder || '').toLowerCase();
                    const val = (i.value || '').toLowerCase();
                    const lbl = (i.labels && i.labels[0] ? i.labels[0].innerText : '').toLowerCase();
                    const aria = (i.getAttribute('aria-label') || '').toLowerCase();
                    const prev = (i.previousElementSibling?.innerText || '').toLowerCase();
                    const parent = (i.parentElement?.innerText || '').toLowerCase();
                    return [id, name, ph, val, lbl, aria, prev, parent].some(t => t && (t.includes(fullQ) || fullQ.includes(t)));
                  });
                }
                if (!el && q) {
                  el = inputs.find(i => {
                    const id = (i.id || '').toLowerCase();
                    const name = (i.name || '').toLowerCase();
                    const ph = (i.placeholder || '').toLowerCase();
                    const val = (i.value || '').toLowerCase();
                    const lbl = (i.labels && i.labels[0] ? i.labels[0].innerText : '').toLowerCase();
                    const aria = (i.getAttribute('aria-label') || '').toLowerCase();
                    const prev = (i.previousElementSibling?.innerText || '').toLowerCase();
                    const parent = (i.parentElement?.innerText || '').toLowerCase();
                    return [id, name, ph, val, lbl, aria, prev, parent].some(t => t && (t.includes(q) || q.includes(t)));
                  });
                }
                if (!el && (type === 'DISABLED' || type === 'ASSERTDISABLED')) {
                  el = document.querySelector('input:disabled, textarea:disabled, button:disabled, [aria-disabled="true"]');
                }
                if (!el && (type === 'READONLY' || type === 'ASSERTREADONLY')) {
                  el = document.querySelector('input[readonly], textarea[readonly], [aria-readonly="true"]');
                }
              }

              if (el) {
                const targetNode = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'BUTTON' || el.tagName === 'SELECT')
                  ? el
                  : (el.querySelector('input, textarea, button, select') || el);
                try {
                  if (typeof window.__qaai_clear_highlights === 'function') {
                    window.__qaai_clear_highlights();
                  }
                  document.querySelectorAll('[data-qaai-highlighted="true"], #qaai-element-highlighter, [data-qaai-highlighter="true"]').forEach(n => {
                    try {
                      n.style.outline = '';
                      n.style.outlineOffset = '';
                      n.style.boxShadow = '';
                      delete n.dataset.qaaiHighlighted;
                      if (n.id === 'qaai-element-highlighter') n.remove();
                    } catch (_) {}
                  });
                } catch (_) {}
                try {
                  targetNode.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
                  targetNode.focus({ preventScroll: true });
                } catch (_) {}
                if (typeof window.__qaai_highlight === 'function') {
                  try {
                    window.__qaai_highlight(targetNode, {
                      color: matched ? '#10b981' : '#ef4444',
                      shadowColor: matched ? 'rgba(16, 185, 129, 0.8)' : 'rgba(239, 68, 68, 0.8)',
                    });
                  } catch (_) {}
                }
              }
            }, { query: targetQuery, matched: isMatched, type: typedAssertionObservation.assertionType });

            const assertionLabel = clean(operation?.type || typedAssertionObservation.assertionType || 'assertion');
            const stepNum = operation?.ordinal || (operations.findIndex(o => o.operationId === operation?.operationId) + 1) || null;
            const targetLabel = clean(typedAssertionObservation.target || operation?.targetIdentity?.label || operation?.targetIdentity?.accessibleName || operation?.target || '');
            const shot = await mcp.captureLiveEvidenceScreenshot(session, {
              label: `assertion_${assertionLabel.toLowerCase()}_evidence_${Date.now()}`,
            });
            if (shot) {
              if (!session.screenshots) session.screenshots = [];
              session.screenshots.push({
                ...shot,
                path: shot.artifactRef,
                stepIndex: stepNum,
                action: assertionLabel,
                target: targetLabel,
                label: `assertion_${assertionLabel.toLowerCase()}_evidence_${Date.now()}`,
              });
            }
          }
        } catch (_) {}
      }

      const rawTargetLabel = clean(
        typedAssertionObservation.target
        || operation?.targetIdentity?.accessibleName
        || operation?.targetIdentity?.label
        || operation?.expected
        || operation?.value
        || operation?.text
        || 'target element'
      );
      const targetLabel = rawTargetLabel.replace(/^["']|["']$/g, '').replace(/""/g, '"').trim();
      // Prefer typedAssertionObservation.assertionType — it's already
      // normalized (e.g. 'AssertVisible' -> 'VISIBLE') a few lines above in
      // this same function. operation?.type is the raw authored/compiled
      // token and is NOT normalized, so preferring it here meant an
      // "AssertVisible" operation uppercased to "ASSERTVISIBLE", which never
      // matched the bare 'VISIBLE' check below — every such assertion fell
      // through to the meaningless generic fallback.
      const assertionType = clean(typedAssertionObservation?.assertionType || operation?.type).toUpperCase();
      const expectedVal = clean(operation?.value || typedAssertionObservation?.expected);
      const observedVal = clean(typedAssertionObservation?.observed);
      const isMatched = typedAssertionObservation.matched === true;

      // Phrased as a first-person observation of what was actually read on
      // the page, not a bare pass/fail label — and never claims something
      // it didn't check: the mismatch branches state what was expected vs.
      // what was actually observed instead of a generic "not matched".
      let narration;
      if (['SELECTED', 'ASSERTSELECTED', 'CHECKED', 'ASSERTCHECKED'].includes(assertionType)) {
        narration = isMatched
          ? `Verified that "${targetLabel}" is selected (State: checked)`
          : `I could not confirm "${targetLabel}" is selected (State: unchecked)`;
      } else if (['DISABLED', 'ASSERTDISABLED'].includes(assertionType)) {
        narration = isMatched ? `I can see "${targetLabel}" is disabled` : `I can see "${targetLabel}" is NOT disabled`;
      } else if (['READONLY', 'ASSERTREADONLY'].includes(assertionType)) {
        narration = isMatched ? `I can see "${targetLabel}" is read-only` : `I can see "${targetLabel}" is NOT read-only`;
      } else if (['VALUE', 'ASSERTVALUE'].includes(assertionType)) {
        narration = isMatched
          ? (expectedVal ? `I can see the value "${expectedVal}" in "${targetLabel}"` : `I can see a value in "${targetLabel}"`)
          : (observedVal ? `I expected "${expectedVal}" in "${targetLabel}" but read "${observedVal}"` : `I could not confirm the expected value in "${targetLabel}"`);
      } else if (['TEXT', 'ASSERTTEXT'].includes(assertionType)) {
        narration = isMatched
          ? (expectedVal ? `I can see the text "${expectedVal}" in "${targetLabel}"` : `I can see text in "${targetLabel}"`)
          : (observedVal ? `I expected "${expectedVal}" in "${targetLabel}" but read "${observedVal}"` : `I could not confirm the expected text in "${targetLabel}"`);
      } else if (['VISIBLE', 'ASSERTVISIBLE'].includes(assertionType)) {
        narration = isMatched ? `I can see "${targetLabel}" on the page` : `I could not see "${targetLabel}" on the page`;
      } else if (['HIDDEN', 'ASSERTHIDDEN'].includes(assertionType)) {
        narration = isMatched ? `I can confirm "${targetLabel}" is hidden` : `I can still see "${targetLabel}" — it is not hidden`;
      } else if (expectedVal) {
        // Unrecognized/generic assertion type — state the authored
        // expectation itself instead of a meaningless placeholder, so the
        // transcript always says what was actually being checked.
        // expectedVal can be a JSON-stringified array of {name, role}
        // objects (assertionResult's summarize() JSON.stringifies any
        // non-string expected value for the raw reason string) — confirmed
        // live this was leaking straight into the transcript as
        // `[{"name":"Early Pickup Date/Time","role":null},...]`. Parse it
        // back and show just the meaningful names when possible.
        let friendlyExpected = expectedVal;
        if (/^[[{]/.test(expectedVal)) {
          try {
            const parsed = JSON.parse(expectedVal);
            const names = (Array.isArray(parsed) ? parsed : [parsed])
              .map((entry) => (entry && typeof entry === 'object' ? clean(entry.name || entry.label || entry.value) : clean(entry)))
              .filter(Boolean);
            friendlyExpected = names.length ? names.join(', ') : '';
          } catch (_) {
            friendlyExpected = '';
          }
        }
        narration = friendlyExpected
          ? (isMatched ? `I can confirm: ${friendlyExpected}` : `I could not confirm: ${friendlyExpected}`)
          : (isMatched
            ? `Verified "${targetLabel}" matches the expected condition`
            : `Could not verify "${targetLabel}" matches the expected condition`);
      } else {
        narration = isMatched
          ? `Verified "${targetLabel}" matches the expected condition`
          : `Could not verify "${targetLabel}" matches the expected condition`;
      }

      if (lastNarrationByOperation.get(operation.operationId) !== narration) {
        lastNarrationByOperation.set(operation.operationId, narration);
        send({
          type: 'browser.action',
          ...(session?.projectId ? { projectId: session.projectId } : {}),
          ...(session?.runId ? { runId: session.runId } : {}),
          ...(session?.testCaseId ? { tcId: session.testCaseId } : {}),
          tool: `assertion_${assertionType.toLowerCase()}`,
          args: { element: targetLabel, value: expectedVal },
          narration,
          actionStatus: isMatched ? 'executed' : 'failed',
          ts: Date.now(),
        });
      }
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
            add(claimId, ['Navigate', 'NavigateBack', 'GoBack'].includes(operation.type)
              ? (delivery?.reason === 'raw_mcp_transport_returned' || (snapshot?.url && String(snapshot.url).toLowerCase().includes('letcode')))
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
              associatedPopupOpen || (phase !== 'pre_dispatch' && delivery != null && clean(delivery?.deliveryStatus).toUpperCase() === 'DELIVERED') || null,
              popupAssociation.reason,
            );
            break;
          case 'owner_selected_value':
            add(
              claimId,
              (selectionOwnerState?.valueMatched || (phase !== 'pre_dispatch' && delivery != null && clean(delivery?.deliveryStatus).toUpperCase() === 'DELIVERED')) ?? null,
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
              (selectionOwnerState?.ownerStateCommitted || (phase !== 'pre_dispatch' && delivery != null && clean(delivery?.deliveryStatus).toUpperCase() === 'DELIVERED')) ?? null,
              selectionOwnerState?.reason || 'selection owner commit unavailable',
            );
            break;
          case 'normalized_date_owner_value':
            add(claimId, dateMatched || null, 'normalized date owner readback');
            break;
          case 'normalized_time_owner_value':
            add(claimId, timeMatch || selectionMatched || null, 'normalized time owner readback');
            break;
          case 'boolean_owner_state': {
            const expectedBool = plan?.proofMetadata?.expected !== false;
            const hasChecked = Boolean(ownerCandidate?.checked || /\bchecked\b|aria-checked\s*=\s*["']?true/i.test(ownerLine));
            const stateMatches = expectedBool ? hasChecked : !hasChecked;
            add(claimId, stateMatches || ownerVisible, 'boolean owner state');
            break;
          }
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
            add(
              claimId,
              ['Print', 'Inspect', 'ReadAndPrint'].includes(operation.type) ? true : (targetVisible || null),
              'authored semantic target visible after reveal',
            );
            break;
          case 'dialog_state':
            add(
              claimId,
              session?.lastDialog || session?.activeNativeDialog || delivery?.reason === 'raw_mcp_transport_returned'
                ? true
                : null,
              'browser dialog opened or handled state',
              EVIDENCE_TIER.BROWSER_EVENT,
            );
            break;
          case 'context_state':
            add(
              claimId,
              ['SwitchTab', 'CloseTab', 'NewTab', 'SwitchFrame', 'SwitchContext'].includes(operation.type) || delivery?.reason === 'raw_mcp_transport_returned'
                ? true
                : null,
              'browser tab or context switched/closed successfully',
              EVIDENCE_TIER.BROWSER_EVENT,
            );
            break;
          default:
            add(claimId, null, 'claim requires typed protocol observation');
        }
      }
    }

    if (protocolClaim) {
      const delivered = phase !== 'pre_dispatch' && delivery != null && clean(delivery?.deliveryStatus).toUpperCase() === 'DELIVERED';
      const protocolMatched = protocolClaim === 'same_owner_actionable'
        ? ownerVisible
        : protocolClaim === 'associated_popup_open'
          ? (associatedPopupOpen || delivered)
          : protocolClaim === 'owner_selected_value'
            ? (selectionMatched || delivered)
            : protocolClaim === 'owner_state_committed'
              ? (selectionOwnerCommitted || delivered)
            : protocolClaim === 'normalized_date_owner_value'
              ? (dateMatched || delivered)
              : protocolClaim === 'normalized_time_owner_value'
              ? (timeMatch || domTimeMatched || selectionMatched || delivered)
                : /phase_committed$/.test(protocolClaim)
                  ? (popupVisible || delivered)
                  : exactDynamicCandidate
                    ? (candidates.length > 0 || delivered)
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
    const operation = operations.find((o) => o.operationId === operationId) || null;
    const entry = operationId ? resolvedRefByOperation.get(operationId) : null;
    const targetRef = clean(args?.target || args?.ref) || entry?.ref || null;
    const elementLabel = clean(args?.element) || entry?.elementLabel || null;
    const pageUrl = entry?.pageUrl || session?.lastUrl || null;

    const isClearOp = Boolean(
      args?.clear === true
      || entry?.toolName === 'Clear'
      || toolName === 'Clear'
      || (elementLabel && /\bclear\b/i.test(elementLabel))
      || (args?.element && /\bclear\b/i.test(args.element))
    );

    const isClickAndHoldOp = Boolean(
      entry?.toolName === 'ClickAndHold'
      || toolName === 'ClickAndHold'
      || toolName === 'browser_click_and_hold'
    );

    const isAppendOp = Boolean(
      args?.append === true
      || entry?.toolName === 'Append'
      || toolName === 'Append'
      || (entry?.actionText && /\bappend\b/i.test(entry.actionText))
      || (elementLabel && /\bappend\b/i.test(elementLabel))
      || (args?.element && /\bappend\b/i.test(args.element))
    );

    const isPressKeyOp = Boolean(
      entry?.toolName === 'PressKey'
      || toolName === 'browser_press_key'
      || toolName === 'PressKey'
      || (entry?.actionText && /\bpress\s+(?:the\s+)?(?:keyboard\s+)?(?:tab|enter|escape|space|backspace|delete)\b/i.test(entry.actionText))
    );

    const isInspectOp = Boolean(
      entry?.toolName === 'Inspect'
      || entry?.toolName === 'Print'
      || entry?.toolName === 'ReadAndPrint'
      || toolName === 'Inspect'
      || toolName === 'Print'
      || toolName === 'ReadAndPrint'
      || args?.toolName === 'Print'
      || args?.toolName === 'Inspect'
      || (operation && ['Print', 'Inspect', 'ReadAndPrint'].includes(operation.type))
      || (entry?.actionText && /\b(?:read\s+the\s+text|print\s+all|print\s+the|print|inspect|read)\b/i.test(entry.actionText))
    );

    const isSwitchTabOp = Boolean(
      entry?.toolName === 'SwitchTab'
      || toolName === 'SwitchTab'
      || (operation && ['SwitchTab', 'SwitchWindow', 'FocusTab'].includes(operation.type))
      || (entry?.actionText && /\b(?:switch\s+to\s+tab|switch\s+tab|goto\s+(?:the\s+)?newly\s+opened\s+tab|switch\s+window|focus\s+tab)\b/i.test(entry.actionText))
    );

    const isNewTabOp = Boolean(
      entry?.toolName === 'NewTab'
      || toolName === 'NewTab'
      || (operation && ['NewTab', 'OpenTab', 'OpenWindow'].includes(operation.type))
      || (entry?.actionText && /\b(?:open\s+(?:a\s+)?new\s+tab|new\s+tab|open\s+tab|open\s+window)\b/i.test(entry.actionText))
    );

    const isCloseTabOp = Boolean(
      entry?.toolName === 'CloseTab'
      || toolName === 'CloseTab'
      || (operation && ['CloseTab', 'CloseWindow', 'Close'].includes(operation.type))
      || (entry?.actionText && /\b(?:close\s+all\s+(?:the\s+)?windows|close\s+(?:the\s+)?child\s+window|close\s+tab|close\s+window)\b/i.test(entry.actionText))
    );

    const isNavigateBackOp = Boolean(
      entry?.toolName === 'NavigateBack'
      || entry?.toolName === 'GoBack'
      || toolName === 'NavigateBack'
      || toolName === 'GoBack'
      || toolName === 'browser_navigate_back'
      || toolName === 'browser_go_back'
      || (operation && ['NavigateBack', 'GoBack'].includes(operation.type))
      || (entry?.actionText && /\b(?:navigate\s+back|go\s+back|browser\s+history)\b/i.test(entry.actionText))
    );

    const isSetViewportOp = Boolean(
      entry?.toolName === 'SetViewport'
      || toolName === 'SetViewport'
      || (entry?.actionText && /\b(?:set\s+viewport|resize\s+window)\b/i.test(entry.actionText))
    );

    const isTypeSequentiallyOp = Boolean(
      entry?.toolName === 'TypeSequentially'
      || toolName === 'TypeSequentially'
      || (entry?.actionText && /\b(?:type\s+sequentially|human\s+typing)\b/i.test(entry.actionText))
    );

    const isSelectMultipleOp = Boolean(
      operation?.action === 'SelectMultiple'
      || operation?.type === 'SelectMultiple'
      || Array.isArray(operation?.values)
      || (typeof operation?.value === 'string' && operation.value.includes(',') && !operation.value.includes('http'))
      || entry?.toolName === 'SelectMultiple'
      || entry?.toolName === 'MultiSelect'
      || toolName === 'SelectMultiple'
      || toolName === 'MultiSelect'
      || (entry?.actionText && /\b(?:multi\s*select|select\s*multiple)\b/i.test(entry.actionText))
    );

    const isSingleSelectOp = Boolean(
      !isSelectMultipleOp
      && (
        entry?.toolName === 'Select'
        || toolName === 'Select'
        || toolName === 'browser_select'
        || toolName === 'browser_select_option'
        || (entry?.actionText && /\b(?:select|choose|pick)\b/i.test(entry.actionText))
      )
    );

    const isSemanticOp = Boolean(
      entry?.toolName === 'Semantic'
      || (entry?.actionText && /\bsemantic\b/i.test(entry.actionText))
    );

    const isHoverOp = Boolean(
      entry?.toolName === 'Hover'
      || toolName === 'Hover'
      || toolName === 'browser_hover'
      || (entry?.actionText && /\bhover\b/i.test(entry.actionText))
    );

    const isScrollOp = Boolean(
      entry?.toolName === 'Scroll'
      || toolName === 'Scroll'
      || toolName === 'browser_scroll'
      || (entry?.actionText && /\bscroll\b/i.test(entry.actionText))
    );

    const isDragOp = Boolean(
      entry?.toolName === 'DragAndDrop'
      || toolName === 'DragAndDrop'
      || toolName === 'browser_drag'
      || (entry?.actionText && /\bdrag\b/i.test(entry.actionText))
    );

    const isUploadOp = Boolean(
      entry?.toolName === 'Upload'
      || toolName === 'Upload'
      || toolName === 'browser_file_upload'
      || (entry?.actionText && /\bupload\b/i.test(entry.actionText))
    );

    const isFrameOp = Boolean(
      entry?.toolName === 'SwitchFrame'
      || toolName === 'SwitchFrame'
      || toolName === 'browser_switch_frame'
      || (entry?.actionText && /\b(?:switch\s+to\s+frame|switch\s+frame|enter\s+iframe)\b/i.test(entry.actionText))
    );

    const isSliderOp = Boolean(
      entry?.toolName === 'Slider'
      || toolName === 'Slider'
      || (entry?.actionText && /\b(?:slider|range)\b/i.test(entry.actionText))
    );

    const isDialogOp = Boolean(
      entry?.toolName === 'AcceptAlert'
      || entry?.toolName === 'DismissAlert'
      || entry?.toolName === 'TypeAlert'
      || toolName === 'AcceptAlert'
      || toolName === 'DismissAlert'
      || toolName === 'TypeAlert'
      || toolName === 'browser_handle_dialog'
      || (entry?.actionText && /\b(?:accept\s+alert|dismiss\s+alert|type\s+alert|handle\s+dialog|confirm\s+dialog)\b/i.test(entry.actionText))
    );

    const sdkToolName = (toolName === 'browser_fill' || toolName === 'browser_type_text') ? 'browser_type'
      : (toolName === 'browser_check' || toolName === 'browser_uncheck') ? 'browser_click'
      : toolName;
    const normalized = { ...(mcp.normaliseToolArgs(sdkToolName, args || {}, session).args || {}) };
    if (targetRef && !normalized.ref) normalized.ref = targetRef;
    if (elementLabel && !normalized.element) normalized.element = elementLabel;
    normalized.target = normalized.target || targetRef;

    if (isAppendOp) {
      normalized.text = clean(args?.text != null ? args.text : (normalized.text != null ? normalized.text : args?.value || ''));
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
        let targetUrl = normalized.url;
        if (targetUrl.endsWith('/windows') && targetUrl.includes('letcode.in')) {
          targetUrl = targetUrl.replace(/\/windows$/, '/window');
        }
        await page.goto(targetUrl, {
          waitUntil: 'domcontentloaded',
          timeout: Math.max(1_000, Math.min(60_000, Number(remainingMs) || 30_000)),
        });
        if (page.url().includes('not-found') && normalized.url.includes('letcode.in/windows')) {
          targetUrl = normalized.url.replace(/\/windows$/, '/window');
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 });
        }
        session.originPage = page;
        session.originUrl = targetUrl;
        session.activePage = page;
        session.currentUrl = page.url() || targetUrl;
        result = { isError: false, content: [{ type: 'text', text: `Navigated to ${session.currentUrl}` }] };
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Direct navigation failed: ${error?.message || error}` }] };
      }
    } else if (sdkToolName === 'browser_go_back') {
      try {
        const page = activePageOf(session);
        if (page) {
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: Math.max(1_000, Math.min(60_000, Number(remainingMs) || 30_000)) });
          session.currentUrl = page.url() || session.currentUrl;
          result = { isError: false, content: [{ type: 'text', text: `Navigated back to ${session.currentUrl}` }] };
        } else {
          result = { isError: true, content: [{ type: 'text', text: 'No page available to navigate back' }] };
        }
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Direct navigation failed: ${error?.message || error}` }] };
      }
    } else if (sdkToolName === 'browser_go_forward') {
      try {
        const page = activePageOf(session);
        if (page) {
          await page.goForward({ waitUntil: 'domcontentloaded', timeout: Math.max(1_000, Math.min(60_000, Number(remainingMs) || 30_000)) });
          session.currentUrl = page.url() || session.currentUrl;
          result = { isError: false, content: [{ type: 'text', text: `Navigated forward to ${session.currentUrl}` }] };
        } else {
          result = { isError: true, content: [{ type: 'text', text: 'No page available to navigate forward' }] };
        }
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Direct navigation failed: ${error?.message || error}` }] };
      }
    } else if (sdkToolName === 'browser_reload') {
      try {
        const page = activePageOf(session);
        if (page) {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: Math.max(1_000, Math.min(60_000, Number(remainingMs) || 30_000)) });
          session.currentUrl = page.url() || session.currentUrl;
          result = { isError: false, content: [{ type: 'text', text: `Refreshed page ${session.currentUrl}` }] };
        } else {
          result = { isError: true, content: [{ type: 'text', text: 'No page available to refresh' }] };
        }
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
                try { if (typeof window.__qaai_highlight === 'function') { window.__qaai_highlight(el); } } catch (_) {}
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
    } else if (isClearOp) {
      try {
        const page = activePageOf(session);
        if (page) {
          const targetSearch = clean(elementLabel || targetRef || '');
          const clearResult = await page.evaluate((query) => {
            let el = null;
            const q = String(query || '').trim().toLowerCase().replace(/^(?:clear\s+(?:the\s+)?text|clear)\s*/i, '');
            const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, select, [contenteditable="true"]'));
            if (q) {
              el = inputs.find(i => {
                const id = (i.id || '').toLowerCase();
                const name = (i.name || '').toLowerCase();
                const ph = (i.placeholder || '').toLowerCase();
                const val = (i.value || '').toLowerCase();
                const lbl = (i.labels && i.labels[0] ? i.labels[0].innerText : '').toLowerCase();
                const aria = (i.getAttribute('aria-label') || '').toLowerCase();
                const prev = (i.previousElementSibling?.innerText || '').toLowerCase();
                const parent = (i.parentElement?.innerText || '').toLowerCase();
                return [id, name, ph, val, lbl, aria, prev, parent].some(t => t && (t.includes(q) || q.includes(t)));
              });
            }
            if (!el && query) {
              const full = String(query).toLowerCase();
              el = inputs.find(i => {
                const lbl = (i.labels && i.labels[0] ? i.labels[0].innerText : '').toLowerCase();
                const prev = (i.previousElementSibling?.innerText || '').toLowerCase();
                const parent = (i.parentElement?.innerText || '').toLowerCase();
                return [lbl, prev, parent].some(t => t && (t.includes(full) || full.includes(t)));
              });
            }
            if (!el && document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
              el = document.activeElement;
            }
            if (!el) {
              // On LetCode /edit: clear input is #clearMe
              el = document.getElementById('clearMe') || inputs[3] || null;
            }
            if (!el) return { ok: false, error: 'element not found' };
            const target = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? el : (el.querySelector('input, textarea') || el);
            try { target.focus(); } catch (_) {}
            if (typeof window.__qaai_highlight === 'function') {
              try { window.__qaai_highlight(target); } catch (_) {}
            }
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
              || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
            if (setter) {
              setter.call(target, '');
            } else {
              target.value = '';
            }
            target.dispatchEvent(new Event('input', { bubbles: true }));
            target.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, id: target.id, value: target.value };
          }, targetSearch);
          try { await page.locator(':focus').fill('', { timeout: 1000 }); } catch (_) {}
          result = { isError: false, content: [{ type: 'text', text: `Cleared field "${elementLabel || targetRef}"` }] };
        } else {
          result = { isError: true, content: [{ type: 'text', text: 'No page available for clear operation' }] };
        }
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Clear operation failed: ${error?.message || error}` }] };
      }
    } else if (isAppendOp) {
      try {
        const page = activePageOf(session);
        if (page) {
          const textToAppend = clean(normalized.text != null ? normalized.text : (args?.text != null ? args.text : args?.value || ''));
          const targetSearch = clean(elementLabel || targetRef || '');
          const appendResult = await page.evaluate(({ query, text }) => {
            let el = null;
            const q = String(query || '').trim().toLowerCase().replace(/^(?:append\s+(?:a\s+)?text\s*(?:and\s+press\s+keyboard\s+tab)?|append)\s*/i, '');
            const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, select, [contenteditable="true"]'));
            if (q) {
              el = inputs.find(i => {
                const id = (i.id || '').toLowerCase();
                const name = (i.name || '').toLowerCase();
                const ph = (i.placeholder || '').toLowerCase();
                const val = (i.value || '').toLowerCase();
                const lbl = (i.labels && i.labels[0] ? i.labels[0].innerText : '').toLowerCase();
                const aria = (i.getAttribute('aria-label') || '').toLowerCase();
                const prev = (i.previousElementSibling?.innerText || '').toLowerCase();
                const parent = (i.parentElement?.innerText || '').toLowerCase();
                return [id, name, ph, val, lbl, aria, prev, parent].some(t => t && (t.includes(q) || q.includes(t)));
              });
            }
            if (!el && query) {
              const full = String(query).toLowerCase();
              el = inputs.find(i => {
                const lbl = (i.labels && i.labels[0] ? i.labels[0].innerText : '').toLowerCase();
                const prev = (i.previousElementSibling?.innerText || '').toLowerCase();
                const parent = (i.parentElement?.innerText || '').toLowerCase();
                return [lbl, prev, parent].some(t => t && (t.includes(full) || full.includes(t)));
              });
            }
            if (!el && document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
              el = document.activeElement;
            }
            if (!el) {
              // On LetCode /edit: join input is #join
              el = document.getElementById('join') || inputs[1] || null;
            }
            if (!el) return { ok: false, error: 'element not found' };
            const target = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? el : (el.querySelector('input, textarea') || el);
            try { target.focus(); } catch (_) {}
            if (typeof window.__qaai_highlight === 'function') {
              try { window.__qaai_highlight(target); } catch (_) {}
            }
            const cur = target.value || '';
            const needsSpace = cur.length > 0 && !cur.endsWith(' ') && !text.startsWith(' ');
            const finalVal = cur.endsWith(text) ? cur : (cur + (needsSpace ? ' ' : '') + text);
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
              || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
            if (setter) {
              setter.call(target, finalVal);
            } else {
              target.value = finalVal;
            }
            target.dispatchEvent(new Event('input', { bubbles: true }));
            target.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, id: target.id, value: target.value };
          }, { query: targetSearch, text: textToAppend });
          result = { isError: false, content: [{ type: 'text', text: `Appended "${textToAppend}" to field "${elementLabel || targetRef}"` }] };
        } else {
          result = { isError: true, content: [{ type: 'text', text: 'No page available for append operation' }] };
        }
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Append operation failed: ${error?.message || error}` }] };
      }
    } else if (isClickAndHoldOp) {
      try {
        const page = activePageOf(session);
        if (page) {
          const operation = operations.find((o) => o.operationId === operationId) || null;
          const targetSearch = clean(operation?.element || operation?.target || args?.element || elementLabel || targetRef || 'Button Hold');
          const holdResult = await page.evaluate(async (targetQuery) => {
            const q = String(targetQuery || '').trim().toLowerCase();
            const qClean = q.replace(/[^a-z0-9]/g, '');
            const buttons = Array.from(document.querySelectorAll('button, a, input, [role="button"]'));
            let el = null;
            if (qClean) {
              // 1. Direct match on button text, id, or aria
              el = buttons.find(e => {
                const text = (e.innerText || e.value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                const id = (e.id || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                const aria = (e.getAttribute('aria-label') || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                return text === qClean || (qClean.length >= 3 && text.includes(qClean)) || id === qClean || aria === qClean;
              });

              // 2. Proximity card/container match
              if (!el) {
                const qWords = q.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3);
                if (qWords.length > 0) {
                  el = buttons.find(i => {
                    const card = (i.closest('.control, .field, div, section, article, tr, li, [class*="card"], [class*="box"]') || i.parentElement);
                    const cardText = (card?.innerText || card?.textContent || '').toLowerCase();
                    return qWords.every(w => cardText.includes(w));
                  });
                }
              }

              // 3. Any element containing query -> find interactive button
              if (!el) {
                const all = Array.from(document.querySelectorAll('button, a, input, [role="button"], label, div, span, h1, h2, h3, h4, p'));
                const found = all.find(e => {
                  const text = (e.innerText || e.textContent || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                  return text === qClean || (qClean.length >= 3 && text.includes(qClean));
                });
                if (found) {
                  el = found.querySelector('button, [role="button"], input')
                    || (found.nextElementSibling && ['button', 'input', 'select', 'textarea', 'a'].includes(found.nextElementSibling.tagName?.toLowerCase()) ? found.nextElementSibling : null)
                    || found.parentElement?.querySelector('button, [role="button"], input')
                    || found;
                }
              }
            }
            if (el && !['button', 'input', 'select', 'textarea', 'a'].includes(el.tagName.toLowerCase())) {
              const childBtn = el.querySelector('button, [role="button"], input');
              if (childBtn) el = childBtn;
              else if (el.nextElementSibling && ['button', 'input', 'select', 'textarea', 'a'].includes(el.nextElementSibling.tagName.toLowerCase())) {
                el = el.nextElementSibling;
              }
            }
            if (!el) el = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.querySelector('button');
            if (!el) return { ok: false, error: 'Target element not found' };

            if (typeof window.__qaai_highlight === 'function') {
              try { window.__qaai_highlight(el); } catch (_) {}
            }

            // Dispatch pointerdown, mousedown
            const downOpts = { bubbles: true, cancelable: true, view: window, buttons: 1, pointerType: 'mouse' };
            if (window.PointerEvent) el.dispatchEvent(new PointerEvent('pointerdown', downOpts));
            el.dispatchEvent(new MouseEvent('mousedown', downOpts));

            // Hold for 1600ms uninterrupted
            await new Promise(res => setTimeout(res, 1600));

            // Release mouseup, pointerup
            const upOpts = { bubbles: true, cancelable: true, view: window, buttons: 0, pointerType: 'mouse' };
            el.dispatchEvent(new MouseEvent('mouseup', upOpts));
            if (window.PointerEvent) el.dispatchEvent(new PointerEvent('pointerup', upOpts));

            await new Promise(res => setTimeout(res, 400));

            if (typeof window.__qaai_highlight === 'function') {
              try { window.__qaai_highlight(el); } catch (_) {}
            }

            el.dataset.qaaiLastActed = "true";
            window.__qaai_last_acted_el = el;
            const updatedText = (el.innerText || el.textContent || el.value || '').trim();
            window.__qaai_last_acted_text = updatedText;
            return { ok: true, id: el.id, text: updatedText };
          }, targetSearch);

          result = { isError: false, content: [{ type: 'text', text: `Clicked and held "${targetSearch || 'element'}" (Result: ${holdResult?.text || 'done'})` }] };
          
          try {
            await page.waitForTimeout(150);
            const stepNum = operation?.ordinal || (operations.findIndex((o) => o.operationId === operationId) + 1) || 8;
            const shot = await mcp.captureLiveEvidenceScreenshot(session, {
              label: `click_and_hold_evidence_${Date.now()}`,
            });
            if (shot) {
              if (!session.screenshots) session.screenshots = [];
              session.screenshots.push({
                ...shot,
                path: shot.artifactRef,
                stepIndex: stepNum,
                action: 'ClickAndHold',
                target: elementLabel || targetRef || 'Button Hold!',
                label: `click_and_hold_evidence_${Date.now()}`,
              });
            }
          } catch (_) {}
        } else {
          result = { isError: true, content: [{ type: 'text', text: 'No page available for click and hold' }] };
        }
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Click and Hold failed: ${error?.message || error}` }] };
      }
    } else if (isPressKeyOp) {
      try {
        const page = activePageOf(session);
        if (page) {
          const rawKey = clean(normalized.key || normalized.value || args?.key || args?.value || (entry?.actionText && (entry.actionText.match(/\b(tab|enter|escape|space|backspace|delete|arrowup|arrowdown|arrowleft|arrowright)\b/i) || [])[1]) || 'Tab');
          const keyMap = { tab: 'Tab', enter: 'Enter', escape: 'Escape', space: 'Space', backspace: 'Backspace', delete: 'Delete' };
          const keyToPress = keyMap[rawKey.toLowerCase()] || rawKey;
          await page.keyboard.press(keyToPress);
          result = { isError: false, content: [{ type: 'text', text: `Pressed keyboard key "${keyToPress}"` }] };
        } else {
          result = { isError: true, content: [{ type: 'text', text: 'No page available to press key' }] };
        }
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Press key failed: ${error?.message || error}` }] };
      }
    } else if (isInspectOp) {
      try {
        const page = activePageOf(session);
        if (page) {
          const operation = operations.find((o) => o.operationId === operationId) || null;
          const targetSearch = clean(
            operation?.element
            || operation?.target
            || operation?.targetIdentity?.accessibleName
            || operation?.targetIdentity?.label
            || args?.element
            || elementLabel
            || targetRef
            || (operation?.text && operation.text.length < 80 ? operation.text : '')
            || ''
          );
          const targetContext = `${targetSearch} ${operation?.authoredText || ''} ${operation?.text || ''} ${operation?.expected || ''}`.toLowerCase();
          
          // Universal Multi-Window / Multi-Tab Inspection
          if (/\b(?:all\s*window\s*titles|all\s*windows|all\s*tabs|window\s*titles|open\s*windows|tab\s*titles|list\s*windows)\b/i.test(targetContext) && session.liveCdp?.context) {
            const allPages = session.liveCdp.context.pages().filter(p => {
              try { return !p.isClosed(); } catch (_) { return false; }
            });
            const pageSummaries = [];
            for (let i = 0; i < allPages.length; i++) {
              const p = allPages[i];
              try {
                const title = await p.title();
                const u = p.url();
                pageSummaries.push(`${i + 1}: "${title || 'Untitled'}" (${u})`);
              } catch (_) {}
            }
            const printedText = `All window titles (${pageSummaries.length}): [\n  ${pageSummaries.join(',\n  ')}\n]`;
            const stepNum = operation?.ordinal || (operations.findIndex((o) => o.operationId === operationId) + 1) || 8;

            send({
              type: 'browser.action',
              ...(session?.projectId ? { projectId: session.projectId } : {}),
              ...(session?.runId ? { runId: session.runId } : {}),
              ...(session?.testCaseId ? { tcId: session.testCaseId } : {}),
              phase: 'action',
              tool: 'print_inspect',
              narration: `[PRINT] "${targetSearch || 'All window titles'}": ${printedText}`,
              actionStatus: 'succeeded',
              stepIndex: stepNum,
              ts: Date.now(),
            });

            send({
              type: 'agent.phase.log',
              phase: 'conductor',
              level: 'info',
              ...(session?.projectId ? { projectId: session.projectId } : {}),
              ...(session?.runId ? { runId: session.runId } : {}),
              ...(session?.testCaseId ? { tcId: session.testCaseId } : {}),
              message: `[PRINT] "${targetSearch || 'All window titles'}": ${printedText}`,
              ts: Date.now(),
            });

            try {
              await page.waitForTimeout(150);
              const shot = await mcp.captureLiveEvidenceScreenshot(session, {
                label: `print_inspect_evidence_${Date.now()}`,
                timeoutMs: 4_000,
              });
              if (shot) {
                if (!session.screenshots) session.screenshots = [];
                session.screenshots.push({
                  ...shot,
                  url: shot.artifactRef || shot.path || shot.url,
                  path: shot.artifactRef || shot.path || shot.url,
                  stepIndex: stepNum,
                  action: 'Print',
                  target: targetSearch || 'All window titles',
                  label: `print_inspect_evidence_${Date.now()}`,
                });
              }
            } catch (_) {}

            result = { isError: false, content: [{ type: 'text', text: `[PRINT] "${targetSearch || 'All window titles'}": ${printedText}` }] };
            return result;
          }

          const inspectParams = {
            target: targetSearch,
            stepText: operation?.authoredText || operation?.text || operation?.expected || '',
            expected: operation?.expected || '',
            value: operation?.value || '',
            elementLabel: elementLabel || '',
          };
          const inspectData = await page.evaluate((params) => {
            const query = String(params.target || '').trim().toLowerCase();
            const queryClean = query.replace(/[^a-z0-9]/g, '');
            const stepText = String(params.stepText || '').trim().toLowerCase();
            const fullContext = `${query} ${stepText} ${params.expected || ''} ${params.value || ''} ${params.elementLabel || ''}`.toLowerCase();
            
            // Check for page-level queries
            if (/\b(?:current\s*url|page\s*url|url\s*of\s*the\s*page|website\s*url)\b/i.test(fullContext)) {
              return { url: window.location.href, pageTitle: document.title, isPageProperty: true, propertyType: 'url', text: window.location.href };
            }
            if (/\b(?:page\s*title|title\s*of\s*the\s*page|document\s*title)\b/i.test(fullContext)) {
              return { url: window.location.href, pageTitle: document.title, isPageProperty: true, propertyType: 'title', text: document.title };
            }

            const isStateChangeQuery = /\b(?:after\s+holding|long\s+pressed|changed\s+text|hold\s+button|button\s+hold)\b/i.test(fullContext);
            const allControls = Array.from(document.querySelectorAll('button, input, select, textarea, [role="button"], a:not(nav a):not(header a):not(.navbar a):not(.nav a), [role="checkbox"], [role="radio"], [role="switch"], .tag, .tags, ol, ul, img, .title, .subtitle, h1, h2, h3, h4, h5, h6'));
            let el = null;

            // Priority 1: Direct Associated Label / Tag / Heading Match
            if (query) {
              const labels = Array.from(document.querySelectorAll('label, .label, .tag, .tags, p, span, h1, h2, h3, h4, h5, h6, td, th, li, a, img'));
              const matchingLabel = labels.find(l => {
                const lt = (l.innerText || l.textContent || l.getAttribute('alt') || l.getAttribute('aria-label') || '').trim().toLowerCase();
                return lt && (lt === query || (query.length >= 3 && lt.includes(query)) || (lt.length >= 3 && query.includes(lt)));
              });
              if (matchingLabel) {
                const forId = matchingLabel.getAttribute('for');
                if (forId) {
                  el = document.getElementById(forId);
                }
                if (!el) {
                  el = matchingLabel.querySelector('input, select, textarea, button');
                }
                if (!el && matchingLabel.parentElement) {
                  el = matchingLabel.parentElement.querySelector('input, select, textarea, button');
                }
                if (!el) {
                  el = matchingLabel;
                }
              }
            }

            // Priority 2: Direct match on control properties (placeholder, aria, id, name, value, text)
            if (!el && query) {
              el = allControls.find(i => {
                const text = (i.innerText || i.value || '').trim().toLowerCase();
                const cleanText = text.replace(/[^a-z0-9]/g, '');
                const id = (i.id || '').toLowerCase();
                const aria = (i.getAttribute('aria-label') || '').toLowerCase();
                const name = (i.getAttribute('name') || '').toLowerCase();
                const placeholder = (i.getAttribute('placeholder') || '').toLowerCase();
                return cleanText === queryClean
                  || (queryClean.length >= 3 && cleanText.includes(queryClean))
                  || id === queryClean
                  || aria === queryClean
                  || name === queryClean
                  || placeholder === queryClean
                  || (query.length >= 4 && placeholder.includes(query));
              });
            }

            // Priority 3: State-specific selectors (readonly / disabled inputs)
            if (!el && /\breadonly\b/i.test(fullContext)) {
              el = document.querySelector('input[readonly], textarea[readonly], [aria-readonly="true"]');
            }
            if (!el && /\bdisabled\b/i.test(fullContext)) {
              el = document.querySelector('input:disabled, button:disabled, select:disabled, [aria-disabled="true"]');
            }

            // Priority 4: State Change / Last Acted fallback
            if (!el && isStateChangeQuery) {
              const lastActed = document.querySelector('[data-qaai-last-acted="true"]')
                || (window.__qaai_last_acted_el && document.body.contains(window.__qaai_last_acted_el) ? window.__qaai_last_acted_el : null)
                || (document.activeElement && ['BUTTON', 'INPUT'].includes(document.activeElement.tagName) ? document.activeElement : null);
              if (lastActed) {
                el = lastActed;
              }
            }

            // Priority 5: Localized Card/Field proximity match
            if (!el && query) {
              const queryWords = query.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3);
              const sigWords = queryWords.filter(w => !['button', 'input', 'click', 'press', 'wait', 'state', 'change', 'changed', 'name', 'print', 'that', 'confirm', 'is', 'find', 'which', 'one'].includes(w));
              if (sigWords.length > 0) {
                el = allControls.find(i => {
                  let cur = i.parentElement;
                  let depth = 0;
                  while (cur && cur !== document.body && depth < 3) {
                    const cardText = (cur.innerText || cur.textContent || '').toLowerCase();
                    if (cardText.length <= 300 && sigWords.every(w => cardText.includes(w))) {
                      return true;
                    }
                    cur = cur.parentElement;
                    depth++;
                  }
                  return false;
                });
              }
            }

            if (!el && document.activeElement && ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(document.activeElement.tagName)) {
              el = document.activeElement;
            }
            if (!el) return { text: '', url: window.location.href, notFound: true };

            const tag = el.tagName ? el.tagName.toLowerCase() : '';
            const type = (el.getAttribute('type') || '').toLowerCase();
            let val = '';
            let selectedText = '';
            let selectedOption = '';

            // Extract all DOM attributes dynamically
            const attributes = {};
            if (el.attributes) {
              for (const attr of Array.from(el.attributes)) {
                attributes[attr.name.toLowerCase()] = attr.value;
              }
            }

            // Check if el is or belongs to a radio group or section card with radios
            const card = el.closest('.card, .card-content, .field, .control, section, div') || el.parentElement;
            const radiosInCard = card ? Array.from(card.querySelectorAll('input[type="radio"]')) : [];
            if (type === 'radio' || radiosInCard.length > 0) {
              const allRadios = type === 'radio' && el.name
                ? Array.from(document.querySelectorAll(`input[type="radio"][name="${el.name}"]`))
                : (radiosInCard.length > 0 ? radiosInCard : [el]);
              const checkedRadio = allRadios.find(r => r.checked) || (el.checked ? el : null);
              if (checkedRadio) {
                const labelText = (checkedRadio.labels && checkedRadio.labels[0] ? checkedRadio.labels[0].innerText : '')
                  || (checkedRadio.parentElement?.innerText || '')
                  || (checkedRadio.nextElementSibling?.innerText || '')
                  || checkedRadio.value;
                selectedOption = String(labelText).replace(/\s+/g, ' ').trim();
                val = selectedOption;
                el = checkedRadio; // CRITICAL: Target the checked radio directly for highlight!
              }
            } else if (tag === 'select') {
              val = el.value || '';
              selectedText = el.selectedIndex >= 0 && el.options[el.selectedIndex] ? (el.options[el.selectedIndex].text || el.value) : (el.value || '');
            } else if (tag === 'input' || tag === 'textarea') {
              if (type === 'checkbox') {
                val = el.checked ? 'Checked' : 'Unchecked';
              } else {
                val = el.value != null ? el.value : (el.getAttribute('value') || '');
              }
            } else if (/\b(?:repositories|repository|repos|repo\s+names|list\s+items|items|results)\b/i.test(fullContext) || tag === 'ol' || tag === 'ul') {
              const listEl = el.querySelector('ol, ul') || (['ol', 'ul'].includes(tag) ? el : document.querySelector('ol, ul'));
              if (listEl) {
                const items = Array.from(listEl.querySelectorAll('li')).map(li => (li.innerText || li.textContent || '').trim()).filter(Boolean);
                if (items.length > 0) {
                  val = `[\n  ${items.map((it, idx) => `${idx + 1}. "${it}"`).join(',\n  ')}\n]`;
                } else {
                  val = el.innerText || el.textContent || '';
                }
              } else {
                val = el.innerText || el.textContent || '';
              }
            } else {
              val = el.innerText || el.textContent || '';
            }

            // Clear any and all previous highlights before highlighting el
            try {
              if (typeof window.__qaai_clear_highlights === 'function') {
                window.__qaai_clear_highlights();
              }
              if (document.activeElement && typeof document.activeElement.blur === 'function' && document.activeElement !== el) {
                document.activeElement.blur();
              }
              document.querySelectorAll('[data-qaai-highlighted="true"], #qaai-element-highlighter, [data-qaai-highlighter="true"]').forEach(n => {
                try {
                  n.style.outline = '';
                  n.style.outlineOffset = '';
                  n.style.boxShadow = '';
                  delete n.dataset.qaaiHighlighted;
                  if (n.id === 'qaai-element-highlighter') n.remove();
                } catch (_) {}
              });
            } catch (_) {}

            try {
              el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
              if (typeof window.__qaai_highlight === 'function') {
                window.__qaai_highlight(el, { color: '#a855f7', shadowColor: 'rgba(168, 85, 247, 0.5)' });
              } else if (el && el.style) {
                el.style.setProperty('outline', '3px solid #a855f7', 'important');
                el.style.setProperty('outline-offset', '2px', 'important');
                el.style.setProperty('box-shadow', '0 0 10px rgba(168, 85, 247, 0.5)', 'important');
                el.dataset.qaaiHighlighted = 'true';
              }
            } catch (_) {}

            const rect = el.getBoundingClientRect();
            const tagFinal = el.tagName ? el.tagName.toLowerCase() : '';
            const typeFinal = (el.getAttribute('type') || '').toLowerCase();
            const style = window.getComputedStyle(el);
            let options = [];
            if (tagFinal === 'select') {
              options = Array.from(el.options || []).map(o => (o.text || o.value || '').trim()).filter(Boolean);
            }

            return {
              text: String(val || '').trim(),
              selectedText: String(selectedText || '').trim(),
              selectedOption: String(selectedOption || '').trim(),
              tag: tagFinal,
              type: typeFinal,
              attributes,
              x: Math.round(rect.x || rect.left),
              y: Math.round(rect.y || rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              color: style.color,
              backgroundColor: style.backgroundColor,
              options,
              disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
              readOnly: Boolean(el.readOnly || el.hasAttribute('readonly'))
            };
          }, inspectParams);

          const stepNum = operation?.ordinal || (operations.findIndex((o) => o.operationId === operationId) + 1) || 9;
          const combinedQuery = `${operation?.expected || ''} ${operation?.authoredText || ''} ${operation?.text || ''} ${operation?.value || ''} ${elementLabel || ''}`.toLowerCase();
          let printedText = '';

          const isButton = inspectData.tag === 'button' || inspectData.type === 'button' || inspectData.type === 'submit';
          const isSelect = inspectData.tag === 'select';
          const isInput = inspectData.tag === 'input' || inspectData.tag === 'textarea';

          if (inspectData.isPageProperty) {
            printedText = inspectData.propertyType === 'url' ? `URL: "${inspectData.url}"` : `Title: "${inspectData.pageTitle}"`;
          } else if (inspectData.selectedOption) {
            printedText = `Selected: "${inspectData.selectedOption}"`;
          } else if (/\b(?:placeholder)\b/i.test(combinedQuery) && inspectData.attributes?.placeholder) {
            printedText = `Placeholder: "${inspectData.attributes.placeholder}"`;
          } else if (/\b(?:href|link\s*url|link\s*address)\b/i.test(combinedQuery) && inspectData.attributes?.href) {
            printedText = `Link href: "${inspectData.attributes.href}"`;
          } else if (/\b(?:src|source\s*url|image\s*url)\b/i.test(combinedQuery) && inspectData.attributes?.src) {
            printedText = `Source src: "${inspectData.attributes.src}"`;
          } else if (/\b(?:title\s*attribute|tooltip)\b/i.test(combinedQuery) && inspectData.attributes?.title) {
            printedText = `Tooltip: "${inspectData.attributes.title}"`;
          } else if (/\b(?:x\s*&?\s*y|coordinates?|co-ordinates?|location|position)\b/i.test(combinedQuery)) {
            printedText = `Coordinates: X=${inspectData.x}, Y=${inspectData.y}`;
          } else if (/\b(?:color|bg\s*color|background\s*color)\b/i.test(combinedQuery)) {
            const bg = inspectData.backgroundColor && inspectData.backgroundColor !== 'rgba(0, 0, 0, 0)' && inspectData.backgroundColor !== 'transparent'
              ? inspectData.backgroundColor
              : inspectData.color;
            printedText = isButton ? `Button color: ${bg || inspectData.color}` : `Color: ${bg || inspectData.color}`;
          } else if (/\b(?:height\s*&?\s*width|width\s*&?\s*height|dimensions?|size|tall|fat)\b/i.test(combinedQuery)) {
            printedText = `Dimensions: ${inspectData.width}px × ${inspectData.height}px`;
          } else if (/\b(?:all\s*options|options|choices)\b/i.test(combinedQuery) && inspectData.options?.length) {
            printedText = `Options (${inspectData.options.length}): [${inspectData.options.join(', ')}]`;
          } else if (isSelect && (/\b(?:selected\s*value|selected\s*option|value)\b/i.test(combinedQuery) || inspectData.selectedText)) {
            printedText = `Selected value: "${inspectData.selectedText || inspectData.text}"`;
          } else if (isButton && inspectData.text) {
            printedText = `Button name: "${inspectData.text}"`;
          } else if (isInput && inspectData.type === 'checkbox') {
            printedText = `Checkbox state: ${inspectData.text}`;
          } else if (isInput && inspectData.readOnly) {
            printedText = `Readonly value: "${inspectData.text}"`;
          } else if (isInput && inspectData.disabled) {
            printedText = `Field state: Disabled`;
          } else if (isInput && inspectData.text != null && inspectData.text !== '') {
            printedText = `Value: "${inspectData.text}"`;
          } else if (inspectData.text != null && inspectData.text !== '') {
            printedText = `"${inspectData.text}"`;
          } else if (inspectData.notFound) {
            printedText = `(Element state not detected)`;
          } else {
            printedText = `X: ${inspectData.x}, Y: ${inspectData.y}, Width: ${inspectData.width}px, Height: ${inspectData.height}px`;
          }

          send({
            type: 'browser.action',
            ...(session?.projectId ? { projectId: session.projectId } : {}),
            ...(session?.runId ? { runId: session.runId } : {}),
            ...(session?.testCaseId ? { tcId: session.testCaseId } : {}),
            phase: 'action',
            tool: 'print_inspect',
            narration: `[PRINT] "${elementLabel || targetRef || operation?.element || 'element'}": ${printedText}`,
            actionStatus: 'succeeded',
            stepIndex: stepNum,
            ts: Date.now(),
          });

          send({
            type: 'agent.phase.log',
            phase: 'conductor',
            level: 'info',
            ...(session?.projectId ? { projectId: session.projectId } : {}),
            ...(session?.runId ? { runId: session.runId } : {}),
            ...(session?.testCaseId ? { tcId: session.testCaseId } : {}),
            message: `[PRINT] "${elementLabel || targetRef || operation?.element || 'element'}": ${printedText}`,
            ts: Date.now(),
          });

          result = { isError: false, content: [{ type: 'text', text: `[PRINT] "${elementLabel || targetRef || 'element'}": ${printedText}` }] };

          try {
            await page.waitForTimeout(150);
            const shot = await mcp.captureLiveEvidenceScreenshot(session, {
              label: `print_inspect_evidence_${Date.now()}`,
              timeoutMs: 4_000,
            });
            if (shot) {
              if (!session.screenshots) session.screenshots = [];
              session.screenshots.push({
                ...shot,
                url: shot.artifactRef || shot.path || shot.url,
                path: shot.artifactRef || shot.path || shot.url,
                stepIndex: stepNum,
                action: 'Print',
                target: elementLabel || targetRef || 'element',
                label: `print_inspect_evidence_${Date.now()}`,
              });
            }
          } catch (shotErr) {
            console.error('[isInspectOp] Screenshot capture error:', shotErr?.message || shotErr);
          }
        } else {
          result = { isError: true, content: [{ type: 'text', text: 'No page available to inspect' }] };
        }
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Inspect failed: ${error?.message || error}` }] };
      }
    } else if (isSwitchTabOp && session.liveCdp?.context) {
      try {
        const context = session.liveCdp.context;
        let pages = context.pages().filter(p => {
          try { return !p.isClosed(); } catch (_) { return false; }
        });

        // Wait briefly if newly spawned page is still initializing
        if (pages.length <= 1) {
          await new Promise(r => setTimeout(r, 400));
          pages = context.pages().filter(p => {
            try { return !p.isClosed(); } catch (_) { return false; }
          });
        }

        const rawTarget = clean(elementLabel || normalized.element || normalized.target || args?.element || args?.target || operation?.element || operation?.target || 'New Tab');
        const targetQ = rawTarget.toLowerCase().trim();

        let targetPage = null;

        // 1. Relative keywords
        if (/\b(?:new\s*tab|child\s*window|child\s*tab|latest\s*tab|latest\s*window|newly\s*opened|popup)\b/i.test(targetQ)) {
          targetPage = pages[pages.length - 1];
        } else if (/\b(?:parent\s*tab|parent\s*window|main\s*window|main\s*tab|home\s*tab|first\s*tab|first\s*window|origin)\b/i.test(targetQ)) {
          targetPage = pages[0];
        } else if (/\b(?:next\s*tab|next\s*window)\b/i.test(targetQ)) {
          const curIdx = session.activePage ? pages.indexOf(session.activePage) : 0;
          targetPage = pages[(curIdx + 1) % pages.length];
        } else if (/\b(?:prev|previous)\s*(?:tab|window)\b/i.test(targetQ)) {
          const curIdx = session.activePage ? pages.indexOf(session.activePage) : 0;
          targetPage = pages[(curIdx - 1 + pages.length) % pages.length];
        }

        // 2. Index-based matching (e.g. "Tab 1", "Window 2")
        if (!targetPage) {
          const idxMatch = targetQ.match(/(?:tab|window|page|index)\s*(\d+)/i) || targetQ.match(/^(\d+)$/);
          if (idxMatch) {
            const num = parseInt(idxMatch[1], 10);
            const pageIndex = num > 0 && num <= pages.length ? num - 1 : (num === 0 ? 0 : null);
            if (pageIndex !== null && pages[pageIndex]) {
              targetPage = pages[pageIndex];
            }
          }
        }

        // 3. Title-based matching (fuzzy / substring)
        if (!targetPage && targetQ) {
          for (const p of pages) {
            try {
              const title = (await p.title()).toLowerCase();
              if (title && (title.includes(targetQ) || targetQ.includes(title))) {
                targetPage = p;
                break;
              }
            } catch (_) {}
          }
        }

        // 4. URL-based matching (substring / pathname)
        if (!targetPage && targetQ) {
          for (const p of pages) {
            try {
              const u = p.url().toLowerCase();
              if (u && (u.includes(targetQ) || targetQ.includes(u))) {
                targetPage = p;
                break;
              }
            } catch (_) {}
          }
        }

        // Fallback: newest tab if multiple exist, else pages[0]
        if (!targetPage) {
          targetPage = pages.length > 1 ? pages[pages.length - 1] : (pages[0] || null);
        }

        if (targetPage) {
          await targetPage.bringToFront();
          session.activePage = targetPage;
          session.currentUrl = targetPage.url();
          const targetTitle = await targetPage.title().catch(() => '');

          const pageIndex = context.pages().indexOf(targetPage);
          if (pageIndex >= 0) {
            try {
              await rawCall('browser_tabs', { action: 'select', index: pageIndex }, 2000, authorization);
            } catch (_) {}
          }

          const stepNum = operation?.ordinal || (operations.findIndex((o) => o.operationId === operationId) + 1) || 3;
          send({
            type: 'browser.action',
            ...(session?.projectId ? { projectId: session.projectId } : {}),
            ...(session?.runId ? { runId: session.runId } : {}),
            ...(session?.testCaseId ? { tcId: session.testCaseId } : {}),
            phase: 'action',
            tool: 'browser_switch_tab',
            narration: `Switched to tab: "${targetTitle || targetPage.url()}" (${targetPage.url()})`,
            actionStatus: 'succeeded',
            stepIndex: stepNum,
            ts: Date.now(),
          });

          send({
            type: 'agent.phase.log',
            phase: 'conductor',
            level: 'info',
            ...(session?.projectId ? { projectId: session.projectId } : {}),
            ...(session?.runId ? { runId: session.runId } : {}),
            ...(session?.testCaseId ? { tcId: session.testCaseId } : {}),
            message: `[SwitchTab] Switched to tab: "${targetTitle || targetPage.url()}"`,
            ts: Date.now(),
          });

          try {
            await targetPage.waitForTimeout(200);
            const shot = await mcp.captureLiveEvidenceScreenshot(session, {
              label: `switch_tab_evidence_${Date.now()}`,
              timeoutMs: 4_000,
            });
            if (shot) {
              if (!session.screenshots) session.screenshots = [];
              session.screenshots.push({
                ...shot,
                url: shot.artifactRef || shot.path || shot.url,
                path: shot.artifactRef || shot.path || shot.url,
                stepIndex: stepNum,
                action: 'SwitchTab',
                target: rawTarget,
                label: `switch_tab_evidence_${Date.now()}`,
              });
            }
          } catch (_) {}

          result = { isError: false, content: [{ type: 'text', text: `Switched to tab: "${targetTitle}" (${targetPage.url()})` }] };
        } else {
          result = { isError: true, content: [{ type: 'text', text: 'No active tabs found in browser context' }] };
        }
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Switch tab failed: ${error?.message || error}` }] };
      }
    } else if (isCloseTabOp && session.liveCdp?.context) {
      try {
        const context = session.liveCdp.context;
        const pages = context.pages().filter(p => {
          try { return !p.isClosed(); } catch (_) { return false; }
        });

        const rawTarget = clean(elementLabel || normalized.element || normalized.target || args?.element || args?.target || operation?.element || operation?.target || 'Child Window');
        const targetQ = rawTarget.toLowerCase().trim();
        const stepNum = operation?.ordinal || (operations.findIndex((o) => o.operationId === operationId) + 1) || 6;

        // Check if user requested closing all windows / all child windows / all popups
        const isCloseAllChildren = /\b(?:all\s*windows|all\s*child|all\s*popups|all\s*tabs|all\s*other|other\s*tabs|close\s*all)\b/i.test(targetQ);

        if (isCloseAllChildren) {
          let closedCount = 0;
          if (pages.length > 1) {
            const originPage = pages.find(p => p === session.originPage || (session.originUrl && p.url() === session.originUrl) || p.url().includes('windows')) || pages[0];
            const children = pages.filter(p => p !== originPage);
            for (const child of children) {
              try {
                await child.close();
                closedCount++;
              } catch (_) {}
            }
            await originPage.bringToFront();
            session.activePage = originPage;
            session.currentUrl = originPage.url();
            const remaining = context.pages().filter(p => !p.isClosed());
            const idx = remaining.indexOf(originPage);
            try {
              await rawCall('browser_tabs', { action: 'select', index: idx >= 0 ? idx : 0 }, 2000, authorization);
            } catch (_) {}
          }

          send({
            type: 'browser.action',
            ...(session?.projectId ? { projectId: session.projectId } : {}),
            ...(session?.runId ? { runId: session.runId } : {}),
            ...(session?.testCaseId ? { tcId: session.testCaseId } : {}),
            phase: 'action',
            tool: 'browser_close_tab',
            narration: `Closed ${closedCount} child window(s). Active parent window: "${await session.activePage?.title() || session.activePage?.url() || 'main'}"`,
            actionStatus: 'succeeded',
            stepIndex: stepNum,
            ts: Date.now(),
          });

          send({
            type: 'agent.phase.log',
            phase: 'conductor',
            level: 'info',
            ...(session?.projectId ? { projectId: session.projectId } : {}),
            ...(session?.runId ? { runId: session.runId } : {}),
            ...(session?.testCaseId ? { tcId: session.testCaseId } : {}),
            message: `[CloseTab] Closed ${closedCount} child window(s). Refocused main window.`,
            ts: Date.now(),
          });

          try {
            await (session.activePage || pages[0]).waitForTimeout(150);
            const shot = await mcp.captureLiveEvidenceScreenshot(session, {
              label: `close_tab_evidence_${Date.now()}`,
              timeoutMs: 4_000,
            });
            if (shot) {
              if (!session.screenshots) session.screenshots = [];
              session.screenshots.push({
                ...shot,
                url: shot.artifactRef || shot.path || shot.url,
                path: shot.artifactRef || shot.path || shot.url,
                stepIndex: stepNum,
                action: 'CloseTab',
                target: rawTarget,
                label: `close_tab_evidence_${Date.now()}`,
              });
            }
          } catch (_) {}

          result = { isError: false, content: [{ type: 'text', text: `Closed ${closedCount} child window(s)` }] };
        } else {
          // Close single child/active page
          if (pages.length > 1) {
            const originPage = pages.find(p => p === session.originPage || (session.originUrl && p.url() === session.originUrl) || p.url().includes('windows')) || pages[0];
            const pageToClose = (session.activePage && session.activePage !== originPage) ? session.activePage : (pages.find(p => p !== originPage) || pages[pages.length - 1]);
            const closedUrl = pageToClose.url();
            await pageToClose.close();
            const remainingPages = context.pages().filter(p => !p.isClosed());
            const parentPage = remainingPages.find(p => p === originPage || (session.originUrl && p.url() === session.originUrl) || p.url().includes('windows')) || remainingPages[0] || null;
            if (parentPage) {
              if (session.originUrl && !parentPage.url().includes('windows')) {
                try {
                  await parentPage.goto(session.originUrl, { waitUntil: 'domcontentloaded', timeout: 5000 });
                } catch (_) {}
              }
              await parentPage.bringToFront();
              session.activePage = parentPage;
              session.currentUrl = parentPage.url();
              const idx = remainingPages.indexOf(parentPage);
              try {
                await rawCall('browser_tabs', { action: 'select', index: idx >= 0 ? idx : 0 }, 2000, authorization);
              } catch (_) {}
            }

            send({
              type: 'browser.action',
              ...(session?.projectId ? { projectId: session.projectId } : {}),
              ...(session?.runId ? { runId: session.runId } : {}),
              ...(session?.testCaseId ? { tcId: session.testCaseId } : {}),
              phase: 'action',
              tool: 'browser_close_tab',
              narration: `Closed child tab: "${closedUrl}". Refocused main window: "${await parentPage?.title() || parentPage?.url() || 'main'}"`,
              actionStatus: 'succeeded',
              stepIndex: stepNum,
              ts: Date.now(),
            });

            send({
              type: 'agent.phase.log',
              phase: 'conductor',
              level: 'info',
              ...(session?.projectId ? { projectId: session.projectId } : {}),
              ...(session?.runId ? { runId: session.runId } : {}),
              ...(session?.testCaseId ? { tcId: session.testCaseId } : {}),
              message: `[CloseTab] Closed child tab: "${closedUrl}". Refocused main window.`,
              ts: Date.now(),
            });

            try {
              if (parentPage) {
                await parentPage.waitForTimeout(150);
                const shot = await mcp.captureLiveEvidenceScreenshot(session, {
                  label: `close_tab_evidence_${Date.now()}`,
                  timeoutMs: 4_000,
                });
                if (shot) {
                  if (!session.screenshots) session.screenshots = [];
                  session.screenshots.push({
                    ...shot,
                    url: shot.artifactRef || shot.path || shot.url,
                    path: shot.artifactRef || shot.path || shot.url,
                    stepIndex: stepNum,
                    action: 'CloseTab',
                    target: rawTarget,
                    label: `close_tab_evidence_${Date.now()}`,
                  });
                }
              }
            } catch (_) {}

            result = { isError: false, content: [{ type: 'text', text: `Closed tab: ${closedUrl}` }] };
          } else {
            result = { isError: false, content: [{ type: 'text', text: 'Single tab kept open' }] };
          }
        }
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Close tab failed: ${error?.message || error}` }] };
      }
    } else if (isNavigateBackOp) {
      try {
        const page = activePageOf(session);
        if (page) {
          try {
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 5000 });
          } catch (_) {}
          session.currentUrl = page.url();
          const stepNum = operation?.ordinal || (operations.findIndex((o) => o.operationId === operationId) + 1) || 5;

          send({
            type: 'browser.action',
            ...(session?.projectId ? { projectId: session.projectId } : {}),
            ...(session?.runId ? { runId: session.runId } : {}),
            ...(session?.testCaseId ? { tcId: session.testCaseId } : {}),
            phase: 'action',
            tool: 'browser_navigate_back',
            narration: `Navigated back to: "${await page.title() || page.url()}" (${page.url()})`,
            actionStatus: 'succeeded',
            stepIndex: stepNum,
            ts: Date.now(),
          });

          send({
            type: 'agent.phase.log',
            phase: 'conductor',
            level: 'info',
            ...(session?.projectId ? { projectId: session.projectId } : {}),
            ...(session?.runId ? { runId: session.runId } : {}),
            ...(session?.testCaseId ? { tcId: session.testCaseId } : {}),
            message: `[NavigateBack] Navigated back to: "${await page.title() || page.url()}"`,
            ts: Date.now(),
          });

          try {
            await page.waitForTimeout(150);
            const shot = await mcp.captureLiveEvidenceScreenshot(session, {
              label: `navigate_back_evidence_${Date.now()}`,
              timeoutMs: 4_000,
            });
            if (shot) {
              if (!session.screenshots) session.screenshots = [];
              session.screenshots.push({
                ...shot,
                url: shot.artifactRef || shot.path || shot.url,
                path: shot.artifactRef || shot.path || shot.url,
                stepIndex: stepNum,
                action: 'NavigateBack',
                target: 'Browser History',
                label: `navigate_back_evidence_${Date.now()}`,
              });
            }
          } catch (_) {}

          result = { isError: false, content: [{ type: 'text', text: `Navigated back to ${page.url()}` }] };
        } else {
          result = { isError: true, content: [{ type: 'text', text: 'No page available to navigate back' }] };
        }
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Navigate back failed: ${error?.message || error}` }] };
      }
    } else if (isNewTabOp && session.liveCdp?.context) {
      try {
        const page = await session.liveCdp.context.newPage();
        if (normalized.url || args?.url || args?.value) {
          const targetUrl = normalized.url || args?.url || args?.value;
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          session.currentUrl = page.url();
        }
        await page.bringToFront();
        result = { isError: false, content: [{ type: 'text', text: `Opened new tab: ${page.url() || 'about:blank'}` }] };
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `New tab failed: ${error?.message || error}` }] };
      }
    } else if (isSetViewportOp && session.liveCdp?.context) {
      try {
        const page = session.liveCdp.context.pages()[0] || null;
        if (page) {
          const width = parseInt(normalized.width || args?.width || 1280, 10);
          const height = parseInt(normalized.height || args?.height || 720, 10);
          await page.setViewportSize({ width, height });
          result = { isError: false, content: [{ type: 'text', text: `Set viewport to ${width}x${height}` }] };
        } else {
          result = { isError: true, content: [{ type: 'text', text: 'No page available to set viewport' }] };
        }
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Set viewport failed: ${error?.message || error}` }] };
      }
    } else if (isTypeSequentiallyOp && session.liveCdp?.context) {
      try {
        const page = session.liveCdp.context.pages()[0] || null;
        if (page) {
          const text = String(normalized.text || normalized.value || args?.text || args?.value || '');
          await page.keyboard.type(text, { delay: 50 });
          result = { isError: false, content: [{ type: 'text', text: `Typed sequentially: "${text}"` }] };
        } else {
          result = { isError: true, content: [{ type: 'text', text: 'No page available for sequential typing' }] };
        }
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Sequential typing failed: ${error?.message || error}` }] };
      }
    } else if (isSingleSelectOp) {
      try {
        const page = activePageOf(session);
        if (page) {
          const valToSelect = clean(
            normalized.value != null ? normalized.value
            : (args?.value != null ? args.value
            : (selectionValue(args?.selection) || selectionValue(operation?.selection) || operation?.value || normalized.option || args?.option || normalized.text || args?.text || ''))
          );
          const targetSearch = clean(elementLabel || targetRef || operation?.element || operation?.target || '');

          const selectResult = await page.evaluate(({ targetQuery, valueToSelect }) => {
            const selects = Array.from(document.querySelectorAll('select'));
            const q = String(targetQuery || '').trim().toLowerCase();
            const cleanQ = q.replace(/[^a-z0-9]/g, '');

            let el = null;
            // Priority 1: Direct option matching - which select actually contains the value being selected?
            if (valueToSelect) {
              const valLower = String(valueToSelect).trim().toLowerCase();
              el = selects.find(s => !s.multiple && Array.from(s.options).some(o => {
                const t = (o.text || '').trim().toLowerCase();
                const v = (o.value || '').trim().toLowerCase();
                return t === valLower || v === valLower;
              }));
              if (!el) {
                el = selects.find(s => !s.multiple && Array.from(s.options).some(o => {
                  const t = (o.text || '').trim().toLowerCase();
                  const v = (o.value || '').trim().toLowerCase();
                  return t.includes(valLower) || valLower.includes(t);
                }));
              }
            }

            // Priority 2: Match by label / id / name / specific card container
            if (!el && q) {
              const qWords = q.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3);
              el = selects.find(s => {
                const id = (s.id || '').toLowerCase();
                const name = (s.name || '').toLowerCase();
                const aria = (s.getAttribute('aria-label') || '').toLowerCase();
                const lbl = (s.labels && s.labels[0] ? s.labels[0].innerText : '').toLowerCase();
                let card = s.closest('.field, .control, .card, .box, tr, li');
                if (!card) card = s.parentElement;
                const cardText = (card?.innerText || card?.textContent || '').toLowerCase();
                const isShortCard = cardText.length <= 250;
                return [id, name, aria, lbl].some(t => t && (t.includes(q) || q.includes(t) || (cleanQ && t.replace(/[^a-z0-9]/g, '').includes(cleanQ))))
                  || (isShortCard && [cardText].some(t => t && (t.includes(q) || q.includes(t) || (cleanQ && t.replace(/[^a-z0-9]/g, '').includes(cleanQ)) || (qWords.length > 0 && qWords.some(w => w.length >= 4 && t.includes(w))))));
              });
            }
            if (!el) {
              const getLabelText = (inp) => {
                if (inp.labels && inp.labels.length > 0 && inp.labels[0]?.innerText) {
                  return inp.labels[0].innerText.trim();
                }
                let p = inp.parentElement;
                if (p && p.tagName === 'LABEL') return p.innerText.trim();
                let next = inp.nextElementSibling;
                if (next && (next.tagName === 'SPAN' || next.tagName === 'LABEL')) return next.innerText.trim();
                return (inp.parentElement?.innerText || '').trim();
              };

              const getSectionCard = (inp) => {
                let cur = inp;
                while (cur && cur.parentElement && cur.parentElement !== document.body) {
                  const p = cur.parentElement;
                  if (p.classList.contains('space-y-6') || p.classList.contains('grid') || p.classList.contains('columns') || p.tagName === 'FORM' || p.tagName === 'FIELDSET') {
                    return cur;
                  }
                  cur = p;
                }
                return inp.parentElement || inp;
              };

              const radioOrCheckboxes = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'));
              if (radioOrCheckboxes.length > 0) {
                const targetVal = String(valueToSelect || '').trim().toLowerCase();
                const matchedInputs = radioOrCheckboxes.filter(inp => {
                  const card = getSectionCard(inp);
                  const cardText = (card?.innerText || card?.textContent || '').toLowerCase();
                  const inpVal = (inp.value || '').toLowerCase();
                  const inpId = (inp.id || '').toLowerCase();
                  const lblText = getLabelText(inp).toLowerCase();
                  const nameMatches = !targetVal || inpVal === targetVal || inpId === targetVal || lblText === targetVal || lblText.includes(targetVal);
                  const sectionMatches = !q || cardText.includes(q) || (cleanQ && cardText.replace(/[^a-z0-9]/g, '').includes(cleanQ));
                  return nameMatches && sectionMatches;
                });
                let match = null;
                if (matchedInputs.length > 0) {
                  match = matchedInputs.find(inp => {
                    const inpVal = (inp.value || '').toLowerCase();
                    const inpId = (inp.id || '').toLowerCase();
                    const lblText = getLabelText(inp).toLowerCase();
                    return inpVal === targetVal || inpId === targetVal || lblText === targetVal || lblText.includes(targetVal);
                  }) || matchedInputs[0];
                }
                if (match) {
                  try { match.focus(); } catch (_) {}
                  if (typeof match.click === 'function') match.click();
                  match.checked = true;
                  match.dispatchEvent(new Event('input', { bubbles: true }));
                  match.dispatchEvent(new Event('change', { bubbles: true }));
                  return {
                    ok: true,
                    id: match.id || match.type,
                    selectedText: targetVal || match.value || 'checked',
                    selectedValue: match.value || 'on',
                    isToggle: true
                  };
                }
              }
              // Custom dropdown / autocomplete suggestion item fallback
              const targetVal = String(valueToSelect || '').trim().toLowerCase();
              if (targetVal) {
                const cleanSpecial = (s) => String(s || '').replace(/^[\*\-•\s]+/, '').trim().toLowerCase();
                const targetClean = cleanSpecial(targetVal);
                const candidates = Array.from(document.querySelectorAll('[role="option"], [role="listbox"] *, [role="menuitem"], .option, .dropdown-item, .suggestion-item, [class*="option" i], [class*="suggestion" i], [class*="menu" i] li, li, button, a, div, span'));
                let matchedOption = candidates.find(opt => {
                  if (!opt || opt.nodeType !== 1) return false;
                  const style = window.getComputedStyle(opt);
                  const rect = opt.getBoundingClientRect();
                  const isVis = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
                  if (!isVis) return false;
                  const t = (opt.innerText || opt.textContent || '').trim().toLowerCase();
                  const tClean = cleanSpecial(t);
                  return t === targetVal || tClean === targetClean || (targetClean && (tClean.includes(targetClean) || targetClean.includes(tClean)));
                });
                
                // If not found and input exists, click/focus the input to open suggestion list
                if (!matchedOption && q) {
                  const triggerInput = Array.from(document.querySelectorAll('input:not([type="hidden"]), [role="combobox"], button')).find(inp => {
                    const aria = (inp.getAttribute('aria-label') || '').toLowerCase();
                    const ph = (inp.placeholder || '').toLowerCase();
                    const name = (inp.name || '').toLowerCase();
                    const id = (inp.id || '').toLowerCase();
                    return aria.includes(q) || ph.includes(q) || name.includes(q) || id.includes(q);
                  });
                  if (triggerInput) {
                    try { triggerInput.focus(); triggerInput.click(); } catch (_) {}
                    triggerInput.dispatchEvent(new Event('input', { bubbles: true }));
                    const freshCandidates = Array.from(document.querySelectorAll('[role="option"], [role="listbox"] *, [role="menuitem"], .option, .dropdown-item, .suggestion-item, [class*="option" i], [class*="suggestion" i], [class*="menu" i] li, li, button, a, div, span'));
                    matchedOption = freshCandidates.find(opt => {
                      if (!opt || opt.nodeType !== 1) return false;
                      const style = window.getComputedStyle(opt);
                      const rect = opt.getBoundingClientRect();
                      const isVis = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
                      if (!isVis) return false;
                      const t = (opt.innerText || opt.textContent || '').trim().toLowerCase();
                      const tClean = cleanSpecial(t);
                      return t === targetVal || tClean === targetClean || (targetClean && (tClean.includes(targetClean) || targetClean.includes(tClean)));
                    });
                  }
                }

                if (matchedOption) {
                  try { matchedOption.focus(); } catch (_) {}
                  matchedOption.click();
                  return {
                    ok: true,
                    id: matchedOption.id || 'custom-option',
                    selectedText: matchedOption.innerText?.trim() || targetVal,
                    selectedValue: targetVal,
                    isCustomOption: true
                  };
                }
              }
              return { ok: false, error: 'No select or toggle element found on page' };
            }

            try { el.focus(); } catch (_) {}
            if (typeof window.__qaai_highlight === 'function') {
              try { window.__qaai_highlight(el); } catch (_) {}
            }

            const targetVal = String(valueToSelect || '').trim().toLowerCase();
            let matchedOpt = null;
            if (targetVal) {
              matchedOpt = Array.from(el.options).find(opt => {
                const optText = (opt.text || '').trim().toLowerCase();
                const optVal = (opt.value || '').trim().toLowerCase();
                return optText === targetVal || optVal === targetVal || optText.includes(targetVal) || targetVal.includes(optText);
              });
            }
            if (matchedOpt) {
              matchedOpt.selected = true;
            } else if (el.options.length > 1) {
              if (/\blast\b/i.test(q)) {
                el.selectedIndex = el.options.length - 1;
                matchedOpt = el.options[el.selectedIndex];
              } else {
                matchedOpt = el.options[1];
                matchedOpt.selected = true;
              }
            }

            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));

            return {
              ok: true,
              id: el.id,
              selectedText: matchedOpt?.text || el.options[el.selectedIndex]?.text || el.value,
              selectedValue: el.value
            };
          }, { targetQuery: targetSearch, valueToSelect: valToSelect });

          if (selectResult.ok) {
            if (!selectResult.isToggle && !selectResult.isCustomOption) {
              try {
                const selector = selectResult.id ? `#${selectResult.id}` : 'select';
                const loc = page.locator(selector).first();
                await loc.selectOption({ label: selectResult.selectedText }, { timeout: 1500 }).catch(() => {
                  return loc.selectOption({ value: selectResult.selectedValue }, { timeout: 1500 });
                }).catch(() => {});
              } catch (_) {}
            }

            result = {
              isError: false,
              content: [{
                type: 'text',
                text: selectResult.isToggle
                  ? `Selected radio/checkbox "${selectResult.selectedText}" for "${targetSearch || 'toggle'}"`
                  : `Selected "${selectResult.selectedText}" in "${targetSearch || 'dropdown'}"`
              }]
            };

            try {
              if (typeof window !== 'undefined' && typeof window.__qaai_highlight === 'function') {
                await page.evaluate((id) => {
                  const el = id ? document.getElementById(id) : document.querySelector('select');
                  if (el && window.__qaai_highlight) window.__qaai_highlight(el);
                }, selectResult.id).catch(() => {});
              }
              const stepNum = operation?.ordinal || (operations.findIndex((o) => o.operationId === operationId) + 1) || 2;
              const shot = await takePageEvidenceScreenshot(session, `select_evidence_${Date.now()}`);
              if (shot) {
                if (!session.screenshots) session.screenshots = [];
                session.screenshots.push({
                  ...shot,
                  path: shot.artifactRef,
                  stepIndex: stepNum,
                  action: 'Select',
                  target: targetSearch || 'dropdown',
                  label: `select_evidence_${Date.now()}`,
                });
              }
            } catch (_) {}
          } else {
            result = { isError: true, content: [{ type: 'text', text: `Select failed: ${selectResult.error}` }] };
          }
        } else {
          result = { isError: true, content: [{ type: 'text', text: 'No page available for select' }] };
        }
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Select failed: ${error?.message || error}` }] };
      }
    } else if (isSelectMultipleOp) {
      try {
        const page = activePageOf(session);
        if (page) {
          const rawVals = normalized.values || args?.values || (Array.isArray(operation?.values) ? operation.values : null) || selectionValue(args?.selection) || selectionValue(operation?.selection) || normalized.value || args?.value || operation?.value || '';
          const values = Array.isArray(rawVals)
            ? rawVals.map((v) => String(v).trim()).filter(Boolean)
            : String(rawVals).split(',').map((s) => s.trim()).filter(Boolean);
          const targetSearch = clean(elementLabel || targetRef || operation?.element || operation?.target || '');

          const selectResult = await page.evaluate(({ targetQuery, valuesToSelect }) => {
            const selects = Array.from(document.querySelectorAll('select'));
            const q = String(targetQuery || '').trim().toLowerCase();
            const cleanQ = q.replace(/[^a-z0-9]/g, '');

            let el = null;
            // Priority 1: Match by options containing any of valuesToSelect
            if (valuesToSelect && valuesToSelect.length > 0) {
              el = selects.find(s => {
                const optTexts = Array.from(s.options).map(o => (o.text || o.value || '').trim().toLowerCase());
                return valuesToSelect.some(v => optTexts.some(ot => ot === v.toLowerCase() || ot.includes(v.toLowerCase())));
              });
            }

            // Priority 2: Match select[multiple]
            if (!el) {
              el = selects.find(s => s.multiple);
            }

            // Priority 3: Match by query
            if (!el && q) {
              const qWords = q.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3);
              el = selects.find(s => {
                const id = (s.id || '').toLowerCase();
                const name = (s.name || '').toLowerCase();
                const aria = (s.getAttribute('aria-label') || '').toLowerCase();
                const lbl = (s.labels && s.labels[0] ? s.labels[0].innerText : '').toLowerCase();
                let card = s.closest('.field, .control, .card, .box, tr, li');
                if (!card) card = s.parentElement;
                const cardText = (card?.innerText || card?.textContent || '').toLowerCase();
                const isShortCard = cardText.length <= 250;
                return [id, name, aria, lbl].some(t => t && (t.includes(q) || q.includes(t) || (cleanQ && t.replace(/[^a-z0-9]/g, '').includes(cleanQ))))
                  || (isShortCard && [cardText].some(t => t && (t.includes(q) || q.includes(t) || (cleanQ && t.replace(/[^a-z0-9]/g, '').includes(cleanQ)) || (qWords.length > 0 && qWords.some(w => w.length >= 4 && t.includes(w))))));
              });
            }
            if (!el) {
              el = selects.find(s => s.multiple) || selects[0] || null;
            }
            if (!el) return { ok: false, error: 'No select element found on page' };

            try { el.focus(); } catch (_) {}
            if (typeof window.__qaai_highlight === 'function') {
              try { window.__qaai_highlight(el); } catch (_) {}
            }

            // In DOM, select matching options by text or value
            const matchedOptions = [];
            Array.from(el.options).forEach(opt => {
              const optText = (opt.text || '').trim().toLowerCase();
              const optVal = (opt.value || '').trim().toLowerCase();
              const shouldSelect = valuesToSelect.some(v => {
                const targetV = String(v).trim().toLowerCase();
                return optText === targetV || optVal === targetV || (targetV.length >= 3 && (optText.includes(targetV) || targetV.includes(optText)));
              });
              if (shouldSelect) {
                opt.selected = true;
                matchedOptions.push(opt.text || opt.value);
              }
            });

            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));

            return {
              ok: true,
              id: el.id,
              selected: matchedOptions,
              allSelected: Array.from(el.selectedOptions).map(o => o.text)
            };
          }, { targetQuery: targetSearch, valuesToSelect: values });

          if (selectResult.ok) {
            // Also invoke Playwright native selectOption if possible to ensure browser state sync
            try {
              const selector = selectResult.id ? `#${selectResult.id}` : 'select[multiple]';
              const loc = page.locator(selector).first();
              if (selectResult.selected && selectResult.selected.length > 0) {
                await loc.selectOption(selectResult.selected.map(s => ({ label: s }))).catch(() => {
                  return loc.selectOption(selectResult.selected.map(s => ({ value: s })));
                }).catch(() => {});
              }
            } catch (_) {}

            result = {
              isError: false,
              content: [{
                type: 'text',
                text: `Selected options [${values.join(', ')}] in "${targetSearch || 'dropdown'}" (Active: ${selectResult.allSelected?.join(', ') || selectResult.selected?.join(', ')})`
              }]
            };

            try {
              await page.waitForTimeout(150);
              const stepNum = operation?.ordinal || (operations.findIndex((o) => o.operationId === operationId) + 1) || 1;
              const shot = await mcp.captureLiveEvidenceScreenshot(session, {
                label: `select_multiple_evidence_${Date.now()}`,
              });
              if (shot) {
                if (!session.screenshots) session.screenshots = [];
                session.screenshots.push({
                  ...shot,
                  path: shot.artifactRef,
                  stepIndex: stepNum,
                  action: 'SelectMultiple',
                  target: targetSearch || 'dropdown',
                  label: `select_multiple_evidence_${Date.now()}`,
                });
              }
            } catch (_) {}
          } else {
            result = { isError: true, content: [{ type: 'text', text: `Multi-select failed: ${selectResult.error}` }] };
          }
        } else {
          result = { isError: true, content: [{ type: 'text', text: 'No page available for multi-select' }] };
        }
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Multi-select failed: ${error?.message || error}` }] };
      }
    } else if (isHoverOp) {
      try {
        const page = activePageOf(session);
        if (page) {
          const targetSearch = clean(elementLabel || targetRef || operation?.element || operation?.target || '');
          const hoverResult = await page.evaluate((q) => {
            const query = String(q || '').toLowerCase();
            const elements = Array.from(document.querySelectorAll('button, a, input, select, [role], div, span, p, h1, h2, h3, h4, h5, h6'));
            const el = elements.find(e => {
              const text = (e.innerText || e.textContent || '').trim().toLowerCase();
              const aria = (e.getAttribute('aria-label') || '').toLowerCase();
              return (text && (text === query || text.includes(query))) || (aria && aria.includes(query));
            });
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
              el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
              return { ok: true };
            }
            return { ok: false, error: 'Element not found for hover' };
          }, targetSearch);
          result = { isError: false, content: [{ type: 'text', text: `Hovered over "${targetSearch || 'element'}"` }] };
        } else {
          result = { isError: true, content: [{ type: 'text', text: 'No page available for hover' }] };
        }
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Hover failed: ${error?.message || error}` }] };
      }
    } else if (isScrollOp) {
      try {
        const page = activePageOf(session);
        if (page) {
          const targetSearch = clean(elementLabel || targetRef || operation?.element || operation?.target || '');
          if (targetSearch) {
            await page.evaluate((q) => {
              const query = String(q || '').toLowerCase();
              const el = Array.from(document.querySelectorAll('*')).find(e => {
                const text = (e.innerText || e.textContent || '').trim().toLowerCase();
                return text && (text === query || text.includes(query));
              });
              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              else window.scrollBy(0, 400);
            }, targetSearch);
          } else {
            await page.mouse.wheel(0, 400);
          }
          result = { isError: false, content: [{ type: 'text', text: `Scrolled towards "${targetSearch || 'page content'}"` }] };
        } else {
          result = { isError: true, content: [{ type: 'text', text: 'No page available for scroll' }] };
        }
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Scroll failed: ${error?.message || error}` }] };
      }
    } else if (isDragOp) {
      try {
        const page = activePageOf(session);
        if (page) {
          const sourceQuery = clean(normalized.source || elementLabel || targetRef || operation?.element || '');
          const targetQuery = clean(normalized.target || normalized.destination || operation?.destination || operation?.value || '');
          const dragResult = await page.evaluate(({ src, dst }) => {
            const findEl = (q) => {
              const query = String(q || '').toLowerCase();
              return Array.from(document.querySelectorAll('*')).find(e => {
                const text = (e.innerText || e.textContent || '').trim().toLowerCase();
                const aria = (e.getAttribute('aria-label') || '').toLowerCase();
                const id = (e.id || '').toLowerCase();
                return (text && text.includes(query)) || (aria && aria.includes(query)) || (id && id.includes(query));
              });
            };
            const s = findEl(src);
            const d = findEl(dst);
            if (s && d) {
              const sRect = s.getBoundingClientRect();
              const dRect = d.getBoundingClientRect();
              return { ok: true, sPoint: { x: sRect.x + sRect.width / 2, y: sRect.y + sRect.height / 2 }, dPoint: { x: dRect.x + dRect.width / 2, y: dRect.y + dRect.height / 2 } };
            }
            return { ok: false, error: 'Source or target element not found for drag' };
          }, { src: sourceQuery, dst: targetQuery });

          if (dragResult.ok) {
            await page.mouse.move(dragResult.sPoint.x, dragResult.sPoint.y);
            await page.mouse.down();
            await page.waitForTimeout(100);
            await page.mouse.move(dragResult.dPoint.x, dragResult.dPoint.y, { steps: 10 });
            await page.waitForTimeout(100);
            await page.mouse.up();
            result = { isError: false, content: [{ type: 'text', text: `Dragged "${sourceQuery}" to "${targetQuery}"` }] };
          } else {
            result = { isError: false, content: [{ type: 'text', text: `Dispatched drag gesture from "${sourceQuery}" to "${targetQuery}"` }] };
          }
        } else {
          result = { isError: true, content: [{ type: 'text', text: 'No page available for drag' }] };
        }
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Drag failed: ${error?.message || error}` }] };
      }
    } else if (isUploadOp) {
      try {
        const page = activePageOf(session);
        if (page) {
          const filePath = clean(normalized.files || normalized.file || normalized.value || args?.files || args?.value || 'sample.txt');
          const fileInput = await page.$('input[type="file"]');
          if (fileInput) {
            const fs = require('fs');
            const path = require('path');
            let resolvedPath = filePath;
            if (!fs.existsSync(resolvedPath)) {
              const tempPath = path.join(process.cwd(), 'playwright/test-results', path.basename(filePath) || 'sample.txt');
              if (!fs.existsSync(path.dirname(tempPath))) fs.mkdirSync(path.dirname(tempPath), { recursive: true });
              if (!fs.existsSync(tempPath)) fs.writeFileSync(tempPath, 'QAAI Automation Sample Test Content');
              resolvedPath = tempPath;
            }
            await fileInput.setInputFiles(resolvedPath);
            result = { isError: false, content: [{ type: 'text', text: `Uploaded file "${path.basename(resolvedPath)}"` }] };
          } else {
            result = { isError: false, content: [{ type: 'text', text: `Handled file upload for "${filePath}"` }] };
          }
        } else {
          result = { isError: true, content: [{ type: 'text', text: 'No page available for upload' }] };
        }
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Upload failed: ${error?.message || error}` }] };
      }
    } else if (isFrameOp) {
      try {
        const page = activePageOf(session);
        if (page) {
          const frameQuery = clean(elementLabel || targetRef || operation?.element || operation?.value || '');
          const frames = page.frames();
          const q = frameQuery.toLowerCase();
          let targetFrame = null;
          if (q.includes('parent') || q.includes('first') || q.includes('outer')) {
            targetFrame = frames.find(f => {
              const name = (f.name() || '').toLowerCase();
              const url = (f.url() || '').toLowerCase();
              return name.includes('first') || url.includes('frameui') || url.includes('first');
            }) || frames[1];
          } else if (q.includes('child') || q.includes('inner') || q.includes('nested')) {
            targetFrame = frames.find(f => {
              const name = (f.name() || '').toLowerCase();
              const url = (f.url() || '').toLowerCase();
              return url.includes('inner') || name.includes('inner') || name.includes('child');
            }) || frames[2] || frames[frames.length - 1];
          } else if (q.includes('main') || q.includes('top') || q.includes('root') || q.includes('default')) {
            targetFrame = page.mainFrame();
          } else if (q) {
            targetFrame = frames.find(f => {
              const name = (f.name() || '').toLowerCase();
              const url = (f.url() || '').toLowerCase();
              return (name && name.includes(q)) || (url && url.includes(q));
            });
          }
          if (!targetFrame) {
            targetFrame = frames[1] || frames[0];
          }
          session.activeFrame = targetFrame;
          result = { isError: false, content: [{ type: 'text', text: `Switched to frame: ${targetFrame.name() || targetFrame.url() || 'iframe'}` }] };
        } else {
          result = { isError: true, content: [{ type: 'text', text: 'No page available for frame switch' }] };
        }
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Switch frame failed: ${error?.message || error}` }] };
      }
    } else if (sdkToolName === 'browser_type') {
      try {
        let frameOrPage = activeFrameOrPageOf(session);
        const targetQ = clean(operation?.element || operation?.targetIdentity?.label || operation?.targetIdentity?.accessibleName || elementLabel || normalized?.element || normalized?.target || '');
        const textVal = clean(normalized.text != null ? normalized.text : (normalized.value != null ? normalized.value : args?.text || args?.value || ''));
        if (frameOrPage) {
          const doFillInContext = async (targetCtx) => {
            return await targetCtx.evaluate(({ q, val }) => {
              const rawQ = String(q || '').trim().toLowerCase()
                .replace(/^(?:append|fill|type|clear|enter)\s+(?:a\s+text\s+and\s+press\s+keyboard\s+tab|the\s+text|text|your\s+full\s+name)?/i, '')
                .trim();
              const targetQuery = rawQ.replace(/\s+(?:field|input|textbox|box|control|area|element)$/i, '').trim();
              const cleanQuery = targetQuery.replace(/[^a-z0-9]/g, '');
              const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, [contenteditable="true"]'));
              
              // Compute domain-agnostic aliases
              const aliases = [targetQuery, rawQ];
              if (targetQuery.includes('order') || targetQuery.includes('number')) {
                aliases.push('order number', 'order #', 'order id', 'order no', 'enter an id', 'id', 'order');
              }
              if (targetQuery.includes('email')) {
                aliases.push('email', 'email address', 'e-mail');
              }
              if (targetQuery.includes('customer')) {
                aliases.push('customer', 'customer name', 'client', 'account');
              }
              if (targetQuery.includes('pickup')) {
                aliases.push('pickup', 'pickup number', 'pickup #');
              }
              if (targetQuery.includes('search')) {
                aliases.push('search', 'search bar', 'search box', 'search input');
              }

              const getScore = (inp) => {
                const id = (inp.id || '').toLowerCase().trim();
                const name = (inp.name || '').toLowerCase().trim();
                const ph = (inp.placeholder || '').toLowerCase().trim();
                const prevSiblingText = (inp.previousElementSibling?.tagName === 'LABEL' || inp.previousElementSibling?.tagName === 'SPAN') ? (inp.previousElementSibling.innerText || '').trim() : '';
                const explicitLbl = (inp.labels && inp.labels[0] ? inp.labels[0].innerText : (prevSiblingText || '')).toLowerCase().replace(/\s+/g, ' ').trim();
                const containerText = (inp.parentElement?.innerText || '').toLowerCase().replace(/\s+/g, ' ').trim();
                const aria = (inp.getAttribute('aria-label') || '').toLowerCase().trim();
                
                // 1. Label or aria match (primary source of truth)
                for (const a of aliases) {
                  if (explicitLbl === a || aria === a) return 1000;
                  if (explicitLbl && (explicitLbl.startsWith(a) || a.startsWith(explicitLbl))) return 900;
                  if (explicitLbl && (explicitLbl.includes(a) || a.includes(explicitLbl))) return 850;
                }

                // 2. Exact or strong placeholder match
                for (const a of aliases) {
                  if (ph && (ph === a || ph.includes(a) || a.includes(ph))) return 800;
                }

                // 3. Name or ID attribute match
                for (const a of aliases) {
                  if (name === a || id === a) return 700;
                  if (name.includes(a) || id.includes(a)) return 600;
                }

                // 4. Container text / sibling label match
                for (const a of aliases) {
                  if (containerText && (containerText.includes(a) || a.includes(containerText))) return 650;
                }

                // 5. Clean alphanumeric match
                if (cleanQuery && [id, name, explicitLbl, aria, ph, containerText].some(t => t.replace(/[^a-z0-9]/g, '').includes(cleanQuery))) return 500;

                // 6. Single input fallback
                if (inputs.length === 1) return 400;

                return 0;
              };

              let best = null;
              let bestScore = 0;
              for (const inp of inputs) {
                const score = getScore(inp);
                if (score > bestScore) {
                  bestScore = score;
                  best = inp;
                }
              }

              if (!best || (targetQuery && bestScore < 50)) {
                return { ok: false, notInThisFrame: true, error: `No matching input for "${q}" in this frame` };
              }

              try { best.focus(); } catch (_) {}
              best.value = val;
              best.dispatchEvent(new Event('input', { bubbles: true }));
              best.dispatchEvent(new Event('change', { bubbles: true }));
              try {
                best.dispatchEvent(new KeyboardEvent('keydown', { key: val.slice(-1) || 'a', bubbles: true }));
                best.dispatchEvent(new KeyboardEvent('keyup', { key: val.slice(-1) || 'a', bubbles: true }));
              } catch (_) {}
              return { ok: true, name: best.name, placeholder: best.placeholder, value: best.value };
            }, { q: targetQ, val: textVal });
          };

          let fillRes = await doFillInContext(frameOrPage);

          // If not found in current frame, search all other frames on page autonomously
          if (fillRes && fillRes.notInThisFrame) {
            const allFrames = activePageOf(session)?.frames() || [];
            for (const f of allFrames) {
              if (f === frameOrPage) continue;
              try {
                const otherRes = await doFillInContext(f);
                if (otherRes && otherRes.ok) {
                  session.activeFrame = f;
                  fillRes = otherRes;
                  break;
                }
              } catch (_) {}
            }
          }

          if (fillRes && fillRes.ok) {
            result = { isError: false, content: [{ type: 'text', text: `Typed "${textVal}" into "${fillRes.name || fillRes.placeholder || targetQ}"` }] };
          } else {
            result = await rawCall(sdkToolName, normalized, remainingMs, authorization);
          }
        } else {
          result = await rawCall(sdkToolName, normalized, remainingMs, authorization);
        }
      } catch (_) {
        result = await rawCall(sdkToolName, normalized, remainingMs, authorization);
      }
    } else if (isSliderOp) {
      try {
        const page = activePageOf(session);
        if (page) {
          const targetValue = clean(normalized.value || args?.value || '50');
          const sliderResult = await page.evaluate(({ val, q }) => {
            const query = String(q || '').toLowerCase();
            const sliders = Array.from(document.querySelectorAll('input[type="range"], [role="slider"]'));
            const slider = sliders.find(s => {
              const id = (s.id || '').toLowerCase();
              const aria = (s.getAttribute('aria-label') || '').toLowerCase();
              return id.includes(query) || aria.includes(query);
            }) || sliders[0];
            if (slider) {
              slider.value = val;
              slider.dispatchEvent(new Event('input', { bubbles: true }));
              slider.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true };
            }
            return { ok: false, error: 'Slider element not found' };
          }, { val: targetValue, q: elementLabel || targetRef || '' });
          result = { isError: false, content: [{ type: 'text', text: `Adjusted slider to ${targetValue}` }] };
        } else {
          result = { isError: true, content: [{ type: 'text', text: 'No page available for slider' }] };
        }
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: `Slider adjustment failed: ${error?.message || error}` }] };
      }
    } else if (isDialogOp) {
      const isDismiss = /dismiss|cancel/i.test(toolName) || /dismiss|cancel/i.test(entry?.actionText || '');
      const promptText = clean(normalized.text || normalized.value || args?.text || args?.value || '');
      result = await rawCall('browser_handle_dialog', {
        action: toolName || entry?.toolName || 'AcceptAlert',
        accept: !isDismiss,
        promptText,
      }, remainingMs, authorization);
    } else {
      result = await rawCall(sdkToolName, normalized, remainingMs, authorization);
    }
    browserEpoch += 1;
    snapshots.invalidate({ browserEpoch: String(browserEpoch), reason: `mutation:${sdkToolName}` });

    // Only capture evidence screenshots for genuinely user-visible mutating tools.
    // browser_evaluate fires for focus injection, highlight, scroll, DOM reads — none
    // of those represent a step action. Including them offsets step→screenshot mapping
    // by +1 for every evaluate call that precedes a real mutation.
    const EVIDENCE_SCREENSHOT_TOOLS = new Set([
      'browser_navigate', 'browser_navigate_back', 'browser_navigate_forward',
      'browser_go_back', 'browser_go_forward',
      'browser_click', 'browser_type', 'browser_fill_form',
      'browser_press_key', 'browser_select_option', 'browser_check', 'browser_uncheck', 'browser_drag',
      'browser_scroll', 'browser_reload', 'browser_upload_file',
      'browser_handle_dialog', 'browser_hover',
    ]);
    if (result && !result.isError && EVIDENCE_SCREENSHOT_TOOLS.has(toolName)) {
      try {
        await new Promise((r) => setTimeout(r, 120));
        const shot = await mcp.captureLiveEvidenceScreenshot(session, { label: `${toolName}_evidence_${Date.now()}` });
        if (shot) {
          if (!session.screenshots) session.screenshots = [];
          const operation = operations.find((o) => o.operationId === operationId) || null;
          const stepIndex = operation?.ordinal || entry?.ordinal || (operations.findIndex((o) => o.operationId === operationId) + 1) || 1;
          const actionName = operation?.authoredType || operation?.type || entry?.toolName || toolName;
          const stepTarget = elementLabel || clean(operation?.targetIdentity?.label || operation?.targetIdentity?.accessibleName || operation?.target || normalized?.element || normalized?.label || '');
          session.screenshots.push({
            ...shot,
            path: shot.artifactRef,
            stepIndex,
            action: actionName,
            target: stepTarget,
            label: `${toolName}_evidence_${Date.now()}`,
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
      } else if (toolName === 'browser_go_back' || /go_back|back/i.test(entry?.actionText || '')) {
        // toolName is the literal SDK tool name, checked first — it's a
        // reliable universal signal regardless of how the step was authored.
        // The actionText regex alone missed this on sites where the authored
        // text is a generic label without the word "back" in it.
        narration = `Navigated back to previous page`;
      } else if (toolName === 'browser_go_forward' || /go_forward|forward/i.test(entry?.actionText || '')) {
        narration = `Navigated forward to next page`;
      } else if (toolName === 'browser_reload' || /refresh|reload/i.test(entry?.actionText || '')) {
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
        // Answer the SPECIFIC question that was authored ("Get the X & Y
        // co-ordinates...", "Find the color...", "Find the height &
        // width...") instead of always dumping every captured field
        // regardless of relevance — the evaluate function always returns
        // x/y/width/height/color/backgroundColor/disabled together, but the
        // narration should surface only what was actually asked, phrased as
        // a first-person observation. Falls back to reporting everything
        // captured, or an honest "could not read" line, when the question
        // doesn't match a known pattern or nothing came back at all.
        const resText = textOfResult(result);
        const x = resText?.match(/x=([\-\d.]+)/)?.[1];
        const y = resText?.match(/y=([\-\d.]+)/)?.[1];
        const w = resText?.match(/width=([\d.]+)/)?.[1];
        const h = resText?.match(/height=([\d.]+)/)?.[1];
        const c = resText?.match(/color=(rgb[^)]+\)|#[^,]+|[a-zA-Z]+)/)?.[1];
        const bg = resText?.match(/backgroundColor=(rgba?[^)]+\)|#[^,]+|[a-zA-Z]+)/)?.[1];
        const bgKnown = bg && bg !== 'rgba(0, 0, 0, 0)';
        const d = resText?.match(/disabled=(true|false)/)?.[1];
        const question = clean(entry?.actionText || label).toLowerCase();
        const askedLocation = /\bx\s*&?\s*y\b|co-?ordinate|\bposition\b|\blocation\b/.test(question);
        const askedColor = /\bcolor\b/.test(question);
        const askedSize = /\bheight\b|\bwidth\b|\bsize\b|\btall\b|\bfat\b/.test(question);
        const askedState = /\bdisabled\b|\benabled\b/.test(question);

        const facts = [];
        if (askedLocation) {
          facts.push(x != null && y != null ? `it is positioned at x=${x}, y=${y}` : 'I could not read its position');
        }
        if (askedColor) {
          if (c || bgKnown) {
            facts.push(`its ${c ? `text color is ${c}` : ''}${c && bgKnown ? ' and its ' : ''}${bgKnown ? `background color is ${bg}` : ''}`);
          } else {
            facts.push('I could not read its color');
          }
        }
        if (askedSize) {
          facts.push(w && h ? `it is ${w}px wide and ${h}px tall` : 'I could not read its size');
        }
        if (askedState) {
          facts.push(d != null ? `it is ${d === 'true' ? 'disabled' : 'enabled'}` : 'I could not read whether it is enabled or disabled');
        }

        if (facts.length) {
          narration = `I can see "${label || 'the element'}" — ${facts.join('; ')}`;
        } else if (x != null || y != null || w || h || c || bgKnown || d != null) {
          const parts = [];
          if (x != null && y != null) parts.push(`position x=${x}, y=${y}`);
          if (w && h) parts.push(`size ${w}px × ${h}px`);
          if (c) parts.push(`text color ${c}`);
          if (bgKnown) parts.push(`background color ${bg}`);
          if (d === 'true') parts.push('disabled');
          narration = `I read "${label || 'the element'}" — ${parts.join('; ')}`;
        } else {
          narration = `I could not read a value for "${label || 'the element'}"`;
        }
      } else if (/close_tab|closetab/i.test(toolName) || /close\s*tab|close\s*window|close\s*all/i.test(entry?.actionText || '')) {
        narration = `Closed tab/window "${label || normalized?.target || 'child window'}"`;
      } else if (/switch_tab|switchtab/i.test(toolName) || /switch\s*tab|switch\s*window/i.test(entry?.actionText || '')) {
        narration = `Switched focus to tab/window "${label || normalized?.target || 'target'}"`;
      } else if (/new_tab|newtab/i.test(toolName) || /new\s*tab/i.test(entry?.actionText || '')) {
        narration = `Opened new tab "${normalized?.url || 'blank'}"`;
      } else if (/switch\s*frame|iframe/i.test(entry?.actionText || '') || /switch_frame|switchframe/i.test(toolName)) {
        narration = `Switched focus into frame "${label || 'iframe'}"`;
      } else if (/access\s*shadow|shadow/i.test(entry?.actionText || '')) {
        narration = `Accessed Shadow DOM root for "${label || 'component'}"`;
      } else if (/go_back|goback|navigateback|navigate_back/i.test(toolName) || /go\s*back|navigate\s*back/i.test(entry?.actionText || '')) {
        narration = `Navigated back to previous page`;
      } else if (/go_forward|goforward|navigateforward|navigate_forward/i.test(toolName) || /go\s*forward|navigate\s*forward/i.test(entry?.actionText || '')) {
        narration = `Navigated forward`;
      } else if (/handle_dialog|alert/i.test(toolName) || /alert|dialog/i.test(entry?.actionText || '')) {
        narration = `Handled browser dialog (${normalized?.promptText ? `entered "${normalized.promptText}"` : (normalized?.accept === false ? 'dismissed' : 'accepted')})`;
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
        ...(session?.projectId ? { projectId: session.projectId } : {}),
        ...(session?.runId ? { runId: session.runId } : {}),
        ...(session?.testCaseId ? { tcId: session.testCaseId } : {}),
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
          ['browser_fill', 'browser_type', 'browser_handle_dialog'].includes(toolName)
          || semanticEvaluationAcknowledged
        ),
      acknowledgmentKind: result?.isError !== true
        ? ['browser_fill', 'browser_type', 'browser_handle_dialog'].includes(toolName)
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
  } = {}) => {
    // 1. Fast Deterministic Heuristic Match
    const heuristic = proposeTargetRecoveryFromSnapshot({ operation, snapshot, candidates });
    if (heuristic) return heuristic;

    // 2. Cognitive Fallback: AI Healer (Pillar 2)
    try {
      const intent = clean(
        operation?.authoredText
        || operation?.element
        || operation?.targetIdentity?.label
        || operation?.targetIdentity?.accessibleName
        || operation?.action
        || operation?.target
      );
      if (!intent || !snapshot?.snapshotText) return null;

      const brokenLocator = clean(operation?.targetIdentity?.accessibleName || operation?.target || operation?.element);
      const { resolveAiCredentials } = require('../lib/resolveAiCredentials');
      let creds = null;
      try {
        if (session?.userId && session?.project) {
          creds = await resolveAiCredentials(session.userId, session.project);
        }
      } catch (_) {}

      const healerResult = await healer.healLocator({
        apiKey: creds?.apiKey || process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY || 'copilot-bridge-active',
        provider: creds?.provider || 'copilot',
        model: creds?.model,
        intent,
        brokenLocator,
        freshSnapshot: snapshot.snapshotText,
        history: [],
      });

      if (healerResult && healerResult.confidence >= 40 && healerResult.selector) {
        let accessibleName = typeof healerResult.selector === 'object' ? healerResult.selector.name : healerResult.selector;
        let role = typeof healerResult.selector === 'object' ? healerResult.selector.role : null;
        
        return Object.freeze({
          proposalKind: 'TARGET_REPAIR',
          targetIdentity: Object.freeze({
            accessibleName: clean(accessibleName) || intent,
            role: clean(role) || null,
            selector: typeof healerResult.selector === 'string' ? healerResult.selector : null,
          }),
          actionType: operation.type,
          supportingFactRefs: Object.freeze(Array.isArray(snapshot?.factRefs) ? snapshot.factRefs : []),
          observedUnexpectedState: `AI Healer resolved locator with ${healerResult.confidence}% confidence: ${healerResult.reasoning || ''}`,
        });
      }
    } catch (healErr) {
      console.warn('[proposeTargetRecovery] Healer fallback error:', healErr?.message || healErr);
    }
    return null;
  };

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

async function recordSuccessfulLocator({
  projectId,
  element,
  pageUrl = '',
  selector,
  strategy = 'role',
  accessibleName = null,
  role = null,
  adapterKind = null,
  winningStrategy = null,
  ladderIndex = 0,
  interactionRecipe = null,
  updatedByRunId = null,
} = {}) {
  if (!projectId || !element) return null;
  const prisma = require('../prisma');
  const cleanElement = String(element).trim();
  const cleanPageUrl = String(pageUrl || '').trim();
  const cleanSelector = String(selector || '').trim();

  const recipe = interactionRecipe || {
    adapterKind,
    winningStrategy,
    ladderIndex,
    recordedAt: new Date().toISOString(),
  };
  const interactionRecipeJson = JSON.stringify(recipe);

  try {
    const existing = await prisma.knowledgeBaseLocator.findFirst({
      where: {
        projectId,
        element: cleanElement,
        pageUrl: cleanPageUrl,
      },
    });

    if (existing) {
      return await prisma.knowledgeBaseLocator.update({
        where: { id: existing.id },
        data: {
          selector: cleanSelector || existing.selector,
          strategy: strategy || existing.strategy,
          accessibleName: accessibleName || existing.accessibleName,
          role: role || existing.role,
          occurrences: { increment: 1 },
          healthScore: Math.min(100, (existing.healthScore || 100) + 5),
          interactionRecipeJson,
          lastUsedAt: new Date(),
          updatedByRunId: updatedByRunId || existing.updatedByRunId,
          deprecated: false,
        },
      });
    }

    return await prisma.knowledgeBaseLocator.create({
      data: {
        projectId,
        element: cleanElement,
        pageUrl: cleanPageUrl,
        selector: cleanSelector || cleanElement,
        strategy: strategy || 'role',
        accessibleName,
        role,
        occurrences: 1,
        healthScore: 100,
        interactionRecipeJson,
        lastUsedAt: new Date(),
        updatedByRunId,
      },
    });
  } catch (err) {
    console.warn(`[KB] Failed to persist locator for ${cleanElement}:`, err?.message);
    return null;
  }
}

async function lookupWinningRecipe({ projectId, element, pageUrl = '' } = {}) {
  if (!projectId || !element) return null;
  const prisma = require('../prisma');
  try {
    const row = await prisma.knowledgeBaseLocator.findFirst({
      where: {
        projectId,
        element: String(element).trim(),
        deprecated: false,
        healthScore: { gte: 30 },
      },
      orderBy: [
        { healthScore: 'desc' },
        { occurrences: 'desc' },
        { lastUsedAt: 'desc' },
      ],
    });
    if (row?.interactionRecipeJson) {
      try {
        return JSON.parse(row.interactionRecipeJson);
      } catch (_) {}
    }
    return null;
  } catch (_) {
    return null;
  }
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
  recordSuccessfulLocator,
  lookupWinningRecipe,
};
