import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, Check, RefreshCw, Trash2, SkipForward, Crosshair,
  Bot, Globe, ShieldAlert, Lock, Network, Clock, AlertOctagon,
  HelpCircle, FolderTree, History, Sparkles, Link2, Wrench,
  Wand2, Loader2, RotateCcw, ArrowUpRight, CornerDownRight, Flame,
  Copy as CopyIcon,
} from 'lucide-react';
import api, { ApiError, formatRunStartError } from '../lib/apiClient';
import { BASE_URL } from '../lib/apiClient';
import { useProject } from '../store/project';
import { useToast } from '../lib/useToast';
import { useConfirm } from '../lib/useConfirm';
import { useRunStream } from '../store/runStream';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';

const API_ORIGIN = (BASE_URL || 'http://localhost:5000/api').replace(/\/api$/, '');
// Guard against non-string inputs: a blocker payload occasionally carries
// numeric/object values where the UI expected a URL (e.g., a screenshot
// metadata blob instead of a path string). The optional-chain `?.startsWith`
// only guards null/undefined — a number or object still crashes with
// "u?.startsWith is not a function" â†’ whole page hits ErrorBoundary
// ("Something broke" — observed 2026-05-28 on Blocked Items). Coerce to
// string-or-bail first; anything non-string falls through to null cleanly.
const absUrl = (u) => {
  if (typeof u !== 'string' || !u) return null;
  return u.startsWith('http') ? u : API_ORIGIN + u;
};

// AuroraBackground — same drifting-orb canvas used on Overview / Run Suite /
// Test Cases / Reports / Theater. The page content layers above as frosted
// glass so the blocker cards inherit the design language of the rest of the
// app instead of sitting on a flat white background.
function AuroraBackground() {
  return (
    <div className="aurora-canvas grain-overlay" aria-hidden="true">
      <div className="aurora-orb aurora-orb-warn    aurora-drift-1"
           style={{ width: '52vw', height: '52vw', top: '-10vw', left: '-6vw', opacity: 0.45 }} />
      <div className="aurora-orb aurora-orb-danger  aurora-drift-2"
           style={{ width: '46vw', height: '46vw', top: '-4vw', right: '-8vw', opacity: 0.38 }} />
      <div className="aurora-orb aurora-orb-info    aurora-drift-3"
           style={{ width: '42vw', height: '42vw', bottom: '-12vw', left: '20vw', opacity: 0.4 }} />
      <div className="aurora-orb aurora-orb-accent  aurora-drift-1"
           style={{ width: '34vw', height: '34vw', bottom: '-10vw', right: '8vw', opacity: 0.3 }} />
    </div>
  );
}

/**
 * Per-reason metadata. Each entry decides:
 *   label / icon / colour    — how the chip renders
 *   blurb                    — a one-sentence explanation of what this kind
 *                              of blocker actually means (NOT the raw error)
 *   needsLocator             — whether the locator-replacement input is
 *                              actionable for this kind. False for agent
 *                              loops, browser crashes, captchas, etc.
 *   suggestedAction          — short hint shown next to the action buttons
 *                              so the user knows what's expected of them.
 */
const REASON_META = {
  locator_missing: {
    label: 'Locator missing',
    icon: Crosshair,
    cls: 'bg-warn-50 text-warn-700 border-warn-200',
    blurb: 'The agent could not find an element it needed. Supplying a stable selector lets the agent (and future runs) recover.',
    needsLocator: true,
    suggestedAction: 'Provide a working selector if you know one. Otherwise rerun after editing the test case, or skip.',
  },
  popup: {
    label: 'Popup / modal',
    icon: AlertOctagon,
    cls: 'bg-warn-50 text-warn-700 border-warn-200',
    blurb: 'The page surfaced a consent banner, modal, or dialog the agent did not anticipate. A selector for the close/accept button usually unblocks it.',
    needsLocator: true,
    suggestedAction: 'Supply a selector for the dismiss / accept button, or add guidance to the test case and rerun.',
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
    suggestedAction: 'Edit the case guidance, then rerun — or skip if it cannot be automated.',
  },
  budget_exceeded: {
    label: 'Daily AI budget reached',
    icon: Clock,
    cls: 'bg-warn-50 text-warn-700 border-warn-200',
    blurb: 'QAAI stopped before the next AI action because the daily token budget was already exhausted. This is not a website failure or locator failure.',
    needsLocator: false,
    suggestedAction: 'Raise the daily budget in Settings > AI Provider, or rerun after the budget resets.',
  },
  agent_repeating: {
    label: 'Agent repeating',
    icon: Bot,
    cls: 'bg-info-50 text-info-700 border-info-100',
    blurb: 'The agent hit the same error three times in a row and bailed out. This is a symptom of an environmental issue — not something a selector can fix.',
    needsLocator: false,
    suggestedAction: 'Investigate the underlying error and rerun, or skip.',
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
    suggestedAction: 'Rerun. If it persists, clear %TEMP%/playwright_chromiumdev_profile-* and try again.',
  },
  supervisor_giveup: {
    label: 'Supervisor stopped',
    icon: ShieldAlert,
    cls: 'bg-ink-100 text-ink-700 border-ink-200',
    blurb: 'After three Conductor attempts plus a supervised final attempt, the Supervisor judged this case unsalvageable. The reason text below is the Supervisor\'s explanation.',
    needsLocator: false,
    suggestedAction: 'Read the Supervisor\'s reasoning. If the case is genuinely untestable, delete it.',
  },
  internal_evidence_gap: {
    label: 'QAAI capture issue',
    icon: Sparkles,
    cls: 'bg-info-50 text-info-700 border-info-200',
    blurb: 'This saved run was held by QAAI evidence capture before a website verdict was reached. It is not a website failure and does not need a manual selector.',
    needsLocator: false,
    suggestedAction: 'Rerun with the current engine. QAAI should execute the browser flow normally and keep evidence preparation separate from the test verdict.',
  },
  assertion_contract_defect: {
    label: 'Assertion contract defect',
    icon: AlertOctagon,
    cls: 'bg-info-50 text-info-700 border-info-200',
    blurb: 'QAAI authored or selected an assertion that contradicts the test flow. This is an internal assertion-contract issue, not a certified website failure.',
    needsLocator: false,
    suggestedAction: 'Regenerate or repair the assertion contract, then rerun this case.',
  },
  timeout: {
    label: 'Timeout',
    icon: Clock,
    cls: 'bg-warn-50 text-warn-700 border-warn-200',
    blurb: 'A wait operation exceeded its time budget. Could be a slow network, a missing element, or an unexpected loading state.',
    needsLocator: true,
    suggestedAction: 'If a specific element timed out, provide its selector. Otherwise rerun or skip.',
  },
  assertion: {
    label: 'Assertion failed',
    icon: AlertOctagon,
    cls: 'bg-danger-50 text-danger-700 border-danger-200',
    blurb: 'A test case assertion did not match the page state. The expected and actual values differed.',
    needsLocator: false,
    suggestedAction: 'Either the app has a bug, or the test case\'s expectation is wrong. Edit the test case and rerun.',
  },
  auth: {
    label: 'Auth required',
    icon: Lock,
    cls: 'bg-ink-100 text-ink-700 border-ink-200',
    blurb: 'The target returned 401/Unauthorized. Either credentials are wrong or the session expired.',
    needsLocator: false,
    suggestedAction: 'Update credentials in Settings, then rerun.',
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
    suggestedAction: 'Verify connectivity from the server, then rerun.',
  },
  unknown: {
    label: 'Unclassified',
    icon: HelpCircle,
    cls: 'bg-ink-100 text-ink-700 border-ink-200',
    blurb: 'We could not classify this blocker automatically. Read the diagnostic below and decide whether a selector helps.',
    needsLocator: true,
    suggestedAction: 'Provide a selector if it\'s clearly a locator issue, otherwise rerun after edits or skip.',
  },
};

