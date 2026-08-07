'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const playwrightPomJs = require('../server/services/codegen/adapters/playwrightPomJs');
const playwrightPom = require('../server/services/codegen/adapters/playwrightPom');
const replayExport = require('../server/services/codegen/replayExport');

const TYPESCRIPT = process.argv.includes('--typescript');
const adapterId = TYPESCRIPT ? 'playwright-pom' : 'playwright-pom-js';
const extension = TYPESCRIPT ? 'ts' : 'js';
const renderer = TYPESCRIPT ? playwrightPom : playwrightPomJs;

function verifiedLocator(expression, { pageUrl, role, name, editable = false }) {
  const backendNodeId = `controlled:${role}:${name}`;
  const identity = {
    scheme: 'qaai-dom-node-v1',
    documentId: `controlled-document:${pageUrl}`,
    nodeId: backendNodeId,
    connected: true,
  };
  return {
    kind: 'playwright',
    strategy: 'role',
    role,
    elementLabel: name,
    expression,
    frameworkExpressions: { playwright: expression },
    verified: true,
    verificationSource: 'verified_dom_inspection',
    evidenceSource: 'verified_dom_inspection',
    pageUrl,
    captureBinding: { kind: 'mcp_bound_ref', ref: `controlled:${backendNodeId}` },
    targetFacts: { role, accessibleName: name, backendNodeId },
    context: { captureBinding: { kind: 'mcp_bound_ref', ref: `controlled:${backendNodeId}` } },
    proof: {
      verified: true,
      count: 1,
      sameElement: true,
      visible: true,
      enabled: true,
      editable,
      source: 'verified_dom_inspection',
      actionTimeResolved: true,
      actedNodeBound: true,
      resolutionMode: 'bound_mcp_ref',
      identityVerified: true,
      expectedBackendNodeId: backendNodeId,
      resolvedBackendNodeId: backendNodeId,
      targetIdentity: identity,
      matchedIdentity: { ...identity },
    },
    domAtlas: {
      schemaVersion: 'qaai-dom-atlas-v1',
      url: pageUrl,
      verifiedActions: [
        {
          expression,
          source: 'verified_dom_inspection',
          count: 1,
          sameElement: true,
          targetIdentity: identity,
          matchedIdentity: { ...identity },
          backendNodeId,
        },
      ],
    },
  };
}

function resolveStep({
  as,
  expression,
  pageUrl,
  role,
  name,
  accessibleName = name,
  contractStepId,
  editable = false,
}) {
  return {
    op: 'resolve',
    as,
    pageUrl,
    elementLabel: name,
    authoredPageName: 'Profile editor',
    contractStepId,
    authored: true,
    actionLocator: verifiedLocator(expression, { pageUrl, role, name: accessibleName, editable }),
  };
}

