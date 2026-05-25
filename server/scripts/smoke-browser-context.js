'use strict';

/**
 * E10.5 smoke — verifies mcpContextConfig builds the right CLI args and
 * generates a syntactically-valid init-script when project context fields
 * are populated. Does NOT spawn a real MCP subprocess; that needs
 * Chromium and is covered by manual smoke against the-internet.herokuapp.com.
 *
 * Run with: node server/scripts/smoke-browser-context.js
 */

const fs = require('fs');
const path = require('path');
const { buildContextArgs, cleanupContextArtifacts } = require('../services/mcpContextConfig');

let passed = 0;
let failed = 0;
const check = (cond, label) => {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else      { console.log(`  FAIL  ${label}`); failed++; }
};

// Scenario 1 — empty project, only the always-on dialog handler in init-script.
{
  console.log('--- empty project (defaults only) ---');
  const session = { id: 'smoketest-empty' };
  const { cliArgs, initScriptPath, downloadsDir } = buildContextArgs({}, session);
  check(cliArgs.includes('--output-dir'), 'output-dir always set');
  check(!!downloadsDir && fs.existsSync(downloadsDir), 'downloads dir created');
  check(!!initScriptPath, 'init-script written (dialog handler default ON)');
  if (initScriptPath) {
    const body = fs.readFileSync(initScriptPath, 'utf8');
    check(body.includes('window.alert'), 'init-script contains dialog shim');
  }
  cleanupContextArtifacts({ initScriptPath, downloadsDir, keepDownloads: false });
}

// Scenario 2 — full config: device, locale, color-scheme, geo, perms, headers, basic auth, proxy.
{
  console.log('--- full config ---');
  const session = { id: 'smoketest-full' };
  const project = {
    contextDevice: 'iPhone 15',
    contextLocale: 'fr-FR',
    contextUserAgent: 'QAAITestUA/1.0',
    contextColorScheme: 'dark',
    contextPermissions: JSON.stringify(['geolocation', 'clipboard-read']),
    contextGeolocation: JSON.stringify({ latitude: 48.8566, longitude: 2.3522, accuracy: 25 }),
    contextHttpCredentials: JSON.stringify({ username: 'admin', password: 'admin' }),
    contextExtraHeaders: JSON.stringify({ 'x-tenant-id': 'acme' }),
    contextIgnoreHttpsErrors: true,
    contextProxyServer: 'http://proxy.example:3128',
    contextProxyBypass: '.internal,.local',
    autoAcceptDialogs: true,
  };
  const { cliArgs, initScriptPath, downloadsDir } = buildContextArgs(project, session);

  check(cliArgs.includes('--device') && cliArgs[cliArgs.indexOf('--device') + 1] === 'iPhone 15', 'device flag emitted');
  check(cliArgs.includes('--user-agent'), 'user-agent flag emitted');
  check(cliArgs.includes('--grant-permissions'), 'grant-permissions flag emitted');
  check(cliArgs.includes('--ignore-https-errors'), 'ignore-https-errors flag emitted');
  check(cliArgs.includes('--proxy-server'), 'proxy-server flag emitted');
  check(cliArgs.includes('--proxy-bypass'), 'proxy-bypass flag emitted');
  check(cliArgs.includes('--init-script'), 'init-script flag emitted');

  // The CLI takes "--grant-permissions geolocation clipboard-read" as space-separated tokens.
  const grantIdx = cliArgs.indexOf('--grant-permissions');
  check(cliArgs[grantIdx + 1] === 'geolocation' && cliArgs[grantIdx + 2] === 'clipboard-read',
    'grant-permissions tokens are space-separated');

  if (initScriptPath) {
    const body = fs.readFileSync(initScriptPath, 'utf8');
    check(body.includes('navigator.geolocation'), 'init-script overrides geolocation');
    check(body.includes('48.8566'),                'init-script embeds latitude');
    check(body.includes('matchMedia'),             'init-script patches matchMedia');
    check(body.includes('"dark"'),                 'init-script embeds dark scheme');
    check(body.match(/navigator,\s*'language'/),   'init-script overrides locale via defineProperty');
    check(body.includes('"fr-FR"'),                'init-script embeds fr-FR');
    check(body.includes('Basic '),                 'init-script injects Basic auth');
    check(body.includes('x-tenant-id'),            'init-script injects extra header');
    check(body.includes('window.alert'),           'init-script keeps dialog shim');

    // Round-trip parse — the body must be syntactically valid JS or the
    // MCP subprocess will throw at first page load.
    try { new Function(body); check(true, 'init-script is syntactically valid JS'); }
    catch (e)                  { check(false, `init-script parse error: ${e.message}`); }
  }
  cleanupContextArtifacts({ initScriptPath, downloadsDir, keepDownloads: false });
}

// Scenario 3 — autoAcceptDialogs false: dialog shim should NOT be in the script.
{
  console.log('--- dialogs explicit-handle mode ---');
  const session = { id: 'smoketest-dialogs-off' };
  const project = { autoAcceptDialogs: false, contextLocale: 'en-US' };
  const { cliArgs, initScriptPath, downloadsDir } = buildContextArgs(project, session);
  if (initScriptPath) {
    const body = fs.readFileSync(initScriptPath, 'utf8');
    check(!body.includes('window.alert'), 'dialog shim suppressed when autoAcceptDialogs=false');
    check(body.includes('"en-US"'), 'locale shim still present');
  } else {
    check(false, 'expected init-script to be written (locale shim present)');
  }
  cleanupContextArtifacts({ initScriptPath, downloadsDir, keepDownloads: false });
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
