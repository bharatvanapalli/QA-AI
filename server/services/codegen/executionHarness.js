'use strict';

/**
 * Phase E — Execution Certification Loop.
 *
 * Server-integrated async harness that runs a generated journey spec in a
 * clean environment and certifies it only when the runner verdict matches
 * the original MCP verdict.
 *
 * Design rules:
 *  1. Async subprocess only (never spawnSync) — non-blocking server.
 *  2. In-memory semaphore: at most QAAI_EXEC_CONCURRENCY (default 3)
 *     concurrent Chromium instances.
 *  3. Verdict Inversion kill switch: if MCP said fail but runner passes,
 *     throw VERDICT_INVERSION — this is the worst possible bug.
 *  4. Auth failure short-circuit: if runner output shows a login wall,
 *     return auth_failure — do not attempt evidence repair.
 *  5. Artifact persistence: on failure copy screenshots + trace.zip to
 *     playwright/artifacts/<runId>/<journeySlug>/ BEFORE deleting the
 *     temp dir. Store only the permanent relative paths, never the temp path.
 *  6. Max MAX_REPAIR_ROUNDS repair rounds; after that → not_certified.
 *
 * Pure module — no MCP, no LLM, no DB writes (caller does DB writes).
 */

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const parity = require('./executionParity');

// ── Configuration ─────────────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes per spec
const MAX_REPAIR_ROUNDS = 2;
const ARTIFACTS_BASE = path.join(__dirname, '..', '..', '..', 'playwright', 'artifacts');

// Auth failure pattern: runner output matching this on stdout → auth_failure verdict
const AUTH_FAILURE_RE = /(?:login|authentication|unauthorized|401|403|invalid\s+credentials|please\s+sign\s+in|session\s+expired)/i;

// ── Semaphore ─────────────────────────────────────────────────────────────────

function makeSemaphore(limit) {
  let active = 0;
  const queue = [];
  function release() {
    active--;
    if (queue.length) {
      const next = queue.shift();
      active++;
      next();
    }
  }
  function acquire() {
    if (active < limit) { active++; return Promise.resolve(); }
    return new Promise((res) => queue.push(res));
  }
  return { acquire, release };
}

const execSem = makeSemaphore(parseInt(process.env.QAAI_EXEC_CONCURRENCY || String(DEFAULT_CONCURRENCY), 10));

// ── Package writer ────────────────────────────────────────────────────────────

/**
 * Write a minimal runnable package into a temp dir under server/ so that
 * @playwright/test can be resolved from the server's node_modules.
 */
function writePackage(files) {
  const serverDir = path.join(__dirname, '..', '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '.qaai-exec-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'qaai-exec-harness',
    private: true,
    version: '1.0.0',
    scripts: { test: 'playwright test' },
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'playwright.config.js'), `
module.exports = {
  testDir: './tests',
  timeout: 60000,
  expect: { timeout: 10000 },
  use: { headless: true, viewport: { width: 1280, height: 720 } },
  workers: 1,
  reporter: 'list',
};
`.trim(), 'utf8');

  // Write spec files (tests/ tree + support/)
  for (const [relPath, content] of Object.entries(files || {})) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }

  // Symlink node_modules from the server directory so @playwright/test resolves
  const nmTarget = path.join(serverDir, '..', 'node_modules');
  const nmLink = path.join(dir, 'node_modules');
  try {
    if (!fs.existsSync(nmLink)) {
      fs.symlinkSync(nmTarget, nmLink, 'junction');
    }
  } catch (_) {
    // Windows junction creation may require elevation; fall back to resolving
    // @playwright/test from the server's node_modules directly in the spawn command
  }

  return dir;
}

/**
 * Resolve the Playwright CLI binary from the root node_modules.
 */
function findPlaywrightBin() {
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'playwright'),
    path.join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'playwright.cmd'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'npx playwright'; // last resort
}

// ── Async runner ──────────────────────────────────────────────────────────────

