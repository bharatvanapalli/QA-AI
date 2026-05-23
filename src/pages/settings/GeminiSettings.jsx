import React, { useEffect, useState, useCallback } from 'react';
import { Save, ShieldCheck, Trash2, BadgeCheck } from 'lucide-react';
import api, { ApiError } from '../../lib/apiClient';
import useDirtyForm, { useUnsavedChangesWarning } from '../../lib/useDirtyForm';
import { useToast } from '../../lib/useToast';
import { useConfirm } from '../../lib/useConfirm';
import Button from '../../components/ui/Button';
import SecretInput from '../../components/ui/SecretInput';
import Select from '../../components/ui/Select';
import StatusBadge from '../../components/ui/StatusBadge';

const KEY_PREFIX = 'AIza';

/**
 * Settings → Gemini API.
 *
 * Mirrors the Claude settings page. The user pastes a Google AI Studio
 * API key, validates it against `/v1beta/models`, picks a model from the
 * list of models that support `generateContent`, and saves.
 *
 * The choice of which provider (Claude vs Gemini) a project's agents
 * actually use lives in `ProjectProviderSection` below, also surfaced on
 * the Claude settings page so users can switch from either side.
 */
export default function GeminiSettings() {
  const toast = useToast();
  const confirm = useConfirm();
  const [loading, setLoading] = useState(true);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [validation, setValidation] = useState(null);
  const [serverInfo, setServerInfo] = useState({
    configured: false,
    lastFour: null,
    status: 'unconfigured',
    lastValidatedAt: null,
    lastError: null,
    modelsAvailable: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  });

  const f = useDirtyForm({ apiKey: '', model: 'gemini-2.5-pro' });
  useUnsavedChangesWarning(f.isDirty);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get('/settings/gemini');
        if (cancelled) return;
        setServerInfo(data);
        f.rebase({ apiKey: '', model: data.model || 'gemini-2.5-pro' });
      } catch (err) {
        if (err instanceof ApiError) toast.error(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cleanedKey = (f.values.apiKey || '').trim();
  // Lenient client-side format hint: Google's real key length varies, so we
  // only flag obviously-wrong pastes (e.g. an Anthropic sk-ant-* key) and let
  // the server's /v1beta/models call decide whether the key actually works.
  const formatLooksValid = cleanedKey.startsWith(KEY_PREFIX) && cleanedKey.length >= 20;
  const canValidate = !validating && cleanedKey.length > 0;
  const canSave =
    !saving &&
    f.isDirty &&
    ((f.values.apiKey && validation?.valid) ||
      (!f.values.apiKey && serverInfo.configured && f.values.model !== serverInfo.model));

  const handleValidate = useCallback(async () => {
    if (!canValidate) return;
    setValidating(true);
    setValidation(null);
    f.clearErrors();
    try {
      const res = await api.post('/settings/gemini/validate', { apiKey: cleanedKey });
      setValidation(res);
      toast.success('Gemini API key is valid.', { title: 'Validation passed' });
      if (cleanedKey !== f.values.apiKey) f.set('apiKey', cleanedKey);
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
      if (!cleanedKey) {
        toast.error(
          'To change the model, paste the API key again (we never store plaintext locally).',
          { title: 'Re-enter key' },
        );
        return;
      }
      const res = await api.post('/settings/gemini/save', {
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
      toast.success('Gemini settings saved.', { title: 'Saved' });
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
      title: 'Delete the stored Gemini API key?',
      message:
        'Any project that has Gemini as its active provider will stop running until a new key is configured (or until you switch the project back to Claude).',
      confirmLabel: 'Remove key',
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await api.del('/settings/gemini');
      setServerInfo({
        configured: false,
        lastFour: null,
        status: 'unconfigured',
        lastValidatedAt: null,
        lastError: null,
        modelsAvailable: serverInfo.modelsAvailable,
      });
      f.rebase({ apiKey: '', model: 'gemini-2.5-pro' });
      setValidation(null);
      toast.success('API key removed.', { title: 'Deleted' });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setDeleting(false);
    }
  }, [serverInfo, f, toast, confirm]);

  if (loading) {
    return <div className="p-8 text-sm text-ink-500">Loading Gemini settings…</div>;
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
          <h2 className="text-xl font-bold text-ink-900">Gemini API</h2>
          <p className="text-sm text-ink-500">
            Google Generative AI — alternative to Claude for projects you'd rather run on Gemini.
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
              : 'AIza…'
          }
          hint={
            serverInfo.configured && !f.values.apiKey
              ? 'A key is stored. Leave blank to keep it, or paste a new one to replace.'
              : cleanedKey && !formatLooksValid
              ? '⚠ Doesn\'t look like a Google key. Expected to start with "AIza". Click Validate anyway to let Google decide.'
              : 'Google AI Studio API key — get one at aistudio.google.com/apikey'
          }
          error={f.errors.apiKey}
        />

        <Select
          label="Default Model"
          value={f.values.model}
          onChange={(e) => f.set('model', e.target.value)}
          options={(serverInfo.modelsAvailable || []).map((m) => ({ value: m, label: m }))}
          hint="Used by every agent when this project's provider is Gemini."
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
        <div className="rounded-md bg-success-50 border border-success-200 text-success-900 text-xs p-3 flex items-start gap-2">
          <BadgeCheck className="w-4 h-4 mt-0.5" />
          <div>
            <div className="font-semibold">Key authenticated against Google.</div>
            <div className="opacity-80">
              {validation.modelsAvailable?.length || 0} models accessible:{' '}
              {(validation.modelsAvailable || []).slice(0, 4).join(', ')}
              {validation.modelsAvailable?.length > 4 ? '…' : ''}
            </div>
          </div>
        </div>
      )}

      <div className="rounded-md bg-info-50 border border-info-200 text-info-900 text-xs p-3">
        Want this project to <strong>actually run</strong> on Gemini? Go to{' '}
        <strong>Settings → AI Provider</strong> and switch this project's provider to Gemini.
        Configuring the key here just stores it — it doesn't change which provider your agents call.
      </div>
    </div>
  );
}
