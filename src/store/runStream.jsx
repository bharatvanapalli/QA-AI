import React, { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useAuth } from './auth';
import { useProject } from './project';
import { alignLoopbackUrlWithPage } from '../lib/localDevOrigin';

const RunStreamCtx = createContext(null);
// Pipeline state — split out into its OWN context so the high-velocity
// fields (pipelineState updated on every browser.frame + browser.action +
// phase.log; mcpSnapshot updated on every MCP roundtrip) only re-render
// the handful of pages that actually consume them (Theater, TestCases).
//
// Previously these lived in the same value object as `subscribe` /
// `latestSummary`, which meant the entire app re-rendered ~2–5× per
// second during a live run. Overview's Aurora rings, AnimatedNumber
// easings, and chart recomputes piled onto the main thread and froze
// page-to-page navigation. Splitting the contexts is the structural
// fix: subscribers opt INTO the firehose only when they need it.
const PipelineStateCtx = createContext(null);

/**
 * Resolve the WebSocket URL.
 *   - Honour VITE_WS_URL if set (explicit override, used by dev with a
 *     separate API host).
 *   - Otherwise derive from window.location: `wss://host/ws` (or `ws://`
 *     for HTTP origins). This is what production deployments behind a
 *     single host should use — no hardcoded localhost fallback that
 *     silently fails in prod.
 */
function resolveWsUrl() {
  if (import.meta.env.VITE_WS_URL) {
    return alignLoopbackUrlWithPage(import.meta.env.VITE_WS_URL, 'ws://localhost:5000');
  }
  if (typeof window !== 'undefined' && window.location) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
  }
  return 'ws://localhost:5000';
}

// Exponential backoff with jitter — caps at 30 s so server bounces don't
// thunder-herd from N clients hammering at the same fixed 2 s interval.
function nextBackoff(attempt) {
  const base = Math.min(30_000, 1_000 * 2 ** attempt); // 1, 2, 4, 8, 16, 30
  const jitter = Math.floor(Math.random() * 500);
  return base + jitter;
}

function schedulePaint(fn) {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return { kind: 'raf', id: window.requestAnimationFrame(fn) };
  }
  return { kind: 'timer', id: setTimeout(fn, 16) };
}

function cancelScheduledPaint(handle) {
  if (!handle) return;
  if (handle.kind === 'raf' && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(handle.id);
    return;
  }
  clearTimeout(handle.id);
}

// Initial shape of the pipeline-accumulator state. The provider holds this
// ABOVE the route tree so leaving and returning to /live-pipeline doesn't
// wipe everything that's happened. Theater reads from here on mount and on
// every change — there's no local mirror to drift out of sync.
const INITIAL_PIPELINE_STATE = {
  currentRunId: null,
  phaseStatus: { architect: 'idle', planner: 'idle', conductor: 'idle', critic: 'idle', verifier: 'idle', supervisor: 'idle' },
  phaseOutput: {},
  phaseAttempt: {},
  logs: { architect: [], planner: [], conductor: [], critic: [], verifier: [], supervisor: [], pipeline: [] },
  actionTrail: [],
  browserFrame: null,
  browserFrameSource: null,
  currentBrowserSessionId: null,
  nowTestingStep: null,
  agentWarning: null,
  runSummary: null,
  // True between /cancel ack (run.cancelling event) and the final
  // run.complete. Lets the UI hide the live "running" indicators
  // immediately even while the agent is still finishing its current
  // Claude call. Cleared on run.complete (final state takes over).
  cancelling: false,
  // Live Architect streaming progress. Set by 'architect.progress' events
  // every few KB of streamed JSON; cleared by agent.phase.complete for
  // phase 'architect'. Shape: { scenariosSoFar, charsSoFar, elapsedMs }.
  // Hoisting it into the global store (rather than TestCases.jsx local
  // state) is what makes the circle survive a navigation away and back —
  // the prior implementation lost state on unmount, which the user
  // reported as "the ongoing generation is vanishing when I switch pages".
  architectProgress: null,
  // Monotonic per-run counters. Derived state in CostStrip used to compute
  // these from `actionTrail.filter(...)`, but actionTrail is bounded to its
  // last 500 entries — so as snapshot/screenshot entries roll into that
  // window, the count of NON-utility actions could DROP. Operators saw
  // "Actions this run" go up then down. These counters are accumulated
  // directly on the WS reducer side and never decrement within a run.
  // Reset on run.started, architect's phase.start, and resetPipelineState.
  actionCount: 0,
  // Cumulative input + output tokens spent by Claude calls this run, derived
  // from claude.rate-limit deltas. More meaningful than per-minute %
  // remaining (which resets each minute and made the "% used" indicator
  // flap). Null until we've seen at least one rate-limit event.
  tokensThisRun: null,
  // Last seen tokens.remaining — used to compute the delta on the next
  // event. Treat any RISE (rate-limit window reset) as a no-op, not a
  // refund.
  _lastTokensRemaining: null,
};

