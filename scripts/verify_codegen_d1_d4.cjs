'use strict';
/**
 * Guard: verifies all four D1–D4 structural defects are closed in the
 * playwrightReference and playwrightPom adapters.
 *
 * D1 — readData(row,…) crash: emitStep must check hasDataLoop before emitting readData;
 *      _journeyStepLines must pass { hasDataLoop: false }.
 * D2 — inline candidate JSON: _journeyStepLines must build a locatorsMap and
 *      prepend a LOCATORS const block; emitLocatorResolver must accept + use the map.
 * D3 — not_matched + non-must hard assert: emitAssertion must return a soft annotation
 *      when liveOutcome===not_matched and criticality!==must.
 * D4 — context switch comment pollution: neither adapter may emit the 4-line
 *      tab-switch speculation comment block.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REF = fs.readFileSync(path.join(ROOT, 'server/services/codegen/adapters/playwrightReference.js'), 'utf8');
const POM = fs.readFileSync(path.join(ROOT, 'server/services/codegen/adapters/playwrightPom.js'), 'utf8');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`  PASS  ${label}`); pass++; }
  else     { console.error(`  FAIL  ${label}${detail ? ': ' + detail : ''}`); fail++; }
}

// ── D1 checks ────────────────────────────────────────────────────────────────

check('D1: emitStep accepts loopOpts parameter',
  /function emitStep\s*\([^)]*loopOpts/.test(REF));

check('D1: emitStep checks hasDataLoop before emitting readData',
  /hasDataLoop\s*&&/.test(REF) || /&& hasDataLoop/.test(REF));

check('D1: _journeyStepLines passes { hasDataLoop: false } to emitStep',
  REF.includes('hasDataLoop: false'));

check('D1: readData(row,…) is NOT emitted unconditionally on step.dataRole (REF)',
  !/const value = step\.dataRole \? `readData\(row/.test(REF));

// D1 in POM adapter
check('D1: pomEmitAct accepts hasDataLoop parameter',
  /function pomEmitAct\s*\([^)]*hasDataLoop/.test(POM));

check('D1: pomEmitAct guards readData with hasDataLoop',
  /step\.dataRole && hasDataLoop/.test(POM));

check('D1: pomEmitAssert accepts hasDataLoop parameter',
  /function pomEmitAssert\s*\([^)]*hasDataLoop/.test(POM));

check('D1: pomEmitAssert guards dataExpected readData with hasDataLoop',
  /step\.dataExpected && hasDataLoop/.test(POM));

check('D1: _pomJourneyStepLines passes computed hasDataLoop to pomEmitAct',
  /pomEmitAct\(step,\s*asMap,\s*hasDataLoop,/.test(POM));

check('D1: _pomJourneyStepLines passes computed hasDataLoop to pomEmitAssert',
  /pomEmitAssert\(step,\s*asMap,\s*evalMap,\s*hasDataLoop\)/.test(POM));

check('D1: readData(row,…) is NOT emitted unconditionally on step.dataRole (POM)',
  !/const value = step\.dataRole \? `readData\(row/.test(POM));

// ── D2 checks ────────────────────────────────────────────────────────────────

check('D2: emitLocatorResolver accepts locatorsMap parameter',
  /function emitLocatorResolver\s*\([^)]*locatorsMap/.test(REF));

check('D2: emitLocatorResolver writes to locatorsMap when provided',
  REF.includes('locatorsMap[name] = norm'));

check('D2: emitLocatorResolver emits LOCATORS.name reference when locatorsMap present',
  REF.includes('LOCATORS.${name}'));

check('D2: _journeyStepLines creates locatorsMap object',
  REF.includes('const locatorsMap = {}'));

check('D2: _journeyStepLines passes locatorsMap to emitLocatorResolver',
  REF.includes('emitLocatorResolver(step.candidates, step, finalName, locatorsMap)'));

check('D2: _journeyStepLines prepends LOCATORS const block',
  REF.includes("lines.unshift(...['', '    const LOCATORS = {'") ||
  REF.includes("const LOCATORS = {"));

// ── D3 checks ────────────────────────────────────────────────────────────────

check('D3: emitAssertion has not_matched + non-must early return',
  REF.includes("step.liveOutcome === 'not_matched'") &&
  REF.includes("step.criticality !== 'must'"));

check('D3: early return emits qaai-degraded-pass annotation (not a hard expect)',
  REF.includes('qaai-degraded-pass'));

check('D3: not_matched + non-must path returns before any expect() channel code',
  (() => {
    // The early return for not_matched+non-must must appear BEFORE the expected-value
    // computation (which feeds into hard expect() calls). Verify by line-order check:
    const notMatchedIdx = REF.indexOf("step.liveOutcome === 'not_matched'");
    const expectedComputeIdx = REF.indexOf('const expected = step.dataExpected');
    // The early return must be defined before the expected computation
    return notMatchedIdx > 0 && expectedComputeIdx > 0 && notMatchedIdx < expectedComputeIdx;
  })());

// ── D4 checks ────────────────────────────────────────────────────────────────

const tabSwitchComment = 'URL changed without a recorded navigate — a browser tab switch';

check('D4: playwrightReference does NOT emit tab-switch comment in generated spec',
  !REF.includes('`      // QAAI: ' + tabSwitchComment.slice(0, 40)));

check('D4: playwrightPom does NOT emit tab-switch comment in generated spec',
  !POM.includes('`      // QAAI: ' + tabSwitchComment.slice(0, 40)));

check('D4: contextSwitchInferred in playwrightReference emits bare goto (no join array)',
  (() => {
    const m = REF.match(/if \(step\.contextSwitchInferred\)[^}]+\}/s);
    if (!m) return false;
    // Should return a string, not an array.join
    return !m[0].includes('.join(') && m[0].includes('page.goto');
  })());

check('D4: contextSwitchInferred in playwrightPom emits bare goto',
  (() => {
    const m = POM.match(/if \(step\.contextSwitchInferred\)[^}]+\}/s);
    if (!m) return false;
    return !m[0].includes('.join(') && m[0].includes('page.goto');
  })());

console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
