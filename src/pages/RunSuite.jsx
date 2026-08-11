import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  motion,
  AnimatePresence,
  MotionConfig,
  useMotionValue,
  useTransform,
  animate as animateMotion,
  useReducedMotion,
} from 'framer-motion';
import {
  Upload, GitBranch, KanbanSquare, FileText, Sparkles, X, Loader2,
  AlertTriangle, GitCompareArrows, CheckCircle2, Info, FileSearch,
  ScrollText, BookOpen, Code2, ClipboardList, StopCircle, GitPullRequest,
  Plug, Plus, ChevronRight, Activity, Database, Table2, Trash2, RefreshCw,
  Check, Copy,
} from 'lucide-react';
import api, { ApiError } from '../lib/apiClient';
import { useProject } from '../store/project';
import { useToast } from '../lib/useToast';
import { sanitizeUiMessage } from '../lib/userFacingMessages';
import { useRunStream, usePipelineState } from '../store/runStream';
import { estimateArchitectCost, formatTokens } from '../lib/costEstimate';
import Button from '../components/ui/Button';
import Skeleton from '../components/ui/Skeleton';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import GenerationGuidancePanel from '../components/GenerationGuidancePanel';
import { GenerateConfigCard } from './TestCases';
import { QAAI_AUTHORING_TEMPLATE } from '../components/testCases/AuthoringAssist';

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * Run Suite V2 — "Mission briefing → launch"
 *
 * Page story (top to bottom):
 *   1. READINESS — the hero. Aggregates "what's queued, what it'll cost,
 *      what's missing". Morphs into the live Architect theatre when running.
 *   2. SOURCES   — three channels (ADO / Jira / Upload), pulse-indicated.
 *   3. DROP ZONE — primary action surface for the most common path.
 *   4. DIFF CTX  — optional code-diff context for the Architect's prior.
 *   5. DISCREP.  — only when contradictions were detected.
 *   6. QUEUE     — requirements grouped by category, re-categorisable inline.
 *
 * Reuses the Aurora Glass vocabulary established by Overview V2 but bends
 * it for this task: lighter aurora intensity (less competing with reading),
 * a single dominant hero CTA, sequential narrative instead of card-grid.
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Format whitelists (mirror the server). Reject non-whitelisted formats up front
// so .doc/.rtf/.odt/.pptx/images are never sent as raw text → binary mojibake.
// Keyed off extension only (structural), never any site-specific value.
const REQ_DOC_EXT_RE = /\.(pdf|docx|html?|json|txt|md|markdown|csv|log|png|jpe?g|webp|gif)$/i;
// Formats that must be sent as a base64 data URL (binary) rather than read as
// text: PDFs, DOCX, and images (the latter go to the vision extractor).
const REQ_DOC_BINARY_RE = /\.(pdf|docx|png|jpe?g|webp|gif)$/i;
const TEST_DATA_EXT_RE = /\.(xlsx|xlsm|xls|csv|tsv|txt)$/i;

// Surface server-side honest-signal degradation records as toasts so the user
// sees rejected/scanned/truncated documents instead of a silent success.
function showDegradations(records, toast, title) {
  if (!Array.isArray(records) || !records.length) return;
  records.slice(0, 3).forEach((d) => {
    const msg = `${d.reason || 'Document needs attention'}${d.impact ? ` - ${d.impact}` : ''}`;
    if (d.severity === 'info') toast.info(msg, { title });
    else toast.warning(msg, { title, ttl: 8000 });
  });
}

const SIGNAL = {
  success: '#10b981',
  danger:  '#ef4444',
  warn:    '#f59e0b',
  info:    '#3b82f6',
  accent:  '#8b5cf6',
  ink:     '#9aa3b4',
};

// Category metadata — mirrors the server's guessCategory() enum. Each one
// is a "lens" the Architect uses on the docs.
const CATEGORY_META = {
  brd: {
    label: 'Business Requirements',
    short: 'BRD',
    icon: BookOpen,
    blurb: 'The contract — what the system must do.',
    tone: 'info',
    importance: 'critical',  // strongest signal for the Architect
  },
  'release-notes': {
    label: 'Release Notes',
    short: 'Release',
    icon: ScrollText,
    blurb: "What's shipping — drives Smart-select.",
    tone: 'warn',
    importance: 'high',
  },
  'user-stories': {
    label: 'User Stories',
    short: 'Stories',
    icon: ClipboardList,
    blurb: 'As-a / I-want / So-that — best for acceptance criteria.',
    tone: 'accent',
    importance: 'high',
  },
  'api-spec': {
    label: 'API Spec',
    short: 'API',
    icon: Code2,
    blurb: 'OpenAPI / Swagger / endpoint contracts.',
    tone: 'success',
    importance: 'medium',
  },
  other: {
    label: 'Other',
    short: 'Other',
    icon: FileText,
    blurb: 'Mockup notes, design docs, anything else.',
    tone: 'ink',
    importance: 'low',
  },
};

const CATEGORY_ORDER = ['brd', 'release-notes', 'user-stories', 'api-spec', 'other'];

const TONE_TEXT = {
  success: 'text-success-700',
  danger:  'text-danger-700',
  warn:    'text-warn-700',
  info:    'text-info-700',
  accent:  'text-accent-700',
  ink:     'text-ink-600',
};
const TONE_BG = {
  success: 'bg-success-50/70 border-success-200/60',
  danger:  'bg-danger-50/70  border-danger-200/60',
  warn:    'bg-warn-50/70    border-warn-200/60',
  info:    'bg-info-50/70    border-info-200/60',
  accent:  'bg-accent-50/70  border-accent-200/60',
  ink:     'bg-ink-100/70    border-ink-200/60',
};

function normalizeArchitectStatus(rawStatus, cancelling = false) {
  if (cancelling && (!rawStatus || rawStatus === 'idle' || rawStatus === 'running')) return 'cancelling';
  if (rawStatus === 'failed') return 'error';
  if (['running', 'cancelling', 'complete', 'cancelled', 'error'].includes(rawStatus)) return rawStatus;
  return 'idle';
}

function mapArchitectLogs(logs = []) {
  return (Array.isArray(logs) ? logs : []).slice(-12).map((e) => ({
    level: e.level || 'info',
    message: e.message || '',
    at: e.ts || Date.now(),
  }));
}

