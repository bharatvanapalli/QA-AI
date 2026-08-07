'use strict';

const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const parity = require('./codegen/executionParity');
const featureFlags = require('./generationFeatureFlags');
const generatedOutputQuality = require('./generatedOutputQuality');
const roundTripParity = require('./scriptRoundTripParity');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_TMP_ROOT = os.tmpdir();
const DEFAULT_ARTIFACT_ROOT = path.join(REPO_ROOT, 'playwright', 'script-validation');
const SCRIPT_VALIDATION_SCHEMA = 'qaai-script-validation-job/1';
const SCRIPT_FAILURE_SCHEMA = 'qaai-script-failure/1';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const PLAYWRIGHT_FRAMEWORKS = new Set([
  'playwright-pom',
  'playwright-pom-js',
  'playwright-reference',
  'playwright-reference-js',
  'playwright-flat',
  'playwright-js',
  'playwright-bdd',
  'cucumber-playwright',
  'replayir-bdd',
]);

const BDD_FRAMEWORKS = new Set(['playwright-bdd', 'cucumber-playwright', 'replayir-bdd']);
const ARTIFACT_DIRS = [
  'script-validation-results',
  'test-results',
  'playwright-report',
  'blob-report',
];
const ARTIFACT_FILE_RE = /\.(json|txt|log|zip|png|jpg|jpeg|webm|mp4|html|xml)$/i;
const DENY_ENV_RE =
  /^(?:DATABASE_URL|DIRECT_URL|SHADOW_DATABASE_URL|JWT_|SESSION_|COOKIE_|QAAI_|PRISMA_|OPENAI_|ANTHROPIC_|GEMINI_|GOOGLE_|AZURE_|AWS_|GCP_|SECRET_|TOKEN$|.*_TOKEN$|.*_SECRET$|.*_KEY$)/i;
const SAFE_BASE_ENV_KEYS = new Set([
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'ComSpec',
  'PLAYWRIGHT_BROWSERS_PATH',
]);

function locatorOnlyRoundTripFinding(finding) {
  if (!finding || typeof finding !== 'object') return false;
  const rule = String(finding.rule || '').toLowerCase();
  if (/^round_trip_locator_.*guessed$/.test(rule) || rule === 'round_trip_locator_evidence_guessed')
    return true;
  if (rule === 'round_trip_evidence_incomplete') {
    const ledger = finding.ledger || {};
    const missingLocator = Number(ledger.missingLocatorCount || 0);
    const nonLocatorMissing = [
      'missingActionEvidenceCount',
      'missingAssertionCount',
      'parseFailedAssertionCount',
      'missingNavigationEvidenceCount',
      'missingAuthSetupCount',
    ].reduce((sum, key) => sum + Number(ledger[key] || 0), 0);
    return missingLocator > 0 && nonLocatorMissing === 0;
  }
  if (rule === 'round_trip_replayir_incomplete') {
    const gaps = Array.isArray(finding.gaps) ? finding.gaps : [];
    return (
      gaps.length > 0 &&
      gaps.every((gap) =>
        /locator|target_resolution|excavation/i.test(
          String((gap && (gap.code || gap.type || gap.rule)) || ''),
        ),
      )
    );
  }
  return false;
}

function safeRelPath(rel) {
  const normalized = String(rel || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  const clean = path.posix.normalize(normalized);
  if (
    !clean ||
    clean === '.' ||
    clean.startsWith('../') ||
    clean === '..' ||
    path.isAbsolute(clean)
  )
    return null;
  if (clean.split('/').some((part) => part === '..' || part === 'node_modules' || part === '.git'))
    return null;
  return clean;
}

function safeId(value, fallback = 'bundle') {
  const raw = String(value || fallback).trim();
  return (
    raw
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 96) || fallback
  );
}

function hashFiles(files = {}) {
  const h = crypto.createHash('sha256');
  for (const key of Object.keys(files).sort()) {
    const content = files[key];
    if (Buffer.isBuffer(content)) {
      h.update(key).update('\0').update(content).update('\0');
    } else {
      h.update(key)
        .update('\0')
        .update(String(content || ''))
        .update('\0');
    }
  }
  return h.digest('hex');
}

function readPackageVersion(name, fallback) {
  try {
    const pkgPath = require.resolve(`${name}/package.json`, {
      paths: [REPO_ROOT, path.join(REPO_ROOT, 'server')],
    });
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version || fallback;
  } catch (_) {
    return fallback;
  }
}

function exactDependencyVersion(name, fallback) {
  const version = readPackageVersion(name, fallback);
  return String(version || fallback).replace(/^[~^]/, '');
}

