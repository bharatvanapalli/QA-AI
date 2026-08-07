/**
 * Phase 3 - data-aware generation guard.
 *
 * The Architect may propose cases, but Node decides whether a case is truly
 * data-aware. This module only binds a case to a TestData sheet when the case
 * already uses role placeholders from that sheet. It never invents steps or
 * converts literal values into placeholders after the fact.
 */

const { normalizeModuleKey, tokenize } = require('./moduleIntelligence');
const { deriveCaseOracleIntent } = require('../lib/dataRowContract');
const { classifyRowOutcomeClass } = require('./testDataMatrix');
const { buildWorkbookContract, buildCoverageItems } = require('./workbookContract');
const { resolveStoryBinding } = require('../lib/storyBinding');
const { normalizeStoryId } = require('../lib/storyId');
const inlineCaseInstanceContract = require('./inlineCaseInstanceContract');

// The case's storyId for binding: prefer a stamped caseObj.storyId, else the
// UNANIMOUS storyId of its requirementRefs (via the clause→storyId index threaded
// from the architect). Conflicting refs → null (never guess; the case stays weak).
function caseStoryIdFor(caseObj, clauseStoryIndex) {
  if (caseObj && caseObj.storyId) return caseObj.storyId;
  const refs = caseObj && Array.isArray(caseObj.requirementRefs) ? caseObj.requirementRefs : [];
  if (!clauseStoryIndex || !refs.length) return null;
  const get = (r) => (typeof clauseStoryIndex.get === 'function' ? clauseStoryIndex.get(r) : clauseStoryIndex[r]);
  const ids = [...new Set(refs.map(get).filter(Boolean))];
  return ids.length === 1 ? ids[0] : null;
}

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

// The ONLY data findings that mean the case is genuinely un-runnable: the bound sheet or column
// does not exist in the uploaded data. Everything else (literal-instead-of-placeholder, missing
// placeholder, alignment heuristics) is authoring-quality and advisory — it must never mark a
// valid, fully-provided binding "incomplete".
const STRUCTURAL_DATA_ERRORS = new Set([
  'data_binding_sheet_not_found',
  'data_binding_column_not_found',
  'data_binding_column_corrupted',
  'data_binding_intent_mismatch',
  'data_binding_mixed_rows_without_scope',
]);

function parseMapping(testData) {
  if (!testData || typeof testData !== 'object') return null;
  let mapping = testData.mapping;
  if (typeof mapping === 'string') {
    try { mapping = JSON.parse(mapping); } catch (_) { mapping = null; }
  }
  return mapping && typeof mapping === 'object' ? mapping : null;
}

function bindingsFor(testData) {
  const mapping = parseMapping(testData);
  return Array.isArray(mapping && mapping.bindings) ? mapping.bindings.filter((b) => b && b.sheet) : [];
}

function mappingEligibleBindings(testData, workbookContract) {
  const manifests = Array.isArray(workbookContract && workbookContract.sheets) ? workbookContract.sheets : [];
  const rawSheets = sheetsFor(testData);
  return bindingsFor(testData).filter((binding) => {
    const wanted = String(binding && binding.sheet || '').trim().toLowerCase();
    const manifestMatches = manifests.filter((sheet) => String(sheet && sheet.name || '').trim().toLowerCase() === wanted);
    const rawMatches = rawSheets.filter((sheet) => String(sheet && sheet.name || '').trim().toLowerCase() === wanted);
    if (manifestMatches.length !== 1 || rawMatches.length !== 1) return false;
    const manifest = manifestMatches[0];
    if (manifest.mappingEligible !== true || Number(manifest.usableRowCount || 0) < 1) return false;

    const mappedHeaders = [
      ...Object.values(binding.columnToField && typeof binding.columnToField === 'object' ? binding.columnToField : {}),
      ...Object.values(binding.expectedColumns && typeof binding.expectedColumns === 'object' ? binding.expectedColumns : {}),
      binding.expectedColumn,
      binding.rowClassColumn,
    ].map((value) => String(value || '').trim()).filter(Boolean);
    if (!mappedHeaders.length) return false;
    const manifestHeaders = new Set((Array.isArray(manifest.headers) ? manifest.headers : []).map((value) => String(value).trim().toLowerCase()));
    if (mappedHeaders.some((header) => !manifestHeaders.has(header.toLowerCase()))) return false;

    const rows = Array.isArray(rawMatches[0].rows) ? rawMatches[0].rows : [];
    return mappedHeaders.every((header) => rows.some((row) => row && typeof row === 'object' && !Array.isArray(row)
      && Object.entries(row).some(([column, value]) => String(column).trim().toLowerCase() === header.toLowerCase()
        && value != null && String(value).trim().length > 0)));
  });
}

function walkStrings(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v) => walkStrings(v, out));
    return out;
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((v) => walkStrings(v, out));
  }
  return out;
}

function placeholdersInCase(caseObj) {
  const found = new Set();
  const text = walkStrings(caseObj).join(' ');
  let match;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((match = PLACEHOLDER_RE.exec(text))) {
    found.add(String(match[1] || '').trim());
  }
  return Array.from(found).filter(Boolean);
}

function rolesForBinding(binding) {
  const roles = new Set(Object.keys((binding && binding.columnToField) || {}));
  for (const role of Object.keys((binding && binding.expectedColumns) || {})) roles.add(role);
  if (binding && binding.expectedColumn) roles.add('expected');
  if (binding && binding.rowClassColumn) roles.add('rowclass');
  return roles;
}

function tokenKey(value) {
  return String(value == null ? '' : value).replace(/[^a-zA-Z0-9_]+/g, '').toLowerCase();
}

