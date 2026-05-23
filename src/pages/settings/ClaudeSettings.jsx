import React, { useEffect, useState, useCallback } from 'react';
import { Save, ShieldCheck, Trash2, BadgeCheck, Sparkles, Loader2 } from 'lucide-react';
import api, { ApiError } from '../../lib/apiClient';
import useDirtyForm, { useUnsavedChangesWarning } from '../../lib/useDirtyForm';
import { useToast } from '../../lib/useToast';
import { useConfirm } from '../../lib/useConfirm';
import { useProject } from '../../store/project';
import Button from '../../components/ui/Button';
import SecretInput from '../../components/ui/SecretInput';
import Select from '../../components/ui/Select';
import StatusBadge from '../../components/ui/StatusBadge';

const KEY_PREFIX = 'sk-ant-';

export default function ClaudeSettings() {
  const toast = useToast();
  const confirm = useConfirm();
  const [loading, setLoading] = useState(true);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [validation, setValidation] = useState(null); // {valid, modelsAvailable?, code?, message?}
  const [serverInfo, setServerInfo] = useState({
    configured: false,
    lastFour: null,
    status: 'unconfigured',
    lastValidatedAt: null,
    lastError: null,
    modelsAvailable: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  });

  const f = useDirtyForm({ apiKey: '', model: 'claude-sonnet-4-6' });
  useUnsavedChangesWarning(f.isDirty);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get('/settings/claude');
        if (cancelled) return;
        setServerInfo(data);
        f.rebase({ apiKey: '', model: data.model || 'claude-sonnet-4-6' });
      } catch (err) {
        if (err instanceof ApiError) {
          toast.error(err.message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Normalised key (whitespace stripped) — used for both the format hint and the request.
  const cleanedKey = (f.values.apiKey || '').trim();
  const formatLooksValid = cleanedKey.startsWith(KEY_PREFIX) && cleanedKey.length >= 27;
  // Be lenient: enable the button as long as SOMETHING is typed. The backend
  // will reject with INVALID_FORMAT if the format is wrong — much better UX than
  // a silently disabled button.
  const canValidate = !validating && cleanedKey.length > 0;
  const canSave =
    !saving &&
    f.isDirty &&
    // Either: key entered + validated, OR: only model changed and existing config valid
    ((f.values.apiKey && validation?.valid) ||
      (!f.values.apiKey && serverInfo.configured && f.values.model !== serverInfo.model));

  const handleValidate = useCallback(async () => {
    if (!canValidate) return;
    setValidating(true);
    setValidation(null);
    f.clearErrors();
    try {
      const res = await api.post('/settings/claude/validate', { apiKey: cleanedKey });
      setValidation(res);
      toast.success('API key is valid.', { title: 'Validation passed' });
      // Reflect trimmed value in the input
      if (cleanedKey !== f.values.apiKey) f.set('apiKey', cleanedKey);
      // Update model dropdown if backend reports newer models
      if (Array.isArray(res.modelsAvailable) && res.modelsAvailable.length) {
        setServerInfo((s) => ({ ...s, modelsAvailable: res.modelsAvailable }));
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setValidation({ valid: false, ...err.payload });
        f.setError('apiKey', err.payload?.message || err.message);
        toast.error(err.payload?.message || err.message, { title: 'Validation failed' });
      } else {
        toast.error(err.message);
      }
    } finally {
      setValidating(false);
    }
  }, [canValidate, f, toast]);

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      // If only model changed, we still need to send the existing key — but we don't have it.
      // The backend requires apiKey for save; surface this clearly.
      if (!cleanedKey) {
        toast.error(
          'To change the model, paste the API key again (we never store plaintext locally).',
          { title: 'Re-enter key' }
        );
        return;
      }
      const res = await api.post('/settings/claude/save', {
        apiKey: cleanedKey,
        model: f.values.model,
      });
      setServerInfo({
        configured: true,
        lastFour: res.lastFour,
        status: res.status,
        lastValidatedAt: res.lastValidatedAt,
        lastError: null,
        modelsAvailable: serverInfo.modelsAvailable,
        model: res.model,
      });
      f.commit({ apiKey: '', model: res.model });
      setValidation(null);
      toast.success('Claude settings saved.', { title: 'Saved' });
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Save failed' });
    } finally {
      setSaving(false);
    }
  }, [canSave, f, toast, serverInfo.modelsAvailable]);

  const handleDelete = useCallback(async () => {
    if (!serverInfo.configured) return;
    const ok = await confirm({
      title: 'Delete the stored Claude API key?',
      message: 'Tests that depend on AI (generation, RCA, locator healing) will stop working until a new key is configured.',
      confirmLabel: 'Remove key',
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await api.del('/settings/claude');
      setServerInfo({
        configured: false,
        lastFour: null,
        status: 'unconfigured',
        lastValidatedAt: null,
        lastError: null,
        modelsAvailable: serverInfo.modelsAvailable,
      });
      f.rebase({ apiKey: '', model: 'claude-sonnet-4-6' });
      setValidation(null);
      toast.success('API key removed.', { title: 'Deleted' });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setDeleting(false);
    }
  }, [serverInfo, f, toast, confirm]);

  if (loading) {
    return (
      <div className="p-8 text-sm text-ink-500">Loading Claude settings…</div>
    );
  }

  const status =
    validating
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
          <h2 className="text-xl font-bold text-ink-900">Claude API</h2>
          <p className="text-sm text-ink-500">
            Used for AI test-case generation, locator healing, and root-cause analysis.
          </p>
        </div>
        <StatusBadge
          status={status}
          label={
            status === 'valid'
              ? serverInfo.lastFour
                ? `Connected · …${serverInfo.lastFour}`
                : 'Connected'
              : undefined
          }
        />
      </header>

      <div className="rounded-lg border border-ink-200 bg-white p-5 space-y-4">
        <SecretInput
          label="API Key"
          value={f.values.apiKey}
          onChange={(e) => {
            f.set('apiKey', e.target.value);
            setValidation(null);
          }}
          placeholderMask={
            serverInfo.configured && !f.values.apiKey
              ? `••••${serverInfo.lastFour}  (stored — paste to change)`
              : 'sk-ant-…'
          }
          hint={
            serverInfo.configured && !f.values.apiKey
              ? 'A key is stored. Leave blank to keep it, or paste a new one to replace.'
              : cleanedKey && !formatLooksValid
              ? '⚠ Expected format: starts with "sk-ant-" and is 27+ chars. Click Validate to let the API decide.'
              : 'Anthropic API key — starts with sk-ant-…'
          }
          error={f.errors.apiKey}
        />

        <Select
          label="Default Model"
          value={f.values.model}
          onChange={(e) => f.set('model', e.target.value)}
          options={(serverInfo.modelsAvailable || []).map((m) => ({ value: m, label: m }))}
          hint="Selected when generating test cases and analyzing failures."
        />

        {validation && !validation.valid && (
          <div className="rounded-md bg-danger-50 border border-danger-200 text-danger-800 text-xs p-3">
            <strong>{validation.code || 'INVALID'}</strong> — {validation.message}
          </div>
        )}
        {serverInfo.lastValidatedAt && (
          <div className="text-xs text-ink-500">
            Last validated: {new Date(serverInfo.lastValidatedAt).toLocaleString()}
          </div>
        )}

        <div className="flex items-center justify-between pt-2 border-t border-ink-200">
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleValidate}
              disabled={!canValidate}
              loading={validating}
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              Validate
            </Button>
            {serverInfo.configured && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDelete}
                loading={deleting}
              >
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
        <div className="rounded-md bg-success-50 border border-success-200 text-success-900 text-xs p-3 flex items-start gap-2">
          <BadgeCheck className="w-4 h-4 mt-0.5" />
          <div>
            <div className="font-semibold">Key authenticated against Anthropic.</div>
            <div className="opacity-80">
              {validation.modelsAvailable?.length || 0} models accessible:{' '}
              {(validation.modelsAvailable || []).slice(0, 4).join(', ')}
              {validation.modelsAvailable?.length > 4 ? '…' : ''}
            </div>
          </div>
        </div>
      )}

      <ProjectGuidanceSection />
    </div>
  );
}

