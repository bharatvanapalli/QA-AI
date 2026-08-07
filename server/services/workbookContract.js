'use strict';

/**
 * Step 3A — the canonical WorkbookContract (data-oracle source).
 *
 * Today the workbook is read by divergent heuristic mappers (testDataUnderstanding
 * + dataMapper) that truncate at MAX_SHEETS, classify sheet purpose by AUTH_RE
 * keyword (so a navigation sheet becomes auth_profiles), pick ONE expectedColumn,
 * and don't recognise row intent — guessing where they should declare. This module
 * is the ONE deterministic contract every mapping/planning/generation path reads:
 *
 *   buildWorkbookContract({ sheets, ... }) → {
 *     schemaVersion, sourceId, sourceName, fileHash, generatedAt,
 *     sheetCount, rowCount, certification, confidence,
 *     sheets: [ SheetManifest ],   // EVERY sheet — no truncation
 *     findings: [ ... ],           // declared problems, never silent guesses
 *   }
 *
 * Generic + deterministic — keyed off header word-shape + STRUCTURAL column
 * presence, NEVER a site/sheet-name string. Pure (no DB / LLM / IO) so it is
 * guarded directly and reproducible for reports/regeneration/audit.
 *
 * Design rules locked with the reviewer:
 *   - No MAX_SHEETS truncation — every sheet is in the manifest.
 *   - storyId is the primary join key (extracted per row).
 *   - Row intent/outcome from caseIntent/intent/scenarioType/variant/testType/
 *     validity/polarity/outcomeClass/rowClass.
 *   - STRUCTURAL sheet purpose: auth_profiles ONLY when real credential-identity
 *     columns exist (a username/email AND a password/secret column). A profileKey
 *     column is an execution-identity reference, NOT auth. A URL value/column
 *     (e.g. /auth/login) never makes a sheet auth.
 *   - expectedColumns BY ORACLE TYPE (success/url/visibleSignal/validation/error/
 *     toast/absence/...), preserving MULTIPLE expected columns — not one.
 *   - Declare findings instead of guessing.
 */

const crypto = require('crypto');
const { analyzeSheetUsability } = require('./testDataSheetPolicy');

const SCHEMA_VERSION = 'wbc-1';

// ── Header word-shape detectors (generic; matched on a normalized header) ─────
const norm = (h) => String(h == null ? '' : h).toLowerCase().replace(/[\s_\-./]+/g, ' ').trim();
const compact = (h) => norm(h).replace(/\s+/g, '');

// storyId: the primary join. Matches "storyId", "story_id", "US ID", "reqId",
// "requirement id", "ticket id", "jira", "ado id" — never bare "id" (too generic).
const STORY_ID_RE = /^(user ?story|story|us|req|requirement|epic|ticket|jira|ado|backlog|feature)( ?id)?$/i;
function isStoryIdHeader(h) {
  const n = norm(h);
  if (/(story|requirement|backlog|epic|feature|ticket|jira|ado)[a-z ]*id\b/.test(n)) return true;
  if (/\b(usid|reqid|storyid|featureid)\b/.test(compact(h) ? n.replace(/\s+/g, '') : n)) return true;
  return STORY_ID_RE.test(n) && /id\b/.test(n);
}

// Row intent / outcome class column headers.
const INTENT_HEADERS = new Set([
  'caseintent', 'intent', 'scenariotype', 'scenario', 'variant', 'testtype',
  'validity', 'polarity', 'outcomeclass', 'outcome', 'rowclass', 'casetype', 'classification',
]);
function isIntentHeader(h) { return INTENT_HEADERS.has(compact(h)); }

// profileKey = execution-identity REFERENCE. NOT an auth-sheet signal.
function isProfileKeyHeader(h) {
  const c = compact(h);
  return c === 'profilekey' || c === 'profile' || c === 'persona' || c === 'rolekey' || c === 'identitykey' || c === 'authprofile';
}

