'use strict';

const actionRegistry = require('../browserActionRegistry');

function escapeText(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, '\\n');
}

function escapeRegexSource(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function executableDiagnosticLine(reason) {
  return `expect.soft(false, '${escapeText(reason)}').toBe(true);`;
}

function semanticTargetLabel(entry, trailEntry = {}) {
  const args = trailEntry && trailEntry.args && typeof trailEntry.args === 'object'
    ? trailEntry.args
    : {};
  return String(
    args.element || args.target || args.label || args.name || args.accessibleName
    || args.description || args.text || '',
  ).trim();
}

function guessedActionLine(entry, trailEntry = {}) {
  const action = String(entry?.replayIrMapping || entry?.canonicalAction || trailEntry.tool || '').toLowerCase();
  const label = semanticTargetLabel(entry, trailEntry);
  if (!label || !/(click|hover|fill|type|check|select)/.test(action)) return null;

  const role = /(fill|type)/.test(action)
    ? 'textbox'
    : /check/.test(action)
      ? 'checkbox'
      : /select/.test(action)
        ? 'combobox'
        : 'button';
  const locator = `page.getByRole(${JSON.stringify(role)}, { name: new RegExp(${JSON.stringify(escapeRegexSource(label))}, 'i') })`;
  const value = trailEntry?.args?.value ?? trailEntry?.args?.text ?? trailEntry?.args?.option ?? '';
  let statement = `await ${locator}.click();`;
  if (/hover/.test(action)) statement = `await ${locator}.hover();`;
  else if (/(fill|type)/.test(action)) statement = `await ${locator}.fill(${JSON.stringify(String(value))});`;
  else if (/check/.test(action)) statement = `await ${locator}.check();`;
  else if (/select/.test(action)) statement = `await ${locator}.selectOption(${JSON.stringify(String(value))});`;
  return [
    `// QAAI_GUESSED_LOCATOR: Runtime DOM evidence was unavailable. This semantic locator is enabled but unverified; replace it with a DOM-confirmed locator if needed.`,
    statement,
  ].join('\n    ');
}

function fallbackForEntry(entry, trailEntry = {}) {
  if (!entry) {
    return {
      status: actionRegistry.SCRIPT_STATUSES.PREVIEW_AVAILABLE,
      line: executableDiagnosticLine(`QAAI runtime action "${trailEntry.tool || 'unknown'}" is not registered; the generated test remains enabled and later steps will continue.`),
      certified: false,
      runnable: true,
    };
  }

  if (entry.codegenFallback === actionRegistry.CODEGEN_FALLBACKS.EMIT_PLAYWRIGHT) {
    return {
      status: actionRegistry.SCRIPT_STATUSES.PREVIEW_AVAILABLE,
      line: `// QAAI preview: ${entry.tool} maps to ReplayIR action "${entry.replayIrMapping || entry.canonicalAction}".`,
      certified: !!entry.exportable,
      runnable: true,
    };
  }

  if (entry.codegenFallback === actionRegistry.CODEGEN_FALLBACKS.EMIT_MANUAL_GATE) {
    return {
      status: actionRegistry.SCRIPT_STATUSES.PREVIEW_AVAILABLE,
      line: guessedActionLine(entry, trailEntry)
        || executableDiagnosticLine(`${entry.tool} lacks sufficient runtime evidence; the test remains enabled and later independent steps will continue.`),
      certified: false,
      runnable: true,
    };
  }

  if (entry.codegenFallback === actionRegistry.CODEGEN_FALLBACKS.EMIT_FIXME) {
    return {
      status: actionRegistry.SCRIPT_STATUSES.PREVIEW_AVAILABLE,
      line: guessedActionLine(entry, trailEntry)
        || executableDiagnosticLine(`${entry.tool} used ${entry.canonicalAction}; exact runtime evidence was unavailable, so this enabled diagnostic records the unresolved action.`),
      certified: false,
      runnable: true,
    };
  }

  return {
    status: actionRegistry.SCRIPT_STATUSES.PREVIEW_AVAILABLE,
    line: guessedActionLine(entry, trailEntry)
      || executableDiagnosticLine(`${entry.tool} lacks ReplayIR evidence; the generated test remains enabled and later independent steps will continue.`),
    certified: false,
    runnable: true,
  };
}

function buildPreviewScript({ title = 'QAAI preview script', trail = [] } = {}) {
  const lines = [
    `// QAAI runnable_unverified diagnostic fallback`,
    `// This enabled file preserves runtime actions; review any QAAI_GUESSED_LOCATOR comment after generation.`,
    `import { test, expect } from '@playwright/test';`,
    ``,
    `test('${escapeText(title)}', async ({ page }) => {`,
  ];
  const findings = [];
  let certified = true;

  for (const item of Array.isArray(trail) ? trail : []) {
    if (!item || !item.tool) continue;
    const entry = actionRegistry.getActionEntry(item.tool);
    if (entry && entry.kind === 'utility') continue;
    const fallback = fallbackForEntry(entry, item);
    certified = certified && fallback.certified;
    findings.push({
      tool: item.tool,
      status: fallback.status,
      codegenFallback: entry ? entry.codegenFallback : actionRegistry.CODEGEN_FALLBACKS.BLOCK_CERTIFICATION,
      certified: fallback.certified,
      runnable: true,
    });
    lines.push(`  // Runtime action: ${escapeText(item.tool)}`);
    for (const part of String(fallback.line).split('\n')) lines.push(`  ${part}`);
  }

  lines.push(`});`, ``);
  return {
    status: certified ? actionRegistry.SCRIPT_STATUSES.CERTIFIED_AVAILABLE : actionRegistry.SCRIPT_STATUSES.PREVIEW_AVAILABLE,
    certificationStatus: certified ? actionRegistry.CERTIFICATION_STATUSES.CERTIFIED : actionRegistry.CERTIFICATION_STATUSES.PREVIEW_NOT_CERTIFIED,
    code: lines.join('\n'),
    findings,
    runnable: true,
  };
}

module.exports = {
  buildPreviewScript,
  fallbackForEntry,
};
