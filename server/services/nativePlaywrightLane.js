'use strict';

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNTIME_MODE = 'native_playwright_agent';
const DEFAULT_TEST_TIMEOUT_MS = 120000;
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_NATIVE_RUN_ROOT = path.join(REPO_ROOT, 'tmp', 'native-runs');
const NATIVE_IMPORT_SCHEMA = 'qaai-native-playwright-import/1';
const NATIVE_MANIFEST_SCHEMA = 'qaai-native-playwright-workspace/1';

const AGENT_FILES = Object.freeze({
  '.github/agents/playwright-test-planner.agent.md': `---
name: playwright-test-planner
description: Create comprehensive Playwright test plans from QAAI Markdown specs.
tools:
  - search
  - playwright-test/browser_click
  - playwright-test/browser_navigate
  - playwright-test/browser_snapshot
  - playwright-test/browser_type
  - playwright-test/browser_wait_for
  - playwright-test/planner_setup_page
  - playwright-test/planner_save_plan
model: Claude Sonnet 4
mcp-servers:
  playwright-test:
    type: stdio
    command: npx
    args: [playwright, run-test-mcp-server]
    tools: ["*"]
---

You are QAAI's Playwright planner. Read the QAAI spec, explore only through Playwright tools, and save a deterministic Markdown plan with independent scenarios, expected outcomes, and setup assumptions.
`,
  '.github/agents/playwright-test-generator.agent.md': `---
name: playwright-test-generator
description: Generate one Playwright spec from one QAAI Markdown scenario.
tools:
  - search
  - playwright-test/browser_click
  - playwright-test/browser_evaluate
  - playwright-test/browser_navigate
  - playwright-test/browser_snapshot
  - playwright-test/browser_type
  - playwright-test/browser_verify_element_visible
  - playwright-test/browser_verify_text_visible
  - playwright-test/browser_wait_for
  - playwright-test/generator_read_log
  - playwright-test/generator_setup_page
  - playwright-test/generator_write_test
model: Claude Sonnet 4
mcp-servers:
  playwright-test:
    type: stdio
    command: npx
    args: [playwright, run-test-mcp-server]
    tools: ["*"]
---

You are QAAI's Playwright generator. Execute the scenario live, read the generator log, and write a single robust Playwright test. Preserve QAAI comments before each step.
`,
  '.github/agents/playwright-test-healer.agent.md': `---
name: playwright-test-healer
description: Debug and repair failing generated Playwright tests.
tools:
  - search
  - edit
  - playwright-test/browser_console_messages
  - playwright-test/browser_generate_locator
  - playwright-test/browser_network_requests
  - playwright-test/browser_snapshot
  - playwright-test/test_debug
  - playwright-test/test_list
  - playwright-test/test_run
model: Claude Sonnet 4
mcp-servers:
  playwright-test:
    type: stdio
    command: npx
    args: [playwright, run-test-mcp-server]
    tools: ["*"]
---

You are QAAI's Playwright healer. Run failing tests, debug with Playwright tools, repair one issue at a time, and rerun until pass. Keep every scenario enabled. If exact locator evidence is unavailable, use a semantic role/function-based locator with a QAAI_GUESSED_LOCATOR comment; preserve later independent steps.
`,
  '.github/agents/playwright-test-reviewer.agent.md': `---
name: playwright-test-reviewer
description: Review generated Playwright tests against QAAI specs, data, evidence, and certification rules.
tools:
  - search
  - playwright-test/test_list
  - playwright-test/test_run
  - playwright-test/browser_snapshot
  - playwright-test/browser_generate_locator
model: Claude Sonnet 4
mcp-servers:
  playwright-test:
    type: stdio
    command: npx
    args: [playwright, run-test-mcp-server]
    tools: ["*"]
---

You are QAAI's Playwright reviewer. You do not own the live runtime loop. Review the generated script package after planner/generator/healer work and produce a certification readiness note.

Check:
- every QAAI scenario step is represented or explicitly justified as setup/assertion-only
- every required assertion/oracle has an enabled Playwright assertion; a non-flow-blocking mismatch uses an explicit soft assertion so later independent steps still run
- test data comes from the declared QAAI data rows/fixtures, not guessed inline values
- locators prefer role, label, test id, accessible name, or proven resolver helpers over brittle CSS/XPath
- stateful dependencies, login, cleanup, and fresh-context rules are represented
- failed generated tests include exact file/line and repair guidance

Output:
- Certified-ready only when the generated suite runs cleanly and preserves the declared behavior
- Preview-only with concrete reasons when evidence is missing or unsupported actions remain
`,
});

