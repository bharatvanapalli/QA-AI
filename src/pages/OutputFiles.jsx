import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  Folder, FolderOpen, FileCode, FileText, FileJson, Settings as SettingsIcon,
  Copy, Check, Download, ChevronRight, FileCog,
  BookOpen, Loader2, RefreshCw, Layers, FlaskConical,
  Wand2, FileTerminal, ExternalLink, X, FolderDown, ShieldCheck, ShieldAlert, Shield,
  Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen,
  PlayCircle,
} from 'lucide-react';
import api from '../lib/apiClient';
import { useProject } from '../store/project';
import { useToast } from '../lib/useToast';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import OutputFilesAssistant from '../components/OutputFilesAssistant';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import {
  isFsAccessSupported, getSavedDirHandle, rememberDirHandle,
  verifyPermission, pickDirectory, writeFilesToDir,
} from '../lib/fsAccess';
import { tokenizeTs, TOKEN_CLASSES } from '../lib/highlightTs';
import { useRunStream } from '../store/runStream';

const OUTPUT_SOURCE = 'replayir';
const OUTPUT_FRAMEWORK = 'playwright-reference';

const FRAMEWORK_META = {
  'playwright-pom': {
    adapter: 'playwright-pom',
    label: 'Playwright POM',
    language: 'TypeScript',
    packageLabel: 'Playwright Test project',
    runCommand: 'npx playwright test',
    layout: ['locators/', 'pages/', 'tests/'],
  },
  'playwright-js': {
    adapter: 'playwright-pom-js',
    label: 'Playwright POM',
    language: 'JavaScript',
    packageLabel: 'Playwright Test project',
    runCommand: 'npx playwright test',
    layout: ['locators/', 'pages/', 'tests/'],
  },
  'playwright-flat': {
    adapter: 'playwright-reference',
    label: 'Playwright Reference',
    language: 'TypeScript',
    packageLabel: 'Playwright Test project',
    runCommand: 'npx playwright test',
    layout: ['tests/', 'support/'],
  },
  'playwright-bdd': {
    adapter: 'replayir-bdd',
    label: 'Playwright BDD',
    language: 'TypeScript + Gherkin',
    packageLabel: 'Playwright BDD project',
    runCommand: 'npx bddgen && npx playwright test',
    layout: ['features/', 'steps/', 'support/'],
  },
  'cucumber-playwright': {
    adapter: 'replayir-bdd',
    label: 'Playwright BDD',
    language: 'TypeScript + Gherkin',
    packageLabel: 'Playwright BDD project',
    runCommand: 'npx bddgen && npx playwright test',
    layout: ['features/', 'steps/', 'support/'],
  },
  'selenium-java': {
    adapter: 'selenium-pom',
    label: 'Selenium POM',
    language: 'Java + TestNG',
    packageLabel: 'Maven TestNG project',
    runCommand: 'mvn test',
    layout: ['src/main/java/.../pages', 'src/main/java/.../locators', 'src/test/java/.../tests'],
  },
  'selenium-bdd': {
    adapter: 'selenium-bdd-reference',
    label: 'Selenium BDD',
    language: 'Java + Cucumber-JVM',
    packageLabel: 'Maven Cucumber-TestNG project',
    runCommand: 'mvn test',
    layout: ['src/test/resources/features', 'src/test/java/.../steps', 'src/main/java/.../bdd'],
  },
};

const ADAPTER_META = Object.fromEntries(Object.values(FRAMEWORK_META).map((m) => [m.adapter, m]));

function resolveFramework(project) {
  const f = project && project.framework;
  // playwright-pom → POM adapter (separate locators/ + pages/ + tests/ tree)
  if (f === 'playwright-pom') return 'playwright-pom';
  if (f === 'playwright-js') return 'playwright-pom-js';
  if (f === 'playwright-bdd') return 'replayir-bdd';
  if (f === 'selenium-java') return 'selenium-pom';
  if (f === 'selenium-bdd') return 'selenium-bdd-reference';
  return 'playwright-reference';
}

function resolveBundleFramework(activeFramework) {
  return activeFramework === 'playwright-pom-js' ? 'playwright-pom-dual' : activeFramework;
}

function frameworkMetaFor(project, adapterOverride) {
  const adapter = adapterOverride || resolveFramework(project);
  return (project && FRAMEWORK_META[project.framework]) || ADAPTER_META[adapter] || {
    adapter,
    label: 'ReplayIR Export',
    language: 'Generated code',
    packageLabel: 'Runnable test project',
    runCommand: 'See README.md',
    layout: ['tests/', 'support/'],
  };
}

