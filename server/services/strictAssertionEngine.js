'use strict';

const ASSERTION_STATUS = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  UNCHECKABLE: 'uncheckable',
});

const ASSERTION_KIND = Object.freeze({
  EXACT_VISIBLE_TEXT: 'exact_visible_text',
  EXACT_VALUE: 'exact_value',
  EXACT_SELECTED_VALUE: 'exact_selected_value',
  COUNT: 'count',
  ORDERED_LIST: 'ordered_list',
  RELATIONSHIP: 'relationship',
  TOOLTIP: 'tooltip',
  VISIBILITY: 'visibility',
});

const FAILURE_CLASS = Object.freeze({
  VALIDATION_ONLY: 'validation_only',
  REQUIRED_ACTION: 'required_action',
  DEPENDENCY: 'dependency',
});

const REDACTED = '[REDACTED]';
const SECRET_HINT_RE = /(?:password|passcode|secret|token|credential|api[_ -]?key|private[_ -]?key|access[_ -]?key)/i;

const GENERIC_CHANNELS = new Set([
  'action_completed',
  'active_page_changed',
  'fingerprint',
  'fingerprint_changed',
  'navigation',
  'navigation_event',
  'page_change',
  'page_changed',
  'page_ready',
  'stable_destination_fingerprint',
  'stable_fingerprint',
  'url_change',
  'url_changed',
]);

