import React, { useEffect, useState, useCallback } from 'react';
import { Save, Plug, Trash2, RefreshCw } from 'lucide-react';
import api, { ApiError } from '../../lib/apiClient';
import useDirtyForm, { useUnsavedChangesWarning } from '../../lib/useDirtyForm';
import { useToast } from '../../lib/useToast';
import { useConfirm } from '../../lib/useConfirm';
import Button from '../../components/ui/Button';
import Input from '../../components/ui/Input';
import SecretInput from '../../components/ui/SecretInput';
import Select from '../../components/ui/Select';
import StatusBadge from '../../components/ui/StatusBadge';

export default function AdoSettings() {
  const toast = useToast();
  const confirm = useConfirm();
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [validation, setValidation] = useState(null); // {valid, user?, projects?, code?, message?}
  const [serverInfo, setServerInfo] = useState({
    configured: false,
    lastFour: null,
    orgUrl: '',
    projectName: '',
    status: 'unconfigured',
    lastValidatedAt: null,
  });

  const f = useDirtyForm({ orgUrl: '', pat: '', projectName: '' });
  useUnsavedChangesWarning(f.isDirty);

  useEffect(() => {
    (async () => {
      try {
        const data = await api.get('/settings/ado');
        setServerInfo(data);
        f.rebase({ orgUrl: data.orgUrl || '', pat: '', projectName: data.projectName || '' });
      } catch (err) {
        toast.error(err.message);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const urlOk = /^https:\/\/.+/.test(f.values.orgUrl.trim());
  const canTest = !testing && urlOk && (f.values.pat || serverInfo.configured);
  const canSave =
    !saving &&
    f.isDirty &&
    urlOk &&
    !!f.values.projectName &&
    (f.values.pat || (serverInfo.configured && f.values.projectName !== serverInfo.projectName));

  const handleTest = useCallback(async () => {
    if (!canTest) return;
    setTesting(true);
    setValidation(null);
    try {
      const body = { orgUrl: f.values.orgUrl.trim() };
      if (f.values.pat) body.pat = f.values.pat;
      const res = await api.post('/settings/ado/test-connection', body);
      setValidation(res);
      toast.success(
        `Authenticated as ${res.user?.displayName || 'user'} · ${res.projects.length} projects accessible.`,
        { title: 'Connection ok' }
      );
      // If saved projectName is still in the list, keep it; else clear it.
      if (
        f.values.projectName &&
        !res.projects.some((p) => p.name === f.values.projectName)
      ) {
        f.set('projectName', '');
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
    if (!f.values.pat) {
      toast.error('Re-enter your PAT to save (we never store plaintext locally).', {
        title: 'Re-enter PAT',
      });
      return;
    }
    setSaving(true);
    try {
      const res = await api.post('/settings/ado/save', {
        orgUrl: f.values.orgUrl.trim(),
        pat: f.values.pat,
        projectName: f.values.projectName,
      });
      setServerInfo({
        configured: true,
        lastFour: res.lastFour,
        orgUrl: res.orgUrl,
        projectName: res.projectName,
        status: 'valid',
        lastValidatedAt: res.lastValidatedAt,
      });
      f.commit({ orgUrl: res.orgUrl, pat: '', projectName: res.projectName });
      setValidation(null);
      toast.success('Azure DevOps connection saved.', { title: 'Saved' });
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
      title: 'Remove Azure DevOps integration?',
      message: 'Stored credentials will be deleted. Requirement ingestion from ADO will stop until you reconfigure.',
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await api.del('/settings/ado');
      setServerInfo({
        configured: false,
        lastFour: null,
        orgUrl: '',
        projectName: '',
        status: 'unconfigured',
        lastValidatedAt: null,
      });
      f.rebase({ orgUrl: '', pat: '', projectName: '' });
      setValidation(null);
      toast.success('ADO integration removed.', { title: 'Deleted' });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setDeleting(false);
    }
  }, [serverInfo, f, toast, confirm]);

  if (loading)
    return <div className="p-8 text-sm text-ink-500">Loading Azure DevOps settings…</div>;

  const projectOptions = [
    ...(validation?.projects || []).map((p) => ({ value: p.name, label: p.name })),
    // Show currently-saved project even if not yet re-tested
    ...(serverInfo.projectName &&
    !(validation?.projects || []).some((p) => p.name === serverInfo.projectName)
      ? [{ value: serverInfo.projectName, label: `${serverInfo.projectName} (saved)` }]
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
          <h2 className="text-xl font-bold text-ink-900">Azure DevOps</h2>
          <p className="text-sm text-ink-500">
            Pulls user stories, features, and bugs from a real ADO project as test requirements.
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
          label="Organization URL"
          value={f.values.orgUrl}
          onChange={(e) => {
            f.set('orgUrl', e.target.value);
            setValidation(null);
          }}
          placeholder="https://dev.azure.com/your-org"
          error={!urlOk && f.values.orgUrl ? 'URL must start with https://' : undefined}
          hint="e.g. https://dev.azure.com/contoso"
        />
        <SecretInput
          label="Personal Access Token"
          value={f.values.pat}
          onChange={(e) => {
            f.set('pat', e.target.value);
            setValidation(null);
          }}
          placeholderMask={
            serverInfo.configured && !f.values.pat
              ? `••••${serverInfo.lastFour}  (stored — paste to change)`
              : 'enter PAT'
          }
          hint="Required scopes: Project & Team (read), Work Items (read)."
        />
        {validation?.valid && projectOptions.length > 0 ? (
          <Select
            label="Project"
            value={f.values.projectName}
            onChange={(e) => f.set('projectName', e.target.value)}
            options={[{ value: '', label: '— select a project —' }, ...projectOptions]}
          />
        ) : serverInfo.configured && serverInfo.projectName ? (
          <Input
            label="Project"
            value={f.values.projectName}
            onChange={(e) => f.set('projectName', e.target.value)}
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
            <Button
              variant="secondary"
              size="sm"
              onClick={handleTest}
              disabled={!canTest}
              loading={testing}
            >
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
            Connected as {validation.user?.displayName || 'user'}
            {validation.user?.email ? ` (${validation.user.email})` : ''}
          </div>
          <div className="opacity-80">
            {validation.projects.length} projects accessible.
          </div>
        </div>
      )}
    </div>
  );
}