// Real credential-identity columns — the ONLY structural signal for auth_profiles.
function isUsernameHeader(h) {
  const n = norm(h);
  return /\b(user ?name|username|email|e mail|login( ?id)?|user ?id|account( ?name)?)\b/.test(n);
}
function isPasswordHeader(h) {
  const n = norm(h);
  return /\b(pass( ?word)?|pwd|secret|passcode|pin|credential)\b/.test(n);
}

// Expected-column → oracle type. ORDER MATTERS (most specific first). A column may
// be an expected oracle of exactly one type; multiple expected columns are kept.
const EXPECTED_ORACLE_RULES = [
  { type: 'validation', re: /(validation|invalid|error|err msg|error message|reject|failure reason)/ },
  { type: 'toast', re: /(toast|notification|flash|snackbar|banner)/ },
  { type: 'visibleSignal', re: /(visible|shown|display|signal|appears|element present)/ },
  { type: 'absence', re: /(absent|absence|hidden|not visible|no display|forbidden control|hidden control|should not)/ },
  { type: 'url', re: /(url|route|landing|destination|redirect|navigates to|expected page)/ },
  { type: 'count', re: /(count|result count|rows returned|number of)/ },
  { type: 'success', re: /(success|expected result|expected outcome|outcome|result|pass|expected)/ },
];
function expectedOracleType(h) {
  const n = norm(h);
  // Only consider columns that read like an EXPECTED/RESULT column.
  if (!/(expected|result|outcome|should|assert|verify|validation|error|toast|signal|landing|redirect)/.test(n)) return null;
  for (const r of EXPECTED_ORACLE_RULES) if (r.re.test(n)) return r.type;
  return 'success';
}

// Optional/required hint from the header (e.g. "username (required)", "note?").
function requiredHint(h) {
  const n = norm(h);
  if (/\b(required|mandatory|must)\b/.test(n) || /\*$/.test(String(h).trim())) return true;
  if (/\b(optional)\b/.test(n) || /\?$/.test(String(h).trim())) return false;
  return null;
}

// Row intent VALUE → normalized class.
const NEG_VALUE_RE = /\b(negative|invalid|error|fail(ure|ed)?|empty|blank|missing|reject(ed)?|denied|unauthor|forbidden|boundary|locked|expired|wrong|bad)\b/i;
const POS_VALUE_RE = /\b(positive|valid|success(ful)?|happy|allow(ed)?|granted|authoriz|correct|good)\b/i;
const NAV_VALUE_RE = /\b(nav(igation)?|menu|route|link|browse|open page)\b/i;
function classifyIntentValue(v) {
  const s = String(v == null ? '' : v);
  if (!s.trim()) return null;
  if (NEG_VALUE_RE.test(s)) return 'negative';
  if (NAV_VALUE_RE.test(s)) return 'navigation';
  if (POS_VALUE_RE.test(s)) return 'positive';
  return null;
}

function cell(row, header) {
  if (!row || typeof row !== 'object') return '';
  if (header in row) return row[header];
  // tolerate header/key whitespace drift
  const target = compact(header);
  for (const k of Object.keys(row)) if (compact(k) === target) return row[k];
  return '';
}
const nonEmpty = (v) => String(v == null ? '' : v).trim() !== '';

/**
 * Classify a sheet's columns into roles + detect the structural signals.
 */
function classifyColumns(headers) {
  const columns = [];
  let storyIdColumn = null;
  let intentColumn = null;
  let profileKeyColumn = null;
  let usernameColumn = null;
  let passwordColumn = null;
  const expectedColumns = [];
  const inputColumns = [];

  for (const h of (Array.isArray(headers) ? headers : [])) {
    const name = String(h);
    let role = 'input';
    let oracleType = null;
    if (isStoryIdHeader(h)) { role = 'story'; if (!storyIdColumn) storyIdColumn = name; }
    else if (isIntentHeader(h)) { role = 'intent'; if (!intentColumn) intentColumn = name; }
    else if (isProfileKeyHeader(h)) { role = 'profile'; if (!profileKeyColumn) profileKeyColumn = name; }
    else if ((oracleType = expectedOracleType(h))) { role = 'expected'; expectedColumns.push({ name, oracleType }); }
    else { inputColumns.push({ name, role: 'input' }); }

    // Credential-identity detection runs INDEPENDENTLY of role assignment (a
    // username column is also an input field), and is the ONLY auth signal.
    if (isUsernameHeader(h) && !usernameColumn) usernameColumn = name;
    if (isPasswordHeader(h) && !passwordColumn) passwordColumn = name;

    columns.push({ name, role, oracleType: oracleType || undefined, required: requiredHint(h) });
  }
  return { columns, storyIdColumn, intentColumn, profileKeyColumn, usernameColumn, passwordColumn, expectedColumns, inputColumns };
}

