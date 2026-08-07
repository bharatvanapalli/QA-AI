'use strict';

/**
 * Project module intelligence.
 *
 * This is deliberately deterministic: documents, TestData sheets, existing
 * scenario modules, and atlas slices propose modules; Node scores and groups
 * the evidence. No LLM call, no website-specific prompt.
 */

const { recordDegradation } = require('../lib/degradationSignal');

const STOP_TOKENS = new Set([
  'and', 'are', 'can', 'for', 'from', 'into', 'module', 'modules', 'page',
  'pages', 'test', 'tests', 'data', 'sheet', 'sheets', 'scenario', 'scenarios',
  'case', 'cases', 'requirement', 'requirements', 'business', 'document',
  'documents', 'feature', 'features', 'flow', 'flows', 'with', 'without',
  'application', 'applications', 'scope',
]);

const GENERIC_NAMES = new Set([
  'overview', 'introduction', 'scope', 'objective', 'objectives', 'summary',
  'business requirement', 'business requirements', 'functional requirement',
  'functional requirements', 'non functional requirement',
  'non functional requirements', 'assumptions', 'dependencies', 'appendix',
  'acceptance criteria', 'preconditions', 'postconditions', 'test data',
  'user stories', 'release notes', 'brd', 'document', 'documents',
  'application module', 'application modules', 'application in scope',
  'applications in scope', 'modules in scope', 'application modules in scope',
  'the story belongs to', 'story belongs to', 'story convention',
  // Common BRD section titles that are NOT modules
  'application context', 'context', 'url navigation', 'url and navigation',
  'assumptions and constraints', 'assumptions constraints',
  'negative edge cases', 'negative cases', 'edge cases', 'positive cases',
  'technical context', 'system context', 'scope definition', 'in scope',
  'out of scope', 'future scope', 'revision history', 'change history',
  'version history', 'references', 'glossary', 'abbreviations',
  'stakeholders', 'responsibilities', 'readme', 'assertion', 'assertions',
  // Single-word generic technical terms — too ambiguous as standalone module names
  'filter', 'search', 'query', 'validation', 'negative', 'positive', 'crud',
]);

const BOILERPLATE_MODULE_RE = /\b(?:story\s+belongs\s+to|application\s+modules?\s+in\s+scope|modules?\s+in\s+scope|covered\s+modules?|total\s+user\s+stories|user\s+story\s+conventions?|document\s+version|prepared\s+by|status\s*[:=-]|target\s+application)\b/i;
const MODULE_TITLE_VERB_RE = /\b(?:shall|must|should|can|able\s+to|want|belongs?\s+to|prepared|covered|follows?|contains?|include[sd]?|version|status)\b/i;
const SUBSECTION_MODULE_RE = /\b(?:surface|control\s+discovery|discovery|single\s+criterion|multi\s+criterion|criteria|criterion|combination|assertion|assertions|negative\s+cases?|positive\s+cases?|empty\s+result|invalid\s+inputs?|capability\s+gates?|story\s+cards?|index|acceptance\s+criteria)\b/i;

// Seed aliases are a LOW-WEIGHT, generic convenience vocabulary — NOT a
// hardcoded website map and NOT a taxonomy any project must conform to. They
// exist only so that the most universal, cross-domain surfaces (login/logout,
// generic admin/user-management) consolidate under one stable label instead of
// fragmenting. They must never OUTVOTE a module the uploaded documents actually
// name: a seed may only "claim" a heading/sheet/clause when that text is
// ESSENTIALLY the seed term itself (see seedIsEssentially / moduleScore), and
// document-derived modules always win otherwise. Anything that cannot be mapped
// to a documented module is reported via recordDegradation, never force-fit
// into one of these buckets.
const SEEDED_MODULES = [
  {
    key: 'auth',
    name: 'Authentication',
    shared: true,
    aliases: [
      'auth', 'authentication', 'login', 'log in', 'logout', 'log out',
      'signin', 'sign in', 'credential', 'credentials', 'password',
      'username', 'session',
    ],
  },
  {
    key: 'admin',
    name: 'Admin',
    aliases: [
      'admin', 'administration', 'user management', 'users', 'roles',
      'role', 'job', 'jobs', 'organization', 'organisation', 'qualification',
      'qualifications',
    ],
  },
];

function cleanText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function tokenize(value) {
  return cleanText(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP_TOKENS.has(t));
}

