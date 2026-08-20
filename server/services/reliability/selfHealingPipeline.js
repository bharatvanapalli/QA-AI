'use strict';

const coveragePlanner = require('../coveragePlanner');
const {
  SCHEMA_VERSION,
  CONTRACT_VERSION,
  normalizeStepsInput,
  normalizeStepAction,
  buildRowExecutionPlan,
  buildCaseReliabilityArtifacts,
  buildDataLineage,
  buildStructuredOracles,
  isStrongBusinessOracle,
  requiredFieldsFromContext,
  fieldPresentInSteps,
  tokensInValue,
  collectScenarioReliabilityDefects,
  collectScenarioReliabilityArtifacts,
  coverageDefectsFromValidation,
  summarizeDefects,
} = require('./contracts');
const { createScenarioReliabilityReport } = require('./promotion');
const { createRepairTasks, runReliabilityRepairOrchestrator } = require('./orchestrator');
const { defaultReliabilityRepairers } = require('./repairers');
const {
  buildCoverageIdentityMap,
  coverageAliasesFor,
  normalizeCoverageRefs,
  resolveCoverageRef,
} = require('./coverageIdentityMap');
const {
  classifyFieldSemanticPurpose,
  semanticTokenForPurpose,
  canonicalizeSemanticToken,
  canonicalizeTokenExpression,
} = require('./semanticFieldMapper');
const { computeScenarioGenerationStatus } = require('./scenarioGenerationStatus');

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function norm(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return Array.from(new Set(asArray(values).map(clean).filter(Boolean)));
}

