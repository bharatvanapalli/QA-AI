import React, { useEffect, useState, useCallback } from 'react';
import { Plus, Folder, Trash2, Save, Settings } from 'lucide-react';
import api, { ApiError } from '../lib/apiClient';
import { useProject } from '../store/project';
import { useToast } from '../lib/useToast';
import { useConfirm } from '../lib/useConfirm';
import useDirtyForm, { useUnsavedChangesWarning } from '../lib/useDirtyForm';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Select from '../components/ui/Select';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';

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