function slugify(value, fallback = 'case') {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || fallback;
}

function list(value) {
  if (!Array.isArray(value) || !value.length) return '- None declared';
  return value.map((item, idx) => `${idx + 1}. ${String(item || '').trim()}`).join('\n');
}

function safeRelPath(value) {
  const normalized = path.normalize(String(value || '')).replace(/^([/\\])+/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('..') || path.isAbsolute(normalized)) return null;
  return normalized.replace(/\\/g, '/');
}

function targetUrlFor(project = {}, testCase = {}) {
  return project.targetUrl || testCase.targetUrl || project.baseUrl || '';
}

function outputFileFor(testCase = {}) {
  const moduleName = testCase.module || testCase.suite || 'General';
  const caseName = testCase.name || testCase.title || 'Unnamed test case';
  return `tests/${slugify(moduleName, 'module')}/${slugify(caseName, 'scenario')}.spec.ts`;
}

function buildMarkdownSpec({ project = {}, testCase = {}, authProfile = null, dataRows = [], outputFile = null } = {}) {
  const projectName = project.name || project.title || 'QAAI Project';
  const caseName = testCase.name || testCase.title || 'Unnamed test case';
  const caseId = testCase.id || testCase.caseId || slugify(caseName);
  const moduleName = testCase.module || testCase.suite || 'General';
  const targetUrl = project.targetUrl || testCase.targetUrl || project.baseUrl || '(target URL not declared)';
  const steps = Array.isArray(testCase.steps) ? testCase.steps : [];
  const assertions = Array.isArray(testCase.declaredAssertions) ? testCase.declaredAssertions : [];
  const quality = testCase.qualityContract && typeof testCase.qualityContract === 'object' ? testCase.qualityContract : null;
  const dataPreview = Array.isArray(dataRows) && dataRows.length
    ? dataRows.map((row, idx) => `- Row ${idx + 1}: ${JSON.stringify(row)}`).join('\n')
    : '- None declared';
  const filePath = outputFile || outputFileFor(testCase);
  const seedFile = testCase.seedFile || 'seed/seed.spec.ts';

  return [
    `# ${caseName}`,
    '',
    `**QAAI Runtime Mode:** ${RUNTIME_MODE}`,
    `**Project:** ${projectName}`,
    `**Case ID:** ${caseId}`,
    `**Module:** ${moduleName}`,
    `**Target:** ${targetUrl}`,
    `**Seed:** ${seedFile}`,
    `**File:** ${filePath}`,
    '',
    '## Business Goal',
    String(testCase.description || testCase.caseIntent || testCase.intent || 'Execute the approved QAAI scenario and prove the declared outcome.'),
    '',
    '## Role And Auth',
    authProfile
      ? `- Auth profile: ${authProfile.name || authProfile.id || 'unnamed'}\n- Strategy: ${authProfile.strategy || 'unspecified'}`
      : '- No auth profile declared',
    '',
    '## Preconditions',
    quality && Array.isArray(quality.preconditions)
      ? list(quality.preconditions)
      : '- Start from a clean browser context.',
    '',
    '## Session And Cleanup',
    quality && quality.sessionRule
      ? [
          `- Isolation: ${quality.sessionRule.isolation || 'fresh_context_per_case'}`,
          `- Storage state: ${quality.sessionRule.storageState || 'none_unless_auth_profile_declares_it'}`,
          `- Cleanup: ${quality.sessionRule.cleanup || 'close_context_after_case'}`,
          `- Dirty-state policy: ${quality.sessionRule.dirtyStatePolicy || 'never_reuse_dirty_state'}`,
        ].join('\n')
      : '- Fresh browser context per case; close context after case.',
    '',
    '## Test Data',
    dataPreview,
    '',
    '## Steps',
    list(steps.map((step) => {
      if (typeof step === 'string') return step;
      return [step.action, step.element || step.target, step.value != null ? `= ${step.value}` : ''].filter(Boolean).join(' ');
    })),
    '',
    '## Expected Results',
    list(assertions.map((assertion) => {
      if (typeof assertion === 'string') return assertion;
      return assertion.text || assertion.assertion || assertion.description || assertion.id || JSON.stringify(assertion);
    })),
    '',
    '## Failure Conditions',
    '- Do not mark the test green if required assertions are absent.',
    '- Never use test.skip, test.fixme, a manual gate, or an early return to hide missing evidence.',
    '- For a locator-only gap, emit a semantic role/function-based locator with QAAI_GUESSED_LOCATOR directly above it.',
    '- Do not inline secrets in generated code.',
    '',
    '## Evidence Requirements',
    '- Playwright trace or screenshot on failure.',
    '- Locator/action comments must preserve the QAAI step text.',
    '- Generated script must run inside the QAAI native-lane sandbox.',
    '',
  ].join('\n');
}

