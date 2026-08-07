'use strict';

const fs = require('fs');
const path = require('path');
const { getRoles, getSuggestedQuery, isInaccessible } = require('@testing-library/dom');

function loadCssSelectorGenerator() {
  // css-selector-generator exposes a UMD file to CommonJS. Its wrapper reads
  // the browser global `self` before selecting module.exports, which otherwise
  // makes every Node-only codegen/verifier import fail. Keep the compatibility
  // alias scoped to module loading; the package's real DOM work still runs only
  // when a DOM target is supplied, and the browser-injected lane is unchanged.
  const hadOwnSelf = Object.prototype.hasOwnProperty.call(globalThis, 'self');
  const previousSelf = globalThis.self;
  if (!hadOwnSelf) globalThis.self = globalThis;
  try {
    return require('css-selector-generator').cssSelectorGenerator;
  } finally {
    if (hadOwnSelf) globalThis.self = previousSelf;
    else delete globalThis.self;
  }
}

const cssSelectorGenerator = loadCssSelectorGenerator();

const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_MAX_CANDIDATES = 500;
const DEFAULT_MAX_COMBINATIONS = 2_000;
const LIVE_ANALYSIS_SCHEMA = 'qaai-live-locator-analysis/1';
const STABLE_ATTRIBUTE_NAMES = new Set([
  'aria-label',
  'aria-labelledby',
  'autocomplete',
  'data-cy',
  'data-pw',
  'data-qa',
  'data-test',
  'data-testid',
  'id',
  'name',
  'placeholder',
  'role',
  'title',
  'type',
]);

const GENERATED_TOKEN_PATTERNS = [
  /(?:^|[-_])(?:css|emotion|makeStyles|mui|sc|styled|jsx)[-_][a-z0-9]{5,}$/i,
  /(?:^|[-_])[a-f0-9]{8,}(?:[-_]|$)/i,
  /(?:^|[-_])\d{7,}(?:[-_]|$)/,
  /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i,
];

function cleanText(value, max = 240) {
  const text = String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
  return max && text.length > max ? text.slice(0, max) : text;
}

function attributeNameFromSelector(selector) {
  const match = /^\[\s*([^\s~|^$*!=\]]+)/.exec(String(selector || ''));
  return match ? match[1].toLowerCase() : '';
}