function tokenAliasesForBinding(binding) {
  const aliases = new Map();
  const c2f = (binding && binding.columnToField && typeof binding.columnToField === 'object') ? binding.columnToField : {};
  for (const [role, header] of Object.entries(c2f)) {
    aliases.set(tokenKey(role), role);
    aliases.set(tokenKey(header), role);
  }
  if (binding && binding.expectedColumn) {
    aliases.set('expected', 'expected');
    aliases.set(tokenKey(binding.expectedColumn), 'expected');
  }
  if (binding && binding.rowClassColumn) {
    aliases.set('rowclass', 'rowclass');
    aliases.set(tokenKey(binding.rowClassColumn), 'rowclass');
  }
  return aliases;
}

function bindingModuleMatches(binding, scenario, moduleScope) {
  if (!moduleScope) return true;
  const wanted = normalizeModuleKey(moduleScope);
  const candidates = [
    binding && binding.moduleKey,
    binding && binding.module,
    scenario && scenario.module,
    binding && binding.purpose === 'auth_profiles' ? 'auth' : null,
  ].filter(Boolean).map(normalizeModuleKey);
  if (candidates.some((c) => c === wanted)) return true;
  const hay = tokenize(`${binding?.sheet || ''} ${binding?.module || ''} ${scenario?.name || ''} ${scenario?.module || ''}`);
  return tokenize(moduleScope).some((t) => hay.includes(t));
}

// Classify a sheet's INTENT semantics from its name/purpose/module so binding can
// prefer the sheet that matches the CASE's intent — not just placeholder overlap.
// AuthProfiles (positive identity) may be a COMPANION, never the primary row
// matrix for a negative/validation/security case.
function sheetIntentClass(binding) {
  const s = `${(binding && binding.sheet) || ''} ${(binding && binding.purpose) || ''} ${(binding && binding.module) || ''}`.toLowerCase();
  if (/negative|invalid|reject|wrong[\s_-]?cred|bad[\s_-]?cred|failed[\s_-]?login|lockout/.test(s)) return 'negative';
  if (/security|sql[\s_-]?inj|injection|\bxss\b|attack|exploit/.test(s)) return 'security';
  if (/form[\s_-]?validation|\bvalidation\b|empty[\s_-]?field|required[\s_-]?field/.test(s)) return 'validation';
  if (/auth[\s_-]?profile|auth_profiles|identit|credential[\s_-]?profile/.test(s)) return 'positive_identity';
  return 'neutral';
}

function bindingHasNegativeRows(binding, testData) {
  const sheet = sheetsFor(testData).find((s) => String(s && s.name || '').trim().toLowerCase() === String(binding && binding.sheet || '').trim().toLowerCase());
  if (!sheet || !Array.isArray(sheet.rows) || !sheet.rows.length) return false;
  const c2f = (binding && binding.columnToField && typeof binding.columnToField === 'object') ? binding.columnToField : {};
  const expectedColumn = binding && binding.expectedColumn;
  const rowClassColumn = binding && binding.rowClassColumn;
  return sheet.rows.some((row, index) => {
    const inputs = {};
    for (const [role, header] of Object.entries(c2f)) {
      if (row && Object.prototype.hasOwnProperty.call(row, header)) inputs[role] = row[header];
    }
    const outcome = classifyRowOutcomeClass({
      index,
      setName: sheet.name,
      sheet: sheet.name,
      inputs,
      raw: row,
      expected: expectedColumn ? row[expectedColumn] : null,
      rowClass: rowClassColumn ? row[rowClassColumn] : null,
      expectedColumn: expectedColumn || null,
      rowClassColumn: rowClassColumn || null,
    });
    return outcome && ['required_validation', 'auth_rejection', 'boundary'].includes(outcome.class);
  });
}

function scoreBinding(binding, placeholderSet, scenario, moduleScope, caseIntent) {
  if (!bindingModuleMatches(binding, scenario, moduleScope)) return 0;
  const roles = rolesForBinding(binding);
  const aliases = tokenAliasesForBinding(binding);
  let score = 0;
  for (const token of placeholderSet) {
    const canonical = aliases.get(tokenKey(token)) || token;
    if (roles.has(canonical)) score += canonical === 'expected' ? 2 : 3;
  }
  if (binding.confidence === 'high') score += 1;
  // INTENT-AWARE term (root-cause fix for the run-91d6301a mis-binding): a NEGATIVE
  // case (invalid/rejected/empty-field) must PREFER its matching negative/validation
  // /security sheet and must NOT make the positive identity sheet (AuthProfiles) its
  // PRIMARY row matrix — even when both expose username/password roles. Without this,
  // a negative-auth case scored AuthProfiles high on placeholder overlap alone and
  // then ran valid-login rows under a "remain on login" oracle. +6 outweighs the
  // username+password overlap (3+3); the −6 penalty drops AuthProfiles below the
  // selection floor so it can never WIN as primary for a negative case.
  if (caseIntent === 'negative' && score > 0) {
    const sc = sheetIntentClass(binding);
    if (sc === 'negative' || sc === 'validation' || sc === 'security') score += 6;
    // The positive identity sheet (AuthProfiles) can NEVER be the PRIMARY row
    // matrix for a negative case — disqualify it (it may still serve as a
    // foreign-key companion identity elsewhere). If it is the only candidate, the
    // case stays unbound and the negative-sheet synthesizer covers it.
    else if (sc === 'positive_identity') return 0;
  }
  return score;
}

function chooseBinding(caseObj, scenario, bindings, moduleScope) {
  const tokens = placeholdersInCase(caseObj);
  if (!tokens.length) return { binding: null, placeholders: tokens };
  const placeholderSet = new Set(tokens);
  // Derive the case's intent ONCE so scoreBinding can prefer the intent-matching
  // sheet. Reuses the same generic detector the runtime data-contract guard uses.
  let caseIntent = null;
  try { caseIntent = deriveCaseOracleIntent(caseObj); } catch (_) { caseIntent = null; }
  let best = null;
  for (const binding of bindings) {
    const score = scoreBinding(binding, placeholderSet, scenario, moduleScope, caseIntent);
    if (score > 0 && (!best || score > best.score)) best = { binding, score };
  }
  return { binding: best && best.binding, placeholders: tokens };
}