const TEXT_CHANNELS = new Set(['dom_visible_text', 'ax_visible_text']);
const VALUE_CHANNELS = new Set(['owner_control_value']);
const SELECTED_VALUE_CHANNELS = new Set(['owner_selected_value']);
const COLLECTION_CHANNELS = new Set(['scoped_collection']);
const RELATIONSHIP_CHANNELS = new Set([
  'typed_relationship',
  'temporal_relationship',
  'numeric_relationship',
]);
const TOOLTIP_VISUAL_CHANNELS = new Set(['visual_tooltip']);
const TOOLTIP_SEMANTIC_CHANNELS = new Set(['semantic_tooltip']);
const VISIBILITY_CHANNELS = new Set(['dom_visibility', 'ax_visibility']);
const TOOLTIP_RELATIONSHIPS = new Set([
  'aria-describedby',
  'aria-label',
  'ax-description',
  'role-tooltip',
  'title',
  'tooltip-dom-node',
]);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeToken(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function normalizeAssertionKind(value) {
  const normalized = normalizeToken(value);
  if ([
    'text', 'assert_text', 'asserttext', 'exact_text', 'visible_text',
    'exact_visible_text', 'text_exact',
  ].includes(normalized)) return ASSERTION_KIND.EXACT_VISIBLE_TEXT;
  if ([
    'value', 'assert_value', 'exact_value', 'input_value', 'value_exact',
  ].includes(normalized)) return ASSERTION_KIND.EXACT_VALUE;
  if ([
    'selected', 'selection', 'selected_value', 'exact_selected_value',
    'selection_exact',
  ].includes(normalized)) return ASSERTION_KIND.EXACT_SELECTED_VALUE;
  if (['count', 'count_matches', 'exact_count'].includes(normalized)) return ASSERTION_KIND.COUNT;
  if ([
    'ordered_list', 'ordered_options', 'collection_exact_order', 'exact_order',
  ].includes(normalized)) return ASSERTION_KIND.ORDERED_LIST;
  if ([
    'relationship', 'typed_relationship', 'temporal_relationship',
    'chronological_relationship', 'control_relationship',
  ].includes(normalized)) return ASSERTION_KIND.RELATIONSHIP;
  if (['tooltip', 'tooltip_visible', 'tooltip_text'].includes(normalized)) return ASSERTION_KIND.TOOLTIP;
  if (['visible', 'assert_visible', 'assertvisible', 'hidden', 'assert_hidden', 'asserthidden'].includes(normalized)) {
    return ASSERTION_KIND.VISIBILITY;
  }
  return normalized || null;
}

function normalizeFailureClass(value) {
  const raw = isObject(value)
    ? value.classification || value.mode || value.type || value.onFailure || value.default
    : value;
  const normalized = normalizeToken(raw);
  if (/dependency|block_dependents|stop_descendants/.test(normalized)) return FAILURE_CLASS.DEPENDENCY;
  if (/required|action|control|input|navigation/.test(normalized)) return FAILURE_CLASS.REQUIRED_ACTION;
  return FAILURE_CLASS.VALIDATION_ONLY;
}

function failurePolicyMetadata(classification, status) {
  const failed = status !== ASSERTION_STATUS.PASS;
  const blockDependents = failed && classification !== FAILURE_CLASS.VALIDATION_ONLY;
  return {
    classification,
    onFailure: classification === FAILURE_CLASS.VALIDATION_ONLY
      ? 'record_and_continue'
      : 'block_dependents_only',
    continueExecution: true,
    continueIndependent: true,
    blockDependents,
    blockCase: false,
    blockRun: false,
  };
}

function normalizeChannels(evidence) {
  if (Array.isArray(evidence)) return evidence.filter(isObject);
  if (!isObject(evidence)) return [];
  if (Array.isArray(evidence.channels)) return evidence.channels.filter(isObject);
  if (isObject(evidence.channel)) return [evidence.channel];
  return [];
}

function channelKind(channel) {
  return normalizeToken(channel.kind || channel.type || channel.channelKind || channel.proofType);
}

function sourceFor(channel) {
  return String(channel.source || channel.provider || channelKind(channel) || '').trim() || null;
}

function sourceSummary(channels) {
  const sources = [...new Set(channels.map(sourceFor).filter(Boolean))];
  return sources.length ? sources.join(' + ') : null;
}

function isGenericChannel(channel) {
  const kind = channelKind(channel);
  return channel.generic === true || GENERIC_CHANNELS.has(kind);
}

function visibleProof(channel) {
  return channel.visible === true || channel.hidden === false || channel.exposed === true;
}

function targetProof(channel) {
  return channel.targetMatched === true || channel.exactTarget === true;
}

function ownerReadbackProof(channel) {
  return channel.ownerMatched === true && channel.readback === true;
}

function collectionProof(channel) {
  return channel.scopeMatched === true
    && channel.stable === true
    && visibleProof(channel);
}

function channelValue(channel) {
  if (Object.prototype.hasOwnProperty.call(channel, 'value')) return channel.value;
  if (Object.prototype.hasOwnProperty.call(channel, 'text')) return channel.text;
  if (Object.prototype.hasOwnProperty.call(channel, 'selectedValue')) return channel.selectedValue;
  if (Object.prototype.hasOwnProperty.call(channel, 'displayedValue')) return channel.displayedValue;
  return null;
}

function expectedFrom(assertion) {
  if (Object.prototype.hasOwnProperty.call(assertion, 'expected')) return assertion.expected;
  if (Object.prototype.hasOwnProperty.call(assertion, 'expectedValue')) return assertion.expectedValue;
  if (Object.prototype.hasOwnProperty.call(assertion, 'value')) return assertion.value;
  if (Object.prototype.hasOwnProperty.call(assertion, 'text')) return assertion.text;
  if (Object.prototype.hasOwnProperty.call(assertion, 'count')) return assertion.count;
  if (Object.prototype.hasOwnProperty.call(assertion, 'items')) return assertion.items;
  return null;
}

function canonicalText(value, caseSensitive = true) {
  const normalized = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return caseSensitive ? normalized : normalized.toLocaleLowerCase('en-US');
}

function canonicalArray(value, caseSensitive = true) {
  if (!Array.isArray(value)) return null;
  return value.map((item) => canonicalText(item, caseSensitive));
}

function uniqueCanonicalValues(rows, canonicalize) {
  const byKey = new Map();
  for (const row of rows) {
    const canonical = canonicalize(row.value);
    const key = JSON.stringify(canonical);
    if (!byKey.has(key)) byKey.set(key, { canonical, raw: row.value });
  }
  return [...byKey.values()];
}

function rawEvaluation(status, observed, source, reason, extra = {}) {
  return {
    status,
    evaluated: status !== ASSERTION_STATUS.UNCHECKABLE,
    matched: status === ASSERTION_STATUS.PASS ? true : status === ASSERTION_STATUS.FAIL ? false : null,
    observed,
    source,
    reason,
    ...extra,
  };
}

function evaluateScalar({ channels, expected, eligible, readValue = channelValue, canonicalize, reasonPrefix }) {
  const accepted = channels.filter((channel) => !isGenericChannel(channel) && eligible(channel));
  if (!accepted.length) {
    return rawEvaluation(
      ASSERTION_STATUS.UNCHECKABLE,
      null,
      null,
      `${reasonPrefix}_evidence_missing`,
    );
  }

  const rows = accepted.map((channel) => ({ channel, value: readValue(channel) }));
  const unique = uniqueCanonicalValues(rows, canonicalize);
  if (unique.length > 1) {
    return rawEvaluation(
      ASSERTION_STATUS.UNCHECKABLE,
      unique.map((entry) => entry.raw),
      sourceSummary(accepted),
      `conflicting_${reasonPrefix}_evidence`,
    );
  }

  const expectedCanonical = canonicalize(expected);
  const observed = unique[0].raw;
  const matched = unique[0].canonical === expectedCanonical;
  return rawEvaluation(
    matched ? ASSERTION_STATUS.PASS : ASSERTION_STATUS.FAIL,
    observed,
    sourceSummary(accepted),
    matched ? `${reasonPrefix}_matched` : `${reasonPrefix}_mismatch`,
  );
}

function evaluateExactVisibleText(assertion, channels, expected) {
  if (expected == null || !canonicalText(expected)) {
    return rawEvaluation(ASSERTION_STATUS.UNCHECKABLE, null, null, 'expected_visible_text_missing');
  }
  const caseSensitive = assertion.caseSensitive !== false;
  const negative = channels.filter((channel) => !isGenericChannel(channel)
    && TEXT_CHANNELS.has(channelKind(channel))
    && targetProof(channel)
    && channel.searched === true
    && channel.visible === false);
  const positive = channels.filter((channel) => !isGenericChannel(channel)
    && TEXT_CHANNELS.has(channelKind(channel))
    && targetProof(channel)
    && visibleProof(channel)
    && channelValue(channel) != null);
  if (!positive.length && negative.length) {
    return rawEvaluation(
      ASSERTION_STATUS.FAIL,
      null,
      sourceSummary(negative),
      'exact_visible_text_not_observed',
    );
  }
  return evaluateScalar({
    channels,
    expected,
    eligible: (channel) => TEXT_CHANNELS.has(channelKind(channel))
      && targetProof(channel)
      && visibleProof(channel)
      && channelValue(channel) != null,
    canonicalize: (value) => canonicalText(value, caseSensitive),
    reasonPrefix: 'exact_visible_text',
  });
}

function evaluateExactValue(assertion, channels, expected, selected = false) {
  if (expected == null) {
    return rawEvaluation(
      ASSERTION_STATUS.UNCHECKABLE,
      null,
      null,
      selected ? 'expected_selected_value_missing' : 'expected_value_missing',
    );
  }
  const caseSensitive = assertion.caseSensitive !== false;
  const allowed = selected ? SELECTED_VALUE_CHANNELS : VALUE_CHANNELS;
  return evaluateScalar({
    channels,
    expected,
    eligible: (channel) => allowed.has(channelKind(channel))
      && ownerReadbackProof(channel)
      && channelValue(channel) != null,
    canonicalize: (value) => canonicalText(value, caseSensitive),
    reasonPrefix: selected ? 'owner_selected_value' : 'owner_value',
  });
}

function evaluateVisibility(assertion, channels, expected) {
  const authoredKind = normalizeToken(assertion.kind || assertion.type);
  const expectedVisible = authoredKind.includes('hidden')
    ? false
    : isObject(expected) && typeof expected.visible === 'boolean'
      ? expected.visible
      : typeof expected === 'boolean' ? expected : true;
  return evaluateScalar({
    channels,
    expected: expectedVisible,
    eligible: (channel) => VISIBILITY_CHANNELS.has(channelKind(channel))
      && targetProof(channel)
      && typeof channel.visible === 'boolean',
    readValue: (channel) => channel.visible,
    canonicalize: (value) => value === true,
    reasonPrefix: 'exact_visibility',
  });
}

function countContract(assertion, expected) {
  const rawExpected = isObject(expected)
    ? expected.count ?? expected.value ?? expected.equals ?? expected.expected
    : expected;
  const count = Number(rawExpected);
  const comparator = normalizeToken(assertion.comparator || (isObject(expected) && expected.comparator) || 'equals');
  if (!Number.isFinite(count)) return null;
  if (!['equals', 'equal', 'eq', 'gte', 'lte', 'gt', 'lt'].includes(comparator)) return null;
  return { count, comparator };
}

function compareCount(actual, contract) {
  if (['equals', 'equal', 'eq'].includes(contract.comparator)) return actual === contract.count;
  if (contract.comparator === 'gte') return actual >= contract.count;
  if (contract.comparator === 'lte') return actual <= contract.count;
  if (contract.comparator === 'gt') return actual > contract.count;
  if (contract.comparator === 'lt') return actual < contract.count;
  return false;
}

function evaluateCount(assertion, channels, expected) {
  const contract = countContract(assertion, expected);
  if (!contract) return rawEvaluation(ASSERTION_STATUS.UNCHECKABLE, null, null, 'expected_count_invalid');
  const accepted = channels.filter((channel) => !isGenericChannel(channel)
    && COLLECTION_CHANNELS.has(channelKind(channel))
    && collectionProof(channel)
    && Number.isFinite(Number(channel.count ?? (Array.isArray(channel.items) ? channel.items.length : NaN))));
  if (!accepted.length) {
    return rawEvaluation(ASSERTION_STATUS.UNCHECKABLE, null, null, 'scoped_count_evidence_missing');
  }
  const rows = accepted.map((channel) => ({
    channel,
    value: Number(channel.count ?? channel.items.length),
  }));
  const unique = uniqueCanonicalValues(rows, Number);
  if (unique.length > 1) {
    return rawEvaluation(
      ASSERTION_STATUS.UNCHECKABLE,
      unique.map((entry) => entry.raw),
      sourceSummary(accepted),
      'conflicting_scoped_count_evidence',
    );
  }
  const observed = unique[0].raw;
  const matched = compareCount(observed, contract);
  return rawEvaluation(
    matched ? ASSERTION_STATUS.PASS : ASSERTION_STATUS.FAIL,
    observed,
    sourceSummary(accepted),
    matched ? 'scoped_count_matched' : 'scoped_count_mismatch',
  );
}

function evaluateOrderedList(assertion, channels, expected) {
  const expectedItems = Array.isArray(expected) ? expected : isObject(expected) ? expected.items : null;
  if (!Array.isArray(expectedItems)) {
    return rawEvaluation(ASSERTION_STATUS.UNCHECKABLE, null, null, 'expected_ordered_list_invalid');
  }
  const caseSensitive = assertion.caseSensitive !== false;
  const accepted = channels.filter((channel) => !isGenericChannel(channel)
    && COLLECTION_CHANNELS.has(channelKind(channel))
    && collectionProof(channel)
    && Array.isArray(channel.items));
  if (!accepted.length) {
    return rawEvaluation(ASSERTION_STATUS.UNCHECKABLE, null, null, 'stable_ordered_list_evidence_missing');
  }
  const rows = accepted.map((channel) => ({ channel, value: channel.items }));
  const unique = uniqueCanonicalValues(rows, (value) => canonicalArray(value, caseSensitive));
  if (unique.length > 1) {
    return rawEvaluation(
      ASSERTION_STATUS.UNCHECKABLE,
      unique.map((entry) => entry.raw),
      sourceSummary(accepted),
      'conflicting_ordered_list_evidence',
    );
  }
  const expectedCanonical = canonicalArray(expectedItems, caseSensitive);
  const matched = JSON.stringify(unique[0].canonical) === JSON.stringify(expectedCanonical);
  return rawEvaluation(
    matched ? ASSERTION_STATUS.PASS : ASSERTION_STATUS.FAIL,
    unique[0].raw,
    sourceSummary(accepted),
    matched ? 'ordered_list_matched' : 'ordered_list_mismatch',
  );
}

function normalizeRelationshipOperator(value) {
  const normalized = normalizeToken(value);
  if (['before', 'less_than', 'lt'].includes(normalized)) return 'before';
  if (['after', 'greater_than', 'gt'].includes(normalized)) return 'after';
  if (['equals', 'equal', 'eq', 'same_as'].includes(normalized)) return 'equals';
  if (['not_equals', 'not_equal', 'ne', 'different_from'].includes(normalized)) return 'not_equals';
  if (['before_or_equal', 'less_than_or_equal', 'lte'].includes(normalized)) return 'before_or_equal';
  if (['after_or_equal', 'greater_than_or_equal', 'gte'].includes(normalized)) return 'after_or_equal';
  return null;
}

function relationshipContract(assertion, expected) {
  const expectedObject = isObject(expected) ? expected : {};
  const operator = normalizeRelationshipOperator(
    assertion.operator
      || assertion.relationship
      || expectedObject.operator
      || expectedObject.relationship
      || expectedObject.relation
      || (typeof expected === 'string' ? expected : null),
  );
  if (!operator) return null;
  return {
    operator,
    leftTarget: assertion.leftTarget || expectedObject.leftTarget || null,
    rightTarget: assertion.rightTarget || expectedObject.rightTarget || null,
  };
}

function normalizeOperandType(value) {
  const normalized = normalizeToken(value);
  if (['number', 'integer', 'decimal'].includes(normalized)) return 'number';
  if (['date', 'datetime', 'date_time', 'timestamp'].includes(normalized)) return 'datetime';
  if (['time', 'time_of_day'].includes(normalized)) return 'time';
  if (['string', 'text'].includes(normalized)) return 'string';
  return null;
}

function canonicalTime(value) {
  const raw = String(value == null ? '' : value).trim();
  const twelveHour = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)$/i);
  if (twelveHour) {
    let hour = Number(twelveHour[1]) % 12;
    if (twelveHour[4].toLowerCase() === 'pm') hour += 12;
    const minute = Number(twelveHour[2]);
    const second = Number(twelveHour[3] || 0);
    if (minute > 59 || second > 59) return null;
    return (hour * 3600) + (minute * 60) + second;
  }
  const twentyFourHour = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!twentyFourHour) return null;
  const hour = Number(twentyFourHour[1]);
  const minute = Number(twentyFourHour[2]);
  const second = Number(twentyFourHour[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return (hour * 3600) + (minute * 60) + second;
}

function typedOperand(value, fallbackType = null) {
  const source = isObject(value) ? value : { value, type: fallbackType };
  const type = normalizeOperandType(source.type || source.valueType || fallbackType);
  if (!type || !Object.prototype.hasOwnProperty.call(source, 'value')) return null;

  let comparable;
  if (type === 'number') {
    comparable = Number(source.value);
    if (!Number.isFinite(comparable)) return null;
  } else if (type === 'datetime') {
    comparable = Date.parse(String(source.value));
    if (!Number.isFinite(comparable)) return null;
  } else if (type === 'time') {
    comparable = canonicalTime(source.value);
    if (!Number.isFinite(comparable)) return null;
  } else {
    comparable = canonicalText(source.value, true);
  }

  return { type, value: source.value, comparable };
}

function relationshipScopeProof(channel) {
  return channel.scopeMatched === true
    || (channel.leftTargetMatched === true && channel.rightTargetMatched === true);
}

function relationshipReadbackProof(channel) {
  return channel.readback === true
    || (channel.leftReadback === true && channel.rightReadback === true);
}

function relationshipOperands(channel) {
  const sharedType = channel.valueType || channel.operandType || null;
  const left = typedOperand(
    Object.prototype.hasOwnProperty.call(channel, 'left') ? channel.left : channel.leftValue,
    channel.leftType || sharedType,
  );
  const right = typedOperand(
    Object.prototype.hasOwnProperty.call(channel, 'right') ? channel.right : channel.rightValue,
    channel.rightType || sharedType,
  );
  if (!left || !right || left.type !== right.type) return null;
  return { left, right };
}

function compareRelationship(left, right, operator) {
  if (operator === 'before') return left < right;
  if (operator === 'after') return left > right;
  if (operator === 'equals') return left === right;
  if (operator === 'not_equals') return left !== right;
  if (operator === 'before_or_equal') return left <= right;
  if (operator === 'after_or_equal') return left >= right;
  return false;
}

function evaluateRelationship(assertion, channels, expected) {
  const contract = relationshipContract(assertion, expected);
  if (!contract) {
    return rawEvaluation(ASSERTION_STATUS.UNCHECKABLE, null, null, 'expected_relationship_invalid');
  }

  const accepted = channels
    .filter((channel) => !isGenericChannel(channel)
      && RELATIONSHIP_CHANNELS.has(channelKind(channel))
      && relationshipScopeProof(channel)
      && relationshipReadbackProof(channel))
    .map((channel) => ({ channel, operands: relationshipOperands(channel) }))
    .filter((row) => row.operands);

  if (!accepted.length) {
    return rawEvaluation(ASSERTION_STATUS.UNCHECKABLE, null, null, 'typed_relationship_evidence_missing');
  }

  const unique = new Map();
  for (const row of accepted) {
    const key = JSON.stringify({
      type: row.operands.left.type,
      left: row.operands.left.comparable,
      right: row.operands.right.comparable,
    });
    if (!unique.has(key)) unique.set(key, row);
  }
  if (unique.size > 1) {
    return rawEvaluation(
      ASSERTION_STATUS.UNCHECKABLE,
      [...unique.values()].map((row) => ({
        valueType: row.operands.left.type,
        left: row.operands.left.value,
        right: row.operands.right.value,
      })),
      sourceSummary(accepted.map((row) => row.channel)),
      'conflicting_typed_relationship_evidence',
    );
  }

  const row = [...unique.values()][0];
  const { left, right } = row.operands;
  const matched = compareRelationship(left.comparable, right.comparable, contract.operator);
  const observed = {
    operator: contract.operator,
    valueType: left.type,
    left: left.value,
    right: right.value,
  };
  return rawEvaluation(
    matched ? ASSERTION_STATUS.PASS : ASSERTION_STATUS.FAIL,
    observed,
    sourceSummary(accepted.map((entry) => entry.channel)),
    matched ? 'typed_relationship_matched' : 'typed_relationship_mismatch',
  );
}

function semanticTooltipProof(channel) {
  const relationship = normalizeToken(channel.relationship || channel.semanticSource || channel.attribute)
    .replace(/_/g, '-');
  return TOOLTIP_SEMANTIC_CHANNELS.has(channelKind(channel))
    && targetProof(channel)
    && (channel.semantic === true || TOOLTIP_RELATIONSHIPS.has(relationship));
}

function visualTooltipProof(channel) {
  return TOOLTIP_VISUAL_CHANNELS.has(channelKind(channel))
    && targetProof(channel)
    && visibleProof(channel);
}

function evaluateTooltip(assertion, channels, expected) {
  if (expected == null || !canonicalText(expected)) {
    return rawEvaluation(ASSERTION_STATUS.UNCHECKABLE, null, null, 'expected_tooltip_text_missing');
  }
  const visual = channels.filter((channel) => !isGenericChannel(channel)
    && visualTooltipProof(channel)
    && channelValue(channel) != null);
  const semantic = channels.filter((channel) => !isGenericChannel(channel)
    && semanticTooltipProof(channel)
    && channelValue(channel) != null);
  const accepted = [...visual, ...semantic];
  if (!accepted.length) {
    return rawEvaluation(ASSERTION_STATUS.UNCHECKABLE, null, null, 'tooltip_evidence_missing', {
      proofType: null,
      visualCaptured: false,
    });
  }
  const caseSensitive = assertion.caseSensitive !== false;
  const rows = accepted.map((channel) => ({ channel, value: channelValue(channel) }));
  const unique = uniqueCanonicalValues(rows, (value) => canonicalText(value, caseSensitive));
  if (unique.length > 1) {
    return rawEvaluation(
      ASSERTION_STATUS.UNCHECKABLE,
      unique.map((entry) => entry.raw),
      sourceSummary(accepted),
      'conflicting_tooltip_evidence',
      { proofType: null, visualCaptured: visual.length > 0 },
    );
  }
  const observed = unique[0].raw;
  const matched = unique[0].canonical === canonicalText(expected, caseSensitive);
  const proofType = visual.length ? 'visual' : 'semantic';
  const reason = matched
    ? proofType === 'visual' ? 'tooltip_visual_matched' : 'tooltip_semantic_matched_no_visual_capture'
    : 'tooltip_text_mismatch';
  return rawEvaluation(
    matched ? ASSERTION_STATUS.PASS : ASSERTION_STATUS.FAIL,
    observed,
    sourceSummary(accepted),
    reason,
    { proofType, visualCaptured: visual.length > 0 },
  );
}

function collectSensitiveLiterals(assertion, evidence, explicitValues) {
  const values = new Set((Array.isArray(explicitValues) ? explicitValues : [])
    .filter((value) => typeof value === 'string' && value.length > 0));
  const target = assertion.target && isObject(assertion.target)
    ? `${assertion.target.name || ''} ${assertion.target.label || ''} ${assertion.target.role || ''}`
    : String(assertion.target || assertion.element || assertion.field || '');
  const sensitive = assertion.sensitive === true || evidence.sensitive === true || SECRET_HINT_RE.test(target);
  if (sensitive) {
    const expected = expectedFrom(assertion);
    if (typeof expected === 'string' && expected) values.add(expected);
    for (const channel of normalizeChannels(evidence)) {
      const value = channelValue(channel);
      if (typeof value === 'string' && value) values.add(value);
    }
  }
  return { sensitive, values: [...values].sort((left, right) => right.length - left.length) };
}

function redactString(value, literals) {
  let output = String(value);
  for (const literal of literals) {
    if (literal) output = output.split(literal).join(REDACTED);
  }
  return output;
}

function redactValue(value, literals, force = false, key = '') {
  if (value == null) return value;
  if (force || SECRET_HINT_RE.test(key)) return REDACTED;
  if (typeof value === 'string') return redactString(value, literals);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, literals, false, key));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactValue(entryValue, literals, false, entryKey),
    ]));
  }
  return value;
}

