import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Folder, Trash2, Save, Settings, Users, ChevronDown, ChevronRight, Calendar, Sparkles, CheckCircle2, GitCompare, ArrowRightLeft, GitBranch } from 'lucide-react';
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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader
        title="Project Setup"
        subtitle={`${projects.length} project${projects.length === 1 ? '' : 's'}`}
        showProject={false}
      >
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="w-3.5 h-3.5" />
          New project
        </Button>
      </PageHeader>

      <main className="flex-1 overflow-y-auto p-6 bg-ink-50">
        <div className="max-w-4xl mx-auto space-y-6">
          {creating && (
            <NewProjectCard
              onCancel={() => setCreating(false)}
              onCreated={async (proj) => {
                await refresh();
                switchTo(proj.id);
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

          {projects.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              isCurrent={current?.id === p.id}
              onActivate={() => switchTo(p.id)}
              onChanged={refresh}
            />
          ))}
        </div>
      </main>
    </div>
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
    <div className="rounded-lg border border-ink-200 bg-white p-5 space-y-4">
      <h2 className="font-semibold text-ink-900">New project</h2>
      <Input label="Name" value={form.name} onChange={(e) => update('name', e.target.value)} placeholder="Checkout Regression Suite" />
      <div className="grid grid-cols-2 gap-4">
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
            { value: 'playwright-pom', label: 'Playwright + Page Object Model' },
            { value: 'playwright-flat', label: 'Playwright (flat)' },
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
      <div className="flex justify-end gap-2 pt-2 border-t border-ink-200">
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
  });
  useUnsavedChangesWarning(f.isDirty && isCurrent);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
    <div className={`rounded-lg border bg-white p-5 ${isCurrent ? 'border-ink-900' : 'border-ink-200'}`}>
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <Folder className="w-4 h-4 text-ink-500" />
            <h3 className="font-semibold text-ink-900">{project.name}</h3>
            {isCurrent && (
              <span className="text-2xs uppercase tracking-wider font-bold text-success-700 bg-success-50 px-1.5 py-0.5 rounded">
                Active
              </span>
            )}
          </div>
          <div className="text-xs text-ink-500 mt-1 flex gap-4">
            <span>{project._count?.requirements ?? 0} requirements</span>
            <span>{project._count?.testCases ?? 0} test cases</span>
            <span>{project._count?.runs ?? 0} runs</span>
            {project._count?.documents !== undefined && <span>{project._count.documents} docs</span>}
          </div>
        </div>
        <div className="flex gap-2">
          {!isCurrent && (
            <Button size="sm" variant="secondary" onClick={onActivate}>
              <Settings className="w-3.5 h-3.5" />
              Activate
            </Button>
          )}
        </div>
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
              { value: 'playwright-pom', label: 'Playwright + POM' },
              { value: 'playwright-flat', label: 'Playwright (flat)' },
            ]}
          />
        </div>
        <Input
          label="Target URL"
          value={f.values.targetUrl}
          onChange={(e) => f.set('targetUrl', e.target.value)}
          placeholder="https://staging.example.com"
        />
      </div>

      <TestUsersEditor projectId={project.id} />
      <GitRepoEditor projectId={project.id} />
      <BrowserContextEditor projectId={project.id} />
      <SprintsEditor projectId={project.id} isCurrent={isCurrent} />

      <div className="flex items-center justify-between pt-3 mt-3 border-t border-ink-200">
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
    <div className="mt-4 pt-3 border-t border-ink-100">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs font-semibold text-ink-700 hover:text-ink-900"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <Users className="w-3.5 h-3.5" />
        Test users
        {loaded && users.length > 0 && (
          <span className="text-2xs uppercase tracking-wider font-bold text-ink-500 bg-ink-100 px-1.5 py-0.5 rounded">
            {users.length}
          </span>
        )}
      </button>
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
    <div className="mt-4 pt-3 border-t border-ink-100">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs font-semibold text-ink-700 hover:text-ink-900"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <GitBranch className="w-3.5 h-3.5" />
        Git repository
        {loaded && form.repoUrl && (
          <span className="text-2xs uppercase tracking-wider font-bold text-info-700 bg-info-50 px-1.5 py-0.5 rounded">
            connected
          </span>
        )}
      </button>
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
    <div className="mt-4 pt-3 border-t border-ink-100">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs font-semibold text-ink-700 hover:text-ink-900"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <Settings className="w-3.5 h-3.5" />
        Browser context
        {isActive && (
          <span className="text-2xs uppercase tracking-wider font-bold text-accent-700 bg-accent-50 px-1.5 py-0.5 rounded">
            configured
          </span>
        )}
      </button>
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
    <div className="mt-4 pt-3 border-t border-ink-100">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs font-semibold text-ink-700 hover:text-ink-900"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <Calendar className="w-3.5 h-3.5" />
        Sprints
        {isCurrent && list.length > 0 && (
          <span className="text-2xs uppercase tracking-wider font-bold text-ink-500 bg-ink-100 px-1.5 py-0.5 rounded">
            {list.length}
          </span>
        )}
      </button>
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