function buildSandboxPolicy({ workspaceRoot, runWorkspace, networkPolicy = 'project_default', timeoutMs = DEFAULT_TEST_TIMEOUT_MS } = {}) {
  const root = workspaceRoot ? path.resolve(workspaceRoot) : null;
  const run = runWorkspace ? path.resolve(runWorkspace) : null;
  return Object.freeze({
    mode: 'locked_child_worker',
    workspaceRoot: root,
    runWorkspace: run,
    timeoutMs,
    noPlatformEnv: true,
    denyEnvPatterns: Object.freeze(['DATABASE_URL', 'JWT_SECRET', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'QAAI_', 'PRISMA_']),
    denyPathFragments: Object.freeze(['.env', 'prisma/dev.db', 'prisma/dev.db-shm', 'prisma/dev.db-wal', 'server/prisma.js']),
    artifactAllowlist: Object.freeze(['test-results', 'playwright-report', 'blob-report', 'traces', 'screenshots', 'videos', 'native-lane-results']),
    networkPolicy,
  });
}

function assertSandboxPolicy(policy = {}) {
  if (!policy.runWorkspace) throw new Error('native_lane_sandbox_missing_run_workspace');
  if (!policy.workspaceRoot) throw new Error('native_lane_sandbox_missing_workspace_root');
  const root = path.resolve(policy.workspaceRoot);
  const run = path.resolve(policy.runWorkspace);
  if (run === root) throw new Error('native_lane_sandbox_run_workspace_must_not_equal_repo_root');
  if (!run.startsWith(root + path.sep)) throw new Error('native_lane_sandbox_run_workspace_must_be_inside_repo_root');
  if (policy.noPlatformEnv !== true) throw new Error('native_lane_sandbox_must_strip_platform_env');
  if (!Array.isArray(policy.denyEnvPatterns) || !policy.denyEnvPatterns.length) throw new Error('native_lane_sandbox_missing_env_denylist');
  if (!Array.isArray(policy.denyPathFragments) || !policy.denyPathFragments.length) throw new Error('native_lane_sandbox_missing_path_denylist');
  if (!Array.isArray(policy.artifactAllowlist) || !policy.artifactAllowlist.length) throw new Error('native_lane_sandbox_missing_artifact_allowlist');
  if (!Number.isFinite(Number(policy.timeoutMs)) || Number(policy.timeoutMs) <= 0) throw new Error('native_lane_sandbox_missing_timeout');
  return true;
}