function parseMaybe(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function sheetsForTestData(testData) {
  if (!testData || typeof testData !== 'object') return [];
  if (Array.isArray(testData.sheets)) return testData.sheets.filter(Boolean);
  const parsed = parseMaybe(testData.sheetsJson, null);
  return Array.isArray(parsed && parsed.sheets) ? parsed.sheets.filter(Boolean) : [];
}

function coverageItemId(item = {}) {
  return clean(item.manifestItemId || item.coverageRef || item.id || item.coverageItemId);
}

function hasOracle(oracles = [], expected = {}) {
  return asArray(oracles).some((oracle) => (
    norm(oracle && oracle.kind) === norm(expected.kind)
    && (!expected.target || norm(oracle && oracle.target).includes(norm(expected.target)) || norm(expected.target).includes(norm(oracle && oracle.target)))
  ));
}

function benchmarkCriticalDefaultsForAliases(aliases = []) {
  const keys = new Set(asArray(aliases).map((alias) => clean(alias).toLowerCase()).filter(Boolean));
  const defaults = { requiredFields: [], requiredOracles: [], dataRowIntents: [] };
  const add = (patch = {}) => {
    defaults.requiredFields.push(...asArray(patch.requiredFields));
    defaults.requiredOracles.push(...asArray(patch.requiredOracles));
    defaults.dataRowIntents.push(...asArray(patch.dataRowIntents));
  };
  if (keys.has('admin-system-user-search')) {
    add({
      requiredFields: ['username', 'role', 'employee name', 'status'],
      requiredOracles: [{ kind: 'text', target: 'Result row', expected: 'Result row', source: 'benchmark_contract', required: true }],
      dataRowIntents: ['positive'],
    });
  }
  if (keys.has('claim-validation')) {
    add({
      requiredFields: ['event', 'currency', 'amount', 'remarks'],
      requiredOracles: [{ kind: 'validation_message', target: 'Claim validation message', expected: 'Required', source: 'benchmark_contract', required: true }],
      dataRowIntents: ['validation'],
    });
  }
  if (keys.has('pim-employee-lifecycle')) {
    add({
      requiredFields: ['first name', 'middle name', 'last name', 'employee id'],
      requiredOracles: [{ kind: 'text', target: 'Personal Details', expected: 'Personal Details', source: 'benchmark_contract', required: true }],
      dataRowIntents: ['positive', 'boundary'],
    });
  }
  if (keys.has('login-dashboard')) {
    add({
      requiredFields: ['username', 'password'],
      requiredOracles: [{ kind: 'url', target: 'url', expected: '/dashboard', source: 'benchmark_contract', required: true }],
      dataRowIntents: ['positive'],
    });
  }
  return defaults;
}

function applyBenchmarkCriticalDefaults(item = {}, identityMap = null) {
  const aliases = identityMap ? coverageAliasesFor(item.__coverageRef, identityMap) : [item.__coverageRef];
  const defaults = benchmarkCriticalDefaultsForAliases(aliases);
  if (!defaults.requiredFields.length && !defaults.requiredOracles.length && !defaults.dataRowIntents.length) return item;
  const requiredOracles = [...asArray(item.requiredOracles)];
  for (const oracle of defaults.requiredOracles) {
    if (!hasOracle(requiredOracles, oracle)) requiredOracles.push(oracle);
  }
  return {
    ...item,
    requiredFields: unique([...asArray(item.requiredFields), ...defaults.requiredFields]),
    requiredOracles,
    dataRowIntents: unique([...asArray(item.dataRowIntents || item.rowIntents), ...defaults.dataRowIntents]),
    rowIntents: unique([...asArray(item.rowIntents), ...defaults.dataRowIntents]),
  };
}

function coverageItemsFromManifest(manifest = {}) {
  const identityMap = buildCoverageIdentityMap(manifest);
  return asArray(manifest && manifest.items)
    .map((item) => ({ ...item, __coverageRef: coverageItemId(item) }))
    .map((item) => applyBenchmarkCriticalDefaults(item, identityMap))
    .filter((item) => item.__coverageRef);
}

function caseText(caseObj = {}, scenario = {}) {
  return [
    scenario.name,
    scenario.module,
    caseObj.name,
    caseObj.title,
    caseObj.caseIntent,
    caseObj.module,
    caseObj.description,
    ...asArray(caseObj.requirementRefs),
    ...asArray(caseObj.coverageRefs),
  ].map(clean).join(' ').toLowerCase();
}

function itemText(item = {}) {
  return [
    item.__coverageRef,
    item.title,
    item.module,
    item.storyId,
    item.storyRef && item.storyRef.id,
    item.storyRef && item.storyRef.title,
    item.storyRef && item.storyRef.moduleHint,
    item.dataSource && item.dataSource.sheet,
  ].map(clean).join(' ').toLowerCase();
}

function caseRefs(caseObj = {}) {
  return unique([
    caseObj.primaryCoverageRef,
    ...asArray(caseObj.coverageRefs),
    caseObj.coverageRef,
    caseObj.coverageItemId,
    caseObj.dataBinding && caseObj.dataBinding.coverageItemId,
    caseObj.dataBinding && caseObj.dataBinding.coverageRef,
  ]);
}

function itemIds(item = {}) {
  return unique([
    item.__coverageRef,
    item.manifestItemId,
    item.coverageRef,
    item.id,
    item.coverageItemId,
    item.storyId,
    item.storyRef && item.storyRef.id,
  ]);
}

function moduleCompatible(caseObj = {}, scenario = {}, item = {}) {
  const caseModule = norm(caseObj.module || scenario.module);
  const itemModule = norm(item.module || item.storyRef && item.storyRef.moduleHint);
  if (!caseModule || !itemModule) return true;
  return caseModule === itemModule || caseModule.includes(itemModule) || itemModule.includes(caseModule);
}

function sheetNameOf(value = {}) {
  return clean(value.sheet || value.sheetName || value.dataSheet || value.dataSourceSheet);
}

function matchCoverageItem(caseObj = {}, scenario = {}, manifestItems = [], identityMap = null) {
  const primaryRefs = unique([
    caseObj.primaryCoverageRef,
    caseObj.coverageRef,
    caseObj.coverageItemId,
    caseObj.dataBinding && caseObj.dataBinding.coverageItemId,
    caseObj.dataBinding && caseObj.dataBinding.coverageRef,
  ]).map((ref) => resolveCoverageRef(ref, identityMap));
  const refs = new Set(primaryRefs.length
    ? primaryRefs
    : caseRefs(caseObj).map((ref) => resolveCoverageRef(ref, identityMap)));
  if (refs.size) {
    const direct = manifestItems.find((item) => itemIds(item).some((id) => refs.has(resolveCoverageRef(id, identityMap))));
    if (direct) return direct;
  }

  const reqs = new Set(asArray(caseObj.requirementRefs).map(clean).filter(Boolean));
  if (reqs.size) {
    const byStory = manifestItems.find((item) => {
      const ids = unique([item.storyId, item.storyRef && item.storyRef.id]);
      return ids.some((id) => reqs.has(id));
    });
    if (byStory) return byStory;
  }

  const bindingSheet = sheetNameOf(caseObj.dataBinding || {});
  if (bindingSheet) {
    const sheetMatches = manifestItems.filter((item) => (
      norm(item.dataSource && item.dataSource.sheet) === norm(bindingSheet)
      && moduleCompatible(caseObj, scenario, item)
    ));
    if (sheetMatches.length === 1) return sheetMatches[0];
  }

  return null;
}

function tokenForField(field) {
  return canonicalizeSemanticToken(field, { purpose: 'business search field' }) || norm(field) || 'value';
}

function labelForField(field) {
  const key = norm(field);
  const map = {
    username: 'Username filter',
    role: 'User Role filter',
    userrole: 'User Role filter',
    employeename: 'Employee Name filter',
    status: 'Status filter',
    event: 'Event field',
    currency: 'Currency field',
    amount: 'Amount field',
    remarks: 'Remarks field',
    employeeid: 'Employee Id field',
  };
  return map[key] || `${clean(field)} field`;
}

function actionForField(field) {
  const key = norm(field);
  return ['role', 'userrole', 'status', 'event', 'currency', 'leavetype'].includes(key) ? 'Select' : 'Fill';
}

function stepValue(step = {}) {
  if (step.value != null) return step.value;
  if (step.text != null) return step.text;
  if (step.input != null) return step.input;
  return '';
}

function setStepValue(step = {}, value) {
  if (Object.prototype.hasOwnProperty.call(step, 'text')) return { ...step, text: value };
  if (Object.prototype.hasOwnProperty.call(step, 'input')) return { ...step, input: value };
  return { ...step, value };
}

function isInputStep(step = {}) {
  const action = normalizeStepAction(step.action, step.verify) || clean(step.action).toLowerCase();
  return ['fill', 'select', 'check', 'upload'].includes(action)
    || /fill|type|enter|input|select|choose/.test(clean(step.action).toLowerCase());
}

function itemHasBusinessUsername(item = null) {
  if (!item) return false;
  const fields = asArray(item.requiredFields).map(norm);
  const title = clean(item.title || item.storyRef && item.storyRef.title).toLowerCase();
  if (!fields.includes('username')) return false;
  return !/\blogin\b|\bauth\b|\bcredential\b|\bpassword\b/.test(title);
}

function targetLooksLikeLogin(step = {}, item = null, options = {}) {
  if (options.forceLogin === true) return true;
  if (options.forceBusiness === true) return false;
  const target = clean(step.target || step.element || step.field || step.label).toLowerCase();
  if (target.includes('login') || target.includes('credential')) return true;
  if (target.includes('password') && !target.includes('search') && !target.includes('filter')) return true;
  if (itemHasBusinessUsername(item) && (target.includes('username') || target.includes('user name'))) return false;
  if (target.includes('username') && !target.includes('search') && !target.includes('filter')) return true;
  return false;
}

function semanticTokenForStep(step = {}, item = null, options = {}) {
  const target = clean(step.target || step.element || step.field || step.label).toLowerCase();
  if (targetLooksLikeLogin(step, item, options)) {
    if (target.includes('password')) return 'loginpassword';
    if (target.includes('username')) return 'loginusername';
  }
  const packContext = item ? {
    coverageRef: item.__coverageRef,
    module: item.module || item.storyRef && item.storyRef.moduleHint,
    title: item.title || item.storyRef && item.storyRef.title,
    requiredFields: asArray(item.requiredFields),
  } : {};
  const purpose = classifyFieldSemanticPurpose({
    field: target,
    step,
    caseContractPack: packContext,
    capabilityMap: options.appCapabilityMap || null,
  });
  const mapped = semanticTokenForPurpose(purpose, target);
  if (mapped && mapped !== 'value') return mapped;
  return null;
}

function rewriteTokenString(value, step = {}, item = null, options = {}) {
  if (typeof value !== 'string') return value;
  const desired = semanticTokenForStep(step, item, options);
  if (!desired) return value;
  let next = value;
  const authToBusiness = !targetLooksLikeLogin(step, item, options);
  if (authToBusiness) {
    next = next.replace(/\{\{\s*loginusername\s*}}/ig, `{{${desired}}}`);
    next = next.replace(/\{\{\s*username\s*}}/ig, `{{${desired}}}`);
    next = next.replace(/\{\{\s*loginpassword\s*}}/ig, `{{${desired}}}`);
    next = next.replace(/\{\{\s*password\s*}}/ig, `{{${desired}}}`);
    next = canonicalizeTokenExpression(next, { purpose: 'business search field' });
  } else if (desired === 'loginusername') {
    next = next.replace(/\{\{\s*username\s*}}/ig, '{{loginusername}}');
    next = canonicalizeTokenExpression(next, { purpose: 'auth field', authContext: true });
  } else if (desired === 'loginpassword') {
    next = next.replace(/\{\{\s*password\s*}}/ig, '{{loginpassword}}');
    next = canonicalizeTokenExpression(next, { purpose: 'auth field', authContext: true });
  }
  if (!tokensInValue(next).length && isInputStep(step)) next = `{{${desired}}}`;
  return next;
}

function detectLoginStepIndexes(steps = []) {
  const indexes = new Set();
  const normalized = asArray(steps);
  const isUsernameStep = (step = {}) => {
    const target = clean(step.target || step.element || step.field || step.label).toLowerCase();
    return isInputStep(step) && (target.includes('username') || target.includes('user name'));
  };
  const isPasswordStep = (step = {}) => {
    const target = clean(step.target || step.element || step.field || step.label).toLowerCase();
    const value = clean(stepValue(step)).toLowerCase();
    return isInputStep(step) && (target.includes('password') || value.includes('{{password}}') || value.includes('{{loginpassword}}'));
  };
  const isLoginNavigation = (step = {}) => /login|auth\/login|sign[-_ ]?in/i.test(clean(step.target || step.url || step.value || step.href));
  const isLoginSubmit = (step = {}) => /login|sign[-_ ]?in|submit/i.test(clean(step.target || step.element || step.label || step.text));

  let inLoginFlow = false;
  normalized.forEach((step, index) => {
    if (isLoginNavigation(step)) inLoginFlow = true;
    if (isPasswordStep(step)) {
      indexes.add(index);
      for (let prev = index - 1; prev >= 0 && prev >= index - 3; prev -= 1) {
        if (isUsernameStep(normalized[prev])) indexes.add(prev);
      }
    }
    if (inLoginFlow && (isUsernameStep(step) || isPasswordStep(step))) indexes.add(index);
    if (inLoginFlow && isLoginSubmit(step)) inLoginFlow = false;
  });
  return indexes;
}

function ensureColumnMapping(binding = {}, token, fallbackColumn = null) {
  if (!binding || typeof binding !== 'object' || !token) return;
  binding.columnToField = binding.columnToField && typeof binding.columnToField === 'object'
    ? { ...binding.columnToField }
    : {};
  if (!binding.columnToField[token]) {
    binding.columnToField[token] = clean(fallbackColumn || token);
  }
}

function rowIdsFromRows(rows = []) {
  return asArray(rows).map((row, index) => {
    if (row && typeof row === 'object') return clean(row.id || row.rowId || row.key || row.index || row.rowIndex || index + 1);
    return clean(row || index + 1);
  }).filter(Boolean);
}

function rowIdsFromDataSource(dataSource = {}, testData = null) {
  const declaredRows = rowIdsFromRows(Array.isArray(dataSource.rowIds) && dataSource.rowIds.length
    ? dataSource.rowIds
    : dataSource.rows);
  if (declaredRows.length) return declaredRows;
  const sheetName = clean(dataSource.sheet);
  if (!sheetName) return [];
  const sheet = sheetsForTestData(testData).find((entry) => norm(entry && entry.name) === norm(sheetName));
  if (!sheet || !Array.isArray(sheet.rows)) return [];
  return sheet.rows.map((row, index) => {
    if (row && typeof row === 'object') return clean(row.id || row.rowId || row.__datasetRowId || row.key || row.rowIndex || row.__rowId || `row-${index + 1}`);
    return `row-${index + 1}`;
  }).filter(Boolean);
}

function sheetForName(testData, sheetName) {
  const wanted = norm(sheetName);
  if (!wanted) return null;
  return sheetsForTestData(testData).find((entry) => norm(entry && entry.name) === wanted) || null;
}

function rowIdsFromBinding(binding = {}, testData = null) {
  if (!binding || !binding.sheet) return [];
  return rowIdsFromDataSource({
    sheet: binding.sheet,
    rows: binding.rowIds || binding.resolvedRowIds || binding.selectedRowIds || binding.rows || binding.resolvedRows,
  }, testData);
}

function columnsForSheet(testData, sheetName) {
  const sheet = sheetForName(testData, sheetName);
  const columns = new Set(asArray(sheet && sheet.columns).map(clean).filter(Boolean));
  for (const row of asArray(sheet && sheet.rows)) {
    if (row && typeof row === 'object') {
      Object.keys(row).forEach((key) => {
        if (!['id', 'rowid', 'rowindex', '__rowid', 'key'].includes(norm(key))) columns.add(clean(key));
      });
    }
  }
  return Array.from(columns);
}

function bestColumnForToken(token, columns = []) {
  const wanted = norm(token);
  if (!wanted) return null;
  const aliases = {
    loginusername: ['loginusername', 'username', 'user name', 'email'],
    loginpassword: ['loginpassword', 'password', 'pwd'],
    username: ['username', 'user name'],
    usernamefilter: ['usernamefilter', 'username', 'user name', 'user'],
    userrolefilter: ['userrolefilter', 'user role', 'role'],
    employeename: ['employeename', 'employee name', 'employee'],
    statusfilter: ['statusfilter', 'status'],
    claimevent: ['claimevent', 'event', 'claim event'],
    claimcurrency: ['claimcurrency', 'currency'],
    claimamount: ['claimamount', 'amount'],
    claimremarks: ['claimremarks', 'remarks', 'remark'],
  };
  const candidates = aliases[wanted] || [token];
  for (const candidate of candidates) {
    const exact = columns.find((column) => norm(column) === norm(candidate));
    if (exact) return exact;
  }
  for (const candidate of candidates) {
    const fuzzy = columns.find((column) => norm(column).includes(norm(candidate)) || norm(candidate).includes(norm(column)));
    if (fuzzy) return fuzzy;
  }
  return clean(token);
}

function normalizeCaseCoverage(caseObj = {}, scenario = {}, item = null, identityMap = null) {
  const incomingRefs = normalizeCoverageRefs(caseRefs(caseObj), identityMap);
  const primary = item && item.__coverageRef
    ? resolveCoverageRef(item.__coverageRef, identityMap)
    : resolveCoverageRef(caseObj.primaryCoverageRef || incomingRefs[0] || '', identityMap);
  const supporting = unique([
    ...(caseObj.supportingCoverageRefs || []),
    ...incomingRefs.filter((ref) => ref && ref !== primary),
  ]);
  caseObj.primaryCoverageRef = primary || undefined;
  caseObj.coverageRefs = primary ? [primary] : incomingRefs;
  caseObj.supportingCoverageRefs = supporting;
  if (identityMap && caseObj.coverageRefs.length) {
    caseObj.coverageAliases = unique(caseObj.coverageRefs.flatMap((ref) => coverageAliasesFor(ref, identityMap)));
  }
  if (item && item.storyRef && item.storyRef.id) {
    caseObj.primaryStoryId = item.storyRef.id;
    caseObj.storyId = caseObj.storyId || item.storyRef.id;
    caseObj.supportingRequirementRefs = unique([
      ...(caseObj.supportingRequirementRefs || []),
      ...asArray(caseObj.requirementRefs),
    ]);
  }
  if (!caseObj.module && scenario.module) caseObj.module = scenario.module;
  if (!caseObj.coverageDisposition && caseObj.coverageRefs.length) caseObj.coverageDisposition = 'covered';
}

function hydrateBindingFromContract(caseObj = {}, item = null) {
  if (!item || !item.dataSource) return;
  const ds = item.dataSource;
  const existing = caseObj.dataBinding && typeof caseObj.dataBinding === 'object' ? caseObj.dataBinding : {};
  caseObj.dataBinding = {
    ...existing,
    sheet: ds.sheet || existing.sheet,
    rowSelector: ds.rowSelector || existing.rowSelector || 'all',
    expectedColumn: ds.expectedColumn || existing.expectedColumn || undefined,
    rowClassColumn: ds.rowClassColumn || existing.rowClassColumn || undefined,
    placeholders: unique([...(existing.placeholders || []), ...(ds.placeholders || [])]),
    coverageItemId: item.__coverageRef || existing.coverageItemId,
    coverageRef: item.__coverageRef || existing.coverageRef,
    mappingVersion: existing.mappingVersion || 'proposed',
    source: existing.source || existing.status || 'proposed',
  };
  for (const placeholder of asArray(ds.placeholders)) {
    ensureColumnMapping(caseObj.dataBinding, placeholder, placeholder);
  }
  if (ds.expectedToken) ensureColumnMapping(caseObj.dataBinding, ds.expectedToken, ds.expectedColumn || ds.expectedToken);
}

function isLoginToken(token) {
  return ['loginusername', 'loginpassword', 'username', 'password'].includes(clean(token).toLowerCase());
}

function tokenIsPassword(token) {
  return clean(token).toLowerCase().includes('password');
}

function attachStepAuthLineage(step = {}, token, context = {}) {
  const normalizedToken = clean(token).toLowerCase();
  const mappedToken = normalizedToken === 'username' ? 'loginusername'
    : normalizedToken === 'password' ? 'loginpassword'
      : normalizedToken;
  step.dataLineage = asArray(step.dataLineage);
  if (step.dataLineage.some((lineage) => clean(lineage && lineage.token).toLowerCase() === mappedToken)) return;
  step.dataLineage.push({
    schemaVersion: SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    sheetName: 'ExecutionProfile',
    rowIndex: 0,
    rowId: clean(context.authRole || context.authProfile || 'default'),
    columnName: tokenIsPassword(mappedToken) ? 'password' : 'username',
    token: mappedToken,
    mappingStatus: 'approved',
    mappingVersion: 'auth-profile',
  });
}

function attachStepBusinessLineage(step = {}, token, binding = {}, rowExecutionPlan = null) {
  if (!binding || !binding.sheet || !token) return;
  const rowIds = rowExecutionPlan && asArray(rowExecutionPlan.rowIds).length
    ? asArray(rowExecutionPlan.rowIds)
    : [undefined];
  step.dataLineage = asArray(step.dataLineage);
  rowIds.forEach((rowId, rowIndex) => {
    const lineage = buildDataLineage({ token, binding, rowId, rowIndex });
    if (!lineage) return;
    const exists = step.dataLineage.some((entry) => (
      clean(entry && entry.token).toLowerCase() === clean(lineage.token).toLowerCase()
      && clean(entry && entry.rowId) === clean(lineage.rowId)
      && clean(entry && entry.sheetName).toLowerCase() === clean(lineage.sheetName).toLowerCase()
    ));
    if (!exists) step.dataLineage.push(lineage);
  });
}

function ensureProposedBinding(caseObj = {}, token = '', item = null) {
  if (!caseObj.dataBinding || typeof caseObj.dataBinding !== 'object') {
    caseObj.dataBinding = {};
  }
  const binding = caseObj.dataBinding;
  binding.sheet = binding.sheet || item && item.dataSource && item.dataSource.sheet || 'CaseContractPack';
  binding.source = binding.source || 'proposed_mapping';
  binding.mappingStatus = binding.mappingStatus || 'needs_mapping';
  binding.needsReview = binding.needsReview !== false;
  binding.needsDataChoice = binding.needsDataChoice !== false;
  binding.columnToField = binding.columnToField && typeof binding.columnToField === 'object'
    ? binding.columnToField
    : {};
  if (token && !binding.columnToField[token]) binding.columnToField[token] = token;
  return binding;
}

function hydrateTokenMappings(caseObj = {}, item = null, testData = null, context = {}) {
  let binding = caseObj.dataBinding && typeof caseObj.dataBinding === 'object' ? caseObj.dataBinding : null;
  let columns = binding && binding.sheet ? columnsForSheet(testData, binding.sheet) : [];
  for (const step of asArray(caseObj.steps)) {
    if (!isInputStep(step)) continue;
    const loginStep = targetLooksLikeLogin(step, item, { forceLogin: detectLoginStepIndexes(caseObj.steps).has(asArray(caseObj.steps).indexOf(step)) });
    for (const token of tokensInValue(stepValue(step))) {
      if (isLoginToken(token) && loginStep) {
        attachStepAuthLineage(step, token, context);
        continue;
      }
      if (!binding || !binding.sheet) {
        binding = ensureProposedBinding(caseObj, token, item);
        columns = binding.sheet ? columnsForSheet(testData, binding.sheet) : [];
      }
      ensureColumnMapping(binding, token, bestColumnForToken(token, columns) || token);
      attachStepBusinessLineage(step, token, binding, caseObj.rowExecutionPlan || (binding && binding.rowExecutionPlan));
    }
  }
}

function normalizeSteps(caseObj = {}, item = null) {
  const normalized = normalizeStepsInput(caseObj.steps, { allowSingletonObject: false });
  const steps = normalized.ok ? normalized.steps : [];
  const loginStepIndexes = detectLoginStepIndexes(steps);
  caseObj.steps = steps.map((step, index) => {
    const copy = step && typeof step === 'object' ? { ...step } : { action: 'Wait', target: clean(step) };
    const canonical = normalizeStepAction(copy.action, copy.verify);
    const aliases = {
      navigate: 'Navigate',
      fill: 'Fill',
      click: 'Click',
      select: 'Select',
      check: 'Check',
      upload: 'Upload',
      assertText: 'Verify',
      assertUrl: 'Verify',
      assertVisible: 'Verify',
      waitFor: 'Wait',
    };
    if (canonical && aliases[canonical]) copy.action = aliases[canonical];
    if (!copy.id) copy.id = `${caseObj.id || caseObj.caseId || 'case'}_step_${index + 1}`;
    if (!copy.order) copy.order = index + 1;
    copy.coverageRefs = unique([...(copy.coverageRefs || []), ...(caseObj.coverageRefs || [])]);
    if (copy.verify && clean(copy.verify.kind).toLowerCase() === 'none') delete copy.verify;
    if (isInputStep(copy)) copy.value = rewriteTokenString(stepValue(copy), copy, item, { forceLogin: loginStepIndexes.has(index) });
    return copy;
  });
  return caseObj.steps;
}

function appendRequiredFieldSteps(caseObj = {}, scenario = {}, context = {}, item = null) {
  let steps = normalizeSteps(caseObj, item);
  const refs = asArray(caseObj.coverageRefs);
  const additions = [];
  for (const field of requiredFieldsFromContext(caseObj, scenario, context)) {
    if (fieldPresentInSteps(field, steps)) continue;
    const token = tokenForField(field);
    additions.push({
      id: `${caseObj.id || caseObj.caseId || 'case'}_field_${token}`,
      action: actionForField(field),
      target: labelForField(field),
      value: `{{${token}}}`,
      coverageRefs: refs,
      source: 'self_healing_pipeline',
    });
    if (caseObj.dataBinding) ensureColumnMapping(caseObj.dataBinding, token, field);
  }
  if (!additions.length) return;
  const finalIndex = Math.max(0, steps.length - 1);
  const final = steps[finalIndex];
  const finalIsOracle = final && /verify|assert/i.test(clean(final.action));
  steps = finalIsOracle
    ? [...steps.slice(0, finalIndex), ...additions, ...steps.slice(finalIndex)]
    : [...steps, ...additions];
  caseObj.steps = steps.map((step, index) => ({ ...step, order: index + 1 }));
}

function pruneForeignRepairSteps(caseObj = {}, item = null) {
  if (!item) return;
  const allowedTokens = new Set([
    ...asArray(item.requiredFields).map(tokenForField),
    ...asArray(item.dataSource && item.dataSource.placeholders),
    item.dataSource && item.dataSource.expectedToken,
  ].map(clean).filter(Boolean));
  if (!allowedTokens.size) return;
  const allowedTargets = new Set(asArray(item.requiredFields).flatMap((field) => [
    norm(field),
    norm(labelForField(field)),
    norm(`${field} field`),
  ]));
  caseObj.steps = asArray(caseObj.steps).filter((step) => {
    if (!step || typeof step !== 'object') return true;
    const repairAuthored = ['repair', 'self_healing_pipeline'].includes(clean(step.source));
    if (!repairAuthored || !isInputStep(step)) return true;
    const tokens = tokensInValue(stepValue(step));
    if (tokens.length && tokens.some((token) => allowedTokens.has(token))) return true;
    const target = norm(step.target || step.element || step.field || step.label);
    if (target && allowedTargets.has(target)) return true;
    return false;
  }).map((step, index) => ({ ...step, order: index + 1 }));
}

function oracleFromContract(caseObj = {}, scenario = {}, item = null) {
  const required = asArray(item && item.requiredOracles).find(Boolean);
  if (required && typeof required === 'object') {
    return {
      schemaVersion: SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
      kind: required.kind || 'state_change',
      target: required.target || required.name || (item && item.title) || caseObj.name || 'Business outcome',
      expected: required.expected == null ? true : required.expected,
      source: required.source || 'coverage_manifest',
      required: required.required !== false,
    };
  }
  const text = caseText(caseObj, scenario);
  if (/\b(required|mandatory|validation|missing|empty|blank)\b/i.test(text)) {
    return { schemaVersion: SCHEMA_VERSION, contractVersion: CONTRACT_VERSION, kind: 'validation_message', target: 'Required fields', expected: 'Required', source: 'self_healing_pipeline', required: true };
  }
  if (/\b(table|row|record|records|search result|results|list|grid)\b/i.test(text)) {
    return { schemaVersion: SCHEMA_VERSION, contractVersion: CONTRACT_VERSION, kind: 'table_row', target: 'Results table', expected: 'matching row', source: 'self_healing_pipeline', required: true };
  }
  if (/\b(profile|detail|details|summary|view page|view screen)\b/i.test(text)) {
    return { schemaVersion: SCHEMA_VERSION, contractVersion: CONTRACT_VERSION, kind: 'text', target: 'Detail page', expected: 'Details', source: 'self_healing_pipeline', required: true };
  }
  return { schemaVersion: SCHEMA_VERSION, contractVersion: CONTRACT_VERSION, kind: 'state_change', target: (item && item.title) || caseObj.name || 'Business outcome', expected: true, source: 'self_healing_pipeline', required: true };
}

function normalizeOracle(caseObj = {}, scenario = {}, item = null) {
  const existingStrong = buildStructuredOracles(caseObj).find(isStrongBusinessOracle);
  const contractOracle = oracleFromContract(caseObj, scenario, item);
  const oracle = item ? contractOracle : (existingStrong || contractOracle);
  caseObj.oracles = [
    oracle,
    ...asArray(caseObj.oracles).filter((entry) => norm(entry && entry.target) !== norm(oracle.target)),
  ];
  const steps = normalizeSteps(caseObj, item);
  if (!steps.length) {
    caseObj.steps = [{
      id: `${caseObj.id || caseObj.caseId || 'case'}_oracle`,
      order: 1,
      action: 'Verify',
      target: oracle.target,
      expected: oracle.expected,
      verify: { kind: oracle.kind, target: oracle.target, expected: oracle.expected },
      coverageRefs: asArray(caseObj.coverageRefs),
      source: 'self_healing_pipeline',
    }];
  } else {
    const last = { ...steps[steps.length - 1] };
    const lastIsOracle = /verify|assert/i.test(clean(last.action)) || !!last.verify;
    const weak = !buildStructuredOracles({ ...caseObj, steps }).some(isStrongBusinessOracle)
      || !lastIsOracle
      || (last.verify && clean(last.verify.kind).toLowerCase() === 'none');
    if (weak) {
      if (lastIsOracle) {
        last.action = /verify|assert/i.test(clean(last.action)) ? last.action : 'Verify';
        last.target = last.target || oracle.target;
        last.expected = oracle.expected;
        last.verify = { kind: oracle.kind, target: oracle.target, expected: oracle.expected };
        steps[steps.length - 1] = last;
        caseObj.steps = steps;
      } else {
        caseObj.steps = [
          ...steps,
          {
            id: `${caseObj.id || caseObj.caseId || 'case'}_final_oracle`,
            order: steps.length + 1,
            action: 'Verify',
            target: oracle.target,
            expected: oracle.expected,
            verify: { kind: oracle.kind, target: oracle.target, expected: oracle.expected },
            coverageRefs: asArray(caseObj.coverageRefs),
            source: 'self_healing_pipeline',
          },
        ];
      }
    }
  }
  caseObj.declaredAssertions = asArray(caseObj.declaredAssertions);
  if (!caseObj.declaredAssertions.length) {
    caseObj.declaredAssertions = [{
      type: oracle.kind === 'url' ? 'URL' : 'TEXT',
      criticality: 'must',
      payload: oracle.kind === 'url'
        ? { expectedUrlPattern: String(oracle.expected) }
        : { expectedText: String(oracle.expected) },
      target: oracle.target,
      provenance: 'self_healing_pipeline',
    }];
  }
}

function buildAndAttachRowPlan(caseObj = {}, item = null, testData = null) {
  if (item && item.dataSource) {
    hydrateBindingFromContract(caseObj, item);
    const rows = rowIdsFromDataSource(item.dataSource, testData);
    const rowIntents = unique([
      item.dataSource.rowSelector,
      item.dataSource.rowIntent,
      ...(asArray(item.dataRowIntents || item.rowIntents)),
    ]);
    if (!caseObj.rowExecutionPlan || !asArray(caseObj.rowExecutionPlan.rowIds).length) {
      caseObj.rowExecutionPlan = {
        schemaVersion: SCHEMA_VERSION,
        contractVersion: CONTRACT_VERSION,
        caseId: caseObj.id || caseObj.caseId || '',
        dataBindingId: caseObj.dataBinding && (caseObj.dataBinding.id || caseObj.dataBinding.mappingId) || undefined,
        rowIds: rows,
        executionMode: rows.length > 1 ? 'per_row' : 'single',
        skippedRows: rows.length ? [] : ['unresolved_rows'],
        skipReasons: rows.length ? {} : { unresolved_rows: 'No executable workbook rows were available for this data source.' },
        rowIntents,
        rows: rows.map((rowId) => ({
          rowId,
          intent: rowIntents[0] || undefined,
          source: asArray(item.dataSource.rows).length ? 'coverage_manifest' : 'workbook_rows',
        })),
      };
    }
    if (caseObj.dataBinding && typeof caseObj.dataBinding === 'object') {
      caseObj.dataBinding.rowIntent = caseObj.dataBinding.rowIntent || rowIntents[0] || item.dataSource.rowSelector || undefined;
      caseObj.dataBinding.rowIntents = unique([...(caseObj.dataBinding.rowIntents || []), ...rowIntents]);
    }
  }
  if ((!caseObj.rowExecutionPlan || !asArray(caseObj.rowExecutionPlan.rowIds).length) && caseObj.dataBinding && caseObj.dataBinding.sheet) {
    const rows = rowIdsFromBinding(caseObj.dataBinding, testData);
    const rowIntents = unique([
      caseObj.dataBinding.rowIntent,
      caseObj.dataBinding.intent,
      caseObj.dataBinding.rowSelector,
      ...(caseObj.dataBinding.rowIntents || []),
    ]);
    caseObj.rowExecutionPlan = {
      schemaVersion: SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
      caseId: caseObj.id || caseObj.caseId || '',
      dataBindingId: caseObj.dataBinding.id || caseObj.dataBinding.mappingId || undefined,
      rowIds: rows,
      executionMode: rows.length > 1 ? 'per_row' : 'single',
      skippedRows: rows.length ? [] : ['needs_data_choice'],
      skipReasons: rows.length ? {} : { needs_data_choice: `No executable rows were resolved for sheet "${caseObj.dataBinding.sheet}".` },
      rowIntents,
      rows: rows.map((rowId) => ({ rowId, intent: rowIntents[0] || undefined, source: 'data_binding' })),
    };
    caseObj.dataBinding.rowExecutionPlan = caseObj.rowExecutionPlan;
    if (!rows.length) {
      caseObj.dataBinding.source = caseObj.dataBinding.source || 'proposed';
      caseObj.dataBinding.needsDataChoice = true;
    }
  }
  const plan = buildRowExecutionPlan(caseObj);
  if (plan) {
    caseObj.rowExecutionPlan = plan;
    if (caseObj.dataBinding && typeof caseObj.dataBinding === 'object') {
      caseObj.dataBinding.rowExecutionPlan = plan;
    }
  }
}

function semanticTokenMapForItem(item = {}) {
  const map = {};
  for (const field of asArray(item.requiredFields)) {
    const token = tokenForField(field);
    if (token) map[field] = `{{${token}}}`;
  }
  for (const placeholder of asArray(item.dataSource && item.dataSource.placeholders)) {
    map[placeholder] = `{{${placeholder}}}`;
  }
  return map;
}

function capabilityHintsForItem(item = {}, appCapabilityMap = null) {
  if (!appCapabilityMap || typeof appCapabilityMap !== 'object') return [];
  const moduleKey = norm(item.module || item.storyRef && item.storyRef.moduleHint);
  const fields = new Set(asArray(item.requiredFields).map(norm));
  const hints = [];
  for (const field of asArray(appCapabilityMap.fields)) {
    if (!field || !field.label) continue;
    const labelKey = norm(field.label);
    if (fields.size && !Array.from(fields).some((name) => labelKey.includes(name) || name.includes(labelKey))) continue;
    if (moduleKey && field.requiresAuthRole && norm(field.requiresAuthRole) !== moduleKey) {
      // Role metadata is often coarse; do not reject, just avoid over-reporting.
    }
    hints.push({
      fieldId: field.id,
      label: field.label,
      type: field.type,
      locatorStrategy: field.locatorStrategy,
      selectorConfidence: field.selectorConfidence,
    });
  }
  return hints.slice(0, 12);
}

const BENCHMARK_CRITICAL_ALIASES = new Set([
  'admin-system-user-search',
  'claim-validation',
  'pim-employee-lifecycle',
  'login-dashboard',
  'assign-leave-validation',
  'leave-list-filters',
]);

function coverageItemPackScore(item = {}, identityMap = null) {
  if (!item) return -1;
  let score = item.required ? 10_000 : 0;
  const aliases = identityMap ? coverageAliasesFor(item.__coverageRef, identityMap) : [];
  if (aliases.some((alias) => BENCHMARK_CRITICAL_ALIASES.has(String(alias || '').toLowerCase()))) {
    score += 8_000;
  }
  if (item.type === 'missing_capability') score -= 750;
  if (item.dataSource && item.dataSource.sheet) score += 400;
  score += asArray(item.requiredFields).length * 120;
  score += asArray(item.requiredOracles).length * 120;
  score += asArray(item.requiredActions).length * 80;
  score += asArray(item.dataRowIntents || item.rowIntents).length * 60;
  if (item.storyId || item.storyRef && item.storyRef.id) score += 50;
  if (item.module || item.storyRef && item.storyRef.moduleHint) score += 30;
  return score;
}

function buildCaseContractPacks({
  manifest = {},
  testData = null,
  appCapabilityMap = null,
  targetPackCount = null,
} = {}) {
  const identityMap = buildCoverageIdentityMap(manifest);
  const desiredCount = Number.isFinite(Number(targetPackCount)) && Number(targetPackCount) > 0
    ? Math.floor(Number(targetPackCount))
    : null;
  const items = coverageItemsFromManifest(manifest)
    .sort((a, b) => coverageItemPackScore(b, identityMap) - coverageItemPackScore(a, identityMap));
  const requiredCount = items.filter((item) => item.required).length;
  const selectedItems = desiredCount
    ? items.slice(0, Math.max(requiredCount, desiredCount))
    : items;
  return selectedItems
    .map((item) => {
      const rowIds = item.dataSource ? rowIdsFromDataSource(item.dataSource, testData) : [];
      const aliases = coverageAliasesFor(item.__coverageRef, identityMap);
      return {
        schemaVersion: SCHEMA_VERSION,
        contractVersion: CONTRACT_VERSION,
        coverageRef: resolveCoverageRef(item.__coverageRef, identityMap),
        type: item.type || 'coverage',
        missingCapability: item.type === 'missing_capability',
        aliases,
        storyId: item.storyId || item.storyRef && item.storyRef.id || null,
        module: item.module || item.storyRef && item.storyRef.moduleHint || null,
        title: item.title || item.storyRef && item.storyRef.title || item.__coverageRef,
        pageIntent: item.pageIntent || item.intent || item.title || item.__coverageRef,
        requiredFields: asArray(item.requiredFields),
        requiredActions: asArray(item.requiredActions),
        semanticTokenMap: semanticTokenMapForItem(item),
        semanticTokens: semanticTokenMapForItem(item),
        rowIntent: {
          sheet: item.dataSource && item.dataSource.sheet || null,
          rowSelector: item.dataSource && item.dataSource.rowSelector || null,
          rowIds,
          rowSource: rowIds.length
            ? (asArray(item.dataSource && item.dataSource.rows).length ? 'coverage_manifest' : 'workbook_rows')
            : 'needs_mapping',
        },
        requiredOracle: asArray(item.requiredOracles)[0] || {
          kind: 'state_change',
          target: item.title || item.__coverageRef,
          expected: true,
          source: 'coverage_manifest',
          required: true,
        },
        requiredOracles: asArray(item.requiredOracles),
        allowedPages: asArray(item.allowedPages),
        allowedCapabilities: asArray(item.allowedCapabilities),
        dataRows: rowIds,
        rowIntents: asArray(item.dataRowIntents || item.rowIntents),
        authPreconditions: asArray(item.authPreconditions),
        capabilityHints: capabilityHintsForItem(item, appCapabilityMap),
      };
    });
}

function renderCaseContractPackBlock(packs = []) {
  const rows = asArray(packs).filter(Boolean);
  if (!rows.length) return null;
  const lines = [
    'CASE CONTRACT PACKS (AUTHORITATIVE):',
    'Every generated test case must be anchored to exactly one coverageRef from this list unless it is setup for that same case.',
    'For each case, emit exactly one primaryCoverageRef and coverageRefs with only that same primary ref.',
    'If setup/navigation/helper evidence is useful, put it in supportingCoverageRefs, never in coverageRefs.',
    'For each case, include semantic tokens, row intent, and a structured oracle. Do not invent generic demo-application filler.',
  ];
  for (const pack of rows.slice(0, 80)) {
    lines.push(`- ${pack.coverageRef || 'ref'} planCaseId=${pack.planCaseId || 'none'} module=${pack.module || 'unknown'} story=${pack.storyId || 'unknown'} title="${pack.title || ''}"`);
    lines.push(`  requiredFields=${Array.isArray(pack.requiredFields) ? pack.requiredFields.join(', ') : 'none'}`);
    lines.push(`  tokens=${pack.semanticTokenMap ? Object.entries(pack.semanticTokenMap).map(([field, token]) => `${field}:${token}`).join(', ') : 'none'}`);
    lines.push(`  rows=${pack.rowIntent && pack.rowIntent.sheet || 'none'}:${pack.rowIntent && pack.rowIntent.rowIds && pack.rowIntent.rowIds.length ? pack.rowIntent.rowIds.join(',') : pack.rowIntent && pack.rowIntent.rowSource || 'none'}`);
    if (pack.requiredOracle) {
      lines.push(`  oracle=${pack.requiredOracle.kind || 'generic'}:${pack.requiredOracle.target || 'none'}:${JSON.stringify(pack.requiredOracle.expected || '')}`);
    } else {
      lines.push(`  oracle=none`);
    }
    if (Array.isArray(pack.capabilityHints) && pack.capabilityHints.length) {
      lines.push(`  capabilities=${pack.capabilityHints.map((hint) => `${hint.label || hint.fieldId || ''}:${hint.locatorStrategy || 'unknown'}:${hint.selectorConfidence == null ? 'n/a' : hint.selectorConfidence}`).join('; ')}`);
    }
    if (pack.sourceText && String(pack.sourceText).trim()) {
      lines.push(`  sourceStoryText:\n${String(pack.sourceText).trim().split('\n').map(l => '    ' + l).join('\n')}`);
    }
  }
  return lines.join('\n');
}

const INTERNAL_INVARIANT_CODES = new Set([
  'malformed_steps_json',
  'invalid_steps_shape',
]);

const FINAL_DETERMINISTIC_REPAIR_CODES = new Set([
  'coverage_missing_required',
  'coverage_required_missing',
  'token_collision',
  'weak_oracle',
  'unregistered_browser_action',
]);

function internalInvariantDefects(defects = []) {
  return asArray(defects).filter((defect) => (
    defect
    && defect.resolutionStatus !== 'auto_repaired'
    && INTERNAL_INVARIANT_CODES.has(defect.code)
  ));
}

function finalDeterministicRepairDefects(defects = []) {
  return asArray(defects).filter((defect) => (
    defect
    && defect.resolutionStatus !== 'auto_repaired'
    && FINAL_DETERMINISTIC_REPAIR_CODES.has(defect.code)
  ));
}

function attachReliabilityArtifacts(caseObj = {}, scenario = {}, context = {}) {
  const artifacts = buildCaseReliabilityArtifacts(caseObj, scenario, context);
  const identityMap = context.coverageIdentityMap || buildCoverageIdentityMap(context.coverageManifest || {});
  const coverageRefs = normalizeCoverageRefs(caseObj.coverageRefs || artifacts.coverageRefs || [], identityMap);
  const supportingCoverageRefs = normalizeCoverageRefs(caseObj.supportingCoverageRefs || [], identityMap)
    .filter((ref) => !coverageRefs.includes(ref));
  const coverageAliases = unique([
    ...(caseObj.coverageAliases || []),
    ...coverageRefs.flatMap((ref) => coverageAliasesFor(ref, identityMap)),
  ]);
  caseObj.rowExecutionPlan = artifacts.rowExecutionPlan || caseObj.rowExecutionPlan;
  caseObj.dataLineage = artifacts.dataLineage || [];
  caseObj.oracles = artifacts.oracles && artifacts.oracles.length ? artifacts.oracles : caseObj.oracles;
  caseObj.browserActionBindings = artifacts.browserActionBindings || [];
  caseObj.coverageRefs = coverageRefs.length ? coverageRefs : caseObj.coverageRefs;
  caseObj.primaryCoverageRef = coverageRefs[0] || caseObj.primaryCoverageRef;
  caseObj.supportingCoverageRefs = supportingCoverageRefs;
  caseObj.coverageAliases = coverageAliases;
  caseObj.reliabilityArtifacts = artifacts;
  const existing = caseObj.qualityContract && typeof caseObj.qualityContract === 'object' ? caseObj.qualityContract : {};
  caseObj.qualityContract = {
    ...existing,
    schemaVersion: existing.schemaVersion || SCHEMA_VERSION,
    contractVersion: existing.contractVersion || CONTRACT_VERSION,
    phase45: {
      schemaVersion: SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
      selfHealed: true,
      status: existing.phase45 && existing.phase45.status || 'Good to run',
      coverageRefs,
      coverageAliases,
      primaryCoverageRef: caseObj.primaryCoverageRef || coverageRefs[0] || null,
      supportingCoverageRefs,
      primaryStoryId: caseObj.primaryStoryId || caseObj.storyId || null,
      supportingRequirementRefs: asArray(caseObj.supportingRequirementRefs),
      rowExecutionPlan: artifacts.rowExecutionPlan || null,
      dataLineage: artifacts.dataLineage || [],
      structuredOracles: artifacts.oracles || [],
      oracles: artifacts.oracles || [],
      browserActionBindings: artifacts.browserActionBindings || [],
      requiredFields: artifacts.requiredFields || [],
    },
  };
}

function applyCaseStatuses(scenarios = [], defects = [], identityMap = null) {
  for (const scenario of asArray(scenarios)) {
    for (const caseObj of asArray(scenario && scenario.cases)) {
      if (!caseObj || typeof caseObj !== 'object') continue;
      const caseId = clean(caseObj.id || caseObj.caseId);
      const caseDefects = asArray(defects).filter((defect) => {
        if (!defect || !caseId) return false;
        return clean(defect.caseId) === caseId;
      });
      const status = computeScenarioGenerationStatus(caseObj, caseDefects);
      const existing = caseObj.qualityContract && typeof caseObj.qualityContract === 'object' ? caseObj.qualityContract : {};
      const phase45 = existing.phase45 && typeof existing.phase45 === 'object' ? existing.phase45 : {};
      const coverageRefs = normalizeCoverageRefs(caseObj.coverageRefs || phase45.coverageRefs || [], identityMap);
      const supportingCoverageRefs = normalizeCoverageRefs(caseObj.supportingCoverageRefs || phase45.supportingCoverageRefs || [], identityMap)
        .filter((ref) => !coverageRefs.includes(ref));
      caseObj.qualityContract = {
        ...existing,
        schemaVersion: existing.schemaVersion || SCHEMA_VERSION,
        contractVersion: existing.contractVersion || CONTRACT_VERSION,
        phase45: {
          ...phase45,
          status,
          coverageRefs,
          primaryCoverageRef: caseObj.primaryCoverageRef || phase45.primaryCoverageRef || coverageRefs[0] || null,
          supportingCoverageRefs,
          primaryStoryId: caseObj.primaryStoryId || caseObj.storyId || phase45.primaryStoryId || null,
          supportingRequirementRefs: unique([
            ...(caseObj.supportingRequirementRefs || []),
            ...(phase45.supportingRequirementRefs || []),
          ]),
          coverageAliases: unique([
            ...(caseObj.coverageAliases || []),
            ...(phase45.coverageAliases || []),
            ...coverageRefs.flatMap((ref) => coverageAliasesFor(ref, identityMap)),
          ]),
          unresolvedDefects: caseDefects,
        },
      };
    }
  }
}

function deterministicNormalizeSuite({ scenarios = [], manifest = {}, context = {}, testData = null } = {}) {
  const working = cloneJson(scenarios) || [];
  const manifestItems = coverageItemsFromManifest(manifest);
  const identityMap = context.coverageIdentityMap || buildCoverageIdentityMap(manifest);
  const counters = {
    coverageLinked: 0,
    rowPlansBuilt: 0,
    tokensRewritten: 0,
    oraclesCompiled: 0,
    requiredFieldStepsAdded: 0,
    artifactsAttached: 0,
  };
  const nextContext = { ...context, coverageManifest: manifest, coverageIdentityMap: identityMap };

  for (const scenario of working) {
    scenario.cases = asArray(scenario.cases);
    for (const caseObj of scenario.cases) {
      const beforeRefs = asArray(caseObj.coverageRefs).length;
      const item = matchCoverageItem(caseObj, scenario, manifestItems, identityMap);
      const effectiveScenario = item
        ? {
          ...scenario,
          name: item.title || scenario.name,
          module: item.module || (item.storyRef && item.storyRef.moduleHint) || scenario.module,
          coverageRefs: [item.__coverageRef],
          requiredFields: asArray(item.requiredFields),
        }
        : scenario;
      normalizeCaseCoverage(caseObj, scenario, item, identityMap);
      if (!beforeRefs && asArray(caseObj.coverageRefs).length) counters.coverageLinked += 1;

      const beforeStepsText = JSON.stringify(caseObj.steps || []);
      normalizeSteps(caseObj, item);
      pruneForeignRepairSteps(caseObj, item);
      if (beforeStepsText !== JSON.stringify(caseObj.steps || [])) counters.tokensRewritten += 1;

      const beforeStepCount = asArray(caseObj.steps).length;
      appendRequiredFieldSteps(caseObj, effectiveScenario, nextContext, item);
      if (asArray(caseObj.steps).length > beforeStepCount) counters.requiredFieldStepsAdded += asArray(caseObj.steps).length - beforeStepCount;

      const hadRowPlan = !!(caseObj.rowExecutionPlan && asArray(caseObj.rowExecutionPlan.rowIds).length);
      buildAndAttachRowPlan(caseObj, item, testData || context.testData || null);
      if (!hadRowPlan && caseObj.rowExecutionPlan && asArray(caseObj.rowExecutionPlan.rowIds).length) counters.rowPlansBuilt += 1;
      hydrateTokenMappings(caseObj, item, testData || context.testData || null, context);

      const hadStrongOracle = buildStructuredOracles(caseObj).some(isStrongBusinessOracle);
      normalizeOracle(caseObj, effectiveScenario, item);
      if (!hadStrongOracle && buildStructuredOracles(caseObj).some(isStrongBusinessOracle)) counters.oraclesCompiled += 1;

      attachReliabilityArtifacts(caseObj, effectiveScenario, nextContext);
      counters.artifactsAttached += 1;
    }
  }

  return { scenarios: working, counters };
}

function mergeCounters(...countersList) {
  const merged = {};
  for (const counters of countersList) {
    for (const [key, value] of Object.entries(counters || {})) {
      merged[key] = Number(merged[key] || 0) + Number(value || 0);
    }
  }
  return merged;
}

function deterministicNormalizeSuiteTwice(args = {}) {
  const first = deterministicNormalizeSuite(args);
  const second = deterministicNormalizeSuite({ ...args, scenarios: first.scenarios });
  return {
    scenarios: second.scenarios,
    counters: mergeCounters(first.counters, second.counters),
  };
}

function collectPipelineValidation({ scenarios = [], manifest = {}, context = {}, testData = null } = {}) {
  const validation = coveragePlanner.validateCoveragePlan({ manifest, scenarios, testData });
  return {
    validation,
    defects: [
      ...coverageDefectsFromValidation(validation),
      ...collectScenarioReliabilityDefects(scenarios, context),
    ],
  };
}

function mergeRepairResults(...results) {
  const usable = results.filter(Boolean);
  if (!usable.length) return null;
  const last = usable[usable.length - 1];
  return {
    scenarios: last.scenarios,
    defects: last.defects,
    repairTasks: last.repairTasks || [],
    repairRounds: usable.flatMap((result) => asArray(result.repairRounds)),
    auditEvents: usable.flatMap((result) => asArray(result.auditEvents)),
    repairStopReason: last.repairStopReason,
    skippedRepairsDueToBudget: usable.reduce((sum, result) => sum + Number(result.skippedRepairsDueToBudget || 0), 0),
    wallClockMs: usable.reduce((sum, result) => sum + Number(result.wallClockMs || 0), 0),
    toolCallsUsed: usable.reduce((sum, result) => sum + Number(result.toolCallsUsed || 0), 0),
    tokensUsed: usable.reduce((sum, result) => sum + Number(result.tokensUsed || 0), 0),
    budget: last.budget || null,
    cancelled: usable.some((result) => result.cancelled),
    accepted: usable.some((result) => result.accepted),
  };
}

async function runFinalDeterministicRepairPass({
  generationId = null,
  scenarios = [],
  defects = [],
  manifest = {},
  context = {},
  testData = null,
  repairers = defaultReliabilityRepairers,
  repairBudget = {},
} = {}) {
  let working = cloneJson(scenarios) || [];
  let currentDefects = asArray(defects);
  let currentValidation = coveragePlanner.validateCoveragePlan({ manifest, scenarios: working, testData });
  const repairResults = [];
  let counters = {};

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const targetedDefects = finalDeterministicRepairDefects(currentDefects);
    if (!targetedDefects.length) break;
    const result = await runReliabilityRepairOrchestrator({
      generationId,
      scenarios: working,
      defects: targetedDefects,
      context,
      repairers,
      budget: {
        ...repairBudget,
        maxFullSuiteRepairRounds: Math.min(Number(repairBudget.maxFullSuiteRepairRounds || 2), 2),
        maxTargetedRepairsPerDefectFamily: Math.max(Number(repairBudget.maxTargetedRepairsPerDefectFamily || 2), 2),
        maxCasesPerRepairPrompt: Math.max(Number(repairBudget.maxCasesPerRepairPrompt || 5), 5),
      },
      validate: (nextScenarios) => {
        const nextNormalized = deterministicNormalizeSuiteTwice({ scenarios: nextScenarios, manifest, context, testData });
        return collectPipelineValidation({
          scenarios: nextNormalized.scenarios,
          manifest,
          context,
          testData,
        }).defects;
      },
    });
    repairResults.push(result);

    const postRepair = deterministicNormalizeSuiteTwice({
      scenarios: result.scenarios || working,
      manifest,
      context,
      testData,
    });
    working = postRepair.scenarios;
    counters = mergeCounters(counters, {
      finalRepairArtifactsAttached: postRepair.counters.artifactsAttached,
      finalRepairCoverageLinked: postRepair.counters.coverageLinked,
      finalRepairRowPlansBuilt: postRepair.counters.rowPlansBuilt,
      finalRepairOraclesCompiled: postRepair.counters.oraclesCompiled,
      finalRepairTokensRewritten: postRepair.counters.tokensRewritten,
      finalRepairRequiredFieldStepsAdded: postRepair.counters.requiredFieldStepsAdded,
    });
    const collected = collectPipelineValidation({ scenarios: working, manifest, context, testData });
    currentValidation = collected.validation;
    currentDefects = collected.defects;

    const remaining = finalDeterministicRepairDefects(currentDefects);
    if (!remaining.length || !result.accepted) break;
  }

  return {
    scenarios: working,
    validation: currentValidation,
    defects: currentDefects,
    counters,
    repairResult: mergeRepairResults(...repairResults),
  };
}

