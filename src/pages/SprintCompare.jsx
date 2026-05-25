import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  TrendingDown,
  TrendingUp,
  CheckCircle2,
  XCircle,
  ShieldAlert,
  ArrowRightLeft,
} from 'lucide-react';
import api, { ApiError } from '../lib/apiClient';
import { useProject } from '../store/project';
import { useToast } from '../lib/useToast';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import Button from '../components/ui/Button';
import Select from '../components/ui/Select';
import Skeleton from '../components/ui/Skeleton';

/**
 * Sprint comparison view (Phase B+). Diffs two sprints by per-case outcome:
 *   - newFailures  = passed in A, failing/blocked in B (regressions)
 *   - newPasses    = failing/blocked in A, passing in B (recoveries)
 *   - stillFailing = bad in both
 *   - stillPassing = passing in both
 *   - onlyInA / onlyInB = cases that only ran in one of the two
 *
 * URL is the source of truth: ?a=<sprintId>&b=<sprintId>. A pair of
 * dropdowns at the top lets the user retarget without leaving the page.
 */
export default function SprintCompare() {
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const { current, sprints } = useProject();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const aId = params.get('a') || '';
  const bId = params.get('b') || '';

  // Sane defaults if the URL lacks a/b: pick the two most recent sprints.
  useEffect(() => {
    if (!current || !sprints.length) return;
    if (aId && bId) return;
    if (sprints.length < 2) return;
    const b = sprints[0]?.id;
    const a = sprints[1]?.id;
    if (a && b && a !== b) {
      setParams({ a, b }, { replace: true });
    }
  }, [current, sprints, aId, bId, setParams]);

  useEffect(() => {
    let cancelled = false;
    if (!current || !aId || !bId) {
      setLoading(false);
      return;
    }
    if (aId === bId) {
      setLoading(false);
      setError('Pick two different sprints.');
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await api.get(`/projects/${current.id}/sprints/compare?a=${aId}&b=${bId}`);
        if (!cancelled) setData(res);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
        setError(msg);
        toast.error(msg, { title: 'Compare failed' });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [current, aId, bId, toast]);

  const sprintOptions = useMemo(
    () => sprints.map((s) => ({ value: s.id, label: `${s.name} · ${s.lifecycle.replace('_', ' ')}` })),
    [sprints],
  );

  if (!current) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Sprint compare" subtitle="No project active" />
        <EmptyState title="No project" message="Activate a project to compare sprints." />
      </div>
    );
  }

  if (sprints.length < 2) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Sprint compare" subtitle={current.name}>
          <Button size="sm" variant="ghost" onClick={() => navigate('/project-setup')}>
            <ArrowLeft className="w-3.5 h-3.5" />
            Project setup
          </Button>
        </PageHeader>
        <EmptyState
          title="Need at least two sprints"
          message="Create a second sprint in Project Setup before comparing."
          action={
            <Button size="md" onClick={() => navigate('/project-setup')}>
              Open project setup
            </Button>
          }
        />
      </div>
    );
  }

  const summary = data?.summary;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader title="Sprint compare" subtitle={current.name}>
        <Button size="sm" variant="ghost" onClick={() => navigate('/overview')}>
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to overview
        </Button>
      </PageHeader>

      <main className="flex-1 overflow-y-auto bg-ink-50">
        <div className="max-w-6xl mx-auto px-page py-8 space-y-6">
          <section className="rounded-card border border-ink-200 bg-white shadow-card p-5">
            <div className="grid md:grid-cols-[1fr_auto_1fr] items-end gap-3">
              <Select
                label="Baseline (A)"
                value={aId}
                onChange={(e) => setParams({ a: e.target.value, b: bId }, { replace: true })}
                options={sprintOptions}
              />
              <div className="flex items-center justify-center pb-2 text-ink-400">
                <ArrowRightLeft className="w-5 h-5" />
              </div>
              <Select
                label="Candidate (B)"
                value={bId}
                onChange={(e) => setParams({ a: aId, b: e.target.value }, { replace: true })}
                options={sprintOptions}
              />
            </div>
          </section>

          {loading ? (
            <CompareSkeleton />
          ) : error ? (
            <EmptyState title="Couldn't compare" message={error} />
          ) : data ? (
            <>
              <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <SummaryTile
                  icon={TrendingDown}
                  tone="danger"
                  label="New failures"
                  value={summary.newFailures}
                  sublabel={`were passing in ${data.a.name}`}
                />
                <SummaryTile
                  icon={TrendingUp}
                  tone="success"
                  label="New passes"
                  value={summary.newPasses}
                  sublabel={`were failing in ${data.a.name}`}
                />
                <SummaryTile
                  icon={ShieldAlert}
                  tone="warn"
                  label="Still failing"
                  value={summary.stillFailing}
                  sublabel="failing in both"
                />
                <SummaryTile
                  icon={CheckCircle2}
                  tone="info"
                  label="Still passing"
                  value={summary.stillPassing}
                  sublabel="green in both"
                />
              </section>

              <DiffSection
                title="Regressions"
                subtitle={`Cases that passed in ${data.a.name} and now fail or are blocked in ${data.b.name}.`}
                tone="danger"
                cases={data.newFailures}
                emptyMessage="No regressions — nothing that was passing has broken."
              />
              <DiffSection
                title="Recoveries"
                subtitle={`Cases that failed in ${data.a.name} and now pass in ${data.b.name}.`}
                tone="success"
                cases={data.newPasses}
                emptyMessage="No recoveries this sprint."
              />
              <DiffSection
                title="Still failing"
                subtitle="Cases that have been failing or blocked across both sprints."
                tone="warn"
                cases={data.stillFailing}
                emptyMessage="Nothing has been consistently failing — good."
              />
              {(data.onlyInA.length > 0 || data.onlyInB.length > 0) && (
                <section className="grid md:grid-cols-2 gap-4">
                  <DiffSection
                    title={`Only ran in ${data.a.name}`}
                    subtitle="Cases the baseline tested but the candidate didn't."
                    tone="ink"
                    cases={data.onlyInA}
                    emptyMessage="None."
                    compact
                  />
                  <DiffSection
                    title={`Only ran in ${data.b.name}`}
                    subtitle="Cases new to the candidate or skipped in the baseline."
                    tone="ink"
                    cases={data.onlyInB}
                    emptyMessage="None."
                    compact
                  />
                </section>
              )}
            </>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function CompareSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-card border border-ink-200 bg-white p-5 space-y-3">
            <Skeleton className="h-8 w-12" />
            <Skeleton className="h-3 w-24" />
          </div>
        ))}
      </section>
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-card border border-ink-200 bg-white p-5 space-y-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-full" />
        </div>
      ))}
    </div>
  );
}