function normaliseOperationText(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/["'`]/g, '')
    .replace(/\b(textbox|field|input|control|button|link|page|the|provided|supplied|value|shows|accepts|accepted|ready|is|with)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function operationKindOf(row) {
  return row?.operationCheck?.kind || row?.kind || null;
}

function operationTargetOf(row) {
  return row?.operationCheck?.target || row?.target || row?.args?.element || row?.args?.target || null;
}

function sameOperationCheck(row, msg, expectedKey) {
  if (!row || row.tool !== 'operation_check' || row.syntheticOperationCheck !== true) return false;
  if (row.stepIndex !== msg.stepIndex) return false;
  if (msg.tcId && row.tcId && row.tcId !== msg.tcId) return false;
  // Row-aware (audit): an identical check from a DIFFERENT data row must NOT replace
  // another row's check in the trail. When either side carries row identity, require
  // the SAME dataRowIndex — otherwise row 2/6's "value is ready" would overwrite
  // row 1/6's, collapsing six rows into one.
  if ((row.dataRowIndex != null || msg.dataRowIndex != null) && row.dataRowIndex !== msg.dataRowIndex) return false;
  const rowKind = operationKindOf(row);
  const msgKind = msg.operationCheck?.kind || msg.kind || null;
  const rowTarget = operationTargetOf(row);
  const msgTarget = msg.operationCheck?.target || msg.target || null;
  if (rowKind && msgKind && rowKind === msgKind) {
    if (!rowTarget || !msgTarget) return true;
    return normaliseOperationText(rowTarget) === normaliseOperationText(msgTarget);
  }
  const rowExpected = row.expected == null ? '' : String(row.expected);
  if (rowExpected === expectedKey) return true;
  return !!rowExpected && !!expectedKey && normaliseOperationText(rowExpected) === normaliseOperationText(expectedKey);
}

function createInitialPipelineState(overrides = {}) {
  return {
    ...INITIAL_PIPELINE_STATE,
    phaseStatus: { ...INITIAL_PIPELINE_STATE.phaseStatus },
    phaseOutput: {},
    phaseAttempt: {},
    logs: {
      architect: [],
      planner: [],
      conductor: [],
      critic: [],
      verifier: [],
      supervisor: [],
      pipeline: [],
    },
    actionTrail: [],
    ...overrides,
  };
}

// Pure reducer applied to incoming WS messages. Pulled out of
// RunStreamProvider so it can be exported for tests and so the dispatcher
// inside the onmessage handler stays a one-liner. Always returns the SAME
// object reference when the message is unrelated to pipeline state — so
// React's bail-out optimisation kicks in for irrelevant updates.
export function applyPipelineMessage(state, msg) {
  if (!msg || typeof msg !== 'object') return state;
  switch (msg.type) {
    case 'run.started': {
      return createInitialPipelineState({ currentRunId: msg.runId || null });
    }
    case 'agent.phase.start': {
      const next = {
        ...state,
        phaseStatus: { ...state.phaseStatus, [msg.phase]: 'running' },
        agentWarning: null,
        cancelling: msg.phase === 'architect' ? false : state.cancelling,
      };
      if (typeof msg.attempt === 'number') {
        next.phaseAttempt = { ...state.phaseAttempt, [msg.phase]: msg.attempt };
      }
      // Architect's phase.start is the canonical "new run begins" signal —
      // reset the monotonic per-run counters so they don't accumulate across
      // back-to-back runs in the same browser session.
      if (msg.phase === 'architect') {
        next.actionCount = 0;
        next.tokensThisRun = null;
        next._lastTokensRemaining = null;
      }
      return next;
    }
    case 'agent.phase.complete': {
      return {
        ...state,
        phaseStatus: {
          ...state.phaseStatus,
          [msg.phase]: msg.cancelled ? 'cancelled' : (msg.error ? 'failed' : 'complete'),
        },
        phaseOutput: msg.output ? { ...state.phaseOutput, [msg.phase]: msg.output } : state.phaseOutput,
        agentWarning: state.agentWarning && state.agentWarning.phase === msg.phase ? null : state.agentWarning,
        cancelling: msg.phase === 'architect' ? false : state.cancelling,
        // Drop architect streaming progress when the architect phase ends —
        // the circle should snap to its final state (driven by the actual
        // scenario count post-parse) rather than freezing at whatever the
        // last streamed chunk reported.
        architectProgress: msg.phase === 'architect' ? null : state.architectProgress,
      };
    }
    case 'architect.progress': {
      // msg shape: { type: 'architect.progress', scenariosSoFar, charsSoFar,
      //              elapsedMs, projectId }. Replace wholesale; later
      //              snapshots always represent a more-complete state.
      return {
        ...state,
        architectProgress: {
          scenariosSoFar: msg.scenariosSoFar || 0,
          charsSoFar: msg.charsSoFar || 0,
          elapsedMs: msg.elapsedMs || 0,
        },
      };
    }
    case 'agent.phase.log': {
      const entry = { level: msg.level, message: msg.message, ts: Date.now(), tcId: msg.tcId };
      const phaseId = msg.phase || 'pipeline';
      const cur = state.logs[phaseId] || [];
      // Auto-flip an IDLE phase to RUNNING when its first log arrives — the
      // Critic in particular emits live hints via phase.log without ever
      // sending a phase.start, and operators saw "Critic IDLE" while the
      // Critic log was actively populating. Phases the pipeline doesn't
      // visualise (e.g. 'pipeline', 'healer', 'instructionReader') don't
      // appear in phaseStatus and are unaffected.
      const phaseStatus = (phaseId !== 'pipeline' && state.phaseStatus[phaseId] === 'idle')
        ? { ...state.phaseStatus, [phaseId]: 'running' }
        : state.phaseStatus;
      return {
        ...state,
        phaseStatus,
        logs: { ...state.logs, [phaseId]: [...cur, entry].slice(-200) },
      };
    }
    case 'agent.phase.warn': {
      return { ...state, agentWarning: { phase: msg.phase, message: msg.message, tcId: msg.tcId, ts: Date.now() } };
    }
    case 'claude.rate-limit': {
      // Track cumulative token spend across the whole run. Anthropic resets
      // `remaining` at the top of each minute (or per the reset header);
      // any RISE in `remaining` since the last event is a window reset, not
      // a refund — treat it as a re-baseline rather than crediting tokens.
      const rem = msg?.tokens?.remaining;
      if (typeof rem !== 'number') return state;
      const last = state._lastTokensRemaining;
      if (last == null) {
        return { ...state, _lastTokensRemaining: rem };
      }
      const delta = last - rem;
      if (delta <= 0) {
        return { ...state, _lastTokensRemaining: rem };
      }
      return {
        ...state,
        tokensThisRun: (state.tokensThisRun || 0) + delta,
        _lastTokensRemaining: rem,
      };
    }
    case 'browser.frame': {
      if (msg.sessionId && state.currentBrowserSessionId && msg.sessionId !== state.currentBrowserSessionId) {
        return state;
      }
      const incomingSource = msg.source || null;
      if (state.browserFrameSource === 'cdp_screencast' && incomingSource !== 'cdp_screencast') {
        return {
          ...state,
          currentBrowserSessionId: msg.sessionId || state.currentBrowserSessionId || null,
        };
      }
      const browserFrameSource = state.browserFrameSource === 'cdp_screencast' && incomingSource && incomingSource !== 'cdp_screencast'
        ? state.browserFrameSource
        : incomingSource || state.browserFrameSource || null;
      return {
        ...state,
        currentBrowserSessionId: msg.sessionId || state.currentBrowserSessionId || null,
        browserFrame: msg.frame ? `data:${msg.mediaType || 'image/jpeg'};base64,${msg.frame}` : state.browserFrame,
        browserFrameSource,
      };
    }
    case 'browser.session': {
      return {
        ...state,
        currentBrowserSessionId: msg.sessionId || null,
        browserFrame: null,
        browserFrameSource: null,
      };
    }
    case 'browser.session.end': {
      if (msg.sessionId && state.currentBrowserSessionId && msg.sessionId !== state.currentBrowserSessionId) {
        return state;
      }
      return { ...state, browserFrame: null, browserFrameSource: null, currentBrowserSessionId: null };
    }
    case 'browser.action': {
      const entry = {
        toolUseId: msg.toolUseId,
        tool: msg.tool,
        args: msg.args,
        narration: msg.narration,
        actionStatus: msg.actionStatus,
        error: msg.error,
        ts: Date.now(),
        tcId: msg.tcId,
        tcName: msg.tcName || null, // human test-case name → trail boundary never shows a bare UUID
        dataRowIndex: msg.dataRowIndex != null ? msg.dataRowIndex : null, // data-row identity → group repeated steps
        dataRowLabel: msg.dataRowLabel || null,
        dataSetName: msg.dataSetName || null,
        terminalStop: msg.terminalStop === true,
        stepTitle: msg.stepTitle || null,
        blockedReason: msg.blockedReason || null,
        syntheticStepAssertion: msg.syntheticStepAssertion === true,
        syntheticOperationCheck: msg.syntheticOperationCheck === true,
        stepIndex: msg.stepIndex,
        expected: msg.expected,
        status: msg.status,
        matched: msg.matched,
        reason: msg.reason,
        evidence: msg.evidence,
        operationCheck: msg.operationCheck || null,
        helperTraffic: msg.helperTraffic === true,
        diagnostic: msg.diagnostic === true,
        agentNarration: msg.agentNarration === true, // model commentary/plan, NOT a real browser action
        deterministicKernel: msg.deterministicKernel === true,
        kernelRecovery: msg.kernelRecovery || null,
      };
      const isUtility = msg.helperTraffic === true
        || msg.diagnostic === true
        || msg.actionStatus === 'diagnostic'
        || msg.agentNarration === true
        || msg.tool === 'agent_narration'
        || msg.terminalStop === true
        || msg.tool === 'terminal_stop'
        || msg.tool === 'browser_snapshot'
        || msg.tool === 'browser_take_screenshot'
        || msg.tool === 'browser_evaluate'
        || msg.tool === 'browser_run_code'
        || msg.tool === 'browser_run_code_unsafe'
        || msg.tool === 'browser_wait_for'
        || msg.tool === 'assertion_check'
        || msg.tool === 'final_verdict'
        || msg.tool === 'remember_credential'
        || msg.tool === 'human_input'
        || msg.tool === 'step_assertion'
        || msg.tool === 'operation_check';
      const nextTrail = [...state.actionTrail];
      let replacedActionLifecycle = false;
      if ((!isUtility || msg.actionStatus === 'diagnostic' || msg.helperTraffic === true || msg.diagnostic === true) && msg.toolUseId) {
        const replaceAt = [...nextTrail].reverse().findIndex((row) =>
          row && row.toolUseId === msg.toolUseId && (!msg.tcId || !row.tcId || row.tcId === msg.tcId)
        );
        if (replaceAt >= 0) {
          const index = nextTrail.length - 1 - replaceAt;
          nextTrail[index] = { ...nextTrail[index], ...entry, ts: nextTrail[index].ts || entry.ts };
          replacedActionLifecycle = true;
        }
      }
      if (
        !replacedActionLifecycle
        &&
        isUtility
        && msg.stepIndex
        && msg.status
        && (msg.status !== 'running' || msg.syntheticOperationCheck === true)
      ) {
        const expectedKey = msg.expected == null ? '' : String(msg.expected);
        const replaceAt = [...nextTrail].reverse().findIndex((row) =>
          row
          && (msg.tool === 'operation_check'
            ? sameOperationCheck(row, msg, expectedKey)
            : row.tool === msg.tool && row.stepIndex === msg.stepIndex)
          && (row.status === 'running' || (msg.tool === 'operation_check' && row.syntheticOperationCheck === true))
          && (!msg.tcId || !row.tcId || row.tcId === msg.tcId)
          && (msg.tool === 'operation_check' || (row.expected == null ? '' : String(row.expected)) === expectedKey)
        );
        if (replaceAt >= 0) {
          nextTrail[nextTrail.length - 1 - replaceAt] = entry;
        } else {
          nextTrail.push(entry);
        }
      } else if (!replacedActionLifecycle) {
        nextTrail.push(entry);
      }
      return {
        ...state,
        actionTrail: nextTrail.slice(-500),
        actionCount: state.actionCount + (isUtility || replacedActionLifecycle ? 0 : 1),
      };
    }
    case 'data.row.start': {
      // First-class data-row boundary (audit): push a rich, NESTABLE header into the
      // trail so repeated Step 1..N sequences read as "Data row 3/6 · set · inputs ·
      // expected" instead of a random restart. Stamped with the row identity so the
      // ActionTrail groups subsequent steps under it.
      if (!msg.tcId) return state;
      const rowEntry = {
        kind: 'data_row_start',
        dataRowStart: true,
        tool: 'data_row_start',
        tcId: msg.tcId,
        tcName: msg.tcName || null,
        dataRowIndex: msg.dataRowIndex,
        totalRows: msg.totalRows || null,
        dataRowLabel: msg.dataRowLabel || null,
        dataSetName: msg.dataSetName || null,
        inputs: msg.inputs || null,
        inputCount: Number.isFinite(Number(msg.inputCount)) ? Number(msg.inputCount) : null,
        hiddenInputCount: Number.isFinite(Number(msg.hiddenInputCount)) ? Number(msg.hiddenInputCount) : null,
        expected: msg.expected != null ? msg.expected : null,
        rowClass: msg.rowClass != null ? msg.rowClass : null,
        narration: msg.narration || null,
        ts: Date.now(),
      };
      return { ...state, actionTrail: [...state.actionTrail, rowEntry].slice(-500), currentDataRow: rowEntry };
    }
    case 'step.start': {
      if (!msg.tcId) return state;
      return { ...state, nowTestingStep: { tcId: msg.tcId, stepIndex: 1, totalSteps: msg.totalSteps || 1, tcName: msg.tcName || null, scenarioName: msg.scenarioName || null, steps: Array.isArray(msg.steps) ? msg.steps : [], dataRowIndex: msg.dataRowIndex, dataRowLabel: msg.dataRowLabel || null, dataSetName: msg.dataSetName || null } };
    }
    case 'step.progress': {
      if (!msg.tcId || !msg.stepIndex) return state;
      const cur = state.nowTestingStep;
      const steps = (cur && cur.tcId === msg.tcId && Array.isArray(cur.steps)) ? cur.steps : [];
      const next = cur && cur.tcId === msg.tcId
        ? { ...cur, stepIndex: msg.stepIndex }
        : { tcId: msg.tcId, stepIndex: msg.stepIndex, totalSteps: cur?.totalSteps || msg.stepIndex, steps };
      // Push a NUMBERED step marker into the live trail when we ENTER a new step,
      // so every step — including pure Fill/Click actions that only emit tool
      // narration — reads "Step N · <action> · <element>" in order.
      const isNewStep = !cur || cur.tcId !== msg.tcId || cur.stepIndex !== msg.stepIndex;
      let actionTrail = state.actionTrail;
      if (isNewStep) {
        const def = steps.find((s) => s && s.n === msg.stepIndex);
        const expected = def && def.expected != null ? String(def.expected).trim() : '';
        const verifyKind = def && def.verifyKind != null ? String(def.verifyKind).trim() : '';
        const label = def ? `${def.action}${def.element ? ` · ${def.element}` : ''}` : '';
        actionTrail = [...state.actionTrail, {
          tool: 'step_marker',
          stepMarker: true,
          tcId: msg.tcId,
          tcName: msg.tcName || null,
          dataRowIndex: msg.dataRowIndex != null ? msg.dataRowIndex : null,
          dataRowLabel: msg.dataRowLabel || null,
          dataSetName: msg.dataSetName || null,
          stepIndex: msg.stepIndex,
          expected,
          verifyKind,
          narration: `Step ${msg.stepIndex}${label ? ` · ${label}` : ''}`,
          ts: Date.now(),
        }].slice(-500);
      }
      return { ...state, nowTestingStep: next, actionTrail };
    }
    case 'step.operationCheck': {
      if (!msg.tcId || !msg.stepIndex) return state;
      const status = msg.status || (msg.matched === true ? 'pass' : msg.matched === false ? 'blocked' : 'running');
      const expected = msg.expected == null ? '' : String(msg.expected);
      const entry = {
        tool: 'operation_check',
        args: {},
        narration: `Step ${msg.stepIndex} operational check ${status === 'pass' ? 'passed' : status === 'running' ? 'is checking' : 'did not match'}. ${msg.kind || 'state_ready'} is ${status === 'pass' ? 'ready' : status}: "${expected || 'Current step state'}".`,
        ts: Date.now(),
        tcId: msg.tcId,
        tcName: msg.tcName || null,
        dataRowIndex: msg.dataRowIndex != null ? msg.dataRowIndex : null, // keep row identity so row N's check can't replace row M's
        dataRowLabel: msg.dataRowLabel || null,
        dataSetName: msg.dataSetName || null,
        syntheticOperationCheck: true,
        stepIndex: msg.stepIndex,
        expected: msg.expected,
        status,
        matched: msg.matched,
        reason: msg.reason,
        evidence: msg.evidence,
        operationCheck: {
          status,
          matched: msg.matched,
          checked: msg.checked,
          reason: msg.reason,
          evidence: msg.evidence,
          expected: msg.expected,
          kind: msg.kind,
          target: msg.target,
          required: msg.required,
        },
      };
      const nextTrail = [...state.actionTrail];
      const expectedKey = msg.expected == null ? '' : String(msg.expected);
      const existingIndex = [...nextTrail].reverse().findIndex((row) =>
        sameOperationCheck(row, msg, expectedKey)
      );
      if (existingIndex >= 0) nextTrail[nextTrail.length - 1 - existingIndex] = entry;
      else nextTrail.push(entry);
      return {
        ...state,
        actionTrail: nextTrail.slice(-500),
      };
    }
    case 'run.cancelling': {
      // Cancel acknowledged by the server — wind the live indicators down
      // immediately. The agent itself may still take 30–60 s to actually
      // stop (it has to unwind the current Claude call + MCP teardown);
      // run.complete will fire when that's done and set runSummary then.
      // Clearing nowTestingStep here removes the "Step X of Y" strip; the
      // cancelling flag lets pipelineLive hide the running pill + spinner
      // without waiting for the conductor's IIFE finally clause.
      return { ...state, nowTestingStep: null, cancelling: true };
    }
    case 'run.complete':
    case 'run.inplace.complete': {
      if (msg.runId && state.currentRunId && msg.runId !== state.currentRunId) {
        return state;
      }
      // Clear the per-case "NOW TESTING" strip and the cancelling flag —
      // no case is in flight once the run finishes, and runSummary now
      // owns the "this run is done" signal. Without this, the strip stayed
      // pinned to the last case for the full session.
      //
      // 2026-05-29 — also normalise any phase still in 'running' to a
      // terminal state. The Critic / Healer / InstructionReader phases
      // emit phase.log entries (auto-flipped to 'running' by the log
      // reducer above) but never emit a corresponding phase.complete, so
      // they would otherwise stay spinning forever after the run ends.
      // Architect / Planner / Conductor / Supervisor DO emit phase.complete
      // and are already at their terminal state — pass through unchanged.
      const cancelled = state.cancelling
        || !!(msg.summary && (msg.summary.cancelled === true || msg.summary.status === 'cancelled'));
      const terminal = cancelled ? 'cancelled' : 'complete';
      const nextPhaseStatus = {};
      for (const [phaseId, s] of Object.entries(state.phaseStatus)) {
        nextPhaseStatus[phaseId] = s === 'running' ? terminal : s;
      }
      return {
        ...state,
        phaseStatus: nextPhaseStatus,
        currentRunId: msg.runId || state.currentRunId,
        runSummary: msg.summary || state.runSummary,
        nowTestingStep: null,
        cancelling: false,
      };
    }
    default:
      return state;
  }
}

export function coalescePipelineMessages(messages = []) {
  const out = [];
  for (const msg of messages) {
    if (msg?.type === 'browser.frame') {
      const previousFrameIndex = out.findLastIndex((row) => row?.type === 'browser.frame');
      if (previousFrameIndex >= 0) out.splice(previousFrameIndex, 1);
    }
    out.push(msg);
  }
  return out;
}

export function deriveLiveActive({ running = false, pipelineState = null } = {}) {
  if (pipelineState?.cancelling) return false;
  if (running) return true;
  const executionPhases = new Set(['planner', 'conductor', 'critic', 'supervisor', 'healer', 'instructionReader']);
  return Object.entries(pipelineState?.phaseStatus || {}).some(([phase, status]) =>
    status === 'running' && executionPhases.has(phase)
  );
}

export function RunStreamProvider({ children }) {
  const { status } = useAuth();
  const { current } = useProject();
  const [connected, setConnected] = useState(false);
  const [log, setLog] = useState([]);
  const [latestRunId, setLatestRunId] = useState(null);
  const [latestSummary, setLatestSummary] = useState(null);
  const [running, setRunning] = useState(false);
  // Live Claude rate-limit snapshot — populated by `claude.rate-limit` WS
  // events emitted server-side after every agent call. Used by the Reports
  // page header to render a current-minute TPM-remaining chip. Null until
  // the first Claude call lands; resets to null on project switch (below).
  const [claudeRateLimit, setClaudeRateLimit] = useState(null);
  // Phase E1.4 — last accessibility-tree preview from the MCP layer. Powers
  // the Theater DOM snapshot pane so the operator can see exactly what the
  // agent is looking at. Cleared on project switch; updated on every
  // mcp.snapshot.preview broadcast (~once per tool call).
  const [mcpSnapshot, setMcpSnapshot] = useState(null);
  // Phase F.4 — pipeline accumulator. Theater used to hold these fields in
  // its OWN useState which evaporated whenever the user navigated away from
  // /live-pipeline mid-run, then came back to an empty page. Hoisting into
  // the provider (which is mounted above the route tree) means accumulation
  // continues across navigation, refreshes, and tab focus changes.
  const [pipelineState, setPipelineState] = useState(() => createInitialPipelineState());
  const wsRef = useRef(null);
  const listenersRef = useRef(new Set());
  const pendingPipelineMessagesRef = useRef([]);
  const pipelineFlushHandleRef = useRef(null);
  const pendingMcpSnapshotRef = useRef(null);
  const mcpSnapshotFlushHandleRef = useRef(null);
  // Ref (not state) so the ws.onmessage closure reads the live value without
  // being reconstructed every time the project changes.
  const currentProjectIdRef = useRef(current?.id || null);

  const flushPipelineMessages = useCallback(() => {
    pipelineFlushHandleRef.current = null;
    const queued = pendingPipelineMessagesRef.current;
    pendingPipelineMessagesRef.current = [];
    if (!queued.length) return;
    const batch = coalescePipelineMessages(queued);
    setPipelineState((cur) => batch.reduce((state, msg) => applyPipelineMessage(state, msg), cur));
  }, []);

  const enqueuePipelineMessage = useCallback((msg) => {
    pendingPipelineMessagesRef.current.push(msg);
    if (!pipelineFlushHandleRef.current) {
      pipelineFlushHandleRef.current = schedulePaint(flushPipelineMessages);
    }
  }, [flushPipelineMessages]);

  const flushMcpSnapshot = useCallback(() => {
    mcpSnapshotFlushHandleRef.current = null;
    const snapshot = pendingMcpSnapshotRef.current;
    pendingMcpSnapshotRef.current = null;
    if (snapshot) setMcpSnapshot(snapshot);
  }, []);

  const enqueueMcpSnapshot = useCallback((snapshot) => {
    pendingMcpSnapshotRef.current = snapshot;
    if (!mcpSnapshotFlushHandleRef.current) {
      mcpSnapshotFlushHandleRef.current = schedulePaint(flushMcpSnapshot);
    }
  }, [flushMcpSnapshot]);

  const clearPendingLiveUpdates = useCallback(() => {
    pendingPipelineMessagesRef.current = [];
    pendingMcpSnapshotRef.current = null;
    cancelScheduledPaint(pipelineFlushHandleRef.current);
    cancelScheduledPaint(mcpSnapshotFlushHandleRef.current);
    pipelineFlushHandleRef.current = null;
    mcpSnapshotFlushHandleRef.current = null;
  }, []);

  // Keep the project-id ref in sync so the ws.onmessage closure always reads
  // the current project, even though the WS connection is never torn down on
  // project switch.
  useEffect(() => {
    currentProjectIdRef.current = current?.id || null;
  }, [current?.id]);

  // Per-project state must reset when the user switches projects — otherwise
  // the in-memory latestRunId / latestSummary / log carries over from
  // project A and quietly contaminates project B's UI (e.g. the Overview
  // shows a "latest run" that belongs to a different project).
  useEffect(() => {
    clearPendingLiveUpdates();
    setLog([]);
    setLatestRunId(null);
    setLatestSummary(null);
    setRunning(false);
    // Rate-limit snapshot is per-API-key not per-project, but resetting it
    // on project switch avoids stale "0 tokens remaining" frightening the
    // user when the project changes context. The next Claude call repopulates.
    setClaudeRateLimit(null);
    setMcpSnapshot(null);
    // Phase F.4 — pipeline accumulator follows the same per-project reset
    // rule so cross-contamination between projects A and B can't happen.
    setPipelineState(createInitialPipelineState());
  }, [clearPendingLiveUpdates, current?.id]);

  const subscribe = useCallback((fn) => {
    listenersRef.current.add(fn);
    return () => listenersRef.current.delete(fn);
  }, []);

  useEffect(() => {
    if (status !== 'authed') return;
    let ws;
    let reconnectTimer;
    let closed = false;
    let attempt = 0;

    const connect = () => {
      ws = new WebSocket(resolveWsUrl());
      wsRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) {
          const delay = nextBackoff(attempt);
          attempt += 1;
          reconnectTimer = setTimeout(connect, delay);
        }
      };
      ws.onerror = () => {
        // close handler will retry
      };
      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        // Cross-project guard: if the server tagged this message with a
        // projectId and it doesn't match the active project, discard it.
        // Prevents project A's in-flight run from contaminating project B's
        // pipeline view after a project switch. Messages without projectId
        // (server-level pings, auth events) are always passed through.
        if (msg.projectId && currentProjectIdRef.current && msg.projectId !== currentProjectIdRef.current) {
          return;
        }
        if (msg.type === 'log') {
          setLog((prev) => {
            const next = [...prev, msg.message];
            return next.length > 500 ? next.slice(-500) : next;
          });
        }
        if (msg.type === 'run.started') {
          pendingMcpSnapshotRef.current = null;
          setLog([]);
          setClaudeRateLimit(null);
          setMcpSnapshot(null);
          setLatestRunId(msg.runId);
          setLatestSummary(null);
          setRunning(true);
        }
        if (msg.type === 'run.complete' || msg.type === 'run.inplace.complete') {
          if (msg.runId) setLatestRunId(msg.runId);
          setLatestSummary(msg.summary || null);
          setRunning(false);
        }
        if (msg.type === 'claude.rate-limit') {
          // Drop the `type` field — keep the structured tokens/requests/capturedAt.
          const { type, ...rest } = msg;
          setClaudeRateLimit(rest);
        }
        if (msg.type === 'mcp.snapshot.preview') {
          // { sessionId, tool, snapshot, truncated, length, ts }
          const { type, ...rest } = msg;
          enqueueMcpSnapshot(rest);
        }
        // Phase F.4 — feed the pipeline accumulator. The reducer is pure and
        // returns the same reference for unrelated messages so React bails out
        // on no-op renders.
        enqueuePipelineMessage(msg);
        for (const fn of listenersRef.current) {
          try {
            fn(msg);
          } catch (_) {}
        }
      };
    };
    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    };
  }, [enqueueMcpSnapshot, enqueuePipelineMessage, status]);

  useEffect(() => () => clearPendingLiveUpdates(), [clearPendingLiveUpdates]);

  const clearLog = useCallback(() => setLog([]), []);

  // Outbound WS send — used by the PauseModal to deliver
  // `agent.inputProvided` so the paused conductor can resume mid-case. Returns
  // true on success so the caller can fall back to an HTTP POST when the
  // socket happens to be down (rare, but safer than dropping the verdict).
  const send = useCallback((msg) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }, []);

  // Allow Theater (or any caller) to manually reset the pipeline accumulator
  // — used when launching a brand-new run so stale phase status from the
  // previous attempt doesn't briefly bleed onto the page. Accepts an
  // optional `overrides` object so the caller can seed an optimistic phase
  // status (e.g. architect = 'complete' when starting from Run Suite, where
  // Architect has already run). Anything not in overrides falls back to the
  // canonical INITIAL_PIPELINE_STATE.
  const resetPipelineState = useCallback((overrides = {}) => {
    clearPendingLiveUpdates();
    setLog([]);
    setMcpSnapshot(null);
    setPipelineState(createInitialPipelineState(overrides));
  }, [clearPendingLiveUpdates]);

  // Lightweight mutators on top of pipelineState. Theater calls these for
  // explicit user actions (dismissing a warning); state-driven updates from
  // WS events flow through applyPipelineMessage above.
  const dismissAgentWarning = useCallback(() => {
    setPipelineState((cur) => (cur.agentWarning ? { ...cur, agentWarning: null } : cur));
  }, []);

  const liveActive = useMemo(
    () => deriveLiveActive({ running, pipelineState }),
    [pipelineState, running]
  );

  // Stable handle — low-velocity fields only. Identity changes when the
  // user connects/disconnects, when a run starts/finishes, or when the
  // operator switches projects. Notably DOES NOT include pipelineState
  // or mcpSnapshot — those fire on every WS frame and would otherwise
  // re-render every consumer of useRunStream() at 2–5 Hz during a run.
  // claudeRateLimit stays here because it only fires once per Claude
  // call (~once per 30–60s) and Reports/ClaudeSettings already accept
  // that cadence.
  const value = useMemo(
    () => ({
      connected,
      log,
      latestRunId,
      latestSummary,
      running,
      liveActive,
      claudeRateLimit,
      resetPipelineState,
      dismissAgentWarning,
      clearLog,
      subscribe,
      setRunning,
      send,
    }),
    [connected, log, latestRunId, latestSummary, running, liveActive, claudeRateLimit, resetPipelineState, dismissAgentWarning, clearLog, subscribe, send]
  );

  // High-velocity handle — pipelineState + mcpSnapshot. Theater always
  // consumes this; TestCases consumes pipelineState.phaseStatus +
  // pipelineState.architectProgress. No other page subscribes, so the
  // browser.frame / browser.action firehose can't re-render them.
  const pipelineValue = useMemo(
    () => ({ pipelineState, mcpSnapshot }),
    [pipelineState, mcpSnapshot]
  );

  return (
    <RunStreamCtx.Provider value={value}>
      <PipelineStateCtx.Provider value={pipelineValue}>
        {children}
      </PipelineStateCtx.Provider>
    </RunStreamCtx.Provider>
  );
}

export function useRunStream() {
  const ctx = useContext(RunStreamCtx);
  if (!ctx) throw new Error('useRunStream must be inside RunStreamProvider');
  return ctx;
}

/**
 * High-velocity pipeline state — pipelineState (phaseStatus, actionTrail,
 * browserFrame, logs, etc.) and mcpSnapshot. Updates on every browser
 * frame and tool result. ONLY consume from pages that actually need to
 * react to per-frame changes (Theater, TestCases). Everyone else uses
 * useRunStream() to stay re-render-quiet.
 */
export function usePipelineState() {
  const ctx = useContext(PipelineStateCtx);
  if (!ctx) throw new Error('usePipelineState must be inside RunStreamProvider');
  return ctx;
}
