import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Save, ShieldCheck, Trash2, BadgeCheck, AlertTriangle } from 'lucide-react';
import api, { ApiError } from '../../lib/apiClient';
import useDirtyForm, { useUnsavedChangesWarning } from '../../lib/useDirtyForm';
import { useToast } from '../../lib/useToast';
import { useConfirm } from '../../lib/useConfirm';
import Button from '../../components/ui/Button';
import SecretInput from '../../components/ui/SecretInput';
import Select from '../../components/ui/Select';
import StatusBadge from '../../components/ui/StatusBadge';

const KEY_PREFIX = 'AIza';

// Human-readable labels and tier info for the models we actively support.
// Ordered by preference — this order is preserved in the dropdown.
const CURATED_MODELS = [
  { id: 'gemini-2.5-pro',          label: 'Gemini 2.5 Pro',          note: 'Best quality · requires paid billing',  tier: 'paid' },
  { id: 'gemini-2.5-flash',        label: 'Gemini 2.5 Flash',        note: 'Fast & balanced · works on free tier',  tier: 'free' },
  { id: 'gemini-2.5-flash-lite',   label: 'Gemini 2.5 Flash Lite',   note: 'Lightweight · free tier',               tier: 'free' },
  { id: 'gemini-2.0-flash',        label: 'Gemini 2.0 Flash',        note: 'Stable · free tier',                    tier: 'free' },
  { id: 'gemini-1.5-pro',          label: 'Gemini 1.5 Pro',          note: 'Reliable · requires paid billing',      tier: 'paid' },
  { id: 'gemini-1.5-flash',        label: 'Gemini 1.5 Flash',        note: 'Fast · free tier',                      tier: 'free' },
];

const CURATED_IDS = new Set(CURATED_MODELS.map((m) => m.id));