/**
 * STRUCTURAL sheet purpose. Keyed off column presence + row-intent signal, never
 * a sheet-name or URL string.
 */
function classifySheetPurpose(cls, rows, findings, sheetName) {
  const hasCred = !!(cls.usernameColumn && cls.passwordColumn);
  const hasExpectedNegative = cls.expectedColumns.some((c) => c.oracleType === 'validation');
  const intentValues = cls.intentColumn ? rows.map((r) => classifyIntentValue(cell(r, cls.intentColumn))) : [];
  const hasNegativeRows = intentValues.some((c) => c === 'negative');
  const hasNavRows = intentValues.some((c) => c === 'navigation');
  const hasExpected = cls.expectedColumns.length > 0;

  // auth_profiles requires REAL credential-identity columns — and is positive
  // identity only. With credentials AND a negative signal it is a negative/
  // validation matrix (rejection testing), not an identity store.
  if (hasCred && !hasExpectedNegative && !hasNegativeRows) {
    return { purpose: 'auth_profiles', confidence: 0.9, reason: 'has username + password credential-identity columns and no negative signal' };
  }
  if (hasCred && (hasExpectedNegative || hasNegativeRows)) {
    return { purpose: 'negative_validation', confidence: 0.8, reason: 'has credential columns but tests rejection (negative intent / validation oracle)' };
  }
  if (!hasCred && (hasExpectedNegative || hasNegativeRows)) {
    return { purpose: 'negative_validation', confidence: 0.75, reason: 'negative intent rows / validation-error oracle without credential identity' };
  }
  if (!hasCred && hasNavRows) {
    return { purpose: 'navigation', confidence: 0.7, reason: 'navigation-intent rows, no credential identity' };
  }
  if (!hasCred && hasExpected) {
    return { purpose: 'data_matrix', confidence: 0.65, reason: 'input + expected columns, no credential identity' };
  }
  if (cls.inputColumns.length && !hasExpected) {
    findings.push({ sheet: sheetName, code: 'sheet_no_expected_oracle', severity: 'warning', detail: 'sheet has inputs but no expected/oracle column — outcome cannot be derived from data' });
    return { purpose: 'reference_data', confidence: 0.5, reason: 'input/reference columns only, no expected oracle' };
  }
  findings.push({ sheet: sheetName, code: 'sheet_purpose_unknown', severity: 'warning', detail: 'no structural signal (credentials / intent / expected / nav) — purpose undetermined' });
  return { purpose: 'unknown', confidence: 0.3, reason: 'no structural signal detected' };
}

/** Build a RowContract for one row. */
function buildRowContract(row, index, cls) {
  const storyId = cls.storyIdColumn ? String(cell(row, cls.storyIdColumn)).trim() || null : null;
  const rowClassRaw = cls.intentColumn ? String(cell(row, cls.intentColumn)).trim() || null : null;
  const intentClass = rowClassRaw ? classifyIntentValue(rowClassRaw) : null;
  const profileKey = cls.profileKeyColumn ? String(cell(row, cls.profileKeyColumn)).trim() || null : null;
  const inputs = {};
  for (const c of cls.inputColumns) { const v = cell(row, c.name); if (nonEmpty(v)) inputs[c.name] = v; }
  const expected = [];
  for (const c of cls.expectedColumns) { const v = cell(row, c.name); if (nonEmpty(v)) expected.push({ column: c.name, oracleType: c.oracleType, value: String(v) }); }
  return { index, storyId, rowClass: rowClassRaw, intentClass, profileKey, inputs, expected };
}

