'use strict';

/**
 * dataMapper (TestData Round A — M-B). Binds an uploaded test-data workbook to
 * the user stories / scenarios it exercises, "pin to pin": which COLUMN feeds
 * which step FIELD, which column states the EXPECTED outcome, and which column
 * (if any) classifies a row as positive / negative / boundary.
 *
 * WHY MOSTLY DETERMINISTIC (CLAUDE.md — Node unless genuine novelty): header
 * names and sheet names carry the mapping the vast majority of the time
 * ("Username"/"password"/"Expected Result", a sheet called "Login"). Those joins
 * are a synonym table + a fuzzy name match — pure Node, zero tokens. Only the
 * genuinely AMBIGUOUS residue (a header that matches no known role, a sheet that
 * matches no scenario) is handed to ONE LLM call. With no provider, the mapper
 * returns the deterministic mapping alone — it never REQUIRES an LLM to work.
 *
 * Pure module: no prisma, no fs. The route loads TestDataSet.sheetsJson + the
 * project's scenarios, calls mapTestData(), and persists the returned mappingJson.
 * Output contract (frozen):
 *   { version, bindings:[{ sheet, scenarioName?, module?, columnToField:{role:header},
 *                          expectedColumn?, rowClassColumn?, confidence }], unmapped:[{sheet,header}] }
 */

const MAPPING_VERSION = 1;
const { isNonExecutableSheet } = require('../testDataSheetPolicy');

// Canonical input-field roles a step might consume → header synonyms (normalised).
// Order matters: more specific roles are tested before generic ones (firstName
// before name, email before a bare "user"), so "First Name" never collapses to "name".
const FIELD_SYNONYMS = [
  ['testCaseId', ['testcaseid', 'testcase', 'tcid', 'caseid', 'testid', 'id']],
  ['scenarioName', ['scenarioname', 'scenario', 'testscenario', 'casename', 'testname', 'description']],
  ['firstName', ['firstname', 'fname', 'givenname', 'forename']],
  ['lastName', ['lastname', 'lname', 'surname', 'familyname']],
  ['fullName', ['fullname', 'name', 'displayname', 'contactname', 'employeename']],
  ['email', ['email', 'emailaddress', 'mail', 'useremail']],
  ['username', ['username', 'user', 'userid', 'login', 'loginid', 'userName', 'account']],
  ['password', ['password', 'passwd', 'pwd', 'pass', 'secret']],
  ['phone', ['phone', 'mobile', 'phonenumber', 'mobilenumber', 'contactnumber', 'tel']],
  ['otp', ['otp', 'code', 'verificationcode', 'onetimecode', 'pin', 'token']],
  ['search', ['search', 'searchterm', 'query', 'keyword', 'searchtext', 'q']],
  ['searchName', ['searchname', 'searchproduct', 'productsearch', 'productname', 'searchproductname']],
  ['inputValue', ['inputvalue', 'payload', 'payloadvalue', 'testinput', 'enteredvalue', 'value']],
  ['expectedMessage', ['expectedmessage', 'expectedmsg', 'validationmessage', 'errormessage', 'expectederrormessage']],
  ['expectedContainsProductName', ['expectedcontainsproductname', 'expectedproductname', 'expectedcontainsname', 'containsproductname']],
  ['assertProductCategory', ['assertproductcategory', 'expectedcategory', 'productcategory', 'categoryassertion']],
  ['assertProductPrice', ['assertproductprice', 'expectedprice', 'productprice', 'priceassertion']],
  ['priceMin', ['pricemin', 'minprice', 'minimumprice', 'fromprice', 'lowprice']],
  ['priceMax', ['pricemax', 'maxprice', 'maximumprice', 'toprice', 'highprice']],
  ['assertOperator', ['assertoperator', 'operator', 'comparison', 'assertionoperator', 'matchoperator']],
  ['expectedResult', ['expectedresult', 'expectedoutcome', 'expectedstatus', 'result']],
  ['amount', ['amount', 'price', 'total', 'cost', 'value', 'fee', 'salary', 'balance']],
  ['quantity', ['quantity', 'qty', 'count', 'units', 'number']],
  ['date', ['date', 'dob', 'dateofbirth', 'startdate', 'enddate', 'joindate']],
  ['city', ['city', 'town']],
  ['state', ['state', 'province', 'region']],
  ['country', ['country', 'nation']],
  ['zip', ['zip', 'zipcode', 'postal', 'postalcode', 'pincode', 'postcode']],
  ['address', ['address', 'street', 'addressline', 'address1', 'addressline1']],
  ['company', ['company', 'organisation', 'organization', 'employer', 'org']],
  ['role', ['role', 'usertype', 'userrole', 'accounttype', 'designation', 'jobtitle', 'title']],
  ['url', ['url', 'link', 'website', 'endpoint']],
  ['comment', ['comment', 'description', 'notes', 'remark', 'message', 'desc']],
];

