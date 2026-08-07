'use strict';

/**
 * Reconcile evidence with the files that were actually emitted.
 * This layer never discovers or upgrades locators: trust can only come from
 * strict action-time proof already present in the emitted locator manifest.
 */

const POM_ADAPTER_IDS = new Set(['playwright-pom', 'playwright-pom-js']);
const LOCATOR_REPORT_SCHEMA = 'qaai-locator-certification-report/1';
const DOM_ATLAS_SCHEMA = 'qaai-dom-atlas-v1';
const POM_REPORT_SCHEMA = 'qaai-pom-architect-v1';

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(String(value || ''));
  } catch (_) {
    return fallback;
  }
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function text(value) {
  return String(value == null ? '' : value).trim();
}

function locatorExpression(entry) {
  return text(entry && (entry.expr || entry.expression || entry.locator));
}

function locatorProof(entry) {
  return entry && typeof entry === 'object'
    ? (entry.proof || entry.verificationProof || {})
    : {};
}

function locatorSource(entry) {
  const proof = locatorProof(entry);
  return text(entry && (
    entry.verificationSource ||
    entry.evidenceSource ||
    entry.source ||
    proof.source
  ));
}

function isAuthoredAssertionContractLocator(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const provenance = entry.locatorProvenance || entry.provenance || {};
  return [
    entry.source,
    entry.verificationSource,
    provenance.kind,
    provenance.source,
  ].some((value) => text(value).toLowerCase().replace(/[^a-z0-9]+/g, '') === 'authoredassertioncontract');
}

function identityMatches(proof) {
  if (!proof || proof.identityVerified !== true) return false;
  const target = proof.targetIdentity;
  const matched = proof.matchedIdentity;
  if (!target || !matched || typeof target !== 'object' || typeof matched !== 'object') return false;
  if (target.backendNodeId != null || matched.backendNodeId != null) {
    return Number(target.backendNodeId) === Number(matched.backendNodeId)
      && (!target.frameId || !matched.frameId || String(target.frameId) === String(matched.frameId));
  }
  if (target.nodeId != null || matched.nodeId != null) {
    return String(target.nodeId || '') === String(matched.nodeId || '')
      && (!target.documentId || !matched.documentId || String(target.documentId) === String(matched.documentId));
  }
  return false;
}

function isAuthoritativeVerifiedLocator(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const proof = locatorProof(entry);
  const status = text(entry.verificationStatus || entry.status).toLowerCase();
  const source = locatorSource(entry).toLowerCase();
  if (!locatorExpression(entry) || !text(entry.file || entry.locatorFile) || !text(entry.name || entry.locatorName)) return false;
  if (entry.guessed === true || entry.guessedLocator === true || /guess|unverified/.test(source)) return false;
  return entry.verified === true
    && (status === 'verified' || status === 'certified')
    && proof.sameElement === true
    && Number(proof.count) === 1
    && proof.actionTimeResolved === true
    && identityMatches(proof);
}