/**
 * Run Playwright tests in a temp dir and return the raw output + verdict.
 * Async, non-blocking. Respects AbortSignal for cancellation.
 */
async function runPlaywrightAsync(dir, env, { timeout = DEFAULT_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve) => {
    const playwrightBin = findPlaywrightBin();
    const [cmd, ...args] = playwrightBin.includes(' ')
      ? playwrightBin.split(' ')
      : [playwrightBin];
    const allArgs = [...args, 'test', '--reporter=list', '--timeout=60000'];

    const child = cp.spawn(cmd, allArgs, {
      cwd: dir,
      env: { ...process.env, ...env, CI: '1', PWTEST_HTML_REPORT_OPEN: 'never' },
      shell: false,
    });

    let out = '';
    child.stdout && child.stdout.on('data', (d) => { out += d; });
    child.stderr && child.stderr.on('data', (d) => { out += d; });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
    }, timeout);

    signal && signal.addEventListener('abort', () => {
      killed = true;
      child.kill('SIGTERM');
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve({ verdict: 'error', exitCode: -1, raw: out, timedOut: true, passed: 0, failed: 0, skipped: 0 });
        return;
      }
      const parsed = parity.parsePlaywrightVerdict(out, code);
      resolve({ ...parsed, exitCode: code ?? 0, raw: out, timedOut: false });
    });
  });
}

// ── Artifact persistence ──────────────────────────────────────────────────────

/**
 * After a Playwright run, copy failure artifacts from the ephemeral temp dir
 * to a permanent location under playwright/artifacts/.
 *
 * Returns an array of { type, path } objects with RELATIVE paths from repo root.
 * Never stores the ephemeral temp dir path — it is deleted after copying.
 */
function persistArtifacts(tempDir, runId, journeySlug) {
  const artifacts = [];
  const destDir = path.join(ARTIFACTS_BASE, runId, journeySlug);
  try {
    const resultsDir = path.join(tempDir, 'test-results');
    if (!fs.existsSync(resultsDir)) return artifacts;
    fs.mkdirSync(destDir, { recursive: true });

    const scanDir = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { scanDir(full); continue; }
        const isArtifact = /\.(png|zip|webm|mp4)$/i.test(entry.name);
        if (!isArtifact) continue;
        const type = /\.png$/i.test(entry.name) ? 'screenshot' : 'trace';
        const destName = `${Date.now()}-${entry.name}`;
        const destFull = path.join(destDir, destName);
        try {
          fs.copyFileSync(full, destFull);
          // Store relative path from repo root
          const relPath = path.relative(
            path.join(__dirname, '..', '..', '..'),
            destFull
          ).replace(/\\/g, '/');
          artifacts.push({ type, path: relPath });
        } catch (_) {}
      }
    };
    scanDir(resultsDir);
  } catch (_) {}
  return artifacts;
}

function cleanTemp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// ── Hash utilities ────────────────────────────────────────────────────────────

