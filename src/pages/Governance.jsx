import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  Check, X, GitMerge, ShieldCheck, FileCode, RefreshCw, AlertTriangle, AlertOctagon,
  MessageSquare, Send, Trash2, GitCompare, GitPullRequest, ExternalLink, Loader2,
} from 'lucide-react';
import Input from '../components/ui/Input';
import api, { ApiError } from '../lib/apiClient';
import { useAuth } from '../store/auth';
import { useProject } from '../store/project';
import { useToast } from '../lib/useToast';
import { useConfirm } from '../lib/useConfirm';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import Button from '../components/ui/Button';

// Status palette (Phase 8: now token-based — previously raw amber/sky/emerald/rose).
const STATUS_META = {
  pending:  { label: 'Pending',  cls: 'bg-warn-50 text-warn-700 border-warn-200' },
  approved: { label: 'Approved', cls: 'bg-info-50 text-info-700 border-info-100' },
  merged:   { label: 'Merged',   cls: 'bg-success-50 text-success-700 border-success-200' },
  rejected: { label: 'Rejected', cls: 'bg-ink-100 text-ink-600 border-ink-200' },
};
function statusMeta(s) { return STATUS_META[s] || STATUS_META.pending; }

const VIEW_TABS = [
  { id: 'spec', label: 'Code', icon: FileCode },
  { id: 'diff', label: 'Diff vs main', icon: GitCompare },
];

export default function Governance() {
  const { current, currentSprintId } = useProject();
  const { profile } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [prs, setPrs] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [active, setActive] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [view, setView] = useState('spec'); // 'spec' | 'diff'

  const load = useCallback(async () => {
    if (!current) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const sprintQs = currentSprintId ? `?sprintId=${encodeURIComponent(currentSprintId)}` : '';
      const res = await api.get(`/projects/${current.id}/governance${sprintQs}`);
      setPrs(res.prs || []);
      if (!activeId && res.prs?.length) setActiveId(res.prs[0].id);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [current, toast, activeId, currentSprintId]);

  useEffect(() => { load(); }, [load]);

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

  const reLint = async () => {
    if (!activeId) return;
    try {
      const res = await api.post(`/projects/${current.id}/governance/${activeId}/lint`, {});
      setActive(res.pr);
      if (res.lint.passed) toast.success('Lint clean.', { title: 'No errors' });
      else toast.error(`${res.lint.errorCount} error · ${res.lint.warningCount} warning`, { title: 'Lint findings' });
    } catch (err) {
      toast.error(err.message);
    }
  };

  // Approve / Reject / Merge — all behind a confirm dialog. Approve + reject
  // are reversible (state machine), but merge is the irreversible step so the
  // dialog body is more pointed for it.
  //
  // Phase E7 — 'refresh-after-push' is a sentinel from PushToGitModal asking
  // the parent to re-fetch state after a successful push. It bypasses the
  // confirm dialog (the push was already confirmed in the modal).
  const reviewAction = async (action) => {
    if (action === 'refresh-after-push') {
      await load();
      // Also refresh the active PR specifically so the new provider chip
      // appears immediately even before the list refresh resolves.
      try {
        const res = await api.get(`/projects/${current.id}/governance/${activeId}`);
        setActive(res.pr);
      } catch (_) {}
      return;
    }
    const meta = {
      approve: { title: 'Approve this PR?', message: 'Approving marks the PR ready to merge. Lint must still pass to merge.', confirmLabel: 'Approve' },
      reject:  { title: 'Reject this PR?',  message: 'The PR will be archived as rejected. It stays visible in history for audit; the test case is unaffected.', confirmLabel: 'Reject' },
      merge:   { title: 'Merge this PR?',   message: 'Merge finalises the PR inside QAAI. The spec becomes the new diff baseline for future regenerations of this case. (Does NOT push to GitHub — use "Push to Git" for that.)', confirmLabel: 'Merge', destructive: true },
    }[action];
    const ok = await confirm(meta);
    if (!ok) return;
    try {
      await api.post(`/projects/${current.id}/governance/${activeId}/${action}`, {});
      await load();
      toast.success(`PR ${action}d.`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: `Cannot ${action}` });
    }
  };

  if (!current) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Governance" />
        <EmptyState icon={ShieldCheck} title="No project selected" message="Activate a project to see generated PRs." />
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
          <div className="px-3 py-2 flex gap-1 border-b border-ink-100 flex-wrap">
            {['all', 'pending', 'approved', 'merged', 'rejected'].map((s) => (
              <button
                key={s}
                onClick={() => setFilter(s)}
                className={`text-2xs px-1.5 py-0.5 rounded font-bold uppercase tracking-wider ${
                  filter === s ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-600 hover:bg-ink-200'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          {loading ? (
            <div className="text-xs text-ink-500 px-3 py-2">Loading…</div>
          ) : visible.length === 0 ? (
            <EmptyState icon={FileCode} title="No PRs" message="Generated PRs from passed test cases will appear here for review." />
          ) : (
            visible.map((pr) => {
              const meta = statusMeta(pr.status);
              return (
                <button
                  key={pr.id}
                  onClick={() => { setActiveId(pr.id); setView('spec'); }}
                  className={`block w-full text-left px-3 py-2 border-b border-ink-100 hover:bg-ink-50 ${
                    activeId === pr.id ? 'bg-ink-50' : ''
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono text-ink-500">{pr.number}</span>
                    <span className={`text-2xs font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border ${meta.cls}`}>
                      {meta.label}
                    </span>
                  </div>
                  <div className="text-xs font-semibold text-ink-900 mt-0.5 truncate">{pr.filename}</div>
                  <div className="text-2xs text-ink-500 truncate">{pr.requirement}</div>
                  {!pr.lintPassed && (
                    <div className="text-2xs text-danger-700 mt-0.5 inline-flex items-center gap-1">
                      <AlertOctagon className="w-2.5 h-2.5" />
                      Lint failed
                    </div>
                  )}
                </button>
              );
            })
          )}
        </aside>

        <section className="overflow-y-auto p-5">
          {!active ? (
            <EmptyState icon={FileCode} title="Select a PR" message="Pick a PR from the left to review." />
          ) : (
            <PRDetail
              pr={active}
              projectId={current.id}
              userEmail={profile?.email || ''}
              view={view}
              setView={setView}
              onRelint={reLint}
              onAction={reviewAction}
            />
          )}
        </section>
      </main>
    </div>
  );
}

