'use strict';

/**
 * Phase 1 - document understanding.
 *
 * This stage deliberately stops before test-case generation. It turns uploaded
 * BRD/User Story/Release Note text and verified RequirementClause rows into the
 * structured QA planning context the product needs before asking for TestData:
 * modules, roles, business entities, test-data needs, testability signals, and
 * the next readiness action.
 *
 * The first implementation is deterministic and no-egress. The LLM can later
 * enrich labels/rationales, but Node owns the contract and keeps the output
 * useful even when no API key is available.
 */

const {
  SEEDED_MODULES,
  detectProjectModules,
  normalizeModuleKey,
  extractRequirementFragments,
} = require('./moduleIntelligence');

const VERSION = 1;

const ROLE_PATTERNS = [
  /\bas\s+(?:an?\s+)?([a-z][a-z0-9 _/-]{1,40}?)(?:\s+user)?\s+i\s+(?:want|can|should|must|need|am able)\b/gi,
  /\b([a-z][a-z0-9 _/-]{1,40}?)\s+user\s+(?:can|must|should|shall|will|is able to|needs to)\b/gi,
  /\b(?:role|actor|profile)\s*[:=-]\s*([a-z][a-z0-9 _/-]{1,40})\b/gi,
];

const GENERIC_ROLES = new Set([
  'a', 'an', 'the', 'user', 'users', 'system', 'application', 'app', 'qa', 'tester',
  'business', 'functional', 'non functional', 'end',
]);

const ENTITY_PATTERNS = [
  /\b(?:create|add|edit|update|delete|remove|view|search|filter|approve|reject|submit|download|export|assign|maintain)\s+(?:a|an|the|new|existing)?\s*([a-z][a-z0-9 _/-]{2,48})\b/gi,
  /\b(?:employee|candidate|vacancy|leave|entitlement|user|role|job|organization|qualification|record|profile|report|file|document|order|product|cart|invoice|payment)s?\b/gi,
];

const STOP_ENTITY_TAIL = /\b(?:and|or|with|from|for|to|by|in|on|when|then|so|that|using|against|where)\b.*$/i;

const DATA_NEED_RULES = [
  {
    key: 'auth_credentials',
    kind: 'auth',
    fields: ['role', 'username', 'password'],
    re: /\b(login|log in|sign in|authenticate|credential|password|username|session)\b/i,
    reason: 'Authentication or login behaviour needs reusable credentials.',
  },
  {
    key: 'search_criteria',
    kind: 'input',
    fields: ['searchCriteria', 'expectedResult'],
    re: /\b(search|filter|find|lookup|query)\b/i,
    reason: 'Search/filter behaviour needs criteria rows and expected results.',
  },
  {
    key: 'create_update_fields',
    kind: 'input',
    fields: ['recordFields', 'expectedResult'],
    re: /\b(create|add|edit|update|maintain|submit|save)\b/i,
    reason: 'Create/update behaviour needs form input rows and expected outcomes.',
  },
  {
    key: 'delete_target',
    kind: 'input',
    fields: ['targetRecord', 'expectedResult'],
    re: /\b(delete|remove|deactivate|terminate)\b/i,
    reason: 'Delete/remove behaviour needs a safe target record and post-action assertion.',
  },
  {
    key: 'approval_state',
    kind: 'workflow',
    fields: ['actorRole', 'targetRecord', 'expectedStatus'],
    re: /\b(approve|reject|assign|review|workflow|status)\b/i,
    reason: 'Workflow behaviour needs actor identity and expected state transitions.',
  },
  {
    key: 'validation_rows',
    kind: 'negative',
    fields: ['invalidInput', 'expectedError'],
    re: /\b(invalid|required|mandatory|error|validation|empty|blank|boundary|negative|cannot|should not|must not)\b/i,
    reason: 'Validation/negative behaviour needs invalid rows and expected messages.',
  },
  {
    key: 'download_expectation',
    kind: 'file',
    fields: ['fileName', 'fileType', 'expectedContent'],
    re: /\b(download|export|report|file|pdf|csv|excel|xlsx)\b/i,
    reason: 'Download/export behaviour needs file expectations.',
  },
];

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function cap(value, max = 180) {
  const text = clean(value);
  return text.length > max ? `${text.slice(0, max).trimEnd()}...` : text;
}

