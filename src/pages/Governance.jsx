import React, { useEffect, useState, useCallback } from 'react';
import { Check, X, GitMerge, ShieldCheck, FileCode, RefreshCw, AlertTriangle, AlertOctagon } from 'lucide-react';
import api, { ApiError } from '../lib/apiClient';
import { useProject } from '../store/project';
import { useToast } from '../lib/useToast';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import Button from '../components/ui/Button';

const STATUS_META = {
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  approved: 'bg-sky-50 text-sky-700 border-sky-200',
  merged: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rejected: 'bg-ink-100 text-ink-600 border-ink-200',
};

export default function Governance() {
  const { current } = useProject();
  const toast = useToast();
  const [prs, setPrs] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [active, setActive] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');

  const load = useCallback(async () => {
    if (!current) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await api.get(`/projects/${current.id}/governance`);
      setPrs(res.prs || []);
      if (!activeId && res.prs?.length) setActiveId(res.prs[0].id);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [current, toast, activeId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!current || !activeId) {
      setActive(null);
      return;
    }
    (async () => {
      try {
        const res = await api.get(`/projects/${current.id}/governance/${activeId}`);
        setActive(res.pr);
      } catch (err) {
        toast.error(err.message);
      }
    })();
  }, [current, activeId, toast]);

  const act = async (action) => {
    try {
      await api.post(`/projects/${current.id}/governance/${activeId}/${action}`, {});
      await load();
      toast.success(`PR ${action}d.`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: `Cannot ${action}` });
    }
  };

  const reLint = async () => {
    if (!activeId) return;
    try {
      const res = await api.post(`/projects/${current.id}/governance/${activeId}/lint`, {});
      setActive(res.pr);
      if (res.lint.passed) toast.success('Lint clean.', { title: 'No errors' });
      else
        toast.error(
          `${res.lint.errorCount} error · ${res.lint.warningCount} warning`,
          { title: 'Lint findings' }
        );
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (!current) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Governance" />
        <EmptyState
          icon={ShieldCheck}
          title="No project selected"
          message="Activate a project to see generated PRs."
        />
      </div>
    );
  }

  const visible = filter === 'all' ? prs : prs.filter((p) => p.status === filter);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader
        title="Governance"
        subtitle={`${prs.length} generated PRs · ${prs.filter((p) => p.status === 'pending').length} awaiting review`}
      />
      <main className="flex-1 lg:grid lg:grid-cols-[320px_1fr] flex flex-col overflow-hidden bg-ink-50">
        <aside className="border-r border-ink-200 bg-white overflow-y-auto max-h-[40vh] lg:max-h-none">
          <div className="px-3 py-2 flex gap-1 border-b border-ink-100">
            {['all', 'pending', 'approved', 'merged', 'rejected'].map((s) => (
              <button
                key={s}
                onClick={() => setFilter(s)}
                className={`text-2xs px-1.5 py-0.5 rounded font-bold uppercase tracking-wider ${
                  filter === s ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-600'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          {loading ? (
            <div className="text-xs text-ink-500 px-3 py-2">Loading…</div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon={FileCode}
              title="No PRs"
              message="Generated PRs from passed test cases will appear here for review."
            />
          ) : (
            visible.map((pr) => (
              <button
                key={pr.id}
                onClick={() => setActiveId(pr.id)}
                className={`block w-full text-left px-3 py-2 border-b border-ink-100 hover:bg-ink-50 ${
                  activeId === pr.id ? 'bg-ink-50' : ''
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono text-ink-500">{pr.number}</span>
                  <span
                    className={`text-2xs font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border ${STATUS_META[pr.status]}`}
                  >
                    {pr.status}
                  </span>
                </div>
                <div className="text-xs font-semibold text-ink-900 mt-0.5 truncate">
                  {pr.filename}
                </div>
                <div className="text-2xs text-ink-500 truncate">{pr.requirement}</div>
                {!pr.lintPassed && (
                  <div className="text-2xs text-rose-700 mt-0.5 inline-flex items-center gap-1">
                    <AlertOctagon className="w-2.5 h-2.5" />
                    Lint failed
                  </div>
                )}
              </button>
            ))
          )}
        </aside>

        <section className="overflow-y-auto p-5">
          {!active ? (
            <EmptyState icon={FileCode} title="Select a PR" message="Pick a PR from the left to review." />
          ) : (
            <div className="max-w-4xl space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-xs font-mono text-ink-500">{active.number}</div>
                  <h2 className="font-bold text-ink-900">{active.filename}</h2>
                  <p className="text-xs text-ink-500 mt-0.5">{active.requirement}</p>
                </div>
                <span
                  className={`text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${STATUS_META[active.status]}`}
                >
                  {active.status}
                </span>
              </div>

              <LintPanel pr={active} onRelint={reLint} />

              <div className="rounded-lg overflow-hidden border border-ink-200">
                <div className="bg-ink-100 px-3 py-1.5 text-xs font-mono text-ink-600 border-b border-ink-200">
                  {active.filename}
                </div>
                <pre className="bg-ink-900 text-emerald-300 text-xs p-3 overflow-x-auto whitespace-pre font-mono leading-relaxed max-h-[60vh]">
                  {active.specCode || '// No code captured yet.'}
                </pre>
              </div>

              {active.status === 'pending' && (
                <div className="flex justify-end gap-2 pt-2 border-t border-ink-200">
                  <Button size="sm" variant="ghost" onClick={() => act('reject')} className="text-rose-600">
                    <X className="w-3.5 h-3.5" />
                    Reject
                  </Button>
                  <Button size="sm" onClick={() => act('approve')}>
                    <Check className="w-3.5 h-3.5" />
                    Approve
                  </Button>
                </div>
              )}
              {active.status === 'approved' && (
                <div className="flex items-center justify-end gap-3 pt-2 border-t border-ink-200">
                  {!active.lintPassed && (
                    <span className="text-xs text-rose-700 inline-flex items-center gap-1">
                      <AlertOctagon className="w-3 h-3" />
                      Lint must pass to merge
                    </span>
                  )}
                  <Button
                    size="sm"
                    onClick={() => act('merge')}
                    disabled={!active.lintPassed}
                  >
                    <GitMerge className="w-3.5 h-3.5" />
                    Merge
                  </Button>
                </div>
              )}
              {active.reviewedAt && (
                <div className="text-xs text-ink-500">
                  Reviewed by {active.reviewer || 'unknown'} on{' '}
                  {new Date(active.reviewedAt).toLocaleString()}
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function LintPanel({ pr, onRelint }) {
  const findings = Array.isArray(pr.lintFindings) ? pr.lintFindings : [];
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');

  return (
    <div className="rounded-lg border border-ink-200 bg-white overflow-hidden">
      <div
        className={`flex items-center justify-between px-3 py-2 ${
          pr.lintPassed ? 'bg-emerald-50' : 'bg-rose-50'
        }`}
      >
        <div className="flex items-center gap-2">
          {pr.lintPassed ? (
            <Check className="w-3.5 h-3.5 text-emerald-700" />
          ) : (
            <AlertOctagon className="w-3.5 h-3.5 text-rose-700" />
          )}
          <span
            className={`text-xs font-bold uppercase tracking-wider ${
              pr.lintPassed ? 'text-emerald-800' : 'text-rose-800'
            }`}
          >
            Lint gates
          </span>
          <span className="text-xs text-ink-600">
            {errors.length} error{errors.length === 1 ? '' : 's'} · {warnings.length} warning{warnings.length === 1 ? '' : 's'}
          </span>
        </div>
        <button
          type="button"
          onClick={onRelint}
          className="text-xs text-ink-700 hover:text-ink-900 inline-flex items-center gap-1"
        >
          <RefreshCw className="w-3 h-3" />
          Re-run
        </button>
      </div>
      {findings.length === 0 ? (
        <div className="px-3 py-2 text-xs text-emerald-700">All checks passed.</div>
      ) : (
        <ul className="divide-y divide-ink-100">
          {findings.map((f, i) => (
            <li key={i} className="px-3 py-2 flex gap-2 items-start text-xs">
              {f.severity === 'error' ? (
                <AlertOctagon className="w-3.5 h-3.5 text-rose-600 mt-0.5 shrink-0" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600 mt-0.5 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div>
                  <span className="font-mono text-2xs text-ink-500 mr-1.5">
                    {f.rule}
                  </span>
                  <span className="text-ink-900">{f.message}</span>
                </div>
                {f.snippet && (
                  <pre className="mt-1 text-2xs font-mono bg-ink-50 text-ink-700 rounded px-2 py-1 overflow-x-auto">
                    line {f.line}: {f.snippet}
                  </pre>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
