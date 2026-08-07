'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function executeAndPersist(pkgDir, standaloneSpec) {
  console.log(`\n=================== VERIFYING PACKAGE: ${pkgDir} ===================`);
  const ts = new Date().toISOString();

  const cmd1 = `node node_modules/@playwright/test/cli.js test tests/${standaloneSpec} --reporter=line`;
  console.log(`Executing Command 1: ${cmd1}`);
  let out1 = '';
  let code1 = 0;
  try {
    out1 = execSync(cmd1, { cwd: pkgDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    console.log('Command 1 Passed (exitCode: 0)');
  } catch (err) {
    code1 = err.status || 1;
    out1 = (err.stdout || '') + '\n' + (err.stderr || '');
    console.log(`Command 1 Failed (exitCode: ${code1})`);
  }

  const cmd2 = `node node_modules/@playwright/test/cli.js test --reporter=line`;
  console.log(`Executing Command 2: ${cmd2}`);
  let out2 = '';
  let code2 = 0;
  try {
    out2 = execSync(cmd2, { cwd: pkgDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    console.log('Command 2 Passed (exitCode: 0)');
  } catch (err) {
    code2 = err.status || 1;
    out2 = (err.stdout || '') + '\n' + (err.stderr || '');
    console.log(`Command 2 Failed (exitCode: ${code2})`);
  }

  const allPassed = (code1 === 0 && code2 === 0);
  const statusStr = allPassed ? 'passed' : 'failed';

  const commands = [
    {
      name: 'Standalone Order Spec',
      command: cmd1,
      workingDirectory: pkgDir,
      exitCode: code1,
      rawOutput: out1.trim(),
      timestamp: ts
    },
    {
      name: 'Full Test Suite',
      command: cmd2,
      workingDirectory: pkgDir,
      exitCode: code2,
      rawOutput: out2.trim(),
      timestamp: ts
    }
  ];

  const exportVerPath = path.resolve(pkgDir, 'EXPORT_VERIFICATION.json');
  const testResultsDir = path.resolve(pkgDir, 'test-results');
  const lastRunPath = path.resolve(testResultsDir, '.last-run.json');
  const reportPath = path.resolve(pkgDir, 'VERIFICATION_REPORT.md');

  if (!fs.existsSync(testResultsDir)) {
    fs.mkdirSync(testResultsDir, { recursive: true });
  }

  const exportVerData = {
    verifiedAt: ts,
    status: statusStr,
    packageDirectory: pkgDir,
    commands
  };

  const lastRunData = {
    status: statusStr,
    timestamp: ts,
    results: commands.map(c => ({ name: c.name, command: c.command, exitCode: c.exitCode, passed: c.exitCode === 0 }))
  };

  const reportMd = [
    `# Playwright Package Verification Report`,
    ``,
    `- **Status**: ${statusStr.toUpperCase()}`,
    `- **Verified At**: ${ts}`,
    `- **Directory**: \`${pkgDir}\``,
    ``,
    `## Executed Commands`,
    ...commands.map(c => `### ${c.name}\n- Command: \`${c.command}\`\n- Exit Code: ${c.exitCode}\n- Status: ${c.exitCode === 0 ? 'PASSED' : 'FAILED'}\n`),
  ].join('\n');

  fs.writeFileSync(exportVerPath, JSON.stringify(exportVerData, null, 2), 'utf8');
  fs.writeFileSync(lastRunPath, JSON.stringify(lastRunData, null, 2), 'utf8');
  fs.writeFileSync(reportPath, reportMd, 'utf8');

  console.log(`✓ Updated ${exportVerPath}`);
  console.log(`✓ Updated ${lastRunPath}`);
  console.log(`✓ Updated ${reportPath}`);
  console.log(`Status recorded: ${statusStr.toUpperCase()}`);

  return allPassed;
}

const root = 'C:/Users/2461898/Downloads/qaai_fixed/qaai_fixed/qaai_fixed';
const tsOk = executeAndPersist(path.resolve(root, 'playwright-runnable/pom-ts'), 'create-an-order-and-validate-complex-form-controls.spec.ts');
const jsOk = executeAndPersist(path.resolve(root, 'playwright-runnable/pom-js'), 'create-an-order-and-validate-complex-form-controls.spec.js');

if (!tsOk || !jsOk) {
  console.error('\n❌ VERIFICATION FAILED: One or more commands failed.');
  process.exit(1);
} else {
  console.log('\n✅ ALL REPO PACKAGES PASSED & PERSISTED WITH STATUS PASSED!');
}
