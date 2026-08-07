'use strict';

/**
 * Website-neutral POM architect.
 *
 * Direct page-object methods are the safe default. A higher-level abstraction
 * may only be considered when the current canonical case repeats the same
 * action against the same verified locator. This module never infers business
 * domains, selectors, assertions, page types, or control families from words.
 */
const actionLocatorResolver = require('../actionLocatorResolver');

const POM_ARCHITECT_SYSTEM_PROMPT = `You are QAAI's website-neutral POM Architect.

Use only the authored canonical case and verified live browser evidence.
Never infer a website, business domain, selector, assertion, or page object from vocabulary alone.
Keep deterministic direct page-object methods unless the current case repeats the same verified action pattern.
Never place credentials, runtime values, URLs, UUIDs, or internal identifiers in public method names.
If an abstraction is not proven by repetition and locator provenance, keep the direct methods.`;

const ROLE_SUFFIX_RE = /(button|link|input|searchinput|select|checkbox|radio|tab|menuitem|option|heading|image|element)$/i;

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function stripRoleSuffix(name) {
  return clean(name).replace(/^_+/, '').replace(/^\d+(?=[A-Z])/, '').replace(ROLE_SUFFIX_RE, '');
}

function wordsFromCamel(value) {
  return stripRoleSuffix(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || clean(value);
}

function titleValue(value) {
  return wordsFromCamel(value).split(/\s+/).filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function normalizeKey(value) {
  return clean(value).toLowerCase().replace(/^_+/, '').replace(/^\d+(?=[a-z])/, '').replace(/[^a-z0-9]+/g, '');
}

function pomInfoForStep(step, caseMap) {
  return step && step.target && caseMap && caseMap.get(step.target) || null;
}

function sourceStepId(step, index) {
  return clean(step && (step.contractStepId || step.sourceContractStepId || step.id || step.as || step.target || step.action)) || `step-${index + 1}`;
}

function verifiedResolveForAct(step, resolveByAs) {
  const resolve = step && step.target ? resolveByAs.get(step.target) : null;
  return resolve && resolve.actionLocator && actionLocatorResolver.isVerifiedActionLocator(resolve.actionLocator)
    ? resolve
    : null;
}

function ensurePage(plan, pageFile) {
  if (!plan.pages[pageFile]) {
    plan.pages[pageFile] = { architectMethods: [], assertionMethods: [], reusedDirectMethods: [] };
  }
  return plan.pages[pageFile];
}

function buildPomArchitectGraph({ caseEntries = [], lang = 'ts', moduleFormat = 'esm' } = {}) {
  const plan = {
    schemaVersion: 'qaai-pom-architect-v2',
    mode: 'deterministic_website_neutral',
    systemPrompt: POM_ARCHITECT_SYSTEM_PROMPT,
    lang,
    moduleFormat,
    pages: {},
    specPlan: [],
    repeatedVerifiedActions: [],
    rejectedAbstractions: [],
    stepPlans: new WeakMap(),
  };

  for (const entry of caseEntries || []) {
    const caseItem = entry && entry.caseItem || {};
    const ir = caseItem.ir || {};
    const steps = Array.isArray(ir.steps) ? ir.steps : [];
    const caseMap = entry && entry.caseMap;
    const testCaseId = caseItem.testCaseId || caseItem.caseId || ir.testCaseId || ir.caseId || null;
    const resolveByAs = new Map(steps.filter((step) => step && step.op === 'resolve' && step.as).map((step) => [step.as, step]));
    const groups = new Map();

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (!step || step.op !== 'act') continue;
      const info = pomInfoForStep(step, caseMap);
      if (!info || !info.file || !info.name) continue;
      const action = clean(step.action);
      const signature = `${info.file}\u0001${action}\u0001${info.name}`;
      if (!groups.has(signature)) groups.set(signature, { info, action, records: [] });
      groups.get(signature).records.push({ step, index, resolve: verifiedResolveForAct(step, resolveByAs) });
    }

    for (const group of groups.values()) {
      if (group.records.length < 2) continue;
      const sourceStepIds = group.records.map((record) => sourceStepId(record.step, record.index));
      if (!group.records.every((record) => record.resolve)) {
        plan.rejectedAbstractions.push({
          testCaseId,
          pageFile: group.info.file,
          action: group.action,
          locator: group.info.name,
          sourceStepIds,
          reason: 'Repeated action kept as direct methods because every occurrence did not have a verified action-time locator.',
        });
        continue;
      }
      const reuse = {
        testCaseId,
        pageFile: group.info.file,
        action: group.action,
        locator: group.info.name,
        sourceStepIds,
        reason: 'The current canonical case repeats one direct parameterized method with verified locator provenance.',
      };
      ensurePage(plan, group.info.file).reusedDirectMethods.push(reuse);
      plan.repeatedVerifiedActions.push(reuse);
    }
  }

  return plan;
}

function serializableReport(plan) {
  const pages = {};
  for (const [pageFile, page] of Object.entries((plan && plan.pages) || {})) {
    pages[pageFile] = {
      architectMethods: (page.architectMethods || []).map((method) => ({ ...method })),
      assertionMethods: (page.assertionMethods || []).map((method) => ({ ...method })),
      reusedDirectMethods: (page.reusedDirectMethods || []).map((method) => ({ ...method })),
    };
  }
  return {
    schemaVersion: plan && plan.schemaVersion || 'qaai-pom-architect-v2',
    mode: plan && plan.mode || 'deterministic_website_neutral',
    pages,
    specPlan: (plan && plan.specPlan || []).map((step) => ({ ...step })),
    repeatedVerifiedActions: (plan && plan.repeatedVerifiedActions || []).map((item) => ({ ...item })),
    rejectedAbstractions: (plan && plan.rejectedAbstractions || []).map((item) => ({ ...item })),
  };
}

module.exports = {
  POM_ARCHITECT_SYSTEM_PROMPT,
  buildPomArchitectGraph,
  serializableReport,
  _normalizeKey: normalizeKey,
  _titleValue: titleValue,
};