function findBindingBySheet(bindings, sheet) {
  const wanted = String(sheet || '').trim().toLowerCase();
  return bindings.find((b) => String(b.sheet || '').trim().toLowerCase() === wanted) || null;
}

function sheetsFor(testData) {
  if (!testData || typeof testData !== 'object') return [];
  const sheets = Array.isArray(testData.sheets) ? testData.sheets : [];
  if (sheets.length) return sheets;
  let parsed = testData.sheetsJson;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch (_) { parsed = null; }
  }
  return Array.isArray(parsed && parsed.sheets) ? parsed.sheets : [];
}

const DATA_LITERAL_STOP = new Set([
  'pass', 'fail', 'true', 'false', 'yes', 'no', 'ok', 'n/a', 'na',
  'positive', 'negative', 'valid', 'invalid',
]);

function literalCandidatesFor(testData) {
  const out = [];
  for (const sheet of sheetsFor(testData)) {
    const sheetName = sheet && sheet.name;
    const headers = Array.isArray(sheet && sheet.headers) ? sheet.headers : [];
    const rows = Array.isArray(sheet && sheet.rows) ? sheet.rows : [];
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex] || {};
      for (const header of headers) {
        const raw = row[header];
        if (raw == null) continue;
        const value = String(raw).trim();
        if (!value) continue;
        const low = value.toLowerCase();
        if (DATA_LITERAL_STOP.has(low)) continue;
        if (value.length < 3 && !/^\d+$/.test(value)) continue;
        out.push({ sheet: sheetName, header, rowIndex, value });
      }
    }
  }
  return out;
}

function literalLeaksInCase(caseObj, testData) {
  const text = walkStrings(caseObj).join('\n');
  if (!text.trim()) return [];
  const placeholders = new Set(placeholdersInCase(caseObj).map((p) => p.toLowerCase()));
  const leaks = [];
  const seen = new Set();
  for (const item of literalCandidatesFor(testData)) {
    if (!item.sheet || !item.value) continue;
    const value = String(item.value);
    const roleish = String(item.header || '').replace(/[^a-zA-Z0-9]+/g, '').toLowerCase();
    if (roleish && placeholders.has(roleish)) continue;
    if (!text.includes(value)) continue;
    const key = `${item.sheet}\u0001${item.header}\u0001${item.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    leaks.push(item);
    if (leaks.length >= 20) break;
  }
  return leaks;
}

function transformStrings(value, transform, key = null) {
  if (typeof value === 'string') return transform(value, key);
  if (Array.isArray(value)) return value.map((item) => transformStrings(item, transform, key));
  if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      value[childKey] = transformStrings(childValue, transform, childKey);
    }
  }
  return value;
}

function canonicalizePlaceholdersInCase(caseObj, binding) {
  const aliases = tokenAliasesForBinding(binding);
  let replacements = 0;
  transformStrings(caseObj, (text) => String(text).replace(PLACEHOLDER_RE, (full, token) => {
    const canonical = aliases.get(tokenKey(token));
    if (!canonical || canonical === token) return full;
    replacements += 1;
    return `{{${canonical}}}`;
  }));
  return replacements;
}

const DATA_LITERAL_KEYS = new Set([
  'value', 'expected', 'expectedText', 'expectedValue', 'expectedUrl', 'pageName',
  'assertions', 'message', 'text', 'contains', 'equals', 'input', 'payload',
  'steps', 'declaredAssertions', 'operationsJson',
]);

function literalReplacementsForBinding(testData, binding) {
  const sheets = sheetsFor(testData);
  const sheet = sheets.find((s) => String(s && s.name).toLowerCase() === String(binding && binding.sheet).toLowerCase());
  if (!sheet) return [];
  const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
  const c2f = (binding && binding.columnToField && typeof binding.columnToField === 'object') ? binding.columnToField : {};
  const replacements = [];
  const add = (header, role) => {
    if (!header || !role) return;
    for (const row of rows) {
      const value = String(row && row[header] == null ? '' : row[header]).trim();
      if (!value) continue;
      const low = value.toLowerCase();
      if (DATA_LITERAL_STOP.has(low)) continue;
      if (value.length < 3 && !/^\d+$/.test(value)) continue;
      replacements.push({ value, token: `{{${role}}}`, header, role });
    }
  };
  for (const [role, header] of Object.entries(c2f)) add(header, role);
  if (binding && binding.expectedColumn) add(binding.expectedColumn, 'expected');
  return replacements
    .sort((a, b) => b.value.length - a.value.length)
    .filter((item, index, list) => list.findIndex((x) => x.value === item.value && x.token === item.token) === index);
}

function replaceAllLiteral(text, literal, token) {
  if (!literal || literal.length < 3 || !text.includes(literal)) return text;
  // Boundary-aware: replace the literal only as a standalone token, never inside a larger word
  // and never inside an existing {{...}} placeholder. A raw split/join (the old behaviour) jammed
  // short role values like "ESS" inside words → "s{{role}}ion" (session) corruption. The
  // lookarounds reject an adjacent alphanumeric OR brace on either side, so corruption is impossible
  // by construction. Generic — no site/word-specific logic.
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![A-Za-z0-9{])${escaped}(?![A-Za-z0-9}])`, 'g');
  return text.replace(re, token);
}

function repairUploadedLiteralsInCase(caseObj, testData, binding) {
  const replacements = literalReplacementsForBinding(testData, binding);
  if (!replacements.length) return { count: 0, replacements: [] };
  let count = 0;
  const used = [];
  transformStrings(caseObj, (text, key) => {
    if (key && !DATA_LITERAL_KEYS.has(key)) return text;
    let next = String(text);
    for (const item of replacements) {
      if (!next.includes(item.value)) continue;
      next = replaceAllLiteral(next, item.value, item.token);
      count += 1;
      used.push({ header: item.header, role: item.role, token: item.token });
    }
    return next;
  });
  return { count, replacements: used };
}

