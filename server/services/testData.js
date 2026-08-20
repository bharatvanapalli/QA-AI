'use strict';

const crypto = require('crypto');

const MAX_SHEETS = 50;
const MAX_COLUMNS = 200;
const MAX_ROWS = 5000;
const MAX_CELL_CHARS = 4000;
const PARSER_VERSION = 'test-data-parser-v2';

let _xlsx = null;
function sheetJs() {
  if (_xlsx !== null) return _xlsx;
  try {
    _xlsx = require('xlsx');
  } catch (_) {
    _xlsx = false;
  }
  return _xlsx;
}

function decodeDataUrl(s) {
  if (typeof s !== 'string' || !s.startsWith('data:')) return null;
  const m = s.match(/^data:([^;,]+)?(?:;[^,]*)?,(.*)$/);
  if (!m) return null;
  const mime = (m[1] || '').toLowerCase();
  const data = m[2] || '';
  if (/;base64/i.test(s)) {
    try {
      return { buffer: Buffer.from(data, 'base64'), mime };
    } catch (_) {
      return null;
    }
  }
  try {
    return { buffer: Buffer.from(decodeURIComponent(data), 'utf8'), mime };
  } catch (_) {
    return null;
  }
}

function decodeContent(content) {
  if (Buffer.isBuffer(content)) return { buffer: content, text: content.toString('utf8'), mime: '' };
  const raw = String(content == null ? '' : content);
  const dataUrl = decodeDataUrl(raw);
  if (dataUrl) return { ...dataUrl, text: dataUrl.buffer.toString('utf8') };
  return { buffer: Buffer.from(raw, 'utf8'), text: raw, mime: '' };
}

function extOf(name) {
  const s = String(name || '').toLowerCase();
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i + 1) : '';
}

function baseName(name, fallback = 'Test Data') {
  const raw = String(name || '').trim();
  if (!raw) return fallback;
  return raw.replace(/\.[^.]+$/, '') || raw;
}

function isWorkbook({ name, mimeType, mime }) {
  const mt = String(mimeType || mime || '').toLowerCase();
  return (
    mt.includes('spreadsheet') ||
    mt.includes('excel') ||
    mt.includes('application/vnd.ms-excel') ||
    ['xlsx', 'xlsm', 'xls'].includes(extOf(name))
  );
}

function isCsv({ name, mimeType, mime }) {
  const mt = String(mimeType || mime || '').toLowerCase();
  return mt.includes('csv') || extOf(name) === 'csv';
}

function isJson({ name, mimeType, mime }) {
  const mt = String(mimeType || mime || '').toLowerCase();
  return mt.includes('json') || extOf(name) === 'json';
}

function cleanCell(value) {
  if (value == null) return '';
  return String(value)
    .replace(/\u0000/g, '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CELL_CHARS);
}

function makeHeaders(row, sheetName, warnings) {
  const headers = [];
  const indexes = [];
  const seen = new Map();
  const cells = Array.isArray(row) ? row : [];
  const capped = Math.min(cells.length, MAX_COLUMNS);
  let blankColumns = 0;
  let duplicateColumns = 0;

  for (let i = 0; i < capped; i += 1) {
    const header = cleanCell(cells[i]);
    if (!header) {
      blankColumns += 1;
      continue;
    }
    const key = header.toLowerCase();
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    headers.push(count ? `${header} ${count + 1}` : header);
    indexes.push(i);
    if (count) duplicateColumns += 1;
  }

  if (cells.length > MAX_COLUMNS) {
    warnings.push(`${sheetName}: truncated columns from ${cells.length} to ${MAX_COLUMNS}`);
  }
  if (blankColumns) warnings.push(`${sheetName}: ignored ${blankColumns} blank header column(s)`);
  if (duplicateColumns) warnings.push(`${sheetName}: renamed ${duplicateColumns} duplicate header column(s)`);

  return { headers, indexes };
}

function matrixToSheet(name, matrix, warnings, rowBudget) {
  const sheetName = cleanCell(name) || 'Sheet';
  const rows = Array.isArray(matrix) ? matrix : [];
  if (!rows.length || !rows.some((r) => Array.isArray(r) && r.some((c) => cleanCell(c)))) {
    warnings.push(`${sheetName}: empty sheet`);
    return { sheet: { name: sheetName, headers: [], rows: [] }, consumed: 0, capped: false };
  }

  const { headers, indexes } = makeHeaders(rows[0] || [], sheetName, warnings);
  if (!headers.length) {
    warnings.push(`${sheetName}: no usable headers`);
    return { sheet: { name: sheetName, headers: [], rows: [] }, consumed: 0, capped: false };
  }

  const out = [];
  let capped = false;
  for (let r = 1; r < rows.length; r += 1) {
    if (out.length >= rowBudget) {
      capped = true;
      break;
    }
    const src = Array.isArray(rows[r]) ? rows[r] : [];
    const obj = {};
    let hasValue = false;
    for (let i = 0; i < headers.length; i += 1) {
      const value = cleanCell(src[indexes[i]]);
      obj[headers[i]] = value;
      if (value) hasValue = true;
    }
    if (hasValue) out.push(obj);
  }

  if (capped) warnings.push(`${sheetName}: row limit reached at ${rowBudget} row(s)`);
  return { sheet: { name: sheetName, headers, rows: out }, consumed: out.length, capped };
}

function parseCsvRows(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const input = String(text || '').replace(/^\uFEFF/, '');

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }

  if (cell || row.length || input.endsWith(delimiter)) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function delimiterFor({ name, mimeType, text } = {}) {
  if (extOf(name) === 'tsv' || /tab-separated/i.test(String(mimeType || ''))) return '\t';
  const firstLine = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).find((line) => line.trim()) || '';
  if (!firstLine) return ',';
  const counts = [',', '\t', ';'].map((delimiter) => ({
    delimiter,
    count: firstLine.split(delimiter).length - 1,
  })).sort((a, b) => b.count - a.count);
  return counts[0].count > 0 ? counts[0].delimiter : ',';
}