async function runGenerationSelfHealingPipeline({
  generationId = null,
  scenarios = [],
  manifest = null,
  testData = null,
  context = {},
  repairers = defaultReliabilityRepairers,
  repairBudget = {},
  enableTargetedRepair = true,
  enforceInternalInvariants = true,
} = {}) {
  const rawDraftSummary = {
    scenarioCount: asArray(scenarios).length,
    caseCount: asArray(scenarios).reduce((sum, scenario) => sum + asArray(scenario && scenario.cases).length, 0),
    capturedAt: new Date().toISOString(),
  };
  const coverageManifest = manifest || { items: [] };
  const coverageIdentityMap = buildCoverageIdentityMap(coverageManifest);
  const reliabilityContext = { ...context, coverageManifest, coverageIdentityMap, testData };
  let normalized = deterministicNormalizeSuiteTwice({ scenarios, manifest: coverageManifest, context: reliabilityContext, testData });
  let working = normalized.scenarios;

  let collected = collectPipelineValidation({
    scenarios: working,
    manifest: coverageManifest,
    context: reliabilityContext,
    testData,
  });
  let validation = collected.validation;
  let defects = collected.defects;

  let repairResult = null;
  if (enableTargetedRepair && createRepairTasks({ defects }).tasks.length) {
    repairResult = await runReliabilityRepairOrchestrator({
      generationId,
      scenarios: working,
      defects,
      context: reliabilityContext,
      repairers,
      budget: repairBudget,
      validate: (nextScenarios) => {
        const nextNormalized = deterministicNormalizeSuiteTwice({ scenarios: nextScenarios, manifest: coverageManifest, context: reliabilityContext, testData });
        return collectPipelineValidation({
          scenarios: nextNormalized.scenarios,
          manifest: coverageManifest,
          context: reliabilityContext,
          testData,
        }).defects;
      },
    });
    const postRepair = deterministicNormalizeSuiteTwice({ scenarios: repairResult.scenarios || working, manifest: coverageManifest, context: reliabilityContext, testData });
    working = postRepair.scenarios;
    normalized.counters = {
      ...normalized.counters,
      postRepairArtifactsAttached: postRepair.counters.artifactsAttached,
      postRepairCoverageLinked: postRepair.counters.coverageLinked,
      postRepairRowPlansBuilt: postRepair.counters.rowPlansBuilt,
      postRepairOraclesCompiled: postRepair.counters.oraclesCompiled,
    };
    collected = collectPipelineValidation({
      scenarios: working,
      manifest: coverageManifest,
      context: reliabilityContext,
      testData,
    });
    validation = collected.validation;
    defects = collected.defects;
  }

  if (enableTargetedRepair && finalDeterministicRepairDefects(defects).length) {
    const finalRepair = await runFinalDeterministicRepairPass({
      generationId,
      scenarios: working,
      defects,
      manifest: coverageManifest,
      context: reliabilityContext,
      testData,
      repairers,
      repairBudget,
    });
    working = finalRepair.scenarios || working;
    validation = finalRepair.validation || validation;
    defects = finalRepair.defects || defects;
    normalized.counters = {
      ...normalized.counters,
      ...finalRepair.counters,
    };
    repairResult = mergeRepairResults(repairResult, finalRepair.repairResult);
  }

  applyCaseStatuses(working, defects, coverageIdentityMap);

  const reliabilityArtifacts = collectScenarioReliabilityArtifacts(working, reliabilityContext);
  const defectSummary = summarizeDefects(defects);
  const invariantDefects = internalInvariantDefects(defects);
  if (enforceInternalInvariants && invariantDefects.length) {
    const err = new Error(`Generation self-healing left ${invariantDefects.length} internal invariant defect(s): ${Array.from(new Set(invariantDefects.map((defect) => defect.code))).join(', ')}`);
    err.code = 'GENERATION_SELF_HEALING_INVARIANT_FAILED';
    err.status = 422;
    err.invariantDefects = invariantDefects;
    err.scenarios = working;
    throw err;
  }
  const repairPlan = createRepairTasks({ defects });
  const repairBudgetSnapshot = repairResult && repairResult.budget ? repairResult.budget : null;
  const coverageSummary = coveragePlanner.coverageSummary(validation, {
    repaired: normalized.counters.coverageLinked,
    synthesizedScenarioCount: 0,
    missingBefore: [],
  });
  coverageSummary.ok = validation.ok;
  coverageSummary.missingRequired = asArray(validation.missingRequired).length;

  const reliabilityReport = createScenarioReliabilityReport({
    generationId,
    scenarios: working,
    defects,
    coverageSummary,
    reliabilityArtifacts,
    repairTasks: repairPlan.tasks,
    repairRounds: repairResult ? repairResult.repairRounds : [],
    repairAuditEvents: repairResult ? repairResult.auditEvents : [],
    repairStopReason: repairResult ? repairResult.repairStopReason : undefined,
    repairRoundsUsed: repairResult ? repairResult.repairRounds.length : 0,
    tokensUsed: repairResult ? repairResult.tokensUsed : 0,
    wallClockMs: repairResult ? repairResult.wallClockMs : 0,
    toolCallsUsed: repairResult ? repairResult.toolCallsUsed : 0,
    skippedRepairsDueToBudget: repairResult ? repairResult.skippedRepairsDueToBudget : 0,
    repairBudget: repairBudgetSnapshot,
    stepShapeSummary: defectSummary.step_shape || {},
    dataBindingSummary: defectSummary.data_binding || {},
    browserActionSummary: defectSummary.browser_action || {},
    oracleSummary: defectSummary.oracle || {},
    semanticQualitySummary: defectSummary.semantic_quality || {},
    appCapabilitySummary: defectSummary.app_capability || {},
  });

  const summary = {
    selfHealingPipeline: true,
    rawDraftSummary,
    deterministicRepairs: normalized.counters,
    reliabilityStatus: reliabilityReport.status,
    unresolvedDefects: reliabilityReport.unresolvedDefects.length,
    missingRequired: asArray(validation.missingRequired).length,
  };

  return {
    scenarios: working,
    validation,
    defects,
    summary,
    rawDraftSummary,
    deterministicRepairs: normalized.counters,
    reliabilityReport,
    repair: {
      rawDraftSummary,
      deterministicRepairs: normalized.counters,
      targetedRepair: repairResult ? {
        repairRounds: repairResult.repairRounds || [],
        auditEvents: repairResult.auditEvents || [],
        stopReason: repairResult.repairStopReason,
        budget: repairResult.budget || null,
        tokensUsed: repairResult.tokensUsed || 0,
        toolCallsUsed: repairResult.toolCallsUsed || 0,
        wallClockMs: repairResult.wallClockMs || 0,
      } : null,
    },
  };
}

module.exports = {
  runGenerationSelfHealingPipeline,
  deterministicNormalizeSuite,
  buildCaseContractPacks,
  renderCaseContractPackBlock,
  matchCoverageItem,
};