// (removed) bestBindingForLeaks — Step 4 retired literal-leak auto-binding. A value
// coincidentally appearing in a sheet is not proof of membership, so the no-signal
// fallback no longer binds on leaks; it warns + leaves the case unbound. See the
// no-binding branch in markDataAwareCases.

function rowSelectorForCase(caseObj, binding) {
  if (!binding || !binding.rowClassColumn) return null;
  const text = walkStrings({
    name: caseObj && caseObj.name,
    type: caseObj && caseObj.type,
    assertions: caseObj && caseObj.assertions,
  }).join(' ').toLowerCase();
  if (/\b(negative|invalid|error|empty|blank|boundary|mandatory|required)\b/.test(text)) return 'negative';
  if (/\b(positive|valid|success|happy path)\b/.test(text)) return 'positive';
  return null;
}

function buildBinding(caseObj, binding, placeholders, reason, extraFindings = []) {
  const placeholderSet = new Set(placeholders);
  const roleSet = rolesForBinding(binding);
  const findings = Array.isArray(extraFindings) ? [...extraFindings] : [];
  for (const token of placeholders) {
    if (!roleSet.has(token)) {
      // Authoring-quality, not missing data: the case used a placeholder the mapping doesn't
      // know. Advisory only — never blocks a binding whose sheet exists.
      findings.push({ code: 'data_placeholder_not_in_mapping', severity: 'warning', token, sheet: binding.sheet });
    }
  }
  const mappedInputRoles = Object.keys(binding.columnToField || {});
  const usedInputRoles = mappedInputRoles.filter((role) => placeholderSet.has(role));
  if (mappedInputRoles.length && !usedInputRoles.length) {
    findings.push({ code: 'data_input_placeholders_missing', severity: 'warning', sheet: binding.sheet, roles: mappedInputRoles });
  }
  if (binding.expectedColumn && !placeholderSet.has('expected')) {
    findings.push({ code: 'data_expected_placeholder_missing', severity: 'warning', sheet: binding.sheet, expectedColumn: binding.expectedColumn });
  }

  // A binding is 'incomplete' ONLY when its sheet/column genuinely does not exist (structural).
  // The findings above are authoring-quality (the Architect used a literal, omitted a placeholder,
  // or named an unmapped role) — they are advisory and must NOT mark a valid binding incomplete or
  // surface a "Data incomplete" badge. When the user supplied the data, the platform delivers it.
  const out = {
    sheet: binding.sheet,
    status: findings.some((f) => f.severity === 'error' && STRUCTURAL_DATA_ERRORS.has(f.code)) ? 'incomplete' : 'complete',
    source: reason,
    placeholders,
  };
  const scope = inlineCaseInstanceContract.caseScopeId(caseObj || {});
  if (scope) out.caseScopeId = scope;
  const selector = caseObj?.dataBinding?.rowSelector || rowSelectorForCase(caseObj, binding);
  if (selector) out.rowSelector = String(selector).slice(0, 60);
  if (binding.columnToField && typeof binding.columnToField === 'object') out.columnToField = binding.columnToField;
  if (binding.expectedColumns && typeof binding.expectedColumns === 'object') out.expectedColumns = binding.expectedColumns;
  if (binding.expectedColumn) out.expectedColumn = binding.expectedColumn;
  if (binding.rowClassColumn) out.rowClassColumn = binding.rowClassColumn;
  if (findings.length) out.findings = findings;
  return out;
}

// Credential / identity role names a login step needs (generic word-shape, never a
// site string). These are the roles the RUNTIME can join from a companion auth sheet
// (testDataMatrix.findCompanionCredentialSource) when the primary oracle sheet doesn't
// carry them.
function isCredentialRoleToken(token) {
  const k = tokenKey(token);
  return /^(login)?(username|user|userid|loginusername|email|account|accountid|employeeid)$/.test(k)
    || /^(login)?(password|pass|pwd|passwd|passcode|secret|loginpassword|pin|otp)$/.test(k);
}

// Fix 1 (multi-source data binding) — a case may legitimately need data from MORE than
// its primary oracle sheet: e.g. a Dashboard case binds to Dashboard_QuickLaunch (the
// oracle) but its login step needs {{username}}/{{loginpassword}} which live in an
// ExecutionProfiles / auth sheet. When the primary binding can't fill a CREDENTIAL role
// but a companion auth sheet (one carrying both an identity and a password column) in
// the SAME mapping supplies it, record that sheet as a `companions[]` source and clear
// the unmapped-token flag for those roles (the runtime cred-join sources them). A role
// NO companion supplies stays flagged → the CaseCompiler still blocks it (Fix 4: resolve
// if possible, else block — never fake a pass). Generic: keyed on column word-shape.
function attachCredentialCompanions(binding, bindings) {
  if (!binding || !binding.sheet || !Array.isArray(binding.findings)) return;
  const unmappedCred = binding.findings.filter((f) => f && f.code === 'data_placeholder_not_in_mapping' && isCredentialRoleToken(f.token));
  if (!unmappedCred.length) return;
  const companions = [];
  const supplied = new Set();
  for (const b of (Array.isArray(bindings) ? bindings : [])) {
    if (!b || !b.sheet || String(b.sheet).toLowerCase() === String(binding.sheet).toLowerCase()) continue;
    const c2f = (b.columnToField && typeof b.columnToField === 'object') ? b.columnToField : {};
    const roles = Object.keys(c2f);
    const looksAuth = roles.some((r) => /user|login|email|account/i.test(r)) && roles.some((r) => /pass|pwd|secret/i.test(r));
    if (!looksAuth) continue; // a companion must be a real identity+password source
    const sub = {};
    for (const f of unmappedCred) {
      const rk = tokenKey(f.token);
      for (const [role, header] of Object.entries(c2f)) {
        if (tokenKey(role) === rk || tokenKey(header) === rk) { sub[role] = header; supplied.add(rk); }
      }
    }
    if (Object.keys(sub).length) companions.push({ sheet: b.sheet, columnToField: sub, source: 'credential_companion' });
  }
  if (!companions.length) return; // no companion supplies them → leave the hard block (honest)
  binding.companions = companions;
  binding.needsReview = true;
  // Replace the HARD unmapped-token block (which the CaseCompiler would treat as a
  // blocker) with a needs_review AUTHORING DEFECT: a companion auth sheet CAN supply
  // these credential roles, but this is a multi-source binding — the primary oracle
  // sheet does not carry them, and the runtime credential-join must resolve them. This
  // is surfaced for review, never silently promoted to "ready" and never a fake pass
  // (Fix 4: resolvable-by-companion → needs_review with a clear defect, not blocked).
  binding.findings = binding.findings.filter((f) => !(f.code === 'data_placeholder_not_in_mapping' && supplied.has(tokenKey(f.token))));
  binding.findings.push({ code: 'multi_source_credential_binding', severity: 'warning', roles: [...supplied], companions: companions.map((c) => c.sheet), detail: `login/identity roles (${[...supplied].join(', ')}) are NOT on the primary sheet "${binding.sheet}" — they must be sourced from companion auth sheet(s) [${companions.map((c) => c.sheet).join(', ')}] at run time. Review the multi-source binding before approval.` });
}

