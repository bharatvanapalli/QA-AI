'use strict';
const path = require('path');
/**
 * Class G Phase 2 — Playwright POM adapter (AS_IS_FIDELITY_PLAN §4 / G.6).
 *
 * Emits a 3-layer runnable package from a journey group:
 *   locators/<page>.locators.ts  — action-time locator functions (one per URL-domain)
 *   pages/<Page>.ts              — action methods 1:1 with recorded acts (imports locators/)
 *   tests/<module>/<scenario>.spec.ts — journey spec calling page methods; zero inline selectors
 *
 * GUARDRAILS:
 *   1. Exact approved action-time locator stored. Reuses buildLocatorRepository (same
 *      normalizeCandidates + selectStaticLocator path as playwright-reference) — never re-derived.
 *   2. Conflict → inline fallback in spec + surfaced in evidence/locator-conflicts.json; never
 *      silently picks one side.
 *   3. Methods wrap recorded actions 1:1 (G.5). No synthesis, no reordering, no invention.
 *
 * Relationship to playwright-reference: this adapter calls _journeyStepLines-style emission
 * but replaces inline `page.getByRole(...)` calls with page-object method invocations.
 * The per-case compile path (compileReplayIR) is NOT implemented; journey specs are
 * the primary POM product (same as playwright-reference). Per-case fallback stays as before.
 */
const {
  buildLocatorRepository,
  PAGE_LEVEL_ACTIONS,
  pageKey,
  pageFileName,
} = require('../pageObjectRepository');
const pomArchitectAgent = require('../pomArchitectAgent');
const pageAtlas = require('../../pageAtlas');
const actionLocatorResolver = require('../../actionLocatorResolver');
const locatorIntelligenceV2 = require('../../locatorIntelligenceV2');
const replayLocatorContract = require('../_verifiedActionLocator');
const {
  emitLocatorResolver, emitStep, emitWait, emitHumanInput, emitAssertion, evaluateArg,
  emitDialogPrearm, emitDialogAcknowledgement, isFlowCriticalAssertion, continueAfterAssertionFailure,
  selectStaticLocator,
} = require('./playwrightReference');

const ADAPTER_ID = 'playwright-pom';
const STANDARD_JS_OUTPUT_PROFILE = 'playwright-pom-js-v1';

function standardJsOutputEnabled(opts, lang) {
  return lang === 'js'
    && opts
    && opts.adapterId === 'playwright-pom-js'
    && opts.standardOutputProfile === STANDARD_JS_OUTPUT_PROFILE;
}

// ── Language helpers (TS vs JS emission) ────────────────────────────────────
// Thread `lang` through emitters so the same logic produces both variants.
// Default is always 'ts'. The JS wrapper adapter passes lang:'js'.
function ext(lang) { return lang === 'js' ? '.js' : '.ts'; }
function isCjs(lang, moduleFormat) { return lang === 'js' && moduleFormat === 'cjs'; }
function importExt(lang, moduleFormat) { return lang === 'js' && moduleFormat !== 'cjs' ? '.js' : ''; }
function tsOnly(lang, str) { return lang === 'js' ? '' : str; }

// ── Utilities ───────────────────────────────────────────────────────────────

function q(value) { return JSON.stringify(value == null ? '' : String(value)); }

function slug(value, fallback = 'journey') {
  const out = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/g, '');
  return out || fallback;
}

function toSafeDataKey(key) {
  const out = String(key || '')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/^([0-9])/, '_$1')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return out || 'field';
}

function dataKey(key) {
  return q(toSafeDataKey(key));
}

function isEnvironmentBackedValue(value) {
  if (typeof value === 'string') return /^(?:env|vault|masked|fixture):/i.test(value.trim());
  if (!value || typeof value !== 'object') return false;
  const kind = String(value.kind || value.type || (value.source && value.source.kind) || '').toLowerCase();
  return ['environment', 'env', 'vault', 'masked', 'fixture'].includes(kind);
}

function commonExportedDataKeys(rows) {
  const usableRows = (rows || []).filter((row) => row && row.fields && Object.keys(row.fields).length > 0);
  if (!usableRows.length) return new Map();
  const common = new Map();
  for (const [key, value] of Object.entries(usableRows[0].fields)) {
    if (!isEnvironmentBackedValue(value)) common.set(toSafeDataKey(key).toLowerCase(), toSafeDataKey(key));
  }
  for (const row of usableRows.slice(1)) {
    const keys = new Set(Object.entries(row.fields)
      .filter(([, value]) => !isEnvironmentBackedValue(value))
      .map(([key]) => toSafeDataKey(key).toLowerCase()));
    for (const key of [...common.keys()]) {
      if (!keys.has(key)) common.delete(key);
    }
  }
  return common;
}

function exportedDataKey(dataHints, requestedKey) {
  const exportedKeys = dataHints instanceof Map ? dataHints : dataHints && dataHints.exportedKeys;
  if (!requestedKey || !(exportedKeys instanceof Map)) return null;
  return exportedKeys.get(toSafeDataKey(requestedKey).toLowerCase()) || null;
}

function opaquePomSeed(seed) {
  const value = String(seed || '').trim();
  return !value || /^(?:act|el|element|target|node|ref|control|button|link|field|input|textbox|selector|unknown)(?:[-_ ]?\d+)?$/i.test(value);
}

function genericPomSeed(action) {
  const normalized = String(action || '').toLowerCase();
  if (['fill', 'type', 'press'].includes(normalized)) return 'GuessedField';
  if (['check', 'uncheck'].includes(normalized)) return 'GuessedCheckbox';
  if (normalized === 'selectOption') return 'GuessedSelect';
  if (normalized === 'upload') return 'GuessedFileInput';
  return 'GuessedControl';
}

function synthesizePomName(action, seed) {
  const rawAction = String(action || 'perform').replace(/[^A-Za-z0-9]/g, '') || 'perform';
  const rawSeed = opaquePomSeed(seed)
    ? genericPomSeed(rawAction)
    : (String(seed).replace(/[^A-Za-z0-9]/g, '') || genericPomSeed(rawAction));
  return `${rawAction}${rawSeed.charAt(0).toUpperCase()}${rawSeed.slice(1)}`;
}

function publicIdentifierName(value, entry = null, fallback = 'element') {
  let name = String(value || fallback).replace(/[^A-Za-z0-9_$]/g, '') || fallback;
  const roleSuffix = (name.match(/(SearchInput|Textbox|Input|Button|Link|MenuItem|Tab|Checkbox|Radio|Select|Option|Heading|Image|Element)$/) || [])[1] || '';
  const evidence = String(entry && (entry.expr || entry.expression) || '');
  const volatile = [
    ...(evidence.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || []),
    ...(evidence.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig) || []),
  ];
  for (const token of volatile) {
    const compact = token.replace(/[^A-Za-z0-9]/g, '');
    if (compact) name = name.replace(new RegExp(escapeRegex(compact), 'ig'), '');
  }
  name = name.replace(/[0-9a-f]{24,}/ig, '').replace(/\d{7,}/g, '');
  if (/(password|passcode|secret|credential)/i.test(name) && /For[A-Z]/.test(name)) {
    const prefix = name.replace(/For[A-Z].*$/, '');
    name = `${prefix}${roleSuffix && !prefix.endsWith(roleSuffix) ? roleSuffix : ''}`;
  }
  if (/^(?:enter|fill|type)(?:The)?Password(?:Input|Textbox|Field)?$/i.test(name)) {
    name = `password${roleSuffix || 'Input'}`;
  }
  // Strip only complete CamelCase connector tokens. Case-insensitive matching
  // truncated valid role names such as `continueButton` to `continueButt` by
  // treating the final lowercase `on` as the token `On`.
  name = name.replace(/(?:For|At|On|With)$/, '').replace(/^[^A-Za-z_$]+/, '');
  if (name.length > 80) name = name.slice(0, 80).replace(/[A-Z][a-z0-9]*$/, '');
  return name || fallback;
}

function safeDataRows(rows) {
  return (rows || []).map((row, index) => {
    const fields = {};
    for (const [key, value] of Object.entries((row && row.fields) || {})) {
      if (isEnvironmentBackedValue(value)) continue;
      fields[toSafeDataKey(key)] = value == null ? '' : String(value);
    }
    return {
      index: Number.isFinite(Number(row && row.index)) ? Number(row.index) : index,
      label: (row && row.label) || `Row ${index + 1}`,
      fields,
    };
  }).filter((row) => Object.keys(row.fields).length > 0);
}

function collectDomAtlasEvidence(cases) {
  const pages = {};
  const mergePage = (domAtlas) => {
    const page = pageAtlas.normalizeDomAtlasPage(domAtlas, { pageUrl: domAtlas && domAtlas.url });
    if (!page) return;
    const key = page.pageKey || page.routeKey || '/';
    pages[key] = pageAtlas.mergeDomAtlasPage(pages[key], page, { pageKey: key });
  };
  for (const item of cases || []) {
    const ir = item && item.ir;
    if (!ir || typeof ir !== 'object') continue;
    const atlasPages = ir.domAtlas && ir.domAtlas.pages && typeof ir.domAtlas.pages === 'object'
      ? Object.values(ir.domAtlas.pages)
      : [];
    for (const page of atlasPages) mergePage(page);
    for (const step of ir.steps || []) {
      const domAtlas = step && step.actionLocator && actionLocatorResolver.isVerifiedActionLocator(step.actionLocator)
        ? actionLocatorResolver.domAtlasFromActionLocator(step.actionLocator)
        : null;
      if (domAtlas) mergePage(domAtlas);
    }
  }
  return Object.keys(pages).length
    ? { schemaVersion: pageAtlas.DOM_ATLAS_SCHEMA_VERSION, pages }
    : null;
}

function collectLocatorCertificationEvidence(cases) {
  const reports = [];
  for (const item of cases || []) {
    const ir = item && item.ir;
    if (!ir || typeof ir !== 'object') continue;
    const report = ir.locatorCertification
      || locatorIntelligenceV2.buildLocatorCertificationReport({ ir });
    if (report) reports.push(report);
  }
  return locatorIntelligenceV2.combineLocatorCertificationReports(reports);
}

