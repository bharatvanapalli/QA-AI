import React, { useEffect, useState, useCallback } from 'react';
import {
  AlertTriangle, Check, RefreshCw, Trash2, SkipForward, Crosshair,
  Bot, Globe, ShieldAlert, Lock, Network, Clock, AlertOctagon,
  HelpCircle, FolderTree, History,
} from 'lucide-react';
import api, { ApiError } from '../lib/apiClient';
import { BASE_URL } from '../lib/apiClient';
import { useProject } from '../store/project';
import { useToast } from '../lib/useToast';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';

const API_ORIGIN = (BASE_URL || 'http://localhost:5000/api').replace(/\/api$/, '');
const absUrl = (u) => (u?.startsWith('http') ? u : u ? API_ORIGIN + u : null);

/**
 * Per-reason metadata. Each entry decides:
 *   label / icon / colour    — how the chip renders
 *   blurb                    — a one-sentence explanation of what this kind
 *                              of blocker actually means (NOT the raw error)
 *   needsLocator             — whether the locator-replacement input is
 *                              actionable for this kind. False for agent
 *                              loops, browser crashes, captchas, etc. —
 *                              asking the user for a CSS selector when the
 *                              browser failed to launch is nonsense.
 *   suggestedAction          — short hint shown next to Skip / Delete so
 *                              the user knows what's expected of them.
 */