function tokenFromAtomicSelector(selector) {
  const raw = String(selector || '');
  if (raw.startsWith('.') || raw.startsWith('#')) return raw.slice(1);
  const attrValue = /^\[[^=\]]+=["']?([^"'\]]+)/.exec(raw);
  return attrValue ? attrValue[1] : raw;
}

function isGeneratedOrUnstableSelector(selector) {
  const raw = String(selector || '').trim();
  if (!raw) return true;
  const attributeName = attributeNameFromSelector(raw);
  if (attributeName && !STABLE_ATTRIBUTE_NAMES.has(attributeName)) return true;
  const token = tokenFromAtomicSelector(raw);
  return GENERATED_TOKEN_PATTERNS.some((pattern) => pattern.test(token));
}

function defaultSelectorRoot(target, explicitRoot) {
  if (explicitRoot) return explicitRoot;
  if (target && typeof target.getRootNode === 'function') return target.getRootNode();
  return target && target.ownerDocument ? target.ownerDocument : null;
}

function canQuery(root) {
  return !!root && typeof root.querySelectorAll === 'function';
}

function queryExactTarget(root, selector, target) {
  if (!canQuery(root) || !selector) return { count: null, exactTarget: false };
  try {
    const matches = Array.from(root.querySelectorAll(selector));
    return {
      count: matches.length,
      exactTarget: matches.length === 1 && matches[0] === target,
    };
  } catch (_) {
    return { count: null, exactTarget: false };
  }
}

function normalizeBackendNodeId(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

/**
 * Generate bounded CSS fallback candidates inside the target's document,
 * frame document, scoped root, or open shadow root. Candidates are returned
 * only when the local DOM proves count=1 and the sole match is the acted node.
 * CDP must still verify backendNodeId before promotion to a reliable locator.
 */
function generateDeterministicCssCandidates(
  target,
  {
    root = null,
    backendNodeId = null,
    maxResults = DEFAULT_MAX_RESULTS,
    maxCandidates = DEFAULT_MAX_CANDIDATES,
    maxCombinations = DEFAULT_MAX_COMBINATIONS,
    blacklist = [],
    whitelist = [],
  } = {},
) {
  if (!target || target.nodeType !== 1) return [];
  const selectorRoot = defaultSelectorRoot(target, root);
  if (!canQuery(selectorRoot)) return [];
  const boundedResults = Math.max(1, Math.min(25, Number(maxResults) || DEFAULT_MAX_RESULTS));
  const options = {
    selectors: ['id', 'attribute', 'class', 'tag', 'nthoftype', 'nthchild'],
    root: selectorRoot,
    maxResults: boundedResults,
    maxCandidates: Math.max(50, Math.min(5_000, Number(maxCandidates) || DEFAULT_MAX_CANDIDATES)),
    maxCombinations: Math.max(
      100,
      Math.min(20_000, Number(maxCombinations) || DEFAULT_MAX_COMBINATIONS),
    ),
    combineWithinSelector: true,
    combineBetweenSelectors: true,
    includeTag: false,
    ignoreGeneratedClassNames: true,
    useScope: selectorRoot.nodeType === 1,
    whitelist: Array.isArray(whitelist) ? whitelist : [],
    blacklist: [isGeneratedOrUnstableSelector, ...(Array.isArray(blacklist) ? blacklist : [])],
  };

  const seen = new Set();
  const candidates = [];
  try {
    for (const rawSelector of cssSelectorGenerator(target, options)) {
      const selector = cleanText(rawSelector, 1_000);
      if (!selector || seen.has(selector)) continue;
      seen.add(selector);
      const proof = queryExactTarget(selectorRoot, selector, target);
      if (proof.count !== 1 || proof.exactTarget !== true) continue;
      candidates.push({
        selector,
        strategy: 'generated_css',
        rank: candidates.length + 1,
        generatedBy: 'css-selector-generator',
        localDomProof: proof,
        backendNodeId: normalizeBackendNodeId(backendNodeId),
        backendNodeVerified: false,
        requiresBackendNodeVerification: true,
        structuralFallback: /:nth-(?:child|of-type)\(/.test(selector),
      });
      if (candidates.length >= boundedResults) break;
    }
  } catch (_) {
    return [];
  }
  return candidates;
}

function roleMapFor(container, target) {
  const roleContainer = container && container.nodeType === 9 ? container.body : container;
  if (!roleContainer || typeof roleContainer.querySelectorAll !== 'function') return [];
  try {
    const roles = getRoles(roleContainer);
    return Object.entries(roles)
      .filter(([, elements]) => Array.isArray(elements) && elements.includes(target))
      .map(([role]) => role)
      .sort();
  } catch (_) {
    return [];
  }
}

function suggestedQuery(target, method) {
  try {
    const suggestion = getSuggestedQuery(target, 'get', method);
    if (!suggestion) return null;
    return {
      method: suggestion.queryMethod || method || null,
      name: suggestion.queryName || null,
      args: Array.isArray(suggestion.queryArgs) ? suggestion.queryArgs : [],
      variant: suggestion.variant || 'get',
    };
  } catch (_) {
    return null;
  }
}

function elementLabels(target) {
  const labels = target && target.labels ? Array.from(target.labels) : [];
  return Array.from(new Set(labels.map((label) => cleanText(label.textContent)).filter(Boolean)));
}

/**
 * Independent Testing Library cross-check for whether a native semantic
 * Playwright locator is appropriate. CDP accessibility data remains the
 * authoritative identity source; this helper supplies a deterministic check.
 */
function crossCheckElementSemantics(container, target) {
  if (!target || target.nodeType !== 1) {
    return {
      exposed: false,
      roles: [],
      primaryRole: null,
      labels: [],
      placeholder: null,
      testIds: {},
      suggestions: {},
      semanticLocatorAppropriate: false,
    };
  }
  let inaccessible = true;
  try {
    inaccessible = isInaccessible(target);
  } catch (_) {}
  const roles = roleMapFor(container || target.ownerDocument, target);
  const labels = elementLabels(target);
  const testIds = {};
  for (const attribute of ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-pw']) {
    const value = cleanText(target.getAttribute && target.getAttribute(attribute));
    if (value) testIds[attribute] = value;
  }
  const suggestions = {
    role: suggestedQuery(target, 'Role'),
    label: suggestedQuery(target, 'LabelText'),
    placeholder: suggestedQuery(target, 'PlaceholderText'),
    testId: suggestedQuery(target, 'TestId'),
  };
  for (const key of Object.keys(suggestions)) {
    if (!suggestions[key]) delete suggestions[key];
  }
  return {
    exposed: !inaccessible,
    roles,
    primaryRole: roles[0] || null,
    labels,
    placeholder: cleanText(target.getAttribute && target.getAttribute('placeholder')) || null,
    testIds,
    suggestions,
    semanticLocatorAppropriate:
      !inaccessible && (roles.length > 0 || labels.length > 0 || !!Object.keys(testIds).length),
  };
}

let browserBundleCache = null;

function browserBundleSources() {
  if (browserBundleCache) return browserBundleCache;
  const cssBundlePath = require.resolve('css-selector-generator');
  const testingLibraryEntry = require.resolve('@testing-library/dom');
  const testingLibraryBundlePath = path.join(path.dirname(testingLibraryEntry), '@testing-library', 'dom.umd.js');
  browserBundleCache = {
    cssSelectorGenerator: fs.readFileSync(cssBundlePath, 'utf8'),
    testingLibraryDom: fs.readFileSync(testingLibraryBundlePath, 'utf8'),
  };
  return browserBundleCache;
}

async function ensureLiveAnalysisLibraries(frame) {
  if (!frame || typeof frame.evaluate !== 'function') {
    return { ok: false, reason: 'playwright_frame_unavailable' };
  }
  const status = async () => await frame.evaluate(() => ({
    cssSelectorGenerator: typeof globalThis.CssSelectorGenerator?.cssSelectorGenerator === 'function',
    testingLibraryDom: typeof globalThis.TestingLibraryDom?.getRoles === 'function'
      && typeof globalThis.TestingLibraryDom?.getSuggestedQuery === 'function'
      && typeof globalThis.TestingLibraryDom?.isInaccessible === 'function',
  }));
  let available = await status().catch(() => ({ cssSelectorGenerator: false, testingLibraryDom: false }));
  const bundles = browserBundleSources();
  if (!available.cssSelectorGenerator) {
    await frame.evaluate(`(() => { ${bundles.cssSelectorGenerator}\n; return true; })()`);
  }
  if (!available.testingLibraryDom) {
    await frame.evaluate(`(() => { ${bundles.testingLibraryDom}\n; return true; })()`);
  }
  available = await status().catch(() => ({ cssSelectorGenerator: false, testingLibraryDom: false }));
  return {
    ok: available.cssSelectorGenerator && available.testingLibraryDom,
    ...available,
    reason: available.cssSelectorGenerator && available.testingLibraryDom ? null : 'browser_analysis_library_unavailable',
  };
}

function browserAnalyzeTarget(element, limits = {}) {
  const clean = (value, max = 500) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
  const selectorApi = globalThis.CssSelectorGenerator;
  const testing = globalThis.TestingLibraryDom;
  if (!element || element.nodeType !== 1 || typeof selectorApi?.cssSelectorGenerator !== 'function'
    || typeof testing?.getRoles !== 'function' || typeof testing?.getSuggestedQuery !== 'function'
    || typeof testing?.isInaccessible !== 'function') {
    return { schema: 'qaai-live-locator-analysis/1', ok: false, reason: 'analysis_library_unavailable' };
  }
  const maxResults = Math.max(1, Math.min(12, Number(limits.maxResults) || 8));
  const maxCandidates = Math.max(50, Math.min(5_000, Number(limits.maxCandidates) || 500));
  const maxCombinations = Math.max(100, Math.min(20_000, Number(limits.maxCombinations) || 2_000));
  const unstable = (selector) => {
    const raw = String(selector || '');
    const value = raw.replace(/^[.#]/, '').replace(/^\[[^=\]]+=["']?/, '').replace(/["']?\]$/, '');
    return /(?:^|[-_])(?:css|emotion|makeStyles|mui|sc|styled|jsx)[-_][a-z0-9]{5,}$/i.test(value)
      || /(?:^|[-_])[a-f0-9]{8,}(?:[-_]|$)/i.test(value)
      || /(?:^|[-_])\d{7,}(?:[-_]|$)/.test(value);
  };
  const generate = (target, root = null, resultLimit = maxResults) => {
    const selectorRoot = root || target.getRootNode();
    try {
      return Array.from(selectorApi.cssSelectorGenerator(target, {
        selectors: ['id', 'attribute', 'class', 'tag', 'nthoftype', 'nthchild'],
        root: selectorRoot,
        maxResults: resultLimit,
        maxCandidates,
        maxCombinations,
        combineWithinSelector: true,
        combineBetweenSelectors: true,
        includeTag: false,
        ignoreGeneratedClassNames: true,
        useScope: selectorRoot?.nodeType === 1,
        blacklist: [unstable],
      })).filter((selector) => {
        try {
          const matches = Array.from(selectorRoot.querySelectorAll(selector));
          return matches.length === 1 && matches[0] === target;
        } catch (_) {
          return false;
        }
      }).slice(0, resultLimit);
    } catch (_) {
      return [];
    }
  };
  const root = element.getRootNode();
  const roleContainer = root?.nodeType === 9 ? root.body : root;
  let roles = [];
  try {
    roles = Object.entries(testing.getRoles(roleContainer))
      .filter(([, elements]) => Array.isArray(elements) && elements.includes(element))
      .map(([role]) => role);
  } catch (_) {}
  let inaccessible = true;
  try {
    inaccessible = testing.isInaccessible(element);
  } catch (_) {}
  const suggestion = (method) => {
    try {
      const value = testing.getSuggestedQuery(element, 'get', method);
      return value ? {
        method: value.queryMethod || method,
        name: value.queryName || null,
        args: Array.isArray(value.queryArgs) ? value.queryArgs : [],
      } : null;
    } catch (_) {
      return null;
    }
  };
  const testIds = {};
  for (const attribute of ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-pw']) {
    const value = clean(element.getAttribute(attribute));
    if (value) testIds[attribute] = value;
  }
  const stableAttributes = {};
  for (const attribute of ['id', 'name', 'autocomplete', 'title', 'type', 'aria-label', 'aria-labelledby']) {
    const value = clean(element.getAttribute(attribute));
    if (value && !unstable(`[${attribute}=${JSON.stringify(value)}]`)) stableAttributes[attribute] = value;
  }
  const labels = Array.from(element.labels || []).map((label) => clean(label.textContent)).filter(Boolean);
  const scopes = [];
  let ancestor = element.parentElement;
  while (ancestor && scopes.length < 4) {
    const selectors = generate(ancestor, ancestor.getRootNode(), 1);
    if (selectors[0] && !/:nth-(?:child|of-type)\(/.test(selectors[0])) scopes.push(selectors[0]);
    ancestor = ancestor.parentElement;
  }
  const shadowHosts = [];
  let currentRoot = root;
  while (typeof ShadowRoot !== 'undefined' && currentRoot instanceof ShadowRoot && currentRoot.host) {
    const host = currentRoot.host;
    const selector = generate(host, host.getRootNode(), 1)[0] || null;
    if (!selector) break;
    shadowHosts.unshift(selector);
    currentRoot = host.getRootNode();
  }
  const xpathLiteral = (value) => {
    const raw = String(value);
    if (!raw.includes("'")) return `'${raw}'`;
    if (!raw.includes('"')) return `"${raw}"`;
    return `concat(${raw.split("'").map((part, index) => `${index ? `,"'",` : ''}'${part}'`).join('')})`;
  };
  const xpath = (() => {
    if (shadowHosts.length) return null;
    const id = clean(element.getAttribute('id'));
    if (id && !unstable(`#${id}`)) return `//*[@id=${xpathLiteral(id)}]`;
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < 24) {
      const tag = node.localName;
      const siblings = node.parentElement ? Array.from(node.parentElement.children).filter((child) => child.localName === tag) : [];
      const index = siblings.length > 1 ? `[${siblings.indexOf(node) + 1}]` : '';
      parts.unshift(`${tag}${index}`);
      node = node.parentElement;
    }
    return parts.length ? `/${parts.join('/')}` : null;
  })();
  return {
    schema: 'qaai-live-locator-analysis/1',
    ok: true,
    exposed: !inaccessible,
    roles,
    labels: Array.from(new Set(labels)),
    placeholder: clean(element.getAttribute('placeholder')) || null,
    testIds,
    stableAttributes,
    suggestions: {
      role: suggestion('Role'),
      label: suggestion('LabelText'),
      placeholder: suggestion('PlaceholderText'),
      testId: suggestion('TestId'),
    },
    generatedCss: generate(element),
    scopeSelectors: Array.from(new Set(scopes)),
    shadowHostSelectors: shadowHosts,
    xpath,
  };
}

async function analyzeLiveTarget({ frame, locator, maxResults, maxCandidates, maxCombinations } = {}) {
  if (!locator || typeof locator.evaluate !== 'function') {
    return { schema: LIVE_ANALYSIS_SCHEMA, ok: false, reason: 'playwright_locator_unavailable' };
  }
  const libraries = await ensureLiveAnalysisLibraries(frame);
  if (!libraries.ok) return { schema: LIVE_ANALYSIS_SCHEMA, ok: false, reason: libraries.reason, libraries };
  try {
    const analysis = await locator.evaluate(browserAnalyzeTarget, { maxResults, maxCandidates, maxCombinations });
    return { ...analysis, libraries };
  } catch (error) {
    return {
      schema: LIVE_ANALYSIS_SCHEMA,
      ok: false,
      reason: 'live_target_analysis_failed',
      detail: cleanText(error?.message || error, 1_000),
      libraries,
    };
  }
}

function cssAttributeSelector(name, value) {
  const attribute = String(name || '').replace(/[^a-zA-Z0-9_:-]/g, '');
  return attribute && value != null ? `[${attribute}=${JSON.stringify(String(value))}]` : null;
}

function suggestionMethodMatches(suggestion, kind) {
  const method = cleanText(suggestion?.method || suggestion?.name).toLowerCase();
  if (!method) return false;
  if (kind === 'role') return method.includes('role');
  if (kind === 'label') return method.includes('label');
  if (kind === 'placeholder') return method.includes('placeholder');
  return false;
}

function semanticValueMatches(actual, expected) {
  const expectedText = cleanText(expected).toLowerCase();
  if (!expectedText || actual == null) return false;
  if (actual instanceof RegExp) {
    actual.lastIndex = 0;
    return actual.test(String(expected));
  }
  if (actual && typeof actual === 'object') {
    const source = cleanText(actual.source);
    if (source) {
      try {
        return new RegExp(source, cleanText(actual.flags)).test(String(expected));
      } catch (_) {}
    }
  }
  const actualText = cleanText(actual).toLowerCase();
  if (!actualText) return false;
  return actualText === expectedText
    || actualText.includes(expectedText)
    || expectedText.includes(actualText);
}

/**
 * Testing Library is an independent semantic validator, not an annotation.
 * Promote role/label/placeholder candidates only when it agrees with the
 * query kind and value for the exact acted node.
 */
function testingLibraryConfirmsSemanticCandidate(analysis, candidate) {
  if (!analysis || analysis.exposed === false || !candidate?.strategy) return false;
  const suggestion = analysis.suggestions?.[candidate.strategy];
  if (!suggestionMethodMatches(suggestion, candidate.strategy)) return false;
  const args = Array.isArray(suggestion.args) ? suggestion.args : [];

  if (candidate.strategy === 'role') {
    const roles = Array.isArray(analysis.roles)
      ? analysis.roles.map((value) => cleanText(value).toLowerCase()).filter(Boolean)
      : [];
    if (!roles.includes(cleanText(candidate.role).toLowerCase())) return false;
    if (!semanticValueMatches(args[0], candidate.role)) return false;
    const suggestedName = args[1] && typeof args[1] === 'object' ? args[1].name : null;
    return suggestedName == null || semanticValueMatches(suggestedName, candidate.name);
  }

  if (candidate.strategy === 'label') {
    const labels = Array.isArray(analysis.labels) ? analysis.labels : [];
    return labels.some((label) => semanticValueMatches(label, candidate.text))
      && semanticValueMatches(args[0], candidate.text);
  }

  if (candidate.strategy === 'placeholder') {
    return semanticValueMatches(analysis.placeholder, candidate.text)
      && semanticValueMatches(args[0], candidate.text);
  }

  return false;
}

function buildAuthoritativeCandidateDescriptors({ analysis = {}, capture = {} } = {}) {
  if (!analysis?.ok || !capture?.captured || !capture?.identity?.backendNodeId) return [];
  const out = [];
  const seen = new Set();
  const add = (candidate) => {
    if (!candidate || !candidate.strategy) return;
    const key = JSON.stringify(candidate);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(candidate);
  };
  for (const attribute of ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-pw']) {
    const value = cleanText(analysis.testIds?.[attribute]);
    if (value) add({ strategy: 'testid', attribute, value, priority: 1 });
  }
  const role = cleanText(capture.accessibility?.role).toLowerCase();
  const name = cleanText(capture.accessibility?.name);
  const roleCandidate = { strategy: 'role', role, name, exact: true };
  const roleConfirmed = role && name && testingLibraryConfirmsSemanticCandidate(analysis, roleCandidate);
  if (roleConfirmed) add({ ...roleCandidate, priority: 2, semanticCrossCheck: true });
  const confirmedLabels = [];
  for (const label of analysis.labels || []) {
    const text = cleanText(label);
    const labelCandidate = { strategy: 'label', text, exact: true };
    if (!text || !testingLibraryConfirmsSemanticCandidate(analysis, labelCandidate)) continue;
    confirmedLabels.push(text);
    add({ ...labelCandidate, priority: 3, semanticCrossCheck: true });
  }
  const placeholderCandidate = {
    strategy: 'placeholder',
    text: cleanText(analysis.placeholder),
    exact: true,
  };
  if (placeholderCandidate.text && testingLibraryConfirmsSemanticCandidate(analysis, placeholderCandidate)) {
    add({ ...placeholderCandidate, priority: 4, semanticCrossCheck: true });
  }
  const ignoredStable = new Set(['aria-label', 'aria-labelledby', 'placeholder', 'role']);
  for (const [attribute, value] of Object.entries(analysis.stableAttributes || {})) {
    if (ignoredStable.has(attribute)) continue;
    const selector = cssAttributeSelector(attribute, value);
    if (selector && !isGeneratedOrUnstableSelector(selector)) add({ strategy: 'stable_attribute', selector, priority: 5 });
  }
  for (const scopeSelector of analysis.scopeSelectors || []) {
    if (roleConfirmed) add({ strategy: 'scoped_semantic', scopeSelector, semantic: roleCandidate, semanticCrossCheck: true, priority: 6 });
    for (const label of confirmedLabels) add({ strategy: 'scoped_semantic', scopeSelector, semantic: { strategy: 'label', text: label, exact: true }, semanticCrossCheck: true, priority: 6 });
  }
  for (const selector of analysis.generatedCss || []) {
    add({
      strategy: 'generated_css',
      selector: cleanText(selector, 1_000),
      shadowHostSelectors: (analysis.shadowHostSelectors || []).map((item) => cleanText(item, 1_000)).filter(Boolean),
      generatedBy: 'css-selector-generator',
      priority: 7,
    });
  }
  if (analysis.xpath && !(analysis.shadowHostSelectors || []).length) {
    add({ strategy: 'verified_xpath', selector: `xpath=${analysis.xpath}`, exceptional: true, priority: 8 });
  }
  return out.sort((a, b) => a.priority - b.priority);
}

module.exports = {
  DEFAULT_MAX_RESULTS,
  LIVE_ANALYSIS_SCHEMA,
  STABLE_ATTRIBUTE_NAMES,
  isGeneratedOrUnstableSelector,
  generateDeterministicCssCandidates,
  crossCheckElementSemantics,
  browserBundleSources,
  ensureLiveAnalysisLibraries,
  analyzeLiveTarget,
  testingLibraryConfirmsSemanticCandidate,
  buildAuthoritativeCandidateDescriptors,
};
