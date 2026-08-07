'use strict';

/**
 * Phase C — Replay Contract Validator.
 *
 * Contract check executed before generateJourney(). Evaluates the Evidence
 * Bundle (post-disposition action plan) against the project's export
 * strictness and returns a typed decision. Locator uncertainty is advisory,
 * but an action without exact action-time evidence remains diagnostic-only.
 * Structural, authentication, credential and non-locator ReplayIR defects
 * remain visible as typed findings.
 *
 * Pure module — no Prisma, no FS, no LLM.
 */

const crypto = require('crypto');
const replayEmitter = require('./replayEmitter');
const verifiedActionLocator = require('./_verifiedActionLocator');

// ── Typed verdict constants ───────────────────────────────────────────────────
// Use these instead of raw string literals so control-flow is grep-able and
// a typo doesn't silently produce the wrong branch.

const VERDICT = {
  EXPORTABLE:      'exportable',
  NEEDS_EVIDENCE:  'repairable',   // repairable gaps; Phase D must fix evidence before codegen
  NOT_EXPORTABLE:  'not_exportable',
};

const STATE = {
  CERTIFIED:            'certified',
  DRAFT:                'draft',
  REPAIRING:            'repairing',
  INCOMPLETE_EVIDENCE:  'incomplete_evidence',
  NOT_EXPORTABLE:       'not_exportable',
};

// ── Gap type constants ────────────────────────────────────────────────────────

const GAP = {
  MISSING_LOCATOR:           'missing_locator',           // kbMiss → nonblocking guessed-locator warning
  MISSING_LOCATOR_NO_URL:    'missing_locator_no_url',    // kbMiss without URL → nonblocking guessed-locator warning
  MISSING_ACTION_LOCATOR:    'missing_verified_action_locator',
  MISSING_ACTION_LOCATOR_NO_URL: 'missing_verified_action_locator_no_url',
  LOCATOR_UNVERIFIED:        'locator_unverified',
  DESCRIPTOR_LOCATOR:        'descriptor_locator',        // description-only locator → replace with one warned semantic guess
  MISSING_AUTH:              'missing_auth',              // no authImportPath + not pre-auth → not_exportable
  MISSING_CREDENTIAL:        'missing_credential',        // credProfile has missing env vars → not_exportable
  INCOMPLETE_REPLAY_IR:      'incomplete_replay_ir',      // locator-only incompleteness warns; structural incompleteness remains explicit
  UNSCOPED_ASSERTION:        'unscoped_assertion',        // business assertion with no scope selector → repairable
  AUTH_FAILURE:              'auth_failure',              // execution auth failure signal → not_exportable
  MISSING_TABLE_CONTEXT:     'missing_table_context',     // table op with no rowSelector/tableSelector → repairable
  MISSING_DOWNLOAD_EVIDENCE: 'missing_download_evidence', // download op with no download event → repairable
};

