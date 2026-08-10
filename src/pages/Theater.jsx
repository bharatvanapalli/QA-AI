import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Sparkles, GitBranch, Bot, Camera, Crosshair, Play, Loader2, CheckCircle2,
  XCircle, AlertCircle, ChevronDown, ChevronRight, Eye, Pause, X, RefreshCcw,
  StopCircle, Maximize2, Minimize2, FileText, Network, Gauge, Copy, ShieldCheck,
} from 'lucide-react';
import api, { ApiError, formatRunStartError } from '../lib/apiClient';
import { useProject } from '../store/project';
import { useToast } from '../lib/useToast';
import { useRunStream, usePipelineState } from '../store/runStream';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import Button from '../components/ui/Button';
import Markdown, { looksLikeMarkdown } from '../components/Markdown';
import { phaseStatusMeta, statusMeta } from '../lib/statusMeta';
import { timeAgo } from '../lib/timeAgo';
import { shouldShowDataRowUi } from '../lib/dataRowPresentation';

// ─────────────────────────────────────────────────────────────────────────────
// AuroraBackground — same design vocabulary as Overview / Run Suite / Test
// Cases / Reports. Four slow-drifting colored orbs behind a grain overlay;
// the main content layers above as frosted glass. Reduced-motion freezes.
// ─────────────────────────────────────────────────────────────────────────────
function AuroraBackground() {
  return (
    <div className="aurora-canvas grain-overlay" aria-hidden="true">
      <div className="aurora-orb aurora-orb-accent  aurora-drift-1"
           style={{ width: '52vw', height: '52vw', top: '-10vw', left: '-6vw' }} />
      <div className="aurora-orb aurora-orb-info    aurora-drift-2"
           style={{ width: '46vw', height: '46vw', top: '-4vw', right: '-8vw', opacity: 0.5 }} />
      <div className="aurora-orb aurora-orb-success aurora-drift-3"
           style={{ width: '42vw', height: '42vw', bottom: '-12vw', left: '20vw', opacity: 0.42 }} />
      <div className="aurora-orb aurora-orb-warn    aurora-drift-1"
           style={{ width: '34vw', height: '34vw', bottom: '-10vw', right: '8vw', opacity: 0.32 }} />
    </div>
  );
}

// PHASES — pipeline node definitions. `blurb` text was removed at user request
// (the action trail already serves as live narration; the blurbs duplicated
// info while burning screen space). If we ever need the descriptions for
// telemetry or backend logs they live in PHASE_LOG.md and the agent source
// files; the operator's live view stays minimal.
const PHASES = [
  { id: 'architect',  label: 'Scenario Architect',   icon: Sparkles    },
  { id: 'planner',    label: 'Dependency Planner',   icon: GitBranch   },
  { id: 'conductor',  label: 'Execution Conductor',  icon: Bot         },
  { id: 'critic',     label: 'Critic',               icon: AlertCircle },
  { id: 'verifier',   label: 'Verdict Verifier',     icon: ShieldCheck },
  { id: 'supervisor', label: 'Supervisor',           icon: Crosshair   },
];

const ACTION_TRAIL_VISIBLE_LIMIT = 140;

// Plain-English description of when each agent activates. Shown in the
// expanded pane when the phase is still idle so the operator never sees
// an "empty / idle" panel without context. Critic and Supervisor in
// particular are dormant most of the time — Critic only fires when
// inline review is triggered (errors / pass-claim review), Supervisor
// only fires after three failed attempts in thorough mode.
function idleAgentHint(phaseId) {
  switch (phaseId) {
    case 'architect':
      return 'Architect activates when a new suite is generated from requirements.';
    case 'planner':
      return 'Planner activates after the Architect to order test-case dependencies into execution waves.';
    case 'conductor':
      return 'Conductor activates when the run starts — it drives the live browser through each approved case.';
    case 'critic':
      return 'Critic activates inline when a turn errors or when the Conductor claims a pass — it reviews the snapshot and can block bad pass claims.';
    case 'verifier':
      return 'Verdict Verifier activates only in thorough mode, after the run. It is a second opinion on PASSED cases — it asks whether the assertions that passed actually prove the requirement, or the case passed on peripheral checks. Insufficient passes are escalated to needs-human. Fast mode (the default) skips it.';
    case 'supervisor':
      return 'Supervisor activates only in thorough mode, after three Conductor attempts have failed for the same case. Fast mode (the default) skips it.';
    default:
      return 'Not started yet.';
  }
}

