import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Loader2, Sparkles, GitBranch, Bot, BrainCircuit, X, CheckCircle2, AlertOctagon,
  AlertCircle, Crosshair, StopCircle, Ban,
} from 'lucide-react';
import { useRunStream, usePipelineState } from '../store/runStream';
import { useProject } from '../store/project';
import { useToast } from '../lib/useToast';
import api, { ApiError } from '../lib/apiClient';

// One-shot agents: when their phase.complete fires, the whole run is done.
// Per-case agents (Conductor / Critic / Supervisor / Healer / InstructionReader)
// fire phase.complete per case — for those we wait for run.complete instead.
const TERMINAL_ON_PHASE_COMPLETE = new Set(['architect', 'analyst', 'reporter']);

const PHASE_META = {
  architect:  { label: 'Scenario Architect',   icon: Sparkles,     route: '/live-pipeline' },
  planner:    { label: 'Dependency Planner',   icon: GitBranch,    route: '/live-pipeline' },
  conductor:  { label: 'Execution Conductor',  icon: Bot,          route: '/live-pipeline' },
  critic:     { label: 'Critic',               icon: AlertCircle,  route: '/live-pipeline' },
  supervisor: { label: 'Supervisor',           icon: Crosshair,    route: '/live-pipeline' },
  analyst:    { label: 'Document Analyst',     icon: BrainCircuit, route: '/test-cases' },
  reporter:   { label: 'Reporter',             icon: BrainCircuit, route: '/reports' },
};

const LIVE_INDICATOR_PHASES = new Set(['planner', 'conductor', 'critic', 'supervisor', 'healer', 'instructionReader']);

/**
 * Compact pill that mirrors any active or recently-completed agent phase.
 *
 * Subscribes to WS messages globally — persists across navigation so the user
 * can leave the page that started the work without losing context.
 *
 * Visual modes:
 *   • Running   — info-tinted, slim progress bar + Terminate
 *   • Cancelling — warn-tinted, shows "Cancelling…" until backend confirms
 *   • Cancelled — neutral-tinted, "Cancelled" with elapsed time
 *   • Complete   — success-tinted, summary + open link
 *   • Error      — danger-tinted, reason + dismiss
 *
 * Anchored bottom-right with a smaller footprint (max 360 px wide, slim
 * padding) so it does not feel like a third-party chatbot overlay.
 *
 * On the page that already owns the visible execution state (Test Cases when
 * the agent is one of architect/analyst), the indicator hides automatically
 * because the page itself surfaces the same status inline.
 */
