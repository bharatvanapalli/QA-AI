import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Play, Check, X, Sparkles, FileText, Loader2, ChevronDown, ChevronRight,
  Plus, Minus, ThumbsUp, Zap, Target, CheckCircle2, XCircle, Circle, Clock,
  StopCircle, Search, MoreVertical, RotateCw, Trash2,
} from 'lucide-react';
import api, { ApiError } from '../lib/apiClient';
import { useProject } from '../store/project';
import { useToast } from '../lib/useToast';
import { useRunStream } from '../store/runStream';
import Button from '../components/ui/Button';
import ProjectPicker from '../components/ProjectPicker';
import EmptyState from '../components/EmptyState';
import {
  PRIORITY_META, CATEGORY_META, TYPE_META, statusMeta,
} from '../lib/statusMeta';
import { estimateArchitectCost, formatTokens } from '../lib/costEstimate';

// Human-readable terminology mapping — keeps "PASS", "SMOKE", "FUNCTIONAL"
// (raw enum tokens) out of the UI in favour of standardised labels.
const STATUS_DISPLAY = {
  pass:     'Passed',
  fail:     'Failed',
  blocked:  'Blocked',
  skipped:  'Skipped',
  running:  'Running',
  pending:  'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
};

const TYPE_COLOURS = Object.fromEntries(
  Object.entries(TYPE_META).map(([k, v]) => [k, v.cls])
);