function evaluateAssertion(input = {}) {
  const assertion = isObject(input.assertion) ? input.assertion : input;
  const evidence = isObject(input.evidence)
    ? input.evidence
    : isObject(assertion.evidence) ? assertion.evidence : {};
  const kind = normalizeAssertionKind(assertion.kind || assertion.type);
  const expected = expectedFrom(assertion);
  const channels = normalizeChannels(evidence);
  const failureClass = normalizeFailureClass(input.failurePolicy ?? assertion.failurePolicy);

  let evaluation;
  if (kind === ASSERTION_KIND.EXACT_VISIBLE_TEXT) {
    evaluation = evaluateExactVisibleText(assertion, channels, expected);
  } else if (kind === ASSERTION_KIND.EXACT_VALUE) {
    evaluation = evaluateExactValue(assertion, channels, expected, false);
  } else if (kind === ASSERTION_KIND.EXACT_SELECTED_VALUE) {
    evaluation = evaluateExactValue(assertion, channels, expected, true);
  } else if (kind === ASSERTION_KIND.COUNT) {
    evaluation = evaluateCount(assertion, channels, expected);
  } else if (kind === ASSERTION_KIND.ORDERED_LIST) {
    evaluation = evaluateOrderedList(assertion, channels, expected);
  } else if (kind === ASSERTION_KIND.RELATIONSHIP) {
    evaluation = evaluateRelationship(assertion, channels, expected);
  } else if (kind === ASSERTION_KIND.TOOLTIP) {
    evaluation = evaluateTooltip(assertion, channels, expected);
  } else if (kind === ASSERTION_KIND.VISIBILITY) {
    evaluation = evaluateVisibility(assertion, channels, expected);
  } else {
    evaluation = rawEvaluation(ASSERTION_STATUS.UNCHECKABLE, null, null, 'assertion_kind_unsupported');
  }

  const secretState = collectSensitiveLiterals(assertion, evidence, input.sensitiveValues);
  return {
    assertionKind: kind,
    ...evaluation,
    expected: redactValue(expected, secretState.values, secretState.sensitive),
    observed: redactValue(evaluation.observed, secretState.values, secretState.sensitive),
    source: redactValue(evaluation.source, secretState.values),
    reason: redactValue(evaluation.reason, secretState.values),
    failurePolicy: failurePolicyMetadata(failureClass, evaluation.status),
  };
}

module.exports = {
  ASSERTION_STATUS,
  ASSERTION_KIND,
  FAILURE_CLASS,
  REDACTED,
  normalizeAssertionKind,
  normalizeFailureClass,
  evaluateAssertion,
};