const REASON_META = {
  locator_missing: {
    label: 'Locator missing',
    icon: Crosshair,
    cls: 'bg-warn-50 text-warn-700 border-warn-200',
    blurb: 'The agent could not find an element it needed. Supplying a stable selector lets the agent (and future runs) recover.',
    needsLocator: true,
    suggestedAction: 'Provide a working selector if you know one. Otherwise skip.',
  },
  popup: {
    label: 'Popup / modal',
    icon: AlertOctagon,
    cls: 'bg-warn-50 text-warn-700 border-warn-200',
    blurb: 'The page surfaced a consent banner, modal, or dialog the agent did not anticipate. A selector for the close/accept button usually unblocks it.',
    needsLocator: true,
    suggestedAction: 'Supply a selector for the dismiss / accept button.',
  },
  captcha: {
    label: 'Captcha challenge',
    icon: ShieldAlert,
    cls: 'bg-danger-50 text-danger-700 border-danger-200',
    blurb: 'The target site presented a CAPTCHA. No selector can solve this — the agent cannot bypass human-verification challenges.',
    needsLocator: false,
    suggestedAction: 'Skip this case, or move the test to a non-CAPTCHA environment.',
  },
  agent_loop: {
    label: 'Agent loop',
    icon: Bot,
    cls: 'bg-info-50 text-info-700 border-info-100',
    blurb: 'The agent retried the same action repeatedly without progress and hit its safety ceiling. This is usually a sign the test case needs better guidance, not a locator change.',
    needsLocator: false,
    suggestedAction: 'Skip and rewrite the test case, or rerun after editing the steps.',
  },
  agent_repeating: {
    label: 'Agent repeating',
    icon: Bot,
    cls: 'bg-info-50 text-info-700 border-info-100',
    blurb: 'The agent hit the same error three times in a row and bailed out. This is a symptom of an environmental issue — not something a selector can fix.',
    needsLocator: false,
    suggestedAction: 'Skip, or investigate the underlying error and retry.',
  },
  browser_missing: {
    label: 'Browser not installed',
    icon: Globe,
    cls: 'bg-ink-100 text-ink-700 border-ink-200',
    blurb: 'Chromium is not installed on the server. Run `npx playwright install chromium` (with NODE_TLS_REJECT_UNAUTHORIZED=0 if behind a proxy).',
    needsLocator: false,
    suggestedAction: 'This is an environment issue — install Chromium on the server, then delete this blocker.',
  },
  browser_crash: {
    label: 'Browser crashed',
    icon: Globe,
    cls: 'bg-danger-50 text-danger-700 border-danger-200',
    blurb: 'The browser or page died mid-run. Usually transient — most commonly caused by zombie profile dirs, a system OOM, or the target navigating away during a check.',
    needsLocator: false,
    suggestedAction: 'Retry the run. If it persists, clear %TEMP%/playwright_chromiumdev_profile-* and try again.',
  },
  supervisor_giveup: {
    label: 'Supervisor stopped',
    icon: ShieldAlert,
    cls: 'bg-ink-100 text-ink-700 border-ink-200',
    blurb: 'After three Conductor attempts plus a supervised final attempt, the Supervisor judged this case unsalvageable. The reason text below is the Supervisor\'s explanation.',
    needsLocator: false,
    suggestedAction: 'Read the Supervisor\'s reasoning. If the case is genuinely untestable, delete it.',
  },
  timeout: {
    label: 'Timeout',
    icon: Clock,
    cls: 'bg-warn-50 text-warn-700 border-warn-200',
    blurb: 'A wait operation exceeded its time budget. Could be a slow network, a missing element, or an unexpected loading state.',
    needsLocator: true,
    suggestedAction: 'If a specific element timed out, provide its selector.',
  },
  assertion: {
    label: 'Assertion failed',
    icon: AlertOctagon,
    cls: 'bg-danger-50 text-danger-700 border-danger-200',
    blurb: 'A test case assertion did not match the page state. The expected and actual values differed.',
    needsLocator: false,
    suggestedAction: 'Either the app has a bug, or the test case\'s expectation is wrong. Edit the test case and retry.',
  },
  auth: {
    label: 'Auth required',
    icon: Lock,
    cls: 'bg-ink-100 text-ink-700 border-ink-200',
    blurb: 'The target returned 401/Unauthorized. Either credentials are wrong or the session expired.',
    needsLocator: false,
    suggestedAction: 'Update credentials in Settings, then retry.',
  },
  permission: {
    label: 'Permission denied',
    icon: Lock,
    cls: 'bg-ink-100 text-ink-700 border-ink-200',
    blurb: 'The target returned 403/Forbidden. The signed-in user does not have access to the page under test.',
    needsLocator: false,
    suggestedAction: 'Use a higher-privilege test account or move this case to a different environment.',
  },
  network: {
    label: 'Network',
    icon: Network,
    cls: 'bg-info-50 text-info-700 border-info-100',
    blurb: 'A connectivity error prevented the agent from reaching the target. DNS, CORS, or a firewall.',
    needsLocator: false,
    suggestedAction: 'Verify connectivity from the server, then retry.',
  },
  unknown: {
    label: 'Unclassified',
    icon: HelpCircle,
    cls: 'bg-ink-100 text-ink-700 border-ink-200',
    blurb: 'We could not classify this blocker automatically. Read the message below and decide whether a selector helps.',
    needsLocator: true,
    suggestedAction: 'Provide a selector if it\'s clearly a locator issue, otherwise skip.',
  },
};

function reasonMeta(reason) {
  return REASON_META[reason] || REASON_META.unknown;
}

