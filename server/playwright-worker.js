/**
 * playwright-worker.js
 * Spawns real Playwright test runs, streams stdout/stderr over WebSocket,
 * parses actual results, and returns real artifacts (screenshots, video, traces).
 */

'use strict';

const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');
const { EventEmitter } = require('events');

const PLAYWRIGHT_DIR  = path.join(__dirname, '..', 'playwright');
const RESULTS_DIR     = path.join(PLAYWRIGHT_DIR, 'results');
const CONFIG_PATH     = path.join(PLAYWRIGHT_DIR, 'playwright.config.js');

// Ensure output directories exist
fs.mkdirSync(RESULTS_DIR,                             { recursive: true });
fs.mkdirSync(path.join(PLAYWRIGHT_DIR, 'tests'),      { recursive: true });
fs.mkdirSync(path.join(PLAYWRIGHT_DIR, 'test-results'), { recursive: true });

/**
 * Parse a single line of Playwright JSON reporter output.
 * Playwright --reporter=json writes the full report at end, but
 * --reporter=line writes human-readable progress to stdout.
 * We use both: line reporter for streaming + JSON for final results.
 */
function parsePlaywrightLine(line) {
  // Patterns from Playwright's line reporter
  if (line.match(/✓|passed/i))   return { type: 'pass',    line };
  if (line.match(/✗|failed/i))   return { type: 'fail',    line };
  if (line.match(/°|skipped/i))  return { type: 'skipped', line };
  if (line.match(/running|►/i))  return { type: 'running', line };
  if (line.match(/error:/i))     return { type: 'error',   line };
  return { type: 'log', line };
}

/**
 * Parse the final JSON report written by Playwright's JSON reporter.
 * @param {string} reportPath
 * @returns {object} { results: {[testId]: {status,duration,error,attachments}}, summary }
 */
function parseJsonReport(reportPath, testCaseMap) {
  if (!fs.existsSync(reportPath)) return null;

  try {
    const raw    = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const parsed = { results: {}, summary: { passed: 0, failed: 0, skipped: 0, blocked: 0 } };

    for (const suite of (raw.suites || [])) {
      for (const spec of (suite.specs || [])) {
        for (const test of (spec.tests || [])) {
          const status   = test.results?.[0]?.status;          // passed|failed|timedOut|skipped
          const duration = test.results?.[0]?.duration || 0;   // ms
          const errors   = test.results?.[0]?.errors || [];

          // Map Playwright spec title back to testCase id
          // Our spec files are named by testCase.id
          const specFile = spec.file || '';
          const tcId     = Object.keys(testCaseMap).find(id =>
            specFile.includes(id.replace(/[^a-zA-Z0-9_-]/g, '_'))
          ) || spec.title;

          // Playwright result statuses we care about:
          //   passed   → pass
          //   failed   → fail (test ran, assertion fired)
          //   timedOut → fail (treat as a real failure, not skipped)
          //   skipped  → skipped (test.skip / --grep deselection — engineer's choice)
          //   interrupted / anything else → blocked (environmental, run did not
          //                                          conclude its assertions)
          const normalised =
            status === 'passed'   ? 'pass' :
            status === 'failed'   ? 'fail' :
            status === 'timedOut' ? 'fail' :
            status === 'skipped'  ? 'skipped' :
            'blocked';

          if (normalised === 'pass')         parsed.summary.passed++;
          else if (normalised === 'fail')    parsed.summary.failed++;
          else if (normalised === 'skipped') parsed.summary.skipped++;
          else                                parsed.summary.blocked++;

          // Find screenshot attachments
          const attachments = test.results?.[0]?.attachments || [];
          const screenshots = attachments.filter(a => a.contentType?.includes('image')).map(a => a.path);
          const videos      = attachments.filter(a => a.contentType?.includes('video')).map(a => a.path);
          const traces      = attachments.filter(a => a.name === 'trace').map(a => a.path);

          parsed.results[tcId] = {
            status:    normalised,
            time:      `${(duration / 1000).toFixed(1)}s`,
            // Pass raw ms through so downstream consumers don't reparse the
            // formatted "1.2s" string back to a number — that round-trip
            // silently collapsed near-zero durations to null
            // (parseFloat('0.0') * 1000 = 0; `0 || null` = null).
            durationMs: Math.round(duration),
            error:     errors.map(e => e.message).join('\n').slice(0, 500),
            screenshots,
            video:     videos[0] || null,
            trace:     traces[0] || null,
            raw:       test,
          };
        }
      }
    }

    return parsed;
  } catch (err) {
    return null;
  }
}

/**
 * Run Playwright tests and stream output over the broadcast function.
 *
 * @param {object}   opts
 * @param {string[]} opts.specFiles      - Array of absolute paths to .spec.ts files
 * @param {object}   opts.testCaseMap    - { [tcId]: testCase }
 * @param {function} opts.broadcast      - ws broadcast function (data: object) => void
 * @param {string}   opts.runId          - Unique run identifier
 * @returns {Promise<{results, summary}>}
 */
