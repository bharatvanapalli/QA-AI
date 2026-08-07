import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Folder, Trash2, Save, Settings, Users, ChevronDown, ChevronRight, Calendar, Sparkles, CheckCircle2, GitCompare, ArrowRightLeft, GitBranch, Zap, ShieldCheck, KeyRound, Star, ScanLine, Loader2 } from 'lucide-react';
import api, { ApiError } from '../lib/apiClient';
import { useProject } from '../store/project';
import { useToast } from '../lib/useToast';
import { useConfirm } from '../lib/useConfirm';
import useDirtyForm, { useUnsavedChangesWarning } from '../lib/useDirtyForm';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Select from '../components/ui/Select';
import SecretInput from '../components/ui/SecretInput';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';

const SPRINT_LIFECYCLE_OPTIONS = [
  { value: 'planning', label: 'Planning' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived', label: 'Archived' },
];

export default function ProjectSetup() {
  const toast = useToast();
  const { projects, current, switchTo, refresh } = useProject();
  const [creating, setCreating] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState(current?.id || projects[0]?.id || null);

  useEffect(() => {
    if (creating) return;
    setSelectedProjectId((prev) => {
      if (prev && projects.some((p) => p.id === prev)) return prev;
      return current?.id || projects[0]?.id || null;
    });
  }, [creating, current?.id, projects]);

  const selectedProject = projects.find((p) => p.id === selectedProjectId) || projects[0] || null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader
        title="Project Setup"
        subtitle="Configure project identity, execution profile, auth, site atlas, and release cycles"
        showProject={false}
      >
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="w-3.5 h-3.5" />
          New project
        </Button>
      </PageHeader>

      <main className="flex-1 overflow-y-auto bg-[radial-gradient(circle_at_10%_0%,rgba(59,130,246,0.10),transparent_30%),radial-gradient(circle_at_92%_12%,rgba(16,185,129,0.10),transparent_26%),linear-gradient(180deg,#f8fafc,#eef3f8)]">
        <div className="max-w-7xl mx-auto px-6 py-7">
          <div className="grid grid-cols-1 xl:grid-cols-[330px_minmax(0,1fr)] gap-5 items-start">
            <aside className="xl:sticky xl:top-6 space-y-4">
              <ProjectSetupSummary projects={projects} current={current} />
              <ProjectList
                projects={projects}
                currentId={current?.id}
                selectedId={selectedProject?.id}
                onSelect={(id) => { setCreating(false); setSelectedProjectId(id); }}
                onCreate={() => setCreating(true)}
              />
            </aside>

            <section className="min-w-0">
              {creating && (
                <NewProjectCard
                  onCancel={() => setCreating(false)}
                  onCreated={async (proj) => {
                    await refresh();
                    switchTo(proj.id);
                    setSelectedProjectId(proj.id);
                    setCreating(false);
                    toast.success(`Project "${proj.name}" created.`);
                  }}
                />
              )}

              {projects.length === 0 && !creating && (
                <EmptyState
                  icon={Folder}
                  title="No projects yet"
                  message="Create a project to start ingesting requirements, generating test cases, and running real Playwright executions."
                  action={
                    <Button size="sm" onClick={() => setCreating(true)}>
                      <Plus className="w-3.5 h-3.5" />
                      Create project
                    </Button>
                  }
                />
              )}

              {!creating && selectedProject && (
                <ProjectCard
                  key={selectedProject.id}
                  project={selectedProject}
                  isCurrent={current?.id === selectedProject.id}
                  onActivate={() => switchTo(selectedProject.id)}
                  onChanged={refresh}
                />
              )}
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}

function ProjectSetupSummary({ projects, current }) {
  const totalRequirements = projects.reduce((a, p) => a + (p._count?.requirements || 0), 0);
  const totalCases = projects.reduce((a, p) => a + (p._count?.testCases || 0), 0);
  const totalRuns = projects.reduce((a, p) => a + (p._count?.runs || 0), 0);
  return (
    <section className="rounded-3xl border border-white/70 bg-white/80 backdrop-blur-xl shadow-card p-4">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-2xl bg-ink-900 text-white flex items-center justify-center shadow-[0_18px_40px_-24px_rgba(15,23,42,0.9)]">
          <Settings className="w-5 h-5" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-[0.18em] font-bold text-ink-500">Control center</div>
          <h2 className="text-lg font-bold text-ink-900 tracking-tight truncate">
            {current?.name || 'Project setup'}
          </h2>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        <MetricTile label="Projects" value={projects.length} />
        <MetricTile label="Cases" value={totalCases} />
        <MetricTile label="Runs" value={totalRuns} />
      </div>
      <div className="mt-3 rounded-2xl border border-ink-200/60 bg-ink-50/70 px-3 py-2 text-xs text-ink-600 leading-relaxed">
        Configure one project at a time. Advanced sections load only when opened, so setup stays fast and readable.
      </div>
      {totalRequirements > 0 && (
        <div className="mt-2 text-2xs text-ink-500 tabular-nums">
          {totalRequirements} requirement{totalRequirements === 1 ? '' : 's'} available across all projects.
        </div>
      )}
    </section>
  );
}

function MetricTile({ label, value }) {
  return (
    <div className="rounded-2xl border border-ink-200/60 bg-white/70 px-3 py-2">
      <div className="text-lg font-black text-ink-900 tabular-nums leading-none">{value}</div>
      <div className="mt-1 text-[10px] uppercase tracking-[0.14em] font-bold text-ink-400">{label}</div>
    </div>
  );
}

function ProjectList({ projects, currentId, selectedId, onSelect, onCreate }) {
  return (
    <section className="rounded-3xl border border-white/70 bg-white/78 backdrop-blur-xl shadow-card overflow-hidden">
      <div className="px-4 py-3 border-b border-ink-200/60 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-ink-900">Projects</h2>
          <p className="text-xs text-ink-500">{projects.length} configured</p>
        </div>
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex h-9 w-9 items-center justify-center rounded-2xl border border-ink-200/70 bg-white text-ink-700 hover:border-info-300 hover:text-info-700 hover:bg-info-50/40 transition-colors focus-visible:outline-none focus-visible:shadow-ring"
          title="New project"
          aria-label="New project"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
      <div className="p-2 space-y-1.5">
        {projects.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-ink-500">No projects yet.</div>
        ) : projects.map((p) => (
          <ProjectListItem
            key={p.id}
            project={p}
            active={p.id === currentId}
            selected={p.id === selectedId}
            onClick={() => onSelect(p.id)}
          />
        ))}
      </div>
    </section>
  );
}

