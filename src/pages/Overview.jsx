import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Play,
  RefreshCw,
  ShieldCheck,
  AlertCircle,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  Clock,
  Target,
  TrendingUp,
  TrendingDown,
  ArrowUpRight,
  FolderTree,
} from 'lucide-react';
import api from '../lib/apiClient';
import { useProject } from '../store/project';
import { useToast } from '../lib/useToast';
import { useRunStream } from '../store/runStream';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import Button from '../components/ui/Button';
import Skeleton from '../components/ui/Skeleton';
import StackedBar from '../components/charts/StackedBar';
import Sparkline from '../components/charts/Sparkline';

export default function Overview() {
  const navigate = useNavigate();
  const { current } = useProject();
  const toast = useToast();
  const { latestSummary } = useRunStream();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!current) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await api.get(`/dashboard/${current.id}`);
      setData(res);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [current, toast]);

  // Run once on project change (via `load`'s deps). A separate effect
  // reloads when a run completes; including both `load` and `latestSummary`
  // in one dep list double-fires on initial mount because both change.
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    // Skip the initial null → null tick that fires on mount before any run
    // has completed in this session.
    if (latestSummary) load();
    // load is stable when current is stable; safe to exclude.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestSummary]);

  if (!current) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Overview" subtitle="Sprint health at a glance" />
        <EmptyState
          illustration="overview"
          title="No project yet"
          message="Create or activate a project to see real metrics here. No fake data will be shown."
          action={
            <Button size="md" onClick={() => navigate('/project-setup')}>
              Create project
            </Button>
          }
        />
      </div>
    );
  }

  const stats = data?.stats;
  const recommendation = stats?.recommendation;
  // LOW_COVERAGE renders in warn tones — it isn't a NO-GO call (we don't
  // have evidence to refuse), it's a "not enough has been measured yet"
  // signal that asks the user to expand coverage before a call can be made.
  const recommendationColors =
    recommendation === 'GO'
      ? 'from-success-50 to-white border-success-100'
      : recommendation === 'NO_GO'
      ? 'from-danger-50 to-white border-danger-100'
      : recommendation === 'LOW_COVERAGE'
      ? 'from-warn-50 to-white border-warn-200'
      : 'from-ink-50 to-white border-ink-200';
  const recommendationTextColor =
    recommendation === 'GO'
      ? 'text-success-700'
      : recommendation === 'NO_GO'
      ? 'text-danger-700'
      : recommendation === 'LOW_COVERAGE'
      ? 'text-warn-700'
      : 'text-ink-700';
  const recommendationLabel =
    recommendation === 'GO' ? 'GO'
    : recommendation === 'NO_GO' ? 'NO GO'
    : recommendation === 'LOW_COVERAGE' ? 'HOLD'
    : '—';

  // Build sparkline data from recent runs (pass rate trend). Server sends
  // newest-first, but sort defensively so the sparkline never silently
  // inverts if the server's ordering changes. Pass-rate denominator
  // excludes pure `skipped` — engineer chose to skip those.
  //
  // Drop runs with denom = 0 (cancelled before any test executed, or all
  // results were skipped) — they have no pass-rate to report, and including
  // them as 0% data points falsely inflated the "100pp vs N runs ago" delta
  // when the only real measurement was a single passing run.
  const trendValues = (data?.recentRuns || [])
    .slice()
    .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt))
    .map((r) => {
      const denom = (r.passed || 0) + (r.failed || 0) + (r.blocked || 0);
      return denom > 0 ? Math.round(((r.passed || 0) / denom) * 100) : null;
    })
    .filter((v) => v !== null);
  // N data points = N-1 gaps. Saying "vs 5 runs ago" when there are only
  // 5 points (so 4 gaps) overstated history by one. Compute the gap count
  // and only render the badge when there's at least one prior run to
  // compare against.
  const trendGaps = trendValues.length - 1;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader title="Overview" subtitle={current.name}>
        <Button size="sm" variant="ghost" onClick={load}>
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </Button>
        <Button size="md" onClick={() => navigate('/run-suite')}>
          <Play className="w-3.5 h-3.5 fill-current" />
          Start new run
        </Button>
      </PageHeader>

      <main className="flex-1 overflow-y-auto bg-ink-50">
        <div className="max-w-6xl mx-auto px-page py-8 space-y-6">
          {loading ? (
            <OverviewSkeleton />
          ) : (
            <>
              {/* Hero row: recommendation + sparkline */}
              <section className="grid lg:grid-cols-[1.4fr_1fr] gap-5">
                <div className={`relative overflow-hidden rounded-card border bg-gradient-to-br p-6 ${recommendationColors}`}>
                  <div className="text-2xs uppercase tracking-[0.18em] font-bold text-ink-500 mb-2">
                    AI Release Recommendation
                  </div>
                  <div className={`text-4xl font-extrabold tracking-tight ${recommendationTextColor}`}>
                    {recommendationLabel}
                  </div>
                  <p className="text-sm text-ink-600 mt-2 max-w-md">
                    {stats?.recommendationReason ||
                      (recommendation === 'NO_DATA'
                        ? 'No test cases generated yet. Pull requirements and ask Claude to plan a test suite to see a recommendation.'
                        : `${stats?.stabilityPercent ?? 0}% pass rate across ${stats?.testCases ?? 0} test cases.`)}
                  </p>
                </div>
                <div className="rounded-card border border-ink-200 bg-white shadow-card p-6">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-2xs uppercase tracking-[0.18em] font-bold text-ink-500">
                      Pass-rate trend
                    </div>
                    {/* Trend delta — only render once we have at least 2
                        measured runs (1 gap) so there's an actual prior
                        value to compare against. The label uses gap count
                        ("over the last N runs") rather than the off-by-one
                        "vs N runs ago" copy that overstated history. */}
                    {trendGaps >= 1 && trendValues[trendValues.length - 1] !== trendValues[0] && (
                      <div className={`flex items-center gap-1 text-xs font-semibold ${
                        trendValues[trendValues.length - 1] >= trendValues[0]
                          ? 'text-success-600'
                          : 'text-danger-600'
                      }`}>
                        {trendValues[trendValues.length - 1] >= trendValues[0]
                          ? <TrendingUp className="w-3.5 h-3.5" />
                          : <TrendingDown className="w-3.5 h-3.5" />}
                        {Math.abs(trendValues[trendValues.length - 1] - trendValues[0])}pp {trendGaps === 1 ? 'vs previous run' : `over the last ${trendValues.length} runs`}
                      </div>
                    )}
                  </div>
                  <div className="flex items-end justify-between mt-3">
                    <div>
                      <div className="text-3xl font-extrabold text-ink-900 tabular-nums">
                        {trendValues.length ? `${trendValues[trendValues.length - 1]}%` : '—'}
                      </div>
                      <div className="text-xs text-ink-500 mt-0.5">
                        latest run · {stats?.stabilityPercent != null ? `${stats.stabilityPercent}% overall` : 'no overall data'}
                      </div>
                    </div>
                    <Sparkline values={trendValues} width={160} height={44} />
                  </div>
                </div>
              </section>

              {/* Stat strip — counts distinct test cases, not raw result
                  rows, so the numbers reconcile with the recommendation
                  card's denominator. Every tile is a button that deep-links
                  to a real filtered list elsewhere in the app. Tiles for
                  metrics with no useful destination (e.g. zero pending PRs)
                  stay clickable so the user can verify there's nothing
                  there — the destination renders an empty list, not an
                  error. */}
              <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
                <Stat
                  icon={CheckCircle2}
                  label="Passed"
                  value={stats?.passed ?? 0}
                  tone="success"
                  sublabel={stats?.testCases ? `of ${stats.testCases} cases` : ''}
                  onClick={stats?.latestRunId
                    ? () => navigate(`/reports?runId=${stats.latestRunId}&status=pass`)
                    : undefined}
                  hoverTitle="Show passed cases from the latest run"
                />
                <Stat
                  icon={XCircle}
                  label="Failed"
                  value={stats?.failed ?? 0}
                  tone="danger"
                  onClick={stats?.latestRunId
                    ? () => navigate(`/reports?runId=${stats.latestRunId}&status=fail`)
                    : undefined}
                  hoverTitle="Show failed cases from the latest run"
                />
                <Stat
                  icon={ShieldAlert}
                  label="Blocked"
                  value={stats?.blocked ?? 0}
                  tone="warn"
                  sublabel="distinct test cases"
                  onClick={() => navigate('/blocked-items')}
                  hoverTitle="Open the Blocked Items page"
                />
                <Stat
                  icon={Target}
                  label="Coverage"
                  value={stats?.coveragePercent != null ? `${stats.coveragePercent}%` : '—'}
                  tone="info"
                  sublabel={stats?.executed != null && stats?.testCases
                    ? `${stats.executed} of ${stats.testCases} executed`
                    : 'awaiting first run'}
                  onClick={stats?.latestRunId
                    ? () => navigate(`/reports?runId=${stats.latestRunId}`)
                    : undefined}
                  hoverTitle="Open the latest run report"
                />
                <Stat
                  icon={Clock}
                  label="PRs pending"
                  value={stats?.pendingPRs ?? 0}
                  tone="accent"
                  onClick={() => navigate('/governance')}
                  hoverTitle="Open the Governance page"
                />
              </section>

              {/* Module health.
                  Split modules into MEASURED (at least one case has a pass /
                  fail / blocked result) and NOT-YET-MEASURED (everything still
                  pending or skipped). The measured ones render in the
                  StackedBar; the not-yet-measured ones render as a list with
                  a "Run module" CTA that deep-links to the Test Cases page
                  pre-filtered to that module. */}
              {data?.modules?.length > 0 && (() => {
                const measured = data.modules.filter((m) => (m.pass + m.fail + m.blocked) > 0);
                const unmeasured = data.modules.filter((m) => (m.pass + m.fail + m.blocked) === 0);
                return (
                  <section className="rounded-card border border-ink-200 bg-white shadow-card p-6">
                    <div className="flex items-center justify-between mb-5">
                      <div>
                        <h2 className="text-lg font-semibold text-ink-900 tracking-tight">Module health</h2>
                        <p className="text-sm text-ink-500 mt-0.5">
                          Distribution of test outcomes across modules
                        </p>
                      </div>
                      {measured.length > 0 && <Legend />}
                    </div>

                    {measured.length > 0 && (
                      <StackedBar
                        data={measured.map((m) => ({
                          label: m.module,
                          pass: m.pass,
                          fail: m.fail,
                          blocked: m.blocked,
                          pending: m.pending,
                        }))}
                      />
                    )}

                    {unmeasured.length > 0 && (
                      <div className={measured.length > 0 ? 'mt-5 pt-5 border-t border-ink-100' : ''}>
                        <div className="text-2xs font-bold uppercase tracking-[0.14em] text-ink-500 mb-2.5">
                          Not yet measured
                        </div>
                        <ul className="divide-y divide-ink-100">
                          {unmeasured.map((m) => (
                            <li key={m.module} className="flex items-center gap-3 py-2.5">
                              <FolderTree className="w-3.5 h-3.5 text-ink-400 shrink-0" aria-hidden="true" />
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-semibold text-ink-800 truncate">{m.module}</div>
                                <div className="text-2xs text-ink-500 tabular-nums">
                                  {m.total} case{m.total === 1 ? '' : 's'} · awaiting first run
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => navigate(`/test-cases?module=${encodeURIComponent(m.module)}`)}
                                className="inline-flex items-center gap-1 px-2.5 h-8 rounded-md border border-ink-200 bg-white text-xs font-semibold text-ink-700 hover:border-ink-400 hover:bg-ink-50 focus-visible:outline-none focus-visible:shadow-ring transition-colors"
                                title={`Open ${m.module} test cases`}
                              >
                                <Play className="w-3 h-3 fill-current" />
                                Run module
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </section>
                );
              })()}

              {/* Recent runs */}
              {data?.recentRuns?.length > 0 && (
                <section>
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-lg font-semibold text-ink-900 tracking-tight">Recent runs</h2>
                    <button
                      onClick={() => navigate('/execution-log')}
                      className="text-xs font-semibold text-ink-600 hover:text-ink-900 inline-flex items-center gap-0.5"
                    >
                      All runs
                      <ArrowUpRight className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="grid sm:grid-cols-2 gap-4">
                    {data.recentRuns.slice(0, 4).map((r) => {
                      // Pass-rate denominator: executed cases. Pure `skipped`
                      // (test.skip) excluded — engineer chose those. `blocked`
                      // counts because the agent tried and couldn't reach
                      // the assertion (environmental).
                      const denom = (r.passed || 0) + (r.failed || 0) + (r.blocked || 0);
                      const rate = denom ? Math.round((r.passed / denom) * 100) : 0;
                      const scenarios = Array.isArray(r.scenarios) ? r.scenarios : [];
                      const primaryTitle = scenarios.length
                        ? scenarios.slice(0, 2).map((s) => s.name).join(' · ') + (scenarios.length > 2 ? ` +${scenarios.length - 2}` : '')
                        : r.sprintName;
                      return (
                        <button
                          key={r.id}
                          onClick={() => navigate(`/reports?runId=${r.id}`)}
                          className="text-left rounded-card border border-ink-200 bg-white shadow-card hover:shadow-card-hover hover:border-ink-300 transition-all duration-200 ease-out-soft p-5"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-semibold text-ink-900 truncate" title={primaryTitle}>
                                {primaryTitle}
                              </div>
                              <div className="text-2xs text-ink-500 font-medium mt-0.5 flex items-center gap-1.5 flex-wrap">
                                <span>
                                  {new Date(r.startedAt).toLocaleString('en-US', {
                                    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                                  })}
                                </span>
                                {typeof r.testCount === 'number' && r.testCount > 0 && (
                                  <span className="tabular-nums">· {r.testCount} test{r.testCount === 1 ? '' : 's'}</span>
                                )}
                                {scenarios.length > 0 && (
                                  <span className="inline-flex items-center gap-0.5">
                                    · <FolderTree className="w-3 h-3" />{scenarios.length}
                                  </span>
                                )}
                              </div>
                            </div>
                            <RunStatusPill status={r.status} />
                          </div>
                          <div className="flex items-end justify-between mt-4">
                            <div className="flex gap-3 text-xs">
                              <span className="inline-flex items-center gap-1 text-success-700 font-semibold tabular-nums">
                                <CheckCircle2 className="w-3 h-3" />{r.passed}
                              </span>
                              <span className="inline-flex items-center gap-1 text-danger-700 font-semibold tabular-nums">
                                <XCircle className="w-3 h-3" />{r.failed}
                              </span>
                              <span
                                className="inline-flex items-center gap-1 text-warn-700 font-semibold tabular-nums"
                                title="Blocked — could not complete assertion (environmental)"
                              >
                                <ShieldAlert className="w-3 h-3" />{r.blocked ?? 0}
                              </span>
                              {(r.skipped ?? 0) > 0 && (
                                <span
                                  className="inline-flex items-center gap-1 text-ink-500 font-semibold tabular-nums"
                                  title="Skipped — test.skip() / --grep deselection"
                                >
                                  ⏭ {r.skipped}
                                </span>
                              )}
                            </div>
                            <div className="text-2xl font-extrabold text-ink-900 tabular-nums leading-none">
                              {rate}<span className="text-sm text-ink-400 font-medium">%</span>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* True empty state */}
              {stats?.testCases === 0 && (
                <EmptyState
                  icon={ShieldCheck}
                  title="Nothing to report yet"
                  message="Pull requirements, generate test cases, and run them to see real metrics here. No data is shown until it exists."
                  action={
                    <Button size="md" onClick={() => navigate('/run-suite')}>
                      Get started
                    </Button>
                  }
                />
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

// Loading skeleton tuned to match the real layout's heights pixel-for-pixel
// so the page doesn't jump when data arrives. aria-hidden on the wrapper
// keeps the duplicate "Loading" announcements down — the inner <Skeleton/>
// pieces each have a polite live region.
function OverviewSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      {/* Hero row */}
      <section className="grid lg:grid-cols-[1.4fr_1fr] gap-5">
        <div className="rounded-card border border-ink-200 bg-white p-6 space-y-3">
          <Skeleton className="h-3 w-40" rounded="pill" />
          <Skeleton className="h-10 w-28" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
        </div>
        <div className="rounded-card border border-ink-200 bg-white p-6 space-y-3">
          <Skeleton className="h-3 w-32" rounded="pill" />
          <div className="flex items-end justify-between mt-3">
            <Skeleton className="h-10 w-20" />
            <Skeleton className="h-11 w-40" />
          </div>
        </div>
      </section>
      {/* Stat strip — 5 tiles (passed, failed, blocked, coverage, prs) */}
      <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="rounded-card border border-ink-200 bg-white p-5 space-y-3">
            <Skeleton className="h-9 w-9" rounded="lg" />
            <Skeleton className="h-8 w-14" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </section>
      {/* Module health */}
      <section className="rounded-card border border-ink-200 bg-white p-6 space-y-4">
        <Skeleton className="h-5 w-40" />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="grid grid-cols-[110px_1fr_64px] items-center gap-3">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3.5 w-full" rounded="pill" />
            <Skeleton className="h-3 w-10 ml-auto" />
          </div>
        ))}
      </section>
      {/* Recent runs */}
      <section>
        <Skeleton className="h-5 w-32 mb-3" />
        <div className="grid sm:grid-cols-2 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="rounded-card border border-ink-200 bg-white p-5 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-5 w-16" rounded="pill" />
              </div>
              <Skeleton className="h-3 w-1/2" />
              <div className="flex items-end justify-between">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-7 w-14" />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

// Stat tile — renders as a button when `onClick` is provided so the user
// can deep-link from the dashboard into a filtered list. Without onClick
// it stays a plain div (e.g. for metrics with no useful destination).
function Stat({ icon: Icon, label, value, tone, sublabel, onClick, hoverTitle }) {
  const tones = {
    success: 'bg-success-50 text-success-700',
    danger:  'bg-danger-50 text-danger-700',
    warn:    'bg-warn-50 text-warn-700',
    accent:  'bg-accent-50 text-accent-700',
    info:    'bg-info-50 text-info-700',
  };
  const body = (
    <>
      <div className={`inline-flex items-center justify-center w-9 h-9 rounded-lg ${tones[tone]}`}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="mt-3 text-3xl font-extrabold text-ink-900 tabular-nums leading-none">{value}</div>
      <div className="text-sm text-ink-500 mt-1">{label}</div>
      {sublabel && <div className="text-2xs text-ink-400 mt-0.5 tabular-nums">{sublabel}</div>}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={hoverTitle}
        className="text-left rounded-card border border-ink-200 bg-white shadow-card p-5 hover:shadow-card-hover hover:border-ink-300 hover:-translate-y-0.5 transition-all duration-200 ease-out-soft focus-visible:outline-none focus-visible:shadow-ring"
      >
        {body}
      </button>
    );
  }
  return (
    <div className="rounded-card border border-ink-200 bg-white shadow-card p-5">
      {body}
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
    <span className={`text-2xs uppercase tracking-wider font-bold px-2 py-0.5 rounded-pill border ${map[status] || map.running}`}>
      {status}
    </span>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-3 text-xs text-ink-500">
      <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-success-500" /> Pass</span>
      <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-danger-500" /> Fail</span>
      <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-warn-500" /> Blocked</span>
      <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-ink-400" /> Pending</span>
    </div>
  );
}