function envKeyDenied(key, patterns = []) {
  const upper = String(key || '').toUpperCase();
  return (patterns || []).some((pattern) => {
    const pat = String(pattern || '').toUpperCase();
    if (!pat) return false;
    if (pat.endsWith('_')) return upper.startsWith(pat);
    return upper === pat || upper.startsWith(`${pat}_`);
  });
}

function buildSandboxEnv({ policy, baseEnv = process.env, scopedTestEnv = {} } = {}) {
  assertSandboxPolicy(policy);
  const allowedHostKeys = [
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
    'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR',
    'LOCALAPPDATA', 'APPDATA',
  ];
  const out = {};
  for (const key of allowedHostKeys) {
    if (baseEnv[key] != null && !envKeyDenied(key, policy.denyEnvPatterns)) out[key] = String(baseEnv[key]);
  }
  out.CI = '1';
  out.PWTEST_HTML_REPORT_OPEN = 'never';
  out.PLAYWRIGHT_HTML_OPEN = 'never';
  out.QAAI_NATIVE_LANE = '1';
  for (const [key, value] of Object.entries(scopedTestEnv || {})) {
    if (envKeyDenied(key, policy.denyEnvPatterns)) {
      throw new Error(`native_lane_scoped_env_key_denied:${key}`);
    }
    out[key] = String(value == null ? '' : value);
  }
  return out;
}

function assertSandboxPath(policy, candidatePath, label = 'path') {
  assertSandboxPolicy(policy);
  const runRoot = path.resolve(policy.runWorkspace);
  const absolute = path.resolve(runRoot, String(candidatePath || ''));
  if (absolute !== runRoot && !absolute.startsWith(runRoot + path.sep)) {
    throw new Error(`native_lane_${label}_outside_run_workspace`);
  }
  const rel = path.relative(runRoot, absolute).replace(/\\/g, '/').toLowerCase();
  const denied = (policy.denyPathFragments || []).find((fragment) => rel.includes(String(fragment).replace(/\\/g, '/').toLowerCase()));
  if (denied) throw new Error(`native_lane_${label}_denied:${denied}`);
  return absolute;
}