export default function BlockedItems() {
  const { current } = useProject();
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState('latest'); // 'latest' | 'all'

  const load = useCallback(async () => {
    if (!current) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await api.get(`/projects/${current.id}/blocked?scope=${scope}`);
      setItems(res.items || []);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [current, toast, scope]);

  useEffect(() => {
    load();
  }, [load]);

  const resolve = async (item, newSelector) => {
    try {
      await api.post(`/projects/${current.id}/blocked/${item.id}/resolve`, {
        newSelector: newSelector || null,
      });
      setItems((all) => all.filter((x) => x.id !== item.id));
      toast.success(newSelector ? 'Resolved + locator stored in Knowledge Base.' : 'Marked resolved.');
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Could not resolve' });
    }
  };

  const skip = async (item) => {
    try {
      await api.post(`/projects/${current.id}/blocked/${item.id}/skip`, {});
      setItems((all) => all.filter((x) => x.id !== item.id));
      toast.success('Skipped. The blocker is hidden from the queue.', { title: 'Skipped' });
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Could not skip' });
    }
  };

  const remove = async (item) => {
    try {
      await api.del(`/projects/${current.id}/blocked/${item.id}`);
      setItems((all) => all.filter((x) => x.id !== item.id));
      toast.success('Removed permanently.', { title: 'Deleted' });
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Could not delete' });
    }
  };

  if (!current) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Blocked Items" />
        <EmptyState
          icon={AlertTriangle}
          title="No project selected"
          message="Activate a project to see blocked items."
        />
      </div>
    );
  }

  const subtitleParts = [
    `${items.length} open`,
    scope === 'latest' ? 'in latest run' : 'across all runs',
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader title="Blocked Items" subtitle={subtitleParts.join(' · ')}>
        <div className="inline-flex items-center rounded-md border border-ink-200 bg-white shadow-card p-0.5">
          <button
            type="button"
            onClick={() => setScope('latest')}
            className={`h-8 px-2.5 rounded text-xs font-semibold inline-flex items-center gap-1 ${
              scope === 'latest' ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-50'
            }`}
            aria-pressed={scope === 'latest'}
          >
            Latest run
          </button>
          <button
            type="button"
            onClick={() => setScope('all')}
            className={`h-8 px-2.5 rounded text-xs font-semibold inline-flex items-center gap-1 ${
              scope === 'all' ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-50'
            }`}
            aria-pressed={scope === 'all'}
          >
            <History className="w-3 h-3" />
            All time
          </button>
        </div>
        <Button size="sm" variant="ghost" onClick={load}>
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </Button>
      </PageHeader>

      <main className="flex-1 overflow-y-auto bg-ink-50">
        <div className="max-w-4xl mx-auto px-page py-8 space-y-3">
          {loading ? (
            <div className="text-xs text-ink-500">Loading…</div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={Check}
              title={scope === 'latest' ? 'Latest run is clean' : 'Nothing blocked'}
              message={
                scope === 'latest'
                  ? 'No blockers from the most recent run. Switch to "All time" if you want to see historical blockers.'
                  : 'Failed tests with locator, timeout, or environment issues show up here for triage.'
              }
            />
          ) : (
            items.map((it) => (
              <BlockedRow
                key={it.id}
                item={it}
                onResolve={resolve}
                onSkip={skip}
                onDelete={remove}
              />
            ))
          )}
        </div>
      </main>
    </div>
  );
}

