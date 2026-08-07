'use strict';

const {
  OUTCOMES,
  compareCollectionMembership,
  compareTableAssertion,
} = require('./tableAssertionComparator');

function result(outcome, expected, actual, comparator, reason) {
  return {
    outcome,
    matched: outcome === OUTCOMES.MATCHED ? true : outcome === OUTCOMES.NOT_MATCHED ? false : null,
    expected,
    actual,
    comparator,
    reason,
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function normalizeText(value, { caseSensitive = false, collapseWhitespace = true, trim = true } = {}) {
  let text = String(value == null ? '' : value);
  if (collapseWhitespace) text = text.replace(/\s+/g, ' ');
  if (trim) text = text.trim();
  return caseSensitive ? text : text.toLocaleLowerCase('en-US');
}

function textActual(actual) {
  if (!isObject(actual)) return actual;
  return firstDefined(actual.text, actual.visibleText, actual.value, actual.actual);
}

function compareText(expected, actual, comparator = 'contains', options = {}) {
  const op = String(comparator || 'contains').toLowerCase();
  if (expected === undefined) return result(OUTCOMES.UNCHECKABLE, expected, actual, op, 'text_expected_missing');
  if (actual === undefined || actual === null) return result(OUTCOMES.UNCHECKABLE, expected, actual, op, 'text_actual_unavailable');
  const left = normalizeText(actual, options);
  const right = normalizeText(expected, options);
  let matched;
  if (op === 'equals' || op === 'eq') matched = left === right;
  else if (op === 'not_equals' || op === 'ne') matched = left !== right;
  else if (op === 'contains') matched = left.includes(right);
  else if (op === 'not_contains') matched = !left.includes(right);
  else if (op === 'starts_with') matched = left.startsWith(right);
  else if (op === 'ends_with') matched = left.endsWith(right);
  else return result(OUTCOMES.UNCHECKABLE, expected, actual, op, 'text_comparator_unsupported');
  return result(matched ? OUTCOMES.MATCHED : OUTCOMES.NOT_MATCHED, expected, actual, op,
    matched ? 'text_matched' : 'text_not_matched');
}

function compareRegex(pattern, actual, flags = '') {
  if (typeof pattern !== 'string') return result(OUTCOMES.UNCHECKABLE, pattern, actual, 'regex', 'regex_pattern_missing');
  if (actual === undefined || actual === null) return result(OUTCOMES.UNCHECKABLE, pattern, actual, 'regex', 'regex_actual_unavailable');
  let expression;
  try { expression = new RegExp(pattern, String(flags || '')); }
  catch (_) { return result(OUTCOMES.UNCHECKABLE, pattern, actual, 'regex', 'regex_pattern_invalid'); }
  const matched = expression.test(String(actual));
  return result(matched ? OUTCOMES.MATCHED : OUTCOMES.NOT_MATCHED, pattern, actual, 'regex',
    matched ? 'regex_matched' : 'regex_not_matched');
}

function numericValue(value) {
  const raw = isObject(value) ? firstDefined(value.number, value.amount, value.value, value.actual) : value;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  let text = raw.replace(/[\s\u00a0,]/g, '').trim();
  const negative = /^\(.*\)$/.test(text);
  if (negative) text = text.slice(1, -1);
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? (negative ? -parsed : parsed) : null;
}

function compareNumber(expectedInput, actualInput, comparator = 'equals', toleranceInput = 0) {
  const expected = numericValue(expectedInput);
  const actual = numericValue(actualInput);
  const tolerance = Number(toleranceInput == null ? 0 : toleranceInput);
  const op = String(comparator || 'equals').toLowerCase();
  if (expected === null) return result(OUTCOMES.UNCHECKABLE, expectedInput, actualInput, op, 'number_expected_invalid');
  if (actual === null) return result(OUTCOMES.UNCHECKABLE, expected, actualInput, op, 'number_actual_unavailable');
  if (!Number.isFinite(tolerance) || tolerance < 0) return result(OUTCOMES.UNCHECKABLE, expected, actual, op, 'number_tolerance_invalid');
  let matched;
  if (op === 'equals' || op === 'eq' || op === 'within') matched = Math.abs(actual - expected) <= tolerance;
  else if (op === 'not_equals' || op === 'ne') matched = Math.abs(actual - expected) > tolerance;
  else if (op === 'gt') matched = actual > expected + tolerance;
  else if (op === 'gte') matched = actual >= expected - tolerance;
  else if (op === 'lt') matched = actual < expected - tolerance;
  else if (op === 'lte') matched = actual <= expected + tolerance;
  else return result(OUTCOMES.UNCHECKABLE, expected, actual, op, 'number_comparator_unsupported');
  return result(matched ? OUTCOMES.MATCHED : OUTCOMES.NOT_MATCHED, expected, actual, op,
    matched ? 'number_matched' : 'number_not_matched');
}

const CURRENCY_SYMBOLS = Object.freeze({ '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR' });

function currencyValue(value, explicitCurrency) {
  const raw = isObject(value) ? firstDefined(value.amount, value.value, value.actual) : value;
  let currency = String(firstDefined(isObject(value) ? value.currency : undefined, explicitCurrency, '') || '').toUpperCase() || null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? { amount: raw, currency } : null;
  if (typeof raw !== 'string') return null;
  const code = raw.match(/\b[A-Z]{3}\b/i);
  const symbol = Object.keys(CURRENCY_SYMBOLS).find((candidate) => raw.includes(candidate));
  if (!currency && code) currency = code[0].toUpperCase();
  if (!currency && symbol) currency = CURRENCY_SYMBOLS[symbol];
  const numeric = raw
    .replace(/\b[A-Z]{3}\b/gi, '')
    .replace(/[$€£¥₹]/g, '')
    .trim();
  const amount = numericValue(numeric);
  return amount === null ? null : { amount, currency };
}

function compareCurrency(payload, actualInput) {
  const expectedInput = firstDefined(payload.expectedAmount, payload.expectedValue, payload.expected);
  const expected = currencyValue(expectedInput, payload.currency || payload.expectedCurrency);
  const actual = currencyValue(actualInput, isObject(actualInput) ? actualInput.currency : undefined);
  const comparator = String(payload.comparator || 'equals').toLowerCase();
  if (!expected) return result(OUTCOMES.UNCHECKABLE, expectedInput, actualInput, comparator, 'currency_expected_invalid');
  if (!actual) return result(OUTCOMES.UNCHECKABLE, expected, actualInput, comparator, 'currency_actual_unavailable');
  if (expected.currency && !actual.currency) return result(OUTCOMES.UNCHECKABLE, expected, actual, comparator, 'currency_code_unavailable');
  if (expected.currency && actual.currency && expected.currency !== actual.currency) {
    return result(OUTCOMES.NOT_MATCHED, expected, actual, comparator, 'currency_code_not_matched');
  }
  const compared = compareNumber(expected.amount, actual.amount, comparator, payload.tolerance || 0);
  return result(compared.outcome, expected, actual, comparator,
    compared.outcome === OUTCOMES.MATCHED ? 'currency_matched'
      : compared.outcome === OUTCOMES.NOT_MATCHED ? 'currency_amount_not_matched' : compared.reason);
}

function parseTemporal(value, kind) {
  const raw = isObject(value) ? firstDefined(value.value, value.dateTime, value.date, value.time, value.actual) : value;
  if (raw instanceof Date) return Number.isFinite(raw.getTime()) ? raw.getTime() : null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const text = raw.trim();
  if (kind === 'date') {
    const utcDate = (year, month, day) => {
      const parsed = Date.UTC(Number(year), Number(month) - 1, Number(day));
      const date = new Date(parsed);
      return date.getUTCFullYear() === Number(year)
        && date.getUTCMonth() === Number(month) - 1
        && date.getUTCDate() === Number(day)
        ? parsed
        : null;
    };
    const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    const slashDate = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
    const namedDate = /^(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),\s*(\d{4})$/i.exec(text);
    const monthNames = [
      'january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december',
    ];
    const parsed = isoDate
      ? utcDate(isoDate[1], isoDate[2], isoDate[3])
      : slashDate
        ? utcDate(slashDate[3], slashDate[1], slashDate[2])
        : namedDate
          ? utcDate(namedDate[3], monthNames.indexOf(namedDate[1].toLowerCase()) + 1, namedDate[2])
          : Date.parse(text);
    if (!Number.isFinite(parsed)) return null;
    const date = new Date(parsed);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  }
  if (kind === 'time') {
    const timeOnly = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(text);
    if (timeOnly) {
      const iso = `1970-01-01T${timeOnly[1]}:${timeOnly[2]}:${timeOnly[3] || '00'}.${String(timeOnly[4] || '0').padEnd(3, '0')}${timeOnly[5] || 'Z'}`;
      const parsed = Date.parse(iso);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareTemporal(kind, payload, actualInput) {
  const field = kind === 'date' ? payload.expectedDate : kind === 'time' ? payload.expectedTime : payload.expectedDateTime;
  const expectedInput = firstDefined(field, payload.expectedValue, payload.expected);
  const expected = parseTemporal(expectedInput, kind);
  const actual = parseTemporal(actualInput, kind);
  const comparator = String(payload.comparator || 'equals').toLowerCase();
  const tolerance = Number(firstDefined(payload.toleranceMs,
    payload.toleranceSeconds === undefined ? undefined : Number(payload.toleranceSeconds) * 1000,
    payload.toleranceMinutes === undefined ? undefined : Number(payload.toleranceMinutes) * 60000,
    0));
  if (expected === null) return result(OUTCOMES.UNCHECKABLE, expectedInput, actualInput, comparator, `${kind}_expected_invalid`);
  if (actual === null) return result(OUTCOMES.UNCHECKABLE, expected, actualInput, comparator, `${kind}_actual_unavailable`);
  if (!Number.isFinite(tolerance) || tolerance < 0) return result(OUTCOMES.UNCHECKABLE, expected, actual, comparator, `${kind}_tolerance_invalid`);
  let matched;
  if (comparator === 'equals' || comparator === 'eq' || comparator === 'within') matched = Math.abs(actual - expected) <= tolerance;
  else if (comparator === 'before' || comparator === 'lt') matched = actual < expected - tolerance;
  else if (comparator === 'after' || comparator === 'gt') matched = actual > expected + tolerance;
  else if (comparator === 'on_or_before' || comparator === 'lte') matched = actual <= expected + tolerance;
  else if (comparator === 'on_or_after' || comparator === 'gte') matched = actual >= expected - tolerance;
  else return result(OUTCOMES.UNCHECKABLE, expected, actual, comparator, `${kind}_comparator_unsupported`);
  return result(matched ? OUTCOMES.MATCHED : OUTCOMES.NOT_MATCHED, expectedInput, actualInput, comparator,
    matched ? `${kind}_matched` : `${kind}_not_matched`);
}

function urlText(value) {
  return String(isObject(value) ? firstDefined(value.url, value.href, value.value, '') : value == null ? '' : value).trim();
}

function parsedUrl(value) {
  try { return new URL(value, 'http://qaai.invalid'); } catch (_) { return null; }
}

function compareUrl(payload, actualInput) {
  const expected = firstDefined(payload.expectedUrl, payload.expectedUrlPattern, payload.expectedValue, payload.expected);
  const actual = urlText(actualInput);
  const comparator = String(payload.comparator || (payload.expectedUrlPattern !== undefined ? 'contains' : 'equals')).toLowerCase();
  if (typeof expected !== 'string' || !expected) return result(OUTCOMES.UNCHECKABLE, expected, actual, comparator, 'url_expected_missing');
  if (!actual) return result(OUTCOMES.UNCHECKABLE, expected, actual, comparator, 'url_actual_unavailable');
  if (comparator === 'regex') return compareRegex(expected, actual, payload.flags);
  let matched;
  if (comparator === 'equals' || comparator === 'eq') matched = actual === expected;
  else if (comparator === 'contains') matched = actual.includes(expected);
  else if (comparator === 'starts_with') matched = actual.startsWith(expected);
  else if (['origin', 'path', 'path_and_query'].includes(comparator)) {
    const expectedUrl = parsedUrl(expected);
    const actualUrl = parsedUrl(actual);
    if (!expectedUrl || !actualUrl) return result(OUTCOMES.UNCHECKABLE, expected, actual, comparator, 'url_parse_failed');
    if (comparator === 'origin') matched = expectedUrl.origin === actualUrl.origin;
    else if (comparator === 'path') matched = expectedUrl.pathname === actualUrl.pathname;
    else matched = `${expectedUrl.pathname}${expectedUrl.search}` === `${actualUrl.pathname}${actualUrl.search}`;
  } else return result(OUTCOMES.UNCHECKABLE, expected, actual, comparator, 'url_comparator_unsupported');
  return result(matched ? OUTCOMES.MATCHED : OUTCOMES.NOT_MATCHED, expected, actual, comparator,
    matched ? 'url_matched' : 'url_not_matched');
}

function booleanState(actual, key) {
  if (typeof actual === 'boolean') return actual;
  if (typeof actual === 'string') {
    const state = actual.trim().toLowerCase();
    if (['true', 'yes', 'checked', 'selected', 'visible'].includes(state)) return true;
    if (['false', 'no', 'unchecked', 'unselected', 'hidden'].includes(state)) return false;
  }
  if (!isObject(actual)) return null;
  if (typeof actual[key] === 'boolean') return actual[key];
  if (key === 'visible' && typeof actual.hidden === 'boolean') return !actual.hidden;
  if (key === 'visible' && actual.exists === false) return false;
  const ariaKey = key === 'checked' ? 'ariaChecked' : key === 'selected' ? 'ariaSelected' : null;
  if (ariaKey && actual[ariaKey] !== undefined) return booleanState(actual[ariaKey], key);
  return null;
}

function compareBoolean(kind, expected, actualInput) {
  const actual = booleanState(actualInput, kind);
  if (actual === null) return result(OUTCOMES.UNCHECKABLE, expected, actualInput, kind, `${kind}_actual_unavailable`);
  const matched = actual === expected;
  return result(matched ? OUTCOMES.MATCHED : OUTCOMES.NOT_MATCHED, expected, actual, kind,
    matched ? `${kind}_matched` : `${kind}_not_matched`);
}

function compareAttribute(payload, actualInput) {
  const name = firstDefined(payload.attributeName, payload.name);
  const comparator = String(payload.comparator || (payload.expectedValue === undefined ? 'present' : 'equals')).toLowerCase();
  if (typeof name !== 'string' || !name) return result(OUTCOMES.UNCHECKABLE, payload.expectedValue, actualInput, comparator, 'attribute_name_missing');
  if (!isObject(actualInput)) return result(OUTCOMES.UNCHECKABLE, payload.expectedValue, actualInput, comparator, 'attribute_actual_unavailable');
  const attributes = isObject(actualInput.attributes) ? actualInput.attributes : actualInput;
  const found = Object.prototype.hasOwnProperty.call(attributes, name)
    && attributes[name] !== null
    && attributes[name] !== undefined;
  if (comparator === 'present' || comparator === 'absent') {
    const matched = comparator === 'present' ? found : !found;
    return result(matched ? OUTCOMES.MATCHED : OUTCOMES.NOT_MATCHED, comparator === 'present', found, comparator,
      matched ? 'attribute_presence_matched' : 'attribute_presence_not_matched');
  }
  if (!found) return result(OUTCOMES.NOT_MATCHED, payload.expectedValue, undefined, comparator, 'attribute_not_found');
  return compareText(payload.expectedValue, attributes[name], comparator, payload);
}

function relationshipOperands(actualInput) {
  if (Array.isArray(actualInput)) return actualInput;
  if (isObject(actualInput) && Array.isArray(actualInput.operands)) return actualInput.operands;
  return [];
}

function relationshipValue(operand, temporal) {
  const value = isObject(operand) ? firstDefined(operand.value, operand.actual, operand.dateTime, operand.date, operand.time) : operand;
  if (temporal) return parseTemporal(value, 'date_time');
  const number = numericValue(value);
  if (number !== null) return number;
  return value == null ? null : normalizeText(value, { caseSensitive: true });
}

function compareRelationship(payload, actualInput, { temporal = false } = {}) {
  const operands = relationshipOperands(actualInput);
  const expectedOperands = Array.isArray(payload.operands) ? payload.operands : [];
  const comparator = String(payload.comparator || payload.relation || payload.operator || 'before').trim().toLowerCase();
  const expected = expectedOperands.map((operand, index) => ({
    name: operand && (operand.name || operand.ref || operand.label) || `operand_${index + 1}`,
    role: operand && operand.role || null,
  }));
  if (operands.length < 2) {
    return result(OUTCOMES.UNCHECKABLE, expected, operands, comparator, 'relationship_operands_missing');
  }
  const ambiguous = operands.find((operand) => operand && operand.status === 'ambiguous');
  if (ambiguous) return result(OUTCOMES.UNCHECKABLE, expected, operands, comparator, 'relationship_operand_ambiguous');
  const missing = operands.find((operand) => !operand || ['missing', 'unavailable', 'uncheckable'].includes(operand.status));
  if (missing) return result(OUTCOMES.UNCHECKABLE, expected, operands, comparator,
    missing?.status === 'missing' ? 'relationship_operand_missing' : 'relationship_operand_unavailable');
  const values = operands.map((operand) => relationshipValue(operand, temporal));
  if (values.some((value) => value === null)) {
    return result(OUTCOMES.UNCHECKABLE, expected, operands, comparator,
      temporal ? 'relationship_temporal_operand_invalid' : 'relationship_operand_invalid');
  }
  let predicate = null;
  if (['before', 'lt', 'ascending', 'chronological'].includes(comparator)) predicate = (left, right) => left < right;
  else if (['after', 'gt', 'descending'].includes(comparator)) predicate = (left, right) => left > right;
  else if (['on_or_before', 'lte', 'ascending_or_equal'].includes(comparator)) predicate = (left, right) => left <= right;
  else if (['on_or_after', 'gte', 'descending_or_equal'].includes(comparator)) predicate = (left, right) => left >= right;
  else if (['equals', 'eq'].includes(comparator)) predicate = (left, right) => left === right;
  else if (['not_equals', 'ne'].includes(comparator)) predicate = (left, right) => left !== right;
  if (!predicate) return result(OUTCOMES.UNCHECKABLE, expected, operands, comparator, 'relationship_comparator_unsupported');
  const matched = values.slice(0, -1).every((value, index) => predicate(value, values[index + 1]));
  return result(matched ? OUTCOMES.MATCHED : OUTCOMES.NOT_MATCHED, expected, operands, comparator,
    matched ? 'relationship_matched' : 'relationship_not_matched');
}

function countValue(actual) {
  if (Array.isArray(actual) || typeof actual === 'string') return actual.length;
  if (actual instanceof Set || actual instanceof Map) return actual.size;
  if (isObject(actual) && Number.isFinite(Number(actual.count))) return Number(actual.count);
  return numericValue(actual);
}

function compareTypedAssertion(assertion = {}, actualInput) {
  const type = String(assertion.type || assertion.kind || '').toUpperCase();
  const payload = isObject(assertion.payload) ? assertion.payload : assertion;
  if (assertion.parseFailed === true) {
    return result(OUTCOMES.UNCHECKABLE, payload, actualInput, null, assertion.parseFailedReason || assertion.parseIssue || 'declared_assertion_unparseable');
  }

  if (type === 'TEXT' || type === 'FORBIDDEN_TEXT') {
    const expected = firstDefined(payload.expectedText, payload.unexpectedText, payload.expectedValue, payload.expected);
    const comparator = type === 'FORBIDDEN_TEXT' ? 'not_contains' : payload.comparator || 'contains';
    return compareText(expected, textActual(actualInput), comparator, payload);
  }
  if (type === 'REGEX') return compareRegex(firstDefined(payload.expectedPattern, payload.pattern), textActual(actualInput), payload.flags);
  if (type === 'NUMBER') return compareNumber(firstDefined(payload.expectedNumber, payload.expectedValue, payload.expected), actualInput, payload.comparator, payload.tolerance);
  if (type === 'CURRENCY') return compareCurrency(payload, actualInput);
  if (type === 'DATE') return compareTemporal('date', payload, actualInput);
  if (type === 'TIME') return compareTemporal('time', payload, actualInput);
  if (type === 'DATE_TIME' || type === 'DATETIME') return compareTemporal('date_time', payload, actualInput);
  if (['RELATIONSHIP', 'ASSERTRELATIONSHIP'].includes(type)) return compareRelationship(payload, actualInput);
  if (['TEMPORAL_RELATIONSHIP', 'TEMPORALRELATIONSHIP', 'TEMPORALCOMPARISON', 'ASSERTTEMPORAL'].includes(type)) {
    return compareRelationship(payload, actualInput, { temporal: true });
  }
  if (type === 'URL') return compareUrl(payload, actualInput);
  if (type === 'VISIBLE') return compareBoolean('visible', true, actualInput);
  if (type === 'HIDDEN') return compareBoolean('visible', false, actualInput);
  if (type === 'ATTRIBUTE') return compareAttribute(payload, actualInput);
  if (type === 'VALUE') return compareText(firstDefined(payload.expectedValue, payload.expected),
    isObject(actualInput) ? firstDefined(actualInput.value, actualInput.actual) : actualInput, payload.comparator || 'equals', payload);
  if (type === 'SELECTED') return compareBoolean('selected', payload.expectedSelected !== false, actualInput);
  if (type === 'CHECKED') return compareBoolean('checked', payload.expectedChecked !== false, actualInput);
  if (type === 'COUNT') return compareNumber(firstDefined(payload.expectedCount, payload.expectedValue, payload.expected),
    countValue(actualInput), payload.comparator || 'equals', payload.tolerance);
  if (['TABLE', 'TABLE_ROW', 'TABLE_CELL', 'TABLE_COLUMN', 'TABLE_QUERY'].includes(type)) {
    const mode = type === 'TABLE' ? payload.mode || payload.tableMode : type.slice('TABLE_'.length).toLowerCase();
    return compareTableAssertion({ ...payload, mode }, actualInput);
  }
  if (type === 'COLLECTION' || type === 'COLLECTION_MEMBERSHIP') {
    const expected = firstDefined(payload.expectedMember, payload.expectedItems, payload.expectedValue, payload.expected);
    return compareCollectionMembership(expected, actualInput, payload.comparator || (Array.isArray(expected) ? 'contains_all' : 'contains'), payload);
  }
  return result(OUTCOMES.UNCHECKABLE, payload, actualInput, null, 'assertion_type_unsupported');
}

module.exports = {
  OUTCOMES,
  compareTypedAssertion,
  compareText,
  compareRegex,
  compareNumber,
  compareCurrency,
  compareTemporal,
  compareRelationship,
  compareUrl,
};
