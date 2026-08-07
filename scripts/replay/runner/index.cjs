'use strict';

/**
 * Replay-harness runner (Stage 2).
 *
 * Pure-Node CLI. Iterates a pinned corpus of runIds (from
 * scripts/replay/corpus/baseline.json) and executes a set of checks against
 * each. Emits a per-run / per-check matrix + aggregate counts; exits non-zero
 * if any registered check failed against any run in the corpus.
 *
 * Per the CLAUDE.md cost-claim discipline: every cost claim ("X cuts tokens
 * by Y%") must be backed by a candidate-vs-baseline replay over this corpus.
 * The harness is the gate; without it, claims are folklore.
 *
 * Usage:
 *   node scripts/replay/runner/index.cjs                       # run all checks
 *   node scripts/replay/runner/index.cjs --check=step-verdict  # filter by check
 *   node scripts/replay/runner/index.cjs --filter=mixed-pass-fail
 *                                                              # filter by classification
 *   node scripts/replay/runner/index.cjs --runIds=ID1,ID2      # ad-hoc list, bypass corpus
 *   node scripts/replay/runner/index.cjs --json                # machine-readable
 *
 * Exit codes
 *   0 = every check passed against every targeted run
 *   1 = at least one check returned non-zero against at least one run
 *   2 = harness itself failed (corpus missing, check threw, etc.)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CHECKS_DIR = path.join(__dirname, '..', 'checks');
const CORPUS_PATH = path.join(__dirname, '..', 'corpus', 'baseline.json');

// ─── Registered checks ────────────────────────────────────────────────
// Each check is a (name, file, runIdMode) tuple. runIdMode:
//   'arg'      : check accepts the runId as a positional CLI arg
//   'env'      : check reads runId from process.env.QAAI_REPLAY_RUNID
//   'standalone': check operates on the whole DB / doesn't take a runId
//
// To add a check: drop a .cjs into scripts/replay/checks/ and register it
// here. Order of entries determines display order in the matrix.
const REGISTERED_CHECKS = [
  {
    name: 'step-verdict-emissions',
    file: 'step-verdict-emissions.cjs',
    runIdMode: 'arg',
    description: 'Strict-parser gap detection for STEP_VERDICT markers.',
  },
  {
    name: 'f32-dedupe-still-needed',
    file: 'f32-dedupe-still-needed.cjs',
    runIdMode: 'arg',
    description: 'Verifies F.3.2 dedupe-by-latest is still required by the fixture.',
  },
  {
    name: 'assertion-gate-would-reject-rate',
    file: 'assertion-gate-would-reject-rate.cjs',
    runIdMode: 'standalone',
    description: 'Soft-fail assertion-gate would-reject rate across all RunResult rows.',
  },
  {
    name: 'url-extract-smoke',
    file: 'url-extract-smoke.cjs',
    runIdMode: 'standalone',
    description: 'URL-extraction smoke test against canned snapshots.',
  },
];

function parseArgs(argv) {
  const args = { checkFilter: null, classFilter: null, runIds: null, json: false, help: false };
  for (const a of argv.slice(2)) {
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--json') args.json = true;
    else if (a.startsWith('--check=')) args.checkFilter = a.slice(8);
    else if (a.startsWith('--filter=')) args.classFilter = a.slice(9);
    else if (a.startsWith('--runIds=')) args.runIds = a.slice(9).split(',').filter(Boolean);
  }
  return args;
}

function loadCorpus() {
  if (!fs.existsSync(CORPUS_PATH)) {
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
    if (!Array.isArray(raw.runs)) return null;
    return raw;
  } catch (err) {
    console.error(`[runner] failed to parse corpus at ${CORPUS_PATH}:`, err.message);
    return null;
  }
}

function runCheck(check, runId) {
  const filePath = path.join(CHECKS_DIR, check.file);
  if (!fs.existsSync(filePath)) {
    return { exitCode: -1, stdout: '', stderr: `check file missing: ${filePath}` };
  }
  const args = [filePath];
  const env = { ...process.env };
  if (check.runIdMode === 'arg' && runId) args.push(runId);
  else if (check.runIdMode === 'env' && runId) env.QAAI_REPLAY_RUNID = runId;

  const result = spawnSync('node', args, { env, encoding: 'utf8', timeout: 60_000 });
  return {
    exitCode: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    timedOut: result.signal === 'SIGTERM',
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').match(/Usage:[\s\S]*?Exit codes[\s\S]*?(?=\*\/)/)?.[0] || '');
    return process.exit(0);
  }

  const corpus = loadCorpus();
  let targets;
  if (args.runIds) {
    targets = args.runIds.map((id) => ({ runId: id, classification: 'ad-hoc' }));
  } else if (!corpus) {
    console.error(`[runner] No corpus at ${CORPUS_PATH}. Capture it with:\n  node scripts/replay/corpus/capture.cjs`);
    return process.exit(2);
  } else {
    targets = corpus.runs;
  }
  if (args.classFilter) {
    targets = targets.filter((t) => t.classification === args.classFilter);
  }

  const checks = REGISTERED_CHECKS.filter((c) => !args.checkFilter || c.name === args.checkFilter);
  if (checks.length === 0) {
    console.error(`[runner] No check matched filter "${args.checkFilter}". Registered:`,
      REGISTERED_CHECKS.map((c) => c.name).join(', '));
    return process.exit(2);
  }
  if (targets.length === 0) {
    console.error(`[runner] No targets after filter "${args.classFilter || '(none)'}".`);
    return process.exit(2);
  }

  const matrix = [];
  for (const check of checks) {
    if (check.runIdMode === 'standalone') {
      const r = runCheck(check, null);
      matrix.push({ check: check.name, runId: '(standalone)', exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr });
    } else {
      for (const t of targets) {
        const r = runCheck(check, t.runId);
        matrix.push({
          check: check.name, runId: t.runId, classification: t.classification,
          exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr,
        });
      }
    }
  }

  // Aggregate
  const aggregate = { total: matrix.length, pass: 0, fail: 0, error: 0 };
  for (const row of matrix) {
    if (row.exitCode === 0) aggregate.pass += 1;
    else if (row.exitCode > 0) aggregate.fail += 1;
    else aggregate.error += 1;
  }

  if (args.json) {
    console.log(JSON.stringify({ aggregate, matrix }, null, 2));
  } else {
    console.log('─'.repeat(80));
    for (const row of matrix) {
      const status = row.exitCode === 0 ? 'PASS' : row.exitCode > 0 ? 'FAIL' : 'ERR ';
      const tag = row.classification ? ` [${row.classification}]` : '';
      console.log(`${status}  ${row.check}  ${row.runId.slice(0, 8)}${tag}`);
      if (row.exitCode !== 0 && row.stderr) {
        const head = row.stderr.split('\n').slice(0, 5).join('\n  ');
        console.log(`      ${head}`);
      }
    }
    console.log('─'.repeat(80));
    console.log(`Total: ${aggregate.total}  Pass: ${aggregate.pass}  Fail: ${aggregate.fail}  Err: ${aggregate.error}`);
  }

  process.exit(aggregate.fail > 0 || aggregate.error > 0 ? 1 : 0);
}

main();