function reasonMeta(reason) {
  return REASON_META[reason] || REASON_META.unknown;
}

function isInternalEvidenceBlocker(item) {
  const text = [
    item?.reason,
    item?.message,
    item?.resultError,
    item?.aiSummary,
    item?.aiSuggestedFix,
  ].filter(Boolean).join(' ').toLowerCase();
  return item?.reason === 'internal_evidence_gap'
    || text.includes('missing_verified_action_locator')
    || text.includes('critical_evidence_gap')
    || text.includes('internal evidence/export gap')
    || text.includes('internal evidence gap');
}

function isAssertionContractBlocker(item) {
  const text = [
    item?.reason,
    item?.message,
    item?.resultError,
    item?.aiSummary,
    item?.aiSuggestedFix,
  ].filter(Boolean).join(' ').toLowerCase();
  return item?.reason === 'assertion_contract_defect'
    || text.includes('assertion_contract_defect')
    || text.includes('assertion contract defect');
}

function displayReason(item) {
  if (isAssertionContractBlocker(item)) return 'assertion_contract_defect';
  return isInternalEvidenceBlocker(item) ? 'internal_evidence_gap' : (item?.reason || 'unknown');
}

// Severity is a tester's-eye urgency hint surfaced by the AI analyzer +
// used server-side for sort order. We do NOT expose a dropdown on this
// page — assigning severity is a ticketing concern, not a testing one.
// Only 'high' renders a visible chip ("URGENT") so the tester knows to
// prioritise; 'normal' and 'low' stay invisible to keep the row quiet.

// AI category metadata.
const AI_CATEGORY_META = {
  dependency_failure: { label: 'Dependency failure', cls: 'bg-info-50 text-info-700 border-info-100' },
  environment:        { label: 'Environment',         cls: 'bg-ink-100 text-ink-700 border-ink-200' },
  data_unavailable:   { label: 'Data unavailable',    cls: 'bg-warn-50 text-warn-700 border-warn-200' },
  selector_drift:     { label: 'Selector drift',      cls: 'bg-warn-50 text-warn-700 border-warn-200' },
  flake:              { label: 'Flake',               cls: 'bg-info-50 text-info-700 border-info-100' },
  unknown:            { label: 'Unclassified',        cls: 'bg-ink-100 text-ink-500 border-ink-200' },
};
function aiCategoryMeta(cat) { return AI_CATEGORY_META[cat] || AI_CATEGORY_META.unknown; }