function isLiveArchitectStatus(status) {
  return ['running', 'cancelling', 'complete', 'error', 'cancelled'].includes(status);
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Lighter aurora — Run Suite has dense reading content, so the background
// stays quieter than Overview's. Two slow orbs instead of four.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function AuroraSoft() {
  return (
    <div className="aurora-canvas grain-overlay" aria-hidden="true">
      <div
        className="aurora-orb aurora-orb-accent aurora-drift-1"
        style={{ width: '46vw', height: '46vw', top: '-8vw', left: '-4vw', opacity: 0.35 }}
      />
      <div
        className="aurora-orb aurora-orb-info aurora-drift-2"
        style={{ width: '40vw', height: '40vw', top: '-2vw', right: '-6vw', opacity: 0.32 }}
      />
      <div
        className="aurora-orb aurora-orb-success aurora-drift-3"
        style={{ width: '36vw', height: '36vw', bottom: '-10vw', left: '24vw', opacity: 0.26 }}
      />
    </div>
  );
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// AnimatedNumber — counts to value via framer-motion, respecting reduced motion.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function AnimatedNumber({ value, suffix = '', duration = 0.8, decimals = 0 }) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(0);
  const display = useTransform(mv, (v) =>
    decimals > 0 ? v.toFixed(decimals) : Math.round(v).toLocaleString()
  );
  useEffect(() => {
    if (reduce) { mv.set(value || 0); return; }
    const c = animateMotion(mv, value || 0, { duration, ease: [0.22, 1, 0.36, 1] });
    return c.stop;
  }, [value, duration, reduce, mv]);
  return (
    <span className="tabular-nums">
      <motion.span>{display}</motion.span>
      {suffix}
    </span>
  );
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// RunSuite — page
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function RunSuite() {
  const navigate = useNavigate();
  const toast = useToast();
  const {
    current,
    currentSprintId,
    generations,
    refreshGenerations,
    switchGeneration,
  } = useProject();
  const { subscribe } = useRunStream();
  const { pipelineState } = usePipelineState();

  const [requirements, setRequirements] = useState([]);
  const [testDataSets, setTestDataSets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [testDataUploading, setTestDataUploading] = useState(false);
  const [deletingTdId, setDeletingTdId] = useState(null);
  const [mappingTdId, setMappingTdId] = useState(null);
  const [approvingTdId, setApprovingTdId] = useState(null);
  const [testDataLoadError, setTestDataLoadError] = useState(null);
  const [pulling, setPulling] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const [guidanceSaving, setGuidanceSaving] = useState(false);
  const [suiteGuidance, setSuiteGuidance] = useState(null);
  const [showGenerationConfig, setShowGenerationConfig] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [integrations, setIntegrations] = useState({ claude: null, ado: null, jira: null });
  const [discrepancies, setDiscrepancies] = useState([]);
  const [detecting, setDetecting] = useState(false);
  const [discrepancyModalOpen, setDiscrepancyModalOpen] = useState(false);

  // Live Architect phase state — inline-owned per CLAUDE.md (the global
  // floating indicator hides itself on this route).
  // Lazy initialisers seed from global pipelineState so returning to this page
  // mid-Architect-run restores the live-theatre view instead of snapping back
  // to "Ready." (identical fix to TestCases.jsx which had the same complaint).
  const [phaseLog, setPhaseLog] = useState(() => {
    return mapArchitectLogs(pipelineState?.logs?.architect || []);
  });
  const [phaseStatus, setPhaseStatus] = useState(() => {
    return normalizeArchitectStatus(pipelineState?.phaseStatus?.architect, pipelineState?.cancelling);
  });
  const [phaseStartedAt, setPhaseStartedAt] = useState(0);
  const [phaseElapsed, setPhaseElapsed] = useState(0);
  const startedAtRef = useRef(0);

  const load = useCallback(async (signal) => {
    if (!current) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const sprintQs = currentSprintId ? `?sprintId=${encodeURIComponent(currentSprintId)}` : '';
      const [reqs, testData, claude, ado, jira, disc] = await Promise.all([
        api.get(`/projects/${current.id}/requirements${sprintQs}`, { signal }),
        api.get(`/projects/${current.id}/test-data${sprintQs}`, { signal }).catch((error) => ({ __loadError: error })),
        api.get('/settings/claude', { signal }).catch(() => null),
        api.get('/settings/ado', { signal }).catch(() => null),
        api.get('/settings/jira', { signal }).catch(() => null),
        api.get(`/projects/${current.id}/discrepancies`, { signal }).catch(() => ({ discrepancies: [] })),
      ]);
      setRequirements(reqs?.requirements || []);
      if (testData?.__loadError) {
        setTestDataSets([]);
        setTestDataLoadError(testData.__loadError?.message || 'Test data could not be loaded.');
      } else {
        setTestDataSets(testData?.testDataSets || []);
        setTestDataLoadError(null);
      }
      setIntegrations({ claude, ado, jira });
      setDiscrepancies(disc?.discrepancies || []);
    } catch (err) {
      if (err?.code !== 'ABORTED') toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [current, toast, currentSprintId]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (!discrepancies.length) setDiscrepancyModalOpen(false);
  }, [discrepancies.length]);

  useEffect(() => {
    if (!discrepancyModalOpen) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') setDiscrepancyModalOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [discrepancyModalOpen]);

  // WS Architect subscription — keep the inline theatre in sync with live generation.
  useEffect(() => {
    const unsub = subscribe((msg) => {
      if (msg.projectId && current?.id && msg.projectId !== current.id) return;
      if (msg.type === 'agent.phase.start' && msg.phase === 'architect') {
        setPhaseStatus('running');
        setPhaseLog([]);
        const now = Date.now();
        setPhaseStartedAt(now);
        startedAtRef.current = now;
      } else if (msg.type === 'agent.phase.log' && msg.phase === 'architect') {
        setPhaseLog((lines) => {
          const next = [...lines, { level: msg.level || 'info', message: msg.message || '', at: Date.now() }];
          return next.length > 12 ? next.slice(-12) : next;
        });
        setPhaseStatus((prev) => (prev === 'idle' ? 'running' : prev));
        if (!startedAtRef.current) {
          const now = Date.now();
          setPhaseStartedAt(now);
          startedAtRef.current = now;
        }
      } else if (msg.type === 'agent.phase.complete' && msg.phase === 'architect') {
        if (msg.cancelled || msg.error === 'cancelled') setPhaseStatus('cancelled');
        else if (msg.error) setPhaseStatus('error');
        else setPhaseStatus('complete');
      } else if (msg.type === 'run.cancelling') {
        setPhaseStatus((prev) => (prev === 'running' || prev === 'idle' ? 'cancelling' : prev));
        setPhaseLog((lines) => {
          const next = [...lines, {
            level: 'warn',
            message: 'Cancellation requested - stopping generation.',
            at: Date.now(),
          }];
          return next.length > 12 ? next.slice(-12) : next;
        });
      }
    });
    return unsub;
  }, [subscribe, current?.id]);

  useEffect(() => {
    // Reset local phase state on project switch. The lazy initialisers above
    // seed from global pipelineState on the FIRST mount for the same project;
    // this effect handles the "switched to a different project" case where the
    // previous project's phase state must not bleed into the new one.
    const seed = normalizeArchitectStatus(pipelineState?.phaseStatus?.architect, pipelineState?.cancelling);
    const seedLogs = mapArchitectLogs(pipelineState?.logs?.architect || []);
    setPhaseStatus(seed);
    setPhaseLog(seedLogs);
    const elapsedMs = Number(pipelineState?.architectProgress?.elapsedMs || 0);
    if (seed === 'running' || seed === 'cancelling') {
      const started = Date.now() - Math.max(0, elapsedMs);
      setPhaseStartedAt(started);
      startedAtRef.current = started;
      setPhaseElapsed(Math.floor(Math.max(0, elapsedMs) / 1000));
    } else {
      setPhaseStartedAt(0);
      startedAtRef.current = 0;
      setPhaseElapsed(0);
    }
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const globalStatus = normalizeArchitectStatus(pipelineState?.phaseStatus?.architect, pipelineState?.cancelling);
    if (globalStatus === 'idle') return;
    setPhaseStatus(globalStatus);
    setPhaseLog(mapArchitectLogs(pipelineState?.logs?.architect || []));
    if (globalStatus === 'running' || globalStatus === 'cancelling') {
      const elapsedMs = Number(pipelineState?.architectProgress?.elapsedMs || 0);
      if (!startedAtRef.current || elapsedMs > 0) {
        const started = Date.now() - Math.max(0, elapsedMs);
        startedAtRef.current = started;
        setPhaseStartedAt(started);
      }
      if (elapsedMs > 0) setPhaseElapsed(Math.floor(elapsedMs / 1000));
    }
  }, [
    current?.id,
    pipelineState?.phaseStatus?.architect,
    pipelineState?.cancelling,
    pipelineState?.architectProgress?.elapsedMs,
    pipelineState?.logs?.architect,
  ]);

  useEffect(() => {
    if (phaseStatus !== 'running' && phaseStatus !== 'cancelling') return;
    // If we mounted mid-run (lazy init seeded phaseStatus as 'running' but
    // startedAtRef is 0 because no agent.phase.start event was received in this
    // session), seed the ref to now so the elapsed counter shows seconds since
    // page-load rather than seconds since Unix epoch (~1.7 billion).
    if (!startedAtRef.current) {
      const now = Date.now();
      startedAtRef.current = now;
      setPhaseStartedAt(now);
    }
    const id = setInterval(() => setPhaseElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000)), 500);
    return () => clearInterval(id);
  }, [phaseStatus]);

  // â”€â”€â”€ Action handlers (identical business logic to RunSuite.jsx) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const handleDetectDiscrepancies = useCallback(async () => {
    if (!current) return;
    setDetecting(true);
    try {
      const res = await api.post(`/projects/${current.id}/analyst/detect-discrepancies`, {});
      setDiscrepancies(res.discrepancies || []);
      setDiscrepancyModalOpen((res.discrepancies || []).length > 0);
      toast.success(
        res.discrepancies.length
          ? `Found ${res.discrepancies.length} discrepancy/-ies.`
          : 'No discrepancies found — your docs are consistent.',
        { title: 'Analyst finished' }
      );
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Detect failed' });
    } finally {
      setDetecting(false);
    }
  }, [current, toast]);

  const resolveDiscrepancy = useCallback(async (id) => {
    try {
      await api.post(`/projects/${current.id}/discrepancies/${id}/resolve`, {});
      setDiscrepancies((d) => d.filter((x) => x.id !== id));
    } catch (err) { toast.error(err.message); }
  }, [current, toast]);

  const handleFiles = useCallback(async (files) => {
    if (!current || !files?.length) return;
    setUploading(true);
    try {
      const docs = await Promise.all([...files].map(async (file) => {
        if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} exceeds 5 MB limit.`);
        if (!REQ_DOC_EXT_RE.test(file.name)) {
          throw new Error(`${file.name}: unsupported format — use PDF, DOCX, HTML, JSON, Markdown, plain text, or a screenshot (PNG/JPG).`);
        }
        const content = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = reject;
          if (REQ_DOC_BINARY_RE.test(file.name)) r.readAsDataURL(file);
          else r.readAsText(file);
        });
        return { name: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size, content };
      }));
      const res = await api.post(`/projects/${current.id}/requirements/upload`, {
        documents: docs,
        sprintId: currentSprintId || null,
      });
      const cats = [...new Set((res.created || []).map((c) => CATEGORY_META[c.category]?.short || 'Other'))];
      const createdCount = (res.created || []).length;
      if (createdCount > 0) {
        toast.success(
          `${createdCount} doc(s) indexed${cats.length ? ` - ${cats.join(', ')}` : ''}.`,
          { title: 'Upload complete' }
        );
      } else {
        toast.warning(
          'No documents were indexed. Review the upload warning and provide a readable source file.',
          { title: 'Upload needs attention', ttl: 8000 }
        );
      }
      if (Array.isArray(res.warnings) && res.warnings.length) {
        res.warnings.slice(0, 3).forEach((w) => {
          toast.warning(sanitizeUiMessage(w, { context: 'document' }), {
            title: 'Document needs attention',
            context: 'document',
            ttl: 8000,
          });
        });
      }
      showDegradations(res.degradations, toast, 'Document not fully ingested');
      await load();
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Upload failed' });
    } finally {
      setUploading(false);
    }
  }, [current, toast, load, currentSprintId]);

  const handleTestDataFiles = useCallback(async (files) => {
    if (!current || !files?.length) return;
    setTestDataUploading(true);
    try {
      const documents = await Promise.all([...files].map(async (file) => {
        if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} exceeds 5 MB limit.`);
        if (!TEST_DATA_EXT_RE.test(file.name)) {
          throw new Error(`${file.name}: unsupported test-data format — use XLSX, XLS or CSV.`);
        }
        const content = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = reject;
          if (/\.(xlsx|xlsm|xls)$/i.test(file.name)) r.readAsDataURL(file);
          else r.readAsText(file);
        });
        return { name: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size, content };
      }));
      const res = await api.post(`/projects/${current.id}/test-data`, {
        documents,
        sprintId: currentSprintId || null,
      });
      toast.success(res.message || `${(res.created || []).length} test data file(s) indexed.`, {
        title: 'Test data uploaded',
      });
      if (Array.isArray(res.warnings) && res.warnings.length) {
        res.warnings.slice(0, 3).forEach((w) => {
          toast.warning(sanitizeUiMessage(w, { context: 'test-data' }), {
            title: 'Test data needs attention',
            context: 'test-data',
            ttl: 8000,
          });
        });
      }
      showDegradations(res.degradations, toast, 'Test data not fully ingested');
      await load();
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Test data upload failed' });
    } finally {
      setTestDataUploading(false);
    }
  }, [current, toast, load, currentSprintId]);

  const handleDeleteTestData = useCallback(async (tdId) => {
    if (!current || !tdId) return;
    setDeletingTdId(tdId);
    try {
      await api.del(`/projects/${current.id}/test-data/${tdId}`);
      setTestDataSets((all) => all.filter((x) => x.id !== tdId));
      toast.success('Test data removed.');
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Could not remove test data' });
    } finally {
      setDeletingTdId(null);
    }
  }, [current, toast]);

  const handleApproveTestData = useCallback(async (tdId, approvalNote = '') => {
    if (!current || approvingTdId) return;
    setApprovingTdId(tdId);
    try {
      const note = String(approvalNote || '').trim();
      const res = await api.post(`/projects/${current.id}/test-data/${tdId}/approve`, note ? { approvalNote: note } : {});
      const version = res?.approved?.version;
      toast.success(`Mapping${version ? ` v${version}` : ''} frozen for generation and execution.`, {
        title: 'Test data approved',
      });
      await load();
    } catch (err) {
      const message = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(message || 'Could not approve the test-data mapping.', {
        title: err instanceof ApiError && err.payload?.code === 'APPROVAL_NOTE_REQUIRED'
          ? 'Review note required'
          : 'Approval failed',
      });
    } finally {
      setApprovingTdId(null);
    }
  }, [approvingTdId, current, load, toast]);

  const handleMapTestData = useCallback(async (tdId) => {
    if (!current || mappingTdId) return;
    setMappingTdId(tdId);
    try {
      const res = await api.post(`/projects/${current.id}/test-data/${tdId}/map`, {});
      const bindingCount = res?.mapping?.bindings?.length || 0;
      toast.success(`Prepared ${bindingCount} deterministic sheet mapping${bindingCount === 1 ? '' : 's'} for review.`, {
        title: 'Mapping refreshed',
      });
      await load();
    } catch (err) {
      const message = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(message || 'Could not build the test-data mapping.', { title: 'Mapping failed' });
    } finally {
      setMappingTdId(null);
    }
  }, [current, load, mappingTdId, toast]);

  const handlePull = useCallback(async (source) => {
    if (!current) return;
    setPulling(source);
    try {
      const res = await api.post(`/projects/${current.id}/requirements/pull/${source}`, {
        sprintId: currentSprintId || null,
      });
      toast.success(res.message);
      await load();
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: `${source.toUpperCase()} pull failed` });
    } finally {
      setPulling(null);
    }
  }, [current, toast, load, currentSprintId]);

  const handleOpenGenerationConfig = useCallback(() => {
    if (!current) return;
    if (testDataLoadError) {
      toast.error('Reload test data before generating; QAAI will not treat an unavailable dataset inventory as empty.', {
        title: 'Test data unavailable',
      });
      return;
    }
    const incompleteDatasets = testDataSets.filter((td) => td?.datasetContract?.stats?.complete !== true);
    if (incompleteDatasets.length) {
      toast.error(`Re-upload ${incompleteDatasets.length} incomplete test-data file${incompleteDatasets.length === 1 ? '' : 's'} before generating.`, {
        title: 'Dataset contract incomplete',
      });
      return;
    }
    if (!requirements.length) {
      toast.error('Upload BRD, user stories, release notes, or API docs before generating test cases.', {
        title: 'No source documents',
      });
      return;
    }
    const unapproved = testDataSets.filter((td) => td?.mappingState !== 'approved');
    if (unapproved.length) {
      toast.warning(`Approve ${unapproved.length} test-data mapping${unapproved.length === 1 ? '' : 's'} before generating.`, {
        title: 'Test-data review required',
      });
      return;
    }
    setShowGenerationConfig(true);
  }, [current, requirements.length, testDataLoadError, testDataSets, toast]);

  const handleGenerate = useCallback(async (sessionGuidance = null, options = {}) => {
    if (!current) return;
    if (testDataLoadError) {
      toast.error('Reload test data before generating; its approved revision pins are unavailable.', {
        title: 'Test data unavailable',
      });
      return;
    }
    if (testDataSets.some((td) => td?.datasetContract?.stats?.complete !== true)) {
      toast.error('Re-upload incomplete test data before generating.', {
        title: 'Dataset contract incomplete',
      });
      return;
    }
    if (!requirements.length) {
      toast.error('Upload BRD, user stories, release notes, or API docs before generating test cases.', {
        title: 'No source documents',
      });
      return;
    }
    const now = Date.now();
    startedAtRef.current = now;
    setPhaseStartedAt(now);
    setPhaseElapsed(0);
    setPhaseStatus('running');
    setShowGenerationConfig(false);
    const modeLabel = String(sessionGuidance || '').match(/\[GENERATION MODE\s*[—–-]\s*([^\]]+)\]/i)?.[1] || 'configured';
    setPhaseLog([{
      level: 'info',
      message: `Starting ${modeLabel} test-case generation: preparing the site atlas (reused if recent and matching, re-crawled only if needed), re-reading sources, binding test data, and rebuilding assertions.`,
      at: now,
    }]);
    setGenerating(true);
    try {
      const body = {
        replace: true,
        // No longer forced on every run — the backend reuses a recent matching
        // atlas and re-crawls only when justified (explicit rebuild toggle,
        // target/identity change, deeper mode, or staleness). Forced ONLY when
        // the user ticked "Rebuild site atlas" in the generation config.
        forceAtlasRefresh: options?.forceAtlasRefresh === true,
        ...(options?.generationMode ? { generationMode: options.generationMode } : {}),
        requirementIds: requirements.map((r) => r.id).filter(Boolean),
        testDataSetIds: testDataSets.map((td) => td.id).filter(Boolean),
        testDataMappingPins: Object.fromEntries(testDataSets
          .filter((td) => td?.id && td?.approvedMapping?.id)
          .map((td) => [td.id, td.approvedMapping.id])),
        ...(suiteGuidance?.id ? { guidanceId: suiteGuidance.id } : {}),
        ...(sessionGuidance ? { sessionGuidance } : {}),
        ...(options?.module ? { module: options.module } : {}),
        ...(options?.focusArea ? { focusArea: options.focusArea } : {}),
      };
      const res = await api.post(`/projects/${current.id}/scenarios/generate`, body);
      toast.success(
        `${res?.stats?.scenarios ?? '?'} scenarios · ${res?.stats?.cases ?? '?'} test cases`,
        { title: 'Test cases rebuilt — review and approve' },
      );
      if (res?.generationId) {
        await refreshGenerations();
        switchGeneration(res.generationId);
      }
      setSuiteGuidance(null);
      navigate('/test-cases?just=generated');
    } catch (err) {
      let raw = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      try {
        const jsonStart = raw.indexOf('{');
        if (jsonStart >= 0) {
          const parsed = JSON.parse(raw.slice(jsonStart));
          raw = parsed?.error?.message || parsed?.message || raw;
        }
      } catch (_) {}
      setPhaseStatus('error');
      setPhaseLog((all) => [
        ...all,
        { level: 'error', message: raw || 'Generation failed.', at: Date.now() },
      ]);
      const hasGeneratedSuiteNow = Array.isArray(generations) && generations.length > 0;
      toast.error(raw, { title: hasGeneratedSuiteNow ? 'Regenerate failed' : 'Generate failed' });
    } finally {
      setGenerating(false);
    }
  }, [current, requirements, testDataLoadError, testDataSets, suiteGuidance, toast, refreshGenerations, switchGeneration, navigate, generations]);

  const handleSaveGuidance = useCallback(async ({ instruction, quickIntents }) => {
    if (!current) return;
    setGuidanceSaving(true);
    try {
      const res = await api.post(`/projects/${current.id}/generation-guidance`, {
        scope: 'suite',
        sourceSurface: 'run-suite',
        sprintId: currentSprintId || null,
        instruction,
        quickIntents,
        subject: current.name,
      });
      setSuiteGuidance(res.guidance);
      setGuidanceOpen(false);
      const hasGeneratedSuiteNow = Array.isArray(generations) && generations.length > 0;
      toast.success(`Generation brief saved. It will be applied to the next ${hasGeneratedSuiteNow ? 'Regenerate' : 'Generate'} Test Cases run.`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Could not save guidance' });
    } finally {
      setGuidanceSaving(false);
    }
  }, [current, currentSprintId, toast, generations]);

  const handleTerminate = useCallback(async () => {
    if (!current || (phaseStatus !== 'running' && phaseStatus !== 'cancelling')) return;
    setPhaseStatus('cancelling');
    setPhaseLog((lines) => {
      const next = [...lines, {
        level: 'warn',
        message: 'Cancellation requested - stopping generation.',
        at: Date.now(),
      }];
      return next.length > 12 ? next.slice(-12) : next;
    });
    try { await api.post(`/projects/${current.id}/agents/cancel`, {}); }
    catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Could not cancel' });
    }
  }, [current, phaseStatus, toast]);

  const updateRequirementCategory = useCallback(async (req, nextCategory) => {
    if (!current) return;
    const sourceIdentifier = req.sourceIdentifier;
    setRequirements((all) => all.map((r) => (r.id === req.id ? { ...r, category: nextCategory } : r)));
    try {
      if (req.sourceType === 'upload' && sourceIdentifier) {
        await api.put(`/projects/${current.id}/documents/${sourceIdentifier}/category`, { category: nextCategory });
      } else {
        throw new ApiError(400, { message: "Re-categorising pulled work items isn't supported yet." });
      }
      toast.success(`Marked as ${CATEGORY_META[nextCategory]?.short || nextCategory}.`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Could not re-categorise' });
      await load();
    }
  }, [current, toast, load]);

  const removingIdsRef = useRef(new Set());
  const removeReq = useCallback(async (id) => {
    if (!current || removingIdsRef.current.has(id)) return;
    removingIdsRef.current.add(id);
    try {
      await api.del(`/projects/${current.id}/requirements/${id}`);
      setRequirements((r) => r.filter((x) => x.id !== id));
    } catch (err) {
      toast.error(err.message);
    } finally {
      removingIdsRef.current.delete(id);
    }
  }, [current, toast]);

  // â”€â”€â”€ Derived â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const reqsByCategory = useMemo(() => {
    const map = new Map();
    for (const key of CATEGORY_ORDER) map.set(key, []);
    for (const r of requirements) {
      const cat = CATEGORY_META[r.category] ? r.category : 'other';
      map.get(cat).push(r);
    }
    return map;
  }, [requirements]);

  const costEstimate = useMemo(
    () => estimateArchitectCost(requirements.map((r) => r.content || '')),
    [requirements]
  );

  const claudeReady = integrations.claude?.configured && integrations.claude?.status === 'valid';
  const adoReady = integrations.ado?.configured && integrations.ado?.status === 'valid';
  const jiraReady = integrations.jira?.configured && integrations.jira?.status === 'valid';
  const hasBrd = (reqsByCategory.get('brd') || []).length > 0;
  const hasAnyReq = requirements.length > 0;
  const generationBusy = phaseStatus === 'running' || phaseStatus === 'cancelling';
  const unapprovedTestDataCount = testDataSets.filter((td) => td?.mappingState !== 'approved').length;
  const incompleteTestDataCount = testDataSets.filter((td) => td?.datasetContract?.stats?.complete !== true).length;
  const testDataReady = !testDataLoadError && unapprovedTestDataCount === 0 && incompleteTestDataCount === 0;
  const canGenerate = claudeReady && hasAnyReq && testDataReady && !generationBusy;
  const hasGeneratedSuite = Array.isArray(generations) && generations.some((g) =>
    Number(g?.scenarioCount || 0) > 0 || Number(g?.caseCount || 0) > 0
  );
  const generationActionLabel = hasGeneratedSuite ? 'Regenerate Test Cases' : 'Generate Test Cases';
  const generationActionVerb = hasGeneratedSuite ? 'regenerating' : 'generating';
  const generationBriefTitle = hasGeneratedSuite ? 'Guide the next test-case rebuild' : 'Guide the first test-case generation';
  const generationBriefSubtitle = hasGeneratedSuite
    ? 'Tell QAAI what to include, focus on, or avoid. The brief is saved and applied when you click Regenerate Test Cases.'
    : 'Tell QAAI what to include, focus on, or avoid. The brief is saved and applied when you click Generate Test Cases.';

  // Empty state — no project picked yet
  if (!current) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Run Suite" />
        <main className="flex-1 bg-ink-50">
          <EmptyState icon={FileText} title="No project selected" message="Create or activate a project first." />
        </main>
      </div>
    );
  }

  return (
    // MotionConfig with reducedMotion="user" — framer-motion respects
    // prefers-reduced-motion automatically: transforms snap, opacity stays.
    // One wrapper at the page root covers every nested motion.* component.
    <MotionConfig reducedMotion="user">
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader title="Run Suite" subtitle={current.name}>
        <Button
          size="sm"
          variant={suiteGuidance ? 'secondary' : 'outline'}
          onClick={() => setGuidanceOpen(true)}
          disabled={generating || generationBusy}
          title={`Tell QAAI what to include, focus on, or avoid during the next test-case ${hasGeneratedSuite ? 'rebuild' : 'generation'}`}
        >
          <Sparkles className="w-3.5 h-3.5" />
          {suiteGuidance ? 'Brief saved' : 'Generation brief'}
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={handleOpenGenerationConfig}
          loading={generating || generationBusy}
          disabled={!canGenerate}
          title={
            !hasAnyReq
              ? 'Upload or pull source documents first'
              : !claudeReady
                ? `Configure an AI provider before ${generationActionVerb} test cases`
                : !testDataReady
                  ? `Review and approve ${unapprovedTestDataCount} test-data mapping${unapprovedTestDataCount === 1 ? '' : 's'} before ${generationActionVerb}`
                : `Choose generation mode, scope, and focus before ${generationActionVerb} test cases`
          }
        >
          {!(generating || generationBusy) && <RefreshCw className="w-3.5 h-3.5" />}
          {generationActionLabel}
        </Button>
        <Button
          size="sm" variant="secondary"
          onClick={handleDetectDiscrepancies}
          loading={detecting}
          disabled={detecting || requirements.length < 2 || !claudeReady}
        >
          <GitCompareArrows className="w-3.5 h-3.5" />
          Detect discrepancies
          {discrepancies.length > 0 && (
            <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-pill bg-warn-100 px-1.5 text-2xs font-bold text-warn-800">
              {discrepancies.length}
            </span>
          )}
        </Button>
      </PageHeader>

      <main
        className="flex-1 overflow-y-auto relative"
        style={{ scrollbarGutter: 'stable' }}
      >
        <div
          className="sticky top-0 overflow-hidden pointer-events-none"
          style={{ height: '100dvh', marginBottom: '-100dvh', zIndex: 0 }}
          aria-hidden="true"
        >
          <AuroraSoft />
        </div>

        <div className="relative z-10 max-w-6xl mx-auto px-page py-8 space-y-7">
          {loading ? (
            <RunSuiteSkeleton />
          ) : (
            <>
              {/* â”€â”€ HERO â”€â”€ morphs from "ready to launch" → "live theatre"  */}
              <ReadinessHero
                status={phaseStatus}
                requirements={requirements}
                reqsByCategory={reqsByCategory}
                costEstimate={costEstimate}
                canGenerate={canGenerate}
                generating={generating}
                hasGeneratedSuite={hasGeneratedSuite}
                claudeReady={claudeReady}
                testDataReady={testDataReady}
                unapprovedTestDataCount={unapprovedTestDataCount}
                phaseLog={phaseLog}
                elapsed={phaseElapsed}
                scenariosSoFar={pipelineState?.architectProgress?.scenariosSoFar || 0}
                onGenerate={handleOpenGenerationConfig}
                onTerminate={handleTerminate}
                onDismiss={() => { setPhaseStatus('idle'); setPhaseLog([]); }}
              />

              {showGenerationConfig && !generationBusy ? (
                <GenerateConfigCard
                  projectId={current?.id}
                  onGenerate={handleGenerate}
                  onCancel={() => setShowGenerationConfig(false)}
                  generating={generating || generationBusy}
                />
              ) : (
                <>
                  {/* â”€â”€ SOURCES â”€â”€ three channels, status-pulsed              */}
                  <SourcesStrip
                    ado={{ ready: adoReady, info: integrations.ado, pulling: pulling === 'ado', onPull: () => handlePull('ado') }}
                    jira={{ ready: jiraReady, info: integrations.jira, pulling: pulling === 'jira', onPull: () => handlePull('jira') }}
                    uploading={uploading}
                    onFiles={handleFiles}
                  />

                  {/* â”€â”€ DROP ZONE â”€â”€ immersive, glass, animated on drag       */}
                  <DropZone
                    dragging={dragging}
                    uploading={uploading}
                    onDrag={setDragging}
                    onFiles={handleFiles}
                    onOpenGuide={() => setShowGuide(true)}
                  />

                  <AIBriefStrip
                    requirements={requirements}
                    reqsByCategory={reqsByCategory}
                    testDataSets={testDataSets}
                  />

                  <TestDataPanel
                    testDataSets={testDataSets}
                    uploading={testDataUploading}
                    deletingTdId={deletingTdId}
                    mappingTdId={mappingTdId}
                    approvingTdId={approvingTdId}
                    loadError={testDataLoadError}
                    onFiles={handleTestDataFiles}
                    onDelete={handleDeleteTestData}
                    onMap={handleMapTestData}
                    onApprove={handleApproveTestData}
                  />

                  {/* â”€â”€ DIFF CONTEXT â”€â”€ optional Architect prior              */}
                  <DiffContextCard
                    projectId={current.id}
                    sprintId={currentSprintId || null}
                    claudeReady={claudeReady}
                  />

                  {/* â”€â”€ DISCREPANCIES â”€â”€ only when present                    */}
                  <AnimatePresence>
                    {discrepancies.length > 0 && (
                      <DiscrepanciesSummary
                        discrepancies={discrepancies}
                        onOpen={() => setDiscrepancyModalOpen(true)}
                      />
                    )}
                  </AnimatePresence>

                  {/* â”€â”€ QUEUE â”€â”€ grouped requirements                         */}
                  {!hasAnyReq && !generationBusy && (
                    <EmptyEducation />
                  )}

                  {hasAnyReq && (
                    <div className="space-y-4">
                      <QueueHeader requirements={requirements} reqsByCategory={reqsByCategory} />
                      <RequirementsQueue
                        reqsByCategory={reqsByCategory}
                        onCategoryChange={updateRequirementCategory}
                        onRemove={removeReq}
                      />
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </main>
      <UserStoryGuideModal
        open={showGuide}
        onClose={() => setShowGuide(false)}
      />
      <DiscrepanciesModal
        open={discrepancyModalOpen && discrepancies.length > 0}
        discrepancies={discrepancies}
        onResolve={resolveDiscrepancy}
        onClose={() => setDiscrepancyModalOpen(false)}
      />
      <GenerationGuidancePanel
        open={guidanceOpen}
        title={generationBriefTitle}
        subtitle={generationBriefSubtitle}
        subject={current?.name}
        submitLabel="Save brief"
        loading={guidanceSaving}
        onClose={() => setGuidanceOpen(false)}
        onSubmit={handleSaveGuidance}
      />
    </div>
    </MotionConfig>
  );
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ReadinessHero — the centerpiece. Two distinct states:
//   IDLE/READY  → "X requirements queued. ~Ys, $Z." + big GENERATE button.
//                 Coverage chips show which categories are present.
//   RUNNING/etc → terminal-style live theatre with streaming Architect log.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function ReadinessHero({
  status, requirements, reqsByCategory, costEstimate, canGenerate, generating,
  hasGeneratedSuite, claudeReady, testDataReady, unapprovedTestDataCount,
  phaseLog, elapsed, scenariosSoFar, onGenerate, onTerminate, onDismiss,
}) {
  const isLive = isLiveArchitectStatus(status);

  return (
    <motion.section
      layout
      transition={{ layout: { duration: 0.5, ease: [0.22, 1, 0.36, 1] } }}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass relative overflow-hidden p-7 md:p-9"
    >
      <AnimatePresence mode="wait">
        {isLive ? (
          <LiveTheatre
            key="live"
            status={status}
            log={phaseLog}
            elapsed={elapsed}
            scenariosSoFar={scenariosSoFar}
            onTerminate={onTerminate}
            onDismiss={onDismiss}
          />
        ) : (
          <ReadyState
            key="ready"
            requirements={requirements}
            reqsByCategory={reqsByCategory}
            costEstimate={costEstimate}
            canGenerate={canGenerate}
            generating={generating}
            hasGeneratedSuite={hasGeneratedSuite}
            claudeReady={claudeReady}
            testDataReady={testDataReady}
            unapprovedTestDataCount={unapprovedTestDataCount}
            onGenerate={onGenerate}
          />
        )}
      </AnimatePresence>
    </motion.section>
  );
}

function ReadyState({ requirements, reqsByCategory, costEstimate, canGenerate, generating, hasGeneratedSuite, claudeReady, testDataReady, unapprovedTestDataCount, onGenerate }) {
  const hasAny = requirements.length > 0;
  const presentCats = CATEGORY_ORDER.filter((c) => (reqsByCategory.get(c) || []).length > 0);
  const missingCriticalBrd = !((reqsByCategory.get('brd') || []).length);
  const suiteAction = hasGeneratedSuite
    ? {
        eyebrow: 'Rebuild suite',
        verb: 'Regenerate',
        line: 'Refresh atlas, bind data, rebuild assertions →',
      }
    : {
        eyebrow: 'Build suite',
        verb: 'Generate',
        line: 'Read sources, bind data, create assertions →',
      };

  return (
    <motion.div
      key="ready"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.45 }}
      className="grid lg:grid-cols-[1fr_auto] gap-8 lg:gap-12 items-center"
    >
      {/* Left — the brief */}
      <div className="min-w-0">
        <div className="text-2xs uppercase tracking-[0.22em] font-bold text-ink-500 mb-3 flex items-center gap-1.5">
          <Sparkles className="w-3 h-3" />
          Generation readiness
        </div>

        <h2 className="font-display text-[64px] md:text-[80px] leading-[0.95] tracking-tight text-ink-900">
          {hasAny ? 'Ready.' : 'Awaiting evidence.'}
        </h2>

        <p className="mt-4 text-base text-ink-700 max-w-xl">
          {hasAny ? (
            <>
              <AnimatedNumber value={requirements.length} /> source item{requirements.length === 1 ? '' : 's'} queued across{' '}
              <span className="font-semibold text-ink-900">{presentCats.length}</span> categor{presentCats.length === 1 ? 'y' : 'ies'}.
              The Architect will read everything and propose scenarios with rationale.
            </>
          ) : (
            <>
              Pull from a tracker or drop files below. The Architect needs at least one document — a BRD gives the
              richest result.
            </>
          )}
        </p>

        {/* Category coverage chips */}
        {hasAny && (
          <div className="mt-5 flex items-center gap-2 flex-wrap">
            {CATEGORY_ORDER.map((cat) => {
              const items = reqsByCategory.get(cat) || [];
              const meta = CATEGORY_META[cat];
              const present = items.length > 0;
              const Icon = meta.icon;
              return (
                <span
                  key={cat}
                  className={`inline-flex items-center gap-1.5 px-2.5 h-7 rounded-pill border text-xs font-semibold backdrop-blur-sm transition-all ${
                    present ? TONE_BG[meta.tone] + ' ' + TONE_TEXT[meta.tone] : 'bg-white/40 border-ink-200/50 text-ink-400'
                  }`}
                  title={present ? `${items.length} ${meta.label.toLowerCase()}` : `No ${meta.label.toLowerCase()} yet`}
                >
                  <Icon className="w-3 h-3" />
                  {meta.short}
                  {present && (
                    <span className="tabular-nums opacity-80">{items.length}</span>
                  )}
                </span>
              );
            })}
          </div>
        )}

        {/* Pre-flight cost line */}
        {hasAny && (
          <div className="mt-5 flex items-center gap-3 flex-wrap text-sm text-ink-700">
            <span className="inline-flex items-center gap-1.5">
              <span className="text-2xs uppercase tracking-wider font-bold text-ink-500">cost</span>
              <span className="font-semibold tabular-nums">{costEstimate.costDisplay}</span>
            </span>
            <span className="text-ink-300">·</span>
            <span className="inline-flex items-center gap-1.5">
              <span className="text-2xs uppercase tracking-wider font-bold text-ink-500">~time</span>
              <span className="font-semibold tabular-nums">{costEstimate.secondsEstimate}s</span>
            </span>
            <span className="text-ink-300">·</span>
            <span className="inline-flex items-center gap-1.5 text-ink-500">
              <span className="tabular-nums">{formatTokens(costEstimate.inputTokens)}</span> in
              <span className="text-ink-300">·</span>
              <span className="tabular-nums">≤{formatTokens(costEstimate.outputTokensMax)}</span> out
            </span>
          </div>
        )}

        {/* Hints when the CTA isn't ready */}
        {hasAny && (!claudeReady || !testDataReady || missingCriticalBrd) && (
          <p className="mt-3 text-2xs text-warn-700 italic">
            {!claudeReady
              ? 'Configure Claude API in Settings → Claude before generating.'
              : !testDataReady
                ? `Review and approve ${unapprovedTestDataCount} test-data mapping${unapprovedTestDataCount === 1 ? '' : 's'} below before generating.`
              : 'No BRD detected — the Architect will use what is available, but a BRD gives the best result.'}
          </p>
        )}
      </div>

      {/* Right — the launch button */}
      <div className="flex flex-col items-stretch lg:items-end gap-3 lg:min-w-[280px]">
        <motion.button
          type="button"
          onClick={onGenerate}
          disabled={!canGenerate}
          whileHover={canGenerate ? { scale: 1.02 } : {}}
          whileTap={canGenerate ? { scale: 0.98 } : {}}
          className={`relative group overflow-hidden rounded-2xl px-7 py-5 text-left transition-all duration-300 ${
            canGenerate
              ? 'bg-ink-900 text-white shadow-[0_24px_48px_-12px_rgba(15,23,42,0.40)] hover:shadow-[0_32px_56px_-12px_rgba(15,23,42,0.50)]'
              : 'bg-ink-100 text-ink-400 cursor-not-allowed'
          }`}
        >
          {/* Aurora glow inside the button on ready state */}
          {canGenerate && (
            <span
              aria-hidden="true"
              className="absolute inset-0 opacity-50 blur-2xl"
              style={{
                background: 'radial-gradient(circle at 30% 30%, #8b5cf6 0%, transparent 60%), radial-gradient(circle at 70% 70%, #3b82f6 0%, transparent 60%)',
              }}
            />
          )}
          <div className="relative">
            <div className="text-2xs uppercase tracking-[0.22em] font-bold opacity-70 mb-2">
              {suiteAction.eyebrow}
            </div>
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="font-display text-[34px] leading-none italic">
                {suiteAction.verb}
              </span>
              {generating ? (
                <Loader2 className="w-5 h-5 opacity-80 animate-spin" />
              ) : (
                <Sparkles className="w-5 h-5 opacity-80 group-hover:rotate-12 transition-transform" />
              )}
            </div>
            <div className="text-sm font-semibold mt-1">
              Test Cases
            </div>
            <div className="text-xs opacity-75 mt-2">
              {canGenerate
                ? suiteAction.line
                : (!testDataReady ? 'Approve test-data mappings first' : 'Add source docs and configure AI first')}
            </div>
          </div>
        </motion.button>
      </div>
    </motion.div>
  );
}

function LiveTheatre({ status, log, elapsed, scenariosSoFar, onTerminate, onDismiss }) {
  const statusMeta = {
    running:   { word: 'Working...',   tone: 'info',    icon: Loader2,         spin: true,  bg: 'from-info-500/15'    },
    cancelling: { word: 'Stopping...', tone: 'warn',    icon: Loader2,         spin: true,  bg: 'from-warn-500/15'    },
    complete:  { word: 'Done.',      tone: 'success', icon: CheckCircle2,    spin: false, bg: 'from-success-500/15' },
    cancelled: { word: 'Stopped.',   tone: 'ink',     icon: StopCircle,      spin: false, bg: 'from-ink-400/15'     },
    error:     { word: 'Failed.',    tone: 'danger',  icon: AlertTriangle,   spin: false, bg: 'from-danger-500/15'  },
  }[status] || { word: 'Ready.', tone: 'ink', icon: Activity, spin: false, bg: 'from-ink-400/15' };
  const Icon = statusMeta.icon;
  const lastFew = log.slice(-12);
  const buildingScenarios = status === 'running' && scenariosSoFar > 0;
  const active = status === 'running' || status === 'cancelling';

  return (
    <motion.div
      key="live"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.45 }}
      className="grid lg:grid-cols-[1fr_1.4fr] gap-8 items-stretch"
    >
      {/* Left — status face */}
      <div>
        <div className="text-2xs uppercase tracking-[0.22em] font-bold text-ink-500 mb-3 flex items-center gap-1.5">
          <Sparkles className="w-3 h-3" />
          Architect
        </div>
        <h2 className={`font-display text-[64px] md:text-[80px] leading-[0.95] tracking-tight ${TONE_TEXT[statusMeta.tone]}`}>
          {statusMeta.word}
        </h2>
        <div className="mt-4 flex items-center gap-3 text-sm text-ink-700">
          <Icon className={`w-5 h-5 ${TONE_TEXT[statusMeta.tone]} ${statusMeta.spin ? 'animate-spin' : ''}`} />
          {active && (
            <>
              <span>
                <span className="font-semibold tabular-nums">{elapsed}s</span>
                <span className="text-ink-500"> elapsed</span>
              </span>
              {buildingScenarios && (
                <motion.span
                  key={scenariosSoFar}
                  initial={{ scale: 0.85, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent-100 text-accent-700 text-xs font-semibold"
                >
                  <Sparkles className="w-3 h-3" />
                  {scenariosSoFar} scenario{scenariosSoFar === 1 ? '' : 's'}
                </motion.span>
              )}
              {status === 'running' ? (
                <button
                  type="button"
                  onClick={onTerminate}
                  className="ml-auto inline-flex items-center gap-1.5 h-8 px-3 rounded-pill text-xs font-semibold text-danger-700 bg-white/70 backdrop-blur border border-danger-200/60 hover:bg-danger-50 transition-colors"
                >
                  <StopCircle className="w-3.5 h-3.5" />
                  Terminate
                </button>
              ) : (
                <span className="ml-auto inline-flex items-center gap-1.5 h-8 px-3 rounded-pill text-xs font-semibold text-warn-700 bg-warn-50/80 border border-warn-200/70">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Stop requested
                </span>
              )}
            </>
          )}
          {status === 'cancelled' && <span className="text-ink-600">Stopped after {elapsed}s. Nothing was persisted.</span>}
          {status === 'complete' && <span className="text-success-700 font-semibold">Navigating to Test Cases...</span>}
          {status === 'error' && <span className="text-danger-700">Check the log on the right for the cause.</span>}
          {(status === 'complete' || status === 'cancelled' || status === 'error') && (
            <button onClick={onDismiss} className="ml-auto text-ink-400 hover:text-ink-700" aria-label="Dismiss">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Right — streaming terminal log */}
      <div className="relative rounded-2xl overflow-hidden bg-ink-900 text-ink-100 shadow-[0_24px_48px_-12px_rgba(15,23,42,0.40)] min-h-[220px]">
        {/* Aurora-tinted gradient overlay above the terminal */}
        <div className={`absolute inset-0 bg-gradient-to-tr ${statusMeta.bg} via-transparent to-transparent pointer-events-none`} />
        <div className="relative p-4 font-mono text-2xs leading-relaxed max-h-[320px] overflow-y-auto">
          {lastFew.length === 0 && (
            <div className="text-ink-400 italic">waiting for first log line...</div>
          )}
          <AnimatePresence initial={false}>
            {lastFew.map((line, i) => (
              <motion.div
                key={`${line.at}-${i}`}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.25 }}
                className={
                  line.level === 'error' ? 'text-danger-300'
                  : line.level === 'warn' ? 'text-warn-300'
                  : 'text-ink-200'
                }
              >
                <span className="text-ink-500 mr-2">{String(i + 1).padStart(2, '0')}</span>
                {line.message}
              </motion.div>
            ))}
            {buildingScenarios && (
              <motion.div
                key="scenario-progress"
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.25 }}
                className="text-accent-300 mt-1"
              >
                <span className="text-ink-500 mr-2">→</span>
                <span className="font-semibold tabular-nums">{scenariosSoFar}</span>
                {' '}scenario{scenariosSoFar === 1 ? '' : 's'} built so far
                <motion.span
                  animate={{ opacity: [1, 0.2, 1] }}
                  transition={{ duration: 1.2, repeat: Infinity }}
                  className="ml-1"
                >...</motion.span>
              </motion.div>
            )}
            {active && !buildingScenarios && (
              <motion.span
                key="cursor"
                animate={{ opacity: [1, 0.2, 1] }}
                transition={{ duration: 1, repeat: Infinity }}
                className={`inline-block w-2 h-3 align-middle ${status === 'cancelling' ? 'bg-warn-400' : 'bg-info-400'}`}
              />
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// SourcesStrip — three channels in a flowing row, no card-grid heaviness.
// Each channel is a soft glass pill with a pulse showing connection.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function SourcesStrip({ ado, jira, uploading, onFiles }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1, duration: 0.45 }}
      className="grid md:grid-cols-3 gap-3"
    >
      <ChannelCard
        icon={GitBranch}
        title="Azure DevOps"
        connected={ado.ready}
        subtitle={ado.ready ? `${ado.info?.projectName || 'project'}` : 'Not configured'}
        action={
          ado.ready ? (
            <button
              onClick={ado.onPull}
              disabled={ado.pulling}
              className="text-xs font-semibold text-info-700 inline-flex items-center gap-1 hover:gap-1.5 transition-all disabled:opacity-50"
            >
              {ado.pulling ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
              {ado.pulling ? 'Pulling...' : 'Pull work items'}
              {!ado.pulling && <ChevronRight className="w-3 h-3" />}
            </button>
          ) : (
            <a href="/settings/ado" className="text-xs font-semibold text-ink-500 inline-flex items-center gap-1 hover:text-ink-900 transition-colors">
              <Plug className="w-3 h-3" /> Configure
            </a>
          )
        }
      />
      <ChannelCard
        icon={KanbanSquare}
        title="Jira"
        connected={jira.ready}
        subtitle={jira.ready ? `${jira.info?.projectKey || 'project'}` : 'Not configured'}
        action={
          jira.ready ? (
            <button
              onClick={jira.onPull}
              disabled={jira.pulling}
              className="text-xs font-semibold text-info-700 inline-flex items-center gap-1 hover:gap-1.5 transition-all disabled:opacity-50"
            >
              {jira.pulling ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
              {jira.pulling ? 'Pulling...' : 'Pull issues'}
              {!jira.pulling && <ChevronRight className="w-3 h-3" />}
            </button>
          ) : (
            <a href="/settings/jira" className="text-xs font-semibold text-ink-500 inline-flex items-center gap-1 hover:text-ink-900 transition-colors">
              <Plug className="w-3 h-3" /> Configure
            </a>
          )
        }
      />
      <ChannelCard
        icon={Upload}
        title="Upload"
        connected={true}
        subtitle="PDF, DOCX, MD, JSON, HTML, TXT, or screenshots (PNG/JPG) — 5 MB max"
        action={
          <label className="text-xs font-semibold text-info-700 inline-flex items-center gap-1 hover:gap-1.5 transition-all cursor-pointer">
            <input
              type="file" multiple
              accept=".txt,.md,.html,.json,.pdf,.docx,.png,.jpg,.jpeg,.webp,.gif"
              className="hidden"
              onChange={(e) => onFiles(e.target.files)}
            />
            {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
            {uploading ? 'Uploading...' : 'Choose files'}
          </label>
        }
      />
    </motion.section>
  );
}

function ChannelCard({ icon: Icon, title, connected, subtitle, action }) {
  return (
    <div className="glass-soft p-4 flex items-center gap-3">
      <div className="w-10 h-10 rounded-xl bg-white/70 border border-white/60 inline-flex items-center justify-center shrink-0">
        <Icon className="w-4 h-4 text-ink-700" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-ink-900">{title}</span>
          {/* Pulse dot */}
          <span className="relative inline-flex w-2 h-2">
            {connected && (
              <span className="absolute inset-0 rounded-full bg-success-500 animate-ping opacity-40" />
            )}
            <span className={`relative inline-flex rounded-full w-2 h-2 ${connected ? 'bg-success-500' : 'bg-warn-500'}`} />
          </span>
        </div>
        <div className="text-2xs text-ink-500 truncate mt-0.5">{subtitle}</div>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// DropZone — immersive, glass, scales+glows on drag.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function DropZone({ dragging, uploading, onDrag, onFiles, onOpenGuide }) {
  return (
    <motion.div
      onDragOver={(e) => { e.preventDefault(); onDrag(true); }}
      onDragLeave={() => onDrag(false)}
      onDrop={(e) => { e.preventDefault(); onDrag(false); onFiles(e.dataTransfer.files); }}
      animate={{
        scale: dragging ? 1.015 : 1,
        boxShadow: dragging
          ? '0 32px 56px -12px rgba(139,92,246,0.30), 0 0 0 2px rgba(139,92,246,0.30) inset'
          : '0 0 0 1px rgba(255,255,255,0.55) inset',
      }}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      className="relative overflow-hidden rounded-2xl border border-dashed border-ink-300/70 bg-white/40 backdrop-blur-md text-center py-8 px-6"
    >
      {dragging && (
        <div
          className="absolute inset-0 opacity-40 pointer-events-none"
          aria-hidden="true"
          style={{ background: 'radial-gradient(circle at center, #8b5cf6 0%, transparent 65%)' }}
        />
      )}
      <div className="relative">
        {uploading ? (
          <Loader2 className="w-7 h-7 mx-auto text-ink-500 mb-2 animate-spin" />
        ) : (
          <Upload className={`w-7 h-7 mx-auto mb-2 transition-colors ${dragging ? 'text-accent-700' : 'text-ink-400'}`} />
        )}
        <p className="text-sm font-semibold text-ink-800">
          {dragging ? 'Drop to add' : 'Drag & drop documents anywhere'}
        </p>
        <p className="text-xs text-ink-500 mt-1">
          PDF · DOCX · Markdown · JSON · HTML · TXT — up to 5 MB each
        </p>
        <div className="mt-3 flex items-center justify-center">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenGuide?.();
            }}
            className="inline-flex items-center gap-1.5 rounded-full border border-accent-200/80 bg-accent-50/80 px-3.5 py-1 text-xs font-semibold text-accent-700 shadow-xs transition hover:bg-accent-100 hover:border-accent-300 focus-visible:outline-none focus-visible:shadow-ring"
          >
            <BookOpen className="h-3.5 w-3.5 text-accent-600" />
            <span>Format Guide & Action Keywords</span>
          </button>
        </div>
      </div>
    </motion.div>
  );
}

function UserStoryGuideModal({ open, onClose }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();

  const copyTemplate = async () => {
    try {
      await navigator.clipboard.writeText(QAAI_AUTHORING_TEMPLATE);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
      toast.success('Sample user story markdown copied to clipboard');
    } catch {
      toast.info('Could not copy automatically. Please select text to copy.');
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6" role="dialog" aria-modal="true">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 bg-ink-900/40 backdrop-blur-sm"
      />

      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 8 }}
        className="relative z-10 max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-3xl border border-white/80 bg-white/95 p-6 shadow-2xl backdrop-blur-xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-ink-100 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-100 text-accent-700">
                <BookOpen className="h-4 w-4" />
              </div>
              <h2 className="text-lg font-bold text-ink-900">User Story & Test Flow Writing Guide</h2>
            </div>
            <p className="mt-1 text-xs text-ink-500">
              Upload documents using these action keywords and variable tokens to ensure 100% automated precision.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700 transition focus-visible:outline-none"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-accent-200/70 bg-accent-50/40 p-3.5">
            <span className="text-xs font-bold uppercase tracking-wider text-accent-800">1. Action Keywords</span>
            <ul className="mt-2 space-y-1 text-xs text-ink-700 font-mono">
              <li><span className="text-accent-900 font-semibold">Navigate to "url"</span></li>
              <li><span className="text-accent-900 font-semibold">Fill "field" with "val"</span></li>
              <li><span className="text-accent-900 font-semibold">Select "opt" from "menu"</span></li>
              <li><span className="text-accent-900 font-semibold">Click "button"</span></li>
              <li><span className="text-accent-900 font-semibold">Check / Uncheck "box"</span></li>
              <li><span className="text-accent-900 font-semibold">Clear "field"</span></li>
              <li><span className="text-accent-900 font-semibold">Upload "file.pdf"</span></li>
              <li><span className="text-accent-900 font-semibold">PressKey "Enter"</span></li>
            </ul>
          </div>

          <div className="rounded-xl border border-success-200/70 bg-success-50/40 p-3.5">
            <span className="text-xs font-bold uppercase tracking-wider text-success-800">2. Validations & Gherkin</span>
            <ul className="mt-2 space-y-1 text-xs text-ink-700">
              <li><code className="font-semibold text-success-900 font-mono">Verify "elem" is visible</code></li>
              <li><code className="font-semibold text-success-900 font-mono">Verify "elem" displays text</code></li>
              <li><code className="font-semibold text-success-900 font-mono">Verify "btn" is disabled</code></li>
              <li><code className="font-semibold text-success-900 font-mono">Verify "box" is checked</code></li>
              <li className="pt-1.5 font-medium text-ink-600">Supports Gherkin:</li>
              <li className="font-semibold text-ink-800">Given / When / Then / And</li>
            </ul>
          </div>

          <div className="rounded-xl border border-info-200/70 bg-info-50/40 p-3.5">
            <span className="text-xs font-bold uppercase tracking-wider text-info-800">3. Variables & Secrets</span>
            <p className="mt-2 text-xs leading-relaxed text-ink-700">
              Use <code className="font-semibold text-info-900 font-mono">{'{{Customer Name}}'}</code> to bind variables to dataset tables.
            </p>
            <p className="mt-2.5 text-xs leading-relaxed text-ink-700">
              Use <code className="font-semibold text-warn-800 bg-warn-50 px-1 py-0.5 rounded font-mono">{'{{env:PASSWORD}}'}</code> for environment passwords & secrets.
            </p>
          </div>
        </div>

        <div className="mt-5 rounded-2xl border border-ink-800 bg-ink-900 p-4 text-white">
          <div className="flex items-center justify-between gap-3 border-b border-ink-700 pb-2.5">
            <span className="text-xs font-semibold text-ink-300">Standard Sample Markdown (One-Click Copy)</span>
            <button
              type="button"
              onClick={copyTemplate}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-accent-500 focus-visible:outline-none"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-success-300" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied to Clipboard' : 'Copy Sample Markdown'}
            </button>
          </div>
          <pre className="mt-3 max-h-56 overflow-y-auto font-mono text-xs leading-relaxed text-ink-100 select-all whitespace-pre-wrap">
            {QAAI_AUTHORING_TEMPLATE}
          </pre>
        </div>

        <div className="mt-5 flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </motion.div>
    </div>
  );
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// DiscrepanciesPanel — alarm-tone glass card, only present when discrepancies
// were detected. Each item is a row with kind + severity + summary + resolve.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// AIBriefStrip — replaces the old DocumentUnderstandingPanel.
// One slim bar: what's in the brief + test data status. Read-only, no interaction.
function AIBriefStrip({ requirements, reqsByCategory, testDataSets }) {
  if (!requirements.length) return null;

  const brdCount = (reqsByCategory.get('brd') || []).length;
  const storyCount = (reqsByCategory.get('user-stories') || []).length;
  const releaseCount = (reqsByCategory.get('release-notes') || []).length;
  const totalSheets = testDataSets.reduce((n, td) => n + (Array.isArray(td.sheets) ? td.sheets.length : 0), 0);
  const totalRows = testDataSets.reduce((n, td) => n + (td.rowCount || 0), 0);
  const hasTestData = testDataSets.length > 0;

  const pills = [
    brdCount > 0 && { label: `BRD (${brdCount})`, tone: 'info' },
    storyCount > 0 && { label: `Stories (${storyCount})`, tone: 'accent' },
    releaseCount > 0 && { label: `Release Notes (${releaseCount})`, tone: 'warn' },
  ].filter(Boolean);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.08, duration: 0.35 }}
      className="glass-soft px-4 py-3 flex items-center gap-3 flex-wrap"
    >
      <div className="w-8 h-8 rounded-lg bg-accent-50/80 border border-accent-200/60 inline-flex items-center justify-center shrink-0">
        <Sparkles className="w-3.5 h-3.5 text-accent-600" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-ink-900">
            {requirements.length} requirement{requirements.length === 1 ? '' : 's'} queued
          </span>
          {pills.map((p) => (
            <span key={p.label} className={`inline-flex px-2 h-5 items-center rounded-pill text-2xs font-bold border ${TONE_BG[p.tone]} ${TONE_TEXT[p.tone]}`}>
              {p.label}
            </span>
          ))}
        </div>
        <div className="text-2xs text-ink-500 mt-0.5">
          {hasTestData
            ? `Test data: ${totalSheets} sheet${totalSheets === 1 ? '' : 's'} · ${totalRows} row${totalRows === 1 ? '' : 's'} — AI maps this to your requirements at generation time`
            : 'Upload test data below to have AI link rows to generated scenarios'}
        </div>
      </div>
      <div className="inline-flex items-center gap-1.5 rounded-pill border border-success-200 bg-success-50/70 px-2.5 py-1 text-2xs font-bold text-success-700 shrink-0">
        <CheckCircle2 className="w-3 h-3" />
        Ready for AI
      </div>
    </motion.div>
  );
}