function displayNameFromKey(key) {
  return String(key || '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => {
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(' ');
}

function normalizeModuleKey(name) {
  const raw = cleanText(name)
    .replace(/\b(module|feature|area|section|screen|page|flow|test data|data|sheet)\b/gi, ' ')
    .replace(/\b(test|tests|scenario|scenarios|case|cases)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return key;
}

function normalizePhrase(value) {
  return cleanText(value).toLowerCase();
}

function isGenericModuleName(name) {
  const key = normalizeModuleKey(name);
  if (!key) return true;
  const phrase = key.replace(/-/g, ' ');
  const rawPhrase = cleanText(name).toLowerCase();
  if (BOILERPLATE_MODULE_RE.test(rawPhrase) || BOILERPLATE_MODULE_RE.test(phrase)) return true;
  if (GENERIC_NAMES.has(phrase)) return true;
  if (phrase.length < 3 && phrase !== 'hr') return true;
  if (/^\d+$/.test(phrase)) return true;
  return false;
}

function isLikelyDynamicModuleName(name, line = '') {
  if (!name || isGenericModuleName(name)) return false;
  const text = cleanText(name);
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 7) return false;
  if (words.length === 1 && !/\b(module|feature|area)\b/i.test(line) && !seedForText(text)) return false;
  if (SUBSECTION_MODULE_RE.test(text)) return false;
  if (MODULE_TITLE_VERB_RE.test(text)) return false;
  if (/[.!?]$/.test(text)) return false;
  const key = normalizeModuleKey(text);
  if (!key || key.length < 3) return false;
  const meaningful = tokenize(text);
  if (!meaningful.length) return false;
  return true;
}

function scoreSeed(seed, text) {
  return seedMatch(seed, text).score;
}

function snippetAround(text, phrase, radius = 70) {
  const raw = cleanText(text);
  const lower = raw.toLowerCase();
  const needle = cleanText(phrase).toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx < 0) return cap(raw, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(raw.length, idx + needle.length + radius);
  return `${start > 0 ? '...' : ''}${raw.slice(start, end).trim()}${end < raw.length ? '...' : ''}`;
}

function seedMatch(seed, text) {
  const hay = ` ${normalizePhrase(text)} `;
  let score = 0;
  let bestPhrase = null;
  for (const alias of seed.aliases) {
    const phrase = normalizePhrase(alias);
    if (!phrase) continue;
    if (hay.includes(` ${phrase} `)) {
      score += phrase.includes(' ') ? 4 : 2;
      if (!bestPhrase || phrase.length > bestPhrase.length) bestPhrase = alias;
    }
  }
  return { score, phrase: bestPhrase, snippet: bestPhrase ? snippetAround(text, bestPhrase) : null };
}

function seedForText(text) {
  let best = null;
  for (const seed of SEEDED_MODULES) {
    const score = scoreSeed(seed, text);
    if (score && (!best || score > best.score)) best = { seed, score };
  }
  return best;
}

// A seed may only CLAIM a candidate module *name* (coercing it into the seed's
// stable key) when that name is ESSENTIALLY the seed term — e.g. "Login",
// "Log out", "Access settings" -> Authentication / Admin. It must NOT claim a
// distinct domain module that merely shares one alias token among others —
// e.g. "Candidate Onboarding", "Employee Benefits Payout", "User Activity
// Audit" — because that would silently relabel a documented module under one
// customer's HR taxonomy. Generic rule: claim only when the candidate's own
// meaningful tokens are a subset of the matched seed alias's tokens (the name
// IS the seed, not a name that CONTAINS the seed).
function seedIsEssentially(seed, name) {
  if (!seed || !name) return false;
  const match = seedMatch(seed, name);
  if (!match.score || !match.phrase) return false;
  const nameTokens = tokenize(name);
  if (!nameTokens.length) return true; // nothing distinctive beyond the seed
  const aliasTokens = new Set(tokenize(match.phrase));
  // Every meaningful token of the candidate must be accounted for by the
  // matched alias. One extra distinctive token => it's its own domain module.
  return nameTokens.every((t) => aliasTokens.has(t));
}

// Resolve a candidate module NAME to either a seed bucket (only when the name is
// essentially the seed) or its own document-derived key. Doc-derived wins
// whenever the name carries distinctive, non-seed meaning.
function resolveModuleIdentity(name) {
  const seeded = seedForText(name);
  if (seeded && seedIsEssentially(seeded.seed, name)) {
    return { seedOrName: seeded.seed, key: seeded.seed.key, seedOrigin: true };
  }
  const key = normalizeModuleKey(name);
  return { seedOrName: name, key, seedOrigin: false };
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function cap(value, max = 160) {
  const text = cleanText(value);
  return text.length > max ? `${text.slice(0, max).trimEnd()}...` : text;
}

function makeEvidence(source, label, text, meta = {}) {
  return {
    source,
    label: cap(label, 80),
    text: cap(text, 180),
    ...meta,
  };
}

function createModule(seedOrName, source, evidence, weight = 1) {
  const isSeed = seedOrName && typeof seedOrName === 'object' && seedOrName.key;
  const key = isSeed ? seedOrName.key : normalizeModuleKey(seedOrName);
  const name = isSeed ? seedOrName.name : displayNameFromKey(key);
  const aliases = isSeed
    ? Array.from(new Set([seedOrName.name, key, ...seedOrName.aliases].filter(Boolean)))
    : Array.from(new Set([name, key.replace(/-/g, ' ')].filter(Boolean)));
  return {
    key,
    name,
    shared: !!(isSeed && seedOrName.shared),
    // Mark seed-origin modules so scoring can keep their generic alias
    // vocabulary from outvoting document-derived modules (see moduleScore).
    seedOrigin: !!isSeed,
    aliases,
    evidenceWeight: weight,
    sourceEvidence: evidence ? [evidence] : [],
    requirements: { count: 0, sample: [] },
    documents: { count: 0, sample: [] },
    testData: { setCount: 0, sheetCount: 0, rowCount: 0, sheets: [] },
    scenarios: { count: 0 },
    atlas: { sliceCount: 0, pageCount: 0, currentSliceCount: 0, staleSliceCount: 0 },
  };
}

function addEvidence(module, evidence, weight = 1) {
  module.evidenceWeight += weight;
  if (evidence && module.sourceEvidence.length < 10) module.sourceEvidence.push(evidence);
}

function ensureModule(modules, name, source, evidence, weight = 1) {
  if (!name || isGenericModuleName(name)) return null;
  // Document-derived first: a seed only claims the name when the name is
  // ESSENTIALLY the seed term. A distinct domain name keeps its own key so it
  // can never be silently absorbed into one customer's HR taxonomy.
  const { seedOrName, key } = resolveModuleIdentity(name);
  if (!key) return null;
  let module = modules.get(key);
  if (!module) {
    module = createModule(seedOrName, source, evidence, weight);
    modules.set(key, module);
  } else {
    addEvidence(module, evidence, weight);
  }
  return module;
}

function extractHeadingCandidates(text) {
  const candidates = [];
  const lines = String(text || '').split(/\r?\n/).slice(0, 900);
  for (const rawLine of lines) {
    const line = rawLine.replace(/^[\s#>*-]+/, '').trim();
    if (!line || line.length > 120) continue;
    const patterns = [
      /^(?:\d+(?:\.\d+)*[\).:-]?\s*)?(?:module|feature|area|section)\s*[:\-]\s*(.{2,70})$/i,
      /^(?:\d+(?:\.\d+)*[\).:-]?\s*)?(.{2,70}?)\s+(?:module|feature|area)\b$/i,
    ];
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (!match) continue;
      const name = cleanText(match[1]).replace(/[:.-]+$/g, '').trim();
      if (isLikelyDynamicModuleName(name, line)) candidates.push({ name, line });
      break;
    }
  }
  return candidates;
}

function extractRequirementFragments(documents, limit = 500) {
  const fragments = [];
  const requirementSignal = /\b(shall|must|should|can|able to|allow|allows|create|edit|update|delete|approve|reject|search|filter|download|export|submit|view|login|logout)\b/i;
  for (const doc of documents || []) {
    const chunks = String(doc.content || '')
      .split(/\r?\n|(?<=[.!?])\s+/)
      .map(cleanText)
      .filter((line) => line.length >= 18 && line.length <= 420 && requirementSignal.test(line));
    for (const [index, text] of chunks.entries()) {
      fragments.push({
        id: `doc:${doc.id || doc.name || 'document'}:${index}`,
        sourceType: String(doc.category || 'document').toUpperCase(),
        behaviourText: text,
        excerpt: text,
        sourceDocId: doc.id || null,
      });
      if (fragments.length >= limit) return fragments;
    }
  }
  return fragments;
}

function moduleScore(module, text) {
  const hay = ` ${normalizePhrase(text)} `;
  const textTokens = new Set(tokenize(text));
  let score = 0;
  // Seed-origin modules ship a broad, generic alias vocabulary (one customer's
  // HR terms: employee/leave/candidate/vacancy/job...). Letting every such
  // single-word alias score as strongly as a document-derived module's own
  // name lets a seed bucket vacuum up unrelated requirements across domains.
  // So for seed-origin modules we keep multi-word, high-signal phrase matches
  // strong but halve single-word generic-alias matches. Document-derived
  // modules are unaffected (full weight) — the lane the customer documented
  // always wins ties.
  const seedOrigin = !!module.seedOrigin;
  for (const alias of module.aliases || []) {
    const phrase = normalizePhrase(alias);
    if (!phrase) continue;
    if (hay.includes(` ${phrase} `)) {
      if (phrase.includes(' ')) score += 5;
      else score += seedOrigin ? 2 : 3;
    }
  }
  const nameTokens = tokenize(module.name);
  for (const token of nameTokens) {
    if (textTokens.has(token)) score += 2;
  }
  const keyTokens = tokenize(module.key.replace(/-/g, ' '));
  for (const token of keyTokens) {
    if (textTokens.has(token)) score += 1;
  }
  return score;
}

function bestModuleForText(modules, text, minScore = 2) {
  let best = null;
  for (const module of modules.values()) {
    const score = moduleScore(module, text);
    if (score < minScore) continue;
    // Document-derived modules win ties over generic seed buckets so a clause
    // the docs actually name is never attributed to a low-weight HR seed.
    const better = !best
      || score > best.score
      || (score === best.score && best.module.seedOrigin && !module.seedOrigin);
    if (better) best = { module, score };
  }
  return best ? best.module : null;
}

function normalizeSheetName(name) {
  const spaced = cleanText(name)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ');
  return spaced
    .replace(/\b(test|data|sheet|worksheet|cases|case|input|inputs|scenario|scenarios)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sheetsFromSet(row) {
  const parsed = parseJson(row.sheetsJson, { sheets: [] });
  return Array.isArray(parsed.sheets) ? parsed.sheets : [];
}

function mappingBindings(row) {
  const parsed = parseJson(row.mappingJson, null);
  return Array.isArray(parsed && parsed.bindings) ? parsed.bindings : [];
}

function collectCandidates({ documents = [], testDataSets = [], scenarios = [], calibrations = [] }) {
  const modules = new Map();

  for (const doc of documents) {
    const docLabel = doc.name || doc.category || 'document';
    for (const candidate of extractHeadingCandidates(doc.content || '')) {
      ensureModule(
        modules,
        candidate.name,
        'document_heading',
        makeEvidence('document_heading', docLabel, candidate.line, { documentId: doc.id || null }),
        4
      );
    }
    // Seed modules are only created from explicit headings or test-data bindings.
    // Scanning full document text for seed aliases injects ghost modules
    // (e.g., "Authentication") into projects that merely mention the word "login".
  }

  for (const set of testDataSets) {
    for (const sheet of sheetsFromSet(set)) {
      const sheetName = sheet.name || '';
      const normalized = normalizeSheetName(sheetName);
      const text = `${set.name || ''} ${sheetName} ${normalized} ${(sheet.headers || []).join(' ')}`;
      const seed = seedForText(text);
      // Only create a new module from a sheet when a known seed clearly matches.
      // Unknown sheets are attributed to existing doc-derived modules in countTestData().
      // Using a generic normalized name like "Filter" from "FilterData" as a module key
      // splits requirements away from the real module (e.g., "Product Search Filter").
      if (!seed) continue;
      ensureModule(
        modules,
        seed.seed.name,
        'test_data_sheet',
        makeEvidence('test_data_sheet', `${set.name || 'TestData'} / ${sheetName}`, (sheet.headers || []).join(', '), {
          testDataSetId: set.id || null,
          sheet: sheetName,
        }),
        4
      );
    }
    for (const binding of mappingBindings(set)) {
      if (binding && binding.module) {
        ensureModule(
          modules,
          binding.module,
          'test_data_mapping',
          makeEvidence('test_data_mapping', set.name || 'TestData mapping', binding.sheet || binding.module, {
            testDataSetId: set.id || null,
            sheet: binding.sheet || null,
          }),
          5
        );
      }
    }
  }

  for (const scenario of scenarios) {
    if (!scenario.module) continue;
    ensureModule(
      modules,
      scenario.module,
      'scenario',
      makeEvidence('scenario', scenario.name || scenario.module, scenario.module, { scenarioId: scenario.id || null }),
      3
    );
  }

  for (const calibration of calibrations) {
    if (!calibration.module) continue;
    ensureModule(
      modules,
      calibration.module,
      'atlas_slice',
      makeEvidence('atlas_slice', calibration.startUrl || calibration.module, calibration.module, {
        calibrationId: calibration.id || null,
        version: calibration.version || null,
      }),
      calibration.isCurrent ? 4 : 2
    );
  }

  return modules;
}

function countDocuments(modules, documents) {
  const counted = new Map();
  for (const doc of documents || []) {
    const text = `${doc.name || ''} ${doc.category || ''} ${doc.content || ''}`;
    for (const module of modules.values()) {
      if (moduleScore(module, text) < 2) continue;
      const key = `${module.key}:${doc.id || doc.name}`;
      if (counted.has(key)) continue;
      counted.set(key, true);
      module.documents.count += 1;
      if (module.documents.sample.length < 4) {
        module.documents.sample.push({ id: doc.id || null, name: doc.name || 'Document', category: doc.category || null });
      }
    }
  }
}

function countRequirements(modules, requirementItems) {
  const unmapped = [];
  for (const req of requirementItems || []) {
    const module = bestModuleForText(modules, `${req.behaviourText || ''} ${req.excerpt || ''}`, 2);
    if (!module) {
      if (unmapped.length < 25) unmapped.push({ id: req.id || null, text: cap(req.behaviourText || req.excerpt || '', 140) });
      continue;
    }
    module.requirements.count += 1;
    if (module.requirements.sample.length < 5) {
      module.requirements.sample.push({
        id: req.id || null,
        sourceType: req.sourceType || null,
        text: cap(req.behaviourText || req.excerpt || '', 140),
      });
    }
  }
  return unmapped;
}

function countTestData(modules, testDataSets) {
  const unmapped = [];
  const setIdsByModule = new Map();
  for (const set of testDataSets || []) {
    const bindings = mappingBindings(set);
    const bindingBySheet = new Map(bindings.map((b) => [String(b.sheet || '').toLowerCase(), b]));
    for (const sheet of sheetsFromSet(set)) {
      const sheetName = sheet.name || '';
      const binding = bindingBySheet.get(String(sheetName).toLowerCase());
      const bindingText = binding
        ? `${binding.module || ''} ${binding.scenarioName || ''} ${Object.keys(binding.columnToField || {}).join(' ')}`
        : '';
      const text = `${set.name || ''} ${sheetName} ${normalizeSheetName(sheetName)} ${(sheet.headers || []).join(' ')} ${bindingText}`;
      const module = binding && binding.module
        ? bestModuleForText(modules, binding.module, 1)
        : bestModuleForText(modules, text, 2);
      const rowCount = Array.isArray(sheet.rows) ? sheet.rows.length : 0;
      if (!module) {
        if (unmapped.length < 25) unmapped.push({ testDataSetId: set.id || null, setName: set.name || null, sheet: sheetName });
        continue;
      }
      module.testData.sheetCount += 1;
      module.testData.rowCount += rowCount;
      if (!setIdsByModule.has(module.key)) setIdsByModule.set(module.key, new Set());
      setIdsByModule.get(module.key).add(set.id || set.name || sheetName);
      if (module.testData.sheets.length < 8) {
        module.testData.sheets.push({
          testDataSetId: set.id || null,
          setName: set.name || null,
          sheet: sheetName,
          rowCount,
          headers: Array.isArray(sheet.headers) ? sheet.headers.slice(0, 12) : [],
          mapped: !!binding,
        });
      }
    }
  }
  for (const module of modules.values()) {
    module.testData.setCount = setIdsByModule.get(module.key)?.size || 0;
  }
  return unmapped;
}

function countScenarios(modules, scenarios) {
  for (const scenario of scenarios || []) {
    const module = bestModuleForText(modules, `${scenario.module || ''} ${scenario.name || ''}`, 1);
    if (module) module.scenarios.count += 1;
  }
}

function countAtlas(modules, calibrations) {
  for (const calibration of calibrations || []) {
    const module = bestModuleForText(modules, calibration.module || '', 1);
    if (!module) continue;
    module.atlas.sliceCount += 1;
    module.atlas.pageCount += Number(calibration.pagesCount || 0);
    if (calibration.isCurrent) module.atlas.currentSliceCount += 1;
    if (calibration.staleAt && new Date(calibration.staleAt).getTime() < Date.now()) module.atlas.staleSliceCount += 1;
  }
}

function finalizeModules(modules) {
  return Array.from(modules.values())
    .map((module) => {
      const evidenceCount = module.sourceEvidence.length;
      const coverageWeight =
        module.requirements.count * 0.4
        + module.testData.sheetCount * 0.6
        + module.scenarios.count * 0.5
        + module.atlas.currentSliceCount * 0.8;
      const confidence = Math.max(0.1, Math.min(0.99, 0.18 + module.evidenceWeight * 0.08 + coverageWeight * 0.03));
      return {
        key: module.key,
        name: module.name,
        shared: module.shared,
        confidence: Number(confidence.toFixed(2)),
        sourceEvidence: module.sourceEvidence,
        evidenceCount,
        requirements: module.requirements,
        documents: module.documents,
        testData: module.testData,
        scenarios: module.scenarios,
        atlas: module.atlas,
      };
    })
    .filter((m) => m.requirements.count > 0 || m.testData.sheetCount > 0 || m.scenarios.count > 0 || m.atlas.sliceCount > 0)
    .sort((a, b) => {
      if (a.shared !== b.shared) return a.shared ? -1 : 1;
      return (b.confidence - a.confidence) || a.name.localeCompare(b.name);
    });
}

function detectProjectModules({
  documents = [],
  requirementClauses = [],
  testDataSets = [],
  scenarios = [],
  calibrations = [],
  onLog = null,
} = {}) {
  const degradations = [];
  const modules = collectCandidates({ documents, testDataSets, scenarios, calibrations });
  const requirementSource = Array.isArray(requirementClauses) && requirementClauses.length
    ? 'requirement_clauses'
    : 'document_fragments';
  const requirementItems = requirementSource === 'requirement_clauses'
    ? requirementClauses
    : extractRequirementFragments(documents);

  countDocuments(modules, documents);
  const unmappedRequirements = countRequirements(modules, requirementItems);
  const unmappedSheets = countTestData(modules, testDataSets);
  countScenarios(modules, scenarios);
  countAtlas(modules, calibrations);

  const moduleList = finalizeModules(modules);

  // SILENT-DEGRADATION META-FIX: when clauses or sheets land UNMAPPED we used to
  // return them quietly inside `unmapped` (or, before the de-biasing above,
  // force-fit them into an HR seed). Either way the operator had no honest
  // signal that scoping was incomplete. Emit a loud, structured degradation so
  // the reviewer knows those requirements/sheets may be scoped or labelled
  // generically rather than mapped to the module the docs intended.
  if (unmappedRequirements.length) {
    recordDegradation({
      onLog,
      collector: degradations,
      stage: 'module-inference',
      reason: `${unmappedRequirements.length} requirement clause(s)/fragment(s) could not be mapped to a documented module`,
      impact: 'these behaviours may be scoped or labelled generically (e.g. left out of a per-module scope) rather than attributed to their real module',
      severity: 'warning',
    });
  }
  if (unmappedSheets.length) {
    recordDegradation({
      onLog,
      collector: degradations,
      stage: 'module-inference',
      reason: `${unmappedSheets.length} test-data sheet(s) could not be mapped to a documented module`,
      impact: 'data from these sheets may not be bound to the intended module/scenario',
      severity: 'warning',
    });
  }
  // If documents/clauses were supplied but NOTHING resolved to a module, the
  // inference effectively failed — surface that instead of returning an empty
  // list that downstream code would treat as "no modules to test".
  if (!moduleList.length && (documents.length || requirementItems.length || testDataSets.length)) {
    recordDegradation({
      onLog,
      collector: degradations,
      stage: 'module-inference',
      reason: 'no module could be derived from the uploaded documents, clauses, or test data',
      impact: 'scenarios cannot be scoped per-module; generation will fall back to ungrouped/generic scope',
      severity: 'warning',
    });
  }

  return {
    modules: moduleList,
    totals: {
      moduleCount: moduleList.length,
      documentCount: documents.length,
      requirementCount: requirementItems.length,
      requirementSource,
      testDataSetCount: testDataSets.length,
      sheetCount: testDataSets.reduce((sum, set) => sum + sheetsFromSet(set).length, 0),
      scenarioCount: scenarios.length,
      atlasSliceCount: calibrations.length,
    },
    unmapped: {
      requirements: unmappedRequirements,
      sheets: unmappedSheets,
    },
    degradations,
  };
}

module.exports = {
  SEEDED_MODULES,
  tokenize,
  normalizeModuleKey,
  extractHeadingCandidates,
  extractRequirementFragments,
  detectProjectModules,
};
