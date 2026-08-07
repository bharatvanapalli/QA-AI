'use strict';
/**
 * Class G — deterministic Page-Object / locator-repository core (AS_IS_FIDELITY_PLAN §4).
 *
 * PURE. Given the run's cases (each with a pinned ReplayIR), produce:
 *   - a per-page locator repository keyed by SEMANTIC name (G.4 naming, G.9 splitter),
 *   - holding the EXACT approved action-time locator (guardrail 1 — never re-derived: we reuse
 *     the same normalizeCandidates + selectStaticLocator the inline emit uses),
 *   - merged by a deterministic idempotent union: same name → same expression = reuse;
 *     same name → DIFFERENT expression = CONFLICT (surface both, never silently pick) — guardrail 2.
 *
 * No framework emission here (that is phase 2). No site-specific page names anywhere — every
 * page key is derived from normalizedUrl (+ an optional calibrator page-role), per §4.9.
 */
const { normalizeCandidates } = require('./adapters/_candidateNormalize');
const { selectStaticCandidate, selectStaticLocator } = require('./adapters/playwrightReference');
const actionLocatorResolver = require('../actionLocatorResolver');

// Framework-universal path noise ONLY (no site-specific names). §4.9.
const UNIVERSAL_NOISE = new Set(['index', 'default', 'view', 'php', 'html']);
const WEB_EXT = /\.(php|html?|aspx?|jsp|do|action)$/i;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const TEMPLATE_VALUE_RE = /\{\{[^{}]+\}\}|\$\{[^{}]+\}/g;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
// Keep this in lockstep with the locator-backed action verbs supported by the
// POM emitter.  A repository entry for an authored action prevents the POM
// layer from falling back to an inline/reference emitter merely because a
// legacy ReplayIR omitted a preceding resolve step.
const LOCATOR_BACKED_ACTIONS = new Set([
  'fill', 'type', 'click', 'doubleClick', 'tripleClick', 'selectOption',
  'check', 'uncheck', 'press', 'hover', 'drag', 'upload',
]);
const PAGE_LEVEL_ACTIONS = new Set([
  'navigate', 'navigateBack', 'navigateForward', 'reload', 'handleDialog', 'resize', 'close',
]);
const GENERIC_PAGE_BASES = new Set([
  'application', 'root', 'authorize', 'authorization', 'captured', 'page', 'screen',
]);
const OPAQUE_SEMANTIC_SEED_RE = /^(?:(?:el|act)(?:element|target|node|ref|control)?\d*|(?:element|target|node|ref|control|selector|unknown|button|link|field|input|textbox)\d*)$/i;

function stripExt(seg) { return String(seg).replace(WEB_EXT, ''); }
function collapseDynamic(seg) {
  if (/^\d+$/.test(seg)) return ':id';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':id';
  if (/^[0-9a-f]{16,}$/i.test(seg)) return ':id';
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*-\d+$/i.test(seg)) return ':id';
  if (/^(?:ord|order|inv|invoice|po|so|req|ticket|case)(?:[-_][a-z0-9]*\d|\d[a-z0-9]*)$/i.test(seg)) return ':id';
  if (!WEB_EXT.test(seg) && /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/i.test(seg)) return ':id';
  return seg;
}