export default function TestCases() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const justGenerated = searchParams.get('just') === 'generated';
  // Module filter from URL — Overview's "Run module" CTA deep-links here as
  // `/test-cases?module=<name>` so the user lands on a pre-filtered list
  // ready to approve and run. Read-once on mount and on URL change.
  const moduleParam = searchParams.get('module') || null;
  const toast = useToast();
  const { current } = useProject();
  const { running, subscribe } = useRunStream();
  const [scenarios, setScenarios] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [approving, setApproving] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());
  const [filter, setFilter] = useState('all'); // all | P0 | P1 | P2 | P3 | <category>
  // Status filter is a SECOND axis — combines with the priority/type filter
  // so the user can ask "only Failed P0 cases" by clicking the Failed pill
  // and the P0 chip. null = no status filter (show every status).
  const [statusFilter, setStatusFilter] = useState(null);
  // Confidence floor — third axis. Architect emits confidence 70-99 per case;
  // filtering lets the user say "I only trust ≥90% cases for this run."
  // null = no floor (show all). Values: 70 (default min) / 80 / 90.
  const [confidenceMin, setConfidenceMin] = useState(null);
  // Full-text search across name + assertions. Cmd+K opens the modal; typed
  // text filters scenarios + cases inline.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  // Bulk-select mode — when on, every case row gets a checkbox and a top
  // bar offers approve / reject / delete on the selection. Set of TC ids.
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkIds, setBulkIds] = useState(() => new Set());
  // Per-scenario regenerate in flight — keyed by scenarioId so multiple
  // scenarios could in theory regenerate in parallel (we don't allow that in
  // practice but the state shape is correct for the future).
  const [regenScenarioId, setRegenScenarioId] = useState(null);
  // Refs to each scenario card — scroll-to-first-match jumps here when the
  // user clicks a stat pill or selects a search result.
  const scenarioRefs = useRef(new Map());
  // Inline phase indicator — drives the in-page banner that surfaces
  // architect / analyst progress without depending on the floating widget.
  // Listens to the same WS messages the global AgentRunningIndicator does;
  // we duplicate locally because the page is the canonical owner of this
  // context when the work originated here.
  const [activePhase, setActivePhase] = useState(null);   // 'architect' | 'analyst' | null
  const [phaseLog, setPhaseLog] = useState('');
  const [phaseStatus, setPhaseStatus] = useState('idle'); // idle | running | cancelling | cancelled | complete | error
  const [phaseStartedAt, setPhaseStartedAt] = useState(0);
  const [phaseElapsed, setPhaseElapsed] = useState(0);
  const phaseStartedAtRef = useRef(0);

  const load = useCallback(async () => {
    if (!current) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await api.get(`/projects/${current.id}/scenarios`);
      const list = res.scenarios || [];
      setScenarios(list);
      // Expand P0 by default
      const next = new Set();
      list.forEach((s) => {
        if (s.priority === 'P0') next.add(s.id);
      });
      setExpanded(next);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [current, toast]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const unsub = subscribe((msg) => {
      // Scope WS to active project so two tabs in different projects don't
      // overwrite each other's case statuses or banner state.
      if (msg.projectId && current?.id && msg.projectId !== current.id) return;

      if (msg.type === 'result' && msg.tcId) {
        setScenarios((all) =>
          all.map((s) => ({
            ...s,
            cases: s.cases.map((c) => (c.id === msg.tcId ? { ...c, status: msg.status } : c)),
          }))
        );
      }
      if (msg.type === 'run.complete') load();

      // Inline phase tracking — only architect + analyst surface in the
      // page banner. Conductor / Critic / Supervisor stay in Live Pipeline.
      if (msg.type === 'agent.phase.start' && (msg.phase === 'architect' || msg.phase === 'analyst')) {
        setActivePhase(msg.phase);
        setPhaseStatus('running');
        setPhaseLog('');
        const now = Date.now();
        setPhaseStartedAt(now);
        phaseStartedAtRef.current = now;
      } else if (msg.type === 'agent.phase.log' && (msg.phase === 'architect' || msg.phase === 'analyst')) {
        if (msg.message) setPhaseLog(msg.message);
        setPhaseStatus((prev) => (prev === 'idle' ? 'running' : prev));
        if (!phaseStartedAtRef.current) {
          const now = Date.now();
          setPhaseStartedAt(now);
          phaseStartedAtRef.current = now;
        }
      } else if (msg.type === 'agent.phase.complete' && (msg.phase === 'architect' || msg.phase === 'analyst')) {
        if (msg.cancelled || msg.error === 'cancelled') {
          setPhaseStatus('cancelled');
        } else if (msg.error) {
          setPhaseStatus('error');
          setPhaseLog(msg.error);
        } else {
          setPhaseStatus('complete');
        }
      }
    });
    return unsub;
  }, [subscribe, load, current?.id]);

  // Reset banner on project switch
  useEffect(() => {
    setActivePhase(null);
    setPhaseStatus('idle');
    setPhaseLog('');
    setPhaseStartedAt(0);
    phaseStartedAtRef.current = 0;
  }, [current?.id]);

  // Tick elapsed time during running / cancelling phases.
  useEffect(() => {
    if (phaseStatus !== 'running' && phaseStatus !== 'cancelling') return;
    const id = setInterval(() => setPhaseElapsed(Math.floor((Date.now() - phaseStartedAtRef.current) / 1000)), 500);
    return () => clearInterval(id);
  }, [phaseStatus]);

  // Auto-dismiss terminal banner states after a short window so they don't
  // clutter the page once the user has had time to see them.
  useEffect(() => {
    if (phaseStatus === 'idle' || phaseStatus === 'running' || phaseStatus === 'cancelling') return;
    const ms = phaseStatus === 'cancelled' ? 5_000 : phaseStatus === 'complete' ? 8_000 : 10_000;
    const t = setTimeout(() => setActivePhase(null), ms);
    return () => clearTimeout(t);
  }, [phaseStatus]);

  const handleTerminate = useCallback(async () => {
    if (!current || phaseStatus !== 'running') return;
    setPhaseStatus('cancelling');
    try {
      await api.post(`/projects/${current.id}/agents/cancel`, {});
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Could not cancel' });
      setPhaseStatus('running');
    }
  }, [current, phaseStatus, toast]);

  const handleGenerate = useCallback(async () => {
    if (!current) return;
    setGenerating(true);
    try {
      const res = await api.post(`/projects/${current.id}/scenarios/generate`, { replace: true });
      toast.success(
        `${res.stats.scenarios} scenarios · ${res.stats.cases} test cases`,
        { title: 'Architect agent finished' }
      );
      await load();
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Generation failed' });
    } finally {
      setGenerating(false);
    }
  }, [current, toast, load]);

  const handleApproveAll = useCallback(async () => {
    if (!current) return;
    setApproving(true);
    try {
      await api.post(`/projects/${current.id}/test-cases/approve-all`, {});
      await load();
      toast.success('All pending test cases approved.');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setApproving(false);
    }
  }, [current, toast, load]);

  const [selecting, setSelecting] = useState(false);
  const handleSmartSelect = useCallback(async () => {
    if (!current) return;
    setSelecting(true);
    try {
      const res = await api.post(`/projects/${current.id}/analyst/select-impacted`, {});
      toast.success(
        `${res.impacted} of ${res.total} scenario(s) flagged as impacted by Release Notes.`,
        { title: 'Smart selection complete' }
      );
      await load();
    } catch (err) {
      // Specific UX for NO_RELEASE_NOTES — the analyst service now returns
      // this code instead of marking everything impacted. We point the user
      // back to Run Suite to upload the missing doc.
      if (err instanceof ApiError && err.payload?.code === 'NO_RELEASE_NOTES') {
        toast.error(err.payload.message, {
          title: 'No release notes',
          // Slight extra TTL because the message has actionable guidance.
          ttl: 8000,
        });
      } else {
        const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
        toast.error(msg, { title: 'Smart selection failed' });
      }
    } finally {
      setSelecting(false);
    }
  }, [current, toast, load]);

  const handleApproveImpactedOnly = useCallback(async () => {
    if (!current) return;
    const impactedCases = scenarios
      .filter((s) => s.impacted)
      .flatMap((s) => s.cases.filter((c) => c.status === 'pending'));
    if (!impactedCases.length) {
      toast.error('No impacted scenarios with pending cases. Run Smart selection first.');
      return;
    }
    setApproving(true);
    try {
      const res = await api.post(`/projects/${current.id}/test-cases/bulk-update`, {
        ids: impactedCases.map((c) => c.id),
        status: 'approved',
      });
      await load();
      toast.success(`Approved ${res.updated} case(s) in impacted scenarios.`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setApproving(false);
    }
  }, [current, scenarios, toast, load]);

  const setStatus = async (tc, status) => {
    try {
      await api.put(`/projects/${current.id}/test-cases/${tc.id}`, { status });
      await load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleExecute = useCallback(async () => {
    if (!current) return;
    const approved = scenarios.flatMap((s) => s.cases.filter((c) => c.status === 'approved'));
    if (!approved.length) {
      toast.error('Approve at least one test case before running.');
      return;
    }
    setExecuting(true);
    try {
      await api.post(`/projects/${current.id}/agents/execute`, {});
      toast.success(`${approved.length} test case(s) queued for execution.`, { title: 'Pipeline started' });
      navigate('/live-pipeline');
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Execution failed' });
    } finally {
      setExecuting(false);
    }
  }, [current, scenarios, toast, navigate]);

  // ⚠ Previously the byPriority tallies were mutated OUTSIDE of useMemo on
  // every render. Because useMemo returned the same `counts` object across
  // renders, every re-render (filter click, expand toggle, etc.) ran the
  // forEach loop again on the same object — doubling the numbers each time.
  // Compute everything inside the memo so the result is pure and stable.
  const counts = useMemo(() => {
    const allCases = scenarios.flatMap((s) => s.cases);
    // Scenario-level priority tallies (P0..P3 counts scenarios, not cases).
    const byPriority = { P0: 0, P1: 0, P2: 0, P3: 0 };
    for (const s of scenarios) {
      byPriority[s.priority] = (byPriority[s.priority] || 0) + 1;
    }
    // Approval-state counts come from TC.status (post-CRIT-6, this only
    // holds pending|approved|rejected|running).
    const pending  = allCases.filter((t) => t.status === 'pending').length;
    const approved = allCases.filter((t) => t.status === 'approved').length;
    const rejected = allCases.filter((t) => t.status === 'rejected').length;
    const running  = allCases.filter((t) => t.status === 'running').length;
    // Execution-state counts come from latestResult (CRIT-6 derives these
    // from RunResult so TC.status doesn't double-book the approval and
    // execution semantics). A case with no latestResult is "not yet run".
    const pass     = allCases.filter((t) => t.latestResult?.status === 'pass').length;
    const fail     = allCases.filter((t) => t.latestResult?.status === 'fail').length;
    const blocked  = allCases.filter((t) => t.latestResult?.status === 'blocked').length;
    const skipped  = allCases.filter((t) => t.latestResult?.status === 'skipped').length;
    const unrun    = allCases.filter((t) => !t.latestResult).length;
    return {
      scenarios: scenarios.length,
      total: allCases.length,
      pending, approved, rejected, running,
      pass, fail, blocked, skipped, unrun,
      byPriority,
    };
  }, [scenarios]);

  // Predicate for a single case under the active status filter.
  // - pass/fail/blocked/skipped  → derived from latestResult.status
  // - approved/pending/rejected  → derived from TC.status (approval lifecycle)
  // - unrun                      → no latestResult attached
  const matchesStatusFilter = useCallback(
    (c) => {
      if (!statusFilter) return true;
      if (statusFilter === 'pass') return c.latestResult?.status === 'pass';
      if (statusFilter === 'fail') return c.latestResult?.status === 'fail';
      if (statusFilter === 'blocked') return c.latestResult?.status === 'blocked';
      if (statusFilter === 'skipped') return c.latestResult?.status === 'skipped';
      if (statusFilter === 'unrun') return !c.latestResult;
      // Approval-state filters
      return c.status === statusFilter;
    },
    [statusFilter]
  );

  const matchesConfidence = useCallback(
    (c) => !confidenceMin || (typeof c.confidence === 'number' && c.confidence >= confidenceMin),
    [confidenceMin]
  );

  const matchesSearch = useCallback(
    (c) => {
      const q = searchQuery.trim().toLowerCase();
      if (!q) return true;
      return (
        (c.name || '').toLowerCase().includes(q) ||
        (c.assertions || '').toLowerCase().includes(q)
      );
    },
    [searchQuery]
  );

  // Visible scenarios — combine priority/type axis with status axis +
  // confidence axis + search query + module URL param. When any of these
  // narrow at the case level, also drop scenarios with no remaining cases
  // so the page doesn't render empty cards.
  const visibleScenarios = useMemo(() => {
    let list = scenarios;
    // Module filter (from `?module=…` URL param) — applied first so the
    // other axes only narrow within the requested module.
    if (moduleParam) {
      list = list.filter((s) => s.module === moduleParam);
    }
    if (filter !== 'all') {
      if (['P0', 'P1', 'P2', 'P3'].includes(filter)) {
        list = list.filter((s) => s.priority === filter);
      } else {
        list = list.filter((s) => s.category === filter);
      }
    }
    const narrowsCases = statusFilter || confidenceMin || searchQuery.trim();
    if (narrowsCases) {
      list = list
        .map((s) => ({
          ...s,
          cases: s.cases.filter((c) => matchesStatusFilter(c) && matchesConfidence(c) && matchesSearch(c)),
        }))
        .filter((s) => s.cases.length > 0);
    }
    return list;
  }, [scenarios, moduleParam, filter, statusFilter, confidenceMin, searchQuery, matchesStatusFilter, matchesConfidence, matchesSearch]);

  const toggleStatusFilter = useCallback((s) => {
    setStatusFilter((cur) => (cur === s ? null : s));
  }, []);

  // Scroll-to-first-match — invoked when user clicks a status pill so the
  // viewport jumps to the first scenario card whose cases survived the
  // filter, instead of leaving them staring at a static page wondering
  // whether the click did anything. MUST be declared before the effect
  // that uses it — `useCallback` desugars to a `const` binding, so
  // referencing it from an earlier line in the component body triggers a
  // temporal-dead-zone throw on render.
  const scrollToFirstVisible = useCallback(() => {
    if (!visibleScenarios.length) return;
    const firstId = visibleScenarios[0].id;
    const node = scenarioRefs.current.get(firstId);
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [visibleScenarios]);

  // After the filter changes and visibleScenarios re-renders, jump the
  // viewport to the first matching scenario card. RAF gives React one
  // frame to land the filtered list before we measure positions.
  const skipScrollRef = useRef(true);
  useEffect(() => {
    if (skipScrollRef.current) { skipScrollRef.current = false; return; }
    const id = requestAnimationFrame(() => scrollToFirstVisible());
    return () => cancelAnimationFrame(id);
  }, [statusFilter, confidenceMin, scrollToFirstVisible]);

  // ── Bulk select handlers ──────────────────────────────────
  const allVisibleCaseIds = useMemo(
    () => visibleScenarios.flatMap((s) => s.cases.map((c) => c.id)),
    [visibleScenarios]
  );
  const toggleBulk = (id) => setBulkIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selectAllVisible = () => setBulkIds(new Set(allVisibleCaseIds));
  const clearBulk = () => setBulkIds(new Set());
  const exitBulk = () => { setBulkMode(false); clearBulk(); };

  const bulkUpdateStatus = useCallback(async (status) => {
    if (!current || bulkIds.size === 0) return;
    try {
      const res = await api.post(`/projects/${current.id}/test-cases/bulk-update`, {
        ids: [...bulkIds], status,
      });
      toast.success(`${status === 'approved' ? 'Approved' : status === 'rejected' ? 'Rejected' : 'Updated'} ${res.updated} case${res.updated === 1 ? '' : 's'}.`);
      await load();
      clearBulk();
    } catch (err) {
      toast.error(err.message);
    }
  }, [current, bulkIds, toast, load]);

  const bulkDelete = useCallback(async () => {
    if (!current || bulkIds.size === 0) return;
    // No DELETE endpoint exists for individual TestCases yet — but bulk
    // update to 'rejected' is the closest non-destructive equivalent and
    // keeps cases out of the Run scope (Conductor only picks 'approved').
    // True hard-delete is Phase 12 (data retention).
    try {
      await api.post(`/projects/${current.id}/test-cases/bulk-update`, {
        ids: [...bulkIds], status: 'rejected',
      });
      toast.success(`Marked ${bulkIds.size} case${bulkIds.size === 1 ? '' : 's'} as rejected.`);
      await load();
      clearBulk();
    } catch (err) {
      toast.error(err.message);
    }
  }, [current, bulkIds, toast, load]);

  // ── Per-scenario regenerate ───────────────────────────────
  const handleRegenerateScenario = useCallback(
    async (scenario) => {
      if (!current || regenScenarioId) return;
      setRegenScenarioId(scenario.id);
      try {
        const res = await api.post(`/projects/${current.id}/scenarios/${scenario.id}/regenerate`, {});
        toast.success(
          `Regenerated "${scenario.name.slice(0, 40)}${scenario.name.length > 40 ? '…' : ''}" — ${res.scenarios?.length || 0} new scenario(s).`,
          { title: 'Architect finished' },
        );
        await load();
      } catch (err) {
        const cancelled = err instanceof ApiError && err.payload?.code === 'CANCELLED';
        const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
        if (!cancelled) toast.error(msg, { title: 'Regenerate failed' });
      } finally {
        setRegenScenarioId(null);
      }
    },
    [current, regenScenarioId, toast, load],
  );

  // ── Cmd+K / Ctrl+K to open search ─────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === 'Escape' && searchOpen) {
        setSearchOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [searchOpen]);

  // ── Cost preview for Run ──────────────────────────────────
  // Conductor cost is harder than Architect: it depends on retries (up to
  // MAX_CONDUCTOR_ATTEMPTS, default 3) + per-step LLM calls. We give a
  // conservative range: 1× attempt as low bound, 3× as high. Each approved
  // case contributes ≈ 800 input + 1500 output tokens per attempt (rough).
  const runCostEstimate = useMemo(() => {
    const approved = scenarios.flatMap((s) => s.cases.filter((c) => c.status === 'approved'));
    if (approved.length === 0) return null;
    // Use the Architect helper's pricing model — Conductor calls are also
    // Sonnet 4.6.
    const oneAttemptTexts = approved.map(() => 'x'.repeat(800 * 4)); // 800 tokens × 4 chars
    const lo = estimateArchitectCost(oneAttemptTexts);
    const hi = estimateArchitectCost(oneAttemptTexts.flatMap(() => ['x'.repeat(800 * 4 * 3)]));
    return {
      count: approved.length,
      lowUsd: lo.costUsd, highUsd: hi.costUsd,
      // Duration scales with case count: roughly 6 s per case for the live
      // browser path, plus 30 s pipeline overhead. Hard to be exact.
      seconds: 30 + approved.length * 6,
    };
  }, [scenarios]);

  const toggleExpanded = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const expandAll = () => setExpanded(new Set(scenarios.map((s) => s.id)));
  const collapseAll = () => setExpanded(new Set());

  if (!current) {
    return (
      <div className="flex flex-col h-full">
        <header className="bg-white border-b border-ink-200 px-page py-5 sticky top-0 z-20">
          <h1 className="text-xl font-semibold text-ink-900 tracking-tight">Test Cases</h1>
          <p className="text-sm text-ink-500 mt-0.5">Review AI-generated scenarios and test cases</p>
        </header>
        <EmptyState illustration="project" title="No project selected" message="Create or activate a project first." />
      </div>
    );
  }

  const hasImpacted = scenarios.some((s) => s.impacted);
  const canRun = !executing && !running && counts.approved > 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Page header — two rows. Row 1: identity + dominant primary CTA.
            Row 2: secondary actions + view controls. Splitting these makes
            the Run button the clear primary action and gives the eye a
            single horizontal rhythm to follow per row. ──────────────── */}
      <header className="bg-white border-b border-ink-200 sticky top-0 z-20">
        <div className="px-page pt-5 pb-3 flex items-start justify-between gap-6">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-ink-900 tracking-tight truncate">Test Cases</h1>
            <p className="text-sm text-ink-500 mt-0.5 truncate">
              {counts.total > 0
                ? `${counts.scenarios} scenario${counts.scenarios === 1 ? '' : 's'} · ${counts.total} test case${counts.total === 1 ? '' : 's'}`
                : 'Generate test scenarios from your requirements'}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <ProjectPicker />
            {/* Search trigger — Cmd+K opens the modal; this button does the
                same thing for users who don't know the shortcut. Small + neutral
                so it doesn't compete with the primary Run CTA. */}
            {counts.total > 0 && (
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-ink-200 bg-white text-xs text-ink-600 hover:border-ink-400 hover:bg-ink-50 transition-colors focus-visible:outline-none focus-visible:shadow-ring"
                title="Search cases (⌘K)"
              >
                <Search className="w-3.5 h-3.5" />
                Search
                <kbd className="ml-1 text-2xs font-mono text-ink-400 border border-ink-200 rounded px-1">⌘K</kbd>
              </button>
            )}
            {/* Primary CTA — visually dominant: larger size, isolated by
                a vertical divider, and its label changes from “Run 12”
                to "Approve cases" when there's nothing approved yet so
                disabled state is informative not just dim. */}
            <span className="hidden md:inline-block w-px h-8 bg-ink-200" aria-hidden="true" />
            <div className="flex flex-col items-end">
              <Button
                size="lg"
                onClick={handleExecute}
                loading={executing}
                disabled={!canRun}
                title={canRun ? `Run ${counts.approved} approved test case${counts.approved === 1 ? '' : 's'}` : 'Approve at least one case to enable run'}
              >
                <Play className="w-4 h-4 fill-current" />
                {counts.approved > 0 ? `Run ${counts.approved}` : 'Approve to run'}
              </Button>
              {runCostEstimate && counts.approved > 0 && (
                <span className="text-2xs text-ink-500 mt-1 tabular-nums" title="Estimated Conductor cost (1× to 3× attempts) + wall-clock duration">
                  ~${runCostEstimate.lowUsd.toFixed(2)}–${runCostEstimate.highUsd.toFixed(2)} · ~{Math.round(runCostEstimate.seconds / 60)} min
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Stat strip — execution summary in a clearly grouped row. Each
            pill is also a filter button: clicking "Failed 14" narrows the
            list below to only failed cases. Active pill is outlined with
            the ink-900 ring so the user can see the filter is engaged. */}
        {counts.total > 0 && (
          <div className="px-page pb-3 flex items-center gap-1 text-xs text-ink-600 flex-wrap">
            <MetricPill icon={CheckCircle2} tone="success" label="Passed" value={counts.pass}
              k="pass" active={statusFilter} onClick={toggleStatusFilter} disabled={counts.pass === 0} />
            <MetricPill icon={XCircle} tone="danger" label="Failed" value={counts.fail}
              k="fail" active={statusFilter} onClick={toggleStatusFilter} disabled={counts.fail === 0} />
            <MetricPill icon={Circle} tone="warn" label="Blocked" value={counts.blocked}
              k="blocked" active={statusFilter} onClick={toggleStatusFilter} disabled={counts.blocked === 0} />
            {counts.skipped > 0 && (
              <MetricPill icon={Circle} tone="ink-soft" label="Skipped" value={counts.skipped}
                k="skipped" active={statusFilter} onClick={toggleStatusFilter} />
            )}
            <span className="mx-2 text-ink-300" aria-hidden="true">·</span>
            <MetricPill icon={Check} tone="ink" label="Approved" value={counts.approved}
              k="approved" active={statusFilter} onClick={toggleStatusFilter} disabled={counts.approved === 0} />
            {counts.pending > 0 && (
              <MetricPill icon={Clock} tone="ink-soft" label="Pending" value={counts.pending}
                k="pending" active={statusFilter} onClick={toggleStatusFilter} />
            )}
            {counts.rejected > 0 && (
              <MetricPill icon={X} tone="ink-soft" label="Rejected" value={counts.rejected}
                k="rejected" active={statusFilter} onClick={toggleStatusFilter} />
            )}
            {statusFilter && (
              <button
                onClick={() => setStatusFilter(null)}
                className="ml-2 text-2xs font-medium text-info-700 hover:underline focus-visible:outline-none focus-visible:shadow-ring rounded"
              >
                Clear status filter
              </button>
            )}
          </div>
        )}

        {/* Secondary action toolbar — separated from the primary CTA above
            so it's clear these are tools, not the main action. */}
        {counts.total > 0 && (
          <div className="px-page py-2 border-t border-ink-100 bg-ink-50/40 flex items-center gap-2 flex-wrap">
            <Button size="sm" variant="secondary" onClick={handleGenerate} loading={generating} disabled={generating}>
              <Sparkles className="w-3.5 h-3.5" />
              Generate scenarios
            </Button>
            <Button size="sm" variant="secondary" onClick={handleSmartSelect} loading={selecting} disabled={selecting}>
              <Zap className="w-3.5 h-3.5" />
              Smart-select impacted
            </Button>
            {hasImpacted && (
              <Button size="sm" variant="secondary" onClick={handleApproveImpactedOnly} loading={approving} disabled={approving}>
                <Target className="w-3.5 h-3.5" />
                Approve impacted ({scenarios.filter((s) => s.impacted).flatMap((s) => s.cases.filter((c) => c.status === 'pending')).length})
              </Button>
            )}
            {counts.pending > 0 && (
              <Button size="sm" variant="secondary" onClick={handleApproveAll} loading={approving} disabled={approving}>
                <ThumbsUp className="w-3.5 h-3.5" />
                Approve all pending
              </Button>
            )}
            <button
              onClick={() => { setBulkMode((on) => !on); clearBulk(); }}
              aria-pressed={bulkMode}
              className={`text-xs font-medium inline-flex items-center gap-1 px-2 h-8 rounded-md transition-colors ${
                bulkMode
                  ? 'text-ink-900 bg-white border border-ink-300'
                  : 'text-ink-600 hover:text-ink-900 hover:bg-white'
              }`}
              title="Toggle bulk-select mode"
            >
              <CheckCircle2 className="w-3.5 h-3.5" /> Select
            </button>
            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={expandAll}
                className="text-xs font-medium text-ink-600 hover:text-ink-900 inline-flex items-center gap-1 px-2 h-8 rounded-md hover:bg-white transition-colors"
              >
                <Plus className="w-3 h-3" /> Expand all
              </button>
              <button
                onClick={collapseAll}
                className="text-xs font-medium text-ink-600 hover:text-ink-900 inline-flex items-center gap-1 px-2 h-8 rounded-md hover:bg-white transition-colors"
              >
                <Minus className="w-3 h-3" /> Collapse all
              </button>
            </div>
          </div>
        )}

        {/* Bulk action bar — only when bulkMode is on. Shows count, select-all,
            and approve / reject / clear / exit. Sticky inside the header so
            it stays visible while scrolling a long list. */}
        {bulkMode && counts.total > 0 && (
          <div className="px-page py-2 border-t border-info-200 bg-info-50 flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-info-900">
              {bulkIds.size} selected
              <span className="text-info-600 font-normal"> · of {allVisibleCaseIds.length} visible</span>
            </span>
            <button onClick={selectAllVisible} className="text-2xs font-semibold text-info-700 hover:underline">
              Select all visible
            </button>
            <button onClick={clearBulk} className="text-2xs font-semibold text-info-700 hover:underline">
              Clear
            </button>
            <div className="ml-auto flex items-center gap-1.5">
              <Button size="sm" variant="secondary" onClick={() => bulkUpdateStatus('approved')} disabled={!bulkIds.size}>
                <Check className="w-3.5 h-3.5" /> Approve {bulkIds.size || ''}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => bulkUpdateStatus('rejected')} disabled={!bulkIds.size}>
                <X className="w-3.5 h-3.5" /> Reject
              </Button>
              <Button size="sm" variant="secondary" onClick={bulkDelete} disabled={!bulkIds.size}>
                <Trash2 className="w-3.5 h-3.5" /> Remove
              </Button>
              <button
                onClick={exitBulk}
                className="text-xs text-info-700 hover:underline ml-1"
                title="Exit bulk-select mode"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </header>

      <main className="flex-1 overflow-y-auto bg-ink-50">
        <div className="max-w-5xl mx-auto px-page py-8 space-y-6">
          {/* Inline phase banner — surfaces architect / analyst progress
              right where the user triggered the work. Replaces the floating
              widget for in-page agents so the execution context is anchored
              to its source, not a detached chatbot-style overlay. Includes
              real Terminate (calls the abort registry) and a live elapsed
              counter. */}
          {activePhase && phaseStatus !== 'idle' && (
            <InlinePhaseBanner
              phase={activePhase}
              status={phaseStatus}
              log={phaseLog}
              elapsed={phaseElapsed}
              onTerminate={handleTerminate}
              onDismiss={() => setActivePhase(null)}
            />
          )}

          {/* Review banner — shown right after Architect generates */}
          {justGenerated && counts.total > 0 && (
            <div className="rounded-card border border-info-200 bg-gradient-to-br from-info-50 to-white shadow-card p-5">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-info-100 flex items-center justify-center shrink-0">
                  <Sparkles className="w-5 h-5 text-info-700" />
                </div>
                <div className="flex-1 min-w-0">
                  <h2 className="text-md font-semibold text-ink-900 tracking-tight">
                    I read your requirements and prepared {counts.scenarios} scenarios with {counts.total} test cases.
                  </h2>
                  <p className="text-sm text-ink-600 mt-1 leading-relaxed">
                    Each scenario expands to show its test cases. Each test case expands to show the step-by-step actions I'd take.
                    Review them below, approve the ones you want to run, then click <strong>Run approved</strong> to start live execution in the Theater.
                  </p>
                  <div className="flex items-center gap-2 mt-3 text-2xs text-ink-500">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-danger-500" />
                      {counts.byPriority.P0 || 0} P0
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-warn-500" />
                      {counts.byPriority.P1 || 0} P1
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-info-500" />
                      {counts.byPriority.P2 || 0} P2
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-ink-400" />
                      {counts.byPriority.P3 || 0} P3
                    </span>
                    <span className="mx-1 text-ink-300">·</span>
                    {Object.entries(CATEGORY_META).map(([k, v]) => {
                      const n = scenarios.filter((s) => s.category === k).length;
                      return n ? (
                        <span key={k} className="inline-flex items-center gap-1">
                          {n} {v.label.toLowerCase()}
                        </span>
                      ) : null;
                    }).filter(Boolean).reduce((acc, el, i, arr) => {
                      acc.push(el);
                      if (i < arr.length - 1) acc.push(<span key={`sep-${i}`} className="text-ink-300">·</span>);
                      return acc;
                    }, [])}
                  </div>
                </div>
                <div className="flex flex-col gap-2 shrink-0">
                  <Button size="sm" onClick={handleApproveAll} loading={approving} disabled={approving || !counts.pending}>
                    <ThumbsUp className="w-3.5 h-3.5" />
                    Approve all
                  </Button>
                  <button
                    onClick={() => setSearchParams((s) => {
                      // Copy the params instead of mutating the hook's
                      // returned instance — mutation triggers double renders
                      // and is fragile if the hook ever changes how it
                      // shares the instance internally.
                      const n = new URLSearchParams(s);
                      n.delete('just');
                      return n;
                    })}
                    className="text-2xs text-ink-500 hover:text-ink-900 underline text-center"
                  >
                    dismiss
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Filter groups — labelled and visually separated so Priority and
              Type aren't mistaken for a flat tag pile. Reset link appears
              when any filter is active so the user always knows how to
              return to the full list. */}

          {/* Module deep-link banner — shown when the user landed here from
              Overview's "Run module" CTA. Surfaces the active filter so they
              can clear it without hunting through the URL bar. */}
          {moduleParam && counts.total > 0 && (
            <div className="rounded-card border border-info-200 bg-info-50 px-4 py-2.5 flex items-center gap-2">
              <Target className="w-3.5 h-3.5 text-info-700 shrink-0" aria-hidden="true" />
              <span className="text-xs text-info-900">
                Filtered to module <span className="font-semibold">{moduleParam}</span>
                {' · '}
                <span className="tabular-nums">
                  {visibleScenarios.length} scenario{visibleScenarios.length === 1 ? '' : 's'}
                </span>
              </span>
              <button
                type="button"
                onClick={() => setSearchParams((s) => {
                  const next = new URLSearchParams(s);
                  next.delete('module');
                  return next;
                }, { replace: true })}
                className="ml-auto text-xs font-semibold text-info-700 hover:text-info-900 underline focus-visible:outline-none focus-visible:shadow-ring rounded"
              >
                Clear module filter
              </button>
            </div>
          )}

          {counts.total > 0 && (
            <div className="bg-white rounded-card border border-ink-200 shadow-card p-4 space-y-3">
              <FilterGroup label="Priority">
                <FilterChip k="all" label="All" count={counts.scenarios} active={filter} setFilter={setFilter} />
                {['P0', 'P1', 'P2', 'P3'].map((p) =>
                  counts.byPriority[p] ? (
                    <FilterChip
                      key={p}
                      k={p}
                      label={p}
                      count={counts.byPriority[p]}
                      active={filter}
                      setFilter={setFilter}
                    />
                  ) : null
                )}
              </FilterGroup>
              {Object.keys(CATEGORY_META).some((c) => scenarios.some((s) => s.category === c)) && (
                <FilterGroup label="Type">
                  {Object.keys(CATEGORY_META).map((c) => {
                    const n = scenarios.filter((s) => s.category === c).length;
                    return n ? (
                      <FilterChip
                        key={c}
                        k={c}
                        label={CATEGORY_META[c].label}
                        count={n}
                        active={filter}
                        setFilter={setFilter}
                      />
                    ) : null;
                  })}
                </FilterGroup>
              )}
              {/* Confidence floor — third filter axis. Architect emits 70-99
                  confidence per case; this lets the user narrow to only
                  high-confidence cases for the run. Counts shown alongside
                  match the active priority/type filter so the displayed
                  count is honest about what's left. */}
              <FilterGroup label="Confidence">
                <FilterChip k={null} label="All"     count={visibleScenarios.reduce((a, s) => a + s.cases.length, 0)} active={confidenceMin} setFilter={setConfidenceMin} />
                <FilterChip k={80}   label="≥ 80%"  count={visibleScenarios.flatMap((s) => s.cases).filter((c) => (c.confidence ?? 0) >= 80).length} active={confidenceMin} setFilter={setConfidenceMin} />
                <FilterChip k={90}   label="≥ 90%"  count={visibleScenarios.flatMap((s) => s.cases).filter((c) => (c.confidence ?? 0) >= 90).length} active={confidenceMin} setFilter={setConfidenceMin} />
              </FilterGroup>
              {(filter !== 'all' || confidenceMin) && (
                <div className="pt-1">
                  <button
                    onClick={() => { setFilter('all'); setConfidenceMin(null); }}
                    className="text-xs font-medium text-info-700 hover:text-info-900 underline focus-visible:outline-none focus-visible:shadow-ring rounded"
                  >
                    Clear filter
                  </button>
                </div>
              )}
            </div>
          )}

          {loading ? (
            <div className="text-sm text-ink-500">Loading…</div>
          ) : counts.total === 0 ? (
            <EmptyState
              icon={Sparkles}
              title="No scenarios yet"
              message="Click Generate scenarios. The Architect agent will read your requirements and produce a structured set of scenarios with priority and category labels."
            />
          ) : visibleScenarios.length === 0 ? (
            <EmptyState icon={FileText} title="No matches" message="Adjust the filter above." />
          ) : (
            <div className="space-y-3">
              {visibleScenarios.map((s) => (
                <ScenarioCard
                  key={s.id}
                  scenario={s}
                  expanded={expanded.has(s.id)}
                  onToggle={() => toggleExpanded(s.id)}
                  onApproveCase={(tc) => setStatus(tc, 'approved')}
                  onRejectCase={(tc) => setStatus(tc, 'rejected')}
                  refMap={scenarioRefs}
                  bulkMode={bulkMode}
                  bulkIds={bulkIds}
                  onToggleBulk={toggleBulk}
                  onRegenerate={() => handleRegenerateScenario(s)}
                  regenerating={regenScenarioId === s.id}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      {/* Search modal — Cmd+K opens it; typing filters the list inline.
          Picking a result closes the modal, sets the search query (which
          drives the actual case-level filter), expands the matching scenario,
          and scrolls it into view. */}
      {searchOpen && (
        <SearchModal
          scenarios={scenarios}
          onClose={() => setSearchOpen(false)}
          onPick={(scenarioId, caseId) => {
            setSearchOpen(false);
            setExpanded((prev) => {
              const next = new Set(prev);
              next.add(scenarioId);
              return next;
            });
            requestAnimationFrame(() => {
              const node = scenarioRefs.current.get(scenarioId);
              if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
          }}
        />
      )}
    </div>
  );
}

// MetricPill — the header stat strip, but also a filter trigger. Clicking
// a pill engages the status filter; clicking it again clears it. Disabled
// (zero count) pills are not interactive so they degrade gracefully.
//
// Restrained colour: only the icon carries the tone, the text and number
// stay neutral so the page doesn't read as a rainbow. The active filter is
// surfaced by an ink-900 ring + background tint — a single visual signal
// that doesn't conflict with the tone-coloured icon.
function MetricPill({ icon: Icon, tone, label, value, k, active, onClick, disabled }) {
  const dotCls = {
    success:    'text-success-600',
    danger:     'text-danger-600',
    warn:       'text-warn-600',
    ink:        'text-ink-700',
    'ink-soft': 'text-ink-400',
  }[tone] || 'text-ink-700';
  const isActive = active === k;
  const isInteractive = !disabled && !!onClick;
  return (
    <button
      type="button"
      onClick={isInteractive ? () => onClick(k) : undefined}
      disabled={!isInteractive}
      aria-pressed={isInteractive ? isActive : undefined}
      title={isInteractive ? (isActive ? `Clear ${label.toLowerCase()} filter` : `Filter to ${label.toLowerCase()} cases`) : undefined}
      className={`inline-flex items-center gap-1.5 px-2.5 h-8 rounded-md border text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:shadow-ring ${
        isActive
          ? 'bg-ink-900 text-white border-ink-900'
          : isInteractive
          ? 'bg-transparent text-ink-600 border-transparent hover:bg-ink-50 hover:border-ink-200'
          : 'bg-transparent text-ink-400 border-transparent cursor-default'
      }`}
    >
      <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-white' : dotCls}`} aria-hidden="true" />
      <span>{label}</span>
      <span className={`font-semibold tabular-nums ${isActive ? 'text-white' : 'text-ink-900'}`}>{value}</span>
    </button>
  );
}

function FilterGroup({ label, children }) {
  return (
    <div className="flex items-baseline gap-3 flex-wrap">
      <span className="text-2xs uppercase tracking-[0.18em] font-semibold text-ink-500 shrink-0 w-14">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

// FilterChip — neutral by default. Only the active chip carries strong
// colour so the eye lands on the user's current selection.
function FilterChip({ k, label, count, active, setFilter }) {
  const isActive = active === k;
  return (
    <button
      onClick={() => setFilter(k)}
      aria-pressed={isActive}
      className={`inline-flex items-center gap-1.5 px-3 h-8 rounded-pill text-xs font-semibold border transition-all duration-150 ease-out-soft focus-visible:outline-none focus-visible:shadow-ring ${
        isActive
          ? 'bg-ink-900 text-white border-ink-900'
          : 'bg-white text-ink-700 border-ink-200 hover:border-ink-400 hover:bg-ink-50'
      }`}
    >
      {label}
      <span className={`tabular-nums ${isActive ? 'text-ink-300' : 'text-ink-400'}`}>{count}</span>
    </button>
  );
}

function ScenarioCard({
  scenario, expanded, onToggle, onApproveCase, onRejectCase,
  refMap, bulkMode, bulkIds, onToggleBulk, onRegenerate, regenerating,
}) {
  const pMeta = PRIORITY_META[scenario.priority] || PRIORITY_META.P2;
  const cMeta = CATEGORY_META[scenario.category] || CATEGORY_META.positive;

  // Post-CRIT-6: pass/fail come from latestResult, not TC.status.
  const passCount = scenario.cases.filter((c) => c.latestResult?.status === 'pass').length;
  const failCount = scenario.cases.filter((c) => c.latestResult?.status === 'fail').length;
  const totalCount = scenario.cases.length;
  const pendCount = scenario.cases.filter((c) => c.status === 'pending').length;

  // Kebab menu open state — outside-click handler defined below. Anchored to
  // the kebab button. Only one card's menu can be open at a time because
  // each card owns its own state.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  // Wire the scroll target — parent uses scenarioRefs to jump here on filter
  // change or search pick.
  const articleRef = useCallback((node) => {
    if (!refMap) return;
    if (node) refMap.current.set(scenario.id, node);
    else refMap.current.delete(scenario.id);
  }, [refMap, scenario.id]);

  return (
    <article
      ref={articleRef}
      data-scenario-id={scenario.id}
      className={`relative rounded-card border bg-white shadow-card hover:shadow-card-hover transition-all duration-200 ease-out-soft overflow-hidden ${
      expanded ? 'border-ink-300' : 'border-ink-200'
    }`}>
      {/* Kebab menu — outside the toggle <button> so a click here does NOT
          expand the scenario. Currently only houses "Regenerate this scenario";
          designed to grow (rename, delete-with-confirm, copy steps as JSON). */}
      <div ref={menuRef} className="absolute top-4 right-4 z-10">
        <button
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
          disabled={regenerating}
          className="inline-flex items-center justify-center w-7 h-7 rounded-md text-ink-500 hover:text-ink-900 hover:bg-ink-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:shadow-ring"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Scenario actions"
          title="Scenario actions"
        >
          <MoreVertical className="w-4 h-4" />
        </button>
        {menuOpen && (
          <div role="menu" className="absolute right-0 mt-1 w-56 rounded-md border border-ink-200 bg-white shadow-pop py-1 text-sm">
            <button
              role="menuitem"
              onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onRegenerate?.(); }}
              disabled={regenerating}
              className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs text-ink-800 hover:bg-ink-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <RotateCw className="w-3.5 h-3.5 text-ink-600" />
              Regenerate this scenario
            </button>
          </div>
        )}
      </div>
      {regenerating && (
        <div className="px-6 py-2 bg-info-50 border-b border-info-200 text-xs text-info-800 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Regenerating this scenario — the Architect is running…
        </div>
      )}
      <button
        onClick={onToggle}
        className="w-full p-6 pr-14 text-left focus-visible:outline-none focus-visible:shadow-ring rounded-card"
        aria-expanded={expanded}
        aria-controls={`scenario-${scenario.id}-body`}
      >
        {/* Top meta row — small, neutral, anchored. Priority is the only
            element with strong colour because it's the highest-signal axis;
            module and case-count read as supporting context. */}
        <div className="flex items-center gap-2 mb-3 text-2xs font-semibold uppercase tracking-[0.14em]">
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-pill border ${pMeta.cls}`}>
            {scenario.priority}
          </span>
          <span className="text-ink-400">{cMeta.label}</span>
          <span className="text-ink-300">·</span>
          <span className="text-ink-500">{scenario.module}</span>
          {scenario.impacted && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill bg-warn-50 text-warn-700 border border-warn-200 normal-case tracking-normal"
              title={scenario.impactReason || 'Impacted by release notes'}
            >
              <Target className="w-3 h-3" />
              Impacted
            </span>
          )}
        </div>

        {/* Title row — bigger and bolder so it sits at the top of the
            hierarchy, with the chevron + counts pushed to the right edge
            for a clear "summary on the left, summary stats on the right"
            reading order. */}
        <div className="flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-semibold text-ink-900 tracking-tight leading-snug">
              {scenario.name}
            </h3>
            {scenario.rationale && (
              <p className="text-sm text-ink-500 leading-relaxed mt-1.5 line-clamp-2">
                {scenario.rationale}
              </p>
            )}
            {scenario.impacted && scenario.impactReason && (
              <div className="text-xs text-warn-800 mt-2 leading-relaxed flex gap-1.5">
                <Target className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />
                <span><span className="font-semibold">Why impacted: </span>{scenario.impactReason}</span>
              </div>
            )}
          </div>

          {/* Right rail — counts with proper labels (not "2✓ 1✗") + a
              clear expand affordance below them. */}
          <div className="flex flex-col items-end gap-2 shrink-0">
            <div className="flex items-center gap-3 text-xs">
              {passCount > 0 && (
                <span className="inline-flex items-center gap-1 text-success-700 font-semibold tabular-nums">
                  <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                  {passCount} passed
                </span>
              )}
              {failCount > 0 && (
                <span className="inline-flex items-center gap-1 text-danger-700 font-semibold tabular-nums">
                  <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
                  {failCount} failed
                </span>
              )}
              {passCount === 0 && failCount === 0 && (
                <span className="text-xs text-ink-400 tabular-nums">
                  {pendCount > 0 ? `${pendCount} pending` : 'Not yet run'}
                </span>
              )}
              <span className="text-xs text-ink-400 tabular-nums">
                · {totalCount} case{totalCount === 1 ? '' : 's'}
              </span>
            </div>
            <span className="inline-flex items-center gap-1 text-xs font-medium text-ink-500">
              {expanded ? (
                <>
                  <ChevronDown className="w-4 h-4" />
                  Hide test cases
                </>
              ) : (
                <>
                  <ChevronRight className="w-4 h-4" />
                  Show test cases
                </>
              )}
            </span>
          </div>
        </div>
      </button>

      {expanded && (
        <div id={`scenario-${scenario.id}-body`} className="border-t border-ink-200">
          {scenario.dependencyOn?.length > 0 && (
            <div className="px-6 py-2.5 bg-ink-50 border-b border-ink-100 text-xs">
              <span className="font-semibold text-ink-600">Depends on: </span>
              <span className="text-ink-500">{scenario.dependencyOn.join(', ')}</span>
            </div>
          )}
          <ul className="divide-y divide-ink-100">
            {scenario.cases.map((tc) => (
              <CaseRow
                key={tc.id}
                tc={tc}
                onApprove={() => onApproveCase(tc)}
                onReject={() => onRejectCase(tc)}
                bulkMode={bulkMode}
                checked={bulkIds?.has(tc.id) || false}
                onToggleBulk={() => onToggleBulk?.(tc.id)}
              />
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

function CaseRow({ tc, onApprove, onReject, bulkMode, checked, onToggleBulk }) {
  const [stepsOpen, setStepsOpen] = React.useState(false);
  // Show the execution outcome if there is one (latest run), otherwise fall
  // back to the approval state — post-CRIT-6, TC.status no longer carries
  // pass/fail/blocked. This keeps the badge meaningful at every stage of
  // the test-case lifecycle.
  const displayStatus = tc.latestResult?.status || tc.status;
  const sm = statusMeta(displayStatus);
  const statusLabel = STATUS_DISPLAY[displayStatus] || sm.label;
  const typeLabel = (TYPE_META[tc.type]?.label) || tc.type;
  const steps = Array.isArray(tc.steps) ? tc.steps : [];

  return (
    <li className="last:border-b-0">
      <div className={`flex items-start gap-4 px-6 py-5 hover:bg-ink-50/60 transition-colors ${checked ? 'bg-info-50/50' : ''}`}>
        {bulkMode && (
          <label className="mt-1 inline-flex items-center cursor-pointer" title="Select this case">
            <input
              type="checkbox"
              checked={!!checked}
              onChange={onToggleBulk}
              className="w-4 h-4 rounded border-ink-300 text-info-600 focus:ring-info-500 focus:ring-2 focus:ring-offset-0"
              aria-label={`Select ${tc.name}`}
            />
          </label>
        )}
        <button
          onClick={() => setStepsOpen((v) => !v)}
          disabled={steps.length === 0}
          className={`mt-1 p-1 rounded-md transition-colors ${
            steps.length === 0
              ? 'text-ink-200 cursor-default'
              : 'text-ink-500 hover:text-ink-900 hover:bg-ink-100'
          }`}
          aria-label={stepsOpen ? 'Hide steps' : 'Show steps'}
          aria-expanded={stepsOpen}
          title={steps.length === 0 ? 'No steps' : `${steps.length} steps`}
        >
          {stepsOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>

        <div className="flex-1 min-w-0">
          {/* Title row */}
          <div className="text-sm font-semibold text-ink-900 leading-snug">{tc.name}</div>
          {tc.assertions && (
            <p className="text-xs text-ink-500 mt-1 leading-relaxed">{tc.assertions}</p>
          )}

          {/* Meta row — restrained palette: status carries the colour
              (because it's the action-driving signal), type and step
              count read as neutral context tags. */}
          <div className="flex items-center gap-2 mt-2.5 flex-wrap">
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-2xs font-semibold border ${sm.cls}`}>
              {sm.icon && <sm.icon className="w-3 h-3" aria-hidden="true" />}
              {statusLabel}
            </span>
            <span className="inline-flex items-center px-2 py-0.5 rounded-pill text-2xs font-medium bg-ink-100 text-ink-700 border border-ink-200">
              {typeLabel}
            </span>
            {steps.length > 0 && (
              <span className="text-2xs text-ink-500 tabular-nums">{steps.length} step{steps.length === 1 ? '' : 's'}</span>
            )}
            <span className="text-2xs text-ink-300">·</span>
            <span className="text-2xs text-ink-500 tabular-nums" title="AI confidence in this test case">
              <span className="font-semibold text-ink-700">{tc.confidence}%</span> confidence
            </span>
            {tc.latestResult?.durationMs != null && (
              <>
                <span className="text-2xs text-ink-300">·</span>
                <span className="text-2xs text-ink-500 tabular-nums">
                  {(tc.latestResult.durationMs / 1000).toFixed(1)}s
                </span>
              </>
            )}
          </div>
        </div>

        {/* Action rail — labelled buttons, not bare icons, so the user
            knows what tapping them will do without hovering for a title. */}
        <div className="flex items-center gap-1 shrink-0">
          {tc.status === 'pending' && (
            <>
              <button
                onClick={onApprove}
                className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md text-xs font-semibold text-success-700 hover:bg-success-50 transition-colors focus-visible:outline-none focus-visible:shadow-ring"
              >
                <Check className="w-3.5 h-3.5" />
                Approve
              </button>
              <button
                onClick={onReject}
                className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md text-xs font-semibold text-ink-500 hover:bg-danger-50 hover:text-danger-700 transition-colors focus-visible:outline-none focus-visible:shadow-ring"
              >
                <X className="w-3.5 h-3.5" />
                Reject
              </button>
            </>
          )}
          {tc.status === 'approved' && (
            <span className="inline-flex items-center gap-1 px-2.5 h-8 rounded-md text-2xs font-semibold uppercase tracking-wider text-success-700 bg-success-50 border border-success-200">
              <Check className="w-3 h-3" />
              Approved
            </span>
          )}
          {tc.status === 'rejected' && (
            <span className="inline-flex items-center gap-1 px-2.5 h-8 rounded-md text-2xs font-semibold uppercase tracking-wider text-ink-600 bg-ink-100 border border-ink-200">
              Rejected
            </span>
          )}
          {tc.status === 'running' && (
            <span className="inline-flex items-center gap-1 px-2.5 h-8 rounded-md text-2xs font-semibold uppercase tracking-wider text-info-700 bg-info-50 border border-info-200">
              <Loader2 className="w-3 h-3 animate-spin" />
              Running
            </span>
          )}
        </div>
      </div>

      {stepsOpen && steps.length > 0 && (
        <div className="ml-12 mr-5 mb-4 rounded-md border border-ink-200 bg-ink-50 overflow-hidden">
          <div className="px-3 py-2 bg-white border-b border-ink-200 text-2xs font-bold uppercase tracking-wider text-ink-500">
            Steps
          </div>
          <ol className="divide-y divide-ink-200">
            {steps.map((step, i) => (
              <StepRow key={i} step={step} index={i + 1} />
            ))}
          </ol>
        </div>
      )}
    </li>
  );
}

// SearchModal — Cmd+K palette over all cases in the project. Filters by
// name + assertions; up to 12 results. Picking a result expands the parent
// scenario in the page below and scrolls it into view.
function SearchModal({ scenarios, onClose, onPick }) {
  const [q, setQ] = React.useState('');
  const inputRef = React.useRef(null);
  const [activeIdx, setActiveIdx] = React.useState(0);

  React.useEffect(() => { inputRef.current?.focus(); }, []);

  // Flatten all cases with their parent scenario id, then filter.
  const allCases = React.useMemo(() => {
    return scenarios.flatMap((s) =>
      s.cases.map((c) => ({
        scenarioId: s.id, scenarioName: s.name, module: s.module, priority: s.priority,
        id: c.id, name: c.name, assertions: c.assertions || '', type: c.type, confidence: c.confidence, status: c.status,
      })),
    );
  }, [scenarios]);

  const results = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return allCases.slice(0, 12);
    return allCases.filter((c) =>
      c.name.toLowerCase().includes(needle) || c.assertions.toLowerCase().includes(needle),
    ).slice(0, 12);
  }, [allCases, q]);

  // Reset active index when results length changes so the highlight always
  // sits on a visible row.
  React.useEffect(() => { setActiveIdx(0); }, [results.length]);

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i) => Math.min(results.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter' && results[activeIdx]) {
      e.preventDefault();
      const pick = results[activeIdx];
      onPick(pick.scenarioId, pick.id);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 px-4 bg-ink-900/40 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Search test cases">
      <div className="w-full max-w-2xl rounded-card border border-ink-200 bg-white shadow-pop overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-ink-100">
          <Search className="w-4 h-4 text-ink-500" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search cases by name or assertions…"
            className="flex-1 text-sm text-ink-900 placeholder:text-ink-400 outline-none bg-transparent"
            aria-label="Search query"
          />
          <kbd className="text-2xs font-mono text-ink-500 border border-ink-200 rounded px-1 py-0.5">Esc</kbd>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 text-ink-400 hover:text-ink-700 rounded hover:bg-ink-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto" role="listbox">
          {results.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-ink-500">No matches.</div>
          ) : (
            results.map((r, i) => (
              <button
                key={r.id}
                role="option"
                aria-selected={i === activeIdx}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => onPick(r.scenarioId, r.id)}
                className={`w-full text-left px-4 py-3 border-b border-ink-100 last:border-b-0 transition-colors ${
                  i === activeIdx ? 'bg-info-50' : 'hover:bg-ink-50'
                }`}
              >
                <div className="flex items-center gap-2 mb-1 text-2xs uppercase tracking-[0.14em] text-ink-500 font-semibold">
                  <span className="text-ink-700">{r.priority}</span>
                  <span className="text-ink-300">·</span>
                  <span>{r.module}</span>
                  <span className="ml-auto text-ink-400 normal-case tracking-normal font-normal">{r.scenarioName}</span>
                </div>
                <div className="text-sm font-semibold text-ink-900 leading-snug">{r.name}</div>
                {r.assertions && (
                  <p className="text-xs text-ink-500 mt-0.5 line-clamp-1">{r.assertions}</p>
                )}
              </button>
            ))
          )}
        </div>
        <div className="px-4 py-2 border-t border-ink-100 flex items-center gap-3 text-2xs text-ink-500">
          <span><kbd className="font-mono border border-ink-200 rounded px-1">↑</kbd> <kbd className="font-mono border border-ink-200 rounded px-1">↓</kbd> navigate</span>
          <span><kbd className="font-mono border border-ink-200 rounded px-1">↵</kbd> open</span>
          <span><kbd className="font-mono border border-ink-200 rounded px-1">Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

// InlinePhaseBanner — surfaces a running architect / analyst directly on
// the page that triggered it, with a real Terminate button (calls the
// abort registry, not a fake UI flag). Sits inline with content rather
// than floating: the bottom-right widget was previously the only visible
// indicator and felt detached from the action.
function InlinePhaseBanner({ phase, status, log, elapsed, onTerminate, onDismiss }) {
  const meta = {
    architect: { label: 'Scenario Architect',  icon: Sparkles },
    analyst:   { label: 'Smart Selection',     icon: Zap      },
  }[phase] || { label: phase, icon: Loader2 };
  const Icon = meta.icon;

  const visual = {
    running:    { border: 'border-info-200',    accent: 'bg-info-500',    iconCls: 'text-info-600',    title: meta.label },
    cancelling: { border: 'border-warn-200',    accent: 'bg-warn-500',    iconCls: 'text-warn-600',    title: `Cancelling ${meta.label}…` },
    cancelled:  { border: 'border-ink-200',     accent: 'bg-ink-400',     iconCls: 'text-ink-500',     title: `${meta.label} cancelled` },
    complete:   { border: 'border-success-200', accent: 'bg-success-500', iconCls: 'text-success-600', title: `${meta.label} finished` },
    error:      { border: 'border-danger-200',  accent: 'bg-danger-500',  iconCls: 'text-danger-600',  title: `${meta.label} failed` },
  }[status] || { border: 'border-ink-200', accent: 'bg-ink-400', iconCls: 'text-ink-500', title: meta.label };

  return (
    <div
      role="status"
      aria-live="polite"
      className={`relative overflow-hidden rounded-card border bg-white shadow-card ${visual.border}`}
    >
      <div className={`absolute left-0 top-0 bottom-0 w-1 ${visual.accent}`} aria-hidden="true" />
      <div className="pl-5 pr-4 py-3.5 flex items-start gap-3">
        <div className="mt-0.5 shrink-0">
          {status === 'running' || status === 'cancelling' ? (
            <Loader2 className={`w-4 h-4 animate-spin ${visual.iconCls}`} aria-hidden="true" />
          ) : status === 'complete' ? (
            <CheckCircle2 className={`w-4 h-4 ${visual.iconCls}`} aria-hidden="true" />
          ) : status === 'cancelled' ? (
            <StopCircle className={`w-4 h-4 ${visual.iconCls}`} aria-hidden="true" />
          ) : (
            <XCircle className={`w-4 h-4 ${visual.iconCls}`} aria-hidden="true" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Icon className="w-3.5 h-3.5 text-ink-500" aria-hidden="true" />
            <span className="text-sm font-semibold text-ink-900 tracking-tight">{visual.title}</span>
            {(status === 'running' || status === 'cancelling') && (
              <span className="ml-auto text-2xs font-mono tabular-nums text-ink-500">{elapsed}s</span>
            )}
          </div>
          {(status === 'running' || status === 'cancelling') && log && (
            <p className="text-xs text-ink-600 mt-1 leading-relaxed line-clamp-2">{log}</p>
          )}
          {status === 'cancelled' && (
            <p className="text-xs text-ink-600 mt-1 leading-relaxed">
              Stopped after {elapsed}s. Nothing was persisted.
            </p>
          )}
          {status === 'error' && log && (
            <p className="text-xs text-danger-700 mt-1 leading-relaxed line-clamp-2">{log}</p>
          )}
        </div>
        {status === 'running' && (
          <button
            onClick={onTerminate}
            className="shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-semibold text-danger-700 bg-white border border-danger-200 hover:bg-danger-50 transition-colors focus-visible:outline-none focus-visible:shadow-ring"
            title="Stop the agent. The in-flight request is aborted."
          >
            <StopCircle className="w-3.5 h-3.5" />
            Terminate
          </button>
        )}
        {status === 'cancelling' && (
          <span className="shrink-0 text-xs font-medium text-warn-700">Cancelling…</span>
        )}
        {(status === 'complete' || status === 'cancelled' || status === 'error') && (
          <button
            onClick={onDismiss}
            className="shrink-0 text-ink-400 hover:text-ink-700 transition-colors"
            aria-label="Dismiss"
            title="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function StepRow({ step, index }) {
  return (
    <li className="grid grid-cols-[40px_1fr] gap-3 px-3 py-2.5">
      <div className="flex items-start">
        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-info-100 text-info-700 text-2xs font-bold tabular-nums">
          {step.order || index}
        </span>
      </div>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-semibold text-ink-900">{step.action}</span>
          {step.target && (
            <span className="text-xs text-ink-600">on <span className="font-mono text-ink-700 bg-white px-1 rounded">{step.target}</span></span>
          )}
        </div>
        {step.value && (
          <div className="text-xs text-ink-600 mt-0.5">
            <span className="text-ink-400">value: </span>
            <span className="font-mono text-ink-800 bg-white px-1 rounded">"{step.value}"</span>
          </div>
        )}
        {step.expected && (
          <div className="text-xs text-success-700 mt-0.5">
            <span className="text-ink-400">expect: </span>
            {step.expected}
          </div>
        )}
      </div>
    </li>
  );
}