function lockedRootDependencyVersions(files = {}) {
  const lockSource = files['package-lock.json'] || files['npm-shrinkwrap.json'];
  if (!lockSource) return {};
  try {
    const lock = JSON.parse(String(lockSource));
    const root = lock && lock.packages && lock.packages[''];
    if (!root || typeof root !== 'object') return {};
    return {
      ...(root.dependencies || {}),
      ...(root.devDependencies || {}),
      ...(root.optionalDependencies || {}),
    };
  } catch (_) {
    return {};
  }
}

function qaaiEnvContract(files = {}) {
  const names = new Set();
  const add = (value) => {
    const name = String(value || '').trim();
    if (/^QAAI_[A-Z0-9_]+$/.test(name)) names.add(name);
  };
  for (const [rel, content] of Object.entries(files || {})) {
    if (typeof content !== 'string') continue;
    const text = String(content);
    let match;
    const direct = /\bprocess\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\])/g;
    while ((match = direct.exec(text))) add(match[1] || match[2]);
    const reader = /\b(?:readEnv|getEnv|requireEnv)\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g;
    while ((match = reader.exec(text))) add(match[1]);
    if (/(?:^|\/)\.env(?:\.example)?$/i.test(String(rel).replace(/\\/g, '/'))) {
      for (const line of text.split(/\r?\n/)) {
        const envLine = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
        if (envLine) add(envLine[1]);
      }
    }
  }
  return [...names].sort();
}

function githubSecretExpression(name) {
  return '${{ secrets.' + name + ' }}';
}

function repairCiWorkflow(workflow, { hasNpmLockfile = false, envNames = [] } = {}) {
  let text = String(workflow || '').replace(/\r\n/g, '\n');
  if (!hasNpmLockfile) {
    text = text.replace(/(\brun:\s*)npm\s+ci\b/g, '$1npm install');
    text = text.replace(/^\s+cache:\s*['"]?npm['"]?\s*\n/gm, '');
  }
  const missing = [];
  for (const name of [...new Set(envNames)].sort()) {
    const desired = `${name}: ${githubSecretExpression(name)}`;
    const assignment = new RegExp(`^(\\s*)${name}\\s*:.*$`, 'm');
    if (assignment.test(text))
      text = text.replace(assignment, (_line, indent) => `${indent}${desired}`);
    else missing.push(desired);
  }
  if (missing.length) {
    const block = `env:\n${missing.map((line) => `  ${line}`).join('\n')}\n\n`;
    if (/^jobs:\s*$/m.test(text)) text = text.replace(/^jobs:\s*$/m, `${block}jobs:`);
    else text = `${block}${text}`;
  }
  return text.endsWith('\n') ? text : `${text}\n`;
}

function ciWorkflow({
  command = 'npx playwright test',
  hasNpmLockfile = true,
  envNames = [],
} = {}) {
  const workflow = [
    'name: QAAI Playwright Suite',
    '',
    'on:',
    '  workflow_dispatch:',
    '  push:',
    '    branches: [ main ]',
    '  pull_request:',
    '',
    'jobs:',
    '  qaai-playwright:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 30',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: 20',
    ...(hasNpmLockfile ? ['          cache: npm'] : []),
    `      - run: ${hasNpmLockfile ? 'npm ci' : 'npm install'}`,
    '      - run: npx playwright install --with-deps',
    `      - run: ${command}`,
    '        env:',
    '          CI: "1"',
    '      - uses: actions/upload-artifact@v4',
    '        if: always()',
    '        with:',
    '          name: qaai-playwright-artifacts',
    '          path: |',
    '            playwright-report/',
    '            test-results/',
    '            script-validation-results/',
    '',
  ].join('\n');
  return repairCiWorkflow(workflow, { hasNpmLockfile, envNames });
}

function hardenPlaywrightPackageFiles(files = {}, { framework = 'playwright-reference' } = {}) {
  const next = { ...files };
  const lockedVersions = lockedRootDependencyVersions(next);
  const dependencyVersion = (name, fallback) =>
    String(lockedVersions[name] || exactDependencyVersion(name, fallback)).replace(/^[~^]/, '');
  if (next['package.json']) {
    try {
      const pkg = JSON.parse(String(next['package.json']));
      pkg.scripts = {
        ...(pkg.scripts || {}),
        test:
          pkg.scripts?.test ||
          (BDD_FRAMEWORKS.has(framework) ? 'bddgen && playwright test' : 'playwright test'),
        list:
          pkg.scripts?.list ||
          (BDD_FRAMEWORKS.has(framework)
            ? 'bddgen && playwright test --list'
            : 'playwright test --list'),
      };
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps['@playwright/test'] || PLAYWRIGHT_FRAMEWORKS.has(framework)) {
        deps['@playwright/test'] = dependencyVersion('@playwright/test', '1.40.0');
      }
      if (deps['@axe-core/playwright'])
        deps['@axe-core/playwright'] = dependencyVersion('@axe-core/playwright', '4.10.0');
      if (deps['playwright-bdd'] || BDD_FRAMEWORKS.has(framework))
        deps['playwright-bdd'] = dependencyVersion('playwright-bdd', '9.0.0');
      delete pkg.dependencies;
      pkg.devDependencies = Object.fromEntries(
        Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)),
      );
      next['package.json'] = JSON.stringify(pkg, null, 2) + '\n';
    } catch (_) {
      // Package validation will report malformed JSON; keep the original bytes.
    }
  }

  const configPath = next['playwright.config.ts']
    ? 'playwright.config.ts'
    : next['playwright.config.js']
      ? 'playwright.config.js'
      : null;
  if (configPath) {
    const text = String(next[configPath] || '');
    if (!/\bvideo\s*:/.test(text) && /trace\s*:\s*['"]retain-on-failure['"]/.test(text)) {
      next[configPath] = text.replace(
        /trace\s*:\s*['"]retain-on-failure['"]\s*,?/,
        "trace: 'retain-on-failure',\n    video: 'retain-on-failure',",
      );
    }
  }

  const hasNpmLockfile = !!(next['package-lock.json'] || next['npm-shrinkwrap.json']);
  const envNames = qaaiEnvContract(next);
  const workflowPaths = Object.keys(next).filter((rel) =>
    /^\.github\/workflows\/.+\.ya?ml$/i.test(rel),
  );
  for (const rel of workflowPaths) {
    next[rel] = repairCiWorkflow(next[rel], { hasNpmLockfile, envNames });
  }
  if (!next['.github/workflows/qaai-run.yml']) {
    next['.github/workflows/qaai-run.yml'] = ciWorkflow({
      command: BDD_FRAMEWORKS.has(framework)
        ? 'npx bddgen && npx playwright test'
        : 'npx playwright test',
      hasNpmLockfile,
      envNames,
    });
  }
  return next;
}

function writeFiles(root, files = {}) {
  const written = [];
  for (const [rel, content] of Object.entries(files || {})) {
    const clean = safeRelPath(rel);
    if (!clean) continue;
    const full = path.join(root, clean);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(root) + path.sep)) continue;
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(
      resolved,
      Buffer.isBuffer(content) ? content : String(content || ''),
      Buffer.isBuffer(content) ? undefined : 'utf8',
    );
    written.push(clean);
  }
  return written;
}