// Columns that DESCRIBE a row rather than feed an input.
const EXPECTED_RE = /^(expected|result|outcome|assert|verif|expectation|expected\s*result|expected\s*outcome)/i;
const ERROR_RE = /(error|err\b|failure|reason|validation\s*message|error\s*message)/i;
const ROWCLASS_RE = /^(type|case\s*type|scenario\s*type|test\s*type|category|valid(ity)?|positive|negative|pos\s*\/\s*neg|polarity)$/i;
const METADATA_RE = /^(id|row\s*id|rowid|test\s*case\s*id|testcaseid|tcid|case\s*id|caseid|scenario\s*id|scenarioid|notes?|comments?|remarks?|description|sensitivity)$/i;

/** Lowercase + strip everything but a-z0-9 — the join key for header/role/name matching. */
function norm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Tokenise a name into normalised words (for fuzzy sheet↔scenario overlap). */
function tokens(s) {
  return String(s == null ? '' : s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Map a single header to a canonical input-field role, or null if unknown.
 * Exact normalised match first (username === "User Name"), then a contained-word
 * check so "Login Username" still resolves to username. Never matches the
 * special expected/error/rowclass columns — those are handled separately.
 */
function headerToRole(header) {
  const h = norm(header);
  if (!h) return null;
  if (isExpectedHeader(header) || isErrorHeader(header) || isRowClassHeader(header)) return null;
  for (const [role, syns] of FIELD_SYNONYMS) {
    if (syns.some((s) => h === norm(s))) return role;
  }
  for (const [role, syns] of FIELD_SYNONYMS) {
    if (syns.some((s) => { const n = norm(s); return n.length >= 4 && h.includes(n); })) return role;
  }
  return null;
}

function rawHeaderRole(header) {
  const raw = String(header || '').trim();
  if (!raw) return null;
  const parts = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  if (!parts.length) return null;
  const [first, ...rest] = parts;
  const role = String(first).charAt(0).toLowerCase() + String(first).slice(1)
    + rest.map((p) => String(p).charAt(0).toUpperCase() + String(p).slice(1)).join('');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(role)) return null;
  if (role.length > 64) return role.slice(0, 64);
  return role;
}

function isExpectedHeader(h) { return EXPECTED_RE.test(String(h || '').trim()); }
function isErrorHeader(h) { return ERROR_RE.test(String(h || '').trim()); }
function isRowClassHeader(h) { return ROWCLASS_RE.test(String(h || '').trim()); }
function isMetadataHeader(h) { return METADATA_RE.test(String(h || '').trim()); }

/**
 * Best scenario for a sheet by token overlap of the sheet name against each
 * scenario's name + module. Returns { scenarioName, module, score } or null.
 * A sheet "Login Data" matches scenario "User Login" (token "login").
 */
function fuzzyScenarioForSheet(sheetName, scenarios) {
  const sheetTokens = new Set(tokens(sheetName));
  if (!sheetTokens.size || !Array.isArray(scenarios) || !scenarios.length) return null;
  let best = null;
  for (const sc of scenarios) {
    const cand = new Set([...tokens(sc.name), ...tokens(sc.module)]);
    let overlap = 0;
    for (const t of sheetTokens) if (cand.has(t) && t.length >= 3) overlap++;
    const score = overlap / sheetTokens.size;
    if (score > 0 && (!best || score > best.score)) {
      best = { scenarioName: sc.name, module: sc.module, score };
    }
  }
  // Require at least one solid shared token before claiming a match.
  return best && best.score >= 0.34 ? best : null;
}

/**
 * The deterministic pass: per sheet, classify each header (input role / expected
 * / error / rowclass / unknown) and fuzzy-match the sheet to a scenario.
 * Returns { bindings, unmapped, ambiguousColumns, ambiguousSheets } — the last
 * two feed the optional LLM residue pass.
 */
function deterministicMap({ sheets, scenarios }) {
  const list = Array.isArray(sheets) ? sheets : [];
  const bindings = [];
  const unmapped = [];
  const ambiguousColumns = []; // { sheet, header } with no role + not special
  const ambiguousSheets = [];  // sheet names with no confident scenario match
  const ignoredSheets = [];

  for (const sheet of list) {
    if (isNonExecutableSheet(sheet)) {
      ignoredSheets.push({ sheet: sheet && sheet.name, reason: 'non_executable_workbook_metadata' });
      continue;
    }
    const name = sheet && sheet.name;
    const headers = Array.isArray(sheet && sheet.headers) ? sheet.headers : [];
    const columnToField = {};
    let expectedColumn;
    let rowClassColumn;

    for (const header of headers) {
      if (!header) continue;
      const role = headerToRole(header);
      if (role) { if (!columnToField[role]) columnToField[role] = header; continue; }
      if (!expectedColumn && (isExpectedHeader(header) || isErrorHeader(header))) { expectedColumn = header; continue; }
      if (!rowClassColumn && isRowClassHeader(header)) { rowClassColumn = header; continue; }
      if (isMetadataHeader(header)) continue;
      const rawRole = rawHeaderRole(header);
      if (rawRole && !columnToField[rawRole]) {
        columnToField[rawRole] = header;
        continue;
      }
      // Unknown column → leave for the LLM residue pass / the user to map.
      ambiguousColumns.push({ sheet: name, header });
      unmapped.push({ sheet: name, header });
    }

    const sc = fuzzyScenarioForSheet(name, scenarios);
    if (!sc) ambiguousSheets.push(name);
    const mappedInputs = Object.keys(columnToField).length;
    bindings.push({
      sheet: name,
      scenarioName: sc ? sc.scenarioName : undefined,
      module: sc ? sc.module : undefined,
      columnToField,
      expectedColumn,
      rowClassColumn,
      confidence: sc && mappedInputs > 0 ? 'high' : 'low',
    });
  }

  return { bindings, unmapped, ambiguousColumns, ambiguousSheets, ignoredSheets };
}

// ── LLM residue pass (only for the ambiguous remainder) ─────────────────────

function parseLooseJson(text) {
  if (!text || typeof text !== 'string') return null;
  let t = text.trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  try { return JSON.parse(t); } catch (_) {}
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (_) {} }
  return null;
}