// ── ProjectGuidanceSection ─────────────────────────────────────────
// Free-form text the user wants every AI agent to honour on this project.
// Loaded from / saved to `Project.aiGuidance`. Prepended to every agent's
// system prompt by server/lib/promptCompose at run time.
function ProjectGuidanceSection() {
  const { current } = useProject();
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [value, setValue] = useState('');
  const [serverValue, setServerValue] = useState('');

  useEffect(() => {
    if (!current) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get(`/projects/${current.id}`);
        if (cancelled) return;
        const v = res.project?.aiGuidance || '';
        setServerValue(v);
        setValue(v);
      } catch (err) {
        if (!cancelled) toast.error(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [current?.id]);

  const dirty = value !== serverValue;
  const remaining = 8000 - value.length;

  const handleSave = useCallback(async () => {
    if (!current) return;
    setSaving(true);
    try {
      const res = await api.put(`/projects/${current.id}/guidance`, { aiGuidance: value });
      setServerValue(res.project.aiGuidance || '');
      setValue(res.project.aiGuidance || '');
      toast.success('Project AI guidance saved.', { title: 'Saved' });
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Could not save' });
    } finally {
      setSaving(false);
    }
  }, [current, value, toast]);

  if (!current) {
    return (
      <div className="rounded-lg border border-ink-200 bg-white p-5 space-y-2">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-accent-600" aria-hidden="true" />
          <h3 className="text-md font-semibold text-ink-900">Project AI guidance</h3>
        </div>
        <p className="text-xs text-ink-500">
          Activate a project to set free-form guidance every AI agent honours on this project.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-ink-200 bg-white p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-accent-600" aria-hidden="true" />
          <div>
            <h3 className="text-md font-semibold text-ink-900">Project AI guidance</h3>
            <p className="text-xs text-ink-500 mt-0.5">
              Free-form notes every AI agent (Architect, Planner, Conductor, Critic, Supervisor, Reporter, Analyst)
              prepends to its prompt for <span className="font-semibold text-ink-700">{current.name}</span>.
            </p>
          </div>
        </div>
      </div>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value.slice(0, 8000))}
        placeholder={'e.g. "This app uses MUI date pickers — prefer aria-label=\'Choose date\' over text-based selectors."\n\n"Test data should always use the @qa.example.com domain."'}
        rows={6}
        disabled={loading || saving}
        className="w-full text-sm font-mono p-3 border border-ink-200 rounded-md focus:outline-none focus:border-ink-900 focus:shadow-ring transition-all resize-y disabled:bg-ink-50 disabled:cursor-not-allowed"
        aria-label="Project AI guidance"
      />
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-2xs text-ink-500">
          {loading
            ? <span className="inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Loading…</span>
            : remaining < 500
            ? <span className={remaining < 0 ? 'text-danger-700' : 'text-warn-700'}>
                {remaining < 0 ? `${-remaining} over limit` : `${remaining} characters left`}
              </span>
            : <span>Stored on the project. Cleared by saving an empty value. Up to 8,000 characters.</span>}
        </div>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={!dirty || saving || loading}
          loading={saving}
        >
          <Save className="w-3.5 h-3.5" />
          {dirty ? 'Save guidance' : 'No changes'}
        </Button>
      </div>
    </div>
  );
}