// Descriptor locator regex — mirrors _exportValidate.js / verify_no_descriptor_locators.cjs
const DESCRIPTOR_LOCATOR_RE = /getByText\s*\(\s*["'`]([^"'`]{40,}|[^"'`]*\([^)]+\)|[^"'`]*\b(?:button|icon|menu|row|container|toggle|field|panel|section|dropdown|checkbox|cell)\s+(?:for|in|of)\b[^"'`]*)["'`]/gi;

// Table operations: clicking/selecting/asserting WITHIN a grid row requires
// structured DOM anchor evidence (tableSelector + rowSelector). Without it the
// generated locator picks the wrong row under concurrent data.
const TABLE_OP_NARRATION_RE = /(?:select(?:ing)?(?:\s+\w+)?(?:\s+(?:where|in|from|row))|rank(?:ing)?\s+by|choose(?:ing)?\s+(?:row|entity|record|item)|assert(?:ing)?\s+(?:table|grid|list|row)|table\s+contains|row\s+matches|find\s+(?:row|record))/i;
// Download operations: need a captured download event, not just a click narration.
const DOWNLOAD_OP_NARRATION_RE = /(?:download|export\s+(?:to\s+)?(?:file|csv|xlsx|pdf)|save\s+(?:as|file)|generate\s+report)/i;
const MUTATING_ELEMENT_TOOLS = new Set([
  'browser_click',
  'browser_mouse_click',
  'browser_click_xy',
  'browser_double_click',
  // LEGACY-TRACE: conductor emits no browser_triple_click; kept in this set only so a
  // historical recorded trace replays/exports cleanly. Not a live tool.
  'browser_triple_click',
  'browser_type',
  'browser_fill',
  'browser_fill_form',
  'browser_select_option',
  'browser_select',
  'browser_press_key',
  'browser_hover',
  'browser_drag',
  'browser_file_upload',
  'browser_check',
  'browser_uncheck',
]);
const LOCATOR_GAP_CODE_RE = /locator|target_resolution|excavation/i;

function locatorExpressionIsExportSafe(expression) {
  const raw = String(expression || '').trim();
  if (!raw) return false;
  if (/\.(?:first|nth|last)\s*\(/.test(raw)) return false;
  if (/:(?:nth-of-type|nth-child)\s*\(/i.test(raw)) return false;
  if (/\[ref\s*=|locator\(\s*['"][^'"]*\[ref\s*=/i.test(raw)) return false;
  if (/^getByRole\(\s*["'][^"']+["']\s*\)$/i.test(raw)) return false;
  if (/(?:#|\[id\s*=\s*["'])[^"'\]\s]*(?:[-_:])\d{6,}(?:["']?\]|\b)/i.test(raw)) return false;
  if (/[\uE000-\uF8FF\u2600-\u27BF]|(?:Ã¯|Ã°|Ã¢|Ãƒ|ï¿½)[\w\u0080-\u00ffï¿½]{0,8}/.test(raw)) return false;
  return true;
}

function isVerifiedActionLocator(actionLocator) {
  return verifiedActionLocator.isVerifiedActionLocator(actionLocator);
}

function actionNeedsVerifiedActionLocator(action) {
  if (!action || typeof action !== 'object') return false;
  const tool = String(action.tool || action.toolName || '');
  if (MUTATING_ELEMENT_TOOLS.has(tool)) return true;
  const op = String(action.op || action.type || '');
  return ['click', 'dblclick', 'doubleClick', 'tripleClick', 'fill', 'type', 'select', 'selectOption', 'press', 'hover', 'drag', 'upload', 'check', 'uncheck'].includes(op);
}

function gapCode(gap) {
  if (typeof gap === 'string') return gap;
  return String(gap && (gap.type || gap.code || gap.rule || gap.reason) || '');
}

function isLocatorGap(gap) {
  if (typeof gap === 'string') return LOCATOR_GAP_CODE_RE.test(gap);
  const codes = [gap?.type, gap?.code, gap?.rule, gap?.reason].filter(Boolean).join(' ');
  return LOCATOR_GAP_CODE_RE.test(codes);
}

function isGuessedLocatorAction(action) {
  if (!action || typeof action !== 'object') return false;
  const locator = action.locator && typeof action.locator === 'object' ? action.locator : {};
  return action.guessedLocator === true
    || action.locatorConfidence === 'guessed'
    || action.locatorProvenance?.kind === 'qaai_guessed_locator'
    || locator.guessedLocator === true
    || locator.guessed === true
    || locator.source === 'qaaiGuessedLocator'
    || locator.source === 'qaai_guessed_locator';
}

function guessedResolveCount(ir) {
  return (Array.isArray(ir && ir.steps) ? ir.steps : []).filter((step) => step && step.op === 'resolve' && (
    step.guessedLocator === true
    || step.locatorConfidence === 'guessed'
    || step.locatorProvenance?.kind === 'qaai_guessed_locator'
    || (Array.isArray(step.candidates) && step.candidates.some((candidate) => candidate && candidate.provenance === 'qaai_guessed_locator'))
  )).length;
}

function actionOperation(action) {
  const tool = String(action && (action.tool || action.toolName) || '');
  return replayEmitter.TOOL_ACTION[tool] || String(action && (action.op || action.type) || '').trim() || 'click';
}

function actionIdentityOf(action, fallbackSequence = null) {
  const identity = action && action.actionIdentity && typeof action.actionIdentity === 'object'
    ? action.actionIdentity
    : {};
  const sequence = Number(identity.sequenceIndex ?? action?.sequenceIndex ?? action?.actionSequenceIndex ?? fallbackSequence);
  return {
    caseId: identity.caseId || action?.testCaseId || action?.caseId || null,
    contractStepId: identity.contractStepId || action?.contractStepId || action?.plannedStepId || null,
    authoredActionId: identity.authoredActionId || action?.authoredActionId || action?.actionId || null,
    sequenceIndex: Number.isFinite(sequence) ? Math.floor(sequence) : null,
    toolUseId: identity.toolUseId || action?.toolUseId || action?.toolCallId || null,
    toolName: identity.toolName || action?.toolName || action?.tool || null,
    operation: identity.operation || actionOperation(action),
  };
}

function advisoryLocatorGap(gap, extra = {}) {
  return {
    ...gap,
    ...extra,
    severity: 'warning',
    nonBlocking: true,
    repairable: true,
  };
}

/**
 * Validate the evidence bundle for a journey before codegen.
 *
 * @param {object}   p
 * @param {Array}    p.actions           – Evidence Bundle actions (post-disposition + locator-enriched)
 * @param {Array}    p.declaredAssertions – TestCase.assertionChecks for all cases in the journey
 * @param {object}   p.authInfo          – { authImportPath?, preAuthenticated? }
 * @param {object}   p.credProfile       – { missing: string[], resolved: object }
 * @param {string}   p.targetUrl         – project target URL
 * @param {string}   p.exportStrictness  – 'strict' | 'standard' | 'exploratory' | null
 * @param {Array}    p.replayIrItems     – array of { replayIrJson } per RunResult in the journey
 *
 * @returns {object} ContractResult:
 *   {
 *     verdict:              'exportable' | 'repairable' | 'not_exportable'
 *     missFraction:         0.0–1.0
 *     kbMissCount:          N
 *     totalActionCount:     N
 *     repairableGaps:       [{type, action, pageUrl, narration}]
 *     notExportableGaps:    [{type, description, action?}]
 *     warningGaps:          locator-only advisory gaps (never block emission)
 *     authOk:               boolean
 *     credOk:               boolean
 *     irOk:                 boolean
 *     gaps:                 all gaps merged (repairableGaps + notExportableGaps)
 *     evidenceBundleHash:   SHA256 of the evidence bundle for stale-cert detection
 *   }
 */
function validateContract({
  actions = [],
  declaredAssertions = [],
  authInfo = {},
  credProfile = {},
  targetUrl = '',
  exportStrictness = null,
  replayIrItems = [],
}) {
  const strictness = exportStrictness || 'standard';
  const repairableGaps = [];
  const notExportableGaps = [];
  const warningGaps = [];

  const authoredIds = new Set();
  const authoredActionOccurrences = new Map();
  for (const [actionIndex, action] of actions.entries()) {
    const id = action && action.contractStepId;
    if (id) authoredIds.add(String(id));
    const identity = actionIdentityOf(action, actionIndex + 1);
    if (identity.authoredActionId) {
      const previous = authoredActionOccurrences.get(String(identity.authoredActionId));
      if (previous && (
        previous.sequenceIndex !== identity.sequenceIndex
        || previous.contractStepId !== identity.contractStepId
        || previous.operation !== identity.operation
      )) {
        warningGaps.push({
          type: 'action_occurrence_identity_collision',
          severity: 'warning',
          nonBlocking: true,
          authoredActionId: String(identity.authoredActionId),
          previous,
          current: identity,
          description: 'Two distinct action occurrences reused one authoredActionId. Both actions remain exportable, but their occurrence identities must be repaired at capture time.',
        });
      } else if (!previous) {
        authoredActionOccurrences.set(String(identity.authoredActionId), identity);
      }
    }
    if (action && action.sourceContractStepId && id && String(action.sourceContractStepId) !== String(id)) {
      warningGaps.push({
        type: 'step_identity_mismatch',
        severity: 'warning',
        nonBlocking: true,
        contractStepId: String(id),
        sourceContractStepId: String(action.sourceContractStepId),
        description: 'Runtime evidence carried a different source step identity and was not allowed to replace the authored contract identity.',
      });
    }
  }

  // ── Auth check ─────────────────────────────────────────────────────────────
  const authOk = !!(authInfo.preAuthenticated || authInfo.authImportPath);
  if (!authOk) {
    notExportableGaps.push({
      type: GAP.MISSING_AUTH,
      description: 'No auth import path and not pre-authenticated. The generated spec cannot log in.',
    });
  }

  // ── Credential check ───────────────────────────────────────────────────────
  const missing = Array.isArray(credProfile.missing) ? credProfile.missing : [];
  const credOk = missing.length === 0;
  if (!credOk) {
    notExportableGaps.push({
      type: GAP.MISSING_CREDENTIAL,
      description: `Missing credential env vars: ${missing.join(', ')}. Add them to the project's .env before exporting.`,
    });
  }

  // ── ReplayIR completeness ─────────────────────────────────────────────────
  let irOk = true;
  for (const item of replayIrItems) {
    if (!item || !item.replayIrJson) {
      irOk = false;
      notExportableGaps.push({
        type: GAP.INCOMPLETE_REPLAY_IR,
        description: 'A dependency member has no persisted ReplayIR. QAAI cannot prove or emit that member\'s ordered actions and dependencies.',
      });
      break;
    }
    let ir = item.replayIrJson;
    if (typeof ir === 'string') {
      try {
        ir = JSON.parse(ir);
      } catch (_) {
        irOk = false;
        notExportableGaps.push({
          type: GAP.INCOMPLETE_REPLAY_IR,
          description: 'A dependency member has malformed ReplayIR JSON. This is a structural export defect, not a locator warning.',
        });
        break;
      }
    }
    if (!ir || typeof ir !== 'object' || !Array.isArray(ir.steps)) {
      irOk = false;
      notExportableGaps.push({
        type: GAP.INCOMPLETE_REPLAY_IR,
        description: 'A dependency member ReplayIR has no ordered steps array. This structural defect cannot be downgraded as locator uncertainty.',
      });
      break;
    }
    if (ir && ir.complete === false) {
      const replayGaps = Array.isArray(ir.gaps) ? ir.gaps : [];
      const locatorGaps = replayGaps.filter(isLocatorGap);
      const nonLocatorGaps = replayGaps.filter((gap) => !isLocatorGap(gap));
      const evidenceSummary = ir.evidenceSummary && typeof ir.evidenceSummary === 'object' ? ir.evidenceSummary : {};
      const missingLocatorCount = Math.max(
        locatorGaps.length,
        Number(evidenceSummary.missingLocatorCount || evidenceSummary.missingActionLocatorCount || 0),
      );
      const nonLocatorMissingCount = [
        'missingActionEvidenceCount',
        'missingAssertionCount',
        'parseFailedAssertionCount',
        'missingNavigationEvidenceCount',
        'missingAuthSetupCount',
      ].reduce((sum, key) => sum + Number(evidenceSummary[key] || 0), 0);
      const guesses = guessedResolveCount(ir);
      const locatorOnly = missingLocatorCount > 0
        && nonLocatorGaps.length === 0
        && nonLocatorMissingCount === 0;

      if (locatorOnly) {
        warningGaps.push(advisoryLocatorGap({
          type: GAP.INCOMPLETE_REPLAY_IR,
          code: 'locator_only_replay_ir_advisory',
          description:
            'ReplayIR contains locator-only evidence gaps. The affected authored intent remains diagnostic metadata and is not emitted as executable browser code until exact action-time locator evidence is available.',
          guessedLocator: guesses > 0,
          guessedLocatorCount: guesses,
          missingLocatorCount,
        }));
      } else {
        irOk = false;
        notExportableGaps.push({
          type: GAP.INCOMPLETE_REPLAY_IR,
          description: `ReplayIR for a case is marked incomplete because non-locator evidence is missing (gaps: ${replayGaps.map(gapCode).filter(Boolean).join(', ') || 'unknown'}). Re-run the case to capture complete evidence.`,
        });
        break;
      }
    }
  }

  // ── Per-action locator and descriptor checks ───────────────────────────────
  const actionable = actions.filter(
    (a) => a.disposition === 'committed' || a.disposition === 'assertion_support'
  );

  let kbMissCount = 0;
  for (const a of actionable) {
    // A KB miss is not an output-availability gate. Preserve it as a warning,
    // but never convert the authored narration into executable locator code.
    if (a.kbMiss || a.originalKbMiss || a.locatorEvidenceMissing) {
      kbMissCount++;
      const guessed = isGuessedLocatorAction(a);
      warningGaps.push(advisoryLocatorGap({
        type: a.pageUrl ? GAP.MISSING_LOCATOR : GAP.MISSING_LOCATOR_NO_URL,
        code: 'qaai_exact_locator_evidence_missing',
        action: a,
        pageUrl: a.pageUrl || null,
        narration: a.narration || a.tool,
        description: `Durable exact locator evidence was unavailable for "${a.narration || a.tool}". The authored intent remains diagnostic and is not emitted as executable browser code.`,
        guessedLocator: guessed,
        guessedLocatorRequired: false,
      }));
      continue;
    }

    // Descriptor locator: getByText(long description) leaked into expression
    if (a.locator && a.locator.expression) {
      DESCRIPTOR_LOCATOR_RE.lastIndex = 0;
      if (DESCRIPTOR_LOCATOR_RE.test(a.locator.expression)) {
        kbMissCount++; // treat descriptor as a miss — it will always timeout
        warningGaps.push(advisoryLocatorGap({
          type: GAP.DESCRIPTOR_LOCATOR,
          action: a,
          description: `Descriptor locator detected for "${a.narration || a.tool}": "${a.locator.expression.slice(0, 80)}". It remains diagnostic and is not emitted as executable browser code.`,
          guessedLocator: isGuessedLocatorAction(a),
          guessedLocatorRequired: false,
        }));
      }
    }

    if (actionNeedsVerifiedActionLocator(a) && !isVerifiedActionLocator(a.actionLocator)) {
      const narration = a.narration || a.elementLabel || a.tool || a.op || 'element action';
      kbMissCount++;
      const coordinate = a.actionLocatorGap && (a.actionLocatorGap.coordinate || null);
      const isCoordinateGap = a.actionLocatorGap && (a.actionLocatorGap.code === GAP.LOCATOR_UNVERIFIED || a.actionLocatorGap.type === GAP.LOCATOR_UNVERIFIED);
      const guessed = isGuessedLocatorAction(a);
      warningGaps.push(advisoryLocatorGap({
        type: isCoordinateGap
          ? GAP.LOCATOR_UNVERIFIED
          : (a.pageUrl ? GAP.MISSING_ACTION_LOCATOR : GAP.MISSING_ACTION_LOCATOR_NO_URL),
        action: a,
        pageUrl: a.pageUrl || null,
        narration,
        elementLabel: a.elementLabel || a.args?.element || a.args?.label || null,
        coordinate,
        description: `Verified action-time locator evidence was unavailable for "${narration}". The authored intent remains diagnostic and is not emitted as executable browser code.`,
        guessedLocator: guessed,
        guessedLocatorRequired: false,
      }));
    }
  }

  // ── Assertion scope check ─────────────────────────────────────────────────
  // Business assertions without any scope/selector info are repairable
  // (evidence repair can discover the container selector).
  for (const assertion of declaredAssertions) {
    if (assertion.type === 'text' || assertion.type === 'element') {
      if (!assertion.scope && !assertion.selector && !assertion.pageUrl) {
        repairableGaps.push({
          type: GAP.UNSCOPED_ASSERTION,
          description: `Assertion "${String(assertion.value || '').slice(0, 60)}" has no scope or selector. Evidence repair can discover the container.`,
          assertionId: assertion.id,
        });
      }
    }
  }

  // ── Operation-specific evidence contracts ─────────────────────────────────
  // Table operations require structured anchor evidence so codegen can scope
  // the locator to the correct row. Download operations require a captured
  // download event so assertion_check has proof beyond "I clicked the link".
  // These are repairable (not instantly not_exportable) because evidence repair
  // can probe the live DOM to recover table structure.
  for (const a of actionable) {
    if (a.disposition !== 'committed') continue;
    const narration = a.narration || a.tool || '';

    // Table context check: only for narrations that look like row-scoped ops
    if (TABLE_OP_NARRATION_RE.test(narration)) {
      const ctx = a.context || {};
      if (!ctx.tableSelector && !ctx.rowSelector) {
        repairableGaps.push({
          type: GAP.MISSING_TABLE_CONTEXT,
          action: a,
          pageUrl: a.pageUrl || null,
          narration,
          description: `Table operation "${narration.slice(0, 80)}" has no tableSelector or rowSelector context. The locator may target the wrong row. Evidence repair can probe table structure.`,
          repairable: true,
        });
      }
    }

    // Download evidence check
    if (DOWNLOAD_OP_NARRATION_RE.test(narration)) {
      if (!a.downloadEvidence && !a.expectedDownload) {
        repairableGaps.push({
          type: GAP.MISSING_DOWNLOAD_EVIDENCE,
          action: a,
          pageUrl: a.pageUrl || null,
          narration,
          description: `Download operation "${narration.slice(0, 80)}" has no download event evidence. Use assertion_check with expectedDownload to prove the file arrived.`,
          repairable: true,
        });
      }
    }
  }

  // ── Compute miss fraction and verdict ─────────────────────────────────────
  const totalActionCount = actionable.length;
  const missFraction = totalActionCount > 0 ? kbMissCount / totalActionCount : 0;

  const hasNotExportable = notExportableGaps.length > 0;
  const hasRepairable = repairableGaps.length > 0;

  let verdict;
  if (hasNotExportable) {
    verdict = 'not_exportable';
  } else if (hasRepairable) {
    verdict = 'repairable';
  } else {
    // All gaps cleared — check strictness gate for any residual miss fraction
    // (should be 0 after the above loop, but guard against edge cases)
    // Locator uncertainty is advisory even under strict export. Structural,
    // compiler, auth and credential gaps are still classified above.
    verdict = 'exportable';
  }

  const allGaps = [...notExportableGaps, ...repairableGaps, ...warningGaps];

  // ── Evidence bundle hash ───────────────────────────────────────────────────
  // Used to detect stale certifications: if the evidence bundle changes after
  // a certification was issued, the certification must be re-validated.
  let evidenceBundleHash = null;
  try {
    const bundleStr = JSON.stringify(
      actions.map((a) => ({
        actionIdentity: actionIdentityOf(a),
        tool: a.tool,
        disposition: a.disposition,
        pageUrl: a.pageUrl,
        domFacts: a.domFacts || null,
        locator: a.locator ? { expression: a.locator.expression, source: a.locator.source || null } : null,
        guessedLocator: isGuessedLocatorAction(a),
        locatorConfidence: a.locatorConfidence || null,
        locatorProvenance: a.locatorProvenance ? {
          kind: a.locatorProvenance.kind || null,
          chosenExpression: a.locatorProvenance.chosenExpression || null,
        } : null,
        actionLocator: a.actionLocator ? {
          expression: a.actionLocator.expression || a.actionLocator.frameworkExpressions?.playwright || null,
          source: a.actionLocator.verificationSource || a.actionLocator.evidenceSource || null,
        } : null,
      }))
    );
    evidenceBundleHash = crypto.createHash('sha256').update(bundleStr).digest('hex');
  } catch (_) {}

  return {
    verdict,
    missFraction,
    kbMissCount,
    totalActionCount,
    authoredActionIdentityCount: authoredActionOccurrences.size,
    repairableGaps,
    notExportableGaps,
    warningGaps,
    locatorWarningCount: warningGaps.filter(isLocatorGap).length,
    authOk,
    credOk,
    irOk,
    gaps: allGaps,
    evidenceBundleHash,
    strictness,
  };
}

/**
 * Build the exportMeta JSON object that gets stored on RunResult.exportMeta.
 * Called by conductor.js after contract validation.
 */
function buildExportMeta({ state, gaps = [], contractAt, repairRound = 0, pipelineTraceId = null }) {
  return JSON.stringify({
    state,
    gaps: gaps.map((g) => ({
      type: g.type,
      description: g.description,
      pageUrl: g.pageUrl || null,
      narration: g.narration || g.action?.narration || null,
      tool: g.tool || g.action?.tool || g.action?.toolName || null,
      elementLabel: g.elementLabel || g.action?.elementLabel || g.action?.args?.element || g.action?.args?.label || null,
      severity: g.severity || (isLocatorGap(g) ? 'warning' : null),
      nonBlocking: g.nonBlocking === true || isLocatorGap(g),
      guessedLocator: g.guessedLocator === true || isGuessedLocatorAction(g.action),
      guessedLocatorRequired: g.guessedLocatorRequired === true,
      guessedLocatorCount: Number(g.guessedLocatorCount || 0),
      missingLocatorCount: Number(g.missingLocatorCount || 0),
      repairable: g.repairable === true || isRepairableGap(g.type),
    })),
    contractAt: contractAt || new Date().toISOString(),
    repairRound,
    certifiedAt: null,
    parityReport: null,
    artifacts: [],
    pipelineTraceId,
  });
}

/**
 * Update an existing exportMeta JSON string with new fields.
 * Safe to call with null (returns a fresh meta with the updates applied).
 */
function mergeExportMeta(existing, updates) {
  let base = {};
  if (existing) {
    try { base = JSON.parse(existing); } catch (_) {}
  }
  return JSON.stringify({ ...base, ...updates });
}

function isRepairableGap(type) {
  return isLocatorGap(type)
    || type === GAP.MISSING_LOCATOR
    || type === GAP.MISSING_LOCATOR_NO_URL
    || type === GAP.MISSING_ACTION_LOCATOR
    || type === GAP.MISSING_ACTION_LOCATOR_NO_URL
    || type === GAP.LOCATOR_UNVERIFIED
    || type === GAP.DESCRIPTOR_LOCATOR
    || type === 'missing_action_locator_evidence'
    || type === 'missing_locator_evidence'
    || type === 'locator_evidence_missing'
    || type === 'locator_certification_draft'
    || type === 'locator_certification_blocked'
    || type === GAP.UNSCOPED_ASSERTION
    || type === GAP.MISSING_TABLE_CONTEXT
    || type === GAP.MISSING_DOWNLOAD_EVIDENCE;
}

/**
 * Compute a SHA256 hash of a ReplayIR set for stale-cert detection.
 * Pass the raw replayIrJson strings from each RunResult in the journey.
 */
function hashReplayIr(replayIrStrings = []) {
  const combined = replayIrStrings.filter(Boolean).join('\n');
  if (!combined) return null;
  return crypto.createHash('sha256').update(combined).digest('hex');
}

module.exports = {
  VERDICT,
  STATE,
  GAP,
  validateContract,
  buildExportMeta,
  mergeExportMeta,
  isRepairableGap,
  isLocatorGap,
  isGuessedLocatorAction,
  isVerifiedActionLocator,
  locatorExpressionIsExportSafe,
  hashReplayIr,
};
