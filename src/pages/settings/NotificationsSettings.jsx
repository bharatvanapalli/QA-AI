import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Plus, Mail, Slack, Webhook, Trash2, Send } from 'lucide-react';
import api, { ApiError } from '../../lib/apiClient';
import { useToast } from '../../lib/useToast';
import { useConfirm } from '../../lib/useConfirm';
import Button from '../../components/ui/Button';
import Input from '../../components/ui/Input';
import Select from '../../components/ui/Select';
import Checkbox from '../../components/ui/Checkbox';
import StatusBadge from '../../components/ui/StatusBadge';

const ICONS = { email: Mail, slack: Slack, webhook: Webhook };

export default function NotificationsSettings() {
  const toast = useToast();
  const confirm = useConfirm();
  const [loading, setLoading] = useState(true);
  const [channels, setChannels] = useState([]);
  const [routing, setRouting] = useState({});
  const [events, setEvents] = useState([]);
  const [savedRouting, setSavedRouting] = useState({});

  // New channel inline form
  const [showAdd, setShowAdd] = useState(false);
  const [newType, setNewType] = useState('email');
  const [newTarget, setNewTarget] = useState('');
  const [creating, setCreating] = useState(false);

  const [savingRouting, setSavingRouting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [evs, list] = await Promise.all([
        api.get('/settings/notifications/events'),
        api.get('/settings/notifications'),
      ]);
      setEvents(evs.events || []);
      setChannels(list.channels || []);
      setRouting(list.routing || {});
      setSavedRouting(list.routing || {});
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const routingDirty = useMemo(() => {
    const a = JSON.stringify(normalise(routing));
    const b = JSON.stringify(normalise(savedRouting));
    return a !== b;
  }, [routing, savedRouting]);

  const handleCreate = useCallback(async () => {
    if (!newTarget) return;
    setCreating(true);
    try {
      const res = await api.post('/settings/notifications/channels', {
        type: newType,
        target: newTarget.trim(),
      });
      setChannels((c) => [res.channel, ...c]);
      setShowAdd(false);
      setNewTarget('');
      toast.success('Channel added. Send a test to verify it.', { title: 'Created' });
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Create failed' });
    } finally {
      setCreating(false);
    }
  }, [newType, newTarget, toast]);

  const handleTest = useCallback(
    async (channel) => {
      try {
        const res = await api.post(`/settings/notifications/channels/${channel.id}/test`, {});
        if (res.success) {
          toast.success(`Delivered in ${res.latencyMs}ms.`, { title: 'Sent' });
          setChannels((all) =>
            all.map((c) =>
              c.id === channel.id ? { ...c, verified: true, lastTestSuccess: true } : c
            )
          );
        }
      } catch (err) {
        const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
        toast.error(msg, { title: 'Delivery failed' });
        setChannels((all) =>
          all.map((c) =>
            c.id === channel.id ? { ...c, lastTestSuccess: false } : c
          )
        );
      }
    },
    [toast]
  );

  const handleDelete = useCallback(
    async (channel) => {
      const ok = await confirm({
        title: 'Delete this channel?',
        message: 'All event routes pointing to this channel will also be removed.',
        confirmLabel: 'Delete channel',
      });
      if (!ok) return;
      try {
        await api.del(`/settings/notifications/channels/${channel.id}`);
        setChannels((c) => c.filter((x) => x.id !== channel.id));
        // Drop from routing
        setRouting((r) => {
          const next = {};
          for (const ev of Object.keys(r)) {
            next[ev] = r[ev].filter((id) => id !== channel.id);
          }
          return next;
        });
        toast.success('Channel removed.');
      } catch (err) {
        toast.error(err.message);
      }
    },
    [toast, confirm]
  );

  const toggleRoute = useCallback((event, channelId) => {
    setRouting((r) => {
      const cur = r[event] || [];
      const has = cur.includes(channelId);
      return { ...r, [event]: has ? cur.filter((id) => id !== channelId) : [...cur, channelId] };
    });
  }, []);

  const handleSaveRouting = useCallback(async () => {
    setSavingRouting(true);
    try {
      await api.put('/settings/notifications/routing', { routing });
      setSavedRouting(routing);
      toast.success('Routing saved.', { title: 'Saved' });
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Save failed' });
    } finally {
      setSavingRouting(false);
    }
  }, [routing, toast]);

  if (loading)
    return <div className="p-8 text-sm text-ink-500">Loading notifications…</div>;

  const placeholder = {
    email: 'you@example.com',
    slack: 'https://hooks.slack.com/services/T0/B0/XXXX',
    webhook: 'https://your-endpoint.example.com/notify',
  }[newType];

  return (
    <div className="max-w-4xl space-y-6">
      <header className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-bold text-ink-900">Notifications</h2>
          <p className="text-sm text-ink-500">
            Route events to email, Slack, or generic webhook endpoints.
          </p>
        </div>
        {!showAdd && (
          <Button size="sm" onClick={() => setShowAdd(true)}>
            <Plus className="w-3.5 h-3.5" />
            Add channel
          </Button>
        )}
      </header>

      {/* Channels list */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-ink-900">Channels</h3>
        {channels.length === 0 && !showAdd && (
          <div className="rounded-lg border border-dashed border-ink-300 p-6 text-center text-sm text-ink-500">
            No channels yet. Add an email, Slack, or webhook channel above.
          </div>
        )}
        <div className="space-y-2">
          {channels.map((ch) => {
            const Icon = ICONS[ch.type] || Webhook;
            return (
              <div
                key={ch.id}
                className="rounded-lg border border-ink-200 bg-white p-3 flex items-center gap-3"
              >
                <Icon className="w-4 h-4 text-ink-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-ink-900 truncate">{ch.target}</div>
                  <div className="text-xs text-ink-500 capitalize">{ch.type}</div>
                </div>
                <StatusBadge
                  status={ch.verified ? 'valid' : ch.lastTestSuccess === false ? 'invalid' : 'unconfigured'}
                  label={ch.verified ? 'Verified' : ch.lastTestSuccess === false ? 'Last test failed' : 'Unverified'}
                />
                <Button size="sm" variant="secondary" onClick={() => handleTest(ch)}>
                  <Send className="w-3.5 h-3.5" />
                  Send test
                </Button>
                <Button size="sm" variant="ghost" onClick={() => handleDelete(ch)} className="text-danger-600">
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            );
          })}
        </div>

        {showAdd && (
          <div className="rounded-lg border border-ink-200 bg-white p-4 space-y-3">
            <div className="flex gap-3">
              <Select
                label="Type"
                value={newType}
                onChange={(e) => setNewType(e.target.value)}
                options={[
                  { value: 'email', label: 'Email' },
                  { value: 'slack', label: 'Slack (Incoming Webhook)' },
                  { value: 'webhook', label: 'Generic webhook' },
                ]}
                className="w-44"
              />
              <div className="flex-1">
                <Input
                  label="Target"
                  value={newTarget}
                  onChange={(e) => setNewTarget(e.target.value)}
                  placeholder={placeholder}
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setShowAdd(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleCreate} disabled={!newTarget || creating} loading={creating}>
                Create
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* Routing matrix */}
      {channels.length > 0 && events.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink-900">Event routing</h3>
            <Button
              size="sm"
              onClick={handleSaveRouting}
              disabled={!routingDirty || savingRouting}
              loading={savingRouting}
            >
              {routingDirty ? 'Save routing' : 'No changes'}
            </Button>
          </div>
          <div className="rounded-lg border border-ink-200 bg-white overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-ink-50 text-left">
                  <th className="p-3 text-xs font-semibold text-ink-700">Event</th>
                  {channels.map((ch) => (
                    <th
                      key={ch.id}
                      className="p-3 text-xs font-semibold text-ink-700 text-center max-w-[160px]"
                    >
                      <div className="truncate" title={ch.target}>
                        {ch.target}
                      </div>
                      <div className="text-[10px] text-ink-400 capitalize">{ch.type}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => (
                  <tr key={ev} className="border-t border-ink-100">
                    <td className="p-3 font-mono text-xs">{ev}</td>
                    {channels.map((ch) => {
                      const checked = (routing[ev] || []).includes(ch.id);
                      return (
                        <td key={ch.id} className="p-3 text-center">
                          <Checkbox
                            checked={checked}
                            onChange={() => toggleRoute(ev, ch.id)}
                            disabled={!ch.verified}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-ink-500">
            Channels must be <strong>verified</strong> (send a test) before they can receive events.
          </p>
        </section>
      )}
    </div>
  );
}

function normalise(routing) {
  const out = {};
  for (const k of Object.keys(routing).sort()) {
    out[k] = [...(routing[k] || [])].sort();
  }
  return out;
}
