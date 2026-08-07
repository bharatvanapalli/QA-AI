'use strict';

/**
 * Enterprise Mode — P1. The ONE canonical test-case persistence path.
 *
 * Before this, two routes created TestCase rows with DIVERGENT field sets:
 *   - server/routes/scenarios.js (approve / regenerate) wrote declaredAssertions
 *     (normalized + grounded) + businessRisk + generationId.
 *   - server/routes/agents.js (the all-in-one agent run) wrote NEITHER — no
 *     declaredAssertions (so the verdict layer had nothing to check), no
 *     businessRisk, no grounding.
 *   - NEITHER wrote producesData / requiresData, so cross-case data chaining was
 *     silently never populated from the Architect's output.
 *
 * The same logical test therefore behaved differently depending on which path
 * created it — a correctness defect, not a feature gap. This module collapses
 * both into one writer so EVERY case carries the same complete contract no
 * matter where it was born. It is the spine the rest of the enterprise pipeline
 * (atlas, TestData, dependency, execution, export) validates against.
 *
 * Pure-ish: takes the prisma client as a parameter (uses the caller's client,
 * no second instance). The only side effect is the create it is asked to do.
 *
 * See ENTERPRISE_MODE.md → "TestCaseContract" and the assertContractComplete
 * gate. The gate is COMPUTED here on every case but is NON-BLOCKING by default;
 * blocking is flipped on under Enterprise Mode in P9. P2/P3/P4 extend the
 * contract view (requirementRefs, authProfile, coverageDisposition, resolved
 * placeholders) through this same function and gate.
 */

const declaredAssertionsLib = require('../lib/declaredAssertions');
const testDataApproval = require('./testDataApproval');
const { sanitizeTokenCorruptions, sanitizeDeep } = require('../lib/tokenHygiene');
const oracleContractLib = require('./oracleContract');
const { buildWorkbookContract } = require('./workbookContract');
const {
  normalizeStepsInput,
  normalizeStepAction,
  buildCaseReliabilityArtifacts,
  collectCaseReliabilityDefects,
} = require('./reliability/contracts');
const { computeScenarioGenerationStatus } = require('./reliability/scenarioGenerationStatus');
const { canonicalizeTokenExpression } = require('./reliability/semanticFieldMapper');
const readinessCompiler = require('./readinessCompiler');
const testDataMatrix = require('./testDataMatrix');
const { inferInlineAssertionsForCase } = require('./inlineAssertionInference');
const caseContractV1 = require('./caseContractV1');
const testDesignStepCompiler = require('./testDesignStepCompiler');

const TAG = '[testCaseContract]';

// Provenance values that mean "the expected value was taken from the live app,"
// not from a requirement. A `must` assertion may NEVER originate here — the
// atlas governs HOW/vocabulary, never WHAT the business result should be (the
// anti-circular rule in ENTERPRISE_MODE.md). Inert until P2 reconciles the
// provenance vocabulary to include these values; wired now so the gate is ready.
const APP_ORIGIN_PROVENANCE = new Set(['website', 'atlas', 'app', 'live_site']);
const DATA_BLOCKING_VIOLATIONS = new Set(['placeholder_unresolved', 'data_binding_incomplete']);

function enc(v) {
  return v === undefined || v === null ? null : JSON.stringify(v);
}

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function testDesignLineageForCase(caseObj = {}) {
  const quality = caseObj && caseObj.qualityContract && typeof caseObj.qualityContract === 'object'
    ? caseObj.qualityContract
    : null;
  const lineage = quality && quality.testDesignPlan && typeof quality.testDesignPlan === 'object'
    ? quality.testDesignPlan
    : null;
  return lineage && lineage.planId && lineage.revision && lineage.planCaseId && lineage.caseRevision
    ? lineage
    : null;
}

function planBackedPersistenceError(caseObj, detail) {
  const err = new Error(`Immutable TestDesignPlan case "${caseObj && caseObj.name || 'unnamed case'}" cannot be persisted: ${detail}`);
  err.code = 'TEST_DESIGN_COMPILED_CASE_INVALID';
  err.status = 422;
  err.caseName = caseObj && caseObj.name || null;
  return err;
}

function defectKey(defect = {}) {
  const evidence = defect.evidence && typeof defect.evidence === 'object' ? defect.evidence : {};
  return [
    defect.code,
    defect.caseId,
    defect.rowId,
    evidence.stepId || defect.stepId,
    evidence.token || defect.token,
    defect.coverageRef,
  ].map(clean).join('|');
}