function packageBin(name, binName, paths) {
  try {
    const pkgPath = require.resolve(`${name}/package.json`, { paths });
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const bin =
      typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && (pkg.bin[binName] || pkg.bin[name]);
    return bin ? path.join(path.dirname(pkgPath), bin) : null;
  } catch (_) {
    return null;
  }
}

function resolveCli(name, binName, workspace) {
  return packageBin(name, binName, [workspace]);
}

function dependencyInstallPlan(files = {}) {
  if (!files['package.json']) return null;
  const locked = !!(files['package-lock.json'] || files['npm-shrinkwrap.json']);
  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: [
      locked ? 'ci' : 'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefer-offline',
    ],
    locked,
  };
}

function envKeyDenied(key) {
  return DENY_ENV_RE.test(String(key || ''));
}

function buildExecutionEnv({
  baseEnv = process.env,
  scopedEnv = {},
  allowedScopedEnvNames = [],
} = {}) {
  const env = {};
  const allowed = new Set(
    (Array.isArray(allowedScopedEnvNames) ? allowedScopedEnvNames : [])
      .map((name) => String(name || '').trim())
      .filter((name) => /^QAAI_[A-Z0-9_]+$/.test(name)),
  );
  for (const key of SAFE_BASE_ENV_KEYS) {
    if (baseEnv[key] != null && !envKeyDenied(key)) env[key] = String(baseEnv[key]);
  }
  for (const [key, value] of Object.entries(scopedEnv || {})) {
    if (envKeyDenied(key) && !allowed.has(key)) {
      throw new Error(`script_validation_env_denied:${key}`);
    }
    env[key] = String(value);
  }
  env.CI = '1';
  env.PWTEST_HTML_REPORT_OPEN = 'never';
  return env;
}

function makeWorkspace({ tmpRoot = DEFAULT_TMP_ROOT, jobId }) {
  const prefix = path.join(tmpRoot, `.qaai-script-validation-${safeId(jobId, 'job')}-`);
  return fs.mkdtempSync(prefix);
}

function cleanupWorkspace(dir) {
  const resolved = path.resolve(dir || '');
  if (!path.basename(resolved).startsWith('.qaai-script-validation-')) return;
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch (_) {}
}

function execFilePromise(execFileImpl, command, args, options) {
  return new Promise((resolve) => {
    const child = execFileImpl(command, args, options, (error, stdout = '', stderr = '') => {
      resolve({
        error,
        exitCode: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        timedOut: !!(error && error.killed),
      });
    });
    if (child && typeof child.on === 'function') {
      child.on('error', (error) =>
        resolve({
          error,
          exitCode: 1,
          stdout: '',
          stderr: String(error.message || error),
          timedOut: false,
        }),
      );
    }
  });
}