function SummaryTile({ icon: Icon, tone, label, value, sublabel }) {
  const tones = {
    success: 'bg-success-50 text-success-700',
    danger: 'bg-danger-50 text-danger-700',
    warn: 'bg-warn-50 text-warn-700',
    info: 'bg-info-50 text-info-700',
  };
  return (
    <div className="rounded-card border border-ink-200 bg-white shadow-card p-5">
      <div className="flex items-center justify-between">
        <span className={`inline-flex items-center justify-center w-9 h-9 rounded-lg ${tones[tone] || tones.info}`}>
          <Icon className="w-4 h-4" />
        </span>
      </div>
      <div className="text-3xl font-extrabold text-ink-900 tabular-nums mt-3">{value ?? 0}</div>
      <div className="text-2xs font-bold uppercase tracking-wider text-ink-600 mt-0.5">{label}</div>
      {sublabel && <div className="text-2xs text-ink-500 mt-0.5">{sublabel}</div>}
    </div>
  );
}

function StatusPill({ status }) {
  const tone = {
    pass: 'bg-success-50 text-success-700 border-success-200',
    fail: 'bg-danger-50 text-danger-700 border-danger-200',
    blocked: 'bg-warn-50 text-warn-700 border-warn-200',
    skipped: 'bg-ink-100 text-ink-600 border-ink-200',
  }[status] || 'bg-ink-100 text-ink-600 border-ink-200';
  return (
    <span className={`inline-flex items-center text-2xs font-bold uppercase tracking-wider border rounded-full px-2 py-0.5 ${tone}`}>
      {status || '—'}
    </span>
  );
}

function DiffSection({ title, subtitle, tone, cases, emptyMessage, compact }) {
  const headerTone = {
    danger: 'text-danger-700',
    success: 'text-success-700',
    warn: 'text-warn-700',
    info: 'text-info-700',
    ink: 'text-ink-700',
  }[tone] || 'text-ink-700';
  return (
    <section className="rounded-card border border-ink-200 bg-white shadow-card p-5">
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
        <div>
          <h2 className={`text-lg font-semibold tracking-tight ${headerTone}`}>{title}</h2>
          {subtitle && <p className="text-sm text-ink-500 mt-0.5">{subtitle}</p>}
        </div>
        <div className="text-2xs font-bold uppercase tracking-wider text-ink-500 tabular-nums">
          {cases.length} case{cases.length === 1 ? '' : 's'}
        </div>
      </div>
      {cases.length === 0 ? (
        <div className="text-xs text-ink-500 italic">{emptyMessage}</div>
      ) : (
        <ul className="divide-y divide-ink-100">
          {cases.slice(0, compact ? 20 : 50).map((c) => (
            <li key={c.id} className="py-2.5 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-ink-800 truncate" title={c.name}>{c.name || c.id}</div>
                {c.module && <div className="text-2xs text-ink-500">{c.module}</div>}
                {c.b?.error && (
                  <div className="text-2xs text-danger-700 mt-0.5 line-clamp-2" title={c.b.error}>
                    {c.b.error}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <StatusPill status={c.a?.status} />
                <span className="text-ink-400 text-xs">→</span>
                <StatusPill status={c.b?.status} />
              </div>
            </li>
          ))}
          {cases.length > (compact ? 20 : 50) && (
            <li className="py-2 text-2xs text-ink-500 italic">
              …and {cases.length - (compact ? 20 : 50)} more not shown
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
