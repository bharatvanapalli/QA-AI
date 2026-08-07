'use strict';
/**
 * Enterprise Mode P8 — clean-env EXECUTION parity (the gate P7 deliberately did NOT claim).
 * P7 proved a package GENERATES + COMPILES/COLLECTS. P8 proves it RUNS and that the runner's
 * verdict matches the MCP verdict that produced the ReplayIR.
 *
 * This module is the PURE, deterministic core (no DB, no spawn, no browser) so the guard can
 * pin every rule:
 *   classifyParity()    — runner-verdict vs MCP-verdict, with the never-green + not-eligible rules
 *   resolveSafeEnv()    — exec values come ONLY from approved refs (operator env / vault), NEVER
 *                         from Excel/test-data literals or the generated files; missing → eligible:false
 *   parsePlaywrightVerdict() / parseSurefireVerdict() — runner stdout → a normalized verdict
 *
 * The spawn/clean-temp-dir/report-writing lives in the harness (scripts/_smoke_p8_parity.cjs),
 * which feeds real output through these functions.
 *
 * Hard rules (user, P8):
 *  - pass MCP → must execute pass.
 *  - fail MCP → must execute fail (same assertion reason captured in the report).
 *  - blocked/needs_human/skipped → must execute as skipped/disabled/not-run, NEVER green.
 *  - unsupported channels (Selenium throwing stubs / no faithful oracle) → NOT parity-eligible,
 *    NEVER counted as failed product behaviour.
 *  - exec env values come from approved refs only — never Excel literals, never credentials in files.
 */

// Verdicts the runner can resolve to (normalized across frameworks).
const RUNNER_VERDICTS = new Set(['pass', 'fail', 'skipped', 'disabled', 'not_run', 'error', 'unsupported']);
// MCP verdicts that must NEVER execute green.
const NEVER_GREEN = new Set(['blocked', 'needs_human', 'skipped']);
// Runner outcomes that count as "did not report a green pass" (the safe side for never-green).
const NON_GREEN_RUNNER = new Set(['skipped', 'disabled', 'not_run', 'error']);

// A secret-keyed valueRef must resolve via an approved ref, never a raw literal.
const SAFE_REF_RE = /^(env|vault|fixture|masked):/i;

/**
 * PURE. Compare the runner's executed verdict to the MCP verdict.
 * eligible=false (e.g. an unsupported assert channel, or a required approved value was missing)
 * → the case is NOT parity-eligible; it is NEVER scored as a product fail.
 * Returns { matched: true|false|null, eligible, reason }. matched=null ⇔ not eligible.
 */
function classifyParity({ mcpVerdict, runnerVerdict, eligible = true, runnerReason = null }) {
  if (!eligible) {
    return { matched: null, eligible: false, reason: runnerReason || 'not parity-eligible (unsupported channel / no faithful oracle / approved value unavailable)' };
  }
  if (runnerVerdict === 'unsupported') {
    return { matched: null, eligible: false, reason: 'runner reported unsupported (throwing stub) — not parity-eligible' };
  }
  if (mcpVerdict === 'pass') {
    return { matched: runnerVerdict === 'pass', eligible: true, reason: runnerVerdict === 'pass' ? 'pass executed pass' : `expected pass, runner=${runnerVerdict}${runnerReason ? ' — ' + runnerReason : ''}` };
  }
  if (mcpVerdict === 'fail') {
    return { matched: runnerVerdict === 'fail', eligible: true, reason: runnerVerdict === 'fail' ? `fail executed fail${runnerReason ? ' — ' + runnerReason : ''}` : `expected fail, runner=${runnerVerdict} (a fail that no longer fails is a parity violation)` };
  }
  if (NEVER_GREEN.has(mcpVerdict)) {
    if (runnerVerdict === 'pass') {
      return { matched: false, eligible: true, reason: `VIOLATION: ${mcpVerdict} executed as a GREEN PASS — must never report green` };
    }
    const preserved = NON_GREEN_RUNNER.has(runnerVerdict);
    return { matched: preserved, eligible: true, reason: preserved ? `${mcpVerdict} preserved as ${runnerVerdict} (not green)` : `expected ${mcpVerdict}→skipped/disabled, runner=${runnerVerdict}` };
  }
  return { matched: false, eligible: true, reason: `unknown MCP verdict '${mcpVerdict}'` };
}

/**
 * PURE. Resolve the env var NAMES a package declares to VALUES from approved sources only.
 *  sources.env      — operator/process environment (the `env:NAME` approved ref).
 *  sources.secrets  — an operator-controlled approved secrets map (vault-like), keyed by NAME.
 * NEVER reads from generated files or Excel/test-data literals. A name with no approved value is
 * returned in `missing` (the caller marks that result eligible:false rather than inventing a value).
 * Returns { resolved:{NAME:value}, missing:[NAME], sources:{NAME:'env'|'secrets'} } — values NOT logged.
 */