function controlledCase(pageUrl) {
  const declaredSteps = [
    { id: 'open-profile', action: 'navigate', url: pageUrl, pageName: 'Profile editor' },
    {
      id: 'enter-display-name',
      action: 'fill',
      target: 'Display name',
      value: 'Ada Lovelace',
      pageName: 'Profile editor',
    },
    { id: 'save-profile', action: 'click', target: 'Save', pageName: 'Profile editor' },
  ];
  const declaredAssertions = [
    {
      id: 'saved-message',
      channel: 'UI_TEXT',
      target: 'saveStatus',
      expected: 'Saved Ada Lovelace',
      criticality: 'must',
    },
  ];
  return {
    runResultId: 'controlled-generated-project-run',
    testCaseId: 'controlled-profile-save',
    caseName: 'Save a profile with verified locators',
    declaredSteps,
    declaredAssertions,
    ir: {
      version: 1,
      caseId: 'controlled-profile-save',
      title: 'Save a profile with verified locators',
      authProfile: { id: 'default', strategy: 'none', disposition: 'bypass_fixture' },
      steps: [
        {
          op: 'act',
          action: 'navigate',
          url: pageUrl,
          authored: true,
          contractStepId: 'open-profile',
          authoredPageName: 'Profile editor',
        },
        resolveStep({
          as: 'displayNameInput',
          expression: 'getByRole("textbox", { name: "Display name", exact: true })',
          pageUrl,
          role: 'textbox',
          name: 'Display name',
          contractStepId: 'enter-display-name',
          editable: true,
        }),
        {
          op: 'act',
          action: 'fill',
          target: 'displayNameInput',
          targetLabel: 'Display name',
          rawValue: 'Ada Lovelace',
          authored: true,
          contractStepId: 'enter-display-name',
        },
        resolveStep({
          as: 'saveButton',
          expression: 'getByRole("button", { name: "Save", exact: true })',
          pageUrl,
          role: 'button',
          name: 'Save',
          contractStepId: 'save-profile',
        }),
        {
          op: 'act',
          action: 'click',
          target: 'saveButton',
          targetLabel: 'Save',
          authored: true,
          contractStepId: 'save-profile',
        },
        resolveStep({
          as: 'saveStatus',
          expression: 'getByRole("status", { name: "Save status", exact: true })',
          pageUrl,
          role: 'status',
          name: 'Save status',
          contractStepId: 'saved-message',
        }),
        {
          op: 'assert',
          id: 'saved-message',
          channel: 'UI_TEXT',
          target: 'saveStatus',
          expected: 'Saved Ada Lovelace',
          criticality: 'must',
          authored: true,
          contractStepId: 'saved-message',
        },
      ],
      verdict: {
        status: 'pass',
        perAssertionOutcomes: [{ assertionId: 'saved-message', outcome: 'matched' }],
      },
    },
  };
}

function fixtureHtml() {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Profile editor</title></head>
  <body>
    <main>
      <h1>Profile editor</h1>
      <label for="display-name">Display name</label>
      <input id="display-name" type="text">
      <button id="save" type="button">Save</button>
      <p role="status" aria-label="Save status" aria-live="polite"></p>
    </main>
    <script>
      document.querySelector('#save').addEventListener('click', () => {
        document.querySelector('[role="status"]').textContent = 'Saved ' + document.querySelector('#display-name').value;
      });
    </script>
  </body>
</html>`;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const executable = windows ? process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe' : command;
    const executableArgs = windows ? ['/d', '/s', '/c', [command, ...args].join(' ')] : args;
    const child = spawn(executable, executableArgs, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      windowsHide: true,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ code, stdout, stderr });
      else
        reject(
          new Error(`${command} ${args.join(' ')} failed with exit ${code}\n${stdout}\n${stderr}`),
        );
    });
  });
}

function writePackage(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const normalized = String(relativePath).replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('../') || path.isAbsolute(normalized))
      throw new Error(`Unsafe generated path: ${relativePath}`);
    const destination = path.resolve(root, normalized);
    if (!destination.startsWith(path.resolve(root) + path.sep))
      throw new Error(`Generated path escaped workspace: ${relativePath}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(
      destination,
      Buffer.isBuffer(content) ? content : String(content),
      Buffer.isBuffer(content) ? undefined : 'utf8',
    );
  }
}

