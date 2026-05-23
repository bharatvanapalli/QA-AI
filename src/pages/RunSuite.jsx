import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Upload, GitBranch, KanbanSquare, FileText, Sparkles, X, Loader2,
  AlertTriangle, GitCompareArrows, CheckCircle2, Info, FileSearch,
  ScrollText, BookOpen, Code2, ClipboardList, StopCircle,
} from 'lucide-react';
import api, { ApiError } from '../lib/apiClient';
import { useProject } from '../store/project';
import { useToast } from '../lib/useToast';
import { useRunStream } from '../store/runStream';
import { estimateArchitectCost, formatTokens } from '../lib/costEstimate';
import Button from '../components/ui/Button';
import Skeleton from '../components/ui/Skeleton';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

// Single source of truth for category metadata — icon, label, dropzone copy.
// Mirrors the server's guessCategory() enum so the UI groups uploaded docs
// into the same buckets the server assigns. "other" is the catch-all and
// is only visible if a doc actually lands there.
const CATEGORY_META = {
  brd: {
    label: 'Business Requirements (BRD)',
    short: 'BRD',
    icon: BookOpen,
    blurb: 'The contract — what the system must do.',
    cls: 'bg-info-50 text-info-700 border-info-200',
    iconCls: 'text-info-700',
  },
  'release-notes': {
    label: 'Release Notes',
    short: 'Release',
    icon: ScrollText,
    blurb: "What's shipping in this release — drives Smart-select.",
    cls: 'bg-warn-50 text-warn-700 border-warn-200',
    iconCls: 'text-warn-700',
  },
  'user-stories': {
    label: 'User Stories',
    short: 'Stories',
    icon: ClipboardList,
    blurb: 'As-a / I-want / So-that. Best signal for acceptance criteria.',
    cls: 'bg-accent-50 text-accent-700 border-accent-200',
    iconCls: 'text-accent-700',
  },
  'api-spec': {
    label: 'API Spec',
    short: 'API',
    icon: Code2,
    blurb: 'OpenAPI / Swagger / endpoint contracts.',
    cls: 'bg-success-50 text-success-700 border-success-200',
    iconCls: 'text-success-700',
  },
  other: {
    label: 'Other',
    short: 'Other',
    icon: FileText,
    blurb: 'Mockup notes, design docs, anything else.',
    cls: 'bg-ink-100 text-ink-700 border-ink-200',
    iconCls: 'text-ink-500',
  },
};

const CATEGORY_ORDER = ['brd', 'release-notes', 'user-stories', 'api-spec', 'other'];

