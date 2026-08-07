'use strict';

const { replaceLiteralBoundaryAware } = require('./tokenHygiene');

const DATA_REPAIR_STOP = new Set([
  'pass', 'fail', 'true', 'false', 'yes', 'no', 'ok', 'n/a', 'na',
  'positive', 'negative', 'valid', 'invalid', 'admin', 'user',
]);

const STRUCTURAL_PATH_KEYS = new Set([
  'databinding',
  'databindingjson',
  'columntofield',
  'expectedcolumn',
  'expectedcolumns',
  'rowclasscolumn',
  'sheet',
  'headers',
  'findings',
  'placeholders',
  'testdatasetid',
  'mappingid',
  'mappingversion',
  'requirementrefs',
  'coveragerefs',
]);

const DATA_LITERAL_KEYS = new Set([
  'value',
  'input',
  'expected',
  'expectedtext',
  'expectedvalue',
  'expectedurl',
  'expectedurlpattern',
  'pagename',
  'assertions',
  'text',
  'contains',
  'equals',
  'expectedreturn',
  'message',
  'note',
]);

function normKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function parseJsonSafe(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function sheetRowsFor(testData, sheetName) {
  const sheets = Array.isArray(testData?.sheets)
    ? testData.sheets
    : (parseJsonSafe(testData?.sheetsJson, {})?.sheets || []);
  const wanted = normKey(sheetName);
  return sheets.find((s) => normKey(s && s.name) === wanted) || null;
}

function dataBindingsFor(testData) {
  const mapping = typeof testData?.mapping === 'string'
    ? parseJsonSafe(testData.mapping, null)
    : testData?.mapping;
  return Array.isArray(mapping?.bindings) ? mapping.bindings.filter((b) => b && b.sheet) : [];
}

function moduleMatchesForRepair(binding, moduleScope) {
  if (!moduleScope) return true;
  if (binding?.purpose === 'auth_profiles') return true;
  const wanted = normKey(moduleScope);
  const candidates = [binding?.moduleKey, binding?.module, binding?.sheet].filter(Boolean).map(normKey);
  return candidates.some((c) => c === wanted || c.includes(wanted) || wanted.includes(c));
}

function buildDataLiteralRepairs(testData, moduleScope = null) {
  const repairs = [];
  for (const binding of dataBindingsFor(testData)) {
    if (!moduleMatchesForRepair(binding, moduleScope)) continue;
    const sheet = sheetRowsFor(testData, binding.sheet);
    if (!sheet || !Array.isArray(sheet.rows)) continue;
    const roleToHeader = binding.columnToField && typeof binding.columnToField === 'object'
      ? binding.columnToField
      : {};
    const roles = Object.entries(roleToHeader).map(([role, header]) => ({ role, header }));
    if (binding.expectedColumn) roles.push({ role: 'expected', header: binding.expectedColumn });
    for (const { role, header } of roles) {
      if (!role || !header) continue;
      const sensitive = /(password|secret|token|otp|pin|key|credential)/i.test(`${role} ${header}`);
      for (const row of sheet.rows) {
        const raw = row && row[header];
        if (raw == null) continue;
        const value = String(raw).trim();
        if (!value || DATA_REPAIR_STOP.has(value.toLowerCase())) continue;
        if (value.length < 3 && !/^\d+$/.test(value)) continue;
        repairs.push({
          value,
          token: `{{${role}}}`,
          role,
          sheet: binding.sheet,
          sensitive,
        });
      }
    }
  }
  const seen = new Set();
  return repairs
    .sort((a, b) => b.value.length - a.value.length)
    .filter((r) => {
      const key = `${r.value}\u0001${r.token}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function canRepairPath(path) {
  const keys = path.map(normKey).filter(Boolean);
  if (keys.some((key) => STRUCTURAL_PATH_KEYS.has(key))) return false;
  const leaf = keys[keys.length - 1] || '';
  return DATA_LITERAL_KEYS.has(leaf);
}

function repairString(text, repairs) {
  let next = String(text);
  let count = 0;
  for (const repair of repairs) {
    if (!repair.value || !next.includes(repair.value) || next.includes(repair.token)) continue;
    if (next === repair.value) {
      next = repair.token;
      count += 1;
      continue;
    }
    const replaced = replaceLiteralBoundaryAware(next, repair.value, repair.token);
    if (replaced !== next) {
      next = replaced;
      count += 1;
    }
  }
  return { value: next, count };
}

function repairDataLiteralsInCase(value, repairs, path = []) {
  if (!repairs.length || value == null) return { value, count: 0 };
  const normalizedPath = Array.isArray(path) ? path : [path].filter(Boolean);
  if (typeof value === 'string') {
    return canRepairPath(normalizedPath) ? repairString(value, repairs) : { value, count: 0 };
  }
  if (Array.isArray(value)) {
    let count = 0;
    const arr = value.map((item) => {
      const repaired = repairDataLiteralsInCase(item, repairs, normalizedPath);
      count += repaired.count;
      return repaired.value;
    });
    return { value: arr, count };
  }
  if (typeof value === 'object') {
    let count = 0;
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const repaired = repairDataLiteralsInCase(childValue, repairs, [...normalizedPath, childKey]);
      count += repaired.count;
      out[childKey] = repaired.value;
    }
    return { value: out, count };
  }
  return { value, count: 0 };
}

module.exports = {
  buildDataLiteralRepairs,
  repairDataLiteralsInCase,
  dataBindingsFor,
};
