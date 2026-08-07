'use strict';

const {
  CONTRACT_VERSION,
  SCHEMA_VERSION,
  DEFECT_FAMILY,
  createReliabilityDefect,
  normalizeStepsInput,
  normalizeStepAction,
  withContractVersions,
} = require('./contracts');

const DEFAULT_MAX_AGE_DAYS = 14;
const DEFAULT_MIN_SELECTOR_CONFIDENCE = 0.55;

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function norm(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function idFor(prefix, value) {
  const base = norm(value).slice(0, 80) || 'unknown';
  return `${prefix}_${base}`;
}

function confidence(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

function normalizeLocatorEvidence(item = {}) {
  const locators = arr(item.locators || item.locatorCandidates)
    .concat(item.locator ? [item.locator] : [])
    .concat(item.selector ? [item.selector] : [])
    .map(clean)
    .filter(Boolean);
  const locatorStrategy = clean(item.locatorStrategy || item.strategy || item.selectorStrategy || (
    locators.some((locator) => locator.includes('getByTestId')) ? 'testid'
      : locators.some((locator) => locator.includes('getByRole')) ? 'role'
        : locators.some((locator) => locator.includes('getByLabel')) ? 'label'
          : locators.some((locator) => locator.startsWith('//')) ? 'xpath'
            : locators.some((locator) => locator.startsWith('.') || locator.startsWith('#')) ? 'css'
              : 'unknown'
  )).toLowerCase();
  return {
    locators,
    locatorStrategy,
    selectorConfidence: confidence(item.selectorConfidence ?? item.confidence, locators.length ? 0.75 : 0),
  };
}

function normalizeField(field = {}, page = {}, form = {}) {
  const label = clean(field.label || field.name || field.target || field.text || field.id);
  const evidence = normalizeLocatorEvidence(field);
  return withContractVersions({
    id: field.id || idFor('field', `${page.id || page.title || ''}:${label}`),
    label,
    type: clean(field.type || field.inputType || 'unknown').toLowerCase() || 'unknown',
    locators: evidence.locators,
    locatorStrategy: evidence.locatorStrategy,
    selectorConfidence: evidence.selectorConfidence,
    dropdownOptions: arr(field.dropdownOptions || field.options).map(clean).filter(Boolean),
    requiresAuthRole: field.requiresAuthRole || page.requiresAuthRole || undefined,
    preconditions: arr(field.preconditions || page.preconditions).map(clean).filter(Boolean),
    pageId: page.id || undefined,
    formId: form.id || undefined,
  });
}

function normalizeButton(button = {}, page = {}) {
  const label = clean(button.label || button.name || button.text || button.target || button.id);
  const evidence = normalizeLocatorEvidence(button);
  return withContractVersions({
    id: button.id || idFor('button', `${page.id || page.title || ''}:${label}`),
    label,
    locators: evidence.locators,
    locatorStrategy: evidence.locatorStrategy,
    selectorConfidence: evidence.selectorConfidence,
    supportedActions: arr(button.supportedActions).length ? arr(button.supportedActions).map(clean) : ['click'],
    requiresAuthRole: button.requiresAuthRole || page.requiresAuthRole || undefined,
    preconditions: arr(button.preconditions || page.preconditions).map(clean).filter(Boolean),
    pageId: page.id || undefined,
  });
}

function normalizeForm(form = {}, page = {}) {
  const id = form.id || idFor('form', `${page.id || page.title || ''}:${form.name || form.label || 'form'}`);
  const fields = arr(form.fields).map((field) => normalizeField(field, page, { ...form, id }));
  return {
    form: withContractVersions({
      id,
      pageId: page.id || undefined,
      fields: fields.map((field) => field.id),
      requiredFields: arr(form.requiredFields).map(clean).filter(Boolean),
      validationMessages: arr(form.validationMessages).map(clean).filter(Boolean),
    }),
    fields,
  };
}

function normalizePage(page = {}) {
  const id = page.id || idFor('page', page.urlPattern || page.title || page.module || 'page');
  const pageWithId = { ...page, id };
  const formResults = arr(page.forms).map((form) => normalizeForm(form, pageWithId));
  const forms = formResults.map((result) => result.form);
  const formFields = formResults.flatMap((result) => result.fields);
  const pageFields = arr(page.fields).map((field) => normalizeField(field, pageWithId));
  const buttons = arr(page.buttons).map((button) => normalizeButton(
    typeof button === 'string' ? { label: button } : button,
    pageWithId,
  ));
  return {
    page: withContractVersions({
      id,
      module: clean(page.module || ''),
      urlPattern: page.urlPattern || page.url || undefined,
      title: page.title || undefined,
      forms: forms.map((form) => form.id),
      buttons: buttons.map((button) => button.id),
      supportedActions: arr(page.supportedActions).length ? arr(page.supportedActions).map(clean) : ['navigate'],
      navigationPath: arr(page.navigationPath).map(clean).filter(Boolean),
      requiresAuthRole: page.requiresAuthRole || undefined,
      preconditions: arr(page.preconditions).map(clean).filter(Boolean),
    }),
    forms,
    fields: [...formFields, ...pageFields],
    buttons,
  };
}

function buildAppCapabilityMap({
  id = undefined,
  projectId,
  version = 'v1',
  source = 'manual_import',
  freshness = 'fresh',
  modules = [],
  pages = [],
  forms = [],
  fields = [],
  buttons = [],
  capturedAt = new Date().toISOString(),
  invalidationReason = undefined,
} = {}) {
  const pageResults = arr(pages).map(normalizePage);
  const normalizedPages = pageResults.map((result) => result.page);
  const normalizedForms = [
    ...pageResults.flatMap((result) => result.forms),
    ...arr(forms).map((form) => normalizeForm(form, {}).form),
  ];
  const normalizedFields = [
    ...pageResults.flatMap((result) => result.fields),
    ...arr(fields).map((field) => normalizeField(field, {}, {})),
  ];
  const normalizedButtons = [
    ...pageResults.flatMap((result) => result.buttons),
    ...arr(buttons).map((button) => normalizeButton(typeof button === 'string' ? { label: button } : button, {})),
  ];
  const moduleNames = new Set(arr(modules).map(clean).filter(Boolean));
  normalizedPages.forEach((page) => { if (page.module) moduleNames.add(page.module); });
  return withContractVersions({
    id: id || `capability_${projectId || 'project'}_${version}`,
    projectId: projectId || null,
    version,
    source,
    freshness,
    modules: Array.from(moduleNames),
    pages: normalizedPages,
    forms: normalizedForms,
    fields: normalizedFields,
    buttons: normalizedButtons,
    capturedAt,
    invalidationReason,
  });
}

function buildAppCapabilityMapFromAtlas({
  projectId,
  atlas = {},
  version = atlas.version || 'atlas',
  source = 'calibration_atlas_fallback',
  capturedAt = atlas.capturedAt || atlas.createdAt || new Date().toISOString(),
} = {}) {
  const flatCapabilities = arr(atlas.capabilities);
  const capabilitiesForPage = (page = {}) => flatCapabilities.filter((capability) => {
    if (!capability) return false;
    const capUrl = clean(capability.pageUrl || capability.url || capability.normalizedUrl);
    const pageUrl = clean(page.url || page.normalizedUrl || page.urlPattern);
    return !capUrl || !pageUrl || capUrl === pageUrl;
  });
  const fieldFromEvidence = (item = {}) => ({
    label: item.label || item.name,
    locators: [item.selector || item.locator].filter(Boolean),
    selectorConfidence: item.selector || item.locator ? 0.85 : 0,
  });
  const buttonFromEvidence = (item = {}) => ({
    label: item.label || item.name,
    locators: [item.selector || item.locator].filter(Boolean),
    selectorConfidence: item.selector || item.locator ? 0.85 : 0,
  });
  const fieldsForCapability = (capability = {}) => {
    const evidence = capability.evidence || {};
    return []
      .concat(arr(evidence.fields).map(fieldFromEvidence))
      .concat(evidence.search ? [fieldFromEvidence(evidence.search)] : [])
      .concat(arr(evidence.columns).map((column) => ({
        label: column.name || column.label,
        locators: [column.selector || column.locator].filter(Boolean),
        selectorConfidence: column.selector || column.locator ? 0.75 : 0,
      })))
      .filter((field) => field.label);
  };
  const buttonsForCapability = (capability = {}) => {
    const evidence = capability.evidence || {};
    return []
      .concat(evidence.submit ? [buttonFromEvidence(evidence.submit)] : [])
      .concat(evidence.action ? [buttonFromEvidence(evidence.action)] : [])
      .concat(evidence.control ? [buttonFromEvidence(evidence.control)] : [])
      .filter((button) => button.label);
  };
  const pages = arr(atlas.pages || atlas.routes || atlas.capabilities).map((page) => ({
    id: page.id,
    module: page.module || page.area,
    urlPattern: page.urlPattern || page.url,
    title: page.title || page.name,
    forms: arr(page.forms),
    fields: arr(page.fields || page.inputs)
      .concat(capabilitiesForPage(page).flatMap(fieldsForCapability)),
    buttons: arr(page.buttons || page.actions).concat(capabilitiesForPage(page).flatMap(buttonsForCapability)).map((button) => (
      typeof button === 'string' ? { label: button } : button
    )),
    supportedActions: arr(page.supportedActions || page.actions).map((action) => (
      typeof action === 'string' ? action : action && action.action
    )).filter(Boolean),
    navigationPath: arr(page.navigationPath || page.breadcrumbs),
    requiresAuthRole: page.requiresAuthRole || page.role,
    preconditions: arr(page.preconditions),
  }));
  return buildAppCapabilityMap({
    projectId,
    version,
    source,
    freshness: atlas.stale || atlas.schemaStale || atlas.degraded ? 'stale' : 'fresh',
    modules: arr(atlas.modules),
    pages,
    capturedAt,
    invalidationReason: atlas.degraded || (atlas.stale ? 'calibration_crawl_too_old' : undefined),
  });
}

function mapAgeDays(capabilityMap, now = new Date()) {
  const captured = Date.parse(capabilityMap && capabilityMap.capturedAt);
  if (!Number.isFinite(captured)) return Infinity;
  return (now.getTime() - captured) / 86400000;
}

function capabilityFreshnessDefects(capabilityMap, {
  requiredModules = [],
  targetUrl = undefined,
  authRole = undefined,
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  now = new Date(),
} = {}) {
  if (!capabilityMap) {
    return [createReliabilityDefect({
      code: 'missing_app_capability',
      family: DEFECT_FAMILY.APP_CAPABILITY,
      message: 'No AppCapabilityMap is available to ground generated scenarios.',
      userDecisionAllowed: true,
      evidence: { requiredModules },
    })];
  }
  const defects = [];
  if (!arr(['playwright_crawl', 'recorded_user_flow', 'manual_import', 'previous_successful_execution', 'calibration_atlas_fallback'])
    .includes(capabilityMap.source)) {
    defects.push(createReliabilityDefect({
      code: 'stale_app_capability',
      family: DEFECT_FAMILY.APP_CAPABILITY,
      message: `AppCapabilityMap source "${capabilityMap.source || 'unknown'}" is not recognized.`,
      userDecisionAllowed: true,
      evidence: { source: capabilityMap.source || null },
    }));
  }
  if (capabilityMap.freshness !== 'fresh') {
    defects.push(createReliabilityDefect({
      code: 'stale_app_capability',
      family: DEFECT_FAMILY.APP_CAPABILITY,
      message: `AppCapabilityMap is ${capabilityMap.freshness || 'unknown'}, not fresh.`,
      userDecisionAllowed: true,
      evidence: { freshness: capabilityMap.freshness, invalidationReason: capabilityMap.invalidationReason || null },
    }));
  }
  const age = mapAgeDays(capabilityMap, now);
  if (age > maxAgeDays) {
    defects.push(createReliabilityDefect({
      code: 'stale_app_capability',
      family: DEFECT_FAMILY.APP_CAPABILITY,
      message: `AppCapabilityMap is older than ${maxAgeDays} days.`,
      userDecisionAllowed: true,
      evidence: { capturedAt: capabilityMap.capturedAt, ageDays: age, maxAgeDays },
    }));
  }
  const modules = new Set(arr(capabilityMap.modules).map(norm));
  for (const moduleName of arr(requiredModules)) {
    if (!moduleName || modules.has(norm(moduleName))) continue;
    defects.push(createReliabilityDefect({
      code: 'missing_app_capability',
      family: DEFECT_FAMILY.APP_CAPABILITY,
      message: `AppCapabilityMap does not include required module "${moduleName}".`,
      userDecisionAllowed: true,
      evidence: { module: moduleName, modules: capabilityMap.modules || [] },
    }));
  }
  if (targetUrl) {
    const pageUrls = arr(capabilityMap.pages).map((page) => clean(page.urlPattern || page.url || '')).filter(Boolean);
    const expectedUrl = clean(targetUrl).toLowerCase();
    const matchesTarget = pageUrls.some((url) => expectedUrl.includes(url.toLowerCase()) || url.toLowerCase().includes(expectedUrl));
    if (pageUrls.length && !matchesTarget) {
      defects.push(createReliabilityDefect({
        code: 'stale_app_capability',
        family: DEFECT_FAMILY.APP_CAPABILITY,
        message: 'AppCapabilityMap target URL no longer matches the project target URL.',
        userDecisionAllowed: true,
        evidence: { targetUrl, pageUrls: pageUrls.slice(0, 10) },
      }));
    }
  }
  if (authRole) {
    const roles = arr(capabilityMap.pages).concat(arr(capabilityMap.fields)).concat(arr(capabilityMap.buttons))
      .map((item) => clean(item.requiresAuthRole))
      .filter(Boolean);
    if (roles.length && !roles.some((role) => norm(role) === norm(authRole))) {
      defects.push(createReliabilityDefect({
        code: 'stale_app_capability',
        family: DEFECT_FAMILY.APP_CAPABILITY,
        message: 'AppCapabilityMap auth role no longer matches the requested role.',
        userDecisionAllowed: true,
        evidence: { authRole, capabilityRoles: Array.from(new Set(roles)) },
      }));
    }
  }
  if (!arr(capabilityMap.pages).length) {
    defects.push(createReliabilityDefect({
      code: 'missing_app_capability',
      family: DEFECT_FAMILY.APP_CAPABILITY,
      message: 'AppCapabilityMap has no pages.',
      userDecisionAllowed: true,
      evidence: { source: capabilityMap.source || null },
    }));
  }
  if (!arr(capabilityMap.fields).length && !arr(capabilityMap.buttons).length) {
    defects.push(createReliabilityDefect({
      code: 'missing_app_capability',
      family: DEFECT_FAMILY.APP_CAPABILITY,
      message: 'AppCapabilityMap has no form/menu/action structure.',
      userDecisionAllowed: true,
      evidence: { source: capabilityMap.source || null, pages: arr(capabilityMap.pages).length },
    }));
  }
  return defects;
}

function targetMatches(target, label) {
  const a = norm(target);
  const b = norm(label);
  return !!a && !!b && (a.includes(b) || b.includes(a));
}

function evidenceUsable(item, minSelectorConfidence) {
  return !!item
    && arr(item.locators).some(Boolean)
    && confidence(item.selectorConfidence) >= minSelectorConfidence;
}

function findField(capabilityMap, target, minSelectorConfidence) {
  return arr(capabilityMap && capabilityMap.fields)
    .find((field) => targetMatches(target, field.label) && evidenceUsable(field, minSelectorConfidence));
}

function findButton(capabilityMap, target, minSelectorConfidence) {
  return arr(capabilityMap && capabilityMap.buttons)
    .find((button) => targetMatches(target, button.label) && evidenceUsable(button, minSelectorConfidence));
}

function findPage(capabilityMap, target) {
  return arr(capabilityMap && capabilityMap.pages)
    .find((page) => targetMatches(target, page.title || page.urlPattern || page.id));
}

function stepCapabilityDefects(step = {}, caseObj = {}, scenario = {}, capabilityMap, options = {}) {
  const minSelectorConfidence = Number.isFinite(Number(options.minSelectorConfidence))
    ? Number(options.minSelectorConfidence)
    : DEFAULT_MIN_SELECTOR_CONFIDENCE;
  const action = normalizeStepAction(step.action, step.verify);
  const target = clean(step.target || step.element || step.field || step.label || step.locator_hint);
  const caseId = caseObj.id || caseObj.caseId || undefined;
  if (!target || !action) return [];
  if (['assertText', 'assertUrl', 'assertVisible', 'waitFor'].includes(action)) return [];
  if (action === 'navigate') {
    if (findPage(capabilityMap, target)) return [];
    return [createReliabilityDefect({
      code: 'missing_app_capability',
      family: DEFECT_FAMILY.APP_CAPABILITY,
      caseId,
      message: `No grounded page capability found for navigation target "${target}".`,
      userDecisionAllowed: true,
      evidence: { target, action, scenario: scenario.name || undefined },
    })];
  }
  const match = ['fill', 'select', 'check', 'upload'].includes(action)
    ? findField(capabilityMap, target, minSelectorConfidence)
    : findButton(capabilityMap, target, minSelectorConfidence);
  if (match) return [];
  return [createReliabilityDefect({
    code: 'missing_app_capability',
    family: DEFECT_FAMILY.APP_CAPABILITY,
    caseId,
    message: `No executable locator evidence found for ${action} target "${target}".`,
    userDecisionAllowed: true,
    evidence: {
      target,
      action,
      minSelectorConfidence,
      scenario: scenario.name || undefined,
      module: caseObj.module || scenario.module || undefined,
    },
  })];
}

function collectAppCapabilityDefects(scenarios = [], {
  capabilityMap = null,
  requiredModules = [],
  targetUrl = undefined,
  authRole = undefined,
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  minSelectorConfidence = DEFAULT_MIN_SELECTOR_CONFIDENCE,
  now = new Date(),
  requireCapabilityMap = false,
} = {}) {
  const modules = new Set(arr(requiredModules));
  arr(scenarios).forEach((scenario) => {
    if (scenario && scenario.module) modules.add(scenario.module);
    arr(scenario && scenario.cases).forEach((caseObj) => {
      if (caseObj && caseObj.module) modules.add(caseObj.module);
    });
  });
  if (!capabilityMap && !requireCapabilityMap) return [];
  const defects = capabilityFreshnessDefects(capabilityMap, {
    requiredModules: Array.from(modules).filter(Boolean),
    targetUrl,
    authRole,
    maxAgeDays,
    now,
  });
  if (!capabilityMap || defects.some((defect) => defect.code === 'stale_app_capability')) return defects;
  for (const scenario of arr(scenarios)) {
    for (const caseObj of arr(scenario && scenario.cases)) {
      const normalized = normalizeStepsInput(caseObj && caseObj.steps, { allowSingletonObject: false });
      if (!normalized.ok) continue;
      for (const step of normalized.steps) {
        defects.push(...stepCapabilityDefects(step, caseObj, scenario, capabilityMap, { minSelectorConfidence }));
      }
    }
  }
  return defects;
}

function summarizeCapabilityMap(capabilityMap) {
  if (!capabilityMap) return { present: false };
  return {
    present: true,
    source: capabilityMap.source || 'unknown',
    freshness: capabilityMap.freshness,
    invalidationReason: capabilityMap.invalidationReason || null,
    modules: arr(capabilityMap.modules).length,
    pages: arr(capabilityMap.pages).length,
    forms: arr(capabilityMap.forms).length,
    fields: arr(capabilityMap.fields).length,
    buttons: arr(capabilityMap.buttons).length,
    locatorBackedFields: arr(capabilityMap.fields).filter((field) => arr(field.locators).length).length,
    locatorBackedButtons: arr(capabilityMap.buttons).filter((button) => arr(button.locators).length).length,
    capturedAt: capabilityMap.capturedAt || null,
  };
}

module.exports = {
  DEFAULT_MAX_AGE_DAYS,
  DEFAULT_MIN_SELECTOR_CONFIDENCE,
  buildAppCapabilityMap,
  buildAppCapabilityMapFromAtlas,
  capabilityFreshnessDefects,
  collectAppCapabilityDefects,
  summarizeCapabilityMap,
};
