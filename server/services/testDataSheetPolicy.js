'use strict';

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function norm(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function sheetHeaders(sheet) {
  const explicit = Array.isArray(sheet && sheet.headers) ? sheet.headers : [];
  const inferred = !explicit.length && Array.isArray(sheet && sheet.rows)
    ? sheet.rows.find((row) => row && typeof row === 'object' && !Array.isArray(row))
    : null;
  return Array.from(new Set((explicit.length ? explicit : Object.keys(inferred || {}))
    .map((header) => clean(header))
    .filter((header) => header && !header.startsWith('__'))));
}

function usableRowsForSheet(sheet, requiredHeaders = []) {
  const headers = sheetHeaders(sheet);
  if (!headers.length) return [];
  const headerLookup = new Map(headers.map((header) => [norm(header), header]));
  const required = (Array.isArray(requiredHeaders) ? requiredHeaders : [])
    .map((header) => headerLookup.get(norm(header)))
    .filter(Boolean);
  if (requiredHeaders.length && required.length !== requiredHeaders.length) return [];
  const selected = required.length ? required : headers;
  return (Array.isArray(sheet && sheet.rows) ? sheet.rows : []).filter((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
    return selected.some((header) => clean(row[header]) !== '');
  });
}

function analyzeSheetUsability(sheet, requiredHeaders = []) {
  const headers = sheetHeaders(sheet);
  const rows = usableRowsForSheet(sheet, requiredHeaders);
  let reason = null;
  if (!headers.length) reason = 'sheet_headers_missing';
  else if (requiredHeaders.length && requiredHeaders.some((header) => !headers.some((candidate) => norm(candidate) === norm(header)))) reason = 'mapped_column_missing';
  else if (!rows.length) reason = requiredHeaders.length ? 'mapped_rows_empty' : 'sheet_rows_empty';
  return {
    usable: !reason,
    reason,
    headers,
    rows,
    sourceRowCount: Array.isArray(sheet && sheet.rows) ? sheet.rows.length : 0,
    usableRowCount: rows.length,
  };
}

const NON_EXECUTABLE_NAME_RE = /^(read\s*me|readme|instructions?|guide|legend|schema|data\s*dictionary|metadata|meta|about|notes?)$/i;
const NON_EXECUTABLE_TOKEN_RE = /\b(read\s*me|readme|instruction|guide|legend|data\s*dictionary|metadata|about\s+this\s+(file|workbook|sheet))\b/i;

const EXECUTABLE_HEADER_HINTS = new Set([
  'username', 'user', 'userid', 'login', 'loginid', 'password', 'pwd', 'secret',
  'role', 'userrole', 'authrole', 'status', 'employmentstatus', 'expected',
  'expectedresult', 'expectedoutcome', 'expectedmessage', 'result', 'outcome',
  'error', 'errormessage', 'validationmessage', 'firstname', 'lastname',
  'fullname', 'employeename', 'employeeid', 'email', 'search', 'searchterm',
  'query', 'fromdate', 'todate', 'date', 'type', 'casetype', 'testtype',
  'rowclass', 'validity', 'positive', 'negative',
]);

const DOC_ONLY_HEADER_HINTS = new Set([
  'field', 'fields', 'column', 'columns', 'description', 'details', 'instruction',
  'instructions', 'note', 'notes', 'comment', 'comments', 'example', 'examples',
  'meaning', 'purpose', 'owner', 'version',
]);

function sheetText(sheet) {
  const headers = Array.isArray(sheet && sheet.headers) ? sheet.headers.join(' ') : '';
  const rows = Array.isArray(sheet && sheet.rows) ? sheet.rows.slice(0, 4) : [];
  const rowText = rows.flatMap((row) => Object.values(row || {})).join(' ');
  return `${sheet && sheet.name ? sheet.name : ''} ${headers} ${rowText}`;
}

function hasExecutableHeaderSignal(sheet) {
  return analyzeSheetUsability(sheet).usable && !hasOnlyDocHeaders(sheet);
}

function hasOnlyDocHeaders(sheet) {
  const headers = Array.isArray(sheet && sheet.headers) ? sheet.headers.filter(Boolean) : [];
  if (!headers.length) return true;
  return headers.every((header) => DOC_ONLY_HEADER_HINTS.has(norm(header)));
}

function isNonExecutableSheet(sheet) {
  const name = clean(sheet && sheet.name);
  if (!name) return false;
  if (NON_EXECUTABLE_NAME_RE.test(name)) return true;
  if (NON_EXECUTABLE_TOKEN_RE.test(name) && !hasExecutableHeaderSignal(sheet)) return true;
  if (NON_EXECUTABLE_TOKEN_RE.test(sheetText(sheet)) && hasOnlyDocHeaders(sheet)) return true;
  return false;
}

function filterExecutableSheets(sheets) {
  const executable = [];
  const ignored = [];
  for (const sheet of Array.isArray(sheets) ? sheets : []) {
    const usability = analyzeSheetUsability(sheet);
    if (!usability.usable || isNonExecutableSheet(sheet)) {
      ignored.push({
        sheet: sheet && sheet.name ? sheet.name : null,
        reason: usability.reason || 'non_executable_workbook_metadata',
      });
    } else {
      executable.push(sheet);
    }
  }
  return { executable, ignored };
}

module.exports = {
  clean,
  norm,
  isNonExecutableSheet,
  filterExecutableSheets,
  sheetHeaders,
  usableRowsForSheet,
  analyzeSheetUsability,
};