function ProjectListItem({ project, selected, active, onClick }) {
  const counts = project._count || {};
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? 'true' : undefined}
      className={`w-full text-left rounded-2xl border px-3 py-3 transition-all focus-visible:outline-none focus-visible:shadow-ring ${
        selected
          ? 'border-ink-300 bg-ink-900 text-white shadow-[0_18px_40px_-28px_rgba(15,23,42,0.9)]'
          : 'border-transparent bg-white/55 text-ink-800 hover:bg-white hover:border-ink-200'
      }`}
    >
      <div className="flex items-start gap-2">
        <Folder className={`w-4 h-4 mt-0.5 shrink-0 ${selected ? 'text-white/80' : 'text-ink-500'}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-semibold text-sm truncate">{project.name}</span>
            {active && (
              <span className={`shrink-0 text-[10px] uppercase tracking-[0.12em] font-black px-1.5 py-0.5 rounded ${
                selected ? 'bg-white/15 text-white' : 'bg-success-50 text-success-700'
              }`}>
                Active
              </span>
            )}
          </div>
          <div className={`mt-1 text-[11px] tabular-nums ${selected ? 'text-white/65' : 'text-ink-500'}`}>
            {counts.requirements ?? 0} reqs - {counts.testCases ?? 0} cases - {counts.runs ?? 0} runs
          </div>
          {project.targetUrl && (
            <div className={`mt-1 text-[11px] truncate ${selected ? 'text-white/55' : 'text-ink-400'}`}>
              {project.targetUrl}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

function NewProjectCard({ onCancel, onCreated }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: '',
    environment: 'staging',
    framework: 'playwright-pom',
    targetUrl: '',
  });
  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    if (form.name.trim().length < 2) {
      toast.error('Name must be at least 2 characters.');
      return;
    }
    if (form.targetUrl && !/^https?:\/\/.+/.test(form.targetUrl)) {
      toast.error('Target URL must start with http:// or https://');
      return;
    }
    setBusy(true);
    try {
      const res = await api.post('/projects', form);
      onCreated(res.project);
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Create failed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-[28px] border border-white/70 bg-white/82 backdrop-blur-xl shadow-card overflow-hidden">
      <div className="px-6 py-5 border-b border-ink-200/60 bg-white/72">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-ink-900 text-white">
            <Plus className="w-5 h-5" aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-xl font-black text-ink-900 tracking-tight">New project</h2>
            <p className="text-sm text-ink-500 mt-0.5">Create the workspace that ties requirements, test data, runs, and exports together.</p>
          </div>
        </div>
      </div>
      <div className="p-6 space-y-4">
      <Input label="Name" value={form.name} onChange={(e) => update('name', e.target.value)} placeholder="Checkout Regression Suite" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Select
          label="Environment"
          value={form.environment}
          onChange={(e) => update('environment', e.target.value)}
          options={['staging', 'production', 'dev']}
        />
        <Select
          label="Framework"
          value={form.framework}
          onChange={(e) => update('framework', e.target.value)}
          options={[
            { value: 'playwright-pom', label: 'Playwright + POM (TypeScript)' },
            { value: 'playwright-js', label: 'Playwright + POM (JavaScript)' },
            { value: 'playwright-bdd', label: 'Playwright BDD (Cucumber)' },
            { value: 'selenium-java', label: 'Selenium + TestNG (Java)' },
            { value: 'selenium-bdd', label: 'Selenium BDD (Cucumber + TestNG)' },
          ]}
        />
      </div>
      <Input
        label="Target URL (under test)"
        value={form.targetUrl}
        onChange={(e) => update('targetUrl', e.target.value)}
        placeholder="https://staging.your-app.example.com"
        hint="Playwright runs target this URL by default."
      />
      </div>
      <div className="flex justify-end gap-2 px-6 py-4 border-t border-ink-200/70 bg-ink-50/65">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button onClick={submit} loading={busy}>
          <Plus className="w-3.5 h-3.5" />
          Create project
        </Button>
      </div>
    </div>
  );
}

function ProjectCard({ project, isCurrent, onActivate, onChanged }) {
  const toast = useToast();
  const confirm = useConfirm();
  const f = useDirtyForm({
    name: project.name,
    environment: project.environment,
    framework: project.framework,
    targetUrl: project.targetUrl || '',
    execMode: project.execMode || 'fast',
    vscodeWorkspacePath: project.vscodeWorkspacePath || '',
  });
  useUnsavedChangesWarning(f.isDirty && isCurrent);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const counts = project._count || {};

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await api.put(`/projects/${project.id}`, f.values);
      f.commit();
      await onChanged();
      toast.success('Project updated.');
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }, [project.id, f, toast, onChanged]);

  const remove = useCallback(async () => {
    const ok = await confirm({
      title: `Delete project "${project.name}"?`,
      message: 'All test cases, runs, requirements, and run history will be permanently removed. This cannot be undone.',
      confirmLabel: 'Delete project',
      requireTypedName: project.name,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await api.del(`/projects/${project.id}`);
      await onChanged();
      toast.success('Project deleted.');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setDeleting(false);
    }
  }, [project, toast, onChanged, confirm]);

  return (
    <div className={`rounded-[28px] border bg-white/82 backdrop-blur-xl shadow-card overflow-hidden ${isCurrent ? 'border-ink-300' : 'border-white/70'}`}>
      <div className="px-6 py-5 border-b border-ink-200/60 bg-white/70">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-ink-900 text-white">
                <Folder className="w-4 h-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <h3 className="text-2xl font-black text-ink-900 tracking-tight truncate">{project.name}</h3>
                  {isCurrent && (
                    <span className="shrink-0 text-2xs uppercase tracking-wider font-bold text-success-700 bg-success-50 px-2 py-1 rounded-pill border border-success-200/70">
                      Active
                    </span>
                  )}
                </div>
                <p className="text-sm text-ink-500 mt-0.5 truncate">
                  {project.targetUrl || 'No target URL configured yet'}
                </p>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 lg:justify-end">
            {!isCurrent && (
              <Button size="sm" variant="secondary" onClick={onActivate}>
                <Settings className="w-3.5 h-3.5" />
                Activate
              </Button>
            )}
            <Button size="sm" onClick={save} disabled={!f.isDirty || saving} loading={saving}>
              <Save className="w-3.5 h-3.5" />
              {f.isDirty ? 'Save changes' : 'No changes'}
            </Button>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 md:grid-cols-4 gap-2">
          <ProjectStat label="Requirements" value={counts.requirements ?? 0} />
          <ProjectStat label="Test cases" value={counts.testCases ?? 0} />
          <ProjectStat label="Runs" value={counts.runs ?? 0} />
          <ProjectStat label="Docs" value={counts.documents ?? 0} />
        </div>
      </div>

      <div className="p-6 space-y-5">
        <section className="rounded-3xl border border-ink-200/70 bg-white/70 p-4">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <h4 className="text-sm font-bold text-ink-900">Core settings</h4>
              <p className="text-xs text-ink-500 mt-0.5">These values drive generation, execution, and exported frameworks.</p>
            </div>
            {f.isDirty && (
              <span className="text-2xs uppercase tracking-[0.14em] font-bold text-info-700 bg-info-50 border border-info-200/70 px-2 py-1 rounded-pill">
                Unsaved
              </span>
            )}
          </div>
          <div className="space-y-3">
        <Input
          label="Name"
          value={f.values.name}
          onChange={(e) => f.set('name', e.target.value)}
        />
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Environment"
            value={f.values.environment}
            onChange={(e) => f.set('environment', e.target.value)}
            options={['staging', 'production', 'dev']}
          />
          <Select
            label="Framework"
            value={f.values.framework}
            onChange={(e) => f.set('framework', e.target.value)}
            options={[
              { value: 'playwright-pom', label: 'Playwright + POM (TypeScript)' },
              { value: 'playwright-js', label: 'Playwright + POM (JavaScript)' },
              { value: 'playwright-bdd', label: 'Playwright BDD (Cucumber)' },
              { value: 'selenium-java', label: 'Selenium + TestNG (Java)' },
              { value: 'selenium-bdd', label: 'Selenium BDD (Cucumber + TestNG)' },
            ]}
          />
        </div>
        <Input
          label="Target URL"
          value={f.values.targetUrl}
          onChange={(e) => f.set('targetUrl', e.target.value)}
          placeholder="https://staging.example.com"
        />
        <Input
          label="VS Code workspace folder"
          value={f.values.vscodeWorkspacePath}
          onChange={(e) => f.set('vscodeWorkspacePath', e.target.value)}
          placeholder={'C:\\QA_Projects\\' + (project.name || 'MyApp').replace(/[^a-zA-Z0-9_-]+/g, '')}
          hint="Absolute folder on your machine. 'Open in VS Code' (Output Files) copies the generated suite here and opens it. Leave blank to be prompted on first use."
        />
        <ExecModeToggle
          value={f.values.execMode}
          onChange={(next) => f.set('execMode', next)}
        />
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h4 className="text-sm font-bold text-ink-900">Advanced setup</h4>
              <p className="text-xs text-ink-500 mt-0.5">Open only the parts this project needs.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3">
            <TestUsersEditor projectId={project.id} />
            <AuthFixturesPanel projectId={project.id} />
            <CalibratorPanel projectId={project.id} />
            <GitRepoEditor projectId={project.id} />
            <BrowserContextEditor projectId={project.id} />
            <KnownPopupsEditor projectId={project.id} />
            <SprintsEditor projectId={project.id} isCurrent={isCurrent} />
          </div>
        </section>
      </div>
      <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-ink-200/70 bg-ink-50/65">
        <Button variant="ghost" size="sm" onClick={remove} loading={deleting} className="text-danger-600">
          <Trash2 className="w-3.5 h-3.5" />
          Delete
        </Button>
        <Button size="sm" onClick={save} disabled={!f.isDirty || saving} loading={saving}>
          <Save className="w-3.5 h-3.5" />
          {f.isDirty ? 'Save changes' : 'No changes'}
        </Button>
      </div>
    </div>
  );
}

// Phase F — Fast vs Thorough toggle. Drives the Conductor profile:
//   Fast:     12 turns/case, 1 attempt, no Supervisor finalise, Critic-on-error
//   Thorough: 22 turns/case, 2 attempts + Supervisor finalise, Critic every 5
// Defaults to Fast for new projects. Flip to Thorough for release-gate runs.
function ProjectStat({ label, value }) {
  return (
    <div className="rounded-2xl border border-ink-200/60 bg-white/75 px-3 py-2.5">
      <div className="text-xl font-black text-ink-900 tabular-nums leading-none">{value}</div>
      <div className="mt-1 text-[10px] uppercase tracking-[0.14em] font-bold text-ink-400">{label}</div>
    </div>
  );
}

function ExecModeToggle({ value, onChange }) {
  const v = value === 'thorough' ? 'thorough' : 'fast';
  const opts = [
    {
      key: 'fast',
      icon: Zap,
      label: 'Fast',
      tagline: 'Daily iteration — cheap, quick verdict',
      meta: '12 turns · 1 attempt · ~70% cheaper',
    },
    {
      key: 'thorough',
      icon: ShieldCheck,
      label: 'Thorough',
      tagline: 'Release-gate — full Critic + Supervisor passes',
      meta: '22 turns · 2 attempts + Supervisor',
    },
  ];
  return (
    <div>
      <label className="block text-xs font-medium text-ink-700 mb-1.5">Execution mode</label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {opts.map((opt) => {
          const Icon = opt.icon;
          const active = v === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => onChange(opt.key)}
              aria-pressed={active}
              className={`text-left rounded-lg border px-3 py-2.5 transition-all ${
                active
                  ? (opt.key === 'thorough'
                      ? 'border-accent-400 bg-accent-50/40 ring-1 ring-accent-300'
                      : 'border-info-400 bg-info-50/40 ring-1 ring-info-300')
                  : 'border-ink-200 bg-white hover:border-ink-300'
              }`}
            >
              <div className="flex items-center gap-2">
                <div className={`w-7 h-7 rounded-md flex items-center justify-center ${
                  opt.key === 'thorough'
                    ? (active ? 'bg-accent-600 text-white' : 'bg-ink-100 text-ink-500')
                    : (active ? 'bg-info-600 text-white' : 'bg-ink-100 text-ink-500')
                }`}>
                  <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                </div>
                <span className="text-sm font-semibold text-ink-900">{opt.label}</span>
              </div>
              <p className="text-[11px] text-ink-600 mt-1.5 leading-snug">{opt.tagline}</p>
              <p className="text-[11px] text-ink-500 mt-0.5 font-mono">{opt.meta}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Shared header for EVERY collapsible Project Setup section. Renders the
// chevron + icon + title + optional status badge on line one, and — the point
// of this component — an ALWAYS-VISIBLE one-line grey description on line two,
// so an operator understands what each feature does without expanding it.
// Previously each section hid its explanation inside the body, so collapsed
// (the default) the panels were bare titles; the two newest features (Auth
// Fixtures, Site Calibration) had also drifted into a different card style.
// One component → one consistent look + standing context across all sections.
function SectionToggle({ open, onToggle, icon: Icon, title, description, badge = null }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="w-full text-left group rounded-xl focus-visible:outline-none focus-visible:shadow-ring"
    >
      <span className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-9 w-9 items-center justify-center rounded-xl border border-ink-200/70 bg-white text-ink-600 group-hover:text-ink-900 group-hover:border-ink-300 transition-colors">
          <Icon className="w-4 h-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-bold text-ink-800 group-hover:text-ink-950">
            <span>{title}</span>
            {badge}
          </span>
          {description && (
            <span className="block text-xs text-ink-500 leading-relaxed mt-0.5">{description}</span>
          )}
        </span>
        <span className="mt-1 inline-flex h-7 w-7 items-center justify-center rounded-lg bg-ink-100/70 text-ink-500 group-hover:bg-ink-200/70 transition-colors">
          {open ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
        </span>
      </span>
    </button>
  );
}

// Test users the Conductor is authorised to log in as for this project.
// Without this list, the agent must abort login-required cases with
// "BLOCKED: no credentials provided" rather than fabricating an account
// (the #1 source of agent loops — see Phase D in BUILD_PLAN.md).
function TestUsersEditor({ projectId }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [users, setUsers] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/projects/${projectId}`);
      let raw = res.project?.testCredentials;
      let parsed = [];
      if (typeof raw === 'string' && raw.trim()) {
        try { parsed = JSON.parse(raw); } catch (_) { parsed = []; }
      } else if (Array.isArray(raw)) {
        parsed = raw;
      }
      setUsers(Array.isArray(parsed) ? parsed.map((u) => ({
        name: u.name || '',
        email: u.email || '',
        password: u.password || '',
        notes: u.notes || '',
      })) : []);
      setLoaded(true);
      setDirty(false);
    } catch (err) {
      toast.error(err.message || 'Failed to load test users.');
    } finally {
      setLoading(false);
    }
  }, [projectId, toast]);

  useEffect(() => {
    if (open && !loaded) load();
  }, [open, loaded, load]);

  const update = (i, key, val) => {
    setUsers((arr) => arr.map((u, idx) => (idx === i ? { ...u, [key]: val } : u)));
    setDirty(true);
  };
  const add = () => {
    setUsers((arr) => [...arr, { name: '', email: '', password: '', notes: '' }]);
    setDirty(true);
  };
  const remove = (i) => {
    setUsers((arr) => arr.filter((_, idx) => idx !== i));
    setDirty(true);
  };

  const save = async () => {
    for (const u of users) {
      if (!u.email.trim() || !u.password) {
        toast.error('Each test user needs at least an email and password.');
        return;
      }
    }
    setSaving(true);
    try {
      const res = await api.put(`/projects/${projectId}/credentials`, {
        testCredentials: users.map((u) => ({
          name: u.name.trim() || undefined,
          email: u.email.trim(),
          password: u.password,
          notes: u.notes.trim() || undefined,
        })),
      });
      const returned = Array.isArray(res.project?.testCredentials) ? res.project.testCredentials : [];
      setUsers(returned.map((u) => ({
        name: u.name || '',
        email: u.email || '',
        password: u.password || '',
        notes: u.notes || '',
      })));
      setDirty(false);
      toast.success(`Saved ${returned.length} test user${returned.length === 1 ? '' : 's'}.`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl border border-ink-200/70 bg-white/68 p-3 shadow-[0_10px_28px_-24px_rgba(15,23,42,0.45)]">
      <SectionToggle
        open={open}
        onToggle={() => setOpen((v) => !v)}
        icon={Users}
        title="Test users"
        description="Accounts the AI may log in as on this site. Leave empty and login-required cases are cleanly blocked — never run with invented credentials."
        badge={loaded && users.length > 0 ? (
          <span className="text-2xs uppercase tracking-wider font-bold text-ink-500 bg-ink-100 px-1.5 py-0.5 rounded">
            {users.length}
          </span>
        ) : null}
      />
      {open && (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-ink-500">
            Accounts the AI is authorised to log in as on this project. Leave empty for sites without login.
            When empty, the agent will abort login-required cases with "BLOCKED: no credentials provided"
            rather than fabricating accounts.
          </p>
          {loading && <div className="text-xs text-ink-500">Loading…</div>}
          {!loading && users.length === 0 && (
            <div className="text-xs text-ink-400 italic">No test users configured.</div>
          )}
          {users.map((u, i) => (
            <div key={i} className="rounded border border-ink-200 bg-ink-50 p-3 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <Input
                  label="Label (optional)"
                  value={u.name}
                  onChange={(e) => update(i, 'name', e.target.value)}
                  placeholder="admin / buyer / etc."
                />
                <Input
                  label="Email"
                  value={u.email}
                  onChange={(e) => update(i, 'email', e.target.value)}
                  placeholder="user@example.com"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <SecretInput
                  label="Password"
                  value={u.password}
                  onChange={(e) => update(i, 'password', e.target.value)}
                />
                <Input
                  label="Notes (optional)"
                  value={u.notes}
                  onChange={(e) => update(i, 'notes', e.target.value)}
                  placeholder="full admin role, MFA disabled, …"
                />
              </div>
              <div className="flex justify-end">
                <Button variant="ghost" size="sm" onClick={() => remove(i)} className="text-danger-600">
                  <Trash2 className="w-3 h-3" />
                  Remove
                </Button>
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between pt-2">
            <Button variant="secondary" size="sm" onClick={add}>
              <Plus className="w-3 h-3" />
              Add user
            </Button>
            <Button size="sm" onClick={save} disabled={!dirty || saving} loading={saving}>
              <Save className="w-3 h-3" />
              Save test users
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// E2 — Auth fixtures. Pre-captured Playwright storageState for SSO injection.
// Users run a one-time manual auth recording and paste the JSON here.
// When a default fixture is set, the Conductor injects it at session start.
function AuthFixturesPanel({ projectId }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [fixtures, setFixtures] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [defaultId, setDefaultId] = useState(null);
  const [form, setForm] = useState({ name: '', environment: 'default', notes: '', validUntil: '', storageState: '' });
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [fixtureRes, projectRes] = await Promise.all([
        api.get(`/projects/${projectId}/auth-fixtures`),
        api.get(`/projects/${projectId}`),
      ]);
      setFixtures(Array.isArray(fixtureRes) ? fixtureRes : []);
      setDefaultId(projectRes.project?.defaultAuthFixtureId || null);
    } catch (err) {
      toast.error(err.message || 'Failed to load auth fixtures.');
    } finally {
      setLoading(false);
    }
  }, [projectId, toast]);

  useEffect(() => { if (open) load(); }, [open, load]);

  const handleAdd = async () => {
    if (!form.name.trim()) return toast.error('Name is required.');
    if (!form.storageState.trim()) return toast.error('StorageState JSON is required.');
    try { JSON.parse(form.storageState); } catch { return toast.error('StorageState must be valid JSON.'); }
    setSaving(true);
    try {
      await api.post(`/projects/${projectId}/auth-fixtures`, {
        name: form.name.trim(),
        storageState: form.storageState.trim(),
        environment: form.environment || 'default',
        notes: form.notes || undefined,
        validUntil: form.validUntil || undefined,
      });
      setForm({ name: '', environment: 'default', notes: '', validUntil: '', storageState: '' });
      setShowAdd(false);
      await load();
      toast.success('Auth fixture saved.');
    } catch (err) {
      toast.error(err.message || 'Failed to save fixture.');
    } finally {
      setSaving(false);
    }
  };

  const handleSetDefault = async (fixtureId) => {
    const newId = fixtureId === defaultId ? null : fixtureId;
    try {
      await api.put(`/projects/${projectId}/default-auth-fixture`, { fixtureId: newId });
      setDefaultId(newId);
      toast.success(newId ? 'Default fixture set.' : 'Default fixture cleared.');
    } catch (err) {
      toast.error(err.message || 'Failed to update default.');
    }
  };

  const handleDelete = async (fixtureId, name) => {
    const ok = await confirm({
      title: `Delete auth fixture "${name}"?`,
      message: 'This removes the saved storageState from this project. Login-gated cases that rely on it may need credentials or a new fixture.',
      confirmLabel: 'Delete fixture',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await api.del(`/projects/${projectId}/auth-fixtures/${fixtureId}`);
      if (defaultId === fixtureId) {
        await api.put(`/projects/${projectId}/default-auth-fixture`, { fixtureId: null });
        setDefaultId(null);
      }
      await load();
      toast.success('Fixture deleted.');
    } catch (err) {
      toast.error(err.message || 'Failed to delete fixture.');
    }
  };

  return (
    <div className="rounded-2xl border border-ink-200/70 bg-white/68 p-3 shadow-[0_10px_28px_-24px_rgba(15,23,42,0.45)]">
      <SectionToggle
        open={open}
        onToggle={() => setOpen((p) => !p)}
        icon={KeyRound}
        title="Auth Fixtures"
        description="Pre-captured SSO / OAuth sessions so login-gated cases start already signed in — the identity provider is never navigated at run time."
        badge={fixtures.length > 0 ? (
          <span className="ml-1 text-2xs uppercase tracking-wider font-bold text-accent-700 bg-accent-50 px-1.5 py-0.5 rounded">{fixtures.length} saved</span>
        ) : null}
      />

      {open && (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-ink-500 leading-relaxed">
            Pre-captured Playwright <code className="font-mono bg-ink-100 px-1 rounded">storageState</code> for SSO / OAuth flows.
            When a default fixture is set, the Conductor injects it at browser context start — the identity provider is never navigated.
            Capture a fixture by running <code className="font-mono bg-ink-100 px-1 rounded">context.storageState(&#123; path: 'fixture.json' &#125;)</code> in a Playwright script after manual login.
          </p>

          {loading && <p className="text-xs text-ink-400">Loading…</p>}

          {!loading && fixtures.length > 0 && (
            <div className="space-y-2">
              {fixtures.map((fx) => (
                <div key={fx.id} className={`flex items-center justify-between px-3 py-2 rounded-md border ${fx.id === defaultId ? 'border-accent-300 bg-accent-50' : 'border-ink-200 bg-ink-50'}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-ink-800 truncate">{fx.name}</span>
                      {fx.id === defaultId && (
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-accent-600 bg-accent-100 px-1.5 py-0.5 rounded">Default</span>
                      )}
                      <span className="text-xs text-ink-500">{fx.environment}</span>
                    </div>
                    {fx.notes && <p className="text-xs text-ink-400 truncate mt-0.5">{fx.notes}</p>}
                    {fx.validUntil && (
                      <p className="text-xs text-warn-600 mt-0.5">Expires {new Date(fx.validUntil).toLocaleDateString()}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 ml-2 shrink-0">
                    <button
                      title={fx.id === defaultId ? 'Clear default' : 'Set as default'}
                      onClick={() => handleSetDefault(fx.id)}
                      className={`p-1.5 rounded hover:bg-ink-200 transition-colors ${fx.id === defaultId ? 'text-accent-600' : 'text-ink-400'}`}
                    >
                      <Star className="w-3.5 h-3.5" fill={fx.id === defaultId ? 'currentColor' : 'none'} />
                    </button>
                    <button
                      title="Delete"
                      onClick={() => handleDelete(fx.id, fx.name)}
                      className="p-1.5 rounded hover:bg-danger-100 text-ink-400 hover:text-danger-600 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && fixtures.length === 0 && !showAdd && (
            <p className="text-xs text-ink-400">No auth fixtures saved yet.</p>
          )}

          {showAdd ? (
            <div className="space-y-2 p-3 rounded-md border border-ink-200 bg-ink-50">
              <div className="grid grid-cols-2 gap-2">
                <Input
                  label="Name"
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="admin_sso"
                  size="sm"
                />
                <Input
                  label="Environment"
                  value={form.environment}
                  onChange={(e) => setForm((p) => ({ ...p, environment: e.target.value }))}
                  placeholder="default"
                  size="sm"
                />
              </div>
              <Input
                label="Notes (optional)"
                value={form.notes}
                onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
                placeholder="Admin user with full access"
                size="sm"
              />
              <Input
                label="Expires (optional)"
                type="datetime-local"
                value={form.validUntil}
                onChange={(e) => setForm((p) => ({ ...p, validUntil: e.target.value }))}
                size="sm"
              />
              <div>
                <label className="block text-xs font-medium text-ink-700 mb-1">
                  StorageState JSON <span className="text-ink-400">(from context.storageState())</span>
                </label>
                <textarea
                  className="w-full text-xs font-mono bg-white border border-ink-300 rounded-md px-2 py-1.5 h-24 resize-none focus:outline-none focus:ring-1 focus:ring-accent-400"
                  value={form.storageState}
                  onChange={(e) => setForm((p) => ({ ...p, storageState: e.target.value }))}
                  placeholder='{"cookies": [...], "origins": [...]}'
                />
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="ghost" size="sm" onClick={() => { setShowAdd(false); setForm({ name: '', environment: 'default', notes: '', validUntil: '', storageState: '' }); }}>
                  Cancel
                </Button>
                <Button size="sm" onClick={handleAdd} loading={saving}>
                  Save Fixture
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setShowAdd(true)} className="w-full">
              <Plus className="w-3.5 h-3.5" />
              Add Auth Fixture
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// E4 — Calibrator. Pre-run site crawl that maps pages and verified selectors.
// The Architect reads the resulting site atlas when generating scenarios;
// the Conductor uses pre-verified selectors before the healer fires.
function CalibratorPanel({ projectId }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [calibrations, setCalibrations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [startUrl, setStartUrl] = useState('');
  const [modulePreview, setModulePreview] = useState(null);
  const [authProfiles, setAuthProfiles] = useState([]);
  const [selectedModuleKey, setSelectedModuleKey] = useState('');
  const [selectedAuthProfileId, setSelectedAuthProfileId] = useState('');
  const [hasCreds, setHasCreds] = useState(true); // optimistic — warn only when confirmed absent

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [calData, moduleData, authData, projData] = await Promise.all([
        api.get(`/projects/${projectId}/calibrations`).catch(() => []),
        api.get(`/projects/${projectId}/modules/preview`).catch(() => null),
        api.get(`/projects/${projectId}/auth-profiles`).catch(() => null),
        api.get(`/projects/${projectId}`).catch(() => null),
      ]);
      setCalibrations(Array.isArray(calData) ? calData : []);
      setModulePreview(moduleData || null);
      setAuthProfiles(Array.isArray(authData?.authProfiles) ? authData.authProfiles : []);
      // Determine whether any login credentials are available so we can warn
      // the user before they run a crawl that will only map the login page.
      const p = projData?.project || projData;
      const hasFixture = !!(p?.defaultAuthFixtureId);
      let hasTestCreds = false;
      try {
        const tc = JSON.parse(p?.testCredentials || '[]');
        hasTestCreds = Array.isArray(tc) && tc.some((c) => c && (c.email || c.name) && c.password);
      } catch { hasTestCreds = false; }
      setHasCreds(hasFixture || hasTestCreds);
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { if (open) load(); }, [open, load]);

  const handleCalibrate = async () => {
    setRunning(true);
    try {
      const body = {};
      if (startUrl) body.startUrl = startUrl;
      if (selectedModuleKey) body.module = selectedModuleKey;
      if (selectedAuthProfileId) body.authProfileId = selectedAuthProfileId;
      await api.post(`/projects/${projectId}/calibrations`, body);
      toast.success('Calibration started. Pages will appear as they are mapped.');
      await load();
    } catch (err) {
      toast.error(err.message || 'Failed to start calibration.');
    } finally {
      setRunning(false);
    }
  };

  const handleDelete = async (id) => {
    const ok = await confirm({
      title: 'Delete this calibration?',
      message: 'The saved site atlas for this calibration will be removed. Future generation can still run, but it may lose this grounding evidence until you calibrate again.',
      confirmLabel: 'Delete calibration',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await api.del(`/projects/${projectId}/calibrations/${id}`);
      await load();
    } catch (err) {
      toast.error(err.message || 'Failed to delete.');
    }
  };

  const latest = calibrations[0];
  const detectedModules = modulePreview?.preview?.modules || [];
  const selectedModule = detectedModules.find((m) => m.key === selectedModuleKey) || null;
  const selectedAuthProfile = authProfiles.find((p) => p.id === selectedAuthProfileId) || null;

  return (
    <div className="rounded-2xl border border-ink-200/70 bg-white/68 p-3 shadow-[0_10px_28px_-24px_rgba(15,23,42,0.45)]">
      <SectionToggle
        open={open}
        onToggle={() => setOpen((p) => !p)}
        icon={ScanLine}
        title="Site Calibration"
        description="Crawl the live site once so the AI authors steps against the app's real labels and selectors — fewer hallucinated assertions and blocked cases."
        badge={
          latest?.status === 'complete' ? (
            <span className="ml-1 text-2xs uppercase tracking-wider font-bold text-success-700 bg-success-50 px-1.5 py-0.5 rounded">{latest.pagesCount} pages</span>
          ) : latest?.status === 'running' ? (
            <span className="ml-1 text-2xs uppercase tracking-wider font-bold text-info-700 bg-info-50 px-1.5 py-0.5 rounded inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> running</span>
          ) : null
        }
      />

      {open && (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-ink-500 leading-relaxed">
            Crawl the site before generating scenarios. The Architect reads the site atlas to generate accurate step descriptions.
            The Conductor uses pre-verified selectors to reduce blocked cases.
          </p>

          {loading && <p className="text-xs text-ink-400">Loading…</p>}

          {!loading && calibrations.length > 0 && (
            <div className="space-y-1.5">
              {calibrations.slice(0, 3).map((c) => (
                <div key={c.id} className={`flex items-center justify-between px-3 py-2 rounded-md border ${
                  c.status === 'complete' ? 'border-success-200 bg-success-50' :
                  c.status === 'running' ? 'border-info-200 bg-info-50' :
                  'border-danger-200 bg-danger-50'
                }`}>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-semibold capitalize ${
                        c.status === 'complete' ? 'text-success-700' :
                        c.status === 'running' ? 'text-info-700' : 'text-danger-700'
                      }`}>{c.status}</span>
                      {c.pagesCount > 0 && <span className="text-xs text-ink-500">{c.pagesCount} pages</span>}
                      {c.module && <span className="text-[10px] font-bold uppercase tracking-wider text-info-700 bg-white/70 px-1.5 py-0.5 rounded">{c.module}</span>}
                      {c.version && <span className="text-[10px] text-ink-400">v{c.version}</span>}
                    </div>
                    <p className="text-xs text-ink-400 truncate max-w-xs mt-0.5">{c.startUrl}</p>
                    {c.authProfileId && (
                      <p className="text-[10px] text-ink-500 mt-0.5">
                        Auth profile: {authProfiles.find((p) => p.id === c.authProfileId)?.name || c.authProfileId}
                      </p>
                    )}
                    <p className="text-[10px] text-ink-400">{new Date(c.createdAt).toLocaleString()}</p>
                    {c.errorMessage && <p className="text-[10px] text-danger-600 mt-0.5">{c.errorMessage}</p>}
                  </div>
                  <button
                    onClick={() => handleDelete(c.id)}
                    className="p-1.5 rounded hover:bg-ink-200 text-ink-400 hover:text-danger-600 transition-colors shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="text-[10px] uppercase tracking-wider font-bold text-ink-500">Module scope</span>
              <select
                value={selectedModuleKey}
                onChange={(e) => setSelectedModuleKey(e.target.value)}
                className="w-full text-xs border border-ink-300 rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-info-400 bg-white"
              >
                <option value="">Whole project</option>
                {detectedModules.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.name} ({m.requirements?.count || 0} reqs, {m.testData?.sheetCount || 0} sheets)
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[10px] uppercase tracking-wider font-bold text-ink-500">Auth profile</span>
              <select
                value={selectedAuthProfileId}
                onChange={(e) => setSelectedAuthProfileId(e.target.value)}
                className="w-full text-xs border border-ink-300 rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-info-400 bg-white"
              >
                <option value="">Default / role-agnostic</option>
                {authProfiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} ({p.disposition})</option>
                ))}
              </select>
            </label>
          </div>

          {(selectedModule || selectedAuthProfile) && (
            <div className="rounded-md border border-info-200 bg-info-50 px-3 py-2 text-xs text-info-800 leading-relaxed">
              Crawl scope: <strong>{selectedModule?.name || 'Whole project'}</strong>
              {selectedAuthProfile ? <> as <strong>{selectedAuthProfile.name}</strong></> : <> with the default identity</>}.
              {selectedModule?.atlas?.currentSliceCount ? ` Existing current atlas slices: ${selectedModule.atlas.currentSliceCount}.` : ''}
            </div>
          )}

          {!hasCreds && (
            <div className="rounded-md border border-warn-300 bg-warn-50 px-3 py-2 text-xs text-warn-800 leading-relaxed">
              <strong>No login credentials configured.</strong> If this site requires authentication, the crawler will only map the login page.
              Add credentials in the <strong>Test Credentials</strong> section above, then calibrate.
            </div>
          )}

          <div className="flex gap-2">
            <input
              type="url"
              className="flex-1 text-xs border border-ink-300 rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-info-400 bg-white"
              placeholder="Start URL (uses project URL if empty)"
              value={startUrl}
              onChange={(e) => setStartUrl(e.target.value)}
            />
            <Button size="sm" onClick={handleCalibrate} loading={running}>
              {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ScanLine className="w-3.5 h-3.5" />}
              Calibrate
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// Git repository (Phase E3). Connect this project to a GitHub repo + PAT
// so the Diff Analyzer can fetch changed files for a PR/branch and feed
// them into the Architect's priorContext.
function GitRepoEditor({ projectId }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState({ repoUrl: '', defaultBranch: '', gitProvider: 'github' });
  const [patLastFour, setPatLastFour] = useState(null);
  const [patValue, setPatValue] = useState('');
  const [patDirty, setPatDirty] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/projects/${projectId}/repo`);
      setForm({
        repoUrl: res.project?.repoUrl || '',
        defaultBranch: res.project?.defaultBranch || '',
        gitProvider: res.project?.gitProvider || 'github',
      });
      setPatLastFour(res.pat?.lastFour || null);
      setPatValue('');
      setPatDirty(false);
      setDirty(false);
      setLoaded(true);
    } catch (err) {
      toast.error(err.message || 'Failed to load repository settings.');
    } finally {
      setLoading(false);
    }
  }, [projectId, toast]);

  useEffect(() => {
    if (open && !loaded) load();
  }, [open, loaded, load]);

  const updateField = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const body = { ...form };
      if (patDirty) body.pat = patValue;
      const res = await api.put(`/projects/${projectId}/repo`, body);
      setForm({
        repoUrl: res.project?.repoUrl || '',
        defaultBranch: res.project?.defaultBranch || '',
        gitProvider: res.project?.gitProvider || 'github',
      });
      setPatLastFour(res.pat?.lastFour || null);
      setPatValue('');
      setPatDirty(false);
      setDirty(false);
      toast.success('Repository settings saved.');
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl border border-ink-200/70 bg-white/68 p-3 shadow-[0_10px_28px_-24px_rgba(15,23,42,0.45)]">
      <SectionToggle
        open={open}
        onToggle={() => setOpen((v) => !v)}
        icon={GitBranch}
        title="Git repository"
        description="Link the source repo so the AI reads PR diffs and prioritises scenarios against what actually changed. PAT stored encrypted."
        badge={loaded && form.repoUrl ? (
          <span className="text-2xs uppercase tracking-wider font-bold text-info-700 bg-info-50 px-1.5 py-0.5 rounded">
            connected
          </span>
        ) : null}
      />
      {open && (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-ink-500">
            Connect this project to its source repo so the AI can read PR diffs and prioritise scenarios against
            what actually changed. PAT needs <code className="text-2xs font-mono">repo</code> scope
            (or <code className="text-2xs font-mono">public_repo</code> for public repos). Stored encrypted; only the last 4 chars are ever shown.
          </p>
          {loading && <div className="text-xs text-ink-500">Loading…</div>}
          {!loading && (
            <div className="space-y-3">
              <Input
                label="Repository URL"
                value={form.repoUrl}
                onChange={(e) => updateField('repoUrl', e.target.value)}
                placeholder="https://github.com/org/repo or git@github.com:org/repo.git"
              />
              <div className="grid grid-cols-2 gap-2">
                <Input
                  label="Default branch"
                  value={form.defaultBranch}
                  onChange={(e) => updateField('defaultBranch', e.target.value)}
                  placeholder="main"
                />
                <Select
                  label="Provider"
                  value={form.gitProvider}
                  onChange={(e) => updateField('gitProvider', e.target.value)}
                  options={[{ value: 'github', label: 'GitHub' }]}
                />
              </div>
              <SecretInput
                label="Personal Access Token"
                value={patValue}
                onChange={(e) => { setPatValue(e.target.value); setPatDirty(true); }}
                placeholder={patLastFour ? `••••${patLastFour}` : 'ghp_…'}
              />
              {patLastFour && !patDirty && (
                <div className="text-2xs text-ink-500">
                  A PAT ending in <code className="font-mono">{patLastFour}</code> is stored. Type a new value to replace it,
                  or clear the field and Save to remove it.
                </div>
              )}
              <div className="flex justify-end pt-1">
                <Button size="sm" onClick={save} disabled={!dirty && !patDirty} loading={saving}>
                  <Save className="w-3 h-3" />
                  Save repository
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Phase E10.5 — Browser context configuration. Surfaces every per-project
// browser-context knob the MCP session honours: viewport, device, locale,
// user-agent, color-scheme, permissions, geolocation, http credentials,
// extra headers, ignore-https-errors, proxy, auto-accept dialogs. All
// fields optional — empty means "use MCP defaults".
//
// Closed by default. Most projects don't need any of this; teams testing
// auth-gated apps, geo-aware features, or mobile UAs open it once and
// configure for the project's lifetime.
function BrowserContextEditor({ projectId }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [form, setForm] = useState({
    contextViewport: '', contextDevice: '', contextLocale: '',
    contextUserAgent: '', contextColorScheme: '', contextPermissions: '',
    contextGeolocation: '', contextHttpCredentials: '', contextExtraHeaders: '',
    contextIgnoreHttpsErrors: false, contextProxyServer: '', contextProxyBypass: '',
    autoAcceptDialogs: true,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/projects/${projectId}/browser-context`);
      const c = res.context || {};
      setForm({
        contextViewport: c.contextViewport || '',
        contextDevice: c.contextDevice || '',
        contextLocale: c.contextLocale || '',
        contextUserAgent: c.contextUserAgent || '',
        contextColorScheme: c.contextColorScheme || '',
        contextPermissions: c.contextPermissions || '',
        contextGeolocation: c.contextGeolocation || '',
        contextHttpCredentials: c.contextHttpCredentials || '',
        contextExtraHeaders: c.contextExtraHeaders || '',
        contextIgnoreHttpsErrors: !!c.contextIgnoreHttpsErrors,
        contextProxyServer: c.contextProxyServer || '',
        contextProxyBypass: c.contextProxyBypass || '',
        autoAcceptDialogs: c.autoAcceptDialogs !== false,
      });
      setDirty(false);
      setLoaded(true);
    } catch (err) {
      toast.error(err.message || 'Failed to load browser context.');
    } finally {
      setLoading(false);
    }
  }, [projectId, toast]);

  useEffect(() => { if (open && !loaded) load(); }, [open, loaded, load]);

  const updateField = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }));
    setDirty(true);
  };

  const save = async () => {
    // Soft client-side JSON validation so the user gets a clear toast
    // instead of a silent MCP boot warning at run time.
    const JSON_FIELDS = ['contextViewport', 'contextPermissions', 'contextGeolocation', 'contextHttpCredentials', 'contextExtraHeaders'];
    for (const k of JSON_FIELDS) {
      const v = form[k];
      if (v && typeof v === 'string') {
        try { JSON.parse(v); } catch (_) {
          toast.error(`${k} must be valid JSON.`);
          return;
        }
      }
    }
    setSaving(true);
    try {
      const res = await api.put(`/projects/${projectId}/browser-context`, form);
      const c = res.context || {};
      setForm((f) => ({ ...f, ...c }));
      setDirty(false);
      toast.success('Browser context saved. Takes effect on the next run.');
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  const isActive = loaded && (
    form.contextViewport || form.contextDevice || form.contextLocale
    || form.contextUserAgent || form.contextColorScheme || form.contextPermissions
    || form.contextGeolocation || form.contextHttpCredentials || form.contextExtraHeaders
    || form.contextIgnoreHttpsErrors || form.contextProxyServer || !form.autoAcceptDialogs
  );

  return (
    <div className="rounded-2xl border border-ink-200/70 bg-white/68 p-3 shadow-[0_10px_28px_-24px_rgba(15,23,42,0.45)]">
      <SectionToggle
        open={open}
        onToggle={() => setOpen((v) => !v)}
        icon={Settings}
        title="Browser context"
        description="Per-project browser settings applied to every session — custom user agent, locale, viewport/device, geolocation, or HTTP credentials."
        badge={isActive ? (
          <span className="text-2xs uppercase tracking-wider font-bold text-accent-700 bg-accent-50 px-1.5 py-0.5 rounded">
            configured
          </span>
        ) : null}
      />
      {open && (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-ink-500">
            Per-project browser configuration applied to every MCP session. Use it to test against authenticated APIs,
            geo-gated features, mobile devices, locale-sensitive UI, or sites that need a custom user agent. Leave
            fields empty for defaults.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <FieldRow label="Viewport (JSON)" hint='e.g. {"width":1920,"height":1080}'>
              <input
                type="text"
                value={form.contextViewport}
                onChange={(e) => updateField('contextViewport', e.target.value)}
                placeholder='{"width":1280,"height":720}'
                className="w-full px-2 py-1.5 text-xs font-mono border border-ink-200 rounded focus:outline-none focus:ring-1 focus:ring-info-400"
              />
            </FieldRow>
            <FieldRow label="Device emulation" hint='e.g. "iPhone 15"'>
              <input
                type="text"
                value={form.contextDevice}
                onChange={(e) => updateField('contextDevice', e.target.value)}
                placeholder="iPhone 15"
                className="w-full px-2 py-1.5 text-xs font-mono border border-ink-200 rounded focus:outline-none focus:ring-1 focus:ring-info-400"
              />
            </FieldRow>
            <FieldRow label="Locale" hint="BCP-47, e.g. fr-FR">
              <input
                type="text"
                value={form.contextLocale}
                onChange={(e) => updateField('contextLocale', e.target.value)}
                placeholder="en-US"
                className="w-full px-2 py-1.5 text-xs font-mono border border-ink-200 rounded focus:outline-none focus:ring-1 focus:ring-info-400"
              />
            </FieldRow>
            <FieldRow label="Color scheme" hint="light / dark / no-preference">
              <select
                value={form.contextColorScheme}
                onChange={(e) => updateField('contextColorScheme', e.target.value)}
                className="w-full px-2 py-1.5 text-xs border border-ink-200 rounded focus:outline-none focus:ring-1 focus:ring-info-400"
              >
                <option value="">— default —</option>
                <option value="light">light</option>
                <option value="dark">dark</option>
                <option value="no-preference">no-preference</option>
              </select>
            </FieldRow>
          </div>

          <FieldRow label="User agent" hint="full UA string — overrides browser default">
            <input
              type="text"
              value={form.contextUserAgent}
              onChange={(e) => updateField('contextUserAgent', e.target.value)}
              placeholder="Mozilla/5.0 (...)"
              className="w-full px-2 py-1.5 text-xs font-mono border border-ink-200 rounded focus:outline-none focus:ring-1 focus:ring-info-400"
            />
          </FieldRow>

          <FieldRow label="Permissions (JSON array)" hint='e.g. ["geolocation","clipboard-read","clipboard-write","notifications","camera"]'>
            <input
              type="text"
              value={form.contextPermissions}
              onChange={(e) => updateField('contextPermissions', e.target.value)}
              placeholder='["geolocation"]'
              className="w-full px-2 py-1.5 text-xs font-mono border border-ink-200 rounded focus:outline-none focus:ring-1 focus:ring-info-400"
            />
          </FieldRow>

          <FieldRow label="Geolocation (JSON)" hint='e.g. {"latitude":51.5074,"longitude":-0.1278,"accuracy":50} — also add "geolocation" to permissions above'>
            <input
              type="text"
              value={form.contextGeolocation}
              onChange={(e) => updateField('contextGeolocation', e.target.value)}
              placeholder='{"latitude":40.7128,"longitude":-74.006}'
              className="w-full px-2 py-1.5 text-xs font-mono border border-ink-200 rounded focus:outline-none focus:ring-1 focus:ring-info-400"
            />
          </FieldRow>

          <FieldRow label="HTTP credentials (JSON)" hint='e.g. {"username":"admin","password":"admin"} — auto-injected as Basic auth on every fetch/XHR'>
            <input
              type="text"
              value={form.contextHttpCredentials}
              onChange={(e) => updateField('contextHttpCredentials', e.target.value)}
              placeholder='{"username":"admin","password":"admin"}'
              className="w-full px-2 py-1.5 text-xs font-mono border border-ink-200 rounded focus:outline-none focus:ring-1 focus:ring-info-400"
            />
          </FieldRow>

          <FieldRow label="Extra headers (JSON)" hint='e.g. {"x-tenant-id":"acme","x-feature-flag":"beta"}'>
            <input
              type="text"
              value={form.contextExtraHeaders}
              onChange={(e) => updateField('contextExtraHeaders', e.target.value)}
              placeholder='{"x-tenant-id":"acme"}'
              className="w-full px-2 py-1.5 text-xs font-mono border border-ink-200 rounded focus:outline-none focus:ring-1 focus:ring-info-400"
            />
          </FieldRow>

          <div className="grid grid-cols-2 gap-3">
            <FieldRow label="Proxy server" hint="http://host:port or socks5://host:port">
              <input
                type="text"
                value={form.contextProxyServer}
                onChange={(e) => updateField('contextProxyServer', e.target.value)}
                placeholder="http://corp-proxy:3128"
                className="w-full px-2 py-1.5 text-xs font-mono border border-ink-200 rounded focus:outline-none focus:ring-1 focus:ring-info-400"
              />
            </FieldRow>
            <FieldRow label="Proxy bypass" hint="comma-separated domains">
              <input
                type="text"
                value={form.contextProxyBypass}
                onChange={(e) => updateField('contextProxyBypass', e.target.value)}
                placeholder=".internal,.local"
                className="w-full px-2 py-1.5 text-xs font-mono border border-ink-200 rounded focus:outline-none focus:ring-1 focus:ring-info-400"
              />
            </FieldRow>
          </div>

          <div className="flex flex-col gap-2 pt-1">
            <label className="flex items-center gap-2 text-xs text-ink-700">
              <input
                type="checkbox"
                checked={form.contextIgnoreHttpsErrors}
                onChange={(e) => updateField('contextIgnoreHttpsErrors', e.target.checked)}
              />
              Ignore HTTPS certificate errors (self-signed certs, internal CAs)
            </label>
            <label className="flex items-center gap-2 text-xs text-ink-700">
              <input
                type="checkbox"
                checked={form.autoAcceptDialogs}
                onChange={(e) => updateField('autoAcceptDialogs', e.target.checked)}
              />
              Auto-accept JavaScript dialogs (alert / confirm / prompt) — prevents agent hangs on unexpected popups
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" onClick={save} disabled={!dirty || saving || loading} loading={saving}>
              <Save className="w-3.5 h-3.5" />
              Save context
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function FieldRow({ label, hint, children }) {
  return (
    <div className="space-y-1">
      <div className="text-2xs font-semibold uppercase tracking-wider text-ink-600">{label}</div>
      {children}
      {hint && <div className="text-2xs text-ink-400">{hint}</div>}
    </div>
  );
}

// Phase H+1 — Known popups editor.
//
// Operator declares site-wide popups (cookie banner, newsletter modal,
// onboarding overlay, etc.) in a project. Two consumers downstream:
//   1. The live agent's system prompt gets a block listing them, so the
//      agent dismisses them proactively instead of fighting click-intercepts.
//   2. Generated spec files import a `dismissKnownPopups` helper sourced
//      from this list, so re-running the spec on a day the popup appears
//      (or doesn't) is robust either way.
//
// Closed by default. Add/remove rows in the table; Save persists. Empty
// list = no project-level popups; codegen still does defensive wrapping
// for ad-hoc popups the agent encountered during a run.
const STRATEGY_OPTIONS = [
  { value: 'role',   label: 'role + name (most resilient)' },
  { value: 'text',   label: 'text (visible label)' },
  { value: 'label',  label: 'label (aria-label / for=)' },
  { value: 'testId', label: 'testId (data-testid)' },
  { value: 'css',    label: 'css (last resort)' },
];
const SCOPE_OPTIONS = [
  { value: 'global',           label: 'global (any page)' },
  { value: 'first-page-load',  label: 'first page load only' },
  { value: 'after-auth',       label: 'after login' },
];

function KnownPopupsEditor({ projectId }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [popups, setPopups] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/projects/${projectId}/known-popups`);
      setPopups(Array.isArray(res.popups) ? res.popups : []);
      setLoaded(true);
      setDirty(false);
    } catch (err) {
      toast.error(err.message || 'Failed to load known popups.');
    } finally {
      setLoading(false);
    }
  }, [projectId, toast]);

  useEffect(() => { if (open && !loaded) load(); }, [open, loaded, load]);

  const addRow = () => {
    setPopups((p) => [...p, {
      name: '',
      matcher: { strategy: 'role', value: '', role: 'button' },
      scope: 'global',
      afterDismiss: null,
    }]);
    setDirty(true);
  };

  const updateRow = (i, patch) => {
    setPopups((p) => p.map((r, idx) => idx === i ? { ...r, ...patch, matcher: { ...r.matcher, ...(patch.matcher || {}) } } : r));
    setDirty(true);
  };

  const removeRow = (i) => {
    setPopups((p) => p.filter((_, idx) => idx !== i));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.put(`/projects/${projectId}/known-popups`, { popups });
      setPopups(res.popups || []);
      setDirty(false);
      if (res.issues && res.issues.length) {
        toast.warn(`Saved with ${res.issues.length} validation issue(s) — see browser console.`);
        // eslint-disable-next-line no-console
        console.warn('known-popups validation issues:', res.issues);
      } else {
        toast.success('Known popups saved. Takes effect on the next run.');
      }
    } catch (err) {
      toast.error(err.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const isActive = loaded && popups.length > 0;

  return (
    <div className="rounded-2xl border border-ink-200/70 bg-white/68 p-3 shadow-[0_10px_28px_-24px_rgba(15,23,42,0.45)]">
      <SectionToggle
        open={open}
        onToggle={() => setOpen((o) => !o)}
        icon={ShieldCheck}
        title="Known popups"
        description="Declare recurring popups (cookie banner, newsletter modal) — the agent dismisses them proactively and every generated spec inherits the logic."
        badge={isActive ? <span className="ml-1 text-2xs uppercase tracking-wider font-bold text-info-700 bg-info-50 px-1.5 py-0.5 rounded">{popups.length} declared</span> : null}
      />
      {open && (
        <div className="mt-3 space-y-3">
          {loading && <div className="text-xs text-ink-500">Loading…</div>}
          {loaded && (
            <>
              <div className="text-2xs text-ink-500 leading-relaxed">
                Declare popups that appear on this project's site (cookie banner, newsletter modal, etc.). The live agent will dismiss them proactively, and every generated spec will inherit the dismissal logic so re-runs are resilient. Empty = no project popups; specs still handle ad-hoc popups defensively.
              </div>
              {popups.length === 0 && (
                <div className="text-xs text-ink-500 italic px-2">No popups declared. Click "Add popup" to add one.</div>
              )}
              {popups.map((p, i) => (
                <div key={i} className="border border-ink-200 rounded-lg p-3 bg-ink-50/30 space-y-2">
                  <div className="flex items-start gap-2">
                    <Input
                      label="Name"
                      value={p.name}
                      onChange={(e) => updateRow(i, { name: e.target.value })}
                      placeholder="Cookie consent banner"
                      className="flex-1"
                    />
                    <button
                      type="button"
                      onClick={() => removeRow(i)}
                      className="mt-6 p-2 text-danger-600 hover:bg-danger-50 rounded"
                      title="Remove this popup"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    <Select
                      label="Match strategy"
                      value={p.matcher?.strategy || 'role'}
                      onChange={(v) => updateRow(i, { matcher: { strategy: v } })}
                      options={STRATEGY_OPTIONS}
                    />
                    {p.matcher?.strategy === 'role' && (
                      <Input
                        label="ARIA role"
                        value={p.matcher?.role || ''}
                        onChange={(e) => updateRow(i, { matcher: { role: e.target.value } })}
                        placeholder="button"
                      />
                    )}
                    <Input
                      label={p.matcher?.strategy === 'role' ? 'Name (text or /regex/i)' : 'Value (text or /regex/i)'}
                      value={p.matcher?.value || ''}
                      onChange={(e) => updateRow(i, { matcher: { value: e.target.value } })}
                      placeholder={
                        p.matcher?.strategy === 'role' ? '/accept all/i' :
                        p.matcher?.strategy === 'testId' ? 'cookie-banner-close' :
                        p.matcher?.strategy === 'css' ? '.modal__close' :
                        'Close'
                      }
                    />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <Select
                      label="When to check"
                      value={p.scope || 'global'}
                      onChange={(v) => updateRow(i, { scope: v })}
                      options={SCOPE_OPTIONS}
                    />
                    <Select
                      label="After dismiss"
                      value={p.afterDismiss || ''}
                      onChange={(v) => updateRow(i, { afterDismiss: v || null })}
                      options={[
                        { value: '',             label: 'nothing extra' },
                        { value: 'wait-hidden',  label: 'wait until hidden' },
                        { value: 'reload',       label: 'reload the page' },
                      ]}
                    />
                  </div>
                </div>
              ))}
              <div className="flex items-center justify-between pt-2">
                <Button variant="ghost" size="sm" onClick={addRow}>
                  <Plus className="w-3.5 h-3.5" /> Add popup
                </Button>
                <Button size="sm" onClick={save} disabled={!dirty || saving} loading={saving}>
                  <Save className="w-3.5 h-3.5" /> Save
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Sprint CRUD (Phase B / B3). Each Sprint groups Documents / Requirements /
// Runs / Blockers / PRs for one release cycle. Archived sprints become
// read-only (server rejects PATCH/DELETE with SPRINT_LOCKED).
function SprintsEditor({ projectId, isCurrent }) {
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { sprints: storeSprints, refreshSprints, currentSprintId } = useProject();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  // For the active project we mirror the store list so create/delete reflect
  // immediately. For non-active projects we'd have to fetch separately —
  // skip that complexity and prompt the user to activate first.
  const list = isCurrent ? storeSprints : [];
  // Most recent completed sprint other than the one being viewed — used as
  // the default "carry forward from" source and the default Compare A side.
  const lastCompleted = list.find((s) => s.lifecycle === 'completed') || null;

  const create = async () => {
    const name = newName.trim();
    if (name.length < 2) {
      toast.error('Sprint name must be at least 2 characters.');
      return;
    }
    setBusy(true);
    try {
      await api.post(`/projects/${projectId}/sprints`, { name });
      setNewName('');
      setCreating(false);
      await refreshSprints();
      toast.success(`Sprint "${name}" created.`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Create failed' });
    } finally {
      setBusy(false);
    }
  };

  const patch = async (sprint, fields, opts = {}) => {
    try {
      const qs = opts.force ? '?force=1' : '';
      await api.patch(`/projects/${projectId}/sprints/${sprint.id}${qs}`, fields);
      await refreshSprints();
      if (!opts.silent) toast.success('Sprint updated.');
      return { ok: true };
    } catch (err) {
      // Lifecycle gate: surface the missing-P0 list and let the caller decide
      // whether to force the transition.
      if (err instanceof ApiError && err.payload?.code === 'SPRINT_INCOMPLETE') {
        return { ok: false, code: 'SPRINT_INCOMPLETE', payload: err.payload };
      }
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Update failed' });
      return { ok: false };
    }
  };

  // Lifecycle change wrapper that, on SPRINT_INCOMPLETE, surfaces the list of
  // unrun P0 cases and asks the user whether to force the transition.
  const changeLifecycle = async (sprint, lifecycle) => {
    if (sprint.lifecycle === lifecycle) return;
    const result = await patch(sprint, { lifecycle });
    if (result.ok) return;
    if (result.code === 'SPRINT_INCOMPLETE') {
      const missing = result.payload.missing || [];
      const preview = missing.slice(0, 5).map((c) => `• ${c.name} (${c.module})`).join('\n');
      const overflow = missing.length > 5 ? `\n…and ${missing.length - 5} more` : '';
      const ok = await confirm({
        title: `${missing.length} P0 case${missing.length === 1 ? '' : 's'} hasn't run in this sprint`,
        message: `Marking this sprint complete will skip past these P0 cases without coverage:\n\n${preview}${overflow}\n\nForce anyway?`,
        confirmLabel: 'Force complete',
        destructive: true,
      });
      if (ok) {
        await patch(sprint, { lifecycle }, { force: true });
      }
    }
  };

  const carryForward = async (sprint) => {
    try {
      const res = await api.post(`/projects/${projectId}/sprints/${sprint.id}/carry-forward-failures`, {});
      if (res.carried === 0 && res.skipped === 0) {
        toast.info(`No failing cases in "${res.fromSprint?.name || 'previous sprint'}".`, { title: 'Nothing to carry forward' });
      } else if (res.carried === 0) {
        toast.info(`All ${res.skipped} failing case(s) were already carried forward.`, { title: 'Up to date' });
      } else {
        toast.success(`Carried ${res.carried} failing case(s) from "${res.fromSprint?.name || ''}".`, { title: 'Carry forward' });
      }
      await refreshSprints();
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Carry forward failed' });
    }
  };

  const openCompare = (sprint) => {
    const a = lastCompleted && lastCompleted.id !== sprint.id ? lastCompleted.id
            : (list.find((s) => s.id !== sprint.id)?.id || null);
    if (!a) {
      toast.error('Need at least two sprints to compare.', { title: 'Compare' });
      return;
    }
    navigate(`/sprints/compare?a=${a}&b=${sprint.id}`);
  };

  const remove = async (sprint) => {
    const counts = sprint.counts || {};
    const tagged = (counts.documents || 0) + (counts.requirements || 0) + (counts.runs || 0) + (counts.blockers || 0) + (counts.prs || 0);
    const ok = await confirm({
      title: `Delete sprint "${sprint.name}"?`,
      message: tagged
        ? `This will untag ${tagged} item${tagged === 1 ? '' : 's'} (docs/reqs/runs/blockers/PRs) — they keep their data but lose their sprint label. The SprintTestCase membership rows are removed.`
        : 'No items are tagged to this sprint. Safe to delete.',
      confirmLabel: 'Delete sprint',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.del(`/projects/${projectId}/sprints/${sprint.id}`);
      await refreshSprints();
      toast.success(`Sprint "${sprint.name}" deleted.`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Delete failed' });
    }
  };

  return (
    <div className="rounded-2xl border border-ink-200/70 bg-white/68 p-3 shadow-[0_10px_28px_-24px_rgba(15,23,42,0.45)]">
      <SectionToggle
        open={open}
        onToggle={() => setOpen((v) => !v)}
        icon={Calendar}
        title="Sprints"
        description="Group docs, requirements, runs, blockers and PRs by release cycle. Test cases stay project-wide; switch the active sprint from the header pill."
        badge={isCurrent && list.length > 0 ? (
          <span className="text-2xs uppercase tracking-wider font-bold text-ink-500 bg-ink-100 px-1.5 py-0.5 rounded">
            {list.length}
          </span>
        ) : null}
      />
      {open && (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-ink-500">
            Sprints group docs, requirements, runs, blockers, and PRs by release cycle. Test cases stay project-wide (they show up in every sprint they run in). Switch the active sprint via the header pill.
          </p>
          {!isCurrent && (
            <div className="text-xs text-warn-700 bg-warn-50 border border-warn-200 rounded p-2">
              Activate this project to manage its sprints.
            </div>
          )}
          {isCurrent && list.length === 0 && !creating && (
            <div className="text-xs text-ink-400 italic">No sprints yet.</div>
          )}
          {isCurrent && list.map((s) => (
            <SprintCard
              key={s.id}
              sprint={s}
              selected={s.id === currentSprintId}
              hasPrevious={!!lastCompleted && lastCompleted.id !== s.id}
              canCompare={list.length >= 2}
              onPatch={(fields) => patch(s, fields, { silent: true })}
              onLifecycle={(life) => changeLifecycle(s, life)}
              onCarryForward={() => carryForward(s)}
              onCompare={() => openCompare(s)}
              onDelete={() => remove(s)}
            />
          ))}
          {isCurrent && creating && (
            <div className="rounded border border-ink-200 bg-ink-50 p-3 space-y-2">
              <Input
                label="Sprint name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Sprint 12 — Checkout polish"
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => { setCreating(false); setNewName(''); }}>Cancel</Button>
                <Button size="sm" onClick={create} loading={busy} disabled={busy}>
                  <Plus className="w-3 h-3" />
                  Create
                </Button>
              </div>
            </div>
          )}
          {isCurrent && !creating && (
            <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
              <Plus className="w-3 h-3" />
              New sprint
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// Per-sprint card. Phase B+ added: AI guidance textarea, planned end date,
// "Mark complete" button (gates on P0 coverage), "Carry forward failures"
// from the previous completed sprint, and "Compare" button. The whole row of
// extras hides behind a "more" toggle so default cards stay compact.
function SprintCard({ sprint: s, selected, hasPrevious, canCompare, onPatch, onLifecycle, onCarryForward, onCompare, onDelete }) {
  const isArchived = s.lifecycle === 'archived';
  const isCompleted = s.lifecycle === 'completed';
  const c = s.counts || {};
  const [expanded, setExpanded] = useState(false);
  // Local mirror so typing doesn't fire a PATCH on every keystroke — debounce
  // by saving on blur.
  const [name, setName] = useState(s.name);
  const [guidance, setGuidance] = useState(s.aiGuidance || '');
  const [endAt, setEndAt] = useState(s.expectedEndAt ? new Date(s.expectedEndAt).toISOString().slice(0, 10) : '');
  // Keep local fields in sync when the parent refreshes (e.g. after carry-forward).
  useEffect(() => { setName(s.name); }, [s.name]);
  useEffect(() => { setGuidance(s.aiGuidance || ''); }, [s.aiGuidance]);
  useEffect(() => { setEndAt(s.expectedEndAt ? new Date(s.expectedEndAt).toISOString().slice(0, 10) : ''); }, [s.expectedEndAt]);

  return (
    <div className={`rounded border bg-ink-50 p-3 space-y-2 ${selected ? 'border-info-200' : 'border-ink-200'}`}>
      <div className="grid grid-cols-2 gap-2 items-end">
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => { if (name.trim() && name !== s.name) onPatch({ name }); }}
          disabled={isArchived}
        />
        <Select
          label="Lifecycle"
          value={s.lifecycle}
          onChange={(e) => onLifecycle(e.target.value)}
          options={SPRINT_LIFECYCLE_OPTIONS}
          disabled={isArchived}
        />
      </div>
      <div className="text-2xs text-ink-500 grid grid-cols-3 gap-1">
        <span>{c.documents ?? 0} docs · {c.requirements ?? 0} reqs</span>
        <span>{c.runs ?? 0} runs · {c.blockers ?? 0} blocked</span>
        <span>{c.cases ?? 0} cases · {c.prs ?? 0} PRs</span>
      </div>

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="text-2xs font-semibold text-ink-600 hover:text-ink-900 inline-flex items-center gap-1"
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {expanded ? 'Hide' : 'More'} options
      </button>

      {expanded && (
        <div className="pt-2 space-y-3 border-t border-ink-100">
          {/* Sprint-scoped AI guidance. Stacks below Project.aiGuidance via
              promptCompose; e.g. "this sprint focuses on payments". */}
          <div>
            <label className="block text-2xs font-bold uppercase tracking-wider text-ink-600 mb-1 inline-flex items-center gap-1">
              <Sparkles className="w-3 h-3" />
              Sprint AI guidance
            </label>
            <textarea
              value={guidance}
              onChange={(e) => setGuidance(e.target.value.slice(0, 4000))}
              onBlur={() => { if ((guidance || '') !== (s.aiGuidance || '')) onPatch({ aiGuidance: guidance }); }}
              placeholder='e.g. "This sprint focuses on the checkout flow — prefer scenarios touching payment, cart, address."'
              rows={3}
              disabled={isArchived}
              className="w-full text-xs font-mono p-2 border border-ink-200 rounded focus:outline-none focus:border-ink-900 focus:shadow-ring transition-all resize-y disabled:bg-ink-100 disabled:cursor-not-allowed"
            />
            <div className="text-2xs text-ink-400">
              Stacked on top of project-wide guidance for every agent call in this sprint.
            </div>
          </div>

          {/* Planned end date — drives "days to cut" on the Overview tile. */}
          <div className="grid grid-cols-2 gap-2 items-end">
            <Input
              label="Planned end date"
              type="date"
              value={endAt}
              onChange={(e) => setEndAt(e.target.value)}
              onBlur={() => {
                const next = endAt ? new Date(endAt + 'T00:00:00').toISOString() : null;
                const prev = s.expectedEndAt ? new Date(s.expectedEndAt).toISOString() : null;
                if (next !== prev) onPatch({ expectedEndAt: next });
              }}
              disabled={isArchived}
            />
          </div>

          {/* Carry-forward + compare + mark-complete actions. */}
          <div className="flex flex-wrap items-center gap-2">
            {!isCompleted && !isArchived && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onLifecycle('completed')}
                title="Mark this sprint complete (gated on P0 coverage)"
              >
                <CheckCircle2 className="w-3 h-3" />
                Mark complete
              </Button>
            )}
            {hasPrevious && !isArchived && (
              <Button
                variant="secondary"
                size="sm"
                onClick={onCarryForward}
                title="Copy failing cases from the most recent completed sprint into this one"
              >
                <ArrowRightLeft className="w-3 h-3" />
                Carry forward failures
              </Button>
            )}
            {canCompare && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onCompare}
                title="Compare results between two sprints"
              >
                <GitCompare className="w-3 h-3" />
                Compare
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={onDelete} className="text-danger-600">
          <Trash2 className="w-3 h-3" />
          Delete
        </Button>
      </div>
    </div>
  );
}