function validateAgentFiles(files = AGENT_FILES) {
  const required = [
    '.github/agents/playwright-test-planner.agent.md',
    '.github/agents/playwright-test-generator.agent.md',
    '.github/agents/playwright-test-healer.agent.md',
    '.github/agents/playwright-test-reviewer.agent.md',
  ];
  const issues = [];
  for (const rel of required) {
    const body = files[rel];
    if (!body) {
      issues.push({ code: 'missing_agent_file', path: rel });
      continue;
    }
    if (!/run-test-mcp-server/.test(body)) issues.push({ code: 'missing_playwright_agent_mcp', path: rel });
    if (!/playwright-test\//.test(body)) issues.push({ code: 'missing_playwright_tools', path: rel });
  }
  return { valid: issues.length === 0, issues };
}

function escapeRegexSource(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inferredRole(action, label) {
  if (/(fill|type|enter|input)/.test(action)) return 'textbox';
  if (/(check|toggle)/.test(action)) return 'checkbox';
  if (/(select|choose)/.test(action)) return 'combobox';
  if (/link/.test(String(label || '').toLowerCase())) return 'link';
  return 'button';
}

function runnableFallbackStep(step = {}, index = 0) {
  const action = String(step.action || step.type || step.operation || 'perform').trim().toLowerCase();
  const label = String(step.element || step.target || step.label || step.name || '').trim();
  const value = step.value ?? step.input ?? step.data ?? '';
  const expected = step.expected ?? step.expectation ?? step.check ?? '';
  const stepName = `Step ${index + 1}: ${action}${label ? ` on ${label}` : ''}`;
  if (/(navigate|goto|open url)/.test(action) && value) {
    return [`  // ${stepName}`, `  await page.goto(${JSON.stringify(String(value))});`];
  }
  if (/(wait|pause)/.test(action)) {
    const timeout = Number(step.timeoutMs ?? step.durationMs ?? step.waitMs ?? value);
    if (label) {
      const locator = `page.getByRole(${JSON.stringify(inferredRole(action, label))}, { name: new RegExp(${JSON.stringify(escapeRegexSource(label))}, 'i') })`;
      return [
        `  // ${stepName}`,
        '  // QAAI_GUESSED_LOCATOR: Runtime DOM evidence was unavailable; replace this semantic locator with a DOM-confirmed locator if needed.',
        `  await ${locator}.waitFor({ state: 'visible'${Number.isFinite(timeout) && timeout > 0 ? `, timeout: ${Math.round(timeout)}` : ''} });`,
      ];
    }
    if (Number.isFinite(timeout) && timeout > 0) return [`  // ${stepName}`, `  await page.waitForTimeout(${Math.round(timeout)});`];
  }
  if (label && /(click|hover|fill|type|enter|check|toggle|select|choose|verify|assert|expect)/.test(action)) {
    const locator = `page.getByRole(${JSON.stringify(inferredRole(action, label))}, { name: new RegExp(${JSON.stringify(escapeRegexSource(label))}, 'i') })`;
    let statement = `await ${locator}.click();`;
    if (/hover/.test(action)) statement = `await ${locator}.hover();`;
    else if (/(fill|type|enter)/.test(action)) statement = `await ${locator}.fill(${JSON.stringify(String(value))});`;
    else if (/(check|toggle)/.test(action)) statement = `await ${locator}.check();`;
    else if (/(select|choose)/.test(action)) statement = `await ${locator}.selectOption(${JSON.stringify(String(value))});`;
    else if (/(verify|assert|expect)/.test(action)) {
      statement = expected
        ? `await expect(${locator}).toContainText(${JSON.stringify(String(expected))});`
        : `await expect(${locator}).toBeVisible();`;
    }
    return [
      `  // ${stepName}`,
      '  // QAAI_GUESSED_LOCATOR: Runtime DOM evidence was unavailable; replace this semantic locator with a DOM-confirmed locator if needed.',
      `  ${statement}`,
    ];
  }
  return [
    `  // ${stepName}`,
    `  expect.soft(false, ${JSON.stringify(`QAAI_FALLBACK: ${stepName} lacks enough runtime evidence for exact code generation; later independent steps continue.`)}).toBe(true);`,
  ];
}

function minimalRunnableSpec({ testCase = {}, markdownSpecPath = null } = {}) {
  const title = String(testCase.name || testCase.title || 'QAAI generated scenario').replace(/[`$]/g, '');
  const specRef = markdownSpecPath ? ` See ${markdownSpecPath}.` : '';
  const steps = Array.isArray(testCase.steps) ? testCase.steps : [];
  return [
    "import { test, expect } from '@playwright/test';",
    '',
    `test(${JSON.stringify(title)}, async ({ page }) => {`,
    `  // QAAI runnable_unverified fallback.${specRef}`,
    "  // Every authored step remains enabled; review QAAI_GUESSED_LOCATOR comments after generation.",
    ...steps.flatMap((step, index) => runnableFallbackStep(step, index)),
    ...(steps.length ? [] : ["  expect.soft(false, 'QAAI_FALLBACK: No authored steps were available to compile.').toBe(true);"]),
    '});',
    '',
  ].join('\n');
}

function playwrightConfig({ baseUrl = '' } = {}) {
  return [
    "import { defineConfig } from '@playwright/test';",
    '',
    'export default defineConfig({',
    "  testDir: './tests',",
    '  timeout: 60000,',
    '  expect: { timeout: 10000 },',
    '  workers: 1,',
    "  reporter: [['json', { outputFile: 'native-lane-results/results.json' }], ['html', { outputFolder: 'playwright-report', open: 'never' }]],",
    `  use: { baseURL: ${JSON.stringify(baseUrl || undefined)}, headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'retain-on-failure' },`,
    '});',
    '',
  ].join('\n');
}

function packageJson() {
  return JSON.stringify({
    name: 'qaai-native-playwright-lane',
    private: true,
    version: '0.0.0',
    type: 'module',
    scripts: {
      test: 'playwright test',
      'test:list': 'playwright test --list',
    },
    devDependencies: {
      '@playwright/test': '1.56.0',
    },
  }, null, 2) + '\n';
}

function buildWorkspaceFiles({
  project = {},
  testCase = {},
  authProfile = null,
  dataRows = [],
  outputFile = null,
  markdownSpec = null,
  generatedSpec = null,
} = {}) {
  const projectSlug = slugify(project.name || project.title || project.id || 'project', 'project');
  const caseId = testCase.id || testCase.caseId || slugify(testCase.name || testCase.title || 'case', 'case');
  const caseSlug = slugify(caseId, 'case');
  const specRel = `specs/${projectSlug}/${caseSlug}.md`;
  const outputRel = safeRelPath(outputFile || outputFileFor(testCase));
  if (!outputRel) throw new Error('native_lane_invalid_output_file');
  const spec = markdownSpec || buildMarkdownSpec({ project, testCase, authProfile, dataRows, outputFile: outputRel });
  const seedRel = safeRelPath(testCase.seedFile || 'seed/seed.spec.ts');
  const files = {
    ...AGENT_FILES,
    [specRel]: spec,
    [outputRel]: generatedSpec || minimalRunnableSpec({ testCase, markdownSpecPath: specRel }),
    [seedRel]: [
      "import { test as setup } from '@playwright/test';",
      '',
      "setup('QAAI native lane seed/setup placeholder', async () => {",
      '  // Project-specific seed/setup actions are declared in the Markdown spec.',
      '});',
      '',
    ].join('\n'),
    'playwright.config.ts': playwrightConfig({ baseUrl: targetUrlFor(project, testCase) }),
    'package.json': packageJson(),
  };
  files['native-lane-manifest.json'] = JSON.stringify({
    schema: NATIVE_MANIFEST_SCHEMA,
    runtimeMode: RUNTIME_MODE,
    status: generatedSpec ? 'generated_script_present' : 'runnable_unverified_until_agent_generates_script',
    experimental: true,
    certificationStatus: 'preview_not_certified',
    markdownSpec: specRel,
    generatedTest: outputRel,
    seedFile: seedRel,
    agentFiles: Object.keys(AGENT_FILES),
    evidenceRequirements: ['trace', 'screenshot_on_failure', 'results_json'],
    createdAt: new Date(0).toISOString(),
  }, null, 2) + '\n';
  return { files, specRel, outputRel, seedRel };
}

function writeWorkspaceFiles(runWorkspace, files = {}) {
  for (const [rel, content] of Object.entries(files)) {
    const clean = safeRelPath(rel);
    if (!clean) throw new Error(`native_lane_invalid_workspace_path:${rel}`);
    const full = path.join(runWorkspace, clean);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, String(content == null ? '' : content), 'utf8');
  }
}

function prepareNativeLaneWorkspace({
  workspaceRoot = REPO_ROOT,
  runId = `native-${Date.now()}`,
  runWorkspace = null,
  project = {},
  testCase = {},
  authProfile = null,
  dataRows = [],
  outputFile = null,
  generatedSpec = null,
  networkPolicy = 'project_default',
  timeoutMs = DEFAULT_TEST_TIMEOUT_MS,
} = {}) {
  const root = path.resolve(workspaceRoot);
  const run = path.resolve(runWorkspace || path.join(root, 'tmp', 'native-runs', slugify(runId, 'run')));
  const policy = buildSandboxPolicy({ workspaceRoot: root, runWorkspace: run, networkPolicy, timeoutMs });
  assertSandboxPolicy(policy);
  const workspace = buildWorkspaceFiles({ project, testCase, authProfile, dataRows, outputFile, generatedSpec });
  for (const rel of Object.keys(workspace.files)) assertSandboxPath(policy, rel, 'workspace_file');
  fs.mkdirSync(run, { recursive: true });
  writeWorkspaceFiles(run, workspace.files);
  return { policy, ...workspace, runWorkspace: run };
}

function resolvePlaywrightCli(policy = {}) {
  const searchRoots = [
    policy.workspaceRoot,
    REPO_ROOT,
    process.cwd(),
  ].filter(Boolean);
  for (const root of searchRoots) {
    const candidates = [
      path.join(root, 'node_modules', 'playwright', 'cli.js'),
      path.join(root, 'node_modules', '@playwright', 'test', 'cli.js'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  try {
    return require.resolve('playwright/cli.js', { paths: searchRoots });
  } catch (_) {
    try {
      return require.resolve('@playwright/test/cli.js', { paths: searchRoots });
    } catch (_) {
      return null;
    }
  }
}

function buildNativeWorkerCommand(policy = {}) {
  assertSandboxPolicy(policy);
  const cli = resolvePlaywrightCli(policy);
  if (!cli) {
    return {
      unavailable: true,
      reason: 'playwright_cli_not_found',
      command: process.execPath,
      args: [],
      cwd: policy.runWorkspace,
    };
  }
  return {
    unavailable: false,
    command: process.execPath,
    args: [cli, 'test', '--config', 'playwright.config.ts', '--reporter=json'],
    cwd: policy.runWorkspace,
  };
}

function parsePlaywrightJson(stdout = '') {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) {}
  const start = raw.lastIndexOf('\n{');
  if (start >= 0) {
    try { return JSON.parse(raw.slice(start + 1)); } catch (_) {}
  }
  return null;
}

function summarizePlaywrightJson(parsed) {
  const suites = Array.isArray(parsed?.suites) ? parsed.suites : [];
  let passed = 0; let failed = 0; let skipped = 0; let total = 0;
  const visitSpecs = (specs = []) => {
    for (const spec of specs) {
      for (const test of Array.isArray(spec.tests) ? spec.tests : []) {
        total += 1;
        const status = test.outcome || test.status || '';
        if (status === 'expected' || status === 'passed') passed += 1;
        else if (status === 'skipped') skipped += 1;
        else failed += 1;
      }
    }
  };
  const walk = (suite) => {
    visitSpecs(suite.specs || []);
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) walk(child);
  };
  suites.forEach(walk);
  return { total, passed, failed, skipped };
}

function collectNativeLaneArtifacts(policy = {}, { maxFiles = 250 } = {}) {
  assertSandboxPolicy(policy);
  const runRoot = path.resolve(policy.runWorkspace);
  const allow = new Set(policy.artifactAllowlist || []);
  const artifacts = [];
  const scan = (dir) => {
    if (artifacts.length >= maxFiles || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(runRoot, full).replace(/\\/g, '/');
      const top = rel.split('/')[0];
      if (!allow.has(top)) continue;
      assertSandboxPath(policy, rel, 'artifact');
      if (entry.isDirectory()) scan(full);
      else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        const type = ext === '.json' ? 'result'
          : ext === '.zip' ? 'trace'
            : /\.(png|jpg|jpeg|webp)$/.test(ext) ? 'screenshot'
              : /\.(webm|mp4)$/.test(ext) ? 'video'
                : 'artifact';
        artifacts.push({ type, relPath: rel, size: fs.statSync(full).size });
      }
    }
  };
  for (const top of allow) scan(path.join(runRoot, top));
  return artifacts;
}

async function runSandboxedNativeTest({
  policy,
  scopedTestEnv = {},
  execFileImpl = cp.execFile,
} = {}) {
  assertSandboxPolicy(policy);
  const command = buildNativeWorkerCommand(policy);
  if (command.unavailable) {
    return {
      status: 'blocked_runner_unavailable',
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: command.reason,
      command,
      artifacts: collectNativeLaneArtifacts(policy),
    };
  }
  const env = buildSandboxEnv({ policy, scopedTestEnv });
  return new Promise((resolve) => {
    execFileImpl(command.command, command.args, {
      cwd: command.cwd,
      env,
      timeout: Number(policy.timeoutMs) || DEFAULT_TEST_TIMEOUT_MS,
      windowsHide: true,
      shell: false,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout = '', stderr = '') => {
      const parsed = parsePlaywrightJson(stdout);
      const summary = summarizePlaywrightJson(parsed);
      const timedOut = !!(error && (error.killed || error.signal || error.code === 'ETIMEDOUT'));
      const exitCode = error && typeof error.code === 'number' ? error.code : 0;
      const status = timedOut
        ? 'timeout'
        : exitCode === 0
          ? 'passed'
          : 'failed';
      resolve({
        status,
        exitCode,
        timedOut,
        stdout: String(stdout || '').slice(0, 10000),
        stderr: String(stderr || '').slice(0, 10000),
        parsedSummary: summary,
        command: { command: command.command, args: command.args, cwd: command.cwd },
        artifacts: collectNativeLaneArtifacts(policy),
      });
    });
  });
}

function buildQaaIImportEnvelope({ policy, workspace = {}, runResult = {}, artifacts = null } = {}) {
  assertSandboxPolicy(policy);
  const relRunWorkspace = path.relative(policy.workspaceRoot, policy.runWorkspace).replace(/\\/g, '/');
  return {
    schema: NATIVE_IMPORT_SCHEMA,
    runtimeMode: RUNTIME_MODE,
    laneStatus: runResult.status || 'not_run',
    certificationStatus: 'preview_not_certified',
    experimental: true,
    reason: runResult.status === 'passed'
      ? 'Native lane execution completed, but certification import has not proven ReplayIR parity yet.'
      : 'Native lane output is experimental until certification import passes.',
    workspace: {
      runWorkspace: relRunWorkspace,
      markdownSpec: workspace.specRel || null,
      generatedTest: workspace.outputRel || null,
      seedFile: workspace.seedRel || null,
    },
    result: {
      exitCode: runResult.exitCode ?? null,
      timedOut: !!runResult.timedOut,
      summary: runResult.parsedSummary || null,
      stdout: runResult.stdout || '',
      stderr: runResult.stderr || '',
    },
    artifacts: artifacts || runResult.artifacts || [],
    sandbox: {
      mode: policy.mode,
      timeoutMs: policy.timeoutMs,
      noPlatformEnv: policy.noPlatformEnv,
      denyEnvPatterns: [...(policy.denyEnvPatterns || [])],
      denyPathFragments: [...(policy.denyPathFragments || [])],
      artifactAllowlist: [...(policy.artifactAllowlist || [])],
      networkPolicy: policy.networkPolicy,
    },
  };
}

module.exports = {
  RUNTIME_MODE,
  DEFAULT_TEST_TIMEOUT_MS,
  DEFAULT_NATIVE_RUN_ROOT,
  NATIVE_IMPORT_SCHEMA,
  NATIVE_MANIFEST_SCHEMA,
  AGENT_FILES,
  slugify,
  buildMarkdownSpec,
  buildSandboxPolicy,
  assertSandboxPolicy,
  envKeyDenied,
  buildSandboxEnv,
  assertSandboxPath,
  validateAgentFiles,
  buildWorkspaceFiles,
  prepareNativeLaneWorkspace,
  resolvePlaywrightCli,
  buildNativeWorkerCommand,
  parsePlaywrightJson,
  summarizePlaywrightJson,
  collectNativeLaneArtifacts,
  runSandboxedNativeTest,
  buildQaaIImportEnvelope,
};
