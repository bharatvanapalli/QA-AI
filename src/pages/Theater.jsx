import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Sparkles, GitBranch, Bot, Camera, Crosshair, Play, Loader2, CheckCircle2,
  XCircle, AlertCircle, ChevronDown, ChevronRight, Eye, Pause, X, RefreshCcw,
  StopCircle, Maximize2, Minimize2, MousePointerClick, Copy, FileText, Network,
} from 'lucide-react';
import api, { ApiError } from '../lib/apiClient';
import { useProject } from '../store/project';
import { useToast } from '../lib/useToast';
import { useRunStream } from '../store/runStream';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import Button from '../components/ui/Button';
import Markdown, { looksLikeMarkdown } from '../components/Markdown';
import { phaseStatusMeta, statusMeta } from '../lib/statusMeta';
import { timeAgo } from '../lib/timeAgo';

const PHASES = [
  { id: 'architect',  label: 'Scenario Architect',   icon: Sparkles,    blurb: 'Reads requirements and produces structured test scenarios with priority + category labels.' },
  { id: 'planner',    label: 'Dependency Planner',   icon: GitBranch,   blurb: 'Orders scenarios into execution waves respecting dependencies and data isolation.' },
  { id: 'conductor',  label: 'Execution Conductor',  icon: Bot,         blurb: 'Drives the live browser via MCP. Auto-retries failing cases up to 3 times. Writes a spec file for each passing test.' },
  { id: 'critic',     label: 'Critic',               icon: AlertCircle, blurb: 'Monitors the Conductor live with inline hints and rewrites failing test cases between retries.' },
  { id: 'supervisor', label: 'Supervisor',           icon: Crosshair,   blurb: 'Final intervention after 3 failed attempts: injects guidance and missing context for one supervised retry.' },
];

