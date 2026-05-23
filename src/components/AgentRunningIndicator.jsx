import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Loader2, Sparkles, GitBranch, Bot, BrainCircuit, X, CheckCircle2, AlertOctagon,
  AlertCircle, Crosshair, StopCircle, Ban,
} from 'lucide-react';
import { useRunStream } from '../store/runStream';
import { useProject } from '../store/project';
import { useToast } from '../lib/useToast';
import api, { ApiError } from '../lib/apiClient';

const PHASE_META = {
  architect:  { label: 'Scenario Architect',   icon: Sparkles,     route: '/live-pipeline' },
  planner:    { label: 'Dependency Planner',   icon: GitBranch,    route: '/live-pipeline' },
  conductor:  { label: 'Execution Conductor',  icon: Bot,          route: '/live-pipeline' },
  critic:     { label: 'Critic',               icon: AlertCircle,  route: '/live-pipeline' },
  supervisor: { label: 'Supervisor',           icon: Crosshair,    route: '/live-pipeline' },
  analyst:    { label: 'Document Analyst',     icon: BrainCircuit, route: '/test-cases' },
  reporter:   { label: 'Reporter',             icon: BrainCircuit, route: '/reports' },
};

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
  const { subscribe } = useRunStream();
  const { current } = useProject();
  const toast = useToast();
  const [phase, setPhase] = useState(null);
  const [status, setStatus] = useState('idle');   // idle | running | cancelling | cancelled | complete | error
  const [lastLog, setLastLog] = useState('');
  const [output, setOutput] = useState(null);
  const [error, setError] = useState(null);
  const [startedAt, setStartedAt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  // Reset state on project switch so the indicator never flips between
  // projects' phase states. Concurrent runs in two projects previously
  // chased whichever projectId sent the most recent WS message.
  useEffect(() => {
    setPhase(null); setStatus('idle'); setLastLog(''); setOutput(null);
    setError(null); setStartedAt(0); setElapsed(0); setDismissed(false);
  }, [current?.id]);

  useEffect(() => {
    const unsub = subscribe((msg) => {
      // Project scope: many WS messages carry projectId; if it does not match
      // the active project, ignore to prevent cross-project contamination.
      if (msg.projectId && current?.id && msg.projectId !== current.id) return;

      if (msg.type === 'agent.phase.start') {
        setPhase(msg.phase);
        setStatus('running');
        setLastLog('');
        setOutput(null);
        setError(null);
        setStartedAt(Date.now());
        setDismissed(false);
      } else if (msg.type === 'agent.phase.log') {
        if (msg.phase) setPhase(msg.phase);
        if (msg.message) setLastLog(msg.message);
        setStatus((prev) => (prev === 'idle' ? 'running' : prev));
        if (!startedAt) setStartedAt(Date.now());
      } else if (msg.type === 'agent.phase.complete') {
        if (msg.phase) setPhase(msg.phase);
        // Distinguish cancelled vs failed: the server now sets msg.cancelled:true
        // when the abort was triggered by the user; show neutral "Cancelled"
        // not an alarming red error pill.
        if (msg.cancelled || msg.error === 'cancelled') {
          setStatus('cancelled');
          setError(null);
        } else if (msg.error) {
          setStatus('error');
          setError(msg.error);
        } else {
          setStatus('complete');
          setOutput(msg.output || null);
        }
      } else if (msg.type === 'run.complete') {
        setStatus((prev) => (prev === 'running' || prev === 'cancelling' ? 'complete' : prev));
        setOutput(msg.summary || null);
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  const handleCancel = useCallback(async () => {
    if (!current || status !== 'running') return;
    // Optimistic UI: switch to "cancelling" immediately so the user gets
    // feedback in the same frame as the click. Server confirms via
    // `agent.phase.complete { cancelled: true }` which then moves us to
    // the final "cancelled" state.
    setStatus('cancelling');
    try {
      await api.post(`/projects/${current.id}/agents/cancel`, {});
      // No toast — the inline status change is the confirmation. The previous
      // giant "Cancelling…" toast competed visually with the indicator itself.
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Could not cancel' });
      setStatus('running');
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

  if (dismissed || status === 'idle' || !phase) return null;

  // Suppress on pages that already show this state inline — Test Cases and
  // Run Suite own architect/analyst visibility, Live Pipeline owns the
  // conductor / critic / supervisor. Falling back to "show" on unrecognised
  // routes so persistence across navigation still works.
  const onTestCases = location.pathname.startsWith('/test-cases');
  const onRunSuite = location.pathname.startsWith('/run-suite');
  const onLivePipeline = location.pathname.startsWith('/live-pipeline') || location.pathname.startsWith('/theater');
  const ownedByPage =
    ((onTestCases || onRunSuite) && (phase === 'architect' || phase === 'analyst')) ||
    (onLivePipeline && status === 'running');
  if (ownedByPage && status === 'running') return null;

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
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 w-[320px] max-w-[calc(100vw-2rem)] pointer-events-auto"
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