function resolveSafeEnv(names, { env = {}, secrets = {} } = {}) {
  const resolved = {};
  const sources = {};
  const missing = [];
  for (const name of names || []) {
    if (env[name] != null && String(env[name]).length) { resolved[name] = String(env[name]); sources[name] = 'env'; }
    else if (secrets[name] != null && String(secrets[name]).length) { resolved[name] = String(secrets[name]); sources[name] = 'secrets'; }
    else missing.push(name);
  }
  return { resolved, missing, sources };
}

/** PURE. Guard against a literal slipping into the injected env (defense in depth). A value that
 * equals a known-banned credential, or a secret-keyed NAME whose value looks like an Excel literal
 * rather than coming from an approved source, is rejected. Returns findings[] (empty = clean). */
function auditInjectedEnv(resolved, sources, denyLiterals = []) {
  const findings = [];
  for (const [name, value] of Object.entries(resolved || {})) {
    for (const lit of denyLiterals) {
      if (lit && value === lit) findings.push({ rule: 'banned_literal_injected', name, message: `Injected env ${name} equals a banned literal.` });
    }
    if (sources && sources[name] && !['env', 'secrets', 'project'].includes(sources[name])) {
      findings.push({ rule: 'unapproved_env_source', name, message: `Injected env ${name} came from a non-approved source '${sources[name]}'.` });
    }
  }
  return findings;
}

function isSafeRef(ref) { return SAFE_REF_RE.test(String(ref || '').trim()); }

/** PURE. Playwright `test` stdout/exit → normalized verdict. */
function parsePlaywrightVerdict(output, exitCode) {
  const text = String(output || '');
  if (/No tests found/i.test(text)) {
    return { verdict: 'not_run', passed: 0, failed: 0, skipped: 0, flaky: 0 };
  }
  const num = (re) => { const m = text.match(re); return m ? Number(m[1]) : 0; };
  const passed = num(/(\d+)\s+passed/i);
  const failed = num(/(\d+)\s+failed/i);
  const skipped = num(/(\d+)\s+skipped/i);
  const flaky = num(/(\d+)\s+flaky/i);
  const didnotrun = num(/(\d+)\s+did not run/i);
  let verdict;
  if (failed > 0 || flaky > 0) verdict = 'fail';
  else if (passed > 0) verdict = 'pass';
  else if (skipped > 0 || didnotrun > 0) verdict = 'skipped';
  else verdict = exitCode === 0 ? 'pass' : 'error';
  // exit!=0 but nothing parsed as failed → an infra/collection error, not a product fail.
  if (exitCode !== 0 && failed === 0 && flaky === 0 && passed === 0 && skipped === 0) verdict = 'error';
  return { verdict, passed, failed, skipped, flaky };
}

/** PURE. Maven surefire (TestNG) stdout/exit → normalized verdict. Takes the LAST totals line
 * (the build summary). A disabled @Test → "Tests run: 0" → not_run (never green). */
function parseSurefireVerdict(output, exitCode) {
  const text = String(output || '');
  const matches = [...text.matchAll(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/gi)];
  const last = matches.length ? matches[matches.length - 1] : null;
  const run = last ? Number(last[1]) : 0;
  const failures = last ? Number(last[2]) : 0;
  const errors = last ? Number(last[3]) : 0;
  const skipped = last ? Number(last[4]) : 0;
  const buildFailure = /BUILD FAILURE/i.test(text);
  let verdict;
  if (failures > 0) verdict = 'fail';
  else if (errors > 0) verdict = buildFailure && run === 0 ? 'error' : 'fail';
  else if (run === 0) verdict = 'not_run'; // disabled / nothing executed
  else if (skipped >= run) verdict = 'skipped';
  else verdict = 'pass';
  if (!last && exitCode !== 0) verdict = 'error'; // compile/infra failure before any test ran
  return { verdict, run, failures, errors, skipped };
}

/** PURE. One parity report row (the user's schema + provenance/eligible). */
function buildParityEntry({ runResultId, framework, mcpVerdict, runnerVerdict, eligible, runnerReason, provenance, logsPath, artifacts, failingAssertion, irHash }) {
  const c = classifyParity({ mcpVerdict, runnerVerdict, eligible, runnerReason });
  return {
    runResultId,
    framework,
    irHash: irHash || null,
    mcpVerdict,
    runnerVerdict,
    matched: c.matched,
    eligible: c.eligible,
    reason: c.reason,
    failingAssertion: failingAssertion || null,
    provenance: provenance || 'real',
    logs: logsPath || null,
    artifacts: artifacts || [],
  };
}

module.exports = {
  RUNNER_VERDICTS, NEVER_GREEN, NON_GREEN_RUNNER,
  classifyParity, resolveSafeEnv, auditInjectedEnv, isSafeRef,
  parsePlaywrightVerdict, parseSurefireVerdict, buildParityEntry,
};