async function main() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(fixtureHtml());
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const targetUrl = `http://127.0.0.1:${port}/profile`;
  let workspace = null;
  try {
    process.stdout.write('STAGE generate-package\n');
    const generated = renderer.emitJourneySpec([controlledCase(targetUrl)], {
      scenarioName: 'Controlled generated project',
      ...(TYPESCRIPT ? { lang: 'ts' } : { moduleFormat: 'esm' }),
    });
    const userSources = [
      generated.content,
      ...Object.entries(generated.extraFiles || {})
        .filter(([file]) => /^(?:locators|pages|tests)\//.test(file) && new RegExp(`\\.${extension}$`).test(file))
        .map(([, source]) => source),
    ].join('\n');
    if (/QAAI_GUESSED_LOCATOR/.test(userSources)) {
      const guessedEntries = Object.entries(generated.extraFiles || {})
        .filter(([, source]) => /QAAI_GUESSED_LOCATOR/.test(String(source)))
        .map(([file, source]) => {
          const lines = String(source).split(/\r?\n/);
          const indexes = lines
            .map((line, index) => (line.includes('QAAI_GUESSED_LOCATOR') ? index : -1))
            .filter((index) => index >= 0);
          return `${file}:\n${indexes.map((index) => lines.slice(index, index + 4).join('\n')).join('\n')}`;
        });
      throw new Error(
        `Controlled verified fixture emitted a guessed locator.\n${guessedEntries.join('\n')}`,
      );
    }
    if (/test\.info\(\)\.annotations|qaai-runtime-evidence|STATUS: DRAFT/.test(userSources)) {
      const telemetryEntries = [
        ['<spec>', generated.content],
        ...Object.entries(generated.extraFiles || {}).filter(([file]) =>
          /^(?:locators|pages|tests)\//.test(file),
        ),
      ]
        .map(([file, source]) => {
          const matches = String(source)
            .split(/\r?\n/)
            .filter((line) =>
              /test\.info\(\)\.annotations|qaai-runtime-evidence|STATUS: DRAFT/.test(line),
            );
          return matches.length ? `${file}:\n${matches.join('\n')}` : null;
        })
        .filter(Boolean);
      throw new Error(
        `Controlled generated project leaked telemetry or draft metadata.\n${telemetryEntries.join('\n')}`,
      );
    }

    const files = replayExport.assemblePackage({
      adapterId,
      admitted: [
        {
          filePath: `tests/controlled/save-profile.spec.${extension}`,
          content: generated.content,
          extraFiles: generated.extraFiles,
        },
      ],
      envVars: ['QAAI_TARGET_URL'],
      targetUrl,
    });
    workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), `qaai-pom-${TYPESCRIPT ? 'ts' : 'js'}-execution-`),
    );
    writePackage(workspace, files);
    process.stdout.write(`STAGE package-written ${workspace}\n`);
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    process.stdout.write(`STAGE ${TYPESCRIPT ? 'npm-install' : 'npm-ci'}\n`);
    const install = await run(npmCommand, [TYPESCRIPT ? 'install' : 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: workspace,
    });
    let typecheck = null;
    if (TYPESCRIPT) {
      process.stdout.write('STAGE typescript-typecheck\n');
      typecheck = await run(npmCommand, ['run', 'typecheck'], { cwd: workspace });
    }
    process.stdout.write('STAGE playwright-browser-install\n');
    await run(npxCommand, ['playwright', 'install', 'chromium'], { cwd: workspace });
    process.stdout.write('STAGE playwright-collection\n');
    const executionEnv = { QAAI_TARGET_URL: targetUrl };
    const collection = await run(npxCommand, ['playwright', 'test', '--list'], {
      cwd: workspace,
      env: executionEnv,
    });
    process.stdout.write('STAGE playwright-execution\n');
    const execution = await run(npxCommand, ['playwright', 'test', '--reporter=line'], {
      cwd: workspace,
      env: executionEnv,
    });
    process.stdout.write(
      JSON.stringify(
        {
          status: 'PASS',
          adapterId,
          workspace,
          generatedFileCount: Object.keys(files).length,
          install: install.stdout.trim(),
          ...(typecheck ? { typecheck: typecheck.stdout.trim() } : {}),
          collection: collection.stdout.trim(),
          execution: execution.stdout.trim(),
        },
        null,
        2,
      ) + '\n',
    );
  } catch (error) {
    if (workspace) process.stderr.write(`Generated project retained for diagnosis: ${workspace}\n`);
    throw error;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exitCode = 1;
});