function parserManifest({
  sourceHash = null,
  sourceSheetCount = 0,
  parsedSheetCount = 0,
  sourceRowCount = null,
  parsedRowCount = 0,
  sourceColumnCounts = [],
  truncations = [],
} = {}) {
  return {
    parserVersion: PARSER_VERSION,
    sourceHash,
    sourceSheetCount,
    parsedSheetCount,
    sourceRowCount,
    parsedRowCount,
    sourceColumnCounts,
    truncations,
    complete: truncations.length === 0,
    limits: {
      maxSheets: MAX_SHEETS,
      maxColumns: MAX_COLUMNS,
      maxRows: MAX_ROWS,
      maxCellChars: MAX_CELL_CHARS,
    },
  };
}

function parseWorkbook({ content, name, mimeType } = {}) {
  const warnings = [];
  if (content == null) {
    return {
      sheets: [],
      rowCount: 0,
      warnings: ['No test data content provided'],
      sourceHash: null,
      parserManifest: parserManifest({ truncations: [{ kind: 'missing_source', reason: 'No test data content provided' }] }),
    };
  }

  const decoded = decodeContent(content);
  const meta = { name, mimeType, mime: decoded.mime };
  const sheets = [];
  let rowCount = 0;
  const sourceHash = crypto.createHash('sha256').update(decoded.buffer).digest('hex');
  const truncations = [];
  const sourceColumnCounts = [];
  let sourceSheetCount = 1;
  let sourceRowCount = 0;

  if (isWorkbook(meta) && !isCsv(meta)) {
    const xlsx = sheetJs();
    if (!xlsx) {
      return {
        sheets: [],
        rowCount: 0,
        warnings: ['SheetJS xlsx package is not installed; cannot parse workbook files'],
        sourceHash,
        parserManifest: parserManifest({
          sourceHash,
          truncations: [{ kind: 'parser_unavailable', reason: 'SheetJS xlsx package is not installed' }],
        }),
      };
    }

    try {
      const wb = xlsx.read(decoded.buffer, { type: 'buffer', cellDates: false, raw: false });
      sourceSheetCount = (wb.SheetNames || []).length;
      const names = (wb.SheetNames || []).slice(0, MAX_SHEETS);
      if ((wb.SheetNames || []).length > MAX_SHEETS) {
        warnings.push(`Workbook truncated from ${wb.SheetNames.length} to ${MAX_SHEETS} sheets`);
        truncations.push({ kind: 'sheet_limit', sourceCount: wb.SheetNames.length, parsedCount: MAX_SHEETS });
      }
      for (let sheetIndex = 0; sheetIndex < names.length; sheetIndex += 1) {
        const sheetName = names[sheetIndex];
        const matrix = xlsx.utils.sheet_to_json(wb.Sheets[sheetName], {
          header: 1,
          raw: false,
          defval: '',
          blankrows: false,
        });
        const rawRowCount = Math.max(0, matrix.length - 1);
        const rawColumnCount = Array.isArray(matrix[0]) ? matrix[0].length : 0;
        sourceRowCount += rawRowCount;
        sourceColumnCounts.push({ sheet: String(sheetName), sourceCount: rawColumnCount, parsedCount: Math.min(rawColumnCount, MAX_COLUMNS) });
        if (rawColumnCount > MAX_COLUMNS) {
          truncations.push({ kind: 'column_limit', sheet: String(sheetName), sourceCount: rawColumnCount, parsedCount: MAX_COLUMNS });
        }
        const parsed = matrixToSheet(sheetName, matrix, warnings, MAX_ROWS - rowCount);
        sheets.push(parsed.sheet);
        rowCount += parsed.consumed;
        if (parsed.capped || rowCount >= MAX_ROWS) {
          if (parsed.capped || sheetIndex < names.length - 1) {
            truncations.push({ kind: 'row_limit', sheet: String(sheetName), sourceCount: rawRowCount, parsedCount: parsed.consumed, globalParsedCount: rowCount });
          }
          break;
        }
      }
    } catch (err) {
      warnings.push(`Workbook parse failed: ${err.message}`);
      truncations.push({ kind: 'parse_error', reason: err.message });
    }
    return {
      sheets,
      rowCount,
      warnings,
      sourceHash,
      parserManifest: parserManifest({
        sourceHash,
        sourceSheetCount,
        parsedSheetCount: sheets.length,
        sourceRowCount,
        parsedRowCount: rowCount,
        sourceColumnCounts,
        truncations,
      }),
    };
  }

  if (isJson(meta)) {
    try {
      const data = JSON.parse(decoded.text);
      let arr = data;
      if (!Array.isArray(data)) {
        const keys = Object.keys(data);
        if (keys.length === 1 && Array.isArray(data[keys[0]])) {
           arr = data[keys[0]];
        } else {
           arr = [data]; // single flat object
        }
      }
      
      const matrix = [];
      let headers = [];
      for (const obj of arr) {
         if (obj && typeof obj === 'object') {
            for (const key of Object.keys(obj)) {
               if (!headers.includes(key)) headers.push(key);
            }
         }
      }
      matrix.push(headers);
      for (const obj of arr) {
         if (obj && typeof obj === 'object') {
            const row = headers.map(h => obj[h] !== undefined ? (typeof obj[h] === 'object' ? JSON.stringify(obj[h]) : obj[h]) : '');
            matrix.push(row);
         }
      }
      
      const rawColumnCount = headers.length;
      sourceRowCount = Math.max(0, matrix.length - 1);
      sourceColumnCounts.push({ sheet: baseName(name, 'JSON'), sourceCount: rawColumnCount, parsedCount: Math.min(rawColumnCount, MAX_COLUMNS) });
      if (rawColumnCount > MAX_COLUMNS) {
        truncations.push({ kind: 'column_limit', sheet: baseName(name, 'JSON'), sourceCount: rawColumnCount, parsedCount: MAX_COLUMNS });
      }
      const parsed = matrixToSheet(baseName(name, 'JSON'), matrix, warnings, MAX_ROWS);
      sheets.push(parsed.sheet);
      rowCount += parsed.consumed;
      if (parsed.capped) truncations.push({ kind: 'row_limit', sheet: parsed.sheet.name, sourceCount: sourceRowCount, parsedCount: parsed.consumed });
      
    } catch (err) {
      warnings.push(`JSON parse failed: ${err.message}`);
      truncations.push({ kind: 'parse_error', reason: err.message });
    }
    
    return {
      sheets,
      rowCount,
      warnings,
      sourceHash,
      parserManifest: parserManifest({
        sourceHash,
        sourceSheetCount: 1,
        parsedSheetCount: sheets.length,
        sourceRowCount,
        parsedRowCount: rowCount,
        sourceColumnCounts,
        truncations,
      }),
    };
  }

  if (!isCsv(meta) && /\u0000/.test(decoded.text)) {
    warnings.push('Input does not look like CSV text; treating it as CSV fallback');
  }

  const delimiter = delimiterFor({ name, mimeType, text: decoded.text });
  const matrix = parseCsvRows(decoded.text, delimiter);
  sourceRowCount = Math.max(0, matrix.length - 1);
  const rawColumnCount = Array.isArray(matrix[0]) ? matrix[0].length : 0;
  sourceColumnCounts.push({ sheet: baseName(name, 'CSV'), sourceCount: rawColumnCount, parsedCount: Math.min(rawColumnCount, MAX_COLUMNS) });
  if (rawColumnCount > MAX_COLUMNS) {
    truncations.push({ kind: 'column_limit', sheet: baseName(name, 'CSV'), sourceCount: rawColumnCount, parsedCount: MAX_COLUMNS });
  }
  const parsed = matrixToSheet(baseName(name, 'CSV'), matrix, warnings, MAX_ROWS);
  sheets.push(parsed.sheet);
  rowCount += parsed.consumed;
  if (parsed.capped) truncations.push({ kind: 'row_limit', sheet: parsed.sheet.name, sourceCount: sourceRowCount, parsedCount: parsed.consumed });
  return {
    sheets,
    rowCount,
    warnings,
    sourceHash,
    parserManifest: parserManifest({
      sourceHash,
      sourceSheetCount: 1,
      parsedSheetCount: sheets.length,
      sourceRowCount,
      parsedRowCount: rowCount,
      sourceColumnCounts,
      truncations,
    }),
  };
}

module.exports = {
  PARSER_VERSION,
  parseWorkbook,
  parseCsvRows,
  _internals: { cleanCell, decodeContent, makeHeaders, matrixToSheet, delimiterFor, parserManifest },
};
