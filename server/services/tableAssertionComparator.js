'use strict';

const OUTCOMES = Object.freeze({
  MATCHED: 'matched',
  NOT_MATCHED: 'not_matched',
  UNCHECKABLE: 'uncheckable',
});

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

function normalizeText(value, caseSensitive = false) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return caseSensitive ? text : text.toLocaleLowerCase('en-US');
}

function equivalent(actual, expected, { caseSensitive = false, partial = true } = {}) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || (!partial && actual.length !== expected.length)) return false;
    if (!partial) return expected.every((item, index) => equivalent(actual[index], item, { caseSensitive, partial }));
    return expected.every((item) => actual.some((candidate) => equivalent(candidate, item, { caseSensitive, partial })));
  }
  if (isObject(expected)) {
    if (!isObject(actual)) return false;
    const expectedKeys = Object.keys(expected);
    if (!partial && Object.keys(actual).length !== expectedKeys.length) return false;
    return expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(actual, key)
      && equivalent(actual[key], expected[key], { caseSensitive, partial }));
  }
  if (typeof actual === 'string' || typeof expected === 'string') {
    return normalizeText(actual, caseSensitive) === normalizeText(expected, caseSensitive);
  }
  return Object.is(actual, expected);
}

function collectionOf(value) {
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return [...value];
  if (isObject(value) && Array.isArray(value.items)) return value.items;
  return null;
}

function compareCollectionMembership(expected, actual, comparator = 'contains', options = {}) {
  const items = collectionOf(actual);
  const op = String(comparator || 'contains').toLowerCase();
  if (!items) return result(OUTCOMES.UNCHECKABLE, expected, actual, op, 'collection_actual_unavailable');
  if (expected === undefined) return result(OUTCOMES.UNCHECKABLE, expected, items, op, 'collection_expected_missing');

  const matchesMember = (wanted) => items.some((item) => equivalent(item, wanted, options));
  let matched;
  if (op === 'contains' || op === 'member') {
    matched = matchesMember(expected);
  } else if (op === 'not_contains' || op === 'not_member') {
    matched = !matchesMember(expected);
  } else if (op === 'contains_all') {
    if (!Array.isArray(expected)) return result(OUTCOMES.UNCHECKABLE, expected, items, op, 'collection_expected_array_required');
    matched = expected.every(matchesMember);
  } else if (op === 'contains_any') {
    if (!Array.isArray(expected)) return result(OUTCOMES.UNCHECKABLE, expected, items, op, 'collection_expected_array_required');
    matched = expected.some(matchesMember);
  } else if (op === 'exact' || op === 'ordered_equals') {
    matched = equivalent(items, expected, { ...options, partial: false });
  } else if (op === 'unordered_equals') {
    if (!Array.isArray(expected)) return result(OUTCOMES.UNCHECKABLE, expected, items, op, 'collection_expected_array_required');
    const remaining = [...items];
    matched = remaining.length === expected.length && expected.every((wanted) => {
      const index = remaining.findIndex((item) => equivalent(item, wanted, { ...options, partial: false }));
      if (index < 0) return false;
      remaining.splice(index, 1);
      return true;
    });
  } else {
    return result(OUTCOMES.UNCHECKABLE, expected, items, op, 'collection_comparator_unsupported');
  }
  return result(
    matched ? OUTCOMES.MATCHED : OUTCOMES.NOT_MATCHED,
    expected,
    items,
    op,
    matched ? 'collection_membership_matched' : 'collection_membership_not_matched',
  );
}

function normalizeTable(actual) {
  const rows = Array.isArray(actual) ? actual : isObject(actual) && Array.isArray(actual.rows) ? actual.rows : null;
  if (!rows) return null;
  const headers = isObject(actual)
    ? (Array.isArray(actual.columns) ? actual.columns : Array.isArray(actual.headers) ? actual.headers : [])
    : [];
  const normalizedRows = rows.map((row) => {
    if (!Array.isArray(row) || !headers.length) return row;
    return Object.fromEntries(headers.map((header, index) => [String(header), row[index]]));
  });
  return { rows: normalizedRows, headers };
}

