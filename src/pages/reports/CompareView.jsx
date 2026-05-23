import React, { useEffect, useState, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  GitCompare, ArrowLeft, CheckCircle2, XCircle, ShieldAlert,
  TrendingUp, TrendingDown, AlertCircle, FolderTree,
} from 'lucide-react';
import api, { ApiError } from '../../lib/apiClient';
import PageHeader from '../../components/PageHeader';
import EmptyState from '../../components/EmptyState';
import Skeleton from '../../components/ui/Skeleton';

/**
 * Side-by-side comparison of two runs. Reads ?a= and ?b= from the URL,
 * fetches GET /api/runs/compare?a=&b=, and renders:
 *   - a top KPI strip with deltas (pass/fail/blocked)
 *   - four collapsible sections: new failures, fixed failures, still
 *     failing, unchanged (collapsed by default for noise reduction)
 *
 * Designed as the "investigation-first" view — the new-failures section
 * is what you actually need to act on after a release, surfaced first.
 */
export default function CompareView() {
  const [searchParams] = useSearchParams();
  const a = searchParams.get('a');
  const b = searchParams.get('b');

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!a || !b) {
      setError('Missing run ids. Compare requires both ?a= and ?b= in the URL.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api.get(`/runs/compare?a=${a}&b=${b}`)
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.toUserMessage() : err.message);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [a, b]);

  if (loading) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <PageHeader title="Compare runs" subtitle="Loading comparison…">
          <Link to="/reports" className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-700 hover:text-ink-900">
            <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
            Back to Reports
          </Link>
        </PageHeader>
        <main className="flex-1 overflow-y-auto bg-ink-50">
          <div className="max-w-6xl mx-auto px-page py-8 space-y-5" aria-busy="true">
            <Skeleton className="h-24 w-full" rounded="card" />
            <Skeleton className="h-40 w-full" rounded="card" />
            <Skeleton className="h-40 w-full" rounded="card" />
          </div>
        </main>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Compare runs">
          <Link to="/reports" className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-700 hover:text-ink-900">
            <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
            Back to Reports
          </Link>
        </PageHeader>
        <EmptyState icon={AlertCircle} title="Cannot compare" message={error} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader
        title="Compare runs"
        subtitle={`${data.a.sprintName} ← → ${data.b.sprintName}`}
      >
        <Link
          to={`/reports?runId=${data.b.id}`}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-700 hover:text-ink-900"
        >
          <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
          Back to Reports
        </Link>
      </PageHeader>
      <main className="flex-1 overflow-y-auto bg-ink-50">
        <div className="max-w-6xl mx-auto px-page py-8 space-y-6">
          <KpiStrip a={data.a} b={data.b} totals={data.totals} />
          <DiffSection
            title="New failures"
            subtitle="Tests that passed in A but failed in B — regressions."
            entries={data.diff.newFailures}
            tone="danger"
            icon={TrendingDown}
            defaultOpen
          />
          <DiffSection
            title="Fixed failures"
            subtitle="Tests that failed in A but passed in B — wins."
            entries={data.diff.fixedFailures}
            tone="success"
            icon={TrendingUp}
            defaultOpen
          />
          <DiffSection
            title="Still failing"
            subtitle="Tests that failed in both runs — chronic, not regressions."
            entries={data.diff.stillFailing}
            tone="warn"
            icon={XCircle}
          />
          <DiffSection
            title="Unchanged"
            subtitle="Tests with the same status in both runs."
            entries={data.diff.unchanged}
            tone="ink"
            icon={CheckCircle2}
          />
          {(data.diff.onlyInA.length > 0 || data.diff.onlyInB.length > 0) && (
            <DiffSection
              title="Only in one run"
              subtitle="Tests that ran in one side but not the other (added or removed between runs)."
              entries={[...data.diff.onlyInA, ...data.diff.onlyInB]}
              tone="ink"
              icon={AlertCircle}
            />
          )}
        </div>
      </main>
    </div>
  );
}