// PR detail pane — header strip, code/diff tabs, lint panel (clickable
// findings scroll the active view to the offending line), action footer,
// comments thread.
function PRDetail({ pr, projectId, userEmail, view, setView, onRelint, onAction }) {
  const meta = statusMeta(pr.status);
  // Tracks the "highlight this line for 2s" pulse on the code/diff view when
  // the user clicks a lint finding. Cleared automatically after the timeout.
  const [pulseLine, setPulseLine] = useState(null);
  const pulseTimerRef = useRef(null);
  const handleLineFocus = (lineNo) => {
    if (!lineNo) return;
    setPulseLine(lineNo);
    if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
    pulseTimerRef.current = setTimeout(() => setPulseLine(null), 2000);
  };
  useEffect(() => () => { if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current); }, []);

  // Phase E7 — Push to Git modal state. The modal renders nothing when
  // closed; closed state never reaches the network. The chip below the
  // status badge is the persistent surface for "this was pushed".
  const [pushModalOpen, setPushModalOpen] = useState(false);

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="text-xs font-mono text-ink-500">{pr.number}</div>
          <h2 className="font-bold text-ink-900">{pr.filename}</h2>
          <p className="text-xs text-ink-500 mt-0.5">{pr.requirement}</p>
          {pr.providerPrUrl && (
            <a
              href={pr.providerPrUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1.5 text-2xs font-semibold rounded-pill px-2 py-0.5 border border-accent-200 bg-accent-50 text-accent-800 hover:bg-accent-100 transition-colors"
              title={`Open ${pr.providerPrNumber ? `PR #${pr.providerPrNumber}` : 'PR'} on GitHub`}
            >
              <GitPullRequest className="w-3 h-3" />
              GitHub PR #{pr.providerPrNumber || '—'}
              <ExternalLink className="w-2.5 h-2.5 opacity-70" />
            </a>
          )}
          {pr.providerStatus === 'error' && !pr.providerPrUrl && (
            <span className="mt-2 inline-flex items-center gap-1.5 text-2xs font-semibold rounded-pill px-2 py-0.5 border border-danger-200 bg-danger-50 text-danger-700">
              <AlertOctagon className="w-3 h-3" />
              Last push failed — retry below
            </span>
          )}
        </div>
        <span className={`text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${meta.cls} shrink-0`}>
          {meta.label}
        </span>
      </div>

      <LintPanel pr={pr} onRelint={onRelint} onLineClick={handleLineFocus} />

      <div className="rounded-lg overflow-hidden border border-ink-200">
        <div className="flex items-center justify-between bg-ink-100 px-3 py-1.5 border-b border-ink-200">
          <div className="text-xs font-mono text-ink-600 truncate">{pr.filename}</div>
          <div className="inline-flex rounded-md border border-ink-200 bg-white p-0.5">
            {VIEW_TABS.map((tab) => {
              const Icon = tab.icon;
              const sel = view === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setView(tab.id)}
                  className={`h-7 px-2 text-2xs font-bold uppercase tracking-wider rounded inline-flex items-center gap-1 ${
                    sel ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-50'
                  }`}
                >
                  <Icon className="w-3 h-3" />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
        {view === 'spec' ? (
          <SpecCode code={pr.specCode || ''} pulseLine={pulseLine} />
        ) : (
          <DiffView projectId={projectId} prId={pr.id} pulseLine={pulseLine} />
        )}
      </div>

      {pr.status === 'pending' && (
        <div className="flex justify-end gap-2 pt-2 border-t border-ink-200">
          <Button size="sm" variant="ghost" onClick={() => onAction('reject')} className="text-danger-600">
            <X className="w-3.5 h-3.5" />
            Reject
          </Button>
          <Button size="sm" onClick={() => onAction('approve')}>
            <Check className="w-3.5 h-3.5" />
            Approve
          </Button>
        </div>
      )}
      {pr.status === 'approved' && (
        <div className="flex items-center justify-end gap-3 pt-2 border-t border-ink-200">
          {!pr.lintPassed && (
            <span className="text-xs text-danger-700 inline-flex items-center gap-1">
              <AlertOctagon className="w-3 h-3" />
              Lint must pass to merge
            </span>
          )}
          {/* Phase E7 — Push to Git. Sits alongside Merge; the two
              actions are independent. The button is enabled only when
              lint passes, the PR hasn't already been pushed, and the
              modal's preview load confirmed the repo + PAT are wired. */}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setPushModalOpen(true)}
            disabled={!pr.lintPassed || !!pr.providerPrUrl}
            title={
              pr.providerPrUrl ? 'Already pushed to GitHub' :
              !pr.lintPassed ? 'Lint must pass first' :
              'Open a real PR on the configured repo'
            }
          >
            <GitPullRequest className="w-3.5 h-3.5" />
            {pr.providerPrUrl ? 'Pushed' : 'Push to Git'}
          </Button>
          <Button size="sm" onClick={() => onAction('merge')} disabled={!pr.lintPassed}>
            <GitMerge className="w-3.5 h-3.5" />
            Merge in QAAI
          </Button>
        </div>
      )}

      {/* Phase E7 — push modal. Loads preview from the server (branch
          name / commit / PR title), lets the operator override before
          confirming, calls /push-to-git on confirm. Modal-only — never
          mounted unless pushModalOpen is true. */}
      {pushModalOpen && (
        <PushToGitModal
          projectId={projectId}
          pr={pr}
          onClose={() => setPushModalOpen(false)}
          onPushed={(updatedPr) => {
            setPushModalOpen(false);
            // Bubble the updated PR back through the standard refresh
            // pathway. onAction('refresh-after-push') is a sentinel the
            // parent recognises; if not wired, fall back to a no-op.
            if (typeof onAction === 'function') onAction('refresh-after-push');
          }}
        />
      )}
      {pr.reviewedAt && (
        <div className="text-xs text-ink-500">
          Reviewed by {pr.reviewer || 'unknown'} on {new Date(pr.reviewedAt).toLocaleString()}
        </div>
      )}

      <CommentsThread projectId={projectId} prId={pr.id} userEmail={userEmail} />
    </div>
  );
}

// Phase E7 — Push-to-Git confirmation modal. Lazy-loaded preview from
// /push-preview shows branch / commit / PR title / spec path; operator
// can override any field before confirming. On submit, POSTs to
// /push-to-git and calls onPushed with the updated PR row.
//
// Renders fully (no portal — overlay positioned fixed). Modal-only state;
// nothing happens until the user confirms. Closes on backdrop click or
// Cancel. Server validates everything again, so client-side preview is
// purely informational.
function PushToGitModal({ projectId, pr, onClose, onPushed }) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [pushing, setPushing] = useState(false);
  const [preview, setPreview] = useState(null);
  const [blockers, setBlockers] = useState([]);
  const [form, setForm] = useState({
    branchName: '',
    commitMessage: '',
    prTitle: '',
    specPath: '',
  });
  const [showBody, setShowBody] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get(`/projects/${projectId}/governance/${pr.id}/push-preview`);
        if (cancelled) return;
        setPreview(res.preview);
        setBlockers(res.blockers || []);
        setForm({
          branchName: res.preview.branchName || '',
          commitMessage: res.preview.commitMessage || '',
          prTitle: res.preview.prTitle || '',
          specPath: res.preview.specPath || '',
        });
      } catch (err) {
        if (!cancelled) toast.error(err.message || 'Failed to load push preview.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, pr.id, toast]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !pushing) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pushing]);

  const submit = async () => {
    setPushing(true);
    try {
      const res = await api.post(
        `/projects/${projectId}/governance/${pr.id}/push-to-git`,
        {
          branchName: form.branchName.trim() || undefined,
          commitMessage: form.commitMessage.trim() || undefined,
          prTitle: form.prTitle.trim() || undefined,
          specPath: form.specPath.trim() || undefined,
        },
      );
      toast.success(
        `Opened PR #${res.pushed?.prNumber || ''} on ${preview?.repo || 'GitHub'}.`,
        { title: 'Pushed to Git' },
      );
      onPushed?.(res.pr);
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      const code = err instanceof ApiError ? err.payload?.code : null;
      toast.error(
        code ? `${code}: ${msg}` : msg,
        { title: 'Push failed' },
      );
    } finally {
      setPushing(false);
    }
  };

  const canSubmit = !loading && !pushing && blockers.length === 0
    && form.branchName.trim() && form.commitMessage.trim() && form.prTitle.trim();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !pushing) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="push-to-git-title"
    >
      <div className="bg-white rounded-card shadow-card-hover border border-ink-200 w-full max-w-xl max-h-[88vh] overflow-y-auto">
        <header className="flex items-start justify-between gap-2 px-5 py-4 border-b border-ink-100">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-accent-50 inline-flex items-center justify-center">
              <GitPullRequest className="w-4 h-4 text-accent-700" />
            </div>
            <div>
              <h3 id="push-to-git-title" className="text-sm font-semibold text-ink-900">Push to Git</h3>
              <p className="text-2xs text-ink-500">Opens a real pull request on the configured repo.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={pushing}
            className="p-1 rounded text-ink-400 hover:text-ink-700 hover:bg-ink-100 disabled:opacity-50"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="p-5 space-y-4">
          {loading && (
            <div className="text-xs text-ink-500 inline-flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Loading preview…
            </div>
          )}

          {!loading && blockers.length > 0 && (
            <div className="rounded border border-warn-200 bg-warn-50 p-3">
              <div className="text-xs font-semibold text-warn-900 mb-1.5 inline-flex items-center gap-1.5">
                <AlertOctagon className="w-3.5 h-3.5" />
                Cannot push yet
              </div>
              <ul className="text-xs text-warn-900 space-y-0.5 list-disc list-inside">
                {blockers.map((b, i) => <li key={i}>{b}</li>)}
              </ul>
            </div>
          )}

          {!loading && preview && blockers.length === 0 && (
            <>
              {/* Target — read-only context */}
              <div className="rounded border border-ink-200 bg-ink-50 p-3 text-xs space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-2xs uppercase tracking-wider font-bold text-ink-500 w-20">Repo</span>
                  <span className="font-mono text-ink-900">{preview.repo || '—'}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-2xs uppercase tracking-wider font-bold text-ink-500 w-20">Base</span>
                  <span className="font-mono text-ink-700">{preview.baseBranch}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-2xs uppercase tracking-wider font-bold text-ink-500 w-20">Provider</span>
                  <span className="text-ink-700 capitalize">{preview.provider}</span>
                </div>
              </div>

              {/* Editable fields */}
              <Input
                label="Branch name"
                value={form.branchName}
                onChange={(e) => setForm((f) => ({ ...f, branchName: e.target.value }))}
                placeholder="qaai/feature-x"
                disabled={pushing}
              />
              <Input
                label="Commit message"
                value={form.commitMessage}
                onChange={(e) => setForm((f) => ({ ...f, commitMessage: e.target.value }))}
                disabled={pushing}
              />
              <Input
                label="Pull request title"
                value={form.prTitle}
                onChange={(e) => setForm((f) => ({ ...f, prTitle: e.target.value }))}
                disabled={pushing}
              />
              <Input
                label="Spec path in repo"
                value={form.specPath}
                onChange={(e) => setForm((f) => ({ ...f, specPath: e.target.value }))}
                placeholder="tests/qaai/login.spec.ts"
                disabled={pushing}
              />

              {/* PR body preview — collapsed by default. Lives entirely
                  on the server (description is composed there); the
                  modal just shows a peek so the operator can verify the
                  reviewers see useful context. */}
              <div className="rounded border border-ink-200 bg-white">
                <button
                  type="button"
                  onClick={() => setShowBody((v) => !v)}
                  className="w-full px-3 py-2 text-2xs uppercase tracking-wider font-bold text-ink-600 hover:bg-ink-50 inline-flex items-center justify-between"
                >
                  <span>PR description preview</span>
                  <span className="text-ink-400">{showBody ? 'Hide' : 'Show'}</span>
                </button>
                {showBody && (
                  <pre className="text-2xs font-mono text-ink-700 px-3 py-2 border-t border-ink-100 bg-ink-50 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
{`> Generated by QAAI Portal · Project context
> QAAI PR: ${pr.number}
> Requirement: ${pr.requirement || '—'}

## Lint
${(pr.lintFindings && pr.lintFindings.length) ? `${pr.lintFindings.length} finding(s) — listed in body` : '✓ Lint clean'}

## Spec
\`\`\`ts
${(pr.specCode || '').slice(0, 400)}${(pr.specCode || '').length > 400 ? '\n…' : ''}
\`\`\`

(Full body assembled server-side before push.)`}
                  </pre>
                )}
              </div>
            </>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-ink-100 bg-ink-50">
          <Button size="sm" variant="ghost" onClick={onClose} disabled={pushing}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} loading={pushing} disabled={!canSubmit}>
            <GitPullRequest className="w-3.5 h-3.5" />
            Open PR on GitHub
          </Button>
        </footer>
      </div>
    </div>
  );
}