export default function AgentRunningIndicator() {
  const navigate = useNavigate();
  const location = useLocation();
  const { subscribe, latestSummary, running } = useRunStream();
  const { pipelineState } = usePipelineState();
  const { current } = useProject();
  const toast = useToast();

  // Seed initial state from global pipelineState so navigating BACK to any
  // page while a phase is running immediately shows the indicator in the right
  // state rather than waiting for the next WS event to arrive.
  const [phase, setPhase] = useState(() => {
    const entry = Object.entries(pipelineState?.phaseStatus || {}).find(([p, s]) => s === 'running' && LIVE_INDICATOR_PHASES.has(p));
    return entry ? entry[0] : null;
  });
  const [status, setStatus] = useState(() => {
    const anyRunning = Object.entries(pipelineState?.phaseStatus || {}).some(([p, s]) => s === 'running' && LIVE_INDICATOR_PHASES.has(p));
    return anyRunning ? 'running' : 'idle';
  });   // idle | running | cancelling | cancelled | complete | error
  const [lastLog, setLastLog] = useState('');
  const [output, setOutput] = useState(null);
  const [error, setError] = useState(null);
  const [startedAt, setStartedAt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // Drag-to-reposition: null = default bottom-right anchor; once the operator
  // drags the chip it becomes {left, top} absolute pixels. The chip can cover a
  // page's own buttons, so letting it be moved anywhere is a real need.
  const [dragPos, setDragPos] = useState(null);
  const cardRef = useRef(null);
  const dragOffset = useRef(null);
  // Ref mirrors startedAt so the subscribe callback (captured once per
  // current?.id change) reads the mutable value, not the stale closure.
  // Previously the closure always saw startedAt=0, so every agent.phase.log
  // event reset the timer to Date.now() — the elapsed counter showed 1–2s
  // instead of the actual time since phase start.
  const startedAtRef = useRef(0);

  // Reset state on project switch so the indicator never flips between
  // projects' phase states. Concurrent runs in two projects previously
  // chased whichever projectId sent the most recent WS message.
  useEffect(() => {
    setPhase(null); setStatus('idle'); setLastLog(''); setOutput(null);
    setError(null); setStartedAt(0); setElapsed(0); setDismissed(false);
    startedAtRef.current = 0;
  }, [current?.id]);

  useEffect(() => {
    const unsub = subscribe((msg) => {
      // Require a loaded project before processing any event — if current is
      // null (page load before project fetch completes), the projectId guard
      // below would be a no-op and every WS message would contaminate state.
      if (!current?.id) return;
      // Project scope: ignore events from a different project.
      if (msg.projectId && msg.projectId !== current.id) return;

      if (msg.type === 'agent.phase.start') {
        if (!LIVE_INDICATOR_PHASES.has(msg.phase)) return;
        const now = Date.now();
        startedAtRef.current = now;
        setPhase(msg.phase);
        setStatus('running');
        setLastLog('');
        setOutput(null);
        setError(null);
        setStartedAt(now);
        setDismissed(false);
      } else if (msg.type === 'agent.phase.log') {
        if (msg.phase && !LIVE_INDICATOR_PHASES.has(msg.phase)) return;
        if (msg.phase) setPhase(msg.phase);
        if (msg.message) setLastLog(msg.message);
        setStatus((prev) => (prev === 'idle' ? 'running' : prev));
        // Use ref to avoid stale closure — the effect is only recreated on
        // current?.id change, so reading `startedAt` state here would always
        // see the initial value (0) and reset the timer on every log event.
        if (!startedAtRef.current) {
          const now = Date.now();
          startedAtRef.current = now;
          setStartedAt(now);
        }
      } else if (msg.type === 'agent.phase.complete') {
        if (msg.phase && !LIVE_INDICATOR_PHASES.has(msg.phase)) return;
        if (msg.phase) setPhase(msg.phase);
        // Distinguish cancelled vs failed: the server sets msg.cancelled=true
        // when the abort was triggered by the user; show neutral "Cancelled".
        if (msg.cancelled || msg.error === 'cancelled') {
          setStatus('cancelled');
          setError(null);
        } else if (msg.error) {
          setStatus('error');
          setError(msg.error);
        } else if (TERMINAL_ON_PHASE_COMPLETE.has(msg.phase)) {
          // Architect / Analyst / Reporter are one-shot agents — phase.complete
          // IS the run end. Per-case agents (conductor / critic / supervisor /
          // healer / instructionReader) fire phase.complete per case, with
          // more cases potentially to follow; for those we DON'T flip status
          // here, otherwise the Terminate button blinks out between cases and
          // operators report "I clicked stop and nothing happened". Wait for
          // run.complete instead.
          setStatus('complete');
          setOutput(msg.output || null);
        }
      } else if (msg.type === 'run.cancelling') {
        // Cancel was initiated from anywhere (Theater button, /agents/cancel
        // POST, /cancel API call) — reflect immediately. Previously the
        // indicator stayed 'running' through the 30-60 s teardown window
        // even though the cancel was already in flight.
        setStatus((prev) => (prev === 'running' || prev === 'cancelling' ? 'cancelling' : prev));
      } else if (msg.type === 'run.complete') {
        // Definitive end of run. If the run was cancelled (we observed
        // run.cancelling first, or the summary carries cancelled=true), land
        // on 'cancelled'; otherwise 'complete'. This is the ONLY path that
        // moves the indicator out of running/cancelling for a multi-phase run.
        const cancelled = !!(msg.summary && (msg.summary.cancelled === true || msg.summary.status === 'cancelled'));
        if (cancelled) {
          setStatus('cancelled');
        } else {
          setStatus((prev) => (prev === 'running' || prev === 'cancelling' ? 'complete' : prev));
        }
        setOutput(msg.summary || null);
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  // Backstop for the "stuck cancelling card" bug: a cancel can be requested
  // after the run has already completed, or this component can miss the
  // terminal WS frame while route state still has the final run summary. In
  // either case the card must not sit in "Cancelling..." forever.
  useEffect(() => {
    if (status !== 'cancelling') return;
    const summary = pipelineState?.runSummary || latestSummary;
    if (pipelineState?.cancelling || running || !summary) return;
    const cancelled = summary.cancelled === true || summary.status === 'cancelled';
    setStatus(cancelled ? 'cancelled' : 'complete');
    setOutput(summary);
  }, [status, pipelineState?.cancelling, pipelineState?.runSummary, latestSummary, running]);

  useEffect(() => {
    if (status !== 'cancelling') return undefined;
    const summary = pipelineState?.runSummary || latestSummary;
    if (pipelineState?.cancelling || running || summary) return undefined;
    const timer = setTimeout(() => {
      setStatus('idle');
      setDismissed(true);
    }, 8_000);
    return () => clearTimeout(timer);
  }, [status, pipelineState?.cancelling, pipelineState?.runSummary, latestSummary, running]);

  // Backstop for missed run.complete: if we're still in 'running' state but the
  // server says no pipeline is active, the WS event was dropped (e.g. server
  // restart mid-run, reconnect timing gap). Poll /agents/status every 8s while
  // running; on run.complete arriving normally this effect cleans up immediately
  // because status flips away from 'running'.
  useEffect(() => {
    if (status !== 'running' || !current?.id) return undefined;
    // Give the run a 10-second grace window before the first poll so we don't
    // race against the bootstrap phase (AgentRun.create lag after cancelRegistry.create).
    let intervalId;
    const graceTimer = setTimeout(() => {
      const poll = () => {
        api.get(`/projects/${current.id}/agents/status`).then((data) => {
          if (data.running || data.cancelRequested) return;
          // Server has no live token — run ended. Resolve to the appropriate terminal state.
          const summary = pipelineState?.runSummary || latestSummary;
          if (summary) {
            const cancelled = summary.cancelled === true || summary.status === 'cancelled';
            setStatus(cancelled ? 'cancelled' : 'complete');
            setOutput(summary);
          } else {
            // No summary available yet — flip to complete; the auto-dismiss will clean up.
            setStatus('complete');
          }
        }).catch(() => {
          // API unreachable — leave the indicator alone; don't flip to a terminal state on transient failures.
        });
      };
      poll(); // immediate first poll after grace period
      intervalId = setInterval(poll, 8_000);
    }, 10_000);
    return () => {
      clearTimeout(graceTimer);
      clearInterval(intervalId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, current?.id]);

  const handleCancel = useCallback(async () => {
    if (!current) {
      toast.error('No active project — refresh and try again.', { title: 'Cannot cancel' });
      return;
    }
    // Previously this returned silently when status !== 'running', which
    // produced the "I click Terminate and nothing happens" report. Cancel
    // is idempotent server-side — repeated clicks are harmless. We always
    // send the POST and give the operator visible feedback either way.
    const wasRunning = status === 'running';
    setStatus('cancelling');
    try {
      const res = await api.post(`/projects/${current.id}/agents/cancel`, {});
      if (!res?.cancelled && !res?.runId) {
        setStatus('idle');
        setDismissed(true);
        toast.info('No active pipeline is running.', { title: 'Nothing to cancel' });
        return;
      }
      // Server broadcasts run.cancelling → run.complete; those move us to
      // the terminal state. Inline status change is the confirmation. If
      // there was no live run, the API returns 200 with a no-op message —
      // still confirm visibly.
      if (!wasRunning) {
        toast.success('Cancellation signal sent.', { title: 'Stop requested' });
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Could not cancel' });
      // Roll back to whatever state we were in. If we were running we
      // genuinely failed to cancel; otherwise restore the prior terminal
      // state so the UI doesn't lie.
      setStatus(wasRunning ? 'running' : 'idle');
    }
  }, [current, status, toast]);

  // Tick elapsed while running or cancelling (cancelling can take a moment
  // for the backend to acknowledge — keep the timer visible).
  useEffect(() => {
    if (status !== 'running' && status !== 'cancelling') return;
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => clearInterval(id);
  }, [status, startedAt]);

  // Auto-dismiss terminal states (complete / cancelled / error) after a
  // shorter window than before so the chip does not linger across pages.
  useEffect(() => {
    if (status === 'idle' || status === 'running' || status === 'cancelling') return;
    const ms = status === 'cancelled' ? 6_000 : status === 'complete' ? 20_000 : 12_000;
    const t = setTimeout(() => setDismissed(true), ms);
    return () => clearTimeout(t);
  }, [status]);

  // ── Drag-to-reposition ──────────────────────────────────────────────
  // Pointer-based so it works with mouse, pen and touch. Dragging starts only
  // on non-interactive areas (the closest() guard) so the Terminate / Open /
  // Dismiss buttons still click normally. Position is clamped to the viewport.
  const onDragMove = useCallback((e) => {
    const off = dragOffset.current;
    if (!off) return;
    const el = cardRef.current;
    const w = el?.offsetWidth || 320;
    const h = el?.offsetHeight || 80;
    let left = Math.max(8, Math.min(e.clientX - off.x, window.innerWidth - w - 8));
    let top = Math.max(8, Math.min(e.clientY - off.y, window.innerHeight - h - 8));
    setDragPos({ left, top });
  }, []);

  const onDragEnd = useCallback(() => {
    dragOffset.current = null;
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    document.body.style.userSelect = '';
  }, [onDragMove]);

  const onDragStart = useCallback((e) => {
    // Let clicks on the action buttons / links behave normally.
    if (e.target.closest('button, a')) return;
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    // Anchor to the current pixel position first so there's no jump when we
    // switch from the bottom-right anchor to absolute left/top.
    setDragPos({ left: rect.left, top: rect.top });
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
  }, [onDragMove, onDragEnd]);

  // Safety cleanup if the chip unmounts mid-drag.
  useEffect(() => () => {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    document.body.style.userSelect = '';
  }, [onDragMove, onDragEnd]);

  if (dismissed || status === 'idle' || !phase) return null;

  // Suppress on pages that already render a RICH inline console for the CURRENT
  // phase — showing the floating chip there would duplicate the same status.
  //
  // Suppression is PHASE-AWARE: each page owns only the phases it actually
  // surfaces inline. Previously Live Pipeline suppressed the chip for ALL
  // phases, including architect/analyst — but a scenario *generation* is not an
  // execution, so the Theater has nothing live to show for it. That left a dead
  // zone: leave Run Suite toward Live Pipeline mid-generation and you saw
  // neither an inline view nor the chip ("it disappears when moving out"). Now
  // the chip is the single persistent cross-page status surface everywhere a
  // page isn't already showing the same phase inline.
  //   • Run Suite     → LiveTheatre "Working…" card  (architect)
  //   • Test Cases    → PhaseBanner                  (architect, analyst)
  //   • Live Pipeline → Theater                      (the execution pipeline only)
  const path = location.pathname;
  const PAGE_OWNED_PHASES = {
    '/run-suite':     ['architect'],
    '/test-cases':    ['architect', 'analyst'],
    '/live-pipeline': ['planner', 'conductor', 'critic', 'supervisor', 'reporter'],
    '/theater':       ['planner', 'conductor', 'critic', 'supervisor', 'reporter'],
  };
  const ownerKey = Object.keys(PAGE_OWNED_PHASES).find((p) => path.startsWith(p));
  const ownedByPage = ownerKey ? PAGE_OWNED_PHASES[ownerKey].includes(phase) : false;
  if (ownedByPage) return null;

  const meta = PHASE_META[phase] || { label: phase, icon: Loader2, route: '/' };
  const Icon = meta.icon;

  const tone =
    status === 'running'    ? 'bg-white border-info-200 text-ink-900' :
    status === 'cancelling' ? 'bg-white border-warn-200 text-ink-900' :
    status === 'cancelled'  ? 'bg-white border-ink-200 text-ink-900' :
    status === 'complete'   ? 'bg-white border-success-200 text-ink-900' :
                              'bg-white border-danger-200 text-ink-900';

  const stripeTone =
    status === 'running'    ? 'bg-info-500' :
    status === 'cancelling' ? 'bg-warn-500' :
    status === 'cancelled'  ? 'bg-ink-400' :
    status === 'complete'   ? 'bg-success-500' :
                              'bg-danger-500';

  return (
    <div
      ref={cardRef}
      role="status"
      aria-live="polite"
      onPointerDown={onDragStart}
      style={dragPos ? { left: dragPos.left, top: dragPos.top } : undefined}
      className={`fixed z-50 w-[320px] max-w-[calc(100vw-2rem)] pointer-events-auto cursor-grab active:cursor-grabbing select-none touch-none ${dragPos ? '' : 'bottom-4 right-4'}`}
    >
      <div className={`relative overflow-hidden rounded-lg border shadow-card ${tone}`}>
        {/* Left accent stripe — subtle colour cue without painting the whole card */}
        <div className={`absolute left-0 top-0 bottom-0 w-1 ${stripeTone}`} />
        <div className="pl-4 pr-3 py-2.5">
          <div className="flex items-start gap-2.5">
            <div className="mt-0.5 shrink-0">
              {status === 'running' && <Loader2 className="w-4 h-4 animate-spin text-info-600" />}
              {status === 'cancelling' && <Loader2 className="w-4 h-4 animate-spin text-warn-600" />}
              {status === 'cancelled' && <Ban className="w-4 h-4 text-ink-500" />}
              {status === 'complete' && <CheckCircle2 className="w-4 h-4 text-success-600" />}
              {status === 'error' && <AlertOctagon className="w-4 h-4 text-danger-600" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <Icon className="w-3 h-3 text-ink-500" />
                <span className="text-xs font-semibold tracking-tight text-ink-900 truncate">{meta.label}</span>
                {(status === 'running' || status === 'cancelling') && (
                  <span className="ml-auto text-2xs font-mono tabular-nums text-ink-500">{elapsed}s</span>
                )}
              </div>
              <div className="text-2xs mt-0.5 leading-snug text-ink-600 line-clamp-2">
                {status === 'running' && (lastLog || 'Working… you can navigate away, this keeps running.')}
                {status === 'cancelling' && 'Cancelling — waiting for the agent to stop…'}
                {status === 'cancelled' && `Cancelled after ${elapsed}s.`}
                {status === 'complete' && (
                  output?.scenarios
                    ? `${output.scenarios} scenarios · ${output.cases ?? '?'} cases.`
                    : output?.passed != null
                    ? `${output.passed} pass · ${output.failed} fail${output.blocked != null ? ` · ${output.blocked} blocked` : ''}${output.skipped != null ? ` · ${output.skipped} skipped` : ''}.`
                    : output?.summary
                    ? `${output.summary.passed} pass · ${output.summary.failed} fail${output.summary.blocked != null ? ` · ${output.summary.blocked} blocked` : ''}${output.summary.skipped != null ? ` · ${output.summary.skipped} skipped` : ''}.`
                    : 'Complete.'
                )}
                {status === 'error' && (error || 'Pipeline failed.')}
              </div>
              {(status === 'running' || status === 'cancelling') && (
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => navigate(meta.route)}
                    className="text-2xs font-semibold text-info-700 hover:underline"
                  >
                    Open Live Pipeline →
                  </button>
                  {current && status === 'running' && (
                    <button
                      onClick={handleCancel}
                      className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-semibold text-ink-700 border border-ink-200 hover:bg-ink-50"
                      title="Stop the pipeline after the current step"
                    >
                      <StopCircle className="w-3 h-3" />
                      Terminate
                    </button>
                  )}
                  {status === 'cancelling' && (
                    <span className="ml-auto text-2xs font-medium text-warn-700">Cancelling…</span>
                  )}
                </div>
              )}
              {(status === 'complete' || status === 'cancelled' || status === 'error') && (
                <div className="mt-1.5 flex items-center gap-2">
                  {status === 'complete' && (
                    <button
                      onClick={() => { navigate(meta.route); setDismissed(true); }}
                      className="text-2xs font-semibold text-success-700 hover:underline"
                    >
                      Open →
                    </button>
                  )}
                  <button
                    onClick={() => setDismissed(true)}
                    className="ml-auto text-2xs text-ink-500 hover:text-ink-900"
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
            <button
              onClick={() => setDismissed(true)}
              className="text-ink-400 hover:text-ink-700 shrink-0"
              title={status === 'running' ? 'Hide (the work keeps running)' : 'Dismiss'}
              aria-label="Hide notification"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