function TestDataPanel({ testDataSets, uploading, deletingTdId, mappingTdId, approvingTdId, loadError, onFiles, onDelete, onMap, onApprove }) {
  const hasData = testDataSets.length > 0;
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.12, duration: 0.45 }}
      className="glass overflow-hidden"
    >
      <header className="px-5 py-4 border-b border-white/60 bg-white/30 flex items-center gap-3 flex-wrap">
        <div className="w-10 h-10 rounded-xl bg-success-50/80 border border-success-200/70 inline-flex items-center justify-center shrink-0">
          <Database className="w-4 h-4 text-success-700" />
        </div>
        <div className="flex-1 min-w-[220px]">
          <h2 className="text-sm font-semibold text-ink-900">Test data</h2>
          <p className="text-2xs text-ink-500 mt-0.5">
            Upload CSV or Excel — AI maps each sheet to your requirements and links rows to generated scenarios.
          </p>
        </div>
        <label className="inline-flex h-9 items-center gap-2 rounded-lg bg-ink-900 px-3 text-xs font-semibold text-white shadow-sm cursor-pointer hover:bg-ink-800 transition-colors">
          <input
            type="file"
            multiple
            accept=".csv,.xlsx,.xlsm,.xls"
            className="hidden"
            onChange={(e) => onFiles(e.target.files)}
          />
          {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
          {uploading ? 'Uploading...' : 'Upload data'}
        </label>
      </header>

      <div className="p-5 space-y-4">
        {loadError && (
          <div className="rounded-xl border border-danger-200 bg-danger-50/70 px-4 py-3 text-xs text-danger-800">
            Test data is unavailable: {loadError}. Generation is blocked until this inventory reloads successfully.
          </div>
        )}
        {!hasData && (
          <div className="rounded-xl border border-dashed border-ink-200/80 bg-white/45 px-4 py-5 text-center">
            <Table2 className="w-5 h-5 mx-auto text-ink-400 mb-2" />
            <p className="text-sm font-semibold text-ink-800">No test data uploaded yet.</p>
            <p className="text-xs text-ink-500 mt-1">
              Upload Excel or CSV data. QAAI profiles every accepted sheet and row within the displayed parser limits, then asks you to approve the proposed mapping before generation.
            </p>
          </div>
        )}

        {hasData && testDataSets.map((td) => (
          <TestDataSetCard
            key={td.id}
            dataset={td}
            deleting={deletingTdId === td.id}
            mapping={mappingTdId === td.id}
            approving={approvingTdId === td.id}
            onDelete={onDelete}
            onMap={onMap}
            onApprove={onApprove}
          />
        ))}
      </div>
    </motion.section>
  );
}

