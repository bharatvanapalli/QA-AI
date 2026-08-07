'use strict';

const SCHEMA = 'qaai-script-round-trip-parity/1';

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function readJsonFile(files, rel, fallback = null) {
  if (!files || typeof files !== 'object') return fallback;
  return parseJson(files[rel], fallback);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function replayActionCount(ir) {
  const steps = asArray(ir && ir.steps);
  return steps.filter((step) => step && (step.op === 'act' || step.op === 'assert')).length;
}

function replayAssertionCount(ir) {
  return asArray(ir && ir.steps).filter((step) => step && step.op === 'assert').length;
}

function replayNavigationUrls(ir) {
  return asArray(ir && ir.steps)
    .filter((step) => step && step.op === 'act' && step.action === 'navigate' && step.url)
    .map((step) => String(step.url));
}

function bundleContainsLiteral(files, value) {
  const expected = String(value || '');
  if (!expected) return false;
  return Object.values(files || {}).some((content) => (
    typeof content === 'string' && content.includes(expected)
  ));
}

function currentStepParity(caseEntry) {
  if (!caseEntry || typeof caseEntry !== 'object') return null;
  const rows = asArray(caseEntry.ledger);
  if (!rows.length) return null;
  const unresolved = rows.filter((row) => (
    !row || row.exportStatus !== 'exported' || row.status === 'requires_repair'
  ));
  return {
    rows,
    complete: unresolved.length === 0,
    unresolved,
    assertionCount: rows.filter((row) => row.replayOp === 'assert').length,
  };
}

function isLocatorOnlyGap(item) {
  const code = String(item && (item.code || item.type || item.rule) || '').toLowerCase();
  return /locator|target_resolution|excavation/.test(code)
    && !/runtime_ref|\[ref|secret|syntax|method|step_parity|assertion|action_evidence/.test(code);
}

function guessedResolveCount(ir) {
  return asArray(ir && ir.steps).filter((step) => step && step.op === 'resolve' && (
    step.guessedLocator === true
    || step.locatorConfidence === 'guessed'
    || step.locatorProvenance?.kind === 'qaai_guessed_locator'
    || asArray(step.candidates).some((candidate) => candidate && candidate.provenance === 'qaai_guessed_locator')
  )).length;
}

function keyFor(item) {
  return String(item && (item.runResultId || item.testCaseId || item.caseName || '') || '');
}

function byKey(items = []) {
  const map = new Map();
  for (const item of asArray(items)) {
    const keys = [
      item && item.runResultId,
      item && item.testCaseId,
      item && item.caseName,
    ].filter(Boolean).map(String);
    for (const key of keys) {
      if (!map.has(key)) map.set(key, item);
    }
  }
  return map;
}

function finding(rule, message, extra = {}) {
  return {
    rule,
    severity: 'error',
    message,
    ...extra,
  };
}

function normalizedLedger(raw) {
  const ledger = raw && raw.ledger ? raw.ledger : raw;
  if (!ledger || typeof ledger !== 'object') return null;
  return {
    ...ledger,
    plannedExecutableStepCount: Number(ledger.plannedExecutableStepCount || 0),
    actionEvidenceCount: Number(ledger.actionEvidenceCount || 0),
    replayIrActionCount: Number(ledger.replayIrActionCount || 0),
    compiledActionCount: Number(ledger.compiledActionCount || 0),
    generatedMethodCount: Number(ledger.generatedMethodCount || 0),
    validatedActionCount: Number(ledger.validatedActionCount || 0),
    plannedAssertionCount: Number(ledger.plannedAssertionCount || 0),
    assertionEvidenceCount: Number(ledger.assertionEvidenceCount || 0),
    finalAssertionEvidenceCount: Number(ledger.finalAssertionEvidenceCount || 0),
    missingEvidenceCount: Number(ledger.missingEvidenceCount || 0),
    missingLocatorCount: Number(ledger.missingLocatorCount || 0),
    missingActionEvidenceCount: Number(ledger.missingActionEvidenceCount || 0),
    missingAssertionCount: Number(ledger.missingAssertionCount || 0),
    parseFailedAssertionCount: Number(ledger.parseFailedAssertionCount || 0),
    missingNavigationEvidenceCount: Number(ledger.missingNavigationEvidenceCount || 0),
    missingAuthSetupCount: Number(ledger.missingAuthSetupCount || 0),
    manualGateCount: Number(ledger.manualGateCount || 0),
  };
}

function validateBundleRoundTrip({ files = {}, validationSummary = null } = {}) {
  const evidence = readJsonFile(files, 'evidence/action-evidence.json', null);
  const replay = readJsonFile(files, 'evidence/replayir.json', null);
  const ledgerFile = readJsonFile(files, 'evidence/completeness-ledger.json', null);
  const stepParityFile = readJsonFile(files, 'evidence/step-parity-report.json', null);
  const manifest = readJsonFile(files, 'EXPORT_MANIFEST.json', null);
  const findings = [];

  if (!evidence || !replay || !ledgerFile) {
    findings.push(finding(
      'round_trip_evidence_files_missing',
      'Script certification requires action evidence, ReplayIR evidence, and completeness ledger files in the bundle.',
      {
        hasActionEvidence: !!evidence,
        hasReplayIr: !!replay,
        hasCompletenessLedger: !!ledgerFile,
      },
    ));
    return {
      schema: SCHEMA,
      ok: false,
      findings,
      summary: {
        resultCount: 0,
        checked: false,
        validationSummary,
      },
    };
  }

  const ledgers = asArray(ledgerFile.ledgers);
  const replayEntries = asArray(replay.replayIr);
  const evidenceEntries = asArray(evidence.entries);
  const replayByKey = byKey(replayEntries);
  const evidenceByKey = byKey(evidenceEntries);
  const stepParityByKey = byKey(asArray(stepParityFile && stepParityFile.cases));

  for (const item of ledgers) {
    const ledger = normalizedLedger(item);
    if (!ledger) {
      findings.push(finding('round_trip_ledger_malformed', 'Completeness ledger entry is malformed.', { entry: item }));
      continue;
    }
    const runResultId = item.runResultId || ledger.runResultId || null;
    const testCaseId = item.testCaseId || ledger.testCaseId || null;
    const caseName = item.caseName || ledger.caseName || null;
    const lookup = [runResultId, testCaseId, caseName].filter(Boolean).map(String);
    const replayEntry = lookup.map((key) => replayByKey.get(key)).find(Boolean);
    const evidenceEntry = lookup.map((key) => evidenceByKey.get(key)).find(Boolean);
    const stepParityEntry = lookup.map((key) => stepParityByKey.get(key)).find(Boolean);
    const finalParity = currentStepParity(stepParityEntry);
    const occurrenceParity = replayEntry && (
      replayEntry.authoredOccurrenceParity || replayEntry.ir && replayEntry.ir.authoredOccurrenceParity
    );
    const guesses = guessedResolveCount(replayEntry && replayEntry.ir);
    const nonLocatorMissing = ledger.missingActionEvidenceCount
      + ledger.missingAssertionCount
      + ledger.parseFailedAssertionCount
      + ledger.missingNavigationEvidenceCount
      + ledger.missingAuthSetupCount;
    const locatorOnlyMissing = ledger.missingLocatorCount > 0
      && nonLocatorMissing === 0
      && guesses >= ledger.missingLocatorCount;
    if (ledger.evidenceStatus !== 'complete' || ledger.missingEvidenceCount > 0) {
      findings.push(finding(
        locatorOnlyMissing ? 'round_trip_locator_evidence_guessed' : 'round_trip_evidence_incomplete',
        locatorOnlyMissing
          ? 'Durable DOM locator evidence was unavailable; QAAI kept the complete script and emitted editable guessed locators.'
          : 'Generated script has incomplete non-locator capture-first evidence.',
        { runResultId, testCaseId, caseName, ledger, severity: locatorOnlyMissing ? 'warning' : 'error', nonBlocking: locatorOnlyMissing },
      ));
    }
    if (ledger.manualGateCount > 0) {
      findings.push(finding(
        'round_trip_manual_gate_unresolved',
        'Manual gates prevent full script certification unless resolved by an approved fixture or hook.',
        { runResultId, testCaseId, caseName, manualGateCount: ledger.manualGateCount },
      ));
    }
    if (!finalParity && ledger.plannedExecutableStepCount !== ledger.actionEvidenceCount) {
      findings.push(finding(
        'round_trip_action_evidence_count_mismatch',
        'Planned exportable steps and captured ActionEvidence count do not match.',
        { runResultId, testCaseId, caseName, planned: ledger.plannedExecutableStepCount, captured: ledger.actionEvidenceCount },
      ));
    }
    if (!finalParity && ledger.plannedAssertionCount !== ledger.assertionEvidenceCount) {
      findings.push(finding(
        'round_trip_assertion_evidence_count_mismatch',
        'Planned assertions and captured AssertionEvidence count do not match.',
        { runResultId, testCaseId, caseName, planned: ledger.plannedAssertionCount, captured: ledger.assertionEvidenceCount },
      ));
    }
    if (!finalParity && ledger.plannedAssertionCount > 0 && ledger.finalAssertionEvidenceCount <= 0) {
      findings.push(finding(
        'round_trip_final_assertion_missing',
        'A case with planned assertions must have final assertion evidence before certification.',
        { runResultId, testCaseId, caseName },
      ));
    }
    if (finalParity && !finalParity.complete) {
      findings.push(finding(
        'round_trip_step_parity_incomplete',
        'Final generated step parity contains authored operations that were not emitted.',
        { runResultId, testCaseId, caseName, unresolved: finalParity.unresolved },
      ));
    }
    if (occurrenceParity && occurrenceParity.satisfied !== true) {
      findings.push(finding(
        'round_trip_occurrence_identity_mismatch',
        'Persisted authored occurrences and ReplayIR occurrences do not reconcile by stable identity.',
        { runResultId, testCaseId, caseName, authoredOccurrenceParity: occurrenceParity },
      ));
    }
    const replayGaps = asArray(replayEntry && replayEntry.gaps);
    const blockingReplayGaps = replayGaps.filter((gap) => !isLocatorOnlyGap(gap));
    const locatorReplayGaps = replayGaps.filter(isLocatorOnlyGap);
    const coveredLocatorReplayGaps = locatorReplayGaps.length > 0 && guesses > 0;
    if (!replayEntry || blockingReplayGaps.length > 0 || (replayEntry.complete !== true && !coveredLocatorReplayGaps)) {
      findings.push(finding(
        'round_trip_replayir_incomplete',
        'ReplayIR has incomplete non-locator evidence.',
        { runResultId, testCaseId, caseName, complete: replayEntry && replayEntry.complete, gaps: blockingReplayGaps },
      ));
    } else if (coveredLocatorReplayGaps) {
      findings.push(finding(
        'round_trip_locator_gaps_guessed',
        'ReplayIR locator gaps are represented by editable QAAI-guessed locators.',
        { runResultId, testCaseId, caseName, gaps: locatorReplayGaps, severity: 'warning', nonBlocking: true },
      ));
    }
    const replayCount = replayEntry ? replayActionCount(replayEntry.ir) : 0;
    if (!finalParity && ledger.actionEvidenceCount !== replayCount) {
      findings.push(finding(
        'round_trip_replay_action_count_mismatch',
        'Captured ActionEvidence count does not match ReplayIR action/assertion count.',
        { runResultId, testCaseId, caseName, actionEvidenceCount: ledger.actionEvidenceCount, replayIrActionCount: replayCount },
      ));
    }
    const replayAssertions = replayEntry ? replayAssertionCount(replayEntry.ir) : 0;
    if (!finalParity && ledger.assertionEvidenceCount !== replayAssertions) {
      findings.push(finding(
        'round_trip_replay_assertion_count_mismatch',
        'Captured AssertionEvidence count does not match ReplayIR assertion count.',
        { runResultId, testCaseId, caseName, assertionEvidenceCount: ledger.assertionEvidenceCount, replayIrAssertionCount: replayAssertions },
      ));
    }
    if (evidenceEntry) {
      const locatorCount = asArray(evidenceEntry.locatorRecipes).length;
      const locatorRequired = asArray(evidenceEntry.actionEvidences).filter((row) => {
        const kind = String(row && row.actionKind || '').toLowerCase();
        return !['navigate', 'assert'].includes(kind) && row && row.exportable !== false;
      }).length;
      if (locatorCount < locatorRequired) {
        const guessedCoverage = guesses >= (locatorRequired - locatorCount);
        findings.push(finding(
          guessedCoverage ? 'round_trip_locator_identity_guessed' : 'round_trip_locator_identity_missing',
          guessedCoverage
            ? 'One or more DOM actions use editable QAAI-guessed locators instead of durable LocatorRecipe rows.'
            : 'A DOM action has neither a durable LocatorRecipe nor a generated guessed locator.',
          { runResultId, testCaseId, caseName, locatorRequired, locatorCount, guessedLocatorCount: guesses, severity: guessedCoverage ? 'warning' : 'error', nonBlocking: guessedCoverage },
        ));
      }
      const replayUrls = replayEntry ? replayNavigationUrls(replayEntry.ir) : [];
      const navigationUrls = asArray(evidenceEntry.navigationEvidences)
        .map((row) => row && (row.resolvedUrl || row.requestedUrl))
        .filter(Boolean)
        .map(String);
      for (const url of navigationUrls) {
        if (!replayUrls.includes(url) && !bundleContainsLiteral(files, url)) {
          findings.push(finding(
            'round_trip_navigation_transition_missing',
            'Navigation evidence URL is missing from generated ReplayIR transitions.',
            { runResultId, testCaseId, caseName, url },
          ));
        }
      }
    }
  }

  if (manifest && manifest.strictExport && manifest.strictExport.ok === false) {
    findings.push(finding(
      'round_trip_manifest_strict_export_failed',
      'EXPORT_MANIFEST strictExport must be ok before certification.',
      { rules: manifest.strictExport.rules || [] },
    ));
  }

  return {
    schema: SCHEMA,
    ok: !findings.some((item) => item && item.severity === 'error'),
    findings,
    summary: {
      resultCount: ledgers.length,
      replayResultCount: replayEntries.length,
      evidenceResultCount: evidenceEntries.length,
      validationSummary,
      checked: true,
    },
  };
}

module.exports = {
  SCHEMA,
  validateBundleRoundTrip,
  replayActionCount,
  replayAssertionCount,
};