function parseJsonReport(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (_) {}
  }
  return null;
}

function lineText(files, file, line) {
  const clean = safeRelPath(file);
  if (!clean || !line) return null;
  const text = files[clean];
  if (text == null || Buffer.isBuffer(text)) return null;
  return String(text).split(/\r?\n/)[Math.max(0, Number(line) - 1)] || null;
}

function normalizeReportPath(file) {
  const raw = String(file || '').replace(/\\/g, '/');
  const marker = raw.match(/(?:^|\/)(tests|pages|features|steps|support|utils|src)\//);
  const candidate = marker
    ? raw.slice(marker.index + (raw[marker.index] === '/' ? 1 : 0))
    : raw.replace(/^\/+/, '');
  return safeRelPath(candidate) || safeRelPath(raw);
}

function attachmentPaths(results = []) {
  const out = [];
  for (const result of results || []) {
    for (const attachment of result.attachments || []) {
      if (!attachment || !attachment.path) continue;
      out.push({
        name: attachment.name || null,
        contentType: attachment.contentType || null,
        path: normalizeReportPath(attachment.path) || String(attachment.path),
      });
    }
  }
  return out;
}

function collectFailuresFromReport(report, files = {}) {
  const failures = [];
  function visitSuite(suite) {
    for (const child of suite?.suites || []) visitSuite(child);
    for (const spec of suite?.specs || []) {
      for (const test of spec.tests || []) {
        const failedResults = (test.results || []).filter(
          (r) => !['passed', 'skipped'].includes(String(r.status || '').toLowerCase()),
        );
        if (
          !failedResults.length &&
          !['unexpected', 'flaky'].includes(String(test.outcome || '').toLowerCase())
        )
          continue;
        const first = failedResults[0] || (test.results || [])[0] || {};
        const err = (first.errors && first.errors[0]) || first.error || {};
        const loc = err.location || first.location || spec.location || {};
        const rel = normalizeReportPath(loc.file || spec.file);
        const line = Number(loc.line || spec.line || 1);
        failures.push({
          schema: SCRIPT_FAILURE_SCHEMA,
          id: crypto
            .createHash('sha1')
            .update(`${rel || 'unknown'}:${line}:${test.title || spec.title || failures.length}`)
            .digest('hex')
            .slice(0, 16),
          testTitle: [spec.title, test.title].filter(Boolean).join(' - '),
          file: rel,
          line,
          column: Number(loc.column || spec.column || 1),
          code: lineText(files, rel, line),
          error: String(
            err.message || first.error?.message || first.status || test.outcome || 'Script failed',
          ),
          tracePath:
            attachmentPaths([first]).find((a) => /trace/i.test(a.name || a.path || ''))?.path ||
            null,
          screenshotPath:
            attachmentPaths([first]).find((a) => /screenshot|png/i.test(a.name || a.path || ''))
              ?.path || null,
          repairAvailable: !!(rel && line && files[rel] != null),
        });
      }
    }
  }
  visitSuite(report || {});
  return failures;
}

function summarizeReport(report, stdout, exitCode) {
  if (report) {
    const failures = collectFailuresFromReport(report);
    let total = 0;
    let skipped = 0;
    let passed = 0;
    function visit(suite) {
      for (const child of suite?.suites || []) visit(child);
      for (const spec of suite?.specs || []) {
        for (const test of spec.tests || []) {
          total += 1;
          const outcome = String(test.outcome || '').toLowerCase();
          if (outcome === 'skipped') skipped += 1;
          else if (outcome === 'expected' || outcome === 'passed') passed += 1;
          else {
            const results = Array.isArray(test.results) ? test.results : [];
            const resultStatuses = results.map((result) =>
              String(result && result.status || '').toLowerCase(),
            );
            if (
              resultStatuses.some((status) => status === 'passed') &&
              !resultStatuses.some((status) => !['passed', 'skipped'].includes(status))
            ) passed += 1;
          }
        }
      }
    }
    visit(report);
    if (Number(exitCode) === 0 && failures.length === 0 && total > 0 && passed === 0) {
      passed = Math.max(0, total - skipped);
    }
    return { total, passed, failed: failures.length, skipped };
  }
  const parsed = parity.parsePlaywrightVerdict(stdout, exitCode);
  return {
    total: (parsed.passed || 0) + (parsed.failed || 0) + (parsed.skipped || 0),
    passed: parsed.passed || 0,
    failed: parsed.failed || 0,
    skipped: parsed.skipped || 0,
  };
}

function copyArtifactFile(src, destRoot, rel) {
  const clean = safeRelPath(rel);
  if (!clean) return null;
  const dest = path.join(destRoot, clean);
  const resolved = path.resolve(dest);
  if (!resolved.startsWith(path.resolve(destRoot) + path.sep)) return null;
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.copyFileSync(src, resolved);
  return path.relative(REPO_ROOT, resolved).replace(/\\/g, '/');
}

function collectArtifacts(workspace, destRoot) {
  const artifacts = [];
  for (const dir of ARTIFACT_DIRS) {
    const root = path.join(workspace, dir);
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(cur, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!entry.isFile() || !ARTIFACT_FILE_RE.test(entry.name)) continue;
        const rel = path.relative(workspace, full).replace(/\\/g, '/');
        const stored = copyArtifactFile(full, destRoot, rel);
        if (stored) artifacts.push({ type: artifactType(rel), path: stored, relPath: rel });
      }
    }
  }
  return artifacts;
}