// key(action): collapse dynamic segments, strip web extensions, drop universal noise. §4.9
function pageKey(url) {
  let pathname;
  try {
    const parsed = new URL(String(url || ''));
    const protocol = String(parsed.protocol || '').toLowerCase();
    // Inline browser documents do not have a meaningful route pathname. Using
    // their payload as a route leaks encoded content into public POM identifiers
    // and can make independently generated references disagree.
    if (protocol === 'data:') return 'inline-document';
    if (protocol === 'blob:') return 'blob-document';
    if (protocol === 'about:') {
      const aboutPage = String(parsed.pathname || '').replace(/^\/+/, '').trim().toLowerCase();
      return aboutPage === 'blank' || !aboutPage ? 'blank-page' : `about-${aboutPage}`;
    }
    pathname = parsed.pathname;
  } catch {
    pathname = String(url || '').replace(/[#?].*$/, '');
  }
  const segs = pathname.split('/').map((s) => s.trim()).filter(Boolean)
    .map(collapseDynamic).map(stripExt)
    .filter((s) => s && !UNIVERSAL_NOISE.has(s.toLowerCase()));
  return segs.join('/') || 'root';
}

function camel(input) {
  const words = String(input || '').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  return words.map((word, index) => {
    const allUpper = /^[A-Z0-9]+$/.test(word);
    const intentionalMixedCase = /[a-z][A-Z]/.test(word);
    const normalized = allUpper
      ? word.toLowerCase()
      : intentionalMixedCase
        ? word
        : word.toLowerCase();
    return index === 0
      ? normalized.charAt(0).toLowerCase() + normalized.slice(1)
      : normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }).join('');
}

function escapedRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeSemanticText(value, dynamicValues = []) {
  let text = String(value == null ? '' : value)
    .replace(URL_RE, ' ')
    .replace(EMAIL_RE, ' ')
    .replace(UUID_RE, ' ')
    .replace(TEMPLATE_VALUE_RE, ' ')
    .replace(PHONE_RE, ' ');
  for (const runtimeValue of Array.from(new Set(dynamicValues.map((item) => String(item == null ? '' : item).trim()).filter((item) => item.length >= 3))).sort((a, b) => b.length - a.length)) {
    text = text.replace(new RegExp(escapedRegExp(runtimeValue), 'gi'), ' ');
  }
  return text.replace(/^\s*(?:enter|type|fill|provide|input)\s+(?:(?:your|the|a|an)\s+)?/i, '')
    .replace(/\b(?:for|of|with|using|as|to)\s*$/gi, ' ')
    .replace(/[^A-Za-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function safeCamel(value, dynamicValues = []) {
  return camel(sanitizeSemanticText(value, dynamicValues));
}

function opaqueSemanticSeed(value) {
  const compact = String(value == null ? '' : value).replace(/[^A-Za-z0-9]/g, '');
  return !compact
    || OPAQUE_SEMANTIC_SEED_RE.test(compact)
    || /^\d+$/.test(compact)
    || /\d{5,}/.test(compact)
    || /^[a-f0-9]{16,}$/i.test(compact);
}

function readableSemanticSeed(values, dynamicValues = []) {
  for (const value of values || []) {
    const text = sanitizeSemanticText(value, dynamicValues).replace(/\b\d+\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (text && !opaqueSemanticSeed(text)) return text;
  }
  return null;
}

// Skip `:id` sentinels (collapsed dynamic segments like /items/42 → /items/:id).
// Taking `:id` as the page name produces `IdPage` — meaningless and machine-fingerprinted.
// Walk backwards through the segments to find the first non-:id meaningful part.
function lastMeaningfulSegment(key) {
  const p = String(key || '').split('/').filter((s) => s && s !== ':id' && s !== 'root');
  return p[p.length - 1] || 'application';
}

function routePageLabel(key) {
  const segments = String(key || '')
    .split('/')
    .filter((segment) => segment && segment !== ':id' && segment !== 'root');
  const leaf = String(segments[segments.length - 1] || 'application').toLowerCase();
  const resource = segments.length > 1 ? segments[segments.length - 2] : null;
  return resource && /^(?:create|new|edit|update|details?|view)$/i.test(leaf)
    ? `${leaf} ${resource}`
    : lastMeaningfulSegment(key);
}

// Root routes do not contain enough information to name a page. For the
// standard Playwright POM JavaScript profile only, retain the observed host as
// the final deterministic context before falling back to WorkspacePage. This
// keeps a journey rooted at https://qa.example-product.com/ domain-specific
// without allowing hostnames to override meaningful authored routes or titles.
const GENERIC_HOST_LABEL_PARTS = new Set([
  'www', 'app', 'apps', 'web', 'portal', 'qa', 'uat', 'stage', 'staging',
  'dev', 'test', 'local', 'localhost', 'com', 'net', 'org', 'io', 'co',
]);

function observedHostPageLabel(url) {
  try {
    const parts = new URL(String(url || '')).hostname
      .toLowerCase()
      .split('.')
      .filter((part) => part && !GENERIC_HOST_LABEL_PARTS.has(part));
    const label = parts[parts.length - 1] || '';
    return label && /[a-z]/i.test(label)
      ? label.replace(/[^a-z0-9]+/gi, ' ').trim()
      : null;
  } catch {
    return null;
  }
}

function contextualPageLabel(url, key, preferred, enabled = false) {
  if (preferred) return preferred;
  if (!enabled || lastMeaningfulSegment(key) !== 'application') return null;
  return observedHostPageLabel(url);
}

// Canonicalize a locator expression string before equality comparison.
// Collapses redundant whitespace and normalises quote style (single→double) so
// trivially-different forms of the same logical locator do not produce false conflicts.
function canonicalizeExpr(expr) {
  return String(expr || '').replace(/\s+/g, ' ').replace(/'/g, '"').trim();
}

function exactActionLocatorExpr(step) {
  const actionLocator = step && step.actionLocator && typeof step.actionLocator === 'object'
    ? step.actionLocator
    : null;
  if (!actionLocator) return null;
  // Executable POM locators require positive same-node browser proof. A locator
  // that is merely serializable/export-safe is evidence, not runnable code.
  if (!actionLocatorResolver.isVerifiedActionLocator(actionLocator)) return null;
  const primary = actionLocatorResolver.primaryActionLocator(actionLocator);
  const raw = primary?.frameworkExpressions?.playwright || primary?.expression || actionLocator.frameworkExpressions?.playwright || actionLocator.expression || null;
  const expr = String(raw || '').trim();
  if (!expr || !actionLocatorResolver.locatorExpressionIsExportSafe(expr)) return null;
  if (/^getByRole\(\s*["'][^"']+["']\s*\)$/i.test(expr)) return null;
  if (/^page\./.test(expr)) return expr;
  if (/^(getByRole|getByLabel|getByPlaceholder|getByText|getByTestId|getByAltText|getByTitle|locator|frameLocator)\s*\(/.test(expr)) {
    return `page.${expr}`;
  }
  return null;
}

function parseLiteralArg(expr, method) {
  const pattern = new RegExp(`${method}\\(\\s*["']([^"']*)["']`);
  const match = String(expr || '').match(pattern);
  return match ? match[1] : null;
}

function uniquenessFinding(expr) {
  const normalized = canonicalizeExpr(expr);
  if (!normalized) return null;
  if (/getByRole\(\s*"[^"]+"\s*\)/.test(normalized)) {
    return {
      rule: 'uniqueness_unverified',
      severity: 'warning',
      reason: 'role locator has no accessible name qualifier',
    };
  }
  const text = parseLiteralArg(normalized, 'getByText');
  if (text != null && text.trim().length <= 3) {
    return {
      rule: 'uniqueness_unverified',
      severity: 'warning',
      reason: 'text locator uses a very short visible string',
    };
  }
  return null;
}

function manifestEntry(step, file, name, expr, key, finding, source = 'candidates', caseKey = null) {
  const entry = { as: step.as, file, name, expr, pageKey: key, source, ...(caseKey ? { caseKey } : {}) };
  const immutableIdentity = {
    contractStepId: step?.contractStepId || step?.sourceContractStepId || null,
    actionOccurrenceId: step?.actionOccurrenceId || step?.actionIdentity?.actionOccurrenceId || null,
    authoredActionId: step?.authoredActionId || step?.actionIdentity?.authoredActionId || null,
    occurrenceKey: step?.occurrenceKey || step?.actionIdentity?.occurrenceKey || null,
  };
  for (const [field, value] of Object.entries(immutableIdentity)) {
    if (value != null && String(value).trim()) entry[field] = value;
  }
  if (source === 'actionLocator' && step && step.actionLocator) {
    const primary = actionLocatorResolver.primaryActionLocator(step.actionLocator);
    entry.verificationSource = primary?.verificationSource || primary?.evidenceSource || primary?.proof?.source || null;
    entry.evidenceSource = primary?.evidenceSource || primary?.verificationSource || primary?.proof?.source || null;
    entry.verified = actionLocatorResolver.isVerifiedActionLocator(step.actionLocator);
    entry.verificationStatus = entry.verified ? 'verified' : 'unverified';
    if (primary?.proof && typeof primary.proof === 'object') {
      // Preserve the browser-authored proof as evidence. Do not reconstruct or
      // upgrade it from the Boolean verification result: readiness must be able
      // to prove that this exact emitted locator resolved one exact action-time
      // DOM/backend node.
      entry.proof = primary.proof;
    }
    entry.locatorProvenance = step.locatorProvenance || null;
  }
  if (finding) {
    entry.findings = [{ ...finding }];
    entry.uniqueness = 'unverified';
  }
  if (source !== 'actionLocator') {
    entry.verified = false;
    entry.confidence = 'unverified_guess';
    entry.warning = step?.locatorProvenance?.warning || null;
    entry.provenance = step?.locatorProvenance || null;
  }
  return entry;
}

function repositoryCaseKey(caseItem, index) {
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

function semanticCaseSuffix(caseItem) {
  const ir = caseItem && caseItem.ir && typeof caseItem.ir === 'object' ? caseItem.ir : {};
  const raw = caseItem && (caseItem.caseName || caseItem.testCaseName || caseItem.name)
    || ir.title
    || 'alternate flow';
  const value = camel(raw);
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : 'AlternateFlow';
}

function conflictSafeName(fileEntries, baseName, caseItem, candidate, expr) {
  const existing = fileEntries[baseName];
  if (!existing || canonicalizeExpr(existing.expr) === canonicalizeExpr(expr)) return baseName;
  const selectorSuffix = camel(selectorTailName(candidate && candidate.selector));
  const candidates = [
    `${baseName}For${semanticCaseSuffix(caseItem)}`,
    selectorSuffix ? `${baseName}In${selectorSuffix.charAt(0).toUpperCase() + selectorSuffix.slice(1)}` : null,
    `${baseName}Alternate`,
    `${baseName}Secondary`,
    `${baseName}Additional`,
  ].filter(Boolean);
  for (const name of candidates) {
    const current = fileEntries[name];
    if (!current || canonicalizeExpr(current.expr) === canonicalizeExpr(expr)) return name;
  }
  // Extremely unusual repeated ambiguity: retain a readable semantic suffix instead of
  // leaking an internal id, UUID, or arbitrary numeric counter into the public API.
  let name = `${baseName}For${semanticCaseSuffix(caseItem)}Alternative`;
  while (fileEntries[name] && canonicalizeExpr(fileEntries[name].expr) !== canonicalizeExpr(expr)) {
    name += 'Alternative';
  }
  return name;
}

// fileName(key): PREFER the calibrator's classified page role, else the route leaf. §4.9
function pageFileName(key, calibratorPageRole) {
  const routeLeaf = String(lastMeaningfulSegment(key) || '').toLowerCase();
  let base = calibratorPageRole && String(calibratorPageRole).trim()
    ? safeCamel(calibratorPageRole)
    : safeCamel(routePageLabel(key));
  if (!base || GENERIC_PAGE_BASES.has(base.toLowerCase())) {
    base = /^(?:auth|authenticate|authentication|authorize|authorization|login|oauth|oidc|signin|signon|sso)$/i.test(routeLeaf)
      ? 'authentication'
      : 'workspace';
  }
  return `${base}Page`;
}

function operationSignature(step, action) {
  return JSON.stringify([
    action,
    step && (step.url || step.href || step.destination || null),
    step && step.accept === false ? false : true,
    step && step.promptText != null ? String(step.promptText) : null,
    Number(step && (step.width || step.viewport?.width)) || null,
    Number(step && (step.height || step.viewport?.height)) || null,
  ]);
}

function operationSemanticName(step, action, key, pageLabel = null) {
  if (action === 'navigate') {
    const authored = readableSemanticSeed([
      step && (step.expectedPageTitle || step.pageTitle || step.authoredPageName || step.semanticPageName),
      pageLabel,
      routePageLabel(key),
    ]);
    return safeCamel(authored || 'destination');
  }
  if (action === 'navigateBack') return 'previousPage';
  if (action === 'navigateForward') return 'nextPage';
  if (action === 'handleDialog') return step && step.accept === false ? 'nextDialogDismissal' : 'nextDialogAcceptance';
  if (action === 'resize') return 'viewport';
  if (action === 'close') return 'currentPage';
  return safeCamel(action) || 'browserOperation';
}

function allocateOperationName(perFile, baseName, signature) {
  const known = perFile.get(signature);
  if (known) return known;
  const occupied = new Set(perFile.values());
  let name = baseName || 'browserOperation';
  for (const suffix of ['Alternate', 'Secondary', 'Additional']) {
    if (!occupied.has(name)) break;
    name = `${baseName}${suffix}`;
  }
  while (occupied.has(name)) name += 'Alternative';
  perFile.set(signature, name);
  return name;
}

// Mirror selectStaticLocator's strategy priority and return the CHOSEN candidate object, so the
// semantic name is derived from the same evidence the emitted locator uses.
function chooseCandidate(normalized) {
  return selectStaticCandidate(normalized);
}

const ROLE_SUFFIX = {
  button: 'Button', link: 'Link', menuitem: 'MenuItem', tab: 'Tab', checkbox: 'Checkbox',
  radio: 'Radio', combobox: 'Select', option: 'Option', heading: 'Heading', img: 'Image',
  textbox: 'Input', searchbox: 'SearchInput',
};

// G.4 semantic naming — camelCase(accessibleName) + role-derived suffix. Returns null when no
// clean name exists (→ the case's locator evidence is weak; the gate blocks rather than guess).
function semanticName(candidate, dynamicValues = []) {
  if (!candidate) return null;
  const role = String(candidate.role || '').toLowerCase();
  const rawName = candidate.name || candidate.text || candidate.testId || '';
  const baseName = safeCamel(rawName, dynamicValues);
  if (!baseName) return null; // role-only / unnamed → weak evidence, no clean name
  // NB: do NOT collapse all password-ish fields to "passwordInput" — camel(name)+suffix already
  // gives "Password"→passwordInput AND "Confirm Password"→confirmPasswordInput (distinct, no
  // false collision). A greedy collapse here mis-merged them (caught by the conflict guardrail).
  const suffix = ROLE_SUFFIX[role] || (role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Element');
  // avoid double suffix (e.g. name already ends with the suffix word)
  if (baseName.toLowerCase().endsWith(suffix.toLowerCase())) return baseName;
  return baseName + suffix;
}

const ROLE_WORDS = {
  button: ['button', 'control'],
  link: ['link'],
  menuitem: ['menuitem', 'item'],
  tab: ['tab'],
  checkbox: ['checkbox', 'field'],
  radio: ['radio', 'field'],
  combobox: ['select', 'combobox', 'dropdown', 'field'],
  option: ['option'],
  heading: ['heading'],
  img: ['image', 'img'],
  textbox: ['input', 'textbox', 'field'],
  searchbox: ['searchinput', 'searchbox', 'input', 'field'],
};

const GENERIC_SEMANTIC_BASES = new Set([
  'id',
  'dropdowntrigger',
  'trigger',
  'control',
  'element',
  'field',
  'input',
  'button',
  'link',
  'select',
  'option',
  'textbox',
]);

function semanticBaseWithoutRole(value, role) {
  let base = safeCamel(value);
  const words = ROLE_WORDS[String(role || '').toLowerCase()] || [];
  for (const word of words) {
    if (
      base.length > word.length &&
      base.toLowerCase().endsWith(word.toLowerCase())
    ) {
      base = base.slice(0, -word.length);
      break;
    }
  }
  return base;
}

function genericSemanticName(value, role) {
  const base = semanticBaseWithoutRole(value, role).toLowerCase();
  return !base || GENERIC_SEMANTIC_BASES.has(base);
}

function semanticAliasName(value, role, dynamicValues = []) {
  const sanitized = safeCamel(value, dynamicValues);
  if (!sanitized || opaqueSemanticSeed(sanitized)) return null;
  const base = semanticBaseWithoutRole(sanitized, role);
  if (!base || GENERIC_SEMANTIC_BASES.has(base.toLowerCase())) return null;
  const suffix =
    ROLE_SUFFIX[String(role || '').toLowerCase()] ||
    (role ? String(role).charAt(0).toUpperCase() + String(role).slice(1) : 'Element');
  return base + suffix;
}

function selectorTailName(selector) {
  const raw = String(selector || '').trim();
  if (!raw) return '';
  const attr = raw.match(/\[(?:data-testid|data-test|data-qa|aria-label|title|alt|name|id|class)=["']?([^"'\]]+)/i);
  if (attr && attr[1]) return attr[1];
  const id = raw.match(/#([A-Za-z0-9_-]+)/);
  if (id && id[1]) return id[1];
  const klass = raw.match(/\.([A-Za-z0-9_-]+)/);
  if (klass && klass[1]) return klass[1];
  const tag = raw.match(/^([A-Za-z][A-Za-z0-9_-]*)/);
  return tag && tag[1] ? tag[1] : '';
}

function candidateText(candidate) {
  return String(candidate && (candidate.name || candidate.text || candidate.testId || candidate.selector) || '').trim();
}

function stepCandidates(step) {
  const actionLocator = step && step.actionLocator && typeof step.actionLocator === 'object' ? step.actionLocator : null;
  const primary = actionLocator ? actionLocatorResolver.primaryActionLocator(actionLocator) : null;
  const recipe = step && step.locatorRecipe && typeof step.locatorRecipe === 'object' ? step.locatorRecipe : null;
  const raw = [];
  for (const value of [
    step && step.candidates,
    step && step.locatorCandidates,
    actionLocator && actionLocator.candidates,
    primary && primary.candidates,
    recipe && recipe.candidates,
  ]) {
    if (Array.isArray(value)) raw.push(...value);
  }
  for (const value of [primary && primary.candidate, recipe && recipe.candidate]) {
    if (value && typeof value === 'object') raw.push(value);
  }
  return normalizeCandidates(raw);
}

function actionRole(step, candidate) {
  const actionLocator = step && step.actionLocator && typeof step.actionLocator === 'object' ? step.actionLocator : null;
  const primary = actionLocator ? actionLocatorResolver.primaryActionLocator(actionLocator) : null;
  const facts = primary && primary.targetFacts && typeof primary.targetFacts === 'object' ? primary.targetFacts : {};
  return String(candidate?.role || facts.role || step?.role || step?.targetRole || '').toLowerCase();
}

function genericFallbackName(action, role) {
  const suffix = ROLE_SUFFIX[String(role || '').toLowerCase()];
  if (suffix) return `guessed${suffix}`;
  if (['fill', 'type', 'press'].includes(action)) return 'guessedField';
  if (action === 'selectOption') return 'guessedSelect';
  if (['check', 'uncheck'].includes(action)) return 'guessedCheckbox';
  if (action === 'upload') return 'guessedFileInput';
  return 'guessedControl';
}

const PLAYWRIGHT_DETERMINISTIC_LOCATOR_STRATEGIES = [
  'action_time_runtime_evidence',
  'test_id',
  'role_and_accessible_name',
  'associated_label',
  'placeholder',
  'stable_attributes',
  'scoped_semantic_locator',
  'deterministic_css',
];

function explicitLocatorGap(step) {
  return step && step.actionLocatorGap && typeof step.actionLocatorGap === 'object'
    ? step.actionLocatorGap
    : null;
}

function locatorGapProvesExhaustion(step) {
  const gap = explicitLocatorGap(step);
  return !!(gap
    && gap.deterministicEvidenceExhausted === true
    && Array.isArray(gap.strategiesTried)
    && gap.strategiesTried.some((strategy) => String(strategy || '').trim()));
}

function completedActionLocatorGap(step, candidates) {
  const upstream = explicitLocatorGap(step);
  const upstreamAccepted = locatorGapProvesExhaustion(step);
  if (upstreamAccepted) {
    return {
      ...upstream,
      strategiesTried: Array.from(new Set(upstream.strategiesTried.map(String).filter(Boolean))),
      upstreamGapAccepted: true,
    };
  }
  const candidateStrategies = (candidates || [])
    .map((candidate) => candidate && candidate.strategy)
    .filter(Boolean)
    .map(String);
  return {
    code: 'playwright_pom_deterministic_locator_exhausted',
    source: 'playwright_pom_js_repository',
    deterministicEvidenceExhausted: true,
    strategiesTried: Array.from(new Set([
      ...PLAYWRIGHT_DETERMINISTIC_LOCATOR_STRATEGIES,
      ...candidateStrategies,
    ])),
    upstreamGapAccepted: false,
    upstreamGapCode: upstream && upstream.code ? String(upstream.code) : null,
    upstreamGapReason: upstream ? 'incomplete_action_locator_gap' : 'missing_action_locator_gap',
  };
}

function isPasswordIntent(step, normalized) {
  const haystack = [
    step && (step.elementLabel || step.element || step.label || step.name || step.narration),
    ...(Array.isArray(normalized) ? normalized.map(candidateText) : []),
  ].filter(Boolean).join(' ').toLowerCase();
  return /\b(password|passcode|pwd)\b/.test(haystack);
}

function exactPasswordCandidateExpr(step, normalized) {
  if (!isPasswordIntent(step, normalized)) return null;
  const cands = Array.isArray(normalized) ? normalized : [];
  const css = cands.find((c) => c && c.strategy === 'css' && /\binput\s*\[\s*type\s*=\s*["']?password/i.test(String(c.selector || '')));
  if (css && css.selector) return `page.locator(${JSON.stringify(css.selector)})`;
  const specific = cands.find((c) => c && c.strategy === 'label' && c.text)
    || cands.find((c) => c && c.strategy === 'placeholder' && c.text);
  const label = candidateText(specific);
  if (label && !/^password$/i.test(label)) {
    const method = specific.strategy === 'placeholder' ? 'getByPlaceholder' : 'getByLabel';
    return `page.${method}(${JSON.stringify(label)})`;
  }
  if (cands.some((c) =>
    (c && (c.strategy === 'label' || c.strategy === 'placeholder' || c.strategy === 'role') && /password/i.test(candidateText(c)))
  )) {
    return 'page.locator("input[type=\\"password\\"]")';
  }
  return null;
}

function fallbackSemanticName(step, candidate, action = 'click', dynamicValues = []) {
  const actionLocator = step && step.actionLocator && typeof step.actionLocator === 'object' ? step.actionLocator : null;
  const primary = actionLocator ? actionLocatorResolver.primaryActionLocator(actionLocator) : null;
  const facts = primary && primary.targetFacts && typeof primary.targetFacts === 'object' ? primary.targetFacts : {};
  const rawName = readableSemanticSeed([
    step && step.targetLabel,
    step && (step.elementLabel || step.element || step.label || step.name || step.narration),
    actionLocator && actionLocator.elementLabel,
    primary && primary.elementLabel,
    facts.accessibleName,
    facts.text,
    facts.testId,
    facts.placeholder,
    facts.idAttr,
    facts.name,
    selectorTailName(facts.selector || candidate?.selector || primary?.selector || primary?.candidate?.selector),
    step && step.as ? `${action} ${step.as}` : null,
  ], dynamicValues);
  const base = rawName ? safeCamel(rawName, dynamicValues) : '';
  const role = actionRole(step, candidate);
  if (!base || opaqueSemanticSeed(base)) return genericFallbackName(action, role);
  const suffix = ROLE_SUFFIX[role] || (role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Element');
  return base.toLowerCase().endsWith(suffix.toLowerCase()) ? base : base + suffix;
}

function caseDynamicValues(caseItem) {
  const ir = caseItem && caseItem.ir && typeof caseItem.ir === 'object' ? caseItem.ir : {};
  const values = [];
  for (const step of Array.isArray(ir.steps) ? ir.steps : []) {
    if (!step || step.op !== 'act' || !['fill', 'type', 'selectOption', 'press', 'upload'].includes(String(step.action || ''))) continue;
    for (const key of ['rawValue', 'value', 'text', 'inputValue']) {
      if (step[key] != null && typeof step[key] !== 'object') values.push(step[key]);
    }
  }
  for (const source of [ir.inlineValues, ir.testData, caseItem && caseItem.inlineValues]) {
    if (source && typeof source === 'object' && !Array.isArray(source)) values.push(...Object.values(source));
  }
  return values;
}

function semanticPageLabel(step, candidate, { preferCapturedPageIdentity = false } = {}) {
  const primary = step?.actionLocator ? actionLocatorResolver.primaryActionLocator(step.actionLocator) : null;
  const pageIdentity = step?.pageIdentity
    || primary?.pageIdentity
    || primary?.context?.pageIdentity
    || null;
  const explicit = [
    step?.authoredPageName, step?.semanticPageName, step?.pageRole, step?.pageName,
    step?.expectedPage, step?.expectedPageTitle, step?.pageTitle, step?.pageHeading,
    ...(preferCapturedPageIdentity ? [
      // A title captured from the browser is a stable, human-readable page identity.
      // Prefer it over dynamic tenant/record segments when no authored page role exists.
      step?.capturedPageTitle, pageIdentity?.title, pageIdentity?.pageTitle,
      primary?.context?.pageTitle, primary?.domAtlas?.title,
    ] : []),
  ].find((value) => value != null && sanitizeSemanticText(value));
  if (explicit) return explicit;
  if (String(candidate?.role || '').toLowerCase() === 'heading'
      && step?.actionLocator && actionLocatorResolver.isVerifiedActionLocator(step.actionLocator)) {
    return candidate.name || candidate.text || null;
  }
  return null;
}

function namingCandidate(step, fallback) {
  const primary = step?.actionLocator ? actionLocatorResolver.primaryActionLocator(step.actionLocator) : null;
  const facts = primary?.targetFacts && typeof primary.targetFacts === 'object' ? primary.targetFacts : null;
  if (!facts) return fallback;
  const name = facts.accessibleName || facts.label || facts.placeholder || facts.testId || facts.text || null;
  if (!name) return fallback;
  return {
    strategy: facts.role ? 'role' : (facts.label ? 'label' : (facts.placeholder ? 'placeholder' : 'text')),
    role: facts.role || fallback?.role || null,
    name,
    text: facts.label || facts.placeholder || facts.text || null,
    testId: facts.testId || null,
    selector: facts.selector || fallback?.selector || null,
  };
}

function pageContextKey(url, pageLabel) {
  let origin = '';
  try { origin = new URL(String(url || '')).origin; } catch (_) {}
  return `${origin}|${pageKey(url)}|${safeCamel(pageLabel)}`;
}

function allocatePageFile(baseFile, key, contextKey, fileContexts) {
  const occupied = fileContexts.get(baseFile);
  if (!occupied || occupied === contextKey) {
    fileContexts.set(baseFile, contextKey);
    return baseFile;
  }
  const base = baseFile.replace(/Page$/, '') || 'Application';
  const segments = String(key || '').split('/').filter((part) => part && part !== ':id' && part !== 'root');
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const prefix = safeCamel(segments.slice(index, -1).join(' '));
    if (!prefix) continue;
    const candidate = `${prefix.charAt(0).toUpperCase()}${prefix.slice(1)}${base.charAt(0).toUpperCase()}${base.slice(1)}Page`;
    if (!fileContexts.has(candidate) || fileContexts.get(candidate) === contextKey) {
      fileContexts.set(candidate, contextKey);
      return candidate;
    }
  }
  let candidate = `Alternate${base.charAt(0).toUpperCase()}${base.slice(1)}Page`;
  while (fileContexts.has(candidate) && fileContexts.get(candidate) !== contextKey) candidate = `Alternate${candidate}`;
  fileContexts.set(candidate, contextKey);
  return candidate;
}

function materializeRepositoryEntry({ step, alias, action, caseItem, caseKey, currentUrl, dynamicValues, pageRoleFor, preferCapturedPageIdentity, files, conflicts, manifest, diagnostics, fileContexts, referencePages }) {
  const normalized = stepCandidates(step);
  const candidate = chooseCandidate(normalized);
  const rawActionExpr = exactActionLocatorExpr(step);
  const actionLocatorVerified = Boolean(rawActionExpr && step?.actionLocator && actionLocatorResolver.isVerifiedActionLocator(step.actionLocator));
  const actionPrimary = step?.actionLocator ? actionLocatorResolver.primaryActionLocator(step.actionLocator) : null;
  const explicitGuess = step?.guessedLocator === true
    || step?.locatorProvenance?.kind === 'qaai_guessed_locator'
    || actionPrimary?.guess?.isGuess === true
    || step?.actionLocator?.guess?.isGuess === true;
  if (!actionLocatorVerified) {
    const primaryExpression = String(
      actionPrimary?.frameworkExpressions?.playwright
      || actionPrimary?.expression
      || step?.actionLocator?.frameworkExpressions?.playwright
      || step?.actionLocator?.expression
      || '',
    ).trim() || null;
    const candidateExpression = selectStaticLocator(normalized) || exactPasswordCandidateExpr(step, normalized) || null;
    diagnostics.push({
      as: String(alias || step?.as || '').trim() || null,
      caseKey,
      pageKey: pageKey(currentUrl),
      contractStepId: step?.contractStepId || step?.sourceContractStepId || null,
      actionOccurrenceId: step?.actionOccurrenceId || step?.actionIdentity?.actionOccurrenceId || null,
      operation: action || null,
      executable: false,
      diagnosticOnly: true,
      reason: explicitGuess
        ? 'semantic_or_narrative_guess'
        : (primaryExpression
          ? 'export_safe_but_unverified_action_locator'
          : (candidateExpression ? 'candidate_only_locator' : 'missing_verified_action_locator')),
      ...(primaryExpression ? { observedExpression: primaryExpression } : {}),
      ...(candidateExpression ? { candidateExpression } : {}),
      candidates: normalized,
      locatorProvenance: step?.locatorProvenance || null,
      actionLocatorGap: step?.actionLocatorGap || null,
    });
    return false;
  }

  // A proven action-time recipe is immutable and always wins, even when stale
  // guessed flags survived in an older persisted record.
  const actionExpr = rawActionExpr;
  const nameCandidate = namingCandidate(step, candidate);
  const role = actionRole(step, nameCandidate);
  const label = readableSemanticSeed([
    step?.targetLabel, step?.elementLabel, step?.element, step?.label, step?.name,
    nameCandidate?.name, nameCandidate?.text, nameCandidate?.testId,
  ], dynamicValues);
  const expr = actionExpr;
  const directName = semanticName(nameCandidate, dynamicValues);
  const aliasName = semanticAliasName(alias || step?.as, role, dynamicValues);
  const baseName = aliasName && genericSemanticName(directName, role)
    ? aliasName
    : (directName && !opaqueSemanticSeed(directName)
      ? directName
      : (aliasName || fallbackSemanticName(step, nameCandidate, action, dynamicValues)));
  const effectiveAs = String(alias || step?.as || baseName || '').trim() || genericFallbackName(action, role);
  const source = 'actionLocator';
  const entryStep = { ...step, op: 'resolve', as: effectiveAs, locatorConfidence: 'verified' };
  delete entryStep.guessedLocator;
  delete entryStep.locatorProvenance;
  delete entryStep.actionLocatorGap;
  const key = pageKey(currentUrl);
  const authoredPageLabel = semanticPageLabel(entryStep, nameCandidate, { preferCapturedPageIdentity });
  const calibratedPageLabel = pageRoleFor ? pageRoleFor(currentUrl, { caseItem, step: entryStep, candidate: nameCandidate }) : null;
  const resolvedPageLabel = contextualPageLabel(
    currentUrl,
    key,
    authoredPageLabel || calibratedPageLabel,
    preferCapturedPageIdentity,
  );
  const contextKey = pageContextKey(currentUrl, resolvedPageLabel);
  const referenceKey = entryStep.contractStepId || entryStep.sourceContractStepId || effectiveAs || null;
  const file = referenceKey && referencePages.has(referenceKey)
    ? referencePages.get(referenceKey)
    : allocatePageFile(pageFileName(key, resolvedPageLabel), key, contextKey, fileContexts);
  if (referenceKey) referencePages.set(referenceKey, file);
  files[file] = files[file] || {};
  const name = conflictSafeName(files[file], baseName, caseItem, candidate, expr);
  const existing = files[file][name];
  const finding = uniquenessFinding(expr);
  if (existing) {
    if (canonicalizeExpr(existing.expr) !== canonicalizeExpr(expr)) {
      conflicts.push({ file, name: baseName, resolvedName: name, existing: existing.expr, incoming: expr, pageKey: key, caseKey });
    }
    if (finding && !existing.findings) existing.findings = [{ ...finding }];
    if (finding && !existing.uniqueness) existing.uniqueness = 'unverified';
  } else {
    files[file][name] = {
      expr,
      actionLocator: step.actionLocator,
      verified: true,
      locatorConfidence: 'verified',
      candidates: normalized,
      role: nameCandidate?.role || role || null,
      strategy: nameCandidate?.strategy || null,
      source,
      pageKey: key,
      ...(finding ? { uniqueness: 'unverified', findings: [{ ...finding }] } : {}),
    };
  }
  manifest.push(manifestEntry(entryStep, file, name, expr, key, finding, source, caseKey));
  return true;
}

/**
 * Build the locator repository for a set of cases.
 *   cases: [{ ir: { steps } }]
 *   pageRoleFor(url) -> calibratorPageRole | null  (optional; from the calibration atlas)
 * Returns { files: { fileName: { semanticName: { expr, role, strategy, pageKey } } },
 *           conflicts: [{ file, name, existing, incoming, ... }], manifest: [...] }
 */
function dragDestinationRepositoryStep(step) {
  const alias = String(step?.destinationTarget || '').trim();
  if (!alias) return null;
  const candidates = Array.isArray(step.destinationCandidates)
    ? step.destinationCandidates
    : (Array.isArray(step.destinationLocatorCandidates) ? step.destinationLocatorCandidates : []);
  const actionLocator = step.destinationActionLocator && typeof step.destinationActionLocator === 'object'
    ? step.destinationActionLocator
    : null;
  const locatorRecipe = step.destinationLocatorRecipe && typeof step.destinationLocatorRecipe === 'object'
    ? step.destinationLocatorRecipe
    : null;
  const destinationLabel = String(
    step.destinationLabel
    || step.destinationName
    || step.destinationText
    || alias,
  ).trim() || alias;
  const verified = actionLocatorResolver.isVerifiedActionLocator(actionLocator);
  return {
    op: 'resolve',
    as: alias,
    contractStepId: step.contractStepId || step.stepId || null,
    pageUrl: step.pageUrl || step.pageUrlBefore || null,
    pageIdentity: step.destinationPageIdentity || step.pageIdentity || null,
    elementLabel: destinationLabel,
    candidates,
    ...(actionLocator ? { actionLocator } : {}),
    ...(locatorRecipe ? { locatorRecipe } : {}),
    locatorConfidence: verified ? 'verified' : 'missing_exact_evidence',
    diagnosticOnly: !verified,
    executable: verified,
    authored: true,
  };
}

function buildLocatorRepository({
  cases,
  pageRoleFor,
  preferCapturedPageIdentity = false,
  materializeUnresolvedActions = false,
} = {}) {
  const files = {};
  const conflicts = [];
  const manifest = [];
  const diagnostics = [];
  const operations = [];
  const fileContexts = new Map();
  const operationNamesByFile = new Map();
  for (const [caseIndex, c] of (cases || []).entries()) {
    const caseKey = repositoryCaseKey(c, caseIndex);
    const steps = (c && c.ir && Array.isArray(c.ir.steps)) ? c.ir.steps : [];
    const dynamicValues = caseDynamicValues(c);
    const referencePages = new Map();
    const pageLabelsByLocation = new Map();
    let identityUrl = null;
    for (const identityStep of steps) {
      if (!identityStep) continue;
      if (identityStep.op === 'act' && identityStep.action === 'navigate' && identityStep.url) identityUrl = identityStep.url;
      if (identityStep.pageUrl || identityStep.pageUrlBefore) identityUrl = identityStep.pageUrl || identityStep.pageUrlBefore;
      if (identityStep.op !== 'resolve') continue;
      const identityLabel = semanticPageLabel(identityStep, namingCandidate(identityStep, chooseCandidate(stepCandidates(identityStep))), {
        preferCapturedPageIdentity,
      });
      if (identityLabel && identityUrl) pageLabelsByLocation.set(pageContextKey(identityUrl, null), identityLabel);
    }
    let currentUrl = null;
    const actionByTarget = new Map();
    for (const step of steps) {
      if (!step || step.op !== 'act' || !String(step.target || '').trim()) continue;
      const action = String(step.action || 'click');
      if (!actionByTarget.has(String(step.target))) actionByTarget.set(String(step.target), action);
    }
    const declaredAliases = new Set(steps
      .filter((step) => step && step.op === 'resolve' && String(step.as || '').trim())
      .map((step) => String(step.as)));
    const materializedAliases = new Set();
    for (const step of steps) {
      if (!step) continue;
      if (step.op === 'act' && step.action === 'navigate' && step.url) currentUrl = step.url;
      if (step.pageUrl || step.pageUrlBefore) currentUrl = step.pageUrl || step.pageUrlBefore;

      if (materializeUnresolvedActions && step.op === 'act' && PAGE_LEVEL_ACTIONS.has(String(step.action || ''))) {
        const action = String(step.action);
        const operationUrl = action === 'navigate'
          ? (step.url || step.href || step.destination || currentUrl)
          : (step.pageUrl || step.pageUrlBefore || currentUrl);
        const key = pageKey(operationUrl);
        const pageLabel = contextualPageLabel(operationUrl, key, semanticPageLabel(step, null, { preferCapturedPageIdentity })
          || pageLabelsByLocation.get(pageContextKey(operationUrl, null))
          || null, preferCapturedPageIdentity);
        const contextKey = pageContextKey(operationUrl, pageLabel);
        const file = allocatePageFile(pageFileName(key, pageLabel), key, contextKey, fileContexts);
        files[file] = files[file] || {};
        if (!operationNamesByFile.has(file)) operationNamesByFile.set(file, new Map());
        const signature = operationSignature(step, action);
        const name = allocateOperationName(
          operationNamesByFile.get(file),
          operationSemanticName(step, action, key, pageLabel),
          signature,
        );
        operations.push({
          step,
          action,
          file,
          name,
          signature,
          pageKey: key,
          caseKey,
        });
      }

      if (step.op === 'resolve' && String(step.as || '').trim()) {
        const alias = String(step.as);
        if (materializeRepositoryEntry({
          step,
          alias,
          action: actionByTarget.get(alias) || 'click',
          caseItem: c,
          caseKey,
          currentUrl,
          dynamicValues,
          pageRoleFor,
          preferCapturedPageIdentity,
          files,
          conflicts,
          manifest,
          diagnostics,
          fileContexts,
          referencePages,
        })) materializedAliases.add(alias);
        continue;
      }

      // The standard Playwright POM JavaScript profile guarantees a centralized
      // repository entry even when legacy ReplayIR omitted a resolve. Keep this
      // opt-in so the shared TypeScript adapter remains byte-for-byte unchanged.
      if (!materializeUnresolvedActions || step.op !== 'act' || !String(step.target || '').trim()) continue;
      const action = String(step.action || '');
      if (['navigate', 'navigateBack', 'navigateForward', 'waitFor', 'handleDialog', 'resize', 'close'].includes(action)) continue;
      const alias = String(step.target);
      if (!declaredAliases.has(alias) && !materializedAliases.has(alias)) {
        if (materializeRepositoryEntry({
          step,
          alias,
          action,
          caseItem: c,
          caseKey,
          currentUrl,
          dynamicValues,
          pageRoleFor,
          preferCapturedPageIdentity,
          files,
          conflicts,
          manifest,
          diagnostics,
          fileContexts,
          referencePages,
        })) materializedAliases.add(alias);
      }

      if (action !== 'drag' || !String(step.destinationTarget || '').trim()) continue;
      const destinationAlias = String(step.destinationTarget);
      if (declaredAliases.has(destinationAlias) || materializedAliases.has(destinationAlias)) continue;
      const destinationStep = dragDestinationRepositoryStep(step);
      if (!destinationStep) continue;
      if (materializeRepositoryEntry({
        step: destinationStep,
        alias: destinationAlias,
        action: 'drag',
        caseItem: c,
        caseKey,
        currentUrl,
        dynamicValues,
        pageRoleFor,
        preferCapturedPageIdentity,
        files,
        conflicts,
        manifest,
        diagnostics,
        fileContexts,
        referencePages,
      })) materializedAliases.add(destinationAlias);
    }
  }
  return { files, conflicts, manifest, diagnostics, operations };
}

module.exports = {
  buildLocatorRepository,
  pageKey, pageFileName, semanticName, chooseCandidate, camel, collapseDynamic,
  canonicalizeExpr, sanitizeSemanticText,
  uniquenessFinding,
  PAGE_LEVEL_ACTIONS,
  UNIVERSAL_NOISE,
};