function locatorStrategy(expression) {
  const match = text(expression).match(/(?:page\.)?(getByTestId|getByRole|getByLabel|getByPlaceholder|getByText|locator)\s*\(/);
  return match ? match[1] : 'playwright';
}

function manifestEntries(files) {
  const parsed = parseJson(files && files['evidence/locator-manifest.json'], []);
  if (Array.isArray(parsed)) return parsed;
  return Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
}

function locatorReason(entry, verified) {
  if (verified) return 'The emitted locator resolves uniquely to the exact action-time browser node.';
  const provenance = entry && (entry.provenance || entry.locatorProvenance) || {};
  const gap = provenance.actionLocatorGap || {};
  return text(
    entry && (entry.warning || entry.reason) ||
    provenance.warning ||
    gap.message ||
    gap.code ||
    'The emitted locator was not verified against the exact action-time browser node.',
  );
}

function locatorCertificationFromManifest(entries) {
  const steps = entries.map((entry, index) => {
    const verified = isAuthoritativeVerifiedLocator(entry);
    const authoredAssertionContract = !verified && isAuthoredAssertionContractLocator(entry);
    const expression = locatorExpression(entry);
    const reason = authoredAssertionContract
      ? 'The locator is derived from an authored assertion contract. It is not action-time verified browser evidence and remains non-blocking.'
      : locatorReason(entry, verified);
    return {
      replayStepIndex: index,
      replayRef: entry.as || entry.name || null,
      action: null,
      stepAuthoringId: entry.contractStepId || entry.stepAuthoringId || null,
      locatorRecipeId: entry.locatorRecipeId || null,
      elementLabel: entry.as || entry.name || null,
      narration: entry.narration || entry.as || entry.name || null,
      pageUrl: entry.pageUrl || locatorProof(entry).targetIdentity?.documentUrl || null,
      fingerprint: entry.fingerprint || null,
      locatorIdentity: {
        file: entry.file || entry.locatorFile || null,
        name: entry.name || entry.locatorName || null,
      },
      selected: {
        expression,
        strategy: entry.strategy || locatorStrategy(expression),
        source: locatorSource(entry) || null,
        score: entry.score == null ? null : Number(entry.score),
        confidence: verified ? 'certified' : (authoredAssertionContract ? 'authored' : 'draft'),
        certificationMode: verified
          ? 'action_time_same_node'
          : (authoredAssertionContract ? 'authored_assertion_contract' : 'unverified_fallback'),
        autoRepaired: entry.autoRepaired === true,
        repairedFrom: entry.repairedFrom || null,
        repairSource: entry.repairSource || null,
        provenance: clone(entry.locatorProvenance || entry.provenance || null),
        proof: clone(locatorProof(entry)),
        fingerprint: entry.fingerprint || null,
      },
      rejectedCandidates: [],
      candidates: [],
      weaknesses: verified || authoredAssertionContract ? [] : ['locator_not_action_time_verified'],
      repairAttempts: [],
      repairedLocator: null,
      repairRecommendation: verified || authoredAssertionContract ? null : reason,
      exportGate: {
        status: verified
          ? 'certified'
          : (authoredAssertionContract ? 'authored_assertion_contract' : 'draft'),
        reason,
        nonBlocking: !verified,
      },
    };
  });
  const certified = steps.filter((step) => step.exportGate.status === 'certified').length;
  const authoredAssertionContract = steps.filter(
    (step) => step.exportGate.status === 'authored_assertion_contract',
  ).length;
  const draft = steps.length - certified - authoredAssertionContract;
  return {
    schemaVersion: LOCATOR_REPORT_SCHEMA,
    source: 'emitted_locator_manifest',
    summary: {
      total: steps.length,
      certified,
      authoredAssertionContract,
      draft,
      blocked: 0,
      missing: 0,
      minScore: null,
      averageScore: null,
      status: steps.length === 0
        ? 'absent'
        : (draft > 0 ? 'draft' : (certified > 0 ? 'certified' : 'authored_assertion_contract')),
    },
    steps,
  };
}

function actionIdentity(entry) {
  return [
    text(entry.file || entry.locatorFile),
    text(entry.name || entry.locatorName),
    text(entry.contractStepId || entry.stepAuthoringId),
  ].join('\u0000');
}

function reconcileDomAtlas(files, entries) {
  const existing = parseJson(files['evidence/dom-atlas.json'], null);
  const atlas = existing && typeof existing === 'object'
    ? clone(existing)
    : { schemaVersion: DOM_ATLAS_SCHEMA, pages: {} };
  atlas.schemaVersion = atlas.schemaVersion || DOM_ATLAS_SCHEMA;
  if (!atlas.pages || typeof atlas.pages !== 'object' || Array.isArray(atlas.pages)) atlas.pages = {};

  for (const entry of entries.filter(isAuthoritativeVerifiedLocator)) {
    const proof = locatorProof(entry);
    const pageKey = text(entry.pageKey || proof.targetIdentity?.documentUrl || entry.pageUrl) || '/';
    const page = atlas.pages[pageKey] && typeof atlas.pages[pageKey] === 'object'
      ? atlas.pages[pageKey]
      : {
          schemaVersion: DOM_ATLAS_SCHEMA,
          pageKey,
          routeKey: pageKey,
          url: proof.targetIdentity?.documentUrl || entry.pageUrl || null,
          title: null,
          controls: [], forms: [], tables: [], dialogs: [], landmarks: [],
          frames: [], shadowHosts: [], headings: [], verifiedActions: [],
        };
    const verifiedActions = Array.isArray(page.verifiedActions) ? page.verifiedActions : [];
    const key = actionIdentity(entry);
    if (!verifiedActions.some((item) => actionIdentity(item) === key)) {
      verifiedActions.push({
        file: entry.file || entry.locatorFile || null,
        name: entry.name || entry.locatorName || null,
        contractStepId: entry.contractStepId || entry.stepAuthoringId || null,
        expression: locatorExpression(entry),
        selector: locatorExpression(entry),
        strategy: entry.strategy || locatorStrategy(locatorExpression(entry)),
        verificationSource: locatorSource(entry) || null,
        evidenceSource: entry.evidenceSource || locatorSource(entry) || null,
        verified: true,
        verificationStatus: 'verified',
        proof: clone(proof),
      });
    }
    page.verifiedActions = verifiedActions;
    page.counts = {
      ...(page.counts || {}),
      controls: Array.isArray(page.controls) ? page.controls.length : Number(page.counts?.controls || 0),
      verifiedActions: verifiedActions.length,
    };
    atlas.pages[pageKey] = page;
  }
  return atlas;
}

function emittedPomPages(files) {
  const pages = {};
  for (const [file, source] of Object.entries(files || {})) {
    if (!/^pages\/.+\.(?:cjs|js|mjs|ts)$/i.test(file) || typeof source !== 'string') continue;
    const className = source.match(/export\s+class\s+([A-Za-z_$][\w$]*)/)?.[1]
      || source.match(/class\s+([A-Za-z_$][\w$]*)/)?.[1]
      || file.split('/').pop().replace(/\.[^.]+$/, '');
    const methods = [];
    const pattern = /^\s{2}async\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      methods.push({
        name: match[1],
        parameters: text(match[2]),
        kind: /^(?:assert|expect|verify)/i.test(match[1]) ? 'assertion' : 'action',
        source: 'emitted_page_source',
      });
    }
    pages[className] = {
      className,
      file,
      architectMethods: methods,
      generatedMethodCount: methods.length,
    };
  }
  return pages;
}

