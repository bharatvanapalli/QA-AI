import React, { useEffect, useState, useCallback } from 'react';
import { Save, Plug, Trash2 } from 'lucide-react';
import api, { ApiError } from '../../lib/apiClient';
import useDirtyForm, { useUnsavedChangesWarning } from '../../lib/useDirtyForm';
import { useToast } from '../../lib/useToast';
import { useConfirm } from '../../lib/useConfirm';
import Button from '../../components/ui/Button';
import Input from '../../components/ui/Input';
import SecretInput from '../../components/ui/SecretInput';
import Select from '../../components/ui/Select';
import StatusBadge from '../../components/ui/StatusBadge';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function JiraSettings() {
  const toast = useToast();
  const confirm = useConfirm();
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [validation, setValidation] = useState(null);
  const [serverInfo, setServerInfo] = useState({
    configured: false,
    lastFour: null,
    url: '',
    email: '',
    projectKey: '',
    status: 'unconfigured',
    lastValidatedAt: null,
  });

  const f = useDirtyForm({ url: '', email: '', token: '', projectKey: '' });
  useUnsavedChangesWarning(f.isDirty);

  useEffect(() => {
    (async () => {
      try {
        const data = await api.get('/settings/jira');
        setServerInfo(data);
        f.rebase({
          url: data.url || '',
          email: data.email || '',
          token: '',
          projectKey: data.projectKey || '',
        });
      } catch (err) {
        toast.error(err.message);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const urlOk = /^https:\/\/.+/.test(f.values.url.trim());
  const emailOk = EMAIL_RE.test(f.values.email.trim());
  const canTest = !testing && urlOk && emailOk && (f.values.token || serverInfo.configured);
  const canSave =
    !saving &&
    f.isDirty &&
    urlOk &&
    emailOk &&
    !!f.values.projectKey &&
    (f.values.token || (serverInfo.configured && f.values.projectKey !== serverInfo.projectKey));

  const handleTest = useCallback(async () => {
    if (!canTest) return;
    setTesting(true);
    setValidation(null);
    try {
      const body = { url: f.values.url.trim(), email: f.values.email.trim() };
      if (f.values.token) body.token = f.values.token;
      const res = await api.post('/settings/jira/test-connection', body);
      setValidation(res);
      toast.success(
        `Authenticated as ${res.user?.displayName || res.user?.email} · ${res.projects.length} projects.`,
        { title: 'Connection ok' }
      );
      if (
        f.values.projectKey &&
        !res.projects.some((p) => p.key === f.values.projectKey)
      ) {
        f.set('projectKey', '');
      }
    } catch (err) {
      const payload = err instanceof ApiError ? err.payload : { message: err.message };
      setValidation({ valid: false, ...payload });
      toast.error(payload.message || 'Connection failed', { title: payload.code || 'Failed' });
    } finally {
      setTesting(false);
    }
  }, [canTest, f, toast]);

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    if (!f.values.token) {
      toast.error('Re-enter your API token to save.', { title: 'Re-enter token' });
      return;
    }
    setSaving(true);
    try {
      const res = await api.post('/settings/jira/save', {
        url: f.values.url.trim(),
        email: f.values.email.trim(),
        token: f.values.token,
        projectKey: f.values.projectKey,
      });
      setServerInfo({
        configured: true,
        lastFour: res.lastFour,
        url: res.url,
        email: res.email,
        projectKey: res.projectKey,
        status: 'valid',
        lastValidatedAt: res.lastValidatedAt,
      });
      f.commit({ url: res.url, email: res.email, token: '', projectKey: res.projectKey });
      setValidation(null);
      toast.success('Jira connection saved.', { title: 'Saved' });
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Save failed' });
    } finally {
      setSaving(false);
    }
  }, [canSave, f, toast]);

  const handleDelete = useCallback(async () => {
    if (!serverInfo.configured) return;
    const ok = await confirm({
      title: 'Remove Jira integration?',
      message: 'Stored credentials will be deleted. Requirement ingestion from Jira will stop until you reconfigure.',
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await api.del('/settings/jira');
      setServerInfo({
        configured: false,
        lastFour: null,
        url: '',
        email: '',
        projectKey: '',
        status: 'unconfigured',
        lastValidatedAt: null,
      });
      f.rebase({ url: '', email: '', token: '', projectKey: '' });
      setValidation(null);
      toast.success('Jira integration removed.');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setDeleting(false);
    }
  }, [serverInfo, f, toast, confirm]);

  if (loading) return <div className="p-8 text-sm text-ink-500">Loading Jira settings…</div>;

  const projectOptions = [
    ...(validation?.projects || []).map((p) => ({ value: p.key, label: `${p.name} (${p.key})` })),
    ...(serverInfo.projectKey &&
    !(validation?.projects || []).some((p) => p.key === serverInfo.projectKey)
      ? [{ value: serverInfo.projectKey, label: `${serverInfo.projectKey} (saved)` }]
      : []),
  ];

  const status =
    testing
      ? 'validating'
      : validation?.valid
      ? 'valid'
      : validation && !validation.valid
      ? 'invalid'
      : serverInfo.configured
      ? 'valid'
      : 'unconfigured';

  return (
    <div className="max-w-3xl space-y-6">
      <header className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-bold text-ink-900">Jira</h2>
          <p className="text-sm text-ink-500">
            Pulls issues (stories, bugs, epics) from a Jira project for requirement ingestion.
          </p>
        </div>
        <StatusBadge
          status={status}
          label={
            status === 'valid' && serverInfo.lastFour
              ? `Connected · …${serverInfo.lastFour}`
              : undefined
          }
        />
      </header>

      <div className="rounded-lg border border-ink-200 bg-white p-5 space-y-4">
        <Input
          label="Jira URL"
          value={f.values.url}
          onChange={(e) => {
            f.set('url', e.target.value);
            setValidation(null);
          }}
          placeholder="https://your-team.atlassian.net"
          error={!urlOk && f.values.url ? 'URL must start with https://' : undefined}
        />
        <Input
          label="Email"
          value={f.values.email}
          onChange={(e) => {
            f.set('email', e.target.value);
            setValidation(null);
          }}
          placeholder="you@example.com"
          error={!emailOk && f.values.email ? 'Invalid email format' : undefined}
        />
        <SecretInput
          label="API Token"
          value={f.values.token}
          onChange={(e) => {
            f.set('token', e.target.value);
            setValidation(null);
          }}
          placeholderMask={
            serverInfo.configured && !f.values.token
              ? `••••${serverInfo.lastFour}  (stored — paste to change)`
              : 'Jira API token'
          }
          hint="Create at id.atlassian.com → Security → API tokens."
        />
        {validation?.valid && projectOptions.length > 0 ? (
          <Select
            label="Project"
            value={f.values.projectKey}
            onChange={(e) => f.set('projectKey', e.target.value)}
            options={[{ value: '', label: '— select a project —' }, ...projectOptions]}
          />
        ) : serverInfo.configured && serverInfo.projectKey ? (
          <Input
            label="Project Key"
            value={f.values.projectKey}
            onChange={(e) => f.set('projectKey', e.target.value)}
            hint="Run Test Connection to refresh the project list."
          />
        ) : null}

        {validation && !validation.valid && (
          <div className="rounded-md bg-danger-50 border border-danger-200 text-danger-800 text-xs p-3">
            <strong>{validation.code || 'INVALID'}</strong> — {validation.message}
          </div>
        )}

        <div className="flex items-center justify-between pt-2 border-t border-ink-200">
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={handleTest} disabled={!canTest} loading={testing}>
              <Plug className="w-3.5 h-3.5" />
              Test Connection
            </Button>
            {serverInfo.configured && (
              <Button variant="ghost" size="sm" onClick={handleDelete} loading={deleting}>
                <Trash2 className="w-3.5 h-3.5" />
                Remove
              </Button>
            )}
          </div>
          <Button onClick={handleSave} disabled={!canSave} loading={saving}>
            <Save className="w-3.5 h-3.5" />
            {f.isDirty ? 'Save changes' : 'No changes'}
          </Button>
        </div>
      </div>

      {validation?.valid && (
        <div className="rounded-md bg-success-50 border border-success-200 text-success-900 text-xs p-3">
          <div className="font-semibold">
            Connected as {validation.user?.displayName} ({validation.user?.email})
          </div>
          <div className="opacity-80">{validation.projects.length} projects accessible.</div>
        </div>
      )}
    </div>
  );
}
