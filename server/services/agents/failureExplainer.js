'use strict';

/**
 * Failure Explainer — given a failed RunResult, generates a plain-English
 * explanation for every failed/uncheckable assertion.
 *
 * The AI receives the ACTUAL requirement text from the uploaded documents,
 * not just reference IDs. It answers:
 *   "The BRD said X (verbatim) — the agent checked for it at step N — the
 *    page showed Y — here is exactly why and what to do."
 *
 * Requirement lookup chain (in order):
 *   1. RequirementClause by exact requirementRefs IDs (most precise — verbatim BRD excerpt)
 *   2. Requirement records searched by inline IDs found in assertion notes (BR-AUTH-04 etc.)
 *   3. Document keyword search for anything still unresolved
 */

const { getProvider } = require('../../lib/llmProvider');
const { resolveModelForTier } = require('../../lib/modelRouter');
const { parseJsonResponse } = require('../../lib/parseJsonResponse');
const { resolveAiCredentials } = require('../../lib/resolveAiCredentials');
const {
  classifyAssertionContractDefect,
  inferFailureExplanationOwnership,
} = require('../assertionContractDefect');
const { recomputeRunCounters } = require('../runs');
const prisma = require('../../prisma');

const TIER = 'mid';

const SYSTEM = `You are a QA expert explaining test failures to a QA lead in plain English.

You receive:
- The test case name and what it was testing
- The exact text of the relevant requirements from the team's BRD and user stories (when available)
- Each failed or uncheckable assertion: what it was checking, what was actually found on the page (the evidence), and the outcome
- The sequence of steps the agent took in the browser

Your job: for EACH non-passing assertion, write a clear explanation connecting the requirement to the failure.

Output a JSON object with this exact shape:
{
  "overallSummary": "1-2 sentences. What failed and why — plain English, no jargon.",
  "ownership": "website | qaai_assertion_contract | qaai_execution | environment",
  "recommendedStatus": "fail | blocked | needs_human",
  "assertionExplanations": [
    {
      "assertionId": "<the assertion ID>",
      "requirementContext": "Quote the exact requirement text if provided, or state 'No specific requirement text available'. Never invent requirement text.",
      "whatWasExpected": "What the assertion was checking for, in plain English (not code)",
      "whatWasFound": "What the agent actually saw on the page — quote the evidence directly if available",
      "whyItFailed": "The specific reason: missing from page / wrong state / security restriction / timing / data dependency / etc.",
      "actionRequired": "One specific actionable step: raise a bug with the dev team / remove this assertion / update calibration / investigate manually"
    }
  ]
}

Rules:
- Only explain assertions that are not_matched or uncheckable. Skip matched ones entirely.
- If requirement text is provided, quote it directly in requirementContext. Do not paraphrase.
- If NO requirement text is provided for an assertion, say "No specific requirement text available — assertion was inferred from test context."
- "whatWasFound" must reflect only the evidence provided. Do not invent what was on the page.
- If the assertion itself is inverted, checks the wrong page/state for the test flow, or appears to be a test design error rather than a product bug, set ownership to "qaai_assertion_contract" and recommendedStatus to "blocked".
- If the page evidence clearly shows a product requirement was not met and the assertion matches the test intent, set ownership to "website" and recommendedStatus to "fail".
- Write as if speaking to a QA lead who owns the product but is not a developer. No HTML, CSS, or code terminology.
- Keep each field to 2-3 sentences maximum.
- Output ONLY valid JSON. No markdown fences. No preamble.`;

// Extracts bare requirement-ID-style tokens from a string (e.g. BR-AUTH-04, REQ-001, US-12)
const INLINE_REF_RE = /\b([A-Z]{2,}[-_][A-Z0-9]{1,}[-_][A-Z0-9]+)\b/g;
function extractInlineRefs(text) {
  if (!text) return [];
  const found = [];
  let m;
  const re = new RegExp(INLINE_REF_RE.source, 'g');
  while ((m = re.exec(text)) !== null) found.push(m[1]);
  return found;
}

function stringValue(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value).slice(0, 1200);
}

