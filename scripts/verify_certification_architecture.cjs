'use strict';

/**
 * Guard for the high-level QAAI certification architecture.
 *
 * This is deliberately pure/deterministic: no browser, no DB writes, no LLM.
 * It proves future unknown edge cases cannot silently become website defects.
 */

const certification = require('../server/services/certificationKernel');
const runs = require('../server/services/runs');
const fs = require('fs');
const path = require('path');

let failures = 0;
function ok(msg) { console.log(`  ok: ${msg}`); }
function bad(msg) { console.log(`  FAIL: ${msg}`); failures++; }
function assert(cond, msg, detail = '') { cond ? ok(msg) : bad(`${msg}${detail ? ` (${detail})` : ''}`); }

console.log('\n[1] Unknown edge cases become QAAI-owned certification gaps');
{
  const gap = certification.buildUnknownGap({
    layer: 'browser_runtime',
    where: 'case TC-1 step 3',
    detail: 'unexpected MCP transport payload',
    evidenceRef: 'evidence/run-1/tool-3.json',
  });
  assert(gap.code === 'unknown_browser_runtime_gap', 'stable unknown gap code');
  assert(gap.ownership === 'qaai', 'unknown gap is owned by QAAI');
  assert(gap.blocksWebsiteVerdict === true, 'unknown gap blocks website verdict');
  assert(gap.description.includes('unexpected MCP transport payload'), 'unknown gap carries human detail');
  assert(certification.isInternalCertificationGap(gap), 'unknown gap is classified as internal certification');
}

console.log('\n[2] Verdict firewall blocks website fail without assertion evidence');
{
  const decision = certification.verdictFirewall({
    intendedStatus: 'fail',
    replayEnvelope: { complete: true, verdict: { perAssertionOutcomes: [] } },
  });
  assert(decision.websiteVerdictAllowed === false, 'fail without evidence is not a website defect');
  assert(decision.finalStatus === 'blocked', 'fail without evidence becomes blocked/internal');
  assert(decision.gaps.some((g) => g.code === 'missing_website_failure_proof'), 'missing proof gap is explicit');
}

console.log('\n[3] Website fail is allowed only when assertion evidence proves it');
{
  const decision = certification.verdictFirewall({
    intendedStatus: 'fail',
    replayEnvelope: {
      complete: true,
      verdict: { perAssertionOutcomes: [{ assertionId: 'A1', status: 'not_matched' }] },
    },
  });
  assert(decision.websiteVerdictAllowed === true, 'website fail allowed with not_matched evidence');
  assert(decision.classification === 'website_failure', 'classification is website_failure');
  assert(decision.finalStatus === 'fail', 'final status remains fail');

  const legacyDecision = certification.verdictFirewall({
    intendedStatus: 'fail',
    replayEnvelope: { complete: true, verdict: { perAssertionOutcomes: [] } },
    assertionOutcomes: [{ assertion: 'Dashboard visible', matched: false }],
  });
  assert(legacyDecision.websiteVerdictAllowed === true, 'legacy matched:false assertion evidence also allows website fail');
}

console.log('\n[4] Export/package/codegen gaps do not rewrite proven website verdicts');
{
  const decision = certification.verdictFirewall({
    intendedStatus: 'fail',
    replayEnvelope: {
      complete: true,
      verdict: { perAssertionOutcomes: [{ assertionId: 'A1', status: 'not_matched' }] },
    },
    packageValidation: { skipped: true, reason: 'local @playwright/test missing' },
  });
  assert(decision.websiteVerdictAllowed === true, 'package skip does not rewrite a proven website failure');
  assert(decision.classification === 'website_failure', 'classification stays website_failure');
  assert(decision.finalStatus === 'fail', 'final status remains fail');

  const codegenDecision = certification.verdictFirewall({
    intendedStatus: 'pass',
    replayEnvelope: {
      complete: false,
      gaps: [{ code: 'missing_verified_action_locator', detail: 'export locator evidence incomplete' }],
      verdict: { perAssertionOutcomes: [{ assertionId: 'A1', status: 'matched' }] },
    },
    codegenDiagnostics: 'TS2345 generated code does not compile',
  });
  assert(codegenDecision.websiteVerdictAllowed === true, 'export/codegen gaps do not turn a passing website run into blocked');
  assert(codegenDecision.classification === 'website_pass', 'classification stays website_pass');
  assert(codegenDecision.finalStatus === 'pass', 'final status remains pass');
}

console.log('\n[5] Run export preflight uses normalized certification gaps');
{
  const preflight = runs.buildExportPreflight([
    { id: 'RR-MISSING', testCaseId: 'TC-MISSING', status: 'pass', replayIrJson: null, testCase: { name: 'Missing IR' } },
    {
      id: 'RR-UNKNOWN',
      testCaseId: 'TC-UNKNOWN',
      status: 'blocked',
      replayIrJson: JSON.stringify({
        complete: false,
        gaps: [{ code: 'unknown_browser_runtime_gap', detail: 'snapshot parser returned impossible shape' }],
      }),
      testCase: { name: 'Unknown browser edge' },
    },
  ]);
  assert(preflight.certified === false, 'preflight is not certified when gaps exist');
  assert(preflight.held === 2, 'both cases are held');
  const unknown = preflight.blockedCases.find((c) => c.runResultId === 'RR-UNKNOWN');
  assert(unknown && unknown.reason === 'unknown_browser_runtime_gap', 'unknown gap reason is preserved');
  assert(unknown && unknown.gaps[0].ownership === 'qaai', 'unknown preflight gap is QAAI-owned');
  assert(unknown && unknown.message.includes('snapshot parser'), 'unknown preflight message is human-readable');
}

console.log('\n[6] Conductor persists through the central verdict firewall');
{
  const conductorSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'agents', 'conductor.js'), 'utf8');
  assert(/certificationKernel/.test(conductorSource), 'conductor imports certification kernel');
  assert(/verdictFirewall/.test(conductorSource), 'conductor calls verdictFirewall before persistence');
  assert(/internal_certification_gap/.test(conductorSource), 'firewall downgrade uses internal certification blocked reason');
  assert(/missing_website_failure_proof/.test(JSON.stringify(certification.GAP_CATALOG)), 'kernel catalogs missing website failure proof');
  const replayIrIncompleteBlock = conductorSource.slice(
    conductorSource.indexOf('if (emit.complete === false)'),
    conductorSource.indexOf('} else {', conductorSource.indexOf('if (emit.complete === false)')),
  );
  assert(!/status\s*:\s*['"]blocked['"]/.test(replayIrIncompleteBlock), 'ReplayIR export gaps do not mutate RunResult.status to blocked');
  assert(!/blockedReason\s*:\s*['"]internal_evidence_gap['"]/.test(replayIrIncompleteBlock), 'ReplayIR export gaps do not create runtime blocked reason');
}

console.log(`\n${failures === 0 ? 'PASS - certification architecture guard green' : `FAIL - ${failures} certification guard(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
