'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const BASE = 'http://localhost:5000';
const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const RUN_ID = 'a0d7891d-dc96-424e-b1b2-15856d19dae5';
const USER = { sub: 'a5d916cd-4178-4bcc-b409-c885a389e843', email: 'bharatvanapalli8@gmail.com', role: 'user' };

function makeHeaders() {
  const token = jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: '2h' });
  const csrf = crypto.randomBytes(16).toString('hex');
  return { Cookie: `token=${token}; XSRF-TOKEN=${csrf}`, 'x-xsrf-token': csrf };
}

function walkTree(node, out = []) {
  if (!node) return out;
  if (node.type === 'file' && String(node.path || '').endsWith('.spec.js')) out.push(node.path);
  (node.children || []).forEach(c => walkTree(c, out));
  return out;
}

// Q11 (correct): within a single test.step block, the same resolveLocator
// candidate array must not appear twice (that would be a const redeclaration).
// Cross-step reuse is CORRECT (each step has its own scope).
function checkQ11WithinSteps(content) {
  const stepRe = /await test\.step\([^,]+,\s*async\s*\(\)\s*=>\s*\{([\s\S]*?)\}\s*\)/g;
  let m;
  const violations = [];
  while ((m = stepRe.exec(content)) !== null) {
    const stepBody = m[1];
    const candidateBlocks = [];
    const lcRe = /await resolveLocator\(page,\s*(\[[\s\S]*?\])/g;
    let lm;
    while ((lm = lcRe.exec(stepBody)) !== null) {
      const key = lm[1].replace(/\s+/g, ' ');
      if (candidateBlocks.includes(key)) violations.push(key.slice(0, 60));
      else candidateBlocks.push(key);
    }
  }
  return violations;
}

// Q4: evaluateSettled IIFE must use arrow-expression body (() => expr), NOT block body
// Block body: async () => { ... } without explicit return — returns undefined
function checkQ4Iife(content) {
  // Look for evaluateSettled(page, async () => { ... } ) with a block body
  // We flag patterns where the IIFE uses { } without a return statement
  const re = /evaluateSettled\s*\(\s*page\s*,\s*async\s*\(\s*\)\s*=>\s*\{([^}]*)\}\s*[,)]/g;
  let m;
  const bad = [];
  while ((m = re.exec(content)) !== null) {
    const body = m[1].trim();
    // Block body without return = bug
    if (body.length > 0 && !/^\s*return\s/.test(body)) {
      bad.push(body.slice(0, 80).trim());
    }
  }
  return bad;
}