export default function RunSuite() {
  const navigate = useNavigate();
  const toast = useToast();
  const { current } = useProject();
  const { subscribe } = useRunStream();
  const [requirements, setRequirements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [pulling, setPulling] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [integrations, setIntegrations] = useState({ claude: null, ado: null, jira: null });
  const [discrepancies, setDiscrepancies] = useState([]);
  const [detecting, setDetecting] = useState(false);

  // Inline streaming Architect log — replaces the floating widget for the
  // page that owns this action. Last 8 lines kept in memory; older ones
  // scroll off. Mirrors the same WS events the global indicator listens to
  // (the indicator hides itself on this route, see AgentRunningIndicator).
  const [phaseLog, setPhaseLog] = useState([]);     // [{ level, message, at }]
  const [phaseStatus, setPhaseStatus] = useState('idle');  // idle | running | complete | error | cancelled
  const [phaseStartedAt, setPhaseStartedAt] = useState(0);
  const [phaseElapsed, setPhaseElapsed] = useState(0);
  const startedAtRef = useRef(0);

  const load = useCallback(async () => {
    if (!current) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [reqs, claude, ado, jira, disc] = await Promise.all([
        api.get(`/projects/${current.id}/requirements`),
        api.get('/settings/claude').catch(() => null),
        api.get('/settings/ado').catch(() => null),
        api.get('/settings/jira').catch(() => null),
        api.get(`/projects/${current.id}/discrepancies`).catch(() => ({ discrepancies: [] })),
      ]);
      setRequirements(reqs.requirements || []);
      setIntegrations({ claude, ado, jira });
      setDiscrepancies(disc?.discrepancies || []);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [current, toast]);

  useEffect(() => { load(); }, [load]);

  // Inline Architect WS subscription. Scoped to the active project so a
  // background run in project B doesn't bleed into this page's view.
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
          return next.length > 8 ? next.slice(-8) : next;
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
      }
    });
    return unsub;
  }, [subscribe, current?.id]);

  // Reset banner on project switch.
  useEffect(() => {
    setPhaseStatus('idle'); setPhaseLog([]); setPhaseStartedAt(0); startedAtRef.current = 0;
  }, [current?.id]);

  // Elapsed timer while running.
  useEffect(() => {
    if (phaseStatus !== 'running') return;
    const id = setInterval(() => setPhaseElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000)), 500);
    return () => clearInterval(id);
  }, [phaseStatus]);

  const handleDetectDiscrepancies = useCallback(async () => {
    if (!current) return;
    setDetecting(true);
    try {
      const res = await api.post(`/projects/${current.id}/analyst/detect-discrepancies`, {});
      setDiscrepancies(res.discrepancies || []);
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

  const resolveDiscrepancy = useCallback(
    async (id) => {
      try {
        await api.post(`/projects/${current.id}/discrepancies/${id}/resolve`, {});
        setDiscrepancies((d) => d.filter((x) => x.id !== id));
      } catch (err) {
        toast.error(err.message);
      }
    },
    [current, toast]
  );

  const handleFiles = useCallback(
    async (files) => {
      if (!current || !files?.length) return;
      setUploading(true);
      try {
        const docs = await Promise.all(
          [...files].map(async (file) => {
            if (file.size > MAX_FILE_BYTES) {
              throw new Error(`${file.name} exceeds 5 MB limit.`);
            }
            const content = await new Promise((resolve, reject) => {
              const r = new FileReader();
              r.onload = () => resolve(r.result);
              r.onerror = reject;
              if (/\.(pdf|docx)$/i.test(file.name)) r.readAsDataURL(file);
              else r.readAsText(file);
            });
            return {
              name: file.name,
              mimeType: file.type || 'application/octet-stream',
              sizeBytes: file.size,
              content,
            };
          })
        );
        const res = await api.post(`/projects/${current.id}/requirements/upload`, { documents: docs });
        const cats = [...new Set((res.created || []).map((c) => CATEGORY_META[c.category]?.short || 'Other'))];
        toast.success(
          `${(res.created || []).length} doc(s) indexed${cats.length ? ` · ${cats.join(', ')}` : ''}.`,
          { title: 'Upload complete' }
        );
        if (Array.isArray(res.warnings) && res.warnings.length) {
          res.warnings.slice(0, 3).forEach((w) => toast.error(w, { title: 'Document warning' }));
        }
        await load();
      } catch (err) {
        const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
        toast.error(msg, { title: 'Upload failed' });
      } finally {
        setUploading(false);
      }
    },
    [current, toast, load]
  );

  const handlePull = useCallback(
    async (source) => {
      if (!current) return;
      setPulling(source);
      try {
        const res = await api.post(`/projects/${current.id}/requirements/pull/${source}`, {});
        toast.success(res.message);
        await load();
      } catch (err) {
        const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
        toast.error(msg, { title: `${source.toUpperCase()} pull failed` });
      } finally {
        setPulling(null);
      }
    },
    [current, toast, load]
  );

  const handleGenerate = useCallback(async () => {
    if (!current) return;
    setGenerating(true);
    try {
      // The inline banner (driven by WS phase events) shows live progress.
      // No toast.info noise — the page itself owns the state for this action.
      const res = await api.post(`/projects/${current.id}/scenarios/generate`, { replace: true });
      toast.success(
        `${res.stats.scenarios} scenarios · ${res.stats.cases} test cases. Review them on the next screen.`,
        { title: 'Architect finished' }
      );
      navigate('/test-cases?just=generated');
    } catch (err) {
      const cancelled = err instanceof ApiError && err.payload?.code === 'CANCELLED';
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      if (!cancelled) toast.error(msg, { title: 'Generation failed' });
    } finally {
      setGenerating(false);
    }
  }, [current, toast, navigate]);

  const handleTerminate = useCallback(async () => {
    if (!current || phaseStatus !== 'running') return;
    try {
      await api.post(`/projects/${current.id}/agents/cancel`, {});
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Could not cancel' });
    }
  }, [current, phaseStatus, toast]);

  const updateRequirementCategory = useCallback(
    async (req, nextCategory) => {
      if (!current) return;
      const sourceIdentifier = req.sourceIdentifier;
      // Optimistic — flip the requirement's category locally so the UI
      // re-buckets immediately. Server PUT mirrors it onto Document and
      // any other Requirement rows that point at the same doc.
      setRequirements((all) => all.map((r) => (r.id === req.id ? { ...r, category: nextCategory } : r)));
      try {
        if (req.sourceType === 'upload' && sourceIdentifier) {
          await api.put(`/projects/${current.id}/documents/${sourceIdentifier}/category`, { category: nextCategory });
        } else {
          // ADO/Jira items: there's no Document row to mirror onto, so just
          // patch the Requirement directly. This endpoint doesn't exist yet
          // for non-upload sources — surface the limitation explicitly.
          throw new ApiError(400, { message: 'Re-categorising pulled work items isn\'t supported yet.' });
        }
        toast.success(`Marked as ${CATEGORY_META[nextCategory]?.short || nextCategory}.`);
      } catch (err) {
        const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
        toast.error(msg, { title: 'Could not re-categorise' });
        // Roll back the optimistic update.
        await load();
      }
    },
    [current, toast, load]
  );

  const removeReq = async (id) => {
    if (!current) return;
    try {
      await api.del(`/projects/${current.id}/requirements/${id}`);
      setRequirements((r) => r.filter((x) => x.id !== id));
    } catch (err) {
      toast.error(err.message);
    }
  };

  // Group requirements by category in a stable order so the buckets don't
  // shuffle as items are uploaded / re-categorised.
  const reqsByCategory = useMemo(() => {
    const map = new Map();
    for (const key of CATEGORY_ORDER) map.set(key, []);
    for (const r of requirements) {
      const cat = CATEGORY_META[r.category] ? r.category : 'other';
      map.get(cat).push(r);
    }
    return map;
  }, [requirements]);

  // Pre-flight cost estimate from current requirement text. Recomputes
  // whenever the user adds / removes / re-categorises something.
  const costEstimate = useMemo(
    () => estimateArchitectCost(requirements.map((r) => r.content || '')),
    [requirements]
  );

  if (!current) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Run Suite" />
        <main className="flex-1 bg-ink-50">
          <EmptyState
            icon={FileText}
            title="No project selected"
            message="Create or activate a project first."
          />
        </main>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <PageHeader title="Run Suite" subtitle={current.name} />
        <main className="flex-1 overflow-y-auto bg-ink-50">
          <div className="max-w-5xl mx-auto px-page py-8 space-y-6" aria-busy="true">
            <section className="grid md:grid-cols-3 gap-4">
              {[0, 1, 2].map((i) => (
                <div key={i} className="rounded-card border border-ink-200 bg-white p-5 space-y-3">
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-8 w-8" rounded="lg" />
                    <Skeleton className="h-4 w-24" />
                  </div>
                  <Skeleton className="h-3 w-3/4" />
                  <Skeleton className="h-9 w-32" rounded="md" />
                </div>
              ))}
            </section>
            <section className="rounded-card border border-ink-200 bg-white p-6 space-y-4">
              <Skeleton className="h-5 w-44" />
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-4 w-4" rounded="full" />
                  <Skeleton className="h-3 w-1/3" />
                  <Skeleton className="h-3 w-1/5 ml-auto" />
                </div>
              ))}
            </section>
          </div>
        </main>
      </div>
    );
  }

  const claudeReady = integrations.claude?.configured && integrations.claude?.status === 'valid';
  const adoReady = integrations.ado?.configured && integrations.ado?.status === 'valid';
  const jiraReady = integrations.jira?.configured && integrations.jira?.status === 'valid';

  const hasBrd = (reqsByCategory.get('brd') || []).length > 0;
  const hasAnyReq = requirements.length > 0;
  const canGenerate = claudeReady && hasAnyReq && !generating && phaseStatus !== 'running';

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader title="Run Suite" subtitle={current.name}>
        <Button
          size="sm"
          variant="secondary"
          onClick={handleDetectDiscrepancies}
          loading={detecting}
          disabled={detecting || requirements.length < 2 || !claudeReady}
        >
          <GitCompareArrows className="w-3.5 h-3.5" />
          Detect discrepancies
        </Button>
        <Button
          size="md"
          onClick={handleGenerate}
          disabled={!canGenerate}
          loading={generating}
          title={
            !claudeReady ? 'Configure Claude API in Settings first'
            : !hasAnyReq ? 'Upload at least one requirement document'
            : phaseStatus === 'running' ? 'Architect is already running'
            : `Generate scenarios from ${requirements.length} requirement${requirements.length === 1 ? '' : 's'}`
          }
        >
          <Sparkles className="w-3.5 h-3.5" />
          Generate scenarios
        </Button>
      </PageHeader>

      <main className="flex-1 overflow-y-auto bg-ink-50">
        <div className="max-w-5xl mx-auto px-page py-8 space-y-6">
          {/* Inline Architect streaming view. Owns the live phase state for
              this page — the global floating indicator hides itself on this
              route (see AgentRunningIndicator). */}
          {(phaseStatus === 'running' || phaseStatus === 'complete' || phaseStatus === 'error' || phaseStatus === 'cancelled') && (
            <ArchitectBanner
              status={phaseStatus}
              log={phaseLog}
              elapsed={phaseElapsed}
              onTerminate={handleTerminate}
              onDismiss={() => { setPhaseStatus('idle'); setPhaseLog([]); }}
            />
          )}

          {/* Cost preview — visible whenever there are requirements to send.
              Shows token estimate + USD cost + duration so a click on
              Generate isn't a leap of faith. */}
          {hasAnyReq && phaseStatus !== 'running' && (
            <CostPreviewCard estimate={costEstimate} canGenerate={canGenerate} reason={
              !claudeReady ? 'Configure Claude API in Settings → Claude before generating.'
              : !hasBrd ? 'No BRD-category doc detected — Architect will use what is available, but a BRD gives the best result.'
              : null
            } />
          )}

          {/* Source ingestion strip — ADO / Jira / Upload */}
          <section className="grid md:grid-cols-3 gap-4">
            <SourceCard
              icon={GitBranch}
              title="Azure DevOps"
              configured={adoReady}
              detail={adoReady ? `Connected to ${integrations.ado.projectName || 'project'}` : 'Not configured'}
              action={
                adoReady ? (
                  <Button size="sm" variant="secondary" loading={pulling === 'ado'} onClick={() => handlePull('ado')}>
                    Pull work items
                  </Button>
                ) : (
                  <a className="text-xs underline text-ink-500" href="/settings/ado">Configure →</a>
                )
              }
            />
            <SourceCard
              icon={KanbanSquare}
              title="Jira"
              configured={jiraReady}
              detail={jiraReady ? `Connected to ${integrations.jira.projectKey || 'project'}` : 'Not configured'}
              action={
                jiraReady ? (
                  <Button size="sm" variant="secondary" loading={pulling === 'jira'} onClick={() => handlePull('jira')}>
                    Pull issues
                  </Button>
                ) : (
                  <a className="text-xs underline text-ink-500" href="/settings/jira">Configure →</a>
                )
              }
            />
            <SourceCard
              icon={Upload}
              title="Upload documents"
              configured
              detail="BRD, user stories, release notes, API spec, or anything else. Auto-categorised — re-tag inline if it's wrong."
              action={
                <label className="text-xs underline text-ink-700 cursor-pointer">
                  <input
                    type="file"
                    multiple
                    accept=".txt,.md,.html,.json,.pdf,.docx"
                    className="hidden"
                    onChange={(e) => handleFiles(e.target.files)}
                  />
                  {uploading ? (
                    <span className="inline-flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Uploading…
                    </span>
                  ) : 'Choose files'}
                </label>
              }
            />
          </section>

          {/* Drop zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              handleFiles(e.dataTransfer.files);
            }}
            className={`rounded-card border-2 border-dashed py-10 px-6 text-center transition-all duration-200 ease-out-soft ${
              dragging
                ? 'border-ink-900 bg-ink-100 scale-[1.01]'
                : 'border-ink-300 bg-white hover:border-ink-400 hover:bg-ink-50'
            }`}
          >
            <Upload className="w-6 h-6 mx-auto text-ink-400 mb-2" />
            <p className="text-sm font-medium text-ink-700">Drag &amp; drop documents here</p>
            <p className="text-xs text-ink-500 mt-1">PDF, DOCX, MD, JSON, HTML, TXT — up to 5 MB each</p>
          </div>

          {/* Discrepancies panel */}
          {discrepancies.length > 0 && (
            <section className="rounded-card border border-warn-200 bg-white shadow-card overflow-hidden">
              <div className="px-5 py-3 bg-warn-50 border-b border-warn-100 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-warn-700" />
                <h2 className="text-sm font-semibold text-warn-900">
                  {discrepancies.length} discrepancy/-ies between documents
                </h2>
                <span className="ml-auto text-2xs text-ink-500">Resolve or accept before generating scenarios</span>
              </div>
              <ul className="divide-y divide-ink-100">
                {discrepancies.map((d) => {
                  const KIND_META = {
                    in_brd_not_in_release: { label: 'In BRD, not in Release', cls: 'bg-warn-50 text-warn-700' },
                    in_release_not_in_brd: { label: 'In Release, not in BRD', cls: 'bg-warn-50 text-warn-700' },
                    spec_mismatch:         { label: 'Spec mismatch',          cls: 'bg-danger-50 text-danger-700' },
                  };
                  const kindMeta = KIND_META[d.kind] || { label: d.kind, cls: 'bg-ink-100 text-ink-700' };
                  const sevColor = d.severity === 'critical' ? 'text-danger-700' : d.severity === 'warning' ? 'text-warn-700' : 'text-info-700';
                  return (
                    <li key={d.id} className="px-5 py-4 flex items-start gap-3 hover:bg-ink-50/40">
                      <Info className={`w-4 h-4 mt-0.5 shrink-0 ${sevColor}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className={`inline-flex px-1.5 py-0.5 rounded text-2xs font-bold uppercase tracking-wider ${kindMeta.cls}`}>
                            {kindMeta.label}
                          </span>
                          <span className={`text-2xs font-bold uppercase tracking-wider ${sevColor}`}>{d.severity}</span>
                        </div>
                        <div className="text-sm font-semibold text-ink-900">{d.summary}</div>
                        <p className="text-xs text-ink-600 mt-1 leading-relaxed">{d.detail}</p>
                      </div>
                      <button
                        onClick={() => resolveDiscrepancy(d.id)}
                        className="text-2xs text-ink-500 hover:text-ink-900 inline-flex items-center gap-1 shrink-0"
                        title="Mark resolved"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        resolve
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* What to upload — onboarding hint (only when empty). */}
          {!hasAnyReq && (
            <div className="rounded-card border border-info-200 bg-info-50/60 p-5">
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-info-100 flex items-center justify-center shrink-0">
                  <FileSearch className="w-4 h-4 text-info-700" />
                </div>
                <div className="flex-1 min-w-0 text-sm text-ink-700 leading-relaxed">
                  <div className="font-semibold text-ink-900 mb-1.5">What works best?</div>
                  <p className="text-ink-600">
                    Upload <strong>any mix</strong>: BRD, release notes, user stories, API spec. The Architect agent reads
                    them together. The more concrete acceptance criteria you include, the more concrete the generated cases.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Requirements grouped by category — each bucket shows its own header,
              count, and a category dropdown on every item so re-tagging is one click. */}
          {hasAnyReq && (
            <section className="space-y-5">
              {CATEGORY_ORDER.map((cat) => {
                const items = reqsByCategory.get(cat) || [];
                if (!items.length) return null;
                const meta = CATEGORY_META[cat];
                const Icon = meta.icon;
                return (
                  <div key={cat} className="rounded-card border border-ink-200 bg-white shadow-card overflow-hidden">
                    <header className="px-5 py-3 border-b border-ink-100 flex items-center gap-2.5">
                      <div className={`w-7 h-7 rounded-md inline-flex items-center justify-center ${meta.cls}`}>
                        <Icon className="w-3.5 h-3.5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-ink-900 tracking-tight">{meta.label}</div>
                        <div className="text-2xs text-ink-500 leading-snug">{meta.blurb}</div>
                      </div>
                      <span className="text-2xs font-mono tabular-nums text-ink-500">{items.length}</span>
                    </header>
                    <ul className="divide-y divide-ink-100">
                      {items.map((r) => (
                        <RequirementRow
                          key={r.id}
                          requirement={r}
                          onCategoryChange={(next) => updateRequirementCategory(r, next)}
                          onRemove={() => removeReq(r.id)}
                        />
                      ))}
                    </ul>
                  </div>
                );
              })}
            </section>
          )}
        </div>
      </main>
    </div>
  );
}

/**
 * Inline streaming banner for the Architect phase. Sits at the top of the
 * page once Generate is clicked, shows the last log line + elapsed time +
 * a real Terminate button.
 */
function ArchitectBanner({ status, log, elapsed, onTerminate, onDismiss }) {
  const lastLine = log.length ? log[log.length - 1].message : '';
  const visual = {
    running:   { border: 'border-info-200',    accent: 'bg-info-500',    title: 'Architect — generating scenarios' },
    complete:  { border: 'border-success-200', accent: 'bg-success-500', title: 'Architect finished' },
    cancelled: { border: 'border-ink-200',     accent: 'bg-ink-400',     title: 'Architect cancelled' },
    error:     { border: 'border-danger-200',  accent: 'bg-danger-500',  title: 'Architect failed' },
  }[status] || { border: 'border-ink-200', accent: 'bg-ink-400', title: 'Architect' };
  return (
    <div className={`relative overflow-hidden rounded-card border bg-white shadow-card ${visual.border}`} role="status" aria-live="polite">
      <div className={`absolute left-0 top-0 bottom-0 w-1 ${visual.accent}`} aria-hidden="true" />
      <div className="pl-5 pr-4 py-4 flex items-start gap-3">
        <div className="mt-0.5 shrink-0">
          {status === 'running'
            ? <Loader2 className="w-4 h-4 animate-spin text-info-600" />
            : status === 'complete'
            ? <CheckCircle2 className="w-4 h-4 text-success-600" />
            : status === 'cancelled'
            ? <StopCircle className="w-4 h-4 text-ink-500" />
            : <AlertTriangle className="w-4 h-4 text-danger-600" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Sparkles className="w-3.5 h-3.5 text-ink-500" aria-hidden="true" />
            <span className="text-sm font-semibold text-ink-900 tracking-tight">{visual.title}</span>
            {status === 'running' && (
              <span className="ml-auto text-2xs font-mono tabular-nums text-ink-500">{elapsed}s</span>
            )}
          </div>
          {status === 'running' && lastLine && (
            <p className="text-xs text-ink-600 mt-1 leading-relaxed line-clamp-2">{lastLine}</p>
          )}
          {status === 'cancelled' && (
            <p className="text-xs text-ink-600 mt-1 leading-relaxed">Stopped after {elapsed}s. Nothing was persisted.</p>
          )}
          {status === 'error' && lastLine && (
            <p className="text-xs text-danger-700 mt-1 leading-relaxed line-clamp-2">{lastLine}</p>
          )}
          {/* Mini log tail — last 8 lines, mono, scrollable */}
          {status === 'running' && log.length > 1 && (
            <div className="mt-2.5 rounded-md bg-ink-900 text-ink-100 text-2xs font-mono leading-relaxed p-2.5 max-h-32 overflow-y-auto">
              {log.map((l, i) => (
                <div key={i} className={l.level === 'error' ? 'text-danger-300' : l.level === 'warn' ? 'text-warn-300' : 'text-ink-200'}>
                  {l.message}
                </div>
              ))}
            </div>
          )}
        </div>
        {status === 'running' && (
          <button
            onClick={onTerminate}
            className="shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-semibold text-danger-700 bg-white border border-danger-200 hover:bg-danger-50 transition-colors focus-visible:outline-none focus-visible:shadow-ring"
            title="Stop the Architect. The in-flight Claude request is aborted."
          >
            <StopCircle className="w-3.5 h-3.5" />
            Terminate
          </button>
        )}
        {(status === 'complete' || status === 'cancelled' || status === 'error') && (
          <button
            onClick={onDismiss}
            className="shrink-0 text-ink-400 hover:text-ink-700 transition-colors"
            aria-label="Dismiss"
            title="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Inline cost-preview card shown before Generate is clicked. Token estimate
 * from `estimateArchitectCost(...)`, plus a reason hint if Claude isn't
 * configured or no BRD has been uploaded.
 */
function CostPreviewCard({ estimate, canGenerate, reason }) {
  const { inputTokens, outputTokensMax, costDisplay, secondsEstimate } = estimate;
  return (
    <div className={`rounded-card border bg-white shadow-card p-4 flex items-center gap-4 ${canGenerate ? 'border-ink-200' : 'border-warn-200'}`}>
      <div className="w-10 h-10 rounded-lg bg-info-50 inline-flex items-center justify-center shrink-0">
        <Sparkles className="w-4 h-4 text-info-700" aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold text-ink-700 mb-1.5 uppercase tracking-[0.14em]">Pre-flight</div>
        <div className="flex items-center gap-4 flex-wrap text-sm">
          <span className="text-ink-900">
            <span className="font-semibold tabular-nums">{formatTokens(inputTokens)}</span>
            <span className="text-ink-500"> input</span>
          </span>
          <span className="text-ink-300">·</span>
          <span className="text-ink-900">
            <span className="font-semibold tabular-nums">≤ {formatTokens(outputTokensMax)}</span>
            <span className="text-ink-500"> output</span>
          </span>
          <span className="text-ink-300">·</span>
          <span className="text-ink-900">
            <span className="font-semibold tabular-nums">{costDisplay}</span>
            <span className="text-ink-500"> Claude cost</span>
          </span>
          <span className="text-ink-300">·</span>
          <span className="text-ink-900">
            <span className="font-semibold tabular-nums">~{secondsEstimate}s</span>
            <span className="text-ink-500"> duration</span>
          </span>
        </div>
        {reason && (
          <p className="text-2xs text-warn-700 mt-1.5">{reason}</p>
        )}
      </div>
    </div>
  );
}

/**
 * One row per requirement. Shows source (upload / ADO / Jira), title,
 * snippet, AND an inline category dropdown so the user can re-tag without
 * leaving the page. The dropdown is hidden for pulled work items (ADO/Jira)
 * because re-categorising them isn't supported server-side.
 */
function RequirementRow({ requirement, onCategoryChange, onRemove }) {
  const isUpload = requirement.sourceType === 'upload';
  return (
    <li className="px-5 py-4 flex items-start gap-3 hover:bg-ink-50/40">
      <span className="shrink-0 text-2xs uppercase tracking-wider font-bold text-ink-600 bg-ink-100 px-2 py-0.5 rounded">
        {requirement.sourceType}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-ink-900 truncate">
          {requirement.title || requirement.sourceIdentifier || '(untitled)'}
        </div>
        <div className="text-xs text-ink-500 line-clamp-2 mt-0.5 leading-relaxed">{requirement.content}</div>
      </div>
      {isUpload && (
        <label className="shrink-0 text-2xs flex items-center gap-1.5">
          <span className="text-ink-500 uppercase tracking-wider font-semibold">Category</span>
          <select
            value={CATEGORY_META[requirement.category] ? requirement.category : 'other'}
            onChange={(e) => onCategoryChange(e.target.value)}
            className="text-xs border border-ink-200 rounded-md px-2 py-1 bg-white text-ink-800 hover:border-ink-400 focus:border-ink-900 focus:outline-none focus-visible:shadow-ring"
            aria-label="Document category"
          >
            {CATEGORY_ORDER.map((k) => (
              <option key={k} value={k}>{CATEGORY_META[k].short}</option>
            ))}
          </select>
        </label>
      )}
      <button
        onClick={onRemove}
        className="text-ink-400 hover:text-danger-600 hover:bg-danger-50 rounded-md p-1.5 shrink-0 transition-colors focus-visible:outline-none focus-visible:shadow-ring"
        aria-label="Remove requirement"
        title="Remove"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </li>
  );
}

function SourceCard({ icon: Icon, title, detail, configured, action }) {
  return (
    <div className="rounded-card border border-ink-200 bg-white shadow-card hover:shadow-card-hover transition-shadow duration-200 ease-out-soft p-5 flex flex-col">
      <div className="flex items-center gap-2.5 mb-2">
        <div className="w-8 h-8 rounded-lg bg-ink-100 inline-flex items-center justify-center">
          <Icon className="w-4 h-4 text-ink-600" />
        </div>
        <h3 className="text-sm font-semibold text-ink-900 tracking-tight">{title}</h3>
        <span
          className={`ml-auto w-2 h-2 rounded-full ${
            configured ? 'bg-success-500 shadow-[0_0_0_3px_rgba(16,185,129,0.15)]' : 'bg-warn-500'
          }`}
        />
      </div>
      <p className="text-xs text-ink-500 mb-4 flex-1 leading-relaxed">{detail}</p>
      <div>{action}</div>
    </div>
  );
}