function titleCase(value) {
  return clean(value)
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (['hr', 'ess', 'sso', 'mfa', 'qa'].includes(lower)) return lower.toUpperCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

function normalizeRoleName(value) {
  return clean(value)
    .replace(/^(?:the|a|an)\s+/i, '')
    .replace(/\s+user$/i, '')
    .trim();
}

function uniquePush(list, item, keyFn = (x) => x) {
  const key = keyFn(item);
  if (!key) return;
  if (!list.some((x) => keyFn(x) === key)) list.push(item);
}

function sourceTexts(documents, requirementClauses) {
  if (Array.isArray(requirementClauses) && requirementClauses.length) {
    return requirementClauses.map((r) => ({
      id: r.id || null,
      moduleHint: r.moduleHint || null,
      sourceType: r.sourceType || 'REQUIREMENT',
      text: clean(r.behaviourText || r.excerpt || ''),
      excerpt: clean(r.excerpt || r.behaviourText || ''),
    })).filter((r) => r.text);
  }
  return extractRequirementFragments(documents || []).map((r) => ({
    id: r.id || null,
    moduleHint: null,
    sourceType: r.sourceType || 'DOCUMENT',
    text: clean(r.behaviourText || r.excerpt || ''),
    excerpt: clean(r.excerpt || r.behaviourText || ''),
  })).filter((r) => r.text);
}

function extractRoles(items) {
  const roles = [];
  for (const item of items) {
    for (const pattern of ROLE_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(item.text))) {
        const raw = normalizeRoleName(match[1]).replace(STOP_ENTITY_TAIL, '').trim();
        const key = normalizeModuleKey(raw);
        if (!key || GENERIC_ROLES.has(key.replace(/-/g, ' '))) continue;
        uniquePush(roles, {
          key,
          name: titleCase(raw),
          evidence: [{ sourceId: item.id, sourceType: item.sourceType, text: cap(item.text, 140) }],
        }, (r) => r.key);
      }
    }
  }
  return roles.slice(0, 20);
}

function extractEntities(items) {
  const entities = [];
  for (const item of items) {
    for (const pattern of ENTITY_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(item.text))) {
        const raw = clean(match[1] || match[0]).replace(STOP_ENTITY_TAIL, '').replace(/\b(record|details|data|page|module)\b$/i, '').trim();
        const key = normalizeModuleKey(raw);
        if (!key || key.length < 3) continue;
        uniquePush(entities, {
          key,
          name: titleCase(raw),
          evidence: [{ sourceId: item.id, sourceType: item.sourceType, text: cap(item.text, 140) }],
        }, (e) => e.key);
      }
    }
  }
  return entities.slice(0, 30);
}

function classifyTestType(text) {
  const t = clean(text).toLowerCase();
  const out = [];
  if (/\b(invalid|error|fail|failure|negative|cannot|should not|must not|empty|blank)\b/.test(t)) out.push('negative');
  if (/\b(boundary|minimum|maximum|min|max|limit|range|edge)\b/.test(t)) out.push('boundary');
  if (/\b(role|permission|access|unauthori[sz]ed|forbidden|admin|ess|manager)\b/.test(t)) out.push('role_access');
  if (/\b(download|export|report|file)\b/.test(t)) out.push('download');
  if (/\b(create|add|search|filter|view|update|delete|submit|approve|reject|login)\b/.test(t)) out.push('functional');
  return out.length ? out : ['functional'];
}

function classifyTestability(item) {
  const t = clean(item.text).toLowerCase();
  if (/\b(manual only|cannot be automated|not automatable|human verification|visual inspection|phone call|email inbox)\b/.test(t)) {
    return { disposition: 'not_automatable', reason: 'The source text explicitly implies manual or external verification.' };
  }
  if (/\b(otp|captcha|one[- ]time|mfa|2fa|external approval|third-party)\b/.test(t)) {
    return { disposition: 'needs_review', reason: 'The flow may need external identity, OTP, CAPTCHA, or third-party state.' };
  }
  return { disposition: 'automatable', reason: null };
}

function moduleForItem(modules, item) {
  const text = ` ${clean(item.text).toLowerCase()} `;
  let best = null;
  for (const m of modules || []) {
    const seed = SEEDED_MODULES.find((s) => s.key === m.key);
    const aliases = [m.key, m.name]
      .concat(seed ? seed.aliases : [])
      .concat(m.sourceEvidence?.map((e) => e.text) || []);
    let score = 0;
    for (const alias of aliases) {
      const a = clean(alias).toLowerCase();
      if (!a || a.length < 3) continue;
      if (text.includes(` ${a} `)) score += a.includes(' ') ? 4 : 2;
      for (const part of a.split(/[^a-z0-9]+/).filter((p) => p.length >= 3)) {
        if (text.includes(` ${part} `)) score += 1;
      }
    }
    if (score && (!best || score > best.score)) best = { module: m, score };
  }
  return best ? best.module : null;
}