function reconcilePomArchitect(files) {
  const existing = parseJson(files['evidence/pom-architect-report.json'], {});
  const pages = emittedPomPages(files);
  const specFiles = Object.keys(files || {})
    .filter((file) => /^tests\/.+\.spec\.(?:cjs|js|mjs|ts)$/i.test(file))
    .sort();
  const detailedSpecPlan = (Array.isArray(existing?.specPlan) ? existing.specPlan : [])
    .filter((entry) => entry && entry.emittedSource && specFiles.some((file) =>
      String(files[file] || '').includes(String(entry.emittedSource).trim())));
  return {
    ...(existing && typeof existing === 'object' ? existing : {}),
    schemaVersion: existing?.schemaVersion || POM_REPORT_SCHEMA,
    mode: existing?.mode || 'deterministic',
    source: 'emitted_page_source',
    pages,
    generatedMethodCount: Object.values(pages).reduce(
      (count, page) => count + Number(page.generatedMethodCount || 0), 0,
    ),
    specPlan: detailedSpecPlan.length
      ? detailedSpecPlan.map((entry) => ({ ...entry, source: 'emitted_spec_source' }))
      : specFiles.map((file) => ({ file, source: 'emitted_spec_source' })),
    rejectedAbstractions: Array.isArray(existing?.rejectedAbstractions)
      ? existing.rejectedAbstractions : [],
  };
}

function reconcileCertificationSummary(files, locatorReport, domAtlas, pomReport) {
  const report = parseJson(files['evidence/certification-report.json'], {});
  return {
    ...(report && typeof report === 'object' ? report : {}),
    evidence: {
      ...((report && report.evidence) || {}),
      'dom-atlas.json': {
        status: 'present',
        pageCount: Object.keys(domAtlas.pages || {}).length,
        verifiedActionCount: Object.values(domAtlas.pages || {}).reduce(
          (count, page) => count + (Array.isArray(page?.verifiedActions) ? page.verifiedActions.length : 0), 0,
        ),
      },
      'locator-certification-report.json': {
        status: locatorReport.summary.status,
        stepCount: locatorReport.summary.total,
        certified: locatorReport.summary.certified,
        authoredAssertionContract: locatorReport.summary.authoredAssertionContract,
        draft: locatorReport.summary.draft,
        blocked: locatorReport.summary.blocked,
      },
      'pom-architect-report.json': {
        status: 'present',
        methodCount: pomReport.generatedMethodCount,
        pageCount: Object.keys(pomReport.pages || {}).length,
      },
    },
  };
}

function reconcileGeneratedEvidence({ files = {}, adapterId = null } = {}) {
  if (!POM_ADAPTER_IDS.has(adapterId)) return files;
  const next = { ...files };
  const entries = manifestEntries(next);
  const locatorReport = locatorCertificationFromManifest(entries);
  const domAtlas = reconcileDomAtlas(next, entries);
  const pomReport = reconcilePomArchitect(next);
  const certification = reconcileCertificationSummary(next, locatorReport, domAtlas, pomReport);
  next['evidence/locator-certification-report.json'] = JSON.stringify(locatorReport, null, 2) + '\n';
  next['evidence/dom-atlas.json'] = JSON.stringify(domAtlas, null, 2) + '\n';
  next['evidence/pom-architect-report.json'] = JSON.stringify(pomReport, null, 2) + '\n';
  next['evidence/certification-report.json'] = JSON.stringify(certification, null, 2) + '\n';
  return next;
}

module.exports = {
  isAuthoritativeVerifiedLocator,
  locatorCertificationFromManifest,
  reconcileDomAtlas,
  emittedPomPages,
  reconcilePomArchitect,
  reconcileGeneratedEvidence,
};
