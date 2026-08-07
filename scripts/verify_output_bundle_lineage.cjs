'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const replayExport = require('../server/services/codegen/replayExport');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function verifyIntegrity(files, integrity) {
  for (const [file, expectedHash] of Object.entries(integrity.fileHashes || {})) {
    assert.ok(Object.prototype.hasOwnProperty.call(files, file), `missing hashed file: ${file}`);
    assert.equal(sha256(files[file]), expectedHash, `hash mismatch: ${file}`);
  }
}

const files = {
  'tests/example.spec.js': "test('example', async () => {});\n",
  'pages/ExamplePage.js': 'export class ExamplePage {}\n',
};
const manifestEntries = [{
  runResultId: 'run-result-1',
  testCaseId: 'test-case-1',
  files: ['tests/example.spec.js', 'pages/ExamplePage.js'],
  fileHashes: {
    'tests/example.spec.js': 'stale-pre-format-hash',
    'pages/ExamplePage.js': 'stale-pre-format-hash',
  },
}];

const refreshed = replayExport.refreshManifestEntryFileHashes(manifestEntries, files);
assert.equal(refreshed.summary.verified, true);
assert.equal(refreshed.summary.missingFileCount, 0);
assert.equal(
  refreshed.entries[0].fileHashes['tests/example.spec.js'],
  sha256(files['tests/example.spec.js']),
);
assert.equal(
  refreshed.entries[0].fileHashes['pages/ExamplePage.js'],
  sha256(files['pages/ExamplePage.js']),
);
assert.equal(refreshed.entries[0].fileHashSource, 'final-package-bytes');

const receipt = replayExport.buildOutputActivationReceipt({
  adapterId: 'playwright-pom-js',
  adapterVersion: 'playwright-pom-js-1',
  scriptArtifacts: ['tests/example.spec.js'],
  allBlocked: false,
});
files['evidence/output-activation-receipt.json'] = JSON.stringify(receipt, null, 2) + '\n';
const singleIntegrity = replayExport.buildImmutableBundleEvidence(files, {
  adapterId: 'playwright-pom-js',
  astInventory: { entries: [{ astId: 'ast-1' }] },
});
verifyIntegrity(files, singleIntegrity);
assert.equal(
  singleIntegrity.fileHashes['evidence/output-activation-receipt.json'],
  sha256(files['evidence/output-activation-receipt.json']),
);
assert.deepEqual(singleIntegrity.executedCaseAstIds, ['ast-1']);

const child = {
  files: {
    ...files,
    'evidence/bundle-integrity.json': JSON.stringify(singleIntegrity, null, 2) + '\n',
    'EXPORT_MANIFEST.json': JSON.stringify({
      adapterId: 'playwright-pom-js',
      bundleId: singleIntegrity.bundleId,
      executedCaseAst: { enabledTestCount: 1 },
      exportValid: true,
    }, null, 2) + '\n',
  },
  manifest: {
    adapterId: 'playwright-pom-js',
    bundleId: singleIntegrity.bundleId,
    executedCaseAst: { enabledTestCount: 1 },
    exportValid: true,
  },
  adapterId: 'playwright-pom-js',
  bundleId: singleIntegrity.bundleId,
  admitted: [],
  blocked: [],
  findings: [],
  allBlocked: false,
};
const dual = replayExport.combineSiblingPomExports({
  javascript: child,
  typescript: {
    ...child,
    adapterId: 'playwright-pom',
    manifest: { ...child.manifest, adapterId: 'playwright-pom' },
  },
});
verifyIntegrity(dual.files, dual.bundleIntegrity);
assert.equal(dual.manifest.testInventoryParity, true);
assert.equal(dual.manifest.fileHashes['javascript/tests/example.spec.js'], sha256(files['tests/example.spec.js']));
assert.equal(dual.manifest.fileHashes['typescript/tests/example.spec.js'], sha256(files['tests/example.spec.js']));

process.stdout.write(JSON.stringify({
  status: 'PASS',
  sourceHashParity: refreshed.summary,
  singleBundleId: singleIntegrity.bundleId,
  singleFileCount: singleIntegrity.fileCount,
  dualBundleId: dual.bundleId,
  dualFileCount: dual.bundleIntegrity.fileCount,
}, null, 2) + '\n');