const KNOWN_ROLES = FIELD_SYNONYMS.map(([r]) => r);

const MAPPER_SYSTEM_PROMPT = `You are a QA test-data mapping assistant. You bind spreadsheet COLUMNS to the input FIELD they feed, and SHEETS to the scenario they exercise. Only resolve the items explicitly listed as ambiguous — never re-map columns already mapped deterministically.
Return ONLY a JSON object, no prose, no markdown fences:
{
  "columnFields": { "<sheetName>": { "<header>": "<fieldRole>" } },   // fieldRole from the allowed list, or "ignore" if it is not an input (e.g. a row id / comment)
  "sheetScenario": { "<sheetName>": "<exact scenario name from the list>" }
}
Allowed fieldRoles: ${KNOWN_ROLES.join(', ')}. Use "ignore" for non-input columns. Omit anything you are unsure about rather than guessing.`;

function buildMapperUserMsg({ sheets, scenarios, ambiguousColumns, ambiguousSheets }) {
  const byName = new Map((sheets || []).map((s) => [s.name, s]));
  const ambSheetSet = new Set(ambiguousColumns.map((c) => c.sheet).concat(ambiguousSheets));
  const sheetViews = [...ambSheetSet].filter(Boolean).map((sn) => {
    const s = byName.get(sn) || {};
    const cols = ambiguousColumns.filter((c) => c.sheet === sn).map((c) => c.header);
    return {
      sheet: sn,
      ambiguousHeaders: cols,
      allHeaders: s.headers || [],
      sampleRows: (s.rows || []).slice(0, 2),
      needsScenario: ambiguousSheets.includes(sn),
    };
  });
  return JSON.stringify({
    scenarios: (scenarios || []).map((sc) => ({ name: sc.name, module: sc.module })),
    sheets: sheetViews,
  }, null, 2);
}

