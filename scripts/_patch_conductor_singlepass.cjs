const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'server', 'services', 'agents', 'conductor.js');
const outputPath = path.join(root, '_conductor_singlepass.final.tmp.js');
let source = fs.readFileSync(sourcePath, 'utf8');

function replaceOnce(from, to, label) {
  const first = source.indexOf(from);
  if (first < 0) throw new Error(`Missing conductor anchor: ${label}`);
  if (source.indexOf(from, first + from.length) >= 0) throw new Error(`Duplicate conductor anchor: ${label}`);
  source = source.slice(0, first) + to + source.slice(first + from.length);
}

replaceOnce(
  "  if (authored && String(authored.kind || 'wait').toLowerCase() !== 'none') return true;",
  "  if (authored && /^(?:wait|stabilization)$/i.test(String(authored.kind || ''))) return true;",
  'strict authored wait kind',
);

replaceOnce(
  "  if (/^(?:wait|stabilization|event)$/i.test(String(check.kind || ''))) return true;\n  return ['timeoutMs', 'timeout', 'pollIntervalMs', 'pollMs', 'stableObservations', 'refreshAfterMs']\n    .some((key) => Object.prototype.hasOwnProperty.call(check, key));",
  "  return /^(?:wait|stabilization)$/i.test(String(check.kind || ''));",
  'strict operation wait kind',
);

replaceOnce(
  "If you need to SELECT ALL existing text in a field and REPLACE it: use browser_fill",
  [
    '## ZERO-LATENCY VALIDATION RULE - HIGHEST PRIORITY',
    '',
    'browser_wait_for is FORBIDDEN for ordinary action checks and verification.',
    'After an action, use the cached post-action snapshot; if it is inconclusive,',
    'take at most ONE browser_snapshot and decide immediately. Do not sleep or poll.',
    'browser_wait_for is allowed only when the backend-selected current step itself',
    'is explicitly authored as Wait, Pause, Delay, Sleep, or stabilization.',
    'Lower tool examples that suggest waiting do not override this rule.',
    '',
    'If you need to SELECT ALL existing text in a field and REPLACE it: use browser_fill',
  ].join('\n'),
  'zero-latency prompt rule',
);

replaceOnce(
  "  _expectedIsAuthProviderTransition: expectedIsAuthProviderTransition,\n  _resolvePageReadyProbe: resolvePageReadyProbe,\n  _drainExecutionFixedPoint: drainExecutionFixedPoint,",
  "  _expectedIsAuthProviderTransition: expectedIsAuthProviderTransition,\n  _approvedStepAllowsBrowserWait: approvedStepAllowsBrowserWait,\n  _resolvePageReadyProbe: resolvePageReadyProbe,\n  _validateSnapshotSinglePassPolicy: validateSnapshotSinglePassPolicy,\n  _drainExecutionFixedPoint: drainExecutionFixedPoint,",
  'single-pass test seams',
);

fs.writeFileSync(outputPath, source, 'utf8');
process.stdout.write(`${outputPath}\n`);
