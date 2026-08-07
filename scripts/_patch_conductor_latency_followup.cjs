const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'server', 'services', 'agents', 'conductor.js');
const outputPath = path.join(root, '_conductor_latency_followup.tmp.js');
let source = fs.readFileSync(sourcePath, 'utf8');

function replaceCount(from, to, expected, label) {
  const windowsNeedle = from.includes('\n') ? from.replace(/\n/g, '\r\n') : from;
  const windowsReplacement = to.includes('\n') ? to.replace(/\n/g, '\r\n') : to;
  const unixCount = source.split(from).length - 1;
  const windowsCount = windowsNeedle === from ? 0 : source.split(windowsNeedle).length - 1;
  const count = unixCount + windowsCount;
  if (count !== expected) throw new Error(`${label}: expected ${expected} anchor(s), found ${count}`);
  source = source.split(from).join(to);
  if (windowsCount) source = source.split(windowsNeedle).join(windowsReplacement);
}

replaceCount(
  "function profileFor(execMode) {\n  return EXEC_MODE_PROFILES[execMode === 'thorough' ? 'thorough' : 'fast'];\n}",
  "function profileFor(execMode) {\n  return EXEC_MODE_PROFILES[execMode === 'thorough' ? 'thorough' : 'fast'];\n}\nfunction selectEffectiveVerifierMode(execMode, verifierMode) {\n  return execMode === 'thorough' && verifierMode === 'semantic_fallback'\n    ? 'semantic_fallback'\n    : 'deterministic';\n}",
  1,
  'verifier mode selector',
);

replaceCount(
  '  const profile = profileFor(execMode);',
  '  const profile = profileFor(execMode);\n  const effectiveVerifierMode = selectEffectiveVerifierMode(execMode, verifierMode);',
  1,
  'effective verifier binding',
);

replaceCount(
  "        verifierMode: verifierMode === 'semantic_fallback' ? 'semantic_fallback' : 'deterministic',",
  '        verifierMode: effectiveVerifierMode,',
  1,
  'run-row verifier mode',
);

replaceCount(
  "if (verifierMode === 'semantic_fallback' && apiKey)",
  "if (effectiveVerifierMode === 'semantic_fallback' && apiKey)",
  2,
  'semantic hook and log gating',
);

replaceCount(
  "  if (verifierMode === 'semantic_fallback') {",
  "  if (effectiveVerifierMode === 'semantic_fallback') {",
  1,
  'semantic rescue summary gating',
);

replaceCount(
  "    // Falls back silently when unavailable - the LLM rescue still fires.\n    {",
  "    // Falls back silently when unavailable - the LLM rescue still fires.\n    if (effectiveVerifierMode === 'semantic_fallback') {",
  1,
  'vector hook gating',
);

let cachedFirstSnapshotCount = 0;
source = source.replace(
  /^(\s*)let snap = mcp\.getLastSnapshot\(mcpSession\) \|\| lastSnapshotText \|\| '';\r?\n\1try \{\r?\n\1  const fresh = await mcp\.snapshot\(mcpSession\);\r?\n\1  if \(fresh\?\.text\) snap = fresh\.text;\r?\n\1\} catch \(_\) \{\}/gm,
  (_match, indent) => {
    cachedFirstSnapshotCount += 1;
    return [
      `${indent}let snap = mcp.getLastSnapshot(mcpSession) || lastSnapshotText || '';`,
      `${indent}if (!snap) {`,
      `${indent}  const refreshed = await freshValidationSnapshot();`,
      `${indent}  if (refreshed.fresh) snap = refreshed.text;`,
      `${indent}}`,
    ].join('\n');
  },
);
if (cachedFirstSnapshotCount !== 4) {
  throw new Error(`cached-first validation snapshots: expected 4 anchors, found ${cachedFirstSnapshotCount}`);
}