async function llmResolve({ sheets, scenarios, ambiguousColumns, ambiguousSheets, provider, apiKey, model }) {
  if (!provider || (!ambiguousColumns.length && !ambiguousSheets.length)) return null;
  let resp;
  try {
    resp = await provider.complete({
      apiKey, model, maxTokens: 1200,
      system: MAPPER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildMapperUserMsg({ sheets, scenarios, ambiguousColumns, ambiguousSheets }) }],
    });
  } catch (_) { return null; }
  const parsed = parseLooseJson(resp && resp.content && resp.content[0] && resp.content[0].text);
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed;
}

/** Fold the LLM's resolutions back into the deterministic bindings (validated). */
function applyLlmResolution(det, llm, scenarioNames) {
  if (!llm) return det;
  const roleSet = new Set(KNOWN_ROLES);
  const nameSet = new Set(scenarioNames);
  const bySheet = new Map(det.bindings.map((b) => [b.sheet, b]));
  const stillUnmapped = [];

  // columnFields: only honour a known role on an ambiguous header; "ignore"/unknown drop.
  const colFields = (llm.columnFields && typeof llm.columnFields === 'object') ? llm.columnFields : {};
  for (const u of det.unmapped) {
    const role = colFields[u.sheet] && colFields[u.sheet][u.header];
    const b = bySheet.get(u.sheet);
    if (b && role && role !== 'ignore' && roleSet.has(role) && !b.columnToField[role]) {
      b.columnToField[role] = u.header;
    } else {
      stillUnmapped.push(u);
    }
  }

  // sheetScenario: only accept an EXACT existing scenario name.
  const sheetScn = (llm.sheetScenario && typeof llm.sheetScenario === 'object') ? llm.sheetScenario : {};
  for (const b of det.bindings) {
    if (!b.scenarioName && nameSet.has(sheetScn[b.sheet])) {
      b.scenarioName = sheetScn[b.sheet];
      const sc = (scenarioNames._byName && scenarioNames._byName.get(b.scenarioName));
      if (sc) b.module = sc.module;
    }
    if (b.scenarioName && Object.keys(b.columnToField).length) b.confidence = 'high';
  }

  return { bindings: det.bindings, unmapped: stillUnmapped };
}

/**
 * Map a parsed workbook to the project's scenarios.
 * @param {object}   p
 * @param {Array}    p.sheets     [{ name, headers[], rows[] }]
 * @param {Array}    p.scenarios  [{ name, module }] (+ optional id)
 * @param {object}  [p.provider]  LLM provider (omit → deterministic-only, no tokens)
 * @param {string}  [p.apiKey] @param {string} [p.model] @param {Function} [p.send]
 * @returns {Promise<{version, bindings, unmapped}>}
 */
async function mapTestData({ sheets, scenarios, provider, apiKey, model, send } = {}) {
  const scn = Array.isArray(scenarios) ? scenarios : [];
  const det = deterministicMap({ sheets, scenarios: scn });

  let resolved = { bindings: det.bindings, unmapped: det.unmapped };
  if (provider && (det.ambiguousColumns.length || det.ambiguousSheets.length)) {
    const llm = await llmResolve({ sheets, scenarios: scn, ambiguousColumns: det.ambiguousColumns, ambiguousSheets: det.ambiguousSheets, provider, apiKey, model });
    if (llm) {
      const names = new Set(scn.map((s) => s.name));
      names._byName = new Map(scn.map((s) => [s.name, s]));
      resolved = applyLlmResolution(det, llm, names);
      if (send) {
        try { send({ type: 'agent.phase.log', phase: 'analyst', level: 'info', message: `🔗 Test-data mapping resolved ${det.ambiguousColumns.length} ambiguous column(s) via AI.` }); } catch (_) {}
      }
    }
  }

  return { version: MAPPING_VERSION, bindings: resolved.bindings, unmapped: resolved.unmapped, ignoredSheets: det.ignoredSheets || [] };
}

module.exports = {
  MAPPING_VERSION,
  // main
  mapTestData,
  // pure helpers (deterministic — unit-tested by verify_testdata.cjs)
  norm,
  headerToRole,
  rawHeaderRole,
  fuzzyScenarioForSheet,
  deterministicMap,
  isExpectedHeader,
  isErrorHeader,
  isRowClassHeader,
  isMetadataHeader,
  isNonExecutableSheet,
};