/** Build a SheetManifest (+ its RowContracts) for one sheet. */
function buildSheetManifest(sheet, findings) {
  const name = String(sheet && sheet.name || '').trim() || '(unnamed)';
  const rawRows = Array.isArray(sheet && sheet.rows) ? sheet.rows : [];
  const usability = analyzeSheetUsability(sheet);
  const headers = usability.headers;
  const usableRawRows = usability.rows;
  const cls = classifyColumns(headers);
  const purpose = classifySheetPurpose(cls, usableRawRows, findings, name);

  const rows = usableRawRows.map((r) => buildRowContract(r, rawRows.indexOf(r), cls));

  if (!usability.usable) {
    findings.push({
      sheet: name,
      code: usability.reason,
      severity: 'warning',
      detail: 'sheet is not eligible for workbook token generation because it has no usable header-and-data-row contract',
    });
  }

  // storyId coverage finding (declare, don't guess).
  if (cls.storyIdColumn) {
    const missing = rows.filter((r) => !r.storyId).length;
    if (missing) findings.push({ sheet: name, code: 'rows_missing_story_id', severity: 'warning', detail: `${missing}/${rows.length} row(s) have a story-id column but no value` });
  }
  return {
    name,
    headers,
    sourceRowCount: rawRows.length,
    usableRowCount: rows.length,
    mappingEligible: usability.usable,
    rowCount: rows.length,
    purpose: purpose.purpose,
    purposeConfidence: purpose.confidence,
    purposeReason: purpose.reason,
    columns: cls.columns,
    storyIdColumn: cls.storyIdColumn,
    intentColumn: cls.intentColumn,
    profileKeyColumn: cls.profileKeyColumn,
    credentialColumns: (cls.usernameColumn && cls.passwordColumn) ? { username: cls.usernameColumn, password: cls.passwordColumn } : null,
    expectedColumns: cls.expectedColumns,
    inputColumns: cls.inputColumns,
    rows,
  };
}

/**
 * @param {object} input { sheets:[{name,headers,rows}], sourceId?, sourceName?, fileHash?, generatedAt? }
 * @returns the canonical WorkbookContract (serializable; ready to persist).
 */
function buildWorkbookContract(input = {}) {
  const sheetsIn = Array.isArray(input.sheets) ? input.sheets : [];
  const findings = [];
  // EVERY sheet — no MAX_SHEETS truncation.
  const sheets = sheetsIn.map((s) => buildSheetManifest(s, findings));
  const rowCount = sheets.reduce((n, s) => n + s.rowCount, 0);

  if (!sheets.length) findings.push({ code: 'workbook_empty', severity: 'error', detail: 'no sheets in the workbook' });

  // Certification: blocking findings (severity error) → incomplete; else certified.
  const blocking = findings.filter((f) => f.severity === 'error');
  const certification = blocking.length ? 'incomplete' : 'certified';
  const confidence = sheets.length ? Number((sheets.reduce((n, s) => n + (s.purposeConfidence || 0), 0) / sheets.length).toFixed(3)) : 0;

  // Stable content hash of the source sheets (lets reports/regeneration detect
  // whether the underlying workbook changed) when no fileHash was supplied.
  const fileHash = input.fileHash || crypto.createHash('sha1').update(JSON.stringify(sheetsIn)).digest('hex').slice(0, 16);

  return {
    schemaVersion: SCHEMA_VERSION,
    sourceId: input.sourceId || null,
    sourceName: input.sourceName || null,
    fileHash,
    generatedAt: input.generatedAt || null, // caller stamps (pure module — no clock)
    sheetCount: sheets.length,
    rowCount,
    certification,
    confidence,
    sheets,
    findings,
  };
}