function runPlaywright({ specFiles, testCaseMap, broadcast, runId }) {
  return new Promise((resolve, reject) => {
    const jsonReportPath = path.join(PLAYWRIGHT_DIR, `report-${runId}.json`);

    // Build npx playwright test command
    // --config  = our playwright.config.js
    // --reporter = line (streaming) + json (final results)
    // --output   = screenshots/video directory
    const args = [
      'playwright', 'test',
      '--config', CONFIG_PATH,
      `--reporter=line,json`,
      `--output=${path.join(PLAYWRIGHT_DIR, 'test-results')}`,
    ];

    // Run only specific spec files for this run
    args.push(...specFiles);

    const env = {
      ...process.env,
      PLAYWRIGHT_JSON_OUTPUT_NAME: jsonReportPath,
      // Disable colour codes so we can parse cleanly
      FORCE_COLOR: '0',
    };

    broadcast({ type: 'log', message: `▶  npx ${args.join(' ')}` });

    const child = spawn('npx', args, {
      cwd:   PLAYWRIGHT_DIR,
      env,
      shell: true,   // required on Windows
    });

    // Stream stdout line by line
    let stdoutBuf = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf   = lines.pop(); // keep incomplete last line

      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (!line) continue;

        broadcast({ type: 'log', message: line });

        // Detect per-test status from line reporter output
        const parsed = parsePlaywrightLine(line);
        if (parsed.type === 'pass' || parsed.type === 'fail' || parsed.type === 'error') {
          // Try to extract test name from line
          broadcast({ type: 'playwright_line', status: parsed.type, line });
        }
      }
    });

    // Stream stderr too (Playwright writes some progress there)
    child.stderr.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) broadcast({ type: 'log', message: `  ${line.trimEnd()}` });
      }
    });

    child.on('error', (err) => {
      broadcast({ type: 'log', message: `ERROR: ${err.message}` });
      reject(err);
    });

    child.on('close', (code) => {
      // Flush remaining stdout
      if (stdoutBuf.trim()) broadcast({ type: 'log', message: stdoutBuf.trim() });

      broadcast({ type: 'log', message: `Playwright process exited with code ${code}` });

      // Parse the JSON report for structured results
      const report = parseJsonReport(jsonReportPath, testCaseMap);

      if (report) {
        // Emit individual results
        for (const [tcId, result] of Object.entries(report.results)) {
          broadcast({ type: 'result', tcId, ...result });
        }

        broadcast({
          type:    'complete',
          runId,
          summary: report.summary,
        });

        resolve(report);
      } else {
        // No JSON report — derive results from exit code
        const fallback = deriveFallbackResults(testCaseMap, code);
        for (const [tcId, result] of Object.entries(fallback.results)) {
          broadcast({ type: 'result', tcId, ...result });
        }
        broadcast({ type: 'complete', runId, summary: fallback.summary });
        resolve(fallback);
      }

      // Cleanup JSON report file
      try { if (fs.existsSync(jsonReportPath)) fs.unlinkSync(jsonReportPath); } catch (_) {}
    });
  });
}

/**
 * Playwright ran but the JSON report file is missing (process killed,
 * disk error, --reporter misconfigured, premature exit). We have no idea
 * which tests actually passed or failed — DO NOT invent results. Mark
 * every test as `blocked` with a clear error so the release-recommendation
 * engine and the user both treat the run as inconclusive.
 *
 * Previous behaviour synthesised pass/fail from tc.confidence, which let
 * an LLM's confidence score drive the GO/NO-GO decision — the single
 * most dangerous integrity bug in the system.
 */
function deriveFallbackResults(testCaseMap, exitCode) {
  const results = {};
  const errMsg = exitCode === 0
    ? 'Playwright exited cleanly but produced no JSON report — results are inconclusive.'
    : `Playwright exited with code ${exitCode} and produced no JSON report — results are inconclusive.`;

  let blocked = 0;
  for (const [id] of Object.entries(testCaseMap)) {
    results[id] = {
      status:      'blocked',
      time:        '?',
      durationMs:  null,
      error:       errMsg,
      blockedReason: 'no_report',
      screenshots: [],
      video:       null,
      trace:       null,
    };
    blocked += 1;
  }

  return { results, summary: { passed: 0, failed: 0, skipped: 0, blocked } };
}

/**
 * List screenshot files for a given test ID.
 */
function getArtifacts(tcId) {
  const resultsDir = path.join(PLAYWRIGHT_DIR, 'test-results');
  if (!fs.existsSync(resultsDir)) return { screenshots: [], video: null };

  const safeId      = tcId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const screenshots = [];
  let video         = null;

  try {
    // Walk test-results dir looking for files containing this test id
    const dirs = fs.readdirSync(resultsDir);
    for (const d of dirs) {
      if (!d.includes(safeId)) continue;
      const full = path.join(resultsDir, d);
      if (!fs.statSync(full).isDirectory()) continue;
      const files = fs.readdirSync(full);
      for (const f of files) {
        if (f.endsWith('.png'))  screenshots.push(path.join(full, f));
        if (f.endsWith('.webm')) video = path.join(full, f);
      }
    }
  } catch (_) {}

  return { screenshots, video };
}

module.exports = { runPlaywright, getArtifacts, PLAYWRIGHT_DIR, RESULTS_DIR };
