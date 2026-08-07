'use strict';

/**
 * Per-turn telemetry recorder — Phase H Stage 0.5.
 *
 * Captures the rich, uncapped per-turn record the Stage 2 replay harness
 * will consume. Existing `RunResult.trace` (the flat `▶ tool(args) ✓`
 * one-liner stream) is too thin to verify agent-loop variants against —
 * any prompt change can land the same flat trace while producing a
 * completely different tool-use sequence. The harness needs the full
 * Claude response content, every snapshot the agent saw, and per-turn
 * token/timing accounting.
 *
 * Storage shape:
 *   playwright/telemetry/<runId>/<runResultId>.json.gz
 *
 *   {
 *     schemaVersion: 1,
 *     runId, runResultId, testCaseName, framework, execMode,
 *     startedAt, completedAt, totalElapsedMs,
 *     stabilityCapHits, stabilityDowngraded,
 *     turns: [
 *       {
 *         index, startedAt, elapsedMs, stopReason,
 *         usage: { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens },
 *         assistantText: '...',          // verbatim
 *         toolUses: [{ id, name, input }],
 *         toolResults: [{ id, name, input, ok, isError, elapsedMs,
 *                         snapshotText, snapshotBytes,
 *                         stability: { iterations, capped, elapsedMs } | null,
 *                         errorPreview }],
 *       }
 *     ]
 *   }
 *
 * Lifecycle:
 *   - conductor.runOneCase creates a recorder at the top of the case
 *     and attaches it to the MCP session as `session.telemetry`.
 *   - mcp.callTool checks `session.telemetry` opportunistically; absent
 *     telemetry means no-op (harness-disabled paths still work).
 *   - At case completion the recorder flushes to disk and the conductor
 *     stores the path on RunResult.richTraceFile.
 *
 * Failure policy: this is observation-only. No path through this module
 * may throw to the caller — telemetry capture or write failures degrade
 * silently with a debug log. We never want a telemetry bug to fail a
 * test case.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SCHEMA_VERSION = 1;

// Cap snapshot text in telemetry too — uncapped is "uncapped versus the
// 800-char Conductor trail limit", not "literally unbounded". A maliciously
// huge page should not be able to fill the disk via this path. 256 KB per
// snapshot is generous (typical SaaS dashboards land 20-60 KB) and matches
// what the replay harness will actually need.
const SNAPSHOT_CAP_BYTES = 256 * 1024;

function safeSlice(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) : s;
}

function captureUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    inputTokens: usage.input_tokens ?? null,
    outputTokens: usage.output_tokens ?? null,
    cacheReadTokens: usage.cache_read_input_tokens ?? null,
    cacheCreateTokens: usage.cache_creation_input_tokens ?? null,
  };
}

function captureContent(content) {
  if (!Array.isArray(content)) return { assistantText: '', toolUses: [] };
  const textParts = [];
  const toolUses = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      textParts.push(b.text);
    } else if (b.type === 'tool_use') {
      toolUses.push({ id: b.id, name: b.name, input: b.input });
    }
  }
  return { assistantText: textParts.join('\n'), toolUses };
}

function create({ runId, runResultId, testCaseName, framework, execMode }) {
  const record = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    runResultId,
    testCaseName: testCaseName || null,
    framework: framework || null,
    execMode: execMode || null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    totalElapsedMs: null,
    stabilityCapHits: 0,
    stabilityDowngraded: false,
    // Phase H Stage 1.2 — assertion_check polling telemetry.
    // assertionPolls is an array of one entry per assertion_check call:
    //   { attempts, elapsedMs, capped }
    // Aggregated summary fields (capHits, downgraded) make later analysis
    // O(1); the array supports per-call attribution when something looks off.
    assertionPolls: [],
    assertionPollCapHits: 0,
    assertionPollDowngraded: false,
    turns: [],
  };
  let currentTurn = null;
  const startedAtMs = Date.now();

  return {
    /** Begin a turn. Returns the turn index. */
    startTurn() {
      currentTurn = {
        index: record.turns.length,
        startedAt: new Date().toISOString(),
        startedAtMs: Date.now(),
        elapsedMs: null,
        stopReason: null,
        usage: null,
        assistantText: '',
        toolUses: [],
        toolResults: [],
      };
      record.turns.push(currentTurn);
      return currentTurn.index;
    },

    /** Finalise a turn with the Claude response. */
    completeTurn({ usage, content, stopReason } = {}) {
      if (!currentTurn) return;
      currentTurn.elapsedMs = Date.now() - currentTurn.startedAtMs;
      currentTurn.stopReason = stopReason || null;
      currentTurn.usage = captureUsage(usage);
      const { assistantText, toolUses } = captureContent(content);
      currentTurn.assistantText = safeSlice(assistantText, 32 * 1024);
      currentTurn.toolUses = toolUses;
      delete currentTurn.startedAtMs;
    },

    /** Record a single tool call result (called from mcp.callTool). */
    recordTool({ tool, input, ok, isError, elapsedMs, snapshotText, domFacts, stability, errorPreview, pageUrlBefore, pageUrlAfter }) {
      if (!currentTurn) return;
      const snap = safeSlice(snapshotText || '', SNAPSHOT_CAP_BYTES);
      currentTurn.toolResults.push({
        name: tool,
        input: input || null,
        ok: ok === true,
        isError: isError === true,
        elapsedMs: typeof elapsedMs === 'number' ? elapsedMs : null,
        pageUrlBefore: pageUrlBefore || null,
        pageUrlAfter: pageUrlAfter || null,
        domFacts: domFacts || null,
        snapshotText: snap,
        snapshotBytes: snap.length,
        stability: stability || null,
        errorPreview: safeSlice(errorPreview || '', 600),
      });
    },

    /** Attach conductor-side evidence that is only known after mcp.callTool returns. */
    annotateLastToolResult(patch = {}) {
      if (!currentTurn || !currentTurn.toolResults.length || !patch || typeof patch !== 'object') return;
      const last = currentTurn.toolResults[currentTurn.toolResults.length - 1];
      if (patch.actionLocator) last.actionLocator = patch.actionLocator;
      if (patch.codegenLocator) last.codegenLocator = patch.codegenLocator;
      if (Array.isArray(patch.fieldCodegenLocators)) last.fieldCodegenLocators = patch.fieldCodegenLocators;
      if (Array.isArray(patch.fieldLocatorDiagnostics)) last.fieldLocatorDiagnostics = patch.fieldLocatorDiagnostics;
      if (patch.locatorDiagnostic) last.locatorDiagnostic = patch.locatorDiagnostic;
      if (patch.actionLocatorGap) last.actionLocatorGap = patch.actionLocatorGap;
      if (patch.actionLocatorKernel) last.actionLocatorKernel = patch.actionLocatorKernel;
      if (patch.stepAuthoring) last.stepAuthoring = patch.stepAuthoring;
      if (patch.locatorRecipe) last.locatorRecipe = patch.locatorRecipe;
      if (patch.transitionProof) last.transitionProof = patch.transitionProof;
    },

    /** Count a stability cap-hit (stabilization didn't settle in budget). */
    noteStabilityCapHit() {
      record.stabilityCapHits += 1;
    },

    /** Mark the case as having downgraded out of stability checks. */
    noteStabilityDowngraded() {
      record.stabilityDowngraded = true;
    },

    /**
     * Record an assertion_check poll. Called from mcp.checkAssertion after
     * every assertion check, whether matched-on-attempt-N or capped.
     */
    noteAssertionPoll({ attempts, elapsedMs, capped }) {
      record.assertionPolls.push({
        attempts: attempts ?? null,
        elapsedMs: elapsedMs ?? null,
        capped: capped === true,
      });
      if (capped) record.assertionPollCapHits += 1;
    },

    /** Mark the case as having downgraded out of assertion_check polling. */
    noteAssertionPollDowngraded() {
      record.assertionPollDowngraded = true;
    },

    /**
     * Flush to disk. Returns the absolute path on success, null on failure.
     * Best-effort: a flush error never throws to the caller.
     */
    async flush({ outputDir }) {
      record.completedAt = new Date().toISOString();
      record.totalElapsedMs = Date.now() - startedAtMs;
      try {
        const dir = path.join(outputDir, runId);
        fs.mkdirSync(dir, { recursive: true });
        const filename = path.join(dir, `${runResultId}.json.gz`);
        const buf = zlib.gzipSync(Buffer.from(JSON.stringify(record), 'utf8'), { level: 6 });
        fs.writeFileSync(filename, buf);
        return filename;
      } catch (err) {
        // Telemetry must NEVER fail a case — log and continue.
        try { console.warn('[turnTelemetry] flush failed:', err.message); } catch (_) {}
        return null;
      }
    },

    /** Test/diagnostic accessor — never used in hot paths. */
    snapshot() { return record; },
  };
}

module.exports = { create, SCHEMA_VERSION, SNAPSHOT_CAP_BYTES };
