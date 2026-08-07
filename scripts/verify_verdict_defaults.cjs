'use strict';
/*
 * CONDUCTOR RELIABILITY — verdict defaults + honest flip direction.
 *  #2 mechanical_v1 is the DEFAULT verdict mode (legacy is opt-in only), so new
 *     projects/runs are judged by the evidence-anchored oracle, not the agent's claim.
 *  #3 a backend auto-closeout (agent made NO pass/fail claim) must NOT register as a
 *     verdict flip/disagreement.
 * Pure functions, no DB.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const flags = require(path.join(ROOT, 'server', 'lib', 'verdictFlags'));
const { deriveFlipDirection } = require(path.join(ROOT, 'server', 'services', 'computeVerdict'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

console.log('— #2 mechanical_v1 is the DEFAULT verdict mode (legacy opt-in only) —');
{
  const save = process.env.QAAI_VERDICT_MODE;
  delete process.env.QAAI_VERDICT_MODE;
  ok('no env set → mechanical_v1 (was legacy)', flags.envVerdictMode() === 'mechanical_v1');
  process.env.QAAI_VERDICT_MODE = 'legacy';
  ok('env=legacy → legacy (opt-in preserved for historical)', flags.envVerdictMode() === 'legacy');
  process.env.QAAI_VERDICT_MODE = 'mechanical_v1';
  ok('env=mechanical_v1 → mechanical_v1', flags.envVerdictMode() === 'mechanical_v1');
  if (save === undefined) delete process.env.QAAI_VERDICT_MODE; else process.env.QAAI_VERDICT_MODE = save;
}
{
  const save = process.env.QAAI_VERDICT_MODE; delete process.env.QAAI_VERDICT_MODE;
  ok('project with NO override → mechanical_v1', flags.resolveVerdictMode({}) === 'mechanical_v1');
  ok('project verdictMode=legacy → legacy (explicit override honored)', flags.resolveVerdictMode({ verdictMode: 'legacy' }) === 'legacy');
  ok('project verdictMode=mechanical_v1 → mechanical_v1', flags.resolveVerdictMode({ verdictMode: 'mechanical_v1' }) === 'mechanical_v1');
  if (save === undefined) delete process.env.QAAI_VERDICT_MODE; else process.env.QAAI_VERDICT_MODE = save;
}

console.log('\n— #3 backend auto-closeout is NOT a verdict flip (agent made no pass/fail claim) —');
ok('backend_auto_closeout vs pass → no flip (null)', deriveFlipDirection('backend_auto_closeout', 'pass') === null);
ok('backend_auto_closeout vs fail → no flip (null)', deriveFlipDirection('backend_auto_closeout', 'fail') === null);
ok('no claim (null) → no flip', deriveFlipDirection(null, 'pass') === null);
console.log('  (real agent pass/fail claims still flip:)');
ok('agent claimed fail, mechanical pass → FAIL_TO_PASS', deriveFlipDirection('fail', 'pass') === 'FAIL_TO_PASS');
ok('agent claimed pass, mechanical fail → PASS_TO_FAIL', deriveFlipDirection('pass', 'fail') === 'PASS_TO_FAIL');
ok('agent claimed pass, mechanical pass → no flip', deriveFlipDirection('pass', 'pass') === null);

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — mechanical_v1 is the default verdict (legacy opt-in only); a backend auto-closeout never registers as an agent verdict flip, while real agent pass/fail claims still flip against the mechanical verdict.');