function dedupeDefects(defects = [], caseObj = {}) {
  const caseId = clean(caseObj.id || caseObj.caseId);
  const seen = new Set();
  const out = [];
  for (const defect of Array.isArray(defects) ? defects : []) {
    if (!defect || !defect.code) continue;
    if (caseId && defect.caseId && clean(defect.caseId) !== caseId) continue;
    const key = defectKey(defect);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(defect);
  }
  return out;
}

function normalizeCaseStepsForPersistence(steps, { caseName = 'unnamed case', log = console, tag = TAG } = {}) {
  const result = normalizeStepsInput(steps, { allowSingletonObject: false });
  if (!result.ok) {
    if (log && typeof log.warn === 'function') {
      log.warn(`${tag} invalid_steps_shape case "${caseName}": ${result.defect ? result.defect.message : 'steps did not normalize to an array'}`);
    }
    return [];
  }
  if (result.defect && log && typeof log.info === 'function') {
    log.info(`${tag} ${result.defect.code} auto-repaired for case "${caseName}"`);
  }
  return result.steps.map((step) => canonicalizeStepTokensForPersistence(step));
}

function stepText(step = {}) {
  return clean([
    step.target,
    step.element,
    step.field,
    step.label,
    step.placeholder,
    step.locator_hint,
  ].filter(Boolean).join(' ')).toLowerCase();
}

function stepLooksLikeAuth(step = {}) {
  const text = stepText(step);
  if (/\blogin\b|\bsign\s*in\b|\bauth\b|\bcredential\b/.test(text)) return true;
  if (text.includes('password') && !/\bsearch\b|\bfilter\b/.test(text)) return true;
  if ((text.includes('username') || text.includes('user name')) && !/\bsearch\b|\bfilter\b/.test(text)) return true;
  return false;
}

function canonicalizeStepTokensForPersistence(step = {}) {
  if (!step || typeof step !== 'object') return step;
  const canonicalAction = normalizeStepAction(step.action, step.verify);
  const isInput = ['fill', 'select', 'check', 'upload'].includes(canonicalAction)
    || /fill|type|enter|input|select|choose|check|upload/i.test(clean(step.action));
  if (!isInput) return step;
  const authContext = stepLooksLikeAuth(step);
  const context = {
    purpose: authContext ? 'auth field' : 'business search field',
    authContext,
  };
  const next = { ...step };
  for (const key of ['value', 'text', 'input']) {
    if (typeof next[key] === 'string' && next[key].includes('{{')) {
      next[key] = canonicalizeTokenExpression(next[key], context);
    }
  }
  return next;
}

/**
 * Deterministic completeness gate over a case's contract view.
 * @returns {{ ok: boolean, violations: string[] }}
 *
 * P1 enforces the invariants that are checkable today:
 *  - an automatable case has >= 1 real (non-parseFailed) declared assertion
 *  - it has >= 1 'must' assertion (the thing it proves)
 *  - every assertion has a valid type
 *  - no 'must' originates from the live app (provenance not app-origin)
 * Manual cases are exempt (the verdict layer is bypassed for them).
 * P2+ add: >= 1 requirementRef, coverageDisposition, authProfile, and that
 * every {{placeholder}} resolves to an approved mapping.
 */
function assertContractComplete(view) {
  const violations = [];
  const automatable = (view && view.automatability) !== 'manual';
  const da = Array.isArray(view && view.declaredAssertions) ? view.declaredAssertions : [];
  const real = da.filter((a) => a && !a.parseFailed);

  if (automatable) {
    if (real.length === 0) {
      violations.push('no_declared_assertions');
    } else {
      if (!real.some((a) => (a.criticality || 'must') === 'must')) {
        violations.push('no_must_assertion');
      }
      if (real.some((a) => !declaredAssertionsLib.VALID_TYPES.has(a.type))) {
        violations.push('invalid_assertion_type');
      }
      if (real.some((a) => (a.criticality || 'must') === 'must'
        && APP_ORIGIN_PROVENANCE.has(String(a.provenance || '').toLowerCase()))) {
        violations.push('must_provenance_app_origin');
      }
    }
    // P2 — traceability to the requirements oracle. INERT until the oracle is
    // wired into generation (requireRequirementRefs stays false until then), so
    // P2 adds no false-flag noise to current generations.
    if (view.requireRequirementRefs) {
      const refs = Array.isArray(view.requirementRefs) ? view.requirementRefs : [];
      if (refs.length === 0) violations.push('no_requirement_ref');
    }
    // P4a — every {{placeholder}} a case uses must resolve to an APPROVED data
    // mapping. INERT until Enterprise Mode (requireApprovedMapping stays false),
    // so current generations get no new violation. The caller computes
    // dataPlaceholders (tokens the case uses) + approvedDataRoles (roles the
    // approved mapping can fill) via testDataApproval; the gate just compares.
    if (view.requireApprovedMapping) {
      const placeholders = Array.isArray(view.dataPlaceholders) ? view.dataPlaceholders : [];
      const roles = new Set((Array.isArray(view.approvedDataRoles) ? view.approvedDataRoles : []).map((r) => String(r).toLowerCase()));
      if (placeholders.some((t) => !roles.has(String(t).toLowerCase()))) {
        violations.push('placeholder_unresolved');
      }
    }
    if (view.dataBinding && view.dataBinding.status === 'incomplete') {
      violations.push('data_binding_incomplete');
    }
    // P4b — the case must declare the IDENTITY it runs as (authProfile). INERT
    // until Enterprise Mode (requireAuthProfile stays false), so current
    // generations get no new violation.
    if (view.requireAuthProfile && !view.authProfile) {
      violations.push('no_auth_profile');
    }
  }
  return { ok: violations.length === 0, violations: Array.from(new Set(violations)) };
}

