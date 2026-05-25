import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  CheckCircle2, XCircle, AlertCircle, FileText, Image as ImageIcon, Video,
  ChevronRight, ChevronDown, Clock, Activity, AlertOctagon, Camera, FileCode,
  Sparkles, Bug, ExternalLink, BrainCircuit, FolderTree, ShieldAlert,
  Search, GitCompare, History, TrendingUp, X, Printer, Zap, Save, Eye, ScanSearch,
} from 'lucide-react';
import api, { ApiError } from '../lib/apiClient';
import { BASE_URL } from '../lib/apiClient';
import { useProject } from '../store/project';
import { useToast } from '../lib/useToast';
import { useRunStream } from '../store/runStream';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import Button from '../components/ui/Button';
import Skeleton from '../components/ui/Skeleton';
import Sparkline from '../components/charts/Sparkline';
import { STATUS_META, statusMeta } from '../lib/statusMeta';

const API_ORIGIN = (BASE_URL || 'http://localhost:5000/api').replace(/\/api$/, '');
const absUrl = (u) => (u?.startsWith('http') ? u : u ? API_ORIGIN + u : null);

// Pane id constants for the responsive tab toggle below `lg`. Centralising
// these avoids string typos when we render the segmented control + decide
// which pane to show on narrow viewports.
const PANES = { RUNS: 'runs', TESTS: 'tests', DETAIL: 'detail' };

// Status filter chip set for the filters bar. Order is intentional so the
// chip row reads in priority order (all → fails first).
const STATUS_FILTERS = [
  { id: 'all',     label: 'All',     cls: 'bg-ink-100 text-ink-700' },
  { id: 'fail',    label: 'Failed',  cls: 'bg-danger-50 text-danger-700' },
  { id: 'blocked', label: 'Blocked', cls: 'bg-warn-50 text-warn-700' },
  { id: 'pass',    label: 'Passed',  cls: 'bg-success-50 text-success-700' },
];