function markDataAwareCases(scenarios, testData, opts = {}) {
  let workbookContract = null;
  try { workbookContract = buildWorkbookContract({ sheets: sheetsFor(testData) }); } catch (_) { workbookContract = null; }
  const bindings = mappingEligibleBindings(testData, workbookContract);
  const stats = {
    bindingCount: bindings.length,
    assigned: 0,
    hydrated: 0,
    incomplete: 0,
    invalidSheet: 0,
    uncoveredSheets: [],
  };
  if (!Array.isArray(scenarios) || !bindings.length) return stats;

  const usedSheets = new Set();
  // Step 3B — the canonical WorkbookContract (data-oracle) for storyId-first
  // binding, built once from the same sheets. opts.clauseStoryIndex maps a
  // requirement ref → its storyId so a case's storyId can be derived here.
  const clauseStoryIndex = opts.clauseStoryIndex || null;
  // Step 3C — index CoverageItems by id so an architect-cited coverageItemId binds
  // to the exact (sheet, storyId) unit (the strongest, most explicit signal).
  const coverageItemById = new Map();
  try { for (const ci of (workbookContract ? buildCoverageItems(workbookContract) : [])) coverageItemById.set(ci.id, ci); } catch (_) { /* contract unavailable */ }
  for (const scenario of scenarios) {
    const cases = Array.isArray(scenario && scenario.cases) ? scenario.cases : [];
    for (const caseObj of cases) {
      if (!caseObj || typeof caseObj !== 'object') continue;
      let binding = null;
      let placeholders = placeholdersInCase(caseObj);
      let reason = 'explicit';
      const initialLiteralLeaks = literalLeaksInCase(caseObj, testData);

      // ── storyId-FIRST (beats keyword/intent AND the architect's explicit guess) ──
      // A data-driven case whose storyId matches a workbook sheet/row binds THERE,
      // to ONLY its story's rows. A cited storyId no sheet carries → needs_review
      // (never a guessed sheet); module match is the next preference. These binds
      // `continue` BEFORE the keyword/explicit branches + in-function repair, so a
      // strong storyId match is never overridden (req 6).
      // storyId-first runs whenever there is a real story/coverage signal to reconcile
      // — NOT only when the case uses {{placeholders}}. A case with a derivable storyId
      // (or a cited CoverageItem) but NO tokens must STILL bind to the sheet its story
      // lives in (or flag a conflict); otherwise the architect's explicit/keyword sheet
      // wins and produces a storyId↔sheet mismatch (v5: US-OHRM-005→MyInfo, 003→Leave,
      // both authored with no {{tokens}}). The weaker none/module branches stay gated on
      // placeholders so a no-token case whose storyId does NOT resolve falls through to
      // the explicit/else path unchanged (no over-flagging of page-load/non-data cases).
      const sid = caseStoryIdFor(caseObj, clauseStoryIndex);
      const citedCi = (caseObj.coverageItemId && coverageItemById.has(caseObj.coverageItemId)) ? coverageItemById.get(caseObj.coverageItemId) : null;
      if (workbookContract && (placeholders.length || sid || citedCi)) {
        const res = resolveStoryBinding({ storyId: sid, module: caseObj.module }, workbookContract);
        const nsid = sid ? normalizeStoryId(sid) : null;
        const ciStory = citedCi && citedCi.storyId ? normalizeStoryId(citedCi.storyId) : null;
        if (process.env.QAAI_DEBUG_BINDING) {
          try { console.log(`[bind-debug] "${String(caseObj.name).slice(0,60)}" refs=${JSON.stringify(caseObj.requirementRefs||[])} sid=${sid||'-'} citedCI=${citedCi?citedCi.id:'-'} ciStory=${ciStory||'-'} resolver=${res?res.matchKind+':'+res.sheet:'null'}`); } catch (_) {}
        }
        // Fix 3 — canonicalize placeholder CASING/aliases against the TARGET sheet's
        // mapping BEFORE building the binding, on EVERY strong-bind path. The LLM emits
        // {{searchterminput}} but the column/role is searchTermInput; without this the
        // token stays unmapped and the CaseCompiler blocks the case. Runs for storyId,
        // coverageItem, and module binds alike (previously it ran only on the late
        // keyword path, so strong binds shipped un-canonicalized tokens).
        const bindStrong = (sheet, matchKind, extra) => {
          const b = findBindingBySheet(bindings, sheet) || { sheet };
          canonicalizePlaceholdersInCase(caseObj, b);
          const ph = placeholdersInCase(caseObj);
          const reason = matchKind === 'storyId' ? 'story_id_match' : (matchKind === 'module' ? 'module_match' : 'coverage_item');
          const built = buildBinding(caseObj, b, ph, reason, []);
          built.matchKind = matchKind;
          Object.assign(built, extra || {});
          attachCredentialCompanions(built, bindings); // Fix 1 — multi-source credential companions
          caseObj.dataBinding = built;
          usedSheets.add(sheet);
          stats.assigned += 1;
          return built;
        };
        const ciExtra = () => ({
          coverageItemId: citedCi.id,
          ...(citedCi.storyId ? { storyId: citedCi.storyId } : {}),
          ...(citedCi.storyColumn ? { storyColumn: citedCi.storyColumn } : {}),
          ...(citedCi.rowSelector ? { rowSelector: citedCi.rowSelector } : {}),
        });

        // Fix 2 — a cited CoverageItem is the MOST SPECIFIC signal when it is CONSISTENT
        // with the case's story: its storyId matches (the story has >1 valid sheet and
        // the CI names the EXACT one — e.g. GlobalSearch_Menu vs Menu_Navigation, both
        // carry US-OHRM-002), OR the case has no derivable storyId (trust the citation).
        // Honor it directly — do NOT let the resolver's "best/most-rows" sheet override
        // a citation whose storyId already matches.
        if (citedCi && (!nsid || (ciStory && ciStory === nsid))) {
          bindStrong(citedCi.sheet, 'coverageItem', ciExtra());
          continue;
        }
        // Authoritative storyId sheet.
        if (res && res.matchKind === 'storyId') {
          // Fix 3 — STORY_ID_CONFLICT. The ref-derived storyId (sid) and a cited
          // CoverageItem BOTH name VALID but DIFFERENT stories that each resolve to a
          // real sheet (e.g. requirementRef → US-OHRM-013/Claim_Submit vs cited CI →
          // a module-specific requirement). The Architect likely mis-assigned a requirementRef, so
          // NEITHER is trustworthy — do NOT blindly bind to the ref-storyId sheet (that
          // is what bound one module's case to another module's data and then blocked missing tokens).
          // Leave it unbound + needs_review with a clear story_id_conflict defect for a
          // human to resolve. Only a cited CI that resolves to its OWN real, different
          // story triggers this; a citation with no/absent story (e.g. an all-rows CI)
          // is NOT a conflict — that falls through to the storyId bind + mismatch flag.
          const citedRealStory = citedCi && citedCi.storyId ? normalizeStoryId(citedCi.storyId) : null;
          const citedResolves = citedRealStory && citedRealStory !== nsid
            ? resolveStoryBinding({ storyId: citedCi.storyId, module: null }, workbookContract) : null;
          if (citedResolves && citedResolves.matchKind === 'storyId') {
            caseObj.dataBinding = {
              sheet: null,
              matchKind: 'needs_review',
              needsReview: true,
              source: 'story_id_conflict',
              findings: [{ code: 'story_id_conflict', severity: 'warning', detail: `requirementRef storyId ${res.storyId} (→ "${res.sheet}") conflicts with the architect-cited CoverageItem ${citedCi.id} storyId ${citedCi.storyId} (→ "${citedResolves.sheet}"). Not auto-bound — the story/requirement assignment must be corrected before approval.` }],
            };
            stats.incomplete += 1;
            continue;
          }
          const built = bindStrong(res.sheet, 'storyId', {
            storyId: res.storyId,
            ...(res.storyColumn ? { storyColumn: res.storyColumn } : {}),
            rowSelector: `story:${res.storyId}`,
          });
          // A cited CI with no/absent story that points at a DIFFERENT sheet is a wrong
          // citation (not a competing story) → bind by storyId, flag the bad citation.
          if (citedCi && String(citedCi.sheet || '').toLowerCase() !== String(res.sheet || '').toLowerCase()) {
            built.findings = [...(built.findings || []), { code: 'coverage_item_story_mismatch', severity: 'warning', detail: `architect cited ${citedCi.id} (sheet "${citedCi.sheet}", story ${citedCi.storyId || 'none'}) but the case storyId ${res.storyId} lives in "${res.sheet}" — bound by storyId (citation ignored)` }];
          }
          continue;
        }
        // No authoritative story sheet, but a cited CI exists → honor it as the fallback.
        if (citedCi) {
          bindStrong(citedCi.sheet, 'coverageItem', ciExtra());
          continue;
        }
        // none/module are WEAKER signals — only act on token-bearing (data-driven) cases.
        // A no-token case whose storyId isn't in the workbook (or only matches by module)
        // is left to the explicit/else path unchanged, so page-load / non-data cases with
        // an incidental storyId are not newly flagged or force-bound.
        if (placeholders.length && res && res.matchKind === 'none' && res.needsReview) {
          caseObj.dataBinding = { sheet: null, status: 'incomplete', source: 'story_id_unmatched', matchKind: 'needs_review', findings: [{ code: 'story_id_no_data', severity: 'warning', detail: res.reason }] };
          stats.incomplete += 1;
          continue;
        }
        if (placeholders.length && res && res.matchKind === 'module') {
          bindStrong(res.sheet, 'module', {});
          continue;
        }
      }

      if (caseObj.dataBinding && typeof caseObj.dataBinding === 'object' && caseObj.dataBinding.sheet) {
        binding = findBindingBySheet(bindings, caseObj.dataBinding.sheet);
        if (!binding) {
          caseObj.dataBinding = {
            sheet: String(caseObj.dataBinding.sheet).slice(0, 120),
            status: 'incomplete',
            source: 'explicit',
            findings: [{ code: 'data_binding_sheet_not_found', severity: 'error', sheet: caseObj.dataBinding.sheet }],
          };
          stats.invalidSheet += 1;
          stats.incomplete += 1;
          continue;
        }
        // #3.2 — an EXPLICIT binding that CONTRADICTS case intent is a generation/
        // data-binding defect, caught BEFORE approval (not only at runtime). A
        // negative/invalid/empty-field/rejection case must not declare AuthProfiles
        // (the positive identity sheet) as its primary row matrix — that is what
        // ran valid-login rows under a "remain on login" oracle (run 91d6301a).
        {
          let __intent = null;
          try { __intent = deriveCaseOracleIntent(caseObj); } catch (_) { __intent = null; }
          if (__intent === 'negative' && sheetIntentClass(binding) === 'positive_identity' && !bindingHasNegativeRows(binding, testData)) {
            caseObj.dataBinding = {
              sheet: String(caseObj.dataBinding.sheet).slice(0, 120),
              status: 'incomplete',
              source: 'explicit',
              findings: [{
                code: 'data_binding_intent_mismatch', severity: 'error', sheet: caseObj.dataBinding.sheet,
                detail: 'negative/invalid case explicitly bound to a positive identity sheet with no compatible negative/validation rows; rebind before approval',
              }],
            };
            stats.invalidSheet += 1;
            stats.incomplete += 1;
            continue;
          }
        }
        stats.hydrated += 1;
      } else {
        const chosen = chooseBinding(caseObj, scenario, bindings, opts.moduleScope);
        binding = chosen.binding;
        placeholders = chosen.placeholders;
        // Step 4 — a literal value merely APPEARING in a sheet is NOT proof the case
        // belongs to that sheet. Every legitimate signal (storyId / coverageItem /
        // module / explicit sheet / placeholder-keyword match) has already `continue`d
        // or set `binding` above; reaching here with no binding means there is NO such
        // proof. Auto-binding on the literal leak alone bound page-load/smoke cases to
        // a data matrix by coincidence and ran them as data-driven. So: warn only —
        // leave the case UNBOUND (sheet:null → not data-driven), surfaced as
        // needs_review when a leak exists so the Architect's copied-literal is visible
        // but never silently made into a data binding. A case that consumes row values
        // would have placeholders → chooseBinding would have matched it.
        if (!binding) {
          if (initialLiteralLeaks.length) {
            const leak0 = initialLiteralLeaks[0];
            caseObj.dataBinding = {
              sheet: null,
              matchKind: 'needs_review',
              needsReview: true,
              source: 'literal_leak_only',
              findings: [{
                code: 'data_literal_without_binding',
                severity: 'warning',
                sheet: leak0.sheet,
                header: leak0.header,
                valuePreview: String(leak0.value).slice(0, 80),
                detail: 'case carries an uploaded data value as a literal but has no storyId / coverageItem / module / placeholder binding signal — NOT auto-bound to a sheet (a literal match is not proof of membership). Tokenize and cite a CoverageItem, or confirm this is a non-data case.',
              }],
            };
            stats.incomplete += 1;
          }
          continue;
        }
        reason = 'placeholder_match';
        stats.assigned += 1;
      }
      const placeholderRepairCount = canonicalizePlaceholdersInCase(caseObj, binding);
      const literalRepair = repairUploadedLiteralsInCase(caseObj, testData, binding);
      placeholders = placeholdersInCase(caseObj);
      if (placeholderRepairCount || literalRepair.count) reason = 'deterministic_repair';
      // Suppress false leaks: if the case already uses the {{role}} placeholder that this binding
      // maps to the leaked value's header, the value is correctly tokenized — not a leak.
      const headerToRoleForBinding = {};
      for (const [role, header] of Object.entries(binding.columnToField || {})) headerToRoleForBinding[String(header)] = role;
      if (binding.expectedColumn) headerToRoleForBinding[String(binding.expectedColumn)] = 'expected';
      const placeholderSetForLeaks = new Set(placeholders.map((p) => String(p).toLowerCase()));
      const literalLeaks = literalLeaksInCase(caseObj, testData).filter((leak) => {
        const role = headerToRoleForBinding[String(leak.header)];
        return !(role && placeholderSetForLeaks.has(String(role).toLowerCase()));
      });
      const leakFindings = literalLeaks.map((leak) => ({
        // Advisory: the case carries a raw uploaded value instead of a {{placeholder}}. The
        // coverage planner rewrites these to tokens; this never marks the binding incomplete.
        code: 'data_literal_from_uploaded_sheet',
        severity: 'warning',
        sheet: leak.sheet,
        header: leak.header,
        rowIndex: leak.rowIndex,
        valuePreview: String(leak.value).slice(0, 80),
        message: 'Architect copied an uploaded data value into the case instead of using a {{placeholder}} bound to the sheet mapping.',
      }));
      const repairFindings = [];
      if (placeholderRepairCount) {
        repairFindings.push({ code: 'data_placeholder_canonicalized', severity: 'info', count: placeholderRepairCount, sheet: binding.sheet });
      }
      if (literalRepair.count) {
        repairFindings.push({ code: 'data_literal_rewritten_to_token', severity: 'info', count: literalRepair.count, sheet: binding.sheet });
      }
      caseObj.dataBinding = buildBinding(caseObj, binding, placeholders, reason, [...repairFindings, ...leakFindings]);
      attachCredentialCompanions(caseObj.dataBinding, bindings); // Fix 1 — multi-source credential companions
      // Step 3B — label the binding's provenance. An EXPLICIT (architect-named,
      // hydrated) sheet is medium-confidence; a SEMANTIC keyword/literal match is
      // the WEAK last resort → flag needs_review so it's never silently treated as
      // a confident, complete bind (storyId/module binds returned earlier).
      if (!caseObj.dataBinding.matchKind) {
        caseObj.dataBinding.matchKind = (reason === 'explicit') ? 'explicit' : 'semantic';
        if (caseObj.dataBinding.matchKind === 'semantic' && caseObj.dataBinding.status !== 'incomplete') {
          caseObj.dataBinding.needsReview = true;
          caseObj.dataBinding.findings = [...(caseObj.dataBinding.findings || []), { code: 'weak_semantic_binding', severity: 'warning', detail: 'bound by token/keyword overlap only — no storyId or module match. Review before approval.' }];
        }
      }
      usedSheets.add(binding.sheet);
      if (caseObj.dataBinding.status === 'incomplete') stats.incomplete += 1;
    }
  }

  const moduleScoped = bindings.filter((b) => bindingModuleMatches(b, {}, opts.moduleScope));
  stats.uncoveredSheets = moduleScoped
    .filter((b) => b.purpose !== 'auth_profiles' && !usedSheets.has(b.sheet))
    .map((b) => ({ sheet: b.sheet, purpose: b.purpose, module: b.module || null }));
  return stats;
}