function cloneMapping(mapping) {
  if (!mapping || typeof mapping !== 'object') return null;
  return {
    ...mapping,
    version: mapping.version || 1,
    bindings: Array.isArray(mapping.bindings)
      ? mapping.bindings.map((binding) => ({
          ...binding,
          columnToField: { ...(binding.columnToField || {}) },
          sensitivity: { ...(binding.sensitivity || {}) },
          ignoredColumns: Array.isArray(binding.ignoredColumns)
            ? binding.ignoredColumns.map((item) => ({ ...item }))
            : [],
        }))
      : [],
    unmapped: Array.isArray(mapping.unmapped)
      ? mapping.unmapped.map((item) => ({ ...item }))
      : [],
    ignored: Array.isArray(mapping.ignored)
      ? mapping.ignored.map((item) => ({ ...item }))
      : [],
    understanding: mapping.understanding
      ? {
          ...mapping.understanding,
          sheets: Array.isArray(mapping.understanding.sheets)
            ? mapping.understanding.sheets.map((sheet) => ({ ...sheet }))
            : [],
        }
      : mapping.understanding,
  };
}

function TestDataSetCard({ dataset, deleting, mapping, approving, onDelete, onMap, onApprove }) {
  const [approvalNote, setApprovalNote] = useState('');
  const sheetCount = Array.isArray(dataset.sheets) ? dataset.sheets.length : 0;
  const rawMapping = dataset.mappingJson ? (typeof dataset.mappingJson === 'string' ? (() => { try { return JSON.parse(dataset.mappingJson); } catch { return null; } })() : dataset.mappingJson) : null;
  const mappingJson = cloneMapping(rawMapping);
  const bindingCount = mappingJson?.bindings?.length || 0;
  const isMapped = bindingCount > 0;
  const isApproved = dataset.mappingState === 'approved';

  return (
    <article className="rounded-xl border border-white/70 bg-white/55 backdrop-blur-sm overflow-hidden">
      <header className="px-4 py-3 border-b border-ink-100/70 flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-white/80 border border-ink-100 inline-flex items-center justify-center shrink-0">
          <Table2 className="w-4 h-4 text-ink-700" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-ink-900 truncate">{dataset.name}</div>
          <div className="text-2xs text-ink-500 mt-0.5 flex items-center gap-2 flex-wrap">
            <span>{sheetCount} sheet{sheetCount === 1 ? '' : 's'}</span>
            <span className="text-ink-300">|</span>
            <span>{dataset.rowCount || 0} row{dataset.rowCount === 1 ? '' : 's'}</span>
            {dataset.uploadedAt && (
              <>
                <span className="text-ink-300">|</span>
                <span>{new Date(dataset.uploadedAt).toLocaleDateString()}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isApproved ? (
            <span className="inline-flex h-7 items-center gap-1 rounded-pill border border-success-200 bg-success-50/70 px-2.5 text-2xs font-bold text-success-700">
              <CheckCircle2 className="w-3 h-3" />
              Approved · v{dataset.approvedMapping?.version || mappingJson?.version || 1}
            </span>
          ) : isMapped ? (
            <span className="inline-flex h-7 items-center gap-1 rounded-pill border border-warn-200 bg-warn-50/70 px-2.5 text-2xs font-bold text-warn-700">
              <AlertTriangle className="w-3 h-3" />
              Review mapping · {bindingCount} sheet{bindingCount === 1 ? '' : 's'}
            </span>
          ) : (
            <span className="inline-flex h-7 items-center gap-1 rounded-pill border border-info-200 bg-info-50/70 px-2.5 text-2xs font-bold text-info-700">
              <Sparkles className="w-3 h-3" />
              Mapping required
            </span>
          )}
          <button
            type="button"
            onClick={() => onDelete(dataset.id)}
            disabled={deleting}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-400 hover:text-danger-700 hover:bg-danger-50 disabled:opacity-50"
            title="Remove test data"
            aria-label="Remove test data"
          >
            {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </header>

      {Array.isArray(dataset.warnings) && dataset.warnings.length > 0 && (
        <div className="px-4 py-2 bg-warn-50/50 border-b border-warn-100 text-2xs text-warn-800 space-y-1">
          {dataset.warnings.slice(0, 3).map((w) => <div key={w}>{w}</div>)}
        </div>
      )}

      <div className="p-4">
        <TestDataUnderstandingSummary dataset={dataset} mapping={mappingJson} />
        {!isApproved && isMapped ? (
          <div className="mb-3 rounded-lg border border-warn-200 bg-warn-50/55 p-3">
            <div className="text-xs font-semibold text-ink-900">Freeze this mapping before generation</div>
            <p className="mt-1 text-2xs text-ink-600">
              Approval pins the exact dataset and mapping revision used by generated cases. Add a review note when low-confidence or unmapped columns are intentional.
            </p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={approvalNote}
                onChange={(event) => setApprovalNote(event.target.value)}
                placeholder="Review note (required when warnings exist)"
                aria-label={`Review note for ${dataset.name}`}
                className="h-9 min-w-0 flex-1 rounded-lg border border-ink-200 bg-white px-3 text-xs text-ink-800 outline-none focus:border-info-400"
              />
              <button
                type="button"
                onClick={() => onApprove(dataset.id, approvalNote)}
                disabled={approving}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-ink-900 px-3 text-xs font-semibold text-white hover:bg-ink-800 disabled:opacity-50"
              >
                {approving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                {approving ? 'Approving…' : 'Approve mapping'}
              </button>
            </div>
          </div>
        ) : null}
        {!isApproved && !isMapped ? (
          <div className="mb-3 flex flex-col gap-3 rounded-lg border border-info-200 bg-info-50/55 p-3 sm:flex-row sm:items-center">
            <div className="flex-1">
              <div className="text-xs font-semibold text-ink-900">Build a mapping before generation</div>
              <p className="mt-1 text-2xs text-ink-600">
                QAAI will re-read the scoped requirement understanding and propose exact sheet/column bindings. You review and approve the result before cases are planned.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onMap(dataset.id)}
              disabled={mapping}
              className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg bg-ink-900 px-3 text-xs font-semibold text-white hover:bg-ink-800 disabled:opacity-50"
            >
              {mapping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {mapping ? 'Mapping…' : 'Build mapping'}
            </button>
          </div>
        ) : null}
        <TestDataPreview sheets={dataset.sheets || []} />
      </div>
    </article>
  );
}


function TestDataUnderstandingSummary({ dataset, mapping }) {
  const understanding = dataset.testDataUnderstanding || mapping?.understanding || null;
  if (!understanding) return null;

  const sheets = Array.isArray(understanding.sheets) ? understanding.sheets : [];
  const modules = Array.from(new Set(sheets.map((sheet) => sheet.module).filter(Boolean)));
  const highConfidence = sheets.filter((sheet) => sheet.confidence === 'high').length;
  const reviewColumns = sheets.reduce((total, sheet) => total + (Array.isArray(sheet.unmappedColumns) ? sheet.unmappedColumns.length : 0), 0);
  const roleCount = sheets.reduce((total, sheet) => total + (Array.isArray(sheet.inputRoles) ? sheet.inputRoles.length : 0), 0);

  return (
    <div className="mb-3 rounded-lg border border-info-100 bg-info-50/55 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <div className="mt-0.5 h-6 w-6 rounded-md bg-white/75 border border-info-100 inline-flex items-center justify-center shrink-0">
          <Sparkles className="w-3.5 h-3.5 text-info-700" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-2xs font-bold uppercase tracking-[0.16em] text-info-700">
            TestData understanding
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5 text-2xs text-ink-600">
            <span className="rounded-pill bg-white/70 border border-info-100 px-2 py-1">
              {sheets.length || understanding.sheetCount || 0} sheet{sheets.length === 1 ? '' : 's'} analyzed
            </span>
            <span className="rounded-pill bg-white/70 border border-info-100 px-2 py-1">
              {highConfidence} high-confidence
            </span>
            <span className="rounded-pill bg-white/70 border border-info-100 px-2 py-1">
              {roleCount} mapped roles
            </span>
            <span className="rounded-pill bg-white/70 border border-info-100 px-2 py-1">
              {reviewColumns} review columns
            </span>
          </div>
          {modules.length > 0 && (
            <p className="mt-1.5 text-2xs text-ink-500">
              Modules: {modules.slice(0, 4).join(', ')}{modules.length > 4 ? ` +${modules.length - 4} more` : ''}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}


function TestDataPreview({ sheets }) {
  const [active, setActive] = useState(0);
  const list = Array.isArray(sheets) ? sheets : [];
  const sheet = list[Math.min(active, Math.max(0, list.length - 1))] || null;
  const headers = sheet?.headers || [];
  const rows = sheet?.rows || [];

  if (!list.length) {
    return (
      <div className="rounded-lg border border-ink-100 bg-white/65 p-4 text-xs text-ink-500">
        No preview rows available.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-ink-100 bg-white/65 overflow-hidden min-w-0">
      <div className="px-3 py-2 border-b border-ink-100 flex items-center gap-2 overflow-x-auto">
        {list.map((s, i) => (
          <button
            key={`${s.name}-${i}`}
            type="button"
            onClick={() => setActive(i)}
            className={`h-7 px-2.5 rounded-md text-2xs font-bold whitespace-nowrap transition-colors ${
              i === active ? 'bg-ink-900 text-white' : 'text-ink-500 hover:bg-ink-100'
            }`}
          >
            {s.name}
          </button>
        ))}
      </div>
      <div className="overflow-auto max-h-[260px]">
        <table className="min-w-full text-left text-xs">
          <thead className="sticky top-0 bg-ink-50/95 backdrop-blur-sm">
            <tr>
              {headers.map((h) => (
                <th key={h} className="px-3 py-2 font-bold text-ink-700 border-b border-ink-100 whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-50">
            {rows.slice(0, 5).map((row, i) => (
              <tr key={i} className="hover:bg-white/80">
                {headers.map((h) => (
                  <td key={h} className="px-3 py-2 text-ink-700 max-w-[180px] truncate" title={row[h]}>
                    {row[h] || <span className="text-ink-300">empty</span>}
                  </td>
                ))}
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={Math.max(1, headers.length)} className="px-3 py-4 text-center text-ink-400">
                  Header-only sheet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {(sheet?.totalRows || rows.length) > rows.length && (
        <div className="px-3 py-2 border-t border-ink-100 text-2xs text-ink-500">
          Showing {rows.length} preview row{rows.length === 1 ? '' : 's'} of {sheet.totalRows}.
        </div>
      )}
    </div>
  );
}

// MappingReview, ColumnSelect, AddFieldMapping removed - AI maps test data automatically at generation time.

function DiscrepanciesSummary({ discrepancies, onOpen }) {
  const critical = discrepancies.filter((d) => d.severity === 'critical').length;
  const warnings = discrepancies.filter((d) => d.severity === 'warning').length;
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.25 }}
      className="glass-soft border border-warn-200/70 bg-warn-50/40 px-4 py-3 flex items-center gap-3 flex-wrap"
    >
      <div className="h-9 w-9 rounded-xl bg-warn-100/80 inline-flex items-center justify-center shrink-0">
        <AlertTriangle className="w-4 h-4 text-warn-700" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-warn-900">
          <AnimatedNumber value={discrepancies.length} /> document discrepanc{discrepancies.length === 1 ? 'y' : 'ies'} found
        </div>
        <div className="text-xs text-ink-600 mt-0.5">
          {critical ? `${critical} critical` : 'No critical'} - {warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : 'no warnings'}
        </div>
      </div>
      <Button size="sm" variant="secondary" onClick={onOpen}>
        <FileSearch className="w-3.5 h-3.5" />
        Review
      </Button>
    </motion.section>
  );
}

function DiscrepanciesModal({ open, discrepancies, onResolve, onClose }) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 bg-ink-900/30 backdrop-blur-sm p-4 sm:p-6"
      role="presentation"
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="discrepancies-dialog-title"
        className="ml-auto flex h-full max-w-4xl flex-col overflow-hidden rounded-card border border-white/60 bg-white shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-ink-100 bg-white px-5 py-4">
          <div className="h-10 w-10 rounded-xl bg-warn-100/80 inline-flex items-center justify-center shrink-0">
            <GitCompareArrows className="w-4 h-4 text-warn-700" />
          </div>
          <div className="min-w-0">
            <h2 id="discrepancies-dialog-title" className="text-base font-semibold text-ink-900">
              Document discrepancies
            </h2>
            <p className="text-xs text-ink-500">
              Review contradictions without moving the uploaded files and queued documents.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-full text-ink-500 hover:bg-ink-100 hover:text-ink-900 focus-visible:outline-none focus-visible:shadow-ring"
            aria-label="Close discrepancy review"
          >
            <X className="w-4 h-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
          <DiscrepanciesPanel discrepancies={discrepancies} onResolve={onResolve} />
        </div>
      </section>
    </div>
  );
}

function DiscrepanciesPanel({ discrepancies, onResolve }) {
  const KIND_META = {
    in_brd_not_in_release: { label: 'In BRD, not in Release', tone: 'warn' },
    in_release_not_in_brd: { label: 'In Release, not in BRD', tone: 'warn' },
    spec_mismatch:         { label: 'Spec mismatch',          tone: 'danger' },
  };
  return (
    <motion.section
      initial={{ opacity: 0, y: 10, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.985 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className="glass relative overflow-hidden"
    >
      <div className="absolute left-0 top-0 bottom-0 w-1 bg-warn-500" aria-hidden="true" />
      <div className="pl-5 pr-5 py-4 border-b border-warn-200/60 bg-warn-50/40 flex items-center gap-2 flex-wrap">
        <AlertTriangle className="w-4 h-4 text-warn-700" />
        <h2 className="text-sm font-semibold text-warn-900">
          <AnimatedNumber value={discrepancies.length} /> discrepanc{discrepancies.length === 1 ? 'y' : 'ies'} between documents
        </h2>
        <span className="ml-auto text-2xs text-ink-500 italic">
          Resolve or accept before generating
        </span>
      </div>
      <ul className="divide-y divide-ink-100/70">
        {discrepancies.map((d, i) => {
          const km = KIND_META[d.kind] || { label: d.kind, tone: 'ink' };
          const sevTone = d.severity === 'critical' ? 'danger' : d.severity === 'warning' ? 'warn' : 'info';
          return (
            <motion.li
              key={d.id}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.04 }}
              className="px-5 py-4 flex items-start gap-3 hover:bg-white/40 transition-colors"
            >
              <Info className={`w-4 h-4 mt-0.5 shrink-0 ${TONE_TEXT[sevTone]}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className={`inline-flex px-2 h-5 items-center rounded-pill text-2xs font-bold uppercase tracking-wider border ${TONE_BG[km.tone]} ${TONE_TEXT[km.tone]}`}>
                    {km.label}
                  </span>
                  <span className={`text-2xs font-bold uppercase tracking-wider ${TONE_TEXT[sevTone]}`}>{d.severity}</span>
                </div>
                <div className="text-sm font-semibold text-ink-900">{d.summary}</div>
                <p className="text-xs text-ink-600 mt-1 leading-relaxed">{d.detail}</p>
              </div>
              <button
                onClick={() => onResolve(d.id)}
                className="text-2xs text-ink-500 hover:text-success-700 inline-flex items-center gap-1 shrink-0 font-semibold"
                title="Mark resolved"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                resolve
              </button>
            </motion.li>
          );
        })}
      </ul>
    </motion.section>
  );
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// EmptyEducation — shown when no requirements yet. Helpful, not noisy.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function EmptyEducation() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2, duration: 0.45 }}
      className="glass-soft p-6 flex items-start gap-4"
    >
      <div className="w-10 h-10 rounded-xl bg-info-100/70 inline-flex items-center justify-center shrink-0">
        <FileSearch className="w-4 h-4 text-info-700" />
      </div>
      <div className="flex-1">
        <h3 className="text-sm font-semibold text-ink-900 mb-1">What works best?</h3>
        <p className="text-sm text-ink-700 leading-relaxed">
          Upload <strong>any mix</strong>: BRD, release notes, user stories, API spec. The Architect reads them together —
          the more concrete the acceptance criteria, the more concrete the generated cases.
        </p>
      </div>
    </motion.div>
  );
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// QueueHeader — section opener for the requirements queue. Tells the user
// what's about to follow + counts. Lives outside RequirementsQueue so the
// space-y rhythm reads correctly with the surrounding sections.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function QueueHeader({ requirements, reqsByCategory }) {
  const totalCount = requirements.length;
  const presentCats = CATEGORY_ORDER.filter((c) => (reqsByCategory.get(c) || []).length > 0);
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.15, duration: 0.45 }}
    >
      <div className="text-2xs uppercase tracking-[0.22em] font-bold text-ink-500 mb-2 flex items-center gap-1.5">
        <FileText className="w-3 h-3" />
        Queued for the Architect
      </div>
      <h2 className="text-3xl font-bold text-ink-900 tracking-tight">
        Documents in the brief
      </h2>
      <p className="text-sm text-ink-600 mt-1.5">
        <AnimatedNumber value={totalCount} duration={0.5} /> document{totalCount === 1 ? '' : 's'} across{' '}
        <span className="font-semibold text-ink-900">{presentCats.length}</span> categor{presentCats.length === 1 ? 'y' : 'ies'}
        {' '}— the Architect reads them all together to build scenarios.
      </p>
    </motion.div>
  );
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// RequirementsQueue — grouped glass cards, one per category. Each row has an
// inline segmented re-categorise control (cleaner than the old <select>).
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function RequirementsQueue({ reqsByCategory, onCategoryChange, onRemove }) {
  return (
    <section className="space-y-5">
      {CATEGORY_ORDER.map((cat, catIndex) => {
        const items = reqsByCategory.get(cat) || [];
        if (!items.length) return null;
        const meta = CATEGORY_META[cat];
        const Icon = meta.icon;
        return (
          <motion.div
            key={cat}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.18 + catIndex * 0.05, duration: 0.4 }}
            className="glass overflow-hidden"
          >
            <header className="px-5 py-3.5 border-b border-white/60 flex items-center gap-3 bg-white/30">
              <div className={`w-8 h-8 rounded-lg inline-flex items-center justify-center border ${TONE_BG[meta.tone]}`}>
                <Icon className={`w-4 h-4 ${TONE_TEXT[meta.tone]}`} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-ink-900 tracking-tight">{meta.label}</div>
                <div className="text-2xs text-ink-500 leading-snug">{meta.blurb}</div>
              </div>
              <span className={`text-2xs font-bold uppercase tracking-wider px-2 h-6 inline-flex items-center rounded-pill border ${TONE_BG[meta.tone]} ${TONE_TEXT[meta.tone]}`}>
                <AnimatedNumber value={items.length} duration={0.5} /> doc{items.length === 1 ? '' : 's'}
              </span>
            </header>
            <ul className="divide-y divide-white/40">
              {items.map((r, i) => (
                <RequirementRow
                  key={r.id}
                  requirement={r}
                  index={i}
                  currentCategory={cat}
                  onCategoryChange={(next) => onCategoryChange(r, next)}
                  onRemove={() => onRemove(r.id)}
                />
              ))}
            </ul>
          </motion.div>
        );
      })}
    </section>
  );
}

function RequirementRow({ requirement, index, currentCategory, onCategoryChange, onRemove }) {
  const isUpload = requirement.sourceType === 'upload';
  const [expanded, setExpanded] = useState(false);
  return (
    <motion.li
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: index * 0.03 }}
      className="px-5 py-4 hover:bg-white/40 transition-colors group"
    >
      <div className="flex items-start gap-3">
        <span className="shrink-0 text-2xs uppercase tracking-wider font-bold text-ink-600 bg-white/60 backdrop-blur-sm border border-ink-200/50 px-2 py-0.5 rounded-pill">
          {requirement.sourceType}
        </span>
        <div className="flex-1 min-w-0">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-left w-full"
          >
            <div className="text-sm font-semibold text-ink-900">
              {requirement.title || requirement.sourceIdentifier || '(untitled)'}
            </div>
            <div className={`text-xs text-ink-600 mt-1 leading-relaxed ${expanded ? '' : 'line-clamp-2'}`}>
              {requirement.content}
            </div>
            {!expanded && requirement.content && requirement.content.length > 180 && (
              <span className="text-2xs text-ink-500 italic mt-1 inline-block">click to expand</span>
            )}
          </button>
        </div>
        <button
          onClick={onRemove}
          className="opacity-0 group-hover:opacity-100 transition-opacity text-ink-400 hover:text-danger-600 hover:bg-danger-50 rounded-md p-1.5 shrink-0"
          aria-label="Remove requirement"
          title="Remove"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Segmented category control. Only for uploaded docs — pulled work
          items can't be re-categorised server-side yet. */}
      {isUpload && (
        <div className="mt-3 flex items-center gap-2 flex-wrap pl-[60px]">
          <span className="text-2xs uppercase tracking-wider font-bold text-ink-500">Category</span>
          <div className="inline-flex items-center gap-1 p-0.5 rounded-pill bg-white/60 backdrop-blur-sm border border-ink-200/50">
            {CATEGORY_ORDER.map((c) => {
              const m = CATEGORY_META[c];
              const isCurrent = c === currentCategory;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => !isCurrent && onCategoryChange(c)}
                  className={`text-2xs font-semibold px-2.5 h-6 rounded-pill transition-all ${
                    isCurrent
                      ? `${TONE_BG[m.tone]} ${TONE_TEXT[m.tone]} border ${m.tone === 'ink' ? 'border-ink-300' : ''}`
                      : 'text-ink-500 hover:text-ink-900 hover:bg-white/50'
                  }`}
                >
                  {m.short}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </motion.li>
  );
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// DiffContextCard — Phase E3. Same business logic as the old card, restyled
// to the glass language and made less form-heavy.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function DiffContextCard({ projectId, sprintId, claudeReady }) {
  const toast = useToast();
  const [latest, setLatest] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ref: '', baseBranch: '' });
  const [repo, setRepo] = useState(null);

  const load = useCallback(async () => {
    try {
      const qs = sprintId ? `?sprintId=${encodeURIComponent(sprintId)}` : '';
      const res = await api.get(`/projects/${projectId}/diff-context${qs}`);
      setLatest(Array.isArray(res.diffContexts) && res.diffContexts.length ? res.diffContexts[0] : null);
      const repoRes = await api.get(`/projects/${projectId}/repo`).catch(() => null);
      setRepo(repoRes?.project || null);
      setLoaded(true);
    } catch { setLoaded(true); }
  }, [projectId, sprintId]);

  useEffect(() => { load(); }, [load]);

  const parseRef = (raw) => {
    const s = String(raw || '').trim();
    if (!s) return null;
    const m = s.match(/\/pull\/(\d+)/) || s.match(/^#?(\d+)$/);
    if (m) return { prNumber: Number(m[1]) };
    return { branch: s };
  };

  const submit = async () => {
    const parsed = parseRef(form.ref);
    if (!parsed) { toast.error('Enter a PR URL, PR number, or branch name.'); return; }
    setFetching(true);
    try {
      const body = { ...parsed, baseBranch: form.baseBranch.trim() || undefined, sprintId: sprintId || undefined };
      const res = await api.post(`/projects/${projectId}/diff-context`, body);
      setLatest({
        id: res.diffContext.id, ref: res.diffContext.ref, baseRef: res.diffContext.baseRef,
        summary: res.diffContext.summary, fetchedAt: res.diffContext.fetchedAt, sprintId: res.diffContext.sprintId,
        changedFiles: res.diffContext.changedFiles || [], changedModules: res.diffContext.changedModules || [],
        suggestedScenarios: res.diffContext.suggestedScenarios || [],
        headRef: res.diffContext.headRef || null, title: res.diffContext.title || null,
      });
      setForm({ ref: '', baseBranch: '' });
      toast.success(`Diff analyzed — ${res.diffContext.changedFiles?.length || 0} file(s).`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Diff fetch failed' });
    } finally { setFetching(false); }
  };

  const clear = async () => {
    if (!latest?.id) return;
    try { await api.del(`/projects/${projectId}/diff-context/${latest.id}`); setLatest(null); toast.success('Diff context cleared.'); }
    catch (err) { toast.error(err.message); }
  };

  if (!loaded) return null;
  const repoConfigured = !!repo?.repoUrl;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.12, duration: 0.45 }}
      className="glass-soft p-5"
    >
      <div className="flex items-start gap-3 mb-3">
        <div className="w-10 h-10 rounded-xl bg-accent-100/70 border border-accent-200/60 inline-flex items-center justify-center shrink-0">
          <GitPullRequest className="w-4 h-4 text-accent-700" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-ink-900 tracking-tight">Code-diff context</h3>
          <p className="text-xs text-ink-600 mt-0.5 leading-relaxed">
            Point the AI at a PR or branch — the diff summary + impacted modules flow into the next Generate
            so scenarios prioritise what actually changed.
          </p>
        </div>
        {latest && (
          <button type="button" onClick={clear} className="text-2xs text-ink-500 hover:text-danger-600 font-semibold">
            Clear
          </button>
        )}
      </div>

      {!repoConfigured && (
        <div className={`rounded-xl border ${TONE_BG.warn} ${TONE_TEXT.warn} text-xs px-3 py-2 mb-3`}>
          <span className="font-semibold">Connect a repo first.</span>{' '}
          Open Project Setup → Git repository, add the repoUrl + PAT, then come back here.
        </div>
      )}

      {latest && (
        <div className="rounded-xl border border-ink-200/60 bg-white/70 backdrop-blur p-3 mb-3 space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-mono font-semibold text-ink-900">{latest.ref}</span>
            <span className="text-ink-400">vs</span>
            <span className="font-mono text-ink-700">{latest.baseRef}</span>
            <span className="ml-auto text-2xs text-ink-500">{latest.fetchedAt ? new Date(latest.fetchedAt).toLocaleString() : ''}</span>
          </div>
          {latest.title && <div className="text-xs text-ink-700 italic">"{latest.title}"</div>}
          {latest.summary && <div className="text-xs text-ink-700 leading-relaxed">{latest.summary}</div>}
          <div className="flex flex-wrap gap-1.5 pt-1">
            <span className="text-2xs bg-white/80 border border-ink-200 px-2 py-0.5 rounded-pill">
              {latest.changedFiles?.length || 0} file{(latest.changedFiles?.length || 0) === 1 ? '' : 's'}
            </span>
            {(latest.changedModules || []).map((m) => (
              <span key={m} className={`text-2xs px-2 py-0.5 rounded-pill border font-semibold ${TONE_BG.accent} ${TONE_TEXT.accent}`}>
                {m}
              </span>
            ))}
          </div>
          {Array.isArray(latest.suggestedScenarios) && latest.suggestedScenarios.length > 0 && (
            <div className="pt-2 border-t border-ink-200/60">
              <div className="text-2xs uppercase tracking-wider font-bold text-ink-500 mb-1">
                Suggested scenarios ({latest.suggestedScenarios.length})
              </div>
              <ul className="space-y-1">
                {latest.suggestedScenarios.map((s, i) => (
                  <li key={i} className="text-xs text-ink-700">
                    <span className="font-semibold">{s.name}</span>
                    <span className="text-ink-500"> — {s.module}</span>
                    {s.why && <span className="text-ink-500 italic"> · {s.why}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs font-semibold text-ink-700 hover:text-ink-900 inline-flex items-center gap-1"
        disabled={!repoConfigured}
      >
        {open ? 'Hide form' : (latest ? 'Replace diff' : 'Fetch diff')}
        <ChevronRight className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>

      <AnimatePresence>
        {open && repoConfigured && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <div className="mt-3 grid sm:grid-cols-3 gap-2">
              <div className="sm:col-span-2">
                <label className="text-2xs uppercase tracking-wider font-bold text-ink-500 block mb-1">
                  PR URL, #number, or branch
                </label>
                <input
                  type="text"
                  value={form.ref}
                  onChange={(e) => setForm((f) => ({ ...f, ref: e.target.value }))}
                  placeholder="https://github.com/org/repo/pull/42  or  feature/login-fix"
                  className="w-full text-xs rounded-xl border border-ink-200 bg-white/80 px-3 py-2 focus-visible:outline-none focus-visible:shadow-ring"
                />
              </div>
              <div>
                <label className="text-2xs uppercase tracking-wider font-bold text-ink-500 block mb-1">
                  Base
                </label>
                <input
                  type="text"
                  value={form.baseBranch}
                  onChange={(e) => setForm((f) => ({ ...f, baseBranch: e.target.value }))}
                  placeholder={repo?.defaultBranch || 'main'}
                  className="w-full text-xs rounded-xl border border-ink-200 bg-white/80 px-3 py-2 focus-visible:outline-none focus-visible:shadow-ring"
                />
              </div>
              <div className="sm:col-span-3 flex justify-end">
                <Button
                  size="sm" onClick={submit} loading={fetching}
                  disabled={fetching || !form.ref.trim() || !claudeReady}
                  title={!claudeReady ? 'Configure Claude API in Settings first' : null}
                >
                  <GitPullRequest className="w-3.5 h-3.5" />
                  Fetch and analyse
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Loading skeleton — shapes match the real layout to avoid jump on load.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function RunSuiteSkeleton() {
  return (
    <div className="space-y-7" aria-busy="true">
      <div className="glass p-9 grid lg:grid-cols-[1fr_auto] gap-8 items-center">
        <div className="space-y-4">
          <Skeleton className="h-3 w-40" rounded="pill" />
          <Skeleton className="h-16 w-72" />
          <Skeleton className="h-3 w-3/4" />
          <div className="flex gap-2">
            {[0,1,2,3,4].map((i) => <Skeleton key={i} className="h-7 w-20" rounded="pill" />)}
          </div>
        </div>
        <Skeleton className="h-28 w-56" rounded="2xl" />
      </div>
      <div className="grid md:grid-cols-3 gap-3">
        {[0,1,2].map((i) => <div key={i} className="glass-soft p-4 h-16"><Skeleton className="h-full w-full" /></div>)}
      </div>
      <Skeleton className="h-32 w-full" rounded="2xl" />
      <div className="glass p-6 space-y-3">
        <Skeleton className="h-4 w-40" />
        {[0,1,2].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-4 w-12" rounded="pill" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-1/4 ml-auto" />
          </div>
        ))}
      </div>
    </div>
  );
}
