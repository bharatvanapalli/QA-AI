'use strict';

/**
 * QAAI Certification Kernel.
 *
 * One place for the platform contract:
 *   - unknowns become internal certification gaps
 *   - website failures require certified assertion evidence
 *   - QAAI packaging/codegen/locator/evidence problems never leak as website defects
 *
 * Pure module: no Prisma, no fs, no browser, no LLM.
 */

const GAP_CATALOG = {
  missing_assertion_outcome: {
    layer: 'assertion',
    ownership: 'qaai',
    repairable: true,
    message: 'A declared validation did not produce recorded evidence. QAAI is holding export because it cannot prove the generated test represents the approved validation set.',
  },
  ratification_failed: {
    layer: 'assertion',
    ownership: 'qaai',
    repairable: false,
    message: 'QAAI could not complete assertion ratification. This is an internal evidence gap, not a website defect verdict.',
  },
  missing_locator_evidence: {
    layer: 'locator',
    ownership: 'qaai',
    repairable: true,
    blocksWebsiteVerdict: false,
    message: 'One or more browser actions do not have certified locator evidence. QAAI is holding export instead of generating a speculative selector.',
  },
  locator_evidence_missing: {
    layer: 'locator',
    ownership: 'qaai',
    repairable: true,
    blocksWebsiteVerdict: false,
    message: 'A ReplayIR resolve step is missing Locator Intelligence v2 evidence. QAAI is holding export until the step is recaptured or repaired.',
  },
  locator_certification_draft: {
    layer: 'locator',
    ownership: 'qaai',
    repairable: true,
    blocksWebsiteVerdict: false,
    message: 'A locator has draft evidence but not certified same-element proof. QAAI is holding export and surfacing the repair reason.',
  },
  locator_certification_blocked: {
    layer: 'locator',
    ownership: 'qaai',
    repairable: true,
    blocksWebsiteVerdict: false,
    message: 'A locator failed certification. QAAI is holding export and surfacing the selected locator, weaknesses, and repair recommendation.',
  },
  locator_unverified: {
    layer: 'locator',
    ownership: 'qaai',
    repairable: true,
    blocksWebsiteVerdict: false,
    message: 'A coordinate or vision-driven action could not be converted into certified DOM locator evidence. QAAI is holding export until the point is repaired into a durable locator.',
  },
  locator_unrecoverable: {
    layer: 'locator',
    ownership: 'qaai',
    repairable: false,
    blocksWebsiteVerdict: false,
    message: 'QAAI could not recover a certified locator after its bounded locator-repair path. This is an internal locator-certification gap, not a confirmed website defect.',
  },
  incomplete_replay_ir: {
    layer: 'replayir',
    ownership: 'qaai',
    repairable: false,
    blocksWebsiteVerdict: false,
    message: 'ReplayIR is incomplete. QAAI is holding export because the recorded execution cannot be converted into a faithful runnable spec.',
  },
  replayir_incomplete: {
    layer: 'replayir',
    ownership: 'qaai',
    repairable: false,
    blocksWebsiteVerdict: false,
    message: 'ReplayIR is incomplete. QAAI is holding export because the recorded execution cannot be converted into a faithful runnable spec.',
  },
  replayir_missing: {
    layer: 'replayir',
    ownership: 'qaai',
    repairable: false,
    blocksWebsiteVerdict: false,
    message: 'No certified ReplayIR was captured for this case, so QAAI cannot export it without fabricating steps.',
  },
  replayir_invalid: {
    layer: 'replayir',
    ownership: 'qaai',
    repairable: false,
    message: 'The stored ReplayIR payload could not be parsed. QAAI is holding export until the internal evidence record is repaired.',
  },
  package_validation_skipped: {
    layer: 'package',
    ownership: 'qaai',
    repairable: false,
    blocksWebsiteVerdict: false,
    message: 'Package validation was skipped, so QAAI cannot certify the generated files as runnable.',
  },
  package_validation_failed: {
    layer: 'package',
    ownership: 'qaai',
    repairable: false,
    blocksWebsiteVerdict: false,
    message: 'Package validation failed. QAAI is holding the export because generated files are not certified runnable.',
  },
  codegen_diagnostics: {
    layer: 'codegen',
    ownership: 'qaai',
    repairable: false,
    blocksWebsiteVerdict: false,
    message: 'Generated code did not pass certification diagnostics. QAAI is holding output instead of shipping broken test files.',
  },
  certification_finding: {
    layer: 'certification',
    ownership: 'qaai',
    repairable: false,
    blocksWebsiteVerdict: false,
    message: 'A certification gate produced an error finding. QAAI is holding the website verdict until the platform evidence is clean.',
  },
  missing_website_failure_proof: {
    layer: 'verdict',
    ownership: 'qaai',
    repairable: false,
    message: 'The case status is fail, but QAAI does not have a recorded failing assertion outcome. This cannot be reported as a website defect.',
  },
  not_exportable: {
    layer: 'certification',
    ownership: 'qaai',
    repairable: false,
    blocksWebsiteVerdict: false,
    message: 'QAAI marked this case as not exportable because internal certification evidence is missing or incomplete.',
  },
};