/**
 * Step 3C — derive CoverageItems from a contract: the unit the Architect binds to
 * (a stable id) instead of guessing a sheet from a lossy summary. One item per
 * (sheet, storyId) group, carrying everything needed to author + bind a data case:
 *   { id, storyId, sheet, storyColumn, purpose, rowSelector, rowCount,
 *     requiredPlaceholders, expectedColumns[{name,oracleType}], oracleRoles,
 *     intentClass }
 * Pure. storyId-keyed so the Architect cites a CoverageItem and the binder resolves
 * it storyId-first (no keyword guessing).
 */
function buildCoverageItems(contract) {
  const { normalizeStoryId } = require('../lib/storyId');
  const items = [];
  const idName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  for (const s of (contract && Array.isArray(contract.sheets) ? contract.sheets : [])) {
    if (s.mappingEligible === false || !Array.isArray(s.rows) || !s.rows.length) continue;
    const groups = new Map();
    for (const r of (Array.isArray(s.rows) ? s.rows : [])) {
      const key = r.storyId ? normalizeStoryId(r.storyId) : '__all__';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    if (!groups.size) groups.set('__all__', []);
    for (const [key, rows] of groups) {
      const storyId = key === '__all__' ? null : key;
      const oracleRoles = [...new Set(rows.flatMap((r) => (r.expected || []).map((e) => e.oracleType)))];
      const intents = [...new Set(rows.map((r) => r.intentClass).filter(Boolean))];
      items.push({
        id: `CI:${idName(s.name)}:${storyId || 'all'}`,
        storyId,
        sheet: s.name,
        storyColumn: s.storyIdColumn || null,
        purpose: s.purpose,
        rowSelector: storyId ? `story:${storyId}` : 'all',
        rowCount: rows.length || s.rowCount,
        requiredPlaceholders: (s.inputColumns || [])
          .filter((c) => rows.some((row) => row && row.inputs && Object.prototype.hasOwnProperty.call(row.inputs, c.name)))
          .map((c) => c.name),
        expectedColumns: (s.expectedColumns || [])
          .filter((c) => rows.some((row) => (row && row.expected || []).some((expected) => expected.column === c.name))),
        oracleRoles: oracleRoles.length ? oracleRoles : (s.expectedColumns || []).map((c) => c.oracleType),
        intentClass: intents.length === 1 ? intents[0] : (intents.length ? 'mixed' : null),
      });
    }
  }
  return items;
}

/** Compact, human-readable summary of a contract (for logs / the review dump). */
function summarizeContract(contract) {
  if (!contract) return 'no contract';
  const lines = [
    `WorkbookContract ${contract.schemaVersion} — ${contract.sheetCount} sheet(s), ${contract.rowCount} row(s), certification=${contract.certification}, confidence=${contract.confidence}`,
  ];
  for (const s of contract.sheets) {
    const story = s.storyIdColumn ? `storyId="${s.storyIdColumn}"` : 'no storyId';
    const intent = s.intentColumn ? `intent="${s.intentColumn}"` : 'no intent';
    const exp = s.expectedColumns.length ? s.expectedColumns.map((c) => `${c.name}:${c.oracleType}`).join(', ') : 'none';
    lines.push(`  • [${s.purpose} ${Math.round((s.purposeConfidence || 0) * 100)}%] "${s.name}" rows=${s.rowCount} | ${story} | ${intent} | expected={${exp}}${s.credentialColumns ? ' | CREDS' : ''}`);
  }
  if (contract.findings.length) {
    lines.push(`  findings (${contract.findings.length}):`);
    for (const f of contract.findings.slice(0, 30)) lines.push(`    - [${f.severity}] ${f.sheet ? `(${f.sheet}) ` : ''}${f.code}: ${f.detail}`);
  }
  return lines.join('\n');
}

module.exports = {
  SCHEMA_VERSION,
  buildWorkbookContract,
  buildCoverageItems,
  summarizeContract,
  // exported for guards
  classifyColumns,
  classifySheetPurpose,
  classifyIntentValue,
  expectedOracleType,
  isStoryIdHeader,
  isIntentHeader,
  isProfileKeyHeader,
  isUsernameHeader,
  isPasswordHeader,
};