function hashFiles(files) {
  const combined = Object.entries(files || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}\n${v}`)
    .join('\n---\n');
  return crypto.createHash('sha256').update(combined).digest('hex');
}

// ── Main certification function ───────────────────────────────────────────────

/**
 * Run a generated journey spec, compare its verdict to the MCP verdict, and
 * return a certification decision.
 *
 * @param {object} p
 * @param {object} p.files            — { [relPath]: content } generated spec files
 * @param {string} p.mcpVerdict       — 'pass' | 'fail' | 'blocked' | 'skipped'
 * @param {string} p.runId            — for artifact directory naming
 * @param {string} p.journeySlug      — for artifact directory naming
 * @param {object} p.credEnv          — { ENV_VAR: value } credential env vars to inject
 * @param {number} p.timeoutMs        — per-run timeout (default 120s)
 * @param {AbortSignal} p.signal      — cancellation signal
 * @param {object} p.parityOptions    — passed to classifyParity (eligible, irHash)
 *
 * @returns {Promise<{
 *   status:        'certified' | 'not_certified' | 'auth_failure' | 'ineligible',
 *   parityMatched: boolean | null,
 *   mcpVerdict:    string,
 *   runnerVerdict: string,
 *   reason:        string,
 *   artifacts:     Array<{type, path}>,
 *   packageHash:   string,
 *   raw:           string,   — runner stdout for debugging
 * }>}
 */
async function runJourneySpec({
  files,
  mcpVerdict,
  runId,
  journeySlug = 'journey',
  credEnv = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  parityOptions = {},
}) {
  const packageHash = hashFiles(files);
  const artifacts = [];

  await execSem.acquire();
  let tempDir = null;
  try {
    tempDir = writePackage(files);

    const runnerResult = await runPlaywrightAsync(tempDir, credEnv, { timeout: timeoutMs, signal });

    // ── Auth failure short-circuit ─────────────────────────────────────────
    // If the runner output matches a login-wall pattern, it's a credential
    // problem — not a locator or code problem. Do not attempt repair.
    if (runnerResult.verdict === 'error' && AUTH_FAILURE_RE.test(runnerResult.raw)) {
      return {
        status: 'auth_failure',
        parityMatched: null,
        mcpVerdict,
        runnerVerdict: runnerResult.verdict,
        reason: 'Auth failure detected in runner output — credential or session issue',
        artifacts: [],
        packageHash,
        raw: runnerResult.raw.slice(0, 2000),
      };
    }

    // ── Verdict Inversion Kill Switch ─────────────────────────────────────
    // A failing MCP run must never produce a passing script. This is the
    // worst possible bug: it launders broken software into green automation.
    if (mcpVerdict === 'fail' && runnerResult.passed > 0 && runnerResult.failed === 0) {
      const msg = `VERDICT_INVERSION: MCP verdict was 'fail' but the generated script passed ${runnerResult.passed} test(s). ` +
        `The app has a bug that the script is hiding. Certification BLOCKED.`;
      return {
        status: 'not_certified',
        parityMatched: false,
        mcpVerdict,
        runnerVerdict: runnerResult.verdict,
        reason: msg,
        artifacts: [],
        packageHash,
        raw: runnerResult.raw.slice(0, 2000),
      };
    }

    // ── Classify parity ───────────────────────────────────────────────────
    const parityResult = parity.classifyParity({
      mcpVerdict,
      runnerVerdict: runnerResult.verdict,
      eligible: parityOptions.eligible !== false,
      runnerReason: runnerResult.failed > 0 ? 'test failures detected' : null,
    });

    if (!parityResult.eligible) {
      return {
        status: 'ineligible',
        parityMatched: null,
        mcpVerdict,
        runnerVerdict: runnerResult.verdict,
        reason: parityResult.reason,
        artifacts: [],
        packageHash,
        raw: runnerResult.raw.slice(0, 2000),
      };
    }

    // On failure: persist artifacts to permanent storage before deleting temp dir
    const hasFailed = runnerResult.failed > 0 || runnerResult.verdict === 'error';
    if (hasFailed && tempDir) {
      const saved = persistArtifacts(tempDir, runId, journeySlug);
      artifacts.push(...saved);
    }

    const status = parityResult.matched ? 'certified' : 'not_certified';

    return {
      status,
      parityMatched: parityResult.matched,
      mcpVerdict,
      runnerVerdict: runnerResult.verdict,
      reason: parityResult.reason,
      artifacts,
      packageHash,
      raw: runnerResult.raw.slice(0, 2000),
    };

  } finally {
    execSem.release();
    if (tempDir) cleanTemp(tempDir);
  }
}

/**
 * Full certification loop with optional evidence-based repair rounds.
 * Calls runJourneySpec up to (1 + MAX_REPAIR_ROUNDS) times.
 *
 * REPAIR CONTRACT (enforced here — do not weaken):
 *   ALLOWED:
 *     - Deterministic evidence repair (Phase D DOM probe)
 *     - Regenerate code from corrected EvidenceBundle
 *     - Deterministic syntax/template fixes
 *   NOT ALLOWED:
 *     - Asking an LLM to "fix" a failing script
 *     - Widening locators to pass (e.g. removing { name: '...' } from getByRole)
 *     - Deleting or weakening assertions
 *     - Converting a fail verdict into green automation
 *
 * @param {object}   p           – same as runJourneySpec plus:
 * @param {Function} p.onRepairNeeded
 *   async ({ failingLocators: string[], currentFiles: object }) => object | null
 *   Called when locator timeouts are detected in runner output. The callback
 *   MUST: repair evidence deterministically (Phase D), regenerate code from the
 *   corrected EvidenceBundle, and return a new { [relPath]: content } map.
 *   Returning null stops the repair loop (e.g. when Phase D needs a live browser
 *   session that is not available in the current context).
 *
 * @returns {Promise<{
 *   finalStatus: string,
 *   parityMatched: boolean | null,
 *   mcpVerdict: string,
 *   runnerVerdict: string,
 *   reason: string,
 *   repairRounds: number,
 *   artifacts: Array,
 *   packageHash: string,
 *   lastRaw: string,
 * }>}
 */
async function certifyJourney({ files, mcpVerdict, runId, journeySlug, credEnv, timeoutMs, signal, parityOptions, onRepairNeeded }) {
  let currentFiles = files;
  let repairRounds = 0;
  let lastResult = null;

  for (let attempt = 0; attempt <= MAX_REPAIR_ROUNDS; attempt++) {
    lastResult = await runJourneySpec({
      files: currentFiles,
      mcpVerdict,
      runId,
      journeySlug,
      credEnv,
      timeoutMs,
      signal,
      parityOptions,
    });

    if (lastResult.status === 'certified' || lastResult.status === 'auth_failure' || lastResult.status === 'ineligible') {
      break;
    }

    // Not certified — attempt evidence-based repair if the caller provided a handler.
    // The handler MUST repair evidence + regenerate; direct code patching is forbidden.
    if (attempt < MAX_REPAIR_ROUNDS && typeof onRepairNeeded === 'function') {
      const failingLocators = extractFailingLocators(lastResult.raw);
      if (failingLocators.length) {
        try {
          const repairedFiles = await onRepairNeeded({ failingLocators, currentFiles });
          if (repairedFiles && typeof repairedFiles === 'object') {
            currentFiles = repairedFiles;
            repairRounds++;
            continue;
          }
        } catch (_) {}
      }
    }
    break;
  }

  return {
    finalStatus: lastResult ? lastResult.status : 'not_certified',
    parityMatched: lastResult ? lastResult.parityMatched : false,
    mcpVerdict: lastResult ? lastResult.mcpVerdict : mcpVerdict,
    runnerVerdict: lastResult ? lastResult.runnerVerdict : 'error',
    reason: lastResult ? lastResult.reason : 'no result',
    repairRounds,
    artifacts: lastResult ? lastResult.artifacts : [],
    packageHash: lastResult ? lastResult.packageHash : null,
    lastRaw: lastResult ? lastResult.raw : '',
  };
}

/**
 * Extract Playwright locator timeout failure expressions from runner output.
 * e.g. "Error: Timed out waiting for getByRole('button', { name: 'Save' })"
 * Returns unique locator expressions that timed out.
 */
function extractFailingLocators(rawOutput) {
  const locators = new Set();
  const TIMEOUT_RE = /(?:Locator\.(?:click|fill|check|waitFor)|waiting for)[^\n]*?((?:getBy\w+|locator)\([^)]+(?:\([^)]*\)[^)]*)*\))/g;
  let m;
  while ((m = TIMEOUT_RE.exec(rawOutput)) !== null) {
    locators.add(m[1].trim());
  }
  return [...locators];
}

module.exports = {
  runJourneySpec,
  certifyJourney,
  writePackage,
  extractFailingLocators,
  persistArtifacts,
  hashFiles,
  MAX_REPAIR_ROUNDS,
};