/**
 * Persist a scenario's cases through the canonical contract path.
 *
 * @param {object}  args
 * @param {object}  args.prisma          - the caller's Prisma client
 * @param {string}  args.projectId
 * @param {string}  args.scenarioId
 * @param {string?} args.generationId
 * @param {string}  args.moduleName      - the scenario's module (written to TestCase.module)
 * @param {object[]} args.cases          - normalized Architect cases (with .declaredAssertions, .businessRisk, .producesData, .requiresData, .dataBinding, .dependsOnNames, …)
 * @param {object?} args.calibrationAtlas - if present, run the grounding gate
 * @param {boolean} args.enterpriseMode  - P9: when true, a contract violation blocks (today: record only)
 * @param {object}  args.log             - logger (defaults to console)
 * @param {string}  args.tag
 * @returns {Promise<Array<{ tc, source, dependsOnNames, declaredAssertions, violations }>>}
 */
async function persistCases({
  prisma,
  projectId,
  scenarioId,
  generationId = null,
  moduleName,
  cases = [],
  calibrationAtlas = null,
  enterpriseMode = false,
  requireRequirementRefs = false,
  // P4a — the approved test-data context (loadTestDataContext({approvedOnly:true})
  // result: { sheets, mapping:{ version, status, bindings(+source refs), ... } }).
  // null on the default/draft path ⇒ no placeholder gate, no dataBinding pin
  // (current generations byte-identical). Supplied under Enterprise Mode (P9).
  requireApprovedMapping = false,
  approvedTestData = null,
  // P4b — the identity this generation runs as (an AuthProfile.name). Stamped onto
  // every case's authProfile; null = legacy default-fixture behavior, unchanged.
  requireAuthProfile = false,
  authProfileName = null,
  log = console,
  tag = TAG,
}) {
  if (!prisma) throw new Error('persistCases requires a prisma client');
  const out = [];

  // Step 3D — build the WorkbookContract ONCE for the batch (row-evidence source for
  // the Oracle Contract). Prefer the approved test-data sheets supplied to this call;
  // fall back to none (the Oracle Contract still composes, just without row evidence).
  // Pure + deterministic; a malformed workbook never breaks persistence.
  let batchWorkbookContract = null;
  try {
    const wbSheets = approvedTestData && Array.isArray(approvedTestData.sheets) ? approvedTestData.sheets : null;
    if (wbSheets && wbSheets.length) batchWorkbookContract = buildWorkbookContract({ sheets: wbSheets });
  } catch (_) { batchWorkbookContract = null; }

  // Step 3B bridge — resolve each case's storyId from its requirementRefs'
  // RequirementClause.storyId. Looked up ONCE for the whole batch. Graceful: a
  // pre-regen client (no storyId column) yields an empty map → cases persist
  // without a storyId, unchanged.
  const allRefIds = [...new Set(cases.flatMap((c) => (Array.isArray(c.requirementRefs) ? c.requirementRefs : [])).filter(Boolean))];
  const storyIdByRef = new Map();
  if (allRefIds.length) {
    try {
      const refClauses = await prisma.requirementClause.findMany({ where: { id: { in: allRefIds } }, select: { id: true, storyId: true } });
      for (const cl of refClauses) if (cl && cl.storyId) storyIdByRef.set(cl.id, cl.storyId);
    } catch (_) { /* pre-regen client (no storyId column) — leave map empty */ }
  }

  for (const c of cases) {
    const testDesignLineage = testDesignLineageForCase(c);
    const isPlanBacked = !!testDesignLineage;
    if (isPlanBacked && clean(authProfileName) && clean(c.authProfile) !== clean(authProfileName)) {
      throw planBackedPersistenceError(c, 'the persistence auth profile differs from the profile hashed by the strict compiler');
    }
    if (isPlanBacked && (!testDesignLineage.compiledCaseRevision
      || c.compiledCaseRevision !== testDesignLineage.compiledCaseRevision)) {
      throw planBackedPersistenceError(c, 'the strict compiler revision is missing or does not match its lineage');
    }
    if (isPlanBacked && testDesignStepCompiler.compiledCaseRevision(c) !== testDesignLineage.compiledCaseRevision) {
      throw planBackedPersistenceError(c, 'the executable case no longer matches its strict compiler revision');
    }

    if (!isPlanBacked) {
      try {
        const inlineMaterialized = testDataMatrix.materializeInlineEvidenceTokens(c);
        if (inlineMaterialized && inlineMaterialized.case && Array.isArray(inlineMaterialized.replacements) && inlineMaterialized.replacements.length) {
          Object.assign(c, inlineMaterialized.case);
          if (log && typeof log.info === 'function') {
            log.info(`${tag} inline_text_data_materialized case "${c.name}": ${inlineMaterialized.replacements.map((t) => `{{${t}}}`).join(', ')}`);
          }
        }
      } catch (err) {
        if (log && typeof log.warn === 'function') {
          log.warn(`${tag} inline_text_data_materialization_failed case "${c.name}": ${err.message}`);
        }
      }
    }

    if (!isPlanBacked) {
      try {
        const inferredAssertions = inferInlineAssertionsForCase(c);
        if (inferredAssertions && inferredAssertions.case && Array.isArray(inferredAssertions.added) && inferredAssertions.added.length) {
          Object.assign(c, inferredAssertions.case);
          if (log && typeof log.info === 'function') {
            log.info(`${tag} inline_text_assertions_inferred case "${c.name}": ${inferredAssertions.added.length} assertion(s)`);
          }
        }
      } catch (err) {
        if (log && typeof log.warn === 'function') {
          log.warn(`${tag} inline_text_assertion_inference_failed case "${c.name}": ${err.message}`);
        }
      }
    }

    // 1) Normalize declaredAssertions — stamp stable IDs, validate shape, and
    //    emit parseFailed placeholders for malformed/missing records (so a bad
    //    case routes to needs_human at verdict time rather than being dropped).
    let declaredResult;
    if (isPlanBacked) {
      if (!Array.isArray(c.declaredAssertions)) {
        throw planBackedPersistenceError(c, 'strictly compiled declaredAssertions must be an array');
      }
      declaredResult = {
        normalized: JSON.parse(JSON.stringify(c.declaredAssertions)),
        issues: [],
      };
    } else {
      declaredResult = declaredAssertionsLib.normalizeForCase(
        c.declaredAssertions,
        { automatability: c.automatability, caseName: c.name },
      );
    }
    for (const issue of declaredResult.issues) {
      if (log && typeof log.warn === 'function') log.warn(`${tag} declaredAssertions issue — ${issue}`);
    }

    // 2) Grounding gate (deterministic, no LLM). If a live crawl mapped the page
    //    this case targets, demote any TEXT assertion whose expectedText that
    //    page does not actually show. Mutates declaredResult.normalized in place.
    //    No atlas → no-op. NEVER demotes a `must` (the anti-circular firewall
    //    lives inside groundCaseAssertions).
    if (calibrationAtlas && !isPlanBacked) {
      try {
        const { groundCaseAssertions } = require('../lib/groundAssertions');
        const g = groundCaseAssertions(declaredResult.normalized, c.steps || [], calibrationAtlas, { caseName: c.name });
        for (const d of (g && g.demoted) || []) {
          if (!(log && typeof log.warn === 'function')) continue;
          if (d.scope === 'structural_label') {
            log.warn(`${tag} grounding — case "${d.caseName}": "${d.expected}" is an ARIA landmark label (structural scaffolding) → structural_label`);
          } else {
            log.warn(`${tag} grounding — case "${d.caseName}": "${d.expected}" not on calibrated ${d.scope} → text_ungrounded`);
          }
        }
      } catch (gErr) {
        if (log && typeof log.warn === 'function') log.warn(`${tag} grounding gate error (non-fatal): ${gErr.message}`);
      }
    }

    // 3) Completeness gate — computed for EVERY case. Non-blocking by default;
    //    Enterprise Mode (P9) flips this to block + mark the case unrunnable.
    const approvedMapping = (approvedTestData && approvedTestData.mapping) ? approvedTestData.mapping : null;
    const gate = assertContractComplete({
      automatability: c.automatability,
      declaredAssertions: declaredResult.normalized,
      requirementRefs: Array.isArray(c.requirementRefs) ? c.requirementRefs : [],
      requireRequirementRefs,
      // P4a — placeholder resolution against the approved mapping (inert until P9).
      requireApprovedMapping,
      dataPlaceholders: requireApprovedMapping ? testDataApproval.placeholdersInCase(c) : [],
      approvedDataRoles: requireApprovedMapping ? testDataApproval.mappingRoles(approvedMapping) : [],
      dataBinding: c.dataBinding || null,
      // P4b — identity gate (inert until P9).
      requireAuthProfile,
      authProfile: authProfileName || c.authProfile || null,
    });
    if (!gate.ok && log && typeof log.warn === 'function') {
      log.warn(`${tag} contract-incomplete case "${c.name}": ${gate.violations.join(', ')}`);
    }
    const shouldBlockDataContract = !!(enterpriseMode || requireApprovedMapping)
      && gate.violations.some((code) => DATA_BLOCKING_VIOLATIONS.has(code));
    if (shouldBlockDataContract) {
      const err = new Error(`Test data contract incomplete for case "${c.name}": ${gate.violations.join(', ')}`);
      err.code = 'TEST_DATA_CONTRACT_INCOMPLETE';
      err.status = 422;
      err.caseName = c.name;
      err.violations = gate.violations;
      throw err;
    }

    // P4a/A1 — pin the case to the exact approved mapping version it was authored
    // against, so run/export evidence records WHICH mapping it used and an old case
    // never silently upgrades to a newer approved version. Only when an approved
    // test-data context is supplied (the P9 approved-only path); pre-P9 there is no
    // approved context → dataBinding is written unchanged ({sheet, rowSelector}).
    let dataBindingForCase = c.dataBinding || null;
    if (!isPlanBacked && dataBindingForCase && approvedMapping && Array.isArray(approvedMapping.bindings)) {
      const src = approvedMapping.bindings.find((b) => b && b.sheet === dataBindingForCase.sheet);
      if (src && src.testDataSetId && src.mappingId) {
        dataBindingForCase = { ...dataBindingForCase, testDataSetId: src.testDataSetId, mappingId: src.mappingId, mappingVersion: src.mappingVersion };
      }
    }

    // 4) Canonical write — the FULL contract, byte-for-byte identical on every
    //    entry path. This is the line that kills the divergence.
    // Universal token hygiene — every route funnels through here, so this is the one place that
    // GUARANTEES no corrupted {{placeholder}} (mid-word, URL-fused, double-wrapped) ever reaches
    // storage, regardless of whether the upstream coverage repair ran. Generic, idempotent.
    let normalizedSteps;
    if (isPlanBacked) {
      if (!Array.isArray(c.steps)) {
        throw planBackedPersistenceError(c, 'strictly compiled steps must be an array');
      }
      normalizedSteps = JSON.parse(JSON.stringify(c.steps));
    } else {
      normalizedSteps = normalizeCaseStepsForPersistence(c.steps || [], { caseName: c.name, log, tag });
      c.steps = normalizedSteps;
    }

    // Phase 4.5 - persist the self-healed scenario contract, not only the raw
    // Architect fields. Row plans/data lineage/oracles are also mirrored into
    // dataBindingJson/qualityContractJson so later reports, output files, and
    // repair prompts do not have to rediscover them from weak prose.
    if (!isPlanBacked && dataBindingForCase && c.rowExecutionPlan && typeof c.rowExecutionPlan === 'object') {
      dataBindingForCase = { ...dataBindingForCase, rowExecutionPlan: c.rowExecutionPlan };
    }
    const reqRefs = Array.isArray(c.requirementRefs) && c.requirementRefs.length ? enc(c.requirementRefs) : null;
    const hasOps = (Array.isArray(c.operations) && c.operations.length) || (Array.isArray(c.operationsDropped) && c.operationsDropped.length);
    const credentialHint = c.credentialHint === 'invalid' ? 'invalid' : undefined;
    const coverageRefs = Array.isArray(c.coverageRefs)
      ? c.coverageRefs.filter((r) => typeof r === 'string' && r.trim()).slice(0, 50)
      : [];
    const supportingCoverageRefs = Array.isArray(c.supportingCoverageRefs)
      ? c.supportingCoverageRefs.filter((r) => typeof r === 'string' && r.trim()).slice(0, 50)
      : [];
    const coverageDisposition = ['covered', 'advisory_used', 'missing_capability', 'needs_review'].includes(c.coverageDisposition)
      ? c.coverageDisposition
      : (coverageRefs.length ? 'covered' : undefined);
    const operationsJson = (hasOps || credentialHint || coverageRefs.length || supportingCoverageRefs.length || coverageDisposition)
      ? enc({
        status: c.operationStatus || 'complete',
        operations: Array.isArray(c.operations) ? c.operations : [],
        dropped: Array.isArray(c.operationsDropped) ? c.operationsDropped : [],
        ...(credentialHint ? { credentialHint } : {}),
        ...(coverageRefs.length ? { coverageRefs } : {}),
        ...(supportingCoverageRefs.length ? { supportingCoverageRefs } : {}),
        ...(coverageDisposition ? { coverageDisposition } : {}),
      })
      : null;
    let qualityContractForCase = c.qualityContract && typeof c.qualityContract === 'object'
      ? { ...c.qualityContract }
      : {};
    qualityContractForCase = caseContractV1.mergeIntoQualityContract(
      qualityContractForCase,
      c.caseContractV1 || qualityContractForCase.caseContractV1 || null,
    );
    try {
      const reliabilityArtifacts = buildCaseReliabilityArtifacts({
        ...c,
        steps: normalizedSteps,
        dataBinding: dataBindingForCase || c.dataBinding || null,
      }, { module: moduleName, name: c.scenarioName || c.name || '' }, {});
      const persistenceDefects = collectCaseReliabilityDefects({
        ...c,
        steps: normalizedSteps,
        dataBinding: dataBindingForCase || c.dataBinding || null,
      }, { module: moduleName, name: c.scenarioName || c.name || '' }, {});
      const scopedDefects = dedupeDefects(persistenceDefects, c);
      const persistedStatus = computeScenarioGenerationStatus(c, scopedDefects);
      const phase45 = qualityContractForCase.phase45 && typeof qualityContractForCase.phase45 === 'object'
        ? qualityContractForCase.phase45
        : {};
      qualityContractForCase = {
        ...qualityContractForCase,
        schemaVersion: qualityContractForCase.schemaVersion || reliabilityArtifacts.schemaVersion,
        contractVersion: qualityContractForCase.contractVersion || reliabilityArtifacts.contractVersion,
        phase45: {
          ...phase45,
          enabled: true,
          selfHealed: !!(c.qualityContract && c.qualityContract.phase45),
          status: persistedStatus,
          primaryCoverageRef: c.primaryCoverageRef || phase45.primaryCoverageRef || coverageRefs[0] || null,
          coverageRefs: Array.isArray(c.coverageRefs) ? c.coverageRefs : (phase45.coverageRefs || []),
          supportingCoverageRefs: Array.isArray(c.supportingCoverageRefs) ? c.supportingCoverageRefs : (phase45.supportingCoverageRefs || []),
          coverageAliases: Array.isArray(c.coverageAliases) ? c.coverageAliases : (phase45.coverageAliases || []),
          primaryStoryId: c.primaryStoryId || c.storyId || phase45.primaryStoryId || null,
          supportingRequirementRefs: Array.isArray(c.supportingRequirementRefs) ? c.supportingRequirementRefs : (phase45.supportingRequirementRefs || []),
          rowExecutionPlan: c.rowExecutionPlan || reliabilityArtifacts.rowExecutionPlan || null,
          dataLineage: Array.isArray(c.dataLineage) && c.dataLineage.length ? c.dataLineage : (reliabilityArtifacts.dataLineage || []),
          structuredOracles: Array.isArray(c.oracles) && c.oracles.length ? c.oracles : (reliabilityArtifacts.oracles || []),
          oracles: Array.isArray(c.oracles) && c.oracles.length ? c.oracles : (reliabilityArtifacts.oracles || []),
          browserActionBindings: Array.isArray(c.browserActionBindings) && c.browserActionBindings.length
            ? c.browserActionBindings
            : (reliabilityArtifacts.browserActionBindings || []),
          requiredFields: reliabilityArtifacts.requiredFields || [],
          capabilityEvidence: Array.isArray(c.capabilityEvidence) ? c.capabilityEvidence : (phase45.capabilityEvidence || []),
          authSetupPlan: c.authSetupPlan || phase45.authSetupPlan || null,
          unresolvedDefects: scopedDefects,
        },
      };
    } catch (artifactErr) {
      artifactErr.code = artifactErr.code || 'QUALITY_CONTRACT_BUILD_FAILED';
      artifactErr.message = `Quality contract build failed for case "${c.name}": ${artifactErr.message}`;
      throw artifactErr;
    }

    const producesStateContracts = Array.isArray(c.producesStateJson) && c.producesStateJson.length
      ? c.producesStateJson
      : (Array.isArray(c.producesState) ? c.producesState : []);
    const requiresStateContracts = Array.isArray(c.requiresStateJson) && c.requiresStateJson.length
      ? c.requiresStateJson
      : (Array.isArray(c.requiresState) ? c.requiresState : []);
    const data = {
      projectId,
      scenarioId,
      generationId: generationId || null,
      name: sanitizeTokenCorruptions(c.name),
      type: c.type,
      module: moduleName,
      confidence: c.confidence,
      assertions: isPlanBacked ? c.assertions : sanitizeTokenCorruptions(c.assertions),
      declaredAssertions: isPlanBacked ? enc(declaredResult.normalized) : enc(sanitizeDeep(declaredResult.normalized)),
      steps: isPlanBacked ? enc(normalizedSteps) : enc(sanitizeDeep(normalizedSteps)),
      status: 'pending',
      automatability: c.automatability === 'manual' ? 'manual' : 'automatable',
      automatabilityReason: c.automatability === 'manual' ? (c.automatabilityReason || null) : null,
      businessRisk: c.businessRisk || 'P1',
      producesData: Array.isArray(c.producesData) && c.producesData.length ? enc(c.producesData) : null,
      requiresData: Array.isArray(c.requiresData) && c.requiresData.length ? enc(c.requiresData) : null,
      dataBindingJson: dataBindingForCase ? enc(dataBindingForCase) : null,
      dependsOnIds: Array.isArray(c.dependsOnIds) && c.dependsOnIds.length ? enc(c.dependsOnIds) : null,
      sessionMode: c.sessionMode || undefined,
      producesStateJson: producesStateContracts.length ? enc(producesStateContracts) : null,
      requiresStateJson: requiresStateContracts.length ? enc(requiresStateContracts) : null,
      failurePolicy: c.failurePolicy || undefined,
    };
    // P2 — requirementRefs traceability + P3d — operations[] plan. A THREE-LEVEL
    // graceful ladder, because the two columns landed at different times:
    //   requirementRefs  exists on the current client (P2 regen already applied)
    //   operationsJson   unknown until the P3d migration + regen at next restart
    // So: try {refs+ops} → {refs} → {base}. Without the middle rung, adding the
    // unknown operationsJson would knock requirementRefs OUT on today's client.
    // operationsJson is { status, operations, dropped } — the export gate reads
    // status/dropped (a case with dropped ops is 'incomplete' → must not ship as
    // a complete BDD feature); the BDD bridge reads .operations.
    const qualityContractJson = qualityContractForCase && Object.keys(qualityContractForCase).length
      ? enc(qualityContractForCase)
      : null;
    // P4b — authProfile is the NEWEST optional column (migration 20260613); add a
    // top rung so it degrades on a pre-regen client exactly like operationsJson did.
    // A plan-backed case has already hashed its auth profile. Once the optional
    // caller override is proven equivalent above, persist the compiler-owned
    // value itself so whitespace/casing in a route argument cannot alter the
    // runtime profile after revision validation. Legacy cases keep the existing
    // override behavior.
    const authProfileVal = isPlanBacked
      ? (clean(c.authProfile) || null)
      : (authProfileName || c.authProfile || null);
    // Step 3B — stamp the case's storyId ONLY when all its requirementRefs agree on
    // ONE storyId. Conflicting refs are flagged ambiguous_story_ids and left unset
    // (never guessed) — the 3B resolver treats an unset/ambiguous storyId as a
    // weaker bind (module/semantic → needs_review).
    let caseStoryId = clean(c.primaryStoryId || c.storyId || (qualityContractForCase.phase45 && qualityContractForCase.phase45.primaryStoryId));
    if (!caseStoryId) {
      const refs = Array.isArray(c.requirementRefs) ? c.requirementRefs : [];
      const ids = [...new Set(refs.map((r) => storyIdByRef.get(r)).filter(Boolean))];
      if (ids.length === 1) { [caseStoryId] = ids; }
      else if (ids.length > 1 && log && typeof log.warn === 'function') {
        log.warn(`${tag} ambiguous_story_ids — case "${c.name}" cites refs mapping to ${ids.length} different storyIds (${ids.join(', ')}); leaving storyId unset (needs_review)`);
      }
    }
    caseStoryId = caseStoryId || null;
    const initialReadiness = readinessCompiler.compileCaseReadiness({
      ...data,
      id: c.id || null,
      dependsOnNames: Array.isArray(c.dependsOnNames) ? c.dependsOnNames : [],
      requirementRefs: reqRefs,
      operationsJson,
      authProfile: authProfileVal,
      storyId: caseStoryId,
      qualityContractJson,
    }, {
      workbookContract: batchWorkbookContract,
      sourceArtifacts: Array.isArray(c.sourceArtifacts) ? c.sourceArtifacts : [],
    });
    const initialReadinessData = readinessCompiler.readinessUpdateData(initialReadiness);
    let tc;
    try {
      tc = await prisma.testCase.create({ data: { ...data, requirementRefs: reqRefs, operationsJson, authProfile: authProfileVal, storyId: caseStoryId, qualityContractJson, ...initialReadinessData } });
    } catch (qualityErr) {
      if (qualityContractJson) {
        qualityErr.code = qualityErr.code || 'QUALITY_CONTRACT_PERSIST_FAILED';
        qualityErr.message = `Quality contract persistence failed for case "${c.name}": ${qualityErr.message}`;
        throw qualityErr;
      }
      try {
        tc = await prisma.testCase.create({ data: { ...data, requirementRefs: reqRefs, operationsJson, authProfile: authProfileVal, storyId: caseStoryId } });
      } catch (_2) {
        try {
          tc = await prisma.testCase.create({ data: { ...data, requirementRefs: reqRefs, operationsJson } });
        } catch (_3) {
          try {
            tc = await prisma.testCase.create({ data: { ...data, requirementRefs: reqRefs } });
          } catch (_4) {
            tc = await prisma.testCase.create({ data });
          }
        }
      }
    }

    // Step 3D — assemble the per-case Oracle Contract at this canonical chokepoint,
    // composed from the EXACT persisted shape (normalized assertions, the final
    // dataBinding, operations, refs, derived storyId, cited coverageItem) + the batch
    // WorkbookContract for row evidence. Derivable, not a new column (the CaseCompiler
    // recomputes it the same way from the stored row — so it can never go stale). It
    // travels on `out[]` for the route to log/use.
    try {
      const compiled = readinessCompiler.compileCaseReadiness(tc, {
        workbookContract: batchWorkbookContract,
        sourceArtifacts: Array.isArray(c.sourceArtifacts) ? c.sourceArtifacts : [],
      });
      const readinessData = readinessCompiler.readinessUpdateData(compiled);
      await prisma.testCase.update({ where: { id: tc.id }, data: readinessData });
      tc = { ...tc, ...readinessData };
    } catch (readinessErr) {
      if (log && typeof log.warn === 'function') {
        log.warn(`${tag} readiness persistence failed for case "${c.name}" (non-fatal): ${readinessErr.message}`);
      }
    }

    let oracleContract = null;
    try {
      oracleContract = oracleContractLib.buildOracleContract({
        name: c.name,
        module: moduleName,
        automatability: c.automatability,
        steps: normalizedSteps,
        assertions: c.assertions || '',
        declaredAssertions: declaredResult.normalized,
        dataBinding: dataBindingForCase,
        operations: c.operations || null,
        requirementRefs: Array.isArray(c.requirementRefs) ? c.requirementRefs : [],
        storyId: caseStoryId,
        coverageItemId: c.coverageItemId || (dataBindingForCase && dataBindingForCase.coverageItemId) || null,
      }, { workbookContract: batchWorkbookContract });
      if (oracleContract && oracleContract.findings.length && log && typeof log.info === 'function') {
        log.info(`${tag} oracle-contract "${c.name}": ${oracleContractLib.summarizeOracleContract(oracleContract)}`);
      }
    } catch (ocErr) {
      if (log && typeof log.warn === 'function') log.warn(`${tag} oracle-contract assembly failed (non-fatal): ${ocErr.message}`);
    }

    out.push({
      tc,
      source: c,
      dependsOnNames: Array.isArray(c.dependsOnNames) ? c.dependsOnNames : [],
      declaredAssertions: declaredResult.normalized,
      violations: gate.violations,
      oracleContract,
    });
  }

  return out;
}

module.exports = { persistCases, assertContractComplete, APP_ORIGIN_PROVENANCE };