// Lint findings panel — clicking a finding with a line scrolls the code/
// diff view to it and pulses the row for 2s. Replaces the previous static
// list with an actionable hint surface.
function LintPanel({ pr, onRelint, onLineClick }) {
  const findings = Array.isArray(pr.lintFindings) ? pr.lintFindings : [];
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');

  return (
    <div className="rounded-lg border border-ink-200 bg-white overflow-hidden">
      <div className={`flex items-center justify-between px-3 py-2 ${pr.lintPassed ? 'bg-success-50' : 'bg-danger-50'}`}>
        <div className="flex items-center gap-2">
          {pr.lintPassed
            ? <Check className="w-3.5 h-3.5 text-success-700" />
            : <AlertOctagon className="w-3.5 h-3.5 text-danger-700" />}
          <span className={`text-xs font-bold uppercase tracking-wider ${pr.lintPassed ? 'text-success-800' : 'text-danger-800'}`}>
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
        <div className="px-3 py-2 text-xs text-success-700">All checks passed.</div>
      ) : (
        <ul className="divide-y divide-ink-100">
          {findings.map((f, i) => (
            <li key={i} className="px-3 py-2 flex gap-2 items-start text-xs">
              {f.severity === 'error'
                ? <AlertOctagon className="w-3.5 h-3.5 text-danger-600 mt-0.5 shrink-0" />
                : <AlertTriangle className="w-3.5 h-3.5 text-warn-600 mt-0.5 shrink-0" />}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-2xs text-ink-500">{f.rule}</span>
                  <span className="text-ink-900">{f.message}</span>
                  {f.line && (
                    <button
                      type="button"
                      onClick={() => onLineClick(f.line)}
                      className="ml-auto text-2xs font-semibold text-info-700 hover:underline"
                      title="Jump to line in the code view"
                    >
                      Line {f.line}
                    </button>
                  )}
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

// Plain code view with line numbers + click-to-pulse highlight. The dark
// background is the ink-900 token (was previously raw `bg-ink-900` already).
function SpecCode({ code, pulseLine }) {
  const lines = useMemo(() => code.split('\n'), [code]);
  const rowRef = useRef(null);

  useEffect(() => {
    if (pulseLine && rowRef.current) {
      rowRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [pulseLine]);

  return (
    <div className="bg-ink-900 text-ink-100 text-xs overflow-x-auto font-mono leading-relaxed max-h-[60vh] overflow-y-auto">
      {lines.map((line, i) => {
        const lineNo = i + 1;
        const isPulse = lineNo === pulseLine;
        return (
          <div
            key={i}
            ref={isPulse ? rowRef : null}
            className={`flex ${isPulse ? 'bg-warn-700/40 transition-colors' : ''}`}
          >
            <span className="select-none w-12 shrink-0 text-right pr-3 text-ink-500 tabular-nums">{lineNo}</span>
            <pre className="flex-1 whitespace-pre">{line || ' '}</pre>
          </div>
        );
      })}
    </div>
  );
}

// Side-by-side diff (Phase 8). Fetches the diff lazily on first render of
// the tab. Equal rows = neutral, removes = danger-tinted, adds = success-
// tinted, empty cells stay grey. Clicking a lint Line in the panel scrolls
// to the matching rightNo here too.
function DiffView({ projectId, prId, pulseLine }) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const rowRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await api.get(`/projects/${projectId}/governance/${prId}/diff`);
        if (!cancelled) setData(res);
      } catch (err) {
        if (!cancelled) toast.error(err.message, { title: 'Diff failed' });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, prId, toast]);

  useEffect(() => {
    if (pulseLine && rowRef.current) {
      rowRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [pulseLine, data]);

  if (loading) {
    return <div className="bg-ink-900 text-ink-300 text-xs p-3">Computing diff…</div>;
  }
  if (!data) {
    return <div className="bg-ink-900 text-ink-300 text-xs p-3">No diff available.</div>;
  }
  const { rows, summary, baseRef } = data;

  return (
    <div className="bg-ink-900 text-ink-100 text-xs">
      <div className="bg-ink-800 px-3 py-1.5 flex items-center gap-3 border-b border-ink-700">
        <span className="text-2xs uppercase tracking-wider font-bold text-ink-300">
          {baseRef ? `Comparing against ${baseRef.number}` : 'New file (no prior merge)'}
        </span>
        <span className="text-2xs text-success-300">+{summary.added}</span>
        <span className="text-2xs text-danger-300">−{summary.removed}</span>
        <span className="text-2xs text-ink-500">·  {summary.equal} unchanged</span>
      </div>
      <div className="grid grid-cols-2 overflow-x-auto max-h-[60vh] overflow-y-auto">
        {rows.map((row, idx) => {
          const isPulse = row.rightNo && row.rightNo === pulseLine;
          const leftClass = row.kind === 'remove'
            ? 'bg-danger-900/40 text-danger-100'
            : row.leftText === null ? 'bg-ink-800/30' : '';
          const rightClass = row.kind === 'add'
            ? 'bg-success-900/40 text-success-100'
            : row.rightText === null ? 'bg-ink-800/30' : '';
          return (
            <React.Fragment key={idx}>
              <div className={`flex ${leftClass}`}>
                <span className="select-none w-10 shrink-0 text-right pr-2 text-ink-500 tabular-nums">{row.leftNo ?? ''}</span>
                <pre className="flex-1 whitespace-pre overflow-x-hidden">{row.leftText ?? ' '}</pre>
              </div>
              <div
                ref={isPulse ? rowRef : null}
                className={`flex ${rightClass} ${isPulse ? 'ring-2 ring-warn-400 ring-inset' : ''}`}
              >
                <span className="select-none w-10 shrink-0 text-right pr-2 text-ink-500 tabular-nums">{row.rightNo ?? ''}</span>
                <pre className="flex-1 whitespace-pre overflow-x-hidden">{row.rightText ?? ' '}</pre>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

// Comments thread — list + composer. Authored by req.user.email server-side;
// only the author can delete their own entries.
function CommentsThread({ projectId, prId, userEmail }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/projects/${projectId}/governance/${prId}/comments`);
      setComments(res.comments || []);
    } catch (err) {
      toast.error(err.message, { title: 'Load comments failed' });
    } finally {
      setLoading(false);
    }
  }, [projectId, prId, toast]);

  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    const body = draft.trim();
    if (!body) return;
    setPosting(true);
    try {
      await api.post(`/projects/${projectId}/governance/${prId}/comments`, { body });
      setDraft('');
      await load();
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Post failed' });
    } finally {
      setPosting(false);
    }
  };

  const remove = async (comment) => {
    const ok = await confirm({
      title: 'Delete this comment?',
      message: 'The comment will be permanently removed. Other comments on this PR are unaffected.',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await api.del(`/projects/${projectId}/governance/${prId}/comments/${comment.id}`);
      await load();
    } catch (err) {
      toast.error(err.message, { title: 'Delete failed' });
    }
  };

  return (
    <div className="rounded-lg border border-ink-200 bg-white">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-ink-100">
        <MessageSquare className="w-3.5 h-3.5 text-ink-500" />
        <span className="text-2xs uppercase tracking-wider font-bold text-ink-700">
          Comments
        </span>
        <span className="text-xs text-ink-500">{comments.length}</span>
      </div>
      {loading ? (
        <div className="px-3 py-2 text-xs text-ink-500">Loading…</div>
      ) : comments.length === 0 ? (
        <div className="px-3 py-2 text-xs text-ink-400 italic">No comments yet. Be the first to weigh in below.</div>
      ) : (
        <ul className="divide-y divide-ink-100">
          {comments.map((c) => {
            const mine = c.author === userEmail;
            return (
              <li key={c.id} className="px-3 py-2 text-xs">
                <div className="flex items-baseline gap-2 mb-1">
                  <span className={`font-semibold ${mine ? 'text-info-700' : 'text-ink-900'}`}>{c.author}</span>
                  <span className="text-2xs text-ink-400 tabular-nums">{new Date(c.createdAt).toLocaleString()}</span>
                  {mine && (
                    <button
                      type="button"
                      onClick={() => remove(c)}
                      className="ml-auto text-2xs text-danger-600 hover:text-danger-800 inline-flex items-center gap-0.5"
                      title="Delete your comment"
                    >
                      <Trash2 className="w-3 h-3" />
                      Delete
                    </button>
                  )}
                </div>
                <p className="text-ink-800 whitespace-pre-wrap break-words">{c.body}</p>
              </li>
            );
          })}
        </ul>
      )}
      <div className="border-t border-ink-100 p-3 space-y-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          placeholder="Add a review comment…"
          className="w-full rounded-md border border-ink-200 bg-white text-xs px-3 py-2 font-sans resize-y focus:outline-none focus:ring-2 focus:ring-ink-900 focus:border-transparent"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="flex items-center justify-between">
          <span className="text-2xs text-ink-400">⌘↵ to post · {draft.length}/4000</span>
          <Button size="sm" onClick={submit} loading={posting} disabled={!draft.trim() || posting}>
            <Send className="w-3 h-3" />
            Post comment
          </Button>
        </div>
      </div>
    </div>
  );
}
