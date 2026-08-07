'use strict';

const { encodeJson, decodeJson } = require('./jsonField');

const VALID_SCOPES = new Set(['suite', 'scenario', 'case']);
const VALID_STATUSES = new Set(['draft', 'applied', 'rejected']);

const INTENT_DEFS = {
  negative: 'Add meaningful negative/error-path cases where the requirements imply validation or rejection.',
  boundary: 'Add boundary-value and empty-state coverage for inputs, filters, and limits.',
  security: 'Add security and abuse-path coverage only where relevant to the documented behavior.',
  data_driven: 'Use uploaded test data through dataBinding placeholders; do not hardcode uploaded row values.',
  strict_assertions: 'Strengthen declaredAssertions with scoped, replayable validation signals instead of generic page text.',
  split_cases: 'Preserve QAAI test-case cardinality; do not collapse independent cases into test.step blocks.',
  skip_cosmetic: 'Avoid cosmetic-only UI checks unless the source document explicitly makes them acceptance criteria.',
  roles: 'Cover role/RBAC differences only for roles explicitly present in the documents or configured test users.',
  locators: 'Prefer steps that target stable semantic controls visible in the Site Atlas.',
};

function clean(value, max = 4000) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeScope(scope) {
  const s = String(scope || '').trim().toLowerCase();
  return VALID_SCOPES.has(s) ? s : 'suite';
}

function normalizeQuickIntents(input) {
  const arr = Array.isArray(input) ? input : [];
  const out = [];
  for (const raw of arr) {
    const key = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (INTENT_DEFS[key] && !out.includes(key)) out.push(key);
  }
  return out.slice(0, 12);
}

function inferGuidanceFocus({ scope, instruction } = {}) {
  const normalizedScope = normalizeScope(scope);
  if (normalizedScope !== 'case') return normalizedScope;
  const text = clean(instruction, 4000).toLowerCase();
  if (!text) return 'case';
  const wholeCase = /\b(whole|entire|complete|full|overall)\s+(test\s+)?case\b|\brewrite\s+(the\s+)?(test\s+)?case\b|\bimprove\s+(the\s+)?(test\s+)?case\b/.test(text);
  if (wholeCase) return 'case';
  const stepFocused = /\bstep\s*\d+\b|\bsteps?\b|\b(insert|add|remove|replace|move)\s+(a\s+|the\s+)?steps?\b|\b(before|after)\s+(login|logout|submit|save|click|step)\b|\b(click|fill|select|check|uncheck|wait|navigate|open|submit)\b/.test(text);
  const stepAssertion = /\b(assert|validate|verify|expect)\b.{0,60}\b(after|before|step\s*\d+)\b/.test(text);
  return stepFocused || stepAssertion ? 'step' : 'case';
}

function buildNormalizedDirectives({ scope, instruction, quickIntents = [], subject = null } = {}) {
  const normalizedScope = normalizeScope(scope);
  const intents = normalizeQuickIntents(quickIntents);
  const lines = [
    `Scope: ${normalizedScope}`,
  ];
  if (subject) lines.push(`Subject: ${clean(subject, 240)}`);
  lines.push(`Guidance focus: ${inferGuidanceFocus({ scope: normalizedScope, instruction })}`);
  if (intents.length) {
    lines.push('Selected directives:');
    for (const key of intents) lines.push(`- ${key}: ${INTENT_DEFS[key]}`);
  }
  const text = clean(instruction, 4000);
  if (text) {
    lines.push('User instruction:');
    lines.push(text);
  }
  lines.push('Application rules:');
  lines.push('- Treat this as QA direction, not as a replacement for BRD/user-story truth.');
  lines.push('- Do not invent requirements, credentials, selectors, data columns, or expected outcomes.');
  lines.push('- If the instruction conflicts with verified requirements, preserve the requirement and surface the conflict.');
  lines.push('- Keep outputs mechanically runnable: complete steps, dataBinding, requirementRefs, and declaredAssertions.');
  return lines.join('\n');
}

function guidancePromptBlock(guidance, opts = {}) {
  if (!guidance) return null;
  const normalized = typeof guidance === 'string'
    ? guidance
    : guidance.normalizedDirectives || buildNormalizedDirectives({
        scope: guidance.scope,
        instruction: guidance.instruction,
        quickIntents: decodeJson(guidance.quickIntentsJson, []),
        subject: opts.subject,
      });
  if (!clean(normalized)) return null;
  const scope = typeof guidance === 'string' ? (opts.scope || 'suite') : guidance.scope;
  return [
    'USER QA GUIDANCE - APPLY DELIBERATELY',
    `Guidance scope: ${scope || 'suite'}`,
    normalized,
    '',
    'This guidance must influence the generated/refined test design, but all output still has to pass the deterministic QAAI contracts: requirement traceability, data binding, assertion fidelity, and runnable steps.',
  ].join('\n');
}

async function createGuidance(prisma, {
  projectId,
  userId,
  sprintId = null,
  generationId = null,
  scenarioId = null,
  testCaseId = null,
  scope = 'suite',
  sourceSurface = null,
  instruction = '',
  quickIntents = [],
  subject = null,
}) {
  const normalizedScope = normalizeScope(scope);
  const cleaned = clean(instruction, 4000);
  const intents = normalizeQuickIntents(quickIntents);
  if (!cleaned && !intents.length) {
    const err = new Error('Tell QAAI what to focus on, or choose at least one guidance chip.');
    err.status = 400;
    err.code = 'EMPTY_GUIDANCE';
    throw err;
  }
  const normalizedDirectives = buildNormalizedDirectives({
    scope: normalizedScope,
    instruction: cleaned,
    quickIntents: intents,
    subject,
  });
  return prisma.generationGuidance.create({
    data: {
      projectId,
      userId,
      sprintId: sprintId || null,
      generationId: generationId || null,
      scenarioId: scenarioId || null,
      testCaseId: testCaseId || null,
      scope: normalizedScope,
      sourceSurface: sourceSurface ? clean(sourceSurface, 80) : null,
      instruction: cleaned || intents.map((key) => INTENT_DEFS[key]).join(' '),
      quickIntentsJson: encodeJson(intents),
      normalizedDirectives,
      status: 'draft',
    },
  });
}

async function loadGuidance(prisma, { projectId, guidanceId }) {
  if (!guidanceId) return null;
  return prisma.generationGuidance.findFirst({
    where: { id: guidanceId, projectId },
  });
}

async function markApplied(prisma, guidanceId, data = {}) {
  if (!guidanceId) return null;
  try {
    return await prisma.generationGuidance.update({
      where: { id: guidanceId },
      data: {
        status: 'applied',
        appliedAt: new Date(),
        appliedGenerationId: data.appliedGenerationId || undefined,
        appliedScenarioId: data.appliedScenarioId || undefined,
        appliedTestCaseId: data.appliedTestCaseId || undefined,
      },
    });
  } catch (_) {
    return null;
  }
}

module.exports = {
  VALID_SCOPES,
  INTENT_DEFS,
  normalizeQuickIntents,
  inferGuidanceFocus,
  buildNormalizedDirectives,
  guidancePromptBlock,
  createGuidance,
  loadGuidance,
  markApplied,
};