replaceCount(
  "      try { const fresh = await mcp.snapshot(mcpSession); snap = fresh?.text || ''; }\n      catch (_) { snap = mcp.getLastSnapshot(mcpSession) || lastSnapshotText || ''; }",
  "      const refreshed = await freshValidationSnapshot();\n      snap = refreshed.text || cachedSnapshotText();",
  1,
  'input readback snapshot',
);

replaceCount(
  "        try { const s = await mcp.snapshot(mcpSession); snap = (s && s.text) || mcp.getLastSnapshot(mcpSession) || ''; }\n        catch (_) { snap = mcp.getLastSnapshot(mcpSession) || ''; }",
  "        const refreshed = await freshValidationSnapshot();\n        snap = refreshed.text || mcp.getLastSnapshot(mcpSession) || '';",
  1,
  'pending result recheck snapshot',
);

replaceCount(
  "                    try { const s = await mcp.snapshot(mcpSession); snapAfter = (s && s.text) || mcp.getLastSnapshot(mcpSession) || snapAfter; } catch (_) {}",
  "                    const refreshed = await freshValidationSnapshot();\n                    if (refreshed.fresh) snapAfter = refreshed.text;",
  1,
  'result-bearing post-fill snapshot',
);

replaceCount(
  '  SYSTEM_PROMPT_LOOP,',
  '  SYSTEM_PROMPT_LOOP,\n  _selectEffectiveVerifierMode: selectEffectiveVerifierMode,',
  1,
  'verifier selector export',
);

replaceCount(
  "    // Fast now runs the same bounded settle + re-check pass as thorough for\n    // transient uncheckables. The ratifier owns the cap; this cannot loop.\n    exhaustiveRatify: true,",
  "    // Fast mode never performs delayed post-loop ratification. It decides\n    // from deterministic single-pass evidence; thorough mode owns re-checks.\n    exhaustiveRatify: false,",
  1,
  'fast exhaustive ratification disabled',
);

replaceCount(
  "      const lastTurnErrored = !!(lastTrailEntry && (lastTrailEntry.error || lastTrailEntry.assertionFailed));",
  "      const lastTurnToolErrored = !!(lastTrailEntry && lastTrailEntry.error);\n      const assertionValidationMiss = !!lastTrailEntry?.assertionFailed;",
  1,
  'critic tool-error separation',
);

replaceCount(
  "      const deferCriticForFirstTimeout = lastTurnErrored\n        && !periodic\n        && !lastTrailEntry?.assertionFailed\n        && isTimeoutLikeError(lastTrailEntry?.error)\n        && consecutiveErrors <= 1;",
  "      const deterministicErrorDiagnosis = lastTurnToolErrored\n        ? diagnoseToolError(lastTrailEntry?.tool, lastTrailEntry?.args || {}, lastTrailEntry?.error || '')\n        : null;\n      const criticToolError = lastTurnToolErrored\n        && (execMode === 'thorough' || !deterministicErrorDiagnosis);\n      const criticValidationMiss = execMode === 'thorough'\n        && (assertionValidationMiss || ineffectiveOpenOrSelect);\n      const deferCriticForFirstTimeout = criticToolError\n        && !periodic\n        && isTimeoutLikeError(lastTrailEntry?.error)\n        && consecutiveErrors <= 1;",
  1,
  'fast critic eligibility',
);

replaceCount(
  "      } else if (lastTurnErrored || ineffectiveOpenOrSelect || periodic) {\n        if (ineffectiveOpenOrSelect && !lastTurnErrored) {",
  "      } else if (criticToolError || criticValidationMiss || periodic) {\n        if (criticValidationMiss && !criticToolError) {",
  1,
  'critic mismatch gating',
);

source = source
  .replace('inspect the SETTLED result surface', 'inspect the post-action result surface')
  .replace('Results load via AJAX - settle + re-snapshot ONCE for a real read.', 'Use at most one fast fresh snapshot when cached result evidence is inconclusive.');

fs.writeFileSync(outputPath, source, 'utf8');
process.stdout.write(`${outputPath}\n`);
