'use strict';

/**
 * Phase 2 - TestData understanding.
 *
 * This runs BEFORE test-case generation. It uses the Phase 1 document
 * understanding (modules, roles, entities, data needs) plus the workbook shape
 * to create a useful draft mapping automatically. Final approval still freezes
 * the mapping, but the user should review exceptions, not hand-map every cell.
 */

const { buildDocumentUnderstanding } = require('./documentUnderstanding');
const { normalizeModuleKey, tokenize } = require('./moduleIntelligence');
const testDataApproval = require('./testDataApproval');
const { isNonExecutableSheet } = require('./testDataSheetPolicy');
const { recordDegradation } = require('../lib/degradationSignal');

const VERSION = 2;

// Inert IDENTIFIER metadata — dropped entirely (no authoring value). NOTE: the
// free-text guidance columns (notes/comment/description/…) were REMOVED from this
// set — they are not bindable inputs but their prose IS procedural authoring
// guidance (e.g. notes="Admin login then logout"), so they are captured as a
// guidanceColumn (see GUIDANCE_HEADERS) and surfaced to the Architect rather than
// silently discarded like an inert row id.
const META_HEADERS = new Set([
  'id', 'rowid', 'row_id', 'testcaseid', 'test_case_id', 'tcid', 'caseid',
  'case_id', 'scenarioid', 'scenario_id', 'sensitivity',
]);

// GUIDANCE metadata — NOT a bindable input/expected column, but the cell text is
// procedural authoring guidance the Architect must honor (e.g. "Admin login then
// logout - verify session cleared and redirect to login"). Captured per-binding
// as guidanceColumn and emitted into the Architect prompt; never bound as a data
// input and never an expected-value source.
const GUIDANCE_HEADERS = new Set([
  'notes', 'note', 'comment', 'comments', 'description', 'remarks', 'remark',
  'instruction', 'instructions', 'steps', 'procedure', 'guidance',
]);

const EXPECTED_RE = /(expected|expectation|result|outcome|assert|verification|landing\s*page|message|error)/i;
const ROW_CLASS_RE = /^(type|case\s*type|scenario\s*type|test\s*type|row\s*class|category|validity|positive|negative|boundary|polarity)$/i;
const AUTH_RE = /\b(auth|authentication|login|log\s*in|signin|sign\s*in|credential|credentials|password|username|session)\b/i;
const SEARCH_RE = /\b(search|filter|find|lookup|query)\b/i;
const CRUD_RE = /\b(create|add|edit|update|delete|remove|crud|submit|save)\b/i;
const VALIDATION_RE = /\b(invalid|negative|validation|error|required|mandatory|boundary|empty|blank)\b/i;
const DOWNLOAD_RE = /\b(download|export|file|csv|excel|xlsx|pdf)\b/i;
const REPORT_DOWNLOAD_RE = /\b(report|reports)\b.*\b(download|export|csv|excel|xlsx|pdf|file)\b|\b(download|export|csv|excel|xlsx|pdf|file)\b.*\b(report|reports)\b/i;
const ACCESS_CONTROL_RE = /\b(role\s*access|access\s*control|permission|permissions|privilege|privileges|role\s*restriction|admin\s*controls?)\b/i;

