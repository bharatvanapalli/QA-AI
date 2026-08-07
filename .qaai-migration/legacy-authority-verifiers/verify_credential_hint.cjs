'use strict';
/**
 * Guard: verifies the credentialHint pipeline is wired correctly.
 *
 * Checks:
 * 1. Architect normalizeCase passes through credentialHint:'invalid', rejects other values
 * 2. testCaseContract.js persistCases embeds credentialHint in operationsJson
 * 3. conductor.js dynamicSuffix injection block is present
 * 4. _journey.js negative credential exception still covers caseName-based fallback
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`  PASS  ${label}`); pass++; }
  else     { console.error(`  FAIL  ${label}${detail ? ': ' + detail : ''}`); fail++; }
}

// 1. architect.js — normalizeCase must pass credentialHint through
const architectSrc = fs.readFileSync(path.join(__dirname, '../server/services/agents/architect.js'), 'utf8');
check('architect: credentialHint field in JSON schema comment',
  architectSrc.includes('"credentialHint": "primary" | "invalid"'));
check('architect: normalizeCase extracts credentialHint',
  architectSrc.includes("c.credentialHint === 'invalid' ? 'invalid' : undefined"));
check('architect: normalizeCase returns credentialHint',
  /return \{[^}]*credentialHint[^}]*\}/.test(architectSrc));
check('architect: negative-login rule references credentialHint',
  architectSrc.includes('credentialHint": "invalid"'));

// 2. testCaseContract.js — must embed credentialHint in operationsJson
const contractSrc = fs.readFileSync(path.join(__dirname, '../server/services/testCaseContract.js'), 'utf8');
check('testCaseContract: reads c.credentialHint',
  contractSrc.includes("c.credentialHint === 'invalid' ? 'invalid' : undefined"));
check('testCaseContract: credentialHint in operationsJson condition',
  contractSrc.includes('hasOps || credentialHint'));
check('testCaseContract: credentialHint spread into operationsJson object',
  contractSrc.includes('credentialHint ? { credentialHint }'));

// 3. conductor.js — dynamic suffix injection
const conductorSrc = fs.readFileSync(path.join(__dirname, '../server/services/agents/conductor.js'), 'utf8');
check('conductor: parses operationsJson for credentialHint',
  conductorSrc.includes("opsObj.credentialHint === 'invalid'"));
check('conductor: injects CREDENTIAL INTENT block into dynamicSuffix',
  conductorSrc.includes('CREDENTIAL INTENT — INVALID'));
check('conductor: instruction to use WRONG values',
  conductorSrc.includes('WRONG values'));

// 4. _journey.js — caseName fallback still present
const journeySrc = fs.readFileSync(path.join(__dirname, '../server/services/codegen/_journey.js'), 'utf8');
check('_journey: caseName-based negative credential exception still present',
  journeySrc.includes('NEGATIVE CREDENTIAL EXCEPTION'));

console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