export default function Theater() {
  const navigate = useNavigate();
  const toast = useToast();
  const { current, currentSprintId, generations, currentGenerationId } = useProject();
  const executionGenerationId = currentGenerationId || generations.find((generation) => generation.isCurrent)?.id || null;
  // Phase F.4 — pipeline accumulator moved into runStream so navigation
  // away from /live-pipeline doesn't wipe the view. Read directly from
  // context; no local mirror.
  const { subscribe, claudeRateLimit, resetPipelineState, dismissAgentWarning, latestRunId } = useRunStream();
  const { pipelineState, mcpSnapshot } = usePipelineState();
  const { phaseStatus, phaseOutput, phaseAttempt, logs, actionTrail, browserFrame, browserFrameSource, nowTestingStep, agentWarning, runSummary, cancelling: cancellingFromStream, actionCount, tokensThisRun } = pipelineState;

  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  // Phase log expansion lives in the timeline pane. By default only the active
  // / most recently active phase is expanded so the timeline doesn't grow into
  // a 5×log-panel monster.
  const [expandedPhase, setExpandedPhase] = useState(null);
  // Directive Fix 6 — Now Testing strip data. Scenarios list is fetched on
  // mount so we can map tcId → test case name + parent scenario name.
  const [scenarios, setScenarios] = useState([]);
  const [scenariosLoaded, setScenariosLoaded] = useState(false);
  const [lastFailedSummary, setLastFailedSummary] = useState(null);   // { lastRun, failedCount, failedCases }
  const [rerunning, setRerunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [resuming, setResuming] = useState(false);
  // Tracks whether the SERVER currently has a pipeline running for this user.
  // Survives WebSocket reconnects, page refreshes, and route navigation —
  // anything that would otherwise wipe local `phaseStatus`. Seeded by
  // /agents/status, kept fresh by phase events.
  //   null  = not checked yet (suppress empty state to avoid flicker)
  //   true  = pipeline is running on the server
  //   false = no pipeline running
  const [serverPipelineRunning, setServerPipelineRunning] = useState(null);

  // Auto-scroll the active phase log
  const logRefs = {
    architect:  useRef(null),
    planner:    useRef(null),
    conductor:  useRef(null),
    critic:     useRef(null),
    verifier:   useRef(null),
    supervisor: useRef(null),
  };

  // Phase F.4 — the runStream provider now accumulates phaseStatus / logs /
  // actionTrail / browserFrame / nowTestingStep / agentWarning / runSummary
  // ABOVE the route tree, so leaving and returning to this page preserves
  // everything. Theater only needs to subscribe for SIDE EFFECTS that aren't
  // state accumulation:
  //   - auto-expand the running phase
  //   - keep the active phase log auto-scrolled
  //   - flip serverPipelineRunning + refresh failed-cases on run.complete
  useEffect(() => {
    const unsub = subscribe((msg) => {
      if (msg.type === 'agent.phase.start') {
        // Skip auto-expanding the conductor's log pane on phase.start. The
        // conductor's log is overwhelmingly mcp tool-call narration
        // (snapshot taken / screenshot saved) which has no operator value
        // by default — the action trail surfaces the meaningful bits.
        // Auto-expanding for architect/planner/critic/supervisor is still
        // useful because their logs are short, substantive narration.
        // User explicitly asked: "if user clicks on it then it can open".
        if (msg.phase !== 'conductor') {
          setExpandedPhase(msg.phase);
        }
        setServerPipelineRunning(true);
      }
      if (msg.type === 'agent.phase.log') {
        setServerPipelineRunning(true);
        requestAnimationFrame(() => {
          const ref = logRefs[msg.phase];
          if (ref?.current) ref.current.scrollTop = ref.current.scrollHeight;
        });
      }
      if (msg.type === 'run.complete' || msg.type === 'run.inplace.complete') {
        setCancelling(false);
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

  // On mount / project change: ask the server whether a pipeline is currently
  // running for this user. Handles a mid-run navigation followed by tab focus
  // — without this, an idle phaseStatus would show the empty state on top of
  // an active server-side run. Local-only state (lastFailedSummary,
  // expandedPhase) is reset here; the WS-driven accumulator (pipelineState)
  // resets itself in the provider when current?.id changes.
  useEffect(() => {
    setLastFailedSummary(null);
    setExpandedPhase(null);
    if (!current) {
      setServerPipelineRunning(false);
      return;
    }
    let cancelled = false;
    api.get(`/projects/${current.id}/agents/status`)
      .then((data) => {
        if (cancelled) return;
        const isRunning = !!data.running;
        setServerPipelineRunning(isRunning);
        if (!isRunning) resetPipelineState();
      })
      .catch(() => { if (!cancelled) setServerPipelineRunning(false); });
    return () => { cancelled = true; };
  }, [current?.id, resetPipelineState]);

  // While we suspect a pipeline is running, re-poll /status every 8s. This
  // catches the case where the WS dropped silently mid-run and we missed the
  // final run.complete event — without it, the "running" hint would stick
  // forever after a real failure. Once we have a runSummary the run is
  // definitively done — kill the poll so we stop hitting the backend.
  useEffect(() => {
    if (!current || serverPipelineRunning !== true || runSummary) return;
    const id = setInterval(() => {
      api.get(`/projects/${current.id}/agents/status`)
        .then((data) => setServerPipelineRunning(!!data.running))
        .catch(() => { setServerPipelineRunning(false); });
    }, 8000);
    return () => clearInterval(id);
  }, [current?.id, serverPipelineRunning, runSummary]);

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

  // Fetch project scenarios so the Now Testing strip can map tcId →
  // test case name + parent scenario name. Refetched on every project
  // change. Cheap (single GET) — same endpoint Test Cases page uses.
  useEffect(() => {
    if (!current) { setScenarios([]); setScenariosLoaded(false); return; }
    let cancelled = false;
    setScenariosLoaded(false);
    api.get(`/projects/${current.id}/scenarios`)
      .then((res) => { if (!cancelled) setScenarios(Array.isArray(res?.scenarios) ? res.scenarios : []); })
      .catch(() => { if (!cancelled) setScenarios([]); })
      .finally(() => { if (!cancelled) setScenariosLoaded(true); });
    return () => { cancelled = true; };
  }, [current?.id]);

  const approvedAutomatableCount = useMemo(() => (
    (scenarios || []).reduce((total, scenario) => total + (Array.isArray(scenario.cases)
      ? scenario.cases.filter((c) => ['approved', 'running'].includes(c.status) && (c.automatability || 'automatable') !== 'manual').length
      : 0), 0)
  ), [scenarios]);
  const canStartExecution = scenariosLoaded && approvedAutomatableCount > 0;

  const handleRerunFailed = useCallback(async () => {
    if (!current) return;
    setRerunning(true);
    // Reset the persisted pipeline state with an optimistic seed: Architect +
    // Planner already ran (this is just a re-run of failed cases through
    // Conductor/Critic/Supervisor).
    resetPipelineState({
      phaseStatus: { architect: 'complete', planner: 'complete', conductor: 'idle', critic: 'idle', verifier: 'idle', supervisor: 'idle' },
    });
    try {
      const data = await api.post(`/projects/${current.id}/agents/rerun-failed`, { sprintId: currentSprintId || null });
      toast.success(`Re-running ${data.caseCount} failed case(s). Watch below.`, { title: 'Re-run started' });
      setLastFailedSummary(null);
      setServerPipelineRunning(true);
    } catch (err) {
      const { title, message } = formatRunStartError(err, 'Could not re-run');
      toast.error(message, { title });
      // On launch error, knock the not-yet-started phases back to idle.
      resetPipelineState({
        phaseStatus: { architect: 'complete', planner: 'complete', conductor: 'idle', critic: 'idle', verifier: 'idle', supervisor: 'idle' },
      });
    } finally {
      setRerunning(false);
    }
  }, [current, toast, currentSprintId, resetPipelineState]);

  const resumeRunId = latestRunId || (lastFailedSummary?.lastRun?.status === 'cancelled' ? lastFailedSummary.lastRun.id : null);

  const handleResume = useCallback(async () => {
    if (!current || !resumeRunId) return;
    setResuming(true);
    resetPipelineState({
      phaseStatus: { architect: 'complete', planner: 'complete', conductor: 'idle', critic: 'idle', verifier: 'idle', supervisor: 'idle' },
    });
    try {
      const data = await api.post(`/projects/${current.id}/agents/resume`, { runId: resumeRunId });
      toast.success(data.message || 'Resuming run from where it stopped.', { title: 'Run resumed' });
    } catch (err) {
      const { title, message } = formatRunStartError(err, 'Could not resume');
      toast.error(message, { title });
      resetPipelineState({
        phaseStatus: { architect: 'complete', planner: 'complete', conductor: 'idle', critic: 'idle', verifier: 'idle', supervisor: 'idle' },
      });
    } finally {
      setResuming(false);
    }
  }, [current, resumeRunId, toast, resetPipelineState]);

  const handleStart = useCallback(async () => {
    if (!current || startingRef.current) return;
    if (!canStartExecution) {
      toast.error('Approve at least one automatable test case before running.', { title: 'Nothing to execute' });
      return;
    }
    startingRef.current = true;
    setStarting(true);
    setPickerCandidates(null);
    // Reset the persisted pipeline state, seeding Architect as already done
    // (it ran on Run Suite — Planner + Conductor pick up from here).
    resetPipelineState({
      phaseStatus: { architect: 'complete', planner: 'idle', conductor: 'idle', critic: 'idle', verifier: 'idle', supervisor: 'idle' },
    });
    try {
      await api.post(`/projects/${current.id}/agents/execute`, {
        sprintId: currentSprintId || null,
        generationId: executionGenerationId,
      });
      toast.success('Planner + Conductor running. Watch below.', { title: 'Execution started' });
      setServerPipelineRunning(true);
    } catch (err) {
      const { title, message } = formatRunStartError(err, 'Could not start');
      toast.error(message, { title });
      resetPipelineState();
      setServerPipelineRunning(false);
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [current, toast, currentSprintId, executionGenerationId, resetPipelineState, canStartExecution]);

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
  // "Pipeline running…" pill must hide once we have a runSummary OR the
  // user has acknowledged-cancel. Without the cancelling guard, clicking
  // Cancel left the pill spinning for 30–60 s while the agent finished
  // its current Claude call — visually indistinguishable from "still
  // running." The cancelling flag is set by the run.cancelling WS event
  // (emitted by /cancel after cancelRegistry.cancel succeeds) and cleared
  // on run.complete. anyRunning may briefly stay true while phases
  // haven't fired phase.complete yet, so we override it.
  const pipelineLive = !cancellingFromStream && (anyRunning || (serverPipelineRunning === true && !runSummary));
  // We only show the empty "Ready to execute" hero once we've confirmed
  // nothing is running on the server AND there's nothing to surface from a
  // prior run (no LastRunSummary, no failed-cases banner) — otherwise we'd
  // hide useful context behind a generic empty state.
  // When a run JUST finished in this page session, runSummary holds its
  // result and the green completion banner below renders. In that case we
  // suppress the yellow "PREVIOUS RUN" banner + the LastRunSummary card —
  // they describe the SAME run and would print the 25/6/5 triple twice
  // more on the page (the BrowserFrame footer used to print it a fourth
  // time; removed). The yellow banner is only meaningful when the user
  // arrives at this page idle and the LAST historical run had failures.
  const hasFailureBanner = !pipelineLive && !runSummary && !!lastFailedSummary?.lastRun && lastFailedSummary.failedCount > 0;
  const hasLastRun = !pipelineLive && !runSummary && !!lastFailedSummary?.lastRun;
  const showEmptyHero = allIdle && serverPipelineRunning === false && !runSummary && !hasLastRun;
  // Joined a run that's already in progress — phaseStatus is all idle locally
  // (because we missed the events), but the server says it's still going.
  const joinedMidRun = allIdle && serverPipelineRunning === true;
  // Whether to render the three-pane execution view at all. Once a run has
  // touched any phase (running or complete) OR the server reports activity,
  // we show the panes so the user has somewhere to watch frames + actions.
  const showExecutionView = pipelineLive || !allIdle || !!runSummary;

  // Only show pipeline nodes that can actually run in the project's exec mode.
  // Verdict Verifier and Supervisor are THOROUGH-only (the server skips both in
  // fast mode), so rendering them as permanently-idle in fast just confuses the
  // operator. Critic stays in both modes — it still fires on tool errors in
  // fast. Gated by execMode (fast|thorough), NOT by model (gemini/claude).
  const isThorough = current?.execMode === 'thorough';
  const visiblePhases = isThorough
    ? PHASES
    : PHASES.filter((p) => p.id !== 'verifier' && p.id !== 'supervisor');

  return (
    <div className="relative flex flex-col h-full overflow-hidden">
      {/* Aurora background — same Overview / Reports vocabulary so the
          three pages feel like one product. Sticky 100dvh trick keeps
          the orbs filling the viewport without consuming flow height. */}
      <div
        className="sticky top-0 overflow-hidden pointer-events-none"
        style={{ height: '100dvh', marginBottom: '-100dvh', zIndex: 0 }}
        aria-hidden="true"
      >
        <AuroraBackground />
      </div>
      <PageHeader title="Live Pipeline" subtitle={current.name + ' — Execute approved test cases'}>
        {!pipelineLive && !cancellingFromStream && (
          <div className="inline-flex items-center gap-2">
            {/* Resume button — shown when last run was cancelled (in-session
                via WS runSummary, or cross-session via lastFailedSummary). */}
            {resumeRunId && (runSummary?.cancelled || lastFailedSummary?.lastRun?.status === 'cancelled') && (
              <Button
                size="md"
                variant="secondary"
                onClick={handleResume}
                disabled={resuming}
                loading={resuming}
                title="Continue from the last test case that was running — skips cases that already passed/failed"
              >
                <RefreshCcw className="w-3.5 h-3.5" />
                Resume run
              </Button>
            )}
            <Button
              size="md"
              onClick={handleStart}
              disabled={starting || pipelineLive || !canStartExecution}
              loading={starting}
              title={!canStartExecution ? 'Approve at least one automatable test case before running' : undefined}
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              {allIdle ? 'Execute approved' : 'Run again'}
            </Button>
          </div>
        )}
        {/* Cancellation-acknowledged state — pipeline isn't "running" any
            more from the user's perspective (no fresh actions), but the
            agent is still winding down its current Claude call + MCP
            teardown. Stays visible until run.complete fires. */}
        {cancellingFromStream && !runSummary && (
          <span className="inline-flex items-center gap-2 px-3 h-9 rounded-pill bg-warn-50 text-warn-800 text-xs font-semibold border border-warn-200">
            <Loader2 className="w-3 h-3 animate-spin" />
            Stopping — finishing current step…
          </span>
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

      <main className="relative z-10 flex-1 overflow-y-auto bg-transparent">
        <div className="max-w-7xl mx-auto px-page py-8 space-y-5">
          {/* Directive Fix 12 — slim cost / speed strip at the top of the page.
              Replaces the V2 "What just happened" panel that the user
              dismissed (the action trail already serves as live commentary).
              Uses plain English labels — no EST / TPM acronyms per the
              directive's Rule 4 (no orphaned labels). Only shows when there's
              live activity to report on. */}
          {(pipelineLive || actionTrail.length > 0) && (
            <CostStrip
              actionCount={actionCount || 0}
              tokensThisRun={tokensThisRun}
              rateLimit={claudeRateLimit}
            />
          )}
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
                onClick={dismissAgentWarning}
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
                phases={visiblePhases}
              />
              <NowTestingStrip actions={actionTrail} scenarios={scenarios} stepInfo={nowTestingStep} runActive={pipelineLive} />
              {/* Explicit completion banner — fires when run.complete has
                  populated runSummary AND the pipeline is no longer live.
                  Gives the user a definitive "this is over" signal instead
                  of leaving them to infer it from green checkmarks. Also
                  reconciles the case-count gap: the pipeline footer says
                  "14 scenarios · 42 cases" but only N execute because
                  manual scenarios sit out of the Conductor path. We surface
                  that delta here so the numbers stop looking like a bug. */}
              {!pipelineLive && runSummary && (() => {
                const manualScenarioCount = (scenarios || []).filter(
                  (s) => Array.isArray(s.cases) && s.cases.length > 0 && s.cases.every((c) => c.automatability === 'manual')
                ).length;
                const manualCaseCount = (scenarios || []).reduce(
                  (a, s) => a + (Array.isArray(s.cases) ? s.cases.filter((c) => c.automatability === 'manual').length : 0),
                  0
                );
                const passRate = runSummary.passRate != null ? runSummary.passRate : (
                  runSummary.total ? Math.round((runSummary.passed || 0) / runSummary.total * 100) : 0
                );
                return (
                  <section className="rounded-card border border-success-200 bg-success-50/60 px-4 py-3 flex items-center gap-3" aria-label="Run finished">
                    <div className="w-9 h-9 rounded-md bg-success-100 flex items-center justify-center shrink-0">
                      <CheckCircle2 className="w-5 h-5 text-success-700" aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-2xs font-bold uppercase tracking-[0.14em] text-success-800">
                        {runSummary.cancelled ? 'Run cancelled' : 'Run complete'}
                      </div>
                      <div className="text-sm text-ink-800 mt-0.5 tabular-nums">
                        {runSummary.total != null ? `${runSummary.total} automated case${runSummary.total === 1 ? '' : 's'} executed · ` : ''}
                        <span className="text-success-700 font-semibold">{runSummary.passed || 0} passed</span>
                        {' · '}
                        <span className="text-danger-700 font-semibold">{runSummary.failed || 0} failed</span>
                        {' · '}
                        <span className="text-warn-700 font-semibold">{runSummary.blocked || 0} blocked</span>
                        {runSummary.skipped > 0 && (
                          <>{' · '}<span className="text-ink-600">{runSummary.skipped} skipped</span></>
                        )}
                        <span className="text-ink-500"> · pass rate <span className="font-semibold text-ink-800">{passRate}%</span></span>
                      </div>
                      {manualCaseCount > 0 && (
                        <div className="text-2xs text-ink-500 mt-1">
                          {manualScenarioCount} manual scenario{manualScenarioCount === 1 ? '' : 's'} ({manualCaseCount} case{manualCaseCount === 1 ? '' : 's'}) are intentionally outside the automated run — review them on the Test Cases · Manual tab.
                        </div>
                      )}
                    </div>
                  </section>
                );
              })()}
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-4">
                <BrowserFrame
                  frame={browserFrame}
                  frameSource={browserFrameSource}
                  runSummary={runSummary}
                  onOpenReports={() => navigate(latestRunId ? `/reports?runId=${encodeURIComponent(latestRunId)}` : '/reports')}
                />
                <ActionTrail
                  actions={actionTrail}
                  scenarios={scenarios}
                  conductorActive={pipelineLive}
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
                <Button
                  onClick={handleStart}
                  loading={starting}
                  disabled={!canStartExecution}
                  title={!canStartExecution ? 'Approve at least one automatable test case before running' : undefined}
                >
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
// HORIZONTAL pipeline strip (per user request 2026-05-27). Five agent nodes
// laid out left-to-right with animated connector lines between them:
//   - Idle node:     soft outlined circle
//   - Running node:  filled circle with a pulsing aurora-glow ring + spinner
//   - Complete node: filled circle with a checkmark + success colour
//   - Failed node:   filled circle with X + danger colour
//   - Cancelled:     same as idle but with a slash
//
// Connector lines:
//   - Both endpoints idle  → grey
//   - From done → running  → animated flowing gradient (CSS keyframes)
//   - From done → done     → solid success
//
// Per-node click toggles an expanded LOG PANEL rendered BELOW the strip
// (not inline within it — the strip stays compact). The previously-vertical
// `expandedPhase` model is preserved 1:1 so parent state doesn't change.
function PhaseTimeline({ phaseStatus, phaseOutput, phaseAttempt, logs, logRefs, expandedPhase, onTogglePhase, phases = PHASES }) {
  // Map phase status → ring + bg + text colours. Using palette tokens only
  // (per CLAUDE.md: no raw Tailwind colours).
  const NODE_THEME = {
    idle:      { ring: 'border-ink-200',     bg: 'bg-white',      icon: 'text-ink-500' },
    running:   { ring: 'border-info-500',    bg: 'bg-info-50',    icon: 'text-info-700' },
    complete:  { ring: 'border-success-500', bg: 'bg-success-50', icon: 'text-success-700' },
    failed:    { ring: 'border-danger-500',  bg: 'bg-danger-50',  icon: 'text-danger-700' },
    cancelled: { ring: 'border-warn-500',    bg: 'bg-warn-50',    icon: 'text-warn-700' },
  };
  const themeFor = (s) => NODE_THEME[s] || NODE_THEME.idle;

  const expandedPhaseDef = phases.find((p) => p.id === expandedPhase);
  const expandedLogs = expandedPhaseDef ? (logs[expandedPhaseDef.id] || []) : [];

  return (
    <section className="glass overflow-hidden" aria-label="Phase timeline">
      <header className="px-4 py-3 border-b border-ink-100 flex items-center gap-2">
        <GitBranch className="w-4 h-4 text-ink-500" />
        <h2 className="text-2xs font-bold uppercase tracking-wider text-ink-700">Pipeline</h2>
      </header>

      {/* Horizontal strip — overflow-x-auto on small screens; on lg+ all five
          nodes fit. Each node is a button that toggles its phase's expanded
          log panel. Connector lines live BETWEEN nodes. */}
      <ol className="flex items-stretch gap-0 px-4 py-5 overflow-x-auto">
        {phases.map((phase, idx) => {
          const status = phaseStatus[phase.id] || 'idle';
          const nextStatus = idx < phases.length - 1 ? (phaseStatus[phases[idx + 1].id] || 'idle') : null;
          const Icon = phase.icon;
          const theme = themeFor(status);
          const meta = phaseStatusMeta(status);
          const isExpanded = expandedPhase === phase.id;
          const attempt = phaseAttempt[phase.id];
          const output = phaseOutput[phase.id];
          const isLast = idx === phases.length - 1;

          // Connector: animated flow when "this is done and next is running"
          // (data is conceptually moving from this node to the next).
          // Solid success when both done. Grey otherwise.
          const flowing = status === 'complete' && nextStatus === 'running';
          const solidDone = status === 'complete' && nextStatus === 'complete';
          const partialDone = status === 'complete' && (nextStatus === 'idle' || !nextStatus);

          return (
            <li key={phase.id} className="flex items-stretch flex-1 min-w-[120px]">
              {/* Node column */}
              <div className="flex flex-col items-center gap-2 min-w-[100px] shrink-0">
                <button
                  type="button"
                  onClick={() => onTogglePhase(phase.id)}
                  aria-expanded={isExpanded}
                  aria-controls={isExpanded ? `phase-log-${phase.id}` : undefined}
                  className={`relative w-14 h-14 rounded-full flex items-center justify-center border-2 transition-all duration-300 ${theme.ring} ${theme.bg} ${isExpanded ? 'ring-2 ring-offset-2 ring-ink-300' : ''}`}
                  title={`${phase.label} — ${meta.label}`}
                >
                  {/* Running glow halo — soft outer ring that pulses */}
                  {status === 'running' && (
                    <span
                      aria-hidden="true"
                      className="absolute inset-[-6px] rounded-full border-2 border-info-300 animate-ping opacity-60"
                    />
                  )}
                  {/* Icon swap by status */}
                  {status === 'running'
                    ? <Loader2 className={`w-5 h-5 animate-spin ${theme.icon}`} />
                    : status === 'complete'
                    ? <CheckCircle2 className={`w-5 h-5 ${theme.icon}`} />
                    : status === 'failed'
                    ? <XCircle className={`w-5 h-5 ${theme.icon}`} />
                    : status === 'cancelled'
                    ? <X className={`w-5 h-5 ${theme.icon}`} />
                    : <Icon className={`w-5 h-5 ${theme.icon}`} />}
                </button>
                <div className="flex flex-col items-center gap-0.5 text-center">
                  <span className="text-2xs font-semibold text-ink-900 leading-tight">{phase.label}</span>
                  <div className="flex items-center gap-1">
                    <span className={`text-[10px] font-bold uppercase tracking-wider ${meta.text}`}>{meta.label}</span>
                    {typeof attempt === 'number' && attempt > 1 && (
                      <span className="text-[10px] font-bold uppercase tracking-wider px-1 py-0.5 rounded-pill bg-warn-50 text-warn-700">
                        try {attempt}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Connector line to the next node (none after the last) */}
              {!isLast && (
                <div className="flex-1 flex items-center pt-[28px] min-w-[24px]" aria-hidden="true">
                  <div className="w-full h-0.5 bg-ink-200 relative overflow-hidden rounded-full">
                    {/* Solid completion — past-tense edge */}
                    {(solidDone || partialDone) && (
                      <div className="absolute inset-0 bg-success-400" />
                    )}
                    {/* Flowing — done→running. CSS gradient slides left-to-right. */}
                    {flowing && (
                      <div
                        className="absolute inset-0"
                        style={{
                          background: 'linear-gradient(90deg, var(--tw-gradient-from, rgb(34 197 94)) 0%, rgb(56 189 248) 50%, transparent 100%)',
                          backgroundSize: '200% 100%',
                          animation: 'pipelineFlow 1.6s linear infinite',
                        }}
                      />
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {/* Output summaries — quiet sub-row showing latest one-liner per phase
          that has output. Operator can quickly scan what each agent produced
          without expanding the log. */}
      <div className="px-4 pb-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-500">
        {phases.map((phase) => {
          const o = phaseOutput[phase.id];
          if (!o) return null;
          return (
            <span key={phase.id} className="font-mono truncate max-w-[260px]">
              <span className="text-ink-700 font-semibold">{phase.label.split(' ')[0]}:</span>{' '}
              {summariseOutput(phase.id, o)}
            </span>
          );
        })}
      </div>

      {/* Expanded log — appears BELOW the strip when a node is selected. The
          ref is whichever phase is expanded, so the log container can
          auto-scroll on new entries. */}
      {expandedPhaseDef && (
        <div id={`phase-log-${expandedPhaseDef.id}`} className="px-4 pb-4 border-t border-ink-100">
          <div className="flex items-center justify-between pt-3 pb-2">
            <span className="text-xs font-semibold text-ink-900">{expandedPhaseDef.label} log</span>
            <button
              type="button"
              onClick={() => onTogglePhase(expandedPhaseDef.id)}
              className="text-2xs uppercase tracking-wider font-bold text-ink-500 hover:text-ink-900"
            >
              Close
            </button>
          </div>
          <div
            ref={logRefs[expandedPhaseDef.id]}
            className="text-[13px] leading-relaxed max-h-72 overflow-y-auto bg-ink-900 text-ink-100 rounded-md p-3 space-y-1.5"
          >
            {expandedLogs.length === 0 ? (
              <div className="text-ink-400 italic font-mono text-xs">
                {(phaseStatus[expandedPhaseDef.id] || 'idle') === 'idle'
                  ? idleAgentHint(expandedPhaseDef.id)
                  : 'Waiting for first log line…'}
              </div>
            ) : (
              expandedLogs.map((l, i) => <LogLine key={i} entry={l} />)
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// ── BrowserFrame ──────────────────────────────────────────────────
// Centre pane. The live browser screencast plus its control strip
// (pause / zoom / fullscreen / pick element). Fullscreen here is a CSS
// expand inside the app — predictable, Esc-to-exit, no cursor surprises.
const BrowserFrame = React.memo(function BrowserFrame({ frame, frameSource, runSummary, onOpenReports }) {
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
    // Alignment fix: previously the outer section grew unbounded (header +
    // h-clamp inner + optional footer) while ActionTrail used h-clamp on its
    // outer. That made the BrowserFrame visibly taller than the trail in the
    // 2-col layout. Now BOTH sections use the same h-clamp on their outer +
    // a flex-1 min-h-0 inner, so they stretch to the same height.
    <section
      className={
        fullscreen
          ? 'fixed inset-0 z-50 bg-ink-900 flex flex-col'
          : 'glass overflow-hidden flex flex-col h-[clamp(420px,64vh,720px)]'
      }
      aria-label="Live browser"
    >
      <div className={`px-4 py-3 border-b ${fullscreen ? 'border-ink-700 bg-ink-900' : 'border-ink-100 bg-white'} flex items-center justify-between flex-wrap gap-2`}>
        <div className="flex items-center gap-2">
          <div className={`w-7 h-7 rounded-md flex items-center justify-center ${fullscreen ? 'bg-info-900/40' : 'bg-info-50'}`}>
            <Eye className={`w-3.5 h-3.5 ${fullscreen ? 'text-info-300' : 'text-info-600'}`} />
          </div>
          <div className="min-w-0">
            <h3 className={`text-sm font-semibold tracking-tight ${fullscreen ? 'text-white' : 'text-ink-900'}`}>
              {runSummary ? 'Browser (run finished)' : 'Live Browser'}
            </h3>
            <p className={`text-2xs ${fullscreen ? 'text-ink-400' : 'text-ink-500'}`}>
              {runSummary
                ? (runSummary.cancelled ? 'Final frame · run cancelled' : 'Final frame · run complete')
                  : paused
                    ? 'Paused — last frame held'
                  : frame
                    ? (frameSource === 'cdp_screencast' ? 'Live CDP screencast' : 'Live screenshot fallback')
                    : 'Waiting for first frame…'}
            </p>
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
          {runSummary && !fullscreen && (
            <Button size="sm" variant="secondary" onClick={onOpenReports} title="Open full Reports">
              <FileText className="w-3.5 h-3.5" />
              Reports
            </Button>
          )}
        </div>
      </div>

      <div className={`relative ${fullscreen ? 'flex-1 bg-ink-900' : 'bg-ink-900 flex-1 min-h-0'} flex items-center justify-center overflow-auto`}>
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

      {/* Run-summary footer removed — was the fourth place printing the same
          passed/failed/blocked triple on the page (PREVIOUS RUN banner,
          pipeline footer, RUN COMPLETE banner all carry it). The completion
          banner above the browser frame is the canonical place now. */}
    </section>
  );
});

// ── ActionTrail ───────────────────────────────────────────────────
// Right pane. Tool calls + narration from the Conductor, plus the picker
// candidates panel pinned to the top when a pick lands. Sticky scroll to
// bottom by default; user scrolling up holds the position until they
// scroll back to within ~20px of the bottom.
const ActionTrail = React.memo(function ActionTrail({ actions, scenarios, conductorActive }) {
  const scrollRef = useRef(null);
  const stickRef = useRef(true);
  const lastActivityAtRef = useRef(Date.now());
  const lastActionCountRef = useRef(actions?.length || 0);
  const [heartbeatAt, setHeartbeatAt] = useState(Date.now());

  useEffect(() => {
    const nextCount = actions?.length || 0;
    if (nextCount !== lastActionCountRef.current) {
      lastActionCountRef.current = nextCount;
      lastActivityAtRef.current = Date.now();
      setHeartbeatAt(Date.now());
    }
  }, [actions?.length]);

  useEffect(() => {
    if (!conductorActive) return undefined;
    lastActivityAtRef.current = Date.now();
    setHeartbeatAt(Date.now());
    const interval = setInterval(() => setHeartbeatAt(Date.now()), 5000);
    return () => clearInterval(interval);
  }, [conductorActive]);

  const heartbeatSeconds = Math.max(0, Math.floor((heartbeatAt - lastActivityAtRef.current) / 1000));
  const visibleActions = React.useMemo(() => {
    if (!Array.isArray(actions)) return [];
    return actions.length > ACTION_TRAIL_VISIBLE_LIMIT ? actions.slice(-ACTION_TRAIL_VISIBLE_LIMIT) : actions;
  }, [actions]);
  const hiddenActionCount = Math.max(0, (actions?.length || 0) - visibleActions.length);
  const tcMap = React.useMemo(() => {
    const m = new Map();
    (scenarios || []).forEach((s, si) => {
      (s.cases || []).forEach((c, ci) => {
        m.set(c.id, {
          name: c.name,
          scenarioName: s.name,
          label: `TS-${si + 1} · TC-${ci + 1}`,
        });
      });
    });
    return m;
  }, [scenarios]);
  const stepDetailMap = React.useMemo(() => {
    const m = new Map();
    (scenarios || []).forEach((s) => {
      (s.cases || []).forEach((c) => {
        (c.steps || []).forEach((step, index) => {
          const expected = String(
            step?.expected
            || step?.operationCheck?.expected
            || step?.verify?.text
            || step?.verify?.url
            || step?.verify?.element?.name
            || step?.verify?.field?.name
            || ''
          ).trim();
          const verifyKind = String(
            step?.verify?.kind
            || step?.operationCheck?.kind
            || step?.expectedKind
            || ''
          ).trim();
          if (expected || verifyKind) {
            m.set(`${c.id}:${index + 1}`, { expected, verifyKind });
          }
        });
      });
    });
    return m;
  }, [scenarios]);
  // Live fallback name map (audit #4/#6): any trail row now carries the human
  // tcName from the backend, so even a case not present in the loaded `scenarios`
  // resolves to a name instead of a raw UUID.
  const liveNameById = React.useMemo(() => {
    const m = new Map();
    for (const a of (actions || [])) if (a && a.tcId && a.tcName) m.set(a.tcId, a.tcName);
    return m;
  }, [actions]);
  const resolveCaseName = React.useCallback(
    (tcId) => (tcId ? (tcMap.get(tcId)?.name || liveNameById.get(tcId) || `case ${String(tcId).slice(0, 8)}`) : 'Test case'),
    [tcMap, liveNameById],
  );
  // Separate counters (audit #5): real browser actions vs internal checks/logs/markers.
  const { browserCount, internalCount } = React.useMemo(() => {
    // Internal browser_* tools (probes, not user-facing execution).
    const INTERNAL_BROWSER_TOOLS = new Set(['browser_snapshot', 'browser_take_screenshot', 'browser_evaluate', 'browser_wait_for']);
    let b = 0; let n = 0;
    for (const a of (actions || [])) {
      const flaggedInternal = a.stepMarker || a.dataRowStart || a.agentNarration || a.syntheticOperationCheck || a.syntheticStepAssertion
        || a.diagnostic || a.actionStatus === 'diagnostic' || a.terminalStop === true;
      // A REAL browser action is an ACTUAL browser_* execution tool (click/navigate/
      // type/fill/select/press…) that is NOT an internal snapshot/evaluate/wait/
      // screenshot probe and NOT flagged internal. Everything else — narrate,
      // agent_narration, planned/dry-run steps, synthetic checks, non-browser or
      // unknown tools — counts as INTERNAL. This prevents planned/no-execution
      // narration from inflating the browser count (the operator's "fake actions").
      const isRealBrowser = typeof a.tool === 'string'
        && ((a.tool.startsWith('browser_') && !INTERNAL_BROWSER_TOOLS.has(a.tool))
          || a.tool === 'deterministic_dom_fill'
          || a.tool === 'deterministic_dom_click'
          || a.tool === 'deterministic_dom_fill_recovery'
          || a.tool === 'deterministic_dom_click_recovery')
        && !flaggedInternal;
      if (isRealBrowser) b += 1; else n += 1;
    }
    return { browserCount: b, internalCount: n };
  }, [actions]);

  // Detect whether the user has scrolled away from the bottom. If so, stop
  // auto-scrolling so they can read history without the panel yanking them
  // back to the latest entry.
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    stickRef.current = fromBottom < 20;
  };

  // requestAnimationFrame wait so the new entry's height is laid out before
  // we measure scrollHeight — without this, fast back-to-back updates can
  // leave the scroll position a row short of the actual bottom.
  useEffect(() => {
    if (!stickRef.current) return;
    const id = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [visibleActions]);

  return (
    <section
      className="glass overflow-hidden flex flex-col h-[clamp(420px,64vh,720px)]"
      aria-label="Action trail"
    >
      <header className="px-4 py-3 border-b border-ink-100 flex items-center gap-2">
        <Bot className="w-4 h-4 text-ink-500" />
        <h3 className="text-2xs font-bold uppercase tracking-wider text-ink-700">Live Execution Transcript</h3>
        {actions.length > 0 && (
          <span className="ml-auto text-2xs font-mono text-ink-400 tabular-nums" title="Browser actions vs internal checks/logs">
            <span className="text-ink-600">{browserCount}</span> browser
            <span className="mx-1 text-ink-300">·</span>
            <span className="text-ink-500">{internalCount}</span> internal
          </span>
        )}
      </header>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-3 space-y-2"
      >
        {actions.length === 0 ? (
          <div className="text-xs text-ink-400 italic">
            {conductorActive
              ? `Preparing browser execution · ${heartbeatSeconds}s elapsed · checking status every 8s`
              : 'Live execution transcript will appear here once execution starts.'}
          </div>
        ) : (
          // Stable key on action.ts — when the trail grows past 200 entries
          // and the array gets sliced, index keys would shift and React
          // would remount every row, defeating the ActionLine memo. ts is
          // assigned at receive-time so it's unique-enough within a session.
          [
            hiddenActionCount > 0 ? (
              <div key="trimmed-action-trail" className="text-2xs text-ink-500 bg-ink-50 border border-ink-100 rounded-md px-3 py-2">
                Showing latest {visibleActions.length} actions. {hiddenActionCount} older entries are retained in the run history.
              </div>
            ) : null,
            ...visibleActions.map((a, i) => {
            const previous = i > 0 ? visibleActions[i - 1] : null;
            const showBoundary = a.tcId && (!previous || previous.tcId !== a.tcId);
            const info = showBoundary ? tcMap.get(a.tcId) : null;
            // Phase 5 — data-row iteration divider. A data-driven case re-runs its
            // steps once PER ROW; without a divider the repeated "Step 1..N"
            // sequences read as "gone mad / repeating randomly" (issue #4). When a
            // step-1 marker appears INSIDE the same case (not at a case boundary),
            // a new row's iteration has started — delimit it so each row is legible.
            const isIterationRestart = !showBoundary
              && (a.stepMarker || a.tool === 'step_marker')
              && Number(a.stepIndex) === 1
              && previous && previous.tcId === a.tcId;
            return (
              <React.Fragment key={`${a.ts}-${i}`}>
                {isIterationRestart && (
                  <div className="pt-1" aria-label="next data row iteration">
                    <div className="flex items-center gap-2 text-2xs text-ink-400">
                      <span className="h-px flex-1 bg-ink-100" />
                      <span className="font-semibold uppercase tracking-wider">next data row</span>
                      <span className="h-px flex-1 bg-ink-100" />
                    </div>
                  </div>
                )}
                {showBoundary && (
                  <div className="pt-2 first:pt-0">
                    <div className="rounded-md border border-info-100 bg-info-50/70 px-3 py-2">
                      <div className="text-2xs font-bold uppercase tracking-wider text-info-700">
                        {info?.label || 'Test case'}
                      </div>
                      <div className="text-xs font-semibold text-ink-800 truncate" title={resolveCaseName(a.tcId)}>
                        {resolveCaseName(a.tcId)}
                      </div>
                      {info?.scenarioName && (
                        <div className="text-2xs text-ink-500 truncate" title={info.scenarioName}>
                          {info.scenarioName}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                <ActionLine
                  action={(() => {
                    if (!(a.stepMarker || a.tool === 'step_marker') || !a.tcId || !a.stepIndex) return a;
                    const detail = stepDetailMap.get(`${a.tcId}:${a.stepIndex}`) || {};
                    return {
                      ...a,
                      expected: a.expected || detail.expected || '',
                      verifyKind: a.verifyKind || detail.verifyKind || '',
                    };
                  })()}
                />
              </React.Fragment>
            );
          })]
        )}
        {conductorActive && actions.length > 0 && (
          <div className="text-2xs text-info-700 bg-info-50 border border-info-100 rounded-md px-3 py-2" role="status">
            Waiting for browser response · {heartbeatSeconds}s since the last action · still monitoring
          </div>
        )}
      </div>
    </section>
  );
});

// ── CostStrip ─────────────────────────────────────────────────────
// Directive Fix 12 + user explicit ask: replace V2's "What just happened"
// panel + EST/TPM acronym block with a slim, plain-English status strip
// at the top of the page. Three numbers max — anything more belongs in
// Reports, not in the operator's live watching view.
//
// `actionCount`  — non-utility tool calls so far this run (excludes
//                  snapshots / screenshots which don't represent user
//                  actions). Multiplied by an indicative per-action cost
//                  for the "Estimated cost" line.
// `rateLimit`    — { tokens, requests, capturedAt } from the latest
//                  claude.rate-limit WS event. Null until Claude has
//                  responded at least once this session.
//
// Per-action cost factor is a heuristic for visibility, not a billing
// number. Real cost comes from the LLM provider's invoice — we surface
// "rough Claude spend so far" so the operator can spot a runaway loop.
function CostStrip({ actionCount, tokensThisRun, rateLimit }) {
  const PER_ACTION_USD = 0.012;
  const estUsd = (actionCount * PER_ACTION_USD).toFixed(2);

  // Tokens this run — cumulative input + output from claude.rate-limit
  // deltas tracked in the reducer. Monotonic within a run; resets at
  // architect.phase.start. Falls back to "—" until the first rate-limit
  // event lands (rare; usually the architect call kicks one within
  // seconds). Prefer compact "12.3K" / "1.2M" formatting so the strip
  // stays one line at small widths.
  let tokensLabel = '—';
  if (typeof tokensThisRun === 'number' && tokensThisRun > 0) {
    if (tokensThisRun < 1000) tokensLabel = `${tokensThisRun}`;
    else if (tokensThisRun < 1_000_000) tokensLabel = `${(tokensThisRun / 1000).toFixed(1)}K`;
    else tokensLabel = `${(tokensThisRun / 1_000_000).toFixed(2)}M`;
  }

  // Per-minute capacity headroom (the upstream Anthropic rate-limit window).
  // Shown as an inline pill ONLY when we have a fresh sample — it's a
  // throttling-risk gauge, not a budget gauge, so it stays out of the
  // primary "this run" row.
  const tokens = rateLimit?.tokens;
  const minuteRemaining = tokens?.limit && tokens?.remaining != null
    ? Math.max(0, Math.min(100, Math.round((tokens.remaining / tokens.limit) * 100)))
    : null;

  return (
    <section
      className="rounded-card border border-ink-200 bg-white/80 backdrop-blur-sm shadow-sm px-4 py-2 flex items-center gap-5 flex-wrap text-xs"
      aria-label="Run cost and rate"
    >
      <div className="flex items-center gap-2">
        <Gauge className="w-3.5 h-3.5 text-ink-500" aria-hidden="true" />
        <span className="text-ink-500">Browser actions</span>
        <span className="font-semibold text-ink-900 tabular-nums">{actionCount}</span>
      </div>
      <span className="text-ink-200">·</span>
      <div className="flex items-center gap-2">
        <span className="text-ink-500">Estimated cost</span>
        <span className="font-semibold text-ink-900 tabular-nums">${estUsd}</span>
      </div>
      <span className="text-ink-200">·</span>
      <div className="flex items-center gap-2" title="Cumulative input + output tokens spent by Claude on this run.">
        <span className="text-ink-500">Tokens this run</span>
        <span className="font-semibold text-ink-900 tabular-nums">{tokensLabel}</span>
      </div>
      {minuteRemaining != null && (
        <>
          <span className="text-ink-200">·</span>
          <div className="flex items-center gap-2" title="Anthropic per-minute rate-limit headroom remaining. Resets every minute — not a budget.">
            <span className="text-ink-500">Minute capacity</span>
            <div className="w-20 h-1.5 bg-ink-100 rounded-full overflow-hidden">
              <div
                className={`h-full ${minuteRemaining < 10 ? 'bg-danger-500' : minuteRemaining < 30 ? 'bg-warn-500' : 'bg-success-500'}`}
                style={{ width: `${minuteRemaining}%` }}
                aria-hidden="true"
              />
            </div>
            <span className="font-semibold text-ink-900 tabular-nums">{minuteRemaining}% free</span>
          </div>
        </>
      )}
      <span className="ml-auto text-ink-400 text-2xs">Speed: Normal</span>
    </section>
  );
}

// ── NowTestingStrip ───────────────────────────────────────────────
// Directive Fix 6: shows the CURRENT test case name (not a UUID), the
// parent scenario, and the live step counter (Step X of Y). Sits directly
// above the live browser so the user instantly knows what's being verified.
// Reads from:
//   · `actions`  — the action trail; last `tcId` we saw IS the case in flight
//   · `scenarios`— /scenarios payload fetched on mount, so we can map tcId
//                  → testCase.name + parent scenario.name
//   · `stepInfo` — { tcId, stepIndex, totalSteps } from WS step.* events
function NowTestingStrip({ actions, scenarios, stepInfo, runActive }) {
  // Build a tcId → { name, scenarioName, scenarioIndex, caseIndex } lookup
  // once per scenarios change. Scenario index = 1-based position in the
  // scenarios array; case index = 1-based position within scenario.cases.
  // These TS-N / TC-N labels are what stakeholders read at a glance during
  // the live demo ("TS-3 · TC-2 is running") — they're a UX channel, not
  // a DB identifier, so deriving from array position is intentional.
  const tcMap = React.useMemo(() => {
    const m = new Map();
    (scenarios || []).forEach((s, si) => {
      (s.cases || []).forEach((c, ci) => {
        m.set(c.id, {
          name: c.name,
          scenarioName: s.name,
          scenarioIndex: si + 1,
          caseIndex: ci + 1,
        });
      });
    });
    return m;
  }, [scenarios]);

  // Strip is meaningful ONLY while a run is in flight. After run.complete
  // we used to fall back to "last action trail tcId" and pin the strip to
  // the final case forever — making the page look stuck on TS-12 hours
  // after the run actually finished. If the run is no longer active, bail.
  if (!runActive) return null;
  // Active tcId is preferred from the live step event; fall back to the most
  // recent action's tcId so the strip populates even before step.start fires.
  const activeTcId = stepInfo?.tcId
    || [...(actions || [])].reverse().find((a) => a.tcId)?.tcId
    || null;
  if (!activeTcId) return null;

  const info = tcMap.get(activeTcId);
  // Fall back to names sent inline in the step.start WS payload — these are
  // always present so the strip shows the real name even before the /scenarios
  // HTTP fetch resolves (race condition on first load / mid-run navigation).
  const liveTcName = (actions || []).find((a) => a && a.tcId === activeTcId && a.tcName)?.tcName || null;
  const tcName = info?.name || stepInfo?.tcName || liveTcName || 'Loading test case…';
  const scenarioName = info?.scenarioName || stepInfo?.scenarioName || '';
  const tsLabel = info?.scenarioIndex ? `TS-${info.scenarioIndex}` : null;
  const tcLabel = info?.caseIndex ? `TC-${info.caseIndex}` : null;
  const stepLine = stepInfo && stepInfo.tcId === activeTcId && stepInfo.totalSteps
    ? `Step ${stepInfo.stepIndex || 1} of ${stepInfo.totalSteps}`
    : null;

  return (
    <section
      className="rounded-card border border-info-200 bg-white shadow-card overflow-hidden"
      aria-label="Now testing"
    >
      <div className="px-4 py-3 flex items-start gap-3">
        <div className="w-9 h-9 rounded-md bg-info-50 flex items-center justify-center shrink-0">
          <Loader2 className="w-4 h-4 text-info-600 animate-spin" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-2xs font-bold uppercase tracking-[0.14em] text-info-700 mb-0.5 flex items-center gap-2">
            <span>Now testing</span>
            {(tsLabel || tcLabel) && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-info-100 text-info-800 text-[10px] font-mono tabular-nums tracking-normal">
                {tsLabel}{tsLabel && tcLabel && ' · '}{tcLabel}
              </span>
            )}
          </div>
          <div className="text-sm font-semibold text-ink-900 leading-snug truncate" title={tcName}>{tcName}</div>
          {(scenarioName || stepLine) && (
            <div className="text-2xs text-ink-500 mt-0.5 tabular-nums truncate">
              {scenarioName && <>Scenario: <span className="text-ink-700">{scenarioName}</span></>}
              {scenarioName && stepLine && <span className="text-ink-300"> · </span>}
              {stepLine}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ── LastRunSummary ────────────────────────────────────────────────
// Idle-state card showing the most recent completed run at a glance:
// passed / failed / blocked / skipped counts, pass-rate bar, relative
// time. Click "Show details" to fetch the full run (via /runs/:id) and
// render a per-scenario breakdown + top failures inline. No navigation.
function LastRunSummary({ summary }) {
  const navigate = useNavigate();
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
  const activityAt = summary.lastActivityAt || summary.latestResultAt || summary.completedAt || summary.startedAt;
  const startedMs = summary.startedAt ? new Date(summary.startedAt).getTime() : 0;
  const activityMs = activityAt ? new Date(activityAt).getTime() : 0;
  const updatedAfterStart = startedMs && activityMs && activityMs - startedMs > 60000;
  const ago = activityAt ? timeAgo(activityAt) : '';

  const handleToggle = useCallback(async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !detail && !loading && summary.id) {
      setLoading(true);
      setError(null);
      try {
        const res = await api.get(`/runs/${summary.id}`);
        setDetail(res.run);
      } catch (err) {
        setError(err.message || 'Could not load run details.');
      } finally {
        setLoading(false);
      }
    }
  }, [expanded, detail, loading, summary.id]);

  const openFullReport = useCallback(() => {
    if (!summary.id) return;
    navigate(`/reports?runId=${encodeURIComponent(summary.id)}`);
  }, [navigate, summary.id]);

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
    <section className="glass overflow-hidden">
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
            {ago && <span className="text-2xs text-ink-500">· {updatedAfterStart ? 'updated ' : ''}{ago}</span>}
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
          <div className="flex flex-wrap justify-end gap-2">
            <button
              onClick={handleToggle}
              className="inline-flex items-center gap-1.5 px-3 h-8 rounded-md border border-ink-200 bg-white text-xs font-semibold text-ink-700 hover:border-ink-400 hover:bg-ink-50 focus-visible:outline-none focus-visible:shadow-ring transition-colors"
              aria-expanded={expanded}
              aria-controls="lastrun-detail"
            >
              {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              {expanded ? 'Hide details' : 'Show details'}
            </button>
            {summary.id && (
              <button
                onClick={openFullReport}
                className="inline-flex items-center gap-1.5 px-3 h-8 rounded-md border border-ink-200 bg-white text-xs font-semibold text-ink-700 hover:border-info-300 hover:text-info-700 hover:bg-info-50/40 focus-visible:outline-none focus-visible:shadow-ring transition-colors"
                title="Open this run in Reports"
              >
                <FileText className="w-3.5 h-3.5" />
                Full report
              </button>
            )}
          </div>
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
              {summary.id && (
                <div className="pt-1">
                  <button
                    type="button"
                    onClick={openFullReport}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-ink-200 bg-white text-xs font-semibold text-ink-700 hover:border-info-300 hover:text-info-700 hover:bg-info-50/40 focus-visible:outline-none focus-visible:shadow-ring transition-colors"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    Open full report
                  </button>
                </div>
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
    'spec-write': { marker: 'bg-accent-400', text: 'text-accent-200' },
    codegen:      { marker: 'bg-accent-400', text: 'text-accent-200' },
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

// Memoised so a 200-row ActionTrail doesn't redraw every row on every WS
// message. Each ActionLine's props only change when its action object is
// replaced, which happens at most once per row (when first inserted) —
// React.memo's default shallow compare is correct here because we never
// mutate the row object in place. Pre-memo, every WS tick re-rendered all
// 200 rows even though only the new bottom row changed — that re-render
// was the dominant cost during a mid-run pipeline. Now O(1) per tick.
const ActionLine = React.memo(function ActionLine({ action }) {
  // Directive Fix 10: render the conductor's humanized narration as the
  // primary content. Raw browser_* tool names are intentionally hidden —
  // they're machine internals, not user-facing language. Details (url /
  // locator / value) drop to a small mono line beneath for power users
  // who want to see what the AI was actually targeting.
  // Numbered step boundary — emitted when the conductor enters each step, so the
  // live trail reads "Step 1 · … / Step 2 · …" for EVERY step (incl. Fill/Click),
  // not only outcome-bearing ones.
  // First-class data-row boundary (audit): a labelled, valued header so repeated
  // Step 1..N sequences group under "Data row 3/6 · set · inputs · expected".
  if (action.tool === 'data_row_start' || action.dataRowStart) {
    const rowNo = (Number(action.dataRowIndex) || 0) + 1;
    if (!shouldShowDataRowUi(action, action.totalRows)) return null;
    // Defensive secret masking + column cap. The backend already sends a compact
    // preview, but historical/legacy rows may carry raw values.
    const SECRET_RE = /pass|pwd|secret|token|api[_-]?key|credential/i;
    const allInputs = action.inputs && typeof action.inputs === 'object' ? Object.entries(action.inputs) : [];
    const inputs = allInputs.slice(0, 4);
    const moreCount = Number.isFinite(Number(action.hiddenInputCount))
      ? Number(action.hiddenInputCount)
      : Math.max(0, (Number.isFinite(Number(action.inputCount)) ? Number(action.inputCount) : allInputs.length) - inputs.length);
    return (
      <div className="mt-3 first:mt-0 rounded-md border border-accent-200 bg-accent-50/60 px-3 py-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-2xs font-bold uppercase tracking-wider text-accent-700">
            Data row {rowNo}{action.totalRows ? `/${action.totalRows}` : ''}
          </span>
          {action.dataSetName && <span className="text-2xs text-ink-500">· {action.dataSetName}</span>}
          {action.dataRowLabel && <span className="text-2xs font-medium text-ink-700">· {action.dataRowLabel}</span>}
          {action.expected != null && (
            <span className="text-2xs px-1.5 py-0.5 rounded-pill bg-ink-100 text-ink-600">expected: {String(action.expected).slice(0, 40)}</span>
          )}
        </div>
        {inputs.length > 0 && (
          <div className="mt-1 text-2xs text-ink-600 font-mono break-words">
            {inputs.map(([k, v]) => `${k}=${SECRET_RE.test(k) ? '••••••' : String(v == null ? '' : v).slice(0, 40)}`).join(' · ')}
            {moreCount > 0 ? ` · +${moreCount} more` : ''}
          </div>
        )}
      </div>
    );
  }
  if (action.tool === 'step_marker' || action.stepMarker) {
    return (
      <div className="mt-2 border-l-2 border-info-400 pl-3 py-1">
        <span className="text-2xs font-bold uppercase tracking-wider text-info-700">
          {action.narration || `Step ${action.stepIndex || ''}`}
        </span>
        {action.expected && (
          <div className="mt-1 text-2xs leading-relaxed text-ink-500 break-words">
            <span className="font-semibold text-ink-600">Checking:</span>{' '}
            {String(action.expected).slice(0, 220)}
            {action.verifyKind && (
              <span className="ml-1 text-ink-400">({String(action.verifyKind).slice(0, 40)})</span>
            )}
          </div>
        )}
      </div>
    );
  }
  // Model chain-of-thought is not execution evidence and must not be projected to
  // operators. Step boundaries and deterministic action/check events already give
  // the useful progress signal.
  if (action.tool === 'agent_narration' || action.agentNarration) {
    const text = action.narration || action.message || action.text;
    if (!text) return null;
    return (
      <div className="pl-3 py-1 border-l-2 border-accent-300 bg-accent-50/40 rounded-r-md">
        <span className="text-xs text-ink-800 leading-snug italic">
          {text}
        </span>
      </div>
    );
  }
  // Internal ratification gate — demote to a human line instead of "final_verdict
  // REJECTED" orchestration noise (audit #7).
  if (action.tool === 'final_verdict') {
    return (
      <div className="pl-3 py-0.5">
        <span className="text-2xs text-ink-500 italic">QAAI is checking the required assertions before finalizing…</span>
      </div>
    );
  }
  if (action.tool === 'resolution_diagnostic' || action.resolutionDiagnostic) {
    const isAmbiguous = action.reason === 'multiple_semantic_snapshot_targets';
    const title = isAmbiguous ? 'Ambiguous Element Reference' : 'Element Not Found';
    const message = isAmbiguous
      ? `Multiple elements matched the reference "${action.target || 'element'}". QAAI found ${action.candidateCount || 0} matching candidates.`
      : `Could not locate "${action.target || 'element'}" on the page.`;
    return (
      <div className="mt-2 border-l-2 border-danger-400 bg-danger-50/50 pl-3 py-2 rounded-r-md">
        <div className="flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-danger-600" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="text-2xs font-bold uppercase tracking-wider text-danger-700">
              {title}
            </div>
            <div className="text-sm text-ink-800 leading-snug mt-0.5">
              {message}
            </div>
            {Array.isArray(action.candidates) && action.candidates.length > 0 && (
              <div className="mt-1.5 text-2xs text-ink-600 font-mono">
                <span className="font-semibold text-ink-700 block mb-0.5">Matched candidates:</span>
                <ul className="list-disc pl-3 space-y-0.5">
                  {action.candidates.slice(0, 4).map((c, i) => (
                    <li key={i} className="truncate">
                      [{c.role}] "{c.accessibleName || c.name || 'unnamed'}" {c.ref ? `(${c.ref})` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }
  if (action.tool === 'proof_diagnostic' || action.proofDiagnostic) {
    if (action.message === 'same_semantic_owner_reresolved_after_rerender') {
      return (
        <div className="pl-3 py-1 border-l-2 border-info-300 text-2xs text-ink-500 italic">
          The page changed, so I re-located the "{action.name || 'element'}" {action.role || 'element'} to keep going.
        </div>
      );
    }
    if (action.message === 'proof_claim_discrepancy') {
      return (
        <div className="mt-2 border-l-2 border-warn-400 bg-warn-50/50 pl-3 py-2 rounded-r-md">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-warn-600" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="text-2xs font-bold uppercase tracking-wider text-warn-700">
                Assertion Discrepancy Found
              </div>
              <div className="text-sm text-ink-800 leading-snug mt-0.5">
                Expected: <span className="font-semibold text-ink-950">"{action.expected}"</span> but observed: <span className="font-semibold text-ink-950">"{action.observed}"</span>.
              </div>
            </div>
          </div>
        </div>
      );
    }
    return null;
  }
  // Dedicated terminal-stop row (audit #1): a deterministic precondition stop. Rendered
  // as a prominent BLOCKED banner (warn tone — a precondition issue, not a defect) so
  // the Live Pipeline explains WHY it stopped at the exact moment, not a silent gap.
  if (action.terminalStop) {
    return (
      <div className="mt-2 border-l-2 border-warn-400 bg-warn-50/70 pl-3 py-2 rounded-r-md">
        <div className="flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-warn-600" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="text-2xs font-bold uppercase tracking-wider text-warn-700">
              Stopped{action.stepIndex ? ` at Step ${action.stepIndex}` : ''}
              {action.stepTitle ? ` · ${String(action.stepTitle).slice(0, 60)}` : ''}
              {' — '}{action.blockedReason === 'test_data_invalid' ? 'invalid test data / missing precondition' : 'precondition not met'}
            </div>
            <div className="text-sm text-ink-800 leading-snug mt-0.5">
              Required precondition was not met. Remaining dependent steps were not executed.
            </div>
          </div>
        </div>
      </div>
    );
  }
  const isStepAssertion = action.tool === 'step_assertion' || action.syntheticStepAssertion;
  const isOperationCheck = action.tool === 'operation_check' || action.syntheticOperationCheck;
  if (isStepAssertion || isOperationCheck) {
    const status = action.status || (action.matched === true ? 'pass' : action.matched === false ? 'fail' : 'running');
    const labels = isOperationCheck
      ? { pass: 'Synced', fail: 'Blocked', blocked: 'Blocked', warning: 'Checkpoint', skipped: 'Skipped', running: 'Checking', fallback: 'Operational check' }
      : { pass: 'Matched', fail: 'Not matched', skipped: 'Recorded', running: 'Validating', fallback: 'Verification' };
    const tone = {
      pass: { border: 'border-success-400', icon: CheckCircle2, iconCls: 'text-success-600', chip: 'bg-success-50 text-success-700', label: labels.pass },
      fail: { border: 'border-danger-400', icon: XCircle, iconCls: 'text-danger-600', chip: 'bg-danger-50 text-danger-700', label: labels.fail },
      blocked: { border: 'border-warn-400', icon: AlertCircle, iconCls: 'text-warn-600', chip: 'bg-warn-50 text-warn-700', label: labels.blocked || 'Blocked' },
      warning: { border: 'border-warn-300', icon: AlertCircle, iconCls: 'text-warn-600', chip: 'bg-warn-50 text-warn-700', label: labels.warning || 'Checkpoint' },
      skipped: { border: 'border-ink-300', icon: AlertCircle, iconCls: 'text-ink-500', chip: 'bg-ink-100 text-ink-600', label: labels.skipped },
      running: { border: 'border-info-300', icon: Loader2, iconCls: 'text-info-600 animate-spin', chip: 'bg-info-50 text-info-700', label: labels.running },
    }[status] || { border: 'border-info-300', icon: ShieldCheck, iconCls: 'text-info-600', chip: 'bg-info-50 text-info-700', label: labels.fallback };
    const Icon = tone.icon;
    const evidence = action.evidence || action.reason || '';
    const checkSummary = isOperationCheck
      ? (status === 'pass' ? 'Required page effect confirmed' : status === 'running' ? 'Checking required page effect' : 'Required page effect not confirmed')
      : (status === 'pass' ? 'Required assertion matched' : status === 'running' ? 'Checking required assertion' : 'Required assertion did not match');
    return (
      <div className={`border-l-2 ${tone.border} pl-3 py-1.5`}>
        <div className="flex items-start gap-2">
          <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${tone.iconCls}`} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-2xs font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-pill ${tone.chip}`}>
                {tone.label}
              </span>
              <span className="text-sm text-ink-800 leading-snug">
                {checkSummary}
              </span>
            </div>
            {(action.expected || evidence) && (
              <div className="text-2xs text-ink-500 mt-1 leading-relaxed">
                {action.expected && <span>{isOperationCheck ? 'Required' : 'Expected'}: <span className="text-ink-700">{String(action.expected).slice(0, 140)}</span></span>}
                {evidence && <span>{action.expected ? ' · ' : ''}{String(evidence).slice(0, 180)}</span>}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }
  const details = [
    action.args?.url,
    action.args?.locator,
    action.args?.element,
    action.error,
  ].filter(Boolean);
  const lifecycle = action.actionStatus || null;
  const isDiagnostic = lifecycle === 'diagnostic' || action.helperTraffic === true || action.diagnostic === true;
  const toolName = String(action.tool || '').toLowerCase();
  const target = String(action.args?.element || action.args?.locator || action.target || '').slice(0, 100);
  const conciseAction = (() => {
    if (action.narration && !isDiagnostic && !/snapshot|evaluate|screenshot/.test(toolName)) {
      return action.narration;
    }
    if (isDiagnostic || /snapshot|evaluate|screenshot/.test(toolName)) return 'Inspect page state';
    if (/navigate|goto|open/.test(toolName)) return `Navigate to ${action.args?.url || target || 'requested page'}`;
    if (/fill|type|input/.test(toolName)) return `Fill${target ? ` · ${target}` : ' required field'}`;
    if (/click|tap/.test(toolName)) return `Click${target ? ` · ${target}` : ' required control'}`;
    if (/select/.test(toolName)) return `Select${target ? ` · ${target}` : ' required option'}`;
    if (/scroll/.test(toolName)) return `Scroll page${target ? ` · ${target}` : ''}`;
    if (/hover/.test(toolName)) return `Hover${target ? ` · ${target}` : ''}`;
    if (/press/.test(toolName)) return `Press key ${action.args?.key || target || ''}`;
    if (/check|radio/.test(toolName)) return `Set control${target ? ` · ${target}` : ''}`;
    if (/upload/.test(toolName)) return `Upload file${target ? ` · ${target}` : ''}`;
    if (/clear/.test(toolName)) return `Clear field${target ? ` · ${target}` : ''}`;
    if (/wait/.test(toolName)) return 'Wait for page effect';
    return 'Perform browser action';
  })();
  const lineTone = isDiagnostic
    ? 'border-ink-200'
    : lifecycle === 'failed'
    ? 'border-danger-300'
    : lifecycle === 'attempted'
      ? 'border-info-300'
      : 'border-ink-200';
  const displayNarration = lifecycle === 'failed' ? `Action failed · ${conciseAction}` : conciseAction;
  return (
    <div className={`border-l-2 ${lineTone} pl-3 py-1.5`}>
      <div className="text-sm text-ink-800 leading-snug flex items-start gap-2">
        <span>{displayNarration}</span>
      </div>
      {details.length > 0 && (
        <div className="text-2xs text-ink-500 mt-1 font-mono truncate">
          {details.join(' · ')}
        </div>
      )}
    </div>
  );
});

function RerunFailedBanner({ summary, loading, onRerun, onDismiss }) {
  const { lastRun, failedCount, failedCases } = summary || {};
  const activityAt = lastRun?.lastActivityAt || lastRun?.latestResultAt || lastRun?.completedAt || lastRun?.startedAt;
  const startedMs = lastRun?.startedAt ? new Date(lastRun.startedAt).getTime() : 0;
  const activityMs = activityAt ? new Date(activityAt).getTime() : 0;
  const updatedAfterStart = startedMs && activityMs && activityMs - startedMs > 60000;
  const ago = activityAt ? timeAgo(activityAt) : '';
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
            {ago && <span className="text-2xs text-ink-500">· {updatedAfterStart ? 'updated ' : ''}{ago}</span>}
          </div>
          <h3 className="text-md font-semibold text-ink-900 tracking-tight mt-0.5">
            {failedCount} test case{failedCount === 1 ? '' : 's'} did not pass
          </h3>
          <p className="text-sm text-ink-600 mt-0.5">
            <span className="text-success-700 font-semibold tabular-nums">{lastRun?.passed || 0} passed</span>
            {' · '}
            <span className="text-danger-700 font-semibold tabular-nums">{lastRun?.failed || 0} failed</span>
            {' · '}
            {/* CRIT-6: blocked + skipped are SEPARATE counters. The banner was
                showing lastRun.skipped labelled as "blocked" — so 14 blocked
                cases displayed as "0 blocked" while the per-case list showed
                them as BLOCKED. Read the right column. */}
            <span className="text-warn-700 font-semibold tabular-nums">{lastRun?.blocked || 0} blocked</span>
            {(lastRun?.skipped || 0) > 0 && (
              <>{' · '}<span className="text-ink-500 font-semibold tabular-nums">{lastRun.skipped} skipped</span></>
            )}
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

  // Fix: previously rendered a <span role="button"> INSIDE a parent <button>
  // for the Copy action when expanded. Nesting interactive elements is
  // invalid HTML and browsers handle it inconsistently — Chrome was
  // swallowing toggle clicks, which is exactly what the user reported
  // ("clicking does not open"). Restructure as a header ROW with two
  // sibling buttons (toggle + copy) so each handles its own click.
  return (
    <section className="rounded-card border border-ink-200 bg-white shadow-card">
      <div className="w-full flex items-center gap-3 px-4 py-3 rounded-card">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-3 flex-1 min-w-0 text-left hover:opacity-80 transition-opacity"
          aria-expanded={expanded}
          aria-controls="dom-snapshot-body"
        >
          {expanded ? <ChevronDown className="w-4 h-4 text-ink-500 shrink-0" /> : <ChevronRight className="w-4 h-4 text-ink-500 shrink-0" />}
          <Network className="w-4 h-4 text-info-700 shrink-0" />
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
        </button>
        {expanded && (
          <button
            type="button"
            onClick={onCopy}
            className="inline-flex items-center gap-1 px-2.5 h-7 rounded-md border border-ink-200 bg-white text-xs font-semibold text-ink-700 hover:border-ink-400 hover:bg-ink-50 shrink-0"
            title="Copy the full snapshot to clipboard"
          >
            <Copy className="w-3 h-3" />
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
      {expanded && (
        <div id="dom-snapshot-body" className="border-t border-ink-200 px-4 py-3">
          <pre className="text-2xs font-mono text-ink-700 whitespace-pre-wrap break-all max-h-[420px] overflow-y-auto leading-relaxed">
            {snapshot.snapshot}
          </pre>
        </div>
      )}
    </section>
  );
}
