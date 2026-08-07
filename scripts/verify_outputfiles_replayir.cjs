#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const route = fs.readFileSync(path.join(root, 'server/routes/outputFiles.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'src/pages/OutputFiles.jsx'), 'utf8');

const checks = [];
function check(name, ok) {
  checks.push({ name, ok: !!ok });
}

check('route defines ReplayIR source constant', route.includes("const REPLAYIR_SOURCE = 'replayir'"));
check('route can build virtual ReplayIR workspace', route.includes('async function buildReplayWorkspace'));
check('route maps selenium-java project framework to selenium-pom', route.includes("'selenium-java': 'selenium-pom'"));
check('route maps selenium-bdd project framework to selenium-bdd-reference', route.includes("'selenium-bdd': 'selenium-bdd-reference'"));
check('route normalizes explicit framework query aliases', route.includes('PROJECT_REPLAY_FRAMEWORKS[queryVal] || queryVal'));
check('route exposes ReplayIR tree preview', route.includes('source: REPLAYIR_SOURCE') && route.includes('treeFromFiles(workspace.files'));
check('route exposes ReplayIR file preview', route.includes("router.get('/file/*'") && route.includes('Object.prototype.hasOwnProperty.call(workspace.files'));
check('route exposes ReplayIR files.json', route.includes("router.get('/files.json'") && route.includes("action: 'output.files-json.replayir'"));
check('route exposes ReplayIR Open in VS Code', route.includes("action: source === REPLAYIR_SOURCE ? 'output.open-in-vscode.replayir'"));
check('route lists ReplayIR-bearing runs', route.includes('results: { some: { replayIrJson: { not: null } } }'));
check('route still blocks invalid ReplayIR exports', route.includes('replayRefusalPayload') && route.includes("code: 'EXPORT_INVALID'"));

check('UI defaults to ReplayIR source', ui.includes("const OUTPUT_SOURCE = 'replayir'"));
check('UI defaults to Playwright reference adapter', ui.includes("const OUTPUT_FRAMEWORK = 'playwright-reference'"));
check('UI maps selenium-java to selenium-pom', ui.includes("if (f === 'selenium-java') return 'selenium-pom'"));
check('UI maps selenium-bdd to selenium-bdd-reference', ui.includes("if (f === 'selenium-bdd') return 'selenium-bdd-reference'"));
check('UI shows selected framework package summary', ui.includes('function FrameworkSummary') && ui.includes('meta.runCommand'));
check('UI uses shared output query helper', ui.includes('function outputQuery'));
check('UI loads ReplayIR tree', ui.includes('/output-files${qs}'));
check('UI loads ReplayIR run list', ui.includes('/output-files/runs${outputQuery(null, activeFramework)}'));
check('UI previews ReplayIR files', ui.includes('/output-files/file/${encoded}${qs}'));
check('UI downloads ReplayIR zip', ui.includes('/output-files/download.zip${qs}'));
check('UI saves ReplayIR files.json', ui.includes('/output-files/files.json${qs}'));
check('UI opens ReplayIR package in VS Code', ui.includes('/output-files/open-in-vscode${qs}'));
check('UI visibly labels ready package', ui.includes('ReplayIR ready'));
check('UI labels blocked file previews as preparation-only', ui.includes('Preview only while package preparation completes'));
check('UI uses output preparation copy', ui.includes('Output package is still preparing') && !ui.includes('did not pass export certification') && !ui.includes('locator quality issue was detected'));

const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}`);
}
if (failed.length) {
  console.error(`\n${failed.length} Output Files ReplayIR guard check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS ${checks.length}/${checks.length} Output Files ReplayIR guard checks`);
