'use strict';

const runner = require('./scriptValidationRunner');
const actionLocatorResolver = require('./actionLocatorResolver');

function lineBounds(text, line) {
  const lines = String(text || '').split(/\r?\n/);
  const index = Math.max(0, Math.min(lines.length - 1, Number(line || 1) - 1));
  return { lines, index, lineText: lines[index] || '' };
}

function replaceLine(text, line, nextLine) {
  const { lines, index } = lineBounds(text, line);
  lines[index] = nextLine;
  return lines.join('\n');
}

function explicitPatch({ fileContent, after, expectedBefore = null }) {
  if (typeof after !== 'string') return null;
  if (expectedBefore != null && String(expectedBefore) !== String(fileContent || '')) {
    return {
      status: 'unresolved_non_blocking',
      reason: 'script_repair_stale_preview',
      nonBlocking: true,
    };
  }
  return {
    status: 'patched',
    after,
    reason: 'explicit_repair_patch',
    repairedBy: 'user_or_claude_supplied_patch',
  };
}

function verifiedPlaywrightExpression(failure = {}) {
  const actionLocator = failure.verifiedActionLocator
    || failure.actionLocator
    || failure.locatorEvidence?.actionLocator
    || null;
  if (!actionLocatorResolver.isVerifiedActionLocator(actionLocator)) return null;
  const primary = actionLocatorResolver.primaryActionLocator(actionLocator);
  const raw = String(
    primary?.frameworkExpressions?.playwright
      || primary?.expression
      || '',
  ).trim();
  if (/^page\./.test(raw)) return raw;
  if (/^(?:locator|getByRole|getByLabel|getByPlaceholder|getByText|getByTestId|getByTitle|getByAltText|frameLocator)\s*\(/.test(raw)) {
    return `page.${raw}`;
  }
  return null;
}

function isLocatorFailure(failure = {}) {
  const signal = [
    failure.error,
    failure.code,
    failure.message,
    failure.action,
  ].filter(Boolean).join(' ');
  return /strict mode|locator|element.*(?:not found|detached|ambiguous)|click.*(?:target|failed)|resolved to .*elements?/i.test(signal);
}

function deterministicLocatorPatch({ fileContent, failure }) {
  const file = runner.safeRelPath(failure && failure.file);
  const line = Number(failure && failure.line || 1);
  const error = String(failure && failure.error || '');
  const { lineText } = lineBounds(fileContent, line);
  if (!file || !/strict mode|locator|click/i.test(error)) return null;

  // A readable label is not locator evidence. Automatic locator repair is
  // permitted only when the live action pipeline supplied the same verified
  // locator contract used by code generation (bound ref, same-node proof,
  // uniqueness, DOM-atlas evidence and an export-safe Playwright expression).
  const verifiedExpression = verifiedPlaywrightExpression(failure);
  if (!verifiedExpression) return null;

  const match = lineText.match(/^(?<indent>\s*)(?<prefix>await\s+)?(?<expr>page\.getByText\(\s*(['"`])(?<label>[^'"`]+)\4\s*\)\.click\(\s*\)\s*;?)\s*$/);
  if (!match) return null;
  const indent = match.groups.indent || '';
  const prefix = match.groups.prefix || '';
  const nextLine = `${indent}${prefix}${verifiedExpression}.click();`;
  return {
    status: 'patched',
    after: replaceLine(fileContent, line, nextLine),
    reason: 'Locator failure repaired from authoritative same-node action evidence.',
    repairedBy: 'verified_action_locator_repair',
  };
}

function proposeRepair({ files = {}, failure = {}, patch = null } = {}) {
  const file = runner.safeRelPath(failure.file || patch?.file);
  if (!file || files[file] == null || Buffer.isBuffer(files[file])) {
    return {
      status: 'unresolved_non_blocking',
      reason: 'repair_file_unavailable',
      file,
      nonBlocking: true,
    };
  }
  const fileContent = String(files[file] || '');
  const explicit = explicitPatch({
    fileContent,
    after: patch && patch.after,
    expectedBefore: patch && patch.expectedBefore,
  });
  if (explicit) return { ...explicit, file, before: fileContent };

  const deterministic = deterministicLocatorPatch({ fileContent, failure });
  if (deterministic) return { ...deterministic, file, before: fileContent };

  return {
    status: 'unresolved_non_blocking',
    reason: 'no_verified_action_locator_repair_available',
    file,
    before: fileContent,
    nonBlocking: true,
  };
}

module.exports = {
  proposeRepair,
  deterministicLocatorPatch,
  isLocatorFailure,
  verifiedPlaywrightExpression,
  replaceLine,
};