(async () => {
  const headers = makeHeaders();

  // Manifest
  const mRes = await fetch(
    `${BASE}/api/projects/${PROJECT_ID}/output-files/file/EXPORT_MANIFEST.json?source=replayir&runId=${RUN_ID}`,
    { headers }
  );
  const mBody = await mRes.json().catch(() => ({}));
  const mContent = mBody.content ? JSON.parse(mBody.content) : mBody;
  const entries = mContent?.entries || [];
  const blocked = entries.filter(e => e.blockReason);
  const exported = entries.filter(e => !e.blockReason && e.files && e.files.length > 0);

  console.log(`=== MANIFEST ===`);
  console.log(`Total: ${entries.length}  Exported: ${exported.length}  Blocked: ${blocked.length}`);
  const blockGroups = {};
  blocked.forEach(e => { const k = e.blockReason || 'unknown'; blockGroups[k] = (blockGroups[k]||0)+1; });
  console.log('Block reasons:', JSON.stringify(blockGroups));
  console.log('\nNote: replayir_missing = case never ran (run was cancelled) — expected.');
  console.log('      replayir_incomplete = case ran but IR incomplete — re-run needed.');

  // Tree
  const treeRes = await fetch(
    `${BASE}/api/projects/${PROJECT_ID}/output-files/?source=replayir&runId=${RUN_ID}`,
    { headers }
  );
  const treeData = await treeRes.json().catch(() => ({}));
  const specFiles = walkTree(treeData?.tree);

  console.log(`\nSpec files: ${specFiles.length}`);
  specFiles.forEach(f => console.log('  ' + f));

  // Per-spec audit
  const results = [];
  for (const specPath of specFiles) {
    const fRes = await fetch(
      `${BASE}/api/projects/${PROJECT_ID}/output-files/file/${encodeURIComponent(specPath)}?source=replayir&runId=${RUN_ID}`,
      { headers }
    );
    if (!fRes.ok) continue;
    const fBody = await fRes.json().catch(() => ({}));
    const content = fBody.content || '';
    if (!content) continue;

    const elVars         = content.match(/\bconst el\d+\s*=/g) || [];
    const inlineLocators = content.match(/\bpage\.(getByRole|getByText|getByLabel|getByPlaceholder|locator)\s*\(/g) || [];
    const asnHashes      = content.match(/ASN-[a-f0-9]+/g) || [];
    const resolveCount   = (content.match(/await resolveLocator\s*\(/g) || []).length;
    const envCreds       = content.match(/process\.env\.(QAAI_USERNAME|QAAI_PASSWORD)/g) || [];
    const q11Violations  = checkQ11WithinSteps(content);
    const q4Bad          = checkQ4Iife(content);

    // Collect all variable names from resolveLocator declarations
    const varNames = [];
    const varRe = /const\s+(\w+)\s*=\s*await resolveLocator\s*\(/g;
    let vm;
    while ((vm = varRe.exec(content)) !== null) varNames.push(vm[1]);

    const q1 = inlineLocators.length === 0;
    const q2 = elVars.length === 0;
    const q3 = asnHashes.length === 0;
    const q4 = q4Bad.length === 0;
    const q8 = envCreds.length === 0;
    const q11 = q11Violations.length === 0;

    results.push({ specPath, q1, q2, q3, q4, q8, q11, resolveCount, elVars, inlineLocators, asnHashes, q4Bad, q11Violations, envCreds, varNames, content });
  }

  console.log('\n=== PER-SPEC QUALITY AUDIT (Q1-Q4, Q8, Q11) ===');
  for (const r of results) {
    const pass = r.q1 && r.q2 && r.q3 && r.q4 && r.q8 && r.q11;
    const icon = pass ? '✓' : '✗';
    const name = path.basename(r.specPath);
    console.log(`\n${icon} ${name}`);
    console.log(`  Q1 inline locators         : ${r.q1 ? 'PASS' : 'FAIL ('+r.inlineLocators.length+')'}`);
    console.log(`  Q2 el1/el2 variable names  : ${r.q2 ? 'PASS' : 'FAIL: '+r.elVars.slice(0,3).join(',')}`);
    console.log(`  Q3 ASN hashes in output    : ${r.q3 ? 'PASS' : 'FAIL ('+r.asnHashes.length+')'}`);
    console.log(`  Q4 IIFE block-body (no ret): ${r.q4 ? 'PASS' : 'FAIL — '+r.q4Bad.length+' block-body IIFEs without return'}`);
    console.log(`  Q8 env creds in spec       : ${r.q8 ? 'PASS (no QAAI_USERNAME/QAAI_PASSWORD)' : 'NOTE: '+r.envCreds.join(',')}`);
    console.log(`  Q11 within-step dup elems  : ${r.q11 ? 'PASS' : 'FAIL ('+r.q11Violations.length+' duplicate within same step)'}`);
    console.log(`  resolveLocator calls total : ${r.resolveCount}`);
    console.log(`  Variable names used        : ${[...new Set(r.varNames)].join(', ')}`);
    if (!r.q4 && r.q4Bad.length) console.log(`    Q4 bad bodies: ${r.q4Bad.slice(0,2).join(' | ')}`);
    if (!r.q11 && r.q11Violations.length) console.log(`    Q11 within-step dups: ${r.q11Violations.slice(0,2).join(' | ')}`);
  }

  // Q8 special: for invalid-credentials spec, check it fills literal values, not env vars
  const invalidSpec = results.find(r => r.specPath.includes('invalid-credentials'));
  if (invalidSpec) {
    const fillLiterals = invalidSpec.content.match(/\.fill\("([^"]+)"\)/g) || [];
    console.log(`\nQ8 deep check (invalid-credentials fills):`);
    fillLiterals.forEach(f => console.log('  ' + f));
  }

  const allPass = results.every(r => r.q1 && r.q2 && r.q3 && r.q4 && r.q8 && r.q11);
  console.log(`\n=== SUMMARY ===`);
  console.log(`Specs: ${results.length} audited, ${results.filter(r => r.q1&&r.q2&&r.q3&&r.q4&&r.q8&&r.q11).length} all-pass`);
  console.log(`Q1: ${results.every(r=>r.q1)?'ALL PASS':'SOME FAIL'}`);
  console.log(`Q2: ${results.every(r=>r.q2)?'ALL PASS':'SOME FAIL'}`);
  console.log(`Q3: ${results.every(r=>r.q3)?'ALL PASS':'SOME FAIL'}`);
  console.log(`Q4: ${results.every(r=>r.q4)?'ALL PASS':'SOME FAIL'}`);
  console.log(`Q8: ${results.every(r=>r.q8)?'ALL PASS (no env creds)':'NOTE: env creds found'}`);
  console.log(`Q11: ${results.every(r=>r.q11)?'ALL PASS':'SOME FAIL'}`);
  console.log(`Blocked in manifest: ${blocked.length} (${Object.keys(blockGroups).map(k=>k+':'+blockGroups[k]).join(', ')})`);
  console.log(`  → replayir_missing = cancelled run, never executed — not a codegen issue`);
})().catch(e => { console.error(String(e)); process.exit(1); });