// ── Deterministic coverage closer (parameterize-and-bind) ───────────────────
// markDataAwareCases only binds cases that ALREADY use {{placeholders}}. But the
// LLM routinely authors CONCRETE cases with invented literal values — so a
// variation sheet (NegativeAuth/SecurityAuth/FormValidation: many rows exercising
// the SAME flow with different inputs/outcomes) ends up with NO bound case and its
// rows go unused. This pass closes that gap deterministically: for each uncovered
// variation sheet it picks the best representative concrete case, swaps its INPUT
// fill-step literals for {{role}} tokens (from columnToField), and binds it
// (rowSelector 'all') so the SAME case now iterates EVERY row. It reuses the LLM's
// correct flow — only the inputs become tokens. Site-independent (keys off field
// role tokens + the approved mapping, never a site string).
const INPUT_ROLE_RE = /^(username|user|userid|email|login|loginusername|password|pass|pwd|otp|code|payload|usernamepayload|passwordpayload|search|query|term|searchterm|name|firstname|lastname|employeename|input|value)$/i;

function matchFillStepRole(step, roles) {
  if (!step) return null;
  if (!/\b(fill|type|enter|input|set)\b/i.test(String(step.action || ''))) return null;
  const label = String(step.element || step.target || step.locator_hint || '').toLowerCase();
  if (!label) return null;
  let bestRole = null, bestLen = -1;
  for (const role of roles) {
    const r = String(role).toLowerCase();
    if (!r || r === 'expected' || r === 'scenario' || r === 'attacktype' || r === 'shouldsubmit' || r === 'shouldcrash' || r === 'shouldrender' || r === 'shouldredirect') continue;
    if (!INPUT_ROLE_RE.test(r)) continue;
    const hit = label.includes(r)
      || (/pass/.test(r) && /pass/.test(label))
      || (/user/.test(r) && /user/.test(label))
      || (/email/.test(r) && /email/.test(label))
      || (/(name|employee)/.test(r) && /name/.test(label));
    if (hit && r.length > bestLen) { bestRole = role; bestLen = r.length; }
  }
  return bestRole;
}

