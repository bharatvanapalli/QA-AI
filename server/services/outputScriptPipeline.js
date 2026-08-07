'use strict';

const crypto = require('crypto');

const actionLocatorResolver = require('./actionLocatorResolver');
const liveScriptRecorder = require('./liveScriptRecorder');
const playwrightPom = require('./codegen/adapters/playwrightPom');
const playwrightPomJs = require('./codegen/adapters/playwrightPomJs');
const playwrightReference = require('./codegen/adapters/playwrightReference');

function sha1(value) {
  return crypto
    .createHash('sha1')
    .update(String(value == null ? '' : value))
    .digest('hex')
    .slice(0, 10);
}

function slug(value, fallback = 'test-case') {
  const out = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return out || fallback;
}

function words(value, fallback = 'item') {
  const parts =
    String(value || '')
      .toLowerCase()
      .match(/[a-z0-9]+/g) || [];
  return parts.length ? parts : [fallback];
}

function pascal(value, fallback = 'Item') {
  return words(value, fallback)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function camel(value, fallback = 'item') {
  const p = pascal(value, fallback);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

function jsLiteral(value) {
  return JSON.stringify(String(value == null ? '' : value));
}

function safeComment(value) {
  return String(value == null ? '' : value)
    .replace(/\r?\n/g, ' ')
    .replace(/\*\//g, '* /')
    .trim();
}

function arrayOf(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function decodeMaybe(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch (_) {
    return fallback;
  }
}

function normalizeLocatorExpression(expression) {
  const raw = String(expression || '').trim();
  if (!raw) return null;
  if (/^page\./.test(raw)) return raw;
  if (
    /^(?:locator|getByRole|getByLabel|getByPlaceholder|getByText|getByTestId|getByTitle|getByAltText|frameLocator)\s*\(/.test(
      raw,
    )
  ) {
    return `page.${raw}`;
  }
  if (/^(?:css=|xpath=|text=|#[\w-]+|\.[\w-]+|\[.+\]|\/{1,2})/.test(raw)) {
    return `page.locator(${jsLiteral(raw)})`;
  }
  return `page.locator(${jsLiteral(raw)})`;
}

function locatorExpressionFromActionLocator(actionLocator) {
  const primary = actionLocatorResolver.primaryActionLocator(actionLocator);
  const expression =
    primary && (primary.frameworkExpressions?.playwright || primary.expression || primary.selector);
  return normalizeLocatorExpression(expression);
}

function locatorExpressionFromLoose(value) {
  if (!value || typeof value !== 'object') return null;
  return (
    locatorExpressionFromActionLocator(value.actionLocator) ||
    normalizeLocatorExpression(value.frameworkExpressions?.playwright) ||
    normalizeLocatorExpression(value.expression) ||
    normalizeLocatorExpression(value.selector) ||
    normalizeLocatorExpression(value.locator) ||
    normalizeLocatorExpression(value.playwright)
  );
}

function collectResolveLocators(irSteps = []) {
  const byName = new Map();
  for (const step of irSteps) {
    if (!step || step.op !== 'resolve') continue;
    const as = step.as || step.name || step.target || step.id;
    const expression =
      locatorExpressionFromActionLocator(step.actionLocator) || locatorExpressionFromLoose(step);
    if (as && expression) byName.set(String(as), expression);
  }
  return byName;
}

function collectActionGraphLocators(actionGraph) {
  const graph = decodeMaybe(actionGraph, null);
  const byKey = new Map();
  const nodes = [
    ...arrayOf(graph && graph.nodes),
    ...arrayOf(graph && graph.actions),
    ...arrayOf(graph && graph.steps),
    ...arrayOf(graph && graph.edges),
  ];
  for (const node of nodes) {
    const expression = locatorExpressionFromLoose(node);
    if (!expression) continue;
    const keys = [
      node.id,
      node.stepId,
      node.stepAuthoringId,
      node.target,
      node.element,
      node.label,
      node.name,
      node.as,
    ]
      .filter(Boolean)
      .map(String);
    for (const key of keys) byKey.set(key, expression);
  }
  return byKey;
}

function locatorForStep(step, resolveLocators, graphLocators) {
  return (
    locatorExpressionFromActionLocator(step && step.actionLocator) ||
    locatorExpressionFromLoose(step) ||
    (step && step.target ? resolveLocators.get(String(step.target)) : null) ||
    (step && step.stepAuthoringId ? graphLocators.get(String(step.stepAuthoringId)) : null) ||
    (step && step.id ? graphLocators.get(String(step.id)) : null) ||
    (step && step.target ? graphLocators.get(String(step.target)) : null) ||
    null
  );
}

function envNameFromRef(ref) {
  const raw = String(ref || '').trim();
  const m = raw.match(/^(?:env|vault|fixture|masked|data):(.+)$/i);
  const body = (m ? m[1] : raw).replace(/[{}]/g, '');
  const safe =
    body
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'VALUE';
  if (/^vault:/i.test(raw)) return `QAAI_VAULT_${safe}`;
  if (/^fixture:/i.test(raw)) return `QAAI_FIXTURE_${safe}`;
  if (/^masked:/i.test(raw)) return `QAAI_MASKED_${safe}`;
  if (/^data:/i.test(raw)) return `QAAI_DATA_${safe}`;
  return safe;
}

function valueExpressionForStep(step) {
  if (!step || typeof step !== 'object') return 'runtimeValue("QAAI_VALUE")';
  const ref = step.valueRef || step.valueToken || step.dataRole || step.fieldRole || step.role;
  if (ref) return `runtimeValue(${jsLiteral(envNameFromRef(ref))})`;
  if (step.rawValue != null)
    return `runtimeValue(${jsLiteral(`QAAI_LITERAL_${sha1(step.rawValue)}`)}, ${jsLiteral('[redacted literal value]')})`;
  if (step.value != null)
    return `runtimeValue(${jsLiteral(`QAAI_VALUE_${sha1(step.value)}`)}, ${jsLiteral('[redacted value]')})`;
  return 'runtimeValue("QAAI_VALUE")';
}

function actionLinesForIrStep(step, index, locatorExpr) {
  const action = String(
    (step && (step.action || step.type || step.tool || '')) || '',
  ).toLowerCase();
  const label = safeComment(
    step && (step.label || step.element || step.target || step.action || `step ${index + 1}`),
  );
  const linePrefix = `  // ${index + 1}. ${label || 'Recorded action'}`;
  if (action === 'navigate' || action === 'goto' || action === 'open') {
    const url = step.url || step.href || step.targetUrl || step.target || '';
    return [
      linePrefix,
      `  await page.goto(${url ? jsLiteral(url) : 'process.env.QAAI_TARGET_URL || "about:blank"'});`,
    ];
  }
  if (!locatorExpr) {
    return [
      linePrefix,
      `  // TODO locator: ${safeComment(step && (step.target || step.element || step.label || 'unresolved target'))}`,
    ];
  }
  if (action === 'click' || action === 'tap' || action === 'pressbutton' || action === 'submit') {
    return [linePrefix, `  await ${locatorExpr}.click();`];
  }
  if (action === 'fill' || action === 'type' || action === 'enter' || action === 'input') {
    return [linePrefix, `  await ${locatorExpr}.fill(${valueExpressionForStep(step)});`];
  }
  if (action === 'select' || action === 'selectoption' || action === 'choose') {
    return [linePrefix, `  await ${locatorExpr}.selectOption(${valueExpressionForStep(step)});`];
  }
  if (action === 'check') return [linePrefix, `  await ${locatorExpr}.check();`];
  if (action === 'uncheck') return [linePrefix, `  await ${locatorExpr}.uncheck();`];
  if (action === 'hover') return [linePrefix, `  await ${locatorExpr}.hover();`];
  if (action === 'press') {
    const key = step.key || step.value || step.rawValue || 'Enter';
    return [linePrefix, `  await ${locatorExpr}.press(${jsLiteral(key)});`];
  }
  if (action === 'upload' || action === 'setinputfiles') {
    return [linePrefix, `  await ${locatorExpr}.setInputFiles(runtimeValue("QAAI_UPLOAD_FILE"));`];
  }
  return [
    linePrefix,
    `  // TODO action: ${safeComment(step && (step.action || step.type || 'unmapped action'))} on ${locatorExpr}`,
  ];
}

function assertionLines(assertion, index) {
  const kind = String(
    (assertion && (assertion.kind || assertion.type || assertion.channel || '')) || '',
  ).toLowerCase();
  const expected = assertion && (assertion.expected ?? assertion.value ?? assertion.text);
  const target =
    assertion && (assertion.target || assertion.selector || assertion.element || assertion.name);
  const prefix = `  // assertion ${index + 1}: ${safeComment(kind || 'unknown')}`;
  if (
    expected == null ||
    String(expected).trim() === '' ||
    /parse_failed|todo|placeholder/i.test(String(expected))
  ) {
    return [prefix, '  // TODO oracle: provide a concrete expected value before replay check.'];
  }
  if (target && /^(?:page\.|locator\(|getBy)/.test(String(target))) {
    const loc = normalizeLocatorExpression(target);
    return [prefix, `  await expect(${loc}).toContainText(${jsLiteral(expected)});`];
  }
  if (kind.includes('url'))
    return [prefix, `  await expect(page).toHaveURL(new RegExp(${jsLiteral(String(expected))}));`];
  if (kind.includes('visible') && target)
    return [prefix, `  await expect(page.getByText(${jsLiteral(target)})).toBeVisible();`];
  return [prefix, `  await expect(page.getByText(${jsLiteral(expected)})).toBeVisible();`];
}

function declaredAssertionsFor(result) {
  const raw =
    result && (result.declaredAssertionsRaw || result.declaredAssertions || result.assertions);
  const parsed = decodeMaybe(raw, raw);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') return [parsed];
  return raw ? [{ kind: 'text', expected: String(raw) }] : [];
}

function contractStepsFor(result) {
  const direct = Array.isArray(result && result.declaredSteps) ? result.declaredSteps : [];
  if (direct.length) return direct;
  const qc =
    decodeMaybe(result && result.qualityContract, null) ||
    decodeMaybe(result && result.qualityContractJson, null);
  const phase = qc && (qc.phase45 || qc);
  return arrayOf(phase && phase.steps);
}

function actionLinesForContractStep(step, index) {
  const action = String((step && (step.action || step.type || '')) || '').toLowerCase();
  const target = String((step && (step.target || step.element || step.label || '')) || '').trim();
  const locator = normalizeLocatorExpression(
    step && (step.locator || step.selector || step.browserActionBinding?.locator),
  );
  const prefix = `  // ${index + 1}. ${safeComment([step && step.action, target].filter(Boolean).join(' ') || `authored step ${index + 1}`)}`;
  if (locator && (action === 'click' || action === 'tap' || action === 'submit'))
    return [prefix, `  await ${locator}.click();`];
  if (
    locator &&
    (action === 'fill' || action === 'type' || action === 'enter' || action === 'input')
  )
    return [prefix, `  await ${locator}.fill(${valueExpressionForStep(step)});`];
  if (locator && (action === 'select' || action === 'selectoption'))
    return [prefix, `  await ${locator}.selectOption(${valueExpressionForStep(step)});`];
  if (/navigate|goto|open/.test(action))
    return [
      prefix,
      `  await page.goto(${target ? jsLiteral(target) : 'process.env.QAAI_TARGET_URL || "about:blank"'});`,
    ];
  return [
    prefix,
    `  // TODO implement step once locator/action evidence is available: ${safeComment([action, target].filter(Boolean).join(' '))}`,
  ];
}

function blockerSummary(blockers = [], result = {}) {
  const codes = [];
  for (const b of blockers || []) {
    if (b && (b.code || b.blockReason || b.rule))
      codes.push(String(b.code || b.blockReason || b.rule));
  }
  for (const reason of arrayOf(result.readinessReasons)) {
    if (reason && (reason.code || reason.family)) codes.push(String(reason.code || reason.family));
  }
  if (result.readinessStatus) codes.push(String(result.readinessStatus));
  return Array.from(new Set(codes)).slice(0, 8);
}

function buildDraftSpec({ result, adapterId, targetUrl, blockers = [] }) {
  const liveLedger =
    result && result.liveScriptLedger && typeof result.liveScriptLedger === 'object'
      ? result.liveScriptLedger
      : null;
  const liveLines = liveLedger ? liveScriptRecorder.canonicalLines(liveLedger) : [];
  if (liveLines.length) {
    const title =
      result.caseName || result.testCaseName || result.testCaseId || 'Generated QAAI case';
    const fileExt = /-js$|playwright-reference-js|playwright-pom-js/.test(String(adapterId || ''))
      ? 'js'
      : 'ts';
    const moduleSlug = slug(result.moduleName || result.module || 'recorded', 'recorded');
    const caseSlug = slug(title, 'test-case');
    const file = `tests/recorded/${moduleSlug}/${caseSlug}.spec.${fileExt}`;
    let content = liveScriptRecorder.compileLedgerToPlaywrightSpec({
      ledger: liveLedger,
      title,
      targetUrl,
      js: fileExt === 'js',
    });
    const extraFiles = {};
    if (isPomAdapter(adapterId)) {
      const pageName = `${pascal(moduleSlug || 'recorded')}RecordedPage`;
      const locatorBase = `${moduleSlug}.recorded.locators.${fileExt}`;
      const pageBase = `${pageName}.${fileExt}`;
      const locatorPath = `locators/generated/${locatorBase}`;
      const pagePath = `pages/${pageBase}`;
      const pom = liveScriptRecorder.compileLedgerToPlaywrightPomPackage({
        ledger: liveLedger,
        title,
        targetUrl,
        moduleName: moduleSlug,
        pageClassName: pageName,
        locatorsExportName: `${camel(pageName)}Locators`,
        locatorsImportPath: `../${locatorPath}`,
        pageImportPath: `../../../${pagePath}`,
        js: fileExt === 'js',
      });
      content = pom.specContent;
      extraFiles[locatorPath] = pom.locatorContent;
      extraFiles[pagePath] = pom.pageContent;
    }
    const blockerCodes = blockerSummary(blockers, result);
    return {
      file,
      content,
      extraFiles,
      artifact: {
        testCaseId: result.testCaseId || null,
        runResultId: result.runResultId || null,
        file,
        source: 'script_ledger',
        scriptGenerationStatus: 'generated',
        scriptRunStatus: 'not_run',
        certificationStatus: 'uncertified',
        scriptMode: liveLedger.scriptMode || null,
        scriptHealth: liveLedger.health || null,
        blockers: blockerCodes,
        repairHints:
          liveLedger.health && liveLedger.health.weakLocatorCount
            ? ['Script is runnable, but some locators were generated from weak fallback evidence.']
            : [],
      },
    };
  }
  const ir = result && result.envelope && result.envelope.ir;
  const irSteps = arrayOf(ir && ir.steps);
  const graphLocators = collectActionGraphLocators(result && result.actionGraph);
  const resolveLocators = collectResolveLocators(irSteps);
  const lines = [];
  const repairHints = [];
  let source = 'skeleton';
  let emittedActionCount = 0;
  let todoCount = 0;

  if (irSteps.length) {
    source =
      result.envelope && result.envelope.complete === false ? 'partial_replayir' : 'replayir';
    for (const [index, step] of irSteps.entries()) {
      if (!step || step.op === 'resolve') continue;
      if (step.op === 'assert') {
        const assertion = {
          kind: step.channel || step.kind,
          expected: step.expected,
          target: step.target,
        };
        const assertionOut = assertionLines(assertion, index);
        lines.push(...assertionOut);
        if (assertionOut.some((line) => line.includes('TODO'))) todoCount += 1;
        continue;
      }
      if (step.op !== 'act') continue;
      const out = actionLinesForIrStep(
        step,
        index,
        locatorForStep(step, resolveLocators, graphLocators),
      );
      lines.push(...out);
      if (out.some((line) => /^\s*await\s+/.test(line))) emittedActionCount += 1;
      if (out.some((line) => line.includes('TODO'))) todoCount += 1;
    }
  }

  if (!emittedActionCount) {
    const contractSteps = contractStepsFor(result);
    if (contractSteps.length) source = source === 'skeleton' ? 'testcase_contract' : source;
    for (const [index, step] of contractSteps.entries()) {
      const out = actionLinesForContractStep(step, index);
      lines.push(...out);
      if (out.some((line) => /^\s*await\s+/.test(line))) emittedActionCount += 1;
      if (out.some((line) => line.includes('TODO'))) todoCount += 1;
    }
  }

  const assertions = declaredAssertionsFor(result);
  if (assertions.length) {
    lines.push('', '  // Declared assertions/oracles from the saved QAAI case:');
    for (const [index, assertion] of assertions.entries()) {
      const out = assertionLines(assertion, index);
      lines.push(...out);
      if (out.some((line) => line.includes('TODO'))) todoCount += 1;
    }
  } else {
    lines.push('', '  // TODO oracle: add a concrete final assertion before replay check.');
    todoCount += 1;
  }

  if (!lines.length) {
    lines.push(
      '  // No usable action evidence exists yet. Use QAAI/Claude to author this case from the saved contract.',
    );
    todoCount += 1;
  }

  const blockerCodes = blockerSummary(blockers, result);
  if (blockerCodes.includes('auth_setup_missing') || blockerCodes.includes('needs_auth_setup')) {
    repairHints.push(
      'Configure an auth setup template or storage state reference; do not hardcode credentials.',
    );
  }
  if (blockerCodes.some((code) => /assertion|oracle/i.test(code))) {
    repairHints.push(
      'Replace oracle TODOs with concrete expected text, URL, table row, validation message, or state change.',
    );
  }
  if (todoCount)
    repairHints.push('Resolve TODO locator/action/oracle lines, then rerun script validation.');

  const title =
    result.caseName || result.testCaseName || result.testCaseId || 'Generated QAAI case';
  const status = emittedActionCount > 0 ? 'generated_with_repairs_needed' : 'skeleton_only';
  const fileExt = /-js$|playwright-reference-js|playwright-pom-js/.test(String(adapterId || ''))
    ? 'js'
    : 'ts';
  const moduleSlug = slug(result.moduleName || result.module || 'preview', 'preview');
  const caseSlug = slug(title, 'test-case');
  const file = `tests/preview/${moduleSlug}/${caseSlug}.preview.spec.${fileExt}`;
  const importLine =
    fileExt === 'js'
      ? "const { test, expect } = require('@playwright/test');"
      : "import { test, expect } from '@playwright/test';";
  const body = [
    importLine,
    '',
    'const runtimeValue = (name, fallback = "") => process.env[name] || fallback;',
    '',
    `test(${jsLiteral(title)}, async ({ page }) => {`,
    `  test.info().annotations.push({ type: 'qaai-source-diagnostic', description: ${jsLiteral(`QAAI generated script health notes: ${blockerCodes.join(', ') || 'source evidence was incomplete'}`)} });`,
    blockerCodes.length
      ? `  expect.soft(false, ${jsLiteral('QAAI could not reconstruct every authored operation from this legacy source; later independent operations will still run.')}).toBe(true);`
      : '',
    targetUrl
      ? `  await page.goto(process.env.QAAI_TARGET_URL || ${jsLiteral(targetUrl)});`
      : '  await page.goto(process.env.QAAI_TARGET_URL || "about:blank");',
    '',
    '    // Generated from available QAAI evidence. TODO lines mark script-health gaps for replay checking.',
    ...lines,
    '});',
    '',
  ].join('\n');
  return {
    file,
    content: body,
    artifact: {
      testCaseId: result.testCaseId || null,
      runResultId: result.runResultId || null,
      file,
      source,
      scriptGenerationStatus: status,
      scriptRunStatus: 'not_run',
      certificationStatus: 'uncertified',
      blockers: [],
      diagnostics: blockerCodes,
      repairHints,
    },
  };
}

function isPomAdapter(adapterId) {
  return adapterId === 'playwright-pom' || adapterId === 'playwright-pom-js';
}

function isJsAdapter(adapterId) {
  return /-js$|playwright-reference-js|playwright-pom-js/.test(String(adapterId || ''));
}

function markPreviewSpec(content) {
  // Runtime/export diagnostics belong in evidence/live-output-status.json.
  // Keep executable specs clean; a locator-specific QAAI_GUESSED_LOCATOR
  // comment is emitted by the locator module only when verified evidence is
  // genuinely unavailable.
  return String(content || '');
}

function pomIrForResult(result = {}, index = 0) {
  if (result?.envelope?.ir && typeof result.envelope.ir === 'object') return result.envelope.ir;
  const caseId = result.testCaseId || result.runResultId || `authored-case-${index + 1}`;
  const title =
    result.caseName || result.testCaseName || result.name || `Authored case ${index + 1}`;
  return {
    version: 1,
    caseId,
    title,
    authProfile: result.authProfile || {
      id: 'default',
      strategy: 'none',
      disposition: 'bypass_fixture',
    },
    // The standard POM normalizer reconciles the complete declared contract
    // into this shell. Keeping the shell empty prevents a second reconstructed
    // runtime flow from being appended beside the authored occurrences.
    steps: [],
    verdict: {
      status: result.status || result.executionStatus || 'not_run',
      perAssertionOutcomes: arrayOf(result.assertionOutcomes),
    },
    source: 'authored_contract_shell',
  };
}

function buildPomDraftArtifacts({
  adapterId,
  adapterVersion,
  results = [],
  blocked = [],
  findings = [],
  targetUrl = '',
} = {}) {
  const files = {};
  const artifacts = [];
  const pomResults = (results || []).filter(Boolean);
  if (!pomResults.length) return null;

  const blockersByKey = new Map();
  for (const block of blocked || []) {
    const keys = [block && block.runResultId, block && block.testCaseId]
      .filter(Boolean)
      .map(String);
    for (const key of keys) {
      if (!blockersByKey.has(key)) blockersByKey.set(key, []);
      blockersByKey.get(key).push(block);
    }
  }
  const allBlockerCodes = [];
  const cases = pomResults.map((result, index) => {
    const blockers = [
      ...arrayOf(blockersByKey.get(String(result.runResultId || ''))),
      ...arrayOf(blockersByKey.get(String(result.testCaseId || ''))),
      ...arrayOf(findings).filter(
        (finding) =>
          finding &&
          ((result.runResultId &&
            String(finding.runResultId || '') === String(result.runResultId)) ||
            (result.testCaseId && String(finding.testCaseId || '') === String(result.testCaseId))),
      ),
    ];
    const codes = blockerSummary(blockers, result);
    allBlockerCodes.push(...codes);
    const ir = pomIrForResult(result, index);
    const source = result.envelope?.ir
      ? result.envelope.complete === false
        ? 'partial_replayir'
        : 'replayir'
      : 'authored_contract';
    const title =
      result.caseName ||
      result.testCaseName ||
      ir.title ||
      result.testCaseId ||
      `Draft case ${index + 1}`;
    artifacts.push({
      testCaseId: result.testCaseId || null,
      runResultId: result.runResultId || null,
      file: null,
      source,
      scriptGenerationStatus: 'generated',
      scriptRunStatus: 'not_run',
      certificationStatus: 'uncertified',
      blockers: [],
      sourceRunDiagnostics: codes,
      repairHints: [],
    });
    return {
      ...result,
      ir,
      caseName: title,
      status: 'generated',
      runResultId: result.runResultId || null,
      testCaseId: result.testCaseId || null,
      declaredSteps: contractStepsFor(result),
      declaredAssertionsRaw: declaredAssertionsFor(result),
    };
  });

  const adapter = adapterId === 'playwright-pom-js' ? playwrightPomJs : playwrightPom;
  const js = isJsAdapter(adapterId);
  const moduleSlug = slug(
    (pomResults[0] && (pomResults[0].moduleName || pomResults[0].module)) || 'preview',
    'preview',
  );
  const scenarioName =
    (pomResults[0] && (pomResults[0].scenarioName || pomResults[0].caseName)) ||
    'QAAI generated run';
  const scenarioSlug = slug(scenarioName, `${moduleSlug}-generated-flow`);
  const scenarioId = `generated-${scenarioSlug}`;
  const file = `tests/recorded/${moduleSlug}/${scenarioSlug}.spec.${js ? 'js' : 'ts'}`;
  const specDir = `tests/recorded/${moduleSlug}`;
  const authoredContractOnly = artifacts.length > 0
    && artifacts.every((artifact) => artifact.source === 'authored_contract');
  if (authoredContractOnly) {
    const diagnosticFile = `tests/diagnostics/${moduleSlug}/${scenarioSlug}.diagnostic.${js ? 'js' : 'ts'}`;
    for (const artifact of artifacts) {
      artifact.file = diagnosticFile;
      artifact.source = 'authored_contract_diagnostic';
      artifact.scriptGenerationStatus = 'generated_with_diagnostics';
      artifact.certificationStatus = 'diagnostic_only';
      artifact.repairHints = [
        'Rerun the case to capture positive browser execution evidence before QAAI emits runnable Playwright POM code.',
      ];
    }
    const diagnostic = {
      schema: 'qaai-playwright-diagnostic/1',
      status: 'diagnostic_only',
      executable: false,
      discoveredByPlaywright: false,
      title: scenarioName,
      targetUrl: targetUrl || null,
      message:
        'No Playwright test was emitted because this result contains authored intent but no positively executed browser action, observed wait, or evaluated assertion evidence.',
      artifacts: artifacts.map((artifact) => ({
        runResultId: artifact.runResultId,
        testCaseId: artifact.testCaseId,
        source: artifact.source,
      })),
    };
    files[diagnosticFile] = js
      ? `// QAAI diagnostic artifact. This file is intentionally outside Playwright test discovery.\nexport const qaaiDiagnostic = Object.freeze(${JSON.stringify(diagnostic, null, 2)});\n`
      : `// QAAI diagnostic artifact. This file is intentionally outside Playwright test discovery.\nexport const qaaiDiagnostic = Object.freeze(${JSON.stringify(diagnostic, null, 2)} as const);\n`;
    const summary = {
      schema: 'qaai-live-output-status/1',
      status: 'generated_with_diagnostics',
      allBlocked: false,
      targetUrl: targetUrl || null,
      adapterId: adapterId || null,
      adapterVersion: adapterVersion || null,
      totalCases: (results || []).length,
      generatedPreviewFiles: 1,
      artifacts,
      scriptArtifacts: artifacts,
      findings: (findings || []).slice(0, 50),
      message:
        'QAAI generated a downloadable diagnostic package because authored intent was available but executable browser evidence was not.',
      generatedAt: new Date().toISOString(),
    };
    files['evidence/live-output-status.json'] = JSON.stringify(summary, null, 2) + '\n';
    files['README.md'] = [
      '# QAAI diagnostic automation bundle',
      '',
      'This bundle is visible because QAAI never hides output solely due to missing or incomplete evidence.',
      '',
      '- No Playwright test was emitted from authored-only intent.',
      '- Rerun the case to capture positive browser actions, waits, assertions, and verified locators.',
      '- Missing evidence is diagnostic metadata, not guessed runnable code.',
      '',
      `Adapter: ${adapterId || 'unknown'}`,
      `Target URL: ${targetUrl || 'unknown'}`,
      `Script artifacts: ${artifacts.length}`,
      '',
    ].join('\n');
    return { files, artifacts, manifestPatch: { scriptArtifacts: artifacts } };
  }
  let emitted;
  try {
    emitted = adapter.emitJourneySpec(cases, { scenarioName, scenarioId, specDir, targetUrl });
  } catch (err) {
    return null;
  }

  const content = typeof emitted === 'string' ? emitted : (emitted && emitted.content) || '';
  const extraFiles =
    typeof emitted === 'object' && emitted && emitted.extraFiles ? emitted.extraFiles : {};
  files[file] = markPreviewSpec(content, Array.from(new Set(allBlockerCodes)));
  Object.assign(files, extraFiles);
  Object.assign(
    files,
    js ? playwrightReference.supportFilesJsEsm() : playwrightReference.supportFiles(),
  );
  for (const artifact of artifacts) artifact.file = file;

  const summary = {
    schema: 'qaai-live-output-status/1',
    status: 'script_generated',
    allBlocked: false,
    targetUrl: targetUrl || null,
    adapterId: adapterId || null,
    adapterVersion: adapterVersion || null,
    totalCases: (results || []).length,
    generatedPreviewFiles: Object.keys(files).filter((rel) =>
      /\.(?:spec\.[jt]s|page\.[jt]s|locators\.[jt]s)$/i.test(rel),
    ).length,
    artifacts,
    scriptArtifacts: artifacts,
    findings: (findings || []).slice(0, 50),
    message:
      'QAAI generated a downloadable framework package from available execution evidence. Authored-only intent remains diagnostic metadata and is not converted into guessed runnable locators.',
    generatedAt: new Date().toISOString(),
  };
  files['evidence/live-output-status.json'] = JSON.stringify(summary, null, 2) + '\n';
  files['README.md'] = [
    '# QAAI generated POM automation bundle',
    '',
    'This bundle follows the selected Playwright POM framework and preserves the executable evidence QAAI can safely materialize.',
    '',
    '- `locators/generated/` contains QAAI-generated locator evidence.',
    '- `locators/` contains editable shims for overrides.',
    '- `pages/` contains page-object methods.',
    '- `tests/recorded/` contains executable specs; source-run failure status never disables the generated test.',
    '- Authored-only intent and missing evidence are reported as diagnostics instead of being converted into narrative locator guesses.',
    '',
    `Adapter: ${adapterId || 'unknown'}`,
    `Target URL: ${targetUrl || 'unknown'}`,
    `Script artifacts: ${artifacts.length}`,
    '',
  ].join('\n');
  return { files, artifacts, manifestPatch: { scriptArtifacts: artifacts } };
}

function buildDraftArtifacts({
  adapterId,
  adapterVersion,
  results = [],
  blocked = [],
  findings = [],
  targetUrl = '',
} = {}) {
  // ReplayIR owns the complete authored flow (actions, waits, assertions,
  // dependencies and semantic locator provenance). A live ledger is only a
  // runtime evidence source and must never replace that richer contract.
  if (isPomAdapter(adapterId)) {
    const pomDraft = buildPomDraftArtifacts({
      adapterId,
      adapterVersion,
      results,
      blocked,
      findings,
      targetUrl,
    });
    if (pomDraft) return pomDraft;
  }
  const files = {};
  const artifacts = [];
  const used = new Set();
  const blockersByKey = new Map();
  for (const block of blocked || []) {
    const keys = [block && block.runResultId, block && block.testCaseId]
      .filter(Boolean)
      .map(String);
    for (const key of keys) {
      if (!blockersByKey.has(key)) blockersByKey.set(key, []);
      blockersByKey.get(key).push(block);
    }
  }
  for (const result of results || []) {
    const blockers = [
      ...arrayOf(blockersByKey.get(String(result.runResultId || ''))),
      ...arrayOf(blockersByKey.get(String(result.testCaseId || ''))),
      ...arrayOf(findings).filter(
        (finding) =>
          finding &&
          ((result.runResultId &&
            String(finding.runResultId || '') === String(result.runResultId)) ||
            (result.testCaseId && String(finding.testCaseId || '') === String(result.testCaseId))),
      ),
    ];
    const built = buildDraftSpec({ result, adapterId, targetUrl, blockers });
    let rel = built.file;
    if (used.has(rel)) {
      rel = rel.replace(
        /\.preview\.spec\.([jt]s)$/i,
        `-${sha1(result.runResultId || result.testCaseId || rel)}.preview.spec.$1`,
      );
      built.artifact.file = rel;
    }
    used.add(rel);
    files[rel] = built.content;
    if (built.extraFiles && typeof built.extraFiles === 'object')
      Object.assign(files, built.extraFiles);
    artifacts.push(built.artifact);
  }
  const summary = {
    schema: 'qaai-live-output-status/1',
    status: artifacts.some((a) => a.source === 'script_ledger')
      ? 'script_generated'
      : artifacts.some((a) => a.scriptGenerationStatus === 'generated_with_repairs_needed')
        ? 'draft_generated'
        : 'preview_only',
    allBlocked: true,
    targetUrl: targetUrl || null,
    adapterId: adapterId || null,
    adapterVersion: adapterVersion || null,
    totalCases: (results || []).length,
    generatedPreviewFiles: artifacts.length,
    artifacts,
    scriptArtifacts: artifacts,
    findings: (findings || []).slice(0, 50),
    message: artifacts.some((a) => a.source === 'script_ledger')
      ? 'QAAI generated runnable scripts from the live execution ledger. Internal script health records locator stability and replay parity.'
      : 'QAAI generated visible script artifacts from the available run evidence.',
    generatedAt: new Date().toISOString(),
  };
  files['evidence/live-output-status.json'] = JSON.stringify(summary, null, 2) + '\n';
  files['README.md'] = [
    '# QAAI generated script bundle',
    '',
    'This bundle is visible for passed, failed, and interrupted runs whenever QAAI has executable history.',
    '',
    '- Known actions and locators are emitted where QAAI has evidence.',
    '- TODO/fixme lines mark script-health gaps for auth, locator, data, oracle, or session context.',
    '- EXPORT_MANIFEST.json records script health, replay status, and artifact metadata.',
    '',
    `Adapter: ${adapterId || 'unknown'}`,
    `Target URL: ${targetUrl || 'unknown'}`,
    `Script artifacts: ${artifacts.length}`,
    '',
  ].join('\n');
  if (!artifacts.length) {
    files['tests/preview/no-generated-case.preview.spec.ts'] = [
      "import { test, expect } from '@playwright/test';",
      '',
      "test('QAAI source evidence diagnostic', async () => {",
      "  test.info().annotations.push({ type: 'qaai-source-diagnostic', description: 'No saved RunResult/TestCase contract rows were available.' });",
      "  expect.soft(false, 'QAAI could not reconstruct a case because no saved contract row was available.').toBe(true);",
      '});',
      '',
    ].join('\n');
  }
  return { files, artifacts, manifestPatch: { scriptArtifacts: artifacts } };
}

module.exports = {
  buildDraftArtifacts,
  buildDraftSpec,
  locatorExpressionFromActionLocator,
  normalizeLocatorExpression,
};