function buildModelOptions(available) {
  const availableSet = new Set(available || []);
  // Curated models that Google says are available for this key (preserves priority order)
  const curated = CURATED_MODELS
    .filter((m) => availableSet.has(m.id) || available.length === 0)
    .map((m) => ({ value: m.id, label: `${m.label} — ${m.note}` }));
  // Any additional non-curated models returned by Google's API (edge case: new/preview models)
  const extras = (available || [])
    .filter((id) => !CURATED_IDS.has(id) && id.startsWith('gemini-') && !id.includes('embedding') && !id.includes('vision'))
    .map((id) => ({ value: id, label: id }));
  return curated.length ? [...curated, ...extras] : CURATED_MODELS.map((m) => ({ value: m.id, label: `${m.label} — ${m.note}` }));
}

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
  // Validate path covers BOTH "test typed key" and "test stored key" — the
  // latter lets the configured + clean state expose a useful primary CTA.
  const canValidate =
    !validating && (cleanedKey.length > 0 || serverInfo.configured);
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
    const useStored = !cleanedKey && serverInfo.configured;
    try {
      const res = useStored
        ? await api.post('/settings/gemini/test', {})
        : await api.post('/settings/gemini/validate', { apiKey: cleanedKey });
      setValidation(res);
      toast.success(
        useStored ? 'Stored Gemini key still works.' : 'Gemini API key is valid.',
        { title: useStored ? 'Connection OK' : 'Validation passed' },
      );
      if (cleanedKey && cleanedKey !== f.values.apiKey) f.set('apiKey', cleanedKey);
      if (Array.isArray(res.modelsAvailable) && res.modelsAvailable.length) {
        setServerInfo((s) => ({
          ...s,
          modelsAvailable: res.modelsAvailable,
          status: 'valid',
          lastValidatedAt: new Date().toISOString(),
          lastError: null,
        }));
      } else if (useStored) {
        setServerInfo((s) => ({
          ...s,
          status: 'valid',
          lastValidatedAt: new Date().toISOString(),
          lastError: null,
        }));
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setValidation({ valid: false, ...err.payload });
        if (!useStored) {
          f.setError('apiKey', err.payload?.message || err.message);
        } else {
          setServerInfo((s) => ({
            ...s,
            status: 'invalid',
            lastError: err.payload?.message || err.message,
          }));
        }
        toast.error(err.payload?.message || err.message, {
          title: useStored ? 'Connection failed' : 'Validation failed',
        });
      } else {
        toast.error(err.message);
      }
    } finally {
      setValidating(false);
    }
  }, [canValidate, cleanedKey, serverInfo.configured, f, toast]);

  // Build the dropdown list: curated models first (with notes), then any
  // extras that Google's API returns but aren't in our curated list.
  const modelOptions = useMemo(
    () => buildModelOptions(serverInfo.modelsAvailable || []),
    [serverInfo.modelsAvailable],
  );

  // Determine if the currently selected model requires a paid billing account.
  const selectedMeta = CURATED_MODELS.find((m) => m.id === f.values.model);
  const selectedNeedsBilling = selectedMeta?.tier === 'paid';

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
          options={modelOptions}
          hint="All agents use this model when the project's provider is set to Gemini."
        />
        {selectedNeedsBilling && (
          <div className="rounded-md bg-warn-50 border border-warn-200 text-warn-900 text-xs p-3 flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              <strong>{selectedMeta?.label}</strong> requires a Google Cloud project with billing enabled.
              Free AI Studio keys will hit a 429 rate-limit error when running tests.
              To enable billing, visit <strong>console.cloud.google.com</strong> → Billing.
            </span>
          </div>
        )}

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

        {/* Configured + clean → primary becomes "Test connection" so the page
            has something useful to do on visit. Dirty → primary is Save. */}
        <div className="flex items-center justify-between pt-2 border-t border-ink-200 gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            {(f.isDirty || !serverInfo.configured) && (
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
            )}
            {serverInfo.configured && (
              <Button variant="ghost" size="sm" onClick={handleDelete} loading={deleting}>
                <Trash2 className="w-3.5 h-3.5" />
                Remove
              </Button>
            )}
          </div>
          {serverInfo.configured && !f.isDirty ? (
            <Button onClick={handleValidate} disabled={validating} loading={validating}>
              <ShieldCheck className="w-3.5 h-3.5" />
              Test connection
            </Button>
          ) : (
            <Button onClick={handleSave} disabled={!canSave} loading={saving}>
              <Save className="w-3.5 h-3.5" />
              {f.isDirty ? 'Save changes' : 'No changes'}
            </Button>
          )}
        </div>
      </div>

      {validation?.valid && validation.canGenerate === false && (
        <div className="rounded-md bg-danger-50 border border-danger-200 text-danger-900 text-xs p-3 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <div className="font-semibold">Key authenticated but generation is rate-limited right now.</div>
            <div className="opacity-80">
              {validation.isFreeQuota
                ? 'This is a free-tier AI Studio key (5–15 RPM limit). It will fail during test runs which make many rapid requests. To remove limits, link your Google Cloud project to a billing account at console.cloud.google.com → Billing.'
                : 'Your quota is exhausted. Wait for the limit window to reset, or raise your quota at console.cloud.google.com/apis/api/generativelanguage.googleapis.com.'}
            </div>
          </div>
        </div>
      )}
      {validation?.valid && validation.canGenerate === true && (
        <div className="rounded-md bg-success-50 border border-success-200 text-success-900 text-xs p-3 flex items-start gap-2">
          <BadgeCheck className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <div className="font-semibold">Key authenticated and generation test passed.</div>
            <div className="opacity-80">
              Your key can make generation calls right now. If you hit limits during sustained test runs, check your quota at console.cloud.google.com.
            </div>
            <div className="opacity-60">
              {(validation.modelsAvailable || []).filter((id) => CURATED_IDS.has(id)).slice(0, 5).join(' · ')}
              {(validation.modelsAvailable || []).filter((id) => CURATED_IDS.has(id)).length > 5 ? ' …' : ''}
            </div>
          </div>
        </div>
      )}
      {validation?.valid && validation.canGenerate === null && (
        <div className="rounded-md bg-success-50 border border-success-200 text-success-900 text-xs p-3 flex items-start gap-2">
          <BadgeCheck className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <div className="font-semibold">Key authenticated against Google.</div>
            <div className="opacity-80">
              Generation probe timed out — authentication passed but quota status is unknown. If you hit rate-limit errors when running, ensure billing is enabled on your GCP project.
            </div>
            <div className="opacity-60">
              {(validation.modelsAvailable || []).filter((id) => CURATED_IDS.has(id)).slice(0, 5).join(' · ')}
              {(validation.modelsAvailable || []).filter((id) => CURATED_IDS.has(id)).length > 5 ? ' …' : ''}
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
