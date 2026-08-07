'use strict';

/**
 * Script to execute Playwright test suites in generated packages
 * and persist EXPORT_VERIFICATION.json, VERIFICATION_REPORT.md, and .last-run.json
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function runAndPersist(packageDir, commands) {
  console.log(`\n=================== PERSISTING EVIDENCE: ${packageDir} ===================`);
  const results = [];
  let allPassed = true;

  for (const cmdObj of commands) {
    const timestamp = new Date().toISOString();
    console.log(`Running: ${cmdObj.cmd}`);
    let rawOutput = '';
    let exitCode = 0;
    try {
      rawOutput = execSync(cmdObj.cmd, { cwd: packageDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      exitCode = err.status || 1;
      rawOutput = (err.stdout || '') + '\n' + (err.stderr || '');
      allPassed = false;
    }
    console.log(`Exit Code: ${exitCode}`);
    results.push({
      command: cmdObj.cmd,
      name: cmdObj.name,
      workingDirectory: packageDir,
      exitCode,
      rawOutput: rawOutput.trim(),
      timestamp
    });
  }

  const testResultsDir = path.join(packageDir, 'test-results');
  if (!fs.existsSync(testResultsDir)) {
    fs.mkdirSync(testResultsDir, { recursive: true });
  }

  // Write .last-run.json
  const lastRunContent = JSON.stringify({
    status: allPassed ? 'passed' : 'failed',
    timestamp: new Date().toISOString(),
    results
  }, null, 2);
  fs.writeFileSync(path.join(testResultsDir, '.last-run.json'), lastRunContent, 'utf8');

  // Write EXPORT_VERIFICATION.json
  const exportVerificationContent = JSON.stringify({
    verifiedAt: new Date().toISOString(),
    status: allPassed ? 'passed' : 'failed',
    packageDirectory: packageDir,
    commands: results
  }, null, 2);
  fs.writeFileSync(path.join(packageDir, 'EXPORT_VERIFICATION.json'), exportVerificationContent, 'utf8');

  // Write VERIFICATION_REPORT.md
  const reportLines = [
    `# Playwright Package Verification Report`,
    ``,
    `- **Package Directory**: \`${packageDir}\``,
    `- **Verified At**: \`${new Date().toISOString()}\``,
    `- **Status**: **${allPassed ? 'PASSED' : 'FAILED'}**`,
    ``,
    `## Execution Log`,
    ``
  ];

  for (const res of results) {
    reportLines.push(`### ${res.name}`);
    reportLines.push(`- **Command**: \`${res.command}\``);
    reportLines.push(`- **Exit Code**: \`${res.exitCode}\``);
    reportLines.push(`- **Timestamp**: \`${res.timestamp}\``);
    reportLines.push(``);
    reportLines.push(`\`\`\`text`);
    reportLines.push(res.rawOutput);
    reportLines.push(`\`\`\``);
    reportLines.push(``);
  }

  fs.writeFileSync(path.join(packageDir, 'VERIFICATION_REPORT.md'), reportLines.join('\n'), 'utf8');
  console.log(`✓ Persisted verification evidence files in ${packageDir}`);
  return allPassed;
}

function main() {
  const root = 'C:/Users/2461898/Downloads/qaai_fixed/qaai_fixed/qaai_fixed';
  const tsDir = path.join(root, 'playwright-runnable/pom-ts');
  const jsDir = path.join(root, 'playwright-runnable/pom-js');
  const nodeCli = 'node node_modules/@playwright/test/cli.js';

  const tsCmds = [
    { name: 'TS Standalone Order Spec', cmd: `${nodeCli} test tests/create-an-order-and-validate-complex-form-controls.spec.ts --reporter=line` },
    { name: 'TS Full Test Suite', cmd: `${nodeCli} test --reporter=line` }
  ];

  const jsCmds = [
    { name: 'JS Standalone Order Spec', cmd: `${nodeCli} test tests/create-an-order-and-validate-complex-form-controls.spec.js --reporter=line` },
    { name: 'JS Full Test Suite', cmd: `${nodeCli} test --reporter=line` }
  ];

  const tsOk = runAndPersist(tsDir, tsCmds);
  const jsOk = runAndPersist(jsDir, jsCmds);

  if (!tsOk || !jsOk) {
    console.error('Verification failed for one or more packages.');
    process.exit(1);
  }
  console.log('\n✓ ALL REPO PACKAGES VERIFIED AND EVIDENCE PERSISTED SUCCESSFULLY!');
}

if (require.main === module) {
  main();
}

module.exports = { runAndPersist };
