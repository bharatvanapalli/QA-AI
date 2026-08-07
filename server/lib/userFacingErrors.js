'use strict';

const DOCUMENT_FORMATS = 'PDF, DOCX, Markdown, HTML, JSON, CSV, or plain text';
const TEST_DATA_FORMATS = 'XLSX, XLS, CSV, TSV, or plain text';

function splitFilePrefix(message) {
  const text = String(message == null ? '' : message).replace(/\s+/g, ' ').trim();
  const match = text.match(/^([^:\r\n]{1,240}\.(?:pdf|docx|xlsx|xlsm|xls|csv|tsv|txt|md|markdown|html?|json|png|jpe?g|webp|gif|log)):\s*(.+)$/i);
  if (!match) return { prefix: '', body: text };
  return { prefix: `${match[1]}: `, body: match[2] };
}

function supportedFormatsFor(area) {
  return area === 'test-data' ? TEST_DATA_FORMATS : DOCUMENT_FORMATS;
}

function sanitizeBody(body, { area = 'general' } = {}) {
  const text = String(body == null ? '' : body).replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  const formats = supportedFormatsFor(area);

  if (!text) return 'Something went wrong. Please try again.';

  if (
    /prisma|p20\d{2}|unique constraint|foreign key|constraint failed|database|sqlite|postgres|sql\b|queryraw/i.test(text)
  ) {
    return 'The request could not be saved. Please retry; if it continues, contact support.';
  }

  if (
    /docx parse failed|mammoth|could not find main document part|valid \.docx|end of central directory|corrupt(ed)? zip|zip file/i.test(text)
  ) {
    return 'This Word document could not be read. Re-save it as a standard .docx file or upload the Markdown/PDF version.';
  }

  if (/pdf parse failed|pdf-parse|invalid pdf|bad xref|bad end offset/i.test(text)) {
    return 'This PDF could not be read. Re-export it as a text-based PDF or upload a Markdown/DOCX version.';
  }

  if (/workbook parse failed|sheetjs|xlsx parse failed|excel parse failed/i.test(text)) {
    return 'This spreadsheet could not be read. Re-save it as a standard XLSX file or upload CSV.';
  }

  if (/no extractable text|has no extractable text|yielded no extractable text|no readable content/i.test(text)) {
    return area === 'test-data'
      ? 'No readable rows were found. Upload a spreadsheet or CSV with a header row.'
      : 'No readable text was found. Upload a text-based document instead of a scanned, protected, or empty file.';
  }

  if (/binary|mojibake|not readable text/i.test(text)) {
    return `This file is not readable as text. Upload one of these formats: ${formats}.`;
  }

  const unsupported = text.match(/unsupported (?:document |test-data )?format\s+"?([^";]+)"?/i);
  if (unsupported) {
    return `Unsupported file format "${unsupported[1]}". Upload one of these formats: ${formats}.`;
  }

  if (/must be sent as .*data url/i.test(text)) {
    return 'The upload payload was incomplete. Please try uploading the file again.';
  }

  if (/cannot read properties of|null|undefined|stack trace|typeerror|referenceerror|syntaxerror/i.test(text)) {
    return 'This operation could not finish cleanly. Please retry; if it continues, contact support.';
  }

  return text;
}

function sanitizeUserMessage(message, opts = {}) {
  const { prefix, body } = splitFilePrefix(message);
  return `${prefix}${sanitizeBody(body, opts)}`;
}

function sanitizeWarningList(warnings, opts = {}) {
  return (Array.isArray(warnings) ? warnings : [])
    .map((w) => sanitizeUserMessage(w, opts))
    .filter(Boolean);
}

function sanitizeDegradations(records, opts = {}) {
  return (Array.isArray(records) ? records : []).map((record) => ({
    ...record,
    reason: sanitizeUserMessage(record && record.reason, opts),
    impact: record && record.impact
      ? sanitizeUserMessage(record.impact, opts)
      : '',
  }));
}

module.exports = {
  sanitizeUserMessage,
  sanitizeWarningList,
  sanitizeDegradations,
};