const INTERNAL_PREFIXES = [
  'unknown_',
  'qaai_',
  'replayir_',
  'package_',
  'codegen_',
  'locator_',
  'ratification_',
  'certification_',
];

function gapCode(gap) {
  return String(gap?.type || gap?.code || gap?.reason || '').trim() || 'not_exportable';
}

function catalogFor(code) {
  return GAP_CATALOG[code] || GAP_CATALOG.not_exportable;
}

function gapMessage(code, gap = {}) {
  if (gap && gap.description) return String(gap.description);
  if (gap && gap.detail) return String(gap.detail);
  return catalogFor(code).message;
}

function normalizeGap(gap = {}, defaults = {}) {
  const code = gapCode(gap) || gapCode(defaults);
  const catalog = catalogFor(code);
  const layer = gap.layer || defaults.layer || catalog.layer || 'certification';
  return {
    type: code,
    code,
    layer,
    ownership: gap.ownership || defaults.ownership || catalog.ownership || 'qaai',
    severity: gap.severity || defaults.severity || 'error',
    repairable: gap.repairable != null ? !!gap.repairable : !!catalog.repairable,
    blocksWebsiteVerdict: gap.blocksWebsiteVerdict != null
      ? !!gap.blocksWebsiteVerdict
      : catalog.blocksWebsiteVerdict != null
        ? !!catalog.blocksWebsiteVerdict
        : true,
    description: gapMessage(code, gap),
    pageUrl: gap.pageUrl || defaults.pageUrl || null,
    where: gap.where || defaults.where || null,
    evidenceRef: gap.evidenceRef || defaults.evidenceRef || null,
  };
}

function buildUnknownGap({ layer = 'platform', where = null, error = null, detail = null, evidenceRef = null } = {}) {
  const safeLayer = String(layer || 'platform').replace(/[^a-z0-9_]+/gi, '_').toLowerCase();
  const message = detail || (error && (error.message || String(error))) || 'QAAI hit an unclassified platform condition.';
  return normalizeGap({
    type: `unknown_${safeLayer}_gap`,
    layer: safeLayer,
    ownership: 'qaai',
    severity: 'error',
    repairable: false,
    blocksWebsiteVerdict: true,
    description: `QAAI hit an unclassified ${safeLayer} condition: ${String(message).slice(0, 500)}`,
    where,
    evidenceRef,
  });
}

function isInternalCertificationGap(gapOrCode) {
  const code = typeof gapOrCode === 'string' ? gapOrCode : gapCode(gapOrCode);
  const catalog = catalogFor(code);
  if (catalog.ownership === 'qaai') return true;
  return INTERNAL_PREFIXES.some((p) => code.startsWith(p));
}