export default function Theater() {
  const navigate = useNavigate();
  const toast = useToast();
  const { current, currentSprintId } = useProject();
  const { subscribe, mcpSnapshot } = useRunStream();

  const [starting, setStarting] = useState(false);
  const [phaseStatus, setPhaseStatus] = useState({ architect: 'idle', planner: 'idle', conductor: 'idle', critic: 'idle', supervisor: 'idle' });
  const [phaseOutput, setPhaseOutput] = useState({});
  const [phaseAttempt, setPhaseAttempt] = useState({});  // phase -> latest attempt number
  const [logs, setLogs] = useState({ architect: [], planner: [], conductor: [], critic: [], supervisor: [], pipeline: [] });
  // Phase log expansion lives in the timeline pane. By default only the active
  // / most recently active phase is expanded so the timeline doesn't grow into
  // a 5×log-panel monster.
  const [expandedPhase, setExpandedPhase] = useState(null);
  const [browserFrame, setBrowserFrame] = useState(null);
  const [actionTrail, setActionTrail] = useState([]);
  const [pickerArmed, setPickerArmed] = useState(false);
  const [pickerCandidates, setPickerCandidates] = useState(null);
  const [runSummary, setRunSummary] = useState(null);
  const [lastFailedSummary, setLastFailedSummary] = useState(null);   // { lastRun, failedCount, failedCases }
  const [rerunning, setRerunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // Tracks whether the SERVER currently has a pipeline running for this user.
  // Survives WebSocket reconnects, page refreshes, and route navigation —
  // anything that would otherwise wipe local `phaseStatus`. Seeded by
  // /agents/status, kept fresh by phase events.
  //   null  = not checked yet (suppress empty state to avoid flicker)
  //   true  = pipeline is running on the server
  //   false = no pipeline running
  const [serverPipelineRunning, setServerPipelineRunning] = useState(null);
  // D5 — most recent agent.phase.warn payload (e.g. Conductor stuck in a
  // repetition loop). Surfaced as an amber banner so the user can cancel
  // before the hard-stop burns more attempts. Cleared on phase.complete or
  // a fresh phase.start.
  const [agentWarning, setAgentWarning] = useState(null);

  // Auto-scroll the active phase log
  const logRefs = {
    architect:  useRef(null),
    planner:    useRef(null),
    conductor:  useRef(null),
    critic:     useRef(null),
    supervisor: useRef(null),
  };

  useEffect(() => {
    const unsub = subscribe((msg) => {
      if (msg.type === 'agent.phase.start') {
        setPhaseStatus((p) => ({ ...p, [msg.phase]: 'running' }));
        // Auto-expand the active phase in the timeline so the user sees its
        // log immediately. The previous expansion gets folded.
        setExpandedPhase(msg.phase);
        setServerPipelineRunning(true);
        setAgentWarning(null);   // fresh phase → clear stale warning
        if (typeof msg.attempt === 'number') {
          setPhaseAttempt((a) => ({ ...a, [msg.phase]: msg.attempt }));
        }
      }
      if (msg.type === 'agent.phase.warn') {
        setAgentWarning({ phase: msg.phase, message: msg.message, tcId: msg.tcId, ts: Date.now() });
      }
      if (msg.type === 'agent.phase.log') {
        setLogs((all) => ({
          ...all,
          [msg.phase]: [...(all[msg.phase] || []), { level: msg.level, message: msg.message, ts: Date.now(), tcId: msg.tcId }].slice(-200),
        }));
        // A phase log means the pipeline is alive even if we missed its start
        setServerPipelineRunning(true);
        // Auto-scroll
        requestAnimationFrame(() => {
          const ref = logRefs[msg.phase];
          if (ref?.current) ref.current.scrollTop = ref.current.scrollHeight;
        });
      }
      if (msg.type === 'agent.phase.complete') {
        setPhaseStatus((p) => ({ ...p, [msg.phase]: msg.error ? 'failed' : 'complete' }));
        if (msg.output) setPhaseOutput((o) => ({ ...o, [msg.phase]: msg.output }));
        setAgentWarning((w) => (w && w.phase === msg.phase ? null : w));
      }
      if (msg.type === 'browser.frame') {
        setBrowserFrame(`data:image/jpeg;base64,${msg.frame}`);
      }
      if (msg.type === 'browser.action') {
        // Keep up to 200 entries so users can scroll back through the run.
        // Old cap of 30 silently dropped the earliest tool calls — combined
        // with the section having no fixed height, the user lost the start
        // of the run before they could read it.
        setActionTrail((trail) => [...trail, { tool: msg.tool, args: msg.args, narration: msg.narration, ts: Date.now(), tcId: msg.tcId }].slice(-200));
      }
      if (msg.type === 'browser.session.end') {
        setBrowserFrame(null);
        setPickerArmed(false);
      }
      if (msg.type === 'picker.armed') setPickerArmed(true);
      if (msg.type === 'picker.candidates') {
        setPickerCandidates(msg.candidates || []);
        setPickerArmed(false);
      }
      if (msg.type === 'run.complete') {
        setRunSummary(msg.summary);
        setCancelling(false);
        // The conductor emits run.complete per attempt; the server only
        // truly stops when the cancelRegistry clears its token. Re-check via
        // /agents/status so we don't prematurely mark the pipeline as idle
        // between Conductor attempts or before the supervised final pass.
        if (current) {
          api.get(`/projects/${current.id}/agents/status`)
            .then((data) => setServerPipelineRunning(!!data.running))
            .catch(() => setServerPipelineRunning(false));
          api.get(`/projects/${current.id}/agents/failed-cases`)
            .then((data) => setLastFailedSummary(data))
            .catch(() => {});
        }
      }
    });
    return unsub;
  }, [subscribe, current]);

  // On mount and on project change: query the server for whether a pipeline
  // is currently running for this user. This handles the case where the user
  // navigated away mid-run and came back — local phaseStatus would otherwise
  // read as "all idle" and render the empty state on top of an active run.
  //
  // Also: reset every piece of per-project Theater state. Without this,
  // switching projects leaves stale phase logs, picker candidates, action
  // trails, run summaries, and frame data from the previous project's run.
  useEffect(() => {
    setPhaseStatus({ architect: 'idle', planner: 'idle', conductor: 'idle', critic: 'idle', supervisor: 'idle' });
    setPhaseOutput({});
    setPhaseAttempt({});
    setLogs({ architect: [], planner: [], conductor: [], critic: [], supervisor: [], pipeline: [] });
    setBrowserFrame(null);
    setActionTrail([]);
    setPickerArmed(false);
    setPickerCandidates(null);
    setRunSummary(null);
    setLastFailedSummary(null);
    setExpandedPhase(null);

    if (!current) {
      setServerPipelineRunning(false);
      return;
    }
    let cancelled = false;
    api.get(`/projects/${current.id}/agents/status`)
      .then((data) => { if (!cancelled) setServerPipelineRunning(!!data.running); })
      .catch(() => { if (!cancelled) setServerPipelineRunning(false); });
    return () => { cancelled = true; };
  }, [current?.id]);

  // While we suspect a pipeline is running, re-poll /status every 8s. This
  // catches the case where the WS dropped silently mid-run and we missed the
  // final run.complete event — without it, the "running" hint would stick
  // forever after a real failure.
  useEffect(() => {
    if (!current || serverPipelineRunning !== true) return;
    const id = setInterval(() => {
      api.get(`/projects/${current.id}/agents/status`)
        .then((data) => setServerPipelineRunning(!!data.running))
        .catch(() => {});
    }, 8000);
    return () => clearInterval(id);
  }, [current?.id, serverPipelineRunning]);

  // On mount / project change: fetch the latest-run failed-cases summary so
  // we can surface the "Re-run failed cases" banner.
  useEffect(() => {
    if (!current) {
      setLastFailedSummary(null);
      return;
    }
    let cancelled = false;
    api.get(`/projects/${current.id}/agents/failed-cases`)
      .then((data) => { if (!cancelled) setLastFailedSummary(data); })
      .catch(() => { if (!cancelled) setLastFailedSummary(null); });
    return () => { cancelled = true; };
  }, [current]);

  const handleRerunFailed = useCallback(async () => {
    if (!current) return;
    setRerunning(true);
    setLogs({ architect: [], planner: [], conductor: [], critic: [], supervisor: [], pipeline: [] });
    setPhaseOutput({});
    setPhaseAttempt({});
    setActionTrail([]);
    setRunSummary(null);
    setPickerCandidates(null);
    setPhaseStatus({ architect: 'complete', planner: 'complete', conductor: 'idle', critic: 'idle', supervisor: 'idle' });
    try {
      const data = await api.post(`/projects/${current.id}/agents/rerun-failed`, { sprintId: currentSprintId || null });
      toast.success(`Re-running ${data.caseCount} failed case(s). Watch below.`, { title: 'Re-run started' });
      setLastFailedSummary(null);
      setServerPipelineRunning(true);
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Could not re-run' });
      setPhaseStatus((p) => ({ ...p, conductor: 'idle', critic: 'idle', supervisor: 'idle' }));
    } finally {
      setRerunning(false);
    }
  }, [current, toast]);

  const handleStart = useCallback(async () => {
    if (!current) return;
    setStarting(true);
    setLogs({ architect: [], planner: [], conductor: [], critic: [], supervisor: [], pipeline: [] });
    setPhaseOutput({});
    setPhaseAttempt({});
    setActionTrail([]);
    setRunSummary(null);
    setPickerCandidates(null);
    // Mark Architect as already done (it ran on Run Suite). Planner + Conductor pick up from here.
    setPhaseStatus({ architect: 'complete', planner: 'idle', conductor: 'idle', critic: 'idle', supervisor: 'idle' });
    try {
      await api.post(`/projects/${current.id}/agents/execute`, { sprintId: currentSprintId || null });
      toast.success('Planner + Conductor running. Watch below.', { title: 'Execution started' });
      setServerPipelineRunning(true);
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Could not start' });
      setPhaseStatus({ architect: 'idle', planner: 'idle', conductor: 'idle', critic: 'idle', supervisor: 'idle' });
      setServerPipelineRunning(false);
    } finally {
      setStarting(false);
    }
  }, [current, toast]);

  const armPicker = useCallback(async () => {
    if (!current) return;
    try {
      await api.post(`/projects/${current.id}/agents/picker/arm`, {});
      setPickerCandidates(null);
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Picker unavailable' });
    }
  }, [current, toast]);

  const handleCancel = useCallback(async () => {
    if (!current || cancelling) return;
    setCancelling(true);
    try {
      await api.post(`/projects/${current.id}/agents/cancel`, {});
      toast.success('Cancellation requested. The pipeline will stop after the current step.', { title: 'Cancelling' });
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Could not cancel' });
    } finally {
      setTimeout(() => setCancelling(false), 1500);
    }
  }, [current, cancelling, toast]);

  if (!current) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Live Pipeline" subtitle="Live multi-agent test generation" />
        <EmptyState icon={Bot} title="No project selected" message="Activate a project to launch the agent pipeline." />
      </div>
    );
  }

  const allIdle = Object.values(phaseStatus).every((s) => s === 'idle');
  const anyRunning = Object.values(phaseStatus).some((s) => s === 'running');
  const pipelineLive = anyRunning || serverPipelineRunning === true;
  // We only show the empty "Ready to execute" hero once we've confirmed
  // nothing is running on the server AND there's nothing to surface from a
  // prior run (no LastRunSummary, no failed-cases banner) — otherwise we'd
  // hide useful context behind a generic empty state.
  const hasFailureBanner = !pipelineLive && !!lastFailedSummary?.lastRun && lastFailedSummary.failedCount > 0;
  const hasLastRun = !pipelineLive && !!lastFailedSummary?.lastRun;
  const showEmptyHero = allIdle && serverPipelineRunning === false && !runSummary && !hasLastRun;
  // Joined a run that's already in progress — phaseStatus is all idle locally
  // (because we missed the events), but the server says it's still going.
  const joinedMidRun = allIdle && serverPipelineRunning === true;
  // Whether to render the three-pane execution view at all. Once a run has
  // touched any phase (running or complete) OR the server reports activity,
  // we show the panes so the user has somewhere to watch frames + actions.
  const showExecutionView = pipelineLive || !allIdle || !!runSummary;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader title="Live Pipeline" subtitle={current.name + ' — Execute approved test cases'}>
        {!pipelineLive && (
          <Button size="md" onClick={handleStart} disabled={starting || pipelineLive} loading={starting}>
            <Play className="w-3.5 h-3.5 fill-current" />
            {allIdle ? 'Execute approved' : 'Run again'}
          </Button>
        )}
        {pipelineLive && (
          <div className="inline-flex items-center gap-2">
            <span className="inline-flex items-center gap-2 px-3 h-9 rounded-pill bg-info-50 text-info-700 text-xs font-semibold border border-info-100">
              <Loader2 className="w-3 h-3 animate-spin" />
              Pipeline running…
            </span>
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="inline-flex items-center gap-2 px-3 h-9 rounded-pill bg-danger-50 text-danger-700 text-xs font-semibold border border-danger-200 hover:bg-danger-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Stop the pipeline after the current step"
            >
              <StopCircle className="w-3.5 h-3.5" />
              {cancelling ? 'Cancelling…' : 'Cancel run'}
            </button>
          </div>
        )}
      </PageHeader>

      <main className="flex-1 overflow-y-auto bg-ink-50">
        <div className="max-w-7xl mx-auto px-page py-8 space-y-5">
          {/* D5 — amber loop warning. Surfaces while a phase is running and
              the Conductor has flagged a stuck pattern. User can cancel the
              run before the hard-stop burns more attempts. */}
          {agentWarning && pipelineLive && (
            <section className="rounded-card border border-warn-200 bg-warn-50 shadow-card p-4 flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-warn-700 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0 text-sm">
                <div className="font-semibold text-warn-800 capitalize">
                  {agentWarning.phase} stuck pattern detected
                </div>
                <div className="text-warn-700 mt-0.5">{agentWarning.message}</div>
              </div>
              <button
                onClick={() => setAgentWarning(null)}
                className="text-warn-700 hover:text-warn-900 p-1"
                title="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            </section>
          )}
          {/* Failure banner — only when idle and the previous run has failures. */}
          {hasFailureBanner && (
            <RerunFailedBanner
              summary={lastFailedSummary}
              loading={rerunning}
              onRerun={handleRerunFailed}
              onDismiss={() => setLastFailedSummary(null)}
            />
          )}

          {/* Clean-run summary — only when idle, the previous run completed,
              and there are no failures to surface (otherwise the failure
              banner above carries the context). Expanding the card fetches
              the full run detail + top failures inline. */}
          {!pipelineLive && !hasFailureBanner && hasLastRun && (
            <LastRunSummary
              projectId={current.id}
              summary={lastFailedSummary.lastRun}
            />
          )}

          {/* Joined-mid-run banner. */}
          {joinedMidRun && (
            <section className="rounded-card border border-info-200 bg-info-50 shadow-card p-5 flex items-start gap-4">
              <div className="w-10 h-10 rounded-lg bg-white flex items-center justify-center shrink-0">
                <Loader2 className="w-5 h-5 text-info-700 animate-spin" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-2xs font-bold uppercase tracking-wider text-info-700">A run is already in progress</div>
                <h3 className="text-md font-semibold text-ink-900 tracking-tight mt-0.5">Streaming live updates…</h3>
                <p className="text-sm text-ink-600 mt-0.5">
                  Events from earlier in this run are not replayed, but new phase activity will appear below as it happens.
                  You can stop the pipeline at any time with <span className="font-semibold">Cancel run</span>.
                </p>
              </div>
            </section>
          )}

          {/* Two-row execution view.
              Row 1: PhaseTimeline spans the full content width so each phase
                 row gets room for its status + output summary, and the
                 expanded dark log panel has breathing room to render full
                 log lines instead of word-wrapping every few words.
              Row 2: BrowserFrame (left, takes most of the row) + ActionTrail
                 (right, ~380px). Both stretch to the same height so the trail
                 doesn't end short below the 16:9 browser frame.
              Below lg the same components stack single-column. */}
          {showExecutionView && (
            <div className="space-y-4">
              <PhaseTimeline
                phaseStatus={phaseStatus}
                phaseOutput={phaseOutput}
                phaseAttempt={phaseAttempt}
                logs={logs}
                logRefs={logRefs}
                expandedPhase={expandedPhase}
                onTogglePhase={(id) => setExpandedPhase((cur) => (cur === id ? null : id))}
              />
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-4">
                <BrowserFrame
                  frame={browserFrame}
                  pickerArmed={pickerArmed}
                  onArmPicker={armPicker}
                  runSummary={runSummary}
                  onOpenReports={() => navigate('/reports')}
                />
                <ActionTrail
                  actions={actionTrail}
                  pickerCandidates={pickerCandidates}
                  onCopyPick={(expr) => navigator.clipboard.writeText(expr).then(() => toast.success('Locator copied.'))}
                  onClearPicks={() => setPickerCandidates(null)}
                  conductorActive={phaseStatus.conductor === 'running' || phaseStatus.conductor === 'complete'}
                />
              </div>
              {/* Phase E1.4 — DOM snapshot pane. Renders only when MCP has
                  emitted at least one snapshot for this session. Collapsed
                  by default; expand to see exactly what the agent is reading.
                  This is the operator's proof that the agent sees the same
                  DOM the human does. */}
              <DomSnapshotPane snapshot={mcpSnapshot} />
            </div>
          )}

          {/* Pristine empty hint — only when truly nothing has run for this
              project yet AND the server confirms nothing is in flight. */}
          {showEmptyHero && (
            <EmptyState
              icon={Sparkles}
              title="Ready to execute"
              message="The Planner will order your approved scenarios into execution waves, and the Conductor will drive a live browser to verify each test case. Make sure you have approved test cases on the Test Cases page first."
              action={
                <Button onClick={handleStart} loading={starting}>
                  <Play className="w-3.5 h-3.5 fill-current" />
                  Execute approved
                </Button>
              }
            />
          )}
        </div>
      </main>
    </div>
  );
}