function normalizeExplanationShape(value, validAssertionIds = new Set()) {
  const src = value && typeof value === 'object' ? value : {};
  const overallSummary = stringValue(
    src.overallSummary,
    'The failure explanation could not be generated in the expected format. Use the assertion evidence below for the authoritative verdict.',
  );
  const assertionExplanations = Array.isArray(src.assertionExplanations)
    ? src.assertionExplanations
      .filter((item) => item && typeof item === 'object')
      .filter((item) => !validAssertionIds.size || validAssertionIds.has(item.assertionId))
      .map((item) => ({
        assertionId: stringValue(item.assertionId),
        requirementContext: stringValue(item.requirementContext, 'No specific requirement text available - assertion was inferred from test context.'),
        whatWasExpected: stringValue(item.whatWasExpected, 'See the assertion evidence.'),
        whatWasFound: stringValue(item.whatWasFound, 'See the recorded page evidence.'),
        whyItFailed: stringValue(item.whyItFailed, 'The recorded evidence did not satisfy this assertion.'),
        actionRequired: stringValue(item.actionRequired, 'Review the assertion evidence and decide whether this is an application defect, data issue, or test-design issue.'),
      }))
    : [];
  const ownershipValues = new Set(['website', 'qaai_assertion_contract', 'qaai_execution', 'environment']);
  const statusValues = new Set(['fail', 'blocked', 'needs_human']);
  return inferFailureExplanationOwnership({
    overallSummary,
    ownership: ownershipValues.has(src.ownership) ? src.ownership : null,
    recommendedStatus: statusValues.has(src.recommendedStatus) ? src.recommendedStatus : null,
    assertionExplanations,
  });
}

