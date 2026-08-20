import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  CheckCircle2, XCircle, AlertCircle, FileText, Image as ImageIcon, Video,
  ChevronRight, ChevronLeft, ChevronDown, ChevronUp, Clock, Activity, AlertOctagon, Camera,
  Sparkles, Bug, ExternalLink, BrainCircuit, FolderTree, ShieldAlert,
  Search, GitCompare, History, TrendingUp, X, Zap, Save, Eye, ScanSearch,
  MessagesSquare, StickyNote, Wrench, Layers, Loader2, Minus, Circle, Inbox,
  GripVertical, Code2, Trash2, StopCircle, FileCode, Wand2,
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
import Skeleton from '../components/ui/Skeleton';
import Sparkline from '../components/charts/Sparkline';
import { STATUS_META, statusMeta } from '../lib/statusMeta';
import { detectVerdictContradiction } from '../lib/verdictContradiction';
import {
  buildConductorSummary,
  buildStepContinuation,
  buildStepEvidenceRows,
  buildStepReportNarrative,
} from '../lib/reportEvidence';
import { projectExecutionJournal } from '../lib/executionJournalProjection';
import { shouldShowDataRowUi } from '../lib/dataRowPresentation';
import {
  authoredStepText,
  projectAuthoredStepRows,
  selectAuthoredPlannedSteps,
  summarizeAuthoredStepVerdict,
} from '../lib/authoredStepProjection';

const API_ORIGIN = (BASE_URL || 'http://localhost:5000/api').replace(/\/api$/, '');
const absUrl = (u) => (u?.startsWith('http') ? u : u ? API_ORIGIN + u : null);

const normaliseDataRowIndex = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : String(value);
};

const liveDataRowKey = (value) => {
  const normalized = normaliseDataRowIndex(value);
  return normalized === null ? 'case' : encodeURIComponent(String(normalized));
};

const liveStepKey = (runId, testCaseId, dataRowIndex, stepIndex) =>
  `${runId}:${testCaseId}:${liveDataRowKey(dataRowIndex)}:${stepIndex}`;

const hasDataRow = (result) =>
  normaliseDataRowIndex(result?.dataRowIndex) !== null ||
  Boolean(result?.dataRowLabel) ||
  Boolean(result?.dataSetName);

const resultMatchesMessageRow = (result, msg) =>
  result?.testCaseId === msg?.tcId &&
  normaliseDataRowIndex(result?.dataRowIndex) === normaliseDataRowIndex(msg?.dataRowIndex);

const formatDataRowLabel = (result) => {
  if (result?.dataRowLabel) return result.dataRowLabel;
  const idx = normaliseDataRowIndex(result?.dataRowIndex);
  if (idx === null) return null;
  const n = Number(idx);
  return Number.isFinite(n) ? `Row ${n + 1}` : `Row ${idx}`;
};

const REPORT_ORDER_MAX = Number.MAX_SAFE_INTEGER;

const parseCaseLabelOrder = (label) => {
  const match = String(label || '').match(/\bS(\d+)\s*(?:[^\d]+)\s*C(\d+)\b/i);
  return {
    scenario: match ? Number(match[1]) : REPORT_ORDER_MAX,
    case: match ? Number(match[2]) : REPORT_ORDER_MAX,
  };
};

const dataRowOrderValue = (result) => {
  const idx = normaliseDataRowIndex(result?.dataRowIndex);
  if (idx === null) return -1;
  const n = Number(idx);
  return Number.isFinite(n) ? n : REPORT_ORDER_MAX;
};

const dateOrderValue = (value) => {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
};

const compareReportResults = (a, b) => {
  const ao = parseCaseLabelOrder(a?.caseLabel);
  const bo = parseCaseLabelOrder(b?.caseLabel);
  return (ao.scenario - bo.scenario)
    || (ao.case - bo.case)
    || (dataRowOrderValue(a) - dataRowOrderValue(b))
    || (dateOrderValue(a?.createdAt) - dateOrderValue(b?.createdAt))
    || String(a?.id || '').localeCompare(String(b?.id || ''));
};

// ─────────────────────────────────────────────────────────────────────────────
// AuroraBackground — same design vocabulary as Overview / Run Suite / Test
// Cases. Four slow-drifting colored orbs behind a grain overlay; the main
// content layers above as frosted glass. Reduced-motion freezes the orbs.
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

// Pane id constants for the responsive tab toggle below `lg`. Two panes now
// (Tests + Detail) — the Runs column is replaced by a horizontal chip strip
// at the top of the page that's always visible.
const PANES = { TESTS: 'tests', DETAIL: 'detail' };

// Status filter chip set for the filters bar. Order is intentional so the
// chip row reads in priority order (all → fails first).
const STATUS_FILTERS = [
  { id: 'all',     label: 'All',     cls: 'bg-ink-100 text-ink-700' },
  { id: 'fail',    label: 'Failed',  cls: 'bg-danger-50 text-danger-700' },
  { id: 'blocked', label: 'Blocked', cls: 'bg-warn-50 text-warn-700' },
  { id: 'pass',    label: 'Passed',  cls: 'bg-success-50 text-success-700' },
];

const reportStatusBucket = (status) => status === 'needs_human' ? 'blocked' : status;

// 5 tabs in the detail pane — directive Fix 14 lists Steps & Trace,
// Screenshots, AI Analysis, Network, Video.
const TABS = [
  { id: 'steps',       label: 'Steps & Trace',     icon: Layers },
  { id: 'screenshots', label: 'Screenshots',       icon: Camera },
  { id: 'ai',          label: 'AI Analysis',       icon: BrainCircuit },
  // Repurposed from the never-populated "Network" tab → the per-assertion
  // verdict breakdown (what was checked, why it mattered, how it was decided).
  { id: 'verdict',     label: 'Verdict & Evidence', icon: ScanSearch },
  { id: 'video',       label: 'Video',             icon: Video },
];

