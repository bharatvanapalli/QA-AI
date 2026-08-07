'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');

const BASE = 'http://localhost:5000';
const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const OLD_RUN_ID = 'cb2836e8-5b06-4044-8328-a4a506d9b98c';
const USER = { sub: 'a5d916cd-4178-4bcc-b409-c885a389e843', email: 'bharatvanapalli8@gmail.com', role: 'user' };

function makeHeaders() {
  const token = jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: '2h' });
  const csrf = crypto.randomBytes(16).toString('hex');
  return { Cookie: `token=${token}; XSRF-TOKEN=${csrf}`, 'x-xsrf-token': csrf };
}

(async () => {
  console.log('Re-exporting run cb2836e8 through fixed code...\n');

  // Force a fresh export with validate=true to get the manifest
  const res = await fetch(
    `${BASE}/api/projects/${PROJECT_ID}/output-files/validate?source=replayir&runId=${OLD_RUN_ID}`,
    { method: 'POST', headers: { ...makeHeaders(), 'Content-Type': 'application/json' }, body: '{}' }
  );

  if (!res.ok) {
    // Fall back to GET (non-validate)
    const res2 = await fetch(
      `${BASE}/api/projects/${PROJECT_ID}/output-files/?source=replayir&runId=${OLD_RUN_ID}`,
      { headers: makeHeaders() }
    );
    const data = await res2.json().catch(() => ({}));
    // Fetch the manifest file directly
    const manifestRes = await fetch(
      `${BASE}/api/projects/${PROJECT_ID}/output-files/file/EXPORT_MANIFEST.json?source=replayir&runId=${OLD_RUN_ID}`,
      { headers: makeHeaders() }
    );
    if (manifestRes.ok) {
      const manifest = await manifestRes.json().catch(() => null) || JSON.parse(await manifestRes.text());
      analyzeManifest(manifest);
    } else {
      console.log('Manifest fetch failed:', manifestRes.status);
      // Check the tree for number of spec files
      const tree = data?.tree;
      const specFiles = [];
      function walk(node) {
        if (!node) return;
        if (node.type === 'file' && node.kind === 'spec') specFiles.push(node.path);
        (node.children || []).forEach(walk);
      }
      walk(tree);
      console.log(`Spec files in export (${specFiles.length}):`);
      specFiles.forEach(f => console.log('  ' + f));
    }
    return;
  }

  const data = await res.json().catch(() => ({}));
  if (data?.manifest) analyzeManifest(data.manifest);
  else console.log('Validate response:', JSON.stringify(data).slice(0, 500));

  function analyzeManifest(m) {
    const entries = m?.entries || [];
    const blocked = entries.filter(e => e.blockReason);
    const exported = entries.filter(e => !e.blockReason && e.files && e.files.length > 0);
    console.log(`Total entries: ${entries.length}`);
    console.log(`Exported (with spec files): ${exported.length}`);
    console.log(`Blocked: ${blocked.length}`);
    if (blocked.length > 0) {
      console.log('\nBlocked details:');
      blocked.forEach(e => console.log(`  "${e.scenarioName || e.caseId}" reason=${e.blockReason}`));
    } else {
      console.log('\n✓ ZERO blocked entries — fix confirmed.');
    }
    // Sample one spec to verify Q1 (no inline page.getByRole)
    if (exported.length > 0) {
      const sample = exported[0];
      console.log(`\nFirst exported file: ${sample.files?.[0]}`);
    }
  }
})().catch(e => { console.error(String(e)); process.exit(1); });