function bindUncoveredDataSheets(scenarios, testData, opts = {}) {
  const stats = { synthesized: 0, sheets: [] };
  let workbookContract = null;
  try { workbookContract = buildWorkbookContract({ sheets: sheetsFor(testData) }); } catch (_) { workbookContract = null; }
  const bindings = mappingEligibleBindings(testData, workbookContract);
  if (!Array.isArray(scenarios) || !bindings.length) return stats;

  const bound = new Set();
  for (const sc of scenarios) for (const c of (sc && sc.cases) || []) {
    if (c && c.dataBinding && c.dataBinding.sheet) bound.add(String(c.dataBinding.sheet).toLowerCase());
  }

  for (const b of bindings) {
    if (!b || !b.sheet) continue;
    if (bound.has(String(b.sheet).toLowerCase())) continue;
    if (!bindingModuleMatches(b, {}, opts.moduleScope)) continue;
    const roles = Object.keys(b.columnToField || {});
    const inputRoles = roles.filter((r) => INPUT_ROLE_RE.test(r));
    if (!inputRoles.length) continue;
    // Only iterate VARIATION sheets (rows vary the same flow). A pure identity
    // sheet (auth_profiles with no expected/row-class column) is NOT auto-bound —
    // those provide identities, not a credential matrix (matches the prompt rule).
    const isVariation = !!(b.expectedColumn || b.rowClassColumn) || (b.purpose && b.purpose !== 'auth_profiles');
    if (!isVariation) continue;

    let best = null;
    for (const sc of scenarios) {
      if (!bindingModuleMatches(b, sc, opts.moduleScope)) continue;
      for (const c of (sc && sc.cases) || []) {
        if (!c || c.dataBinding || !Array.isArray(c.steps)) continue;
        const matched = new Set();
        for (const s of c.steps) { const role = matchFillStepRole(s, roles); if (role) matched.add(role); }
        if (matched.size && (!best || matched.size > best.size)) best = { c, size: matched.size };
      }
    }
    if (!best) continue;

    const placeholders = [];
    for (const s of best.c.steps) {
      const role = matchFillStepRole(s, roles);
      if (role) { s.value = `{{${role}}}`; if (!placeholders.includes(role)) placeholders.push(role); }
    }
    if (!placeholders.length) continue;
    best.c.dataBinding = buildBinding(best.c, b, placeholders, 'synthesized_coverage', []);
    bound.add(String(b.sheet).toLowerCase());
    stats.synthesized += 1;
    stats.sheets.push(b.sheet);
  }
  return stats;
}

module.exports = {
  markDataAwareCases,
  bindUncoveredDataSheets,
  placeholdersInCase,
  bindingsFor,
  mappingEligibleBindings,
  // exported for the binding-intent guard
  chooseBinding,
  scoreBinding,
  sheetIntentClass,
};