function parseObject(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function collectReplayGaps(replayEnvelope) {
  const env = parseObject(replayEnvelope);
  if (!env) return [normalizeGap({ type: 'replayir_missing' })];
  if (env.complete === false) {
    const gaps = Array.isArray(env.gaps) && env.gaps.length ? env.gaps : [{ code: 'replayir_incomplete' }];
    return gaps.map((g) => normalizeGap(g, { layer: 'replayir' }));
  }
  return [];
}

function collectExportMetaGaps(exportMeta) {
  const meta = parseObject(exportMeta);
  if (!meta || !['not_exportable', 'repairing', 'incomplete_evidence'].includes(String(meta.state || ''))) return [];
  const gaps = Array.isArray(meta.gaps) && meta.gaps.length ? meta.gaps : [{ type: meta.state }];
  return gaps.map((g) => normalizeGap(g));
}

function collectPackageGaps(validation) {
  if (!validation) return [];
  if (validation.skipped) return [normalizeGap({ type: 'package_validation_skipped', detail: validation.reason || null })];
  if (validation.packagePassed === false) return [normalizeGap({ type: 'package_validation_failed', detail: validation.error || null })];
  return [];
}

function outcomeStatus(outcome) {
  if (outcome && outcome.matched === false) return 'not_matched';
  if (outcome && outcome.matched === true) return 'matched';
  return String(outcome?.status || outcome?.outcome || outcome?.result || '').toLowerCase();
}

function hasFailingAssertionEvidence({ replayEnvelope = null, assertionOutcomes = [] } = {}) {
  const direct = Array.isArray(assertionOutcomes) ? assertionOutcomes : [];
  if (direct.some((o) => ['not_matched', 'fail', 'failed'].includes(outcomeStatus(o)))) return true;
  const env = parseObject(replayEnvelope);
  const verdict = env?.verdict || env?.ir?.verdict || null;
  const per = Array.isArray(verdict?.perAssertionOutcomes) ? verdict.perAssertionOutcomes : [];
  return per.some((o) => ['not_matched', 'fail', 'failed'].includes(outcomeStatus(o)));
}

function verdictFirewall({
  intendedStatus = null,
  replayEnvelope = null,
  exportMeta = null,
  packageValidation = null,
  codegenDiagnostics = null,
  findings = [],
  assertionOutcomes = [],
} = {}) {
  const gaps = [
    ...collectExportMetaGaps(exportMeta),
    ...collectReplayGaps(replayEnvelope),
    ...collectPackageGaps(packageValidation),
  ];

  if (codegenDiagnostics) {
    gaps.push(normalizeGap({ type: 'codegen_diagnostics', detail: String(codegenDiagnostics).slice(0, 500) }));
  }

  for (const f of Array.isArray(findings) ? findings : []) {
    if (f && f.severity === 'error') {
      gaps.push(normalizeGap({
        type: f.rule || 'certification_finding',
        layer: 'certification',
        description: f.message || GAP_CATALOG.certification_finding.message,
      }));
    }
  }

  const status = String(intendedStatus || '').toLowerCase();
  const failingEvidence = hasFailingAssertionEvidence({ replayEnvelope, assertionOutcomes });
  if (status === 'fail' && !failingEvidence) {
    gaps.push(normalizeGap({ type: 'missing_website_failure_proof' }));
  }

  const internalGaps = gaps
    .filter(isInternalCertificationGap)
    .filter((g) => g.blocksWebsiteVerdict !== false);
  if (internalGaps.length) {
    return {
      websiteVerdictAllowed: false,
      classification: 'internal_certification_gap',
      finalStatus: 'blocked',
      gaps: internalGaps,
      humanMessage: internalGaps[0].description,
    };
  }

  if (status === 'fail') {
    return {
      websiteVerdictAllowed: true,
      classification: 'website_failure',
      finalStatus: 'fail',
      gaps: [],
      humanMessage: 'Website failure is allowed because QAAI has certified failing assertion evidence and no internal certification gaps.',
    };
  }

  if (status === 'pass') {
    return {
      websiteVerdictAllowed: true,
      classification: 'website_pass',
      finalStatus: 'pass',
      gaps: [],
      humanMessage: 'Website pass is allowed because QAAI has no internal certification gaps for this result.',
    };
  }

  return {
    websiteVerdictAllowed: false,
    classification: 'internal_certification_gap',
    finalStatus: 'blocked',
    gaps: [buildUnknownGap({ layer: 'verdict', detail: `Unsupported or missing intended status: ${intendedStatus || '(empty)'}` })],
    humanMessage: 'QAAI could not certify a website verdict from the recorded status.',
  };
}

module.exports = {
  GAP_CATALOG,
  gapCode,
  gapMessage,
  normalizeGap,
  buildUnknownGap,
  isInternalCertificationGap,
  collectReplayGaps,
  collectExportMetaGaps,
  collectPackageGaps,
  hasFailingAssertionEvidence,
  verdictFirewall,
};