function BlockedRow({ item, onResolve, onSkip, onDelete }) {
  const [selector, setSelector] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const meta = reasonMeta(item.reason);
  const Icon = meta.icon;

  const submit = async () => {
    setBusy(true);
    await onResolve(item, selector.trim() || null);
    setBusy(false);
  };

  const title = item.testCase?.name || 'Untitled test case';
  const scenarioName = item.scenario?.name;
  const moduleName = item.testCase?.module;
  const shotUrl = item.screenshot ? absUrl(item.screenshot) : null;

  return (
    <article className="rounded-card border border-ink-200 bg-white shadow-card hover:shadow-card-hover transition-shadow duration-200 ease-out-soft overflow-hidden">
      {/* Header strip — proper title + scenario context so the user actually
          knows what this blocker is about, instead of an opaque "UNKNOWN". */}
      <div className="p-5">
        <div className="flex items-start gap-3">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 border ${meta.cls}`}>
            <Icon className="w-5 h-5" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className={`px-2 py-0.5 rounded-pill text-2xs font-bold uppercase tracking-wider border ${meta.cls}`}>
                {meta.label}
              </span>
              {moduleName && (
                <span className="text-2xs uppercase tracking-wider text-ink-500 font-semibold">{moduleName}</span>
              )}
              {scenarioName && (
                <span className="inline-flex items-center gap-1 text-2xs text-ink-500">
                  <FolderTree className="w-3 h-3" aria-hidden="true" />
                  <span className="font-medium">{scenarioName}</span>
                </span>
              )}
              <span className="ml-auto text-2xs text-ink-400 tabular-nums">
                {new Date(item.createdAt).toLocaleString()}
              </span>
            </div>
            <h3 className="text-md font-semibold text-ink-900 tracking-tight truncate" title={title}>
              {title}
            </h3>
            <p className="text-sm text-ink-600 mt-1 leading-relaxed">{meta.blurb}</p>
          </div>
        </div>

        {/* Visual context — first screenshot from the failing run, if any. */}
        {shotUrl && (
          <div className="mt-3 rounded-md border border-ink-200 overflow-hidden bg-ink-100">
            <a href={shotUrl} target="_blank" rel="noreferrer" className="block">
              <img
                src={shotUrl}
                alt={`Screenshot from ${title}`}
                loading="lazy"
                className="block w-full max-h-64 object-contain bg-ink-900"
                onError={(e) => { e.target.parentElement.parentElement.style.display = 'none'; }}
              />
            </a>
          </div>
        )}

        {/* Raw diagnostic — collapsed by default since it's intimidating;
            anyone who actually wants to read it can click expand. */}
        {(item.message || item.resultError) && (
          <details className="mt-3 group">
            <summary className="text-2xs font-semibold uppercase tracking-wider text-ink-500 cursor-pointer hover:text-ink-700 select-none inline-flex items-center gap-1">
              Diagnostic message
              <span className="text-ink-400 group-open:hidden">— show</span>
              <span className="text-ink-400 hidden group-open:inline">— hide</span>
            </summary>
            <pre className="mt-2 bg-ink-900 text-ink-100 text-xs font-mono leading-relaxed p-3 rounded-md overflow-x-auto whitespace-pre-wrap max-h-48">
              {item.message || item.resultError}
            </pre>
            {item.locator && (
              <div className="mt-2 text-2xs text-ink-500">
                <span className="font-semibold">Failing locator: </span>
                <code className="font-mono text-ink-800 bg-ink-100 px-1 rounded">{item.locator}</code>
              </div>
            )}
          </details>
        )}
      </div>

      {/* Action footer — input shown only when a selector can actually help. */}
      <div className="px-5 py-4 bg-ink-50/60 border-t border-ink-100">
        <div className="text-2xs text-ink-500 mb-3">
          <span className="font-semibold uppercase tracking-wider">Suggested action: </span>
          {meta.suggestedAction}
        </div>

        {meta.needsLocator ? (
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto_auto] gap-2 items-end">
            <Input
              label="Replacement selector (optional)"
              value={selector}
              onChange={(e) => setSelector(e.target.value)}
              placeholder='[data-testid="submit-cta"]'
              hint="Stored in the Knowledge Base so future runs use it automatically."
            />
            <Button size="md" variant="secondary" onClick={() => onSkip(item)} title="Hide this blocker from the queue without storing a fix">
              <SkipForward className="w-3.5 h-3.5" />
              Skip
            </Button>
            <Button
              size="md"
              variant="secondary"
              onClick={() => { if (confirmDelete) onDelete(item); else setConfirmDelete(true); }}
              title="Delete this blocker permanently"
              className={confirmDelete ? '!text-danger-700 !border-danger-200 !bg-danger-50' : ''}
            >
              <Trash2 className="w-3.5 h-3.5" />
              {confirmDelete ? 'Confirm delete' : 'Delete'}
            </Button>
            <Button size="md" onClick={submit} loading={busy} disabled={busy}>
              <Check className="w-3.5 h-3.5" />
              Save fix
            </Button>
          </div>
        ) : (
          // For non-locator reasons (agent loop, browser crash, captcha, etc.)
          // the locator input would be misleading — hide it entirely and
          // only offer Skip + Delete (+ a contextual one-liner above).
          <div className="flex flex-wrap items-center gap-2">
            <Button size="md" variant="secondary" onClick={() => onSkip(item)}>
              <SkipForward className="w-3.5 h-3.5" />
              Skip
            </Button>
            <Button
              size="md"
              variant="secondary"
              onClick={() => { if (confirmDelete) onDelete(item); else setConfirmDelete(true); }}
              className={confirmDelete ? '!text-danger-700 !border-danger-200 !bg-danger-50' : ''}
            >
              <Trash2 className="w-3.5 h-3.5" />
              {confirmDelete ? 'Confirm delete' : 'Delete'}
            </Button>
          </div>
        )}
      </div>
    </article>
  );
}