function outputQuery(runId, framework, extra = {}) {
  const params = new URLSearchParams({
    source: OUTPUT_SOURCE,
    framework: framework || 'playwright-reference',
    ...extra,
  });
  if (runId) params.set('runId', runId);
  return `?${params.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// AuroraBackground — same drifting-orb canvas used across the app. Sits
// behind the workspace explorer so the page reads as part of the QAAI design
// system rather than a bare file browser.
// ─────────────────────────────────────────────────────────────────────────────
function AuroraBackground() {
  return (
    <div className="aurora-canvas grain-overlay" aria-hidden="true">
      <div className="aurora-orb aurora-orb-info    aurora-drift-1"
           style={{ width: '52vw', height: '52vw', top: '-10vw', left: '-6vw', opacity: 0.42 }} />
      <div className="aurora-orb aurora-orb-accent  aurora-drift-2"
           style={{ width: '46vw', height: '46vw', top: '-4vw', right: '-8vw', opacity: 0.4 }} />
      <div className="aurora-orb aurora-orb-success aurora-drift-3"
           style={{ width: '42vw', height: '42vw', bottom: '-12vw', left: '20vw', opacity: 0.36 }} />
      <div className="aurora-orb aurora-orb-warn    aurora-drift-1"
           style={{ width: '34vw', height: '34vw', bottom: '-10vw', right: '8vw', opacity: 0.28 }} />
    </div>
  );
}

// File-kind → icon + tone. Picked so the tree reads at a glance like an IDE.
const KIND_META = {
  spec:    { icon: FlaskConical,  cls: 'text-success-600' },
  page:    { icon: Layers,        cls: 'text-accent-600' },
  locator: { icon: Layers,        cls: 'text-info-600' },
  data:    { icon: FileJson,      cls: 'text-warn-600' },
  evidence:{ icon: ShieldCheck,   cls: 'text-success-600' },
  fixture: { icon: Wand2,         cls: 'text-warn-600' },
  util:    { icon: FileTerminal,  cls: 'text-info-600' },
  config:  { icon: FileCog,       cls: 'text-ink-500' },
  env:     { icon: SettingsIcon,  cls: 'text-ink-500' },
  doc:     { icon: BookOpen,      cls: 'text-ink-500' },
  misc:    { icon: FileText,      cls: 'text-ink-500' },
};
function kindMeta(kind) { return KIND_META[kind] || KIND_META.misc; }

// Analyse generated TypeScript for locator strategy distribution.
// Returns { level: 'solid'|'ok'|'fragile', label, score, detail } or null.
// solid  ≥75 — mostly getByRole / stable selectors; high replay confidence.
// ok     50–74 — mixed; some CSS or text selectors present.
// fragile <50 — CSS-heavy, codegen warning present, or no detectable locators.
function scriptHealth(content, kind) {
  if (!content || !['spec', 'page'].includes(kind)) return null;
  if (content.includes('// QAAI CODEGEN WARNING:')) {
    return { level: 'fragile', label: 'Codegen warning', score: 0, detail: 'File may be incomplete — see the warning comment at the top.' };
  }
  // replayir flat adapter uses resolveLocator() with a multi-strategy candidate array
  // instead of raw getByRole/getByLabel. Count these as fully stable — the runtime probe
  // handles role/label/testid/css fallback internally so every call is high-confidence.
  const resolveCount = (content.match(/resolveLocator\s*\(/g) || []).length;
  if (resolveCount > 0) {
    return { level: 'solid', label: 'High confidence', score: 95, detail: `${resolveCount} resolveLocator (multi-strategy runtime probe)` };
  }
  const pomRegistryCount = (
    content.match(/\b[A-Za-z_$][\w$]*Locators(?:\.[A-Za-z_$][\w$]*|\[\s*['"`][^'"`]+['"`]\s*\])\s*\(/g) || []
  ).length;
  if (kind === 'page' && pomRegistryCount > 0) {
    return {
      level: 'solid',
      label: 'POM linked',
      score: 95,
      detail: `${pomRegistryCount} generated locator registry call${pomRegistryCount === 1 ? '' : 's'}; raw locators live under locators/.`,
    };
  }
  const importsPageObject = /from\s+['"][^'"]*\/pages\/[^'"]+['"]/.test(content);
  const pageObjectMethodCalls = (
    content.match(/\b[a-z][A-Za-z0-9_$]*Page\.[A-Za-z_$][\w$]*\s*\(/g) || []
  ).length;
  if (kind === 'spec' && (importsPageObject || pageObjectMethodCalls > 0)) {
    return {
      level: 'solid',
      label: 'POM flow',
      score: 95,
      detail: 'Spec uses page-object methods; element locators are intentionally kept in pages/ and locators/.',
    };
  }
  const roleCount   = (content.match(/getByRole\s*\(/g) || []).length;
  const stableCount = (content.match(/getBy(?:TestId|Label|Placeholder)\s*\(/g) || []).length;
  const textCount   = (content.match(/getByText\s*\(/g) || []).length;
  const cssCount    = (content.match(/\.locator\s*\(\s*['"`][.#\[]/g) || []).length;
  const total = roleCount + stableCount + textCount + cssCount;
  if (total === 0) return null;
  if (total === 0) return { level: 'ok', label: 'No locator calls', score: 50, detail: 'No Playwright locator calls detected — may be a config file.' };
  const stableRatio = (roleCount + stableCount) / total;
  const score = Math.round(30 + stableRatio * 70);
  const level = score >= 75 ? 'solid' : score >= 50 ? 'ok' : 'fragile';
  const label = level === 'solid' ? 'High confidence' : level === 'ok' ? 'Review recommended' : 'Fragile locators';
  const detail = `${roleCount} getByRole · ${stableCount} getByLabel/TestId · ${textCount} getByText · ${cssCount} CSS`;
  return { level, label, score, detail };
}

// Pretty bytes for the status bar.
function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function OutputFilesHeader({
  empty,
  stats,
  outputReadinessSummary,
  outputPreparation,
  triggerRepair,
  repairBusy,
  runs,
  selectedRunId,
  activeRun,
  onRunChange,
  loading,
  load,
  downloadZip,
  downloadEvidence,
  saveToFolder,
  savingFolder,
  openInVscode,
  vscodeBusy,
  exportBlocked,
}) {
  const subtitle = empty
    ? 'No outputs yet - kick off a run from Test Cases.'
    : `${stats.files} file${stats.files === 1 ? '' : 's'} · ${stats.dirs} folder${stats.dirs === 1 ? '' : 's'} · ${formatBytes(stats.totalSize)}`;

  return (
    <header className="sticky top-0 z-20 border-b border-ink-200 bg-white/95 px-page py-4 shadow-[0_1px_0_rgba(15,23,42,0.02)] backdrop-blur">
      <div className="mx-auto flex w-full max-w-[1680px] flex-col gap-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold tracking-tight text-ink-900">Output Files</h1>
            <p className="mt-0.5 text-sm text-ink-500">{subtitle}</p>
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-2.5 lg:justify-end">
            <BudgetChip />
            <ProjectPicker />
            <SprintPicker />
            <GenerationPicker />
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-ink-100 pt-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-2.5">
            <OutputReadinessBadge
              summary={outputReadinessSummary}
              preparation={outputPreparation}
              onRepair={outputReadinessSummary?.headline === 'incomplete_evidence' ? triggerRepair : null}
              repairBusy={repairBusy}
            />
            {runs.length > 1 && (
              <RunSelector
                runs={runs}
                value={selectedRunId || (activeRun?.id ?? null)}
                onChange={onRunChange}
              />
            )}
            <Button size="sm" variant="ghost" onClick={() => load(true)} disabled={loading} title="Re-walk the workspace">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-2.5 xl:justify-end">
            <Button
              size="sm"
              variant="secondary"
              onClick={downloadZip}
              disabled={empty}
              title="Download this workspace as a zip"
            >
              <Download className="w-3.5 h-3.5" />
              Download .zip
            </Button>
            <Button size="sm" variant="secondary" onClick={downloadEvidence} disabled={empty} title="Download the audit evidence bundle for this run">
              <ShieldCheck className="w-3.5 h-3.5" />
              Evidence
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={saveToFolder}
              disabled={empty || savingFolder}
              loading={savingFolder}
              title="Write this suite straight into a folder on your machine (no unzip), then open it in VS Code. Works on Chrome/Edge."
            >
              <FolderDown className="w-3.5 h-3.5" />
              Save to folder
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={openInVscode}
              disabled={empty || vscodeBusy}
              loading={vscodeBusy}
              title="Copy this suite into the project's local folder and open it in VS Code (works when QAAI runs on your machine)"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Open in VS Code
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}

// Build a flat list of [{path, name, kind, depth}] from the tree so we can
// search across the whole workspace later. Currently unused but handy if
// we add filtering.
function flatten(node, depth = 0, acc = []) {
  if (node.type === 'file') {
    acc.push({ path: node.path, name: node.name, kind: node.kind, depth });
  } else {
    for (const c of node.children || []) flatten(c, depth + 1, acc);
  }
  return acc;
}

// Pick a sensible default file to preview when the tree loads. Prefer a
// page object (the trust surface), then a spec, then config, then anything.
function pickDefaultPath(node) {
  const all = flatten(node);
  return (
    all.find((f) => f.kind === 'page')?.path
    ?? all.find((f) => f.kind === 'spec')?.path
    ?? all.find((f) => f.kind === 'config')?.path
    ?? all[0]?.path
    ?? null
  );
}

export default function OutputFiles() {
  const { current, currentGenerationId } = useProject();
  const toast = useToast();
  const { subscribe } = useRunStream();
  const frameworkMeta = useMemo(() => frameworkMetaFor(current), [current?.framework]);
  const activeFramework = frameworkMeta.adapter || resolveFramework(current);
  const bundleFramework = resolveBundleFramework(activeFramework);
  const [tree, setTree] = useState(null);
  const [stats, setStats] = useState({ files: 0, dirs: 0, totalSize: 0, byKind: {} });
  const [loading, setLoading] = useState(true);
  const [activePath, setActivePath] = useState(null);
  const [activeFile, setActiveFile] = useState(null); // { name, path, content, kind, sizeBytes, mtime }
  const [filePending, setFilePending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [empty, setEmpty] = useState(false);
  // Phase F.1 — per-run isolation. The output workspace shows ONE run at
  // a time. Default to the latest run (selectedRunId null = "let server
  // pick latest"); the user can switch via the run selector dropdown.
  const [runs, setRuns] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [activeRun, setActiveRun] = useState(null);
  const [exportBlocked, setExportBlocked] = useState(false);
  const [exportBlockDetail, setExportBlockDetail] = useState(null);
  const [outputReadinessSummary, setOutputReadinessSummary] = useState(null);
  const [outputPreparation, setOutputPreparation] = useState(null);
  const [repairBusy, setRepairBusy] = useState(false);
  const [scriptRunBusy, setScriptRunBusy] = useState(false);
  const [scriptRepairBusyId, setScriptRepairBusyId] = useState(null);
  const [scriptValidation, setScriptValidation] = useState(null);
  const [scriptHighlight, setScriptHighlight] = useState(null);
  const [fileRefreshNonce, setFileRefreshNonce] = useState(0);
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [explorerWidth, setExplorerWidth] = useState(380);
  const outputFileList = useMemo(() => (tree ? flatten(tree) : []), [tree]);
  const generationQuery = useMemo(
    () => (currentGenerationId ? { generationId: currentGenerationId } : {}),
    [currentGenerationId],
  );

  const load = useCallback(async (preservePath = true, runIdOverride) => {
    if (!current) { setLoading(false); return; }
    setLoading(true);
    try {
      // selectedRunId === null means "latest" — server picks.
      const runId = runIdOverride !== undefined ? runIdOverride : selectedRunId;
      const qs = outputQuery(runId, activeFramework, generationQuery);
      const res = await api.get(`/projects/${current.id}/output-files${qs}`);
      setTree(res.tree || null);
      setStats(res.stats || { files: 0, dirs: 0, totalSize: 0, byKind: {} });
      setEmpty(!!res.empty);
      setActiveRun(res.run || null);
      setExportBlocked(!!res.exportBlocked);
      setExportBlockDetail(res.exportBlockDetail || null);
      setOutputReadinessSummary(res.certificationSummary || null);
      setOutputPreparation(res.outputPreparation || null);
      setScriptValidation(res.scriptValidation || null);
      // Auto-select something the first time, or if the previous selection
      // disappeared (file got deleted by a regeneration).
      if (res.tree) {
        const flat = flatten(res.tree).map((f) => f.path);
        if (!preservePath || !activePath || !flat.includes(activePath)) {
          setActivePath(pickDefaultPath(res.tree));
        }
      }
    } catch (err) {
      setTree(null);
      setStats({ files: 0, dirs: 0, totalSize: 0, byKind: {} });
      setEmpty(true);
      setActiveRun(null);
      setOutputPreparation(null);
      setScriptValidation(null);
      toast.error(err.message || 'Failed to load workspace.');
    } finally {
      setLoading(false);
    }
  }, [current, toast, activePath, selectedRunId, activeFramework, generationQuery]);

  // Fetch the list of runs for the project — powers the run selector.
  const loadRuns = useCallback(async () => {
    if (!current) return;
    try {
      const res = await api.get(`/projects/${current.id}/output-files/runs${outputQuery(null, activeFramework, generationQuery)}`);
      setRuns(Array.isArray(res?.runs) ? res.runs : []);
    } catch (_) {
      // Non-fatal — selector just won't populate. Tree still loads.
    }
  }, [current, activeFramework, generationQuery]);

  useEffect(() => {
    setSelectedRunId(null);
    setActivePath(null);
    setActiveFile(null);
    loadRuns();
    load(false, null);
    /* eslint-disable-next-line */
  }, [current?.id, currentGenerationId, activeFramework]);

  // Live reload: when a run completes, files have likely changed on disk.
  // A NEW run completing also means a new entry exists in /runs, so the
  // selector refreshes too.
  useEffect(() => {
    if (!current?.id) return;
    return subscribe((msg) => {
      if (msg.projectId && msg.projectId !== current.id) return;
      if (msg.type === 'run.complete') {
        loadRuns();
        // When a new run finishes AND the user is viewing "latest" (no
        // explicit selection), jump to the new run automatically.
        if (selectedRunId === null) load(true);
      }
      if (msg.type === 'run.certificationRepairComplete') {
        const resolved = Number(msg.resolved || 0);
        const failed = Number(msg.failed || 0);
        if (failed > 0) {
          toast.info(`Repair finished: ${resolved} locator${resolved === 1 ? '' : 's'} recaptured, ${failed} still need authenticated live recapture.`);
        } else {
          toast.success(`Repair finished: ${resolved} locator${resolved === 1 ? '' : 's'} recaptured.`);
        }
        load(true);
      }
      if (msg.type === 'run.certificationRepairFailed') {
        toast.error(msg.error || 'Evidence repair failed before it could recapture the missing locators.');
        load(true);
      }
      if (msg.type === 'output.scriptValidationComplete') {
        setScriptValidation((prev) => ({ ...(prev || {}), ...msg, status: msg.status, summary: msg.summary, failures: msg.failures }));
        if (msg.status === 'certified') {
          toast.success('Generated Playwright scripts passed validation.');
        } else if (msg.status === 'failed') {
          toast.error('Generated Playwright scripts failed validation. The failing file and line are now available.');
        } else {
          toast.info('Generated scripts remain preview-only. Check the validation details before release use.');
        }
        load(true);
      }
      if (msg.type === 'output.scriptValidationQueued' || msg.type === 'output.scriptValidationRunning') {
        setScriptValidation((prev) => ({
          ...(prev || {}),
          ...(msg.job || {}),
          bundleId: msg.bundleId || msg.job?.bundleId || prev?.bundleId,
          status: msg.type === 'output.scriptValidationRunning' ? 'running' : 'queued',
        }));
        if (msg.type === 'output.scriptValidationQueued') {
          toast.info('Generated-script validation is queued.');
        }
      }
      if (msg.type === 'output.scriptRepairComplete') {
        setScriptValidation((prev) => ({ ...(prev || {}), status: msg.status, summary: msg.summary }));
        setFileRefreshNonce((n) => n + 1);
        if (msg.status === 'healed' || msg.status === 'certified') {
          toast.success('Script repair passed its rerun. The repaired bundle is now stored in Output Files.');
        } else {
          toast.info('Script repair was applied. Review the rerun validation result.');
        }
        load(true);
      }
    });
  }, [subscribe, current?.id, load, loadRuns, selectedRunId, toast]);

  useEffect(() => {
    if (!current?.id || empty) return undefined;
    const runActive = ['running', 'queued'].includes(String(activeRun?.status || ''));
    if (!outputPreparation || (outputPreparation.status === 'ready' && !runActive)) return undefined;
    if (outputPreparation.status === 'reacquisition_required' && !runActive) return undefined;
    if (outputPreparation.status === 'certification_failed' && !runActive) return undefined;
    const timer = window.setInterval(() => {
      load(true);
      loadRuns();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [current?.id, empty, activeRun?.status, outputPreparation?.status, outputPreparation?.prepared, outputPreparation?.preparing, load, loadRuns]);

  // Fetch the active file's content whenever the selection changes.
  useEffect(() => {
    if (!current || !activePath) { setActiveFile(null); return; }
    let cancelled = false;
    setFilePending(true);
    (async () => {
      try {
        const encoded = activePath.split('/').map(encodeURIComponent).join('/');
        const qs = outputQuery(selectedRunId, activeFramework, generationQuery);
        const res = await api.get(`/projects/${current.id}/output-files/file/${encoded}${qs}`);
        if (!cancelled) setActiveFile(res);
      } catch (err) {
        if (!cancelled) {
          setActiveFile(null);
          toast.error(err.message || 'Could not load file.');
        }
      } finally {
        if (!cancelled) setFilePending(false);
      }
    })();
    return () => { cancelled = true; };
  }, [current, activePath, toast, selectedRunId, activeFramework, generationQuery, fileRefreshNonce]);

  const copy = async () => {
    if (!activeFile?.content) return;
    try {
      await navigator.clipboard.writeText(activeFile.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_) {
      toast.error('Browser refused clipboard access.');
    }
  };

  const downloadZip = () => {
    if (!current) return;
    // Per-run scoped ZIP — bundles only the selected run's workspace.
    const qs = outputQuery(selectedRunId, bundleFramework, generationQuery);
    window.open(`/api/projects/${current.id}/output-files/download.zip${qs}`, '_blank');
  };

  const downloadEvidence = () => {
    if (!current) return;
    const params = new URLSearchParams({ framework: activeFramework });
    const evidenceRunId = selectedRunId || activeRun?.id;
    if (evidenceRunId) params.set('runId', evidenceRunId);
    if (currentGenerationId) params.set('generationId', currentGenerationId);
    const qs = `?${params.toString()}`;
    window.open(`/api/projects/${current.id}/output-files/evidence.zip${qs}`, '_blank');
  };

  const startExplorerResize = useCallback((event) => {
    if (explorerCollapsed || editorExpanded) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = explorerWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (moveEvent) => {
      const nextWidth = Math.max(280, Math.min(560, startWidth + moveEvent.clientX - startX));
      setExplorerWidth(nextWidth);
    };
    const onDone = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onDone);
      window.removeEventListener('pointercancel', onDone);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onDone);
    window.addEventListener('pointercancel', onDone);
  }, [editorExpanded, explorerCollapsed, explorerWidth]);

  const triggerRepair = useCallback(async () => {
    if (!current || !activeRun || activeRun.id === '__legacy__') return;
    setRepairBusy(true);
    try {
      const res = await api.post(`/projects/${current.id}/output-files/repair`, { runId: activeRun.id });
      const count = Number(res.targetCount || 0);
      toast.info(`Authenticated recapture started for ${count || 'the remaining'} output case${count === 1 ? '' : 's'}.`);
    } catch (err) {
      const code = err.payload?.code || err.code;
      if (code === 'NOTHING_TO_REPAIR') {
        toast.info('No active repair queue was found. Refreshing output status from the latest run evidence.');
        load(true);
      } else if (code === 'REPAIR_BUDGET_EXHAUSTED') {
        toast.info('Repair attempts are exhausted for this run. QAAI needs live reacquisition for the remaining output evidence.');
        load(true);
      } else {
        toast.error(err.payload?.message || err.message || 'Repair request failed.');
      }
    } finally {
      setRepairBusy(false);
    }
  }, [current, activeRun, toast, load]);

  // ── Open in VS Code ─────────────────────────────────────
  // POSTs to the server, which copies this run's complete project into the
  // project's configured local folder and launches `code <folder>`. If no
  // folder is configured yet, the server replies NO_WORKSPACE_PATH and we
  // prompt for one, save it, then retry.
  const [vscodeBusy, setVscodeBusy] = useState(false);
  const [pathModal, setPathModal] = useState(null); // { value } when open

  const openInVscode = useCallback(async () => {
    if (!current) return;
    setVscodeBusy(true);
    try {
      const qs = outputQuery(selectedRunId, bundleFramework, generationQuery);
      const res = await api.post(`/projects/${current.id}/output-files/open-in-vscode${qs}`, {});
      if (res.opened) {
        toast.success(`Opened in VS Code — ${res.path}`);
      } else if (res.code === 'NO_CODE_CLI') {
        toast.info(`Files copied to ${res.path}, but the "code" command isn't on your PATH. Open that folder in VS Code manually, or run VS Code → Ctrl+Shift+P → "Shell Command: Install 'code' command in PATH", then try again.`);
      }
      setPathModal(null);
    } catch (err) {
      if (err.code === 'NO_WORKSPACE_PATH') {
        // First use — ask where to put it, then retry.
        const suggested = `C:\\QA_Projects\\${(current.name || 'project').replace(/[^a-zA-Z0-9_-]+/g, '')}`;
        setPathModal({ value: suggested });
      } else {
        toast.error(err.payload?.message || err.message || 'Could not open in VS Code.');
      }
    } finally {
      setVscodeBusy(false);
    }
  }, [current, selectedRunId, toast, bundleFramework, generationQuery]);

  const savePathAndOpen = useCallback(async () => {
    const value = (pathModal?.value || '').trim();
    if (!value) { toast.error('Enter the folder path first.'); return; }
    setVscodeBusy(true);
    try {
      await api.put(`/projects/${current.id}`, { vscodeWorkspacePath: value });
      setPathModal(null);
      await openInVscode(); // retry now that the folder is saved
    } catch (err) {
      toast.error(err.payload?.message || err.message || 'Could not save the folder path.');
      setVscodeBusy(false);
    }
  }, [pathModal, current, toast, openInVscode]);

  // ── Save to folder (File System Access API) ─────────────
  // Browser-side write into a folder the user picks on THEIR machine — works
  // even when QAAI is deployed remotely. Remembers the folder per project.
  // Falls back to the ZIP download on browsers without the API.
  const [savingFolder, setSavingFolder] = useState(false);

  const saveToFolder = useCallback(async () => {
    if (!current) return;
    if (!isFsAccessSupported()) {
      toast.info('This browser can\'t save to a folder directly — downloading a .zip instead. Use Chrome or Edge for direct save.');
      downloadZip();
      return;
    }
    setSavingFolder(true);
    try {
      const qs = outputQuery(selectedRunId, bundleFramework, generationQuery);
      const res = await api.get(`/projects/${current.id}/output-files/files.json${qs}`);
      const files = res.files || [];
      if (!files.length) { toast.error('No files to save yet — run a suite first.'); return; }

      // Reuse the remembered folder if we still have permission; else pick one.
      let handle = await getSavedDirHandle(current.id);
      if (handle && !(await verifyPermission(handle, true))) handle = null;
      if (!handle) {
        handle = await pickDirectory(); // throws AbortError if the user cancels
        await rememberDirHandle(current.id, handle);
      }

      await writeFilesToDir(handle, files);
      toast.success(`Saved ${files.length} files to "${handle.name}". Open that folder in VS Code (File → Open Folder).`);
    } catch (err) {
      if (err?.name === 'AbortError') return; // user dismissed the folder picker
      toast.error(err?.message || 'Could not save to the folder.');
    } finally {
      setSavingFolder(false);
    }
  }, [current, selectedRunId, toast, bundleFramework, generationQuery]);

  const runScripts = useCallback(async () => {
    if (!current || empty) return;
    const bundleId = activeRun?.id || selectedRunId || 'latest';
    setScriptRunBusy(true);
    try {
      const qs = outputQuery(activeRun?.id || selectedRunId, activeFramework, generationQuery);
      const res = await api.post(`/projects/${current.id}/output-files/${encodeURIComponent(bundleId)}/run${qs}`, { mode: 'user_run', async: true });
      const job = res.job || null;
      setScriptValidation(job);
      toast.info('Script validation queued. QAAI will update this bundle when the isolated runner finishes.');
    } catch (err) {
      toast.error(err.payload?.message || err.message || 'Script validation failed to start.');
    } finally {
      setScriptRunBusy(false);
    }
  }, [current, empty, activeRun?.id, selectedRunId, activeFramework, generationQuery, toast, load]);

  const viewScriptFailure = useCallback((failure) => {
    if (!failure?.file) return;
    setActivePath(failure.file);
    setScriptHighlight({
      path: failure.file,
      line: Number(failure.line || 1),
      id: failure.id || `${failure.file}:${failure.line || 1}`,
    });
    setEditorExpanded(true);
    setFileRefreshNonce((n) => n + 1);
  }, []);

  const viewScriptRepairJournal = useCallback(() => {
    setActivePath('evidence/script-repair-journal.json');
    setScriptHighlight(null);
    setEditorExpanded(true);
    setFileRefreshNonce((n) => n + 1);
  }, []);

  const proposeScriptRepair = useCallback(async (failure, patch = null) => {
    if (!current || !failure?.id) return null;
    const bundleId = scriptValidation?.bundleId || activeRun?.id || selectedRunId || 'latest';
    const runIdForQuery = activeRun?.id || selectedRunId || (bundleId !== 'latest' ? bundleId : null);
    const qs = outputQuery(runIdForQuery, activeFramework, generationQuery);
    const res = await api.post(
      `/projects/${current.id}/output-files/${encodeURIComponent(bundleId)}/repairs/${encodeURIComponent(failure.id)}/propose${qs}`,
      patch || {},
    );
    return res.proposal || null;
  }, [current, scriptValidation?.bundleId, activeRun?.id, selectedRunId, activeFramework, generationQuery]);

  const repairScriptFailure = useCallback(async (failure, proposal = null) => {
    if (!current || !failure?.id) return;
    const bundleId = scriptValidation?.bundleId || activeRun?.id || selectedRunId || 'latest';
    const runIdForQuery = activeRun?.id || selectedRunId || (bundleId !== 'latest' ? bundleId : null);
    setScriptRepairBusyId(failure.id);
    try {
      const qs = outputQuery(runIdForQuery, activeFramework, generationQuery);
      const res = await api.post(
        `/projects/${current.id}/output-files/${encodeURIComponent(bundleId)}/repairs/${encodeURIComponent(failure.id)}/apply${qs}`,
        proposal?.after
          ? {
              file: proposal.file || failure.file,
              after: proposal.after,
              expectedBefore: proposal.before || null,
            }
          : {},
      );
      const job = res.job || null;
      if (job) setScriptValidation(job);
      viewScriptFailure(failure);
      setFileRefreshNonce((n) => n + 1);
      if (job?.status === 'healed' || job?.status === 'certified') {
        toast.success('Repair applied and the failed test reran cleanly.');
      } else {
        toast.info(job?.reason || 'Repair applied. Review the rerun validation result.');
      }
      load(true);
    } catch (err) {
      const code = err.payload?.code || err.code;
      if (code === 'SCRIPT_REPAIR_MANUAL_GATE') {
        toast.info(err.payload?.message || 'This script failure needs manual review before QAAI can repair it safely.');
      } else if (code === 'SCRIPT_REPAIR_STALE_FILE') {
        toast.info('The file changed after validation. Run scripts again, then repair the latest failure.');
      } else {
        toast.error(err.payload?.message || err.message || 'Script repair failed.');
      }
    } finally {
      setScriptRepairBusyId(null);
    }
  }, [current, scriptValidation?.bundleId, activeRun?.id, selectedRunId, activeFramework, generationQuery, toast, load, viewScriptFailure]);

  const handleAssistantBundlePatched = useCallback((patch) => {
    if (!patch?.file) return;
    const line = patch.line == null ? null : Number(patch.line || 1);
    setActivePath(patch.file);
    setScriptHighlight(line
      ? {
          path: patch.file,
          line,
          id: `assistant-patch:${patch.file}:${line}:${Date.now()}`,
        }
      : null);
    setEditorExpanded(true);
    setFileRefreshNonce((n) => n + 1);
    load(true);
    toast.success(line ? `Patched ${patch.file}:${line}` : patch.action === 'created' ? `Created ${patch.file}` : `Rewrote ${patch.file}`);
  }, [load, toast]);

  const onRunChange = (next) => {
    setSelectedRunId(next || null);
    setActivePath(null);
    setActiveFile(null);
    // Reload tree against the new run choice. Pass it explicitly so we
    // don't wait for the state update before fetching.
    load(false, next || null);
  };

  const displayedExportBlockDetail = exportBlocked
    ? (outputPreparation
      ? (outputPreparation.status === 'certification_failed'
        ? `${outputPreparation.prepared || 0}/${outputPreparation.total || 0} tests generated with validation diagnostics. Generated files remain visible; this is a QAAI output diagnostic, not a website failure.`
        : outputPreparation.status === 'reacquisition_required'
        ? `${outputPreparation.prepared || 0}/${outputPreparation.total || 0} tests generated. Some validation evidence needs live reacquisition; generated files remain visible.`
        : `Output package is still preparing. ${outputPreparation.prepared || 0}/${outputPreparation.total || 0} tests generated · ${outputPreparation.preparing || 0} generating. Diagnostics do not hide generated files.`)
      : 'Output package is still preparing. QAAI is preparing the remaining output evidence; generated files remain visible while diagnostics complete.')
    : null;

  if (!current) {
    return (
      <div className="relative flex flex-col h-full overflow-hidden">
        <div className="absolute inset-0 -z-10"><AuroraBackground /></div>
        <PageHeader title="Output Files" />
        <EmptyState
          icon={Folder}
          title="No project selected"
          message="Activate a project to see its generated test workspace."
        />
      </div>
    );
  }

  return (
    <div className="relative flex flex-col h-full overflow-hidden">
      <div
        className="pointer-events-none"
        style={{ position: 'sticky', top: 0, height: '100dvh', marginBottom: '-100dvh', zIndex: 0 }}
      >
        <AuroraBackground />
      </div>

      <div className="relative z-10">
        <PageHeader
          title="Output Files"
          subtitle={
            empty
              ? 'No outputs yet — kick off a run from Test Cases.'
              : `${stats.files} file${stats.files === 1 ? '' : 's'} · ${stats.dirs} folder${stats.dirs === 1 ? '' : 's'} · ${formatBytes(stats.totalSize)}`
          }
        >
          <OutputReadinessBadge
            summary={outputReadinessSummary}
            preparation={outputPreparation}
            onRepair={
              (
                outputReadinessSummary?.headline === 'incomplete_evidence'
                || outputReadinessSummary?.headline === 'not_exportable'
                || Number(outputPreparation?.needsReacquisition || 0) > 0
              ) && !['running', 'queued'].includes(String(activeRun?.status || ''))
                ? triggerRepair
                : null
            }
            repairBusy={repairBusy}
          />
          {/* Only show the run selector when there's more than one source to
              switch between — otherwise it's noise. */}
          {runs.length > 1 && (
            <RunSelector
              runs={runs}
              value={selectedRunId || (activeRun?.id ?? null)}
              onChange={onRunChange}
            />
          )}
          <Button size="sm" variant="ghost" onClick={() => load(true)} disabled={loading} title="Re-walk the workspace">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={downloadZip}
            disabled={empty}
            title={exportBlocked ? 'Generated output has nonblocking diagnostics. Review Evidence for details.' : 'Download this workspace as a zip'}
          >
            <Download className="w-3.5 h-3.5" />
            Download .zip
          </Button>
          <Button size="sm" variant="secondary" onClick={downloadEvidence} disabled={empty} title="Download the audit evidence bundle for this run">
            <ShieldCheck className="w-3.5 h-3.5" />
            Evidence
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={runScripts}
            disabled={empty || scriptRunBusy}
            loading={scriptRunBusy}
            title="Run the generated Playwright scripts inside QAAI and attach validation evidence"
          >
            <PlayCircle className="w-3.5 h-3.5" />
            Run scripts
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={saveToFolder}
            disabled={empty || savingFolder}
            loading={savingFolder}
            title="Write this suite straight into a folder on your machine (no unzip), then open it in VS Code. Works on Chrome/Edge."
          >
            <FolderDown className="w-3.5 h-3.5" />
            Save to folder
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={openInVscode}
            disabled={empty || vscodeBusy}
            loading={vscodeBusy}
            title="Copy this suite into the project's local folder and open it in VS Code (works when QAAI runs on your machine)"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Open in VS Code
          </Button>
        </PageHeader>
      </div>

      <main className="relative z-10 flex-1 overflow-y-auto bg-transparent">
        <div className="min-h-full max-w-[1680px] mx-auto px-page py-4 lg:py-5 flex flex-col gap-3">
          {loading && !tree ? (
            <div className="glass p-6 text-sm text-ink-500">Loading workspace…</div>
          ) : empty ? (
            <div className="glass p-10 flex items-center justify-center">
              <EmptyState
                icon={FileCode}
                title="Workspace is empty"
                message={`Run a suite from Run Suite or Test Cases. QAAI will build the selected ${frameworkMeta.label} package here for preview, folder save, VS Code open, or zip export.`}
              />
            </div>
          ) : (
            <>
            <FrameworkSummary meta={frameworkMeta} stats={stats} exportBlocked={exportBlocked} outputPreparation={outputPreparation} />
            <ScriptValidationPanel
              report={scriptValidation}
              current={outputPreparation?.validationCurrent}
              onRun={runScripts}
              running={scriptRunBusy}
              disabled={empty}
              onViewFailure={viewScriptFailure}
              onRepairFailure={repairScriptFailure}
              repairingFailureId={scriptRepairBusyId}
              onViewJournal={viewScriptRepairJournal}
            />
            <div
              className={`grid gap-0 min-h-[680px] lg:h-[calc(100dvh-260px)] ${
              explorerCollapsed || editorExpanded
                ? 'grid-cols-1'
                : 'grid-cols-1 lg:grid-cols-[var(--explorer-width)_14px_minmax(0,1fr)]'
              }`}
              style={!explorerCollapsed && !editorExpanded ? { '--explorer-width': `${explorerWidth}px` } : undefined}
            >
              {/* ── Left: tree explorer ── */}
              {!explorerCollapsed && !editorExpanded && (
              <aside className="glass border-transparent overflow-hidden flex flex-col h-full min-h-0">
                <div className="px-3 py-2 border-b border-ink-100 flex items-center gap-2">
                  <FolderOpen className="w-3.5 h-3.5 text-ink-500" aria-hidden="true" />
                  <span className="text-2xs font-bold uppercase tracking-wider text-ink-600">Explorer</span>
                  <span className="ml-auto text-2xs text-ink-400 tabular-nums">{stats.files}</span>
                  <button
                    type="button"
                    onClick={() => setExplorerCollapsed(true)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-500 hover:bg-ink-100 hover:text-ink-900 transition-colors"
                    title="Collapse explorer"
                    aria-label="Collapse explorer"
                  >
                    <PanelLeftClose className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto py-1 text-sm">
                  {tree && (
                    <TreeNode
                      node={tree}
                      depth={0}
                      activePath={activePath}
                      onSelectFile={setActivePath}
                      defaultOpen
                    />
                  )}
                </div>
              </aside>
              )}

              {/* ── Right: file preview ── */}
              {!explorerCollapsed && !editorExpanded && (
                <div
                  className="hidden lg:flex items-center justify-center cursor-col-resize group"
                  onPointerDown={startExplorerResize}
                  onDoubleClick={() => setExplorerWidth(380)}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize explorer"
                  title="Drag to resize Explorer. Double-click to reset."
                >
                  <div className="h-24 w-1.5 rounded-full bg-ink-300/45 transition-colors group-hover:bg-accent-500/80" />
                </div>
              )}
              <section className="glass border-transparent overflow-hidden flex flex-col h-full min-h-0">
                {!activeFile && !filePending && (
                  <div className="flex-1 flex items-center justify-center text-sm text-ink-500">
                    Select a file from the explorer to preview it.
                  </div>
                )}
                {filePending && (
                  <div className="flex-1 flex items-center justify-center text-sm text-ink-500">
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    Loading…
                  </div>
                )}
                {activeFile && !filePending && (
                  <>
                    {/* Editor chrome — breadcrumb path, size, reliability badge, copy */}
                    <div className="flex items-center gap-2 px-3 py-2 border-b border-ink-100 min-w-0">
                      {explorerCollapsed && !editorExpanded && (
                        <button
                          type="button"
                          onClick={() => setExplorerCollapsed(false)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-500 hover:bg-ink-100 hover:text-ink-900 transition-colors shrink-0"
                          title="Show explorer"
                          aria-label="Show explorer"
                        >
                          <PanelLeftOpen className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <FileBreadcrumb path={activeFile.path} kind={activeFile.kind} />
                      {(() => {
                        const h = scriptHealth(activeFile.content, activeFile.kind);
                        if (!h) return null;
                        const tone = h.level === 'solid'
                          ? 'bg-success-50 text-success-700 border-success-200'
                          : h.level === 'ok'
                          ? 'bg-warn-50 text-warn-700 border-warn-200'
                          : 'bg-danger-50 text-danger-700 border-danger-200';
                        return (
                          <span
                            className={`inline-flex items-center px-2 h-5 rounded-pill text-[10px] font-semibold border shrink-0 ${tone}`}
                            title={`Script health ${h.score}/100 — ${h.detail}`}
                          >
                            {h.label}
                          </span>
                        );
                      })()}
                      <span className="ml-auto hidden md:inline text-2xs text-ink-400 tabular-nums shrink-0">
                        {formatBytes(activeFile.sizeBytes)} · {new Date(activeFile.mtime).toLocaleString()}
                      </span>
                      <button
                        type="button"
                        onClick={() => setEditorExpanded((v) => !v)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-500 hover:bg-ink-100 hover:text-ink-900 transition-colors shrink-0"
                        title={editorExpanded ? 'Restore split view' : 'Focus editor'}
                        aria-label={editorExpanded ? 'Restore split view' : 'Focus editor'}
                      >
                        {editorExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
                      </button>
                      <button
                        type="button"
                        onClick={copy}
                        disabled={activeFile.binary || !activeFile.content}
                        className="inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-ink-600 hover:text-ink-900 hover:bg-ink-100 px-2 py-1 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        title="Copy the entire file"
                      >
                        {copied ? <Check className="w-3 h-3 text-success-600" /> : <Copy className="w-3 h-3" />}
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    {activeFile.binary
                      ? <BinaryFilePreview file={activeFile} />
                      : (
                        <CodePreview
                          content={activeFile.content || ''}
                          highlightLine={scriptHighlight?.path === activeFile.path ? scriptHighlight.line : null}
                        />
                      )}
                  </>
                )}
              </section>
            </div>
            </>
          )}
        </div>
      </main>

      {/* First-use prompt: capture the local folder, save it, then open. */}
      {pathModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 backdrop-blur-sm px-4"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => { if (e.target === e.currentTarget && !vscodeBusy) setPathModal(null); }}
        >
          <div className="glass w-full max-w-lg p-5 rounded-xl">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="font-display text-base font-semibold text-ink-900">Open in VS Code</h3>
                <p className="text-xs text-ink-500 mt-1">
                  Choose (or create) a folder on your machine. We'll copy this suite there and open it in VS Code.
                </p>
              </div>
              <button
                onClick={() => !vscodeBusy && setPathModal(null)}
                className="text-ink-400 hover:text-ink-700 p-1 -m-1"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <Input
              label="Local folder (absolute path)"
              value={pathModal.value}
              autoFocus
              onChange={(e) => setPathModal((m) => ({ ...m, value: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter' && !vscodeBusy) savePathAndOpen(); }}
              placeholder="C:\QA_Projects\MyApp"
              hint="Tip: create an empty folder in your workspace first, then paste its full path here. This is saved to the project's settings, so you only do it once."
            />
            <div className="flex items-center justify-end gap-2 mt-4">
              <Button size="sm" variant="ghost" onClick={() => setPathModal(null)} disabled={vscodeBusy}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" onClick={savePathAndOpen} loading={vscodeBusy}>
                <ExternalLink className="w-3.5 h-3.5" />
                Save &amp; open
              </Button>
            </div>
          </div>
        </div>
      )}

      {!pathModal && (
        <OutputFilesAssistant
          projectId={current.id}
          projectName={current.name}
          generationId={currentGenerationId}
          framework={activeFramework}
          frameworkLabel={frameworkMeta.label}
          bundleId={scriptValidation?.bundleId || activeRun?.id || selectedRunId || 'latest'}
          activeFile={activeFile}
          fileList={outputFileList}
          report={scriptValidation}
          running={scriptRunBusy}
          disabled={empty}
          repairingFailureId={scriptRepairBusyId}
          onRunScripts={runScripts}
          onViewFailure={viewScriptFailure}
          onProposeRepair={proposeScriptRepair}
          onRepairFailure={repairScriptFailure}
          onViewJournal={viewScriptRepairJournal}
          onBundlePatched={handleAssistantBundlePatched}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OutputReadinessBadge — reads the aggregated output readiness summary from the
// API and renders the pipeline state for the active run's workspace.
//
// States:
//  ready             → green ShieldCheck (all or partial count)
//  draft             → blue Shield (contract validated, parity pending)
//  incomplete_evidence → amber ShieldAlert + Repair Output button
//  repairing         → amber Loader2 spinner
//  not_exportable    → amber preparation state; details live in the evidence report
//  null/unpipelined  → static "ReplayIR ready" fallback
// ─────────────────────────────────────────────────────────────────────────────
function ScriptValidationPanel({
  report,
  current,
  onRun,
  running,
  disabled,
  onViewFailure,
  onRepairFailure,
  repairingFailureId,
  onViewJournal,
}) {
  const reportedStatus = String(report?.status || 'not_run');
  const status = report && current === false ? 'stale' : reportedStatus;
  const tone = status === 'certified'
    ? 'bg-success-50 text-success-700 border-success-200'
    : status === 'healed'
    ? 'bg-info-50 text-info-700 border-info-200'
    : status === 'failed'
    ? 'bg-danger-50 text-danger-700 border-danger-200'
    : status === 'preview_only'
    ? 'bg-warn-50 text-warn-700 border-warn-200'
    : status === 'stale'
    ? 'bg-warn-50 text-warn-700 border-warn-200'
    : status === 'queued' || status === 'running'
    ? 'bg-info-50 text-info-700 border-info-200'
    : 'bg-ink-50 text-ink-600 border-ink-200';
  const label = status === 'certified'
    ? 'Certified'
    : status === 'healed'
    ? 'Healed'
    : status === 'failed'
    ? 'Script failed'
    : status === 'preview_only'
    ? 'Preview only'
    : status === 'stale'
    ? 'Stale result'
    : status === 'queued'
    ? 'Queued'
    : status === 'running'
    ? 'Validating'
    : 'Not run';
  const summary = report?.summary || {};
  const failures = Array.isArray(report?.failures) ? report.failures : [];
  const firstFailure = failures[0] || null;
  const repairs = Array.isArray(report?.repairJournal?.repairs) ? report.repairJournal.repairs : [];
  return (
    <section className="rounded-xl bg-white/82 px-4 py-3 shadow-sm ring-1 ring-white/75 backdrop-blur">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-success-50 text-success-700">
            <PlayCircle className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-bold text-ink-900">Script Validation Lane</span>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tone}`}>
                {label}
              </span>
              {report?.id && <span className="text-[11px] text-ink-400 font-mono">{String(report.id).slice(0, 8)}</span>}
            </div>
            <p className="mt-1 text-xs text-ink-500">
              {status === 'certified'
                ? `${summary.passed || 0}/${summary.total || 0} generated test${summary.total === 1 ? '' : 's'} passed inside QAAI.`
                : status === 'healed'
                ? `${summary.passed || 0}/${summary.total || 0} repaired test${summary.total === 1 ? '' : 's'} passed after an in-place bundle repair.`
                : status === 'failed'
                ? (firstFailure?.file
                  ? `Failed at ${firstFailure.file}:${firstFailure.line || 1}. ${firstFailure.error || 'Open validation evidence for details.'}`
                  : 'Generated scripts failed during QAAI validation. Open validation evidence for details.')
                : status === 'preview_only'
                ? 'Preview is available, but this bundle does not yet have a clean script execution proof.'
                : status === 'stale'
                ? 'The saved validation result belongs to older generated files. Run this current bundle before treating it as verified.'
                : status === 'queued'
                ? 'Generated-script validation is queued in the isolated QAAI runner.'
                : status === 'running'
                ? 'Generated scripts are running in the isolated QAAI script runner.'
                : 'Run the generated Playwright suite here before treating output files as certified.'}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          {repairs.length > 0 && (
            <Button size="sm" variant="ghost" onClick={onViewJournal} disabled={!onViewJournal} title="Open the script repair journal evidence file">
              <FileText className="w-3.5 h-3.5" />
              Repair journal
            </Button>
          )}
          {report?.artifacts?.some((a) => a.type === 'report') && (
            <span className="text-[11px] font-semibold text-ink-500">
              Evidence attached
            </span>
          )}
          <Button size="sm" variant="secondary" onClick={onRun} loading={running} disabled={disabled || running} title="Run generated scripts inside QAAI">
            <PlayCircle className="w-3.5 h-3.5" />
            Run scripts
          </Button>
        </div>
      </div>

      {failures.length > 0 && (
        <div className="mt-3 divide-y divide-ink-100 rounded-lg border border-ink-100 bg-white/70">
          {failures.slice(0, 6).map((failure, index) => {
            const id = failure.id || `${failure.file || 'unknown'}:${failure.line || index}`;
            const repairable = !!failure.repairAvailable;
            return (
              <div key={id} className="grid gap-2 px-3 py-2 text-xs lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11px] font-semibold text-ink-500">
                      {failure.file || 'unknown file'}:{failure.line || 1}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${repairable ? 'bg-info-50 text-info-700' : 'bg-warn-50 text-warn-700'}`}>
                      {repairable ? 'repairable' : 'manual review'}
                    </span>
                  </div>
                  <div className="mt-1 truncate font-medium text-ink-800" title={failure.testTitle || ''}>
                    {failure.testTitle || 'Generated script failure'}
                  </div>
                  <div className="mt-0.5 truncate text-ink-500" title={failure.error || ''}>
                    {failure.error || 'No error message captured.'}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                  <Button size="sm" variant="ghost" onClick={() => onViewFailure?.(failure)} disabled={!failure.file} title="Open the failing generated line">
                    <ExternalLink className="w-3.5 h-3.5" />
                    View line
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onRepairFailure?.(failure)}
                    loading={repairingFailureId === failure.id}
                    disabled={!repairable || !onRepairFailure || !!repairingFailureId}
                    title={repairable ? 'Patch the generated output file and rerun this failed test only' : 'QAAI did not capture enough script context for a safe automatic patch'}
                  >
                    <Wand2 className="w-3.5 h-3.5" />
                    Repair
                  </Button>
                </div>
              </div>
            );
          })}
          {failures.length > 6 && (
            <div className="px-3 py-2 text-xs text-ink-500">
              {failures.length - 6} additional script failure{failures.length - 6 === 1 ? '' : 's'} are available in the validation report evidence.
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function FrameworkSummary({ meta, stats, exportBlocked, outputPreparation }) {
  const dirs = Array.isArray(meta.layout) ? meta.layout : [];
  const byKind = stats?.byKind || {};
  const generatedTests = Number(outputPreparation?.generatedTests || 0);
  const certificationFailed = outputPreparation?.status === 'certification_failed';
  const metrics = [
    generatedTests ? { key: 'generated-tests', label: 'Test cases', value: generatedTests, icon: FlaskConical, cls: 'text-success-600' } : null,
    byKind.spec ? { key: 'spec', label: 'Spec files', value: byKind.spec, icon: kindMeta('spec').icon, cls: kindMeta('spec').cls } : null,
    byKind.page ? { key: 'page', label: 'Page files', value: byKind.page, icon: kindMeta('page').icon, cls: kindMeta('page').cls } : null,
    byKind.locator ? { key: 'locator', label: 'Locator files', value: byKind.locator, icon: kindMeta('locator').icon, cls: kindMeta('locator').cls } : null,
    byKind.data ? { key: 'data', label: 'Data files', value: byKind.data, icon: kindMeta('data').icon, cls: kindMeta('data').cls } : null,
    byKind.evidence ? { key: 'evidence', label: 'Evidence files', value: byKind.evidence, icon: kindMeta('evidence').icon, cls: kindMeta('evidence').cls } : null,
  ].filter(Boolean);
  return (
    <section
      className="rounded-xl bg-white/82 px-4 py-3 shadow-sm ring-1 ring-white/75 backdrop-blur"
      title={`Run command: ${meta.runCommand || 'See README.md'}`}
    >
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0 flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-info-50 text-info-700">
            <FileCode className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-bold text-ink-900">{meta.label}</span>
              <span className="text-xs text-ink-500">{meta.language}</span>
              <span className="hidden sm:inline text-xs text-ink-300">.</span>
              <span className="hidden sm:inline text-xs text-ink-500">{meta.packageLabel}</span>
              <span className="sr-only">{meta.runCommand}</span>
              {certificationFailed && (
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-warn-50 text-warn-700">
                  with warnings
                </span>
              )}
            </div>
            {dirs.length > 0 && (
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-500">
                {dirs.map((dir) => (
                  <span key={dir} className="font-mono text-ink-600">{dir}</span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-600 xl:justify-end">
          {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <span key={metric.key} className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <Icon className={`w-3.5 h-3.5 ${metric.cls}`} aria-hidden="true" />
              <span className="font-semibold tabular-nums">{metric.value}</span>
              <span>{metric.label}</span>
            </span>
          );
        })}
          <span className="whitespace-nowrap text-ink-400 tabular-nums">{stats.files} files</span>
        </div>
      </div>
    </section>
  );
}

function PreparationMeter({ preparation, compact = false }) {
  if (!preparation) return null;
  const total = Number(preparation.total || 0);
  const prepared = Number(preparation.prepared || 0);
  const preparing = Number(preparation.preparing || 0);
  const recapture = Number(preparation.needsReacquisition || preparation.notExportable || 0);
  const percent = Math.max(0, Math.min(100, Number(preparation.percent || 0)));
  const ready = preparation.status === 'ready' && preparation.certified === true;
  const needsReacquisition = preparation.status === 'reacquisition_required' || recapture > 0;
  const pendingLabel = preparation.validationStatus === 'not_run' || preparation.validationStatus === 'preview_only'
    ? 'not run'
    : preparing > 0
      ? `${preparing} generating`
      : preparation.runnable === false
        ? 'validation incomplete'
        : 'generated';
  return (
    <div className={`min-w-0 ${compact ? 'w-[128px]' : 'w-full max-w-[520px]'}`}>
      <div className="flex items-center justify-between gap-2 text-[11px] font-semibold text-ink-600">
        <span className="truncate">{compact ? `${prepared}/${total} generated` : `${prepared}/${total} tests generated`}</span>
        {!ready && !compact && (
          <span className="shrink-0 text-warn-700">
            {needsReacquisition ? `${recapture || Math.max(0, total - prepared)} need recapture` : pendingLabel}
          </span>
        )}
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-100">
        <div
          className={`h-full rounded-full transition-all duration-500 ${ready ? 'bg-success-500' : 'bg-warn-500'}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function OutputReadinessBadge({ summary, preparation, onRepair, repairBusy }) {
  if (preparation && Number(preparation.total || 0) > 0) {
    const ready = preparation.status === 'ready' && preparation.certified === true;
    const runActive = !!preparation.runStillActive;
    const recapture = Number(preparation.needsReacquisition || preparation.notExportable || 0);
    const blockers = Array.isArray(preparation.blockers) ? preparation.blockers : [];
    const primaryBlocker = blockers[0] || null;
    const hasAuthPrecondition = blockers.some((b) => /auth/i.test(`${b.rule || ''} ${b.message || ''}`));
    const activeRepairCount = Number(summary?.repairing || preparation.repairing || 0);
    const repairing = preparation.status === 'repairing' && activeRepairCount > 0;
    const certificationFailed = preparation.status === 'certification_failed';
    const draftGenerated = preparation.status === 'draft_generated' || preparation.status === 'generated_unverified';
    const notRun = preparation.validationStatus === 'not_run' || preparation.validationStatus === 'preview_only';
    const needsRepair = preparation.status === 'needs_repair';
    const safetyDiagnostic = preparation.status === 'safety_blocked';
    const needsReacquisition = preparation.status === 'reacquisition_required' || (!repairing && !runActive && recapture > 0);
    const label = ready
      ? 'Verified and runnable'
      : safetyDiagnostic
        ? 'Generated with diagnostics'
      : needsRepair || certificationFailed
        ? 'Generated draft'
      : draftGenerated
        ? (notRun ? 'Generated - not run' : 'Generated draft')
      : needsReacquisition
        ? (hasAuthPrecondition ? 'Auth needed for recapture' : 'Needs live recapture')
        : repairing
          ? 'Repairing output'
          : runActive
            ? 'Generating tests'
            : 'Preparing output';
    const Icon = ready ? ShieldCheck : safetyDiagnostic || needsRepair || certificationFailed || needsReacquisition ? ShieldAlert : draftGenerated ? FileCode : repairing ? Loader2 : Loader2;
    const title = `${preparation.phase || 'Generated output'}: ${preparation.prepared}/${preparation.total} tests generated.${preparation.downloadable ? ' Files remain downloadable.' : ''}${recapture ? ` ${recapture} passed case(s) need live reacquisition before export.` : ''}${primaryBlocker?.message ? ` Nonblocking diagnostic: ${primaryBlocker.message}` : ''}`;
    return (
      <div
        className={`inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md border text-xs font-semibold max-w-full ${
          ready
            ? 'border-success-200 bg-success-50 text-success-700'
            : 'border-warn-200 bg-warn-50 text-warn-800'
        }`}
        title={title}
      >
        <Icon className={`w-3.5 h-3.5 ${!ready && !certificationFailed && !draftGenerated && !needsRepair && !safetyDiagnostic && !needsReacquisition ? 'animate-spin' : ''}`} />
        <span className="shrink-0">{label}</span>
        <PreparationMeter preparation={preparation} compact />
        {primaryBlocker?.message && needsReacquisition && (
          <span className="hidden max-w-[260px] truncate text-[11px] font-medium 2xl:inline text-warn-700">
            {primaryBlocker.message}
          </span>
        )}
        {onRepair && (needsRepair || certificationFailed || needsReacquisition) && !hasAuthPrecondition && (
          <Button
            size="sm"
            variant="secondary"
            onClick={onRepair}
            loading={repairBusy}
            title="Run the output repair agent to recapture missing replay data"
          >
            <Wand2 className="w-3.5 h-3.5" />
            Repair
          </Button>
        )}
      </div>
    );
  }

  if (!summary || !summary.pipelineRan) {
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-warn-200 bg-warn-50 text-warn-800 text-xs font-semibold"
        title="Output files were generated, but no successful script validation report is available."
      >
        <FileCode className="w-3.5 h-3.5" />
        Generated - not validated
      </span>
    );
  }

  const { headline, certified: readyCount, draft, incomplete_evidence: incompleteCount, not_exportable: notExportable, repairing, total } = summary;

  if (headline === 'certified') {
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-warn-200 bg-warn-50 text-warn-800 text-xs font-semibold"
        title={`${readyCount}/${total} legacy result(s) passed the older pipeline, but current package-hash and script-run proof is unavailable.`}
      >
        <FileCode className="w-3.5 h-3.5" />
        Generated - validation pending
      </span>
    );
  }

  if (headline === 'draft') {
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-info-200 bg-info-50 text-info-700 text-xs font-semibold"
        title="Contract validated; waiting for execution output data."
      >
        <Shield className="w-3.5 h-3.5" />
        {draft === total ? 'Draft' : `${draft}/${total} Draft`}
      </span>
    );
  }

  if (headline === 'repairing') {
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-warn-200 bg-warn-50 text-warn-700 text-xs font-semibold"
        title="Evidence repair in progress — probing DOM for missing locators."
      >
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Repairing…
      </span>
    );
  }

  if (headline === 'incomplete_evidence') {
    return (
      <div className="inline-flex items-center gap-1.5">
        <span
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-warn-200 bg-warn-50 text-warn-700 text-xs font-semibold"
          title={`${incompleteCount}/${total} result(s) need QAAI to finish internal replay data. Click Repair Output to recapture what is missing.`}
        >
          <ShieldAlert className="w-3.5 h-3.5" />
          {incompleteCount === total ? 'Preparing' : `${incompleteCount}/${total} Preparing`}
        </span>
        {onRepair && (
          <Button
            size="sm"
            variant="secondary"
            onClick={onRepair}
            loading={repairBusy}
            title="Run the output repair agent to recapture missing replay data"
          >
            <Wand2 className="w-3.5 h-3.5" />
            Repair Output
          </Button>
        )}
      </div>
    );
  }

  if (headline === 'not_exportable') {
    const ready = Math.max(0, Number(total || 0) - Number(notExportable || 0));
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-warn-200 bg-warn-50 text-warn-800 text-xs font-semibold"
        title={`${ready}/${total} output case(s) are ready. ${notExportable} passed case(s) need live reacquisition before they can be exported.`}
      >
        <ShieldAlert className="w-3.5 h-3.5" />
        {notExportable > 0 ? `${notExportable} Need recapture` : 'Output not ready'}
      </span>
    );
  }

  // Fallback
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-warn-200 bg-warn-50 text-warn-800 text-xs font-semibold"
      title="Generated files are available, but current validation proof is unavailable."
    >
      <FileCode className="w-3.5 h-3.5" />
      Generated - status unavailable
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TreeNode — recursive folder/file row. VS Code-shaped: clickable folder
// expand/collapse, file rows highlight on active. Indentation is tight so
// deep nesting stays readable in 300px.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// RunSelector — picks which run's workspace the rest of the page shows.
// Lists project runs newest-first. Each option shows sprint label, date,
// and the run's pass/fail/blocked counts so the user knows what they're
// switching to.
// ─────────────────────────────────────────────────────────────────────────────
function RunSelector({ runs, value, onChange }) {
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }) : '';
  const activityDate = (run) => run?.lastActivityAt || run?.latestResultAt || run?.completedAt || run?.startedAt || null;
  const wasUpdated = (run) => {
    const started = run?.startedAt ? new Date(run.startedAt).getTime() : 0;
    const activity = activityDate(run) ? new Date(activityDate(run)).getTime() : 0;
    return started && activity && activity - started > 60000;
  };
  const displayDate = (run) => {
    const date = fmtDate(activityDate(run));
    return wasUpdated(run) && date ? `Updated ${date}` : date;
  };
  const labelFor = (r) => {
    // Legacy workspace gets its own readable label, not a run-style stamp.
    if (r.id === '__legacy__') return 'Workspace (older outputs)';
    // For real runs: lead with the date, drop the meaningless "Agent run"
    // prefix that the system auto-stamps onto sprintName. If the user gave
    // the sprint a real name, surface that instead of the date.
    const auto = /^agent run\b/i.test(String(r.sprintName || ''));
    const date = displayDate(r);
    if (auto || !r.sprintName) return date || r.id.slice(0, 8);
    return `${r.sprintName} · ${date}`;
  };
  return (
    <label className="inline-flex items-center gap-1.5 text-xs">
      <span className="font-medium text-ink-600 hidden sm:inline">Showing:</span>
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="text-xs font-medium px-2.5 py-1.5 rounded-md border border-ink-200 bg-white text-ink-800 hover:border-ink-300 focus-visible:outline-none focus-visible:shadow-ring max-w-[260px]"
        title="Switch which run's output workspace you're viewing"
      >
        {runs.map((r) => (
          <option key={r.id} value={r.id}>{labelFor(r)}</option>
        ))}
      </select>
    </label>
  );
}

function TreeNode({ node, depth, activePath, onSelectFile, defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen);
  if (!node) return null;

  if (node.type === 'file') {
    const isActive = node.path === activePath;
    const meta = kindMeta(node.kind);
    const Icon = meta.icon;
    return (
      <button
        type="button"
        onClick={() => onSelectFile(node.path)}
        className={`w-full text-left flex items-center gap-1.5 pr-2 py-0.5 hover:bg-ink-100/60 transition-colors ${
          isActive ? 'bg-info-50 text-info-800 font-semibold' : 'text-ink-700'
        }`}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        title={node.path}
      >
        <Icon className={`w-3.5 h-3.5 shrink-0 ${isActive ? 'text-info-700' : meta.cls}`} aria-hidden="true" />
        <span className="truncate text-xs">{node.name}</span>
      </button>
    );
  }

  // Directory
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left flex items-center gap-1 pr-2 py-0.5 hover:bg-ink-100/60 transition-colors text-ink-800"
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        <ChevronRight
          className={`w-3 h-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          aria-hidden="true"
        />
        {open
          ? <FolderOpen className="w-3.5 h-3.5 shrink-0 text-warn-500" aria-hidden="true" />
          : <Folder    className="w-3.5 h-3.5 shrink-0 text-warn-500" aria-hidden="true" />}
        <span className="truncate text-xs font-semibold">{node.name}</span>
      </button>
      {open && (node.children || []).map((c) => (
        <TreeNode
          key={c.path || c.name}
          node={c}
          depth={depth + 1}
          activePath={activePath}
          onSelectFile={onSelectFile}
        />
      ))}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Breadcrumb that walks the active file's path. Each segment is plain text;
// the last segment gets the file-kind icon so the user can tell at a glance
// whether they're looking at a spec / page / config.
// ─────────────────────────────────────────────────────────────────────────────
function FileBreadcrumb({ path, kind }) {
  const segments = (path || '').split('/').filter(Boolean);
  const meta = kindMeta(kind);
  const Icon = meta.icon;
  return (
    <div className="flex flex-1 items-center gap-1 text-xs text-ink-500 min-w-0 truncate">
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        return (
          <React.Fragment key={`${seg}-${i}`}>
            {i > 0 && <ChevronRight className="w-3 h-3 text-ink-300 shrink-0" aria-hidden="true" />}
            <span className={isLast ? `font-semibold text-ink-800 inline-flex items-center gap-1` : ''}>
              {isLast && <Icon className={`w-3.5 h-3.5 ${meta.cls}`} aria-hidden="true" />}
              <span className="truncate">{seg}</span>
            </span>
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CodePreview — syntax-highlighted file content with a gutter showing line
// numbers. Tokenised via the in-house TS highlighter; rendered as styled
// spans so we don't ship Prism / Shiki.
// ─────────────────────────────────────────────────────────────────────────────
function BinaryFilePreview({ file }) {
  const meta = kindMeta(file?.kind);
  const Icon = meta.icon;
  return (
    <div className="flex-1 bg-ink-900 text-white flex items-center justify-center p-8">
      <div className="max-w-md rounded-lg border border-white/15 bg-white/8 px-5 py-4 text-center">
        <Icon className={`w-8 h-8 mx-auto mb-3 ${meta.cls || 'text-white'}`} aria-hidden="true" />
        <div className="text-sm font-semibold">{file?.name || 'Binary file'}</div>
        <p className="mt-2 text-xs leading-relaxed text-white/70">
          {file?.message || 'This file is binary and is included in the generated project package. Use Save to folder, Open in VS Code, or Download .zip to open it with the right desktop application.'}
        </p>
        <div className="mt-3 text-2xs uppercase tracking-wider text-white/45">
          {formatBytes(file?.sizeBytes)}
        </div>
      </div>
    </div>
  );
}

function CodePreview({ content, highlightLine = null }) {
  const codeScrollRef = useRef(null);
  const horizontalRailRef = useRef(null);
  const codeContentRef = useRef(null);
  const [contentWidth, setContentWidth] = useState(1);
  const tokens = useMemo(() => tokenizeTs(content || ''), [content]);
  // Split tokens into lines so we can render a gutter.
  const lines = useMemo(() => {
    const out = [[]];
    for (const t of tokens) {
      const parts = t.text.split('\n');
      parts.forEach((p, i) => {
        if (i > 0) out.push([]);
        if (p) out[out.length - 1].push({ kind: t.kind, text: p });
      });
    }
    return out;
  }, [tokens]);

  useEffect(() => {
    const scrollEl = codeScrollRef.current;
    const contentEl = codeContentRef.current;
    if (!scrollEl || !contentEl) return undefined;
    const updateWidth = () => {
      setContentWidth(Math.max(scrollEl.clientWidth || 1, contentEl.scrollWidth || 1));
    };
    updateWidth();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(updateWidth);
    observer.observe(scrollEl);
    observer.observe(contentEl);
    return () => observer.disconnect();
  }, [content, lines.length]);

  useEffect(() => {
    const lineNo = Number(highlightLine || 0);
    if (!lineNo || !codeScrollRef.current) return undefined;
    const handle = window.requestAnimationFrame(() => {
      const target = codeScrollRef.current?.querySelector(`[data-line-number="${lineNo}"]`);
      target?.scrollIntoView({ block: 'center', inline: 'nearest' });
    });
    return () => window.cancelAnimationFrame(handle);
  }, [highlightLine, content, lines.length]);

  const syncFromCode = () => {
    if (!codeScrollRef.current || !horizontalRailRef.current) return;
    if (horizontalRailRef.current.scrollLeft !== codeScrollRef.current.scrollLeft) {
      horizontalRailRef.current.scrollLeft = codeScrollRef.current.scrollLeft;
    }
  };

  const syncFromRail = () => {
    if (!codeScrollRef.current || !horizontalRailRef.current) return;
    if (codeScrollRef.current.scrollLeft !== horizontalRailRef.current.scrollLeft) {
      codeScrollRef.current.scrollLeft = horizontalRailRef.current.scrollLeft;
    }
  };

  const handleCodeWheel = (event) => {
    const scrollEl = codeScrollRef.current;
    if (!scrollEl) return;
    const horizontalDelta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
    if (!horizontalDelta) return;
    const maxLeft = scrollEl.scrollWidth - scrollEl.clientWidth;
    if (maxLeft <= 0) return;
    const nextLeft = Math.max(0, Math.min(maxLeft, scrollEl.scrollLeft + horizontalDelta));
    if (nextLeft !== scrollEl.scrollLeft) {
      event.preventDefault();
      scrollEl.scrollLeft = nextLeft;
      syncFromCode();
    }
  };

  return (
    <div className="flex-1 min-h-0 bg-ink-900 flex flex-col">
      <div
        ref={codeScrollRef}
        onScroll={syncFromCode}
        onWheel={handleCodeWheel}
        className="qaai-code-scroll flex-1 min-h-0 overflow-auto overscroll-contain bg-ink-900"
      >
        <pre ref={codeContentRef} className="text-[13px] font-mono leading-relaxed py-3 min-w-max">
        <code>
          {lines.map((toks, i) => {
            const lineNo = i + 1;
            const highlighted = Number(highlightLine || 0) === lineNo;
            return (
              <div
              key={i}
              data-line-number={lineNo}
              className={`flex w-max min-w-full hover:bg-white/5 ${highlighted ? 'bg-warn-400/18 ring-1 ring-inset ring-warn-300/50' : ''}`}
            >
              <span className="select-none text-ink-600 text-right pr-3 pl-3 w-12 shrink-0 tabular-nums">
                {lineNo}
              </span>
              <span className="whitespace-pre pr-6">
                {toks.length === 0
                  ? ' '
                  : toks.map((t, j) => (
                      <span key={j} className={TOKEN_CLASSES[t.kind] || TOKEN_CLASSES.plain}>
                        {t.text}
                      </span>
                    ))}
              </span>
            </div>
            );
          })}
        </code>
        </pre>
      </div>
      <div className="shrink-0 border-t border-white/10 bg-ink-950/95 px-3 py-1.5">
        <div
          ref={horizontalRailRef}
          onScroll={syncFromRail}
          className="qaai-code-horizontal-rail h-3 overflow-x-scroll overflow-y-hidden"
          aria-label="Horizontal code scroll"
        >
          <div style={{ width: contentWidth, height: 1 }} />
        </div>
      </div>
    </div>
  );
}
