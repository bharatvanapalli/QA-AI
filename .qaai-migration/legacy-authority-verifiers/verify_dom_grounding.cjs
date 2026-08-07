'use strict';
/**
 * Guard: domGrounded pipeline integrity.
 *
 * Verifies that:
 *  1. mcp.js computes domGrounded and puts it in the assertion_check payload
 *  2. conductor.js stores domGrounded=false in v2Recorded when received
 *  3. replayExport.js reduceAssertionOutcomes carries domGrounded through
 *  4. replayExport.js stamps step.liveDomGrounded=false on assert steps
 *  5. playwrightReference.js emits uncheckable annotation when liveDomGrounded===false
 *  6. assertTextPresent no longer has the visibility gate (uses ARIA-scope matching)
 */

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

const errs = [];
function check(label, condition) {
  if (!condition) errs.push(`FAIL  ${label}`);
  else console.log(`  PASS  ${label}`);
}

// ── 1. mcp.js: domGrounded computation ───────────────────────────────────
const mcpSrc = read('server/services/mcp.js');
check(
  'mcp.js: domGrounded flag computed for text assertions',
  mcpSrc.includes('const domGrounded = matched && expectedText')
);
check(
  'mcp.js: textMatchedViaEvalCache check',
  mcpSrc.includes('textMatchedViaEvalCache') && mcpSrc.includes('text:OK from browser_evaluate')
);
check(
  'mcp.js: textMatchedViaRescue check',
  mcpSrc.includes('textMatchedViaRescue') && mcpSrc.includes('semanticRescue.rescued')
);
check(
  'mcp.js: domGrounded included in matched payload',
  mcpSrc.includes('domGrounded,')
);

// ── 2. conductor.js: domGrounded stored in v2Recorded ────────────────────
const conductorSrc = read('server/services/agents/conductor.js');
check(
  'conductor.js: domGrounded=false stored in v2Recorded when received',
  conductorSrc.includes('parsed?.domGrounded === false') && conductorSrc.includes('rec.domGrounded = false')
);

// ── 3. replayExport.js: reduceAssertionOutcomes carries domGrounded ───────
const replayExportSrc = read('server/services/codegen/replayExport.js');
check(
  'replayExport.js: reduceAssertionOutcomes returns objects with domGrounded',
  replayExportSrc.includes('domGrounded: a.domGrounded !== false')
);
check(
  'replayExport.js: domGrounded=false stays false across higher-rank outcomes',
  replayExportSrc.includes('existing.domGrounded !== false')
);

// ── 4. replayExport.js: step.liveDomGrounded stamped ─────────────────────
check(
  'replayExport.js: step.liveDomGrounded stamped when domGrounded===false',
  replayExportSrc.includes('step.liveDomGrounded = false')
);
check(
  'replayExport.js: lo.outcome used (not raw object) for step.liveOutcome',
  replayExportSrc.includes('step.liveOutcome = lo.outcome')
);

// ── 5. playwrightReference.js: uncheckable emitted for liveDomGrounded===false
const refSrc = read('server/services/codegen/adapters/playwrightReference.js');
check(
  'playwrightReference.js: liveDomGrounded===false guard present',
  refSrc.includes("step.liveDomGrounded === false")
);
check(
  'playwrightReference.js: qaai-uncheckable annotation emitted for ungrounded text assertions',
  refSrc.includes("type: 'qaai-uncheckable'") &&
  refSrc.includes('browser_evaluate cache or semantic rescue')
);
check(
  'playwrightReference.js: only applies to UI_TEXT / FORBIDDEN_TEXT channels',
  /liveDomGrounded === false[\s\S]{0,200}UI_TEXT/.test(refSrc)
);

// ── 6. assertTextPresent: no visibility gate ─────────────────────────────
check(
  'playwrightReference.js: assertTextPresent has no strict visibility gate (removed visibleCount throw)',
  !refSrc.includes('throw new Error(`Assertion ${contractRef || \'unknown\'} expected visible text')
);
check(
  'playwrightReference.js: assertTextPresent uses expect(locator).not.toHaveCount(0) as sole gate',
  refSrc.includes("await expect(locator).not.toHaveCount(0, { timeout: timeoutMs });")
);

if (errs.length) {
  console.error('\n' + errs.join('\n'));
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