// ── PhaseTimeline ─────────────────────────────────────────────────
// Left pane. A vertical list of the 5 phases, each with status dot, label,
// attempt counter, output summary, and an expandable inline log. The
// timeline visually connects phases with a left rail so the dependency
// reading order is obvious.
function PhaseTimeline({ phaseStatus, phaseOutput, phaseAttempt, logs, logRefs, expandedPhase, onTogglePhase }) {
  return (
    <section
      className="rounded-card border border-ink-200 bg-white shadow-card overflow-hidden"
      aria-label="Phase timeline"
    >
      <header className="px-4 py-3 border-b border-ink-100 flex items-center gap-2">
        <GitBranch className="w-4 h-4 text-ink-500" />
        <h2 className="text-2xs font-bold uppercase tracking-wider text-ink-700">Pipeline</h2>
      </header>
      <ol className="relative">
        {PHASES.map((phase, idx) => {
          const status = phaseStatus[phase.id] || 'idle';
          const meta = phaseStatusMeta(status);
          const Icon = phase.icon;
          const StatusIcon = meta.icon;
          const isExpanded = expandedPhase === phase.id;
          const phaseLogs = logs[phase.id] || [];
          const output = phaseOutput[phase.id];
          const attempt = phaseAttempt[phase.id];
          const isLast = idx === PHASES.length - 1;
          return (
            <li key={phase.id}>
              {/* Button row in its own relative container so the dot-to-dot
                  connector is bounded by the button's height — without this,
                  the line ran from this phase's button through the expanded
                  dark log panel (left:28px landed inside it). */}
              <div className="relative">
                {/* Connector line — between dots, only when not the last item */}
                {!isLast && (
                  <span
                    className={`absolute left-[28px] top-[44px] bottom-0 w-px ${status === 'complete' ? 'bg-success-200' : 'bg-ink-200'}`}
                    aria-hidden="true"
                  />
                )}
                <button
                  onClick={() => onTogglePhase(phase.id)}
                  className={`w-full flex items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-ink-50 focus-visible:outline-none focus-visible:bg-ink-50 ${isExpanded ? 'bg-ink-50/60' : ''}`}
                  aria-expanded={isExpanded}
                  aria-controls={`phase-log-${phase.id}`}
                >
                {/* Status dot — the visual focal point. Running phases pulse
                    with a soft ring to draw the eye. */}
                <span
                  className={`relative w-7 h-7 shrink-0 rounded-full flex items-center justify-center border ${meta.cls} ${status === 'running' ? `ring-4 ${meta.ring} ring-opacity-30 animate-pulse` : ''}`}
                  aria-hidden="true"
                >
                  {status === 'running'
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : status === 'idle'
                    ? <Icon className="w-3.5 h-3.5" />
                    : <StatusIcon className="w-3.5 h-3.5" />}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-semibold text-ink-900 truncate">{phase.label}</span>
                    {typeof attempt === 'number' && attempt > 1 && (
                      <span className="text-2xs font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-pill bg-warn-50 text-warn-700">
                        try {attempt}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className={`text-2xs font-bold uppercase tracking-wider ${meta.text}`}>{meta.label}</span>
                    {output && (
                      <>
                        <span className="text-ink-300 text-2xs">·</span>
                        <span className="text-2xs text-ink-500 truncate font-mono">{summariseOutput(phase.id, output)}</span>
                      </>
                    )}
                  </div>
                </div>
                <ChevronDown
                  className={`w-3.5 h-3.5 text-ink-400 shrink-0 mt-1 transition-transform ${isExpanded ? 'rotate-0' : '-rotate-90'}`}
                />
              </button>
              </div>

              {isExpanded && (
                <div id={`phase-log-${phase.id}`} className="px-4 pb-4">
                  <div
                    ref={logRefs[phase.id]}
                    className="text-[13px] leading-relaxed max-h-72 overflow-y-auto bg-ink-900 text-ink-100 rounded-md p-3 space-y-1.5"
                  >
                    {phaseLogs.length === 0 ? (
                      <div className="text-ink-400 italic font-mono text-xs">
                        {status === 'idle' ? 'Not started yet.' : 'Waiting for first log line…'}
                      </div>
                    ) : (
                      phaseLogs.map((l, i) => <LogLine key={i} entry={l} />)
                    )}
                  </div>
                  <p className="text-2xs text-ink-500 mt-2 leading-relaxed">{phase.blurb}</p>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ── BrowserFrame ──────────────────────────────────────────────────
// Centre pane. The live browser screencast plus its control strip
// (pause / zoom / fullscreen / pick element). Fullscreen here is a CSS
// expand inside the app — predictable, Esc-to-exit, no cursor surprises.
function BrowserFrame({ frame, pickerArmed, onArmPicker, runSummary, onOpenReports }) {
  const [paused, setPaused] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [frozenFrame, setFrozenFrame] = useState(null);
  const [fullscreen, setFullscreen] = useState(false);

  // Freeze the frame on pause so subsequent WS frames don't overwrite what
  // the user is looking at.
  useEffect(() => {
    if (paused) setFrozenFrame(frame);
    else setFrozenFrame(null);
  }, [paused]);

  // Esc exits fullscreen — also covers users who hit Esc without clicking
  // the minimise button.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const displayFrame = paused ? frozenFrame : frame;

  return (
    <section
      className={
        fullscreen
          ? 'fixed inset-0 z-50 bg-ink-900 flex flex-col'
          : 'rounded-card border border-ink-200 bg-white shadow-card overflow-hidden flex flex-col'
      }
      aria-label="Live browser"
    >
      <div className={`px-4 py-3 border-b ${fullscreen ? 'border-ink-700 bg-ink-900' : 'border-ink-100 bg-white'} flex items-center justify-between flex-wrap gap-2`}>
        <div className="flex items-center gap-2">
          <div className={`w-7 h-7 rounded-md flex items-center justify-center ${fullscreen ? 'bg-info-900/40' : 'bg-info-50'}`}>
            <Eye className={`w-3.5 h-3.5 ${fullscreen ? 'text-info-300' : 'text-info-600'}`} />
          </div>
          <div className="min-w-0">
            <h3 className={`text-sm font-semibold tracking-tight ${fullscreen ? 'text-white' : 'text-ink-900'}`}>Live Browser</h3>
            <p className={`text-2xs ${fullscreen ? 'text-ink-400' : 'text-ink-500'}`}>Streaming frames at ~2 fps</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setPaused((p) => !p)}
            disabled={!frame}
            title={paused ? 'Resume live stream' : 'Pause viewer (agent keeps running)'}
            aria-pressed={paused}
          >
            {paused
              ? <><Play className="w-3.5 h-3.5" /> Resume</>
              : <><Pause className="w-3.5 h-3.5" /> Pause</>
            }
          </Button>
          <div className={`flex items-center gap-1.5 px-2 h-8 rounded-md border ${fullscreen ? 'bg-ink-800 border-ink-700' : 'bg-ink-100 border-ink-200'}`}>
            <span className={`text-2xs uppercase tracking-wider font-bold ${fullscreen ? 'text-ink-400' : 'text-ink-500'}`}>zoom</span>
            <input
              type="range"
              min="0.5"
              max="2"
              step="0.1"
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="accent-ink-900 w-20"
              aria-label="Zoom"
              disabled={!frame}
            />
            <span className={`text-2xs font-mono tabular-nums w-8 text-right ${fullscreen ? 'text-ink-200' : 'text-ink-700'}`}>{zoom.toFixed(1)}x</span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setFullscreen((f) => !f)}
            disabled={!frame}
            title={fullscreen ? 'Exit fullscreen (Esc)' : 'Expand to fullscreen'}
            aria-pressed={fullscreen}
            aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          >
            {fullscreen
              ? <><Minimize2 className="w-3.5 h-3.5" /> Exit</>
              : <><Maximize2 className="w-3.5 h-3.5" /> Full</>
            }
          </Button>
          <Button
            size="sm"
            variant={pickerArmed ? 'primary' : 'secondary'}
            onClick={onArmPicker}
            disabled={!frame || pickerArmed}
            title="Click an element in the live browser to capture locator candidates"
          >
            <Crosshair className="w-3.5 h-3.5" />
            {pickerArmed ? 'Picking…' : 'Pick element'}
          </Button>
          {runSummary && !fullscreen && (
            <Button size="sm" variant="secondary" onClick={onOpenReports} title="Open full Reports">
              <FileText className="w-3.5 h-3.5" />
              Reports
            </Button>
          )}
        </div>
      </div>

      <div className={`relative ${fullscreen ? 'flex-1 bg-ink-900' : 'bg-ink-900 aspect-[16/9] min-h-[520px]'} flex items-center justify-center overflow-auto`}>
        {displayFrame ? (
          <img
            src={displayFrame}
            alt="Live browser frame"
            style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
            className="max-w-full max-h-full object-contain transition-transform"
          />
        ) : (
          <div className="text-ink-400 text-xs flex flex-col items-center gap-2 p-6 text-center">
            <Camera className="w-6 h-6" />
            No frames yet. Browser starts when the Conductor phase begins.
          </div>
        )}
        {paused && displayFrame && (
          <div className="absolute top-3 right-3 px-2 py-1 bg-warn-500/95 text-white text-2xs font-bold uppercase tracking-wider rounded">
            Paused — viewer only
          </div>
        )}
        {pickerArmed && frame && (
          <div className="absolute top-3 left-3 px-2 py-1 bg-success-500/95 text-white text-2xs font-bold uppercase tracking-wider rounded flex items-center gap-1.5">
            <MousePointerClick className="w-3 h-3" />
            Pick mode — click an element in the actual browser
          </div>
        )}
        {fullscreen && (
          <button
            onClick={() => setFullscreen(false)}
            className="absolute top-3 right-3 px-2 h-7 rounded bg-white/10 hover:bg-white/20 text-white text-2xs font-semibold flex items-center gap-1.5 transition-colors"
            aria-label="Exit fullscreen"
          >
            <X className="w-3 h-3" /> Esc
          </button>
        )}
      </div>

      {runSummary && !fullscreen && (
        <div className="border-t border-ink-100 px-4 py-3 bg-ink-50 flex items-center gap-3 text-xs flex-wrap">
          <span className="text-success-700 font-bold tabular-nums">{runSummary.passed} pass</span>
          <span className="text-danger-700 font-bold tabular-nums">{runSummary.failed} fail</span>
          <span className="text-warn-700 font-bold tabular-nums">{runSummary.blocked ?? 0} blocked</span>
          {(runSummary.skipped ?? 0) > 0 && (
            <span className="text-ink-500 font-bold tabular-nums">{runSummary.skipped} skipped</span>
          )}
          <span className="ml-auto text-ink-500">Pass rate: <span className="font-bold text-ink-900 tabular-nums">{runSummary.passRate}%</span></span>
        </div>
      )}
    </section>
  );
}

// ── ActionTrail ───────────────────────────────────────────────────
// Right pane. Tool calls + narration from the Conductor, plus the picker
// candidates panel pinned to the top when a pick lands. Sticky scroll to
// bottom by default; user scrolling up holds the position until they
// scroll back to within ~20px of the bottom.
function ActionTrail({ actions, pickerCandidates, onCopyPick, onClearPicks, conductorActive }) {
  const scrollRef = useRef(null);
  const stickRef = useRef(true);

  // Detect whether the user has scrolled away from the bottom. If so, stop
  // auto-scrolling so they can read history without the panel yanking them
  // back to the latest entry.
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    stickRef.current = fromBottom < 20;
  };

  useEffect(() => {
    if (!stickRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [actions]);

  return (
    <section
      className="rounded-card border border-ink-200 bg-white shadow-card overflow-hidden flex flex-col h-[640px]"
      aria-label="Action trail"
    >
      <header className="px-4 py-3 border-b border-ink-100 flex items-center gap-2">
        <Bot className="w-4 h-4 text-ink-500" />
        <h3 className="text-2xs font-bold uppercase tracking-wider text-ink-700">Action trail</h3>
        {actions.length > 0 && (
          <span className="ml-auto text-2xs font-mono text-ink-400 tabular-nums">{actions.length}</span>
        )}
      </header>

      {pickerCandidates && pickerCandidates.length > 0 && (
        <PickerCandidates
          candidates={pickerCandidates}
          onCopy={onCopyPick}
          onClear={onClearPicks}
        />
      )}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-3 space-y-2"
      >
        {actions.length === 0 ? (
          <div className="text-xs text-ink-400 italic">
            {conductorActive
              ? 'Waiting for the Conductor’s first action…'
              : 'Tool calls and narration will appear here once the Conductor starts.'}
          </div>
        ) : (
          actions.map((a, i) => <ActionLine key={i} action={a} />)
        )}
      </div>
    </section>
  );
}

// ── PickerCandidates ──────────────────────────────────────────────
// Ranked locator suggestions returned by the picker. Each row shows:
//  - a stability bar (colour by score: success ≥80, warn ≥50, danger <50)
//  - a strategy chip (testid / role / label / css / xpath …)
//  - the expression in mono
//  - click-to-copy with a clipboard icon
function PickerCandidates({ candidates, onCopy, onClear }) {
  const toneFor = (score) => {
    if (score >= 80) return { bar: 'bg-success-500', text: 'text-success-700', bg: 'bg-success-50' };
    if (score >= 50) return { bar: 'bg-warn-500',    text: 'text-warn-700',    bg: 'bg-warn-50' };
    return { bar: 'bg-danger-500', text: 'text-danger-700', bg: 'bg-danger-50' };
  };
  return (
    <div className="border-b border-ink-200 bg-success-50/50">
      <div className="px-3 py-2 border-b border-success-200 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Crosshair className="w-3.5 h-3.5 text-success-700" />
          <span className="text-2xs font-bold uppercase tracking-wider text-success-700">
            {candidates.length} locator candidate{candidates.length === 1 ? '' : 's'}
          </span>
        </div>
        <button
          onClick={onClear}
          className="text-ink-400 hover:text-ink-700 focus-visible:outline-none focus-visible:shadow-ring rounded p-0.5"
          title="Dismiss"
          aria-label="Dismiss locator candidates"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <ul className="p-2 space-y-1.5">
        {candidates.map((c, i) => {
          const stability = typeof c.stability === 'number' ? c.stability : 0;
          const tone = toneFor(stability);
          return (
            <li
              key={i}
              className="rounded-md border border-ink-200 bg-white p-2 space-y-1.5"
            >
              <div className="flex items-center gap-2">
                <span className={`text-2xs uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-pill ${tone.bg} ${tone.text}`}>
                  {c.strategy || 'css'}
                </span>
                <div className="flex-1 h-1.5 bg-ink-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${tone.bar} transition-all`}
                    style={{ width: `${Math.max(2, Math.min(100, stability))}%` }}
                    aria-hidden="true"
                  />
                </div>
                <span className={`text-2xs font-mono tabular-nums w-9 text-right font-semibold ${tone.text}`}>
                  {stability}%
                </span>
              </div>
              <button
                onClick={() => onCopy(c.expression)}
                className="w-full text-left group flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-ink-50 focus-visible:outline-none focus-visible:bg-ink-50"
                title="Copy selector"
              >
                <Copy className="w-3 h-3 text-ink-400 group-hover:text-ink-700 shrink-0" />
                <code className="text-xs text-ink-900 truncate font-mono flex-1">{c.expression}</code>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── LastRunSummary ────────────────────────────────────────────────
// Idle-state card showing the most recent completed run at a glance:
// passed / failed / blocked / skipped counts, pass-rate bar, relative
// time. Click "Show details" to fetch the full run (via /runs/:id) and
// render a per-scenario breakdown + top failures inline. No navigation.
function LastRunSummary({ projectId, summary }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const passed = summary.passed || 0;
  const failed = summary.failed || 0;
  const blocked = summary.blocked || 0;
  const skipped = summary.skipped || 0;
  const total = passed + failed + blocked + skipped;
  const passRate = total ? Math.round((passed / total) * 100) : 0;
  const started = summary.startedAt ? new Date(summary.startedAt) : null;
  const ago = started ? timeAgo(started) : '';

  const handleToggle = useCallback(async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !detail && !loading && summary.id) {
      setLoading(true);
      setError(null);
      try {
        const res = await api.get(`/projects/${projectId}/runs/${summary.id}`);
        setDetail(res.run);
      } catch (err) {
        setError(err.message || 'Could not load run details.');
      } finally {
        setLoading(false);
      }
    }
  }, [expanded, detail, loading, projectId, summary.id]);

  // Top failures: first 5 RunResult rows whose status is fail/blocked, with
  // a short error preview. Skipped cases are excluded — they're not
  // diagnostic.
  const topFailures = React.useMemo(() => {
    if (!detail?.results) return [];
    return detail.results
      .filter((r) => r.status === 'fail' || r.status === 'blocked')
      .slice(0, 5);
  }, [detail]);

  // Scenario breakdown: groupBy scenario name, count per status.
  const scenarioBreakdown = React.useMemo(() => {
    if (!detail?.results) return [];
    const byId = new Map();
    for (const r of detail.results) {
      const sc = r.testCase?.scenario;
      if (!sc) continue;
      const cur = byId.get(sc.id) || {
        id: sc.id, name: sc.name, module: sc.module,
        pass: 0, fail: 0, blocked: 0, skipped: 0,
      };
      if (cur[r.status] != null) cur[r.status] += 1;
      byId.set(sc.id, cur);
    }
    return Array.from(byId.values()).sort((a, b) => (b.fail + b.blocked) - (a.fail + a.blocked));
  }, [detail]);

  return (
    <section className="rounded-card border border-ink-200 bg-white shadow-card overflow-hidden">
      <div className="flex items-start gap-4 p-5">
        <div className="w-10 h-10 rounded-lg bg-success-50 flex items-center justify-center shrink-0">
          <CheckCircle2 className="w-5 h-5 text-success-700" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-2xs font-bold uppercase tracking-wider text-success-700">Most recent run</span>
            {summary.sprintName && (
              <span className="text-2xs font-semibold text-ink-500">{summary.sprintName}</span>
            )}
            {ago && <span className="text-2xs text-ink-500">· {ago}</span>}
            {summary.status && (
              <span className="text-2xs text-ink-400 uppercase tracking-wider">· {summary.status}</span>
            )}
          </div>
          <h3 className="text-md font-semibold text-ink-900 tracking-tight mt-0.5">
            {total} test case{total === 1 ? '' : 's'} executed
          </h3>
          <div className="mt-2 flex items-center gap-3 text-xs flex-wrap">
            <span className="text-success-700 font-bold tabular-nums">{passed} pass</span>
            <span className="text-danger-700 font-bold tabular-nums">{failed} fail</span>
            <span className="text-warn-700 font-bold tabular-nums">{blocked} blocked</span>
            {skipped > 0 && (
              <span className="text-ink-500 font-bold tabular-nums">{skipped} skipped</span>
            )}
            <span className="ml-auto text-ink-500">
              Pass rate: <span className="font-bold text-ink-900 tabular-nums">{passRate}%</span>
            </span>
          </div>
          {/* Stacked-bar pass-rate visual */}
          {total > 0 && (
            <div className="mt-2 flex h-2 w-full rounded-full overflow-hidden bg-ink-100">
              {passed > 0 && <span className="bg-success-500" style={{ width: `${(passed / total) * 100}%` }} aria-hidden="true" />}
              {failed > 0 && <span className="bg-danger-500" style={{ width: `${(failed / total) * 100}%` }} aria-hidden="true" />}
              {blocked > 0 && <span className="bg-warn-500" style={{ width: `${(blocked / total) * 100}%` }} aria-hidden="true" />}
              {skipped > 0 && <span className="bg-ink-300" style={{ width: `${(skipped / total) * 100}%` }} aria-hidden="true" />}
            </div>
          )}
        </div>
        <div className="shrink-0">
          <button
            onClick={handleToggle}
            className="inline-flex items-center gap-1.5 px-3 h-8 rounded-md border border-ink-200 bg-white text-xs font-semibold text-ink-700 hover:border-ink-400 hover:bg-ink-50 focus-visible:outline-none focus-visible:shadow-ring transition-colors"
            aria-expanded={expanded}
            aria-controls="lastrun-detail"
          >
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            {expanded ? 'Hide details' : 'Show details'}
          </button>
        </div>
      </div>

      {expanded && (
        <div id="lastrun-detail" className="border-t border-ink-100 px-5 py-4 bg-ink-50/50 space-y-4">
          {loading && (
            <div className="text-xs text-ink-500 flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Loading run detail…
            </div>
          )}
          {error && (
            <div className="text-xs text-danger-700">{error}</div>
          )}

          {!loading && !error && detail && (
            <>
              {/* Top failures */}
              {topFailures.length > 0 && (
                <div>
                  <h4 className="text-2xs font-bold uppercase tracking-wider text-ink-600 mb-1.5">
                    Top failures
                  </h4>
                  <ul className="space-y-1.5">
                    {topFailures.map((r) => {
                      const meta = statusMeta(r.status);
                      const Icon = meta.icon;
                      return (
                        <li key={r.id} className="rounded-md border border-ink-200 bg-white px-3 py-2 text-xs">
                          <div className="flex items-center gap-2">
                            <Icon className={`w-3.5 h-3.5 ${meta.text} shrink-0`} />
                            <span className="font-semibold text-ink-900 truncate">{r.testCase?.name || r.testCaseId}</span>
                            {r.testCase?.module && (
                              <span className="text-2xs text-ink-400 shrink-0">[{r.testCase.module}]</span>
                            )}
                          </div>
                          {(r.error || r.blocked?.message) && (
                            <p className="text-2xs text-ink-600 mt-1 line-clamp-2 leading-relaxed">
                              {r.error || r.blocked?.message}
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {/* Scenario breakdown */}
              {scenarioBreakdown.length > 0 && (
                <div>
                  <h4 className="text-2xs font-bold uppercase tracking-wider text-ink-600 mb-1.5">
                    By scenario
                  </h4>
                  <ul className="space-y-1">
                    {scenarioBreakdown.map((sc) => {
                      const scTotal = sc.pass + sc.fail + sc.blocked + sc.skipped;
                      return (
                        <li key={sc.id} className="rounded-md border border-ink-200 bg-white px-3 py-1.5 text-xs flex items-center gap-2">
                          <span className="font-semibold text-ink-900 truncate flex-1">{sc.name}</span>
                          {sc.module && <span className="text-2xs text-ink-400 shrink-0">[{sc.module}]</span>}
                          <span className="text-2xs tabular-nums flex items-center gap-2 shrink-0">
                            {sc.pass > 0 && <span className="text-success-700 font-semibold">{sc.pass}p</span>}
                            {sc.fail > 0 && <span className="text-danger-700 font-semibold">{sc.fail}f</span>}
                            {sc.blocked > 0 && <span className="text-warn-700 font-semibold">{sc.blocked}b</span>}
                            {sc.skipped > 0 && <span className="text-ink-500 font-semibold">{sc.skipped}s</span>}
                            <span className="text-ink-400">/ {scTotal}</span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {topFailures.length === 0 && scenarioBreakdown.length === 0 && (
                <div className="text-xs text-ink-500">No detailed results available for this run.</div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ── LogLine ───────────────────────────────────────────────────────
// Single line in a phase's dark log panel. Different `level`s render
// distinctly: tool calls compact, scenario headers punchy, errors marked.
function LogLine({ entry }) {
  const msg = entry.message || '';

  if (entry.level === 'tool') {
    const trimmed = msg.replace(/^\s*[↳▶→·•]?\s*/, '');
    return (
      <div className="flex items-baseline gap-2 font-mono text-xs">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-info-400/80 translate-y-[3px] shrink-0" />
        <span className="text-info-300 break-all">{trimmed}</span>
      </div>
    );
  }

  if (entry.level === 'scenario') {
    return (
      <div className="text-info-200 font-bold uppercase tracking-wider text-2xs mt-2 first:mt-0 border-l-2 border-info-400/60 pl-2.5">
        {msg}
      </div>
    );
  }

  const tone = {
    error:   { marker: 'bg-danger-400',  text: 'text-danger-200' },
    warn:    { marker: 'bg-warn-400',    text: 'text-warn-200' },
    pass:    { marker: 'bg-success-400', text: 'text-success-200' },
    fail:    { marker: 'bg-danger-400',  text: 'text-danger-200' },
    codegen: { marker: 'bg-accent-400',  text: 'text-accent-200' },
    info:    { marker: 'bg-ink-500',     text: 'text-ink-100' },
  }[entry.level] || { marker: 'bg-ink-600', text: 'text-ink-100' };

  if (looksLikeMarkdown(msg)) {
    return (
      <div className="flex gap-2.5">
        <span className={`inline-block w-1 self-stretch rounded-full ${tone.marker} shrink-0 mt-1`} />
        <Markdown text={msg} className={`flex-1 min-w-0 ${tone.text}`} />
      </div>
    );
  }

  return (
    <div className={`flex gap-2.5 ${tone.text}`}>
      <span className={`inline-block w-1 self-stretch rounded-full ${tone.marker} shrink-0 mt-1`} />
      <div className="flex-1 min-w-0 whitespace-pre-wrap break-words">{msg}</div>
    </div>
  );
}

function summariseOutput(phaseId, output) {
  if (!output) return '';
  if (phaseId === 'architect') return `${output.scenarios} scenarios · ${output.cases || ''} cases`;
  if (phaseId === 'planner')   return `${output.waves?.length || 0} waves · ~${output.estimatedDurationSec || 0}s · ${output.riskFactors?.length || 0} risks`;
  if (phaseId === 'conductor') return output.summary
    ? (
        `${output.summary.passed} pass · ${output.summary.failed} fail`
        + (output.summary.blocked != null ? ` · ${output.summary.blocked} blocked` : '')
        + (output.summary.skipped != null ? ` · ${output.summary.skipped} skipped` : '')
        + ` (${output.summary.passRate}%)`
      )
    : 'completed';
  return '';
}

function ActionLine({ action }) {
  const toolColor = {
    navigate:        'text-info-600',
    click:           'text-success-600',
    fill:            'text-info-600',
    press:           'text-info-600',
    expect_visible:  'text-accent-600',
    expect_text:     'text-accent-600',
    wait_for:        'text-warn-600',
    snapshot:        'text-ink-500',
  }[action.tool] || 'text-ink-600';
  return (
    <div className="border-l-2 border-ink-200 pl-3 py-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-2xs font-mono font-bold uppercase ${toolColor}`}>{action.tool}</span>
        {action.args?.locator && <code className="text-2xs text-ink-500 truncate font-mono">{action.args.locator}</code>}
        {action.args?.url && <code className="text-2xs text-ink-500 truncate font-mono">{action.args.url}</code>}
        {action.args?.value && <code className="text-2xs text-ink-500 truncate font-mono">"{action.args.value}"</code>}
      </div>
      {action.narration && <div className="text-xs text-ink-700 mt-0.5">{action.narration}</div>}
    </div>
  );
}

function RerunFailedBanner({ summary, loading, onRerun, onDismiss }) {
  const { lastRun, failedCount, failedCases } = summary || {};
  const ago = lastRun?.startedAt ? timeAgo(lastRun.startedAt) : '';
  return (
    <section className="rounded-card border border-warn-200 bg-warn-50 shadow-card overflow-hidden">
      <div className="flex items-start gap-4 p-5">
        <div className="w-10 h-10 rounded-lg bg-warn-100 flex items-center justify-center shrink-0">
          <AlertCircle className="w-5 h-5 text-warn-700" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-2xs font-bold uppercase tracking-wider text-warn-700">Previous run</span>
            {lastRun?.sprintName && (
              <span className="text-2xs font-semibold text-ink-500">{lastRun.sprintName}</span>
            )}
            {ago && <span className="text-2xs text-ink-500">· {ago}</span>}
          </div>
          <h3 className="text-md font-semibold text-ink-900 tracking-tight mt-0.5">
            {failedCount} test case{failedCount === 1 ? '' : 's'} did not pass
          </h3>
          <p className="text-sm text-ink-600 mt-0.5">
            <span className="text-success-700 font-semibold tabular-nums">{lastRun?.passed || 0} passed</span>
            {' · '}
            <span className="text-danger-700 font-semibold tabular-nums">{lastRun?.failed || 0} failed</span>
            {' · '}
            <span className="text-warn-700 font-semibold tabular-nums">{lastRun?.skipped || 0} blocked</span>
            . Re-running will retry only the failing cases with the full Conductor → Critic → Supervisor pipeline.
          </p>
          {Array.isArray(failedCases) && failedCases.length > 0 && (
            <ul className="mt-2 space-y-0.5 max-h-32 overflow-y-auto pr-2">
              {failedCases.slice(0, 8).map((c) => (
                <li key={c.id} className="text-xs text-ink-700 flex items-baseline gap-2">
                  <span className="text-2xs uppercase tracking-wider font-bold text-warn-700 shrink-0">{c.status}</span>
                  <span className="truncate">{c.name || c.id}</span>
                  {c.module && <span className="text-2xs text-ink-400 shrink-0">[{c.module}]</span>}
                </li>
              ))}
              {failedCases.length > 8 && (
                <li className="text-2xs text-ink-500">…and {failedCases.length - 8} more</li>
              )}
            </ul>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="md" onClick={onRerun} disabled={loading} loading={loading}>
            <RefreshCcw className="w-3.5 h-3.5" />
            Re-run failed cases
          </Button>
          <button
            onClick={onDismiss}
            className="w-9 h-9 rounded-md text-ink-400 hover:text-ink-700 hover:bg-warn-100 flex items-center justify-center transition-colors"
            title="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </section>
  );
}

// Phase E1.4 — DOM snapshot pane. Renders the most recent Playwright-MCP
// accessibility-tree preview broadcast by the server. Collapsed by default
// so the row doesn't dominate the layout; once expanded, the operator can
// see exactly what the agent is reading and confirm the AI isn't hallucinating
// elements that aren't actually on the page. Wraps long lines in a mono pane.
function DomSnapshotPane({ snapshot }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!snapshot || !snapshot.snapshot) return null;

  const lineCount = snapshot.snapshot.split('\n').length;
  const lenLabel = snapshot.length >= 1024
    ? `${(snapshot.length / 1024).toFixed(1)} KB`
    : `${snapshot.length} chars`;
  const ago = snapshot.ts ? timeAgo(new Date(snapshot.ts).toISOString()) : '';

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(snapshot.snapshot);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_) { /* ignore */ }
  };

  return (
    <section className="rounded-card border border-ink-200 bg-white shadow-card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-ink-50 transition-colors rounded-card"
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="w-4 h-4 text-ink-500" /> : <ChevronRight className="w-4 h-4 text-ink-500" />}
        <Network className="w-4 h-4 text-info-700" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-ink-900">DOM snapshot · what the agent sees</div>
          <div className="text-2xs text-ink-500 flex items-center gap-2 flex-wrap">
            <span className="font-mono">{snapshot.tool || 'snapshot'}</span>
            <span>·</span>
            <span>{lineCount} lines</span>
            <span>·</span>
            <span>{lenLabel}{snapshot.truncated ? ' (preview truncated)' : ''}</span>
            {ago && <><span>·</span><span>{ago}</span></>}
          </div>
        </div>
        {expanded && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onCopy(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onCopy(); } }}
            className="inline-flex items-center gap-1 px-2.5 h-7 rounded-md border border-ink-200 bg-white text-xs font-semibold text-ink-700 hover:border-ink-400 hover:bg-ink-50 cursor-pointer"
            title="Copy the full snapshot to clipboard"
          >
            <Copy className="w-3 h-3" />
            {copied ? 'Copied' : 'Copy'}
          </span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-ink-200 px-4 py-3">
          <pre className="text-2xs font-mono text-ink-700 whitespace-pre-wrap break-all max-h-[420px] overflow-y-auto leading-relaxed">
            {snapshot.snapshot}
          </pre>
        </div>
      )}
    </section>
  );
}