function artifactType(rel) {
  if (/trace/i.test(rel) && /\.zip$/i.test(rel)) return 'trace';
  if (/\.(png|jpg|jpeg)$/i.test(rel)) return 'screenshot';
  if (/\.(webm|mp4)$/i.test(rel)) return 'video';
  if (/results|report/i.test(rel)) return 'report';
  return 'artifact';
}

function writeValidationArtifacts({
  artifactRoot = DEFAULT_ARTIFACT_ROOT,
  projectId,
  bundleId,
  jobId,
  report,
}) {
  const destRoot = path.join(
    artifactRoot,
    safeId(projectId, 'project'),
    safeId(bundleId, 'bundle'),
    safeId(jobId, 'job'),
  );
  fs.mkdirSync(destRoot, { recursive: true });
  const rels = {};
  for (const [name, content] of Object.entries({
    'validation-report.json': JSON.stringify(report, null, 2) + '\n',
    'stdout.txt': report.logs?.stdout || '',
    'stderr.txt': report.logs?.stderr || '',
  })) {
    const full = path.join(destRoot, name);
    fs.writeFileSync(full, content, 'utf8');
    rels[name] = path.relative(REPO_ROOT, full).replace(/\\/g, '/');
  }
  return { destRoot, rels };
}

function readLatestValidationReport({ artifactRoot = DEFAULT_ARTIFACT_ROOT, projectId, bundleId }) {
  const root = path.join(artifactRoot, safeId(projectId, 'project'), safeId(bundleId, 'bundle'));
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, 'validation-report.json'))
    .filter((full) => fs.existsSync(full))
    .map((full) => ({ full, mtimeMs: fs.statSync(full).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!candidates.length) return null;
  try {
    return JSON.parse(fs.readFileSync(candidates[0].full, 'utf8'));
  } catch (_) {
    return null;
  }
}

function buildPlaywrightArgs({ testFile = null, testTitle = null } = {}) {
  const args = ['test'];
  if (testFile) {
    const clean = safeRelPath(testFile);
    if (!clean) {
      const err = new Error('script_validation_test_file_denied');
      err.code = 'SCRIPT_VALIDATION_TEST_FILE_DENIED';
      throw err;
    }
    args.push(clean);
  }
  if (testTitle) args.push('--grep', String(testTitle));
  args.push('--reporter=json', '--workers=1');
  return args;
}

async function runScriptValidation({
  projectId,
  bundleId,
  framework,
  files = {},
  mode = 'user_run',
  scopedEnv = {},
  testFile = null,
  testTitle = null,
  tmpRoot = DEFAULT_TMP_ROOT,
  artifactRoot = DEFAULT_ARTIFACT_ROOT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  execFileImpl = cp.execFile,
  dependencyExecFileImpl = cp.execFile,
  resolveCliImpl = resolveCli,
} = {}) {
  const adapter = String(framework || '').trim() || 'playwright-reference';
  const jobId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const normalizedBundleId = safeId(bundleId, 'bundle');
  const hardenedFiles = hardenPlaywrightPackageFiles(files, { framework: adapter });
  let validationFiles = hardenedFiles;
  let formattingError = null;
  try {
    validationFiles = await generatedOutputQuality.formatGeneratedFileMap(hardenedFiles);
  } catch (error) {
    formattingError = error;
  }
  const packageHash = hashFiles(validationFiles);
  const startedAt = new Date().toISOString();

  const baseJob = {
    schema: SCRIPT_VALIDATION_SCHEMA,
    id: jobId,
    projectId: projectId || null,
    bundleId: normalizedBundleId,
    framework: adapter,
    mode,
    status: 'running',
    startedAt,
    completedAt: null,
    packageHash,
  };

  if (!PLAYWRIGHT_FRAMEWORKS.has(adapter)) {
    const report = {
      ...baseJob,
      status: 'preview_only',
      completedAt: new Date().toISOString(),
      reason: 'script_validation_framework_not_supported',
      summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
      failures: [],
      artifacts: [],
      logs: { stdout: '', stderr: '' },
      certification: { scriptResult: 'Preview only', certified: false },
    };
    const persisted = writeValidationArtifacts({
      artifactRoot,
      projectId,
      bundleId: normalizedBundleId,
      jobId,
      report,
    });
    report.artifacts.push({
      type: 'report',
      path: persisted.rels['validation-report.json'],
      relPath: 'validation-report.json',
    });
    return report;
  }

  let outputQuality;
  try {
    if (formattingError) throw formattingError;
    outputQuality = await generatedOutputQuality.verifyGeneratedFileMap(validationFiles);
  } catch (error) {
    outputQuality = {
      ok: false,
      files: [],
      lintErrors: 1,
      lintWarnings: 0,
      unformatted: [],
      issues: [
        {
          file: null,
          line: 1,
          column: 1,
          severity: 'error',
          rule: 'quality_tooling',
          message: String((error && error.message) || error),
        },
      ],
    };
  }
  baseJob.outputQuality = outputQuality;
  if (!outputQuality.ok) {
    const firstIssue = (outputQuality.issues && outputQuality.issues[0]) || {};
    const report = {
      ...baseJob,
      status: 'failed',
      completedAt: new Date().toISOString(),
      reason: 'generated_output_quality_failed',
      summary: { total: 0, passed: 0, failed: 1, skipped: 0 },
      failures: [
        {
          schema: SCRIPT_FAILURE_SCHEMA,
          id: crypto
            .createHash('sha1')
            .update(
              `generated_output_quality_failed:${firstIssue.file || ''}:${firstIssue.rule || ''}`,
            )
            .digest('hex')
            .slice(0, 16),
          testTitle: 'Generated output quality',
          file: firstIssue.file || null,
          line: firstIssue.line || 1,
          code: firstIssue.rule || 'generated_output_quality_failed',
          error: firstIssue.message || 'Generated output failed ESLint or Prettier validation.',
          repairAvailable: false,
        },
      ],
      artifacts: [],
      logs: { stdout: '', stderr: outputQuality.lintOutput || '' },
      certification: { scriptResult: 'Failed', certified: false, outputQualityOk: false },
    };
    const persisted = writeValidationArtifacts({
      artifactRoot,
      projectId,
      bundleId: normalizedBundleId,
      jobId,
      report,
    });
    report.artifacts.push({
      type: 'report',
      path: persisted.rels['validation-report.json'],
      relPath: 'validation-report.json',
    });
    return report;
  }

  let workspace = null;
  try {
    workspace = makeWorkspace({ tmpRoot, jobId });
    writeFiles(workspace, validationFiles);

    const env = buildExecutionEnv({
      scopedEnv,
      allowedScopedEnvNames: qaaiEnvContract(validationFiles),
    });
    const commands = [];
    const installPlan = dependencyInstallPlan(validationFiles);
    if (!installPlan) {
      const report = {
        ...baseJob,
        status: 'preview_only',
        completedAt: new Date().toISOString(),
        reason: 'dependency_manifest_missing',
        summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
        failures: [],
        artifacts: [],
        logs: { stdout: '', stderr: 'Generated package.json was not found.' },
        commands,
        certification: { scriptResult: 'Preview only', certified: false },
      };
      const persisted = writeValidationArtifacts({
        artifactRoot,
        projectId,
        bundleId: normalizedBundleId,
        jobId,
        report,
      });
      report.artifacts.push({
        type: 'report',
        path: persisted.rels['validation-report.json'],
        relPath: 'validation-report.json',
      });
      return report;
    }
    const installed = await execFilePromise(
      dependencyExecFileImpl,
      installPlan.command,
      installPlan.args,
      {
        cwd: workspace,
        env,
        // Node cannot exec a .cmd shim directly on Windows (spawn EINVAL).
        // The command and every argument are fixed by dependencyInstallPlan;
        // no generated/user text is interpolated into this shell invocation.
        shell: process.platform === 'win32',
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
      },
    );
    commands.push({
      cmd: `${installPlan.command} ${installPlan.args.join(' ')}`,
      exitCode: installed.exitCode,
      timedOut: installed.timedOut,
    });
    if (installed.exitCode !== 0) {
      const report = {
        ...baseJob,
        status: 'preview_only',
        completedAt: new Date().toISOString(),
        reason: 'dependency_install_failed',
        summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
        failures: [],
        artifacts: [],
        logs: {
          stdout: installed.stdout.slice(0, MAX_OUTPUT_BYTES),
          stderr: installed.stderr.slice(0, MAX_OUTPUT_BYTES),
        },
        commands,
        certification: { scriptResult: 'Preview only', certified: false },
      };
      const persisted = writeValidationArtifacts({
        artifactRoot,
        projectId,
        bundleId: normalizedBundleId,
        jobId,
        report,
      });
      report.artifacts.push({
        type: 'report',
        path: persisted.rels['validation-report.json'],
        relPath: 'validation-report.json',
      });
      return report;
    }
    if (BDD_FRAMEWORKS.has(adapter)) {
      const bddCli = resolveCliImpl('playwright-bdd', 'bddgen', workspace);
      if (!bddCli) {
        const report = {
          ...baseJob,
          status: 'preview_only',
          completedAt: new Date().toISOString(),
          reason: 'playwright_bdd_dependency_missing',
          summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
          failures: [],
          artifacts: [],
          logs: { stdout: '', stderr: 'playwright-bdd CLI not found' },
          commands,
          certification: { scriptResult: 'Preview only', certified: false },
        };
        const persisted = writeValidationArtifacts({
          artifactRoot,
          projectId,
          bundleId: normalizedBundleId,
          jobId,
          report,
        });
        report.artifacts.push({
          type: 'report',
          path: persisted.rels['validation-report.json'],
          relPath: 'validation-report.json',
        });
        return report;
      }
      const bdd = await execFilePromise(execFileImpl, process.execPath, [bddCli], {
        cwd: workspace,
        env,
        shell: false,
        timeout: Math.min(timeoutMs, 60_000),
        maxBuffer: MAX_OUTPUT_BYTES,
      });
      commands.push({ cmd: 'bddgen', exitCode: bdd.exitCode, timedOut: bdd.timedOut });
      if (bdd.exitCode !== 0) {
        const report = {
          ...baseJob,
          status: 'failed',
          completedAt: new Date().toISOString(),
          reason: 'bdd_generation_failed',
          summary: { total: 0, passed: 0, failed: 1, skipped: 0 },
          failures: [
            {
              schema: SCRIPT_FAILURE_SCHEMA,
              id: crypto
                .createHash('sha1')
                .update('bdd_generation_failed')
                .digest('hex')
                .slice(0, 16),
              testTitle: 'BDD generation',
              file: 'playwright.config.ts',
              line: 1,
              code: null,
              error: (bdd.stderr || bdd.stdout || 'bddgen failed').slice(0, 2000),
              repairAvailable: false,
            },
          ],
          artifacts: [],
          logs: {
            stdout: bdd.stdout.slice(0, MAX_OUTPUT_BYTES),
            stderr: bdd.stderr.slice(0, MAX_OUTPUT_BYTES),
          },
          commands,
          certification: { scriptResult: 'Failed', certified: false },
        };
        const persisted = writeValidationArtifacts({
          artifactRoot,
          projectId,
          bundleId: normalizedBundleId,
          jobId,
          report,
        });
        report.artifacts.push({
          type: 'report',
          path: persisted.rels['validation-report.json'],
          relPath: 'validation-report.json',
        });
        return report;
      }
    }

    const cli = resolveCliImpl('@playwright/test', 'playwright', workspace);
    if (!cli) {
      const report = {
        ...baseJob,
        status: 'preview_only',
        completedAt: new Date().toISOString(),
        reason: 'playwright_cli_missing',
        summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
        failures: [],
        artifacts: [],
        logs: { stdout: '', stderr: '@playwright/test CLI not found' },
        commands,
        certification: { scriptResult: 'Preview only', certified: false },
      };
      const persisted = writeValidationArtifacts({
        artifactRoot,
        projectId,
        bundleId: normalizedBundleId,
        jobId,
        report,
      });
      report.artifacts.push({
        type: 'report',
        path: persisted.rels['validation-report.json'],
        relPath: 'validation-report.json',
      });
      return report;
    }

    const playArgs = buildPlaywrightArgs({ testFile, testTitle });
    const result = await execFilePromise(execFileImpl, process.execPath, [cli, ...playArgs], {
      cwd: workspace,
      env,
      shell: false,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    commands.push({
      cmd: `playwright ${playArgs.join(' ')}`,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    });
    const json = parseJsonReport(result.stdout);
    const summary = summarizeReport(json, result.stdout, result.exitCode);
    const failures = json ? collectFailuresFromReport(json, validationFiles) : [];
    const roundTripValidationEnabled = featureFlags.enabled(
      'roundTripScriptValidationEnabled',
      true,
    );
    const roundTripValidation = roundTripValidationEnabled
      ? roundTripParity.validateBundleRoundTrip({
          files: validationFiles,
          validationSummary: summary,
        })
      : {
          schema: roundTripParity.SCHEMA,
          ok: true,
          skipped: true,
          reason: 'round_trip_script_validation_disabled',
          findings: [],
        };
    const roundTripFindings = (
      Array.isArray(roundTripValidation.findings) ? roundTripValidation.findings : []
    ).map((finding) =>
      locatorOnlyRoundTripFinding(finding)
        ? { ...finding, severity: 'warning', nonBlocking: true }
        : finding,
    );
    roundTripValidation.findings = roundTripFindings;
    roundTripValidation.ok = !roundTripFindings.some(
      (finding) => finding && finding.severity === 'error',
    );
    const roundTripErrors = roundTripFindings.filter(
      (finding) => finding && finding.severity === 'error',
    );
    const playwrightPassed = result.exitCode === 0 && summary.failed === 0 && summary.total > 0;
    // Script execution and evidence-parity review are independent results.
    // A diagnostic parity finding must never replace a real Playwright pass
    // with a failed execution result or prevent users from running the bundle.
    const status = playwrightPassed
      ? roundTripErrors.length > 0
        ? 'passed'
        : mode === 'repair_rerun'
          ? 'healed'
          : 'certified'
      : summary.total === 0 && result.exitCode === 0
        ? 'preview_only'
        : 'failed';
    const scriptResult =
      status === 'certified'
        ? 'Certified'
        : status === 'healed'
          ? 'Healed'
          : status === 'passed'
            ? 'Passed'
          : status === 'preview_only'
            ? 'Preview only'
            : 'Failed';
    const report = {
      ...baseJob,
      status,
      completedAt: new Date().toISOString(),
      reason:
        status === 'certified'
          ? 'playwright_run_passed'
          : status === 'healed'
            ? 'script_repair_rerun_passed'
            : status === 'passed'
              ? 'playwright_run_passed_with_parity_diagnostics'
            : status === 'preview_only'
              ? 'no_tests_executed'
              : result.timedOut
                ? 'playwright_run_timeout'
                : 'playwright_run_failed',
      summary,
      failures,
      roundTripValidation,
      artifacts: [],
      logs: {
        stdout: result.stdout.slice(0, MAX_OUTPUT_BYTES),
        stderr: result.stderr.slice(0, MAX_OUTPUT_BYTES),
      },
      commands,
      certification: {
        scriptResult,
        certified: status === 'certified' || status === 'healed',
        outputQualityOk: outputQuality.ok,
        previewAvailable: true,
        requiresCleanRerun: failures.some((f) => f.repairAvailable) || roundTripErrors.length > 0,
        roundTripParityOk: roundTripValidation.ok === true,
      },
    };
    const persisted = writeValidationArtifacts({
      artifactRoot,
      projectId,
      bundleId: normalizedBundleId,
      jobId,
      report,
    });
    const copiedArtifacts = collectArtifacts(workspace, persisted.destRoot);
    report.artifacts.push(
      {
        type: 'report',
        path: persisted.rels['validation-report.json'],
        relPath: 'validation-report.json',
      },
      { type: 'stdout', path: persisted.rels['stdout.txt'], relPath: 'stdout.txt' },
      { type: 'stderr', path: persisted.rels['stderr.txt'], relPath: 'stderr.txt' },
      ...copiedArtifacts,
    );
    fs.writeFileSync(
      path.join(persisted.destRoot, 'validation-report.json'),
      JSON.stringify(report, null, 2) + '\n',
      'utf8',
    );
    return report;
  } catch (error) {
    const report = {
      ...baseJob,
      status: 'failed',
      completedAt: new Date().toISOString(),
      reason: 'script_validation_internal_error',
      summary: { total: 0, passed: 0, failed: 1, skipped: 0 },
      failures: [
        {
          schema: SCRIPT_FAILURE_SCHEMA,
          id: crypto
            .createHash('sha1')
            .update(String((error && error.message) || error))
            .digest('hex')
            .slice(0, 16),
          testTitle: 'Script validation runner',
          file: null,
          line: 1,
          code: null,
          error: String((error && error.message) || error),
          repairAvailable: false,
        },
      ],
      artifacts: [],
      logs: { stdout: '', stderr: String((error && error.stack) || error) },
      certification: { scriptResult: 'Failed', certified: false },
    };
    const persisted = writeValidationArtifacts({
      artifactRoot,
      projectId,
      bundleId: normalizedBundleId,
      jobId,
      report,
    });
    report.artifacts.push({
      type: 'report',
      path: persisted.rels['validation-report.json'],
      relPath: 'validation-report.json',
    });
    return report;
  } finally {
    if (workspace) cleanupWorkspace(workspace);
  }
}

module.exports = {
  SCRIPT_VALIDATION_SCHEMA,
  SCRIPT_FAILURE_SCHEMA,
  DEFAULT_ARTIFACT_ROOT,
  PLAYWRIGHT_FRAMEWORKS,
  BDD_FRAMEWORKS,
  safeRelPath,
  safeId,
  hashFiles,
  exactDependencyVersion,
  qaaiEnvContract,
  repairCiWorkflow,
  ciWorkflow,
  hardenPlaywrightPackageFiles,
  dependencyInstallPlan,
  buildExecutionEnv,
  parseJsonReport,
  collectFailuresFromReport,
  summarizeReport,
  buildPlaywrightArgs,
  runScriptValidation,
  readLatestValidationReport,
};