// Friendly absolute + relative timestamp.
function formatBlockedAt(iso) {
  if (!iso) return { abs: '—', rel: '' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { abs: '—', rel: '' };
  const abs = d.toLocaleString();
  const deltaMs = Date.now() - d.getTime();
  if (deltaMs < 60_000) return { abs, rel: 'just now' };
  if (deltaMs < 3_600_000) return { abs, rel: `${Math.floor(deltaMs / 60_000)}m ago` };
  if (deltaMs < 86_400_000) return { abs, rel: `${Math.floor(deltaMs / 3_600_000)}h ago` };
  return { abs, rel: `${Math.floor(deltaMs / 86_400_000)}d ago` };
}

export default function BlockedItems() {
  const { current, currentSprintId } = useProject();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { subscribe } = useRunStream();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState('latest'); // 'latest' | 'all'
  const [analyzing, setAnalyzing] = useState(false);
  const [reasonFilter, setReasonFilter] = useState(null);

  const load = useCallback(async () => {
    if (!current) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const sprintQs = currentSprintId ? `&sprintId=${encodeURIComponent(currentSprintId)}` : '';
      const blockedRes = await api.get(`/projects/${current.id}/blocked?scope=${scope}${sprintQs}`);
      setItems(blockedRes.items || []);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [current, toast, scope, currentSprintId]);

  useEffect(() => {
    load();
  }, [load]);

  // Isolation — drop the previous project's blockers the instant the active
  // project changes, so they can't linger on the new project's list during
  // the refetch window (the cross-project stale-paint class).
  useEffect(() => {
    setItems([]);
    setLoading(true);
  }, [current?.id]);

  // Live updates — when a run.result event arrives for a case that's in our
  // current list, drop the blocker if the case now passed. The server will
  // also create new BlockedItem rows for fresh failures; refetch on
  // run.complete to pick those up without spamming the API mid-run.
  //
  // Also listens for run.semantic.rescued: emitted by the conductor at the
  // end of a verifierMode='semantic_fallback' run when one or more
  // assertions were rescued. We open a modal so the user can confirm the
  // learned equivalences should be saved to Project.assertionEquivalences
  // (deterministic verifier-side memory).
  const [rescuesModal, setRescuesModal] = useState(null); // { rescues: [...] } | null
  const [rescuesSaving, setRescuesSaving] = useState(false);
  useEffect(() => {
    if (!current?.id) return;
    return subscribe((msg) => {
      // Project-scope guard — concurrent runs in other projects must not
      // mutate this page's state.
      if (msg.projectId && msg.projectId !== current.id) return;
      if (msg.type === 'result' && msg.status === 'pass' && msg.tcId) {
        setItems((prev) => prev.filter((it) => it.testCaseId !== msg.tcId));
      }
      if (msg.type === 'run.semantic.rescued' && Array.isArray(msg.rescues) && msg.rescues.length) {
        setRescuesModal({ runId: msg.runId, rescues: msg.rescues });
      }
      if (msg.type === 'run.complete' || msg.type === 'run.inplace.complete') {
        // Light refetch so new blockers and resolved ones reconcile.
        // run.inplace.complete fires for single-case reruns from Reports/BlockedItems
        // and must also trigger the reconcile so re-failures appear immediately.
        load();
      }
    });
  }, [subscribe, current?.id, load]);

  const resolve = async (item, newSelector, note) => {
    try {
      await api.post(`/projects/${current.id}/blocked/${item.id}/resolve`, {
        newSelector: newSelector || null,
        note: note || null,
      });
      setItems((all) => all.filter((x) => x.id !== item.id));
      toast.success(newSelector ? 'Resolved + locator stored in Knowledge Base.' : 'Marked resolved.');
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Could not resolve' });
    }
  };

  const skip = async (item) => {
    const ok = await confirm({
      title: 'Hide this blocker?',
      message: 'Skipping hides this blocker from the queue but keeps its history. Use this when you have decided not to fix the underlying case right now.',
      confirmLabel: 'Hide blocker',
      cancelLabel: 'Keep it visible',
      variant: 'primary',
    });
    if (!ok) return;
    try {
      await api.post(`/projects/${current.id}/blocked/${item.id}/skip`, { note: null });
      setItems((all) => all.filter((x) => x.id !== item.id));
      toast.success('Hidden from the queue. History preserved.', { title: 'Skipped' });
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Could not skip' });
    }
  };

  const remove = async (item) => {
    const ok = await confirm({
      title: 'Delete blocker record?',
      message: 'This deletes the blocker permanently — including its triage history. The underlying test case is NOT deleted. Use Skip if you only want to hide it.',
      confirmLabel: 'Delete permanently',
      cancelLabel: 'Cancel',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await api.del(`/projects/${current.id}/blocked/${item.id}`);
      setItems((all) => all.filter((x) => x.id !== item.id));
      toast.success('Removed permanently.', { title: 'Deleted' });
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Could not delete' });
    }
  };

  // Rerun: confirms with a preview of prerequisite cases the run engine
  // will auto-include (from TestCase.dependsOnIds). The server's POST
  // /blocked/:id/rerun handler handles the rest.
  const rerun = async (item) => {
    const prereqs = item.rerunWillInclude || [];
    const prereqList = prereqs.length
      ? `\n\nThe run engine will also re-execute ${prereqs.length} prerequisite case${prereqs.length === 1 ? '' : 's'} so prior state (login, cart, etc.) is rebuilt before your case retries:\nâ€¢ ${prereqs.map((p) => p.name).join('\nâ€¢ ')}`
      : '\n\nThis case is standalone — no prerequisites will be queued.';
    const ok = await confirm({
      title: 'Rerun this case?',
      message: `A fresh browser session will execute "${item.testCase?.name || 'this case'}" again. The blocker will be marked resolved; if the rerun fails, a new blocker will be created.${prereqList}`,
      confirmLabel: prereqs.length ? `Run ${prereqs.length + 1} cases` : 'Rerun case',
      cancelLabel: 'Cancel',
      variant: 'primary',
    });
    if (!ok) return;
    try {
      const res = await api.post(`/projects/${current.id}/blocked/${item.id}/rerun`, {});
      setItems((all) => all.filter((x) => x.id !== item.id));
      toast.success('Rerun queued. Open Live Pipeline to watch.', {
        title: 'Rerun started',
      });
      return res;
    } catch (err) {
      const code = err instanceof ApiError ? err.payload?.code : null;
      if (code === 'BUDGET_EXCEEDED') {
        const { title, message } = formatRunStartError(err, 'Rerun failed');
        toast.error(message, { title });
        return;
      }
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      const title = code === 'PREREQUISITE_REJECTED' ? 'Prerequisite is rejected'
                  : code === 'DEPENDENCY_CYCLE'      ? 'Dependency cycle detected'
                  : code === 'RUN_IN_PROGRESS'       ? 'A run is already streaming'
                  : 'Rerun failed';
      toast.error(msg, { title });
    }
  };

  // Per-case rerun with AI semantic verification. Used from:
  //   - failed-case rows (where deterministic assertion didn't match the
  //     SUT's wording but a human can see the page is right)
  //   - blocker rows with reason='assertion_*' where the user wants a
  //     second AI opinion instead of a literal text-match retry.
  // The endpoint flips verifierMode='semantic_fallback' for the rerun and
  // optionally appends the user's note to TestCase.userGuidance so future
  // runs see the explanation.
  const [semanticTarget, setSemanticTarget] = useState(null); // { testCaseId, name } | null
  const [semanticNote, setSemanticNote] = useState('');
  const [semanticBusy, setSemanticBusy] = useState(false);

  const launchSemanticRerun = async (testCaseId, name) => {
    setSemanticTarget({ testCaseId, name });
    setSemanticNote('');
  };

  // Save the rescued equivalences to Project.assertionEquivalences so the
  // deterministic verifier matches them on the next full-suite run without
  // needing semantic fallback again. The variant comes from the LLM's
  // reasoning when it cited the SUT's actual wording; we extract a
  // canonical/variant pair from each rescue. The user can opt out per row
  // before saving.
  const saveRescuedEquivalences = async (selectedRescues) => {
    if (!current || !selectedRescues?.length) return;
    setRescuesSaving(true);
    try {
      // Fetch the current equivalences so we MERGE rather than overwrite.
      // The PUT endpoint replaces the field wholesale.
      const existing = await api.get(`/projects/${current.id}`)
        .then((res) => {
          const raw = res?.project?.assertionEquivalences;
          if (!raw) return [];
          try { return JSON.parse(raw); } catch (_) { return []; }
        })
        .catch(() => []);
      // Coalesce by canonical.
      const byCanonical = new Map(existing.map((e) => [e.canonical, new Set(e.variants || [])]));
      for (const rescue of selectedRescues) {
        const canonical = (rescue.canonical || rescue.assertionWording || '').trim();
        const variant = (rescue.variant || '').trim();
        if (!canonical || !variant || canonical === variant) continue;
        if (!byCanonical.has(canonical)) byCanonical.set(canonical, new Set());
        byCanonical.get(canonical).add(variant);
      }
      const equivalences = Array.from(byCanonical.entries()).map(([canonical, variants]) => ({
        canonical,
        variants: Array.from(variants).filter(Boolean),
      })).filter((e) => e.variants.length > 0);

      await api.put(`/projects/${current.id}/assertion-equivalences`, { equivalences });
      toast.success(
        `Saved ${selectedRescues.length} equivalence${selectedRescues.length === 1 ? '' : 's'}. Future runs will match these deterministically — no extra LLM calls.`,
        { title: 'Project synonyms updated' }
      );
      setRescuesModal(null);
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Could not save equivalences' });
    } finally {
      setRescuesSaving(false);
    }
  };

  const submitSemanticRerun = async () => {
    if (!semanticTarget || !current) return;
    setSemanticBusy(true);
    try {
      await api.post(`/projects/${current.id}/agents/rerun-case-semantic`, {
        testCaseId: semanticTarget.testCaseId,
        note: semanticNote.trim() || null,
      });
      toast.success(
        `"${semanticTarget.name || 'Case'}" re-running with AI verification. The verifier will use semantic judgment on any deterministic miss.`,
        { title: 'Rerun queued' },
      );
      setSemanticTarget(null);
      setSemanticNote('');
      // Optimistic remove from failed list — it'll come back if the rerun
      // still fails. Refetch on run.complete via the WS subscriber covers
      // the persistent case.
      setFailedCases((all) => all.filter((c) => c.id !== semanticTarget.testCaseId));
    } catch (err) {
      const { title, message } = formatRunStartError(err, 'Could not queue rerun');
      toast.error(message, { title });
    } finally {
      setSemanticBusy(false);
    }
  };

  // Run the Blockage Analyzer over this scope's unresolved blockers.
  const analyse = async () => {
    if (!current || analyzing) return;
    setAnalyzing(true);
    try {
      const qs = scope === 'all' ? '?all=true' : '';
      const res = await api.post(`/projects/${current.id}/blocked/analyze${qs}`, {});
      await load();
      toast.success(`Analysed ${res.analyses?.length ?? 0} blocker${res.analyses?.length === 1 ? '' : 's'}.`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Re-analyse failed' });
    } finally {
      setAnalyzing(false);
    }
  };

  const reasonCounts = useMemo(() => {
    const counts = {};
    for (const it of items) {
      const reason = displayReason(it);
      counts[reason] = (counts[reason] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [items]);
  const filteredItems = useMemo(
    () => (reasonFilter ? items.filter((it) => displayReason(it) === reasonFilter) : items),
    [items, reasonFilter],
  );
  const locatorFixCount = useMemo(
    () => items.filter((it) => reasonMeta(displayReason(it)).needsLocator).length,
    [items],
  );

  if (!current) {
    return (
      <div className="relative flex flex-col h-full overflow-hidden">
        <div className="absolute inset-0 -z-10"><AuroraBackground /></div>
        <PageHeader title="Recovery Workbench" />
        <EmptyState
          icon={AlertTriangle}
          title="No project selected"
          message="Activate a project to see recovery items."
        />
      </div>
    );
  }

  const subtitleParts = [
    `${items.length} recovery item${items.length !== 1 ? 's' : ''}`,
    scope === 'latest' ? 'in latest run' : 'across all runs',
  ];

  return (
    <div className="relative flex flex-col h-full overflow-hidden">
      {/* Aurora background pinned via the sticky-100dvh trick used across
          Overview / Reports / Theater. Sits in its own absolutely-positioned
          layer so it never consumes flow space. */}
      <div
        className="pointer-events-none"
        style={{ position: 'sticky', top: 0, height: '100dvh', marginBottom: '-100dvh', zIndex: 0 }}
      >
        <AuroraBackground />
      </div>

      <div className="relative z-10">
        <PageHeader title="Recovery Workbench" subtitle={subtitleParts.join(' - ')}>
          <div className="inline-flex items-center rounded-md border border-ink-200 bg-white/80 backdrop-blur shadow-card p-0.5">
            <button
              type="button"
              onClick={() => setScope('latest')}
              className={`h-8 px-2.5 rounded text-xs font-semibold inline-flex items-center gap-1 transition-colors ${
                scope === 'latest' ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-50'
              }`}
              aria-pressed={scope === 'latest'}
            >
              Latest run
            </button>
            <button
              type="button"
              onClick={() => setScope('all')}
              className={`h-8 px-2.5 rounded text-xs font-semibold inline-flex items-center gap-1 transition-colors ${
                scope === 'all' ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-50'
              }`}
              aria-pressed={scope === 'all'}
            >
              <History className="w-3 h-3" />
              All time
            </button>
          </div>
          <Button size="sm" variant="ghost" onClick={load} title="Refresh from the server">
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </Button>
        </PageHeader>
      </div>

      <main className="relative z-10 flex-1 overflow-y-auto bg-transparent">
        <div className="max-w-5xl mx-auto px-page py-6 space-y-3">
          {loading ? (
            <div className="text-xs text-ink-500">Loading…</div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={Check}
              title={scope === 'latest' ? 'Latest run is clean' : 'Nothing needs recovery'}
              message={
                scope === 'latest'
                  ? 'No recovery items from the most recent run. Switch to "All time" to see historical items.'
                  : 'Cases that need rerun, setup review, locator repair, or environment attention show up here.'
              }
            />
          ) : (
            <>
              <BlockedTriageBrief
                items={items}
                scope={scope}
                locatorFixCount={locatorFixCount}
                reasonCounts={reasonCounts}
                onAnalyse={analyse}
                analyzing={analyzing}
              />
              {/* Root-cause distribution bar — visible when 2+ distinct reasons present. */}
              {(() => {
                if (reasonCounts.length < 2) return null;
                return (
                  <div className="glass-soft rounded-card px-4 py-3 flex flex-wrap gap-2 items-center">
                    <span className="text-2xs font-semibold uppercase tracking-wider text-ink-500 shrink-0">Root causes</span>
                    {reasonCounts.map(([reason, count]) => {
                      const meta = reasonMeta(reason);
                      const Icon = meta.icon;
                      const isActive = reasonFilter === reason;
                      return (
                        <button
                          key={reason}
                          type="button"
                          onClick={() => setReasonFilter(isActive ? null : reason)}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill text-2xs font-semibold border transition-colors ${meta.cls} ${isActive ? 'ring-2 ring-offset-1 ring-ink-400' : 'opacity-70 hover:opacity-100'}`}
                        >
                          <Icon className="w-3 h-3" aria-hidden="true" />
                          {meta.label}
                          <span className="font-mono">{count}</span>
                        </button>
                      );
                    })}
                    {reasonFilter && (
                      <button
                        type="button"
                        onClick={() => setReasonFilter(null)}
                        className="text-2xs text-ink-500 hover:text-ink-800 underline ml-1"
                      >
                        Clear filter
                      </button>
                    )}
                  </div>
                );
              })()}
              {filteredItems.map((it) => (
                <BlockedRow
                  key={it.id}
                  item={it}
                  onResolve={resolve}
                  onSkip={skip}
                  onDelete={remove}
                  onRerun={rerun}
                  onSemanticRerun={launchSemanticRerun}
                  projectId={current?.id}
                  onLocatorHealed={load}
                />
              ))}
            </>
          )}
        </div>
      </main>

      {/* Rescues modal — surfaces after a semantic-fallback run rescues
          assertions. Lets the operator confirm each learned synonym and
          save them to the project's deterministic verifier-side map. */}
      {rescuesModal && (
        <RescuesSaveModal
          rescues={rescuesModal.rescues}
          saving={rescuesSaving}
          onSave={saveRescuedEquivalences}
          onClose={() => setRescuesModal(null)}
        />
      )}

      {/* Semantic-rerun modal — operator note + confirmation. */}
      {semanticTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 backdrop-blur-sm p-4"
          onClick={(e) => { if (e.target === e.currentTarget && !semanticBusy) setSemanticTarget(null); }}
        >
          <div className="bg-white rounded-lg shadow-xl border border-ink-200 max-w-lg w-full p-5 space-y-3">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-md bg-accent-100 text-accent-700 flex items-center justify-center shrink-0">
                <Sparkles className="w-4 h-4" />
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold text-ink-900">Rerun with AI verification</div>
                <div className="text-xs text-ink-600 mt-0.5 leading-relaxed">
                  "{semanticTarget.name || 'this case'}" will re-run in a fresh browser session. When the deterministic
                  assertion check misses, the verifier will ask the AI whether the page semantically satisfies the
                  assertion's intent. Use this when you can see the page is correct but the wording differed.
                </div>
              </div>
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-500">
                Note for the AI (optional)
              </label>
              <textarea
                value={semanticNote}
                onChange={(e) => setSemanticNote(e.target.value)}
                rows={3}
                placeholder='e.g. "The confirmation copy on this SUT is &quot;Thank you for your order!&quot; — treat any confirmation-page assertion as matching that text."'
                className="w-full mt-1 px-2.5 py-2 text-sm border border-ink-200 rounded-md focus:outline-none focus:ring-2 focus:ring-accent-400"
                disabled={semanticBusy}
                maxLength={600}
              />
              <div className="text-[10px] text-ink-500 mt-1">
                Appended to this test case's user guidance for future runs.
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setSemanticTarget(null)} disabled={semanticBusy}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={submitSemanticRerun} loading={semanticBusy}>
                <Sparkles className="w-3.5 h-3.5" />
                Rerun with AI verification
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BlockedTriageBrief({ items, scope, locatorFixCount, reasonCounts, onAnalyse, analyzing }) {
  const topReason = reasonCounts[0];
  const topReasonMeta = topReason ? reasonMeta(topReason[0]) : null;
  const TopIcon = topReasonMeta?.icon || AlertTriangle;
  const scopeLabel = scope === 'latest' ? 'Latest run' : 'All runs';

  return (
    <section className="glass-soft rounded-card px-5 py-4">
      <div className="flex flex-col xl:flex-row xl:items-center gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-2xs font-bold uppercase tracking-[0.18em] text-ink-500">Recovery workbench</div>
          <h2 className="mt-1 text-base font-semibold text-ink-900">
            {items.length} item{items.length === 1 ? '' : 's'} waiting for recovery
          </h2>
          <p className="mt-1 text-sm text-ink-600 leading-relaxed max-w-3xl">
            Reports keeps the evidence trail. This page is for recovery decisions: rerun with the current engine, repair setup, supply a locator only when needed, skip, delete, or ask for AI verification when deterministic checks missed intent.
          </p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 xl:w-[520px]">
          <TriageMetric label="Scope" value={scopeLabel} />
          <TriageMetric label="Open" value={items.length} tone="warn" />
          <TriageMetric label="Locator fix" value={locatorFixCount} tone={locatorFixCount ? 'info' : 'ink'} />
          <div className="rounded-md border border-ink-200 bg-white px-3 py-2 min-w-0">
            <div className="text-2xs font-bold uppercase tracking-[0.14em] text-ink-500 truncate">Top cause</div>
            <div className="mt-1 flex items-center gap-1.5 min-w-0 text-sm font-semibold text-ink-900">
              <TopIcon className="w-3.5 h-3.5 shrink-0 text-ink-500" aria-hidden="true" />
              <span className="truncate">{topReasonMeta?.label || 'Unclassified'}</span>
              {topReason && <span className="text-ink-400 tabular-nums">({topReason[1]})</span>}
            </div>
          </div>
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          variant="secondary"
          onClick={onAnalyse}
          loading={analyzing}
          disabled={analyzing}
          title="Ask QAAI to read every open recovery item and categorise the root cause. Costs one AI call."
        >
          <Sparkles className="w-3.5 h-3.5" />
          {analyzing ? 'Re-analysing...' : 'Re-analyse recovery items'}
        </Button>
      </div>
    </section>
  );
}

function TriageMetric({ label, value, tone = 'ink' }) {
  const toneClass = {
    warn: 'text-warn-700 bg-warn-50 border-warn-100',
    info: 'text-info-700 bg-info-50 border-info-100',
    ink: 'text-ink-700 bg-white border-ink-200',
  }[tone] || 'text-ink-700 bg-white border-ink-200';
  return (
    <div className={`rounded-md border px-3 py-2 min-w-0 ${toneClass}`}>
      <div className="text-2xs font-bold uppercase tracking-[0.14em] opacity-70 truncate">{label}</div>
      <div className="mt-0.5 text-base font-semibold tabular-nums truncate">{value}</div>
    </div>
  );
}

function RescuesSaveModal({ rescues, saving, onSave, onClose }) {
  // Per rescue, let the operator edit the canonical (what the assertion
  // expected) and the variant (what the SUT actually shows). Default
  // canonical = assertion wording, default variant = excerpt the LLM
  // semantic verifier cited as evidence (often the SUT's actual copy).
  const [rows, setRows] = useState(() =>
    rescues.map((r) => {
      // Heuristic: pull a quoted phrase out of the LLM reasoning to seed
      // the variant. If we can't find one, leave variant blank and let
      // the operator type the actual SUT wording.
      const reasoning = r.semanticReasoning || '';
      const m = reasoning.match(/"([^"]{2,200})"|'([^']{2,200})'/);
      const candidateVariant = m ? (m[1] || m[2]) : '';
      return {
        key: r.assertionId,
        testCaseName: r.testCaseName,
        reasoning,
        include: true,
        canonical: r.assertionWording || '',
        variant: candidateVariant,
      };
    })
  );

  const update = (idx, patch) => setRows((all) => all.map((r, i) => i === idx ? { ...r, ...patch } : r));

  const selected = rows.filter((r) => r.include && r.canonical.trim() && r.variant.trim() && r.canonical.trim() !== r.variant.trim());

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}
    >
      <div className="bg-white rounded-lg shadow-xl border border-ink-200 max-w-2xl w-full p-5 space-y-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-md bg-success-100 text-success-700 flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-ink-900">
              AI rescued {rescues.length} assertion{rescues.length === 1 ? '' : 's'}. Save as project synonyms?
            </div>
            <div className="text-xs text-ink-600 mt-1 leading-relaxed">
              The semantic verifier matched these assertions to the page even though the deterministic substring check
              missed. Save the variant wording so the next full-suite run matches without spending another LLM call —
              and so every other case that asserts the same intent benefits too.
            </div>
          </div>
        </div>

        <div className="space-y-3">
          {rows.map((row, idx) => (
            <div key={row.key} className="border border-ink-200 rounded-md p-3 space-y-2">
              <div className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={row.include}
                  onChange={(e) => update(idx, { include: e.target.checked })}
                  className="mt-1"
                  disabled={saving}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-ink-700 truncate">
                    {row.testCaseName || '(unnamed case)'}
                  </div>
                  {row.reasoning && (
                    <div className="text-[11px] text-ink-500 mt-0.5 leading-relaxed">
                      AI reasoning: {row.reasoning}
                    </div>
                  )}
                </div>
              </div>
              {row.include && (
                <div className="grid grid-cols-2 gap-2 pl-6">
                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-ink-500">
                      Assertion wording (canonical)
                    </label>
                    <input
                      type="text"
                      value={row.canonical}
                      onChange={(e) => update(idx, { canonical: e.target.value })}
                      placeholder="What the assertion expects"
                      className="w-full mt-1 px-2 py-1.5 text-xs border border-ink-200 rounded focus:outline-none focus:ring-2 focus:ring-accent-400"
                      disabled={saving}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-ink-500">
                      SUT wording (variant)
                    </label>
                    <input
                      type="text"
                      value={row.variant}
                      onChange={(e) => update(idx, { variant: e.target.value })}
                      placeholder="What the page actually renders"
                      className="w-full mt-1 px-2 py-1.5 text-xs border border-ink-200 rounded focus:outline-none focus:ring-2 focus:ring-accent-400"
                      disabled={saving}
                    />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between pt-1 border-t border-ink-100">
          <div className="text-[11px] text-ink-500">
            {selected.length} of {rows.length} ready to save.
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
              Skip
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => onSave(selected)}
              loading={saving}
              disabled={saving || selected.length === 0}
            >
              <Check className="w-3.5 h-3.5" />
              Save {selected.length} synonym{selected.length === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// FailedRow removed — failed cases are now triaged in Reports (AI Analysis tab)

function BlockedRow({ item, onResolve, onSkip, onDelete, onRerun, onSemanticRerun, projectId, onLocatorHealed }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [selector, setSelector] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [reruning, setRerunning] = useState(false);
  const [healing, setHealing] = useState(false);
  const [healResult, setHealResult] = useState(null);

  const healFromCurrentDom = async () => {
    if (!item.kbLocator?.id || !projectId) return;
    setHealing(true);
    setHealResult(null);
    try {
      const res = await api.post(`/projects/${projectId}/knowledge-base/${item.kbLocator.id}/heal-now`, {});
      setHealResult(res);
      if (res.healed) {
        const conf = res.healed.confidence;
        if (conf >= 70) {
          toast.success(`Healed (${conf}% confidence). KB locator updated.`, { title: 'Heal succeeded' });
        } else {
          toast.info(`Healer proposal had low confidence (${conf}%). KB stayed unchanged; review below.`, { title: 'Low confidence' });
        }
      } else {
        toast.info('Healer found no replacement in the current DOM. The element may be genuinely missing.', { title: 'No proposal' });
      }
      onLocatorHealed?.();
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Heal failed' });
    } finally {
      setHealing(false);
    }
  };

  const internalEvidence = isInternalEvidenceBlocker(item);
  const assertionContract = isAssertionContractBlocker(item);
  const meta = reasonMeta(displayReason(item));
  const Icon = meta.icon;
  const isUrgent = item.severity === 'high' && !internalEvidence && !assertionContract;
  const aiMeta = item.aiCategory && !internalEvidence && !assertionContract ? aiCategoryMeta(item.aiCategory) : null;
  const timestamp = useMemo(() => formatBlockedAt(item.createdAt), [item.createdAt]);

  const copyDiagnostic = async () => {
    const lines = [
      `Test case: ${item.testCase?.name || 'Untitled'}`,
      `Reason: ${meta.label}`,
      item.lastStep ? `Stopped at step ${(item.lastStep.index ?? 0) + 1}${item.lastStep.total ? ` of ${item.lastStep.total}` : ''}: ${item.lastStep.action || ''}` : null,
      item.aiSummary ? `${internalEvidence || assertionContract ? 'Why held' : 'Why blocked'}: ${item.aiSummary}` : null,
      item.aiSuggestedFix ? `Suggested fix: ${item.aiSuggestedFix}` : null,
      item.locator ? `Failing locator: ${item.locator}` : null,
      '',
      'Diagnostic:',
      item.message || item.resultError || '(no diagnostic captured)',
    ].filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(lines);
      toast.success('Diagnostic copied. Paste it into Slack / Teams / ticket.', { title: 'Copied' });
    } catch (_) {
      toast.error('Browser refused clipboard access. Open the diagnostic and copy by hand.');
    }
  };

  const submit = async () => {
    setBusy(true);
    await onResolve(item, selector.trim() || null, note.trim() || null);
    setBusy(false);
  };

  const handleRerun = async () => {
    setRerunning(true);
    try {
      await onRerun(item);
    } finally {
      setRerunning(false);
    }
  };

  const title = item.testCase?.name || 'Untitled test case';
  const scenarioName = item.scenario?.name;
  const moduleName = item.testCase?.module;
  const shotUrl = item.screenshot ? absUrl(item.screenshot) : null;
  const canDeepLink = !!(item.runId && item.testCaseId);

  const openInReports = () => {
    if (!canDeepLink) return;
    navigate(`/reports?runId=${encodeURIComponent(item.runId)}&caseId=${encodeURIComponent(item.testCaseId)}`);
  };

  return (
    <article className="glass overflow-hidden">
      {/* Header — single visual strip: icon, reason+severity, module/scenario,
          blocked-at timestamp on the right. The title sits below as the
          primary heading + a deep-link affordance to the Reports detail pane
          for THIS exact run+case (where step trace + screenshots + AI
          analysis live). */}
      <div className="p-5">
        {internalEvidence && (
          <div className="mb-4 rounded-lg border border-info-100 bg-info-50/70 px-4 py-3 text-sm text-info-800">
            <div className="font-semibold text-info-900">This is a QAAI-side capture issue from the saved run.</div>
            <div className="mt-1 leading-relaxed">
              The website was not proven failed here. Rerun with the current engine; QAAI will continue browser actions even when evidence preparation needs repair.
            </div>
          </div>
        )}
        {assertionContract && (
          <div className="mb-4 rounded-lg border border-info-100 bg-info-50/70 px-4 py-3 text-sm text-info-800">
            <div className="font-semibold text-info-900">Assertion contract defect</div>
            <div className="mt-1 leading-relaxed">
              QAAI authored or selected an assertion that contradicts the test flow. Repair the assertion contract and rerun; do not treat this row as a website defect.
            </div>
          </div>
        )}
        <div className="flex items-start gap-3">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 border ${meta.cls}`}>
            <Icon className="w-5 h-5" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            {/* Top row: REASON · [URGENT?] · MODULE · SCENARIO · BLOCKED-AT
                We do not render a Normal/Low severity chip — that's noise
                for a tester. Only `high` surfaces as an URGENT flame so
                priority blockers stand out without implying the tester
                should be re-triaging them. */}
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <span className={`px-2 py-0.5 rounded-pill text-2xs font-bold uppercase tracking-wider border ${meta.cls}`}>
                {meta.label}
              </span>
              {isUrgent && (
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-2xs font-bold uppercase tracking-wider border bg-danger-50 text-danger-700 border-danger-200"
                  title="AI Blockage Analyzer marked this as release-critical."
                >
                  <Flame className="w-3 h-3" aria-hidden="true" />
                  Urgent
                </span>
              )}
              {moduleName && (
                <span className="text-2xs uppercase tracking-wider text-ink-500 font-semibold">
                  {moduleName}
                </span>
              )}
              {scenarioName && (
                <span className="inline-flex items-center gap-1 text-2xs text-ink-500">
                  <FolderTree className="w-3 h-3" aria-hidden="true" />
                  <span className="font-medium">{scenarioName}</span>
                </span>
              )}
              <span
                className="ml-auto inline-flex items-center gap-1.5 text-2xs text-ink-500"
                title={timestamp.abs}
              >
                <Clock className="w-3 h-3" aria-hidden="true" />
                <span className="uppercase tracking-wider font-semibold text-ink-400">{internalEvidence || assertionContract ? 'Held' : 'Blocked'}</span>
                <span className="tabular-nums">{timestamp.rel || timestamp.abs}</span>
              </span>
            </div>

            {/* Title — deep-links into Reports for this run+case when we
                have the run id. Underlined-on-hover to look interactive. */}
            <div className="flex items-baseline gap-2">
              {item.caseLabel && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-ink-100 text-ink-600 border border-ink-200 text-2xs font-bold tabular-nums shrink-0 whitespace-nowrap self-center">
                  {item.caseLabel}
                </span>
              )}
              {canDeepLink ? (
                <button
                  type="button"
                  onClick={openInReports}
                  className="text-md font-semibold text-ink-900 tracking-tight truncate text-left hover:text-info-700 hover:underline underline-offset-2 inline-flex items-center gap-1.5 max-w-full"
                  title="Open this case in Reports — full step trace, screenshots, video, AI analysis"
                >
                  <span className="truncate">{title}</span>
                  <ArrowUpRight className="w-3.5 h-3.5 shrink-0 text-ink-400" aria-hidden="true" />
                </button>
              ) : (
                <h3 className="text-md font-semibold text-ink-900 tracking-tight truncate" title={title}>
                  {title}
                </h3>
              )}
            </div>
            <p className="text-sm text-ink-600 mt-1 leading-relaxed">{meta.blurb}</p>

            {/* Step-where-it-died — pulled from RunResult.stepResults. Only
                rendered when we actually know which step the execution
                stopped on. */}
            {item.lastStep && (
              <div className="mt-2 inline-flex items-center gap-1.5 text-2xs text-ink-600 bg-ink-50 border border-ink-200 rounded-pill px-2.5 py-1">
                <CornerDownRight className="w-3 h-3 text-ink-400" aria-hidden="true" />
                <span className="font-semibold uppercase tracking-wider text-ink-500">
                  Stopped at step {(item.lastStep.index ?? 0) + 1}
                  {item.lastStep.total ? ` of ${item.lastStep.total}` : ''}
                </span>
                {item.lastStep.action && (
                  <span className="text-ink-700">· {item.lastStep.action}</span>
                )}
                {item.lastStep.status && item.lastStep.status !== 'pass' && (
                  <span className={`uppercase tracking-wider font-bold ${
                    item.lastStep.status === 'fail' ? 'text-danger-700' :
                    item.lastStep.status === 'blocked' ? 'text-warn-700' :
                    'text-ink-500'
                  }`}>
                    ({item.lastStep.status})
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* AI "Why blocked?" panel — only renders when the analyzer has
            touched this row. Shows category, narrative, optional root-cause
            link, and a suggested fix. */}
        {item.aiSummary && (
          <div className="mt-4 rounded-lg border border-accent-100 bg-accent-50/40 p-4">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="w-3.5 h-3.5 text-accent-700" aria-hidden="true" />
              <span className="text-2xs uppercase tracking-wider font-bold text-accent-700">
                {internalEvidence || assertionContract ? 'Why held?' : 'Why blocked?'}
              </span>
              {aiMeta && (
                <span className={`px-2 py-0.5 rounded-pill text-2xs font-bold uppercase tracking-wider border ${aiMeta.cls}`}>
                  {aiMeta.label}
                </span>
              )}
              {item.aiAnalyzedAt && (
                <span className="ml-auto text-2xs text-ink-400 tabular-nums">
                  Analysed {new Date(item.aiAnalyzedAt).toLocaleString()}
                </span>
              )}
            </div>
            <p className="text-sm text-ink-800 leading-relaxed">{item.aiSummary}</p>
            {item.aiRootCauseTc && (
              <div className="mt-2 inline-flex items-center gap-1 text-2xs text-info-700 bg-info-50 border border-info-100 rounded-pill px-2 py-0.5">
                <Link2 className="w-3 h-3" aria-hidden="true" />
                <span className="font-semibold">Root cause:</span>
                <span>{item.aiRootCauseTc.name || item.aiRootCauseTc.id}</span>
              </div>
            )}
            {item.aiSuggestedFix && (
              <div className="mt-2 flex items-start gap-2 text-sm text-ink-700">
                <Wrench className="w-3.5 h-3.5 text-ink-500 shrink-0 mt-0.5" aria-hidden="true" />
                <span><span className="font-semibold">Suggested fix: </span>{item.aiSuggestedFix}</span>
              </div>
            )}
            {item.aiCategory === 'selector_drift' && item.kbLocator?.id && (
              <div className="mt-3 pt-3 border-t border-accent-100 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={healFromCurrentDom}
                    disabled={healing}
                    loading={healing}
                    title="Open a fresh browser to this page and ask the AI to find the element in the live DOM"
                  >
                    {healing
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : <Wand2 className="w-3 h-3" />}
                    Heal locator from current DOM
                  </Button>
                  <span className="text-2xs text-ink-500">
                    KB health: <span className="tabular-nums font-semibold">{item.kbLocator.healthScore ?? '—'}</span>
                  </span>
                </div>
                {healResult && (
                  <div className="rounded-md border border-ink-200 bg-white p-3 text-xs space-y-1">
                    {healResult.healed ? (
                      <>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-2xs uppercase tracking-wider font-bold text-accent-700">Healer proposal</span>
                          <span className="font-mono text-2xs text-ink-600">{healResult.healed.strategy}</span>
                          <span className={`text-2xs font-bold tabular-nums ${healResult.healed.confidence >= 70 ? 'text-success-700' : 'text-warn-700'}`}>
                            {healResult.healed.confidence}% confidence
                          </span>
                        </div>
                        <div className="font-mono text-2xs text-ink-800 bg-ink-50 rounded p-2 break-all">
                          {healResult.healed.selector}
                        </div>
                        {healResult.healed.reasoning && (
                          <div className="text-2xs text-ink-600 italic">{healResult.healed.reasoning}</div>
                        )}
                        {healResult.healed.confidence >= 70 ? (
                          <div className="inline-flex items-center gap-1 text-2xs text-success-700">
                            <Check className="w-3 h-3" aria-hidden="true" />
                            KB selector updated. The next run will use this locator.
                          </div>
                        ) : (
                          <div className="text-2xs text-warn-700">
                            Low confidence — KB unchanged. Inspect the page or refine the test case before relying on this.
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="text-2xs text-ink-600 italic">
                        Healer found no matching element in the current DOM snapshot. The element may have been removed.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

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

        {/* Raw diagnostic — kept collapsed behind a SHOW toggle (per
            operator preference). The Reason blurb above already explains
            the category in plain English; this is the raw text for
            anyone who wants to dig in OR copy out to escalate. */}
        {(item.message || item.resultError) && (
          <details className="mt-3 group">
            <summary className="text-2xs font-semibold uppercase tracking-wider text-ink-500 cursor-pointer hover:text-ink-700 select-none inline-flex items-center gap-1">
              Diagnostic message
              <span className="text-ink-400 group-open:hidden">— show</span>
              <span className="text-ink-400 hidden group-open:inline">— hide</span>
            </summary>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={copyDiagnostic}
                className="inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-ink-600 hover:text-ink-900 hover:bg-ink-100 px-2 py-1 rounded transition-colors"
                title="Copy a formatted summary (case · reason · step · diagnostic) so you can paste it into Slack, Teams, or a ticket when escalating."
              >
                <CopyIcon className="w-3 h-3" aria-hidden="true" />
                Copy for escalation
              </button>
              <span className="text-2xs text-ink-400">
                {internalEvidence ? 'Developer detail. Not required for normal QA review.' : 'Includes case name, reason, step, and the raw error.'}
              </span>
            </div>
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

      {/* Action footer — Rerun is the primary recovery; Save fix (with
          replacement locator) is secondary; Skip / Delete are tertiary.
          For non-locator categories the Save-fix column collapses. */}
      <div className="px-5 py-4 bg-white/40 backdrop-blur-sm border-t border-ink-100">
        <div className="text-2xs text-ink-500 mb-3">
          <span className="font-semibold uppercase tracking-wider">Suggested action: </span>
          {meta.suggestedAction}
        </div>

        {meta.needsLocator ? (
          <div className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2 items-end">
              <Input
                label="Replacement selector (optional)"
                value={selector}
                onChange={(e) => setSelector(e.target.value)}
                placeholder='[data-testid="submit-cta"]'
                hint="Stored in the Knowledge Base so future runs use it automatically."
              />
              <Button size="md" onClick={submit} loading={busy} disabled={busy}>
                <Check className="w-3.5 h-3.5" />
                Save fix
              </Button>
            </div>
            <Input
              label="Resolve note (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What did you do to fix it? Captured for triage history."
            />
            <RowActions
              onRerun={handleRerun}
              rerunBusy={reruning}
              onSkip={() => onSkip(item)}
              onDelete={() => onDelete(item)}
              rerunWillInclude={item.rerunWillInclude}
              rerunDisabled={!item.testCaseId}
              onSemanticRerun={
                onSemanticRerun && item.testCaseId
                  ? () => onSemanticRerun(item.testCaseId, item.testCase?.name)
                  : null
              }
            />
          </div>
        ) : (
          <div className="space-y-3">
            {assertionContract && canDeepLink && (
              <Button size="md" variant="primary" onClick={openInReports}>
                <Wand2 className="w-3.5 h-3.5" />
                Repair assertion
              </Button>
            )}
            <RowActions
              onRerun={handleRerun}
              rerunBusy={reruning}
              onSkip={() => onSkip(item)}
              onDelete={() => onDelete(item)}
              rerunWillInclude={item.rerunWillInclude}
              rerunDisabled={!item.testCaseId}
              onSemanticRerun={
                onSemanticRerun && item.testCaseId
                  ? () => onSemanticRerun(item.testCaseId, item.testCase?.name)
                  : null
              }
            />
          </div>
        )}
      </div>
    </article>
  );
}

// Shared action strip. Rerun is the headline action (primary tone); Skip
// and Delete are intentionally muted so the operator doesn't reach for a
// destructive verb when they actually want to retry.
function RowActions({ onRerun, rerunBusy, onSkip, onDelete, rerunWillInclude, rerunDisabled, onSemanticRerun }) {
  const extra = rerunWillInclude?.length || 0;
  const rerunTitle = extra
    ? `Reruns this case plus ${extra} prerequisite${extra === 1 ? '' : 's'} (${rerunWillInclude.map((p) => p.name).join(', ')}) so prior state is rebuilt.`
    : 'Reruns this case in a fresh browser. No prerequisites declared.';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="md"
        variant="primary"
        onClick={onRerun}
        loading={rerunBusy}
        disabled={rerunBusy || rerunDisabled}
        title={rerunDisabled ? 'This blocker has no linked test case — cannot rerun.' : rerunTitle}
      >
        <RotateCcw className="w-3.5 h-3.5" />
        Rerun after edits
        {extra > 0 && (
          <span className="ml-1 text-2xs font-bold tabular-nums px-1.5 py-0.5 rounded-pill bg-white/20">
            +{extra}
          </span>
        )}
      </Button>
      {onSemanticRerun && (
        <Button
          size="md"
          variant="secondary"
          onClick={onSemanticRerun}
          title="Rerun with LLM-mediated assertion verification. Use this when the page is correct but the deterministic check missed due to wording differences."
        >
          <Sparkles className="w-3.5 h-3.5" />
          Rerun with AI
        </Button>
      )}
      <Button
        size="md"
        variant="secondary"
        onClick={onSkip}
        title="Hide this blocker from the queue. The history is kept so you can still find it later."
      >
        <SkipForward className="w-3.5 h-3.5" />
        Skip
      </Button>
      <Button
        size="md"
        variant="ghost"
        onClick={onDelete}
        title="Delete this blocker record permanently. The underlying test case stays."
        className="!text-danger-700 hover:!bg-danger-50"
      >
        <Trash2 className="w-3.5 h-3.5" />
        Delete
      </Button>
    </div>
  );
}