export default function Reports() {
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { current, currentSprintId, currentGeneration, currentGenerationId } = useProject();
  const { claudeRateLimit, subscribe, latestSummary, latestRunId } = useRunStream();
  const [searchParams, setSearchParams] = useSearchParams();
  const [runs, setRuns] = useState([]);
  const [activeRun, setActiveRun] = useState(null);
  const [activeResult, setActiveResult] = useState(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingRun, setLoadingRun] = useState(false);
  // Per-step live status keyed by `${runId}:${tcId}:${stepIndex}` — populated
  // by step.start / step.complete WS events so the Steps & Trace tab updates
  // mid-run without a refetch.
  const [liveStepStatus, setLiveStepStatus] = useState({});

  // Filter state — persisted in `?q=` / `?status=` so a filtered view is
  // shareable and survives reloads. We read on every render rather than
  // mirroring into useState to keep URL the single source of truth.
  const runIdParam = searchParams.get('runId');
  const tabParam = searchParams.get('tab');
  const q = (searchParams.get('q') || '').toLowerCase();
  const statusFilter = searchParams.get('status') || 'all';
  const sprintFilter = searchParams.get('sprint') || '';

  // Active tab in the detail pane. URL-synced so deep links open the right
  // tab. Defaults to Steps & Trace because that's the most common entry
  // point — "what happened?" comes before "why?".
  const activeTab = TABS.some((t) => t.id === tabParam) ? tabParam : 'steps';

  // Selection state drives BOTH compare and delete from the runs strip.
  // Compare needs exactly 2 picks; delete supports any positive count.
  // The selection-toggle UI no longer caps at 2 so the user can pick a
  // wider batch for cleanup.
  const [selectedRunIds, setSelectedRunIds] = useState(() => new Set());
  const [deleting, setDeleting] = useState(false);

  // Prune selectedRunIds to ids that still exist in the current runs
  // list. Without this, ghost selections survive across:
  //   - run deletes triggered from another tab
  //   - the 50-row listRuns window dropping an older selection
  //   - the project switching to a sprint that doesn't include the run
  // and the Delete/Compare counters drift from what the user can see
  // on the strip — which is exactly what you reported.
  useEffect(() => {
    setSelectedRunIds((prev) => {
      if (prev.size === 0) return prev;
      const knownIds = new Set(runs.map((r) => r.id));
      let dirty = false;
      const next = new Set();
      for (const id of prev) {
        if (knownIds.has(id)) next.add(id);
        else dirty = true;
      }
      return dirty ? next : prev;
    });
  }, [runs]);

  // Active pane on narrow viewports (< lg).
  const [activePane, setActivePane] = useState(PANES.TESTS);

  // The report brief is always visible; the heavier run selector/filter tray
  // stays opt-in so the page opens as a report rather than a control panel.
  const [headerOpen, setHeaderOpen] = useState(false);
  useEffect(() => {
    if (!headerOpen) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') setHeaderOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [headerOpen]);

  // aria-live region for screen-reader announcement of detail-pane changes.
  const liveRef = useRef(null);

  useEffect(() => {
    if (!current) { setLoadingList(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const sprintQs = currentSprintId ? `&sprintId=${encodeURIComponent(currentSprintId)}` : '';
        const genQs = currentGenerationId ? `&generationId=${encodeURIComponent(currentGenerationId)}` : '';
        const res = await api.get(`/runs?projectId=${current.id}&limit=50${sprintQs}${genQs}`);
        if (cancelled) return;
        const list = Array.isArray(res?.runs) ? res.runs : [];
        setRuns(list);
        // If the URL carries a runId from a previous project, drop it.
        const valid = runIdParam && list.some((r) => r.id === runIdParam);
        // If the user just ran a smoke test (or any run) and the URL is still
        // pointing at an older run, auto-switch to the latest run they kicked
        // off. latestRunId is updated by both run.started and run.complete so
        // it's always the most recent run regardless of WS reconnects.
        const latestIsNewer = latestRunId && latestRunId !== runIdParam && list.some((r) => r.id === latestRunId);
        if (latestIsNewer) {
          const next = new URLSearchParams(searchParams);
          next.set('runId', latestRunId);
          setSearchParams(next, { replace: true });
        } else if (!valid) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, currentSprintId, currentGenerationId]);

  // When a run finishes (latestSummary updates), refresh the runs list so the
  // new run appears without a manual reload. The list load above only fires on
  // project/sprint change — without this, a run that completes while the user
  // is on Reports is invisible until they navigate away and back.
  useEffect(() => {
    if (!latestSummary || !current) return;
    let cancelled = false;
    const projectId = current.id;
    const completedRunId = latestRunId || null;
    const sprintQs = currentSprintId ? `&sprintId=${encodeURIComponent(currentSprintId)}` : '';
    const genQs = currentGenerationId ? `&generationId=${encodeURIComponent(currentGenerationId)}` : '';
    (async () => {
      try {
        const res = await api.get(`/runs?projectId=${projectId}&limit=50${sprintQs}${genQs}`);
        if (cancelled) return;
        const list = Array.isArray(res?.runs) ? res.runs : [];
        setRuns(list);
        // A run just completed. If it's not the run we're currently viewing,
        // auto-switch to it so the user sees the new results without manually
        // clicking the Runs panel. (Smoke runs started from Test Cases page
        // are the primary case — the user lands on Reports expecting to see
        // the smoke results, not the previous run.)
        if (completedRunId && completedRunId !== runIdParam && list.some((r) => r.id === completedRunId)) {
          setSearchParams((prev) => {
            const next = new URLSearchParams(prev);
            next.set('runId', completedRunId);
            return next;
          }, { replace: true });
        }
      } catch (_) { /* silently ignore — the user can manually refresh */ }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestSummary, current?.id, currentSprintId, currentGenerationId]);

  useEffect(() => {
    if (!runIdParam) { setActiveRun(null); setActiveResult(null); return; }
    setLoadingRun(true);
    (async () => {
      try {
        const res = await api.get(`/runs/${runIdParam}`);
        setActiveRun(res.run);
        const wanted = searchParams.get('resultId');
        const match = wanted && (res.run?.results || []).find((r) => r.id === wanted);
        setActiveResult(match || res.run?.results?.[0] || null);
        setActivePane(PANES.TESTS);
      } catch (err) {
        toast.error(err.message);
      } finally {
        setLoadingRun(false);
      }
    })();
  }, [runIdParam, toast]);

  // ── Live updates (directive Fix 15 + Global Rule 1) ─────────────────
  // Every test-case completion, every per-step verdict, and every run
  // counter recompute is broadcast over WS by the conductor. Subscribe
  // here so the page updates mid-run without a manual refresh.
  useEffect(() => {
    const unsub = subscribe((msg) => {
      // Step-level verdicts — update the live map regardless of which run
      // is currently viewed; the StepsTraceTab will only render the entries
      // that match its result id.
      if (msg.type === 'step.complete' && msg.runId && typeof msg.stepIndex === 'number') {
        const k = liveStepKey(msg.runId, msg.tcId, msg.dataRowIndex, msg.stepIndex);
        setLiveStepStatus((prev) => ({
          ...prev,
          [k]: {
            ...(prev[k] || {}),
            status: msg.status,
            error: msg.error,
            reason: msg.reason || prev[k]?.reason || null,
            evidence: msg.evidence || prev[k]?.evidence || null,
            durationMs: msg.durationMs,
            assertion: msg.assertion || prev[k]?.assertion || null,
            operationCheck: msg.operationCheck || prev[k]?.operationCheck || null,
            actionOutcome: msg.actionOutcome || prev[k]?.actionOutcome,
            assertions: msg.assertions || prev[k]?.assertions,
            assertionOutcome: msg.assertionOutcome || prev[k]?.assertionOutcome,
            continuationOutcome: msg.continuationOutcome || prev[k]?.continuationOutcome,
            continuationReason: msg.continuationReason || prev[k]?.continuationReason,
            expectedState: msg.expectedState ?? prev[k]?.expectedState,
            observedState: msg.observedState ?? prev[k]?.observedState,
            executionError: msg.executionError ?? prev[k]?.executionError,
            failureType: msg.failureType || prev[k]?.failureType,
          },
        }));
      }
      if (msg.type === 'step.start' && msg.runId && typeof msg.stepIndex === 'number') {
        const k = liveStepKey(msg.runId, msg.tcId, msg.dataRowIndex, msg.stepIndex);
        setLiveStepStatus((prev) => prev[k]
          ? prev
          : { ...prev, [k]: { status: 'running' } });
      }
      if (msg.type === 'step.assertion' && msg.runId && typeof msg.stepIndex === 'number') {
        const k = liveStepKey(msg.runId, msg.tcId, msg.dataRowIndex, msg.stepIndex);
        const assertion = {
          status: msg.status,
          expected: msg.expected,
          matched: msg.matched,
          checked: msg.checked === true,
          reason: msg.reason || null,
          evidence: msg.evidence || null,
          channel: msg.channel || null,
          synthetic: msg.synthetic === true,
        };
        setLiveStepStatus((prev) => ({
          ...prev,
          [k]: {
            ...(prev[k] || { status: 'running' }),
            status: msg.status === 'fail' ? 'fail' : (prev[k]?.status || 'running'),
            error: msg.status === 'fail' ? (msg.reason || msg.evidence || prev[k]?.error || null) : prev[k]?.error || null,
            assertion,
          },
        }));
      }
      if (msg.type === 'step.operationCheck' && msg.runId && typeof msg.stepIndex === 'number') {
        const k = liveStepKey(msg.runId, msg.tcId, msg.dataRowIndex, msg.stepIndex);
        const operationCheck = {
          status: msg.status,
          expected: msg.expected,
          matched: msg.matched,
          checked: msg.checked === true,
          reason: msg.reason || null,
          evidence: msg.evidence || null,
          channel: msg.channel || null,
          kind: msg.kind || null,
          target: msg.target || null,
          required: msg.required === true,
          synthetic: msg.synthetic === true,
        };
        setLiveStepStatus((prev) => ({
          ...prev,
          [k]: {
            ...(prev[k] || { status: 'running' }),
            status: (msg.status === 'fail' || msg.status === 'blocked') ? 'blocked' : (prev[k]?.status || 'running'),
            error: (msg.status === 'fail' || msg.status === 'blocked') ? (msg.reason || msg.evidence || prev[k]?.error || null) : prev[k]?.error || null,
            operationCheck,
          },
        }));
      }

      // A new run just started — fetch it immediately so it appears in the
      // sidebar list and becomes the active run without waiting for completion.
      if (msg.type === 'run.started' && msg.runId) {
        api.get(`/runs/${msg.runId}`).then((res) => {
          if (!res.run) return;
          setRuns((prev) => {
            if (prev.some((r) => r.id === res.run.id)) return prev;
            return [res.run, ...prev];
          });
          setActiveRun(res.run);
          setSearchParams((prev) => {
            const next = new URLSearchParams(prev);
            next.set('runId', res.run.id);
            return next;
          }, { replace: true });
        }).catch(() => {});
      }

      // Only the active run's events drive the run-level updates below.
      if (!activeRun?.id || msg.runId !== activeRun.id) return;

      // A test case just finished — update the matching result row in
      // place. If the user is viewing that exact result, replace
      // activeResult too so the detail pane refreshes mid-run.
      if (msg.type === 'result') {
        setActiveRun((prev) => {
          if (!prev || prev.id !== msg.runId) return prev;
          let found = false;
          const updated = (prev.results || []).map((r) => {
            if (resultMatchesMessageRow(r, msg)) {
              found = true;
              return {
                ...r,
                status: msg.status,
                error: msg.error,
                durationMs: msg.durationMs,
                blockedReason: msg.blockedReason ?? r.blockedReason,
                stepResults: msg.stepResults ?? r.stepResults,
                journalSummary: msg.journalSummary ?? r.journalSummary,
              };
            }
            return r;
          });
          // Round B live display: results are created server-side as each case
          // completes (not pre-seeded). If no match, synthesize a minimal entry
          // so the row appears immediately. run.complete refetch will overlay
          // this with the full DB row (testCase populated, caseLabel, etc.).
          if (!found && msg.resultId) {
            updated.push({
              id: msg.resultId,
              runId: msg.runId,
              testCaseId: msg.tcId,
              dataRowIndex: msg.dataRowIndex ?? null,
              dataRowLabel: msg.dataRowLabel ?? null,
              dataSetName: msg.dataSetName ?? null,
              status: msg.status,
              error: msg.error || null,
              durationMs: msg.durationMs || null,
              blockedReason: msg.blockedReason || null,
              stepResults: msg.stepResults || [],
              journalSummary: msg.journalSummary || null,
              caseLabel: null,
              testCase: msg.tcName
                ? { name: msg.tcName, module: null, type: null, scenario: msg.scenarioName ? { name: msg.scenarioName } : null, declaredAssertions: [] }
                : null,
              screenshots: [],
              networkLog: [],
              domSnapshots: [],
              assertionCheckResults: [],
            });
          }
          return { ...prev, results: updated };
        });
        setActiveResult((cur) => {
          if (!cur || !resultMatchesMessageRow(cur, msg)) return cur;
          return {
            ...cur,
            status: msg.status,
            error: msg.error,
            durationMs: msg.durationMs,
            blockedReason: msg.blockedReason ?? cur.blockedReason,
            stepResults: msg.stepResults ?? cur.stepResults,
            journalSummary: msg.journalSummary ?? cur.journalSummary,
          };
        });
      }

      // Counters tick up live so the chip-strip totals don't lag.
      if (msg.type === 'run.counters') {
        setActiveRun((prev) => {
          if (!prev || prev.id !== msg.runId) return prev;
          return { ...prev, passed: msg.passed, failed: msg.failed, blocked: msg.blocked, skipped: msg.skipped };
        });
        setRuns((prev) => prev.map((r) => r.id === msg.runId
          ? { ...r, passed: msg.passed, failed: msg.failed, blocked: msg.blocked, skipped: msg.skipped }
          : r));
      }

      // When a run finishes, refetch it once so we pick up stepResults
      // JSON + final trace strings the conductor persisted at completion.
      // run.inplace.complete fires for single-case reruns; the conductor writes
      // new stepResults, screenshots, and trace for the re-executed case —
      // without this refetch the detail pane keeps showing the old failure data
      // even after the status chip flips to "pass".
      if (msg.type === 'run.complete' || msg.type === 'run.inplace.complete') {
        api.get(`/runs/${msg.runId}`).then((res) => {
          setActiveRun((prev) => prev?.id === msg.runId ? res.run : prev);
          setActiveResult((cur) => {
            if (!cur) return cur;
            const fresh = (res.run?.results || []).find((r) => r.id === cur.id);
            return fresh || cur;
          });
        }).catch(() => { /* tolerated; next user action will refetch */ });
      }
    });
    return unsub;
  }, [subscribe, activeRun?.id]);

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
    const totalFromResults = Array.isArray(activeRun.results) ? activeRun.results.length : 0;
    const totalFromCounters =
      (activeRun.passed || 0) +
      (activeRun.failed || 0) +
      (activeRun.blocked || 0) +
      (activeRun.skipped || 0);
    const total = totalFromResults || totalFromCounters;
    const denominator = (activeRun.passed || 0) + (activeRun.failed || 0) + (activeRun.blocked || 0);
    return {
      total,
      attention: (activeRun.failed || 0) + (activeRun.blocked || 0),
      passRate: denominator ? Math.round(((activeRun.passed || 0) / denominator) * 100) : 0,
      duration: activeRun.completedAt
        ? Math.round((new Date(activeRun.completedAt) - new Date(activeRun.startedAt)) / 1000)
        : null,
    };
  }, [activeRun]);

  // Filtered run list — search matches against any scenario name, sprint
  // name, or module label on the run card.
  const visibleRuns = useMemo(() => {
    let list = runs;
    if (sprintFilter) list = list.filter((r) => r.sprintName === sprintFilter);
    if (!q) return list;
    return list.filter((r) => {
      const hay = [
        r.sprintName,
        ...(Array.isArray(r.scenarios) ? r.scenarios.flatMap((s) => [s.name, s.module]) : []),
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [runs, q, sprintFilter]);

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

  const visibleResults = useMemo(() => {
    const all = activeRun?.results || [];
    return all.filter((r) => {
      if (statusFilter !== 'all' && reportStatusBucket(r.status) !== statusFilter) return false;
      if (!q) return true;
      const tc = r.testCase;
      const hay = [tc?.name, tc?.module, tc?.scenario?.name].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [activeRun, q, statusFilter]);

  const activeRunInternalHeld = useMemo(
    () => (activeRun?.results || []).filter(isInternalEvidenceResult).length,
    [activeRun]
  );
  const activeRunAllBlockedInternal = (activeRun?.blocked || 0) > 0
    && activeRunInternalHeld >= (activeRun?.blocked || 0);

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
      blocked: searchFiltered.filter((r) => reportStatusBucket(r.status) === 'blocked').length,
      pass:    searchFiltered.filter((r) => r.status === 'pass').length,
    };
  }, [activeRun, q]);

  const failsMissingRca = useMemo(() => {
    if (!activeRun) return 0;
    return (activeRun.results || []).filter(
      (r) => r.status === 'fail' && !r.rcaWhat
    ).length;
  }, [activeRun]);

  // Only ids that are currently in the loaded runs list count as a
  // valid selection. This guards every count + button-visibility
  // decision against a 1-frame window between a runs update and the
  // pruning effect, and against any future code path that adds an id
  // we haven't loaded yet. The Delete / Compare buttons NEVER show
  // unless at least one currently-displayed chip's checkbox is ticked.
  const validSelectedIds = useMemo(() => {
    if (selectedRunIds.size === 0) return [];
    const known = new Set(runs.map((r) => r.id));
    const out = [];
    for (const id of selectedRunIds) if (known.has(id)) out.push(id);
    return out;
  }, [selectedRunIds, runs]);
  const validSelectedCount = validSelectedIds.length;
  const [analyzing, setAnalyzing] = useState(false);

  const handleAnalyze = useCallback(async () => {
    if (!activeRun) return;
    setAnalyzing(true);
    try {
      const res = await api.post(`/runs/${activeRun.id}/analyze`, {});
      toast.success(`Reporter analysed ${res.analyzed} failure${res.analyzed === 1 ? '' : 's'}.`, { title: 'Root cause ready' });
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
    next.delete('resultId');
    setSearchParams(next, { replace: true });
    setHeaderOpen(false);
  };
  const pickResult = (r) => {
    setActiveResult(r);
    setActivePane(PANES.DETAIL);
    const next = new URLSearchParams(searchParams);
    if (r?.id) next.set('resultId', r.id);
    else next.delete('resultId');
    setSearchParams(next, { replace: true });
  };
  const pickTab = (tabId) => {
    const next = new URLSearchParams(searchParams);
    if (tabId === 'steps') next.delete('tab');
    else next.set('tab', tabId);
    setSearchParams(next, { replace: true });
  };

  const toggleRunSelection = (runId) => {
    setSelectedRunIds((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };
  const launchCompare = () => {
    if (validSelectedCount !== 2) return;
    const [a, b] = validSelectedIds;
    navigate(`/reports/compare?a=${a}&b=${b}`);
  };

  // Bulk delete the selected runs. Confirms with the user first because
  // this is destructive (RunResults cascade away with the parent Run).
  // Operates only on valid (currently loaded) ids so a stale selection
  // can never mass-delete something the user didn't actually pick.
  const handleDeleteSelected = useCallback(async () => {
    const ids = validSelectedIds.slice();
    if (!ids.length || deleting) return;
    const ok = await confirm({
      title: ids.length === 1 ? 'Delete this run?' : `Delete ${ids.length} runs?`,
      message: `This permanently removes the run${ids.length === 1 ? '' : 's'} from Reports along with every test result, screenshot, and trace attached. Any blocked items or generated scripts already filed will keep their history but lose their run reference.`,
      confirmLabel: ids.length === 1 ? 'Delete run' : `Delete ${ids.length} runs`,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      const results = await Promise.allSettled(ids.map((id) => api.del(`/runs/${id}`)));
      const failures = results
        .map((r, i) => ({ r, id: ids[i] }))
        .filter(({ r }) => r.status === 'rejected');
      const succeededIds = new Set(
        results.map((r, i) => (r.status === 'fulfilled' ? ids[i] : null)).filter(Boolean),
      );
      // Drop deleted runs from the list + selection. If the currently
      // active run was among them, clear it and let the user pick again
      // from whatever survived.
      setRuns((prev) => prev.filter((r) => !succeededIds.has(r.id)));
      setSelectedRunIds((prev) => {
        const next = new Set(prev);
        for (const id of succeededIds) next.delete(id);
        return next;
      });
      if (runIdParam && succeededIds.has(runIdParam)) {
        const remaining = runs.filter((r) => !succeededIds.has(r.id));
        const nextParams = new URLSearchParams(searchParams);
        if (remaining[0]?.id) nextParams.set('runId', remaining[0].id);
        else nextParams.delete('runId');
        nextParams.delete('resultId');
        setSearchParams(nextParams, { replace: true });
      }
      if (succeededIds.size > 0) {
        toast.success(
          `Deleted ${succeededIds.size} run${succeededIds.size === 1 ? '' : 's'}.`,
          { title: 'Runs removed' },
        );
      }
      if (failures.length) {
        const first = failures[0].r.reason;
        const msg = first instanceof ApiError
          ? (first.payload?.message || first.message)
          : first?.message || 'Unknown error';
        toast.error(
          failures.length === 1
            ? msg
            : `${failures.length} run${failures.length === 1 ? '' : 's'} could not be deleted. First error: ${msg}`,
          { title: 'Could not delete' },
        );
      }
    } finally {
      setDeleting(false);
    }
  }, [validSelectedIds, deleting, confirm, runIdParam, runs, searchParams, setSearchParams, toast]);

  if (!current) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Reports" />
        <EmptyState illustration="reports" title="No project selected" message="Activate a project to see reports." />
      </div>
    );
  }

  const headerDuration = summary?.duration != null
    ? formatDurationLabel(summary.duration)
    : (activeRun?.status === 'running' ? 'live now' : null);
  const headerStatus = activeRun?.status === 'running' ? 'In progress' : activeRun ? 'Completed' : 'No run selected';
  const headerStatusClass = activeRun?.status === 'running'
    ? 'border-info-200 bg-info-50 text-info-700'
    : activeRun
      ? 'border-success-200 bg-success-50 text-success-700'
      : 'border-ink-200 bg-white/70 text-ink-600';
  const headerUpdatedLabel = activeRun && runUpdatedAfterStart(activeRun)
    ? `updated ${formatRunDate(runActivityDate(activeRun))}`
    : null;
  const reportHeaderSubtitle = activeRun
    ? ['Agent run', formatRunDate(activeRun.startedAt), headerUpdatedLabel, headerDuration].filter(Boolean).join(' · ')
    : 'Pick a run to inspect results';

  return (
    <div className="relative flex flex-col h-full overflow-hidden">
      {/* Aurora orbs sit behind everything via z-index. Pointer-events
          none so they never intercept clicks. Sticky positioning trick
          (height: 100dvh, marginBottom: -100dvh) lets the aurora fill
          the viewport without consuming flow space — same pattern as
          Overview / Run Suite. Real content below is z-10 to layer
          above. */}
      <div
        className="sticky top-0 overflow-hidden pointer-events-none"
        style={{ height: '100dvh', marginBottom: '-100dvh', zIndex: 0 }}
        aria-hidden="true"
      >
        <AuroraBackground />
      </div>
      {/* Top chrome — PageHeader + RunChipStrip + FilterBar layered
          above the aurora. The wrapper carries a glass backdrop so the
          colored orbs subtly tint the chrome without losing legibility. */}
      <PageHeader
        title="Reports"
        subtitle={reportHeaderSubtitle}
      >
        {activeRun && (
          <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-[22px] border border-white/70 bg-[linear-gradient(135deg,rgba(236,253,245,0.74),rgba(255,255,255,0.82)_44%,rgba(239,246,255,0.72)_100%)] px-2.5 py-2 shadow-[0_18px_40px_-30px_rgba(15,23,42,0.44),0_1px_0_rgba(255,255,255,0.9)_inset] backdrop-blur-xl">
            <span className={`inline-flex h-8 items-center rounded-full border px-3 text-xs font-bold uppercase tracking-[0.12em] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm ${headerStatusClass}`}>
              {headerStatus}
            </span>
            <ReportMetric label="Pass" value={`${summary?.passRate ?? 0}%`} tone="success" />
            <ReportMetric label="OK" value={activeRun.passed || 0} tone="success" />
            <ReportMetric label="Fail" value={activeRun.failed || 0} tone="danger" />
            {(activeRun.needsHuman || 0) > 0 && (
              // "Not judged" — QAAI could not verify (needs_human). Shown SEPARATELY
              // from Fail so a not-judged row never reads as a confirmed product failure.
              <ReportMetric label="Not judged" value={activeRun.needsHuman || 0} tone="accent" />
            )}
            <ReportMetric label={activeRunAllBlockedInternal ? 'QAAI held' : 'Blocked'} value={activeRun.blocked || 0} tone={activeRunAllBlockedInternal ? 'accent' : 'warn'} />
            <ReportMetric label="Time" value={headerDuration || '-'} tone="ink" />
          </div>
        )}
        <ClaudeRateLimitChip info={claudeRateLimit} aiProvider={current?.aiProvider} />
        {validSelectedCount >= 1 && (
          <Button
            size="sm"
            variant="danger"
            onClick={handleDeleteSelected}
            loading={deleting}
            disabled={deleting}
            title="Permanently remove the selected runs and their results"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete {validSelectedCount} run{validSelectedCount === 1 ? '' : 's'}
          </Button>
        )}
        {validSelectedCount === 2 && (
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
        <button
          type="button"
          onClick={() => setHeaderOpen((v) => !v)}
          title="Open run selector and filters"
          className="inline-flex items-center gap-1.5 px-3 h-8 rounded-pill text-2xs font-semibold uppercase tracking-wider border border-ink-200 bg-white/60 text-ink-600 hover:border-ink-400 hover:bg-white transition-all shrink-0"
        >
          {headerOpen
            ? <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
            : <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />}
          Runs
        </button>
      </PageHeader>

      {activeRun?.scriptValidation && (
        <RunScriptValidationSummary report={activeRun.scriptValidation} />
      )}

      {/* Collapsible header cards — RunChipStrip + filters bar together.
          Auto-collapses after 1s on mount (peek effect). "Show runs /
          Collapse" button in PageHeader drives headerOpen. The max-height
          transition slides them up/down smoothly. */}
      {headerOpen && (
      <div
        data-no-print="true"
        className="fixed inset-0 z-50 bg-ink-900/25 backdrop-blur-sm p-4 sm:p-6"
        onClick={() => setHeaderOpen(false)}
      >
        <section
          className="ml-auto flex h-full max-w-5xl flex-col overflow-hidden rounded-card border border-white/60 bg-white shadow-xl"
          aria-label="Run selector and filters"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between gap-3 border-b border-ink-100 px-4 py-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink-900">Runs and filters</h2>
              <p className="text-xs text-ink-500 truncate">Choose a run, compare selected runs, delete old evidence, or narrow the visible test list.</p>
            </div>
            <button
              type="button"
              onClick={() => setHeaderOpen(false)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-ink-200 text-ink-500 hover:bg-ink-50 hover:text-ink-900"
              aria-label="Close run controls"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Run chip strip — horizontal, scannable */}
        <RunChipStrip
          runs={visibleRuns}
          totalRuns={runs.length}
          loading={loadingList}
          activeRunId={runIdParam}
          selectedRunIds={selectedRunIds}
          onPick={pickRun}
          onToggleSelect={toggleRunSelection}
          searchActive={!!q || !!sprintFilter}
          generationLabel={currentGeneration ? `v${currentGeneration.version}${currentGeneration.label ? ` - ${currentGeneration.label}` : ''}` : null}
        />

        {/* Filters bar — search + status chips + sprint filter */}
        <div className="relative z-10 border-b border-white/40 bg-white/70 backdrop-blur-md px-page py-2.5 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 max-w-md min-w-[200px]">
            <Search className="w-3.5 h-3.5 text-ink-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
            <input
              type="search"
              value={searchParams.get('q') || ''}
              onChange={(e) => updateParam('q', e.target.value)}
              placeholder="Search tests, scenarios, runs…"
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
          {validSelectedCount > 0 && (
            <div className="ml-auto inline-flex items-center gap-2 text-2xs text-ink-600">
              <span className="font-semibold uppercase tracking-wider">
                {validSelectedCount} run{validSelectedCount === 1 ? '' : 's'} selected
                {validSelectedCount === 2 && <span className="ml-1 normal-case tracking-normal text-ink-500">· ready to compare</span>}
              </span>
              <button
                onClick={() => setSelectedRunIds(new Set())}
                className="text-ink-500 hover:text-ink-900 underline"
              >
                clear
              </button>
            </div>
          )}
        </div>
          </div>
        </section>
      </div>
      )}

      {/* Mobile / narrow-viewport pane toggle. Two panes now (no Runs
          column). Hidden at `lg+` where the columns render side by side. */}
      <div data-no-print="true" className="relative z-10 lg:hidden border-b border-white/40 bg-white/70 backdrop-blur-md flex" role="tablist" aria-label="Reports panes">
        {[
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

      <div ref={liveRef} aria-live="polite" aria-atomic="true" className="sr-only" />

      {/* Main 2-column layout: Test list + draggable splitter + Detail.
          Transparent background so the AuroraBackground bleeds through;
          the columns themselves carry their own surface treatment. */}
      <ResizableSplit className="flex-1 overflow-hidden bg-transparent relative z-10" activePane={activePane}>
        {/* ── Test list ── Glass-soft surface so the aurora is visible
            behind it. Border-r kept as a hairline divider; the glass's
            translucent fill lets the colored orbs subtly tint the column. */}
        <aside
          className={`bg-white/70 backdrop-blur-md border-r border-white/40 overflow-y-auto h-full ${
            activePane === PANES.TESTS ? 'block' : 'hidden lg:block'
          }`}
          aria-label="Test results"
        >
          <div className="bg-white border-b border-ink-200 px-5 py-4">
            <h2 className="font-display text-xl text-ink-900 leading-tight">Test cases</h2>
            {activeRun && (
              <>
                <div className="text-xs text-ink-500 mt-0.5 tabular-nums">
                  {q
                    ? <>{visibleResults.length} of {activeRun.results?.length || 0} shown</>
                    : (
                      <>
                        {activeRun.results?.length || 0} total · {activeRun.passed} passed · {activeRun.failed} failed ·{' '}
                        {activeRunAllBlockedInternal
                          ? `${activeRun.blocked} held by QAAI`
                          : `${activeRun.blocked} blocked`}
                      </>
                    )
                  }
                </div>
                {/* Cancellation banner — shown whenever the run did NOT
                    reach a clean 'completed' terminal state. Covers both
                    user-initiated cancel ('cancelled') and a run that was
                    aborted / timed out mid-flight ('stopped', 'failed').
                    The counters above reflect only what completed; this
                    banner explains why the numbers may not add up to the
                    full approved case count. */}
                {(activeRun.status === 'cancelled' || activeRun.status === 'stopped' || activeRun.status === 'failed') && (
                  <div className="mt-3 rounded-md border border-warn-200 bg-warn-50 px-3 py-2 flex items-start gap-2">
                    <StopCircle className="w-4 h-4 text-warn-700 shrink-0 mt-0.5" aria-hidden="true" />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-warn-800">Run cancelled mid-flight</div>
                      <div className="text-2xs text-warn-700 mt-0.5">
                        {activeRun.results?.length
                          ? `${activeRun.results.length} case${activeRun.results.length === 1 ? '' : 's'} completed before the stop signal. Remaining approved cases were not executed.`
                          : 'No cases completed before the stop signal.'}
                      </div>
                    </div>
                  </div>
                )}
                <div className="mt-2.5">
                  <Bar
                    passed={activeRun.passed}
                    failed={activeRun.failed}
                    blocked={activeRun.blocked}
                    skipped={activeRun.skipped}
                  />
                </div>
              </>
            )}
          </div>
          {loadingRun ? (
            <TestListSkeleton />
          ) : !activeRun ? (
            <div className="p-8 text-center text-sm text-ink-500">
              <Inbox className="w-8 h-8 text-ink-300 mx-auto mb-2" aria-hidden="true" />
              Pick a run from the strip above to see its tests.
            </div>
          ) : !activeRun.results?.length ? (
            <div className="p-8 text-center text-sm text-ink-500">No results in this run yet.</div>
          ) : visibleResults.length === 0 ? (
            <div className="p-8 text-center text-sm text-ink-500">
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

        {/* ── Detail pane ── Transparent column; cards inside provide
            their own glass surfaces so the aurora reads through the
            gaps between sections. */}
        <section
          className={`overflow-y-auto bg-transparent h-full ${
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
              message="Pick a test case from the left to see its steps, screenshots, AI analysis, network, and video."
            />
          ) : (
            <DetailPane
              result={activeResult}
              testCase={activeResult.testCase}
              dataRowCount={(activeRun.results || []).filter((candidate) => (
                candidate.testCaseId === activeResult.testCaseId && hasDataRow(candidate)
              )).length}
              projectId={activeRun.projectId}
              runId={activeRun.id}
              activeTab={activeTab}
              onPickTab={pickTab}
              liveStepStatus={liveStepStatus}
              onAssertionRemoved={(assertionId) => {
                setActiveResult((prev) => {
                  if (!prev?.testCase?.declaredAssertions) return prev;
                  const updated = Array.isArray(prev.testCase.declaredAssertions)
                    ? prev.testCase.declaredAssertions.filter((a) => a?.id !== assertionId)
                    : prev.testCase.declaredAssertions;
                  return { ...prev, testCase: { ...prev.testCase, declaredAssertions: updated } };
                });
              }}
              onAssertionRepaired={(assertionId, repairedAssertion) => {
                setActiveResult((prev) => {
                  if (!prev?.testCase?.declaredAssertions || !repairedAssertion) return prev;
                  const updated = Array.isArray(prev.testCase.declaredAssertions)
                    ? prev.testCase.declaredAssertions.map((a) => (a?.id === assertionId ? repairedAssertion : a))
                    : prev.testCase.declaredAssertions;
                  return { ...prev, testCase: { ...prev.testCase, declaredAssertions: updated } };
                });
              }}
            />
          )}
        </section>
      </ResizableSplit>
    </div>
  );
}

// ── ResizableSplit ──────────────────────────────────────────────────
// Two-pane horizontal layout with a draggable divider. Left-pane width
// is a percentage of the container (clamped to [240px, 65%]). State
// persists to localStorage so the user's preferred ratio survives
// reloads. Below the `lg` breakpoint the children stack vertically and
// the splitter is hidden — the page-level pane toggle controls which
// is visible there.
function ExportPreflightPanelLegacy({ preflight, onPickCase }) {
  if (!preflight || !preflight.total) return null;
  const held = Number(preflight.held || 0);
  const exportable = Number(preflight.exportable || 0);
  const total = Number(preflight.total || 0);
  const blockedCases = Array.isArray(preflight.blockedCases) ? preflight.blockedCases : [];
  const reasonSummary = Object.entries(preflight.reasonCounts || {})
    .filter(([, count]) => Number(count) > 0)
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(' · ');

  if (held <= 0) {
    return (
      <div className="mt-3 rounded-md border border-success-200 bg-success-50 px-3 py-2 flex items-start gap-2">
        <CheckCircle2 className="w-4 h-4 text-success-700 shrink-0 mt-0.5" aria-hidden="true" />
        <div className="min-w-0">
          <div className="text-xs font-semibold text-success-800">Output files ready</div>
          <div className="text-2xs text-success-700 mt-0.5">
            {exportable}/{total} cases have complete ReplayIR and element targeting data for Output Files.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-md border border-warn-200 bg-warn-50 px-3 py-2">
      <div className="flex items-start gap-2">
        <ShieldAlert className="w-4 h-4 text-warn-700 shrink-0 mt-0.5" aria-hidden="true" />
        <div className="min-w-0">
          <div className="text-xs font-semibold text-warn-800">Output files are still preparing</div>
          <div className="text-2xs text-warn-700 mt-0.5">
            {exportable}/{total} cases are exportable. {held} need QAAI to complete internal replay evidence before download. These are not confirmed website failures.
          </div>
          {reasonSummary && (
            <div className="text-2xs text-warn-800 mt-1 break-words">
              Evidence groups: {reasonSummary}
            </div>
          )}
        </div>
      </div>
      <div className="mt-2 space-y-1.5">
        {blockedCases.slice(0, 3).map((item) => (
          <button
            type="button"
            key={item.runResultId || item.testCaseId || item.caseName}
            onClick={() => onPickCase?.(item.runResultId)}
            className="w-full rounded-md border border-warn-200 bg-white/80 px-2 py-1.5 text-left hover:bg-white"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-xs font-semibold text-ink-800">{item.caseName}</span>
              <span className="shrink-0 text-2xs font-bold uppercase tracking-[0.12em] text-warn-700">Open</span>
            </div>
            <div className="mt-0.5 text-2xs text-warn-800 break-words">
              {item.reason}: {item.message}
            </div>
          </button>
        ))}
        {blockedCases.length > 3 && (
          <div className="text-2xs text-warn-700">
            {blockedCases.length - 3} more held case{blockedCases.length - 3 === 1 ? '' : 's'} in this run.
          </div>
        )}
      </div>
    </div>
  );
}

function ExportPreflightPanel({ preflight, onPickCase }) {
  if (!preflight || !preflight.total) return null;
  const held = Number(preflight.held || 0);
  if (held <= 0) return null;

  const exportable = Number(preflight.exportable || 0);
  const total = Number(preflight.total || 0);
  const blockedCases = Array.isArray(preflight.blockedCases) ? preflight.blockedCases : [];
  const friendlyReason = (reason) => ({
    locator_unrecoverable: 'Element targeting needs recapture',
    missing_locator_evidence: 'Element targeting needs recapture',
    missing_assertion_outcome: 'Assertion recording needs repair',
    assertion_cardinality_gap: 'Assertion coverage needs review',
    replay_ir_incomplete: 'Replay evidence is incomplete',
    codegen_validation_failed: 'Generated package validation failed',
  }[String(reason || '').toLowerCase()] || String(reason || 'Evidence repair needed').replace(/_/g, ' '));
  const friendlyMessage = (item) => {
    const reason = String(item?.reason || '').toLowerCase();
    const message = String(item?.message || '');
    const quoted = message.match(/"([^"]+)"/)?.[1];
    if (reason.includes('locator')) {
      return quoted
        ? `QAAI needs to recapture the exact element target for "${quoted}" before this case can be exported.`
        : 'QAAI needs to recapture the exact element target before this case can be exported.';
    }
    if (reason.includes('assertion')) {
      return 'QAAI needs complete recorded assertion evidence before this case can be exported.';
    }
    return message
      .replace(/^LOCATOR_UNRECOVERABLE:\s*/i, '')
      .replace(/^QAAI_[A-Z_]+:\s*/i, '')
      .replace(/_/g, ' ')
      || 'QAAI needs to finish its internal replay evidence before this case can be exported.';
  };
  const reasonSummary = Object.entries(preflight.reasonCounts || {})
    .filter(([, count]) => Number(count) > 0)
    .map(([reason, count]) => `${friendlyReason(reason)}: ${count}`)
    .join(' · ');

  return (
    <div className="mt-2 rounded-md border border-warn-200 bg-warn-50/75 px-3 py-2" aria-label="Output preparing">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn-700" aria-hidden="true" />
          <div className="min-w-0">
            <div className="text-xs font-semibold text-warn-900">Output files are still preparing</div>
            <div className="mt-0.5 text-2xs leading-relaxed text-warn-800">
              Live test results remain valid. {exportable}/{total} cases can export now; {held} need QAAI to complete internal replay evidence before download. These are QAAI platform gaps, not confirmed website failures.
            </div>
          </div>
        </div>
        {blockedCases[0]?.runResultId && (
          <button
            type="button"
            onClick={() => onPickCase?.(blockedCases[0].runResultId)}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-pill border border-warn-300 bg-white px-2.5 text-2xs font-bold uppercase tracking-[0.12em] text-warn-800 hover:bg-warn-100"
          >
            Review
          </button>
        )}
      </div>
      {(reasonSummary || blockedCases.length > 0) && (
        <details className="mt-1.5 text-2xs text-warn-800">
          <summary className="cursor-pointer font-semibold">Show affected export cases</summary>
          {reasonSummary && (
            <div className="mt-1 break-words">
              Evidence groups: {reasonSummary}
            </div>
          )}
          <div className="mt-1.5 grid gap-1.5 md:grid-cols-2 xl:grid-cols-3">
            {blockedCases.slice(0, 6).map((item) => (
              <button
                type="button"
                key={item.runResultId || item.testCaseId || item.caseName}
                onClick={() => onPickCase?.(item.runResultId)}
                className="rounded-md border border-warn-200 bg-white/85 px-2 py-1.5 text-left hover:bg-white"
              >
                <div className="truncate text-xs font-semibold text-ink-800">{item.caseName}</div>
                <div className="mt-0.5 font-semibold text-warn-800">{friendlyReason(item.reason)}</div>
                <div className="mt-0.5 break-words text-warn-700">{friendlyMessage(item)}</div>
              </button>
            ))}
          </div>
          {blockedCases.length > 6 && (
            <div className="mt-1 text-warn-700">
              {blockedCases.length - 6} more export-held case{blockedCases.length - 6 === 1 ? '' : 's'} in this run.
            </div>
          )}
        </details>
      )}
    </div>
  );
}

function RunScriptValidationSummary({ report }) {
  if (!report) return null;
  const status = String(report.status || 'not_run');
  const repairs = Array.isArray(report.repairJournal?.repairs) ? report.repairJournal.repairs : [];
  const failures = Array.isArray(report.failures) ? report.failures : [];
  const summary = report.summary || {};
  const meta = status === 'certified'
    ? { label: 'Certified', icon: CheckCircle2, cls: 'border-success-200 bg-success-50 text-success-800' }
    : status === 'healed'
    ? { label: 'Healed and certified', icon: Wand2, cls: 'border-info-200 bg-info-50 text-info-800' }
    : status === 'failed'
    ? { label: 'Script failed', icon: AlertCircle, cls: 'border-danger-200 bg-danger-50 text-danger-800' }
    : status === 'preview_only'
    ? { label: 'Preview only', icon: ShieldAlert, cls: 'border-warn-200 bg-warn-50 text-warn-800' }
    : status === 'queued' || status === 'running'
    ? { label: status === 'queued' ? 'Script queued' : 'Script validating', icon: Loader2, cls: 'border-info-200 bg-info-50 text-info-800' }
    : { label: 'Script not run', icon: FileCode, cls: 'border-ink-200 bg-white/80 text-ink-700' };
  const Icon = meta.icon;
  const firstFailure = failures[0] || null;
  const text = status === 'certified'
    ? `${summary.passed || 0}/${summary.total || 0} generated test${summary.total === 1 ? '' : 's'} passed in QAAI script validation.`
    : status === 'healed'
    ? `${summary.passed || 0}/${summary.total || 0} generated test${summary.total === 1 ? '' : 's'} passed after ${repairs.length || 1} journaled repair${(repairs.length || 1) === 1 ? '' : 's'}.`
    : status === 'failed'
    ? (firstFailure?.file
      ? `Generated script failed at ${firstFailure.file}:${firstFailure.line || 1}. Behavior result and script result are separate.`
      : 'Generated script validation failed. Behavior result and script result are separate.')
    : status === 'preview_only'
    ? 'Generated files are available as preview output, but no clean script-run proof certifies them yet.'
    : status === 'queued' || status === 'running'
    ? 'Generated scripts are being validated in the isolated QAAI script lane, separate from the live Conductor.'
    : 'Generated scripts have not been validated for this run yet.';
  return (
    <section className="relative z-10 border-b border-white/50 bg-white/65 px-4 py-3 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1500px] flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex items-start gap-3">
          <span className={`mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${meta.cls}`}>
            <Icon className={`h-4 w-4 ${status === 'running' ? 'animate-spin' : ''}`} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-bold text-ink-950">Automation Script</h2>
              <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${meta.cls}`}>{meta.label}</span>
              {report.id && <span className="font-mono text-[11px] text-ink-400">{String(report.id).slice(0, 8)}</span>}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-ink-600">{text}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-600">
          <span className="rounded-full border border-ink-100 bg-white/80 px-2.5 py-1 font-semibold">
            Behavior result stays from live evidence
          </span>
          <span className="rounded-full border border-ink-100 bg-white/80 px-2.5 py-1 font-semibold">
            Repairs {repairs.length}
          </span>
          {firstFailure?.file && (
            <span className="max-w-[420px] truncate rounded-full border border-danger-100 bg-danger-50 px-2.5 py-1 font-semibold text-danger-800" title={`${firstFailure.file}:${firstFailure.line || 1}`}>
              {firstFailure.file}:{firstFailure.line || 1}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

function ReportMetric({ label, value, tone = 'ink' }) {
  const toneClass = {
    success: 'text-success-700 bg-success-50 border-success-100',
    danger: 'text-danger-700 bg-danger-50 border-danger-100',
    warn: 'text-warn-700 bg-warn-50 border-warn-100',
    accent: 'text-accent-700 bg-accent-50 border-accent-100',
    ink: 'text-ink-700 bg-white border-ink-200',
  }[tone] || 'text-ink-700 bg-white border-ink-200';
  return (
    <div className={`inline-flex h-8 items-center gap-1.5 rounded-pill border px-2.5 min-w-0 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-white hover:shadow-md ${toneClass}`}>
      <span className="text-2xs font-bold uppercase tracking-[0.12em] opacity-70 truncate">{label}</span>
      <span className="text-sm font-semibold tabular-nums leading-none truncate">{value}</span>
    </div>
  );
}

function formatDurationLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (mins < 60) return rem ? `${mins}m ${rem}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const minRem = mins % 60;
  return minRem ? `${hrs}h ${minRem}m` : `${hrs}h`;
}

function ResizableSplit({ children, className, activePane }) {
  const [pct, setPct] = useState(() => {
    try {
      const raw = localStorage.getItem('qaai.reports.leftPaneWidth');
      const n = raw ? Number(raw) : NaN;
      if (Number.isFinite(n) && n >= 15 && n <= 70) return n;
    } catch { /* ignore */ }
    return 30;
  });
  const containerRef = useRef(null);
  const draggingRef = useRef(false);

  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    function onMove(e) {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width <= 0) return;
      const minPx = 240;
      const minPct = Math.max(15, (minPx / rect.width) * 100);
      const next = Math.max(minPct, Math.min(65, ((e.clientX - rect.left) / rect.width) * 100));
      setPct(next);
    }
    function onUp() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try { localStorage.setItem('qaai.reports.leftPaneWidth', String(Math.round(pct))); } catch { /* ignore */ }
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // Clear body cursor override if the component unmounts while the user is
      // still holding the mouse button — without this, the cursor stays
      // col-resize and the page is unselectable until the next DOM interaction.
      if (draggingRef.current) {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        draggingRef.current = false;
      }
    };
  }, [pct]);

  // Keyboard accessibility: arrow keys nudge the splitter by 2% steps so
  // the divider is usable without a mouse.
  const onKeyDown = useCallback((e) => {
    if (e.key === 'ArrowLeft')  { setPct((p) => Math.max(15, p - 2)); e.preventDefault(); }
    if (e.key === 'ArrowRight') { setPct((p) => Math.min(65, p + 2)); e.preventDefault(); }
  }, []);

  // Track whether we're at the `lg` breakpoint or above. The inline
  // width (set by the splitter drag) only applies at lg+ — below it,
  // both children render full-width inside a flex-col container.
  const [isWide, setIsWide] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.matchMedia('(min-width: 1024px)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const mq = window.matchMedia('(min-width: 1024px)');
    const handler = (e) => setIsWide(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const [left, right] = React.Children.toArray(children);

  return (
    <main ref={containerRef} className={`${className} flex flex-col lg:flex-row`}>
      <div
        className="lg:shrink-0 min-w-0"
        style={isWide ? { width: `${pct}%` } : undefined}
      >
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panels (left and right arrow keys to nudge)"
        tabIndex={0}
        onMouseDown={onMouseDown}
        onKeyDown={onKeyDown}
        className="hidden lg:flex shrink-0 w-1.5 hover:w-2 transition-all bg-ink-100 hover:bg-ink-300 cursor-col-resize items-center justify-center focus-visible:outline-none focus-visible:bg-info-400 focus-visible:w-2 group"
        title="Drag to resize · left/right arrows to nudge"
      >
        <GripVertical className="w-3 h-3 text-ink-400 group-hover:text-white transition-colors" aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        {right}
      </div>
    </main>
  );
}

// ── Loading skeletons ───────────────────────────────────────────────

function TestListSkeleton() {
  return (
    <ul role="list" className="list-none m-0 p-0" aria-hidden="true">
      {Array.from({ length: 8 }).map((_, i) => (
        <li key={i} className="border-b border-ink-100 px-5 py-3.5 flex items-start gap-3">
          <Skeleton className="h-5 w-5" rounded="full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-5/6" />
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
      <div className="rounded-card border border-ink-200 bg-white p-6 space-y-3">
        <Skeleton className="h-4 w-32" rounded="pill" />
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-4 w-full" />
      </div>
      <div className="rounded-card border border-ink-200 bg-white p-6 space-y-3">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-40 w-full" />
      </div>
    </div>
  );
}

function RunChipSkeleton() {
  return (
    <div className="flex items-center gap-3 px-page py-3 border-b border-ink-200 bg-white overflow-x-auto" aria-hidden="true">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="shrink-0 w-[220px] h-16 rounded-card border border-ink-200 bg-white p-3 space-y-1.5">
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      ))}
    </div>
  );
}

// ── RunChipStrip ────────────────────────────────────────────────────
// Horizontal scrollable strip of run chips at the top of the page.
// Replaces the old left-column run list. Latest run sits on the left,
// active run gets an aurora-glow ring. The whole strip can be collapsed
// to a thin one-line summary so the operator can reclaim vertical space
// for the tests + detail panes. Collapse state lives in localStorage.
function RunChipStrip({ runs, totalRuns, loading, activeRunId, selectedRunIds, onPick, onToggleSelect, searchActive, generationLabel }) {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('qaai.reports.runStripCollapsed') === '1'; } catch { return false; }
  });
  const toggleCollapsed = useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem('qaai.reports.runStripCollapsed', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  if (loading) return <RunChipSkeleton />;
  if (totalRuns === 0) {
    return (
      <div className="relative z-10 px-page py-4 border-b border-white/40 bg-white/70 backdrop-blur-md">
        <p className="text-sm text-ink-500 inline-flex items-center gap-2">
          <FileText className="w-4 h-4 text-ink-400" aria-hidden="true" />
          {generationLabel
            ? `No runs for ${generationLabel} yet. Execute approved test cases from Live Pipeline to populate this generation.`
            : 'No runs yet. Execute approved test cases from Live Pipeline to populate this list.'}
        </p>
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <div className="relative z-10 px-page py-4 border-b border-white/40 bg-white/70 backdrop-blur-md">
        <p className="text-sm text-ink-500">No runs match the current filter.</p>
      </div>
    );
  }

  if (collapsed) {
    const active = runs.find((r) => r.id === activeRunId);
    const activeDot = active && ({
      completed: 'bg-success-500',
      failed:    'bg-danger-500',
      cancelled: 'bg-ink-400',
      running:   'bg-info-500 animate-pulse',
    }[active.status] || 'bg-ink-400');
    return (
      <div data-no-print="true" className="relative z-10 px-page py-2.5 border-b border-white/40 bg-white/70 backdrop-blur-md flex items-center gap-3">
        <span className="text-2xs font-bold uppercase tracking-[0.18em] text-ink-500 shrink-0">
          Run
        </span>
        {active ? (
          <span className="flex items-center gap-2 text-sm text-ink-700 flex-1 min-w-0">
            <span className={`w-2 h-2 rounded-full shrink-0 ${activeDot}`} aria-hidden="true" />
            <span className="font-semibold tabular-nums shrink-0">{runDisplayDate(active)}</span>
            <span className="text-ink-300 shrink-0" aria-hidden="true">·</span>
            <span className="truncate min-w-0">{runChipPrimaryLabel(active)}</span>
          </span>
        ) : (
          <span className="text-sm text-ink-500 flex-1 min-w-0">
            {runs.length} run{runs.length === 1 ? '' : 's'} available
          </span>
        )}
        <span className="text-2xs text-ink-400 tabular-nums shrink-0">
          {runs.length} run{runs.length === 1 ? '' : 's'} hidden
        </span>
        <button
          type="button"
          onClick={toggleCollapsed}
          className="inline-flex items-center gap-1.5 px-3 h-8 rounded-pill text-2xs font-semibold uppercase tracking-wider border border-ink-200 bg-white text-ink-600 hover:border-ink-400 transition-all shrink-0"
          title="Show all runs"
        >
          <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
          Show runs
        </button>
      </div>
    );
  }

  return (
    <div data-no-print="true" className="relative z-10 border-b border-white/40 bg-white/70 backdrop-blur-md">
      <div className="px-page pt-2.5 pb-1 flex items-center gap-3">
        <span className="text-2xs font-bold uppercase tracking-[0.18em] text-ink-500 shrink-0">
          Recent runs
          {searchActive && (
            <span className="text-ink-400 ml-1.5 normal-case tracking-normal font-medium tabular-nums">
              · {runs.length} of {totalRuns}
            </span>
          )}
        </span>
        <span className="flex-1" aria-hidden="true" />
        <button
          type="button"
          onClick={toggleCollapsed}
          className="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-pill text-2xs font-semibold uppercase tracking-wider border border-transparent text-ink-500 hover:text-ink-900 hover:bg-ink-50 transition-all"
          title="Hide the runs strip and reclaim vertical space"
        >
          <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
          Hide runs
        </button>
      </div>
      <div
        className="px-page pt-1.5 pb-3 flex items-stretch gap-2 overflow-x-auto"
        role="listbox"
        aria-label="Recent runs"
      >
        {runs.map((r) => (
          <RunChip
            key={r.id}
            run={r}
            active={activeRunId === r.id}
            selected={selectedRunIds.has(r.id)}
            onPick={() => onPick(r.id)}
            onToggleSelect={() => onToggleSelect(r.id)}
          />
        ))}
      </div>
    </div>
  );
}

function formatRunDate(iso) {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function runActivityDate(run) {
  return run?.lastActivityAt || run?.latestResultAt || run?.completedAt || run?.startedAt || null;
}

function runUpdatedAfterStart(run) {
  const started = run?.startedAt ? new Date(run.startedAt).getTime() : 0;
  const activity = runActivityDate(run) ? new Date(runActivityDate(run)).getTime() : 0;
  return started && activity && activity - started > 60000;
}

function runDisplayDate(run) {
  const iso = runActivityDate(run);
  if (!iso) return '';
  const date = formatRunDate(iso);
  return runUpdatedAfterStart(run) ? `Updated ${date}` : date;
}

// Build a meaningful primary label for a run chip. Priority:
//   1. Scenarios touched in this run — most descriptive ("Registration ·
//      Authentication +2")
//   2. Sprint name — but ONLY if the user gave it a real name; the
//      conductor auto-fills `Agent run · <date>` when no sprint is set
//      and that just repeats the timestamp, so skip it.
//   3. "Untitled run" — last resort
function runChipPrimaryLabel(r) {
  const scenarios = Array.isArray(r.scenarios) ? r.scenarios.filter((s) => s?.name) : [];
  if (scenarios.length === 1) return scenarios[0].name;
  if (scenarios.length === 2) return `${scenarios[0].name} · ${scenarios[1].name}`;
  if (scenarios.length > 2)   return `${scenarios[0].name} · ${scenarios[1].name} +${scenarios.length - 2}`;
  // Suppress the auto-generated "Agent run · DATE" sprintName — it
  // duplicates the timestamp underneath. Keep user-set names only.
  if (r.sprintName && !/^Agent run /.test(r.sprintName)) return r.sprintName;
  return 'Untitled run';
}

function RunChip({ run, active, selected, onPick, onToggleSelect }) {
  const r = run;
  const denom = (r.passed || 0) + (r.failed || 0) + (r.blocked || 0);
  const hasSignal = denom > 0;
  const rate = hasSignal ? Math.round((r.passed / denom) * 100) : null;
  const dateStr = runDisplayDate(r);
  const primaryLabel = runChipPrimaryLabel(r);
  // Build a short metadata line — date, test count, duration. Each part
  // is meaningful on its own so the user can scan the strip and pick the
  // right run without re-reading the title.
  const metaParts = [dateStr];
  if (typeof r.testCount === 'number' && r.testCount > 0) {
    metaParts.push(`${r.testCount} test${r.testCount === 1 ? '' : 's'}`);
  }
  if (r.completedAt && r.startedAt) {
    const seconds = Math.round((new Date(r.completedAt) - new Date(r.startedAt)) / 1000);
    if (Number.isFinite(seconds) && seconds > 0) {
      metaParts.push(seconds >= 60 ? `${Math.round(seconds / 60)}m` : `${seconds}s`);
    }
  }
  // Status dot replaces the inline pill so the title gets the full
  // chip width — colored circle reads at a glance without competing
  // with the scenario name for horizontal space.
  const statusTone = {
    completed: { dot: 'bg-success-500', label: 'Completed' },
    failed:    { dot: 'bg-danger-500',  label: 'Failed' },
    cancelled: { dot: 'bg-ink-400',     label: 'Stopped' },
    running:   { dot: 'bg-info-500 animate-pulse', label: 'Running' },
  }[r.status] || { dot: 'bg-ink-400', label: r.status || 'Unknown' };
  // Three independent visual states:
  //   - `active`   — bold black ring around the chip; this is the run
  //                  you're currently viewing in the detail pane below.
  //   - `selected` — blue tinted toolbar with a visible checkmark + a
  //                  blue ring; this is a run marked for batch compare
  //                  or delete. Independent from `active`.
  //   - default    — neutral ink-200 border, no tint.
  // The CHIP BODY (title, meta, counts) is a button that only triggers
  // `onPick` (activate for viewing). The CHECKBOX lives in a separate
  // header toolbar above the body, isolated by a border, so clicks in
  // the body can never accidentally toggle selection.
  // Aurora Glass: chips use .glass-soft as the base surface so they sit
  // on the aurora background as frosted cards. Active/selected indicators
  // use rings (outside the border) instead of overriding the glass's
  // white hairline border — keeps the frosted look intact in every state.
  const outerClass = active
    ? 'ring-2 ring-ink-900 shadow-card-hover'
    : selected
      ? 'ring-2 ring-info-500 shadow-card'
      : 'hover:ring-1 hover:ring-ink-300';
  return (
    <div className={`shrink-0 relative glass-soft glass-hover overflow-hidden transition-all ${outerClass}`}>
      {/* Selection toolbar — ONLY this row toggles selection. Visually
          partitioned from the chip body by a hard border + tinted
          background so the user can never confuse the two click zones.
          Clicking anywhere here flips the selection state for this run;
          clicks never bubble out to the chip body's pickRun. */}
      <label
        className={`flex items-center justify-between gap-2 px-3 py-1.5 border-b cursor-pointer transition-colors select-none ${
          selected
            ? 'bg-info-50 border-info-200 hover:bg-info-100'
            : 'bg-ink-50/60 border-ink-100 hover:bg-ink-100'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="inline-flex items-center gap-2 min-w-0">
          <span
            className={`inline-flex items-center justify-center w-4 h-4 rounded border shrink-0 transition-colors ${
              selected ? 'bg-info-600 border-info-600' : 'bg-white border-ink-400'
            }`}
            aria-hidden="true"
          >
            {selected && <CheckCircle2 className="w-3 h-3 text-white" aria-hidden="true" />}
          </span>
          <span
            className={`text-2xs font-bold uppercase tracking-[0.14em] truncate ${
              selected ? 'text-info-700' : 'text-ink-500'
            }`}
          >
            {selected ? 'Selected' : 'Select'}
          </span>
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select ${primaryLabel} for compare or delete`}
            className="sr-only"
          />
        </span>
        <RunStatusPill status={r.status} />
      </label>

      {/* Body — click anywhere to load this run in the detail pane.
          Title, metadata, and counts only. Selection toolbar is above
          this region and outside the button so the click areas never
          overlap. */}
      <button
        type="button"
        onClick={onPick}
        aria-pressed={active}
        title={`View this run — ${primaryLabel} · ${dateStr}`}
        className="block text-left px-4 py-2.5 w-[300px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink-900"
      >
        <div className="flex items-start gap-2.5">
          <span
            className={`mt-1.5 w-2.5 h-2.5 rounded-full shrink-0 ${statusTone.dot}`}
            aria-label={statusTone.label}
          />
          <h3 className="text-sm font-semibold text-ink-900 leading-snug line-clamp-2 flex-1 min-w-0">
            {primaryLabel}
          </h3>
        </div>
        <div className="mt-1.5 ml-5 text-2xs text-ink-500 tabular-nums">
          {metaParts.join(' · ')}
        </div>
        {hasSignal ? (
          <div className="mt-2.5 pt-2.5 ml-5 border-t border-ink-100 flex items-center gap-3 text-2xs">
            <span className="inline-flex items-center gap-1 text-success-700 font-semibold tabular-nums">
              <CheckCircle2 className="w-3 h-3" aria-hidden="true" />{r.passed || 0}
            </span>
            <span className="inline-flex items-center gap-1 text-danger-700 font-semibold tabular-nums">
              <XCircle className="w-3 h-3" aria-hidden="true" />{r.failed || 0}
            </span>
            <span className="inline-flex items-center gap-1 text-warn-700 font-semibold tabular-nums">
              <ShieldAlert className="w-3 h-3" aria-hidden="true" />{r.blocked || 0}
            </span>
            <span className="ml-auto text-ink-800 font-bold tabular-nums">{rate}% pass</span>
          </div>
        ) : (
          <div className="mt-2.5 pt-2.5 ml-5 border-t border-ink-100 text-2xs text-ink-400 italic">
            {r.status === 'running' ? 'Run still in progress…' : 'No test results recorded'}
          </div>
        )}
      </button>
    </div>
  );
}

function ResultsByScenario({ results, activeResultId, onPick }) {
  const groups = useMemo(() => {
    const map = new Map();
    const orderedResults = [...(Array.isArray(results) ? results : [])].sort(compareReportResults);
    for (const r of orderedResults) {
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
          counts: { pass: 0, fail: 0, blocked: 0, held: 0, skipped: 0 },
        });
      }
      const g = map.get(key);
      g.items.push(r);
      if (r.status === 'pass')         g.counts.pass++;
      else if (r.status === 'fail')    g.counts.fail++;
      else if (r.status === 'blocked' && isInternalEvidenceResult(r)) g.counts.held++;
      else if (r.status === 'blocked') g.counts.blocked++;
      else if (r.status === 'skipped') g.counts.skipped++;
      else                              g.counts.blocked++;
    }
    return Array.from(map.values())
      .sort((a, b) => compareReportResults(a.items[0], b.items[0]))
      .map((g) => ({
        ...g,
        caseGroups: buildResultCaseGroups(g.items),
      }));
  }, [results]);

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
                className="w-full px-5 py-3 flex items-center gap-2 bg-ink-50/80 hover:bg-ink-50 border-y border-ink-100 sticky top-0 z-[1] focus-visible:outline-none focus-visible:bg-info-50"
                title={g.name}
              >
                <FolderTree className="w-3.5 h-3.5 text-ink-500 shrink-0" aria-hidden="true" />
                <span className="text-2xs font-bold uppercase tracking-[0.18em] text-ink-700 truncate flex-1 text-left">
                  {g.name}
                </span>
                <span className="inline-flex items-center gap-1.5 text-2xs tabular-nums">
                  {g.counts.pass > 0 && <span className="text-success-700 font-bold">{g.counts.pass}</span>}
                  {g.counts.fail > 0 && <span className="text-danger-700 font-bold">{g.counts.fail}</span>}
                  {g.counts.held > 0 && <span className="text-info-700 font-bold" title="Held by QAAI evidence capture">{g.counts.held}</span>}
                  {g.counts.blocked > 0 && <span className="text-warn-700 font-bold">{g.counts.blocked}</span>}
                </span>
                {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-ink-400" aria-hidden="true" /> : <ChevronRight className="w-3.5 h-3.5 text-ink-400" aria-hidden="true" />}
              </button>
            </h3>
            {isOpen && (
              <ul role="list" id={listId} className="list-none m-0 p-0">
                {g.caseGroups.map((caseGroup) => (
                  caseGroup.dataDriven
                    ? (
                      <DataDrivenResultGroup
                        key={caseGroup.id}
                        caseGroup={caseGroup}
                        activeResultId={activeResultId}
                        onPick={onPick}
                      />
                    )
                    : caseGroup.rows.map((r) => (
                      <ResultListItem
                        key={r.id}
                        result={r}
                        activeResultId={activeResultId}
                        onPick={onPick}
                      />
                    ))
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function buildResultCaseGroups(items) {
  const map = new Map();
  const orderedItems = [...(Array.isArray(items) ? items : [])].sort(compareReportResults);
  for (const r of orderedItems) {
    const key = r.testCaseId || r.id || `__case_${map.size}`;
    if (!map.has(key)) {
      map.set(key, { id: key, rows: [], dataDriven: false });
    }
    const group = map.get(key);
    group.rows.push(r);
    group.dataDriven = group.dataDriven || hasDataRow(r);
  }
  return Array.from(map.values())
    .map((group) => {
      const rows = [...group.rows].sort(compareReportResults);
      const dataRowCount = rows.filter(hasDataRow).length;
      return {
        ...group,
        rows,
        dataDriven: rows.some((row) => hasDataRow(row) && shouldShowDataRowUi(row, dataRowCount)),
      };
    })
    .sort((a, b) => compareReportResults(a.rows[0], b.rows[0]));
}

function AutoRevealText({ children, className = '' }) {
  const shellRef = useRef(null);
  const textRef = useRef(null);
  const [offset, setOffset] = useState(0);
  const [active, setActive] = useState(false);
  const label = typeof children === 'string' ? children : undefined;

  const reveal = useCallback(() => {
    const shell = shellRef.current;
    const text = textRef.current;
    if (!shell || !text) return;
    const travel = Math.max(0, text.scrollWidth - shell.clientWidth);
    setOffset(travel);
    setActive(travel > 2);
  }, []);

  const reset = useCallback(() => {
    setActive(false);
  }, []);

  const duration = active
    ? Math.min(5200, Math.max(1400, offset * 24))
    : 280;

  return (
    <span
      ref={shellRef}
      className={`block min-w-0 flex-1 overflow-hidden whitespace-nowrap ${className}`}
      aria-label={label}
      onPointerEnter={reveal}
      onPointerLeave={reset}
    >
      <span
        ref={textRef}
        className="inline-block max-w-full truncate align-bottom transition-transform ease-linear motion-reduce:transition-none"
        style={{
          maxWidth: active ? 'none' : '100%',
          transform: active ? `translateX(-${offset}px)` : 'translateX(0)',
          transitionDuration: `${duration}ms`,
        }}
      >
        {children}
      </span>
    </span>
  );
}

function DataDrivenResultGroup({ caseGroup, activeResultId, onPick }) {
  const rows = caseGroup.rows;
  const first = rows[0] || {};
  const isActive = rows.some((r) => r.id === activeResultId);
  const passed = rows.filter((r) => r.status === 'pass').length;
  const failed = rows.filter((r) => r.status === 'fail').length;
  const held = rows.filter((r) => r.status === 'blocked' && isInternalEvidenceResult(r)).length;
  const blocked = rows.filter((r) => r.status === 'blocked' && !isInternalEvidenceResult(r)).length;
  const skipped = rows.filter((r) => r.status === 'skipped').length;
  const total = rows.length;

  return (
    <li>
      <div className={`px-5 py-3 border-b border-ink-100 bg-ink-50/45 ${isActive ? 'border-l-2 border-l-info-500' : ''}`}>
        <div className="flex items-start gap-3">
          <Layers className="w-4 h-4 mt-0.5 shrink-0 text-info-600" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-ink-900 flex items-center gap-1.5 min-w-0">
              {first.caseLabel && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-white text-ink-600 border border-ink-200 text-2xs font-bold tabular-nums shrink-0 whitespace-nowrap">
                  {first.caseLabel}
                </span>
              )}
              <AutoRevealText>{first.testCase?.name || first.testCaseId}</AutoRevealText>
            </div>
            <div className="flex items-center gap-2 mt-1 text-2xs text-ink-500 flex-wrap">
              {first.dataSetName && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-pill bg-info-50 text-info-700 border border-info-100 font-semibold">
                  {first.dataSetName}
                </span>
              )}
              <span className="tabular-nums font-semibold text-success-700">{passed}/{total} passed</span>
              {failed > 0 && <span className="tabular-nums font-semibold text-danger-700">{failed} failed</span>}
              {held > 0 && <span className="tabular-nums font-semibold text-info-700">{held} held by QAAI</span>}
              {blocked > 0 && <span className="tabular-nums font-semibold text-warn-700">{blocked} blocked</span>}
              {skipped > 0 && <span className="tabular-nums font-semibold text-ink-500">{skipped} skipped</span>}
            </div>
          </div>
        </div>
      </div>
      <ul role="list" className="list-none m-0 p-0">
        {rows.map((r) => (
          <ResultListItem
            key={r.id}
            result={r}
            activeResultId={activeResultId}
            onPick={onPick}
            nested
          />
        ))}
      </ul>
    </li>
  );
}

function ResultListItem({ result: r, activeResultId, onPick, nested = false }) {
  const meta = statusMeta(r.status || 'blocked');
  const internalEvidence = isInternalEvidenceResult(r);
  const Icon = internalEvidence ? AlertCircle : meta.icon;
  const isActive = activeResultId === r.id;
  const title = nested ? (formatDataRowLabel(r) || r.testCase?.name || r.testCaseId) : (r.testCase?.name || r.testCaseId);
  const metaLabel = nested ? r.dataSetName || r.testCase?.module : r.testCase?.module;

  return (
    <li>
      <button
        type="button"
        onClick={() => onPick(r)}
        aria-current={isActive ? 'true' : undefined}
        className={`w-full text-left border-b border-ink-100 flex items-start gap-3 transition-colors focus-visible:outline-none focus-visible:bg-info-50 ${
          nested ? 'pl-10 pr-5 py-2.5 bg-white/70' : 'px-5 py-3'
        } ${
          isActive ? 'bg-info-50/60 border-l-2 border-l-info-500' : 'hover:bg-ink-50/60'
        }`}
      >
        <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${internalEvidence ? 'text-info-600' : meta.text}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink-900 flex items-center gap-1.5 min-w-0">
            {!nested && r.caseLabel && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-ink-100 text-ink-600 border border-ink-200 text-2xs font-bold tabular-nums shrink-0 whitespace-nowrap">
                {r.caseLabel}
              </span>
            )}
            <AutoRevealText>{title}</AutoRevealText>
            {r.rcaWhat && <BrainCircuit className="w-3 h-3 text-accent-600 shrink-0" aria-label="AI root cause available" />}
            {r.ticketId && <Bug className="w-3 h-3 text-info-600 shrink-0" aria-label={`Ticket ${r.ticketId}`} />}
          </div>
          <div className="flex items-center gap-2 mt-1 text-2xs text-ink-500">
            {metaLabel && <span className="truncate">{metaLabel}</span>}
            {metaLabel && <span aria-hidden="true">·</span>}
            <span className="tabular-nums">{r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}</span>
          </div>
        </div>
      </button>
    </li>
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
    completed: { cls: 'bg-success-50 text-success-700 border-success-200', label: 'Completed' },
    failed:    { cls: 'bg-danger-50 text-danger-700 border-danger-200',    label: 'Failed' },
    cancelled: { cls: 'bg-ink-100 text-ink-600 border-ink-200',            label: 'Stopped' },
    running:   { cls: 'bg-info-50 text-info-700 border-info-200',          label: 'Running' },
  };
  const meta = map[status] || map.running;
  return (
    <span className={`text-2xs uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-pill border ${meta.cls}`}>
      {meta.label}
    </span>
  );
}

// ── DetailPane (tabbed) ─────────────────────────────────────────────
// Headline status block on top, sticky tab bar, then the selected tab
// content. Focus moves to the heading on result switch so keyboard
// users land on the new content.
function DetailPane({ result, testCase, dataRowCount, projectId, runId, activeTab, onPickTab, liveStepStatus, onAssertionRemoved, onAssertionRepaired }) {
  const headingRef = useRef(null);
  // ONE shared lightbox for the whole pane — the Screenshots gallery and the
  // step thumbnails both open it, so prev/next traverses every captured frame.
  // `lightboxIndex` is a position into `frames`; null = closed.
  const frames = useMemo(() => normaliseScreenshots(result.screenshots), [result.screenshots]);
  const [lightboxIndex, setLightboxIndex] = useState(null);
  useEffect(() => {
    const id = setTimeout(() => { headingRef.current?.focus(); }, 0);
    setLightboxIndex(null); // close the viewer when switching to another case
    return () => clearTimeout(id);
  }, [result.id]);

  return (
    <div className="max-w-5xl mx-auto px-page py-5 space-y-4">
      <DetailHeader
        result={result}
        testCase={testCase}
        dataRowCount={dataRowCount}
        projectId={projectId}
        headingRef={headingRef}
      />
      <div className="glass overflow-hidden">
        <TabBar tabs={TABS} activeTab={activeTab} onPickTab={onPickTab} result={result} />
        <div className="p-4 lg:p-5">
          {activeTab === 'steps' && (
            <StepsTraceTab
              result={result}
              testCase={testCase}
              runId={runId}
              liveStepStatus={liveStepStatus}
              frames={frames}
              onOpenFrame={setLightboxIndex}
            />
          )}
          {activeTab === 'screenshots' && (
            <ScreenshotsTab result={result} frames={frames} onOpenFrame={setLightboxIndex} />
          )}
          {activeTab === 'ai' && (
            <AIAnalysisTab result={result} testCase={testCase} projectId={projectId} />
          )}
          {activeTab === 'verdict' && (
            <VerdictEvidenceTab
              result={result}
              projectId={projectId}
              onAssertionRemoved={onAssertionRemoved}
              onAssertionRepaired={onAssertionRepaired}
            />
          )}
          {activeTab === 'video' && (
            <VideoTab result={result} />
          )}
        </div>
      </div>
      <ScreenshotLightbox
        frames={frames}
        index={lightboxIndex}
        onClose={() => setLightboxIndex(null)}
        onIndex={setLightboxIndex}
      />
    </div>
  );
}

// ── DetailHeader ────────────────────────────────────────────────────
// The block that greets you when you open a failed test case. Large
// display-font headline, friendly metadata line, and — for failures —
// the Reporter agent's plain-English summary right there in the header.
// E0 — friendly labels for the structured RunResult.blockedReason codes. Shown
// as a categorical chip on blocked cases so a QA lead can see *why* at a glance
// and so the reason-code distribution (selector_not_found vs auth_required …)
// is legible without reading prose. Keep in sync with the enum the conductor
// writes (persistResultAndCodegen) and classifyError's mapping.
const BLOCKED_REASON_LABELS = {
  selector_not_found:    'Selector not found',
  selector_quarantined:  'Selector quarantined',
  auth_required:         'Auth required',
  session_expired:       'Session expired',
  page_not_reached:      'Page not reached',
  unexpected_modal:      'Unexpected modal',
  assertion_uncheckable: 'Assertion uncheckable',
  agent_loop:            'Agent loop',
  budget_exceeded:       'Daily AI budget reached',
  env_config:            'Environment / config',
  multi_tab_required:    'Multi-tab required',
  iframe_required:       'Iframe required',
  failed_prereq:         'Blocked by prerequisite',
  session_continuity_unavailable: 'Session continuity unavailable',
  internal_evidence_gap: 'QAAI capture issue',
  qaai_execution_error:  'QAAI execution error',
  evidence_acquisition_failed: 'QAAI evidence capture failed',
  dependency_not_executed: 'Dependent steps not executed',
  validation_failed:     'Validation failed',
  no_assertions_declared: 'No required assertions declared',
  assertion_parse_failed: 'Assertion could not be prepared',
  assertion_contract_defect: 'Assertion contract defect',
  incomplete_execution:  'Incomplete execution',
  test_data_invalid:     'Invalid test data / missing precondition',
  unknown:               'Uncategorized',
};

function isInternalEvidenceResult(result) {
  if (!result) return false;
  const parsedSteps = parseStoredObject(result.stepResults);
  const stepRows = Array.isArray(parsedSteps)
    ? parsedSteps
    : (parsedSteps && typeof parsedSteps === 'object' ? Object.values(parsedSteps) : []);
  const stepText = stepRows.flatMap((step) => [
    step?.reason,
    step?.error,
    step?.evidence,
    step?.executionErrorReason,
    step?.continuationReason,
    step?.failureType,
    step?.failureImpact,
    step?.operationCheck?.reason,
    step?.operationCheck?.evidence,
    step?.stateEvidence?.reason,
  ]).filter(Boolean).join(' ');
  const text = [
    result.blockedReason,
    result.error,
    result.failureExplanation,
    result.mechanicalVerdictReason,
    result.blocked?.message,
    stepText,
  ].filter(Boolean).join(' ').toLowerCase();
  return result.blockedReason === 'internal_evidence_gap'
    || ['qaai_execution_error', 'evidence_acquisition_failed', 'no_assertions_declared', 'assertion_parse_failed']
      .includes(String(result.blockedReason || result.mechanicalVerdictReason || ''))
    || text.includes('missing_verified_action_locator')
    || text.includes('critical_evidence_gap')
    || text.includes('internal evidence/export gap')
    || text.includes('internal evidence gap')
    || text.includes('snapshot_unavailable')
    || text.includes('fresh_snapshot_unavailable')
    || text.includes('evidence_acquisition_failed')
    || /cached state.+fresh validation snapshot|fresh validation snapshot.+did not confirm/.test(text);
}

function parseStoredObject(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return null; }
}

function failureExplanationOwnership(result) {
  const parsed = parseStoredObject(result?.failureExplanation);
  return typeof parsed?.ownership === 'string' ? parsed.ownership : null;
}

function isAssertionContractDefectResult(result) {
  if (!result) return false;
  if (result.blockedReason === 'assertion_contract_defect') return true;
  if (failureExplanationOwnership(result) === 'qaai_assertion_contract') return true;
  const text = [
    result.mechanicalVerdictReason,
    result.error,
    result.failureExplanation,
    result.blocked?.message,
  ].filter(Boolean).join(' ').toLowerCase();
  return text.includes('assertion_contract_defect')
    || text.includes('assertion contract defect');
}

function assertionOutcomeIsMatched(outcome) {
  const raw = String(outcome?.effective || outcome?.outcome || outcome?.status || '').toLowerCase();
  return raw === 'matched' || raw === 'pass' || raw === 'passed';
}

function resultHasAllRecordedAssertionsMatched(result) {
  const outcomes = Array.isArray(result?.assertionCheckResults)
    ? result.assertionCheckResults.filter(Boolean)
    : [];
  return outcomes.length > 0 && outcomes.every(assertionOutcomeIsMatched);
}

// detectVerdictContradiction now lives in ../lib/verdictContradiction (pure +
// unit-tested in tests/unit/verdictContradiction.test.js); imported at the top.

function isLegacyCloseoutCorrection(result) {
  if (!result) return false;
  if (result.statusCorrection?.reason === 'legacy_closeout_after_complete_assertion_evidence') return true;
  const text = [
    result.blockedReason,
    result.error,
    result.mechanicalVerdictReason,
    result.failureExplanation,
  ].filter(Boolean).join(' ').toLowerCase();
  return resultHasAllRecordedAssertionsMatched(result)
    && (text.includes('turn_ceiling') || text.includes('no_end_turn') || text.includes('mechanical_v1'));
}

function DetailHeader({ result, testCase, dataRowCount, projectId, headingRef }) {
  const meta = statusMeta(result.status || 'pending');
  const internalEvidence = isInternalEvidenceResult(result);
  const assertionContractDefect = isAssertionContractDefectResult(result);
  const specialInternal = internalEvidence || assertionContractDefect;
  const contradiction = detectVerdictContradiction(result);
  const Icon = specialInternal ? AlertCircle : meta.icon;
  const friendlySummary = useMemo(() => buildFriendlySummary(result), [result]);
  const moduleLabel = testCase?.module;
  const typeLabel = testCase?.type;
  const scenarioName = testCase?.scenario?.name;
  const durationStr = result.durationMs ? `${(result.durationMs / 1000).toFixed(1)}s` : '—';
  const dataRowBadge = result.dataRowLabel && shouldShowDataRowUi(result, dataRowCount)
    ? [result.dataSetName, result.dataRowLabel].filter(Boolean).join(' · ')
    : null;

  return (
    <header className={`rounded-card border ${specialInternal ? 'border-info-200 bg-info-50' : `${meta.border} ${meta.bg}`} px-5 py-5`}>
      {contradiction && (
        <div className="mb-4 rounded-lg border border-danger-200 bg-danger-50 px-4 py-3 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 text-danger-600 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="min-w-0">
            <div className="text-2xs uppercase tracking-wider font-bold text-danger-700">
              Backend contradiction — uncertified pass
            </div>
            <p className="mt-1 text-sm text-danger-800 leading-relaxed">{contradiction.text}</p>
          </div>
        </div>
      )}
      <div className="flex items-start gap-4">
        <div className="w-11 h-11 rounded-full bg-white shadow-card flex items-center justify-center shrink-0">
          <Icon className={`w-5 h-5 ${specialInternal ? 'text-info-600' : meta.text}`} aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          {scenarioName && (
            <div className="text-2xs uppercase tracking-[0.22em] font-bold text-ink-500 mb-1.5 flex items-center gap-1.5">
              <FolderTree className="w-3 h-3" aria-hidden="true" />
              <span>{scenarioName}</span>
            </div>
          )}
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="text-xl font-semibold text-ink-900 leading-snug outline-none focus-visible:ring-2 focus-visible:ring-info-300 focus-visible:ring-offset-2 rounded"
          >
            {result.caseLabel && (
              <span className="inline-flex items-center mr-2.5 px-2 py-0.5 rounded-lg bg-ink-100 text-ink-600 border border-ink-200 text-sm font-bold tabular-nums align-middle whitespace-nowrap">
                {result.caseLabel}
              </span>
            )}
            {testCase?.name || result.testCaseId}
          </h2>
          {dataRowBadge && (
            <div className="mt-2">
              <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-pill bg-info-50 text-info-700 border border-info-200 text-2xs font-bold">
                <Layers className="w-3 h-3" aria-hidden="true" />
                {dataRowBadge}
              </span>
            </div>
          )}
          <div className="mt-2 flex items-center gap-2 flex-wrap text-2xs uppercase tracking-wider font-bold">
            <span className={`${internalEvidence ? 'text-info-700' : meta.text}`}>
              {assertionContractDefect ? 'Assertion contract defect' : internalEvidence ? 'Needs rerun' : meta.label}
            </span>
            {reportStatusBucket(result.status) === 'blocked' && result.blockedReason && (
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded-full border normal-case tracking-normal ${
                  specialInternal
                    ? 'bg-info-50 text-info-700 border-info-200'
                    : 'bg-warn-100 text-warn-700 border-warn-200'
                }`}
                title={assertionContractDefect ? 'QAAI selected an assertion that contradicts the flow; this is not a confirmed website failure.' : internalEvidence ? 'This saved run was held by QAAI evidence capture, not by the website.' : 'Why this case was blocked (structured reason code)'}
              >
                {BLOCKED_REASON_LABELS[result.blockedReason] || result.blockedReason}
              </span>
            )}
            {moduleLabel && <span className="text-ink-300">·</span>}
            {moduleLabel && <span className="text-ink-600">{moduleLabel}</span>}
            {typeLabel && <span className="text-ink-300">·</span>}
            {typeLabel && <span className="text-ink-600">{typeLabel}</span>}
            <span className="text-ink-300">·</span>
            <span className="text-ink-600 inline-flex items-center gap-1 normal-case tracking-normal">
              <Clock className="w-3 h-3" aria-hidden="true" />
              {durationStr}
            </span>
          </div>
          {friendlySummary && (
            <p className="mt-3 text-sm text-ink-800 leading-relaxed max-w-3xl">
              {friendlySummary}
            </p>
          )}
        </div>
      </div>
      {testCase?.id && projectId && (
        <div className="mt-5 -mb-1 -mx-1">
          <TestHistoryPanel projectId={projectId} testCaseId={testCase.id} currentRunId={result.runId} compact />
        </div>
      )}
    </header>
  );
}

// Plain-English headline summary for the DetailHeader. Prefers the
// Reporter agent's `rcaWhat` (already written in user-friendly language).
// Falls back to a short translation of the blocker reason if present, or
// the raw error trimmed to one sentence. Returns null for passing tests —
// no need to narrate a green run.
function buildFriendlySummary(result) {
  if (result.status === 'pass') return null;

  // Dependency context (#5): if this case didn't pass AND one of its
  // prerequisites also didn't pass in this run, lead with that so the user
  // knows the real cause is upstream and to run/fix the prerequisite first.
  let depNote = '';
  if (Array.isArray(result.prereqFailures) && result.prereqFailures.length) {
    const p = result.prereqFailures[0];
    const verb = p.status === 'fail' ? 'failed'
      : p.status === 'blocked' ? 'was blocked'
      : p.status === 'skipped' ? 'did not run'
      : "didn't pass";
    depNote = `Blocked because the prerequisite "${p.name || 'an earlier case'}" ${verb} in this run — run that first. `;
  }

  const conductorSummary = buildConductorSummary(result);
  let base = '';
  if (isLegacyCloseoutCorrection(result)) base = 'QAAI recorded the declared validation evidence successfully. This saved run was previously labeled blocked because the runner hit its closeout turn ceiling after those checks were complete; current runs keep that as a pass.';
  else if (isAssertionContractDefectResult(result)) base = 'QAAI checked the wrong required assertion for this flow. The browser reached the expected state, but the assertion contract expected a different page.';
  else if (isInternalEvidenceResult(result)) base = 'QAAI could not capture or confirm the browser evidence needed for this check. No website failure was established; rerun so QAAI can acquire fresh evidence.';
  else if (result.mechanicalVerdictReason === 'dependency_not_executed' || result.blockedReason === 'dependency_not_executed') base = 'This case did not complete because one or more dependent steps were not executable after an earlier stop. The unexecuted steps remain distinct from product validation failures.';
  else if (result.mechanicalVerdictReason === 'validation_failed' || result.blockedReason === 'validation_failed') base = 'Execution completed, but at least one required validation did not match the observed website state. Review expected versus actual evidence below.';
  else if (conductorSummary) base = conductorSummary;
  else if (result.rcaWhat) base = result.rcaWhat;
  else if (result.blockedReason === 'budget_exceeded') base = 'QAAI stopped before the next AI action because the daily token budget was exhausted. This is not a website failure or locator failure.';
  else if (result.blockedReason === 'no_execution') base = 'Browser session unavailable — the case did not execute. This is an environment/session failure, NOT a website failure or a confirmed test result.';
  else if (result.blockedReason === 'test_data_invalid') base = 'Invalid generated test data / binding — this row contradicts its own intent (e.g. a negative case bound to valid-login rows). This is a test-data/generation defect, NOT a website failure.';
  else if (/Result-bearing\s+(?:fill|select)\s+step/i.test(String(result.error || result.blocked?.message || ''))) base = 'QAAI stopped before the real website assertion ran. The input value was entered, but result proof was attached too early to the Fill step instead of the later Search/Verify step. Treat this as an automation/oracle-placement issue, not a confirmed website failure.';
  else if (result.status === 'needs_human') base = 'Not judged — QAAI could not verify this case from the captured evidence (automation evidence unavailable). This is NOT a confirmed website failure; rerun to capture the evidence.';
  else if (result.blocked?.message) base = humanizeBlockerReason(result.blocked.reason, result.blocked.message);
  else if (result.error) base = humanizeErrorMessage(String(result.error).split('\n').find(Boolean) || '');
  else if (result.status === 'blocked') base = "This test couldn't reach its assertion — the agent was unable to complete the steps end-to-end.";
  else if (result.status === 'fail') base = 'This test failed during execution. Check the steps below to see exactly where it broke.';
  else if (result.status === 'skipped') base = 'This case did not run — the suite was stopped before it executed. Rerun it when ready.';

  // Provenance note: if a REQUIRED check drawn verbatim from the document
  // failed, say so plainly — this is the "I treated it as a must because the
  // document stated it" context. Faithful: only added when the data shows it.
  let provNote = '';
  try {
    const declared = Array.isArray(result.testCase?.declaredAssertions) ? result.testCase.declaredAssertions : [];
    const outcomes = Array.isArray(result.assertionCheckResults) ? result.assertionCheckResults : [];
    const ocById = new Map(outcomes.filter((o) => o && o.assertionId).map((o) => [o.assertionId, o]));
    const fm = declared.find((d) => d && !d.parseFailed
      && (d.criticality || 'must') === 'must' && d.provenance === 'doc_quoted'
      && ocById.get(d.id)?.outcome === 'not_matched');
    if (fm && !isAssertionContractDefectResult(result)) provNote = ' This was a required outcome stated in your document, so it was checked strictly — open Verdict & Evidence for the details.';
  } catch (_) { /* non-fatal — summary still renders without the note */ }

  return (depNote + base + provNote).trim() || null;
}

function humanizeBlockerReason(reason, fallback) {
  switch (reason) {
    case 'agent_loop':
      return 'The agent tried the same actions over and over without making progress, so it stopped to save your credits.';
    case 'budget_exceeded':
      return 'QAAI stopped before the next AI action because the daily token budget was exhausted.';
    case 'locator_missing':
      return 'The agent couldn\'t find the element it needed to interact with on the page.';
    case 'timeout':
      return 'The page didn\'t respond in time, so the agent gave up waiting.';
    case 'assertion':
      return 'The page did something different from what the test expected.';
    case 'assertion_contract_defect':
      return 'QAAI checked the wrong required assertion for this flow; repair the assertion contract and rerun.';
    case 'qaai_execution_error':
    case 'evidence_acquisition_failed':
      return 'QAAI could not capture or confirm the browser evidence required to judge the website. Rerun to acquire fresh evidence.';
    case 'dependency_not_executed':
      return 'Dependent steps were not executed after an earlier required step stopped.';
    case 'validation_failed':
      return 'The browser actions completed, but a required validation did not match the observed state.';
    case 'no_assertions_declared':
    case 'assertion_parse_failed':
      return 'QAAI could not prepare a complete required assertion contract, so no product verdict was made.';
    case 'network':
      return 'A network request the test depends on returned an error.';
    case 'supervisor_giveup':
      return 'The Supervisor stopped after three failed attempts because the same problem kept happening.';
    default:
      return fallback || 'This test was blocked before it could finish.';
  }
}

function humanizeErrorMessage(line) {
  if (/mechanical_v1:\s*(turn_ceiling|no_end_turn)|\bturn_ceiling\b|\bno_end_turn\b/i.test(line)) {
    return 'QAAI finished the visible checks but the runner did not close the case cleanly in this saved run.';
  }
  if (/TimeoutError|Timeout \d+ms exceeded/i.test(line)) {
    return 'The page didn\'t respond within the time limit.';
  }
  if (/locator.*not.*found|element.*not.*found/i.test(line)) {
    return 'The agent couldn\'t find an element it needed on the page.';
  }
  if (/navigation|net::ERR/i.test(line)) {
    return 'The browser couldn\'t reach the page.';
  }
  // If the line is short and looks like a sentence already, use it.
  if (line.length < 160 && !line.includes('(')) return line;
  return 'Something went wrong during execution. See the steps below for the exact point of failure.';
}

// ── TabBar ──────────────────────────────────────────────────────────
// Sticky tab navigation inside the detail card. Active tab gets an aurora
// underline. Each tab can show a small badge (e.g., screenshot count,
// network entry count) so the user knows what's worth a click.
function TabBar({ tabs, activeTab, onPickTab, result }) {
  const frameCount = Array.isArray(result.screenshots) ? result.screenshots.length : 0;
  const badges = {
    steps: tabBadge(result),
    screenshots: frameCount,
    ai: result.rcaWhat ? 1 : 0,
    verdict: (() => {
      const da = result.testCase?.declaredAssertions;
      if (!Array.isArray(da)) return 0;
      const active = da.filter((d) => d && !d.parseFailed).length;
      // When all assertions were demoted (parseFailed), show the demoted count
      // so the tab is visibly non-empty and QA knows to open it.
      if (active === 0) return da.filter((d) => d && d.parseFailed === true).length;
      return active;
    })(),
    // Real MP4 (when wired) takes precedence; otherwise the badge
    // reflects the synthesised frame-stitched playback count so the
    // Video tab is discoverable even without a real recording.
    video: result.video ? 1 : frameCount,
  };
  return (
    <div role="tablist" aria-label="Test detail sections" className="border-b border-ink-100 flex overflow-x-auto bg-white sticky top-0 z-10">
      {tabs.map((t) => {
        const Icon = t.icon;
        const active = activeTab === t.id;
        const badge = badges[t.id];
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onPickTab(t.id)}
            className={`shrink-0 px-5 py-3 inline-flex items-center gap-2 text-sm font-medium border-b-2 transition-colors focus-visible:outline-none focus-visible:bg-info-50 ${
              active
                ? 'border-ink-900 text-ink-900 bg-ink-50/40'
                : 'border-transparent text-ink-500 hover:text-ink-800 hover:bg-ink-50/60'
            }`}
          >
            <Icon className={`w-4 h-4 ${active ? 'text-ink-900' : 'text-ink-500'}`} aria-hidden="true" />
            <span>{t.label}</span>
            {badge > 0 && (
              <span className={`tabular-nums text-2xs font-semibold px-1.5 rounded-pill ${active ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-600'}`}>
                {badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function tabBadge(result) {
  const authored = selectAuthoredPlannedSteps({ result, testCase: result.testCase });
  const logicalCount = projectAuthoredStepRows(authored).length;
  if (logicalCount > 0) return logicalCount;
  // Step count badge — prefer parsed stepResults length, fall back to
  // declared steps count, then trace line count.
  try {
    const parsed = typeof result.stepResults === 'string' ? JSON.parse(result.stepResults) : result.stepResults;
    if (Array.isArray(parsed) && parsed.length > 0) return parsed.length;
  } catch { /* fall through */ }
  if (Array.isArray(result.testCase?.steps) && result.testCase.steps.length) return result.testCase.steps.length;
  if (result.trace) return result.trace.split('\n').filter(Boolean).length;
  return 0;
}

// ── StepsTraceTab ───────────────────────────────────────────────────
// Two stacked sections:
//   1. "Declared steps" — what the test was *meant* to do, overlaid with
//      per-step verdicts from `result.stepResults` (Batch 2) or live WS
//      updates from `step.complete` events when the run is in flight.
//   2. "What QAAI actually did" — chronological humanised trace from the
//      stored `result.trace` string. Every raw `browser_*({...})` line is
//      mapped to a human past-tense sentence.
function StepsTraceTab({ result, testCase, runId, liveStepStatus, frames = [], onOpenFrame }) {
  // Developer-only toggle: when on, every humanised line is followed by
  // the original conductor trace string (raw tool name + JSON args) so a
  // QA engineer can spot the exact selector / payload. Off by default.
  // Persisted to localStorage so the choice survives navigation.
  const [showRawTrace, setShowRawTrace] = useState(() => {
    try { return localStorage.getItem('qaai.reports.showRawTrace') === '1'; } catch { return false; }
  });
  const toggleRaw = useCallback(() => {
    setShowRawTrace((v) => {
      const next = !v;
      try { localStorage.setItem('qaai.reports.showRawTrace', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Project both enriched journal rows and legacy stepResults through one
  // compatibility layer. Planned steps without a persisted result are always
  // shown as not executed; a case-level PASS must never manufacture step passes.
  const declaredSteps = useMemo(
    () => selectAuthoredPlannedSteps({ result, testCase }),
    [result.executionContract, result.executionContractJson, testCase?.steps],
  );
  const stepProjection = useMemo(() => {
    let parsed = result.stepResults;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch { parsed = null; }
    }
    const persisted = Array.isArray(parsed) ? parsed : [];
    const projection = projectExecutionJournal(persisted, declaredSteps);
    const map = {};
    for (const row of projection.rows) {
      if (row && typeof row.ordinal === 'number') {
        map[row.ordinal] = row;
      }
    }
    return { ...projection, map, persistedCount: persisted.length };
  }, [result.stepResults, declaredSteps]);
  const authoredStepRows = useMemo(
    () => projectAuthoredStepRows(declaredSteps, stepProjection.rows),
    [declaredSteps, stepProjection.rows],
  );
  const stepResults = stepProjection.map;
  const journalSummary = useMemo(() => {
    let persisted = result.journalSummary;
    if (typeof persisted === 'string') {
      try { persisted = JSON.parse(persisted); } catch { persisted = null; }
    }
    return persisted && typeof persisted === 'object' && Number.isFinite(Number(persisted.planned))
      ? persisted
      : stepProjection.summary;
  }, [result.journalSummary, stepProjection.summary]);
  const executionFullyCompleted = journalSummary.executionCompleted
    && journalSummary.notExecuted === 0
    && journalSummary.executed === journalSummary.planned;
  const firstNotExecuted = stepProjection.rows.find((row) => row.actionOutcome === 'not_executed');
  const incompleteReason = firstNotExecuted?.continuationReason
    || firstNotExecuted?.reason
    || (journalSummary.notExecuted > 0 ? 'One or more planned steps were not executed.' : '');

  // Live-step overlays for the case currently being executed.
  const liveOverlay = useMemo(() => {
    const overlay = {};
    if (!runId || !result.testCaseId) return overlay;
    const rowPrefix = `${runId}:${result.testCaseId}:${liveDataRowKey(result.dataRowIndex)}:`;
    const legacyPrefix = `${runId}:${result.testCaseId}:case:`;
    for (const k of Object.keys(liveStepStatus)) {
      const prefix = k.startsWith(rowPrefix) ? rowPrefix : k.startsWith(legacyPrefix) ? legacyPrefix : null;
      if (prefix) {
        const idx = Number(k.slice(prefix.length));
        if (!Number.isNaN(idx)) overlay[idx] = liveStepStatus[k];
      }
    }
    return overlay;
  }, [liveStepStatus, runId, result.testCaseId, result.dataRowIndex]);

  // Screenshots indexed by stepIndex so each declared step row can
  // render the latest frame the agent captured for that step (Batch
  // 4.2). Legacy runs (string-array screenshots) won't have a stepIndex
  // — they're skipped, which preserves backward compatibility.
  const screenshotsByStep = useMemo(() => {
    const map = new Map();
    const raw = Array.isArray(result.screenshots) ? result.screenshots : [];
    for (const entry of raw) {
      if (!entry || typeof entry === 'string') continue;
      if (typeof entry.stepIndex !== 'number') continue;
      // Keep the LAST frame for each step — most cases capture multiple
      // frames per step (e.g. one before, one after); the final one
      // shows the result of the step which is the most useful preview.
      map.set(entry.stepIndex, entry);
    }
    return map;
  }, [result.screenshots]);

  const hasDeclared = authoredStepRows.length > 0;
  const hasStepResults = stepProjection.persistedCount > 0 || Object.keys(liveOverlay).length > 0;

  // Trace lines parsed + humanised. Each line carries kind / verdict /
  // headline (plain English) / raw (original text for the disclosure).
  const traceLines = useMemo(() => {
    if (!result.trace) return [];
    const assertionContext = {
      allRecordedAssertionsMatched: resultHasAllRecordedAssertionsMatched(result),
    };
    return String(result.trace)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, i) => ({ order: i + 1, ...humanizeTraceLine(line, result.status, assertionContext) }));
  }, [result]);
  const declaredCount = authoredStepRows.length;
  const traceCount = traceLines.length;
  const resultStepCount = stepProjection.persistedCount;
  const actualTraceIsShort = hasDeclared && traceCount > 0 && traceCount < declaredCount;

  if (!hasDeclared && traceLines.length === 0) {
    return (
      <div className="text-center py-10 text-ink-500">
        <Layers className="w-10 h-10 text-ink-300 mx-auto mb-3" aria-hidden="true" />
        <p className="text-sm">No steps recorded for this test yet.</p>
        <p className="text-xs text-ink-400 mt-1">
          Execute the test from Live Pipeline to see its steps here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Pre-Batch-2 banner: declared steps exist but no step-level
          verdicts captured for this run. */}
      {hasDeclared && !hasStepResults && (
        <div className="rounded-card border border-info-200 bg-info-50/60 px-4 py-3 text-sm text-info-800 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 text-info-600 mt-0.5 shrink-0" aria-hidden="true" />
          <div>
            This run pre-dates per-step capture. The step list below shows what the test was meant to do; the run-time actions are in <strong>What QAAI actually did</strong> further down.
          </div>
        </div>
      )}

      {hasDeclared && (
        <section>
          <h3 className="font-display text-xl text-ink-900 mb-1">Planned step status</h3>
          <p className="text-sm text-ink-500 mb-4">
            {declaredCount} planned step{declaredCount === 1 ? '' : 's'} for this test case, with the status captured during this run.
          </p>
          {stepProjection.persistedCount > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-600 tabular-nums" aria-label="Execution journal summary">
              <span>{journalSummary.planned} planned</span>
              <span aria-hidden="true">·</span>
              <span>{journalSummary.executed} executed</span>
              <span aria-hidden="true">·</span>
              <span>{journalSummary.passed} passed</span>
              {journalSummary.notExecuted > 0 && (
                <>
                  <span aria-hidden="true">&middot;</span>
                  <span className="text-warn-700">{journalSummary.notExecuted} not executed</span>
                </>
              )}
              {journalSummary.validationFailed > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-danger-700">{journalSummary.validationFailed} validation{journalSummary.validationFailed === 1 ? '' : 's'} failed</span>
                </>
              )}
              {journalSummary.executionErrors > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-warn-700">{journalSummary.executionErrors} QAAI execution error{journalSummary.executionErrors === 1 ? '' : 's'}</span>
                </>
              )}
              {journalSummary.dependencySkipped > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{journalSummary.dependencySkipped} blocked by dependency</span>
                </>
              )}
              {executionFullyCompleted ? (
                <span className="font-semibold text-ink-800 ml-1">Execution completed</span>
              ) : journalSummary.pending > 0 ? (
                <span className="font-semibold text-info-700 ml-1">Execution still pending</span>
              ) : (
                <span className="font-semibold text-warn-700 ml-1">Execution incomplete</span>
              )}
            </div>
          )}
          {stepProjection.persistedCount > 0 && !executionFullyCompleted && incompleteReason && (
            <div className="-mt-2 mb-4 text-xs text-warn-800 bg-warn-50 border border-warn-200 rounded-md px-3 py-2 leading-relaxed">
              Stopped reason: {String(incompleteReason).slice(0, 260)}
            </div>
          )}
          <ol className="space-y-2">
            {authoredStepRows.map((logicalStep, idx) => {
              const stepNumber = idx + 1;
              const runtimeDetails = logicalStep.atomicActions.map((atomic) => ({
                ...atomic,
                verdict: liveOverlay[atomic.sourceOrdinal] || atomic.journal || stepResults[atomic.sourceOrdinal] || null,
              }));
              const verdict = summarizeAuthoredStepVerdict(runtimeDetails);
              const thumb = [...logicalStep.sourceOrdinals]
                .reverse()
                .map((ordinal) => screenshotsByStep.get(ordinal))
                .find(Boolean) || null;
              // Resolve this step's frame to its position in the shared `frames`
              // array so the lightbox opens at the right place and ◂ ▸ traverses
              // the whole capture sequence (not just this one step).
              const thumbIndex = thumb ? frames.findIndex((fr) => fr.url === thumb.url) : -1;
              return (
                <DeclaredStepRow
                  key={logicalStep.id}
                  step={logicalStep.step}
                  number={stepNumber}
                  verdict={verdict}
                  runtimeDetails={runtimeDetails}
                  thumbnail={thumb}
                  onOpenThumbnail={(thumbIndex >= 0 && onOpenFrame) ? () => onOpenFrame(thumbIndex) : null}
                />
              );
            })}
          </ol>
        </section>
      )}

      {traceLines.length > 0 && (
        <section>
          <div className="flex items-end justify-between gap-4 mb-4 flex-wrap">
            <div>
              <h3 className="font-display text-xl text-ink-900 mb-1">Actual browser actions</h3>
              <p className="text-sm text-ink-500">
                {traceCount} persisted browser action{traceCount === 1 ? '' : 's'} from the Conductor trace. This can be shorter than the planned steps when a case stops early or grouped form actions are replayed together.
              </p>
            </div>
            <button
              type="button"
              onClick={toggleRaw}
              aria-pressed={showRawTrace}
              className={`inline-flex items-center gap-1.5 px-3 h-8 rounded-pill text-2xs font-semibold uppercase tracking-wider border transition-all ${
                showRawTrace
                  ? 'bg-ink-900 text-white border-ink-900'
                  : 'bg-white text-ink-600 border-ink-200 hover:border-ink-400'
              }`}
              title="Append the raw conductor trace under each step (developer view)"
            >
              <Code2 className="w-3.5 h-3.5" aria-hidden="true" />
              {showRawTrace ? 'Raw trace shown' : 'Show raw trace'}
            </button>
          </div>
          {actualTraceIsShort && (
            <div className="mb-4 rounded-card border border-warn-200 bg-warn-50/70 px-4 py-3 text-sm text-warn-800 flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-warn-600 mt-0.5 shrink-0" aria-hidden="true" />
              <div>
                This trace has {traceCount} actual action{traceCount === 1 ? '' : 's'} for {declaredCount} planned step{declaredCount === 1 ? '' : 's'}.
                {resultStepCount > 0 ? ` Step status is preserved above for ${resultStepCount} step${resultStepCount === 1 ? '' : 's'}.` : ''}
              </div>
            </div>
          )}
          <ol className="space-y-1.5">
            {traceLines.map((line) => (
              <TraceLineRow key={line.order} line={line} showRaw={showRawTrace} />
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function ExecutionJournalEvidence({ verdict }) {
  const checks = buildStepEvidenceRows(verdict);
  const continuation = buildStepContinuation(verdict);
  if (checks.length === 0 && !continuation) return null;

  return (
    <div className="mt-2 space-y-2">
      {checks.map((check) => {
        const failed = check.outcome === 'not_matched';
        const uncheckable = check.outcome === 'uncheckable';
        const tone = failed ? 'border-danger-200 bg-danger-50/70 text-danger-800'
          : uncheckable ? 'border-warn-200 bg-warn-50/70 text-warn-800'
            : 'border-ink-200 bg-ink-50/70 text-ink-700';
        return (
          <div key={check.id} className={`rounded-md border px-3 py-2 text-xs leading-relaxed ${tone}`}>
            <div className="font-semibold capitalize">{check.outcome.replace(/_/g, ' ')}</div>
            <dl className="mt-1 grid gap-x-3 gap-y-0.5 sm:grid-cols-[auto_1fr]">
              {check.expected && <><dt className="font-semibold">Expected</dt><dd className="min-w-0 break-words">{check.expected}</dd></>}
              {check.actual && <><dt className="font-semibold">Actual</dt><dd className="min-w-0 break-words">{check.actual}</dd></>}
              {check.comparator && <><dt className="font-semibold">Comparator</dt><dd className="min-w-0 break-words">{check.comparator}</dd></>}
              {check.reason && <><dt className="font-semibold">Reason</dt><dd className="min-w-0 break-words">{check.reason}</dd></>}
              {check.evidence && <><dt className="font-semibold">Evidence</dt><dd className="min-w-0 break-words">{check.evidence}</dd></>}
            </dl>
          </div>
        );
      })}
      {continuation && (
        <div className="text-xs text-ink-600">
          {continuation.label && <span className="font-semibold text-ink-800">{continuation.label}.</span>}
          {continuation.reason && <span>{continuation.label ? ' ' : ''}{continuation.reason}</span>}
        </div>
      )}
    </div>
  );
}

function DeclaredStepRow({ step, number, verdict, runtimeDetails = [], thumbnail, onOpenThumbnail }) {
  const rawStatus = verdict?.status || 'pending';
  // CONSISTENCY GUARD (Rule 8): a step must NOT render as Passed while it carries a
  // blocking error or a failed operation/assertion check. Mirrors the backend
  // reconcile so the UI can never show a green PASS sitting on top of a red failure
  // (the exact contradiction in the audited screenshot). Note: `evidence`/`reason`
  // are present on legitimate passes, so only a real `error` or a failed check
  // (matched === false) triggers the downgrade — never mere evidence text.
  const opFailedRow = (verdict?.operationCheck || verdict?.stepOperationCheck)?.matched === false;
  const asFailedRow = (verdict?.assertion || verdict?.stepAssertion)?.matched === false;
  const blockingErrorRow = typeof verdict?.error === 'string' && verdict.error.trim() && !/^mechanical_v1:/i.test(verdict.error);
  // Mirror the backend reconcile (audit #3): blocking failure stored only in
  // evidence/reason (no `error`, no matched===false) must also block a green render.
  // Phrase list is curated to NOT collide with benign pass evidence.
  const STEP_BLOCKING_TEXT_RE = /\b(no records found|no results found|no matching record|returned no results|did not match|did not reach|does not contain|not committed on the control|selection has not taken|could not be selected|was rejected|blocked because|test[_ ]data[_ ]invalid|effect was not proven)\b/i;
  // PRIMARY blocking signal = structured reason codes (regex below is the fallback for
  // legacy text-only rows). Mirrors the backend BLOCKING_REASON_CODES set.
  const STEP_BLOCKING_REASONS = new Set(['test_data_invalid', 'test_data_invalid_dependency', 'evidence_missing', 'wrong_tool', 'value_wrong_tool', 'value_mismatch', 'selection_not_reflected', 'selected_not_reflected', 'checked_not_reflected', 'autocomplete_no_results', 'autocomplete_not_selected', 'result_no_match', 'result_needs_intent', 'url_not_reached', 'visible_not_confirmed', 'hidden_not_confirmed']);
  const blockingTextRow = STEP_BLOCKING_TEXT_RE.test(String(verdict?.evidence || '')) || STEP_BLOCKING_TEXT_RE.test(String(verdict?.reason || ''));
  const blockingReasonRow = verdict?.reason && STEP_BLOCKING_REASONS.has(String(verdict.reason));
  const diagnosticText = [
    verdict?.reason,
    verdict?.error,
    verdict?.evidence,
    verdict?.continuationReason,
    verdict?.failureType,
    verdict?.failureImpact,
    (verdict?.operationCheck || verdict?.stepOperationCheck)?.reason,
    (verdict?.operationCheck || verdict?.stepOperationCheck)?.evidence,
  ].filter(Boolean).join(' ').toLowerCase();
  const dependencyNotExecuted = verdict?.actionOutcome === 'not_executed'
    || verdict?.dependencySkipped === true
    || /dependency/.test(String(verdict?.failureType || verdict?.failureImpact || '').toLowerCase());
  const qaaiExecutionError = verdict?.executionError === true
    || verdict?.qaaiExecutionError === true
    || /qaai_execution_error|evidence_acquisition_failed|snapshot_(?:unavailable|missing|empty)|fresh_snapshot_(?:unavailable|missing|empty)/.test(diagnosticText)
    || /cached state.+fresh validation snapshot|fresh validation snapshot.+did not confirm/.test(diagnosticText);
  const validationFailed = !dependencyNotExecuted && !qaaiExecutionError
    && verdict?.actionOutcome !== 'failed'
    && (verdict?.assertionOutcome === 'not_matched' || asFailedRow);
  const reconciledStatus = (!verdict?.actionOutcome && rawStatus === 'pass' && (opFailedRow || asFailedRow || blockingErrorRow || blockingTextRow || blockingReasonRow))
    ? (asFailedRow ? 'fail' : 'blocked')
    : rawStatus;
  const status = dependencyNotExecuted
    ? 'not_executed'
    : qaaiExecutionError
      ? 'qaai_error'
      : validationFailed
        ? 'validation_failed'
        : reconciledStatus;
  const tone = {
    pass:    { ring: 'ring-success-200', chip: 'bg-success-50 text-success-700', icon: CheckCircle2, iconCls: 'text-success-600', label: 'Passed' },
    fail:    { ring: 'ring-danger-200',  chip: 'bg-danger-50 text-danger-700',   icon: XCircle,      iconCls: 'text-danger-600',  label: 'Failed' },
    blocked: { ring: 'ring-warn-200',    chip: 'bg-warn-50 text-warn-700',       icon: AlertCircle,  iconCls: 'text-warn-600',    label: 'Blocked' },
    qaai_error: { ring: 'ring-warn-200', chip: 'bg-warn-50 text-warn-700', icon: AlertCircle, iconCls: 'text-warn-600', label: 'QAAI execution error' },
    validation_failed: { ring: 'ring-danger-200', chip: 'bg-danger-50 text-danger-700', icon: XCircle, iconCls: 'text-danger-600', label: 'Validation failed' },
    not_executed: { ring: 'ring-ink-200', chip: 'bg-ink-100 text-ink-600', icon: Minus, iconCls: 'text-ink-500', label: 'Not executed' },
    skipped: { ring: 'ring-ink-200',     chip: 'bg-ink-100 text-ink-500',         icon: Minus,        iconCls: 'text-ink-400',     label: 'Skipped' },
    running: { ring: 'ring-info-300/70 ring-2 animate-pulse', chip: 'bg-info-50 text-info-700', icon: Loader2, iconCls: 'text-info-600 animate-spin', label: 'Running' },
    pending: { ring: 'ring-ink-200',     chip: 'bg-ink-50 text-ink-500',          icon: Circle,       iconCls: 'text-ink-400',     label: 'Not yet run' },
  }[status] || { ring: 'ring-ink-200', chip: 'bg-ink-50 text-ink-500', icon: Circle, iconCls: 'text-ink-400', label: status };

  const Icon = tone.icon;
  const description = formatStepDescription(step);
  const duration = verdict?.durationMs ? `${(verdict.durationMs / 1000).toFixed(1)}s` : null;
  const assertion = verdict?.assertion || verdict?.stepAssertion || null;
  const operationCheck = verdict?.operationCheck || verdict?.stepOperationCheck || null;
  const stepNarrative = buildStepReportNarrative({ step, number, verdict });

  return (
    <li className={`rounded-card bg-white border border-ink-200 ring-1 ${tone.ring} px-4 py-3 flex items-start gap-3`}>
      <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-ink-50 text-ink-700 text-xs font-bold tabular-nums shrink-0 mt-0.5">
        {number}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex-1 min-w-0 text-sm text-ink-800 leading-relaxed">
            {description}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {duration && <span className="text-2xs text-ink-500 tabular-nums">{duration}</span>}
            <span className={`inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider px-2 py-0.5 rounded-pill ${tone.chip}`}>
              <Icon className={`w-3 h-3 ${tone.iconCls}`} aria-hidden="true" />
              {tone.label}
            </span>
          </div>
        </div>
        <AuthoredExecutionDetails
          authoredText={authoredStepText(step)}
          details={runtimeDetails}
        />
        <StepOperationCheckSummary operationCheck={operationCheck} verdict={verdict} />
        <StepAssertionSummary assertion={assertion} verdict={verdict} />
        <ExecutionJournalEvidence verdict={verdict} />
        <StepReportNarrative narrative={stepNarrative} />
        {!stepNarrative && (verdict?.error || verdict?.evidence || verdict?.reason) && (
          <div className="mt-2 text-xs text-danger-700 bg-danger-50 border border-danger-200 rounded-md px-3 py-2 leading-relaxed">
            {verdict.error || verdict.evidence || verdict.reason}
          </div>
        )}
        {thumbnail?.url && (
          // Opens the shared half-screen lightbox (◂ ▸ across all frames). Falls
          // back to opening the raw image in a new tab on legacy data where the
          // frame couldn't be resolved into the gallery's frames array.
          onOpenThumbnail ? (
            <button
              type="button"
              onClick={onOpenThumbnail}
              className="mt-2.5 block rounded-md border border-ink-200 bg-ink-50 overflow-hidden hover:border-ink-400 transition-colors w-full max-w-[280px] cursor-zoom-in"
              title={thumbnail.action || `Step ${number} screenshot — click to enlarge`}
            >
              <img
                src={absUrl(thumbnail.url)}
                alt={thumbnail.action || `Step ${number} screenshot`}
                loading="lazy"
                className="block w-full h-auto"
                onError={(e) => { e.target.style.display = 'none'; }}
              />
            </button>
          ) : (
            <a
              href={absUrl(thumbnail.url)}
              target="_blank"
              rel="noreferrer"
              className="mt-2.5 block rounded-md border border-ink-200 bg-ink-50 overflow-hidden hover:border-ink-400 transition-colors w-full max-w-[280px]"
              title={thumbnail.action || `Step ${number} screenshot`}
            >
              <img
                src={absUrl(thumbnail.url)}
                alt={thumbnail.action || `Step ${number} screenshot`}
                loading="lazy"
                className="block w-full h-auto"
                onError={(e) => { e.target.style.display = 'none'; }}
              />
            </a>
          )
        )}
      </div>
    </li>
  );
}

function AuthoredExecutionDetails({ authoredText, details }) {
  const visible = (Array.isArray(details) ? details : []).filter((detail) => {
    const interpreted = String(detail?.text || '').trim();
    return interpreted && (
      details.length > 1
      || interpreted !== String(authoredText || '').trim()
    );
  });
  if (!visible.length) return null;

  return (
    <details className="mt-2 rounded-md border border-ink-200 bg-ink-50/60 px-3 py-2">
      <summary className="cursor-pointer select-none text-2xs font-semibold uppercase tracking-wider text-ink-600">
        View {visible.length} interpreted execution action{visible.length === 1 ? '' : 's'}
      </summary>
      <ol className="mt-2 space-y-2">
        {visible.map((detail, index) => {
          const verdict = detail.verdict || null;
          const status = String(verdict?.status || (
            verdict?.actionOutcome === 'succeeded'
              ? 'pass'
              : verdict?.actionOutcome === 'failed'
                ? 'fail'
                : verdict?.actionOutcome === 'not_executed'
                  ? 'not_executed'
                  : 'pending'
          )).toLowerCase();
          const tone = ['pass', 'passed', 'success', 'succeeded'].includes(status)
            ? 'bg-success-50 text-success-700'
            : ['fail', 'failed', 'validation_failed'].includes(status)
              ? 'bg-danger-50 text-danger-700'
              : ['blocked', 'qaai_error'].includes(status)
                ? 'bg-warn-50 text-warn-700'
                : 'bg-ink-100 text-ink-600';
          const evidence = verdict?.evidence
            || verdict?.observedState
            || verdict?.reason
            || verdict?.continuationReason
            || null;
          return (
            <li key={detail.id || `${index}:${detail.text}`} className="text-xs text-ink-700">
              <div className="flex items-start gap-2">
                <span className="shrink-0 tabular-nums text-ink-500">{index + 1}.</span>
                <span className="min-w-0 flex-1 leading-relaxed">{detail.text}</span>
                <span className={`shrink-0 rounded-pill px-1.5 py-0.5 text-2xs font-semibold ${tone}`}>
                  {status.replace(/_/g, ' ')}
                </span>
              </div>
              {evidence && (
                <div className="ml-5 mt-1 text-2xs leading-relaxed text-ink-500">
                  {String(evidence).replace(/\s+/g, ' ').trim().slice(0, 260)}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

function StepReportNarrative({ narrative }) {
  if (!narrative) return null;
  const tone = {
    success: { border: 'border-success-200', bg: 'bg-success-50/70', text: 'text-success-800', icon: CheckCircle2, iconCls: 'text-success-600' },
    danger: { border: 'border-danger-200', bg: 'bg-danger-50/80', text: 'text-danger-800', icon: XCircle, iconCls: 'text-danger-600' },
    warn: { border: 'border-warn-200', bg: 'bg-warn-50/80', text: 'text-warn-800', icon: AlertCircle, iconCls: 'text-warn-600' },
  }[narrative.tone] || { border: 'border-ink-200', bg: 'bg-ink-50', text: 'text-ink-700', icon: AlertCircle, iconCls: 'text-ink-500' };
  const Icon = tone.icon;
  return (
    <div className={`mt-2 rounded-md border ${tone.border} ${tone.bg} px-3 py-2`}>
      <div className={`flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider ${tone.text}`}>
        <Icon className={`w-3.5 h-3.5 shrink-0 ${tone.iconCls}`} aria-hidden="true" />
        {narrative.title}
      </div>
      <div className="mt-1.5 space-y-1 text-xs text-ink-700 leading-relaxed">
        {narrative.checked && <div><span className="font-semibold text-ink-800">Checked:</span> {narrative.checked}</div>}
        {narrative.observed && <div><span className="font-semibold text-ink-800">Observed:</span> {narrative.observed}</div>}
        {narrative.conclusion && <div><span className="font-semibold text-ink-800">Conclusion:</span> {narrative.conclusion}</div>}
      </div>
    </div>
  );
}

// operationCheck/assertion sub-objects declare a REQUIREMENT (condition,
// expected, kind) — they never carry their own resolved `.matched`. The
// requirement's real resolution is the parent step's own status: a required
// check gates whether the step commits, so `verdict.status` IS the
// resolution. Without this, every check rendered as permanently "Pending"/
// "uncheckable" regardless of whether the step actually passed.
function resolvedCheckMatched(check, verdict) {
  if (check?.matched === true || check?.matched === false) return check.matched;
  const stepStatus = verdict?.status;
  if (stepStatus === 'pass') return true;
  if (stepStatus === 'fail' || stepStatus === 'blocked') return false;
  return null;
}

function StepOperationCheckSummary({ operationCheck, verdict }) {
  if (!operationCheck) return null;
  const matched = resolvedCheckMatched(operationCheck, verdict);
  const status = operationCheck.status || (matched === true ? 'pass' : matched === false ? 'fail' : 'pending');
  const tone = {
    pass: { border: 'border-success-300', icon: CheckCircle2, iconCls: 'text-success-600', chip: 'bg-success-50 text-success-700', label: 'Synced' },
    fail: { border: 'border-warn-300', icon: AlertCircle, iconCls: 'text-warn-600', chip: 'bg-warn-50 text-warn-700', label: 'Blocked' },
    blocked: { border: 'border-warn-300', icon: AlertCircle, iconCls: 'text-warn-600', chip: 'bg-warn-50 text-warn-700', label: 'Blocked' },
    warning: { border: 'border-warn-300', icon: AlertCircle, iconCls: 'text-warn-600', chip: 'bg-warn-50 text-warn-700', label: 'Checkpoint' },
    running: { border: 'border-info-300', icon: Loader2, iconCls: 'text-info-600 animate-spin', chip: 'bg-info-50 text-info-700', label: 'Checking' },
    skipped: { border: 'border-ink-300', icon: AlertCircle, iconCls: 'text-ink-500', chip: 'bg-ink-100 text-ink-600', label: 'Recorded' },
    pending: { border: 'border-ink-200', icon: Circle, iconCls: 'text-ink-400', chip: 'bg-ink-50 text-ink-500', label: 'Pending' },
  }[status] || { border: 'border-info-300', icon: AlertCircle, iconCls: 'text-info-600', chip: 'bg-info-50 text-info-700', label: 'Check' };
  const Icon = tone.icon;
  const expected = operationCheck.expected != null ? String(operationCheck.expected).replace(/\s+/g, ' ').trim() : '';
  const detail = operationCheck.evidence || operationCheck.reason || verdict?.reason || '';
  return (
    <div className={`mt-2 border-l-2 ${tone.border} pl-3 py-1.5`}>
      <div className="flex items-center gap-2 flex-wrap">
        <Icon className={`w-3.5 h-3.5 shrink-0 ${tone.iconCls}`} aria-hidden="true" />
        <span className="text-2xs font-semibold uppercase tracking-wider text-ink-500">Assertion validation</span>
        <span className={`inline-flex items-center px-1.5 py-0.5 rounded-pill text-2xs font-semibold ${tone.chip}`}>
          {tone.label}
        </span>
      </div>
      {expected && (
        <div className="mt-1 text-xs text-ink-600 leading-relaxed">
          Required: <span className="text-ink-800">{expected.slice(0, 180)}</span>
        </div>
      )}
      {detail && (
        <div className="mt-0.5 text-2xs text-ink-500 leading-relaxed">
          {String(detail).replace(/\s+/g, ' ').trim().slice(0, 220)}
        </div>
      )}
    </div>
  );
}

function StepAssertionSummary({ assertion, verdict }) {
  if (!assertion) return null;
  const matched = resolvedCheckMatched(assertion, verdict);
  const status = assertion.status || (matched === true ? 'pass' : matched === false ? 'fail' : 'pending');
  const tone = {
    pass: { border: 'border-success-300', icon: CheckCircle2, iconCls: 'text-success-600', chip: 'bg-success-50 text-success-700', label: 'Matched' },
    fail: { border: 'border-danger-300', icon: XCircle, iconCls: 'text-danger-600', chip: 'bg-danger-50 text-danger-700', label: 'Not matched' },
    running: { border: 'border-info-300', icon: Loader2, iconCls: 'text-info-600 animate-spin', chip: 'bg-info-50 text-info-700', label: 'Validating' },
    skipped: { border: 'border-ink-300', icon: AlertCircle, iconCls: 'text-ink-500', chip: 'bg-ink-100 text-ink-600', label: 'Recorded' },
    pending: { border: 'border-ink-200', icon: Circle, iconCls: 'text-ink-400', chip: 'bg-ink-50 text-ink-500', label: 'Pending' },
  }[status] || { border: 'border-info-300', icon: AlertCircle, iconCls: 'text-info-600', chip: 'bg-info-50 text-info-700', label: 'Validation' };
  const Icon = tone.icon;
  const expected = assertion.expected != null ? String(assertion.expected).replace(/\s+/g, ' ').trim() : '';
  const detail = assertion.evidence || assertion.reason || verdict?.reason || '';
  return (
    <div className={`mt-2 border-l-2 ${tone.border} pl-3 py-1.5`}>
      <div className="flex items-center gap-2 flex-wrap">
        <Icon className={`w-3.5 h-3.5 shrink-0 ${tone.iconCls}`} aria-hidden="true" />
        <span className="text-2xs font-semibold uppercase tracking-wider text-ink-500">Verification point</span>
        <span className={`inline-flex items-center px-1.5 py-0.5 rounded-pill text-2xs font-semibold ${tone.chip}`}>
          {tone.label}
        </span>
      </div>
      {expected && (
        <div className="mt-1 text-xs text-ink-600 leading-relaxed">
          Expected: <span className="text-ink-800">{expected.slice(0, 180)}</span>
        </div>
      )}
      {detail && (
        <div className="mt-0.5 text-2xs text-ink-500 leading-relaxed">
          {String(detail).replace(/\s+/g, ' ').trim().slice(0, 220)}
        </div>
      )}
    </div>
  );
}

// Render a declared step as a sentence. Accepts either `{action, target,
// value, expected}` or a simple `description` / `text` field. Falls back
// to JSON stringification only as a last resort.
function formatStepDescription(step) {
  if (!step) return '—';
  if (typeof step === 'string') return step;
  if (step.authoredText || step.userAuthoredText || step.raw?.authoredText) {
    return authoredStepText(step);
  }
  if (step.description) return step.description;
  if (step.text) return step.text;
  const parts = [];
  if (step.action) parts.push(capitalize(step.action));
  // Phase F.3 — prefer the new canonical `element` field; fall back to legacy
  // `target` for older runs. `locator_hint` shown separately as a quieter chip
  // so reviewers can see the CSS hint without confusing it with the element.
  const elementLabel = step.element || step.target;
  if (elementLabel) parts.push(<span key="t" className="text-ink-700 bg-ink-50 border border-ink-200 rounded px-1.5 py-0.5 text-xs">{elementLabel}</span>);
  if (step.locator_hint) parts.push(<span key="h" className="font-mono text-ink-500 text-2xs" title="Selector hint">[{step.locator_hint}]</span>);
  if (step.value) parts.push(<span key="v"> with <span className="text-ink-700">"{step.value}"</span></span>);
  if (parts.length === 0) return JSON.stringify(step);
  return (
    <>
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 && ' '}
          {p}
        </React.Fragment>
      ))}
      {step.expected && (
        <div className="mt-1 text-xs text-ink-500 leading-relaxed">
          Expected: <span className="text-ink-700">{step.expected}</span>
        </div>
      )}
    </>
  );
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// One row in the chronological "What QAAI actually did" list. Headline
// is the plain-English narration; when the page-level `showRaw` toggle
// is on, the original conductor line is shown as muted mono text below
// (developer view) — otherwise we hide it entirely so the per-line "▸
// Technical details" disclosure that just repeated the headline is gone.
function TraceLineRow({ line, showRaw }) {
  const verdictTone = {
    pass: { icon: CheckCircle2, iconCls: 'text-success-600', text: 'text-ink-800' },
    fail: { icon: XCircle,      iconCls: 'text-danger-600',  text: 'text-danger-800' },
    internal: { icon: AlertCircle, iconCls: 'text-info-600', text: 'text-info-800' },
  }[line.verdict] || { icon: Circle, iconCls: 'text-ink-400', text: 'text-ink-700' };
  const Icon = verdictTone.icon;
  const isError = line.kind === 'error';
  const isInternal = line.kind === 'internal';
  const showRawForThisLine = showRaw && !isError && String(line.raw).trim() !== line.headline.trim();
  return (
    <li className={`rounded-md px-3 py-2 flex items-start gap-3 ${
      isError ? 'bg-danger-50/50' : isInternal ? 'bg-info-50/60' : 'hover:bg-ink-50/60'
    }`}>
      <span className="inline-flex items-center justify-center w-6 h-6 rounded-full text-2xs font-bold tabular-nums shrink-0 mt-0.5 bg-white border border-ink-200 text-ink-600">
        {line.order}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2">
          {!isError && <Icon className={`w-3.5 h-3.5 mt-1 shrink-0 ${verdictTone.iconCls}`} aria-hidden="true" />}
          <span className={`text-sm leading-relaxed ${verdictTone.text} ${isError ? 'font-mono text-xs' : ''}`}>
            {line.headline}
          </span>
        </div>
        {showRawForThisLine && (
          <pre className="mt-1.5 text-2xs font-mono text-ink-500 bg-ink-50 border border-ink-200 rounded px-2 py-1.5 whitespace-pre-wrap break-all leading-relaxed">
            {line.raw}
          </pre>
        )}
      </div>
    </li>
  );
}

// ── Trace humaniser ─────────────────────────────────────────────────
// Parses one persisted trace line into { kind, verdict, headline, raw }.
// The conductor writes lines in three shapes (see stringifyAction in
// server/services/agents/conductor.js):
//   1. `▶ <tool>(<jsonArgs>) <verdict>`             — every tool call
//   2. `ASSERTION: ✓|✗ "<claim>" — <evidence>`       — assertion_check
//   3. Free text — stack traces, error stderr, etc.
// We strip the leading ▶ before matching and humanise the tool name +
// args into past-tense English so the operator never reads raw JSON.
function legacyHumanizeTraceLine(rawLine) {
  const line = String(rawLine).replace(/^\s*▶\s*/, '').trim();
  const internalEvidenceLine = isInternalEvidenceText(line);
  const assertionMatch = /^ASSERTION:\s*(.+)$/s.exec(line);
  if (assertionMatch) {
    const text = assertionMatch[1].trim();
    let verdict = null;
    let body = text;
    if (text.startsWith('✓') || text.startsWith('PASS')) { verdict = 'pass'; body = text.replace(/^✓\s*/, '').replace(/^PASS\s*/, ''); }
    else if (text.startsWith('✗') || text.startsWith('FAIL') || text.startsWith('X')) { verdict = 'fail'; body = text.replace(/^✗\s*/, '').replace(/^FAIL\s*/, '').replace(/^X\s*/, ''); }
    return { kind: 'assertion', verdict, headline: `Verified: ${body}`, raw: rawLine };
  }
  const toolMatch = /^(\w+)\(([\s\S]*)\)\s*(✓|✗|X)?(?:\s+(.+))?$/.exec(line);
  if (toolMatch) {
    const [, tool, argsRaw, mark, tail] = toolMatch;
    let args = {};
    try { args = JSON.parse(argsRaw); } catch { /* args may be too large or contain a fn body */ }
    if (internalEvidenceLine || isInternalEvidenceText(tail)) {
      return {
        kind: 'internal',
        verdict: 'internal',
        headline: `${humanizeAction(tool, args)} — held by QAAI evidence capture in this saved run. Rerun with the current engine.`,
        raw: rawLine,
      };
    }
    const verdict = mark === '✓' ? 'pass' : (mark === '✗' || mark === 'X') ? 'fail' : null;
    const headline = verdict === 'fail' && tail
      ? `${humanizeAction(tool, args)} — couldn't complete (${shortenError(tail)})`
      : humanizeAction(tool, args);
    return { kind: 'action', verdict, headline, raw: rawLine };
  }
  if (internalEvidenceLine) {
    return {
      kind: 'internal',
      verdict: 'internal',
      headline: 'QAAI evidence capture held this saved run before a website verdict. Rerun with the current engine.',
      raw: rawLine,
    };
  }
  return { kind: 'error', verdict: null, headline: line, raw: rawLine };
}

function humanizeTraceLine(rawLine, resultStatus = null, assertionContext = {}) {
  const line = String(rawLine).replace(/^\s*(?:\u25b6|\u00e2\u2013\u00b6)\s*/, '').trim();
  const internalEvidenceLine = isInternalEvidenceText(line);
  const assertionMatch = /^ASSERTION:\s*(.+)$/s.exec(line);
  if (assertionMatch) {
    const { verdict: parsedVerdict, body } = parseTraceVerdictPrefix(assertionMatch[1]);
    const verdict = parsedVerdict || inferAssertionTraceVerdict(body, resultStatus, assertionContext);
    return { kind: 'assertion', verdict, headline: `Verified: ${body}`, raw: rawLine };
  }
  const terminalStopMatch = /^STOP:\s*(.+?)(?:\s+[—-]\s+(.+))?$/s.exec(line);
  if (terminalStopMatch) {
    const [, title, note] = terminalStopMatch;
    const reason = String(note || '').trim();
    return {
      kind: 'stop',
      verdict: 'fail',
      headline: reason ? `Stopped: ${title.trim()} - ${reason}` : `Stopped: ${title.trim()}`,
      raw: rawLine,
    };
  }
  const engineMatch = /^ENGINE:\s*(\S+)(?:\s+(.+?))?(?:\s+(\u2713|\u2717|X|PASS\b|FAIL\b|OK\b|ERROR\b).*)?$/is.exec(line);
  if (engineMatch) {
    const [, tool, labelRaw, markRaw] = engineMatch;
    const { verdict } = parseTraceVerdictPrefix(markRaw || '');
    const label = String(labelRaw || '').replace(/\s*(?:\u2713|\u2717|X|PASS\b|FAIL\b|OK\b|ERROR\b).*$/i, '').trim();
    return {
      kind: 'engine',
      verdict: verdict || null,
      headline: label ? `Engine action: ${humanizeEngineTool(tool)} ${label}` : `Engine action: ${humanizeEngineTool(tool)}`,
      raw: rawLine,
    };
  }
  const toolMatch = /^(\w+)\(([\s\S]*)\)\s*(.*)?$/.exec(line);
  if (toolMatch) {
    const [, tool, argsRaw, tailRaw] = toolMatch;
    const { verdict, body: tail } = parseTraceVerdictPrefix(tailRaw || '');
    let args = {};
    try { args = JSON.parse(argsRaw); } catch { /* args may be too large or contain a fn body */ }
    if (internalEvidenceLine || isInternalEvidenceText(tail)) {
      return {
        kind: 'internal',
        verdict: 'internal',
        headline: `${humanizeAction(tool, args)} â€” held by QAAI evidence capture in this saved run. Rerun with the current engine.`,
        raw: rawLine,
      };
    }
    const headline = verdict === 'fail' && tail
      ? `${humanizeAction(tool, args)} â€” couldn't complete (${shortenError(tail)})`
      : humanizeAction(tool, args);
    return { kind: 'action', verdict, headline, raw: rawLine };
  }
  if (internalEvidenceLine) {
    return {
      kind: 'internal',
      verdict: 'internal',
      headline: 'QAAI evidence capture held this saved run before a website verdict. Rerun with the current engine.',
      raw: rawLine,
    };
  }
  return { kind: 'error', verdict: null, headline: line, raw: rawLine };
}

function humanizeEngineTool(tool) {
  switch (tool) {
    case 'deterministic_dom_fill':
    case 'deterministic_dom_fill_recovery':
      return 'filled';
    case 'deterministic_dom_click':
    case 'deterministic_dom_click_recovery':
      return 'clicked';
    case 'browser_fill_form':
      return 'filled';
    case 'browser_click':
      return 'clicked';
    case 'browser_select_option':
      return 'selected';
    case 'browser_navigate':
      return 'opened';
    default:
      return String(tool || 'completed').replace(/_/g, ' ');
  }
}

function normaliseTraceMarkers(value) {
  return String(value || '')
    .replace(/\u00e2\u0153[\u201c\u0093]/g, '\u2713')
    .replace(/\u00e2\u0153[\u2014\u0097]/g, '\u2717')
    .trim();
}

function parseTraceVerdictPrefix(value) {
  const text = normaliseTraceMarkers(value);
  if (!text) return { verdict: null, body: '' };
  if (/^(?:\u2713|\u2714|\u2705|PASS\b|OK\b)/i.test(text)) {
    return {
      verdict: 'pass',
      body: text.replace(/^(?:\u2713|\u2714|\u2705|PASS\b|OK\b)\s*/i, '').trim(),
    };
  }
  if (/^(?:\u2717|\u2718|\u274c|FAIL\b|FAILED\b|X\b|ERROR\b)/i.test(text)) {
    return {
      verdict: 'fail',
      body: text.replace(/^(?:\u2717|\u2718|\u274c|FAIL\b|FAILED\b|X\b|ERROR\b)\s*/i, '').trim(),
    };
  }
  if (/\b(?:text|role|url|eval):OK\b/i.test(text) || /\bmatched\s*[:=]\s*true\b/i.test(text)) {
    return { verdict: 'pass', body: text };
  }
  if (/\b(?:not_matched|matched\s*[:=]\s*false|assertion_check failed)\b/i.test(text)) {
    return { verdict: 'fail', body: text };
  }
  return { verdict: null, body: text };
}

function inferAssertionTraceVerdict(body, resultStatus, assertionContext = {}) {
  if (isInternalEvidenceText(body)) return 'internal';
  if (assertionContext.allRecordedAssertionsMatched) return 'pass';
  if (String(resultStatus || '').toLowerCase() === 'pass') return 'pass';
  return null;
}

function isInternalEvidenceText(value) {
  const text = String(value || '').toLowerCase();
  return text.includes('critical_evidence_gap')
    || text.includes('missing_verified_action_locator')
    || text.includes('internal evidence gap')
    || text.includes('internal evidence/export gap');
}

function shortenError(s) {
  const first = String(s).split('\n').find(Boolean) || '';
  return first.length > 120 ? `${first.slice(0, 117)}…` : first;
}

function humanizeAction(tool, args = {}) {
  switch (tool) {
    case 'browser_navigate':
      return args.url ? `Opened ${shortenUrl(args.url)}` : 'Opened a page';
    case 'browser_click':
      return args.element ? `Clicked ${args.element}` : 'Clicked an element';
    case 'browser_fill_form':
      if (Array.isArray(args.fields) && args.fields.length) {
        const names = args.fields.map((f) => f.name || f.field || f.label).filter(Boolean);
        if (names.length === 1) return `Filled in the ${names[0]} field`;
        if (names.length <= 3) return `Filled in ${names.join(', ')}`;
        return `Filled in ${names.length} form fields`;
      }
      return 'Filled in the form';
    case 'browser_type':
      return args.element ? `Typed into ${args.element}` : 'Typed into a field';
    case 'browser_press_key':
      return args.key ? `Pressed the ${args.key} key` : 'Pressed a key';
    case 'browser_select_option':
      return args.element ? `Selected ${args.element}` : 'Selected an option';
    case 'browser_hover':
      return args.element ? `Hovered over ${args.element}` : 'Hovered over an element';
    case 'browser_wait_for':
      if (args.text) return `Waited for "${args.text}" to appear`;
      if (args.time) return `Waited ${args.time}s`;
      return 'Waited for the page';
    case 'browser_snapshot':
      return 'Read the page contents';
    case 'browser_take_screenshot':
      return 'Took a screenshot';
    case 'browser_evaluate':
      return 'Ran a script in the page';
    case 'browser_handle_dialog':
      return args.action ? `Handled the popup (${args.action})` : 'Handled a popup dialog';
    case 'browser_drag':
      return 'Dragged an element';
    case 'browser_close':
      return 'Closed the browser tab';
    case 'browser_resize':
      return args.width && args.height ? `Resized the window to ${args.width}×${args.height}` : 'Resized the window';
    case 'assertion_check':
      return args.statement ? `Verified: ${args.statement}` : 'Verified an expected outcome';
    default:
      return tool.replace(/^browser_/, '').replace(/_/g, ' ');
  }
}

function shortenUrl(u) {
  try {
    const url = new URL(u);
    const path = url.pathname === '/' ? '' : url.pathname;
    return `${url.host}${path}`;
  } catch { return u; }
}

// ── ScreenshotLightbox ──────────────────────────────────────────────
// One shared half-screen image viewer for the whole detail pane. Opened
// from the Screenshots gallery AND from the step thumbnails (both feed the
// SAME normalised frames array, so prev/next traverses the entire capture
// sequence). Behaviour:
//   • image sized to ~half the screen (md+), contained — never overflows
//   • ◂ ▸ arrow buttons + ←/→ keys to traverse; disabled at the ends
//   • click the dim backdrop (or Esc, or ✕) to close; clicking the image
//     itself does NOT close (stopPropagation)
// `index` is the position into `frames`; null = closed.
function ScreenshotLightbox({ frames, index, onClose, onIndex }) {
  const open = Array.isArray(frames) && index != null && index >= 0 && index < frames.length;
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
      else if (e.key === 'ArrowRight' && index < frames.length - 1) onIndex(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, index, frames, onClose, onIndex]);

  if (!open) return null;
  const frame = frames[index];
  const canPrev = index > 0;
  const canNext = index < frames.length - 1;
  const caption = frame.action
    || (frame.stepIndex != null ? `Step ${frame.stepIndex}` : `Screenshot ${index + 1}`);

  // Portalled to <body> so the dim/blur backdrop covers the sticky PageHeader
  // (z-20) too — otherwise the header stayed crisp on top while the rest of the
  // page was dimmed. z-[80] sits above every in-page chrome layer.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Screenshot preview"
      className="fixed inset-0 z-[80] bg-ink-900/80 backdrop-blur-md flex items-center justify-center p-4 sm:p-8"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close preview"
        className="absolute top-4 right-4 inline-flex items-center justify-center w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
      >
        <X className="w-5 h-5" aria-hidden="true" />
      </button>

      {/* Image + arrows in one centered column; click anywhere inside keeps the
          viewer open (only the backdrop closes). Arrows sit in a flex row right
          beside the image so they hug it regardless of image width — no longer
          pinned to the far screen edges. */}
      <figure className="flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 sm:gap-4">
          <button
            type="button"
            disabled={!canPrev}
            onClick={(e) => { e.stopPropagation(); if (canPrev) onIndex(index - 1); }}
            aria-label="Previous screenshot"
            className="shrink-0 inline-flex items-center justify-center w-10 h-10 sm:w-11 sm:h-11 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors disabled:opacity-25 disabled:cursor-not-allowed"
          >
            <ChevronLeft className="w-6 h-6" aria-hidden="true" />
          </button>
          <img
            src={absUrl(frame.url)}
            alt={caption}
            className="max-h-[80vh] max-w-[70vw] md:max-w-[52vw] object-contain rounded-card shadow-card-hover bg-white"
          />
          <button
            type="button"
            disabled={!canNext}
            onClick={(e) => { e.stopPropagation(); if (canNext) onIndex(index + 1); }}
            aria-label="Next screenshot"
            className="shrink-0 inline-flex items-center justify-center w-10 h-10 sm:w-11 sm:h-11 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors disabled:opacity-25 disabled:cursor-not-allowed"
          >
            <ChevronRight className="w-6 h-6" aria-hidden="true" />
          </button>
        </div>
        <figcaption className="text-center text-sm text-white/90 max-w-[80vw] truncate">
          <span className="font-semibold">{caption}</span>
          <span className="text-white/55 ml-2">{index + 1} / {frames.length}</span>
        </figcaption>
      </figure>
    </div>,
    document.body,
  );
}

// ── ScreenshotsTab ──────────────────────────────────────────────────
// Gallery view, grouped by the step each frame belongs to. After Batch
// 4.2 the conductor stores screenshots as `{ url, stepIndex, action, ts
// }` so every thumbnail has a real caption ("Step 3 · Clicked the
// Register button"). Legacy runs persisted plain strings — we detect
// that shape and fall back to "Step N" placeholder captions so old
// trial-run data still renders.
//
// `frames` + `onOpenFrame` are supplied by DetailPane so the gallery and the
// step thumbnails share ONE lightbox (prev/next spans every captured frame).
function ScreenshotsTab({ result, frames, onOpenFrame }) {
  if (frames.length === 0 && !result.baselineScreenshot && !result.visualVerdict) {
    return (
      <div className="text-center py-10 text-ink-500">
        <Camera className="w-10 h-10 text-ink-300 mx-auto mb-3" aria-hidden="true" />
        <p className="text-sm">No screenshots captured for this test case yet.</p>
        <p className="text-xs text-ink-400 mt-1">
          New runs capture one screenshot after every action automatically. Re-run this test to populate the gallery.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {frames.length > 0 && (
        <section>
          <h3 className="font-display text-xl text-ink-900 mb-1">Screenshots</h3>
          <p className="text-sm text-ink-500 mb-4">
            {frames.length} image{frames.length === 1 ? '' : 's'} captured during this test, in chronological order. Click any thumbnail to view full size.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {frames.map((f, i) => (
              <ScreenshotCard
                key={`${f.url}-${i}`}
                frame={f}
                index={i}
                onOpen={() => onOpenFrame(i)}
              />
            ))}
          </div>
        </section>
      )}

      {(result.baselineScreenshot || result.visualVerdict) && (
        <section>
          <h3 className="font-display text-xl text-ink-900 mb-1">Visual comparison</h3>
          <p className="text-sm text-ink-500 mb-4">
            How this run compares to the baseline screenshot.
          </p>
          <VisualDiffSection
            result={result}
            currentScreenshot={frames.length ? frames[frames.length - 1].url : null}
          />
        </section>
      )}
    </div>
  );
}

// Normalise the persisted screenshots column into the rich object
// shape regardless of how it was written. New runs (Batch 4.2 onward)
// store `{ url, stepIndex, action, ts }`; older runs stored bare URL
// strings. Returns an array of the rich shape for consistent rendering.
function normaliseScreenshots(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry, idx) => {
      if (entry == null) return null;
      if (typeof entry === 'string') {
        return { url: entry, stepIndex: null, action: null, ts: null, isLegacy: true, fallbackIndex: idx };
      }
      if (typeof entry === 'object' && entry.url) {
        return { url: entry.url, stepIndex: entry.stepIndex ?? null, action: entry.action ?? null, ts: entry.ts ?? null, isLegacy: false, fallbackIndex: idx };
      }
      return null;
    })
    .filter(Boolean);
}

function ScreenshotCard({ frame, index, onOpen }) {
  const stepLabel = frame.stepIndex === 0
    ? 'Before the test began'
    : frame.stepIndex == null
      ? `Frame ${index + 1}`
      : `Step ${frame.stepIndex}`;
  const caption = frame.action || 'Action capture';
  const tsLabel = frame.ts ? new Date(frame.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="block rounded-card border border-ink-200 bg-white overflow-hidden hover:border-ink-400 hover:shadow-card-hover transition-all text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info-500"
    >
      <div className="bg-ink-100 px-3 py-2 border-b border-ink-200 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-2xs font-bold uppercase tracking-wider text-ink-600">{stepLabel}</div>
          <div className="text-xs text-ink-700 truncate" title={caption}>{caption}</div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {tsLabel && <span className="text-2xs text-ink-400 tabular-nums">{tsLabel}</span>}
          <ImageIcon className="w-3.5 h-3.5 text-ink-400" aria-hidden="true" />
        </div>
      </div>
      <img
        src={absUrl(frame.url)}
        alt={caption}
        className="block w-full h-auto bg-white"
        loading="lazy"
        onError={(e) => { e.target.style.display = 'none'; }}
      />
    </button>
  );
}

// ── AIAnalysisTab ───────────────────────────────────────────────────
// The rescue tab. RCA card on top (Reporter agent's structured findings
// rewritten as What / Why / How to fix), then the conversational chat
// expanded properly (not crammed into a corner), then the per-case
// notes field at the bottom.
function AIAnalysisTab({ result, testCase, projectId }) {
  const hasRca = !!result.rcaWhat;
  return (
    <div className="space-y-8">
      <section>
        <h3 className="font-display text-xl text-ink-900 mb-1 flex items-center gap-2">
          <BrainCircuit className="w-5 h-5 text-accent-600" aria-hidden="true" />
          What QAAI found
        </h3>
        {hasRca ? (
          <FormalRcaCards result={result} />
        ) : (
          <RcaEmptyState result={result} />
        )}
      </section>

      <hr className="border-ink-100" />

      <section>
        <h3 className="font-display text-xl text-ink-900 mb-1 flex items-center gap-2">
          <MessagesSquare className="w-5 h-5 text-accent-600" aria-hidden="true" />
          Ask Claude about this result
        </h3>
        <p className="text-sm text-ink-500 mb-4">
          Claude has the full context of this test case — the steps, screenshots, network log, and any RCA above. Ask anything.
        </p>
        <FriendlyChatPanel
          projectId={projectId}
          runId={result.runId}
          resultId={result.id}
          initialHistory={Array.isArray(result.chatHistory) ? result.chatHistory : []}
          result={result}
        />
      </section>

      {testCase?.id && projectId && (
        <>
          <hr className="border-ink-100" />
          <section>
            <h3 className="font-display text-xl text-ink-900 mb-1 flex items-center gap-2">
              <StickyNote className="w-5 h-5 text-info-600" aria-hidden="true" />
              Tell AI how to validate next time
            </h3>
            <p className="text-sm text-ink-500 mb-4">
              Review the screenshots and trace above. If the assertions or validations need to change — tell the AI exactly how to validate this step. Your instructions are saved globally to this test case and applied on every future run, including JSON assertion checks end-to-end.
            </p>
            <CaseGuidanceEditor
              projectId={projectId}
              runId={result.runId}
              testCaseId={testCase.id}
              testCaseName={testCase.name}
              initialValue={testCase.userGuidance || ''}
              result={result}
            />
          </section>
        </>
      )}
    </div>
  );
}

// Structured RCA — directive-required Blocked/Failed/Root cause/
// Recommendation framing. Each card has one purpose and an associated
// Lucide icon.
function FormalRcaCards({ result }) {
  const classMeta = {
    locator: { label: 'Locator', tone: 'bg-warn-50 text-warn-700 border-warn-200' },
    data:    { label: 'Test data', tone: 'bg-info-50 text-info-700 border-info-200' },
    timing:  { label: 'Timing', tone: 'bg-accent-50 text-accent-700 border-accent-200' },
    backend: { label: 'Backend', tone: 'bg-danger-50 text-danger-700 border-danger-200' },
    env:     { label: 'Environment', tone: 'bg-ink-100 text-ink-700 border-ink-200' },
    unknown: { label: 'Unclassified', tone: 'bg-ink-100 text-ink-600 border-ink-200' },
  }[result.rcaClass] || { label: 'Unclassified', tone: 'bg-ink-100 text-ink-600 border-ink-200' };
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap text-2xs uppercase tracking-wider font-bold">
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-pill border ${classMeta.tone}`}>
          {classMeta.label}
        </span>
        {typeof result.rcaConfidence === 'number' && (
          <span className="text-ink-500 normal-case tracking-normal font-medium">
            Confidence <span className="text-ink-800 font-semibold tabular-nums">{result.rcaConfidence}%</span>
          </span>
        )}
      </div>
      <RcaCard icon={FileText} label="What happened" tone="ink">
        {result.rcaWhat}
      </RcaCard>
      <RcaCard icon={AlertCircle} label="Most likely cause" tone="warn">
        {result.rcaWhy}
      </RcaCard>
      <RcaCard icon={Wrench} label="Recommended next step" tone="info">
        {result.rcaFix}
      </RcaCard>
      <RcaTicketingFooter result={result} />
    </div>
  );
}

function RcaCard({ icon: Icon, label, tone, children }) {
  const map = {
    ink:  { border: 'border-ink-200',    bg: 'bg-white',         iconCls: 'text-ink-500',     labelCls: 'text-ink-700' },
    warn: { border: 'border-warn-200',   bg: 'bg-warn-50/40',    iconCls: 'text-warn-600',    labelCls: 'text-warn-800' },
    info: { border: 'border-info-200',   bg: 'bg-info-50/40',    iconCls: 'text-info-600',    labelCls: 'text-info-800' },
  }[tone] || { border: 'border-ink-200', bg: 'bg-white', iconCls: 'text-ink-500', labelCls: 'text-ink-700' };
  return (
    <div className={`rounded-card border ${map.border} ${map.bg} px-5 py-4`}>
      <div className="flex items-center gap-2 mb-2">
        <Icon className={`w-4 h-4 ${map.iconCls}`} aria-hidden="true" />
        <h4 className={`text-2xs uppercase tracking-[0.18em] font-bold ${map.labelCls}`}>
          {label}
        </h4>
      </div>
      <p className="text-sm text-ink-800 leading-relaxed whitespace-pre-wrap">{children}</p>
    </div>
  );
}

function RcaTicketingFooter({ result }) {
  const toast = useToast();
  const [filing, setFiling] = useState(null);
  const [ticket, setTicket] = useState(
    result.ticketId ? { id: result.ticketId, url: result.ticketUrl } : null
  );
  useEffect(() => {
    setTicket(result.ticketId ? { id: result.ticketId, url: result.ticketUrl } : null);
  }, [result.id, result.ticketId, result.ticketUrl]);

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
    <div className="rounded-card border border-ink-200 bg-ink-50/60 px-4 py-3 flex items-center gap-2 flex-wrap">
      {ticket ? (
        <a
          href={ticket.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-info-700 hover:text-info-800"
        >
          <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
          {ticket.id} — open ticket
        </a>
      ) : (
        <>
          <Button size="sm" variant="secondary" onClick={() => createTicket('jira')} loading={filing === 'jira'} disabled={!!filing}>
            <Bug className="w-3.5 h-3.5" />
            File Jira ticket
          </Button>
          <Button size="sm" variant="secondary" onClick={() => createTicket('ado')} loading={filing === 'ado'} disabled={!!filing}>
            <Bug className="w-3.5 h-3.5" />
            File ADO ticket
          </Button>
          <span className="ml-auto text-2xs text-ink-500">
            Error, steps, and RCA auto-attached.
          </span>
        </>
      )}
    </div>
  );
}

function RcaEmptyState({ result }) {
  if (result.status === 'pass') {
    return (
      <div className="rounded-card border border-success-200 bg-success-50/40 px-5 py-4 text-sm text-success-800 leading-relaxed">
        This test passed — no analysis needed. Ask Claude below if you want to understand why a particular step behaved a certain way.
      </div>
    );
  }
  const isPending = !result.status || result.status === 'pending';
  if (isPending) {
    return (
      <div className="rounded-card border border-warn-200 bg-warn-50/40 px-5 py-4 text-sm text-warn-800 leading-relaxed">
        This test ran but produced no conclusive verdict — the run may have been cancelled or interrupted before it finished. Use <strong>Rerun with AI validation</strong> below to retry this case in-place, or add guidance first to help the AI navigate the tricky step.
      </div>
    );
  }
  return (
    <div className="rounded-card border border-ink-200 bg-ink-50/40 px-5 py-4 text-sm text-ink-700 leading-relaxed">
      No AI analysis has been generated for this result yet. Use the
      {' '}<strong>Analyse failures with AI</strong>{' '}
      button at the top of the page to have Claude write a structured root-cause summary.
    </div>
  );
}

// Friendlier rebuild of the chat box. Default state shows suggestion
// chips picked from the failure context; clicking one prefills the
// textarea. Character counter only surfaces near the limit.
function FriendlyChatPanel({ projectId, runId, resultId, initialHistory, result }) {
  const toast = useToast();
  const [history, setHistory] = useState(initialHistory || []);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history.length]);

  // Dynamic suggestion chips driven by failure context.
  const suggestions = useMemo(() => buildChatSuggestions(result), [result]);

  const send = useCallback(async (text) => {
    const msg = (text || draft).trim();
    if (!msg || sending) return;
    setSending(true);
    const optimistic = [...history, { role: 'user', content: msg, ts: new Date().toISOString() }];
    setHistory(optimistic);
    setDraft('');
    try {
      const res = await api.post(`/runs/${runId}/results/${resultId}/chat`, { message: msg });
      setHistory(res.history || optimistic);
    } catch (err) {
      const m = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(m, { title: 'Chat failed' });
      setHistory(history);
      setDraft(msg);
    } finally {
      setSending(false);
    }
  }, [draft, sending, history, runId, resultId, toast]);

  const overLimit = draft.length > 4000;
  const remaining = 4000 - draft.length;

  return (
    <div className="rounded-card border border-ink-200 bg-white shadow-card overflow-hidden">
      {history.length === 0 && (
        <div className="p-5 border-b border-ink-100 bg-ink-50/40">
          <p className="text-xs uppercase tracking-wider font-bold text-ink-500 mb-2.5">
            Try one of these to start
          </p>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => send(s)}
                disabled={sending}
                className="px-3 py-1.5 rounded-pill text-xs font-medium border border-ink-200 bg-white text-ink-700 hover:border-accent-300 hover:bg-accent-50/50 hover:text-accent-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div
          ref={scrollRef}
          className="max-h-[420px] overflow-y-auto p-5 space-y-3 bg-ink-50/30"
        >
          {history.map((m, i) => (
            <ChatBubble key={i} role={m.role} content={m.content} ts={m.ts} />
          ))}
        </div>
      )}

      <div className="p-4 bg-white">
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
            ? 'Type your question…'
            : 'Continue the conversation…'}
          rows={3}
          disabled={sending}
          className="w-full text-sm p-3 border border-ink-200 rounded-card focus:outline-none focus:border-accent-400 focus:shadow-ring transition-all resize-y disabled:bg-ink-50 disabled:cursor-not-allowed leading-relaxed"
          aria-label="Message to AI"
        />
        <div className="flex items-center justify-between gap-2 mt-2">
          {remaining < 200 ? (
            <span className={`text-2xs ${overLimit ? 'text-danger-700' : 'text-warn-700'}`}>
              {overLimit ? `${-remaining} over the 4,000-character limit` : `${remaining} characters left`}
            </span>
          ) : (
            <span className="text-2xs text-ink-400">
              <kbd className="font-mono border border-ink-200 rounded px-1 text-2xs">⌘↵</kbd> to send
            </span>
          )}
          <Button size="sm" onClick={() => send()} disabled={!draft.trim() || sending || overLimit} loading={sending}>
            <MessagesSquare className="w-3.5 h-3.5" />
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

// Pick 3–4 suggestion chips based on what went wrong.
function buildChatSuggestions(result) {
  const out = [];
  if (result.status === 'pass') {
    return [
      'Why did this test pass?',
      'What was checked in the assertion?',
      'How long did each step take?',
    ];
  }
  if (result.rcaClass === 'locator' || (result.error && /locator|element.*not.*found/i.test(result.error))) {
    out.push('Was the locator the problem?');
    out.push('How do I fix this locator?');
  }
  if (result.rcaClass === 'timing' || (result.error && /timeout|timed out/i.test(result.error))) {
    out.push('Did the page load slowly?');
    out.push('How can I make the test wait longer?');
  }
  if (result.blocked?.reason === 'agent_loop') {
    out.push('Why did the agent get stuck in a loop?');
    out.push('What should I add to the test to break the loop?');
  }
  // Always-available defaults so we never show fewer than 3.
  out.push('Why did it fail?');
  out.push('What changed since the last passing run?');
  out.push('What\'s the simplest fix?');
  // De-dupe + cap at 4.
  const seen = new Set();
  const final = [];
  for (const s of out) {
    if (seen.has(s)) continue;
    seen.add(s);
    final.push(s);
    if (final.length === 4) break;
  }
  return final;
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
      <div className={`max-w-[80%] rounded-card px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words leading-relaxed ${
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

// ── VerdictEvidenceTab ──────────────────────────────────────────────
// Repurposed from the never-populated Network tab. Correlates each DECLARED
// assertion (type, criticality, provenance, note) with its recorded OUTCOME
// (matched / not_matched / uncheckable, and whether a deterministic check or
// the AI semantic-rescue decided it). Then a plain-language "What this means"
// block spells out the trade-offs of how the verdict was reached — so the
// user sees not just THAT a case passed/failed but WHY, and what to watch.
const CRIT_META = {
  must:       { label: 'Must',       cls: 'bg-danger-50 text-danger-700 border-danger-200',  blurb: 'acceptance criterion' },
  should:     { label: 'Should',     cls: 'bg-warn-50 text-warn-700 border-warn-200',        blurb: 'expected, not critical' },
  incidental: { label: 'Incidental', cls: 'bg-ink-100 text-ink-600 border-ink-200',          blurb: 'cosmetic / inferred' },
};
const PROV_META = {
  doc_quoted:       { label: 'From document',  cls: 'bg-info-50 text-info-700 border-info-200' },
  atlas_reconciled: { label: 'Matched to site', cls: 'bg-accent-50 text-accent-700 border-accent-200' },
  inferred:         { label: 'Inferred',        cls: 'bg-ink-100 text-ink-600 border-ink-200' },
};
const OUTCOME_META = {
  matched:     { label: 'Matched',     icon: CheckCircle2, cls: 'bg-success-50 text-success-700 border-success-200' },
  not_matched: { label: 'Not matched', icon: XCircle,      cls: 'bg-danger-50 text-danger-700 border-danger-200' },
  uncheckable: { label: 'Uncheckable', icon: AlertCircle,  cls: 'bg-warn-50 text-warn-700 border-warn-200' },
};

function normaliseAiFailureExplanation(value) {
  if (!value || typeof value !== 'object') return null;
  const overallSummary = typeof value.overallSummary === 'string' ? value.overallSummary.trim() : '';
  if (!overallSummary) return null;
  const ownership = typeof value.ownership === 'string' ? value.ownership : null;
  const recommendedStatus = typeof value.recommendedStatus === 'string' ? value.recommendedStatus : null;
  const assertionExplanations = Array.isArray(value.assertionExplanations)
    ? value.assertionExplanations
      .filter((item) => item && typeof item === 'object' && typeof item.assertionId === 'string')
      .map((item) => ({
        assertionId: item.assertionId,
        requirementContext: typeof item.requirementContext === 'string' ? item.requirementContext : '',
        whatWasExpected: typeof item.whatWasExpected === 'string' ? item.whatWasExpected : '',
        whatWasFound: typeof item.whatWasFound === 'string' ? item.whatWasFound : '',
        whyItFailed: typeof item.whyItFailed === 'string' ? item.whyItFailed : '',
        actionRequired: typeof item.actionRequired === 'string' ? item.actionRequired : '',
      }))
    : [];
  return { overallSummary, ownership, recommendedStatus, assertionExplanations };
}

function parseAiFailureExplanation(raw) {
  if (!raw) return null;
  try { return normaliseAiFailureExplanation(JSON.parse(raw)); } catch (_) { return null; }
}

function friendlyFailureExplanationError(err) {
  const code = err?.code || err?.payload?.code;
  if (code === 'EXPLANATION_SCHEMA_STALE') {
    return 'AI explanation is temporarily unavailable while the backend finishes its database update. The verdict evidence below is still valid.';
  }
  if (code === 'CANCELLED') return 'Explanation generation was cancelled.';
  if (err instanceof ApiError && err.isAuth) return 'You do not have access to generate this explanation.';
  if (err instanceof ApiError && err.isNetwork) return 'Could not reach the backend to generate the explanation. Please retry.';
  return 'AI explanation is temporarily unavailable. The verdict evidence below is still valid.';
}

function assertionExpected(d) {
  const p = d?.payload || {};
  if (typeof p.expectedText === 'string') return `"${p.expectedText}"`;
  if (typeof p.unexpectedText === 'string') return `must NOT show "${p.unexpectedText}"`;
  if (typeof p.expectedUrlPattern === 'string') return `URL ~ ${p.expectedUrlPattern}`;
  if (typeof p.expectedRole === 'string') return `role: ${p.expectedRole}`;
  if (typeof p.unexpectedRole === 'string') return `must NOT have role: ${p.unexpectedRole}`;
  if (p.pageName) return `page: ${p.pageName}`;
  if (p.filenamePattern || p.mimeType || p.minSize) return 'a file download';
  if (typeof p.expectedReturn === 'string') return `eval = ${p.expectedReturn}`;
  return d?.type || 'assertion';
}

// Plain-language trade-off notes — the explicit "advantages and disadvantages"
// of how this verdict was reached. Derived purely from the correlated rows +
// result fields, so it stays faithful to what actually happened.
function buildCaveats(result, rows) {
  const out = [];
  const assertionContractDefect = isAssertionContractDefectResult(result);
  const softMiss = rows.filter((r) => r.criticality !== 'must' && r.outcome
    && (r.outcome.outcome === 'not_matched' || r.outcome.outcome === 'uncheckable'));
  const rescued = rows.filter((r) => r.outcome && r.outcome.source === 'semantic_rescue');
  const reconciled = rows.filter((r) => r.provenance === 'atlas_reconciled');
  const failingMustDoc = rows.find((r) => r.criticality === 'must' && r.provenance === 'doc_quoted'
    && r.outcome && r.outcome.outcome === 'not_matched');

  // Parse calibration-gap and soft-verification warnings from mechanicalVerdictReason.
  // Conductor stores them as: "reason ⚠ warning1,warning2"
  const mvr = result.mechanicalVerdictReason || '';
  const mvrWarnings = mvr.includes('⚠')
    ? mvr.split('⚠')[1].split(',').map((w) => w.trim()).filter(Boolean)
    : [];

  if (result.status === 'pass' && softMiss.length) {
    out.push({ tone: 'warn',
      text: `Passed even though ${softMiss.length} non-critical check${softMiss.length > 1 ? 's' : ''} didn't match (e.g. ${assertionExpected(softMiss[0])}). Upside: a cosmetic wording difference didn't fail your build. Trade-off: if exact wording matters here, re-tier that check to "Must".` });
  }
  if (rescued.length) {
    out.push({ tone: 'info',
      text: `${rescued.length} check${rescued.length > 1 ? 's were' : ' was'} confirmed by AI judgment of intent, not an exact string match. Upside: tolerates real-world wording the document couldn't predict. Trade-off: an AI made the call — double-check if this case is safety-critical.` });
  }
  if (reconciled.length) {
    out.push({ tone: 'accent',
      text: `Adjusted ${reconciled.length} interaction label${reconciled.length > 1 ? 's' : ''} to match the live site${reconciled[0].note ? ` (${reconciled[0].note})` : ''}. Upside: the test drives the real controls. Trade-off: based on the last site crawl — recalibrate if the UI changed.` });
  }
  if (assertionContractDefect) {
    out.push({ tone: 'info',
      text: 'Assertion contract defect: QAAI checked a required assertion that contradicts this flow. The raw assertion evidence is preserved for audit, but this is not certified as a website failure.' });
  } else if (failingMustDoc) {
    out.push({ tone: 'danger',
      text: `Failed on a required outcome taken from your document: ${assertionExpected(failingMustDoc)}. It was treated as required because the document specified it — this is a real regression, not a flaky check.` });
  }
  // Live verification notes surfaced from the verdict layer.
  if (mvrWarnings.includes('all_assertions_ungrounded') || mvrWarnings.includes('hard_assertion_ungrounded')) {
    out.push({ tone: 'info',
      text: 'Assertions were authored directly from requirement specifications and verified live by the Conductor during browser execution.' });
  }
  if (mvrWarnings.includes('soft_assertion_uncheckable')) {
    out.push({ tone: 'info',
      text: 'One or more non-critical assertions could not be verified (page state was ambiguous or the check timed out). The required acceptance criteria all passed — this is a verification coverage note, not a defect.' });
  }
  return out;
}

// Returns a plain-English explanation for why a specific assertion is UNCHECKABLE,
// tailored to its type and payload.
function uncheckableHelp(row) {
  const type = (row.type || '').toUpperCase();
  const payload = row.payload || {};
  if (type === 'EVALUATE') {
    const script = String(payload.expectedReturn ?? payload.script ?? '');
    const isCookie = /cookie/i.test(script) || /document\.cookie/i.test(script);
    if (isCookie) {
      return {
        why: 'This check tries to read browser cookies using JavaScript. Most modern web applications protect their session cookies with the "HttpOnly" security flag, which deliberately hides them from JavaScript. This is correct security behaviour — not a bug.',
        action: 'The session is verified by navigation: if the agent loaded authenticated pages, the session was active. Remove this assertion or change it to "should" criticality, since it can never pass on any HttpOnly site.',
      };
    }
    return {
      why: 'A JavaScript expression was run in the browser to check a condition, but the result didn\'t match or the value was inaccessible (e.g. cross-origin frame, security restriction, timing issue).',
      action: 'If this check is important, verify the same condition using a visible text or element check instead of a script-based eval.',
    };
  }
  if (type === 'PAGE') {
    return {
      why: 'The platform could not confidently identify the expected page — the page signals (URL, heading, role) were ambiguous or the page was still loading.',
      action: 'Check the Screenshots tab to see what page the agent was actually on at this step.',
    };
  }
  if (type === 'TEXT' || type === 'FORBIDDEN_TEXT') {
    return {
      why: 'The expected text could not be located in the page snapshot — either the page wasn\'t in the right state when the check ran, or the text appears inside a frame/shadow DOM that the snapshot missed.',
      action: 'Review the step screenshot to confirm the page state at the moment of this check.',
    };
  }
  return {
    why: 'The platform could not get a definitive yes/no answer for this check — the page state was ambiguous or the verification primitive timed out.',
    action: 'Review the step screenshot and consider whether the check timing or assertion type needs adjustment.',
  };
}

// Derives a single plain-English sentence explaining WHY this case failed.
// Used as the red headline banner at the top of Verdict & Evidence for fail cases.
function deriveFailureHeadline(result, rows, demotedRows) {
  if (isAssertionContractDefectResult(result)) {
    return 'QAAI assertion contract defect: the browser reached the expected state, but the saved assertion expected a different page.';
  }
  if (result.status !== 'fail') return null;
  // Priority 1: active must assertion explicitly not matched
  const notMatchedMust = rows.find((r) => r.criticality === 'must' && r.outcome?.outcome === 'not_matched');
  if (notMatchedMust) {
    return `A required assertion did not match: ${assertionExpected(notMatchedMust)}`;
  }
  // Priority 2: active must assertion uncheckable
  const uncheckableMust = rows.find((r) => r.criticality === 'must' && r.outcome?.outcome === 'uncheckable');
  if (uncheckableMust) {
    return `A required assertion could not be verified automatically: ${assertionExpected(uncheckableMust)}. A human needs to confirm this condition.`;
  }
  // Priority 3: active must assertion with no outcome (never checked)
  const uncheckedMust = rows.find((r) => r.criticality === 'must' && !r.outcome);
  if (uncheckedMust) {
    return `A required assertion was never checked during the run: ${assertionExpected(uncheckedMust)}.`;
  }
  // Priority 4: skipped-at-calibration must assertions + flipDirection (agent called pass, checks overrode)
  if (demotedRows.length > 0) {
    const mustDemoted = demotedRows.filter((d) => (d.criticality || 'must') === 'must');
    if (mustDemoted.length > 0) {
      return `${mustDemoted.length} required assertion${mustDemoted.length > 1 ? 's were' : ' was'} excluded at calibration and never verified. A case cannot be declared passing with unverified requirements — see below.`;
    }
    return `${demotedRows.length} assertion${demotedRows.length > 1 ? 's were' : ' was'} excluded at calibration and could not be checked.`;
  }
  // Priority 5: flipDirection with all assertions matched (unusual — some check outside declared set failed)
  if (result.flipDirection) {
    return 'The automated checks overrode the agent\'s pass verdict — at least one required check did not confirm the expected outcome.';
  }
  return 'This case did not meet all required assertions.';
}

const CAVEAT_TONE = {
  warn:   'bg-warn-50 border-warn-200 text-warn-800',
  info:   'bg-info-50 border-info-200 text-info-800',
  accent: 'bg-accent-50 border-accent-200 text-accent-800',
  danger: 'bg-danger-50 border-danger-200 text-danger-800',
  ink:    'bg-ink-50 border-ink-200 text-ink-700',
};

function RemoveAssertionButton({ projectId, testCaseId, assertionId, onRemoved }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const handleRemove = async () => {
    if (busy || done) return;
    setBusy(true);
    try {
      await api.delete(`/projects/${projectId}/test-cases/${testCaseId}/assertions/${assertionId}`);
      setDone(true);
      onRemoved(assertionId);
      toast.success('Assertion removed from this test case.');
    } catch (err) {
      toast.error(err.message || 'Failed to remove assertion');
    } finally {
      setBusy(false);
    }
  };
  if (done) return null;
  return (
    <button
      type="button"
      onClick={handleRemove}
      disabled={busy}
      className="mt-3 inline-flex items-center gap-1.5 text-2xs font-semibold text-danger-700 hover:text-danger-900 disabled:opacity-50 border border-danger-200 hover:border-danger-400 bg-danger-50 hover:bg-danger-100 px-2.5 py-1 rounded-pill transition-colors"
    >
      <XCircle className="w-3 h-3 shrink-0" aria-hidden="true" />
      {busy ? 'Removing…' : 'Remove this assertion'}
    </button>
  );
}

function RepairAssertionButton({ projectId, testCaseId, assertionId, onRepaired }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const handleRepair = async () => {
    if (busy || done) return;
    setBusy(true);
    try {
      const res = await api.post(`/projects/${projectId}/test-cases/${testCaseId}/assertions/${assertionId}/repair-contract`, {});
      setDone(true);
      onRepaired(assertionId, res.repairedAssertion);
      toast.success('Assertion contract repaired. Rerun this case to verify the corrected contract.');
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg || 'Failed to repair assertion contract');
    } finally {
      setBusy(false);
    }
  };
  if (done) return (
    <span className="mt-3 inline-flex items-center gap-1.5 text-2xs font-semibold text-success-700 border border-success-200 bg-success-50 px-2.5 py-1 rounded-pill">
      <CheckCircle2 className="w-3 h-3 shrink-0" aria-hidden="true" />
      Assertion repaired
    </span>
  );
  return (
    <button
      type="button"
      onClick={handleRepair}
      disabled={busy}
      className="mt-3 inline-flex items-center gap-1.5 text-2xs font-semibold text-info-700 hover:text-info-900 disabled:opacity-50 border border-info-200 hover:border-info-400 bg-info-50 hover:bg-info-100 px-2.5 py-1 rounded-pill transition-colors"
    >
      <Wand2 className="w-3 h-3 shrink-0" aria-hidden="true" />
      {busy ? 'Repairing...' : 'Repair assertion'}
    </button>
  );
}

function VerdictEvidenceTab({ result, projectId, onAssertionRemoved, onAssertionRepaired }) {
  const toast = useToast();
  const declared = Array.isArray(result.testCase?.declaredAssertions) ? result.testCase.declaredAssertions : [];
  const outcomes = Array.isArray(result.assertionCheckResults) ? result.assertionCheckResults : [];
  const outcomeById = useMemo(() => {
    const m = new Map();
    for (const o of outcomes) if (o && o.assertionId) m.set(o.assertionId, o);
    return m;
  }, [outcomes]);

  const rows = useMemo(() => declared
    .filter((d) => d && !d.parseFailed)
    .map((d) => ({
      id: d.id,
      type: d.type,
      criticality: (d.criticality === 'should' || d.criticality === 'incidental') ? d.criticality : 'must',
      provenance: PROV_META[d.provenance] ? d.provenance : 'inferred',
      note: typeof d.note === 'string' ? d.note : null,
      payload: d.payload,
      outcome: outcomeById.get(d.id) || null,
    })), [declared, outcomeById]);

  const demotedRows = useMemo(() => declared
    .filter((d) => d && d.parseFailed === true)
    .map((d) => ({
      id: d.id,
      type: d.type,
      criticality: d.criticality || 'incidental',
      reason: typeof d.parseFailedReason === 'string' ? d.parseFailedReason : 'declared_assertion_unparseable',
      note: typeof d.note === 'string' ? d.note : null,
      payload: d.payload,
    })), [declared]);

  const caveats = useMemo(() => buildCaveats(result, rows), [result, rows]);
  const failureHeadline = useMemo(() => deriveFailureHeadline(result, rows, demotedRows), [result, rows, demotedRows]);
  const assertionContractDefect = isAssertionContractDefectResult(result);

  // AI-generated failure explanation — auto-triggered for fail cases.
  // Cached in the DB so subsequent opens are instant (no extra LLM call).
  const [aiExplanation, setAiExplanation] = useState(() => {
    return parseAiFailureExplanation(result.failureExplanation);
  });
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(null);

  useEffect(() => {
    setAiExplanation(parseAiFailureExplanation(result.failureExplanation));
    setAiError(null);
    setAiLoading(false);
  }, [result.id, result.failureExplanation]);

  // Build a stable lookup of AI per-assertion explanations
  const aiByAssertionId = useMemo(() => {
    const m = new Map();
    if (Array.isArray(aiExplanation?.assertionExplanations)) {
      for (const e of aiExplanation.assertionExplanations) if (e?.assertionId) m.set(e.assertionId, e);
    }
    return m;
  }, [aiExplanation]);

  const generateExplanation = useCallback(async (refresh = false) => {
    if (aiLoading) return;
    setAiLoading(true);
    setAiError(null);
    try {
      const res = await api.post(
        `/runs/results/${result.id}/explain-failure${refresh ? '?refresh=1' : ''}`,
        {},
      );
      const explanation = normaliseAiFailureExplanation(res.explanation);
      if (!explanation) {
        setAiExplanation(null);
        setAiError('AI explanation returned an unreadable response. The verdict evidence below is still valid.');
        return;
      }
      setAiExplanation(explanation);
    } catch (err) {
      const message = friendlyFailureExplanationError(err);
      setAiError(message);
      toast.error(message);
    } finally {
      setAiLoading(false);
    }
  }, [result.id, aiLoading, toast]);

  // Auto-trigger once when tab is rendered for a failed case with no cached explanation
  useEffect(() => {
    if ((result.status === 'fail' || assertionContractDefect) && !aiExplanation && !aiLoading && !aiError) {
      generateExplanation();
    }
  }, [result.id, result.status, assertionContractDefect, aiExplanation, aiLoading, aiError, generateExplanation]);

  if (rows.length === 0 && demotedRows.length === 0 && caveats.length === 0) {
    return (
      <div className="text-center py-10 text-ink-500">
        <ScanSearch className="w-10 h-10 text-ink-300 mx-auto mb-3" aria-hidden="true" />
        <p className="text-sm">No structured assertions were recorded for this case.</p>
        <p className="text-xs text-ink-400 mt-1">Manual cases and older runs won't have a verdict breakdown here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="font-display text-xl text-ink-900 mb-1">Verdict &amp; evidence</h3>
        <p className="text-sm text-ink-500">
          What the AI checked, why each check mattered, and how it decided — the reasoning behind the {statusMeta(result.status || 'pending').label.toLowerCase()} verdict.
        </p>
      </div>

      {failureHeadline && (
        <div className={`rounded-card border px-4 py-3 flex items-start gap-3 ${
          assertionContractDefect ? 'border-info-300 bg-info-50' : 'border-danger-300 bg-danger-50'
        }`}>
          <XCircle className={`w-5 h-5 shrink-0 mt-0.5 ${assertionContractDefect ? 'text-info-600' : 'text-danger-600'}`} aria-hidden="true" />
          <p className={`text-sm font-semibold leading-snug ${assertionContractDefect ? 'text-info-800' : 'text-danger-800'}`}>{failureHeadline}</p>
        </div>
      )}

      {/* AI-generated explanation block */}
      {(result.status === 'fail' || assertionContractDefect) && (
        <div className="rounded-card border border-ink-200 bg-ink-50/50">
          <div className="flex items-center justify-between px-4 py-3 border-b border-ink-200">
            <span className="inline-flex items-center gap-2 text-sm font-semibold text-ink-800">
              <BrainCircuit className="w-4 h-4 text-accent-500 shrink-0" aria-hidden="true" />
              {assertionContractDefect || aiExplanation?.ownership === 'qaai_assertion_contract'
                ? 'AI assertion-contract explanation'
                : 'AI failure explanation'}
            </span>
            {aiExplanation && !aiLoading && (
              <button
                type="button"
                onClick={() => generateExplanation(true)}
                className="text-2xs text-ink-500 hover:text-ink-800 underline"
              >
                Regenerate
              </button>
            )}
          </div>
          <div className="px-4 py-3">
            {aiLoading && (
              <div className="space-y-2">
                <div className="h-3 bg-ink-200 rounded animate-pulse w-4/5" />
                <div className="h-3 bg-ink-200 rounded animate-pulse w-3/5" />
                <div className="h-3 bg-ink-200 rounded animate-pulse w-2/3" />
              </div>
            )}
            {!aiLoading && aiError && (
              <div className="flex items-start gap-3">
                <p className="text-xs text-danger-700 flex-1">{aiError}</p>
                <button
                  type="button"
                  onClick={() => generateExplanation(true)}
                  className="text-2xs text-accent-600 hover:text-accent-800 font-medium underline shrink-0"
                >
                  Retry
                </button>
              </div>
            )}
            {!aiLoading && aiExplanation && (
              <div className="space-y-1">
                <p className="text-sm text-ink-800 leading-relaxed">{aiExplanation.overallSummary}</p>
              </div>
            )}
            {!aiLoading && !aiExplanation && !aiError && (
              <button
                type="button"
                onClick={() => generateExplanation()}
                className="text-xs text-accent-600 hover:text-accent-800 font-medium underline"
              >
                Generate explanation
              </button>
            )}
          </div>
        </div>
      )}

      {caveats.length > 0 && (
        <div className="space-y-2">
          {caveats.map((c, i) => (
            <div key={i} className={`rounded-card border px-4 py-3 text-sm leading-relaxed ${CAVEAT_TONE[c.tone] || CAVEAT_TONE.ink}`}>
              {c.text}
            </div>
          ))}
        </div>
      )}

      {rows.length > 0 && (
        <ul className="space-y-3">
          {rows.map((r) => {
            const crit = CRIT_META[r.criticality];
            const prov = PROV_META[r.provenance];
            const oc = r.outcome ? OUTCOME_META[r.outcome.outcome] : null;
            const OcIcon = oc?.icon;
            return (
              <li key={r.id} className="rounded-card border border-ink-200 bg-white p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className={`text-2xs font-bold uppercase tracking-wider px-2 py-0.5 rounded-pill border ${crit.cls}`} title={crit.blurb}>
                        {crit.label}
                      </span>
                      <span className="text-2xs uppercase tracking-wider text-ink-400 font-semibold">{r.type}</span>
                    </div>
                    <p className="text-sm text-ink-900 break-words">{assertionExpected(r)}</p>
                  </div>
                  {oc && (
                    <span className={`shrink-0 inline-flex items-center gap-1.5 text-2xs font-bold uppercase tracking-wider px-2.5 py-1 rounded-pill border ${oc.cls}`}>
                      {OcIcon && <OcIcon className="w-3.5 h-3.5" aria-hidden="true" />}
                      {oc.label}
                    </span>
                  )}
                </div>
                <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                  <span className={`text-2xs font-semibold px-2 py-0.5 rounded-pill border ${prov.cls}`}>{prov.label}</span>
                  {r.outcome?.source === 'semantic_rescue' && (
                    <span className="text-2xs font-semibold px-2 py-0.5 rounded-pill border bg-info-50 text-info-700 border-info-200 inline-flex items-center gap-1">
                      <Sparkles className="w-3 h-3" aria-hidden="true" /> AI-confirmed intent
                    </span>
                  )}
                  {r.note && <span className="text-xs text-ink-600 italic">{r.note}</span>}
                </div>
                {r.outcome?.evidence && (
                  <p className="mt-2 text-xs text-ink-500 font-mono break-words bg-ink-50/60 rounded px-2 py-1">
                    {String(r.outcome.evidence).slice(0, 240)}
                  </p>
                )}
                {r.outcome?.outcome === 'uncheckable' && (() => {
                  const help = uncheckableHelp(r);
                  return (
                    <div className="mt-3 rounded border border-warn-200 bg-warn-50 px-3 py-2.5 space-y-1.5">
                      <p className="text-xs font-semibold text-warn-800 flex items-center gap-1.5">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                        Why uncheckable?
                      </p>
                      <p className="text-xs text-warn-700 leading-snug">{help.why}</p>
                      <p className="text-xs text-warn-800 font-medium leading-snug">
                        <span className="font-semibold">What to do: </span>{help.action}
                      </p>
                    </div>
                  );
                })()}
                {/* Per-assertion AI explanation */}
                {(() => {
                  const exp = aiByAssertionId.get(r.id);
                  if (!exp) return null;
                  return (
                    <div className="mt-3 rounded border border-accent-200 bg-accent-50/60 px-3 py-2.5 space-y-2">
                      <p className="text-2xs font-bold uppercase tracking-wider text-accent-700 flex items-center gap-1.5">
                        <BrainCircuit className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                        AI analysis
                      </p>
                      {exp.requirementContext && exp.requirementContext !== 'No specific requirement reference' && (
                        <p className="text-xs text-accent-800 leading-snug">
                          <span className="font-semibold">Requirement: </span>{exp.requirementContext}
                        </p>
                      )}
                      <p className="text-xs text-ink-700 leading-snug">
                        <span className="font-semibold">Expected: </span>{exp.whatWasExpected}
                      </p>
                      <p className="text-xs text-ink-700 leading-snug">
                        <span className="font-semibold">Found: </span>{exp.whatWasFound}
                      </p>
                      <p className="text-xs text-ink-700 leading-snug">
                        <span className="font-semibold">Why it failed: </span>{exp.whyItFailed}
                      </p>
                      <p className="text-xs text-accent-900 font-medium leading-snug">
                        <span className="font-semibold">Action: </span>{exp.actionRequired}
                      </p>
                    </div>
                  );
                })()}
                {result.testCase?.id && (r.outcome?.outcome === 'uncheckable' || r.outcome?.outcome === 'not_matched') && (
                  <div className="flex items-center gap-2 flex-wrap">
                    {assertionContractDefect && onAssertionRepaired && r.outcome?.outcome === 'not_matched' && (
                      <RepairAssertionButton
                        projectId={projectId}
                        testCaseId={result.testCase.id}
                        assertionId={r.id}
                        onRepaired={onAssertionRepaired}
                      />
                    )}
                    {onAssertionRemoved && (
                      <RemoveAssertionButton
                        projectId={projectId}
                        testCaseId={result.testCase.id}
                        assertionId={r.id}
                        onRemoved={onAssertionRemoved}
                      />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {demotedRows.length > 0 && (
        <DemotedAssertionsPanel demotedRows={demotedRows} defaultOpen={result.status === 'fail'} />
      )}
    </div>
  );
}

function DemotedAssertionsPanel({ demotedRows, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const REASON_LABELS = {
    text_ungrounded: 'Text not found in calibration',
    underspecified_page: 'Page not in site atlas',
    declared_assertion_unparseable: 'Malformed assertion payload',
  };
  return (
    <div className="rounded-card border border-warn-200 bg-warn-50">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-warn-800">
          <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          {demotedRows.length} assertion{demotedRows.length !== 1 ? 's' : ''} skipped at calibration
        </span>
        {open
          ? <ChevronUp className="w-4 h-4 text-warn-600 shrink-0" aria-hidden="true" />
          : <ChevronDown className="w-4 h-4 text-warn-600 shrink-0" aria-hidden="true" />}
      </button>
      {open && (
        <div className="border-t border-warn-200 px-4 pb-4 pt-3 space-y-2">
          <p className="text-xs text-warn-700 mb-3">
            These assertions were authored by the AI but excluded from execution because
            the expected text or condition was not found in the site's calibration data.
            They were NOT tested in this run. Review them to decide whether the Calibrator
            needs updating or the assertions need to be reauthored.
          </p>
          <ul className="space-y-2">
            {demotedRows.map((d) => {
              const expected = d.payload?.expectedText || d.payload?.unexpectedText
                || d.payload?.script || d.payload?.expectedUrlPattern
                || (d.payload?.pageName ? `page: ${d.payload.pageName}` : null) || '—';
              return (
                <li key={d.id} className="rounded border border-warn-200 bg-white px-3 py-2.5">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="text-2xs font-bold uppercase tracking-wider px-2 py-0.5 rounded-pill border bg-warn-100 text-warn-700 border-warn-300">
                      {d.criticality}
                    </span>
                    <span className="text-2xs uppercase tracking-wider text-ink-400 font-semibold">{d.type}</span>
                    <span className="text-2xs font-semibold px-2 py-0.5 rounded-pill border bg-danger-50 text-danger-700 border-danger-200">
                      {REASON_LABELS[d.reason] || d.reason}
                    </span>
                  </div>
                  <p className="text-xs text-ink-700 font-mono break-words bg-ink-50 rounded px-2 py-1 mt-1">
                    {String(expected).slice(0, 200)}
                  </p>
                  {d.note && <p className="text-xs text-ink-500 italic mt-1">{d.note}</p>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function NetworkTable({ entries }) {
  const [statusFilter, setStatusFilter] = useState('all');
  const filtered = useMemo(() => {
    if (statusFilter === 'all') return entries;
    return entries.filter((e) => {
      const s = Number(e.status);
      if (statusFilter === '2xx') return s >= 200 && s < 300;
      if (statusFilter === '3xx') return s >= 300 && s < 400;
      if (statusFilter === '4xx') return s >= 400 && s < 500;
      if (statusFilter === '5xx') return s >= 500;
      return true;
    });
  }, [entries, statusFilter]);
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
    <div className="rounded-card border border-ink-200 bg-white overflow-hidden">
      <div className="border-b border-ink-100 px-4 py-2.5 flex items-center gap-2 flex-wrap bg-ink-50/40" role="radiogroup" aria-label="Filter by status code">
        {[
          { id: 'all',  label: 'All',  count: entries.length, cls: 'text-ink-700' },
          { id: '2xx',  label: '2xx',  count: counts['2xx'],  cls: 'text-success-700' },
          { id: '3xx',  label: '3xx',  count: counts['3xx'],  cls: 'text-warn-700' },
          { id: '4xx',  label: '4xx',  count: counts['4xx'],  cls: 'text-danger-700' },
          { id: '5xx',  label: '5xx',  count: counts['5xx'],  cls: 'text-danger-800' },
        ].map((f) => {
          const active = statusFilter === f.id;
          if (f.count === 0 && f.id !== 'all') return null;
          return (
            <button
              key={f.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setStatusFilter(f.id)}
              className={`text-2xs font-semibold uppercase tracking-wider px-2 py-1 rounded-pill border transition-all inline-flex items-center gap-1.5 ${
                active ? 'bg-ink-900 text-white border-ink-900' : `bg-white ${f.cls} border-ink-200 hover:border-ink-400`
              }`}
            >
              <span>{f.label}</span>
              <span className="tabular-nums opacity-70">{f.count}</span>
            </button>
          );
        })}
      </div>
      <div className="max-h-[480px] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="bg-ink-50 text-2xs uppercase tracking-wider text-ink-600 sticky top-0">
            <tr>
              <th className="text-left px-4 py-2 font-semibold">Method</th>
              <th className="text-left px-4 py-2 font-semibold">Status</th>
              <th className="text-left px-4 py-2 font-semibold">URL</th>
              <th className="text-left px-4 py-2 font-semibold">Type</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e, i) => {
              const s = Number(e.status);
              const cls = s >= 500 ? 'text-danger-800' : s >= 400 ? 'text-danger-600' : s >= 300 ? 'text-warn-700' : 'text-success-700';
              return (
                <tr key={i} className="border-t border-ink-100 hover:bg-ink-50/40">
                  <td className="px-4 py-2 font-mono font-semibold text-ink-700">{e.method}</td>
                  <td className={`px-4 py-2 font-mono font-bold tabular-nums ${cls}`}>{e.status}</td>
                  <td className="px-4 py-2 font-mono text-ink-600 truncate max-w-[520px]" title={e.url}>{e.url}</td>
                  <td className="px-4 py-2 text-2xs text-ink-500 uppercase tracking-wider">{e.resourceType || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── VideoTab ────────────────────────────────────────────────────────
// Frame-stitched playback. The @playwright/mcp CLI we drive doesn't
// expose native video recording, so we synthesise playback from the
// per-action screenshots the conductor captured (Batch 4.2). Each
// frame carries its step + action caption — the player advances at a
// configurable framerate, jumps to any frame via the scrubber, and
// supports keyboard control (space / ← / →). If a future build wires
// real MP4 capture into RunResult.video, that takes priority.
function VideoTab({ result }) {
  const frames = useMemo(() => normaliseScreenshots(result.screenshots), [result.screenshots]);

  // Real MP4 path takes precedence when it exists.
  if (result.video) {
    return (
      <div>
        <h3 className="font-display text-xl text-ink-900 mb-1">Recording</h3>
        <p className="text-sm text-ink-500 mb-4">
          Full playback of the browser session for this test.
        </p>
        <div className="rounded-card border border-ink-200 overflow-hidden bg-ink-900">
          <video controls className="block w-full" preload="metadata">
            <source src={absUrl(result.video)} />
            Your browser does not support video playback.
          </video>
        </div>
      </div>
    );
  }

  if (frames.length === 0) {
    return (
      <div className="text-center py-10 text-ink-500">
        <Video className="w-10 h-10 text-ink-300 mx-auto mb-3" aria-hidden="true" />
        <p className="text-sm">No playback available for this test case yet.</p>
        <p className="text-xs text-ink-400 mt-1">
          Playback is built from the per-action screenshots the agent captures during a run. Re-run this test to populate it.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h3 className="font-display text-xl text-ink-900 mb-1">Playback</h3>
      <p className="text-sm text-ink-500 mb-4">
        Frame-by-frame replay of every action the agent took, built from
        the {frames.length} screenshot{frames.length === 1 ? '' : 's'} captured during this test. Use space to play / pause, ← / → to step.
      </p>
      <FramePlayer frames={frames} />
    </div>
  );
}

function FramePlayer({ frames }) {
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(1.5);
  const playerRef = useRef(null);

  // Reset playback head when the underlying frame list changes (e.g.
  // when the user picks a different result).
  useEffect(() => { setIdx(0); setPlaying(false); }, [frames]);

  // Advance the playback head at the configured framerate. Stops at
  // the last frame instead of looping so the operator sees the final
  // state clearly.
  useEffect(() => {
    if (!playing) return undefined;
    if (idx >= frames.length - 1) { setPlaying(false); return undefined; }
    const ms = Math.max(120, Math.round(1000 / fps));
    const t = setTimeout(() => setIdx((i) => Math.min(frames.length - 1, i + 1)), ms);
    return () => clearTimeout(t);
  }, [playing, idx, frames.length, fps]);

  // Keyboard controls — only when the player has focus so they don't
  // interfere with form inputs elsewhere on the page.
  const onKeyDown = useCallback((e) => {
    if (e.key === ' ') { setPlaying((p) => !p); e.preventDefault(); }
    if (e.key === 'ArrowLeft')  { setIdx((i) => Math.max(0, i - 1)); setPlaying(false); e.preventDefault(); }
    if (e.key === 'ArrowRight') { setIdx((i) => Math.min(frames.length - 1, i + 1)); setPlaying(false); e.preventDefault(); }
  }, [frames.length]);

  const frame = frames[idx];
  const stepLabel = frame.stepIndex === 0
    ? 'Before the test began'
    : frame.stepIndex == null
      ? `Frame ${idx + 1}`
      : `Step ${frame.stepIndex}`;

  return (
    <div
      ref={playerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="rounded-card border border-ink-200 bg-white overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info-500"
      aria-label="Test playback. Press space to play or pause, arrow keys to step."
    >
      <div className="bg-ink-900 aspect-[16/9] flex items-center justify-center overflow-hidden relative">
        <img
          src={absUrl(frame.url)}
          alt={frame.action || stepLabel}
          className="block max-w-full max-h-full object-contain"
          onError={(e) => { e.target.style.display = 'none'; }}
        />
        <div className="absolute top-3 left-3 px-2.5 py-1 rounded-pill bg-black/60 text-white text-2xs font-semibold uppercase tracking-wider backdrop-blur-sm">
          {stepLabel}
        </div>
        <div className="absolute bottom-3 right-3 px-2.5 py-1 rounded-pill bg-black/60 text-white text-2xs font-mono tabular-nums backdrop-blur-sm">
          {idx + 1} / {frames.length}
        </div>
      </div>

      <div className="px-4 py-3 bg-white border-t border-ink-100">
        <p className="text-sm text-ink-800 leading-snug min-h-[1.5em]">
          {frame.action || <span className="text-ink-400 italic">No caption recorded</span>}
        </p>
      </div>

      <div className="px-4 py-3 bg-ink-50 border-t border-ink-100 flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => {
            if (idx >= frames.length - 1) { setIdx(0); setPlaying(true); }
            else setPlaying((p) => !p);
          }}
          className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-ink-900 text-white hover:bg-ink-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info-500"
          aria-label={playing ? 'Pause' : 'Play'}
          title={playing ? 'Pause (space)' : 'Play (space)'}
        >
          {playing ? <Minus className="w-4 h-4 rotate-90" aria-hidden="true" /> : <ChevronRight className="w-4 h-4" aria-hidden="true" />}
        </button>
        <button
          type="button"
          onClick={() => { setIdx((i) => Math.max(0, i - 1)); setPlaying(false); }}
          disabled={idx === 0}
          className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-white border border-ink-200 text-ink-700 hover:border-ink-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          aria-label="Previous frame"
          title="Previous frame (←)"
        >
          <ChevronRight className="w-3.5 h-3.5 rotate-180" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => { setIdx((i) => Math.min(frames.length - 1, i + 1)); setPlaying(false); }}
          disabled={idx >= frames.length - 1}
          className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-white border border-ink-200 text-ink-700 hover:border-ink-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          aria-label="Next frame"
          title="Next frame (→)"
        >
          <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
        <input
          type="range"
          min={0}
          max={frames.length - 1}
          value={idx}
          onChange={(e) => { setIdx(Number(e.target.value)); setPlaying(false); }}
          className="flex-1 min-w-[140px] accent-ink-900"
          aria-label="Playback position"
        />
        <label className="inline-flex items-center gap-1.5 text-2xs text-ink-600 font-semibold uppercase tracking-wider">
          <span>Speed</span>
          <select
            value={fps}
            onChange={(e) => setFps(Number(e.target.value))}
            className="h-7 px-1.5 rounded-md border border-ink-200 bg-white text-2xs font-mono tabular-nums focus:outline-none focus:border-ink-900"
            aria-label="Playback speed"
          >
            <option value={0.5}>0.5×</option>
            <option value={1}>1×</option>
            <option value={1.5}>1.5×</option>
            <option value={2}>2×</option>
            <option value={3}>3×</option>
          </select>
        </label>
      </div>
    </div>
  );
}

// ── VisualDiffSection (Phase E4) ────────────────────────────────────
// Visual regression card — kept inside the Screenshots tab. Quiet on
// pass; reveals side-by-side on fail / inconclusive.
const VISUAL_VERDICT_META = {
  pass: {
    label: 'No visual regression',
    icon: CheckCircle2,
    text: 'text-success-700', bg: 'bg-success-50', border: 'border-success-200',
  },
  fail: {
    label: 'Visual regression detected',
    icon: AlertOctagon,
    text: 'text-danger-700', bg: 'bg-danger-50', border: 'border-danger-200',
  },
  inconclusive: {
    label: 'Inconclusive',
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
  const [open, setOpen] = useState(verdict === 'fail' || verdict === 'inconclusive');
  const hasBaseline = !!result.baselineScreenshot;
  const Icon = meta?.icon || Eye;

  return (
    <section className="rounded-card border border-ink-200 bg-white overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-5 py-3 border-b border-ink-100 flex items-center gap-2 hover:bg-ink-50 transition-colors text-left"
      >
        <Eye className="w-4 h-4 text-ink-500" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-ink-900">Visual</h3>
        {meta && (
          <span className={`text-2xs uppercase tracking-wider font-bold px-2 py-0.5 rounded-pill ${meta.bg} ${meta.text} border ${meta.border} inline-flex items-center gap-1`}>
            <Icon className="w-3 h-3" aria-hidden="true" />
            {meta.label}
          </span>
        )}
        {!meta && hasBaseline && (
          <span className="text-2xs text-ink-500">
            Baseline captured · awaiting next run for comparison
          </span>
        )}
        {open ? <ChevronDown className="w-3.5 h-3.5 ml-auto text-ink-400" aria-hidden="true" /> : <ChevronRight className="w-3.5 h-3.5 ml-auto text-ink-400" aria-hidden="true" />}
      </button>

      {open && (
        <div className="p-4 space-y-4 bg-ink-50/40">
          {result.visualDiffSummary && (
            <div className={`rounded border ${meta?.border || 'border-ink-200'} ${meta?.bg || 'bg-white'} p-3`}>
              <p className={`text-xs leading-relaxed ${meta?.text || 'text-ink-700'}`}>
                {result.visualDiffSummary}
              </p>
            </div>
          )}

          {diffs.length > 0 && (
            <ul className="space-y-1.5">
              {diffs.map((d, i) => (
                <li key={i} className="rounded border border-ink-200 bg-white p-3">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full ${SEVERITY_DOT[d.severity] || SEVERITY_DOT.low}`} aria-hidden="true" />
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
                    <ImageIcon className="w-3 h-3 text-ink-400" aria-hidden="true" />
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
                    <ImageIcon className="w-3 h-3 text-ink-400" aria-hidden="true" />
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

// ── TestHistoryPanel ────────────────────────────────────────────────
// Recent-history strip for a test case. Lives inside the DetailHeader
// in compact mode. Quiet — renders nothing on first run.
function TestHistoryPanel({ projectId, testCaseId, currentRunId, compact = false }) {
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

  if (loading || error || !data?.history?.length) return null;

  const { history, stats } = data;
  const values = history.map((h) => (h.status === 'pass' ? 2 : h.status === 'blocked' ? 1 : 0));
  const stroke = stats.passRate >= 80 ? '#10b981' : stats.passRate >= 40 ? '#f59e0b' : '#ef4444';
  const flakyTone = stats.flakyScore >= 50
    ? { cls: 'bg-danger-50 text-danger-700 border-danger-200', label: 'Often unstable' }
    : stats.flakyScore >= 20
    ? { cls: 'bg-warn-50 text-warn-700 border-warn-200', label: 'Occasionally unstable' }
    : { cls: 'bg-success-50 text-success-700 border-success-200', label: 'Stable' };

  return (
    <section className={`rounded-card ${compact ? 'bg-white/80 border border-ink-200' : 'border border-ink-200 bg-white shadow-card'} overflow-hidden`}>
      <div className={`flex items-center gap-3 flex-wrap ${compact ? 'px-4 py-2.5' : 'px-5 py-3 border-b border-ink-100'}`}>
        <History className="w-4 h-4 text-ink-500" aria-hidden="true" />
        <span className="text-xs font-semibold text-ink-700">Recent history</span>
        <span className="text-2xs text-ink-500 tabular-nums">
          {history.length} run{history.length === 1 ? '' : 's'} · {stats.passRate}% pass rate
        </span>
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-2xs font-bold uppercase tracking-wider border ${flakyTone.cls}`}>
          <TrendingUp className="w-3 h-3" aria-hidden="true" />
          {flakyTone.label}
        </span>
        <span className="ml-auto"><Sparkline values={values} width={100} height={24} stroke={stroke} /></span>
      </div>
      {!compact && (
        <div className="px-5 py-3">
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
      )}
    </section>
  );
}

// ── CaseGuidanceEditor ──────────────────────────────────────────────
// runId: the currently-selected run in the Reports page. When present the
// rerun is executed in-place within that run (no new Run row). When absent
// (edge case: component rendered before a run is selected) the button is
// disabled to avoid ambiguity about where results would land.
function CaseGuidanceEditor({ projectId, runId, testCaseId, testCaseName, initialValue, result }) {
  const toast = useToast();
  const { subscribe } = useRunStream();
  const [value, setValue] = useState(initialValue || '');
  const [serverValue, setServerValue] = useState(initialValue || '');
  const [saving, setSaving] = useState(false);
  // rerunPhase: 'idle' | 'queuing' | 'running' | 'pass' | 'fail' | 'blocked'
  const [rerunPhase, setRerunPhase] = useState('idle');
  // True once an in-place rerun passes — shows the Output Files update banner.
  const [codeUpdated, setCodeUpdated] = useState(false);
  // Set when the conductor confirms the operator's guidance was injected into
  // the prompt — gives the user proof their note was read, not just saved.
  const [guidanceApplied, setGuidanceApplied] = useState(false);

  useEffect(() => {
    setValue(initialValue || '');
    setServerValue(initialValue || '');
    setCodeUpdated(false);
    setGuidanceApplied(false);
  }, [initialValue, testCaseId, result?.id]);

  // Subscribe to WS while a rerun is in-flight so the button tracks the
  // live execution state rather than just the HTTP handshake.
  useEffect(() => {
    if (rerunPhase !== 'running') return;
    const unsub = subscribe((msg) => {
      // Conductor confirms the operator's guidance was injected into the prompt.
      if (msg.type === 'agent.guidance.applied' && msg.tcId === testCaseId) {
        setGuidanceApplied(true);
      }
      if (msg.type === 'result' && resultMatchesMessageRow(result, msg)) {
        const phase = msg.status === 'pass' ? 'pass' : msg.status === 'blocked' ? 'blocked' : 'fail';
        setRerunPhase(phase);
        if (phase === 'pass') setCodeUpdated(true);
      }
      // run.inplace.complete fires when in-place conductor finishes
      if (msg.type === 'run.inplace.complete' && msg.runId === runId) {
        setRerunPhase((p) => p === 'running' ? 'idle' : p);
      }
      // Fallback: suite run ended without a matching result event
      if (msg.type === 'run.complete') {
        setRerunPhase((p) => p === 'running' ? 'idle' : p);
      }
    });
    return unsub;
  }, [rerunPhase, testCaseId, runId, subscribe, result?.dataRowIndex, result?.testCaseId]);

  // Auto-reset the result badge after 4 s so the button returns to idle.
  useEffect(() => {
    if (rerunPhase !== 'pass' && rerunPhase !== 'fail' && rerunPhase !== 'blocked') return;
    const t = setTimeout(() => setRerunPhase('idle'), 4000);
    return () => clearTimeout(t);
  }, [rerunPhase]);

  const dirty = value !== serverValue;
  const remaining = 4000 - value.length;
  // Show rerun for fail/blocked but also for inconclusive cases (pending /
  // null) — those ran but got no verdict and need another attempt.
  const CONCLUSIVE = new Set(['pass']);
  const isFailed = !CONCLUSIVE.has(result?.status);
  const busy = saving || rerunPhase === 'queuing' || rerunPhase === 'running';

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await api.put(`/projects/${projectId}/test-cases/${testCaseId}`, { userGuidance: value });
      const v = res.testCase?.userGuidance || '';
      setServerValue(v);
      setValue(v);
      toast.success('Saved. The AI will read this before the next run of this test case.', { title: 'Guidance saved' });
    } catch (err) {
      const m = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(m, { title: 'Could not save' });
    } finally {
      setSaving(false);
    }
  };

  const handleRerunWithAI = async () => {
    if (!runId) return;
    setRerunPhase('queuing');
    setCodeUpdated(false);
    setGuidanceApplied(false);
    try {
      // In-place rerun: mutates the existing run, no new Run row.
      await api.post(`/projects/${projectId}/agents/runs/${runId}/cases/${testCaseId}/rerun`, {
        note: value || null,
      });
      setServerValue(value);
      setRerunPhase('running');
      toast.success(
        `"${testCaseName || 'Case'}" is running in-place. This run's result will update live.`,
        { title: 'Rerun started' },
      );
    } catch (err) {
      const { title, message } = formatRunStartError(err, 'Could not start rerun');
      toast.error(message, { title });
      setRerunPhase('idle');
    }
  };

  // Derive button appearance from rerunPhase
  const rerunBtn = (() => {
    switch (rerunPhase) {
      case 'queuing':  return { label: 'Queuing…',       variant: 'primary',   icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />, loading: true  };
      case 'running':  return { label: 'Running…',       variant: 'secondary', icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />, loading: false };
      case 'pass':     return { label: 'Passed',         variant: 'success',   icon: <CheckCircle2 className="w-3.5 h-3.5" />,         loading: false };
      case 'fail':     return { label: 'Check results',  variant: 'warn',      icon: <AlertCircle className="w-3.5 h-3.5" />,          loading: false };
      case 'blocked':  return { label: 'Check results',  variant: 'warn',      icon: <AlertCircle className="w-3.5 h-3.5" />,          loading: false };
      default:         return { label: 'Rerun with AI validation', variant: 'primary', icon: <Sparkles className="w-3.5 h-3.5" />,     loading: false };
    }
  })();

  return (
    <div className="rounded-card border border-ink-200 bg-white overflow-hidden">
      <div className="p-5 space-y-3">
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value.slice(0, 4000))}
          placeholder={
            isFailed
              ? `E.g. "The confirmation message on this app says 'Order received' — any variation of that wording should count as a pass for the confirmation assertion. Check the order summary section, not the page title."`
              : `E.g. "Wait for the loading spinner to disappear before clicking submit — there's a race condition on slow networks."`
          }
          rows={4}
          disabled={busy}
          className="w-full text-sm p-3 border border-ink-200 rounded-card focus:outline-none focus:border-info-400 focus:shadow-ring transition-all resize-y disabled:bg-ink-50 disabled:cursor-not-allowed leading-relaxed"
          aria-label={`Validation guidance for ${testCaseName || 'this test case'}`}
        />
        <div className="flex items-center justify-between gap-2 flex-wrap">
          {remaining < 200 ? (
            <span className={`text-2xs ${remaining < 0 ? 'text-danger-700' : 'text-warn-700'}`}>
              {remaining < 0 ? `${-remaining} over limit` : `${remaining} characters left`}
            </span>
          ) : (
            <span className="text-2xs text-ink-500">Saved per test case · applied globally on every future run.</span>
          )}
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={handleSave} disabled={!dirty || busy} loading={saving}>
              <Save className="w-3.5 h-3.5" />
              {dirty ? 'Save' : 'Saved'}
            </Button>
            {isFailed && (
              <Button
                size="sm"
                variant={rerunBtn.variant}
                onClick={rerunPhase === 'idle' ? handleRerunWithAI : undefined}
                disabled={!runId || busy || rerunPhase === 'pass' || rerunPhase === 'fail' || rerunPhase === 'blocked'}
                loading={rerunBtn.loading}
                title={!runId ? 'Select a run above to enable rerun' : undefined}
              >
                {rerunBtn.icon}
                {rerunBtn.label}
              </Button>
            )}
          </div>
        </div>
        {isFailed && rerunPhase === 'idle' && (
          <p className="text-2xs text-ink-500 leading-relaxed">
            "Rerun with AI validation" overwrites this run's result in-place — no new run entry is created. Your guidance is applied and the result updates live on this page.
          </p>
        )}
        {rerunPhase === 'running' && (
          <p className="text-2xs text-info-600 leading-relaxed">
            Running in-place — this run's result will update here when done.
          </p>
        )}
        {guidanceApplied && (
          <div className="flex items-start gap-2 rounded-lg border border-accent-200 bg-accent-50 px-3 py-2">
            <Sparkles className="w-3.5 h-3.5 text-accent-600 shrink-0 mt-0.5" aria-hidden="true" />
            <p className="text-2xs text-accent-800 leading-relaxed">
              Your guidance was applied — the AI is using your note for this run.
            </p>
          </div>
        )}
        {codeUpdated && (
          <div className="flex items-start gap-2 rounded-lg border border-success-200 bg-success-50 px-3 py-2.5">
            <CheckCircle2 className="w-4 h-4 text-success-600 shrink-0 mt-0.5" aria-hidden="true" />
            <p className="text-2xs text-success-800 leading-relaxed">
              Code has been updated in Output Files for this test case as it passed now.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── ClaudeRateLimitChip ─────────────────────────────────────────────
function ClaudeRateLimitChip({ info, aiProvider }) {
  if (aiProvider && aiProvider !== 'claude') return null;
  if (!info?.tokens?.limit) return null;
  const { remaining, limit, resetAt } = info.tokens;
  const used = Math.max(0, (limit || 0) - (remaining || 0));
  const usedPercent = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const tone = usedPercent >= 90
    ? { bar: 'bg-danger-500', bg: 'bg-danger-50', text: 'text-danger-700', border: 'border-danger-200' }
    : usedPercent >= 60
    ? { bar: 'bg-warn-500',   bg: 'bg-warn-50',   text: 'text-warn-700',   border: 'border-warn-200' }
    : { bar: 'bg-success-500',bg: 'bg-success-50',text: 'text-success-700',border: 'border-success-200' };
  const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
  const resetIn = resetIsoToCountdown(resetAt);
  return (
    <span
      className={`hidden md:inline-flex items-center gap-1.5 px-2 h-7 rounded-pill text-2xs font-semibold border ${tone.bg} ${tone.text} ${tone.border}`}
      title={`Tokens/min: ${used.toLocaleString()} of ${limit.toLocaleString()} used${resetAt ? ` · resets in ~${resetIn}` : ''}`}
      aria-label={`Anthropic token rate limit: ${usedPercent}% used`}
    >
      <Zap className="w-3 h-3" aria-hidden="true" />
      <span className="w-10 h-1.5 bg-ink-100 rounded-full overflow-hidden" aria-hidden="true">
        <span className={`block h-full ${tone.bar} transition-all`} style={{ width: `${usedPercent}%` }} />
      </span>
      <span className="tabular-nums">{usedPercent}%</span>
    </span>
  );
}

function resetIsoToCountdown(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.round(s / 60)}m`;
}