function readColumn(row, column) {
  if (typeof column === 'number' && Array.isArray(row)) {
    return column >= 0 && column < row.length ? { found: true, value: row[column] } : { found: false };
  }
  if (!isObject(row)) return { found: false };
  if (Object.prototype.hasOwnProperty.call(row, column)) return { found: true, value: row[column] };
  const wanted = normalizeText(column);
  const key = Object.keys(row).find((candidate) => normalizeText(candidate) === wanted);
  return key == null ? { found: false } : { found: true, value: row[key] };
}

function rowMatches(row, expectedRow, options = {}) {
  if (isObject(expectedRow)) {
    return Object.entries(expectedRow).every(([column, expected]) => {
      const cell = readColumn(row, column);
      return cell.found && equivalent(cell.value, expected, options);
    });
  }
  if (Array.isArray(expectedRow)) return equivalent(row, expectedRow, { ...options, partial: false });
  const rowText = isObject(row) ? Object.values(row).join(' ') : Array.isArray(row) ? row.join(' ') : row;
  return normalizeText(rowText, options.caseSensitive) === normalizeText(expectedRow, options.caseSensitive)
    || normalizeText(rowText, options.caseSensitive).includes(normalizeText(expectedRow, options.caseSensitive));
}

function rowsMatchingWhere(rows, where, options = {}) {
  if (!isObject(where) || !Object.keys(where).length) return rows;
  return rows.filter((row) => rowMatches(row, where, options));
}

function compareCellValue(actual, expected, comparator, options = {}) {
  const op = String(comparator || 'equals').toLowerCase();
  if (op === 'equals' || op === 'eq') return { valid: true, matched: equivalent(actual, expected, options) };
  if (op === 'not_equals' || op === 'ne') return { valid: true, matched: !equivalent(actual, expected, options) };
  const actualText = normalizeText(actual, options.caseSensitive);
  const expectedText = normalizeText(expected, options.caseSensitive);
  if (op === 'contains') return { valid: true, matched: actualText.includes(expectedText) };
  if (op === 'not_contains') return { valid: true, matched: !actualText.includes(expectedText) };
  if (op === 'starts_with') return { valid: true, matched: actualText.startsWith(expectedText) };
  if (op === 'ends_with') return { valid: true, matched: actualText.endsWith(expectedText) };
  if (op === 'regex') {
    try { return { valid: true, matched: new RegExp(String(expected), options.flags || '').test(String(actual)) }; }
    catch (_) { return { valid: false, reason: 'table_regex_invalid' }; }
  }
  const actualNumber = Number(actual);
  const expectedNumber = Number(expected);
  if (Number.isFinite(actualNumber) && Number.isFinite(expectedNumber)) {
    if (op === 'gt') return { valid: true, matched: actualNumber > expectedNumber };
    if (op === 'gte') return { valid: true, matched: actualNumber >= expectedNumber };
    if (op === 'lt') return { valid: true, matched: actualNumber < expectedNumber };
    if (op === 'lte') return { valid: true, matched: actualNumber <= expectedNumber };
  }
  return { valid: false, reason: 'table_comparator_unsupported' };
}