function KpiStrip({ a, b, totals }) {
  const ratesA = ratesFor(a);
  const ratesB = ratesFor(b);
  return (
    <section className="grid md:grid-cols-2 gap-4">
      <RunHeroCard label="A" run={a} rates={ratesA} />
      <RunHeroCard label="B" run={b} rates={ratesB} />
      <div className="md:col-span-2 rounded-card border border-ink-200 bg-white shadow-card p-5">
        <div className="text-2xs font-bold uppercase tracking-[0.18em] text-ink-500 mb-3 inline-flex items-center gap-1.5">
          <GitCompare className="w-3.5 h-3.5" aria-hidden="true" />
          Delta summary
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <KpiTile label="New failures"   value={totals.newFailures}   tone={totals.newFailures > 0 ? 'danger' : 'success'} />
          <KpiTile label="Fixed failures" value={totals.fixedFailures} tone={totals.fixedFailures > 0 ? 'success' : 'ink'} />
          <KpiTile label="Still failing"  value={totals.stillFailing}  tone={totals.stillFailing > 0 ? 'warn' : 'ink'} />
          <KpiTile label="Unchanged"      value={totals.unchanged}     tone="ink" />
          <KpiTile label="Only in A"      value={totals.onlyInA}       tone="ink" />
          <KpiTile label="Only in B"      value={totals.onlyInB}       tone="ink" />
        </div>
      </div>
    </section>
  );
}

function ratesFor(run) {
  // Total counts every result (visibility), but the pass-rate denominator
  // excludes pure `skipped` — those are engineer-chosen exclusions, not
  // failures. `blocked` counts as the agent tried but couldn't reach the
  // assertion (environmental).
  const total = (run.passed || 0) + (run.failed || 0) + (run.blocked || 0) + (run.skipped || 0);
  const denom = (run.passed || 0) + (run.failed || 0) + (run.blocked || 0);
  return {
    total,
    passRate: denom ? Math.round((run.passed / denom) * 100) : 0,
  };
}