const ROLE_SYNONYMS = [
  ['username', ['username', 'user', 'user name', 'login', 'login id', 'userid', 'user id']],
  ['password', ['password', 'pwd', 'pass', 'passwd', 'secret']],
  ['role', ['role', 'auth role', 'user role', 'account type', 'profile']],
  ['email', ['email', 'email address', 'mail']],
  ['firstName', ['first name', 'firstname', 'fname', 'given name']],
  ['middleName', ['middle name', 'middlename', 'mname']],
  ['lastName', ['last name', 'lastname', 'lname', 'surname', 'family name']],
  ['fullName', ['full name', 'fullname', 'employee name', 'candidate name', 'name']],
  ['employeeId', ['employee id', 'employeeid', 'emp id', 'empid', 'employee number']],
  ['jobTitle', ['job title', 'jobtitle', 'title', 'designation']],
  ['employmentStatus', ['employment status', 'employement status', 'status']],
  ['supervisor', ['supervisor', 'supervisor name', 'manager']],
  ['date', ['date', 'from date', 'to date', 'start date', 'end date']],
  ['expected', ['expected', 'expected result', 'expected outcome', 'expected message']],
];

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function norm(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function camelRole(header) {
  const words = clean(header)
    .replace(/[_-]+/g, ' ')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  if (!words.length) return null;
  const out = words.map((w, i) => {
    const lower = w.toLowerCase();
    if (i === 0) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join('');
  return /^[a-z][a-zA-Z0-9_]*$/.test(out) ? out : null;
}

function headerToRole(header, understanding) {
  const h = norm(header);
  if (!h) return null;
  for (const [role, synonyms] of ROLE_SYNONYMS) {
    if (synonyms.some((s) => h === norm(s))) return role;
  }
  for (const [role, synonyms] of ROLE_SYNONYMS) {
    if (synonyms.some((s) => {
      const n = norm(s);
      return n.length >= 4 && h.includes(n);
    })) return role;
  }

  // Document-aware dynamic roles: if a header matches an entity/data need from
  // the docs, keep the header as a stable role instead of dropping it.
  const docTerms = [];
  for (const entity of understanding?.entities || []) {
    docTerms.push(entity.key, entity.name);
  }
  for (const need of understanding?.dataNeeds || []) {
    docTerms.push(...(need.fields || []));
  }
  const hTokens = new Set(tokenize(header));
  const docHit = docTerms.some((term) => {
    const key = normalizeModuleKey(term);
    if (!key) return false;
    if (h === norm(key)) return true;
    return tokenize(key).some((t) => hTokens.has(t));
  });
  return docHit ? camelRole(header) : null;
}

// #10 NON-LATIN HEADERS. norm()/camelRole collapse a CJK/Cyrillic/Arabic header
// to '' (no ASCII alnum survives), which would silently DROP the column and lose
// its data. Provide a stable, deterministic fallback token keyed on COLUMN
// POSITION so the column is still bindable (placeholders can reference {{col3}}),
// and the caller records a degradation so the operator knows the non-Latin header
// needs review. Generic — fires for ANY header whose normalised form is empty,
// never a specific language/string.
function isNonLatinHeader(header) {
  const raw = clean(header);
  return raw !== '' && norm(header) === '';
}
function fallbackHeaderRole(index) {
  return `col${Number(index) + 1}`;
}

function isMetadataHeader(header) {
  const key = norm(header);
  if (META_HEADERS.has(key)) return true;
  return /^(test|tc|case|scenario).*(id|no|number)$/.test(key);
}

// A free-text guidance/instructions column: not bindable data, but its prose is
// procedural authoring guidance the Architect should honor.
function isGuidanceHeader(header) {
  return GUIDANCE_HEADERS.has(norm(header));
}

function textForSheet(sheet) {
  const rows = Array.isArray(sheet.rows) ? sheet.rows.slice(0, 6) : [];
  const rowValues = rows.flatMap((r) => Object.values(r || {})).join(' ');
  return `${sheet.name || ''} ${(sheet.headers || []).join(' ')} ${rowValues}`;
}

function classifyPurpose(sheet) {
  if (isNonExecutableSheet(sheet)) return 'non_executable_metadata';
  const text = textForSheet(sheet);
  const flat = norm(text);
  const headers = new Set((sheet.headers || []).map(norm));
  const sheetNameNorm = norm(sheet.name);
  // Split each header on camelCase / separators so "menuItemShouldExist" → {menu,item,should,exist}.
  const headerWords = new Set();
  for (const h of (sheet.headers || [])) {
    for (const w of String(h || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)) {
      if (w) headerWords.add(w);
    }
  }
  const ACCESS_TARGET_WORDS = ['menu', 'menuitem', 'nav', 'navigation', 'page', 'url', 'route', 'permission', 'permissions', 'privilege', 'privileges', 'visible', 'hidden', 'widget', 'control', 'controls', 'module', 'modules', 'access'];
  const hasAccessTarget = ACCESS_TARGET_WORDS.some((w) => headerWords.has(w));
  const hasRoleDiscriminator = headerWords.has('role') || headerWords.has('roles') || headers.has('role');
  const hasCredentialPair = (headers.has('username') || headers.has('email')) && headers.has('password');
  const nameSaysAccess = /(roleaccess|accesscontrol|rolerestriction|rbac)/.test(sheetNameNorm);

  // Classify by STRUCTURE, most-specific signal first — never by keyword first-match.
  // 1. A full credential pair (username/email + password) makes this the login/identity sheet.
  if (hasCredentialPair) return 'auth_profiles';
  // 2. ACCESS CONTROL: a role/permission discriminator paired with an access-target column
  //    (menu/page/url/visible/hidden/widget/control/...), or a sheet whose NAME says RBAC. Tested
  //    BEFORE the generic keyword cascade so an RBAC matrix is never mislabelled download/validation.
  if (nameSaysAccess || ACCESS_CONTROL_RE.test(text) || (hasRoleDiscriminator && hasAccessTarget)) return 'access_control';
  // 3. Auth-themed sheet without an explicit credential pair (e.g. a logout/session sheet).
  if (AUTH_RE.test(text)) return 'auth_profiles';
  if (VALIDATION_RE.test(text) || /(invalid|negative|validation|required|mandatory|boundary|blank)/.test(flat)) return 'validation_cases';
  if (DOWNLOAD_RE.test(text) || REPORT_DOWNLOAD_RE.test(text) || /(download|export|file|csv|excel|xlsx|pdf)/.test(flat)) return 'download_expectations';
  if (SEARCH_RE.test(text) || /(search|filter|lookup|query)/.test(flat)) return 'search_data';
  if (CRUD_RE.test(text) || /(crud|create|add|edit|update|delete|remove|submit|save)/.test(flat)) return 'crud_data';
  return 'scenario_data';
}

function bestModule(sheet, understanding) {
  const purpose = classifyPurpose(sheet);
  // Credentials are usable across modules — but "shared" is a FLAG, not a module identity. Do not
  // collapse every auth sheet to "Authentication"; let it bind to the module its tokens actually
  // match (an RBAC/access-control sheet belongs to its access-control module, not Authentication).
  const shared = purpose === 'auth_profiles';
  const hay = ` ${textForSheet(sheet).toLowerCase()} `;
  let best = null;
  for (const module of understanding?.modules || []) {
    const aliases = [module.key, module.name].concat(module.sourceEvidence?.map((e) => e.text) || []);
    let score = 0;
    for (const alias of aliases) {
      const cleanAlias = clean(alias).toLowerCase();
      if (!cleanAlias || cleanAlias.length < 3) continue;
      if (hay.includes(` ${cleanAlias} `)) score += cleanAlias.includes(' ') ? 5 : 3;
      for (const token of tokenize(cleanAlias)) {
        if (hay.includes(` ${token} `)) score += 1;
      }
    }
    // Use data-need hints: a sheet with search columns belongs to a module whose
    // docs said search data is needed, even if the sheet name is generic.
    const needKeys = new Set((module.dataNeeds || []).map((n) => n.key));
    if (purpose === 'search_data' && needKeys.has('search_criteria')) score += 4;
    if (purpose === 'crud_data' && needKeys.has('create_update_fields')) score += 4;
    if (purpose === 'validation_cases' && needKeys.has('validation_rows')) score += 3;
    if (purpose === 'download_expectations' && needKeys.has('download_expectation')) score += 3;
    if (score && (!best || score > best.score)) best = { module, score };
  }
  if (!best) {
    // No document module scored. A shared credential sheet falls back to a synthetic Authentication
    // module; anything else stays unassigned (low confidence) rather than being mislabelled.
    if (shared) return { key: 'auth', name: 'Authentication', confidence: 'medium', shared: true };
    return { key: null, name: null, confidence: 'low', shared: false };
  }
  return {
    key: best.module.key,
    name: best.module.name,
    confidence: best.score >= 5 ? 'high' : 'medium',
    shared: shared || !!best.module.shared,
  };
}

function valuesForHeader(sheet, header) {
  return (Array.isArray(sheet.rows) ? sheet.rows : [])
    .map((row) => row && row[header])
    .filter((value) => value != null && String(value).trim() !== '')
    .slice(0, 12);
}

// Header words that strongly suggest PII but whose VALUE patterns are
// locale-specific (and our value regexes only cover US SSN / India Aadhaar/PAN /
// 12-16-digit cards). When such a header is present but no known value pattern
// matches, the column is likely PII for a locale we can't validate — flag it
// (#34/#35) instead of silently treating it as synthetic.
const LIKELY_PII_HEADER_RE = /\b(national\s*id|tax\s*id|nino|sin|nric|insurance\s*number|dob|date\s*of\s*birth|birth\s*date|address|postcode|post\s*code|zip|driver'?s?\s*licen[cs]e|licen[cs]e\s*number|passport)\b/i;

function detectSensitivity(role, header, sheet, degradations = null) {
  const key = `${role || ''} ${header || ''}`.toLowerCase();
  if (testDataApproval.defaultSensitivity(role) === 'masked') return 'masked';
  if (/(password|secret|token|otp|pin|api.?key|credential|auth)/i.test(key)) return 'masked';
  if (/(ssn|aadhaar|passport|pan|credit|card|cvv|email|phone|mobile)/i.test(key)) return 'restricted';
  const samples = valuesForHeader(sheet, header).join(' ');
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(samples) || /\b\d{12,16}\b/.test(samples)) return 'restricted';
  if (/@/.test(samples) && role !== 'username') return 'restricted';
  // #34/#35 — likely-PII header (a locale we don't have a value pattern for) that
  // matched none of the known patterns: do not silently call it synthetic. Treat
  // it as restricted AND surface a degradation so a reviewer can confirm masking.
  if (LIKELY_PII_HEADER_RE.test(key)) {
    if (degradations) {
      recordDegradation({
        collector: degradations, stage: 'data-binding', severity: 'info',
        reason: `column "${String(header).slice(0, 40)}" on sheet "${sheet && sheet.name}" looks like PII but matched no known (US/India) value pattern`,
        impact: 'classified restricted by header signal; PII detection is locale-limited — confirm masking for this locale',
      });
    }
    return 'restricted';
  }
  return 'synthetic';
}

function analyzeColumns(sheet, understanding, degradations = null) {
  const headers = Array.isArray(sheet.headers) ? sheet.headers.filter(Boolean) : [];
  const columnToField = {};
  const sensitivity = {};
  const ignored = [];
  const unmapped = [];
  let expectedColumn = null;
  let rowClassColumn = null;
  let guidanceColumn = null;

  for (let headerIndex = 0; headerIndex < headers.length; headerIndex += 1) {
    const header = headers[headerIndex];
    if (!expectedColumn && EXPECTED_RE.test(header)) {
      expectedColumn = header;
      sensitivity.expected = detectSensitivity('expected', header, sheet, degradations);
      continue;
    }
    if (!rowClassColumn && ROW_CLASS_RE.test(header)) {
      rowClassColumn = header;
      continue;
    }
    // Guidance/instructions column: NOT bound as a data input (so it never becomes
    // a {{token}} or an expected value), but the FIRST one is captured as the
    // binding's guidanceColumn so its per-row prose reaches the Architect as
    // procedural authoring guidance. Checked before isMetadataHeader so a real
    // 'notes' column is preserved (it is no longer in META_HEADERS).
    if (isGuidanceHeader(header)) {
      if (!guidanceColumn) guidanceColumn = header;
      ignored.push({ header, reason: 'guidance' });
      continue;
    }
    if (isMetadataHeader(header)) {
      ignored.push({ header, reason: 'metadata' });
      continue;
    }
    const role = headerToRole(header, understanding);
    if (role) {
      if (!columnToField[role]) {
        columnToField[role] = header;
        sensitivity[role] = detectSensitivity(role, header, sheet, degradations);
      } else {
        // The canonical role is already taken (e.g. a 2nd "expected*" column like
        // expectedHiddenMenuItems when expectedVisibleMenuItems already claimed "expected").
        // Keep this column under its own camelCased role so a DISTINCT token can bind it, instead
        // of dropping it — every expected/value column the user supplied must be usable.
        const altRole = camelRole(header);
        if (altRole && !columnToField[altRole]) {
          columnToField[altRole] = header;
          sensitivity[altRole] = detectSensitivity(altRole, header, sheet, degradations);
        } else {
          unmapped.push({ header, reason: `duplicate role ${role}` });
        }
      }
      continue;
    }
    // Retain every non-meta data column under SOME role — canonical if known above, else the
    // camelCased header. A real data column (e.g. an RBAC sheet's menuItemShouldExist / dashboardWidget)
    // must never be silently dropped just because it isn't in the credential synonym table; the
    // binder hydrates only what is in columnToField, so a dropped column = lost test data.
    const fallbackRole = camelRole(header);
    if (fallbackRole && !columnToField[fallbackRole]) {
      columnToField[fallbackRole] = header;
      sensitivity[fallbackRole] = detectSensitivity(fallbackRole, header, sheet, degradations);
      continue;
    }
    // #10 — a non-empty header that normalises to '' is non-Latin (CJK/Cyrillic/
    // Arabic). camelRole returned null, so without a fallback the column would be
    // silently dropped and its data lost. Bind it under a stable position key so
    // it is still usable, and record a degradation for operator review.
    if (isNonLatinHeader(header)) {
      const posRole = fallbackHeaderRole(headerIndex);
      if (!columnToField[posRole]) {
        columnToField[posRole] = header;
        sensitivity[posRole] = detectSensitivity(posRole, header, sheet, degradations);
        if (degradations) {
          recordDegradation({
            collector: degradations, stage: 'data-binding', severity: 'warning',
            reason: `non-Latin column header "${String(header).slice(0, 40)}" on sheet "${sheet && sheet.name}" could not be normalised to a Latin role`,
            impact: `column bound under positional token {{${posRole}}} — header needs review to confirm the intended role`,
          });
        }
        continue;
      }
    }
    unmapped.push({ header, reason: 'unclear_column' });
  }

  return { columnToField, expectedColumn, rowClassColumn, guidanceColumn, sensitivity, ignored, unmapped };
}

function rowClassSummary(sheet, rowClassColumn) {
  if (!rowClassColumn) return { detected: false, values: [] };
  const counts = new Map();
  for (const value of valuesForHeader(sheet, rowClassColumn)) {
    const key = clean(value).toLowerCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return { detected: counts.size > 0, values: Array.from(counts.entries()).map(([value, count]) => ({ value, count })) };
}

function understandWorkbook({ sheets = [], documentUnderstanding = null } = {}) {
  const understanding = documentUnderstanding || buildDocumentUnderstanding({});
  const bindings = [];
  const unmapped = [];
  const ignoredSheets = [];
  const sheetUnderstanding = [];
  // #10 / #34 / #35 — degradation collector: non-Latin headers bound under a
  // positional token, likely-PII columns we can't validate by value pattern.
  // Surfaced on the returned mapping/summary so the route/UI can flag them.
  const degradations = [];

  for (const sheet of Array.isArray(sheets) ? sheets : []) {
    if (isNonExecutableSheet(sheet)) {
      ignoredSheets.push({ sheet: sheet.name, reason: 'non_executable_workbook_metadata' });
      sheetUnderstanding.push({
        sheet: sheet.name,
        purpose: 'non_executable_metadata',
        module: null,
        moduleKey: null,
        confidence: 'ignored',
        ignored: true,
        inputRoles: [],
        expectedColumn: null,
        rowClassColumn: null,
        ignoredColumns: [],
        unmappedColumns: [],
        rowCount: Array.isArray(sheet.rows) ? sheet.rows.length : 0,
      });
      continue;
    }
    const purpose = classifyPurpose(sheet);
    const module = bestModule(sheet, understanding);
    const columns = analyzeColumns(sheet, understanding, degradations);
    for (const u of columns.unmapped) {
      unmapped.push({ sheet: sheet.name, header: u.header, reason: u.reason });
    }
    const inputCount = Object.keys(columns.columnToField).length;
    const confidence = module.confidence === 'high' && (inputCount > 0 || columns.expectedColumn) ? 'high'
      : inputCount > 0 || columns.expectedColumn ? 'medium' : 'low';
    const binding = {
      sheet: sheet.name,
      module: module.name || undefined,
      moduleKey: module.key || undefined,
      purpose,
      columnToField: columns.columnToField,
      expectedColumn: columns.expectedColumn || undefined,
      rowClassColumn: columns.rowClassColumn || undefined,
      guidanceColumn: columns.guidanceColumn || undefined,
      sensitivity: columns.sensitivity,
      ignoredColumns: columns.ignored,
      rowClassSummary: rowClassSummary(sheet, columns.rowClassColumn),
      confidence,
      source: 'document_aware_auto',
    };
    bindings.push(binding);
    sheetUnderstanding.push({
      sheet: sheet.name,
      purpose,
      module: module.name || null,
      moduleKey: module.key || null,
      confidence,
      inputRoles: Object.keys(columns.columnToField),
      expectedColumn: columns.expectedColumn || null,
      rowClassColumn: columns.rowClassColumn || null,
      ignoredColumns: columns.ignored,
      unmappedColumns: columns.unmapped,
      rowCount: Array.isArray(sheet.rows) ? sheet.rows.length : 0,
    });
  }

  const mapping = {
    version: VERSION,
    strategy: 'pre_generation_document_aware',
    bindings,
    unmapped,
    ignoredSheets,
    ignored: bindings.flatMap((b) => (b.ignoredColumns || []).map((x) => ({ sheet: b.sheet, ...x }))),
    degradations,
    understanding: {
      version: VERSION,
      sheetCount: sheetUnderstanding.length,
      sheets: sheetUnderstanding,
      documentSummary: documentUnderstanding ? documentUnderstanding.summary : null,
    },
  };

  return {
    version: VERSION,
    mapping,
    sheetUnderstanding,
    summary: {
      sheetCount: sheetUnderstanding.length,
      bindingCount: bindings.length,
      unmappedCount: unmapped.length,
      ignoredCount: mapping.ignored.length,
      ignoredSheetCount: ignoredSheets.length,
      highConfidenceCount: bindings.filter((b) => b.confidence === 'high').length,
      degradationCount: degradations.length,
    },
    degradations,
  };
}

module.exports = {
  VERSION,
  understandWorkbook,
  classifyPurpose,
  headerToRole,
  detectSensitivity,
  isNonExecutableSheet,
};