function clonePlain(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function serializePageMethodStep(action, step) {
  if (!step || typeof step !== 'object') return null;
  const source = action === 'assert' ? recoveredAssertionStep(step) : step;
  const keep = {};
  const copy = (field) => {
    if (source[field] !== undefined) keep[field] = clonePlain(source[field]);
  };
  // Preserve only method-behavior metadata. Raw input values and value references stay out of
  // the serializable graph, while optionality, timeout, assertion semantics, and failure policy
  // survive the direct-emission -> merged-package round trip.
  for (const field of [
    'contractStepId', 'stepId', 'id', 'authored', 'kind', 'action', 'operation',
    'authoredOperation', 'originalAction', 'instruction', 'description', 'narration',
    'optional', 'ifPresent', 'ifVisible', 'optionalAbsent', 'timeoutMs',
    'failurePolicy', 'onFailure', 'validationMismatch', 'requiredInput', 'assertionMode',
    'continueOnFailure', 'continueIndependent', 'nonBlocking',
    'flowCritical', 'isFlowCritical', 'flowCriticalAssertion', 'hardAssertion',
    'blocksFlow', 'blocksDependentFlow', 'dependencyPrerequisite',
    'isDependencyPrerequisite', 'requiredForNextStep', 'stopOnFailure',
    'proofType', 'visualCaptured', 'proofSource', 'qualifiedPass',
    'qualifiedPassExplanation', 'browserEvent', 'browserEventEvidence',
    'eventContract', 'contextTransition', 'opensPopup', 'popupExpectedUrl',
    'downloadEvidence', 'observedConsequenceUrl', 'navigation', 'waitContract',
    'dialogEvidence', 'dialogType', 'actionGuard', 'transitionKind',
    'popupIdentity', 'pageUrlBefore', 'pageUrlAfter',
    'metadata', 'contract', 'flow', 'dependency', 'expectedOutcome',
  ]) copy(field);
  if (action === 'navigate') {
    for (const field of ['url', 'href', 'destination', 'value', 'redirectExpected', 'waitUntil']) copy(field);
  } else if (action === 'handleDialog') {
    for (const field of ['expectedMessage', 'message', 'dialogText', 'accept', 'promptText']) copy(field);
  } else if (action === 'resize') {
    for (const field of ['width', 'height', 'viewport']) copy(field);
  } else if (action === 'assert') {
    for (const field of [
      'channel', 'assertionType', 'expectedKind', 'expected', 'expectedText',
      'expectedValue', 'expectedCount', 'expectedChecked', 'missingAuthoredExpected',
      'target', 'targetLabel', 'elementLabel', 'label', 'payload', 'comparator',
      'operator', 'attributeName', 'name', 'authoredContractText', 'expectedSignals',
      'signals', 'primaryIndicator', 'assertion',
    ]) copy(field);
  }
  return Object.keys(keep).length ? keep : null;
}

function serializePageMethods(pagesMethods) {
  const out = {};
  for (const [fileName, methods] of pagesMethods || new Map()) {
    out[fileName] = [...methods.entries()].map(([key, method]) => {
      const action = method && method.action;
      const step = serializePageMethodStep(action, method && method.step);
      return {
        key,
        action,
        name: method && method.name,
        ...(method && method.locatorName ? { locatorName: method.locatorName } : {}),
        ...(step ? { step } : {}),
      };
    });
  }
  return out;
}

function methodsArrayToMap(methods) {
  const out = new Map();
  for (const [index, method] of (methods || []).entries()) {
    if (!method || !method.action) continue;
    const name = method.name || synthesizePomName(method.action, method.role || method.target || method.key, index);
    method.name = name;
    const key = method.key || `${method.action}:${name}`;
    if (!out.has(key)) {
      const step = serializePageMethodStep(method.action, method.step);
      out.set(key, {
        action: method.action,
        name,
        ...(method.locatorName ? { locatorName: method.locatorName } : {}),
        ...(step ? { step } : {}),
      });
    }
  }
  return out;
}

function locatorIdentity(entry) {
  if (!entry) return '';
  if (entry.expr) return String(entry.expr);
  if (entry.frameworkExpressions && entry.frameworkExpressions.playwright) return String(entry.frameworkExpressions.playwright);
  return JSON.stringify(entry.candidates || entry);
}

function buildPomGraph({ repo, pagesMethods, domAtlasEvidence, locatorCertificationEvidence, qualityIssues, isDraft, dataFiles, lang, moduleFormat, adapterId, standardOutputProfile, architectPlan }) {
  const pageMethods = serializePageMethods(pagesMethods);
  const pageNames = new Set([
    ...Object.keys((repo && repo.files) || {}),
    ...Object.keys(pageMethods || {}),
    ...Object.keys((architectPlan && architectPlan.pages) || {}),
  ]);
  const pages = {};
  for (const fileName of pageNames) {
    pages[fileName] = {
      locators: clonePlain(((repo && repo.files) || {})[fileName] || {}),
      methods: clonePlain(pageMethods[fileName] || []),
      architect: clonePlain(((architectPlan && architectPlan.pages) || {})[fileName] || {}),
    };
  }
  return {
    schemaVersion: 1,
    lang: lang || 'ts',
    moduleFormat: moduleFormat || 'esm',
    adapterId: adapterId || null,
    standardOutputProfile: standardOutputProfile || null,
    pages,
    manifest: clonePlain((repo && repo.manifest) || []),
    conflicts: clonePlain((repo && repo.conflicts) || []),
    domAtlas: clonePlain(domAtlasEvidence),
    locatorCertification: clonePlain(locatorCertificationEvidence),
    qualityIssues: clonePlain(qualityIssues || []),
    isDraft: !!isDraft,
    dataFiles: clonePlain(dataFiles || {}),
    architect: pomArchitectAgent.serializableReport(architectPlan),
  };
}

function mergePomGraphs(graphs, opts = {}) {
  const sourceGraphs = (graphs || []).filter(Boolean);
  const first = sourceGraphs[0] || {};
  const merged = {
    schemaVersion: 1,
    lang: opts.lang || first.lang || 'ts',
    moduleFormat: opts.moduleFormat || first.moduleFormat || 'esm',
    adapterId: opts.adapterId || first.adapterId || null,
    standardOutputProfile: opts.standardOutputProfile || first.standardOutputProfile || null,
    pages: {},
    manifest: [],
    conflicts: [],
    domAtlas: null,
    locatorCertification: null,
    qualityIssues: [],
    isDraft: false,
    dataFiles: {},
    architect: {
      schemaVersion: 'qaai-pom-architect-v1',
      mode: 'deterministic',
      pages: {},
      specPlan: [],
      rejectedAbstractions: [],
    },
  };
  const seenManifest = new Set();
  const addManifest = (entry) => {
    const key = [
      entry && entry.file,
      entry && entry.name,
      locatorIdentity(entry),
    ].map((v) => String(v == null ? '' : v)).join('\u0001');
    if (seenManifest.has(key)) return;
    seenManifest.add(key);
    merged.manifest.push(clonePlain(entry));
  };

  for (const graph of sourceGraphs) {
    merged.isDraft = merged.isDraft || !!graph.isDraft;
    merged.qualityIssues.push(...clonePlain(graph.qualityIssues || []));
    merged.conflicts.push(...clonePlain(graph.conflicts || []));
    Object.assign(merged.dataFiles, clonePlain(graph.dataFiles || {}));
    const architect = clonePlain(graph.architect || {});
    merged.architect.specPlan.push(...(architect.specPlan || []));
    merged.architect.rejectedAbstractions.push(...(architect.rejectedAbstractions || []));
    for (const [pageFile, pagePlan] of Object.entries(architect.pages || {})) {
      if (!merged.architect.pages[pageFile]) merged.architect.pages[pageFile] = { architectMethods: [], assertionMethods: [] };
      const targetPage = merged.architect.pages[pageFile];
      const seenArchitectMethods = new Set((targetPage.architectMethods || []).map((m) => m && m.name).filter(Boolean));
      for (const [index, method] of (pagePlan.architectMethods || []).entries()) {
        if (!method) continue;
        if (!method.name) method.name = synthesizePomName(method.kind || 'architect', method.role || method.locator || method.inputLocator, index);
        if (seenArchitectMethods.has(method.name)) continue;
        seenArchitectMethods.add(method.name);
        targetPage.architectMethods.push(method);
      }
      const seenAssertionMethods = new Set((targetPage.assertionMethods || []).map((m) => m && m.name).filter(Boolean));
      for (const [index, method] of (pagePlan.assertionMethods || []).entries()) {
        if (!method) continue;
        if (!method.name) method.name = synthesizePomName(method.kind || 'assert', method.role || method.locator, index);
        if (seenAssertionMethods.has(method.name)) continue;
        seenAssertionMethods.add(method.name);
        targetPage.assertionMethods.push(method);
      }
    }

    if (graph.domAtlas && graph.domAtlas.pages) {
      const current = merged.domAtlas || { schemaVersion: pageAtlas.DOM_ATLAS_SCHEMA_VERSION, pages: {} };
      for (const [pageKey, page] of Object.entries(graph.domAtlas.pages || {})) {
        current.pages[pageKey] = pageAtlas.mergeDomAtlasPage(current.pages[pageKey], page, { pageKey });
      }
      merged.domAtlas = current;
    }
    if (graph.locatorCertification) {
      const currentReports = [];
      if (merged.locatorCertification) {
        if (Array.isArray(merged.locatorCertification.cases)) currentReports.push(...merged.locatorCertification.cases);
        else currentReports.push(merged.locatorCertification);
      }
      if (Array.isArray(graph.locatorCertification.cases)) currentReports.push(...graph.locatorCertification.cases);
      else currentReports.push(graph.locatorCertification);
      merged.locatorCertification = locatorIntelligenceV2.combineLocatorCertificationReports(currentReports);
    }

    for (const entry of graph.manifest || []) addManifest(entry);

    for (const [fileName, page] of Object.entries(graph.pages || {})) {
      if (!merged.pages[fileName]) merged.pages[fileName] = { locators: {}, methods: [], architect: {} };
      const target = merged.pages[fileName];
      target.architect = clonePlain(merged.architect.pages[fileName] || target.architect || {});
      for (const [name, entry] of Object.entries((page && page.locators) || {})) {
        const existing = target.locators[name];
        if (existing && locatorIdentity(existing) !== locatorIdentity(entry)) {
          merged.conflicts.push({
            rule: 'pom_graph_locator_conflict',
            severity: 'error',
            file: fileName,
            name,
            firstExpression: locatorIdentity(existing),
            secondExpression: locatorIdentity(entry),
            message: `POM locator key ${fileName}.${name} was generated with different expressions across journey groups.`,
          });
          continue;
        }
        if (!existing) target.locators[name] = clonePlain(entry);
      }
      const methodIndex = new Map(
        target.methods.map((method, index) => [
          method && (method.key || `${method.action}:${method.name}`),
          index,
        ]),
      );
      for (const [index, method] of ((page && page.methods) || []).entries()) {
        if (!method || !method.action) continue;
        if (!method.name) method.name = synthesizePomName(method.action, method.role || method.target || method.key, index);
        const key = method.key || `${method.action}:${method.name}`;
        const candidate = clonePlain({ ...method, key });
        if (methodIndex.has(key)) {
          const existingIndex = methodIndex.get(key);
          const existing = target.methods[existingIndex];
          const existingStep = existing && existing.step;
          const candidateStep = candidate.step;
          const requiredOverridesOptional =
            method.action !== 'assert' &&
            existingStep && candidateStep &&
            pomActionIsOptional(existingStep) && !pomActionIsOptional(candidateStep);
          const assertionContractImproved =
            method.action === 'assert' &&
            ((!existing.locatorName && candidate.locatorName) ||
              (authoredAssertionExpected(existingStep) == null &&
                authoredAssertionExpected(candidateStep) != null));
          const missingStepRecovered = !existingStep && !!candidateStep;
          if (requiredOverridesOptional || assertionContractImproved || missingStepRecovered) {
            target.methods[existingIndex] = candidate;
          }
          continue;
        }
        methodIndex.set(key, target.methods.length);
        target.methods.push(candidate);
      }
    }
  }
  return merged;
}

function emitPomGraphFiles(graph, opts = {}) {
  const lang = opts.lang || (graph && graph.lang) || 'ts';
  const moduleFormat = opts.moduleFormat || (graph && graph.moduleFormat) || 'esm';
  const standardJsOutput = standardJsOutputEnabled(
    {
      adapterId: opts.adapterId || (graph && graph.adapterId),
      standardOutputProfile:
        opts.standardOutputProfile || (graph && graph.standardOutputProfile),
    },
    lang,
  );
  const fe = ext(lang);
  const files = {};
  const locatorStats = {};
  for (const [fileName, page] of Object.entries((graph && graph.pages) || {}).sort(([a], [b]) => a.localeCompare(b))) {
    const entries = (page && page.locators) || {};
    const methods = methodsArrayToMap(page && page.methods);
    files[`locators/generated/${fileName}.generated.locators${fe}`] = emitLocatorFileGenerated(fileName, entries, lang, moduleFormat);
    files[`locators/${fileName}.locators${fe}`] = emitLocatorShim(fileName, lang, moduleFormat);
    files[`pages/${pageClassName(fileName)}${fe}`] = emitPageFile(
      fileName,
      entries,
      methods,
      lang,
      moduleFormat,
      page && page.architect,
      null,
      standardJsOutput,
    );
    locatorStats[fileName] = { locatorCount: Object.keys(entries).length };
  }
  const conflicts = (graph && graph.conflicts) || [];
  if (conflicts.length) {
    files['evidence/locator-conflicts.json'] = JSON.stringify(conflicts, null, 2) + '\n';
  }
  files['evidence/locator-manifest.json'] = JSON.stringify((graph && graph.manifest) || [], null, 2) + '\n';
  if (graph && graph.domAtlas) {
    files['evidence/dom-atlas.json'] = JSON.stringify(graph.domAtlas, null, 2) + '\n';
  }
  if (graph && graph.locatorCertification) {
    files['evidence/locator-certification-report.json'] = JSON.stringify(graph.locatorCertification, null, 2) + '\n';
  }
  if (graph && graph.architect) {
    files['evidence/pom-architect-report.json'] = JSON.stringify(graph.architect, null, 2) + '\n';
  }
  if (!standardJsOutput) files['evidence/certification-report.json'] = JSON.stringify({
    fidelityPlan: 'AS_IS_FIDELITY_PLAN §4 Class G Phase 3',
    spec: {
      status: conflicts.some((c) => c && c.severity === 'error') ? 'internal-error' : (graph && graph.isDraft ? 'draft' : 'runnable'),
      qualityIssues: (graph && graph.qualityIssues) || [],
    },
    data: {
      fileCount: Object.keys((graph && graph.dataFiles) || {}).length,
      files: Object.keys((graph && graph.dataFiles) || {}),
    },
    locators: Object.fromEntries(
      Object.entries(locatorStats).map(([f, s]) => [
        `locators/generated/${f}.generated.locators${fe}`,
        { status: 'runnable', ...s },
      ])
    ),
    evidence: {
      'locator-manifest.json': { status: 'present', entryCount: ((graph && graph.manifest) || []).length },
      'locator-conflicts.json': { status: conflicts.length ? 'present' : 'absent', conflictCount: conflicts.length },
      'dom-atlas.json': { status: graph && graph.domAtlas ? 'present' : 'absent', pageCount: graph && graph.domAtlas ? Object.keys(graph.domAtlas.pages || {}).length : 0 },
      'locator-certification-report.json': {
        status: graph && graph.locatorCertification ? (graph.locatorCertification.summary && graph.locatorCertification.summary.status || 'present') : 'absent',
        stepCount: graph && graph.locatorCertification && graph.locatorCertification.summary ? graph.locatorCertification.summary.total : 0,
        certified: graph && graph.locatorCertification && graph.locatorCertification.summary ? graph.locatorCertification.summary.certified : 0,
        draft: graph && graph.locatorCertification && graph.locatorCertification.summary ? graph.locatorCertification.summary.draft : 0,
        blocked: graph && graph.locatorCertification && graph.locatorCertification.summary ? graph.locatorCertification.summary.blocked : 0,
      },
      'pom-architect-report.json': { status: graph && graph.architect ? 'present' : 'absent', methodCount: Object.values((graph && graph.architect && graph.architect.pages) || {}).reduce((n, page) => n + ((page && page.architectMethods) || []).length, 0) },
    },
  }, null, 2) + '\n';
  if (standardJsOutput) {
    for (const [filePath, source] of Object.entries(files)) {
      if (/\.(?:js|ts|cjs|mjs|md)$/i.test(filePath) && typeof source === 'string') {
        files[filePath] = sanitizeGeneratedSource(source);
      }
    }
  }
  return files;
}

function timeout(condition, fallback = 10000) {
  const n = Number(condition && condition.timeoutMs);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function envNameFromRef(kind, body) {
  const suffix = String(body || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'VALUE';
  if (kind === 'fixture') return `QAAI_FIXTURE_${suffix}`;
  if (kind === 'vault') return `QAAI_VAULT_${suffix}`;
  if (kind === 'masked') return `QAAI_MASKED_${suffix}`;
  return suffix;
}

function envKeyFromRef(ref, fallback) {
  const match = String(ref || '').match(/^(env|vault|fixture|masked):(.+)$/i);
  if (!match) return fallback;
  const kind = match[1].toLowerCase();
  const body = match[2];
  return kind === 'env' ? body : envNameFromRef(kind, body);
}

function valueExpression(step) {
  const ref = String(step.valueRef || '');
  const match = ref.match(/^(env|vault|fixture|masked):(.+)$/i);
  if (!match) return step.rawValue != null ? q(step.rawValue) : 'undefined';
  const kind = match[1].toLowerCase();
  const body = match[2];
  if (kind === 'env') return `readEnv(${q(body)})`;
  return `readEnv(${q(envNameFromRef(kind, body))})`;
}

const TYPED_BINDING_KINDS = new Set(['literal', 'secret_env', 'workbook_column', 'runtime_output', 'dependency_output', 'generated_value']);
function own(obj, key) { return !!obj && Object.prototype.hasOwnProperty.call(obj, key); }
function bindingText(...values) {
  const found = values.find((value) => value != null && String(value).trim());
  return found == null ? null : String(found).trim();
}
function stableBindingKey(step, prefix) {
  const suffix = bindingText(step && (step.contractStepId || step.stepId || step.id || step.target || step.action), 'VALUE')
    .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'VALUE';
  return `${prefix}_${suffix}`;
}
function literalExpression(value) { return value === undefined ? 'undefined' : JSON.stringify(value); }
function authoredLiteral(step, binding, purpose) {
  if (own(binding, 'value')) return binding.value;
  if (own(binding, 'literal')) return binding.literal;
  if (purpose === 'expected' && own(step, 'expected')) return step.expected;
  if (own(step, 'rawValue')) return step.rawValue;
  if (own(step, 'value')) return step.value;
  return undefined;
}
function warningExpression(message, expression) {
  const safe = String(message || '').replace(/\*\//g, '* /').replace(/\s+/g, ' ').trim();
  return `/* QAAI_BINDING_DIAGNOSTIC: ${safe} */ ${expression}`;
}
function usableWorkbookProof(binding, context, column) {
  const metadata = context && context.bindingMetadata && typeof context.bindingMetadata === 'object' ? context.bindingMetadata : {};
  const bindingId = bindingText(binding.bindingId, binding.id, binding.proofId, column);
  const proofs = [
    binding.proof,
    binding.bindingMetadata,
    bindingId && metadata.bindings && metadata.bindings[bindingId],
    column && metadata.workbookColumns && metadata.workbookColumns[column],
    column && metadata.columns && metadata.columns[column],
  ].filter(Boolean);
  return proofs.some((proof) => {
    if (proof === true) return true;
    if (!proof || typeof proof !== 'object') return false;
    const proofCaseId = bindingText(proof.caseId, proof.testCaseId);
    if (proofCaseId && context && context.caseId && proofCaseId !== String(context.caseId)) return false;
    const status = String(proof.status || '').toLowerCase();
    return proof.usable === true || proof.proven === true || proof.verified === true || ['usable', 'proven', 'verified'].includes(status);
  });
}
function typedBindingExpression(step, binding, context = {}, purpose = 'value') {
  if (!binding || typeof binding !== 'object') return null;
  const kind = String(binding.kind || '').toLowerCase();
  if (!TYPED_BINDING_KINDS.has(kind)) return null;
  const fallback = authoredLiteral(step || {}, binding, purpose);
  if (kind === 'literal') {
    return fallback === undefined
      ? warningExpression('literal binding has no authored value', `missingBindingValue('literal', ${q(stableBindingKey(step, 'LITERAL'))})`)
      : literalExpression(fallback);
  }
  if (kind === 'secret_env') {
    const raw = bindingText(binding.envKey, binding.environmentVariable, binding.name, binding.key, binding.ref);
    const key = raw && /^env:/i.test(raw) ? raw.replace(/^env:/i, '') : (raw || stableBindingKey(step, 'QAAI_SECRET'));
    return warningExpression(`secret_env reads ${key} and throws when missing; no secret is embedded`, `readEnv(${q(key)})`);
  }
  if (kind === 'workbook_column') {
    const column = bindingText(binding.column, binding.sourceColumn, binding.columnName, binding.key);
    const rowKey = context.hasDataLoop && column ? exportedDataKey(context.exportedKeys, column) : null;
    if (rowKey && usableWorkbookProof(binding, context, column)) return `readData(row, ${dataKey(rowKey)})`;
    const expression = fallback === undefined
      ? `missingBindingValue('workbook_column', ${q(stableBindingKey(step, 'WORKBOOK'))})`
      : literalExpression(fallback);
    return warningExpression('workbook_column lacks case-scoped usable-row proof; authored literal is retained', expression);
  }
  if (kind === 'runtime_output') {
    const key = bindingText(binding.output, binding.outputKey, binding.name, binding.key) || stableBindingKey(step, 'RUNTIME');
    return warningExpression(`runtime_output ${key} throws when unavailable`, `readRuntimeOutput(${q(key)})`);
  }
  if (kind === 'dependency_output') {
    const dependencyCaseId = bindingText(binding.dependencyCaseId, binding.dependsOnCaseId, binding.sourceCaseId) || 'dependency';
    const key = bindingText(binding.output, binding.outputKey, binding.name, binding.key) || stableBindingKey(step, 'OUTPUT');
    return warningExpression(`dependency_output ${dependencyCaseId}.${key} throws when unavailable`, `readDependencyOutput(${q(dependencyCaseId)}, ${q(key)})`);
  }
  const contract = binding.contract || binding.generationContract || binding.generator || {
    name: bindingText(binding.name, stableBindingKey(step, 'GENERATED')),
    prefix: binding.prefix,
    length: binding.length,
    seed: binding.seed,
  };
  return `generateDeterministicValue(${JSON.stringify({ ...contract, caseId: context.caseId || null, stepId: step && (step.contractStepId || step.stepId || step.id) || null })})`;
}

function dataRoleFromValueRef(ref) {
  const match = String(ref || '').match(/^data[.:](.+)$/i);
  return match ? toSafeDataKey(match[1]) : null;
}

function dataRoleFromBinding(binding) {
  if (!binding || typeof binding !== 'object') return null;
  const candidates = [
    binding.sourceColumn,
    binding.column,
    binding.columnName,
    binding.key,
    binding.dataRef,
    binding.ref,
    ...(Array.isArray(binding.refs) ? binding.refs : []),
  ];
  for (const candidate of candidates) {
    if (candidate == null || !String(candidate).trim()) continue;
    const role = dataRoleFromValueRef(candidate) || toSafeDataKey(candidate);
    if (role) return role;
  }
  return null;
}

function explicitDataRoleForStep(step) {
  if (!step) return null;
  if (step.dataBinding && step.dataBinding.isDataBound === true) {
    const bindingRole = dataRoleFromBinding(step.dataBinding);
    if (bindingRole) return bindingRole;
  }
  if (step.dataRole) return toSafeDataKey(step.dataRole);
  return dataRoleFromValueRef(step.valueRef);
}

function boundDataRoleForStep(step) {
  if (!step || !step.dataBinding || step.dataBinding.isDataBound !== true) return null;
  return dataRoleFromBinding(step.dataBinding)
    || toSafeDataKey(step.dataRole || step.dataExpected || dataRoleFromValueRef(step.valueRef));
}

function actionValueExpression(step, hasDataLoop, fallbackValue = null, dataHints = null) {
  if (step && step.action === 'selectOption' && Array.isArray(step.optionValues) && step.optionValues.length) {
    return JSON.stringify(step.optionValues.map(String));
  }
  if (step && step.action === 'upload' && Array.isArray(step.filePaths) && step.filePaths.length) {
    return JSON.stringify(step.filePaths.map(String));
  }
  const ref = String(step && step.valueRef || '');
  const typed = typedBindingExpression(step, step && step.valueBinding, {
    hasDataLoop,
    exportedKeys: dataHints && dataHints.exportedKeys,
    bindingMetadata: dataHints && dataHints.bindingMetadata,
    caseId: dataHints && dataHints.caseId,
  }, 'value');
  if (typed) return typed;
  const boundRole = hasDataLoop ? boundDataRoleForStep(step) : null;
  const boundRowKey = exportedDataKey(dataHints, boundRole);
  if (boundRowKey) return `readData(row, ${dataKey(boundRowKey)})`;
  if (/^(?:env|vault|fixture|masked):/i.test(ref)) return valueExpression(step);
  const requestedRole = hasDataLoop ? explicitDataRoleForStep(step) : null;
  const rowKey = exportedDataKey(dataHints, requestedRole);
  if (rowKey) return `readData(row, ${dataKey(rowKey)})`;
  if (step && (step.rawValue != null || step.valueRef)) return valueExpression(step);
  if (fallbackValue != null) return q(fallbackValue);
  return valueExpression(step || {});
}

// ── Naming helpers ───────────────────────────────────────────────────────────

// pageClassName('loginPage') → 'LoginPage'
function pageClassName(fileName) {
  return fileName.charAt(0).toUpperCase() + fileName.slice(1);
}

const ROLE_SUFFIXES_STRIP = [
  'Button', 'Link', 'MenuItem', 'Tab', 'Checkbox', 'Radio', 'Select', 'Option',
  'Heading', 'Image', 'Input', 'SearchInput', 'Element',
];

function stripRoleSuffix(name) {
  for (const s of ROLE_SUFFIXES_STRIP) {
    if (name.endsWith(s) && name.length > s.length) return name.slice(0, -s.length);
  }
  return name;
}

const ACTION_VERB = {
  fill: 'fill',
  type: 'type',
  click: 'click',
  doubleClick: 'doubleClick',
  tripleClick: 'tripleClick',
  selectOption: 'select',
  check: 'check',
  uncheck: 'uncheck',
  press: 'press',
  hover: 'hover',
  drag: 'drag',
  upload: 'upload',
  navigate: 'open',
  navigateBack: 'goBack',
  navigateForward: 'goForward',
  reload: 'reload',
  handleDialog: 'handle',
  resize: 'resize',
  close: 'close',
};

const ASSERTION_ACTION_TOKENS = new Set([
  'assert',
  'assertion',
  'expect',
  'validate',
  'validation',
  'verify',
  'verification',
]);

function assertionLikeAct(step) {
  if (!step || typeof step !== 'object') return false;
  const tokens = [
    step.kind,
    step.action,
    step.authoredOperation,
    step.originalAction,
    step.operationNormalization && step.operationNormalization.from,
  ].map((value) => String(value || '').trim().toLowerCase().replace(/[_-]+/g, ' '));
  if (tokens.some((token) => ASSERTION_ACTION_TOKENS.has(token))) return true;
  return /\bdeclared\s+assertion\b/i.test(String(
    step.targetLabel || step.elementLabel || step.label || step.description || '',
  ));
}

function recoveredAssertionStep(step) {
  const payload = step && step.payload && typeof step.payload === 'object' ? step.payload : {};
  const rawChannel = String(
    step.channel || step.assertionType || step.expectedKind || payload.channel || payload.type || 'UI_TEXT',
  ).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const channel = /URL|ROUTE|LOCATION/.test(rawChannel) ? 'URL'
    : /HIDDEN|NOT_VISIBLE|ABSENT/.test(rawChannel) ? 'HIDDEN'
      : /VISIBLE|PRESENT|DISPLAYED/.test(rawChannel) ? 'VISIBLE'
        : /COUNT/.test(rawChannel) ? 'COUNT'
          : /NUMBER|NUMERIC|AMOUNT/.test(rawChannel) ? 'NUMBER'
            : /VALUE|SELECTED/.test(rawChannel) ? 'VALUE'
              : /CHECKED/.test(rawChannel) ? 'CHECKED'
                : /ATTRIBUTE/.test(rawChannel) ? 'ATTRIBUTE'
                  : /DISABLED/.test(rawChannel) ? 'DISABLED'
                    : /ENABLED/.test(rawChannel) ? 'ENABLED'
                      : /READ.?ONLY/.test(rawChannel) ? 'READ_ONLY'
                        : /EDITABLE/.test(rawChannel) ? 'EDITABLE'
                          : /ROLE/.test(rawChannel) ? 'UI_ROLE'
                            : /PAGE|STATE/.test(rawChannel) ? 'PAGE'
                              : 'UI_TEXT';
  const expected = step.expected ?? step.expectedText ?? step.expectedValue ??
    step.expectedCount ?? step.expectedChecked ?? payload.expected ?? payload.expectedText ??
    payload.expectedValue ?? payload.expectedCount ?? payload.expectedChecked;
  const fabricatedTarget = /\bdeclared\s+assertion\b/i.test(String(
    step.targetLabel || step.elementLabel || step.label || step.description || '',
  ));
  return {
    ...step,
    op: 'assert',
    channel,
    ...(expected != null ? { expected } : {}),
    ...(fabricatedTarget ? { target: null } : {}),
  };
}

function isIdentifierName(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(name || ''));
}

function objectKey(name) {
  return isIdentifierName(name) ? String(name) : q(name);
}

function propertyRef(objectName, propName) {
  return isIdentifierName(propName)
    ? `${objectName}.${propName}`
    : `${objectName}[${q(propName)}]`;
}

function methodDeclName(name) {
  return isIdentifierName(name) ? String(name) : q(name);
}

function pageAccessorCall(pageVar, name) {
  return `${propertyRef(pageVar, name)}()`;
}

function thisAccessorCall(name, args = '') {
  return `${propertyRef('this', name)}(${args})`;
}

function locatorFieldName(name) {
  const cleaned = String(name || 'locator').replace(/[^A-Za-z0-9_$]/g, '_') || 'locator';
  return `_${cleaned}`;
}

// methodNameFor('fill', 'usernameInput') → 'fillUsername'
// methodNameFor('click', 'loginButton') → 'clickLogin'
function methodNameFor(action, semanticName) {
  if (action === 'navigateBack') return 'goBack';
  if (action === 'navigateForward') return 'goForward';
  if (action === 'reload') return 'reload';
  if (action === 'handleDialog') return semanticName === 'nextDialogDismissal' ? 'dismissNextDialog' : 'acceptNextDialog';
  if (action === 'resize') return 'resizeViewport';
  if (action === 'close') return 'closePage';
  const verb = ACTION_VERB[action] || action;
  const roleStripped = stripRoleSuffix(semanticName);
  const leadingVerb = String(verb || '');
  const hasRepeatedVerb =
    leadingVerb &&
    roleStripped.toLowerCase().startsWith(leadingVerb.toLowerCase()) &&
    /^[A-Z0-9_$]/.test(roleStripped.charAt(leadingVerb.length));
  const base = hasRepeatedVerb ? roleStripped.slice(leadingVerb.length) : roleStripped;
  const cap = base.charAt(0).toUpperCase() + base.slice(1);
  return verb + cap;
}

// PO↔SPEC BIJECTION (TIER 2.4): methodNameFor() can collapse two DISTINCT elements
// onto one name (stripRoleSuffix + capitalization, e.g. "Login button" + "Login link"
// → "clickLogin"). Without disambiguation emitPageFile skipped the 2nd method's BODY
// (seen-dedupe) while pomEmitAct still emitted a call to that name — binding the 2nd
// element's call to the 1st element's locator: a SILENT wrong-element method. This
// registry assigns a UNIQUE method name to every distinct (action, semanticName) per
// page file; BOTH the definition (emitPageFile) and the call site (pomEmitAct) read it,
// so the spec calls exactly the methods the page object defines (no missing, no wrong-
// element). Identical (action,name) still share ONE method (correct — same locator).
function buildMethodNameRegistry(pagesMethods, readableCollisions = false) {
  const registry = new Map(); // file → Map<`${action}::${name}`, mName>
  for (const [file, methods] of (pagesMethods instanceof Map ? pagesMethods : new Map())) {
    const perFile = new Map();
    const used = new Set();
    for (const [, entry] of (methods instanceof Map ? methods : new Map())) {
      const action = entry && entry.action;
      const name = entry && entry.name;
      if (!action || name == null) continue;
      const key = `${action}::${name}`;
      if (perFile.has(key)) continue;
      let mName = methodNameFor(action, name);
      if (used.has(mName)) {
        if (readableCollisions) {
          const base = mName;
          for (const suffix of ['Alternate', 'Secondary', 'Additional']) {
            if (!used.has(mName)) break;
            mName = `${base}${suffix}`;
          }
          while (used.has(mName)) mName += 'Alternative';
        } else {
          let n = 2;
          while (used.has(`${mName}_${n}`)) n += 1;
          mName = `${mName}_${n}`;
        }
      }
      used.add(mName);
      perFile.set(key, mName);
    }
    registry.set(file, perFile);
  }
  return registry;
}

// Resolve the method name for a (file, action, name), preferring the shared registry
// (attached to asMap as __methodNames) so call sites and definitions never diverge.
function resolvedMethodName(methodNameMap, action, name) {
  const fromRegistry = methodNameMap && methodNameMap.get(`${action}::${name}`);
  return fromRegistry || methodNameFor(action, name);
}

// ── Repository + asMap ───────────────────────────────────────────────────────

/**
 * Build the locator repository from all cases' IRs and a reverse-lookup map from
 * step.as (e.g. 'el1') → { file, name, pageVar, pageClass }.
 * pageVar = the variable name in the spec (e.g. 'loginPage')
 * pageClass = the class name (e.g. 'LoginPage')
 */
function caseScopeKey(caseItem, index) {
  const ir = caseItem && caseItem.ir && typeof caseItem.ir === 'object' ? caseItem.ir : {};
  return String(
    (caseItem && (caseItem.runResultId || caseItem.testCaseId || caseItem.caseId))
    || ir.runResultId
    || ir.testCaseId
    || ir.caseId
    || ir.id
    || `case-${index == null ? 'unknown' : index}`
  );
}

function entryToMapInfo(entry) {
  if (!entry || !entry.file) return null;
  return {
    file: entry.file,
    name: publicIdentifierName(entry.canonicalAlias || entry.name || synthesizePomName('element', entry.as || entry.target || entry.file, 0), entry),
    pageVar: entry.file,
    pageClass: pageClassName(entry.file),
    pageKey: entry.pageKey || null,
  };
}

function canonicalizeRepositoryPublicNames(repo) {
  const aliasesByFile = new Map();
  for (const [file, entries] of Object.entries((repo && repo.files) || {})) {
    const aliases = new Map();
    const canonicalEntries = {};
    for (const [rawName, entry] of Object.entries(entries || {})) {
      const base = publicIdentifierName(rawName, entry);
      let name = base;
      for (const suffix of ['Alternate', 'Secondary', 'Additional']) {
        if (!canonicalEntries[name] || canonicalEntries[name].expr === entry.expr) break;
        name = `${base}${suffix}`;
      }
      while (canonicalEntries[name] && canonicalEntries[name].expr !== entry.expr) name += 'Alternative';
      aliases.set(rawName, name);
      canonicalEntries[name] = { ...entry, canonicalAlias: name };
    }
    repo.files[file] = canonicalEntries;
    aliasesByFile.set(file, aliases);
  }
  for (const entry of (repo && repo.manifest) || []) {
    const canonical = aliasesByFile.get(entry.file)?.get(entry.name);
    if (canonical) {
      if (entry.as && entry.as !== canonical && !entry.sourceRef) entry.sourceRef = entry.as;
      entry.name = canonical;
      entry.canonicalAlias = canonical;
    }
  }
}

function buildAsMap(cases, {
  preferCapturedPageIdentity = false,
  materializeUnresolvedActions = false,
} = {}) {
  const repo = buildLocatorRepository({
    cases,
    pageRoleFor: null,
    preferCapturedPageIdentity,
    materializeUnresolvedActions,
  });
  canonicalizeRepositoryPublicNames(repo);
  for (const manifestEntry of repo.manifest || []) {
    const entry = repo.files?.[manifestEntry.file]?.[manifestEntry.name];
    if (!entry) continue;
    entry.source = manifestEntry.source || entry.source;
    entry.verified = manifestEntry.verified === true;
    entry.verificationStatus = manifestEntry.verificationStatus || (entry.verified ? 'verified' : 'unverified');
    entry.verificationSource = manifestEntry.verificationSource || null;
    if (manifestEntry.proof && typeof manifestEntry.proof === 'object') {
      entry.proof = clonePlain(manifestEntry.proof);
    }
    if (manifestEntry.confidence) entry.confidence = manifestEntry.confidence;
    if (manifestEntry.provenance) entry.provenance = manifestEntry.provenance;
    if (manifestEntry.warning) entry.warning = manifestEntry.warning;
  }
  const asMap = new Map();
  const caseAsMap = new Map();
  for (const [index, caseItem] of (cases || []).entries()) {
    caseAsMap.set(caseScopeKey(caseItem, index), new Map());
  }
  for (const entry of repo.manifest || []) {
    if (!entry || !entry.as) continue;
    const info = entryToMapInfo(entry);
    if (!info) continue;
    const localMap = caseAsMap.get(String(entry.caseKey || ''));
    if (localMap) localMap.set(entry.as, info);
    if (!asMap.has(entry.as)) asMap.set(entry.as, info);
  }
  const operationMap = new WeakMap();
  const operationInfos = [];
  for (const operation of repo.operations || []) {
    if (!operation || !operation.step || !operation.file) continue;
    const info = {
      file: operation.file,
      name: operation.name,
      pageVar: operation.file,
      pageClass: pageClassName(operation.file),
      action: operation.action,
      signature: operation.signature,
      pageKey: operation.pageKey || null,
    };
    operationMap.set(operation.step, info);
    operationInfos.push(info);
  }
  try {
    asMap.__operationMap = operationMap;
    asMap.__operationInfos = operationInfos;
  } catch (_) {}
  return { repo, asMap, caseAsMap };
}

function caseAsLookup(caseAsMap, caseItem, index) {
  return (caseAsMap && caseAsMap.get(caseScopeKey(caseItem, index))) || new Map();
}

function pomInfoForRef(asMap, caseMap, ref) {
  if (!ref) return null;
  return (caseMap && caseMap.get(ref)) || (asMap && asMap.get(ref)) || null;
}

function emitPomWait(condition, asMap, caseMap) {
  const c = condition || {};
  if (!(asMap && asMap.__standardJsOutput)) {
    if (c.target) {
      const info = pomInfoForRef(asMap, caseMap, c.target);
      if (info && info.file && info.name) {
        return emitWait(c, { [c.target]: pageAccessorCall(info.file, info.name) });
      }
    }
    return emitWait(condition);
  }

  const totalTimeoutMs = timeout(c, c.kind === 'networkidle' ? 15000 : 10000);
  const rawRecovery = c.recovery && typeof c.recovery === 'object' ? c.recovery : {};
  const recoveryAction = String(rawRecovery.action || (c.refreshAfterMs != null ? 'reload' : '')).toLowerCase();
  const recoveryLimitRaw = Number(rawRecovery.maxAttempts ?? (c.refreshAfterMs != null ? 1 : 0));
  const recoveryLimit = Number.isFinite(recoveryLimitRaw) && recoveryLimitRaw > 0
    ? Math.floor(recoveryLimitRaw)
    : 0;
  const refreshAfterRaw = Number(c.refreshAfterMs ?? rawRecovery.refreshAfterMs ?? totalTimeoutMs);
  const refreshAfterMs = Number.isFinite(refreshAfterRaw) && refreshAfterRaw > 0
    ? Math.min(Math.floor(refreshAfterRaw), totalTimeoutMs)
    : totalTimeoutMs;
  const retryAfterRaw = Number(rawRecovery.retryAfterMs ?? refreshAfterMs);
  const retryAfterMs = Number.isFinite(retryAfterRaw) && retryAfterRaw > 0
    ? Math.floor(retryAfterRaw)
    : refreshAfterMs;
  const recoveryWaitUntil = ['commit', 'domcontentloaded', 'load', 'networkidle'].includes(
    String(rawRecovery.waitUntil || '').toLowerCase(),
  ) ? String(rawRecovery.waitUntil).toLowerCase() : null;
  const stableObservationsRaw = Number(c.stableObservations);

  const targetExpression = () => {
    if (c.target) {
      const info = pomInfoForRef(asMap, caseMap, c.target);
      if (info && info.file && info.name)
        return { expression: pageAccessorCall(info.pageVar || info.file, info.name) };
    }
    const locator = c.locatorRecipe || c.actionLocator || null;
    const recorded = replayLocatorContract.isVerifiedActionLocator(locator)
      ? locatorExpressionFromRecipe(locator)
      : null;
    if (recorded) return { expression: recorded };
    return null;
  };

  let renderWait = null;
  const kind = String(c.kind || '').trim();
  if (kind === 'url') {
    const expected = c.pattern ?? c.expected ?? c.url;
    if (expected != null && String(expected).includes('*')) {
      renderWait = (budget) => `await page.waitForURL(${q(expected)}, { timeout: ${budget} });`;
    } else if (expected != null) {
      renderWait = (budget) => `await page.waitForURL(new RegExp(${q(`${escapeRegex(String(expected))}$`)}), { timeout: ${budget} });`;
    }
  } else if (['visible', 'hidden', 'enabled', 'disabled', 'text'].includes(kind)) {
    const target = targetExpression();
    if (target) {
      if (kind === 'visible' || kind === 'hidden') {
        renderWait = (budget) => `await ${target.expression}.waitFor({ state: ${q(kind)}, timeout: ${budget} });`;
      } else if (kind === 'enabled') {
        renderWait = (budget) => `await expect(${target.expression}).toBeEnabled({ timeout: ${budget} });`;
      } else if (kind === 'disabled') {
        renderWait = (budget) => `await expect(${target.expression}).toBeDisabled({ timeout: ${budget} });`;
      } else {
        renderWait = (budget) => `await expect(${target.expression}).toContainText(${q(c.expected ?? c.text ?? '')}, { timeout: ${budget} });`;
      }
    } else if (recoveryLimit > 0 || stableObservationsRaw > 1) {
      // The wait was positively executed, but its target cannot be represented
      // by a verified locator in the exported POM. Preserve the authored timing,
      // recovery, and same-page continuation contract without inventing a
      // narrative locator from the target description.
      renderWait = (budget) => `await page.waitForLoadState("domcontentloaded", { timeout: ${budget} });`;
    }
  } else if (kind === 'title') {
    renderWait = (budget) => `await expect(page).toHaveTitle(${q(c.expected ?? c.title ?? '')}, { timeout: ${budget} });`;
  } else if (kind === 'pageState') {
    const expected = c.expected && typeof c.expected === 'object' ? c.expected : {};
    const state = String(expected.readiness || expected.state || c.state || '').toLowerCase();
    if (['domcontentloaded', 'load', 'networkidle'].includes(state)) {
      renderWait = (budget) => `await page.waitForLoadState(${q(state)}, { timeout: ${budget} });`;
    } else {
      renderWait = (budget) => `await page.waitForLoadState("domcontentloaded", { timeout: ${budget} });`;
    }
  } else if (kind === 'loadState' || kind === 'networkidle') {
    const requestedState = kind === 'networkidle'
      ? 'networkidle'
      : String(c.expected ?? c.state ?? 'domcontentloaded').toLowerCase();
    const state = ['domcontentloaded', 'load', 'networkidle'].includes(requestedState)
      ? requestedState
      : 'domcontentloaded';
    renderWait = (budget) => `await page.waitForLoadState(${q(state)}, { timeout: ${budget} });`;
  } else if (kind === 'duration') {
    const durationMs = Math.max(0, Math.floor(Number(c.durationMs ?? c.expected) || 0));
    renderWait = () => `await page.waitForTimeout(${durationMs});`;
  } else if (kind === 'selector' && c.selector) {
    renderWait = (budget) => `await page.locator(${q(c.selector)}).waitFor({ state: ${q(c.state || 'visible')}, timeout: ${budget} });`;
  }

  if (!renderWait) {
    // A wait without an exact representable target remains evidence/diagnostic
    // metadata. Never stop the generated flow and never invent a locator from
    // the authored description.
    return null;
  }

  const stableObservations = Number.isFinite(stableObservationsRaw) && stableObservationsRaw > 1
    ? Math.floor(stableObservationsRaw)
    : 1;
  const pollIntervalRaw = Number(c.pollIntervalMs);
  const pollIntervalMs = Number.isFinite(pollIntervalRaw) && pollIntervalRaw > 0
    ? Math.floor(pollIntervalRaw)
    : 250;
  if (stableObservations > 1 && kind !== 'duration') {
    const renderSingleObservation = renderWait;
    renderWait = (budget) => [
      'await waitForStableObservations(page, {',
      `  timeoutMs: ${budget},`,
      `  observations: ${stableObservations},`,
      `  pollIntervalMs: ${pollIntervalMs},`,
      '}, async (_qaaiStableRemaining) => {',
      `  ${renderSingleObservation('_qaaiStableRemaining')}`,
      '});',
    ].join('\n');
  }

  if (recoveryAction !== 'reload' || recoveryLimit < 1 || kind === 'duration') {
    return `      ${renderWait(String(totalTimeoutMs))}`;
  }
  const reloadOptions = recoveryWaitUntil
    ? `{ timeout: _qaaiReloadBudget, waitUntil: ${q(recoveryWaitUntil)} }`
    : '{ timeout: _qaaiReloadBudget }';
  return `${[
    '      {',
    `        const _qaaiWaitDeadline = Date.now() + ${totalTimeoutMs};`,
    `        const _qaaiInitialRecoveryAfterMs = ${refreshAfterMs};`,
    `        const _qaaiRetryAfterMs = ${retryAfterMs};`,
    `        const _qaaiRecoveryLimit = ${recoveryLimit};`,
    '        let _qaaiRecoveryAttempt = 0;',
    '        while (true) {',
    '          const _qaaiRemainingBudget = _qaaiWaitDeadline - Date.now();',
    "          if (_qaaiRemainingBudget <= 0) throw new Error('Authored wait budget exhausted before the expected state was observed.');",
    '          const _qaaiCanRecover = _qaaiRecoveryAttempt < _qaaiRecoveryLimit;',
    '          const _qaaiRecoveryWindow = _qaaiRecoveryAttempt === 0 ? _qaaiInitialRecoveryAfterMs : _qaaiRetryAfterMs;',
    '          const _qaaiWaitBudget = _qaaiCanRecover ? Math.min(_qaaiRecoveryWindow, _qaaiRemainingBudget) : _qaaiRemainingBudget;',
    '          try {',
    `            ${renderWait('_qaaiWaitBudget')}`,
    '            break;',
    '          } catch (_qaaiWaitError) {',
    '            if (!_qaaiCanRecover || Date.now() >= _qaaiWaitDeadline) throw _qaaiWaitError;',
    '            _qaaiRecoveryAttempt += 1;',
    '            const _qaaiReloadBudget = _qaaiWaitDeadline - Date.now();',
    '            if (_qaaiReloadBudget <= 0) throw _qaaiWaitError;',
    `            await page.reload(${reloadOptions});`,
    '          }',
    '        }',
    '      }',
  ].join('\n')}`;
}

function isImmediatePostClickWait(step, previousClickTarget) {
  const waitTarget = step && step.condition && step.condition.target;
  const authoredRecovery = step && step.condition
    && (step.condition.refreshAfterMs != null || step.condition.recovery != null);
  if (authoredRecovery) return false;
  return !!(previousClickTarget && waitTarget && String(previousClickTarget) === String(waitTarget));
}

function allMappedInfos(asMap, caseAsMap) {
  const seen = new Set();
  const infos = [];
  const add = (info) => {
    if (!info || !info.file || !info.name) return;
    const key = `${info.file}\u0001${info.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    infos.push(info);
  };
  for (const map of (caseAsMap && caseAsMap.values && caseAsMap.values()) || []) {
    for (const info of map.values()) add(info);
  }
  for (const info of (asMap && asMap.values && asMap.values()) || []) add(info);
  for (const info of (asMap && asMap.__operationInfos) || []) add(info);
  for (const info of (asMap && asMap.__assertionInfos) || []) add(info);
  return infos;
}

function assertionChannelName(step) {
  const channel = String(step && step.channel || 'text').trim().toLowerCase();
  return channel.replace(/[^a-z0-9]+(.)/g, (_match, next) => String(next || '').toUpperCase()) || 'text';
}

function assertionSignalName(step) {
  const signals = pageSignals(step) || {};
  return firstSignal(signals.heading)
    || firstSignal(signals.title)
    || firstSignal(signals.text)
    || firstSignal(signals.role)
    || null;
}

function assertionMethodSemanticName(step, info, ordinal) {
  const seed = info?.name
    || step?.targetLabel
    || step?.elementLabel
    || step?.targetName
    || assertionSignalName(step)
    || step?.authoredContractText
    || step?.description
    || `page ${assertionChannelName(step)}`;
  const words = String(seed || '').trim().split(/[^A-Za-z0-9_$]+/).filter(Boolean);
  const readableSeed = words.length > 1
    ? `${words[0].charAt(0).toLowerCase()}${words[0].slice(1)}${words.slice(1).map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join('')}`
    : seed;
  const base = publicIdentifierName(readableSeed, null, `assertion${ordinal + 1}`);
  const suffix = assertionChannelName(step);
  return base.toLowerCase().endsWith(suffix.toLowerCase()) ? base : `${stripRoleSuffix(base)}${suffix.charAt(0).toUpperCase()}${suffix.slice(1)}`;
}

function observedPageLabel(step) {
  return step?.authoredPageName
    || step?.semanticPageName
    || step?.pageRole
    || step?.pageName
    || step?.expectedPageTitle
    || step?.pageTitle
    || step?.capturedPageTitle
    || step?.pageIdentity?.title
    || null;
}

function actionLocatorObservedUrl(step) {
  const primary = step?.actionLocator
    ? actionLocatorResolver.primaryActionLocator(step.actionLocator)
    : null;
  const sources = [
    step?.pageUrl,
    step?.pageUrlBefore,
    step?.pageIdentity?.url,
    step?.pageIdentity?.href,
    primary?.pageUrl,
    primary?.documentUrl,
    primary?.context?.documentUrl,
    primary?.context?.pageUrl,
    primary?.context?.pageIdentity?.url,
    primary?.context?.pageIdentity?.href,
    primary?.proof?.targetIdentity?.documentUrl,
    primary?.proof?.matchedIdentity?.documentUrl,
    step?.actionLocator?.context?.documentUrl,
    step?.actionLocator?.captureEvidence?.pre?.documentUrl,
    step?.actionLocator?.captureEvidence?.post?.documentUrl,
  ];
  return sources.find((value) => typeof value === 'string' && value.trim()) || null;
}

function transientControlContextLabel(value) {
  const label = String(value || '').trim();
  if (!label) return false;
  if (/\b(?:button|field|input|checkbox|radio|dropdown|combobox|link|prompt)\b/i.test(label)) {
    return true;
  }
  const words = label.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.length <= 4 && /\b(?:password|username|email|phone|skype|otp|passcode)\b/i.test(label);
}

function capturedContextLabel(step) {
  const primary = step?.actionLocator
    ? actionLocatorResolver.primaryActionLocator(step.actionLocator)
    : null;
  const pageIdentity = step?.pageIdentity
    || primary?.pageIdentity
    || primary?.context?.pageIdentity
    || null;
  const authoredIdentity = step?.authoredPageName
    || step?.pageRole
    || step?.pageName
    || step?.expectedPage
    || step?.expectedPageTitle;
  const label = step?.capturedPageTitle
    || pageIdentity?.title
    || pageIdentity?.pageTitle
    || primary?.context?.pageTitle
    || primary?.domAtlas?.title
    || (!authoredIdentity ? step?.pageTitle : null)
    || null;
  return !authoredIdentity && transientControlContextLabel(label) ? null : label;
}

function observedBrowserContextKey(url) {
  let origin = '';
  try { origin = new URL(String(url || '')).origin; } catch (_) {}
  return `${origin}|${pageKey(url)}`;
}

function contextRouteWords(url) {
  return new Set(String(pageKey(url) || '')
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word && word !== 'root' && word !== 'id'));
}

function chooseCanonicalContextLabel(records, url) {
  const routeWords = contextRouteWords(url);
  const byLabel = new Map();
  for (const record of records || []) {
    const label = String(record?.label || '').trim();
    if (!label) continue;
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key) continue;
    const current = byLabel.get(key) || { label, count: 0, first: record.first };
    current.count += 1;
    current.first = Math.min(current.first, record.first);
    byLabel.set(key, current);
  }
  let best = null;
  for (const candidate of byLabel.values()) {
    const words = String(candidate.label).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const overlap = words.filter((word) => routeWords.has(word)).length;
    const score = (overlap * 10000) + (candidate.count * 100) + Math.min(words.length, 6);
    if (!best || score > best.score || (score === best.score && candidate.first < best.first)) {
      best = { ...candidate, score };
    }
  }
  return best?.label || null;
}

// The standard JavaScript profile partitions POMs by the observed browser
// context (origin + normalized route). Captured titles can legitimately change
// while one page renders a provider choice or intermediate state; those title
// changes must not create implementation-named page objects for the same URL.
// This clone-only pass also restores missing URL metadata from the authoritative
// action-locator context. User-authored page names and Unicode values are not
// rewritten.
function normalizeStandardJsPageContexts(cases) {
  const cloned = (cases || []).map((caseItem) => ({
    ...caseItem,
    ir: caseItem?.ir && typeof caseItem.ir === 'object'
      ? { ...caseItem.ir, steps: (caseItem.ir.steps || []).map((step) => ({ ...step })) }
      : caseItem?.ir,
  }));
  const recordsByContext = new Map();
  let ordinal = 0;
  for (const caseItem of cloned) {
    let currentUrl = null;
    for (const step of caseItem?.ir?.steps || []) {
      if (step?.op === 'act' && step.action === 'navigate' && step.url) currentUrl = step.url;
      const observedUrl = actionLocatorObservedUrl(step) || currentUrl;
      if (observedUrl) currentUrl = observedUrl;
      const label = capturedContextLabel(step);
      if (currentUrl && label) {
        const key = observedBrowserContextKey(currentUrl);
        if (!recordsByContext.has(key)) recordsByContext.set(key, { url: currentUrl, records: [] });
        recordsByContext.get(key).records.push({ label, first: ordinal });
      }
      ordinal += 1;
      if (step?.pageUrlAfter) currentUrl = step.pageUrlAfter;
    }
  }
  const labels = new Map();
  for (const [key, value] of recordsByContext) {
    labels.set(key, chooseCanonicalContextLabel(value.records, value.url));
  }
  for (const caseItem of cloned) {
    let currentUrl = null;
    const declaredById = new Map();
    for (const declared of caseItem?.declaredSteps || []) {
      const identity = declared?.id
        || declared?.contractStepId
        || declared?.stepId
        || declared?.requirementId;
      if (identity != null) declaredById.set(String(identity), declared);
    }
    caseItem.ir.steps = (caseItem.ir.steps || []).map((step) => {
      if (step?.op === 'act' && step.action === 'navigate' && step.url) currentUrl = step.url;
      const directUrl = actionLocatorObservedUrl(step);
      const observedUrl = directUrl || currentUrl;
      if (observedUrl) currentUrl = observedUrl;
      const canonicalLabel = observedUrl ? labels.get(observedBrowserContextKey(observedUrl)) : null;
      const normalized = { ...step };
      if (!normalized.pageUrl && !normalized.pageUrlBefore && observedUrl) normalized.pageUrl = observedUrl;
      if (canonicalLabel && capturedContextLabel(step)) {
        const declared = declaredById.get(String(
          step?.contractStepId || step?.stepId || step?.sourceContractStepId || step?.id || '',
        )) || null;
        const declaredSemanticName = declared?.semanticPageName || null;
        normalized.capturedPageTitle = canonicalLabel;
        normalized.pageIdentity = {
          ...(normalized.pageIdentity && typeof normalized.pageIdentity === 'object'
            ? normalized.pageIdentity
            : {}),
          title: canonicalLabel,
          pageTitle: canonicalLabel,
        };
        if (normalized.semanticPageName && !declaredSemanticName) {
          normalized.semanticPageName = canonicalLabel;
        }
        const hasAuthoredIdentity = normalized.authoredPageName
          || declaredSemanticName
          || normalized.pageRole
          || normalized.pageName
          || normalized.expectedPage
          || normalized.expectedPageTitle;
        if (!hasAuthoredIdentity && normalized.pageTitle) normalized.pageTitle = canonicalLabel;
      }
      const declared = declaredById.get(String(
        step?.contractStepId || step?.stepId || step?.sourceContractStepId || step?.id || '',
      )) || null;
      if (
        normalized.semanticPageName
        && !declared?.semanticPageName
        && transientControlContextLabel(normalized.semanticPageName)
      ) {
        delete normalized.semanticPageName;
      }
      if (step?.pageUrlAfter) currentUrl = step.pageUrlAfter;
      return normalized;
    });
  }
  return cloned;
}

function assertionOwnerInfo(step, mappedInfos, currentInfo, currentUrl, ordinal) {
  const explicitUrl = step?.pageUrlAfter || step?.pageUrl || step?.pageUrlBefore || currentUrl || null;
  const explicitKey = explicitUrl ? pageKey(explicitUrl) : null;
  const assertionPageLabel = observedPageLabel(step);
  if (explicitKey) {
    if (currentInfo && currentInfo.pageKey === explicitKey) return currentInfo;
    const matched = mappedInfos.find((info) => info && info.pageKey === explicitKey);
    if (matched) return matched;
    const pageAssertionFile = assertionPageLabel ? pageFileName(explicitKey, assertionPageLabel) : null;
    const file = pageAssertionFile || pageFileName(explicitKey, assertionPageLabel);
    return { file, pageVar: file, pageClass: pageClassName(file), pageKey: explicitKey, name: `assertion${ordinal + 1}` };
  }
  return currentInfo
    || mappedInfos[mappedInfos.length - 1]
    || {
      file: pageFileName('root', observedPageLabel(step)),
      pageVar: pageFileName('root', observedPageLabel(step)),
      pageClass: pageClassName(pageFileName('root', observedPageLabel(step))),
      pageKey: 'root',
      name: `assertion${ordinal + 1}`,
    };
}

function firstMappedOwnerForCase(caseItem, index, asMap, caseAsMap) {
  const caseMap = caseAsLookup(caseAsMap, caseItem, index);
  for (const candidate of (caseItem?.ir?.steps || [])) {
    if (candidate?.op === 'resolve' && candidate.as) {
      const resolved = pomInfoForRef(asMap, caseMap, candidate.as);
      if (resolved) return resolved;
    }
    if (candidate?.op === 'act' && candidate.authored !== false && !assertionLikeAct(candidate)) {
      const resolved = PAGE_LEVEL_ACTIONS.has(String(candidate.action || ''))
        ? asMap.__operationMap && asMap.__operationMap.get(candidate)
        : (candidate.target && pomInfoForRef(asMap, caseMap, candidate.target));
      if (resolved) return resolved;
    }
  }
  return null;
}

function terminalContinuationOwner(cases, caseIndex, caseSteps, stepIndex, asMap, caseAsMap) {
  const hasLaterOwnedOperation = caseSteps.slice(stepIndex + 1).some((candidate) => {
    if (candidate?.op === 'resolve' && candidate.as) return true;
    return candidate?.op === 'act' && candidate.authored !== false && !assertionLikeAct(candidate);
  });
  if (hasLaterOwnedOperation) return null;
  const nextCase = cases[caseIndex + 1];
  if (!nextCase || !isContinuationCase(nextCase)) return null;
  return firstMappedOwnerForCase(nextCase, caseIndex + 1, asMap, caseAsMap);
}

/**
 * Walk all IR steps and collect (pageFile → Map<methodKey → { action, name }>) for
 * every locator-backed act step that has a POM mapping.  Used to emit page methods.
 */
function collectPageMethods(cases, asMap) {
  const pagesMethods = new Map(); // file → Map<key → { action, name }>
  for (const { ir } of cases) {
    for (const step of (ir && ir.steps) || []) {
      if (!step || step.authored === false || step.op !== 'act' || !step.target || assertionLikeAct(step)) continue;
      const action = String(step.action || '');
      if (!ACTION_VERB[action]) continue;
      const info = asMap.get(step.target);
      if (!info) continue;
      if (!pagesMethods.has(info.file)) pagesMethods.set(info.file, new Map());
      const name = info.name || synthesizePomName(action, step.role || step.target, pagesMethods.get(info.file).size);
      const key = `${action}:${name}`;
      if (!pagesMethods.get(info.file).has(key)) {
        pagesMethods.get(info.file).set(key, { action, name });
      }
    }
  }
  return pagesMethods;
}

collectPageMethods = function collectPageMethodsCaseScoped(cases, asMap, caseAsMap) {
  const pagesMethods = new Map();
  const assertionMap = new WeakMap();
  const assertionInfos = [];
  const mappedInfos = allMappedInfos(asMap, caseAsMap);
  const caseList = cases || [];
  for (const [index, caseItem] of caseList.entries()) {
    const { ir } = caseItem || {};
    const caseMap = caseAsLookup(caseAsMap, caseItem, index);
    let currentInfo = null;
    let currentUrl = null;
    let assertionOrdinal = 0;
    const caseSteps = (ir && ir.steps) || [];
    for (const [stepIndex, step] of caseSteps.entries()) {
      if (step?.pageUrl || step?.pageUrlBefore) currentUrl = step.pageUrl || step.pageUrlBefore;
      if (step?.op === 'act' && step.action === 'navigate' && step.url) currentUrl = step.url;
      if (step?.op === 'resolve' && step.as) currentInfo = pomInfoForRef(asMap, caseMap, step.as) || currentInfo;
      if (step?.op === 'assert' && step.authored !== false && step.channel !== 'EVALUATE') {
        if (!assertionExecutableContract(step).executable) {
          assertionOrdinal += 1;
          continue;
        }
        const targetInfo = step.target && pomInfoForRef(asMap, caseMap, step.target);
        const continuationOwner = !targetInfo
          ? terminalContinuationOwner(caseList, index, caseSteps, stepIndex, asMap, caseAsMap)
          : null;
        const owner = targetInfo
          || continuationOwner
          || assertionOwnerInfo(step, mappedInfos, currentInfo, currentUrl, assertionOrdinal);
        if (owner) {
          const name = assertionMethodSemanticName(step, targetInfo, assertionOrdinal);
          const info = {
            ...owner,
            name,
            locatorName: targetInfo?.name || null,
            step,
            caseKey: caseScopeKey(caseItem, index),
          };
          assertionMap.set(step, info);
          assertionInfos.push(info);
          if (!pagesMethods.has(info.file)) pagesMethods.set(info.file, new Map());
          const key = `assert:${name}`;
          if (!pagesMethods.get(info.file).has(key)) {
            pagesMethods.get(info.file).set(key, { action: 'assert', name, locatorName: info.locatorName, step });
          }
        }
        assertionOrdinal += 1;
        continue;
      }
      if (!step || step.authored === false || step.op !== 'act' || assertionLikeAct(step)) continue;
      const action = String(step.action || '');
      if (!ACTION_VERB[action]) continue;
      const info = PAGE_LEVEL_ACTIONS.has(action)
        ? asMap.__operationMap && asMap.__operationMap.get(step)
        : (step.target && pomInfoForRef(asMap, caseMap, step.target));
      if (!info) continue;
      currentInfo = info;
      if (!pagesMethods.has(info.file)) pagesMethods.set(info.file, new Map());
      const name = info.name || synthesizePomName(action, step.role || step.target, pagesMethods.get(info.file).size);
      const key = `${action}:${name}`;
      const existingMethod = pagesMethods.get(info.file).get(key);
      if (!existingMethod) {
        pagesMethods.get(info.file).set(key, { action, name, step });
      } else if (pomActionIsOptional(existingMethod.step) && !pomActionIsOptional(step)) {
        // A method reused by required and optional occurrences must remain required.
        // The optional occurrence is guarded at its call site instead.
        existingMethod.step = step;
      }
      if (step.pageUrlAfter) {
        currentUrl = step.pageUrlAfter;
        currentInfo = null;
      }
    }
  }
  try {
    asMap.__assertionMap = assertionMap;
    asMap.__assertionInfos = assertionInfos;
  } catch (_) {}
  return pagesMethods;
};

function materializeAuthoredAssertionLocators(repo, asMap, pagesMethods) {
  for (const info of (asMap && asMap.__assertionInfos) || []) {
    if (!info || info.locatorName || !info.file || !info.step) continue;
    const channel = String(info.step.channel || 'UI_TEXT').trim().toUpperCase();
    if (!['UI_TEXT', 'FORBIDDEN_TEXT', 'PAGE'].includes(channel)) continue;

    const authoredExpected = authoredAssertionExpected(info.step);
    const dynamicExpected = assertionNeedsExpectedParameter(info.step);
    if (!dynamicExpected && authoredExpected === undefined) continue;

    const entries = repo.files[info.file] || (repo.files[info.file] = {});
    const baseName = publicIdentifierName(info.name || `${assertionChannelName(info.step)} assertion`);
    let locatorName = baseName;
    let suffix = 2;
    const parameterized = dynamicExpected;
    const expr = parameterized
      ? 'page.getByText(expected, { exact: true }).first()'
      : `page.getByText(${q(authoredExpected)}, { exact: false })`;
    while (entries[locatorName] && entries[locatorName].expr !== expr) {
      locatorName = `${baseName}${suffix}`;
      suffix += 1;
    }

    if (!entries[locatorName]) {
      const entry = {
        file: info.file,
        name: locatorName,
        canonicalAlias: locatorName,
        expr,
        parameterized,
        contractual: true,
        source: 'authoredAssertionContract',
        verified: false,
        verificationStatus: 'authored_contract',
        verificationSource: 'authored_contract',
        provenance: { kind: 'authored_assertion_contract' },
      };
      entries[locatorName] = entry;
      repo.manifest.push({
        ...clonePlain(entry),
        caseKey: info.caseKey || null,
        contractStepId: info.step.contractStepId || info.step.stepId || null,
        authoredActionId: info.step.authoredActionId || null,
      });
    }

    info.locatorName = locatorName;
    info.locatorParameterized = parameterized;
    const selectedMethod = pagesMethods.get(info.file)?.get(`assert:${info.name}`);
    if (selectedMethod) {
      selectedMethod.locatorName = locatorName;
      selectedMethod.locatorParameterized = parameterized;
    }
  }
}

function assertStandardJsPomCoverage(cases, asMap, caseAsMap) {
  for (const [index, caseItem] of (cases || []).entries()) {
    const caseMap = caseAsLookup(caseAsMap, caseItem, index);
    for (const step of (caseItem?.ir?.steps || [])) {
      if (!step || step.authored === false || step.op !== 'act' || assertionLikeAct(step)) continue;
      const action = String(step.action || '');
      if (!ACTION_VERB[action]) continue;
      if (PAGE_LEVEL_ACTIONS.has(action)) {
        if (asMap.__operationMap && asMap.__operationMap.get(step)) continue;
        throw new Error(`Playwright POM JavaScript invariant: authored ${action} step has no centralized page-level method mapping.`);
      }
      const target = String(step.target || '').trim();
      if (!target || !pomInfoForRef(asMap, caseMap, target)) {
        throw new Error(`Playwright POM JavaScript invariant: authored ${action || 'action'} step ${String(step.contractStepId || step.stepId || 'without an id')} has no centralized page-object mapping.`);
      }
      if (action !== 'drag') continue;
      const destinationTarget = String(step.destinationTarget || '').trim();
      if (destinationTarget && pomInfoForRef(asMap, caseMap, destinationTarget)) continue;
      throw new Error(`Playwright POM JavaScript invariant: authored drag step ${String(step.contractStepId || step.stepId || 'without an id')} has no centralized destination page-object mapping.`);
    }
  }
}

// ── File emitters ────────────────────────────────────────────────────────────

/**
 * Helper: emit one locator property line (or multi-line .or() chain).
 * Action-time expressions are authoritative; semantic OR chains are fallback for legacy
 * candidate-only ReplayIR where the live ActionLocator contract is not present.
 */
function locatorFallbackKind(entry) {
  const source = String(entry && (entry.source || entry.provenance?.kind || entry.locatorProvenance?.kind) || 'candidate').trim();
  // An assertion locator is an executable projection of an authored contract,
  // not a browser-action locator guess. Keep its provenance explicit without
  // presenting it as CDP-verified action evidence or as an unreliable fallback.
  if (entry?.contractual === true || source === 'authoredAssertionContract') return null;
  if (entry && entry.verified === true && source === 'actionLocator') return null;
  if (/llm/i.test(source)) return 'LLM locator inference';
  if (/structural/i.test(source)) return 'structural locator fallback';
  if (/semantic|guess/i.test(source)) return 'semantic locator guess';
  if (/candidate/i.test(source)) return 'unverified locator candidate';
  return `${source || 'unverified'} locator fallback`;
}

function emitLocatorEntry(name, entry, lang = 'ts') {
  const contractualAssertion =
    entry?.contractual === true ||
    entry?.source === 'authoredAssertionContract' ||
    entry?.provenance?.kind === 'authoredAssertionContract';
  if (
    !entry ||
    (!contractualAssertion &&
      (entry.verified !== true ||
        !replayLocatorContract.isVerifiedActionLocator(entry.actionLocator))) ||
    !entry.expr
  ) {
    return null;
  }
  const expectedParam = entry?.parameterized === true
    ? (lang === 'js' ? ', expected' : ', expected: string | number | boolean')
    : '';
  const pageParam = `${lang === 'js' ? 'page' : 'page: Page'}${expectedParam}`;
  const key = objectKey(name);
  const exact = String(entry.expr || '').replace(/^page\./, '');
  return `  // prettier-ignore\n  ${key}: (${pageParam}) => page.${exact},`;
}

/**
 * Emit locators/<page>.locators.ts
 * Stores the EXACT action-time locator expression (guardrail 1 — never re-derived).
 * The expr from selectStaticLocator is like: page.getByRole("textbox", { name: "Username" })
 * We strip the leading `page.` and wrap as a function: (page: Page) => page.<rest>
 */
function emitLocatorFile(fileName, entries) {
  const constName = `${fileName}Locators`;
  const lines = [
    `// generated — do not edit; copy to locators/overrides/${fileName}.override.ts to customize`,
    `// Source: QAAI replayIrJson (action-time locators; semantic fallback only when action evidence is absent)`,
    `import type { Page } from '@playwright/test';`,
    ``,
    `export const ${constName} = {`,
  ];
  for (const [name, entry] of Object.entries(entries)) {
    const rendered = emitLocatorEntry(publicIdentifierName(name, entry), entry);
    if (rendered) lines.push(rendered);
  }
  lines.push(`};`);
  lines.push(`export type ${pageClassName(fileName)}LocatorKey = keyof typeof ${constName};`);
  return lines.join('\n') + '\n';
}

// ── Phase 3: G.2 / G.7 / G.8 ────────────────────────────────────────────────

/**
 * G.2 — Emit locators/generated/<page>.generated.locators.ts
 * The authoritative generated file — overwritten safely on each export.
 * Uses action-owned locator evidence first; semantic fallback chains are only used for
 * legacy candidate-only ReplayIR where action locator evidence is absent.
 */
function emitLocatorFileGenerated(fileName, entries, lang = 'ts', moduleFormat = 'esm') {
  const constName = `${fileName}Locators`;
  const overrideExt = ext(lang);
  const cjs = isCjs(lang, moduleFormat);
  const lines = [
    `// GENERATED — do not edit directly. Overwritten on every QAAI export.`,
    `// Source: replayIrJson (exact-node verified action-time locators only).`,
    `// To override: copy to locators/overrides/${fileName}.override${overrideExt}, then change`,
    `//   locators/${fileName}.locators${overrideExt} to re-export from './overrides/${fileName}.override${importExt(lang, moduleFormat)}'.`,
  ];
  if (lang !== 'js') lines.push(`import type { Page } from '@playwright/test';`);
  lines.push(``, `${cjs ? 'const' : 'export const'} ${constName} = {`);
  for (const [name, entry] of Object.entries(entries)) {
    const rendered = emitLocatorEntry(publicIdentifierName(name, entry), entry, lang);
    if (rendered) lines.push(rendered);
  }
  lines.push(`};`);
  if (cjs) lines.push(`module.exports = { ${constName} };`);
  else if (lang !== 'js') lines.push(`export type ${pageClassName(fileName)}LocatorKey = keyof typeof ${constName};`);
  return lines.join('\n') + '\n';
}

/**
 * G.2 — Emit the shim at locators/<page>.locators.ts.
 * Re-exports from generated/ by default. Tester edits this file (not the generated
 * file) to point at an override — the shim itself is not overwritten on regeneration.
 */
function emitLocatorShim(fileName, lang = 'ts', moduleFormat = 'esm') {
  const overrideExt = ext(lang);
  const cjs = isCjs(lang, moduleFormat);
  const generatedPath = `./generated/${fileName}.generated.locators${importExt(lang, moduleFormat)}`;
  const overridePath = `./overrides/${fileName}.override${importExt(lang, moduleFormat)}`;
  const exportLine = cjs
    ? `module.exports = require('${generatedPath}');`
    : `export * from '${generatedPath}';`;
  return [
    `// QAAI locator index — this file is NOT overwritten on regeneration; edit it to switch to an override.`,
    `// Default: forwards to the QAAI-generated action-time locators (locators/generated/).`,
    `// Override: create locators/overrides/${fileName}.override${overrideExt}, then change the line below`,
    `//   to: ${cjs ? `module.exports = require('${overridePath}');` : `export * from '${overridePath}';`}`,
    exportLine,
    ``,
  ].join('\n');
}

// G.7 quality signals — downgrade spec to Draft (still runnable, flagged for review).
const QUALITY_SIGNALS = [
  { code: 'el-variables', re: /\bel\d+\./, detail: 'raw el1/el2 variable access (inline fallback — step not POM-mapped)' },
  { code: 'telemetry-annotations', re: /test\.info\(\)\.annotations\.push/, detail: 'test.info() annotations carry internal telemetry IDs' },
  { code: 'generic-test-name', re: /test\(\s*['"]full journey['"]\s*,/, detail: 'test name is generic "full journey" with no scenario context' },
];

function detectQualityIssues(content) {
  const issues = [];
  // Check only the test body (not import lines) to avoid false positives on imported names.
  const body = content.split('\n').filter((l) => !l.trimStart().startsWith('import ')).join('\n');
  for (const sig of QUALITY_SIGNALS) {
    if (sig.re.test(body)) issues.push({ code: sig.code, detail: sig.detail });
  }
  return issues;
}

function pomActionIsOptional(step) {
  if (!step || typeof step !== 'object') return false;
  if (
    step.optional === true ||
    step.ifPresent === true ||
    step.ifVisible === true ||
    step.optionalAbsent === true ||
    ['continue', 'skip', 'ignore'].includes(
      String(step.optionalAbsent == null ? '' : step.optionalAbsent).trim().toLowerCase(),
    )
  ) return true;
  const text = [
    step.action,
    step.operation,
    step.authoredOperation,
    step.originalAction,
    step.instruction,
    step.description,
    step.narration,
  ].map((value) => String(value || '')).join(' ').replace(/[_-]+/g, ' ').toLowerCase();
  return /\boptional(?:ly)?\b/.test(text) ||
    /\b(?:if|when)\b.{0,96}\b(?:visible|present|available|shown|displayed|found|exists?|appears?|applicable)\b/.test(text);
}

function sanitizeGeneratedSource(source) {
  const repaired = String(source == null ? '' : source)
    .replace(/\u00e2\u201d\u20ac/g, '-')
    .replace(/\u00e2\u20ac\u201d/g, '--')
    .replace(/\u00e2\u2020\u2019/g, '->')
    .replace(/\u00e2\u2020\u2014/g, '<->')
    .replace(/\u00c2\u00a7/g, 'Section ')
    .replace(/\u00e2[^\x00-\x7f]{2}/g, '-')
    .replace(/\u00c2(?=[^\x00-\x7f])/g, '');
  return repaired
    .split('\n')
    .map((line) =>
      /^\s*\/\//.test(line)
        ? line
            .replace(/[\u2500-\u257f]+/g, '-')
            .replace(/[\u2013\u2014]/g, '-')
            .replace(/\u2192/g, '->')
            .replace(/\u00a7/g, 'Section ')
        : line,
    )
    .join('\n');
}

function buildMethodBody(action, semName, constName, method = {}) {
  const step = method.step || {};
  if (action === 'navigate') {
    const navUrl = relativeUrl(step.url || step.href || step.destination || step.value || '');
    const navigation = step.navigation && typeof step.navigation === 'object' ? step.navigation : {};
    const waitUntil = ['commit', 'domcontentloaded', 'load', 'networkidle'].includes(
      String(navigation.waitUntil || step.waitUntil || '').toLowerCase(),
    ) ? String(navigation.waitUntil || step.waitUntil).toLowerCase() : 'domcontentloaded';
    const navigationTimeout = timeout(navigation, timeout(step, null));
    const timeoutOption = navigationTimeout ? `, timeout: ${navigationTimeout}` : '';
    if (step.redirectExpected) {
      return `try { await this.page.goto(${q(navUrl)}, { waitUntil: 'commit'${timeoutOption} }); } catch (error) { if (!String(error && error.message).includes('ERR_ABORTED')) throw error; }`;
    }
    return `await this.page.goto(${q(navUrl)}, { waitUntil: ${q(waitUntil)}${timeoutOption} });`;
  }
  if (action === 'navigateBack' || action === 'navigateForward' || action === 'reload') {
    const navigation = step.navigation && typeof step.navigation === 'object' ? step.navigation : {};
    const waitUntil = ['commit', 'domcontentloaded', 'load', 'networkidle'].includes(
      String(navigation.waitUntil || step.waitUntil || '').toLowerCase(),
    ) ? String(navigation.waitUntil || step.waitUntil).toLowerCase() : 'domcontentloaded';
    const navigationTimeout = timeout(navigation, timeout(step, null));
    const timeoutOption = navigationTimeout ? `, timeout: ${navigationTimeout}` : '';
    const methodName = action === 'navigateBack' ? 'goBack' : action === 'navigateForward' ? 'goForward' : 'reload';
    return `await this.page.${methodName}({ waitUntil: ${q(waitUntil)}${timeoutOption} });`;
  }
  if (action === 'handleDialog') {
    const expectedMessage = step.expectedMessage || step.message || step.dialogText || null;
    const expectation = expectedMessage == null
      ? ''
      : `if (!String(dialog.message()).includes(${q(expectedMessage)})) throw new Error(${q(`Expected browser dialog containing "${expectedMessage}".`)}); `;
    const disposition = step.accept === false
      ? 'await dialog.dismiss();'
      : `await dialog.accept(${step.promptText != null ? q(step.promptText) : ''});`;
    return `this.page.once('dialog', async (dialog) => { ${expectation}${disposition} });`;
  }
  if (action === 'resize') {
    const width = Number(step.width || step.viewport?.width) || 1280;
    const height = Number(step.height || step.viewport?.height) || 720;
    return `await this.page.setViewportSize({ width: ${Math.floor(width)}, height: ${Math.floor(height)} });`;
  }
  if (action === 'close') return `if (!this.page.isClosed()) await this.page.close();`;
  const loc = thisAccessorCall(semName);
  const optionalBody = (statement) => {
    if (!pomActionIsOptional(method.step)) return statement;
    const ms = timeout(method.step, 2000);
    return `const optionalTarget = ${loc};\nconst appeared = await optionalTarget.waitFor({ state: 'visible', timeout: ${ms} }).then(() => true).catch(() => false);\nif (appeared) { ${statement.replace(loc, 'optionalTarget')} }`;
  };
  if (action === 'fill') return optionalBody(`await ${loc}.fill(value);`);
  if (action === 'type') return optionalBody(`await ${loc}.pressSequentially(value);`);
  if (action === 'click') return optionalBody(`await ${loc}.click(options);`);
  if (action === 'doubleClick') return optionalBody(`await ${loc}.dblclick(options);`);
  // LEGACY-TRACE TRANSLATOR: the live conductor no longer emits tripleClick (MCP has
  // no browser_triple_click), but a historical recorded trace may carry the action;
  // emit valid Playwright (clickCount:3) so older specs still export cleanly.
  if (action === 'tripleClick') return optionalBody(`await ${loc}.click({ ...options, clickCount: 3 });`);
  if (action === 'selectOption') return optionalBody(`await ${loc}.selectOption(value);`);
  if (action === 'check') return optionalBody(`await ${loc}.check();`);
  if (action === 'uncheck') return optionalBody(`await ${loc}.uncheck();`);
  if (action === 'press') return optionalBody(`await ${loc}.press(value);`);
  if (action === 'hover') return optionalBody(`await ${loc}.hover();`);
  if (action === 'drag') return optionalBody(`await ${loc}.dragTo(target);`);
  if (action === 'upload') return optionalBody(`await ${loc}.setInputFiles(value);`);
  return `throw new Error(${q(`QAAI cannot represent the executed action "${action}" exactly.`)});`;
}

function assertionNeedsExpectedParameter(step) {
  const channel = String(step?.channel || 'UI_TEXT').trim().toUpperCase();
  if (channel === 'PAGE' && pageSignals(step)) return false;
  if (['UI_TEXT', 'FORBIDDEN_TEXT', 'VALUE', 'SELECTED', 'NUMBER', 'COUNT', 'ATTRIBUTE', 'URL'].includes(channel)) return true;
  if (['UI_ROLE', 'VISIBLE', 'HIDDEN', 'FORBIDDEN_ROLE', 'CHECKED', 'ENABLED', 'DISABLED', 'EDITABLE', 'READ_ONLY', 'READONLY'].includes(channel)) return false;
  return authoredAssertionExpected(step) !== undefined;
}

function assertionExecutableContract(step) {
  if (!step || step.op !== 'assert' || step.authored === false) {
    return { executable: false, reason: 'not_an_authored_assertion' };
  }
  const channel = String(step.channel || 'UI_TEXT').trim().toUpperCase();
  if (channel === 'EVALUATE') return { executable: true, reason: null };

  const payload = step.payload && typeof step.payload === 'object' ? step.payload : {};
  const comparator = String(step.comparator || step.operator || payload.comparator || payload.operator || '').trim().toLowerCase();
  const attributeName = String(step.attributeName || payload.attributeName || payload.name || step.name || '').trim();
  const hasTarget = !!String(step.target || '').trim();
  const hasPageSignals = !!pageSignals(step);
  const hasExpectedRef = !!String(step.expectedRef || '').trim();
  const hasDataExpected = !!(
    step.dataExpected
    || step.dataRole
    || (step.dataBinding && (
      step.dataBinding.isDataBound === true
      || (Array.isArray(step.dataBinding.refs) && step.dataBinding.refs.length > 0)
    ))
  );
  const hasExpected = authoredAssertionExpected(step) !== undefined || hasExpectedRef || hasDataExpected;

  if (channel === 'PAGE') {
    return hasPageSignals || hasTarget
      ? { executable: true, reason: null }
      : { executable: false, reason: 'missing_page_signal_and_target' };
  }
  if (['UI_TEXT', 'FORBIDDEN_TEXT', 'URL'].includes(channel)) {
    return hasExpected
      ? { executable: true, reason: null }
      : { executable: false, reason: 'missing_expected_value' };
  }
  if (['UI_ROLE', 'VISIBLE', 'HIDDEN', 'FORBIDDEN_ROLE', 'CHECKED', 'ENABLED', 'DISABLED', 'EDITABLE', 'READ_ONLY', 'READONLY'].includes(channel)) {
    return hasTarget
      ? { executable: true, reason: null }
      : { executable: false, reason: 'missing_assertion_target' };
  }
  if (channel === 'ATTRIBUTE' && ['absent', 'missing', 'not_present'].includes(comparator)) {
    return hasTarget && attributeName
      ? { executable: true, reason: null }
      : { executable: false, reason: !hasTarget ? 'missing_assertion_target' : 'missing_attribute_name' };
  }
  if (['VALUE', 'SELECTED', 'NUMBER', 'COUNT', 'ATTRIBUTE'].includes(channel)) {
    if (!hasTarget) return { executable: false, reason: 'missing_assertion_target' };
    return hasExpected
      ? { executable: true, reason: null }
      : { executable: false, reason: 'missing_expected_value' };
  }
  return hasTarget || hasExpected || hasPageSignals
    ? { executable: true, reason: null }
    : { executable: false, reason: 'missing_expected_value_and_target' };
}

function collectNonExecutableAssertionDiagnostics(cases) {
  const diagnostics = [];
  for (const caseItem of cases || []) {
    for (const step of caseItem?.ir?.steps || []) {
      if (!step || step.op !== 'assert' || step.authored === false || step.channel === 'EVALUATE') continue;
      const eligibility = assertionExecutableContract(step);
      if (eligibility.executable) continue;
      diagnostics.push({
        caseId: caseItem?.ir?.caseId || caseItem?.testCaseId || null,
        caseName: caseItem?.caseName || caseItem?.ir?.title || null,
        assertionId: step.assertionId || null,
        contractRef: step.contractRef || step.contractStepId || null,
        channel: step.channel || null,
        executionStatus: step.executionStatus || null,
        liveOutcome: step.liveOutcome || step.outcome || null,
        reason: eligibility.reason,
        nonBlocking: true,
        runnableCodeEmitted: false,
      });
    }
  }
  return diagnostics;
}

function buildAssertionMethodBody(method) {
  const step = method.step || {};
  const channel = String(step.channel || 'UI_TEXT').trim().toUpperCase();
  const ms = timeout(step, 10000);
  const assertion = isFlowCriticalAssertion(step) ? 'expect' : 'expect.soft';
  const pollingAssertion = isFlowCriticalAssertion(step) ? 'expect' : 'expect.configure({ soft: true })';
  const target = method.locatorName
    ? thisAccessorCall(method.locatorName, method.locatorParameterized === true ? 'expected' : '')
    : null;
  const payload = step.payload && typeof step.payload === 'object' ? step.payload : {};
  const comparator = String(step.comparator || step.operator || payload.comparator || payload.operator || 'eq').trim().toLowerCase();
  const attributeName = String(step.attributeName || payload.attributeName || payload.name || step.name || '').trim();
  const expectedValueRequired = new Set([
    'URL',
    'UI_TEXT',
    'FORBIDDEN_TEXT',
    'VALUE',
    'SELECTED',
    'NUMBER',
    'ATTRIBUTE',
    'CHECKED',
  ]).has(channel);
  if (step.missingAuthoredExpected === true && expectedValueRequired) {
    const contractText = String(
      step.authoredContractText || step.description || step.instruction || `${channel} assertion`,
    ).trim();
    const message = `QAAI_ASSERTION_CONTRACT_UNRESOLVED: the authored expected value was unavailable. Contract: ${contractText}`;
    const targetVisibility = target
      ? `await expect.soft(${target}, ${q(message)}).toBeVisible({ timeout: ${ms} });\n`
      : '';
    return `${targetVisibility}await expect.soft(expected, ${q(message)}).toBeDefined();\nawait expect.soft(expected, ${q(message)}).not.toBe("");\nif (expected === undefined || expected === "") return;`;
  }
  if (step.missingAuthoredExpected === true && !target && !pageSignals(step)) {
    const message = `QAAI_ASSERTION_CONTRACT_UNRESOLVED: expected value and target evidence were unavailable. Contract: ${String(step.authoredContractText || step.description || step.instruction || `${channel} assertion`).trim()}`;
    return `throw new Error(${q(message)});`;
  }
  if (!target && channel === 'PAGE') {
    const source = emitPageSignalAssertion(step, ms);
    if (source) return source.trim().replace(/\bexpect\(/g, `${assertion}(`).replace(/\bpage\b/g, 'this.page');
  }
  if (!target && channel === 'URL') return `await ${assertion}(this.page).toHaveURL(new RegExp(String(expected)), { timeout: ${ms} });`;
  if (!target && channel === 'FORBIDDEN_TEXT') return `await ${assertion}(this.page.getByText(String(expected), { exact: false })).toBeHidden({ timeout: ${ms} });`;
  if (!target && channel === 'UI_TEXT') return `await ${assertion}(this.page.getByText(String(expected), { exact: false })).toBeVisible({ timeout: ${ms} });`;
  if (!target) {
    const message = `QAAI_ASSERTION_CONTRACT_UNRESOLVED: expected value and target evidence were unavailable. Contract: ${String(step.authoredContractText || step.description || step.instruction || `${channel} assertion`).trim()}`;
    return `throw new Error(${q(message)});`;
  }
  if (step.missingAuthoredExpected === true) return `await ${assertion}(${target}).toBeVisible({ timeout: ${ms} });`;
  if (channel === 'PAGE' || channel === 'UI_ROLE') return `await ${assertion}(${target}).toBeVisible({ timeout: ${ms} });`;
  if (channel === 'VISIBLE') return `await ${assertion}(${target}).toBeVisible({ timeout: ${ms} });`;
  if (channel === 'HIDDEN' || channel === 'FORBIDDEN_ROLE') return `await ${assertion}(${target}).toBeHidden({ timeout: ${ms} });`;
  if (channel === 'FORBIDDEN_TEXT') return `await ${assertion}(${target}).not.toContainText(String(expected), { timeout: ${ms} });`;
  if (channel === 'VALUE' || channel === 'SELECTED') return `await ${assertion}(${target}).toHaveValue(String(expected), { timeout: ${ms} });`;
  if (channel === 'NUMBER') return `await ${assertion}(${target}).toHaveText(String(expected), { timeout: ${ms} });`;
  if (channel === 'CHECKED') {
    const checked = step.expected !== false && String(step.expected).toLowerCase() !== 'false';
    return checked
      ? `await ${assertion}(${target}).toBeChecked({ timeout: ${ms} });`
      : `await ${assertion}(${target}).not.toBeChecked({ timeout: ${ms} });`;
  }
  if (channel === 'COUNT') {
    if (['gte', 'at_least', 'count_at_least', 'greater_than_or_equal'].includes(comparator)) return `await ${pollingAssertion}.poll(async () => ${target}.count(), { timeout: ${ms} }).toBeGreaterThanOrEqual(Number(expected));`;
    if (['lte', 'at_most', 'count_at_most', 'less_than_or_equal'].includes(comparator)) return `await ${pollingAssertion}.poll(async () => ${target}.count(), { timeout: ${ms} }).toBeLessThanOrEqual(Number(expected));`;
    return `await ${assertion}(${target}).toHaveCount(Number(expected), { timeout: ${ms} });`;
  }
  if (channel === 'ATTRIBUTE' && attributeName) {
    if (['absent', 'missing', 'not_present'].includes(comparator)) return `await ${pollingAssertion}.poll(async () => ${target}.getAttribute(${q(attributeName)}), { timeout: ${ms} }).toBeNull();`;
    return `await ${assertion}(${target}).toHaveAttribute(${q(attributeName)}, String(expected), { timeout: ${ms} });`;
  }
  if (channel === 'ENABLED') return `await ${assertion}(${target}).toBeEnabled({ timeout: ${ms} });`;
  if (channel === 'DISABLED') return `await ${assertion}(${target}).toBeDisabled({ timeout: ${ms} });`;
  if (channel === 'EDITABLE') return `await ${assertion}(${target}).toBeEditable({ timeout: ${ms} });`;
  if (channel === 'READ_ONLY' || channel === 'READONLY') return `await ${assertion}(${target}).not.toBeEditable({ timeout: ${ms} });`;
  if (channel === 'UI_TEXT' && method.locatorParameterized === true) {
    return `await ${assertion}(${target}).toBeVisible({ timeout: ${ms} });`;
  }
  return `await ${assertion}(${target}).toContainText(String(expected), { timeout: ${ms} });`;
}

/**
 * Emit pages/<Page>.ts
 * Class with:
 *   - locator accessor methods: usernameInput() → returns the locator (for assertions)
 *   - action methods: fillUsername(value) → fills (for acts in the spec)
 */
function emitPageFile(fileName, entries, methods, lang = 'ts', moduleFormat = 'esm', architectPage = null, methodNameMap = null, standardJsOutput = false, allowPageRebinding = false) {
  entries = Object.fromEntries(Object.entries(entries || {}).map(([name, entry]) => [publicIdentifierName(name, entry), entry]));
  const className = pageClassName(fileName);
  const constName = `${fileName}Locators`;
  const cjs = isCjs(lang, moduleFormat);
  const locatorsPath = `../locators/${fileName}.locators${importExt(lang, moduleFormat)}`;
  const hasLocators = Object.keys(entries).length > 0;
  // Page objects expose only locator-backed methods referenced by canonical act steps.
  // Business/domain abstractions must be authored in the canonical plan, never inferred
  // from page names, locator names, or a website-specific template.
  const hasAssertionMethods = !!(methods && [...methods.values()].some((method) => method && method.action === 'assert'));
  const hasArchitectFallbacks = false;
  const hasDragMethods = !!(methods && [...methods.values()].some((method) => method && method.action === 'drag'));
  const hasFallbackMethods = !!(methods && [...methods.values()].some((method) => method && !ACTION_VERB[method.action]));

  const lines = [];
  if (lang !== 'js') lines.push(`import { Page${hasDragMethods ? ', Locator' : ''}${hasAssertionMethods || hasFallbackMethods || hasArchitectFallbacks ? ', expect' : ''} } from '@playwright/test';`);
  else if (hasAssertionMethods || hasFallbackMethods || hasArchitectFallbacks) lines.push(cjs ? `const { expect } = require('@playwright/test');` : `import { expect } from '@playwright/test';`);
  const locatorImport = cjs
    ? `const { ${constName} } = require('${locatorsPath}');`
    : `import { ${constName} } from '${locatorsPath}';`;
  if (hasLocators) lines.push(locatorImport, ``);
  lines.push(`${cjs ? 'class' : 'export class'} ${className} {`);

  if (lang !== 'js') {
    for (const [name, entry] of Object.entries(entries)) {
      if (entry?.parameterized === true) continue;
      lines.push(`  private readonly ${locatorFieldName(name)}: ReturnType<typeof ${propertyRef(constName, name)}>;`);
    }
    if (Object.keys(entries).length) lines.push(``);
  }

  if (lang === 'js') {
    lines.push(`  constructor(page) {`);
    lines.push(`    this.page = page;`);
  } else {
    lines.push(`  constructor(private readonly page: Page) {`);
  }
  for (const [name, entry] of Object.entries(entries)) {
    if (entry?.parameterized === true) continue;
    lines.push(`    this.${locatorFieldName(name)} = ${propertyRef(constName, name)}(page);`);
  }
  lines.push(
    `  }`,
    ``,
    `  // ─── Locator accessors (for assertions and direct locator use) ────────────`,
  );

  if (standardJsOutput && lang === 'js' && allowPageRebinding) {
    lines.push(`  usePage(page) {`, `    this.page = page;`);
    for (const [name, entry] of Object.entries(entries)) {
      if (entry?.parameterized === true) continue;
      lines.push(`    this.${locatorFieldName(name)} = ${propertyRef(constName, name)}(page);`);
    }
    lines.push(`  }`, ``);
  }

  for (const [name, entry] of Object.entries(entries)) {
    if (entry?.parameterized === true) {
      const expectedParam = lang === 'js' ? 'expected' : 'expected: string | number | boolean';
      lines.push(`  ${methodDeclName(name)}(${expectedParam}) { return ${propertyRef(constName, name)}(this.page, expected); }`);
    } else {
      lines.push(`  ${methodDeclName(name)}() { return this.${locatorFieldName(name)}; }`);
    }
  }

  if (methods && methods.size) {
    lines.push(``, `  // ─── Action methods — 1:1 with recorded acts (G.5) ─────────────────────`);
    const seen = new Set();
    for (const [, method] of methods) {
      const canonicalLocatorEntry = method.locatorName ? entries[method.locatorName] : null;
      const renderMethod = canonicalLocatorEntry?.parameterized === true
        ? { ...method, locatorParameterized: true }
        : method;
      const { action, name: semName } = renderMethod;
      // Use the shared registry's unique name so distinct elements get distinct
      // methods (no silent drop); the seen-guard now only collapses a genuinely
      // identical (action,name) that maps to one shared method.
      const safeSemName = publicIdentifierName(semName);
      const mName = standardJsOutput
        ? resolvedMethodName(methodNameMap, action, safeSemName)
        : methodNameFor(action, safeSemName);
      if (seen.has(mName)) continue;
      seen.add(mName);
      const hasValue = ['fill', 'type', 'selectOption', 'press', 'upload'].includes(action);
      const hasExpected = action === 'assert' && assertionNeedsExpectedParameter(renderMethod.step);
      const clickOptions = ['click', 'doubleClick', 'tripleClick'].includes(action);
      const param = action === 'drag'
        ? (lang === 'js' ? 'target' : 'target: Locator')
        : clickOptions
          ? (lang === 'js'
            ? 'options = {}'
            : `options: { button?: 'left' | 'middle' | 'right'; modifiers?: Array<'Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift'> } = {}`)
          : (hasExpected
            ? (lang === 'js' ? 'expected' : 'expected: string | number | boolean')
            : (hasValue
            ? (lang === 'js' ? 'value' : `value: ${['selectOption', 'upload'].includes(action) ? 'string | string[]' : 'string'}`)
            : ''));
      const returnType = tsOnly(lang, ': Promise<void>');
      const body = action === 'assert'
        ? buildAssertionMethodBody(renderMethod)
        : buildMethodBody(action, safeSemName, constName, renderMethod);
      lines.push(`  async ${mName}(${param})${returnType} {`);
      for (const bodyLine of String(body).split('\n')) lines.push(`    ${bodyLine}`);
      lines.push(`  }`);
    }
  }

  lines.push(`}`);
  if (cjs) lines.push(`module.exports = { ${className} };`);
  return lines.join('\n') + '\n';
}

// ── Step-level emitters (POM-aware) ─────────────────────────────────────────

/**
 * For a resolve step:
 * - If the step.as has a POM mapping → skip (the act steps use page methods directly,
 *   and assertion steps use inline page accessor). Return null = no output.
 * - If no mapping (weak/conflict) → fall back to a clean static locator expression.
 *   Uses the best-strategy candidate from the recorded evidence (same selectStaticLocator
 *   path as the locator accessor in emitLocatorEntry) so the fallback is readable and
 *   consistent with the page-class accessors above it.
 */
function pomEmitResolve(step, asMap, caseMap) {
  if (pomInfoForRef(asMap, caseMap, step && step.as)) return null;
  const locator = step && (step.actionLocator || step.locatorRecipe);
  if (!replayLocatorContract.isVerifiedActionLocator(locator)) return null;
  return emitLocatorResolver(step.candidates, step);
}

// Interaction actions that cause the browser to navigate as a side-effect.
// A navigate step immediately following one of these is a consequence of the
// browser redirect, NOT a programmatic goto — emitting page.goto() would reset
// the page to a stale URL, discarding the post-interaction state.
const INTERACTION_ACTIONS = new Set(['click', 'doubleClick', 'tripleClick', 'fill', 'selectOption', 'check', 'uncheck', 'press', 'hover', 'drag', 'upload']);

// Extract the path+search+hash from an absolute URL so generated specs use
// relative paths. playwright.config.ts sets baseURL from QAAI_TARGET_URL, so
// page.goto('/products') resolves correctly against any environment — staging,
// local, prod — without editing every goto call individually. Falls back to
// the raw value if URL parsing fails (e.g. already-relative or malformed).
function relativeUrl(url) {
  return String(url || '');
}

function stableObservedPath(url) {
  try {
    const parsed = new URL(String(url || ''), 'https://qaai.invalid');
    return parsed.pathname || '/';
  } catch {
    return String(url || '').replace(/[?#].*$/, '') || '/';
  }
}

function stableObservedLocation(url) {
  try {
    const parsed = new URL(String(url || ''), 'https://qaai.invalid');
    return `${parsed.pathname || '/'}${parsed.search}${parsed.hash}`;
  } catch {
    return String(url || '') || '/';
  }
}

function isObservedNavigation(step) {
  const source = String(
    step && (step.navigationKind || step.navigationSource || step.transitionSource
      || step.provenance?.kind || step.metadata?.navigationKind) || ''
  ).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return !!(step && (step.contextSwitchInferred || step.observedOnly || step.authored === false))
    || ['observed_redirect', 'browser_redirect', 'runtime_observation', 'popup_destination', 'inferred_transition'].includes(source);
}

function isPopupObservedNavigation(step) {
  const sources = [step, step && step.metadata, step && step.provenance, step && step.navigation]
    .filter((value) => value && typeof value === 'object');
  return sources.some((value) => value.popupIdentity
    || value.popup === true
    || value.newTab === true
    || ['popup', 'popup_context', 'popup_destination', 'new_tab', 'newtab']
      .includes(String(value.navigationKind || value.transitionKind || value.kind || '').toLowerCase()));
}

// A popup is an authored event contract, not a website-specific action name.
// Older traces used `opensPopup`; current traces carry eventContract/context
// metadata. Normalize both forms here so the generated JavaScript pre-arms the
// popup listener before the action without inventing another interaction.
function popupActionContract(step) {
  if (!step || typeof step !== 'object') return null;
  const contracts = [
    step.eventContract,
    step.browserEventEvidence,
    step.browserEvent,
    step.contextTransition,
    step.popupIdentity,
    step.navigation,
    step.metadata,
  ].filter((value) => value && typeof value === 'object');
  const isPopupKind = (value) => [value.kind, value.eventKind, value.transitionKind, value.navigationKind]
    .some((kind) => ['popup', 'popup_context', 'popup_destination', 'new_tab', 'newtab']
      .includes(String(kind || '').trim().toLowerCase().replace(/[\s-]+/g, '_')));
  const eventContract = contracts.find(isPopupKind) || null;
  if (step.opensPopup !== true && step.popup !== true && !eventContract) return null;
  const expected = eventContract?.expected && typeof eventContract.expected === 'object'
    ? eventContract.expected
    : {};
  const selectedEvent = eventContract?.selectedEvent && typeof eventContract.selectedEvent === 'object'
    ? eventContract.selectedEvent
    : {};
  const alias = String(
    step.popupIdentity?.pageAlias
    || eventContract?.pageAlias
    || step.contextTransition?.to
    || 'popupPage',
  ).trim();
  return {
    timeoutMs: timeout(eventContract || step, timeout(step, 10000)),
    expectedLocation: String(
      step.popupExpectedUrl
      || step.pageUrlAfter
      || selectedEvent.url
      || expected.urlPattern
      || expected.url
      || expected.href
      || '',
    ),
    pageVar: isIdentifierName(alias) ? alias : 'popupPage',
  };
}

function nonAuthoredActionEvidence(step) {
  const action = String(step && step.action || 'runtime operation');
  const identity = step && (step.contractStepId || step.sourceContractStepId) || 'unmatched runtime operation';
  const detail = `Observed ${action} evidence (${identity}) was not replayed because it had no exact authored contract identity and operation match.`;
  return `      test.info().annotations.push({ type: 'qaai-runtime-evidence', description: ${q(detail)} });`;
}

function standardJsOutputFor(asMap) {
  return !!(asMap && asMap.__standardJsOutput);
}

function actionPromiseExpression(line) {
  const source = String(line || '').trim();
  const match = source.match(/^await\s+([\s\S]+);$/);
  return match ? match[1] : null;
}

function wrapPopupAction(step, line, asMap) {
  const contract = popupActionContract(step);
  if (!contract || !standardJsOutputFor(asMap)) return line;
  const promise = actionPromiseExpression(line);
  if (!promise) return line;
  const ms = contract.timeoutMs;
  const expectedLocation = contract.expectedLocation;
  const popupPageVar = contract.pageVar;
  const pageVars = Array.isArray(asMap.__pageVars) ? asMap.__pageVars : [];
  const lines = [
    '      {',
    `        const [${popupPageVar}] = await Promise.all([`,
    `          page.waitForEvent('popup', { timeout: ${ms} }),`,
    `          ${promise},`,
    '        ]);',
    `        page = ${popupPageVar};`,
    `        await ${popupPageVar}.waitForLoadState('domcontentloaded', { timeout: ${ms} });`,
  ];
  if (expectedLocation && expectedLocation !== '/') {
    lines.push(`        await ${popupPageVar}.waitForURL(new RegExp(${q(`${escapeRegex(expectedLocation)}$`)}), { timeout: ${ms} });`);
  }
  for (const pageVar of pageVars) lines.push(`        ${pageVar}.usePage(${popupPageVar});`);
  lines.push('      }');
  return lines.join('\n');
}

function browserEventContract(step, requestedKind) {
  if (!step || typeof step !== 'object') return null;
  const sources = [
    step.browserEventEvidence,
    step.browserEvent,
    step.eventContract,
    step.dialogEvidence,
  ].filter((value) => value && typeof value === 'object');
  const normalizeKind = (value) => String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const contract = sources.find((value) => [
    value.eventKind,
    value.kind,
    value.type,
  ].some((kind) => normalizeKind(kind) === requestedKind)) || null;
  if (!contract) return null;
  return {
    contract,
    selectedEvent: contract.selectedEvent && typeof contract.selectedEvent === 'object'
      ? contract.selectedEvent
      : {},
    expected: contract.expected && typeof contract.expected === 'object'
      ? contract.expected
      : {},
    timeoutMs: timeout(contract.timing || contract, timeout(step, 10000)),
  };
}

function wrapDownloadAction(step, line, asMap) {
  const event = browserEventContract(step, 'download');
  if (!event || !standardJsOutputFor(asMap)) return line;
  const promise = actionPromiseExpression(line);
  if (!promise) return line;
  const filenamePattern = event.expected.filenamePattern
    || event.expected.filename
    || event.selectedEvent.suggestedFilename
    || null;
  const lines = [
    '      {',
    '        const [_qaaiDownload] = await Promise.all([',
    `          page.waitForEvent('download', { timeout: ${event.timeoutMs} }),`,
    `          ${promise},`,
    '        ]);',
  ];
  if (filenamePattern) {
    lines.push(`        expect(_qaaiDownload.suggestedFilename()).toMatch(new RegExp(${q(filenamePattern)}));`);
  }
  lines.push('        await _qaaiDownload.path();', '      }');
  return lines.join('\n');
}

function wrapDialogAction(step, line, asMap) {
  const event = browserEventContract(step, 'dialog');
  if (!event || !standardJsOutputFor(asMap)) return line;
  const promise = actionPromiseExpression(line);
  if (!promise) return line;
  const expectedType = step.dialogType || event.expected.dialogType || event.selectedEvent.dialogType || null;
  const expectedMessage = step.expectedMessage || event.expected.messagePattern
    || event.expected.message || event.selectedEvent.message || null;
  const accept = step.accept !== false;
  const lines = [
    '      {',
    `        const _qaaiDialogPromise = page.waitForEvent('dialog', { timeout: ${event.timeoutMs} });`,
    `        const _qaaiActionPromise = ${promise};`,
    '        const _qaaiDialog = await _qaaiDialogPromise;',
  ];
  if (expectedType) lines.push(`        expect(_qaaiDialog.type()).toBe(${q(expectedType)});`);
  if (expectedMessage) lines.push(`        expect(_qaaiDialog.message()).toMatch(new RegExp(${q(expectedMessage)}));`);
  lines.push(accept
    ? `        await _qaaiDialog.accept(${step.promptText != null ? q(step.promptText) : ''});`
    : '        await _qaaiDialog.dismiss();');
  lines.push('        await _qaaiActionPromise;', '      }');
  return lines.join('\n');
}

function wrapNavigationEventAction(step, line, asMap) {
  const event = browserEventContract(step, 'navigation');
  if (!event || !standardJsOutputFor(asMap)) return line;
  const promise = actionPromiseExpression(line);
  if (!promise) return line;
  const destination = step.observedConsequenceUrl
    || event.selectedEvent.url
    || event.expected.urlPattern
    || event.expected.url
    || null;
  if (!destination) return line;
  return [
    '      {',
    '        await Promise.all([',
    `          page.waitForURL(new RegExp(${q(`${escapeRegex(String(destination))}$`)}), { timeout: ${event.timeoutMs} }),`,
    `          ${promise},`,
    '        ]);',
    '      }',
  ].join('\n');
}

function wrapBrowserEventAction(step, line, asMap) {
  if (!standardJsOutputFor(asMap)) return line;
  if (popupActionContract(step)) return wrapPopupAction(step, line, asMap);
  if (browserEventContract(step, 'download')) return wrapDownloadAction(step, line, asMap);
  if (browserEventContract(step, 'dialog')) return wrapDialogAction(step, line, asMap);
  if (browserEventContract(step, 'navigation')) return wrapNavigationEventAction(step, line, asMap);
  return line;
}

function wrapOptionalAction(step, locatorExpression, line, asMap) {
  if (!pomActionIsOptional(step) || !locatorExpression || !standardJsOutputFor(asMap)) return line;
  const ms = timeout(step, 2000);
  const bodyLines = String(line || '').split('\n');
  const indents = bodyLines.filter((part) => part.trim()).map((part) => (part.match(/^\s*/) || [''])[0].length);
  const minimumIndent = indents.length ? Math.min(...indents) : 0;
  const body = bodyLines.map((part) => `${' '.repeat(10)}${part.slice(minimumIndent)}`).join('\n');
  return [
    '      {',
    `        const appeared = await ${locatorExpression}.waitFor({ state: 'visible', timeout: ${ms} }).then(() => true).catch(() => false);`,
    `        if (appeared) {`,
    body,
    '        }',
    '      }',
  ].join('\n');
}

function locatorExpressionFromRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object') return null;
  if (recipe.expression) return recipe.expression;
  if (recipe.primary) return recipe.primary;
  if (recipe.frameworkExpressions && recipe.frameworkExpressions.playwright) return recipe.frameworkExpressions.playwright;
  const primary = actionLocatorResolver.primaryActionLocator(recipe);
  return primary && (primary.frameworkExpressions?.playwright || primary.expression || primary.primary) || null;
}

function playwrightPomClickOptions(step, clickCount = null) {
  const aliases = {
    alt: 'Alt', control: 'Control', ctrl: 'Control', controlormeta: 'ControlOrMeta',
    meta: 'Meta', command: 'Meta', cmd: 'Meta', shift: 'Shift',
  };
  const options = {};
  const button = String(step && step.button || '').toLowerCase();
  if (['left', 'middle', 'right'].includes(button)) options.button = button;
  const modifiers = Array.from(new Set((Array.isArray(step && step.modifiers) ? step.modifiers : [])
    .map((value) => aliases[String(value || '').replace(/[^a-z]/gi, '').toLowerCase()] || null)
    .filter(Boolean)));
  if (modifiers.length) options.modifiers = modifiers;
  const count = clickCount == null ? null : Number(clickCount);
  if (Number.isFinite(count) && count > 0) options.clickCount = Math.floor(count);
  return JSON.stringify(options);
}

function generateActionString(irStep, rowVar = 'row', hasDataLoop = false, dataHints = null) {
  const locator = irStep && (irStep.locatorRecipe || irStep.actionLocator);
  if (!replayLocatorContract.isVerifiedActionLocator(locator)) return null;
  const locatorStr = locatorExpressionFromRecipe(locator);
  if (!locatorStr) return null;
  const action = String(irStep.action || '');
  if (!action) return null;
  if (!ACTION_VERB[action]) return null;
  if (action === 'drag') {
    if (!irStep.destinationTarget) return null;
    const destination = toSafeDataKey(irStep.destinationTarget || 'destination');
    return `      await ${locatorStr}.dragTo(${destination});`;
  }
  const clickOptions = playwrightPomClickOptions(irStep);
  if (action === 'click') return `      await ${locatorStr}.click(${clickOptions});`;
  if (action === 'doubleClick') return `      await ${locatorStr}.dblclick(${clickOptions});`;
  if (action === 'tripleClick') return `      await ${locatorStr}.click(${playwrightPomClickOptions(irStep, 3)});`;
  const boundRole = hasDataLoop ? boundDataRoleForStep(irStep) : null;
  const columnKey = exportedDataKey(dataHints, boundRole);
  if (columnKey) {
    const method = action === 'upload' ? 'setInputFiles' : (action === 'type' ? 'pressSequentially' : action);
    return `      await ${locatorStr}.${method}(readData(${rowVar}, ${dataKey(columnKey)}));`;
  }
  const hasValue = ['fill', 'type', 'selectOption', 'press', 'upload'].includes(action);
  const method = action === 'upload' ? 'setInputFiles' : (action === 'type' ? 'pressSequentially' : action);
  if (!hasValue) return `      await ${locatorStr}.${method}();`;
  return `      await ${locatorStr}.${method}(${actionValueExpression(irStep, hasDataLoop, null, dataHints)});`;
}

/**
 * For an act step:
 * - Navigate/back/forward: always inline (no locator target).
 * - If step.target is in asMap → emit page method call directly.
 * - Else → fall back to inline via emitStep (the inline resolver variable was emitted above).
 *
 * prevActAction: the action string of the most recent non-navigation act step, used
 * to detect consequence navigates (browser-redirected) vs programmatic ones (goto).
 */
function pomEmitAct(step, asMap, hasDataLoop, prevActAction, caseMap, dataHints, replayIR = null) {
  const action = String(step.action || '');
  const standardJsOutput = standardJsOutputFor(asMap);
  if (standardJsOutput && assertionLikeAct(step)) {
    return pomEmitAssert(recoveredAssertionStep(step), asMap, null, hasDataLoop, caseMap, dataHints);
  }
  if (step && step.authored === false && action !== 'navigate') {
    return standardJsOutput ? null : nonAuthoredActionEvidence(step);
  }
  if (standardJsOutput && PAGE_LEVEL_ACTIONS.has(action)
      && !(action === 'navigate' && isObservedNavigation(step))) {
    const info = asMap.__operationMap && asMap.__operationMap.get(step);
    if (!info) throw new Error(`Playwright POM JavaScript invariant: ${action} has no page-level method mapping.`);
    const perFileNames = asMap.__methodNames && asMap.__methodNames.get(info.file);
    const methodName = resolvedMethodName(perFileNames, action, info.name);
    return `      await ${info.pageVar}.${methodName}();`;
  }
  if (action === 'navigate') {
    if (isObservedNavigation(step)) {
      const expectedPath = stableObservedPath(step.url || '');
      const popup = isPopupObservedNavigation(step);
      if (standardJsOutput) {
        if (popup) {
          return `      await page.waitForURL(${q(`**${expectedPath}`)}, { timeout: ${timeout(step, 10000)} });`;
        }
        return `      await page.waitForURL(${q(`**${expectedPath}`)}, { timeout: ${timeout(step, 10000)} });`;
      }
      const detail = popup
        ? 'Observed popup/new-tab context switch retained as non-authored evidence; QAAI waits for the observed destination and does not invent a second navigation.'
        : 'Observed browser transition retained as evidence; no direct navigation was invented because this transition was not authored.';
      return `      test.info().annotations.push({ type: ${q(popup ? 'qaai-observed-popup' : 'qaai-observed-navigation')}, description: ${q(detail)} });\n      await page.waitForURL(new RegExp(${q(escapeRegex(expectedPath))}), { timeout: ${timeout(step, 10000)} }).catch(() => {});`;
    }
    // Consequence navigate: follows a user interaction → browser already navigated; suppress.
    if (prevActAction && INTERACTION_ACTIONS.has(prevActAction)) {
      const expectedPath = stableObservedPath(step.url || '');
      return `      await page.waitForURL(new RegExp(${q(escapeRegex(expectedPath))}), { timeout: ${timeout(step, 10000)} });`;
    }
    // Emit relative path so playwright.config.ts baseURL (QAAI_TARGET_URL) handles portability.
    const navUrl = relativeUrl(step.url || '');
    if (step.redirectExpected) {
      return `      await page.goto(${q(navUrl)}, { waitUntil: 'commit' }).catch((e) => { if (!String(e && e.message).includes('ERR_ABORTED')) throw e; });`;
    }
    return `      await page.goto(${q(navUrl)}, { waitUntil: 'domcontentloaded' });`;
  }
  if (action === 'navigateBack' || action === 'navigateForward' || action === 'reload') {
    const navigation = step.navigation && typeof step.navigation === 'object' ? step.navigation : {};
    const waitUntil = ['commit', 'domcontentloaded', 'load', 'networkidle'].includes(
      String(navigation.waitUntil || step.waitUntil || '').toLowerCase(),
    ) ? String(navigation.waitUntil || step.waitUntil).toLowerCase() : 'domcontentloaded';
    const navigationTimeout = timeout(navigation, timeout(step, 20000));
    const methodName = action === 'navigateBack' ? 'goBack' : action === 'navigateForward' ? 'goForward' : 'reload';
    return `      await page.${methodName}({ waitUntil: ${q(waitUntil)}, timeout: ${navigationTimeout} });`;
  }
  if (action === 'handleDialog') return emitDialogAcknowledgement(step, replayIR);
  if (action === 'resize' || action === 'close') return emitStep(step, replayIR);
  if (!ACTION_VERB[action]) return emitStep(step, replayIR);

  const info = step.target && pomInfoForRef(asMap, caseMap, step.target);
  if (!info) {
    const direct = generateActionString(step, 'row', hasDataLoop, dataHints);
    if (!direct && INTERACTION_ACTIONS.has(action)) return null;
    const emitted = direct || emitStep(step, replayIR);
    const locator = direct
      ? locatorExpressionFromRecipe(step && (step.locatorRecipe || step.actionLocator))
      : null;
    return wrapOptionalAction(step, locator, wrapBrowserEventAction(step, emitted, asMap), asMap);
  }

  const value = actionValueExpression(step, hasDataLoop, null, dataHints);
  // Read the SAME resolved name the page object defined (shared registry on asMap),
  // so the call site can never reference an undeclared / wrong-element method.
  const perFileNames = asMap && asMap.__methodNames && asMap.__methodNames.get(info.file);
  const mName = resolvedMethodName(perFileNames, action, info.name);
  if (action === 'drag') {
    const destinationInfo = step.destinationTarget && pomInfoForRef(asMap, caseMap, step.destinationTarget);
    const destinationExpr = destinationInfo
      ? pageAccessorCall(destinationInfo.pageVar, destinationInfo.name)
      : toSafeDataKey(step.destinationTarget || 'destination');
    const line = `      await ${info.pageVar}.${mName}(${destinationExpr});`;
    return wrapBrowserEventAction(step, line, asMap);
  }
  if (['click', 'doubleClick', 'tripleClick'].includes(action)) {
    const clickCount = action === 'tripleClick' ? 3 : null;
    const options = playwrightPomClickOptions(step, clickCount);
    const args = standardJsOutput && options === '{}' ? '' : options;
    const line = `      await ${info.pageVar}.${mName}(${args});`;
    const eventWrapped = wrapBrowserEventAction(step, line, asMap);
    return wrapOptionalAction(
      step,
      pageAccessorCall(info.pageVar, info.name),
      eventWrapped,
      asMap,
    );
  }
  const hasValue = ['fill', 'type', 'selectOption', 'press', 'upload'].includes(action);
  const line = `      await ${info.pageVar}.${mName}(${hasValue ? value : ''});`;
  const eventWrapped = wrapBrowserEventAction(step, line, asMap);
  return (popupActionContract(step)
      || browserEventContract(step, 'download')
      || browserEventContract(step, 'dialog')
      || browserEventContract(step, 'navigation'))
    ? wrapOptionalAction(step, pageAccessorCall(info.pageVar, info.name), eventWrapped, asMap)
    : eventWrapped;
}

// ── EVALUATE method generation (Q4) ──────────────────────────────────────────
// POM specs must have zero inline evaluateSettled/page.evaluate calls. EVALUATE
// assertions are generated as methods on a dedicated EvaluateMethods page class;
// the spec body calls evaluateMethods.evaluateStep_N() only.

function _evalMethodPrefix(cases, opts = {}) {
  const seed = opts.scenarioId
    || opts.scenarioName
    || (cases && cases[0] && cases[0].caseName)
    || (cases && cases[0] && cases[0].ir && (cases[0].ir.title || cases[0].ir.caseId))
    || 'journey';
  return toSafeDataKey(seed).slice(0, 48) || 'journey';
}

function _buildEvalMap(cases, opts = {}) {
  const map = new WeakMap(); // step object → methodName
  const entries = [];
  let idx = 0;
  const prefix = _evalMethodPrefix(cases, opts);
  for (const { ir } of cases) {
    for (const step of (ir && ir.steps) || []) {
      if (step.op === 'assert' && step.channel === 'EVALUATE' && !step.target && step.script) {
        const methodName = `evaluateStep_${prefix}_${idx}`;
        map.set(step, methodName);
        entries.push({ step, methodName });
        idx++;
      }
    }
  }
  return { map, entries };
}

function _emitEvalMethodBody(step, methodName, lang = 'ts') {
  const normalizedScript = String(step.script)
    .replace(/\.textContent\?\.includes\s*\(/g, '.textContent?.toLowerCase().includes(')
    .replace(/\.textContent\.includes\s*\(/g, '.textContent.toLowerCase().includes(');
  const expectedStr = step.expected != null ? q(String(step.expected)) : 'null';
  const expectsTrue = step.expected === 'true' || step.expected === true;
  const ms = timeout(step, 10000);
  const flowCritical = isFlowCriticalAssertion(step);
  const failurePrefix = q(`QAAI_ASSERTION_FAILED: EVALUATE expected "${String(step.expected == null ? 'a successful result' : step.expected)}".`);
  const catchAsSoftFailure = (expression) => flowCritical
    ? expression
    : `${expression}.catch((_qaaiAssertionError) => {\n      expect.soft(_qaaiAssertionError, ${failurePrefix} + ' ' + String(_qaaiAssertionError && _qaaiAssertionError.message || _qaaiAssertionError)).toBeUndefined();\n    })`;

  const retType = tsOnly(lang, ': Promise<void>');
  if (expectsTrue) {
    const _textContentMatch = normalizedScript.match(/\.toLowerCase\(\)\.includes\(\s*['"]([^'"]+)['"]\s*\)/);
    const _compareText = _textContentMatch ? _textContentMatch[1] : null;
    const _isNegated = /^!(?!!)/.test(normalizedScript.trim()) || /\breturn\s+!(?!!)/.test(normalizedScript);
    if (_compareText && !_isNegated) {
      return `  async ${methodName}()${retType} {\n    await ${catchAsSoftFailure(`assertTextPresent(this.page, ${q(_compareText)}, '', ${ms})`)};\n  }`;
    }
    return `  async ${methodName}()${retType} {\n    await ${catchAsSoftFailure(`this.page.waitForFunction(${evaluateArg(normalizedScript)}, null, { timeout: ${ms} })`)};\n  }`;
  }

  const expectFn = flowCritical ? 'expect' : 'expect.soft';
  const expectLine = expectedStr !== 'null'
    ? `    ${expectFn}(_result, ${q(`EVALUATE: expected "${step.expected}"`)}).toContain(${expectedStr});`
    : `    ${expectFn}(_result, 'EVALUATE: must not error').not.toMatch(/^EVALUATE_ERROR:/);`;
  return `  async ${methodName}()${retType} {\n    const _result = String(await evaluateSettled(this.page, ${evaluateArg(normalizedScript)}).catch((e) => \`EVALUATE_ERROR:\${e.message}\`));\n${expectLine}\n  }`;
}

function _emitEvaluateMethodsFile(entries, lang = 'ts', moduleFormat = 'esm') {
  if (!entries.length) return null;
  const cjs = isCjs(lang, moduleFormat);
  const needsAssertText = entries.some(({ step }) => {
    if (step.expected !== 'true' && step.expected !== true) return false;
    const ns = String(step.script)
      .replace(/\.textContent\?\.includes\s*\(/g, '.textContent?.toLowerCase().includes(')
      .replace(/\.textContent\.includes\s*\(/g, '.textContent.toLowerCase().includes(');
    const m = ns.match(/\.toLowerCase\(\)\.includes\(\s*['"]([^'"]+)['"]\s*\)/);
    const isNeg = /^!(?!!)/.test(ns.trim()) || /\breturn\s+!(?!!)/.test(ns);
    return m && !isNeg;
  });
  const needsEvalSettled = entries.some(({ step }) => step.expected !== 'true' && step.expected !== true);
  const helperImportParts = [
    needsAssertText && 'assertTextPresent',
    needsEvalSettled && 'evaluateSettled',
  ].filter(Boolean).join(', ');
  const helperImport = helperImportParts
    ? (cjs
      ? `const { ${helperImportParts} } = require('../tests/support/replayir');\n`
      : `import { ${helperImportParts} } from '../tests/support/replayir${importExt(lang, moduleFormat)}';\n`)
    : '';
  const methods = entries.map(({ step, methodName }) => _emitEvalMethodBody(step, methodName, lang)).join('\n\n');
  const pageImport = lang === 'js' ? '' : `import { type Page } from '@playwright/test';\n`;
  const expectImport = cjs
    ? `const { expect } = require('@playwright/test');\n`
    : `import { expect } from '@playwright/test';\n`;
  const ctor = lang === 'js'
    ? `  constructor(page) { this.page = page; }`
    : `  constructor(private readonly page: Page) {}`;
  const classLine = `${cjs ? 'class' : 'export class'} EvaluateMethods`;
  const exportLine = cjs ? `\nmodule.exports = { EvaluateMethods };\n` : '\n';
  return `${pageImport}${expectImport}${helperImport}\n${classLine} {\n${ctor}\n\n${methods}\n}${exportLine}`;
}

function escapeRegex(value) {
  return String(value == null ? '' : value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function firstSignal(value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstSignal(item);
      if (found != null) return found;
    }
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const s = String(value).trim();
    return s ? s : null;
  }
  if (typeof value === 'object') return value;
  return null;
}

function pageSignals(step) {
  const payload = step && step.payload && typeof step.payload === 'object' ? step.payload : {};
  return (step && step.expectedSignals && typeof step.expectedSignals === 'object' && step.expectedSignals)
    || (payload.expectedSignals && typeof payload.expectedSignals === 'object' && payload.expectedSignals)
    || (step && step.signals && typeof step.signals === 'object' && step.signals)
    || (payload.signals && typeof payload.signals === 'object' && payload.signals)
    || null;
}

function emitPageSignalAssertion(step, ms) {
  const payload = step && step.payload && typeof step.payload === 'object' ? step.payload : {};
  const primary = (step && step.primaryIndicator && typeof step.primaryIndicator === 'object' && step.primaryIndicator)
    || (payload.primaryIndicator && typeof payload.primaryIndicator === 'object' && payload.primaryIndicator)
    || null;
  const signals = pageSignals(step) || {};
  const candidates = [];
  if (primary) candidates.push(primary);
  candidates.push(
    { role: firstSignal(signals.heading) ? 'heading' : null, name: firstSignal(signals.heading) },
    { role: firstSignal(signals.title) ? 'heading' : null, name: firstSignal(signals.title) },
    firstSignal(signals.role),
    { url: firstSignal(signals.url) },
    { text: firstSignal(signals.text) },
  );

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === 'string') {
      return `      await expect(page.getByText(${q(candidate)}, { exact: false })).toBeVisible({ timeout: ${ms} });`;
    }
    if (candidate.url) {
      return `      await expect(page).toHaveURL(new RegExp(${q(String(candidate.url))}), { timeout: ${ms} });`;
    }
    const role = candidate.role || candidate.expectedRole;
    const name = candidate.name || candidate.expectedName || candidate.text || candidate.label;
    if (role && name) {
      return `      await expect(page.getByRole(${q(role)}, { name: new RegExp(${q(escapeRegex(name))}, 'i') })).toBeVisible({ timeout: ${ms} });`;
    }
    const heading = candidate.heading || candidate.title;
    if (heading) {
      return `      await expect(page.getByRole('heading', { name: new RegExp(${q(escapeRegex(heading))}, 'i') })).toBeVisible({ timeout: ${ms} });`;
    }
    if (candidate.text) {
      return `      await expect(page.getByText(${q(candidate.text)}, { exact: false })).toBeVisible({ timeout: ${ms} });`;
    }
  }
  return null;
}

function pomReadDataExpr(role, hasDataLoop, type = 'string', fallback = null, dataHints = null) {
  const rowKey = hasDataLoop ? exportedDataKey(dataHints, role) : null;
  if (rowKey) return `readData(row, ${dataKey(rowKey)}, { type: ${q(type)} })`;
  if (fallback != null) return q(fallback);
  return type === 'number' ? '0' : "''";
}

function sanitizeRuntimeSelector(selector) {
  const parts = String(selector || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/\[ref\s*=|^ref\s*=|^e\d+$/i.test(part));
  return parts.join(', ');
}

function assertionPageVar(caseMap) {
  const values = caseMap && typeof caseMap.values === 'function' ? [...caseMap.values()] : [];
  const preferred = values.find((info) => info && info.pageVar);
  return preferred && preferred.pageVar || null;
}

function authoredAssertionExpected(step) {
  if (!step || typeof step !== 'object') return undefined;
  const payload = step.payload && typeof step.payload === 'object' ? step.payload : {};
  const expectedSignals = step.expectedSignals && typeof step.expectedSignals === 'object'
    ? step.expectedSignals
    : {};
  const assertion = step.assertion && typeof step.assertion === 'object' ? step.assertion : {};
  const candidates = [
    expectedSignals.text,
    expectedSignals.value,
    expectedSignals.count,
    expectedSignals.checked,
    expectedSignals.url,
    expectedSignals.attributeValue,
    expectedSignals.heading,
    expectedSignals.title,
    expectedSignals.role && typeof expectedSignals.role === 'object'
      ? (expectedSignals.role.name || expectedSignals.role.expectedName || expectedSignals.role.text)
      : undefined,
    step.expected,
    step.expectedValue,
    step.expectedText,
    step.expectedCount,
    step.expectedChecked,
    step.expectedUrl,
    step.expectedAttributeValue,
    payload.expected,
    payload.expectedValue,
    payload.expectedText,
    payload.expectedCount,
    payload.expectedChecked,
    payload.expectedUrl,
    payload.expectedAttributeValue,
    assertion.expected,
    assertion.expectedValue,
    assertion.expectedText,
  ];
  for (const candidate of candidates) {
    const values = Array.isArray(candidate) ? candidate : [candidate];
    const value = values.find((entry) =>
      entry !== undefined
      && entry !== null
      && !(typeof entry === 'string' && entry.trim() === '')
    );
    if (value !== undefined) return value;
  }
  return undefined;
}

function expectedExpression(step, hasDataLoop, dataHints) {
  const requestedRole = hasDataLoop
    ? (boundDataRoleForStep(step) || (step && (step.dataExpected || explicitDataRoleForStep(step))))
    : null;
  const rowKey = exportedDataKey(dataHints, requestedRole);
  if (rowKey) return `readData(row, ${dataKey(rowKey)})`;
  return ((step && step.expectedRef && step.channel !== 'URL')
    ? `readEnv(${q(envKeyFromRef(step.expectedRef, 'QAAI_EXPECTED'))})`
    : q(authoredAssertionExpected(step)));
}

function emitPomScopedAssertion(step, hasDataLoop, ms, dataHints, pageVar = null) {
  if (!step || step.target || !step.scope?.selector) return null;
  if (step.channel !== 'UI_TEXT' && step.channel !== 'PAGE') return null;
  const selector = sanitizeRuntimeSelector(step.scope.selector);
  if (!selector) return null;
  const expected = expectedExpression(step, hasDataLoop, dataHints);
  return `      await assertScopedText(page, ${q(selector)}, ${expected}, ${ms});`;
}

function indentStandardAssertion(source, spaces = 8) {
  const prefix = ' '.repeat(spaces);
  return String(source || '').trim().split('\n')
    .map((line) => `${prefix}${line.trimStart()}`)
    .join('\n');
}

function softenStandardJsAssertion(step, source) {
  if (!source || isFlowCriticalAssertion(step) || /\bexpect\.soft\s*\(/.test(source)) return source;
  if (/\bexpect\s*\(/.test(source)) return source.replace(/\bexpect\s*\(/g, 'expect.soft(');
  const channel = String(step && step.channel || 'assertion');
  const expected = String(step && step.expected != null ? step.expected : '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const message = `${channel}${expected ? ` expected "${expected}"` : ''} did not match; later independent steps will continue.`;
  return `      await (async () => {\n${indentStandardAssertion(source, 8)}\n      })().catch((_assertionError) => {\n        expect.soft(_assertionError, ${q(message)} + ' ' + String(_assertionError && _assertionError.message || _assertionError)).toBeUndefined();\n      });`;
}

/**
 * For an assert step with a target that's in asMap:
 * Use the page object's locator accessor (e.g. loginPage.usernameInput()) instead of el1.
 * For all other cases (no target, or target not in asMap, or channel-level asserts),
 * delegate to the standard emitAssertion.
 */
function pomEmitAssert(step, asMap, evalMap, hasDataLoop, caseMap, dataHints) {
  const ms = timeout(step, 10000);
  const standardJsOutput = standardJsOutputFor(asMap);
  if (standardJsOutput && !assertionExecutableContract(step).executable) return null;
  if (standardJsOutput && step && step.channel !== 'EVALUATE') {
    const info = asMap.__assertionMap && asMap.__assertionMap.get(step);
    if (!info) throw new Error(`Playwright POM JavaScript invariant: authored assertion has no centralized page-object method mapping.`);
    const perFileNames = asMap.__methodNames && asMap.__methodNames.get(info.file);
    const methodName = resolvedMethodName(perFileNames, 'assert', info.name);
    const selectedMethod = asMap.__pagesMethods
      && asMap.__pagesMethods.get(info.file)
      && asMap.__pagesMethods.get(info.file).get(`assert:${info.name}`);
    const methodStep = selectedMethod && selectedMethod.step || step;
    const invocationStep = {
      ...step,
      ...methodStep,
      expectedSignals: methodStep.expectedSignals || step.expectedSignals,
      expected: authoredAssertionExpected(methodStep) ?? authoredAssertionExpected(step),
      dataRole: methodStep.dataRole || step.dataRole || stripRoleSuffix(info.name) || info.name,
    };
    const expected = assertionNeedsExpectedParameter(methodStep)
      ? expectedExpression(invocationStep, hasDataLoop, dataHints)
      : '';
    return `      await ${info.pageVar}.${methodName}(${expected});`;
  }
  const missingAuthoredExpected = !!(standardJsOutput && step && step.missingAuthoredExpected === true);
  const unresolvedAssertion = () => {
    const contractText = String(
      step.authoredContractText
      || step.description
      || step.instruction
      || `${step.channel || 'authored'} assertion`,
    ).trim();
    const message = `QAAI_ASSERTION_CONTRACT_UNRESOLVED: expected value and target evidence were unavailable. Contract: ${contractText}`;
    return `      // ${message.replace(/\r?\n/g, ' ')}\n      throw new Error(${q(message)});`;
  };
  const finalizeAssertion = (source) => standardJsOutput
    ? softenStandardJsAssertion(step, source)
    : continueAfterAssertionFailure(step, source);
  const emitGenericAssertion = () => {
    if (missingAuthoredExpected && !step.target && !step.scope?.selector && !pageSignals(step)) {
      return unresolvedAssertion();
    }
    const source = emitAssertion(standardJsOutput
      ? { ...step, dependencyPrerequisite: true }
      : step);
    return standardJsOutput ? softenStandardJsAssertion(step, source) : source;
  };
  if (!step.target) {
    // EVALUATE with script → call the generated EvaluateMethods method (Q4: hide evaluateSettled)
    if (step.channel === 'EVALUATE' && step.script && evalMap && evalMap.has(step)) {
      return `      await evaluateMethods.${evalMap.get(step)}();`;
    }
    const scopedLine = emitPomScopedAssertion(step, hasDataLoop, ms, dataHints, null);
    if (scopedLine) return finalizeAssertion(scopedLine);
    if (step.channel === 'PAGE') {
      const pageSignal = emitPageSignalAssertion(step, ms);
      return pageSignal ? finalizeAssertion(pageSignal) : emitGenericAssertion();
    }
    return emitGenericAssertion();
  }
  const info = pomInfoForRef(asMap, caseMap, step.target);
  if (!info) return emitGenericAssertion();
  if (step.liveOutcome === 'uncheckable'
      || (step.liveDomGrounded === false && (step.channel === 'UI_TEXT' || step.channel === 'FORBIDDEN_TEXT'))) {
    return emitGenericAssertion();
  }

  const targetExpr = pageAccessorCall(info.pageVar, info.name);
  const expected = expectedExpression(step, hasDataLoop, dataHints);
  const channel = String(step.channel || 'UI_TEXT').trim().toUpperCase();
  const payload = step.payload && typeof step.payload === 'object' ? step.payload : {};
  const rawExpected = step.expected
    ?? step.expectedValue
    ?? step.expectedCount
    ?? step.expectedChecked
    ?? payload.expected
    ?? payload.expectedValue
    ?? payload.expectedCount
    ?? payload.expectedChecked;
  const comparator = String(step.comparator || step.operator || payload.comparator || payload.operator || 'eq').trim().toLowerCase();
  const attributeName = String(step.attributeName || payload.attributeName || payload.name || step.name || '').trim();
  if (missingAuthoredExpected) {
    return finalizeAssertion(`      await expect(${targetExpr}).toBeVisible({ timeout: ${ms} });`);
  }
  if (step.channel === 'PAGE') {
    const pageSignal = emitPageSignalAssertion(step, ms);
    const source = pageSignal || `      await expect(${targetExpr}).toBeVisible({ timeout: ${ms} });`;
    return finalizeAssertion(source);
  }
  if (step.channel === 'UI_ROLE') {
    return finalizeAssertion(`      await expect(${targetExpr}).toBeVisible({ timeout: ${ms} });`);
  }
  if (step.channel === 'FORBIDDEN_TEXT') {
    return finalizeAssertion(`      await expect(${targetExpr}).not.toContainText(${expected}, { timeout: ${ms} });`);
  }
  if (step.channel === 'FORBIDDEN_ROLE') {
    return finalizeAssertion(`      await expect(${targetExpr}).toBeHidden({ timeout: ${ms} });`);
  }
  if (channel === 'VISIBLE') {
    return finalizeAssertion(`      await expect(${targetExpr}).toBeVisible({ timeout: ${ms} });`);
  }
  if (channel === 'HIDDEN') {
    return finalizeAssertion(`      await expect(${targetExpr}).toBeHidden({ timeout: ${ms} });`);
  }
  if (channel === 'VALUE' || channel === 'SELECTED') {
    return finalizeAssertion(`      await expect(${targetExpr}).toHaveValue(${expected}, { timeout: ${ms} });`);
  }
  if (channel === 'NUMBER') {
    return finalizeAssertion(`      await expect(${targetExpr}).toHaveText(${expected}, { timeout: ${ms} });`);
  }
  if (channel === 'CHECKED') {
    const checked = rawExpected !== false && String(rawExpected).toLowerCase() !== 'false';
    return finalizeAssertion(checked
      ? `      await expect(${targetExpr}).toBeChecked({ timeout: ${ms} });`
      : `      await expect(${targetExpr}).not.toBeChecked({ timeout: ${ms} });`);
  }
  if (channel === 'COUNT') {
    if (['gte', 'at_least', 'count_at_least', 'greater_than_or_equal'].includes(comparator)) {
      return finalizeAssertion(`      await expect.poll(async () => ${targetExpr}.count(), { timeout: ${ms} }).toBeGreaterThanOrEqual(Number(${expected}));`);
    }
    if (['lte', 'at_most', 'count_at_most', 'less_than_or_equal'].includes(comparator)) {
      return finalizeAssertion(`      await expect.poll(async () => ${targetExpr}.count(), { timeout: ${ms} }).toBeLessThanOrEqual(Number(${expected}));`);
    }
    return finalizeAssertion(`      await expect(${targetExpr}).toHaveCount(Number(${expected}), { timeout: ${ms} });`);
  }
  if (channel === 'ATTRIBUTE' && attributeName) {
    if (['absent', 'missing', 'not_present'].includes(comparator)) {
      return finalizeAssertion(`      await expect.poll(async () => ${targetExpr}.getAttribute(${q(attributeName)}), { timeout: ${ms} }).toBeNull();`);
    }
    return finalizeAssertion(`      await expect(${targetExpr}).toHaveAttribute(${q(attributeName)}, ${expected}, { timeout: ${ms} });`);
  }
  if (channel === 'ENABLED') {
    return finalizeAssertion(`      await expect(${targetExpr}).toBeEnabled({ timeout: ${ms} });`);
  }
  if (channel === 'DISABLED') {
    return finalizeAssertion(`      await expect(${targetExpr}).toBeDisabled({ timeout: ${ms} });`);
  }
  if (channel === 'EDITABLE') {
    return finalizeAssertion(`      await expect(${targetExpr}).toBeEditable({ timeout: ${ms} });`);
  }
  if (channel === 'READ_ONLY' || channel === 'READONLY') {
    return finalizeAssertion(`      await expect(${targetExpr}).not.toBeEditable({ timeout: ${ms} });`);
  }
  return finalizeAssertion(`      await expect(${targetExpr}).toContainText(${expected}, { timeout: ${ms} });`);
}

// ── Journey spec emitter ─────────────────────────────────────────────────────

function rawStepDataValue(step) {
  if (!step) return null;
  if (step.rawValue != null) return String(step.rawValue);
  if (step.value != null && typeof step.value !== 'object') return String(step.value);
  return null;
}

function dataRoleForStep(step, info) {
  if (step && step.dataRole) return step.dataRole;
  if (info && info.name) return stripRoleSuffix(info.name) || info.name;
  const label = step && (step.label || step.targetName || step.targetText || step.role);
  return label ? toSafeDataKey(label) : null;
}

function buildDataHints(ir, caseMap, exportedRows = []) {
  return { exportedKeys: commonExportedDataKeys(exportedRows) };
}

function _caseDataRows(ir, caseMap) {
  const rows = Array.isArray(ir && ir.dataRows) ? ir.dataRows : (ir && ir.dataRow ? [ir.dataRow] : []);
  return rows.filter((r) => r && r.fields && Object.keys(r.fields).length > 0);
}

function _pomJourneyStepLines(cases, asMap, evalMap, ctx = {}) {
  const lines = [];
  const dataFiles = ctx.dataFiles || {};
  const usedDataFiles = ctx.usedDataFiles || new Set();
  const caseAsMap = ctx.caseAsMap || null;
  const architectPlan = ctx.architectPlan || null;
  for (const [caseIndex, caseItem] of (cases || []).entries()) {
    const { ir, caseName } = caseItem || {};
    const sourceIndex = Number.isInteger(caseItem && caseItem._caseIndex) ? caseItem._caseIndex : caseIndex;
    const caseMap = caseAsLookup(caseAsMap, caseItem, sourceIndex);
    const title = caseName || (ir && (ir.title || ir.caseId)) || 'step';
    const dataRows = safeDataRows(_caseDataRows(ir, caseMap));
    const dataHints = buildDataHints(ir, caseMap, dataRows);
    const hasDataLoop = dataRows.length > 0;

    lines.push('');
    lines.push(`    // ─── ${title} ${'─'.repeat(Math.max(0, 64 - title.length))}`);
    const sessionComment = caseSessionContractComment(caseItem);
    if (sessionComment) lines.push(`    // ${sessionComment}`);
    lines.push(`    await test.step(${q(title)}, async () => {`);

    if (hasDataLoop) {
      const baseName = slug(title, 'data-rows');
      let dataPath = `tests/data/${baseName}.json`;
      let n = 2;
      while (usedDataFiles.has(dataPath)) {
        dataPath = `tests/data/${baseName}-${n}.json`;
        n += 1;
      }
      usedDataFiles.add(dataPath);
      dataFiles[dataPath] = JSON.stringify(dataRows, null, 2) + '\n';
      lines.push(`      const _dataRows = loadDataRows(${q(dataPath)});`);
      lines.push(`      for (const row of _dataRows) {`);
    }
    const dialogPrearm = emitDialogPrearm(ir, hasDataLoop ? '        ' : '      ');
    if (dialogPrearm) lines.push(dialogPrearm);

    let prevActAction = null;
    let prevClickTarget = null;
    for (const step of (ir && ir.steps) || []) {
      let line = null;
      if (step.op === 'resolve') {
        line = pomEmitResolve(step, asMap, caseMap);
        prevClickTarget = null;
      }
      else if (step.op === 'act') {
        line = pomEmitAct(step, asMap, hasDataLoop, prevActAction, caseMap, dataHints, ir);
        const a = String(step.action || '');
        if (a && a !== 'navigate' && a !== 'navigateBack' && a !== 'navigateForward') prevActAction = a;
        prevClickTarget = a === 'click' ? step.target || null : null;
      }
      else if (step.op === 'assert') {
        line = pomEmitAssert(step, asMap, evalMap, hasDataLoop, caseMap, dataHints);
        prevClickTarget = null;
      }
      else if (step.op === 'waitFor') {
        line = emitPomWait(step.condition, asMap, caseMap);
        prevClickTarget = null;
      }
      else if (step.op === 'handlePopup') {
        // Legacy authored-only popup declarations are metadata, not executable
        // browser mutations. Executed popup actions arrive as ordinary `act`
        // steps and must pass the exact-node locator compiler above.
        line = null;
        prevClickTarget = null;
      }
      else if (step.op === 'humanInput') {
        line = emitHumanInput(step.disposition, step);
        prevClickTarget = null;
      }
      if (line != null) {
        recordPomSpecPlan(architectPlan, caseItem, step, line);
        lines.push(hasDataLoop ? line.replace(/^      /, '        ') : line);
      }
    }

    if (hasDataLoop) lines.push(`      }`);
    lines.push(`      if (!page.isClosed()) await page.screenshot({ path: ${q(`test-results/${slug(title)}.png`)}, fullPage: true });`);
    lines.push('    });');
  }
  return lines;
}

function _pomCaseExecutionLines(caseItem, preconditionCases, asMap, evalMap, hasDataLoop, caseAsMap, caseIndex, dataHints, architectPlan) {
  const lines = [];
  const stepSources = [
    ...(preconditionCases || []).map((c) => ({ ...c, _precondition: true })),
    caseItem,
  ];
  for (const source of stepSources) {
    const ir = source && source.ir;
    const sourceIndex = source && source._caseIndex != null ? source._caseIndex : (source === caseItem ? caseIndex : null);
    const sourceCaseMap = source && source._caseMap ? source._caseMap : caseAsLookup(caseAsMap, source, sourceIndex);
    const sourceDataHints = source && source._precondition && !source._shareDataLoop
      ? buildDataHints(ir, sourceCaseMap, [])
      : dataHints;
    const dialogPrearm = emitDialogPrearm(ir);
    if (dialogPrearm) lines.push(dialogPrearm);
    let prevActAction = null;
    let prevClickTarget = null;
    for (const step of (ir && ir.steps) || []) {
      let line = null;
      if (step.op === 'resolve') {
        line = pomEmitResolve(step, asMap, sourceCaseMap);
        prevClickTarget = null;
      }
      else if (step.op === 'act') {
        const sourceUsesRow = !(source && source._precondition) || !!(source && source._shareDataLoop);
        const planned = null;
        line = pomEmitAct(step, asMap, hasDataLoop && sourceUsesRow, prevActAction, sourceCaseMap, sourceDataHints, ir);
        const a = String(step.action || '');
        const plannedClick = false;
        if (step.authored !== false) {
          if (plannedClick) prevActAction = 'click';
          else if (a && a !== 'navigate' && a !== 'navigateBack' && a !== 'navigateForward') prevActAction = a;
          prevClickTarget = (plannedClick || a === 'click') ? step.target || null : null;
        }
      } else if (step.op === 'assert') {
        line = pomEmitAssert(step, asMap, evalMap, hasDataLoop, sourceCaseMap, sourceDataHints);
        prevClickTarget = null;
      }
      else if (step.op === 'waitFor') {
        line = emitPomWait(step.condition, asMap, sourceCaseMap);
        prevClickTarget = null;
      }
      else if (step.op === 'handlePopup') {
        // Defense in depth for older ReplayIR: never convert popup narration
        // into a runnable locator/action.
        line = null;
        prevClickTarget = null;
      }
      else if (step.op === 'humanInput') {
        line = emitHumanInput(step.disposition, step);
        prevClickTarget = null;
      }
      if (line != null) {
        recordPomSpecPlan(architectPlan, source, step, line);
        lines.push(line);
      }
    }
  }
  return lines;
}

function recordPomSpecPlan(plan, caseItem, step, emittedSource) {
  if (!plan || !Array.isArray(plan.specPlan) || !step || step.authored === false || emittedSource == null) return;
  const source = String(emittedSource).trim();
  if (!source) return;
  const callMatch = source.match(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/);
  const testCaseId = caseItem?.testCaseId || caseItem?.caseId || caseItem?.ir?.testCaseId || caseItem?.ir?.caseId || null;
  const entry = {
    testCaseId,
    contractStepId: step.contractStepId || step.sourceContractStepId || step.contractRef || step.stepId || null,
    authoredActionId: step.authoredActionId || step.actionIdentity?.authoredActionId || null,
    occurrenceKey: step.occurrenceKey || step.actionIdentity?.occurrenceKey || null,
    sequenceIndex: step.sequenceIndex ?? step.actionIdentity?.sequenceIndex ?? null,
    op: step.op || null,
    action: step.action || (step.op === 'waitFor' ? 'waitFor' : null),
    target: step.target || step.condition?.target || null,
    pageVar: callMatch ? callMatch[1] : null,
    exportedPageMethod: callMatch ? callMatch[2] : null,
    emittedSource: source,
  };
  const duplicate = plan.specPlan.some((item) =>
    item.testCaseId === entry.testCaseId
    && item.contractStepId === entry.contractStepId
    && item.authoredActionId === entry.authoredActionId
    && item.op === entry.op
    && item.action === entry.action
    && item.emittedSource === entry.emittedSource);
  if (!duplicate) plan.specPlan.push(entry);
}

function hasReplaySetupSteps(caseItem) {
  const steps = Array.isArray(caseItem && caseItem.ir && caseItem.ir.steps) ? caseItem.ir.steps : [];
  return steps.some((s) => s && s.authored !== false && s.op === 'act');
}

function isAssertionOnlyCase(caseItem) {
  const steps = Array.isArray(caseItem && caseItem.ir && caseItem.ir.steps) ? caseItem.ir.steps : [];
  return steps.length > 0
    && steps.some((s) => s && s.op === 'assert')
    && !steps.some((s) => s && s.authored !== false && s.op === 'act');
}

function actionOnlyPrecondition(caseItem, caseIndex) {
  const ir = caseItem && caseItem.ir;
  if (!ir || !Array.isArray(ir.steps)) return null;
  const steps = ir.steps.filter((step) => step && !(step.op === 'act' && step.authored === false));
  if (!steps.some((s) => s && s.op === 'act')) return null;
  return {
    ...caseItem,
    _caseIndex: caseIndex,
    ir: { ...ir, steps },
  };
}

function stringList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).map((item) => item.trim()).filter(Boolean);
  } catch (_) {}
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function caseIdentityValues(caseItem) {
  const ir = caseItem && caseItem.ir || {};
  return new Set([
    caseItem && caseItem.testCaseId,
    caseItem && caseItem.caseId,
    caseItem && caseItem.runResultId,
    caseItem && caseItem.caseName,
    caseItem && caseItem.name,
    ir.testCaseId,
    ir.caseId,
    ir.title,
  ].filter(Boolean).map(String));
}

function explicitDependencyValues(caseItem) {
  const ir = caseItem && caseItem.ir || {};
  const session = ir.sessionRequirement && typeof ir.sessionRequirement === 'object' ? ir.sessionRequirement : {};
  return new Set([
    ...stringList(caseItem && caseItem.dependsOn),
    ...stringList(caseItem && caseItem.dependsOnIds),
    ...stringList(caseItem && caseItem.dependsOnNames),
    ...stringList(caseItem && caseItem.dependsOnCaseRefs),
    ...stringList(caseItem && caseItem.dependsOnCaseId),
    ...stringList(ir.dependsOn),
    ...stringList(ir.dependsOnIds),
    ...stringList(ir.dependsOnNames),
    ...stringList(ir.dependsOnCaseRefs),
    ...stringList(ir.dependsOnCaseId),
    ...stringList(session.dependsOnCaseRefs),
    ...stringList(session.dependsOnCaseId),
  ]);
}

function explicitlyDependsOn(caseItem, candidate) {
  const dependencies = explicitDependencyValues(caseItem);
  if (!dependencies.size) return false;
  for (const identity of caseIdentityValues(candidate)) {
    if (dependencies.has(identity)) return true;
  }
  return false;
}

const CONTINUATION_SESSION_MODES = new Set([
  'continue_from_dependency',
  'continue_from_case',
  'same_session',
]);

function normalizeSessionMode(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function sessionModeFor(caseItem) {
  const ir = caseItem && caseItem.ir || {};
  const contracts = [
    caseItem,
    caseItem && caseItem.sessionContract,
    caseItem && caseItem.sessionRequirement,
    ir,
    ir.sessionContract,
    ir.sessionRequirement,
  ];
  for (const contract of contracts) {
    if (!contract || typeof contract !== 'object') continue;
    const mode = normalizeSessionMode(contract.sessionMode != null ? contract.sessionMode : contract.mode);
    if (mode) return mode;
  }
  return '';
}

function failurePolicyFor(caseItem) {
  const ir = caseItem && caseItem.ir || {};
  const contracts = [
    caseItem,
    caseItem && caseItem.sessionContract,
    caseItem && caseItem.sessionRequirement,
    ir,
    ir.sessionContract,
    ir.sessionRequirement,
  ];
  for (const contract of contracts) {
    if (!contract || typeof contract !== 'object' || contract.failurePolicy == null) continue;
    return contract.failurePolicy;
  }
  return null;
}

function commentValue(value) {
  if (value == null) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.replace(/[\r\n]+/g, ' ').replace(/\*\//g, '* /').trim();
}

function dependencyCommentValues(caseItem) {
  const ir = (caseItem && caseItem.ir) || {};
  const preferredNames = [
    ...stringList(caseItem && caseItem.dependsOnNames),
    ...stringList(ir.dependsOnNames),
  ].filter(Boolean);
  if (preferredNames.length) return [...new Set(preferredNames)];
  const opaqueIdentifier = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9a-f]{24,})$/i;
  const readable = [...explicitDependencyValues(caseItem)].filter(
    (value) => !opaqueIdentifier.test(String(value).trim()),
  );
  if (readable.length) return readable;
  return explicitDependencyValues(caseItem).size ? ['previous dependency case'] : [];
}

function caseSessionContractComment(caseItem) {
  const mode = sessionModeFor(caseItem);
  const dependencies = dependencyCommentValues(caseItem);
  const failurePolicy = failurePolicyFor(caseItem);
  const parts = [];
  if (mode) parts.push(`sessionMode: ${commentValue(mode)}`);
  if (dependencies.length) parts.push(`dependsOn: ${dependencies.map(commentValue).join(', ')}`);
  if (failurePolicy != null) parts.push(`failurePolicy: ${commentValue(failurePolicy)}`);
  return parts.length ? `Session contract — ${parts.join('; ')}.` : '';
}

function isContinuationCase(caseItem) {
  return CONTINUATION_SESSION_MODES.has(sessionModeFor(caseItem));
}

function planPomExecutionUnits(cases) {
  const sourceCases = Array.isArray(cases) ? cases : [];
  const nodes = sourceCases.map((caseItem, index) => ({ caseItem, index }));
  const parentsByChild = new Map(nodes.map((node) => [node.index, new Set()]));
  const neighbors = new Map(nodes.map((node) => [node.index, new Set()]));

  for (const child of nodes) {
    if (!isContinuationCase(child.caseItem)) continue;
    for (const parent of nodes) {
      if (parent.index === child.index || !explicitlyDependsOn(child.caseItem, parent.caseItem)) continue;
      parentsByChild.get(child.index).add(parent.index);
      neighbors.get(child.index).add(parent.index);
      neighbors.get(parent.index).add(child.index);
    }
  }

  const hasContinuation = [...parentsByChild.values()].some((parents) => parents.size > 0);
  if (!hasContinuation) return { hasContinuation: false, units: [{ kind: 'cases', cases: sourceCases }] };

  const visited = new Set();
  const units = [];
  for (const node of nodes) {
    if (visited.has(node.index)) continue;
    const stack = [node.index];
    const component = [];
    visited.add(node.index);
    while (stack.length) {
      const current = stack.pop();
      component.push(current);
      for (const adjacent of neighbors.get(current) || []) {
        if (visited.has(adjacent)) continue;
        visited.add(adjacent);
        stack.push(adjacent);
      }
    }

    const componentSet = new Set(component);
    const indegree = new Map(component.map((index) => [index, 0]));
    for (const childIndex of component) {
      for (const parentIndex of parentsByChild.get(childIndex) || []) {
        if (componentSet.has(parentIndex)) indegree.set(childIndex, indegree.get(childIndex) + 1);
      }
    }
    const ready = component.filter((index) => indegree.get(index) === 0).sort((a, b) => a - b);
    const ordered = [];
    while (ready.length) {
      const current = ready.shift();
      ordered.push(current);
      for (const childIndex of component) {
        if (!(parentsByChild.get(childIndex) || new Set()).has(current)) continue;
        indegree.set(childIndex, indegree.get(childIndex) - 1);
        if (indegree.get(childIndex) === 0) {
          ready.push(childIndex);
          ready.sort((a, b) => a - b);
        }
      }
    }
    for (const index of component.sort((a, b) => a - b)) {
      if (!ordered.includes(index)) ordered.push(index);
    }

    const unitCases = ordered.map((index) => ({ ...sourceCases[index], _caseIndex: index }));
    units.push({
      kind: component.length > 1 ? 'continuation' : 'case',
      firstIndex: Math.min(...component),
      cases: unitCases,
    });
  }
  units.sort((a, b) => a.firstIndex - b.firstIndex);
  return { hasContinuation: true, units };
}

function siblingPreconditionsFor(emitCases, caseIndex) {
  const item = emitCases[caseIndex];
  if (!isAssertionOnlyCase(item)) return [];
  for (let i = caseIndex - 1; i >= 0; i -= 1) {
    if (!hasReplaySetupSteps(emitCases[i])) continue;
    const precondition = actionOnlyPrecondition(emitCases[i], i);
    if (precondition
        && explicitlyDependsOn(item, emitCases[i])
        && safeDataRows(_caseDataRows(precondition.ir, caseAsLookup(null, precondition, i))).length) {
      precondition._shareDataLoop = true;
    }
    return precondition ? [precondition] : [];
  }
  return [];
}

function pageFilesUsedByCases(cases, asMap, caseAsMap) {
  const used = new Set();
  for (const [index, item] of (cases || []).entries()) {
    const sourceIndex = Number.isInteger(item && item._caseIndex) ? item._caseIndex : index;
    const caseMap = caseAsLookup(caseAsMap, item, sourceIndex);
    if (caseMap && typeof caseMap.values === 'function') {
      for (const info of caseMap.values()) {
        if (info && info.file) used.add(info.file);
      }
    }
    for (const step of item?.ir?.steps || []) {
      const operationInfo = asMap.__operationMap && asMap.__operationMap.get(step);
      const assertionInfo = asMap.__assertionMap && asMap.__assertionMap.get(step);
      if (operationInfo && operationInfo.file) used.add(operationInfo.file);
      if (assertionInfo && assertionInfo.file) used.add(assertionInfo.file);
      for (const ref of [step.target, step.destinationTarget]) {
        const info = ref && pomInfoForRef(asMap, caseMap, ref);
        if (info && info.file) used.add(info.file);
      }
    }
  }
  return used;
}

function caseGroupHasPopup(cases) {
  return (cases || []).some((item) => (item?.ir?.steps || []).some((step) =>
    !!popupActionContract(step)));
}

function pageInitLinesForCases(cases, asMap, caseAsMap, allPageInitLines) {
  if (caseGroupHasPopup(cases)) return allPageInitLines;
  return [...pageFilesUsedByCases(cases, asMap, caseAsMap)]
    .sort()
    .map((file) => `const ${file} = new ${pageClassName(file)}(page);`);
}

function partialRunBoundaryComment(caseItem) {
  const evidence = (caseItem?.ir?.runtimeEvidence || []).find(
    (entry) => entry?.kind === 'partial_run_boundary'
      || entry?.failureBoundary?.code === 'partial_run_evidence_boundary',
  );
  const boundary = evidence?.failureBoundary;
  if (!boundary) return null;
  const safe = (value) => String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
  const afterNumber = Number(boundary.afterAuthoredStepNumber);
  const nextNumber = Number(boundary.nextAuthoredStepNumber);
  if (!Number.isInteger(afterNumber) || afterNumber < 1 || !Number.isInteger(nextNumber)) {
    return null;
  }
  const afterId = safe(boundary.afterContractStepId);
  const nextId = safe(boundary.nextContractStepId);
  return `// Execution evidence ended after authored step ${afterNumber}${afterId ? ` (${afterId})` : ''}. Authored step ${nextNumber}${nextId ? ` (${nextId})` : ''} was not executed; no executable code was generated beyond this boundary.`;
}

function _pomTestBlocks(cases, asMap, evalMap, ctx = {}, pageInitLines = [], evalInitLine = '') {
  const lines = [];
  const dataFiles = ctx.dataFiles || {};
  const usedDataFiles = ctx.usedDataFiles || new Set();
  const caseAsMap = ctx.caseAsMap || null;
  const architectPlan = ctx.architectPlan || null;
  const syntheticPreconditions = (cases || []).filter((c) => c && c.synthetic);
  const realCases = (cases || []).filter((c) => c && !c.synthetic);
  const emitCases = realCases.length ? realCases : (cases || []);
  let idx = Number.isInteger(ctx.dataVarCounter) ? ctx.dataVarCounter : 0;

  for (const [caseIndex, item] of emitCases.entries()) {
    const ir = item && item.ir;
    const sourceIndex = Number.isInteger(item && item._caseIndex) ? item._caseIndex : caseIndex;
    const caseMap = caseAsLookup(caseAsMap, item, sourceIndex);
    const title = (item && item.caseName) || (ir && (ir.title || ir.caseId)) || 'test case';
    const siblingPreconditions = siblingPreconditionsFor(emitCases, caseIndex);
    let dataRows = safeDataRows(_caseDataRows(ir, caseMap));
    let dataHints = buildDataHints(ir, caseMap, dataRows);
    if (!dataRows.length) {
      for (const pre of siblingPreconditions) {
        if (!pre || !pre._shareDataLoop) continue;
        const preMap = caseAsLookup(caseAsMap, pre, pre._caseIndex);
        dataRows = safeDataRows(_caseDataRows(pre.ir, preMap));
        if (dataRows.length) dataHints = buildDataHints(pre.ir, preMap, dataRows);
        if (dataRows.length) break;
      }
    }
    const hasDataLoop = dataRows.length > 0;
    const bodyIndent = hasDataLoop ? '      ' : '    ';

    lines.push('');
    if (hasDataLoop) {
      const baseName = slug(title, 'data-rows');
      let dataPath = `tests/data/${baseName}.json`;
      let n = 2;
      while (usedDataFiles.has(dataPath)) {
        dataPath = `tests/data/${baseName}-${n}.json`;
        n += 1;
      }
      usedDataFiles.add(dataPath);
      dataFiles[dataPath] = JSON.stringify(dataRows, null, 2) + '\n';
      const varName = `_dataRows${idx++}`;
      lines.push(`  const ${varName} = loadDataRows(${q(dataPath)});`);
      lines.push(`  for (const row of ${varName}) {`);
      lines.push(`    test(${q(`${title} [`)} + row.label + ']', async ({ page }) => {`);
    } else {
      lines.push(`  test(${q(title)}, async ({ page }) => {`);
    }

    const preconditions = [...syntheticPreconditions, ...siblingPreconditions];
    const scopedPageInitLines = pageInitLinesForCases(
      [item, ...preconditions],
      asMap,
      caseAsMap,
      pageInitLines,
    );
    for (const init of scopedPageInitLines) lines.push(`${bodyIndent}${init}`);
    if (evalInitLine) lines.push(`${bodyIndent}${evalInitLine}`);
    const bodyLines = _pomCaseExecutionLines(item, preconditions, asMap, evalMap, hasDataLoop, caseAsMap, sourceIndex, dataHints, architectPlan);
    for (const line of bodyLines) lines.push(line.replace(/^      /, bodyIndent));
    lines.push(`${bodyIndent}if (!page.isClosed()) await page.screenshot({ path: ${q(`test-results/${slug(title)}.png`)}, fullPage: true });`);
    const boundaryComment = partialRunBoundaryComment(item);
    if (boundaryComment) lines.push(`${bodyIndent}${boundaryComment}`);
    lines.push(hasDataLoop ? `    });` : `  });`);
    if (hasDataLoop) lines.push(`  }`);
  }
  ctx.dataVarCounter = idx;
  return lines;
}

function _pomContinuationTestBlock(cases, title, asMap, evalMap, ctx, pageInitLines, evalInitLine) {
  const lines = ['', `  test(${q(title)}, async ({ page }) => {`];
  const scopedPageInitLines = pageInitLinesForCases(
    cases,
    asMap,
    ctx && ctx.caseAsMap,
    pageInitLines,
  );
  for (const init of scopedPageInitLines) lines.push(`    ${init}`);
  if (evalInitLine) lines.push(`    ${evalInitLine}`);
  lines.push(..._pomJourneyStepLines(cases, asMap, evalMap, ctx));
  const boundaryComments = [...new Set((cases || []).map(partialRunBoundaryComment).filter(Boolean))];
  for (const comment of boundaryComments) lines.push(`    ${comment}`);
  lines.push('  });');
  return lines;
}

// Compute the relative path from the spec's directory to the pages/ directory.
// Derived structurally from opts.specDir so the import path is always correct even
// if the output layout changes — never assumes a fixed depth.
// Falls back to '../../pages' (the current standard depth: tests/<module>/<spec>)
// when the caller doesn't provide specDir, so existing tests that omit it still pass.
function relativeImportPath(fromDir, targetNoExt, fallback) {
  if (!fromDir) return fallback;
  const rel = path.posix.relative(fromDir, targetNoExt);
  if (!rel) return '.';
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function _pagesImportPath(specDir) {
  return relativeImportPath(specDir, 'pages', '../../pages');
}

function _supportImportPath(specDir) {
  return relativeImportPath(specDir, 'tests/support/replayir', '../support/replayir');
}

function emitPomSpec(cases, opts, asMap, evalMap, evalEntries, lang = 'ts', moduleFormat = 'esm', caseAsMap = null) {
  const scenarioName = String(opts.scenarioName || (cases[0] && cases[0].ir && (cases[0].ir.title || cases[0].ir.caseId)) || 'Journey').trim();
  const cjs = isCjs(lang, moduleFormat);

  // Collect which pages are used and need imports + constructor calls.
  const usedPages = new Set();
  for (const info of allMappedInfos(asMap, caseAsMap)) usedPages.add(info.file);

  const pagesRel = _pagesImportPath(opts && opts.specDir);
  const jsImportExt = importExt(lang, moduleFormat);
  const pageImports = [...usedPages].sort()
    .map((f) => cjs
      ? `const { ${pageClassName(f)} } = require('${pagesRel}/${pageClassName(f)}${jsImportExt}');`
      : `import { ${pageClassName(f)} } from '${pagesRel}/${pageClassName(f)}${jsImportExt}';`)
    .join('\n');

  const pageInitLines = [...usedPages].sort()
    .map((f) => `const ${f} = new ${pageClassName(f)}(page);`);

  const hasEvalMethods = evalEntries && evalEntries.length > 0;
  const evalImport = hasEvalMethods
    ? (cjs
      ? `\nconst { EvaluateMethods } = require('${pagesRel}/EvaluateMethods${jsImportExt}');`
      : `\nimport { EvaluateMethods } from '${pagesRel}/EvaluateMethods${jsImportExt}';`)
    : '';
  const evalInitLine = hasEvalMethods ? `const evaluateMethods = new EvaluateMethods(page);` : '';

  const bodyCtx = { ...(opts && opts._pomDataCtx || {}), caseAsMap, architectPlan: opts && opts._pomArchitectPlan };
  const executionPlan = planPomExecutionUnits(cases);
  const bodyLines = [];
  if (!executionPlan.hasContinuation) {
    bodyLines.push(..._pomTestBlocks(cases, asMap, evalMap, bodyCtx, pageInitLines, evalInitLine));
  } else {
    for (const unit of executionPlan.units) {
      if (unit.kind === 'continuation') {
        const unitTitle = executionPlan.units.length === 1
          ? scenarioName
          : unit.cases.map((item) => item.caseName || item.ir && (item.ir.title || item.ir.caseId) || 'test case').join(' → ');
        bodyLines.push(..._pomContinuationTestBlock(unit.cases, unitTitle, asMap, evalMap, bodyCtx, pageInitLines, evalInitLine));
      } else {
        bodyLines.push(..._pomTestBlocks(unit.cases, asMap, evalMap, bodyCtx, pageInitLines, evalInitLine));
      }
    }
  }
  const body = bodyLines.join('\n');

  const pageImportBlock = pageImports ? `\n${pageImports}` : '';

  const playwrightImports = ['test'];
  if (/\bexpect(?:\.(?:poll|soft))?\s*\(/.test(body)) playwrightImports.push('expect');

  const supportImports = [
    /\bassertTextPresent\s*\(/.test(body) && 'assertTextPresent',
    /\bassertScopedText\s*\(/.test(body) && 'assertScopedText',
    /\bdismissKnownPopups\s*\(/.test(body) && 'dismissKnownPopups',
    /\breadEnv\s*\(/.test(body) && 'readEnv',
    /\breadData\s*\(/.test(body) && 'readData',
    /\bmissingBindingValue\s*\(/.test(body) && 'missingBindingValue',
    /\breadRuntimeOutput\s*\(/.test(body) && 'readRuntimeOutput',
    /\breadDependencyOutput\s*\(/.test(body) && 'readDependencyOutput',
    /\bgenerateDeterministicValue\s*\(/.test(body) && 'generateDeterministicValue',
    /\bloadDataRows\s*\(/.test(body) && 'loadDataRows',
    /\bresolveLocator\s*\(/.test(body) && 'resolveLocator',
    /\bcheckAccessibility\s*\(/.test(body) && 'checkAccessibility',
    /\bevaluateSettled\s*\(/.test(body) && 'evaluateSettled',
    /\bwaitForStableObservations\s*\(/.test(body) && 'waitForStableObservations',
  ].filter(Boolean);
  const supportImport = supportImports.length
    ? (cjs
      ? `\nconst { ${supportImports.join(', ')} } = require('${_supportImportPath(opts && opts.specDir)}${jsImportExt}');`
      : `\nimport { ${supportImports.join(', ')} } from '${_supportImportPath(opts && opts.specDir)}${jsImportExt}';`)
    : '';

  const playwrightImport = cjs
    ? `const { ${playwrightImports.join(', ')} } = require('@playwright/test');`
    : `import { ${playwrightImports.join(', ')} } from '@playwright/test';`;

  return `${playwrightImport}${supportImport}${pageImportBlock}${evalImport}

test.describe(${q(scenarioName)}, () => {
  test.describe.configure({ mode: 'serial', retries: 1 });
${body}
});
`;
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * emitJourneySpec — returns { content, extraFiles } (not a plain string).
 * replayExport._compileJourneyGroup detects the object form and spreads extraFiles
 * into the assembled package.
 *
 * extraFiles:
 *   locators/<page>.locators.ts   — one per distinct URL-domain page
 *   pages/<Page>.ts               — one per distinct page
 *   evidence/locator-conflicts.json  — present only when conflicts exist (guardrail 2)
 */
function emitJourneySpec(cases, opts = {}) {
  const lang = opts.lang === 'js' ? 'js' : 'ts';
  const moduleFormat = opts.moduleFormat === 'cjs' ? 'cjs' : 'esm';
  const standardJsOutput = standardJsOutputEnabled(opts, lang);
  const fe = ext(lang); // file extension for generated source files

  if (standardJsOutput) cases = normalizeStandardJsPageContexts(cases);
  const allowPageRebinding = standardJsOutput && (cases || []).some((caseItem) =>
    (caseItem?.ir?.steps || []).some((step) => !!popupActionContract(step)));

  const { repo, asMap, caseAsMap } = buildAsMap(cases, {
    preferCapturedPageIdentity: standardJsOutput,
    materializeUnresolvedActions: standardJsOutput,
  });
  if (standardJsOutput) assertStandardJsPomCoverage(cases, asMap, caseAsMap);
  const pagesMethods = collectPageMethods(cases, asMap, caseAsMap);
  if (standardJsOutput) materializeAuthoredAssertionLocators(repo, asMap, pagesMethods);
  // Shared method-name registry (PO↔spec bijection). Attach to asMap so pomEmitAct
  // resolves the EXACT same method name the page file declares — no missing/wrong-element.
  const methodNameRegistry = buildMethodNameRegistry(pagesMethods, standardJsOutput);
  try {
    asMap.__methodNames = methodNameRegistry;
    asMap.__pagesMethods = pagesMethods;
  } catch (_) {}
  try {
    asMap.__standardJsOutput = standardJsOutput;
    asMap.__pageVars = allMappedInfos(asMap, caseAsMap)
      .map((info) => info.pageVar)
      .filter((value, index, values) => values.indexOf(value) === index);
  } catch (_) {}
  const architectPlan = {
    schemaVersion: 'qaai-pom-architect-v1',
    mode: 'canonical-only',
    pages: {},
    specPlan: [],
    rejectedAbstractions: [],
    stepPlans: new WeakMap(),
  };

  const extraFiles = {};
  const assertionDiagnostics = standardJsOutput
    ? collectNonExecutableAssertionDiagnostics(cases)
    : [];

  // G.2 Manual override contract: generated file under locators/generated/; shim at locators/.
  // Include all pages referenced in asMap — some may not be in repo.files if the repository
  // builder filtered them for a different reason (e.g. conflict-only entries). Without their
  // page file, the spec would call methods on an import that doesn't exist.
  const locatorStats = {};
  const allPageFileNames = new Set([
    ...Object.keys(repo.files),
    ...allMappedInfos(asMap, caseAsMap).map((i) => i.file),
    ...pagesMethods.keys(),
  ]);
  for (const fileName of allPageFileNames) {
    const entries = repo.files[fileName] || {};
    const methods = pagesMethods.get(fileName) || new Map();
    if (Object.keys(entries).length) {
      extraFiles[`locators/generated/${fileName}.generated.locators${fe}`] = emitLocatorFileGenerated(fileName, entries, lang, moduleFormat);
      extraFiles[`locators/${fileName}.locators${fe}`] = emitLocatorShim(fileName, lang, moduleFormat);
    }
    extraFiles[`pages/${pageClassName(fileName)}${fe}`] = emitPageFile(fileName, entries, methods, lang, moduleFormat, architectPlan.pages[fileName], methodNameRegistry.get(fileName), standardJsOutput, allowPageRebinding);
    locatorStats[fileName] = { locatorCount: Object.keys(entries).length };
  }

  if (repo.conflicts.length) {
    extraFiles['evidence/locator-conflicts.json'] = JSON.stringify(repo.conflicts, null, 2) + '\n';
  }

  // G.8 Evidence: always emit full locator manifest.
  extraFiles['evidence/locator-manifest.json'] = JSON.stringify(repo.manifest, null, 2) + '\n';
  if (assertionDiagnostics.length) {
    extraFiles['evidence/assertion-diagnostics.json'] = JSON.stringify({
      schemaVersion: 'qaai-assertion-diagnostics-v1',
      summary: {
        diagnosticCount: assertionDiagnostics.length,
        blockingCount: 0,
      },
      assertions: assertionDiagnostics,
    }, null, 2) + '\n';
  }
  const domAtlasEvidence = collectDomAtlasEvidence(cases);
  if (domAtlasEvidence) {
    extraFiles['evidence/dom-atlas.json'] = JSON.stringify(domAtlasEvidence, null, 2) + '\n';
  }
  // The JS POM profile is source-first: locator provenance remains in the
  // editable locator module and manifest, not in a certification artifact.
  const locatorCertificationEvidence = standardJsOutput ? null : collectLocatorCertificationEvidence(cases);
  if (locatorCertificationEvidence) {
    extraFiles['evidence/locator-certification-report.json'] = JSON.stringify(locatorCertificationEvidence, null, 2) + '\n';
  }

  // Q4: build EVALUATE method map — hides evaluateSettled/page.evaluate from spec body
  const { map: evalMap, entries: evalEntries } = _buildEvalMap(cases, opts);
  if (evalEntries.length) {
    const evalFile = _emitEvaluateMethodsFile(evalEntries, lang, moduleFormat);
    if (evalFile) extraFiles[`pages/EvaluateMethods${fe}`] = evalFile;
  }

  const dataCtx = { dataFiles: {}, usedDataFiles: new Set() };
  const specContent = emitPomSpec(cases, { ...opts, _pomDataCtx: dataCtx, _pomArchitectPlan: architectPlan }, asMap, evalMap, evalEntries, lang, moduleFormat, caseAsMap);
  Object.assign(extraFiles, dataCtx.dataFiles);
  extraFiles['evidence/pom-architect-report.json'] = JSON.stringify(pomArchitectAgent.serializableReport(architectPlan), null, 2) + '\n';

  // G.7 Readable-code gate: quality issues → Draft downgrade (never hard-block).
  const qualityIssues = detectQualityIssues(specContent);
  // JS POM exports remain directly runnable. Locator uncertainty is explicit
  // beside the locator instead of being turned into a draft banner.
  const isDraft = !standardJsOutput && qualityIssues.length > 0;
  const content = isDraft
    ? `// STATUS: DRAFT — quality flags (spec is runnable; review recommended): ${qualityIssues.map((q) => q.code).join(', ')}\n${specContent}`
    : specContent;
  const pomGraph = buildPomGraph({
    repo,
    pagesMethods,
    domAtlasEvidence,
    locatorCertificationEvidence,
    qualityIssues: standardJsOutput ? [] : qualityIssues,
    isDraft,
    dataFiles: dataCtx.dataFiles,
    lang,
    moduleFormat,
    adapterId: opts.adapterId,
    standardOutputProfile: opts.standardOutputProfile,
    architectPlan,
  });

  // G.8 Certification report: per-file status + quality audit.
  if (!standardJsOutput) extraFiles['evidence/certification-report.json'] = JSON.stringify({
    fidelityPlan: 'AS_IS_FIDELITY_PLAN §4 Class G Phase 3',
    spec: { status: isDraft ? 'draft' : 'runnable', qualityIssues },
    data: {
      fileCount: Object.keys(dataCtx.dataFiles).length,
      files: Object.keys(dataCtx.dataFiles),
    },
    locators: Object.fromEntries(
      Object.entries(locatorStats).map(([f, s]) => [
        `locators/generated/${f}.generated.locators${fe}`,
        { status: 'runnable', ...s },
      ])
    ),
    evidence: {
      'locator-manifest.json': { status: 'present', entryCount: repo.manifest.length },
      'locator-conflicts.json': { status: repo.conflicts.length ? 'present' : 'absent', conflictCount: repo.conflicts.length },
      'dom-atlas.json': { status: domAtlasEvidence ? 'present' : 'absent', pageCount: domAtlasEvidence ? Object.keys(domAtlasEvidence.pages || {}).length : 0 },
      'locator-certification-report.json': {
        status: locatorCertificationEvidence ? (locatorCertificationEvidence.summary && locatorCertificationEvidence.summary.status || 'present') : 'absent',
        stepCount: locatorCertificationEvidence && locatorCertificationEvidence.summary ? locatorCertificationEvidence.summary.total : 0,
        certified: locatorCertificationEvidence && locatorCertificationEvidence.summary ? locatorCertificationEvidence.summary.certified : 0,
        draft: locatorCertificationEvidence && locatorCertificationEvidence.summary ? locatorCertificationEvidence.summary.draft : 0,
        blocked: locatorCertificationEvidence && locatorCertificationEvidence.summary ? locatorCertificationEvidence.summary.blocked : 0,
      },
      'pom-architect-report.json': { status: 'present', methodCount: Object.values((architectPlan && architectPlan.pages) || {}).reduce((n, page) => n + ((page && page.architectMethods) || []).length, 0) },
    },
  }, null, 2) + '\n';

  const sanitizedContent = sanitizeGeneratedSource(content);
  for (const [fileName, source] of Object.entries(extraFiles)) {
    if (/\.(?:[cm]?js|ts)$/.test(fileName) && typeof source === 'string') {
      extraFiles[fileName] = sanitizeGeneratedSource(source);
    }
  }
  return { content: sanitizedContent, extraFiles, pomGraph };
}

module.exports = {
  id: ADAPTER_ID,
  emitJourneySpec,
  // Exposed for tests
  _buildAsMap: buildAsMap,
  _collectPageMethods: collectPageMethods,
  _emitLocatorFile: emitLocatorFile,
  _emitLocatorFileGenerated: emitLocatorFileGenerated,
  _emitLocatorShim: emitLocatorShim,
  _detectQualityIssues: detectQualityIssues,
  _emitPageFile: emitPageFile,
  _emitPomWait: emitPomWait,
  _isImmediatePostClickWait: isImmediatePostClickWait,
  _emitPageSignalAssertion: emitPageSignalAssertion,
  _pomEmitAct: pomEmitAct,
  _pagesImportPath: _pagesImportPath,
  _supportImportPath: _supportImportPath,
  _methodNameFor: methodNameFor,
  _buildMethodBody: buildMethodBody,
  _serializePageMethodStep: serializePageMethodStep,
  _pageClassName: pageClassName,
  _buildPomGraph: buildPomGraph,
  _mergePomGraphs: mergePomGraphs,
  _emitPomGraphFiles: emitPomGraphFiles,
};