export default function Reports() {
  const toast = useToast();
  const navigate = useNavigate();
  const { current, currentSprintId } = useProject();
  const { claudeRateLimit } = useRunStream();
  const [searchParams, setSearchParams] = useSearchParams();
  const [runs, setRuns] = useState([]);
  const [activeRun, setActiveRun] = useState(null);
  const [activeResult, setActiveResult] = useState(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingRun, setLoadingRun] = useState(false);

  // Filter state — persisted in `?q=` / `?status=` so a filtered view is
  // shareable and survives reloads. We read on every render rather than
  // mirroring into useState to keep URL the single source of truth.
  const runIdParam = searchParams.get('runId');
  const q = (searchParams.get('q') || '').toLowerCase();
  const statusFilter = searchParams.get('status') || 'all';
  const sprintFilter = searchParams.get('sprint') || '';

  // Selection state for compare mode. Up to 2 runs can be selected; once
  // 2 are picked, a "Compare 2 runs" button appears in the page header.
  const [compareSelection, setCompareSelection] = useState(() => new Set());

  // Active pane on narrow viewports (< lg). Defaults to the most relevant
  // pane based on URL state — Detail if a run + a result are both loaded,
  // Tests if just a run, otherwise Runs.
  const [activePane, setActivePane] = useState(PANES.RUNS);

  // aria-live region for screen-reader announcement of detail-pane changes.
  const liveRef = useRef(null);

  useEffect(() => {
    if (!current) { setLoadingList(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const sprintQs = currentSprintId ? `&sprintId=${encodeURIComponent(currentSprintId)}` : '';
        const res = await api.get(`/runs?projectId=${current.id}&limit=50${sprintQs}`);
        if (cancelled) return;
        const list = res.runs || [];
        setRuns(list);
        // If the URL carries a runId from a previous project, it won't be in
        // this project's run list — drop it and reseed with the first run so
        // the detail pane doesn't try to load a stranger's run id (which
        // would 404). On first mount with a legitimate deep link, the id is
        // present in the list and we keep it.
        const valid = runIdParam && list.some((r) => r.id === runIdParam);
        if (!valid) {
          const next = new URLSearchParams(searchParams);
          if (list[0]?.id) next.set('runId', list[0].id);
          else next.delete('runId');
          setSearchParams(next, { replace: true });
        }
      } catch (err) {
        if (!cancelled) toast.error(err.message);
      } finally {
        if (!cancelled) setLoadingList(false);
      }
    })();
    return () => { cancelled = true; };
    // Project + sprint changes both invalidate the list. Other deps (filters,
    // runId, etc.) intentionally don't refire — they'd be wasteful and risk
    // render loops. Sprint is here because switching the header pill must
    // re-narrow the run list to the new container.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, currentSprintId]);

  useEffect(() => {
    if (!runIdParam) { setActiveRun(null); setActiveResult(null); return; }
    setLoadingRun(true);
    (async () => {
      try {
        const res = await api.get(`/runs/${runIdParam}`);
        setActiveRun(res.run);
        // Honour deep links: if the URL carries a resultId and it belongs
        // to this run, select it; otherwise fall back to the first result.
        const wanted = searchParams.get('resultId');
        const match = wanted && (res.run?.results || []).find((r) => r.id === wanted);
        setActiveResult(match || res.run?.results?.[0] || null);
        // After picking a run, the user almost always wants to see results,
        // so default the narrow-viewport tab to "tests".
        setActivePane(PANES.TESTS);
      } catch (err) {
        toast.error(err.message);
      } finally {
        setLoadingRun(false);
      }
    })();
  }, [runIdParam, toast]);

  // Announce active-result changes via aria-live so screen-reader users
  // hear when the detail pane content changes (otherwise switching tests
  // produces silent UI updates).
  useEffect(() => {
    if (!liveRef.current) return;
    if (!activeResult) { liveRef.current.textContent = ''; return; }
    const tc = activeResult.testCase;
    const status = activeResult.status || 'pending';
    const scenario = tc?.scenario?.name || 'unassigned scenario';
    const name = tc?.name || activeResult.testCaseId || 'untitled';
    liveRef.current.textContent = `Selected ${name}, status ${status}, in ${scenario}`;
  }, [activeResult?.id]);

  const summary = useMemo(() => {
    if (!activeRun) return null;
    const total = activeRun.passed + activeRun.failed + activeRun.skipped;
    return {
      total,
      passRate: total ? Math.round((activeRun.passed / total) * 100) : 0,
      duration: activeRun.completedAt
        ? Math.round((new Date(activeRun.completedAt) - new Date(activeRun.startedAt)) / 1000)
        : null,
    };
  }, [activeRun]);

  // Filtered run list — search matches against any scenario name, sprint
  // name, or module label on the run card. Sprint dropdown narrows to one
  // specific sprintName when set.
  const visibleRuns = useMemo(() => {
    let list = runs;
    if (sprintFilter) {
      list = list.filter((r) => r.sprintName === sprintFilter);
    }
    if (!q) return list;
    return list.filter((r) => {
      const hay = [
        r.sprintName,
        ...(Array.isArray(r.scenarios) ? r.scenarios.flatMap((s) => [s.name, s.module]) : []),
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [runs, q, sprintFilter]);

  // Distinct sprint names — fuel for the sprint dropdown. Order by most
  // recent run first so the freshest sprint sits at the top of the list.
  const sprintOptions = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const r of runs) {
      if (!r.sprintName || seen.has(r.sprintName)) continue;
      seen.add(r.sprintName);
      out.push(r.sprintName);
    }
    return out;
  }, [runs]);

  // Filtered test results — search by test name + status chip filter.
  const visibleResults = useMemo(() => {
    const all = activeRun?.results || [];
    return all.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (!q) return true;
      const tc = r.testCase;
      const hay = [tc?.name, tc?.module, tc?.scenario?.name].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [activeRun, q, statusFilter]);

  // Per-status counts for the filter chips, computed against the search-
  // narrowed results (so "fail" count drops to 0 if a search hides them).
  // Each chip shows its count inline so the user can see at a glance how
  // many tests would survive each filter.
  const statusCounts = useMemo(() => {
    const all = activeRun?.results || [];
    const searchFiltered = all.filter((r) => {
      if (!q) return true;
      const tc = r.testCase;
      const hay = [tc?.name, tc?.module, tc?.scenario?.name].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
    return {
      all:     searchFiltered.length,
      fail:    searchFiltered.filter((r) => r.status === 'fail').length,
      blocked: searchFiltered.filter((r) => r.status === 'blocked').length,
      pass:    searchFiltered.filter((r) => r.status === 'pass').length,
    };
  }, [activeRun, q]);

  if (!current) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Reports" />
        <EmptyState illustration="reports" title="No project selected" message="Activate a project to see reports." />
      </div>
    );
  }

  // Count failures missing RCA. INT-5: only true `fail` cases benefit from
  // Reporter analysis — `blocked` is mostly environmental (no browser /
  // captcha) where the Reporter has nothing actionable to say, and feeding
  // those into the Reporter wastes tokens + adds noise to the panel.
  const failsMissingRca = useMemo(() => {
    if (!activeRun) return 0;
    return (activeRun.results || []).filter(
      (r) => r.status === 'fail' && !r.rcaWhat
    ).length;
  }, [activeRun]);
  const [analyzing, setAnalyzing] = useState(false);

  const handleAnalyze = useCallback(async () => {
    if (!activeRun) return;
    setAnalyzing(true);
    try {
      const res = await api.post(`/runs/${activeRun.id}/analyze`, {});
      toast.success(`Reporter analysed ${res.analyzed} failure${res.analyzed === 1 ? '' : 's'}.`, { title: 'Root cause ready' });
      // Refetch the active run to pick up RCA fields
      const r = await api.get(`/runs/${activeRun.id}`);
      setActiveRun(r.run);
      if (activeResult) {
        const upd = r.run.results.find((x) => x.id === activeResult.id);
        if (upd) setActiveResult(upd);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Analyze failed' });
    } finally {
      setAnalyzing(false);
    }
  }, [activeRun, activeResult, toast]);

  // URL-mutating helpers so the call sites stay short.
  const updateParam = (key, value) => {
    const next = new URLSearchParams(searchParams);
    if (value == null || value === '' || value === 'all') next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };
  const pickRun = (runId) => {
    const next = new URLSearchParams(searchParams);
    next.set('runId', runId);
    setSearchParams(next, { replace: true });
  };
  const pickResult = (r) => {
    setActiveResult(r);
    // On narrow viewports, jump to the detail pane so the user actually
    // sees what they just clicked instead of scrolling endlessly.
    setActivePane(PANES.DETAIL);
    // Persist the selected test result id to the URL so a shared link can
    // deep-link to a specific test case within a run, not just to the run.
    const next = new URLSearchParams(searchParams);
    if (r?.id) next.set('resultId', r.id);
    else next.delete('resultId');
    setSearchParams(next, { replace: true });
  };

  // Compare-mode toggle: clicking the small checkbox on a run row adds/
  // removes it from the selection (max 2). Clicking the run row itself
  // still navigates as normal.
  const toggleCompareSelection = (runId) => {
    setCompareSelection((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else if (next.size < 2) next.add(runId);
      return next;
    });
  };
  const launchCompare = () => {
    const [a, b] = Array.from(compareSelection);
    if (!a || !b) return;
    navigate(`/reports/compare?a=${a}&b=${b}`);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader
        title="Reports"
        subtitle={
          activeRun
            ? `${activeRun.sprintName} · ${summary?.duration ? summary.duration + 's' : '—'}`
            : 'Pick a run to inspect results'
        }
      >
        <ClaudeRateLimitChip info={claudeRateLimit} aiProvider={current?.aiProvider} />
        {compareSelection.size === 2 && (
          <Button size="sm" variant="secondary" onClick={launchCompare}>
            <GitCompare className="w-3.5 h-3.5" />
            Compare 2 runs
          </Button>
        )}
        {activeRun && failsMissingRca > 0 && (
          <Button size="sm" onClick={handleAnalyze} loading={analyzing} disabled={analyzing}>
            <BrainCircuit className="w-3.5 h-3.5" />
            Analyse {failsMissingRca} failure{failsMissingRca === 1 ? '' : 's'} with AI
          </Button>
        )}
        {activeRun && (
          <Button size="sm" variant="secondary" onClick={() => window.print()} title="Print this run report (use Save as PDF in the print dialog)">
            <Printer className="w-3.5 h-3.5" />
            Print / PDF
          </Button>
        )}
      </PageHeader>

      {/* Filters bar — search box + status chips. Filter state lives in the
          URL via ?q= and ?status=, so a filtered view is shareable. */}
      <div data-no-print="true" className="border-b border-ink-200 bg-white px-4 py-2.5 flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-md min-w-[200px]">
          <Search className="w-3.5 h-3.5 text-ink-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
          <input
            type="search"
            value={searchParams.get('q') || ''}
            onChange={(e) => updateParam('q', e.target.value)}
            placeholder="Search runs, tests, scenarios…"
            aria-label="Filter runs and tests"
            className="w-full h-9 pl-9 pr-8 rounded-md border border-ink-200 bg-white text-sm placeholder:text-ink-400 focus:outline-none focus:border-ink-900 focus:shadow-ring transition-all"
          />
          {q && (
            <button
              onClick={() => updateParam('q', '')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700 p-1 rounded"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
        {/* Sprint dropdown — derived from distinct sprintName values across
            the runs list. Setting it filters the run list on the left to the
            chosen sprint. URL param `?sprint=` for shareability. */}
        {sprintOptions.length > 1 && (
          <select
            value={sprintFilter}
            onChange={(e) => updateParam('sprint', e.target.value)}
            aria-label="Filter by sprint"
            className="h-8 px-2 rounded-md border border-ink-200 bg-white text-xs text-ink-800 focus:outline-none focus:border-ink-900 focus:shadow-ring transition-all max-w-[180px]"
          >
            <option value="">All sprints</option>
            {sprintOptions.map((sp) => (
              <option key={sp} value={sp}>{sp}</option>
            ))}
          </select>
        )}
        <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Filter by status">
          {STATUS_FILTERS.map((s) => {
            const active = statusFilter === s.id;
            const count = statusCounts[s.id];
            return (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => updateParam('status', s.id)}
                className={`h-8 px-2.5 rounded-pill text-2xs font-bold uppercase tracking-wider border transition-all inline-flex items-center gap-1.5 ${
                  active ? 'bg-ink-900 text-white border-ink-900' : `${s.cls} border-transparent hover:border-ink-300`
                }`}
              >
                <span>{s.label}</span>
                <span className={`tabular-nums font-mono text-2xs ${active ? 'text-white/70' : 'opacity-60'}`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
        {compareSelection.size > 0 && (
          <div className="ml-auto inline-flex items-center gap-2 text-2xs text-ink-600">
            <span className="font-semibold uppercase tracking-wider">{compareSelection.size}/2 selected</span>
            <button
              onClick={() => setCompareSelection(new Set())}
              className="text-ink-500 hover:text-ink-900 underline"
            >
              clear
            </button>
          </div>
        )}
      </div>

      {/* Mobile / narrow-viewport pane toggle. Hidden at `lg+` where the
          three columns render side by side. */}
      <div data-no-print="true" className="lg:hidden border-b border-ink-200 bg-white flex" role="tablist" aria-label="Reports panes">
        {[
          { id: PANES.RUNS, label: 'Runs' },
          { id: PANES.TESTS, label: 'Tests' },
          { id: PANES.DETAIL, label: 'Detail' },
        ].map((p) => {
          const active = activePane === p.id;
          return (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActivePane(p.id)}
              className={`flex-1 h-10 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors ${
                active ? 'border-info-500 text-ink-900 bg-info-50/60' : 'border-transparent text-ink-500 hover:bg-ink-50'
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {/* Visually-hidden aria-live region. Always mounted so the live
          region exists from the first paint; content is set by the
          activeResult useEffect above. */}
      <div ref={liveRef} aria-live="polite" aria-atomic="true" className="sr-only" />

      <main className="flex-1 lg:grid lg:grid-cols-[280px_360px_1fr] overflow-hidden bg-ink-50">
        {/* ── Pane 1: Run list ── */}
        <aside
          className={`border-r border-ink-200 bg-white overflow-y-auto ${
            activePane === PANES.RUNS ? 'block' : 'hidden lg:block'
          }`}
          aria-label="Run list"
        >
          <div className="sticky top-0 bg-white border-b border-ink-200 px-4 py-3 z-10">
            <h2 className="text-2xs font-bold uppercase tracking-[0.18em] text-ink-500">
              Runs <span className="text-ink-400 tabular-nums">({visibleRuns.length}{q ? ` of ${runs.length}` : ''})</span>
            </h2>
          </div>
          {loadingList ? (
            <RunListSkeleton />
          ) : runs.length === 0 ? (
            <div className="p-6 text-center">
              <FileText className="w-8 h-8 text-ink-300 mx-auto mb-2" aria-hidden="true" />
              <p className="text-xs text-ink-500">No runs yet.</p>
              <p className="text-xs text-ink-400 mt-1">Execute approved test cases from Live Pipeline.</p>
            </div>
          ) : visibleRuns.length === 0 ? (
            <div className="p-6 text-center text-xs text-ink-400">No runs match "{q}".</div>
          ) : (
            <ul role="list" className="list-none m-0 p-0">
              {visibleRuns.map((r) => {
                // Pass-rate denom: executed (pass + fail + blocked).
                // Pure `skipped` (test.skip / --grep) is excluded.
                const denom = (r.passed || 0) + (r.failed || 0) + (r.blocked || 0);
                const rate = denom ? Math.round((r.passed / denom) * 100) : 0;
                const isActive = runIdParam === r.id;
                const isSelected = compareSelection.has(r.id);
                const scenarios = Array.isArray(r.scenarios) ? r.scenarios : [];
                const primaryTitle = scenarios.length
                  ? scenarios.slice(0, 2).map((s) => s.name).join(' · ') + (scenarios.length > 2 ? ` +${scenarios.length - 2}` : '')
                  : r.sprintName;
                return (
                  <li key={r.id} className="border-b border-ink-100">
                    <div className={`group relative flex items-stretch transition-colors ${
                      isActive ? 'bg-info-50' : 'hover:bg-ink-50/60'
                    }`}>
                      {isActive && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-info-500" aria-hidden="true" />}
                      <label
                        className={`flex items-center pl-3 pr-1 cursor-pointer transition-opacity ${
                          isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-60 focus-within:opacity-100'
                        }`}
                        title="Select to compare with another run"
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleCompareSelection(r.id)}
                          disabled={!isSelected && compareSelection.size >= 2}
                          aria-label={`Select ${primaryTitle} for comparison`}
                          className="w-3.5 h-3.5 rounded border-ink-300 text-info-600 focus:ring-info-500"
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => pickRun(r.id)}
                        aria-current={isActive ? 'true' : undefined}
                        className="flex-1 text-left pl-1 pr-4 py-3 focus-visible:outline-none focus-visible:bg-info-50/60"
                      >
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="text-sm font-semibold text-ink-900 truncate" title={primaryTitle}>{primaryTitle}</span>
                          <RunStatusPill status={r.status} />
                        </div>
                        <div className="flex items-center gap-3 text-2xs">
                          <span className="inline-flex items-center gap-1 text-success-700 font-semibold tabular-nums">
                            <CheckCircle2 className="w-3 h-3" aria-hidden="true" />{r.passed}
                          </span>
                          <span className="inline-flex items-center gap-1 text-danger-700 font-semibold tabular-nums">
                            <XCircle className="w-3 h-3" aria-hidden="true" />{r.failed}
                          </span>
                          <span
                            className="inline-flex items-center gap-1 text-warn-700 font-semibold tabular-nums"
                            title="Blocked — environmental failure"
                          >
                            <ShieldAlert className="w-3 h-3" aria-hidden="true" />{r.blocked ?? 0}
                          </span>
                          {(r.skipped ?? 0) > 0 && (
                            <span
                              className="inline-flex items-center gap-1 text-ink-500 font-semibold tabular-nums"
                              title="Skipped — engineer-chosen"
                            >
                              ⏭ {r.skipped}
                            </span>
                          )}
                          <span className="ml-auto text-ink-700 font-bold tabular-nums">{rate}%</span>
                        </div>
                        <div className="flex items-center justify-between gap-2 mt-1.5">
                          <div className="text-2xs text-ink-400 truncate">
                            {new Date(r.startedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                            {typeof r.testCount === 'number' && r.testCount > 0 && (
                              <> · <span className="tabular-nums">{r.testCount} test{r.testCount === 1 ? '' : 's'}</span></>
                            )}
                          </div>
                          {scenarios.length > 0 && (
                            <span className="inline-flex items-center gap-1 text-2xs font-semibold text-ink-500 shrink-0">
                              <FolderTree className="w-3 h-3" aria-hidden="true" />
                              {scenarios.length}
                            </span>
                          )}
                        </div>
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        {/* ── Pane 2: Test result list ── */}
        <aside
          className={`border-r border-ink-200 bg-white overflow-y-auto ${
            activePane === PANES.TESTS ? 'block' : 'hidden lg:block'
          }`}
          aria-label="Test results"
        >
          <div className="sticky top-0 bg-white border-b border-ink-200 px-4 py-3 z-10">
            <h2 className="text-2xs font-bold uppercase tracking-[0.18em] text-ink-500">
              Test cases
              {activeRun && q && (
                <span className="text-ink-400 tabular-nums ml-1">
                  ({visibleResults.length} of {activeRun.results?.length || 0})
                </span>
              )}
            </h2>
            {activeRun && (
              <div className="flex items-center gap-3 mt-1.5">
                <Bar
                  passed={activeRun.passed}
                  failed={activeRun.failed}
                  blocked={activeRun.blocked}
                  skipped={activeRun.skipped}
                />
              </div>
            )}
          </div>
          {loadingRun ? (
            <TestListSkeleton />
          ) : !activeRun ? (
            <div className="p-6 text-center text-xs text-ink-400">Pick a run on the left.</div>
          ) : !activeRun.results?.length ? (
            <div className="p-6 text-center text-xs text-ink-400">No results in this run.</div>
          ) : visibleResults.length === 0 ? (
            <div className="p-6 text-center text-xs text-ink-400">
              No tests match the current filter.
            </div>
          ) : (
            <ResultsByScenario
              results={visibleResults}
              activeResultId={activeResult?.id}
              onPick={pickResult}
            />
          )}
        </aside>

        {/* ── Pane 3: Detail ── */}
        <section
          className={`overflow-y-auto bg-ink-50 ${
            activePane === PANES.DETAIL ? 'block' : 'hidden lg:block'
          }`}
          aria-label="Test detail"
        >
          {loadingRun ? (
            <DetailSkeleton />
          ) : !activeResult ? (
            <EmptyState
              icon={FileText}
              title="Select a test"
              message="Pick a test case from the middle column to see steps, screenshots, video, and error details."
            />
          ) : (
            <DetailPane
              result={activeResult}
              testCase={activeResult.testCase}
              projectId={activeRun.projectId}
            />
          )}
        </section>
      </main>
    </div>
  );
}

// ── Loading skeletons ───────────────────────────────────────────────
// Heights mirror the real rows so the layout doesn't shift when data lands.

function RunListSkeleton() {
  return (
    <ul role="list" className="list-none m-0 p-0" aria-hidden="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <li key={i} className="border-b border-ink-100 px-4 py-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-12" rounded="pill" />
          </div>
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="h-3 w-1/3" />
        </li>
      ))}
    </ul>
  );
}

function TestListSkeleton() {
  return (
    <ul role="list" className="list-none m-0 p-0" aria-hidden="true">
      {Array.from({ length: 8 }).map((_, i) => (
        <li key={i} className="border-b border-ink-100 px-4 py-3 flex items-start gap-3">
          <Skeleton className="h-4 w-4" rounded="full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-5/6" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function DetailSkeleton() {
  return (
    <div className="max-w-4xl mx-auto px-page py-8 space-y-5" aria-hidden="true">
      <div className="rounded-card border border-ink-200 bg-white p-5 space-y-3">
        <Skeleton className="h-4 w-32" rounded="pill" />
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-3 w-full" />
      </div>
      <div className="rounded-card border border-ink-200 bg-white p-5 space-y-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-32 w-full" />
      </div>
    </div>
  );
}

function ResultsByScenario({ results, activeResultId, onPick }) {
  // Group results by the parent scenario. Cases without a scenario fall into
  // a synthetic "Unassigned" bucket so they remain visible.
  const groups = useMemo(() => {
    const map = new Map();
    for (const r of results) {
      const sc = r.testCase?.scenario;
      const key = sc?.id || '__unassigned';
      if (!map.has(key)) {
        map.set(key, {
          id: key,
          name: sc?.name || 'Unassigned',
          module: sc?.module || r.testCase?.module || null,
          priority: sc?.priority || null,
          category: sc?.category || null,
          items: [],
          counts: { pass: 0, fail: 0, blocked: 0, skipped: 0 },
        });
      }
      const g = map.get(key);
      g.items.push(r);
      // Explicit branching post-CRIT-3 — `skipped` was previously lumped
      // into `blocked`, and any unexpected status (e.g. mid-stream
      // `running`) would also silently increment blocked.
      if (r.status === 'pass')         g.counts.pass++;
      else if (r.status === 'fail')    g.counts.fail++;
      else if (r.status === 'blocked') g.counts.blocked++;
      else if (r.status === 'skipped') g.counts.skipped++;
      else {
        // Surface anything we don't recognise during development. Counted
        // under blocked as the closest "didn't pass and didn't conclude"
        // bucket — but a log makes it visible during testing instead of
        // silently shifting metrics.
        if (typeof console !== 'undefined') {
          console.warn('[reports] unexpected RunResult.status', r.status);
        }
        g.counts.blocked++;
      }
    }
    return Array.from(map.values());
  }, [results]);

  // ⚠ Previously `open` was initialised inside `useState(() => new Set(...))`
  // which only runs on first mount. When the user picked a different run on
  // the left, `groups` changed but `open` kept the stale ids — toggle state
  // was effectively random. Track the canonical id list as a stable string
  // and reset `open` to match it whenever the set of groups changes.
  const groupIdsKey = groups.map((g) => g.id).join('|');
  const [open, setOpen] = useState(() => new Set(groups.map((g) => g.id)));
  useEffect(() => {
    setOpen(new Set(groups.map((g) => g.id)));
  }, [groupIdsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="divide-y divide-ink-100">
      {groups.map((g) => {
        const isOpen = open.has(g.id);
        const listId = `scenario-list-${g.id}`;
        return (
          <div key={g.id}>
            <h3 className="m-0">
              <button
                onClick={() => toggle(g.id)}
                aria-expanded={isOpen}
                aria-controls={listId}
                className="w-full px-4 py-2.5 flex items-center gap-2 bg-ink-50/80 hover:bg-ink-50 border-y border-ink-100 sticky top-0 z-[1] focus-visible:outline-none focus-visible:bg-info-50"
                title={g.name}
              >
                <FolderTree className="w-3.5 h-3.5 text-ink-500 shrink-0" aria-hidden="true" />
                <span className="text-2xs font-bold uppercase tracking-[0.18em] text-ink-700 truncate flex-1 text-left">
                  {g.name}
                </span>
                <span className="inline-flex items-center gap-1.5 text-2xs tabular-nums">
                  {g.counts.pass > 0 && <span className="text-success-700 font-bold">{g.counts.pass}</span>}
                  {g.counts.fail > 0 && <span className="text-danger-700 font-bold">{g.counts.fail}</span>}
                  {g.counts.blocked > 0 && <span className="text-warn-700 font-bold">{g.counts.blocked}</span>}
                </span>
                {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-ink-400" aria-hidden="true" /> : <ChevronRight className="w-3.5 h-3.5 text-ink-400" aria-hidden="true" />}
              </button>
            </h3>
            {isOpen && (
              <ul role="list" id={listId} className="list-none m-0 p-0">
                {g.items.map((r) => {
                  const meta = statusMeta(r.status || 'blocked');
                  const Icon = meta.icon;
                  const isActive = activeResultId === r.id;
                  return (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => onPick(r)}
                        aria-current={isActive ? 'true' : undefined}
                        className={`w-full text-left px-4 py-2.5 border-b border-ink-100 flex items-start gap-3 transition-colors focus-visible:outline-none focus-visible:bg-info-50 ${
                          isActive ? 'bg-info-50/60 border-l-2 border-l-info-500' : 'hover:bg-ink-50/60'
                        }`}
                      >
                        <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${meta.text}`} aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-ink-900 line-clamp-2 flex items-center gap-1.5">
                            {r.testCase?.name || r.testCaseId}
                            {r.rcaWhat && <BrainCircuit className="w-3 h-3 text-accent-600 shrink-0" aria-label="AI root cause available" />}
                            {r.ticketId && <Bug className="w-3 h-3 text-info-600 shrink-0" aria-label={`Ticket ${r.ticketId}`} />}
                          </div>
                          <div className="flex items-center gap-2 mt-1 text-2xs text-ink-500">
                            {r.testCase?.module && <span className="font-mono">{r.testCase.module}</span>}
                            {r.testCase?.module && <span>·</span>}
                            <span className="tabular-nums">{r.durationMs ? `${r.durationMs}ms` : '—'}</span>
                          </div>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Bar({ passed, failed, blocked, skipped }) {
  const t = (passed || 0) + (failed || 0) + (blocked || 0) + (skipped || 0);
  if (!t) return null;
  return (
    <div className="flex h-1.5 w-full rounded-pill overflow-hidden bg-ink-100">
      {passed > 0  && <div className="bg-success-500" style={{ width: `${(passed / t) * 100}%` }}  title={`${passed} passed`} />}
      {failed > 0  && <div className="bg-danger-500"  style={{ width: `${(failed / t) * 100}%` }}  title={`${failed} failed`} />}
      {blocked > 0 && <div className="bg-warn-500"    style={{ width: `${(blocked / t) * 100}%` }} title={`${blocked} blocked`} />}
      {skipped > 0 && <div className="bg-ink-400"     style={{ width: `${(skipped / t) * 100}%` }} title={`${skipped} skipped`} />}
    </div>
  );
}

function RunStatusPill({ status }) {
  const map = {
    completed: 'bg-success-50 text-success-700 border-success-100',
    failed:    'bg-danger-50 text-danger-700 border-danger-100',
    cancelled: 'bg-ink-100 text-ink-600 border-ink-200',
    running:   'bg-info-50 text-info-700 border-info-100',
  };
  return (
    <span className={`text-2xs uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-pill border ${map[status] || map.running}`}>
      {status}
    </span>
  );
}

function DetailPane({ result, testCase, projectId }) {
  const meta = statusMeta(result.status || 'blocked');
  const Icon = meta.icon;

  // Heading ref + focus-on-change: when the user picks a different result,
  // shift focus to the detail heading so keyboard users land on the new
  // content instead of remaining on whatever button they clicked.
  const headingRef = useRef(null);
  useEffect(() => {
    // Schedule on next tick so React has rendered the new content already.
    const id = setTimeout(() => { headingRef.current?.focus(); }, 0);
    return () => clearTimeout(id);
  }, [result.id]);

  const traceSteps = useMemo(() => {
    if (!result.trace) return [];
    return String(result.trace)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, i) => {
        // Phase E2 — assertion_check rows render as "ASSERTION: ✓/✗/… …".
        // Pick them out so they can be visually distinguished from regular
        // browser_ tool calls — they're the correctness gate, not the
        // exploration trail.
        const isAssertion = /^ASSERTION:/.test(line);
        const assertionMatched = isAssertion && /^ASSERTION:\s*✓/.test(line);
        const assertionFailed  = isAssertion && /^ASSERTION:\s*✗/.test(line);
        const isPass    = !isAssertion && /^✓|^pass/i.test(line);
        const isFail    = !isAssertion && /^✗|fail|error/i.test(line);
        return {
          order: i + 1, text: line,
          isPass, isFail,
          isAssertion, assertionMatched, assertionFailed,
        };
      });
  }, [result.trace]);

  const screenshots = Array.isArray(result.screenshots) ? result.screenshots : [];

  return (
    <div className="max-w-4xl mx-auto px-page py-8 space-y-5">
      {/* Header */}
      <header className={`rounded-card border ${meta.border} ${meta.bg} p-5`}>
        <div className="flex items-start gap-4">
          <div className={`w-12 h-12 rounded-lg bg-white ring-2 ring-white flex items-center justify-center shrink-0`}>
            <Icon className={`w-6 h-6 ${meta.text}`} aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className={`text-2xs uppercase tracking-wider font-bold px-2 py-0.5 rounded-pill bg-white ${meta.text} border ${meta.border}`}>
                {meta.label}
              </span>
              {testCase?.module && (
                <span className="text-2xs uppercase tracking-wider text-ink-600 font-semibold">{testCase.module}</span>
              )}
              {testCase?.type && (
                <span className="text-2xs uppercase tracking-wider text-ink-600 font-semibold">{testCase.type}</span>
              )}
              <span className="ml-auto text-xs text-ink-600 tabular-nums inline-flex items-center gap-1">
                <Clock className="w-3 h-3" aria-hidden="true" />
                {result.durationMs ? `${result.durationMs}ms` : '—'}
              </span>
            </div>
            {testCase?.scenario?.name && (
              <div className="text-2xs text-ink-500 mb-0.5 inline-flex items-center gap-1.5">
                <FolderTree className="w-3 h-3" aria-hidden="true" />
                <span className="font-semibold uppercase tracking-wider">Scenario</span>
                <span className="text-ink-700 normal-case font-medium tracking-normal">{testCase.scenario.name}</span>
              </div>
            )}
            <h2
              ref={headingRef}
              tabIndex={-1}
              className="text-lg font-semibold text-ink-900 tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-info-300 focus-visible:ring-offset-2 rounded"
            >
              {testCase?.name || result.testCaseId}
            </h2>
          </div>
        </div>
      </header>

      {/* Test history — sparkline of recent runs for this test case + flaky
          score. Mounted only when we have the projectId + tcId we need to
          query the history endpoint. */}
      {testCase?.id && projectId && (
        <TestHistoryPanel projectId={projectId} testCaseId={testCase.id} currentRunId={result.runId} />
      )}

      {/* AI Root Cause panel */}
      {result.rcaWhat && (
        <RcaPanel result={result} projectId={projectId} />
      )}

      {/* AI chat — talk to Claude about THIS failure. Persists per-result. */}
      <RcaChatPanel
        projectId={projectId}
        runId={result.runId}
        resultId={result.id}
        initialHistory={Array.isArray(result.chatHistory) ? result.chatHistory : []}
      />

      {/* Per-test-case user guidance — free-form notes the Conductor /
          Critic / Supervisor honour on every future run of THIS case. */}
      {testCase?.id && projectId && (
        <CaseGuidanceEditor
          projectId={projectId}
          testCaseId={testCase.id}
          testCaseName={testCase.name}
          initialValue={testCase.userGuidance || ''}
        />
      )}

      {/* Error / Blocked block — falls back to BlockedItem.message when the
          test was blocked and result.error is empty (common after Conductor
          gives up between retries). */}
      {(result.error || result.blocked?.message) && (
        <ErrorBlock result={result} />
      )}

      {/* Network log */}
      {Array.isArray(result.networkLog) && result.networkLog.length > 0 && (
        <NetworkLogPanel entries={result.networkLog} />
      )}

      {/* Trace */}
      <TraceSection traceSteps={traceSteps} />

      {/* Screenshots */}
      {screenshots.length > 0 && (
        <section className="rounded-card border border-ink-200 bg-white shadow-card overflow-hidden">
          <div className="px-5 py-3 border-b border-ink-100 flex items-center gap-2">
            <Camera className="w-4 h-4 text-ink-500" />
            <h3 className="text-sm font-semibold text-ink-900">Screenshots</h3>
            <span className="text-2xs text-ink-500 tabular-nums">{screenshots.length}</span>
          </div>
          <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3 bg-ink-50">
            {screenshots.map((s, i) => (
              <a
                key={i}
                href={absUrl(s)}
                target="_blank"
                rel="noreferrer"
                className="block rounded-md border border-ink-200 bg-white overflow-hidden hover:border-ink-400 hover:shadow-card-hover transition-all"
              >
                <div className="bg-ink-100 px-3 py-1.5 border-b border-ink-200 flex items-center justify-between">
                  <span className="text-2xs font-mono text-ink-600 truncate">{s.split('/').pop()}</span>
                  <ImageIcon className="w-3 h-3 text-ink-400" />
                </div>
                <img
                  src={absUrl(s)}
                  alt={`screenshot ${i + 1}`}
                  className="block w-full h-auto bg-white"
                  loading="lazy"
                  onError={(e) => { e.target.style.display = 'none'; }}
                />
              </a>
            ))}
          </div>
        </section>
      )}

      {/* Visual diff (Phase E4). Renders only when there is something to
          say — either a baseline + current to compare against, or a
          verdict from a prior VisualCritic pass. Pass-verdict shows as a
          one-line confirmation; fail/inconclusive opens the side-by-side. */}
      {(result.baselineScreenshot || result.visualVerdict) && (
        <VisualDiffSection
          result={result}
          currentScreenshot={screenshots.length ? screenshots[screenshots.length - 1] : null}
        />
      )}

      {/* Video */}
      {result.video && (
        <section className="rounded-card border border-ink-200 bg-white shadow-card overflow-hidden">
          <div className="px-5 py-3 border-b border-ink-100 flex items-center gap-2">
            <Video className="w-4 h-4 text-ink-500" />
            <h3 className="text-sm font-semibold text-ink-900">Recording</h3>
          </div>
          <video controls className="block w-full bg-ink-900" preload="metadata">
            <source src={absUrl(result.video)} />
          </video>
        </section>
      )}

      {/* Spec code */}
      {testCase?.id && projectId && (
        <SpecCodeSection testCase={testCase} projectId={projectId} />
      )}
    </div>
  );
}

function ErrorBlock({ result }) {
  const isBlocked = result.status === 'blocked';
  const message = result.error || result.blocked?.message || '';
  const reason = result.blocked?.reason;
  const locator = result.blocked?.locator;
  const reasonMeta = {
    locator_missing:  { label: 'Locator missing',  text: 'text-warn-700',   bg: 'bg-warn-50',   border: 'border-warn-200' },
    timeout:          { label: 'Timeout',          text: 'text-warn-700',   bg: 'bg-warn-50',   border: 'border-warn-200' },
    assertion:        { label: 'Assertion failed', text: 'text-danger-700', bg: 'bg-danger-50', border: 'border-danger-200' },
    network:          { label: 'Network',          text: 'text-danger-700', bg: 'bg-danger-50', border: 'border-danger-200' },
    supervisor_giveup:{ label: 'Supervisor stopped', text: 'text-ink-700',  bg: 'bg-ink-100',   border: 'border-ink-200' },
    unknown:          { label: 'Unknown',          text: 'text-ink-700',    bg: 'bg-ink-100',   border: 'border-ink-200' },
  }[reason] || { label: reason || (isBlocked ? 'Blocked' : 'Error'), text: 'text-danger-700', bg: 'bg-danger-50', border: 'border-danger-200' };

  const tone = isBlocked
    ? { border: 'border-warn-200', headBg: 'bg-warn-50', headBorder: 'border-warn-100', headIcon: 'text-warn-700', headText: 'text-warn-800', title: 'Blocked', preColor: 'text-warn-200' }
    : { border: 'border-danger-200', headBg: 'bg-danger-50', headBorder: 'border-danger-100', headIcon: 'text-danger-600', headText: 'text-danger-800', title: 'Error', preColor: 'text-danger-300' };

  return (
    <section className={`rounded-card border ${tone.border} bg-white shadow-card overflow-hidden`}>
      <div className={`px-5 py-3 ${tone.headBg} border-b ${tone.headBorder} flex items-center gap-2 flex-wrap`}>
        <AlertOctagon className={`w-4 h-4 ${tone.headIcon}`} />
        <h3 className={`text-sm font-semibold ${tone.headText}`}>{tone.title}</h3>
        {reason && (
          <span className={`text-2xs uppercase tracking-wider font-bold px-2 py-0.5 rounded-pill ${reasonMeta.bg} ${reasonMeta.text} border ${reasonMeta.border}`}>
            {reasonMeta.label}
          </span>
        )}
        {locator && (
          <code className="text-2xs font-mono text-ink-700 bg-white border border-ink-200 rounded px-1.5 py-0.5 ml-1 max-w-[60%] truncate">
            {locator}
          </code>
        )}
      </div>
      {message ? (
        <pre className={`bg-ink-900 ${tone.preColor} text-xs font-mono leading-relaxed p-4 overflow-x-auto whitespace-pre-wrap max-h-72`}>{message}</pre>
      ) : (
        <div className="px-5 py-4 text-xs text-ink-500 italic">No diagnostic message recorded. Check the Trace below for the last action before the test stopped.</div>
      )}
    </section>
  );
}

// Phase E4 — visual regression. Renders the visualCritic verdict + the
// baseline-vs-current side-by-side. Designed to stay quiet when nothing
// went wrong (no shouty banners on pass) and only reveal the side-by-side
// when the verdict suggests a regression OR the user explicitly expands.
const VISUAL_VERDICT_META = {
  pass: {
    label: 'No visual regression',
    tone: 'success',
    icon: CheckCircle2,
    text: 'text-success-700', bg: 'bg-success-50', border: 'border-success-200',
  },
  fail: {
    label: 'Visual regression',
    tone: 'danger',
    icon: AlertOctagon,
    text: 'text-danger-700', bg: 'bg-danger-50', border: 'border-danger-200',
  },
  inconclusive: {
    label: 'Inconclusive',
    tone: 'warn',
    icon: ScanSearch,
    text: 'text-warn-700', bg: 'bg-warn-50', border: 'border-warn-200',
  },
};

const SEVERITY_DOT = {
  high:   'bg-danger-500',
  medium: 'bg-warn-500',
  low:    'bg-ink-300',
};

function VisualDiffSection({ result, currentScreenshot }) {
  const verdict = result.visualVerdict || null;
  const meta = verdict ? VISUAL_VERDICT_META[verdict] : null;
  const diffs = Array.isArray(result.visualDiffs) ? result.visualDiffs : [];
  // Auto-expand when something is worth showing: a non-pass verdict, or
  // diffs to inspect. Pass-with-no-diffs stays collapsed by default.
  const [open, setOpen] = useState(verdict === 'fail' || verdict === 'inconclusive');
  const hasBaseline = !!result.baselineScreenshot;
  const Icon = meta?.icon || Eye;

  return (
    <section className="rounded-card border border-ink-200 bg-white shadow-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-5 py-3 border-b border-ink-100 flex items-center gap-2 hover:bg-ink-50 transition-colors text-left"
      >
        <Eye className="w-4 h-4 text-ink-500" />
        <h3 className="text-sm font-semibold text-ink-900">Visual</h3>
        {meta && (
          <span className={`text-2xs uppercase tracking-wider font-bold px-2 py-0.5 rounded-pill ${meta.bg} ${meta.text} border ${meta.border} inline-flex items-center gap-1`}>
            <Icon className="w-3 h-3" />
            {meta.label}
          </span>
        )}
        {!meta && hasBaseline && (
          <span className="text-2xs text-ink-500">
            Baseline captured · awaiting next run for comparison
          </span>
        )}
        {open ? <ChevronDown className="w-3.5 h-3.5 ml-auto text-ink-400" /> : <ChevronRight className="w-3.5 h-3.5 ml-auto text-ink-400" />}
      </button>

      {open && (
        <div className="p-4 space-y-4 bg-ink-50">
          {/* Narration */}
          {result.visualDiffSummary && (
            <div className={`rounded border ${meta?.border || 'border-ink-200'} ${meta?.bg || 'bg-white'} p-3`}>
              <p className={`text-xs leading-relaxed ${meta?.text || 'text-ink-700'}`}>
                {result.visualDiffSummary}
              </p>
            </div>
          )}

          {/* Diff list */}
          {diffs.length > 0 && (
            <ul className="space-y-1.5">
              {diffs.map((d, i) => (
                <li key={i} className="rounded border border-ink-200 bg-white p-3">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full ${SEVERITY_DOT[d.severity] || SEVERITY_DOT.low}`} />
                    <span className="text-xs font-semibold text-ink-800">{d.region || 'change'}</span>
                    <span className="text-2xs uppercase tracking-wider text-ink-500 ml-auto">{d.severity || 'low'}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <div className="text-2xs uppercase tracking-wider text-ink-500 mb-0.5">Baseline</div>
                      <div className="text-ink-700">{d.before || <span className="italic text-ink-400">—</span>}</div>
                    </div>
                    <div>
                      <div className="text-2xs uppercase tracking-wider text-ink-500 mb-0.5">Current</div>
                      <div className="text-ink-700">{d.after || <span className="italic text-ink-400">—</span>}</div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* Side-by-side. Only when we have a baseline AND a current
              screenshot to render; otherwise show the one we have alone. */}
          {(result.baselineScreenshot || currentScreenshot) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {result.baselineScreenshot && (
                <a
                  href={absUrl(result.baselineScreenshot)}
                  target="_blank"
                  rel="noreferrer"
                  className="block rounded-md border border-ink-200 bg-white overflow-hidden hover:border-ink-400 hover:shadow-card-hover transition-all"
                >
                  <div className="bg-ink-100 px-3 py-1.5 border-b border-ink-200 flex items-center justify-between">
                    <span className="text-2xs uppercase tracking-wider font-bold text-ink-600">Baseline</span>
                    <ImageIcon className="w-3 h-3 text-ink-400" />
                  </div>
                  <img
                    src={absUrl(result.baselineScreenshot)}
                    alt="baseline"
                    className="block w-full h-auto bg-white"
                    loading="lazy"
                    onError={(e) => { e.target.style.display = 'none'; }}
                  />
                </a>
              )}
              {currentScreenshot && (
                <a
                  href={absUrl(currentScreenshot)}
                  target="_blank"
                  rel="noreferrer"
                  className="block rounded-md border border-ink-200 bg-white overflow-hidden hover:border-ink-400 hover:shadow-card-hover transition-all"
                >
                  <div className="bg-ink-100 px-3 py-1.5 border-b border-ink-200 flex items-center justify-between">
                    <span className="text-2xs uppercase tracking-wider font-bold text-ink-600">Current</span>
                    <ImageIcon className="w-3 h-3 text-ink-400" />
                  </div>
                  <img
                    src={absUrl(currentScreenshot)}
                    alt="current"
                    className="block w-full h-auto bg-white"
                    loading="lazy"
                    onError={(e) => { e.target.style.display = 'none'; }}
                  />
                </a>
              )}
            </div>
          )}

          {/* Empty-state hint when we have a baseline but no verdict yet —
              happens on the very first pass that wrote it. */}
          {!verdict && hasBaseline && (
            <p className="text-2xs text-ink-500 italic">
              The next pass of this case will compare against this baseline.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function TraceSection({ traceSteps }) {
  return (
    <section className="rounded-card border border-ink-200 bg-white shadow-card overflow-hidden">
      <div className="px-5 py-3 border-b border-ink-100 flex items-center gap-2">
        <Activity className="w-4 h-4 text-ink-500" />
        <h3 className="text-sm font-semibold text-ink-900">Trace</h3>
        <span className="text-2xs text-ink-500 tabular-nums">{traceSteps.length} step{traceSteps.length === 1 ? '' : 's'}</span>
      </div>
      {traceSteps.length === 0 ? (
        <div className="text-xs text-ink-400 px-5 py-6 text-center italic">No trace recorded for this test.</div>
      ) : (
        <ol className="divide-y divide-ink-100 max-h-[480px] overflow-y-auto">
          {traceSteps.map((s) => <TraceStep key={s.order} step={s} />)}
        </ol>
      )}
    </section>
  );
}

function TraceStep({ step }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = step.text.length > 120;
  // Phase E2 — assertion_check rows get accent (success/danger by matched)
  // and a distinguishable left-border so the eye picks them out as the
  // correctness checkpoints among the browser_ exploration noise.
  const toneRow = step.assertionFailed
    ? 'bg-danger-100/60 hover:bg-danger-100 border-l-4 border-danger-500'
    : step.assertionMatched
      ? 'bg-success-100/50 hover:bg-success-100 border-l-4 border-success-500'
      : step.isAssertion
        ? 'bg-ink-100/60 hover:bg-ink-100 border-l-4 border-ink-300'
        : step.isFail
          ? 'bg-danger-50/60 hover:bg-danger-50'
          : step.isPass
            ? 'bg-success-50/30 hover:bg-success-50/60'
            : 'hover:bg-ink-50/60';
  const toneText = step.assertionFailed
    ? 'text-danger-800 font-semibold'
    : step.assertionMatched
      ? 'text-success-800 font-semibold'
      : step.isFail
        ? 'text-danger-700'
        : step.isPass
          ? 'text-success-700'
          : 'text-ink-700';
  return (
    <li className={`grid grid-cols-[36px_1fr_auto] items-start gap-3 px-5 py-2 ${toneRow} transition-colors`}>
      <div className="flex items-center justify-end pt-0.5">
        <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-2xs font-bold tabular-nums ${
          step.assertionFailed
            ? 'bg-danger-200 text-danger-800'
            : step.assertionMatched
              ? 'bg-success-200 text-success-800'
              : step.isFail
                ? 'bg-danger-100 text-danger-700'
                : step.isPass
                  ? 'bg-success-100 text-success-700'
                  : 'bg-ink-100 text-ink-600'
        }`}>{step.order}</span>
      </div>
      <div className={`text-xs font-mono leading-relaxed ${toneText} min-w-0`}>
        {expanded || !isLong ? (
          <div className="whitespace-pre-wrap break-all">{step.text}</div>
        ) : (
          <div className="truncate" title="Click expand to see full step">{step.text}</div>
        )}
      </div>
      {isLong && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-2xs font-semibold text-ink-500 hover:text-ink-900 px-2 py-0.5 rounded-pill hover:bg-white border border-transparent hover:border-ink-200 shrink-0"
        >
          {expanded ? 'collapse' : 'expand'}
        </button>
      )}
    </li>
  );
}

function RcaPanel({ result, projectId }) {
  const [filing, setFiling] = useState(null);
  const [ticket, setTicket] = useState(
    result.ticketId ? { id: result.ticketId, url: result.ticketUrl } : null
  );
  const toast = useToast();

  // Sync local ticket state if result changes
  useEffect(() => {
    setTicket(result.ticketId ? { id: result.ticketId, url: result.ticketUrl } : null);
  }, [result.id, result.ticketId, result.ticketUrl]);

  const classMeta = {
    locator: { bg: 'bg-warn-50', text: 'text-warn-700', label: 'Locator' },
    data:    { bg: 'bg-info-50', text: 'text-info-700', label: 'Data' },
    timing:  { bg: 'bg-accent-50', text: 'text-accent-700', label: 'Timing' },
    backend: { bg: 'bg-danger-50', text: 'text-danger-700', label: 'Backend' },
    env:     { bg: 'bg-ink-100', text: 'text-ink-700', label: 'Environment' },
    unknown: { bg: 'bg-ink-100', text: 'text-ink-600', label: 'Unknown' },
  }[result.rcaClass] || { bg: 'bg-ink-100', text: 'text-ink-600', label: 'Unknown' };

  const createTicket = async (target) => {
    setFiling(target);
    try {
      const res = await api.post(`/runs/${result.runId}/results/${result.id}/ticket`, { target });
      setTicket({ id: res.ticketId, url: res.ticketUrl });
      toast.success(
        <span>Ticket {res.ticketId} created. <a href={res.ticketUrl} target="_blank" rel="noreferrer" className="underline">Open →</a></span>,
        { title: target.toUpperCase() + ' ticket filed' }
      );
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: `Could not create ${target.toUpperCase()} ticket` });
    } finally {
      setFiling(null);
    }
  };

  return (
    <section className="rounded-card border border-accent-200 bg-white shadow-card overflow-hidden">
      <div className="px-5 py-3 bg-gradient-to-r from-accent-50 to-white border-b border-accent-100 flex items-center gap-2">
        <BrainCircuit className="w-4 h-4 text-accent-700" />
        <h3 className="text-sm font-semibold text-accent-900">AI Root Cause Analysis</h3>
        <span className={`ml-auto inline-flex items-center gap-1.5 px-2 py-0.5 rounded-pill text-2xs font-bold uppercase tracking-wider ${classMeta.bg} ${classMeta.text}`}>
          {classMeta.label}
        </span>
        {typeof result.rcaConfidence === 'number' && (
          <span className="text-2xs text-ink-500 tabular-nums font-semibold">
            confidence <span className="text-ink-800">{result.rcaConfidence}%</span>
          </span>
        )}
      </div>
      <div className="px-5 py-4 space-y-3 text-sm leading-relaxed">
        <div>
          <div className="text-2xs uppercase tracking-wider font-bold text-ink-500 mb-1">What</div>
          <p className="text-ink-800">{result.rcaWhat}</p>
        </div>
        <div>
          <div className="text-2xs uppercase tracking-wider font-bold text-ink-500 mb-1">Why</div>
          <p className="text-ink-700">{result.rcaWhy}</p>
        </div>
        <div>
          <div className="text-2xs uppercase tracking-wider font-bold text-ink-500 mb-1">Suggested fix</div>
          <p className="text-ink-700 whitespace-pre-wrap">{result.rcaFix}</p>
        </div>
      </div>
      <div className="px-5 py-3 border-t border-ink-100 bg-ink-50/60 flex items-center gap-2">
        {ticket ? (
          <a
            href={ticket.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-info-700 hover:text-info-800"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            {ticket.id} — open ticket
          </a>
        ) : (
          <>
            <Button size="sm" variant="secondary" onClick={() => createTicket('jira')} loading={filing === 'jira'} disabled={!!filing}>
              <Bug className="w-3.5 h-3.5" />
              Create Jira ticket
            </Button>
            <Button size="sm" variant="secondary" onClick={() => createTicket('ado')} loading={filing === 'ado'} disabled={!!filing}>
              <Bug className="w-3.5 h-3.5" />
              Create ADO ticket
            </Button>
            <span className="ml-auto text-2xs text-ink-500">Evidence (error + steps + RCA) auto-attached</span>
          </>
        )}
      </div>
    </section>
  );
}

function NetworkLogPanel({ entries }) {
  const [open, setOpen] = useState(false);
  const counts = useMemo(() => {
    const c = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
    for (const e of entries) {
      const s = Number(e.status);
      if (s >= 200 && s < 300) c['2xx']++;
      else if (s >= 300 && s < 400) c['3xx']++;
      else if (s >= 400 && s < 500) c['4xx']++;
      else if (s >= 500) c['5xx']++;
    }
    return c;
  }, [entries]);
  return (
    <section className="rounded-card border border-ink-200 bg-white shadow-card overflow-hidden">
      <button onClick={() => setOpen((v) => !v)} className="w-full px-5 py-3 border-b border-ink-100 flex items-center gap-2 hover:bg-ink-50/60">
        <Activity className="w-4 h-4 text-ink-500" />
        <h3 className="text-sm font-semibold text-ink-900">Network log</h3>
        <span className="text-2xs text-ink-500 tabular-nums">{entries.length}</span>
        <span className="ml-3 inline-flex items-center gap-2 text-2xs">
          <span className="text-success-700 font-semibold tabular-nums">{counts['2xx']}✓</span>
          <span className="text-warn-700 font-semibold tabular-nums">{counts['3xx']}↻</span>
          <span className="text-danger-700 font-semibold tabular-nums">{counts['4xx']}✗</span>
          <span className="text-danger-700 font-semibold tabular-nums">{counts['5xx']}!!</span>
        </span>
        <span className="ml-auto text-ink-400">{open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</span>
      </button>
      {open && (
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="bg-ink-50 text-2xs uppercase tracking-wider text-ink-600">
              <tr>
                <th className="text-left px-4 py-2">Method</th>
                <th className="text-left px-4 py-2">Status</th>
                <th className="text-left px-4 py-2">URL</th>
                <th className="text-left px-4 py-2">Type</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => {
                const s = Number(e.status);
                const cls = s >= 500 ? 'text-danger-700' : s >= 400 ? 'text-danger-600' : s >= 300 ? 'text-warn-700' : 'text-success-700';
                return (
                  <tr key={i} className="border-t border-ink-100 hover:bg-ink-50/40">
                    <td className="px-4 py-1.5 font-mono font-semibold text-ink-700">{e.method}</td>
                    <td className={`px-4 py-1.5 font-mono font-bold tabular-nums ${cls}`}>{e.status}</td>
                    <td className="px-4 py-1.5 font-mono text-ink-600 truncate max-w-[420px]">{e.url}</td>
                    <td className="px-4 py-1.5 text-2xs text-ink-500 uppercase tracking-wider">{e.resourceType || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * Tiny trend panel showing the last N statuses for this test case as a
 * sparkline + a flaky-score chip. Backed by GET /test-cases/:tc/history.
 *
 * The sparkline values are coded numerically (pass=2, fail=0, blocked=1)
 * just so the existing Sparkline component (which expects numbers) can
 * draw a meaningful line — the actual story is the colour-coded run dots
 * below. Hover/focus reveals the run sprint name + date for each point.
 */
function TestHistoryPanel({ projectId, testCaseId, currentRunId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.get(`/projects/${projectId}/test-cases/${testCaseId}/history?limit=20`)
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof ApiError ? err.toUserMessage() : err.message;
        setError(msg);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, testCaseId]);

  if (loading) {
    return (
      <section className="rounded-card border border-ink-200 bg-white shadow-card p-4 space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-6 w-full" />
      </section>
    );
  }
  if (error || !data?.history?.length) {
    // Don't render a noisy error card — most likely the test just has no
    // history yet (first run). Stay quiet.
    return null;
  }

  const { history, stats } = data;
  const values = history.map((h) => (h.status === 'pass' ? 2 : h.status === 'blocked' ? 1 : 0));
  const stroke = stats.passRate >= 80 ? '#10b981' : stats.passRate >= 40 ? '#f59e0b' : '#ef4444';
  const flakyTone = stats.flakyScore >= 50
    ? { cls: 'bg-danger-50 text-danger-700 border-danger-200', label: 'Highly flaky' }
    : stats.flakyScore >= 20
    ? { cls: 'bg-warn-50 text-warn-700 border-warn-200', label: 'Somewhat flaky' }
    : { cls: 'bg-success-50 text-success-700 border-success-200', label: 'Stable' };

  return (
    <section className="rounded-card border border-ink-200 bg-white shadow-card overflow-hidden">
      <div className="px-5 py-3 border-b border-ink-100 flex items-center gap-2 flex-wrap">
        <History className="w-4 h-4 text-ink-500" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-ink-900">Recent history</h3>
        <span className="text-2xs text-ink-500 tabular-nums">{history.length} run{history.length === 1 ? '' : 's'}</span>
        <span className={`ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-2xs font-bold uppercase tracking-wider border ${flakyTone.cls}`}>
          <TrendingUp className="w-3 h-3" aria-hidden="true" />
          {flakyTone.label} · {stats.flakyScore}%
        </span>
      </div>
      <div className="p-4 space-y-3">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-2xs uppercase tracking-wider font-bold text-ink-500">Pass rate</span>
            <span className="text-sm font-semibold text-ink-900 tabular-nums">{stats.passRate}%</span>
          </div>
          {stats.lastFailureAt && (
            <div className="flex items-center gap-2">
              <span className="text-2xs uppercase tracking-wider font-bold text-ink-500">Last failure</span>
              <span className="text-2xs text-ink-700 tabular-nums">
                {new Date(stats.lastFailureAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </span>
            </div>
          )}
          <div className="ml-auto"><Sparkline values={values} width={120} height={28} stroke={stroke} /></div>
        </div>
        {/* Per-run status dots — chronological left → right. Current run is ringed. */}
        <ol className="flex items-center gap-1 flex-wrap" aria-label="Run-by-run status">
          {history.map((h) => {
            const tone = h.status === 'pass'
              ? 'bg-success-500'
              : h.status === 'fail'
              ? 'bg-danger-500'
              : h.status === 'blocked'
              ? 'bg-warn-500'
              : 'bg-ink-300';
            const isCurrent = h.runId === currentRunId;
            const date = h.startedAt ? new Date(h.startedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
            return (
              <li key={h.runId} title={`${h.status} · ${date}${h.sprintName ? ` · ${h.sprintName}` : ''}`}>
                <span
                  aria-label={`${h.status} on ${date}${isCurrent ? ' (current)' : ''}`}
                  className={`block w-3 h-3 rounded-full ${tone} ${isCurrent ? 'ring-2 ring-info-500 ring-offset-1' : ''}`}
                />
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

function SpecCodeSection({ testCase, projectId }) {
  const [code, setCode] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => { setCode(null); setExpanded(false); }, [testCase?.id]);

  const handleExpand = useCallback(async () => {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (code !== null) return;
    setLoading(true);
    try {
      // Routes through the shared api client so we get the same auth +
      // refresh + error-normalisation behaviour as every other request.
      const fname = `${testCase.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.spec.ts`;
      const json = await api.get(`/projects/${projectId}/output-files/${encodeURIComponent(fname)}`);
      setCode(json?.content || '');
    } catch (err) {
      // 404 (no spec on disk) and 5xx both end up here. Distinguish so the
      // user gets a useful message for transient errors instead of the
      // generic "spec not found" copy.
      if (err instanceof ApiError && err.status === 404) {
        setCode('');
      } else {
        const msg = err instanceof ApiError ? err.toUserMessage() : err.message;
        setCode(`// Could not load spec: ${msg}`);
      }
    } finally {
      setLoading(false);
    }
  }, [code, expanded, testCase, projectId]);

  return (
    <section className="rounded-card border border-ink-200 bg-white shadow-card overflow-hidden">
      <button
        onClick={handleExpand}
        aria-expanded={expanded}
        className="w-full px-5 py-3 border-b border-ink-100 flex items-center gap-2 hover:bg-ink-50/60 focus-visible:outline-none focus-visible:bg-info-50"
      >
        <FileCode className="w-4 h-4 text-ink-500" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-ink-900">Generated spec</h3>
        <span className="ml-auto text-ink-400">
          {expanded ? <ChevronDown className="w-4 h-4" aria-hidden="true" /> : <ChevronRight className="w-4 h-4" aria-hidden="true" />}
        </span>
      </button>
      {expanded && (
        loading ? (
          <div className="text-xs text-ink-500 p-4 italic">Loading…</div>
        ) : code ? (
          <pre className="bg-ink-900 text-emerald-300 text-xs font-mono p-4 overflow-x-auto leading-relaxed">{code}</pre>
        ) : (
          <div className="text-xs text-ink-500 p-4 italic">
            No spec file on disk for this test. Specs are written only when the Conductor's actions succeed against the live target.
          </div>
        )
      )}
    </section>
  );
}

// ── ClaudeRateLimitChip ─────────────────────────────────────────────
// Live current-minute Anthropic rate-limit indicator. Reads token usage
// directly from `anthropic-ratelimit-tokens-*` response headers (captured
// server-side and broadcast over WS). This is the most honest signal we
// can show: it's a real header value Anthropic emits, not an artificial cap.
//
// Window: per-minute TPM. The percentage resets when the next minute starts.
// Resets countdown derived from `resetAt` ISO timestamp.
//
// Empty state: render nothing until the first Claude call has landed.
function ClaudeRateLimitChip({ info, aiProvider }) {
  // Gemini does not return per-request remaining-tokens headers, so this
  // chip is Claude-only. Hide it entirely on Gemini-backed projects rather
  // than show stale Anthropic numbers carried over from a previous run.
  if (aiProvider && aiProvider !== 'claude') return null;
  if (!info?.tokens?.limit) return null;
  const { remaining, limit, resetAt } = info.tokens;
  const used = Math.max(0, (limit || 0) - (remaining || 0));
  const usedPercent = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  // tone: green when there's plenty of headroom, amber 60-89%, red 90%+.
  // The bar fills to the USED side so the chip reads like a fuel gauge.
  const tone = usedPercent >= 90
    ? { bar: 'bg-danger-500', bg: 'bg-danger-50', text: 'text-danger-700', border: 'border-danger-200' }
    : usedPercent >= 60
    ? { bar: 'bg-warn-500',   bg: 'bg-warn-50',   text: 'text-warn-700',   border: 'border-warn-200' }
    : { bar: 'bg-success-500',bg: 'bg-success-50',text: 'text-success-700',border: 'border-success-200' };
  const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
  const resetIn = resetIsoToCountdown(resetAt);
  return (
    <span
      className={`hidden md:inline-flex items-center gap-1.5 px-2.5 h-8 rounded-pill text-2xs font-semibold border ${tone.bg} ${tone.text} ${tone.border}`}
      title={`Anthropic rate limit: ${used.toLocaleString()} of ${limit.toLocaleString()} tokens used in the current minute window${resetAt ? ` (resets in ~${resetIn})` : ''}.`}
      aria-label={`Anthropic token rate limit: ${usedPercent}% used`}
    >
      <Zap className="w-3 h-3" aria-hidden="true" />
      <span className="hidden lg:inline">TPM</span>
      <span className="w-12 h-1.5 bg-ink-100 rounded-full overflow-hidden" aria-hidden="true">
        <span className={`block h-full ${tone.bar} transition-all`} style={{ width: `${usedPercent}%` }} />
      </span>
      <span className="tabular-nums">{usedPercent}%</span>
      <span className="text-ink-400 font-normal hidden lg:inline">
        {fmt(remaining)}/{fmt(limit)}
        {resetAt && ` · ${resetIn}`}
      </span>
    </span>
  );
}

// Format `resetAt` ISO timestamp as a short countdown ("18s", "1m"). Returns
// "now" if already past.
function resetIsoToCountdown(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.round(s / 60)}m`;
}

// ── RcaChatPanel ───────────────────────────────────────────────────
// Conversational follow-up on a specific failure. User asks questions,
// Claude responds with context-aware analysis (it has the error, trace,
// network log, screenshots, and prior structured RCA in scope server-side).
// Chat history persists per-RunResult so reloads preserve the thread.
function RcaChatPanel({ projectId, runId, resultId, initialHistory }) {
  const toast = useToast();
  const [history, setHistory] = React.useState(initialHistory || []);
  const [draft, setDraft] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const scrollRef = React.useRef(null);

  // Keep chat scrolled to the bottom on new messages.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history.length]);

  const send = React.useCallback(async () => {
    const msg = draft.trim();
    if (!msg || sending) return;
    setSending(true);
    // Optimistic: show the user's message immediately so the chat feels
    // responsive while we wait for Claude's reply.
    const optimistic = [...history, { role: 'user', content: msg, ts: new Date().toISOString() }];
    setHistory(optimistic);
    setDraft('');
    try {
      const res = await api.post(`/runs/${runId}/results/${resultId}/chat`, { message: msg });
      setHistory(res.history || optimistic);
    } catch (err) {
      const m = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(m, { title: 'Chat failed' });
      // Roll back the optimistic message so the user can retry.
      setHistory(history);
      setDraft(msg);
    } finally {
      setSending(false);
    }
  }, [draft, sending, history, runId, resultId, toast]);

  return (
    <section className="rounded-card border border-accent-200 bg-white shadow-card overflow-hidden">
      <div className="px-4 py-3 border-b border-accent-100 bg-accent-50/40 flex items-center gap-2">
        <BrainCircuit className="w-4 h-4 text-accent-700" aria-hidden="true" />
        <h3 className="text-md font-semibold text-ink-900">Ask AI about this failure</h3>
        <span className="ml-auto text-2xs text-ink-500 tabular-nums">
          {history.length === 0 ? 'No messages yet' : `${history.length} message${history.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {history.length > 0 && (
        <div
          ref={scrollRef}
          className="max-h-[320px] overflow-y-auto p-4 space-y-3 bg-ink-50/40"
        >
          {history.map((m, i) => (
            <ChatBubble key={i} role={m.role} content={m.content} ts={m.ts} />
          ))}
        </div>
      )}

      <div className="p-3 border-t border-ink-100 bg-white">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, 4000))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={history.length === 0
            ? 'Ask anything about this failure — "Could this be a race condition?", "Why did the locator fail?"…'
            : 'Continue the conversation…'}
          rows={2}
          disabled={sending}
          className="w-full text-sm p-2.5 border border-ink-200 rounded-md focus:outline-none focus:border-ink-900 focus:shadow-ring transition-all resize-y disabled:bg-ink-50 disabled:cursor-not-allowed"
          aria-label="Message to AI"
        />
        <div className="flex items-center justify-between gap-2 mt-2">
          <span className="text-2xs text-ink-400">
            <kbd className="font-mono border border-ink-200 rounded px-1 text-2xs">⌘↵</kbd> to send · {4000 - draft.length} characters left
          </span>
          <Button size="sm" onClick={send} disabled={!draft.trim() || sending} loading={sending}>
            <BrainCircuit className="w-3.5 h-3.5" />
            Send
          </Button>
        </div>
      </div>
    </section>
  );
}

function ChatBubble({ role, content, ts }) {
  const isUser = role === 'user';
  return (
    <div className={`flex gap-2.5 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-2xs font-bold uppercase ${
        isUser ? 'bg-ink-900 text-white' : 'bg-accent-100 text-accent-700'
      }`} aria-hidden="true">
        {isUser ? 'You' : 'AI'}
      </div>
      <div className={`max-w-[80%] rounded-card px-3 py-2 text-sm whitespace-pre-wrap break-words leading-relaxed ${
        isUser ? 'bg-ink-900 text-white' : 'bg-white border border-ink-200 text-ink-800'
      }`}>
        {content}
        {ts && (
          <div className={`text-2xs mt-1 ${isUser ? 'text-white/60' : 'text-ink-400'}`}>
            {new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── CaseGuidanceEditor ─────────────────────────────────────────────
// Free-form notes the user wants Conductor / Critic / Supervisor to honour
// on every FUTURE run of this specific test case. Stored on
// `TestCase.userGuidance`. Saved via PUT /api/projects/:p/test-cases/:tc.
function CaseGuidanceEditor({ projectId, testCaseId, testCaseName, initialValue }) {
  const toast = useToast();
  const [value, setValue] = React.useState(initialValue || '');
  const [serverValue, setServerValue] = React.useState(initialValue || '');
  const [saving, setSaving] = React.useState(false);

  // Sync if the parent reloads with new initial data (e.g. user picks a
  // different test result whose TC has different stored guidance).
  React.useEffect(() => {
    setValue(initialValue || '');
    setServerValue(initialValue || '');
  }, [initialValue, testCaseId]);

  const dirty = value !== serverValue;
  const remaining = 4000 - value.length;

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await api.put(`/projects/${projectId}/test-cases/${testCaseId}`, { userGuidance: value });
      const v = res.testCase?.userGuidance || '';
      setServerValue(v);
      setValue(v);
      toast.success('Saved. The AI will honour this on the next run of this case.', { title: 'Guidance saved' });
    } catch (err) {
      const m = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(m, { title: 'Could not save' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-card border border-info-200 bg-white shadow-card overflow-hidden">
      <div className="px-4 py-3 border-b border-info-100 bg-info-50/40 flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-info-700" aria-hidden="true" />
        <h3 className="text-md font-semibold text-ink-900">
          Your guidance for this test case
        </h3>
        <span className="ml-auto text-2xs text-ink-500 truncate max-w-[40%]" title={testCaseName}>
          {testCaseName}
        </span>
      </div>
      <div className="p-4 space-y-2">
        <p className="text-xs text-ink-600 leading-relaxed">
          Free-form notes the Conductor, Critic, and Supervisor will honour the next time this case runs.
          Example: <span className="font-mono text-ink-700">"Always wait for the loading spinner to disappear before clicking the submit button."</span>
        </p>
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value.slice(0, 4000))}
          placeholder="Suggestions, hints, gotchas — anything the AI should know for next time…"
          rows={3}
          disabled={saving}
          className="w-full text-sm p-2.5 border border-ink-200 rounded-md focus:outline-none focus:border-ink-900 focus:shadow-ring transition-all resize-y disabled:bg-ink-50 disabled:cursor-not-allowed"
          aria-label="User guidance for this test case"
        />
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="text-2xs text-ink-500">
            {remaining < 500
              ? <span className={remaining < 0 ? 'text-danger-700' : 'text-warn-700'}>
                  {remaining < 0 ? `${-remaining} over limit` : `${remaining} characters left`}
                </span>
              : <span>Saved per test case. Up to 4,000 characters.</span>}
          </span>
          <Button size="sm" onClick={handleSave} disabled={!dirty || saving} loading={saving}>
            <Save className="w-3.5 h-3.5" />
            {dirty ? 'Save guidance' : 'No changes'}
          </Button>
        </div>
      </div>
    </section>
  );
}