function RunHeroCard({ label, run, rates }) {
  return (
    <div className="rounded-card border border-ink-200 bg-white shadow-card p-5">
      <div className="flex items-center justify-between mb-2">
        <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-ink-900 text-white text-xs font-bold">{label}</span>
        <span className="text-2xs text-ink-500 tabular-nums">
          {new Date(run.startedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
        </span>
      </div>
      <h3 className="text-md font-semibold text-ink-900 tracking-tight truncate">{run.sprintName}</h3>
      <div className="mt-3 flex items-center gap-4 text-xs">
        <span className="inline-flex items-center gap-1 text-success-700 font-semibold tabular-nums">
          <CheckCircle2 className="w-3 h-3" aria-hidden="true" />{run.passed}
        </span>
        <span className="inline-flex items-center gap-1 text-danger-700 font-semibold tabular-nums">
          <XCircle className="w-3 h-3" aria-hidden="true" />{run.failed}
        </span>
        <span
          className="inline-flex items-center gap-1 text-warn-700 font-semibold tabular-nums"
          title="Blocked — environmental"
        >
          <ShieldAlert className="w-3 h-3" aria-hidden="true" />{run.blocked ?? 0}
        </span>
        {(run.skipped ?? 0) > 0 && (
          <span
            className="inline-flex items-center gap-1 text-ink-500 font-semibold tabular-nums"
            title="Skipped — engineer-chosen"
          >
            ⏭ {run.skipped}
          </span>
        )}
        <span className="ml-auto text-ink-700 font-bold tabular-nums">{rates.passRate}%</span>
      </div>
    </div>
  );
}

function KpiTile({ label, value, tone }) {
  const tones = {
    danger:  'bg-danger-50 text-danger-700 border-danger-200',
    warn:    'bg-warn-50 text-warn-700 border-warn-200',
    success: 'bg-success-50 text-success-700 border-success-200',
    ink:     'bg-ink-50 text-ink-700 border-ink-200',
  };
  return (
    <div className={`rounded-md border px-3 py-2 ${tones[tone] || tones.ink}`}>
      <div className="text-2xl font-extrabold tabular-nums leading-none">{value}</div>
      <div className="text-2xs uppercase tracking-wider font-bold mt-1 opacity-80">{label}</div>
    </div>
  );
}

function DiffSection({ title, subtitle, entries, tone, icon: Icon, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const tones = {
    danger:  { border: 'border-danger-200', headBg: 'bg-danger-50/60', text: 'text-danger-700' },
    warn:    { border: 'border-warn-200',   headBg: 'bg-warn-50/60',   text: 'text-warn-700' },
    success: { border: 'border-success-200',headBg: 'bg-success-50/60',text: 'text-success-700' },
    ink:     { border: 'border-ink-200',    headBg: 'bg-ink-50/60',    text: 'text-ink-700' },
  };
  const t = tones[tone] || tones.ink;

  if (entries.length === 0) {
    return (
      <section className={`rounded-card border ${t.border} bg-white shadow-card p-4`}>
        <div className="flex items-center gap-2">
          <Icon className={`w-4 h-4 ${t.text}`} aria-hidden="true" />
          <h2 className="text-sm font-semibold text-ink-900">{title}</h2>
          <span className="text-2xs text-ink-500 ml-2">— none</span>
        </div>
      </section>
    );
  }

  return (
    <section className={`rounded-card border ${t.border} bg-white shadow-card overflow-hidden`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`w-full px-5 py-3 border-b ${t.border} ${t.headBg} flex items-center gap-2 hover:bg-opacity-80 focus-visible:outline-none focus-visible:bg-info-50`}
      >
        <Icon className={`w-4 h-4 ${t.text}`} aria-hidden="true" />
        <h2 className={`text-sm font-semibold ${t.text}`}>{title}</h2>
        <span className="text-2xs text-ink-500 tabular-nums">{entries.length}</span>
        {subtitle && <span className="text-2xs text-ink-500 ml-1 hidden sm:inline">— {subtitle}</span>}
        <span className="ml-auto text-ink-400">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <ul role="list" className="list-none m-0 p-0 divide-y divide-ink-100">
          {entries.map((e) => (
            <li key={e.testCaseId} className="px-5 py-3 grid grid-cols-[1fr_auto_auto] items-center gap-3 hover:bg-ink-50/40">
              <div className="min-w-0">
                <div className="text-sm font-medium text-ink-900 truncate">
                  {e.testCase?.name || e.testCaseId}
                </div>
                <div className="flex items-center gap-2 text-2xs text-ink-500 mt-0.5">
                  {e.testCase?.module && <span className="font-mono">{e.testCase.module}</span>}
                  {e.scenario?.name && (
                    <span className="inline-flex items-center gap-1">
                      <FolderTree className="w-3 h-3" aria-hidden="true" />
                      {e.scenario.name}
                    </span>
                  )}
                </div>
              </div>
              <StatusPair side="A" status={e.a?.status} durationMs={e.a?.durationMs} />
              <StatusPair side="B" status={e.b?.status} durationMs={e.b?.durationMs} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StatusPair({ side, status, durationMs }) {
  const tone = status === 'pass'
    ? 'bg-success-50 text-success-700 border-success-200'
    : status === 'fail'
    ? 'bg-danger-50 text-danger-700 border-danger-200'
    : status === 'blocked'
    ? 'bg-warn-50 text-warn-700 border-warn-200'
    : 'bg-ink-100 text-ink-600 border-ink-200';
  return (
    <div className="text-2xs tabular-nums flex flex-col items-end">
      <span className="text-ink-400 font-bold uppercase tracking-wider">{side}</span>
      <span className={`mt-0.5 px-2 py-0.5 rounded-pill border font-bold uppercase tracking-wider ${tone}`}>
        {status || '—'}
      </span>
      {durationMs != null && <span className="text-ink-400 mt-0.5">{durationMs}ms</span>}
    </div>
  );
}
