'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function runAndSave(pkgDir, specName) {
  const ts = new Date().toISOString();
  console.log(`Running tests for ${pkgDir}...`);
  const binPath = path.resolve(pkgDir, 'node_modules/.bin/playwright');
  const specCmd = `"${binPath}" test tests/${specName} --workers=1 --reporter=line`;
  console.log(`Command 1: ${specCmd}`);
  let out1 = '';
  let code1 = 0;
  try {
    out1 = execSync(specCmd, { cwd: pkgDir, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    code1 = err.status || 1;
    out1 = (err.stdout || '') + '\n' + (err.stderr || '');
  }

  const fullCmd = `"${binPath}" test --workers=1 --reporter=line`;
  console.log(`Command 2: ${fullCmd}`);
  let out2 = '';
  let code2 = 0;
  try {
    out2 = execSync(fullCmd, { cwd: pkgDir, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    code2 = err.status || 1;
    out2 = (err.stdout || '') + '\n' + (err.stderr || '');
  }

  const allPassed = code1 === 0 && code2 === 0;

  const commands = [
    {
      name: 'Standalone Order Spec',
      command: specCmd,
      workingDirectory: pkgDir,
      exitCode: code1,
      rawOutput: out1.trim(),
      timestamp: ts
    },
    {
      name: 'Full Test Suite',
      command: fullCmd,
      workingDirectory: pkgDir,
      exitCode: code2,
      rawOutput: out2.trim(),
      timestamp: ts
    }
  ];

  const exportVerPath = path.resolve(pkgDir, 'EXPORT_VERIFICATION.json');
  const testResultsDir = path.resolve(pkgDir, 'test-results');
  const lastRunPath = path.resolve(testResultsDir, '.last-run.json');

  if (!fs.existsSync(testResultsDir)) {
    fs.mkdirSync(testResultsDir, { recursive: true });
  }

  const payload = JSON.stringify({
    verifiedAt: ts,
    status: allPassed ? 'passed' : 'failed',
    packageDirectory: pkgDir,
    commands
  }, null, 2);

  const lastRunPayload = JSON.stringify({
    status: allPassed ? 'passed' : 'failed',
    timestamp: ts,
    results: commands.map(c => ({ name: c.name, command: c.command, exitCode: c.exitCode, passed: c.exitCode === 0 }))
  }, null, 2);

  fs.writeFileSync(exportVerPath, payload, 'utf8');
  fs.writeFileSync(lastRunPath, lastRunPayload, 'utf8');

  console.log(`Wrote file: ${exportVerPath}`);
  console.log(`Read back status from file: ${JSON.parse(fs.readFileSync(exportVerPath, 'utf8')).status}`);
  console.log(`✓ Saved verified status (${allPassed ? 'PASSED' : 'FAILED'}) files in ${pkgDir}`);
  return allPassed;
}

function main() {
  const root = 'C:/Users/2461898/Downloads/qaai_fixed/qaai_fixed/qaai_fixed';
  const tsOk = runAndSave(path.resolve(root, 'playwright-runnable/pom-ts'), 'create-an-order-and-validate-complex-form-controls.spec.ts');
  const jsOk = runAndSave(path.resolve(root, 'playwright-runnable/pom-js'), 'create-an-order-and-validate-complex-form-controls.spec.js');

  if (!tsOk || !jsOk) {
    console.error('Verification failed for one or more packages.');
    process.exit(1);
  }
  console.log('\n✓ ALL REPO PACKAGES VERIFIED AND EVIDENCE PERSISTED SUCCESSFULLY!');
}

if (require.main === module) {
  main();
}

module.exports = { runAndSave };