async function persistFailureExplanation(runResultId, parsed) {
  try {
    const ownership = parsed?.ownership || null;
    const markContractDefect = ownership === 'qaai_assertion_contract';
    await prisma.runResult.update({
      where: { id: runResultId },
      data: {
        failureExplanation: JSON.stringify(parsed),
        ...(markContractDefect ? {
          status: 'blocked',
          blockedReason: 'assertion_contract_defect',
          error: 'QAAI assertion contract defect: failure explanation identified the assertion as wrong for this flow.',
          mechanicalVerdictReason: 'assertion_contract_defect:failure_explainer',
        } : {}),
      },
    });
    if (markContractDefect) {
      const row = await prisma.runResult.findUnique({
        where: { id: runResultId },
        select: { runId: true, testCaseId: true },
      });
      if (row?.runId && row?.testCaseId) {
        await prisma.blockedItem.updateMany({
          where: { runId: row.runId, testCaseId: row.testCaseId },
          data: {
            reason: 'assertion_contract_defect',
            locator: null,
            message: 'QAAI assertion contract defect: failure explanation identified the assertion as wrong for this flow.',
            aiCategory: 'assertion_contract_defect',
            aiSummary: 'QAAI authored or selected an assertion that contradicts the browser flow.',
            aiSuggestedFix: 'Repair the assertion contract and rerun.',
          },
        });
      }
      if (row?.runId) await recomputeRunCounters(row.runId);
    }
  } catch (err) {
    const msg = String(err?.message || '');
    if (/Unknown field|Unknown argument|Invalid `prisma\./i.test(msg)) return false;
    throw err;
  }
  return true;
}

/**
 * Builds a map of requirementId → requirement text by searching three sources.
 * Returns { clauseMap: Map<id, {excerpt, behaviourText, sourceType}>,
 *           requirementMap: Map<keyword, {title, content, category}> }
 */
async function resolveRequirementContext(projectId, nonPassing) {
  // ── Source 1: RequirementClause by exact IDs ─────────────────────────
  const clauseIds = [...new Set(nonPassing.flatMap((d) => d.requirementRefs || []))].filter(Boolean);
  const clauses = clauseIds.length
    ? await prisma.requirementClause.findMany({
        where: { id: { in: clauseIds }, projectId },
        select: { id: true, excerpt: true, behaviourText: true, sourceType: true },
      })
    : [];
  const clauseMap = new Map(clauses.map((c) => [c.id, c]));

  // ── Source 2: Requirement records by inline IDs in notes ──────────────
  // Collect all inline refs from assertion notes that weren't covered by clauses
  const inlineRefs = [...new Set(
    nonPassing.flatMap((d) => [
      ...extractInlineRefs(d.note || ''),
      ...extractInlineRefs((d.requirementRefs || []).join(' ')),
    ]),
  )].filter((r) => !clauseMap.has(r));

  const requirementMap = new Map();
  if (inlineRefs.length) {
    const reqs = await prisma.requirement.findMany({
      where: {
        projectId,
        OR: inlineRefs.map((ref) => ({ content: { contains: ref } })),
      },
      select: { id: true, title: true, content: true, category: true },
      take: 15,
    });
    for (const req of reqs) {
      // Find which inline ref matched this record so we can key the map
      const matchedRef = inlineRefs.find((r) => req.content.includes(r));
      if (matchedRef) requirementMap.set(matchedRef, req);
    }
  }

  // ── Source 3: Document keyword search for still-unresolved refs ───────
  const stillUnresolved = inlineRefs.filter((r) => !requirementMap.has(r));
  if (stillUnresolved.length) {
    const docs = await prisma.document.findMany({
      where: {
        projectId,
        OR: stillUnresolved.map((ref) => ({ content: { contains: ref } })),
      },
      select: { id: true, name: true, content: true, category: true },
      take: 5,
    });
    for (const doc of docs) {
      const matchedRef = stillUnresolved.find((r) => doc.content.includes(r));
      if (matchedRef && !requirementMap.has(matchedRef)) {
        // Extract the surrounding 600-char window containing the ref
        const idx = doc.content.indexOf(matchedRef);
        const start = Math.max(0, idx - 200);
        const end = Math.min(doc.content.length, idx + 400);
        requirementMap.set(matchedRef, {
          title: doc.name,
          content: doc.content.slice(start, end),
          category: doc.category,
        });
      }
    }
  }

  return { clauseMap, requirementMap };
}

/**
 * Formats the requirement context block that gets injected into the LLM prompt.
 * Only includes requirements that are actually referenced by a non-passing assertion.
 */
function buildRequirementSection(nonPassing, clauseMap, requirementMap) {
  const blocks = [];

  for (const d of nonPassing) {
    const refs = d.requirementRefs || [];
    const inlineRefs = extractInlineRefs(d.note || '');
    const allRefs = [...new Set([...refs, ...inlineRefs])];

    for (const ref of allRefs) {
      if (clauseMap.has(ref)) {
        const c = clauseMap.get(ref);
        blocks.push([
          `[${ref}] — from ${c.sourceType || 'requirement document'}`,
          `Verbatim excerpt: "${c.excerpt}"`,
          c.behaviourText ? `Testable statement: "${c.behaviourText}"` : '',
        ].filter(Boolean).join('\n'));
      } else if (requirementMap.has(ref)) {
        const r = requirementMap.get(ref);
        const snippet = String(r.content || '').slice(0, 600);
        blocks.push([
          `[${ref}]${r.title ? ` — ${r.title}` : ''} (from ${r.category || 'document'})`,
          `Content: "${snippet}${snippet.length < (r.content || '').length ? '…' : ''}"`,
        ].join('\n'));
      }
    }
  }

  if (blocks.length === 0) return null;
  return ['=== REQUIREMENT TEXT (verbatim from your uploaded BRD / user stories) ===', ...blocks].join('\n\n---\n\n');
}

/**
 * Explain all non-passing assertions for one RunResult.
 * Returns { overallSummary, assertionExplanations } or throws.
 *
 * @param {object} opts
 * @param {string} opts.runResultId
 * @param {string} opts.projectId
 * @param {object} [opts.signal]
 */
async function explainFailure({ runResultId, projectId, userId, signal }) {
  const result = await prisma.runResult.findFirst({
    where: { id: runResultId },
    include: {
      testCase: {
        select: { id: true, name: true, module: true, type: true, assertions: true, declaredAssertions: true, userGuidance: true },
      },
    },
  });
  if (!result) throw Object.assign(new Error('Result not found'), { status: 404 });
  if (result.status === 'pass') return { overallSummary: 'This case passed.', assertionExplanations: [] };

  let declared = [];
  try { declared = result.testCase?.declaredAssertions ? JSON.parse(result.testCase.declaredAssertions) : []; } catch (_) {}
  if (!Array.isArray(declared)) declared = [];

  let assertionCheckResults = [];
  try { assertionCheckResults = result.assertionCheckResults ? JSON.parse(result.assertionCheckResults) : []; } catch (_) {}
  if (!Array.isArray(assertionCheckResults)) assertionCheckResults = [];
  const outcomeMap = new Map(assertionCheckResults.map((o) => [o.assertionId, o]));
  const nonPassing = declared.filter((d) => {
    if (!d?.id || d.parseFailed) return false;
    const oc = outcomeMap.get(d.id);
    return oc && (oc.outcome === 'not_matched' || oc.outcome === 'uncheckable');
  });
  const parseFailedAssertions = declared.filter((d) => d?.id && d.parseFailed === true);
  for (const d of parseFailedAssertions) {
    // A parseFailed assertion was excluded at calibration and never genuinely
    // verified — so ANY outcome recorded against it (even a spurious "matched")
    // is meaningless. Force it to uncheckable unconditionally; otherwise a
    // lingering matched entry makes the explainer skip it and wrongly report
    // "no failures" for a case the verdict layer marked fail.
    outcomeMap.set(d.id, {
      assertionId: d.id,
      outcome: 'uncheckable',
      reason: d.parseFailedReason || 'declared_assertion_unparseable',
      evidence: 'This required assertion was excluded during calibration and was never verified by the live run.',
    });
  }
  const explanationTargets = [...nonPassing, ...parseFailedAssertions];

  if (explanationTargets.length === 0) {
    return {
      overallSummary: 'All checked assertions matched, but the automated verdict system overrode the pass. This usually means a required assertion could not be verified or was excluded at calibration.',
      assertionExplanations: [],
    };
  }

  // ── Resolve requirement text from documents ───────────────────────────
  const { clauseMap, requirementMap } = await resolveRequirementContext(projectId, explanationTargets);
  const requirementSection = buildRequirementSection(explanationTargets, clauseMap, requirementMap);

  // ── Build the assertion context block ─────────────────────────────────
  const assertionBlock = explanationTargets.map((d) => {
    const oc = outcomeMap.get(d.id);
    const expected = (() => {
      const p = d.payload || {};
      if (p.expectedText) return `text present on page: "${p.expectedText}"`;
      if (p.unexpectedText) return `text must NOT be present: "${p.unexpectedText}"`;
      if (p.expectedUrlPattern) return `URL matches pattern: ${p.expectedUrlPattern}`;
      if (p.expectedRole) return `ARIA role present: ${p.expectedRole}`;
      if (p.unexpectedRole) return `ARIA role must NOT be present: ${p.unexpectedRole}`;
      if (p.expectedReturn !== undefined) return `JavaScript eval returns: ${p.expectedReturn}`;
      if (p.pageName) return `page identity: ${p.pageName}`;
      if (p.filenamePattern) return `file download: ${p.filenamePattern}`;
      if (p.script) return `JavaScript: ${String(p.script).slice(0, 120)}`;
      return 'assertion';
    })();

    const allRefs = [...new Set([
      ...(d.requirementRefs || []),
      ...extractInlineRefs(d.note || ''),
    ])];
    const covered = allRefs.filter((r) => clauseMap.has(r) || requirementMap.has(r));

    return [
      `Assertion ID: ${d.id}`,
      `Type: ${d.type || 'unknown'}`,
      `Criticality: ${d.criticality || 'must'}`,
      `Requirement reference IDs: ${allRefs.length ? allRefs.join(', ') : 'none'}`,
      covered.length ? `(requirement text for ${covered.join(', ')} is in the REQUIREMENT TEXT section above)` : '',
      `Assertion note: ${d.note || 'none'}`,
      d.parseFailed ? `Calibration status: excluded before execution (${d.parseFailedReason || 'declared_assertion_unparseable'})` : '',
      `What was being checked: ${expected}`,
      `Outcome: ${oc.outcome}`,
      `Evidence from page at time of check: ${oc.evidence ? String(oc.evidence).slice(0, 500) : 'none recorded'}`,
    ].filter(Boolean).join('\n');
  }).join('\n\n---\n\n');

  let stepResults = [];
  try { stepResults = result.stepResults ? JSON.parse(result.stepResults) : []; } catch (_) {}
  const traceLines = Array.isArray(stepResults)
    ? stepResults.slice(0, 50).map((s) => `Step ${s.index ?? '?'}: ${s.status}${s.error ? ` — ${s.error}` : ''}`).join('\n')
    : '';

  const userMessage = [
    `TEST CASE: ${result.testCase?.name || result.testCaseId}`,
    result.testCase?.module ? `MODULE: ${result.testCase.module}` : '',
    result.testCase?.type ? `TEST TYPE: ${result.testCase.type}` : '',
    result.testCase?.userGuidance ? `TESTER GUIDANCE: ${result.testCase.userGuidance}` : '',
    result.testCase?.assertions ? `WHAT IT WAS TESTING: ${result.testCase.assertions}` : '',
    '',
    requirementSection || '(No requirement documents were found for this project — assertions were authored from inferred context only)',
    '',
    '=== NON-PASSING ASSERTIONS ===',
    assertionBlock,
    '',
    '=== AGENT STEPS (what the agent did in the browser) ===',
    traceLines || '(no trace recorded)',
  ].filter(Boolean).join('\n');

  const project = await prisma.project.findFirst({ where: { id: projectId } });
  // Resolve the viewer's API key (req.user.id, threaded from the route). Fall
  // back to the project owner for non-request contexts (scripts, retries) —
  // vault/integrations key off userId and throw on null, so this must be set.
  const { provider: providerName, apiKey, model } = await resolveAiCredentials(userId || project?.userId, project);
  const provider = getProvider(providerName);
  const routedModel = resolveModelForTier({ provider: providerName, requestedModel: model, tier: TIER });

  let resp;
  try {
    resp = await provider.complete({
      apiKey,
      model: routedModel,
      maxTokens: 2000,
      system: SYSTEM,
      messages: [{ role: 'user', content: userMessage }],
      signal,
      responseFormat: 'json',
    });
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) {
      const e = new Error('Cancelled'); e.code = 'CANCELLED'; e.status = 499; throw e;
    }
    throw err;
  }

  const raw = resp?.content?.[0]?.text || resp?.text || '';
  let parsed;
  try { parsed = parseJsonResponse(raw); } catch (_) {
    parsed = {
      overallSummary: 'The AI response was not valid JSON. Use the assertion evidence below for the authoritative verdict.',
      assertionExplanations: [],
    };
  }
  parsed = normalizeExplanationShape(parsed, new Set(explanationTargets.map((d) => d.id)));
  const contractDecision = classifyAssertionContractDefect({
    testCase: result.testCase,
    declaredAssertions: declared,
    recordedOutcomes: assertionCheckResults,
    trace: result.trace,
    failureExplanation: parsed,
    verdictReason: result.mechanicalVerdictReason || result.error,
  });
  const aiSuggestedContractOwnership = parsed.ownership === 'qaai_assertion_contract'
    || parsed.ownershipSignal === 'qaai_assertion_contract';
  if (contractDecision.isDefect) {
    parsed = {
      ...parsed,
      ownership: 'qaai_assertion_contract',
      recommendedStatus: 'blocked',
      assertionContractDefect: {
        assertionId: contractDecision.assertionId || null,
        defectType: contractDecision.defectType || null,
        message: contractDecision.message || null,
        expectedByAssertion: contractDecision.expectedByAssertion || null,
        observedByEvidence: contractDecision.observedByEvidence || null,
        suggestedAssertion: contractDecision.suggestedAssertion || null,
        evidenceBasis: contractDecision.evidenceBasis || null,
      },
    };
  } else if (aiSuggestedContractOwnership) {
    parsed = {
      ...parsed,
      ownership: 'website',
      recommendedStatus: 'fail',
      ownershipNote: 'AI suggested assertion-contract ownership, but deterministic evidence did not certify a contradiction between the assertion contract and observed outcome.',
    };
  }

  await persistFailureExplanation(runResultId, parsed);

  return parsed;
}

module.exports = { explainFailure };