function buildDataNeeds(items, modules) {
  const byKey = new Map();
  for (const item of items) {
    const module = moduleForItem(modules, item);
    const moduleKey = module?.key || 'unscoped';
    const moduleName = module?.name || 'Unscoped';
    for (const rule of DATA_NEED_RULES) {
      if (!rule.re.test(item.text)) continue;
      const key = `${moduleKey}:${rule.key}`;
      const existing = byKey.get(key) || {
        key: rule.key,
        moduleKey,
        moduleName,
        kind: rule.kind,
        fields: rule.fields,
        confidence: module ? 'medium' : 'low',
        reason: rule.reason,
        evidence: [],
      };
      if (existing.evidence.length < 5) {
        existing.evidence.push({ sourceId: item.id, sourceType: item.sourceType, text: cap(item.text, 160) });
      }
      byKey.set(key, existing);
    }
  }
  return Array.from(byKey.values()).sort((a, b) => a.moduleName.localeCompare(b.moduleName) || a.key.localeCompare(b.key));
}

function summarizeTestability(items) {
  const automatable = [];
  const needsReview = [];
  const notAutomatable = [];
  for (const item of items) {
    const cls = classifyTestability(item);
    const record = {
      sourceId: item.id,
      sourceType: item.sourceType,
      text: cap(item.text, 180),
      reason: cls.reason,
      testTypes: classifyTestType(item.text),
    };
    if (cls.disposition === 'not_automatable') notAutomatable.push(record);
    else if (cls.disposition === 'needs_review') needsReview.push(record);
    else automatable.push(record);
  }
  return {
    automatableCount: automatable.length,
    needsReviewCount: needsReview.length,
    notAutomatableCount: notAutomatable.length,
    samples: {
      automatable: automatable.slice(0, 8),
      needsReview: needsReview.slice(0, 8),
      notAutomatable: notAutomatable.slice(0, 8),
    },
  };
}

function attachModuleDataNeeds(modules, dataNeeds) {
  return (modules || []).map((module) => ({
    ...module,
    dataNeeds: dataNeeds
      .filter((need) => need.moduleKey === module.key || (module.shared && need.key === 'auth_credentials'))
      .map((need) => ({
        key: need.key,
        kind: need.kind,
        fields: need.fields,
        confidence: need.confidence,
        reason: need.reason,
        evidence: need.evidence.slice(0, 3),
      })),
  }));
}

function readiness(documents, modules, dataNeeds, testability) {
  if (!Array.isArray(documents) || !documents.length) {
    return {
      status: 'needs_documents',
      nextAction: 'Upload BRD, user stories, or release notes before planning tests.',
      blockers: ['No requirement documents are available.'],
    };
  }
  const blockers = [];
  if (!modules.length) blockers.push('No product modules were detected from the documents.');
  if (!dataNeeds.length) blockers.push('No concrete TestData needs were detected yet.');
  if (testability.automatableCount === 0) blockers.push('No automatable requirement-like behaviours were detected.');
  return {
    status: blockers.length ? 'needs_review' : 'ready_for_test_data',
    nextAction: blockers.length
      ? 'Review document categories/content, then upload or correct the source documents.'
      : 'Upload/select TestData for one module, then let QAAI generate data-aware scenarios.',
    blockers,
  };
}

function buildDocumentUnderstanding({
  project = null,
  documents = [],
  requirementClauses = [],
  testDataSets = [],
  scenarios = [],
  calibrations = [],
} = {}) {
  const modulePreview = detectProjectModules({
    documents,
    requirementClauses,
    testDataSets,
    scenarios,
    calibrations,
  });
  const items = sourceTexts(documents, requirementClauses);
  const roles = extractRoles(items);
  const entities = extractEntities(items);
  const dataNeeds = buildDataNeeds(items, modulePreview.modules);
  const testability = summarizeTestability(items);
  const modules = attachModuleDataNeeds(modulePreview.modules, dataNeeds);
  const ready = readiness(documents, modules, dataNeeds, testability);

  return {
    version: VERSION,
    project: project ? { id: project.id, name: project.name, targetUrl: project.targetUrl || null } : null,
    readiness: ready,
    summary: {
      documentCount: documents.length,
      requirementItemCount: items.length,
      moduleCount: modules.length,
      roleCount: roles.length,
      entityCount: entities.length,
      dataNeedCount: dataNeeds.length,
      requirementSource: modulePreview.totals.requirementSource,
    },
    modules,
    roles,
    entities,
    dataNeeds,
    testability,
    unmapped: modulePreview.unmapped,
  };
}

module.exports = {
  VERSION,
  buildDocumentUnderstanding,
  classifyTestType,
  classifyTestability,
};
