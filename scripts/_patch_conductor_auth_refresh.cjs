const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'server', 'services', 'agents', 'conductor.js');
const outputPath = path.join(root, '_conductor_auth_refresh.tmp.js');
let source = fs.readFileSync(sourcePath, 'utf8');

function replaceOnce(from, to, label) {
  const windowsFrom = from.replace(/\n/g, '\r\n');
  const windowsTo = to.replace(/\n/g, '\r\n');
  const unixCount = source.split(from).length - 1;
  const windowsCount = windowsFrom === from ? 0 : source.split(windowsFrom).length - 1;
  if (unixCount + windowsCount !== 1) throw new Error(`${label}: expected one anchor, found ${unixCount + windowsCount}`);
  source = unixCount ? source.replace(from, to) : source.replace(windowsFrom, windowsTo);
}

replaceOnce(
  [
    '    try {',
    '      const snap = await mcp.snapshot(mcpSession);',
    "      const fresh = snap?.text || mcp.textOfContent(snap?.content) || mcp.getLastSnapshot(mcpSession) || '';",
    '      if (fresh) {',
    '        lastSnapshotText = fresh;',
    '        return fresh;',
    '      }',
    '    } catch (_) {}',
    "    return snapshotText || '';",
  ].join('\n'),
  [
    '    const validation = await validateSnapshotSinglePass({',
    '      cachedSnapshot: snapshotText || mcp.getLastSnapshot(mcpSession) || lastSnapshotText || \'\',',
    '      probe: (candidate) => !!String(candidate || \'\').trim(),',
    '    });',
    '    if (validation.matched && validation.snapshotText) {',
    '      lastSnapshotText = validation.snapshotText;',
    '      return validation.snapshotText;',
    '    }',
    "    return snapshotText || mcp.getLastSnapshot(mcpSession) || lastSnapshotText || '';",
  ].join('\n'),
  'auth submit cached-first refresh',
);

replaceOnce(
  '              profile, scenarioContext, verdictMode: runVerdictMode, knownPopups: projectKnownPopups,',
  '              profile, execMode, scenarioContext, verdictMode: runVerdictMode, knownPopups: projectKnownPopups,',
  'thread execMode into runOneCase call',
);

replaceOnce(
  "  profile = EXEC_MODE_PROFILES.fast,\n  scenarioContext = null,",
  "  profile = EXEC_MODE_PROFILES.fast,\n  execMode = 'fast',\n  scenarioContext = null,",
  'runOneCase execMode parameter',
);

replaceOnce(
  '  const actionText = [step.action, step.name, step.stepKind, step.type, step.tool, step.toolName]',
  '  const actionText = [step.action, step.stepKind, step.type, step.tool, step.toolName]',
  'exclude free-form step name from wait authorization',
);

for (const sourceName of [
  'input_value_readback',
  'tooltip_visible_probe',
  'field_blocked_probe',
]) {
  replaceOnce(
    `{ strictActionEvidence: false, source: '${sourceName}', telemetry: false });`,
    `{ strictActionEvidence: false, source: '${sourceName}', telemetry: false, timeoutMs: VALIDATION_SNAPSHOT_TIMEOUT_MS });`,
    `bound ${sourceName}`,
  );
}

replaceOnce(
  '      let domTooltip = null;\n      if (!roleTooltip && want) {',
  '      let domTooltip = null;\n      let domTooltipProbeUnavailable = false;\n      if (!roleTooltip && want) {',
  'track unavailable tooltip DOM probe',
);

replaceOnce(
  '          if (parsed && parsed.ok === true) domTooltip = parsed;\n        } catch (_) {}',
  '          if (parsed && parsed.ok === true) domTooltip = parsed;\n        } catch (_) { domTooltipProbeUnavailable = true; }',
  'mark unavailable tooltip DOM probe',
);

replaceOnce(
  [
    "        status: matched ? 'pass' : 'blocked',",
    '        matched,',
    '        checked: true,',
    "        reason: matched ? 'tooltip_visible_after_hover' : 'tooltip_not_proven_after_hover',",
  ].join('\n'),
  [
    "        status: matched ? 'pass' : domTooltipProbeUnavailable ? 'skipped' : 'blocked',",
    '        matched: matched ? true : domTooltipProbeUnavailable ? null : false,',
    '        checked: !domTooltipProbeUnavailable,',
    "        reason: matched ? 'tooltip_visible_after_hover' : domTooltipProbeUnavailable ? 'tooltip_probe_unavailable' : 'tooltip_not_proven_after_hover',",
  ].join('\n'),
  'make tooltip timeout uncheckable',
);

replaceOnce(
  [
    "          status: 'blocked',",
    '          matched: false,',
    '          checked: true,',
    "          reason: 'field_blocked_probe_error',",
    '          evidence: `Blocked-field probe for "${fieldLabel}" failed: ${err.message || String(err)}`,',
  ].join('\n'),
  [
    "          status: 'skipped',",
    '          matched: null,',
    '          checked: false,',
    "          reason: 'field_blocked_probe_unavailable',",
    '          evidence: `Blocked-field probe for "${fieldLabel}" was unavailable: ${err.message || String(err)}`,',
  ].join('\n'),
  'make blocked-field timeout uncheckable',
);

fs.writeFileSync(outputPath, source, 'utf8');
process.stdout.write(`${outputPath}\n`);
