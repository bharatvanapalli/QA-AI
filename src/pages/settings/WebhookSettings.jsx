import React, { useEffect, useState, useCallback } from 'react';
import { Plus, KeyRound, Send, Trash2, RefreshCw, ShieldCheck, Copy, Check } from 'lucide-react';
import api, { ApiError } from '../../lib/apiClient';
import { useToast } from '../../lib/useToast';
import { useConfirm } from '../../lib/useConfirm';
import Button from '../../components/ui/Button';
import Input from '../../components/ui/Input';
import SecretInput from '../../components/ui/SecretInput';
import Checkbox from '../../components/ui/Checkbox';
import StatusBadge from '../../components/ui/StatusBadge';

export default function WebhookSettings() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [webhooks, setWebhooks] = useState([]);
  const [supportedEvents, setSupportedEvents] = useState([]);

  // Inline "add new" form state
  const [adding, setAdding] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newSecret, setNewSecret] = useState('');
  const [newSecretRevealed, setNewSecretRevealed] = useState(false);
  const [newSecretCopied, setNewSecretCopied] = useState(false);
  const [newEvents, setNewEvents] = useState([]);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [evs, list] = await Promise.all([
          api.get('/settings/webhook/events'),
          api.get('/settings/webhook'),
        ]);
        setSupportedEvents(evs.events || []);
        setWebhooks(list.webhooks || []);
      } catch (err) {
        toast.error(err.message);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const urlOk = /^https?:\/\/.+/.test(newUrl.trim());

  const handleGenerateSecret = useCallback(async () => {
    try {
      const res = await api.post('/settings/webhook/generate-secret', {});
      setNewSecret(res.secret);
      setNewSecretRevealed(true);
      setNewSecretCopied(false);
      toast.info('Secret generated — copy it now. It will only be shown once.', {
        title: 'Save the secret',
      });
    } catch (err) {
      toast.error(err.message);
    }
  }, [toast]);

  const handleValidate = useCallback(async () => {
    if (!urlOk || !newSecret) return;
    setValidating(true);
    setValidation(null);
    try {
      const res = await api.post('/settings/webhook/validate', {
        url: newUrl.trim(),
        secret: newSecret,
      });
      setValidation(res);
      toast.success(`Endpoint returned ${res.statusCode} in ${res.latencyMs}ms.`, {
        title: 'Endpoint verified',
      });
    } catch (err) {
      const payload = err instanceof ApiError ? err.payload : { message: err.message };
      setValidation({ valid: false, ...payload });
      toast.error(payload.message || 'Validation failed', { title: payload.code });
    } finally {
      setValidating(false);
    }
  }, [urlOk, newUrl, newSecret, toast]);

  const handleSaveNew = useCallback(async () => {
    if (!urlOk || !newSecret || !newEvents.length) return;
    setSaving(true);
    try {
      const res = await api.post('/settings/webhook', {
        url: newUrl.trim(),
        secret: newSecret,
        events: newEvents,
      });
      setWebhooks((w) => [res.webhook, ...w]);
      setAdding(false);
      setNewUrl('');
      setNewSecret('');
      setNewEvents([]);
      setValidation(null);
      toast.success('Webhook created.', { title: 'Saved' });
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Save failed' });
    } finally {
      setSaving(false);
    }
  }, [urlOk, newSecret, newUrl, newEvents, toast]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(newSecret);
      setNewSecretCopied(true);
      setTimeout(() => setNewSecretCopied(false), 2000);
    } catch (_) {}
  }, [newSecret]);

  if (loading)
    return <div className="p-8 text-sm text-ink-500">Loading webhook settings…</div>;

  return (
    <div className="max-w-3xl space-y-6">
      <header className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-bold text-ink-900">CI/CD Webhooks</h2>
          <p className="text-sm text-ink-500">
            Receive signed HTTP POSTs when runs complete, PRs open, or tests block.
          </p>
        </div>
        {!adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="w-3.5 h-3.5" />
            Add webhook
          </Button>
        )}
      </header>

      {/* Existing list */}
      {webhooks.length === 0 && !adding && (
        <div className="rounded-lg border border-dashed border-ink-300 p-8 text-center text-ink-500 text-sm">
          No webhooks yet. Click "Add webhook" to create one.
        </div>
      )}
      <div className="space-y-3">
        {webhooks.map((w) => (
          <WebhookRow
            key={w.id}
            webhook={w}
            onChanged={(updated) =>
              setWebhooks((all) => all.map((x) => (x.id === updated.id ? updated : x)))
            }
            onDeleted={(id) => setWebhooks((all) => all.filter((x) => x.id !== id))}
            supportedEvents={supportedEvents}
          />
        ))}
      </div>

      {/* Inline new webhook form */}
      {adding && (
        <div className="rounded-lg border border-ink-200 bg-white p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-ink-900">New webhook</h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setAdding(false);
                setNewUrl('');
                setNewSecret('');
                setNewEvents([]);
                setValidation(null);
              }}
            >
              Cancel
            </Button>
          </div>

          <Input
            label="Target URL"
            value={newUrl}
            onChange={(e) => {
              setNewUrl(e.target.value);
              setValidation(null);
            }}
            placeholder="https://your-ci.example.com/qaai/hook"
            error={!urlOk && newUrl ? 'Must be http(s) URL' : undefined}
          />

          <div className="space-y-2">
            <label className="text-xs font-semibold text-ink-700">
              Signing secret (HMAC-SHA256)
            </label>
            {newSecret ? (
              <div className="rounded-md bg-ink-50 border border-ink-300 px-3 py-2 flex items-center gap-2 font-mono text-xs">
                <span className="flex-1 break-all">
                  {newSecretRevealed ? newSecret : '•'.repeat(40) + newSecret.slice(-4)}
                </span>
                <button
                  type="button"
                  onClick={() => setNewSecretRevealed((s) => !s)}
                  className="text-ink-500 hover:text-ink-900"
                >
                  {newSecretRevealed ? 'Hide' : 'Show'}
                </button>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="text-ink-500 hover:text-ink-900 inline-flex items-center gap-1"
                >
                  {newSecretCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {newSecretCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
            ) : (
              <Button size="sm" variant="secondary" onClick={handleGenerateSecret}>
                <KeyRound className="w-3.5 h-3.5" />
                Generate secret
              </Button>
            )}
            {newSecret && (
              <p className="text-xs text-warn-700">
                ⚠ Copy this secret now. It will not be shown again.
              </p>
            )}
          </div>

          <div>
            <div className="text-xs font-semibold text-ink-700 mb-2">Events</div>
            <div className="grid grid-cols-2 gap-2">
              {supportedEvents.map((ev) => (
                <Checkbox
                  key={ev}
                  label={<span className="font-mono text-xs">{ev}</span>}
                  checked={newEvents.includes(ev)}
                  onChange={(c) =>
                    setNewEvents((cur) => (c ? [...cur, ev] : cur.filter((x) => x !== ev)))
                  }
                />
              ))}
            </div>
          </div>

          {validation && !validation.valid && (
            <div className="rounded-md bg-danger-50 border border-danger-200 text-danger-800 text-xs p-3">
              <strong>{validation.code}</strong> — {validation.message}
            </div>
          )}

          <div className="flex items-center justify-between pt-2 border-t border-ink-200">
            <Button
              size="sm"
              variant="secondary"
              onClick={handleValidate}
              disabled={!urlOk || !newSecret || validating}
              loading={validating}
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              Validate endpoint
            </Button>
            <Button
              onClick={handleSaveNew}
              disabled={!urlOk || !newSecret || newEvents.length === 0 || saving}
              loading={saving}
            >
              Save webhook
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Existing webhook row ───────────────────────────────────────
function WebhookRow({ webhook, onChanged, onDeleted, supportedEvents }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(null);
  const [deliveries, setDeliveries] = useState(null);
  const [editingEvents, setEditingEvents] = useState(false);
  const [draftEvents, setDraftEvents] = useState(webhook.events);

  const eventsDirty = JSON.stringify(draftEvents.sort()) !== JSON.stringify([...webhook.events].sort());

  const handleTest = useCallback(async () => {
    setBusy('test');
    try {
      const res = await api.post(`/settings/webhook/${webhook.id}/test`, {});
      if (res.success) {
        toast.success(`Test event delivered (HTTP ${res.statusCode}, ${res.latencyMs}ms).`);
      } else {
        toast.error(res.error || 'Delivery failed');
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  }, [webhook.id, toast]);

  const handleRotate = useCallback(async () => {
    const ok = await confirm({
      title: 'Rotate signing secret?',
      message: 'The current secret will stop working immediately. The new secret will be shown once — copy it before closing the prompt.',
      confirmLabel: 'Rotate secret',
    });
    if (!ok) return;
    setBusy('rotate');
    try {
      const res = await api.post(`/settings/webhook/${webhook.id}/rotate-secret`, {});
      const ok = window.prompt(
        'New secret (copy now — will not be shown again):',
        res.secret
      );
      if (!ok) toast.info('Secret rotated. Stored on server; you did not copy it.');
      onChanged({ ...webhook, lastFourSecret: res.secret.slice(-4) });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  }, [webhook, toast, onChanged, confirm]);

  const handleDelete = useCallback(async () => {
    const ok = await confirm({
      title: 'Delete this webhook?',
      message: 'Future events will no longer be delivered to this endpoint. Delivery history is retained for auditing.',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    setBusy('delete');
    try {
      await api.del(`/settings/webhook/${webhook.id}`);
      onDeleted(webhook.id);
      toast.success('Webhook deleted.');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  }, [webhook.id, toast, onDeleted, confirm]);

  const handleSaveEvents = useCallback(async () => {
    setBusy('events');
    try {
      const res = await api.put(`/settings/webhook/${webhook.id}`, { events: draftEvents });
      onChanged(res.webhook);
      setEditingEvents(false);
      toast.success('Events updated.');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  }, [webhook.id, draftEvents, toast, onChanged]);

  const handleToggleEnabled = useCallback(async () => {
    setBusy('toggle');
    try {
      const res = await api.put(`/settings/webhook/${webhook.id}`, {
        enabled: !webhook.enabled,
      });
      onChanged(res.webhook);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  }, [webhook, toast, onChanged]);

  const loadDeliveries = useCallback(async () => {
    setBusy('deliveries');
    try {
      const res = await api.get(`/settings/webhook/${webhook.id}/deliveries`);
      setDeliveries(res.deliveries || []);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  }, [webhook.id, toast]);

  return (
    <div className="rounded-lg border border-ink-200 bg-white p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm text-ink-900 break-all">{webhook.url}</div>
          <div className="text-xs text-ink-500 mt-0.5">
            Secret …{webhook.lastFourSecret || '????'} · {webhook.events.length} events
          </div>
        </div>
        <StatusBadge status={webhook.enabled ? 'valid' : 'idle'} label={webhook.enabled ? 'Enabled' : 'Disabled'} />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={handleTest} disabled={busy === 'test'} loading={busy === 'test'}>
          <Send className="w-3.5 h-3.5" />
          Send test
        </Button>
        <Button size="sm" variant="secondary" onClick={handleRotate} disabled={busy === 'rotate'} loading={busy === 'rotate'}>
          <RefreshCw className="w-3.5 h-3.5" />
          Rotate secret
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditingEvents((s) => !s)}>
          {editingEvents ? 'Cancel' : 'Edit events'}
        </Button>
        <Button size="sm" variant="ghost" onClick={loadDeliveries} loading={busy === 'deliveries'}>
          Recent deliveries
        </Button>
        <Button size="sm" variant="ghost" onClick={handleToggleEnabled} loading={busy === 'toggle'}>
          {webhook.enabled ? 'Disable' : 'Enable'}
        </Button>
        <Button size="sm" variant="ghost" onClick={handleDelete} loading={busy === 'delete'} className="text-danger-600">
          <Trash2 className="w-3.5 h-3.5" />
          Delete
        </Button>
      </div>

      {editingEvents && (
        <div className="space-y-2 pt-2 border-t border-ink-200">
          <div className="grid grid-cols-2 gap-2">
            {supportedEvents.map((ev) => (
              <Checkbox
                key={ev}
                label={<span className="font-mono text-xs">{ev}</span>}
                checked={draftEvents.includes(ev)}
                onChange={(c) =>
                  setDraftEvents((cur) => (c ? [...cur, ev] : cur.filter((x) => x !== ev)))
                }
              />
            ))}
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={handleSaveEvents}
              disabled={!eventsDirty || draftEvents.length === 0}
              loading={busy === 'events'}
            >
              Save events
            </Button>
          </div>
        </div>
      )}

      {deliveries && (
        <div className="pt-2 border-t border-ink-200">
          <div className="text-xs font-semibold text-ink-700 mb-2">
            Recent deliveries ({deliveries.length})
          </div>
          {deliveries.length === 0 ? (
            <div className="text-xs text-ink-500">None yet.</div>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-ink-500">
                    <th className="py-1 pr-2">When</th>
                    <th className="py-1 pr-2">Event</th>
                    <th className="py-1 pr-2">Status</th>
                    <th className="py-1 pr-2">Latency</th>
                    <th className="py-1">Attempts</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.map((d) => (
                    <tr key={d.id} className="border-t border-ink-100">
                      <td className="py-1 pr-2 whitespace-nowrap">
                        {new Date(d.createdAt).toLocaleString()}
                      </td>
                      <td className="py-1 pr-2 font-mono">{d.event}</td>
                      <td className={`py-1 pr-2 font-semibold ${d.succeeded ? 'text-success-700' : 'text-danger-700'}`}>
                        {d.succeeded ? d.statusCode || 'OK' : d.error || 'FAIL'}
                      </td>
                      <td className="py-1 pr-2">{d.latencyMs ?? '—'}ms</td>
                      <td className="py-1">{d.attempts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