function compareTableAssertion(payload = {}, actual) {
  const table = normalizeTable(actual);
  const mode = String(payload.mode || payload.tableMode || payload.operation || '').toLowerCase();
  if (!table) return result(OUTCOMES.UNCHECKABLE, payload, actual, mode || null, 'table_actual_unavailable');
  if (!mode) return result(OUTCOMES.UNCHECKABLE, payload, table.rows, null, 'table_mode_missing');
  const options = { caseSensitive: payload.caseSensitive === true, flags: payload.flags };

  if (mode === 'row') {
    const expectedRow = payload.expectedRow !== undefined ? payload.expectedRow : payload.row;
    const comparator = String(payload.comparator || 'contains').toLowerCase();
    if (expectedRow === undefined) return result(OUTCOMES.UNCHECKABLE, expectedRow, table.rows, comparator, 'table_expected_row_missing');
    const selected = Number.isInteger(payload.rowIndex) ? table.rows[payload.rowIndex] : undefined;
    const found = selected !== undefined ? rowMatches(selected, expectedRow, options) : table.rows.some((row) => rowMatches(row, expectedRow, options));
    const matched = comparator === 'not_contains' ? !found : found;
    return result(matched ? OUTCOMES.MATCHED : OUTCOMES.NOT_MATCHED, expectedRow, table.rows, comparator,
      matched ? 'table_row_matched' : 'table_row_not_matched');
  }

  if (mode === 'cell') {
    const column = payload.column !== undefined ? payload.column : payload.columnName;
    const expected = payload.expectedValue !== undefined ? payload.expectedValue : payload.expected;
    const comparator = String(payload.comparator || 'equals').toLowerCase();
    if (column === undefined || expected === undefined) {
      return result(OUTCOMES.UNCHECKABLE, expected, table.rows, comparator, 'table_cell_contract_incomplete');
    }
    const candidates = Number.isInteger(payload.rowIndex)
      ? (table.rows[payload.rowIndex] === undefined ? [] : [table.rows[payload.rowIndex]])
      : rowsMatchingWhere(table.rows, payload.where, options);
    if (!candidates.length) return result(OUTCOMES.NOT_MATCHED, expected, null, comparator, 'table_query_row_not_found');
    const cell = readColumn(candidates[0], column);
    if (!cell.found) return result(OUTCOMES.NOT_MATCHED, expected, undefined, comparator, 'table_column_not_found');
    const compared = compareCellValue(cell.value, expected, comparator, options);
    if (!compared.valid) return result(OUTCOMES.UNCHECKABLE, expected, cell.value, comparator, compared.reason);
    return result(compared.matched ? OUTCOMES.MATCHED : OUTCOMES.NOT_MATCHED, expected, cell.value, comparator,
      compared.matched ? 'table_cell_matched' : 'table_cell_not_matched');
  }

  if (mode === 'column') {
    const column = payload.column !== undefined ? payload.column : payload.columnName;
    const expected = payload.expectedValues !== undefined ? payload.expectedValues
      : payload.expectedValue !== undefined ? payload.expectedValue : payload.expected;
    const comparator = String(payload.comparator || (Array.isArray(expected) ? 'contains_all' : 'contains')).toLowerCase();
    if (column === undefined || expected === undefined) {
      return result(OUTCOMES.UNCHECKABLE, expected, table.rows, comparator, 'table_column_contract_incomplete');
    }
    const cells = table.rows.map((row) => readColumn(row, column));
    if (!cells.some((cell) => cell.found)) return result(OUTCOMES.NOT_MATCHED, expected, [], comparator, 'table_column_not_found');
    return compareCollectionMembership(expected, cells.filter((cell) => cell.found).map((cell) => cell.value), comparator, options);
  }

  if (mode === 'query') {
    if (!isObject(payload.where) || !Object.keys(payload.where).length) {
      return result(OUTCOMES.UNCHECKABLE, payload.where, table.rows, 'query', 'table_query_missing');
    }
    const selected = rowsMatchingWhere(table.rows, payload.where, options);
    if (payload.expectedCount !== undefined) {
      const compared = compareCellValue(selected.length, payload.expectedCount, payload.countComparator || 'equals', options);
      if (!compared.valid) return result(OUTCOMES.UNCHECKABLE, payload.expectedCount, selected.length, payload.countComparator || 'equals', compared.reason);
      return result(compared.matched ? OUTCOMES.MATCHED : OUTCOMES.NOT_MATCHED, payload.expectedCount, selected.length,
        payload.countComparator || 'equals', compared.matched ? 'table_query_count_matched' : 'table_query_count_not_matched');
    }
    const exists = payload.exists !== false;
    const matched = exists ? selected.length > 0 : selected.length === 0;
    return result(matched ? OUTCOMES.MATCHED : OUTCOMES.NOT_MATCHED, { where: payload.where, exists }, selected, 'query',
      matched ? 'table_query_matched' : 'table_query_not_matched');
  }

  return result(OUTCOMES.UNCHECKABLE, payload, table.rows, mode, 'table_mode_unsupported');
}

module.exports = {
  OUTCOMES,
  compareCollectionMembership,
  compareTableAssertion,
  normalizeTable,
};
